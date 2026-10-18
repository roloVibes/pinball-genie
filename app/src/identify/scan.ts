// PinballGenieWeb — identify/scan.ts
//
// One-shot camera machine-ID scan UI. Ports the *shape* of
//   com.rolo.pinballgenie.identify.MachineIdentifier.kt (MachineScanner class)
//   com.rolo.pinballgenie.identify.IdentifySheet.kt (sheet copy/UX states)
// per PinballARPipeline/specs/SPEC-MACHINE-ID.md — but NOT the continuous
// ≤2Hz-with-hit-counter scan loop those files drive: the web contract
// (CONTRACTS.md) is one-shot. The user frames the machine's title inside a
// crop guide and taps Scan; that grabs a single frame, crops it to the
// CENTER 60%x30%, runs one self-hosted Tesseract.js OCR pass, folds the
// recognized text into an uppercase word set (identify/matcher.ts#ocrWordSet)
// and resolves with matchMachines()'s top hit — or null on no-match, OCR
// error, or the 10s timeout. Native's honest-limits copy ("reads the printed
// title; glare/angle can defeat it") and its "Can't read the machine — pick
// it below" timeout copy are reused verbatim where they still apply.
//
// Tesseract MUST be fully self-hosted (the app sits behind auth; zero CDN
// requests at runtime — CONTRACTS.md "Rules"): workerPath/corePath/langPath
// all point at /vendor/tesseract/, populated by scripts/prepare-vendor.mjs.

import { createWorker } from 'tesseract.js'
import type { Machine } from '../models'
import { matchMachines, ocrWordSet } from './matcher'

/** The minimal camera surface this module needs (see ar/camera.ts's
 *  `CameraFeed` in CONTRACTS.md — a structural subset so this file doesn't
 *  have to depend on that module's file directly). */
export interface ScanCameraFeed {
  grabFrame(maxDim?: number): { canvas: HTMLCanvasElement; scaleToVideo: number }
}

export type ScanStatus =
  | 'idle' // waiting for the user to tap Scan
  | 'loading' // first run only: booting the Tesseract core + downloading/reading the cached language data
  | 'recognizing' // OCR running on the cropped frame
  | 'matched' // resolved with a Machine
  | 'no-match' // OCR ran; nothing in the catalog fully matched
  | 'timeout' // 10s elapsed with no result
  | 'error' // camera/OCR threw

export interface ScanProgress {
  status: ScanStatus
  /** 0..1 where Tesseract reports it (during 'loading'/'recognizing'); omitted otherwise. */
  progress?: number
}

export interface ScanHandle {
  /** Resolves exactly once, after the user's tap runs OCR: the best
   *  catalog match, or null (no match / timeout / error / destroyed
   *  before a tap ever completed). */
  result: Promise<Machine | null>
  /** Tears down the mounted UI. Resolves `result` with null if a scan
   *  hadn't already settled. Safe to call more than once. */
  destroy(): void
}

const TIMEOUT_MS = 10_000
const CROP_WIDTH_FRACTION = 0.6
const CROP_HEIGHT_FRACTION = 0.3
const OCR_MAX_DIM = 1600

// A single Tesseract worker is created lazily and kept warm for the page's
// lifetime (module-level cache): the wasm core + English traineddata are a
// few MB, and re-instantiating them on every scan would make repeat scans
// noticeably slower for no benefit. `activeProgressSink` lets whichever
// mountIdentifyScan() call is currently running forward that shared
// worker's logger callbacks to *its* UI/onProgress — safe because only one
// identify UI is ever open at a time (mirrors native: a single IdentifySheet).
let sharedWorkerInit: ReturnType<typeof createWorker> | null = null
let activeProgressSink: ((p: ScanProgress) => void) | null = null

function ensureWorker() {
  if (!sharedWorkerInit) {
    sharedWorkerInit = createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract/',
      langPath: '/vendor/tesseract/',
      gzip: true,
      logger: (m) => {
        activeProgressSink?.({
          status: m.status === 'recognizing text' ? 'recognizing' : 'loading',
          progress: m.progress,
        })
      },
    })
  }
  return sharedWorkerInit
}

/** Crops the CENTER 60%x30% out of `source` into a new canvas. */
function centerCrop(source: HTMLCanvasElement): HTMLCanvasElement {
  const cropWidth = Math.max(1, Math.round(source.width * CROP_WIDTH_FRACTION))
  const cropHeight = Math.max(1, Math.round(source.height * CROP_HEIGHT_FRACTION))
  const cropX = Math.round((source.width - cropWidth) / 2)
  const cropY = Math.round((source.height - cropHeight) / 2)

  const out = document.createElement('canvas')
  out.width = cropWidth
  out.height = cropHeight
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  ctx.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
  return out
}

const STYLE_ID = 'pg-identify-scan-styles'

function injectStylesOnce(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.pg-scan { position: absolute; inset: 0; pointer-events: none; }
.pg-scan__crop {
  position: absolute; left: 20%; top: 35%; width: 60%; height: 30%;
  border: 2px dashed rgba(242, 169, 59, 0.85); border-radius: 10px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.28);
}
.pg-scan__crop-label {
  position: absolute; left: 50%; bottom: 100%; transform: translate(-50%, -8px);
  white-space: nowrap; font: 600 12px system-ui, sans-serif; letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.85); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}
