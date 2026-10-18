#!/usr/bin/env node
// app/tests/plunger-route.test.mjs — SPEC-PATHVIZ rule 5 (lane route) +
// SPEC-BALLSTART's 2026-07-28 "plunger launch realism" amendment, the
// 2026-07-28 review's follow-up fixes (tightened Case A boundary,
// "Degenerate legs", ring captions / map-declutter — SPEC-PATHVIZ point 2),
// AND the 2026-07-28 "Shot Coach" polyline-flattening + tracer-ball redesign
// (design_handoff_shot_coach/README.md §1, corrected by the orchestrator's
// shotcoach-corrections.md — that file is binding wherever it disagrees with
// the README).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/plunger-route.test.mjs"
// or from app/:
//   node tests/plunger-route.test.mjs
//
// Same esbuild-bundling + recording-Proxy-ctx pattern as
// app/tests/geometry-chain.test.mjs: the REAL overlay/drawing.ts (and, for
// the declutter tests, the REAL overlay/map2d.ts) are bundled and their real
// exports are exercised through a coordinate-capturing 2D-context stub —
// app/src is never edited or copied.
//
// ROUTING itself (routeSegment/directControl/bowControl/laneRoute) is
// UNCHANGED by Shot Coach — only how a computed route becomes pixels
// changed: every route segment is now flattened into ONE continuous
// polyline (22 samples per surviving Bézier leg, chained through leg
// origins) instead of being stroked leg-by-leg with quadraticCurveTo. So:
//   - ROUTING-SHAPE assertions (sections a-m below) call drawGoalOverlay
//     with `ballTracer: false` (+ `time: 1000`, unchanged from before —
//     autoHighlightIndex(1000, n) === 0 for every n, so segment 0 is always
//     the deterministic "active" one) so the OLD two-state active/quiet
//     highlight semantics apply and nothing about the ROUTED GEOMETRY itself
//     needs re-deriving beyond how it's grouped into draw calls.
//   - curveLegs() (old: pairs up adjacent moveTo/quadraticCurveTo calls) is
//     replaced by polylineRuns() (new: groups moveTo + the lineTo run that
//     follows it — one "run" per ctx.beginPath()+moveTo+lineTo*+stroke()
//     sequence, from ANY of drawing.ts's callers: a leg's stroke, its
//     arrowhead, the tracer ball's comet, or (when showLabels is true) the
//     action-label bubble's rounded-rect path). Geometry tests below pass
//     `showLabels: false` to keep runs limited to leg-stroke/arrowhead
//     geometry, exactly like the pre-Shot-Coach source's section k already
//     did for the same reason.
//   - A stroked LEG's run always ends EXACTLY at its segment's target (the
//     flattened polyline's last sample is the quad curve at t=1, which is
//     the target point with zero float error) — an arrowhead's 3-point
//     chevron run does NOT (its base is pulled back `back` px along the
//     tangent) — so "the run whose last point equals the target" robustly
//     picks out the real stroke geometry regardless of trailStyle (dash
//     restrokes it twice, neon three times + a conditional sheen run; any
//     one of them carries the same sampled points).
//   - Per-CURVE-LEG exact-control asserts (old sections g/h) are re-derived
//     as curve-sampling asserts: the flattened polyline must pass within
//     1.5px of the expected quadratic Bézier's B(0.5) midpoint for the leg
//     of interest, computed from the expected control point.
//   - Leg-COUNT asserts (old sections i/l) become point-COUNT asserts on the
//     matched stroke run: each surviving Bézier leg contributes exactly 22
//     samples (+1 shared seed point for the whole segment), so a 1-leg
//     Case-A segment's run has 23 points, a 2-leg Case-B run has 45, a
//     3-leg Case-C run has 67.
//   - The degenerate-leg test (old section k) asserts NO polyline run
//     exists at all for the zero-length segment (Pass 1 skips a null/
//     len<1 flat entirely — no stroke, no arrowhead). Its polyline stays
//     that way after the 2026-07-28 degenerate-leg review — only tracerAt's
//     SCHEDULE (section n) changed, not Pass 1's polyline draw gate.
//
// New sections (shotcoach-corrections.md #17):
//   n. tracerAt() unit tests — phase boundaries at exact ms offsets, clock
//      anchoring (t=0 -> index 0, u=0), and (2026-07-28 degenerate-leg
//      review findings 1/2, superseding the original correction #4 skip
//      behavior) degenerate/null-flat DWELL-ONLY phases — no travel, ball
//      stays null, `done`/`index` still fold in ORIGINAL segment indices,
//      including through the end-pause boundary with a mix of real and
//      degenerate/null segments. ALSO (D8, 2026-07-29 review) a FlatSegment
//      carrying `rampIdx` (a rule-7 elevated tail survived): `sinceHit` is
//      measured from the crossing of the "main" (entrance-ring) length, not
//      from the full flight's `dwellStart` — null before that crossing,
//      non-null (and counting from the crossing instant, not from arrival)
//      while still travelling the elevated tail, during the dwell at the
//      feed point, and through the end pause; the ball's own travelled
//      position (`u`/`ball`) is completely unaffected, still the whole
//      flight's arc-length fraction.
//   o. pointAt() unit tests — arc-length lerp + tangent angle, clamping.
//   p. labelPacker() unit tests — box collision directly, no rendering.
//   q. caption-collision integration test — two same-position shots, the
//      second caption moves below rather than overlapping the first.
//   r. manual-mode / ballTracer integration — manual highlightIndex bypasses
//      the flying ball (no radial gradient) even with ballTracer:true and
//      marks earlier steps done (checkmark badges); ballTracer:true + auto +
//      t=0 DOES draw the ball. Plus drawGoalOverlay's { highlightIndex }
//      return value.
//   s. 2026-07-28 degenerate-leg review regressions — finding 2 (end-pause
//      done/index across a mix of real and degenerate/null flats) and
//      finding 3 (the reinstated ARROWHEAD_MIN_LEG_PX gate: a short leg's
//      polyline still draws, its arrowhead doesn't).
//   t. 2026-07-29 straightness regression — bowControl/directControl now
//      both return the chord midpoint (a degenerate quadratic renders as an
//      EXACT straight line), and directControl's obstacle-clearance nudge is
//      gone with it: a direct launch segment, a viaWaypoint route's two legs,
//      and a direct segment with a "mech" obstacle sitting right on the
//      chord all now assert genuine collinearity. laneRoute's shooter-lane
//      ARCH leg (Case B) is asserted to still DEVIATE from its chord —
//      arches are a real physical feature of the table and were
//      deliberately NOT flattened to straight lines.
//
// 2026-08-11 (phase A7 — rolo, reviewing production: "I don't like the
// plunger pull line representation, completely remove that... shots need
// the flippers to complete, many times you can't just go right thru the
// board"): a plunger-origin segment (the first launch AND every mid-sequence
// re-plunge alike) now draws NO lane leg at all — routeSegment's 'lane' kind
// always carries `legs: []` (see drawing.ts's header + routeSegment's own
// doc comment). drawPlungeGauge (sections v/v2 below) is the ONLY visual
// plunge representation left; classifyPlunge/laneRoute are UNCHANGED and
// still fully exercised (routeSegment still calls laneRoute for `partial`,
// it just discards `legs`).
//   Every section below whose whole POINT was a drawn lane leg/arch/junction
// (b, c, g, h, i, l, m2, u, and v's one "shared calc" test, plus part of t)
// is reworked HONESTLY, not deleted: they now assert NO polyline run draws
// for the plunger-origin segment (0 runs where legs used to be), with the
// still-relevant HALF of their old intent — the target still rings, or the
// classification is still correct — re-asserted through what's actually
// still drawn (rings/badges, or the gauge's own SOFT/FULL label and fill
// height, read straight from classifyPlunge rather than a route point).
// Section k's degenerate-ring regression, and every gauge-geometry
// assertion in sections v/v2, needed NO changes — they never depended on a
// drawn lane leg to begin with (or, for k, already asserted the leg was
// ABSENT). Section w's two integration tests (goal-level ball-tracer
// checks) become 'no polyline, tracer doesn't get stuck' cases — its three
// tracerAt() unit tests (synthetic flats, no drawGoalOverlay call at all)
// are untouched. A few tests elsewhere (section r's ballTracer/neon smoke
// tests, section s's arrowhead control) had incidentally picked a
// plunge-origin fixture for an unrelated purpose (tracer-ball presence,
// arrowhead chevron presence) — those keep their ORIGINAL intent and just
// swap in a non-plunge fixture, matching section f's "plain goal" shape.
//   New section x (end of file) exercises the REAL Jaws
// data/jaws_goals.json 'skillshot-level-3' goal (shooter-lane plunge:'full'
// -> fish-finder-bank flipper:'right', shooter-lane resolving real
// `feeds:{shot:'mini-flipper'}`) as an honest regression fixture, verified
// against the real bundled drawing.ts before writing its assertions rather
// than assumed — see that section's own header comment (data/ changed
// underneath this task mid-development, from another agent's concurrent
// edit; that comment records both what was true before and what's verified
// true now).
//
// 2026-07-29b — SPEC-PATHVIZ rules 6-7 (flipper-anchored launches/returns +
// ramp continuation; see drawing.ts's header note for the full rule text).
// Rule 6 replaces two FIXED points that used to be geometry-independent —
// the flat DEFAULT_LAUNCH_UV (0.5,0.03) launch anchor for a non-plunger
// 'any'-ballPosition goal, and the fixed RETURN_WAYPOINT_UV (0.5,0.06)
// viaWaypoint waypoint — with a per-segment CHOSEN FLIPPER anchor, decided
// by pure geometry (chooseFlipper's cross-flipper heuristic) whenever no
// explicit step.flipper/shot.flipper is set. That heuristic fires for EVERY
// such segment, including goals with zero schema-v3 fields at all, so three
// PRE-EXISTING sections below needed their expected anchor updated even
// though they predate rule 6 and don't touch feeds/flipper data themselves:
//   - section d's "flipper-hold" sub-test (launch dot)
//   - section e (launch dot)
//   - section f (the launch->target run's seed point)
// Each is annotated in place with the new expected anchor and why. Section
// t's viaWaypoint-corner sub-test is the one case that was already flagged
// for this update; annotated the same way. Section headers/intent below are
// otherwise left as originally written for continuity with the git history.
//
// Sections a-m (unchanged intent from before Shot Coach):
//   a. plunge-first goal, ballPosition 'any': launch dot at the plunger
//      anchor (laneX clamped from the plunge shot's x), plus real clamp-band
//      boundary coverage (x=0.90 and x=1.0 synthetic machines).
//   b. plunge -> low flipper target: 2026-08-11 (phase A7) — the old Case C
//      over-the-arch leg is GONE; both segments of this fixture are
//      plunger-origin, so the whole route draws 0 polyline runs, while the
//      flipper target still rings.
//   c. plunge -> lane-region target: phase A7 — Case A no longer draws
//      either; 0 polyline runs for the plunge->orbit segment.
//   d. skillshot launch-anchor gate: y>=0.15 anchors at the plunger,
//      y<0.15 (flipper-hold instruction) stays at the flat default.
//   e. mid-sequence re-plunge: phase A7 — the segment LEAVING a plunge step
//      is STILL lane-routed (mid-goal re-plunges follow the same no-legs
//      rule as the first launch), so it now draws 0 polyline runs too; the
//      launch-dot assertion is untouched.
//   f. regression: a plain non-plunger goal is untouched.
//   g. Case B arch control: phase A7 — the arch no longer draws; 0 polyline
//      runs.
//   h. Case C junctions: phase A7 — the climb/arch/descent no longer draws;
//      0 polyline runs.
//   i. lane fallback: phase A7 — the "unmappable LANE_TOP junction collapses
//      to one straight leg" mechanism no longer applies to a plunge segment
//      at all (there is no lane geometry left to collapse) — repurposed to
//      prove that: 0 polyline runs regardless of whether LANE_TOP is
//      mappable.
//   j. ballPosition anchor gating.
//   k. degenerate legs: a plunge ring modeled AT the plunger anchor draws NO
//      polyline run at all for that segment — UNCHANGED by phase A7 (this
//      was already the expected result; now true of every OTHER
//      plunger-origin segment too, not just the degenerate one).
//   l. Case A boundary regression (tightened 2026-07-28): phase A7 — both
//      fixtures (Case A and Case B boundary shapes) draw 0 polyline runs
//      now; point-count asserts become 0-run asserts.
//   m. ring captions + map2d declutter + independent emoji-marker gating
//      (shotcoach-corrections.md #3).

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const srcDir = resolve(appDir, 'src')

// ---------------------------------------------------------------------------
// Tiny harness (matches geometry-chain.test.mjs / selftest.mjs / arview-seams.test.mjs)
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
// Minimal in-memory localStorage (section y, 2026-08-11 — shotLines
// persistence round-trip) — this Node has no built-in one (trim-filter.
// test.mjs verified: `node -e "console.log(typeof localStorage)"` ->
// undefined). Installed BEFORE the bundle is imported, matching every other
// suite's own "stub globals before importing" ordering.
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
// Bundle the real modules — drawing.ts (routing/flattening/tracer/rings/
// badges/captions), map2d.ts (drawShotDots' declutter behavior, section m
// only), and (section y) state.ts's readBoolPref/SHOT_LINES_KEY for the
// shotLines persistence round-trip.
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-plunge-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  `export * as drawing from ${JSON.stringify(resolve(srcDir, 'overlay/drawing'))}\n` +
    `export * as map2d from ${JSON.stringify(resolve(srcDir, 'overlay/map2d'))}\n` +
    `export { readBoolPref, SHOT_LINES_KEY } from ${JSON.stringify(resolve(srcDir, 'state'))}\n`,
)
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const { drawing, map2d, readBoolPref, SHOT_LINES_KEY } = await import(pathToFileURL(outfile).href)

// ---------------------------------------------------------------------------
// Synthetic machine + MapFn — a plain rect, v=0 at the bottom (flipper edge).
// ---------------------------------------------------------------------------
const W = 450
const H = 900
const map = (u, v) => ({ x: u * W, y: H - v * H })

const SHOTS = [
  { id: 'plunge', name: 'Plunge', type: 'plunge', x: 0.96, y: 0.3, trim: 'all' },
  { id: 'flipper', name: 'Flipper target', type: 'standup', x: 0.41, y: 0.06, trim: 'all' },
  { id: 'toplane', name: 'Top lane', type: 'lane', x: 0.5, y: 0.95, trim: 'all' },
  { id: 'orbit', name: 'Right orbit', type: 'orbit', x: 0.92, y: 0.5, trim: 'all' },
  { id: 'bumper', name: 'Bumpers', type: 'bumpers', x: 0.6, y: 0.8, trim: 'all' },
  { id: 'basket', name: 'Basket', type: 'ramp', x: 0.85, y: 0.8, trim: 'all' },
  { id: 'rightorbit_low', name: 'Low right orbit', type: 'orbit', x: 0.87, y: 0.5, trim: 'all' },
]
const shotsByID = new Map(SHOTS.map((s) => [s.id, s]))

function goal(id, category, steps) {
  return { id, title: id, category, summary: '', difficulty: 1, steps: steps.map((shot) => ({ shot, action: `Shoot ${shot}` })) }
}

/** 2D-context stub that records every call (method + args, in order) the
 *  real drawing.ts/map2d.ts emits. Property SETS (shadowBlur, lineWidth,
 *  lineCap, ...) are silently accepted and NOT recorded — same limitation
 *  the pre-Shot-Coach harness had; every assertion below works off call
 *  ARGUMENTS (positions, text, gradient-creation counts) for those.
 *  `fillStyle`/`strokeStyle` are the ONE exception (2026-08-11, phase A5/A6 +
 *  live GAUGE feedback): drawPlungeGauge's repaint moves its fill from a
 *  category-color stroke to a `ctx.createLinearGradient` OBJECT assigned to
 *  `fillStyle`, and section v2 below needs to tell "a gradient object" apart
 *  from "a hex color string" — impossible without observing the assignment
 *  itself. Recorded as `{method:'set:fillStyle', args:[value]}` /
 *  `{method:'set:strokeStyle', args:[value]}`; also mirrors the value onto
 *  the underlying `base` object (closer to a real CanvasRenderingContext2D,
 *  though nothing currently reads it back). Every pre-existing call site in
 *  this file's drawing/map2d code sets these styles strictly BETWEEN a
 *  path's moveTo/lineTo/arcTo calls and its stroke()/fill() (never
 *  interleaved mid-path), so recording them here cannot split apart a
 *  polylineRuns() run that would otherwise have stayed whole — verified by
 *  the full pre-existing suite staying green after this change. */
function recordingCtx() {
  const calls = []
  const rec = (method) => (...args) => calls.push({ method, args })
  const noop = () => {}
  const base = {
    canvas: { clientWidth: W, clientHeight: H, width: W * 3, height: H * 3 },
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
    createLinearGradient: (...args) => {
      calls.push({ method: 'createLinearGradient', args })
      return { addColorStop: noop }
    },
    createRadialGradient: (...args) => {
      calls.push({ method: 'createRadialGradient', args })
      return { addColorStop: noop }
    },
    setLineDash: noop,
  }
  const ctx = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => {
      if (k === 'fillStyle' || k === 'strokeStyle') calls.push({ method: `set:${String(k)}`, args: [v] })
      t[k] = v
      return true
    },
  })
  return { ctx, calls }
}

/** Groups moveTo + the lineTo run that immediately follows it into one
 *  "polyline run" — see the file header. arcTo calls (roundedRectPath) are
 *  tracked but not treated as run-continuing lineTo-equivalents, so a
 *  showLabels:true action-bubble's rounded-rect path still shows up as its
 *  own (harmless, ignorable) run rather than corrupting a leg's run. */
function polylineRuns(calls) {
  const runs = []
  let current = null
  for (const c of calls) {
    if (c.method === 'moveTo') {
      current = { points: [{ x: c.args[0], y: c.args[1] }] }
      runs.push(current)
    } else if (c.method === 'lineTo' && current) {
      current.points.push({ x: c.args[0], y: c.args[1] })
    } else if (c.method !== 'arcTo') {
      current = null
    }
  }
  return runs
}

/** The run(s) whose LAST point lands exactly on `target` (within `eps`) —
 *  robustly picks out a leg's STROKE geometry (the flattened polyline's
 *  final sample is the quad curve at t=1, i.e. the target, with zero float
 *  error) as opposed to an arrowhead's pulled-back chevron, regardless of
 *  how many times trailStyle restrokes the same points. */
