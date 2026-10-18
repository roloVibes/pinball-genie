// Data models — mirror of native Models.kt / Models.swift and the *_goals.json schema.
// The JSON files are the source of truth; these types describe them exactly.

/**
 * A reference to a point the ball feeds back into the lower playfield —
 * where a ramp/orbit/loop shot re-enters play (SPEC-PATHVIZ rule 7, dataset
 * schema v3). Every field is OPTIONAL and additive; older apps/datasets that
 * don't know about it simply never see it (fail-soft).
 *
 * Resolution: if `shot` is present AND resolves to a known shot id, it wins
 * over `x`/`y` outright; an unresolvable `shot` reference is treated as if
 * the whole FeedRef were absent (no extension drawn) — it does NOT fall
 * back to `x`/`y`.
 *
 * Conventions (identical on web/iOS/Android): LEFT_INLANE = (0.36, 0.10),
 * RIGHT_INLANE = (0.64, 0.10) are the usual feed points a machine's own
 * inlane shots model; "feed side" for a shot without an explicit ref is
 * x<0.5 -> left, else right.
 */
export interface FeedRef {
  x?: number
  y?: number
  shot?: string
  /** Optional loop-around waypoint (schema v5, rolo 2026-08-11): on the way
   *  to the feed point the ball physically WRAPS this element — Jaws' plunge
   *  coiling around the fishing-reel spinner before dropping at the mini
   *  flipper is the reference case. The renderer draws the continuation as a
   *  visible coil around this point instead of a plain arc. Same resolution
   *  rules as the outer ref: `shot` beats x/y; unresolvable = no loop. */
  loop?: { x?: number; y?: number; shot?: string } | null
}

/**
 * One raised (upper/mini) or sunken (lower) playfield — dataset schema v5
 * (2026-08-10, playfield-truth overhaul). Optional/additive and fail-soft
 * everywhere: a machine with no `playfields` renders exactly as before, and
 * apps that predate the field ignore it.
 *
 * All coordinates are MAIN-playfield UV. The unit square and the MapFn
 * contract are untouched — a zone is a labeled region of that square, not a
 * second coordinate space. Shots that live on a deck keep their true
 * flattened (x, y) and simply carry `Shot.playfield` naming this zone.
 *
 * `entries`/`exits` exist for the validator and the map art (entry chevrons,
 * plate labels), NOT for routing: the ball climbs onto a deck via the entry
 * shot's own `feeds` (rule 7 elevated legs), same as any other feed.
 */
export interface PlayfieldZone {
  id: string
  /** Display name, e.g. "Orca Deck", "Smith's Grove Sanitarium". */
  name: string
  /** 'upper' = raised deck; 'mini' = small raised mini-playfield;
   *  'lower' = below the main surface (drawn as a dashed inset window —
   *  you cannot shoot at this region directly from the main playfield). */
  kind: 'upper' | 'mini' | 'lower'
  /** Footprint on the main unit square. */
  bounds: { x: number; y: number; w: number; h: number }
  /** Same semantics as Shot.trim: absent/'all' = present on every model. */
  trim?: string | null
  /** Main-playfield shot ids whose feeds deliver the ball ONTO this zone. */
  entries?: string[] | null
  /** Where the ball lands back on the main playfield when it leaves. */
  exits?: FeedRef[] | null
}

