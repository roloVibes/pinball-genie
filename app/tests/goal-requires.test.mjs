#!/usr/bin/env node
// app/tests/goal-requires.test.mjs — SUITE 28: goal dependencies
// (dataset schema v8, 2026-08-15 — Goal.requires / Goal.requiresNote).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/goal-requires.test.mjs"
// or from app/:
//   node tests/goal-requires.test.mjs
//
// WHY THIS SUITE EXISTS. A machine's skill-shot ladder was, until this schema,
// a fact that lived in exactly one sentence of prose on exactly one goal, and
// only when whoever wrote that summary happened to mention it. Jaws' Level 1
// card said collecting it opened Level 2; Levels 2 and 3 — the cards a player
// opens to ask "why isn't this lit" — said nothing at all. The Map tab's ‹ ›
// skill-shot carousel walked those three in the right order because the FILE
// happened to list them that way, so a reorder would have shipped a ladder that
// browsed backwards with nothing failing.
//
// Everything this schema adds fails SILENTLY without a gate:
//
//   * A `requires` naming a goal that was renamed or never existed resolves to
//     nothing, and every surface renders NOTHING when a lookup misses — the
//     goal quietly stops being gated.
//   * A `requires` cycle describes a set of goals none of which can ever be
//     first. It is data corruption, not a hard game, and it leaves the
//     carousel's ladder ordering undefined.
//   * A malformed `requires` (a bare string, a list of objects) is read with
//     Array.isArray, so it renders no dependency line at all and the goal
//     simply looks ungated.
//   * `requiresNote` exists so `requires` never has to lie about a threshold
//     prerequisite — but only if it may STAND ALONE, which is the exact rule a
//     "note implies requires" check would quietly break.
//
// SECTIONS
//   1. ui/goalMeta.ts's pure helpers — shortGoalName / requiredGoals /
//      hasDependency / requiresChipText / requiresSpokenText /
//      unlocksAfterText / orderByLadder.
//   2. The Map carousel (overlay/map2d.ts's skillshotGoals + browse) against
//      the REAL shipped Jaws data, including the proof that the order is by
//      RULE and not by file luck (the same goals, shuffled, still come back in
//      ladder order) and that a machine with no `requires` is untouched.
//   3. The shipped datasets' own contract — the authored Jaws and Harry Potter
//      edges, corpus-wide resolvability/acyclicity, and copy hygiene.
//   4. MUTATION BATTERY against the real validate-machines.py: nine ways to
//      write a broken dependency, each of which must turn the exit code red,
//      plus the two shapes that must stay green (a note standing alone, and no
//      dependency at all).
//   5. Source-level wiring in app.ts / overlay/map2d.ts / styles.css.
//   6. DOM — app.ts's renderGoalDetail actually builds the chain line, with the
//      exact text, and builds nothing for an ungated goal.
//
// Pattern: step-chips.test.mjs (esbuild-bundle the REAL .ts, FakeElement DOM,
// mountApp) plus pathless-goals.test.mjs (read the REAL data/ files).
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, basename } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const srcDir = resolve(appDir, 'src')
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
const ids = (list) => list.map((g) => g.id)

// ---------------------------------------------------------------------------
// Minimal DOM stub — cribbed from step-chips.test.mjs's FakeElement (which
// cribbed card.test.mjs's). Installed BEFORE the app.ts bundle is imported:
// ui/install.ts registers window listeners at MODULE LOAD TIME.
// ---------------------------------------------------------------------------
class FakeNode {
  constructor(text) {
    this._text = text
  }
  get textContent() {
    return this._text
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.className = ''
    this.id = ''
    this.href = undefined
    this.type = undefined
    this.style = {}
    this._text = ''
    this.children = []
    this._listeners = {}
    this._attrs = {}
    this._removed = false
  }
  set textContent(v) {
    this._text = v
    this.children = []
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('')
    return this._text
  }
  set innerHTML(v) {
    this._innerHTML = v
    this.children = []
  }
  get classList() {
    const self = this
    return {
      add(...cls) {
        const set = new Set((self.className || '').split(/\s+/).filter(Boolean))
        for (const c of cls) set.add(c)
        self.className = [...set].join(' ')
      },
      contains(c) {
        return (self.className || '').split(/\s+/).filter(Boolean).includes(c)
      },
      remove(...cls) {
        const set = new Set((self.className || '').split(/\s+/).filter(Boolean))
        for (const c of cls) set.delete(c)
        self.className = [...set].join(' ')
      },
    }
  }
  get childElementCount() {
    return this.children.length
  }
  append(...n) {
    this.children.push(...n)
  }
  appendChild(n) {
    this.children.push(n)
    return n
  }
  replaceChildren(...n) {
    this.children = [...n]
  }
  setAttribute(k, v) {
    this._attrs[k] = v
  }
  getAttribute(k) {
    return this._attrs[k]
  }
  addEventListener(t, fn) {
    ;(this._listeners[t] ||= []).push(fn)
  }
  removeEventListener(t, fn) {
    this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn)
  }
  focus() {
    this._focused = true
  }
  remove() {
    this._removed = true
  }
  fire(type, evt = {}) {
    for (const fn of this._listeners[type] || []) fn(evt)
  }
  find(cls) {
    if (typeof this.className === 'string' && this.className.split(/\s+/).includes(cls)) return this
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        const hit = c.find(cls)
        if (hit) return hit
      }
    }
    return null
  }
  findAll(cls, acc = []) {
    if (typeof this.className === 'string' && this.className.split(/\s+/).includes(cls)) acc.push(this)
    for (const c of this.children) if (c instanceof FakeElement) c.findAll(cls, acc)
    return acc
  }
}

