// app/src/overlay/shotgeom.ts — pure shot/route geometry, extracted
// 2026-08-10 (phase A1 of the map-art/route geometry-unification work).
//
// CONTRACT: this module is PURE — no DOM, no canvas, no CSS imports, and no
// imports from ./drawing.ts or ./map2d.ts (only from ../models). That is not
// a style preference, it is the whole point of the file: ./drawing.ts (the
// goal-route renderer) and ./map2d.ts (the map's background playfield art)
// each draw a DIFFERENT picture of the same machine, and before this file
// existed they each carried their OWN copy of the geometry that decides
// "which flipper shoots this shot" / "where does an unauthored ramp crest
// sit" — two copies that could (and did — see approachLine's own doc
// comment) silently disagree. Every caller in both files now imports its
// shot-geometry primitives from HERE instead, so there is exactly one place
// that answer can live, and both surfaces read the same one. If a function
// in this file ever needs a `CanvasRenderingContext2D`, a `MapFn`, or any
// other DOM/canvas state, it does not belong in this file — keeping it DOM-
// free is also load-bearing for tests/playfield-art.test.mjs, which esbuild-
// bundles this module directly (`platform: neutral`) alongside map2d.ts.
//
// WHAT LIVES HERE: the flipper/lane constants (FLIPPER_ANCHORS, FLIPPER_SNAP,
// DEFAULT_LAUNCH_UV, the shooter-lane band), chooseFlipper (rule 6's
// shooting-flipper resolution) and resolveFeedUV (rule 7's feed-point
// resolution) — both moved here verbatim from ./drawing.ts, which now
// imports and re-exports them — plus synthesizeApex (rule 7's ramp-
// continuation crest formula, extracted out of ./drawing.ts's
// rampExtensionLegs so it has exactly one implementation) and four new
// functions: approachLine (./map2d.ts's lane-line geometry, now routed
// through chooseFlipper instead of a naive same-side guess — the reason this
// module exists), resolveShootingAnchor (a forward-looking wrapper over
// chooseFlipper for a later deck/PlayfieldZone routing phase), and
// isShotVisible/feedForTrim (per-trim visibility and feed resolution,
// dataset schema v5 — not wired into either renderer yet as of this phase;
// there is no trim selector in state.ts to drive them from. See each
// function's own doc comment for specifics).
//
// 2026-08-10 (phase A4, deck/PlayfieldZone routing): resolveShootingAnchor is
// no longer a thin wrapper — it is now deck-aware. When targetShot.playfield
// names a PlayfieldZone (models.ts) that itself has one or more
// `type:'flipper'` shots on it (batsForZone), the returned anchor is that
// deck bat's own (x, y) — `deck: true` — instead of FLIPPER_ANCHORS[side]. A
// zone with no bat, an unresolvable `playfield`, or no `zones` argument at
// all (the pre-A4 call shape) all fall through to EXACTLY the old
// main-flipper behavior — fail-soft, so every caller that doesn't thread
// `zones` is byte-identical to before this phase. New exports zoneOf/
// batsForZone/isZoneVisible support this and ./drawing.ts's/./map2d.ts's own
// deck wiring; see each function's own doc comment.

import type { FeedRef, PlayfieldZone, Shot } from '../models'
import { BALL_ANCHORS } from '../models'

export type Pt = { x: number; y: number }

/** models.ts's BALL_ANCHORS uses {u, v}; this file's routing math uses
 *  {x, y}. Duplicated from ./drawing.ts rather than shared — this module
 *  must not import from drawing.ts, and drawing.ts keeps its own copy for
 *  the one call site that didn't move here (`anchorToPt(BALL_ANCHORS[o.ballPosition])`
 *  inside drawGoalOverlay). Same "trivial helper, cheaper to duplicate than
 *  to widen an export surface for" rule map2d.ts's own withAlpha comment
 *  documents. */
function anchorToPt(anchor: { u: number; v: number }): Pt {
  return { x: anchor.u, y: anchor.v }
}

