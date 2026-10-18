#!/usr/bin/env node
// app/tests/account-settings.test.mjs — SUITE 8: D3 (account settings UI),
// D6 (single shared /whoami), D8 (blocked-cookie banner) client-side checks.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/account-settings.test.mjs"
// or from app/:
//   node tests/account-settings.test.mjs
//
// Pattern: identical to account-cta.test.mjs — esbuild's Node API bundles the
// REAL .ts source into a temp ESM file, dynamically imported and exercised
// directly against a minimal hand-rolled DOM/fetch stub. Exits non-zero on
// any FAIL. Every test() body is SYNCHRONOUS by design (same reasoning as
// account-cta.test.mjs's own header note) — every async trigger below is
// awaited OUTSIDE test(), with test() only asserting on the already-settled
// result.
//
// Coverage this suite adds (per the D3/D6/D8 review):
//   1. Signed-out visitors get ZERO account controls (source-level, mirrors
//      account-cta.test.mjs's technique for the sign-in banner).
//   2. "Delete my account" requires a real second confirm click before it
//      ever calls the server — a single tap must never delete anything.
//   3. Sign-out degrades gracefully (a clear message, not a false "done") when
//      POST /auth/signout 404s — the route does not exist server-side yet,
//      see account.ts's own header comment — and succeeds/calls back on 2xx.
//   4. Export is a real navigable link at the real endpoint, not a promise
//      with nothing behind it.
//   5. ui/session.ts's getSession() shares ONE /whoami call across concurrent
//      callers (the actual mechanism D6's fix depends on).
//   6. ui/cookieWarning.ts's banner (D8) explains the real problem in plain
//      language and is dismissible.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const uiDir = resolve(srcDir, 'ui')
const achievementsPath = resolve(uiDir, 'achievements.ts')
const accountPath = resolve(uiDir, 'account.ts')
const sessionPath = resolve(uiDir, 'session.ts')
const cookieWarningPath = resolve(uiDir, 'cookieWarning.ts')

// ---------------------------------------------------------------------------
// Minimal test harness (no vitest/tsx in this repo) — identical shape to
// every other suite in this directory.
// ---------------------------------------------------------------------------
const results = []
let currentSection = ''

function section(name) {
  currentSection = name
  console.log(`\n=== ${name} ===`)
}

