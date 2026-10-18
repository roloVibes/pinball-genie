#!/usr/bin/env node
// app/tests/validate-machines.test.mjs — SUITE: validator corpus gate + howItPlays mutation battery
// (dataset schema v9, 2026-08-16 — GameData.howItPlays).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/validate-machines.test.mjs"
// or from app/:
//   node tests/validate-machines.test.mjs
//
// WHY THIS SUITE EXISTS. The validator is the only gate between a hand-edited
// JSON dataset and the app. A broken howItPlays block fails SILENTLY in the
// UI: a light group whose shot id was renamed renders nothing, a laneChange
// value outside the closed vocabulary falls through to a default, and a
// scoring tier out of order breaks the "ball-one → building → the-big-one"
// progression the Study tab relies on. None of that is caught by tsc or Vite.
//
// SECTIONS
//   1. CORPUS GATE — spawn the real validator over the real corpus, assert
//      exit 0, and print the summary line. This is the exact check that gates
//      deploy-prod.sh (a0), the fork's check.sh, and deploy-beta.sh.
//   2. MUTATION BATTERY — a trimmed copy of the repo (Jaws only) with a
//      synthetic valid howItPlays injected, then fifteen ways to break it,
//      each of which must turn the validator's exit code red and name the
//      right location, plus the three shapes that must stay green.
//
// Pattern: goal-requires.test.mjs §4 (trimmed tree + runValidator), but with
// the validator copied into a temp root instead of using the real one, so the
// battery never touches the shipped data.
// Exits non-zero on any FAIL.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const repoRoot = resolve(appDir, '..')
const dataDir = resolve(repoRoot, 'data')
const validatorPath = resolve(appDir, 'scripts/validate-machines.py')

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
  const t0 = Date.now()
  try {
    const evidence = fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}  ${String(Date.now() - t0).padStart(6)} ms${evidence ? `  ${evidence}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, error: e })
    console.log(`  FAIL  ${name}  ${String(Date.now() - t0).padStart(6)} ms`)
    console.log(`        ${e.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ===========================================================================
section('1. CORPUS GATE — the real validator must pass the real corpus')
// ===========================================================================

test('validate-machines.py exits 0 over the shipped data/', () => {
  const res = spawnSync('python3', [validatorPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  assert(res.status === 0, `expected exit 0, got ${res.status}\n${out}`)
  const lines = out.split('\n').filter(Boolean)
  const summary = lines[lines.length - 1]
  assert(/^\d+ machines, \d+ catalog entries, \d+ errors, \d+ warnings$/.test(summary),
    `summary line not found or malformed: "${summary}"`)
  return summary
})

// ===========================================================================
section('2. MUTATION BATTERY — howItPlays must turn the validator red on breakage')
// ===========================================================================

// A trimmed copy of the repo layout: the validator resolves DATA from its own
// __file__ (parents[2]/data), so it needs app/scripts/ + data/ and nothing
// else. One machine + a one-entry catalog keeps each run at a few
// milliseconds, so the whole battery is cheap enough to be exhaustive.
const mutRoot = await mkdtemp(resolve(tmpdir(), 'pg-howitplays-mut-'))
mkdirSync(resolve(mutRoot, 'app/scripts'), { recursive: true })
mkdirSync(resolve(mutRoot, 'data'), { recursive: true })
copyFileSync(validatorPath, resolve(mutRoot, 'app/scripts/validate-machines.py'))

const realCatalog = JSON.parse(readFileSync(resolve(dataDir, 'catalog.json'), 'utf8'))
writeFileSync(
  resolve(mutRoot, 'data/catalog.json'),
  JSON.stringify(realCatalog.filter((e) => e.resource === 'jaws_goals'), null, 2),
)

const jaws = JSON.parse(readFileSync(resolve(dataDir, 'jaws_goals.json'), 'utf8'))
const shotIds = jaws.shots.map((s) => s.id)
const goalIds = jaws.goals.map((g) => g.id)
assert(shotIds.length >= 2 && goalIds.length >= 2, 'Jaws fixture needs at least 2 shots and 2 goals')

// The synthetic valid howItPlays. laneChange is 'unknown' so the fixture stays
// green without a laneChangeNote; the battery's RED cases mutate this base.
const baseHowItPlays = {
  objective: 'Start multiball and complete modes to reach Wizard Mode.',
  loop: [
    'Shoot the left ramp to start Shark Attack.',
    'Collect Super Jackpot during multiball.',
    'Complete all modes to light Wizard Mode.',
  ],
  lights: [
    {
      id: 'left-ramp-light',
      name: 'Left Ramp',
      kind: 'shot-arrow',
      sites: [{ shot: shotIds[0] }],
      lit: 'Left ramp is lit for Shark Attack.',
      then: 'Shoot the left ramp to start Shark Attack.',
      goals: [goalIds[0]],
    },
    {
      id: 'multiball-light',
      name: 'Multiball',
      kind: 'status',
      sites: [{ shot: shotIds[1] }],
      lit: 'Multiball is ready.',
      then: 'Shoot the center shot to start multiball.',
      goals: [goalIds[1]],
    },
  ],
  laneChange: 'unknown',
  scoring: [
    { tier: 'ball-one', text: 'Score points on ball one.' },
    { tier: 'building', text: 'Build towards multiball.' },
    { tier: 'the-big-one', text: 'The big one is Wizard Mode.' },
  ],
}

/** Writes `mutate(doc)` into the trimmed tree and returns the validator's
 *  DIRECT exit code plus its ERROR and WARN lines. Exit code, never a grepped
 *  tail — scripts/run-tests.mjs's own rule, for the same reason. */
function runValidator(mutate) {
  const doc = JSON.parse(JSON.stringify(jaws))
  doc.howItPlays = JSON.parse(JSON.stringify(baseHowItPlays))
  mutate(doc)
  writeFileSync(resolve(mutRoot, 'data/jaws_goals.json'), JSON.stringify(doc, null, 2))
  const res = spawnSync('python3', [resolve(mutRoot, 'app/scripts/validate-machines.py')], {
    cwd: mutRoot,
    encoding: 'utf8',
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const lines = out.split('\n').filter((l) => l.startsWith('ERROR ') || l.startsWith('WARN '))
  return { status: res.status, errors: lines.filter((l) => l.startsWith('ERROR ')), warnings: lines.filter((l) => l.startsWith('WARN ')) }
}

test('BASELINE: the synthetic valid howItPlays validates clean — otherwise every mutation below is vacuous', () => {
  const { status, errors } = runValidator(() => {})
  assert(status === 0, `expected exit 0, got ${status}:\n${errors.join('\n')}`)
  assert(errors.length === 0, errors.join('\n'))
})

test('RED: absent howItPlays on a registered machine → exit 1 + ERROR (v9 program complete 2026-09-08)', () => {
  // Flipped from WARN to ERROR once the catalog was fully covered: a registered
  // machine may no longer ship without howItPlays. (KNOWN_UNREGISTERED shelved
  // datasets still WARN, mirroring the actionButton gate.)
  const doc = JSON.parse(JSON.stringify(jaws))
  delete doc.howItPlays
  writeFileSync(resolve(mutRoot, 'data/jaws_goals.json'), JSON.stringify(doc, null, 2))
  const res = spawnSync('python3', [resolve(mutRoot, 'app/scripts/validate-machines.py')], {
    cwd: mutRoot,
    encoding: 'utf8',
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  assert(res.status === 1, `expected exit 1 (registered machine must carry howItPlays), got ${res.status}\n${out}`)
  const err = out.split('\n').find((l) => l.startsWith('ERROR ') && l.includes('howItPlays'))
  assert(err, `expected an ERROR mentioning howItPlays, got:\n${out}`)
  return err.trim()
})

test('GREEN: laneChange "unknown" → exit 0 + WARN', () => {
  const { status, warnings } = runValidator(() => {})
  assert(status === 0, `expected exit 0, got ${status}`)
  const warn = warnings.find((l) => l.includes('laneChange') && l.includes('unknown'))
  assert(warn, `expected a WARN about laneChange unknown, got:\n${warnings.join('\n') || '(none)'}`)
  return warn.trim()
})

const MUTATIONS = [
  ['bad kind', (d) => { d.howItPlays.lights[0].kind = 'not-a-kind' }, /kind must be one of/],
  ['bad control.input', (d) => { d.howItPlays.lights[0].control = { input: 'bad-input', effect: 'Does something.' } }, /input must be one of/],
  ['unresolvable sites[].shot', (d) => { d.howItPlays.lights[0].sites[0].shot = 'no-such-shot' }, /unknown shot/],
  ['free site without name', (d) => { d.howItPlays.lights[0].sites[0] = { x: 0.5, y: 0.5 } }, /exactly one form/],
  ['a site carrying both forms', (d) => { d.howItPlays.lights[0].sites[0] = { shot: shotIds[0], x: 0.5, y: 0.5, name: 'Both' } }, /exactly one form/],
  ['duplicate group id', (d) => { d.howItPlays.lights[1].id = d.howItPlays.lights[0].id }, /duplicate.*id/],
  ['tiers out of order', (d) => { d.howItPlays.scoring[0].tier = 'building'; d.howItPlays.scoring[1].tier = 'ball-one' }, /tier must be/],
  ['only two tiers', (d) => { d.howItPlays.scoring = d.howItPlays.scoring.slice(0, 2) }, /exactly 3 steps/],
  ['unknown goals[] id', (d) => { d.howItPlays.lights[0].goals = ['no-such-goal'] }, /unknown goal/],
  ['bad laneChange', (d) => { d.howItPlays.laneChange = 'bad-value' }, /laneChange must be one of/],
  ['laneChange "flippers" without laneChangeNote', (d) => { d.howItPlays.laneChange = 'flippers' }, /laneChangeNote is required/],
  ['empty objective', (d) => { d.howItPlays.objective = '   ' }, /objective.*non-empty/],
  ['empty loop', (d) => { d.howItPlays.loop = [] }, /loop must have at least one step/],
  ['control without effect', (d) => { d.howItPlays.lights[0].control = { input: 'action-button' } }, /effect must be a non-empty string/],
  ['lit contains research voice', (d) => { d.howItPlays.lights[0].lit = 'according to the rulesheet the arrow pays' }, /howItPlays\.lights\[0\]\.lit/],
]

for (const [label, mutate, expected] of MUTATIONS) {
  test(`RED: ${label}`, () => {
    const { status, errors } = runValidator(mutate)
    assert(status === 1, `expected exit 1, got ${status}. Errors:\n${errors.join('\n') || '(none)'}`)
    const hit = errors.find((l) => expected.test(l))
    assert(hit, `no error matching ${expected}. Got:\n${errors.join('\n') || '(none)'}`)
    return hit.trim()
  })
}

// ---------------------------------------------------------------------------
// Cleanup + exit
// ---------------------------------------------------------------------------
await rm(mutRoot, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log(`\n${failed.length} test(s) failed`)
  process.exit(1)
}
console.log(`\n${results.length} tests passed`)
process.exit(0)
