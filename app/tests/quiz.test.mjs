#!/usr/bin/env node
// app/tests/quiz.test.mjs — the KNOW THIS TABLE quiz (ui/quiz.ts).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/quiz.test.mjs"
//
// Pattern: esbuild bundles the REAL ui/quiz.ts into a temp ESM file (CSS
// loaded as empty), same as lights.test.mjs / sheet.test.mjs. buildQuiz() is
// driven against REAL data files — data/jaws_goals.json (deep), gorgar (a thin
// classic), star_wars_data_east (the thinnest file in data/: fewest shots, no
// howItPlays, four pathless goals) — then against EVERY data/*_goals.json, so
// "always five on a normal machine" is a measured claim, not a hope. openQuiz()
// is then driven end to end against a small fake DOM.
//
// Sections:
//   a. Invariants on the three named files (both trims): unique options,
//      answer at correctIndex, 3-4 options, unique subjects, deterministic.
//   b. Each question kind says what the data says (answer derivation and
//      "no second right answer among the distractors").
//   c. Seeded shuffling: same seed → identical; options not always in the
//      same slot; a different day moves things.
//   d. Corpus sweep: every data file, both trims — invariants + 5 questions.
//   e. Thin / malformed data never throws; < QUIZ_MIN → [].
//   f. quizSeed format; firstSentence; verdictFor.
//   g. UI: openQuiz end to end (answer, feedback, Show me door, score card,
//      RETRY, DONE, empty state, focus moves).
//
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const dataDir = resolve(__dirname, '../../data')
const quizPath = resolve(srcDir, 'ui/quiz.ts')

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
    console.log(`  FAIL  ${name}\n          ${err && err.stack ? err.stack : err}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-quiz-test-'))
let mod
try {
  const out = resolve(tmp, 'quiz.bundle.mjs')
  const res = await build({
    entryPoints: [quizPath],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    loader: { '.css': 'empty' },
    write: false,
  })
  await writeFile(out, res.outputFiles[0].text)
  mod = await import(pathToFileURL(out).href)
} finally {
  await rm(tmp, { recursive: true, force: true })
}
const { buildQuiz, quizSeed, firstSentence, verdictFor, withPeriod, openQuiz, QUIZ_LENGTH, QUIZ_MIN } = mod

const load = (f) => JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
const NAMED = ['jaws_goals.json', 'gorgar_goals.json', 'star_wars_data_east_goals.json']
const SEED = 'test-machine:2026-10-14'
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** Throws on the first broken invariant; returns the questions. */
function checkInvariants(qs, label, { strictSubjects = true } = {}) {
  assert(Array.isArray(qs), `${label}: not an array`)
  assert(qs.length === 0 || (qs.length >= QUIZ_MIN && qs.length <= QUIZ_LENGTH), `${label}: ${qs.length} questions`)
  const subjects = new Set()
  const ids = new Set()
  for (const q of qs) {
    const keys = q.options.map(norm)
    assert(new Set(keys).size === keys.length, `${label} ${q.id}: duplicate option in ${JSON.stringify(q.options)}`)
    assert(q.options.length >= 3 && q.options.length <= 4, `${label} ${q.id}: ${q.options.length} options`)
    assert(q.options[q.correctIndex] === q.answer, `${label} ${q.id}: answer not at correctIndex`)
    assert(q.options.includes(q.answer), `${label} ${q.id}: answer missing from options`)
    assert(typeof q.prompt === 'string' && q.prompt.length > 0, `${label} ${q.id}: empty prompt`)
    assert(!ids.has(q.id), `${label}: question ${q.id} asked twice`)
    ids.add(q.id)
    const subj = q.goal ? `goal:${q.goal.id}` : q.id
    if (strictSubjects) assert(!subjects.has(subj), `${label}: subject ${subj} asked twice`)
    subjects.add(subj)
  }
  return qs
}

/** JSON-comparable projection (drops the goal object, keeps its id). */
const snap = (qs) => JSON.stringify(qs.map((q) => ({ ...q, goal: q.goal ? q.goal.id : null })))

// ---------------------------------------------------------------------------
section('a. invariants on the named files')
// ---------------------------------------------------------------------------
for (const f of NAMED) {
  for (const trim of [undefined, 'pro', 'premium-le']) {
    test(`${f} trim=${trim ?? 'none'}`, () => {
      const data = load(f)
      const qs = checkInvariants(buildQuiz(data, SEED, { trim }), f)
      assert(qs.length === QUIZ_LENGTH, `${f}: expected ${QUIZ_LENGTH}, got ${qs.length}`)
      assert(snap(buildQuiz(data, SEED, { trim })) === snap(qs), `${f}: not deterministic`)
      return qs.map((q) => `${q.kind}`).join(', ')
    })
  }
}

test('jaws gets the designed mix (goal-start, light-shot, light-lit, ladder)', () => {
  const kinds = new Set(buildQuiz(load('jaws_goals.json'), SEED).map((q) => q.kind))
  for (const k of ['goal-start', 'light-shot', 'light-lit', 'ladder']) assert(kinds.has(k), `jaws quiz missing ${k}: ${[...kinds]}`)
  return [...kinds].join(', ')
})

test('star_wars_data_east (no howItPlays) still gets five from goal/category generators', () => {
  const qs = buildQuiz(load('star_wars_data_east_goals.json'), SEED)
  assert(qs.every((q) => !q.kind.startsWith('light') && q.kind !== 'ladder'), 'a howItPlays question on a file with no howItPlays')
  return qs.map((q) => q.prompt).join(' | ')
})

// ---------------------------------------------------------------------------
section('b. each kind says what the data says')
// ---------------------------------------------------------------------------
function kindChecks(data, label) {
  const byId = new Map(data.shots.map((s) => [s.id, s]))
  const hip = data.howItPlays
  let n = 0
  for (let day = 1; day <= 20; day++) {
    for (const q of buildQuiz(data, `${label}:2026-10-${String(day).padStart(2, '0')}`)) {
      n++
      if (q.kind === 'goal-start' || q.kind === 'goal-first') {
        assert(q.goal.ordered !== false, `${q.id}: any-order goal asked for a first shot`)
        assert(q.answer === byId.get(q.goal.steps[0].shot).name, `${q.id}: answer is not the first step's shot name`)
        if (q.kind === 'goal-start') assert(['multiball', 'mode'].includes(q.goal.category), `${q.id}: goal-start on ${q.goal.category}`)
        const shotNames = new Set(data.shots.map((s) => s.name))
        assert(q.options.every((o) => shotNames.has(o)), `${q.id}: an option is not a shot name`)
      } else if (q.kind === 'light-shot') {
        const group = hip.lights.find((g) => `light-shot:${g.id}` === q.id)
        const siteNames = new Set(group.sites.filter((s) => 'shot' in s).map((s) => norm(byId.get(s.shot)?.name ?? '')))
        assert(siteNames.has(norm(q.answer)), `${q.id}: answer is not one of the group's shots`)
        const wrongButRight = q.options.filter((o, i) => i !== q.correctIndex && siteNames.has(norm(o)))
        assert(wrongButRight.length === 0, `${q.id}: distractor ${wrongButRight} is also a site of the group`)
      } else if (q.kind === 'light-lit') {
        const group = hip.lights.find((g) => `light-lit:${g.id}` === q.id)
        assert(q.answer === group.lit.trim(), `${q.id}: answer is not the group's lit sentence`)
        const lits = new Set(hip.lights.map((g) => g.lit.trim()))
        assert(q.options.every((o) => lits.has(o)), `${q.id}: an option is not some group's lit`)
      } else if (q.kind === 'ladder') {
        assert(q.answer === hip.scoring[0].text.trim(), 'ladder answer is not scoring[0].text')
        assert(q.options.length === 3, `ladder has ${q.options.length} options, expected the three tiers`)
      } else if (q.kind === 'category') {
        const cat = q.goal.category
        assert(q.answer === q.goal.title.trim(), `${q.id}: answer is not the goal title`)
        const inCat = new Set(data.goals.filter((g) => g.category === cat).map((g) => norm(g.title)))
        const leaks = q.options.filter((o, i) => i !== q.correctIndex && inCat.has(norm(o)))
        assert(leaks.length === 0, `${q.id}: distractor ${leaks} is also in ${cat}`)
      }
    }
  }
  return `${n} questions checked over 20 seeds`
}
for (const f of NAMED) test(`${f}`, () => kindChecks(load(f), f))

