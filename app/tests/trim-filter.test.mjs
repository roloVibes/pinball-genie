#!/usr/bin/env node
// app/tests/trim-filter.test.mjs — SUITE 15: the Pro/Premium-LE MODEL
// selector (phase A3, 2026-08-10).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/trim-filter.test.mjs"
// or from app/:
//   node tests/trim-filter.test.mjs
//
// WHAT THIS SUITE COVERS. Dataset schema v5 has always distinguished base-Pro
// shots from premium-le-only content (Shot.trim, models.ts) — 23 machines /
// 65 shots as of this writing, Jaws' three Orca-deck shots among them — but
// nothing read it until this phase: every player, regardless of which
// physical machine they stood at, saw the union of both models' shots. This
// phase adds the actual selector (state.trim/setTrim), the predicates that
// decide what it hides (shotgeom.ts's isShotVisible/feedForTrim, already
// landed but unwired; ui/goalMeta.ts's machineHasVariants/goalVisibleForTrim/
// goalReferencesPremiumLe; overlay/map2d.ts's visibleShotsForTrim), and wires
// them into the Map tab's render + goal picker, the Goals tab's PREM/LE chip,
// and ui/machinecard.ts's per-model entry filtering.
//
//   a. isShotVisible — truth table incl. null/undefined/''/'all'/'pro'/
//      'premium-le'.
//   b. machineHasVariants — real Jaws (true) vs real Gorgar, a trim-free
//      machine (false), plus a synthetic playfields[]-only case and the
//      defensive null/undefined case.
//   c. Jaws' three Orca-deck shots (lookout-tower-ramp/ship-wheel-spinner/
//      radio-target) are excluded under 'pro', included under 'premium-le'
//      — via the SAME visibleShotsForTrim map2d.ts's render() calls.
//   d. THE INVARIANT: a synthetic goal referencing a premium-le shot keeps
//      that shot in visibleShotsForTrim's output even under 'pro' — the
//      filter never subtracts what the selected goal needs.
//   e. localStorage round-trip incl. stale-value fallback (state.ts's
//      trimStorageKey/readTrimPref).
//   f. goalVisibleForTrim (the Map goal picker's blocked-row predicate — an
//      OMISSION predicate until P7b, 2026-08-14; see the section's own note)
//      both as a direct unit test and as a map2d.ts source-wiring check (same
//      technique pathless-goals.test.mjs already uses for isPathless), plus
//      trimBlockCopy, the wording all three disclosure surfaces share.
//   g. feedForTrim resolution order: step feeds > feedsByTrim[trim] > base
//      feeds, incl. an explicit `null` override suppressing the feed rather
//      than falling through.
//
// Pattern: identical to playfield-art.test.mjs — esbuild bundles the REAL
// .ts sources (never edited, never copied) behind a tiny re-export entry
// point, dynamically imported and exercised directly; no DOM/canvas needed
// since every function under test is pure. Section (e) additionally stubs a
// minimal in-memory `globalThis.localStorage` (this Node has no built-in
// one — verified: `node -e "console.log(typeof localStorage)"` -> undefined)
// before importing, so state.ts's bare `localStorage.getItem/setItem` calls
// resolve. Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const dataDir = resolve(repoRoot, 'data')
const srcDir = resolve(__dirname, '../src')

