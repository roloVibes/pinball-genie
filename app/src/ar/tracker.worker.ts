// ar/tracker.worker.ts — OpenCV.js keyframe tracking pipeline.
//
// Fills the ROLE ARCore's SLAM world-tracking plays natively (Android:
// ArSessionManager.kt's per-frame anchor/pose update; iOS: ARKit) — there is
// no single native file this is a line-for-line port of, since the browser
// has no 6-DoF pose API. Instead: a SELF-REFERENCING 2D tracker. At init(),
// Shi-Tomasi corners ("good features") are detected inside the calibrated
// quad on the keyframe; the keyframe's grayscale image AND that corner set
// are held IMMUTABLE for the whole session (never reassigned, only ever
// selected from — see TrackerState). Every track() call steps the currently
// active corners forward with Lucas-Kanade pyramidal optical flow (previous
// frame -> current frame), and the homography fit each frame is always
// KEYFRAME -> CURRENT (RANSAC) using the immutable keyframe coordinates of
// whichever corners are still active, never frame(n-1) -> frame(n) chained
// — chaining per-frame homographies would accumulate drift; anchoring every
// fit back to the immutable keyframe does not. When too many corners are
// lost (occlusion, fast motion), re-detect does NOT invent new "keyframe"
// coordinates by reprojecting fresh current-frame corners backwards through
// the (imperfect) last homography — instead it re-runs LK directly from the
// immutable keyframe grayscale to the current frame (one larger-baseline
// jump), seeded with each corner's last-known-good reprojection through
// lastGoodH purely as a starting guess (cv.OPTFLOW_USE_INITIAL_FLOW), and
// keeps only the survivors that pass both the LK status flag and an error
// cutoff. The active working set can therefore only ever be a SELECTION
// from the original immutable corners, never a fabricated one, so no
// per-event error can bake into the anchor and compound across re-detects.
// See ar/tracker.ts for the RPC contract and CONTRACTS.md.
//
// Runs entirely in this module worker (Vite `worker: { format: 'es' }`,
// vite.config.ts) so OpenCV.js's ~10 MB asm.js/WASM payload never blocks the
// main thread. `self` is accessed through a narrow local interface instead of
// the `webworker` lib, matching ar/quaddetect.worker.ts's convention — the
// project tsconfig's shared `dom` lib already declares a conflicting `self`
// and isn't ours to change (CONTRACTS.md: own only your listed files).
//
// Every OpenCV Mat this file allocates is freed in a try/finally — per the
// task brief, OpenCV.js heap leaks are the #1 bug in code like this.

import * as cvModule from '@techstark/opencv-js'
import { applyH, type H } from './homography'

// ---- OpenCV.js async init -------------------------------------------------
//
// @techstark/opencv-js is an Emscripten MODULARIZE build: its real CommonJS
// export is a thenable that resolves to the cv API once the WASM/asm.js
// runtime finishes initializing (confirmed empirically — a throwaway Vite
// build + Node execution of the bundled output showed the imported value has
// `.then` and resolves to an object with working `Mat`/`goodFeaturesToTrack`/
// etc). The package's shipped .d.ts declares a flat named-export namespace
// instead (no `default`), so `import cv from '@techstark/opencv-js'` (the
// README's documented usage) fails `tsc` without `esModuleInterop`, which
// isn't set in this project's tsconfig and isn't ours to add. Going through
// a namespace import + cast sidesteps that: Vite's CJS interop surfaces the
// real thenable as the namespace's `default` at runtime, which is all we use.
//
// The resolved `cv` object itself is typed `any` throughout this file: the
// shipped typings are, by the package's own README, "not always up to date"
// with the runtime surface, and OpenCV.js's embind constants/overloads don't
// map cleanly onto the declared types. Every other type in this file stays
// strict; this is a deliberately narrow, documented exception at the WASM
// interop boundary.
const cvReadyPromise = (cvModule as unknown as { default: Promise<any> }).default