function runsEndingAt(runs, target, eps = 1e-6) {
  return runs.filter((r) => {
    const last = r.points[r.points.length - 1]
    return Math.abs(last.x - target.x) <= eps && Math.abs(last.y - target.y) <= eps
  })
}

function closestDist(points, target) {
  let best = Infinity
  for (const p of points) best = Math.min(best, Math.hypot(p.x - target.x, p.y - target.y))
  return best
}

// gaugeLabelCalls (drawPlungeGauge's SOFT/FULL PLUNGE halo-label finder) was
// REMOVED 2026-08-11 (phase A12 item 1 — the gauge it read is deleted
// outright). classifyPlunge is called directly now instead — see sections
// m2/u above.

/** Quadratic Bézier midpoint B(0.5) = 0.25*a + 0.5*c + 0.25*b. */
function quadMidpoint(a, c, b) {
  return { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y }
}

/** Perpendicular distance from point `p` to the INFINITE line through `a`
 *  and `b` (not clamped to the segment) — used by the straightness section
 *  (t.) below to prove a flattened polyline sits exactly on its chord. A
 *  quadratic Bézier whose control point is the midpoint of `a`/`b`
 *  degenerates algebraically to the linear interpolation `a + t*(b-a)`, so
 *  every sampled point should land on this line to within float error. */
function perpDist(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}

/** `opts` lets a test swap in a custom MapFn/catalog, override highlight
 *  mode, or toggle showLabels/trailStyle/ballTracer without disturbing the
 *  shared SHOTS/map used everywhere else. `ballTracer` defaults to false
 *  (deterministic two-state active/quiet geometry, per the file header) —
 *  override explicitly for tracer/manual-mode tests. */
function draw(g, ballPosition, opts = {}) {
  const {
    time = 1000,
    map: mapOverride,
    shotsByID: shotsOverride,
    showLabels,
    trailStyle,
    ballTracer = false,
    highlightIndex,
    topInset,
    shotLines,
  } = opts
  const { ctx, calls } = recordingCtx()
  const o = {
    shotsByID: shotsOverride ?? shotsByID,
    goal: g,
    stepIndex: 0,
    ballPosition,
    map: mapOverride ?? map,
    time,
    ballTracer,
  }
  if (showLabels !== undefined) o.showLabels = showLabels
  if (trailStyle !== undefined) o.trailStyle = trailStyle
  if (highlightIndex !== undefined) o.highlightIndex = highlightIndex
  if (topInset !== undefined) o.topInset = topInset
  if (shotLines !== undefined) o.shotLines = shotLines
  const result = drawing.drawGoalOverlay(ctx, o)
  return { calls, runs: polylineRuns(calls), result }
}

// Expected plunger anchor for this synthetic machine: plunge shot x=0.96,
// clamped to [0.93,0.98] -> 0.96 (no clamping actually applied here).
const LANE_X = 0.96
const PLUNGER_ANCHOR = map(LANE_X, 0.02)
const DEFAULT_ANCHOR = map(0.5, 0.03)
// SPEC-PATHVIZ rule 5's LANE_TOP is (laneX, 0.88) — a segment that reaches
// the shooter lane's top junction (or beyond, into the arch) samples a point
// at v>=0.88; 0.86 keeps a hair of float slack below that spec constant so
// quad-curve sampling can't miss it by a rounding error.
const LANE_TOP_Y_MAX = H - 0.86 * H

// ===========================================================================
section('a. plunge-first goal, ballPosition any: launch dot at the plunger anchor')
// ===========================================================================

await test('white launch dot (first arc call) lands at map(laneX, 0.02)', () => {
  const g = goal('g-plunge-first', 'combo', ['plunge', 'flipper'])
  const { calls } = draw(g, 'any')
  const firstArc = calls.find((c) => c.method === 'arc')
  assert(firstArc, 'expected an arc() call for the launch dot')
  const [x, y] = firstArc.args
  close(x, PLUNGER_ANCHOR.x, 1e-6, 'launch dot x')
  close(y, PLUNGER_ANCHOR.y, 1e-6, 'launch dot y')
  return `arc(${x.toFixed(1)}, ${y.toFixed(1)}) == map(${LANE_X}, 0.02) == (${PLUNGER_ANCHOR.x}, ${PLUNGER_ANCHOR.y})`
})

await test('clamp band LOW bound: plunge shot x=0.90 (outside [0.93,0.98]) -> laneX clamps to 0.93', () => {
  const shots = new Map([['plunge', { id: 'plunge', name: 'Plunge', type: 'plunge', x: 0.9, y: 0.3, trim: 'all' }]])
  const g = goal('g-clamp-low', 'combo', ['plunge'])
  const { calls } = draw(g, 'any', { shotsByID: shots })
  const firstArc = calls.find((c) => c.method === 'arc')
  const expected = map(0.93, 0.02)
  const [x, y] = firstArc.args
  close(x, expected.x, 1e-6, 'launch dot x')
  close(y, expected.y, 1e-6, 'launch dot y')
  return `plunge shot x=0.90 (below the band) -> launch dot at map(0.93, 0.02) = (${expected.x}, ${expected.y})`
})

await test('clamp band HIGH bound: plunge shot x=1.0 (outside [0.93,0.98]) -> laneX clamps to 0.98', () => {
  const shots = new Map([['plunge', { id: 'plunge', name: 'Plunge', type: 'plunge', x: 1.0, y: 0.3, trim: 'all' }]])
  const g = goal('g-clamp-high', 'combo', ['plunge'])
  const { calls } = draw(g, 'any', { shotsByID: shots })
  const firstArc = calls.find((c) => c.method === 'arc')
  const expected = map(0.98, 0.02)
  const [x, y] = firstArc.args
  close(x, expected.x, 1e-6, 'launch dot x')
  close(y, expected.y, 1e-6, 'launch dot y')
  return `plunge shot x=1.0 (above the band) -> launch dot at map(0.98, 0.02) = (${expected.x}, ${expected.y})`
})

// ===========================================================================
section('b. plunge -> low flipper target: leaving segment goes over the top first')
// ===========================================================================

await test("phase A7: the segment leaving the plunge ring draws NO polyline any more; the flipper target still rings WHEN ACTIVE (item 5 supersedes this test's original \"still rings [while inactive]\" premise)", () => {
  // 2026-08-11 (phase A7): the old Case-C climb/arch/descent this test used
  // to assert (reaching y<=LANE_TOP_Y_MAX before diving to the low target)
  // no longer draws at all. Both segments of THIS fixture are plunger-origin
  // — step 0's own target IS the 'plunge' shot, so the segment LEAVING it
  // (step 1, ->flipper) counts as a mid-sequence re-plunge under the
  // unchanged D1 fromPlungerAt rule, same no-legs treatment as the first
  // launch (requirement: "mid-goal re-plunges: same rule"). `showLabels:
  // false` keeps the run list to leg/arrowhead geometry only — without it
  // the action-label bubble's own rounded-rect polyline (pinned near the
  // canvas top, well above LANE_TOP_Y_MAX) would have made the OLD assertion
  // here pass for the wrong reason regardless of whether the route itself
  // drew anything, which is exactly why this test needed reworking rather
  // than trusting its old green checkmark.
  // 2026-08-11 (phase A12 item 5, same day): step 1 (flipper) is not the
  // default-active step (0) — its ring is now SUPPRESSED while inactive, and
  // only appears once IT is active (highlightIndex:1). Both halves are
  // checked below so this test still proves its original point (a leg-less
  // target still rings) without contradicting item 5's active-only gate.
  const g = goal('g-plunge-to-flipper', 'combo', ['plunge', 'flipper'])
  const plungeView = map(SHOTS[0].x, SHOTS[0].y)
  const flipperView = map(SHOTS[1].x, SHOTS[1].y)
  const ringsAt = (calls, p) => calls.filter((c) => c.method === 'arc' && Math.abs(c.args[0] - p.x) <= 1e-6 && Math.abs(c.args[1] - p.y) <= 1e-6)

  const { runs, calls } = draw(g, 'any', { showLabels: false })
  const runsToPlunge = runsEndingAt(runs, plungeView)
  const runsToFlipper = runsEndingAt(runs, flipperView)
  assert(runsToPlunge.length === 0, `expected 0 drawn polyline runs ending at the plunge target (segment 0, plunger-origin), got ${runsToPlunge.length}`)
  assert(runsToFlipper.length === 0, `expected 0 drawn polyline runs ending at the flipper target (segment 1, ALSO plunger-origin — a re-plunge), got ${runsToFlipper.length}`)
  assert(ringsAt(calls, flipperView).length === 0, `expected step 1's ring suppressed while step 0 is active (item 5), got ${ringsAt(calls, flipperView).length}`)

  const { calls: callsActive } = draw(g, 'any', { showLabels: false, highlightIndex: 1 })
  const ringsAtFlipperActive = ringsAt(callsActive, flipperView)
  assert(ringsAtFlipperActive.length > 0, `expected the flipper target to still get its ring/badge arc() calls once ACTIVE, even with its leg gone, got ${ringsAtFlipperActive.length}`)
  return `both segments are plunger-origin (0 drawn polyline runs at either target); step 1's ring is suppressed while inactive and draws ${ringsAtFlipperActive.length} ring/badge arc() call(s) once active — proving rings don't depend on the removed legs`
})

// ===========================================================================
section('c. plunge -> lane-region target: Case A stays inside the lane')
// ===========================================================================

await test('phase A7: the plunge->orbit segment draws NO polyline any more (Case A is gone too)', () => {
  // Pre-phase-A7 this asserted a 23-point Case-A run staying inside the
  // lane's x band; Case A no longer draws at all now, so the honest
  // rework is simply "no run reaches the orbit target".
  const g = goal('g-plunge-to-orbit', 'combo', ['plunge', 'orbit'])
  const { runs } = draw(g, 'any', { showLabels: false })
  const orbitView = map(SHOTS[3].x, SHOTS[3].y)
  const stroke = runsEndingAt(runs, orbitView)
  assert(stroke.length === 0, `expected 0 drawn polyline runs ending at the orbit target (plunger-origin, formerly a 23-point Case-A run), got ${stroke.length}`)
  return `plunge->orbit draws 0 polyline runs now — the Case-A lane leg is gone, only the ring/gauge remain to represent the plunge`
})

// ===========================================================================
section('d. skillshot launch-anchor gate (SPEC-BALLSTART y>=0.15 vs the flipper-hold y<=0.06 case)')
// ===========================================================================

await test('skillshot goal, first target y>=0.15 (non-plunge shot): launch dot still anchors at the plunger', () => {
  const g = goal('g-skillshot-high', 'skillshot', ['toplane']) // toplane.y = 0.95 >= 0.15, type 'lane' (not plunge)
  const { calls } = draw(g, 'any')
  const firstArc = calls.find((c) => c.method === 'arc')
  const [x, y] = firstArc.args
  close(x, PLUNGER_ANCHOR.x, 1e-6, 'launch dot x')
  close(y, PLUNGER_ANCHOR.y, 1e-6, 'launch dot y')
  return `skillshot first target y=0.95 >= 0.15 -> startsFromPlunger even though its own shot type is '${SHOTS[2].type}' -> launch dot at the plunger anchor (${x.toFixed(1)}, ${y.toFixed(1)})`
})

await test('skillshot goal, first target y<=0.06 (flipper-hold instruction): launch dot stays OFF the plunger, at the rule-6 flipper anchor', () => {
  // 2026-07-29b (SPEC-PATHVIZ rule 6a): the y-gate below 0.15 still keeps
  // this OFF the plunger anchor, same as always — but a non-plunger 'any'
  // launch no longer falls back to the flat DEFAULT_LAUNCH_UV (0.5,0.03)
  // either. chooseFlipper(target=(0.41,0.06), origin=DEFAULT_LAUNCH_UV,
  // no explicit step/shot flipper): target.x=0.41 < 0.45 -> 'right' ->
  // FLIPPER_ANCHORS.right = (0.60, 0.04) (models.ts BALL_ANCHORS.rightFlipper).
  const g = goal('g-skillshot-low', 'skillshot', ['flipper']) // flipper.y = 0.06 < 0.15
  const { calls } = draw(g, 'any')
  const firstArc = calls.find((c) => c.method === 'arc')
  const [x, y] = firstArc.args
  const expected = map(0.6, 0.04) // FLIPPER_ANCHORS.right
  close(x, expected.x, 1e-6, 'launch dot x')
  close(y, expected.y, 1e-6, 'launch dot y')
  assert(Math.abs(x - PLUNGER_ANCHOR.x) > 1e-3 || Math.abs(y - PLUNGER_ANCHOR.y) > 1e-3, 'launch dot must NOT be pulled to the plunger anchor')
  return `skillshot first target y=0.06 < 0.15 -> the y-gate still keeps it off the plunger, but rule 6a now anchors at the chosen flipper (right, target x=0.41<0.45): (${x.toFixed(1)}, ${y.toFixed(1)}) == map(0.60, 0.04), not the old flat map(0.5,0.03)`
})

// ===========================================================================
section('e. mid-sequence re-plunge: the segment LEAVING a later plunge step lane-routes')
// ===========================================================================

await test('goal [orbit, plunge, flipper]: segment 2 (leaving the re-plunge) draws NO polyline any more', () => {
  // 2026-07-29b (SPEC-PATHVIZ rule 6a): this goal still doesn't START at the
  // plunger (step 0 is 'orbit', not plunge-type), so plungerLaunch is still
  // false — but the non-plunger 'any' launch anchor is now the rule-6
  // flipper anchor, not the flat DEFAULT_LAUNCH_UV.
  // chooseFlipper(target=orbit(0.92,0.5), origin=DEFAULT_LAUNCH_UV, no
  // explicit flipper): target.x=0.92 > 0.55 -> 'left' -> FLIPPER_ANCHORS.left
  // = (0.40, 0.04).
  // 2026-08-11 (phase A7): segment 2 (leaving step 1's 'plunge' target) used
  // to reach y<=LANE_TOP_Y_MAX (a Case-C climb) — mid-goal re-plunges follow
  // the SAME no-legs rule as the first launch now, so it draws nothing
  // instead. Segment 1 (orbit->plunge, arriving AT the re-plunge target) is
  // NOT plunger-origin — its own origin isn't a plunge shot — and is
  // untouched by this phase; this test doesn't scrutinize it directly, only
  // the launch dot (segment 0's origin) and segment 2 (leaving the
  // re-plunge).
  const g = goal('g-mid-replunge', 'combo', ['orbit', 'plunge', 'flipper'])
  const { calls, runs } = draw(g, 'any', { showLabels: false })
  const firstArc = calls.find((c) => c.method === 'arc')
  const [lx, ly] = firstArc.args
  const expectedLaunch = map(0.4, 0.04) // FLIPPER_ANCHORS.left
  close(lx, expectedLaunch.x, 1e-6, 'launch dot x (rule-6 flipper anchor, goal does not start at the plunger)')
  close(ly, expectedLaunch.y, 1e-6, 'launch dot y (rule-6 flipper anchor, goal does not start at the plunger)')

  const flipperView = map(SHOTS[1].x, SHOTS[1].y)
  const runsToFlipper = runsEndingAt(runs, flipperView)
  assert(runsToFlipper.length === 0, `expected the re-plunge-leaving segment to draw 0 polyline runs, got ${runsToFlipper.length}`)
  return `launch anchored at the rule-6 flipper anchor (${lx.toFixed(1)}, ${ly.toFixed(1)}) == map(0.40,0.04) since the GOAL doesn't start at the plunger (only rule 6a's y/x heuristic applies); the mid-sequence segment leaving step 1 (the re-plunge) now draws 0 polyline runs — same no-legs rule as the first launch`
})

// ===========================================================================
section('f. regression: a plain non-plunger goal is untouched')
// ===========================================================================

await test('goal [flipper, orbit]: rule-6 flipper launch anchor, launch segment never enters the lane region', () => {
  // 2026-07-29b (SPEC-PATHVIZ rule 6a): this is still a "plain" non-plunger
  // goal in the sense this test cares about (the launch segment must never
  // route into the shooter-lane region) — but the launch anchor itself is
  // no longer the flat DEFAULT_LAUNCH_UV. chooseFlipper(target=flipper
  // (0.41,0.06), origin=DEFAULT_LAUNCH_UV): target.x=0.41 < 0.45 -> 'right'
  // -> FLIPPER_ANCHORS.right = (0.60, 0.04) (same anchor as section d's
  // now-updated skillshot-low sub-test, same target shot).
  const g = goal('g-plain', 'combo', ['flipper', 'orbit'])
  const { runs } = draw(g, 'any')
  const flipperView = map(SHOTS[1].x, SHOTS[1].y)
  const stroke = runsEndingAt(runs, flipperView).find((r) => r.points.length > 3)
  assert(stroke, 'expected to find the launch->flipper stroke run')
  const expectedLaunch = map(0.6, 0.04) // FLIPPER_ANCHORS.right
  close(stroke.points[0].x, expectedLaunch.x, 1e-6, 'run seed x (rule-6 flipper launch anchor)')
  close(stroke.points[0].y, expectedLaunch.y, 1e-6, 'run seed y (rule-6 flipper launch anchor)')
  const laneRegionX = 0.9 * W
  const touchedLane = stroke.points.some((p) => p.x > laneRegionX)
  assert(!touchedLane, 'launch segment must never enter the lane region (x > 0.9*W) for a non-plunger goal')
  return `run seeded at (${expectedLaunch.x}, ${expectedLaunch.y}) == map(0.60,0.04) (rule-6 flipper anchor, not the old flat map(0.5,0.03)); launch segment stayed clear of x>${laneRegionX} (the lane region)`
})

// ===========================================================================
section('g. Case B arch control — curve-sampling assert (SPEC-PATHVIZ rule 5)')
// ===========================================================================

await test('phase A7: plunge -> toplane draws NO polyline any more (the Case B arch is gone)', () => {
  // Pre-phase-A7 this asserted the flattened polyline passed within 1.5px of
  // the Case B arch's B(0.5) midpoint, reached y<=LANE_TOP_Y_MAX, and formed
  // a 45-point 2-leg run. The arch no longer draws at all now — laneRoute
  // still COMPUTES that geometry internally on every call (it's what
  // `partial` comes from — see routeSegment's `fromPlunger` branch), but
  // routeSegment discards the legs outright, so the arch's specific CURVE
  // SHAPE is no longer independently observable through any drawn output
  // (canvas calls or the gauge) — same as every other case's control-point
  // formula in this now-legless regime.
  const g = goal('g-case-b-control', 'combo', ['plunge', 'toplane'])
  const { runs } = draw(g, 'any', { showLabels: false })
  const toplaneView = map(0.5, 0.95)
  const stroke = runsEndingAt(runs, toplaneView)
  assert(stroke.length === 0, `expected 0 drawn polyline runs ending at the toplane target (formerly a 45-point Case-B run), got ${stroke.length}`)
  return `plunge->toplane draws 0 polyline runs now — the Case-B climb+arch is gone, only the ring/gauge remain`
})