// ---------------------------------------------------------------------------
// Harness (identical shape to every other suite here)
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------------------
// Minimal in-memory localStorage — see header note. Installed BEFORE the
// bundle is imported (state.ts touches it only inside function bodies, but
// matching every other suite's "stub globals before importing" ordering).
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
// Bundle every pure export this suite needs, from the REAL sources, behind
// one tiny re-export entry point (playfield-art.test.mjs's technique).
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-trim-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  `export { isShotVisible, feedForTrim } from ${JSON.stringify(resolve(srcDir, 'overlay/shotgeom.ts'))}\n` +
    `export { machineHasVariants, goalVisibleForTrim, goalReferencesPremiumLe, stepProvenance } from ${JSON.stringify(resolve(srcDir, 'ui/goalMeta.ts'))}\n` +
    `export { visibleShotsForTrim, trimBlockCopy } from ${JSON.stringify(resolve(srcDir, 'overlay/map2d.ts'))}\n` +
    `export { trimStorageKey, readTrimPref } from ${JSON.stringify(resolve(srcDir, 'state.ts'))}\n`,
)
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
})
const { isShotVisible, feedForTrim, machineHasVariants, goalVisibleForTrim, goalReferencesPremiumLe, stepProvenance, visibleShotsForTrim, trimBlockCopy, trimStorageKey, readTrimPref } =
  await import(pathToFileURL(outfile).href)

function goalOf(steps, extra = {}) {
  return { id: 'g-test', title: 'Test Goal', category: 'combo', summary: 's', difficulty: 1, steps, ...extra }
}

// ===========================================================================
section('a. isShotVisible — truth table incl. null/undefined/\'\'/\'all\'/\'pro\'/\'premium-le\'')
// ===========================================================================

function shotWithTrim(trim) {
  return { id: 's', name: 'S', type: 'standup', x: 0.5, y: 0.5, trim }
}

const VISIBILITY_CASES = [
  // [trim value on the shot, visible under 'pro'?, visible under 'premium-le'?]
  [undefined, true, true],
  [null, true, true],
  ['', true, true],
  ['all', true, true],
  ['premium-le', false, true],
  ['pro', true, false],
]

for (const [trimValue, wantPro, wantPrem] of VISIBILITY_CASES) {
  test(`shot.trim=${JSON.stringify(trimValue)} -> visible under pro=${wantPro}, premium-le=${wantPrem}`, () => {
    const shot = shotWithTrim(trimValue)
    assert(isShotVisible(shot, 'pro') === wantPro, `pro: expected ${wantPro}, got ${isShotVisible(shot, 'pro')}`)
    assert(
      isShotVisible(shot, 'premium-le') === wantPrem,
      `premium-le: expected ${wantPrem}, got ${isShotVisible(shot, 'premium-le')}`,
    )
  })
}

// ===========================================================================
section('b. machineHasVariants — the machine-variance helper')
// ===========================================================================

const jawsData = JSON.parse(readFileSync(resolve(dataDir, 'jaws_goals.json'), 'utf8'))
const gorgarData = JSON.parse(readFileSync(resolve(dataDir, 'gorgar_goals.json'), 'utf8'))

test('gorgar (real shipped data) actually has zero non-\'all\' shot trims — otherwise this test proves nothing', () => {
  const nonAll = (gorgarData.shots || []).filter((s) => s.trim && s.trim !== 'all')
  assert(nonAll.length === 0, `expected gorgar to have no trim-restricted shots, found ${nonAll.length}`)
})

test('jaws (has premium-le shots) -> true', () => {
  assert(machineHasVariants(jawsData) === true, 'expected jaws to report variants')
})

test('gorgar (no trim restrictions) -> false', () => {
  assert(machineHasVariants(gorgarData) === false, 'expected gorgar to report no variants')
})

test('a synthetic machine with ONLY a playfields[] zone trim (no shot trims) -> true', () => {
  const data = {
    machine: 'Synthetic',
    shots: [{ id: 's', name: 'S', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }],
    goals: [],
    sources: [],
    playfields: [{ id: 'z1', name: 'Zone', kind: 'upper', bounds: { x: 0, y: 0, w: 1, h: 1 }, trim: 'premium-le' }],
  }
  assert(machineHasVariants(data) === true, 'expected the playfields[]-only trim to count')
})

test('a synthetic machine with no shots, no playfields -> false', () => {
  const data = { machine: 'Empty', shots: [], goals: [], sources: [] }
  assert(machineHasVariants(data) === false)
})