/** Default launch anchor for BallPosition 'any' (native: `?: (0.5, 0.03)`). */
export const DEFAULT_LAUNCH_UV: Pt = { x: 0.5, y: 0.03 }

/** Rule 6's shooting-flipper anchors — the SAME points as the ballPosition
 *  anchors (models.ts BALL_ANCHORS.leftFlipper/rightFlipper), just keyed by
 *  'left'/'right' instead of BallPosition and run through this file's
 *  existing anchorToPt conversion rather than duplicating the literals. */
export const FLIPPER_ANCHORS: Record<'left' | 'right', Pt> = {
  left: anchorToPt(BALL_ANCHORS.leftFlipper),
  right: anchorToPt(BALL_ANCHORS.rightFlipper),
}

/** Rule 6(c) snap-direct threshold, in UV units. When a segment's origin
 *  already sits within this distance of the chosen shooting flipper's
 *  anchor — e.g. an inlane feed returning to its own flipper, ~0.072 UV
 *  units for (0.36,0.10)->(0.40,0.04) — the "return through the flipper
 *  zone" route collapses to one straight leg instead of a detour through a
 *  waypoint the ball is already sitting on. */
export const FLIPPER_SNAP = 0.08

// ---- Shooter-lane band (SPEC-PATHVIZ rule 5) — the UV footprint of the lane
// a plunger-origin segment actually travels, and where the ball rests at its
// bottom. UNCHANGED, additive only; consumed by ./drawing.ts's laneRoute and
// the effective-launch-anchor block in drawGoalOverlay. ----
export const LANE_MIN_X = 0.93
export const LANE_MAX_X = 0.98
export const LANE_TOP_V = 0.88
export const ARCH_ENTRY_UV: Pt = { x: 0.74, y: 0.93 }
/** Where the ball rests at the bottom of the shooter lane — the plunger
 *  anchor's v coordinate (SPEC-BALLSTART's "plunger launch realism"
 *  amendment). Named so every consumer of the lane band shares it instead of
 *  a bare literal. */
export const LANE_BOTTOM_V = 0.02

/**
 * Resolves a FeedRef (SPEC-PATHVIZ rule 7, dataset schema v3) to a UV point.
 * `shot` wins over `x`/`y` when present; an unresolvable `shot` id is
 * treated as if the whole ref were absent (fail-soft) — it does NOT fall
 * back to `x`/`y`. Returns null when nothing usable is present, which
 * ./drawing.ts's rampExtensionLegs treats as "no extension to draw".
 */
export function resolveFeedUV(ref: FeedRef | null | undefined, shotsByID: Map<string, Shot>): Pt | null {
  if (!ref) return null
  if (ref.shot != null) {
    const shot = shotsByID.get(ref.shot)
    return shot ? { x: shot.x, y: shot.y } : null
  }
  if (typeof ref.x === 'number' && typeof ref.y === 'number' && Number.isFinite(ref.x) && Number.isFinite(ref.y)) {
    return { x: ref.x, y: ref.y }
  }
  return null
}

/**
 * Rule 6's shooting-flipper resolution for the segment arriving at target
 * `toUV` from origin `fromUV`. Precedence: 1) the step's own override,
 * 2) the target shot's own `flipper`, 3) a cross-flipper heuristic off the
 * TARGET's x (t.x<0.45 -> right, t.x>0.55 -> left — the ball crosses the
 * playfield to hit a shot on the far side), 4) in the center band
 * [0.45,0.55], whichever flipper the ball is already presumed to be on
 * (fromUV.x<0.5 -> left, else right).
 */
export function chooseFlipper(
  toUV: Pt,
  fromUV: Pt,
  stepFlipper: string | null | undefined,
  shotFlipper: string | null | undefined,
): 'left' | 'right' {
  if (stepFlipper === 'left' || stepFlipper === 'right') return stepFlipper
  if (shotFlipper === 'left' || shotFlipper === 'right') return shotFlipper
  if (toUV.x < 0.45) return 'right'
  if (toUV.x > 0.55) return 'left'
  return fromUV.x < 0.5 ? 'left' : 'right'
}