test('pro trim never asks about a premium-le shot (every file that has one)', () => {
  let files = 0
  let checked = 0
  for (const f of readdirSync(dataDir).filter((x) => x.endsWith('_goals.json'))) {
    const data = load(f)
    const prem = new Set(data.shots.filter((s) => s.trim === 'premium-le').map((s) => s.id))
    if (prem.size === 0) continue
    files++
    const premNames = new Set(data.shots.filter((s) => prem.has(s.id)).map((s) => norm(s.name)))
    const proNames = new Set(data.shots.filter((s) => !prem.has(s.id)).map((s) => norm(s.name)))
    for (const q of buildQuiz(data, SEED, { trim: 'pro' })) {
      checked++
      if (q.goal) assert(q.goal.steps.every((st) => !prem.has(st.shot)), `${f} ${q.id}: goal routes through a premium-le shot`)
      for (const o of q.options) {
        const k = norm(o)
        assert(!(premNames.has(k) && !proNames.has(k)), `${f} ${q.id}: premium-le-only shot "${o}" offered on pro`)
      }
    }
  }
  assert(files > 0, 'no data file has a premium-le shot — this test would pass vacuously')
  return `${files} files with premium-le shots, ${checked} pro questions checked`
})

// THE PROMPT MUST NOT ANSWER ITSELF (2026-10-14 review). Jaws asked "What
// starts Fish Finder — Collect All 5 Awards?" with "Left 3-Bank (Fish Finder)"
// among the options; Godzilla asked what starts Mechagodzilla Multiball with
// "Right Spinner (Mechagodzilla)" on screen. Word-matching is not knowing.
// This tokenizer is the TEST's own, deliberately written apart from quiz.ts's,
// with the same rule: 4+ letter words that are not generic shot words.
const GENERIC = new Set(['left', 'right', 'center', 'centre', 'upper', 'lower', 'ramp', 'ramps', 'lane', 'lanes', 'shot', 'shots', 'ball', 'balls', 'multiball', 'mode', 'modes', 'orbit', 'loop', 'target', 'targets', 'what', 'starts', 'first', 'with', 'from', 'into', 'then'])
const words = (t) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w)))
/** The subject a shot question is built from: the goal title, or the light
 *  group's name. null for kinds whose answer is not a shot name. */