const bodyEl = new FakeElement('body')
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  location: { href: 'http://localhost/', search: '', hostname: 'localhost' },
  localStorage: {
    getItem() {
      return null
    },
    setItem() {},
    removeItem() {},
  },
}
Object.defineProperty(globalThis, 'document', {
  value: {
    createElement: (t) => new FakeElement(t),
    createElementNS: (_ns, t) => new FakeElement(t),
    createTextNode: (t) => new FakeNode(t),
    body: bodyEl,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  },
  configurable: true,
  writable: true,
})

const cssNoop = {
  name: 'css-noop',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-noop' }))
    b.onLoad({ filter: /.*/, namespace: 'css-noop' }, () => ({ contents: '', loader: 'js' }))
  },
}

async function bundle(entryPath, outName) {
  const tmp = await mkdtemp(resolve(tmpdir(), `pg-${outName}-`))
  const outfile = resolve(tmp, `${outName}.mjs`)
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    plugins: [cssNoop],
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(outfile).href)
  return { mod, tmp }
}

const { mod: goalMeta, tmp: goalMetaTmp } = await bundle(resolve(srcDir, 'ui/goalMeta.ts'), 'goalmeta')
const {
  shortGoalName,
  requiredGoals,
  hasDependency,
  requiresChipText,
  requiresSpokenText,
  unlocksAfterText,
  orderByLadder,
} = goalMeta

const { mod: mapMod, tmp: mapTmp } = await bundle(resolve(srcDir, 'overlay/map2d.ts'), 'map2d')
const { skillshotGoals, skillshotBrowseStep } = mapMod

// Real shipped data.
const goalFiles = readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))
const machines = goalFiles.map((f) => ({
  file: f,
  slug: basename(f, '_goals.json'),
  data: JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')),
}))
const byFile = new Map(machines.map((m) => [m.file, m.data]))
const jaws = byFile.get('jaws_goals.json')
const potter = byFile.get('harry_potter_goals.json')
const goalById = (data, id) => data.goals.find((g) => g.id === id)

// A tiny goal factory for the pure-helper section.
function g(id, extra = {}) {
  return { id, title: id, category: 'skillshot', summary: 's', difficulty: 1, steps: [], ...extra }
}

// ===========================================================================
section('1. ui/goalMeta.ts — the pure dependency helpers')
// ===========================================================================

test('shortGoalName strips the generic leading segment from BOTH corpus title styles', () => {
  assert(shortGoalName('Skill Shot — Level 1: Light Plunge') === 'Level 1', shortGoalName('Skill Shot — Level 1: Light Plunge'))
  assert(shortGoalName('Skill Shot -- Level 1') === 'Level 1', shortGoalName('Skill Shot -- Level 1'))
  assert(shortGoalName('Skill Shot — Level 2: Short Plunge') === 'Level 2', shortGoalName('Skill Shot — Level 2: Short Plunge'))
  return 'em-dash+colon and double-hyphen forms both reduce to the rung name'
})

test('shortGoalName leaves a separator-free title WHOLE rather than emptying it', () => {
  assert(shortGoalName('Secret Skill Shot') === 'Secret Skill Shot', shortGoalName('Secret Skill Shot'))
  assert(shortGoalName('Super Secret Skill Shot') === 'Super Secret Skill Shot', shortGoalName('Super Secret Skill Shot'))
})

test('shortGoalName does not split on an ordinary hyphenated word', () => {
  assert(shortGoalName('Mini-Wizard: 4th of July') === 'Mini-Wizard', shortGoalName('Mini-Wizard: 4th of July'))
})

test('requiredGoals resolves ids against the machine and DROPS an unresolvable one (never renders a bare id)', () => {
  const a = g('a', { title: 'Alpha' })
  const b = g('b', { title: 'Beta', requires: ['a', 'ghost-id'] })
  const data = { goals: [a, b] }
  assert(ids(requiredGoals(b, data)).join() === 'a', JSON.stringify(ids(requiredGoals(b, data))))
  assert(requiredGoals(a, data).length === 0, 'a goal with no requires resolves to []')
  assert(requiredGoals(b, null).length === 0, 'null data resolves to [] rather than throwing')
})