export interface Shot {
  id: string
  name: string
  /** plunge | ramp | orbit | loop | lane | scoop | spinner | standup | target-bank | mech | bumpers | captive-ball */
  type: string
  /** Normalized playfield coords: x 0→1 left→right, y 0→1 flippers→back. */
  x: number
  y: number
  /** Which machine model has this shot: 'all' (every model) | 'premium-le'
   *  (Premium/LE only). The old '"all" | "core"' comment described values
   *  that never shipped — measured 2026-08-10: 3,284 shots 'all', 65
   *  'premium-le', nothing else. Base fields describe the PRO machine;
   *  premium-le content is additive on top. Read (at last) by the trim
   *  selector: visible ⇔ !trim || trim === 'all' || trim === selected. */
  trim: string
  notes?: string | null
  /** Ramp/orbit/loop crest (SPEC-PATHVIZ rule 7). Optional/additive — used
   *  ONLY when both `x` and `y` are finite numbers; a partial ({x} alone),
   *  malformed, or ref-shaped value is treated the same as absent (2026-07-29
   *  review, D5) — never resolved as a shot reference, never dropping the
   *  extension. When absent (or invalid) and a feed point resolves, one is
   *  SYNTHESIZED identically on every platform: with e = this shot's own
   *  (x,y) and f = the resolved feed point,
   *  `apex = (e.x + 0.25*(f.x - e.x), min(0.95, max(e.y + 0.22, f.y + 0.02)))`
   *  — the `max(..., f.y + 0.02)` term keeps the crest at/above the landing
   *  point for upper-playfield feeds (e.g. a Powerfield-style feed well above
   *  the usual ~0.10 down-feed); for a normal down-feeding ramp this is
   *  byte-identical to the pre-2026-07-29 `min(0.95, e.y + 0.22)`. */
  apex?: { x: number; y: number } | null
  /** Where the ball re-enters the lower playfield after this shot (rule 7).
   *  Optional/additive; a GoalStep's own `feeds` overrides this for that one
   *  step only. Activation gate is FEEDS PRESENCE, not `type === 'ramp'` —
   *  orbits/loops get the same treatment as pure data. */
  feeds?: FeedRef | null
  /** The flipper that habitually makes this shot ('left' | 'right') —
   *  SPEC-PATHVIZ rule 6. A GoalStep's own `flipper` beats this for that one
   *  step; otherwise this beats the geometric cross-flipper heuristic. */
  flipper?: string | null
  /** PlayfieldZone.id this shot lives on; absent = the main playfield
   *  (dataset schema v5). Routing to a shot on a zone that declares its own
   *  flipper bat(s) anchors at the DECK bat, never the main flippers. */
  playfield?: string | null
  /** For `type === 'flipper'` shots only: declared bat geometry (schema v5).
   *  When present it RETIRES the name-regex upper/mini-bat detection in
   *  map2d's drawPlayfieldArt for this shot; the regex survives only as the
   *  fallback for unauthored machines. `side` is which way the bat points
   *  when it is one of a facing pair; `size:'mini'` draws at half scale. */
  bat?: { side?: 'left' | 'right'; size?: 'full' | 'mini' } | null
  /** Per-model feed override (schema v5): resolution is
   *  `feedsByTrim[selectedTrim] ?? feeds`. Base `feeds` is the PRO truth, so
   *  in practice only a 'premium-le' key ever appears (Jaws' wave ramp: Pro
   *  wireform returns to the mini flipper; Premium/LE feeds the Orca deck).
   *  Keys are trim ids; values follow FeedRef's own resolution rules. */
  feedsByTrim?: Record<string, FeedRef | null> | null
  /** Flippers from which this shot can be BACKHANDED ('left'/'right'),
   *  ease-layer schema v5. Absent = unknown/not backhandable; authored only
   *  where rulesheet/tutorial evidence exists. Surfaced as a technique chip
   *  and in choreography copy, never guessed from geometry. */
  backhand?: ('left' | 'right')[] | null
  /**
   * A RAMP PLATE THE GAME RAISES AND LOWERS — its footprint on the playfield
   * (2026-08-15, additive). `w`/`h` are the plate's full width and depth in
   * UV, CENTRED on this shot's own (x, y); map2d's drawPlayfieldArt paints
   * that rectangle as faint background furniture (outline + rungs + a heavier
   * front lip), the same "derived from the machine's own data" rule every
   * other shape in that function follows.
   *
   * WHY IT EXISTS. A ramp mech that physically moves is a big object a player
   * has to see and time — Stranger Things' centre ramp swings in front of the
   * Demogorgon and changes what the centre shot does — and the insert
   * vocabulary can only draw it as one more ~7px arrow among its neighbours.
   * An object with real extent needs to be drawn with extent (rolo, on the
   * Stranger Things map: "in the middle theres a huge drop down ramp that
   * gets activated, the playfield should show that").
   *
   * THE AUTHORING RULE, because a footprint is geometry and geometry must be
   * attested: `w`/`h` are MEASURED off that machine's own playfield — its
   * manufacturer playfield photo, scale-checked against a feature whose real
   * size is known (Stranger Things: the 4-bank of drops measured 0.22 of the
   * cabinet width, i.e. ~4.5" of a 20.25" playfield, which is what a 4-bank
   * physically is) and cross-checked against the machine's own authored shot
   * coordinates. Never a guess, and never a value picked to make the drawing
   * look better. Absent (the overwhelming default) draws nothing at all, so
   * every machine that doesn't author one renders byte-identical.
   */
  flap?: { w: number; h: number } | null
}

