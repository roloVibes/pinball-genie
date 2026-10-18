// Port of the schematic 2D playfield map. Canonical source:
//   PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/ui/Playfield2DView.kt
//   (Playfield2DView composable, playfieldRect, drawPlayfieldBackground,
//   drawShotDots — the launchUV/launchPoint call into OverlayDrawing.drawGoalOverlay
//   is ported into this file's render loop directly rather than the Compose
//   call site).
//
// SPEC-PATHVIZ: "The change is shared by BOTH render surfaces automatically —
// the AR overlay and the 2D map both draw through OverlayDrawing.drawGoal ...
// keep it that way (no surface-specific forks)." This file draws its goal
// path by calling drawGoalOverlay from ./drawing — no duplicated routing/
// rendering logic.
//
// 2026-07-13 ("remove the BALL AT selector"): this file used to also draw an
// always-visible "BALL AT" marker (ring + dot + label) at the selected
// BallPosition anchor, independent of whether a goal was selected — a
// web-only addition (the native apps only ever draw a launch dot as part of
// drawGoalOverlay, i.e. only with a goal selected). That marker is REMOVED:
// ballPosition is now a fixed 'any' (state.ts's header note) with no user
// picker, and a goal's own route already marks where it starts (its step-1
// badge, drawn by drawGoalOverlay below) — a separate always-on marker with
// nothing to distinguish is just clutter now.
//
// 2026-07-12 design turns t12/t13 ("decluttering the 2D map"): drawShotDots
// used to fillText() every shot's name unconditionally — 23 labels collide
// on a busy machine like JAWS. Per t13 (the resolved combination of t12's
// three options), draw passes now are:
//   - ambient majors: a fixed, deterministic subset of "navigation anchor"
//     shot.types gets a dim ~8px micro-label at rest, capped at
//     MAX_AMBIENT_LABELS so a shot-heavy machine can't recreate the same
//     clutter; everything else is a bare ~22%-opacity dot.
//   - goal pass: while a goal is selected, its route's target shots (opts.
//     routeShotIDs) get a full ~9.5px/85%-opacity label instead, overriding
//     both the ambient-major and bare-dot treatments for those points.
//   - tap-to-identify (t12c): a lightweight canvas hit-test in mountMap2D
//     below shows any tapped shot's name as a transient callout, regardless
//     of major/route status.
// All label styling is canvas fillStyle/font/strokeText — not CSS, so no CSP
// concern (production style-src 'self' only blocks runtime <style>/inline-
// style injection, not canvas text).
//
// t14 (2026-07-28, SPEC-PATHVIZ point 2 — ring captions): drawGoalOverlay
// (./drawing) now captions each step's ring with its shot's name directly on
// the overlay, so the goal pass's route label above is redundant once a goal
// is selected — drawShotDots drops ALL its own labels (route AND ambient-
// major) whenever routeShotIDs is non-empty, demoting major dots to the bare
// 0.22-alpha treatment too, so only the overlay's own captions name
// anything. routeShotIDs absent/empty (no goal picked) is untouched.
//
// 2026-07-28 "Shot Coach" (design_handoff_shot_coach/README.md §2, corrected
// by the orchestrator's shotcoach-corrections.md — that file wins wherever it
// disagrees with the README):
//   - drawPlayfieldArt (README §2a) — a generic standard-body playfield
//     (orbits/ramps/pop nest/lane/guides/slings/flippers/apron), ported
//     verbatim from design_handoff_shot_coach/pg-render.js, drawn under the
//     dots at alpha 0.85 clipped to the card. MAP-ONLY (correction 1 — the
//     prototype draws it inside its own *simulated* AR camera feed; over
//     real video it would paint a fake playfield, so there is no AR call
//     site for this function).
//   - the card's category-colored radial glow is ported FIXED (correction
//     2): the prototype's own version clips to whatever path a PRIOR canvas
//     call happened to leave behind (the drain-apron strip, from the last
//     shape drawPlayfieldArt drew) — invisible in practice. This port
//     rebuilds the rounded-rect clip path immediately before painting the
//     glow.
//   - the goal pill (DOM, not canvas) + its goal sheet, layout changes
//     (44px top pad + CONTROLS_CLEARANCE bottom only with a goal selected,
//     playfieldRect margin 20), the relative tracer clock, and drawShotDots'
//     ambient-label treatment — see each block's own comment below
//     (correction 12; the emoji glyph chips were removed 2026-07-29).
//
// 2026-07-29 (AR removal — UNIMPORT pattern, app.ts's header comment): the
// Map-renderer prefs that used to live ONLY in ar/arview.ts's settings
// popover (Trail style / Ball tracer / Path labels / Line brightness) now
// have a Map-side home too — see mountMap2D's own "Settings popover" block
// below. Visual/interaction recipe (segmented control, toggle switch, range
// slider, popover shell) is ported verbatim from arview.ts's version, styled
// through map2d.css's own standalone `.map-settings-*` copy of arview.css's
// `.ar-settings-*` rules — same "self-contained, can't assume arview.css has
// been loaded" rationale as this file's existing `.map-gsheet-*` goal-sheet
// rows (see map2d.css's header). state.trailStyle/state.ballTracer are the
// SAME persisted AppState fields AR used to drive (setTrailStyle/
// setBallTracer, unchanged localStorage keys) — Map and the (still-on-disk,
// unmounted) AR view read/write the identical persisted prefs, they just
// don't currently run at the same time since AR has no UI route left in this
// web app. showLabels/lineBrightness are local to this mount, same as they
// were local to arview.ts's own `ArSettings` (never AppState fields, never
// persisted — see state.ts's own header note).

import './map2d.css'
import { CANVAS_LETTERBOX, CARD_GRADIENT_A, CARD_GRADIENT_B } from '../theme'
import type { AppState } from '../state'
import { filterGoalsByBallPosition } from '../state'
import type { GameData, Goal, GoalCategory, MapFn, PlayfieldZone, Shot } from '../models'
import {
  CATEGORY_COLOR,
  drawGoalOverlay,
  drawHaloLabel,
  goalBadgesAreInformative,
  HIGHLIGHT_HOLD_S,
  labelPacker,
  roundedRectPath,
  cardXBounds,
  type LabelBounds,
  LABEL_EDGE_PAD,
  rectXBounds,
} from './drawing'
import {
  approachLine,
  batsForZone,
  FLIPPER_SNAP,
  feedForTrim,
  isShotVisible,
  isZoneVisible,
  resolveFeedUV,
  resolveShootingAnchor,
} from './shotgeom'
import { createSheet, type SheetHandle } from '../ui/sheet'
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  goalReferencesPremiumLe,
  goalVisibleForTrim,
  isCharacterGoal,
  isPathless,
  machineHasVariants,
  orderByLadder,
  pipsTextWithEmpty,
  requiresChipText,
  requiresSpokenText,
  stepChips,
  stepProvenance,
} from '../ui/goalMeta'
import { glyphFor } from '../ui/fxGlyphs'
import { showToast } from '../ui/toast'
// isRendered is the overlay stack's own "is this actually on screen?" test
// (getClientRects, fail-soft on a DOM that has none). announceTrimChange uses
// it so a MODEL switch made from the Study rail cannot toast about this tab.
import { isRendered } from '../ui/overlayStack'
// ui/machinecard.ts's renderMachineCard/ShowGoalOnMap import (2026-08-11
// "card beside map" wide-viewport column) is REMOVED 2026-08-11 (owner:
// "Remove all cards. That feature has been removed.") — see this file's
// mountMap2D doc comment and app.ts's header for the full history.

const FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
/** BACKGLASS (P5, 2026-08-14) — the canvas half of styles.css's --display.
 *  Canvas `ctx.font` is a CSS font shorthand string and cannot read a custom
 *  property, so the stack is written out here exactly as the token declares
 *  it. The @font-face that loads 'Chakra Petch' lives in styles.css; canvas
 *  text uses whatever the document has already loaded, which is why every
 *  canvas label falls back gracefully (system-ui) for the swap window rather
 *  than blocking. */
const DISPLAY_STACK = `'Chakra Petch', 'DIN Alternate', system-ui, sans-serif`

/** "Major" shot anchors get an always-on ambient label at rest (t13); every
 *  other shot is a bare dot until the goal pass or a tap promotes it. Picked
 *  by shot.type: orbit/loop/ramp/lane/scoop/spinner are the playfield's
 *  named navigation shots a player orients by; standup/target-bank/bumpers/
 *  mech/captive-ball/drop-target/plunge are numerous, small, or single-
 *  purpose enough that labeling all of them was the original 23-label
 *  clutter t12/t13 set out to fix. This doesn't reproduce the design doc's
 *  own JAWS mockup label-for-label (that hand-drawn mockup labels one
 *  drop-target + the plunge lane while skipping 2 of its 4 ramps — not
 *  reconcilable with its own "orbits/ramps/lanes/mechs" prose); it's the
 *  closest stable, type-driven rule that reproduces the same *intent*
 *  ("named navigation shots stay legible, everything else declutters")
 *  across all ~56 machines' varying shot rosters, not just one 23-shot one. */
const MAJOR_SHOT_TYPES = new Set(['orbit', 'loop', 'ramp', 'lane', 'scoop', 'spinner'])

/** Soft cap on ambient major labels — DESIGN-NOTES §7's "~8 major anchors"
 *  target — so a machine with more majors-by-type than JAWS doesn't
 *  reintroduce the same clutter. */
const MAX_AMBIENT_LABELS = 8

const CALLOUT_MS = 2200
/** Generous tap-target radius in CSS px — shot dots themselves are only
 *  3.5px, far too small to reliably hit on a phone. */
const HIT_RADIUS = 16

export interface ShotDotsOptions {
  /** Shot ids belonging to the active goal's steps — labeled in full,
   *  brighter type (t13's "goal pass"), overriding both the ambient-major
   *  micro-label and the bare-dot default. Omit (or pass an empty set) for
   *  the no-goal ambient-only rest state; arview.ts's idle AR hint does this
   *  by not passing a 4th argument at all, so that call site is unaffected. */
  routeShotIDs?: ReadonlySet<string>
  /** Banner exclusion (2026-08-11, phase A12 item 3, additive) — the same
   *  reserved-band height as drawPlayfieldArt's own `topInset` param (TOP_PAD,
   *  the always-visible goal pill row): an ambient major-shot label that
   *  would otherwise land inside it flips below its dot instead. Default 0
   *  (omitting this reproduces the exact prior behavior — nothing to clear;
   *  arview.ts's idle AR hint, which never had a pill to clear, is
   *  unaffected). */
  topInset?: number
  /** Horizontal limits for this pass's labels. Callers that know the drawn
   *  card pass rectXBounds(rect); without it the labels fall back to asking
   *  the map, which is only correct for a MAIN-playfield map — see
   *  drawing.ts's rectXBounds. */
  labelBounds?: LabelBounds
  /** BACKGLASS (P5, 2026-08-14) — the ONE shot on this canvas that is LIT:
   *  its insert gets an amber halo + amber outline instead of the pale
   *  blue-white insert treatment every other shot gets.
   *
   *  Set by ui/study.ts ONLY, to the tour's current shot. The Map tab
   *  deliberately does not pass it: a selected goal's route can be five
   *  shots, drawGoalOverlay already lights the ACTIVE one with its own
   *  ring/badge/caption, and lighting all five here would blow the restraint
   *  rule (BACKGLASS §5 — max 2-3 lit elements per screen) on the exact
   *  screen that can least afford it. Omit for today's behaviour. */
  litShotID?: string | null
}

// Standard-body playfield is ~20.25" x 45"; keep that aspect ratio
// (Playfield2DView.kt: `val aspect = 20.25f / 45.0f`).
//
// EXPORTED 2026-08-15 for the Study tab's ALL level (ui/study.ts's
// computeStackRects), which stacks the main card and every deck card in one
// canvas and therefore has to convert between the two directions of UV. UV is
// NOT isotropic: u spans the table's 20.25" WIDTH and v its 45" LENGTH, so one
// unit of u is this number times one unit of v in drawn pixels. A zone's TRUE
// on-table shape is `PLAYFIELD_ASPECT * bounds.w / bounds.h`, and only a
// function that has this constant can compute it. Exported rather than copied
// because a second `20.25 / 45` in another module is exactly the kind of
// duplicated geometry this codebase's own comments keep warning about — and
// because playfieldRect (just below) already leaks the same number as its
// default argument.
export const PLAYFIELD_ASPECT = 20.25 / 45.0

// Native: `24f * density` (dp -> px). Per drawing.ts's header, this port
// treats 1 dp == 1 CSS px (device-pixel-ratio scaling happens separately, in
// the canvas transform below), so the literal carries over unchanged.
// 2026-07-28 Shot Coach (README §2b / correction 12): 24 -> 20, to match the
// design bundle's tighter card margin now that the goal pill/controls bar
// reserve their own bands (TOP_PAD / CONTROLS_CLEARANCE below) instead of
// leaning on this margin for clearance.
// 2026-07-31: 20 -> 8 (rolo: "the playfield needs to be bigger, the bottom
// should almost touch the buttons that guide you thru shots"). This margin is
// applied on ALL FOUR sides by playfieldRect(), and because the playfield is
// height-constrained at this aspect (0.45 w:h), every vertical pixel it gives
// back also widens the card by 0.45x. 20px of breathing room made sense when
// the map shared the screen with more chrome; now that the shell is tight it
// was just wasted table.
const MARGIN = 8

/** Vertical strip reserved for the ‹ › controls bar while a goal is selected
 *  (.map-step-controls: 44px tall at bottom:8px, styles.css — so its top edge
 *  is H - 52). Real machines put shots at the very bottom of the playfield
 *  (flippers, drain, plunger lane at v ≈ 0.01-0.05), so the playfield rect
 *  must SHRINK clear of the bar — drawing under it would hide those dots and
 *  hand their taps to the bar's buttons instead of tap-to-identify.
 *
 *  THE MATH (render() below; playfieldRect centers the rect inside the
 *  reduced height, then `rect.y += TOP_PAD / 2` pushes it down, so HALF the
 *  top band comes off the bottom edge too — the term that is easy to forget):
 *    card bottom = H - CONTROLS_CLEARANCE - TOP_PAD / 2 - MARGIN
 *                = H - 10 - 36 - 8 = H - 54
 *  i.e. 2px clear of the bar's top edge at H - 52 — that being the
 *  HEIGHT-constrained case (every phone); clamped on width instead, the card
 *  is shorter and its bottom sits higher still. Re-derive whenever
 *  TOP_PAD, MARGIN, or that CSS `bottom`/height changes — the same formula
 *  with a different TOP_PAD is exactly how ui/study.ts's BOTTOM_CLEARANCE,
 *  which copied this number, ended up drawing 4px UNDER its own bar until
 *  2026-08-14. The pill's height is pinned too (styles.css's
 *  .map-step-readout-* line-heights): a pill taller than 44px grows the
 *  bottom-anchored bar UPWARD and eats this clearance from the other side. */
// 2026-07-31: 40 -> 36, tracking .map-step-controls moving from bottom:12px to
// bottom:8px (styles.css). The bar is still 44px tall, so its top edge is now
// 52px above #map-host's bottom (was 56px); 36 keeps the shrunken rect's own
// bottom MARGIN (20px) 16px clear of it. Kept as an explicit constant rather
// than derived from the DOM because the playfield rect is computed before
// layout settles — but it MUST be re-checked whenever that CSS `bottom`
// changes, which is why both carry each other's name.
// 2026-07-31: 36 -> 10. This is the strip kept clear ABOVE the ‹ › bar so the
// bar never covers shots at the very bottom of the playfield (flippers, drain,
// plunger lane at v ~ 0.01-0.05). The bar sits at bottom:8px and is 44px tall,
// so its top edge is 52px above #map-host's bottom; the playfield's own MARGIN
// (now 8) sits inside that. 10 puts the card's bottom edge a couple of pixels
// clear of the bar instead of 20+ — "almost touching", which is what was
// asked for — while still guaranteeing no shot dot is drawn underneath a
// button. Do NOT take this to 0: the dots have radius, and a dot centred at
// the card's edge would still be half-under the bar.
const CONTROLS_CLEARANCE = 10

/** Band reserved at the TOP for the goal pill row (map2d.css's
 *  .map-goal-pill-row), applied unconditionally — the pill is always visible
 *  on the Map tab, goal selected or not (correction 12). Half of it
 *  (`rect.y += TOP_PAD / 2`) centers the shrunken playfield in the remaining
 *  space rather than pinning it flush to the reserved band's bottom edge —
 *  ported from design_handoff_shot_coach/pg-render.js's `topPad`/`rect.y +=`
 *  handling verbatim. Also threaded into drawGoalOverlay's `topInset` so its
 *  ring captions / action-label bubble clear the same band (README §1f).
 *
 *  2026-07-31: 44 -> 72 (rolo: "move the playfield image slightly lower
 *  because the top gets cluttered, especially when text pop-ups about the
 *  shot appear towards the top"). The band was measurably too small for what
 *  sits in it: `.map-goal-pill-row` is `top: 12px` with a ~44px-tall control
 *  row, so it occupies 12-56px — while the playfield card's top landed at
 *  MARGIN(20) + TOP_PAD/2 = 42px, i.e. UNDERNEATH the pill by 14px, and an
 *  action-label bubble clamped to the old hardcoded `topInset: 46` landed
 *  under it too. At 72 the card top is 20 + 36 = 56px, flush with the pill's
 *  bottom edge rather than beneath it, and the bubble clamp clears it (see
 *  the topInset call site, which now derives from THIS constant instead of
 *  repeating a number that had already drifted away from it). */
const TOP_PAD = 72

// GAUGE_GUTTER (the right-edge strip reserved for drawing.ts's plunge gauge,
// drawPlungeGauge) was RECLAIMED 2026-08-11 (phase A12 item 1 — rolo: "the
// gradient line for the plunger — remove that feature"; drawing.ts's own
// header has the full note). playfieldRect below is back to Playfield2DView.
// kt's original native formula — MARGIN on every side, nothing extra on the
// right — since there is no gauge left to make room for.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** `canvas.getContext('2d')` is nullable at the type level; a plain `if`
 *  guard in `mountMap2D` doesn't narrow `ctx` inside the closures declared
 *  later in that function (TS doesn't carry narrowing across function
 *  boundaries), so the null check is centralized in a typed helper instead. */
function must2DContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('map2d: 2D canvas context unavailable')
  return ctx
}

/** Largest `aspect`-ratio rect that fits inside `width`x`height` minus MARGIN
 *  on every side, centered within the remaining space. Mirrors
 *  Playfield2DView.kt's `playfieldRect` exactly: fit to height first, fall
 *  back to fitting to width if that would overflow. `aspect` defaults to
 *  PLAYFIELD_ASPECT (the whole-table MAIN view); Feature 2's LEVEL view
 *  (2026-08-11, any zone kind) passes the selected zone's OWN bounds aspect
 *  instead ("own scale, keep aspect of bounds").
 *
 *  Exported (wave 2, 2026-08-11 — Study tab) so ui/study.ts's tour
 *  configuration fits its own canvas the exact same way the main Map view
 *  does, rather than re-deriving this fit-and-center math a second time —
 *  the owner spec's own words: "reuse map2d's exported drawPlayfieldArt +
 *  drawShotDots + playfieldRect/mapping". Behavior for every existing
 *  in-file call site is unchanged; this is an export-visibility change only. */
export function playfieldRect(width: number, height: number, aspect: number = PLAYFIELD_ASPECT): Rect {
  let h = height - MARGIN * 2
  let w = h * aspect
  if (w > width - MARGIN * 2) {
    w = width - MARGIN * 2
    h = w / aspect
  }
  return { x: (width - w) / 2, y: (height - h) / 2, w, h }
}

// ---- small canvas helpers (mirrors design_handoff_shot_coach/pg-render.js's
// disc/ring/polyPath/uvArc — kept local since ./drawing's own fillCircle/
// strokeCircle equivalents aren't exported, and these have slightly
// different call shapes anyway (uv-space polylines through a MapFn)). ----

function disc(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, r: number, color: string): void {
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

function ring(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, r: number, color: string, lineWidth: number): void {
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

function polyPath(ctx: CanvasRenderingContext2D, map: MapFn, uvs: readonly (readonly [number, number])[]): void {
  ctx.beginPath()
  uvs.forEach(([u, v], i) => {
    const p = map(u, v)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
}

function uvArc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 20): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n)
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
  }
  return out
}

/** Hex -> rgba string. Local copy of ./drawing's private `withAlpha` (not
 *  exported — trivial enough that duplicating beats widening that file's
 *  export surface for a 3-line helper; same pattern as ui/fxGlyphs.ts's
 *  deliberate standalone glyph-table copy). */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// ---------------------------------------------------------------------------
// PER-MACHINE PLAYFIELD ART (rewritten 2026-07-31, rolo)
//
// WHAT WAS WRONG. The previous drawPlayfieldArt painted ONE hardcoded
// standard-body playfield — two orbit arcs across the top, two ramps, a
// three-bumper nest, upper lane guides, two slingshots, flippers, apron — at
// fixed coordinates, for ALL 62 MACHINES, regardless of what the machine
// actually has. In a STUDY TOOL that is not a cosmetic problem, it is a
// factual one: the app was drawing an arch across the back of games that have
// no orbit, and slingshots beside the flippers of games that have none. A
// player using the map to learn a specific machine was being shown furniture
// that isn't there. rolo caught it: "the shapes that are part of the playfield
// aren't like that for every game... there shouldn't be an arch in the back,
// and maybe some games don't have those side bumpers next to the flipper".
//
// Checked against the data before rewriting: orbits are attested on 53 of 62
// machines, bumpers on ~55, an explicit plunge shot on 59, and slingshots on
// far fewer. So the generic art was wrong somewhere on every one of those gaps.
//
// WHAT IT DOES NOW. Every shape is DERIVED FROM THAT MACHINE'S OWN `shots[]`,
// so the art is correct by construction: if the data does not attest to a
// feature, it is not drawn. Nothing is invented. The only thing still drawn
// unconditionally is the flipper pair and the apron strip below them — every
// machine in this catalog has flippers, and they are what orients the whole
// map (without them the playfield reads as an abstract rectangle).
//
// Ramps and orbits get LANE LINES rather than blobs — rolo: "lines like as
// part of the playfield background for ramps would be helpful". Each line runs
// from the flipper that habitually makes that shot, through the ramp's own
// crest (`Shot.apex`, already in the data for the route renderer) when it has
// one, to the shot itself. That is the real path of the ball, taken from the
// same fields the goal-route renderer uses, so background and route agree.
//
// Everything is deliberately faint. This is background: the goal route drawn
// on top by ./drawing.ts is the thing the user is meant to read.
// ---------------------------------------------------------------------------

/** Pop/jet bumpers. Both spellings appear in the data. */
const ART_BUMPER_TYPES = new Set(['bumpers', 'bumper'])
/** Slingshots. Only ~a dozen machines type them explicitly, so the name
 *  fallback below does most of the work. */
const ART_SLING_TYPES = new Set(['slingshot', 'sling'])
/** Shots whose approach is worth drawing as a lane line. */
const ART_LANE_TYPES = new Set(['ramp', 'orbit', 'loop'])



function artMatches(shot: Shot, types: Set<string>, nameRe: RegExp): boolean {
  return types.has((shot.type || '').toLowerCase()) || nameRe.test((shot.name || '').toLowerCase())
}

/**
 * Is this shot one of the MAIN (lower) flippers?
 *
 * FIXED 2026-07-31 after rolo's screenshot. The first version of this test was
 * `type === 'flipper' || /\bflipper\b/.test(name)`, which is far too loose:
 * JAWS has "Mini-Flipper Lane" (type `lane`, y=0.33) and "Mid-Right Mini
 * Flipper" (type `mech`, y=0.30), and BOTH matched. With no shot named "left
 * flipper"/"right flipper" to beat them, the right flipper resolved to a mini
 * flipper a third of the way UP the playfield — so a red flipper was painted
 * mid-map, and, worse, every right-side ramp/orbit lane line was drawn
 * starting from there instead of from the flipper, which is what made the
 * lines fan out from the wrong place.
 *
 * The name must therefore BE a flipper, not merely contain the word, and the
 * shot must sit low. Upper/mini flippers are deliberately excluded even when
 * correctly typed: this function's only job is to say where the ball is
 * launched from for the background lane lines, and that is the lower pair.
 */
function isMainFlipper(shot: Shot): boolean {
  const name = (shot.name || '').toLowerCase().trim()
  const type = (shot.type || '').toLowerCase()
  const namedFlipper = /^(lower\s+)?(left|right)\s+flipper$/.test(name) || name === 'flipper'
  if (type !== 'flipper' && !namedFlipper) return false
  return Number.isFinite(shot.y) && shot.y <= 0.25
}

/** Default flipper tips, used only when a machine's data names no flipper
 *  shot. Matches the previous hardcoded art so machines without flipper shots
 *  look exactly as they did before this rewrite. */
