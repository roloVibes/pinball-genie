// ar/arview.ts — AR mode composition (integrator-owned; see CONTRACTS.md).
//
// 2026-07-11 field-test fix pass: the AR flow is manual-first. "Start
// camera" goes STRAIGHT to manual 4-corner calibration for the currently
// selected machine — no OCR machine identification, no auto-detect quad
// proposal. Those features (identify/scan.ts, the OCR match card,
// ar/calibrate.ts's auto-detect mode) are deliberately deferred ("not
// features we need yet" — rolo, field test 2026-07-10) and kept ON DISK,
// unimported, so the AR bundle tree-shakes them out entirely (no Tesseract
// chunk, no quaddetect chunk).
//
// Phase machine: idle -> calibrating -> live -> freeze. Every non-idle
// phase shows a header "Exit AR" (✕) button that fully tears down back to
// idle (reuses the same teardown as the settings popover's "Stop camera").
// A camera watchdog (~6s from "Start camera") swaps the phase UI for a
// plain-language error card + Try again/Exit if the camera never reaches
// 'live' (or reports an error before it does) — no infinite spinners.
//
// Design references (unchanged from before this pass — camera/calibrate/
// tracker/freeze contract logic below is preserved verbatim):
//   PinballGenieAndroid/.../ar/ArSessionManager.kt (mode machine: scanning ->
//     calibrated -> tracking; freeze/resume; recalibrate; FPS/quality signal)
//   PinballGenieAndroid/.../ui/ArScreen.kt / CalibrationCard.kt (HUD copy,
//     freeze-button-is-first-class framing, "hold steady" messaging)
//   design/DESIGN-NOTES.md §3 "Design tokens" (glass surface recipe,
//     spacing/radii/type literals, inlined below per its own note: literals,
//     not var(), inside this injected <style> block) and §4 "Component
//     inventory" (header pills, step controls, freeze/recalibrate, sheets,
//     settings toggle/slider, celebrate toast). The design doc's
//     identify/match screens (§2.2-2.3) and its "Scan to identify" row
//     (§2.7) no longer apply to this build.
//
// 2026-07-13 ("remove the BALL AT selector"): the bottom stack's BALL AT
// chip row (design doc's §4 inventory item) is gone — see state.ts's header
// note (`ballPosition` is now a fixed 'any') and app.ts's matching header
// note. The 2D map and AR overlay already draw a goal's route starting from
// its own first-step shot, which made the picker redundant.
//
// Deliberate deviations from the literal design still in effect:
//   - No literal "97% MATCH" confidence math ever existed (matchMachines()
//     doesn't compute one) — moot now that the match card is gone entirely.
//   - "Auto-advance" has no ball-arrival signal to key off (ball tracking
//     is deliberately out of scope — models.ts's own header comment).
//     Implemented as a fixed-interval timer, not a ball-dwell trigger.
//   - Tapping '›' on a goal's last step completes it — restarts the goal at
//     step 1 and keeps auto-advance running (no completion toast/particle
//     burst — celebrations removed 2026-07-28, shotcoach-corrections.md
//     #11), mirroring app.ts's non-AR goal-detail loop-forever behavior,
//     since there's no ball-arrival event to trigger it automatically.
//   - Kept a "Stop camera" control (not in the design mock) in the settings
//     popover — DESIGN-NOTES §5's bottom row is exactly two 50/50 outline
//     buttons (FREEZE/RECALIBRATE); the header's Exit AR (✕) button is the
//     other, more-discoverable way to release the camera from any phase.
//   - Settings gear glyph simplified to plain bars (design uses bars with
//     offset dots); same 36px circular affordance.
//
// ---- Coordinate spaces this file threads together (unchanged) ----
//   (u,v)               playfield-normalized, v=0 at the flipper edge
//   stage px            CSS px inside the calibration stage / live frame
//                        box (both sized identically — see .ar-cal-wrap /
//                        .ar-frame in styles.css — so a homography computed
//                        against one box's rect is valid against the other's)
//   video-intrinsic px  feed.video.videoWidth/videoHeight space
//   keyframe px         the ≤480px-downscaled canvas ar/tracker.ts's
//                        init()/track() operate in (ar/camera.ts's
//                        grabFrame(480))
// calibrationH_keyframe:(u,v) -> keyframe px, frozen at calibration time.
// trackerH (per frame): keyframe px -> CURRENT keyframe-space frame px.
// LIVE mapFn / FREEZE mapFn: unchanged from before this pass — see the
// freeze-contract comment on enterFreeze() below.

import './arview.css'
import type { AppState } from '../state'
import { filterGoalsByBallPosition } from '../state'
import type { Goal, GoalCategory, Machine, MapFn } from '../models'
import type { CameraFeed, CameraState } from './camera'
import { createCameraFeed } from './camera'
import { createCalibrationUI, type Calibration } from './calibrate'
import { computeHomography, applyH, type H } from './homography'
import { createTracker, type Tracker } from './tracker'
import { drawGoalOverlay, drawHaloLabel } from '../overlay/drawing'
import { createSheet, type SheetHandle } from '../ui/sheet'
import { CATEGORY_META, CATEGORY_ORDER, pipsTextWithEmpty } from '../ui/goalMeta'
import { glyphFor } from '../ui/fxGlyphs'

/** Alphabetized COPY of a Machine list for display (design turn t7: machine
 *  pickers list machines by name, case-insensitive) — mirrors app.ts's
 *  sortedByName() (kept as a local copy rather than a shared import so this
 *  file stays self-contained per the header comment above). Never mutates
 *  the input — state.machines must stay in catalog.json's insertion order
 *  so state.ts's machines[0]-is-default logic keeps picking JAWS. */
