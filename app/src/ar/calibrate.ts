// ar/calibrate.ts — corner calibration UI + state.
// Native sources:
//   PinballGenieAndroid/.../ar/ArSessionManager.kt   (mode/state machine, tap
//     order, accept/"Start over" semantics)
//   PinballGenieAndroid/.../ar/PlayfieldCalibration.kt (tapOrder labels)
//   PinballGenieAndroid/.../ui/CalibrationCard.kt    (card copy/layout)
//
// 2026-07-11 field-test fix pass: manual tap-to-place is now the ONLY
// calibration mode. The auto-detect ("beta") quad-proposal flow — the
// >=20%-viewport area gate, the 5-consecutive-hit stability accumulator
// (SPEC-AUTOCAL), and its ar/quaddetect.ts worker wiring — is removed from
// this module entirely per explicit field-test direction ("not a feature we
// need yet" — rolo, 2026-07-10; it was defaulting users into a glossy-glass
// quad detector that never locked on, with manual tap only surfacing after
// an 8s hint delay). ar/quaddetect.ts + ar/quaddetect.worker.ts stay on disk,
// unimported, so they tree-shake out of the AR bundle. `setProposal()` (the
// integration point for an external detection source) is removed from the
// returned handle for the same reason — nothing calls it anymore.
//
// Deviation from native (intentional, called out explicitly in this port's
// original build instructions, still true for the manual flow): native's
// tap-to-calibrate auto-commits on the 4th tap; here the user can refine
// first via draggable 44px corner handles, then an explicit Accept step.
// Native's Undo/"Start over" copy is kept verbatim.
//
// renderCornerOrderDiagram() (inline SVG, numbered dots 1->4 on a playfield
// outline matching the BL/BR/TR/TL tap order) is exported so ui/howto.ts can
// reuse it for its corner-tapping step — see that module's import.
//
// 2026-07-28 chrome redesign (design_handoff_shot_coach README §4 + binding
// correction 13): the old single bottom HUD bar (diagram + text + actions)
// is split into a TOP instruction pill (eyebrow, live single-line
// instruction, 4 vertically-stacked progress dots) and a BOTTOM action row
// (demo hint + Undo/Start over/Accept as three always-present, equal-width
// buttons) — clear of the corners entirely, on both ends of the stage. The
// per-corner mini-diagram is dropped from THIS module's own HUD (superseded
// by the progress dots + the four static corner-guide rings drawn on the
// outline canvas, see drawCornerGuides() below) but renderCornerOrderDiagram
// itself is untouched and still exported for ui/howto.ts.

import './calibrate.css'
import type { CameraFeed, CameraState } from './camera'

export interface Calibration {
  corners: [number, number][] /* BL,BR,TR,TL in video-display px */
}

// Label + a short caps parenthetical, combined into ONE line by
// manualMessage() below to match the handoff copy verbatim: "Tap the
// BOTTOM-LEFT (NEAR THE LEFT FLIPPER) corner of the playfield glass — n/4"
// (design_handoff_shot_coach README §4 / binding correction 13).
const TAP_ORDER = [
  { label: 'BOTTOM-LEFT', paren: 'NEAR THE LEFT FLIPPER' },
  { label: 'BOTTOM-RIGHT', paren: 'NEAR THE RIGHT FLIPPER' },
  { label: 'TOP-RIGHT', paren: 'BACK RIGHT, BY THE BACK PANEL' },
  { label: 'TOP-LEFT', paren: 'BACK LEFT, BY THE BACK PANEL' },
]

const AMBER = '#f5a623'
const BAD_QUAD_RED = '#ff3b30'
const TOUCH_SLOP_PX = 10 // web has no ViewConfiguration.scaledTouchSlop; reasonable default
const LONG_PRESS_MS = 500 // matches ViewConfiguration.getLongPressTimeout()'s ballpark
const MIN_CORNER_SPACING_PX = 8
const MIN_QUAD_AREA_PX2 = 1000
const STAGE_RESIZE_JITTER_PX = 24 // safe-area/URL-bar micro-shifts under this are noise, not a real resize