// FIXED 2026-07-31 (rolo's second screenshot: "some of the flippers are on top
// of each other"). These were 0.4 / 0.6, and the tip reach below is 0.13 — so
// the left tip landed at 0.53 and the right at 0.47 and the two flippers CROSSED
// through each other by 0.06, drawing a bowtie in the middle of the drain
// instead of a flipper pair. 0.33 / 0.67 are the standard-body pivot positions,
// which with the same reach put the tips either side of centre with a real gap
// between them — see ART_FLIPPER_TIP_GAP.
const ART_DEFAULT_LEFT_FLIPPER = { x: 0.33, y: 0.05 }
const ART_DEFAULT_RIGHT_FLIPPER = { x: 0.67, y: 0.05 }

/** How far a flipper reaches inward from its pivot, in UV. */
const ART_FLIPPER_REACH = 0.13

/** Paint one red flipper bat: pivot at `f`, tip reaching `inward` (+1 right,
 *  -1 left), whole shape scaled by `scale` (1 = main flipper; upper/mini bats
 *  pass less). `tipLimit` clamps the tip's x when given — the main pair uses
 *  it to keep a drain gap; upper flippers only stay on the playfield. */
function paintFlipper(
  ctx: CanvasRenderingContext2D,
  map: MapFn,
  f: { x: number; y: number },
  inward: 1 | -1,
  scale: number,
  tipLimit?: number,
): void {
  const reached = f.x + ART_FLIPPER_REACH * scale * inward
  const bounded = Math.min(0.97, Math.max(0.03, reached))
  const tipX =
    tipLimit === undefined
      ? bounded
      : inward > 0
        ? Math.min(bounded, tipLimit)
        : Math.max(bounded, tipLimit)
  polyPath(ctx, map, [
    [f.x - 0.005 * scale * inward, f.y + 0.025 * scale],
    [tipX, f.y - 0.022 * scale],
    [tipX + 0.005 * scale * inward, f.y - 0.042 * scale],
    [f.x - 0.01 * scale * inward, f.y],
  ])
  // BACKGLASS under-glow (one extra stroke pass, no blur — the concept's SVG
  // used a feGaussianBlur here and that is not worth a per-frame filter on a
  // phone). A wide, very low-alpha blue stroke on the SAME path reads as the
  // bat's own light spilling onto the playfield; the red bat and its dark
  // outline below are untouched, which is what keeps deck-route.test.mjs's
  // `rgba(195, 63, 42, 0.85)` flipper-fill assertions meaningful.
  ctx.strokeStyle = 'rgba(110, 185, 255, 0.10)'
  ctx.lineWidth = 6
  ctx.stroke()
  ctx.fillStyle = 'rgba(195, 63, 42, 0.85)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.lineWidth = 1
  ctx.stroke()
}
/** Total gap left between the two flipper TIPS — the drain. Enforced as a hard
 *  clamp rather than left to arithmetic, because the pivots can also come from
 *  a machine's own `flipper`-typed shots, and nothing stops two of those from
 *  sitting close enough together that a fixed reach would overlap them again. */
const ART_FLIPPER_TIP_GAP = 0.1

/** Zone-plate micro-label (phase A4, 2026-08-10) — small halo text, the same
 *  treatment drawShotDots already uses for its ambient-major shot labels
 *  (600 weight, 8px, dim white on a dark halo), just naming a PlayfieldZone
 *  instead of a shot. */
function drawZoneLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  bounds?: LabelBounds,
): void {
  drawHaloLabel(
    ctx,
    text.toUpperCase(),
    x,
    y,
    `600 9px ${DISPLAY_STACK}`,
    'rgba(233, 237, 247, 0.45)',
    'rgba(5, 11, 24, 0.85)',
    bounds ?? 0,
  )
}

/** `zone.bounds` (MAIN-playfield UV) mapped to a screen-space `Rect`, exactly
 *  the corner-mapping drawPlayfieldArt's own zone-plate loop below computes
 *  inline — factored out (wave 2, 2026-08-11 — Study tab) so ui/study.ts's
 *  tap-to-inspect hit-test can ask "did this tap land on a zone's plate?"
 *  against the SAME rectangle drawPlayfieldArt actually painted, rather than
 *  duplicating the corner-flip math (v grows toward the back of the table;
 *  map() inverts v to canvas y, so the high-v corner is the plate's
 *  canvas-TOP and the low-v corner its canvas-BOTTOM — see the call site
 *  below for the longer version of this comment). Pure/DOM-free; exported
 *  per the owner spec's "export a minimal helper from map2d.ts if needed
 *  rather than duplicating." drawPlayfieldArt's own loop now calls this too,
 *  so there is exactly one implementation. */
export function zoneScreenRect(zone: PlayfieldZone, map: MapFn): Rect {
  const canvasTop = map(zone.bounds.x, zone.bounds.y + zone.bounds.h)
  const canvasBottom = map(zone.bounds.x + zone.bounds.w, zone.bounds.y)
  return {
    x: Math.min(canvasTop.x, canvasBottom.x),
    y: Math.min(canvasTop.y, canvasBottom.y),
    w: Math.abs(canvasBottom.x - canvasTop.x),
    h: Math.abs(canvasBottom.y - canvasTop.y),
  }
}

/** Playfield geometry for ONE machine, derived entirely from its own shots
 *  (and, as of phase A4, its own `playfields[]` zones). `shots` empty (or
 *  omitted) draws just the flippers and apron — never the old generic
 *  furniture. Exported per README §2a; MAP-ONLY in practice (correction 1 —
 *  no AR call site: over real camera video this would paint a fake
 *  playfield).
 *
 *  `playfields` (2026-08-10, phase A4) is a trailing optional parameter —
 *  every existing call site (including every test's bare 5-arg `render()`
 *  entry) keeps compiling and rendering byte-identical, since an omitted
 *  array defaults to `[]` and the new zone-plate/deck-bat block below simply
 *  has nothing to iterate. Callers are expected to have ALREADY trim-filtered
 *  this array (mountMap2D's render() does, via shotgeom.ts's isZoneVisible —
 *  the same "caller filters, this function just draws what it's given" rule
 *  `shots` itself already follows here).
 *
 *  `topInset` (2026-08-11, phase A12 item 3, additive) — the SAME reserved-
 *  band height threaded into drawing.ts's OverlayOpts.topInset (TOP_PAD, the
 *  always-visible goal pill row) — is a trailing optional parameter for the
 *  same reason: default 0 reproduces byte-identical rendering for any call
 *  site (including every existing test) that doesn't pass it. A zone plate's
 *  own micro-label (drawZoneLabel below) is the only thing in this function
 *  that can land inside that band — a raised zone sitting at the very top of
 *  the table would otherwise get its name label drawn directly under the
 *  goal pill, same bug as drawing.ts's ring captions (see that file's header
 *  note). */
export function drawPlayfieldArt(
  ctx: CanvasRenderingContext2D,
  map: MapFn,
  tSec: number,
  alpha = 1,
  shots: readonly Shot[] = [],
  playfields: readonly PlayfieldZone[] = [],
  topInset = 0,
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])

  const flipperShots = shots.filter(isMainFlipper)
  const leftFlipper =
    flipperShots.find((s) => /left/.test(s.name.toLowerCase())) ??
    flipperShots.find((s) => s.x < 0.5) ??
    ART_DEFAULT_LEFT_FLIPPER
  const rightFlipper =
    flipperShots.find((s) => /right/.test(s.name.toLowerCase())) ??
    flipperShots.find((s) => s.x >= 0.5) ??
    ART_DEFAULT_RIGHT_FLIPPER

  // ---- raise/lower ramp plates: ONLY from a shot's own authored `flap` ----
  // A ramp mech that physically swings up and down (models.ts Shot.flap) is a
  // big object on the real table, and the insert vocabulary can only offer it
  // one ~7px arrow — so the map showed nothing where a machine's biggest
  // centre feature actually is. This paints the plate's own FOOTPRINT: the
  // authored rectangle centred on the shot, with a brighter line along its
  // LOW-v edge — the lip nearest the flippers, the edge a player aims at, and
  // the cue that separates a flap from a zone plate (which marks its far edge
  // dark instead, and rounds its corners).
  //
  // Every number comes from the shot's own (x, y) and its own authored w/h.
  // Drawn BEFORE the lane lines below so the ramp's own approach line runs
  // over its plate rather than under it.
  for (const shot of shots) {
    const flap = shot.flap
    if (!flap || !Number.isFinite(flap.w) || !Number.isFinite(flap.h)) continue
    if (flap.w <= 0 || flap.h <= 0) continue
    if (!Number.isFinite(shot.x) || !Number.isFinite(shot.y)) continue
    const x0 = shot.x - flap.w / 2
    const x1 = shot.x + flap.w / 2
    const y0 = shot.y - flap.h / 2
    const y1 = shot.y + flap.h / 2
    polyPath(ctx, map, [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ])
    ctx.fillStyle = 'rgba(255, 255, 255, 0.065)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)'
    ctx.lineWidth = 1.25
    ctx.stroke()
    const lipA = map(x0, y0)
    const lipB = map(x1, y0)
    ctx.beginPath()
    ctx.moveTo(lipA.x, lipA.y)
    ctx.lineTo(lipB.x, lipB.y)
    ctx.strokeStyle = 'rgba(150, 200, 255, 0.55)'
    ctx.lineWidth = 3
    ctx.stroke()
    // NO LABEL ON THE PLATE, deliberately — and no ambient label for the shot
    // either (drawShotDots' `majors` filter drops flap shots; see there).
    //
    // MEASURED, not assumed: on a phone-width card Stranger Things' centre has
    // the Demogorgon mouth's label one row above this plate, the left ramp's
    // label crossing the whole card level with its lip, and the right orbit's
    // one row below — a 14px label box has nowhere to land that doesn't sit on
    // one of them, at any offset. So a name here can only be bought by taking
    // one away from a shot that has no other identity, while the plate itself
    // is a 50px shape nothing else on the map looks like. It is named on tap
    // (mountMap2D's identify callout), in the Study tab, and by the route
    // caption whenever a goal targets it — three places that cost no map real
    // estate. A machine whose plate sits somewhere emptier still gets the same
    // treatment, because a plate that labels itself on one table and not on
    // another is a worse rule than one that never does.
  }

  // ---- lane lines for ramps / orbits / loops -----------------------------
  // One faint line per real ramp-ish shot, from the SAME flipper anchor the
  // goal route would shoot it from, bowing through the shot's own crest when
  // the data gives one. `Shot.apex` and `Shot.flipper` are the SAME fields
  // ./drawing.ts routes goals through, so a ramp's background line and its
  // highlighted route follow the same geometry instead of disagreeing.
  //
  // 2026-08-10 (phase A1): this loop used to pick its own origin
  // (`shot.x < 0.5`, this function's own leftFlipper/rightFlipper pivot
  // points) independent of the router — a naive same-side guess that
  // disagrees with chooseFlipper's cross-flipper heuristic for most shots
  // outside the center band. approachLine() (./shotgeom.ts) is now the one
  // function both this art and ./drawing.ts's route rendering call for this
  // geometry, so the line drawn here and the route drawn on top of it can
  // never point at different flippers for the same shot again. That DOES
  // move some lines to the opposite flipper anchor from before — the
  // disagreement was the bug being fixed, not a side effect to avoid.
  const shotsById = new Map(shots.map((s) => [s.id, s]))
  for (const shot of shots) {
    if (!ART_LANE_TYPES.has((shot.type || '').toLowerCase())) continue
    if (!Number.isFinite(shot.x) || !Number.isFinite(shot.y)) continue
    const { from, control, to } = approachLine(shot, shotsById)
    const a = map(from.x, from.y)
    const c = map(control.x, control.y)
    const b = map(to.x, to.y)
    // Wide soft underlay + a thin bright core: reads as a lane at a glance
    // without competing with the goal route drawn over it.
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
    // BACKGLASS: the underlay goes BLUE (it was neutral white at .055), which
    // is the concept's soft ball-guide under-glow done as a colour change
    // rather than a per-frame blur — same two strokes, same cost, and the
    // lane now reads as lit plastic over navy instead of a grey smudge.
    ctx.strokeStyle = 'rgba(110, 185, 255, 0.075)'
    ctx.lineWidth = 11
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
    ctx.strokeStyle = 'rgba(150, 200, 255, 0.14)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // ---- NO SHOOTER LANE. Deleted 2026-08-14, and it does not come back -----
  // This function used to draw the shooter lane as a channel: a narrow darkened
  // strip hugging whichever edge the machine's `plunge` shot sits on, from the
  // apron up to just past the plunge, with a hairline outline. rolo, on the
  // shipped map: "I don't like the tiny ramp on the side on playfields that
  // show the plunger ramp. Remove those everywhere."
  //
  // It also had nothing to say. Every OTHER shape in this function marks a
  // place you aim at — a bumper you avoid, a sling that kicks, a deck you shoot
  // to. The lane is the one strip of a playfield a player never aims INTO; the
  // plunge itself is already drawn (its own insert dot, and drawing.ts's plunge
  // gauge when a goal starts there), so the channel was decoration around a
  // thing that was already on the canvas, and at map width it read as a stray
  // ramp glued to the edge.
  //
  // WHAT SURVIVES, deliberately: `Shot.plunge`/the plunge gauge, plunge-origin
  // ROUTES (./drawing.ts owns those and never drew this channel), and the
  // dataset's plunge coordinates. The removal is the LANE ART only — here, in
  // ui/library.ts's drawThumb, and therefore on every surface either one paints
  // (map, study, zone views, the ALL-level stack, library thumbnails).
  // tests/playfield-art.test.mjs 12g and tests/library.test.mjs both assert the
  // ABSENCE behaviourally, so re-adding a strip in any form goes red.

  // ---- pop bumpers: one per REAL bumper shot, at its real position -------
  // The old art drew a fixed three-bumper nest mid-playfield on every machine.
  for (const shot of shots) {
    if (!artMatches(shot, ART_BUMPER_TYPES, /\bbumper/)) continue
    if (!Number.isFinite(shot.x) || !Number.isFinite(shot.y)) continue
    const p = map(shot.x, shot.y)
    const edge = map(shot.x + 0.022, shot.y)
    // FIXED 2026-07-31 (rolo's screenshot): this used to be 0.05 of the
    // playfield width and un-clamped, which on a phone-width map is a ~24px
    // ring sitting next to 3.5px shot dots — it read as a rendering artifact,
    // not as a pop bumper. Clamped so it stays a bumper at any canvas size.
    const rr = Math.min(9, Math.max(3.5, Math.abs(edge.x - p.x)))
    disc(ctx, p, rr, 'rgba(255, 255, 255, 0.05)')
    ring(ctx, p, rr, 'rgba(255, 255, 255, 0.11)', 1)
    // A slow shared pulse marks them as active mechs without drawing the eye.
    disc(ctx, p, rr * 0.38, `rgba(255, 220, 140, ${0.09 + 0.04 * Math.sin(tSec * 2 + shot.x * 12)})`)
  }

  // ---- slingshots: ONLY when the machine's data attests to them ----------
  // rolo: "maybe some games don't have those side bumpers next to the
  // flipper". Correct — and the old art drew them on all 62 regardless.
  for (const shot of shots) {
    if (!artMatches(shot, ART_SLING_TYPES, /sling/)) continue
    if (!Number.isFinite(shot.x) || !Number.isFinite(shot.y)) continue
    const onLeft = shot.x < 0.5
    const dx = onLeft ? 0.075 : -0.075
    polyPath(ctx, map, [
      [shot.x, shot.y + 0.045],
      [shot.x + dx, shot.y - 0.015],
      [shot.x, shot.y - 0.045],
    ])
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.17)'
    ctx.lineWidth = 1.25
    ctx.stroke()
  }

  // ---- zone plates + deck bats: ONLY from the machine's own playfields[] --
  // Raised (upper/mini) or sunken (lower) playfields (models.ts PlayfieldZone)
  // — same "derived from the data, nothing invented" rule as everything else
  // in this function. `playfields` is empty on every machine with a flat
  // single surface (the overwhelming majority as of this writing), so this
  // loop draws nothing for them. Sits between the slingshots and the main
  // flipper pair in z-order: a deck plate reads as part of the table's own
  // construction, not a decal over the flippers.
  for (const zone of playfields) {
    // Zone bounds are MAIN-playfield UV like everything else (PlayfieldZone's
    // own doc comment) — (x,y) is the low-u/low-v corner, (x+w,y+h) the
    // high-u/high-v corner. v grows toward the BACK of the table and map()
    // inverts v to canvas y (v=0 is the bottom), so the high-v corner maps to
    // the canvas-TOP of the plate and the low-v corner to its canvas-BOTTOM.
    // zoneScreenRect (above) is this exact corner-flip, factored out (wave 2,
    // 2026-08-11) so ui/study.ts's zone-plate tap hit-test uses the identical
    // rectangle this loop paints rather than a second copy of the math.
    const { x: px, y: py, w: pw, h: ph } = zoneScreenRect(zone, map)

    if (zone.kind === 'lower') {
      // Inset window: "you cannot shoot at this region directly from the
      // main playfield" (PlayfieldZone.kind's own doc comment) — drawn
      // sunken (darker fill) with a DASHED outline, unlike the raised
      // plates' solid stroke below.
      ctx.save()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(0, 0, 0, 0.30)'
      ctx.fillRect(px, py, pw, ph)
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
      ctx.lineWidth = 1.25
      ctx.strokeRect(px, py, pw, ph)
      ctx.setLineDash([])
      ctx.restore()
      // Banner exclusion (phase A12 item 3): offset down, never up, clear of
      // the reserved band — a lower zone's inset window sits well inside the
      // main playfield in every real case, so this floor is defensive rather
      // than expected to fire, but costs nothing to apply uniformly.
      drawZoneLabel(ctx, `${zone.name} · BELOW DECK`, px + pw / 2, Math.max(py + ph / 2, topInset + 8), cardXBounds(map))
    } else {
      // Raised plate (upper or mini — mini scales the same treatment down).
      const scale = zone.kind === 'mini' ? 0.75 : 1
      ctx.save()
      roundedRectPath(ctx, px, py, pw, ph, 6 * scale)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.045)'
      ctx.fill()
      roundedRectPath(ctx, px, py, pw, ph, 6 * scale)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
      ctx.lineWidth = 1.25 * scale
      ctx.stroke()
      // Elevation cue: a darker edge along the plate's canvas-BOTTOM (the
      // low-v edge, closest to the main flippers) — the "step down" a player
      // actually sees looking at a real raised deck.
      ctx.beginPath()
      ctx.moveTo(px, py + ph)
      ctx.lineTo(px + pw, py + ph)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
      ctx.lineWidth = scale >= 1 ? 3 : 2
      ctx.stroke()
      ctx.restore()
      // Banner exclusion (phase A12 item 3, 2026-08-11 — rolo's screenshot:
      // "ORCA DECK" sitting right under the always-visible goal pill row).
      // The plate's own top edge is where this label wants to sit by
      // default; when that would land inside the reserved band, flip to the
      // plate's BOTTOM edge instead (still floored at topInset+8 in case the
      // plate itself is short enough that even its bottom edge lands inside
      // the band).
      const raisedLabelY = py + 10 < topInset + 8 ? Math.max(py + ph - 10, topInset + 8) : py + 10
      drawZoneLabel(ctx, zone.name, px + pw / 2, raisedLabelY, cardXBounds(map))
    }

    // Deck bats: the zone's own type:'flipper' shots, painted with the SAME
    // paintFlipper the main/upper-mini bats below use — 'mini' bat.size at
    // half scale, side from the shot's own authored bat.side, else (fallback)
    // which half of the ZONE it sits in. These shots are excluded from the
    // name-regex extras loop below (a `playfield` beats the regex outright —
    // see that loop's own comment) so nothing double-draws.
    for (const bat of batsForZone(shotsById, zone.id)) {
      const side =
        bat.bat?.side === 'left' || bat.bat?.side === 'right'
          ? bat.bat.side
          : bat.x < zone.bounds.x + zone.bounds.w / 2
            ? 'left'
            : 'right'
      const inward = side === 'left' ? 1 : -1
      // Deck bats default to MINI scale when unauthored (2026-08-11): the P2
      // apply shipped 23 deck flippers with no bat metadata and full-size
      // bats overwhelm a fraction-of-board plate. True full-size upper
      // flippers (Black Knight class) must author bat.size:'full' — the
      // flipper-anchor review pass owns that adjudication.
      const batScale = bat.bat?.size === 'full' ? 1 : 0.5
      paintFlipper(ctx, map, bat, inward, batScale)
    }
  }

  // ---- flippers + apron: the one unconditional pair ----------------------
  // Every machine in this catalog has flippers, and they are the landmark the
  // whole map is read against. Drawn from the machine's own flipper shots when
  // it names them, else at the standard body position.
  for (const [f, inward] of [
    [leftFlipper, 1],
    [rightFlipper, -1],
  ] as const) {
    // Reach inward from the pivot, but NEVER across the centreline — the two
    // tips must always leave a drain gap between them. Without this clamp the
    // pair drew a bowtie through the middle of the drain (rolo's screenshot),
    // and a machine whose own flipper shots sit close enough together would do
    // it again even with the corrected default pivots.
    const limit = 0.5 - (ART_FLIPPER_TIP_GAP / 2) * inward
    paintFlipper(ctx, map, f, inward, 1, limit)
  }

  // ---- upper / mini flippers: same red bat, drawn where the data puts them.
  // rolo (2026-08-01): a labeled dot is not a flipper — machines with upper or
  // mini-playfield flippers should SHOW them. Only `type: 'flipper'` shots
  // qualify (a "Mini-Flipper Lane" of type `lane` stays a lane), the main pair
  // is excluded because it was just drawn, and size follows the flipper class:
  // mini-playfield bats at half reach, full upper flippers slightly short of
  // the mains. Direction comes from the name's own side, else from which half
  // of the playfield the pivot sits in.
  //
  // 2026-08-10 (phase A4): a shot naming a `playfield` zone is EXCLUDED here
  // — it was already drawn (or, under the current trim, deliberately not
  // drawn) by the zone-plate/deck-bat loop above, which reads its geometry
  // from the authored zone/bat data instead of this regex/position guesswork.
  // A `playfield` always wins over the regex, regardless of whether that
  // zone happens to resolve under the current trim selection — so a deck
  // bat's zone vanishing under Pro hides the bat too, rather than it falling
  // back to a generic upper-flipper guess (models.ts's Shot.bat doc comment:
  // authored data always retires the regex; it survives only as the fallback
  // for unauthored machines).
  const extras: { shot: Shot; inward: 1 | -1; scale: number; tipLimit?: number }[] = []
  for (const shot of shots) {
    if ((shot.type || '').toLowerCase() !== 'flipper') continue
    if (isMainFlipper(shot)) continue
    if (shot.playfield) continue
    if (!Number.isFinite(shot.x) || !Number.isFinite(shot.y)) continue
    const name = (shot.name || '').toLowerCase()
    const inward = /right/.test(name) ? -1 : /left/.test(name) ? 1 : shot.x < 0.5 ? 1 : -1
    // Real upper flippers are standard-length bats, so they draw at FULL main
    // size (rolo 2026-08-01: "sizes accurate to their size on the playfield").
    // Genuinely small bats — mini-playfield pairs and machines whose own data
    // calls the bat mini/short (Thing, Godzilla's Big Loop mini, TZ's much
    // shorter upper-left) — draw at half reach. The shot's NOTES participate
    // so the size claim lives in the machine's data, not in this heuristic.
    const mini = /mini|\bshort|stewie|donkey|kneedeep|encounter|castle|twister|thing\b|shark/.test(
      `${name} ${shot.id} ${(shot.notes || '').toLowerCase()}`,
    )
    extras.push({ shot, inward, scale: mini ? 0.5 : 1 })
  }
  // Two extra bats at the same height and close together are physically a
  // PAIR, and a pair faces inward — orient them that way when neither name
  // states a side (Mandalorian's "Encounter Mini-PF Flipper(s)" + "Second
  // Flipper" both fell back to the same x-derived direction and overlapped).
  // Name-stated sides always win; distant same-height bats (TZ's two uppers,
  // 0.44 apart) are left alone.
  for (const a of extras) {
    for (const b of extras) {
      if (a === b) continue
      const dx = b.shot.x - a.shot.x
      if (dx <= 0 || dx > 0.3 || Math.abs(b.shot.y - a.shot.y) > 0.06) continue
      const aNamed = /left|right/.test((a.shot.name || '').toLowerCase())
      const bNamed = /left|right/.test((b.shot.name || '').toLowerCase())
      if (!aNamed) a.inward = 1
      if (!bNamed) b.inward = -1
    }
  }
  // A FACING PAIR of extra bats (a mini-playfield's own left+right flippers)
  // needs the same tip-gap treatment as the mains, around the pair's OWN
  // midline rather than the playfield's — otherwise Stewie's pair draws the
  // exact bowtie rolo's 2026-07-31 screenshot caught on the main pair.
  for (const a of extras) {
    if (a.inward !== 1 || a.tipLimit !== undefined) continue
    let partner: (typeof extras)[number] | undefined
    for (const b of extras) {
      if (b.inward !== -1 || b.tipLimit !== undefined) continue
      if (b.shot.x <= a.shot.x || Math.abs(b.shot.y - a.shot.y) > 0.06) continue
      if (!partner || b.shot.x < partner.shot.x) partner = b
    }
    if (!partner) continue
    const mid = (a.shot.x + partner.shot.x) / 2
    const gap = (ART_FLIPPER_TIP_GAP / 2) * Math.max(a.scale, partner.scale)
    a.tipLimit = mid - gap
    partner.tipLimit = mid + gap
  }
  for (const e of extras) paintFlipper(ctx, map, e.shot, e.inward, e.scale, e.tipLimit)

  polyPath(ctx, map, [
    [0, 0],
    [1, 0],
    [1, 0.035],
    [0, 0.035],
  ])
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.fill()

  ctx.restore()
}

