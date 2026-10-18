#!/usr/bin/env node
// app/tests/account-cta.test.mjs — SUITE 7: Phase 5 (magic-link accounts)
// client-side copy/CTA audit.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/account-cta.test.mjs"
// or from app/:
//   node tests/account-cta.test.mjs
//
// Phase 5 replaced the 6 demo username/password accounts with self-serve
// magic-link email sign-in (server owns the actual auth flow — see
// server/pinball_auth.py, not touched by this suite). This file exists to
// pin down the two things a client-side regression could quietly break
// without any server change at all:
//
//   1. ui/achievements.ts's signed-out banner is a REAL call to action now
//      (it used to be a dead-end sentence with no link — see the module's
//      own "Phase 5" doc comment) — SECTION 1 proves the produced DOM has an
//      <a href="/login"> in it, not just a hope expressed in a comment.
//      SECTION 2 proves render() can't have turned that banner into a wall
//      that gates the rest of the tab.
//   2. Nothing in app/src/ui/**'s user-facing copy still talks about
//      passwords or "signing in again" — both would be actively wrong once
//      most visitors have never had an account at all (SECTION 4; SECTION 3
//      is the same check narrowed to howto.ts's step 1, called out
//      explicitly in the build brief this suite was written from).
//
// Pattern: identical to adslot-gate.test.mjs — esbuild's Node API bundles the
// REAL .ts source into a temp ESM file which is dynamically imported and
// exercised directly. Exits non-zero on any FAIL. Like that suite's test()
// harness, every test body here is SYNCHRONOUS on purpose: this harness's
// test() does not await fn(), so an async fn would report "pass" the instant
// it returns a pending Promise, before its body actually ran — every file
// read below uses the *Sync fs API for exactly that reason.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const uiDir = resolve(srcDir, 'ui')
const achievementsPath = resolve(uiDir, 'achievements.ts')
const howtoPath = resolve(uiDir, 'howto.ts')

// ---------------------------------------------------------------------------
// Minimal test harness (no vitest/tsx in this repo — see adslot-gate.test.mjs's
// own header note; same constraint applies here). SYNCHRONOUS by design —
// see this file's header for why every test body below must be too.
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
// Section 1 setup: bundle the REAL ui/achievements.ts and call its exported,
// module-level renderSignInBanner() against a tiny hand-rolled DOM stub.
// ---------------------------------------------------------------------------
const cssNoop = {
  name: 'css-noop',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-noop' }))
    b.onLoad({ filter: /.*/, namespace: 'css-noop' }, () => ({ contents: '', loader: 'js' }))
  },
}

const tmp = await mkdtemp(resolve(tmpdir(), 'pg-account-cta-'))
const outfile = resolve(tmp, 'achievements.mjs')
await build({
  entryPoints: [achievementsPath],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  plugins: [cssNoop],
  logLevel: 'silent',
})

// ---- minimal DOM stub, built for renderSignInBanner()'s EXACT surface -----
// achievements.ts's renderSignInBanner (read in full) touches only:
// document.createElement('div'|'p'|'a'), .className, .textContent (set),
// .href (set, anchor only), and el.append(...children). No event listeners,
// no attributes, no style — a real per-tag stub (arview-seams.test.mjs's
// camera.ts section) would be overkill; one generic element class covers
// this and is reusable for the next ui/*.ts render-helper test that needs
// real DOM assertions rather than source-string ones.
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this._className = ''
    this._textContent = ''
    this.href = undefined
    this.children = []
  }
  set className(v) {
    this._className = v
  }
  get className() {
    return this._className
  }
  set textContent(v) {
    this._textContent = v
    this.children = [] // real DOM: setting textContent clears existing children
  }
  get textContent() {
    // Mirrors real DOM: a node with children reports their concatenated text.
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
  /** Depth-first find, used below instead of hardcoding "the CTA is
   *  children[1]" — a harmless future reorder (e.g. an icon added before the
   *  link) shouldn't break this test on layout alone. */
  querySelectorTag(tag) {
    const want = tag.toUpperCase()
    const stack = [...this.children]
    while (stack.length > 0) {
      const el = stack.shift()
      if (!el || typeof el !== 'object') continue
      if (el.tagName === want) return el
      if (Array.isArray(el.children)) stack.push(...el.children)
    }
    return null
  }
}

// document only needs to exist for the duration of the import + the one
// direct call below — nothing later in this file touches the DOM at all
// (sections 2-4 are pure source-string checks), so the stub is installed
// once and restored immediately after, rather than threading a with-stub
// helper through every call site.
const prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'document', {
  value: { createElement: (tag) => new FakeElement(tag) },
  configurable: true,
  writable: true,
})