/**
 * Rule 7's ramp-continuation apex synthesis (models.ts Shot.apex doc
 * comment, which gives this exact formula): used whenever a shot has no
 * authored `apex` (or an invalid one — see ./drawing.ts's rampExtensionLegs,
 * the only caller today) but a feed point DID resolve. With `entrance` = the
 * shot's own (x, y) and `feed` = the resolved feed point, the crest sits a
 * quarter of the way from entrance to feed horizontally, and never below
 * either endpoint plus a small margin vertically — the `max(..., feed.y +
 * 0.02)` term keeps the crest at/above the landing point for upper-playfield
 * feeds (e.g. a feed well above the usual ~0.10 down-feed); for a normal
 * down-feeding ramp this is byte-identical to the pre-2026-07-29
 * `min(0.95, entrance.y + 0.22)`. Extracted 2026-08-10 (phase A1) out of
 * rampExtensionLegs so there is exactly one implementation of this formula.
 */
export function synthesizeApex(entrance: Pt, feed: Pt): Pt {
  return {
    x: entrance.x + 0.25 * (feed.x - entrance.x),
    y: Math.min(0.95, Math.max(entrance.y + 0.22, feed.y + 0.02)),
  }
}

export interface ShootingAnchor {
  uv: Pt
  side: 'left' | 'right'
  /** True when `uv` is a deck bat's own coordinates (phase A4) rather than
   *  FLIPPER_ANCHORS[side] — i.e. `targetShot.playfield` named a zone that
   *  has at least one `type:'flipper'` shot of its own. `side` is set either
   *  way (the deck bat's own `bat.side`, or a geometric fallback — see
   *  batSide), so a caller that only cares about left/right never needs to
   *  branch on `deck` at all. */
  deck: boolean
}

/**
 * Resolves a flipper VALUE (GoalStep.flipper / Shot.flipper) that names a
 * flipper-typed SHOT ID rather than 'left'/'right' — Feature 1 extension,
 * 2026-08-11 (rolo, screenshot evidence: Jaws' harpoon lane is made from the
 * MID-RIGHT MINI FLIPPER — `harpoon-lane.flipper: 'mini-flipper'` in the
 * shipped data — not the main right flipper the old 'left'/'right'-only
 * heuristic assumed, since the cross-side heuristic only knows the main
 * pair). `value` is 'left'/'right' (not this function's concern — every
 * caller checks that case itself first), null/undefined, or a shot id;
 * returns the named shot only when it resolves AND is `type:'flipper'` —
 * an unresolvable id, or one that resolves to something else, is treated as
 * absent (fail-soft, same shape as every other id lookup in this file).
 * Exported for ui/goalMeta.ts's stepProvenance, which names the same shot
 * in its "FROM <FLIPPER> " choreography line.
 */
export function resolveFlipperShot(value: string | null | undefined, shots: Map<string, Shot>): Shot | null {
  if (!value || value === 'left' || value === 'right') return null
  const shot = shots.get(value)
  return shot && shot.type === 'flipper' ? shot : null
}