/** Card background (gradient + drawPlayfieldArt clipped in + category glow +
 *  border stroke). `glowColor` is the selected goal's literal hex category
 *  color (./drawing's CATEGORY_COLOR — a real canvas-fillable color, unlike
 *  ui/goalMeta.ts's CSS-custom-property strings), or null with no goal
 *  selected (no glow drawn at all). `topInset` (phase A12 item 3, additive,
 *  default 0) passes straight through to drawPlayfieldArt's own — see its
 *  doc comment. */
function drawMapCardBackground(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  map: MapFn,
  tSec: number,
  glowColor: string | null,
  shots: readonly Shot[] = [],
  playfields: readonly PlayfieldZone[] = [],
  topInset = 0,
): void {
  const corner = 12
  const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h)
  gradient.addColorStop(0, CARD_GRADIENT_A)
  gradient.addColorStop(1, CARD_GRADIENT_B)
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.fillStyle = gradient
  ctx.fill()

  ctx.save()
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.clip()
  drawPlayfieldArt(ctx, map, tSec, 0.85, shots, playfields, topInset)
  ctx.restore()

  if (glowColor) {
    ctx.save()
    // Shot Coach correction 2: the clip path is rebuilt HERE, immediately
    // before clipping — drawPlayfieldArt's last drawn shape (the drain
    // apron strip) is still the "current path" otherwise, since canvas
    // paths aren't part of save()/restore() state, and clipping to that
    // sliver makes the glow invisible (the prototype's actual bug).
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
    ctx.clip()
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h * 0.22
    const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, rect.w * 1.1)
    glow.addColorStop(0, withAlpha(glowColor, 0.16))
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
    ctx.restore()
  }

  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.lineWidth = 2
  ctx.stroke()
}

/** All shots — bare dots by default, with ambient-major/goal-route labels
 *  per the file header's t12/t13 rule. The goal overlay (drawn after, when a
 *  goal is selected) adds rings/badges/the action-label bubble on top.
 *  Exported (integrator addition) so ar/arview.ts's "no goal selected" AR
 *  hint state reuses this instead of duplicating the same dot-rendering
 *  logic — both surfaces already share drawGoalOverlay for the routed case,
 *  this keeps the unrouted case shared too. */
/** BACKGLASS (P5, 2026-08-14) — a shot is drawn as the INSERT it physically
 *  is, and the shape carries the shot type before any label is read:
 *
 *    diamond  lanes, outlanes, rollovers        (a rounded lane insert)
 *    bar      standups, drop targets, banks     (a target's rectangular lamp)
 *    ring     scoops, saucers, kickers, locks   (a hole with a dark interior)
 *    blade    spinners                          (a tall narrow blade)
 *    arrow    ramps, orbits, loops              (the "shoot here" chevron)
 *    chevron  the plunge                        (the shooter-lane mark)
 *    cluster  bumpers                           (three lamps in a nest)
 *    dot      everything else                   (the pre-P5 3.5px circle)
 *
 *  Ported from design3/backglass-concept.html's `#ins` symbol group — the
 *  concept drew these as SVG paths; these are the same shapes in canvas ops.
 *  Every shape is drawn at the SAME visual weight the old dot had (a ~7px
 *  box), so nothing about hit-testing, the declutter rule, the alpha tiers or
 *  the label logic changes: only the silhouette does. */
export type InsertShape = 'diamond' | 'bar' | 'ring' | 'blade' | 'arrow' | 'chevron' | 'cluster' | 'dot'

/** The insert silhouette for a shot's `type` — lower-cased, with the same
 *  'dot' fallback drawShotDots itself uses for an unknown or absent type. */
export function insertShapeFor(type: string | null | undefined): InsertShape {
  return INSERT_SHAPE[(type || '').toLowerCase()] ?? 'dot'
}

/** Drawn radius of a normal insert, in px. The TAP TEST measures against this
 *  same number (insertHitDistance below), which is the whole reason it is a
 *  named constant rather than a literal at the draw call: a radius that lives
 *  in one place and not the other is how a target silently drifts away from
 *  its own graphic. Exported alongside insertHitDistance so any other surface
 *  hit-testing these shapes measures the shape that was actually drawn. */
export const INSERT_DRAW_RADIUS = 4.6

/** The Study tab's one lit insert draws slightly larger (it carries a halo).
 *  Hit-testing deliberately still uses INSERT_DRAW_RADIUS: the lit shot is
 *  already the current one, so making it a BIGGER tap target than its
 *  neighbours would only make its neighbours harder to select. */
const INSERT_LIT_RADIUS = 5.5

/** Shot `type` -> the insert silhouette drawShotDots paints for it.
 *
 *  EXPORTED 2026-08-14, with `InsertShape`, to delete a MIRROR. ui/study.ts
 *  hit-tests the same inserts this file draws, so when it adopted
 *  insertHitDistance it had to know the shape for a shot — and because this
 *  table was private it carried a hand-kept copy of all 25 rows, with a test
 *  that parsed THIS file to prove the two had not drifted. That gate worked,
 *  but the copy was always the wrong shape for the problem: one exported
 *  table is the fix the gate's own failure message told the next person to
 *  make. Use insertShapeFor() rather than indexing this directly — it owns
 *  the lower-casing and the 'dot' fallback. */
export const INSERT_SHAPE: Record<string, InsertShape> = {
  lane: 'diamond',
  lanes: 'diamond',
  outlane: 'diamond',
  rollover: 'diamond',
  gate: 'diamond',
  standup: 'bar',
  target: 'bar',
  'target-bank': 'bar',
  'drop-target': 'bar',
  'drop-target-bank': 'bar',
  scoop: 'ring',
  'scoop-vuk': 'ring',
  saucer: 'ring',
  kicker: 'ring',
  lock: 'ring',
  'captive-ball': 'ring',
  captive: 'ring',
  spinner: 'blade',
  disc: 'blade',
  ramp: 'arrow',
  orbit: 'arrow',
  loop: 'arrow',
  plunge: 'chevron',
  bumpers: 'cluster',
  bumper: 'cluster',
}

/** Each insert's drawn EXTENT and its visual CENTROID, both in units of the
 *  drawn radius `r`, for hit-testing (K3 fast-follow #1, 2026-08-14).
 *
 *  THE PROBLEM THIS SOLVES, stated precisely, because the measurements are
 *  smaller than they sound. The tap test was a 16px radius around each shot's
 *  geometric point — written when every shot was a radially symmetric 3.5px
 *  dot, where "the point" and "what the user sees" were the same thing. They
 *  are not the same thing any more:
 *
 *    * A RING is an annulus with a deliberately DARK centre. Nothing is drawn
 *      at the point the hit test measures from. (It still hit-tests as a
 *      filled disc, which is what a player expects when they tap a scoop —
 *      that part the radius test already got right, and this keeps it.)
 *    * A BLADE is 3r tall and 0.84r wide; a BAR is 2.7r wide and 1r tall.
 *      Their drawn area is nowhere near circular, so "distance to the centre"
 *      badly describes "did the tap land on it".
 *    * An ARROW and a CHEVRON are not symmetric about their centre at all.
 *
 *  MEASURED, so nobody has to trust the adjectives: at r = 4.6px the centroid
 *  offsets are arrow +0.61px, cluster +0.39px, chevron -0.23px, everything
 *  else 0. Those are sub-pixel and would not, on their own, be worth a line of
 *  code. The part that actually changes behaviour is the EXTENT: a tap is now
 *  measured to the shape's drawn BOX (zero inside it), so a tap that lands on
 *  a shape always beats a neighbour whose centre happens to be a hair closer.
 *  That is the real failure mode with shapes this asymmetric — not the offset.
 *
 *  `cy` is the centroid offset along y (every shape is symmetric in x, so
 *  there is no cx); `hx`/`hy` are half-extents measured FROM THE CENTROID,
 *  and must cover ALL of the shape's ink.
 *
 *  THAT LAST CLAUSE IS THE SUBTLE ONE, and a test caught it being wrong: for
 *  an asymmetric shape the span about the centroid is asymmetric too, so a
 *  single `hy` has to be max(top, bottom), NOT the shape's half-height about
 *  its origin. The arrow spans +/-1.25r about its ORIGIN, but its centroid
 *  sits at +0.1322r, which puts its apex 1.3822r above the centroid — using
 *  1.25 left the drawn apex 0.61px outside its own tap target, i.e. exactly
 *  the "users tap where the shape looks like it is and miss" failure this
 *  whole helper exists to remove. Over-covering the other side by the same
 *  amount is harmless: it is a tap halo, not a paint.
 */
const INSERT_METRICS: Record<InsertShape, { hx: number; hy: number; cy: number }> = {
  //                        half-width  half-height  centroid-y
  diamond: { hx: 0.78, hy: 1.0, cy: 0 },
  bar: { hx: 1.35, hy: 0.5, cy: 0 },
  ring: { hx: 1.0, hy: 1.0, cy: 0 },
  blade: { hx: 0.42, hy: 1.5, cy: 0 },
  // Polygon centroid of the drawn arrow (+0.1322r); ink spans +/-1.25r about
  // the origin, so from the centroid that is 1.3822r up and 1.1178r down.
  arrow: { hx: 1.05, hy: 1.3822, cy: 0.1322 },
  // Stroke-length-weighted centroid of the two chevron segments (-0.05r); ink
  // spans -0.6r..+0.5r about the origin, which is 0.55r each way from there.
  chevron: { hx: 1.0, hy: 0.55, cy: -0.05 },
  // Three discs of radius 0.55r at (-0.85, 0.51), (0.85, 0.51), (0, -0.765):
  // ink spans -1.315r..+1.06r about the origin, centroid +0.085r -> 1.4r up.
  cluster: { hx: 1.4, hy: 1.4, cy: 0.085 },
  dot: { hx: 0.75, hy: 0.75, cy: 0 },
}

/** How far a tap at (px, py) is from the INSERT drawn for `shot` — 0 when it
 *  lands inside the shape's drawn box, otherwise the distance to that box.
 *
 *  Exported because ui/study.ts runs its OWN tap hit-test over its own
 *  `lastShotPoints` and needs the identical rule; a shot that is tappable on
 *  the Shots tab and not on Study (or vice versa) is the exact inconsistency
 *  a shared helper prevents. (As of this commit study.ts is owned by another
 *  agent and still uses the plain radius test — adopting this is a one-line
 *  change there and is noted in the P5 fast-follow report.)
 */
export function insertHitDistance(
  shape: InsertShape,
  center: { x: number; y: number },
  r: number,
  px: number,
  py: number,
): number {
  const m = INSERT_METRICS[shape] ?? INSERT_METRICS.dot
  // A ring is hit-tested as a FILLED disc: the drawn hole is a graphic, not a
  // gap in the target. Everything else uses its drawn box.
  const cx = center.x
  const cy = center.y + m.cy * r
  const dx = Math.max(0, Math.abs(px - cx) - m.hx * r)
  const dy = Math.max(0, Math.abs(py - cy) - m.hy * r)
  return Math.hypot(dx, dy)
}

/** Trace one insert silhouette, centred on the ORIGIN of the current
 *  transform. The caller translates to the shot's screen point first (see
 *  drawShotDots) — which keeps every shape's arithmetic in one small local
 *  frame instead of threading a centre through each case, and gives the test
 *  harness a single recorded `translate(x, y)` per shot as the shape-agnostic
 *  "where is this insert" signal (radius-3.5 `arc` calls used to serve that
 *  purpose, and no longer exist for most shot types).
 *
 *  Path only — the caller owns fill/stroke, which is what lets the same
 *  geometry serve the crisp pass and the lit pass without duplicating the
 *  shapes. */
function insertPath(ctx: CanvasRenderingContext2D, shape: InsertShape, r: number): void {
  ctx.beginPath()
  switch (shape) {
    case 'diamond':
      ctx.moveTo(0, -r)
      ctx.lineTo(r * 0.78, 0)
      ctx.lineTo(0, r)
      ctx.lineTo(-r * 0.78, 0)
      ctx.closePath()
      break
    case 'bar':
      roundedRectPath(ctx, -r * 1.35, -r * 0.5, r * 2.7, r, r * 0.5)
      break
    case 'ring':
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      break
    case 'blade':
      roundedRectPath(ctx, -r * 0.42, -r * 1.5, r * 0.84, r * 3, r * 0.42)
      break
    case 'arrow': {
      // Apex up, wings, then a stem — the concept's ramp-entrance insert.
      const w = r * 1.05
      ctx.moveTo(0, -r * 1.25)
      ctx.lineTo(w, r * 0.35)
      ctx.lineTo(w * 0.42, r * 0.35)
      ctx.lineTo(w * 0.42, r * 1.25)
      ctx.lineTo(-w * 0.42, r * 1.25)
      ctx.lineTo(-w * 0.42, r * 0.35)
      ctx.lineTo(-w, r * 0.35)
      ctx.closePath()
      break
    }
    case 'chevron':
      ctx.moveTo(-r, r * 0.5)
      ctx.lineTo(0, -r * 0.6)
      ctx.lineTo(r, r * 0.5)
      break
    case 'cluster': {
      const d = r * 0.85
      for (const [dx, dy] of [
        [-d, d * 0.6],
        [d, d * 0.6],
        [0, -d * 0.9],
      ] as const) {
        ctx.moveTo(dx + r * 0.55, dy)
        ctx.arc(dx, dy, r * 0.55, 0, Math.PI * 2)
      }
      break
    }
    default:
      ctx.moveTo(r * 0.75, 0)
      ctx.arc(0, 0, r * 0.75, 0, Math.PI * 2)
  }
}

/** Paint one insert at the current origin: a translucent interior plus a
 *  brighter outline, the two-pass "lit lamp under glass" treatment the
 *  concept's `#ins` group uses (`fill-opacity .20` under `stroke-opacity
 *  .60`). `alpha` is the tier the caller already computed (route /
 *  ambient-major / quiet), so the three brightness levels the map has always
 *  had are preserved exactly — only the silhouette changed. */
function drawInsert(ctx: CanvasRenderingContext2D, shape: InsertShape, r: number, alpha: number): void {
  if (shape !== 'chevron') {
    insertPath(ctx, shape, r)
    ctx.fillStyle = `rgba(211, 231, 255, ${(alpha * 0.34).toFixed(3)})`
    ctx.fill()
  }
  insertPath(ctx, shape, r)
  ctx.strokeStyle = `rgba(211, 231, 255, ${alpha.toFixed(3)})`
  ctx.lineWidth = 1.2
  ctx.stroke()
  // A scoop/saucer is a HOLE — the concept punches its interior dark so it
  // never reads as a filled lamp.
  if (shape === 'ring') {
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.36, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(5, 11, 24, 0.85)'
    ctx.fill()
  }
}

/** Paint one lit insert at the current origin with a glow multiplier.
 *  glow=1 reproduces the original lit branch (visually identical: halo alpha
 *  0.85, fill alpha 0.55, stroke #ffc85f width 1.6; the toFixed(3) form
 *  "0.850" is the same colour the canvas parsed from "0.85"). */
export function drawLitInsert(ctx: CanvasRenderingContext2D, shape: InsertShape, r: number, glow: number): void {
  ctx.save()
  ctx.shadowColor = `rgba(255, 176, 46, ${(0.85 * glow).toFixed(3)})`
  ctx.shadowBlur = 16
  insertPath(ctx, shape, r)
  ctx.fillStyle = `rgba(255, 176, 46, ${(0.25 + 0.30 * glow).toFixed(3)})`
  ctx.fill()
  ctx.restore()
  insertPath(ctx, shape, r)
  ctx.strokeStyle = '#ffc85f'
  ctx.lineWidth = 1.6
  ctx.stroke()
}

export function drawShotDots(
  ctx: CanvasRenderingContext2D,
  shots: Shot[],
  map: MapFn,
  opts: ShotDotsOptions = {},
): void {
  const routeShotIDs = opts.routeShotIDs
  const topInset = opts.topInset ?? 0
  const litShotID = opts.litShotID
  const labelBounds = opts.labelBounds
  // Declutter (t14, added 2026-07-28, SPEC-PATHVIZ point 2): while a goal is
  // selected, drawGoalOverlay's own ring captions already name the route's
  // objects (halo label centered above each step's ring) — this pass must
  // not double-label them, and every AMBIENT (non-route) label goes quiet
  // too, so only the goal's objects stay named. Declutter activates only for
  // a non-empty routeShotIDs; an absent/empty set (no goal selected, or a
  // caller that never passes one — arview.ts's idle AR hint) reproduces
  // today's ambient-major-label behavior byte-for-byte.
  const declutter = !!routeShotIDs && routeShotIDs.size > 0
  ctx.setLineDash([])

  // `!s.flap`: a shot drawn as a raise/lower ramp PLATE (drawPlayfieldArt) is
  // already a ~50px shape nothing else on the map looks like, and in the
  // crowded centre where those mechs live its label can only be bought by
  // taking one from a shot that has no other identity — see the long note at
  // that plate's draw site. Filtered out of the POOL rather than skipped at
  // the draw, so it doesn't silently spend one of the eight ambient slots and
  // push whatever was 8th (Stranger Things: the left return lane) off the map.
  const majors = shots
    .filter((s) => MAJOR_SHOT_TYPES.has(s.type) && !s.flap && !routeShotIDs?.has(s.id))
    .slice(0, MAX_AMBIENT_LABELS)
  const majorIDs = new Set(majors.map((s) => s.id))
  // Shot Coach (correction 12): the up-to-8 ambient major labels can sit
  // within a few px of each other on a dense machine (e.g. a left orbit
  // right beside a left spinner) — pack them through the same
  // occupied-box tracker the route captions use (./drawing's labelPacker)
  // instead of always drawing every one.
  const fits = labelPacker()

  for (const shot of shots) {
    const point = map(shot.x, shot.y)
    const onRoute = routeShotIDs?.has(shot.id) ?? false
    const isMajor = majorIDs.has(shot.id)

    // BACKGLASS: the alpha TIERS are exactly what they were (route 0.85 /
    // ambient-major 0.55 / quiet 0.22) — only the silhouette the alpha is
    // applied to changed, from a bare 3.5px dot to the shot's own insert
    // shape. See INSERT_SHAPE above.
    const shape = INSERT_SHAPE[(shot.type || '').toLowerCase()] ?? 'dot'
    const alpha = onRoute ? 0.85 : isMajor && !declutter ? 0.55 : 0.22
    ctx.save()
    ctx.translate(point.x, point.y)
    if (litShotID != null && shot.id === litShotID) {
      drawLitInsert(ctx, shape, INSERT_LIT_RADIUS, 1)
    } else {
      drawInsert(ctx, shape, INSERT_DRAW_RADIUS, alpha)
    }
    ctx.restore()

    // Declutter: no label from this pass at all — route names are the
    // overlay caption's job now, and ambient majors go fully quiet while a
    // goal is selected.
    if (declutter) continue

    if (onRoute) {
      drawHaloLabel(ctx, shot.name, point.x, point.y - 15, `600 10px ${DISPLAY_STACK}`, 'rgba(233, 237, 247, 0.85)', undefined, labelBounds ?? cardXBounds(map))
    } else if (isMajor) {
      const text = shot.name.toUpperCase()
      // BACKGLASS: ambient labels are 9px display-face at 0.45 — a touch
      // larger and a touch brighter than the old 8px/0.38 mono, because the
      // display face runs narrower at the same size and the inserts under
      // them are now shapes rather than dots.
      ctx.font = `600 9px ${DISPLAY_STACK}`
      const textWidth = ctx.measureText(text).width
      // (The emoji glyph chip that could sit above this label was removed
      // 2026-07-29 — labels sit at the pre-Shot-Coach y-11 unconditionally.)
      // Banner exclusion (phase A12 item 3): a major shot near the very top
      // of the table (e.g. an orbit) would otherwise put this label directly
      // under the always-visible goal pill row — flip below the dot instead,
      // floored so the flipped position can't land inside the band either.
      const aboveY = point.y - 11
      const labelY = aboveY < topInset + 8 ? Math.max(point.y + 16, topInset + 8) : aboveY
      if (!fits(point.x, labelY, textWidth, 10)) continue
      // CARD bounds, not the canvas width this used to pass: clamping to the
      // canvas stops the clipping but strands the text on the letterbox strip
      // beside the card. See drawing.ts's cardXBounds.
      drawHaloLabel(
        ctx,
        text,
        point.x,
        labelY,
        `600 9px ${DISPLAY_STACK}`,
        'rgba(233, 237, 247, 0.45)',
        'rgba(5, 11, 24, 0.85)',
        labelBounds ?? cardXBounds(map),
      )
    }
  }
}

/** The shots that live ON `zoneId`, for the current trim — the roster both
 *  tabs' zone views walk. One definition so "what is on this deck" cannot
 *  mean two things. */
export interface LitSite {
  u: number
  v: number
  shape: InsertShape
}

/** Draw a set of lit sites (the Study tab's selected light group) on the map.
 *  Each site paints its insert at its mapped (u,v). When `only` is a number,
 *  just that index is lit (the lane-change step demo); the rest draw as quiet
 *  inserts so the group still reads as a set. */
export function drawLitSites(
  ctx: CanvasRenderingContext2D,
  sites: readonly LitSite[],
  map: MapFn,
  opts: { glow?: number; only?: number | null } = {},
): void {
  const glow = opts.glow ?? 1
  const only = opts.only ?? null
  sites.forEach((site, i) => {
    const point = map(site.u, site.v)
    ctx.save()
    ctx.translate(point.x, point.y)
    if (only === null || only === i) {
      drawLitInsert(ctx, site.shape, INSERT_LIT_RADIUS, glow)
    } else {
      drawInsert(ctx, site.shape, INSERT_DRAW_RADIUS, 0.22)
    }
    ctx.restore()
  })
}

export function zoneMemberShots(
  shots: readonly Shot[] | null | undefined,
  zoneId: string,
  trim: 'pro' | 'premium-le',
): Shot[] {
  return (shots ?? []).filter((s) => s.playfield === zoneId && isShotVisible(s, trim))
}

/** A zone level's static furniture: the floor plate, its flipper bats, and
 *  the entry/exit markers on its edges. Everything a zone view draws EXCEPT
 *  the shot dots (whose options differ per tab — the Shots tab tints a goal's
 *  route, the Study tab lights the current tour shot) and any goal route.
 *
 *  EXPORTED 2026-08-14 for the Study tab's LEVEL feature. It was inline in
 *  mountMap2D's renderZoneLevel, and the alternative was a second copy of the
 *  bat-side/bat-scale rules — the very rules whose comment already warns that
 *  23 shipped deck flippers depend on the unauthored default. A second copy
 *  would have been a second place for that default to drift. */
export function drawZoneArt(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  map: MapFn,
  zone: PlayfieldZone,
  shotsById: Map<string, Shot>,
  trim: 'pro' | 'premium-le',
): void {
  drawZoneFloor(ctx, rect, zone)

  for (const bat of batsForZone(shotsById, zone.id)) {
    const side =
      bat.bat?.side === 'left' || bat.bat?.side === 'right'
        ? bat.bat.side
        : bat.x < zone.bounds.x + zone.bounds.w / 2
          ? 'left'
          : 'right'
    const inward = side === 'left' ? 1 : -1
    // Deck bats default to MINI scale when unauthored (2026-08-11): the P2
    // apply shipped 23 deck flippers with no bat metadata and full-size bats
    // overwhelm a fraction-of-board plate. True full-size upper flippers
    // (Black Knight class) must author bat.size:'full'.
    const batScale = bat.bat?.size === 'full' ? 1 : 0.5
    paintFlipper(ctx, map, bat, inward, batScale)
  }

  drawZoneEdgeMarkers(ctx, map, zone, shotsById, trim, rectXBounds(rect))
}

/** Transient tap-to-identify callout (t12c) — a leader line + rounded-pill
 *  label, clamped inside the canvas the same way drawing.ts's drawLabel
 *  clamps its action-label bubble. */
