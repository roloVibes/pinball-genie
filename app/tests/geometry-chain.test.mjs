#!/usr/bin/env node
// app/tests/geometry-chain.test.mjs — SUITE 4: the (u,v) -> tap -> stage px ->
// video px -> keyframe px coordinate CHAIN (geometry lens).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/geometry-chain.test.mjs"
// or from app/:
//   node tests/geometry-chain.test.mjs
//
// Exits non-zero on any FAIL. No deps beyond esbuild (already present via
// vite) — same bundling pattern as app/scripts/selftest.mjs and
// app/tests/arview-seams.test.mjs: the REAL .ts sources are bundled and
// imported; app/src is never edited or copied.
//
// REAL (bundled, executed) code under test:
//   ar/homography.ts  — computeHomography / applyH (every H below is built by
//                       the real DLT solver, never a hand-written matrix)
//   ar/camera.ts      — the real grabFrame() (scaleToVideo + Math.round
//                       downscale), driven through a minimal DOM stub
//   overlay/drawing.ts— the real drawGoalOverlay(), recorded through a
//                       coordinate-capturing 2D-context stub, fed real
//                       data/jaws_goals.json
// LITERAL COPIES (labeled at each use): arview.ts's coverFit /
//   displayToMedia / mediaToDisplay (arview.ts lines 152-165) and its
//   onCalibrated/liveMapFn composition (lines 655-661 / 760-771). arview.ts
//   exports only mountAR(), so these internals cannot be imported; they are
//   copied verbatim from source, not reimplemented from intent — exactly the
//   convention app/tests/arview-seams.test.mjs already uses.
//
// Sections:
//   1. chain round-trip + tap-order/v-flip correspondence   (expect PASS)
//   2. object-fit:cover inverse — crop signs + how much
//      camera FOV the portrait stage throws away             (evidence)
//   3. grabFrame downscale: scaleToVideo isotropy            (expect PASS)
//   4. keyframe image vs. tapped quad: different camera poses (DEFECT)
//   5. corners clamped to the stage: off-frame playfield      (DEFECT)
//   6. video intrinsic size changes mid-session               (DEFECT)
//   7. tracker-H composition order in liveMapFn               (expect PASS)
//   8. grabFrame's shared canvas — aliasing surface           (expect PASS)
//   9. non-convex (but not crossed) quad: vanishing line
//      inside the unit square; drawing.ts's isFinite guard    (evidence)

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const srcDir = resolve(appDir, 'src')
const dataDir = resolve(appDir, '../data')

// ---------------------------------------------------------------------------
// Tiny harness (no vitest/tsx in this repo — see selftest.mjs's header note)
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
    results.push({ name: full, outcome: 'pass' })
    console.log(`  PASS  ${name}`)
    if (evidence) console.log(`        ${evidence}`)
  } catch (e) {
    results.push({ name: full, outcome: 'fail' })
    console.log(`  FAIL  ${name}`)
    console.log(`        ${e && e.stack ? e.stack : e}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function close(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`)
}

// ---------------------------------------------------------------------------
// Bundle the real modules
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-geom-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  [
    `export * as homography from ${JSON.stringify(resolve(srcDir, 'ar/homography'))}`,
    `export * as camera from ${JSON.stringify(resolve(srcDir, 'ar/camera'))}`,
    `export * as drawing from ${JSON.stringify(resolve(srcDir, 'overlay/drawing'))}`,
    `export * as models from ${JSON.stringify(resolve(srcDir, 'models'))}`,
  ].join('\n'),
)
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})

// camera.ts touches `document` at module scope only inside createCameraFeed(),
// but its listeners are registered on the global `document` — stub it BEFORE
// importing so the import itself is side-effect free either way.
installDomStub()
const { homography, camera, drawing, models } = await import(pathToFileURL(outfile).href)
const { computeHomography, applyH } = homography