// Four VISUAL corner-guide rings (correction 13) — screen-fraction positions
// on the STAGE, in BL/BR/TR/TL order to mirror TAP_ORDER. Guides only: no
// snapping, no auto-advance, free tapping unchanged. y is screen-down (0 =
// top edge), matching README §4's "top corners at v=0.215, bottom corners
// at v=0.845" — both clear of the redesigned top pill and bottom action row.
const GUIDE_FRACS: { x: number; y: number }[] = [
  { x: 0.08, y: 0.845 }, // BL
  { x: 0.92, y: 0.845 }, // BR
  { x: 0.92, y: 0.215 }, // TR
  { x: 0.08, y: 0.215 }, // TL
]
const GUIDE_RING_RADIUS = 16

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Pure validity check on 4 tapped corners, BL/BR/TR/TL order, in display px
 * (y-down screen coords — the stage's bottom edge has the LARGER y). Returns
 * null when the quad is sane, else a short human-readable reason. Exported
 * for tests.
 *
 * Insane when:
 *  (a) any two corners sit closer than MIN_CORNER_SPACING_PX (a fat-finger
 *      double-tap — near-coincident points make the DLT solver's pivot
 *      near-singular, per ar/homography.ts's own degenerate-input guard);
 *  (b) the 4 consecutive-edge cross products aren't all the same sign, or
 *      that shared sign isn't the one a CORRECT BL,BR,TR,TL tap order
 *      produces. This single check catches both a self-intersecting bowtie
 *      (whose edge signs mix) and a fully mirrored/clockwise tap order
 *      (whose signs are uniform but flipped). Concrete verification, y-down:
 *      BL=(0,100) BR=(100,100) TR=(100,0) TL=(0,0). Walking BL->BR->TR->TL,
 *      each consecutive edge pair's z = dx1*dy2 - dy1*dx2 evaluates to
 *      -10000 at all 4 vertices — so a correct tap order is all-NEGATIVE z
 *      here, and anything else (mixed signs, or all-positive) is wrong;
 *  (c) shoelace area < MIN_QUAD_AREA_PX2 — a near-collinear/degenerate quad
 *      that dodges both checks above but is still too small to calibrate
 *      against.
 */
export function quadProblem(corners: [number, number][]): string | null {
  if (corners.length !== 4) return 'Need exactly 4 corners'

  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const a = corners[i]!
      const b = corners[j]!
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < MIN_CORNER_SPACING_PX) return 'Two corners are on top of each other'
    }
  }

  for (let i = 0; i < 4; i++) {
    const a = corners[i]!
    const b = corners[(i + 1) % 4]!
    const c = corners[(i + 2) % 4]!
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (z >= 0) return 'Corners are crossed or out of order — tap BOTTOM-LEFT, BOTTOM-RIGHT, TOP-RIGHT, TOP-LEFT'
  }

  let area2 = 0
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!
    const b = corners[(i + 1) % 4]!
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  if (Math.abs(area2) / 2 < MIN_QUAD_AREA_PX2) return 'Corners are too close together'

  return null
}

function textEl(cls: string, text: string): HTMLParagraphElement {
  const el = document.createElement('p')
  el.className = cls
  el.textContent = text
  return el
}

function buttonEl(label: string, kind: 'primary' | 'outline', onClick: () => void, disabled = false): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `pg-cal-btn pg-cal-btn-${kind}`
  btn.textContent = label
  btn.disabled = disabled
  btn.addEventListener('click', onClick)
  return btn
}