function drawIdentifyCallout(
  ctx: CanvasRenderingContext2D,
  shot: Shot,
  point: { x: number; y: number },
  canvasSize: { width: number; height: number },
  cardBounds?: LabelBounds,
): void {
  const text = shot.name
  ctx.font = `600 12px ${FONT_STACK}`
  const textWidth = ctx.measureText(text).width
  const width = textWidth + 24
  const height = 24

  let centerX = point.x
  let centerY = point.y - 24 - height / 2
  const edge = 6
  // The PILL is clamped to the card when the caller knows where the card is
  // (2026-08-14), and to the canvas otherwise. The leader line below still
  // starts at the shot's real point, so the callout keeps pointing at what it
  // names however far the pill had to slide.
  const lo = (cardBounds ? cardBounds.left : 0) + width / 2 + edge
  const hi = (cardBounds ? cardBounds.right : canvasSize.width) - width / 2 - edge
  centerX = lo > hi ? (lo + hi) / 2 : Math.min(Math.max(centerX, lo), hi)
  centerY = Math.max(centerY, height / 2 + edge)

  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(point.x, point.y - 6)
  ctx.lineTo(centerX, centerY + height / 2)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.lineWidth = 1
  ctx.stroke()

  roundedRectPath(ctx, centerX - width / 2, centerY - height / 2, width, height, height / 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
  ctx.fill()
  roundedRectPath(ctx, centerX - width / 2, centerY - height / 2, width, height, height / 2)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  ctx.fillText(text, centerX, centerY)

  ctx.beginPath()
  ctx.arc(point.x, point.y, 6, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'
  ctx.lineWidth = 1.5
  ctx.stroke()
}

/** Goal sheet row — SAME row spec as ar/arview.ts's `buildGoalRow` (bar,
 *  title+meta, difficulty pips, checkmark). This is a standalone copy, not a
 *  shared import — the two sheets are independently mounted (Map tab vs AR),
 *  same rationale as ui/fxGlyphs.ts's own header comment for duplicating the
 *  glyph table rather than reaching into a sibling agent's module.
 *
 *  NO LEADING fx GLYPH (BACKGLASS, P5 2026-08-14). The row title used to be
 *  `` `${glyphFor(goal.fx ?? data.defaultFx)}  ${title}` `` (correction 12).
 *  It came out of the concept render as the weakest element on the screen:
 *  a machine's goals almost all share one `fx`, so a list of five rows drew
 *  five identical 💀 down the left margin — a repeated bullet carrying zero
 *  information, in the one colour space (full-colour emoji) that cannot join
 *  a one-accent palette. The CATEGORY BAR beside it already carries identity,
 *  and does it per-row. The glyph is kept where it is one-per-screen and
 *  means something: the map's celebration burst (drawGoalOverlay's
 *  `celebrate.glyph`, still resolved by glyphFor below in renderMainLevel).
 *  See design3/BACKGLASS-NOTES.md §9. */
function buildGoalRow(state: AppState, g: Goal, color: string, opts: GoalRowOpts): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'map-gsheet-row'

  const bar = document.createElement('span')
  bar.className = 'map-gsheet-row-bar'
  bar.style.background = color

  const body = document.createElement('div')
  body.className = 'map-gsheet-row-body'
  const title = document.createElement('div')
  title.className = 'map-gsheet-row-title'
  title.textContent = g.title
  const meta = document.createElement('div')
  meta.className = 'map-gsheet-row-meta'
  const metaParts = [opts.metaLead ?? `${g.steps.length} step${g.steps.length === 1 ? '' : 's'}`]
  if (g.reward) metaParts.push(g.reward)
  meta.textContent = metaParts.join(' · ')
  body.append(title, meta)

  // Right-hand slot: the difficulty pips, or — for a row that LEAVES this tab
  // — a chevron saying so. A pathless goal's difficulty is real and is shown
  // on the Goals tab it sends you to; what this sheet has to answer about that
  // row is "where does tapping it take me", which pips cannot say.
  const trailing = document.createElement('span')
  if (opts.trailing === 'jump') {
    trailing.className = 'map-gsheet-row-jump'
    trailing.setAttribute('aria-hidden', 'true')
    trailing.textContent = '›' // ›
  } else {
    trailing.className = 'map-gsheet-row-pips'
    trailing.textContent = pipsTextWithEmpty(g.difficulty)
  }

  const check = document.createElement('span')
  check.className = 'map-gsheet-row-check'
  check.textContent = state.selectedGoal?.id === g.id ? '✓' : ''

  row.append(bar, body, trailing, check)
  if (opts.onActivate) {
    row.addEventListener('click', opts.onActivate)
  } else {
    // THE DISABLED STATE IS THE ABSENCE OF AN ACTION, not a separate flag the
    // caller could forget to pair with one: a row with nothing to do is
    // rendered, dimmed, and never wired for a tap. `disabled` (the property,
    // which reflects to the attribute) is also what ui/sheet.ts's
    // focusableWithin skips, so the sheet's focus trap steps over these rows
    // instead of parking on a control that does nothing.
    row.disabled = true
    row.classList.add('map-gsheet-row-disabled')
  }
  if (!opts.reason) return row

  // THE REASON LIVES OUTSIDE THE BUTTON (K3 review, 2026-08-14). It started
  // inside the row body, which is the one place it must not be: a native
  // `disabled` button is removed from the tab order, and assistive tech
  // varies on whether it exposes a disabled control's SUBTREE at all in
  // browse/swipe navigation. The sentence explaining why the row cannot be
  // used would then be the part most likely to go unread — the exact opposite
  // of what P7b is for.
  //
  // So the row becomes [button][reason] inside a plain wrapper, and the reason
  // is a SIBLING: it is ordinary page text, reachable by any browse mode that
  // can reach the row at all, whatever the button's disabled state does to its
  // own contents. `disabled` itself is unchanged and stays the containment
  // mechanism — this changes only where the explanation sits.
  //
  // No aria-describedby to go with it: the association is positional and
  // visual, and a describedby on a disabled control is announced even less
  // consistently than the subtree this is escaping.
  const wrap = document.createElement('div')
  wrap.className = 'map-gsheet-row-wrap'
  const reason = document.createElement('div')
  reason.className = 'map-gsheet-row-reason'
  reason.textContent = opts.reason
  wrap.append(row, reason)
  return wrap
}

/** How ONE goal is offered in the sheet — decided per goal by goalRowOpts
 *  below, rendered by buildGoalRow above. */
interface GoalRowOpts {
  /** What a tap does. `null` is the whole disabled state — see buildGoalRow. */
  onActivate: (() => void) | null
  /** Replaces the "N steps" lead of the meta line (any reward still follows
   *  it). "0 steps" is not a fact worth printing about a pathless goal. */
  metaLead?: string
  /** One line under the row saying WHY it reads as it does. Rendered as a
   *  SIBLING of the row button, never inside it — see buildGoalRow. */
  reason?: string
  /** Right-hand slot — difficulty pips (default), or a › for a row that
   *  leaves the Map tab. */
  trailing?: 'pips' | 'jump'
}

/**
 * The three ways this app has to say "this goal's route needs a shot the
 * current MODEL doesn't have", derived ONCE so the sheet row, the goal pill's
 * chip and the MODEL-switch toast can never word the same fact differently.
 *
 * Only the premium-le-under-PRO case is named exactly, because it is the only
 * one the shipped data can produce: every shot in data/ carries 'all' or
 * 'premium-le' and nothing else (ui/goalMeta.ts's goalReferencesPremiumLe doc
 * comment, measured 2026-08-10). A future pro-only shot would block a goal
 * under PREM/LE instead, and this says so without guessing which model it
 * wants — the same "never guess" rule stepProvenance follows.
 *
 * Exported for direct testing (tests/goal-bridge.test.mjs) without mounting
 * the map, same as visibleShotsForTrim below.
 */
export function trimBlockCopy(
  goal: Goal,
  shotsById: Map<string, Shot>,
  trim: 'pro' | 'premium-le',
): { chip: string; reason: string; needs: string } {
  // "switch MODEL", NOT "switch MODEL in settings" (2026-08-14). The old
  // wording named a LOCATION, and the location stopped being unique the moment
  // the Study rail grew its own MODEL control: a Study-tab reader was told to
  // open a settings popover on a different tab while the identical switch sat
  // two inches below the sentence. The control's LABEL is the same word on
  // both surfaces, so naming the label and not the room is the version that
  // stays true wherever this string is rendered — and it is one string, so
  // there is no per-surface variant to keep in step.
  if (trim === 'pro' && goalReferencesPremiumLe(goal, shotsById)) {
    return { chip: 'NOT ON PRO', reason: 'Needs Premium/LE — switch MODEL', needs: 'needs Premium/LE' }
  }
  return { chip: 'NOT ON THIS MODEL', reason: 'Not on this model — switch MODEL', needs: 'not on this model' }
}

/**
 * Which of the FOUR row treatments `g` gets, and what each one does.
 *
 * ROUTED — the ordinary case: tap selects the goal and closes the sheet.
 * CHARACTER (2026-08-15) — a pathless 'progression' goal (ui/goalMeta.ts's
 *   isCharacterGoal): the hero you pick, the gear you bank, the XP that
 *   outlives the ball. This material now has a door of its own — the Study
 *   tab's CHARACTER sheet — and the owner's instruction was to move it there
 *   ("drop character dev info from shots and only have it in study"). The ROW
 *   STAYS, because P7b's contract is that this sheet lists every goal the
 *   machine has and a silent omission is the exact bug that contract exists to
 *   end; what changes is where tapping it goes. Without the wiring it falls
 *   through to the PATHLESS treatment below — the Goals tab still renders these
 *   goals, so the fallback is a working door, not a dead end.
 * PATHLESS — no route to draw, so tapping it here can only honestly hand the
 *   visitor to the screen that DOES render it: the Goals tab's detail view
 *   (jumpToGoalDetail, injected by app.ts). Without that wiring there is
 *   nowhere to send them, so the row says where to read it and is not
 *   tappable — a live-looking row that silently does nothing is the failure
 *   this whole pass exists to remove.
 * TRIM-BLOCKED — the route needs a shot this MODEL doesn't have, so tapping
 *   it would draw a route with a missing target. Disabled, and it says why.
 *
 * The trim-blocked test cannot overlap the other two: goalVisibleForTrim is
 * `steps.every(...)` and a pathless goal has no steps, so it is vacuously
 * visible under both trims and can only ever land in a pathless branch.
 */
function goalRowOpts(
  state: AppState,
  g: Goal,
  onPicked: () => void,
  jumpToGoalDetail?: (goal: Goal) => void,
  jumpToStudyCharacter?: () => void,
): GoalRowOpts {
  if (isPathless(g)) {
    // THE CHARACTER BRANCH IS FIRST, and it is a strict subset of the pathless
    // one: every character goal is pathless, so ordering these the other way
    // round would make this branch unreachable. The predicate is imported from
    // ui/goalMeta.ts — the SAME function the Study rail's pill visibility and
    // that sheet's own body are built from, so a row can never send anyone to
    // a door that is not there.
    if (jumpToStudyCharacter && isCharacterGoal(g)) {
      return {
        onActivate: () => {
          onPicked()
          jumpToStudyCharacter()
        },
        // Names the DOOR and the TAB, because this jump leaves the tab you are
        // on — the same job "opens instructions" does for the Goals tab below.
        metaLead: 'No map route — opens CHARACTER in Study',
        trailing: 'jump',
      }
    }
    if (!jumpToGoalDetail) return { onActivate: null, metaLead: 'No map route', reason: 'Read it on the Goals tab' }
    return {
      onActivate: () => {
        onPicked()
        jumpToGoalDetail(g)
      },
      metaLead: 'No map route — opens instructions',
      trailing: 'jump',
    }
  }
  if (!goalVisibleForTrim(g, state.shotsByID, state.trim)) {
    return { onActivate: null, reason: trimBlockCopy(g, state.shotsByID, state.trim).reason }
  }
  return {
    onActivate: () => {
      selectSkillshotAtTarget(state, g)
      onPicked()
    },
  }
}

/**
 * Goal sheet body — same category-grouped-section shape as ar/arview.ts's
 * `buildGoalSheetBody`.
 *
 * P7b (2026-08-14): THIS SHEET LISTS EVERY GOAL THE MACHINE HAS. It used to
 * drop two kinds silently:
 *
 *   * PATHLESS goals (2026-07-31) — 'secret'/'progression' entries whose
 *     instructions are prose rather than shots ("hold both flippers in attract
 *     mode"). Omitted so a visitor couldn't pick one and land on a blank
 *     playfield with a "SHOT 1 OF 0" readout.
 *   * TRIM-BLOCKED goals (A3, 2026-08-10) — a route needing a shot the current
 *     MODEL doesn't have. Omitted so a pick couldn't draw a route with a
 *     missing target.
 *
 * Both omissions fixed a real bug and both created a worse one: the SAME
 * machine's goal list is different on the Goals tab and here, with nothing on
 * screen accounting for the difference. A visitor who read about a goal on one
 * tab and cannot find it on the other has no way to learn that the app did
 * that on purpose — the sheet's own "N LOADED" count contradicted what it
 * drew. So the rows stay, and each one says what it is: goalRowOpts above
 * decides which of the three treatments each goal gets. Nothing about the
 * original two bugs is reintroduced — a blocked row is not tappable, and a
 * pathless row goes where the instructions actually are.
 *
 * `jumpToGoalDetail` and `jumpToStudyCharacter` are mountMap2D's (see its doc
 * comment): the Goals-tab detail jump a pathless row needs, and the Study-tab
 * CHARACTER door a pathless PROGRESSION row needs. Both are threaded straight
 * through to goalRowOpts, which decides which row gets which.
 */
function buildGoalSheetBody(
  state: AppState,
  onPicked: () => void,
  jumpToGoalDetail?: (goal: Goal) => void,
  jumpToStudyCharacter?: () => void,
): HTMLElement {
  const wrap = document.createElement('div')
  const allGoals = state.data?.goals ?? []
  const filtered = filterGoalsByBallPosition(allGoals, state.shotsByID, state.ballPosition)

  if (filtered.length === 0) {
    const msg = document.createElement('div')
    msg.className = 'state-message'
    msg.textContent = 'No goals loaded for this machine yet.'
    wrap.appendChild(msg)
    return wrap
  }

  const byCategory = new Map<GoalCategory, Goal[]>()
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, [])
  for (const g of filtered) byCategory.get(g.category)?.push(g)

  for (const cat of CATEGORY_ORDER) {
    const goals = byCategory.get(cat)
    if (!goals || goals.length === 0) continue
    const meta = CATEGORY_META[cat]
    const header = document.createElement('div')
    header.className = 'map-gsheet-section'
    const dot = document.createElement('span')
    dot.className = 'map-gsheet-section-dot'
    dot.style.background = meta.color
    const label = document.createElement('span')
    label.className = 'map-gsheet-section-label'
    label.textContent = meta.label.toUpperCase()
    header.append(dot, label)
    wrap.appendChild(header)
    for (const g of goals) {
      wrap.appendChild(buildGoalRow(state, g, meta.color, goalRowOpts(state, g, onPicked, jumpToGoalDetail, jumpToStudyCharacter)))
    }
  }
  return wrap
}

/**
 * The trim filter for everything the Map tab draws EXCEPT the selected
 * goal's own route (phase A3, 2026-08-10): shots not visible under `trim`
 * (shotgeom.ts's isShotVisible) are dropped — UNLESS the currently selected
 * goal's route needs them.
 *
 * THE INVARIANT: this filter never subtracts anything the selected goal
 * needs to draw, even under a MODEL setting where that shot wouldn't
 * otherwise be visible — a player who has MODEL set one way but selected a
 * goal that touches the other model's content should still see their own
 * route intact, not have shots vanish out from under an already-drawn goal.
 *
 * `state.shotsByID` (the full, UNFILTERED map) is untouched by this — only
 * what render() below hands to the background art / dots / tap-to-identify
 * hit-testing is filtered; drawGoalOverlay's own `shotsByID` option keeps
 * reading the full map so route resolution (feeds, apex, etc.) never has a
 * hole punched in it. Exported for direct unit testing
 * (tests/trim-filter.test.mjs).
 */
export function visibleShotsForTrim(
  shots: readonly Shot[],
  trim: 'pro' | 'premium-le',
  selectedGoal: Goal | null | undefined,
): Shot[] {
  const visible = shots.filter((s) => isShotVisible(s, trim))
  if (!selectedGoal || selectedGoal.steps.length === 0) return visible
  const seen = new Set(visible.map((s) => s.id))
  const byId = new Map(shots.map((s) => [s.id, s]))
  const extra: Shot[] = []
  for (const step of selectedGoal.steps) {
    if (seen.has(step.shot)) continue
    const shot = byId.get(step.shot)
    if (!shot) continue
    seen.add(step.shot)
    extra.push(shot)
  }
  return extra.length > 0 ? [...visible, ...extra] : visible
}

/** Local point alias — mirrors drawing.ts's own `Pt` (not exported from
 *  there; trivial enough that duplicating beats widening that file's export
 *  surface, same rule this file's own withAlpha doc comment documents). */
type Pt = { x: number; y: number }

// ---------------------------------------------------------------------------
// Feature 2 (2026-08-11, GENERALIZED the same day): PLAYFIELD LEVEL VIEW. A
// machine's own `playfields[]` may declare any number of zones, of ANY
// `kind` — raised 'upper'/'mini' decks, or a sunken 'lower' sub-playfield
// (PlayfieldZone's own doc comment) — the settings popover's LEVEL control
// (mountMap2D below) lets the player switch the WHOLE map canvas to a
// zoomed-in view of just ONE zone at a time: its own bounds fill the
// playfield rect (own aspect, via playfieldRect's `aspect` param above),
// only member shots + the zone's own deck bat draw, a simple plate-floor
// treatment stands in for the raised/sunken plate art the MAIN view uses
// (drawZoneFloor, kind-branched — see its own doc comment), and entry/exit
// markers show where the ball crosses the zone's edge.
//
// ORIGINALLY (this feature's first cut, same day) the control was a fixed
// two-button MAIN/−1 pair scoped to a SINGLE `kind:'lower'` zone — no
// shipped machine had one yet, so it was exercised purely through synthetic
// fixtures in tests/deck-route.test.mjs. Once real zone data landed
// (halloween/jaws/evil_dead/~26 P2 machines' upper+mini decks, plus real
// `kind:'lower'` zones on ac_dc/munsters/street_fighter_ii/evil_dead), the
// owner: "there should be a toggle like we have for LE and regular games to
// show the other playfields but instead of version of the game it just
// scrolls thru the levels of playfields." GENERALIZED the same day: the
// control now offers MAIN plus ONE ENTRY PER VISIBLE ZONE (machineZones
// below), of ANY kind, labeled by the zone's own name — e.g. a two-way
// MAIN | ORCA DECK pair, or a three-way MAIN | STRODE HOUSE | SANITARIUM.
// Rendered as a segmented control (MODEL/TRAIL STYLE's own recipe, extended
// to N buttons) while the total option count fits LEVEL_SEGMENTED_MAX, else
// a compact ‹ › scroller row — see refreshLevelControl() in mountMap2D
// below, which also documents the choice.
//
// The render PATH itself needed almost no changes for this: renderZoneLevel
// (mountMap2D), zoneLocalMap, drawZoneEdgeMarkers, and drawZoneGoalRoute
// were ALREADY kind-agnostic — bounds- and `Shot.playfield`-id-based, never
// conditional on `PlayfieldZone.kind`. drawZoneFloor was the one exception
// (it painted the sunken/dashed 'lower' look unconditionally); see its own
// doc comment for the narrow fix.
// ---------------------------------------------------------------------------

/** MAIN-eligible zones — every `playfields[]` entry, of ANY kind (upper,
 *  mini, OR lower), visible under `trim` (shotgeom.ts's isZoneVisible), in
 *  data order. Generalizes Feature 2's original `visibleLowerZones` (which
 *  only ever surfaced `kind:'lower'`) to the full LEVEL-control redesign —
 *  see this file's Feature 2 header comment above. Exported for direct
 *  testing (tests/deck-route.test.mjs) without mounting the full DOM
 *  control; also what `machineHasLowerZone` below and mountMap2D's
 *  refreshLevelControl() both build on. */
export function machineZones(playfields: readonly PlayfieldZone[] | null | undefined, trim: 'pro' | 'premium-le'): PlayfieldZone[] {
  return (playfields ?? []).filter((z) => isZoneVisible(z, trim))
}

/** Whether the machine has at least one visible `kind:'lower'` zone under
 *  `trim`. PRE-GENERALIZATION this WAS the map's LEVEL control's own
 *  visibility gate (a lower zone was the only kind Feature 2's first cut
 *  ever handled); the control itself now gates on
 *  `machineZones(...).length > 0` instead (any kind — see
 *  refreshLevelControl() in mountMap2D below). Kept, behavior UNCHANGED,
 *  because tests/deck-route.test.mjs imports it directly (the owner spec's
 *  own "keep the old export working if tests import it" rule) — and it
 *  remains a reasonable question to ask on its own. */
export function machineHasLowerZone(playfields: readonly PlayfieldZone[] | null | undefined, trim: 'pro' | 'premium-le'): boolean {
  return machineZones(playfields, trim).some((z) => z.kind === 'lower')
}

/** Resolves the LEVEL control's next `mapLevel` after the machine's visible-
 *  zone roster changes: 'main' is always valid; a zone id survives only
 *  while `zones` still contains it, else falls back to 'main'. This is what
 *  makes "session-local level state resets on machine AND trim switch"
 *  true — a machine switch clears `mapLevel` outright (mountMap2D's
 *  syncMachineLocalState, unconditional), and a TRIM switch runs through
 *  here (refreshLevelControl, below): a premium-le zone selected, then
 *  MODEL -> pro, falls back to 'main' because that zone no longer appears
 *  in `machineZones(..., 'pro')`; a trim-less (or dual-trim) zone survives
 *  the same switch unchanged, because it does. Pure/exported so this rule
 *  is directly testable without mounting mountMap2D's DOM (this suite has
 *  no jsdom — every control here is tested through its pure pieces, same as
 *  machineHasLowerZone/machineZones above). mountMap2D's
 *  refreshLevelControl() below is the only runtime caller. */
export function resolveMapLevel(current: 'main' | string, zones: readonly PlayfieldZone[]): 'main' | string {
  if (current === 'main') return 'main'
  return zones.some((z) => z.id === current) ? current : 'main'
}

/** The segmented control (MODEL/TRAIL STYLE's own recipe) comfortably fits
 *  up to this many total options (MAIN + zones) in the popover's fixed
 *  230px width. A machine with more levels than that — no shipped machine
 *  as of this writing, max 2 zones on any one machine (e.g. halloween,
 *  wizard_of_oz, popeye) = 3 options with MAIN — gets the compact ‹ ›
 *  scroller instead (refreshLevelControl(), mountMap2D below). Exported so
 *  the threshold is pinned by a test rather than living only as a magic
 *  number inside that function. */
export const LEVEL_SEGMENTED_MAX = 3

/** A MapFn that re-maps MAIN-playfield UV (the same coordinate space every
 *  shot/zone already lives in — PlayfieldZone's own doc comment: "a zone is
 *  a labeled region of that square, not a second coordinate space") into
 *  `rect`, treating `zone.bounds` as the FULL [0,1]x[0,1] unit square for
 *  this view. A point outside the zone's own bounds maps outside `rect`
 *  (linear extrapolation, same "MapFn never clamps" contract as the main
 *  map — CONTRACTS.md) — used deliberately by drawZoneGoalRoute below to
 *  detect off-zone geometry rather than to draw it. */
export function zoneLocalMap(zone: PlayfieldZone, rect: Rect): MapFn {
  const { x: zx, y: zy, w: zw, h: zh } = zone.bounds
  return (u, v) => {
    const zu = zw > 0 ? (u - zx) / zw : 0.5
    const zv = zh > 0 ? (v - zy) / zh : 0.5
    return { x: rect.x + zu * rect.w, y: rect.y + rect.h - zv * rect.h }
  }
}

/** Zone-local fraction (zu, zv), CLAMPED to [0,1], converted back to a
 *  MAIN-UV point still inside `zone.bounds` — pins a point that resolves
 *  OUTSIDE the zone (e.g. an `exits[]` FeedRef, which by definition lands
 *  back on the main table) to the nearest point on the zone's own edge. A
 *  point that's already inside the zone (the common case for `entries[]`,
 *  which resolve to where the ball lands ON this zone) round-trips
 *  unchanged. This is the "entry/exit markers at the zone edge where
 *  entries[]/exits[] resolve" rule from a single, deterministic function. */