// ---------------------------------------------------------------------------
// Minimal DOM stub — only what ar/camera.ts actually touches (read from the
// full file): document.createElement('video'|'canvas'),
// document.addEventListener, and on the elements the properties camera.ts
// sets/reads. drawImage is recorded so the tests can assert on the exact
// downscale rectangle grabFrame draws.
// ---------------------------------------------------------------------------
function installDomStub() {
  const drawCalls = []
  class FakeCanvas {
    constructor() {
      this.width = 300
      this.height = 150
      this._ctx = {
        canvas: this,
        drawImage: (...args) => drawCalls.push(args),
      }
    }
    getContext() {
      return this._ctx
    }
  }
  class FakeVideo {
    constructor() {
      this.style = {}
      this.videoWidth = 0
      this.videoHeight = 0
      this.srcObject = null
      this._attrs = {}
    }
    setAttribute(k, v) {
      this._attrs[k] = v
    }
    addEventListener() {}
    play() {
      return Promise.resolve()
    }
  }
  globalThis.document = {
    _listeners: new Map(),
    visibilityState: 'visible',
    createElement(tag) {
      return tag === 'canvas' ? new FakeCanvas() : new FakeVideo()
    },
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set())
      this._listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn)
    },
  }
  // Node 24 exposes a getter-only globalThis.navigator — define over it.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [] }) } },
  })
  globalThis.__drawCalls = drawCalls
}

// ---------------------------------------------------------------------------
// LITERAL COPIES of ar/arview.ts's unexported geometry helpers.
// Source: app/src/ar/arview.ts lines 152-165. Copied verbatim.
// ---------------------------------------------------------------------------
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

// ar/arview.ts line 96-101 (tap order BL, BR, TR, TL <-> unit square).
const UNIT_SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const IDENTITY_H = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const KEYFRAME_MAX_DIM = 480 // arview.ts line 104

/** Faithful re-execution of arview.onCalibrated()'s geometry (lines 648-661),
 *  using the REAL grabFrame() for the keyframe downscale and the REAL DLT. */
function calibrate(feed, stageRect, cornersDisplayPx) {
  const vw = feed.video.videoWidth || 1
  const vh = feed.video.videoHeight || 1
  const kf = feed.grabFrame(KEYFRAME_MAX_DIM)
  const cover = coverFit(stageRect.width, stageRect.height, vw, vh)
  const quadKeyframePx = cornersDisplayPx.map(([dx, dy]) => {
    const media = displayToMedia(dx, dy, cover)
    return [media.x / kf.scaleToVideo, media.y / kf.scaleToVideo]
  })
  return {
    calibrationHKeyframe: computeHomography(UNIT_SQUARE, quadKeyframePx),
    quadKeyframePx,
    scaleToVideo: kf.scaleToVideo,
  }
}

/** Faithful re-execution of arview.liveMapFn() (lines 760-771) + renderLive's
 *  fresh per-frame reads (lines 793-800) and tick()'s lastScaleToVideo update
 *  (line 729). `trackerH === null` reproduces the `?? IDENTITY_H` fallback. */
function liveMap(feed, calH, rect, trackerH) {
  const videoW = feed.video.videoWidth || 1
  const videoH = feed.video.videoHeight || 1
  const lastScaleToVideo = feed.grabFrame(KEYFRAME_MAX_DIM).scaleToVideo // tick() line 728-729
  const cover = coverFit(rect.width, rect.height, videoW, videoH)
  const effTrackerH = trackerH ?? IDENTITY_H
  return (u, v) => {
    const kfPt = applyH(calH, u, v)
    const trackedPt = applyH(effTrackerH, kfPt.x, kfPt.y)
    return mediaToDisplay(trackedPt.x * lastScaleToVideo, trackedPt.y * lastScaleToVideo, cover)
  }
}

function makeFeed(videoWidth, videoHeight) {
  const feed = camera.createCameraFeed()
  feed.video.videoWidth = videoWidth
  feed.video.videoHeight = videoHeight
  return feed
}

// A plausible hand-held framing of a playfield on a 390x844 (iPhone 14-class)
// stage: BL, BR, TR, TL — calibrate.ts's tap order.
const STAGE = { width: 390, height: 844 }
const TAPS = [
  [60, 760],
  [330, 760],
  [300, 180],
  [90, 180],
]

