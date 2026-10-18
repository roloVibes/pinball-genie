// ar/tracker.ts — main-thread wrapper around tracker.worker.ts.
//
// No single native source file to port: ARCore (Android, ArSessionManager.kt)
// and ARKit (iOS) provide 6-DoF SLAM world-tracking natively — that's what
// keeps the calibrated overlay glued to the playfield as the phone moves;
// see ArSessionManager.kt's per-frame FrameGeometry (anchor poses + the
// view/projection matrix, onDrawFrame). The browser has no such API, so this
// module fills the same ROLE with a SELF-REFERENCING 2D keyframe tracker
// instead: an immutable set of Shi-Tomasi corners detected inside the
// calibrated quad at calibration time (the "keyframe") is tracked
// frame-to-frame with Lucas-Kanade optical flow and fit to a homography
// (keyframe px -> live-frame px) every frame via RANSAC. No reference
// images/markers, matching the product's constraints. See CONTRACTS.md
// ("ar/tracker.ts") for the exported shape, and tracker.worker.ts for the
// actual OpenCV.js pipeline (runs off the main thread).
//
// RPC pattern (id-based pending map, transferable ArrayBuffers, terminate()
// on destroy) matches the sibling ar/quaddetect.ts wrapper for consistency.

import type { H } from './homography'

export interface Tracker {
  init(keyframe: ImageData, quad: [number, number][]): Promise<boolean>
  track(frame: ImageData): Promise<{ h: H | null; inliers: number; fps: number }>
  destroy(): void
}

interface InitRequest {
  type: 'init'
  id: number
  buffer: ArrayBuffer // keyframe.data.buffer (RGBA8, tightly packed), transferred
  width: number
  height: number
  quad: [number, number][] // keyframe px, BL/BR/TR/TL (calibrate.ts tap order)
}

interface TrackRequest {
  type: 'track'
  id: number
  buffer: ArrayBuffer // frame.data.buffer (RGBA8, tightly packed), transferred
  width: number
  height: number
}

type WorkerRequest = InitRequest | TrackRequest

interface InitResponse {
  type: 'init'
  id: number
  ok: boolean
}

interface TrackResponse {
  type: 'track'
  id: number
  h: number[] | null // row-major 3x3, keyframe px -> frame px, or null
  inliers: number
  fps: number
}

type WorkerResponse = InitResponse | TrackResponse

// Generous: the worker's first 'init' load pulls in the 10.3MB OpenCV.js
// chunk, which can take a while on slow arcade Wi-Fi — this is a ceiling on
// a genuinely-stuck load, not a normal-case budget.
const INIT_TIMEOUT_MS = 30_000
// Per-frame; the live loop calls track() every rAF, so a hang here must
// resolve fast enough that the caller's own tracking-lost/STATIC UI (which
// keys off res.h === null) kicks in within about a frame budget of stalls,
// not seconds.
const TRACK_TIMEOUT_MS = 5_000

const INIT_FALLBACK: InitResponse = { type: 'init', id: -1, ok: false }
const TRACK_FALLBACK: Omit<TrackResponse, 'id'> = { type: 'track', h: null, inliers: 0, fps: 0 }

interface Pending {
  resolve: (res: WorkerResponse) => void
  fallback: WorkerResponse
  timer: ReturnType<typeof setTimeout> | null
}

export function createTracker(): Tracker {
  const worker = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' })

  let nextId = 1
  let destroyed = false
  let dead = false // set by worker.onerror/onmessageerror: worker is unusable, but not yet destroy()ed
  let trackInFlight = false
  let lastFps = 0
  const pending = new Map<number, Pending>()

  /** Resolves and removes one pending entry — used by the real onmessage
   *  path, per-request timeouts, and the worker-death handlers below, so
   *  there's exactly one place that clears a pending entry's timer. */
  function settle(id: number, res: WorkerResponse): void {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (p.timer !== null) clearTimeout(p.timer)
    p.resolve(res)
  }

  /** worker.onerror / onmessageerror: settle every in-flight call with its
   *  fallback and mark the tracker dead so send() stops posting to a worker
   *  that's already crashed (later calls resolve immediately with their
   *  fallback instead of hanging behind a dead Worker). */
  function killWorker(): void {
    if (dead) return
    dead = true
    for (const [id, p] of pending) {
      if (p.timer !== null) clearTimeout(p.timer)
      p.resolve(p.fallback)
    }
    pending.clear()
  }
  worker.onerror = () => killWorker()
  worker.onmessageerror = () => killWorker()

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    settle(ev.data.id, ev.data)
  }

  function send(req: WorkerRequest, transfer: Transferable[], timeoutMs: number, fallback: WorkerResponse): Promise<WorkerResponse> {
    if (dead) return Promise.resolve(fallback)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Never reject — callers already treat a falsy/ok:false result as
        // failure, so a timeout is just another way to produce that result.
        pending.delete(req.id)
        resolve(fallback)
      }, timeoutMs)
      pending.set(req.id, { resolve, fallback, timer })
      worker.postMessage(req, transfer)
    })
  }

  return {
    async init(keyframe, quad) {
      if (destroyed || dead) return false
      const id = nextId++
      // Transferable, zero-copy — matches ar/quaddetect.ts's convention:
      // `keyframe` must not be reused by the caller after this call.
      const buffer = keyframe.data.buffer
      const res = (await send(
        { type: 'init', id, buffer, width: keyframe.width, height: keyframe.height, quad },
        [buffer],
        INIT_TIMEOUT_MS,
        { ...INIT_FALLBACK, id },
      )) as InitResponse
      return res.ok
    },

    async track(frame) {
      if (destroyed || dead) return { h: null, inliers: 0, fps: lastFps }
      // Frame dropping, never queue: a track() call while one is already in
      // flight resolves null immediately instead of piling up behind the
      // worker — a homography computed from a stale, superseded frame is
      // worse than simply skipping this frame's overlay update.
      if (trackInFlight) return { h: null, inliers: 0, fps: lastFps }
      trackInFlight = true
      try {
        const id = nextId++
        const buffer = frame.data.buffer // zero-copy transfer; do not reuse `frame` afterward
        const res = (await send(
          { type: 'track', id, buffer, width: frame.width, height: frame.height },
          [buffer],
          TRACK_TIMEOUT_MS,
          { ...TRACK_FALLBACK, id, fps: lastFps },
        )) as TrackResponse
        lastFps = res.fps
        return { h: res.h, inliers: res.inliers, fps: res.fps }
      } finally {
        trackInFlight = false
      }
    },

    destroy() {
      destroyed = true
      // Settle every in-flight promise with its fallback before dropping the
      // map — without this, an in-flight init()/track() awaited by arview.ts
      // (e.g. sessionGen changed mid-await) never resolves at all, stranding
      // that continuation forever even though nothing is actually broken.
      for (const [, p] of pending) {
        if (p.timer !== null) clearTimeout(p.timer)
        p.resolve(p.fallback)
      }
      pending.clear()
      worker.terminate()
    },
  }
}
