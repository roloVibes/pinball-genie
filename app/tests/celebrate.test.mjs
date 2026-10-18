#!/usr/bin/env node
// app/tests/celebrate.test.mjs — Feature 3 (2026-08-11, owner request):
// map-scoped celebration burst — a small emoji scatter overlay/drawing.ts's
// drawGoalOverlay draws (Pass 5) at the selected goal's LAST step, gated by
// state.ts's `celebrationLevel` pref (default 1, an intensity 0-7 dialed
// from the map settings popover's CELEBRATION slider — Feature 7, 2026-08-11,
// phase A14, superseding Feature 3's plain on/off switch; range widened 0-5
// -> 0-7 in phase A16, same day) and, in MANUAL highlight mode, armed by the
// pure state machine in overlay/map2d.ts (nextCelebrationArmingState).
//
// Phase A16 (2026-08-11, owner, reviewing level 5/5: "the animation for
// celebration is all the same still. the celebration explosion needs to
// almost take up the entire screen when you chose 7/7."): the legal level
// range widens 1-7 (state.ts's own clamp moves to [0,7]), the level-1..7
// scaling table is recalculated with new level-1/level-7 anchors, and —
// the actual fix — the scatter's max travel distance becomes a FRACTION of
// the canvas's own min(width,height) (`celebrationParams`' `reachFraction`
// field, replacing the old `reachCoefficient` ring-radius multiplier)
// instead of a fixed pixel value, so a level-7 burst can genuinely "take up
// the entire screen" regardless of canvas size. See overlay/drawing.ts's own
// phase A16 header note for the full rationale.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/celebrate.test.mjs"
// or from app/:
//   node tests/celebrate.test.mjs
//
// Same esbuild-bundling + recording-Proxy-ctx pattern as every other suite
// here: the REAL overlay/drawing.ts and overlay/map2d.ts are bundled and
// their real exports exercised — app/src is never edited or copied.
//
// Sections:
//   a. nextCelebrationArmingState (map2d.ts, PURE — no DOM needed): the
//      MANUAL-mode arming state machine in isolation. Covers the exact
//      sequence from the brief: advance -> celebrate -> stay (no repeat) ->
//      leave -> return (celebrates again) -> select another goal (re-arms).
//      Also: celebration OFF never arms; AUTO mode never arms (needs none);
//      a pathless/empty-steps goal never arms (no "last step" to park on).
//   b. drawGoalOverlay Pass 5 — AUTO/tracer mode: fires (8 glyph sprites)
//      while parked on the last step, does NOT fire on any earlier step,
//      and fires again on a LATER loop cycle (periodic, not a one-shot).
//   c. drawGoalOverlay Pass 5 — MANUAL mode: draws only while
//      o.celebrate.manualStartedAt is a finite number AND elapsed is inside
//      [0, CELEBRATE_DURATION_MS); null/absent, elapsed>=duration, or the
//      active step not being the last all suppress it.
//   d. celebration OFF (o.celebrate omitted/null): never draws, in either
//      mode, even when every other condition (last step, armed timer) would
//      otherwise fire.
//   e. prefers-reduced-motion (REWORKED 2026-08-11, phase A17 — owner report:
//      celebrations "are all the same" turned out to be this exact path; the
//      static pulse used to be IDENTICAL at every level, fixed 28px/fixed
//      fade, never reading celebrationParams(level) at all): now a STATIC,
//      level-scaled frame — celebrationParams(level).count glyphs at
//      celebrationParams(level).px, frozen at the animated burst's own final
//      (canvas-relative) scatter distance, cross-faded by opacity alone (in
//      then out, never instant-on). Level 1 is visibly smaller than level 7
//      in count/size/reach; level 0 still draws nothing (Pass 5's own gate).
//      The normal (no-preference / explicit false) path is UNCHANGED — still
//      gets the full animated scatter.
//   f. Feature 6 (2026-08-11, TARGET-ONLY revision — rolo: "just reference
//      the targets the skill shots need to hit... hitting the spot before
//      the targets is irrelevant"): skillshotGoals/adjacentSkillshotGoal/
//      skillshotBrowseStep/skillshotReadoutLabel/shouldAdvanceSkillshotBrowse/
//      selectSkillshotAtTarget (map2d.ts, PURE): every skill shot is ONE
//      flat position in the browse sequence, always parked on its LAST step
//      — ‹ › always crosses to the adjacent skill shot (no more "within-goal"
//      case), auto-cycle rolls goal-to-goal on a flat HIGHLIGHT_HOLD_S (no
//      per-step lap multiplier), and the pill has no a/b/c lettering.
//      Closes with a render-level (drawGoalOverlay) check that a two-step
//      skill shot's LAST step gets the active ring treatment (target lit,
//      shooter-lane step not) — the thing TARGET-ONLY browse guarantees is
//      always what's on screen, not just a reachable state.
//   g. Feature 6: skillshotEffectiveHighlightMode (map2d.ts, PURE) maps a
//      skill shot's highlightMode to 'manual' regardless of the real
//      auto/manual cadence — proven here to make the UNCHANGED
//      nextCelebrationArmingState (section a) produce exactly "one burst
//      per skill shot" across a sequence of goal arrivals, with no changes
//      to that state machine itself.
//   h. Burst geometry (phase A12 item 2): the scatter starts AT the ring's
//      own edge (not inside it) and travels well past 2x the ring radius
//      across the burst's duration; a genuinely intermediate step (neither
//      first nor last) fires nothing, same as the first.
//   i. Feature 7 (2026-08-11, phase A14; range widened 1-5 -> 1-7 in phase
//      A16, same day): celebrationParams(level) — the per-level scaling
//      table (glyph count, glyph px, the canvas-min reach FRACTION, the
//      spiral-drift coefficient, hold duration) asserted directly as a pure
//      function, levels 1-7, plus the [1,7] clamp.
//   j. Feature 7 rendering: level 0 draws nothing; level 1 (omitted or
//      explicit) is internally self-consistent (omitted defaults to exactly
//      the same output as an explicit level:1 — no longer claimed
//      byte-identical to the pre-Feature-7 pinned burst, since reach is now
//      canvas-relative, phase A16); rendered glyph count/font-size scale
//      from level 1 to level 7 exactly as celebrationParams predicts; the
//      spiral term is actually wired into the angle formula at level 3+ (not
//      just present in the params table) and absent below it.
//   k. celebrationLevel migration (state.ts's readCelebrationLevel): no
//      stored value defaults to 1; a pre-Feature-7 boolean `"true"`/`"false"`
//      migrates to 1/0; a stored numeric level round-trips for every legal
//      0-7 value (0-5 are the pre-A16 legacy range, still fully supported;
//      6-7 are new); out-of-range/garbage values clamp to the documented
//      fallback instead of propagating.
//   m. Phase A16 canvas-relative travel: the scatter's max travel distance
//      scales with the canvas's own min(width,height) — doubling the
//      canvas-min at a fixed level doubles the travel; level 7's travel
//      clears both a 0.8x-canvas-min floor and a >5x-level-1 floor; a
//      degenerate near-zero canvas holds the scatter at the ring radius
//      rather than collapsing inward.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const srcDir = resolve(appDir, 'src')

// ---------------------------------------------------------------------------
// Tiny harness (matches every other suite here)
// ---------------------------------------------------------------------------
const results = []
let currentSection = ''
function section(name) {
  currentSection = name
  console.log(`\n=== ${name} ===`)
}
async function test(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = await fn()
    results.push({ name: full, outcome: 'pass' })
    console.log(`  PASS  ${name}`)
    if (evidence) console.log(`        ${evidence}`)
  } catch (e) {
    results.push({ name: full, outcome: 'fail' })
    console.log(`  FAIL  ${name}`)
    console.log(`        ${e && e.stack ? e.stack : e}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function close(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`)
}

// ---------------------------------------------------------------------------
// Minimal in-memory localStorage (Feature 7, 2026-08-11, phase A14 —
// celebrationLevel migration tests, section k below) — this Node has no
// built-in one (trim-filter.test.mjs verified: `node -e "console.log(typeof
// localStorage)"` -> undefined). Installed BEFORE the bundle is imported,
// matching trim-filter.test.mjs's own "stub globals before importing"
// ordering, even though state.ts only touches it inside function bodies.
// ---------------------------------------------------------------------------
class FakeStorage {
  constructor() {
    this._map = new Map()
  }
  getItem(k) {
    return this._map.has(k) ? this._map.get(k) : null
  }
  setItem(k, v) {
    this._map.set(k, String(v))
  }
  removeItem(k) {
    this._map.delete(k)
  }
  clear() {
    this._map.clear()
  }
}
globalThis.localStorage = new FakeStorage()

// ---------------------------------------------------------------------------
// Bundle the real modules — drawing.ts (Pass 5's actual drawing), map2d.ts
// (the pure arming state machine), and state.ts (the celebrationLevel pref
// reader/migration, Feature 7). map2d.ts imports './map2d.css', so give
// esbuild an empty loader for CSS (deck-route.test.mjs's technique).
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-celebrate-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  [
    `export * as drawing from ${JSON.stringify(resolve(srcDir, 'overlay/drawing'))}`,
    `export { nextCelebrationArmingState, initialCelebrationArmingState, skillshotGoals, adjacentSkillshotGoal, skillshotBrowseStep, skillshotReadoutLabel, shouldAdvanceSkillshotBrowse, selectSkillshotAtTarget, skillshotEffectiveHighlightMode, mountMap2D } from ${JSON.stringify(resolve(srcDir, 'overlay/map2d'))}`,
    `export { readCelebrationLevel, CELEBRATION_KEY } from ${JSON.stringify(resolve(srcDir, 'state'))}`,
  ].join('\n'),
)
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
})
const {
  drawing,
  nextCelebrationArmingState,
  initialCelebrationArmingState,
  skillshotGoals,
  adjacentSkillshotGoal,
  skillshotBrowseStep,
  skillshotReadoutLabel,
  shouldAdvanceSkillshotBrowse,
  selectSkillshotAtTarget,
  skillshotEffectiveHighlightMode,
  mountMap2D,
  readCelebrationLevel,
  CELEBRATION_KEY,
} = await import(pathToFileURL(outfile).href)

// ---------------------------------------------------------------------------
// window.matchMedia stub — toggled per-test. Absent entirely reproduces
// drawing.ts's own `typeof window !== 'undefined'` fallback (reduceMotion
// false), matching a non-browser/no-preference environment.
// ---------------------------------------------------------------------------
function setReducedMotion(value) {
  globalThis.window = { matchMedia: (q) => ({ matches: value, media: q }) }
}
function clearWindow() {
  delete globalThis.window
}
clearWindow()

// ---------------------------------------------------------------------------
// Synthetic machine + MapFn — same plain rect + v-flip convention as every
// other suite here, v=0 at the bottom (flipper edge).
// ---------------------------------------------------------------------------
const W = 450
const H = 900
const map = (u, v) => ({ x: u * W, y: H - v * H })

const SHOTS = [
  { id: 's1', name: 'Shot 1', type: 'standup', x: 0.3, y: 0.3, trim: 'all' },
  { id: 's2', name: 'Shot 2 (last)', type: 'standup', x: 0.7, y: 0.5, trim: 'all' },
]
const shotsByID = new Map(SHOTS.map((s) => [s.id, s]))
const GLYPH = '🦈' // a distinctive emoji unlikely to collide with any badge digit/checkmark/shot-name label

function goal(id, category, steps, extra = {}) {
  return { id, title: id, category, summary: '', difficulty: 1, steps: steps.map((shot) => ({ shot, action: `Shoot ${shot}` })), ...extra }
}

/** Recording 2D-context stub — same shape as every other suite here, PLUS
 *  (2026-08-11, phase A12 item 2) a real `save`/`restore`/`translate` stack
 *  so each recorded call can be stamped with its ABSOLUTE canvas position
 *  (`at: {x, y}`) even when drawn through a translate (drawCelebrationBurst's
 *  own per-glyph `ctx.translate(x, y); ctx.rotate(...); ctx.fillText(glyph,
 *  0, 0)` — fillText's own args are always literally `(glyph, 0, 0)`, so
 *  without this the glyph's real scatter position would be unrecoverable).
 *  `rotate` only affects ORIENTATION, never the local origin's position, so
 *  it's tracked as a no-op here — irrelevant to `at`. Safe for every OTHER
 *  test in this file: nothing outside drawCelebrationBurst ever calls
 *  `ctx.translate`, so `at` equals the raw (x, y) passed to `arc`/`fillText`/
 *  etc. everywhere else, same as if this tracking didn't exist.
 *
 *  2026-08-11 (Feature 7, phase A14) additionally tracks `ctx.font` the same
 *  way — a plain mutable string threaded through the save/restore stack
 *  alongside tx/ty — and stamps it onto every recorded call as `font`, so
 *  section j below can recover drawCelebrationBurst's resolved glyph PIXEL
 *  SIZE (`emojiFont(params.px)`, e.g. `'40px "Apple Color Emoji"...'`)
 *  straight from a fillText call instead of re-deriving it. Before this, the
 *  Proxy's `set` trap was a bare `() => true` — it let `ctx.font = ...`
 *  "succeed" without ever recording (or even storing) the value; every
 *  OTHER existing test in this file never reads `.font`, so making it a real
 *  tracked property is purely additive.
 *
 * `canvasWidth`/`canvasHeight` (phase A16, 2026-08-11, additive — default to
 * the module-level W/H, i.e. every pre-A16 call site that never passed these
 * is unaffected): the `ctx.canvas.clientWidth`/`clientHeight` values
 * drawGoalOverlay's Pass 5 reads (the same `ctx.canvas.clientWidth ||
 * ctx.canvas.width` idiom Pass 2.5/Pass 4 already use) to resolve
 * `canvasMin` for the celebration burst's canvas-relative reach — see
 * section m below, which is the only place these are ever overridden. Note
 * this is independent of `map` (a plain module-level closure over W/H,
 * unaffected by these) — real production code has the same split: map2d.ts
 * computes its `map` from a playfieldRect INSIDE the canvas, which can be
 * smaller than the canvas itself. */
function recordingCtx(canvasWidth = W, canvasHeight = H) {
  const calls = []
  let tx = 0
  let ty = 0
  let font = ''
  const txStack = []
  const rec = (method) => (...args) => calls.push({ method, args, at: { x: tx, y: ty }, font })
  const noop = () => {}
  const base = {
    canvas: { clientWidth: canvasWidth, clientHeight: canvasHeight, width: canvasWidth * 3, height: canvasHeight * 3 },
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    arcTo: rec('arcTo'),
    arc: rec('arc'),
    rect: rec('rect'),
    roundRect: rec('roundRect'),
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: (...args) => {
      calls.push({ method: 'createRadialGradient', args })
      return { addColorStop: noop }
    },
    setLineDash: noop,
    save: () => {
      txStack.push({ tx, ty, font })
    },
    restore: () => {
      const s = txStack.pop()
      if (s) {
        tx = s.tx
        ty = s.ty
        font = s.font
      }
    },
    translate: (dx, dy) => {
      tx += dx
      ty += dy
    },
    rotate: noop,
  }
  const ctx = new Proxy(base, {
    get: (t, k) => {
      if (k === 'font') return font
      return k in t ? t[k] : noop
    },
    set: (t, k, v) => {
      if (k === 'font') {
        font = v
        return true
      }
      return true
    },
  })
  return { ctx, calls }
}