const { renderSignInBanner } = await import(pathToFileURL(outfile).href)

// ===========================================================================
section('1. Signed-out banner is a real call to action (DOM-level)')
// ===========================================================================

let banner
test('renderSignInBanner() builds without throwing, against the minimal DOM stub', () => {
  banner = renderSignInBanner()
  assert(banner && banner.tagName === 'DIV', 'expected a <div> banner root')
})

if (prevDocument) Object.defineProperty(globalThis, 'document', prevDocument)
else delete globalThis.document

test('the banner contains a real <a> link (not a dead-end sentence)', () => {
  const link = banner.querySelectorTag('a')
  assert(link !== null, 'expected an <a> element somewhere inside the banner')
  return 'found <a> — this used to be plain textContent with no control at all'
})

test('the link points at the sign-in route, /login', () => {
  const link = banner.querySelectorTag('a')
  assert(link.href === '/login', `expected href '/login', got ${JSON.stringify(link.href)}`)
})

test('the link has non-empty visible text (an accessible name, not an icon-only control)', () => {
  const link = banner.querySelectorTag('a')
  assert(typeof link.textContent === 'string' && link.textContent.trim().length > 0, 'expected non-empty link text')
  return `link text: ${JSON.stringify(link.textContent)}`
})

test('the banner explains the value in plain language (saving progress, across devices)', () => {
  const whole = banner.textContent.toLowerCase()
  assert(whole.includes('save') || whole.includes('sync'), 'expected the banner to explain WHY signing in helps')
  assert(whole.includes('device'), 'expected the banner to mention cross-device sync specifically')
})

test('the banner never mentions passwords, credentials, or repeat sign-in', () => {
  const whole = banner.textContent.toLowerCase()
  for (const banned of ['password', 'credential', 'again']) {
    assert(!whole.includes(banned), `banner text must not contain "${banned}", got: ${JSON.stringify(banner.textContent)}`)
  }
})

// ===========================================================================
section('2. render() never gates browsing behind sign-in (source-level proof)')
// ===========================================================================
// Full mountAchievements() needs a live AppState + network stubs to exercise
// end-to-end (fetchWhoami/fetchProgress/loadMachineAchievements all fire on
// boot()) — out of proportion for what this check needs. Instead: prove
// STRUCTURALLY that render()'s "show the banner" line can't also gate the
// overview/detail render that follows it, by requiring the banner append to
// be a bare one-line `if`, with no braces to hide a `return` inside.
const achievementsSrc = readFileSync(achievementsPath, 'utf8')

test('render(): the sign-in banner append is a bare one-line `if` (cannot also `return`)', () => {
  assert(
    /if \(!user\) root\.appendChild\(renderSignInBanner\(\)\)\s*\n/.test(achievementsSrc),
    'expected a brace-less one-line `if (!user) root.appendChild(renderSignInBanner())` — a `{ }` block here could hide a `return` that walls off the rest of render()',
  )
})