function subjectText(q, data) {
  if (q.kind === 'goal-start' || q.kind === 'goal-first') return q.goal.title
  if (q.kind === 'light-shot') return data.howItPlays.lights.find((g) => `light-shot:${g.id}` === q.id).name
  return null
}
function giveaway(q, data) {
  const subj = subjectText(q, data)
  if (subj === null) return null
  const a = words(q.answer)
  const shared = [...words(subj)].filter((w) => a.has(w))
  return shared.length ? shared : null
}

for (const [file, goalId, word] of [
  ['jaws_goals.json', 'fish-finder-awards', 'finder'],
  ['godzilla_goals.json', 'mechagodzilla-multiball', 'mechagodzilla'],
]) {
  test(`${file}: the "${goalId}" goal-start question is never asked — its start shot repeats "${word}" from the title`, () => {
    const data = load(file)
    const g = data.goals.find((x) => x.id === goalId)
    const start = data.shots.find((x) => x.id === g?.steps?.[0]?.shot)
    assert(g && start && words(g.title).has(word) && words(start.name).has(word), `setup: ${file} no longer pairs "${g?.title}" with "${start?.name}" — re-point this test`)
    let asked = 0
    let full = 0
    for (let day = 1; day <= 28; day++) {
      for (const trim of ['pro', 'premium-le']) {
        const qs = buildQuiz(data, `${file}:2026-02-${String(day).padStart(2, '0')}`, { trim })
        if (qs.length === QUIZ_LENGTH) full++
        for (const q of qs) {
          if (q.id === `goal-start:${goalId}` || q.id === `goal-first:${goalId}`) asked++
          const leak = giveaway(q, data)
          assert(!leak, `${q.id}: "${q.prompt}" answered by "${q.answer}" (shares ${leak})`)
        }
      }
    }
    assert(asked === 0, `asked ${asked} times`)
    assert(full === 56, `the fallbacks did not fill the slot: only ${full} of 56 sets reached ${QUIZ_LENGTH}`)
    return `"${g.title}" → "${start.name}": never asked over 28 days x 2 trims; every set still has ${QUIZ_LENGTH}`
  })
}

test('jaws Fish Finder Awards light: never asked as "which shot" — its only site repeats "Fish Finder"', () => {
  const data = load('jaws_goals.json')
  for (let day = 1; day <= 28; day++) {
    for (const q of buildQuiz(data, `j:2026-02-${String(day).padStart(2, '0')}`)) {
      assert(q.id !== 'light-shot:fish-finder-awards', `asked "${q.prompt}" with "${q.answer}" on screen`)
    }
  }
})

// OFF-MODEL LIGHTS (2026-10-14 review). On Pro, Jaws' Lookout Tower Extra Ball
// lives only on a premium-le ramp, and its `lit` says "(Premium/LE only)" —
// it was still asked about, and still offered as a distractor.
test('jaws on PRO: no Lookout Tower question and no option containing "Premium/LE" over 28 days', () => {
  const data = load('jaws_goals.json')
  const lookout = data.howItPlays.lights.find((g) => g.id === 'lookout-tower-extra-ball')
  assert(lookout && /premium\/le only/i.test(lookout.lit), 'setup: jaws no longer has the Premium/LE-only Lookout Tower light — re-point this test')
  let n = 0
  let litQs = 0
  for (let day = 1; day <= 28; day++) {
    for (const q of buildQuiz(data, `jaws:2026-02-${String(day).padStart(2, '0')}`, { trim: 'pro' })) {
      n++
      if (q.kind === 'light-lit') litQs++
      assert(!/lookout tower/i.test(q.prompt), `pro asked: "${q.prompt}"`)
      for (const o of q.options) assert(!/premium\/le/i.test(o), `pro offered: "${o}" in ${q.id}`)
    }
  }
  assert(litQs > 0, 'no light-lit questions at all on pro — the distractor half of this check ran on nothing')
  return `${n} pro questions (${litQs} light-lit), none about Lookout Tower or offering Premium/LE text`
})

test('…and on PREMIUM/LE the Lookout Tower light is still in play (the filter is the trim, not the light)', () => {
  const data = load('jaws_goals.json')
  let seen = 0
  for (let day = 1; day <= 28; day++) {
    for (const q of buildQuiz(data, `jaws:2026-02-${String(day).padStart(2, '0')}`, { trim: 'premium-le' })) {
      if (/lookout tower/i.test(q.prompt) || q.options.some((o) => /premium\/le only/i.test(o))) seen++
    }
  }
  assert(seen > 0, 'Premium/LE never sees the Lookout Tower light — the filter over-reached')
  return `${seen} premium-le questions touch it`
})