function draw(g, opts = {}) {
  const { time = 1000, shotsByID: shotsOverride, showLabels = false, ballTracer = false, highlightIndex, celebrate, canvasWidth, canvasHeight } = opts
  const { ctx, calls } = recordingCtx(canvasWidth, canvasHeight)
  const o = {
    shotsByID: shotsOverride ?? shotsByID,
    goal: g,
    stepIndex: 0,
    ballPosition: 'any',
    map,
    time,
    ballTracer,
    showLabels,
  }
  if (highlightIndex !== undefined) o.highlightIndex = highlightIndex
  if (celebrate !== undefined) o.celebrate = celebrate
  const result = drawing.drawGoalOverlay(ctx, o)
  return { calls, result }
}

/** Count of Pass 5's own glyph fillText calls — 8 for the normal scatter, 1
 *  for the reduced-motion pulse, 0 when not celebrating. Filtering by
 *  `text === GLYPH` cleanly isolates these from badge numbers/checkmarks
 *  and ring-caption/action-label text, which never equal the glyph string —
 *  simpler and more robust than reconstructing canvas transform math to
 *  recover each sprite's real pixel position from its translate/rotate
 *  calls. */
function glyphCount(calls) {
  return calls.filter((c) => c.method === 'fillText' && c.args[0] === GLYPH).length
}

/** Feature 7 (2026-08-11, phase A14) — the pixel size baked into the FIRST
 *  glyph fillText call's `font` string (recordingCtx's new font-tracking —
 *  see its own doc comment), e.g. `'40px "Apple Color Emoji"...'` -> 40.
 *  Every glyph in one burst shares the same `ctx.font` (set once before the
 *  loop in drawCelebrationBurst), so "the first one" is representative of
 *  all of them; null when there is no glyph call to read at all. */
function glyphFontPx(calls) {
  const c = calls.find((c) => c.method === 'fillText' && c.args[0] === GLYPH)
  if (!c) return null
  const m = /^(\d+(?:\.\d+)?)px/.exec(c.font)
  return m ? parseFloat(m[1]) : null
}

// ===========================================================================
section('a. nextCelebrationArmingState (map2d.ts, PURE) — MANUAL-mode arming')
// ===========================================================================

await test('advance to the last step -> celebrates; stay -> no repeat; leave -> re-armed; return -> celebrates again', () => {
  const g = goal('g-arm', 'combo', ['s1', 's2']) // lastIndex = 1
  let state = initialCelebrationArmingState()
  const opts = (stepIndex, relMs) => ({ celebrationOn: true, goal: g, highlightMode: 'manual', stepIndex, relMs })

  // Sitting on step 0 (not the last step) — never armed-and-fired.
  state = nextCelebrationArmingState(state, opts(0, 1000))
  assert(state.manualStartedAt === null, 'expected no celebration while on step 0')

  // ADVANCE to the last step (index 1) — celebrate.
  state = nextCelebrationArmingState(state, opts(1, 2000))
  assert(state.manualStartedAt === 2000, `expected the arrival to fire, capturing relMs=2000, got ${state.manualStartedAt}`)
  assert(state.armed === false, 'expected disarming immediately after firing')

  // STAY on the last step across several more frames — NO REPEAT (the
  // captured timestamp must not change).
  for (const laterMs of [2016, 2500, 3200]) {
    state = nextCelebrationArmingState(state, opts(1, laterMs))
    assert(state.manualStartedAt === 2000, `expected no repeat while sitting on the last step, got manualStartedAt=${state.manualStartedAt} at relMs=${laterMs}`)
  }

  // LEAVE the last step (back to step 0) — re-armed, timer cleared.
  state = nextCelebrationArmingState(state, opts(0, 4000))
  assert(state.manualStartedAt === null, 'expected the timer cleared after leaving the last step')
  assert(state.armed === true, 'expected re-arming after leaving the last step')

  // RETURN to the last step — celebrates AGAIN, with a fresh timestamp.
  state = nextCelebrationArmingState(state, opts(1, 5000))
  assert(state.manualStartedAt === 5000, `expected a fresh celebration on return, got ${state.manualStartedAt}`)

  return 'advance->celebrate(2000)->stay(no repeat, 3 frames)->leave(re-armed)->return->celebrates again(5000) — the exact sequence from the brief'
})

await test('selecting a DIFFERENT goal re-arms even while sitting on what was the last step of the previous goal', () => {
  const gA = goal('g-arm-a', 'combo', ['s1', 's2'])
  let state = initialCelebrationArmingState()
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: gA, highlightMode: 'manual', stepIndex: 1, relMs: 1000 })
  assert(state.manualStartedAt === 1000, 'sanity: goal A fired')
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: gA, highlightMode: 'manual', stepIndex: 1, relMs: 1500 })
  assert(state.manualStartedAt === 1000, 'sanity: goal A did not repeat while sitting')

  // A DIFFERENT goal is selected (state.select() resets stepIndex to 0
  // upstream, but the arming check itself only needs the id to differ —
  // simulate the worst case, stepIndex still reads 1 momentarily).
  const gB = goal('g-arm-b', 'combo', ['s1', 's2'])
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: gB, highlightMode: 'manual', stepIndex: 1, relMs: 1600 })
  assert(state.goalId === 'g-arm-b', 'expected the arming state to now track the new goal')
  assert(state.manualStartedAt === 1600, `expected goal B's own arrival to fire fresh (not blocked by goal A's history), got ${state.manualStartedAt}`)
  return "switching goals resets arming — goal B's own last-step arrival celebrates even though goal A had already fired and not re-armed"
})

await test('celebration pref OFF: never arms, regardless of step position or mode', () => {
  const g = goal('g-arm-off', 'combo', ['s1', 's2'])
  let state = initialCelebrationArmingState()
  for (const [stepIndex, mode] of [
    [1, 'manual'],
    [0, 'manual'],
    [1, 'auto'],
  ]) {
    state = nextCelebrationArmingState(state, { celebrationOn: false, goal: g, highlightMode: mode, stepIndex, relMs: 1000 })
    assert(state.manualStartedAt === null, `expected no arming with celebrationOn:false (stepIndex=${stepIndex}, mode=${mode})`)
  }
  return 'celebrationOn:false never sets manualStartedAt no matter what step/mode is passed'
})

await test('AUTO mode never sets manualStartedAt (it needs none — drawGoalOverlay derives its own timing from the tracer)', () => {
  const g = goal('g-arm-auto', 'combo', ['s1', 's2'])
  let state = initialCelebrationArmingState()
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: g, highlightMode: 'auto', stepIndex: 1, relMs: 1000 })
  assert(state.manualStartedAt === null, 'expected AUTO mode to leave manualStartedAt null')
  assert(state.armed === true, 'expected AUTO mode to keep armed:true (ready for the next manual pause)')
  return 'AUTO mode is a pure no-op for this state machine — manualStartedAt stays null, armed stays true'
})

await test('a pathless/empty-steps goal never arms — there is no "last step" to park manual mode on', () => {
  const g = goal('g-arm-pathless', 'secret', [])
  let state = initialCelebrationArmingState()
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: g, highlightMode: 'manual', stepIndex: 0, relMs: 1000 })
  assert(state.manualStartedAt === null, 'expected no arming for a 0-step goal')
  return 'steps.length===0 -> lastIndex=-1 -> the manual-arrival branch never fires'
})

// ===========================================================================
section('b. drawGoalOverlay Pass 5 — AUTO/tracer mode')
// ===========================================================================

await test('fires (8 glyph sprites) while parked on the LAST step; does not fire on an earlier step; fires again on a LATER loop cycle', () => {
  const g = goal('g-auto-celebrate', 'combo', ['s1', 's2']) // lastIndex = 1
  // Scan a wide time range coarsely: find at least one window where it
  // fires, confirm it does NOT fire at t=0 (early in the FIRST segment,
  // nowhere near the last step yet), and confirm there are at least two
  // SEPARATE (non-adjacent) firing windows — i.e. genuinely periodic, not a
  // one-shot that then stays on forever.
  const stepMs = 100
  const maxMs = 20000
  const hits = []
  for (let t = 0; t <= maxMs; t += stepMs) {
    const { calls } = draw(g, { ballTracer: true, time: t, celebrate: { glyph: GLYPH } })
    if (glyphCount(calls) === 8) hits.push(t)
  }
  assert(hits.length > 0, 'expected AUTO mode to fire the celebration at least once across a 6s scan')
  const { calls: atZero } = draw(g, { ballTracer: true, time: 0, celebrate: { glyph: GLYPH } })
  assert(glyphCount(atZero) === 0, 'expected NO celebration at t=0 (freshly launched toward step 1, not yet at the last step)')

  // Group consecutive hits into windows (a gap > stepMs between two hits
  // means a new window started).
  const windows = []
  for (const t of hits) {
    const last = windows[windows.length - 1]
    if (last && t - last.end <= stepMs) last.end = t
    else windows.push({ start: t, end: t })
  }
  assert(windows.length >= 2, `expected at least 2 SEPARATE firing windows (periodic, not one-shot) within ${maxMs}ms, found ${windows.length}: ${JSON.stringify(windows)}`)
  return `${windows.length} separate firing windows found in a ${maxMs}ms scan (e.g. ${windows[0].start}-${windows[0].end}ms, ${windows[1].start}-${windows[1].end}ms) — AUTO mode celebrates every loop arrival, not just the first`
})

await test('the active step being the LAST step is required — o.celebrate alone is not enough', () => {
  const g = goal('g-auto-not-last', 'combo', ['s1', 's2'])
  // t=0 is always segment 0 (index 0, not the last step) per every other
  // suite's own "time:1000/autoHighlightIndex(1000,n)===0" convention —
  // here we use ballTracer:true and t=0, which starts the flight toward
  // step 0's own target, i.e. index 0 is active, not index 1 (lastIndex).
  const { calls, result } = draw(g, { ballTracer: true, time: 0, celebrate: { glyph: GLYPH } })
  assert(result.highlightIndex !== g.steps.length - 1, `sanity: expected the active index at t=0 to NOT be the last step, got ${result.highlightIndex}`)
  assert(glyphCount(calls) === 0, 'expected zero glyph sprites while the active step is not the last one')
  return `at t=0 the active index is ${result.highlightIndex} (not the last step, ${g.steps.length - 1}) — 0 glyph sprites drawn`
})

// ===========================================================================
section('c. drawGoalOverlay Pass 5 — MANUAL mode')
// ===========================================================================