function cameraErrorMessage(err?: Error): string {
  const name = err?.name
  if (name === 'NotAllowedError') return 'Camera access denied — allow it in your browser settings and reload'
  if (name === 'NotFoundError') return 'No camera found on this device'
  return 'Camera unavailable — reopen the app'
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Inline SVG: a playfield outline (trapezoid, narrow at the back) with 4
 * numbered dots at the corners in tap order — 1=BL, 2=BR, 3=TR, 4=TL. Shared
 * between this module's manual-flow HUD and ui/howto.ts's corner-tapping
 * step so the two reinforce the same visual (see this file's header note).
 *
 * `activeCorner` (1-based, optional — field-test fix 2026-07-27): dims the
 * other dots and rings the one the user is being asked to tap next, so the
 * shrunken HUD-bar version of this diagram still reads at a glance. Omitted
 * (ui/howto.ts's call) it renders all four dots equally, exactly as before.
 */
export function renderCornerOrderDiagram(activeCorner?: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 120 150')
  svg.setAttribute('width', '84')
  svg.setAttribute('height', '105')
  svg.setAttribute('class', 'pg-cal-diagram')
  svg.setAttribute('aria-hidden', 'true')

  const outline = document.createElementNS(SVG_NS, 'polygon')
  outline.setAttribute('points', '12,138 108,138 90,12 30,12')
  outline.setAttribute('fill', 'rgba(245,166,35,0.08)')
  outline.setAttribute('stroke', AMBER)
  outline.setAttribute('stroke-width', '2')
  svg.appendChild(outline)

  const corners: { x: number; y: number; n: number }[] = [
    { x: 12, y: 138, n: 1 }, // BL
    { x: 108, y: 138, n: 2 }, // BR
    { x: 90, y: 12, n: 3 }, // TR
    { x: 30, y: 12, n: 4 }, // TL
  ]
  for (const c of corners) {
    const isActive = activeCorner === c.n
    const dimOthers = activeCorner !== undefined && !isActive

    const dot = document.createElementNS(SVG_NS, 'circle')
    dot.setAttribute('cx', String(c.x))
    dot.setAttribute('cy', String(c.y))
    dot.setAttribute('r', isActive ? '14' : '11')
    dot.setAttribute('fill', AMBER)
    if (dimOthers) dot.setAttribute('fill-opacity', '0.35')
    if (isActive) {
      dot.setAttribute('stroke', '#fff')
      dot.setAttribute('stroke-width', '3')
    }
    svg.appendChild(dot)

    const label = document.createElementNS(SVG_NS, 'text')
    label.setAttribute('x', String(c.x))
    label.setAttribute('y', String(c.y))
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('dominant-baseline', 'central')
    label.setAttribute('font-size', isActive ? '15' : '13')
    label.setAttribute('font-weight', '800')
    label.setAttribute('fill', '#1a1200')
    if (dimOthers) label.setAttribute('fill-opacity', '0.5')
    label.textContent = String(c.n)
    svg.appendChild(label)
  }
  return svg
}

export function createCalibrationUI(
  host: HTMLElement,
  feed: CameraFeed,
  onCalibrated: (c: Calibration) => void,
): { reset(): void; destroy(): void } {
  let destroyed = false
  let calibrated = false

  let manualCorners: [number, number][] = []

  // Stage-resize invalidation (field-test fix): iOS toolbar collapse/expand
  // or a rotation mid-calibration changes the stage's rect out from under
  // stored corners, which are in DISPLAY px relative to that rect — see
  // resizeCanvas() below. resizeNotice is transient UI state, cleared the
  // next time a tap successfully places a corner.
  let lastStageSize: { w: number; h: number } | null = null
  let resizeNotice = false

  let cameraState: CameraState = 'stopped'
  let cameraError: Error | undefined

  let handles: HTMLDivElement[] = []

  // ---- DOM ----
  const wrapper = document.createElement('div')
  wrapper.className = 'pg-cal-stage'

  const stage = wrapper // the positioned box everything else is relative to
  stage.appendChild(feed.video)
  // Re-parenting a live <video> can pause it on iOS — same nudge arview.ts
  // applies on the opposite (calibration -> live frame) move. Without this,
  // RECALIBRATE / switch-machine re-enter calibration over a frozen still.
  // Harmless when already playing (play() on a playing element is a no-op).
  void feed.video.play().catch(() => {})

  const canvas = document.createElement('canvas')
  canvas.className = 'pg-cal-canvas'
  stage.appendChild(canvas)
  const drawCtx = canvas.getContext('2d')

  const tapzone = document.createElement('div')
  tapzone.className = 'pg-cal-tapzone'
  stage.appendChild(tapzone)

  // Field-test fix 2026-07-27 (rolo, at a real machine): the old .pg-cal-card
  // was a tall centered card that covered the bottom ~40% of the camera view —
  // exactly where corners 1/2 (the flippers) sit — and swallowed their taps.
  //
  // 2026-07-28 chrome redesign (correction 13): that single bottom bar is now
  // TWO bars, both pointer-events:none at the container level (only the
  // action row's buttons re-enable pointer-events), so a machine framed clear
  // down to either screen edge stays fully tappable through both of them —
  // and the four corner-guide rings (drawCornerGuides(), drawn on the canvas
  // below) keep the actual tap targets clear of both bars entirely:
  //   - top instruction pill (.pg-cal-hud, name kept for e2e-selector
  //     continuity): eyebrow, the live single-line instruction, 4
  //     vertically-stacked progress dots.
  //   - bottom action row (.pg-cal-hud-bottom): the demo-discovery hint above
  //     Undo / Start over / Accept — three always-present, equal-width
  //     buttons (disabled state carries the "nothing to act on yet" cases
  //     instead of the buttons popping in/out).
  const topCard = document.createElement('div')
  topCard.className = 'pg-cal-hud'
  stage.appendChild(topCard)

  const bottomCard = document.createElement('div')
  bottomCard.className = 'pg-cal-hud-bottom'
  stage.appendChild(bottomCard)

  // Persistent slots (a11y fix): previously updateCardDom() did
  // card.innerHTML='' and rebuilt everything, including the aria-live text
  // wrapper, on every render — VoiceOver (and other AT) track a live
  // region by DOM node identity, so recreating the node each time made
  // announcements unreliable, and the wholesale clear threw focus to
  // <body> whenever a keyboard/AT user had focus inside the card (e.g. on
  // Undo). These slots are built ONCE and kept for the component's whole
  // lifetime; updateCardDom() below only ever replaces their CHILDREN
  // (or, for the eyebrow/hint text nodes, their textContent), never the
  // slot elements themselves.
  const eyebrow = document.createElement('p')
  eyebrow.className = 'pg-cal-hud-eyebrow'
  eyebrow.textContent = 'LINE UP THE MACHINE'

  const textWrap = document.createElement('div')
  textWrap.className = 'pg-cal-hud-text'
  textWrap.setAttribute('aria-live', 'polite')

  const dotsWrap = document.createElement('div')
  dotsWrap.className = 'pg-cal-hud-dots'
  const dotEls: HTMLSpanElement[] = []
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('span')
    dot.className = 'pg-cal-hud-dot'
    dotsWrap.appendChild(dot)
    dotEls.push(dot)
  }

  topCard.append(eyebrow, textWrap, dotsWrap)

  const hintEl = document.createElement('p')
  hintEl.className = 'pg-cal-hud-hint'

  const actionsSlot = document.createElement('span')
  actionsSlot.className = 'pg-cal-hud-actions'

  bottomCard.append(hintEl, actionsSlot)

  host.appendChild(wrapper)

  // ---- Canvas sizing (device-pixel-ratio aware) ----
  function resizeCanvas(): void {
    const rect = stage.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const prevSize = lastStageSize
    lastStageSize = { w: rect.width, h: rect.height }
    if (prevSize) {
      const dw = Math.abs(rect.width - prevSize.w)
      const dh = Math.abs(rect.height - prevSize.h)
      // Only a real resize (>STAGE_RESIZE_JITTER_PX) with in-progress,
      // unaccepted taps needs invalidating — jitter under that, an empty
      // corner set, or an already-accepted quad have nothing to corrupt.
      if ((dw > STAGE_RESIZE_JITTER_PX || dh > STAGE_RESIZE_JITTER_PX) && manualCorners.length > 0 && !calibrated) {
        manualCorners = []
        resizeNotice = true
        render()
        return
      }
    }
    redrawOutline()
  }
  const resizeObserver = new ResizeObserver(() => resizeCanvas())
  resizeObserver.observe(stage)

  // ---- Camera state ----
  const unsubscribeCameraState = feed.onStateChange((s, err) => {
    if (destroyed) return
    cameraState = s
    cameraError = err
    render()
  })
  void feed.start()

  // ---- Video metadata self-heal (R3): cameraState can flip to 'live'
  // before the <video> element's own dimensions are populated
  // (videoWidth/videoHeight still 0) — updateCardDom()'s Accept-disable
  // branch below needs a re-render once they land, and camera-state/tap
  // changes alone don't guarantee one arrives. 'loadedmetadata' is that
  // signal directly; removed in destroy() below.
  function onVideoMeta(): void {
    render()
  }
  feed.video.addEventListener('loadedmetadata', onVideoMeta)

  // ---- Manual tap-to-place (with slop/long-press guard, mirroring
  //      ArSessionManager.kt's createGlView touch listener) ----
  let downPos: { x: number; y: number } | null = null
  let downTime = 0
  let isTap = true

  tapzone.addEventListener('pointerdown', (ev) => {
    downPos = { x: ev.clientX, y: ev.clientY }
    downTime = performance.now()
    isTap = true
  })
  tapzone.addEventListener('pointermove', (ev) => {
    if (!downPos) return
    if (Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) > TOUCH_SLOP_PX) isTap = false
  })
  tapzone.addEventListener('pointerup', (ev) => {
    const held = performance.now() - downTime
    const wasTap = isTap
    downPos = null
    if (!wasTap || held >= LONG_PRESS_MS) return
    if (calibrated || manualCorners.length >= 4) return
    // A real video frame must be on screen before a tap means anything —
    // without this, taps land invisibly against a black "Starting
    // camera…" stage and get silently baked into the calibration.
    if (cameraState !== 'live') return
    const rect = stage.getBoundingClientRect()
    manualCorners.push([clamp(ev.clientX - rect.left, 0, rect.width), clamp(ev.clientY - rect.top, 0, rect.height)])
    resizeNotice = false
    render()
  })

  // ---- Draggable corner handles ----
  const ARROW_STEP_PX = 2
  const ARROW_STEP_SHIFT_PX = 10

  function makeHandle(index: number, onMove: (i: number, x: number, y: number) => void): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'pg-cal-handle'
    el.setAttribute('role', 'slider')
    el.setAttribute('aria-label', `Corner ${index + 1}`)
    el.tabIndex = 0
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      el.setPointerCapture(ev.pointerId)
      const move = (mv: PointerEvent): void => {
        const rect = stage.getBoundingClientRect()
        const x = clamp(mv.clientX - rect.left, 0, rect.width)
        const y = clamp(mv.clientY - rect.top, 0, rect.height)
        onMove(index, x, y)
      }
      const up = (uv: PointerEvent): void => {
        el.releasePointerCapture(uv.pointerId)
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        // HUD refresh on drag END only (A3) — never during pointermove,
        // which would thrash a full render() every pixel of the drag.
        // syncHandles() leaves existing handle elements untouched when the
        // corner count is unchanged (only their positions update), so this
        // render() can never yank pointer capture out from under a handle
        // or steal focus mid-drag.
        render()
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    })
    el.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? ARROW_STEP_SHIFT_PX : ARROW_STEP_PX
      let dx = 0
      let dy = 0
      if (ev.key === 'ArrowLeft') dx = -step
      else if (ev.key === 'ArrowRight') dx = step
      else if (ev.key === 'ArrowUp') dy = -step
      else if (ev.key === 'ArrowDown') dy = step
      else return
      ev.preventDefault()
      const p = manualCorners[index]
      if (!p) return
      const rect = stage.getBoundingClientRect()
      onMove(index, clamp(p[0] + dx, 0, rect.width), clamp(p[1] + dy, 0, rect.height))
      // Each key press is a discrete, already-complete move (unlike a
      // pointermove stream) — refresh the HUD the same way drag-end does.
      render()
    })
    return el
  }

  function onManualHandleMove(i: number, x: number, y: number): void {
    manualCorners[i] = [x, y]
    redrawOutline()
    positionHandles(manualCorners)
  }

  function positionHandles(points: [number, number][]): void {
    handles.forEach((h, i) => {
      const p = points[i]
      if (!p) return
      h.style.left = `${p[0]}px`
      h.style.top = `${p[1]}px`
      h.setAttribute('aria-valuetext', `Corner ${i + 1} at ${Math.round(p[0])}, ${Math.round(p[1])}`)
    })
  }

  function syncHandles(points: [number, number][], onMove: (i: number, x: number, y: number) => void): void {
    while (handles.length < points.length) {
      const idx = handles.length
      const h = makeHandle(idx, onMove)
      handles.push(h)
      stage.appendChild(h)
    }
    while (handles.length > points.length) {
      handles.pop()?.remove()
    }
    positionHandles(points)
  }

  function clearHandles(): void {
    handles.forEach((h) => h.remove())
    handles = []
  }

  // ---- Canvas drawing ----

  /** Four static, non-interactive guide rings (correction 13) at
   *  GUIDE_FRACS' screen fractions of the current stage size — purely
   *  visual: no snapping, no auto-advance, tapping anywhere is unaffected.
   *  Drawn under the in-progress outline; hidden once calibrated (nothing
   *  left to guide). */
  function drawCornerGuides(w: number, h: number): void {
    if (!drawCtx) return
    drawCtx.save()
    drawCtx.setLineDash([5, 5])
    drawCtx.lineWidth = 1.5
    drawCtx.strokeStyle = 'rgba(255,255,255,0.3)'
    for (const g of GUIDE_FRACS) {
      drawCtx.beginPath()
      drawCtx.arc(g.x * w, g.y * h, GUIDE_RING_RADIUS, 0, Math.PI * 2)
      drawCtx.stroke()
    }
    drawCtx.restore()
  }

  function redrawOutline(): void {
    if (!drawCtx) return
    const dpr = window.devicePixelRatio || 1
    drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawCtx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)

    if (!calibrated) drawCornerGuides(canvas.width / dpr, canvas.height / dpr)

    const pts = manualCorners
    if (!pts || pts.length < 2) return
    const solid = manualCorners.length === 4
    const problem = solid ? quadProblem(manualCorners) : null
    drawCtx.lineWidth = 2
    drawCtx.strokeStyle = solid ? (problem ? BAD_QUAD_RED : AMBER) : 'rgba(255,255,255,0.6)'
    drawCtx.setLineDash(solid ? [] : [8, 6])
    drawCtx.beginPath()
    pts.forEach((p, i) => (i === 0 ? drawCtx.moveTo(p[0], p[1]) : drawCtx.lineTo(p[0], p[1])))
    if (pts.length === 4) drawCtx.closePath()
    drawCtx.stroke()
  }

  // ---- Actions ----
  function acceptManual(): void {
    if (calibrated) return // guard a double-tap on Accept (already committed once)
    if (manualCorners.length !== 4) return
    // Backstop only — updateCardDom() already renders Accept disabled
    // whenever this is non-null, so a real pointer/keyboard user can't
    // reach this branch; kept in case a future caller invokes Accept some
    // other way.
    if (quadProblem(manualCorners) !== null) return
    calibrated = true
    const corners = manualCorners.map((c) => [c[0], c[1]] as [number, number])
    render()
    onCalibrated({ corners })
  }
  function undoManual(): void {
    manualCorners.pop()
    render()
  }
  function fullReset(): void {
    calibrated = false
    manualCorners = []
    render()
  }

  // ---- Render ----

  /** Fills the persistent textWrap slot (see its construction comment
   *  above) with a step line, optionally a second dimmer detail line —
   *  omit `detail` for the single-line handoff-copy messages (correction
   *  13). Callers never create a wrapper — updateCardDom() below clears
   *  textWrap's CHILDREN before each render pass; the aria-live node itself
   *  never moves. */
  function hudText(step: string, detail = ''): void {
    textWrap.appendChild(textEl('pg-cal-hud-step', step))
    if (detail) textWrap.appendChild(textEl('pg-cal-hud-detail', detail))
  }

  /** Appends into the persistent actionsSlot (cleared by updateCardDom()
   *  before each render pass, same pattern as hudText()). */
  function hudActions(...buttons: HTMLButtonElement[]): void {
    actionsSlot.append(...buttons)
  }

  /** Sets the top pill's live instruction text for the manual (uncalibrated,
   *  camera-live) phase — handoff copy verbatim (correction 13): a single
   *  combined line per corner, then 'Drag to refine, then Accept.' once all
   *  4 are placed and the quad's ready to accept. The two n===4 DIAGNOSTIC
   *  sub-states (bad quad / video not ready yet) aren't part of that adopted
   *  copy and keep their existing two-line step+detail explanations. */
  function manualMessage(n: number): void {
    if (n < 4) {
      if (n === 0 && resizeNotice) {
        // Stage-resize invalidation (B5): corners were just cleared out
        // from under the user — say why instead of silently restarting
        // the first prompt as if nothing happened.
        hudText('Screen changed — start over', 'Corner taps reset because the view resized (rotation/toolbar)')
      } else {
        const order = TAP_ORDER[n]!
        hudText(`Tap the ${order.label} (${order.paren}) corner of the playfield glass — ${n}/4`)
      }
    } else {
      const problem = quadProblem(manualCorners)
      if (problem) {
        // Quad validation at Accept (A3): self-intersecting/mirrored taps
        // produce silent garbage overlays downstream — block Accept and
        // say why instead of letting it through.
        hudText('Corners look wrong', `${problem}. Drag the handles to fix, or Start over`)
      } else if (feed.video.videoWidth === 0) {
        // No Accept without a real video (A4) — cameraState can be 'live'
        // before the first frame has actual dimensions; the 'loadedmetadata'
        // listener wired above (R3) re-renders once they land, so this
        // self-heals without the user needing to tap or do anything else.
        hudText('All 4 corners placed', 'Camera still starting — one moment')
      } else {
        hudText('Drag to refine, then Accept.')
      }
    }
  }

  function updateDots(n: number): void {
    dotEls.forEach((dot, i) => dot.classList.toggle('pg-cal-hud-dot-filled', i < n))
  }

  function updateCardDom(): void {
    // Focus preservation (a11y batch): clearing the slots' children below
    // used to throw focus to <body> whenever the user had focus on a card
    // button (e.g. Undo) — note the focused button's label first so it can
    // be restored on its freshly-rebuilt replacement.
    const activeEl = document.activeElement
    const activeLabel = activeEl instanceof HTMLElement && bottomCard.contains(activeEl) ? activeEl.textContent : null

    textWrap.innerHTML = ''
    actionsSlot.innerHTML = ''

    // The bottom action row (hint + Undo/Start over/Accept) only makes sense
    // once there's something to act on: camera live, not yet calibrated —
    // exactly the phase manualMessage()/manualCorners apply to. Every other
    // phase (starting/suspended/error, or post-Accept 'Locking on…') hides
    // it entirely, same gating as before this redesign.
    const manualPhase = cameraState === 'live' && !calibrated
    const n = manualPhase ? manualCorners.length : 0
    updateDots(n)

    if (cameraState === 'error') {
      hudText('Camera problem', cameraErrorMessage(cameraError))
    } else if (cameraState !== 'live') {
      hudText('Line up the machine', cameraState === 'suspended' ? 'Camera paused' : 'Starting camera…')
    } else if (calibrated) {
      // Buttonless progress state (R5) — this used to show 'Locked on' plus
      // a Recalibrate button that called this module's LOCAL fullReset().
      // arview.ts never learned about that reset (sessionGen isn't bumped),
      // so the onCalibrated() continuation it's mid-await on — tracker.init(),
      // now guaranteed to resolve, up to ~30s later — would land after the
      // user had already restarted here and yank them back out of it. This
      // affordance has always been broken post-Accept; arview.ts owns
      // recovery from here on, this component doesn't get a say once
      // onCalibrated() has fired. Escape hatches remain: the header's ✕
      // Exit AR bumps sessionGen and tears down; a tracker.init() failure
      // falls through to live + the STATIC banner; onCalibrated()'s
      // degenerate-catch calls this handle's reset() (below), which is what
      // actually returns this UI to corner-1.
      hudText('Locking on…', 'Loading the tracking engine — first run can take a few seconds')
    } else {
      manualMessage(n)
    }

    bottomCard.style.display = manualPhase ? '' : 'none'
    if (manualPhase) {
      // Demo discoverability (C14): only at the very first prompt, before
      // any commitment to a real machine. :empty{display:none} in
      // calibrate.css collapses the row's gap when there's nothing to show.
      hintEl.textContent = n === 0 ? 'NO MACHINE HANDY? TAP THE CORNERS OF ANY TABLE TO DEMO.' : ''
      const problem = n === 4 ? quadProblem(manualCorners) : null
      const acceptDisabled = n < 4 || problem !== null || feed.video.videoWidth === 0
      hudActions(
        buttonEl('Undo', 'outline', undoManual, n === 0),
        buttonEl('Start over', 'outline', fullReset, n === 0),
        buttonEl('Accept', 'primary', acceptManual, acceptDisabled),
      )
    } else {
      hintEl.textContent = ''
    }

    if (activeLabel) {
      const restored = Array.from(actionsSlot.querySelectorAll('button')).find((b) => b.textContent === activeLabel)
      restored?.focus()
    }
  }

  function updateHandles(): void {
    if (calibrated || cameraState !== 'live') {
      clearHandles()
      return
    }
    syncHandles(manualCorners, onManualHandleMove)
  }

  function render(): void {
    if (destroyed) return
    updateCardDom()
    redrawOutline()
    updateHandles()
  }

  resizeCanvas()
  render()

  return {
    reset(): void {
      if (!destroyed) fullReset()
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      unsubscribeCameraState()
      feed.video.removeEventListener('loadedmetadata', onVideoMeta)
      resizeObserver.disconnect()
      wrapper.remove()
    },
  }
}