let cvPromise: Promise<any> | null = null
function ensureCv(): Promise<any> {
  if (!cvPromise) cvPromise = cvReadyPromise
  return cvPromise
}
// Kick off the (slow, one-time) OpenCV.js init as soon as the worker spins
// up, so it's usually already warm by the time init() is first called.
void ensureCv()

// ---- Tunables (per the task brief) ----------------------------------------
const MAX_DIM = 480 // longest side of the internal tracking work image, px
const MAX_CORNERS = 200
const QUALITY_LEVEL = 0.01
const MIN_DISTANCE = 7 // px, in work space
const MIN_SURVIVORS = 12 // below this (even after a re-detect attempt) -> h:null
const REDETECT_RATIO = 0.4 // survivors < this fraction of the last baseline -> re-detect
const RANSAC_REPROJ_THRESHOLD = 3
const LK_WIN_SIZE = 21
const LK_MAX_LEVEL = 3
const LK_CRITERIA_MAX_COUNT = 30
const LK_CRITERIA_EPS = 0.01
// Empirical per-point LK error cutoff for the re-detect jump only (see
// lkTrackSeeded). Normal frame-to-frame LK doesn't gate on `err`: RANSAC in
// fitHomography is enough to reject outliers at that (much smaller)
// baseline. A single large-baseline jump seeded far from the truth is far
// more prone to a "confidently wrong" converged match, so this is an extra
// filter on top of the LK status flag before a re-detect survivor is
// trusted at all.
const REDETECT_MAX_ERR = 24
const FPS_EMA_ALPHA = 0.2

// ---- Message protocol -------------------------------------------------
interface InitRequest {
  type: 'init'
  id: number
  buffer: ArrayBuffer
  width: number
  height: number
  quad: [number, number][]
}

interface TrackRequest {
  type: 'track'
  id: number
  buffer: ArrayBuffer
  width: number
  height: number
}

type WorkerRequestMsg = InitRequest | TrackRequest

interface InitResponse {
  type: 'init'
  id: number
  ok: boolean
}

interface TrackResponse {
  type: 'track'
  id: number
  h: number[] | null
  inliers: number
  fps: number
}

type WorkerResponseMsg = InitResponse | TrackResponse

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequestMsg>) => void) | null
  postMessage(msg: WorkerResponseMsg): void
}

const ctx = self as unknown as WorkerScope

// ---- Tracking state ---------------------------------------------------
//
// Points are kept as plain [x,y] pairs between calls — only the grayscale
// frame Mats need to persist as real cv.Mats across track() calls; every
// point set is wrapped into a transient Mat only for the duration of the
// OpenCV call that needs it, then immediately freed. This keeps Mat
// lifetimes short and easy to audit.
interface TrackerState {
  workW: number
  workH: number
  /** Grayscale, work-space Mat of the last successfully processed frame
   *  (initially a clone of keyframeGray, until the first track() call). */
  prevGray: any
  /** Grayscale, work-space Mat of the keyframe itself — set once at init()
   *  and NEVER reassigned or mutated for the session's lifetime. The
   *  re-detect path's LK source image, so a big-baseline jump is always
   *  measured against the true keyframe, never a derived approximation. */
  keyframeGray: any
  /** Work-space [x,y] pairs of the corners CURRENTLY being tracked,
   *  index-aligned with activeIdx (and, through it, with
   *  keyframePtsOriginal/keyframePtsWork). */
  prevPtsWork: [number, number][]
  /** Indices into keyframePtsOriginal/keyframePtsWork for the corners
   *  currently active — i.e. prevPtsWork[i] corresponds to
   *  keyframePtsOriginal[activeIdx[i]]. Shrinks/refreshes each frame as
   *  points are lost or a re-detect selects new survivors; never used to
   *  rewrite the immutable arrays it indexes into. */
  activeIdx: number[]
  /** ORIGINAL keyframe px [x,y] pairs, the FULL set detected at init() —
   *  immutable for the session's lifetime, index-aligned with
   *  keyframePtsWork. Every homography is fit against a selection of these
   *  true coordinates, never a reprojected/fabricated substitute. */
  keyframePtsOriginal: [number, number][]
  /** Work-space counterpart of keyframePtsOriginal (same indices), used as
   *  the LK source points when re-detecting from keyframeGray. Also
   *  immutable for the session's lifetime. */
  keyframePtsWork: [number, number][]
  /** Survivor count baseline the 40% re-detect threshold is measured
   *  against; reset each time a re-detect succeeds. */
  baselineCount: number
  /** Last homography that successfully fit (keyframe px -> frame px), used
   *  to seed the re-detect LK search with each corner's best-guess current
   *  position. */
  lastGoodH: H | null
  fpsEma: number
  lastFrameTime: number | null
}

