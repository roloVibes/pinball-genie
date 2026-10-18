// AppState port. Native source of truth:
//   PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/AppState.kt
// Goal-filtering-by-ballPosition rule ported EXACTLY from:
//   PinballGenieAndroid/.../ui/GoalBrowser.kt (firstShotType/makeable/filteredGoals)
//   PinballARPipeline/specs/SPEC-BALLSTART.md
//
// Deviation from Kotlin: native's `ballPosition: BallPosition?` uses null for
// "Any"; the web contract's BallPosition type has no null variant, so 'any'
// is the literal stand-in for null everywhere below (same semantics).
//
// 2026-07-13 ("remove the BALL AT selector"): the user-facing BALL AT
// Any/Plunger/L-flip/R-flip picker (app.ts header + ar/arview.ts bottom
// stack) is gone — the 2D map and AR overlay already show a goal's route
// starting from its own first-step shot, which made the picker redundant.
// `ballPosition` is now a fixed constant 'any' for the lifetime of the app
// (no setter, nothing restores a persisted value) rather than removing it
// outright, because overlay/drawing.ts's drawGoalOverlay still threads it
// through to pick the route's launch anchor (SPEC-BALLSTART) — see
// AppState.ballPosition below. filterGoalsByBallPosition is kept (still
// called by ar/arview.ts's goal sheet) but with the only caller always
// passing 'any' its plunger/flipper branches are now unreachable in
// practice; left in place as the literal SPEC-BALLSTART port rather than
// pruned, since a future BALL AT UI (if ever re-added) would need it back.
//
// 2026-07-28 "Shot Coach" (design_handoff_shot_coach/README.md "State"
// section, shotcoach-corrections.md #8): three new persisted user prefs
// (trailStyle/ballTracer, wired from the AR settings popover —
// out of scope for this file's own agent pass, that's ar/arview.ts's job)
// plus `routeStartedAt`, the epoch overlay/drawing.ts's tracer/marching
// clock is meant to be anchored to (o.time - routeStartedAt) so a newly
// selected goal's tracer always starts at leg 1 instead of landing at a
// random point in the cycle. NOTE: overlay/map2d.ts and ar/arview.ts still
// pass drawGoalOverlay a raw, unsubtracted clock THIS phase (their own
// agent passes do the subtraction — shotcoach-corrections.md #9) —
// `routeStartedAt` is tracked and reset correctly here regardless, ready for
// that wiring. `showLabels`/`lineBrightness` deliberately stay
// arview.ts-local (never were AppState fields, and Shot Coach doesn't move
// them here either).
//
// 2026-08-10 ("A3 trim selector"): `trim`/`setTrim` add a Pro/Premium-LE
// MODEL selector — dataset schema v5's Shot.trim (models.ts) has always
// distinguished base-Pro shots from premium-le-only content, but nothing
// read it until now, so every player saw every machine's superset of shots
// regardless of which physical model they were standing at. Persisted PER
// MACHINE (unlike trailStyle/ballTracer, which are global app prefs) because
// the choice describes one physical table, not the app as a whole — see
// readTrimPref's own comment for the key shape and the back-compat-safe
// 'premium-le' default. Consumed by overlay/map2d.ts (shot/goal filtering,
// the MODEL settings control) and overlay/drawing.ts (per-trim feed
// resolution, via shotgeom.ts's feedForTrim) — see each file's own A3 notes.
//
// 2026-08-11 (Feature 3, "map-scoped celebration"): `celebration`/
// setCelebration add a GLOBAL app pref (same persistence shape as
// trailStyle/ballTracer above, not per-machine — a "do I want the burst"
// preference describes the player, not one physical table), default ON.
// Read by overlay/map2d.ts's mountMap2D to gate the whole celebration
// subsystem (both the settings-popover toggle and whether anything is ever
// armed/drawn) and threaded into overlay/drawing.ts's drawGoalOverlay as
// `o.celebrate` — see each file's own Feature 3 notes. The LEVEL control
// (Feature 2, playfield −1 view) is deliberately NOT an AppState field —
// "session-local, resets on machine switch" is a plain local variable in
// map2d.ts's mountMap2D closure instead, the same pattern showLabels/
// lineBrightness already established for map-local, never-persisted state.
//
// 2026-08-11 (Feature 7, phase A14, "celebration intensity slider" — owner
// request: "Make the celebrations bigger... Create a slider that goes from
// 0 - no celebration to the slider all the way to the right..."): Feature
// 3's boolean `celebration`/setCelebration are SUPERSEDED by
// `celebrationLevel`/setCelebrationLevel (integer 0-5) — the map settings
// popover's CELEBRATION on/off toggle becomes an intensity SLIDER. Same
// localStorage key (CELEBRATION_KEY) and global (not per-machine)
// persistence shape as before; readCelebrationLevel migrates a pre-existing
// stored boolean transparently (`true` -> 1, `false` -> 0) so a returning
// user's prior on/off choice survives as the equivalent level rather than
// silently reverting to the new default. See overlay/drawing.ts's own
// Feature 7 header note for how the level scales the burst itself.
//
// 2026-08-11 (Feature 8, phase A15, "shot lines toggle" — owner request: "I
// think an on off button to remove the shot lines can be helpful. Then just
// the targets are displayed, it gives the user to just see each target shot
// without being confused with the line."): `shotLines`/setShotLines add a
// GLOBAL app pref (same persistence shape as trailStyle/ballTracer/
// celebrationLevel above, not per-machine like `trim`), default true
// (today's exact behavior when the field/localStorage key is absent). Read
// by overlay/map2d.ts's mountMap2D (map settings popover's new SHOT LINES
// toggle row, same buildToggleRow recipe as Ball tracer/Path labels) and
// threaded into overlay/drawing.ts's drawGoalOverlay as `o.shotLines` —
// false suppresses EVERY step's connector leg (Pass 1), rule-7 feed
// continuation, and loop coil for the whole goal, at drawing.ts's single
// existing gate point (`stepLinkSuppressed` — see that file's own Feature 8
// note), leaving the per-step ring/badge/name/caption marching through the
// goal exactly as before. Reuses the same generic `readBoolPref` helper
// ballTracer already does — SHOT_LINES_KEY/readBoolPref are exported
// (mirrors CELEBRATION_KEY's own export above) so the persistence
// round-trip can be tested directly without booting the whole app.
//
// 2026-08-11 (phase A16, "celebration reach to 7 + canvas-relative travel" —
// owner, reviewing level 5/5: "the animation for celebration is all the same
// still. the celebration explosion needs to almost take up the entire screen
// when you chose 7/7."): the legal `celebrationLevel` range widens from 0-5
// to 0-7 — setCelebrationLevel's clamp and readCelebrationLevel's parse-clamp
// both move their upper bound from `Math.min(5, ...)` to `Math.min(7, ...)`.
// Nothing else in this file changes: the SAME localStorage key
// (CELEBRATION_KEY), the SAME true/false->1/0 boolean migration, and the
// SAME default (1, "today's burst was ON by default") all carry over
// untouched — a value stored back when 5 was the ceiling (0 through 5) reads
// back byte-identical under the new ceiling, since every one of those values
// was already inside [0,7]. Only overlay/drawing.ts's drawGoalOverlay (Pass
// 5) and celebrationParams actually DO anything different with a level above
// 5 — see that file's own phase A16 note for the full formula table (now
// anchored at level 7, not level 5) and the canvas-relative reach change
// that makes "take up the entire screen" possible at all (a fixed-pixel
// reach could never scale to fill an arbitrary canvas). map2d.ts's settings
// popover slider still has `max="5"` as of this writing — a separate,
// not-yet-landed change — so celebrationLevel in practice still never
// exceeds 5 from the live UI; this widened ceiling is what that slider
// change will rely on once it lands, and is exercised directly today by
// tests/celebrate.test.mjs.

