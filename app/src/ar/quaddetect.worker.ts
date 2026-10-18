// ar/quaddetect.worker.ts — pixel-processing port of QuadDetector.kt.
// Native source (357 lines):
//   PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/ar/QuadDetector.kt
//
// Ports `detectCorners` and its helpers (`convexHull`, `reduceToQuad`,
// `cross`/`crossD`/`sq`/`samePoint`) EXACTLY — same downscale width, same
// Sobel kernel, same mean+1.5σ threshold, same 8-connected iterative
// flood fill, same Andrew's monotone-chain hull, same farthest-point
// 4-corner reduction. Every threshold/constant below matches the Kotlin
// `companion object` values 1:1.
//
// One unavoidable platform difference: QuadDetector.kt reads luma directly
// off ARCore's Y (YUV) plane — real camera luminance with no RGB roundtrip.
// The browser only ever hands us RGBA ImageData (from camera.ts's
// grabFrame() canvas), so this file derives luma from RGB using the
// standard BT.601 weights before running the identical pipeline below.
//
// What this file deliberately does NOT do (ported instead in quaddetect.ts,
// which owns the main-thread side of the wrapper) — see CONTRACTS.md:
//   - ordering corners to BL/BR/TR/TL (native: takeResult's orderCorners)
//   - convexity rejection (native: takeResult's isConvex)
//   - the >= 20%-of-viewport area gate and the 5-consecutive-hit stability
//     rule (native: ArSessionManager's onAutoDetection) — those need the
//     real on-screen viewport, which only calibrate.ts has (SPEC-AUTOCAL).
//
// This file has no top-level imports/exports besides the `export {}` marker
// required to make it a module under isolatedModules; `self` is accessed
// through a narrow local interface instead of the `webworker` lib to avoid
// colliding with the project tsconfig's `dom` lib (both declare `self`).

export {}

// ---- Constants — identical to QuadDetector.kt's companion object ----
const DOWNSCALE_WIDTH = 120
const EDGE_SIGMA = 1.5
const MIN_COMPONENT = 12

interface DetectRequest {
  id: number
  buffer: ArrayBuffer // ImageData.data.buffer (RGBA8, tightly packed), transferred
  width: number
  height: number
}

interface DetectResponse {
  id: number
  corners: [number, number][] | null // p0, p1, p2, p3 in full input-frame px, unordered/unrotated
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent<DetectRequest>) => void) | null
  postMessage(msg: DetectResponse): void
}

const ctx = self as unknown as WorkerScope

ctx.onmessage = (ev: MessageEvent<DetectRequest>) => {
  const { id, buffer, width, height } = ev.data
  let corners: [number, number][] | null = null
  try {
    const rgba = new Uint8ClampedArray(buffer)
    const { luma, gw, gh } = downscaleLuma(rgba, width, height)
    corners = detectCorners(luma, gw, gh, width, height)
  } catch {
    corners = null
  }
  ctx.postMessage({ id, corners })
}

/** Downscale to a ~120px-wide luma grid (nearest-neighbor sample), mirroring
 *  QuadDetector.kt#enqueue's Y-plane downscale loop exactly in shape —
 *  `iy = y*imgH/gh`, `ix = x*imgW/gw` — but sourced from RGBA here. */
function downscaleLuma(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
): { luma: Uint8ClampedArray; gw: number; gh: number } {
  const gw = DOWNSCALE_WIDTH
  const gh = Math.max(1, Math.floor((DOWNSCALE_WIDTH * imgH) / imgW))
  const luma = new Uint8ClampedArray(gw * gh)
  for (let y = 0; y < gh; y++) {
    const iy = Math.min(imgH - 1, Math.floor((y * imgH) / gh))
    for (let x = 0; x < gw; x++) {
      const ix = Math.min(imgW - 1, Math.floor((x * imgW) / gw))
      const p = (iy * imgW + ix) * 4
      const r = rgba[p] as number
      const g = rgba[p + 1] as number
      const b = rgba[p + 2] as number
      luma[y * gw + x] = 0.299 * r + 0.587 * g + 0.114 * b
    }
  }
  return { luma, gw, gh }
}

/** Sobel magnitude -> mean+1.5σ threshold -> largest 8-connected edge
 *  component -> convex hull -> farthest-point 4-corner reduction. Returns
 *  the four corners in full image pixels (grid cell centers rescaled), or
 *  null if no usable quad blob was found. Direct port of
 *  QuadDetector.kt#detectCorners. */