// The two Pro filters, each on its own. Jaws exercises both at once (its
// Lookout Tower light is premium-le-only AND says so), so either one alone
// would pass the test above; these fixtures separate them.
function proLightFixture({ offModelLit, phraseOnAllTrim }) {
  const shots = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: `Shot ${id.toUpperCase()}`, type: 'target', x: 0.5, y: 0.5, trim: 'all' }))
  shots.push({ id: 'p', name: 'Tower Ramp', type: 'ramp', x: 0.5, y: 0.9, trim: 'premium-le' })
  const light = (id, name, site, lit) => ({ id, name, kind: 'status', sites: [{ shot: site }], lit, then: 'Then.' })
  return {
    shots,
    goals: [],
    howItPlays: {
      objective: 'x', loop: ['a'], laneChange: 'unknown', scoring: [],
      lights: [
        light('l1', 'Alpha Lamp', 'a', 'A lit Alpha Lamp doubles the next shot.'),
        light('l2', 'Beta Lamp', 'b', 'A lit Beta Lamp adds a ball save.'),
        light('l3', 'Gamma Lamp', 'c', 'A lit Gamma Lamp spots a letter.'),
        light('l4', 'Delta Lamp', 'd', phraseOnAllTrim ? 'A lit Delta Lamp opens the tower diverter (Premium/LE only).' : 'A lit Delta Lamp collects the bonus.'),
        light('lp', 'Tower Lamp', 'p', offModelLit),
      ],
    },
  }
}
test('PRO, light on premium-le shots only (no "Premium/LE only" wording): never asked, its lit never offered', () => {
  const data = proLightFixture({ offModelLit: 'A lit Tower Lamp awards an extra ball.', phraseOnAllTrim: false })
  let n = 0
  for (let day = 1; day <= 20; day++) {
    for (const q of buildQuiz(data, `fx:${day}`, { trim: 'pro' })) {
      n++
      assert(!/tower lamp/i.test(q.prompt), `pro asked: "${q.prompt}"`)
      assert(!q.options.includes('A lit Tower Lamp awards an extra ball.'), `pro offered the off-model lit in ${q.id}`)
    }
  }
  assert(n > 0, 'setup: the fixture built no questions')
  let premSeen = 0
  for (let day = 1; day <= 20; day++) {
    for (const q of buildQuiz(data, `fx:${day}`, { trim: 'premium-le' })) {
      if (/tower lamp/i.test(q.prompt) || q.options.includes('A lit Tower Lamp awards an extra ball.')) premSeen++
    }
  }
  assert(premSeen > 0, 'setup: premium-le never uses the Tower Lamp either — the pro check proves nothing')
  return `${n} pro questions; premium-le uses the Tower Lamp in ${premSeen}`
})
test('PRO, "Premium/LE only" wording on a light that IS on Pro: that text is never an option', () => {
  const data = proLightFixture({ offModelLit: 'A lit Tower Lamp awards an extra ball.', phraseOnAllTrim: true })
  let n = 0
  for (let day = 1; day <= 20; day++) {
    for (const q of buildQuiz(data, `fx:${day}`, { trim: 'pro' })) {
      n++
      for (const o of q.options) assert(!/premium\/le only/i.test(o), `pro offered "${o}" in ${q.id}`)
    }
  }
  assert(n > 0, 'setup: the fixture built no questions')
  let premSeen = 0
  for (let day = 1; day <= 20; day++) {
    for (const q of buildQuiz(data, `fx:${day}`, { trim: 'premium-le' })) if (q.options.some((o) => /premium\/le only/i.test(o))) premSeen++
  }
  assert(premSeen > 0, 'setup: premium-le never shows the Delta text either — the pro check proves nothing')
  return `${n} pro questions; premium-le shows the text in ${premSeen}`
})

// THE VERIFIER'S CORPUS CHECK: every data file x both trims x 3 seeds.
test('CORPUS: every data/*_goals.json x {pro, premium-le} x 3 seeds — unique options, answer among them, no giveaway, no off-model light content', () => {
  const files = readdirSync(dataDir).filter((x) => x.endsWith('_goals.json'))
  const seeds = ['2026-10-14', '2026-10-15', '2026-10-16']
  let sets = 0
  let questions = 0
  const problems = []
  for (const f of files) {
    const data = load(f)
    const byId = new Map(data.shots.map((s) => [s.id, s]))
    const offModelLight = (g) => g.sites.length > 0 && g.sites.every((st) => st && 'shot' in st && byId.get(st.shot)?.trim === 'premium-le')
    const offIds = new Set((data.howItPlays?.lights ?? []).filter(offModelLight).map((g) => g.id))
    const offLits = new Set((data.howItPlays?.lights ?? []).filter(offModelLight).map((g) => norm(g.lit ?? '')))
    for (const trim of ['pro', 'premium-le']) {
      for (const day of seeds) {
        const qs = buildQuiz(data, `${f}:${day}`, { trim })
        sets++
        for (const q of qs) {
          questions++
          const keys = q.options.map(norm)
          if (new Set(keys).size !== keys.length) problems.push(`${f}/${trim}/${day} ${q.id}: duplicate options`)
          if (q.options[q.correctIndex] !== q.answer || !q.options.includes(q.answer)) problems.push(`${f}/${trim}/${day} ${q.id}: answer not among options`)
          const leak = giveaway(q, data)
          if (leak) problems.push(`${f}/${trim}/${day} ${q.id}: giveaway (${leak})`)
          if (trim === 'pro') {
            const lightId = q.kind.startsWith('light') ? q.id.slice(q.id.indexOf(':') + 1) : null
            if (lightId && offIds.has(lightId)) problems.push(`${f}/pro/${day} ${q.id}: asks about a premium-le-only light`)
            for (const o of q.options) {
              if (/\bpremium\s*(\/|and)\s*le\s+only\b/i.test(o)) problems.push(`${f}/pro/${day} ${q.id}: option "${o}"`)
              if (offLits.has(norm(o))) problems.push(`${f}/pro/${day} ${q.id}: off-model light text "${o}"`)
            }
          }
        }
      }
    }
  }
  assert(problems.length === 0, `${problems.length} problems:\n            ${problems.slice(0, 20).join('\n            ')}`)
  return `${files.length} files x 2 trims x 3 seeds = ${sets} quiz sets, ${questions} questions, 0 problems`
})