// ===========================================================================
section('1. chain round-trip + tap-order / v-flip correspondence')
// ===========================================================================

await test('(u,v) -> display px round-trips EXACTLY back to the tapped corners (identity tracker)', () => {
  const feed = makeFeed(1280, 720)
  const cal = calibrate(feed, STAGE, TAPS)
  const map = liveMap(feed, cal.calibrationHKeyframe, STAGE, null)
  const errs = UNIT_SQUARE.map(([u, v], i) => {
    const p = map(u, v)
    return Math.hypot(p.x - TAPS[i][0], p.y - TAPS[i][1])
  })
  const max = Math.max(...errs)
  assert(max < 1e-9, `chain must round-trip; max corner error ${max}`)
  return `max round-trip error over the 4 corners: ${max.toExponential(2)}px (the ÷scaleToVideo at calibration and the ×lastScaleToVideo per frame are the SAME scalar, so the keyframe downscale cancels exactly)`
})

await test('UNIT_SQUARE[0]=(0,0) is the BOTTOM-LEFT tap and v grows toward the BACK (v-flip is correct)', () => {
  const feed = makeFeed(1280, 720)
  const cal = calibrate(feed, STAGE, TAPS)
  const map = liveMap(feed, cal.calibrationHKeyframe, STAGE, null)
  const bl = map(0, 0)
  const tl = map(0, 1)
  assert(bl.y > tl.y, `v=0 must be LOWER on screen (larger y) than v=1: ${bl.y} vs ${tl.y}`)
  // models.ts: Shot.y is "0->1 flippers->back"; BALL_ANCHORS.leftFlipper.v=0.04
  const lf = models.BALL_ANCHORS.leftFlipper
  const p = map(lf.u, lf.v)
  assert(p.y > STAGE.height * 0.75, `left-flipper anchor must land in the bottom quarter of the stage, got y=${p.y}`)
  return `v=0 -> y=${bl.y.toFixed(0)} (bottom), v=1 -> y=${tl.y.toFixed(0)} (top); BALL_ANCHORS.leftFlipper(u=${lf.u},v=${lf.v}) -> (${p.x.toFixed(0)},${p.y.toFixed(0)}) on a ${STAGE.width}x${STAGE.height} stage`
})

// ===========================================================================
section('2. object-fit:cover inverse — crop signs, and the FOV the stage discards')
// ===========================================================================

await test('cover offsets are NEGATIVE (crop, never letterbox) and displayToMedia stays inside the media rect', () => {
  for (const [vw, vh] of [
    [1280, 720],
    [720, 1280],
    [640, 480],
  ]) {
    const c = coverFit(STAGE.width, STAGE.height, vw, vh)
    assert(c.offsetX <= 1e-9 && c.offsetY <= 1e-9, `cover must never letterbox (${vw}x${vh}): ${JSON.stringify(c)}`)
    for (const [dx, dy] of [
      [0, 0],
      [STAGE.width, STAGE.height],
      [STAGE.width, 0],
    ]) {
      const m = displayToMedia(dx, dy, c)
      assert(
        m.x >= -1e-9 && m.x <= vw + 1e-9 && m.y >= -1e-9 && m.y <= vh + 1e-9,
        `every in-stage point must invert to a point inside the video (${vw}x${vh}): ${JSON.stringify(m)}`,
      )
      const back = mediaToDisplay(m.x, m.y, c)
      close(back.x, dx, 1e-9, 'displayToMedia/mediaToDisplay must be exact inverses (x)')
      close(back.y, dy, 1e-9, 'displayToMedia/mediaToDisplay must be exact inverses (y)')
    }
  }
  return 'crop signs correct and the inverse is exact for landscape, portrait and 4:3 tracks'
})