//
// 2026-08-14 (P6 L1, Machine Library): machine SWITCHING stops being
// fire-and-forget. Until now `selectMachine()` was called as
// `void state.selectMachine(m)` from the header picker and awaited nowhere
// that could act on a failure — `loadMachine` did an unguarded
// `await fetchGameData(m)`, so a flaky venue Wi-Fi hiccup produced an
// unhandled promise rejection and a UI frozen on the PREVIOUS machine with no
// explanation. Four things change, all additive:
//   - `machineLoading` / `machineError` are real, observable state. loadMachine
//     try/catches the fetch and RESOLVES either way (it never rejects any
//     more) — a caller learns the outcome from the flags, not from a catch it
//     was never going to write. `machine`/`data` are left completely untouched
//     on failure: the app keeps showing the machine that IS loaded rather than
//     half-swapping into one that isn't.
//   - A GENERATION TOKEN (`loadGeneration`) makes "success" mean "this is the
//     load that is still wanted". Two quick taps in the library used to race:
//     whichever fetch happened to settle last won, even if it was the one the
//     user had already moved on from. A superseded load now returns without
//     touching a single field.
//   - `recentMachineIds` (most-recent-first, capped) and `pinnedMachineIds`
//     (the star) persist to localStorage. Both are VALIDATED against the live
//     catalog on read: a stored id for a machine that has since been renamed
//     or removed is dropped, never rendered as a ghost row.
//   - `bootMachine()` still REJECTS on failure, deliberately, even though
//     loadMachine no longer does. main.ts's boot try/catch is the only thing
//     that can tell a visitor "Couldn't load Pinball Genie" at all; making the
//     boot path resolve-quietly would replace that message with an app stuck
//     on a permanent "Loading…" — see bootMachine's own comment.

import type { BallPosition, GameData, Goal, Machine, Shot } from './models'
import { fetchCatalog, fetchGameData } from './models'

/** Why a machine switch failed, and WHICH machine it was for (P6 L1). The
 *  machine id is half the payload: by the time this is rendered, `state.machine`
 *  is still the machine that WAS loaded, so an error string alone could not say
 *  whose failure it describes ("Couldn't load Godzilla" needs the id that
 *  failed, not the one that survived). */
export interface MachineLoadError {
  machineId: string
  message: string
}

