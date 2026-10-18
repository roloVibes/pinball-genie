#!/usr/bin/env node
// app/tests/signup-gate.test.mjs — SUITE 9: ui/signupgate.ts, the
// "unlock Achievements" prompt shown to signed-out visitors.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/signup-gate.test.mjs"
// or from app/:
//   node tests/signup-gate.test.mjs
//
// WHY THIS SUITE EXISTS. The gate is the only thing standing between a
// signed-out visitor and a tab that cannot work for them, and it is easy to
// break in a way nothing else notices: the dismiss path in app.ts routes
// through a callback, and if that callback stops firing the visitor is
// stranded on an empty Achievements panel with no way back except a page
// reload. That failure is invisible to a typecheck, invisible to a build, and
// invisible to every other suite here.
//
// Equally important is the inverse: a signed-IN user must NEVER see this
// prompt. Showing "create an account" to somebody who already has one reads
// as the app having lost their session, which is exactly the moment people
// give up on a product. app.ts guards that by awaiting getSession() and
// treating only a resolved-null as signed out — the third state (`undefined`,
// "not known yet") must not be mistaken for "signed out". That sequencing is
// asserted at the source level below, since it lives in app.ts rather than in
// this module.
//
// Pattern: same as account-settings.test.mjs / adslot-gate.test.mjs — esbuild
// bundles the REAL ui/signupgate.ts against a minimal hand-rolled DOM stub.
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const gatePath = resolve(srcDir, 'ui/signupgate.ts')
const appPath = resolve(srcDir, 'app.ts')

// ---------------------------------------------------------------------------
// Harness
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

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------
class FakeNode {
  constructor(text) {
    this._text = text
  }
  get textContent() {
    return this._text
  }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.className = ''
    this.id = ''
    this.href = undefined
    this.type = undefined
    this._text = ''
    this.children = []
    this._listeners = {}
    this._attrs = {}
    this._removed = false
    this._focused = false
  }
  set textContent(v) {
    this._text = v
    this.children = []
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('')
    return this._text
  }
  append(...n) {
    this.children.push(...n)
  }
  appendChild(n) {
    this.children.push(n)
    return n
  }
  setAttribute(k, v) {
    this._attrs[k] = v
  }
  getAttribute(k) {
    return this._attrs[k]
  }
  addEventListener(t, fn) {
    ;(this._listeners[t] ||= []).push(fn)
  }
  removeEventListener(t, fn) {
    this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn)
  }
  focus() {
    this._focused = true
  }
  remove() {
    this._removed = true
    if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this)
  }
  fire(type, evt = {}) {
    for (const fn of this._listeners[type] || []) fn(evt)
  }
  /** Depth-first search by class name — the assertions below address elements
   *  the way a reader of signupgate.ts would, by their class. */
  find(cls) {
    if (typeof this.className === 'string' && this.className.split(/\s+/).includes(cls)) return this
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        const hit = c.find(cls)
        if (hit) return hit
      }
    }
    return null
  }
  findAll(cls, acc = []) {
    if (typeof this.className === 'string' && this.className.split(/\s+/).includes(cls)) acc.push(this)
    for (const c of this.children) if (c instanceof FakeElement) c.findAll(cls, acc)
    return acc
  }
}

const docListeners = {}
const body = new FakeElement('body')
Object.defineProperty(globalThis, 'document', {
  value: {
    createElement: (t) => new FakeElement(t),
    createTextNode: (t) => new FakeNode(t),
    body: {
      appendChild(n) {
        n._parent = body
        body.children.push(n)
        return n
      },
      get children() {
        return body.children
      },
    },
    addEventListener(t, fn) {
      ;(docListeners[t] ||= []).push(fn)
    },
    removeEventListener(t, fn) {
      docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn)
    },
  },
  configurable: true,
  writable: true,
})
function fireDoc(type, evt) {
  for (const fn of [...(docListeners[type] || [])]) fn(evt)
}
function currentOverlay() {
  return body.children[body.children.length - 1] || null
}
function resetBody() {
  body.children = []
}

