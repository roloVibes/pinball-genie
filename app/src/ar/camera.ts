// ar/camera.ts — getUserMedia camera layer.
//
// No single native source file: ARCore (ArSessionManager.kt) and AVFoundation
// own the camera pipeline on-device end-to-end. This is a behavioral port of
// the parts that matter for parity with ArSessionManager.kt's resume()/pause()
// session lifecycle — environment-facing capture, and rebuilding the stream
// after the OS silently kills it while backgrounded — adapted to the web's
// getUserMedia + Page Visibility API (there is no ARCore session to resume;
// the closest web analog is re-acquiring the MediaStream).
// See CONTRACTS.md ("ar/camera.ts") for the CameraFeed contract implemented here.

export type CameraState = 'live' | 'suspended' | 'stopped' | 'error'

export interface CameraFeed {
  video: HTMLVideoElement // playsinline muted autoplay, object-fit cover
  start(): Promise<void> // must be called from a user gesture
  stop(): void
  onStateChange(fn: (s: CameraState, err?: Error) => void): () => void
  grabFrame(maxDim?: number): { canvas: HTMLCanvasElement; scaleToVideo: number }
}

const DEFAULT_MAX_DIM = 640

export function createCameraFeed(): CameraFeed {
  const video = document.createElement('video')
  // Both the IDL properties and the attribute form are set: iOS Safari has a
  // long history of only honoring the attribute form of playsinline/muted
  // when it's present before the stream attaches.
  video.playsInline = true
  video.muted = true
  video.autoplay = true
  video.setAttribute('playsinline', '')
  video.setAttribute('muted', '')
  video.setAttribute('autoplay', '')
  video.style.width = '100%'
  video.style.height = '100%'
  video.style.objectFit = 'cover'

  let stream: MediaStream | null = null
  let state: CameraState = 'stopped'
  let lastError: Error | undefined
  let starting = false
  let frameCanvas: HTMLCanvasElement | null = null
  const listeners = new Set<(s: CameraState, err?: Error) => void>()

  function setState(s: CameraState, err?: Error): void {
    state = s
    lastError = s === 'error' ? err : undefined
    for (const fn of listeners) fn(s, err)
  }

  function stopTracks(): void {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }

  async function openStream(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    }
    const s = await navigator.mediaDevices.getUserMedia(constraints)
    stopTracks()
    stream = s
    video.srcObject = s
    try {
      await video.play()
    } catch {
      // play() can transiently reject right after getUserMedia resolves even
      // inside a user-gesture call chain (autoplay-policy timing quirks);
      // the stream is live regardless and playback proceeds on its own.
    }
    // One-shot per acquired track (not per stream lifetime — a fresh
    // listener attaches on every openStream(), including rebuilds): the OS
    // can kill the underlying track (phone call / another app claims the
    // camera / device unplugged) while the PAGE stays visible, which the
    // video element's own 'ended' handler alone can't distinguish from a
    // background suspend. Rebuild immediately if we're still on-screen;
    // otherwise fall back to 'suspended' and let the existing
    // visibilitychange path rebuild on return (mirrors handleVisibilityChange
    // — never race a second concurrent (re)acquire).
    const track = s.getVideoTracks()[0]
    track?.addEventListener(
      'ended',
      () => {
        if (state !== 'live') return
        if (document.visibilityState === 'visible') {
          setState('suspended')
          void restart()
        } else {
          setState('suspended')
        }
      },
      { once: true },
    )
    setState('live')
  }

  /** Shared by start() and the visibility-driven rebuild so concurrent
   *  attempts to (re)acquire the camera never race each other. Also a no-op
   *  when the stream is already live: ar/arview.ts's identify phase now
   *  starts the camera itself (before ar/calibrate.ts ever mounts, so OCR
   *  can grab frames during identify/match), and ar/calibrate.ts's own
   *  constructor unconditionally calls start() too — without this guard,
   *  entering calibrate would silently tear down and reacquire an
   *  already-live stream (visible flash, wasted work) every time. */
  async function restart(): Promise<void> {
    if (starting || state === 'live') return
    starting = true
    try {
      await openStream()
    } catch (e) {
      // NotAllowedError (permission denied) / NotFoundError (no camera) /
      // NotReadableError (device busy) all land here as typed DOMExceptions;
      // `err.name` lets the caller (calibrate.ts) show the right copy.
      const err = e instanceof Error ? e : new Error(String(e))
      setState('error', err)
      throw err
    } finally {
      starting = false
    }
  }

  function isStreamDead(): boolean {
    return !stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      if (state === 'live') setState('suspended')
      return
    }
    // Returning to the foreground: iOS Safari kills the camera stream while
    // backgrounded with no reliable event while hidden to observe it, so the
    // only place to detect and rebuild it is here, on the way back.
    if ((state === 'live' || state === 'suspended') && isStreamDead()) {
      void restart()
    } else if (state === 'suspended') {
      setState('live')
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  function handleVideoEnded(): void {
    if (state === 'live') setState('suspended')
  }
  video.addEventListener('ended', handleVideoEnded)

  return {
    video,
    start: restart,
    // Terminal in every real call path — arview.ts always discards the whole
    // CameraFeed after stop() and builds a new one via createCameraFeed()
    // rather than reusing it (see arview.ts's stopCamera()) — so detaching
    // the document/video listeners here can never strand a feed callers
    // expect to keep using.
    stop(): void {
      stopTracks()
      video.srcObject = null
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      video.removeEventListener('ended', handleVideoEnded)
      setState('stopped')
    },
    // Replays the CURRENT state synchronously to a new subscriber before
    // returning: a second createCalibrationUI() mounted over an
    // already-live feed (RECALIBRATE, switchMachine) previously started
    // from calibrate.ts's own `cameraState = 'stopped'` default and never
    // learned otherwise, because restart()'s `state === 'live'` guard
    // (see the comment above it) makes its own void feed.start() call a
    // silent no-op that emits nothing — the HUD stayed stuck on "Starting
    // camera…" forever. Replaying here means every subscriber's first
    // observation always matches reality, live feed or not.
    onStateChange(fn): () => void {
      listeners.add(fn)
      fn(state, lastError)
      return () => listeners.delete(fn)
    },
    // Downscaled, on-demand only — never called from a per-rAF-frame hot
    // loop; callers (quaddetect via calibrate.ts, the tracker) throttle their
    // own polling cadence. No getImageData happens in here at all — this
    // only draws; callers pull pixels from the returned canvas themselves.
    grabFrame(maxDim = DEFAULT_MAX_DIM) {
      const vw = video.videoWidth || 1
      const vh = video.videoHeight || 1
      const longest = Math.max(vw, vh)
      const scale = longest > maxDim ? maxDim / longest : 1
      const cw = Math.max(1, Math.round(vw * scale))
      const ch = Math.max(1, Math.round(vh * scale))
      if (!frameCanvas) frameCanvas = document.createElement('canvas')
      if (frameCanvas.width !== cw) frameCanvas.width = cw
      if (frameCanvas.height !== ch) frameCanvas.height = ch
      const ctx = frameCanvas.getContext('2d')
      if (!ctx) throw new Error('grabFrame: 2D context unavailable')
      ctx.drawImage(video, 0, 0, cw, ch)
      return { canvas: frameCanvas, scaleToVideo: vw / cw }
    },
  }
}