// AppState port (mirror AppState.kt semantics) — see CONTRACTS.md.
export interface AppState {
  machines: Machine[]
  machine: Machine | null
  data: GameData | null
  shotsByID: Map<string, Shot>
  selectedGoal: Goal | null
  stepIndex: number
  /** Fixed constant 'any' — see the 2026-07-13 header note above. Still
   *  threaded through to overlay/drawing.ts's drawGoalOverlay (SPEC-
   *  BALLSTART's launch-anchor rule), so the field stays, just with no
   *  setter and nothing ever assigning it a non-'any' value. */
  ballPosition: BallPosition
  /** 'auto': the overlay's marching highlight cycles the goal's steps on a
   *  timer. 'manual': it parks on stepIndex until resumed. Reset to 'auto' by
   *  select()/clearSelection()/restartGoal()/machine loads. */
  highlightMode: 'auto' | 'manual'
  /** Shot Coach (2026-07-28) route rendering prefs — persisted to
   *  localStorage, see the *_KEY consts below. */
  trailStyle: 'dash' | 'neon'
  ballTracer: boolean
  /** Feature 8 (2026-08-11, phase A15) — master ON/OFF for route-LINE
   *  rendering (owner: "an on off button to remove the shot lines... just
   *  the targets are displayed"). false suppresses every connector leg,
   *  rule-7 feed continuation, and loop coil for the WHOLE selected goal —
   *  see overlay/drawing.ts's own Feature 8 note for the single gate point.
   *  Global app pref (unlike `trim`), same persistence shape as trailStyle/
   *  ballTracer/celebrationLevel. Default true (today's exact behavior). */
  shotLines: boolean
  /** Model selector (A3, 2026-08-10) — which physical machine variant's shot
   *  roster/feeds to draw: 'pro' (base) or 'premium-le' (Pro's shots plus
   *  premium-le-only content). Persisted PER MACHINE at localStorage key
   *  `pinballgenie.trim.<machineId>` (unlike trailStyle/ballTracer, which are
   *  global app prefs) — restored in loadMachine() on every boot/
   *  selectMachine(). Default 'premium-le': today's (pre-A3) render is
   *  unfiltered, i.e. equivalent to always showing premium-le content, so
   *  that's the back-compat-safe default (see readTrimPref below). */
  trim: 'pro' | 'premium-le'
  /** Feature 7 (2026-08-11, phase A14; range widened 0-5 -> 0-7 in phase
   *  A16, same day) — map-scoped celebration INTENSITY, global app pref
   *  (unlike `trim`), integer 0-7. Supersedes Feature 3's boolean
   *  `celebration` (see the header note above): 0 disables the burst
   *  entirely (mountMap2D passes drawGoalOverlay `celebrate: null`, same as
   *  the old `celebration: false`); 1 reproduces Feature 3's original
   *  count/size/duration exactly, though its REACH is now a canvas-relative
   *  fraction rather than the old fixed-pixel multiple, so it is no longer
   *  byte-identical pixel-for-pixel (phase A16 — see overlay/drawing.ts's
   *  own note); each level above 1 scales glyph count/size/travel/duration
   *  up further, with spiral (angular-drift) trajectories added at level 3+,
   *  reaching a burst at level 7 that spans most of the canvas's own
   *  min(width,height) — "take up the entire screen" (owner, phase A16).
   *  Default 1 — "back-compat wins": the pre-Feature-7 default was `true`
   *  (today's burst). See readCelebrationLevel's own doc comment for how an
   *  existing `true`/`false` stored pref migrates to 1/0. */
  celebrationLevel: number
  /** Epoch (performance.now()-space) the tracer/marching-highlight clock is
   *  anchored to — see the header note above. Reset on select()/
   *  restartGoal()/resumeHighlight()/machine loads (existing early-return
   *  guards on those methods are unchanged; see each method below). */
  routeStartedAt: number
  /** P6 L1 — a machine's dataset fetch is in flight. True for the WHOLE of a
   *  switch, including the boot load; every subscriber sees it via the
   *  onChange notify loadMachine fires before it awaits anything. */
  machineLoading: boolean
  /** P6 L1 — the last machine switch that FAILED, or null. Cleared when a
   *  switch starts, when one succeeds, and when the visitor re-picks the
   *  machine already loaded (see selectMachine). `machine`/`data` are
   *  untouched by a failure, so the app is never in a half-switched state. */
  machineError: MachineLoadError | null
  /** P6 L1 — machine ids the visitor has actually loaded, MOST RECENT FIRST,
   *  deduped, capped at RECENT_MACHINES_CAP, persisted. Includes the machine
   *  currently loaded (it is, definitionally, the most recent one) — the
   *  library's Recent section filters that one out for display, because it
   *  already has its own strip at the top of the overlay. */
  recentMachineIds: readonly string[]
  /** P6 L1 — machine ids the visitor has starred, in the order they were
   *  starred, persisted. Unbounded by design: it can never exceed the size of
   *  the catalog, since every id is validated against it on read. */
  pinnedMachineIds: readonly string[]
  /** Stars/unstars `machineId` and persists the result. Returns the NEW pinned
   *  state so a caller can update one star without re-reading the array.
   *  Ignores (returns false for) an id that is not in this catalog. */
  togglePinned(machineId: string): boolean
  /** Whether `machineId` is starred. A method rather than making callers scan
   *  `pinnedMachineIds` themselves — the library asks this once per card. */
  isPinned(machineId: string): boolean
  setTrailStyle(v: 'dash' | 'neon'): void
  setBallTracer(v: boolean): void
  /** Sets the shot-lines pref (see `shotLines` above) and persists it
   *  globally. No-op (no notify) when unchanged. */
  setShotLines(v: boolean): void
  /** Sets the model selector and persists it under THIS machine's own
   *  localStorage key (see `trim` above). No-op (no notify) when unchanged. */
  setTrim(v: 'pro' | 'premium-le'): void
  /** Sets the celebration intensity (clamped to the legal [0,7] integer
   *  range — widened from [0,5] in phase A16) and persists it globally (see
   *  `celebrationLevel` above). No-op (no notify) when the CLAMPED value is
   *  unchanged. */
  setCelebrationLevel(v: number): void
  selectMachine(m: Machine): Promise<void> // resets selection
  select(g: Goal): void
  clearSelection(): void
  nextStep(): void
  prevStep(): void
  /** Jumps directly to step `i` (clamped to [0, steps.length-1]) — lets the
   *  Goals-tab step rows be tapped individually instead of only stepping via
   *  ‹ ›. No-op when no goal is selected. */
  goToStep(i: number): void
  /** Resets stepIndex to 0 without clearing the selection — AR's celebrate
   *  loop restarts at step 1 of the SAME goal (DESIGN-NOTES §2.6), unlike
   *  the non-AR Goals tab's completion flow which calls clearSelection().
   *  No-op when no goal is selected. */
  restartGoal(): void
  /** Enter manual mode (park the highlight on stepIndex). No-op when no goal
   *  is selected or already manual. */
  pauseHighlight(): void
  /** Back to the auto-marching highlight. No-op when already auto. */
  resumeHighlight(): void
  onChange(fn: () => void): () => void // subscribe, returns unsubscribe
}