test('hasDependency is true for requires, true for a note STANDING ALONE, false for neither', () => {
  assert(hasDependency(g('x', { requires: ['a'] })) === true, 'requires alone')
  assert(hasDependency(g('x', { requiresNote: 'Three barrels first.' })) === true,
    'a threshold prerequisite has no goal to point at — models.ts makes the note valid on its own')
  assert(hasDependency(g('x', { requires: [] })) === false, 'an empty list is not a dependency')
  assert(hasDependency(g('x', { requiresNote: '   ' })) === false, 'whitespace is not a note')
  assert(hasDependency(g('x')) === false, 'absent is the norm')
})

test('requiresChipText shouts the SHORT name — "REQUIRES LEVEL 1"', () => {
  const l1 = g('l1', { title: 'Skill Shot — Level 1: Light Plunge' })
  const l2 = g('l2', { title: 'Skill Shot — Level 2: Short Plunge', requires: ['l1'] })
  const got = requiresChipText(l2, { goals: [l1, l2] })
  assert(got === 'REQUIRES LEVEL 1', JSON.stringify(got))
  return got
})

test('requiresChipText joins a fan-in with " + " (all of them), never the neutral middot', () => {
  const a = g('a', { title: 'Skill Shot — Level 1: Light Plunge' })
  const b = g('b', { title: 'Skill Shot — Level 2: Short Plunge' })
  const c = g('c', { title: 'Skill Shot — Level 3: Plunge Through', requires: ['a', 'b'] })
  const got = requiresChipText(c, { goals: [a, b, c] })
  assert(got === 'REQUIRES LEVEL 1 + LEVEL 2', JSON.stringify(got))
  assert(!got.includes('·'), 'the middot is this app\'s "or"-flavoured separator; requires means AND')
  return got
})

test('requiresChipText is null when nothing resolves — including a note-only goal (documented: the Map pill is goals-only)', () => {
  assert(requiresChipText(g('x'), { goals: [] }) === null, 'no dependency')
  assert(requiresChipText(g('x', { requires: ['ghost'] }), { goals: [] }) === null, 'unresolvable')
  assert(requiresChipText(g('x', { requiresNote: 'Three barrels first.' }), { goals: [] }) === null,
    'a note is a sentence — it gets its room on the Goals tab, not on the shouted map pill')
})

test('requiresSpokenText is the SENTENCE-CASE mirror of the chip (a screen reader must not be handed a shouted run)', () => {
  const l1 = g('l1', { title: 'Skill Shot — Level 1: Light Plunge' })
  const l2 = g('l2', { title: 'Skill Shot — Level 2: Short Plunge', requires: ['l1'] })
  const got = requiresSpokenText(l2, { goals: [l1, l2] })
  assert(got === 'Requires Level 1', JSON.stringify(got))
  assert(requiresSpokenText(l1, { goals: [l1, l2] }) === null, 'ungated goals say nothing extra')
  return got
})

test('unlocksAfterText uses the FULL titles and the corpus and-list', () => {
  const a = g('a', { title: 'Skill Shot — Level 1: Light Plunge' })
  const b = g('b', { title: 'Skill Shot — Level 2: Short Plunge' })
  const c = g('c', { title: 'Secret Skill Shot' })
  const one = g('one', { requires: ['a'] })
  const two = g('two', { requires: ['a', 'b'] })
  const three = g('three', { requires: ['a', 'b', 'c'] })
  const data = { goals: [a, b, c, one, two, three] }
  assert(unlocksAfterText(one, data) === 'Unlocks after: Skill Shot — Level 1: Light Plunge', unlocksAfterText(one, data))
  assert(unlocksAfterText(two, data) === 'Unlocks after: Skill Shot — Level 1: Light Plunge and Skill Shot — Level 2: Short Plunge', unlocksAfterText(two, data))
  assert(unlocksAfterText(three, data) === 'Unlocks after: Skill Shot — Level 1: Light Plunge, Skill Shot — Level 2: Short Plunge and Secret Skill Shot', unlocksAfterText(three, data))
  assert(unlocksAfterText(a, data) === null, 'an ungated goal has no chain line at all')
})

// ---- orderByLadder --------------------------------------------------------

test('orderByLadder sorts a ladder listed BACKWARDS into ladder order (the whole point — order by rule, not by file luck)', () => {
  const l3 = g('l3', { requires: ['l2'] })
  const l2 = g('l2', { requires: ['l1'] })
  const l1 = g('l1')
  const got = ids(orderByLadder([l3, l2, l1]))
  assert(got.join() === 'l1,l2,l3', got.join())
  return `[l3, l2, l1] -> [${got.join(', ')}]`
})

test('unchained goals come AFTER the ladder, in dataset order', () => {
  const l1 = g('l1')
  const l2 = g('l2', { requires: ['l1'] })
  const secret = g('secret')
  const superSecret = g('super-secret')
  const got = ids(orderByLadder([secret, l2, superSecret, l1]))
  assert(got.join() === 'l1,l2,secret,super-secret', got.join())
  return `[secret, l2, super-secret, l1] -> [${got.join(', ')}]`
})

test('a list with NO requires anywhere comes back byte-identical (a machine without a ladder is untouched)', () => {
  const list = [g('a'), g('b'), g('c')]
  const got = orderByLadder(list)
  assert(ids(got).join() === 'a,b,c', ids(got).join())
  assert(got.every((x, i) => x === list[i]), 'the same object references, in the same order')
})

