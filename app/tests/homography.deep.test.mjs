#!/usr/bin/env node
// app/tests/homography.deep.test.mjs
//
// SUITE 1 — homography + coordinate-chain math (deep test).
// Scope: app/src/ar/homography.ts (computeHomography/applyH, bundled REAL
// via esbuild, no reimplementation) + a line-quoted local reimplementation
// of app/src/ar/arview.ts's onCalibrated()/liveMapFn() coordinate chain
// (that file has DOM/CSS-import side effects so it isn't Node-bundlable —
// see the "FULL-CHAIN REPLICA" section below for exact source quotes).
//
// Run (cwd matters per the harness note this suite was briefed with; we
// empirically verified both work — see PROVENANCE note below — but the
// canonical invocation, matching app/scripts/selftest.mjs's own documented
// usage, is from app/):
//
//   cd app && node tests/homography.deep.test.mjs
//
// Also verified working from the repo root:
//   cd PinballGenieWeb && node app/tests/homography.deep.test.mjs
//
// PROVENANCE: esbuild's entryPoints-based bundling of ar/homography.ts uses
// __dirname (import.meta.url), not process.cwd(), to locate ../src, and
// Node's ESM bare-specifier resolution ("esbuild") walks up from THIS
// file's own directory (app/tests/ -> app/node_modules), not cwd — so
// unlike some other harness scripts in this batch, this file's bundling
// step does not actually depend on cwd. Both invocations above were run and
// produced identical PASS/FAIL output before this file was finalized.
//
// No test framework is installed (vitest/tsx aren't dependencies — see
// package.json), so this file is a self-contained runner: exits non-zero if
// any assertion fails, prints a JSON summary to stdout.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')