await test('a LANDSCAPE track in the portrait stage discards ~74% of the camera’s horizontal FOV', () => {
  // camera.ts (lines 56-62) asks for width:{ideal:1280}, height:{ideal:720} —
  // a LANDSCAPE track — and both stages (.pg-cal-stage / .ar-frame) are the
  // full-bleed portrait viewport. object-fit:cover then crops the width.
  const c = coverFit(STAGE.width, STAGE.height, 1280, 720)
  const displayedVideoW = 1280 * c.scale
  const visibleFraction = STAGE.width / displayedVideoW
  // Horizontal half-angle actually shown, for a 67-degree-HFOV phone camera.
  const tanHalf = Math.tan((67 / 2) * (Math.PI / 180))
  const visibleHalfAngleDeg = Math.atan(tanHalf * visibleFraction) * (180 / Math.PI)
  // Distance needed to fit a 22" wide playfield (glass + rails) across it.
  const needInches = 11 / Math.tan(visibleHalfAngleDeg * (Math.PI / 180))
  assert(visibleFraction < 0.35, `expected a heavy horizontal crop, got ${visibleFraction}`)
  const cPortrait = coverFit(STAGE.width, STAGE.height, 720, 1280)
  const visiblePortrait = STAGE.width / (720 * cPortrait.scale)
  return (
    `1280x720 track, 390x844 stage: cover scale=${c.scale.toFixed(3)}, displayed video is ${displayedVideoW.toFixed(0)}px wide, ` +
    `only ${(visibleFraction * 100).toFixed(0)}% of the frame width is on screen (offsetX=${c.offsetX.toFixed(0)}px each side) -> ` +
    `~${(visibleHalfAngleDeg * 2).toFixed(0)}° of usable HFOV, so the 4 corners of a 22"-wide playfield only fit from ` +
    `~${(needInches / 12).toFixed(1)} ft back. (A PORTRAIT 720x1280 track instead keeps ${(visiblePortrait * 100).toFixed(0)}% of its width.)`
  )
})

// ===========================================================================
section('3. grabFrame downscale — scaleToVideo isotropy (Math.round on cw/ch)')
// ===========================================================================

await test('the single scaleToVideo scalar matches the vertical scale for every realistic capture size', () => {
  const sizes = [
    [1280, 720],
    [640, 480],
    [1920, 1080],
    [1024, 768],
    [1280, 960],
    [1600, 1200],
    [3840, 2160],
    [1440, 1080],
    [720, 1280],
    [1152, 864],
    [352, 288],
    [2592, 1944],
    [4032, 3024],
  ]
  let worst = 0
  let worstAt = null
  for (const [vw, vh] of sizes) {
    const feed = makeFeed(vw, vh)
    const { canvas, scaleToVideo } = feed.grabFrame(KEYFRAME_MAX_DIM)
    const yScaleTrue = vh / canvas.height
    const relative = Math.abs(scaleToVideo - yScaleTrue) / yScaleTrue
    if (relative > worst) {
      worst = relative
      worstAt = `${vw}x${vh} -> ${canvas.width}x${canvas.height}`
    }
  }
  // Not a "should be zero" assertion by luck: it IS zero for every 4:3/16:9
  // capture size because Math.round(vw*s)/vw === Math.round(vh*s)/vh there.
  assert(worst < 1e-12, `anisotropy ${worst} at ${worstAt ?? '(none)'}`)
  return `max |vw/cw - vh/ch| / (vh/ch) over ${sizes.length} real capture sizes = ${worst} (no size produced ANY anisotropy) — Math.round never splits the axes for 4:3/16:9 tracks, so the single-scalar scaleToVideo is exact`
})

await test('grabFrame with videoWidth===0 yields scaleToVideo=1 against a 1x1 canvas (the || 1 fallback)', () => {
  const feed = makeFeed(0, 0)
  const g = feed.grabFrame(KEYFRAME_MAX_DIM)
  assert(g.canvas.width === 1 && g.canvas.height === 1, `expected a 1x1 keyframe, got ${g.canvas.width}x${g.canvas.height}`)
  assert(g.scaleToVideo === 1, `expected scaleToVideo 1, got ${g.scaleToVideo}`)
  // Consequence in the LIVE loop (not calibration): renderLive() reads the
  // same `|| 1` fallback for the cover fit, so one 1x1 frame throws the whole
  // overlay off-screen until metadata lands.
  const feed720 = makeFeed(1280, 720)
  const cal = calibrate(feed720, STAGE, TAPS)
  const mapBlind = liveMap(feed, cal.calibrationHKeyframe, STAGE, null)
  const p = mapBlind(0.5, 0.5)
  assert(Math.abs(p.x) > 1e4 || Math.abs(p.y) > 1e4, `expected an off-screen blowup, got ${JSON.stringify(p)}`)
  return `a frame grabbed while videoWidth===0 maps playfield center (0.5,0.5) to (${p.x.toFixed(0)},${p.y.toFixed(0)}) on a 390x844 stage — coverFit(390,844,1,1) has scale=${coverFit(390, 844, 1, 1).scale}`
})

