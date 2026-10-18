#!/usr/bin/env node
// app/tests/step-chips.test.mjs — SUITE 14: choreography provenance +
// technique chips (phase B1/B2, 2026-08-10, ui/goalMeta.ts's
// stepProvenance/stepChips).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/step-chips.test.mjs"
// or from app/:
//   node tests/step-chips.test.mjs
//
// WHAT THIS SUITE COVERS. Schema v5's ease layer (GoalStep.technique/plunge/
// plungeTo/flipper, Shot.feeds/feedsByTrim/flipper) makes every step able to
// teach TWO things beyond "shoot this next": where the ball comes FROM
// (stepProvenance — "FROM RIGHT FLIPPER · LEFT-RAMP RETURN") and HOW the shot
// is physically made (stepChips — technique + derived plunge chips). Both are
// pure functions in ui/goalMeta.ts so app.ts's Goals-tab step rows and
// overlay/map2d.ts's step readout render from exactly one derivation each.
//
//   1. stepProvenance — the flipper+feed derivation rule, including the two
//      "stay honest" branches: a named-but-unresolvable feed still asserts
//      the (independently authored) flipper line, while a coordinates-only
//      feed must geometrically agree with that flipper or the whole line is
//      dropped rather than asserting a contradiction.
//   2. stepChips — technique[] verbatim + derived SOFT/FULL PLUNGE chips,
//      always last, never read from `technique` (models.ts is explicit that
//      plunge strength is NOT in that vocabulary).
//   3. DOM — app.ts's renderGoalDetail actually renders .goal-step-provenance
//      and .goal-step-chip elements from those two helpers, and renders
//      neither for a step that earns neither.
//
// Pattern: identical to card.test.mjs — esbuild bundles the REAL .ts source
// (never edited, never copied) into a temp ESM file, dynamically imported and
// exercised. Section 3 cribs card.test.mjs's mountApp() execution harness
// (FakeElement + window/document stubs) verbatim, with one addition: a real
// `style` object on FakeElement, since this phase is the first to need
// `.style.borderColor =` (the chip's category-tinted border) — card.test.mjs
// never exercised a code path that sets `.style.*` on a live FakeElement, so
// its own copy of the class doesn't need one.
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const goalMetaPath = resolve(srcDir, 'ui/goalMeta.ts')
const appPath = resolve(srcDir, 'app.ts')

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
// Minimal DOM stub — cribbed from card.test.mjs's FakeElement, PLUS a real
// `style` object (see this file's header comment for why).
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
    this.tagName = tag.toUpperCase()
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
      // The real DOM has remove(); this fake did not, and app.ts's header
      // legitimately calls it (P6 L5's one-time picker pulse is a class that
      // has to come OFF once the hint is retired). A harness that only models
      // half of an API turns a correct call into a crash inside a render.
      remove(...cls) {
        const set = new Set((self.className || '').split(/\s+/).filter(Boolean))
        for (const c of cls) set.delete(c)
        self.className = [...set].join(' ')
      },
    }
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
  /** Depth-first find/findAll by class — same technique every other suite
   *  here uses, so a harmless future reorder of sibling elements doesn't
   *  break these tests on layout position alone. */
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

// install.ts (pulled in transitively via app.ts -> ui/howto.ts -> ui/install.ts)
// registers 'beforeinstallprompt'/'appinstalled' listeners at MODULE LOAD
// TIME — so `window` must exist with a working addEventListener before the
// app.ts bundle is even imported, not just before mountApp() runs (same
// requirement card.test.mjs's section 6 documents).
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

const { mod: goalMetaMod, tmp: goalMetaTmp } = await bundle(goalMetaPath, 'goalmeta')
const { stepProvenance, stepChips } = goalMetaMod

// ===========================================================================
section('1. stepProvenance — flipper + inbound-feed derivation')
// ===========================================================================

function goalOf(steps, category = 'combo') {
  return { id: 'g-test', title: 'Test Goal', category, summary: 's', difficulty: 1, steps }
}