let state: TrackerState | null = null

function freeState(): void {
  if (state) {
    state.prevGray.delete()
    state.keyframeGray.delete()
    state = null
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function applyHXY(h: H, x: number, y: number): [number, number] {
  const p = applyH(h, x, y)
  return [p.x, p.y]
}

function computeWorkDims(width: number, height: number, maxDim: number): { workW: number; workH: number } {
  const longest = Math.max(width, height)
  const scale = longest > maxDim ? maxDim / longest : 1
  return { workW: Math.max(1, Math.round(width * scale)), workH: Math.max(1, Math.round(height * scale)) }
}

/** RGBA ArrayBuffer (original frame px) -> grayscale cv.Mat resized to a
 *  FIXED work resolution (workW x workH). Forcing every frame — keyframe and
 *  every subsequent live frame — through the same fixed work size (rather
 *  than each frame downscaling relative to its own dimensions) guarantees
 *  prevGray and curGray always match in size, which calcOpticalFlowPyrLK
 *  requires. Caller owns the returned Mat. */
function toWorkGray(cv: any, width: number, height: number, buffer: ArrayBuffer, workW: number, workH: number): any {
  const imgData = new ImageData(new Uint8ClampedArray(buffer), width, height)
  const rgba = cv.matFromImageData(imgData)
  const resized = new cv.Mat()
  const gray = new cv.Mat()
  try {
    cv.resize(rgba, resized, new cv.Size(workW, workH), 0, 0, cv.INTER_AREA)
    cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY)
    return gray
  } catch (e) {
    gray.delete()
    throw e
  } finally {
    rgba.delete()
    resized.delete()
  }
}

/** goodFeaturesToTrack masked to a work-space polygon. Returns work-space
 *  [x,y] pairs (possibly empty). */
function detectFeaturesInPolygon(
  cv: any,
  gray: any,
  polygonWork: [number, number][],
  workW: number,
  workH: number,
): [number, number][] {
  const mask = new cv.Mat(workH, workW, cv.CV_8UC1, new cv.Scalar(0))
  const flatPts: number[] = []
  for (const [x, y] of polygonWork) {
    flatPts.push(clamp(Math.round(x), 0, workW - 1), clamp(Math.round(y), 0, workH - 1))
  }
  const polyMat = cv.matFromArray(polygonWork.length, 1, cv.CV_32SC2, flatPts)
  const polyVec = new cv.MatVector()
  polyVec.push_back(polyMat)
  const corners = new cv.Mat()
  try {
    cv.fillPoly(mask, polyVec, new cv.Scalar(255))
    cv.goodFeaturesToTrack(gray, corners, MAX_CORNERS, QUALITY_LEVEL, MIN_DISTANCE, mask)
    const out: [number, number][] = []
    for (let i = 0; i < corners.rows; i++) {
      out.push([corners.data32F[i * 2], corners.data32F[i * 2 + 1]])
    }
    return out
  } finally {
    mask.delete()
    polyMat.delete()
    polyVec.delete()
    corners.delete()
  }
}

/** One LK step: prevGray/prevPtsWork -> curGray. Returns the survivors'
 *  work-space positions plus the indices (into prevPtsWork, and therefore —
 *  via the caller's index-aligned activeIdx — into keyframePtsOriginal)
 *  that survived. */
function lkTrack(
  cv: any,
  prevGray: any,
  curGray: any,
  prevPtsWork: [number, number][],
): { curPts: [number, number][]; keepIdx: number[] } {
  const n = prevPtsWork.length
  const prevFlat = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const [x, y] = prevPtsWork[i] as [number, number]
    prevFlat[i * 2] = x
    prevFlat[i * 2 + 1] = y
  }
  const prevMat = cv.matFromArray(n, 1, cv.CV_32FC2, prevFlat)
  const nextMat = new cv.Mat()
  const status = new cv.Mat()
  const err = new cv.Mat()
  const winSize = new cv.Size(LK_WIN_SIZE, LK_WIN_SIZE)
  const criteria = new cv.TermCriteria(
    cv.TermCriteria_COUNT + cv.TermCriteria_EPS,
    LK_CRITERIA_MAX_COUNT,
    LK_CRITERIA_EPS,
  )
  try {
    cv.calcOpticalFlowPyrLK(prevGray, curGray, prevMat, nextMat, status, err, winSize, LK_MAX_LEVEL, criteria)
    const curPts: [number, number][] = []
    const keepIdx: number[] = []
    for (let i = 0; i < n; i++) {
      if (status.data8U[i] === 1) {
        keepIdx.push(i)
        curPts.push([nextMat.data32F[i * 2], nextMat.data32F[i * 2 + 1]])
      }
    }
    return { curPts, keepIdx }
  } finally {
    prevMat.delete()
    nextMat.delete()
    status.delete()
    err.delete()
  }
}