test('null/undefined data -> false (defensive)', () => {
  assert(machineHasVariants(null) === false, 'null')
  assert(machineHasVariants(undefined) === false, 'undefined')
})

// ===========================================================================
section('c. Jaws\' Orca-deck trio: hidden under pro, visible under premium-le')
// ===========================================================================

const ORCA_TRIO = ['lookout-tower-ramp', 'ship-wheel-spinner', 'radio-target']

test('the trio is actually present in jaws\' data, each trim:\'premium-le\' — otherwise this test proves nothing', () => {
  for (const id of ORCA_TRIO) {
    const shot = jawsData.shots.find((s) => s.id === id)
    assert(shot, `expected a jaws shot with id ${id}`)
    assert(shot.trim === 'premium-le', `expected ${id} trim === 'premium-le', got ${JSON.stringify(shot.trim)}`)
  }
})

test('trim \'pro\' excludes all three Orca-deck shots from visibleShotsForTrim\'s output', () => {
  const visible = visibleShotsForTrim(jawsData.shots, 'pro', null)
  const visibleIds = new Set(visible.map((s) => s.id))
  for (const id of ORCA_TRIO) assert(!visibleIds.has(id), `expected ${id} excluded under pro`)
  return `${jawsData.shots.length} shots -> ${visible.length} visible under pro`
})

test('trim \'premium-le\' includes all three Orca-deck shots', () => {
  const visible = visibleShotsForTrim(jawsData.shots, 'premium-le', null)
  const visibleIds = new Set(visible.map((s) => s.id))
  for (const id of ORCA_TRIO) assert(visibleIds.has(id), `expected ${id} included under premium-le`)
  assert(visible.length === jawsData.shots.length, 'expected premium-le to include every jaws shot (superset)')
})

// ===========================================================================
section('d. THE INVARIANT — the trim filter never subtracts a shot the selected goal needs')
// ===========================================================================

const proShot = { id: 'pro-shot', name: 'Pro Shot', type: 'standup', x: 0.4, y: 0.4, trim: 'all' }
const premShot = { id: 'prem-shot', name: 'Prem Shot', type: 'standup', x: 0.3, y: 0.9, trim: 'premium-le' }
const invariantShots = [proShot, premShot]
const invariantGoal = goalOf([
  { shot: 'pro-shot', action: 'a' },
  { shot: 'prem-shot', action: 'b' },
])

test('without a selected goal, trim pro drops the premium-le shot', () => {
  const visible = visibleShotsForTrim(invariantShots, 'pro', null)
  assert(!visible.some((s) => s.id === 'prem-shot'), 'expected prem-shot excluded with no goal selected')
})

test('WITH that goal selected, trim pro still includes the premium-le shot its own route needs', () => {
  const visible = visibleShotsForTrim(invariantShots, 'pro', invariantGoal)
  assert(visible.some((s) => s.id === 'prem-shot'), 'THE INVARIANT violated: selected-goal shots were subtracted')
  assert(visible.some((s) => s.id === 'pro-shot'), 'expected the ordinary pro shot to still be present too')
  assert(visible.length === 2, `expected exactly 2 shots (no duplicates), got ${visible.length}`)
})

test('a goal with no steps (pathless) behaves exactly like no goal selected', () => {
  const visible = visibleShotsForTrim(invariantShots, 'pro', goalOf([]))
  assert(!visible.some((s) => s.id === 'prem-shot'), 'expected prem-shot still excluded for a pathless goal')
})

test('under premium-le trim (default), both shots are visible regardless of goal selection', () => {
  const withGoal = visibleShotsForTrim(invariantShots, 'premium-le', invariantGoal)
  const withoutGoal = visibleShotsForTrim(invariantShots, 'premium-le', null)
  assert(withGoal.length === 2 && withoutGoal.length === 2, 'expected both shots visible either way under premium-le')
})

