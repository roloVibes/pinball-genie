#!/usr/bin/env node
// app/tests/deck-route.test.mjs — SUITE 16: deck/PlayfieldZone routing
// (phase A4, 2026-08-10, dataset schema v5 — models.ts's PlayfieldZone/
// Shot.playfield/Shot.bat doc comments).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/deck-route.test.mjs"
// or from app/:
//   node tests/deck-route.test.mjs
//
// WHAT THIS SUITE COVERS. A raised/sunken playfield (PlayfieldZone) can carry
// its own flipper bat(s) — a shot with `type:'flipper'` and `Shot.playfield`
// naming the zone. Before this phase, ./overlay/shotgeom.ts's
// resolveShootingAnchor was a documented-forward-looking wrapper that always
// anchored at a MAIN flipper (FLIPPER_ANCHORS), even for a shot that lives on
// a deck with its own bat right next to it — routing a goal step "through"
// the main flippers for a shot the ball never actually returns to there. This
// phase makes resolveShootingAnchor deck-aware (shotgeom.ts), threads it
// through ./overlay/drawing.ts's routing (routeSegment's anchor + a new
// same-playfield guard on the both-upper direct exception + the launch-anchor
// block), and adds the matching background art in ./overlay/map2d.ts's
// drawPlayfieldArt (raised plate / sunken inset window + deck bats, excluded
// from the pre-existing name-regex upper/mini-bat detection).
//
//   a. mid-goal deck routing: a step targeting a zone shot routes via that
//      zone's own bat (waypoint === bat (x,y), not FLIPPER_ANCHORS) — and the
//      PRECEDING step's rule-7 elevated legs + landing marker (the "climb"
//      onto the deck) still draw, unmodified by this phase.
//   b. a lower (sunken) zone: routing never anchors at a main flipper: the
//      art draws its inset window with a dashed [4,4] outline.
//   c. the same-playfield guard on the both-upper direct exception: a
//      main-playfield shot -> a deck shot on the SAME two-upper-half/close
//      geometry that would have gone direct pre-guard does NOT go direct;
//      two shots on the SAME deck (same `.playfield`) still CAN.
//   d. a goal STARTING on a deck shot launches from that deck's own bat —
//      never the plunger, never a main flipper — including for a
//      skillshot-category goal whose step-0 y >= 0.15, where the pre-A4
//      heuristic would have forced a plunger launch.
//   e. fail-soft: a zone with NO bat renders IDENTICAL route geometry to a
//      no-`playfields` render of the same machine (byte-for-byte `calls`
//      comparison, not just "close").
//   f. THE BYTE-IDENTITY GATE: every goal in the real, shipped
//      data/jaws_goals.json (which has no `playfields` key at all today)
//      renders byte-for-byte IDENTICAL with `opts.playfields` omitted vs an
//      explicit empty array — proving the ~139 zone-less machines this ships
//      alongside are completely unaffected by this phase.
//   g. art: an upper zone's raised plate draws within its mapped bounds; a
//      premium-le-only zone's plate is absent under trim 'pro'
//      (shotgeom.ts's isZoneVisible); a deck bat draws exactly once (the
//      name-regex extras loop is excluded for any shot naming a `playfield`,
//      so nothing double-paints).
//
// FIXTURES ARE SYNTHETIC. Dataset schema v5's PlayfieldZone/Shot.playfield/
// Shot.bat (models.ts) landed the same day as this phase, ahead of the real
// data-authoring pass — as of this writing neither data/halloween_goals.json
// nor data/evil_dead_goals.json (checked directly) has a `playfields` key,
// and no shipped machine does (verified in section f: real data/
// jaws_goals.json has none either). Sections a-e below build hand-rolled
// GameData fixtures rather than reading a real file — the same approach
// app/tests/card.test.mjs's header note documents for MachineCard/Drill.
// Once the flagship data pass authors real halloween/evil_dead playfields
// (owner review pending as of this writing), those sections should switch to
// reading the real files directly instead — this comment is the marker for
// that follow-up.
//
// Pattern: identical to ramp-route.test.mjs (routing, sections a-f) plus
// playfield-art.test.mjs (art, section g) — esbuild bundles the REAL .ts
// sources (never edited, never copied) behind a tiny re-export entry point,
// dynamically imported and exercised against recording 2D-context stubs.
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const srcDir = resolve(appDir, 'src')
const dataDir = resolve(appDir, '../data')

// ---------------------------------------------------------------------------
// Harness (identical shape to every other suite here)
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

// ---------------------------------------------------------------------------
// Bundle the real modules — drawing.ts (routing, sections a-f), map2d.ts's
// drawPlayfieldArt + Feature 2's exported LEVEL-view helpers, now
// generalized beyond `kind:'lower'` (art, sections g-h — machineZones/
// resolveMapLevel/LEVEL_SEGMENTED_MAX are the generalization's own new
// exports), and shotgeom.ts's isZoneVisible. map2d.ts imports
// './map2d.css', so give esbuild an empty loader for CSS (playfield-
// art.test.mjs's technique).
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-deck-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  [
    `export * as drawing from ${JSON.stringify(resolve(srcDir, 'overlay/drawing'))}`,
    `export { drawPlayfieldArt, machineHasLowerZone, machineZones, resolveMapLevel, LEVEL_SEGMENTED_MAX, zoneLocalMap, drawZoneFloor, drawZoneEdgeMarkers, drawZoneGoalRoute } from ${JSON.stringify(resolve(srcDir, 'overlay/map2d'))}`,
    `export { isZoneVisible } from ${JSON.stringify(resolve(srcDir, 'overlay/shotgeom'))}`,
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
  drawPlayfieldArt,
  isZoneVisible,
  machineHasLowerZone,
  machineZones,
  resolveMapLevel,
  LEVEL_SEGMENTED_MAX,
  zoneLocalMap,
  drawZoneFloor,
  drawZoneEdgeMarkers,
  drawZoneGoalRoute,
} = await import(pathToFileURL(outfile).href)

// ---------------------------------------------------------------------------
// Synthetic machine + MapFn — same plain rect + v-flip convention as
// ramp-route.test.mjs, v=0 at the bottom (flipper edge).
// ---------------------------------------------------------------------------
const W = 450
const H = 900
const map = (u, v) => ({ x: u * W, y: H - v * H })

// FLIPPER_ANCHORS / FLIPPER_SNAP / DEFAULT_LAUNCH_UV, mirrored from
// models.ts/shotgeom.ts for prediction purposes only (ramp-route.test.mjs's
// own convention — the REAL bundled drawing.ts is what's actually exercised).
const LEFT_ANCHOR_UV = { x: 0.4, y: 0.04 }
const RIGHT_ANCHOR_UV = { x: 0.6, y: 0.04 }
const FLIPPER_SNAP = 0.08

// ---------------------------------------------------------------------------
// Recording 2D-context stub for the ROUTING sections (a-f) — identical to
// ramp-route.test.mjs's, since these all exercise drawing.ts's
// drawGoalOverlay through the exact same call/inspect shape.
// ---------------------------------------------------------------------------
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
function closestDist(points, target) {
  let best = Infinity
  for (const p of points) best = Math.min(best, Math.hypot(p.x - target.x, p.y - target.y))
  return best
}

function goal(id, category, steps, extra = {}) {
  return { id, title: id, category, summary: '', difficulty: 1, steps: steps.map((shot) => ({ shot, action: `Shoot ${shot}` })), ...extra }
}

function draw(g, ballPosition, opts = {}) {
  const {
    time = 1000,
    map: mapOverride,
    shotsByID: shotsOverride,
    showLabels = false,
    ballTracer = false,
    highlightIndex,
    playfields,
  } = opts
  const { ctx, calls } = recordingCtx()
  const o = {
    shotsByID: shotsOverride,
    goal: g,
    stepIndex: 0,
    ballPosition,
    map: mapOverride ?? map,
    time,
    ballTracer,
    showLabels,
  }
  if (highlightIndex !== undefined) o.highlightIndex = highlightIndex
  if (playfields !== undefined) o.playfields = playfields
  const result = drawing.drawGoalOverlay(ctx, o)
  return { calls, runs: polylineRuns(calls), result }
}

// ---------------------------------------------------------------------------
// SYNTHETIC-HALLOWEEN-LIKE fixture — two non-overlapping upper zones, each
// with one mini deck bat, member shots inside bounds, and an entry scoop on
// the MAIN playfield whose `feeds` lands inside zone 1 (sections a, c, d, g).
// ---------------------------------------------------------------------------
const ATTIC_ZONE = { id: 'z-upper-attic', name: 'Attic', kind: 'upper', bounds: { x: 0.10, y: 0.60, w: 0.30, h: 0.25 } }
const GARAGE_ZONE = { id: 'z-upper-garage', name: 'Garage', kind: 'upper', bounds: { x: 0.60, y: 0.55, w: 0.25, h: 0.20 } }

const atticBat = { id: 'attic-bat', name: 'Attic Bat', type: 'flipper', x: 0.36, y: 0.62, trim: 'all', playfield: 'z-upper-attic', bat: { side: 'right', size: 'mini' } }
const atticTarget = { id: 'attic-target', name: 'Attic Target', type: 'standup', x: 0.15, y: 0.80, trim: 'all', playfield: 'z-upper-attic' }
const atticTargetB = { id: 'attic-target-b', name: 'Attic Target B', type: 'standup', x: 0.20, y: 0.82, trim: 'all', playfield: 'z-upper-attic' }
const garageBat = { id: 'garage-bat', name: 'Garage Bat', type: 'flipper', x: 0.72, y: 0.58, trim: 'all', playfield: 'z-upper-garage', bat: { side: 'left', size: 'mini' } }
const garageTarget = { id: 'garage-target', name: 'Garage Target', type: 'standup', x: 0.75, y: 0.62, trim: 'all', playfield: 'z-upper-garage' }
// Main-playfield shots: the "climb" entry (its `feeds` lands inside the Attic
// zone, at a point distinct from either attic shot, so the segment it seeds
// is non-degenerate and clear of FLIPPER_SNAP around the bat) and a plain
// main shot placed close to attic-target for the same-playfield guard (c).
const entryScoop = { id: 'entry-scoop', name: 'Entry Scoop', type: 'scoop', x: 0.50, y: 0.30, trim: 'all', feeds: { x: 0.12, y: 0.83 } }
const mainUpperShot = { id: 'main-upper-shot', name: 'Main Upper Shot', type: 'standup', x: 0.25, y: 0.78, trim: 'all' }

