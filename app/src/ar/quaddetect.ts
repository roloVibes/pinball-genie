// ar/quaddetect.ts — main-thread wrapper around quaddetect.worker.ts.
// Native source (same file as the worker port):
//   PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/ar/QuadDetector.kt
//
// The worker ports the pixel-processing half of QuadDetector.kt (Sobel ->
// threshold -> flood fill -> hull -> farthest-point reduction). This file
// ports the VIEW-space half of `takeResult` — `orderCorners` (BL/BR/TR/TL)
// and `isConvex` — which only need the four points, not a viewport, so they
// run cheaply here on the main thread right after the worker responds.
//
// What this file does NOT do: the >= 20%-of-viewport area gate and the
// 5-consecutive-hit stability rule (SPEC-AUTOCAL) live in calibrate.ts,
// which is the only module that knows the real on-screen viewport — this
// wrapper only ever sees frame-local pixel space (per CONTRACTS.md).

export function createQuadDetector(): {
  detect(frame: ImageData): Promise<[number, number][] | null>
  destroy(): void
} {
  const worker = new Worker(new URL('./quaddetect.worker.ts', import.meta.url), { type: 'module' })
  let nextId = 1
  const pending = new Map<number, (v: [number, number][] | null) => void>()

  worker.onmessage = (ev: MessageEvent<{ id: number; corners: [number, number][] | null }>) => {
    const { id, corners } = ev.data
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    if (!corners) {
      resolve(null)
      return
    }
    const ordered = orderCorners(corners)
    resolve(ordered && isConvex(ordered) ? ordered : null)
  }

  return {
    detect(frame: ImageData): Promise<[number, number][] | null> {
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        // Transferable: the underlying buffer moves to the worker with no
        // copy. `frame` must not be reused by the caller after this call.
        const buffer = frame.data.buffer
        worker.postMessage({ id, buffer, width: frame.width, height: frame.height }, [buffer])
      })
    },
    destroy(): void {
      worker.terminate()
      pending.clear()
    },
  }
}

/** Order four VIEW/frame-space points to the tap order BL, BR, TR, TL. Per
 *  SPEC-AUTOCAL / QuadDetector.kt#orderCorners: the two corners below the
 *  centroid (larger Y, nearer the flippers) are the bottom pair; bottom/top
 *  split by X. */
export function orderCorners(pts: [number, number][]): [number, number][] | null {
  if (pts.length !== 4) return null
  const byY = [...pts].sort((a, b) => a[1] - b[1])
  const top = [byY[0] as [number, number], byY[1] as [number, number]].sort((a, b) => a[0] - b[0])
  const bottom = [byY[2] as [number, number], byY[3] as [number, number]].sort((a, b) => a[0] - b[0])
  return [bottom[0] as [number, number], bottom[1] as [number, number], top[1] as [number, number], top[0] as [number, number]]
}

/** Direct port of QuadDetector.kt#isConvex: all four turns of the polygon
 *  must have the same cross-product sign (collinear turns are allowed). */
export function isConvex(p: [number, number][]): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = p[i] as [number, number]
    const b = p[(i + 1) % 4] as [number, number]
    const c = p[(i + 2) % 4] as [number, number]
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    const s = z > 0 ? 1 : z < 0 ? -1 : 0
    if (s !== 0) {
      if (sign === 0) sign = s
      else if (s !== sign) return false
    }
  }
  return true
}

/** Direct port of QuadDetector.kt#quadArea (shoelace formula). Exported for
 *  calibrate.ts's viewport-area gate (SPEC-AUTOCAL: >= 20% of the viewport). */
export function quadArea(p: [number, number][]): number {
  let s = 0
  for (let i = 0; i < 4; i++) {
    const a = p[i] as [number, number]
    const b = p[(i + 1) % 4] as [number, number]
    s += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(s) / 2
}