test('a fan-in (two prerequisites) still topologically orders, ties broken on DATASET order', () => {
  const a = g('a')
  const b = g('b')
  const c = g('c', { requires: ['b', 'a'] })
  // Dataset order here is [c, b, a], so b (index 1) precedes a (index 2) —
  // the tie-break is the FILE's order, deliberately, not the order the
  // `requires` list happens to name them in and not alphabetical.
  const got = ids(orderByLadder([c, b, a]))
  assert(got.indexOf('a') < got.indexOf('c') && got.indexOf('b') < got.indexOf('c'),
    `both prerequisites must precede what they gate: ${got.join()}`)
  assert(got.join() === 'b,a,c', `ties must break on dataset index, got ${got.join()}`)
  return `[c, b, a] -> [${got.join(', ')}]`
})

test('a requires pointing OUTSIDE the list leaves the goal unchained rather than pretending to place it', () => {
  const a = g('a', { requires: ['a-mode-in-another-category'] })
  const b = g('b')
  const got = ids(orderByLadder([a, b]))
  assert(got.join() === 'a,b', got.join())
})

test('self-reference cannot reorder anything (validator errors on it; the UI must still not hang or drop it)', () => {
  const a = g('a', { requires: ['a'] })
  const b = g('b')
  const got = ids(orderByLadder([a, b]))
  assert(got.length === 2 && got.includes('a') && got.includes('b'), got.join())
})

test('a CYCLE loses nothing — every goal still browses, none twice (corrupt data must not shorten the carousel)', () => {
  const a = g('a', { requires: ['b'] })
  const b = g('b', { requires: ['a'] })
  const c = g('c')
  const got = ids(orderByLadder([a, b, c]))
  assert(got.length === 3, `expected 3 entries, got ${got.length}: ${got.join()}`)
  assert(new Set(got).size === 3, `expected no duplicates, got ${got.join()}`)
  return `cycle a<->b plus c -> [${got.join(', ')}]`
})

test('orderByLadder is deterministic and does not mutate its input', () => {
  const list = [g('l3', { requires: ['l2'] }), g('l2', { requires: ['l1'] }), g('l1')]
  const before = ids(list).join()
  const first = ids(orderByLadder(list)).join()
  const second = ids(orderByLadder(list)).join()
  assert(first === second, `${first} vs ${second}`)
  assert(ids(list).join() === before, 'the caller\'s array was reordered in place')
})

// ===========================================================================
section('2. The Map carousel (overlay/map2d.ts) on the REAL shipped data')
// ===========================================================================

const JAWS_LADDER = ['skillshot-level-1', 'skillshot-level-2', 'skillshot-level-3', 'skillshot-secret', 'skillshot-super-secret']

test('skillshotGoals(jaws) browses the ladder in rung order, secrets after', () => {
  const got = ids(skillshotGoals(jaws))
  assert(got.join() === JAWS_LADDER.join(), got.join())
  return got.join(' → ')
})

test('THE ORDER IS BY RULE, NOT BY FILE LUCK: reverse the file\'s goal order and the carousel is unchanged', () => {
  // Jaws already lists its ladder in the right order, so the shipped case
  // alone proves nothing about the sort. Reversing the file is what separates
  // "sorted" from "happened to be in order".
  const reversed = { ...jaws, goals: [...jaws.goals].reverse() }
  const got = ids(skillshotGoals(reversed))
  assert(got.slice(0, 3).join() === 'skillshot-level-1,skillshot-level-2,skillshot-level-3',
    `ladder came back as ${got.join()}`)
  assert(new Set(got).size === JAWS_LADDER.length, `expected the same ${JAWS_LADDER.length} skill shots, got ${got.join()}`)
  // The unchained pair follows the (now reversed) dataset order, by contract.
  assert(got.slice(3).join() === 'skillshot-super-secret,skillshot-secret', got.slice(3).join())
  return `reversed file -> [${got.join(', ')}]`
})

test('skillshotGoals(harry potter) browses its ladder in rung order', () => {
  const got = ids(skillshotGoals(potter))
  assert(got.join() === 'skillshot-level-1,skillshot-level-2,skillshot-level-3', got.join())
  return got.join(' → ')
})

test('a machine with NO requires anywhere browses in unchanged dataset order', () => {
  const plain = machines.find((m) => {
    const sk = (m.data.goals || []).filter((x) => x.category === 'skillshot')
    return sk.length >= 2 && sk.every((x) => !Array.isArray(x.requires) || x.requires.length === 0)
  })
  assert(plain, 'no ungated multi-skill-shot machine in the corpus to compare against')
  const raw = ids((plain.data.goals || []).filter((x) => x.category === 'skillshot'))
  const got = ids(skillshotGoals(plain.data))
  assert(got.join() === raw.join(), `${plain.file}: ${got.join()} vs raw ${raw.join()}`)
  return `${plain.file}: [${raw.join(', ')}] unchanged`
})