const MACHINE_KEY = 'pinballgenie.machineId'
const TRAIL_STYLE_KEY = 'pinballgenie.trailStyle'
const BALL_TRACER_KEY = 'pinballgenie.ballTracer'
// 'pinballgenie.emojiMarkers' pref RETIRED 2026-07-29 (playfield emoji chips
// removed — rolo found them distracting); stale stored values are ignored.
/** Model selector (A3, 2026-08-10) — PER-MACHINE, unlike every other
 *  persisted pref in this file, because a Pro/Premium-LE choice describes
 *  one physical machine, not a global app preference: a JAWS Premium owner
 *  and a Deadpool Pro owner sharing this browser must each keep their own
 *  setting. */
const TRIM_KEY_PREFIX = 'pinballgenie.trim.'
/** Feature 3 (2026-08-11) — global app pref, same shape as TRAIL_STYLE_KEY/
 *  BALL_TRACER_KEY above (not per-machine, unlike TRIM_KEY_PREFIX). Feature
 *  7 (2026-08-11, phase A14) reuses this SAME key for the numeric
 *  celebrationLevel pref — see readCelebrationLevel's own doc comment for
 *  the migration from this key's original boolean values. Exported so
 *  tests/celebrate.test.mjs can write a pre-migration value under the exact
 *  key readCelebrationLevel reads, without duplicating the literal string. */
export const CELEBRATION_KEY = 'pinballgenie.celebration'
/** Feature 8 (2026-08-11, phase A15) — global app pref, same persistence
 *  shape as TRAIL_STYLE_KEY/BALL_TRACER_KEY above. Exported (mirrors
 *  CELEBRATION_KEY above) so tests can read/write the exact key
 *  `readBoolPref(SHOT_LINES_KEY, ...)` reads, without duplicating the
 *  literal string. */
export const SHOT_LINES_KEY = 'pinballgenie.shotLines'
/** P6 L1 (Machine Library) — the visitor's own two lists. Exported for the
 *  same reason CELEBRATION_KEY/SHOT_LINES_KEY are: a test writes the exact key
 *  the reader reads, with no literal duplicated between the two files. */
export const RECENT_MACHINES_KEY = 'pinballgenie.recentMachineIds'
export const PINNED_MACHINES_KEY = 'pinballgenie.pinnedMachineIds'
/** How many machines the Recent list remembers. Six is the design's own number
 *  (the library shows a Recent section of at most six cards); keeping the cap
 *  in the STATE rather than the view means the persisted list can't quietly
 *  grow to hundreds of ids that nothing will ever render. */
export const RECENT_MACHINES_CAP = 6

/** Parses a persisted id list, dropping everything that isn't a plain string,
 *  everything that isn't a machine in the CURRENT catalog, and every duplicate
 *  after the first — then caps it.
 *
 *  The catalog check is the point of this function existing rather than a
 *  JSON.parse at each call site. Machine ids are content, and content moves: a
 *  machine can be renamed, split, or pulled from the catalog between two visits.
 *  An id that survives in localStorage past its machine would otherwise render
 *  as a card that cannot be tapped, or (worse) be handed to selectMachine and
 *  fetch a 404. Same stale-key-guard posture as readTrimPref/readCelebration-
 *  Level above, applied to a list.
 *
 *  Never throws: unparseable JSON, a stored object, a stored number — all read
 *  as the empty list. Exported for direct testing without booting the app. */
export function readMachineIdList(key: string, validIds: ReadonlySet<string>, cap = Infinity): string[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return [] // storage disabled/blocked (private mode) — behave as "never set"
  }
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    if (!validIds.has(entry)) continue
    if (out.includes(entry)) continue
    out.push(entry)
    if (out.length >= cap) break
  }
  return out
}

/** Pure most-recent-first push: `id` goes to the front, any earlier copy of it
 *  is removed (a re-visit MOVES a machine up the list rather than listing it
 *  twice), and the result is capped. Exported so the dedupe/cap contract can
 *  be tested as arithmetic instead of through a mounted app. */
export function pushRecentId(list: readonly string[], id: string, cap = RECENT_MACHINES_CAP): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, Math.max(0, cap))
}

/** Best-effort persist. localStorage throws in Safari private mode and when a
 *  quota is exceeded; a starred machine failing to survive a reload is a far
 *  smaller problem than the star tap throwing out of the click handler and
 *  taking the rest of the UI update with it. */
function writeMachineIdList(key: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    /* storage unavailable — the in-memory list still works for this session */
  }
}

function readTrailStylePref(): 'dash' | 'neon' {
  const raw = localStorage.getItem(TRAIL_STYLE_KEY)
  return raw === 'neon' ? 'neon' : 'dash'
}

/** Generic localStorage boolean-pref reader (JSON `"true"`/`"false"`), with
 *  a documented fallback for a never-set or unparseable/non-boolean stored
 *  value — shared by ballTracer (BALL_TRACER_KEY) and shotLines
 *  (SHOT_LINES_KEY, Feature 8 2026-08-11 phase A15). Exported (Feature 8) so
 *  a persistence round-trip can be tested directly against SHOT_LINES_KEY
 *  without booting the whole app — same rationale as trimStorageKey/
 *  readTrimPref/readCelebrationLevel's own exports above. */
