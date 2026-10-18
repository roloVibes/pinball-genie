#!/usr/bin/env node
// app/tests/adslot-gate.test.mjs — SUITE 6: ui/adslot.ts's invalid-traffic gate.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/adslot-gate.test.mjs"
// or from app/:
//   node tests/adslot-gate.test.mjs
//
// WHY THIS SUITE EXISTS (2026-07-30). `shouldRenderNetworkAds()` is a gate with
// no call site yet — no ad network is wired in, so Rollup tree-shakes it out of
// the shipped bundle entirely. That makes it the most rot-prone code in the
// repo: nothing imports it, nothing exercises it, and the day someone finally
// does wire up a network they will be under time pressure and will trust it.
// Its failure mode is not a broken page, it is Google closing the AdSense
// account permanently (their invalid-traffic policy escalates to closure, and
// closure blocks opening a new account) — a consequence no runtime error
// surfaces and no user reports. So the gate gets a test BEFORE it gets a
// caller.
//
// The contract under test, from adslot.ts's own doc comment: the function
// FAILS CLOSED. Every ambiguous or unverifiable condition must return false.
// Returning `true` is the privileged answer and must require every check to
// affirmatively pass.
//
// Pattern: identical to arview-seams.test.mjs / selftest.mjs — esbuild bundles
// the REAL ui/adslot.ts (never edited, never copied) into a temp ESM file which
// is dynamically imported and called directly. Exits non-zero on any FAIL.
//
// Note on bundling: adslot.ts imports './adslot.css', which esbuild cannot
// parse as JS, so the build below marks .css as an external no-op via a tiny
// plugin. mountAdSlot() is not exercised here (it needs a DOM); this suite is
// scoped to the pure predicate.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const adslotPath = resolve(srcDir, 'ui/adslot.ts')

// ---------------------------------------------------------------------------
// Minimal test harness (no vitest/tsx in this repo — see selftest.mjs's header)
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
// Bundle the real source
// ---------------------------------------------------------------------------
const cssNoop = {
  name: 'css-noop',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-noop' }))
    b.onLoad({ filter: /.*/, namespace: 'css-noop' }, () => ({ contents: '', loader: 'js' }))
  },
}

const tmp = await mkdtemp(resolve(tmpdir(), 'pg-adslot-gate-'))
const outfile = resolve(tmp, 'adslot.mjs')
await build({
  entryPoints: [adslotPath],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  plugins: [cssNoop],
  logLevel: 'silent',
})
const { shouldRenderNetworkAds } = await import(pathToFileURL(outfile).href)
const adslotSrc = readFileSync(adslotPath, 'utf8')