/**
 * Rule 6's shooting-flipper anchor for the segment arriving at `targetShot`
 * from `fromUV`.
 *
 * Feature 1 extension (2026-08-11, checked FIRST, before the deck-bat/
 * heuristic logic below): `stepFlipper` (beats) or `targetShot.flipper` may
 * name a flipper-typed shot id instead of 'left'/'right' — see
 * resolveFlipperShot's own doc comment. When one resolves, the anchor is
 * THAT SHOT's own (x, y) outright — `side` from its own authored
 * `bat.side`, else which half of the playfield it sits in (the same "no
 * data, use geometry" fallback batSide uses for a deck bat); `deck: true`
 * only when the named shot itself carries a `playfield` (it's a deck bat
 * named directly rather than discovered via `targetShot.playfield` +
 * batsForZone below — same concept, a different route to it). This is the
 * general mechanism for a shot actually made from something other than the
 * main pair (an upper/mini flipper) that the geometric heuristics below
 * have no way to discover on their own.
 *
 * Deck-aware as of phase A4 (2026-08-10, dataset schema v5): when no named
 * flipper shot resolved above, and `targetShot.playfield` names a
 * PlayfieldZone in `zones` that itself has one or more `type:'flipper'`
 * shots on it (batsForZone), the anchor is that DECK BAT's own (x, y) —
 * `deck: true` — instead of the main FLIPPER_ANCHORS. A single bat is used
 * outright; 2+ bats are disambiguated by chooseDeckBat (stepFlipper/
 * shot.flipper matching a bat's side, else the cross-side heuristic
 * re-centered on the zone's own midline).
 *
 * FAIL-SOFT: no named flipper shot, a zone with no bat, an unresolvable
 * `targetShot.playfield`, or no `zones` argument at all (the pre-A4 call
 * shape) all fall through to EXACTLY the old main-flipper behavior —
 * `{ uv: FLIPPER_ANCHORS[side], side, deck: false }`, `side` from
 * chooseFlipper. This is why every caller that doesn't thread `zones` (or a
 * machine whose data has no `playfields`, or no step ever names a flipper
 * shot) stays byte-identical to before these phases.
 */
export function resolveShootingAnchor(
  targetShot: Shot,
  fromUV: Pt,
  stepFlipper: string | null | undefined,
  shots: Map<string, Shot>,
  zones?: PlayfieldZone[] | Map<string, PlayfieldZone> | null,
): ShootingAnchor {
  const namedFlipperShot = resolveFlipperShot(stepFlipper, shots) ?? resolveFlipperShot(targetShot.flipper, shots)
  if (namedFlipperShot) {
    return {
      uv: { x: namedFlipperShot.x, y: namedFlipperShot.y },
      side:
        namedFlipperShot.bat?.side === 'left' || namedFlipperShot.bat?.side === 'right'
          ? namedFlipperShot.bat.side
          : namedFlipperShot.x < 0.5
            ? 'left'
            : 'right',
      deck: !!namedFlipperShot.playfield,
    }
  }
  const zone = zoneOf(targetShot, zones)
  if (zone) {
    const bats = batsForZone(shots, zone.id)
    if (bats.length > 0) {
      const bat = chooseDeckBat(bats, zone, targetShot, fromUV, stepFlipper)
      return { uv: { x: bat.x, y: bat.y }, side: batSide(bat, zone), deck: true }
    }
  }
  const side = chooseFlipper({ x: targetShot.x, y: targetShot.y }, fromUV, stepFlipper, targetShot.flipper)
  return { uv: FLIPPER_ANCHORS[side], side, deck: false }
}

/**
 * The PlayfieldZone `shot.playfield` names, or undefined when the shot
 * carries no `playfield`, the id doesn't resolve, or `zones` itself is
 * absent/empty — all treated the same (fail-soft: "this shot is on the main
 * playfield"). Accepts either the raw `GameData.playfields` array or a
 * pre-built `Map<id, zone>` — callers that resolve many shots per render
 * (./drawing.ts's drawGoalOverlay) build the Map once instead of re-scanning
 * the array per shot.
 */
export function zoneOf(
  shot: Shot,
  zones: PlayfieldZone[] | Map<string, PlayfieldZone> | null | undefined,
): PlayfieldZone | undefined {
  if (!zones || !shot.playfield) return undefined
  return zones instanceof Map ? zones.get(shot.playfield) : zones.find((z) => z.id === shot.playfield)
}

/**
 * Every `type:'flipper'` shot declared on zone `zoneId` — a zone's "deck
 * bat(s)". Most zones have exactly one; a facing pair (two bats on one deck)
 * is also expected data. Empty for a zone with no bat at all, which is
 * resolveShootingAnchor's fail-soft signal to fall through to the main
 * flippers.
 */
export function batsForZone(shots: Map<string, Shot>, zoneId: string): Shot[] {
  const out: Shot[] = []
  for (const s of shots.values()) {
    if (s.type === 'flipper' && s.playfield === zoneId) out.push(s)
  }
  return out
}