// ===========================================================================
section('h. Case C junctions — curve-sampling asserts (SPEC-PATHVIZ rule 5)')
// ===========================================================================

await test('phase A7: plunge -> flipper draws NO polyline any more (the Case C climb/arch/descent is gone)', () => {
  // Pre-phase-A7 this asserted a 67-point 3-leg run with exact LANE_TOP/
  // ARCH_ENTRY junction samples and an arch-leg midpoint within 1.5px of the
  // expected control geometry. None of that draws any more — same fixture
  // as section b above (['plunge','flipper']), which additionally confirms
  // the flipper target still rings even with 0 legs drawn.
  const g = goal('g-case-c-junctions', 'combo', ['plunge', 'flipper'])
  const { runs } = draw(g, 'any', { showLabels: false })
  const flipperView = map(SHOTS[1].x, SHOTS[1].y)
  const stroke = runsEndingAt(runs, flipperView)
  assert(stroke.length === 0, `expected 0 drawn polyline runs ending at the flipper target (formerly a 67-point Case-C run), got ${stroke.length}`)
  return `plunge->flipper draws 0 polyline runs now — the Case-C climb/arch/descent is gone, only the ring/gauge remain`
})

// ===========================================================================
section('i. lane fallback: an unmappable LANE_TOP junction collapses the chained segment to ONE straight leg')
// ===========================================================================

await test('phase A7: an unmappable LANE_TOP junction is now IRRELEVANT — the plunge segment draws 0 polyline runs either way', () => {
  // Pre-phase-A7 this proved a NaN at the LANE_TOP junction (laneX, 0.88)
  // collapsed the whole chained lane route down to one straight leg (67
  // points -> 23). That fallback ran on legsForRoute's MAPPED control
  // points — with `legs` now always empty for a 'lane' route (routeSegment
  // discards them, see its own doc comment), map() is never even ASKED for
  // the LANE_TOP coordinate any more (there is no leg control point left to
  // map), so there is nothing left for a NaN at that exact coordinate to
  // collapse. Repurposed to prove exactly that: the normal map and a map
  // that returns NaN at LANE_TOP produce the IDENTICAL (empty) result for
  // this segment — the old collapse mechanism is dead code in practice for
  // a plunge segment, not merely untriggered by this one fixture.
  const nanAtLaneTop = (u, v) => (Math.abs(u - LANE_X) < 1e-9 && Math.abs(v - 0.88) < 1e-9 ? { x: NaN, y: NaN } : map(u, v))
  const g = goal('g-lane-fallback', 'combo', ['plunge', 'flipper'])
  const flipperView = map(SHOTS[1].x, SHOTS[1].y)

  const { runs: normalRuns } = draw(g, 'any', { showLabels: false })
  const normalStroke = runsEndingAt(normalRuns, flipperView)
  assert(normalStroke.length === 0, `expected 0 drawn polyline runs under the normal map (formerly a 67-point Case-C run), got ${normalStroke.length}`)

  const { runs: fallbackRuns } = draw(g, 'any', { map: nanAtLaneTop, showLabels: false })
  const fallbackStroke = runsEndingAt(fallbackRuns, flipperView)
  assert(fallbackStroke.length === 0, `expected 0 drawn polyline runs under the NaN-at-LANE_TOP map too (nothing left to collapse), got ${fallbackStroke.length}`)

  return `plunge->flipper draws 0 polyline runs under BOTH the normal map and a map that returns NaN at the old LANE_TOP junction — that junction is never queried any more, so the old collapse-to-a-straight-leg fallback has nothing left to fire on`
})

// ===========================================================================
section('j. ballPosition anchor gating')
// ===========================================================================

await test("ballPosition 'plunger' uses the dynamic (laneX, 0.02) anchor, never the static BALL_ANCHORS.plunger (0.97, 0.10)", () => {
  const g = goal('g-explicit-plunger', 'combo', ['flipper']) // not plunge-first — only ballPosition drives the anchor here
  const { calls } = draw(g, 'plunger')
  const firstArc = calls.find((c) => c.method === 'arc')
  const [x, y] = firstArc.args
  const staticAnchor = map(0.97, 0.1) // BALL_ANCHORS.plunger, models.ts
  close(x, PLUNGER_ANCHOR.x, 1e-6, 'launch dot x (dynamic anchor)')
  close(y, PLUNGER_ANCHOR.y, 1e-6, 'launch dot y (dynamic anchor)')
  assert(Math.abs(y - staticAnchor.y) > 1e-3, 'launch dot must NOT land at the static BALL_ANCHORS.plunger y')
  return `arc(${x.toFixed(1)}, ${y.toFixed(1)}) == dynamic map(${LANE_X}, 0.02); static BALL_ANCHORS.plunger would have been (${staticAnchor.x.toFixed(1)}, ${staticAnchor.y.toFixed(1)})`
})

await test("ballPosition 'leftFlipper' is never overridden, even for a plunge-first goal", () => {
  const g = goal('g-plunge-first-left-flipper', 'combo', ['plunge', 'flipper'])
  const { calls } = draw(g, 'leftFlipper')
  const firstArc = calls.find((c) => c.method === 'arc')
  const [x, y] = firstArc.args
  const leftFlipperAnchor = map(0.4, 0.04) // BALL_ANCHORS.leftFlipper, models.ts
  close(x, leftFlipperAnchor.x, 1e-6, 'launch dot x (explicit leftFlipper anchor)')
  close(y, leftFlipperAnchor.y, 1e-6, 'launch dot y (explicit leftFlipper anchor)')
  assert(Math.abs(x - PLUNGER_ANCHOR.x) > 1e-3 || Math.abs(y - PLUNGER_ANCHOR.y) > 1e-3, 'launch dot must NOT be pulled to the plunger anchor')
  return `explicit leftFlipper position wins even though the goal starts from the plunge: arc(${x.toFixed(1)}, ${y.toFixed(1)}) == map(0.40, 0.04)`
})

// ===========================================================================
section('k. degenerate legs (SPEC-PATHVIZ rule 5, added 2026-07-28)')
// ===========================================================================

await test('plunge ring modeled AT the plunger anchor draws NO polyline run at all — no detached arrowhead chevron', () => {
  // A machine whose only shot is a plunge ring sitting exactly at (laneX,
  // 0.02) — the dynamic plunger anchor itself. The launch segment's Case-A
  // leg then runs anchor->ring with ZERO mapped length: the degenerate-leg
  // rule must skip it entirely (flats[0] === null), so Pass 1 draws nothing
  // for it at all — no stroke run, no arrowhead run — rather than a
  // zero-length stroke with a detached 32px-pulled-back arrowhead floating
  // behind the dot.
  const ringOnAnchor = new Map([['ring', { id: 'ring', name: 'Ring', type: 'plunge', x: LANE_X, y: 0.02, trim: 'all' }]])
  const g = goal('g-degenerate-ring', 'combo', ['ring'])
  const { runs } = draw(g, 'any', { shotsByID: ringOnAnchor, showLabels: false })
  assert(runs.length === 0, `expected NO polyline runs for the degenerate ring segment, got ${runs.length}`)
  return `ring modeled at the anchor (${LANE_X}, 0.02): 0 polyline runs — nothing drawn for the segment but the dot/ring/badge`
})

// ===========================================================================
section('l. Case A boundary regression (tightened 2026-07-28)')
// ===========================================================================

await test('phase A7: basket (0.85, 0.80) — the old Case B arch draws NO polyline any more', () => {
  // Pre-phase-A7 this asserted a 45-point Case-B run (climb + arch) reaching
  // the lane top, proving the tightened boundary routed this beside-the-lane
  // -but-high target OVER THE TOP rather than a straight Case-A diagonal.
  // That distinction is invisible on the canvas now — both Case A and Case B
  // draw nothing — so the honest rework is just "no run at all".
  const g = goal('g-boundary-basket', 'combo', ['plunge', 'basket'])
  const { runs } = draw(g, 'any', { showLabels: false })
  const basketView = map(0.85, 0.8)
  const stroke = runsEndingAt(runs, basketView)
  assert(stroke.length === 0, `expected 0 drawn polyline runs ending at the basket target (formerly a 45-point Case-B run), got ${stroke.length}`)
  return `plunge->basket draws 0 polyline runs now — Case A and Case B are equally invisible, only the ring/gauge remain`
})

await test('phase A7: rightorbit_low (0.87, 0.50) — the old Case A exit draws NO polyline any more', () => {
  // Pre-phase-A7 this asserted a 23-point single-leg Case-A run, proving the
  // tightened boundary still routed this low, near-lane target as a direct
  // exit rather than Case B's arch. Same "invisible either way" rework.
  const g = goal('g-boundary-orbit-low', 'combo', ['plunge', 'rightorbit_low'])
  const { runs } = draw(g, 'any', { showLabels: false })
  const orbitView = map(0.87, 0.5)
  const stroke = runsEndingAt(runs, orbitView)
  assert(stroke.length === 0, `expected 0 drawn polyline runs ending at the rightorbit_low target (formerly a 23-point Case-A run), got ${stroke.length}`)
  return `plunge->rightorbit_low draws 0 polyline runs now — only the ring/gauge remain`
})

// ===========================================================================
section('m. ring captions + map2d declutter + independent emoji-marker gating')
// ===========================================================================

await test('drawGoalOverlay captions each step ring with its shot name once, deduping a repeated shot id', () => {
  const g = goal('g-caption-dedupe', 'combo', ['orbit', 'orbit']) // both steps reference the SAME shot id
  const { calls } = draw(g, 'any')
  const captionCalls = calls.filter((c) => c.method === 'fillText' && c.args[0] === 'Right orbit')
  assert(captionCalls.length === 1, `expected exactly 1 caption fillText for the repeated shot, got ${captionCalls.length}`)
  const [, x, y] = captionCalls[0].args
  const orbitView = map(SHOTS[3].x, SHOTS[3].y)
  close(x, orbitView.x, 1e-6, 'caption x (centered on the ring)')
  close(y, orbitView.y - 13, 1e-6, 'caption y (13 view units above the ring center)')
  return `1 'Right orbit' caption at (${x.toFixed(1)}, ${y.toFixed(1)}) == (target.x, target.y - 13), despite 2 steps sharing the shot`
})

await test("showLabels:false hides ONLY the action-label bubble — the ring caption (target NAME) always draws (2026-08-11, phase A13 — rolo: \"if you remove path bubbles from the map setting only remove the bubble; keep the name of the targets popping up\")", () => {
  const g = goal('g-caption-off', 'combo', ['orbit']) // action text: 'Shoot orbit'; ring caption: shot.name 'Right orbit'
  const nameCalls = (calls) => calls.filter((c) => c.method === 'fillText' && c.args[0] === 'Right orbit')
  const bubbleCalls = (calls) => calls.filter((c) => c.method === 'fillText' && c.args[0] === 'Shoot orbit')

  const off = draw(g, 'any', { showLabels: false }).calls
  assert(nameCalls(off).length === 1, `expected the target NAME label ('Right orbit') to still draw with showLabels:false, got ${nameCalls(off).length}`)
  assert(bubbleCalls(off).length === 0, `expected the action-label bubble ('Shoot orbit') suppressed with showLabels:false, got ${bubbleCalls(off).length}`)

  const on = draw(g, 'any', { showLabels: true }).calls
  assert(nameCalls(on).length === 1, `expected the target NAME label to still draw with showLabels:true, got ${nameCalls(on).length}`)
  assert(bubbleCalls(on).length === 1, `expected the action-label bubble to draw with showLabels:true, got ${bubbleCalls(on).length}`)

  return `showLabels:false -> name label drew (1), bubble suppressed (0); showLabels:true -> both drew (1 each)`
})

await test('emoji glyph chips never draw (feature removed 2026-07-29 — rolo: playfield emoji too distracting)', () => {
  const g = goal('g-emoji-removed', 'combo', ['orbit']) // type 'orbit' had glyph 🌀
  const { calls } = draw(g, 'any', { showLabels: true })
  const captionCalls = calls.filter((c) => c.method === 'fillText' && c.args[0] === 'Right orbit')
  const emojiCalls = calls.filter(
    (c) => c.method === 'fillText' && typeof c.args[0] === 'string' && /\p{Extended_Pictographic}/u.test(c.args[0]),
  )
  assert(captionCalls.length === 1, `expected the caption to still draw (showLabels:true), got ${captionCalls.length}`)
  assert(emojiCalls.length === 0, `expected 0 emoji fillText calls anywhere in the overlay, got ${emojiCalls.length}`)
  return `caption drew, and no emoji glyph reached the canvas`
})

await test('drawShotDots with a non-empty routeShotIDs draws zero labels (declutter — the overlay caption is the only name)', () => {
  const { ctx, calls } = recordingCtx()
  map2d.drawShotDots(ctx, SHOTS, map, { routeShotIDs: new Set(['plunge']) })
  const labelCalls = calls.filter((c) => c.method === 'fillText' || c.method === 'strokeText')
  assert(labelCalls.length === 0, `expected 0 label calls (fillText/strokeText) while decluttered, got ${labelCalls.length}`)
  return `routeShotIDs={'plunge'} -> 0 fillText/strokeText calls across ${SHOTS.length} shots (route dot label dropped too — the overlay caption already names it)`
})

await test('drawShotDots without routeShotIDs still draws ambient-major labels (unchanged rest state)', () => {
  const { ctx, calls } = recordingCtx()
  map2d.drawShotDots(ctx, SHOTS, map)
  const labelCalls = calls.filter((c) => c.method === 'fillText')
  assert(labelCalls.length > 0, 'expected ambient-major fillText labels with no routeShotIDs')
  return `no routeShotIDs -> ${labelCalls.length} ambient-major label fillText call(s), same as today's no-goal browse state`
})

// ===========================================================================
section("m3. banner label exclusion (2026-08-11, phase A12 item 3 — rolo's screenshot: target NAME labels near the top of the playfield get covered by the goal banner/pill)")
// ===========================================================================
// Pass 2.5's ring caption flips BELOW the ring (floored clear of the band)
// instead of merely clamping in place, whenever the default above-the-ring
// position would land inside the reserved topInset band — see drawing.ts's
// header note. topInset=72 mirrors map2d.ts's real TOP_PAD, threaded through
// this file's draw() helper (extended for this section) the same way
// map2d.ts's own renderMainLevel() passes `topInset: TOP_PAD` for real.

await test('synthetic target at y=0.93 (near the top of the table): its caption lands AT/BELOW the reserved top-inset region, not clamped inside it', () => {
  const topShots = new Map([['top', { id: 'top', name: 'Top Target', type: 'standup', x: 0.5, y: 0.93, trim: 'all' }]])
  const g = goal('g-banner-high', 'combo', ['top'])
  const { calls } = draw(g, 'any', { shotsByID: topShots, topInset: 72, showLabels: true })
  const caption = calls.find((c) => c.method === 'fillText' && c.args[0] === 'Top Target')
  assert(caption, 'expected the ring caption to draw')
  const [, , y] = caption.args
  const target = map(0.5, 0.93)
  assert(y >= 72, `expected the caption y (${y}) to sit at/below the top-inset region (topInset=72), not clamped inside it`)
  const oldClampY = target.y - 13
  assert(Math.abs(y - oldClampY) > 1, `fixture sanity: the OLD in-place-clamp default position (target.y-13=${oldClampY.toFixed(1)}) must differ visibly from the new flipped position, got y=${y}`)
  return `target at y=0.93 (canvas y=${target.y.toFixed(1)}): caption flipped to y=${y}, clear of the topInset=72 region (the old clamp-in-place formula would have left it at y=${oldClampY.toFixed(1)}, still inside the band)`
})

await test("a low target (y=0.1) keeps today's placement — the caption stays above the ring, unaffected by the banner-exclusion band", () => {
  const lowShots = new Map([['low', { id: 'low', name: 'Low Target', type: 'standup', x: 0.5, y: 0.1, trim: 'all' }]])
  const g = goal('g-banner-low', 'combo', ['low'])
  const { calls } = draw(g, 'any', { shotsByID: lowShots, topInset: 72, showLabels: true })
  const caption = calls.find((c) => c.method === 'fillText' && c.args[0] === 'Low Target')
  assert(caption, 'expected the ring caption to draw')
  const [, , y] = caption.args
  const target = map(0.5, 0.1)
  close(y, target.y - 13, 1e-6, "low target's caption y (today's unflipped placement, target.y - 13)")
  return `target at y=0.1 (canvas y=${target.y.toFixed(1)}): caption stays at y=${y} (target.y-13) — today's placement, unaffected by the banner-exclusion band`
})

await test('map2d.drawShotDots: an ambient major-shot label near the top also flips clear of the reserved band', () => {
  const topOrbit = { id: 'top-orbit', name: 'Top Orbit', type: 'orbit', x: 0.5, y: 0.95, trim: 'all' }
  const { ctx, calls } = recordingCtx()
  map2d.drawShotDots(ctx, [topOrbit], map, { topInset: 72 })
  const label = calls.find((c) => c.method === 'fillText' && c.args[0] === 'TOP ORBIT')
  assert(label, 'expected the ambient major-shot label to draw')
  const [, , y] = label.args
  const point = map(0.5, 0.95)
  assert(y >= 72, `expected the label y (${y}) to sit at/below the top-inset region (topInset=72)`)
  const oldY = point.y - 11
  assert(Math.abs(y - oldY) > 1, `fixture sanity: the old above-the-dot default (point.y-11=${oldY.toFixed(1)}) must differ visibly from the flipped position, got y=${y}`)
  return `ambient major label near the top (canvas y=${point.y.toFixed(1)}) flips to y=${y}, clear of the topInset=72 region (old default y=${oldY.toFixed(1)} would have been inside it)`
})

// ===========================================================================
section('m4. active-target-only display (2026-08-11, phase A12 item 5 — rolo: "only display the name of the target you need to hit for that specific spot of all shots")')
// ===========================================================================
// A multi-step goal now draws exactly ONE step's ring+badge+caption at a
// time — the ACTIVE one — regardless of how many steps the goal has;
// advancing the active step (via highlightIndex, mirroring state.stepIndex
// in the real app) moves which one shows. Sections a-x elsewhere in this
// file (and ramp-route.test.mjs / deck-route.test.mjs) already prove this
// piecemeal for individual routing fixtures via highlightIndex; this is the
// single general-purpose proof the owner's brief asked for directly.