// ---------------------------------------------------------------------------
// Bundle the REAL app/src/ar/homography.ts (pattern: app/scripts/selftest.mjs)
// ---------------------------------------------------------------------------
const tmpDir = await mkdtemp(resolve(tmpdir(), 'pg-homography-deep-'))
const outfile = resolve(tmpDir, 'homography-bundle.mjs')
let computeHomography, applyH, homographySelfTest
try {
  await build({
    entryPoints: [resolve(srcDir, 'ar/homography.ts')],
    bundle: true,
    write: true,
    outfile,
    format: 'esm',
    platform: 'node',
    target: 'node18',
  })
  ;({ computeHomography, applyH, homographySelfTest } = await import(pathToFileURL(outfile).href))
} finally {
  await rm(tmpDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Tiny self-contained test harness (no framework installed in this repo)
// ---------------------------------------------------------------------------
const results = []
const findings = []

function record(name, outcome, evidence) {
  results.push({ name, outcome, evidence: evidence ?? '' })
}

function assert(name, cond, evidence) {
  record(name, cond ? 'pass' : 'fail', evidence)
  if (!cond) console.error(`FAIL: ${name}\n  ${evidence}`)
  return cond
}

function finding(file, title, detail, severity, provenBy, line) {
  findings.push({ file, title, detail, severity, provenBy, line })
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — fixed integer literal seed, NEVER Date.now()/
// Math.random(), so every run of this permanent test file is byte-identical.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let s = seed >>> 0
  return function rng() {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// UNIT_SQUARE order matches ar/homography.ts's own homographySelfTest() and
// arview.ts's UNIT_SQUARE constant: BL, BR, TR, TL; v=0 at the FLIPPER edge.
const UNIT_SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

function maxRoundTripError(h, src, dst) {
  let maxErr = 0
  for (let i = 0; i < src.length; i++) {
    const [sx, sy] = src[i]
    const p = applyH(h, sx, sy)
    maxErr = Math.max(maxErr, Math.hypot(p.x - dst[i][0], p.y - dst[i][1]))
  }
  return maxErr
}

// Signed cross product of edge (a->b) and (b->c) — used for both convexity
// verification of generated fuzz quads and point-in-convex-polygon tests.
function cross3(a, b, c) {
  const v1x = b[0] - a[0]
  const v1y = b[1] - a[1]
  const v2x = c[0] - b[0]
  const v2y = c[1] - b[1]
  return v1x * v2y - v1y * v2x
}

function isConvexQuad(poly, minTurnMag = 1e-6) {
  const n = poly.length
  const signs = []
  for (let i = 0; i < n; i++) {
    signs.push(cross3(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]))
  }
  if (signs.some((s) => Math.abs(s) < minTurnMag)) return false
  return signs.every((s) => s > 0) || signs.every((s) => s < 0)
}

/** Point-in-polygon for a CONVEX polygon given in either winding order.
 *  Points within `eps` of an edge count as inside (boundary-inclusive). */
function pointInConvexPolygon(pt, poly, eps = 1e-6) {
  let sign = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const c = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0])
    if (Math.abs(c) < eps) continue
    const s = Math.sign(c)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Fuzzed convex quad generator: one point per quadrant of a WxH box around
 *  the box's own center. NOTE: "one point per quadrant, connected
 *  quadrant-cyclically" is NOT actually guaranteed convex in general (a
 *  point close enough to the shared center can produce a reflex angle at
 *  its neighbor) — empirically ~6% of naive draws from this scheme come out
 *  non-convex, confirmed by an isConvexQuad() rejection count during
 *  development of this generator. So this generator REJECTS and RESAMPLES
 *  (up to MAX_ATTEMPTS) until isConvexQuad() actually agrees, rather than
 *  asserting convexity structurally. `squeezeIdx` (0..3, or -1) pushes that
 *  corner's point hard toward the box center to synthesize strong-perspective
 *  quads (short "near" edge, long "far" edge — the case most likely to break
 *  an under-conditioned DLT solve); this is also the profile most likely to
 *  need a resample. Image/CSS convention: x right, y DOWN, so BL/BR are the
 *  larger-y quadrants. */
const QUAD_GEN_MAX_ATTEMPTS = 200
function randomConvexQuad(rng) {
  for (let attempt = 0; attempt < QUAD_GEN_MAX_ATTEMPTS; attempt++) {
    const W = 100 + rng() * 1900 // 100..2000 px, matches typical stage/video px ranges
    const H = 100 + rng() * 1900
    const cx = W / 2
    const cy = H / 2
    const strong = rng() < 0.3
    const squeezeIdx = strong ? Math.floor(rng() * 4) : -1

    function pt(xlo, xhi, ylo, yhi, squeeze) {
      // Normal: interpolate broadly inside the quadrant, away from its edges
      // (0.05..0.95) so no coordinate lands exactly on an axis by chance.
      // Squeezed: interpolate within a thin (0.02..0.10) sliver near ONE
      // corner of the quadrant (chosen per-call below) to create an extreme,
      // strongly-foreshortened quad while staying inside the quadrant.
      const fx = squeeze ? 0.02 + rng() * 0.08 : 0.05 + rng() * 0.9
      const fy = squeeze ? 0.02 + rng() * 0.08 : 0.05 + rng() * 0.9
      return [xlo + fx * (xhi - xlo), ylo + fy * (yhi - ylo)]
    }

    const BL = pt(0, cx, cy, H, squeezeIdx === 0)
    const BR = pt(cx, W, cy, H, squeezeIdx === 1)
    const TR = pt(cx, W, 0, cy, squeezeIdx === 2)
    const TL = pt(0, cx, 0, cy, squeezeIdx === 3)
    const quad = [BL, BR, TR, TL]
    if (isConvexQuad(quad)) return { quad, strong, W, H, attempts: attempt + 1 }
  }
  throw new Error(`randomConvexQuad: failed to draw a convex quad in ${QUAD_GEN_MAX_ATTEMPTS} attempts (PRNG state bug?)`)
}

// =============================================================================
// (0) Sanity: the module's OWN self-test (homographySelfTest, exported for
//     an integrator smoke test) still passes on the bundle we just built —
//     cheap canary that the esbuild bundle wired up the real module, not a
//     stub.
// =============================================================================
assert('0: app/src/ar/homography.ts\'s own homographySelfTest() passes', homographySelfTest(), 'homographySelfTest() returned false')

// =============================================================================
// (a) Exact 4-corner recovery on 200+ fuzzed convex quads (seeded PRNG)
// =============================================================================
{
  const rng = mulberry32(1337) // fixed literal seed — no Date/Math.random
  const N = 240
  let worstErr = 0
  let worstRelErr = 0
  let worstCase = null
  let strongCount = 0
  let totalAttempts = 0
  for (let i = 0; i < N; i++) {
    const { quad, strong, W, H, attempts } = randomConvexQuad(rng)
    totalAttempts += attempts
    if (strong) strongCount++
    // randomConvexQuad() only ever returns quads that already passed
    // isConvexQuad() internally (reject/resample loop) — reassert here as a
    // cheap regression guard on the generator itself, not on the app.
    if (!isConvexQuad(quad)) throw new Error(`test generator invariant violated at i=${i}: ${JSON.stringify(quad)}`)
    const h = computeHomography(UNIT_SQUARE, quad)
    const err = maxRoundTripError(h, UNIT_SQUARE, quad)
    const diag = Math.hypot(W, H)
    const relErr = err / diag
    if (err > worstErr) {
      worstErr = err
      worstRelErr = relErr
      worstCase = { i, quad, W, H, strong }
    }
  }
  assert(
    'a1: 240 fuzzed convex quads all recover exactly (max abs err < 1e-6 px)',
    worstErr < 1e-6,
    `worst abs err=${worstErr.toExponential(3)}px, worst rel err=${worstRelErr.toExponential(3)}, worst case=${JSON.stringify(worstCase)}`,
  )
  assert(
    `a2: fuzz batch includes strong-perspective quads (${strongCount}/${N} ~30% target)`,
    strongCount > 40,
    `strongCount=${strongCount}`,
  )
  record('a3: generator reject/resample cost (informational)', 'info', `totalAttempts=${totalAttempts} for N=${N} (${(totalAttempts / N).toFixed(2)} attempts/quad avg)`)
  if (worstErr >= 1e-6) {
    finding(
      'app/src/ar/homography.ts',
      'DLT round-trip error exceeds 1e-6 on a fuzzed convex quad',
      `computeHomography->applyH round trip on quad ${JSON.stringify(worstCase)} produced error ${worstErr}px`,
      'major',
      'a1',
    )
  }
}

// =============================================================================
// (b) Interior-point sanity: (0.5,0.5) lands inside the quad for convex quads
// =============================================================================
{
  const rng = mulberry32(2024)
  const N = 200
  let outsideCount = 0
  let firstOutside = null
  for (let i = 0; i < N; i++) {
    const { quad } = randomConvexQuad(rng)
    const h = computeHomography(UNIT_SQUARE, quad)
    const center = applyH(h, 0.5, 0.5)
    const inside = pointInConvexPolygon([center.x, center.y], quad)
    if (!inside) {
      outsideCount++
      if (!firstOutside) firstOutside = { i, quad, center }
    }
  }
  assert(
    `b1: unit-square center (0.5,0.5) maps inside the quad's hull for all ${N} convex fuzz quads`,
    outsideCount === 0,
    `outsideCount=${outsideCount}, firstOutside=${JSON.stringify(firstOutside)}`,
  )
}

// =============================================================================
// (c) Degenerate inputs — assert computeHomography THROWS (or record what it
//     actually does). Per spec, a no-throw result here is EVIDENCE, not a
//     broken test: recorded as 'info' (not a suite failure) plus a finding.
//     Only the one case the code's own singular-system guard demonstrably
//     DOES catch (c3, all-4-collinear) is asserted as a hard pass/fail —
//     that's a real regression test for behavior the source code documents
//     and this suite confirmed works.
// =============================================================================
{
  function tryCompute(label, dst) {
    try {
      const h = computeHomography(UNIT_SQUARE, dst)
      return { label, threw: false, h }
    } catch (e) {
      return { label, threw: true, message: e.message }
    }
  }

  // c1: two coincident corners (BL === BR)
  const twoCoincident = tryCompute('two-coincident-BL-BR', [
    [0, 0],
    [0, 0],
    [100, 100],
    [0, 100],
  ])
  record(
    'c1: two coincident tapped corners (BL===BR) — computeHomography outcome',
    'info',
    JSON.stringify(twoCoincident),
  )
  console.log(`c1 evidence: ${twoCoincident.threw ? 'THREW: ' + twoCoincident.message : 'did NOT throw, H=' + JSON.stringify(twoCoincident.h)}`)

  // c2: three collinear corners (BL, BR, TR all on y=0), TL off-line
  const threeCollinear = tryCompute('three-collinear', [
    [0, 0],
    [50, 0],
    [100, 0],
    [0, 100],
  ])
  record(
    'c2: three collinear tapped corners — computeHomography outcome',
    'info',
    JSON.stringify(threeCollinear),
  )
  console.log(`c2 evidence: ${threeCollinear.threw ? 'THREW: ' + threeCollinear.message : 'did NOT throw, H=' + JSON.stringify(threeCollinear.h)}`)

  // c3: all four corners collinear (all on y=0) — the one case the code's
  // own Gauss-Jordan pivot check (maxAbs < 1e-12) demonstrably catches.
  const fourCollinear = tryCompute('four-collinear', [
    [0, 0],
    [33, 0],
    [66, 0],
    [100, 0],
  ])
  assert(
    'c3: all four tapped corners collinear -> computeHomography throws (the one degenerate case the solver\'s pivot check actually catches)',
    fourCollinear.threw,
    JSON.stringify(fourCollinear),
  )

  if (!twoCoincident.threw) {
    finding(
      'app/src/ar/homography.ts',
      'computeHomography does not throw on two coincident tapped corners',
      `dst=[[0,0],[0,0],[100,100],[0,100]] produced H=${JSON.stringify(twoCoincident.h)} instead of throwing — this is what arview.ts's un-awaited onCalibrated() would propagate (or swallow) if a user taps the same spot twice`,
      'blocker',
      'c1',
    )
  }
  if (!threeCollinear.threw) {
    finding(
      'app/src/ar/homography.ts',
      'computeHomography does not throw on three collinear tapped corners',
      `dst=[[0,0],[50,0],[100,0],[0,100]] produced H=${JSON.stringify(threeCollinear.h)} instead of throwing`,
      'blocker',
      'c2',
    )
  }
  if (!fourCollinear.threw) {
    finding(
      'app/src/ar/homography.ts',
      'computeHomography does not throw on four collinear tapped corners',
      `dst=[[0,0],[33,0],[66,0],[100,0]] produced H=${JSON.stringify(fourCollinear.h)} instead of throwing`,
      'blocker',
      'c3',
    )
  }
}

// =============================================================================
// (d) Crossed 'bowtie' quad (BL,BR swapped) — record H finite + where
//     (0.5,0.5) lands relative to the (self-intersecting) hull
// =============================================================================
{
  // A normal, clean trapezoid quad in BL,BR,TR,TL order...
  const clean = [
    [50, 500],
    [450, 500],
    [400, 50],
    [100, 50],
  ]
  // ...with BL and BR SWAPPED, as if the user tapped corners 1 and 2 out of
  // order — this self-intersects (the BL-TL and BR-TR "legs" now cross).
  const bowtie = [clean[1], clean[0], clean[2], clean[3]]

  let h, threw, errMsg
  try {
    h = computeHomography(UNIT_SQUARE, bowtie)
    threw = false
  } catch (e) {
    threw = true
    errMsg = e.message
  }

  assert('d1: bowtie (BL/BR swapped) quad does NOT throw — computeHomography has no crossed-quad validation', !threw, JSON.stringify({ threw, errMsg }))

  if (!threw) {
    const allFinite = h.every((v) => Number.isFinite(v))
    assert('d2: bowtie H is finite (all 9 entries)', allFinite, JSON.stringify(h))

    const center = applyH(h, 0.5, 0.5)
    const centerFinite = Number.isFinite(center.x) && Number.isFinite(center.y)
    assert('d3: bowtie-mapped center (0.5,0.5) point is finite', centerFinite, JSON.stringify(center))

    // "Inside the hull" is ambiguous for a self-intersecting quad — report
    // membership against BOTH the convex hull of the 4 raw points AND the
    // (invalid, self-intersecting) even-odd polygon defined by the tap
    // order, since a renderer would use the latter.
    const hullPts = [...bowtie].sort((p, q) => Math.atan2(p[1] - 300, p[0] - 250) - Math.atan2(q[1] - 300, q[0] - 250))
    const insideConvexHull = pointInConvexPolygon([center.x, center.y], hullPts)

    record('d4: bowtie evidence — where (0.5,0.5) lands', 'info', JSON.stringify({ bowtie, h, mappedCenter: center, insideConvexHullOfRawPoints: insideConvexHull }))
    console.log(`d4 evidence: bowtie quad=${JSON.stringify(bowtie)} H=${JSON.stringify(h)} mapped(0.5,0.5)=${JSON.stringify(center)} insideConvexHullOfRawPoints=${insideConvexHull}`)

    finding(
      'app/src/ar/homography.ts',
      'No crossed/bowtie-quad validation in computeHomography (confirms candidate defect #2)',
      `Tapping corners out of order (BL/BR swapped) on an otherwise-normal quad ${JSON.stringify(clean)} -> bowtie ${JSON.stringify(bowtie)} still produces a finite H (${JSON.stringify(h)}); (0.5,0.5) maps to ${JSON.stringify(center)}, ${insideConvexHull ? 'INSIDE' : 'OUTSIDE'} the convex hull of the raw tapped points — the overlay silently renders garbage instead of surfacing an error to the user.`,
      'major',
      'd1',
    )
  }
}

// =============================================================================
// (e) Near-degenerate conditioning: tiny quad (4px wide) — round-trip error
// =============================================================================
{
  // A 4px-wide, mildly-perspective quad, positioned away from the origin
  // (origin-adjacency would mask conditioning issues in the h13/h23 terms).
  const tiny = [
    [1000, 1002],
    [1004, 1002],
    [1003, 998],
    [1000.5, 998.5],
  ]
  let h, threw, errMsg, roundTripErr
  try {
    h = computeHomography(UNIT_SQUARE, tiny)
    roundTripErr = maxRoundTripError(h, UNIT_SQUARE, tiny)
    threw = false
  } catch (e) {
    threw = true
    errMsg = e.message
  }
  record(
    'e1: 4px-wide quad — computeHomography outcome',
    threw ? 'info' : 'info',
    JSON.stringify({ threw, errMsg, tiny, h, roundTripErr }),
  )
  console.log(`e1 evidence: tiny=${JSON.stringify(tiny)} threw=${threw} h=${JSON.stringify(h)} roundTripErr=${roundTripErr}`)
  if (!threw) {
    // Not asserting a hard pass/fail threshold here (spec: "measure
    // round-trip error", not "assert it's small") — report the measured
    // value as evidence. 1e-6px on a 4px feature is a ~2.5e-7 relative
    // error; anything above ~1e-3px (a ~0.025% relative wobble on a 4px
    // quad) would be visually meaningful on-screen, so flag it as a finding
    // if crossed.
    assert('e2: tiny-quad round-trip error is finite (no NaN/Inf from ill-conditioning)', Number.isFinite(roundTripErr), `roundTripErr=${roundTripErr}`)
    if (roundTripErr > 1e-3) {
      finding(
        'app/src/ar/homography.ts',
        'DLT solve on a near-degenerate (4px-wide) quad has visually-meaningful round-trip error',
        `4px-wide quad ${JSON.stringify(tiny)} -> round-trip error ${roundTripErr}px (>1e-3px threshold, meaningful relative to the 4px feature size)`,
        'minor',
        'e2',
      )
    }
  } else {
    finding(
      'app/src/ar/homography.ts',
      '4px-wide (near-degenerate but non-collinear) quad throws instead of solving',
      `computeHomography threw on a legitimately tiny but valid convex quad: ${errMsg}`,
      'minor',
      'e1',
    )
  }
}

// =============================================================================
// (f) FULL-CHAIN REPLICA — arview.ts's onCalibrated()/liveMapFn() math,
//     reimplemented EXACTLY (source lines quoted verbatim below), for a
//     portrait 390x654 stage with a 1280x720 landscape video.
// =============================================================================

// ---- Quoted from app/src/ar/arview.ts (coverFit/displayToMedia/mediaToDisplay) ----
//
//   function coverFit(boxW: number, boxH: number, mediaW: number, mediaH: number): CoverFit {
//     const scale = Math.max(boxW / Math.max(1, mediaW), boxH / Math.max(1, mediaH))
//     const dw = mediaW * scale
//     const dh = mediaH * scale
//     return { scale, offsetX: (boxW - dw) / 2, offsetY: (boxH - dh) / 2 }
//   }
//
//   function displayToMedia(dx: number, dy: number, c: CoverFit): { x: number; y: number } {
//     return { x: (dx - c.offsetX) / c.scale, y: (dy - c.offsetY) / c.scale }
//   }
//
//   function mediaToDisplay(mx: number, my: number, c: CoverFit): { x: number; y: number } {
//     return { x: c.offsetX + mx * c.scale, y: c.offsetY + my * c.scale }
//   }
//
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

// ---- Quoted from app/src/ar/camera.ts's grabFrame() (scaleToVideo math) ----
//
//     grabFrame(maxDim = DEFAULT_MAX_DIM) {
//       const vw = video.videoWidth || 1
//       const vh = video.videoHeight || 1
//       const longest = Math.max(vw, vh)
//       const scale = longest > maxDim ? maxDim / longest : 1
//       const cw = Math.max(1, Math.round(vw * scale))
//       const ch = Math.max(1, Math.round(vh * scale))
//       ...
//       return { canvas: frameCanvas, scaleToVideo: vw / cw }
//     },
//
function grabFrameScaleToVideo(videoWidthRaw, videoHeightRaw, maxDim) {
  const vw = videoWidthRaw || 1
  const vh = videoHeightRaw || 1
  const longest = Math.max(vw, vh)
  const scale = longest > maxDim ? maxDim / longest : 1
  const cw = Math.max(1, Math.round(vw * scale))
  return vw / cw
}

// ---- Quoted from app/src/ar/arview.ts (constants) ----
//   const UNIT_SQUARE: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
//   const IDENTITY_H: H = [1, 0, 0, 0, 1, 0, 0, 0, 1]
//   const KEYFRAME_MAX_DIM = 480
const ARVIEW_UNIT_SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const IDENTITY_H = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const KEYFRAME_MAX_DIM = 480

// ---- Quoted from app/src/ar/arview.ts's onCalibrated() (2026-07-28 A4 fix —
//      was `const vw = feed.video.videoWidth || 1` with no guard at all;
//      see the f4/f5 update below for what this changed) ----
//
//   async function onCalibrated(calibration: Calibration): Promise<void> {
//     ...
//     const stageRect = calWrap.getBoundingClientRect()
//     const vw = feed.video.videoWidth
//     const vh = feed.video.videoHeight
//
//     // Backstop only (A4) — calibrate.ts's own Accept-gating (renderManualHud
//     // n===4, feed.video.videoWidth === 0) should make this unreachable; kept
//     // rather than baking a 1x1-video cover fit into calibrationHKeyframe
//     // permanently (the ~947px-off overlay defect this backstops).
//     if (vw === 0 || vh === 0) {
//       console.error('[arview] onCalibrated: video has no dimensions yet')
//       calibrateHandle?.reset()
//       return
//     }
//
//     const kf = feed.grabFrame(KEYFRAME_MAX_DIM)
//     const cover = coverFit(stageRect.width, stageRect.height, vw, vh)
//     const quadKeyframePx: [number, number][] = calibration.corners.map(([dx, dy]) => {
//       const media = displayToMedia(dx, dy, cover)
//       return [media.x / kf.scaleToVideo, media.y / kf.scaleToVideo]
//     })
//     calibrationHKeyframe = computeHomography(UNIT_SQUARE, quadKeyframePx)
//     ...
//     lastScaleToVideo = kf.scaleToVideo   // (set right after)
//     ...
//   }
//
// Returns null when vw===0||vh===0 (mirrors the new guard's early return —
// no cover/homography math ever runs on bogus 1x1-video assumptions).
function replicaOnCalibrated(displayCorners, stageRect, videoWidthRaw, videoHeightRaw) {
  if (videoWidthRaw === 0 || videoHeightRaw === 0) return null
  const vw = videoWidthRaw
  const vh = videoHeightRaw
  const kfScaleToVideo = grabFrameScaleToVideo(videoWidthRaw, videoHeightRaw, KEYFRAME_MAX_DIM)
  const cover = coverFit(stageRect.width, stageRect.height, vw, vh)
  const quadKeyframePx = displayCorners.map(([dx, dy]) => {
    const media = displayToMedia(dx, dy, cover)
    return [media.x / kfScaleToVideo, media.y / kfScaleToVideo]
  })
  const calibrationHKeyframe = computeHomography(ARVIEW_UNIT_SQUARE, quadKeyframePx)
  return { calibrationHKeyframe, lastScaleToVideo: kfScaleToVideo, quadKeyframePx, cover }
}

// ---- Quoted from app/src/ar/arview.ts's liveMapFn() (lines 760-771) ----
//
//   function liveMapFn(rect: { width: number; height: number }, videoW: number, videoH: number): MapFn {
//     const cover = coverFit(rect.width, rect.height, videoW, videoH)
//     const effTrackerH = currentTrackerH ?? lastGoodTrackerH ?? IDENTITY_H
//     const calH = calibrationHKeyframe as H
//     return (u, v) => {
//       const kfPt = applyH(calH, u, v)
//       const trackedPt = applyH(effTrackerH, kfPt.x, kfPt.y)
//       const vx = trackedPt.x * lastScaleToVideo
//       const vy = trackedPt.y * lastScaleToVideo
//       return mediaToDisplay(vx, vy, cover)
//     }
//   }
//
function replicaLiveMapFn(rect, videoW, videoH, calibrationHKeyframe, trackerH, lastScaleToVideo) {
  const cover = coverFit(rect.width, rect.height, videoW, videoH)
  return (u, v) => {
    const kfPt = applyH(calibrationHKeyframe, u, v)
    const trackedPt = applyH(trackerH, kfPt.x, kfPt.y)
    const vx = trackedPt.x * lastScaleToVideo
    const vy = trackedPt.y * lastScaleToVideo
    return mediaToDisplay(vx, vy, cover)
  }
}

{
  // Per-spec scenario: portrait 390x654 stage (iPhone-class viewport minus
  // chrome), 1280x720 landscape video (a common webcam/rear-camera mode).
  // .ar-cal-wrap and .ar-frame are documented (arview.ts's own header
  // comment, lines 55-61) to be sized identically, so stageRect === the
  // later frame.getBoundingClientRect() used by liveMapFn — reused as-is.
  const stageRect = { width: 390, height: 654 }
  const videoW = 1280
  const videoH = 720

  // Tapped display-px corners, BL, BR, TR, TL, a plausible in-bounds
  // playfield quad inside the 390x654 stage.
  const tapped = [
    [40, 600], // BL
    [350, 600], // BR
    [340, 80], // TR
    [50, 70], // TL
  ]

  const { calibrationHKeyframe, lastScaleToVideo, cover: calCover } = replicaOnCalibrated(tapped, stageRect, videoW, videoH)

  assert('f1: calibrationHKeyframe is 9 finite numbers', calibrationHKeyframe.length === 9 && calibrationHKeyframe.every(Number.isFinite), JSON.stringify(calibrationHKeyframe))

  const map = replicaLiveMapFn(stageRect, videoW, videoH, calibrationHKeyframe, IDENTITY_H, lastScaleToVideo)

  // f2: the 4 unit-square corners round-trip to the ORIGINAL tapped display
  // px within 1e-6, with identity trackerH and lastScaleToVideo taken
  // straight from the same grabFrame() call used to build calibrationHKeyframe
  // (exactly as arview.ts does at line 686, immediately post-calibration,
  // before any live tick() has run).
  let maxChainErr = 0
  const roundTrip = []
  for (let i = 0; i < ARVIEW_UNIT_SQUARE.length; i++) {
    const [u, v] = ARVIEW_UNIT_SQUARE[i]
    const p = map(u, v)
    const target = tapped[i]
    const err = Math.hypot(p.x - target[0], p.y - target[1])
    maxChainErr = Math.max(maxChainErr, err)
    roundTrip.push({ u, v, mapped: p, target, err })
  }
  assert(
    'f2: full chain (taps -> calibrationHKeyframe -> identity trackerH -> liveMapFn) round-trips all 4 corners within 1e-6px',
    maxChainErr < 1e-6,
    JSON.stringify({ maxChainErr, roundTrip }),
  )

  // f3: (0.5, 0.03) — the launch-anchor point near the v=0 (FLIPPER) edge —
  // lands between the bottom corners (inside the quad's hull, and nearer
  // the BL/BR pair than the TL/TR pair).
  const launch = map(0.5, 0.03)
  const insideHull = pointInConvexPolygon([launch.x, launch.y], tapped)
  const bottomMidY = (tapped[0][1] + tapped[1][1]) / 2 // BL,BR
  const topMidY = (tapped[2][1] + tapped[3][1]) / 2 // TR,TL
  const nearerBottom = Math.abs(launch.y - bottomMidY) < Math.abs(launch.y - topMidY)
  const xBetween = launch.x >= Math.min(tapped[0][0], tapped[1][0]) - 1e-6 && launch.x <= Math.max(tapped[0][0], tapped[1][0]) + 1e-6
  assert(
    'f3: launch anchor (0.5,0.03) lands inside the quad hull, nearer the bottom (BL/BR) edge, x between BL.x and BR.x',
    insideHull && nearerBottom && xBetween,
    JSON.stringify({ launch, insideHull, nearerBottom, xBetween, bottomMidY, topMidY }),
  )

  // ---------------------------------------------------------------------
  // f4/f5 (2026-07-28 UPDATE — A4 fix landed): this section used to run the
  // SAME chain with arview.ts's old `feed.video.videoWidth || 1` fallback
  // (vw=vh=1) and measure how wrong the resulting overlay got (up to
  // ~947px on a 390x654 stage — a real, confirmed blocker finding at the
  // time). arview.ts's onCalibrated() no longer has that fallback: it now
  // reads `vw = feed.video.videoWidth` (no `|| 1`) and returns immediately
  // — before ever calling coverFit/computeHomography — when vw===0||vh===0
  // (see the updated source quote above). replicaOnCalibrated() above was
  // updated to match (returns null on vw===0||vh===0 instead of silently
  // computing under vw=vh=1). f4/f5 below now regression-test THAT guard
  // instead of measuring the (no-longer-reachable) bad math.
  // ---------------------------------------------------------------------
  {
    const guarded = replicaOnCalibrated(tapped, stageRect, 0, 0)
    assert(
      'f4: onCalibrated() with videoWidth===0 now returns null (short-circuits) instead of silently computing a bogus 1x1-cover calibrationHKeyframe',
      guarded === null,
      JSON.stringify({ guarded }),
    )

    // f5: confirm the guard fires on EITHER dimension being 0 independently
    // (not just both at once), and that a genuinely-ready video (both
    // dimensions nonzero) is unaffected by the new check.
    const guardedWidthOnly = replicaOnCalibrated(tapped, stageRect, 0, videoH)
    const guardedHeightOnly = replicaOnCalibrated(tapped, stageRect, videoW, 0)
    const unguarded = replicaOnCalibrated(tapped, stageRect, videoW, videoH)
    assert(
      'f5: the vw===0||vh===0 guard fires independently on either dimension, and never fires when both are real',
      guardedWidthOnly === null && guardedHeightOnly === null && unguarded !== null,
      JSON.stringify({ guardedWidthOnly, guardedHeightOnly, unguardedIsNull: unguarded === null }),
    )

    record(
      'f4/f5: videoWidth===0 defect (was: up to 947px overlay error, blocker) — FIXED, no longer reproducible',
      'info',
      'Two independent, redundant guards now prevent this: (1) ar/calibrate.ts\'s own Accept-gating renders Accept DISABLED with "Camera still starting — one moment" while feed.video.videoWidth===0 — see calibrate.e2e.py\'s test_accept_disabled_when_videoWidth_zero, verified against the real bundled module; (2) ar/arview.ts\'s onCalibrated() keeps an explicit vw===0||vh===0 backstop (console.error + calibrateHandle?.reset() + return) in case (1) is ever bypassed. This section (f4/f5) exercises a hand-written replica of guard (2)\'s SHAPE (replicaOnCalibrated() above) — that replica alone does NOT regression-test arview.ts itself (a replica can drift from its source silently); the SOURCE PIN test right after this one is what actually fails if the real guard is deleted.',
    )

    // ---------------------------------------------------------------------
    // SOURCE PIN (R6 honesty repair): f4/f5 above only prove the REPLICA
    // (replicaOnCalibrated, a hand-written copy) has the right shape — that
    // alone is invisible to a deletion of the real guard in arview.ts, since
    // nothing here previously read the actual source file. Mutation-proven:
    // deleting the `if (vw === 0 || vh === 0) { ... return }` block from
    // arview.ts's onCalibrated() left every other test in this repo green.
    // This pin closes that gap by grepping the REAL bundled-from source file
    // for the guard's exact condition and its early-return body.
    // ---------------------------------------------------------------------
    const arviewSrc = readFileSync(resolve(srcDir, 'ar/arview.ts'), 'utf8')
    const guardIdx = arviewSrc.indexOf('if (vw === 0 || vh === 0) {')
    assert(
      'SOURCE PIN: the real arview.ts onCalibrated() still contains the `vw === 0 || vh === 0` guard',
      guardIdx !== -1,
      'expected the literal condition `if (vw === 0 || vh === 0) {` present in app/src/ar/arview.ts — deleting or rewording it fails this test independently of the replica above',
    )
    if (guardIdx !== -1) {
      const resetIdx = arviewSrc.indexOf('calibrateHandle?.reset()', guardIdx)
      const returnIdx = arviewSrc.indexOf('return', guardIdx)
      const closeBraceIdx = arviewSrc.indexOf('}', guardIdx)
      assert(
        'SOURCE PIN: the guard block still calls calibrateHandle?.reset() and returns, in that order, before its closing brace',
        resetIdx !== -1 && returnIdx !== -1 && resetIdx < returnIdx && returnIdx < closeBraceIdx,
        `expected reset() < return < closing brace after the guard condition, got indices ${JSON.stringify({ guardIdx, resetIdx, returnIdx, closeBraceIdx })}`,
      )
    }
  }
}

// =============================================================================
// Report
// =============================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
const info = results.filter((r) => r.outcome === 'info').length

console.log(
  JSON.stringify(
    {
      suite: 'SUITE 1 — homography + coordinate-chain math',
      passed,
      failed,
      info,
      results,
      findings,
    },
    null,
    2,
  ),
)

if (failed > 0) process.exitCode = 1