test('overlay/map2d.ts\'s render() actually calls visibleShotsForTrim with (allShots, state.trim, goal) — source check', () => {
  const src = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
  assert(
    /const shots = visibleShotsForTrim\(allShots, state\.trim, goal\)/.test(src),
    'map2d.ts render() does not wire visibleShotsForTrim the expected way',
  )
  assert(
    /shotsByID: state\.shotsByID,/.test(src) && /trim: state\.trim,/.test(src),
    'map2d.ts\'s drawGoalOverlay call must still pass the FULL state.shotsByID (unfiltered) plus trim: state.trim',
  )
})

// ===========================================================================
section('e. localStorage round-trip incl. stale-value fallback (state.ts)')
// ===========================================================================

test('trimStorageKey follows the documented pinballgenie.trim.<machineId> shape', () => {
  assert(trimStorageKey('jaws') === 'pinballgenie.trim.jaws', `got ${JSON.stringify(trimStorageKey('jaws'))}`)
})

test('no stored value -> default \'premium-le\'', () => {
  globalThis.localStorage.clear()
  assert(readTrimPref('machine-a') === 'premium-le')
})

test('round-trip: writing \'pro\' under the documented key, reading it back via readTrimPref', () => {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(trimStorageKey('machine-b'), 'pro')
  assert(readTrimPref('machine-b') === 'pro', `got ${JSON.stringify(readTrimPref('machine-b'))}`)
})

test('round-trip: writing \'premium-le\' explicitly reads back \'premium-le\'', () => {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(trimStorageKey('machine-c'), 'premium-le')
  assert(readTrimPref('machine-c') === 'premium-le')
})

test('stale/corrupt stored value falls back to the default, not the garbage', () => {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(trimStorageKey('machine-d'), 'gold-edition-nonsense')
  assert(readTrimPref('machine-d') === 'premium-le', `expected the default fallback, got ${JSON.stringify(readTrimPref('machine-d'))}`)
})

test('per-machine isolation: two machines\' keys never collide', () => {
  globalThis.localStorage.clear()
  globalThis.localStorage.setItem(trimStorageKey('machine-e'), 'pro')
  globalThis.localStorage.setItem(trimStorageKey('machine-f'), 'premium-le')
  assert(readTrimPref('machine-e') === 'pro', 'machine-e should read pro')
  assert(readTrimPref('machine-f') === 'premium-le', 'machine-f should read premium-le')
  assert(readTrimPref('machine-g') === 'premium-le', 'an untouched machine-g should read the default')
})

// ===========================================================================
section('f. Map goal picker: goals needing a hidden-under-trim shot are DISABLED, not omitted (goalVisibleForTrim)')
// ===========================================================================

test('a goal referencing only an all-trim shot is visible under both trims', () => {
  const shotsById = new Map([['s1', { id: 's1', name: 'S1', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }]])
  const goal = goalOf([{ shot: 's1', action: 'a' }])
  assert(goalVisibleForTrim(goal, shotsById, 'pro') === true, 'expected visible under pro')
  assert(goalVisibleForTrim(goal, shotsById, 'premium-le') === true, 'expected visible under premium-le')
})

test('a SYNTHETIC premium-le-only goal fails the predicate under pro, passes it under premium-le', () => {
  const shotsById = new Map([['orca1', { id: 'orca1', name: 'Orca1', type: 'standup', x: 0.3, y: 0.9, trim: 'premium-le' }]])
  const goal = goalOf([{ shot: 'orca1', action: 'a' }])
  assert(goalVisibleForTrim(goal, shotsById, 'pro') === false, 'expected blocked under pro')
  assert(goalVisibleForTrim(goal, shotsById, 'premium-le') === true, 'expected makeable under premium-le')
})