/** adslot.ts is heavily commented on purpose — the invalid-traffic rationale
 *  and the future call-site sketch both live in comments, and both legitimately
 *  contain the very strings the source-level invariants below search for
 *  (`shouldRenderNetworkAds(...)`, `aria-hidden`). Matching raw source
 *  therefore produces false failures on prose. Strip comments first so these
 *  assertions test CODE. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. jsdoc)
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // line comments, keeping `https://` intact
}
const adslotCode = codeOnly(adslotSrc)

// ---------------------------------------------------------------------------
// A controllable stand-in for the browser globals the gate reads.
// ---------------------------------------------------------------------------
const PROD = 'pinball-genie.com'

function withEnv({ hostname, killSwitch, localStorageThrows = false, noWindow = false }, fn) {
  const savedWindow = globalThis.window
  if (noWindow) {
    delete globalThis.window
  } else {
    globalThis.window = {
      location: hostname === undefined ? undefined : { hostname },
      localStorage: {
        getItem(k) {
          if (localStorageThrows) throw new Error('localStorage disabled (private mode)')
          return k === 'pg_ads_kill_switch' ? (killSwitch === undefined ? null : killSwitch) : null
        },
      },
    }
  }
  try {
    return fn()
  } finally {
    if (savedWindow === undefined) delete globalThis.window
    else globalThis.window = savedWindow
  }
}

const onProd = (user, killSwitch) => withEnv({ hostname: PROD, killSwitch }, () => shouldRenderNetworkAds(user))

// ===========================================================================
section('1. The only path that returns true')
// ===========================================================================
test('signed-out, production hostname, no kill switch -> true', () => {
  assert(onProd(null) === true, 'expected true for the one fully-verified case')
  assert(onProd(undefined) === true, 'undefined user must behave the same as null (signed out)')
  return 'this is the ONLY combination that may serve a network ad'
})

// ===========================================================================
section('2. Signed-in sessions never generate our own impressions')
// ===========================================================================
for (const user of ['owner', 'tester1', 'tester2', 'guest1', 'guest2', 'guest3']) {
  test(`signed in as "${user}" on production -> false`, () => {
    assert(onProd(user) === false, `expected false for signed-in user ${user}`)
  })
}
test('an owner-shaped session on prod is refused even with no kill switch set', () => {
  assert(onProd('owner', undefined) === false, 'session check must not depend on the kill switch')
  return 'the 6 known accounts are exactly the audience invalid-traffic detection is built to catch'
})

// ===========================================================================
section('3. Non-production hosts are refused (dev/staging/deploy checks)')
// ===========================================================================
for (const host of [
  'localhost',
  '127.0.0.1',
  '203.0.113.7',
  'pinball-203-0-113-7.nip.io',
  'staging.pinball-genie.com',
  'www.pinball-genie.com',
  'pinball-genie.com.evil.example',
  'PINBALL-GENIE.COM',
]) {
  test(`hostname "${host}" -> false`, () => {
    assert(withEnv({ hostname: host }, () => shouldRenderNetworkAds(null)) === false, `expected false on ${host}`)
  })
}
test('www is refused deliberately, not by oversight', () => {
  // Caddy 301s www -> apex, so a browser that still reports www.* did not
  // arrive through the canonical origin. Fail closed rather than assume.
  assert(withEnv({ hostname: 'www.pinball-genie.com' }, () => shouldRenderNetworkAds(null)) === false, 'www must be false')
  return 'www 301s to the apex in production; a live www hostname means something unexpected'
})

// ===========================================================================
section('4. Kill switch — must fail CLOSED on any plausible spelling')
// ===========================================================================
// REGRESSION GUARD (2026-07-30): the gate previously tested `=== '1'`, so
// `localStorage.pg_ads_kill_switch = true` — the most natural thing an owner
// would actually type into a devtools console — coerced to the string 'true'
// and left ads serving while appearing to be switched off. For a control whose
// whole purpose is failing closed, the likely-mistyped spelling must not be the
// one that fails open.
for (const flag of ['1', 'true', 'TRUE', 'yes', 'on', 'off?', 'kill', ' ', '0.0', 'null']) {
  test(`kill switch "${flag}" -> false (ads suppressed)`, () => {
    assert(onProd(null, flag) === false, `expected kill switch value ${JSON.stringify(flag)} to suppress ads`)
  })
}
for (const flag of ['0', 'false', '']) {
  test(`kill switch ${JSON.stringify(flag)} -> true (explicitly off)`, () => {
    assert(onProd(null, flag) === true, `expected ${JSON.stringify(flag)} to mean "switch not thrown"`)
  })
}
test('absent kill switch (null) -> true', () => {
  assert(onProd(null, undefined) === true, 'an unset flag must not suppress ads')
})

// ===========================================================================
section('5. Unverifiable environments fail closed')
// ===========================================================================
test('no window at all (SSR / prerender) -> false', () => {
  assert(withEnv({ noWindow: true }, () => shouldRenderNetworkAds(null)) === false, 'expected false with no window')
  return 'Phase 4 adds build-time prerendering — this path becomes reachable then'
})
test('window with no location -> false', () => {
  assert(withEnv({ hostname: undefined }, () => shouldRenderNetworkAds(null)) === false, 'expected false with no location')
})
test('localStorage throwing (private mode / storage disabled) -> false', () => {
  assert(
    withEnv({ hostname: PROD, localStorageThrows: true }, () => shouldRenderNetworkAds(null)) === false,
    'expected false when localStorage access throws',
  )
  return 'cannot read the kill switch => cannot prove it is off => refuse'
})

// ===========================================================================
section('6. Source-level invariants (catch a well-meaning refactor)')
// ===========================================================================
test('the production hostname is the bare apex, exactly once', () => {
  assert(/PRODUCTION_HOSTNAME\s*=\s*'pinball-genie\.com'/.test(adslotSrc), "expected PRODUCTION_HOSTNAME = 'pinball-genie.com'")
  return 'a wildcard/endsWith match here would re-admit staging subdomains'
})
test('the hostname check is strict equality, not endsWith/includes', () => {
  assert(
    /hostname\s*!==\s*PRODUCTION_HOSTNAME/.test(adslotSrc),
    'expected a strict !== comparison against PRODUCTION_HOSTNAME',
  )
  assert(
    !/hostname\.(endsWith|includes|indexOf|match)\s*\(/.test(adslotSrc),
    'hostname must NOT be matched with endsWith/includes/indexOf/match — "pinball-genie.com.evil.example" would pass',
  )
})
test('the signed-in check is the first thing the function does', () => {
  const body = adslotSrc.slice(adslotSrc.indexOf('export function shouldRenderNetworkAds'))
  const firstReturn = body.indexOf('return false')
  const userCheck = body.indexOf('if (user) return false')
  assert(userCheck !== -1, 'expected `if (user) return false` in shouldRenderNetworkAds')
  assert(userCheck <= firstReturn, 'the session check must precede every other refusal')
})
test('localStorage access stays wrapped in try/catch', () => {
  const body = adslotSrc.slice(adslotSrc.indexOf('export function shouldRenderNetworkAds'))
  assert(/try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/.test(body), 'expected localStorage read inside try/catch')
})
test('the house banner is NOT gated by this function', () => {
  const mount = adslotCode.slice(
    adslotCode.indexOf('export function mountAdSlot'),
    adslotCode.indexOf('export function shouldRenderNetworkAds'),
  )
  assert(mount.length > 0, 'could not locate mountAdSlot in the comment-stripped source')
  assert(
    !mount.includes('shouldRenderNetworkAds'),
    'mountAdSlot must render the self-hosted house banner unconditionally (the documented seam in its comments is fine — a real call is not)',
  )
  return 'our own banner is not third-party ad inventory and carries no invalid-traffic risk'
})
test('the "Advertisement" disclosure label is not hidden from assistive tech', () => {
  // Scope this to the `label` element specifically. The house banner's chevron
  // (`cta`) IS legitimately aria-hidden — the whole row is a single link, so the
  // chevron is a visual affordance rather than a second control. Asserting on
  // "no aria-hidden anywhere in the file" would wrongly fail on that.
  const labelBlock = adslotCode.slice(adslotCode.indexOf("label.className = 'ad-slot-label'"))
  const labelStmts = labelBlock.slice(0, labelBlock.indexOf('el.append('))
  assert(labelStmts.includes("label.textContent = 'Advertisement'"), 'expected the Advertisement label text')
  assert(
    !/label\.setAttribute\(\s*['"]aria-hidden['"]/.test(labelStmts),
    'the Advertisement label is a required disclosure, not decoration — it must not be aria-hidden',
  )
  return 'label exposed to assistive tech; the decorative chevron on the house banner stays hidden'
})

// ===========================================================================
section('c. The strip is CENTRED on its copy (rolo, 2026-08-14)')
// ===========================================================================
// "I see the follow pinball genie text on a bottom banner is not centered,
// make sure that gets centered."
//
// It could not be, in the old shape: the "Follow" pill lived inside the banner
// link, so the row was [label][link[copy][pill]] and the copy's centre was
// displaced by half the label's width — measured in Chrome at 10px left of the
// viewport centre at 390px, 11px right of it at 320px (the copy ellipsizes
// there, which moves it the other way).
//
// The fix is structural and constant-free: the label and the pill are SIBLING
// end slots, both `flex: 1 1 0`, so they resolve to equal widths and the copy
// lands on the true centre at any width. This section pins the three things
// that make it work, because every one of them is a plausible "tidy-up" for
// someone who does not know what it is holding up.
{
  const css = readFileSync(resolve(srcDir, 'ui/adslot.css'), 'utf8')
  const rule = (sel) => {
    const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
    return m ? m[1] : null
  }

  test('the label and the CTA are EQUAL end slots — flex: 1 1 0 on both', () => {
    for (const sel of ['.ad-slot-label', '.ad-slot-cta']) {
      const body = rule(sel)
      assert(body, `no ${sel} rule found`)
      assert(/flex:\s*1\s+1\s+0/.test(body), `${sel} must be \`flex: 1 1 0\` — unequal end slots are exactly what put the copy off centre`)
    }
    // And the middle must NOT grow, or it would eat the slots it is centred
    // between and the equality would stop meaning anything.
    const creative = rule('.ad-slot-creative')
    assert(/flex:\s*0\s+1\s+auto/.test(creative), 'the creative must be `flex: 0 1 auto` — a growing middle is not a centred middle')
    assert(/justify-content:\s*center/.test(creative), 'the creative centres its own content too (it is the middle slot)')
    return 'label 1 1 0 | creative 0 1 auto | cta 1 1 0'
  })

  test('neither end slot can shrink below its own text — the disclosure is never the thing that gets cut', () => {
    // A flex item's automatic minimum is min-content, and `nowrap` makes that
    // the full string. Without it, `flex: 1 1 0` would happily clip the
    // "ADVERTISEMENT" label at 320px, where the row genuinely runs out of room.
    for (const sel of ['.ad-slot-label', '.ad-slot-cta']) {
      assert(/white-space:\s*nowrap/.test(rule(sel)), `${sel} must be nowrap so its automatic minimum protects it at 320px`)
    }
    return 'both ends nowrap; at 320 they keep their text and the copy ellipsizes instead'
  })

  test('the CTA is a real link, aria-hidden and out of the tab order — one control, still tappable', () => {
    // It left the banner link to become the right end slot. That must not add
    // a second thing for a screen reader or the keyboard to find: the strip
    // still exposes exactly ONE link, the labelled one.
    const cta = adslotCode.slice(adslotCode.indexOf('function renderHouseCta'))
    assert(cta.length > 0, 'could not find renderHouseCta in the comment-stripped source')
    assert(/createElement\('a'\)/.test(cta), 'the pill must stay a real <a> — it is the most pressable-looking thing in the strip')
    assert(/setAttribute\(\s*'aria-hidden',\s*'true'\s*\)/.test(cta), 'the pill must stay aria-hidden — it duplicates the banner link')
    assert(/tabIndex\s*=\s*-1/.test(cta), 'the pill must be out of the tab order, or the strip has two tab stops for one destination')
    assert(/INSTAGRAM_URL/.test(cta), 'the pill must use the shared profile URL, not a second copy of it')
    return 'one focusable link, one aria-exposed link, two tappable regions'
  })
}

await rm(tmp, { recursive: true, force: true })

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
