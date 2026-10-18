#!/usr/bin/env node
// app/tests/ramp-route.test.mjs — SPEC-PATHVIZ rules 6-7 (dataset schema v3,
// additive/fail-soft): rule 6 "flipper-anchored launches/returns" (every
// non-direct, non-plunge-origin segment routes through a CHOSEN flipper's
// anchor instead of the fixed RETURN_WAYPOINT_UV/DEFAULT_LAUNCH_UV points)
// and rule 7 "ramp continuation" (a shot whose `feeds` resolves gets two
// more straight, ELEVATED legs chained past its entrance ring: entrance->
// apex->feed, and the NEXT segment originates at that feed point instead of
// the entrance ring). See drawing.ts's 2026-07-29b header note for the full
// rule text, and models.ts's FeedRef/Shot.apex/Shot.feeds/Shot.flipper/
// GoalStep.feeds/GoalStep.flipper doc comments for the schema.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/ramp-route.test.mjs"
// or from app/:
//   node tests/ramp-route.test.mjs
//
// Same esbuild-bundling + recording-Proxy-ctx harness pattern as
// app/tests/plunger-route.test.mjs: the REAL overlay/drawing.ts is bundled
// and its real (exported) surface is exercised through a coordinate-
// capturing 2D-context stub — app/src is never edited or copied. Every
// section below draws with `showLabels:false, ballTracer:false` (fixed
// `time`) for deterministic, geometry-only assertions, exactly like
// plunger-route.test.mjs's own sections a-m — except section (h), which
// explicitly needs `ballTracer:true` to inspect the flying tracer ball.
//
// Sections:
//   a. ramp extension: the run continues past the entrance ring with the
//      expected point counts (22 samples/leg + 1 shared seed) and passes
//      through the synthesized apex exactly (straight legs, no curve slop).
//   b. next-segment origin = the resolved feed point, not the entrance ring.
//   c. the arrowhead stays on the entrance leg's tangent (not the elevated
//      tail's), and a landing marker is drawn at the feed point.
//   d. regression: a shot with NO `feeds` (even `type: 'ramp'`) draws
//      exactly like it did before rule 7 existed — no extension, no landing
//      marker. Activation gate is FEEDS PRESENCE, not `type === 'ramp'`.
//   e. a GoalStep's own `feeds` override beats the target shot's `feeds`.
//   f. FeedRef resolution: `{shot}` wins and resolves to that shot's own
//      (x,y); an UNRESOLVABLE `shot` id is treated as fully absent — it does
//      NOT fall back to a same-ref `x`/`y` sitting right next to it.
//   g. apex synthesis: the exact (2026-07-29-amended) formula
//      `(e.x+0.25*(f.x-e.x), min(0.95, max(e.y+0.22, f.y+0.02)))`, the
//      un-clamped case, the upper-feed case where the new `max(...,f.y+0.02)`
//      term sets the crest (D5's amended formula, "crest never below the
//      landing point"), the `min(0.95, ...)` clamp case, authored `shot.apex`
//      beating synthesis outright, and a PARTIAL authored apex ({x} alone)
//      falling back to synthesis instead of dropping the extension (D5).
//   h. ballTracer:true — at a time chosen to fall past the entrance ring's
//      arc-length position, the flying ball sits exactly on the elevated
//      tail (cross-checked against an independently reconstructed
//      pointAt-equivalent over the actually-drawn polyline, not hand-typed
//      geometry constants).
//   i. repeated ramp steps (the same shot id twice in a row): the second
//      occurrence's segment originates at the FIRST occurrence's feed point,
//      so it stays non-degenerate even though both steps target the same
//      ring (the old ring-to-ring origin would have collapsed to a
//      zero-length segment here).
//   j. rule 6 flipper resolution: cross-flipper heuristic (target-side
//      routes via the OPPOSITE anchor) both ways, step.flipper/shot.flipper
//      overriding the heuristic (and step beating shot), the center-band
//      origin-side tie-break both ways, snap-direct from a feed already on
//      its own flipper (no waypoint detour), a ramp feed routing the NEXT
//      shot via the opposite-side anchor, 'any' launch anchoring at the
//      cross flipper of step 0's target, and an explicit ballPosition never
//      being overridden by any of the above.
//   k. D1 regression: a segment leaving a plunge step that resolved a feed
//      exit is NOT a lane route (fromPlunger depends on the PREVIOUS step's
//      feed resolution, not just its shot type) — no 67-point lane loop, no
//      point inside the shooter-lane x-band.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const srcDir = resolve(appDir, 'src')

// ---------------------------------------------------------------------------
// Tiny harness (matches plunger-route.test.mjs / geometry-chain.test.mjs)
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
// Bundle the real module — drawing.ts (routing/flattening/tracer/rings/
// badges/captions, now rule 6/7 too).
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-ramp-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(entry, `export * as drawing from ${JSON.stringify(resolve(srcDir, 'overlay/drawing'))}\n`)
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const { drawing } = await import(pathToFileURL(outfile).href)

// ---------------------------------------------------------------------------
// Synthetic machine + MapFn — same plain rect as plunger-route.test.mjs,
// v=0 at the bottom (flipper edge).
// ---------------------------------------------------------------------------
const W = 450
const H = 900
const map = (u, v) => ({ x: u * W, y: H - v * H })

// FLIPPER_ANCHORS, mirrored from models.ts BALL_ANCHORS.leftFlipper/
// rightFlipper (drawing.ts derives the same values via anchorToPt — see its
// header note — this file just names the two UV points for readability).
const LEFT_ANCHOR_UV = { x: 0.4, y: 0.04 }
const RIGHT_ANCHOR_UV = { x: 0.6, y: 0.04 }
const DEFAULT_LAUNCH_UV = { x: 0.5, y: 0.03 }
const FLIPPER_SNAP = 0.08 // drawing.ts's FLIPPER_SNAP constant, mirrored here for comments/predictions only

const SHOTS = [
  { id: 'leftTarget', name: 'Left target', type: 'standup', x: 0.3, y: 0.4, trim: 'all' },
  { id: 'rightTarget', name: 'Right target', type: 'standup', x: 0.7, y: 0.4, trim: 'all' },
  { id: 'ramp', name: 'Main ramp', type: 'ramp', x: 0.7, y: 0.55, trim: 'all', feeds: { x: 0.64, y: 0.1 } },
  { id: 'ramp_noFeeds', name: 'Ramp no feeds (type alone must not trigger anything)', type: 'ramp', x: 0.7, y: 0.55, trim: 'all' },
]
const shotsByID = new Map(SHOTS.map((s) => [s.id, s]))

function goal(id, category, steps) {
  return { id, title: id, category, summary: '', difficulty: 1, steps: steps.map((shot) => ({ shot, action: `Shoot ${shot}` })) }
}
/** Like `goal()`, but each step is a full {shot, feeds?, flipper?} def —
 *  used wherever a test needs a GoalStep-level override. */
function goalWithSteps(id, category, stepDefs) {
  return {
    id,
    title: id,
    category,
    summary: '',
    difficulty: 1,
    steps: stepDefs.map((sd) => {
      const step = { shot: sd.shot, action: sd.action ?? `Shoot ${sd.shot}` }
      if (sd.feeds !== undefined) step.feeds = sd.feeds
      if (sd.flipper !== undefined) step.flipper = sd.flipper
      return step
    }),
  }
}

/** Same recording 2D-context stub as plunger-route.test.mjs. */
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
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: (...args) => {
      calls.push({ method: 'createRadialGradient', args })
      return { addColorStop: noop }
    },
    setLineDash: noop,
  }
  const ctx = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: () => true,
  })
  return { ctx, calls }
}

/** Same moveTo+lineTo* run grouping as plunger-route.test.mjs. */
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

function runsEndingAt(runs, target, eps = 1e-6) {
  return runs.filter((r) => {
    const last = r.points[r.points.length - 1]
    return Math.abs(last.x - target.x) <= eps && Math.abs(last.y - target.y) <= eps
  })
}
function runsStartingAt(runs, target, eps = 1e-6) {
  return runs.filter((r) => {
    const first = r.points[0]
    return Math.abs(first.x - target.x) <= eps && Math.abs(first.y - target.y) <= eps
  })
}
function closestDist(points, target) {
  let best = Infinity
  for (const p of points) best = Math.min(best, Math.hypot(p.x - target.x, p.y - target.y))
  return best
}

function draw(g, ballPosition, opts = {}) {
  const {
    time = 1000,
    map: mapOverride,
    shotsByID: shotsOverride,
    showLabels = false,
    ballTracer = false,
    highlightIndex,
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
    showLabels,
  }
  if (highlightIndex !== undefined) o.highlightIndex = highlightIndex
  const result = drawing.drawGoalOverlay(ctx, o)
  return { calls, runs: polylineRuns(calls), result }
}

// ===========================================================================
section('a. ramp extension: past-entrance run, point counts, exact apex sample')
// ===========================================================================