export function readBoolPref(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'boolean' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** The localStorage key trim is persisted under for one machine — exported
 *  (with readTrimPref below) for direct testing of the round-trip/stale-
 *  value-fallback contract (tests/trim-filter.test.mjs) without booting the
 *  whole app, since createAppState() does real network fetches. */
export function trimStorageKey(machineId: string): string {
  return `${TRIM_KEY_PREFIX}${machineId}`
}

/** DEFAULT 'premium-le' — today's (pre-A3) render is unfiltered, i.e.
 *  equivalent to always showing premium-le content, so defaulting the new
 *  filter to 'premium-le' is what keeps a returning user's map looking
 *  exactly as it did before this control existed (back-compat wins). A
 *  stored value outside the two legal strings — never written by this app,
 *  but a stale/corrupted/hand-edited key is not impossible — falls back to
 *  that same default rather than propagating garbage into state.trim (same
 *  stale-key-guard shape as readTrailStylePref above). */
export function readTrimPref(machineId: string): 'pro' | 'premium-le' {
  const raw = localStorage.getItem(trimStorageKey(machineId))
  return raw === 'pro' ? 'pro' : 'premium-le'
}

/** Feature 7 (2026-08-11, phase A14; range widened 0-5 -> 0-7 in phase A16,
 *  same day) — reads the persisted celebration intensity, MIGRATING a
 *  pre-Feature-7 boolean pref transparently. CELEBRATION_KEY used to store a
 *  JSON boolean (`"true"`/`"false"`, Feature 3's `celebration` on/off
 *  toggle) — this reads that SAME key but now expects a plain integer string
 *  (Feature 7's `celebrationLevel`, "0" through "7" as of phase A16; "0"
 *  through "5" pre-A16). A stored `"true"`/`"false"` (from before this
 *  feature existed, or a stale/hand-edited value) migrates to 1/0
 *  respectively, preserving the exact on/off meaning the boolean pref used
 *  to carry. Any other unparseable/non-finite/never-set value falls back to
 *  the documented default (1 — "today's burst was ON by default"); a
 *  parseable but out-of-range number (negative, or > 7) clamps into the
 *  legal range rather than propagating garbage into state.celebrationLevel —
 *  same stale-key-guard shape as readTrimPref/readTrailStylePref above. A
 *  value stored under the pre-A16 ceiling (0 through 5) round-trips
 *  byte-identical, since every legal pre-A16 value is still legal now —
 *  widening the ceiling is additive, never a breaking migration. Exported
 *  (mirrors trimStorageKey/readTrimPref) for direct testing
 *  (tests/celebrate.test.mjs) without booting the whole app, since
 *  createAppState() does real network fetches. */
export function readCelebrationLevel(): number {
  const raw = localStorage.getItem(CELEBRATION_KEY)
  if (raw === null) return 1
  if (raw === 'true') return 1 // pre-Feature-7 boolean pref, migrated
  if (raw === 'false') return 0 // pre-Feature-7 boolean pref, migrated
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(7, Math.max(0, Math.round(n))) : 1
}

/** The `type` of a goal's first-step shot (undefined if unresolvable) —
 *  mirrors GoalBrowser.kt's private `firstShotType`. */
function firstShotType(goal: Goal, shotsByID: Map<string, Shot>): string | undefined {
  const first = goal.steps[0]
  if (!first) return undefined
  return shotsByID.get(first.shot)?.type
}

/** Whether a goal's first-step target is a cross-court (forehand) shot from
 *  the given flipper — mirrors GoalBrowser.kt's private `makeable`. */
function makeable(goal: Goal, shotsByID: Map<string, Shot>, position: BallPosition): boolean {
  const first = goal.steps[0]
  if (!first) return false
  const shot = shotsByID.get(first.shot)
  if (!shot) return false
  if (position === 'leftFlipper') return shot.x >= 0.45
  if (position === 'rightFlipper') return shot.x <= 0.55
  return true // plunger (or 'any', never reaches here from filterGoalsByBallPosition)
}

/**
 * SPEC-BALLSTART filter contract, ball-position portion only (category
 * filtering, if any, is ANDed by the caller beforehand). Ported EXACTLY
 * from GoalBrowser.kt's `filteredGoals` local:
 *   any      -> all goals, unchanged order
 *   plunger  -> only goals whose first step's shot type == "plunge"
 *   flipper  -> drop plunge-first goals, then stable-sort makeable-first
 *               (cross-court/forehand from that flipper), same-side after
 *               but never hidden
 */
export function filterGoalsByBallPosition(
  goals: Goal[],
  shotsByID: Map<string, Shot>,
  ballPosition: BallPosition,
): Goal[] {
  if (ballPosition === 'any') return goals
  if (ballPosition === 'plunger') {
    return goals.filter((g) => firstShotType(g, shotsByID) === 'plunge')
  }
  // leftFlipper | rightFlipper
  return goals
    .filter((g) => firstShotType(g, shotsByID) !== 'plunge')
    .slice()
    .sort((a, b) => {
      const bm = makeable(b, shotsByID, ballPosition) ? 1 : 0
      const am = makeable(a, shotsByID, ballPosition) ? 1 : 0
      return bm - am // descending: makeable-true first; Array.sort is stable (ES2019+)
    })
}

class AppStateImpl implements AppState {
  machines: Machine[]
  machine: Machine | null = null
  data: GameData | null = null
  shotsByID: Map<string, Shot> = new Map()
  selectedGoal: Goal | null = null
  stepIndex = 0
  ballPosition: BallPosition = 'any'
  highlightMode: 'auto' | 'manual' = 'auto'
  trailStyle: 'dash' | 'neon' = 'dash'
  ballTracer = true
  shotLines = true
  trim: 'pro' | 'premium-le' = 'premium-le'
  celebrationLevel = 1
  routeStartedAt = performance.now()
  machineLoading = false
  machineError: MachineLoadError | null = null
  recentMachineIds: readonly string[] = []
  pinnedMachineIds: readonly string[] = []

  private listeners = new Set<() => void>()
  /** Every id in `machines`, for O(1) validation of a persisted/ hostile id. */
  private readonly machineIds: Set<string>
  /** Monotonic token identifying the load that is CURRENTLY wanted (P6 L1).
   *  Bumped by every loadMachine and by the "re-picked the machine already
   *  loaded" branch of selectMachine; a load whose token no longer matches has
   *  been superseded and must not write a single field. */
  private loadGeneration = 0

  constructor(machines: Machine[]) {
    this.machines = machines
    this.machineIds = new Set(machines.map((m) => m.id))
  }

  togglePinned(machineId: string): boolean {
    // An id outside the catalog can only arrive from a caller that made one
    // up; refuse rather than persist it and have readMachineIdList silently
    // drop it on the next boot (a star that survives until reload and then
    // vanishes is worse than one that never appears).
    if (!this.machineIds.has(machineId)) return false
    const was = this.pinnedMachineIds.includes(machineId)
    this.pinnedMachineIds = was
      ? this.pinnedMachineIds.filter((x) => x !== machineId)
      : [...this.pinnedMachineIds, machineId]
    writeMachineIdList(PINNED_MACHINES_KEY, this.pinnedMachineIds)
    this.notify()
    return !was
  }

  isPinned(machineId: string): boolean {
    return this.pinnedMachineIds.includes(machineId)
  }

  /** Records a SUCCESSFUL load in the recents list and persists it. Failures
   *  deliberately do not count: "recent" means machines the visitor actually
   *  got to, and a list that fills up with machines that failed to load would
   *  be a list of the visitor's worst moments. */
  private rememberRecent(machineId: string): void {
    this.recentMachineIds = pushRecentId(this.recentMachineIds, machineId)
    writeMachineIdList(RECENT_MACHINES_KEY, this.recentMachineIds)
  }

  /** Internal loader shared by boot and selectMachine. `ballPosition` is
   *  never touched here — it's a fixed 'any' for the app's whole lifetime
   *  (see the header note above), so switching machines has nothing to
   *  reset on that front anymore. `routeStartedAt` DOES reset here (Shot
   *  Coach, 2026-07-28) — a freshly loaded machine's first-selected goal
   *  should never inherit a stale clock. */
  private async loadMachine(m: Machine): Promise<void> {
    // P6 L1: this method RESOLVES WHATEVER HAPPENS. Its two callers are
    // `void state.selectMachine(m)` from a click handler and bootMachine();
    // neither is a place a rejection can be usefully caught, which is exactly
    // how the pre-P6 version produced unhandled rejections on a failed fetch.
    // The outcome is published as state instead: machineLoading/machineError,
    // and the `machine` identity itself (success ⇔ state.machine.id === m.id).
    const gen = ++this.loadGeneration
    this.machineLoading = true
    this.machineError = null
    this.notify()

    let data: GameData
    try {
      data = await fetchGameData(m)
    } catch (err) {
      // A load the visitor has already moved on from must not raise an error
      // banner for a machine they are no longer waiting on.
      if (gen !== this.loadGeneration) return
      this.machineLoading = false
      this.machineError = {
        machineId: m.id,
        message: err instanceof Error ? err.message : String(err),
      }
      // NOTHING ELSE IS TOUCHED — machine, data, shotsByID, selectedGoal and
      // trim all still describe the machine that IS loaded. A failed switch
      // leaves the app exactly where it was, which is the only honest place
      // for it to be.
      this.notify()
      return
    }
    if (gen !== this.loadGeneration) return

    this.machine = m
    this.data = data
    this.shotsByID = new Map(data.shots.map((s) => [s.id, s]))
    this.selectedGoal = null
    this.stepIndex = 0
    this.highlightMode = 'auto'
    this.routeStartedAt = performance.now()
    // Model selector (A3, 2026-08-10): per-machine, restored from
    // localStorage — falls back to the documented default 'premium-le' for a
    // never-set or stale/corrupt stored value (readTrimPref's own stale-key
    // guard).
    this.trim = readTrimPref(m.id)
    this.machineLoading = false
    this.machineError = null
    this.rememberRecent(m.id)
    try {
      localStorage.setItem(MACHINE_KEY, m.id)
    } catch {
      /* storage unavailable — the switch itself still worked */
    }
    this.notify()
  }

  setTrailStyle(v: 'dash' | 'neon'): void {
    if (this.trailStyle === v) return
    this.trailStyle = v
    localStorage.setItem(TRAIL_STYLE_KEY, v)
    this.notify()
  }

  setBallTracer(v: boolean): void {
    if (this.ballTracer === v) return
    this.ballTracer = v
    localStorage.setItem(BALL_TRACER_KEY, JSON.stringify(v))
    this.notify()
  }

  setShotLines(v: boolean): void {
    if (this.shotLines === v) return
    this.shotLines = v
    localStorage.setItem(SHOT_LINES_KEY, JSON.stringify(v))
    this.notify()
  }

  setTrim(v: 'pro' | 'premium-le'): void {
    if (this.trim === v) return
    this.trim = v
    if (this.machine) localStorage.setItem(trimStorageKey(this.machine.id), v)
    this.notify()
  }

  setCelebrationLevel(v: number): void {
    const clamped = Math.min(7, Math.max(0, Math.round(v)))
    if (this.celebrationLevel === clamped) return
    this.celebrationLevel = clamped
    localStorage.setItem(CELEBRATION_KEY, String(clamped))
    this.notify()
  }

  /** Used only by createAppState() during boot.
   *
   *  STILL REJECTS ON FAILURE (P6 L1), unlike every other path into
   *  loadMachine. main.ts's boot try/catch is the app's only "Couldn't load
   *  Pinball Genie" surface; if this resolved quietly the visitor would get a
   *  mounted shell with no machine, no goals, and a permanent "Loading…" —
   *  strictly worse than the message they get today. Everything AFTER boot has
   *  a loaded machine to fall back to and a library UI to show the error in,
   *  which is why those paths resolve instead. */
  async bootMachine(m: Machine): Promise<void> {
    await this.loadMachine(m)
    const failure = this.machineError
    if (failure && this.machine?.id !== m.id) throw new Error(failure.message)
  }

  async selectMachine(m: Machine): Promise<void> {
    if (this.machine?.id === m.id) {
      // Re-picking the machine already loaded is a no-op with one job left to
      // do: clear the wreckage of a PREVIOUS failed switch. Without this, the
      // sequence "on Jaws → tap Godzilla → it fails → tap Jaws" leaves an
      // error banner about Godzilla sitting over a perfectly healthy Jaws.
      // Bumping the generation also cancels an in-flight load of some third
      // machine — the visitor just told us which one they want.
      if (this.machineError || this.machineLoading) {
        this.loadGeneration += 1
        this.machineLoading = false
        this.machineError = null
        this.notify()
      }
      return
    }
    await this.loadMachine(m)
  }

  select(g: Goal): void {
    if (this.selectedGoal?.id === g.id) return
    this.selectedGoal = g
    this.stepIndex = 0
    this.highlightMode = 'auto'
    this.routeStartedAt = performance.now()
    this.notify()
  }

  clearSelection(): void {
    this.selectedGoal = null
    this.stepIndex = 0
    this.highlightMode = 'auto'
    this.notify()
  }

  nextStep(): void {
    const goal = this.selectedGoal
    if (!goal) return
    this.stepIndex = Math.min(this.stepIndex + 1, goal.steps.length - 1)
    this.notify()
  }

  prevStep(): void {
    this.stepIndex = Math.max(this.stepIndex - 1, 0)
    this.notify()
  }

  goToStep(i: number): void {
    const goal = this.selectedGoal
    if (!goal) return
    this.stepIndex = Math.min(Math.max(i, 0), goal.steps.length - 1)
    this.notify()
  }

  restartGoal(): void {
    if (!this.selectedGoal) return
    this.stepIndex = 0
    this.highlightMode = 'auto'
    this.routeStartedAt = performance.now()
    this.notify()
  }

  pauseHighlight(): void {
    if (!this.selectedGoal || this.highlightMode === 'manual') return
    this.highlightMode = 'manual'
    this.notify()
  }

  resumeHighlight(): void {
    if (this.highlightMode === 'auto') return
    this.highlightMode = 'auto'
    this.routeStartedAt = performance.now()
    this.notify()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }
}

/** What a `?machine=…&goal=…` URL asked for. `machine` is already RESOLVED
 *  against the catalog (null = absent, unknown, or hostile); `goalId` is the
 *  raw parameter, because at parse time no goals are loaded to check it
 *  against — see parseDeepLink's own note on why that is safe. */
export interface DeepLink {
  machine: Machine | null
  goalId: string | null
}

/**
 * Parses the boot deep link out of a query string. PURE — takes the search
 * string rather than reading window.location, and touches no storage, so the
 * hostile-input cases are directly testable (exported for exactly that
 * reason, the same way readTrimPref/trimStorageKey above are).
 *
 * `machine` is validated here because the catalog is in hand: an id that is
 * not a machine resolves to null and the caller falls back to the stored/
 * default machine, which is what shipped for `?machine=` in 2026-07-31.
 *
 * `goal` CANNOT be validated here — the machine's goals arrive with its
 * GameData, one fetch later — so this returns the raw string and the caller
 * matches it against the loaded `goals` by id. That is safe because the value
 * is only ever COMPARED, never rendered, never stored, and never interpolated
 * into markup or a URL: `?goal=<script>alert(1)</script>` matches no goal id
 * and is dropped on the floor, silently, the same as `?goal=banana`.
 *
 * PARSE-ONLY, both parameters: nothing here or downstream ever writes a goal
 * back into the address bar. The URL is an entry point, not a state mirror
 * (the design pass's "deep links parse-only" default) — a history entry per
 * step tap is not something anyone asked for.
 *
 * Never throws: a malformed query string is a thing a stranger can hand a
 * visitor, and it must not be able to stop the app from booting.
 */
export function parseDeepLink(search: string, machines: readonly Machine[]): DeepLink {
  try {
    const params = new URLSearchParams(search)
    const machineId = params.get('machine')
    const goalId = params.get('goal')
    return {
      machine: (machineId ? machines.find((m) => m.id === machineId) : undefined) ?? null,
      // Empty/whitespace-only is "not asked for", not "asked for nothing".
      goalId: goalId && goalId.trim() ? goalId : null,
    }
  } catch {
    return { machine: null, goalId: null }
  }
}

/** Boots AppState: fetches the catalog, restores the last-selected machine
 *  from localStorage (if any), and loads that machine's GameData before
 *  resolving. ballPosition is always 'any' (see header note) — nothing to
 *  restore there anymore, including any legacy `pinballgenie.ballPosition`
 *  key a returning user's browser might still have from before the BALL AT
 *  picker was removed; it's simply never read. */
export async function createAppState(): Promise<AppState> {
  const machines = await fetchCatalog()
  if (machines.length === 0) throw new Error('catalog.json is empty')
  const state = new AppStateImpl(machines)

  // `?machine=<slug>` — the deep link every Phase 4 guide page's call-to-action
  // uses ("Open Gorgar in the Pinball Genie app →").
  //
  // WHY THIS EXISTS (2026-07-31). The 62 guide pages shipped that link before
  // anything read the parameter, so EVERY one of them dropped the visitor on
  // Jaws — catalog.json[0] — no matter which machine's guide they had just
  // read. That silently broke the entire point of the SEO work: someone
  // searches "world cup soccer pinball rules", reads our guide, taps through,
  // and lands on the wrong machine. It went unnoticed in testing because the
  // obvious thing to try is `?machine=jaws`, which "works" by coincidence.
  //
  // Takes priority over the stored id (an explicit link beats last session's
  // leftovers) and is persisted, so a refresh or a later visit keeps it.
  // Validated against the real catalog before use: an unknown or hostile slug
  // falls through to the normal path rather than throwing or being trusted.
  // Guarded (P6 L6): every OTHER localStorage read in this file already falls
  // back on a throw, but this one sits on the boot path — a browser that
  // refuses storage access (older iOS private mode throws on the getter itself,
  // not just on write) would take the whole app down with "Couldn't load
  // Pinball Genie" rather than simply forgetting which machine was last open.
  let savedMachineId: string | null = null
  try {
    savedMachineId = localStorage.getItem(MACHINE_KEY)
  } catch {
    /* storage unavailable — boot the default machine */
  }
  // P7a (2026-08-14): the parse moved into the exported, pure parseDeepLink()
  // above, which also reads `goal` — see the goal-selection block after
  // bootMachine below, and that function's own comment for the hostile-input
  // contract. Behaviour for `?machine=` is unchanged: an explicit link beats
  // the stored id and is persisted, an unknown one falls through. The
  // `typeof window` guard keeps the tolerance the try/catch this replaced had:
  // no environment this ships in lacks `window`, but a boot path is the last
  // place to find out otherwise.
  const link = parseDeepLink(typeof window === 'undefined' ? '' : (window.location?.search ?? ''), machines)
  if (link.machine) {
    try {
      localStorage.setItem(MACHINE_KEY, link.machine.id)
    } catch {
      /* storage unavailable — the link still opens this machine, just not next time */
    }
  }
  const initialMachine = link.machine ?? machines.find((m) => m.id === savedMachineId) ?? machines[0]!

  // Shot Coach prefs (2026-07-28): restored with validation — an
  // unrecognized/corrupt value (or a key from before this feature existed)
  // falls back to the documented default rather than propagating garbage
  // into OverlayOpts.
  state.trailStyle = readTrailStylePref()
  state.ballTracer = readBoolPref(BALL_TRACER_KEY, true)
  // Feature 8 (2026-08-11, phase A15): default true ("today's exact
  // behavior" when never set) — same validated-restore shape as ballTracer
  // just above (readBoolPref's own doc comment has the shared contract).
  state.shotLines = readBoolPref(SHOT_LINES_KEY, true)
  // Feature 7 (2026-08-11, phase A14): default 1 ("today's burst was ON by
  // default"), same validated-restore shape as the two prefs above —
  // readCelebrationLevel's own doc comment has the boolean->level migration.
  state.celebrationLevel = readCelebrationLevel()
  // P6 L1 (Machine Library): both lists are validated against THIS catalog as
  // they are read (readMachineIdList's own doc comment) — a stored id whose
  // machine has since left the catalog is dropped here, not rendered as a card
  // that 404s when tapped. Restored BEFORE bootMachine so the boot load's own
  // rememberRecent() prepends onto the restored list instead of starting a
  // fresh one and wiping the visitor's history on every launch.
  const catalogIds = new Set(machines.map((m) => m.id))
  state.recentMachineIds = readMachineIdList(RECENT_MACHINES_KEY, catalogIds, RECENT_MACHINES_CAP)
  state.pinnedMachineIds = readMachineIdList(PINNED_MACHINES_KEY, catalogIds)

  await state.bootMachine(initialMachine)

  // `?goal=<id>` (P7a, 2026-08-14) — the second half of the deep link, and the
  // reason the guide pages can now link a SPECIFIC goal into the app rather
  // than only a machine (app/scripts/gen-guides.mjs wraps each goal title in
  // one of these). Resolved AFTER the boot load because the goals only exist
  // once that machine's GameData has landed.
  //
  // Anything that does not match a loaded goal id — a goal from another
  // machine, a goal that has since been renamed, a string a stranger crafted
  // — is ignored SILENTLY: the visitor gets the machine they asked for, on the
  // goal list, which is a good place to be. An error message about a goal id
  // would be noise about something they never typed.
  //
  // select() puts the app on that goal's DETAIL screen (mountApp renders
  // whatever state.selectedGoal says on its first render), which is the point:
  // the link lands on the steps, not on a list to search.
  if (link.goalId) {
    const linkedGoal = state.data?.goals.find((g) => g.id === link.goalId)
    if (linkedGoal) state.select(linkedGoal)
  }

  return state
}