// ---------------------------------------------------------------------------
section('c. seeded shuffling')
// ---------------------------------------------------------------------------
test('same seed → byte-identical set, across fresh calls', () => {
  const data = load('jaws_goals.json')
  assert(snap(buildQuiz(data, SEED)) === snap(buildQuiz(structuredClone(data), SEED)), 'differs on a clone of the same data')
})

test('the correct answer is not parked in one slot', () => {
  const slots = [0, 0, 0, 0]
  for (const f of NAMED) {
    for (let day = 1; day <= 28; day++) {
      for (const q of buildQuiz(load(f), `x:2026-02-${String(day).padStart(2, '0')}`)) slots[q.correctIndex]++
    }
  }
  const total = slots.reduce((a, b) => a + b, 0)
  assert(slots.slice(0, 3).every((n) => n > total * 0.1), `correctIndex distribution looks unshuffled: ${slots}`)
  return `correctIndex histogram over ${total} questions: ${slots.join(' / ')}`
})

test('a different day changes the set or the option order', () => {
  const data = load('jaws_goals.json')
  const a = snap(buildQuiz(data, quizSeed('jaws', new Date(2026, 9, 14))))
  const b = snap(buildQuiz(data, quizSeed('jaws', new Date(2026, 9, 15))))
  assert(a !== b, 'two different days produced the identical quiz')
})

test('option order for a given question is seeded (two seeds can differ, one seed never does)', () => {
  const data = load('gorgar_goals.json')
  const orders = new Map()
  for (let day = 1; day <= 28; day++) {
    for (const q of buildQuiz(data, `g:2026-03-${String(day).padStart(2, '0')}`)) {
      const key = q.id
      const sig = [...q.options].sort().join('|')
      const prev = orders.get(`${key}#${sig}`) ?? new Set()
      prev.add(q.options.join('|'))
      orders.set(`${key}#${sig}`, prev)
    }
  }
  const varied = [...orders.values()].filter((s) => s.size > 1).length
  assert(varied > 0, 'the same question with the same options never appeared in a different order')
  return `${varied} question/option-set pairs seen in more than one order`
})

// ---------------------------------------------------------------------------
section('d. corpus sweep — every data file, both trims')
// ---------------------------------------------------------------------------
test('invariants hold and every normal machine gets five', () => {
  const files = readdirSync(dataDir).filter((x) => x.endsWith('_goals.json'))
  assert(files.length > 10, `only ${files.length} data files found`)
  const short = []
  let total = 0
  for (const f of files) {
    const data = load(f)
    for (const trim of ['pro', 'premium-le']) {
      const qs = checkInvariants(buildQuiz(data, `${f}:2026-10-14`, { trim }), `${f}/${trim}`)
      total += qs.length
      const routed = data.goals.filter((g) => g.steps.length > 0).length
      if (data.shots.length >= 4 && routed >= 4 && qs.length !== QUIZ_LENGTH) short.push(`${f}/${trim}=${qs.length}`)
    }
  }
  assert(short.length === 0, `machines with >=4 shots and >=4 routed goals but fewer than five questions: ${short.join(', ')}`)
  return `${files.length} files x 2 trims, ${total} questions, all invariants held`
})

// ---------------------------------------------------------------------------
section('e. thin and malformed data never throws')
// ---------------------------------------------------------------------------
const shot = (id, name) => ({ id, name, type: 'target', x: 0.5, y: 0.5, trim: 'all' })
const goal = (id, category, shots, title = id) => ({ id, title, category, summary: `${title} summary. More.`, difficulty: 1, steps: shots.map((s) => ({ shot: s, action: 'Shoot' })) })
const CASES = {
  'null': null,
  'empty object': {},
  'no arrays': { shots: 'x', goals: 7, howItPlays: { lights: 'nope', scoring: {} } },
  'empty arrays': { machine: 'x', shots: [], goals: [], sources: [] },
  'holes in arrays': { shots: [null, 3, { id: 'a' }], goals: [null, { id: 'g' }, { id: 'h', steps: [null] }], howItPlays: { lights: [null, { id: 'l', name: 'L', sites: [null, 4, { shot: 'zz' }] }], scoring: [null, null, null] } },
  'two shots, one goal': { shots: [shot('a', 'A'), shot('b', 'B')], goals: [goal('g', 'mode', ['a'])] },
  'dangling step ids': { shots: [shot('a', 'A'), shot('b', 'B'), shot('c', 'C'), shot('d', 'D')], goals: [goal('g1', 'mode', ['zz']), goal('g2', 'multiball', ['yy'])] },
  'all one category, pathless': { shots: [shot('a', 'A'), shot('b', 'B'), shot('c', 'C'), shot('d', 'D')], goals: ['1', '2', '3', '4'].map((i) => ({ ...goal(i, 'secret', []), instructions: ['x'] })) },
  'duplicate shot names': { shots: [shot('a', 'Ramp'), shot('b', 'ramp '), shot('c', 'Ramp'), shot('d', 'Orbit')], goals: [goal('g1', 'mode', ['a']), goal('g2', 'mode', ['b']), goal('g3', 'multiball', ['c']), goal('g4', 'combo', ['d'])] },
}
for (const [label, data] of Object.entries(CASES)) {
  test(label, () => {
    // Lean data may reuse a goal for a second, different question (relaxed pass).
    const qs = checkInvariants(buildQuiz(data, SEED), label, { strictSubjects: false })
    return `${qs.length} questions`
  })
}