await test("a 3-step goal at stepIndex=k records exactly ONE ring/badge/caption set, and it is step k's; advancing (k=0,1,2) moves it", () => {
  const g = goal('g-active-only', 'multiball', ['orbit', 'bumper', 'basket'])
  const targets = [map(SHOTS[3].x, SHOTS[3].y), map(SHOTS[4].x, SHOTS[4].y), map(SHOTS[5].x, SHOTS[5].y)] // orbit, bumper, basket
  const names = ['Right orbit', 'Bumpers', 'Basket']
  const ringAt = (calls, p) => calls.filter((c) => c.method === 'arc' && Math.abs(c.args[0] - p.x) <= 1e-6 && Math.abs(c.args[1] - p.y) <= 1e-6)
  const report = []
  for (let k = 0; k < 3; k++) {
    const { calls } = draw(g, 'any', { highlightIndex: k, showLabels: true })
    for (let i = 0; i < 3; i++) {
      const arcs = ringAt(calls, targets[i])
      const caption = calls.find((c) => c.method === 'fillText' && c.args[0] === names[i])
      if (i === k) {
        assert(arcs.length > 0, `expected step ${k}'s ring/badge to draw while it is active (stepIndex=${k}), found ${arcs.length} arcs at its target`)
        assert(caption, `expected step ${k}'s caption ('${names[k]}') to draw while it is active (stepIndex=${k})`)
      } else {
        assert(arcs.length === 0, `expected step ${i}'s ring/badge suppressed while step ${k} is active (stepIndex=${k}), found ${arcs.length} arcs`)
        assert(!caption, `expected step ${i}'s caption ('${names[i]}') suppressed while step ${k} is active (stepIndex=${k})`)
      }
    }
    report.push(`k=${k}->'${names[k]}' only`)
  }
  return `3-step goal ['orbit','bumper','basket']: ${report.join(', ')} — exactly one ring/badge/caption set drew at every stepIndex, always step k's own, nothing else`
})

// ===========================================================================
section('m1b. The numbered badge draws ONLY when its number could say something')
// ===========================================================================
// drawing.ts's goalBadgesAreInformative. The badge answers "which step of how
// many" — a question that does not exist for a single-step goal, or for ANY
// skillshot (whose badge index is pinned to 0 because a skill shot is ONE
// target to the player, so it could only ever read "1"). These pin the rule
// at the RENDERED level — "is there a circled digit on the canvas" — not just
// at the predicate, because the predicate being right while the call site
// ignores it is exactly the failure that would ship silently.
//
// Badge text is isolated from every other fillText by matching the digit (or
// the done checkmark) exactly: captions are shot names ('Right orbit') and
// the action bubble is a sentence ('Shoot orbit'), so neither can collide.

const badgeTexts = (calls) =>
  calls.filter((c) => c.method === 'fillText' && /^(\d+|✓)$/.test(String(c.args[0]))).map((c) => String(c.args[0]))

await test('a SINGLE-step goal draws no badge — but still draws its ring and its name caption', () => {
  const g = goal('g-single', 'multiball', ['orbit'])
  const { calls } = draw(g, 'any', { showLabels: true })
  const badges = badgeTexts(calls)
  assert(badges.length === 0, `expected no badge on a 1-step goal, got ${JSON.stringify(badges)}`)
  const target = map(SHOTS[3].x, SHOTS[3].y)
  const rings = calls.filter(
    (c) => c.method === 'arc' && Math.abs(c.args[0] - target.x) <= 1e-6 && Math.abs(c.args[1] - target.y) <= 1e-6,
  )
  assert(rings.length > 0, 'the target ring must still draw — removing the badge must not remove the target')
  assert(calls.some((c) => c.method === 'fillText' && c.args[0] === 'Right orbit'), 'the name caption must still draw')
  return `1-step goal: 0 badges, ${rings.length} ring arc(s) at the target, caption present`
})

await test('a SKILLSHOT goal draws no badge at ANY step index, however many steps it has', () => {
  // Two steps (the plunge->target shape that used to leak a "2"), walked with
  // highlightIndex the way the Map tab's skill-shot carousel parks on a
  // target.
  const g = goal('g-skill', 'skillshot', ['plunge', 'toplane'])
  const seen = []
  for (const k of [0, 1]) {
    const { calls } = draw(g, 'plunger', { highlightIndex: k, showLabels: true })
    const badges = badgeTexts(calls)
    assert(badges.length === 0, `expected no badge on a skillshot goal at stepIndex=${k}, got ${JSON.stringify(badges)}`)
    seen.push(`k=${k}:0`)
  }
  return `skillshot goal, 2 steps: no badge at either index (${seen.join(', ')}) — the permanent "1" is gone`
})

await test('a MULTI-step non-skillshot goal still badges, and still with its own 1-based step number', () => {
  // The other half of the rule, and the reason it is a rule rather than a
  // deletion: this is the case the badge exists for and it must be untouched.
  // Without this, "remove the badge" could pass by removing it everywhere.
  const g = goal('g-multi', 'multiball', ['orbit', 'bumper', 'basket'])
  const report = []
  for (const k of [0, 1, 2]) {
    const { calls } = draw(g, 'any', { highlightIndex: k })
    const badges = badgeTexts(calls)
    assert(badges.length === 1, `expected exactly one badge at stepIndex=${k}, got ${JSON.stringify(badges)}`)
    assert(badges[0] === String(k + 1), `expected the badge to read "${k + 1}" at stepIndex=${k}, got "${badges[0]}"`)
    report.push(`k=${k}->"${badges[0]}"`)
  }
  return `3-step multiball goal still badges its active step: ${report.join(', ')}`
})

await test('the predicate itself: goalBadgesAreInformative is false for 1-step and for every skillshot, true otherwise', () => {
  const f = drawing.goalBadgesAreInformative
  assert(typeof f === 'function', 'drawing.ts must export goalBadgesAreInformative (map2d.ts shares it for the LEVEL view)')
  assert(f(goal('a', 'multiball', ['orbit'])) === false, '1-step multiball should be false')
  assert(f(goal('b', 'skillshot', ['plunge', 'toplane'])) === false, '2-step skillshot should be false')
  assert(f(goal('c', 'skillshot', ['toplane'])) === false, '1-step skillshot should be false')
  assert(f(goal('d', 'multiball', ['orbit', 'bumper'])) === true, '2-step multiball should be true')
  assert(f(goal('e', 'mode', ['orbit', 'bumper', 'basket'])) === true, '3-step mode should be true')
  return 'false for {1-step, any skillshot}, true for multi-step non-skillshot'
})

// ===========================================================================
section('m1c. Shape-aware tap hit-testing (K3 fast-follow #1)')
// ===========================================================================
// BACKGLASS turned every shot dot into a playfield INSERT whose shape carries
// the shot type. The tap test was written when they were all radially
// symmetric 3.5px dots, so "distance to the shot's point" and "did the tap
// land on the thing I can see" were the same question. They are not any more:
// a ring draws NOTHING at the point being measured from, a blade is 3r tall
// and 0.84r wide, and an arrow/chevron is not symmetric about its centre.
//
// map2d.ts's insertHitDistance answers the second question: distance to the
// shape's drawn box, zero inside it, measured from the shape's visual
// CENTROID rather than its geometric origin.
//
// HONEST SCALE, since the code comment says it too: at the shipped r=4.6px the
// centroid offsets are sub-pixel to 0.61px. They are free to correct and they
// are not the point. The EXTENT is the point — it is what makes a tap that
// lands on a shape beat a neighbour whose centre is marginally closer.

const R = map2d.INSERT_DRAW_RADIUS
// Read once at module scope (top-level await) so the assertions below stay
// synchronous — this suite's harness runs test bodies directly.
const map2dSrc = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
const SHAPES = ['diamond', 'bar', 'ring', 'blade', 'arrow', 'chevron', 'cluster', 'dot']

/** Where each shape's ink actually is, relative to the shot's point, in units
 *  of r — derived from overlay/map2d.ts's own insertPath() geometry. These are
 *  the places a user's finger goes, which is the whole subject of this
 *  section. */
const VISUAL_PROBES = {
  diamond: [[0, -1], [0.78, 0], [0, 1], [-0.78, 0]], // the four points
  bar: [[-1.35, 0], [1.35, 0], [0, 0.5]], // both ends + an edge
  ring: [[1, 0], [-1, 0], [0, 0], [0, -1]], // the annulus AND its dark middle
  blade: [[0, -1.5], [0, 1.5], [0.42, 0]], // top, bottom, side of the tall bar
  arrow: [[0, -1.25], [1.05, 0.35], [0, 1.25]], // apex, wing tip, stem foot
  chevron: [[-1, 0.5], [0, -0.6], [1, 0.5]], // both arms + the vertex
  cluster: [[-0.85, 0.51], [0.85, 0.51], [0, -0.765]], // all three lamps
  dot: [[0, 0], [0.75, 0]],
}

await test('for EVERY shape, a tap anywhere on the drawn ink registers as a hit (distance 0 inside the shape)', () => {
  const rows = []
  for (const shape of SHAPES) {
    const probes = VISUAL_PROBES[shape]
    assert(probes, `no probe set for '${shape}' — every shape must be covered`)
    for (const [ux, uy] of probes) {
      const d = map2d.insertHitDistance(shape, { x: 100, y: 100 }, R, 100 + ux * R, 100 + uy * R)
      // Tolerance, not `=== 0`: a probe ON the box edge computes its offset
      // two different ways (100 + uy*R vs cy + hy*R) and they disagree in the
      // last bit — ~1e-14px. An exact compare here fails on arithmetic, not
      // on behaviour.
      assert(d < 1e-9, `a tap on '${shape}' ink at (${ux}r, ${uy}r) measured ${d}px away instead of landing inside it`)
    }
    rows.push(`${shape}:${probes.length}`)
  }
  return `every drawn probe lands inside its own shape — ${rows.join(' ')}`
})

await test("a RING hit-tests as a FILLED disc — its dark middle is a graphic, not a hole in the target", () => {
  // The specific regression K3 called out: the ring's visual middle is empty,
  // so a naive "is the tap on drawn ink" test would reject the exact centre.
  const d = map2d.insertHitDistance('ring', { x: 50, y: 50 }, R, 50, 50)
  assert(d === 0, `a tap at a scoop's centre measured ${d}px — the hole must not be a gap in the tap target`)
  return 'centre of a ring = distance 0'
})

await test('the CENTROID shift is applied, and it is the measured sub-pixel amount — not a guess', () => {
  // Asymmetric shapes only. Probe symmetrically above and below the shot's
  // POINT at a distance outside the box, and check the shape reads as nearer
  // on the side its ink actually leans toward.
  const cases = [
    { shape: 'arrow', leans: +1 }, // centroid +0.1322r (stem side, downward)
    { shape: 'cluster', leans: +1 }, // centroid +0.085r
    { shape: 'chevron', leans: -1 }, // centroid -0.05r (vertex side, upward)
  ]
  const rows = []
  for (const { shape, leans } of cases) {
    const probe = 40 // px away, well outside every box
    const below = map2d.insertHitDistance(shape, { x: 0, y: 0 }, R, 0, probe)
    const above = map2d.insertHitDistance(shape, { x: 0, y: 0 }, R, 0, -probe)
    const nearerBelow = below < above
    assert(
      leans > 0 ? nearerBelow : !nearerBelow,
      `'${shape}' should measure nearer from the ${leans > 0 ? 'bottom' : 'top'} (its ink leans that way), got below=${below.toFixed(3)} above=${above.toFixed(3)}`,
    )
    rows.push(`${shape} ${Math.abs(below - above).toFixed(2)}px asymmetry`)
  }
  // And the magnitude is small — this test would be lying if it implied a big
  // correction. 2 x centroid offset x r, so under 1.3px for every shape.
  for (const { shape } of cases) {
    const below = map2d.insertHitDistance(shape, { x: 0, y: 0 }, R, 0, 40)
    const above = map2d.insertHitDistance(shape, { x: 0, y: 0 }, R, 0, -40)
    assert(Math.abs(below - above) < 1.3, `${shape}'s centroid correction is larger than the measured sub-pixel amount`)
  }
  return `asymmetry present and sub-1.3px as measured — ${rows.join(', ')}`
})

await test('EXTENT beats proximity: a tap ON a blade picks the blade, not a bare dot whose centre is closer', () => {
  // This is the behaviour the whole change exists for. A blade is 1.5r tall;
  // a tap near its top end is 6.9px from the blade's point. Put a plain dot
  // 6px away horizontally — closer by centre-distance — and the blade must
  // still win, because the tap is ON it.
  const bladeCenter = { x: 100, y: 100 }
  const tap = { x: 100, y: 100 - 1.4 * R } // on the blade's upper arm
  // 5px from the tap: closer than the blade's centre (6.44px), and further
  // than the dot's own 3.45px half-extent, so the tap is NOT on the dot.
  const dotCenter = { x: 100, y: tap.y + 5 }
  const dBlade = map2d.insertHitDistance('blade', bladeCenter, R, tap.x, tap.y)
  const dDot = map2d.insertHitDistance('dot', dotCenter, R, tap.x, tap.y)
  assert(dBlade < 1e-9, `the tap should be inside the blade, measured ${dBlade}`)
  assert(dDot > dBlade, `the neighbouring dot measured ${dDot.toFixed(2)} vs the blade's ${dBlade} — the blade must win`)
  // Centre-distance alone would have gone the other way, which is the bug:
  const centreBlade = Math.hypot(tap.x - bladeCenter.x, tap.y - bladeCenter.y)
  const centreDot = Math.hypot(tap.x - dotCenter.x, tap.y - dotCenter.y)
  assert(centreDot < centreBlade, 'setup is wrong: this fixture must be one where centre-distance picks the WRONG shot')
  return `on-blade tap: blade 0px vs dot ${dDot.toFixed(2)}px (centre-distance would have said blade ${centreBlade.toFixed(2)} vs dot ${centreDot.toFixed(2)} — wrong)`
})

await test('the drawn radius and the hit-tested radius are the SAME constant', () => {
  // A literal in one place and not the other is how a target drifts off its
  // own graphic. INSERT_DRAW_RADIUS is exported precisely so this is checkable.
  assert(typeof R === 'number' && R > 0, 'map2d.ts must export INSERT_DRAW_RADIUS')
  assert(
    /drawInsert\(ctx, shape, INSERT_DRAW_RADIUS, alpha\)/.test(map2dSrc),
    'the draw call must use INSERT_DRAW_RADIUS, not a literal — otherwise the hit test can silently measure a different shape than the one drawn',
  )
  assert(
    /insertHitDistance\(shape, entry\.point, INSERT_DRAW_RADIUS, x, y\)/.test(map2dSrc),
    'the hit test must measure at INSERT_DRAW_RADIUS',
  )
  return `draw and hit-test both at r=${R}px`
})

// ===========================================================================
section('n. tracerAt() — phase boundaries, degenerate-flat skip, clock anchoring')
// ===========================================================================

function makeFlat(coords) {
  const pts = coords.map(([x, y]) => ({ x, y }))
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return { pts, cum, len: cum[cum.length - 1] }
}

// Two 340px-long straight flats -> travel = max(220, 340/340*1000) = 1000ms
// exactly, dwell = 620ms (default) -> phase0 [0,1000) travel, [1000,1620)
// dwell; phase1 [1620,2620) travel, [2620,3240) dwell; endPause 900ms ->
// cycle = 3240+900 = 4140ms. Clean, hand-checkable boundaries.
const flatA = makeFlat([[0, 0], [340, 0]])
const flatB = makeFlat([[340, 0], [680, 0]])

await test('t=0: clock anchors at index 0, u=0, done=0, no sinceHit', () => {
  const r = drawing.tracerAt([flatA, flatB], 0)
  assert(r.index === 0 && r.done === 0, `expected index=0 done=0, got index=${r.index} done=${r.done}`)
  assert(r.u === 0, `expected u=0, got ${r.u}`)
  assert(r.ball && r.ball.x === 0 && r.ball.y === 0, `expected ball at the flat's origin, got ${JSON.stringify(r.ball)}`)
  assert(r.sinceHit === null && !r.finished, 'expected sinceHit null, finished false')
  return `t=0 -> {index:0, done:0, u:0, ball:(0,0)} — a newly selected goal starts at leg 1, not mid-route`
})

await test('t=999 (just before dwellStart): still travelling, u just under 1', () => {
  const r = drawing.tracerAt([flatA, flatB], 999)
  assert(r.index === 0 && r.u > 0.99 && r.u < 1, `expected index=0, u~0.999, got index=${r.index} u=${r.u}`)
  assert(r.sinceHit === null, 'expected still travelling (sinceHit null)')
  return `t=999 -> index=0, u=${r.u.toFixed(4)}`
})

await test('t=1000 (exact dwellStart): dwell phase begins, done becomes 1, sinceHit=0', () => {
  const r = drawing.tracerAt([flatA, flatB], 1000)
  assert(r.index === 0 && r.done === 1, `expected index=0 done=1, got index=${r.index} done=${r.done}`)
  assert(r.ball === null, 'expected ball null during dwell')
  assert(r.sinceHit === 0, `expected sinceHit=0 at the exact dwell boundary, got ${r.sinceHit}`)
  return `t=1000 (exact travel/dwell boundary) -> index=0, done=1, sinceHit=0`
})

await test('t=1619 (just before phase 1 begins): still dwelling on target 0', () => {
  const r = drawing.tracerAt([flatA, flatB], 1619)
  assert(r.index === 0 && r.done === 1 && r.sinceHit === 619, `unexpected state: ${JSON.stringify(r)}`)
  return `t=1619 -> index=0, done=1, sinceHit=619`
})

await test('t=1620 (exact dwellStart+dwell boundary): phase 1 begins, done folds in target 0, ball at u=0', () => {
  const r = drawing.tracerAt([flatA, flatB], 1620)
  assert(r.index === 1 && r.done === 1, `expected index=1 done=1 (target 0 already folded into done), got index=${r.index} done=${r.done}`)
  assert(r.u === 0, `expected u=0 at the exact start of phase 1, got ${r.u}`)
  return `t=1620 -> index=1, done=1, u=0 — target 0 counted done the instant phase 1 begins`
})