// ---------------------------------------------------------------------------
// Bundle the real module
// ---------------------------------------------------------------------------
const cssNoop = {
  name: 'css-noop',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css-noop' }))
    b.onLoad({ filter: /.*/, namespace: 'css-noop' }, () => ({ contents: '', loader: 'js' }))
  },
}
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-gate-'))
const outfile = resolve(tmp, 'gate.mjs')
await build({
  entryPoints: [gatePath],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  plugins: [cssNoop],
  logLevel: 'silent',
})
const { openSignupGate } = await import(pathToFileURL(outfile).href)
const gateSrc = readFileSync(gatePath, 'utf8')
const appSrc = readFileSync(appPath, 'utf8')

// ===========================================================================
section('1. It renders, and it explains WHY before it asks')
// ===========================================================================
test('opening mounts an overlay into document.body', () => {
  resetBody()
  openSignupGate(() => {})
  const o = currentOverlay()
  assert(o && o.className === 'pg-gate-overlay', 'expected a .pg-gate-overlay in body')
  assert(o.getAttribute('role') === 'dialog', 'expected role=dialog')
  assert(o.getAttribute('aria-modal') === 'true', 'expected aria-modal=true')
})

test('the primary action points at the sign-in page', () => {
  resetBody()
  openSignupGate(() => {})
  const primary = currentOverlay().find('pg-gate-primary')
  assert(primary, 'no primary action found')
  assert(primary.href === '/login', `expected href=/login, got ${primary.href}`)
  assert(/account/i.test(primary.textContent), `expected account-creation copy, got ${primary.textContent}`)
  return `primary = "${primary.textContent}" -> ${primary.href}`
})

test("the copy states rolo's actual reason: progress is per-account", () => {
  resetBody()
  openSignupGate(() => {})
  const text = currentOverlay().textContent.toLowerCase()
  assert(text.includes('account'), 'expected the word "account"')
  assert(
    text.includes('your own') || text.includes('tied to you') || text.includes('your progress'),
    'expected copy explaining that progress is per-account, not just an ask to register',
  )
  return 'reason stated before the ask'
})

test('it says everything else stays free, so this does not read as a paywall', () => {
  resetBody()
  openSignupGate(() => {})
  const text = currentOverlay().textContent.toLowerCase()
  assert(
    text.includes('free and open') || text.includes('no account at all'),
    'expected reassurance that the rest of the app needs no account',
  )
})

test('it tells the visitor there is no password, up front', () => {
  resetBody()
  openSignupGate(() => {})
  assert(/no password/i.test(currentOverlay().textContent), 'expected "no password" in the copy')
  return 'people brace for a password when they read "register"'
})

test('an existing user is offered sign-in, not only registration', () => {
  resetBody()
  openSignupGate(() => {})
  const already = currentOverlay().find('pg-gate-already')
  assert(already, 'expected an "already have one?" affordance')
  assert(/sign in/i.test(already.textContent), 'expected a Sign in link for existing users')
})

// ===========================================================================
section('2. Every escape hatch calls back exactly once — nobody gets stranded')
// ===========================================================================
for (const [label, act] of [
  ['"Not now" button', (o) => o.find('pg-gate-secondary').fire('click')],
  ['close X', (o) => o.find('pg-gate-close').fire('click')],
  ['Escape key', () => fireDoc('keydown', { key: 'Escape' })],
]) {
  test(`${label} dismisses and fires onDismiss once`, () => {
    resetBody()
    let calls = 0
    openSignupGate(() => calls++)
    const o = currentOverlay()
    act(o)
    assert(calls === 1, `expected exactly 1 onDismiss call, got ${calls}`)
    assert(o._removed, 'expected the overlay to be removed from the DOM')
  })
}

test('a backdrop click dismisses, but a click inside the card does NOT', () => {
  resetBody()
  let calls = 0
  openSignupGate(() => calls++)
  const o = currentOverlay()
  const card = o.find('pg-gate-card')
  o.fire('click', { target: card })
  assert(calls === 0, 'a click on the card must not close the dialog (text-selection drags)')
  o.fire('click', { target: o })
  assert(calls === 1, `expected 1 onDismiss after a true backdrop click, got ${calls}`)
})