test('four shots + four routed goals in four categories → five questions', () => {
  const data = {
    shots: [shot('a', 'Left Ramp'), shot('b', 'Right Ramp'), shot('c', 'Spinner'), shot('d', 'Scoop')],
    goals: [goal('g1', 'mode', ['a', 'b']), goal('g2', 'multiball', ['b']), goal('g3', 'combo', ['c', 'd']), goal('g4', 'wizard', ['d'])],
  }
  const qs = checkInvariants(buildQuiz(data, SEED), 'synthetic', { strictSubjects: false })
  assert(qs.length === QUIZ_LENGTH, `got ${qs.length}`)
  return qs.map((q) => q.prompt).join(' | ')
})

test('any-order goals never produce a first-shot question', () => {
  const data = {
    shots: [shot('a', 'A'), shot('b', 'B'), shot('c', 'C'), shot('d', 'D')],
    goals: [{ ...goal('g1', 'multiball', ['a', 'b']), ordered: false }, { ...goal('g2', 'mode', ['c']), ordered: false }, goal('g3', 'combo', ['d']), goal('g4', 'wizard', ['a'])],
  }
  for (let d = 1; d <= 10; d++) {
    for (const q of buildQuiz(data, `s${d}`)) {
      if (q.kind === 'goal-start' || q.kind === 'goal-first') assert(q.goal.ordered !== false, `${q.id} asked for an any-order goal`)
    }
  }
})

// ---------------------------------------------------------------------------
section('f. helpers')
// ---------------------------------------------------------------------------
test('quizSeed is machine + local day', () => {
  assert(quizSeed('jaws', new Date(2026, 0, 5, 23, 59)) === 'jaws:2026-01-05', quizSeed('jaws', new Date(2026, 0, 5, 23, 59)))
  assert(quizSeed('jaws', new Date(2026, 0, 5, 0, 1)) === quizSeed('jaws', new Date(2026, 0, 5, 23, 0)), 'same day, different seeds')
})
test('firstSentence', () => {
  assert(firstSentence('One. Two.') === 'One.', firstSentence('One. Two.'))
  assert(firstSentence('No stop') === 'No stop', 'no terminator')
  assert(firstSentence(null) === '', 'null')
  assert(firstSentence('  ') === '', 'blank')
})
test('withPeriod: one period, never two (the wrong-answer verdict quotes whole data sentences)', () => {
  assert(withPeriod('Left Ramp') === 'Left Ramp.', withPeriod('Left Ramp'))
  assert(withPeriod('Shoot the lit arrow.') === 'Shoot the lit arrow.', withPeriod('Shoot the lit arrow.'))
  for (const t of ['Go!', 'Really?', 'And then…', 'the "Fat Man"', "Quint's 'knot'", 'trailing space.  ']) {
    assert(!/[.!?…"'][.]$/.test(withPeriod(t)), `${JSON.stringify(t)} -> ${JSON.stringify(withPeriod(t))}`)
  }
})
test('verdictFor', () => {
  assert(/know this table/i.test(verdictFor(5, 5)), verdictFor(5, 5))
  assert(verdictFor(4, 5) !== verdictFor(5, 5), 'perfect and near-perfect read the same')
  assert(verdictFor(1, 5) !== verdictFor(4, 5), 'low and high read the same')
})

// ---------------------------------------------------------------------------
section('g. UI: openQuiz end to end (fake DOM)')
// ---------------------------------------------------------------------------
let active = null
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.className = ''
    this._text = ''
    this.hidden = false
    this.disabled = false
    this.id = ''
    this.style = {}
    this._attrs = {}
    this._l = new Map()
    const cls = () => new Set(this.className.split(/\s+/).filter(Boolean))
    this.classList = {
      add: (...c) => { const s = cls(); c.forEach((x) => s.add(x)); this.className = [...s].join(' ') },
      remove: (...c) => { const s = cls(); c.forEach((x) => s.delete(x)); this.className = [...s].join(' ') },
      contains: (c) => cls().has(c),
    }
  }
  set textContent(v) { this._text = v; this.children = [] }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c }
  append(...n) { n.forEach((c) => this.appendChild(c)) }
  replaceChildren(...n) { this.children = []; this.append(...n) }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null } }
  setAttribute(k, v) { this._attrs[k] = String(v) }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null }
  addEventListener(t, fn) { if (!this._l.has(t)) this._l.set(t, new Set()); this._l.get(t).add(fn) }
  removeEventListener(t, fn) { this._l.get(t)?.delete(fn) }
  click() { for (const fn of this._l.get('click') ?? []) fn({ type: 'click', target: this }) }
  focus() { active = this }
  findAll(c, acc = []) { if (this.className.split(/\s+/).includes(c)) acc.push(this); for (const k of this.children) k.findAll(c, acc); return acc }
  find(c) { return this.findAll(c)[0] ?? null }
}
function withDom(fn) {
  const prior = { document: globalThis.document }
  const body = new El('body')
  const docListeners = new Map()
  active = null
  globalThis.document = {
    body,
    createElement: (t) => new El(t),
    addEventListener: (t, f) => { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(f) },
    removeEventListener: (t, f) => docListeners.get(t)?.delete(f),
    get activeElement() { return active },
  }
  const key = (k) => { for (const f of [...(docListeners.get('keydown') ?? [])]) f({ type: 'keydown', key: k, shiftKey: false, preventDefault() {} }) }
  try { return fn({ body, key }) } finally { globalThis.document = prior.document }
}
const jaws = load('jaws_goals.json')
const fakeState = (data = jaws) => ({ machine: { id: 'jaws', name: 'Jaws', shortTitle: 'Jaws', resource: 'jaws_goals' }, data, trim: 'premium-le' })
const panelOf = (body) => body.find('pg-sheet-panel')