test('a goal is blocked if ANY step (not just the first) needs a hidden shot', () => {
  const shotsById = new Map([
    ['base', { id: 'base', name: 'Base', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }],
    ['orca2', { id: 'orca2', name: 'Orca2', type: 'standup', x: 0.3, y: 0.9, trim: 'premium-le' }],
  ])
  const goal = goalOf([{ shot: 'base', action: 'a' }, { shot: 'orca2', action: 'b' }])
  assert(goalVisibleForTrim(goal, shotsById, 'pro') === false, 'expected blocked — step 2 needs a hidden shot')
})

test('a step referencing an unknown shot id does not itself block the goal (a data bug, not a trim question)', () => {
  const shotsById = new Map()
  const goal = goalOf([{ shot: 'ghost', action: 'a' }])
  assert(goalVisibleForTrim(goal, shotsById, 'pro') === true, 'expected an unresolvable step to be ignored, not to block')
})

// REVERSED 2026-08-14 (P7b), same reasoning as the pathless half in
// pathless-goals.test.mjs 11c: this used to require
// `.filter((g) => goalVisibleForTrim(g, state.shotsByID, state.trim))` — the
// goal DELETED from the Map tab's sheet. goalVisibleForTrim is still the one
// predicate, and it still decides the same thing; what changed is the verb.
// The row is rendered and DISABLED with a reason, so the Map and Goals tabs
// list the same machine identically (the Goals tab has always chipped rather
// than hidden — goalReferencesPremiumLe above). Re-adding the filter fails
// here.
test('map2d.ts uses goalVisibleForTrim to DISABLE a trim-blocked row, not to filter it out of the sheet', () => {
  const src = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
  assert(
    /import \{[\s\S]*?goalVisibleForTrim[\s\S]*?\} from '\.\.\/ui\/goalMeta'/.test(src),
    'map2d.ts does not import goalVisibleForTrim from ../ui/goalMeta',
  )
  assert(
    !/\.filter\(\(g\) => goalVisibleForTrim\(g, state\.shotsByID, state\.trim\)\)/.test(src),
    'map2d.ts is filtering trim-blocked goals out of the sheet again — P7b renders them disabled with a reason',
  )
  assert(
    !/\.filter\(\(g\) => !isPathless\(g\)\)/.test(src),
    'map2d.ts is filtering pathless goals out of the sheet again — see pathless-goals.test.mjs 11c',
  )
  // The predicate is still consulted, and the row that fails it is still not
  // selectable — a listed-but-tappable blocked row would draw a route with a
  // missing target, which is the bug the original filter was written for.
  assert(
    /!goalVisibleForTrim\(g, state\.shotsByID, state\.trim\)/.test(src),
    'map2d.ts no longer tests goalVisibleForTrim when building a goal row',
  )
  assert(
    /onActivate: null, reason: trimBlockCopy\(g, state\.shotsByID, state\.trim\)\.reason/.test(src),
    'a trim-blocked row must be built with no activation handler (that IS the disabled state) and a stated reason',
  )
})