await test('t=3240 (exact end of the last dwell / start of the end-pause): finished=true, done=phases.length', () => {
  const r = drawing.tracerAt([flatA, flatB], 3240)
  assert(r.finished === true, 'expected finished=true during the end pause')
  assert(r.done === 2, `expected done=2 (all targets reached), got ${r.done}`)
  assert(r.index === 1 && r.ball === null, `expected index=1 (parked on the last target), ball=null, got index=${r.index} ball=${JSON.stringify(r.ball)}`)
  // sinceHit counts continuously from ARRIVAL (phase1's dwellStart=2620), not
  // from the dwell/end-pause boundary — so at t=3240 it reads 620 (== dwell),
  // matching pg-render.js's `t - last.dwellStart` exactly. The impact flash
  // (hit = max(0, 1 - sinceHit/420)) has already faded to 0 well before this
  // point, which is the whole reason a separate "sinceHit resets" concept
  // isn't needed.
  assert(r.sinceHit === 620, `expected sinceHit=620 (== dwell, counted continuously from arrival), got ${r.sinceHit}`)
  return `t=3240 -> finished=true, done=2, parked on the last target (sinceHit=620, counted from arrival at t=2620)`
})

await test('t=4140 (exact cycle length): wraps back to t=0 behavior', () => {
  const r = drawing.tracerAt([flatA, flatB], 4140)
  assert(r.index === 0 && r.done === 0 && r.u === 0, `expected the cycle to wrap back to index=0/done=0/u=0, got ${JSON.stringify(r)}`)
  return `t=4140 (== cycle length) -> wraps to index=0, done=0, u=0, same as t=0`
})

await test('a near-zero-length flat (len<1) contributes a DWELL-ONLY phase (2026-07-28 review finding 1, supersedes correction #4\'s skip)', () => {
  const degenerate = makeFlat([[5, 5], [5, 5.5]]) // len = 0.5, under the 1px threshold
  const real = makeFlat([[0, 0], [340, 0]]) // len = 340 -> travel = 1000ms
  // The degenerate segment is no longer skipped out of the schedule — it
  // gets its own dwell-only phase (0ms travel, 620ms dwell, ball/u null
  // throughout) so it becomes the active index for its beat, same as a real
  // segment would, just without a flight.
  const r0 = drawing.tracerAt([degenerate, real], 0)
  assert(r0.index === 0 && r0.done === 1, `expected the dwell-only phase on segment 0 (index=0, done=1), got index=${r0.index} done=${r0.done}`)
  assert(r0.ball === null && r0.u === null, `expected ball/u null throughout the dwell-only phase, got ball=${JSON.stringify(r0.ball)} u=${r0.u}`)
  assert(r0.sinceHit === 0, `expected sinceHit=0 at the start of the dwell-only phase (still counts up so the ring pulses), got ${r0.sinceHit}`)
  const r1 = drawing.tracerAt([degenerate, real], 620) // the dwell-only phase's 620ms dwell has just elapsed
  assert(r1.index === 1 && r1.done === 1 && r1.u === 0, `expected the real flat's travel to begin at t=620 (index=1, done=1, u=0), got ${JSON.stringify(r1)}`)
  return `flats=[degenerate(len=0.5), real(len=340)]: t=0 -> dwell-only phase on segment 0 (index=0, done=1, ball=null, sinceHit=0); t=620 -> segment 1 begins travel (u=0)`
})

await test('a null flat (missing segment) also contributes a dwell-only phase', () => {
  const real = makeFlat([[0, 0], [340, 0]])
  const r0 = drawing.tracerAt([null, real], 0)
  assert(r0.index === 0 && r0.done === 1, `expected a dwell-only phase on segment 0 (index=0, done=1), got index=${r0.index} done=${r0.done}`)
  assert(r0.ball === null, `expected ball null (no flat to sample), got ${JSON.stringify(r0.ball)}`)
  const r1 = drawing.tracerAt([null, real], 620)
  assert(r1.index === 1 && r1.u === 0, `expected the real flat's travel to begin at t=620 (index=1, u=0), got index=${r1.index} u=${r1.u}`)
  return `flats=[null, real]: t=0 -> dwell-only phase (index=0, done=1); t=620 -> real flat begins travel (index=1, u=0)`
})

await test('every flat null/degenerate: both fold through dwell-only phases, cycling safely (no throw)', () => {
  const d1 = makeFlat([[1, 1], [1, 1]]) // len = 0, degenerate
  const flats = [null, d1]
  const r0 = drawing.tracerAt(flats, 0)
  assert(r0.index === 0 && r0.done === 1 && r0.ball === null, `expected the first dwell-only phase, got ${JSON.stringify(r0)}`)
  const r1 = drawing.tracerAt(flats, 620)
  assert(r1.index === 1 && r1.done === 2 && r1.ball === null, `expected the schedule to fold to segment 1's dwell-only phase at t=620 (done=2, both original indices counted), got ${JSON.stringify(r1)}`)
  // total = 620 (seg0 dwell-only) + 620 (seg1 dwell-only) = 1240; cycle = 1240 + 900 = 2140
  const r2 = drawing.tracerAt(flats, 1240)
  assert(r2.finished === true && r2.done === 2 && r2.index === 1, `expected the end pause (finished=true, done=flats.length=2, index=last entry's original index=1), got ${JSON.stringify(r2)}`)
  return `flats=[null, degenerate]: t=0 -> seg0 dwell-only (index=0,done=1); t=620 -> seg1 dwell-only (index=1,done=2); t=1240 -> end pause (finished, done=2, index=1) — never throws even with zero real segments`
})

// D8 (2026-07-29 review): a FlatSegment carrying `rampIdx` (a rule-7 elevated
// entrance->apex->feed tail survived) must fire its impact flash (sinceHit)
// at the CROSSING of the "main" (entrance-ring) length, not at the end of the
// whole (longer) flight. mainLen=170, total len=340 -> travel = max(220,
// 340/340*1000) = 1000ms exactly (same clean numbers as flatA/flatB above);
// crossAt = 1000 * (170/340) = 500ms exactly, well before dwellStart=1000ms.
function makeFlatWithRamp(coords, rampIdx) {
  const flat = makeFlat(coords)
  return { ...flat, rampIdx }
}
const rampFlat = makeFlatWithRamp([[0, 0], [170, 0], [340, 0]], 2) // pts[1]=(170,0) is the entrance ring, mainLen=cum[1]=170

await test('D8: before the entrance crossing (t=499 < crossAt=500), sinceHit is still null even though the ball is travelling', () => {
  const r = drawing.tracerAt([rampFlat], 499)
  assert(r.index === 0 && r.ball !== null, `expected still travelling, got ${JSON.stringify(r)}`)
  assert(r.sinceHit === null, `expected sinceHit null before the entrance crossing (crossAt=500), got ${r.sinceHit}`)
  return `t=499 (just before crossAt=500): ball travelling (u=${r.u.toFixed(4)}), sinceHit=null`
})

await test('D8: at the exact entrance crossing (t=500=crossAt, well before dwellStart=1000), sinceHit flips to 0 while STILL travelling', () => {
  const r = drawing.tracerAt([rampFlat], 500)
  assert(r.index === 0 && r.ball !== null && r.u !== null, `expected still travelling past the entrance (into the elevated tail), got ${JSON.stringify(r)}`)
  assert(r.sinceHit === 0, `expected sinceHit=0 exactly at the entrance crossing, got ${r.sinceHit}`)
  return `t=500 (==crossAt, dwellStart is still 500ms away): ball already past the entrance ring (u=${r.u.toFixed(4)}) yet sinceHit=0 — the flash fires here, not at dwellStart`
})

await test('D8: mid-elevated-tail (t=750), sinceHit counts from the crossing (250ms), not from dwellStart (which is still 250ms away)', () => {
  const r = drawing.tracerAt([rampFlat], 750)
  assert(r.index === 0 && r.ball !== null, `expected still travelling down the elevated tail, got ${JSON.stringify(r)}`)
  assert(r.sinceHit === 250, `expected sinceHit=750-crossAt(500)=250, got ${r.sinceHit}`)
  return `t=750: ball still travelling the elevated tail (u=${r.u.toFixed(4)}), sinceHit=250 (250ms since crossing the entrance at t=500)`
})

await test('D8: at dwellStart (t=1000, ball parked at the FEED point), sinceHit=500 (since the t=500 crossing) — NOT 0 (the pre-D8 t-dwellStart formula)', () => {
  const r = drawing.tracerAt([rampFlat], 1000)
  assert(r.index === 0 && r.done === 1 && r.ball === null, `expected the dwell phase (parked at the feed point), got ${JSON.stringify(r)}`)
  assert(r.sinceHit === 500, `expected sinceHit=1000-crossAt(500)=500 (pre-D8 code would have reported 0 here == t-dwellStart), got ${r.sinceHit}`)
  return `t=1000 (dwellStart, ball dwelling at the feed point): sinceHit=500 — the impact flash (hit=max(0,1-sinceHit/420)) has ALREADY faded out by the time the ball finishes the longer elevated-tail trip, exactly the D8 fix's point`
})

await test('D8: a rampIdx===undefined (ordinary, non-elevated) flat is completely unaffected — crossAt collapses to dwellStart', () => {
  const r = drawing.tracerAt([flatA], 1000) // flatA: len=340, no rampIdx -> mainLen===len -> crossAt===dwellStart===1000
  assert(r.sinceHit === 0, `expected sinceHit=0 at the ordinary dwell boundary (no rampIdx -> crossAt===dwellStart), got ${r.sinceHit}`)
  return `flatA (no rampIdx) at t=1000: sinceHit=0, identical to the pre-D8 behavior — the fix only changes segments with a surviving elevated tail`
})

// ===========================================================================
section('o. pointAt() — arc-length lerp + tangent angle')
// ===========================================================================

await test('pointAt at dist=0 returns the first point with the first span\'s tangent angle', () => {
  const flat = makeFlat([[0, 0], [100, 0], [100, 100]])
  const p = drawing.pointAt(flat, 0)
  close(p.x, 0, 1e-9, 'x')
  close(p.y, 0, 1e-9, 'y')
  close(p.angle, 0, 1e-9, 'angle (pointing along +x)')
  return `pointAt(dist=0) = (${p.x}, ${p.y}), angle=${p.angle.toFixed(4)}`
})

await test('pointAt lerps within a span (dist=25 on a 0->100 straight run)', () => {
  const flat = makeFlat([[0, 0], [100, 0]])
  const p = drawing.pointAt(flat, 25)
  close(p.x, 25, 1e-9, 'x')
  close(p.y, 0, 1e-9, 'y')
  return `pointAt(dist=25) on a 100px straight run = (${p.x}, ${p.y})`
})

await test('pointAt at the exact end of the last span returns the last point', () => {
  const flat = makeFlat([[0, 0], [100, 0]])
  const p = drawing.pointAt(flat, 100)
  close(p.x, 100, 1e-9, 'x')
  return `pointAt(dist=len) = (${p.x}, ${p.y})`
})

await test('pointAt clamps dist beyond the polyline length', () => {
  const flat = makeFlat([[0, 0], [100, 0]])
  const p = drawing.pointAt(flat, 9999)
  close(p.x, 100, 1e-9, 'x (clamped to the end)')
  return `pointAt(dist=9999) on a 100px run clamps to (${p.x}, ${p.y})`
})

await test('pointAt reports the tangent angle of a perpendicular second span', () => {
  const flat = makeFlat([[0, 0], [100, 0], [100, 100]])
  const p = drawing.pointAt(flat, 150) // 50 into the second (vertical) span
  close(p.x, 100, 1e-9, 'x')
  close(p.y, 50, 1e-9, 'y')
  close(p.angle, Math.PI / 2, 1e-9, 'angle (pointing along +y)')
  return `pointAt(dist=150) on an L-shaped run = (${p.x}, ${p.y}), angle=${p.angle.toFixed(4)} (== PI/2)`
})

// ===========================================================================
section('p. labelPacker() — box collision, direct unit test')
// ===========================================================================

await test('the first box placed always fits', () => {
  const fits = drawing.labelPacker()
  assert(fits(100, 100, 40, 10) === true, 'expected the first box to fit')
  return `fits(100,100,40,10) === true (nothing placed yet)`
})

await test('an overlapping box is rejected', () => {
  const fits = drawing.labelPacker()
  assert(fits(100, 100, 40, 10) === true)
  assert(fits(105, 101, 40, 10) === false, 'expected the near-identical box to be rejected as overlapping')
  return `fits(100,100,40,10) -> true; fits(105,101,40,10) -> false (overlaps the first box)`
})

await test('a far-away box still fits after a rejection', () => {
  const fits = drawing.labelPacker()
  assert(fits(100, 100, 40, 10) === true)
  assert(fits(105, 101, 40, 10) === false)
  assert(fits(500, 500, 40, 10) === true, 'expected a box far from both prior boxes to fit')
  return `after 1 accepted + 1 rejected box, a box at (500,500) still fits`
})

await test('a box exactly touching (not overlapping) an existing one fits', () => {
  const fits = drawing.labelPacker()
  assert(fits(0, 0, 20, 10) === true) // box: l=-13,r=13,t=-7,bo=7
  // next box's left edge (x-w/2-3) sits exactly at the first box's right edge -> l < o.r is FALSE (equal, not less-than) -> no overlap
  assert(fits(26, 0, 20, 10) === true, 'expected an edge-touching box (not overlapping) to still fit')
  return `two boxes with edges exactly touching both fit (strict-inequality overlap test)`
})

// ===========================================================================
section('q. caption-collision integration test (README §1e "collision suppression")')
// ===========================================================================

await test("two same-position shots: only the ACTIVE step's caption ever draws (item 5, 2026-08-11 — supersedes this section's original cross-step collision-avoidance premise: Pass 2.5 no longer has a second SIMULTANEOUS caption to collide with in the first place)", () => {
  const samePoint = new Map([
    ['a', { id: 'a', name: 'Shot Alpha', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }],
    ['b', { id: 'b', name: 'Shot Beta', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }],
  ])
  const g = goal('g-collision', 'combo', ['a', 'b'])
  const target = map(0.5, 0.5)

  // step 'a' active (t=0 -> autoHighlightIndex=0): its caption draws at the
  // default above-the-ring position; step 'b's caption does not draw at all.
  const { calls: atA } = draw(g, 'any', { shotsByID: samePoint, time: 0 })
  const alphaCall = atA.find((c) => c.method === 'fillText' && c.args[0] === 'Shot Alpha')
  const betaCallAtA = atA.find((c) => c.method === 'fillText' && c.args[0] === 'Shot Beta')
  assert(alphaCall, "expected the active step's caption (Shot Alpha) to be placed")
  assert(!betaCallAtA, "expected Shot Beta's caption to be absent while step 'a' is active")
  const [, ax, ay] = alphaCall.args
  close(ay, target.y - 13, 1e-6, 'caption at the default y (target.y - 13) — nothing else on screen to collide with any more')

  // step 'b' active (highlightIndex:1): the roles flip — now ITS caption
  // draws at the same default position, and Alpha's is the one absent.
  const { calls: atB } = draw(g, 'any', { shotsByID: samePoint, highlightIndex: 1 })
  const betaCallAtB = atB.find((c) => c.method === 'fillText' && c.args[0] === 'Shot Beta')
  const alphaCallAtB = atB.find((c) => c.method === 'fillText' && c.args[0] === 'Shot Alpha')
  assert(betaCallAtB, "expected the active step's caption (Shot Beta) to be placed once it's active")
  assert(!alphaCallAtB, "expected Shot Alpha's caption to be absent while step 'b' is active")
  const [, bx, by] = betaCallAtB.args
  close(by, target.y - 13, 1e-6, "Shot Beta's caption at the same default y once it's the active one")

  return `step 'a' active: only 'Shot Alpha' draws (y=${ay.toFixed(1)}); step 'b' active: only 'Shot Beta' draws (y=${by.toFixed(1)}) — never both at once, so there is nothing left for the old collision-avoidance fallback to arbitrate`
})

// ===========================================================================
section('r. manual mode / ballTracer integration + drawGoalOverlay return value')
// ===========================================================================

await test('manual highlightIndex=2 bypasses the flying ball (no radial gradient); its own badge shows the step number, not a checkmark — steps 0/1 no longer draw at all (item 5, 2026-08-11, supersedes this test\'s original "steps 0,1 done" premise)', () => {
  const g = goal('g-manual', 'combo', ['plunge', 'flipper', 'orbit'])
  const { calls, result } = draw(g, 'any', { ballTracer: true, highlightIndex: 2, showLabels: false })
  const gradients = calls.filter((c) => c.method === 'createRadialGradient')
  assert(gradients.length === 0, `expected no tracer ball in manual mode, got ${gradients.length} radial gradient(s)`)
  // Steps 0/1 don't draw AT ALL any more (item 5), so there is no "done"
  // checkmark left to show for them; the sole active step (2) is never its
  // own "done" in manual mode either (isDone = index < active.done =
  // manualIndex < manualIndex = false), so its badge shows its number.
  const checkmarks = calls.filter((c) => c.method === 'fillText' && c.args[0] === '✓')
  assert(checkmarks.length === 0, `expected 0 checkmark badges, got ${checkmarks.length}`)
  const activeBadge = calls.filter((c) => c.method === 'fillText' && c.args[0] === '3') // index 2 + 1
  assert(activeBadge.length > 0, `expected the sole active step's own badge to show its number (3), got ${activeBadge.length}`)
  assert(result.highlightIndex === 2, `expected the returned highlightIndex to equal the manual index, got ${result.highlightIndex}`)
  return `manual highlightIndex=2: 0 tracer-ball gradients, 0 checkmarks (steps 0/1 don't draw at all any more), badge "3" for the sole active step, returned {highlightIndex: 2}`
})

await test('ballTracer:true, auto mode, t=0: the tracer ball IS drawn (exactly 1 radial gradient), no checkmarks yet', () => {
  // 2026-08-11 (phase A7): swapped from the original ['plunge','flipper']
  // fixture — both its segments are plunger-origin now (0 legs, nothing to
  // fly — see section w's own "no polyline" rework below) — to a plain
  // non-plunge goal. This test's actual point is ballTracer's own
  // gradient/checkmark bookkeeping, unrelated to plunge routing.
  const g = goal('g-tracer-on', 'combo', ['flipper', 'orbit'])
  const { calls, result } = draw(g, 'any', { ballTracer: true, showLabels: false, time: 0 })
  const gradients = calls.filter((c) => c.method === 'createRadialGradient')
  assert(gradients.length === 1, `expected exactly 1 tracer-ball radial gradient at t=0 (travelling), got ${gradients.length}`)
  const checkmarks = calls.filter((c) => c.method === 'fillText' && c.args[0] === '✓')
  assert(checkmarks.length === 0, `expected 0 checkmarks at t=0 (nothing reached yet), got ${checkmarks.length}`)
  assert(result.highlightIndex === 0, `expected the returned highlightIndex to be 0 at the start of the cycle, got ${result.highlightIndex}`)
  return `ballTracer:true, t=0: 1 tracer-ball gradient drawn, 0 checkmarks, returned {highlightIndex: 0}`
})