/** A deck bat's effective side — its own authored `bat.side` when present,
 *  else inferred from which half of the ZONE it sits in (x vs the zone's own
 *  midline, `bounds.x + bounds.w / 2`) — the same "no data, use geometry"
 *  fallback chooseFlipper itself uses for the main flippers, just local to
 *  the deck. */
function batSide(bat: Shot, zone: PlayfieldZone): 'left' | 'right' {
  if (bat.bat?.side === 'left' || bat.bat?.side === 'right') return bat.bat.side
  return bat.x < zone.bounds.x + zone.bounds.w / 2 ? 'left' : 'right'
}

/** chooseFlipper's own cross-side bands (target x<0.45 -> right, x>0.55 ->
 *  left, else the origin-side tie-break), re-run with both points shifted so
 *  the ZONE's own midline lands on the 0.5 those bands assume — the same
 *  "ball crosses to the far side" intuition chooseFlipper already encodes
 *  for the main flippers, just local to the deck instead of the whole
 *  playfield. Reuses chooseFlipper rather than re-deriving its bands at a
 *  second call site. */
function crossSideAtZone(targetShot: Shot, fromUV: Pt, zone: PlayfieldZone): 'left' | 'right' {
  const shift = 0.5 - (zone.bounds.x + zone.bounds.w / 2)
  return chooseFlipper({ x: targetShot.x + shift, y: targetShot.y }, { x: fromUV.x + shift, y: fromUV.y }, null, null)
}

/**
 * Deck-bat selection for a zone with 2+ bats (most zones have exactly one,
 * and this function's only caller — resolveShootingAnchor — never reaches it
 * for a single-bat zone). Precedence: 1) `stepFlipper` (the GoalStep's own
 * override) matching a bat's side, 2) the target shot's own `flipper`
 * matching a bat's side, 3) crossSideAtZone's geometric fallback. If the
 * winning side matches no bat (e.g. neither bat's side/x-position agrees
 * with it), degrades to the bat nearest the target on the x axis — still
 * deterministic, still a deck anchor, never a crash or an arbitrary pick.
 */
function chooseDeckBat(
  bats: Shot[],
  zone: PlayfieldZone,
  targetShot: Shot,
  fromUV: Pt,
  stepFlipper: string | null | undefined,
): Shot {
  if (bats.length === 1) return bats[0]!
  const desired: 'left' | 'right' =
    stepFlipper === 'left' || stepFlipper === 'right'
      ? stepFlipper
      : targetShot.flipper === 'left' || targetShot.flipper === 'right'
        ? targetShot.flipper
        : crossSideAtZone(targetShot, fromUV, zone)
  const match = bats.find((b) => batSide(b, zone) === desired)
  if (match) return match
  return bats.reduce((best, b) => (Math.abs(b.x - targetShot.x) < Math.abs(best.x - targetShot.x) ? b : best))
}

/**
 * Per-model shot visibility (models.ts Shot.trim doc comment, which gives
 * this exact formula): visible on `trim` ⇔ the shot carries no trim
 * restriction, is explicitly 'all', or matches the selected trim exactly.
 * Not wired into either renderer yet — there is no trim selector in
 * state.ts as of this phase; this is the predicate models.ts's own doc
 * comment already promises one will use.
 */
export function isShotVisible(shot: Shot, trim: 'pro' | 'premium-le'): boolean {
  return !shot.trim || shot.trim === 'all' || shot.trim === trim
}

/**
 * Per-model PlayfieldZone visibility (models.ts PlayfieldZone.trim doc
 * comment: "Same semantics as Shot.trim") — the exact same formula as
 * isShotVisible, kept as its own one-line predicate (rather than widening
 * isShotVisible's parameter type) so each function's name says exactly what
 * it tests. ./map2d.ts's drawPlayfieldArt caller (phase A4) uses this to
 * drop a premium-le-only zone's plate under the pro selector, same as it
 * already drops a premium-le-only shot.
 */