export interface GoalStep {
  /** Shot id reference into GameData.shots. */
  shot: string
  action: string
  detail?: string | null
  /** Per-step diverter override for `Shot.feeds` (SPEC-PATHVIZ rule 7) —
   *  beats the target shot's own `feeds` for this step only. */
  feeds?: FeedRef | null
  /** Per-step override for `Shot.flipper` (SPEC-PATHVIZ rule 6) — beats the
   *  target shot's own `flipper` for this step only. */
  flipper?: string | null
  /** Plunge-strength hint for a plunger-origin step (2026-08-02). The lane
   *  router normally infers partial-vs-full from where the target sits, but
   *  geometry cannot know pull strength: James Bond's right orbit takes a
   *  FULL pull to coordinates the bands read as partial, and some lanes eject
   *  clear across the table. 'partial' forces the short die-in-the-lane
   *  route; 'full' forces the over-the-top route; absent = geometric bands. */
  plunge?: 'partial' | 'full' | null
  /** For `plunge: 'partial'` only (schema v5): the UV y where the ball dies
   *  in / exits the shooter lane — the physical variable a soft plunge
   *  controls. Jaws' three skill-shot strengths are partial@≈0.50 (light,
   *  falls into the pops), partial@≈0.38 (shorter, dies above the mini
   *  flipper), and full. Clamped to [0.10, 0.88] at draw time; absent keeps
   *  the router's existing `min(target.y + 0.06, 0.8)` exit. Ignored when
   *  `plunge` is 'full'/absent — it is a stop height, not a hint. */
  plungeTo?: number | null
  /** HOW the step is physically executed (ease-layer schema v5) — rendered
   *  as chips on the step pill and goal-detail rows, each opening its
   *  glossary entry. Closed vocabulary (validator-enforced):
   *  backhand | forehand | on-the-fly | from-cradle | early-flip |
   *  late-flip | hold-flipper | drop-catch | live-catch | dead-bounce |
   *  post-pass | tap-pass | nudge.
   *  Plunge strength is NOT in this vocabulary — SOFT/FULL PLUNGE chips
   *  derive from `plunge`/`plungeTo` so the two can never disagree. */
  technique?: string[] | null
  /** RARE authored exception (rolo's route-truth rule, 2026-08-11): true =
   *  the ball genuinely travels from the PREVIOUS step's target directly to
   *  this one without a flipper in between (feed-through / on-the-fly
   *  combo geometry). Default (absent/false) = every leg is flipper → ONE
   *  target: the renderer routes this step via its shooting flipper, and
   *  the ball's return between steps is the previous target's dotted feed
   *  line, not a target-to-target connector. "From flipper to a target is
   *  just one shot; rarely would it go flipper to target to target." */
  direct?: boolean | null
  /** Connector INTO this step. 'none' suppresses the drawn route leg (and
   *  arrowhead) leading to this step's target — the target still gets its
   *  ring, badge and marching highlight. For goals that mix a genuinely
   *  sequential opener with an any-order collection (rolo 2026-08-02: a
   *  multiball's lit jackpots are not a forced sequence — drawing
   *  target-to-target trajectories implies an order the game doesn't
   *  require). Goal.ordered === false is the whole-goal form. */
  link?: 'route' | 'none' | null
}

export type GoalCategory =
  | 'skillshot' | 'combo' | 'multiball' | 'mode' | 'multiplier' | 'wizard' | 'strategy'
  // 'secret' added 2026-07-31: pre-game flipper/start-button selections,
  // video modes, and other genuinely hidden features. These are the things a
  // player at a machine cannot discover by playing — which is precisely why
  // they belong in a study tool, and why they earn their own category rather
  // than being buried under 'mode' or 'strategy' where nobody would look.
  | 'secret'
  // 'progression' added 2026-07-31: character/class/side SELECTION, collectible
  // ladders, upgrade tiers, and item systems — mechanics where a choice or an
  // accumulation changes how the REST of the game plays (pick your adventurer
  // and every quest scores differently; collect teeth and the machine promotes
  // you a rank). Distinct from 'mode' (a mode is a thing you play and finish)
  // and from 'secret' (a secret is hidden; a progression system is usually
  // advertised on the display but its EFFECTS are undocumented in-game).
  | 'progression'

