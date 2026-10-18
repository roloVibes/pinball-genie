#!/usr/bin/env node
// app/tests/arview-seams.test.mjs — SUITE 3: ar/arview.ts calibration-integration
// seams (onCalibrated pipeline, sessionGen race guards, camera.ts lifecycle,
// stage-rect staleness, freeze-phase snapshot mismatch).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/arview-seams.test.mjs"
// or from app/:
//   node tests/arview-seams.test.mjs
//
// Pattern: identical to app/scripts/selftest.mjs — esbuild's Node API bundles
// the REAL .ts source (never edited, never copied) into a temp ESM file which
// is then dynamically imported and exercised directly. Exits non-zero on any
// FAIL.
//
// What's a real (executed) test vs. a documented code-trace:
//   SECTION 1 (coincident corners)     — real: bundles ar/homography.ts and
//     calls the REAL computeHomography(); the async-throw-semantics case
//     wraps it in a hand-written function structurally identical to
//     arview.ts's onCalibrated (that file exports only mountAR, so its
//     internals can't be imported — see the section comment).
//   SECTION 2 (sessionGen / tracker race) — real: bundles ar/tracker.ts with
//     a stub `Worker` global and proves destroy()-mid-init() hangs the
//     promise forever. The sessionGen-placement comparison itself (onCalibrated
//     vs tick()) is a code-trace, cited by exact line number.
//   SECTION 3 (stage-rect staleness)   — math-consequence test: coverFit/
//     displayToMedia/mediaToDisplay are LITERAL, labeled copies of
//     arview.ts's own (unexported, so unimportable) helpers, run against the
//     REAL bundled applyH/computeHomography from homography.ts.
//   SECTION 4 (camera.ts)              — real: bundles the REAL ar/camera.ts
//     against a minimal hand-rolled DOM/navigator stub (documented inline).
//   SECTION 5 (freeze-phase mismatch)  — math-consequence test, same
//     literal-copy approach as section 3.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')

// ---------------------------------------------------------------------------
// Minimal test harness (no vitest/tsx in this repo — see selftest.mjs's own
// header note; same constraint applies here).
// ---------------------------------------------------------------------------
const results = []
let currentSection = ''

function section(name) {
  currentSection = name
  console.log(`\n=== ${name} ===`)
}

