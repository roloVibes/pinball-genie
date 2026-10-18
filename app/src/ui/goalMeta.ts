// ui/goalMeta.ts — shared goal-category / difficulty-pips presentation
// metadata, factored out of app.ts so the non-AR Goals tab (app.ts) and the
// AR machine/goal sheets (ar/arview.ts) draw from one source instead of
// duplicating category order/colors and pips formatting. See DESIGN-NOTES.md:
//   §2 "Goal sheet" — "Sections in fixed category order... matches
//   app.ts's existing goal-list grouping — confirm order matches exactly,
//   don't re-derive."
//   §3 "Design tokens" — CATEGORY colors (already `--cat-*` in styles.css).
//
// clampDifficulty/pipsText are moved verbatim from app.ts (behavior
// unchanged — the non-AR Goals tab's rendering is byte-for-byte identical
// after this refactor). pipsTextWithEmpty is NEW: the AR goal sheet's pip
// format per DESIGN-NOTES §2.8 is filled+empty circles
// (`'●'.repeat(d) + '○'.repeat(max(0,3-d))`, confirmed against the raw
// `Pinball Genie AR.dc.html`'s `pips:` line), which differs from the
// existing Goals-tab format (filled-only, no empty circles) — a real
// discrepancy between the design and the shipped non-AR UI. Per this
// project's ground rules ("keep the non-AR tabs working exactly as they
// are"), the existing `pipsText` is NOT changed to match the design; a
// second function carries the AR-only format instead.
//
// 2026-07-13: BALL_POSITIONS/BALL_POSITION_SHORT_LABEL (BALL AT chip
// label metadata) removed along with the BALL AT selector itself — see
// state.ts's/app.ts's header notes.
//
// 2026-08-10 (phase A3, trim/MODEL selector): machineHasVariants,
// goalVisibleForTrim, and goalReferencesPremiumLe join isPathless as shared,
// single-source-of-truth predicates over the machine/goal data shape — see
// each function's own doc comment. stepProvenance's `trim` parameter is no
// longer hardcoded (see its doc comment's own A3 update).

import type { AltMode, GameData, Goal, GoalCategory, GoalStep, Shot } from '../models'
import { feedForTrim, isShotVisible, resolveFeedUV, resolveFlipperShot } from '../overlay/shotgeom'

export const CATEGORY_ORDER: GoalCategory[] = [
  'skillshot',
  'combo',
  'multiball',
  'mode',
  'multiplier',
  'wizard',
  'strategy',
  // These two are last on purpose: they are the most surprising content, so
  // they read as a payoff at the end of a machine's goals rather than as noise
  // up top. 'progression' sits before 'secret' because it describes something
  // the machine tells you about (pick a character) while a secret is something
  // it never mentions at all — increasing order of hiddenness.
  'progression',
  'secret',
]

export const CATEGORY_META: Record<GoalCategory, { label: string; color: string }> = {
  skillshot: { label: 'Skill Shots', color: 'var(--cat-skillshot)' },
  combo: { label: 'Combos', color: 'var(--cat-combo)' },
  multiball: { label: 'Multiball', color: 'var(--cat-multiball)' },
  mode: { label: 'Modes', color: 'var(--cat-mode)' },
  multiplier: { label: 'Multipliers', color: 'var(--cat-multiplier)' },
  wizard: { label: 'Wizard', color: 'var(--cat-wizard)' },
  strategy: { label: 'Strategy', color: 'var(--cat-strategy)' },
  progression: { label: 'Progression', color: 'var(--cat-progression)' },
  secret: { label: 'Secrets', color: 'var(--cat-secret)' },
}

/**
 * Whether `goal` has no playfield route to draw (2026-07-31).
 *
 * THE ONE PLACE this test lives. A pathless goal is one whose instructions are
 * prose rather than shots — "hold both flippers in attract mode", "cycle the
 * right flipper to pick your class". See `Goal.instructions` in models.ts for
 * why those cannot be expressed as `steps` without either dangling or lying.
 *
 * Callers must branch on THIS, not on `instructions` being present, so that a
 * data file which somehow carries both stays predictable: `steps` wins, and
 * the goal is treated as a normal routed goal.
 */