test('walking › from Level 1 visits the whole ladder in order and wraps back to the start', () => {
  const list = skillshotGoals(jaws)
  const seen = [list[0].id]
  let cur = list[0]
  for (let i = 0; i < list.length; i++) {
    const next = skillshotBrowseStep(list, cur, 0, 1)
    cur = next.goal
    seen.push(cur.id)
  }
  assert(seen.slice(0, JAWS_LADDER.length).join() === JAWS_LADDER.join(), seen.join())
  assert(seen[seen.length - 1] === JAWS_LADDER[0], `expected the walk to wrap, ended on ${seen[seen.length - 1]}`)
  return seen.join(' → ')
})

test('every gated Jaws rung carries a REQUIRES chip; the ungated ones carry none', () => {
  const chips = skillshotGoals(jaws).map((x) => [x.id, requiresChipText(x, jaws)])
  const table = Object.fromEntries(chips)
  assert(table['skillshot-level-1'] === null, `level 1 is the entry rung: ${table['skillshot-level-1']}`)
  assert(table['skillshot-level-2'] === 'REQUIRES LEVEL 1', table['skillshot-level-2'])
  assert(table['skillshot-level-3'] === 'REQUIRES LEVEL 2', table['skillshot-level-3'])
  assert(table['skillshot-secret'] === null, `the secret skill shots are not ladder rungs: ${table['skillshot-secret']}`)
  assert(table['skillshot-super-secret'] === null, `the secret skill shots are not ladder rungs: ${table['skillshot-super-secret']}`)
  return chips.map(([id, c]) => `${id}: ${c ?? '—'}`).join(' | ')
})

// ===========================================================================
section('3. The shipped datasets\' own contract')
// ===========================================================================

test('Jaws: Level 2 requires Level 1, Level 3 requires Level 2', () => {
  assert(JSON.stringify(goalById(jaws, 'skillshot-level-2').requires) === '["skillshot-level-1"]',
    JSON.stringify(goalById(jaws, 'skillshot-level-2').requires))
  assert(JSON.stringify(goalById(jaws, 'skillshot-level-3').requires) === '["skillshot-level-2"]',
    JSON.stringify(goalById(jaws, 'skillshot-level-3').requires))
})

test('Jaws: the secret and super-secret skill shots carry NO requires — they are alternate ways to collect the CURRENT level, not rungs above it', () => {
  for (const id of ['skillshot-secret', 'skillshot-super-secret']) {
    const goal = goalById(jaws, id)
    assert(!goal.requires, `${id} must not be gated on the ladder: ${JSON.stringify(goal.requires)}`)
  }
})

test('Jaws: both gated rungs carry the next-ball timing note, so `requires` cannot be read as "immediately"', () => {
  for (const id of ['skillshot-level-2', 'skillshot-level-3']) {
    const note = goalById(jaws, id).requiresNote
    assert(typeof note === 'string' && note.trim(), `${id} has no requiresNote`)
    assert(/next ball/i.test(note), `${id}'s note does not state when the ladder steps up: ${note}`)
  }
})

test('Jaws: no goal still claims the level steps up on the next PLUNGE (the rulesheet says start of each ball)', () => {
  for (const goal of jaws.goals) {
    const text = `${goal.summary} ${goal.reward || ''} ${goal.requiresNote || ''}`
    assert(!/next plunge/i.test(text), `${goal.id} still says "next plunge": ${text}`)
  }
})

test('Harry Potter: Level 2 requires Level 1, Level 3 requires Level 2', () => {
  assert(JSON.stringify(goalById(potter, 'skillshot-level-2').requires) === '["skillshot-level-1"]',
    JSON.stringify(goalById(potter, 'skillshot-level-2').requires))
  assert(JSON.stringify(goalById(potter, 'skillshot-level-3').requires) === '["skillshot-level-2"]',
    JSON.stringify(goalById(potter, 'skillshot-level-3').requires))
})

test('every gated goal states its dependency in its own PROSE too — the data and the card cannot disagree', () => {
  // The chain line renders from `requires`; the summary is what a player reads
  // first. A rung gated in data but silent in prose is the exact half-told
  // story this schema was built to end.
  const gated = machines.flatMap((m) => (m.data.goals || []).filter((x) => Array.isArray(x.requires) && x.requires.length).map((x) => ({ ...x, __file: m.file, __data: m.data })))
  assert(gated.length > 0, 'no gated goals in the corpus — this suite would be vacuous')
  for (const goal of gated) {
    const names = requiredGoals(goal, goal.__data).map((r) => shortGoalName(r.title))
    const prose = `${goal.summary} ${goal.reward || ''}`
    for (const n of names) {
      assert(prose.toLowerCase().includes(n.toLowerCase()),
        `${goal.__file}:${goal.id} is gated on "${n}" but never names it in its own summary/reward`)
    }
  }
  return `${gated.length} gated goals, every prerequisite named in prose`
})