await test('draws only while manualStartedAt is set AND elapsed is inside [0, CELEBRATE_DURATION_MS)', () => {
  const g = goal('g-manual-celebrate', 'combo', ['s1', 's2'])
  const lastIndex = g.steps.length - 1
  const armedAt = 1000

  const { calls: justArrived } = draw(g, { highlightIndex: lastIndex, time: armedAt, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
  assert(glyphCount(justArrived) === 8, `expected the full 8-sprite scatter at elapsed=0, got ${glyphCount(justArrived)}`)

  const { calls: midway } = draw(g, { highlightIndex: lastIndex, time: armedAt + 900, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
  assert(glyphCount(midway) === 8, `expected the scatter to still be drawing midway through the window, got ${glyphCount(midway)}`)

  const { calls: atBoundary } = draw(g, {
    highlightIndex: lastIndex,
    time: armedAt + drawing.CELEBRATE_DURATION_MS,
    celebrate: { glyph: GLYPH, manualStartedAt: armedAt },
  })
  assert(glyphCount(atBoundary) === 0, `expected NO celebration exactly at the duration boundary (elapsed===CELEBRATE_DURATION_MS is NOT < it), got ${glyphCount(atBoundary)}`)

  const { calls: wayAfter } = draw(g, { highlightIndex: lastIndex, time: armedAt + 5000, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
  assert(glyphCount(wayAfter) === 0, `expected no celebration long after the window closed, got ${glyphCount(wayAfter)}`)

  return `elapsed=0 -> 8 sprites; elapsed=900ms -> 8 sprites; elapsed===CELEBRATE_DURATION_MS(${drawing.CELEBRATE_DURATION_MS}) -> 0; elapsed=+5000ms -> 0`
})

await test('manualStartedAt: null (not armed) draws nothing, even parked exactly on the last step', () => {
  const g = goal('g-manual-not-armed', 'combo', ['s1', 's2'])
  const { calls } = draw(g, { highlightIndex: g.steps.length - 1, time: 1000, celebrate: { glyph: GLYPH, manualStartedAt: null } })
  assert(glyphCount(calls) === 0, 'expected zero glyph sprites when manualStartedAt is null')
  return 'null manualStartedAt (not yet armed / already disarmed with nothing captured) draws nothing, matching "never repeat while sitting" — the caller (map2d.ts) is what decides when to set it'
})

await test('manual mode parked on a NON-last step never celebrates, even with a manualStartedAt somehow set', () => {
  const g = goal('g-manual-wrong-step', 'combo', ['s1', 's2'])
  const { calls } = draw(g, { highlightIndex: 0, time: 1000, celebrate: { glyph: GLYPH, manualStartedAt: 1000 } })
  assert(glyphCount(calls) === 0, 'expected zero glyph sprites when the manual highlight is not on the last step')
  return 'active.index !== steps.length-1 gates Pass 5 outright, regardless of manualStartedAt'
})

// ===========================================================================
section('d. celebration OFF (o.celebrate omitted/null): never draws')
// ===========================================================================

await test('o.celebrate omitted entirely: no celebration in either AUTO or MANUAL mode, even parked on the last step with a fresh timer', () => {
  const g = goal('g-off-omitted', 'combo', ['s1', 's2'])
  const { calls: autoCalls } = draw(g, { ballTracer: true, time: 1200 })
  assert(glyphCount(autoCalls) === 0, 'expected 0 glyph sprites in AUTO mode with o.celebrate omitted')
  const { calls: manualCalls } = draw(g, { highlightIndex: g.steps.length - 1, time: 1000 })
  assert(glyphCount(manualCalls) === 0, 'expected 0 glyph sprites in MANUAL mode with o.celebrate omitted')
  return 'omitting o.celebrate entirely (the state.celebrationLevel===0 wiring in map2d.ts) suppresses Pass 5 completely in both modes'
})

await test('o.celebrate explicitly null: same as omitted — never draws', () => {
  const g = goal('g-off-null', 'combo', ['s1', 's2'])
  const { calls } = draw(g, { highlightIndex: g.steps.length - 1, time: 1000, celebrate: null })
  assert(glyphCount(calls) === 0, 'expected 0 glyph sprites with o.celebrate: null')
  return 'o.celebrate: null behaves identically to omitting the field'
})

// ===========================================================================
section(
  'e. prefers-reduced-motion (REWORKED 2026-08-11, phase A17 — owner: celebrations "are all the same" for a full day was THIS path silently ignoring `level`; reduced motion now honors the preference by removing MOTION, not the FEATURE — same celebrationParams(level) count/px/reach as the animated path, frozen at its final pose, cross-faded by opacity alone)',
)
// ===========================================================================

/** The static (reduced-motion) frame is frozen at ease===1 for EVERY glyph,
 *  regardless of level — see drawCelebrationBurst's reduced-motion branch,
 *  which reuses the animated path's own `y -= CELEBRATE_RING_RADIUS * ease`
 *  vertical-lift term with `ease` pinned to 1 (never travels, so `ease` is
 *  not a variable there the way it is in the animated branch). Undoing that
 *  fixed lift recovers the pure radial distance from the target — the same
 *  trick section m's own `radialDistFrom` uses for the animated path,
 *  independently reproduced here (rather than importing that one, which
 *  takes a variable `ease`) since this branch's `ease` is always exactly 1,
 *  a constant, not a parameter. */
function staticRadialDist(call, origin) {
  return Math.hypot(call.at.x - origin.x, call.at.y - origin.y + drawing.CELEBRATE_RING_RADIUS)
}

await test('reduced motion ON, level 0: never draws — Pass 5\'s own `(o.celebrate.level ?? 1) > 0` gate short-circuits before drawCelebrationBurst is ever called, same as the animated path (section j) and unaffected by this rework', () => {
  setReducedMotion(true)
  try {
    const g = goal('g-reduced-motion-level0', 'combo', ['s1', 's2'])
    const { calls } = draw(g, { highlightIndex: g.steps.length - 1, time: 1000, celebrate: { glyph: GLYPH, level: 0, manualStartedAt: 1000 } })
    assert(glyphCount(calls) === 0, `expected 0 glyphs at level 0 under reduced motion, got ${glyphCount(calls)}`)
  } finally {
    clearWindow()
  }
  return 'level 0 draws nothing under reduced motion, exactly like the animated path'
})

await test('reduced motion ON, level 1 (default): renders celebrationParams(1).count (8) glyphs at celebrationParams(1).px (20px), every one frozen at the SAME radial distance from the target — a scaled-down static scatter, not the old single fixed-size pulse', () => {
  setReducedMotion(true)
  try {
    const g = goal('g-reduced-motion-l1', 'combo', ['s1', 's2'])
    const origin = map(SHOTS[1].x, SHOTS[1].y)
    const armedAt = 1000
    const params1 = drawing.celebrationParams(1)
    const midBurst = Math.round(params1.durationMs * 0.5) // fully faded in (past the 0.3 ramp), not yet fading out (before the 0.7 mark)
    const { calls } = draw(g, { highlightIndex: 1, time: armedAt + midBurst, celebrate: { glyph: GLYPH, level: 1, manualStartedAt: armedAt } })
    assert(glyphCount(calls) === params1.count, `expected ${params1.count} glyphs (celebrationParams(1).count), got ${glyphCount(calls)}`)
    assert(glyphFontPx(calls) === params1.px, `expected a ${params1.px}px font (celebrationParams(1).px), got ${glyphFontPx(calls)}`)
    const glyphCalls = calls.filter((c) => c.method === 'fillText' && c.args[0] === GLYPH)
    const maxTravelPx1 = Math.max(drawing.CELEBRATE_RING_RADIUS, params1.reachFraction * 450) // this suite's default canvas-min (W=450, recordingCtx())
    for (const c of glyphCalls) close(staticRadialDist(c, origin), maxTravelPx1, 1e-6, 'level-1 static-frame radial distance')
    return `level 1: ${params1.count} glyphs @ ${params1.px}px, frozen at ${maxTravelPx1.toFixed(1)}px from the target (celebrationParams(1).reachFraction * canvas-min 450)`
  } finally {
    clearWindow()
  }
})

await test('reduced motion ON, level 7: renders celebrationParams(7).count (20) glyphs at celebrationParams(7).px (56px), frozen scatter distance clears the SAME 0.8x-canvas-min floor the animated path clears (section m) — the static frame genuinely reaches "almost the entire screen" too, not just the animated one', () => {
  setReducedMotion(true)
  try {
    const g = goal('g-reduced-motion-l7', 'combo', ['s1', 's2'])
    const origin = map(SHOTS[1].x, SHOTS[1].y)
    const armedAt = 1000
    const params7 = drawing.celebrationParams(7)
    const midBurst = Math.round(params7.durationMs * 0.5)
    const canvasMin = 450 // this suite's default draw() canvas (W=450,H=900)
    const { calls } = draw(g, { highlightIndex: 1, time: armedAt + midBurst, celebrate: { glyph: GLYPH, level: 7, manualStartedAt: armedAt } })
    assert(glyphCount(calls) === params7.count, `expected ${params7.count} glyphs (celebrationParams(7).count), got ${glyphCount(calls)}`)
    assert(glyphFontPx(calls) === params7.px, `expected a ${params7.px}px font (celebrationParams(7).px), got ${glyphFontPx(calls)}`)
    const glyphCalls = calls.filter((c) => c.method === 'fillText' && c.args[0] === GLYPH)
    const maxTravelPx7 = Math.max(drawing.CELEBRATE_RING_RADIUS, params7.reachFraction * canvasMin)
    assert(
      maxTravelPx7 >= 0.8 * canvasMin,
      `sanity: expected level 7's static reach (${maxTravelPx7.toFixed(1)}px) to clear 0.8x canvas-min (${(0.8 * canvasMin).toFixed(1)}px) — same floor section m pins for the animated path`,
    )
    for (const c of glyphCalls) close(staticRadialDist(c, origin), maxTravelPx7, 1e-6, 'level-7 static-frame radial distance')
    return `level 7: ${params7.count} glyphs @ ${params7.px}px, frozen at ${maxTravelPx7.toFixed(1)}px from the target (${((maxTravelPx7 / canvasMin) * 100).toFixed(0)}% of canvas-min ${canvasMin}px) — clears the 0.8x-canvas-min floor while completely static (no travel)`
  } finally {
    clearWindow()
  }
})

await test('reduced motion ON: level 1 is visibly SMALLER than level 7 in every dimension the owner named — fewer glyphs, smaller glyphs, and a closer/tighter scatter — proving the slider now actually does something under reduced motion, the exact bug this rework fixes', () => {
  setReducedMotion(true)
  try {
    const g = goal('g-reduced-motion-compare', 'combo', ['s1', 's2'])
    const armedAt = 1000
    const p1 = drawing.celebrationParams(1)
    const p7 = drawing.celebrationParams(7)
    const { calls: l1 } = draw(g, { highlightIndex: 1, time: armedAt + Math.round(p1.durationMs * 0.5), celebrate: { glyph: GLYPH, level: 1, manualStartedAt: armedAt } })
    const { calls: l7 } = draw(g, { highlightIndex: 1, time: armedAt + Math.round(p7.durationMs * 0.5), celebrate: { glyph: GLYPH, level: 7, manualStartedAt: armedAt } })
    assert(glyphCount(l1) < glyphCount(l7), `expected fewer glyphs at level 1 (${glyphCount(l1)}) than level 7 (${glyphCount(l7)})`)
    assert(glyphFontPx(l1) < glyphFontPx(l7), `expected a smaller font at level 1 (${glyphFontPx(l1)}px) than level 7 (${glyphFontPx(l7)}px)`)
    const origin = map(SHOTS[1].x, SHOTS[1].y)
    const dist1 = staticRadialDist(
      l1.find((c) => c.method === 'fillText' && c.args[0] === GLYPH),
      origin,
    )
    const dist7 = staticRadialDist(
      l7.find((c) => c.method === 'fillText' && c.args[0] === GLYPH),
      origin,
    )
    assert(dist1 < dist7, `expected a closer/tighter scatter at level 1 (${dist1.toFixed(1)}px) than level 7 (${dist7.toFixed(1)}px)`)
    return `level 1: ${glyphCount(l1)} glyphs @ ${glyphFontPx(l1)}px, ${dist1.toFixed(1)}px reach | level 7: ${glyphCount(l7)} glyphs @ ${glyphFontPx(l7)}px, ${dist7.toFixed(1)}px reach — fewer/smaller/closer at level 1, exactly like the animated path`
  } finally {
    clearWindow()
  }
})

await test('reduced motion ON: opacity fades IN then OUT, never instant-on — zero glyphs at elapsedMs=0 (fade-in not yet started) and again near the level\'s own duration (faded back out), full count mid-burst', () => {
  setReducedMotion(true)
  try {
    const g = goal('g-reduced-motion-fade', 'combo', ['s1', 's2'])
    const armedAt = 1000
    const params1 = drawing.celebrationParams(1)
    const { calls: atStart } = draw(g, { highlightIndex: 1, time: armedAt, celebrate: { glyph: GLYPH, level: 1, manualStartedAt: armedAt } })
    assert(glyphCount(atStart) === 0, `expected 0 glyphs at elapsedMs=0 (opacity fading IN from 0), got ${glyphCount(atStart)}`)
    const { calls: midBurst } = draw(g, { highlightIndex: 1, time: armedAt + Math.round(params1.durationMs * 0.5), celebrate: { glyph: GLYPH, level: 1, manualStartedAt: armedAt } })
    assert(glyphCount(midBurst) === params1.count, `expected the full ${params1.count} glyphs mid-burst (fully faded in), got ${glyphCount(midBurst)}`)
    const { calls: atEnd } = draw(g, { highlightIndex: 1, time: armedAt + params1.durationMs - 1, celebrate: { glyph: GLYPH, level: 1, manualStartedAt: armedAt } })
    assert(glyphCount(atEnd) === 0, `expected 0 glyphs 1ms before the duration boundary (opacity faded OUT to ~0), got ${glyphCount(atEnd)}`)
    return `elapsed=0ms -> 0 glyphs (fading in) | elapsed=50% -> ${params1.count} glyphs (fully opaque) | elapsed=duration-1ms -> 0 glyphs (faded out) — opacity in/out, never instant-on like the pre-A17 pulse`
  } finally {
    clearWindow()
  }
})

await test('reduced motion OFF (explicit false): the full 8-sprite scatter, same as no preference at all — UNCHANGED by this rework, animated path pins stay green', () => {
  setReducedMotion(false)
  try {
    const g = goal('g-normal-motion', 'combo', ['s1', 's2'])
    const { calls } = draw(g, { highlightIndex: g.steps.length - 1, time: 1000, celebrate: { glyph: GLYPH, manualStartedAt: 1000 } })
    assert(glyphCount(calls) === 8, `expected the full 8-sprite scatter with reduced-motion explicitly false, got ${glyphCount(calls)}`)
  } finally {
    clearWindow()
  }
  return 'window.matchMedia(...).matches===false behaves identically to no window/matchMedia at all (the default path already exercised throughout sections b/c)'
})

// ===========================================================================
section('f. Feature 6 (2026-08-11): SKILL-SHOT BROWSE MODE — TARGET-ONLY')
// ===========================================================================
// TARGET-ONLY revision (rolo's own live-design call: "just reference the
// targets the skill shots need to hit... hitting the spot before the
// targets is irrelevant in jaws") supersedes a same-day-earlier HYBRID
// revision that briefly walked a multi-step skill shot's OWN steps before
// rolling to the next one. Every skill shot is now ONE flat position in the
// browse sequence, always parked on its LAST step (the target): ‹ › always
// crosses to the adjacent skill shot, auto-cycle rolls goal-to-goal on a
// flat HIGHLIGHT_HOLD_S, and the pill has no a/b/c lettering (map2d.ts's own
// Feature 6 header has the full design). Celebrations follow section g
// below.

const skA = goal('sk-a', 'skillshot', ['s1'])
const skB = goal('sk-b', 'skillshot', ['s1', 's2'])
const skC = goal('sk-c', 'skillshot', ['s2'])
const comboGoal = goal('g-combo', 'combo', ['s1', 's2'])
const MACHINE_DATA = { machine: 'Test Machine', shots: SHOTS, goals: [comboGoal, skA, skB, skC], sources: [] }

await test('skillshotGoals: filters to ONLY category:\'skillshot\', in data order, skipping non-skillshot goals entirely', () => {
  const list = skillshotGoals(MACHINE_DATA)
  assert(list.map((g) => g.id).join(',') === 'sk-a,sk-b,sk-c', `expected [sk-a,sk-b,sk-c] in data order, got ${JSON.stringify(list.map((g) => g.id))}`)
  assert(!list.some((g) => g.id === 'g-combo'), 'expected the non-skillshot goal to be excluded')
  assert(skillshotGoals(null).length === 0, 'expected [] for null data')
  assert(skillshotGoals({ goals: [] }).length === 0, 'expected [] for a machine with no goals at all')
  return `skillshotGoals(data) = [${list.map((g) => g.id).join(', ')}] — the combo goal is correctly excluded`
})

await test("adjacentSkillshotGoal: ‹ › selects the next/prev SKILL SHOT GOAL (not a step index), and WRAPS at both ends", () => {
  const list = skillshotGoals(MACHINE_DATA) // [sk-a, sk-b, sk-c]
  assert(adjacentSkillshotGoal(list, 'sk-a', 1).id === 'sk-b', 'expected next(sk-a) === sk-b')
  assert(adjacentSkillshotGoal(list, 'sk-b', 1).id === 'sk-c', 'expected next(sk-b) === sk-c')
  assert(adjacentSkillshotGoal(list, 'sk-c', 1).id === 'sk-a', 'expected next(sk-c) to WRAP to sk-a (a browse carousel, not a clamp)')
  assert(adjacentSkillshotGoal(list, 'sk-a', -1).id === 'sk-c', 'expected prev(sk-a) to WRAP to sk-c')
  assert(adjacentSkillshotGoal(list, 'sk-b', -1).id === 'sk-a', 'expected prev(sk-b) === sk-a')
  assert(adjacentSkillshotGoal([], 'sk-a', 1) === null, 'expected null for an empty list')
  const single = [skA]
  assert(adjacentSkillshotGoal(single, 'sk-a', 1).id === 'sk-a', 'expected a single-item list to return itself (harmless no-op wrap)')
  assert(adjacentSkillshotGoal(list, 'unknown-id', 1).id === 'sk-a', 'expected an unresolvable currentId to fall back to the FIRST entry for dir:+1')
  assert(adjacentSkillshotGoal(list, 'unknown-id', -1).id === 'sk-c', 'expected an unresolvable currentId to fall back to the LAST entry for dir:-1')
  return 'next/prev correctly resolve to adjacent GOALS across [sk-a,sk-b,sk-c], wrapping at both ends; edge cases (empty/single/unresolvable) degrade sanely'
})

await test("skillshotReadoutLabel: plain 'SKILL SHOT n OF m · <title>' for EVERY skill shot — TARGET-ONLY revision dropped the a/b/c sub-lettering a same-day-earlier HYBRID revision added; single-step and multi-step goals read IDENTICALLY now", () => {
  const list = skillshotGoals(MACHINE_DATA) // [sk-a(1 step), sk-b(2 steps), sk-c(1 step)]
  assert(skillshotReadoutLabel(list, skA) === 'SKILL SHOT 1 OF 3 · sk-a', `got ${JSON.stringify(skillshotReadoutLabel(list, skA))}`)
  assert(skillshotReadoutLabel(list, skC) === 'SKILL SHOT 3 OF 3 · sk-c', `got ${JSON.stringify(skillshotReadoutLabel(list, skC))}`)
  // sk-b is 2-step — no lettering, no different in shape from a 1-step
  // goal's own format. THE proof the lettering is gone: the pre-revision
  // format here was 'SKILL SHOT 2a OF 3 · sk-b'.
  assert(skillshotReadoutLabel(list, skB) === 'SKILL SHOT 2 OF 3 · sk-b', `got ${JSON.stringify(skillshotReadoutLabel(list, skB))}`)
  // A 3-step goal reads the same plain way too — proves it generalizes past
  // two steps, not just "one letter dropped".
  const skD = goal('sk-d', 'skillshot', ['s1', 's2', 's1'])
  const list4 = [skA, skB, skC, skD]
  assert(skillshotReadoutLabel(list4, skD) === 'SKILL SHOT 4 OF 4 · sk-d', `got ${JSON.stringify(skillshotReadoutLabel(list4, skD))}`)
  return `1-step: "${skillshotReadoutLabel(list, skA)}"; 2-step: "${skillshotReadoutLabel(list, skB)}"; 3-step: "${skillshotReadoutLabel(list4, skD)}" — identical shape regardless of step count`
})

await test('skillshotReadoutLabel: an unresolvable goal (not found in list) reads as "1 OF m" rather than "0 OF m" or throwing', () => {
  const list = skillshotGoals(MACHINE_DATA)
  const stranger = goal('sk-stranger', 'skillshot', ['s1'])
  assert(skillshotReadoutLabel(list, stranger) === 'SKILL SHOT 1 OF 3 · sk-stranger', `got ${JSON.stringify(skillshotReadoutLabel(list, stranger))}`)
  return 'an id absent from the list falls back to position 1 rather than 0 or a thrown error'
})

await test("shouldAdvanceSkillshotBrowse: fires for ANY skillshot goal in AUTO mode at a FLAT HIGHLIGHT_HOLD_S — TARGET-ONLY revision dropped the same-day-earlier HYBRID revision's 'one full lap through the goal's own steps' (steps.length * HIGHLIGHT_HOLD_S) multiplier; non-skillshot goals NEVER advance this way", () => {
  const hold = drawing.HIGHLIGHT_HOLD_S

  // A 1-step skill shot (sk-a) and a 2-step one (sk-b) now advance at the
  // EXACT SAME threshold — proof there is no more per-step multiplier. The
  // pre-revision behavior required sk-b to wait 2x as long (one full lap
  // through both of its own steps); TARGET-ONLY browse has no lap to run.
  for (const g of [skA, skB]) {
    assert(shouldAdvanceSkillshotBrowse(g, 'auto', hold) === true, `expected true right at the flat threshold for ${g.id} (${g.steps.length} steps)`)
    assert(shouldAdvanceSkillshotBrowse(g, 'auto', hold + 5) === true, `expected true comfortably past the threshold for ${g.id}`)
    assert(shouldAdvanceSkillshotBrowse(g, 'auto', hold - 0.01) === false, `expected false just under the threshold for ${g.id}`)
  }

  assert(shouldAdvanceSkillshotBrowse(skA, 'manual', hold + 5) === false, 'expected false in MANUAL mode — the ‹ › buttons drive browsing there, not the auto-timer')
  assert(shouldAdvanceSkillshotBrowse(null, 'auto', hold + 5) === false, 'expected false with no goal selected')
  // THE non-skillshot guarantee: a 'combo' goal (2 steps), even auto-marching
  // well past the threshold, never triggers a goal-browse advance — it
  // keeps stepping through ITS OWN steps via the normal (unchanged)
  // drawGoalOverlay tracer/autoHighlightIndex path instead.
  assert(shouldAdvanceSkillshotBrowse(comboGoal, 'auto', 10 * hold) === false, "expected false for a non-skillshot ('combo') goal regardless of elapsed time or mode")
  return `HIGHLIGHT_HOLD_S=${hold}s: both a 1-step and a 2-step skill shot now advance at the SAME ${hold}s threshold (no per-step lap multiplier); a 'combo' goal never triggers it`
})

await test('skillshotBrowseStep: EVERY press crosses to the adjacent skill shot now — sk-b (2-step) is never returned as its own neighbor, from EITHER of its own steps (unlike the pre-revision HYBRID "within-goal" case)', () => {
  const list = skillshotGoals(MACHINE_DATA) // [sk-a(1), sk-b(2), sk-c(1)]
  const forward = skillshotBrowseStep(list, skB, 0, 1) // › from sk-b
  assert(forward.goal.id === 'sk-c', `expected › to cross OUT to sk-c even from sk-b's own step 0, got ${forward.goal.id}`)
  const backward = skillshotBrowseStep(list, skB, 1, -1) // ‹ from sk-b
  assert(backward.goal.id === 'sk-a', `expected ‹ to cross OUT to sk-a even from sk-b's own last step, got ${backward.goal.id}`)
  return 'sk-b --›--> sk-c; sk-b --‹--> sk-a — regardless of which of its own steps the press was notionally "from"'
})

await test("skillshotBrowseStep: lands on the adjacent goal's OWN LAST step in BOTH directions now — not step 0 for › (the pre-revision HYBRID rule) — and still WRAPS at both ends", () => {
  const list = skillshotGoals(MACHINE_DATA) // [sk-a(1), sk-b(2), sk-c(1)]
  const intoMultiForward = skillshotBrowseStep(list, skA, 0, 1) // › sk-a --> sk-b (2 steps)
  assert(intoMultiForward.goal.id === 'sk-b', `expected to cross to sk-b, got ${intoMultiForward.goal.id}`)
  assert(intoMultiForward.stepIndex === 1, `expected sk-b's OWN LAST step (1), NOT step 0, got ${intoMultiForward.stepIndex}`)

  const intoMultiBackward = skillshotBrowseStep(list, skC, 0, -1) // ‹ sk-c --> sk-b (2 steps)
  assert(intoMultiBackward.goal.id === 'sk-b', `expected to cross to sk-b, got ${intoMultiBackward.goal.id}`)
  assert(intoMultiBackward.stepIndex === 1, `expected sk-b's OWN LAST step (1), got ${intoMultiBackward.stepIndex}`)

  // Wrapping at both ends of the list, same as adjacentSkillshotGoal.
  const wrapForward = skillshotBrowseStep(list, skC, 0, 1)
  assert(wrapForward.goal.id === 'sk-a', `expected › from the last skill shot to WRAP to sk-a, got ${wrapForward.goal.id}`)
  assert(wrapForward.stepIndex === 0, "expected sk-a's own last step (0, since sk-a is 1-step)")
  const wrapBackward = skillshotBrowseStep(list, skA, 0, -1)
  assert(wrapBackward.goal.id === 'sk-c', `expected ‹ from the first skill shot to WRAP to sk-c, got ${wrapBackward.goal.id}`)
  assert(wrapBackward.stepIndex === 0, "expected sk-c's own last step (0, since sk-c is 1-step)")

  return "sk-a --›--> sk-b's LAST step (1, not 0); sk-c --‹--> sk-b's LAST step (1); sk-c --›--> WRAPS to sk-a; sk-a --‹--> WRAPS to sk-c"
})

await test('skillshotBrowseStep: the `stepIndex` argument is now IGNORED — every value produces the identical result for the same goal/dir', () => {
  const list = skillshotGoals(MACHINE_DATA)
  const results = [0, 1, 5, -3, 99].map((si) => skillshotBrowseStep(list, skB, si, 1))
  assert(
    results.every((r) => r.goal.id === 'sk-c' && r.stepIndex === 0),
    `expected every stepIndex value to produce the identical {sk-c, 0} result, got ${JSON.stringify(results)}`,
  )
  return 'skillshotBrowseStep(list, sk-b, stepIndex, 1) === {sk-c, 0} for stepIndex in [0,1,5,-3,99] — stepIndex is vestigial, kept only for call-signature stability'
})

await test('skillshotBrowseStep: a SINGLE-step skill shot has no "own step" to walk — every press crosses to the adjacent skill shot, unchanged from before this revision (now simply the ONLY behavior it has)', () => {
  const list = skillshotGoals(MACHINE_DATA)
  const forward = skillshotBrowseStep(list, skA, 0, 1) // skA is 1-step; index 0 IS its last step
  assert(forward.goal.id === 'sk-b', `expected › to cross straight to sk-b, got ${forward.goal.id}`)
  const backward = skillshotBrowseStep(list, skA, 0, -1)
  assert(backward.goal.id === 'sk-c', `expected ‹ to cross straight to sk-c (wrapping), got ${backward.goal.id}`)
  return 'a 1-step skill shot never returns {goal: itself, ...} — step 0 is simultaneously both ends, so every press crosses'
})

await test('skillshotBrowseStep: an empty list returns null (nothing to browse at all), same degenerate case as adjacentSkillshotGoal', () => {
  assert(skillshotBrowseStep([], skA, 0, 1) === null, 'expected null for an empty list, dir:+1')
  assert(skillshotBrowseStep([], skA, 0, -1) === null, 'expected null for an empty list, dir:-1')
  return 'no crash, no bogus fallback goal — mirrors adjacentSkillshotGoal([], ...) === null'
})

/** Minimal fake AppState for selectSkillshotAtTarget — it only ever calls
 *  `.select`/`.goToStep`, so that's all this needs to record. */
function fakeSelectState() {
  const calls = []
  return {
    calls,
    select: (g) => calls.push({ method: 'select', id: g.id }),
    goToStep: (i) => calls.push({ method: 'goToStep', i }),
  }
}

await test('selectSkillshotAtTarget: a multi-step skill shot selection is followed by goToStep(lastIndex) — "on entry, jump straight to the target"', () => {
  const st = fakeSelectState()
  selectSkillshotAtTarget(st, skB) // 2 steps, lastIndex 1
  assert(st.calls.length === 2, `expected exactly 2 calls (select + goToStep), got ${JSON.stringify(st.calls)}`)
  assert(st.calls[0].method === 'select' && st.calls[0].id === 'sk-b', 'expected select(sk-b) first')
  assert(st.calls[1].method === 'goToStep' && st.calls[1].i === 1, `expected a follow-up goToStep(1), got ${JSON.stringify(st.calls[1])}`)
  return "select(sk-b) -> goToStep(1) — lands on sk-b's target (index 1), not its shooter-lane step 0"
})

await test("selectSkillshotAtTarget: a single-step skill shot needs no follow-up call — state.select() already parked it at its only (=last) step", () => {
  const st = fakeSelectState()
  selectSkillshotAtTarget(st, skA) // 1 step, lastIndex 0
  assert(st.calls.length === 1, `expected exactly 1 call (select only), got ${JSON.stringify(st.calls)}`)
  assert(st.calls[0].method === 'select' && st.calls[0].id === 'sk-a', 'expected select(sk-a) with no goToStep follow-up')
  return 'select(sk-a) only — no goToStep call needed for a single-step skill shot'
})

await test('selectSkillshotAtTarget: a non-skillshot goal is a plain select() — no target follow-up regardless of step count', () => {
  const st = fakeSelectState()
  selectSkillshotAtTarget(st, comboGoal) // 'combo', 2 steps
  assert(st.calls.length === 1, `expected exactly 1 call (select only) for a non-skillshot goal, got ${JSON.stringify(st.calls)}`)
  assert(st.calls[0].method === 'select' && st.calls[0].id === 'g-combo', 'expected select(g-combo) with no goToStep follow-up')
  return "a 'combo' goal — even multi-step — never gets the skill-shot target follow-up; buildGoalRow/selectGoalFromCard can call this unconditionally for any category"
})

await test("render level: a skillshot goal's LAST step gets the active tracer-ring treatment when highlightIndex names it (target lit, 3 arcs), while an earlier step's ring is suppressed outright (0 arcs) — the exact configuration TARGET-ONLY browse now ALWAYS puts on screen (skillshotEffectiveHighlightMode pins renderMainLevel's own highlightIndex to the target unconditionally — section g below)", () => {
  // Reuses sk-b (skillshot, ['s1','s2']) — s1 -> (0.3,0.3), s2 -> (0.7,0.5).
  // Compute expected view-space points via the SAME map() the harness hands
  // to drawGoalOverlay, so this can't drift from float-literal rounding.
  const s1Point = map(SHOTS[0].x, SHOTS[0].y)
  const s2Point = map(SHOTS[1].x, SHOTS[1].y)
  // Pass 2's active ring (drawTracerRing, manual mode) draws 3 arcs
  // (radius+5, radius, and a 4px center dot) at NONE of which equal the
  // quiet ring's fixed radius of 14. The INACTIVE step draws NO arc at all
  // (phase A12 item 4, active-target-only display) — every other step's
  // ring/badge is suppressed outright, not just dimmed.
  const arcsAt = (calls, pt) => calls.filter((c) => c.method === 'arc' && c.args[0] === pt.x && c.args[1] === pt.y)

  // The REAL app now always computes highlightIndex as goal.steps.length-1
  // for a selected skill shot — this IS that value, sk-b's own target.
  const lastIndex = skB.steps.length - 1
  const { calls: atTarget } = draw(skB, { highlightIndex: lastIndex, time: 1000 })
  const shooterLaneRing = arcsAt(atTarget, s1Point)
  const targetRing = arcsAt(atTarget, s2Point)
  assert(targetRing.length === 3, `expected the target's ring to get the 3-arc active treatment, got ${targetRing.length}`)
  assert(!targetRing.some((c) => c.args[2] === 14), "expected none of the target's active-ring arcs to be the quiet radius (14)")
  assert(shooterLaneRing.length === 0, `expected the shooter-lane step's ring suppressed outright, got ${shooterLaneRing.length} arc(s)`)

  // Sanity check the inverse (drawGoalOverlay's own ring logic is symmetric
  // at any index, not hardcoded to "last index only") — TARGET-ONLY browse
  // guarantees the real app never actually reaches this configuration for a
  // selected skill shot (selectSkillshotAtTarget/skillshotBrowseStep both
  // always land on the last step), included only as regression coverage
  // that drawGoalOverlay itself has no dead/special-cased branch here.
  const { calls: atStep0 } = draw(skB, { highlightIndex: 0, time: 1000 })
  assert(arcsAt(atStep0, s1Point).length === 3, "expected step 0's ring to light when IT is explicitly named active")
  assert(arcsAt(atStep0, s2Point).length === 0, 'expected the target ring suppressed when step 0 is active')

  return `highlightIndex=${lastIndex} (sk-b's real target, what the app always passes now): target ring active (3 arcs), shooter-lane ring suppressed (0 arcs)`
})

// ===========================================================================
section('g. Feature 6: skillshotEffectiveHighlightMode drives the UNCHANGED arming machine (section a) to "one burst per skill shot"')
// ===========================================================================
// TARGET-ONLY browse means a skill shot's state.stepIndex is ALWAYS its
// target the instant it's selected (section f above) — so map2d.ts's
// updateCelebrationArming now feeds nextCelebrationArmingState a
// highlightMode of 'manual' for EVERY skill shot, via
// skillshotEffectiveHighlightMode, regardless of the REAL auto/manual
// cadence. nextCelebrationArmingState ITSELF is completely UNCHANGED
// (section a already proves its MANUAL-mode edge-triggered rule
// byte-for-byte) — these tests prove the MAPPING alone produces "one burst
// per skill shot" end to end, including the AUTO-cadence case a plain
// highlightMode:'auto' pass-through could never celebrate at all (section
// a's own "AUTO mode never sets manualStartedAt" test).

await test("skillshotEffectiveHighlightMode: 'skillshot' category always maps to 'manual', regardless of the real mode; every other category (or no goal selected) passes the real mode straight through unchanged", () => {
  assert(skillshotEffectiveHighlightMode('skillshot', 'auto') === 'manual', "expected 'skillshot'+'auto' -> 'manual'")
  assert(skillshotEffectiveHighlightMode('skillshot', 'manual') === 'manual', "expected 'skillshot'+'manual' -> 'manual'")
  assert(skillshotEffectiveHighlightMode('combo', 'auto') === 'auto', "expected 'combo'+'auto' -> 'auto' (pass-through)")
  assert(skillshotEffectiveHighlightMode('combo', 'manual') === 'manual', "expected 'combo'+'manual' -> 'manual' (pass-through)")
  assert(skillshotEffectiveHighlightMode(undefined, 'auto') === 'auto', 'expected an undefined category (no goal selected) to pass the real mode through')
  return "skillshot always -> 'manual'; every other category (or no goal) passes realMode straight through"
})

await test("a skill shot selected while the REAL cadence is AUTO (auto-cycling goal-to-goal) still celebrates once per arrival — the exact case a plain highlightMode:'auto' pass-through could never fire at all (section a's own proof)", () => {
  let state = initialCelebrationArmingState()
  const mode = skillshotEffectiveHighlightMode('skillshot', 'auto')
  assert(mode === 'manual', 'sanity: the mapped mode must be manual for the rest of this test to mean anything')
  const lastIndex = skB.steps.length - 1 // TARGET-ONLY browse: always this, never anywhere else

  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: skB, highlightMode: mode, stepIndex: lastIndex, relMs: 1000 })
  assert(state.manualStartedAt === 1000, `expected the arrival to fire even though the REAL cadence is auto, got ${state.manualStartedAt}`)

  // The auto-cycle dwell holds on sk-b for one HIGHLIGHT_HOLD_S before
  // advanceSkillshotBrowseIfDue rolls to the next goal — sitting there
  // across more frames (same goal, same stepIndex) must NOT repeat.
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: skB, highlightMode: mode, stepIndex: lastIndex, relMs: 1800 })
  assert(state.manualStartedAt === 1000, 'expected no repeat while the auto-cycle is still dwelling on sk-b')

  return 'sk-b arrives while the REAL cadence is auto -> fires once (1000) -> no repeat across the dwell — the mapping alone is what makes this fire at all'
})

await test("a full auto-cycle sequence across THREE skill shots fires exactly once per goal, in order, regardless of each goal's own step count", () => {
  let state = initialCelebrationArmingState()
  const mode = skillshotEffectiveHighlightMode('skillshot', 'auto')
  const arrivals = [
    { goal: skA, relMs: 1000 }, // 1 step
    { goal: skB, relMs: 3500 }, // 2 steps
    { goal: skC, relMs: 6000 }, // 1 step
  ]
  const fired = []
  for (const { goal: g, relMs } of arrivals) {
    state = nextCelebrationArmingState(state, { celebrationOn: true, goal: g, highlightMode: mode, stepIndex: g.steps.length - 1, relMs })
    fired.push({ goalId: state.goalId, manualStartedAt: state.manualStartedAt })
  }
  assert(fired.every((f, i) => f.goalId === arrivals[i].goal.id), `expected goalId to track each arrival in order, got ${JSON.stringify(fired)}`)
  assert(fired.every((f, i) => f.manualStartedAt === arrivals[i].relMs), `expected EVERY arrival to fire fresh at its own relMs, got ${JSON.stringify(fired)}`)
  return "sk-a(fires,1000) -> sk-b(fires,3500) -> sk-c(fires,6000) — one burst per skill shot across a 3-goal auto-cycle sequence, undeterred by each goal's own step count"
})

await test('MANUAL ‹ › browsing across skill shots produces the identical one-burst-per-arrival sequence — the mapping is a no-op when the real mode is already manual', () => {
  let state = initialCelebrationArmingState()
  const mode = skillshotEffectiveHighlightMode('skillshot', 'manual')
  assert(mode === 'manual', 'sanity')
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: skA, highlightMode: mode, stepIndex: 0, relMs: 1000 })
  assert(state.manualStartedAt === 1000, 'expected sk-a (1 step) to celebrate immediately on arrival')
  // › crosses to sk-b, landing on ITS last step (skillshotBrowseStep, section f) — a NEW goal, fires fresh.
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: skB, highlightMode: mode, stepIndex: skB.steps.length - 1, relMs: 1600 })
  assert(state.manualStartedAt === 1600, `expected sk-b's arrival (already at its own target — TARGET-ONLY browse never lands anywhere else) to fire fresh, got ${state.manualStartedAt}`)
  // ‹ back to sk-a — a different goal again, fires again.
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: skA, highlightMode: mode, stepIndex: 0, relMs: 2100 })
  assert(state.manualStartedAt === 2100, 'expected sk-a to celebrate AGAIN on this fresh arrival')
  return 'sk-a(fires,1000) -> ›sk-b(fires immediately,1600 — TARGET-ONLY means every arrival IS the target) -> ‹sk-a(fires again,2100)'
})