/**
 * An ALTERNATIVE to normal ball-in-play, as opposed to a part of it (dataset
 * schema v7, 2026-08-14). Owner: "in jaws, there are video game modes, I think
 * that should be its own button in learning like, alternate modes… I think a
 * lot of games have alternate modes and that should be its own button and info
 * in study mode."
 *
 * - `video` — a video-game-style mode played on the DISPLAY rather than with
 *   the ball on the playfield: video modes, trivia, video poker, backbox
 *   challenges. THE DISPLAY-VS-PHYSICAL LINE is the test, not the name: it
 *   qualifies when the mode is played entirely off the main playfield with the
 *   buttons/flippers driving a display (or a lamp/board surface — Safe
 *   Cracker's board game) and no ball is at risk. A physical-ball backbox or
 *   mini contraption (NBA Fastbreak's real ball at a backglass hoop, Champion
 *   Pub's jump-rope, Banzai Run's backglass field) is a PLAYFIELD FEATURE and
 *   carries no flag, however "backbox" it looks. A video mode may still be
 *   ROUTED — Attack from Mars, T2 and Star Wars all have a shot that starts
 *   theirs — because the route is how you get there, not what it is.
 * - `menu` — an interactive selection SURFACE outside normal ball-in-play
 *   flow: attract-mode hold-both-flippers challenge menus, game-start selects.
 *   THE CAMPAIGN-VS-CONTENT DISTINCTION decides the pre-game picks: a pick
 *   that swaps the playable CAMPAIGN or roster is an alternative to the
 *   standard game and is flagged (Evil Dead's Pick Your Movie swaps the whole
 *   story-mode roster); a pick that reskins or tunes the ONE standard campaign
 *   is customisation OF normal play and is NOT (song select, character/turtle/
 *   class/house/host picks). Dr. Who's Doctor select is flagged because the
 *   Doctor rewrites that ball's rules, not because you choose a Doctor.
 * - `ruleset` — a specific alternate way the WHOLE GAME plays, put on at the
 *   start rather than reached during play: competition/casual/novice/league/
 *   challenge rulesets. When one goal covers both the menu and the mode it
 *   launches, the goal's DOMINANT teachable content decides which of the two
 *   it gets.
 *
 * ABSENT IS THE NORM — most goals are normal play and carry nothing. Absence
 * is not "unclassified": it is the positive statement that this is the game
 * rather than an alternative to it, which is why the validator checks the
 * VALUE and never the presence.
 *
 * DUPLICATION IS BY DESIGN: a flagged goal keeps every surface it already
 * appears on (Goals tab, Map picker, guide page). The flag adds the ALT MODES
 * collection in the Study rail; it does not move anything.
 */
export type AltMode = 'video' | 'menu' | 'ruleset'