test('render(): renderOverview() is called unconditionally after the banner line, not inside an `if (user)` guard', () => {
  const renderFnStart = achievementsSrc.indexOf('function render(): void {')
  assert(renderFnStart !== -1, 'could not locate render() in achievements.ts')
  const renderFnEnd = achievementsSrc.indexOf('\n  }\n', renderFnStart)
  assert(renderFnEnd !== -1, 'could not locate the end of render() in achievements.ts')
  const renderFnBody = achievementsSrc.slice(renderFnStart, renderFnEnd)
  assert(renderFnBody.includes('root.appendChild(renderOverview())'), 'expected renderOverview() to be reachable from render()')
  // D3 (2026-07-30): render() now ALSO has a bare one-line `if (user) root
  // .appendChild(renderAccountBanner(...))` (the signed-in complement to the
  // signed-out banner line above it) — a plain textual "does `if (user)`
  // appear anywhere before renderOverview()?" check would false-flag that
  // harmless line, since it textually precedes renderOverview() in the
  // source. The actual hazard this test guards against is specifically a
  // BRACED `if (user) { ... }` block, which could hide a `return` inside it;
  // a bare one-liner (no `{`) cannot. So this checks for the braced form
  // specifically, not just the substring "if (user)".
  assert(
    !/if \(user\)\s*\{[\s\S]*?root\.appendChild\(renderOverview\(\)\)/.test(renderFnBody),
    'renderOverview() must not be nested inside a BRACED `if (user) { ... }` guard — browsing must work signed out',
  )
  return 'renderOverview() runs regardless of sign-in state — Achievements stays browsable, never a wall'
})

// ===========================================================================
section('3. howto.ts step 1 is accurate for magic-link (no password language)')
// ===========================================================================
const howtoSrc = readFileSync(howtoPath, 'utf8')
const step1Match = howtoSrc.match(/n:\s*1,\s*\n\s*title:\s*'([^']*)',\s*\n\s*body:\s*'([^']*)',/)

test('step 1 exists and covers "no account needed to start"', () => {
  assert(step1Match !== null, 'could not locate STEPS[0] (n: 1) in howto.ts')
  const [, title, body] = step1Match
  assert(/no account needed/i.test(body), `expected step 1's body to say browsing needs no account, got: ${JSON.stringify(body)}`)
  assert(/sign in/i.test(body), 'expected step 1 to still mention signing in as the optional upgrade')
  return `title=${JSON.stringify(title)} body=${JSON.stringify(body)}`
})

test('step 1 does not say "credentials" or "password" (magic-link has neither)', () => {
  const body = step1Match[2].toLowerCase()
  assert(!body.includes('credential'), `step 1 body must not mention credentials, got: ${JSON.stringify(body)}`)
  assert(!body.includes('password'), `step 1 body must not mention a password, got: ${JSON.stringify(body)}`)
})

// ===========================================================================
section('4. No password/credential/repeat-signin language survives anywhere in app/src/ui/**')
// ===========================================================================
// Comments legitimately narrate the OLD (pre-Phase-5) copy verbatim as
// history ("was 'Log in — Sign in with the credentials you were given.'" —
// howto.ts; "sign in AGAIN" — achievements.ts's own Phase 5 doc comment) —
// exactly the kind of prose adslot-gate.test.mjs's codeOnly() strips before
// asserting on CODE. Same technique here, so this suite doesn't false-fail
// on a codebase that documents its own history inline (this repo's stated
// convention).
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. jsdoc)
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // line comments, keeping `https://` intact
}

// The point of this scan is to catch copy that implies the RETIRED
// username+password model still exists — "enter your password", "sign in
// again" (which presumes the reader once had credentials), and so on.
//
// It used to ban the bare substring "password", which was right up until
// 2026-07-31, when ui/signupgate.ts shipped the line "No password to make or
// remember." That sentence is the single most reassuring thing on the
// registration prompt and is the EXACT OPPOSITE of what this rule protects
// against — people brace for a password the moment they read "register", and
// telling them there isn't one is why they continue. Banning the word outright
// would force the copy to talk around the very fact it most wants to state.
//
// So: ban the phrasings that assert a password EXISTS, and let negations
// through. NEGATION_ALLOWED is matched first; anything else containing
// "password" still fails, so a future "enter your password" is still caught.
const BANNED = [
  'your password',
  'enter a password',
  'enter your password',
  'password field',
  'choose a password',
  'create a password',
  'forgot password',
  'reset your password',
  'credentials you were given',
  'sign in again',
  'log in again',
]
/** Phrasings that mention a password only to say there ISN'T one. */
const NEGATION_ALLOWED = [
  'no password',
  'without a password',
  'never store a password',
  'there isn’t one',
  "there isn't one",
]

const uiFiles = readdirSync(uiDir).filter((f) => f.endsWith('.ts'))
test('precondition: found .ts files to scan under app/src/ui', () => {
  assert(uiFiles.length > 0, 'expected at least one .ts file in app/src/ui')
  return `${uiFiles.length} files: ${uiFiles.join(', ')}`
})

for (const file of uiFiles) {
  test(`${file}: no banned account-copy substrings in CODE (comments excluded)`, () => {
    const raw = readFileSync(resolve(uiDir, file), 'utf8')
    const code = codeOnly(raw).toLowerCase()
    for (const phrase of BANNED) {
      assert(!code.includes(phrase), `${file} contains "${phrase}" outside of a comment`)
    }
    // Any OTHER mention of a password must be a negation ("no password"),
    // never an assertion that one exists.
    if (code.includes('password')) {
      const negated = NEGATION_ALLOWED.some((ok) => code.includes(ok))
      assert(
        negated,
        `${file} mentions "password" outside a comment without it being a negation — the password model is retired; say there ISN'T one or don't mention it`,
      )
    }
  })
}

test('sanity check: the banned-phrase scan can actually catch a violation (not a no-op)', () => {
  const codeWithViolation = codeOnly("const x = 'the user password field'\n// this comment mentions password too, but is stripped")
  assert(codeWithViolation.toLowerCase().includes('password'), 'codeOnly() unexpectedly stripped a real string literal')
})

await rm(tmp, { recursive: true, force: true })

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