await test("goal [ramp]: the run continues past the entrance ring with 23 (main) + 45 (elevated tail) points, passing exactly through the synthesized apex", () => {
  const g = goal('g-ramp-basic', 'combo', ['ramp'])
  const { runs } = draw(g, 'any')
  const entranceView = map(0.7, 0.55)
  const feedView = map(0.64, 0.1)
  // apex = (e.x + 0.25*(f.x-e.x), min(0.95, e.y+0.22)) = (0.7-0.015, 0.77) = (0.685, 0.77)
  const apexView = map(0.685, 0.77)

  const main = runsEndingAt(runs, entranceView).find((r) => r.points.length > 3)
  assert(main, 'expected the main (launch->entrance) stroke run')
  assert(main.points.length === 23, `expected the main run to be a single 23-point leg (1 seed + 22 samples), got ${main.points.length}`)

  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated entrance->apex->feed run ending at the feed point')
  assert(rampPart.points.length === 45, `expected the elevated tail to be a 2-leg run (45 points: shared entrance seed + 2*22 samples), got ${rampPart.points.length}`)
  close(rampPart.points[0].x, entranceView.x, 1e-6, 'elevated tail shares its first point with the main run\'s last (the entrance ring)')
  close(rampPart.points[0].y, entranceView.y, 1e-6, 'elevated tail shares its first point with the main run\'s last (the entrance ring)')

  const apexDist = closestDist(rampPart.points, apexView)
  assert(apexDist <= 1e-6, `expected an EXACT sample at the synthesized apex (${apexView.x.toFixed(2)},${apexView.y.toFixed(2)}) — legs are straight (control=chord midpoint), so the apex is a real sample, not just "near" — closest was ${apexDist}`)

  return `main run: 23 points ending at the entrance (${entranceView.x},${entranceView.y}); elevated tail: 45 points from there to the feed point (${feedView.x},${feedView.y}), passing exactly through the apex (${apexView.x.toFixed(2)},${apexView.y.toFixed(2)})`
})

// ===========================================================================
section('b. next-segment origin = the resolved feed point, not the entrance ring')
// ===========================================================================

await test("goal [ramp, farTarget]: segment 2 originates at the ramp's feed point (0.64,0.10), not its entrance ring (0.7,0.55)", () => {
  const farTarget = { id: 'farTarget', name: 'Far target', type: 'standup', x: 0.75, y: 0.6, trim: 'all' }
  const shots = new Map([...shotsByID, ['farTarget', farTarget]])
  const g = goal('g-next-origin', 'combo', ['ramp', 'farTarget'])
  // segment 2 (index 1) needs to be the ACTIVE step for its leg to draw at
  // all (phase A12 item 5: only the active step's leg draws now).
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const feedView = map(0.64, 0.1)
  const entranceView = map(0.7, 0.55)
  const targetView = map(0.75, 0.6)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y) // chooseFlipper(target.x=0.75>0.55) -> 'left'

  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the segment-2 stroke run ending at farTarget')
  assert(stroke.points.length === 45, `expected a 2-leg viaWaypoint run (45 points), got ${stroke.points.length}`)
  close(stroke.points[0].x, feedView.x, 1e-6, 'segment-2 origin x must be the feed point')
  close(stroke.points[0].y, feedView.y, 1e-6, 'segment-2 origin y must be the feed point')
  const distToEntrance = Math.hypot(stroke.points[0].x - entranceView.x, stroke.points[0].y - entranceView.y)
  assert(distToEntrance > 5, `expected the origin to be clearly NOT the entrance ring, was only ${distToEntrance.toFixed(2)}px away`)
  const cornerDist = closestDist(stroke.points, leftAnchorView)
  assert(cornerDist <= 1e-6, `expected the viaWaypoint corner to land exactly on the rule-6 left anchor (${leftAnchorView.x},${leftAnchorView.y})`)

  return `segment 2's run is seeded at (${stroke.points[0].x},${stroke.points[0].y}) == the feed point map(0.64,0.10), ${distToEntrance.toFixed(1)}px clear of the entrance ring map(0.7,0.55); corner at the rule-6 left anchor`
})

// ===========================================================================
section('c. arrowhead on the entrance-leg tangent + landing marker at the feed point')
// ===========================================================================

await test('goal [ramp]: the 3-point arrowhead chevron sits near the entrance ring, not the far-away feed point; a landing marker (ring r=9 + dot r=3.5) is drawn at the feed point', () => {
  const g = goal('g-ramp-arrowhead', 'combo', ['ramp'])
  const { calls, runs } = draw(g, 'any')
  const entranceView = map(0.7, 0.55)
  const feedView = map(0.64, 0.1)

  const chevrons = runs.filter((r) => r.points.length === 3)
  assert(chevrons.length > 0, 'expected at least one arrowhead chevron run')
  for (const c of chevrons) {
    const dEntrance = closestDist(c.points, entranceView)
    const dFeed = closestDist(c.points, feedView)
    assert(dEntrance < dFeed, `expected the arrowhead to sit near the ENTRANCE ring (dist ${dEntrance.toFixed(1)}px) rather than the feed point (dist ${dFeed.toFixed(1)}px) — rule 7(3)`)
    assert(dEntrance < 40, `expected the arrowhead within its normal pull-back distance of the entrance, got ${dEntrance.toFixed(1)}px`)
  }

  const ring = calls.find((c) => c.method === 'arc' && Math.abs(c.args[0] - feedView.x) < 1e-6 && Math.abs(c.args[1] - feedView.y) < 1e-6 && Math.abs(c.args[2] - 9) < 1e-6)
  const dot = calls.find((c) => c.method === 'arc' && Math.abs(c.args[0] - feedView.x) < 1e-6 && Math.abs(c.args[1] - feedView.y) < 1e-6 && Math.abs(c.args[2] - 3.5) < 1e-6)
  assert(ring, 'expected the landing marker ring (radius 9) at the feed point')
  assert(dot, 'expected the landing marker dot (radius 3.5) at the feed point')

  return `${chevrons.length} arrowhead chevron(s), all closer to the entrance ring than the feed point; landing marker (ring r=9 + dot r=3.5) confirmed at (${feedView.x},${feedView.y})`
})

// ===========================================================================
section("d. regression: no `feeds` (even type==='ramp') draws exactly as before rule 7")
// ===========================================================================

await test("goal [ramp_noFeeds]: no elevated tail, no landing marker — type==='ramp' alone never activates rule 7", () => {
  const g = goal('g-no-feeds', 'combo', ['ramp_noFeeds'])
  const { calls, runs } = draw(g, 'any')
  const entranceView = map(0.7, 0.55)
  const main = runsEndingAt(runs, entranceView).find((r) => r.points.length > 3)
  assert(main, 'expected the plain direct launch->entrance run')
  assert(main.points.length === 23, `expected an ordinary single-leg 23-point run (no extension appended), got ${main.points.length}`)
  const longer = runs.filter((r) => r.points.length > 23)
  assert(longer.length === 0, `expected NO run longer than 23 points anywhere (no elevated tail was appended), found ${longer.length}`)
  const landingMarkerDots = calls.filter((c) => c.method === 'arc' && Math.abs(c.args[2] - 3.5) < 1e-9)
  assert(landingMarkerDots.length === 0, `expected zero landing-marker dots (radius 3.5), found ${landingMarkerDots.length}`)
  return `single 23-point run, no run longer than 23 points anywhere, zero landing-marker dots — a 'ramp'-typed shot with no feeds renders exactly as it did before rule 7 existed`
})

// ===========================================================================
section("e. a GoalStep's own `feeds` beats the target shot's `feeds`")
// ===========================================================================

await test('step-level feeds (0.36,0.10) wins over the shot-level feeds (0.64,0.10) authored on the same shot', () => {
  const rampX = { id: 'rampX', name: 'Ramp X', type: 'ramp', x: 0.7, y: 0.55, trim: 'all', feeds: { x: 0.64, y: 0.1 } }
  const shots = new Map([['rampX', rampX]])
  const g = goalWithSteps('g-step-feeds', 'combo', [{ shot: 'rampX', feeds: { x: 0.36, y: 0.1 } }])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const stepFeedView = map(0.36, 0.1)
  const shotFeedView = map(0.64, 0.1)
  const stepWins = runsEndingAt(runs, stepFeedView).find((r) => r.points.length > 3)
  const shotLoses = runsEndingAt(runs, shotFeedView).find((r) => r.points.length > 3)
  assert(stepWins, `expected the elevated tail to end at the STEP's feed point (${stepFeedView.x},${stepFeedView.y})`)
  assert(!shotLoses, `expected NO run ending at the shot-level feed point (${shotFeedView.x},${shotFeedView.y}) — the step override must fully replace it, not merge`)
  return `elevated tail ends at the step-level feed (${stepFeedView.x},${stepFeedView.y}); the shot-level feed (${shotFeedView.x},${shotFeedView.y}) is not drawn at all`
})

// ===========================================================================
section('f. FeedRef resolution: {shot} wins and resolves; an unresolvable shot id drops the whole ref (fail-soft)')
// ===========================================================================