test('corpus-wide: every requires entry resolves IN THE SAME FILE, with no self-reference', () => {
  let edges = 0
  for (const m of machines) {
    const known = new Set((m.data.goals || []).map((x) => x.id))
    for (const goal of m.data.goals || []) {
      if (goal.requires == null) continue
      assert(Array.isArray(goal.requires), `${m.file}:${goal.id} requires is not a list`)
      for (const r of goal.requires) {
        assert(typeof r === 'string' && r.trim(), `${m.file}:${goal.id} requires entry is not an id string`)
        assert(r !== goal.id, `${m.file}:${goal.id} requires itself`)
        assert(known.has(r), `${m.file}:${goal.id} requires unknown goal '${r}'`)
        edges++
      }
      assert(new Set(goal.requires).size === goal.requires.length, `${m.file}:${goal.id} lists a prerequisite twice`)
    }
  }
  return `${edges} dependency edges, all resolvable`
})

test('corpus-wide: the dependency graph is ACYCLIC in every machine', () => {
  for (const m of machines) {
    const deps = new Map((m.data.goals || []).map((x) => [x.id, (Array.isArray(x.requires) ? x.requires : []).filter((r) => typeof r === 'string')]))
    const state = new Map()
    const visit = (id, path) => {
      const c = state.get(id)
      if (c === 2) return
      assert(c !== 1, `${m.file}: requires cycle ${[...path, id].join(' -> ')}`)
      state.set(id, 1)
      for (const r of deps.get(id) || []) if (deps.has(r)) visit(r, [...path, id])
      state.set(id, 2)
    }
    for (const id of deps.keys()) visit(id, [])
  }
})

test('corpus-wide: requiresNote, where present, is non-empty text', () => {
  for (const m of machines) {
    for (const goal of m.data.goals || []) {
      if (goal.requiresNote == null) continue
      assert(typeof goal.requiresNote === 'string' && goal.requiresNote.trim(),
        `${m.file}:${goal.id} requiresNote is empty`)
    }
  }
})

// Same regex, same reason, as pathless-goals.test.mjs §11d: this copy ships to
// players, so it must not read like the research that produced it.
const PROVENANCE = /according to|sources? say|the community (?:says|reports|believes|agrees|considers|thinks|regards|rates)|reportedly|it is said|rulesheet|tiltforums|pinside|\battributed to\b|\bapparently\b|players report|is believed|\bsupposedly\b/i

test('no research/provenance voice in any dependency copy', () => {
  let checked = 0
  for (const m of machines) {
    for (const goal of m.data.goals || []) {
      if (!hasDependency(goal)) continue
      for (const [field, text] of [['summary', goal.summary], ['reward', goal.reward || ''], ['requiresNote', goal.requiresNote || '']]) {
        const hit = String(text).match(PROVENANCE)
        assert(!hit, `${m.file}:${goal.id} ${field} contains research voice: "${hit && hit[0]}"`)
      }
      checked++
    }
  }
  return `${checked} goals with dependencies, all clean`
})

// ===========================================================================
section('4. MUTATION BATTERY — the real validate-machines.py must turn red')
// ===========================================================================

// A trimmed copy of the repo layout: the validator resolves DATA from its own
// __file__ (parents[2]/data), so it needs app/scripts/ + data/ and nothing
// else. One machine + a one-entry catalog keeps each run at a few
// milliseconds, so the whole battery is cheap enough to be exhaustive.
const mutRoot = await mkdtemp(resolve(tmpdir(), 'pg-requires-mut-'))
mkdirSync(resolve(mutRoot, 'app/scripts'), { recursive: true })
mkdirSync(resolve(mutRoot, 'data'), { recursive: true })
copyFileSync(validatorPath, resolve(mutRoot, 'app/scripts/validate-machines.py'))
const catalog = JSON.parse(readFileSync(resolve(dataDir, 'catalog.json'), 'utf8'))
writeFileSync(
  resolve(mutRoot, 'data/catalog.json'),
  JSON.stringify(catalog.filter((e) => e.resource === 'jaws_goals'), null, 2),
)

/** Writes `mutate(jaws)` into the trimmed tree and returns the validator's
 *  DIRECT exit code plus its ERROR lines. Exit code, never a grepped tail —
 *  scripts/run-tests.mjs's own rule, for the same reason. */