export interface Goal {
  id: string
  title: string
  category: GoalCategory
  /** Marks this goal as an ALTERNATIVE to normal ball-in-play — see AltMode.
   *  Optional/additive and fail-soft: absent on the overwhelming majority of
   *  goals, and an app that predates the field simply never sees it. */
  altMode?: AltMode | null
  summary: string
  /** 1..3 */
  difficulty: number
  reward?: string | null
  /** The playfield route. MAY BE EMPTY — see `instructions` below. */
  steps: GoalStep[]
  /**
   * Prose instructions for a PATHLESS goal — one that has no playfield route
   * to draw (2026-07-31).
   *
   * Every goal in this app used to be a sequence of shots, so `steps` doubled
   * as both "what the player does" and "what the Map tab draws". The 'secret'
   * and 'progression' categories broke that equivalence: "hold both flippers
   * while the machine sits in attract mode" and "pick your class before
   * plunging" are real, teachable things a player does, and they involve NO
   * shot at all. Forcing them into `steps` would mean inventing a `shot` id
   * for each one, which either dangles (the id resolves to nothing) or lies
   * (it points at an unrelated ramp and the Map draws a route the player is
   * not supposed to take). Both are worse than saying "this one has no route".
   *
   * INVARIANT: a goal is PATHLESS iff `steps.length === 0`. When pathless it
   * MUST carry `instructions`; when it has steps, `instructions` MUST be
   * absent. `isPathless()` in ui/goalMeta.ts is the single predicate — do not
   * re-derive this test at call sites.
   *
   * Consumers: the Goals tab renders these as a plain ordered list in place of
   * the step-by-step walker, and the Map tab's goal picker omits pathless
   * goals entirely (there is nothing to draw, and offering one would select a
   * goal that renders an empty playfield).
   */
  instructions?: string[] | null
  /**
   * Whether the steps form a required SEQUENCE (default true). Set false for
   * any-order collections — multiball jackpot sets, "complete all N lit
   * shots", frenzy/multiplier target groups — where drawing connector lines
   * from target to target would imply an order the game doesn't require
   * (rolo, 2026-08-02). When false, no connector legs or tracer are drawn:
   * the targets simply light up one after another in the existing highlight
   * cadence (auto-march and manual ‹ › both still work). Equivalent to
   * `link: 'none'` on every step.
   */
  ordered?: boolean | null
  /**
   * GOAL DEPENDENCIES (dataset schema v8, 2026-08-15) — the ids of goals, in
   * THIS machine's file, that have to be collected before this one is on
   * offer at all.
   *
   * The census that motivated this found the dependency already written down,
   * but only in prose and only from one side: Jaws' Level 1 skill shot said
   * collecting it opens Level 2, and Level 2 and Level 3 said nothing about
   * needing anything. A player reading the Level 3 card had no way to learn
   * it was gated, the Map carousel offered the three in file order by
   * coincidence rather than by rule, and nothing could fail when a future
   * edit reordered them. `requires` moves that fact out of one sentence in
   * one goal and into a field every surface can read.
   *
   * A LIST, NOT A `requiresPrev` CHAIN. Ladders are the easy case; fan-in is
   * the real one — a mini-wizard mode that needs several modes finished, a
   * final wizard that needs several mini-wizards. A single-parent field would
   * force those to name one prerequisite and drop the rest, and the dropped
   * ones would look deliberate. Order inside the list carries no meaning:
   * these are conditions, not steps.
   *
   * `requiresNote` EXISTS SO `requires` NEVER HAS TO LIE. Plenty of real
   * prerequisites are not goals: a shot count, a lit-insert threshold, a
   * number of modes started, a prerequisite the corpus has simply never
   * authored as its own goal. Without somewhere else to put those, an author
   * points `requires` at the nearest goal that is only approximately the
   * condition, and the app then states something the machine does not do. The
   * note is free player-facing text and MAY STAND ALONE — a goal gated purely
   * on a threshold carries a note and no `requires` at all, which is the
   * honest shape for it.
   *
   * INVARIANTS (app/scripts/validate-machines.py enforces all three): every id
   * resolves to a goal in the same file; no goal requires itself; no cycles.
   * A cycle is data corruption rather than a hard game — it describes a set of
   * goals none of which can ever be first — and it would also make the Map
   * carousel's ladder ordering undefined.
   *
   * ABSENT IS THE NORM, and additive/fail-soft like `altMode`: most goals are
   * reachable from the start, and a build that predates the field simply never
   * sees it.
   */
  requires?: string[] | null
  /** Free player-facing text for a prerequisite that is NOT another goal —
   *  a threshold, a count, an uncatalogued condition. Valid on its own, with
   *  no `requires` beside it. See `requires` above for why it exists. */
  requiresNote?: string | null
  /** Celebration FX theme override; falls back to GameData.defaultFx. */
  fx?: string | null
}

/** Difficulty/rarity band for an Achievement — presentation-only (a subtle
 *  text chip in the Achievements tab), no gameplay effect. */
export type AchievementTier = 'easy' | 'medium' | 'hard' | 'epic'

/** Where an achievement's wording was derived from — 'insider' (based on a
 *  machine's real tracked accomplishment, e.g. Stern Insider Connected, but
 *  always re-worded in-house per the dataset's IP rules) or 'derived'
 *  (invented in-house from the ruleset with no external tracked source).
 *  Not surfaced in the UI as-is; kept for dataset provenance/audits. */