async function test(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = await fn()
    results.push({ name: full, outcome: 'pass', evidence: evidence ?? '' })
    console.log(`  PASS  ${name}${evidence ? ` — ${evidence}` : ''}`)
  } catch (e) {
    results.push({ name: full, outcome: 'fail', evidence: String(e && e.stack ? e.stack : e) })
    console.log(`  FAIL  ${name} — ${e}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

// ---------------------------------------------------------------------------
// esbuild-bundle helper — bundles a virtual entry (stdin) with resolveDir set
// to app/src so relative imports inside the REAL .ts sources resolve, then
// dynamically imports the built ESM file. `loaderOverrides` lets a bundle
// stub out side-effecting imports it doesn't need (e.g. calibrate.ts's own
// './calibrate.css' — not used by any entry here, kept for completeness).
// ---------------------------------------------------------------------------
async function bundleAndImport(entryContents, { loaderOverrides = {} } = {}) {
  const tmpDir = await mkdtemp(resolve(tmpdir(), 'pg-arview-seams-'))
  const outfile = resolve(tmpDir, 'out.mjs')
  try {
    await build({
      stdin: { contents: entryContents, resolveDir: srcDir, loader: 'ts', sourcefile: 'seams-entry.ts' },
      bundle: true,
      write: true,
      outfile,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      loader: { '.css': 'empty', ...loaderOverrides },
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ===========================================================================
// SECTION 1 — Coincident-corner Accept: computeHomography throws inside
// onCalibrated (candidate defect #1)
// ===========================================================================
section('1. coincident-corner Accept -> computeHomography throw')

const homographyMod = await bundleAndImport(`
  export { computeHomography, applyH, homographySelfTest } from ${JSON.stringify(resolve(srcDir, 'ar/homography.ts'))}
`)

await test('sanity: homographySelfTest() passes on the real bundled module', () => {
  assert(homographyMod.homographySelfTest() === true, 'homographySelfTest should pass')
})

await test('EXACTLY 2 coincident corners does NOT throw — silently collapses the whole playfield to one point', () => {
  // Empirically probed first (a throwaway harness swept several degenerate
  // configurations against the REAL solver) before writing this assertion —
  // the task spec's framing ("reproduce the throw with 2 identical corners")
  // turned out to be off: with the FIXED unit-square src and only 2 of the 4
  // dst points coincident, solveLinearSystem's pivot check (homography.ts
  // line 39, threshold 1e-12) never trips — the 8x8 system stays
  // (barely) non-singular. This is the WORSE finding: no throw at all, and
  // the resulting H is catastrophically degenerate anyway (see math below).
  const UNIT_SQUARE = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const quadKeyframePx = [
    [100, 300], // BL
    [100, 300], // BR -- coincident with BL (fat-finger double-tap-in-place)
    [260, 40], // TR
    [40, 40], // TL
  ]
  const h = homographyMod.computeHomography(UNIT_SQUARE, quadKeyframePx)
  // h31=0, h32=-1, h33=1 -> w = 1-v. Numerator x = 100(1-v), y = 300(1-v) ->
  // x=100, y=300 for EVERY (u,v) with v!==1 (the whole playfield collapses to
  // the single tapped point) and 0/0 = NaN exactly at v=1 (the TR/TL edge).
  const mid = homographyMod.applyH(h, 0.5, 0.5)
  const corner = homographyMod.applyH(h, 0.1, 0.1)
  const nearEdge = homographyMod.applyH(h, 0.5, 0.999)
  const onEdge = homographyMod.applyH(h, 0.5, 1) // w === 0 exactly
  assert(Math.hypot(mid.x - 100, mid.y - 300) < 1e-6, `expected (u,v)=(0.5,0.5) to collapse to (100,300), got (${mid.x},${mid.y})`)
  assert(Math.hypot(corner.x - 100, corner.y - 300) < 1e-6, `expected (0.1,0.1) to ALSO collapse to (100,300), got (${corner.x},${corner.y})`)
  assert(Math.hypot(nearEdge.x - 100, nearEdge.y - 300) < 1, `expected near-edge point to still be ~(100,300), got (${nearEdge.x},${nearEdge.y})`)
  assert(Number.isNaN(onEdge.x) || !Number.isFinite(onEdge.x), `expected v=1 (w=0) to be NaN/Infinity, got ${onEdge.x}`)
  return `H=${JSON.stringify(h.map((n) => Math.round(n * 100) / 100))}; every (u,v) with v<1 maps to the SAME point (100,300); v=1 -> ${onEdge.x}/${onEdge.y} (NaN/Inf) — computeHomography() returns normally, no throw, no NaN check anywhere in the call chain`
})

await test('3+ coincident corners (or a fully-collinear quad) DOES throw', () => {
  const UNIT_SQUARE = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  // Reproduces the actual throw boundary: THREE of the 4 taps landing on the
  // exact same px (e.g. the long-press guard rejecting fast repeat taps so
  // the user's first 3 attempts all register at one spot before they
  // reposition for the 4th) — this is the scenario that genuinely trips
  // solveLinearSystem's zero-pivot guard.
  const quadKeyframePx = [
    [100, 300], // BL
    [100, 300], // BR -- coincident with BL
    [100, 300], // TR -- ALSO coincident with BL/BR
    [40, 40], // TL
  ]
  let threw = null
  try {
    homographyMod.computeHomography(UNIT_SQUARE, quadKeyframePx)
  } catch (e) {
    threw = e
  }
  assert(threw !== null, 'computeHomography must throw on a 3-coincident-corner quad')
  assert(
    /singular|degenerate|collinear/i.test(String(threw.message)),
    `error message should name the degeneracy, got: ${threw.message}`,
  )
  return threw.message
})

await test('computeHomography does NOT throw for a merely-skewed (non-degenerate) quad', () => {
  // Control case: confirms the throw above is specifically about the
  // coincident points, not the calibration flow's general shape.
  const UNIT_SQUARE = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const quadKeyframePx = [
    [90, 300],
    [260, 305],
    [230, 40],
    [60, 45],
  ]
  const h = homographyMod.computeHomography(UNIT_SQUARE, quadKeyframePx)
  assert(Array.isArray(h) && h.length === 9, 'expected a 9-element H')
})

// ---- async-throw semantics: reproduce arview.ts's exact call shape --------
// arview.ts (read in full for this pass) wires the calibration callback as:
//   calibrateHandle = createCalibrationUI(calWrap, feed, (c) => void onCalibrated(c))
// and onCalibrated is declared `async function onCalibrated(...)`.
// computeHomography(...) is called SYNCHRONOUSLY inside onCalibrated, BEFORE
// its only meaningful `await` (tracker.init(...)) — but (R6 honesty repair,
// 2026-07-28: a prior fix pass landed a guard this section used to claim did
// not exist) it is NOT called bare anymore. The real onCalibrated wraps the
// grabFrame/coverFit/computeHomography sequence in a try/catch that, on
// failure, logs, nulls calibrationHKeyframe, calls `calibrateHandle?.reset()`,
// and returns — see the exact block quoted in the SOURCE PIN test below. This
// section previously asserted (stale, now corrected) that no try/catch
// existed anywhere in the call chain and that the discarded `void
// onCalibrated(c)` promise genuinely rejects unhandled. Neither claim is true
// of the current source: the catch swallows the throw internally, the
// promise now RESOLVES, and the user gets routed back to corner-1 via
// reset() instead of a silently stuck "Locking on…" card. ar/arview.ts
// exports only `mountAR` — onCalibrated is a closure inside it and cannot be
// imported in isolation without either editing app/src (forbidden) or
// instantiating the full mountAR() DOM/AppState graph (camera/tracker/state/
// overlay/ui.sheet/fx.celebrate — outside a Node-only harness's reach). This
// block instead defines a function with the IDENTICAL structural shape
// (async fn, try/catch around a synchronous computeHomography call pre-
// await, invoked as `(c) => void f(c)`) against the REAL bundled
// computeHomography, AND pins the real source's try/catch + reset() call
// verbatim (SOURCE PIN test) so deleting either half of the real fix fails
// this suite, not just the hand-written replica.
async function onCalibratedLike(calibration, computeHomography, onReset) {
  // Mirrors arview.ts's onCalibrated structurally: sync work wrapped in a
  // try/catch, THEN (elsewhere, unreached here) the only await.
  const UNIT_SQUARE = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  let calibrationHKeyframe
  try {
    calibrationHKeyframe = computeHomography(UNIT_SQUARE, calibration.corners) // <- throws here on a degenerate quad
  } catch (e) {
    onReset() // mirrors arview.ts's `calibrateHandle?.reset()`
    return null // mirrors arview.ts's bare `return` inside the catch
  }
  return calibrationHKeyframe
}

await test('async throw before the first await is caught by the real try/catch — does NOT escape synchronously, and (INVERTED from the pre-fix finding of the same name) no longer rejects at all', async () => {
  // Uses the VERIFIED-throwing 3-coincident-corner quad (section above) —
  // not the 2-coincident case, which was just proven to NOT throw at all.
  const corners = [
    [100, 300],
    [100, 300],
    [100, 300],
    [40, 40],
  ]
  let syncThrew = false
  let returned
  let capturedPromise // side-channel only, so this test can await the settlement below
  let resetCalled = false
  try {
    // Exactly arview.ts's call shape: `(c) => void onCalibrated(c)`
    // (the `capturedPromise =` assignment is a test-only side channel added
    // purely for cleanup — it does not change `void expr`'s evaluated value
    // or the synchronous-throw behavior being asserted below).
    returned = ((c) =>
      void (capturedPromise = onCalibratedLike(c, homographyMod.computeHomography, () => {
        resetCalled = true
      })))(calibration_stub(corners))
  } catch (e) {
    syncThrew = true
  }
  assert(syncThrew === false, 'the throw inside the async fn must NOT propagate synchronously (JS async-fn semantics — unchanged by the try/catch fix)')
  assert(returned === undefined, '`void expr` always evaluates to undefined at the call site')
  function calibration_stub(corners) {
    return { corners }
  }
  let rejected = false
  await capturedPromise.then(
    () => {},
    () => {
      rejected = true
    },
  )
  assert(rejected === false, 'the real try/catch means this promise now RESOLVES (does not reject) — was: rejects, an unhandled rejection with no .catch anywhere in app/src')
  assert(resetCalled === true, 'the catch block must call the reset callback (mirrors calibrateHandle?.reset(), routing the user back to corner-1 instead of a stuck card)')
  return 'sync-throw-does-not-escape is unchanged JS semantics; NEW (R6): the promise resolves cleanly and reset() fires exactly once — was: an unhandled rejection, no recovery'
})

await test('the discarded promise from `void onCalibrated(c)` now RESOLVES cleanly and does NOT reject — INVERTED from "...DOES reject (unhandled)", the pre-fix finding of the same scenario', async () => {
  const corners = [
    [100, 300],
    [100, 300],
    [100, 300],
    [40, 40],
  ]
  // Capture what `void onCalibrated(c)` discards, to prove it settles as a
  // RESOLVED promise (not rejected) — i.e. there is no unhandled promise
  // rejection here anymore, because the real onCalibrated's own try/catch
  // (not a caller-side .catch — app/src still has zero `unhandledrejection`
  // listeners, verified: `grep -rn "unhandledrejection" app/src` -> no
  // matches, and none is needed here) intercepts it before the promise ever
  // settles rejected.
  let resetCallCount = 0
  const p = onCalibratedLike({ corners }, homographyMod.computeHomography, () => {
    resetCallCount++
  })
  let rejected = false
  let resolvedValue = 'unset (test bug if this survives)'
  await p.then(
    (v) => {
      resolvedValue = v
    },
    () => {
      rejected = true
    },
  )
  assert(rejected === false, "the async function's promise must NOT reject now that the real try/catch swallows the throw")
  assert(resolvedValue === null, `expected the catch branch's bare \`return\` (undefined, represented here as null) sentinel, got ${JSON.stringify(resolvedValue)}`)
  assert(resetCallCount === 1, `expected the reset callback called exactly once, got ${resetCallCount}`)
  return 'resolves cleanly, no rejection, reset() called once — was (same degenerate-corners scenario, pre-fix): rejected with a singular/degenerate/collinear message and nothing ever called reset(), a genuine unhandled rejection with no user-visible recovery'
})

await test('SOURCE PIN: the real arview.ts still wraps computeHomography in the try/catch that calls calibrateHandle?.reset() — deleting it fails this suite, not just the replica above', () => {
  const arviewSrc = readFileSync(resolve(srcDir, 'ar/arview.ts'), 'utf8')
  // Checked as ordered, individually-stable substrings (not one contiguous
  // block) so an inline comment reflow between them doesn't false-fail this
  // pin — what actually matters is that the try/catch shape and the
  // reset()-on-catch behavior are both still present, in the right order.
  const tryIdx = arviewSrc.indexOf('    try {\n      kf = feed.grabFrame(KEYFRAME_MAX_DIM)')
  const computeIdx = arviewSrc.indexOf('calibrationHKeyframe = computeHomography(UNIT_SQUARE, quadKeyframePx)')
  const catchIdx = arviewSrc.indexOf('    } catch (e) {', computeIdx)
  // `calibrationHKeyframe = null` and `calibrateHandle?.reset()` each also
  // appear elsewhere in the file (teardownTracking()'s reset, and the
  // separate vw===0||vh===0 backstop branch) — search from catchIdx onward
  // so this pins THIS catch block's own copies, not an earlier occurrence.
  const nullOutIdx = arviewSrc.indexOf('calibrationHKeyframe = null', catchIdx)
  const resetIdx = arviewSrc.indexOf('calibrateHandle?.reset()', catchIdx)
  assert(tryIdx !== -1, 'expected the try { block around the grabFrame/coverFit/computeHomography sequence still present')
  assert(computeIdx !== -1, 'expected the computeHomography call still inside that try block')
  assert(catchIdx !== -1, 'expected a `} catch (e) {` immediately closing that try block')
  assert(nullOutIdx !== -1, 'expected the catch branch to still null out calibrationHKeyframe')
  assert(resetIdx !== -1, 'expected the catch branch to still call calibrateHandle?.reset()')
  assert(
    tryIdx < computeIdx && computeIdx < catchIdx && catchIdx < nullOutIdx && nullOutIdx < resetIdx,
    `expected try < computeHomography-call < catch < null-out < reset(), in that order — got indices ${JSON.stringify({ tryIdx, computeIdx, catchIdx, nullOutIdx, resetIdx })}`,
  )
  return 'arview.ts still contains the try/catch around computeHomography, with the catch branch nulling calibrationHKeyframe and calling calibrateHandle?.reset(), in the right order — deleting or reordering any of these fails this test independently of the hand-written replica'
})

// ===========================================================================
// SECTION 2 — sessionGen race across onCalibrated's / tick()'s awaits
// (candidate defect #2, task item 2)
// ===========================================================================
section('2. sessionGen race: onCalibrated await vs tick() await vs tracker.destroy()')

// Stub `Worker` global BEFORE bundling/importing tracker.ts — createTracker()
// constructs `new Worker(new URL('./tracker.worker.ts', import.meta.url), ...)`
// inside its function body (not at module top level), so the stub only needs
// to exist by call time, not import time. The stub worker NEVER responds
// (no onmessage firing) — this is deliberate: it isolates exactly what
// tracker.destroy() does to an in-flight init()/track() RPC promise, without
// needing a real OpenCV.js worker.
// Instance registry (2026-07-28 fix-pass addition) — createTracker()'s
// `new Worker(...)` call is internal to the module, so a test that needs to
// fire worker.onerror/onmessageerror on the exact instance a given
// createTracker() call constructed needs a way to get it back; StubWorker
// pushes itself here on construction, in creation order.
const stubWorkerInstances = []
class StubWorker {
  constructor(url, opts) {
    this.url = String(url)
    this.opts = opts
    this.onmessage = null
    this.onerror = null
    this.onmessageerror = null
    this.terminated = false
    this.posted = []
    stubWorkerInstances.push(this)
  }
  postMessage(msg, transfer) {
    this.posted.push(msg)
    // Deliberately never calls this.onmessage — simulates a worker that is
    // slow/never replies before the caller loses interest (destroy()), or
    // that never responds at all (the A2 timeout-fallback tests below).
  }
  terminate() {
    this.terminated = true
  }
}
globalThis.Worker = StubWorker

const trackerMod = await bundleAndImport(`
  export { createTracker } from ${JSON.stringify(resolve(srcDir, 'ar/tracker.ts'))}
`)

function raceWithTimeout(promise, ms, timeoutValue) {
  return Promise.race([
    promise.then((v) => ({ settled: 'resolved', v })).catch((e) => ({ settled: 'rejected', e })),
    new Promise((res) => setTimeout(() => res({ settled: 'timeout' }), ms)),
  ])
}

await test('tracker.destroy() mid-init() now settles the init() promise with the fallback instead of hanging forever (A2 fix)', async () => {
  const tracker = trackerMod.createTracker()
  const fakeKeyframe = { data: { buffer: new ArrayBuffer(4) }, width: 1, height: 1 }
  const initPromise = tracker.init(fakeKeyframe, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ])
  // Simulates recalibrate()/switchMachine()/stopCamera() firing while
  // onCalibrated is mid-`await tracker.init(...)` (arview.ts's onCalibrated):
  // teardownTracking() calls `tracker?.destroy(); tracker = null`.
  tracker.destroy()
  const outcome = await raceWithTimeout(initPromise, 250)
  assert(
    outcome.settled === 'resolved',
    `expected init() to resolve promptly (not hang) after destroy(), got ${outcome.settled}` +
      (outcome.e !== undefined ? ` (${outcome.e})` : ''),
  )
  assert(outcome.v === false, `expected the init() fallback value (ok:false) after destroy(), got ${JSON.stringify(outcome.v)}`)
  return 'init() promise settles IMMEDIATELY with false (the INIT_FALLBACK) when destroy() fires mid-flight — was: hung forever (pending map cleared without settling the waiter); destroy() now settles every pending entry with its fallback before clearing the map'
})

await test('tracker.init() on a worker that never responds times out via the real 30s INIT_TIMEOUT_MS path and resolves ok:false — no hang (A2 fix, sped up via a monkeypatched setTimeout so this test does not actually wait 30s)', async () => {
  const realSetTimeout = globalThis.setTimeout
  const tracker = trackerMod.createTracker()
  const fakeKeyframe = { data: { buffer: new ArrayBuffer(4) }, width: 1, height: 1 }
  // tracker.ts's send() calls the global `setTimeout` SYNCHRONOUSLY (the
  // Promise executor that schedules it runs synchronously, as part of
  // evaluating `send(...)` before init()'s own `await` suspends) — so
  // patching setTimeout only around this ONE call site reroutes just this
  // request's 30_000ms to ~20ms, then restores the REAL setTimeout
  // immediately after for raceWithTimeout's own (genuine) wait below. This
  // exercises the REAL INIT_TIMEOUT_MS/fallback code path, not a
  // reimplementation of it — just sped up.
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms, 20), ...rest)
  const initPromise = tracker.init(fakeKeyframe, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ])
  globalThis.setTimeout = realSetTimeout
  // StubWorker.postMessage() never calls onmessage (see its own comment) —
  // the ONLY way this init() call can settle is the (now sped-up) timeout path.
  const outcome = await raceWithTimeout(initPromise, 2000)
  assert(outcome.settled === 'resolved', `expected the sped-up 30s timeout to fire and resolve, got ${outcome.settled}`)
  assert(outcome.v === false, `expected ok:false from the timeout fallback, got ${JSON.stringify(outcome.v)}`)
  return 'a worker that never posts a response no longer hangs tracker.init() forever — INIT_TIMEOUT_MS fires and resolves ok:false (this is what unsticks arview.ts\'s `await tracker.init()` on a failed/hung 10.3MB OpenCV load on slow arcade Wi-Fi)'
})