function runValidator(mutate) {
  const doc = JSON.parse(JSON.stringify(jaws))
  mutate(doc, (id) => doc.goals.find((x) => x.id === id))
  writeFileSync(resolve(mutRoot, 'data/jaws_goals.json'), JSON.stringify(doc, null, 2))
  const res = spawnSync('python3', [resolve(mutRoot, 'app/scripts/validate-machines.py')], {
    cwd: mutRoot,
    encoding: 'utf8',
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`
  return { status: res.status, errors: out.split('\n').filter((l) => l.startsWith('ERROR ')) }
}

test('BASELINE: the shipped Jaws file (with its real ladder) validates clean — otherwise every mutation below is vacuous', () => {
  const { status, errors } = runValidator(() => {})
  assert(status === 0, `expected exit 0, got ${status}:\n${errors.join('\n')}`)
  assert(errors.length === 0, errors.join('\n'))
})

const MUTATIONS = [
  ['requires names a goal that does not exist', (d, find) => { find('skillshot-level-2').requires = ['no-such-goal'] }, /unknown goal/],
  ['a goal requires ITSELF', (d, find) => { find('skillshot-level-2').requires = ['skillshot-level-2'] }, /names itself/],
  ['a two-goal cycle', (d, find) => { find('skillshot-level-1').requires = ['skillshot-level-2'] }, /cycle/],
  ['a three-goal cycle', (d, find) => { find('skillshot-level-1').requires = ['skillshot-level-3'] }, /cycle/],
  ['requires is a bare string, not a list', (d, find) => { find('skillshot-level-2').requires = 'skillshot-level-1' }, /must be a list/],
  ['a requires entry is not a string', (d, find) => { find('skillshot-level-2').requires = [42] }, /not a goal id string/],
  ['a requires entry is an empty string', (d, find) => { find('skillshot-level-2').requires = [''] }, /not a goal id string/],
  ['the same prerequisite listed twice', (d, find) => { find('skillshot-level-3').requires = ['skillshot-level-2', 'skillshot-level-2'] }, /same goal twice/],
  ['requiresNote is an empty string', (d, find) => { find('skillshot-level-2').requiresNote = '   ' }, /must be non-empty text/],
  ['requiresNote is not text', (d, find) => { find('skillshot-level-2').requiresNote = ['a note'] }, /must be non-empty text/],
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

test('GREEN: requiresNote STANDING ALONE, with no requires beside it, is valid (models.ts: a threshold has no goal to point at)', () => {
  const { status, errors } = runValidator((d, find) => {
    const goal = find('skillshot-secret')
    goal.requiresNote = 'The plunge has to reach the flippers untouched before this one counts.'
  })
  assert(status === 0, `expected exit 0, got ${status}:\n${errors.join('\n')}`)
})

test('GREEN: no dependency fields at all is valid (absent is the norm)', () => {
  const { status, errors } = runValidator((d) => {
    for (const goal of d.goals) {
      delete goal.requires
      delete goal.requiresNote
    }
  })
  assert(status === 0, `expected exit 0, got ${status}:\n${errors.join('\n')}`)
})

// ===========================================================================
section('5. Source-level wiring')
// ===========================================================================

const appSrc = readFileSync(resolve(srcDir, 'app.ts'), 'utf8')
const mapSrc = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
const cssSrc = readFileSync(resolve(srcDir, 'styles.css'), 'utf8')
const modelsSrc = readFileSync(resolve(srcDir, 'models.ts'), 'utf8')

test('models.ts declares BOTH fields as optional and additive', () => {
  assert(/requires\?: string\[\] \| null/.test(modelsSrc), 'Goal.requires is not declared as an optional string[]')
  assert(/requiresNote\?: string \| null/.test(modelsSrc), 'Goal.requiresNote is not declared as an optional string')
})

test('map2d.ts\'s skillshotGoals sorts through orderByLadder rather than returning file order', () => {
  const fn = mapSrc.match(/export function skillshotGoals\([\s\S]*?\n\}/)
  assert(fn, 'could not find skillshotGoals in map2d.ts')
  assert(/orderByLadder\(/.test(fn[0]), 'skillshotGoals no longer sorts by ladder — the carousel is back on file order')
})

test('map2d.ts fills the skill-shot readout meta line from requiresChipText (not hardcoded hidden)', () => {
  assert(/requiresChipText\(goal, state\.data\)/.test(mapSrc), 'the readout does not derive its chip from requiresChipText')
  assert(!/readoutMeta\.hidden = true\n\s*readoutMeta\.textContent = ''/.test(mapSrc),
    'the skill-shot branch still hardcodes an empty meta row — a gated rung would browse with nothing saying so')
})

test('map2d.ts speaks the dependency too (a chip only the sighted user gets is half a feature)', () => {
  assert(/requiresSpokenText\(goal, state\.data\)/.test(mapSrc), 'spokenReadout does not mirror the chip')
})

test('app.ts renders the chain line AFTER the reward and BEFORE the pathless early-return', () => {
  assert(/import \{[\s\S]*?hasDependency[\s\S]*?\} from '\.\/ui\/goalMeta'/.test(appSrc), 'app.ts does not import hasDependency')
  assert(/import \{[\s\S]*?unlocksAfterText[\s\S]*?\} from '\.\/ui\/goalMeta'/.test(appSrc), 'app.ts does not import unlocksAfterText')
  const rewardIdx = appSrc.indexOf("reward.className = 'goal-detail-reward'")
  const chainIdx = appSrc.indexOf('if (hasDependency(goal))')
  const pathlessIdx = appSrc.indexOf('if (isPathless(goal))')
  const walkerIdx = appSrc.indexOf("stepsWrap.className = 'goal-steps'")
  assert(rewardIdx > -1 && chainIdx > -1 && pathlessIdx > -1 && walkerIdx > -1, 'could not locate all four anchors in app.ts')
  assert(rewardIdx < chainIdx, 'the chain line must follow the reward callout')
  assert(chainIdx < pathlessIdx,
    'the chain line must be built BEFORE the pathless early-return, or a gated secret/progression goal silently loses it')
  assert(chainIdx < walkerIdx, 'the chain line is a precondition — it belongs above the route, not after it')
})

test('styles.css defines the chain line and uses only tokens for its colours', () => {
  const block = cssSrc.match(/\.goal-detail-requires \{[\s\S]*?\}/)
  assert(block, 'no .goal-detail-requires rule in styles.css')
  assert(/\.goal-detail-requires-note \{[\s\S]*?\}/.test(cssSrc), 'no .goal-detail-requires-note rule')
  assert(!/#[0-9a-f]{3,8}/i.test(block[0]), `the chain line carries a literal colour: ${block[0]}`)
})

// ===========================================================================
section('6. DOM — app.ts renderGoalDetail builds the chain line')
// ===========================================================================

const { mod: appMod, tmp: appTmp } = await bundle(resolve(srcDir, 'app.ts'), 'app')
const { mountApp } = appMod

const domShots = [{ id: 'ramp', name: 'Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all' }]
const domL1 = {
  id: 'sk-1', title: 'Skill Shot — Level 1: Light Plunge', category: 'skillshot',
  summary: 'The entry rung.', difficulty: 1, steps: [{ shot: 'ramp', action: 'Plunge' }],
}
const domL2 = {
  id: 'sk-2', title: 'Skill Shot — Level 2: Short Plunge', category: 'skillshot',
  summary: 'Level 1 has to be banked first.', difficulty: 2, reward: '10M',
  requires: ['sk-1'],
  requiresNote: 'The ladder steps up at the start of your next ball.',
  steps: [{ shot: 'ramp', action: 'Plunge' }],
}

function mountWith(selected) {
  const machine = { id: 'test-machine', name: 'Test Machine', shortTitle: 'Test', resource: 'test_goals' }
  const data = { machine: 'Test Machine', shots: domShots, goals: [domL1, domL2], sources: [] }
  const state = {
    machines: [machine], machine, data,
    shotsByID: new Map(domShots.map((s) => [s.id, s])),
    selectedGoal: selected, stepIndex: 0, ballPosition: 'any', highlightMode: 'auto',
    trailStyle: 'dash', ballTracer: true, routeStartedAt: 0, trim: 'premium-le',
    setTrailStyle() {}, setBallTracer() {}, async selectMachine() {}, select() {},
    clearSelection() {}, nextStep() {}, prevStep() {}, goToStep() {}, restartGoal() {},
    pauseHighlight() {}, resumeHighlight() {}, onChange() { return () => {} },
  }
  const root = new FakeElement('div')
  mountApp(root, state)
  return root
}

test('a gated goal renders .goal-detail-requires with BOTH the chain line and the note', () => {
  const root = mountWith(domL2)
  const chain = root.find('goal-detail-requires')
  assert(chain, 'no .goal-detail-requires element rendered for a goal with requires')
  const line = chain.find('goal-detail-requires-line')
  assert(line, 'no .goal-detail-requires-line')
  assert(line.textContent === 'Unlocks after: Skill Shot — Level 1: Light Plunge', JSON.stringify(line.textContent))
  const note = chain.find('goal-detail-requires-note')
  assert(note, 'no .goal-detail-requires-note')
  assert(note.textContent === 'The ladder steps up at the start of your next ball.', JSON.stringify(note.textContent))
  return `${line.textContent} / ${note.textContent}`
})

test('an ungated goal renders NO chain line at all (absence is the norm — no empty row)', () => {
  const root = mountWith(domL1)
  assert(!root.find('goal-detail-requires'), 'an ungated goal rendered a dependency element')
})

test('the chain line renders BELOW the reward and ABOVE the steps in the built tree', () => {
  const root = mountWith(domL2)
  const detail = root.find('goal-detail')
  assert(detail, 'no .goal-detail wrapper')
  const classOf = (el) => (el && typeof el.className === 'string' ? el.className : '')
  const order = detail.children.map(classOf)
  const iReward = order.findIndex((c) => c.split(/\s+/).includes('goal-detail-reward'))
  const iChain = order.findIndex((c) => c.split(/\s+/).includes('goal-detail-requires'))
  const iSteps = order.findIndex((c) => c.split(/\s+/).includes('goal-steps'))
  assert(iReward > -1 && iChain > -1 && iSteps > -1, `missing a section: ${order.join(' | ')}`)
  assert(iReward < iChain && iChain < iSteps, `unexpected order: ${order.join(' | ')}`)
  return order.filter(Boolean).join(' | ')
})

// ---------------------------------------------------------------------------
await rm(goalMetaTmp, { recursive: true, force: true })
await rm(mapTmp, { recursive: true, force: true })
await rm(appTmp, { recursive: true, force: true })
await rm(mutRoot, { recursive: true, force: true })

const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed) {
  console.log('\nFAILED:')
  for (const r of results.filter((x) => x.outcome === 'fail')) console.log(`  - ${r.name}`)
  process.exit(1)
}
