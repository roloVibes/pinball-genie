#!/usr/bin/env node
// app/tests/pathless-goals.test.mjs — SUITE 11: 'secret' / 'progression'
// goals that have NO playfield route.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/pathless-goals.test.mjs"
//
// WHY THIS SUITE EXISTS. Until 2026-07-31 every goal in this app was a
// sequence of shots, and `steps` did double duty: it was both "what the player
// does" and "what the Map tab draws". The 'secret' and 'progression' categories
// broke that equivalence — "hold both flippers while the machine sits in
// attract mode" is a real, teachable thing with no shot anywhere in it.
//
// The data for those goals arrives from a research pipeline in a DIFFERENT
// SHAPE from the app's model, and the three mismatches all fail SILENTLY
// rather than loudly:
//
//   * `difficulty` is "easy"/"medium"/"hard" in research output but 1..3 in the
//     app. clampDifficulty() runs Math.round() on it — a string yields NaN and
//     every difficulty pip renders as nothing, with no error in the console.
//   * `steps` is a list of STRINGS in research output but a list of OBJECTS
//     ({shot, action, detail}) in the app, where `shot` must resolve against
//     that machine's `shots` array. Prose in that slot leaves every step
//     pointing at a shot that does not exist.
//   * A pathless goal offered in the Map tab's picker would select a goal the
//     canvas cannot draw — a blank playfield and a "SHOT 1 OF 0" readout.
//     (P7b, 2026-08-14: that picker lists pathless goals again — the row is
//     there, it says it has no map route, and tapping it opens the Goals tab's
//     instructions instead of selecting anything. The hazard above is why the
//     tap must not select; 11c below pins both halves.)
//
// None of those is caught by `tsc` (the data is JSON, typed only by assertion)
// and none is caught by the build. So they are caught here, against the REAL
// shipped data files and the REAL source.
//
// Pattern follows guide-pages.test.mjs (reads the real data) plus
// signup-gate.test.mjs (asserts source-level wiring that lives in app.ts).

import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

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
// Load every shipped machine dataset
// ---------------------------------------------------------------------------
const goalFiles = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
const machines = goalFiles.map((f) => ({
  file: f,
  slug: basename(f, '_goals.json').replace(/_/g, '-'),
  data: JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')),
}))
const allGoals = machines.flatMap((m) => (m.data.goals || []).map((g) => ({ ...g, __file: m.file })))
const pathless = allGoals.filter((g) => Array.isArray(g.steps) && g.steps.length === 0)
const routed = allGoals.filter((g) => Array.isArray(g.steps) && g.steps.length > 0)

const NEW_CATEGORIES = new Set(['secret', 'progression'])

section('11a. Shipped data conforms to the pathless-goal contract')

test('the dataset actually contains pathless goals (otherwise this suite proves nothing)', () => {
  check(pathless.length > 0, 'no pathless goals found in data/ — merge step did not run?')
  return `${pathless.length} pathless goals across ${goalFiles.length} machines`
})

test('every pathless goal carries non-empty instructions', () => {
  const bad = pathless.filter((g) => !Array.isArray(g.instructions) || g.instructions.length === 0)
  check(bad.length === 0,
    `${bad.length} pathless goal(s) with no instructions — they would render an empty list: ` +
    bad.slice(0, 5).map((g) => `${g.__file}:${g.id}`).join(', '))
  return `all ${pathless.length} have instructions`
})

test('every pathless instruction is a non-empty string', () => {
  for (const g of pathless) {
    for (const [i, line] of g.instructions.entries()) {
      check(typeof line === 'string' && line.trim().length > 0,
        `${g.__file}:${g.id} instruction ${i + 1} is not a non-empty string (${JSON.stringify(line)})`)
    }
  }
})

