#!/usr/bin/env node
// app/tests/playfield-art.test.mjs — SUITE 12: the per-machine playfield art.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/playfield-art.test.mjs"
//
// WHY THIS SUITE EXISTS. Until 2026-07-31 map2d.ts's drawPlayfieldArt painted
// ONE hardcoded standard-body playfield for all 62 machines: orbit arcs across
// the back, two ramps, a three-bumper nest, upper lane guides, two slingshots,
// flippers, apron — all at fixed coordinates. In a study tool that is a
// FACTUAL defect, not a cosmetic one: it drew an arch across the back of games
// with no orbit and slingshots beside the flippers of games that have none, so
// a player learning a specific machine was shown furniture that isn't there.
// rolo caught it in review.
//
// The art is now DERIVED from each machine's own `shots[]`. That correctness
// property is invisible to `tsc` (it is data-dependent) and invisible to the
// build, and the failure mode is silent — the map just quietly lies. So it is
// pinned here, by rendering against a RECORDING 2D-context stub and asserting
// which shapes actually reach the canvas for machines chosen because their
// data differs.
//
// Pattern follows geometry-chain.test.mjs: esbuild bundles the REAL source
// against a minimal stub, then assertions run on captured draw calls.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, basename } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const dataDir = resolve(repoRoot, 'data')
const srcDir = resolve(__dirname, '../src')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const results = []
let currentSection = ''
function section(name) {
  currentSection = name
  console.log(`\n=== ${name} ===`)
}
function test(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = fn()
    results.push({ name: full, outcome: 'pass' })
    console.log(`  PASS  ${name}${evidence ? `\n          ${evidence}` : ''}`)
  } catch (err) {
    results.push({ name: full, outcome: 'fail' })
    console.log(`  FAIL  ${name}\n          ${err && err.message ? err.message : err}`)
  }
}
function check(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------------------
// Bundle just drawPlayfieldArt. map2d.ts imports './map2d.css' and pulls in
// DOM-touching modules, so re-export through a tiny entry and give esbuild an
// empty loader for CSS.
// ---------------------------------------------------------------------------
const outdir = await mkdtemp(resolve(tmpdir(), 'pg-art-'))
const entry = resolve(outdir, 'entry.ts')
await writeFile(
  entry,
  `export { drawPlayfieldArt, drawShotDots } from ${JSON.stringify(resolve(srcDir, 'overlay/map2d.ts'))}\n` +
    // shotgeom.ts is the pure geometry module ./map2d.ts's lane lines and
    // ./drawing.ts's routing both resolve their shooting flipper through
    // (phase A1, 2026-08-10) — bundled here too (it's DOM-free, no CSS loader
    // needed) so 12d below can pin the art's lane-line origin against the
    // SAME chooseFlipper/FLIPPER_ANCHORS/DEFAULT_LAUNCH_UV the art itself
    // calls, not a hand-mirrored copy that could silently drift out of sync.
    `export { chooseFlipper, FLIPPER_ANCHORS, DEFAULT_LAUNCH_UV } from ${JSON.stringify(resolve(srcDir, 'overlay/shotgeom.ts'))}\n`,
)
const outfile = resolve(outdir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
})
const { drawPlayfieldArt, drawShotDots, chooseFlipper, FLIPPER_ANCHORS, DEFAULT_LAUNCH_UV } = await import(pathToFileURL(outfile).href)

/** Records every path segment and fill/stroke so we can ask "what got drawn?" */
function recordingCtx() {
  const calls = []
  let current = []
  const ctx = {
    _calls: calls,
    lineCap: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '', globalAlpha: 1,
    save() {}, restore() {}, setLineDash() {},
    beginPath() { current = [] },
    moveTo(x, y) { current.push([x, y]) },
    lineTo(x, y) { current.push([x, y]) },
    quadraticCurveTo(cx, cy, x, y) { current.push([cx, cy], [x, y]) },
    arcTo(x1, y1, x2, y2) { current.push([x1, y1], [x2, y2]) },
    closePath() {},
    fillText(text, x, y) { calls.push({ op: 'fillText', text, pts: [[x, y]], style: this.fillStyle }) },
    strokeText(text, x, y) { calls.push({ op: 'strokeText', text, pts: [[x, y]], style: this.strokeStyle }) },
    measureText(text) { return { width: String(text).length * 5 } },
    fillRect(x, y, w, h) { calls.push({ op: 'fillRect', pts: [[x, y], [x + w, y + h]], style: this.fillStyle }) },
    strokeRect(x, y, w, h) { calls.push({ op: 'strokeRect', pts: [[x, y], [x + w, y + h]], style: this.strokeStyle }) },
    translate() {}, rotate() {}, scale() {},
    createLinearGradient() { return { addColorStop() {} } },
    arc(x, y, r) { current.push([x, y]); calls.push({ op: 'arc', pts: [[x, y]], r, fill: this.fillStyle, stroke: this.strokeStyle }) },
    fill() { calls.push({ op: 'fill', pts: current.slice(), style: this.fillStyle }) },
    stroke() { calls.push({ op: 'stroke', pts: current.slice(), style: this.strokeStyle, lineWidth: this.lineWidth }) },
  }
  return ctx
}