await test("worker.onerror settles ALL pending calls with their fallbacks and marks the tracker dead so later calls resolve immediately (A2 fix)", async () => {
  const tracker = trackerMod.createTracker()
  const stub = stubWorkerInstances[stubWorkerInstances.length - 1]
  assert(stub instanceof StubWorker, 'expected to recover the StubWorker instance this createTracker() call constructed')
  const fakeKeyframe = { data: { buffer: new ArrayBuffer(4) }, width: 1, height: 1 }
  const fakeFrame = { data: { buffer: new ArrayBuffer(4) }, width: 1, height: 1 }
  const initPromise = tracker.init(fakeKeyframe, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ])
  const trackPromise = tracker.track(fakeFrame)
  // Simulates a genuine Worker crash (e.g. an uncaught exception inside
  // tracker.worker.ts, or a malformed postMessage triggering onmessageerror)
  // — neither pending call's own timeout has fired; onerror must settle both.
  stub.onerror(new Event('error'))
  const [initOutcome, trackOutcome] = await Promise.all([raceWithTimeout(initPromise, 250), raceWithTimeout(trackPromise, 250)])
  assert(initOutcome.settled === 'resolved' && initOutcome.v === false, `expected init() ok:false after worker.onerror, got ${JSON.stringify(initOutcome)}`)
  assert(
    trackOutcome.settled === 'resolved' && trackOutcome.v && trackOutcome.v.h === null,
    `expected track() {h:null,...} after worker.onerror, got ${JSON.stringify(trackOutcome)}`,
  )
  // Dead tracker: a call made AFTER the crash must resolve immediately too
  // (send()'s `if (dead) return Promise.resolve(fallback)` early-return),
  // not post to a Worker that has already crashed.
  const postCrashInit = await raceWithTimeout(
    tracker.init(fakeKeyframe, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]),
    250,
  )
  assert(postCrashInit.settled === 'resolved' && postCrashInit.v === false, `expected a post-crash init() call to resolve ok:false immediately, got ${JSON.stringify(postCrashInit)}`)
  return 'worker.onerror settled both an in-flight init() and track() with their fallbacks, and a THIRD call made after the crash resolved immediately without posting to the dead worker'
})