export type AchievementSource = 'insider' | 'derived'

/**
 * Dataset schema v4 (additive/optional — see data/<machine>_goals.json's
 * top-level "achievements" key). Every achievement's `goal` MUST resolve to
 * a Goal.id in the SAME file's `goals` array per the authoring rule, but the
 * UI (ui/achievements.ts) treats an unresolvable `goal` as fail-soft (stale
 * data): the row still renders, only its "SHOW ME" affordance disables.
 */
export interface Achievement {
  id: string
  title: string
  desc: string
  tier: AchievementTier
  source: AchievementSource
  /** Goal.id in this same file's `goals` array — the "how to obtain" route
   *  shown on the 2D map / AR overlay when the achievement's SHOW ME
   *  affordance is tapped. */
  goal: string
}

/** RETIRED 2026-08-11 (owner: "Remove all cards. That feature has been
 *  removed."). One line on the (now-removed) machine card (ease-layer
 *  schema v5) — no surface renders this any more, and card data has been
 *  stripped from the catalog (data/*_goals.json's top-level `card` key).
 *  This type remains only so ui/machinecard.ts — kept on disk, fully
 *  unimported (UNIMPORT pattern, app.ts's header comment) — still
 *  typechecks. What it WAS: `text` was the whole content — short,
 *  glanceable, original prose. Optional refs made it actionable: `goal`
 *  jumped to that goal on the Map via the same showGoalOnMap flow
 *  achievements use; `shot` let the card name a dot. `trim` marked
 *  model-specific entries ('premium-le'), filtered/chipped by the trim
 *  selector like everything else. */
export interface CardEntry {
  text: string
  shot?: string | null
  goal?: string | null
  trim?: string | null
}

/**
 * RETIRED 2026-08-11 (owner: "Remove all cards. That feature has been
 * removed."). The (now-removed) at-the-machine card (ease-layer schema v5)
 * — no surface renders this any more; card data has been stripped from the
 * catalog. This type remains only so ui/machinecard.ts — kept on disk,
 * fully unimported (UNIMPORT pattern, app.ts's header comment, same as
 * ar/arview.ts and fx/celebrate.ts) — still typechecks. What it WAS: what a
 * player needed in the seconds between balls, in big type — NOT another
 * rules dump. Born from rolo's 2026-08-10 tournament feedback: the map
 * teaches at home; the card was for standing at the glass. Sections
 * rendered in this order: SKILL SHOT / THE LINE / SAFE / DANGER / REMINDERS
 * / PRACTICE (drills).
 */
export interface MachineCard {
  /** The skill-shot pick and why (usually referencing a skillshot goal). */
  skillShot: CardEntry
  /** THE tournament line — one ordered, curated path through the game.
   *  Highest expected value, lowest variance; not a tour of every mode. */
  line: CardEntry[]
  /** Shots that are repeatable and low-drain-risk on this machine. */
  safeShots: CardEntry[]
  /** Shots/situations that drain — `text` says WHY ("rejects SDTM"). */
  dangerShots: CardEntry[]
  /** Anything else worth knowing before ball one ("ball save is short"). */
  reminders?: string[] | null
}

/** A structured practice routine (ease-layer schema v5) — converts limited
 *  machine time into skill instead of discovery. `reps` is prose on purpose
 *  ("one full ball", "3 attempts each strength"); `focus` is a loose tag
 *  (skill-shot | accuracy | ball-control | flow); optional `goal`/`shots`
 *  refs let a drill jump to the map. */
export interface Drill {
  id: string
  title: string
  text: string
  reps?: string | null
  focus?: string | null
  goal?: string | null
  shots?: string[] | null
}

/** One concrete situation where the machine's action button matters. */
export interface ActionButtonUse {
  /** The game situation, short ("During Smart Missile", "Video mode"). */
  when: string
  /** What pressing (or holding) the button does there. */
  what: string
}

/** The machine's in-play control beyond flippers/plunger — Stern's
 *  lockdown-bar action button, a gun trigger (T2/STTNG), magna-save
 *  (BK/BK2000), etc. (dataset schema v6, 2026-08-13). REQUIRED on every
 *  registered machine: `present: false` entries still carry a player-facing
 *  `how` line explaining the game has no such control, so the app can always
 *  answer "what does the button do?". Buy-in buttons and launch-only
 *  buttons with no in-game function do not count as present. */