export function isZoneVisible(zone: PlayfieldZone, trim: 'pro' | 'premium-le'): boolean {
  return !zone.trim || zone.trim === 'all' || zone.trim === trim
}

/**
 * Rule 7 + schema v5 per-model feed resolution (models.ts Shot.feedsByTrim
 * doc comment): a step's own `feeds` override beats everything; failing
 * that, a per-trim override beats the shot's base `feeds`. Returns the
 * FeedRef to resolve (via resolveFeedUV) or null/undefined when none apply —
 * the same "absent means nothing to extend" contract resolveFeedUV and
 * rampExtensionLegs already have. Not wired into either renderer yet (no
 * trim selector exists as of this phase) — see isShotVisible's doc comment.
 */
export function feedForTrim(
  shot: Shot,
  stepFeeds: FeedRef | null | undefined,
  trim: 'pro' | 'premium-le',
): FeedRef | null | undefined {
  return stepFeeds ?? shot.feedsByTrim?.[trim] ?? shot.feeds
}

/**
 * The map background art's lane-line geometry for a ramp/orbit/loop shot
 * (./map2d.ts's drawPlayfieldArt) — deliberately the SAME flipper-selection
 * logic the route renderer uses, so the art and the goal route can never
 * point at different flippers for the same shot. Before this function
 * existed, map2d.ts picked its own origin with a naive `shot.x < 0.5`
 * same-side guess — which disagrees with chooseFlipper's cross-flipper
 * heuristic (target x<0.45 -> RIGHT, x>0.55 -> LEFT) for most shots outside
 * the center band. That disagreement between the drawn background lane and
 * the drawn goal route on top of it was the bug this module exists to make
 * structurally impossible (2026-08-10, phase A1).
 *
 * `from` uses DEFAULT_LAUNCH_UV as chooseFlipper's center-band tie-break
 * origin: there is no real "previous shot" for a piece of standalone
 * background art, and DEFAULT_LAUNCH_UV is the same context-free tie-break
 * ./drawing.ts's drawGoalOverlay itself falls back to for a step-0 launch
 * with no established ball position (its `launchFlipperChoice`).
 *
 * `control` honors an authored `shot.apex` (finite x AND y) exactly like the
 * route renderer does; otherwise it synthesizes a control point with the
 * ART's OWN curve formula — NOT synthesizeApex, which is rule 7's
 * ramp-continuation crest, a different curve for a different purpose. This
 * fallback is preserved byte-for-byte from map2d.ts's pre-extraction
 * lane-line code (just fed the new `from`), so the drawn curve's SHAPE is
 * unchanged by this refactor — only which flipper it starts from changes.
 *
 * `shotsById` is used (2026-08-11, Feature 1 extension) to resolve a
 * `shot.flipper` value that names a flipper-typed shot id instead of
 * 'left'/'right' — see resolveFlipperShot's own doc comment. Checked here
 * too so the background lane line can never point at a different flipper
 * than the route it underlays (this function's whole reason for existing —
 * see the file header). This closes the SAME-shaped gap for background art
 * that resolveShootingAnchor closes for the route; it does NOT extend to
 * full zone/deck-bat awareness (this function has no `zones` argument) —
 * that is a separate, larger feature this function doesn't attempt.
 */
export function approachLine(shot: Shot, shotsById: Map<string, Shot>): { from: Pt; control: Pt; to: Pt } {
  const to: Pt = { x: shot.x, y: shot.y }
  const namedFlipperShot = resolveFlipperShot(shot.flipper, shotsById)
  const from: Pt = namedFlipperShot
    ? { x: namedFlipperShot.x, y: namedFlipperShot.y }
    : FLIPPER_ANCHORS[chooseFlipper(to, DEFAULT_LAUNCH_UV, null, shot.flipper)]
  const control: Pt =
    shot.apex && Number.isFinite(shot.apex.x) && Number.isFinite(shot.apex.y)
      ? shot.apex
      : { x: from.x + (to.x - from.x) * 0.55, y: Math.min(0.95, to.y * 0.72 + 0.08) }
  return { from, control, to }
}