.pg-scan__panel {
  position: absolute; left: 16px; right: 16px; bottom: 16px; pointer-events: auto;
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px; border-radius: 18px;
  background: rgba(12, 11, 10, 0.82); backdrop-filter: blur(6px);
  font: 14px/1.4 system-ui, sans-serif; color: #fff;
}
.pg-scan__status { margin: 0; font-weight: 600; }
.pg-scan__hint { margin: 0; font-size: 11px; color: rgba(255, 255, 255, 0.45); }
.pg-scan__bar-track {
  height: 4px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, 0.15);
}
.pg-scan__bar {
  height: 100%; width: 0%; background: #f2a93b; transition: width 120ms linear;
}
.pg-scan__button {
  appearance: none; border: none; border-radius: 12px; min-height: 48px;
  padding: 0 16px; font: 700 15px system-ui, sans-serif; color: #1a1200;
  background: linear-gradient(180deg, #f7c15c, #f2a93b); cursor: pointer;
}
.pg-scan__button:disabled { opacity: 0.55; cursor: default; }
`
  document.head.appendChild(style)
}

const COPY = {
  idle: "Point the camera at the machine’s backglass or apron, then tap Scan.",
  loading: 'Loading the reader…',
  recognizing: 'Reading the title…',
  matched: (shortTitle: string) => `This looks like ${shortTitle}.`,
  noMatch: "Couldn't read a match — pick the machine below.",
  timeout: "Can't read the machine — pick it below.",
  error: 'Scan failed — pick the machine below.',
  hint: "Reads the machine's printed title — glare or a steep angle can defeat it. The full list is always one tap away.",
  cropLabel: 'Frame the machine title',
} as const

/**
 * Mounts a one-shot identify scan UI into `host`: a crop guide over the
 * center 60%x30% of the frame plus a "frame the machine title" label, and a
 * tap-to-scan button/status panel. `host` should already sit over the live
 * camera preview (this module only ever asks `feed` for still frames — it
 * does not render video itself). Tapping Scan is a single, non-repeatable
 * action: `result` settles once, after that tap's OCR pass completes,
 * errors, or times out at 10s.
 */
export function mountIdentifyScan(
  host: HTMLElement,
  feed: ScanCameraFeed,
  machines: Machine[],
  onProgress?: (p: ScanProgress) => void,
): ScanHandle {
  injectStylesOnce()
  if (getComputedStyle(host).position === 'static') {
    host.style.position = 'relative'
  }

  const root = document.createElement('div')
  root.className = 'pg-scan'

  const crop = document.createElement('div')
  crop.className = 'pg-scan__crop'
  const cropLabel = document.createElement('div')
  cropLabel.className = 'pg-scan__crop-label'
  cropLabel.textContent = COPY.cropLabel
  crop.appendChild(cropLabel)

  const status = document.createElement('p')
  status.className = 'pg-scan__status'
  status.textContent = COPY.idle

  const barTrack = document.createElement('div')
  barTrack.className = 'pg-scan__bar-track'
  barTrack.style.display = 'none'
  const bar = document.createElement('div')
  bar.className = 'pg-scan__bar'
  barTrack.appendChild(bar)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'pg-scan__button'
  button.textContent = 'Scan'

  const hint = document.createElement('p')
  hint.className = 'pg-scan__hint'
  hint.textContent = COPY.hint

  const panel = document.createElement('div')
  panel.className = 'pg-scan__panel'
  panel.append(status, barTrack, button, hint)

  root.append(crop, panel)
  host.appendChild(root)

  let settled = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let resolveResult!: (m: Machine | null) => void
  const result = new Promise<Machine | null>((resolve) => {
    resolveResult = resolve
  })

  const report = (p: ScanProgress): void => {
    if (typeof p.progress === 'number') {
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, p.progress)) * 100)}%`
    }
    status.textContent = p.status === 'loading' ? COPY.loading : COPY.recognizing
    onProgress?.(p)
  }

  const finish = (machine: Machine | null, finalStatus: ScanStatus, message: string): void => {
    if (settled) return
    settled = true
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    if (activeProgressSink === report) activeProgressSink = null
    barTrack.style.display = 'none'
    status.textContent = message
    button.disabled = true
    onProgress?.({ status: finalStatus })
    resolveResult(machine)
  }

  const runScan = async (): Promise<void> => {
    activeProgressSink = report
    status.textContent = COPY.recognizing
    barTrack.style.display = ''
    bar.style.width = '0%'
    onProgress?.({ status: 'recognizing' })

    timeoutHandle = setTimeout(() => finish(null, 'timeout', COPY.timeout), TIMEOUT_MS)

    try {
      const { canvas } = feed.grabFrame(OCR_MAX_DIM)
      const cropped = centerCrop(canvas)
      const worker = await ensureWorker()
      if (settled) return // 10s timeout already fired while the (first-run) worker was still booting
      const { data } = await worker.recognize(cropped)
      if (settled) return
      const words = ocrWordSet(data.text)
      const best = matchMachines(words, machines)[0] ?? null
      if (best) {
        finish(best, 'matched', COPY.matched(best.shortTitle))
      } else {
        finish(null, 'no-match', COPY.noMatch)
      }
    } catch (err) {
      console.error('[identify/scan] OCR failed', err)
      finish(null, 'error', COPY.error)
    }
  }

  button.addEventListener('click', () => {
    if (settled || button.disabled) return
    button.disabled = true
    void runScan()
  })

  const destroy = (): void => {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    if (activeProgressSink === report) activeProgressSink = null
    if (!settled) {
      settled = true
      resolveResult(null)
    }
    root.remove()
  }

  return { result, destroy }
}