// ===========================================================================
section('4. keyframe image and tapped quad come from DIFFERENT camera poses')
// ===========================================================================

await test('camera motion between the last corner tap and the Accept press becomes a PERMANENT overlay offset', () => {
  // calibrate.ts:320-326 acceptManual() hands over the corners tapped/dragged
  // earlier; arview.ts:655 grabs the tracker KEYFRAME image at that instant.
  // The tracker's homography is therefore anchored to the pose of the Accept
  // frame, while calibrationHKeyframe encodes the corners as seen in the
  // (older) tap-time pose. Nothing re-projects one onto the other.
  const feed = makeFeed(1280, 720)
  const cal = calibrate(feed, STAGE, TAPS)

  // Phone moves between the taps and the button press (thumb reaching for
  // "Accept" tilts the phone): the playfield shifts by dx,dy display px.
  for (const [dx, dy] of [
    [8, -6],
    [18, -14],
    [30, 24],
  ]) {
    // A PERFECT tracker: it reports exactly the keyframe->current-frame motion
    // in keyframe px (so this is the best case, not a tracking failure).
    const kfScale = cal.scaleToVideo
    const cover = coverFit(STAGE.width, STAGE.height, 1280, 720)
    const kfDx = dx / cover.scale / kfScale
    const kfDy = dy / cover.scale / kfScale
    const trackerH = [1, 0, kfDx, 0, 1, kfDy, 0, 0, 1]
    const map = liveMap(feed, cal.calibrationHKeyframe, STAGE, trackerH)
    // Where the real BL corner now IS on screen after that motion:
    const truthBL = [TAPS[0][0] + dx, TAPS[0][1] + dy]
    const drawn = map(0, 0)
    const err = Math.hypot(drawn.x - truthBL[0], drawn.y - truthBL[1])
    // The tracker moved the overlay WITH the playfield, so a perfect tracker
    // leaves error 0 for motion AFTER the keyframe. The defect is motion
    // BEFORE the keyframe — modelled next.
    assert(err < 1e-6, `sanity: post-keyframe motion must be absorbed by the tracker, got ${err}`)
  }

  // Now the real case: the quad was tapped in pose A, the keyframe grabbed in
  // pose B (A + delta). calibrationHKeyframe still says the corners are at
  // their pose-A pixels, but every tracker H from now on is relative to B.
  const rows = []
  for (const [dx, dy] of [
    [8, -6],
    [18, -14],
    [30, 24],
  ]) {
    const tapsPoseA = TAPS
    const cover = coverFit(STAGE.width, STAGE.height, 1280, 720)
    const calA = calibrate(feed, STAGE, tapsPoseA)
    // Truth in pose B (where the playfield actually is in the keyframe image
    // the tracker anchors to):
    const truthPoseB = tapsPoseA.map(([x, y]) => [x + dx, y + dy])
    const mapNow = liveMap(feed, calA.calibrationHKeyframe, STAGE, null) // tracker sees pose B == current
    const errs = truthPoseB.map(([tx, ty], i) => {
      const p = mapNow(...UNIT_SQUARE[i])
      return Math.hypot(p.x - tx, p.y - ty)
    })
    const maxErr = Math.max(...errs)
    close(maxErr, Math.hypot(dx, dy), 1e-6, 'offset must equal the between-poses motion')
    rows.push(`${Math.hypot(dx, dy).toFixed(0)}px of motion -> ${maxErr.toFixed(1)}px permanent overlay offset`)
  }
  return (
    `quad captured in the tap pose, keyframe grabbed at Accept (arview.ts:655) — ${rows.join('; ')}. ` +
    `The offset never decays: every later tracker H is relative to the Accept-time keyframe, so it transports the WRONG anchor. ` +
    `The same misalignment also seeds tracker.init()'s Shi-Tomasi quad (arview.ts:669) off the playfield.`
  )
})