export interface ActionButtonInfo {
  present: boolean
  /** Player-facing name ("Action Button", "Gun Trigger"); null when absent. */
  label?: string | null
  /** Where it physically sits ("center of the lockdown bar"); null when absent. */
  location?: string | null
  /** What it is + how it works on THIS game (or, when absent, the one-liner
   *  explaining that flippers/plunger/nudging are the whole interface). */
  how: string
  /** When to use it — non-empty when present, empty/absent otherwise. */
  uses?: ActionButtonUse[] | null
}

/** LightKind — the closed vocabulary of light group kinds (dataset schema v9).
 *  WHY closed: the UI renders each kind with a distinct visual treatment, so
 *  an unknown kind would render as nothing. The set mirrors the app's
 *  rendering capabilities and is frozen until a future schema revision. */
export type LightKind = 'shot-arrow' | 'letters' | 'ladder' | 'lanes' | 'multiplier' | 'status' | 'mode'

/** LightInput — the closed vocabulary of player inputs that can control a
 *  light group (dataset schema v9). WHY closed: the control chip in the UI
 *  shows an icon per input; an unknown input would show a blank chip. */
export type LightInput = 'left-flipper' | 'right-flipper' | 'either-flipper' | 'both-flippers'
  | 'action-button' | 'plunger' | 'none'

/** LightSite — where a light group's lamps live. A discriminated union:
 *  either a shot-anchored site (with optional `lamps` count when one shot
 *  stands for a bank, e.g. AFM top-lanes = 2) or a free lamp with authored
 *  coordinates. A site carrying BOTH forms is a validator error; free lamps
 *  are never trim-filtered (they are authored, not derived from shot data).
 *  The honesty rule: free lamps must be placed by an author who has seen the
 *  machine; they are never invented from a rulesheet. */
export type LightSite =
  | { shot: string; lamps?: number | null }
  | { x: number; y: number; name: string }

/** LightControl — how the player (or the game) changes a light group's state.
 *  `input` is from the closed LightInput vocabulary; `effect` describes what
 *  the input does; `when` is optional context. */
export interface LightControl {
  input: LightInput
  effect: string
  when?: string | null
}

/** LightGroup — one coherent set of lamps that share a meaning (dataset schema v9).
 *  `sites` must contain 1..12 entries; `shot` sites must resolve to a shot id
 *  in the same file (any trim). `lit` is a one-sentence explanation of what
 *  LIT means; `flashing` only when FLASHING differs from lit. `control` is
 *  null when the game (or the ball) decides. `then` tells the player what to
 *  shoot/do next when it's lit. `goals` optionally links goal ids that ride
 *  this light, for chip display. */
export interface LightGroup {
  id: string
  name: string
  kind: LightKind
  sites: LightSite[]
  lit: string
  flashing?: string | null
  control?: LightControl | null
  then: string
  goals?: string[] | null
}

/** ScoringTier — the three phases of scoring progression (dataset schema v9).
 *  Closed vocabulary: 'ball-one' (early ball), 'building' (mid-game setup),
 *  'the-big-one' (the machine's largest payoff). */
export type ScoringTier = 'ball-one' | 'building' | 'the-big-one'

/** ScoringStep — one step in the scoring progression. `text` explains the
 *  phase; `goals` optionally links goal ids that contribute to this phase. */
export interface ScoringStep {
  tier: ScoringTier
  text: string
  goals?: string[] | null
}

/** HowItPlays — the machine's "how it plays" explainer (dataset schema v9).
 *  Additive and fail-soft: absent until the v9 content program covers a
 *  machine. The validator WARNs on absence until the program closes, then
 *  ERRORs. `objective` is ≤2 sentences; `loop` is 3..5 ordered cause→effect
 *  bullets; `lights` is 2..10 LightGroups; `laneChange` is promoted from
 *  'unknown' only with evidence, and `laneChangeNote` is required whenever
 *  laneChange !== 'unknown'; `scoring` is exactly the three ScoringTiers in
 *  order. All prose fields are player-facing and subject to the same
 *  sourcing-voice/IP rules as other strings. */