test('trimBlockCopy names the ONE case the shipped data can produce, and stays honest about the other', () => {
  const premShots = new Map([['orca', { id: 'orca', name: 'Orca', type: 'standup', x: 0.3, y: 0.9, trim: 'premium-le' }]])
  const proShots = new Map([['pro-only', { id: 'pro-only', name: 'Pro Only', type: 'standup', x: 0.3, y: 0.9, trim: 'pro' }]])
  const premGoal = goalOf([{ shot: 'orca', action: 'a' }])
  const proGoal = goalOf([{ shot: 'pro-only', action: 'a' }])

  // The real case: premium-le content, MODEL set to Pro.
  const blocked = trimBlockCopy(premGoal, premShots, 'pro')
  assert(blocked.chip === 'NOT ON PRO', `chip: got ${JSON.stringify(blocked.chip)}`)
  // "switch MODEL", not "switch MODEL in settings" (2026-08-14): MODEL is now
  // a control on TWO surfaces (the Shots settings popover and the Study rail),
  // so the copy names the control's label and not a room only one of them has.
  assert(blocked.reason === 'Needs Premium/LE — switch MODEL', `reason: got ${JSON.stringify(blocked.reason)}`)
  assert(!/in settings/.test(blocked.reason), 'the copy must not send the reader to one surface\'s popover — MODEL exists in the Study rail too')
  assert(blocked.needs === 'needs Premium/LE', `needs: got ${JSON.stringify(blocked.needs)}`)

  // The hypothetical inverse (no shipped machine has a pro-only shot today):
  // it must NOT claim the goal needs Premium/LE, because it doesn't.
  const inverse = trimBlockCopy(proGoal, proShots, 'premium-le')
  assert(!/Premium\/LE/.test(inverse.reason), `the inverse case must not name Premium/LE: ${JSON.stringify(inverse.reason)}`)
  assert(!/Premium\/LE/.test(inverse.needs), `the inverse case must not name Premium/LE: ${JSON.stringify(inverse.needs)}`)
  assert(inverse.chip === 'NOT ON THIS MODEL', `chip: got ${JSON.stringify(inverse.chip)}`)
  return `${blocked.chip} / "${blocked.reason}"  |  ${inverse.chip} / "${inverse.reason}"`
})

// ===========================================================================
section('g. feedForTrim resolution order: step feeds > feedsByTrim[trim] > base feeds')
// ===========================================================================

const feedShot = {
  id: 's',
  name: 'S',
  type: 'ramp',
  x: 0.5,
  y: 0.5,
  trim: 'all',
  feeds: { x: 0.1, y: 0.1 },
  feedsByTrim: { 'premium-le': { x: 0.2, y: 0.2 }, pro: null },
}

test('no step override, premium-le trim -> feedsByTrim.premium-le wins over base feeds', () => {
  const got = feedForTrim(feedShot, undefined, 'premium-le')
  assert(got && got.x === 0.2 && got.y === 0.2, `got ${JSON.stringify(got)}`)
})

test('no step override, pro trim with an explicit null feedsByTrim.pro -> FALLS THROUGH to base feeds (not suppressed)', () => {
  // feedForTrim's real body (shotgeom.ts, off-limits — read, not edited) is
  // the nullish-coalescing chain `stepFeeds ?? shot.feedsByTrim?.[trim] ??
  // shot.feeds`. `??` does not stop at an explicit `null` partway through —
  // it treats `null` exactly like an absent/undefined value and keeps
  // falling through — so `feedsByTrim.pro: null` behaves IDENTICALLY to no
  // `pro` key at all, resolving to `shot.feeds` rather than suppressing the
  // feed. Confirmed here rather than assumed, since it's the one non-obvious
  // corner of an otherwise-intuitive "step > per-trim > base" precedence.
  const got = feedForTrim(feedShot, undefined, 'pro')
  assert(
    got && got.x === feedShot.feeds.x && got.y === feedShot.feeds.y,
    `expected the null override to fall through to base feeds ${JSON.stringify(feedShot.feeds)}, got ${JSON.stringify(got)}`,
  )
})

test('a step-level override wins over everything, regardless of trim', () => {
  const stepFeeds = { x: 0.9, y: 0.9 }
  const got = feedForTrim(feedShot, stepFeeds, 'premium-le')
  assert(got === stepFeeds, `expected the exact step-override object back, got ${JSON.stringify(got)}`)
  const gotPro = feedForTrim(feedShot, stepFeeds, 'pro')
  assert(gotPro === stepFeeds, 'step override must win under pro too, despite the explicit feedsByTrim.pro null')
})

test('a trim with no feedsByTrim entry at all falls back to base feeds', () => {
  const shotNoOverride = { id: 's2', name: 'S2', type: 'ramp', x: 0.5, y: 0.5, trim: 'all', feeds: { x: 0.1, y: 0.1 } }
  const got = feedForTrim(shotNoOverride, undefined, 'pro')
  assert(got && got.x === 0.1 && got.y === 0.1, `got ${JSON.stringify(got)}`)
})