export function isPathless(goal: Goal): boolean {
  return goal.steps.length === 0
}

/** The prose lines for a pathless goal, or [] if it has none / isn't pathless. */
export function instructionsFor(goal: Goal): string[] {
  if (!isPathless(goal)) return []
  return goal.instructions ?? []
}

/**
 * The chip text for an `altMode` value (dataset schema v7). 'VIDEO MODE'
 * rather than a bare 'VIDEO' because the noun on the machine is the mode, not
 * the medium; MENU and RULESET are already the nouns.
 *
 * A Record over the union, so adding a fourth AltMode is a TYPE ERROR here
 * rather than a chip that silently renders empty.
 */
export const ALT_MODE_LABEL: Record<AltMode, string> = {
  video: 'VIDEO MODE',
  menu: 'MENU',
  ruleset: 'RULESET',
}

/**
 * The machine's ALT MODES collection: every goal carrying an `altMode` flag,
 * in DATASET ORDER (the same order the Goals tab and the guide page walk, so
 * the collection reads as a subset of a list the player has already seen
 * rather than a re-sorted third opinion).
 *
 * THE ONE PLACE THIS TEST LIVES — isPathless's own precedent. Both the Study
 * rail's conditional pill and the sheet body ask this, and a pill shown by one
 * rule and filled by another is how a pill that opens nothing ships.
 *
 * NOT trim-filtered: an alternate mode is a property of the RULESET, and no
 * goal in this corpus carries a trim of its own. The MODEL switch changes
 * which shots are on the field, never which games the code can play.
 */
export function altModeGoals(data: GameData | null | undefined): Goal[] {
  if (!data) return []
  return data.goals.filter((g) => !!g.altMode && g.altMode in ALT_MODE_LABEL)
}

// ---------------------------------------------------------------------------
// GOAL DEPENDENCIES (dataset schema v8, 2026-08-15) — Goal.requires /
// Goal.requiresNote. Same discipline as isPathless above: the rule lives here
// once, and both surfaces that render it (the Goals tab's detail line in
// app.ts, the Map tab's skill-shot carousel in overlay/map2d.ts) read from
// these helpers rather than each re-deriving "what does this goal depend on".
// ---------------------------------------------------------------------------

/** The goals `goal` depends on, RESOLVED against `data` and in the order the
 *  data lists them — unresolvable ids are dropped, never rendered as a bare
 *  id. (validate-machines.py errors on a dangling id, so a drop here means a
 *  file that never went through the gate; naming a goal the machine doesn't
 *  have would be worse than saying nothing.) */
export function requiredGoals(goal: Goal, data: GameData | null | undefined): Goal[] {
  const ids = Array.isArray(goal.requires) ? goal.requires : []
  if (ids.length === 0 || !data) return []
  const byId = new Map(data.goals.map((g) => [g.id, g]))
  return ids.map((id) => byId.get(id)).filter((g): g is Goal => !!g)
}

/** Whether `goal` states a prerequisite of any kind — a required goal, or a
 *  `requiresNote` standing alone (models.ts: a threshold has no goal to point
 *  at). Deliberately does NOT resolve ids: this answers "does the data claim
 *  this is gated", which is the question the detail view asks before deciding
 *  whether to render a line at all. */
export function hasDependency(goal: Goal): boolean {
  return (Array.isArray(goal.requires) && goal.requires.length > 0) || !!goal.requiresNote?.trim()
}

/** Title segments a dependency chip drops before picking a short name: the
 *  corpus writes a ladder rung as "<what it is> — <which rung>: <flavour>"
 *  ("Skill Shot — Level 1: Light Plunge"), and on a chip that already says
 *  REQUIRES, inside a carousel that already says SKILL SHOT, the first
 *  segment is the one word the reader has. */
const GENERIC_TITLE_SEGMENT = /^skill\s*shots?$/i