export interface HowItPlays {
  objective: string
  loop: string[]
  lights: LightGroup[]
  laneChange: 'flippers' | 'action-button' | 'none' | 'unknown'
  laneChangeNote?: string | null
  scoring: ScoringStep[]
}
export interface GameData {
  /** Display string, e.g. "Godzilla (Stern, 2021)". */
  machine: string
  defaultFx?: string | null
  shots: Shot[]
  goals: Goal[]
  sources: string[]
  /** Optional/additive (dataset schema v4) — absent or empty on a machine
   *  whose dataset hasn't been patched with achievements yet. See
   *  ui/achievements.ts for the fail-soft handling. */
  achievements?: Achievement[]
  /** Raised/sunken playfields (dataset schema v5) — absent on the ~136
   *  machines that are a single flat surface. See PlayfieldZone. */
  playfields?: PlayfieldZone[] | null
  /** RETIRED 2026-08-11 (owner: "Remove all cards. That feature has been
   *  removed.") — card data has been stripped from every machine's dataset
   *  (see data/*_goals.json), so this field is now always absent in
   *  practice. Kept optional (rather than deleted) only so ui/machinecard.ts
   *  — unimported but still on disk — keeps typechecking against GameData's
   *  real shape; see CardEntry/MachineCard's own doc comments above. */
  card?: MachineCard | null
  /** Practice drills (ease-layer schema v5); absent until authored. */
  drills?: Drill[] | null
  /** Action-button explainer (dataset schema v6) — required on every
   *  registered machine; see ActionButtonInfo. Optional here only so the
   *  seven shelved/unregistered datasets keep typechecking while unpatched
   *  (validate-machines.py enforces presence for catalog machines). */
  actionButton?: ActionButtonInfo | null
  /** How-it-plays explainer (dataset schema v9) — required on every
   *  registered machine once the v9 content program closes; see HowItPlays.
   *  Optional here only so the seven shelved/unregistered datasets keep
   *  typechecking while unpatched (validate-machines.py WARNs on absence
   *  until the program closes, then ERRORs). */
  howItPlays?: HowItPlays | null
}

export interface Machine {
  id: string
  name: string
  shortTitle: string
  /** Dataset basename without .json, e.g. "godzilla_goals". */
  resource: string
}

/** Where the ball starts — filters goals + sets the drawn path's launch point.
 *  NOT ball tracking (deliberately removed from the product). */
export type BallPosition = 'any' | 'plunger' | 'leftFlipper' | 'rightFlipper'

/** Normalized (u,v) anchors for BallPosition, from native AppState.
 *  `plunger` is superseded at draw time (SPEC-BALLSTART's 2026-07-28
 *  "plunger launch realism" amendment): overlay/drawing.ts's drawGoalOverlay
 *  computes a dynamic `(laneX, 0.02)` anchor instead — the machine's
 *  `type === 'plunge'` shot x, clamped to [0.93, 0.98] (fallback 0.97 when
 *  none is modeled) — because this static (0.97, 0.10) sat ABOVE some
 *  machines' plunge rings (dataset plunge y runs 0.02-0.5). The entry stays
 *  here only because the `Record<Exclude<BallPosition, 'any'>, ...>` type
 *  demands the key; it is never read for `plunger` at draw time. leftFlipper
 *  / rightFlipper are unaffected and stay live. */
export const BALL_ANCHORS: Record<Exclude<BallPosition, 'any'>, { u: number; v: number }> = {
  plunger: { u: 0.97, v: 0.10 },
  leftFlipper: { u: 0.40, v: 0.04 },
  rightFlipper: { u: 0.60, v: 0.04 },
}

/** Maps normalized playfield (u,v) — v=0 at the FLIPPER edge — to CSS pixels.
 *  Everything draws through one of these (native parity: the `map` closure). */
export type MapFn = (u: number, v: number) => { x: number; y: number }

export async function fetchCatalog(): Promise<Machine[]> {
  const r = await fetch('/data/catalog.json')
  if (!r.ok) throw new Error(`catalog: HTTP ${r.status}`)
  return r.json()
}

export async function fetchGameData(m: Machine): Promise<GameData> {
  const r = await fetch(`/data/${m.resource}.json`)
  if (!r.ok) throw new Error(`${m.resource}: HTTP ${r.status}`)
  return r.json()
}