function clampToZoneEdge(uv: Pt, zone: PlayfieldZone): Pt {
  const { x: zx, y: zy, w: zw, h: zh } = zone.bounds
  const zu = zw > 0 ? clamp01((uv.x - zx) / zw) : 0.5
  const zv = zh > 0 ? clamp01((uv.y - zy) / zh) : 0.5
  return { x: zx + zu * zw, y: zy + zv * zh }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/** Full-card floor treatment for the LEVEL view — reuses the SAME visual
 *  language drawPlayfieldArt's own zone-plate loop (above) already gives a
 *  zone of THIS kind on the MAIN view: dark fill + dashed outline for a
 *  sunken `kind:'lower'` inset window, or light fill + solid outline for a
 *  raised `kind:'upper'`/`'mini'` plate — just filling the WHOLE playfield
 *  rect instead of a small inset, since this view IS that zone at full
 *  scale. Chosen over inventing a new treatment: a player who has already
 *  learned either visual grammar from the MAIN view sees the same one here,
 *  just zoomed in.
 *
 *  FIXED 2026-08-11 (LEVEL control generalization — this file's Feature 2
 *  header comment above): this function used to paint the sunken/dashed/
 *  "BELOW DECK" treatment UNCONDITIONALLY, regardless of `zone.kind` —
 *  harmless while the LEVEL control only ever offered a single `lower`
 *  zone, but wrong the moment it started offering upper/mini zones too: a
 *  raised deck would have rendered as a sunken one — the same "furniture
 *  that isn't there" factual-accuracy failure drawPlayfieldArt's own header
 *  (this file, above) already fixed once for the MAIN view's art.
 *  renderZoneLevel/zoneLocalMap/drawZoneEdgeMarkers/drawZoneGoalRoute were
 *  already kind-agnostic (bounds- and `.playfield`-id-based, never read
 *  `.kind`); this was the ONE hard-coded-'lower' spot in the LEVEL view's
 *  whole render path. */
export function drawZoneFloor(ctx: CanvasRenderingContext2D, rect: Rect, zone: PlayfieldZone): void {
  const corner = 12
  // Same card gradient the MAIN view's drawMapCardBackground paints, so
  // this still reads as "a card" — drawPlayfieldArt (the whole-table
  // background) has no place here, but the card's own chrome does.
  const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h)
  gradient.addColorStop(0, CARD_GRADIENT_A)
  gradient.addColorStop(1, CARD_GRADIENT_B)
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.fillStyle = gradient
  ctx.fill()

  if (zone.kind === 'lower') {
    // Sunken-zone treatment: dark fill + dashed outline — the SAME visual
    // language drawPlayfieldArt's own `kind:'lower'` inset-window branch
    // gives this kind on the MAIN view.
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.30)'
    ctx.fill()
    ctx.save()
    ctx.setLineDash([4, 4])
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
    ctx.lineWidth = 1.25
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
    drawZoneLabel(ctx, `${zone.name} · BELOW DECK`, rect.x + rect.w / 2, rect.y + 16, rectXBounds(rect))
  } else {
    // Raised-plate treatment ('upper' or 'mini') — the SAME visual language
    // drawPlayfieldArt's own raised-plate branch gives these kinds on the
    // MAIN view: light fill, solid outline, no dash. "BELOW DECK" is
    // specifically true of a sunken zone only, so a raised one gets its
    // plain name instead.
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.045)'
    ctx.fill()
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
    ctx.lineWidth = 1.25
    ctx.stroke()
    drawZoneLabel(ctx, zone.name, rect.x + rect.w / 2, rect.y + 16, rectXBounds(rect))
  }

  // Outer card border — matches drawMapCardBackground's own final stroke.
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.lineWidth = 2
  ctx.stroke()
}

/** Entry/exit edge markers for the LEVEL view — ALWAYS shown (goal-
 *  independent), per zone. `entries[]` (main-playfield shot ids whose feeds
 *  land on this zone) resolve via the SAME feedForTrim/resolveFeedUV rule-7
 *  machinery the route renderer uses; `exits[]` (FeedRef[] back onto the
 *  main table) resolve directly. Both are pinned to the zone's own edge via
 *  clampToZoneEdge — an entry's landing point is usually already inside the
 *  zone (a no-op clamp), an exit's is by definition outside it (a real
 *  clamp to the nearest edge/corner). Unresolvable entries/exits are
 *  skipped (fail-soft, same as every other feed resolution in this app). */
export function drawZoneEdgeMarkers(
  ctx: CanvasRenderingContext2D,
  zoneMap: MapFn,
  zone: PlayfieldZone,
  shotsById: Map<string, Shot>,
  trim: 'pro' | 'premium-le',
  /** Horizontal limits for the ENTRY/EXIT labels. Required in practice —
   *  asking `zoneMap` where u = 0 lands is meaningless (see drawing.ts's
   *  rectXBounds), so a caller that omits this gets no clamping rather than
   *  wrong clamping. */
  bounds?: LabelBounds,
): void {
  const markers: { kind: 'entry' | 'exit'; uv: Pt }[] = []
  for (const entryId of zone.entries ?? []) {
    const entryShot = shotsById.get(entryId)
    if (!entryShot) continue
    const feedUV = resolveFeedUV(feedForTrim(entryShot, null, trim), shotsById)
    if (feedUV) markers.push({ kind: 'entry', uv: clampToZoneEdge(feedUV, zone) })
  }
  for (const exitRef of zone.exits ?? []) {
    const exitUV = resolveFeedUV(exitRef, shotsById)
    if (exitUV) markers.push({ kind: 'exit', uv: clampToZoneEdge(exitUV, zone) })
  }
  for (const marker of markers) {
    const p = zoneMap(marker.uv.x, marker.uv.y)
    const r = 5
    ctx.beginPath()
    ctx.moveTo(p.x, p.y - r)
    ctx.lineTo(p.x + r, p.y)
    ctx.lineTo(p.x, p.y + r)
    ctx.lineTo(p.x - r, p.y)
    ctx.closePath()
    ctx.fillStyle = marker.kind === 'entry' ? 'rgba(52, 199, 89, 0.85)' : 'rgba(255, 149, 0, 0.85)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)'
    ctx.lineWidth = 1
    ctx.stroke()
    drawHaloLabel(ctx, marker.kind.toUpperCase(), p.x, p.y - r - 8, `700 9px ${DISPLAY_STACK}`, 'rgba(233, 237, 247, 0.75)', undefined, bounds)
  }
}

/** The zone's nearest `entries[]` landing point to `targetUV` (by straight-
 *  line UV distance) — used by drawZoneGoalRoute as the ORIGIN for a
 *  zone-member step whose predecessor (in the whole goal's real sequence)
 *  is NOT itself a member of this zone (including the goal's real step 0
 *  landing directly on the zone). Null when the zone has no entries, or
 *  none resolve — the caller then omits that step's leg entirely (ring/
 *  badge only), the same "steps not on the zone don't draw legs" rule
 *  generalized to "a leg that would have to originate off-zone doesn't
 *  draw" rather than inventing a fake origin. */
function nearestEntryUV(zone: PlayfieldZone, shotsById: Map<string, Shot>, trim: 'pro' | 'premium-le', targetUV: Pt): Pt | null {
  let best: Pt | null = null
  let bestDist = Infinity
  for (const entryId of zone.entries ?? []) {
    const entryShot = shotsById.get(entryId)
    if (!entryShot) continue
    const feedUV = resolveFeedUV(feedForTrim(entryShot, null, trim), shotsById)
    if (!feedUV) continue
    const d = Math.hypot(feedUV.x - targetUV.x, feedUV.y - targetUV.y)
    if (d < bestDist) {
      bestDist = d
      best = feedUV
    }
  }
  return best
}

/**
 * The selected goal's route, drawn WITHIN the LEVEL view — deliberately
 * NOT a call into drawGoalOverlay's full tracer/marching-highlight engine
 * (that engine is indexed against the WHOLE goal's step array via
 * `state.stepIndex`/`state.highlightMode`, and this view only ever shows a
 * FILTERED subset of those steps; reindexing them for a synthetic sub-goal
 * would either desync from the ‹ › controls, which drive the ORIGINAL
 * indices, or require teaching drawGoalOverlay a THIRD indexing scheme for
 * a feature with zero shipped data to validate against — see this file's
 * Feature 2 header comment). Instead, every ZONE-MEMBER step draws its own
 * ring + numbered badge (the badge shows the step's ORIGINAL whole-goal
 * index, matching the Goals tab and the MAIN map) directly, always at a
 * single consistent "shown" style — no live tracer/active-step distinction
 * inside this static sub-view.
 *
 * Legs route via resolveShootingAnchor exactly like Feature 1's default (the
 * zone's own deck bat when it has one), or straight target-to-target when
 * the step is `direct:true` (mirrors drawing.ts's routeSegment). A step
 * whose immediate PREDECESSOR (in the whole goal) is also a zone member
 * chains from that predecessor's own rule-7 feed exit, exactly like the
 * MAIN view; a step whose predecessor is off-zone (including the goal's
 * real step 0) originates instead at nearestEntryUV's resolved entry point
 * — reusing the SAME "entry marker" mechanism the always-on edge markers
 * already compute, rather than inventing a second one. When neither
 * resolves, the step draws its ring/badge only — "steps not on the zone
 * don't draw legs" (chosen over dimming a ring at an edge marker: that
 * alternative only has a well-defined position for a step whose OWN shot
 * happens to equal one of the zone's entries[], not for an arbitrary
 * off-zone step, so a uniform omit rule is both simpler and correct for
 * every case — documented choice, see this file's Feature 2 header).
 *
 * KNOWN SIMPLIFICATION: a goal that visits this zone, leaves, and returns
 * (two non-adjacent runs of zone-member steps) chains its second run's
 * first step from the FIRST run's own feed exit, same as if the off-zone
 * excursion between them didn't happen — acceptable given no shipped
 * machine has a lower zone yet; a future multi-hop deck/main/deck goal
 * would need per-run re-anchoring at the entry point, out of scope here.
 */
export function drawZoneGoalRoute(
  ctx: CanvasRenderingContext2D,
  zoneMap: MapFn,
  zone: PlayfieldZone,
  zonesById: Map<string, PlayfieldZone>,
  goal: Goal,
  shotsById: Map<string, Shot>,
  trim: 'pro' | 'premium-le',
  color: string,
): void {
  const steps = goal.steps
  const badgesInformative = goalBadgesAreInformative(goal)
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const shot = shotsById.get(step.shot)
    if (!shot || shot.playfield !== zone.id) continue
    const targetUV: Pt = { x: shot.x, y: shot.y }
    const targetView = zoneMap(shot.x, shot.y)

    const prevStep = i > 0 ? steps[i - 1] : undefined
    const prevShot = prevStep ? shotsById.get(prevStep.shot) : undefined
    let fromUV: Pt | null
    if (prevShot && prevShot.playfield === zone.id) {
      const prevFeedUV = resolveFeedUV(feedForTrim(prevShot, prevStep!.feeds, trim), shotsById)
      fromUV = prevFeedUV ?? { x: prevShot.x, y: prevShot.y }
    } else {
      fromUV = nearestEntryUV(zone, shotsById, trim, targetUV)
    }

    if (fromUV) {
      const fromView = zoneMap(fromUV.x, fromUV.y)
      const anchor = resolveShootingAnchor(shot, fromUV, step.flipper, shotsById, zonesById)
      const anchorView = zoneMap(anchor.uv.x, anchor.uv.y)
      const direct = step.direct === true
      const snapped = Math.hypot(fromUV.x - anchor.uv.x, fromUV.y - anchor.uv.y) < FLIPPER_SNAP
      ctx.save()
      ctx.setLineDash([])
      ctx.strokeStyle = withAlpha(color, 0.8)
      ctx.lineWidth = 2.5
      ctx.lineCap = 'round'
      if (direct || snapped) {
        ctx.beginPath()
        ctx.moveTo(fromView.x, fromView.y)
        ctx.lineTo(targetView.x, targetView.y)
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.moveTo(fromView.x, fromView.y)
        ctx.lineTo(anchorView.x, anchorView.y)
        ctx.lineTo(targetView.x, targetView.y)
        ctx.stroke()
      }
      ctx.restore()
    }

    ring(ctx, targetView, 14, withAlpha(color, 0.55), 2)
    // Same badge rule as the MAIN view (./drawing's goalBadgesAreInformative,
    // shared rather than re-derived so the two views cannot disagree): a
    // number that can only ever read "1" is decoration. This view draws its
    // own badge instead of calling drawBadge because it labels EVERY
    // zone-member step with its whole-goal number, not just the active one —
    // so when the badge does draw, `i + 1` stays the original index.
    if (badgesInformative) {
      disc(ctx, { x: targetView.x + 20, y: targetView.y - 20 }, 10, 'rgba(0, 0, 0, 0.65)')
      ctx.save()
      ctx.font = `700 11px ${DISPLAY_STACK}`
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), targetView.x + 20, targetView.y - 20)
      ctx.restore()
    }
  }
}

// ---------------------------------------------------------------------------
// Feature 3 (2026-08-11): CELEBRATION ARMING — the pure state machine behind
// the map-scoped celebration burst's MANUAL-mode "once per arrival" rule.
//
// drawGoalOverlay (overlay/drawing.ts) is a stateless per-frame renderer: in
// AUTO/tracer mode it can time the burst entirely off the tracer's own
// `sinceHit` (which already resets every loop cycle — "celebrate every loop
// arrival" needs no memory at all). MANUAL mode has no such clock
// (resolveActiveState parks `sinceHit` null there), and "celebrate ONCE per
// arrival, never while sitting, re-arm on leaving/returning or picking
// another goal" is an EDGE-TRIGGERED rule — it can only be decided by
// comparing THIS frame's (goal, stepIndex, highlightMode) against what they
// were the last time this ran. That comparison is exactly what this little
// state machine does, factored out to a PURE function (no DOM, no canvas,
// no closures) so it's directly unit-testable (tests/celebrate.test.mjs)
// without mounting the full mountMap2D DOM tree — mountMap2D below just
// threads its own `state`/`nowMs` through this on every render() call.
// ---------------------------------------------------------------------------

export interface CelebrationArmingState {
  /** Which goal this arming state belongs to — a change here always resets
   *  `armed`/`manualStartedAt`, same as picking a different goal from the
   *  sheet ("...or selects another goal" — the spec's own third re-arm
   *  trigger, alongside "steps away and returns"). */
  goalId: string | null
  /** May the NEXT manual arrival at the last step fire? */
  armed: boolean
  /** Relative-ms timestamp (SAME clock as drawGoalOverlay's `o.time`) the
   *  current manual-mode celebration began, or null when none is armed —
   *  this is exactly the value threaded into OverlayOpts.celebrate's own
   *  `manualStartedAt`. */
  manualStartedAt: number | null
}

/** The arming state before any goal has ever been selected, or after
 *  celebration has been toggled off / the machine has switched — armed,
 *  nothing in flight, belongs to no goal. */
export function initialCelebrationArmingState(): CelebrationArmingState {
  return { goalId: null, armed: true, manualStartedAt: null }
}

/**
 * One state-machine step, called once per render() frame with the CURRENT
 * (goal, stepIndex, highlightMode, relMs) — see mountMap2D's own call site
 * for what each maps to. Rules (mirrors the file header / drawing.ts's own
 * OverlayOpts.celebrate doc comment):
 *   - `celebrationOn` false, or no goal selected: reset to the initial
 *     state (still tagged with the current goal id, if any, so a re-toggle
 *     ON while sitting on the last step fires fresh rather than replaying
 *     stale arming from before it was switched off).
 *   - A different goal than last call: reset (armed, no timer) — "...or
 *     selects another goal".
 *   - MANUAL mode, parked on the goal's LAST step, still armed, no timer
 *     already running: ARM the burst (`manualStartedAt = relMs`, disarm).
 *     Sitting there on later calls (same step, already disarmed or already
 *     timed) changes nothing — no repeat.
 *   - MANUAL mode, parked anywhere else: re-arm (armed=true, timer
 *     cleared) — "...steps away and returns" needs exactly this on the
 *     "steps away" half; the "returns" half is the ARM branch above firing
 *     again on a later call.
 *   - AUTO mode (or a pathless/empty-steps goal, which has no "last step"
 *     to park manual mode on): drawGoalOverlay derives its own timing
 *     internally, so this just keeps `armed` true (ready for the next time
 *     the user pauses into manual) and clears any stale timer.
 */
export function nextCelebrationArmingState(
  prev: CelebrationArmingState,
  opts: {
    celebrationOn: boolean
    goal: { id: string; steps: readonly unknown[] } | null
    highlightMode: 'auto' | 'manual'
    stepIndex: number
    relMs: number
  },
): CelebrationArmingState {
  const { celebrationOn, goal, highlightMode, stepIndex, relMs } = opts
  if (!celebrationOn || !goal) {
    return { goalId: goal?.id ?? null, armed: true, manualStartedAt: null }
  }
  let next: CelebrationArmingState =
    prev.goalId !== goal.id ? { goalId: goal.id, armed: true, manualStartedAt: null } : prev
  const lastIndex = goal.steps.length - 1
  if (highlightMode === 'manual' && lastIndex >= 0) {
    if (stepIndex === lastIndex) {
      if (next.armed && next.manualStartedAt === null) {
        next = { ...next, armed: false, manualStartedAt: relMs }
      }
      // else: already fired (or already disarmed) for this arrival — no
      // change, no repeat.
    } else {
      next = { ...next, armed: true, manualStartedAt: null }
    }
  } else {
    next = { ...next, armed: true, manualStartedAt: null }
  }
  return next
}

// ---------------------------------------------------------------------------
// Feature 6 (2026-08-11): SKILL-SHOT BROWSE MODE — TARGET-ONLY (revised same
// day, twice over: first a HYBRID revision that walked a multi-step skill
// shot's OWN steps — plunge/setup step, then target — before rolling to the
// next skill shot; THIS revision replaces that, rolo's own live-design call:
// "Idk why you reference the shot lines first then the targets for skill
// shots 3 and more, just reference the targets the skill shots need to hit
// bc hitting the spot before the targets is irrelevant in jaws." The
// shooter-lane/setup step (Jaws L3/secret/super-secret's own plunge leg,
// e.g.) is real and still fully described on the Goals tab — untouched by
// this feature, see that tab's own step walker in app.ts — but is not worth
// an independent browse position on the Map: a skill shot browses as its
// target, full stop.
//
// So: every skill-shot goal is now ONE flat position in the browse
// sequence, always parked on its LAST step (`goal.steps.length - 1` — the
// target; a single-step skill shot's step 0 already IS its last step, so
// this is a no-op for those, same as before). SELECTING a skill shot (goal
// sheet row, or a ‹ ›/auto-cycle arrival — the machine-card column link this
// sentence originally also listed was retired 2026-08-11, see mountMap2D's
// own doc comment) always lands there: state.select() itself unconditionally
// resets stepIndex to 0
// (state.ts, out of scope here), so every entry point pairs it with an
// explicit state.goToStep(lastIndex) — selectSkillshotAtTarget below is the
// one place that pairing lives, shared by all of them. ‹ › (
// skillshotBrowseStep) has no "within-goal" case left at all — every press
// crosses to the adjacent skill shot (adjacentSkillshotGoal, still
// wrapping), landing on ITS last step regardless of direction. Auto-cycle
// (shouldAdvanceSkillshotBrowse) rolls goal-to-goal on a FLAT
// HIGHLIGHT_HOLD_S cadence — no more "one full lap through this goal's own
// steps" multiplier, since there is no lap left to run. The pill readout
// (skillshotReadoutLabel) dropped the a/b/c sub-lettering the HYBRID
// revision added for exactly that lap — single-step and multi-step skill
// shots read identically now, plain "SKILL SHOT n OF m · <title>".
//
// Celebration arming needs no NEW machinery for any of this —
// skillshotEffectiveHighlightMode (below) just tells
// nextCelebrationArmingState and the render call (renderMainLevel's own
// drawGoalOverlay `highlightIndex` opt) to treat EVERY skill shot as if
// permanently parked in 'manual' mode, regardless of the REAL
// state.highlightMode: since a skill shot's stepIndex is now always its
// target the instant it's selected, that is simply true, and reusing the
// existing MANUAL-mode edge-triggered rule (nextCelebrationArmingState
// itself, UNCHANGED — this file's Feature 3 header has it: "arm once per
// arrival, no repeat while sitting, re-arm on leaving/returning or
// switching goals") produces exactly "one burst per skill shot" for free.
// The REAL state.highlightMode is still what shouldAdvanceSkillshotBrowse
// reads to decide whether to keep auto-cycling at all — pausing (tap)
// still freezes on the current skill shot, same UI contract as any other
// goal. The Goals tab's own step-walker (app.ts) is completely unaffected
// — this is Map-tab-only.
// ---------------------------------------------------------------------------

/** The machine's skillshot goals in LADDER ORDER — the browse sequence
 *  Feature 6's ‹ › stepper (and auto-cycle) moves across.
 *
 *  DATA ORDER until 2026-08-15 (dataset schema v8, Goal.requires). A ladder
 *  read in the right sequence only because the file happened to list it that
 *  way, and the carousel had no way to know a rung was gated at all; ui/
 *  goalMeta.ts's orderByLadder sorts prerequisites ahead of what they gate and
 *  leaves everything unchained in data order behind them, so Jaws' secret and
 *  super-secret shots still browse where they always did while Levels 1-2-3
 *  are now ordered by rule rather than by luck. Nothing is dropped or
 *  duplicated — see that function's own doc comment. Exported for direct
 *  testing (tests/celebrate.test.mjs). */
export function skillshotGoals(data: GameData | null | undefined): Goal[] {
  return orderByLadder((data?.goals ?? []).filter((g) => g.category === 'skillshot'))
}

/** The skill shot WRAPPING `dir` (+1/-1) steps from `currentId` in `list` —
 *  "wraps... it's a browse carousel" (Feature 6's own documented choice
 *  over clamping at the ends). `currentId` not found in `list` (shouldn't
 *  happen in practice — the caller only calls this while a skillshot goal
 *  is selected) falls back to the first (dir:+1) or last (dir:-1) entry
 *  rather than throwing. Null only when `list` is empty. */
export function adjacentSkillshotGoal(list: readonly Goal[], currentId: string | undefined, dir: 1 | -1): Goal | null {
  if (list.length === 0) return null
  const idx = list.findIndex((g) => g.id === currentId)
  if (idx === -1) return dir === 1 ? list[0]! : list[list.length - 1]!
  const nextIdx = (idx + dir + list.length) % list.length
  return list[nextIdx]!
}

/** The goal+step a manual ‹ ›(dir:-1/+1) press should land on next — TARGET-
 *  ONLY revision (2026-08-11, rolo: "just reference the targets the skill
 *  shots need to hit... hitting the spot before the targets is
 *  irrelevant"): every press crosses to the ADJACENT skill shot
 *  (adjacentSkillshotGoal, still wrapping) regardless of direction — there
 *  is no "within-goal" case left to walk (that was the same-day-earlier
 *  HYBRID revision this supersedes; see this file's own Feature 6 header
 *  for the full history) — landing on the adjacent goal's OWN LAST step
 *  (`Math.max(next.steps.length - 1, 0)`) either way, so `‹ ‹ ‹ ...` and
 *  `› › › ...` each still read as one continuous walk across the whole
 *  browse sequence, always parked on a target. `stepIndex` is UNUSED now —
 *  kept (and `void`-ed below) purely so this export's call signature stays
 *  stable for any existing caller/test that still passes it positionally;
 *  mountMap2D's own ‹ › handlers still compute and pass their usual "base"
 *  index, now silently ignored. Returns null only when `list` is empty
 *  (nothing to browse at all — the same degenerate case
 *  adjacentSkillshotGoal already documents). Exported for direct testing
 *  (tests/celebrate.test.mjs). */
export function skillshotBrowseStep(
  list: readonly Goal[],
  goal: Goal,
  stepIndex: number,
  dir: 1 | -1,
): { goal: Goal; stepIndex: number } | null {
  void stepIndex // unused — see doc comment: target-only browse has no
  // "within-goal" position left for it to describe.
  const next = adjacentSkillshotGoal(list, goal.id, dir)
  if (!next) return null
  return { goal: next, stepIndex: Math.max(next.steps.length - 1, 0) }
}

/** "SKILL SHOT n OF m · <title>" pill/readout text for Feature 6's browse
 *  mode — n/m are 1-based position of `goal` within `list` (skillshotGoals'
 *  own return). TARGET-ONLY revision (2026-08-11): the a/b/c sub-lettering
 *  a same-day-earlier HYBRID revision added ("like shot 4a and 4b for
 *  walking thru", to distinguish a multi-step skill shot's own setup step
 *  from its target) is GONE — every skill shot is always parked on its
 *  target now (this file's own Feature 6 header has the full history), so
 *  single-step and multi-step goals read identically, exactly the
 *  pre-lettering format. `goal` not found in `list` (shouldn't happen in
 *  practice) reads as "1 OF m" rather than "0 OF m" or throwing. Exported
 *  for direct testing (tests/celebrate.test.mjs). */
export function skillshotReadoutLabel(list: readonly Goal[], goal: Goal): string {
  const { n, m } = skillshotPosition(list, goal)
  return `SKILL SHOT ${n} OF ${m} · ${goal.title}`
}

/** WHERE in the carousel a skill shot sits — the one derivation behind both
 *  the pill's shouted label above and P9's spoken mirror of it (mountMap2D's
 *  spokenReadout). Split out when the second reader arrived rather than
 *  copied: two independently-derived positions for the same goal is exactly
 *  the drift a screen-reader user could never see and a sighted user could
 *  never explain. Degenerate cases match the label's long-standing behaviour
 *  — a `goal` not in `list` reads as 1, an empty list as 1 rather than 0. */
export function skillshotPosition(list: readonly Goal[], goal: Goal): { n: number; m: number } {
  const idx = list.findIndex((g) => g.id === goal.id)
  return { n: idx >= 0 ? idx + 1 : 1, m: Math.max(list.length, 1) }
}