function test(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = fn()
    results.push({ name: full, outcome: 'pass' })
    console.log(`  PASS  ${name}${evidence ? `\n          ${evidence}` : ''}`)
  } catch (err) {
    results.push({ name: full, outcome: 'fail' })
    console.log(`  FAIL  ${name}\n          ${err && err.message ? err.message : err}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function flush() {
  // Flushes the microtask queue (fetch-mock resolution -> the `await` inside
  // signOut()/deleteAccount() -> their .then() callback) — a macrotask
  // (setTimeout) is guaranteed to run after every already-queued microtask.
  return new Promise((r) => setTimeout(r, 0))
}

const cssNoop = {
  name: 'css-noop',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-noop' }))
    b.onLoad({ filter: /.*/, namespace: 'css-noop' }, () => ({ contents: '', loader: 'js' }))
  },
}

// ---- minimal DOM stub -------------------------------------------------
// Superset of account-cta.test.mjs's FakeElement: adds addEventListener
// (single-listener-per-type is all this codebase's click handlers need),
// disabled/href passthrough, replaceChildren, and a no-op remove() — built
// for account.ts's EXACT surface (read in full), same "real per-tag stub
// would be overkill" call as account-cta.test.mjs's own version.
class FakeTextNode {
  constructor(text) {
    this.textContent = text
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this._className = ''
    this._textContent = ''
    this.href = undefined
    this.disabled = false
    this.children = []
    this._listeners = {}
  }
  set className(v) {
    this._className = v
  }
  get className() {
    return this._className
  }
  set textContent(v) {
    this._textContent = v
    this.children = []
  }
  get textContent() {
    if (this.children.length > 0) return this.children.map((c) => c.textContent).join('')
    return this._textContent
  }
  append(...nodes) {
    this.children.push(...nodes)
  }
  appendChild(node) {
    this.children.push(node)
    return node
  }
  setAttribute(name, value) {
    this[`_attr_${name}`] = value
  }
  addEventListener(type, fn) {
    this._listeners[type] = fn
  }
  /** Test-only helper: invokes the stored listener for `type`, if any. */
  fire(type) {
    const fn = this._listeners[type]
    assert(typeof fn === 'function', `no '${type}' listener registered on <${this.tagName.toLowerCase()}>`)
    fn()
  }
  remove() {
    this._removed = true
  }
  replaceChildren(...nodes) {
    this.children = nodes
  }
  /** Depth-first find by tag — same technique as account-cta.test.mjs's
   *  querySelectorTag, generalized to optionally match by visible text too
   *  (buttons/links in account.ts are told apart by their label, not by any
   *  id/data-attribute — this app has none). */
  findByTag(tag) {
    return this._search((el) => el.tagName === tag.toUpperCase())
  }
  findByText(text) {
    return this._search((el) => typeof el.textContent === 'string' && el.textContent.includes(text))
  }
  /** Tag-scoped text search — account.ts's section titles and their
   *  matching buttons are deliberately worded the SAME ("Sign out" the
   *  heading, "Sign out" the button; "Delete my account" both), so a plain
   *  findByText() on that label is ambiguous (depth-first hits the heading
   *  first). Buttons are always what a click-driving test actually wants. */
  findButton(text) {
    return this._search((el) => el.tagName === 'BUTTON' && typeof el.textContent === 'string' && el.textContent.includes(text))
  }
  _search(pred) {
    const stack = [...this.children]
    while (stack.length > 0) {
      const el = stack.shift()
      if (!el || typeof el !== 'object') continue
      if (pred(el)) return el
      if (Array.isArray(el.children)) stack.push(...el.children)
    }
    return null
  }
}

const prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const prevFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')

function installDomStub() {
  const body = new FakeElement('body')
  Object.defineProperty(globalThis, 'document', {
    value: {
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (t) => new FakeTextNode(t),
      body,
    },
    configurable: true,
    writable: true,
  })
  return body
}

function restoreDom() {
  if (prevDocument) Object.defineProperty(globalThis, 'document', prevDocument)
  else delete globalThis.document
}

function restoreFetch() {
  if (prevFetch) Object.defineProperty(globalThis, 'fetch', prevFetch)
  else delete globalThis.fetch
}

/** Installs a controllable fetch stub. `impl(url, opts) -> response-shape`
 *  (or throws, to simulate a network failure) — every call is recorded in
 *  the returned array for assertions. */
function installFetchStub(impl) {
  const calls = []
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url, opts) => {
      calls.push({ url, opts })
      return impl(url, opts)
    },
    configurable: true,
    writable: true,
  })
  return calls
}

async function bundle(entryPoint, outName) {
  const tmp = await mkdtemp(resolve(tmpdir(), 'pg-account-settings-'))
  const outfile = resolve(tmp, outName)
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    plugins: [cssNoop],
    logLevel: 'silent',
  })
  return { tmp, outfile }
}

// ===========================================================================
section('1. Signed-out visitors get zero account controls (source-level)')
// ===========================================================================
const achievementsSrc = readFileSync(achievementsPath, 'utf8')

test('render(): the account-management row is gated behind a bare, literal `if (user)` — never unconditional', () => {
  assert(
    /if \(user\) root\.appendChild\(renderAccountBanner\(/.test(achievementsSrc),
    'expected a bare one-line `if (user) root.appendChild(renderAccountBanner(...))` in achievements.ts',
  )
})

test('render(): the account-management row and the sign-in banner are mutually exclusive, not both reachable at once', () => {
  const renderFnStart = achievementsSrc.indexOf('function render(): void {')
  assert(renderFnStart !== -1, 'could not locate render() in achievements.ts')
  const renderFnEnd = achievementsSrc.indexOf('\n  }\n', renderFnStart)
  const body = achievementsSrc.slice(renderFnStart, renderFnEnd)
  const signedOutIdx = body.indexOf('if (!user) root.appendChild(renderSignInBanner())')
  const signedInIdx = body.indexOf('if (user) root.appendChild(renderAccountBanner(')
  assert(signedOutIdx !== -1, 'expected the signed-out banner line')
  assert(signedInIdx !== -1, 'expected the signed-in account-banner line')
  return `both present as separate bare-if lines (signed-out at offset ${signedOutIdx}, signed-in at ${signedInIdx}) — user is truthy XOR falsy, so exactly one ever fires`
})

// Same comment-stripping technique as account-cta.test.mjs's codeOnly() —
// this file's own header comment narrates renderAccountBanner() by name
// twice in prose, which a naive raw-source grep would wrongly count as
// extra call sites.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. jsdoc)
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // line comments, keeping `https://` intact
}

test('renderAccountBanner is defined but never invoked from anywhere reachable when signed out (no second call site)', () => {
  const callSites = codeOnly(achievementsSrc).match(/renderAccountBanner\(/g) ?? []
  // Exactly 2 in CODE (comments excluded): the function's own definition
  // line (`function renderAccountBanner(`) and the one gated call site
  // asserted above. A 3rd would mean an ungated/second reachable path.
  assert(callSites.length === 2, `expected exactly 2 code occurrences of "renderAccountBanner(" (definition + one gated call), found ${callSites.length}`)
})

// ===========================================================================
section('2. "Delete my account" requires a real confirm step')
// ===========================================================================
{
  const { tmp, outfile } = await bundle(accountPath, 'account.mjs')
  installDomStub()
  const { buildDeleteSection } = await import(pathToFileURL(outfile).href)

  let onDeletedCalls = 0
  const callbacks = { onSignedOut: () => {}, onDeleted: () => onDeletedCalls++ }

  // --- idle state: exactly one button, and it must NOT be the confirm's
  const deleteSection = buildDeleteSection(callbacks)
  test('idle state renders exactly one "Delete my account" button, no fetch yet', () => {
    const idleBtn = deleteSection.findButton('Delete my account')
    assert(idleBtn !== null, 'expected an idle "Delete my account" button')
    assert(deleteSection.findButton('Yes, delete my account') === null, 'confirm button must not exist before the first click')
    return 'idle button located, distinct from any confirm control'
  })

  const fetchCallsNoTrigger = installFetchStub(async () => ({ ok: true, status: 200 }))

  test('a SINGLE click on the idle button shows the confirm step and calls NO fetch at all', () => {
    const idleBtn = deleteSection.findButton('Delete my account')
    idleBtn.fire('click')
    assert(fetchCallsNoTrigger.length === 0, `expected zero fetch calls from one click, got ${fetchCallsNoTrigger.length}`)
    const confirmBtn = deleteSection.findButton('Yes, delete my account')
    assert(confirmBtn !== null, 'expected a distinct "Yes, delete my account" confirm button to appear')
    const cancelBtn = deleteSection.findButton('Cancel')
    assert(cancelBtn !== null, 'expected a "Cancel" escape hatch out of the confirm step')
    return 'confirm step appeared; the server was never contacted by the first tap'
  })

  test('the confirm copy states the action is irreversible and names achievement progress', () => {
    const whole = deleteSection.textContent.toLowerCase()
    assert(whole.includes('cannot be undone') || whole.includes('no recovery'), 'expected explicit irreversibility language')
    assert(whole.includes('achievement'), 'expected the copy to name achievement progress specifically, per the D3 brief')
  })

  test('Cancel returns to the idle state without ever calling fetch', () => {
    const cancelBtn = deleteSection.findButton('Cancel')
    cancelBtn.fire('click')
    assert(fetchCallsNoTrigger.length === 0, 'Cancel must not touch the network')
    const idleBtn = deleteSection.findButton('Delete my account')
    assert(idleBtn !== null, 'expected the idle button back after Cancel')
    assert(deleteSection.findButton('Yes, delete my account') === null, 'confirm controls must be gone after Cancel')
  })

  // --- now actually confirm, against a 200 OK server -----------------------
  const okCalls = installFetchStub(async () => ({ ok: true, status: 200 }))
  deleteSection.findButton('Delete my account').fire('click')
  deleteSection.findButton('Yes, delete my account').fire('click')
  await flush()

  test('confirming calls POST /auth/delete exactly once, same-origin credentials', () => {
    assert(okCalls.length === 1, `expected exactly one fetch call, got ${okCalls.length}`)
    assert(okCalls[0].url === '/auth/delete', `expected url '/auth/delete', got ${JSON.stringify(okCalls[0].url)}`)
    assert(okCalls[0].opts?.method === 'POST', 'expected a POST')
    assert(okCalls[0].opts?.credentials === 'same-origin', 'expected same-origin credentials (cookie must ride along)')
  })

  test('a server-acknowledged delete (2xx) fires onDeleted()', () => {
    assert(onDeletedCalls === 1, `expected onDeleted() to fire exactly once, got ${onDeletedCalls} calls`)
  })

  // --- a failed delete must NOT fire onDeleted() and must say so ----------
  const failSection = buildDeleteSection(callbacks)
  const failCalls = installFetchStub(async () => ({ ok: false, status: 500 }))
  failSection.findButton('Delete my account').fire('click')
  failSection.findButton('Yes, delete my account').fire('click')
  await flush()

  test('a failed delete (non-2xx) does NOT fire onDeleted() and shows an error, not silence', () => {
    assert(onDeletedCalls === 1, 'onDeleted() must not fire again on a failed delete (still 1 from the earlier success case)')
    const whole = failSection.textContent.toLowerCase()
    assert(whole.includes("couldn't") || whole.includes('error') || whole.includes('try again'), 'expected a visible failure message, not silent failure')
  })

  restoreFetch()
  restoreDom()
  await rm(tmp, { recursive: true, force: true })
}

// ===========================================================================
section('3. Sign-out degrades gracefully on 404, succeeds on 2xx')
// ===========================================================================
{
  const { tmp, outfile } = await bundle(accountPath, 'account2.mjs')
  installDomStub()
  const { buildSignOutSection } = await import(pathToFileURL(outfile).href)

  // --- route not deployed yet (current reality — see account.ts's header) -
  let signedOutCalls = 0
  const callbacks404 = { onSignedOut: () => signedOutCalls++, onDeleted: () => {} }
  const section404 = buildSignOutSection(callbacks404)
  const calls404 = installFetchStub(async () => ({ ok: false, status: 404 }))
  section404.findButton('Sign out').fire('click')
  await flush()

  test('POST /auth/signout is what the client actually calls (same-origin)', () => {
    assert(calls404.length === 1, `expected one fetch call, got ${calls404.length}`)
    assert(calls404[0].url === '/auth/signout', `expected '/auth/signout', got ${JSON.stringify(calls404[0].url)}`)
    assert(calls404[0].opts?.method === 'POST', 'expected POST')
  })

  test('a 404 (route not deployed) does NOT fire onSignedOut() and says so honestly, not "you are signed out"', () => {
    assert(signedOutCalls === 0, 'must not claim success on a 404')
    const whole = section404.textContent.toLowerCase()
    assert(whole.includes("isn't available") || whole.includes('not available'), 'expected an honest "not available yet" message on 404')
    assert(!whole.includes('signed out') && !whole.includes('successfully'), 'must not falsely claim the sign-out succeeded')
  })

  // --- route deployed, succeeds -------------------------------------------
  const sectionOk = buildSignOutSection(callbacks404)
  const callsOk = installFetchStub(async () => ({ ok: true, status: 204 }))
  sectionOk.findButton('Sign out').fire('click')
  await flush()

  test('a 2xx response fires onSignedOut() exactly once', () => {
    assert(signedOutCalls === 1, `expected onSignedOut() to fire exactly once total, got ${signedOutCalls}`)
  })

  restoreFetch()
  restoreDom()
  await rm(tmp, { recursive: true, force: true })
}

// ===========================================================================
section('4. Export is a real link at the real endpoint, not an empty promise')
// ===========================================================================
{
  const { tmp, outfile } = await bundle(accountPath, 'account3.mjs')
  installDomStub()
  const { buildExportSection } = await import(pathToFileURL(outfile).href)
  const exportSection = buildExportSection()

  test('the export control is a real <a> pointed at GET /auth/export', () => {
    const link = exportSection.findByTag('A')
    assert(link !== null, 'expected an <a> element in the export section')
    assert(link.href === '/auth/export', `expected href '/auth/export', got ${JSON.stringify(link.href)}`)
    return 'a real, navigable, session-cookie-carrying link — no fetch/blob plumbing needed for a same-origin download'
  })

  restoreDom()
  await rm(tmp, { recursive: true, force: true })
}

// ===========================================================================
section('5. ui/session.ts: one /whoami call serves every caller this page load')
// ===========================================================================
{
  const { tmp, outfile } = await bundle(sessionPath, 'session.mjs')
  const calls = installFetchStub(async () => ({
    ok: true,
    json: async () => ({ user: 'uid-abc123' }),
  }))
  const { getSession } = await import(pathToFileURL(outfile).href)

  const [a, b] = await Promise.all([getSession(), getSession()])

  test('two concurrent getSession() callers trigger exactly ONE /whoami fetch', () => {
    assert(calls.length === 1, `expected exactly 1 fetch, got ${calls.length} — this is the exact mechanism D6's fix depends on`)
    assert(calls[0].url === '/whoami', `expected '/whoami', got ${JSON.stringify(calls[0].url)}`)
    assert(calls[0].opts?.credentials === 'same-origin', 'expected same-origin credentials')
  })

  const c = await getSession() // awaited OUTSIDE test() — see this file's header on why
  test('a THIRD, later call still reuses the cached result — no re-fetch', () => {
    assert(calls.length === 1, `expected still exactly 1 fetch after a 3rd caller, got ${calls.length}`)
    assert(c && c.uid === 'uid-abc123', 'expected the cached session to resolve consistently')
  })

  test('both concurrent callers resolved to the same uid', () => {
    assert(a && b && a.uid === 'uid-abc123' && b.uid === 'uid-abc123', 'expected both callers to see the resolved session')
  })

  restoreFetch()
  await rm(tmp, { recursive: true, force: true })
}

// ===========================================================================
section('6. ui/cookieWarning.ts: D8 banner is plain-language and dismissible')
// ===========================================================================
{
  const { tmp, outfile } = await bundle(cookieWarningPath, 'cookieWarning.mjs')
  installDomStub()
  const { renderCookieBlockedBanner } = await import(pathToFileURL(outfile).href)
  const banner = renderCookieBlockedBanner()

  test('the banner names the actual mechanism (cookie/browser), not a vague error', () => {
    const whole = banner.textContent.toLowerCase()
    assert(whole.includes('cookie'), 'expected the word "cookie" — this is what actually broke')
    assert(whole.includes('browser'), 'expected "browser" — the actionable thing a reader can go check')
  })

  test('the banner has a dismiss control that actually removes it', () => {
    const closeBtn = banner.findByTag('BUTTON')
    assert(closeBtn !== null, 'expected a dismiss button')
    closeBtn.fire('click')
    assert(banner._removed === true, 'expected the dismiss button to remove the banner from the DOM')
  })

  restoreDom()
  await rm(tmp, { recursive: true, force: true })
}

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