test('opens a dialog on body with question 1 and focuses the prompt', () =>
  withDom(({ body }) => {
    const h = openQuiz(fakeState(), { showGoalOnShots() {} })
    const panel = panelOf(body)
    assert(panel && panel.getAttribute('role') === 'dialog', 'no dialog panel')
    assert(panel.textContent.includes('Know this table'), 'no title')
    assert(body.find('pg-quiz-eyebrow').textContent === 'Question 1 of 5', body.find('pg-quiz-eyebrow')?.textContent)
    assert(active === body.find('pg-quiz-prompt'), 'focus not on the prompt')
    assert(body.findAll('pg-quiz-opt').length >= 3, 'no options')
    h.destroy()
    assert(!panelOf(body), 'destroy left the panel')
  }))

test('a wrong tap marks wrong + right, explains, locks, and focuses NEXT', () =>
  withDom(({ body }) => {
    openQuiz(fakeState(), { showGoalOnShots() {} })
    const q = buildQuiz(jaws, quizSeed('jaws'), { trim: 'premium-le' })[0]
    const opts = body.findAll('pg-quiz-opt')
    const wrong = opts.findIndex((_, i) => i !== q.correctIndex)
    opts[wrong].click()
    assert(opts[wrong].classList.contains('is-wrong'), 'chosen wrong option not marked')
    assert(opts[q.correctIndex].classList.contains('is-right'), 'correct option not highlighted')
    assert(body.find('pg-quiz-verdict').textContent.includes(q.answer), 'verdict does not name the answer')
    if (q.why) assert(body.find('pg-quiz-why').textContent === q.why, 'why line missing')
    opts[q.correctIndex].click() // locked: must not change the outcome
    assert(body.findAll('pg-quiz-verdict').length === 1, 'a second tap answered again')
    assert(active && active.textContent === 'NEXT', `focus on ${active?.textContent}`)
  }))

test('the WRONG-answer verdict ends in exactly one period when the answer is a sentence (jaws, real sheet)', () =>
  withDom(({ body }) => {
    // A day whose set has a question whose answer already ends in a period
    // (a light-lit or ladder sentence); the sheet is walked to it.
    let seedDay = null
    let q = null
    let at = -1
    for (let day = 1; day <= 28 && !q; day++) {
      const qs = buildQuiz(jaws, quizSeed('jaws', new Date(2026, 1, day)), { trim: 'premium-le' })
      at = qs.findIndex((x) => /\.$/.test(x.answer))
      if (at !== -1) {
        seedDay = new Date(2026, 1, day, 12)
        q = qs[at]
      }
    }
    assert(q, 'setup: no day in February has a sentence answer')
    // openQuiz seeds from quizSeed(machine, new Date()): pin "today".
    const RealDate = globalThis.Date
    globalThis.Date = class extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : [seedDay.getTime()]))
      }
    }
    try {
      openQuiz(fakeState(), { showGoalOnShots() {} })
    } finally {
      globalThis.Date = RealDate
    }
    for (let i = 0; i < at; i++) {
      body.findAll('pg-quiz-opt')[0].click()
      body.find('pg-quiz-btn-primary').click()
    }
    assert(body.find('pg-quiz-prompt').textContent === q.prompt, `setup: walked to "${body.find('pg-quiz-prompt').textContent}", not "${q.prompt}"`)
    const opts = body.findAll('pg-quiz-opt')
    opts[(q.correctIndex + 1) % opts.length].click()
    const verdict = body.find('pg-quiz-verdict').textContent
    assert(!/\.\.$/.test(verdict), `double period: ${verdict}`)
    assert(verdict === `Not quite. It's ${q.answer}`, `verdict: ${JSON.stringify(verdict)}`)
    return verdict
  }))