await test('drawGoalOverlay returns { highlightIndex } matching the (ballTracer:false) auto-marching index', () => {
  const g = goal('g-return-auto', 'combo', ['plunge', 'flipper', 'orbit'])
  const { result } = draw(g, 'any', { time: 1000 }) // ballTracer:false default -> autoHighlightIndex(1000, 3) === 0
  assert(result.highlightIndex === 0, `expected {highlightIndex: 0}, got ${JSON.stringify(result)}`)
  return `ballTracer:false, time:1000 -> returned {highlightIndex: 0} (autoHighlightIndex(1000,3))`
})

await test('trailStyle:"neon" smoke test — still produces a stroke run reaching the target, does not throw', () => {
  // 2026-08-11 (phase A7): swapped from ['plunge','orbit'] (plunger-origin,
  // now draws nothing) to a plain non-plunge goal — this test's point is the
  // neon stroke technique, unrelated to plunge routing. Segment 1
  // (flipper->orbit) snap-directs (its origin sits within FLIPPER_SNAP of
  // its own rule-6 anchor), so it's still a single 23-point leg, the same
  // shape the original fixture's Case-A run had.
  // 2026-08-11 (phase A12 item 5, same day): the target under test (orbit)
  // is STEP 1, not the default-active step 0 — highlightIndex:1 makes it
  // active so Pass 1 actually draws its leg (only the active step's leg
  // draws now).
  const g = goal('g-neon-smoke', 'combo', ['flipper', 'orbit'])
  const { runs } = draw(g, 'any', { trailStyle: 'neon', highlightIndex: 1 })
  const orbitView = map(SHOTS[3].x, SHOTS[3].y)
  const stroke = runsEndingAt(runs, orbitView).find((r) => r.points.length > 3)
  assert(stroke, 'expected a stroke run reaching the orbit target under trailStyle:neon')
  assert(stroke.points.length === 23, `expected a single-leg (23-point) run, got ${stroke.points.length}`)
  return `trailStyle:'neon' still produced a normal 23-point single-leg run, just restroked differently`
})

// ===========================================================================
section('s. 2026-07-28 degenerate-leg review regressions (findings 2 and 3)')
// ===========================================================================

await test("finding 2: mixed real/null flats — end pause done===flats.length, index===the LAST entry's original index", () => {
  const shortReal = makeFlat([[0, 0], [50, 0]]) // len=50 -> travel = max(220, 50/340*1000=147.06) = 220ms exactly
  const flats = [shortReal, null, null, shortReal, shortReal]
  // Before the fix, phases only existed for the 3 real entries (original
  // indices 0, 3, 4), so the end pause's `done` read phases.length===3 —
  // undercounting, since indices 3 and 4 (already flown) would then fall
  // OUTSIDE `index < done` in Pass 1/2 and wrongly revert to "quiet" mid
  // end-pause. Every array index now gets a phase (real or dwell-only), so
  // phases.length === flats.length always.
  // total = (220+620)*3 [real phases 0,3,4] + 620*2 [dwell-only 1,2]
  //       = 2520 + 1240 = 3760ms; cycle = 3760 + 900 = 4660ms
  const r = drawing.tracerAt(flats, 3760) // exact start of the end pause
  assert(r.finished === true, 'expected the end pause to be active at t=3760')
  assert(r.done === flats.length, `expected done===flats.length (${flats.length}), got ${r.done}`)
  assert(r.index === 4, `expected index===4 (the last array entry's original index), got ${r.index}`)
  assert(r.ball === null, 'expected ball null during the end pause')
  assert(r.sinceHit === 620, `expected sinceHit=620 (one full dwell after the last phase's arrival), got ${r.sinceHit}`)
  return `flats=[real,null,null,real,real], t=3760 (end pause): done=${r.done}===flats.length, index=${r.index}===last entry's original index — no already-flown leg reverts to quiet`
})

await test('finding 3: a segment whose flattened polyline is under ARROWHEAD_MIN_LEG_PX (40) still draws its line, but no arrowhead', () => {
  // A tiny custom MapFn (300x scale, vs. the shared map's 450x900) shrinks
  // the same routed geometry down to a short flattened polyline —
  // comfortably above DEGENERATE_LEG_MIN_PX (1px, so the leg still draws)
  // but under the 40px arrowhead gate. Routing itself (UV-space) doesn't
  // care about the map's scale, so this is still a normal Case-A launch
  // segment (direct control, chord-midpoint straight leg), not a synthetic
  // shortcut.
  const tinyMap = (u, v) => ({ x: u * 300, y: 300 - v * 300 })
  const nearShots = new Map([['near', { id: 'near', name: 'Near target', type: 'standup', x: 0.55, y: 0.08, trim: 'all' }]])
  const g = goal('g-short-arrowhead', 'combo', ['near'])
  const { runs } = draw(g, 'any', { map: tinyMap, shotsByID: nearShots, showLabels: false })
  const targetView = tinyMap(0.55, 0.08)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the connector line to still draw for the short leg')
  let len = 0
  for (let i = 1; i < stroke.points.length; i++) {
    len += Math.hypot(stroke.points[i].x - stroke.points[i - 1].x, stroke.points[i].y - stroke.points[i - 1].y)
  }
  assert(len < 40, `expected this test's polyline to be under the 40px arrowhead gate (sanity-check the fixture), got ${len.toFixed(2)}px`)
  assert(len >= 1, `expected the polyline to still be above the 1px degenerate-leg threshold (sanity-check the fixture), got ${len.toFixed(2)}px`)
  const chevronRuns = runs.filter((r) => r.points.length === 3)
  assert(chevronRuns.length === 0, `expected NO 3-point arrowhead chevron run for a ${len.toFixed(2)}px leg (under the 40px gate), got ${chevronRuns.length}`)
  return `short leg (${len.toFixed(2)}px, under ARROWHEAD_MIN_LEG_PX=40): polyline drew (${stroke.points.length}-point run), 0 arrowhead chevron runs`
})

await test('control: a normal-scale leg (>=40px) DOES draw its arrowhead chevron — proves the chevron-detection above is meaningful', () => {
  // 2026-08-11 (phase A7): swapped from ['plunge','orbit'] — plunger-origin,
  // draws no leg/arrowhead any more — to a plain non-plunge goal (same
  // shape as section f's fixture). This control's whole point is that the
  // harness's chevron detection fires at normal scale; a plunge fixture no
  // longer has any chevron to detect.
  const g = goal('g-normal-arrowhead', 'combo', ['flipper', 'orbit']) // full-scale shared map, non-plunge
  const { runs } = draw(g, 'any', { showLabels: false })
  const chevronRuns = runs.filter((r) => r.points.length === 3)
  assert(chevronRuns.length > 0, `expected at least one 3-point arrowhead chevron run at normal (>=40px) scale, got ${chevronRuns.length}`)
  return `normal-scale flipper->orbit route draws ${chevronRuns.length} arrowhead chevron run(s) (3 points each) — confirms the harness's chevron detection is meaningful, not vacuous`
})

// ===========================================================================
section('t. 2026-07-29 straightness regression — chord-midpoint controls, arches survive')
// ===========================================================================
//
// bowControl/directControl now both return the chord midpoint — a quadratic
// Bézier whose control point is its own endpoints' midpoint degenerates
// ALGEBRAICALLY to the linear interpolation a + t*(b-a), so every flattened
// sample should land on the chord to within float error, not just "close".
// perpDist() (file top) measures perpendicular distance to the INFINITE line
// through the two endpoints, scaled by segment length for the epsilon so the
// same relative tolerance holds regardless of the synthetic machine's scale.
//
// 2026-08-11 (phase A7): this section used to end on the one exception to
// "everything got flattened straight" — laneRoute's shooter-lane ARCH leg
// (Case B/C), deliberately left curved because a real machine's arch is
// physical. That sub-test is reworked below to prove the opposite kind of
// point now: Case B draws NO leg at all any more, so there is nothing left
// to assert curvature (or straightness) OF on the canvas — see its own
// comment.

await test('direct launch segment: every flattened point sits on the launch->target chord (within 1e-6 * segment length)', () => {
  const g = goal('g-straight-direct', 'combo', ['flipper'])
  const { runs } = draw(g, 'any')
  const flipperView = map(SHOTS[1].x, SHOTS[1].y)
  const stroke = runsEndingAt(runs, flipperView).find((r) => r.points.length > 3)
  assert(stroke, 'expected to find the launch->flipper stroke run')
  const from = stroke.points[0]
  const segLen = Math.hypot(flipperView.x - from.x, flipperView.y - from.y)
  const eps = 1e-6 * segLen
  let worst = 0
  for (const p of stroke.points) worst = Math.max(worst, perpDist(p, from, flipperView))
  assert(worst <= eps, `expected every point within ${eps.toExponential(2)}px of the chord (bowControl/directControl now return the chord midpoint), worst was ${worst.toExponential(2)}px`)
  return `direct launch->flipper run (${stroke.points.length} points): worst perpendicular deviation from the chord = ${worst.toExponential(2)}px (<= ${eps.toExponential(2)}px, i.e. 1e-6 * segment length ${segLen.toFixed(1)}px)`
})

await test("a viaWaypoint route's two legs are each collinear (corner at the waypoint allowed)", () => {
  // 2026-07-29b (SPEC-PATHVIZ rule 6c): the waypoint is no longer the fixed
  // RETURN_WAYPOINT_UV (0.5,0.06) — it's the chosen shooting flipper's own
  // anchor. chooseFlipper(target=far(0.7,0.75), origin=near(0.3,0.4), no
  // explicit step/shot flipper): target.x=0.7 > 0.55 -> 'left' ->
  // FLIPPER_ANCHORS.left = (0.40, 0.04) (models.ts BALL_ANCHORS.leftFlipper).
  // hypot(near - (0.40,0.04)) = hypot(0.1, 0.36) ~= 0.374, well over
  // FLIPPER_SNAP (0.08), so this still routes viaWaypoint rather than
  // snap-directing (that case is covered separately in ramp-route.test.mjs).
  const viaShots = new Map([
    ['near', { id: 'near', name: 'Near', type: 'standup', x: 0.3, y: 0.4, trim: 'all' }],
    ['far', { id: 'far', name: 'Far', type: 'standup', x: 0.7, y: 0.75, trim: 'all' }],
  ])
  // 'far' is step 1, not the default-active step 0 — highlightIndex:1 makes
  // it active so Pass 1 actually draws its leg (phase A12 item 5).
  const g = goal('g-straight-via', 'combo', ['near', 'far'])
  const { runs } = draw(g, 'any', { shotsByID: viaShots, highlightIndex: 1 })
  const nearView = map(0.3, 0.4)
  const waypointView = map(0.4, 0.04) // FLIPPER_ANCHORS.left (rule 6c), not the tombstoned RETURN_WAYPOINT_UV
  const farView = map(0.7, 0.75)
  const stroke = runsEndingAt(runs, farView).find((r) => r.points.length > 3)
  assert(stroke, 'expected to find the near->far viaWaypoint stroke run')
  assert(stroke.points.length === 45, `expected a 2-leg viaWaypoint run (45 points: 1 seed + 2*22 samples), got ${stroke.points.length}`)
  const cornerIdx = 22 // leg 1's last sample == leg 2's origin == the waypoint
  const corner = stroke.points[cornerIdx]
  close(corner.x, waypointView.x, 1e-6, 'corner x lands on the waypoint')
  close(corner.y, waypointView.y, 1e-6, 'corner y lands on the waypoint')
  let worstLeg1 = 0
  for (let i = 0; i <= cornerIdx; i++) worstLeg1 = Math.max(worstLeg1, perpDist(stroke.points[i], nearView, waypointView))
  let worstLeg2 = 0
  for (let i = cornerIdx; i < stroke.points.length; i++) worstLeg2 = Math.max(worstLeg2, perpDist(stroke.points[i], waypointView, farView))
  const leg1Len = Math.hypot(waypointView.x - nearView.x, waypointView.y - nearView.y)
  const leg2Len = Math.hypot(farView.x - waypointView.x, farView.y - waypointView.y)
  assert(worstLeg1 <= 1e-6 * leg1Len, `expected leg 1 (near->waypoint) collinear, worst deviation ${worstLeg1.toExponential(2)}px`)
  assert(worstLeg2 <= 1e-6 * leg2Len, `expected leg 2 (waypoint->far) collinear, worst deviation ${worstLeg2.toExponential(2)}px`)
  return `viaWaypoint run (45 points): corner at (${corner.x.toFixed(1)}, ${corner.y.toFixed(1)}) == the waypoint; leg1 worst deviation ${worstLeg1.toExponential(2)}px, leg2 worst deviation ${worstLeg2.toExponential(2)}px — each leg is its own straight chord, corner allowed`
})

await test('obstacle regression: a "mech" sitting exactly on the chord no longer nudges the direct route off it', () => {
  // Pre-2026-07-29, directControl would have found this chord "blocked"
  // (distanceToSegment(mech, upperA, upperB) === 0 < OBSTACLE_CLEARANCE) and
  // pushed the control point perpendicular until curveClears() passed — a
  // real, visible bow around the obstacle. Both functions are gone; the
  // route must now stay dead straight regardless of what obstacles exist.
  const obstacleShots = new Map([
    ['upperA', { id: 'upperA', name: 'Upper A', type: 'standup', x: 0.3, y: 0.6, trim: 'all' }],
    ['upperB', { id: 'upperB', name: 'Upper B', type: 'standup', x: 0.5, y: 0.6, trim: 'all' }],
    ['mechObstacle', { id: 'mechObstacle', name: 'Mech', type: 'mech', x: 0.4, y: 0.6, trim: 'all' }],
  ])
  const g = goal('g-straight-obstacle', 'combo', ['upperA', 'upperB'])
  // 2026-08-11 (phase A8 interaction): this fixture used to go DIRECT
  // purely from geometry (both upper-half, close together) — phase A8
  // ("flipper-default routing") killed that heuristic, so direct topology
  // now requires an AUTHORED `direct:true`. Added here so this test keeps
  // exercising the thing it's actually about (directControl's obstacle
  // nudge is gone, even for an authored-direct route) rather than silently
  // starting to test the (unrelated) viaWaypoint path instead.
  g.steps[1].direct = true
  // 'upperB' is step 1, not the default-active step 0 — highlightIndex:1
  // makes it active so Pass 1 actually draws its leg (phase A12 item 5).
  const { runs } = draw(g, 'any', { shotsByID: obstacleShots, highlightIndex: 1 })
  const upperAView = map(0.3, 0.6)
  const upperBView = map(0.5, 0.6)
  const stroke = runsEndingAt(runs, upperBView).find((r) => r.points.length > 3)
  assert(stroke, 'expected to find the upperA->upperB direct stroke run')
  assert(stroke.points.length === 23, `expected a single straight leg (23-point run), got ${stroke.points.length}`)
  const segLen = Math.hypot(upperBView.x - upperAView.x, upperBView.y - upperAView.y)
  const eps = 1e-6 * segLen
  let worst = 0
  for (const p of stroke.points) worst = Math.max(worst, perpDist(p, upperAView, upperBView))
  assert(worst <= eps, `expected the route to stay on the chord despite the mech sitting on it (old code would have nudged the control up to 0.32 UV units perpendicular), worst deviation ${worst.toExponential(2)}px (<= ${eps.toExponential(2)}px)`)
  return `upperA->upperB (both upper, close, mech obstacle exactly on the chord midpoint): worst perpendicular deviation = ${worst.toExponential(2)}px — the obstacle nudge is gone, the route stays dead straight`
})

await test('phase A7: lane-route Case B no longer draws AT ALL — there is no arch leg left to deviate from its chord', () => {
  // Pre-phase-A7 this was the straightness section's one exception: every
  // OTHER leg kind got flattened to a dead-straight chord by the 2026-07-29
  // change, but laneRoute's shooter-lane ARCH (Case B/C) was deliberately
  // left curved (archControl sits well off the chord) because a real
  // machine's arch is physical, not synthesized. That distinction — "this
  // ONE leg kind still curves" — no longer has anything to observe on the
  // canvas: Case B draws 0 legs now, same as every other case. laneRoute's
  // own archControl formula is UNCHANGED internally (still called for
  // `partial`, see routeSegment's `fromPlunger` branch) — there is simply no
  // drawn output left to sample a curve out of any more.
  const g = goal('g-arch-survives', 'combo', ['plunge', 'toplane'])
  const { runs } = draw(g, 'any', { showLabels: false })
  const toplaneView = map(0.5, 0.95)
  const stroke = runsEndingAt(runs, toplaneView)
  assert(stroke.length === 0, `expected 0 drawn polyline runs ending at the toplane target (formerly a 45-point curved Case-B run), got ${stroke.length}`)
  return `plunge->toplane draws 0 polyline runs now — the arch that used to survive the 2026-07-29 straightness fix has no drawn leg left to survive ON`
})

// ===========================================================================
section('m2. partial plunge: lane-adjacent mid targets classify SOFT, not FULL (rolo 2026-08-02; classifyPlunge unit-level since phase A12 item 1 removed the gauge)')
// ===========================================================================
// 2026-08-11 (phase A12 item 1 — rolo: "the gradient line for the plunger —
// remove that feature"): drawPlungeGauge is deleted outright, so there is no
// longer any RENDERED signal of classifyPlunge's verdict to read at all —
// gaugeLabelCalls's "gauge-based since phase A7" workaround (reading the
// classification off a drawn SOFT/FULL PLUNGE label) is retired along with
// it. classifyPlunge is now EXPORTED (see drawing.ts's own doc comment on
// it) specifically so these three tests can call it directly instead.

await test('a target at (0.74,0.45) classifies as partial (SOFT), not full', () => {
  const cls = drawing.classifyPlunge({ x: 0.74, y: 0.45 })
  assert(cls.kind === 'partial', `expected kind 'partial' for a lane-adjacent mid-playfield target, got ${cls.kind}`)
  return `classifyPlunge({x:0.74,y:0.45}) = {kind:'partial', v:${cls.v.toFixed(2)}} — a light pull, not a full send`
})