/** The short name a dependency chip uses for a goal — the first meaningful
 *  segment of its title, splitting on the separators this corpus's titles
 *  actually use (em/en dash, `--`, colon, middot, pipe). "Skill Shot — Level
 *  1: Light Plunge" and "Skill Shot -- Level 1" both give "Level 1"; a title
 *  with no separators, or one made only of generic segments, comes back
 *  whole rather than empty. */
export function shortGoalName(title: string): string {
  const segments = title
    .split(/\s*(?:—|–|--|:|·|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  const meaningful = segments.filter((s) => !GENERIC_TITLE_SEGMENT.test(s))
  return meaningful[0] ?? segments[0] ?? title.trim()
}

/**
 * The Map readout's dependency chip — "REQUIRES LEVEL 1" — or null when the
 * goal has no resolvable prerequisite goal.
 *
 * ` + ` joins a fan-in, not ` · `: the middot is this app's neutral separator
 * (the readout's own provenance/technique line uses it) and would read as
 * "one of these", where `requires` means all of them.
 *
 * GOALS ONLY, deliberately. A `requiresNote` standing alone is a sentence, and
 * the Map pill is a shouted one-line browse aid — the note gets its room on
 * the Goals tab's detail line (unlocksAfterText below), which is where the
 * goal's own prose already lives.
 */
export function requiresChipText(goal: Goal, data: GameData | null | undefined): string | null {
  const names = requiredGoals(goal, data).map((g) => shortGoalName(g.title).toUpperCase())
  return names.length > 0 ? `REQUIRES ${names.join(' + ')}` : null
}

/** The SPOKEN mirror of requiresChipText — "Requires Level 1", sentence case.
 *  Same derivation, deliberately: the pill is a passive element a screen
 *  reader is never told to re-read, so the Map tab speaks its own readout
 *  (P9), and a chip only the sighted user gets is a half-built feature. Screen
 *  readers spell out or shout all-caps runs depending on the voice, which is
 *  why this is not just the chip string. */
export function requiresSpokenText(goal: Goal, data: GameData | null | undefined): string | null {
  const names = requiredGoals(goal, data).map((g) => shortGoalName(g.title))
  return names.length > 0 ? `Requires ${andList(names)}` : null
}

/** Joins a list the way the corpus writes one: "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The Goals-tab detail chain line — "Unlocks after: <title(s)>", FULL titles
 *  (there is room here, and the detail screen is where a player goes to find
 *  out exactly which goal is meant). Null when nothing resolves, so a goal
 *  carrying only a `requiresNote` renders the note alone. */
export function unlocksAfterText(goal: Goal, data: GameData | null | undefined): string | null {
  const titles = requiredGoals(goal, data).map((g) => g.title)
  return titles.length > 0 ? `Unlocks after: ${andList(titles)}` : null
}

/**
 * `list` reordered so a dependency ladder reads in ladder order: every goal
 * that takes part in an in-list `requires` relationship first, in topological
 * order (a prerequisite always precedes what it gates), then everything
 * unchained in the order the data lists it.
 *
 * WHY THE CAROUSEL NEEDS THIS. The Map tab's ‹ › skill-shot browse walked the
 * dataset's own order, which put Jaws' three plunge levels in the right
 * sequence by coincidence rather than by rule — nothing failed if a later edit
 * moved Level 3 above Level 1, and nothing would have ordered a machine whose
 * file happened to list its ladder out of order.
 *
 * ONLY IN-LIST EDGES COUNT. A `requires` pointing at a goal outside `list`
 * (the carousel is skill-shots-only; a mode may well be gated on a multiball)
 * cannot be ordered against anything here, so it leaves the goal unchained
 * rather than pretending to place it.
 *
 * STABLE AND TOTAL. Ties break on dataset order, so the same file always
 * produces the same carousel; and nothing is ever dropped — a cycle (which
 * validate-machines.py errors on, so it should never reach here) leaves its
 * members unemitted by the topological pass and they are appended in dataset
 * order rather than vanishing from the browse.
 */
export function orderByLadder(list: readonly Goal[]): Goal[] {
  const index = new Map(list.map((g, i) => [g.id, i]))
  const deps = new Map<string, string[]>()
  for (const g of list) {
    const inList = (Array.isArray(g.requires) ? g.requires : []).filter((id) => index.has(id) && id !== g.id)
    if (inList.length > 0) deps.set(g.id, inList)
  }
  const gated = new Set(deps.keys())
  const prerequisite = new Set<string>()
  for (const ids of deps.values()) for (const id of ids) prerequisite.add(id)
  const chained = list.filter((g) => gated.has(g.id) || prerequisite.has(g.id))
  const unchained = list.filter((g) => !gated.has(g.id) && !prerequisite.has(g.id))

  // Kahn over the chained subset, always taking the lowest dataset index among
  // the currently-ready goals — that is what makes ties deterministic.
  const remaining = new Map(chained.map((g) => [g.id, new Set((deps.get(g.id) ?? []).filter((id) => index.has(id)))]))
  const emitted: Goal[] = []
  const done = new Set<string>()
  let progress = true
  while (remaining.size > 0 && progress) {
    progress = false
    const ready = [...remaining.entries()]
      .filter(([, need]) => [...need].every((id) => done.has(id)))
      .map(([id]) => id)
      .sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
    for (const id of ready) {
      const g = chained.find((x) => x.id === id)
      if (g) emitted.push(g)
      done.add(id)
      remaining.delete(id)
      progress = true
    }
  }
  // Cycle survivors (data corruption — see the doc comment): keep them, in
  // dataset order, rather than silently shortening the carousel.
  const stranded = chained.filter((g) => remaining.has(g.id))
  return [...emitted, ...stranded, ...unchained]
}

/**
 * THE CHARACTER RULE (2026-08-15, owner: the progression layer gets its own
 * door in Study), as a per-goal test: a 'progression' goal with no playfield
 * route. Those two conditions are the whole definition, and each one is doing
 * work:
 *
 *   * `category === 'progression'` is the dataset's own word for the layer
 *     this door is about — what you PICK and what you CARRY: the hero you
 *     choose, the gear you bank, the XP and the account progress that outlives
 *     a game. It is a field the corpus already authors (goalMeta's
 *     CATEGORY_ORDER has carried it since the categories existed), not a new
 *     flag this feature asks the data to grow.
 *   * `isPathless` is what makes the door NECESSARY rather than merely tidy.
 *     A routed progression goal is already fully served: the Shots map draws
 *     it and the Goals tab walks its steps. A PATHLESS one has no route to
 *     draw, so before this door the Shots tab could only hand it back to the
 *     Goals tab — the material had no home of its own anywhere in the app.
 *
 * WHAT IS DELIBERATELY NOT IN, and both exclusions were measured rather than
 * assumed:
 *
 *   * 'secret' CHARACTER SELECTS. Several machines author the same choice
 *     TWICE — dnd carries `class-select-flipper-cycle` (secret) beside
 *     `character-and-city-select` (progression), and tmnt carries
 *     `pregame-turtle-select` (secret) beside `turtle-select-perks`
 *     (progression). Taking both would put two cards about one decision in a
 *     five-card sheet. A secret is also, by CATEGORY_ORDER's own note, "something
 *     the machine never mentions at all" — the opposite of a system it asks you
 *     to engage with, which is what this door collects.
 *   * ACHIEVEMENTS, of any source. They are a different feature with its own
 *     tab and its own server-backed per-user state (ui/achievements.ts); this
 *     function reads `data.goals` and nothing else, so there is no path by
 *     which one could arrive here.
 *
 * NOT TRIM-FILTERED, for altModeGoals' reason: none of this content is a shot
 * on the field, so no MODEL setting can take it away.
 */
export function isCharacterGoal(goal: Goal): boolean {
  return goal.category === 'progression' && isPathless(goal)
}

/**
 * The machine's CHARACTER collection: every goal matching isCharacterGoal, in
 * DATASET ORDER (altModeGoals' rule, for altModeGoals' reason — the sheet
 * reads as a subset of a list the player has already met on the Goals tab
 * rather than a re-sorted third opinion).
 *
 * THE ONE PLACE THIS TEST LIVES, in the two shapes its three callers need: the
 * Study rail's conditional pill and the CHARACTER sheet body both ask this
 * COLLECTION, and the Shots tab's goal-sheet row asks the MEMBER test above —
 * and the collection is defined in terms of the member test, so the three
 * surfaces cannot drift into disagreeing about what a character goal is. A
 * pill shown by one rule and filled by another is how a pill that opens
 * nothing ships (altModeGoals' own note); a row retargeted by a third rule is
 * how a row that jumps to an empty door ships.
 */
export function characterGoals(data: GameData | null | undefined): Goal[] {
  if (!data) return []
  return data.goals.filter(isCharacterGoal)
}

/**
 * Whether `data` has any model-specific (trim-restricted) content — a
 * Pro/Premium-LE VARIANCE signal, not a per-shot visibility test (see
 * shotgeom.ts's isShotVisible for that). True iff any shot, or (dataset
 * schema v5) any playfields[] zone, carries a `trim` that is neither
 * absent/null nor 'all' — schema v5's own "absent/'all' = present on every
 * model" contract (models.ts Shot.trim / PlayfieldZone.trim doc comments).
 *
 * Used to decide whether the Map tab's MODEL segmented control is worth
 * showing at all — a machine with no variants has nothing for it to switch
 * between. THE ONE PLACE this test lives (isPathless's own precedent above):
 * shared by overlay/map2d.ts (control visibility) and
 * tests/trim-filter.test.mjs.
 */
export function machineHasVariants(data: GameData | null | undefined): boolean {
  if (!data) return false
  const restricted = (trim: string | null | undefined): boolean => !!trim && trim !== 'all'
  if (data.shots.some((s) => restricted(s.trim))) return true
  return (data.playfields ?? []).some((z) => restricted(z.trim))
}

export function clampDifficulty(d: number): number {
  return Math.min(3, Math.max(1, Math.round(d)))
}

/** Filled-only pips — existing Goals-tab format (app.ts), unchanged. */
export function pipsText(difficulty: number): string {
  return '●'.repeat(clampDifficulty(difficulty))
}

/** Filled+empty pips — AR goal sheet format (DESIGN-NOTES §2.8 / raw
 *  `pips: '●'.repeat(d) + '○'.repeat(max(0,3-d))`). */
export function pipsTextWithEmpty(difficulty: number): string {
  const d = clampDifficulty(difficulty)
  return '●'.repeat(d) + '○'.repeat(Math.max(0, 3 - d))
}

// ---------------------------------------------------------------------------
// Trim (MODEL) filtering — phase A3, 2026-08-10. Two DIFFERENT predicates for
// two DIFFERENT surfaces, deliberately: the Map tab HIDES a goal it cannot
// fully draw (goalVisibleForTrim); the Goals tab never hides, it CHIPS a goal
// that touches premium-le content (goalReferencesPremiumLe). Conflating the
// two would either hide goals from the Goals tab's browse-everything list
// (wrong — see app.ts's chip treatment) or offer un-drawable goals on the
// Map (wrong — see map2d.ts's buildGoalSheetBody).
// ---------------------------------------------------------------------------

/**
 * Whether `goal`'s playfield route is fully makeable under `trim` — every
 * step's shot resolves and is visible there (shotgeom.ts's isShotVisible).
 * Used by the Map tab's goal picker (overlay/map2d.ts's buildGoalSheetBody)
 * to OMIT a goal whose route needs a shot the current MODEL doesn't have —
 * offering it would select a goal whose drawn route is missing a target.
 * Map-only: the Goals tab does NOT hide (see goalReferencesPremiumLe's chip
 * below instead — app.ts renderGoalRow). A step whose shot id doesn't
 * resolve at all contributes nothing to this test (a dangling reference is a
 * data bug, not a trim question — see pathless-goals.test.mjs's own
 * dangling-step check).
 */
export function goalVisibleForTrim(goal: Goal, shotsById: Map<string, Shot>, trim: 'pro' | 'premium-le'): boolean {
  return goal.steps.every((step) => {
    const shot = shotsById.get(step.shot)
    return !shot || isShotVisible(shot, trim)
  })
}

/**
 * Whether ANY of `goal`'s steps resolves to a shot whose trim is exactly
 * 'premium-le' — the Goals tab's PREM/LE chip derivation (app.ts
 * renderGoalRow). Deliberately narrower than machineHasVariants' "not in
 * (null,'all')" test above: the chip specifically means "this goal touches
 * premium-le content", so it checks the one real marker value the dataset
 * uses (models.ts Shot.trim doc comment: measured 2026-08-10, only 'all' and
 * 'premium-le' ever appear) rather than "any non-'all' string". An
 * unresolvable step shot id contributes nothing (never guess).
 */
export function goalReferencesPremiumLe(goal: Goal, shotsById: Map<string, Shot>): boolean {
  return goal.steps.some((step) => shotsById.get(step.shot)?.trim === 'premium-le')
}

// ---------------------------------------------------------------------------
// Choreography provenance + technique chips (phase B1/B2, 2026-08-10) —
// schema v5's ease layer (GoalStep.technique/plunge/plungeTo/flipper,
// Shot.feeds/feedsByTrim/flipper/backhand). Both surfaces (app.ts's Goals-tab
// step rows, overlay/map2d.ts's step readout) render from these ONE set of
// pure helpers rather than each re-deriving the rule, same discipline as
// isPathless() above.
// ---------------------------------------------------------------------------

/**
 * Choreography provenance line for a routed step — "FROM RIGHT FLIPPER ·
 * LEFT-RAMP RETURN": names the flipper this step is shot from and, when
 * resolvable, the shot whose feed delivers the ball there, so a step teaches
 * WHERE THE BALL COMES FROM, not just where it's going next.
 *
 * Requires BOTH an authored flipper (`step.flipper ?? its shot's own
 * .flipper` — never guessed from geometry) AND an inbound feed authored on
 * the PREVIOUS step: that step's own `.feeds` override, else its shot's
 * feedForTrim resolution (step override -> per-trim override -> base feeds;
 * see overlay/shotgeom.ts). No previous step, no authored flipper, or no
 * feed authored at all on the previous step -> null (never guess; first
 * steps never get a line — their origin is the launch/plunger, already
 * drawn).
 *
 * A feed that NAMES a shot (`FeedRef.shot`) is trusted for the "<NAME>
 * RETURN" suffix even when that name doesn't resolve against `shotsById` —
 * it falls back to the bare flipper line rather than dropping the whole
 * line, since SOME feed was authored and the flipper side isn't derived from
 * this lookup anyway. A feed with coordinates only must have its landing
 * side agree with the authored flipper (FeedRef's own x<0.5-left/else-right
 * convention, models.ts) or the line is dropped entirely — asserting "FROM
 * X FLIPPER" against a feed that visibly lands on the other side would be a
 * guess, not a fact.
 *
 * `trim` (threaded through as of phase A3, 2026-08-10 — this used to be a
 * hardcoded 'premium-le' placeholder) is the caller's actual selected MODEL:
 * app.ts's renderGoalDetail and overlay/map2d.ts's step readout both pass
 * state.trim. Defaults to 'premium-le' when omitted (this app's pre-A3
 * default render, and the same back-compat-safe fallback state.ts's own
 * `trim` field defaults to), matching feedForTrim's own resolution order.
 *
 * Feature 1 extension (2026-08-11): the authored flipper value may instead
 * name a flipper-typed SHOT ID (shotgeom.ts's resolveFlipperShot — the same
 * mechanism the route/background-art renderers use for a shot actually made
 * from an upper/mini flipper, e.g. Jaws' harpoon lane from the mid-right
 * mini flipper). When it resolves, the line names THAT SHOT directly ("FROM
 * MID-RIGHT MINI FLIPPER") instead of a bare side, and its SIDE (for the
 * coordinates-only-feed agreement check below) is inferred the same way
 * resolveShootingAnchor infers a deck bat's side: its own authored
 * `bat.side`, else which half of the playfield it sits in.
 */
export function stepProvenance(
  goal: Goal,
  stepIndex: number,
  shotsById: Map<string, Shot>,
  trim: 'pro' | 'premium-le' = 'premium-le',
): string | null {
  if (stepIndex <= 0 || stepIndex >= goal.steps.length) return null
  const step = goal.steps[stepIndex]
  const prevStep = goal.steps[stepIndex - 1]
  if (!step || !prevStep) return null

  const shot = shotsById.get(step.shot)
  const flipperRaw = step.flipper ?? shot?.flipper
  const flipper: 'left' | 'right' | null = flipperRaw === 'left' || flipperRaw === 'right' ? flipperRaw : null
  const namedFlipperShot = resolveFlipperShot(flipperRaw, shotsById)
  const effectiveSide: 'left' | 'right' | null =
    flipper ??
    (namedFlipperShot
      ? namedFlipperShot.bat?.side === 'left' || namedFlipperShot.bat?.side === 'right'
        ? namedFlipperShot.bat.side
        : namedFlipperShot.x < 0.5
          ? 'left'
          : 'right'
      : null)
  if (!effectiveSide) return null

  const prevShot = shotsById.get(prevStep.shot)
  if (!prevShot) return null

  const feedRef = feedForTrim(prevShot, prevStep.feeds, trim)
  if (!feedRef) return null // nothing authored at all on the previous step -- never guess

  const flipperLabel = namedFlipperShot ? `FROM ${namedFlipperShot.name.toUpperCase()}` : `FROM ${effectiveSide.toUpperCase()} FLIPPER`

  if (feedRef.shot != null) {
    // A named feed is trusted regardless of geometry -- an authored link is
    // a stronger signal than a coordinate side-check. Falls back to the bare
    // flipper line (not null) when the name itself doesn't resolve: SOME
    // feed was authored, we just can't name where it lands.
    const namedShot = shotsById.get(feedRef.shot)
    return namedShot ? `${flipperLabel} · ${namedShot.name.toUpperCase()} RETURN` : flipperLabel
  }

  // Coordinates-only feed: only counts as this step's inbound feed when its
  // landing side actually agrees with the authored flipper -- otherwise the
  // line would assert a flipper side the feed's own landing contradicts.
  const feedUV = resolveFeedUV(feedRef, shotsById)
  if (!feedUV) return null
  const impliedSide: 'left' | 'right' = feedUV.x < 0.5 ? 'left' : 'right'
  return impliedSide === effectiveSide ? flipperLabel : null
}

/** One technique/plunge chip: `label` is what renders; `term` is the closed-
 *  vocabulary string (GoalStep.technique's entries) a future glossary
 *  deep-link would jump to — null for the DERIVED plunge chips (SOFT/FULL
 *  PLUNGE), which per GoalStep.technique's own doc comment are deliberately
 *  NOT part of that vocabulary (they derive from `plunge`/`plungeTo` so the
 *  chip and the data can never disagree, so there is no glossary term for
 *  "soft plunge" as a technique). */
export interface StepChip {
  label: string
  term: string | null
}

/**
 * Technique + derived-plunge chips for one step: `step.technique[]`
 * verbatim (closed vocabulary, models.ts — label is the vocab term upper-
 * cased with hyphens turned to spaces, e.g. 'late-flip' -> 'LATE FLIP')
 * PLUS a derived chip from `step.plunge` ('partial' -> 'SOFT PLUNGE', 'full'
 * -> 'FULL PLUNGE') — NEVER the reverse: plunge chips are derivation-only,
 * never read from `technique`, so the chip and the data can never disagree.
 * Derived chips always come LAST so authored technique reads first. No
 * technique and no plunge -> `[]`.
 */
export function stepChips(step: GoalStep): StepChip[] {
  const chips: StepChip[] = (step.technique ?? []).map((t) => ({
    label: t.toUpperCase().replace(/-/g, ' '),
    term: t,
  }))
  if (step.plunge === 'partial') chips.push({ label: 'SOFT PLUNGE', term: null })
  else if (step.plunge === 'full') chips.push({ label: 'FULL PLUNGE', term: null })
  return chips
}