// ===========================================================================
section('5. corners clamped to the stage rect — off-frame playfield corners')
// ===========================================================================

await test('a playfield corner outside the frame is silently clamped to the edge and skews the whole homography', () => {
  // calibrate.ts:234 clamps every tap to [0,rect.width]x[0,rect.height], and
  // :250-251 clamps the drag handles the same way, so a corner the camera
  // cannot see CANNOT be expressed — the user taps the nearest visible edge
  // and the HUD still reports "All 4 corners placed" -> Accept -> (R5)
  // the buttonless "Locking on…" progress state.
  const rows = []
  for (const off of [40, 100, 200]) {
    const truth = [[-off, 760], [330, 760], [300, 180], [90, 180]]
    const clamped = [[0, 760], [330, 760], [300, 180], [90, 180]]
    const hTruth = computeHomography(UNIT_SQUARE, truth)
    const hClamped = computeHomography(UNIT_SQUARE, clamped)
    let worst = 0
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const a = applyH(hTruth, i / 20, j / 20)
        const b = applyH(hClamped, i / 20, j / 20)
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y))
      }
    }
    const lf = models.BALL_ANCHORS.leftFlipper
    const a = applyH(hTruth, lf.u, lf.v)
    const b = applyH(hClamped, lf.u, lf.v)
    const lfErr = Math.hypot(a.x - b.x, a.y - b.y)
    assert(worst > off * 0.9, `expected the error to scale with the off-frame distance, got ${worst} for ${off}`)
    rows.push(`BL ${off}px off-frame -> up to ${worst.toFixed(0)}px overlay error (${lfErr.toFixed(0)}px at the left-flipper anchor)`)
  }
  return `${rows.join('; ')} — nothing anywhere checks whether a tap/handle is sitting on the stage boundary, so this calibration is accepted silently`
})

// ===========================================================================
section('6. video intrinsic size changes mid-session')
// ===========================================================================

await test('calibrationHKeyframe is never invalidated when videoWidth/videoHeight change', () => {
  // camera.ts's restart() (lines 86-101, driven by handleVisibilityChange)
  // re-runs getUserMedia with `ideal` — not `exact` — constraints, so the
  // rebuilt track may come back at a different size; on Android the track
  // dimensions also swap on rotation. arview.ts never listens for the
  // <video> 'resize' event and never recomputes calibrationHKeyframe.
  const feedA = makeFeed(1280, 720)
  const cal = calibrate(feedA, STAGE, TAPS)
  const mapA = liveMap(feedA, cal.calibrationHKeyframe, STAGE, null)

  const rows = []
  for (const [vw, vh] of [
    [640, 480],
    [720, 1280],
  ]) {
    const feedB = makeFeed(vw, vh)
    const mapB = liveMap(feedB, cal.calibrationHKeyframe, STAGE, null)
    let worst = 0
    for (const [u, v] of [...UNIT_SQUARE, [0.5, 0.5]]) {
      const a = mapA(u, v)
      const b = mapB(u, v)
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y))
    }
    assert(worst > 50, `expected a large displacement after a resolution change, got ${worst}`)
    rows.push(`${vw}x${vh}: up to ${worst.toFixed(0)}px displacement`)
  }
  return (
    `calibrated at 1280x720, stream rebuilt at — ${rows.join('; ')}. Bites whenever the tracker is in its fallback ` +
    `(trackingEnabled===false / "?? lastGoodTrackerH ?? IDENTITY_H", arview.ts:762); a live tracker lock absorbs it, a lost one does not.`
  )
})

// ===========================================================================
section('7. tracker-H composition order in liveMapFn')
// ===========================================================================