function detectCorners(
  luma: Uint8ClampedArray,
  w: number,
  h: number,
  imgW: number,
  imgH: number,
): [number, number][] | null {
  if (w < 3 || h < 3) return null

  // Sobel gradient magnitude (|gx| + |gy|) over the interior.
  const mag = new Int32Array(w * h)
  let sum = 0
  let sumSq = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const tl = luma[i - w - 1] as number
      const tc = luma[i - w] as number
      const tr = luma[i - w + 1] as number
      const ml = luma[i - 1] as number
      const mr = luma[i + 1] as number
      const bl = luma[i + w - 1] as number
      const bc = luma[i + w] as number
      const br = luma[i + w + 1] as number
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl)
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr)
      const m = Math.abs(gx) + Math.abs(gy)
      mag[i] = m
      sum += m
      sumSq += m * m
    }
  }
  const n = (w - 2) * (h - 2)
  if (n <= 0) return null
  const mean = sum / n
  const variance = Math.max(sumSq / n - mean * mean, 0)
  const threshold = mean + EDGE_SIGMA * Math.sqrt(variance)

  // Largest 8-connected edge component (flood fill with an explicit stack —
  // no recursion, matching the Kotlin implementation's stack discipline).
  const labels = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  const comp = new Int32Array(w * h)
  let best = new Int32Array(0)
  let label = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const start = y * w + x
      if (labels[start] !== 0 || (mag[start] as number) <= threshold) continue
      label += 1
      let sp = 0
      stack[sp++] = start
      labels[start] = label
      let count = 0
      while (sp > 0) {
        const p = stack[--sp] as number
        comp[count++] = p
        const px = p % w
        const py = (p / w) | 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = px + dx
            const ny = py + dy
            if (nx >= 1 && nx < w - 1 && ny >= 1 && ny < h - 1) {
              const np = ny * w + nx
              if (labels[np] === 0 && (mag[np] as number) > threshold) {
                labels[np] = label
                stack[sp++] = np
              }
            }
          }
        }
      }
      if (count > best.length) best = comp.slice(0, count)
    }
  }
  if (best.length < MIN_COMPONENT) return null

  const hull = convexHull(best, w)
  if (!hull || hull.length < 4) return null
  const quad = reduceToQuad(hull)
  if (!quad) return null

  // Grid cell centers -> full image pixels.
  return quad.map(([gx, gy]) => [((gx + 0.5) * imgW) / w, ((gy + 0.5) * imgH) / h])
}

/** Andrew's monotone-chain convex hull of the component pixels (CCW). */
function convexHull(pixels: Int32Array, w: number): [number, number][] | null {
  const pts: [number, number][] = []
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i] as number
    pts.push([p % w, (p / w) | 0])
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return null

  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const hull: [number, number][] = []
  for (const p of pts) {
    while (hull.length >= 2 && cross(hull[hull.length - 2] as [number, number], hull[hull.length - 1] as [number, number], p) <= 0) {
      hull.pop()
    }
    hull.push(p)
  }
  const lower = hull.length + 1
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as [number, number]
    while (hull.length >= lower && cross(hull[hull.length - 2] as [number, number], hull[hull.length - 1] as [number, number], p) <= 0) {
      hull.pop()
    }
    hull.push(p)
  }
  hull.pop() // drop the repeated start point
  return hull
}

/** Reduce a convex hull to the four vertices spanning the largest quad via
 *  farthest-point selection: p0 farthest from the centroid, p2 farthest from
 *  p0, then p1/p3 the extreme points either side of the p0->p2 diagonal. */
function reduceToQuad(
  hull: [number, number][],
): [[number, number], [number, number], [number, number], [number, number]] | null {
  if (hull.length < 4) return null
  let cx = 0
  let cy = 0
  for (const [x, y] of hull) {
    cx += x
    cy += y
  }
  cx /= hull.length
  cy /= hull.length

  const sq = (dx: number, dy: number): number => dx * dx + dy * dy

  let p0 = hull[0] as [number, number]
  let maxD0 = -Infinity
  for (const p of hull) {
    const d = sq(p[0] - cx, p[1] - cy)
    if (d > maxD0) {
      maxD0 = d
      p0 = p
    }
  }

  let p2 = hull[0] as [number, number]
  let maxD2 = -Infinity
  for (const p of hull) {
    const d = sq(p[0] - p0[0], p[1] - p0[1])
    if (d > maxD2) {
      maxD2 = d
      p2 = p
    }
  }

  const crossD = (o: [number, number], a: [number, number], p: [number, number]): number =>
    (a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0])

  let p1: [number, number] | null = null
  let p3: [number, number] | null = null
  let maxPos = 0
  let maxNeg = 0
  for (const p of hull) {
    const d = crossD(p0, p2, p)
    if (d > maxPos) {
      maxPos = d
      p1 = p
    }
    if (d < maxNeg) {
      maxNeg = d
      p3 = p
    }
  }
  if (!p1 || !p3) return null
  if (samePoint(p0, p2) || samePoint(p1, p3)) return null

  // p1 and p3 sit on opposite sides of the diagonal, so p0 -> p1 -> p2 -> p3
  // is a simple (non-self-intersecting) quad.
  return [p0, p1, p2, p3]
}

function samePoint(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1]
}