await test('tracker.track() after destroy() resolves immediately with h:null (does NOT hang)', async () => {
  // Contrast case: track()'s own `if (destroyed) return {...}` early-return
  // guard (tracker.ts line 102) means a POST-destroy call is safe — only an
  // ALREADY-IN-FLIGHT call at destroy() time is the hang case above.
  const tracker = trackerMod.createTracker()
  tracker.destroy()
  const outcome = await raceWithTimeout(tracker.track({ data: { buffer: new ArrayBuffer(4) }, width: 1, height: 1 }), 250)
  assert(outcome.settled === 'resolved', `expected an immediate resolve, got ${outcome.settled}`)
  assert(outcome.v.h === null, 'expected h:null from the post-destroy guard')
})

console.log(`
  [code-trace] sessionGen guard placement (arview.ts, read in full):
    onCalibrated (line 640-696): exactly ONE await (tracker.init, line 669).
    \`const gen = sessionGen\` is captured at line 646, BEFORE the await.
    The continuation at line 675 checks \`if (destroyed || sessionGen !== gen || !feed) return\`
    IMMEDIATELY after that await, before any further mutation (calibrateHandle?.destroy(),
    frame.insertBefore, showOnly('live'), startLiveLoop()). This IS on the correct side
    (post-await, pre-mutation) and IS sufficient for onCalibrated's own single await.

    tick() (line 709-758) has a SEPARATE await (tracker.track, line 734) that has
    NO sessionGen check anywhere. Its only pre-await guard is
    \`if (!liveLoopActive || phase !== 'live' || !feed || !tracker) { liveLoopActive = false; return }\`
    (line 710) -- checked BEFORE the await, not re-checked after. So if
    recalibrate()/switchMachine()/stopCamera() (all of which bump sessionGen AND call
    teardownTracking(), nulling tracker/currentTrackerH/lastGoodTrackerH/calibrationHKeyframe,
    and stopCamera() also nulls feed) fire while a tick() is mid-await:
      - the awaited tracker.track() call resolves (SECTION 2's stub proves destroy()
        mid-flight instead HANGS a Worker-RPC promise forever, but a real OpenCV worker
        would likely still post its queued response before actually being torn down by
        terminate(), so both outcomes are plausible depending on worker.terminate() timing)
      - if it DOES resolve, the continuation UNCONDITIONALLY does
        \`currentTrackerH = res.h; lastGoodTrackerH = res.h; lastGoodAt = performance.now()\`
        (line 738-740) with NO re-check of sessionGen/phase/destroyed -- this REVIVES
        currentTrackerH/lastGoodTrackerH to a stale value immediately after
        teardownTracking() (called synchronously by recalibrate/switchMachine/stopCamera,
        BEFORE this continuation runs) had explicitly nulled them.
      - it then unconditionally calls renderLive() (line 751), which self-guards via
        \`if (!feed || !calibrationHKeyframe) return\` (line 792) -- this DOES catch the
        stopCamera()/recalibrate() case (calibrationHKeyframe is nulled by teardownTracking()),
        so no visible paint corruption from THIS path, but the currentTrackerH/lastGoodTrackerH
        state mutation above is NOT guarded by that check and happens regardless.
      - the reschedule guard \`if (liveLoopActive && phase === 'live')\` (line 753) IS
        phase-correct, so the stray tick is self-limiting (fires its stale continuation once,
        does not keep re-scheduling itself) -- NOT an unbounded loop, but a one-shot state
        revival. onCalibrated's own explicit reset of currentTrackerH/lastGoodTrackerH
        (line 683-685) papers over this once the NEXT calibration completes, but there is a
        real window (from recalibrate()/switchMachine() until the new onCalibrated resolves)
        where currentTrackerH/lastGoodTrackerH can be non-null when the teardown intended null.
    CONCLUSION: onCalibrated's gen check is correctly placed and sufficient for itself.
    tick()'s per-frame await has NO gen (or post-await phase re-check) guard at all --
    the asymmetry is real and is exactly the seam candidate defect #2 describes.
`)

// ===========================================================================
// SECTION 3 — stage-rect staleness: calibrate.ts stores corners in stage px
// at TAP time; onCalibrated reads calWrap.getBoundingClientRect() at ACCEPT
// time (candidate defect #3 / task item 3)
// ===========================================================================
section('3. stage-rect staleness: math consequence of a resize between tap and Accept')

// ---- LITERAL copies of arview.ts's own (unexported) geometry helpers ----
// Source: app/src/ar/arview.ts lines 152-165 (coverFit/displayToMedia/
// mediaToDisplay) and 763-771 (calibrationHKeyframe -> applyH -> ...
// -> mediaToDisplay, the exact liveMapFn composition). arview.ts's own header
// comment (lines 138-144) explains WHY these are duplicated here rather than
// imported: they operate on video-intrinsic <-> stage-px spaces and are not
// exported (only Calibration's corners cross the module boundary), and this
// file must not edit app/src. Copied verbatim, not reimplemented from intent.
function coverFit(boxW, boxH, mediaW, mediaH) {
  const scale = Math.max(boxW / Math.max(1, mediaW), boxH / Math.max(1, mediaH))
  const dw = mediaW * scale
  const dh = mediaH * scale
  return { scale, offsetX: (boxW - dw) / 2, offsetY: (boxH - dh) / 2 }
}
function displayToMedia(dx, dy, c) {
  return { x: (dx - c.offsetX) / c.scale, y: (dy - c.offsetY) / c.scale }
}
function mediaToDisplay(mx, my, c) {
  return { x: c.offsetX + mx * c.scale, y: c.offsetY + my * c.scale }
}