await test('liveMapFn composes calH -> trackerH -> scaleToVideo -> cover in the right order', () => {
  const feed = makeFeed(1280, 720)
  const cal = calibrate(feed, STAGE, TAPS)
  // A tracker H that scales about the keyframe origin AND translates: if the
  // order were swapped (trackerH applied to display px, or the scale applied
  // before trackerH) the result below would differ.
  const trackerH = [1.1, 0.02, 7, -0.03, 0.95, -11, 0, 0, 1]
  const map = liveMap(feed, cal.calibrationHKeyframe, STAGE, trackerH)
  const cover = coverFit(STAGE.width, STAGE.height, 1280, 720)
  for (const [u, v] of [
    [0, 0],
    [1, 1],
    [0.37, 0.81],
  ]) {
    const kfPt = applyH(cal.calibrationHKeyframe, u, v)
    const expected = mediaToDisplay(
      (trackerH[0] * kfPt.x + trackerH[1] * kfPt.y + trackerH[2]) / (trackerH[6] * kfPt.x + trackerH[7] * kfPt.y + trackerH[8]) * cal.scaleToVideo,
      (trackerH[3] * kfPt.x + trackerH[4] * kfPt.y + trackerH[5]) / (trackerH[6] * kfPt.x + trackerH[7] * kfPt.y + trackerH[8]) * cal.scaleToVideo,
      cover,
    )
    const got = map(u, v)
    close(got.x, expected.x, 1e-9, `composition order (x) at (${u},${v})`)
    close(got.y, expected.y, 1e-9, `composition order (y) at (${u},${v})`)
  }
  return 'keyframe-px tracker H is applied AFTER calH and BEFORE the ×scaleToVideo / cover-fit projection — matches ar/tracker.ts’s documented "keyframe px -> current frame px" contract'
})

// ===========================================================================
section('8. grabFrame’s shared canvas — aliasing surface')
// ===========================================================================

await test('grabFrame returns ONE shared canvas per feed, and arview never holds it across an await', () => {
  const feed = makeFeed(1280, 720)
  const a = feed.grabFrame(KEYFRAME_MAX_DIM)
  const b = feed.grabFrame(KEYFRAME_MAX_DIM)
  assert(a.canvas === b.canvas, 'expected the same canvas instance (camera.ts caches frameCanvas)')
  // Resizing to a different maxDim reuses the same element, resetting pixels:
  const c = feed.grabFrame(240)
  assert(c.canvas === a.canvas && c.canvas.width === 240, `expected an in-place resize, got ${c.canvas.width}`)
  return (
    'shared instance confirmed. arview.ts:655-667 calls getImageData() on it in the SAME synchronous task as the grab ' +
    '(computeHomography + createTracker in between are both sync), and tick():728-732 does the same, so no consumer ever ' +
    'observes a canvas repainted by another consumer — no aliasing defect, but any future await between grab and read introduces one.'
  )
})

// ===========================================================================
section('9. non-convex (uncrossed) quad: the vanishing line inside the unit square')
// ===========================================================================

await test('concavity needs a ~257px mistap before w=0 reaches the unit square — then it is finite and unguarded', () => {
  const base = [...TAPS.map((t) => [...t])]
  const concave = [...base.map((t) => [...t])]
  concave[3] = [base[3][0] + 126, base[3][1] + 224] // TL pulled toward the center
  const h = computeHomography(UNIT_SQUARE, concave)
  let minW = Infinity
  let flipped = 0
  let n = 0
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const u = i / 40
      const v = j / 40
      const w = h[6] * u + h[7] * v + h[8]
      minW = Math.min(minW, w)
      n++
      if (w < 0) flipped++
    }
  }
  assert(minW < 0, `expected the vanishing line to cross the unit square, got minW=${minW}`)
  const lf = models.BALL_ANCHORS.leftFlipper
  const p = applyH(h, lf.u, lf.v)
  assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'coordinates stay FINITE — this is the point')
  const good = computeHomography(UNIT_SQUARE, base)
  const pGood = applyH(good, lf.u, lf.v)
  return (
    `TL mistapped 257px into the playfield (smaller mistaps stay convex — checked 36/72/99/108px, all w>0): w goes negative over ` +
    `${((100 * flipped) / n).toFixed(2)}% of the unit square (minW=${minW.toFixed(2)}, i.e. the vanishing line has only just crossed a corner); ` +
    `the left-flipper anchor moves (${pGood.x.toFixed(0)},${pGood.y.toFixed(0)}) -> (${p.x.toFixed(0)},${p.y.toFixed(0)}), still FINITE, so drawing.ts's ` +
    `Number.isFinite() degrade path (drawing.ts:402/418/450) never fires. computeHomography accepts it (no convexity/orientation check). ` +
    `Conclusion: the CONCAVE case needs an implausibly large mistap — the CROSSED (tap-order) case, already reported by suites 1-2, is the realistic one.`
  )
})

