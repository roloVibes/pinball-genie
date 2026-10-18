// app/tests/harness/tracker.stub.ts — drop-in stand-in for src/ar/tracker.ts,
// substituted at bundle time ONLY for the SUITE 4 browser harness (see
// ../arview-statemachine.e2e.py). src/ar/tracker.ts itself is never modified.
//
// Why stub it at all: the real tracker spawns a module Worker that pulls in
// @techstark/opencv-js (~10 MB wasm) — unusable inside a single-file esbuild
// IIFE bundle, and its timing is exactly the variable this suite needs to
// CONTROL, not observe. Each mode below models a state the REAL tracker.ts +
// tracker.worker.ts provably reach:
//
//   'ok'    -> init resolves true (normal path).
//   'slow'  -> init resolves true after window.__trackerInitDelayMs.
//              Models the real first-calibration path: tracker.worker.ts's
//              handleInit() starts with `await ensureCv()` (line 439), i.e.
//              it does not answer until OpenCV.js's ~10 MB payload has
//              downloaded + initialized. ui/howto.ts step 1 tells users this
//              takes "a moment ... on arcade Wi-Fi".
//   'hang'  -> init never settles. Models an ensureCv() REJECTION: worker
//              line 566 is `void handleInit(req).then((res) => ctx.postMessage(res))`
//              with no .catch, and tracker.ts registers no worker.onerror,
//              so a failed OpenCV load posts nothing back and the
//              main-thread promise in tracker.ts's init() never settles.
//   'false' -> init resolves false (worker answered ok:false).
//
// Call/destroy bookkeeping is exposed on window.__trackerLog so the suite can
// prove tracker leaks (createTracker() without a matching destroy()).

import type { H } from '../../src/ar/homography'

export interface Tracker {
  init(keyframe: ImageData, quad: [number, number][]): Promise<boolean>
  track(frame: ImageData): Promise<{ h: H | null; inliers: number; fps: number }>
  destroy(): void
}

interface TrackerLog {
  created: number
  destroyed: number
  initCalls: number
  liveInstances: number
}

declare global {
  interface Window {
    __trackerMode?: 'ok' | 'slow' | 'hang' | 'false'
    __trackerInitDelayMs?: number
    // B6 coverage (2026-07-28 addition): lets a test drive track()'s
    // per-frame inlier count so it can exercise arview.ts's
    // TRACKER_MIN_INLIERS gate (currently 8) behaviorally — set below the
    // gate to prove a thin fit is treated like h:null (falls back to
    // lastGoodTrackerH), at/above it to prove a fit that clears the gate is
    // accepted. Defaults to 40 (comfortably above the gate) so every
    // existing test that never touches this knob keeps seeing a healthy,
    // trusted track() result.
    __trackerInliers?: number
    __trackerLog: TrackerLog
  }
}

window.__trackerLog = { created: 0, destroyed: 0, initCalls: 0, liveInstances: 0 }

export function createTracker(): Tracker {
  window.__trackerLog.created += 1
  window.__trackerLog.liveInstances += 1
  let destroyed = false
  return {
    init(): Promise<boolean> {
      window.__trackerLog.initCalls += 1
      const mode = window.__trackerMode ?? 'ok'
      if (mode === 'hang') return new Promise<boolean>(() => {})
      if (mode === 'false') return Promise.resolve(false)
      if (mode === 'slow') {
        return new Promise<boolean>((resolve) =>
          window.setTimeout(() => resolve(!destroyed), window.__trackerInitDelayMs ?? 1500),
        )
      }
      return Promise.resolve(true)
    },
    track(): Promise<{ h: H | null; inliers: number; fps: number }> {
      const inliers = window.__trackerInliers ?? 40
      return Promise.resolve({ h: [1, 0, 0, 0, 1, 0, 0, 0, 1] as H, inliers, fps: 30 })
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      window.__trackerLog.destroyed += 1
      window.__trackerLog.liveInstances -= 1
    },
  }
}