await test('reproduces the raw drift math if the SAME 4 taps survived to Accept-time against a resized rect — this is EXACTLY what B5\'s resize invalidation now prevents for resizes over the 24px jitter threshold', async () => {
  // Scenario per the task spec verbatim: "same taps, stage height shrunk
  // 60px between tap and accept". Models the drift that would result IF the
  // same 4 taps survived to Accept-time against the resized rect.
  //
  // R6 honesty repair: this section used to claim "no re-clamp/re-derive on
  // resize anywhere in calibrate.ts... manualCorners is never touched by the
  // file's ResizeObserver" — that was true when this section was written,
  // but a later fix pass (B5) added exactly that: calibrate.ts's own
  // ResizeObserver callback (resizeCanvas(), ~calibrate.ts line 272-297) now
  // CLEARS manualCorners and shows a 'Screen changed — start over' notice
  // whenever a resize exceeds STAGE_RESIZE_JITTER_PX (24px) while corners
  // are in-progress and not yet calibrated. So for a REAL 60px
  // toolbar-collapse resize like this one, the user is forced to re-tap
  // against the NEW rect before Accept can ever fire — this drift never
  // actually reaches onCalibrated in the current app. The math below is
  // still real and still useful (it's exactly the math B5's 24px threshold
  // is calibrated against) — see the SOURCE PIN test right after this one
  // for a regression pin on B5 itself, and the sub-threshold test after that
  // for the (smaller, by-design-unprevented) drift that still gets through.
  //   - calibrate.ts's tapzone pointerup handler reads
  //     `stage.getBoundingClientRect()` and stores RAW absolute CSS px.
  //   - by the time Accept fires, arview.onCalibrated reads
  //     `calWrap.getBoundingClientRect()` freshly -- if iOS Safari's dvh
  //     toolbar collapsed in between (a real, common mid-interaction event),
  //     this rect is now shorter than the one the taps were placed against.
  const rect0 = { width: 390, height: 844 } // stage rect AT TAP TIME
  const rect1 = { width: 390, height: 784 } // stage rect AT ACCEPT TIME (toolbar collapsed, -60px height)
  const vw = 1280
  const vh = 720 // camera.ts's own `ideal` constraints (camera.ts line 59-60)

  // Plausible tapped corners for a playfield roughly filling the visible
  // frame (BL, BR, TR, TL -- ar/homography.ts's documented tap order).
  const taps = [
    [40, 780], // BL
    [350, 780], // BR
    [320, 120], // TR
    [70, 120], // TL
  ]

  const cover0 = coverFit(rect0.width, rect0.height, vw, vh) // what the user visually aimed at
  const cover1 = coverFit(rect1.width, rect1.height, vw, vh) // what onCalibrated ACTUALLY uses

  const mediaIntended = taps.map(([dx, dy]) => displayToMedia(dx, dy, cover0))
  const mediaActual = taps.map(([dx, dy]) => displayToMedia(dx, dy, cover1))

  const dxdy = mediaIntended.map((m, i) => Math.hypot(m.x - mediaActual[i].x, m.y - mediaActual[i].y))
  const maxDriftMediaPx = Math.max(...dxdy)

  assert(maxDriftMediaPx > 0, 'a rect resize between tap and Accept must produce nonzero media-px drift')

  // Build both homographies (correct-vs-actual) with the REAL bundled DLT
  // solver and show the resulting calibrationHKeyframe disagree materially:
  // this IS what actually gets stored (permanently, until Recalibrate) as
  // calibrationHKeyframe and fed to tracker.init()'s Shi-Tomasi seeding quad.
  const UNIT_SQUARE = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const hCorrect = homographyMod.computeHomography(
    UNIT_SQUARE,
    mediaIntended.map((m) => [m.x, m.y]),
  )
  const hActual = homographyMod.computeHomography(
    UNIT_SQUARE,
    mediaActual.map((m) => [m.x, m.y]),
  )

  // Sample the playfield CENTER (u=0.5,v=0.5) -- not one of the 4 exact
  // correspondence points (those trivially round-trip for ANY H by DLT
  // construction, so they cannot show drift) -- in media (video-intrinsic)
  // px, which is exactly the space calibrationHKeyframe operates in
  // (arview.ts line 763's `calH`) and what the tracker is seeded against.
  const centerCorrect = homographyMod.applyH(hCorrect, 0.5, 0.5)
  const centerActual = homographyMod.applyH(hActual, 0.5, 0.5)
  const centerDriftMediaPx = Math.hypot(centerCorrect.x - centerActual.x, centerCorrect.y - centerActual.y)

  assert(centerDriftMediaPx > 1, `expected material center drift, got ${centerDriftMediaPx.toFixed(2)}px`)

  return (
    `per-corner media-px drift (displayToMedia, cover0 vs cover1): [${dxdy.map((d) => d.toFixed(1)).join(', ')}]px; ` +
    `max=${maxDriftMediaPx.toFixed(1)}px; playfield-CENTER drift through the two resulting calibrationHKeyframe: ` +
    `${centerDriftMediaPx.toFixed(1)}px (video-intrinsic px, before the /kf.scaleToVideo keyframe downscale — ` +
    `that division is a uniform per-axis scale, so it shrinks this number but does not remove it)`
  )
})

await test('SOURCE PIN: calibrate.ts still clears manualCorners on a >24px stage resize while taps are in-progress (B5) — this is what actually prevents the drift measured above in practice', () => {
  const calibrateSrc = readFileSync(resolve(srcDir, 'ar/calibrate.ts'), 'utf8')
  const invalidationBlock =
    "if ((dw > STAGE_RESIZE_JITTER_PX || dh > STAGE_RESIZE_JITTER_PX) && manualCorners.length > 0 && !calibrated) {\n" +
    "        manualCorners = []\n" +
    "        resizeNotice = true\n" +
    "        render()\n" +
    "        return\n" +
    "      }"
  assert(calibrateSrc.includes(invalidationBlock), "expected calibrate.ts's B5 resize-invalidation block present verbatim")
  return "calibrate.ts still clears in-progress corners on a >24px stage resize before Accept can fire — deleting this block would silently let the drift measured in the previous test reach onCalibrated again"
})

await test('a SUB-threshold resize (exactly 24px = STAGE_RESIZE_JITTER_PX, B5\'s own boundary) is deliberately NOT invalidated — the SAME drift math still applies there, just smaller (a real, by-design residual, not a defect)', () => {
  // B5's own comparison is strict `>` (dw > STAGE_RESIZE_JITTER_PX), so a
  // resize of EXACTLY 24px is, by construction, a no-op — corners survive to
  // Accept-time unclamped and unwarned, and the same displayToMedia/
  // computeHomography drift chain as the test above applies, just scaled to
  // a smaller (but nonzero) shrink. This is the honest boundary of B5's fix:
  // "noise under 24px" was an explicit design choice (calibrate.ts's own
  // STAGE_RESIZE_JITTER_PX comment), not an oversight — recorded here as
  // real, present behavior rather than asserted away.
  const rect0 = { width: 390, height: 844 }
  const rect1 = { width: 390, height: 844 - 24 } // exactly at the jitter boundary
  const vw = 1280
  const vh = 720
  const taps = [
    [40, 780],
    [350, 780],
    [320, 120],
    [70, 120],
  ]
  const cover0 = coverFit(rect0.width, rect0.height, vw, vh)
  const cover1 = coverFit(rect1.width, rect1.height, vw, vh)
  const mediaIntended = taps.map(([dx, dy]) => displayToMedia(dx, dy, cover0))
  const mediaActual = taps.map(([dx, dy]) => displayToMedia(dx, dy, cover1))
  const dxdy = mediaIntended.map((m, i) => Math.hypot(m.x - mediaActual[i].x, m.y - mediaActual[i].y))
  const maxDriftMediaPx = Math.max(...dxdy)
  assert(maxDriftMediaPx > 0, 'a 24px resize must still produce nonzero media-px drift (B5 does not invalidate at exactly the threshold)')
  assert(maxDriftMediaPx < 25, `expected the sub-threshold drift to be small relative to the 60px-shrink case above, got ${maxDriftMediaPx.toFixed(1)}px`)
  return `at exactly the 24px jitter boundary (B5's own no-op edge), per-corner media-px drift: [${dxdy.map((d) => d.toFixed(1)).join(', ')}]px, max=${maxDriftMediaPx.toFixed(1)}px — small compared to the 60px-shrink scenario above, but real and unprevented; this is B5's documented "noise, not a real resize" tradeoff, not a regression`
})

await test('drift scales with how much the rect shrinks (60px vs 200px) — same taps', () => {
  const rect0 = { width: 390, height: 844 }
  const vw = 1280
  const vh = 720
  const taps = [
    [40, 780],
    [350, 780],
    [320, 120],
    [70, 120],
  ]
  const cover0 = coverFit(rect0.width, rect0.height, vw, vh)
  const mediaIntended = taps.map(([dx, dy]) => displayToMedia(dx, dy, cover0))

  function driftFor(shrinkPx) {
    const rect1 = { width: 390, height: 844 - shrinkPx }
    const cover1 = coverFit(rect1.width, rect1.height, vw, vh)
    const mediaActual = taps.map(([dx, dy]) => displayToMedia(dx, dy, cover1))
    return Math.max(...mediaIntended.map((m, i) => Math.hypot(m.x - mediaActual[i].x, m.y - mediaActual[i].y)))
  }

  const drift60 = driftFor(60)
  const drift200 = driftFor(200)
  assert(drift200 > drift60, `expected larger shrink -> larger drift: 60px->${drift60.toFixed(1)}, 200px->${drift200.toFixed(1)}`)
  return `60px shrink -> ${drift60.toFixed(1)}px media drift; 200px shrink -> ${drift200.toFixed(1)}px media drift`
})