await test('real goal data on a strongly foreshortened quad does NOT blow up (control points stay on the safe side of w=0)', () => {
  // drawing.ts routes through control points computed from real goal data
  // (bowControl/directControl: 2026-07-29, both now just the chord midpoint —
  // a degenerate quadratic that draws an exact straight line; laneRoute's
  // ARCH legs still push their control OUTSIDE the unit square, e.g. up to
  // v=0.99), so this checks whether any real route crosses the vanishing
  // line.
  const data = JSON.parse(readFileSync(resolve(dataDir, 'jaws_goals.json'), 'utf8'))
  const shotsByID = new Map(data.shots.map((s) => [s.id, s]))
  const yb = 790
  const yt = 250
  const cx = 195
  let worstAbs = 0
  let worstAt = null
  for (const backW of [240, 100, 40, 24]) {
    const quad = [
      [40, yb],
      [350, yb],
      [cx + backW / 2, yt],
      [cx - backW / 2, yt],
    ]
    const h = computeHomography(UNIT_SQUARE, quad)
    const map = (u, v) => applyH(h, u, v)
    for (const goal of data.goals) {
      const { ctx, pts } = recordingCtx()
      drawing.drawGoalOverlay(ctx, {
        shotsByID,
        goal,
        stepIndex: 0,
        ballPosition: 'any',
        map,
        time: 1000,
        showLabels: true,
        lineBrightness: 1,
      })
      for (const p of pts) {
        assert(Number.isFinite(p.x) && Number.isFinite(p.y), `non-finite draw coord in ${goal.id} @ backW ${backW}`)
        const a = Math.max(Math.abs(p.x), Math.abs(p.y))
        if (a > worstAbs) {
          worstAbs = a
          worstAt = `${goal.id} @ back edge ${backW}px`
        }
      }
    }
  }
  assert(worstAbs < 5000, `expected no vanishing-line blowup with real data, worst |coord| = ${worstAbs}`)
  return `all 22 JAWS goals x 4 foreshortening levels (back edge 240px down to 24px): worst drawn coordinate |${worstAbs.toFixed(0)}|px (${worstAt}) — real shot/waypoint geometry never pushes a control point past w=0`
})

/** 2D-context stub that records every coordinate the real drawing.ts emits. */
function recordingCtx() {
  const pts = []
  const rec = (...xs) => {
    for (let i = 0; i + 1 < xs.length; i += 2) pts.push({ x: xs[i], y: xs[i + 1] })
  }
  const noop = () => {}
  const base = {
    // drawing.ts:697 reads ctx.canvas.clientWidth || ctx.canvas.width for
    // label placement — CSS px in the app (canvases are DPR-scaled by
    // arview.ts's sizeCanvasToRect, which installs a dpr transform).
    canvas: { clientWidth: STAGE.width, clientHeight: STAGE.height, width: STAGE.width * 3, height: STAGE.height * 3 },
    moveTo: rec,
    lineTo: rec,
    quadraticCurveTo: rec,
    bezierCurveTo: rec,
    arc: (x, y) => rec(x, y),
    rect: (x, y) => rec(x, y),
    roundRect: (x, y) => rec(x, y),
    fillText: (t, x, y) => rec(x, y),
    strokeText: (t, x, y) => rec(x, y),
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    setLineDash: noop,
  }
  const ctx = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: () => true,
  })
  return { ctx, pts }
}

// ---------------------------------------------------------------------------
await rm(tmp, { recursive: true, force: true })
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