/** Re-detect LK step: srcGray/srcPtsWork -> dstGray, a single (possibly
 *  large-baseline) jump, seeded per-point via cv.OPTFLOW_USE_INITIAL_FLOW so
 *  the search starts at seedPtsWork's guess instead of blind. Survivors are
 *  filtered by both the LK status flag AND a max-error cutoff — a big jump
 *  is far more prone to a "confidently wrong" converged match than the
 *  frame-to-frame case, where RANSAC alone is enough. Returns the indices
 *  (into srcPtsWork/seedPtsWork) that survived, so the caller can select
 *  the matching immutable keyframe coordinates rather than fabricate any. */
function lkTrackSeeded(
  cv: any,
  srcGray: any,
  dstGray: any,
  srcPtsWork: [number, number][],
  seedPtsWork: [number, number][],
): { dstPts: [number, number][]; keepIdx: number[] } {
  const n = srcPtsWork.length
  const srcFlat = new Float32Array(n * 2)
  const seedFlat = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const [sx, sy] = srcPtsWork[i] as [number, number]
    srcFlat[i * 2] = sx
    srcFlat[i * 2 + 1] = sy
    const [gx, gy] = seedPtsWork[i] as [number, number]
    seedFlat[i * 2] = gx
    seedFlat[i * 2 + 1] = gy
  }
  const srcMat = cv.matFromArray(n, 1, cv.CV_32FC2, srcFlat)
  // nextMat doubles as the initial-guess INPUT and the refined-position
  // OUTPUT under OPTFLOW_USE_INITIAL_FLOW.
  const nextMat = cv.matFromArray(n, 1, cv.CV_32FC2, seedFlat)
  const status = new cv.Mat()
  const err = new cv.Mat()
  const winSize = new cv.Size(LK_WIN_SIZE, LK_WIN_SIZE)
  const criteria = new cv.TermCriteria(
    cv.TermCriteria_COUNT + cv.TermCriteria_EPS,
    LK_CRITERIA_MAX_COUNT,
    LK_CRITERIA_EPS,
  )
  try {
    cv.calcOpticalFlowPyrLK(
      srcGray,
      dstGray,
      srcMat,
      nextMat,
      status,
      err,
      winSize,
      LK_MAX_LEVEL,
      criteria,
      cv.OPTFLOW_USE_INITIAL_FLOW,
    )
    const dstPts: [number, number][] = []
    const keepIdx: number[] = []
    for (let i = 0; i < n; i++) {
      if (status.data8U[i] === 1 && (err.data32F[i] as number) <= REDETECT_MAX_ERR) {
        keepIdx.push(i)
        dstPts.push([nextMat.data32F[i * 2], nextMat.data32F[i * 2 + 1]])
      }
    }
    return { dstPts, keepIdx }
  } finally {
    srcMat.delete()
    nextMat.delete()
    status.delete()
    err.delete()
  }
}