// ===========================================================================
// SECTION 4 — camera.ts: listener lifecycle (leak FIXED — C10), onStateChange
// replay-on-subscribe (NEW — A1), grabFrame(videoWidth=0), restart() during
// state==='error'
// ===========================================================================
section('4. camera.ts lifecycle')

// ---- minimal DOM/navigator stub, built for camera.ts's EXACT surface -----
// camera.ts (read in full) touches: document.createElement('video'|'canvas'),
// document.addEventListener('visibilitychange', ...) [MODULE-LEVEL, once per
// createCameraFeed() call], document.visibilityState,
// navigator.mediaDevices.getUserMedia(), and on the created <video>: the
// playsInline/muted/autoplay IDL+attribute pair, .style.*, .srcObject,
// .play(), .videoWidth/.videoHeight, .addEventListener/.removeEventListener
// ('ended', ...). On the created <canvas>: .width/.height,
// .getContext('2d').drawImage(...). 2026-07-28 fix-pass addition: the
// acquired MediaStreamTrack now also needs .addEventListener/
// .removeEventListener('ended', ...) — camera.ts's openStream() attaches a
// one-shot listener to it (C10/B7's "rebuild on a track that dies while
// visible" fix) — see makeFakeMediaStream() below.
class FakeDocument {
  constructor() {
    this._listeners = new Map() // type -> Set<fn>
    this.visibilityState = 'visible'
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn)
  }
  listenerCount(type) {
    return this._listeners.get(type)?.size ?? 0
  }
  createElement(tag) {
    if (tag === 'video') return makeFakeVideo()
    if (tag === 'canvas') return makeFakeCanvas()
    throw new Error(`FakeDocument.createElement: unsupported tag ${tag}`)
  }
}

function makeFakeVideo() {
  const listeners = new Map()
  return {
    style: {},
    videoWidth: 0,
    videoHeight: 0,
    srcObject: null,
    setAttribute() {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    play() {
      return Promise.resolve()
    },
    remove() {},
  }
}

function makeFakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext(kind) {
      if (kind !== '2d') return null
      return { drawImage() {} }
    },
  }
}

function makeFakeMediaStream(videoTrackState = 'live') {
  // Minimal EventTarget-like track stub (2026-07-28 addition): camera.ts's
  // openStream() now does `track?.addEventListener('ended', ..., {once:true})`
  // on the acquired track (C10/B7) — real MediaStreamTrack.stop() does NOT
  // itself fire 'ended' (confirmed empirically against Chromium's fake
  // device while building the arview-statemachine.e2e.py suite's section 3;
  // 'ended' only fires for a genuine external end), so this stub's own
  // stop() mirrors that: it does NOT auto-dispatch 'ended' either — a test
  // that wants to simulate a real external track death calls
  // dispatchEnded() explicitly.
  const listeners = new Map()
  const track = {
    readyState: videoTrackState,
    stop() {
      track.readyState = 'ended'
    },
    addEventListener(type, fn, opts) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
      if (opts && opts.once) {
        const wrapped = fn
        track[`__once_${type}`] = wrapped
      }
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEnded() {
      for (const fn of listeners.get('ended') ?? []) fn()
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    __track: track,
  }
}

async function withCameraStubs(run) {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const fakeDocument = new FakeDocument()
  const fakeNavigator = {
    mediaDevices: {
      getUserMedia: async () => makeFakeMediaStream(),
    },
  }
  // Node 21+ defines a built-in, non-writable `navigator` global (its own
  // Node-runtime NavigatorID) — plain assignment throws ("has only a
  // getter"). redefineProperty to stub it for the duration of one test, then
  // restore the original descriptor exactly (works whether or not Node's own
  // global existed, and whether or not `document` existed at all).
  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: fakeNavigator, configurable: true, writable: true })
  try {
    return await run(fakeDocument)
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc)
    else delete globalThis.document
    if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav)
    else delete globalThis.navigator
  }
}

const cameraMod = await bundleAndImport(`
  export { createCameraFeed } from ${JSON.stringify(resolve(srcDir, 'ar/camera.ts'))}
`)

await test('createCameraFeed().stop() now removes its visibilitychange listener — Start->Exit->Start cycles stay bounded, not leaked (C10 fix)', async () => {
  await withCameraStubs(async (fakeDocument) => {
    assert(fakeDocument.listenerCount('visibilitychange') === 0, 'precondition: no listeners yet')

    const CYCLES = 5
    for (let i = 0; i < CYCLES; i++) {
      // Mirrors arview.ts's startCamera()/stopCamera() pair: `feed =
      // createCameraFeed()` then, later, `feed.stop()`.
      const feed = cameraMod.createCameraFeed()
      await feed.start()
      assert(
        fakeDocument.listenerCount('visibilitychange') === 1,
        `expected exactly 1 listener while this feed is live (cycle ${i}), got ${fakeDocument.listenerCount('visibilitychange')}`,
      )
      feed.stop()
    }

    const count = fakeDocument.listenerCount('visibilitychange')
    assert(
      count === 0,
      `expected 0 leaked listeners after ${CYCLES} Start->Exit->Start cycles (was: exactly ${CYCLES}, one leaked per cycle with no way to remove it), got ${count}`,
    )
    return `0 visibilitychange listeners remain after ${CYCLES} Start->Exit->Start cycles (was: ${CYCLES} leaked, unbounded) — stop() now removes both the document 'visibilitychange' listener and the video 'ended' listener it added in openStream()`
  })
})

await test("createCameraFeed().stop() does NOT explicitly detach the acquired track's one-shot 'ended' listener (only document+video, per C10's own scope) — informational, not a leak", async () => {
  await withCameraStubs(async () => {
    let lastStream = null
    globalThis.navigator.mediaDevices.getUserMedia = async () => {
      lastStream = makeFakeMediaStream()
      return lastStream
    }
    const feed = cameraMod.createCameraFeed()
    await feed.start()
    assert(lastStream.__track.listenerCount('ended') === 1, `expected 1 'ended' listener on the acquired track while live, got ${lastStream.__track.listenerCount('ended')}`)
    feed.stop()
    const stillAttached = lastStream.__track.listenerCount('ended') === 1
    // NOT asserted as a failure: unlike the document-level listener above
    // (a genuine, accumulating-forever leak — `document` is never
    // GC'd), this track-scoped `{once:true}` listener's closure has no
    // other referrer once stopTracks() drops `stream`/`track` and
    // video.srcObject=null runs — the track (and its listener) becomes
    // GC-eligible right alongside it, so there is no observable
    // accumulation across repeated Start->Exit->Start cycles. Recorded as
    // an informational precision gap only: C10's own source comment says
    // stop() removes "both listeners" (singular pair: document + video),
    // and does not mention the track-level one at all — this confirms
    // that's accurate as written, not under-scoped.
    return `track 'ended' listener still attached after stop()=${stillAttached} (expected: not explicitly removed, matches C10's documented scope of exactly 2 listeners — document visibilitychange + video ended; the track-level listener is GC-scoped instead, not leaked)`
  })
})