/** Pure predicate: should Feature 6's auto-cycle roll to the next skill
 *  shot goal right now? `elapsedS` is the caller's own
 *  (nowMs - state.routeStartedAt)/1000 — the SAME elapsed-time anchor the
 *  marching-highlight clock already uses elsewhere in this app, reused
 *  rather than a second closure timer (see mountMap2D's own
 *  advanceSkillshotBrowseIfDue, a thin wrapper calling this with live
 *  state). TARGET-ONLY revision (2026-08-11): the threshold is now a FLAT
 *  HIGHLIGHT_HOLD_S, not `steps.length * HIGHLIGHT_HOLD_S` (the same-day-
 *  earlier HYBRID revision's own "one full lap through the goal's own
 *  steps" rule — this file's own Feature 6 header has the full history) —
 *  there is no lap left to run now that a skill shot is always shown
 *  parked on its target the whole time it's up (renderMainLevel's own
 *  drawGoalOverlay call pins `highlightIndex` there via
 *  skillshotEffectiveHighlightMode below, so drawGoalOverlay's own
 *  autoHighlightIndex march never runs for one). Exported for direct
 *  testing (tests/celebrate.test.mjs). */
export function shouldAdvanceSkillshotBrowse(goal: Goal | null, highlightMode: 'auto' | 'manual', elapsedS: number): boolean {
  if (!goal || goal.category !== 'skillshot' || highlightMode !== 'auto') return false
  return elapsedS >= HIGHLIGHT_HOLD_S
}

/** Selects `g` and, for a 'skillshot' goal, immediately follows up with
 *  state.goToStep(lastIndex) — TARGET-ONLY browse's own entry rule (this
 *  file's Feature 6 header): state.select() itself always resets stepIndex
 *  to 0 (state.ts), so landing a skill shot on its target instead of its
 *  shooter-lane/setup step needs this explicit follow-up every time one is
 *  chosen from OUTSIDE the ‹ › carousel (skillshotBrowseStep/
 *  applySkillshotBrowseStep already handle that case themselves). Shared
 *  by two entry points that would otherwise each need their own copy of
 *  the same category check: the goal sheet row (buildGoalRow, module
 *  scope — hence `state` is a parameter here rather than a closure) and
 *  the auto-cycle's own goal-to-goal roll (mountMap2D's
 *  advanceSkillshotBrowseIfDue). (A third call site, the now-removed
 *  "card beside map" column's own goal link, was retired 2026-08-11 along
 *  with that whole feature — see mountMap2D's own doc comment.) A
 *  single-step skill shot (lastIndex 0)
 *  needs no follow-up call — state.select() already parked it there. Safe
 *  to call for ANY category (buildGoalRow picks from every category, not
 *  just skill shots) — the category check just makes it a no-op extra step
 *  for everything else. Exported for direct testing
 *  (tests/celebrate.test.mjs) against a minimal fake `state` (only
 *  `.select`/`.goToStep` need to exist — the same duck-typed-stub
 *  discipline every other suite here uses for a recording 2D context). */
export function selectSkillshotAtTarget(state: AppState, g: Goal): void {
  state.select(g)
  if (g.category === 'skillshot' && g.steps.length > 1) state.goToStep(g.steps.length - 1)
}

/** The highlightMode a skill shot's celebration arming
 *  (nextCelebrationArmingState) and render-level pin (renderMainLevel's own
 *  drawGoalOverlay `highlightIndex` opt) should actually be evaluated
 *  against, given the REAL `realMode` (state.highlightMode). TARGET-ONLY
 *  browse (this file's own Feature 6 header) means a 'skillshot' goal's
 *  state.stepIndex is ALWAYS its target the instant it's selected —
 *  guaranteed by selectSkillshotAtTarget above and skillshotBrowseStep's
 *  own return shape — whether the surrounding UI cadence is 'auto'
 *  (auto-cycling goal-to-goal) or 'manual' (paused): there is no
 *  "within-goal auto-march" left to run for one, unlike every other
 *  category, where `realMode` passes straight through unchanged.
 *  Deliberately NOT used by shouldAdvanceSkillshotBrowse/
 *  advanceSkillshotBrowseIfDue, which need the REAL state.highlightMode —
 *  auto-cycling itself must still stop when the user pauses. Exported for
 *  direct testing (tests/celebrate.test.mjs); shared by both call sites so
 *  they can never drift out of sync with each other. */
export function skillshotEffectiveHighlightMode(category: GoalCategory | undefined, realMode: 'auto' | 'manual'): 'auto' | 'manual' {
  return category === 'skillshot' ? 'manual' : realMode
}

/** How long the spoken readout folds a burst of moves into one line (P9) —
 *  the same window, for the same reason, as ui/study.ts's ANNOUNCE_WINDOW_MS
 *  (see announceReadout inside mountMap2D for why it is a copy). Long enough
 *  to swallow a held ‹ ›, short enough that a deliberate second press is
 *  still its own announcement. */
const READOUT_ANNOUNCE_WINDOW_MS = 250

/**
 * Mounts a self-contained, playfield-proportioned 2D map canvas into `host`,
 * alongside a `.map-goal-pill-row` (always visible — correction 12, now also
 * home to the settings ⚙ button, see below) and a `.map-step-controls` ‹ ›
 * bar (styles.css) that's shown only while a goal is selected — the Map
 * tab's manual-highlight-mode controls (see state.ts's `highlightMode`).
 * Renders a static frame when no goal is selected; runs a
 * requestAnimationFrame loop (for the Shot Coach tracer / marching
 * highlight) only while a goal is selected, stopping the instant it's
 * cleared.
 *
 * Also mounts a settings popover (Trail style / Ball tracer / Path labels /
 * Line brightness) — the Map-side home for the render prefs that used to
 * live only in ar/arview.ts's settings popover before the AR tab was removed
 * from this web app (2026-07-29, app.ts's header comment); see the "Settings
 * popover" block below for the full rationale.
 *
 * 2026-08-11 ("card beside map", rolo's live design feedback) briefly made
 * `host` a two-column flex row at wide viewports so a right-hand column
 * could reuse ui/machinecard.ts's renderMachineCard() beside the route —
 * REMOVED the same day (owner: "Remove all cards. That feature has been
 * removed."). `host` is back to being the map's own single positioning
 * context directly, exactly as before that feature: no wrapper column, no
 * `#app:has(#map-host ...)` width widening (styles.css), no `.map-col`/
 * `.map-card-col` (map2d.css). ui/machinecard.ts stays on disk, fully
 * unimported (UNIMPORT pattern, app.ts's header comment).
 *
 * `jumpToGoalDetail` (P7b, 2026-08-14) is how a PATHLESS goal's row in the
 * goal sheet reaches the only screen that can render it — the Goals tab's
 * detail view. TRAILING-OPTIONAL on purpose: every existing call site and
 * every suite that mounts this map with two arguments still compiles and
 * behaves identically, and the sheet degrades honestly without it (a pathless
 * row with nowhere to go is not tappable — see goalRowOpts above). app.ts
 * owns the jump itself.
 *
 * `speakReadout` (P9, 2026-08-14) is the same shape for the same reason: one
 * line that writes app.ts's polite live region, so the ‹ SHOT 3 OF 5 › pill
 * has a spoken mirror. Trailing-optional, so every 2- and 3-argument call
 * site still compiles and behaves exactly as before — a map mounted without
 * it is silent, not broken. See the SPOKEN READOUT block below for why the
 * region belongs to app.ts and not to this file.
 *
 * `jumpToStudyCharacter` (2026-08-15) is the third of these, in the same shape
 * for the third time: the Study tab's CHARACTER door, which a pathless
 * PROGRESSION row in the goal sheet now opens instead of the Goals tab (owner:
 * "drop character dev info from shots and only have it in study"). Every 2-,
 * 3- and 4-argument call site still compiles, and a map mounted without it
 * degrades to the behaviour those rows had yesterday — the Goals-tab jump —
 * rather than to a dead row.
 *
 * IT TAKES NO GOAL, unlike jumpToGoalDetail, and that is deliberate. The
 * CHARACTER sheet is a COLLECTION of a machine's character goals, not a detail
 * view of one, and the jump does not change machine — so the goal the row was
 * built from is already on the screen this opens. Passing it would be a
 * parameter app.ts reads for nothing.
 */