const HALLOWEEN_SHOTS = new Map(
  [atticBat, atticTarget, atticTargetB, garageBat, garageTarget, entryScoop, mainUpperShot].map((s) => [s.id, s]),
)
const HALLOWEEN_ZONES = [ATTIC_ZONE, GARAGE_ZONE]

// ---------------------------------------------------------------------------
// SYNTHETIC-BASEMENT fixture — a lower (sunken) zone with one bat (section b).
// ---------------------------------------------------------------------------
const CRYPT_ZONE = { id: 'z-lower-crypt', name: 'Crypt', kind: 'lower', bounds: { x: 0.35, y: 0.30, w: 0.30, h: 0.15 } }
const cryptBat = { id: 'crypt-bat', name: 'Crypt Bat', type: 'flipper', x: 0.45, y: 0.33, trim: 'all', playfield: 'z-lower-crypt', bat: { side: 'left' } }
const cryptTarget = { id: 'crypt-target', name: 'Crypt Target', type: 'standup', x: 0.55, y: 0.40, trim: 'all', playfield: 'z-lower-crypt' }
const cryptEntry = { id: 'crypt-entry', name: 'Crypt Entry', type: 'standup', x: 0.20, y: 0.30, trim: 'all' }
const BASEMENT_SHOTS = new Map([cryptBat, cryptTarget, cryptEntry].map((s) => [s.id, s]))
const BASEMENT_ZONES = [CRYPT_ZONE]

// ---------------------------------------------------------------------------
// NO-BAT fixture — a zone with zero declared bats (section e, fail-soft).
// ---------------------------------------------------------------------------
const OBSERVATORY_ZONE = { id: 'z-upper-observatory', name: 'Observatory', kind: 'upper', bounds: { x: 0.10, y: 0.55, w: 0.20, h: 0.15 } }
const obsTarget = { id: 'obs-target', name: 'Observatory Target', type: 'standup', x: 0.18, y: 0.60, trim: 'all', playfield: 'z-upper-observatory' }
const obsEntry = { id: 'obs-entry', name: 'Observatory Entry', type: 'standup', x: 0.70, y: 0.30, trim: 'all' }
const NOBAT_SHOTS = new Map([obsTarget, obsEntry].map((s) => [s.id, s]))
const NOBAT_ZONES = [OBSERVATORY_ZONE]

// ===========================================================================
section('a. mid-goal deck routing: waypoint = zone bat, climb mechanism intact')
// ===========================================================================

await test('goal [entry-scoop, attic-target]: segment 2 routes via the ATTIC bat\'s own (x,y) — not FLIPPER_ANCHORS', () => {
  const g = goal('g-deck-mid', 'combo', ['entry-scoop', 'attic-target'])
  // segment 2 (index 1, attic-target) needs to be ACTIVE for its leg to draw
  // (phase A12 item 5: only the active step's leg draws now).
  const { runs } = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, playfields: HALLOWEEN_ZONES, highlightIndex: 1 })
  const feedView = map(0.12, 0.83)
  const targetView = map(0.15, 0.80)
  const batView = map(atticBat.x, atticBat.y)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)

  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the entry-scoop-feed -> attic-target stroke run')
  assert(stroke.points.length === 45, `expected a 2-leg viaWaypoint run (45 points), got ${stroke.points.length}`)
  close(stroke.points[0].x, feedView.x, 1e-6, "segment origin x must be entry-scoop's feed point")
  close(stroke.points[0].y, feedView.y, 1e-6, "segment origin y must be entry-scoop's feed point")
  const dBat = closestDist(stroke.points, batView)
  assert(dBat <= 1e-6, `expected the waypoint corner exactly on the Attic bat (${batView.x},${batView.y}), closest was ${dBat}`)
  const dLeft = closestDist(stroke.points, leftAnchorView)
  const dRight = closestDist(stroke.points, rightAnchorView)
  assert(dLeft > 5 && dRight > 5, `expected the route to stay clear of the MAIN flipper anchors, got dLeft=${dLeft.toFixed(1)} dRight=${dRight.toFixed(1)}`)
  return `waypoint corner exactly on the Attic bat (${batView.x},${batView.y}); ${Math.min(dLeft, dRight).toFixed(1)}px clear of the nearest main-flipper anchor`
})

await test("the PRECEDING entry-scoop step's rule-7 elevated legs + landing marker still draw (climb mechanism unmodified)", () => {
  const g = goal('g-deck-climb', 'combo', ['entry-scoop', 'attic-target'])
  const { calls, runs } = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, playfields: HALLOWEEN_ZONES })
  const entranceView = map(entryScoop.x, entryScoop.y)
  const feedView = map(0.12, 0.83)
  const rampPart = runsEndingAt(runs, feedView).find((r) => r.points.length > 3)
  assert(rampPart, 'expected the elevated entrance->apex->feed run ending at the feed point')
  assert(rampPart.points.length === 45, `expected the ordinary 2-leg elevated run (45 points), got ${rampPart.points.length}`)
  close(rampPart.points[0].x, entranceView.x, 1e-6, "elevated tail's first point is the entry-scoop entrance ring")
  const ring = calls.find((c) => c.method === 'arc' && Math.abs(c.args[0] - feedView.x) < 1e-6 && Math.abs(c.args[1] - feedView.y) < 1e-6 && Math.abs(c.args[2] - 9) < 1e-6)
  const dot = calls.find((c) => c.method === 'arc' && Math.abs(c.args[0] - feedView.x) < 1e-6 && Math.abs(c.args[1] - feedView.y) < 1e-6 && Math.abs(c.args[2] - 3.5) < 1e-6)
  assert(ring, 'expected the landing marker ring (radius 9) at the feed point')
  assert(dot, 'expected the landing marker dot (radius 3.5) at the feed point')
  return 'elevated tail (45 points) + landing marker (ring r=9 + dot r=3.5) both present at the feed point — climbing onto the deck needed no new mechanism'
})

// ===========================================================================
section('b. a lower (sunken) zone never routes via a main flipper; art draws a dashed outline')
// ===========================================================================

await test('goal [crypt-entry, crypt-target]: the segment anchors at the CRYPT bat, never FLIPPER_ANCHORS.left/right', () => {
  const g = goal('g-basement-route', 'combo', ['crypt-entry', 'crypt-target'])
  // segment 2 (index 1, crypt-target) needs to be ACTIVE for its leg to draw
  // (phase A12 item 5).
  const { runs } = draw(g, 'any', { shotsByID: BASEMENT_SHOTS, playfields: BASEMENT_ZONES, highlightIndex: 1 })
  const targetView = map(cryptTarget.x, cryptTarget.y)
  const batView = map(cryptBat.x, cryptBat.y)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the crypt-entry -> crypt-target stroke run')
  const dBat = closestDist(stroke.points, batView)
  const dLeft = closestDist(stroke.points, leftAnchorView)
  const dRight = closestDist(stroke.points, rightAnchorView)
  assert(dBat <= 1e-6, `expected the corner exactly on the Crypt bat (${batView.x},${batView.y}), closest was ${dBat}`)
  assert(dLeft > 5 && dRight > 5, `expected the route to never come near a MAIN flipper anchor, got dLeft=${dLeft.toFixed(1)} dRight=${dRight.toFixed(1)}`)
  return `basement route corners exactly on the Crypt bat; nearest main-flipper anchor is ${Math.min(dLeft, dRight).toFixed(1)}px away`
})

await test("art: the Crypt (lower) zone draws a dashed [4,4] outline, not the raised plates' solid stroke", () => {
  const lineDashCalls = []
  const artCtx = makeArtCtx(lineDashCalls)
  drawPlayfieldArt(artCtx, map, 0, 1, [], BASEMENT_ZONES)
  const hasDashed = lineDashCalls.some((d) => Array.isArray(d) && d.length === 2 && d[0] === 4 && d[1] === 4)
  assert(hasDashed, `expected setLineDash([4,4]) at some point while drawing the lower zone, recorded dash calls: ${JSON.stringify(lineDashCalls)}`)
  const resetToSolid = lineDashCalls[lineDashCalls.length - 1]
  assert(Array.isArray(resetToSolid) && resetToSolid.length === 0, 'expected the dash pattern reset back to [] after the outline (so later art is not accidentally dashed)')
  return `setLineDash calls recorded: ${JSON.stringify(lineDashCalls)} — [4,4] present and reset to [] afterward`
})

// ===========================================================================
section('c. same-playfield guard on AUTHORED direct (phase A8, 2026-08-11 — reworked: the OLD geometric bothUpper+close trigger this guard used to gate is gone; direct now requires GoalStep.direct:true)')
// ===========================================================================
// 2026-08-11 (phase A8, rolo's route-truth rule): routeSegment's direct
// path used to fire from pure geometry (both shots upper-half, close
// together) — this section's ORIGINAL fixtures exercised that heuristic
// directly, with no `direct` field authored anywhere. Phase A8 kills the
// heuristic outright: direct topology now requires GoalStep.direct===true,
// gated by the SAME same-playfield guard this section was written to prove
// (never draw a straight line through a deck wall — authored or not).
// Reworked in place rather than deleted: every fixture below now AUTHORS
// `direct:true` on its target step, so the guard's own behavior (blocks
// cross-playfield, allows same-playfield) is still exactly what's under
// test — plus a NEW sub-test proving Feature 1's actual default (no
// authored direct -> routes via the deck bat, even for two shots sharing
// one deck) now that the geometric shortcut is gone.