await test('feeds:{shot:"inlaneRef"} resolves to that shot\'s own (x,y), not any x/y on the ref itself', () => {
  const rampShotRef = { id: 'ramp_shotref', name: 'Ramp via shot ref', type: 'ramp', x: 0.55, y: 0.5, trim: 'all', feeds: { shot: 'inlaneRef' } }
  const inlaneRef = { id: 'inlaneRef', name: 'Inlane', type: 'lane', x: 0.36, y: 0.1, trim: 'all' }
  const shots = new Map([['ramp_shotref', rampShotRef], ['inlaneRef', inlaneRef]])
  const g = goal('g-shotref', 'combo', ['ramp_shotref'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(0.36, 0.1)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, `expected the elevated tail to resolve to inlaneRef's own coords (${feedView.x},${feedView.y})`)
  return `feeds:{shot:'inlaneRef'} resolved to inlaneRef's own (0.36,0.10) = (${feedView.x},${feedView.y})`
})

await test('feeds:{shot:"doesNotExist", x:0.9, y:0.9} — an unresolvable shot id drops the WHOLE ref, it does NOT fall back to the sibling x/y', () => {
  const rampBadRef = { id: 'ramp_badref', name: 'Ramp bad ref', type: 'ramp', x: 0.55, y: 0.5, trim: 'all', feeds: { shot: 'doesNotExist', x: 0.9, y: 0.9 } }
  const shots = new Map([['ramp_badref', rampBadRef]])
  const g = goal('g-badref', 'combo', ['ramp_badref'])
  const { calls, runs } = draw(g, 'any', { shotsByID: shots })
  const entranceView = map(0.55, 0.5)
  const wouldBeFallbackView = map(0.9, 0.9)
  const main = runsEndingAt(runs, entranceView).find((r) => r.points.length > 3)
  assert(main, 'expected the plain main run to still draw (fail-soft: only the extension drops)')
  assert(main.points.length === 23, `expected the main run un-extended (23 points), got ${main.points.length}`)
  const fallbackRuns = runsEndingAt(runs, wouldBeFallbackView)
  assert(fallbackRuns.length === 0, `expected NO run at the sibling x/y (0.9,0.9) — an unresolvable shot ref must not fall back to it`)
  const landingMarkerDots = calls.filter((c) => c.method === 'arc' && Math.abs(c.args[2] - 3.5) < 1e-9)
  assert(landingMarkerDots.length === 0, `expected zero landing markers (the extension was dropped entirely), found ${landingMarkerDots.length}`)
  return `unresolvable {shot:'doesNotExist', x:0.9,y:0.9} drops the extension entirely — no run at (0.9,0.9), no landing marker, main run renders as a plain 23-point leg`
})

// ===========================================================================
section('g. apex synthesis — exact formula, the 0.95 clamp, and authored shot.apex beating it')
// ===========================================================================

// 2026-07-29 review, amended formula: apex.y = min(0.95, max(e.y+0.22, f.y+0.02)).
// This fixture's feed (f.y=0.60) sits ABOVE e.y+0.22 (0.52), so the amended
// max() clause is the one driving the result now (0.62, not the pre-amendment
// 0.52) — see the "byte-identical for down-feeds" cases elsewhere (section a's
// ramp fixture: e.y+0.22=0.77 > f.y+0.02=0.12, unaffected; still asserts 0.77)
// and the dedicated upper-feed case right below.
await test('apex = (e.x + 0.25*(f.x-e.x), max(e.y+0.22, f.y+0.02)) when unclamped: e=(0.55,0.30), f=(0.20,0.60) -> apex=(0.4625,0.62)', () => {
  const s = { id: 's', name: 'S', type: 'ramp', x: 0.55, y: 0.3, trim: 'all', feeds: { x: 0.2, y: 0.6 } }
  const shots = new Map([['s', s]])
  const g = goal('g-apex-1', 'combo', ['s'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(0.2, 0.6)
  const apexView = map(0.4625, 0.62)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated tail run')
  const d = closestDist(rampPart.points, apexView)
  assert(d <= 1e-6, `expected an exact sample at apex=(0.4625,0.62) -> (${apexView.x.toFixed(2)},${apexView.y.toFixed(2)}), closest was ${d}`)
  return `synthesized apex (0.4625, 0.62) present as an exact sample (dist ${d.toExponential(2)}px) — f.y+0.02 (0.62) beats e.y+0.22 (0.52), so the amended max() clause set the crest height`
})

// D5/decision-3 (2026-07-29 review): an upper-playfield feed (f.y=0.8, well
// above the usual ~0.10 down-feed) must not synthesize a crest BELOW the
// landing point — e.g. the old `min(0.95, e.y+0.22)` formula would have put
// the apex at 0.72 here, under the feed's own 0.80, drawing the tail sloping
// downward INTO the feed from above then doubling back up to it. The amended
// `max(..., f.y+0.02)` term fixes this: apex.y = f.y + 0.02 = 0.82.
await test('upper-feed apex clamp: e=(0.45,0.50), f=(0.30,0.80) -> apex.y = f.y+0.02 = 0.82 (crest never below the landing point)', () => {
  const s = { id: 's', name: 'S', type: 'ramp', x: 0.45, y: 0.5, trim: 'all', feeds: { x: 0.3, y: 0.8 } }
  const shots = new Map([['s', s]])
  const g = goal('g-apex-upper-feed', 'combo', ['s'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(0.3, 0.8)
  const apexView = map(0.4125, 0.82) // x = 0.45 + 0.25*(0.30-0.45) = 0.4125; y = max(0.50+0.22, 0.80+0.02) = max(0.72,0.82) = 0.82
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated tail run')
  const d = closestDist(rampPart.points, apexView)
  assert(d <= 1e-6, `expected an exact sample at apex=(0.4125,0.82) -> (${apexView.x.toFixed(2)},${apexView.y.toFixed(2)}), closest was ${d}`)
  return `upper feed f.y=0.80 -> synthesized apex.y=0.82 (f.y+0.02, beating e.y+0.22=0.72) — the crest sits above the landing point instead of below it`
})

// D5 (2026-07-29 review): a partial authored apex ({x} alone, no finite y)
// must NOT be used outright (the pre-fix `shot.apex ?? synth` would take this
// truthy-but-partial object, feed its `undefined` y into arithmetic, produce
// NaN mapped points, and drop the ENTIRE extension — not just the apex).
// It must instead fall back to synthesis exactly as if `apex` were absent.
await test('partial shot.apex ({x} alone, no y) falls back to SYNTHESIS instead of dropping the extension', () => {
  const s = { id: 's', name: 'S', type: 'ramp', x: 0.55, y: 0.3, trim: 'all', feeds: { x: 0.2, y: 0.6 }, apex: { x: 0.9 } }
  const shots = new Map([['s', s]])
  const g = goal('g-apex-partial', 'combo', ['s'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(0.2, 0.6)
  const synthesizedApexView = map(0.4625, 0.62) // same synthesis formula as the fixture right above
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated tail run to still be drawn (fail-soft: a bad apex must not drop the extension)')
  assert(rampPart.points.length === 45, `expected the ordinary 2-leg elevated run (45 points), got ${rampPart.points.length}`)
  const d = closestDist(rampPart.points, synthesizedApexView)
  assert(d <= 1e-6, `expected the polyline to pass through the SYNTHESIZED apex (0.4625,0.62) -> (${synthesizedApexView.x.toFixed(2)},${synthesizedApexView.y.toFixed(2)}), closest was ${d}`)
  return `partial shot.apex={x:0.9} (no finite y) is discarded — the extension still draws (45 points) through the synthesized apex (0.4625,0.62), not dropped and not NaN`
})

await test('apex y clamps to 0.95: e=(0.60,0.85), f=(0.50,0.95) -> e.y+0.22=1.07 clamps to 0.95, apex=(0.575,0.95)', () => {
  const s = { id: 's', name: 'S', type: 'ramp', x: 0.6, y: 0.85, trim: 'all', feeds: { x: 0.5, y: 0.95 } }
  const shots = new Map([['s', s]])
  const g = goal('g-apex-clamp', 'combo', ['s'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(0.5, 0.95)
  const apexView = map(0.575, 0.95)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated tail run')
  const d = closestDist(rampPart.points, apexView)
  assert(d <= 1e-6, `expected the clamped apex (0.575,0.95) -> (${apexView.x.toFixed(2)},${apexView.y.toFixed(2)}) as an exact sample, closest was ${d}`)
  return `clamped apex (0.575, 0.95) present as an exact sample (dist ${d.toExponential(2)}px) — e.y+0.22=1.07 correctly clamped to 0.95`
})

await test('authored shot.apex beats synthesis outright', () => {
  const s = { id: 's', name: 'S', type: 'ramp', x: 0.7, y: 0.55, trim: 'all', feeds: { x: 0.64, y: 0.1 }, apex: { x: 0.8, y: 0.9 } }
  const shots = new Map([['s', s]])
  const g = goal('g-apex-authored', 'combo', ['s'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(0.64, 0.1)
  const authoredApexView = map(0.8, 0.9)
  const synthesizedApexView = map(0.685, 0.77) // what synthesis WOULD have produced for this same entrance/feed
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated tail run')
  const dAuthored = closestDist(rampPart.points, authoredApexView)
  const dSynth = closestDist(rampPart.points, synthesizedApexView)
  assert(dAuthored <= 1e-6, `expected the AUTHORED apex (0.8,0.9) as an exact sample, closest was ${dAuthored}`)
  assert(dSynth > 1, `expected the polyline NOT to pass through the synthesized apex (0.685,0.77) once an authored apex is present, closest was ${dSynth}`)
  return `authored apex (0.8,0.9) present exactly (dist ${dAuthored.toExponential(2)}px); synthesized apex (0.685,0.77) absent (dist ${dSynth.toFixed(1)}px away) — authored wins outright`
})

// ===========================================================================
section('h. ballTracer:true — the flying ball sits on the elevated tail past a mid-extension time')
// ===========================================================================

/** Same arc-length lerp as drawing.ts's exported pointAt, reimplemented here
 *  over an INDEPENDENTLY reconstructed points/cum table (built from the
 *  actually-drawn polyline, not hand-typed geometry constants) so this test
 *  cross-checks the real tracerAt/pointAt against a from-scratch model
 *  rather than asserting a hand-derived pixel coordinate. */
function pointAtLocal(pts, cum, dist) {
  const d = Math.min(Math.max(dist, 0), cum[cum.length - 1])
  let i = 1
  while (i < cum.length - 1 && cum[i] < d) i++
  const span = cum[i] - cum[i - 1] || 1
  const tt = (d - cum[i - 1]) / span
  const a = pts[i - 1]
  const b = pts[i]
  return { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt }
}
function buildCum(pts) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return cum
}

await test('goal [ramp]: at a time computed to land past the entrance, the tracer ball matches an independently-reconstructed pointAt', () => {
  const g = goal('g-tracer-ramp', 'combo', ['ramp'])
  // Pass 1: draw with ballTracer:false to capture the actual drawn geometry
  // (main run + elevated tail run), exactly as sections a/c already found them.
  const entranceView = map(0.7, 0.55)
  const feedView = map(0.64, 0.1)
  const { runs: geomRuns } = draw(g, 'any')
  const main = runsEndingAt(geomRuns, entranceView).find((r) => r.points.length > 3)
  const rampPart = runsEndingAt(geomRuns, feedView).find((r) => r.points.length > 3)
  assert(main && rampPart, 'expected both the main and elevated-tail runs to reconstruct the full polyline')
  const fullPts = main.points.concat(rampPart.points.slice(1))
  const cum = buildCum(fullPts)
  const totalLen = cum[cum.length - 1]
  const mainLen = buildCum(main.points)[main.points.length - 1]

  // Pick an arc-length target safely inside the elevated tail (past mainLen),
  // then back-solve the `time` tracerAt needs to report exactly that `u`.
  const targetDist = mainLen + (totalLen - mainLen) * 0.5
  assert(targetDist > mainLen, 'sanity: target must be past the entrance (fixture check, not the thing under test)')
  const u = targetDist / totalLen
  const TRACER_SPEED = 340 // drawing.ts's TRACER_SPEED — mirrored here to back-solve `time`
  const TRACER_MIN_TRAVEL_MS = 220 // drawing.ts's TRACER_MIN_TRAVEL_MS
  const travel = Math.max(TRACER_MIN_TRAVEL_MS, (totalLen / TRACER_SPEED) * 1000)
  const time = u * travel // single-step goal -> the only phase starts at t=0, so time IS the travel-elapsed ms

  // Pass 2: draw again with ballTracer:true at that computed time and read
  // the ball's position off the tracer's radial-gradient call (args[3],[4]
  // are the gradient's outer circle center == the ball's exact position).
  const { calls } = draw(g, 'any', { ballTracer: true, time })
  const gradients = calls.filter((c) => c.method === 'createRadialGradient')
  assert(gradients.length === 1, `expected exactly one tracer-ball gradient, got ${gradients.length}`)
  const [, , , bx, by] = gradients[0].args
  const expected = pointAtLocal(fullPts, cum, targetDist)
  close(bx, expected.x, 1e-6, 'ball x matches the independently-reconstructed pointAt')
  close(by, expected.y, 1e-6, 'ball y matches the independently-reconstructed pointAt')
  const distFromEntrance = Math.hypot(bx - entranceView.x, by - entranceView.y)
  assert(targetDist - mainLen > 0, 'sanity: arc-length target is past the entrance')
  return `ball at (${bx.toFixed(1)},${by.toFixed(1)}) matches pointAt(${targetDist.toFixed(1)}) exactly; arc-length past the entrance = ${(targetDist - mainLen).toFixed(1)}px (${distFromEntrance.toFixed(1)}px straight-line from the entrance ring)`
})

// ===========================================================================
section('i. repeated ramp steps: the second occurrence stays non-degenerate')
// ===========================================================================

await test("goal [ramp, ramp] (same shot id twice): segment 2 originates at segment 1's feed point, not the (identical) target ring — non-degenerate", () => {
  const g = goal('g-repeated-ramp', 'combo', ['ramp', 'ramp'])
  const entranceView = map(0.7, 0.55)
  const feedView = map(0.64, 0.1)
  // segment 2 (index 1) active — phase A12 item 5 means only ONE segment's
  // leg ever draws, so this is checked directly rather than by comparing
  // two SIMULTANEOUS runs the way the pre-item-5 version of this test did.
  const { runs } = draw(g, 'any', { highlightIndex: 1 })
  const seg2 = runsEndingAt(runs, entranceView).find((r) => r.points.length > 3)
  assert(seg2, "expected segment 2's run, ending at the (repeated) entrance ring")
  const seededAtFeed = Math.abs(seg2.points[0].x - feedView.x) < 1e-6 && Math.abs(seg2.points[0].y - feedView.y) < 1e-6
  assert(seededAtFeed, "expected segment 2's run to be seeded at the feed point, not collapse to a zero-length ring-to-ring segment")
  assert(seg2.points.length > 1, 'expected a real (non-degenerate) polyline, not a single point')
  return `segment 2 (active) ends at the shared entrance ring, seeded at the feed point (${feedView.x},${feedView.y}) rather than degenerating — the repeated shot id does not collapse the route`
})

// ===========================================================================
section('j. rule 6 flipper resolution')
// ===========================================================================

await test('viaWaypoint: a LEFT-side target (x<0.45) routes via the RIGHT anchor (cross-flipper)', () => {
  const origin = { id: 'origin', name: 'Origin', type: 'standup', x: 0.5, y: 0.3, trim: 'all' }
  const leftSide = { id: 'leftSide', name: 'Left side', type: 'standup', x: 0.2, y: 0.5, trim: 'all' }
  const shots = new Map([['origin', origin], ['leftSide', leftSide]])
  const g = goal('g-cross-right', 'combo', ['origin', 'leftSide'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.2, 0.5)
  const anchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin->leftSide viaWaypoint run')
  const d = closestDist(stroke.points, anchorView)
  assert(d <= 1e-6, `expected the corner exactly on the RIGHT anchor (0.60,0.04), closest was ${d}`)
  return `left-side target (x=0.2<0.45) routes via the RIGHT anchor (0.60,0.04) — the ball crosses from the right flipper`
})

await test('viaWaypoint: a RIGHT-side target (x>0.55) routes via the LEFT anchor (mirror)', () => {
  const origin = { id: 'origin', name: 'Origin', type: 'standup', x: 0.5, y: 0.3, trim: 'all' }
  const rightSide = { id: 'rightSide', name: 'Right side', type: 'standup', x: 0.8, y: 0.5, trim: 'all' }
  const shots = new Map([['origin', origin], ['rightSide', rightSide]])
  const g = goal('g-cross-left', 'combo', ['origin', 'rightSide'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.8, 0.5)
  const anchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin->rightSide viaWaypoint run')
  const d = closestDist(stroke.points, anchorView)
  assert(d <= 1e-6, `expected the corner exactly on the LEFT anchor (0.40,0.04), closest was ${d}`)
  return `right-side target (x=0.8>0.55) routes via the LEFT anchor (0.40,0.04) — the mirror case`
})

await test("shot.flipper overrides the cross-flipper heuristic", () => {
  const origin = { id: 'origin', name: 'Origin', type: 'standup', x: 0.5, y: 0.3, trim: 'all' }
  // Heuristic alone (x=0.2<0.45) would pick 'right'; shot.flipper='left' must win.
  const leftSide = { id: 'leftSide', name: 'Left side', type: 'standup', x: 0.2, y: 0.5, trim: 'all', flipper: 'left' }
  const shots = new Map([['origin', origin], ['leftSide', leftSide]])
  const g = goal('g-shot-flipper', 'combo', ['origin', 'leftSide'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.2, 0.5)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin->leftSide viaWaypoint run')
  const d = closestDist(stroke.points, leftAnchorView)
  assert(d <= 1e-6, `expected shot.flipper='left' to override the heuristic (which would have picked 'right'), got corner dist ${d}`)
  return `shot.flipper='left' overrides the heuristic (x=0.2<0.45 would have picked 'right') — corner at the LEFT anchor`
})

await test("step.flipper beats shot.flipper", () => {
  const origin = { id: 'origin', name: 'Origin', type: 'standup', x: 0.5, y: 0.3, trim: 'all' }
  const leftSide = { id: 'leftSide', name: 'Left side', type: 'standup', x: 0.2, y: 0.5, trim: 'all', flipper: 'left' }
  const shots = new Map([['origin', origin], ['leftSide', leftSide]])
  const g = goalWithSteps('g-step-flipper', 'combo', [{ shot: 'origin' }, { shot: 'leftSide', flipper: 'right' }])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.2, 0.5)
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin->leftSide viaWaypoint run')
  const d = closestDist(stroke.points, rightAnchorView)
  assert(d <= 1e-6, `expected step.flipper='right' to beat shot.flipper='left', got corner dist ${d}`)
  return `step.flipper='right' beats shot.flipper='left' — corner at the RIGHT anchor, even though the shot itself says left`
})

await test('center-band (x=0.5) target: origin.x<0.5 ties to LEFT', () => {
  const origin = { id: 'origin', name: 'Origin', type: 'standup', x: 0.3, y: 0.3, trim: 'all' } // origin.x < 0.5
  const center = { id: 'center', name: 'Center', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }
  const shots = new Map([['origin', origin], ['center', center]])
  const g = goal('g-center-left-origin', 'combo', ['origin', 'center'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.5, 0.5)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin->center viaWaypoint run')
  const d = closestDist(stroke.points, leftAnchorView)
  assert(d <= 1e-6, `expected the center-band tie-break (origin.x=0.3<0.5) to pick LEFT, got corner dist ${d}`)
  return `center-band target (x=0.5) with origin.x=0.3<0.5 ties to the LEFT anchor`
})

await test('center-band (x=0.5) target: origin.x>=0.5 ties to RIGHT (mirror)', () => {
  const origin = { id: 'origin', name: 'Origin', type: 'standup', x: 0.7, y: 0.3, trim: 'all' } // origin.x >= 0.5
  const center = { id: 'center', name: 'Center', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }
  const shots = new Map([['origin', origin], ['center', center]])
  const g = goal('g-center-right-origin', 'combo', ['origin', 'center'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.5, 0.5)
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin->center viaWaypoint run')
  const d = closestDist(stroke.points, rightAnchorView)
  assert(d <= 1e-6, `expected the center-band tie-break (origin.x=0.7>=0.5) to pick RIGHT, got corner dist ${d}`)
  return `center-band target (x=0.5) with origin.x=0.7>=0.5 ties to the RIGHT anchor (mirror)`
})

await test('snap-direct: a feed already on its own flipper collapses to a single direct leg (no waypoint pass-through)', () => {
  // LEFT_INLANE-ish feed (0.36,0.10); next target x=0.8>0.55 -> chooseFlipper
  // picks 'left' regardless of origin -> anchor (0.40,0.04).
  // hypot((0.36,0.10)-(0.40,0.04)) = hypot(0.04,0.06) = 0.0721 < FLIPPER_SNAP(0.08).
  const rampLeftFeed = { id: 'rampLeftFeed', name: 'Ramp left feed', type: 'ramp', x: 0.55, y: 0.5, trim: 'all', feeds: { x: 0.36, y: 0.1 } }
  const farTarget = { id: 'farTarget', name: 'Far target', type: 'standup', x: 0.8, y: 0.6, trim: 'all' }
  const shots = new Map([['rampLeftFeed', rampLeftFeed], ['farTarget', farTarget]])
  const dist = Math.hypot(0.36 - LEFT_ANCHOR_UV.x, 0.1 - LEFT_ANCHOR_UV.y)
  assert(dist < FLIPPER_SNAP, `fixture sanity: expected the feed to be within FLIPPER_SNAP of the left anchor, got ${dist}`)
  const g = goal('g-snap-direct', 'combo', ['rampLeftFeed', 'farTarget'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const feedView = map(0.36, 0.1)
  const targetView = map(0.8, 0.6)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the feed->farTarget run')
  assert(stroke.points.length === 23, `expected a single DIRECT leg (23 points, no waypoint detour), got ${stroke.points.length}`)
  close(stroke.points[0].x, feedView.x, 1e-6, 'run seed x (the feed point)')
  close(stroke.points[0].y, feedView.y, 1e-6, 'run seed y (the feed point)')
  return `feed (0.36,0.10) is within FLIPPER_SNAP of its own left anchor -> single 23-point direct leg from the feed straight to the target, no viaWaypoint detour`
})

await test('a ramp feed on one side routes the NEXT shot via the OPPOSITE-side anchor when it is not close enough to snap', () => {
  const farTarget = { id: 'farTarget2', name: 'Far target 2', type: 'standup', x: 0.85, y: 0.65, trim: 'all' }
  const shots = new Map([...shotsByID, ['farTarget2', farTarget]])
  // 'ramp' feeds to (0.64,0.10) (right-ish); farTarget2.x=0.85>0.55 -> chooseFlipper picks 'left' (opposite side).
  const g = goal('g-opposite-anchor', 'combo', ['ramp', 'farTarget2'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const feedView = map(0.64, 0.1)
  const targetView = map(0.85, 0.65)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the feed->farTarget2 run')
  assert(stroke.points.length === 45, `expected a viaWaypoint run (45 points, not a snap), got ${stroke.points.length}`)
  close(stroke.points[0].x, feedView.x, 1e-6, 'run origin is the (right-ish) feed point')
  const d = closestDist(stroke.points, leftAnchorView)
  assert(d <= 1e-6, `expected the corner on the OPPOSITE (left) anchor, closest was ${d}`)
  return `feed near the right side (0.64,0.10) routes the next (opposite-side, x=0.85) shot via the LEFT anchor — a genuine cross-playfield return`
})

await test("'any' launch anchors at the cross flipper of step 0's target", () => {
  const gLeft = goal('g-launch-left-target', 'combo', ['leftTarget']) // x=0.3<0.45 -> 'right'
  const { calls: callsLeft } = draw(gLeft, 'any')
  const arcLeft = callsLeft.find((c) => c.method === 'arc')
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  close(arcLeft.args[0], rightAnchorView.x, 1e-6, 'launch dot x for a left-side step-0 target')
  close(arcLeft.args[1], rightAnchorView.y, 1e-6, 'launch dot y for a left-side step-0 target')

  const gRight = goal('g-launch-right-target', 'combo', ['rightTarget']) // x=0.7>0.55 -> 'left'
  const { calls: callsRight } = draw(gRight, 'any')
  const arcRight = callsRight.find((c) => c.method === 'arc')
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  close(arcRight.args[0], leftAnchorView.x, 1e-6, 'launch dot x for a right-side step-0 target')
  close(arcRight.args[1], leftAnchorView.y, 1e-6, 'launch dot y for a right-side step-0 target')

  return `'any' launch anchors at the RIGHT anchor for a left-side step-0 target, and the LEFT anchor for a right-side one — the cross-flipper heuristic (tie-break origin = DEFAULT_LAUNCH_UV=(0.5,0.03))`
})

await test('an explicit ballPosition is NEVER overridden by rule 6, even when the heuristic would pick a different anchor', () => {
  // leftTarget (x=0.3<0.45): the 'any' heuristic (previous test) picks
  // 'right' -> (0.60,0.04). An explicit ballPosition:'leftFlipper' must
  // still land at (0.40,0.04) regardless.
  const g = goal('g-explicit-not-overridden', 'combo', ['leftTarget'])
  const { calls } = draw(g, 'leftFlipper')
  const arc = calls.find((c) => c.method === 'arc')
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  close(arc.args[0], leftAnchorView.x, 1e-6, 'launch dot x (explicit leftFlipper)')
  close(arc.args[1], leftAnchorView.y, 1e-6, 'launch dot y (explicit leftFlipper)')
  assert(Math.abs(arc.args[0] - rightAnchorView.x) > 1e-3, 'must NOT land at the heuristic-chosen right anchor')
  return `explicit ballPosition:'leftFlipper' anchors at (0.40,0.04) even though the 'any' heuristic for this same target would have picked the right anchor (0.60,0.04)`
})

// Feature 1 extension (2026-08-11, rolo — screenshot evidence: Jaws' harpoon
// lane is made from the MID-RIGHT MINI FLIPPER, not the main right flipper
// the cross-side heuristic assumed): Shot.flipper/GoalStep.flipper may now
// name a flipper-typed SHOT ID instead of 'left'/'right' — resolveShootingAnchor
// resolves it to that shot's own (x,y) outright, before any geometric
// heuristic runs.

await test("a step whose flipper NAMES A FLIPPER-TYPED SHOT ID anchors at THAT shot's own (x,y), not FLIPPER_ANCHORS", () => {
  const miniFlipper = { id: 'mini-flip', name: 'Mini Flipper', type: 'flipper', x: 0.78, y: 0.3, trim: 'all', bat: { side: 'right', size: 'mini' } }
  // target.x=0.09<0.45 -> the OLD cross-side heuristic would pick 'right' ->
  // FLIPPER_ANCHORS.right (0.60,0.04); the shot is really made from the
  // mini flipper instead.
  const farLeftTarget = { id: 'far-left-target', name: 'Far Left Target', type: 'lane', x: 0.09, y: 0.48, trim: 'all', flipper: 'mini-flip' }
  const origin = { id: 'origin2', name: 'Origin 2', type: 'standup', x: 0.5, y: 0.3, trim: 'all' }
  const shots = new Map([['mini-flip', miniFlipper], ['far-left-target', farLeftTarget], ['origin2', origin]])
  const g = goal('g-named-flipper-shot', 'combo', ['origin2', 'far-left-target'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.09, 0.48)
  const miniView = map(0.78, 0.3)
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin2->far-left-target stroke run')
  const dMini = closestDist(stroke.points, miniView)
  const dRight = closestDist(stroke.points, rightAnchorView)
  assert(dMini <= 1e-6, `expected the corner exactly on the named mini-flipper shot (${miniView.x},${miniView.y}), closest was ${dMini}`)
  assert(dRight > 5, `expected the route to stay clear of the main RIGHT anchor the old cross-side heuristic would have picked, got ${dRight.toFixed(1)}px`)
  return `flipper:'mini-flip' anchors the route at the named shot's own coords (${miniView.x},${miniView.y}) instead of the heuristic-picked main RIGHT anchor (${rightAnchorView.x},${rightAnchorView.y})`
})

await test("REAL Jaws data: harpoon-lane (flipper:'mini-flipper') anchors at the mini flipper's own (0.78,0.30) — the shot that actually makes it", () => {
  const miniFlipper = { id: 'mini-flipper', name: 'Mid-Right Mini Flipper', type: 'flipper', x: 0.78, y: 0.3, trim: 'all', bat: { side: 'right', size: 'mini' } }
  const harpoonLane = { id: 'harpoon-lane', name: 'Harpoon Lane', type: 'lane', x: 0.09, y: 0.48, trim: 'all', flipper: 'mini-flipper' }
  const origin = { id: 'jaws-origin', name: 'Jaws origin', type: 'standup', x: 0.5, y: 0.3, trim: 'all' }
  const shots = new Map([['mini-flipper', miniFlipper], ['harpoon-lane', harpoonLane], ['jaws-origin', origin]])
  const g = goal('g-jaws-harpoon', 'combo', ['jaws-origin', 'harpoon-lane'])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.09, 0.48)
  const miniView = map(0.78, 0.3)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the origin->harpoon-lane stroke run')
  const dMini = closestDist(stroke.points, miniView)
  assert(dMini <= 1e-6, `expected the corner exactly on the mini flipper (${miniView.x},${miniView.y}), closest was ${dMini}`)
  return `real Jaws shape: harpoon-lane's flipper:'mini-flipper' anchors at (${miniView.x},${miniView.y}) — the shot that actually makes it`
})

await test('step.flipper naming a shot id beats shot.flipper naming a DIFFERENT shot id — precedence unchanged from the left/right case', () => {
  const flipperA = { id: 'flip-a', name: 'Flipper A', type: 'flipper', x: 0.2, y: 0.3, trim: 'all' }
  const flipperB = { id: 'flip-b', name: 'Flipper B', type: 'flipper', x: 0.85, y: 0.55, trim: 'all' }
  const target = { id: 'named-target', name: 'Named target', type: 'standup', x: 0.5, y: 0.5, trim: 'all', flipper: 'flip-a' }
  const origin = { id: 'named-origin', name: 'Named origin', type: 'standup', x: 0.5, y: 0.3, trim: 'all' }
  const shots = new Map([['flip-a', flipperA], ['flip-b', flipperB], ['named-target', target], ['named-origin', origin]])
  const g = goalWithSteps('g-named-precedence', 'combo', [{ shot: 'named-origin' }, { shot: 'named-target', flipper: 'flip-b' }])
  const { runs } = draw(g, 'any', { shotsByID: shots, highlightIndex: 1 })
  const targetView = map(0.5, 0.5)
  const flipBView = map(0.85, 0.55)
  const flipAView = map(0.2, 0.3)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the named-origin->named-target stroke run')
  const dB = closestDist(stroke.points, flipBView)
  const dA = closestDist(stroke.points, flipAView)
  assert(dB <= 1e-6, `expected step.flipper='flip-b' to win over shot.flipper='flip-a', corner should be exactly on flip-b (${flipBView.x},${flipBView.y}), closest was ${dB}`)
  assert(dA > 5, `expected the route to stay clear of flip-a (the shot-level value, which should lose), got ${dA.toFixed(1)}px`)
  return `step.flipper='flip-b' (a named shot id) beats shot.flipper='flip-a' — same precedence as the 'left'/'right' case, just with named shots`
})

// ===========================================================================
section('k. D1 regression: fromPlunger is plunge-origin ONLY when the previous plunge resolved NO feed exit')
// ===========================================================================
// Reviewer-confirmed defect: fromPlunger used to be derived purely from the
// PREVIOUS step's shot type ("was it a plunge?"), ignoring whether that step
// itself resolved a feed exit (rule 7(2)). goal [plunge(feeds), A, B]: step 0
// is a plunge shot whose `feeds` resolves, so segment 2 (step0 -> A) already
// originates at the FEED point (rule 7(2), covered by section b/i above) —
// but the old code still routed that segment through laneRoute (because
// stepShotTypes[0]==='plunge'), clamping its origin x back into
// [0.93,0.98] and drawing a 3-leg (67-point) lane loop out to the shooter
// lane and back to the target instead of a plain rule-6 route from the feed
// point. 18 goals across addams_family/beetlejuice/pulp_fiction/tmnt/
// transformers reproduced this (e.g. addams_family's skillshot-soft-plunge).
// The fix: fromPlunger = exitsUV[index-1]==null && prevShot.type==='plunge'.

await test("goal [plungeFeed(feeds), A, B]: segment 2 (plungeFeed->A) originates at the feed point and is a plain rule-6 route, NOT a lane route", () => {
  const plungeFeed = { id: 'plungeFeed', name: 'Plunge w/ feed', type: 'plunge', x: 0.96, y: 0.3, trim: 'all', feeds: { x: 0.64, y: 0.1 } }
  const shotA = { id: 'd1-shotA', name: 'D1 Shot A', type: 'standup', x: 0.75, y: 0.6, trim: 'all' }
  const shotB = { id: 'd1-shotB', name: 'D1 Shot B', type: 'standup', x: 0.3, y: 0.5, trim: 'all' }
  const shots = new Map([['plungeFeed', plungeFeed], ['d1-shotA', shotA], ['d1-shotB', shotB]])
  // 2026-08-11 (phase A10 interaction): category is 'combo', not the
  // original 'skillshot' — phase A10 ("skillshot = target-only rendering")
  // now suppresses every step's connector leg by default for that category,
  // which would swallow this test's actual point (a REAL drawn rule-6 leg
  // for segment 2) behind an unrelated suppression. D1's origin-resolution
  // fix is generic routing math, not skillshot-specific.
  const g = goal('g-d1-regression', 'combo', ['plungeFeed', 'd1-shotA', 'd1-shotB'])
  // segment 2 (index 1, plungeFeed->A) needs to be the ACTIVE step for its
  // leg to draw at all (phase A12 item 5).
  const { runs } = draw(g, 'plunger', { shotsByID: shots, highlightIndex: 1 })
  const feedView = map(0.64, 0.1)
  const targetAView = map(0.75, 0.6)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y) // chooseFlipper(A.x=0.75>0.55) -> 'left'

  const seg2 = runsEndingAt(runs, targetAView).find((r) => r.points.length > 3)
  assert(seg2, 'expected segment 2 (plungeFeed -> A) to draw a stroke run ending at A')
  assert(seg2.points.length !== 67, `expected NOT a 3-leg (67-point) lane loop — the D1 bug's exact signature — got ${seg2.points.length} points`)
  assert(seg2.points.length === 45, `expected a plain rule-6 viaWaypoint run (45 points: origin->flipper-anchor->target), got ${seg2.points.length}`)
  close(seg2.points[0].x, feedView.x, 1e-6, "segment 2's origin x must be the feed point, not the lane")
  close(seg2.points[0].y, feedView.y, 1e-6, "segment 2's origin y must be the feed point, not the lane")
  const cornerDist = closestDist(seg2.points, leftAnchorView)
  assert(cornerDist <= 1e-6, `expected the rule-6 corner exactly on the LEFT anchor (${leftAnchorView.x},${leftAnchorView.y}), not a lane-route arch junction`)
  const laneBandMinX = map(0.93, 0).x
  const laneBandMaxX = map(0.98, 0).x
  const inLaneBand = seg2.points.filter((p) => p.x >= laneBandMinX && p.x <= laneBandMaxX)
  assert(inLaneBand.length === 0, `expected NO point of segment 2 inside the shooter-lane x-band [0.93,0.98] (view x [${laneBandMinX},${laneBandMaxX}]), found ${inLaneBand.length}`)

  return `segment 2 is a plain 45-point rule-6 route from the feed point (${feedView.x},${feedView.y}) via the LEFT anchor to A — not the 67-point lane loop the D1 bug produced, and no point sits in the lane's x-band`
})

// ===========================================================================
section('l. orbit/loop continuation arcs (phase A5, 2026-08-11): arch controls for cross-table feeds; ramps and short-hop orbits stay straight')
// ===========================================================================
// CONTRACTS-PLAYFIELDS.md rule 5: the two elevated legs (entrance->apex->
// feed) arch — control y = apex.y+0.06, clamped to 0.99 — ONLY when BOTH
// shot.type is 'orbit'/'loop' AND |feed.x-entrance.x| > 0.3. Every other
// case (ramps regardless of distance; a short-hop orbit/loop) keeps the
// plain chord-midpoint control (bowControl) sections a/g etc. already cover.

/** Same quadratic-Bézier sample formula as drawing.ts's sampleQuadInto,
 *  reimplemented locally (not imported — this module stays a black box, see
 *  the file header) so this section can predict an EXACT interior sample
 *  from the spec's own control-point formula, not just detect "some"
 *  deviation. */
function quadAt(a, c, b, t) {
  const mt = 1 - t
  return { x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y }
}
function synthApexUV(e, f) {
  return { x: e.x + 0.25 * (f.x - e.x), y: Math.min(0.95, Math.max(e.y + 0.22, f.y + 0.02)) }
}
function archControlUV(a, apex) {
  return { x: (a.x + apex.x) / 2, y: Math.min(0.99, apex.y + 0.06) }
}
function chordMidUV(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

// FLATTEN_SAMPLES=22 per leg, 1 shared entrance seed: rampPart.points[0] is
// the entrance, [1..22] leg1's t=1/22..22/22 samples ([11]=t=0.5, [22]=apex
// exactly), [23..44] leg2's samples ([33]=t=0.5, [44]=feed exactly) — same
// indexing section a's "45 points" assertion already established.
const LEG1_MID_IDX = 11
const LEG2_MID_IDX = 33

await test("orbit, cross-table feed (|Δx|=0.50>0.3): BOTH elevated legs arch — exact midpoint sample matches the spec formula, and deviates >2px from the plain chord", () => {
  const e = { x: 0.75, y: 0.45 }
  const f = { x: 0.25, y: 0.1 }
  const s = { id: 's-orbit-far', name: 'Far orbit', type: 'orbit', x: e.x, y: e.y, trim: 'all', feeds: { x: f.x, y: f.y } }
  const shots = new Map([['s-orbit-far', s]])
  const g = goal('g-orbit-arch', 'combo', ['s-orbit-far'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(f.x, f.y)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated entrance->apex->feed run')
  assert(rampPart.points.length === 45, `expected the ordinary 2-leg elevated run (45 points), got ${rampPart.points.length}`)

  const apex = synthApexUV(e, f)
  const leg1Control = archControlUV(e, apex)
  const leg2Control = archControlUV(apex, f) // same formula, re-centered between apex and f per the spec
  const eView = map(e.x, e.y)
  const apexView = map(apex.x, apex.y)
  const leg1ControlView = map(leg1Control.x, leg1Control.y)
  const leg2ControlView = map((apex.x + f.x) / 2, Math.min(0.99, apex.y + 0.06))

  const expectedLeg1Mid = quadAt(eView, leg1ControlView, apexView, 0.5)
  const expectedLeg2Mid = quadAt(apexView, leg2ControlView, feedView, 0.5)
  const actualLeg1Mid = rampPart.points[LEG1_MID_IDX]
  const actualLeg2Mid = rampPart.points[LEG2_MID_IDX]
  close(actualLeg1Mid.x, expectedLeg1Mid.x, 1e-6, 'leg1 midpoint x matches the arch formula exactly')
  close(actualLeg1Mid.y, expectedLeg1Mid.y, 1e-6, 'leg1 midpoint y matches the arch formula exactly')
  close(actualLeg2Mid.x, expectedLeg2Mid.x, 1e-6, 'leg2 midpoint x matches the arch formula exactly')
  close(actualLeg2Mid.y, expectedLeg2Mid.y, 1e-6, 'leg2 midpoint y matches the arch formula exactly')

  const chord1Mid = map((e.x + apex.x) / 2, (e.y + apex.y) / 2)
  const chord2Mid = map((apex.x + f.x) / 2, (apex.y + f.y) / 2)
  const dev1 = Math.hypot(actualLeg1Mid.x - chord1Mid.x, actualLeg1Mid.y - chord1Mid.y)
  const dev2 = Math.hypot(actualLeg2Mid.x - chord2Mid.x, actualLeg2Mid.y - chord2Mid.y)
  assert(dev1 > 2, `expected leg1's midpoint sample to deviate >2px from the plain chord midpoint, got ${dev1.toFixed(2)}px`)
  assert(dev2 > 2, `expected leg2's midpoint sample to deviate >2px from the plain chord midpoint, got ${dev2.toFixed(2)}px`)
  return `orbit, |Δx|=0.50>0.3: leg1 deviates ${dev1.toFixed(1)}px and leg2 ${dev2.toFixed(1)}px from their plain chords, both landing exactly on the arch formula's own midpoint sample`
})

await test("loop, cross-table feed (|Δx|=0.50>0.3): arches exactly like orbit — 'loop' is not special-cased separately from 'orbit'", () => {
  const e = { x: 0.28, y: 0.4 }
  const f = { x: 0.78, y: 0.12 }
  const s = { id: 's-loop-far', name: 'Far loop', type: 'loop', x: e.x, y: e.y, trim: 'all', feeds: { x: f.x, y: f.y } }
  const shots = new Map([['s-loop-far', s]])
  const g = goal('g-loop-arch', 'combo', ['s-loop-far'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(f.x, f.y)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated entrance->apex->feed run')

  const apex = synthApexUV(e, f)
  const leg1ControlView = map((e.x + apex.x) / 2, Math.min(0.99, apex.y + 0.06))
  const eView = map(e.x, e.y)
  const apexView = map(apex.x, apex.y)
  const expectedLeg1Mid = quadAt(eView, leg1ControlView, apexView, 0.5)
  const actualLeg1Mid = rampPart.points[LEG1_MID_IDX]
  close(actualLeg1Mid.x, expectedLeg1Mid.x, 1e-6, "loop leg1 midpoint x matches the arch formula (type:'loop' arches, same as 'orbit')")
  close(actualLeg1Mid.y, expectedLeg1Mid.y, 1e-6, "loop leg1 midpoint y matches the arch formula")
  const chord1Mid = map((e.x + apex.x) / 2, (e.y + apex.y) / 2)
  const dev1 = Math.hypot(actualLeg1Mid.x - chord1Mid.x, actualLeg1Mid.y - chord1Mid.y)
  assert(dev1 > 2, `expected loop leg1's midpoint to deviate >2px from the plain chord, got ${dev1.toFixed(2)}px`)
  return `loop, |Δx|=0.50>0.3: leg1 deviates ${dev1.toFixed(1)}px from its plain chord — 'loop' gets the same arch treatment as 'orbit'`
})

await test('short-hop orbit (|Δx|=0.20, under the 0.3 threshold): stays STRAIGHT — midpoint sample lands exactly on the plain chord', () => {
  const e = { x: 0.7, y: 0.5 }
  const f = { x: 0.5, y: 0.1 } // |f.x - e.x| = 0.2 <= 0.3
  const s = { id: 's-orbit-short', name: 'Short orbit', type: 'orbit', x: e.x, y: e.y, trim: 'all', feeds: { x: f.x, y: f.y } }
  const shots = new Map([['s-orbit-short', s]])
  const g = goal('g-orbit-short', 'combo', ['s-orbit-short'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(f.x, f.y)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated entrance->apex->feed run')

  const apex = synthApexUV(e, f)
  const chord1Mid = map((e.x + apex.x) / 2, (e.y + apex.y) / 2)
  const actualLeg1Mid = rampPart.points[LEG1_MID_IDX]
  const dev1 = Math.hypot(actualLeg1Mid.x - chord1Mid.x, actualLeg1Mid.y - chord1Mid.y)
  assert(dev1 <= 1e-6, `expected a short-hop orbit (|Δx|=0.2<=0.3) to stay perfectly straight (0px chord deviation), got ${dev1.toFixed(4)}px`)
  return `short-hop orbit (|Δx|=0.2, under the 0.3 threshold): leg1's midpoint lands exactly on the plain chord (${dev1.toExponential(2)}px deviation) — no arch`
})

await test('ramp with the SAME large cross-table feed (|Δx|=0.50>0.3): stays STRAIGHT — the arch gate is type-specific (orbit/loop only), not merely distance-based', () => {
  const e = { x: 0.75, y: 0.45 }
  const f = { x: 0.25, y: 0.1 } // identical geometry to the orbit-arch fixture above
  const s = { id: 's-ramp-far', name: 'Far ramp', type: 'ramp', x: e.x, y: e.y, trim: 'all', feeds: { x: f.x, y: f.y } }
  const shots = new Map([['s-ramp-far', s]])
  const g = goal('g-ramp-far-straight', 'combo', ['s-ramp-far'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(f.x, f.y)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated entrance->apex->feed run')

  const apex = synthApexUV(e, f)
  const chord1Mid = map((e.x + apex.x) / 2, (e.y + apex.y) / 2)
  const chord2Mid = map((apex.x + f.x) / 2, (apex.y + f.y) / 2)
  const actualLeg1Mid = rampPart.points[LEG1_MID_IDX]
  const actualLeg2Mid = rampPart.points[LEG2_MID_IDX]
  const dev1 = Math.hypot(actualLeg1Mid.x - chord1Mid.x, actualLeg1Mid.y - chord1Mid.y)
  const dev2 = Math.hypot(actualLeg2Mid.x - chord2Mid.x, actualLeg2Mid.y - chord2Mid.y)
  assert(dev1 <= 1e-6, `expected a ramp (type-gated out of the arch, even with |Δx|=0.5>0.3) to stay straight on leg1, got ${dev1.toFixed(4)}px deviation`)
  assert(dev2 <= 1e-6, `expected a ramp to stay straight on leg2 too, got ${dev2.toFixed(4)}px deviation`)
  return `ramp, |Δx|=0.50>0.3 (same distance that arched the orbit fixture above): both legs stay exactly on their plain chords — the 2026-08-11 arch rule is gated on shot.type, not on feed distance alone`
})

// ===========================================================================
section('m. loop-coil continuation (Feature 4 / phase A9, 2026-08-11): models.ts FeedRef.loop')
// ===========================================================================
// A resolved feed can carry a `loop` waypoint — "on the way to the feed
// point the ball physically WRAPS this element" (Jaws' shooter-lane plunge
// coiling around the fishing-reel spinner before dropping at the mini
// flipper is the reference case, data/jaws_goals.json). Uses a synthetic,
// non-skillshot ('combo') fixture rather than the real Jaws goal: Feature 5
// (phase A10, "skillshot = target-only rendering") suppresses EVERY
// connector leg — including a loop coil — by default for `category:
// 'skillshot'`, and 'skillshot-level-3' (the goal that actually uses
// shooter-lane in the shipped data) never opts back in with
// `link:'route'`, so the coil geometry itself is never drawn there — see
// plunger-route.test.mjs section x. This is the correct, owner-confirmed
// behavior ("for Jaws that means the reel coil currently shows nowhere
// until a non-skillshot goal uses shooter-lane"), and it means a coil can
// only be observed on the canvas through a non-skillshot fixture.

const loopEntrance = { id: 'loop-entrance', name: 'Loop Entrance', type: 'ramp', x: 0.55, y: 0.3, trim: 'all', feeds: { shot: 'loop-feed-target', loop: { shot: 'loop-waypoint' } } }
const loopFeedTarget = { id: 'loop-feed-target', name: 'Loop Feed Target', type: 'lane', x: 0.3, y: 0.1, trim: 'all' }
const loopWaypoint = { id: 'loop-waypoint', name: 'Loop Waypoint (spinner)', type: 'spinner', x: 0.45, y: 0.55, trim: 'all' }

await test('loop-authored feed: the continuation winds around the loop center MORE than one full turn (2π) — a real coil, not just a curved leg', () => {
  const shots = new Map([
    ['loop-entrance', loopEntrance],
    ['loop-feed-target', loopFeedTarget],
    ['loop-waypoint', loopWaypoint],
  ])
  const g = goal('g-loop-coil', 'combo', ['loop-entrance'])
  const { runs } = draw(g, 'any', { shotsByID: shots })
  const feedView = map(loopFeedTarget.x, loopFeedTarget.y)
  const centerView = map(loopWaypoint.x, loopWaypoint.y)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated entrance->coil->feed run ending at the feed point')
  assert(rampPart.points.length > 45, `expected MORE points than the plain 2-leg apex shape (45) — a coil is many short legs, got ${rampPart.points.length}`)
  // Measure winding over the COIL SWEEP ONLY — drawing.ts's own
  // FLATTEN_SAMPLES (22 samples/leg, already an established constant this
  // whole suite hardcodes elsewhere: e.g. section l's LEG1_MID_IDX/
  // LEG2_MID_IDX above). rampPart.points[0] is the shared entrance seed;
  // [1..22] is the entrance->coil-start bookend leg; [23..374] is the coil
  // sweep itself (16 sub-legs); [375..396] is the coil-end->feed bookend
  // leg. The two BOOKEND legs are excluded on purpose: they are ordinary
  // straight connectors (same as every other leg in this file) whose
  // direction depends entirely on where the entrance/feed points happen to
  // sit relative to the coil, NOT on the coil's own sweep — a feed point
  // that happens to sit angularly "behind" where the coil ends can visibly
  // swing the exit leg backward relative to the coil's accumulated
  // rotation (verified against the real bundled code with this exact
  // fixture before writing this comment: measuring the WHOLE run's winding
  // gave only ~0.94 turns here, even though the coil itself sweeps its full
  // 1.25). That is a property of the straight exit connector, not evidence
  // the coil failed to wrap — the coil vertices themselves objectively
  // sweep past a full turn regardless of what a subsequent straight leg
  // does, which is the thing this feature actually promises ("a visible
  // COIL around the loop point").
  const FLATTEN_SAMPLES = 22
  const coilOnly = rampPart.points.slice(FLATTEN_SAMPLES, rampPart.points.length - FLATTEN_SAMPLES)
  assert(coilOnly.length > 2, `sanity: expected a real coil-only sub-range, got ${coilOnly.length} points`)
  let winding = 0
  let prevAngle = Math.atan2(coilOnly[0].y - centerView.y, coilOnly[0].x - centerView.x)
  for (let i = 1; i < coilOnly.length; i++) {
    const angle = Math.atan2(coilOnly[i].y - centerView.y, coilOnly[i].x - centerView.x)
    let delta = angle - prevAngle
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI
    winding += delta
    prevAngle = angle
  }
  assert(
    Math.abs(winding) > 2 * Math.PI,
    `expected the coil sweep's total winding around the loop center to exceed 2π (1 full turn), got ${Math.abs(winding).toFixed(3)} rad (${(Math.abs(winding) / (2 * Math.PI)).toFixed(2)} turns)`,
  )
  return `loop-authored continuation: ${rampPart.points.length} points total; the coil sweep alone (excluding the two straight bookend legs) winds ${(Math.abs(winding) / (2 * Math.PI)).toFixed(2)} turns around the loop center (${centerView.x.toFixed(1)},${centerView.y.toFixed(1)}) — exceeds 1 full turn (2π)`
})

await test('loop-less and unresolvable-loop feeds stay on the classic 2-leg apex path — Feature 4 fail-soft: absent/unresolvable loop = no coil, byte-identical to before this phase', () => {
  const noLoop = { id: 'no-loop-ramp', name: 'No-loop ramp', type: 'ramp', x: 0.55, y: 0.3, trim: 'all', feeds: { x: 0.2, y: 0.6 } }
  const badLoop = {
    id: 'bad-loop-ramp',
    name: 'Bad-loop ramp',
    type: 'ramp',
    x: 0.55,
    y: 0.3,
    trim: 'all',
    feeds: { x: 0.2, y: 0.6, loop: { shot: 'does-not-exist' } },
  }
  const shots = new Map([
    ['no-loop-ramp', noLoop],
    ['bad-loop-ramp', badLoop],
  ])
  const feedView = map(0.2, 0.6)
  const apexView = map(0.4625, 0.62) // same synthesis formula as section g's identical entrance/feed fixture

  for (const [label, id] of [
    ['no loop field at all', 'no-loop-ramp'],
    ['authored but UNRESOLVABLE loop.shot', 'bad-loop-ramp'],
  ]) {
    const g = goal(`g-${id}`, 'combo', [id])
    const { runs } = draw(g, 'any', { shotsByID: shots })
    const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
    assert(rampPart, `expected the elevated tail run for ${label}`)
    assert(rampPart.points.length === 45, `expected the classic 2-leg apex run (45 points) for ${label}, got ${rampPart.points.length}`)
    const d = closestDist(rampPart.points, apexView)
    assert(d <= 1e-6, `expected the polyline to pass exactly through the synthesized apex for ${label}, closest was ${d}`)
  }
  return 'both a loop-less feed and a feed with an unresolvable loop.shot render the identical byte-for-byte classic 45-point apex-based continuation — Feature 4 is pure fail-soft addition'
})

// ---------------------------------------------------------------------------
await rm(tmp, { recursive: true, force: true })
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