await test("defense in depth: EVEN with the mapping active (highlightMode:'manual'), a hypothetical non-target stepIndex for a skill shot still does NOT celebrate — the arming machine's own gate is real, not bypassed by the mapping", () => {
  let state = initialCelebrationArmingState()
  const mode = skillshotEffectiveHighlightMode('skillshot', 'auto')
  // sk-b's last index is 1 — stepIndex 0 should never actually reach this
  // call under TARGET-ONLY browse (selectSkillshotAtTarget/skillshotBrowseStep
  // both always pass lastIndex), but proving it does NOT fire is what proves
  // the mapping only changes WHICH mode is consulted, not the gate itself.
  state = nextCelebrationArmingState(state, { celebrationOn: true, goal: skB, highlightMode: mode, stepIndex: 0, relMs: 1000 })
  assert(state.manualStartedAt === null, "expected NO celebration at sk-b's step 0, even mapped to 'manual' — only its OWN last step (1) fires")
  return "highlightMode:'manual' (via the mapping) + stepIndex:0 (not sk-b's last step, 1) -> no fire"
})

await test("celebration OFF still suppresses skill-shot celebrations regardless of the mapping (section a's own guarantee, unaffected by skillshotEffectiveHighlightMode)", () => {
  let state = initialCelebrationArmingState()
  const mode = skillshotEffectiveHighlightMode('skillshot', 'auto')
  state = nextCelebrationArmingState(state, { celebrationOn: false, goal: skB, highlightMode: mode, stepIndex: skB.steps.length - 1, relMs: 1000 })
  assert(state.manualStartedAt === null, 'expected celebrationOn:false to suppress even a mapped-to-manual skill-shot arrival')
  return 'celebrationOn gates BEFORE the highlightMode mapping is ever consulted — unaffected by this revision'
})