await test("main-playfield shot -> deck shot, AUTHORED direct:true (different .playfield each side): the guard blocks it, routing via the deck bat instead; the SAME authored direct:true is honored WITHOUT zones (same-playfield defaults true)", () => {
  const g = goal('g-guard-blocks', 'combo', ['main-upper-shot', 'attic-target'])
  g.steps[1].direct = true
  // segment 2 (index 1, attic-target) needs to be ACTIVE for its leg to draw
  // on either side of this comparison (phase A12 item 5).
  const withZones = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, playfields: HALLOWEEN_ZONES, highlightIndex: 1 })
  const withoutZones = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, highlightIndex: 1 })
  const targetView = map(atticTarget.x, atticTarget.y)
  const batView = map(atticBat.x, atticBat.y)

  const strokeWith = runsEndingAt(withZones.runs, targetView).find((r) => r.points.length > 3)
  assert(strokeWith, 'expected the WITH-zones stroke run')
  assert(strokeWith.points.length === 45, `expected the guard to override the AUTHORED direct:true and force a 2-leg viaWaypoint route (45 points) WITH zones (different .playfield each side), got ${strokeWith.points.length}`)
  const dBat = closestDist(strokeWith.points, batView)
  assert(dBat <= 1e-6, `expected the WITH-zones corner exactly on the Attic bat, closest was ${dBat}`)

  const strokeWithout = runsEndingAt(withoutZones.runs, targetView).find((r) => r.points.length > 3)
  assert(strokeWithout, 'expected the WITHOUT-zones stroke run')
  assert(strokeWithout.points.length === 23, `expected the SAME authored direct:true to be HONORED (23 points, single chord) with no playfields data — samePlayfield defaults true with no zones authored at all, got ${strokeWithout.points.length}`)

  return `WITHOUT playfields: authored direct:true honored (23 pts). WITH playfields (different .playfield on each side): the same-playfield guard overrides it, routing via the deck bat (${batView.x},${batView.y}) instead (45 pts) — the guard, not the authored flag, is what made the difference`
})

await test('two shots on the SAME deck (same .playfield), AUTHORED direct:true: CAN still go direct', () => {
  const g = goal('g-same-deck-direct', 'combo', ['attic-target', 'attic-target-b'])
  g.steps[1].direct = true
  // segment 2 (index 1) needs to be ACTIVE for its leg to draw (item 5).
  const { runs } = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, playfields: HALLOWEEN_ZONES, highlightIndex: 1 })
  const targetView = map(atticTargetB.x, atticTargetB.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the attic-target -> attic-target-b stroke run')
  assert(stroke.points.length === 23, `expected a single DIRECT leg (23 points) for two same-deck shots with an authored direct:true, got ${stroke.points.length}`)
  return `two shots sharing playfield '${atticTargetB.playfield}' with authored direct:true drew a single 23-point direct leg — the same-playfield guard does not block same-deck routing`
})

await test('two shots on the SAME deck, NO authored direct: Feature 1 default — routes via the DECK BAT, not a direct chord (the old geometric shortcut is gone even for same-deck pairs)', () => {
  const g = goal('g-same-deck-default-anchor', 'combo', ['attic-target', 'attic-target-b'])
  // segment 2 (index 1) needs to be ACTIVE for its leg to draw (item 5).
  const { runs } = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, playfields: HALLOWEEN_ZONES, highlightIndex: 1 })
  const targetView = map(atticTargetB.x, atticTargetB.y)
  const batView = map(atticBat.x, atticBat.y)
  const stroke = runsEndingAt(runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'expected the attic-target -> attic-target-b stroke run')
  assert(stroke.points.length === 45, `expected a 2-leg viaWaypoint route (45 points) via the deck bat BY DEFAULT — two same-deck shots no longer go direct just from geometry, got ${stroke.points.length}`)
  const dBat = closestDist(stroke.points, batView)
  assert(dBat <= 1e-6, `expected the corner exactly on the Attic bat (${batView.x},${batView.y}) even for a same-deck pair, closest was ${dBat}`)
  return `two shots sharing playfield '${atticTargetB.playfield}' with NO authored direct now route via their own deck bat (${batView.x},${batView.y}, 45 pts) by default — "make deck same-playfield legs also anchor via the deck bat unless direct" (Feature 1)`
})

// ===========================================================================
section("d. a goal starting on a deck shot launches from the deck's own bat")
// ===========================================================================

await test('goal [attic-target] (skillshot, step-0 y=0.80 >= 0.15): launches from the Attic bat — not the plunger, not a main flipper (the old y>=0.15 skillshot heuristic loses)', () => {
  const g = goal('g-deck-launch', 'skillshot', ['attic-target'])
  const { calls, runs } = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, playfields: HALLOWEEN_ZONES })
  const batView = map(atticBat.x, atticBat.y)
  const leftAnchorView = map(LEFT_ANCHOR_UV.x, LEFT_ANCHOR_UV.y)
  const rightAnchorView = map(RIGHT_ANCHOR_UV.x, RIGHT_ANCHOR_UV.y)
  const launchArc = calls.find((c) => c.method === 'arc')
  assert(launchArc, 'expected a launch-point arc (circle) to be drawn')
  close(launchArc.args[0], batView.x, 1e-6, 'launch dot x must be the Attic bat, not the plunger/main-flipper default')
  close(launchArc.args[1], batView.y, 1e-6, 'launch dot y must be the Attic bat')
  const dLeft = Math.hypot(launchArc.args[0] - leftAnchorView.x, launchArc.args[1] - leftAnchorView.y)
  const dRight = Math.hypot(launchArc.args[0] - rightAnchorView.x, launchArc.args[1] - rightAnchorView.y)
  assert(dLeft > 5 && dRight > 5, 'launch dot must NOT be at a main-flipper anchor')
  const laneBandMinX = map(0.93, 0).x
  const laneBandMaxX = map(0.98, 0).x
  const inLaneBand = runs.flatMap((r) => r.points).filter((p) => p.x >= laneBandMinX && p.x <= laneBandMaxX)
  assert(inLaneBand.length === 0, `expected NO drawn point inside the shooter-lane x-band [0.93,0.98] (a deck shot cannot be plunged directly), found ${inLaneBand.length}`)
  return `launch dot at the Attic bat (${batView.x},${batView.y}); ${Math.min(dLeft, dRight).toFixed(1)}px clear of the nearest main-flipper anchor; zero points in the shooter-lane band`
})

await test('the SAME step-0 shot with category "combo" (not skillshot) also launches from the deck bat — confirms the override is about the deck, not the category', () => {
  const g = goal('g-deck-launch-combo', 'combo', ['attic-target'])
  const { calls } = draw(g, 'any', { shotsByID: HALLOWEEN_SHOTS, playfields: HALLOWEEN_ZONES })
  const batView = map(atticBat.x, atticBat.y)
  const launchArc = calls.find((c) => c.method === 'arc')
  close(launchArc.args[0], batView.x, 1e-6, 'launch dot x')
  close(launchArc.args[1], batView.y, 1e-6, 'launch dot y')
  return `non-skillshot goal starting on the same deck shot also launches at (${batView.x},${batView.y})`
})

// ===========================================================================
section('e. fail-soft: a zone with NO bat renders IDENTICAL route geometry to a no-zones render')
// ===========================================================================

await test('goal [obs-entry, obs-target]: WITH a bat-less zone === WITHOUT any playfields at all (byte-for-byte calls comparison)', () => {
  const g = goal('g-nobat', 'combo', ['obs-entry', 'obs-target'])
  // segment 2 (index 1, obs-target) active on both sides — its leg needs to
  // be the one drawn for the sanity check below (item 5), and both sides
  // must stay on the SAME active index for the byte-identity comparison to
  // mean anything.
  const withZone = draw(g, 'any', { shotsByID: NOBAT_SHOTS, playfields: NOBAT_ZONES, highlightIndex: 1 })
  const withoutZone = draw(g, 'any', { shotsByID: NOBAT_SHOTS, highlightIndex: 1 })
  const a = JSON.stringify(withZone.calls)
  const b = JSON.stringify(withoutZone.calls)
  assert(a === b, `expected byte-identical draw calls; got ${withZone.calls.length} calls WITH the bat-less zone vs ${withoutZone.calls.length} WITHOUT`)
  const targetView = map(obsTarget.x, obsTarget.y)
  const stroke = runsEndingAt(withZone.runs, targetView).find((r) => r.points.length > 3)
  assert(stroke, 'sanity: expected a real route to have drawn at all (a trivially-empty comparison would prove nothing)')
  return `${withZone.calls.length} canvas calls, byte-for-byte identical whether the bat-less "Observatory" zone is passed or playfields is omitted entirely`
})

// ===========================================================================
section('f. THE BYTE-IDENTITY GATE: real, zone-less data/jaws_goals.json is unaffected')
// ===========================================================================