export function mountMap2D(
  host: HTMLElement,
  state: AppState,
  jumpToGoalDetail?: (goal: Goal) => void,
  speakReadout?: (text: string) => void,
  jumpToStudyCharacter?: () => void,
): { destroy(): void } {
  const canvas = document.createElement('canvas')
  canvas.className = 'map-canvas'
  // P9 (2026-08-14): A TEXT ALTERNATIVE FOR THE PICTURE. A bare <canvas> has
  // no implicit role and no name — it is announced as nothing at all, so the
  // biggest thing on this tab is invisible twice over. role=img plus a name
  // makes it ONE object with a label ("Playfield map of Jaws"), which is the
  // honest description of what it is: a picture. It deliberately does NOT try
  // to narrate the route inside it — that is what the spoken readout below,
  // the goal sheet's rows and the Study tab all already are, in real DOM.
  // The name is refreshed on machine change (refreshCanvasLabel below); a
  // label naming the machine you switched away from would be worse than none.
  canvas.setAttribute('role', 'img')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'

  // ---- Goal pill (correction 12) — always visible; opens the goal sheet. ----
  const goalPillRow = document.createElement('div')
  goalPillRow.className = 'map-goal-pill-row'

  const goalPill = document.createElement('button')
  goalPill.type = 'button'
  goalPill.className = 'map-goal-pill'
  const pillDot = document.createElement('span')
  pillDot.className = 'map-goal-pill-dot'
  const pillLabel = document.createElement('span')
  pillLabel.className = 'map-goal-pill-label'
  /** P7b (2026-08-14): "the goal you are looking at is not on the MODEL you
   *  have selected", said where the goal's name is.
   *
   *  The goal sheet now DISABLES such a goal and says why (goalRowOpts), but
   *  the sheet is not where the selection lives — a goal picked on the Goals
   *  tab (which never hides for trim; app.ts's renderGoalRow chips it instead)
   *  arrives here already selected, and the MODEL selector can be moved
   *  underneath one at any time. Without this the map would draw that route
   *  while the sheet listed it as unavailable: two surfaces, one machine, two
   *  different stories. Hidden whenever the selected goal is fine (the common
   *  case), so it costs the pill nothing on an ordinary route. */
  const pillChip = document.createElement('span')
  pillChip.className = 'map-goal-pill-chip'
  pillChip.hidden = true
  const pillChevron = document.createElement('span')
  pillChevron.className = 'map-goal-pill-chevron'
  pillChevron.textContent = '▼' // ▼
  goalPill.append(pillDot, pillLabel, pillChip, pillChevron)
  goalPill.setAttribute('aria-label', 'Choose a goal')

  // Settings button sits BETWEEN the pill and the ✕ clear button (not after
  // it) so its position is stable — clearBtn appears/disappears with goal
  // selection, and putting settings after it would shift the settings button
  // sideways every time a goal is picked/cleared.
  const settingsBtn = document.createElement('button')
  settingsBtn.type = 'button'
  settingsBtn.className = 'map-settings-btn'
  settingsBtn.setAttribute('aria-label', 'Map settings')
  for (let i = 0; i < 3; i++) {
    const bar = document.createElement('span')
    bar.className = 'map-settings-glyph-bar'
    settingsBtn.appendChild(bar)
  }

  const clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.className = 'map-goal-clear'
  clearBtn.hidden = true
  clearBtn.textContent = '✕' // ✕
  clearBtn.setAttribute('aria-label', 'Clear selected goal')

  goalPillRow.append(goalPill, settingsBtn, clearBtn)

  // ---- ‹ › step controls (manual highlight mode) — see the file header. ----
  const controls = document.createElement('div')
  controls.className = 'map-step-controls'

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.className = 'map-step-btn'
  prevBtn.textContent = '‹' // ‹
  prevBtn.setAttribute('aria-label', 'Previous shot')

  const readout = document.createElement('button')
  readout.type = 'button'
  readout.className = 'map-step-readout'
  // Choreography provenance + technique chips (phase B1/B2, 2026-08-10) —
  // ONE compact dim line ABOVE the SHOT N OF M label (the closest thing this
  // pill has to "the active step's text"; the step's actual action prose is
  // canvas-drawn by ./drawing.ts's drawActionLabel, out of scope here).
  // Hidden entirely when there's nothing to show — see updateControls().
  const readoutMeta = document.createElement('div')
  readoutMeta.className = 'map-step-readout-meta'
  readoutMeta.hidden = true
  const readoutLabel = document.createElement('div')
  readoutLabel.className = 'map-step-readout-label'
  const readoutSub = document.createElement('div')
  readoutSub.className = 'map-step-readout-sub'
  readout.append(readoutMeta, readoutLabel, readoutSub)

  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.className = 'map-step-btn'
  nextBtn.textContent = '›' // ›
  nextBtn.setAttribute('aria-label', 'Next shot')

  controls.append(prevBtn, readout, nextBtn)

  // ---- Settings popover (relocated off the AR tab — see this file's header
  // comment) ----
  /** Local-only render prefs, never persisted — same status quo
   *  showLabels/lineBrightness had as arview.ts-local `ArSettings` fields
   *  before AR removal (state.ts's header note: they were never AppState
   *  fields). trailStyle/ballTracer are NOT here — those are the persisted
   *  AppState fields (state.setTrailStyle/setBallTracer), read straight off
   *  `state` in render() below same as before this popover existed. */
  const settings = { showLabels: true, lineBrightness: 1 }

  // Feature 2 (2026-08-11, generalized the same day): the LEVEL selection.
  // 'main' | a PlayfieldZone id — ANY kind now (upper/mini/lower), not just
  // 'lower' — see machineZones(). SESSION-LOCAL, same never-persisted shape
  // as `settings` above — the spec's own words are "session-local state,
  // default MAIN, resets on machine switch", and the state.onChange
  // subscription below resets it back to 'main' the instant the machine
  // changes (see the machine-switch detection there); a trim switch that
  // hides the currently-selected zone falls back the same way, via
  // resolveMapLevel() inside refreshLevelControl() below.
  let mapLevel: 'main' | string = 'main'

  // Feature 3 (2026-08-11): celebration arming — the PURE state machine
  // (nextCelebrationArmingState, above mountMap2D) owns the actual rules;
  // this closure just holds the running state and calls it once per
  // render(), the same pattern lastAutoIndex/lastShotPoints already use for
  // analogous cross-frame memory.
  let celebrationArming: CelebrationArmingState = initialCelebrationArmingState()

  const settingsPopover = document.createElement('div')
  settingsPopover.className = 'map-settings-popover'
  settingsPopover.hidden = true

  /** Same on/off pill-toggle recipe as ar/arview.ts's buildToggleRow — a
   *  standalone copy (this file doesn't import from ar/arview.ts, same
   *  "self-contained" rule as its other DOM-building helpers). */
  function buildToggleRow(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const row = document.createElement('div')
    row.className = 'map-settings-row'
    const labelEl = document.createElement('div')
    labelEl.className = 'map-settings-row-label'
    labelEl.textContent = label
    const track = document.createElement('button')
    track.type = 'button'
    track.className = 'map-settings-toggle'
    const knob = document.createElement('span')
    knob.className = 'map-settings-toggle-knob'
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
    return row
  }

  /** One segmented-control button (MODEL, LEVEL, TRAIL STYLE — all five
   *  instances in this popover go through here).
   *
   *  THE LABEL IS A SPAN, NOT A TEXT NODE, and that is load-bearing rather
   *  than tidy: `.map-settings-segmented-btn` used to carry `overflow:hidden`
   *  itself (for the LEVEL control's ellipsized zone names), which silently
   *  clipped the button's own `::after` tap-target overlay — so the 44px hit
   *  area that rule claims to create did not exist. The clipping box is now
   *  this span, which contains only text, and the button clips nothing. See
   *  map2d.css's `.map-settings-segmented-label` comment.
   *
   *  `textContent` still reads back as the label (it aggregates through the
   *  span), so callers and tests that read it are unaffected. */
  function buildSegmentedBtn(label: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'map-settings-segmented-btn'
    const text = document.createElement('span')
    text.className = 'map-settings-segmented-label'
    text.textContent = label
    btn.appendChild(text)
    return btn
  }

  // MODEL — PRO/PREM-LE segmented control (phase A3, 2026-08-10). Same
  // segmented-control recipe as TRAIL STYLE below, wired to the persisted
  // per-machine AppState field (state.setTrim -> notify -> the
  // state.onChange subscription re-renders, same as every other control in
  // this popover). Only shown when the CURRENT machine actually has
  // trim-restricted content (ui/goalMeta.ts's machineHasVariants) — a
  // machine with no variants has nothing for this control to switch
  // between, so it stays hidden rather than offering a choice with no
  // effect. Visibility is refreshed by refreshModelControl(), called on
  // mount and on every state.onChange (machine switches included) — see
  // that subscription below.
  const modelWrap = document.createElement('div')
  modelWrap.className = 'map-settings-model'
  const modelLabel = document.createElement('div')
  modelLabel.className = 'map-settings-row-label'
  modelLabel.textContent = 'MODEL'
  const modelTrack = document.createElement('div')
  modelTrack.className = 'map-settings-segmented'
  const modelProBtn = buildSegmentedBtn('PRO')
  const modelPremBtn = buildSegmentedBtn('PREM/LE')
  modelTrack.append(modelProBtn, modelPremBtn)
  modelWrap.append(modelLabel, modelTrack)
  function refreshModelControl(): void {
    modelProBtn.classList.toggle('selected', state.trim === 'pro')
    modelPremBtn.classList.toggle('selected', state.trim === 'premium-le')
    modelWrap.hidden = !machineHasVariants(state.data)
  }
  modelProBtn.addEventListener('click', () => {
    state.setTrim('pro')
    refreshModelControl()
  })
  modelPremBtn.addEventListener('click', () => {
    state.setTrim('premium-le')
    refreshModelControl()
  })
  refreshModelControl()

  // LEVEL — MAIN + one entry per visible zone, ANY kind (Feature 2,
  // 2026-08-11; generalized the same day from a fixed MAIN/−1 pair scoped
  // to a single `kind:'lower'` zone — see this file's Feature 2 header
  // comment above for the full design/owner-quote). Only shown when the
  // machine has at least one visible zone under the current trim
  // (machineZones) — a machine with none has nothing for this control to
  // switch to. Rendered as a segmented control (MODEL/TRAIL STYLE's own
  // recipe, extended to N buttons) while MAIN + the zone count fits
  // LEVEL_SEGMENTED_MAX; a compact ‹ › scroller row otherwise — no shipped
  // machine needs the scroller today (max 2 zones on any one machine = 3
  // options with MAIN), but a future 3+-zone machine degrades to it
  // instead of a squeezed/wrapping N-way segmented row. Each option's own
  // label is simply the zone's name in full (uppercased, matching every
  // other segmented button's styling) — no "−1"/kind prefix, since that
  // implied "one level down" and is no longer true for a raised upper/mini
  // entry.
  const levelWrap = document.createElement('div')
  levelWrap.className = 'map-settings-model'
  const levelLabel = document.createElement('div')
  levelLabel.className = 'map-settings-row-label'
  levelLabel.textContent = 'LEVEL'
  const levelBody = document.createElement('div')
  levelWrap.append(levelLabel, levelBody)

  /** The level ids currently built into levelBody's DOM, joined — compared
   *  against the fresh list on every refreshLevelControl() call so the
   *  control's buttons are torn down and rebuilt ONLY when the machine's
   *  visible-zone roster actually changes shape (a machine swap, or a trim
   *  switch that shows/hides a trim-restricted zone), not on every OTHER
   *  state.onChange this same function also runs on (a ‹ › step, a goal
   *  pick, ...) — those just need the SELECTED state refreshed, not the
   *  buttons torn down and recreated out from under an in-progress tap. */
  let levelShapeKey: string | null = null
  let levelSegmentedBtns: { id: string; el: HTMLButtonElement }[] = []
  let levelScrollerLabelEl: HTMLElement | null = null

  /** Shared apply-and-render for both control shapes' click handlers below. */
  function selectLevel(id: string): void {
    mapLevel = id
    refreshLevelControl()
    render(performance.now())
  }

  /** Refreshes the LEVEL control's visibility/options/selected state from
   *  current state — called on mount, on every state.onChange (trim
   *  changes can hide/show/add/remove zones), and from this control's own
   *  click handlers. Also the single place that resolves `mapLevel` back to
   *  'main' if it ever points at a zone that's no longer valid
   *  (resolveMapLevel — a trim switch hid it, or the machine changed) —
   *  never renders a blank canvas silently. */
  function refreshLevelControl(): void {
    const zones = machineZones(state.data?.playfields, state.trim)
    levelWrap.hidden = zones.length === 0
    mapLevel = resolveMapLevel(mapLevel, zones)

    const levels: { id: string; label: string }[] = [
      { id: 'main', label: 'MAIN' },
      ...zones.map((z) => ({ id: z.id, label: z.name.toUpperCase() })),
    ]
    const shapeKey = levels.map((l) => l.id).join('|')

    if (shapeKey !== levelShapeKey) {
      levelShapeKey = shapeKey
      levelBody.replaceChildren()
      levelSegmentedBtns = []
      levelScrollerLabelEl = null

      if (levels.length <= LEVEL_SEGMENTED_MAX) {
        const track = document.createElement('div')
        track.className = 'map-settings-segmented'
        for (const level of levels) {
          const btn = buildSegmentedBtn(level.label)
          btn.addEventListener('click', () => selectLevel(level.id))
          track.appendChild(btn)
          levelSegmentedBtns.push({ id: level.id, el: btn })
        }
        levelBody.appendChild(track)
      } else {
        // Compact ‹ › scroller — cyclic (no disabled ends), same "browse
        // carousel has no ends" choice Feature 6's skill-shot ‹ › makes
        // (this file's own Feature 6 header) — the owner's own framing was
        // "scrolls thru the levels", which reads as a continuous cycle
        // rather than a bounded list.
        const scroller = document.createElement('div')
        scroller.className = 'map-settings-scroller'
        const prevLevelBtn = document.createElement('button')
        prevLevelBtn.type = 'button'
        prevLevelBtn.className = 'map-settings-scroller-btn'
        prevLevelBtn.textContent = '‹' // ‹
        prevLevelBtn.setAttribute('aria-label', 'Previous level')
        const scrollerLabel = document.createElement('div')
        scrollerLabel.className = 'map-settings-scroller-label'
        const nextLevelBtn = document.createElement('button')
        nextLevelBtn.type = 'button'
        nextLevelBtn.className = 'map-settings-scroller-btn'
        nextLevelBtn.textContent = '›' // ›
        nextLevelBtn.setAttribute('aria-label', 'Next level')
        prevLevelBtn.addEventListener('click', () => {
          const i = Math.max(0, levels.findIndex((l) => l.id === mapLevel))
          selectLevel(levels[(i - 1 + levels.length) % levels.length]!.id)
        })
        nextLevelBtn.addEventListener('click', () => {
          const i = Math.max(0, levels.findIndex((l) => l.id === mapLevel))
          selectLevel(levels[(i + 1) % levels.length]!.id)
        })
        scroller.append(prevLevelBtn, scrollerLabel, nextLevelBtn)
        levelBody.appendChild(scroller)
        levelScrollerLabelEl = scrollerLabel
      }
    }

    if (levels.length <= LEVEL_SEGMENTED_MAX) {
      for (const { id, el } of levelSegmentedBtns) el.classList.toggle('selected', id === mapLevel)
    } else if (levelScrollerLabelEl) {
      const current = levels.find((l) => l.id === mapLevel) ?? levels[0]!
      levelScrollerLabelEl.textContent = current.label
    }
  }
  refreshLevelControl()

  // SHOT LINES — Feature 8 (2026-08-11, phase A15), owner request: "I think
  // an on off button to remove the shot lines can be helpful. Then just the
  // targets are displayed, it gives the user to just see each target shot
  // without being confused with the line." Same on/off pill-toggle recipe
  // as Ball tracer/Path labels below (buildToggleRow), wired straight to
  // the persisted AppState field (state.setShotLines already notifies
  // onChange, which re-renders). Placed ABOVE trail style/ball tracer/line
  // brightness — those three only ever describe HOW a route line looks and
  // become moot once this master switch is off, so it reads top-to-bottom
  // as "does a line draw at all" before "what does it look like".
  const shotLinesRow = buildToggleRow(
    'Shot lines',
    () => state.shotLines,
    (v) => state.setShotLines(v),
  )

  // TRAIL STYLE — segmented DASH/NEON control, wired straight to the
  // persisted AppState field (state.setTrailStyle already notifies
  // onChange, which re-renders — see the state.onChange subscription below).
  const trailStyleWrap = document.createElement('div')
  trailStyleWrap.className = 'map-settings-trailstyle'
  const trailStyleLabel = document.createElement('div')
  trailStyleLabel.className = 'map-settings-row-label'
  trailStyleLabel.textContent = 'TRAIL STYLE'
  const trailStyleTrack = document.createElement('div')
  trailStyleTrack.className = 'map-settings-segmented'
  const trailStyleDashBtn = buildSegmentedBtn('DASH')
  const trailStyleNeonBtn = buildSegmentedBtn('NEON')
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

  const ballTracerRow = buildToggleRow(
    'Ball tracer',
    () => state.ballTracer,
    (v) => state.setBallTracer(v),
  )
  // CELEBRATION — Feature 7 (2026-08-11, phase A14): a 0-5 intensity
  // SLIDER, replacing Feature 3's plain on/off toggle — owner request:
  // "Create a slider that goes from 0 - no celebration to the slider all
  // the way to the right with 7 emojis pop out or spiral way out of the
  // circle". Same row recipe as LINE BRIGHTNESS below (a native
  // <input type=range>, not a segmented control — a 0-5 intensity reads
  // more like a dial than an on/off pair), persisted via
  // state.setCelebrationLevel (same notify-and-rerender wiring every other
  // control in this popover uses; default level 1, state.ts). The row's own
  // label doubles as the "live value" readout, refreshed on every `input`
  // event — "Off" at 0, otherwise the bare level number, so the label
  // always names exactly what the slider is currently set to (no separate
  // value element needed, and nothing else in this popover shows a live
  // numeric readout for LINE BRIGHTNESS to stay consistent with either).
  const celebrationWrap = document.createElement('div')
  celebrationWrap.className = 'map-settings-brightness'
  const celebrationLabel = document.createElement('div')
  celebrationLabel.className = 'map-settings-row-label'
  const celebrationInput = document.createElement('input')
  celebrationInput.type = 'range'
  celebrationInput.min = '0'
  // 0-7 (rolo 2026-08-11): 7/7 = the near-fullscreen burst — the state layer
  // and celebrationParams already accept 7; this ceiling was the last gate.
  celebrationInput.max = '7'
  celebrationInput.step = '1'
  celebrationInput.className = 'map-settings-range'
  function refreshCelebrationRow(): void {
    celebrationLabel.textContent = `Celebration · ${state.celebrationLevel === 0 ? 'Off' : state.celebrationLevel}`
    celebrationInput.value = String(state.celebrationLevel)
  }
  celebrationInput.addEventListener('input', () => {
    state.setCelebrationLevel(parseInt(celebrationInput.value, 10))
    refreshCelebrationRow()
  })
  refreshCelebrationRow()
  celebrationWrap.append(celebrationLabel, celebrationInput)
  // 2026-08-11 (phase A13 — rolo: "if you remove path bubbles from the map
  // setting only remove the bubble; keep the name of the targets popping
  // up"): this toggle now governs ONLY drawing.ts's Pass 4 action-label
  // bubble. The active target's NAME label (Pass 2.5's ring caption) always
  // draws regardless of this setting, same as its ring/badge — see
  // drawGoalOverlay's Pass 2.5/Pass 4 comments in ./drawing. The row is
  // still labeled "Path labels" (unchanged, still an accurate name for what
  // it now solely controls: the labeled bubble on the path).
  const labelsRow = buildToggleRow(
    'Path labels',
    () => settings.showLabels,
    (v) => {
      settings.showLabels = v
      render(performance.now())
    },
  )

  const brightnessWrap = document.createElement('div')
  brightnessWrap.className = 'map-settings-brightness'
  const brightnessLabel = document.createElement('div')
  brightnessLabel.className = 'map-settings-row-label'
  brightnessLabel.textContent = 'Line brightness'
  const brightnessInput = document.createElement('input')
  brightnessInput.type = 'range'
  brightnessInput.min = '0.4'
  brightnessInput.max = '1.8'
  brightnessInput.step = '0.05'
  brightnessInput.value = String(settings.lineBrightness)
  brightnessInput.className = 'map-settings-range'
  brightnessInput.addEventListener('input', () => {
    settings.lineBrightness = parseFloat(brightnessInput.value)
    render(performance.now())
  })
  brightnessWrap.append(brightnessLabel, brightnessInput)

  // Row order (2026-08-11, phase A17 — owner: "Toggles at the top,
  // underneath them the range of dragging"): PURE APPEND REORDERING — every
  // row above still builds exactly where it always did (same variables, same
  // construction code, same refresh*/click-handler wiring); only the order
  // they're appended to settingsPopover changes. Three tiers, top to bottom:
  //   1) plain on/off TOGGLE rows — Shot lines, Path labels, Ball tracer
  //   2) segmented pick-one controls — MODEL, LEVEL, TRAIL STYLE (LEVEL
  //      generalized 2026-08-11 — same day — to hide itself via
  //      refreshLevelControl() when the current machine has no VISIBLE ZONE
  //      of any kind, not just no lower zone; slotted next to MODEL, the
  //      OTHER "which variant of the geometry am I looking at" selector,
  //      rather than after TRAIL STYLE, which is unrelated — how a route
  //      LINE looks, not what geometry is shown)
  //   3) range/slider rows LAST — CELEBRATION, Line brightness ("the range
  //      of dragging" is a bare <input type=range>; only these two rows are)
  // A future new row should slot into whichever tier matches its own control
  // type, not just get appended at the end.
  settingsPopover.append(shotLinesRow, labelsRow, ballTracerRow, modelWrap, levelWrap, trailStyleWrap, celebrationWrap, brightnessWrap)

  let settingsOpen = false
  function closeSettingsPopover(): void {
    settingsOpen = false
    settingsPopover.hidden = true
  }
  function toggleSettingsPopover(): void {
    settingsOpen = !settingsOpen
    settingsPopover.hidden = !settingsOpen
    if (settingsOpen) closeGoalSheet()
  }
  settingsBtn.addEventListener('click', toggleSettingsPopover)
  function onDocPointerDown(ev: PointerEvent): void {
    if (!settingsOpen) return
    const target = ev.target as Node
    if (settingsPopover.contains(target) || settingsBtn.contains(target)) return
    closeSettingsPopover()
  }
  document.addEventListener('pointerdown', onDocPointerDown)

  /** ESCAPE CLOSES IT TOO (2026-08-14 click-through, found in real Chrome).
   *
   *  Until now this popover dismissed on a pointerdown outside itself and on a
   *  second press of the ≡ button — and nothing else. Every other dismissible
   *  surface in this app takes Escape (the how-to overlay, the glossary, this
   *  tab's own goal sheet, all four Study sheets), so a keyboard visitor who
   *  opened the popover pressed Escape, watched nothing happen, and had to
   *  work out that the button they came from was also the way back.
   *
   *  IT CANNOT STEAL THE SHEET'S ESCAPE. The two are mutually exclusive by
   *  construction — openGoalSheet() closes this popover first, and
   *  toggleSettingsPopover() closes the sheet first — and this handler returns
   *  immediately unless the popover is open, so with a sheet up it is inert.
   *  Focus goes back to the ≡ button rather than being left on whatever
   *  control inside the popover had it, which is the same "return focus to the
   *  thing you opened it with" contract ui/sheet.ts already keeps.
   *
   *  IT DOES NOT STOP PROPAGATION, on purpose. There is nothing to stop: the
   *  only other document-level Escape handlers in this app belong to dialogs
   *  that cannot be open at the same time as this popover (the goal sheet, by
   *  the mutual exclusion above; the glossary and how-to, because opening
   *  either takes a pointerdown on a control outside the popover, which
   *  dismisses it first). Swallowing the event would only make it possible for
   *  this non-modal disclosure to eat an Escape meant for a modal above it. */
  function onDocKeyDown(ev: KeyboardEvent): void {
    if (!settingsOpen || ev.key !== 'Escape') return
    closeSettingsPopover()
    settingsBtn.focus?.()
  }
  document.addEventListener('keydown', onDocKeyDown)

  // The "card beside map" wide-viewport column (2026-08-11 - 2026-08-11) —
  // .map-col/.map-card-col wrapper divs, selectGoalFromCard, renderCardColumn
  // — is REMOVED (owner: "Remove all cards. That feature has been removed.").
  // `host` mounts the map's own chrome directly again, single column, exactly
  // as it did before that feature (see this function's own doc comment).
  host.replaceChildren(canvas, goalPillRow, controls, settingsPopover)

  const ctx = must2DContext(canvas)

  let destroyed = false
  let rafId: number | null = null
  // The live marching-highlight/tracer index as of the most recent auto-mode
  // frame — render() keeps this current (from drawGoalOverlay's own return
  // value now, see below); prev/next/readout read it as the "shot the user
  // is currently looking at" base when taking manual control.
  let lastAutoIndex = 0
  // Feature 2 (2026-08-11): the LEVEL selection's own machine-switch reset —
  // "session-local state... resets on machine switch". state.onChange fires
  // on every notify() (goal selection, stepping, trim, machine loads, ...),
  // so this tracks which machine mapLevel currently belongs to and resets
  // it (and the celebration arming state, which is likewise keyed to
  // whatever goal is selected — a fresh machine load always clears
  // selectedGoal too) the instant that id changes.
  let lastMachineId: string | null = state.machine?.id ?? null

  /** prefers-reduced-motion, LIVE (P5, 2026-08-14).
   *
   *  A one-shot `matchMedia(...).matches` read at mount would be wrong in the
   *  direction that matters: iOS puts Reduce Motion in Control Centre, so a
   *  user turns it on precisely BECAUSE something already on screen is moving
   *  too much — and this tab is a long-lived mount (the map is not remounted
   *  on a settings change). Listening keeps it honest, and the listener
   *  re-renders immediately rather than waiting for the next state change,
   *  because with a goal deselected there is no rAF loop running to pick the
   *  change up on its own.
   *
   *  Threaded into drawGoalOverlay's `reducedMotion` opt (see its doc comment
   *  for exactly what freezes) and into drawPlayfieldArt's `tSec` (0 stops the
   *  pop-bumper pulse). The CSS half of reduced motion lives in the
   *  stylesheets' own @media blocks; this is the canvas half, which no media
   *  query can reach.
   *
   *  `addEventListener` on a MediaQueryList is Safari 14+ / every browser this
   *  app supports; the optional-chained fallback is for the test harness's
   *  stub window, which has no matchMedia at all. */
  const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  let reduceMotion = motionQuery?.matches === true
  const onMotionPrefChange = (e: MediaQueryListEvent): void => {
    reduceMotion = e.matches
    render(performance.now())
  }
  motionQuery?.addEventListener?.('change', onMotionPrefChange)

  // ---- Goal sheet (correction 12) ----
  let sheetHandle: SheetHandle | null = null

  function closeGoalSheet(): void {
    sheetHandle?.destroy()
    sheetHandle = null
  }

  /** P4 (2026-08-14): this sheet is now a real dialog — role/aria-modal/
   *  aria-labelledby, Escape-to-dismiss, focus in on open and back to the
   *  goal pill on close — entirely from ui/sheet.ts's shared shell; not one
   *  line of it is duplicated here.
   *
   *  THE ESCAPE KEY AND THE SETTINGS POPOVER DO NOT FIGHT — still true after
   *  the popover grew its OWN Escape handler (onDocKeyDown above, 2026-08-14).
   *  The two controls are mutually exclusive by construction: this function
   *  closes the popover before opening, and toggleSettingsPopover() closes
   *  this sheet before opening. The popover's handler also returns immediately
   *  unless `settingsOpen`, so with a sheet up it is inert and the Escape
   *  reaches the sheet's own handler, which closes the sheet only. */
  function openGoalSheet(): void {
    if (sheetHandle) {
      closeGoalSheet()
      return
    }
    closeSettingsPopover()
    sheetHandle = createSheet(host, {
      title: 'Goals',
      // "N LOADED" counts state.data.goals, and as of P7b that is exactly what
      // the body below renders: buildGoalSheetBody's only remaining filter is
      // filterGoalsByBallPosition, which is the identity function while
      // ballPosition is the fixed 'any' it has been since the BALL AT selector
      // was removed (state.ts's header). Before P7b this number counted goals
      // the sheet then silently dropped — a header that disagreed with the list
      // under it. If a ball-position picker ever comes back, this number has to
      // come from the rendered rows instead of from the dataset.
      meta: `${(state.machine?.shortTitle ?? '').toUpperCase()} · ${state.data?.goals.length ?? 0} LOADED`,
      maxHeightVh: 62,
      onDismiss: closeGoalSheet,
    })
    sheetHandle.setBody(buildGoalSheetBody(state, closeGoalSheet, jumpToGoalDetail, jumpToStudyCharacter))
  }

  goalPill.addEventListener('click', openGoalSheet)
  clearBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    state.clearSelection()
  })

  /** Refreshes the goal pill's dot/label/✕-visibility from current state —
   *  called on mount and on every state.onChange. */
  function updateGoalPill(): void {
    const goal = state.selectedGoal
    if (goal) {
      const meta = CATEGORY_META[goal.category]
      pillDot.style.background = meta.color
      pillLabel.textContent = goal.title
      clearBtn.hidden = false
    } else {
      pillDot.style.removeProperty('background')
      pillLabel.textContent = 'Pick a goal'
      clearBtn.hidden = true
    }
    // P7b: the MODEL chip, from the same derivation the sheet row and the
    // toast use. A pathless goal is never blocked (goalRowOpts' own note) and
    // is excluded here for the same reason, not by coincidence.
    //
    // The aria-label carries it too, in words. This button's label REPLACES
    // its contents for a screen reader, so a chip inside it announces as
    // nothing at all — the disclosure would be sighted-only, and the toast
    // that fires at the moment of the switch would be the only thing an
    // assistive-tech user ever got. Identical to its long-standing 'Choose a
    // goal' whenever there is nothing to disclose.
    const blocked = !!goal && !isPathless(goal) && !goalVisibleForTrim(goal, state.shotsByID, state.trim)
    const blockCopy = blocked && goal ? trimBlockCopy(goal, state.shotsByID, state.trim) : null
    pillChip.hidden = !blockCopy
    pillChip.textContent = blockCopy ? blockCopy.chip : ''
    goalPill.setAttribute(
      'aria-label',
      blockCopy && goal ? `Choose a goal — ${goal.title}: ${blockCopy.reason}` : 'Choose a goal',
    )
    // Keep an open sheet's checkmarks in sync — the selection can also
    // change from the AR tab while this one stays mounted in the background
    // (state is shared across surfaces; tabs are hidden, not unmounted).
    if (sheetHandle) sheetHandle.setBody(buildGoalSheetBody(state, closeGoalSheet, jumpToGoalDetail, jumpToStudyCharacter))
  }

  /** The canvas's accessible NAME, kept in step with the loaded machine —
   *  called on mount and on every state.onChange (a machine switch is just
   *  another notify, and this tab is a long-lived mount that never remounts
   *  for one). Falls back to the unqualified name while a machine is in
   *  flight: "Playfield map" with no machine is vague, "Playfield map of
   *  <the last machine>" is wrong. */
  function refreshCanvasLabel(): void {
    const name = state.machine?.name ?? state.data?.machine ?? null
    canvas.setAttribute('aria-label', name ? `Playfield map of ${name}` : 'Playfield map')
  }

  /** Refreshes the controls bar's visibility, readout text, and disabled
   *  states from current state — called on mount, on every state.onChange,
   *  and from render() whenever the live auto-marching index moves (so the
   *  readout keeps pace with the animation, not just with stepIndex). */
  function updateControls(): void {
    // P9: the spoken mirror of everything below, first so the early returns
    // (no goal / pathless goal) cannot skip it — announceReadout decides for
    // itself when there is nothing to say.
    announceReadout()
    const goal = state.selectedGoal
    // FIXED 2026-07-31 (rolo's screenshot showed "SHOT 1 OF 0"). Excluding
    // pathless goals from THIS tab's picker was not enough: a 'secret' or
    // 'progression' goal can be selected on the Goals tab and the selection
    // carries when the user switches to Map. With steps.length === 0 the
    // stepper rendered "SHOT 1 OF 0" and a ‹ › bar that stepped through
    // nothing. There is no route to walk, so there is no walker.
    controls.hidden = !goal || isPathless(goal)
    if (!goal || isPathless(goal)) return
    const manual = state.highlightMode === 'manual'

    // Feature 6 (2026-08-11): SKILL-SHOT BROWSE MODE, TARGET-ONLY semantics
    // (see this file's own Feature 6 header comment) — a 'skillshot' goal's
    // ‹ › pair always crosses to the adjacent skill shot; there is no
    // "within-goal" walk left at all. Pill reads the plain "SKILL SHOT n OF
    // m · <title>" unconditionally now — the a/b/c sub-lettering a
    // same-day-earlier HYBRID revision briefly added is gone
    // (skillshotReadoutLabel's own doc comment has the history);
    // single-step and multi-step skill shots read identically. ‹ › always
    // enabled (it always has somewhere to go — the adjacent skill shot — a
    // browse carousel has no "ends").
    if (goal.category === 'skillshot') {
      readoutLabel.textContent = skillshotReadoutLabel(skillshotGoals(state.data), goal)
      readoutSub.textContent = manual ? 'PAUSED · TAP FOR AUTO' : 'AUTO · TAP TO PAUSE'
      // No per-step provenance/chips line — only the ACTIVE step's ring ever
      // draws (phase A12 item 4, active-target-only display; TARGET-ONLY
      // browse means that active step is now always the goal's target), so
      // a single line here would be redundant with the pill's own "n OF m"
      // readout.
      //
      // The ONE thing this line does carry (2026-08-15, dataset schema v8) is
      // the dependency chip: browsing a ladder past a rung that isn't on
      // offer yet, with nothing on screen saying so, is the exact confusion
      // Goal.requires exists to end. Only gated skill shots get a line; every
      // other one keeps the empty meta row it has always had.
      const requiresText = requiresChipText(goal, state.data)
      readoutMeta.hidden = !requiresText
      readoutMeta.textContent = requiresText ?? ''
      readout.setAttribute('aria-label', manual ? 'Paused — tap to resume auto-cycle' : 'Tap to pause on the current skill shot')
      prevBtn.setAttribute('aria-label', 'Previous skill shot')
      nextBtn.setAttribute('aria-label', 'Next skill shot')
      prevBtn.disabled = false
      nextBtn.disabled = false
      return
    }
    prevBtn.setAttribute('aria-label', 'Previous shot')
    nextBtn.setAttribute('aria-label', 'Next shot')

    const activeIndex = manual ? state.stepIndex : lastAutoIndex
    const n = activeIndex + 1
    readoutLabel.textContent = `SHOT ${n} OF ${goal.steps.length}`
    readoutSub.textContent = manual ? 'PAUSED · TAP FOR AUTO' : 'AUTO · TAP TO PAUSE'

    // Choreography provenance + technique chips, composed into ONE line —
    // the map pill has no room for the Goals tab's separate provenance line
    // plus a bordered chip row (app.ts's renderGoalDetail), so chips render
    // here as plain '·'-joined text after the provenance text, same size,
    // no border/tap-target (the map pill stays passive — see this repo's
    // phase report for why: ui/glossary.ts has no anchor/term parameter, so
    // there's nothing for a map-pill chip tap to jump to that a Goals-tab
    // chip tap doesn't already do better).
    const activeStep = goal.steps[activeIndex]
    const provenanceText = stepProvenance(goal, activeIndex, state.shotsByID, state.trim)
    const chipLabels = activeStep ? stepChips(activeStep).map((c) => c.label) : []
    const metaText = [provenanceText, ...chipLabels].filter((s): s is string => !!s).join(' · ')
    readoutMeta.hidden = metaText.length === 0
    readoutMeta.textContent = metaText

    readout.setAttribute(
      'aria-label',
      manual ? 'Paused — tap to resume auto-cycle' : 'Tap to pause on the current shot',
    )
    prevBtn.disabled = manual && state.stepIndex === 0
    nextBtn.disabled = manual && state.stepIndex >= goal.steps.length - 1
  }

  // ---- THE SPOKEN READOUT (P9, 2026-08-14) ------------------------------
  //
  // The ‹ SHOT 3 OF 5 › pill is this tab's entire running commentary, and it
  // is a passive <div>: it changes as you step, and nothing tells a screen
  // reader to look at it again. So every move is mirrored, in sentence case,
  // into a polite live region.
  //
  // APP.TS OWNS THAT REGION and hands this function the one line that writes
  // it (`speakReadout`, trailing-optional exactly like `jumpToGoalDetail`).
  // Two structural reasons, not taste: `host` here is replaceChildren()-ed at
  // mount and emptied again at destroy(), so a region built in this file
  // would be destroyed and rebuilt by its own owner — and a live region has
  // to be in the document BEFORE its text changes to be announced at all.
  // app.ts's copy sits outside the tab panels for the life of the app.
  // (tests/goal-bridge.test.mjs pins the set of files allowed to own one.)

  /** What the readout would SAY, or null when there is nothing to say (no
   *  goal, or a pathless one — the controls bar is hidden for both).
   *
   *  Sentence case, not the pill's shouted 'SHOT 4 OF 6': this string is never
   *  rendered, it is spoken, and screen readers spell out or shout all-caps
   *  runs depending on the voice. Same reasoning, same format, as ui/study.ts's
   *  own P8 announcement.
   *
   *  AUTO MODE IS ONE SENTENCE, NOT A COMMENTARY — the guard that keeps this
   *  from being unusable. Auto marches the highlight on its own every
   *  HIGHLIGHT_HOLD_S and calls updateControls each time it moves; narrating
   *  that is a voice interrupting itself every 2.5 seconds forever, which is
   *  worse than silence. The goal TITLE rides along on the route case because
   *  a normal goal's auto-cycle never changes goals by itself, so the line
   *  changes exactly when the SELECTION changes and the repeat guard in
   *  announceReadout collapses the rest. A skill shot's carousel does roll
   *  goal-to-goal on its own (Feature 6), so its auto line deliberately
   *  carries no title — it would be the same 2.5s spam by another route. */
  function spokenReadout(): string | null {
    const goal = state.selectedGoal
    if (!goal || isPathless(goal)) return null
    const skillshot = goal.category === 'skillshot'
    if (state.highlightMode !== 'manual') {
      return skillshot ? 'Auto-cycling the skill shots' : `Auto-cycling the route — ${goal.title}`
    }
    if (skillshot) {
      const { n, m } = skillshotPosition(skillshotGoals(state.data), goal)
      // The dependency chip's spoken mirror (schema v8) — see
      // requiresSpokenText's own doc comment for why this is not just the
      // pill's all-caps string read aloud.
      const gate = requiresSpokenText(goal, state.data)
      const line = `Skill shot ${n} of ${m} — ${goal.title}`
      return gate ? `${line}. ${gate}` : line
    }
    const step = goal.steps[state.stepIndex]
    const shot = step ? state.shotsByID.get(step.shot) : undefined
    const position = `Shot ${state.stepIndex + 1} of ${goal.steps.length}`
    // A step whose shot id is not in the dataset still has a position worth
    // saying; the name is the part that would be a lie.
    return shot ? `${position} — ${shot.name}` : position
  }

  /** The last line handed to `speakReadout` — the repeat guard. */
  let spokenLast: string | null = null
  let announceTimer: number | null = null
  let pendingAnnounce: string | null = null

  /** Speaks the current position, LEADING-EDGE THEN COALESCED.
   *
   *  A single move announces IMMEDIATELY — a deliberate ‹ › press must not
   *  feel like it is waiting for anything. A BURST (a held ›, an autorepeating
   *  key) collapses: every line inside READOUT_ANNOUNCE_WINDOW_MS after the
   *  first is folded into one trailing write carrying the LAST position, so a
   *  screen reader reads "shot 3" then "shot 11", not all nine in between.
   *  Politeness alone would not do this — a polite region still queues every
   *  distinct value it is given.
   *
   *  This is ui/study.ts's P8 announcer, copied rather than shared: study.ts
   *  imports FROM this file, so a shared module would have to be a third one
   *  and BOTH call sites would have to move to it. That is a change to
   *  ui/study.ts, which this pass does not touch. Noted here rather than left
   *  for a reader to find — the two are the same 20 lines and the same 250ms.
   *
   *  Nothing to say resets the guard: re-selecting the goal you just cleared
   *  produces identical text, and must announce again. */
  function announceReadout(): void {
    if (!speakReadout) return
    const text = spokenReadout()
    if (text === null) {
      spokenLast = null
      return
    }
    if (text === spokenLast) return
    spokenLast = text
    if (announceTimer === null) {
      speakReadout(text)
      pendingAnnounce = null
      announceTimer = window.setTimeout(flushAnnounce, READOUT_ANNOUNCE_WINDOW_MS)
      return
    }
    // Inside the window: remember only the newest. No second timer — the
    // window is a fixed slice from the FIRST write, not a debounce a long
    // enough burst could postpone for ever.
    pendingAnnounce = text
  }

  /** End of a coalescing window. Speaks the last position, then opens ONE
   *  more window — the re-arm is what holds a sustained burst to one
   *  announcement per window instead of alternating leading/trailing writes.
   *  A flush with nothing pending does NOT re-arm, so the chain always
   *  terminates on its own; destroy() cancels it either way, which is what
   *  keeps it from firing into a region whose map is gone. */
  function flushAnnounce(): void {
    announceTimer = null
    if (pendingAnnounce === null) return
    speakReadout?.(pendingAnnounce)
    pendingAnnounce = null
    announceTimer = window.setTimeout(flushAnnounce, READOUT_ANNOUNCE_WINDOW_MS)
  }

  function cancelAnnounce(): void {
    if (announceTimer !== null) window.clearTimeout(announceTimer)
    announceTimer = null
    pendingAnnounce = null
  }

  /** Applies a skillshotBrowseStep() result — TARGET-ONLY revision
   *  (2026-08-11): skillshotBrowseStep no longer has a "same goal" case at
   *  all (every press crosses to the adjacent skill shot — see this file's
   *  own Feature 6 header), so this is now just selectSkillshotAtTarget's
   *  own state.select() + state.goToStep(lastIndex) pairing, applied to
   *  whichever goal skillshotBrowseStep resolved to. Kept as its own named
   *  step (rather than inlined at both ‹ › call sites below) purely for
   *  the shared null check — skillshotBrowseStep only returns null when
   *  skillshotGoals(state.data) is itself empty (adjacentSkillshotGoal's
   *  own documented degenerate case, nothing to browse at all). */
  function applySkillshotBrowseStep(step: { goal: Goal; stepIndex: number } | null): void {
    if (step) selectSkillshotAtTarget(state, step.goal)
  }

  prevBtn.addEventListener('click', () => {
    const goal = state.selectedGoal
    if (!goal) return
    if (goal.category === 'skillshot') {
      const base = state.highlightMode === 'manual' ? state.stepIndex : lastAutoIndex
      applySkillshotBrowseStep(skillshotBrowseStep(skillshotGoals(state.data), goal, base, -1))
      state.pauseHighlight()
      return
    }
    const base = state.highlightMode === 'manual' ? state.stepIndex : lastAutoIndex
    state.goToStep(base - 1)
    state.pauseHighlight()
  })
  nextBtn.addEventListener('click', () => {
    const goal = state.selectedGoal
    if (!goal) return
    if (goal.category === 'skillshot') {
      const base = state.highlightMode === 'manual' ? state.stepIndex : lastAutoIndex
      applySkillshotBrowseStep(skillshotBrowseStep(skillshotGoals(state.data), goal, base, 1))
      state.pauseHighlight()
      return
    }
    const base = state.highlightMode === 'manual' ? state.stepIndex : lastAutoIndex
    state.goToStep(base + 1)
    state.pauseHighlight()
  })
  readout.addEventListener('click', () => {
    // TARGET-ONLY skill-shot browse needs no special case here either: a
    // skillshot goal's state.stepIndex is always its target the instant
    // it's selected (this file's own Feature 6 header), so snapshotting
    // lastAutoIndex before pausing is exactly as correct for it as it
    // already is for everything else — the active ring stays on whichever
    // step was showing at the moment of the tap instead of silently
    // jumping.
    const goal = state.selectedGoal
    if (!goal) return
    if (state.highlightMode === 'manual') {
      state.resumeHighlight()
    } else {
      state.goToStep(lastAutoIndex)
      state.pauseHighlight()
    }
  })

  // ---- Tap-to-identify (t12c) — hit-tested against the most recent
  // render's shot points, in the same CSS-px space pointer events report
  // (map2d draws in CSS px; devicePixelRatio scaling is only ctx's
  // transform, set once in resize() below). ----
  let lastShotPoints: { shot: Shot; point: { x: number; y: number } }[] = []
  let callout: { shot: Shot; point: { x: number; y: number }; expiresAt: number } | null = null
  let calloutTimer: number | null = null

  /** Feature 3 (2026-08-11) celebration arming — advances `celebrationArming`
   *  via the PURE nextCelebrationArmingState (above mountMap2D) once per
   *  render() call, REGARDLESS of which level (Feature 2) is currently
   *  showing: the ‹ › controls drive state.stepIndex/highlightMode either
   *  way, so keeping this in sync every frame is what makes "leave and
   *  return" re-arming correct even if the user happened to be looking at
   *  a zone's LEVEL view in between (drawZoneGoalRoute has no live "active
   *  step" concept at all — see this file's Feature 2 header — so the LEVEL
   *  view never READS this, but keeping it advancing regardless is what
   *  keeps it correct for whenever the user switches back to MAIN). `relMs` is
   *  the SAME clock drawGoalOverlay's `time` opt gets for the MAIN level
   *  (nowMs - state.routeStartedAt), so a captured `manualStartedAt` lines
   *  up exactly with `o.time - manualStartedAt` inside drawGoalOverlay's
   *  own Pass 5. */
  function updateCelebrationArming(goal: Goal | null, relMs: number): void {
    // TARGET-ONLY skill-shot browse (2026-08-11 revision — this file's own
    // Feature 6 header): skillshotEffectiveHighlightMode maps a
    // 'skillshot' goal's highlightMode to 'manual' regardless of the REAL
    // state.highlightMode, because a skill shot's state.stepIndex is now
    // ALWAYS its target the instant it's selected — every entry point
    // (selectSkillshotAtTarget) and ‹ › (skillshotBrowseStep) guarantee it.
    // That makes nextCelebrationArmingState's existing MANUAL-mode
    // edge-triggered rule ("arm once per arrival at the last step, no
    // repeat while sitting, re-arm on leaving/returning or switching
    // goals") produce exactly "one burst per skill shot" with NO changes
    // to that state machine itself — every other category still passes
    // its REAL state.highlightMode straight through, unaffected.
    celebrationArming = nextCelebrationArmingState(celebrationArming, {
      // Feature 7 (2026-08-11, phase A14): state.celebration (boolean) is
      // now state.celebrationLevel (0-5) — "on" is simply "above zero". The
      // arming state machine itself is level-agnostic (it only ever needs
      // to know on/off), so no other change was needed here.
      celebrationOn: state.celebrationLevel > 0,
      goal,
      highlightMode: skillshotEffectiveHighlightMode(goal?.category, state.highlightMode),
      stepIndex: state.stepIndex,
      relMs,
    })
  }

  /** TARGET-ONLY skill-shot browse (2026-08-11 revision, this file's own
   *  Feature 6 header) auto-cycle: while auto-marching a 'skillshot' goal,
   *  roll to the NEXT skillshot goal every FLAT HIGHLIGHT_HOLD_S
   *  (shouldAdvanceSkillshotBrowse) — no more "one full lap through this
   *  goal's own steps" multiplier (the same-day-earlier HYBRID revision
   *  this supersedes), because there is no within-goal lap left to run: a
   *  skill shot is shown parked on its target for the WHOLE dwell (the
   *  render call pins `highlightIndex` there via
   *  skillshotEffectiveHighlightMode, so drawGoalOverlay's own
   *  autoHighlightIndex march never runs for one). This function only ever
   *  decides WHEN to cross a goal boundary, landing on the next goal's own
   *  target via selectSkillshotAtTarget. Reuses state.routeStartedAt as
   *  the elapsed-time anchor (state.select() resets it, which is what
   *  restarts the newly-shown goal's own HIGHLIGHT_HOLD_S hold) rather
   *  than a second closure timer — the same "one clock, read everywhere"
   *  convention drawing.ts's own header comments document. Called once per
   *  render() frame, BEFORE `goal` is read there, so a switch here is
   *  reflected in THAT SAME frame's draw rather than one frame late. */
  function advanceSkillshotBrowseIfDue(nowMs: number): void {
    const goal = state.selectedGoal
    const elapsedS = (nowMs - state.routeStartedAt) / 1000
    if (!shouldAdvanceSkillshotBrowse(goal, state.highlightMode, elapsedS)) return
    const next = adjacentSkillshotGoal(skillshotGoals(state.data), goal!.id, 1)
    if (next && next.id !== goal!.id) selectSkillshotAtTarget(state, next)
  }

  function render(nowMs: number): void {
    if (destroyed) return
    // Feature 6's auto-cycle, checked FIRST — a switch here must be
    // reflected in THIS frame's read of state.selectedGoal below, not one
    // frame late.
    advanceSkillshotBrowseIfDue(nowMs)
    // Fallback reads host (the canvas's own containing block) for whichever
    // dimension the canvas itself hasn't been laid out with yet.
    const width = canvas.clientWidth || host.clientWidth
    const height = canvas.clientHeight || host.clientHeight
    if (width <= 0 || height <= 0) return

    ctx.clearRect(0, 0, width, height)
    // Playfield2DView.kt: Canvas modifier.background(Color(0xFF050D1F)).
    ctx.fillStyle = CANVAS_LETTERBOX
    ctx.fillRect(0, 0, width, height)

    const goal = state.selectedGoal
    updateCelebrationArming(goal, goal ? nowMs - state.routeStartedAt : 0)
    // TOP_PAD is reserved unconditionally (the goal pill is always visible);
    // CONTROLS_CLEARANCE only while a goal is selected (the ‹ › bar only
    // shows then) — correction 12's layout rule, ported from
    // design_handoff_shot_coach/pg-render.js's `topPad`/`rect.y +=` handling.
    const availableHeight = (goal ? height - CONTROLS_CLEARANCE : height) - TOP_PAD

    // Feature 2 (2026-08-11, generalized the same day): resolve the active
    // LEVEL zone, if any (any kind — see machineZones()). Falls back to
    // 'main' whenever mapLevel points at something no longer valid
    // (refreshLevelControl's own resolveMapLevel() guard, called on every
    // state.onChange) — the `?? null` here is defensive, not load-bearing.
    const activeZone: PlayfieldZone | null =
      mapLevel === 'main' ? null : (machineZones(state.data?.playfields, state.trim).find((z) => z.id === mapLevel) ?? null)

    if (activeZone) {
      renderZoneLevel(activeZone, goal, width, height, availableHeight)
    } else {
      renderMainLevel(goal, nowMs, width, height, availableHeight)
    }

    if (callout) {
      if (nowMs >= callout.expiresAt) {
        callout = null
      } else {
        drawIdentifyCallout(ctx, callout.shot, callout.point, { width, height }, rectXBounds(playfieldRect(width, availableHeight)))
      }
    }
  }

  /** The pre-Feature-2 MAIN-level render path, unchanged apart from
   *  threading Feature 3's `celebrate` opt into drawGoalOverlay — factored
   *  out of render() so it and renderZoneLevel below are two clearly
   *  separate, independently readable paths instead of one function with a
   *  branch buried in its middle. */
  function renderMainLevel(goal: Goal | null, nowMs: number, width: number, height: number, availableHeight: number): void {
    const rect = playfieldRect(width, availableHeight)
    rect.y += TOP_PAD / 2

    // Static rect MapFn: u -> x left->right, v -> y INVERTED (v=0 flippers
    // at the BOTTOM), per CONTRACTS.md.
    const map: MapFn = (u, v) => ({ x: rect.x + u * rect.w, y: rect.y + rect.h - v * rect.h })

    // Shots are read BEFORE the background now: the playfield art is derived
    // per-machine from them (see drawPlayfieldArt's header for the incident).
    // A3 (2026-08-10): filtered through the current MODEL selector before
    // anything downstream sees them — visibleShotsForTrim's own doc comment
    // has THE INVARIANT (the selected goal's own shots are never subtracted).
    // state.shotsByID stays unfiltered; only drawGoalOverlay's own
    // `shotsByID` opt below keeps reading it, so route resolution never has
    // a hole punched in it.
    const allShots = state.data?.shots ?? []
    const shots = visibleShotsForTrim(allShots, state.trim, goal)
    // Same per-model filtering rule as shots (isZoneVisible mirrors
    // isShotVisible exactly — see its own doc comment) — a premium-le-only
    // zone (and, per drawPlayfieldArt's extras-loop comment, its own deck
    // bat) vanishes under Pro. No "goal needs it" exception here: unlike a
    // shot, a zone plate is background art a selected goal's route never
    // depends on for correctness.
    const playfields = (state.data?.playfields ?? []).filter((z) => isZoneVisible(z, state.trim))
    // tSec 0 under reduced motion freezes drawPlayfieldArt's pop-bumper
    // pulse (the one animated thing in the background art) — the bumpers are
    // still drawn, they just stop breathing.
    const artSec = reduceMotion ? 0 : nowMs / 1000
    drawMapCardBackground(ctx, rect, map, artSec, goal ? CATEGORY_COLOR[goal.category] : null, shots, playfields, TOP_PAD)
    lastShotPoints = shots.map((shot) => ({ shot, point: map(shot.x, shot.y) }))

    const routeShotIDs = goal ? new Set(goal.steps.map((s) => s.shot)) : undefined
    drawShotDots(ctx, shots, map, { routeShotIDs, topInset: TOP_PAD })

    if (goal) {
      // Shot Coach (correction 9): the tracer/marching-highlight clock is
      // anchored to state.routeStartedAt (reset on select/restart/resume/
      // machine load — state.ts) so a freshly picked goal's tracer always
      // starts at leg 1 instead of landing mid-cycle.
      const relMs = nowMs - state.routeStartedAt
      // Feature 3 (2026-08-11): resolved once per render() — glyphFor never
      // fails (it has its own 'sparkle' fallback), and `null` when the
      // pref is off skips the whole celebration subsystem inside
      // drawGoalOverlay (its own Pass 5 gate). Feature 7 (2026-08-11, phase
      // A14): "off" is now level 0 rather than a boolean false, and the
      // resolved level is threaded through so Pass 5 knows how big/long to
      // make the burst.
      const celebrate =
        state.celebrationLevel > 0
          ? { glyph: glyphFor(goal.fx ?? state.data?.defaultFx), level: state.celebrationLevel, manualStartedAt: celebrationArming.manualStartedAt }
          : null
      const result = drawGoalOverlay(ctx, {
        shotsByID: state.shotsByID,
        goal,
        stepIndex: state.stepIndex,
        ballPosition: state.ballPosition,
        map,
        time: relMs,
        // TARGET-ONLY skill-shot browse (2026-08-11 revision, this file's
        // own Feature 6 header): skillshotEffectiveHighlightMode pins a
        // 'skillshot' goal to state.stepIndex (its target — every entry
        // point/‹ › guarantees this) exactly like real MANUAL mode already
        // pins any other goal. Without this, drawGoalOverlay's own
        // AUTO-mode fallback (autoHighlightIndex) would march across the
        // goal's OTHER steps instead of holding on the target for the
        // whole HIGHLIGHT_HOLD_S auto-cycle dwell.
        highlightIndex: skillshotEffectiveHighlightMode(goal.category, state.highlightMode) === 'manual' ? state.stepIndex : undefined,
        trailStyle: state.trailStyle,
        ballTracer: state.ballTracer,
        // P5 (2026-08-14): freezes the dash/sheen/pulse and swaps the flying
        // tracer for the stepped highlight — WITHOUT stopping the
        // auto-advance. See drawing.ts's OverlayOpts.reducedMotion.
        reducedMotion: reduceMotion,
        // Feature 8 (2026-08-11, phase A15) — the "Shot lines" master
        // toggle; see drawing.ts's own OverlayOpts.shotLines doc comment.
        shotLines: state.shotLines,
        showLabels: settings.showLabels,
        lineBrightness: settings.lineBrightness,
        // Derived, NOT a literal. This read `topInset: 46` while TOP_PAD was
        // 44 — two numbers meant to describe the same reserved band, already
        // drifted apart, and neither one large enough to clear the goal pill
        // row that ends at 56px. Bubbles clamped to 46 were drawn beneath the
        // pill. Keep this expression so the band can only ever be changed in
        // one place.
        topInset: TOP_PAD,
        // Per-trim feed resolution (A3) — the selected-goal overlay itself
        // still reads the FULL state.shotsByID above; this only affects how
        // shotgeom.ts's feedForTrim resolves a ramp/orbit/loop continuation.
        trim: state.trim,
        celebrate,
      })
      if (state.highlightMode === 'auto' && result.highlightIndex !== lastAutoIndex) {
        lastAutoIndex = result.highlightIndex
        updateControls()
      }
    } else {
      // The controls bar (above) occupies this bottom-center zone once a
      // goal is selected — the caption only makes sense pre-selection.
      ctx.setLineDash([])
      ctx.font = `600 9px ${DISPLAY_STACK}`
      ctx.fillStyle = 'rgba(255, 255, 255, 0.32)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText('TAP ANY DOT TO IDENTIFY', width / 2, height - 10)
    }
  }

  /** Feature 2 (2026-08-11) LEVEL-view render path — works identically for
   *  any `zone.kind` (upper/mini/lower — see this file's own Feature 2
   *  header comment for the full design/generalization). `rect`'s aspect is
   *  the ZONE's own bounds aspect ("own scale, keep aspect of bounds"), not
   *  the whole-table PLAYFIELD_ASPECT. `lastShotPoints` is populated with
   *  the ZONE-mapped member shots so the existing tap-to-identify hit-test
   *  (onCanvasClick below) keeps working unchanged in this view. */
  function renderZoneLevel(zone: PlayfieldZone, goal: Goal | null, width: number, height: number, availableHeight: number): void {
    const zoneAspect = zone.bounds.h > 0 ? zone.bounds.w / zone.bounds.h : PLAYFIELD_ASPECT
    const rect = playfieldRect(width, availableHeight, zoneAspect)
    rect.y += TOP_PAD / 2

    const map = zoneLocalMap(zone, rect)
    const shotsById = state.shotsByID
    const memberShots = zoneMemberShots(state.data?.shots, zone.id, state.trim)
    lastShotPoints = memberShots.map((shot) => ({ shot, point: map(shot.x, shot.y) }))
    const routeShotIDs = goal
      ? new Set(goal.steps.filter((s) => shotsById.get(s.shot)?.playfield === zone.id).map((s) => s.shot))
      : undefined

    // FLOOR + BATS + EDGE MARKERS, then the dots on top — the same order and
    // the same code the Study tab's own zone view draws, because it is
    // literally the same function now (drawZoneArt).
    drawZoneArt(ctx, rect, map, zone, shotsById, state.trim)
    drawShotDots(ctx, memberShots, map, { routeShotIDs, labelBounds: rectXBounds(rect) })

    if (goal && goal.steps.some((s) => shotsById.get(s.shot)?.playfield === zone.id)) {
      const zonesById = new Map((state.data?.playfields ?? []).map((z) => [z.id, z]))
      drawZoneGoalRoute(ctx, map, zone, zonesById, goal, shotsById, state.trim, CATEGORY_COLOR[goal.category])
    } else if (!goal) {
      ctx.setLineDash([])
      ctx.font = `600 9px ${DISPLAY_STACK}`
      ctx.fillStyle = 'rgba(255, 255, 255, 0.32)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText('TAP ANY DOT TO IDENTIFY', width / 2, height - 10)
    }
  }

  function onCanvasClick(ev: MouseEvent): void {
    if (destroyed) return
    const rect = canvas.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    let hit: { shot: Shot; point: { x: number; y: number } } | null = null
    let bestDist = HIT_RADIUS
    for (const entry of lastShotPoints) {
      // SHAPE-AWARE (K3 fast-follow #1) — distance to the insert the user can
      // actually see, not to a point that a ring draws nothing at. Zero
      // inside the shape, so a tap that lands ON something always beats a
      // neighbour whose centre is marginally closer. HIT_RADIUS is now a
      // halo AROUND the drawn shape rather than a circle centred on the
      // point, which also makes the small shapes (blade, chevron) easier to
      // hit than they were as bare dots. See insertHitDistance.
      const shape = INSERT_SHAPE[(entry.shot.type || '').toLowerCase()] ?? 'dot'
      const d = insertHitDistance(shape, entry.point, INSERT_DRAW_RADIUS, x, y)
      if (d <= bestDist) {
        bestDist = d
        hit = entry
      }
    }
    if (!hit) return
    if (calloutTimer !== null) window.clearTimeout(calloutTimer)
    callout = { shot: hit.shot, point: hit.point, expiresAt: performance.now() + CALLOUT_MS }
    render(performance.now())
    calloutTimer = window.setTimeout(() => {
      calloutTimer = null
      callout = null
      render(performance.now())
    }, CALLOUT_MS)
  }
  canvas.addEventListener('click', onCanvasClick)

  function frame(nowMs: number): void {
    if (destroyed) return
    render(nowMs)
    rafId = state.selectedGoal ? requestAnimationFrame(frame) : null
  }

  /** Starts the rAF loop iff a goal is selected (animation is needed);
   *  otherwise stops it and repaints one static frame. */
  function ensureLoop(): void {
    if (destroyed) return
    if (state.selectedGoal) {
      if (rafId === null) rafId = requestAnimationFrame(frame)
    } else {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      render(performance.now())
    }
  }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1
    const width = host.clientWidth
    const height = host.clientHeight
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    render(performance.now())
  }

  // Observes host directly so a resize is caught whenever the map's own
  // drawable area changes for any reason.
  const resizeObserver = new ResizeObserver(() => resize())
  resizeObserver.observe(host)

  /** Feature 2's machine-switch reset, checked once per state.onChange fire
   *  (cheaper than every rAF frame — notify() already fires on machine
   *  load). Resets mapLevel to 'main' and clears the celebration arming
   *  state (a fresh machine load also clears selectedGoal, so the
   *  arming-by-goal-id check in updateCelebrationArming would reset it too,
   *  but this is the more direct, explicit fix and doesn't depend on that
   *  ordering). */
  function syncMachineLocalState(): void {
    const currentId = state.machine?.id ?? null
    if (currentId === lastMachineId) return
    lastMachineId = currentId
    mapLevel = 'main'
    celebrationArming = initialCelebrationArmingState()
  }

  /** The MODEL the pill's chip was last reconciled against, so a trim CHANGE
   *  can be told from every other state.onChange fire. */
  let lastTrim = state.trim

  /**
   * P7b (2026-08-14): say it OUT LOUD when a MODEL switch strands the goal
   * that is currently selected.
   *
   * WHY THIS DOES NOT CLEAR THE SELECTION, which was the other candidate.
   * Three reasons, in order of weight:
   *
   *   1. The route is not broken, so there is nothing to rescue the visitor
   *      from. visibleShotsForTrim's INVARIANT (see its doc comment) already
   *      re-adds the selected goal's own shots under any MODEL, and
   *      drawGoalOverlay reads the full, unfiltered state.shotsByID — the
   *      route draws COMPLETE, exactly as the person who selected it asked
   *      for. Clearing would delete a working screen.
   *   2. It would be a one-way door. The goal sheet on this tab now disables
   *      that same goal (goalRowOpts), so a cleared selection could not be
   *      re-picked from the Map at all — the visitor would have to work out
   *      that the Goals tab still has it. Toggling MODEL to compare a Pro
   *      route against a Premium/LE one is the exact thing this control is
   *      for, and it would break after the first toggle.
   *   3. It is the same instinct this whole pass is undoing. "The app knows
   *      something you might not like, so the app removes it" is what the two
   *      silent filters did. Disclosure is the fix: the toast says it happened,
   *      and pillChip keeps saying it after the toast is gone (2.4s is an
   *      announcement, not a state).
   *
   * Fires only on an actual trim change, and only for a goal the change
   * actually strands — switching BACK says nothing, because nothing is wrong.
   */
  function announceTrimChange(): void {
    if (state.trim === lastTrim) return
    lastTrim = state.trim
    const goal = state.selectedGoal
    if (!goal || isPathless(goal)) return
    if (goalVisibleForTrim(goal, state.shotsByID, state.trim)) return
    // ONLY WHILE THIS TAB IS ON SCREEN (2026-08-14). MODEL is now switchable
    // from the Study rail as well as from this popover, and ui/toast.ts is a
    // singleton on document.body — so without this guard, flipping MODEL in
    // Study would drop a pill about the SHOTS tab's selected goal over a tab
    // that shows no goal at all. `lastTrim` is updated ABOVE the guard on
    // purpose: the change has still been observed, so coming back to this tab
    // later must not fire a toast about a switch made minutes ago. Nothing
    // durable is lost either way — the goal pill's own chip carries the same
    // fact as STATE, and it is repainted by updateGoalPill in this same
    // notify, so it is already correct when the visitor arrives.
    if (!isRendered(host)) return
    showToast(`${goal.title} — ${trimBlockCopy(goal, state.shotsByID, state.trim).needs}`, '!')
  }

  const unsubscribe = state.onChange(() => {
    syncMachineLocalState()
    announceTrimChange()
    ensureLoop()
    updateControls()
    updateGoalPill()
    refreshModelControl()
    refreshLevelControl()
    refreshCanvasLabel()
  })

  updateControls()
  updateGoalPill()
  refreshModelControl()
  refreshLevelControl()
  refreshCanvasLabel()
  resize()
  ensureLoop()

  return {
    destroy(): void {
      destroyed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (calloutTimer !== null) window.clearTimeout(calloutTimer)
      // A pending announcement outlives its map otherwise: the trailing write
      // would land in app.ts's region (which survives this teardown by
      // design) and speak a shot on a tab that is no longer mounted.
      cancelAnnounce()
      motionQuery?.removeEventListener?.('change', onMotionPrefChange)
      canvas.removeEventListener('click', onCanvasClick)
      resizeObserver.disconnect()
      unsubscribe()
      closeGoalSheet()
      document.removeEventListener('pointerdown', onDocPointerDown)
      // Both document-level dismissals come off together — a keydown listener
      // left behind by a destroyed map would swallow Escape for whatever
      // mounts next.
      document.removeEventListener('keydown', onDocKeyDown)
      host.replaceChildren()
    },
  }
}