// ---- (a) full case: named, resolvable feed + authored flipper ----
const shotsA = new Map([
  ['left-ramp', { id: 'left-ramp', name: 'Left Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all', feeds: { shot: 'right-inlane' } }],
  ['right-inlane', { id: 'right-inlane', name: 'Right Inlane', type: 'lane', x: 0.64, y: 0.1, trim: 'all' }],
  ['right-ramp', { id: 'right-ramp', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all', flipper: 'right' }],
])
const goalA = goalOf([
  { shot: 'left-ramp', action: 'Shoot the left ramp' },
  { shot: 'right-ramp', action: 'Shoot the right ramp' },
])

test('named + resolvable feed, authored flipper -> "FROM RIGHT FLIPPER · RIGHT INLANE RETURN"', () => {
  const got = stepProvenance(goalA, 1, shotsA)
  assert(got === 'FROM RIGHT FLIPPER · RIGHT INLANE RETURN', `got ${JSON.stringify(got)}`)
  return got
})

test('step 0 (first step) is always null — no previous step to feed from', () => {
  const got = stepProvenance(goalA, 0, shotsA)
  assert(got === null, `got ${JSON.stringify(got)}`)
})

// ---- (c) named but unresolvable feed (shot id doesn't exist) ----
const shotsC = new Map([
  ['left-ramp', { id: 'left-ramp', name: 'Left Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all', feeds: { shot: 'ghost-shot-id' } }],
  ['right-ramp-flip', { id: 'right-ramp-flip', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all', flipper: 'right' }],
  ['right-ramp-noflip', { id: 'right-ramp-noflip', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all' }],
])
const goalC1 = goalOf([{ shot: 'left-ramp', action: 'a' }, { shot: 'right-ramp-flip', action: 'b' }])
const goalC2 = goalOf([{ shot: 'left-ramp', action: 'a' }, { shot: 'right-ramp-noflip', action: 'b' }])

test('unresolvable feed (named shot id doesn\'t exist) + authored flipper -> bare "FROM RIGHT FLIPPER"', () => {
  const got = stepProvenance(goalC1, 1, shotsC)
  assert(got === 'FROM RIGHT FLIPPER', `got ${JSON.stringify(got)}`)
  return got
})

test('unresolvable feed + NO authored flipper -> null (the AND condition, not just the feed)', () => {
  const got = stepProvenance(goalC2, 1, shotsC)
  assert(got === null, `got ${JSON.stringify(got)}`)
})

test('no-flipper step -> null even with a perfectly good resolvable named feed (goalA\'s feed chain)', () => {
  // Reuse shotsA's left-ramp/right-inlane feed chain, but the step-1 shot
  // carries no flipper at all and the step has no override either.
  const shots = new Map(shotsA)
  shots.set('no-flipper-shot', { id: 'no-flipper-shot', name: 'No Flipper Shot', type: 'standup', x: 0.5, y: 0.4, trim: 'all' })
  const goal = goalOf([{ shot: 'left-ramp', action: 'a' }, { shot: 'no-flipper-shot', action: 'b' }])
  const got = stepProvenance(goal, 1, shots)
  assert(got === null, `got ${JSON.stringify(got)}`)
})

// ---- coordinates-only feed: must geometrically agree with the flipper ----
const shotsD = new Map([
  ['left-ramp-xy-match', { id: 'left-ramp-xy-match', name: 'Left Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all', feeds: { x: 0.7, y: 0.1 } }],
  ['left-ramp-xy-mismatch', { id: 'left-ramp-xy-mismatch', name: 'Left Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all', feeds: { x: 0.2, y: 0.1 } }],
  ['right-ramp-flip2', { id: 'right-ramp-flip2', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all', flipper: 'right' }],
])

test('coordinates-only feed whose landing side AGREES with the flipper -> bare flipper line (no source part)', () => {
  const goal = goalOf([{ shot: 'left-ramp-xy-match', action: 'a' }, { shot: 'right-ramp-flip2', action: 'b' }])
  const got = stepProvenance(goal, 1, shotsD)
  assert(got === 'FROM RIGHT FLIPPER', `got ${JSON.stringify(got)}`)
  return got
})

test('coordinates-only feed whose landing side CONTRADICTS the flipper -> null (never guess)', () => {
  const goal = goalOf([{ shot: 'left-ramp-xy-mismatch', action: 'a' }, { shot: 'right-ramp-flip2', action: 'b' }])
  const got = stepProvenance(goal, 1, shotsD)
  assert(got === null, `got ${JSON.stringify(got)}`)
})

test('no feed authored at all on the previous step/shot -> null', () => {
  const shots = new Map([
    ['plain-shot', { id: 'plain-shot', name: 'Plain Shot', type: 'standup', x: 0.5, y: 0.5, trim: 'all' }],
    ['right-ramp-flip3', { id: 'right-ramp-flip3', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all', flipper: 'right' }],
  ])
  const goal = goalOf([{ shot: 'plain-shot', action: 'a' }, { shot: 'right-ramp-flip3', action: 'b' }])
  const got = stepProvenance(goal, 1, shots)
  assert(got === null, `got ${JSON.stringify(got)}`)
})

test('defensive: empty steps array and out-of-range index both -> null', () => {
  assert(stepProvenance(goalOf([]), 0, shotsA) === null, 'empty steps')
  assert(stepProvenance(goalA, 5, shotsA) === null, 'out of range')
})

// ===========================================================================
section('2. stepChips — technique[] verbatim + derived plunge chips')
// ===========================================================================

test("technique ['backhand','late-flip'] + plunge 'partial' -> BACKHAND, LATE FLIP, SOFT PLUNGE (derived last)", () => {
  const chips = stepChips({ shot: 's', action: 'a', technique: ['backhand', 'late-flip'], plunge: 'partial' })
  const labels = chips.map((c) => c.label)
  assert(labels.join('|') === 'BACKHAND|LATE FLIP|SOFT PLUNGE', `got ${JSON.stringify(labels)}`)
  assert(chips[0].term === 'backhand' && chips[1].term === 'late-flip', 'technique chips must carry their vocab term')
  assert(chips[2].term === null, 'derived plunge chip must carry term:null (not in the technique vocabulary)')
  return labels.join(', ')
})

test('no technique, no plunge -> []', () => {
  const chips = stepChips({ shot: 's', action: 'a' })
  assert(Array.isArray(chips) && chips.length === 0, `got ${JSON.stringify(chips)}`)
})

test("plunge 'full' alone -> [FULL PLUNGE]", () => {
  const chips = stepChips({ shot: 's', action: 'a', plunge: 'full' })
  assert(chips.length === 1 && chips[0].label === 'FULL PLUNGE' && chips[0].term === null, `got ${JSON.stringify(chips)}`)
})

test('plunge is NEVER read from technique[] even if the string appears there (derivation only, per models.ts)', () => {
  const chips = stepChips({ shot: 's', action: 'a', technique: ['nudge'], plunge: null })
  assert(chips.length === 1 && chips[0].label === 'NUDGE', `got ${JSON.stringify(chips)}`)
})

test('hyphens become spaces in the label; the vocab string itself is preserved as term', () => {
  const chips = stepChips({ shot: 's', action: 'a', technique: ['on-the-fly', 'drop-catch'] })
  assert(chips[0].label === 'ON THE FLY' && chips[0].term === 'on-the-fly', `got ${JSON.stringify(chips[0])}`)
  assert(chips[1].label === 'DROP CATCH' && chips[1].term === 'drop-catch', `got ${JSON.stringify(chips[1])}`)
})

await rm(goalMetaTmp, { recursive: true, force: true })

// ===========================================================================
section('3. DOM — app.ts renderGoalDetail renders provenance + chips')
// ===========================================================================

const { mod: appMod, tmp: appTmp } = await bundle(appPath, 'app')
const { mountApp } = appMod

const domShots = [
  { id: 'left-ramp', name: 'Left Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all' },
  { id: 'right-inlane', name: 'Right Inlane', type: 'lane', x: 0.64, y: 0.1, trim: 'all' },
  { id: 'right-ramp', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all' },
  { id: 'center-shot', name: 'Center Shot', type: 'standup', x: 0.5, y: 0.4, trim: 'all' },
]
const domGoal = {
  id: 'g-dom',
  title: 'DOM Test Goal',
  category: 'combo',
  summary: 'summary',
  difficulty: 1,
  steps: [
    // step 0: feeds INTO step 1's inbound-feed lookup; itself gets neither
    // element (first step -> no provenance; no technique/plunge -> no chips)
    { shot: 'left-ramp', action: 'Shoot the left ramp', feeds: { shot: 'right-inlane' } },
    // step 1: earns BOTH a provenance line and chips
    { shot: 'right-ramp', action: 'Shoot the right ramp', flipper: 'right', technique: ['backhand'], plunge: 'partial' },
    // step 2: earns NEITHER (no flipper authored anywhere, no technique/plunge)
    { shot: 'center-shot', action: 'Shoot the center shot' },
  ],
}

function mountDomFixture() {
  const machine = { id: 'test-machine', name: 'Test Machine', shortTitle: 'Test', resource: 'test_goals' }
  const data = { machine: 'Test Machine', shots: domShots, goals: [domGoal], sources: [] }
  const state = {
    machines: [machine],
    machine,
    data,
    shotsByID: new Map(domShots.map((s) => [s.id, s])),
    selectedGoal: domGoal,
    stepIndex: 0,
    ballPosition: 'any',
    highlightMode: 'auto',
    trailStyle: 'dash',
    ballTracer: true,
    routeStartedAt: 0,
    setTrailStyle() {},
    setBallTracer() {},
    async selectMachine() {},
    select() {},
    clearSelection() {},
    nextStep() {},
    prevStep() {},
    goToStep() {},
    restartGoal() {},
    pauseHighlight() {},
    resumeHighlight() {},
    onChange() {
      return () => {}
    },
  }
  const root = new FakeElement('div')
  mountApp(root, state)
  return root
}

let domRoot
test('mountApp() renders the pre-selected goal detail without throwing', () => {
  domRoot = mountDomFixture()
  const rows = domRoot.findAll('goal-step')
  assert(rows.length === 3, `expected 3 .goal-step rows, got ${rows.length}`)
})

test('row 0 (first step): renders NEITHER .goal-step-provenance NOR .goal-step-chips', () => {
  const row = domRoot.findAll('goal-step')[0]
  assert(!row.find('goal-step-provenance'), 'first step must never get a provenance line')
  assert(!row.find('goal-step-chips'), 'step 0 has no technique/plunge — expected no chips row')
})

test('row 1: .goal-step-provenance renders the exact expected text', () => {
  const row = domRoot.findAll('goal-step')[1]
  const prov = row.find('goal-step-provenance')
  assert(prov, 'expected a .goal-step-provenance element on row 1')
  assert(
    prov.textContent === 'FROM RIGHT FLIPPER · RIGHT INLANE RETURN',
    `unexpected provenance text: ${JSON.stringify(prov.textContent)}`,
  )
  return prov.textContent
})

test('row 1: provenance sits BETWEEN the shot label and the action text', () => {
  const row = domRoot.findAll('goal-step')[1]
  const body = row.find('goal-step-body')
  const classesInOrder = body.children.filter((c) => c instanceof FakeElement).map((c) => c.className)
  const shotIdx = classesInOrder.indexOf('goal-step-shot')
  const provIdx = classesInOrder.indexOf('goal-step-provenance')
  const actionIdx = classesInOrder.indexOf('goal-step-action')
  assert(shotIdx !== -1 && provIdx !== -1 && actionIdx !== -1, `missing an expected child: ${classesInOrder.join(', ')}`)
  assert(shotIdx < provIdx && provIdx < actionIdx, `expected shot < provenance < action, got order: ${classesInOrder.join(', ')}`)
})

test('row 1: chips render BACKHAND then SOFT PLUNGE, as real buttons', () => {
  const row = domRoot.findAll('goal-step')[1]
  const chipsRow = row.find('goal-step-chips')
  assert(chipsRow, 'expected a .goal-step-chips row on row 1')
  const chips = chipsRow.findAll('goal-step-chip')
  const labels = chips.map((c) => c.textContent)
  assert(labels.join('|') === 'BACKHAND|SOFT PLUNGE', `got ${JSON.stringify(labels)}`)
  assert(chips.every((c) => c.tagName === 'BUTTON'), 'expected chips to be <button> elements (tappable)')
  return labels.join(', ')
})

test("row 1: chip borders are tinted with the goal's own category color (combo)", () => {
  const row = domRoot.findAll('goal-step')[1]
  const chips = row.find('goal-step-chips').findAll('goal-step-chip')
  for (const c of chips) {
    assert(
      typeof c.style.borderColor === 'string' && c.style.borderColor.includes('--cat-combo'),
      `expected a border-color referencing --cat-combo, got ${JSON.stringify(c.style.borderColor)}`,
    )
  }
})

test('row 1: a chip click does not throw (glossary open path wired, not exercised here)', () => {
  const row = domRoot.findAll('goal-step')[1]
  const chip = row.find('goal-step-chip')
  chip.fire('click', { stopPropagation() {} })
})

test('row 2 (no flipper, no technique/plunge): renders NEITHER element either', () => {
  const row = domRoot.findAll('goal-step')[2]
  assert(!row.find('goal-step-provenance'), 'row 2 must not get a provenance line (no flipper authored anywhere)')
  assert(!row.find('goal-step-chips'), 'row 2 must not get a chips row (no technique/plunge)')
})

await rm(appTmp, { recursive: true, force: true })

// ===========================================================================
section('4. CSS: ONE chip recipe (P4, 2026-08-14), and a step chip big enough to tap')
// ===========================================================================
// .goal-row-chip / .goal-step-chip / .study-learn-chip were three hand-copies
// of one pill recipe, each carrying a comment claiming to be "the same recipe
// as .goal-row-chip" — and by the time anyone read them together, two were
// 9.5px and one was 10px. Copies drift on the axis nobody is looking at, so
// the shared half now lives in one grouped rule and this section is what stops
// a fourth copy (or a re-inlined declaration) from creeping back.
{
  const stylesSrc = readFileSync(resolve(srcDir, 'styles.css'), 'utf8')
  const CHIPS = ['.goal-row-chip', '.goal-step-chip', '.study-learn-chip']

  /** Every top-level rule in styles.css as { selectors: [...], body }. */
  const rules = []
  {
    const src = stylesSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m
    while ((m = re.exec(src))) rules.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] })
  }
  const rulesFor = (sel) => rules.filter((r) => r.selectors.includes(sel))
  /** Resolved longhand for `sel` — last declaration wins across every rule
   *  naming it (source order = cascade order; all single-class, so equal
   *  specificity). null when never declared. */
  function cssValue(sel, prop) {
    let value = null
    for (const r of rulesFor(sel)) {
      const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g')
      let m
      while ((m = re.exec(r.body))) value = m[1].trim()
    }
    return value
  }

  test('the shared geometry lives in exactly ONE grouped rule naming all three chip classes', () => {
    const grouped = rules.filter((r) => CHIPS.every((c) => r.selectors.includes(c)))
    assert(grouped.length === 1, `expected exactly 1 rule grouping ${CHIPS.join(' + ')}, found ${grouped.length}`)
    for (const prop of ['border-radius', 'font-size', 'line-height', 'font-weight', 'letter-spacing', 'text-transform']) {
      assert(new RegExp(`(?:^|;)\\s*${prop}\\s*:`).test(grouped[0].body), `the shared rule does not set ${prop}`)
    }
    return grouped[0].selectors.join(', ')
  })

  test('no chip class re-declares that shared geometry privately (the duplication is actually GONE, not just also-shared)', () => {
    const offenders = []
    for (const chip of CHIPS) {
      for (const r of rulesFor(chip)) {
        if (CHIPS.every((c) => r.selectors.includes(c))) continue // the shared rule itself
        for (const prop of ['border-radius', 'font-size', 'font-weight', 'letter-spacing', 'text-transform']) {
          if (new RegExp(`(?:^|;)\\s*${prop}\\s*:`).test(r.body)) offenders.push(`${chip} { ${prop} }`)
        }
      }
    }
    assert(offenders.length === 0, `these re-declare shared chip geometry: ${offenders.join(', ')}`)
  })

  test('all three chips render at ONE font size (10px) — the drift this merge existed to kill', () => {
    const sizes = CHIPS.map((c) => cssValue(c, 'font-size'))
    assert(sizes.every((s) => s === '10px'), `expected every chip at 10px, got ${JSON.stringify(sizes)}`)
    return CHIPS.map((c, i) => `${c} ${sizes[i]}`).join(', ')
  })

  test('.goal-step-chip is >= 24px tall — WCAG 2.5.8 Target Size (Minimum) — computed from the CSS as shipped', () => {
    // Height is only KNOWABLE because line-height is explicit: the shorthand
    // `normal` is a per-platform font metric, so a target-size claim built on
    // it would not be a claim at all (same rule study.test.mjs section l
    // enforces for the readout pills).
    const fontSize = Number(/(\d+(?:\.\d+)?)px/.exec(cssValue('.goal-step-chip', 'font-size'))[1])
    const lineHeight = Number(cssValue('.goal-step-chip', 'line-height'))
    assert(Number.isFinite(lineHeight), `.goal-step-chip's line-height must be an explicit unitless number, got ${cssValue('.goal-step-chip', 'line-height')}`)
    const padding = cssValue('.goal-step-chip', 'padding')
    const padY = Number(/(\d+(?:\.\d+)?)px/.exec(padding)[1])
    const border = Number(/(\d+(?:\.\d+)?)px/.exec(cssValue('.goal-step-chip', 'border'))[1])
    const height = fontSize * lineHeight + 2 * padY + 2 * border
    assert(height >= 24, `.goal-step-chip computes to ${height}px tall — under the 24px WCAG 2.5.8 floor`)
    // Not 44: these are nested inside .goal-step, itself a full-width tappable
    // row, so 2.5.8's minimum (not 2.5.5's 44px enhanced target) is the bar —
    // see the rule's own comment in styles.css.
    return `${fontSize}px x ${lineHeight} + ${padY}*2 padding + ${border}*2 border = ${height}px`
  })
}

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