await test('every goal in a real ZONE-LESS machine renders byte-identical draw calls with opts.playfields omitted vs an explicit []', () => {
  // Fixture is picked dynamically: the data passes are authoring playfields[]
  // into more machines over time (jaws gained the Orca deck the day this
  // phase landed), so pinning any one filename would rot. The premise this
  // test needs is only "a real shipped machine with NO zones" — find one.
  const candidate = readdirSync(dataDir)
    .filter((f) => f.endsWith('_goals.json'))
    .sort()
    .map((f) => ({ f, doc: JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')) }))
    .find(({ doc }) => !('playfields' in doc) && doc.goals.some((g) => g.steps.length > 0))
  assert(candidate, 'fixture sanity: expected at least ONE shipped machine without a playfields key — if every machine has zones now, this fail-soft gate needs a synthetic fixture instead')
  const { f, doc } = candidate
  const shotsByID = new Map(doc.shots.map((s) => [s.id, s]))
  const routedGoals = doc.goals.filter((g) => g.steps.length > 0)
  let checked = 0
  for (const g of routedGoals) {
    const omitted = draw(g, 'any', { shotsByID })
    const empty = draw(g, 'any', { shotsByID, playfields: [] })
    const a = JSON.stringify(omitted.calls)
    const b = JSON.stringify(empty.calls)
    assert(a === b, `${f} goal "${g.id}": draw calls diverged between playfields omitted (${omitted.calls.length} calls) and playfields:[] (${empty.calls.length} calls)`)
    checked++
  }
  return `${checked} routed goals of real zone-less ${f} rendered byte-identical draw-call sequences with opts.playfields absent vs [] — this phase's fail-soft gate holds for real shipped data`
})

// ===========================================================================
section('g. art: zone plates, trim filtering, and the regex-extras exclusion')
// ===========================================================================

/** Recording 2D-context stub for drawPlayfieldArt/drawZoneFloor (art
 *  assertions need fillStyle/strokeStyle + traced path points + setLineDash
 *  args, none of which the routing recordingCtx above tracks —
 *  playfield-art.test.mjs's technique, extended with fillRect/strokeRect
 *  (map2d.ts already uses fillRect elsewhere — see drawMapCardBackground's
 *  glow) and a REAL setLineDash recorder (every other suite's stub no-ops
 *  it; section b's dashed-outline assertion needs the actual argument).
 *  createLinearGradient (2026-08-11, LEVEL-control generalization tests)
 *  is drawZoneFloor's own card-background gradient — drawPlayfieldArt never
 *  calls it, so this stub never needed it before drawZoneFloor was first
 *  exercised directly. */
function makeArtCtx(lineDashCalls = []) {
  const calls = []
  let current = []
  const ctx = {
    lineCap: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '', globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, closePath() {},
    setLineDash(segs) { lineDashCalls.push(Array.isArray(segs) ? segs.slice() : segs) },
    createLinearGradient: () => ({ addColorStop: () => {} }),
    beginPath() { current = [] },
    moveTo(x, y) { current.push([x, y]) },
    lineTo(x, y) { current.push([x, y]) },
    arcTo(x1, y1, x2, y2) { current.push([x1, y1], [x2, y2]) },
    quadraticCurveTo(cx, cy, x, y) { current.push([cx, cy], [x, y]) },
    arc(x, y, r) { current.push([x, y]); calls.push({ op: 'arc', pts: [[x, y]], r, fill: this.fillStyle, stroke: this.strokeStyle }) },
    fillRect(x, y, w, h) { calls.push({ op: 'fillRect', pts: [[x, y], [x + w, y + h]], style: this.fillStyle }) },
    strokeRect(x, y, w, h) { calls.push({ op: 'strokeRect', pts: [[x, y], [x + w, y + h]], style: this.strokeStyle, lineWidth: this.lineWidth }) },
    fill() { calls.push({ op: 'fill', pts: current.slice(), style: this.fillStyle }) },
    stroke() { calls.push({ op: 'stroke', pts: current.slice(), style: this.strokeStyle, lineWidth: this.lineWidth }) },
    fillText(t, x, y) { calls.push({ op: 'fillText', pts: [[x, y]], text: t }) },
    strokeText(t, x, y) { calls.push({ op: 'strokeText', pts: [[x, y]], text: t }) },
    measureText: () => ({ width: 40 }),
  }
  ctx._calls = calls
  return ctx
}

/** Mapped pixel bounds of a zone (same corner math as map2d.ts's own
 *  zone-plate block — mirrored here for prediction, not imported, matching
 *  every other suite's "predict independently, then check the real output"
 *  convention). */
function zonePxBounds(zone) {
  const top = map(zone.bounds.x, zone.bounds.y + zone.bounds.h)
  const bottom = map(zone.bounds.x + zone.bounds.w, zone.bounds.y)
  return { x: Math.min(top.x, bottom.x), y: Math.min(top.y, bottom.y), w: Math.abs(bottom.x - top.x), h: Math.abs(bottom.y - top.y) }
}
function withinBounds(pts, b, eps = 1.5) {
  return pts.every(([px, py]) => px >= b.x - eps && px <= b.x + b.w + eps && py >= b.y - eps && py <= b.y + b.h + eps)
}

await test('upper plate (Garage zone): a fill call in the plate\'s fill color traces a path within its mapped bounds', () => {
  const artCtx = makeArtCtx()
  drawPlayfieldArt(artCtx, map, 0, 1, [], [GARAGE_ZONE])
  const b = zonePxBounds(GARAGE_ZONE)
  const plateFill = artCtx._calls.find((c) => c.op === 'fill' && c.style === 'rgba(255, 255, 255, 0.045)' && withinBounds(c.pts, b))
  assert(plateFill, `expected a plate fill (rgba(255, 255, 255, 0.045)) within mapped bounds x[${b.x.toFixed(1)},${(b.x + b.w).toFixed(1)}] y[${b.y.toFixed(1)},${(b.y + b.h).toFixed(1)}], calls: ${JSON.stringify(artCtx._calls.filter((c) => c.op === 'fill').map((c) => c.style))}`)
  const plateStroke = artCtx._calls.find((c) => c.op === 'stroke' && c.style === 'rgba(255, 255, 255, 0.22)' && withinBounds(c.pts, b))
  assert(plateStroke, 'expected the plate outline stroke within the same bounds')
  return `plate fill+stroke both traced within Garage's mapped bounds x[${b.x.toFixed(1)},${(b.x + b.w).toFixed(1)}] y[${b.y.toFixed(1)},${(b.y + b.h).toFixed(1)}]`
})

await test("trim: a premium-le-only zone's plate is absent under trim 'pro' (isZoneVisible), a trim-less zone's plate still draws", () => {
  const proOnlyZone = { id: 'z-pro-visible', name: 'Pro Visible', kind: 'upper', bounds: { x: 0.05, y: 0.05, w: 0.15, h: 0.10 } }
  const premiumZone = { id: 'z-premium-only', name: 'Premium Only', kind: 'upper', bounds: { x: 0.75, y: 0.80, w: 0.15, h: 0.10 }, trim: 'premium-le' }
  assert(isZoneVisible(proOnlyZone, 'pro') === true, 'fixture sanity: a trim-less zone must be visible under pro')
  assert(isZoneVisible(premiumZone, 'pro') === false, 'fixture sanity: a premium-le zone must NOT be visible under pro')
  const filtered = [proOnlyZone, premiumZone].filter((z) => isZoneVisible(z, 'pro'))
  assert(filtered.length === 1 && filtered[0].id === 'z-pro-visible', 'expected isZoneVisible to filter out exactly the premium-le zone')

  const artCtx = makeArtCtx()
  drawPlayfieldArt(artCtx, map, 0, 1, [], filtered)
  const proB = zonePxBounds(proOnlyZone)
  const premB = zonePxBounds(premiumZone)
  const proPlate = artCtx._calls.find((c) => c.op === 'fill' && c.style === 'rgba(255, 255, 255, 0.045)' && withinBounds(c.pts, proB))
  const premPlate = artCtx._calls.find((c) => c.op === 'fill' && c.style === 'rgba(255, 255, 255, 0.045)' && withinBounds(c.pts, premB))
  assert(proPlate, "expected the trim-less zone's plate to still draw")
  assert(!premPlate, "expected NO plate fill within the premium-le zone's bounds — it must vanish under trim 'pro'")
  return `caller-side filtering via isZoneVisible(z,'pro'): the trim-less plate draws, the premium-le plate is entirely absent`
})

await test('deck bat draws exactly once, at bat.size — the name-regex extras loop is excluded for a shot naming a `playfield`', () => {
  const zone = { id: 'z-test-deck', name: 'Test Deck', kind: 'upper', bounds: { x: 0.15, y: 0.55, w: 0.30, h: 0.20 } }
  // Name deliberately does NOT match the regex extras loop's own `mini`
  // detection (/mini|\bshort|stewie|donkey|kneedeep|encounter|castle|
  // twister|thing\b|shark/) — so a scale-0.5 draw can only have come from
  // `bat.size:'mini'` being read directly, not from the regex's name-sniffing
  // heuristic. This is what makes the test actually discriminate the new
  // deck-bat code path from the old regex path, not just count draws: on the
  // pre-A4 code (no `.playfield` exclusion, no zone-plate block) this exact
  // shot would still get picked up by the regex loop — count 3 either way —
  // but at FULL scale, since its name doesn't trip the mini regex. Confirmed
  // by hand (git-stash round-trip against pre-A4 drawing.ts/map2d.ts/
  // shotgeom.ts): this assertion FAILS on the old code (span ratio ~1.0),
  // PASSES on the new code (span ratio ~0.5).
  const batShot = { id: 'test-deck-bat', name: 'Test Deck Bat', type: 'flipper', x: 0.30, y: 0.62, trim: 'all', playfield: 'z-test-deck', bat: { side: 'left', size: 'mini' } }
  const artCtx = makeArtCtx()
  drawPlayfieldArt(artCtx, map, 0, 1, [batShot], [zone])
  const flipperFills = artCtx._calls.filter((c) => c.op === 'fill' && c.style === 'rgba(195, 63, 42, 0.85)')
  // 2 unconditional main flippers (default pivots — this fixture names no
  // main-flipper shot) + 1 deck bat = 3. A double-draw (the regex extras loop
  // ALSO picking up the same shot) would make this 4.
  assert(flipperFills.length === 3, `expected exactly 3 flipper-colored fills (2 default mains + 1 deck bat, no double-draw), got ${flipperFills.length}`)
  const span = (f) => Math.max(...f.pts.map((p) => p[0])) - Math.min(...f.pts.map((p) => p[0]))
  const mains = flipperFills.filter((f) => Math.min(...f.pts.map((p) => p[1])) > H * 0.7)
  const deckBatFill = flipperFills.find((f) => !mains.includes(f))
  assert(mains.length === 2 && deckBatFill, `expected 2 main-band fills + 1 deck-bat fill, got ${mains.length} mains and ${deckBatFill ? 1 : 0} deck-bat fill`)
  const mainSpan = Math.max(...mains.map(span))
  const batSpanRatio = span(deckBatFill) / mainSpan
  assert(batSpanRatio < 0.75, `expected the deck bat to draw at its OWN bat.size:'mini' scale (~0.5x a main flipper's span), got a span ratio of ${batSpanRatio.toFixed(2)} — a ratio near 1.0 would mean it fell through to the regex loop's full-scale default instead of reading bat.size directly`)
  return `${flipperFills.length} flipper-colored fills (2 default mains + 1 deck bat); deck bat span is ${(batSpanRatio * 100).toFixed(0)}% of a main flipper's — reads bat.size:'mini' directly, not the regex's name-sniffed default`
})

// ===========================================================================
section("h. Feature 2 (2026-08-11): PLAYFIELD LEVEL VIEW")
// ===========================================================================
// A machine's own playfields[] may declare any number of zones, of ANY kind
// ('upper'/'mini' raised decks, or a sunken 'lower' sub-playfield) — the map
// settings popover's LEVEL control switches the whole canvas to a zoomed
// view of just ONE zone at a time: own bounds fill the playfield rect (own
// scale, own aspect), only member shots + the zone's own deck bat + a
// plate-floor treatment + entry/exit edge markers draw, and the selected
// goal's steps ON that zone draw within — via the zone's own deck bat by
// default (Feature 1), same as the MAIN view.
//
// GENERALIZED 2026-08-11 (same day as the feature's first cut): originally
// the control was a fixed MAIN/−1 pair scoped to a single `kind:'lower'`
// zone, with no shipped machine having one yet. Real zone data has since
// landed (see the first test below, against the live catalog) and the
// owner asked for every zone kind to be reachable, not just 'lower' — the
// control now offers MAIN plus one entry per visible zone, any kind
// (machineZones), rendered as a segmented control or a compact ‹ › scroller
// depending on how many options that is (LEVEL_SEGMENTED_MAX). The tests
// below cover: the visibility gate against the real catalog (both
// directions — a shipped lower zone, AND a shipped machine with none);
// machineZones's own multi-kind/multi-zone generalization on synthetic
// fixtures; resolveMapLevel's machine/trim reset rule; the
// LEVEL_SEGMENTED_MAX threshold; drawZoneFloor's kind-branch fix (the ONE
// place in the render path that used to hard-code the 'lower' look); and
// the pre-existing render-path primitives (zoneLocalMap/drawZoneGoalRoute/
// drawZoneEdgeMarkers) proven again against an UPPER zone fixture, not just
// CRYPT2_ZONE's lower one, since none of them had ever been exercised with
// anything but a lower zone before.

const CRYPT2_ZONE = {
  id: 'z-lower-crypt2',
  name: 'The Crypt',
  kind: 'lower',
  bounds: { x: 0.3, y: 0.2, w: 0.4, h: 0.3 },
  entries: ['crypt2-entry'],
  // Deliberately OUTSIDE the zone's own bounds (v=0.85 vs the zone's own
  // v-range [0.20,0.50]) — exercises the edge-marker CLAMP.
  exits: [{ x: 0.5, y: 0.85 }],
}
const crypt2Bat = { id: 'crypt2-bat', name: 'Crypt Bat', type: 'flipper', x: 0.5, y: 0.25, trim: 'all', playfield: 'z-lower-crypt2', bat: { side: 'right' } }
const crypt2Target1 = { id: 'crypt2-target-1', name: 'Crypt Target 1', type: 'standup', x: 0.35, y: 0.3, trim: 'all', playfield: 'z-lower-crypt2' }
const crypt2Target2 = { id: 'crypt2-target-2', name: 'Crypt Target 2', type: 'standup', x: 0.6, y: 0.4, trim: 'all', playfield: 'z-lower-crypt2' }
// feeds land INSIDE the zone (0.38,0.28) — the "climb onto the deck" entry.
const crypt2Entry = { id: 'crypt2-entry', name: 'Crypt2 Entry', type: 'scoop', x: 0.2, y: 0.6, trim: 'all', feeds: { x: 0.38, y: 0.28 } }
const CRYPT2_SHOTS = new Map([crypt2Bat, crypt2Target1, crypt2Target2, crypt2Entry].map((s) => [s.id, s]))

function centerOf(pts) {
  const xs = pts.map(([x]) => x)
  const ys = pts.map(([, y]) => y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

// ---------------------------------------------------------------------------
// SYNTHETIC-BELFRY fixture (generalization tests) — an UPPER zone, deliberate
// mirror of CRYPT2_ZONE (same shape of entries/exits/bat/two targets) so the
// render-path primitives below can be proven against a RAISED zone with the
// same rigor CRYPT2_ZONE already got for a SUNKEN one, rather than just
// trusting "zoneLocalMap never reads .kind" by inspection.
// ---------------------------------------------------------------------------
const BELFRY_ZONE = {
  id: 'z-upper-belfry',
  name: 'The Belfry',
  kind: 'upper',
  bounds: { x: 0.3, y: 0.2, w: 0.4, h: 0.3 },
  entries: ['belfry-entry'],
  exits: [{ x: 0.5, y: 0.85 }],
}
const belfryBat = { id: 'belfry-bat', name: 'Belfry Bat', type: 'flipper', x: 0.5, y: 0.25, trim: 'all', playfield: 'z-upper-belfry', bat: { side: 'right' } }
const belfryTarget1 = { id: 'belfry-target-1', name: 'Belfry Target 1', type: 'standup', x: 0.35, y: 0.3, trim: 'all', playfield: 'z-upper-belfry' }
const belfryTarget2 = { id: 'belfry-target-2', name: 'Belfry Target 2', type: 'standup', x: 0.6, y: 0.4, trim: 'all', playfield: 'z-upper-belfry' }
const belfryEntry = { id: 'belfry-entry', name: 'Belfry Entry', type: 'scoop', x: 0.2, y: 0.6, trim: 'all', feeds: { x: 0.38, y: 0.28 } }
const BELFRY_SHOTS = new Map([belfryBat, belfryTarget1, belfryTarget2, belfryEntry].map((s) => [s.id, s]))

// ---------------------------------------------------------------------------
// SYNTHETIC multi-kind, multi-zone fixture (generalization tests) — one zone
// of EACH kind on a single machine, proving machineZones surfaces all three
// together (not just 'lower', the pre-generalization behavior) and pinning
// where LEVEL_SEGMENTED_MAX's segmented/scroller split actually falls.
// ---------------------------------------------------------------------------
const TRIZONE_UPPER = { id: 'z-tri-upper', name: 'Tri Upper', kind: 'upper', bounds: { x: 0.05, y: 0.55, w: 0.2, h: 0.15 } }
const TRIZONE_MINI = { id: 'z-tri-mini', name: 'Tri Mini', kind: 'mini', bounds: { x: 0.6, y: 0.5, w: 0.15, h: 0.1 } }
const TRIZONE_LOWER = { id: 'z-tri-lower', name: 'Tri Lower', kind: 'lower', bounds: { x: 0.35, y: 0.25, w: 0.3, h: 0.15 } }
const TRIZONE_ALL = [TRIZONE_UPPER, TRIZONE_MINI, TRIZONE_LOWER]

await test('machineHasLowerZone over real shipped data: true for the P2-authored lower zones, false everywhere else', () => {
  // Premise updated 2026-08-11: the P2 deck-inventory apply shipped the first
  // real kind:'lower' zones (ac_dc's Underworld and munsters' Grandpa's Lab —
  // both premium-le — and street_fighter_ii's Car Crunch on every trim), so
  // the old "NEVER true for shipped data" pin is obsolete. This test now pins
  // BOTH directions against the live catalog: the LEVEL control has real
  // machines to show, and it doesn't leak onto machines with no lower zone.
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  const withLower = new Set()
  let checked = 0
  for (const f of files) {
    const doc = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
    if (machineHasLowerZone(doc.playfields, 'pro') || machineHasLowerZone(doc.playfields, 'premium-le')) {
      withLower.add(f)
    }
    checked++
  }
  assert(checked > 50, `fixture sanity: expected to check a real number of shipped files, got ${checked}`)
  assert(withLower.size >= 1, 'expected at least one shipped machine with a lower zone after the P2 apply')
  for (const known of ['ac_dc_goals.json', 'munsters_goals.json', 'street_fighter_ii_goals.json']) {
    assert(withLower.has(known), `${known}: expected a lower zone (P2-applied) — did the data move?`)
  }
  const sf2 = JSON.parse(readFileSync(resolve(dataDir, 'street_fighter_ii_goals.json'), 'utf8'))
  assert(machineHasLowerZone(sf2.playfields, 'pro') === true, 'sf2 Car Crunch has no trim restriction — LEVEL must show under pro too')
  const acdc = JSON.parse(readFileSync(resolve(dataDir, 'ac_dc_goals.json'), 'utf8'))
  assert(machineHasLowerZone(acdc.playfields, 'pro') === false, "ac_dc Underworld is premium-le-only — LEVEL must NOT show under pro")
  return `${checked} shipped files: ${withLower.size} with a lower zone (${[...withLower].join(', ')}) — LEVEL control gates correctly in both directions`
})

await test("machineHasLowerZone: true for a synthetic kind:'lower' zone visible under trim; false when trim hides it, kind isn't 'lower', or playfields is empty/absent", () => {
  assert(machineHasLowerZone([CRYPT2_ZONE], 'pro') === true, 'expected true for a visible lower zone (pro)')
  assert(machineHasLowerZone([CRYPT2_ZONE], 'premium-le') === true, 'expected true regardless of trim — this zone carries no trim restriction')
  const premiumOnly = { ...CRYPT2_ZONE, id: 'z-lower-premium', trim: 'premium-le' }
  assert(machineHasLowerZone([premiumOnly], 'pro') === false, 'expected false under pro when the lower zone is premium-le-only')
  assert(machineHasLowerZone([], 'pro') === false, 'expected false for an empty playfields array')
  assert(machineHasLowerZone(null, 'pro') === false, 'expected false for null/absent playfields')
  assert(machineHasLowerZone([{ ...CRYPT2_ZONE, kind: 'upper' }], 'pro') === false, "expected false for an 'upper' zone (not 'lower')")
  return "machineHasLowerZone correctly gates on kind==='lower' AND isZoneVisible(trim)"
})

await test("zoneLocalMap: the zone's own bounds fill the rect exactly, at the zone's OWN aspect — an off-zone point maps OUTSIDE the rect (no clamping)", () => {
  const rect = { x: 20, y: 20, w: 300, h: 225 }
  const zoneMap = zoneLocalMap(CRYPT2_ZONE, rect)
  const bottomLeft = zoneMap(CRYPT2_ZONE.bounds.x, CRYPT2_ZONE.bounds.y) // zone-local (0,0) -> rect bottom-left (v=0 at the bottom, same convention as the MAIN map)
  const topRight = zoneMap(CRYPT2_ZONE.bounds.x + CRYPT2_ZONE.bounds.w, CRYPT2_ZONE.bounds.y + CRYPT2_ZONE.bounds.h) // zone-local (1,1) -> rect top-right
  close(bottomLeft.x, rect.x, 1e-6, 'zone (0,0) -> rect left edge')
  close(bottomLeft.y, rect.y + rect.h, 1e-6, 'zone (0,0) -> rect BOTTOM edge')
  close(topRight.x, rect.x + rect.w, 1e-6, 'zone (1,1) -> rect right edge')
  close(topRight.y, rect.y, 1e-6, 'zone (1,1) -> rect TOP edge')
  const center = zoneMap(CRYPT2_ZONE.bounds.x + CRYPT2_ZONE.bounds.w / 2, CRYPT2_ZONE.bounds.y + CRYPT2_ZONE.bounds.h / 2)
  close(center.x, rect.x + rect.w / 2, 1e-6, 'zone center -> rect center x')
  close(center.y, rect.y + rect.h / 2, 1e-6, 'zone center -> rect center y')
  const outside = zoneMap(CRYPT2_ZONE.bounds.x - CRYPT2_ZONE.bounds.w, CRYPT2_ZONE.bounds.y)
  assert(outside.x < rect.x - 1, 'expected a point outside the zone bounds to map outside the rect (linear extrapolation, no clamping — CONTRACTS.md)')
  return `zone bounds fill the rect exactly (own aspect ${(CRYPT2_ZONE.bounds.w / CRYPT2_ZONE.bounds.h).toFixed(2)}); an off-zone point maps outside the rect, confirming a real re-projection rather than a clamp-to-rect`
})

await test("drawZoneGoalRoute: an off-zone step 0 draws nothing; the first zone-member step (predecessor off-zone) routes from the ENTRY MARKER through the zone's DECK BAT; a chained same-zone step ALSO routes via the deck bat by default; badges use the ORIGINAL whole-goal step numbers", () => {
  const g = goal('g-zone-route', 'combo', ['crypt2-entry', 'crypt2-target-1', 'crypt2-target-2'])
  const rect = { x: 20, y: 20, w: 300, h: 225 }
  const zoneMap = zoneLocalMap(CRYPT2_ZONE, rect)
  const zonesById = new Map([[CRYPT2_ZONE.id, CRYPT2_ZONE]])
  const artCtx = makeArtCtx()
  drawZoneGoalRoute(artCtx, zoneMap, CRYPT2_ZONE, zonesById, g, CRYPT2_SHOTS, 'premium-le', '#ff9500')

  const entryFeedView = zoneMap(0.38, 0.28) // crypt2-entry's resolved feed — the entry-marker origin for step 1
  const batView = zoneMap(crypt2Bat.x, crypt2Bat.y)
  const target1View = zoneMap(crypt2Target1.x, crypt2Target1.y)
  const target2View = zoneMap(crypt2Target2.x, crypt2Target2.y)
  const strokes = artCtx._calls.filter((c) => c.op === 'stroke')

  // step 1 (crypt2-target-1): origin = the entry marker, routed via the deck bat.
  const legToTarget1 = strokes.find((c) => c.pts.some(([x, y]) => Math.hypot(x - target1View.x, y - target1View.y) < 1e-6))
  assert(legToTarget1, 'expected a stroked leg reaching crypt2-target-1')
  assert(
    legToTarget1.pts.some(([x, y]) => Math.hypot(x - entryFeedView.x, y - entryFeedView.y) < 1e-6),
    "expected the leg into the first zone-member step to originate at the entry marker's resolved feed point",
  )
  assert(
    legToTarget1.pts.some(([x, y]) => Math.hypot(x - batView.x, y - batView.y) < 1e-6),
    "expected the leg to route THROUGH the zone's own deck bat (Feature 1 default anchor)",
  )

  // step 2 (crypt2-target-2): origin = crypt2-target-1's own (x,y) (no feeds authored), ALSO via the deck bat by default (no direct:true).
  const legToTarget2 = strokes.find((c) => c.pts.some(([x, y]) => Math.hypot(x - target2View.x, y - target2View.y) < 1e-6))
  assert(legToTarget2, 'expected a stroked leg reaching crypt2-target-2')
  assert(
    legToTarget2.pts.some(([x, y]) => Math.hypot(x - target1View.x, y - target1View.y) < 1e-6),
    "expected the second zone-member step's leg to originate at the FIRST zone-member step's own position",
  )
  assert(
    legToTarget2.pts.some(([x, y]) => Math.hypot(x - batView.x, y - batView.y) < 1e-6),
    'expected the chained same-zone leg to ALSO route via the deck bat by default (Feature 1: no authored direct)',
  )

  // Badges: crypt2-target-1 is the WHOLE GOAL's step index 1 (2nd step) -> "2"; crypt2-target-2 is index 2 -> "3"; crypt2-entry (index 0, off-zone) contributes no badge.
  const badgeTexts = artCtx._calls.filter((c) => c.op === 'fillText').map((c) => c.text)
  assert(badgeTexts.includes('2'), `expected a badge reading the ORIGINAL step number "2" for crypt2-target-1, got texts: ${JSON.stringify(badgeTexts)}`)
  assert(badgeTexts.includes('3'), `expected a badge reading the ORIGINAL step number "3" for crypt2-target-2, got texts: ${JSON.stringify(badgeTexts)}`)
  assert(!badgeTexts.includes('1'), 'expected NO badge "1" — the off-zone step 0 (crypt2-entry) draws nothing in this view')

  return `both zone-member legs route through the deck bat (${batView.x.toFixed(0)},${batView.y.toFixed(0)}) by default; badges read the ORIGINAL whole-goal step numbers ("2","3"), not local 1-based numbers; the off-zone step 0 contributes no badge`
})

await test('drawZoneGoalRoute: a goal whose badge could only read "1" gets NO badge here either — the LEVEL view shares the main view\'s rule, it does not re-derive one', () => {
  // The whole point of exporting goalBadgesAreInformative from drawing.ts is
  // that this view draws its OWN badge (it labels every zone-member step with
  // the whole-goal number, not just the active one) and would otherwise be
  // free to disagree with the main view about when a badge exists. A user
  // switching between MAIN and a LEVEL would see the badge appear/disappear.
  //
  // Both suppressed shapes are checked: a single-step goal, and a skillshot.
  // The route itself must still draw in both — this removes a label, not a
  // path.
  const cases = [
    { name: 'single-step', g: goal('g-zone-single', 'combo', ['crypt2-target-1']) },
    { name: 'skillshot', g: goal('g-zone-skill', 'skillshot', ['crypt2-target-1', 'crypt2-target-2']) },
  ]
  const rect = { x: 20, y: 20, w: 300, h: 225 }
  const zoneMap = zoneLocalMap(CRYPT2_ZONE, rect)
  const zonesById = new Map([[CRYPT2_ZONE.id, CRYPT2_ZONE]])
  const target1View = zoneMap(crypt2Target1.x, crypt2Target1.y)
  const report = []
  for (const { name, g } of cases) {
    const artCtx = makeArtCtx()
    drawZoneGoalRoute(artCtx, zoneMap, CRYPT2_ZONE, zonesById, g, CRYPT2_SHOTS, 'premium-le', '#ff6b26')
    const digits = artCtx._calls.filter((c) => c.op === 'fillText' && /^\d+$/.test(String(c.text))).map((c) => c.text)
    assert(digits.length === 0, `${name}: expected no numbered badge in the LEVEL view, got ${JSON.stringify(digits)}`)
    // The target ring is drawn as an arc at the target — still there.
    const ringAtTarget = artCtx._calls.filter(
      (c) => c.op === 'arc' && Math.hypot(c.pts[0][0] - target1View.x, c.pts[0][1] - target1View.y) < 1e-6,
    )
    assert(ringAtTarget.length > 0, `${name}: the target ring must still draw — the badge rule must not remove the target`)
    report.push(`${name}: 0 badges, ${ringAtTarget.length} ring arc(s)`)
  }
  return `LEVEL view honours goalBadgesAreInformative — ${report.join('; ')}`
})

await test('drawZoneGoalRoute: authored direct:true on the chained step draws a straight target-to-target leg — no deck-bat waypoint', () => {
  const g = goal('g-zone-route-direct', 'combo', ['crypt2-entry', 'crypt2-target-1', 'crypt2-target-2'])
  g.steps[2].direct = true
  const rect = { x: 20, y: 20, w: 300, h: 225 }
  const zoneMap = zoneLocalMap(CRYPT2_ZONE, rect)
  const zonesById = new Map([[CRYPT2_ZONE.id, CRYPT2_ZONE]])
  const artCtx = makeArtCtx()
  drawZoneGoalRoute(artCtx, zoneMap, CRYPT2_ZONE, zonesById, g, CRYPT2_SHOTS, 'premium-le', '#ff9500')

  const batView = zoneMap(crypt2Bat.x, crypt2Bat.y)
  const target1View = zoneMap(crypt2Target1.x, crypt2Target1.y)
  const target2View = zoneMap(crypt2Target2.x, crypt2Target2.y)
  const strokes = artCtx._calls.filter((c) => c.op === 'stroke')
  const legToTarget2 = strokes.find((c) => c.pts.some(([x, y]) => Math.hypot(x - target2View.x, y - target2View.y) < 1e-6))
  assert(legToTarget2, 'expected a stroked leg reaching crypt2-target-2')
  assert(legToTarget2.pts.length === 2, `expected a plain 2-point straight leg (direct:true, no waypoint corner), got ${legToTarget2.pts.length} points`)
  assert(
    !legToTarget2.pts.some(([x, y]) => Math.hypot(x - batView.x, y - batView.y) < 1),
    'expected the authored-direct leg to skip the deck bat entirely',
  )
  assert(
    Math.hypot(legToTarget2.pts[0][0] - target1View.x, legToTarget2.pts[0][1] - target1View.y) < 1e-6,
    'expected the direct leg to still originate at the previous target',
  )
  return `direct:true draws a plain 2-point straight leg from crypt2-target-1 (${target1View.x.toFixed(0)},${target1View.y.toFixed(0)}) directly to crypt2-target-2, skipping the deck bat`
})

await test('drawZoneEdgeMarkers: an entry lands at its unclamped resolved feed point (already inside the zone); an exit that resolves OUTSIDE the zone bounds is pinned to the nearest edge', () => {
  const rect = { x: 20, y: 20, w: 300, h: 225 }
  const zoneMap = zoneLocalMap(CRYPT2_ZONE, rect)
  const artCtx = makeArtCtx()
  drawZoneEdgeMarkers(artCtx, zoneMap, CRYPT2_ZONE, CRYPT2_SHOTS, 'premium-le')

  const fills = artCtx._calls.filter((c) => c.op === 'fill')
  assert(fills.length === 2, `expected exactly 2 marker fills (1 entry + 1 exit), got ${fills.length}`)

  // Entry: crypt2-entry.feeds = (0.38, 0.28) — already inside CRYPT2_ZONE.bounds
  // (x:[0.30,0.70], y:[0.20,0.50]) — the clamp is a no-op.
  const entryFeedView = zoneMap(0.38, 0.28)
  const entryFill = fills.find((c) => Math.hypot(centerOf(c.pts).x - entryFeedView.x, centerOf(c.pts).y - entryFeedView.y) < 1e-6)
  assert(entryFill, `expected an entry marker centered exactly on the unclamped resolved feed point (${entryFeedView.x.toFixed(1)},${entryFeedView.y.toFixed(1)})`)

  // Exit: {x:0.5, y:0.85} — y=0.85 is WAY outside the zone's own v-range
  // [0.20,0.50] — must clamp to the zone's own top edge (v=0.50); x=0.5 is
  // already inside [0.30,0.70], so only y clamps.
  const clampedExitView = zoneMap(0.5, 0.5)
  const rawExitView = zoneMap(0.5, 0.85) // where it would land WITHOUT clamping
  const exitFill = fills.find((c) => Math.hypot(centerOf(c.pts).x - clampedExitView.x, centerOf(c.pts).y - clampedExitView.y) < 1e-6)
  assert(exitFill, `expected an exit marker pinned to the zone's own top edge (${clampedExitView.x.toFixed(1)},${clampedExitView.y.toFixed(1)}), not the raw unclamped resolution`)
  const dRaw = Math.hypot(clampedExitView.x - rawExitView.x, clampedExitView.y - rawExitView.y)
  assert(dRaw > 5, `expected the clamped position to be measurably different from the raw (unclamped) resolution, got ${dRaw.toFixed(2)}px apart`)

  const labels = artCtx._calls.filter((c) => c.op === 'fillText').map((c) => c.text)
  assert(labels.includes('ENTRY'), `expected an ENTRY label, got ${JSON.stringify(labels)}`)
  assert(labels.includes('EXIT'), `expected an EXIT label, got ${JSON.stringify(labels)}`)
  return `entry marker at the unclamped feed point (${entryFeedView.x.toFixed(1)},${entryFeedView.y.toFixed(1)}); exit marker clamped to the zone's own edge (${clampedExitView.x.toFixed(1)},${clampedExitView.y.toFixed(1)}), ${dRaw.toFixed(0)}px from its raw (off-zone) resolution`
})

// ===========================================================================
// GENERALIZATION (2026-08-11, same day): the LEVEL control now scrolls
// through MAIN + one entry per visible zone, ANY kind — not just a single
// `kind:'lower'` zone. Owner: "there should be a toggle like we have for LE
// and regular games to show the other playfields but instead of version of
// the game it just scrolls thru the levels of playfields."
// ===========================================================================

await test("machineZones: GENERALIZATION — returns visible zones of EVERY kind (upper, mini, AND lower) together, in data order, not just kind:'lower' (machineHasLowerZone's pre-generalization scope)", () => {
  const zones = machineZones(TRIZONE_ALL, 'pro')
  assert(zones.length === 3, `expected all 3 zones regardless of kind, got ${zones.length}`)
  assert(
    zones.map((z) => z.id).join(',') === 'z-tri-upper,z-tri-mini,z-tri-lower',
    `expected data order preserved (upper, mini, lower authored in that order), got ${zones.map((z) => z.id).join(',')}`,
  )
  assert(machineZones([], 'pro').length === 0, 'expected an empty array for a machine with no playfields')
  assert(machineZones(null, 'pro').length === 0, 'expected an empty array for playfields: null')
  assert(machineZones(undefined, 'pro').length === 0, 'expected an empty array for playfields: undefined')
  return "machineZones(TRIZONE_ALL) returned all 3 zones (upper, mini, lower) in data order — the LEVEL control's option set is no longer kind:'lower'-only"
})

await test("LEVEL_SEGMENTED_MAX: MAIN + a real machine's zone count fits the segmented control (max 2 zones on any shipped machine, e.g. halloween); MAIN + TRIZONE_ALL's 3 zones does not, and would use the compact ‹ › scroller instead — this is the 'control offers MAIN+zone entries' option set mountMap2D's refreshLevelControl() builds", () => {
  assert(LEVEL_SEGMENTED_MAX === 3, `expected the documented threshold of 3, got ${LEVEL_SEGMENTED_MAX}`)
  const halloween = JSON.parse(readFileSync(resolve(dataDir, 'halloween_goals.json'), 'utf8'))
  const halloweenZones = machineZones(halloween.playfields, 'premium-le')
  assert(halloweenZones.length === 2, `fixture sanity: expected halloween's real 2-zone roster (house-deck upper + sanitarium-deck mini), got ${halloweenZones.length}`)
  const halloweenOptions = 1 + halloweenZones.length
  assert(halloweenOptions <= LEVEL_SEGMENTED_MAX, `expected halloween's MAIN + 2 zones (${halloweenOptions} options) to fit the segmented control`)
  const triOptions = 1 + machineZones(TRIZONE_ALL, 'pro').length
  assert(triOptions === 4 && triOptions > LEVEL_SEGMENTED_MAX, `expected MAIN + TRIZONE_ALL's 3 zones (${triOptions} options) to exceed LEVEL_SEGMENTED_MAX — this is the fixture that would exercise the ‹ › scroller path`)
  return `LEVEL_SEGMENTED_MAX=${LEVEL_SEGMENTED_MAX}: real halloween MAIN+2 (${halloweenOptions} options, labels MAIN/STRODE HOUSE/SANITARIUM) fits the segmented control; synthetic MAIN+3 (${triOptions} options) does not and would use the ‹ › scroller`
})

await test("resolveMapLevel: 'main' is always valid; a zone id survives only while machineZones(trim) still contains it — falls back to 'main' otherwise. Proves the spec's \"session-local level state resets on machine AND trim switch\" rule, including the owner's own example (a premium-le zone selected, then trim -> pro, back to MAIN)", () => {
  assert(resolveMapLevel('main', []) === 'main', "'main' survives even with zero visible zones")
  assert(resolveMapLevel('main', [CRYPT2_ZONE]) === 'main', "'main' is always valid regardless of what's visible")
  assert(resolveMapLevel(CRYPT2_ZONE.id, [CRYPT2_ZONE]) === CRYPT2_ZONE.id, 'a zone id survives while it is still in the visible list')
  assert(resolveMapLevel(CRYPT2_ZONE.id, []) === 'main', 'falls back to main once its zone drops out of the visible list entirely (machine switch: the whole roster changed)')
  assert(resolveMapLevel('some-other-id', [CRYPT2_ZONE]) === 'main', 'falls back to main when the current id matches nothing visible')

  // The owner's own scenario: "a premium-le zone selected, then trim->pro
  // -> back to MAIN".
  const premiumZone = { ...BELFRY_ZONE, id: 'z-premium-belfry', trim: 'premium-le' }
  let level = resolveMapLevel(premiumZone.id, machineZones([premiumZone], 'premium-le'))
  assert(level === premiumZone.id, 'fixture sanity: selectable while trim is premium-le')
  level = resolveMapLevel(level, machineZones([premiumZone], 'pro'))
  assert(level === 'main', 'expected LEVEL to fall back to MAIN once MODEL switches to pro and the premium-le zone is no longer visible — the owner\'s exact example')

  // Complement (the natural symmetric case, worth pinning even though the
  // owner didn't spell it out): a TRIM-LESS zone SURVIVES the same switch,
  // because it never leaves machineZones(...) in the first place — the
  // reset is conditional on the selection actually going invalid, not an
  // unconditional wipe on every MODEL click (matches state.ts's own
  // setTrim, which never resets unrelated session state itself, only what
  // becomes invalid under the new trim).
  let dualLevel = resolveMapLevel(CRYPT2_ZONE.id, machineZones([CRYPT2_ZONE], 'premium-le'))
  assert(dualLevel === CRYPT2_ZONE.id, 'fixture sanity: selectable under premium-le')
  dualLevel = resolveMapLevel(dualLevel, machineZones([CRYPT2_ZONE], 'pro'))
  assert(dualLevel === CRYPT2_ZONE.id, 'expected a trim-less zone to SURVIVE a trim switch — the reset is conditional on the zone actually disappearing, not unconditional on every MODEL click')

  return "resolveMapLevel: 'main' always valid; a premium-le-only zone resets to MAIN across the owner's exact trim-switch scenario; a trim-less zone survives the same switch unchanged"
})

await test("drawZoneFloor: a LOWER zone draws the sunken treatment (dark fill, dashed [4,4] outline, '· BELOW DECK' label) — direct coverage of this function itself (previously only drawPlayfieldArt's SEPARATE main-view inset-window branch had ever been tested against a lower zone; drawZoneFloor was imported into this suite's bundle but never actually called)", () => {
  const lineDashCalls = []
  const artCtx = makeArtCtx(lineDashCalls)
  const rect = { x: 20, y: 20, w: 300, h: 225 }
  drawZoneFloor(artCtx, rect, CRYPT2_ZONE)
  const hasDashed = lineDashCalls.some((d) => Array.isArray(d) && d.length === 2 && d[0] === 4 && d[1] === 4)
  assert(hasDashed, `expected setLineDash([4,4]) while drawing a lower zone's floor, recorded: ${JSON.stringify(lineDashCalls)}`)
  const resetToSolid = lineDashCalls[lineDashCalls.length - 1]
  assert(Array.isArray(resetToSolid) && resetToSolid.length === 0, 'expected the dash pattern reset back to [] after the outline')
  const sunkenFill = artCtx._calls.find((c) => c.op === 'fill' && c.style === 'rgba(0, 0, 0, 0.30)')
  assert(sunkenFill, 'expected the sunken-zone dark fill')
  const labels = artCtx._calls.filter((c) => c.op === 'fillText').map((c) => c.text)
  assert(labels.some((t) => t.includes('BELOW DECK')), `expected a "BELOW DECK" label, got ${JSON.stringify(labels)}`)
  return `lower-zone floor: dashed outline present (reset to [] after), sunken fill present, label includes "BELOW DECK" — ${JSON.stringify(labels)}`
})

await test("drawZoneFloor: an UPPER (or mini) zone draws the RAISED-plate treatment (light fill, solid outline, plain name) — NOT the lower zone's sunken/dashed/'BELOW DECK' look. THE FIX: this function used to paint the sunken look UNCONDITIONALLY regardless of zone.kind, which was harmless while the LEVEL control only ever offered a single lower zone but became a factual-accuracy bug (a raised deck rendered as sunken) the moment upper/mini zones became selectable", () => {
  for (const zone of [BELFRY_ZONE, { ...BELFRY_ZONE, id: 'z-mini-belfry', kind: 'mini' }]) {
    const lineDashCalls = []
    const artCtx = makeArtCtx(lineDashCalls)
    const rect = { x: 20, y: 20, w: 300, h: 225 }
    drawZoneFloor(artCtx, rect, zone)
    const hasDashed = lineDashCalls.some((d) => Array.isArray(d) && d.length === 2 && d[0] === 4 && d[1] === 4)
    assert(!hasDashed, `expected NO dashed outline for a '${zone.kind}' zone (that is the 'lower'-only treatment), recorded: ${JSON.stringify(lineDashCalls)}`)
    const raisedFill = artCtx._calls.find((c) => c.op === 'fill' && c.style === 'rgba(255, 255, 255, 0.045)')
    assert(raisedFill, `expected the raised-plate fill color for a '${zone.kind}' zone (the SAME color drawPlayfieldArt's own MAIN-view raised branch uses)`)
    const sunkenFill = artCtx._calls.find((c) => c.op === 'fill' && c.style === 'rgba(0, 0, 0, 0.30)')
    assert(!sunkenFill, `expected NO sunken dark fill for a '${zone.kind}' zone`)
    const labels = artCtx._calls.filter((c) => c.op === 'fillText').map((c) => c.text)
    assert(labels.some((t) => t === zone.name.toUpperCase()), `expected the plain zone name label "${zone.name.toUpperCase()}", got ${JSON.stringify(labels)}`)
    assert(!labels.some((t) => t.includes('BELOW DECK')), `expected NO "BELOW DECK" suffix for a '${zone.kind}' zone, got ${JSON.stringify(labels)}`)
  }
  return "upper AND mini zones both draw the raised-plate floor (light fill, solid outline, plain name, no dash) — the kind-hardcode fix covers both raised kinds, not just 'upper'"
})

await test("drawZoneGoalRoute + zoneLocalMap + drawZoneEdgeMarkers: an UPPER zone (BELFRY_ZONE) routes identically to CRYPT2_ZONE's lower one — proves the LEVEL view's render path is truly kind-agnostic (bounds- and .playfield-id-based), not just 'happened to be tested with a lower zone'", () => {
  const g = goal('g-belfry-route', 'combo', ['belfry-entry', 'belfry-target-1', 'belfry-target-2'])
  const rect = { x: 20, y: 20, w: 300, h: 225 }
  const zoneMap = zoneLocalMap(BELFRY_ZONE, rect)
  const zonesById = new Map([[BELFRY_ZONE.id, BELFRY_ZONE]])
  const artCtx = makeArtCtx()
  drawZoneGoalRoute(artCtx, zoneMap, BELFRY_ZONE, zonesById, g, BELFRY_SHOTS, 'premium-le', '#ff9500')

  const entryFeedView = zoneMap(0.38, 0.28)
  const batView = zoneMap(belfryBat.x, belfryBat.y)
  const target1View = zoneMap(belfryTarget1.x, belfryTarget1.y)
  const target2View = zoneMap(belfryTarget2.x, belfryTarget2.y)
  const strokes = artCtx._calls.filter((c) => c.op === 'stroke')

  const legToTarget1 = strokes.find((c) => c.pts.some(([x, y]) => Math.hypot(x - target1View.x, y - target1View.y) < 1e-6))
  assert(legToTarget1, 'expected a stroked leg reaching belfry-target-1')
  assert(
    legToTarget1.pts.some(([x, y]) => Math.hypot(x - entryFeedView.x, y - entryFeedView.y) < 1e-6),
    "expected the leg into the first zone-member step to originate at the entry marker's resolved feed point",
  )
  assert(
    legToTarget1.pts.some(([x, y]) => Math.hypot(x - batView.x, y - batView.y) < 1e-6),
    "expected the leg to route through the UPPER zone's own deck bat, same default anchor a lower zone gets",
  )

  const legToTarget2 = strokes.find((c) => c.pts.some(([x, y]) => Math.hypot(x - target2View.x, y - target2View.y) < 1e-6))
  assert(legToTarget2, 'expected a stroked leg reaching belfry-target-2')
  assert(
    legToTarget2.pts.some(([x, y]) => Math.hypot(x - batView.x, y - batView.y) < 1e-6),
    'expected the chained same-zone leg to ALSO route via the deck bat by default',
  )

  const markerCtx = makeArtCtx()
  drawZoneEdgeMarkers(markerCtx, zoneMap, BELFRY_ZONE, BELFRY_SHOTS, 'premium-le')
  const fills = markerCtx._calls.filter((c) => c.op === 'fill')
  assert(fills.length === 2, `expected exactly 2 marker fills (1 entry + 1 exit) for an upper zone, got ${fills.length}`)

  return `an UPPER zone (BELFRY_ZONE) routes through its own deck bat exactly like CRYPT2_ZONE's lower one (bat at ${batView.x.toFixed(0)},${batView.y.toFixed(0)}); its edge markers also resolve (2 fills) — the render path never special-cased 'lower'`
})

await test('machines with no visible zone under the current trim show NO LEVEL row: machineZones(...).length === 0 for playfields absent/null/empty, AND for a real shipped zone-less machine under both trims', () => {
  assert(machineZones(undefined, 'pro').length === 0, 'undefined playfields')
  assert(machineZones(null, 'pro').length === 0, 'null playfields')
  assert(machineZones([], 'pro').length === 0, 'empty playfields array')
  // Cross-check against a REAL shipped machine with no playfields key at all
  // (section f's own "find one, don't pin a filename" technique — the
  // catalog keeps gaining zones over time as data passes land).
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  const zoneless = files.find((f) => !('playfields' in JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))))
  assert(zoneless, 'fixture sanity: expected at least one real shipped machine with no playfields key')
  const doc = JSON.parse(readFileSync(resolve(dataDir, zoneless), 'utf8'))
  assert(
    machineZones(doc.playfields, 'pro').length === 0 && machineZones(doc.playfields, 'premium-le').length === 0,
    `expected ${zoneless} (no playfields key) to offer zero LEVEL options under either trim`,
  )
  return `machineZones returns [] for absent/null/empty playfields, and for real zone-less ${zoneless} under both trims — refreshLevelControl()'s levelWrap.hidden = zones.length === 0 has nothing to show for any of these`
})

// ---------------------------------------------------------------------------
function close(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`)
}

await rm(tmp, { recursive: true, force: true })
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