await test('grabFrame() with videoWidth===0 (metadata not yet loaded) does not throw — returns a degenerate 1x1 frame', async () => {
  await withCameraStubs(async () => {
    const feed = cameraMod.createCameraFeed()
    await feed.start() // camera.ts's openStream() sets state 'live' right after video.play() resolves —
    // it never waits on 'loadedmetadata', so videoWidth/videoHeight staying 0
    // here (our stub never populates them, exactly like a real browser in the
    // narrow gap before the first frame's metadata arrives) is a FAITHFUL
    // reproduction, not stub-only artifice — confirmed by reading camera.ts's
    // openStream() (lines 55-76) in full: no dimension wait exists.
    const grabbed = feed.grabFrame(480)
    assert(grabbed.canvas.width === 1 && grabbed.canvas.height === 1, `expected a 1x1 canvas, got ${grabbed.canvas.width}x${grabbed.canvas.height}`)
    assert(grabbed.scaleToVideo === 1, `expected scaleToVideo===1 (vw/cw = 1/1), got ${grabbed.scaleToVideo}`)
    return 'grabFrame(480) with videoWidth=0 returns {canvas:1x1, scaleToVideo:1} silently — no throw, no signal to the caller that the frame is meaningless'
  })
})

await test('restart() called while state==="error" is allowed to retry (not blocked by the starting/live guard)', async () => {
  await withCameraStubs(async () => {
    let call = 0
    globalThis.navigator.mediaDevices.getUserMedia = async () => {
      call++
      if (call === 1) {
        const err = new Error('device busy')
        err.name = 'NotReadableError'
        throw err
      }
      return makeFakeMediaStream()
    }
    const feed = cameraMod.createCameraFeed()
    const states = []
    feed.onStateChange((s) => states.push(s))
    await feed.start().catch(() => {}) // 1st call fails -> state 'error'
    assert(states[states.length - 1] === 'error', `expected state 'error' after first failed start, got ${states.join(',')}`)
    // restart()'s guard is `if (starting || state === 'live') return` (camera.ts
    // line 87) -- 'error' satisfies NEITHER condition, so a second start() call
    // is expected to proceed and retry, not be silently swallowed.
    await feed.start()
    assert(states[states.length - 1] === 'live', `expected retry from 'error' to reach 'live', got ${states.join(',')}`)
    return `state sequence: ${states.join(' -> ')} — retry-from-error path works as coded (refutes a "stuck in error forever" concern)`
  })
})

await test('onStateChange(fn) replays the CURRENT state synchronously to a new subscriber (A1 fix — this is the RECALIBRATE-dead-end fix)', async () => {
  await withCameraStubs(async () => {
    const feed = cameraMod.createCameraFeed()

    // Subscribe BEFORE any start() call: a brand-new feed's state is
    // 'stopped', so replay must deliver 'stopped' synchronously — proves
    // this isn't conditioned on the feed having ever gone live.
    const earlyObserved = []
    const unsubEarly = feed.onStateChange((s) => earlyObserved.push(s))
    assert(earlyObserved.length === 1 && earlyObserved[0] === 'stopped', `expected an immediate synchronous replay of 'stopped' to a subscriber on a fresh feed, got ${JSON.stringify(earlyObserved)}`)
    unsubEarly()

    await feed.start()

    // THE scenario this fixes: a SECOND createCalibrationUI() (RECALIBRATE /
    // switchMachine) mounts a NEW subscriber onto an ALREADY-LIVE feed. Before
    // this fix, that subscriber started from calibrate.ts's own default
    // ('stopped') and never learned otherwise (restart()'s own
    // `state === 'live'` guard makes its `void feed.start()` a silent no-op
    // that emits nothing) — the HUD was stuck on "Starting camera…" forever.
    const lateObserved = []
    const unsubLate = feed.onStateChange((s, err) => lateObserved.push({ s, err }))
    assert(
      lateObserved.length === 1 && lateObserved[0].s === 'live',
      `expected a subscriber added AFTER the feed went live to be told 'live' immediately, got ${JSON.stringify(lateObserved)}`,
    )
    unsubLate()

    // Replay also carries lastError for a subscriber added while in 'error'
    // — a FRESH feed, since the one above is already 'live' and restart()'s
    // own `state === 'live'` guard would make a further start() a no-op
    // regardless of getUserMedia, never reaching 'error' at all.
    const errFeed = cameraMod.createCameraFeed()
    globalThis.navigator.mediaDevices.getUserMedia = async () => {
      const err = new Error('device busy')
      err.name = 'NotReadableError'
      throw err
    }
    await errFeed.start().catch(() => {})
    const errObserved = []
    errFeed.onStateChange((s, err) => errObserved.push({ s, errName: err?.name }))
    assert(
      errObserved.length === 1 && errObserved[0].s === 'error' && errObserved[0].errName === 'NotReadableError',
      `expected a subscriber added while in 'error' to be replayed the state AND the error, got ${JSON.stringify(errObserved)}`,
    )

    // Unsubscribing still works normally (the returned fn is still a real
    // unsubscribe, not just consumed by the replay).
    const afterUnsub = []
    const unsub2 = feed.onStateChange((s) => afterUnsub.push(s))
    unsub2()
    afterUnsub.length = 0 // clear the replay entry itself
    feed.stop()
    assert(afterUnsub.length === 0, `expected an unsubscribed listener to receive nothing further, got ${JSON.stringify(afterUnsub)}`)

    return 'a new subscriber now always observes the CURRENT state synchronously on subscribe (stopped / live / error+err all verified), fixing the RECALIBRATE dead-end where a second calibration UI mounted over an already-live feed never learned the state'
  })
})

// ===========================================================================
// SECTION 5 — freeze-phase: freezeMapFn snapshot vs later resize
// (candidate defect, task item 5)
// ===========================================================================
section('5. freeze-phase: freezeMapFn snapshot staleness across a resize')

await test('BASELINE (pre-fix math, no longer what renderFreeze() actually draws): an UNSTRETCHED overlay map desyncs from the re-stretched frozen photo after a rotation', () => {
  // This models the OLD renderFreeze() — draw the frozen photo stretched to
  // the CURRENT rect, but the overlay with the UNCHANGED freezeMapFn (no
  // sx/sy compensation). R6 note: the real renderFreeze() no longer does
  // this (see the FIXED model + SOURCE PIN tests below) — this test is kept
  // as the "what B5's stretch fix eliminates" baseline for comparison, not
  // as a claim about current app behavior.
  const rectAtFreeze = { width: 390, height: 844 }
  const vw = 1280
  const vh = 720
  const coverAtFreeze = coverFit(rectAtFreeze.width, rectAtFreeze.height, vw, vh) // baked into freezeMapFn forever

  // A rotation is the sharpest real-world trigger (iOS Safari rotate fires a
  // ResizeObserver entry with swapped dimensions almost immediately).
  const rectAfterRotate = { width: 844, height: 390 }

  // A FIXED media-space point (the video's own center, in video-intrinsic
  // px — deliberately cover-independent) projected through both cover fits,
  // to show the SAME underlying camera pixel lands in two different places
  // depending on which rect's cover-fit is used to project it to screen px.
  const mediaCenter = { x: vw / 2, y: vh / 2 }

  // The overlay's drawn position under the OLD (unstretched) map:
  const overlayDrawnAt = mediaToDisplay(mediaCenter.x, mediaCenter.y, coverAtFreeze)
  // What a rect-correct mapping would draw it at, rebuilt fresh against the
  // new rect's cover-fit:
  const coverAfterRotate = coverFit(rectAfterRotate.width, rectAfterRotate.height, vw, vh)
  const correctDrawnAt = mediaToDisplay(mediaCenter.x, mediaCenter.y, coverAfterRotate)

  const canvasNowW = rectAfterRotate.width
  const canvasNowH = rectAfterRotate.height
  const offCanvasX = overlayDrawnAt.x < 0 || overlayDrawnAt.x > canvasNowW
  const offCanvasY = overlayDrawnAt.y < 0 || overlayDrawnAt.y > canvasNowH
  const driftPx = Math.hypot(overlayDrawnAt.x - correctDrawnAt.x, overlayDrawnAt.y - correctDrawnAt.y)

  assert(driftPx > 50, `expected large drift after a full rotation with an UNSTRETCHED map, got ${driftPx.toFixed(1)}px`)

  return (
    `freeze at 390x844, rotated to 844x390, UNSTRETCHED overlay map: drawn at ` +
    `(${overlayDrawnAt.x.toFixed(0)},${overlayDrawnAt.y.toFixed(0)}) against a canvas now ` +
    `${canvasNowW}x${canvasNowH} — vs. rect-correct: (${correctDrawnAt.x.toFixed(0)},${correctDrawnAt.y.toFixed(0)}); ` +
    `drift=${driftPx.toFixed(0)}px; off-canvas: x=${offCanvasX} y=${offCanvasY} — this is the 321px defect ` +
    `the sx/sy stretch fix (B5) below eliminates for this specific (video-center) point`
  )
})