/** RANSAC homography fit, keyframe (original px) -> current frame
 *  (original px). Returns the row-major 3x3 array + inlier count, or
 *  {h:null} if the fit fails/degenerates. */
function fitHomography(
  cv: any,
  srcPts: [number, number][],
  dstPts: [number, number][],
): { h: number[] | null; inliers: number } {
  const n = srcPts.length
  const srcFlat = new Float32Array(n * 2)
  const dstFlat = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const [sx, sy] = srcPts[i] as [number, number]
    const [dx, dy] = dstPts[i] as [number, number]
    srcFlat[i * 2] = sx
    srcFlat[i * 2 + 1] = sy
    dstFlat[i * 2] = dx
    dstFlat[i * 2 + 1] = dy
  }
  const srcMat = cv.matFromArray(n, 1, cv.CV_32FC2, srcFlat)
  const dstMat = cv.matFromArray(n, 1, cv.CV_32FC2, dstFlat)
  const mask = new cv.Mat()
  let hMat: any = null
  try {
    hMat = cv.findHomography(srcMat, dstMat, cv.RANSAC, RANSAC_REPROJ_THRESHOLD, mask)
    if (!hMat || hMat.empty() || hMat.rows !== 3 || hMat.cols !== 3) {
      return { h: null, inliers: 0 }
    }
    const h: number[] = Array.from(hMat.data64F)
    let inliers = 0
    for (let i = 0; i < mask.rows; i++) if (mask.data8U[i]) inliers++
    return { h, inliers }
  } finally {
    srcMat.delete()
    dstMat.delete()
    mask.delete()
    hMat?.delete()
  }
}

function updateFps(now: number): number {
  if (!state) return 0
  if (state.lastFrameTime != null) {
    const dt = now - state.lastFrameTime
    if (dt > 0) {
      const inst = 1000 / dt
      state.fpsEma = state.fpsEma === 0 ? inst : state.fpsEma * (1 - FPS_EMA_ALPHA) + inst * FPS_EMA_ALPHA
    }
  }
  state.lastFrameTime = now
  return state.fpsEma
}

// ---- Request handlers ---------------------------------------------------

async function handleInit(req: InitRequest): Promise<InitResponse> {
  const cv = await ensureCv()
  freeState() // in case of recalibration mid-session — never leak the old Mat

  const { workW, workH } = computeWorkDims(req.width, req.height, MAX_DIM)
  const scaleX = workW / req.width
  const scaleY = workH / req.height
  const quadWork = req.quad.map(([x, y]) => [x * scaleX, y * scaleY] as [number, number])

  const gray = toWorkGray(cv, req.width, req.height, req.buffer, workW, workH)
  let pts: [number, number][]
  try {
    pts = detectFeaturesInPolygon(cv, gray, quadWork, workW, workH)
  } catch (e) {
    gray.delete()
    console.error('tracker.worker: init feature detection failed', e)
    return { type: 'init', id: req.id, ok: false }
  }

  if (pts.length < MIN_SURVIVORS) {
    gray.delete()
    return { type: 'init', id: req.id, ok: false }
  }

  const keyframePtsOriginal = pts.map(([x, y]) => [x / scaleX, y / scaleY] as [number, number])
  state = {
    workW,
    workH,
    prevGray: gray,
    keyframeGray: gray.clone(),
    prevPtsWork: pts,
    activeIdx: pts.map((_, i) => i),
    keyframePtsOriginal,
    keyframePtsWork: pts,
    baselineCount: pts.length,
    lastGoodH: null,
    fpsEma: 0,
    lastFrameTime: null,
  }
  return { type: 'init', id: req.id, ok: true }
}