await test('tuned band: a target at (0.57,0.52) — Addams Thing eject shape — classifies as partial (SOFT)', () => {
  const cls = drawing.classifyPlunge({ x: 0.57, y: 0.52 })
  assert(cls.kind === 'partial', `expected kind 'partial' for the x=0.57 boundary case (band should admit x>=0.57), got ${cls.kind}`)
  return `classifyPlunge({x:0.57,y:0.52}) = {kind:'partial', v:${cls.v.toFixed(2)}} — the 0.57 boundary case`
})

await test("plunge:'full' hint beats the partial band (James Bond right-orbit shape) — classifies as full", () => {
  const cls = drawing.classifyPlunge({ x: 0.74, y: 0.47 }, 'full')
  assert(cls.kind === 'full', `expected kind 'full' despite partial-band coordinates (the explicit hint wins), got ${cls.kind}`)
  return `classifyPlunge({x:0.74,y:0.47}, 'full') = {kind:'full'} — full send despite partial-band coordinates, because the explicit plunge:'full' hint wins`
})

// ===========================================================================
section('n. any-order goals: no connector legs, targets still ring (rolo 2026-08-02)')
// ===========================================================================

await test('ordered:false draws ZERO polyline runs but still rings every target', () => {
  const g = { ...goal('g-anyorder', 'multiball', ['orbit', 'bumper', 'basket']), ordered: false }
  const { calls, runs } = draw(g, 'any', { showLabels: false })
  assert(runs.length === 0,
    `an any-order goal drew ${runs.length} polyline runs — connector legs/arrowheads must be suppressed`)
  const arcs = calls.filter((c) => c.method === 'arc')
  assert(arcs.length >= 3, `expected >=3 ring/badge arcs for 3 targets, got ${arcs.length}`)
  return `0 polyline runs, ${arcs.length} arcs for 3 targets`
})

await test('ordered:false also forces the tracer ball off', () => {
  const g = { ...goal('g-anyorder-tracer', 'multiball', ['orbit', 'bumper', 'basket']), ordered: false }
  const { runs } = draw(g, 'any', { showLabels: false, ballTracer: true })
  assert(runs.length === 0,
    `ballTracer:true on an any-order goal still drew ${runs.length} polyline runs (comet/legs)`)
  return 'tracer suppressed with the legs'
})

await test("a single step with link:'none' loses only ITS leg; a DIFFERENT step's leg is unaffected (item 5, 2026-08-11: since only the ACTIVE step's leg ever draws now, this is checked per-step via highlightIndex rather than by comparing whole-route run counts)", () => {
  const base = goal('g-mixed', 'multiball', ['orbit', 'bumper', 'basket'])
  const withNone = {
    ...base,
    steps: base.steps.map((s, i) => (i === 1 ? { ...s, link: 'none' } : s)),
  }
  // Step 1 (bumper) carries link:'none' — while IT is active, its own leg
  // stays suppressed (0 runs), same as an any-order goal's suppressed step.
  const step1Suppressed = draw(withNone, 'any', { showLabels: false, highlightIndex: 1 }).runs.length
  assert(step1Suppressed === 0, `expected step 1's own leg suppressed by its link:'none' while active, got ${step1Suppressed} runs`)
  // Step 2 (basket) carries no link override — its own leg draws normally
  // when IT is active, identically whether or not a DIFFERENT step (1)
  // happens to carry link:'none' — the suppression is per-step, not whole-goal.
  const step2Full = draw(base, 'any', { showLabels: false, highlightIndex: 2 }).runs.length
  const step2Mixed = draw(withNone, 'any', { showLabels: false, highlightIndex: 2 }).runs.length
  assert(step2Full > 0, 'sanity: step 2 should draw a leg when active in the default (no link override) goal')
  assert(step2Mixed === step2Full, `expected step 2's own leg unaffected by step 1's link:'none' (${step2Full} runs either way), got ${step2Mixed}`)
  return `step 1 active: ${step1Suppressed} runs (its own link:'none' suppresses only its leg); step 2 active: ${step2Mixed} runs either way (unaffected by a DIFFERENT step's link override) — link:'none' is per-step, not whole-goal`
})

// ===========================================================================
section('u. plungeTo variant (models.ts GoalStep.plungeTo, schema v5, 2026-08-10 phase A2; classifyPlunge unit-level since phase A12 item 1 removed the gauge)')
// ===========================================================================
// laneRoute's Case A2 (partial plunge) used to always exit at
// `min(t.y + 0.06, 0.8)`. plungeTo lets a step author the ball's actual stop
// height instead — an authored value wins outright, clamped to
// [0.10, LANE_TOP_V]; an absent value must reproduce the old formula
// byte-for-byte. classifyPlunge (laneRoute's own internal classifier,
// EXPORTED since phase A12 item 1 — see drawing.ts's own doc comment) is
// where this clamp actually lives, so these four tests call it directly
// rather than reading it back off drawn/gauge geometry that no longer
// exists (drawPlungeGauge was deleted the same phase — see this file's
// header note).

await test('plungeTo=0.5 on a partial-plunge target raises the clamped height to 0.5, not the target-derived default (0.51)', () => {
  const cls = drawing.classifyPlunge({ x: 0.74, y: 0.45 }, 'partial', 0.5)
  assert(cls.kind === 'partial', 'sanity: expected a partial classification')
  close(cls.v, 0.5, 1e-9, "classifyPlunge's clamped v")
  // Sanity: the target-derived default (min(0.45+0.06,0.8)=0.51) differs
  // visibly, proving plungeTo actually overrode it rather than this
  // assertion passing by coincidence.
  assert(Math.abs(cls.v - 0.51) > 0.001, 'fixture sanity: plungeTo=0.5 must differ from the default 0.51 exit by a visible margin')
  return `classifyPlunge({x:0.74,y:0.45}, 'partial', 0.5).v = ${cls.v}, overriding the target-derived default 0.51`
})

await test('plungeTo above LANE_TOP_V (0.88) clamps to 0.88', () => {
  const cls = drawing.classifyPlunge({ x: 0.74, y: 0.45 }, 'partial', 0.95)
  assert(cls.kind === 'partial', 'sanity: expected a partial classification')
  close(cls.v, 0.88, 1e-9, "classifyPlunge's clamped v")
  return `plungeTo=0.95 clamps to v=${cls.v}`
})

await test('plungeTo below 0.10 clamps to 0.10', () => {
  const cls = drawing.classifyPlunge({ x: 0.74, y: 0.45 }, 'partial', 0.02)
  assert(cls.kind === 'partial', 'sanity: expected a partial classification')
  close(cls.v, 0.1, 1e-9, "classifyPlunge's clamped v")
  return `plungeTo=0.02 clamps to v=${cls.v}`
})

await test('absent plungeTo reproduces the pre-plungeTo exit formula exactly: min(t.y+0.06, 0.8)', () => {
  const cls = drawing.classifyPlunge({ x: 0.74, y: 0.45 })
  assert(cls.kind === 'partial', 'sanity: expected a partial classification')
  const oldFormulaV = Math.min(0.45 + 0.06, 0.8) // == 0.51, the pre-plungeTo Case A2 exit formula
  close(cls.v, oldFormulaV, 1e-9, "classifyPlunge's v with no authored plungeTo")
  return `no plungeTo authored: v=${cls.v} == min(t.y+0.06,0.8)=${oldFormulaV} — byte-identical to the pre-plungeTo formula`
})

// ===========================================================================
section('v. no-gauge regression (2026-08-11, phase A12 item 1 — rolo: "the gradient line for the plunger — remove that feature")')
// ===========================================================================
// drawPlungeGauge/Pass 1.5/PLUNGE_GAUGE_* were deleted outright (see
// drawing.ts's header note) — sections v/v2 used to cover WHEN/WHERE/WHAT
// the gauge drew (label presence per plunge-origin/non-plunge-origin active
// step, the degenerate-segment gate, the outside-the-playfield repaint
// position, the gradient fillStyle); the underlying classifyPlunge/plungeTo
// classification those tests actually cared about is covered directly at
// the unit level instead (sections m2/u above, now calling
// drawing.classifyPlunge). What's left here collapses to ONE regression
// pin: no gauge output survives, across every shape that used to draw one.

await test('no gauge label / gradient / fill-rect survives for ANY previously-gauged shape', () => {
  const shots = new Map(SHOTS.map((s) => [s.id, s]))
  shots.set('softtarget', { id: 'softtarget', name: 'Soft Target', type: 'bumpers', x: 0.74, y: 0.45, trim: 'all' })
  const gaugeShapes = [
    goal('g-nogauge-full', 'combo', ['plunge', 'flipper']), // Case A / full send
    (() => {
      const g = goal('g-nogauge-partial', 'skillshot', ['softtarget'])
      g.steps[0].plunge = 'partial'
      g.steps[0].plungeTo = 0.5 // authored plungeTo used to move the gauge's OWN fill height
      return g
    })(),
    goal('g-nogauge-none', 'combo', ['flipper', 'orbit']), // no plunger-origin step at all
  ]
  for (const g of gaugeShapes) {
    const { calls } = draw(g, 'any', { shotsByID: shots, highlightIndex: 0, showLabels: true })
    const labels = calls.filter(
      (c) => (c.method === 'fillText' || c.method === 'strokeText') && (c.args[0] === 'SOFT PLUNGE' || c.args[0] === 'FULL PLUNGE'),
    )
    const gradients = calls.filter((c) => c.method === 'createLinearGradient')
    const rects = calls.filter((c) => c.method === 'rect')
    assert(labels.length === 0, `goal ${g.id}: expected 0 SOFT/FULL PLUNGE labels, got ${labels.length}`)
    assert(gradients.length === 0, `goal ${g.id}: expected 0 createLinearGradient calls, got ${gradients.length}`)
    assert(rects.length === 0, `goal ${g.id}: expected 0 rect() calls (the gauge's fill was the only caller in this file), got ${rects.length}`)
  }
  // Degenerate ring-at-anchor (section k's own fixture) — belt-and-suspenders:
  // this used to need its OWN distance gate (Pass 1.5) to avoid drawing a
  // gauge with nothing else on screen; now there is no Pass 1.5 to gate at all.
  const ringOnAnchor = new Map([['ring', { id: 'ring', name: 'Ring', type: 'plunge', x: LANE_X, y: 0.02, trim: 'all' }]])
  const { runs, calls: degenerateCalls } = draw(goal('g-nogauge-degenerate', 'combo', ['ring']), 'any', {
    shotsByID: ringOnAnchor,
    showLabels: false,
  })
  assert(runs.length === 0, `expected 0 polyline runs for the degenerate ring segment, got ${runs.length}`)
  const degenerateGradients = degenerateCalls.filter((c) => c.method === 'createLinearGradient')
  assert(degenerateGradients.length === 0, `expected 0 gradients for the degenerate ring segment, got ${degenerateGradients.length}`)

  return `0 gauge labels / gradients / rect() calls across ${gaugeShapes.length} previously-gauged shapes (full send, partial+authored plungeTo, no-plunge-step) plus the degenerate ring-at-anchor case — drawPlungeGauge leaves no trace anywhere`
})

// ===========================================================================
section('w. decel soft-plunge tracer (phase A6, 2026-08-11): eased progress on partial-plunge lane segments only')
// ===========================================================================
// tracerAt maps a partial-plunge LANE segment's raw (linear, constant-speed)
// time-fraction `u` through 1-(1-u)^2 before sampling position — front-
// loaded progress, so the flying ball covers ground fast right off the
// plunger and visibly decelerates into its landing. Flagged on the
// FlatSegment via `easing:'decel'` (laneRoute's own classifyPlunge verdict,
// threaded through routeSegment/flattenSegment — see drawing.ts's header).

function makeFlatWithEasing(coords, easing) {
  const flat = makeFlat(coords)
  return { ...flat, easing }
}

await test("a flat flagged easing:'decel' reports u=0.75 (eased) at raw time-fraction 0.5 — landing FURTHER along the path than a linear flat at the same instant", () => {
  // Both 340px long -> travel = max(220, 340/340*1000) = 1000ms; t=500 is
  // exactly the raw time-fraction 0.5 for either (same clean numbers as
  // section n's flatA/flatB).
  const linear = makeFlat([[0, 0], [340, 0]])
  const decel = makeFlatWithEasing([[0, 0], [340, 0]], 'decel')
  const rLinear = drawing.tracerAt([linear], 500)
  const rDecel = drawing.tracerAt([decel], 500)
  assert(rLinear.u !== null && rDecel.u !== null, 'expected both still travelling at t=500')
  close(rLinear.u, 0.5, 1e-6, 'linear flat: u tracks the raw time-fraction exactly')
  close(rDecel.u, 0.75, 1e-6, 'decel flat: u = 1-(1-0.5)^2 = 0.75, NOT the raw 0.5')
  assert(rDecel.ball.x > rLinear.ball.x, `expected the decel ball further along the (straight, +x) path than the linear ball: decel x=${rDecel.ball.x} vs linear x=${rLinear.ball.x}`)
  return `at the same instant (raw time-fraction 0.5), the linear flat's ball sits at u=0.50 (x=${rLinear.ball.x.toFixed(1)}) while the decel flat's ball has already reached u=0.75 (x=${rDecel.ball.x.toFixed(1)}) — decel front-loads progress, matching a soft pull that leaves fast and dies into its landing`
})

await test('a flat with NO easing field (the overwhelming majority) is completely unaffected — u stays linear', () => {
  const plain = makeFlat([[0, 0], [340, 0]]) // no `easing` key at all
  const r = drawing.tracerAt([plain], 250) // raw time-fraction 0.25
  close(r.u, 0.25, 1e-6, 'expected u to track the raw time-fraction exactly with no easing field present')
  return `flat.easing undefined -> u=${r.u} == the raw time-fraction, byte-identical to before A6`
})

await test("easing:'decel' leaves both endpoints alone — u=0 at departure, u approaches 1 near arrival, same as linear", () => {
  const decel = makeFlatWithEasing([[0, 0], [340, 0]], 'decel')
  const start = drawing.tracerAt([decel], 0)
  close(start.u, 0, 1e-9, 'expected u=0 at the exact start regardless of easing (1-(1-0)^2=0)')
  const nearEnd = drawing.tracerAt([decel], 999) // just before dwellStart=1000
  assert(nearEnd.u > 0.99, `expected u to still approach 1 near the end of travel, got ${nearEnd.u}`)
  return `decel easing reshapes only the MIDDLE of the flight — both endpoints (u=0 departing, u->1 arriving) land where a linear flat would put them`
})

await test('goal [pops] (would-be partial-plunge integration): draws NO polyline, and the tracer never gets stuck flying it', () => {
  // 2026-08-11 (phase A7): this used to independently reconstruct the
  // partial-plunge segment's flattened polyline/arc-length table and prove
  // the flying ball's position matched the EASED (not linear) prediction —
  // impossible now, since the segment draws no polyline to reconstruct or
  // fly at all (routeSegment's `fromPlunger` branch discards laneRoute's
  // `legs`, so flattenSegment returns null here — no `feeds` on 'pops' means
  // no surviving extension either). Reworked into what the task actually
  // needs proven: the route is gone (0 runs), AND the tracer — which now has
  // nothing to fly for this segment — never gets stuck or throws across a
  // full cycle. This exercises the SAME null/degenerate-flat dwell-only-
  // phase machinery section k's regression and section n's tracerAt unit
  // tests cover directly, end-to-end through drawGoalOverlay for a real
  // (would-be partial-plunge) goal.
  const shots = new Map(SHOTS.map((s) => [s.id, s]))
  shots.set('pops', { id: 'pops', name: 'Pops', type: 'bumpers', x: 0.74, y: 0.45, trim: 'all' })
  const g = goal('g-decel-integration', 'skillshot', ['pops'])
  const target = map(0.74, 0.45)

  const { runs: geomRuns } = draw(g, 'any', { shotsByID: shots, showLabels: false })
  assert(runsEndingAt(geomRuns, target).length === 0, 'expected 0 drawn polyline runs (the partial-plunge lane leg is gone)')

  // Sweep several times across (and past) a full tracer cycle (single-null-
  // flat cycle = 620ms dwell + 900ms end pause = 1520ms): the ball must
  // never appear (nothing to fly) and drawGoalOverlay must never throw or
  // return a non-finite highlightIndex.
  for (const time of [0, 200, 620, 900, 1520, 3200]) {
    const { calls, result } = draw(g, 'any', { shotsByID: shots, showLabels: false, ballTracer: true, time })
    const gradients = calls.filter((c) => c.method === 'createRadialGradient')
    assert(gradients.length === 0, `expected no tracer-ball gradient at t=${time} (nothing to fly), got ${gradients.length}`)
    assert(Number.isFinite(result.highlightIndex), `expected a finite highlightIndex at t=${time}, got ${result.highlightIndex}`)
  }
  return `plunge->pops draws 0 polyline runs; the tracer produced 0 ball gradients and a finite highlightIndex across a full cycle sweep — the degenerate/null-flat handling (section k's precedent) keeps it from getting stuck`
})

await test('goal [plunge] (Case A / would-be full plunge, NOT partial): draws NO polyline, and the tracer never gets stuck flying it', () => {
  // 2026-08-11 (phase A7): same rework as the [pops] test above — this used
  // to independently reconstruct the Case-A segment's polyline and prove the
  // ball tracked LINEAR (non-eased) progress, confirming decel easing didn't
  // leak onto a non-partial plunge. There is no polyline left to
  // reconstruct or fly (same fixture as section a: step 0 targets the
  // 'plunge' shot itself at (0.96,0.3), classifyPlunge's 'caseA'). What's
  // left worth proving is unchanged in spirit: 0 drawn runs, and the tracer
  // (nothing to fly) never gets stuck or throws — a decel-easing regression
  // here would most likely show up as a NaN or a stuck ball, exactly what
  // this sweep checks for.
  const g = goal('g-decel-nonpartial', 'combo', ['plunge'])
  const target = map(0.96, 0.3)

  const { runs: geomRuns } = draw(g, 'any', { showLabels: false })
  assert(runsEndingAt(geomRuns, target).length === 0, 'expected 0 drawn polyline runs (the Case-A lane leg is gone)')

  for (const time of [0, 200, 620, 900, 1520, 3200]) {
    const { calls, result } = draw(g, 'any', { showLabels: false, ballTracer: true, time })
    const gradients = calls.filter((c) => c.method === 'createRadialGradient')
    assert(gradients.length === 0, `expected no tracer-ball gradient at t=${time} (nothing to fly), got ${gradients.length}`)
    assert(Number.isFinite(result.highlightIndex), `expected a finite highlightIndex at t=${time}, got ${result.highlightIndex}`)
  }
  return `plunge->plunge(itself) draws 0 polyline runs; the tracer produced 0 ball gradients and a finite highlightIndex across a full cycle sweep`
})