await test('FIXED MODEL: renderFreeze()\'s sx/sy-stretched map (freezeRect snapshot) drives drift to exactly 0 for the video-center point after a full rotation', () => {
  // Models the CURRENT renderFreeze(): freezeRect = {w,h} is snapshotted
  // alongside freezeMapFn at Freeze-press time; on every redraw, the frozen
  // photo is stretched to the CURRENT rect (unchanged from before) AND the
  // overlay map is now ALSO stretched by the same (sx, sy) = (current/frozen)
  // ratio before being drawn — see the SOURCE PIN test below for the exact
  // source lines this reproduces.
  const rectAtFreeze = { width: 390, height: 844 }
  const vw = 1280
  const vh = 720
  const coverAtFreeze = coverFit(rectAtFreeze.width, rectAtFreeze.height, vw, vh)
  const rectAfterRotate = { width: 844, height: 390 }
  const sx = rectAfterRotate.width / rectAtFreeze.width
  const sy = rectAfterRotate.height / rectAtFreeze.height
  const coverAfterRotate = coverFit(rectAfterRotate.width, rectAfterRotate.height, vw, vh)

  const mediaCenter = { x: vw / 2, y: vh / 2 }
  const drawnOld = mediaToDisplay(mediaCenter.x, mediaCenter.y, coverAtFreeze) // freezeMapFn(u,v), pre-stretch
  const drawnFixed = { x: drawnOld.x * sx, y: drawnOld.y * sy } // stretchedMapFn(u,v) — what renderFreeze() actually draws now
  const correctDrawnAt = mediaToDisplay(mediaCenter.x, mediaCenter.y, coverAfterRotate)
  const driftPx = Math.hypot(drawnFixed.x - correctDrawnAt.x, drawnFixed.y - correctDrawnAt.y)

  assert(driftPx < 1e-6, `expected ~0 drift at the video-center point after the sx/sy stretch fix, got ${driftPx.toFixed(3)}px`)

  return `freeze at 390x844, rotated to 844x390, FIXED (sx/sy-stretched) overlay map: drawn at (${drawnFixed.x.toFixed(1)},${drawnFixed.y.toFixed(1)}), rect-correct is (${correctDrawnAt.x.toFixed(1)},${correctDrawnAt.y.toFixed(1)}) — drift=${driftPx.toExponential(2)}px (was 321px unstretched, see the BASELINE test above)`
})

await test('FIXED MODEL, off-center point: the sx/sy stretch does NOT generalize to non-center overlay content — real residual drift remains after a full rotation (genuine finding, not papered over)', () => {
  // The video-center result above is NOT representative of real overlay
  // content: shots/goal-route points on the playfield essentially never land
  // exactly at the video's own geometric center. The sx/sy stretch is a
  // per-axis scale of an ALREADY-projected (offset-inclusive) display point —
  // algebraically this only cancels a genuine rect-resize's effect on
  // mediaToDisplay() when the resize is a pure uniform scale (sx===sy) or the
  // point sits on one of coverFit's own zero-offset symmetry axes (as the
  // video-center point above does, coincidentally). A full portrait<->
  // landscape rotation swaps which axis coverFit is bound by (390x844 is
  // height-bound; 844x390 is width-bound), which is NOT a uniform scale, so
  // an off-center point gets real, unprevented drift — empirically NOT
  // smaller than the unstretched baseline for this scenario.
  const rectAtFreeze = { width: 390, height: 844 }
  const vw = 1280
  const vh = 720
  const coverAtFreeze = coverFit(rectAtFreeze.width, rectAtFreeze.height, vw, vh)
  const rectAfterRotate = { width: 844, height: 390 }
  const sx = rectAfterRotate.width / rectAtFreeze.width
  const sy = rectAfterRotate.height / rectAtFreeze.height
  const coverAfterRotate = coverFit(rectAfterRotate.width, rectAfterRotate.height, vw, vh)

  // A representative off-center overlay point (u,v)~(0.3,0.7)-ish in
  // video-intrinsic px — NOT the video's geometric center.
  const media = { x: vw * 0.3, y: vh * 0.7 }
  const drawnOld = mediaToDisplay(media.x, media.y, coverAtFreeze)
  const drawnFixed = { x: drawnOld.x * sx, y: drawnOld.y * sy }
  const correctDrawnAt = mediaToDisplay(media.x, media.y, coverAfterRotate)
  const driftUnstretched = Math.hypot(drawnOld.x - correctDrawnAt.x, drawnOld.y - correctDrawnAt.y)
  const driftFixed = Math.hypot(drawnFixed.x - correctDrawnAt.x, drawnFixed.y - correctDrawnAt.y)

  assert(driftFixed > 100, `expected real residual drift for an off-center point after a full rotation even WITH the sx/sy stretch, got ${driftFixed.toFixed(1)}px`)

  return (
    `off-center point (0.3,0.7)-ish, same 390x844 -> 844x390 rotation: unstretched drift=${driftUnstretched.toFixed(0)}px, ` +
    `FIXED (sx/sy-stretched) drift=${driftFixed.toFixed(0)}px — the stretch fix does NOT eliminate drift here (and is not even ` +
    `smaller than the unstretched baseline for this scenario); it only cancels exactly at coverFit's zero-offset symmetry points ` +
    `(like the video-center point in the previous test). GENUINE RESIDUAL FINDING: a full-rotation resize during freeze still ` +
    `desyncs the overlay from off-center goal/shot content — B5 narrows the defect (a same-axis resize like an iOS toolbar ` +
    `collapse improves noticeably) but does not close it for an aspect-swapping rotation.`
  )
})

await test('SOURCE PIN: the real arview.ts renderFreeze() still snapshots freezeRect and applies the sx/sy-stretched map — deleting it fails this suite, not just the model above', () => {
  const arviewSrc = readFileSync(resolve(srcDir, 'ar/arview.ts'), 'utf8')
  assert(
    arviewSrc.includes('freezeRect = { w: rect.width, h: rect.height }'),
    'expected enterFreeze() to still snapshot freezeRect alongside freezeMapFn',
  )
  assert(
    arviewSrc.includes('const sx = rect.width / freezeRect.w') && arviewSrc.includes('const sy = rect.height / freezeRect.h'),
    'expected renderFreeze() to still derive sx/sy from the CURRENT rect divided by the frozen freezeRect',
  )
  const stretchedMapBlock =
    'const stretchedMapFn: MapFn = (u, v) => {\n' +
    '      const p = freezeMapFn!(u, v)\n' +
    '      return { x: p.x * sx, y: p.y * sy }\n' +
    '    }'
  assert(arviewSrc.includes(stretchedMapBlock), 'expected the exact stretchedMapFn closure (scales freezeMapFn\'s output by sx/sy) verbatim in arview.ts')
  assert(arviewSrc.includes('drawOverlayFor(freezeCtx, stretchedMapFn, freezeTimeMs)'), 'expected renderFreeze() to draw with stretchedMapFn, not the raw freezeMapFn')
  return 'arview.ts still snapshots freezeRect at Freeze-press time and applies the sx/sy-stretched map on every renderFreeze() redraw — deleting any of these four pieces fails this test independently of the FIXED MODEL tests above'
})

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