test('SHIPPED jaws data: shots WITHOUT feedsByTrim resolve trim-invariant; wave-ramp resolves per model', () => {
  // Guards the A3 wiring both ways now that the P1 flagship pass authored
  // the first real feedsByTrim (2026-08-10, wave-ramp: Pro wireform returns
  // to the mini flipper, Premium/LE feeds the Orca deck). Un-overridden
  // shots must stay byte-identical under both trims (the back-compat claim
  // for every pre-A3 route assertion), and the override must actually
  // resolve differently per model — otherwise the selector is cosmetic.
  let invariant = 0
  let overridden = 0
  for (const shot of jawsData.shots) {
    if (!shot.feeds && !shot.feedsByTrim) continue
    const pro = feedForTrim(shot, undefined, 'pro')
    const prem = feedForTrim(shot, undefined, 'premium-le')
    if (shot.feedsByTrim) {
      overridden++
      assert(
        JSON.stringify(pro) !== JSON.stringify(prem),
        `${shot.id}: authors feedsByTrim but resolves identically under both trims — the override is dead data`,
      )
    } else {
      invariant++
      assert(
        JSON.stringify(pro) === JSON.stringify(shot.feeds) && JSON.stringify(prem) === JSON.stringify(shot.feeds),
        `${shot.id}: feedForTrim diverged from base feeds under one of the two trims`,
      )
    }
  }
  assert(invariant > 0, 'no un-overridden jaws shot with feeds found — assertion never ran')
  assert(overridden > 0, 'expected wave-ramp to carry feedsByTrim after the P1 apply — did the data move?')
  return `${invariant} jaws shots trim-invariant, ${overridden} resolving per model (wave-ramp)`
})

// stepProvenance's own trim threading is covered end-to-end by
// step-chips.test.mjs (unchanged — the new 4th param defaults to
// 'premium-le', matching every one of that suite's existing expectations).
// One direct check here that the parameter actually changes the answer, via
// a synthetic feedsByTrim shot (step-chips.test.mjs's fixtures have none).
test('stepProvenance: trim threads through to the named-feed RETURN suffix via feedForTrim', () => {
  const shotsById = new Map([
    ['left-ramp', { id: 'left-ramp', name: 'Left Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all', feeds: { shot: 'pro-lane' }, feedsByTrim: { 'premium-le': { shot: 'prem-lane' } } }],
    ['pro-lane', { id: 'pro-lane', name: 'Pro Lane', type: 'lane', x: 0.64, y: 0.1, trim: 'all' }],
    ['prem-lane', { id: 'prem-lane', name: 'Prem Lane', type: 'lane', x: 0.64, y: 0.1, trim: 'all' }],
    ['right-ramp', { id: 'right-ramp', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all', flipper: 'right' }],
  ])
  const goal = goalOf([{ shot: 'left-ramp', action: 'a' }, { shot: 'right-ramp', action: 'b' }])
  const underPro = stepProvenance(goal, 1, shotsById, 'pro')
  const underPrem = stepProvenance(goal, 1, shotsById, 'premium-le')
  assert(underPro === 'FROM RIGHT FLIPPER · PRO LANE RETURN', `pro: got ${JSON.stringify(underPro)}`)
  assert(underPrem === 'FROM RIGHT FLIPPER · PREM LANE RETURN', `premium-le: got ${JSON.stringify(underPrem)}`)
  return `pro -> ${underPro}; premium-le -> ${underPrem}`
})

await rm(tmp, { recursive: true, force: true })

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) {
  console.log('\nFAILED:')
  for (const r of results.filter((x) => x.outcome === 'fail')) console.log(`  - ${r.name}`)
  process.exitCode = 1
}