async function handleTrack(req: TrackRequest): Promise<TrackResponse> {
  const cv = await ensureCv()
  const fps = updateFps(performance.now())

  if (!state) {
    return { type: 'track', id: req.id, h: null, inliers: 0, fps }
  }
  const s = state
  const scaleX = s.workW / req.width
  const scaleY = s.workH / req.height
  const curGray = toWorkGray(cv, req.width, req.height, req.buffer, s.workW, s.workH)
  let committed = false

  try {
    const { curPts, keepIdx } = lkTrack(cv, s.prevGray, curGray, s.prevPtsWork)
    let activeIdx = keepIdx.map((i) => s.activeIdx[i] as number)
    let curPtsWork = curPts
    let survivorCount = curPts.length
    let baselineReset = false

    if (survivorCount < MIN_SURVIVORS || survivorCount < REDETECT_RATIO * s.baselineCount) {
      // Re-establish TRUE keyframe<->current correspondences by tracking
      // straight from the immutable keyframe grayscale (a single larger
      // jump), seeded with each keyframe corner's last-known-good
      // reprojection through lastGoodH so the search starts close to the
      // answer instead of blind. The LK source is always
      // s.keyframePtsWork/s.keyframePtsOriginal — the untouched originals —
      // so this can only SELECT survivors from them, never fabricate new
      // anchor coordinates.
      const seedWork = s.keyframePtsOriginal.map(([x, y]) => {
        const [px, py] = s.lastGoodH ? applyHXY(s.lastGoodH, x, y) : [x, y]
        return [clamp(px * scaleX, 0, s.workW - 1), clamp(py * scaleY, 0, s.workH - 1)] as [number, number]
      })
      const { dstPts, keepIdx: redetectIdx } = lkTrackSeeded(cv, s.keyframeGray, curGray, s.keyframePtsWork, seedWork)
      if (dstPts.length >= MIN_SURVIVORS) {
        activeIdx = redetectIdx
        curPtsWork = dstPts
        survivorCount = dstPts.length
        baselineReset = true
      }
    }

    if (survivorCount < MIN_SURVIVORS) {
      // Tracking lost this frame. Leave persisted state untouched (do NOT
      // advance prevGray) so the next call retries LK + re-detect from the
      // same last-known-good anchor rather than compounding staleness.
      return { type: 'track', id: req.id, h: null, inliers: 0, fps }
    }

    const keyframePts = activeIdx.map((i) => s.keyframePtsOriginal[i] as [number, number])
    const curPtsOriginal = curPtsWork.map(([x, y]) => [x / scaleX, y / scaleY] as [number, number])
    const { h, inliers } = fitHomography(cv, keyframePts, curPtsOriginal)

    // Commit: point tracking and homography fitting are decoupled failure
    // modes — this frame's LK/re-detect result becomes the new anchor for
    // the next call regardless of whether findHomography itself succeeded.
    // The immutable keyframe (keyframeGray/keyframePtsOriginal/
    // keyframePtsWork) is never touched here — only which corners are
    // currently active (activeIdx) and their last-seen frame position
    // (prevPtsWork) advance.
    s.prevGray.delete()
    s.prevGray = curGray
    committed = true
    s.prevPtsWork = curPtsWork
    s.activeIdx = activeIdx
    if (baselineReset) s.baselineCount = survivorCount
    if (h) s.lastGoodH = h

    return { type: 'track', id: req.id, h, inliers, fps }
  } catch (e) {
    console.error('tracker.worker: track failed', e)
    return { type: 'track', id: req.id, h: null, inliers: 0, fps }
  } finally {
    if (!committed) curGray.delete()
  }
}

// ---- Wiring ---------------------------------------------------------------
// track() calls never overlap in practice — ar/tracker.ts drops a frame
// rather than issuing a second concurrent request — so handlers freely read
// and mutate module-level `state` without additional locking. A recalibrate
// (new 'init') is likewise expected only while no track() is in flight (the
// calibration UI replaces the live-tracking view).
ctx.onmessage = (ev) => {
  const req = ev.data
  if (req.type === 'init') {
    void handleInit(req).then((res) => ctx.postMessage(res))
  } else {
    void handleTrack(req).then((res) => ctx.postMessage(res))
  }
}
