// ar/homography.ts — 4-point DLT planar homography, no dependencies.
//
// Native reference: PinballGenieAndroid/.../ar/PlayfieldCalibration.kt maps
// normalized playfield (u,v) to the four tapped corners via BILINEAR mixing
// in 3D world space — ARCore anchors/raycasting own the perspective there,
// so a straight bilinear blend of the anchors' world positions is enough;
// the view-projection matrix does the actual perspective projection to
// screen every frame (see ArSessionManager.kt's FrameGeometry.project).
//
// The web has no camera pose/anchor system, just a flat video image, so this
// port instead solves a full 2D projective transform (homography) from the
// unit playfield square straight to the on-screen quad — the standard
// computer-vision analog for a flat surface viewed under perspective, and
// mathematically the right generalization of what the bilinear-in-3D +
// projection pipeline achieves on native. Corner semantics are ported
// exactly: v=0 at the FLIPPER edge, tap order BL, BR, TR, TL
// (ArSessionManager.kt / PlayfieldCalibration.kt).

import type { MapFn } from '../models'

export type H = number[] // row-major 3x3, h[8] === 1 by construction

/** Solve A x = b (n x n) via Gauss-Jordan elimination with partial pivoting.
 *  No external deps — used only for the 8x8 system below. */
function solveLinearSystem(a: number[][], b: number[]): number[] {
  const n = b.length
  const m: number[][] = a.map((row, i) => [...row, b[i] as number])

  for (let col = 0; col < n; col++) {
    let pivotRow = col
    let maxAbs = Math.abs(m[col]?.[col] ?? 0)
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r]?.[col] ?? 0)
      if (v > maxAbs) {
        maxAbs = v
        pivotRow = r
      }
    }
    if (maxAbs < 1e-12) {
      throw new Error('computeHomography: singular system — corners are degenerate or collinear')
    }
    if (pivotRow !== col) {
      const tmp = m[col] as number[]
      m[col] = m[pivotRow] as number[]
      m[pivotRow] = tmp
    }
    const row = m[col] as number[]
    const pivot = row[col] as number
    for (let c = col; c <= n; c++) row[c] = (row[c] as number) / pivot
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const other = m[r] as number[]
      const factor = other[col] as number
      if (factor === 0) continue
      for (let c = col; c <= n; c++) other[c] = (other[c] as number) - factor * (row[c] as number)
    }
  }
  return m.map((row) => row[n] as number)
}

/**
 * 4-point DLT: builds the 8x8 linear system for a projective homography
 * (h9 fixed to 1) mapping each src[i] -> dst[i] exactly, and solves it via
 * Gaussian elimination with partial pivoting.
 */
export function computeHomography(src: [number, number][], dst: [number, number][]): H {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error('computeHomography: exactly 4 point correspondences required')
  }
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] as [number, number]
    const [X, Y] = dst[i] as [number, number]
    // h33 = 1, so each correspondence contributes two rows:
    //   h11 x + h12 y + h13 - h31 x X - h32 y X = X
    //   h21 x + h22 y + h23 - h31 x Y - h32 y Y = Y
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X])
    b.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y])
    b.push(Y)
  }
  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinearSystem(A, b)
  return [h11, h12, h13, h21, h22, h23, h31, h32, 1] as H
}

/** Apply H to a point, with perspective divide. */
export function applyH(h: H, x: number, y: number): { x: number; y: number } {
  const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number)
  return {
    x: ((h[0] as number) * x + (h[1] as number) * y + (h[2] as number)) / w,
    y: ((h[3] as number) * x + (h[4] as number) * y + (h[5] as number)) / w,
  }
}

/** (u,v) -> CSS px through H. u: 0->1 left->right; v: 0 at the FLIPPER edge. */
export function makeMapFn(h: H): MapFn {
  return (u: number, v: number) => applyH(h, u, v)
}

/**
 * Self-check for the integrator: builds H from a known, non-degenerate
 * perspective quad and asserts every unit-square corner maps back through H
 * to its target within 1e-6. A 4-point DLT has exactly as many equations as
 * unknowns (8), so a correct solver reproduces the inputs to floating-point
 * precision on any well-conditioned input — a larger error means the solver
 * (or its call site) is broken. Call this once at startup/in a smoke test;
 * it does no I/O and has no side effects.
 */
export function homographySelfTest(): boolean {
  const src: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  // An arbitrary, clearly-non-affine (real perspective, unequal side ratios)
  // quad in BL, BR, TR, TL order so the test also catches a missing
  // perspective divide, not just an affine-only solve.
  const dst: [number, number][] = [
    [120, 640],
    [700, 660],
    [660, 60],
    [140, 40],
  ]
  const h = computeHomography(src, dst)
  let maxError = 0
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i] as [number, number]
    const [ex, ey] = dst[i] as [number, number]
    const p = applyH(h, sx, sy)
    maxError = Math.max(maxError, Math.abs(p.x - ex), Math.abs(p.y - ey))
  }
  if (maxError >= 1e-6) {
    console.error(`homographySelfTest: round-trip error ${maxError} >= 1e-6`)
    return false
  }
  return true
}