test('dismissing twice cannot fire onDismiss twice', () => {
  resetBody()
  let calls = 0
  openSignupGate(() => calls++)
  const o = currentOverlay()
  o.find('pg-gate-secondary').fire('click')
  o.find('pg-gate-close').fire('click')
  fireDoc('keydown', { key: 'Escape' })
  assert(calls === 1, `expected exactly 1 onDismiss total, got ${calls} — app.ts would re-select the tab repeatedly`)
})

test('a non-Escape key does not dismiss', () => {
  resetBody()
  let calls = 0
  openSignupGate(() => calls++)
  fireDoc('keydown', { key: 'a' })
  assert(calls === 0, 'only Escape should dismiss')
})

test('the Escape handler is unbound after dismissal (no leak across opens)', () => {
  resetBody()
  let first = 0
  openSignupGate(() => first++)
  currentOverlay().find('pg-gate-secondary').fire('click')
  let second = 0
  openSignupGate(() => second++)
  fireDoc('keydown', { key: 'Escape' })
  assert(first === 1, `the first dialog's callback fired again: ${first}`)
  assert(second === 1, `expected the second dialog to handle Escape, got ${second}`)
})

test('destroy() removes the overlay WITHOUT firing onDismiss', () => {
  resetBody()
  let calls = 0
  const h = openSignupGate(() => calls++)
  // Grab the node BEFORE destroying: remove() detaches it from body.children,
  // so currentOverlay() is legitimately null afterwards.
  const o = currentOverlay()
  h.destroy()
  assert(calls === 0, 'destroy() is the programmatic path and must not bounce the tab')
  assert(o._removed, 'expected the overlay element to be removed')
  assert(currentOverlay() === null, 'expected it to be detached from body too')
})

// ===========================================================================
section('3. app.ts wiring — the half that lives outside this module')
// ===========================================================================
test('the Achievements tab consults getSession() before mounting', () => {
  assert(/getSession\(\)/.test(appSrc), 'expected app.ts to call getSession()')
  const achBlock = appSrc.slice(appSrc.indexOf("if (tab === 'achievements'"))
  assert(
    achBlock.indexOf('getSession') < achBlock.indexOf("import('./ui/achievements')"),
    'the session check must precede the dynamic import — otherwise the gated module ships to people who cannot use it',
  )
})

test('only a resolved-null session opens the gate (never the unknown state)', () => {
  assert(
    /if \(session\) return/.test(appSrc) || /if \(!session\)/.test(appSrc),
    'expected app.ts to branch on the resolved session value',
  )
  assert(
    !/peekSessionUser|peekSession\(/.test(appSrc),
    'app.ts must AWAIT the session, not peek synchronously — a pending answer is not "signed out", and peeking would show a registration prompt to a signed-in user mid-load',
  )
})

test('dismissal returns the visitor to the tab they came from', () => {
  assert(/lastOpenTab/.test(appSrc), 'expected app.ts to track the previous tab')
  assert(
    /tabBar\.select\(lastOpenTab\)/.test(appSrc),
    'expected the dismiss callback to re-select the previous tab, so nobody is stranded on an empty panel',
  )
})

test('the re-select is guarded against re-entrancy', () => {
  assert(
    /returningFromGate/.test(appSrc),
    'tabBar.select() re-enters the same handler; without a guard the gate can reopen itself in a loop',
  )
})

// ===========================================================================
section('4. CSP and asset hygiene')
// ===========================================================================
test('no inline styles or event-handler attributes', () => {
  assert(!/\.style\./.test(gateSrc), 'no inline style writes (style-src is self)')
  assert(!/setAttribute\(\s*['"]on\w+/.test(gateSrc), 'no on*= handler attributes')
  assert(!/innerHTML/.test(gateSrc), 'no innerHTML — build nodes explicitly')
})

test('the bullet markers are CSS, not emoji that can render as tofu', () => {
  const css = readFileSync(resolve(srcDir, 'ui/signupgate.css'), 'utf8')
  assert(/\.pg-gate-why li::before/.test(css), 'expected a CSS-drawn bullet')
})

await rm(tmp, { recursive: true, force: true })

const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