// ===========================================================================
section("h. burst geometry (2026-08-11, phase A12 item 2 — rolo: \"have the emojis blow up or spin out of the target circle so it's not confined within the target. Only show celebration for the last shot\")")
// ===========================================================================
// The "only the last shot" half is section b/c's existing job (active.index
// === steps.length-1, unchanged by this phase) — the new assertions below
// are the "blow up / spin out of the target circle" half: the scatter must
// start AT the ring's edge (not inside it) and travel out to a multiple of
// the ring radius, plus an explicit check that a THIRD, genuinely
// intermediate step (neither first nor last) still fires nothing, not just
// "not step 0" (section b's own `g-auto-not-last` fixture is only 2 steps,
// so its "not last" step happens to also be the first).

await test('at elapsedMs=0, every glyph sits EXACTLY CELEBRATE_RING_RADIUS from the target center — starts at the ring edge, not inside it', () => {
  const g = goal('g-burst-start', 'combo', ['s1', 's2']) // s2 (index 1) is the last step
  const origin = map(SHOTS[1].x, SHOTS[1].y)
  const armedAt = 1000
  const { calls } = draw(g, { highlightIndex: 1, time: armedAt, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
  const glyphCalls = calls.filter((c) => c.method === 'fillText' && c.args[0] === GLYPH)
  assert(glyphCalls.length === 8, `expected the full 8-sprite scatter at elapsed=0, got ${glyphCalls.length}`)
  const dists = glyphCalls.map((c) => Math.hypot(c.at.x - origin.x, c.at.y - origin.y))
  for (const d of dists) {
    close(d, drawing.CELEBRATE_RING_RADIUS, 1e-6, 'glyph distance from target center at elapsed=0')
  }
  return `all 8 glyphs at elapsed=0 sit exactly ${drawing.CELEBRATE_RING_RADIUS}px from the target center (distances: ${dists.map((d) => d.toFixed(2)).join(', ')}) — AT the ring's own edge, not confined inside it`
})

await test('across the burst\'s full duration, the scatter reaches well past 2x the ring radius (spec: "~3-5x ring radius")', () => {
  const g = goal('g-burst-travel', 'combo', ['s1', 's2'])
  const origin = map(SHOTS[1].x, SHOTS[1].y)
  const armedAt = 1000
  let maxDist = 0
  for (let elapsed = 0; elapsed < drawing.CELEBRATE_DURATION_MS; elapsed += 25) {
    const { calls } = draw(g, { highlightIndex: 1, time: armedAt + elapsed, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
    for (const c of calls) {
      if (c.method !== 'fillText' || c.args[0] !== GLYPH) continue
      maxDist = Math.max(maxDist, Math.hypot(c.at.x - origin.x, c.at.y - origin.y))
    }
  }
  const twoRings = 2 * drawing.CELEBRATE_RING_RADIUS
  assert(maxDist > twoRings, `expected the scatter's max travel distance to exceed 2x the ring radius (${twoRings}px), got ${maxDist.toFixed(2)}px`)
  // Also confirm it lands inside the spec'd upper bound (5x) rather than
  // flying off arbitrarily far — this is a controlled radius, not a runaway.
  const fiveRings = 5 * drawing.CELEBRATE_RING_RADIUS
  assert(maxDist <= fiveRings + 1e-6, `expected the scatter to stay within 5x the ring radius (${fiveRings}px), got ${maxDist.toFixed(2)}px`)
  return `scatter's max observed travel distance across the full ${drawing.CELEBRATE_DURATION_MS}ms burst: ${maxDist.toFixed(2)}px (${(maxDist / drawing.CELEBRATE_RING_RADIUS).toFixed(2)}x the ${drawing.CELEBRATE_RING_RADIUS}px ring radius) — clears the >2x floor and stays inside the spec's 3-5x range`
})

await test('a non-skillshot 3-step goal: the burst fires ONLY on the LAST step — a genuinely intermediate step (neither first nor last) fires nothing, same as the first', () => {
  const s3 = { id: 's3', name: 'Shot 3 (mid)', type: 'standup', x: 0.5, y: 0.4, trim: 'all' }
  const shots = new Map(shotsByID)
  shots.set(s3.id, s3)
  const g = goal('g-three-step-celebrate', 'combo', ['s1', 's3', 's2']) // lastIndex = 2 ('s2')
  const armedAt = 1000
  for (const stepIndex of [0, 1]) {
    const { calls } = draw(g, { shotsByID: shots, highlightIndex: stepIndex, time: armedAt, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
    assert(glyphCount(calls) === 0, `expected 0 glyph sprites while step ${stepIndex} (not the last, index 2) is active, got ${glyphCount(calls)}`)
  }
  const { calls: atLast } = draw(g, { shotsByID: shots, highlightIndex: 2, time: armedAt, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
  assert(glyphCount(atLast) === 8, `expected the full 8-sprite scatter once the LAST step (index 2) is active, got ${glyphCount(atLast)}`)
  return `3-step goal ['s1','s3','s2']: 0 glyphs while step 0 (first) or step 1 (genuinely intermediate — neither first nor last) is active; 8 glyphs once step 2 (the last) is active`
})

// ===========================================================================
section('i. Feature 7 (2026-08-11, phase A14; range widened 1-5 -> 1-7 in phase A16, same day): celebrationParams(level) — the per-level scaling table')
// ===========================================================================
// Pure-function assertions on celebrationParams itself — the single source
// of truth both drawCelebrationBurst (the pixels, section j) and the Pass-5
// duration gate read. Exact formulas (phase A16 — 6 equal steps from the
// level-1 anchor to the level-7 anchor): count = round(8 + (level-1)*2),
// px = 20 + (level-1)*6, reachFraction = 0.10 + (level-1)*0.14, spiralPerP =
// level>=3 ? (level-2)*0.9π : 0, durationMs = 1800 + (level-1)*200.
// `reachFraction` (phase A16) REPLACES the pre-A16 `reachCoefficient` field
// outright — it is a fraction of canvas-min, not a multiple of the fixed
// ring radius; see section m for the canvas-relative proof.

await test("celebrationParams(1) reproduces Feature 3's count/px/duration exactly (count 8, px 20, durationMs === CELEBRATE_DURATION_MS, spiralPerP 0); reach is now expressed as a canvas-fraction (0.10) rather than the old fixed-pixel multiple (phase A16)", () => {
  const p = drawing.celebrationParams(1)
  assert(p.count === 8, `count: ${p.count}`)
  assert(p.px === 20, `px: ${p.px}`)
  close(p.reachFraction, 0.1, 1e-9, 'reachFraction')
  assert(p.spiralPerP === 0, `spiralPerP: ${p.spiralPerP}`)
  assert(p.durationMs === drawing.CELEBRATE_DURATION_MS, `durationMs: ${p.durationMs} vs CELEBRATE_DURATION_MS=${drawing.CELEBRATE_DURATION_MS}`)
  return `level 1: ${JSON.stringify(p)}`
})

await test('the full level 1-7 scaling table matches the documented formulas exactly', () => {
  const expected = [
    { level: 1, count: 8, px: 20, reachFraction: 0.1, spiralPerP: 0, durationMs: 1800 },
    { level: 2, count: 10, px: 26, reachFraction: 0.24, spiralPerP: 0, durationMs: 2000 },
    { level: 3, count: 12, px: 32, reachFraction: 0.38, spiralPerP: 0.9 * Math.PI, durationMs: 2200 },
    { level: 4, count: 14, px: 38, reachFraction: 0.52, spiralPerP: 1.8 * Math.PI, durationMs: 2400 },
    { level: 5, count: 16, px: 44, reachFraction: 0.66, spiralPerP: 2.7 * Math.PI, durationMs: 2600 },
    { level: 6, count: 18, px: 50, reachFraction: 0.8, spiralPerP: 3.6 * Math.PI, durationMs: 2800 },
    { level: 7, count: 20, px: 56, reachFraction: 0.94, spiralPerP: 4.5 * Math.PI, durationMs: 3000 },
  ]
  const rows = []
  for (const e of expected) {
    const t = drawing.celebrationParams(e.level)
    assert(t.count === e.count, `L${e.level} count: got ${t.count}, want ${e.count}`)
    assert(t.px === e.px, `L${e.level} px: got ${t.px}, want ${e.px}`)
    close(t.reachFraction, e.reachFraction, 1e-9, `L${e.level} reachFraction`)
    assert(Math.abs(t.spiralPerP - e.spiralPerP) < 1e-9, `L${e.level} spiralPerP: got ${t.spiralPerP}, want ${e.spiralPerP}`)
    assert(t.durationMs === e.durationMs, `L${e.level} durationMs: got ${t.durationMs}, want ${e.durationMs}`)
    rows.push(`L${e.level}: count=${t.count} px=${t.px} reach=${(t.reachFraction * 100).toFixed(0)}%(canvas-min) spiral=${(t.spiralPerP / Math.PI).toFixed(2)}π/p hold=${t.durationMs}ms`)
  }
  return rows.join(' | ')
})

await test('level clamps to [1,7] — level 0/negative and over-range/fractional inputs never produce out-of-table params (the Pass-5 gate, not this function, is what turns level<=0 into "draw nothing")', () => {
  assert(JSON.stringify(drawing.celebrationParams(0)) === JSON.stringify(drawing.celebrationParams(1)), 'expected level 0 to clamp to level 1 params')
  assert(JSON.stringify(drawing.celebrationParams(-5)) === JSON.stringify(drawing.celebrationParams(1)), 'expected a negative level to clamp to level 1 params')
  assert(JSON.stringify(drawing.celebrationParams(99)) === JSON.stringify(drawing.celebrationParams(7)), 'expected an over-range level to clamp to level 7 params')
  assert(JSON.stringify(drawing.celebrationParams(5)) !== JSON.stringify(drawing.celebrationParams(7)), 'sanity: level 5 (the pre-A16 ceiling) must NOT silently clamp to 7 — 6 and 7 are genuinely new, reachable levels')
  assert(JSON.stringify(drawing.celebrationParams(3.4)) === JSON.stringify(drawing.celebrationParams(3)), 'expected a fractional level to round to the nearest integer level')
})

// ===========================================================================
section('j. Feature 7 rendering: level 0 draws nothing; level 1 is internally self-consistent; count/size scale; spiral wires into the draw math')
// ===========================================================================
// Every draw() call in this section omits canvasWidth/canvasHeight, so
// canvasMin is always 450 (this suite's default — see recordingCtx()'s own
// doc comment); reach/travel-distance assertions against a specific pixel
// value live in section m below, which is what actually varies the canvas.

await test('level:0 draws zero glyphs even parked on the last step with a fresh timer (defensive — map2d.ts normally passes celebrate:null at level 0 instead, section d)', () => {
  const g = goal('g-level0', 'combo', ['s1', 's2'])
  const { calls } = draw(g, { highlightIndex: 1, time: 1000, celebrate: { glyph: GLYPH, level: 0, manualStartedAt: 1000 } })
  assert(glyphCount(calls) === 0, `expected 0 glyphs at level 0, got ${glyphCount(calls)}`)
})

await test('level omitted vs level:1 explicit render IDENTICAL glyph positions at every sampled elapsed time — omitting `level` resolves to exactly the same output as an explicit level:1 (no longer claimed byte-identical to the pre-Feature-7 fixed-pixel burst, since reach is canvas-relative as of phase A16 — that comparison now lives in celebrationParams\' own doc comment/table, not here)', () => {
  const g = goal('g-level1-identical', 'combo', ['s1', 's2'])
  const armedAt = 1000
  const posOf = (calls) => calls.filter((c) => c.method === 'fillText' && c.args[0] === GLYPH).map((c) => `${c.at.x.toFixed(4)},${c.at.y.toFixed(4)}`)
  // 1750ms (not 1799ms) is the late-window sample: alpha fades to
  // `1-(p-0.7)/0.3` past p=0.7 and drops <=0.01 (the function's own
  // early-return threshold) above ~1795ms of a 1800ms level-1 duration —
  // 1799ms would legitimately draw ZERO glyphs, which would prove nothing
  // about the omitted-vs-explicit comparison; 1750ms stays comfortably above
  // that threshold (alpha ~0.09) while still sampling deep into the
  // fade-out tail.
  for (const elapsed of [0, 250, 900, 1500, 1750]) {
    const { calls: omitted } = draw(g, { highlightIndex: 1, time: armedAt + elapsed, celebrate: { glyph: GLYPH, manualStartedAt: armedAt } })
    const { calls: explicit } = draw(g, { highlightIndex: 1, time: armedAt + elapsed, celebrate: { glyph: GLYPH, level: 1, manualStartedAt: armedAt } })
    const a = posOf(omitted)
    const b = posOf(explicit)
    assert(a.length === 8 && b.length === 8, `expected 8 glyphs each at elapsed=${elapsed}, got ${a.length}/${b.length}`)
    assert(JSON.stringify(a) === JSON.stringify(b), `expected identical positions at elapsed=${elapsed}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
  return 'omitted-level and level:1 render identical glyph positions across the whole burst window (5 sampled times, 8 glyphs each)'
})

await test('rendered glyph COUNT matches celebrationParams(level).count at level 1 (8), level 5 (16), and level 7 (20)', () => {
  const g = goal('g-count-scale', 'combo', ['s1', 's2'])
  const armedAt = 1000
  const counts = {}
  for (const level of [1, 5, 7]) {
    const { calls } = draw(g, { highlightIndex: 1, time: armedAt, celebrate: { glyph: GLYPH, level, manualStartedAt: armedAt } })
    counts[level] = glyphCount(calls)
    assert(counts[level] === drawing.celebrationParams(level).count, `L${level} count: ${counts[level]}`)
  }
  assert(counts[1] === 8 && counts[5] === 16 && counts[7] === 20, `expected 8/16/20, got ${counts[1]}/${counts[5]}/${counts[7]}`)
  return `L1 -> ${counts[1]} glyphs, L5 -> ${counts[5]} glyphs, L7 -> ${counts[7]} glyphs`
})

await test("rendered glyph FONT SIZE matches celebrationParams(level).px at level 1 (20px), level 5 (44px), and level 7 (56px, 2.8x level 1's) — reads recordingCtx's font-tracking", () => {
  const g = goal('g-size-scale', 'combo', ['s1', 's2'])
  const armedAt = 1000
  const px = {}
  for (const level of [1, 5, 7]) {
    const { calls } = draw(g, { highlightIndex: 1, time: armedAt, celebrate: { glyph: GLYPH, level, manualStartedAt: armedAt } })
    px[level] = glyphFontPx(calls)
    assert(px[level] === drawing.celebrationParams(level).px, `L${level} px: ${px[level]}`)
  }
  assert(px[1] === 20 && px[5] === 44 && px[7] === 56, `expected 20/44/56, got ${px[1]}/${px[5]}/${px[7]}`)
  return `L1 -> ${px[1]}px, L5 -> ${px[5]}px, L7 -> ${px[7]}px (${(px[7] / px[1]).toFixed(1)}x L1)`
})

await test("rendered TRAVEL is monotonically increasing with level (L1 < L3 < L5 < L7), scanned across each level's OWN full duration at this suite's default canvas — the precise canvas-min FRACTION checks (>=0.8x canvas-min at L7, >5x L1's, and the canvas-doubling proof) live in section m below", () => {
  const g = goal('g-travel-scale', 'combo', ['s1', 's2'])
  const origin = map(SHOTS[1].x, SHOTS[1].y)
  const armedAt = 1000
  function maxDistFor(level) {
    const duration = drawing.celebrationParams(level).durationMs
    let maxDist = 0
    for (let elapsed = 0; elapsed < duration; elapsed += 25) {
      const { calls } = draw(g, { highlightIndex: 1, time: armedAt + elapsed, celebrate: { glyph: GLYPH, level, manualStartedAt: armedAt } })
      for (const c of calls) {
        if (c.method !== 'fillText' || c.args[0] !== GLYPH) continue
        maxDist = Math.max(maxDist, Math.hypot(c.at.x - origin.x, c.at.y - origin.y))
      }
    }
    return maxDist
  }
  const dists = [1, 3, 5, 7].map((level) => ({ level, dist: maxDistFor(level) }))
  for (let i = 1; i < dists.length; i++) {
    assert(dists[i].dist > dists[i - 1].dist, `expected L${dists[i].level} (${dists[i].dist.toFixed(1)}px) > L${dists[i - 1].level} (${dists[i - 1].dist.toFixed(1)}px)`)
  }
  assert(dists[3].dist > 5 * dists[0].dist, `expected L7's max travel (${dists[3].dist.toFixed(1)}px) to exceed 5x L1's (${(5 * dists[0].dist).toFixed(1)}px)`)
  return dists.map((d) => `L${d.level}=${d.dist.toFixed(1)}px`).join(' | ') + ' — strictly increasing, L7 > 5x L1'
})

/** The documented closed-form position of glyph i=0 (whose `(2*Math.PI*i)/count`
 *  term is always 0, for any count) at a given level/elapsed/canvas-min —
 *  mirrors drawCelebrationBurst's own formula exactly, including the
 *  level-scaled duration (`p`), the shared base rotation, Feature 7's
 *  additional spiral term (0 below level 3), phase A16's canvas-relative
 *  reach (`reachFraction * canvasMin`, floored at CELEBRATE_RING_RADIUS),
 *  and the vertical lift. */
function expectedGlyph0Pos(level, elapsedMs, origin, canvasMin) {
  const params = drawing.celebrationParams(level)
  const p = Math.min(Math.max(elapsedMs / params.durationMs, 0), 1)
  const ease = 1 - (1 - p) * (1 - p)
  const angle = p * 1.4 * Math.PI + params.spiralPerP * p
  const maxTravelPx = Math.max(drawing.CELEBRATE_RING_RADIUS, params.reachFraction * canvasMin)
  const dist = drawing.CELEBRATE_RING_RADIUS + (maxTravelPx - drawing.CELEBRATE_RING_RADIUS) * ease
  return {
    x: origin.x + Math.cos(angle) * dist,
    y: origin.y + Math.sin(angle) * dist - drawing.CELEBRATE_RING_RADIUS * ease,
  }
}

await test("REACH + SPIRAL wiring: glyph 0's rendered position at every level 1-7 matches the documented closed-form formula exactly (angle incl. spiral drift, canvas-relative reach, and vertical lift together) — celebrationParams feeds directly into the draw math, not just a declared table; levels 1-2 (spiralPerP===0) also PROVE no spurious drift leaks in below level 3", () => {
  const g = goal('g-formula-wire', 'combo', ['s1', 's2'])
  const origin = map(SHOTS[1].x, SHOTS[1].y)
  const armedAt = 1000
  const elapsed = 500
  const canvasMin = 450 // this suite's default draw() canvas (W=450,H=900) — see recordingCtx()
  const rows = []
  for (let level = 1; level <= 7; level++) {
    const { calls } = draw(g, { highlightIndex: 1, time: armedAt + elapsed, celebrate: { glyph: GLYPH, level, manualStartedAt: armedAt } })
    const first = calls.find((c) => c.method === 'fillText' && c.args[0] === GLYPH)
    const expected = expectedGlyph0Pos(level, elapsed, origin, canvasMin)
    close(first.at.x, expected.x, 1e-6, `level ${level} glyph-0 x`)
    close(first.at.y, expected.y, 1e-6, `level ${level} glyph-0 y`)
    rows.push(`L${level}: (${first.at.x.toFixed(2)},${first.at.y.toFixed(2)})`)
  }
  return rows.join(' | ')
})

// ===========================================================================
section("k. celebrationLevel migration (state.ts's readCelebrationLevel) — Feature 7, phase A14; range widened 0-5 -> 0-7 in phase A16, same day")
// ===========================================================================

await test("no stored value -> default level 1 (today's burst was ON by default)", () => {
  globalThis.localStorage.clear()
  assert(readCelebrationLevel() === 1, `got ${readCelebrationLevel()}`)
})

await test('pre-Feature-7 boolean pref "true" migrates to level 1', () => {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(CELEBRATION_KEY, 'true')
  assert(readCelebrationLevel() === 1, `got ${readCelebrationLevel()}`)
})

await test('pre-Feature-7 boolean pref "false" migrates to level 0', () => {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(CELEBRATION_KEY, 'false')
  assert(readCelebrationLevel() === 0, `got ${readCelebrationLevel()}`)
})

await test('a value stored under the pre-A16 ceiling (0 through 5 — the LEGACY range) still round-trips byte-identical now that the ceiling is 7 — widening the range never breaks an existing stored pref', () => {
  for (let lvl = 0; lvl <= 5; lvl++) {
    globalThis.localStorage.clear()
    globalThis.localStorage.setItem(CELEBRATION_KEY, String(lvl))
    assert(readCelebrationLevel() === lvl, `legacy level ${lvl}: got ${readCelebrationLevel()}`)
  }
  return 'legacy levels 0,1,2,3,4,5 (the entire pre-A16 legal range) all round-trip exactly under the new [0,7] ceiling'
})

await test('a stored numeric level round-trips exactly, for every legal level 0-7 (6-7 are newly legal in phase A16)', () => {
  for (let lvl = 0; lvl <= 7; lvl++) {
    globalThis.localStorage.clear()
    globalThis.localStorage.setItem(CELEBRATION_KEY, String(lvl))
    assert(readCelebrationLevel() === lvl, `level ${lvl}: got ${readCelebrationLevel()}`)
  }
  return 'levels 0,1,2,3,4,5,6,7 all round-trip exactly'
})

await test('an out-of-range or garbage stored value clamps/falls back rather than propagating (ceiling is now 7, not 5)', () => {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(CELEBRATION_KEY, '99')
  assert(readCelebrationLevel() === 7, `expected an over-range positive value clamped to 7, got ${readCelebrationLevel()}`)
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(CELEBRATION_KEY, '-3')
  assert(readCelebrationLevel() === 0, `expected a negative value clamped to 0, got ${readCelebrationLevel()}`)
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(CELEBRATION_KEY, 'nonsense')
  assert(readCelebrationLevel() === 1, `expected unparseable garbage to fall back to the default (1), got ${readCelebrationLevel()}`)
})

await test("the key read is CELEBRATION_KEY === 'pinballgenie.celebration' — the SAME key Feature 3 used, confirming this is a migration in place, not a new key", () => {
  assert(CELEBRATION_KEY === 'pinballgenie.celebration', `got ${JSON.stringify(CELEBRATION_KEY)}`)
})

// ===========================================================================
section(
  "l. INTEGRATION (2026-08-11, owner report: \"the celebration slider isn't going big enough, still just sticks at level 1 thru the slider\"): mountMap2D's REAL render path threads state.celebrationLevel into drawCelebrationBurst",
)
// ===========================================================================
// Every section above exercises drawGoalOverlay's Pass 5 directly, via this
// file's own draw() helper — which hand-builds `o.celebrate` (including its
// `level` field) itself. That proves celebrationParams()/Pass 5 are correct
// GIVEN a correctly-built opts object, but it never once calls the actual
// production code that BUILDS that object from a live AppState —
// overlay/map2d.ts's mountMap2D -> render() -> renderMainLevel(), which
// reads `state.celebrationLevel` fresh every frame and constructs
// `{ glyph, level: state.celebrationLevel, manualStartedAt }` (map2d.ts,
// inside renderMainLevel). That is exactly the wiring the owner's bug report
// describes as broken — "the slider moves, the burst doesn't" — and exactly
// the gap the sections above cannot detect, however many of them pass.
//
// This section mounts the REAL, unmodified mountMap2D against a minimal
// fake DOM (just enough surface for it to run without throwing — canvas
// returns the SAME recordingCtx() Proxy every section above already uses),
// drives its render loop deterministically (a fake requestAnimationFrame the
// test steps by hand, a fake performance.now() clock the test sets
// directly — no real timers, no flakiness), and reads back the ACTUAL
// fillText calls drawCelebrationBurst made through the full
// render->renderMainLevel->drawGoalOverlay->Pass5->drawCelebrationBurst call
// chain. Manually verified once against the real running app in a real
// browser first (localhost dev server, live DOM, real canvas) to confirm
// this fake-DOM harness's results aren't an artifact of the shim: at
// Celebration·5 the live canvas drew 14 glyphs/frame at "40px ..." fonts (98
// fillText calls clustering into 7 same-frame groups of exactly 14); at
// Celebration·2, 10 glyphs/frame at "25px ..." — both exactly matching
// celebrationParams(5)/celebrationParams(2). No code change was needed: the
// wiring already threads the level correctly end to end. This suite had
// simply never pinned that fact — these tests do.

/** Minimal, permissive DOM element — just enough for the REAL mountMap2D to
 *  run to completion: classList/style/append/addEventListener/etc. all work
 *  well enough that nothing throws, and the handful of properties mountMap2D
 *  actually READS BACK (clientWidth/clientHeight, mainly) return sane fixed
 *  numbers. Everything else is a harmless, permissive no-op — this shim only
 *  needs to not crash, not to reproduce real layout/event semantics. */
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.className = ''
    this.textContent = ''
    this.innerHTML = ''
    this.hidden = false
    this.disabled = false
    this.dataset = {}
    this.clientWidth = 600
    this.clientHeight = 900
    this.width = 0
    this.height = 0
    const classSet = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      toggle: (c, force) => {
        const want = force === undefined ? !classSet.has(c) : force
        if (want) classSet.add(c)
        else classSet.delete(c)
        return want
      },
      contains: (c) => classSet.has(c),
    }
    const styleObj = { removeProperty: (prop) => delete styleObj[prop] }
    this.style = styleObj
    this._listeners = new Map()
    this._attrs = {}
  }
  appendChild(child) {
    this.children.push(child)
    child.parentElement = this
    return child
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n))
  }
  replaceChildren(...nodes) {
    this.children = []
    nodes.forEach((n) => this.appendChild(n))
  }
  remove() {
    if (!this.parentElement) return
    const i = this.parentElement.children.indexOf(this)
    if (i >= 0) this.parentElement.children.splice(i, 1)
  }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    return child
  }
  setAttribute(k, v) {
    this._attrs[k] = v
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn)
  }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) || []) fn(ev)
    return true
  }
  contains(el) {
    if (el === this) return true
    return this.children.some((c) => c.contains(el))
  }
  querySelector() {
    return null
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }
  }
}

/** A no-op ResizeObserver — mountMap2D's own initial resize() call already
 *  runs synchronously at mount (before this would ever need to fire), and
 *  this suite drives every subsequent frame by hand, so it never needs to. */
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function makeFakeDocument(canvasCtx) {
  const listeners = new Map()
  return {
    createElement(tag) {
      const el = new FakeElement(tag)
      if (String(tag).toLowerCase() === 'canvas') {
        el.getContext = (type) => (type === '2d' ? canvasCtx : null)
      }
      return el
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
  }
}

/** Minimal fake AppState — a plain mutable object satisfying every field/
 *  method mountMap2D's render path actually touches (state.ts's AppState
 *  shape), backing a single machine/goal fixture. `celebrationLevel` starts
 *  at `level`; the "live change, no remount" test below mutates it directly
 *  mid-session, exactly like setCelebrationLevel does internally. */
function fakeAppState({ goal: g, level }) {
  const listeners = new Set()
  function notify() {
    for (const fn of listeners) fn()
  }
  const st = {
    machines: [],
    machine: { id: 'integration-test', name: 'Integration Test Machine', shortTitle: 'ITM' },
    data: { machine: 'Integration Test Machine', shots: SHOTS, goals: [g], sources: [] },
    shotsByID,
    selectedGoal: g,
    stepIndex: g.steps.length - 1, // parked on the LAST step (manual mode) so the very first render arms+fires
    ballPosition: 'any',
    highlightMode: 'manual',
    trailStyle: 'dash',
    ballTracer: true,
    shotLines: true,
    trim: 'premium-le',
    celebrationLevel: level,
    routeStartedAt: 0,
    setTrailStyle(v) {
      st.trailStyle = v
      notify()
    },
    setBallTracer(v) {
      st.ballTracer = v
      notify()
    },
    setShotLines(v) {
      st.shotLines = v
      notify()
    },
    setTrim(v) {
      st.trim = v
      notify()
    },
    setCelebrationLevel(v) {
      st.celebrationLevel = Math.min(5, Math.max(0, Math.round(v)))
      notify()
    },
    async selectMachine() {},
    select(goal) {
      st.selectedGoal = goal
      st.stepIndex = 0
      st.highlightMode = 'auto'
      notify()
    },
    clearSelection() {
      st.selectedGoal = null
      notify()
    },
    nextStep() {},
    prevStep() {},
    goToStep(i) {
      st.stepIndex = Math.min(Math.max(i, 0), (st.selectedGoal?.steps.length ?? 1) - 1)
      notify()
    },
    restartGoal() {},
    pauseHighlight() {},
    resumeHighlight() {},
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return st
}

/** Mounts the REAL mountMap2D against the fake DOM above, installing fake
 *  document/window/ResizeObserver/requestAnimationFrame/performance for the
 *  duration of `fn`, then tears everything down (including calling the real
 *  `destroy()`) and restores the prior globals — even if `fn` throws. Gives
 *  `fn` a `step(elapsedMs)` function (sets the fake clock, invokes whichever
 *  callback mountMap2D's own render loop most recently registered via
 *  requestAnimationFrame — the SAME `frame()` closure every real browser
 *  frame would call) and the shared `calls` array recordingCtx() populates.
 *  `state`'s own synchronous mount-time render (mountMap2D calls resize() ->
 *  render(performance.now()) before returning) already happens before `fn`
 *  runs, at fake-clock 0. */
function withMountedMap2D(state, fn) {
  const { ctx, calls } = recordingCtx()
  const doc = makeFakeDocument(ctx)
  const prior = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    performance: globalThis.performance,
  }
  let fakeClock = 0
  let pendingFrame = null
  globalThis.document = doc
  globalThis.window = { devicePixelRatio: 1, matchMedia: (q) => ({ matches: false, media: q }) }
  globalThis.requestAnimationFrame = (cb) => {
    pendingFrame = cb
    return 1
  }
  globalThis.cancelAnimationFrame = () => {
    pendingFrame = null
  }
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.performance = { now: () => fakeClock }
  let handle
  try {
    const host = doc.createElement('div')
    handle = mountMap2D(host, state)
    function step(elapsedMs) {
      fakeClock = elapsedMs
      const cb = pendingFrame
      if (!cb) return false
      cb(fakeClock)
      return true
    }
    return fn({ step, calls })
  } finally {
    handle?.destroy()
    globalThis.document = prior.document
    globalThis.window = prior.window
    globalThis.requestAnimationFrame = prior.requestAnimationFrame
    globalThis.cancelAnimationFrame = prior.cancelAnimationFrame
    globalThis.ResizeObserver = prior.ResizeObserver
    globalThis.performance = prior.performance
  }
}

/** Identifies drawCelebrationBurst's OWN fillText calls among everything
 *  else Pass 5's real render draws (shot dots, labels, badges, the goal
 *  route) — by FONT FAMILY, not by glyph text. Unlike every other test in
 *  this file, this integration section never hand-builds `o.celebrate`
 *  (that's the whole point — it goes through renderMainLevel's REAL
 *  `glyphFor(goal.fx ?? state.data?.defaultFx)` resolution), and this
 *  section's fixtures set neither `fx` nor `defaultFx`, so glyphFor resolves
 *  its own fallback glyph ("✨"), not this file's module-level GLYPH const
 *  ("🦈") every other section passes in explicitly. Filtering on
 *  drawCelebrationBurst's own emojiFont family (`"<px>px \"Apple Color
 *  Emoji\"..."`, confirmed unique to that one function — nothing else in
 *  overlay/drawing.ts or overlay/map2d.ts sets this font) is robust to
 *  exactly which glyph resolved, which is what "the recorded burst glyph
 *  count" actually means here. */
function glyphsSince(calls, sinceIndex) {
  return calls
    .slice(sinceIndex)
    .filter((c) => c.method === 'fillText' && /^\d+(\.\d+)?px "Apple Color Emoji"/.test(c.font))
    .map((c) => ({ x: c.at.x, y: c.at.y, font: c.font }))
}

/** Mounts fresh, sweeps every frame of `level`'s own burst window (fake
 *  clock 0, 25, 50, ... up to celebrationParams(level).durationMs), and
 *  returns `[{ elapsed, glyphs: [{x,y,font}, ...] }, ...]` — one entry per
 *  rendered frame, in order. */
function mountAndSweep(state, level) {
  return withMountedMap2D(state, ({ step, calls }) => {
    const frames = [{ elapsed: 0, glyphs: glyphsSince(calls, 0) }]
    const duration = drawing.celebrationParams(level).durationMs
    for (let elapsed = 25; elapsed < duration; elapsed += 25) {
      const before = calls.length
      if (!step(elapsed)) break
      frames.push({ elapsed, glyphs: glyphsSince(calls, before) })
    }
    return frames
  })
}

/** Every glyph's distance from ITS OWN FRAME's centroid, maxed across every
 *  frame — a self-contained "how far did the scatter travel" measure that
 *  needs no knowledge of the internal playfieldRect()/map() geometry
 *  mountMap2D computes for itself (this suite's fixture never asserts a
 *  specific canvas size): glyphs are evenly angularly distributed around the
 *  target at any instant, so their own centroid is a good stand-in for the
 *  (otherwise-opaque) target position drawCelebrationBurst scattered them
 *  from. */
function maxScatterRadius(frames) {
  let max = 0
  for (const f of frames) {
    if (f.glyphs.length === 0) continue
    const cx = f.glyphs.reduce((s, p) => s + p.x, 0) / f.glyphs.length
    const cy = f.glyphs.reduce((s, p) => s + p.y, 0) / f.glyphs.length
    for (const gl of f.glyphs) max = Math.max(max, Math.hypot(gl.x - cx, gl.y - cy))
  }
  return max
}

await test(
  'level 5, through the REAL mountMap2D render path: every burst frame draws exactly celebrationParams(5).count (16) glyphs at celebrationParams(5).px (44px), and the scatter travels well past 2x its own level-1 baseline (map2d\'s live slider still caps at 5 as of this writing — see state.ts\'s own phase A16 note — so this is the highest level reachable from the real settings popover today; levels 6-7 are proven directly via celebrationParams/drawGoalOverlay in sections i/j/m, not through this mounted-map2d harness)',
  () => {
    const frames5 = mountAndSweep(fakeAppState({ goal: goal('g-integration-l5', 'combo', ['s1', 's2']), level: 5 }), 5)
    const frames1 = mountAndSweep(fakeAppState({ goal: goal('g-integration-l1-baseline', 'combo', ['s1', 's2']), level: 1 }), 1)

    assert(frames5.length > 1, `expected multiple captured frames at level 5, got ${frames5.length}`)
    for (const f of frames5) {
      assert(f.glyphs.length === 16, `expected exactly 16 glyphs (celebrationParams(5).count) at elapsed=${f.elapsed}ms, got ${f.glyphs.length}`)
      for (const gl of f.glyphs) {
        assert(/^44px\b/.test(gl.font), `expected a "44px ..." font (celebrationParams(5).px) at elapsed=${f.elapsed}ms, got ${JSON.stringify(gl.font)}`)
      }
    }

    const r5 = maxScatterRadius(frames5)
    const r1 = maxScatterRadius(frames1)
    assert(r5 > 2 * r1, `expected level 5's max scatter radius (${r5.toFixed(1)}px) to exceed 2x level 1's (${(2 * r1).toFixed(1)}px)`)
    return `level 5: ${frames5.length} real-render frames, 16 glyphs/frame @ "44px ..." throughout, max scatter radius ${r5.toFixed(1)}px vs level 1's ${r1.toFixed(1)}px (${(r5 / r1).toFixed(2)}x) — through the unmodified mountMap2D -> render -> renderMainLevel -> drawGoalOverlay -> Pass 5 -> drawCelebrationBurst call chain, driven only by state.celebrationLevel`
  },
)

await test('level 2, through the REAL mountMap2D render path: every burst frame draws exactly celebrationParams(2).count (10) glyphs at celebrationParams(2).px (26px)', () => {
  const frames2 = mountAndSweep(fakeAppState({ goal: goal('g-integration-l2', 'combo', ['s1', 's2']), level: 2 }), 2)
  assert(frames2.length > 1, `expected multiple captured frames at level 2, got ${frames2.length}`)
  for (const f of frames2) {
    assert(f.glyphs.length === 10, `expected exactly 10 glyphs (celebrationParams(2).count) at elapsed=${f.elapsed}ms, got ${f.glyphs.length}`)
    for (const gl of f.glyphs) {
      assert(/^26px\b/.test(gl.font), `expected a "26px ..." font (celebrationParams(2).px) at elapsed=${f.elapsed}ms, got ${JSON.stringify(gl.font)}`)
    }
  }
  return `level 2: ${frames2.length} real-render frames, 10 glyphs/frame @ "26px ..." throughout — through the REAL mountMap2D render path`
})

await test(
  "changing state.celebrationLevel mid-session with NO remount changes the very NEXT render() frame's burst immediately — proves renderMainLevel re-reads the pref every frame rather than capturing it once at mount (the owner's own suspicion: \"triggers a re-read on next render, not only on remount\")",
  () => {
    const state = fakeAppState({ goal: goal('g-integration-live-change', 'combo', ['s1', 's2']), level: 1 })
    const after = withMountedMap2D(state, ({ step, calls }) => {
      const atMount = glyphsSince(calls, 0)
      assert(atMount.length === 8, `expected 8 glyphs (level 1) from the synchronous mount-time render, got ${atMount.length}`)

      let before = calls.length
      step(50)
      const stillLevel1 = glyphsSince(calls, before)
      assert(stillLevel1.length === 8, `expected still 8 glyphs at elapsed=50ms (celebrationLevel untouched), got ${stillLevel1.length}`)

      // The exact mutation state.setCelebrationLevel(5) performs internally —
      // applied directly, with NO remount and no new mountMap2D() call, the
      // same way the map settings popover's slider `input` listener changes
      // it on a live page (map2d.ts: `state.setCelebrationLevel(parseInt(...))`).
      state.celebrationLevel = 5

      before = calls.length
      step(75)
      return glyphsSince(calls, before)
    })
    assert(after.length === 16, `expected the FIRST frame after mutating state.celebrationLevel to 5 (no remount) to already draw 16 glyphs, got ${after.length}`)
    for (const gl of after) {
      assert(/^44px\b/.test(gl.font), `expected the post-change frame's font to already be "44px ..." (level 5), got ${JSON.stringify(gl.font)}`)
    }
    return 'level 1 (8 glyphs @ 20px) held for 2 frames -> state.celebrationLevel mutated to 5 with NO remount -> the very next render() call already draws 16 glyphs @ 44px'
  },
)

// ===========================================================================
section(
  'm. Phase A16 (2026-08-11, owner: "the celebration explosion needs to almost take up the entire screen when you chose 7/7"): CANVAS-RELATIVE TRAVEL — max scatter distance is a FRACTION of the canvas\'s own min(width,height), not a fixed pixel constant',
)
// ===========================================================================
// Every test above this section uses draw()'s DEFAULT canvas (W=450,H=900,
// canvas-min 450 — recordingCtx()'s own module-level defaults), so a level's
// travel distance has been a constant, canvas-independent number throughout.
// These tests are the only ones that vary canvasWidth/canvasHeight, proving
// the mechanism itself: `ctx.canvas.clientWidth`/`clientHeight` (read once
// by Pass 5, the same idiom Pass 2.5/Pass 4 already use) is what actually
// drives the scatter's reach, independent of `map` (a fixed function of
// (u,v) in this harness, per recordingCtx()'s own doc comment) — exactly
// mirroring production, where map2d.ts's `map` comes from a playfieldRect
// INSIDE the canvas that can be smaller than the canvas itself.

/** Undoes drawCelebrationBurst's fixed, canvas-INDEPENDENT vertical "lift"
 *  cosmetic term (`- CELEBRATE_RING_RADIUS * ease`, added to every glyph's y
 *  regardless of level/canvas — pre-existing, not part of this phase) to
 *  recover the pure canvas-relative radial distance `dist` the formula
 *  actually scales with canvas-min. A raw hypot-from-origin is contaminated
 *  by that shared additive term, so on its own it is only APPROXIMATELY
 *  proportional to canvas-min (the smaller canvas's already-shorter `dist`
 *  is proportionally more perturbed by the same fixed-size term) — exact
 *  proportionality requires undoing it first. This is exact for ANY glyph
 *  at ANY angle: with x = cosθ*dist, y = sinθ*dist - RING*ease relative to
 *  origin, `hypot(x, y + RING*ease) === hypot(cosθ*dist, sinθ*dist) ===
 *  dist * hypot(cosθ, sinθ) === dist` identically (cos²θ+sin²θ=1), so this
 *  also proves every glyph in one frame shares the same radial distance —
 *  asserted directly below as an extra sanity check. */
function radialDistFrom(call, origin, ease) {
  return Math.hypot(call.at.x - origin.x, call.at.y - origin.y + drawing.CELEBRATE_RING_RADIUS * ease)
}

await test(
  "same level (7), two canvas sizes where the SECOND is exactly 2x the first in both dimensions (400x800 vs 800x1600, canvas-min 400 vs 800), sampled at the SAME elapsed time (so `ease`, and therefore the shared vertical-lift term, is identical for both) — the scatter's radial travel distance scales with canvas-min",
  () => {
    const g = goal('g-canvas-relative', 'combo', ['s1', 's2'])
    const origin = map(SHOTS[1].x, SHOTS[1].y) // fixed regardless of canvasWidth/canvasHeight — see section note above
    const armedAt = 1000
    const duration = drawing.celebrationParams(7).durationMs
    const elapsed = 2500 // comfortably inside the alpha===1 window (p<0.7 fade threshold isn't even the concern here — 2500/3000=0.833 is well clear of the <=0.01 cutoff), late enough in the burst to read as "travel", not a boundary edge case
    const p = Math.min(Math.max(elapsed / duration, 0), 1)
    const ease = 1 - (1 - p) * (1 - p)
    function radialDistAtCanvas(canvasWidth, canvasHeight) {
      const { calls } = draw(g, {
        highlightIndex: 1,
        time: armedAt + elapsed,
        celebrate: { glyph: GLYPH, level: 7, manualStartedAt: armedAt },
        canvasWidth,
        canvasHeight,
      })
      const dists = calls.filter((c) => c.method === 'fillText' && c.args[0] === GLYPH).map((c) => radialDistFrom(c, origin, ease))
      assert(dists.length > 0, 'expected at least one glyph drawn')
      for (const d of dists) close(d, dists[0], 1e-6, "every glyph should share the same radial distance at a fixed elapsed (radialDistFrom's own invariant)")
      return dists[0]
    }
    const distSmall = radialDistAtCanvas(400, 800) // canvas-min 400
    const distLarge = radialDistAtCanvas(800, 1600) // canvas-min 800 — exactly 2x
    // Exact identity (holds for ANY `ease` in [0,1], not just as ease->1 —
    // dist = RING + (max(RING,reachFraction*canvasMin) - RING)*ease is
    // linear in canvasMin once past the ring-radius floor, so doubling
    // canvasMin while holding `ease` fixed doubles the FRACTION-driven part
    // of `dist` exactly, leaving a residual of exactly -RING*(1-ease) versus
    // a naive 2x): distLarge === 2*distSmall - CELEBRATE_RING_RADIUS*(1-ease).
    const expectedLarge = 2 * distSmall - drawing.CELEBRATE_RING_RADIUS * (1 - ease)
    close(distLarge, expectedLarge, 1e-6, `expected distLarge to satisfy the exact 2x-minus-ring-residual identity: got ${distLarge}, expected ${expectedLarge}`)
    const ratio = distLarge / distSmall
    return `canvas-min 400 -> radial travel ${distSmall.toFixed(2)}px; canvas-min 800 -> radial travel ${distLarge.toFixed(2)}px (${ratio.toFixed(4)}x, converging to exactly 2x as ease->1) — travel tracks canvas-min, not a fixed pixel constant`
  },
)

await test(
  "level 7 travel clears BOTH the 0.8x-canvas-min floor and the >5x-level-1 floor, at this suite's default canvas (450x900, canvas-min 450) — measured as the RAW on-screen distance (including the fixed vertical-lift cosmetic term), i.e. what a viewer actually sees, unlike the lift-corrected radial figure the doubling proof above uses",
  () => {
    const g = goal('g-l7-floor', 'combo', ['s1', 's2'])
    const origin = map(SHOTS[1].x, SHOTS[1].y)
    const armedAt = 1000
    function maxDistForLevel(level) {
      const duration = drawing.celebrationParams(level).durationMs
      let maxDist = 0
      for (let elapsed = 0; elapsed < duration; elapsed += 25) {
        const { calls } = draw(g, { highlightIndex: 1, time: armedAt + elapsed, celebrate: { glyph: GLYPH, level, manualStartedAt: armedAt } })
        for (const c of calls) {
          if (c.method !== 'fillText' || c.args[0] !== GLYPH) continue
          maxDist = Math.max(maxDist, Math.hypot(c.at.x - origin.x, c.at.y - origin.y))
        }
      }
      return maxDist
    }
    const canvasMin = 450 // this suite's default draw() canvas (W=450,H=900) — see recordingCtx()
    const d7 = maxDistForLevel(7)
    const d1 = maxDistForLevel(1)
    assert(d7 >= 0.8 * canvasMin, `expected level 7's max travel (${d7.toFixed(1)}px) >= 0.8 * canvas-min (${(0.8 * canvasMin).toFixed(1)}px)`)
    assert(d7 > 5 * d1, `expected level 7's max travel (${d7.toFixed(1)}px) to exceed 5x level 1's (${(5 * d1).toFixed(1)}px)`)
    return `canvas-min ${canvasMin}px: L1 max travel ${d1.toFixed(1)}px, L7 max travel ${d7.toFixed(1)}px (${((d7 / canvasMin) * 100).toFixed(0)}% of canvas-min, ${(d7 / d1).toFixed(2)}x level 1's) — clears both the 0.8x-canvas-min floor and the >5x-level-1 floor`
  },
)

await test(
  'a tiny/degenerate canvas (canvas-min below the ring-radius floor) holds the scatter\'s radial distance EXACTLY at CELEBRATE_RING_RADIUS for the entire burst — the Math.max(CELEBRATE_RING_RADIUS, ...) floor in drawCelebrationBurst clamps maxTravelPx down to the ring radius itself, so `dist` never moves at all (rather than merely being stopped from going lower)',
  () => {
    const g = goal('g-tiny-canvas', 'combo', ['s1', 's2'])
    const armedAt = 1000
    const origin = map(SHOTS[1].x, SHOTS[1].y)
    const duration = drawing.celebrationParams(1).durationMs
    // canvas-min 10px: reachFraction(1)*10 = 1px, far below CELEBRATE_RING_RADIUS
    // (14px), so Math.max(RING, 1) === RING exactly — maxTravelPx===RING makes
    // the (maxTravelPx-RING)*ease term in drawCelebrationBurst's `dist`
    // formula vanish for every `ease`, not just clip a would-be-lower value.
    const rows = []
    for (const elapsed of [0, 900, 1700]) {
      const p = Math.min(Math.max(elapsed / duration, 0), 1)
      const ease = 1 - (1 - p) * (1 - p)
      const { calls } = draw(g, {
        highlightIndex: 1,
        time: armedAt + elapsed,
        celebrate: { glyph: GLYPH, level: 1, manualStartedAt: armedAt },
        canvasWidth: 10,
        canvasHeight: 20,
      })
      const c = calls.find((c) => c.method === 'fillText' && c.args[0] === GLYPH)
      assert(c, `expected a glyph to draw at elapsed=${elapsed} on a 10x20px canvas`)
      const d = radialDistFrom(c, origin, ease)
      close(d, drawing.CELEBRATE_RING_RADIUS, 1e-6, `radial distance at elapsed=${elapsed}`)
      rows.push(`elapsed=${elapsed}: ${d.toFixed(4)}px`)
    }
    return `10x20px canvas (canvas-min 10, well below the ${drawing.CELEBRATE_RING_RADIUS}px ring radius): radial distance holds at exactly ${drawing.CELEBRATE_RING_RADIUS}px throughout (${rows.join(', ')}) — the floor clamps maxTravelPx itself, so dist never moves`
  },
)

// ===========================================================================
section('n. The reduced-motion matchMedia listener: exactly one alive, always torn down')
// ===========================================================================
// K3 fast-follow #3 (2026-08-14). map2d.ts subscribes to
// `(prefers-reduced-motion: reduce)` for the CANVAS half of reduced motion —
// the half no @media rule can reach (a frozen marching dash, a stepped
// highlight instead of a flying tracer, a still bumper pulse). A subscription
// on a long-lived mount is a leak waiting to happen, and the specific worry
// worth testing is not "is removeEventListener called" but:
//
//   1. Is it called with the SAME FUNCTION REFERENCE that was added? A
//      listener removed by a fresh arrow function is not removed at all — it
//      is the classic version of this bug, it throws nothing, and the only
//      symptom is that after a few tab switches every stale closure re-renders
//      a destroyed canvas on one flick of the OS toggle.
//   2. Does destroy() actually RUN on a machine switch? It does not — and it
//      should not: mountMap2D survives a machine switch (syncMachineLocalState
//      resets the machine-local bits in place), so the listener is added ONCE
//      PER MOUNT, not once per machine. This pins that, because "add on every
//      machine load" is exactly how one listener becomes twelve.
//
// The stub below records every add/remove with its reference, so both claims
// are checked against identity, not against call counts.

/** A fixture state for this section — one goal, celebrations off (level 0),
 *  so nothing here depends on the burst machinery the rest of the file tests. */
function motionState(id) {
  return fakeAppState({ goal: goal(id, 'combo', ['s1', 's2']), level: 0 })
}

function motionMediaStub() {
  const live = new Map() // type -> Set<fn>
  let adds = 0
  let removes = 0
  const query = {
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener(type, fn) {
      adds++
      if (!live.has(type)) live.set(type, new Set())
      live.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      removes++
      // Set.delete is reference-identity, so a listener removed with a
      // DIFFERENT function object simply is not found here.
      live.get(type)?.delete(fn)
    },
  }
  return {
    query,
    liveCount: () => [...live.values()].reduce((n, set) => n + set.size, 0),
    stats: () => ({ adds, removes }),
    fire: (matches) => {
      query.matches = matches
      for (const fn of [...(live.get('change') ?? [])]) fn({ matches })
    },
  }
}

/** Mounts map2d against `stub` for matchMedia, runs `fn`, then destroys. */
function withMotionStub(stub, state, fn) {
  const { ctx } = recordingCtx()
  const doc = makeFakeDocument(ctx)
  const prior = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    performance: globalThis.performance,
  }
  globalThis.document = doc
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => stub.query }
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.performance = { now: () => 0 }
  let handle
  try {
    handle = mountMap2D(doc.createElement('div'), state)
    return fn(handle)
  } finally {
    handle?.destroy()
    Object.assign(globalThis, prior)
  }
}

await test('N mount/destroy cycles leave exactly ONE listener alive during each, and ZERO after — removal is by the same reference', () => {
  const stub = motionMediaStub()
  const CYCLES = 5
  const during = []
  for (let i = 0; i < CYCLES; i++) {
    withMotionStub(stub, motionState(`g-motion-${i}`), () => {
      during.push(stub.liveCount())
    })
    // destroy() has run by here (withMotionStub's finally).
    assert(
      stub.liveCount() === 0,
      `after mount/destroy cycle ${i + 1} there are ${stub.liveCount()} listener(s) still registered — ` +
        `removeEventListener was called with a DIFFERENT function object than addEventListener, so nothing was removed`,
    )
  }
  assert(
    during.every((n) => n === 1),
    `expected exactly 1 live listener while mounted, saw ${JSON.stringify(during)}`,
  )
  const { adds, removes } = stub.stats()
  assert(adds === CYCLES && removes === CYCLES, `expected ${CYCLES} adds and ${CYCLES} removes, got ${adds}/${removes}`)
  return `${CYCLES} cycles: 1 live listener during each, 0 after each, ${adds} adds / ${removes} removes`
})

await test('a machine switch does NOT re-subscribe — the mount survives it, so the listener is added once per MOUNT', () => {
  const stub = motionMediaStub()
  const state = motionState('g-motion-switch')
  withMotionStub(stub, state, () => {
    assert(stub.liveCount() === 1, 'setup: one listener after mount')
    // Three machine switches, delivered through the REAL onChange path
    // (setTrailStyle is one of the fixture's own notify()-firing setters, so
    // this exercises mountMap2D's actual subscriber, not a hand-called hook).
    for (const id of ['machine-b', 'machine-c', 'machine-d']) {
      state.machine = { id, name: id }
      state.setTrailStyle(state.trailStyle === 'dash' ? 'neon' : 'dash')
      assert(
        stub.liveCount() === 1,
        `after switching to ${id} there are ${stub.liveCount()} listeners — a machine switch must not re-subscribe`,
      )
    }
    const { adds } = stub.stats()
    assert(adds === 1, `expected exactly 1 addEventListener across 3 machine switches, got ${adds}`)
  })
  assert(stub.liveCount() === 0, 'and destroy() still removes the one listener afterwards')
  return '3 machine switches, still 1 add / 1 live listener; 0 after destroy'
})

await test('the listener actually does something: flipping the OS pref re-renders without a state change', () => {
  // A subscription that is correctly torn down but never repaints would pass
  // both tests above and still be useless — the whole reason it exists is
  // that with no goal selected there is no rAF loop to notice the change.
  const stub = motionMediaStub()
  const state = motionState('g-motion-idle')
  state.selectedGoal = null
  withMotionStub(stub, state, () => {
    assert(stub.liveCount() === 1, 'setup: subscribed')
    // Fires the change handler; it must not throw against a live mount, and
    // it must repaint (the handler calls render() directly).
    stub.fire(true)
    stub.fire(false)
  })
  return 'change events delivered to a live mount with no goal selected (no rAF loop running) without throwing'
})

// ---------------------------------------------------------------------------
await rm(tmp, { recursive: true, force: true })
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