function sortedByName(machines: Machine[]): Machine[] {
  return [...machines].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

// Tap order BL, BR, TR, TL <-> unit square, v=0 at the FLIPPER edge
// (ar/homography.ts's documented convention; also CONTRACTS.md's).
const UNIT_SQUARE: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const IDENTITY_H: H = [1, 0, 0, 0, 1, 0, 0, 0, 1]

const KEYFRAME_MAX_DIM = 480 // matches ar/tracker.ts's own internal MAX_DIM
const HOLD_STEADY_GRACE_MS = 1000

// Per-frame tracker inlier gate (field-test fix; widened, R4): tracker.
// worker.ts's own RANSAC refuses to even attempt a fit below MIN_SURVIVORS
// (12) point matches, but a legitimate fit against those 12 can still land
// as few as 8-11 RANSAC inliers — the original gate of 10 sat INSIDE that
// legitimate range and was freezing dim-but-tracking sessions into
// permanent 'Tracking lost'. 8 is ~67% consensus of the worker's own
// 12-point minimum fit — enough to reject minority-consensus junk (glass
// reflections, motion blur) without starving dim-light tracking. Below it,
// a frame's res.h is treated as if it were null (falls back to
// lastGoodTrackerH) instead of yanking the overlay off a thin fit.
const TRACKER_MIN_INLIERS = 8

const TRACKING_LOST_TEXT = 'Tracking lost — hold steady, or Recalibrate below.'
// Surfaces the STATIC case honestly (field-test fix): tracker.init()
// returning false used to enter live silently with only the tiny quality
// pill saying "STATIC" — easy to miss, and the overlay never explains
// itself. Mutually exclusive with TRACKING_LOST_TEXT by construction (see
// updateHud() below): the lost banner requires trackingEnabled, this one
// requires !trackingEnabled.
const STATIC_OVERLAY_TEXT = "Static overlay — tracking couldn't start (blur or low light). It won't follow the camera. Recalibrate to retry."

// AR shows the route and nothing else (README §3a / shotcoach-corrections.md
// #1): no goal selected -> no ambient dots, no insert markers, just this
// halo label. drawShotDots is deliberately not called here at all.
const NO_GOAL_HINT_TEXT = 'PICK A GOAL TO DRAW ITS SHOT PATH'
const AR_MONO = `ui-monospace, Menlo, monospace`

// Timing constant (auto-advance) — see the deviations note above for why
// this is a reasonable substitute rather than a literal DESIGN-NOTES value
// (the design simulated a ball-dwell trigger the real product doesn't have —
// no ball tracking). Celebrations (incl. the old CELEBRATE_TOAST_MS) were
// removed 2026-07-28 — shotcoach-corrections.md #11.
const AUTO_ADVANCE_MS = 3500 // no literal spec (ball-dwell driven in the design); a reasonable reading pace

// Camera watchdog (dead-ends fix, field test 2026-07-10): "Start camera"
// jumps straight into calibrating before the stream is confirmed live, so
// there's no bound on how long a stalled getUserMedia() leaves the user
// staring at calibrate.ts's own "Starting camera…" copy. This fires once,
// ~6s after Start, if the feed still hasn't reached 'live' — see
// showCameraError()/armCameraWatchdog() below.
const CAMERA_WATCHDOG_MS = 6000

// One-time GOAL-pill callout (field test: "overlay looks broken" — the
// live view with no goal selected just shows dots, easy to read as broken).
// Shown once ever, right after the first successful calibration, if no goal
// is selected yet.
const GOALPILL_SEEN_KEY = 'pg_goalpill_seen'
const GOALPILL_CALLOUT_MS = 6000

type Phase = 'idle' | 'calibrating' | 'live' | 'freeze'
type SheetId = 'machines' | 'goals' | null

interface ArSettings {
  showLabels: boolean
  autoAdvance: boolean
  lineBrightness: number
}

// ---------------------------------------------------------------------------
// Geometry helpers — replicate ar/calibrate.ts's private object-fit:cover
// math (video-intrinsic px <-> stage/display CSS px). Not exported by that
// module (only Calibration's corners, already in display px, cross the
// module boundary), so this is a small, deliberate, documented duplication
// rather than a change to another agent's file for an internal helper.
// ---------------------------------------------------------------------------

interface CoverFit {
  scale: number
  offsetX: number
  offsetY: number
}

function coverFit(boxW: number, boxH: number, mediaW: number, mediaH: number): CoverFit {
  const scale = Math.max(boxW / Math.max(1, mediaW), boxH / Math.max(1, mediaH))
  const dw = mediaW * scale
  const dh = mediaH * scale
  return { scale, offsetX: (boxW - dw) / 2, offsetY: (boxH - dh) / 2 }
}

function displayToMedia(dx: number, dy: number, c: CoverFit): { x: number; y: number } {
  return { x: (dx - c.offsetX) / c.scale, y: (dy - c.offsetY) / c.scale }
}

function mediaToDisplay(mx: number, my: number, c: CoverFit): { x: number; y: number } {
  return { x: c.offsetX + mx * c.scale, y: c.offsetY + my * c.scale }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function must2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('arview: 2D canvas context unavailable')
  return ctx
}

/** Resizes `canvas`'s backing store to `rect` at devicePixelRatio and
 *  installs the DPR transform. No-ops the resize when unchanged. */
function sizeCanvasToRect(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, rect: { width: number; height: number }): void {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

// ---- Screen Wake Lock (field-test fix: phone auto-locks mid-study — the
//      product's core loop is "no touches for tens of seconds" while the
//      user reads the overlay off their phone stood up at the machine).
//      Narrow local types instead of relying on lib.dom's Navigator/
//      WakeLock surface, which this project's TS target may not carry —
//      keeps `any` out of this module's exports either way. ----
interface WakeLockSentinelLike {
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}
interface NavigatorWithWakeLock {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> }
}

/**
 * Mounts the AR mode into `host` (app.ts's `#ar-host` panel). Camera access
 * only ever starts from the "Start camera" button's click handler (user
 * gesture, required by getUserMedia). The camera stream persists across
 * app-tab switches once started (only "Stop camera" releases it); the live
 * tracking loop pauses itself while `host` isn't on-screen (IntersectionObserver)
 * so switching to the Goals/Map tab doesn't keep burning CPU/battery.
 *
 * While any phase past idle is active, `document.body` gets an
 * `ar-immersive` class (styles.css) that hides app.ts's header/tab-bar and
 * makes this host full-bleed — DESIGN-NOTES §5/§7 gap 9 ("the header ...
 * replaces tab navigation while in AR"). Idle stays inside the normal app
 * chrome so the tab bar remains a real escape hatch before the camera ever
 * starts.
 */
export function mountAR(host: HTMLElement, state: AppState): { destroy(): void } {
  host.innerHTML = ''

  let destroyed = false
  let phase: Phase = 'idle'
  let hostVisible = true
  let sessionGen = 0

  let feed: CameraFeed | null = null
  let unsubscribeCameraState: (() => void) | null = null
  let lastCameraState: CameraState = 'stopped'
  let calibrateHandle: { reset(): void; destroy(): void } | null = null
  let tracker: Tracker | null = null

  // Camera watchdog (dead-ends fix) — see CAMERA_WATCHDOG_MS above.
  let cameraWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  let cameraEverLive = false
  let cameraErrorActive = false

  let calibrationHKeyframe: H | null = null
  let trackingEnabled = false

  let currentTrackerH: H | null = null
  let lastGoodTrackerH: H | null = null
  let lastGoodAt = 0
  let lastScaleToVideo = 1
  let lastFps = 0
  let lastInliers = 0

  let liveLoopActive = false
  let freezeBaseCanvas: HTMLCanvasElement | null = null
  let freezeMapFn: MapFn | null = null
  // Stage rect at the instant FREEZE was pressed — see renderFreeze()'s
  // resize-compensation comment below (proven 321px drift without this).
  let freezeRect: { w: number; h: number } | null = null
  // The highlightIndex drawGoalOverlay returned from the last drawOverlayFor
  // call — i.e. which step the user is CURRENTLY LOOKING AT. The step
  // buttons' auto-mode base must come from this, not a freshly re-evaluated
  // clock (shotcoach-corrections.md #9): during freeze the overlay is drawn
  // once from a frozen timestamp while the wall clock keeps advancing, so
  // re-deriving the index live would park the user on a shot they never saw
  // highlighted.
  let lastAutoIndex = 0
  // The one frozen clock renderFreeze() draws with — captured at the instant
  // FREEZE is pressed, reused for every freeze-phase redraw (state change /
  // resize), so the frozen overlay never silently advances between redraws.
  let freezeTimeMs = 0

  let wakeLockSentinel: WakeLockSentinelLike | null = null
  let wakeLockAcquiring = false

  async function acquireWakeLock(): Promise<void> {
    // Sentinel leak fix (R1): showOnly() calls this on EVERY non-idle phase
    // transition, not just the idle->non-idle edge — without this guard each
    // call overwrote wakeLockSentinel with a fresh sentinel, orphaning the
    // previous one still held (Screen Wake Lock stays engaged as long as ANY
    // sentinel is unreleased). wakeLockSentinel is nulled on release (below,
    // and by the 'release' listener). The `wakeLockAcquiring` flag covers the
    // request() await window itself: without it, two calls overlapping that
    // latency both pass the null check and double-request (orphaning one
    // sentinel), and a teardown racing the await couldn't be honored at all.
    if (wakeLockSentinel || wakeLockAcquiring) return
    wakeLockAcquiring = true
    try {
      const sentinel = (await (navigator as unknown as NavigatorWithWakeLock).wakeLock?.request('screen')) ?? null
      // Teardown ran while request() was pending (✕ Exit / stopCamera /
      // destroy all go through releaseWakeLock, which cannot see an
      // un-assigned sentinel): release the one we just got instead of
      // assigning it into a session that no longer wants the screen held.
      if (destroyed || phase === 'idle') {
        void sentinel?.release()
        return
      }
      wakeLockSentinel = sentinel
      // Wake locks can auto-release out from under us (e.g. the OS/browser
      // dropping it on tab hide, independent of our own visibilitychange
      // re-acquire path below) — without this, wakeLockSentinel would keep
      // pointing at an already-released sentinel and the guard above would
      // wedge shut for the rest of the session. `sentinel === wakeLockSentinel`
      // guards against nulling a NEWER sentinel if this is an old one firing
      // late.
      sentinel?.addEventListener('release', () => {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null
      })
    } catch {
      // Unsupported browser, or the OS/browser declined (e.g. low battery) —
      // degrades to "the screen can lock mid-study" rather than failing AR.
      wakeLockSentinel = null
    } finally {
      wakeLockAcquiring = false
    }
  }

  function releaseWakeLock(): void {
    void wakeLockSentinel?.release()
    wakeLockSentinel = null
  }

  // Wake locks auto-release when the tab is hidden (spec behavior, not a
  // bug) — re-acquire on the way back if AR is still up.
  function handleVisibilityChangeForWakeLock(): void {
    if (document.visibilityState === 'visible' && phase !== 'idle') void acquireWakeLock()
  }

  let sheetOpen: SheetId = null
  let sheetHandle: SheetHandle | null = null
  let settingsOpen = false
  const settings: ArSettings = { showLabels: true, autoAdvance: true, lineBrightness: 1 }

  let autoAdvanceTimer: ReturnType<typeof setTimeout> | null = null
  let goalPillCalloutTimer: ReturnType<typeof setTimeout> | null = null

  // ---- DOM: idle ----
  const root = el('div', 'ar-root')

  const idle = el('div', 'ar-idle')
  const idleBrandMark = el('div', 'ar-idle-brand-mark')
  const idleWordmark = el('div', 'ar-idle-wordmark', 'PINBALL GENIE')
  const idleTitle = el('h2', 'ar-idle-title', 'Live shot overlay')
  const idleSub = el(
    'p',
    'ar-idle-sub',
    'Start the camera at your selected machine, tap the four corners of the playfield glass, and Genie draws every shot from where your ball rests.',
  )
  const startBtn = el('button', 'ar-idle-btn', 'Start camera')
  startBtn.type = 'button'
  const idleCount = el('div', 'ar-idle-count', `${state.machines.length} MACHINES SUPPORTED`)
  const howToBtn = el('button', 'ar-idle-howto-btn', 'How to use')
  howToBtn.type = 'button'
  // Glossary sits right next to "How to use" (design constraint: same
  // surface as How-To, both tabs since howto appears here too). Reuses the
  // identical .ar-idle-howto-btn text-link style — no new CSS needed for the
  // button itself, just the .ar-idle-links row wrapper below.
  const glossaryBtn = el('button', 'ar-idle-howto-btn', 'Glossary')
  glossaryBtn.type = 'button'
  const idleLinks = el('div', 'ar-idle-links')
  idleLinks.append(howToBtn, glossaryBtn)
  const idleHint = el(
    'p',
    'ar-idle-hint',
    'Camera access is required. On an installed home-screen app, iOS asks again — if no prompt appears, reinstall from Safari.',
  )
  idle.append(idleBrandMark, idleWordmark, idleTitle, idleSub, startBtn, idleCount, idleLinks, idleHint)
  root.appendChild(idle)

  // ---- DOM: calibrate (ar/calibrate.ts owns everything inside) ----
  const calWrap = el('div', 'ar-cal-wrap')
  calWrap.hidden = true
  root.appendChild(calWrap)

  // ---- DOM: live/freeze frame ----
  const frame = el('div', 'ar-frame')
  frame.hidden = true
  const overlayCanvas = el('canvas', 'ar-overlay-canvas')
  const freezeCanvas = el('canvas', 'ar-freeze-canvas')
  freezeCanvas.hidden = true
  const freezeBadge = el('div', 'ar-freeze-badge', 'Frozen')
  freezeBadge.hidden = true
  const banner = el('div', 'ar-banner', TRACKING_LOST_TEXT)
  banner.hidden = true
  const reacquire = el('div', 'ar-reacquire')
  reacquire.hidden = true
  const reacquireText = el('p', '', '')
  reacquire.appendChild(reacquireText)
  frame.append(overlayCanvas, freezeCanvas, freezeBadge, banner, reacquire)
  root.appendChild(frame)

  // ---- DOM: camera watchdog error card (dead-ends fix) ----
  const cameraErrorCard = el('div', 'ar-error-card')
  cameraErrorCard.hidden = true
  const cameraErrorTitle = el('h3', 'ar-error-title', 'Camera trouble')
  const cameraErrorMsg = el('p', 'ar-error-msg', '')
  const cameraErrorRow = el('div', 'ar-error-row')
  const cameraErrorRetryBtn = el('button', 'ar-outline-btn', 'Try again')
  cameraErrorRetryBtn.type = 'button'
  const cameraErrorExitBtn = el('button', 'ar-outline-btn', 'Exit')
  cameraErrorExitBtn.type = 'button'
  cameraErrorRow.append(cameraErrorRetryBtn, cameraErrorExitBtn)
  cameraErrorCard.append(cameraErrorTitle, cameraErrorMsg, cameraErrorRow)
  root.appendChild(cameraErrorCard)

  host.appendChild(root)

  const overlayCtx = must2D(overlayCanvas)
  const freezeCtx = must2D(freezeCanvas)

  // ---- DOM: header pills (DESIGN-NOTES §4/§5) ----
  const header = el('div', 'ar-header')
  header.hidden = true

  const machinePill = el('button', 'ar-pill ar-machine-pill')
  machinePill.type = 'button'
  const machineDot = el('span', 'ar-machine-pill-dot')
  const machineLabel = el('span', 'ar-machine-pill-label', '—')
  const machineCaret = el('span', 'ar-pill-caret', '▾')
  machinePill.append(machineDot, machineLabel, machineCaret)

  const goalPill = el('button', 'ar-pill ar-goal-pill')
  goalPill.type = 'button'
  const goalDot = el('span', 'ar-goal-pill-dot')
  const goalLabel = el('span', 'ar-goal-pill-label', 'Loading…')
  const goalCaret = el('span', 'ar-pill-caret', '▾')
  goalPill.append(goalDot, goalLabel, goalCaret)

  const qualityPill = el('div', 'ar-pill ar-quality-pill')
  const qualityPillDot = el('span', 'ar-quality-pill-dot')
  const qualityPillText = el('span', 'ar-quality-pill-text', '—')
  qualityPill.append(qualityPillDot, qualityPillText)

  const settingsBtn = el('button', 'ar-settings-btn')
  settingsBtn.type = 'button'
  settingsBtn.setAttribute('aria-label', 'AR settings')
  for (let i = 0; i < 3; i++) settingsBtn.appendChild(el('span', 'ar-settings-glyph-bar'))

  // Dead-ends fix: a visible exit from EVERY non-idle phase (header.hidden
  // is already `next === 'idle'` — see showOnly() — so this button is
  // automatically shown in calibrating/live/freeze, including on top of
  // the camera watchdog error card — header z-index:5 vs. the card's 4).
  const exitBtn = el('button', 'ar-exit-btn', '✕')
  exitBtn.type = 'button'
  exitBtn.setAttribute('aria-label', 'Exit AR')

  header.append(machinePill, goalPill, qualityPill, settingsBtn, exitBtn)
  root.appendChild(header)

  // ---- DOM: one-time GOAL-pill callout (field test fix) ----
  const goalPillCallout = el('div', 'ar-goalpill-callout')
  goalPillCallout.hidden = true
  const goalPillCalloutBubble = el('button', 'ar-goalpill-callout-bubble', 'Tap to pick a shot path')
  goalPillCalloutBubble.type = 'button'
  goalPillCallout.appendChild(goalPillCalloutBubble)
  root.appendChild(goalPillCallout)

  // ---- DOM: settings popover ----
  const settingsPopover = el('div', 'ar-settings-popover')
  settingsPopover.hidden = true

  function buildToggleRow(label: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; refresh: () => void } {
    const row = el('div', 'ar-settings-row')
    const labelEl = el('div', 'ar-settings-row-label', label)
    const track = el('button', 'ar-settings-toggle')
    track.type = 'button'
    const knob = el('span', 'ar-settings-toggle-knob')
    track.appendChild(knob)
    function refresh(): void {
      track.classList.toggle('on', get())
    }
    track.addEventListener('click', () => {
      set(!get())
      refresh()
    })
    row.append(labelEl, track)
    refresh()
    return { row, refresh }
  }

  // TRAIL STYLE — segmented DASH/NEON control (README §3d / correction 7,
  // inserted first). state.trailStyle is an AppState field (persisted) —
  // state.setTrailStyle() already notifies onChange, which redraws freeze
  // (see the `state.onChange` subscription below); live picks it up on its
  // own next tick since renderLive -> drawOverlayFor reads state fresh.
  const trailStyleWrap = el('div', 'ar-settings-trailstyle')
  // Caps, per README §3d ("**TRAIL STYLE** — segmented, 2 options DASH /
  // NEON") — 2026-07-28 review finding 6 (nit): the label was sentence case.
  const trailStyleLabel = el('div', 'ar-settings-row-label', 'TRAIL STYLE')
  const trailStyleTrack = el('div', 'ar-settings-segmented')
  const trailStyleDashBtn = el('button', 'ar-settings-segmented-btn', 'DASH')
  trailStyleDashBtn.type = 'button'
  const trailStyleNeonBtn = el('button', 'ar-settings-segmented-btn', 'NEON')
  trailStyleNeonBtn.type = 'button'
  trailStyleTrack.append(trailStyleDashBtn, trailStyleNeonBtn)
  trailStyleWrap.append(trailStyleLabel, trailStyleTrack)
  function refreshTrailStyle(): void {
    trailStyleDashBtn.classList.toggle('selected', state.trailStyle === 'dash')
    trailStyleNeonBtn.classList.toggle('selected', state.trailStyle === 'neon')
  }
  trailStyleDashBtn.addEventListener('click', () => {
    state.setTrailStyle('dash')
    refreshTrailStyle()
  })
  trailStyleNeonBtn.addEventListener('click', () => {
    state.setTrailStyle('neon')
    refreshTrailStyle()
  })
  refreshTrailStyle()

  const ballTracerToggle = buildToggleRow(
    'Ball tracer',
    () => state.ballTracer,
    (v) => state.setBallTracer(v),
  )
  const labelsToggle = buildToggleRow(
    'Path labels',
    () => settings.showLabels,
    (v) => {
      settings.showLabels = v
      redrawCurrentFrame()
    },
  )
  const autoToggle = buildToggleRow(
    'Auto-advance',
    () => settings.autoAdvance,
    (v) => {
      settings.autoAdvance = v
      resetAutoAdvanceTimer()
    },
  )

  const brightnessWrap = el('div', 'ar-settings-brightness')
  const brightnessLabel = el('div', 'ar-settings-row-label', 'Line brightness')
  const brightnessInput = document.createElement('input')
  brightnessInput.type = 'range'
  brightnessInput.min = '0.4'
  brightnessInput.max = '1.8'
  brightnessInput.step = '0.05'
  brightnessInput.value = String(settings.lineBrightness)
  brightnessInput.className = 'ar-settings-range'
  brightnessInput.addEventListener('input', () => {
    settings.lineBrightness = parseFloat(brightnessInput.value)
    // Live phase picks this up on its own next animation frame (the tick()
    // loop reads `settings` fresh every frame); freeze doesn't run a loop,
    // so it needs an explicit repaint of the frozen overlay canvas.
    redrawCurrentFrame()
  })
  brightnessWrap.append(brightnessLabel, brightnessInput)

  // Not in the design mock (which never shows a stuck-mid-flow state) — a
  // secondary Stop camera affordance (the header's ✕ Exit AR button is now
  // the primary, more-discoverable one — see the dead-ends fix note at the
  // top of this file), deliberately placed here rather than the bottom
  // stack (DESIGN-NOTES §5's bottom row is FREEZE/RECALIBRATE only,
  // live/freeze-only anyway) because the settings popover is reachable from
  // every non-idle phase (header shows whenever headerOn).
  const stopFromSettingsBtn = el('button', 'ar-settings-stop-btn', 'Stop camera')
  stopFromSettingsBtn.type = 'button'
  stopFromSettingsBtn.addEventListener('click', () => {
    closeSettingsPopover()
    stopCamera()
  })

  settingsPopover.append(
    trailStyleWrap,
    ballTracerToggle.row,
    labelsToggle.row,
    autoToggle.row,
    brightnessWrap,
    stopFromSettingsBtn,
  )
  root.appendChild(settingsPopover)

  // ---- DOM: bottom stack (Play phase — DESIGN-NOTES §5 "Controls") ----
  const bottomStack = el('div', 'ar-bottom-stack')
  bottomStack.hidden = true

  const stepRow = el('div', 'ar-step-row')
  const stepPrevBtn = el('button', 'ar-step-btn', '‹')
  stepPrevBtn.type = 'button'
  stepPrevBtn.setAttribute('aria-label', 'Previous step')
  const stepReadout = el('button', 'ar-step-readout')
  stepReadout.type = 'button'
  const stepReadoutLabel = el('div', 'ar-step-readout-label', '')
  const stepReadoutAction = el('div', 'ar-step-readout-action', '')
  stepReadout.append(stepReadoutLabel, stepReadoutAction)
  const stepNextBtn = el('button', 'ar-step-btn', '›')
  stepNextBtn.type = 'button'
  stepNextBtn.setAttribute('aria-label', 'Next step')
  stepRow.append(stepPrevBtn, stepReadout, stepNextBtn)

  // DESIGN-NOTES §5 "Controls" row 3: exactly two 50/50-width outline
  // buttons, FREEZE / RECALIBRATE — no third button here (see the Stop
  // camera control in the settings popover, `stopFromSettingsBtn`, for the
  // full camera-release affordance).
  const freezeRow = el('div', 'ar-freeze-row')
  const freezeToggleBtn = el('button', 'ar-outline-btn', 'FREEZE')
  freezeToggleBtn.type = 'button'
  const recalBtn = el('button', 'ar-outline-btn', 'RECALIBRATE')
  recalBtn.type = 'button'
  freezeRow.append(freezeToggleBtn, recalBtn)

  bottomStack.append(stepRow, freezeRow)
  root.appendChild(bottomStack)

  // Celebrate toast removed 2026-07-28 (shotcoach-corrections.md #11) —
  // completing a goal in AR just loops it (see completeGoal() below), no
  // completion toast/particle burst on either surface.

  // ---- Camera reacquire banner (live/freeze use the frame-scoped overlay;
  //      calibrate.ts renders its own connecting/error copy pre-live; the
  //      camera watchdog card below is the fallback for when that connecting
  //      state never resolves) ----
  function cameraStateMessage(s: CameraState, err?: Error): string {
    return s === 'error'
      ? err?.name === 'NotAllowedError'
        ? 'Camera access denied — allow it in your browser settings and reload.'
        : 'Camera unavailable — reopen the app.'
      : 'Camera paused — reopen this tab or app to resume.'
  }

  function onCameraStateChange(s: CameraState, err?: Error): void {
    if (destroyed) return
    lastCameraState = s
    if (s === 'live') {
      cameraEverLive = true
      clearCameraWatchdog()
      if (cameraErrorActive) hideCameraError()
    } else if (s === 'error' && phase !== 'idle' && (phase === 'calibrating' || !cameraEverLive)) {
      // Denied permission / no camera found resolves near-instantly — no
      // reason to make the user wait out the full watchdog window for a
      // failure we already know about. The !cameraEverLive gate exists so
      // this doesn't fight the live/freeze reacquire banner below — but a
      // RECALIBRATE re-enters 'calibrating' with cameraEverLive already
      // true from the earlier session, and calibrate.ts has no error UI of
      // its own for a camera that dies AFTER it mounts (only for one that
      // never started) — so 'calibrating' always shows this card on error,
      // regardless of cameraEverLive. Live/freeze keep the original gate;
      // their reacquire banner already covers this case.
      showCameraError(err)
    }
    if (phase === 'live' || phase === 'freeze') {
      reacquire.hidden = s === 'live'
      if (s !== 'live') reacquireText.textContent = cameraStateMessage(s, err)
    } else {
      reacquire.hidden = true
    }
  }

  // ---- Camera watchdog (dead-ends fix — see CAMERA_WATCHDOG_MS) ----

  function clearCameraWatchdog(): void {
    if (cameraWatchdogTimer !== null) {
      window.clearTimeout(cameraWatchdogTimer)
      cameraWatchdogTimer = null
    }
  }

  function armCameraWatchdog(): void {
    clearCameraWatchdog()
    cameraWatchdogTimer = window.setTimeout(() => {
      cameraWatchdogTimer = null
      if (destroyed || cameraEverLive) return
      showCameraError()
    }, CAMERA_WATCHDOG_MS)
  }

  /** Swaps in a plain-language error card over whatever phase-specific
   *  content was showing (no infinite spinners). `err` present ->
   *  camera-reported reason; absent -> the watchdog timed out waiting. */
  function showCameraError(err?: Error): void {
    if (destroyed || phase === 'idle') return
    clearCameraWatchdog()
    cameraErrorActive = true
    cameraErrorMsg.textContent = err
      ? cameraStateMessage('error', err)
      : "Camera didn't start in time — check that no other app is using it, then try again."
    cameraErrorCard.hidden = false
  }

  function hideCameraError(): void {
    cameraErrorActive = false
    cameraErrorCard.hidden = true
  }

  // ---- Phase transitions ----

  function showOnly(next: Phase): void {
    // Any deliberate phase transition dismisses a stale watchdog error card
    // — it's only ever shown mid-'calibrating', never past a real
    // transition (see showCameraError()).
    hideCameraError()
    idle.hidden = next !== 'idle'
    calWrap.hidden = next !== 'calibrating'
    frame.hidden = next !== 'live' && next !== 'freeze'
    header.hidden = next === 'idle'
    bottomStack.hidden = next !== 'live' && next !== 'freeze'
    if (next === 'idle') {
      settingsOpen = false
      settingsPopover.hidden = true
      closeSheetsInternal()
      clearCameraWatchdog()
      goalPillCallout.hidden = true
      if (goalPillCalloutTimer !== null) {
        window.clearTimeout(goalPillCalloutTimer)
        goalPillCalloutTimer = null
      }
      releaseWakeLock()
    } else {
      // Every non-idle phase, not just 'live' — the point is "don't let the
      // phone auto-lock while the user is mid-flow", which includes sitting
      // on the calibrate screen.
      void acquireWakeLock()
    }
    document.body.classList.toggle('ar-immersive', next !== 'idle')
    phase = next
    if (next === 'live') resetAutoAdvanceTimer()
    else clearAutoAdvanceTimer()
    renderHeader()
    renderStepRow()
    updateHud()
  }

  function bumpGen(): number {
    sessionGen += 1
    return sessionGen
  }

  /** Stops live tracking + drops calibration state, WITHOUT touching the
   *  camera feed itself or the selected machine — shared by recalibrate()
   *  and switchMachine(). */
  function teardownTracking(): void {
    stopLiveLoop()
    tracker?.destroy()
    tracker = null
    trackingEnabled = false
    currentTrackerH = null
    lastGoodTrackerH = null
    calibrationHKeyframe = null
    freezeMapFn = null
    freezeRect = null
  }

  /** "Start camera" goes STRAIGHT to manual corner calibration for the
   *  currently selected machine (state always has one pre-selected) — no
   *  OCR identify/match step. Arms the camera watchdog immediately so a
   *  stalled/denied getUserMedia() can't leave the user staring at a
   *  spinner indefinitely. */
  async function startCamera(): Promise<void> {
    if (feed) return // already started this session
    hideCameraError()
    cameraEverLive = false
    feed = createCameraFeed()
    unsubscribeCameraState = feed.onStateChange(onCameraStateChange)
    armCameraWatchdog()
    void feed.start()
    startCalibration()
  }

  function startCalibration(): void {
    if (!feed) return
    showOnly('calibrating')
    // Leak fix: switchMachine()/recalibrate() can re-enter this while a
    // previous calibration UI is still mounted (mid-calibration machine
    // switch) — without destroying it first, its camera-state subscription
    // and ResizeObserver leak, one per re-entry.
    calibrateHandle?.destroy()
    calibrateHandle = createCalibrationUI(calWrap, feed, (c) => void onCalibrated(c))
  }

  async function onCalibrated(calibration: Calibration): Promise<void> {
    if (destroyed || !feed) return
    // Captured so the post-await continuation below can detect a teardown
    // or machine-switch (both bump sessionGen) that happened while we were
    // awaiting tracker.init() — without this a stale continuation can
    // dereference a nulled feed or clobber a fresh calibration UI.
    const gen = sessionGen
    // Must read the stage rect BEFORE anything hides/removes calWrap.
    const stageRect = calWrap.getBoundingClientRect()
    const vw = feed.video.videoWidth
    const vh = feed.video.videoHeight

    // Backstop only (A4) — calibrate.ts's own Accept-gating (renderManualHud
    // n===4, feed.video.videoWidth === 0) should make this unreachable; kept
    // rather than baking a 1x1-video cover fit into calibrationHKeyframe
    // permanently (the ~947px-off overlay defect this backstops).
    if (vw === 0 || vh === 0) {
      console.error('[arview] onCalibrated: video has no dimensions yet')
      calibrateHandle?.reset()
      return
    }

    // Convert the display-px quad -> keyframe-px quad: display -> video
    // intrinsic (inverse cover-fit at calibration time) -> keyframe canvas
    // px (divide by grabFrame's scaleToVideo).
    let kf: ReturnType<CameraFeed['grabFrame']>
    let quadKeyframePx: [number, number][]
    try {
      kf = feed.grabFrame(KEYFRAME_MAX_DIM)
      const cover = coverFit(stageRect.width, stageRect.height, vw, vh)
      quadKeyframePx = calibration.corners.map(([dx, dy]) => {
        const media = displayToMedia(dx, dy, cover)
        return [media.x / kf.scaleToVideo, media.y / kf.scaleToVideo]
      })
      calibrationHKeyframe = computeHomography(UNIT_SQUARE, quadKeyframePx)
    } catch (e) {
      // Backstop only (A3) — calibrate.ts's quadProblem() validation at
      // Accept should make computeHomography's degenerate-input throw
      // unreachable; kept in case a corner case slips past it (this used to
      // be an un-awaited `void onCalibrated(c)` throw -> unhandled
      // rejection -> calibrate UI stuck on its post-Accept state forever;
      // that HUD now reads "Locking on…" — see calibrate.ts's calibrated
      // branch).
      console.error('[arview] onCalibrated: homography computation failed', e)
      calibrationHKeyframe = null
      calibrateHandle?.reset()
      return
    }

    tracker?.destroy() // leak fix: a repeat onCalibrated must not strand the previous Worker
    tracker = createTracker()
    const kfCtx = kf.canvas.getContext('2d', { willReadFrequently: true })
    let initOk = false
    if (kfCtx) {
      const kfImageData = kfCtx.getImageData(0, 0, kf.canvas.width, kf.canvas.height)
      try {
        initOk = await tracker.init(kfImageData, quadKeyframePx)
      } catch (e) {
        console.error('[arview] tracker init failed', e)
        initOk = false
      }
    }
    if (destroyed || sessionGen !== gen || !feed) return
    trackingEnabled = initOk

    calibrateHandle?.destroy()
    calibrateHandle = null
    // Re-parent the (still-live) video element into the live frame.
    frame.insertBefore(feed.video, overlayCanvas)
    // iOS pauses a re-parented live video — nudge it back without letting a
    // rejected play() (e.g. a stale gesture context) surface as an error.
    void feed.video.play().catch(() => {})

    currentTrackerH = null
    lastGoodTrackerH = null
    lastGoodAt = performance.now()
    lastScaleToVideo = kf.scaleToVideo
    banner.hidden = true
    freezeBadge.hidden = true
    freezeCanvas.hidden = true
    overlayCanvas.style.display = ''
    feed.video.style.visibility = ''
    onCameraStateChange('live') // clear/seed the reacquire banner for the new phase
    showOnly('live')
    startLiveLoop()
    maybeShowGoalPillCallout()
  }

  // ---- LIVE loop ----

  function startLiveLoop(): void {
    if (liveLoopActive) return
    liveLoopActive = true
    void tick()
  }
  function stopLiveLoop(): void {
    liveLoopActive = false
  }

  async function tick(): Promise<void> {
    if (!liveLoopActive || phase !== 'live' || !feed || !tracker) {
      liveLoopActive = false
      return
    }
    if (!hostVisible) {
      // Paused while off-screen; the IntersectionObserver restarts this loop.
      liveLoopActive = false
      return
    }

    if (trackingEnabled && lastCameraState === 'live') {
      // Guards against grabbing/tracking a dead <video> element: iOS kills
      // the MediaStream while backgrounded, and camera.ts's restart() on
      // foreground is async, so a tick() resumed by rAF can otherwise land
      // in the gap before the stream is actually live again. Skip the
      // grab/track work (renderLive() below still runs off the last-known
      // currentTrackerH, and the loop keeps rescheduling itself so it
      // resumes tracking on its own once lastCameraState flips back).
      const grabbed = feed.grabFrame(KEYFRAME_MAX_DIM)
      lastScaleToVideo = grabbed.scaleToVideo
      const fctx = grabbed.canvas.getContext('2d', { willReadFrequently: true })
      if (fctx) {
        const imageData = fctx.getImageData(0, 0, grabbed.canvas.width, grabbed.canvas.height)
        try {
          const res = await tracker.track(imageData)
          lastFps = res.fps
          lastInliers = res.inliers
          // Inlier gate (field-test fix): below TRACKER_MIN_INLIERS the
          // RANSAC fit is too thin to trust (glass reflections can yank the
          // overlay with confidence off a handful of points) — treat it
          // exactly like a null result, falling back to lastGoodTrackerH.
          if (res.h && res.inliers >= TRACKER_MIN_INLIERS) {
            currentTrackerH = res.h
            lastGoodTrackerH = res.h
            lastGoodAt = performance.now()
          } else {
            currentTrackerH = null
          }
        } catch (e) {
          console.error('[arview] tracker.track failed', e)
          currentTrackerH = null
        }
      }
    }

    renderLive()

    if (liveLoopActive && phase === 'live') {
      requestAnimationFrame(() => void tick())
    } else {
      liveLoopActive = false
    }
  }

  function liveMapFn(rect: { width: number; height: number }, videoW: number, videoH: number): MapFn {
    const cover = coverFit(rect.width, rect.height, videoW, videoH)
    const effTrackerH = currentTrackerH ?? lastGoodTrackerH ?? IDENTITY_H
    const calH = calibrationHKeyframe as H
    return (u, v) => {
      const kfPt = applyH(calH, u, v)
      const trackedPt = applyH(effTrackerH, kfPt.x, kfPt.y)
      const vx = trackedPt.x * lastScaleToVideo
      const vy = trackedPt.y * lastScaleToVideo
      return mediaToDisplay(vx, vy, cover)
    }
  }

  function computeQuality(): { color: string; text: string } {
    if (phase === 'calibrating') return { color: '#f5a623', text: 'CALIBRATING' }
    if (!trackingEnabled) return { color: '#ff3b30', text: 'STATIC' }
    const lostFor = performance.now() - lastGoodAt
    if (currentTrackerH === null && lostFor > HOLD_STEADY_GRACE_MS) return { color: '#ff3b30', text: 'LOST' }
    const color = lastInliers >= 30 ? '#34c759' : lastInliers >= 12 ? '#f5a623' : '#ff3b30'
    return { color, text: `${Math.round(lastFps)} FPS` }
  }

  function updateHud(): void {
    const lostFor = performance.now() - lastGoodAt
    const lost = phase === 'live' && trackingEnabled && currentTrackerH === null && lostFor > HOLD_STEADY_GRACE_MS
    // Surface STATIC honestly (field-test fix): mutually exclusive with
    // `lost` by construction — `lost` requires trackingEnabled, this
    // requires !trackingEnabled — so the two banner messages can never
    // both want to show at once.
    const staticOverlay = phase === 'live' && !trackingEnabled
    if (staticOverlay) {
      banner.textContent = STATIC_OVERLAY_TEXT
      banner.hidden = false
    } else if (lost) {
      banner.textContent = TRACKING_LOST_TEXT
      banner.hidden = false
    } else {
      banner.hidden = true
    }
    const q = computeQuality()
    qualityPillDot.style.background = q.color
    qualityPillText.textContent = q.text
  }

  function renderLive(): void {
    if (!feed || !calibrationHKeyframe) return
    const rect = frame.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    sizeCanvasToRect(overlayCanvas, overlayCtx, rect)
    overlayCtx.clearRect(0, 0, rect.width, rect.height)

    const videoW = feed.video.videoWidth || 1
    const videoH = feed.video.videoHeight || 1
    const map = liveMapFn(rect, videoW, videoH)
    drawOverlayFor(overlayCtx, map, performance.now())
    updateHud()
  }

  function drawOverlayFor(ctx: CanvasRenderingContext2D, map: MapFn, timeMs: number): void {
    // No more separate "BALL AT" marker (removed with the BALL AT chip
    // row — see this file's 2026-07-13 header note): the route's own
    // step-1 badge, drawn by drawGoalOverlay below, already marks where the
    // combo starts.
    const goal = state.selectedGoal
    if (goal) {
      // relMs anchors the tracer/marching-highlight clock to selection
      // (shotcoach-corrections.md #9) — computed here, not inside
      // drawing.ts, so state.ts's routeStartedAt stays the single owner of
      // the epoch and drawGoalOverlay keeps treating `time` as an opaque
      // clock.
      const relMs = timeMs - state.routeStartedAt
      const result = drawGoalOverlay(ctx, {
        shotsByID: state.shotsByID,
        goal,
        stepIndex: state.stepIndex,
        ballPosition: state.ballPosition,
        map,
        time: relMs,
        showLabels: settings.showLabels,
        lineBrightness: settings.lineBrightness,
        highlightIndex: state.highlightMode === 'manual' ? state.stepIndex : undefined,
        trailStyle: state.trailStyle,
        ballTracer: state.ballTracer,
        topInset: 152,
      })
      lastAutoIndex = result.highlightIndex
    } else {
      // AR shows the route and nothing else (README §3a) — no ambient dots,
      // just the halo hint. drawShotDots is deliberately not called here.
      drawNoGoalHint(ctx)
    }
  }

  /** No-goal AR state: a single centered halo label, per README §3a /
   *  shotcoach-corrections.md #1 (drawPlayfieldArt-style ambient dots are
   *  map-only). Uses drawing.ts's exported halo-label helper so the stroke-
   *  then-fill "paint-order" treatment matches every other label on both
   *  surfaces. */
  function drawNoGoalHint(ctx: CanvasRenderingContext2D): void {
    const w = ctx.canvas.clientWidth || ctx.canvas.width
    const h = ctx.canvas.clientHeight || ctx.canvas.height
    drawHaloLabel(ctx, NO_GOAL_HINT_TEXT, w / 2, h * 0.52, `800 10px ${AR_MONO}`, 'rgba(255,255,255,.7)', 'rgba(0,0,0,.7)')
  }

  function redrawCurrentFrame(): void {
    if (phase === 'freeze') renderFreeze()
  }

  // ---- FREEZE ----
  // Unchanged contract from before this pass: freeze captures frame + mapFn
  // TOGETHER (one pose) — freezeMapFn is liveMapFn(...) snapshotted once at
  // the instant Freeze is pressed and reused for the whole freeze duration,
  // so the frozen still and its overlay always agree. DESIGN-NOTES §7 gap 8:
  // button now reads FREEZE/RESUME (uppercase), not Freeze/Live.

  function enterFreeze(): void {
    if (phase !== 'live' || !feed) return
    clearAutoAdvanceTimer()
    stopLiveLoop()
    freezeTimeMs = performance.now()
    const rect = frame.getBoundingClientRect()
    const videoW = feed.video.videoWidth || 1
    const videoH = feed.video.videoHeight || 1
    const cover = coverFit(rect.width, rect.height, videoW, videoH)

    freezeMapFn = liveMapFn(rect, videoW, videoH)
    // Snapshot alongside freezeMapFn (B5) — renderFreeze() below stretches
    // the frozen photo to whatever the CURRENT rect is (rotation/toolbar
    // change during freeze), so the overlay's map must be stretched by the
    // same factor or it drifts off the photo (proven 321px drift without
    // this).
    freezeRect = { w: rect.width, h: rect.height }

    const srcX = Math.max(0, -cover.offsetX / cover.scale)
    const srcY = Math.max(0, -cover.offsetY / cover.scale)
    const srcW = Math.min(videoW - srcX, rect.width / cover.scale)
    const srcH = Math.min(videoH - srcY, rect.height / cover.scale)

    const dpr = window.devicePixelRatio || 1
    const baseW = Math.max(1, Math.round(rect.width * dpr))
    const baseH = Math.max(1, Math.round(rect.height * dpr))
    if (!freezeBaseCanvas) freezeBaseCanvas = document.createElement('canvas')
    freezeBaseCanvas.width = baseW
    freezeBaseCanvas.height = baseH
    const baseCtx = must2D(freezeBaseCanvas)
    baseCtx.drawImage(feed.video, srcX, srcY, Math.max(1, srcW), Math.max(1, srcH), 0, 0, baseW, baseH)

    feed.video.style.visibility = 'hidden'
    overlayCanvas.style.display = 'none'
    freezeCanvas.hidden = false
    freezeBadge.hidden = false
    banner.hidden = true
    freezeToggleBtn.textContent = 'RESUME'
    renderFreeze()
    showOnly('freeze')
  }

  function renderFreeze(): void {
    if (!freezeBaseCanvas || !freezeMapFn || !freezeRect) return
    const rect = frame.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    sizeCanvasToRect(freezeCanvas, freezeCtx, rect)
    freezeCtx.clearRect(0, 0, rect.width, rect.height)
    // The frozen PHOTO is drawn stretched to the CURRENT rect (unchanged) —
    // so the overlay's map must be stretched by the same factor, or it
    // stays glued to the OLD rect's geometry while the photo underneath it
    // moves (the 321px-drift defect).
    freezeCtx.drawImage(freezeBaseCanvas, 0, 0, rect.width, rect.height)
    const sx = rect.width / freezeRect.w
    const sy = rect.height / freezeRect.h
    const stretchedMapFn: MapFn = (u, v) => {
      const p = freezeMapFn!(u, v)
      return { x: p.x * sx, y: p.y * sy }
    }
    drawOverlayFor(freezeCtx, stretchedMapFn, freezeTimeMs)
  }

  /** Restores the live-frame chrome enterFreeze() hides (video visibility,
   *  overlay canvas display, freeze canvas/badge) — shared by resumeLive()
   *  and by recalibrate()/switchMachine() below (R2). Both of the latter are
   *  reachable FROM freeze and re-mount calibration on top of whatever
   *  showOnly('calibrating') leaves showing; without this they left the
   *  video hidden and the freeze canvas/badge up, i.e. a solid black stage
   *  that still accepted taps. Idempotent — a no-op when nothing was hidden. */
  function restoreFreezeChrome(): void {
    if (feed) feed.video.style.visibility = ''
    overlayCanvas.style.display = ''
    freezeCanvas.hidden = true
    freezeBadge.hidden = true
  }

  function resumeLive(): void {
    if (phase !== 'freeze' || !feed) return
    restoreFreezeChrome()
    freezeToggleBtn.textContent = 'FREEZE'
    showOnly('live')
    startLiveLoop()
  }

  function toggleFreeze(): void {
    if (phase === 'live') enterFreeze()
    else if (phase === 'freeze') resumeLive()
  }

  // ---- Recalibrate / machine switch / stop ----

  function recalibrate(): void {
    if (!feed) return
    bumpGen()
    teardownTracking()
    restoreFreezeChrome() // R2: reachable from freeze — undo its hidden video/overlay before re-mounting calibration
    freezeToggleBtn.textContent = 'FREEZE'
    startCalibration()
  }

  async function switchMachine(m: Machine): Promise<void> {
    if (!feed) return
    bumpGen()
    teardownTracking()
    restoreFreezeChrome() // R2: reachable from freeze — same as recalibrate() above
    freezeToggleBtn.textContent = 'FREEZE'
    if (state.machine?.id !== m.id) {
      try {
        await state.selectMachine(m)
      } catch (e) {
        console.error('[arview] selectMachine failed', e)
      }
    }
    if (destroyed) return
    startCalibration()
  }

  /** Full teardown back to idle — the ✕ Exit AR header button, the settings
   *  popover's "Stop camera", and the camera watchdog error card's "Exit"
   *  all call this. Also the basis of retryCamera()'s "fully rebuild, no
   *  stale streams/listeners" behavior below. */
  function stopCamera(): void {
    bumpGen()
    clearAutoAdvanceTimer()
    clearCameraWatchdog()
    calibrateHandle?.destroy()
    calibrateHandle = null
    teardownTracking()
    unsubscribeCameraState?.()
    unsubscribeCameraState = null
    feed?.stop()
    feed?.video.remove()
    feed = null
    cameraEverLive = false
    hideCameraError()
    reacquire.hidden = true
    freezeToggleBtn.textContent = 'FREEZE'
    calWrap.innerHTML = ''
    closeSheetsInternal()
    settingsOpen = false
    settingsPopover.hidden = true
    showOnly('idle')
  }

  /** Camera watchdog error card's "Try again" — re-runs startCamera from
   *  scratch (full teardown first, so there's no stale stream/listener to
   *  race the new one). */
  function retryCamera(): void {
    hideCameraError()
    stopCamera()
    void startCamera()
  }

  // ---- Header pill content ----

  function renderHeader(): void {
    machineLabel.textContent = state.machine?.shortTitle ?? '—'
    const goal = state.selectedGoal
    goalDot.style.background = goal ? CATEGORY_META[goal.category].color : 'rgba(255,255,255,.3)'
    goalLabel.textContent = goal ? goal.title : state.data ? 'Pick a goal' : 'Loading…'
    goalPill.disabled = !state.data
  }

  // ---- Step controls ----

  function renderStepRow(): void {
    const goal = state.selectedGoal
    // '‹' is gated on stepIndex only once the user actually HOLDS manual
    // control — in auto mode its action is "park one step behind the live
    // marching highlight" (onStepPrev), which is valid regardless of
    // stepIndex, so disabling it on stepIndex === 0 would make backwards
    // entry into manual mode unreachable (stepIndex sits at 0 until
    // something advances it).
    stepPrevBtn.disabled = !goal || (state.highlightMode === 'manual' && state.stepIndex === 0)
    stepNextBtn.disabled = !goal
    stepReadout.disabled = !goal
    if (!goal) {
      stepReadoutLabel.textContent = 'NO GOAL'
      stepReadoutAction.textContent = 'Tap the goal pill to pick one'
      stepNextBtn.textContent = '›'
      stepReadout.setAttribute('aria-label', 'No goal selected')
      return
    }
    const manual = state.highlightMode === 'manual'
    const onLast = state.stepIndex >= goal.steps.length - 1
    // In auto mode the '›' button never means "finish" — it means "take
    // manual control one step ahead of the marching highlight" — so the ✓
    // affordance only ever appears once the user has actually parked on the
    // last step themselves.
    const showFinish = onLast && manual
    stepReadoutLabel.textContent = `STEP ${state.stepIndex + 1} OF ${goal.steps.length}${manual ? ' · PAUSED' : ''}`
    stepReadoutAction.textContent = goal.steps[state.stepIndex]?.action ?? ''
    stepNextBtn.textContent = showFinish ? '✓' : '›'
    stepNextBtn.setAttribute('aria-label', showFinish ? 'Finish goal' : 'Next step')
    stepReadout.setAttribute(
      'aria-label',
      manual ? 'Paused — tap to resume auto-cycle' : 'Tap to pause on the current shot',
    )
  }

  /** '‹' button: in auto mode, takes manual control one step behind the live
   *  marching highlight (mirrors onStepNext's auto branch below); in manual
   *  mode, plain prevStep as before. */
  function onStepPrev(): void {
    const goal = state.selectedGoal
    if (!goal) return
    if (state.highlightMode === 'auto') {
      state.goToStep(Math.max(lastAutoIndex - 1, 0))
      state.pauseHighlight()
    } else {
      state.prevStep()
      resetAutoAdvanceTimer()
    }
  }

  /** Advances stepIndex by one, completing the goal on the last step — the
   *  auto-advance TIMER's own action (must never pause the highlight) and
   *  the '›' button's action once already in manual mode (keeps the
   *  existing complete-on-last semantic). See onStepNext() below for the
   *  '›' button's AUTO-mode behavior, which instead takes manual control. */
  function advanceStep(): void {
    const goal = state.selectedGoal
    if (!goal) return
    if (state.stepIndex >= goal.steps.length - 1) {
      completeGoal()
    } else {
      state.nextStep()
      resetAutoAdvanceTimer()
    }
  }

  /** '›' button: in auto mode, takes manual control one step ahead of the
   *  live marching highlight instead of finishing; once already in manual
   *  mode, delegates to advanceStep() (complete-on-last). */
  function onStepNext(): void {
    const goal = state.selectedGoal
    if (!goal) return
    if (state.highlightMode === 'auto') {
      state.goToStep(Math.min(lastAutoIndex + 1, goal.steps.length - 1))
      state.pauseHighlight()
    } else {
      advanceStep()
    }
  }

  /** Readout tap: the pause/resume affordance (mirrors overlay/map2d.ts's
   *  Map-tab readout). No-op with no goal selected. */
  function onStepReadoutClick(): void {
    const goal = state.selectedGoal
    if (!goal) return
    if (state.highlightMode === 'manual') {
      state.resumeHighlight()
      resetAutoAdvanceTimer()
    } else {
      state.goToStep(lastAutoIndex)
      state.pauseHighlight()
    }
  }

  // ---- Complete (celebrations removed 2026-07-28 — shotcoach-corrections.md
  //      #11: no completion toast, no particle/sprite burst on either
  //      surface). Tapping '›' on a goal's final step completes it — mirrors
  //      app.ts's non-AR goal-detail loop-forever behavior (see this file's
  //      header comment for why: no ball-arrival signal exists to trigger it
  //      automatically) — reaching the last step just restarts the route at
  //      step 1 and keeps auto-advance running. fx/celebrate.ts stays on
  //      disk, unimported. ----

  function completeGoal(): void {
    const goal = state.selectedGoal
    if (!goal) return
    clearAutoAdvanceTimer()
    state.restartGoal()
    resetAutoAdvanceTimer()
  }

  // ---- GOAL-pill one-time callout (field test fix — see GOALPILL_SEEN_KEY
  //      above). Fires once, right after the first successful calibration,
  //      only if no goal is selected yet; dismisses itself on tap or after
  //      GOALPILL_CALLOUT_MS. ----

  function maybeShowGoalPillCallout(): void {
    if (state.selectedGoal) return
    if (localStorage.getItem(GOALPILL_SEEN_KEY) === '1') return
    localStorage.setItem(GOALPILL_SEEN_KEY, '1')
    goalPillCallout.hidden = false
    if (goalPillCalloutTimer !== null) window.clearTimeout(goalPillCalloutTimer)
    goalPillCalloutTimer = window.setTimeout(dismissGoalPillCallout, GOALPILL_CALLOUT_MS)
  }

  function dismissGoalPillCallout(): void {
    goalPillCallout.hidden = true
    if (goalPillCalloutTimer !== null) {
      window.clearTimeout(goalPillCalloutTimer)
      goalPillCalloutTimer = null
    }
  }

  // ---- Auto-advance timer (settings popover toggle; DESIGN-NOTES §5/§7
  //      gap 5 — no ball-arrival event exists, so this is a fixed-interval
  //      timer per the task's explicit instruction, not the design doc's
  //      literal ball-dwell trigger; see file header deviations note) ----

  function clearAutoAdvanceTimer(): void {
    if (autoAdvanceTimer !== null) {
      window.clearTimeout(autoAdvanceTimer)
      autoAdvanceTimer = null
    }
  }

  function resetAutoAdvanceTimer(): void {
    clearAutoAdvanceTimer()
    // Manual highlight mode suspends AR auto-advance too — the whole point
    // of taking manual control is that nothing keeps walking the sequence
    // out from under the user.
    if (!settings.autoAdvance || phase !== 'live' || !state.selectedGoal || state.highlightMode === 'manual') return
    autoAdvanceTimer = window.setTimeout(() => {
      autoAdvanceTimer = null
      advanceStep()
    }, AUTO_ADVANCE_MS)
  }

  // ---- Settings popover open/close ----

  function closeSettingsPopover(): void {
    settingsOpen = false
    settingsPopover.hidden = true
  }

  function toggleSettings(): void {
    settingsOpen = !settingsOpen
    settingsPopover.hidden = !settingsOpen
    if (settingsOpen) closeSheetsInternal()
  }

  function onDocPointerDown(ev: PointerEvent): void {
    if (!settingsOpen) return
    const target = ev.target as Node
    if (settingsPopover.contains(target) || settingsBtn.contains(target)) return
    closeSettingsPopover()
  }
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('visibilitychange', handleVisibilityChangeForWakeLock)

  // ---- Bottom sheets (machine picker / goal browser — DESIGN-NOTES §2.7-8,
  //      shared chrome factored into ui/sheet.ts; content built here since
  //      it's tightly coupled to AR phase transitions) ----

  function closeSheetsInternal(): void {
    sheetHandle?.destroy()
    sheetHandle = null
    sheetOpen = null
  }

  function closeSheets(): void {
    closeSheetsInternal()
  }

  function buildMachineSheetBody(): HTMLElement {
    const wrap = document.createElement('div')

    for (const m of sortedByName(state.machines)) {
      const row = el('button', 'ar-msheet-row')
      row.type = 'button'
      const selected = state.machine?.id === m.id
      if (selected) row.classList.add('selected')
      const body = el('div', 'ar-msheet-row-body')
      body.append(el('div', 'ar-msheet-row-title', m.shortTitle), el('div', 'ar-msheet-row-sub', m.name))
      const check = el('div', 'ar-msheet-row-check', selected ? '✓' : '')
      row.append(body, check)
      row.addEventListener('click', () => {
        closeSheets()
        void switchMachine(m)
      })
      wrap.appendChild(row)
    }
    return wrap
  }

  function buildGoalRow(g: Goal, color: string): HTMLElement {
    const row = el('button', 'ar-gsheet-row')
    row.type = 'button'
    const bar = el('span', 'ar-gsheet-row-bar')
    bar.style.background = color
    const body = el('div', 'ar-gsheet-row-body')
    const metaParts = [`${g.steps.length} step${g.steps.length === 1 ? '' : 's'}`]
    if (g.reward) metaParts.push(g.reward)
    // Leading fx glyph (2026-07-28 review finding 4) — matches app.ts's
    // renderGoalRow and map2d's buildGoalRow, both of which already carry
    // this convention; this sheet's row was missing it.
    const title = `${glyphFor(g.fx ?? state.data?.defaultFx)}  ${g.title}`
    body.append(el('div', 'ar-gsheet-row-title', title), el('div', 'ar-gsheet-row-meta', metaParts.join(' · ')))
    const pips = el('span', 'ar-gsheet-row-pips', pipsTextWithEmpty(g.difficulty))
    const check = el('span', 'ar-gsheet-row-check', state.selectedGoal?.id === g.id ? '✓' : '')
    row.append(bar, body, pips, check)
    row.addEventListener('click', () => {
      state.select(g)
      closeSheets()
    })
    return row
  }

  function buildGoalSheetBody(): HTMLElement {
    const wrap = document.createElement('div')
    const allGoals = state.data?.goals ?? []
    const filtered = filterGoalsByBallPosition(allGoals, state.shotsByID, state.ballPosition)

    if (filtered.length === 0) {
      wrap.appendChild(el('div', 'state-message', 'No goals loaded for this machine yet.'))
      return wrap
    }

    const byCategory = new Map<GoalCategory, Goal[]>()
    for (const cat of CATEGORY_ORDER) byCategory.set(cat, [])
    for (const g of filtered) byCategory.get(g.category)?.push(g)

    for (const cat of CATEGORY_ORDER) {
      const goals = byCategory.get(cat)
      if (!goals || goals.length === 0) continue
      const meta = CATEGORY_META[cat]
      const header2 = el('div', 'ar-gsheet-section')
      const dot = el('span', 'ar-gsheet-section-dot')
      dot.style.background = meta.color
      header2.append(dot, el('span', 'ar-gsheet-section-label', meta.label.toUpperCase()))
      wrap.appendChild(header2)
      for (const g of goals) wrap.appendChild(buildGoalRow(g, meta.color))
    }
    return wrap
  }

  function openMachineSheet(): void {
    if (phase === 'idle') return
    closeSettingsPopover()
    if (sheetOpen === 'machines') {
      closeSheets()
      return
    }
    closeSheetsInternal()
    sheetOpen = 'machines'
    sheetHandle = createSheet(root, {
      title: 'Machines',
      meta: `${state.machines.length} IN CATALOG`,
      maxHeightVh: 56,
      onDismiss: closeSheets,
    })
    sheetHandle.setBody(buildMachineSheetBody())
  }

  function openGoalSheet(): void {
    if (phase === 'idle' || !state.data) return
    closeSettingsPopover()
    if (sheetOpen === 'goals') {
      closeSheets()
      return
    }
    closeSheetsInternal()
    sheetOpen = 'goals'
    sheetHandle = createSheet(root, {
      title: 'Goals',
      meta: `${(state.machine?.shortTitle ?? '').toUpperCase()} · ${state.data.goals.length} LOADED`,
      maxHeightVh: 62,
      onDismiss: closeSheets,
    })
    sheetHandle.setBody(buildGoalSheetBody())
  }

  // ---- Event wiring ----
  startBtn.addEventListener('click', () => void startCamera())
  howToBtn.addEventListener('click', () => {
    void import('../ui/howto').then(({ openHowTo }) => openHowTo())
  })
  glossaryBtn.addEventListener('click', () => {
    void import('../ui/glossary').then(({ openGlossary }) => openGlossary())
  })
  machinePill.addEventListener('click', openMachineSheet)
  goalPill.addEventListener('click', () => {
    dismissGoalPillCallout()
    openGoalSheet()
  })
  goalPillCalloutBubble.addEventListener('click', dismissGoalPillCallout)
  settingsBtn.addEventListener('click', toggleSettings)
  exitBtn.addEventListener('click', stopCamera)
  cameraErrorRetryBtn.addEventListener('click', retryCamera)
  cameraErrorExitBtn.addEventListener('click', stopCamera)
  stepPrevBtn.addEventListener('click', onStepPrev)
  stepNextBtn.addEventListener('click', onStepNext)
  stepReadout.addEventListener('click', onStepReadoutClick)
  freezeToggleBtn.addEventListener('click', toggleFreeze)
  recalBtn.addEventListener('click', recalibrate)

  // ---- Redraw on state changes (machine/goal/step) ----
  const unsubscribe = state.onChange(() => {
    renderHeader()
    renderStepRow()
    resetAutoAdvanceTimer()
    if (phase === 'freeze') renderFreeze()
  })

  // ---- Visibility (pause the live loop while the AR tab isn't shown) ----
  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1]
      hostVisible = entry ? entry.isIntersecting : true
      if (hostVisible && phase === 'live') startLiveLoop()
    },
    { threshold: 0 },
  )
  intersectionObserver.observe(host)

  // ---- Resize (freeze mode only — live recomputes cover-fit every tick;
  //      calibrate.ts owns its own resize handling internally) ----
  const resizeObserver = new ResizeObserver(() => {
    if (phase === 'freeze') renderFreeze()
  })
  resizeObserver.observe(root)

  // ---- Initial render ----
  showOnly('idle')

  return {
    destroy(): void {
      if (destroyed) return
      destroyed = true
      bumpGen()
      clearAutoAdvanceTimer()
      clearCameraWatchdog()
      if (goalPillCalloutTimer !== null) window.clearTimeout(goalPillCalloutTimer)
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('visibilitychange', handleVisibilityChangeForWakeLock)
      releaseWakeLock()
      stopLiveLoop()
      unsubscribe()
      intersectionObserver.disconnect()
      resizeObserver.disconnect()
      closeSheetsInternal()
      calibrateHandle?.destroy()
      tracker?.destroy()
      unsubscribeCameraState?.()
      unsubscribeCameraState = null
      feed?.stop()
      document.body.classList.remove('ar-immersive')
      root.remove()
    },
  }
}