test('difficulty is a NUMBER 1..3 on every goal — never a research-shape string', () => {
  const bad = allGoals.filter((g) => !Number.isInteger(g.difficulty) || g.difficulty < 1 || g.difficulty > 3)
  check(bad.length === 0,
    `${bad.length} goal(s) with a non-1..3 difficulty — clampDifficulty() would produce NaN pips: ` +
    bad.slice(0, 5).map((g) => `${g.__file}:${g.id}=${JSON.stringify(g.difficulty)}`).join(', '))
  return `all ${allGoals.length} goals have integer difficulty 1..3`
})

test('a ROUTED goal never carries instructions (the two shapes stay mutually exclusive)', () => {
  const bad = routed.filter((g) => g.instructions != null)
  check(bad.length === 0,
    `${bad.length} routed goal(s) also carry instructions — isPathless() keys off steps.length, so ` +
    `these would silently render the step walker and drop the prose: ` +
    bad.slice(0, 5).map((g) => `${g.__file}:${g.id}`).join(', '))
})

test('every routed step still resolves to a real shot id on its own machine', () => {
  // Guards the inverse mistake: prose merged into `steps` instead of
  // `instructions` would dangle here.
  const failures = []
  for (const m of machines) {
    const shotIds = new Set((m.data.shots || []).map((s) => s.id))
    for (const g of m.data.goals || []) {
      for (const [i, step] of (g.steps || []).entries()) {
        if (typeof step !== 'object' || step === null) {
          failures.push(`${m.file}:${g.id} step ${i + 1} is not an object (${typeof step})`)
          continue
        }
        if (!shotIds.has(step.shot)) failures.push(`${m.file}:${g.id} step ${i + 1} -> unknown shot "${step.shot}"`)
      }
    }
  }
  check(failures.length === 0, `${failures.length} dangling step(s):\n          ` + failures.slice(0, 8).join('\n          '))
  return `all steps across ${machines.length} machines resolve`
})