// Identity-ish MapFn matching the real one's orientation (v=0 at the bottom).
const W = 400, H = 900
const map = (u, v) => ({ x: u * W, y: H - v * H })

function loadMachine(slug) {
  const file = resolve(dataDir, `${slug.replace(/-/g, '_')}_goals.json`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function render(shots, playfields) {
  const ctx = recordingCtx()
  drawPlayfieldArt(ctx, map, 0, 1, shots, playfields)
  return ctx._calls
}

const has = (shots, re, types) =>
  shots.some((s) => (types && types.includes((s.type || '').toLowerCase())) || re.test((s.name || '').toLowerCase()))

// ---------------------------------------------------------------------------
section('12a. Art is derived from the machine, not hardcoded')

test('two machines with different shot rosters produce different art', () => {
  const a = render(loadMachine('jaws').shots)
  const b = render(loadMachine('gorgar').shots)
  check(a.length !== b.length || JSON.stringify(a) !== JSON.stringify(b),
    'JAWS (2024 Stern, ramps+orbits) and Gorgar (1979 EM-era) rendered IDENTICAL playfield art — ' +
    'the art is not actually machine-derived')
  return `jaws ${a.length} draw calls vs gorgar ${b.length}`
})

test('an empty shot list draws only the unconditional flippers + apron', () => {
  const calls = render([])
  // 2 flippers (fill+stroke each) + 1 apron fill = 5 ops, and NOTHING else.
  const fills = calls.filter((c) => c.op === 'fill')
  const arcs = calls.filter((c) => c.op === 'arc')
  check(arcs.length === 0, `a machine with no shots drew ${arcs.length} circles (bumpers) out of nowhere`)
  check(fills.length <= 3, `expected at most 3 fills (2 flippers + apron), got ${fills.length}`)
  return `${calls.length} draw calls total for an empty roster`
})

section('12b. Features absent from the data are NOT drawn')

test('a machine with no slingshot shots draws no slingshot', () => {
  // Find a real machine whose data has no sling at all.
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  let checked = 0
  for (const f of files) {
    const d = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
    const shots = d.shots || []
    if (has(shots, /sling/, ['slingshot', 'sling'])) continue
    checked++
    const calls = render(shots)
    // The slingshot is the only 3-point filled polygon this renderer makes.
    const triangles = calls.filter((c) => c.op === 'fill' && c.pts.length === 3)
    check(triangles.length === 0,
      `${basename(f)} has no slingshot in its data but ${triangles.length} slingshot triangle(s) were drawn`)
    if (checked >= 12) break
  }
  check(checked > 0, 'no sling-less machine found to test — the assertion never ran')
  return `${checked} sling-less machines drew no slingshots`
})

test('a machine with no bumper shots draws no pop bumpers', () => {
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  let checked = 0
  for (const f of files) {
    const d = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
    const shots = d.shots || []
    if (has(shots, /\bbumper/, ['bumpers', 'bumper'])) continue
    checked++
    const calls = render(shots)
    const arcs = calls.filter((c) => c.op === 'arc')
    check(arcs.length === 0,
      `${basename(f)} has no bumper in its data but ${arcs.length} bumper circle(s) were drawn`)
    if (checked >= 12) break
  }
  check(checked > 0, 'no bumper-less machine found to test — the assertion never ran')
  return `${checked} bumper-less machines drew no bumpers`
})

test('bumper circles land on the REAL bumper coordinates', () => {
  const d = loadMachine('jaws')
  const bumpers = (d.shots || []).filter((s) => has([s], /\bbumper/, ['bumpers', 'bumper']))
  if (!bumpers.length) return 'jaws has no bumpers — skipped'
  const calls = render(d.shots).filter((c) => c.op === 'arc')
  for (const b of bumpers) {
    const want = map(b.x, b.y)
    const hit = calls.some((c) => Math.abs(c.pts[0][0] - want.x) < 1 && Math.abs(c.pts[0][1] - want.y) < 1)
    check(hit, `no bumper circle drawn at ${b.name} (${b.x}, ${b.y}) -> canvas (${want.x.toFixed(1)}, ${want.y.toFixed(1)})`)
  }
  return `${bumpers.length} bumper(s) drawn at their data coordinates`
})

section('12c. The old hardcoded furniture is gone')

const mapSrc = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')

test('no fixed orbit arcs remain (rolo: "there shouldn\'t be an arch in the back")', () => {
  check(!/uvArc\(0\.5, 0\.5, 0\.42, 0\.47/.test(mapSrc),
    'the hardcoded uvArc(0.5,0.5,0.42,0.47) back-arch pair is still being drawn')
  // And prove it behaviourally: a machine with no orbit/loop shot must draw
  // no lane lines at all.
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  let checked = 0
  for (const f of files) {
    const d = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
    const shots = d.shots || []
    if (shots.some((s) => ['ramp', 'orbit', 'loop'].includes((s.type || '').toLowerCase()))) continue
    checked++
    const calls = render(shots)
    const wide = calls.filter((c) => c.op === 'stroke' && c.lineWidth === 11)
    check(wide.length === 0, `${basename(f)} has no ramp/orbit/loop but drew ${wide.length} lane line(s)`)
  }
  return checked > 0 ? `${checked} machine(s) with no ramp/orbit drew no lane lines` : 'source-level assertion only'
})

test('the fixed three-bumper nest coordinates are gone', () => {
  for (const lit of ['[0.42, 0.76]', '[0.52, 0.78]', '[0.47, 0.69]']) {
    check(!mapSrc.includes(lit), `the hardcoded bumper-nest coordinate ${lit} is still in the source`)
  }
})

test('the fixed slingshot polygons are gone', () => {
  check(!/\[0\.16, 0\.2\][\s\S]{0,60}\[0\.3, 0\.11\]/.test(mapSrc),
    'the hardcoded left-slingshot polygon is still in the source')
})

// ===========================================================================
section('12g. The shooter-lane channel is gone — everywhere the art is drawn')
// ===========================================================================
// 2026-08-14, rolo, on the shipped map: "I don't like the tiny ramp on the
// side on playfields that show the plunger ramp. Remove those everywhere."
//
// drawPlayfieldArt used to paint the shooter lane as a narrow darkened strip
// hugging whichever edge the machine's `plunge` shot sat on, from the apron up
// past the plunge, with a hairline outline. This function is the art for the
// Shots map, the Study card, both zone views and every card of the ALL-level
// stack, so deleting it here deletes it on all of them — which is why the
// coverage below is EVERY machine that models a plunge rather than a sample.
//
// WHAT IS NOT BEING REMOVED, and is asserted elsewhere so this cannot quietly
// take it with it: the plunge SHOT (its own insert dot, drawn by drawShotDots),
// drawing.ts's plunge gauge, and plunge-origin goal routes. Only the channel.

test('no machine that models a plunge gets an edge channel drawn for it', () => {
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  let withPlunge = 0
  for (const f of files) {
    const d = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
    const shots = d.shots || []
    if (!has(shots, /shooter|plunger|plunge/, ['plunge'])) continue
    withPlunge++
    const calls = render(shots)
    // GEOMETRY, NOT COLOUR. The old lane was a 4-point polygon spanning 7% of
    // the width at an edge and at least half the height; anything with that
    // shape is the lane back under another fill. (The apron — the one other
    // unconditional 4-point fill — is the full WIDTH of the board and 3.5% of
    // its height, so it can never match.)
    const strips = calls.filter((c) => {
      if (c.op !== 'fill' && c.op !== 'stroke') return false
      if (c.pts.length !== 4) return false
      const xs = c.pts.map((p) => p[0])
      const ys = c.pts.map((p) => p[1])
      const w = Math.max(...xs) - Math.min(...xs)
      const h = Math.max(...ys) - Math.min(...ys)
      const atEdge = Math.min(...xs) <= W * 0.12 || Math.max(...xs) >= W * 0.88
      return w <= W * 0.2 && h >= H * 0.4 && atEdge
    })
    check(
      strips.length === 0,
      `${basename(f)} models a plunge and drew ${strips.length} edge channel(s): ${JSON.stringify(strips.map((s) => s.pts))}`,
    )
  }
  check(withPlunge > 40, `only ${withPlunge} machines with a plunge were checked — the scan is not reading the catalog`)
  return `${withPlunge} plunge-modelling machines drew no shooter lane`
})

test('the lane\'s own constants are out of the source, not merely unreached', () => {
  // The behavioural test above is the real gate; this one stops a future
  // "temporarily commented out" from reading as done. 0.925/0.995 were the
  // lane's inner/outer edges and appear nowhere else in this file.
  check(!/\b0\.925\b/.test(mapSrc), "the lane's inner edge (0.925) is still in map2d.ts")
  check(!/\[outer, 0\.0\]/.test(mapSrc), "the lane's polygon is still in map2d.ts")
  check(!/ART_PLUNGE_TYPES/.test(mapSrc), 'ART_PLUNGE_TYPES survived the removal — nothing else uses it')
  return 'no lane geometry, no lane type-set'
})

section('12d. Ramp lane lines follow the same geometry as the goal route')

test('ramp lane lines start at a flipper and end on the ramp shot', () => {
  const d = loadMachine('jaws')
  const ramps = (d.shots || []).filter((s) => (s.type || '').toLowerCase() === 'ramp')
  check(ramps.length > 0, 'jaws has no ramp shots — cannot test')
  const lanes = render(d.shots).filter((c) => c.op === 'stroke' && c.lineWidth === 11)
  check(lanes.length === ramps.length + (d.shots.filter((s) => ['orbit', 'loop'].includes((s.type || '').toLowerCase())).length),
    `expected one lane line per ramp/orbit/loop shot, got ${lanes.length} lines for ` +
    `${ramps.length} ramps + orbits/loops`)
  for (const r of ramps) {
    const want = map(r.x, r.y)
    const ends = lanes.some((l) => {
      const last = l.pts[l.pts.length - 1]
      return Math.abs(last[0] - want.x) < 1 && Math.abs(last[1] - want.y) < 1
    })
    check(ends, `no lane line ends on ramp "${r.name}" at (${r.x}, ${r.y})`)
  }
  return `${lanes.length} lane lines, each terminating on its real shot`
})

test('ramp lane lines originate at the SAME flipper chooseFlipper would route through', () => {
  // Re-pinned 2026-08-10 (phase A1, shotgeom extraction). Before this phase
  // the art picked its lane-line origin with a naive `shot.x < 0.5` same-side
  // guess, entirely independent of the goal router's chooseFlipper — the test
  // above only ever confirmed a line started at SOME flipper and ended on the
  // right shot, never that it was the flipper the route itself would use.
  // approachLine() (./shotgeom.ts) is now the one function both the art and
  // ./drawing.ts's routing call for this, so this pins the ORIGIN of every
  // real Jaws ramp/orbit/loop lane line against chooseFlipper's own answer —
  // called here directly against the SAME exported chooseFlipper/
  // FLIPPER_ANCHORS/DEFAULT_LAUNCH_UV the bundle's drawPlayfieldArt uses
  // internally (not a hand-mirrored copy that could drift out of sync).
  const d = loadMachine('jaws')
  const laneShots = (d.shots || []).filter(
    (s) =>
      ['ramp', 'orbit', 'loop'].includes((s.type || '').toLowerCase()) &&
      Number.isFinite(s.x) &&
      Number.isFinite(s.y),
  )
  check(laneShots.length > 0, 'jaws has no ramp/orbit/loop shots — cannot test')
  const lanes = render(d.shots).filter((c) => c.op === 'stroke' && c.lineWidth === 11)
  let checked = 0
  for (const shot of laneShots) {
    // Mirrors approachLine()'s own tie-break origin: there is no "previous
    // shot" for standalone background art, so it ties off DEFAULT_LAUNCH_UV
    // exactly like drawGoalOverlay's own step-0 launch does.
    const side = chooseFlipper({ x: shot.x, y: shot.y }, DEFAULT_LAUNCH_UV, null, shot.flipper)
    const want = map(FLIPPER_ANCHORS[side].x, FLIPPER_ANCHORS[side].y)
    const target = map(shot.x, shot.y)
    const lane = lanes.find((l) => {
      const last = l.pts[l.pts.length - 1]
      return Math.abs(last[0] - target.x) < 1 && Math.abs(last[1] - target.y) < 1
    })
    check(lane, `no lane line found ending on "${shot.name}"`)
    const start = lane.pts[0]
    check(
      Math.abs(start[0] - want.x) < 1 && Math.abs(start[1] - want.y) < 1,
      `"${shot.name}" (x=${shot.x}) lane line starts at (${start[0].toFixed(1)}, ${start[1].toFixed(1)}) but ` +
        `chooseFlipper says '${side}' -> (${want.x.toFixed(1)}, ${want.y.toFixed(1)})`,
    )
    checked++
  }
  return `${checked} Jaws lane-typed shot(s) confirmed art origin === chooseFlipper's answer`
})

section('12e. Bugs from rolo\'s 2026-07-31 map screenshot')

test('a "Mini-Flipper Lane" / "Mid-Right Mini Flipper" is NOT treated as a main flipper', () => {
  // The first version tested `/\bflipper\b/` against the name, so JAWS's
  // "Mini-Flipper Lane" (type lane, y=0.33) and "Mid-Right Mini Flipper"
  // (type mech, y=0.30) both matched. With no real "left/right flipper" shot
  // to beat them, the RIGHT flipper resolved a third of the way up the
  // playfield — a red flipper painted mid-map, and every right-side lane line
  // starting from the wrong place.
  const d = loadMachine('jaws')
  const calls = render(d.shots)
  // Flippers are the only shapes filled with the red flipper colour.
  const flippers = calls.filter((c) => c.op === 'fill' && String(c.style).includes('195, 63, 42'))
  const span = (f) => Math.max(...f.pts.map((p) => p[0])) - Math.min(...f.pts.map((p) => p[0]))
  // The MAIN pair must land in the lower part of the canvas (v=0 is the
  // bottom, map() inverts). Since 2026-08-01 upper/mini flipper SHOTS also
  // draw as red bats where the data puts them — so the contract is: exactly
  // two main-sized bats at the bottom, and anything drawn higher must be a
  // SMALLER bat (jaws's Mid-Right Mini Flipper), never a misplaced main.
  const mains = flippers.filter((f) => Math.min(...f.pts.map((p) => p[1])) > H * 0.7)
  check(mains.length === 2, `expected exactly 2 main flippers at the bottom, got ${mains.length}`)
  const mainSpan = Math.max(...mains.map(span))
  for (const f of flippers) {
    if (mains.includes(f)) continue
    check(span(f) < mainSpan * 0.75,
      `a red bat above the main flippers spans ${span(f).toFixed(1)}px vs main ${mainSpan.toFixed(1)}px — ` +
      'an upper/mini flipper must draw smaller than a main flipper')
  }
  return `2 mains below y=${(H * 0.7).toFixed(0)}, ${flippers.length - 2} smaller bat(s) above`
})

section('12f. Upper & mini flippers render as bats (rolo 2026-08-01)')

test('Twilight Zone draws its two upper flippers as bats above the main pair', () => {
  const calls = render(loadMachine('twilight-zone').shots)
  const flippers = calls.filter((c) => c.op === 'fill' && String(c.style).includes('195, 63, 42'))
  const mains = flippers.filter((f) => Math.min(...f.pts.map((p) => p[1])) > H * 0.7)
  check(mains.length === 2, `expected 2 mains, got ${mains.length}`)
  const uppers = flippers.filter((f) => !mains.includes(f))
  check(uppers.length === 2,
    `TZ has upper-left + upper-right flipper shots; expected 2 upper bats, got ${uppers.length}`)
  return `4 bats total (2 mains + 2 uppers)`
})

test('mini-playfield flippers (Family Guy Stewie pair) draw at reduced size — via the ZONE path since P2 authored its deck', () => {
  // Premise updated 2026-08-11: the P2 apply gave family_guy a real
  // stewie-mini-deck zone whose flipper shots carry `playfield` refs, which
  // (per A4) EXCLUDES them from the name-regex extras loop and draws them as
  // deck bats in the zone-plate block instead. Same bats, truer path — the
  // machine graduated from the fallback. playfields must be passed, as the
  // real map2d render() does.
  const fg = loadMachine('family-guy')
  const calls = render(fg.shots, fg.playfields)
  const flippers = calls.filter((c) => c.op === 'fill' && String(c.style).includes('195, 63, 42'))
  const span = (f) => Math.max(...f.pts.map((p) => p[0])) - Math.min(...f.pts.map((p) => p[0]))
  const mains = flippers.filter((f) => Math.min(...f.pts.map((p) => p[1])) > H * 0.7)
  const minis = flippers.filter((f) => !mains.includes(f))
  check(minis.length >= 2, `expected the Stewie mini bats via the zone path, got ${minis.length}`)
  const mainSpan = Math.max(...mains.map(span))
  for (const m of minis) {
    check(span(m) < mainSpan * 0.6,
      `mini bat spans ${span(m).toFixed(1)}px vs main ${mainSpan.toFixed(1)}px — minis draw at half reach`)
  }
  return `${minis.length} mini bats via zone path, span ${Math.max(...minis.map(span)).toFixed(1)}px vs main ${mainSpan.toFixed(1)}px`
})

test('name-regex fallback still draws mini bats for an UNAUTHORED machine (no playfields data)', () => {
  // The regex fallback (mini|stewie|donkey|... names) must survive for the
  // machines no data pass has reached — synthetic fixture with no zones.
  const shots = [
    { id: 'left-flipper', name: 'Left Flipper', type: 'flipper', x: 0.33, y: 0.05, trim: 'all' },
    { id: 'right-flipper', name: 'Right Flipper', type: 'flipper', x: 0.67, y: 0.05, trim: 'all' },
    { id: 'mini-flipper', name: 'Mini Flipper', type: 'flipper', x: 0.75, y: 0.55, trim: 'all' },
  ]
  const calls = render(shots)
  const flippers = calls.filter((c) => c.op === 'fill' && String(c.style).includes('195, 63, 42'))
  const mains = flippers.filter((f) => Math.min(...f.pts.map((p) => p[1])) > H * 0.7)
  const minis = flippers.filter((f) => !mains.includes(f))
  check(minis.length === 1, `expected 1 regex-fallback mini bat, got ${minis.length}`)
  return 'regex fallback intact for unauthored machines'
})

test('facing pairs of upper/mini bats never overlap, on any machine', () => {
  // rolo (2026-08-01, second screenshot): the Stewie pair drew a bowtie —
  // the same defect the MAIN pair was cured of on 07-31, because the extras
  // pass had no tip-gap clamp. Checked across every machine: any two red bats
  // above the main band that sit at ~the same height with the left-pivoted one
  // left of the right-pivoted one must leave a horizontal gap between them.
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  let pairs = 0
  for (const f of files) {
    const shots = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')).shots || []
    const bats = render(shots)
      .filter((c) => c.op === 'fill' && String(c.style).includes('195, 63, 42'))
      .filter((b) => Math.min(...b.pts.map((p) => p[1])) <= H * 0.7)
    for (let i = 0; i < bats.length; i++) {
      for (let j = i + 1; j < bats.length; j++) {
        const [a, b] = [bats[i], bats[j]]
        const ay = Math.min(...a.pts.map((p) => p[1]))
        const by = Math.min(...b.pts.map((p) => p[1]))
        if (Math.abs(ay - by) > H * 0.06) continue
        const [l, r] =
          Math.min(...a.pts.map((p) => p[0])) < Math.min(...b.pts.map((p) => p[0])) ? [a, b] : [b, a]
        const gap = Math.min(...r.pts.map((p) => p[0])) - Math.max(...l.pts.map((p) => p[0]))
        pairs++
        check(gap > 0,
          `${f}: two upper/mini bats at the same height OVERLAP by ${(-gap).toFixed(1)}px`)
      }
    }
  }
  return `${pairs} same-height upper/mini bat pairs checked, all with a positive gap`
})

test('mini-flipper shots do not become lane-line origins', () => {
  const d = loadMachine('jaws')
  const lanes = render(d.shots).filter((c) => c.op === 'stroke' && c.lineWidth === 11)
  for (const l of lanes) {
    const start = l.pts[0]
    check(start[1] > H * 0.7,
      `a lane line starts at canvas y=${start[1].toFixed(0)} — lane lines must start at a ` +
      `main flipper (lower playfield), not at a mid-playfield mini flipper`)
  }
  return `${lanes.length} lane lines all start at the flippers`
})

test('bumper circles stay bumper-sized at any canvas width', () => {
  // Was 0.05 * playfield width, un-clamped: ~24px on a phone next to 3.5px
  // shot dots, which read as a rendering artifact rather than a pop bumper.
  const d = loadMachine('jaws')
  for (const width of [320, 400, 900, 1600]) {
    const wideMap = (u, v) => ({ x: u * width, y: H - v * H })
    const ctx = recordingCtx()
    drawPlayfieldArt(ctx, wideMap, 0, 1, d.shots)
    const arcs = ctx._calls.filter((c) => c.op === 'arc')
    for (const a of arcs) {
      check(a.r <= 9.001, `bumper radius ${a.r.toFixed(1)}px at canvas width ${width} — too large (cap is 9)`)
      check(a.r >= 1, `bumper radius ${a.r.toFixed(1)}px at canvas width ${width} — degenerate`)
    }
  }
  return 'radius clamped to <=9px across 320..1600px canvases'
})

test('the Map tab hides its step walker for a pathless goal (no "SHOT 1 OF 0")', () => {
  // A 'secret'/'progression' goal can be selected on the Goals tab and the
  // selection carries when the user switches to Map. Excluding them from
  // THIS tab's picker was not enough — rolo's screenshot showed the stepper
  // reading "SHOT 1 OF 0" with a ‹ › bar stepping through nothing.
  const src = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
  check(/controls\.hidden = !goal \|\| isPathless\(goal\)/.test(src),
    'map2d.ts still shows the step controls for a pathless goal — the readout would say "SHOT 1 OF 0"')
  check(/if \(!goal \|\| isPathless\(goal\)\) return/.test(src),
    'updateControls does not bail out for a pathless goal, so it would still write the readout text')
})

test('the two flippers never overlap — there is always a drain gap between the tips', () => {
  // rolo's 2026-07-31 screenshot: the pair drew a BOWTIE. Pivots were 0.4/0.6
  // with a 0.13 reach, so the left tip landed at 0.53 and the right at 0.47 and
  // they crossed through each other by 0.06. Checked across every real machine
  // (their own flipper shots can move the pivots) plus the no-data default.
  const cases = [['<defaults>', []], ...readdirSync(dataDir)
    .filter((f) => f.endsWith('_goals.json'))
    .map((f) => [basename(f), JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')).shots || []])]
  for (const [label, shots] of cases) {
    // Only the MAIN pair participates in the drain-gap contract; upper/mini
    // bats (drawn since 2026-08-01) sit higher and may legitimately be
    // anywhere. Mains are the red fills in the bottom band of the canvas.
    const flippers = render(shots)
      .filter((c) => c.op === 'fill' && String(c.style).includes('195, 63, 42'))
      .filter((f) => Math.min(...f.pts.map((p) => p[1])) > H * 0.7)
    if (flippers.length !== 2) {
      check(false, `${label}: expected 2 main flippers, got ${flippers.length}`)
      continue
    }
    const spans = flippers
      .map((f) => ({ min: Math.min(...f.pts.map((p) => p[0])), max: Math.max(...f.pts.map((p) => p[0])) }))
      .sort((a, b) => a.min - b.min)
    const gapPx = spans[1].min - spans[0].max
    check(gapPx > 0,
      `${label}: the flippers OVERLAP by ${(-gapPx).toFixed(1)}px — they are drawn on top of each ` +
      `other instead of leaving a drain gap (left spans ${spans[0].min.toFixed(0)}..${spans[0].max.toFixed(0)}, ` +
      `right ${spans[1].min.toFixed(0)}..${spans[1].max.toFixed(0)})`)
  }
  return `${cases.length} configurations, all with a positive tip gap`
})

// ===========================================================================
section('12h. Raise/lower ramp plates (Shot.flap, 2026-08-15)')
// ===========================================================================
// rolo, on the shipped Stranger Things map: "in the middle theres a huge drop
// down ramp that gets activated, the playfield should show that." The centre
// ramp swings in front of the Demogorgon and decides what a centre shot does,
// and the insert vocabulary could only offer it one ~7px arrow — so the map
// showed nothing where the machine's biggest feature is. `Shot.flap` (w/h in
// UV, centred on the shot) is that mech's FOOTPRINT, and this section pins the
// two things that make it honest: the plate is drawn at exactly the authored
// rectangle, and a machine that authors none renders byte-identical to before
// the field existed.

/** The flap plate's own fill/lip colours — the signal that a plate reached the
 *  canvas at all. Both are unique to this shape in drawPlayfieldArt. */
const FLAP_FILL = '255, 255, 255, 0.065'
const FLAP_LIP = '150, 200, 255, 0.55'
const plateFills = (calls) => calls.filter((c) => c.op === 'fill' && String(c.style).includes(FLAP_FILL))
const lipStrokes = (calls) => calls.filter((c) => c.op === 'stroke' && String(c.style).includes(FLAP_LIP))
/** Same shots with every `flap` removed — the "before this field existed"
 *  version of a machine, for the additive-only proofs below. */
const stripFlaps = (shots) => shots.map(({ flap, ...rest }) => rest)

test("Stranger Things' centre ramp draws its plate at the AUTHORED footprint", () => {
  const shots = loadMachine('stranger-things').shots
  const ramp = shots.find((s) => s.flap)
  check(ramp, 'stranger_things_goals.json has no shot with a `flap` — fixture gone, this section is testing nothing')
  const plates = plateFills(render(shots))
  check(plates.length === 1, `expected exactly 1 flap plate, got ${plates.length}`)
  const [x0, x1] = [ramp.x - ramp.flap.w / 2, ramp.x + ramp.flap.w / 2]
  const [y0, y1] = [ramp.y - ramp.flap.h / 2, ramp.y + ramp.flap.h / 2]
  const want = [map(x0, y0), map(x1, y0), map(x1, y1), map(x0, y1)].map((p) => [p.x, p.y])
  const got = plates[0].pts
  check(got.length === 4, `expected a 4-corner plate, got ${got.length} points`)
  for (let i = 0; i < 4; i++) {
    check(Math.abs(got[i][0] - want[i][0]) < 1e-6 && Math.abs(got[i][1] - want[i][1]) < 1e-6,
      `plate corner ${i} drew at (${got[i]}) but the authored footprint puts it at (${want[i]})`)
  }
  return `${ramp.id}: w=${ramp.flap.w} h=${ramp.flap.h} -> plate ${x0.toFixed(3)}..${x1.toFixed(3)} x ${y0.toFixed(3)}..${y1.toFixed(3)} UV, corner-exact`
})

test('the bright accent sits on the LOW-v LIP (the edge facing the flippers), not the far edge', () => {
  const shots = loadMachine('stranger-things').shots
  const ramp = shots.find((s) => s.flap)
  const lips = lipStrokes(render(shots))
  check(lips.length === 1, `expected exactly 1 lip stroke, got ${lips.length}`)
  const lipY = lips[0].pts.map((p) => p[1])
  const wantY = map(ramp.x, ramp.y - ramp.flap.h / 2).y
  const farY = map(ramp.x, ramp.y + ramp.flap.h / 2).y
  check(lipY.every((y) => Math.abs(y - wantY) < 1e-6),
    `the accent drew at y=${lipY} — the low-v lip is y=${wantY}, the far edge y=${farY}. ` +
    'Marking the far edge would point the player at the wrong side of the mech.')
  check(Math.abs(wantY - farY) > 1, 'fixture sanity: the two edges must be visibly apart for this assertion to mean anything')
  return `lip at canvas y=${wantY.toFixed(1)} (far edge ${farY.toFixed(1)}), width ${Math.abs(lips[0].pts[1][0] - lips[0].pts[0][0]).toFixed(1)}px`
})

test('the plate is drawn UNDER the same ramp lane line, not over it', () => {
  const calls = render(loadMachine('stranger-things').shots)
  const plateAt = calls.findIndex((c) => c.op === 'fill' && String(c.style).includes(FLAP_FILL))
  const laneAt = calls.findIndex((c) => c.op === 'stroke' && String(c.style).includes('110, 185, 255, 0.075'))
  check(plateAt >= 0 && laneAt >= 0, `fixture: plate at ${plateAt}, first lane-line underlay at ${laneAt}`)
  check(plateAt < laneAt, `the plate (call ${plateAt}) drew AFTER the lane lines (call ${laneAt}) — the ball path belongs on top of the ramp surface`)
  return `plate call #${plateAt} precedes lane-line call #${laneAt}`
})

test('removing `flap` removes the plate and NOTHING else (additive-only)', () => {
  const shots = loadMachine('stranger-things').shots
  const withFlap = render(shots)
  const without = render(stripFlaps(shots))
  const at = withFlap.findIndex((c) => c.op === 'fill' && String(c.style).includes(FLAP_FILL))
  check(at >= 0, 'fixture: no plate fill found in the with-flap render')
  // The plate is exactly three consecutive ops: fill (body), stroke (outline),
  // stroke (lip). Cut those and the rest must match the no-flap render.
  const plateOps = withFlap.slice(at, at + 3)
  check(plateOps[0].op === 'fill' && plateOps[1].op === 'stroke' && plateOps[2].op === 'stroke'
    && String(plateOps[2].style).includes(FLAP_LIP),
    `expected fill+stroke+lip at ${at}, got ${plateOps.map((c) => `${c.op}(${c.style})`).join(', ')}`)
  check(plateFills(without).length === 0 && lipStrokes(without).length === 0,
    'stripping `flap` still drew a plate — the plate is not actually gated on the authored field')
  // `arc` records the stub's CURRENT fillStyle, which nothing has painted with
  // yet (disc() sets its own colour before its fill()); the plate leaves that
  // property holding its own colour, so the recorded-but-unpainted field
  // differs while the pixels do not. Compared without it.
  const shape = (list) => JSON.stringify(list.map((c) => (c.op === 'arc' ? { ...c, fill: undefined } : c)))
  const rest = withFlap.filter((_, i) => i < at || i >= at + 3)
  check(shape(rest) === shape(without),
    `with the plate's 3 ops removed, the remaining ${rest.length} draw calls must match the no-flap render (${without.length} calls) — ` +
    'the flap must not perturb any other shape')
  return `${withFlap.length} calls with the flap, ${without.length} without; the ${withFlap.length - without.length} extra are exactly the plate`
})

test('no machine WITHOUT an authored flap draws a plate', () => {
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  let authored = 0
  let checked = 0
  for (const f of files) {
    const d = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
    const shots = d.shots || []
    const flaps = shots.filter((s) => s.flap).length
    const plates = plateFills(render(shots)).length
    if (flaps) authored++
    else checked++
    check(plates === flaps,
      `${basename(f)} authors ${flaps} flap(s) but ${plates} plate(s) were drawn`)
  }
  check(checked > 0, 'no flap-less machine found — the assertion never ran')
  return `${checked} machines with no flap drew 0 plates; ${authored} machine(s) authoring one drew exactly one each`
})

test('a flap shot does not spend one of the eight ambient label slots', () => {
  const shots = loadMachine('stranger-things').shots
  const ramp = shots.find((s) => s.flap)
  const labels = (list) => {
    const ctx = recordingCtx()
    drawShotDots(ctx, list, map, {})
    return ctx._calls.filter((c) => c.op === 'fillText').map((c) => c.text)
  }
  const withFlap = labels(shots)
  const without = labels(stripFlaps(shots))
  const NAME = ramp.name.toUpperCase()
  check(!withFlap.includes(NAME),
    `${NAME} printed an ambient label as well as its plate — the name would be drawn twice`)
  check(without.includes(NAME),
    'fixture sanity: with `flap` stripped the same shot DOES take an ambient label, so the filter is what removes it')
  const lost = without.filter((l) => l !== NAME && !withFlap.includes(l))
  check(lost.length === 0,
    `authoring a flap silently dropped other machines' labels from the map: ${lost.join(', ')}`)
  return `flap authored -> ${withFlap.length} ambient labels (no ${NAME}); flap stripped -> ${without.length} (${NAME} takes a slot and pushes ${without.length === withFlap.length ? 'one out' : 'the list around'})`
})

test('every machine renders without throwing', () => {
  const files = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
  for (const f of files) {
    const d = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
    try {
      render(d.shots || [])
    } catch (err) {
      check(false, `${basename(f)} threw while rendering playfield art: ${err && err.message}`)
    }
  }
  return `${files.length} machines rendered clean`
})

await rm(outdir, { recursive: true, force: true })

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed) {
  console.log('\nFAILED:')
  for (const r of results.filter((x) => x.outcome === 'fail')) console.log(`  - ${r.name}`)
  process.exit(1)
}