// ===========================================================================
section("x. real Jaws data regression (data/jaws_goals.json 'skillshot-level-3', phase A10, 2026-08-11)")
// ===========================================================================
// Uses the REAL shot ids/coordinates/types/feeds from data/jaws_goals.json's
// 'skillshot-level-3' goal (shooter-lane plunge:'full' -> fish-finder-bank
// flipper:'right') as a realistic fixture — read directly from that file
// while writing this section (this suite reads data/, never writes it).
// Hardcoded here (not a live import of the JSON) so this test stays stable
// regardless of later data/ edits — data/ is a moving target authored by
// other agents in parallel with this work.
//
// REWORKED 2026-08-11 (phase A10, "skillshot = target-only rendering" —
// supersedes the phase A7 version of this section, which asserted a real
// DRAWN rule-7 continuation and a real drawn flipper->bank leg here).
// 'skillshot-level-3' is a `category: 'skillshot'` goal, and NEITHER of its
// two steps carries an authored `link: 'route'` — so phase A10's inverted
// default ("every step behaves as if link:'none'" for this category) now
// suppresses EVERY connector leg for it, including shooter-lane's own real
// rule-7 continuation. That continuation now ALSO resolves a `loop` around
// the fishing-reel spinner (the concurrent phase A9 data/code landing —
// JAWS_SHOTS below mirrors the real shooter-lane.feeds shape, loop and
// all), which changes nothing about this section's outcome: "no flipper-
// anchored legs, no feed continuations, no loop coils" is a blanket rule
// for the category, not conditional on what kind of continuation it would
// have been. What SURVIVES for a skillshot goal: the plunge gauge (per the
// active plunger-origin step — entirely unrelated to `link`) and every
// step's ring/badge. Test (c) proves the escape hatch (`link:'route'`) opts
// a step's leg back in exactly like a non-skillshot goal's default — and
// that the OTHER (un-opted-in) step stays suppressed, i.e. the hatch is
// per-step, not whole-goal.

const JAWS_SHOTS = new Map([
  ['shooter-lane', { id: 'shooter-lane', name: 'Shooter Lane', type: 'plunge', x: 0.96, y: 0.3, trim: 'all', feeds: { shot: 'mini-flipper', loop: { shot: 'fishing-reel' } } }],
  ['mini-flipper', { id: 'mini-flipper', name: 'Mid-Right Mini Flipper', type: 'flipper', x: 0.78, y: 0.3, trim: 'all', bat: { side: 'right', size: 'mini' } }],
  ['fishing-reel', { id: 'fishing-reel', name: 'Fishing Reel (The Pond)', type: 'spinner', x: 0.66, y: 0.62, trim: 'all' }],
  ['fish-finder-bank', { id: 'fish-finder-bank', name: 'Left 3-Bank (Fish Finder)', type: 'target-bank', x: 0.15, y: 0.36, trim: 'all' }],
])

await test('(a) the plunge segment AND its real rule-7/loop-coil continuation both draw ZERO polyline runs — the ring still draws; no gauge left to draw either (phase A12 item 1)', () => {
  const g = goal('skillshot-level-3', 'skillshot', ['shooter-lane', 'fish-finder-bank'])
  g.steps[0].plunge = 'full'
  g.steps[1].flipper = 'right'
  const { runs, calls } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false })
  const laneView = map(0.96, 0.3)
  const feedView = map(0.78, 0.3) // mini-flipper — shooter-lane's resolved feeds target
  assert(runsEndingAt(runs, laneView).length === 0, 'expected 0 drawn polyline runs ENDING at the shooter-lane ring itself (no main plunge leg — unchanged from phase A7)')
  const continuation = runsEndingAt(runs, feedView).filter((r) => r.points.length > 3)
  assert(continuation.length === 0, `expected ZERO drawn continuation runs ending at the mini-flipper feed point — phase A10 suppresses the rule-7/loop-coil continuation too for an un-opted-in skillshot step, got ${continuation.length}`)
  const ringAt = (p) => calls.filter((c) => c.method === 'arc' && Math.abs(c.args[0] - p.x) <= 1e-6 && Math.abs(c.args[1] - p.y) <= 1e-6)
  assert(ringAt(laneView).length > 0, 'expected the shooter-lane target to still get its ring/badge even with every leg suppressed (it is the default-active step 0)')
  const gauge = calls.filter((c) => (c.method === 'fillText' || c.method === 'strokeText') && (c.args[0] === 'SOFT PLUNGE' || c.args[0] === 'FULL PLUNGE'))
  assert(gauge.length === 0, `expected 0 gauge label calls — drawPlungeGauge was removed outright (phase A12 item 1), got ${gauge.length}`)
  return `shooter-lane's main leg AND its real feeds->loop-coil continuation both draw 0 runs; the ring still shows and 0 gauge labels drew (the gauge no longer exists) — phase A10's blanket skillshot suppression`
})

await test("(b) segment 2 (mini-flipper exit -> fish-finder-bank) ALSO draws zero runs when active — its ring shows only while it's the active step (item 5), not while shooter-lane is", () => {
  const g = goal('skillshot-level-3', 'skillshot', ['shooter-lane', 'fish-finder-bank'])
  g.steps[0].plunge = 'full'
  g.steps[1].flipper = 'right'
  const bankView = map(0.15, 0.36)
  const ringAt = (calls, p) => calls.filter((c) => c.method === 'arc' && Math.abs(c.args[0] - p.x) <= 1e-6 && Math.abs(c.args[1] - p.y) <= 1e-6)

  // fish-finder-bank (step 1) active: its own leg is STILL suppressed (a
  // skillshot step's leg is suppressed by default even for an ordinary
  // rule-6 route, not just a plunge), but its ring/badge draws now that
  // it's the active step.
  const { runs, calls } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false, highlightIndex: 1 })
  const bankStroke = runsEndingAt(runs, bankView).filter((r) => r.points.length > 3)
  assert(bankStroke.length === 0, `expected ZERO drawn runs for segment 1 (mini-flipper -> fish-finder-bank) while active, got ${bankStroke.length}`)
  assert(ringAt(calls, bankView).length > 0, 'expected fish-finder-bank to still get its ring/badge with its leg suppressed, once it is the active step')

  // shooter-lane (step 0, the default) active instead: fish-finder-bank's
  // ring is now suppressed too — only ONE step's ring ever shows (item 5).
  const { calls: callsStep0 } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false })
  assert(ringAt(callsStep0, bankView).length === 0, `expected fish-finder-bank's ring suppressed while shooter-lane (step 0) is active instead, got ${ringAt(callsStep0, bankView).length}`)

  return `mini-flipper -> fish-finder-bank draws 0 runs even while active (skillshot leg suppression applies to an ordinary rule-6 segment exactly as it does to the plunge segment); its ring shows only while it's the active step, suppressed otherwise`
})

await test("(c) the escape hatch: link:'route' on fish-finder-bank's step opts its leg back in (drawn exactly like a non-skillshot default) once it's active; shooter-lane's own (un-opted-in) continuation stays suppressed even while IT is active — per-step, not whole-goal", () => {
  const g = goal('skillshot-level-3', 'skillshot', ['shooter-lane', 'fish-finder-bank'])
  g.steps[0].plunge = 'full'
  g.steps[1].flipper = 'right'
  g.steps[1].link = 'route'
  const feedView = map(0.78, 0.3) // mini-flipper — segment 1's real origin (rule 7(2) chaining)
  const bankView = map(0.15, 0.36)

  // Segment 1 (fish-finder-bank), opted in via link:'route' — active.
  const { runs: runsStep1 } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false, highlightIndex: 1 })
  const bankStroke = runsEndingAt(runsStep1, bankView).find((r) => r.points.length > 3)
  assert(bankStroke, "expected link:'route' to opt segment 1's leg back in once it is the active step")
  assert(bankStroke.points.length === 45, `expected the ordinary 2-leg rule-6 viaWaypoint run (45 points: mini-flipper -> right-flipper anchor -> bank) once opted back in, got ${bankStroke.points.length}`)
  close(bankStroke.points[0].x, feedView.x, 1e-6, "segment 1's origin x must still be shooter-lane's resolved feed exit (mini-flipper), not its ring")
  close(bankStroke.points[0].y, feedView.y, 1e-6, "segment 1's origin y must still be shooter-lane's resolved feed exit")
  const rightAnchorView = map(0.6, 0.04) // FLIPPER_ANCHORS.right, matches step 1's explicit flipper:'right'
  const cornerDist = closestDist(bankStroke.points, rightAnchorView)
  assert(cornerDist <= 1e-6, `expected the route's corner to land exactly on the right-flipper anchor (0.60,0.04), closest was ${cornerDist}`)

  // Segment 0 (shooter-lane), NOT opted in — active instead. Its own rule-7
  // continuation stays suppressed even though it's the currently-active
  // step — the escape hatch is per-step, it was only authored on
  // fish-finder-bank's step.
  const { runs: runsStep0 } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false, highlightIndex: 0 })
  const stillSuppressed = runsEndingAt(runsStep0, feedView).filter((r) => r.points.length > 3)
  assert(stillSuppressed.length === 0, "expected shooter-lane's OWN continuation to stay suppressed even while it is the active step — the escape hatch is per-step, it was only authored on fish-finder-bank's step")

  return `link:'route' on fish-finder-bank's step draws its 45-point leg (once active) from mini-flipper (${feedView.x},${feedView.y}) through the right-flipper anchor to the bank, exactly like a non-skillshot default — while shooter-lane's own (un-opted-in) continuation stays suppressed (0 runs) even while IT is active`
})

// ===========================================================================
section("y. shot-lines toggle (owner request, Feature 8, phase A15, 2026-08-11): o.shotLines === false is the single gate point (drawing.ts's stepLinkSuppressed) that suppresses EVERY step's leg/extLegs/loop-coil for the WHOLE goal, any category — rings/badges/name captions keep marching; the SAME toggle, default true, round-trips through state.ts's readBoolPref/SHOT_LINES_KEY")
// ===========================================================================
// Owner's own words (verbatim from the task brief): "I think an on off
// button to remove the shot lines can be helpful. Then just the targets are
// displayed, it gives the user to just see each target shot without being
// confused with the line."

await test('OFF: zero polyline runs anywhere for a multi-step non-skillshot goal, while the active step still draws its ring, numbered badge, and name caption', () => {
  const g = goal('g-shotlines-off', 'combo', ['flipper', 'orbit', 'basket'])
  const { runs, calls } = draw(g, 'any', { shotsByID, showLabels: false, shotLines: false })
  assert(runs.length === 0, `expected 0 polyline runs anywhere (no flipper-anchored legs, no rule-7/loop-coil continuations) with shotLines:false, got ${runs.length}`)
  const flipperView = map(0.41, 0.06)
  const ringHits = calls.filter((c) => c.method === 'arc' && Math.abs(c.args[0] - flipperView.x) <= 1e-6 && Math.abs(c.args[1] - flipperView.y) <= 1e-6)
  assert(ringHits.length > 0, "expected the active step's ring (arc() calls centered on the flipper target) to still draw")
  const badgeOne = calls.filter((c) => c.method === 'fillText' && c.args[0] === '1')
  assert(badgeOne.length > 0, 'expected the numbered badge "1" to still draw for the active step')
  const nameCaption = calls.filter((c) => (c.method === 'fillText' || c.method === 'strokeText') && c.args[0] === 'Flipper target')
  assert(nameCaption.length > 0, "expected the active target's NAME caption (Pass 2.5) to still draw")
  return `0 polyline runs total; ring (${ringHits.length} arc() calls), badge "1", and name caption "Flipper target" all still recorded for the active step`
})

await test('ON (field omitted, today\'s default): the SAME goal draws its normal 2-leg viaWaypoint run — sanity baseline the next test diffs against', () => {
  const g = goal('g-shotlines-on-baseline', 'combo', ['flipper', 'orbit', 'basket'])
  const { runs } = draw(g, 'any', { shotsByID, showLabels: false })
  assert(runs.length > 0, `expected the default (shotLines omitted) render to draw at least one polyline run, got ${runs.length}`)
  return `default render draws ${runs.length} polyline run(s) — confirms this fixture actually exercises leg-drawing code, so the OFF test above is meaningful and not vacuous`
})

await test('ON: shotLines:true (explicit) reproduces the field-omitted default byte-for-byte — proves "true" and "omitted" are the exact same code path', () => {
  const g1 = goal('g-shotlines-on-a', 'combo', ['flipper', 'orbit', 'basket'])
  const g2 = goal('g-shotlines-on-b', 'combo', ['flipper', 'orbit', 'basket'])
  const { calls: callsDefault } = draw(g1, 'any', { shotsByID, showLabels: false })
  const { calls: callsExplicitOn } = draw(g2, 'any', { shotsByID, showLabels: false, shotLines: true })
  assert(callsDefault.length > 0, 'sanity check: expected the default render to record some calls')
  assert(
    JSON.stringify(callsDefault) === JSON.stringify(callsExplicitOn),
    `expected shotLines:true to be byte-identical to the omitted-field default — ${callsDefault.length} vs ${callsExplicitOn.length} recorded calls`,
  )
  return `shotLines:true reproduces the default render exactly (${callsDefault.length} recorded calls, byte-identical) — "today's exact behavior"`
})

await test('OFF (real fixture): a non-skillshot goal whose active step has a REAL feeds->loop-coil continuation (JAWS shooter-lane data, section x) also draws ZERO runs — proves rule-7/extLegs/loop-coil suppression, not just an ordinary flipper-anchored leg', () => {
  const g = goal('g-shotlines-loop-off', 'combo', ['shooter-lane', 'fish-finder-bank'])
  g.steps[0].plunge = 'full'
  const feedView = map(0.78, 0.3) // mini-flipper — shooter-lane's resolved feeds target

  // Sanity baseline FIRST: with shotLines OMITTED, a plain 'combo' category
  // (no link overrides needed — unlike section x's 'skillshot' fixture)
  // draws shooter-lane's real feeds->loop-coil continuation by default.
  const { runs: onRuns } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false })
  const onContinuation = runsEndingAt(onRuns, feedView).filter((r) => r.points.length > 3)
  assert(onContinuation.length > 0, `sanity check: expected the DEFAULT render to draw shooter-lane's real feeds->loop-coil continuation for a plain 'combo' category, got ${onContinuation.length} matching runs (of ${onRuns.length} total)`)

  const { runs: offRuns } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false, shotLines: false })
  assert(offRuns.length === 0, `expected shotLines:false to suppress EVERYTHING, including the real feeds->loop-coil continuation that just drew above, got ${offRuns.length} runs`)
  return `default render draws shooter-lane's real continuation (${onContinuation.length} run(s) ending at the mini-flipper feed point, of ${onRuns.length} total); shotLines:false drops it to 0 runs total`
})

await test('skillshot stays legless regardless of the toggle — shotLines:true (explicit) and shotLines:false both draw 0 runs for the same real shooter-lane continuation', () => {
  const g = goal('skillshot-level-3', 'skillshot', ['shooter-lane', 'fish-finder-bank'])
  g.steps[0].plunge = 'full'
  g.steps[1].flipper = 'right'
  const { runs: runsOn } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false, shotLines: true })
  const { runs: runsOff } = draw(g, 'any', { shotsByID: JAWS_SHOTS, showLabels: false, shotLines: false })
  assert(runsOn.length === 0, `expected a skillshot goal to stay legless with shotLines:true (existing phase A10 rule, unaffected by this toggle), got ${runsOn.length}`)
  assert(runsOff.length === 0, `expected a skillshot goal to also draw 0 runs with shotLines:false (redundant with its own rule), got ${runsOff.length}`)
  return `skillshot goal draws 0 polyline runs whether shotLines is true or false — the category's own legless rule (phase A10) and the new global toggle never disagree`
})

await test('drawGoalOverlay still returns a valid { highlightIndex } with shotLines:false (the march is unaffected, only the leg drawing is)', () => {
  const g = goal('g-shotlines-off-index', 'combo', ['flipper', 'orbit', 'basket'])
  const { result } = draw(g, 'any', { shotsByID, showLabels: false, shotLines: false, time: 1000 })
  assert(result && typeof result.highlightIndex === 'number', `expected a numeric highlightIndex, got ${JSON.stringify(result)}`)
  assert(result.highlightIndex === 0, `expected autoHighlightIndex(1000, 3) === 0 (unaffected by shotLines), got ${result.highlightIndex}`)
  return `highlightIndex resolves to ${result.highlightIndex} exactly as it does with shot lines on — only Pass 1/extLegs/the tracer are gated, not the march itself`
})

await test('persistence round-trip (state.ts readBoolPref/SHOT_LINES_KEY): unset -> default true; explicit "false"/"true" round-trip; garbage falls back to the default', () => {
  globalThis.localStorage.clear()
  assert(readBoolPref(SHOT_LINES_KEY, true) === true, `expected the documented default (true) for a never-set key, got ${readBoolPref(SHOT_LINES_KEY, true)}`)

  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(SHOT_LINES_KEY, JSON.stringify(false))
  assert(readBoolPref(SHOT_LINES_KEY, true) === false, `expected a stored "false" to round-trip to false, got ${readBoolPref(SHOT_LINES_KEY, true)}`)

  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(SHOT_LINES_KEY, JSON.stringify(true))
  assert(readBoolPref(SHOT_LINES_KEY, true) === true, `expected a stored "true" to round-trip to true, got ${readBoolPref(SHOT_LINES_KEY, true)}`)

  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(SHOT_LINES_KEY, 'not-json-boolean')
  assert(readBoolPref(SHOT_LINES_KEY, true) === true, `expected unparseable garbage to fall back to the documented default (true), got ${readBoolPref(SHOT_LINES_KEY, true)}`)

  assert(SHOT_LINES_KEY === 'pinballgenie.shotLines', `got ${JSON.stringify(SHOT_LINES_KEY)}`)
  return `readBoolPref(SHOT_LINES_KEY, true) round-trips false/true through localStorage, defaults to true when unset, and falls back to true on garbage — SHOT_LINES_KEY === 'pinballgenie.shotLines'`
})

// ---------------------------------------------------------------------------
await rm(tmp, { recursive: true, force: true })
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