test('goal ids are unique within each machine', () => {
  for (const m of machines) {
    const ids = (m.data.goals || []).map((g) => g.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    check(dupes.length === 0, `${m.file} has duplicate goal ids: ${[...new Set(dupes)].join(', ')}`)
  }
})

section('11b. New categories are fully plumbed (a missing entry is a runtime crash)')

const goalMetaSrc = readFileSync(resolve(srcDir, 'ui/goalMeta.ts'), 'utf8')
const modelsSrc = readFileSync(resolve(srcDir, 'models.ts'), 'utf8')
// (overlay/drawing.ts and styles.css were read here for the colour-parity test
// that moved to tokens.test.mjs — see the note further down. No longer needed.)

const usedCategories = [...new Set(allGoals.map((g) => g.category))]

test('every category present in the data is declared in the GoalCategory union', () => {
  for (const cat of usedCategories) {
    check(new RegExp(`'${cat}'`).test(modelsSrc), `models.ts GoalCategory is missing '${cat}'`)
  }
  return usedCategories.join(', ')
})

test('every category present in the data appears in CATEGORY_ORDER and CATEGORY_META', () => {
  for (const cat of usedCategories) {
    // CATEGORY_META is Record<GoalCategory,...> so tsc enforces it, but the
    // ORDER array is a plain list — a category missing from it renders NOWHERE
    // in the Goals tab, silently, with no type error.
    check(new RegExp(`^\\s*'${cat}',`, 'm').test(goalMetaSrc), `CATEGORY_ORDER is missing '${cat}' — goals in it would never render`)
    check(new RegExp(`\\b${cat}:\\s*\\{\\s*label:`).test(goalMetaSrc), `CATEGORY_META is missing '${cat}'`)
  }
})

// MOVED 2026-08-14 -> app/tests/tokens.test.mjs. A test here ('every category
// has BOTH a --cat-* CSS var and a matching canvas hex') used to compare
// styles.css's --cat-* values against overlay/drawing.ts's CATEGORY_COLOR.
// That is a palette question, not a pathless-goals question, and it is now one
// of several in tokens.test.mjs (which also gates src/theme.ts's canvas-surface
// mirror) — one home for the whole gate rather than the colour half living
// here by historical accident. The replacement is STRICTLY STRONGER: it walks
// both tables and requires them to be the same SET, so a category defined in
// both files but not yet used by any shipped machine is compared too, which
// the `usedCategories` loop below could never reach.
//
// What stays here is the part that is genuinely about the data: every category
// the shipped datasets USE must exist in the GoalCategory union and in
// CATEGORY_ORDER/CATEGORY_META (above). That plus tsc's
// Record<GoalCategory, string> on CATEGORY_COLOR keeps the chain
// data -> union -> canvas table -> CSS var unbroken across the two suites.

section('11c. Source wiring: pathless goals bypass the walker, and the Map picker LISTS them (P7b)')

const appSrc = readFileSync(resolve(srcDir, 'app.ts'), 'utf8')
const mapSrc = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')

test('isPathless/instructionsFor are exported from ui/goalMeta.ts (the single predicate)', () => {
  check(/export function isPathless\(/.test(goalMetaSrc), 'goalMeta.ts does not export isPathless')
  check(/export function instructionsFor\(/.test(goalMetaSrc), 'goalMeta.ts does not export instructionsFor')
  check(/steps\.length === 0/.test(goalMetaSrc), 'isPathless should key off steps.length — see models.ts Goal.instructions')
})

test('app.ts renders instructions and returns BEFORE building the step walker', () => {
  check(/import \{[\s\S]*?isPathless[\s\S]*?\} from '\.\/ui\/goalMeta'/.test(appSrc),
    'app.ts does not import isPathless (a missing import builds fine and throws at runtime — this exact ' +
    'bug was caught by tsc on 2026-07-31, and the Vite build succeeded anyway)')
  const guardIdx = appSrc.indexOf('if (isPathless(goal))')
  check(guardIdx > -1, 'app.ts has no isPathless(goal) branch in the goal detail view')
  const walkerIdx = appSrc.indexOf("stepsWrap.className = 'goal-steps'")
  check(walkerIdx > -1, 'could not locate the step walker in app.ts')
  check(guardIdx < walkerIdx,
    'the pathless branch must come BEFORE the step walker, and must return — otherwise a pathless ' +
    'goal renders "STEP 1 OF 0" and a ✓ button that is both first and last')
  const between = appSrc.slice(guardIdx, walkerIdx)
  check(/return wrap/.test(between), 'the pathless branch does not return — it would fall through into the walker')
})

// REVERSED 2026-08-14 (P7b). This test used to require the opposite:
// `.filter((g) => !isPathless(g))` in map2d.ts, i.e. pathless goals dropped
// from the Map tab's picker outright. That filter fixed a real bug (picking one
// drew a blank playfield with a "SHOT 1 OF 0" readout) by creating a quieter
// one — the same machine's goal list differed between the two tabs, with
// nothing on screen accounting for the difference, and the sheet's own
// "N LOADED" header counted goals it then refused to draw. The row is listed
// now and says what it is: no map route, tap to read the instructions on the
// Goals tab. The ORIGINAL bug stays fixed by the tap going somewhere real
// rather than by the row being deleted — and this test now fails if the filter
// comes back.
test('map2d.ts LISTS pathless goals in the goal picker (no silent filter) and sends the tap to the Goals tab', () => {
  check(/import \{[\s\S]*?isPathless[\s\S]*?\} from '\.\.\/ui\/goalMeta'/.test(mapSrc),
    'map2d.ts does not import isPathless')
  check(!/\.filter\(\(g\) => !isPathless\(g\)\)/.test(mapSrc),
    'map2d.ts is filtering pathless goals out of the goal picker again — P7b lists them instead, disabled or ' +
    'deep-linked, so the Map and Goals tabs show the same machine the same way')
  check(/jumpToGoalDetail/.test(mapSrc),
    'map2d.ts has no jumpToGoalDetail wiring — a listed pathless row with nowhere to go is a dead affordance')
  check(/isPathless\(g\)/.test(mapSrc),
    'map2d.ts no longer branches on isPathless when building a row — a pathless goal would render "0 steps" ' +
    'and a route the canvas cannot draw')
})

test('app.ts hands the map that jump, and switches tab BEFORE selecting', () => {
  // The order is load-bearing: the 'goals' tab handler calls
  // state.clearSelection(), so selecting first would land on the goal LIST
  // with the selection wiped instead of on the detail screen.
  const fn = appSrc.match(/function jumpToGoalDetail\(goal: Goal\): void \{([\s\S]*?)\n  \}/)
  check(fn, 'app.ts has no jumpToGoalDetail(goal) function for the map to call')
  const selectTabIdx = fn[1].indexOf("tabBar.select('goals')")
  const selectGoalIdx = fn[1].indexOf('state.select(goal)')
  check(selectTabIdx > -1, 'jumpToGoalDetail does not switch to the Goals tab')
  check(selectGoalIdx > -1, 'jumpToGoalDetail does not select the goal')
  check(selectTabIdx < selectGoalIdx,
    'jumpToGoalDetail selects the goal BEFORE switching tabs — the tab handler clears the selection, so the ' +
    'detail screen would flash and vanish')
  // POSITION, not mere presence: jumpToGoalDetail has to be the THIRD
  // argument. The trailing `(?:, ...)?` is deliberate — mountMap2D's optional
  // tail grows (P9 added a fourth, the spoken-readout writer), and a gate that
  // pins the whole call would fail on every future addition while proving
  // nothing more than this does.
  check(/mountMap2D\(mapPanel, state, jumpToGoalDetail(?:,[^)]*)?\)/.test(appSrc),
    'app.ts does not pass jumpToGoalDetail into mountMap2D as its third argument — the sheet would render ' +
    'pathless rows disabled')
})

section('11d. Player-facing copy is clean')

// `the community` used to be a bare alternative here, which made this check fire
// on Monopoly's "the Community Chest light" — a FEATURE NAME on the machine, not
// sourcing voice (2026-08-01). The term this is actually hunting is the pinball
// community as an authority ("the community considers this the best opener"), so
// require a reporting verb after it. Same reasoning would apply to any other
// alternative that is also a legitimate playfield noun.
const PROVENANCE = /according to|sources? say|the community (?:says|reports|believes|agrees|considers|thinks|regards|rates)|reportedly|it is said|rulesheet|tiltforums|pinside|\battributed to\b|\bapparently\b|players report|is believed|\bsupposedly\b/i

test('no research/provenance voice in any pathless goal copy', () => {
  for (const g of pathless) {
    for (const [field, text] of [['title', g.title], ['summary', g.summary], ['reward', g.reward || '']]) {
      const hit = text.match(PROVENANCE)
      check(!hit, `${g.__file}:${g.id} ${field} contains research voice: "${hit && hit[0]}"`)
    }
    for (const [i, line] of g.instructions.entries()) {
      const hit = line.match(PROVENANCE)
      check(!hit, `${g.__file}:${g.id} instruction ${i + 1} contains research voice: "${hit && hit[0]}"`)
    }
  }
  return `${pathless.length} goals clean`
})

test('every pathless goal has a title and a summary', () => {
  for (const g of pathless) {
    check(typeof g.title === 'string' && g.title.trim(), `${g.__file}:${g.id} has no title`)
    check(typeof g.summary === 'string' && g.summary.trim(), `${g.__file}:${g.id} has no summary`)
    check(NEW_CATEGORIES.has(g.category),
      `${g.__file}:${g.id} is pathless but category is '${g.category}' — only ${[...NEW_CATEGORIES].join('/')} should be pathless`)
  }
})

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed) {
  console.log('\nFAILED:')
  for (const r of results.filter((x) => x.outcome === 'fail')) console.log(`  - ${r.name}`)
  process.exit(1)
}