test('"Show me on the playfield" closes the quiz and opens the door with the goal', () =>
  withDom(({ body }) => {
    const qs = buildQuiz(jaws, quizSeed('jaws'), { trim: 'premium-le' })
    const firstGoalQ = qs.findIndex((q) => q.goal)
    assert(firstGoalQ >= 0, 'no goal question in today\'s jaws set')
    let shown = null
    openQuiz(fakeState(), { showGoalOnShots: (g) => { shown = g } })
    for (let i = 0; i < firstGoalQ; i++) {
      body.findAll('pg-quiz-opt')[0].click()
      body.findAll('pg-quiz-btn-primary')[0].click()
    }
    body.findAll('pg-quiz-opt')[0].click()
    const link = body.find('pg-quiz-link')
    assert(link, 'no Show me link on a goal question')
    link.click()
    assert(shown && shown.id === qs[firstGoalQ].goal.id, 'door not called with the question goal')
    assert(!panelOf(body), 'quiz still open after Show me')
  }))

test('all right → 5 / 5 score card; RETRY restarts; DONE closes', () =>
  withDom(({ body }) => {
    const qs = buildQuiz(jaws, quizSeed('jaws'), { trim: 'premium-le' })
    openQuiz(fakeState(), { showGoalOnShots() {} })
    for (const q of qs) {
      body.findAll('pg-quiz-opt')[q.correctIndex].click()
      body.find('pg-quiz-btn-primary').click()
    }
    assert(body.find('pg-quiz-score-num').textContent === `${qs.length} / ${qs.length}`, body.find('pg-quiz-score-num')?.textContent)
    assert(body.find('pg-quiz-score-label').textContent === 'Know this table', 'score label')
    assert(!body.find('pg-quiz-missed'), 'a perfect run listed misses')
    assert(active === body.find('pg-quiz-score-head'), 'focus not on the score')
    const retry = body.findAll('pg-quiz-btn').find((b) => b.textContent === 'RETRY')
    retry.click()
    assert(body.find('pg-quiz-eyebrow').textContent === 'Question 1 of 5', 'RETRY did not restart')
    for (const q of qs) {
      body.findAll('pg-quiz-opt')[(q.correctIndex + 1) % q.options.length].click()
      body.find('pg-quiz-btn-primary').click()
    }
    assert(body.find('pg-quiz-score-num').textContent === `0 / ${qs.length}`, 'score not reset by RETRY')
    assert(body.findAll('pg-quiz-missed-row').length === qs.length, 'misses not listed')
    body.findAll('pg-quiz-btn').find((b) => b.textContent === 'DONE').click()
    assert(!panelOf(body), 'DONE did not close')
  }))

test('live region is per question and per sheet, never a shared node', () =>
  withDom(({ body }) => {
    const a = openQuiz(fakeState(), { showGoalOnShots() {} })
    const first = body.find('pg-quiz-feedback')
    assert(first.getAttribute('role') === 'status', 'feedback is not a status region')
    assert(first.textContent === '', 'status region not empty before an answer (it must exist before it speaks)')
    body.findAll('pg-quiz-opt')[0].click()
    body.find('pg-quiz-btn-primary').click()
    const second = body.find('pg-quiz-feedback')
    assert(second && second !== first, 'question 2 reused question 1\'s live region')
    assert(second.textContent === '', 'question 2 inherited question 1\'s announcement')
    a.destroy()
    openQuiz(fakeState(), { showGoalOnShots() {} })
    const third = body.find('pg-quiz-feedback')
    assert(third !== first && third !== second, 'a reopened sheet reused a live region')
    assert(body.findAll('pg-quiz-feedback').length === 1, 'more than one live region on screen')
  }))

test('Escape closes through the shared sheet', () =>
  withDom(({ body, key }) => {
    openQuiz(fakeState(), { showGoalOnShots() {} })
    key('Escape')
    assert(!panelOf(body), 'Escape did not close')
  }))

test('no data → an explanatory empty state, never a crash', () =>
  withDom(({ body }) => {
    openQuiz({ machine: null, data: null, trim: 'pro' }, { showGoalOnShots() {} })
    assert(body.find('pg-quiz-empty'), 'no empty-state message')
    body.find('pg-quiz-btn-primary').click()
    assert(!panelOf(body), 'DONE did not close')
    openQuiz(fakeState({ shots: [], goals: [] }), { showGoalOnShots() {} })
    assert(body.find('pg-quiz-empty').textContent.includes('not enough'), 'thin-data message')
  }))

test('copy hygiene: no emoji, no machine count in quiz.ts / quiz.css', () => {
  const src = readFileSync(quizPath, 'utf8') + readFileSync(resolve(srcDir, 'ui/quiz.css'), 'utf8')
  assert(!/\p{Extended_Pictographic}/u.test(src.replace(/[›…✕]/g, '')), 'emoji found')
  assert(!/\b\d{2,3}\s+(machines|tables|games)\b/i.test(src), 'a machine count in copy')
})

// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.outcome === 'fail')
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  for (const f of failed) console.log(`  FAIL: ${f.name}`)
  process.exit(1)
}
