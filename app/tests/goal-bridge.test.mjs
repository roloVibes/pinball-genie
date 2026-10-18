#!/usr/bin/env node
// app/tests/goal-bridge.test.mjs — SUITE 26: the Goals ⇄ Map bridge
// (P7a, 2026-08-14).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/goal-bridge.test.mjs"
// or from app/:
//   node tests/goal-bridge.test.mjs
//
// WHAT THIS SUITE COVERS. Four small features that all connect the app's two
// halves — the Goals tab you read and the Shots map you look at — plus the
// links that get you into either from outside:
//
//   1. SHOW ON MAP (app.ts renderGoalDetail). A ◎ button in the goal-detail
//      step-controls bar. The interesting part is what it must NOT do: it may
//      not re-select the goal, because AppState.select() resets stepIndex to
//      0, and someone on step 4 of 6 who taps "show me on the map" must land
//      on step 4. That is a behaviour no type checks and no reviewer catches
//      by reading — it is one extra line that looks obviously right.
//      Pathless goals must not get the button at all (they have no route).
//   2. COMPLETION FEEDBACK (ui/toast.ts + app.ts). A singleton status pill and
//      a one-render mark on the row you land back on. Both are timing/lifetime
//      claims: replace-not-stack, 2.4s, and a cue that survives exactly ONE
//      render and no more.
//   3. DEEP LINKS (state.ts parseDeepLink). Pure parse, hostile input, and the
//      "unknown id is ignored SILENTLY" contract — a stranger's URL must never
//      throw on the boot path.
//   4. GLOSSARY ANCHORS (ui/glossary.ts). openGlossary(term) scrolls the
//      matching entry into view and marks it; a miss opens at the top, which
//      is exactly what every caller did before the parameter existed.
//
// Pattern: the same one card.test.mjs/step-chips.test.mjs/sheet.test.mjs use —
// esbuild bundles the REAL .ts sources (never edited, never copied) into a
// temp ESM module, driven against a hand-rolled fake DOM. The fake element
// here is sheet.test.mjs's (parentElement-aware remove(), dispatchEvent,
// classList, style) plus a recording scrollIntoView, which is new: this is
// the first phase whose code scrolls anything.
//
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, relative, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const appPath = resolve(srcDir, 'app.ts')
const statePath = resolve(srcDir, 'state.ts')
const toastPath = resolve(srcDir, 'ui/toast.ts')
const glossaryPath = resolve(srcDir, 'ui/glossary.ts')

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
/** The same, for an ASYNC body. A plain try/catch around an async fn catches
 *  nothing — the call returns a promise before the first assertion runs, so a
 *  failing async test would print PASS and then blow up as an unhandled
 *  rejection somewhere else entirely. Call sites `await` this. */
async function testAsync(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = await fn()
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
// Fake DOM
// ---------------------------------------------------------------------------
let domActiveElement = null

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.className = ''
    this.id = ''
    this.type = undefined
    this.src = undefined
    this.alt = undefined
    this.hidden = false
    this.disabled = false
    this.tabIndex = 0
    this.value = ''
    this._text = ''
    this._html = ''
    this.scrollCalls = []
    const classSet = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      // toggle() arrived with section 9 (P7b): the REAL overlay/map2d.ts is
      // mounted there, and its segmented controls (MODEL/LEVEL/TRAIL STYLE)
      // drive their selected state through it.
      toggle: (c, force) => {
        const want = force === undefined ? !classSet.has(c) : force
        if (want) classSet.add(c)
        else classSet.delete(c)
        return want
      },
      contains: (c) => classSet.has(c),
    }
    // className and classList have to agree — app.ts sets className directly
    // on creation and then classList.add()s modifiers onto the same element.
    const self = this
    Object.defineProperty(this, 'className', {
      get: () => [...classSet].join(' '),
      set: (v) => {
        classSet.clear()
        String(v)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classSet.add(c))
      },
    })
    void self
    const styleObj = {
      setProperty(prop, value) {
        styleObj[prop] = value
      },
      removeProperty(prop) {
        delete styleObj[prop]
      },
    }
    this.style = styleObj
    this._listeners = new Map()
    this._attrs = {}
  }
  set textContent(v) {
    this._text = v
    this.children = []
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent ?? '').join('')
    return this._text
  }
  set innerHTML(v) {
    this._html = v
    if (v === '') this.children = []
  }
  get innerHTML() {
    return this._html
  }
  appendChild(child) {
    if (child.parentElement) child.remove()
    this.children.push(child)
    child.parentElement = this
    return child
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n))
  }
  replaceChildren(...nodes) {
    this.children.forEach((c) => (c.parentElement = null))
    this.children = []
    nodes.forEach((n) => this.appendChild(n))
  }
  remove() {
    if (!this.parentElement) return
    const i = this.parentElement.children.indexOf(this)
    if (i >= 0) this.parentElement.children.splice(i, 1)
    this.parentElement = null
  }
  setAttribute(k, v) {
    this._attrs[k] = v
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn)
  }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) || []) fn(ev)
    return true
  }
  /** What a click on this element does, with the shape app.ts's handlers read
   *  (`ev.detail`, `ev.stopPropagation`). */
  click(detail = 1) {
    this.dispatchEvent({ type: 'click', detail, target: this, stopPropagation() {}, preventDefault() {} })
  }
  focus() {
    domActiveElement = this
  }
  /** RECORDED, not stubbed away: app.ts and ui/glossary.ts both call this and
   *  a silent no-op would let "it scrolls to the row" pass on a call that
   *  never happens. */
  scrollIntoView(opts) {
    this.scrollCalls.push(opts ?? null)
  }
  querySelector() {
    return null
  }
  find(cls) {
    if (this.className.split(/\s+/).includes(cls)) return this
    for (const c of this.children) {
      const hit = c.find?.(cls)
      if (hit) return hit
    }
    return null
  }
  findAll(cls, acc = []) {
    if (this.className.split(/\s+/).includes(cls)) acc.push(this)
    for (const c of this.children) c.findAll?.(cls, acc)
    return acc
  }
  /** Depth-first list of every descendant (plus self), for whole-tree claims
   *  like "exactly one .pg-toast exists". */
  all(acc = []) {
    acc.push(this)
    for (const c of this.children) c.all?.(acc)
    return acc
  }
}

let bodyEl = new FakeElement('body')
const docListeners = new Map()

/** The 2D context the REAL map renders into in section 9 — every method it
 *  calls, all no-ops. Nothing in this suite asserts a drawn pixel (that is
 *  deck-route/plunger-route/celebrate's subject); this only has to let the
 *  render path run to completion so the DOM half is exercised for real. */
function fakeCanvasCtx() {
  const noop = () => {}
  return {
    lineCap: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
    globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    save: noop, restore: noop, clip: noop, setLineDash: noop, setTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, arcTo: noop, arc: noop,
    ellipse: noop, rect: noop, roundRect: noop, fillRect: noop, strokeRect: noop,
    clearRect: noop, fillText: noop, strokeText: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fill: noop, stroke: noop, translate: noop, rotate: noop, scale: noop,
  }
}

const fakeDocument = {
  createElement: (t) => {
    const el = new FakeElement(t)
    if (String(t).toLowerCase() === 'canvas') {
      const ctx = fakeCanvasCtx()
      // The real back-reference: drawShotDots sizes its labels off
      // ctx.canvas.clientWidth || ctx.canvas.width, and resize() writes the
      // latter onto this very element.
      ctx.canvas = el
      el.getContext = (type) => (type === '2d' ? ctx : null)
    }
    return el
  },
  createElementNS: (_ns, t) => new FakeElement(t),
  createTextNode: (t) => {
    const n = new FakeElement('#text')
    n.textContent = t
    return n
  },
  get body() {
    return bodyEl
  },
  get activeElement() {
    return domActiveElement
  },
  querySelector: () => null,
  addEventListener(type, cb) {
    if (!docListeners.has(type)) docListeners.set(type, new Set())
    docListeners.get(type).add(cb)
  },
  removeEventListener(type, cb) {
    docListeners.get(type)?.delete(cb)
  },
}

const storage = new Map()
const fakeStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}

// install.ts registers 'beforeinstallprompt'/'appinstalled' at MODULE LOAD, so
// `window` must exist before the bundle is imported — not just before mountApp
// runs (card.test.mjs section 6 documents the same requirement).
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  location: { href: 'http://localhost/', search: '', hostname: 'localhost' },
  localStorage: fakeStorage,
  matchMedia: (q) => ({ matches: false, media: q }),
}
globalThis.localStorage = fakeStorage
// app.ts's header prefetches ui/library on idle. Defining this (as a callback
// that is never invoked) takes the requestIdleCallback branch instead of the
// `setTimeout(warmLibrary, 1500)` one — no chunk import in a bundle that has
// no chunks, and no 1.5s timer holding the event loop open at the end of the
// run (which is exactly why card.test/step-chips take ~1.6s each).
globalThis.requestIdleCallback = () => 1

// app.ts defers the completed-row scroll to requestAnimationFrame (the
// after-render hook — see its own comment). Queued, never auto-run: a test
// that wants the frame calls flushRaf(), so "it scrolled" and "it scrolled at
// the right time" stay separable claims.
let rafQueue = []
globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb)
// Section 9 mounts the REAL map: its rAF loop cancels on teardown, and it
// observes its host for resizes. Both are no-ops here — the suite drives every
// frame it wants by hand (flushRaf), and mountMap2D's own mount-time resize()
// runs synchronously before a ResizeObserver would ever fire.
globalThis.cancelAnimationFrame = () => {}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
function flushRaf() {
  const due = rafQueue
  rafQueue = []
  for (const cb of due) cb(0)
  return due.length
}

Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true, writable: true })

function resetDom() {
  bodyEl = new FakeElement('body')
  domActiveElement = null
  docListeners.clear()
  rafQueue = []
}

// ---------------------------------------------------------------------------
// Bundle the real modules (one graph — app.ts imports ui/toast.ts, and the
// glossary/state entry points come along as named re-exports).
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-goal-bridge-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  [
    `export { mountApp } from ${JSON.stringify(appPath)}`,
    `export { parseDeepLink, createAppState } from ${JSON.stringify(statePath)}`,
    `export { showToast, dismissToast, TOAST_MS } from ${JSON.stringify(toastPath)}`,
    `export { openGlossary, findTerm } from ${JSON.stringify(glossaryPath)}`,
  ].join('\n'),
)
const outfile = resolve(tmp, 'bundle.mjs')
// overlay/map2d.ts is STUBBED in this bundle. Tapping ◎ makes app.ts's tab
// handler lazily mount the map, and the real mountMap2D wants a canvas 2D
// context, a ResizeObserver and a live layout — none of which this fake DOM
// has, so it would throw inside loadChunk's catch, print a chunk-load error
// mid-run, and drop a failure banner into the page. What this suite claims
// about that tap is the SHELL's half (panel visibility, aria-selected, and
// that the goal/stepIndex are left alone); the map's own rendering is
// deck-route/plunger-route/sheet.test.mjs's subject, against their harnesses.
const stubMap2D = {
  name: 'stub-map2d',
  setup(b) {
    b.onResolve({ filter: /overlay\/map2d(\.ts)?$/ }, () => ({ path: 'map2d-stub', namespace: 'pg-stub' }))
    // ui/study IS STUBBED TOO since 2026-08-15, and only since then: section 12
    // below is the first test here that visits the Study tab, and the real
    // mountStudy wants a canvas 2D context, a ResizeObserver and a live layout
    // — none of which this fake DOM has, so it would throw inside loadChunk's
    // catch and drop a chunk-load banner into the page instead of mounting.
    // What section 12 claims is the SHELL's half of the CHARACTER jump (which
    // tab is showing, and that app.ts called openCharacter on the handle it
    // holds); the sheet that opens is tests/study.test.mjs section (ah)'s
    // subject, against a harness that can mount a canvas.
    b.onResolve({ filter: /ui\/study(\.ts)?$/ }, () => ({ path: 'study-stub', namespace: 'pg-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'pg-stub' }, (args) => (args.path === 'study-stub' ? {
      contents: [
        'export function mountStudy(host, state) {',
        '  const handle = {',
        '    opens: 0,',
        // The LANDING door (2026-10-14) — counted separately, so section 13
        // can tell "the landing opened HOW IT PLAYS" from "a character jump".
        '    hipOpens: 0,',
        '    destroy() {},',
        '    openCharacter() { handle.opens += 1 },',
        '    openHowItPlays() { handle.hipOpens += 1 },',
        '  }',
        '  ;(globalThis.__studyMounts ??= []).push({ host, state, handle })',
        '  return handle',
        '}',
      ].join('\n'),
      loader: 'js',
    } : {
      // Every name any importer takes from that module: mountMap2D (app.ts's
      // lazy tab mount) plus the canvas helpers ui/study.ts reuses — study.ts
      // is in this graph too (app.ts imports it lazily), and an ESM stub
      // missing a named export is a BUILD error, not a runtime one. None of
      // them is ever called here: this suite mounts neither tab's canvas.
      // (insertHitDistance/INSERT_DRAW_RADIUS joined the list in P8, when
      // study.ts's tap-to-inspect adopted the shared shape-aware hit test.)
      contents: [
        // RECORDING, not empty (P7b): app.ts now hands mountMap2D a third
        // argument — the Goals-tab jump a pathless row in the map's goal
        // sheet needs. Section 10 mounts the real shell, takes the callback
        // out of here, and calls it: that is the only way to prove the
        // tab-switch-then-select ORDER against the REAL tab handler (which
        // clears the selection on its way past). P9 added a fourth, the
        // writer for app.ts's own spoken-readout region — recorded here for
        // the same reason: section 11 calls it and looks at where the words
        // landed.
        'export function mountMap2D(host, state, jumpToGoalDetail, speakReadout, jumpToStudyCharacter) {',
        '  ;(globalThis.__mapMounts ??= []).push({ host, state, jumpToGoalDetail, speakReadout, jumpToStudyCharacter })',
        '  return { destroy() {} }',
        '}',
        'export function drawPlayfieldArt() {}',
        'export function drawShotDots() {}',
        'export function playfieldRect() { return { x: 0, y: 0, w: 0, h: 0 } }',
        'export function zoneScreenRect() { return { x: 0, y: 0, w: 0, h: 0 } }',
        'export function insertHitDistance() { return 0 }',
        'export const INSERT_DRAW_RADIUS = 4.6',
        // The LEVEL feature's shared zone path (2026-08-14).
        'export function drawZoneArt() {}',
        'export function insertShapeFor() { return "dot" }',
        'export function machineZones() { return [] }',
        'export function resolveMapLevel(current) { return current }',
        'export function zoneLocalMap() { return () => ({ x: 0, y: 0 }) }',
        'export function zoneMemberShots() { return [] }',
        // LEVEL v2 (2026-08-15): study.ts's ALL level needs the table's own
        // aspect to give a deck card its TRUE on-table shape, so map2d.ts
        // exports the constant it already leaked as playfieldRect's default.
        'export const PLAYFIELD_ASPECT = 20.25 / 45',
      ].join('\n'),
      loader: 'js',
    }))
  },
}
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  plugins: [stubMap2D],
})
const { mountApp, parseDeepLink, createAppState, showToast, dismissToast, TOAST_MS, openGlossary, findTerm } =
  await import(pathToFileURL(outfile).href)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SHOTS = [
  { id: 'left-ramp', name: 'Left Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all' },
  { id: 'right-ramp', name: 'Right Ramp', type: 'ramp', x: 0.7, y: 0.5, trim: 'all' },
  { id: 'center-scoop', name: 'Center Scoop', type: 'scoop', x: 0.5, y: 0.4, trim: 'all' },
]

const PATHFUL_GOAL = {
  id: 'g-pathful',
  title: 'Shark Hunt Multiball',
  category: 'multiball',
  summary: 'Light and start the multiball.',
  difficulty: 2,
  reward: '25M',
  steps: [
    { shot: 'left-ramp', action: 'Shoot the left ramp', technique: ['on-the-fly'] },
    { shot: 'right-ramp', action: 'Shoot the right ramp' },
    { shot: 'center-scoop', action: 'Shoot the scoop' },
  ],
}

const OTHER_GOAL = {
  id: 'g-other',
  title: 'Orbit Combo',
  category: 'combo',
  summary: 'Two orbits back to back.',
  difficulty: 1,
  steps: [{ shot: 'left-ramp', action: 'Shoot the left orbit' }],
}

const PATHLESS_GOAL = {
  id: 'g-pathless',
  title: 'Attract Mode Secret',
  category: 'secret',
  summary: 'A button code, not a shot.',
  difficulty: 3,
  steps: [],
  instructions: ['Hold both flippers in attract mode.', 'Press start.'],
}

const MACHINE = { id: 'test-machine', name: 'Test Machine', shortTitle: 'Test', resource: 'test_goals' }

/** A state stub with the surface app.ts actually touches, plus recorders. The
 *  mutators behave like the real AppStateImpl on the two points this suite
 *  makes claims about: select() resets stepIndex, clearSelection() notifies. */
function makeState({ selectedGoal = null, stepIndex = 0, goals = [PATHFUL_GOAL, OTHER_GOAL, PATHLESS_GOAL] } = {}) {
  const listeners = new Set()
  const calls = { select: [], clearSelection: 0, goToStep: [], nextStep: 0, prevStep: 0, order: [] }
  const state = {
    machines: [MACHINE],
    machine: MACHINE,
    data: { machine: MACHINE.name, shots: SHOTS, goals, sources: [] },
    shotsByID: new Map(SHOTS.map((s) => [s.id, s])),
    selectedGoal,
    stepIndex,
    ballPosition: 'any',
    highlightMode: 'auto',
    trailStyle: 'dash',
    ballTracer: true,
    shotLines: true,
    trim: 'premium-le',
    celebrationLevel: 1,
    routeStartedAt: 0,
    machineLoading: false,
    machineError: null,
    recentMachineIds: [],
    pinnedMachineIds: [],
    calls,
    setTrailStyle() {},
    setBallTracer() {},
    setShotLines() {},
    setTrim() {},
    setCelebrationLevel() {},
    togglePinned: () => false,
    isPinned: () => false,
    async selectMachine() {},
    select(g) {
      calls.select.push(g.id)
      calls.order.push('select')
      state.selectedGoal = g
      state.stepIndex = 0 // the real one does this — the whole point of B2
      state.notify()
    },
    clearSelection() {
      calls.clearSelection += 1
      calls.order.push('clearSelection')
      state.selectedGoal = null
      state.stepIndex = 0
      state.notify()
    },
    nextStep() {
      calls.nextStep += 1
      state.stepIndex += 1
      state.notify()
    },
    prevStep() {
      calls.prevStep += 1
      state.stepIndex -= 1
      state.notify()
    },
    goToStep(i) {
      calls.goToStep.push(i)
      state.stepIndex = i
      state.notify()
    },
    restartGoal() {},
    pauseHighlight() {},
    resumeHighlight() {},
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    notify() {
      for (const fn of [...listeners]) fn()
    },
  }
  return state
}

function mount(state) {
  const root = new FakeElement('div')
  bodyEl.appendChild(root)
  mountApp(root, state)
  return root
}

/** One turn of the real event loop — for the glossary's fetch + .then hops.
 *  (app.ts's deferred scroll is a FRAME, not a task: flushRaf() above.) */
const flushTask = () => new Promise((r) => setTimeout(r, 0))

// ===========================================================================
section('1. B2 — "Show on map" on goal detail')
// ===========================================================================
{
  resetDom()
  const state = makeState({ selectedGoal: PATHFUL_GOAL, stepIndex: 1 })
  const root = mount(state)

  test('the goal-detail step-controls bar carries a .step-btn-map button', () => {
    const controls = root.find('step-controls')
    assert(controls, 'expected the sticky .step-controls bar on a pathful goal')
    const btn = controls.find('step-btn-map')
    assert(btn, 'expected a .step-btn-map button in the controls bar')
    assert(btn.tagName === 'BUTTON' && btn.type === 'button', 'it must be a real <button type="button">')
    return `${controls.children.length} controls: ${controls.children.map((c) => c.className).join(' | ')}`
  })

  test('it is LEFT of the ‹ walker (first in the bar), and does not displace the ✓/›', () => {
    const controls = root.find('step-controls')
    const classes = controls.children.map((c) => c.className)
    assert(classes[0].includes('step-btn-map'), `expected the map button first, got ${JSON.stringify(classes)}`)
    assert(classes[1] === 'step-btn', 'expected the ‹ button second')
    assert(classes[2] === 'step-progress', 'expected the STEP n OF m readout third')
    assert(classes[3] === 'step-btn', 'expected the › button last')
  })

  test('it carries the spec aria-label (its glyph is the Shots tab\'s own ◎, which announces as nothing)', () => {
    const btn = root.find('step-btn-map')
    assert(
      btn.getAttribute('aria-label') === 'Show this goal on the Shots map',
      `got ${JSON.stringify(btn.getAttribute('aria-label'))}`,
    )
    assert(btn.textContent === '◎', `expected the ◎ glyph, got ${JSON.stringify(btn.textContent)}`)
  })

  test('it shares the 44px .step-btn recipe rather than inventing a second button family', () => {
    const btn = root.find('step-btn-map')
    assert(btn.className.split(/\s+/).includes('step-btn'), `got className ${JSON.stringify(btn.className)}`)
  })

  test('TAPPING IT SWITCHES TO THE SHOTS TAB', () => {
    const goalsPanel = root.find('tab-panel') // first panel in DOM order = goals
    assert(goalsPanel.id === 'goals-view', `expected the goals panel first, got ${goalsPanel.id}`)
    const panels = root.findAll('tab-panel')
    const map = panels.find((p) => p.id === 'map-host')
    assert(map && map.hidden === true, 'precondition: the Shots panel starts hidden')
    root.find('step-btn-map').click()
    assert(map.hidden === false, 'the Shots panel must be visible after the tap')
    assert(goalsPanel.hidden === true, 'the Goals panel must be hidden after the tap')
    const mapTab = root.findAll('tab-btn').find((b) => b.id === 'tab-map')
    assert(mapTab.getAttribute('aria-selected') === 'true', 'the Shots tab must be the selected tab')
    return 'goals hidden, map-host shown, aria-selected moved'
  })

  test('IT DOES NOT RE-SELECT THE GOAL — stepIndex survives the jump (the whole point)', () => {
    // state.select() resets stepIndex to 0 (see makeState, which mirrors the
    // real AppStateImpl). This fixture is parked on step 2 of 3.
    assert(state.calls.select.length === 0, `select() was called ${state.calls.select.length}x — it must not be`)
    assert(state.stepIndex === 1, `stepIndex moved to ${state.stepIndex}; the visitor's place was lost`)
    assert(state.selectedGoal === PATHFUL_GOAL, 'the selection itself must be untouched')
    return 'stepIndex still 1, select() never called'
  })

  test('and it does not clear the selection either (that is the ‹ Goals button\'s job)', () => {
    assert(state.calls.clearSelection === 0, 'clearSelection() must not fire on a map jump')
  })
}

// ===========================================================================
section('2. B2 — pathless goals get no button, because they have no route')
// ===========================================================================
{
  resetDom()
  const state = makeState({ selectedGoal: PATHLESS_GOAL })
  const root = mount(state)

  test('a pathless goal renders its instructions, and NO step-controls bar at all', () => {
    assert(root.find('goal-instructions'), 'expected the prose instruction list')
    assert(!root.find('step-controls'), 'a pathless goal must not get the walker bar')
  })

  test('and therefore no .step-btn-map anywhere on the screen', () => {
    assert(!root.find('step-btn-map'), 'a goal with no map route must not offer to show it on the map')
    return 'no ◎ on a pathless goal'
  })

  test('the honest note is still there (nothing about this phase removed it)', () => {
    const note = root.find('goal-instructions-note')
    assert(note && note.textContent.includes('No playfield route'), `got ${JSON.stringify(note?.textContent)}`)
  })
}

// ===========================================================================
section('3. B3 — ui/toast.ts: singleton, timing, shape')
// ===========================================================================
{
  resetDom()
  // FAKE TIMERS, installed for this section only: everything after it awaits
  // real promises (the glossary fetch), and a stubbed setTimeout would hang
  // those forever.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let seq = 0
  const timers = new Map()
  globalThis.setTimeout = (fn, ms) => {
    const id = ++seq
    timers.set(id, { fn, ms })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  /** Runs every timer scheduled for <= ms and returns how many fired. */
  const advance = (ms) => {
    let fired = 0
    for (const [id, t] of [...timers]) {
      if (t.ms <= ms) {
        timers.delete(id)
        t.fn()
        fired += 1
      }
    }
    return fired
  }

  test('showToast() mounts ONE .pg-toast on document.body, as a polite live region', () => {
    showToast('Shark Hunt Multiball — done')
    const toasts = bodyEl.all().filter((el) => el.className.split(/\s+/).includes('pg-toast'))
    assert(toasts.length === 1, `expected exactly 1 .pg-toast, got ${toasts.length}`)
    assert(toasts[0].parentElement === bodyEl, 'the pill must be mounted on document.body, above the shell')
    assert(toasts[0].getAttribute('role') === 'status', `expected role="status", got ${toasts[0].getAttribute('role')}`)
    return toasts[0].textContent
  })

  test('it reads "✓ <goal title> — done", with the glyph hidden from the announcement', () => {
    const toast = bodyEl.find('pg-toast')
    const check = toast.find('pg-toast-check')
    const text = toast.find('pg-toast-text')
    assert(check.textContent === '✓', `expected the ✓ glyph, got ${JSON.stringify(check.textContent)}`)
    assert(check.getAttribute('aria-hidden') === 'true', 'the decorative glyph must be aria-hidden')
    assert(text.textContent === 'Shark Hunt Multiball — done', `got ${JSON.stringify(text.textContent)}`)
  })

  test('SINGLETON: a second call REPLACES the pill, it does not stack a second one', () => {
    showToast('Orbit Combo — done')
    const toasts = bodyEl.all().filter((el) => el.className.split(/\s+/).includes('pg-toast'))
    assert(toasts.length === 1, `expected still exactly 1 .pg-toast, got ${toasts.length}`)
    assert(toasts[0].find('pg-toast-text').textContent === 'Orbit Combo — done', 'the pill must show the LATEST text')
    return `1 pill, showing "${toasts[0].find('pg-toast-text').textContent}"`
  })

  test('...and the replaced pill\'s timer is cancelled, so it cannot yank the new one away early', () => {
    // Two showToast() calls happened; exactly one timer may still be pending.
    assert(timers.size === 1, `expected 1 live timer after 2 toasts, found ${timers.size}`)
  })

  test(`it dismisses itself after exactly TOAST_MS (${TOAST_MS}ms), and not before`, () => {
    assert(TOAST_MS === 2400, `the spec is 2.4s; TOAST_MS is ${TOAST_MS}`)
    const pending = [...timers.values()][0]
    assert(pending.ms === TOAST_MS, `the pill's timer is ${pending.ms}ms, not TOAST_MS`)
    assert(advance(TOAST_MS - 1) === 0, 'nothing may fire before TOAST_MS')
    assert(bodyEl.find('pg-toast'), 'the pill must still be up one millisecond early')
    assert(advance(TOAST_MS) === 1, 'the dismissal timer must fire at TOAST_MS')
    assert(!bodyEl.find('pg-toast'), 'the pill must be gone (removed, not hidden) after TOAST_MS')
    return `up for ${TOAST_MS}ms, then removed from the DOM`
  })

  test('teardown is a plain removal — no exit animation to wait on, nothing left behind', () => {
    assert(timers.size === 0, `expected no live timers after dismissal, found ${timers.size}`)
    assert(bodyEl.children.length === 0, 'document.body must be empty again')
  })

  test('dismissToast() is safe with nothing showing, and cancels a live pill', () => {
    dismissToast() // nothing up — must not throw
    showToast('Test — done')
    assert(bodyEl.find('pg-toast'), 'precondition: a pill is up')
    dismissToast()
    assert(!bodyEl.find('pg-toast'), 'dismissToast() must remove the live pill')
    assert(timers.size === 0, 'and cancel its timer')
  })

  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}

// ===========================================================================
section('4. B3 — completion, end to end through mountApp')
// ===========================================================================
{
  resetDom()
  const state = makeState({ selectedGoal: PATHFUL_GOAL, stepIndex: 2 }) // last step
  const root = mount(state)
  let toastTextAtClearTime = null
  const realClear = state.clearSelection
  state.clearSelection = function patched() {
    // Snapshot what the DOM looked like the moment the selection was cleared:
    // "toast BEFORE clearSelection" is an ORDER claim, and order claims are
    // only provable from inside the sequence.
    toastTextAtClearTime = bodyEl.find('pg-toast')?.textContent ?? null
    return realClear.call(state)
  }

  test('precondition: the ✓ (not ›) is showing, because this is the last step', () => {
    const nextBtn = root.find('step-controls').children[3]
    assert(nextBtn.textContent === '✓', `expected the ✓ finish button, got ${JSON.stringify(nextBtn.textContent)}`)
    assert(nextBtn.getAttribute('aria-label') === 'Finish goal', 'expected the finish aria-label')
  })

  test('tapping ✓ shows the toast and returns to the list', () => {
    root.find('step-controls').children[3].click()
    assert(state.calls.clearSelection === 1, 'completing must still clear the selection exactly once')
    assert(root.find('goal-groups'), 'the goal LIST must be back on screen')
    assert(!root.find('step-controls'), 'the detail screen must be gone')
    const toast = bodyEl.find('pg-toast')
    assert(toast, 'expected the completion toast')
    assert(
      toast.find('pg-toast-text').textContent === 'Shark Hunt Multiball — done',
      `got ${JSON.stringify(toast.find('pg-toast-text').textContent)}`,
    )
    return toast.textContent
  })

  test('THE TOAST GOES UP FIRST: it was already on screen when clearSelection() ran', () => {
    assert(
      toastTextAtClearTime && toastTextAtClearTime.includes('Shark Hunt Multiball — done'),
      `at clearSelection() time the toast read ${JSON.stringify(toastTextAtClearTime)} — the pill must precede the tear-down, ` +
        'or the render it is describing happens before it exists',
    )
  })

  test('and the goal is NOT advanced past the end (it completes, it does not step)', () => {
    assert(state.calls.nextStep === 0, 'the last step\'s ✓ must never call nextStep()')
  })

  test('the row you land back on is marked .goal-row-done with a ✓ — and it is the RIGHT row', () => {
    const done = root.findAll('goal-row').filter((r) => r.className.split(/\s+/).includes('goal-row-done'))
    assert(done.length === 1, `expected exactly 1 marked row, got ${done.length}`)
    assert(done[0].textContent.includes('Shark Hunt Multiball'), `marked the wrong row: ${done[0].textContent}`)
    assert(done[0].find('goal-row-check').textContent === '✓', 'the marked row must show the ✓')
    return done[0].find('goal-row-title').textContent
  })

  test('no row is left SELECTED — completing cleared the selection, so nothing is amber-lit', () => {
    const sel = root.findAll('goal-row').filter((r) => r.className.split(/\s+/).includes('goal-row-sel'))
    assert(sel.length === 0, `expected no .goal-row-sel after completion, got ${sel.length}`)
  })

  test('the marked row is scrolled into view — on the NEXT FRAME, not during the render', () => {
    const done = root.findAll('goal-row').find((r) => r.className.split(/\s+/).includes('goal-row-done'))
    assert(done.parentElement, 'precondition: the row is in the tree')
    // NOT YET. The render task is over and nothing has scrolled: the call is
    // sitting in a requestAnimationFrame callback, which is the point — a
    // scrollIntoView inside the render would force a synchronous layout to
    // answer "where is this row?" before the browser has laid the list out.
    assert(done.scrollCalls.length === 0, 'the scroll must not happen inside the render task')
    const frames = flushRaf()
    assert(frames === 1, `expected exactly 1 queued frame, ran ${frames}`)
    assert(done.scrollCalls.length === 1, `expected exactly 1 scrollIntoView call, got ${done.scrollCalls.length}`)
    assert(done.scrollCalls[0]?.block === 'center', `expected block:'center', got ${JSON.stringify(done.scrollCalls[0])}`)
    // NEVER 'smooth': that would be motion, and motion needs a reduced-motion
    // branch that a scroll like this has no way to express.
    assert(!('behavior' in (done.scrollCalls[0] ?? {})), 'the scroll must use the default (instant) behaviour')
    return "queued in rAF, then scrollIntoView({block:'center'}) once"
  })

  test('WHAT it scrolls: the app has exactly one scrollport, and the document is not it', () => {
    // The iOS trap this avoids: `body` is position:fixed/overflow:hidden (the
    // collapsing-toolbar hardening), so a scrollIntoView that resolved against
    // the DOCUMENT would silently do nothing. #main-content is the scrollport
    // the goal list actually lives in.
    const css = readFileSync(resolve(srcDir, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const main = /#main-content\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert(/overflow-y:\s*auto/.test(main), `#main-content must be the scrollport, got: ${main.trim()}`)
    assert(/min-height:\s*0/.test(main), '#main-content needs min-height:0 or a flex child cannot shrink to scroll')
    // EVERY rule naming `body`, concatenated in cascade order — `body` is
    // styled twice (once grouped with `html`, once alone), and a lazy
    // /\nbody\s*\{/ finds the grouped rule, reports no position:fixed, and
    // "disproves" a property that is right there in the file. It did, on the
    // first run of this test.
    const bodyDecls = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1].split(',').map((s) => s.trim()).includes('body'))
      .map((m) => m[2])
      .join(';')
    assert(bodyDecls.length > 0, 'no rule styles `body` at all — the parse is wrong, not the CSS')
    assert(/position:\s*fixed/.test(bodyDecls) && /overflow:\s*hidden/.test(bodyDecls), `body must stay pinned/non-scrolling, got: ${bodyDecls.trim()}`)
    return '#main-content{overflow-y:auto;min-height:0} · body{position:fixed;overflow:hidden}'
  })

  test('ONE RENDER ONLY: the very next re-render draws that row plain again', () => {
    state.notify() // anything at all re-rendering the list
    const done = root.findAll('goal-row').filter((r) => r.className.split(/\s+/).includes('goal-row-done'))
    assert(done.length === 0, 'the cue must not survive a second render — it is transient, not state')
    return 'cue consumed by the render that used it'
  })

  test('and it does not come back on a later completion of a DIFFERENT goal', () => {
    state.selectedGoal = OTHER_GOAL
    state.stepIndex = 0
    state.notify()
    root.find('step-controls').children[3].click() // OTHER_GOAL has one step: ✓
    const done = root.findAll('goal-row').filter((r) => r.className.split(/\s+/).includes('goal-row-done'))
    assert(done.length === 1 && done[0].textContent.includes('Orbit Combo'), 'the mark must follow the goal just finished')
    assert(
      bodyEl.find('pg-toast').find('pg-toast-text').textContent === 'Orbit Combo — done',
      'and the toast must describe the goal just finished',
    )
  })
}

// ===========================================================================
section('5. B3 — the CSS claims (position derived, motion removable)')
// ===========================================================================
{
  const stylesCss = readFileSync(resolve(srcDir, 'styles.css'), 'utf8')

  /** Removes every at-block (@media, @keyframes, @supports) WITH its contents,
   *  brace-depth aware.
   *
   *  Without this, a naive "last rule naming this selector wins" scan finds
   *  `.pg-toast { animation: none }` INSIDE the reduced-motion block and
   *  reports the base rule as having no bottom offset, no pointer-events and
   *  no animation — which is exactly what the first draft of this section did,
   *  and it would have "proved" three properties absent that are right there
   *  in the file. */
  function stripAtBlocks(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
    let out = ''
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== '@') {
        out += src[i]
        continue
      }
      const open = src.indexOf('{', i)
      if (open < 0) break
      let depth = 0
      let j = open
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}' && --depth === 0) break
      }
      i = j // skip the whole block
    }
    return out
  }

  /** The BASE (non-at-block) rule body for `selector`, last declaration
   *  block wins — source order is cascade order here, all single-class. */
  function ruleBody(css, selector) {
    const src = stripAtBlocks(css)
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m
    let body = null
    while ((m = re.exec(src))) {
      if (m[1].split(',').map((s) => s.trim()).includes(selector)) body = m[2]
    }
    return body
  }

  test('the CSS reader itself: it reads the BASE rule, not one inside an at-block', () => {
    // Pin the harness, since three claims below depend on it. The reduced-
    // motion block sets `animation: none` on .pg-toast; the base rule sets
    // pgToastIn. A reader that confused them would silently invert this
    // section's meaning.
    const base = ruleBody(stylesCss, '.pg-toast')
    assert(/animation:\s*pgToastIn/.test(base), `the base .pg-toast rule was not found; got: ${String(base).slice(0, 80)}`)
    assert(!/animation:\s*none/.test(base), 'the reader picked up the reduced-motion override as the base rule')
    assert(ruleBody(stylesCss, '.pg-toast-nope') === null, 'a selector that does not exist must read as null')
  })

  test('.pg-toast clears the ad slot AND the tab bar by DERIVATION, not by a magic number', () => {
    const body = ruleBody(stylesCss, '.pg-toast')
    assert(body, 'expected a .pg-toast rule in styles.css')
    const bottom = /bottom:\s*([^;]+)/.exec(body)?.[1] ?? ''
    for (const token of ['var(--ad-h)', 'var(--tabbar-h)', 'var(--tabbar-pad-b)']) {
      assert(bottom.includes(token), `.pg-toast's bottom offset does not read ${token}: ${bottom}`)
    }
    return bottom.trim()
  })

  test('--tabbar-pad-b is the tab bar\'s OWN padding, not a copy of it (they move together)', () => {
    // The failure this pins: someone turns the safe-area multiplier in
    // .tab-bar (its comment openly invites it) and the toast keeps clearing
    // the old height. A shared token cannot drift; two copies of an
    // expression can, and silently.
    const root = ruleBody(stylesCss, ':root')
    assert(/--tabbar-pad-b:\s*max\(5px,\s*calc\(env\(safe-area-inset-bottom\)\s*\*\s*0\.5\)\)/.test(root), 'expected the token in :root')
    const tabBar = ruleBody(stylesCss, '.tab-bar')
    assert(
      /padding-bottom:\s*var\(--tabbar-pad-b\)/.test(tabBar),
      '.tab-bar must READ the token, not re-type the expression',
    )
    assert(
      !/padding-bottom:\s*max\(5px/.test(tabBar),
      '.tab-bar still carries a literal copy of the expression — that is the drift this token exists to prevent',
    )
  })

  test('the pill cannot swallow a tap meant for the app', () => {
    assert(/pointer-events:\s*none/.test(ruleBody(stylesCss, '.pg-toast')), '.pg-toast must be pointer-events:none')
  })

  test('the pill sits ABOVE the sheets, and below the two banners that report trouble', () => {
    // K3 review, 2026-08-14: at the original 150 a completion that happened
    // with the glossary open announced (role="status") but never appeared —
    // the screen-reader and sighted experiences disagreed. The tiers it must
    // stay between are read out of the real stylesheets, not retyped here.
    const z = (body) => Number(/z-index:\s*(\d+)/.exec(body ?? '')?.[1] ?? NaN)
    const toast = z(ruleBody(stylesCss, '.pg-toast'))
    const sheetCss = readFileSync(resolve(srcDir, 'ui/sheet.css'), 'utf8')
    const sheetPanel = z(ruleBody(sheetCss, '.pg-sheet-panel.pg-sheet-overlay'))
    const gate = z(ruleBody(readFileSync(resolve(srcDir, 'ui/signupgate.css'), 'utf8'), '.pg-gate-overlay'))
    const chunkErr = z(ruleBody(stylesCss, '.pg-chunk-error'))
    assert(Number.isFinite(toast) && Number.isFinite(sheetPanel), `could not read the tiers: toast ${toast}, sheet ${sheetPanel}`)
    assert(toast > sheetPanel, `the toast (${toast}) must outrank the overlay sheet panel (${sheetPanel})`)
    assert(Number.isFinite(chunkErr) && toast < chunkErr, `the chunk-error banner (${chunkErr}) must outrank the toast (${toast})`)
    if (Number.isFinite(gate)) assert(toast < gate, `the sign-up gate (${gate}) must outrank the toast (${toast})`)
    return `sheet ${sheetPanel} < toast ${toast} < gate ${gate} < chunk-error ${chunkErr}`
  })

  test('reduced motion removes the MOTION and keeps the FEATURE', () => {
    const stripped = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const blocks = [...stripped.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1])
    const toastBlock = blocks.find((b) => b.includes('.pg-toast'))
    assert(toastBlock, 'expected a prefers-reduced-motion block naming .pg-toast')
    assert(/animation:\s*none/.test(toastBlock), 'the reduced-motion branch must turn the animation off')
    // The FEATURE survives because nothing else is disabled: no display:none,
    // no visibility:hidden, no opacity:0 hiding the pill from the visitor who
    // asked for less motion.
    assert(!/display:\s*none|visibility:\s*hidden|opacity:\s*0/.test(toastBlock), 'reduced motion must not hide the pill')
    // And the entry animation must be enter-only (no exit transition that a
    // reduced-motion visitor would have to sit through or that would need an
    // animationend listener to clean up).
    const base = ruleBody(stylesCss, '.pg-toast')
    assert(/animation:\s*pgToastIn/.test(base), 'expected the enter animation')
    assert(!/transition:/.test(base), '.pg-toast must not carry a transition — teardown is a removal')
    return toastBlock.trim().replace(/\s+/g, ' ')
  })

  test('the just-finished row is GREEN, not another amber thing to read', () => {
    const body = ruleBody(stylesCss, '.goal-row-done .goal-row-check')
    assert(body, 'expected a .goal-row-done .goal-row-check rule')
    assert(/color:\s*var\(--cat-skillshot\)/.test(body), `expected the skill-shot green, got: ${body}`)
    assert(!/var\(--amber\)/.test(body), 'amber in this list means SELECTED — the completed row must not claim it')
  })
}

// ===========================================================================
section('6. B4 — parseDeepLink(search, machines)')
// ===========================================================================
{
  const machines = [MACHINE, { id: 'jaws', name: 'Jaws', shortTitle: 'Jaws', resource: 'jaws_goals' }]

  test('?machine=<known>&goal=<id> returns the resolved machine and the raw goal id', () => {
    const link = parseDeepLink('?machine=jaws&goal=skillshot-level-1', machines)
    assert(link.machine?.id === 'jaws', `got machine ${JSON.stringify(link.machine)}`)
    assert(link.goalId === 'skillshot-level-1', `got goalId ${JSON.stringify(link.goalId)}`)
    return `${link.machine.id} / ${link.goalId}`
  })

  test('a leading "?" is optional (URLSearchParams accepts both) — the boot path passes location.search', () => {
    const a = parseDeepLink('machine=jaws', machines)
    const b = parseDeepLink('?machine=jaws', machines)
    assert(a.machine?.id === 'jaws' && b.machine?.id === 'jaws', 'both forms must resolve')
  })

  test('an UNKNOWN machine resolves to null (the caller falls back to stored/default)', () => {
    const link = parseDeepLink('?machine=not-a-machine&goal=g-pathful', machines)
    assert(link.machine === null, `expected null, got ${JSON.stringify(link.machine)}`)
    assert(link.goalId === 'g-pathful', 'the goal half is independent and survives')
  })

  test('a goal WITHOUT a machine still parses (the goal is checked against whatever machine loads)', () => {
    const link = parseDeepLink('?goal=g-other', machines)
    assert(link.machine === null && link.goalId === 'g-other', `got ${JSON.stringify(link)}`)
  })

  test('empty / whitespace-only / absent parameters are all "not asked for"', () => {
    for (const search of ['', '?', '?machine=&goal=', '?goal=%20%20', '?other=1']) {
      const link = parseDeepLink(search, machines)
      assert(link.machine === null, `${JSON.stringify(search)}: expected no machine`)
      assert(link.goalId === null, `${JSON.stringify(search)}: expected no goal, got ${JSON.stringify(link.goalId)}`)
    }
  })

  test('HOSTILE INPUT: script tags, traversal, prototype probes and junk all parse to nothing usable', () => {
    const hostile = [
      '?goal=<script>alert(1)</script>',
      '?machine=<script>alert(1)</script>&goal=<img src=x onerror=alert(1)>',
      '?machine=__proto__&goal=__proto__',
      '?machine=constructor&goal=constructor',
      '?machine=../../etc/passwd&goal=../../etc/passwd',
      '?machine=jaws%00&goal=%00',
      `?goal=${'A'.repeat(5000)}`,
      '?machine=%E0%A4%A&goal=%E0%A4%A', // malformed percent-encoding
      '?%',
      '?goal=jaws&goal=other', // duplicated key
    ]
    for (const search of hostile) {
      let link
      // NEVER THROWS is half the contract: this runs on the boot path, and a
      // URL a stranger can hand someone must not be able to stop the app.
      try {
        link = parseDeepLink(search, machines)
      } catch (err) {
        throw new Error(`parseDeepLink threw on ${JSON.stringify(search.slice(0, 40))}: ${err.message}`)
      }
      assert(link.machine === null, `${search.slice(0, 40)}: resolved a machine it should not have`)
      // The goal half may come back as a raw string — it is only ever COMPARED
      // against real goal ids, never rendered — so what matters is that it
      // matches nothing.
      if (link.goalId !== null) {
        const goals = [PATHFUL_GOAL, OTHER_GOAL, PATHLESS_GOAL]
        assert(!goals.some((g) => g.id === link.goalId), `${search.slice(0, 40)}: matched a real goal id`)
      }
    }
    return `${hostile.length} hostile inputs, none resolved, none threw`
  })

  test('it is PURE — no window, no storage, no side effects (the reason it is exported)', () => {
    const before = new Map(storage)
    parseDeepLink('?machine=jaws&goal=g-other', machines)
    assert(storage.size === before.size, 'parseDeepLink must not write storage')
    assert(machines.length === 2, 'and must not mutate the catalog it was handed')
  })

  await testAsync('COLD BOOT with ?machine=A&goal=G while the STORED machine is B — A and G both win', async () => {
    // The race this proves is not hypothetical: loadMachine() sets
    // `selectedGoal = null` and `stepIndex = 0` as part of installing a
    // machine's data. A goal selected before that await lands is wiped
    // without a trace, and the visitor gets machine A's goal LIST — which
    // looks like a working deep link right up until you notice it never opens
    // the goal. So this drives the REAL createAppState() over a stubbed
    // network and asserts the end state, rather than asserting the ordering
    // by reading the source.
    //
    // The fixture is built so no other explanation fits: 'g-only-on-a' exists
    // ONLY in A's dataset, and A is NOT machines[0] (B is), and B is also the
    // stored last-machine. A pass means the parse beat storage AND the
    // selection happened against A's loaded goals.
    const machineA = { id: 'machine-a', name: 'Machine A', shortTitle: 'A', resource: 'a_goals' }
    const machineB = { id: 'machine-b', name: 'Machine B', shortTitle: 'B', resource: 'b_goals' }
    const goalOnA = { id: 'g-only-on-a', title: 'Linked Goal', category: 'combo', summary: 's', difficulty: 1, steps: [{ shot: 'left-ramp', action: 'a' }] }
    const dataFor = {
      '/data/a_goals.json': { machine: 'Machine A', shots: SHOTS, goals: [OTHER_GOAL, goalOnA], sources: [] },
      '/data/b_goals.json': { machine: 'Machine B', shots: SHOTS, goals: [OTHER_GOAL], sources: [] },
    }
    const fetched = []
    const priorFetch = globalThis.fetch
    const priorLoc = globalThis.window.location
    globalThis.fetch = async (url) => {
      fetched.push(url)
      // catalog lists B FIRST, so machines[0] — the no-link default — is B.
      const body = url === '/data/catalog.json' ? [machineB, machineA] : dataFor[url]
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }
    globalThis.window.location = { href: 'http://localhost/?machine=machine-a&goal=g-only-on-a', search: '?machine=machine-a&goal=g-only-on-a', hostname: 'localhost' }
    storage.clear()
    storage.set('pinballgenie.machineId', 'machine-b') // last session was on B
    try {
      const booted = await createAppState()
      assert(booted.machine?.id === 'machine-a', `expected machine A, got ${JSON.stringify(booted.machine?.id)}`)
      assert(booted.data?.machine === 'Machine A', 'the LOADED dataset must be A\'s')
      assert(
        booted.selectedGoal?.id === 'g-only-on-a',
        `expected the linked goal selected after boot, got ${JSON.stringify(booted.selectedGoal?.id)} — ` +
          'a null here is the race: loadMachine() clears selectedGoal, so a selection made before it resolved is gone',
      )
      assert(booted.selectedGoal === booted.data?.goals.find((g) => g.id === 'g-only-on-a'), 'it must be the object out of the LOADED data, not a copy')
      assert(booted.stepIndex === 0, 'a freshly linked goal opens at step 1')
      assert(!fetched.includes('/data/b_goals.json'), `the stored machine's data must never be fetched: ${fetched.join(', ')}`)
      assert(storage.get('pinballgenie.machineId') === 'machine-a', 'the link must be persisted over the stored id')
      return `fetched ${fetched.join(' -> ')}; machine=${booted.machine.id}, goal=${booted.selectedGoal.id}`
    } finally {
      globalThis.fetch = priorFetch
      globalThis.window.location = priorLoc
      storage.clear()
    }
  })

  await testAsync('...and the same boot with an unknown goal id lands on the machine, silently, with nothing selected', async () => {
    const machineA = { id: 'machine-a', name: 'Machine A', shortTitle: 'A', resource: 'a_goals' }
    const priorFetch = globalThis.fetch
    const priorLoc = globalThis.window.location
    globalThis.fetch = async (url) =>
      url === '/data/catalog.json'
        ? { ok: true, status: 200, json: async () => [machineA] }
        : { ok: true, status: 200, json: async () => ({ machine: 'Machine A', shots: SHOTS, goals: [OTHER_GOAL], sources: [] }) }
    globalThis.window.location = { href: 'http://localhost/', search: '?machine=machine-a&goal=<script>alert(1)</script>', hostname: 'localhost' }
    storage.clear()
    try {
      const booted = await createAppState()
      assert(booted.machine?.id === 'machine-a', 'the machine half must still work')
      assert(booted.selectedGoal === null, `a hostile/unknown goal id must select nothing, got ${JSON.stringify(booted.selectedGoal)}`)
      return 'machine A loaded, no goal selected, no error surfaced'
    } finally {
      globalThis.fetch = priorFetch
      globalThis.window.location = priorLoc
      storage.clear()
    }
  })

  test('the boot path actually USES it: state.ts selects the linked goal after bootMachine', () => {
    // Source-level, because createAppState() is a fetch + boot away: what this
    // pins is the WIRING (the parse feeds the machine choice AND a select()),
    // which is the part a refactor could quietly drop.
    const stateSrc = readFileSync(statePath, 'utf8')
    const boot = stateSrc.slice(stateSrc.indexOf('export async function createAppState'))
    assert(/const link = parseDeepLink\(/.test(boot), 'createAppState must parse the deep link')
    assert(/link\.machine \?\? machines\.find/.test(boot), 'the linked machine must beat the stored one')
    const after = boot.slice(boot.indexOf('await state.bootMachine('))
    assert(/link\.goalId/.test(after) && /state\.select\(linkedGoal\)/.test(after), 'the goal must be selected AFTER the boot load')
    assert(
      !/searchParams\.set\(|history\.(replace|push)State/.test(boot),
      'PARSE-ONLY: nothing may write the goal back into the URL',
    )
  })
}

// ===========================================================================
section('7. Glossary term anchors — openGlossary(term)')
// ===========================================================================
const GLOSSARY_FIXTURE = {
  version: 1,
  categories: [
    {
      id: 'shots',
      title: 'Shots',
      terms: [
        { term: 'Orbit', aliases: ['loop'], def: 'A shot that circles the back of the playfield.' },
        { term: 'Ramp', def: 'A raised lane the ball travels up.' },
      ],
    },
    {
      id: 'technique',
      title: 'Technique',
      terms: [
        { term: 'On the fly', def: 'Hitting a moving ball without cradling first.' },
        { term: 'Nudge', def: 'Moving the machine to influence the ball.' },
        { term: 'Flip timing', aliases: ['Early flip', 'Late flip'], def: 'When to flip.' },
      ],
    },
  ],
}

test('findTerm: exact match, case-insensitively', () => {
  assert(findTerm(GLOSSARY_FIXTURE, 'nudge')?.term === 'Nudge', 'lower-case exact must match')
  assert(findTerm(GLOSSARY_FIXTURE, 'ORBIT')?.term === 'Orbit', 'upper-case exact must match')
})

test('findTerm: the vocabulary\'s hyphens read as spaces ("on-the-fly" -> "On the fly")', () => {
  // This is the whole reason the chips can anchor at all: models.ts's closed
  // technique vocabulary is hyphenated, the glossary writes prose.
  assert(findTerm(GLOSSARY_FIXTURE, 'on-the-fly')?.term === 'On the fly', 'hyphenated vocab must match prose')
  return 'on-the-fly -> On the fly'
})

test('findTerm: prefix match, and EXACT beats prefix', () => {
  assert(findTerm(GLOSSARY_FIXTURE, 'flip')?.term === 'Flip timing', 'a prefix must find its term')
  // 'Orbit' is exact; nothing else starts with it — but the exact-first rule
  // is what stops a longer neighbour winning when both exist.
  const fixture = {
    version: 1,
    categories: [{ id: 'x', title: 'X', terms: [{ term: 'Lock down', def: 'd' }, { term: 'Lock', def: 'd' }] }],
  }
  assert(findTerm(fixture, 'lock')?.term === 'Lock', 'an exact match must beat an earlier prefix match')
})

test('findTerm: an ALIAS resolves to its term ("late-flip" -> "Flip timing")', () => {
  assert(findTerm(GLOSSARY_FIXTURE, 'late-flip')?.term === 'Flip timing', 'an authored alias must find its entry')
  assert(findTerm(GLOSSARY_FIXTURE, 'Early Flip')?.term === 'Flip timing', 'aliases match case-insensitively too')
  return 'late-flip -> Flip timing'
})

test('findTerm: a colliding prefix resolves to the LONGEST match, whatever order the file lists it in', () => {
  // THE BUG THIS CLOSES (K3 review): the prefix pass used to take the first
  // candidate in iteration order, so which entry a chip opened depended on how
  // data/glossary.json happened to be sorted — re-alphabetising a content file
  // could silently change a UI destination. Two entries, both prefixed by
  // "post", in BOTH orders: the answer must be the same one every time.
  const post = { term: 'Post pass', def: 'd' }
  const postTransfer = { term: 'Post transfer pass', def: 'd' }
  const orderA = { version: 1, categories: [{ id: 'x', title: 'X', terms: [post, postTransfer] }] }
  const orderB = { version: 1, categories: [{ id: 'x', title: 'X', terms: [postTransfer, post] }] }
  const a = findTerm(orderA, 'post')
  const b = findTerm(orderB, 'post')
  assert(a?.term === 'Post transfer pass', `expected the longest prefix match, got ${JSON.stringify(a?.term)}`)
  assert(b?.term === a?.term, `file order changed the answer: ${JSON.stringify(b?.term)} vs ${JSON.stringify(a?.term)}`)
  // Across categories too — the scan is flat, not per-section.
  const split = {
    version: 1,
    categories: [
      { id: 'a', title: 'A', terms: [post] },
      { id: 'b', title: 'B', terms: [postTransfer] },
    ],
  }
  assert(findTerm(split, 'post')?.term === 'Post transfer pass', 'a longer match in a later category must still win')
  // And an EXACT match still outranks any prefix, however long.
  assert(findTerm(orderA, 'post pass')?.term === 'Post pass', 'exact must beat longest-prefix')
  return 'both orders -> Post transfer pass; exact still wins'
})

test('findTerm: EQUAL-length prefix candidates are settled alphabetically, not by file order', () => {
  // Length alone is not a total order, and the real glossary is full of ties:
  // 'lo' prefixes both "Lock" and "Loop", 'sh' prefixes "Shooter lane" and
  // "Short plunge". Leaving those to iteration order is the original bug with
  // a smaller blast radius, which is what the first fix here shipped until the
  // reversal check below caught it.
  const lock = { term: 'Lock', def: 'd' }
  const loop = { term: 'Loop', def: 'd' }
  const fwd = { version: 1, categories: [{ id: 'x', title: 'X', terms: [loop, lock] }] }
  const rev = { version: 1, categories: [{ id: 'x', title: 'X', terms: [lock, loop] }] }
  assert(findTerm(fwd, 'lo')?.term === 'Lock', `expected the alphabetically first of the tie, got ${findTerm(fwd, 'lo')?.term}`)
  assert(findTerm(rev, 'lo')?.term === 'Lock', 'and the same answer with the file in the other order')
  return "'lo' -> Lock in both orders (Lock < Loop)"
})

// The real file, and three properties of it that the rule above depends on.
// (A first draft asserted "the shipped glossary has no prefix collisions" —
// it has seven. Guessing at data is how a comment becomes a lie; these read
// the file.)
const REAL_GLOSSARY = JSON.parse(readFileSync(resolve(__dirname, '../../data/glossary.json'), 'utf8'))
const glossKey = (s) => s.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ')

test('the real glossary DOES have prefix collisions — and every one is settled by an exact pass', () => {
  const names = new Set()
  const aliases = new Set()
  for (const c of REAL_GLOSSARY.categories) {
    for (const t of c.terms) {
      names.add(glossKey(t.term))
      for (const a of t.aliases ?? []) aliases.add(glossKey(a))
    }
  }
  const keys = [...new Set([...names, ...aliases])]
  const pairs = []
  for (const a of keys) for (const b of keys) if (a !== b && b.startsWith(a)) pairs.push([a, b])
  assert(pairs.length > 0, 'expected collisions to exist — if this file ever has none, simplify the rule')
  // THE PROPERTY THAT MAKES THE TIEBREAK HARMLESS TODAY: in each pair the
  // SHORT key is itself a real name/alias, so a query spelling it is answered
  // exactly and never reaches the prefix pass. Delete "Bonus" while keeping
  // "Bonus X" and this fires — which is exactly when someone should re-read
  // where that query now lands.
  const unsettled = pairs.filter(([a]) => !names.has(a) && !aliases.has(a))
  assert(
    unsettled.length === 0,
    `these prefixes are decided by the LONGEST-match tiebreak rather than an exact key — confirm each destination: ${unsettled
      .map(([a, b]) => `${a} < ${b}`)
      .join(', ')}`,
  )
  return `${keys.length} keys (${names.size} names + ${aliases.size} aliases), ${pairs.length} proper-prefix pairs, all exact-settled: ${pairs
    .map(([a, b]) => `${a}<${b}`)
    .join(', ')}`
})

test('no shipped chip depends on the tiebreak at all — every authored technique resolves EXACTLY', () => {
  const exactKeys = new Set()
  for (const c of REAL_GLOSSARY.categories) {
    for (const t of c.terms) {
      exactKeys.add(glossKey(t.term))
      for (const a of t.aliases ?? []) exactKeys.add(glossKey(a))
    }
  }
  const used = new Set()
  const dataDir = resolve(__dirname, '../../data')
  for (const file of readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))) {
    const doc = JSON.parse(readFileSync(resolve(dataDir, file), 'utf8'))
    for (const g of doc.goals ?? []) for (const s of g.steps ?? []) for (const t of s.technique ?? []) used.add(t)
  }
  const viaPrefix = [...used].filter((t) => !exactKeys.has(glossKey(t)))
  assert(viaPrefix.length === 0, `these chips reach the prefix pass, so their destination IS the tiebreak: ${viaPrefix.join(', ')}`)
  return `${used.size} authored techniques, all exact-matched`
})

test('DETERMINISM on the real file: reversing the JSON changes no answer, for any key or ambiguous prefix', () => {
  // The blocker itself, proven where it matters rather than only on a
  // synthetic pair: shuffle the content file and every lookup must be stable.
  const reversed = {
    ...REAL_GLOSSARY,
    categories: [...REAL_GLOSSARY.categories].reverse().map((c) => ({ ...c, terms: [...c.terms].reverse() })),
  }
  const queries = new Set()
  for (const c of REAL_GLOSSARY.categories) {
    for (const t of c.terms) {
      queries.add(t.term)
      for (const a of t.aliases ?? []) queries.add(a)
      // Every proper prefix of every key, which is where a tiebreak can bite.
      const k = glossKey(t.term)
      for (let i = 1; i < k.length; i++) queries.add(k.slice(0, i))
    }
  }
  const drift = []
  for (const q of queries) {
    const a = findTerm(REAL_GLOSSARY, q)
    const b = findTerm(reversed, q)
    if ((a?.term ?? null) !== (b?.term ?? null)) drift.push(`${q}: ${a?.term ?? 'null'} vs ${b?.term ?? 'null'}`)
  }
  assert(drift.length === 0, `file order changed ${drift.length} answer(s): ${drift.slice(0, 6).join(' | ')}`)
  return `${queries.size} queries (every key + every proper prefix), identical answers in both orders`
})

test('findTerm: a term NAME beats an alias of some other term', () => {
  const fixture = {
    version: 1,
    categories: [
      { id: 'a', title: 'A', terms: [{ term: 'Trap', aliases: ['Cradle'], def: 'd' }] },
      { id: 'b', title: 'B', terms: [{ term: 'Cradle', def: 'd' }] },
    ],
  }
  assert(findTerm(fixture, 'cradle')?.term === 'Cradle', 'the entry actually NAMED cradle must win')
})

test('findTerm: a miss is null — never a near-neighbour guess', () => {
  for (const miss of ['banana', 'zzz', '', '   ', '-']) {
    assert(findTerm(GLOSSARY_FIXTURE, miss) === null, `${JSON.stringify(miss)} must not match anything`)
  }
  // And a term whose only relationship is being a SUBSTRING must not match
  // either — prefix, not contains.
  assert(findTerm(GLOSSARY_FIXTURE, 'timing') === null, '"timing" is inside "Flip timing" but does not prefix it')
  return 'junk + a substring-only near miss all resolve to null'
})

test('MEASURED against the shipped data: every technique chip in the catalog lands on an entry', () => {
  // The claim this suite exists to keep honest. findTerm looked perfectly
  // correct on names alone — and would have missed 32 of the 45 technique
  // chips actually authored across the machines we ship, because the two most
  // common (hold-flipper, from-cradle) are glossary ALIASES rather than term
  // names. A unit test on a fixture cannot see that; only the real data can.
  const dataDir = resolve(__dirname, '../../data')
  const glossary = JSON.parse(readFileSync(resolve(dataDir, 'glossary.json'), 'utf8'))
  const used = new Map() // technique -> chip count
  for (const file of readdirSync(dataDir).filter((f) => f.endsWith('_goals.json'))) {
    const doc = JSON.parse(readFileSync(resolve(dataDir, file), 'utf8'))
    for (const g of doc.goals ?? []) {
      for (const s of g.steps ?? []) {
        for (const t of s.technique ?? []) used.set(t, (used.get(t) ?? 0) + 1)
      }
    }
  }
  assert(used.size > 0, 'no technique chips found in the dataset — this check would be vacuous')
  const missing = [...used].filter(([t]) => findTerm(glossary, t) === null)
  assert(
    missing.length === 0,
    `these authored techniques have no glossary entry, so their chips open at the top of the list: ` +
      `${missing.map(([t, n]) => `${t} (${n} chips)`).join(', ')} — add the term, or an alias on the term it belongs to, ` +
      `in data/glossary.json`,
  )
  const total = [...used.values()].reduce((a, b) => a + b, 0)
  return `${used.size} distinct techniques / ${total} chips, all resolving: ${[...used]
    .map(([t, n]) => `${t}->${findTerm(glossary, t).term} (${n})`)
    .join(', ')}`
})

{
  resetDom()
  const priorFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => GLOSSARY_FIXTURE })

  const handle = openGlossary('on-the-fly')
  // loadGlossary() is a fetch plus two .then hops.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  test('openGlossary(term) marks the matching entry — and only that one', () => {
    const hits = bodyEl.all().filter((el) => el.className.split(/\s+/).includes('pg-glossary-term-hit'))
    assert(hits.length === 1, `expected exactly 1 marked term, got ${hits.length}`)
    assert(hits[0].textContent.includes('On the fly'), `marked the wrong row: ${hits[0].textContent}`)
    return hits[0].find('pg-glossary-term-name').textContent
  })

  test('...and scrolls it into view, instantly (never behavior:"smooth")', () => {
    const hit = bodyEl.all().find((el) => el.className.split(/\s+/).includes('pg-glossary-term-hit'))
    assert(hit.scrollCalls.length === 1, `expected 1 scrollIntoView call, got ${hit.scrollCalls.length}`)
    assert(hit.scrollCalls[0]?.block === 'center', `expected block:'center', got ${JSON.stringify(hit.scrollCalls[0])}`)
    assert(!('behavior' in (hit.scrollCalls[0] ?? {})), 'a smooth scroll would be motion with no reduced-motion branch')
  })

  test('the rest of the sheet is untouched: every term still renders, filter included', () => {
    const names = bodyEl
      .all()
      .filter((el) => el.className.split(/\s+/).includes('pg-glossary-term-name'))
      .map((el) => el.textContent)
    assert(names.length === 5, `expected all 5 fixture terms, got ${names.length}`)
    assert(bodyEl.find('pg-glossary-filter'), 'the live filter must still be there')
    return names.join(', ')
  })

  test('typing in the filter drops the mark rather than fighting the visitor\'s query', () => {
    const input = bodyEl.find('pg-glossary-filter')
    // A query that KEEPS the anchored term on screen ("On the fly" matches
    // "fly"). Filtering it out instead would prove nothing: the mark would be
    // gone because the row was, which is true of any implementation. This is
    // the case where a re-marking bug would actually show.
    input.value = 'fly'
    input.dispatchEvent({ type: 'input' })
    const names = bodyEl
      .all()
      .filter((el) => el.className.split(/\s+/).includes('pg-glossary-term-name'))
      .map((el) => el.textContent)
    assert(names.includes('On the fly'), `precondition: the anchored term must survive this filter, got ${names.join(',')}`)
    const hits = bodyEl.all().filter((el) => el.className.split(/\s+/).includes('pg-glossary-term-hit'))
    assert(hits.length === 0, 'the anchor mark must not be re-applied on a filtered re-render')
    return `filtered to [${names.join(', ')}], 0 marks`
  })

  handle.destroy()

  await testAsync('openGlossary() with NO term opens at the top, exactly as it always did', async () => {
    resetDom()
    const h = openGlossary()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    const marked = bodyEl.all().filter((el) => el.className.split(/\s+/).includes('pg-glossary-term-hit'))
    assert(marked.length === 0, 'no term may be marked when none was asked for')
    const scrolled = bodyEl.all().filter((el) => el.scrollCalls.length > 0)
    assert(scrolled.length === 0, 'and nothing may be scrolled')
    assert(bodyEl.find('pg-glossary-term'), 'the term list must still render')
    h.destroy()
  })

  await testAsync('an UNKNOWN term also opens at the top (a miss must not be a broken sheet)', async () => {
    resetDom()
    // A term with no entry AND no alias. (It has to be junk: every string in
    // models.ts's technique vocabulary resolves against the real glossary —
    // see the measured check above — so a "realistic" miss no longer exists,
    // which is the point.)
    const h = openGlossary('flarnbuckle')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    const marked = bodyEl.all().filter((el) => el.className.split(/\s+/).includes('pg-glossary-term-hit'))
    assert(marked.length === 0, 'a term with no glossary entry must mark nothing')
    assert(bodyEl.findAll('pg-glossary-term').length === 5, 'and the full list must still be there to browse')
    h.destroy()
  })

  globalThis.fetch = priorFetch
}

// ===========================================================================
section('8. The chips actually pass their term (source wiring, app.ts)')
// ===========================================================================
{
  // A DOM assertion cannot see this: the chip's click handler calls
  // loadChunk(() => import('./ui/glossary'), …), which in a bundle with no
  // chunks resolves to nothing. What matters is that the term is threaded, and
  // that the old "openGlossary() takes NO arguments" comment did not survive
  // the change that made it false.
  const appSrc = readFileSync(appPath, 'utf8')

  test('the step-chip handler passes chip.term through to openGlossary', () => {
    assert(
      /openGlossary\(chip\.term \?\? undefined\)/.test(appSrc),
      'expected the chip handler to pass its vocabulary term to openGlossary',
    )
  })

  test('the header Glossary chip still opens at the top (no term to anchor)', () => {
    assert(/'the glossary', \(\{ openGlossary \}\) => openGlossary\(\)\)/.test(appSrc), 'the header chip must stay argument-free')
  })

  test('the stale "openGlossary() takes NO arguments" comment is gone', () => {
    assert(
      !/openGlossary\(\) takes NO arguments/.test(appSrc),
      'that comment is now false — a comment that lies is worse than no comment',
    )
  })

  test('the header contract comment records the supersession of "no toast"', () => {
    // The 2026-08-11 entry says goal completion has "no toast". P7a changed
    // that, and the brief required the supersession be written down in the
    // same commit rather than left as a comment that quietly contradicts the
    // code beneath it.
    assert(/SUPERSEDED 2026-08-14 as to the toast only/.test(appSrc), 'the "no toast" line must be flagged as superseded')
    assert(/P7a, Goals ⇄ Map bridge/.test(appSrc), 'expected a dated P7a entry in the header changelog')
    assert(/fx\/celebrate\.ts \(still unimported by anything\)/.test(appSrc), 'the entry must state what did NOT come back')
  })
}

// ===========================================================================
section('9. P7b — the goal sheet stops hiding goals, through the REAL mountMap2D')
// ===========================================================================
//
// The Map tab's goal sheet used to drop two kinds of goal on the floor: ones
// with no route to draw (isPathless) and ones whose route needs a shot the
// current MODEL doesn't have (goalVisibleForTrim). Both drops were silent, and
// both produced the same symptom — a goal you can read about on the Goals tab
// is simply not in the Map tab's list, with nothing on screen saying why, while
// the sheet's own "N LOADED" header went on counting it.
//
// This section drives the REAL overlay/map2d.ts (its own bundle: the shell's
// bundle above stubs that module out) against the fake DOM, and asserts the
// three treatments and the count that ties them together. IT IS ALSO THE
// MUTATION GATE: re-adding either filter deletes rows, and the first two tests
// here fail on the count before anything else does.
{
  const tmpMap = await mkdtemp(resolve(tmpdir(), 'pg-p7b-map-'))
  const mapEntry = resolve(tmpMap, 'entry.ts')
  await writeFile(
    mapEntry,
    [
      `export { mountMap2D } from ${JSON.stringify(resolve(srcDir, 'overlay/map2d.ts'))}`,
      // The map's OWN copy of the toast module. Two bundles means two module
      // instances, so the singleton the map writes into is not the one section
      // 3 above drives — this suite must dismiss the map's own pill (and its
      // pending 2.4s timer) through the map's own module.
      `export { dismissToast as mapDismissToast } from ${JSON.stringify(toastPath)}`,
    ].join('\n'),
  )
  const mapOutfile = resolve(tmpMap, 'bundle.mjs')
  await build({
    entryPoints: [mapEntry],
    outfile: mapOutfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
  })
  const { mountMap2D, mapDismissToast } = await import(pathToFileURL(mapOutfile).href)

  const MAP_SHOTS = [
    { id: 'all-ramp', name: 'All Ramp', type: 'ramp', x: 0.3, y: 0.5, trim: 'all' },
    { id: 'orca-deck', name: 'Orca Deck', type: 'standup', x: 0.7, y: 0.8, trim: 'premium-le' },
  ]
  const ROUTED_GOAL = {
    id: 'g-routed', title: 'Chum Multiball', category: 'multiball', summary: 's', difficulty: 2, reward: '25M',
    steps: [{ shot: 'all-ramp', action: 'Shoot the ramp' }],
  }
  const BLOCKED_GOAL = {
    id: 'g-blocked', title: 'Orca Deck Frenzy', category: 'mode', summary: 's', difficulty: 3,
    steps: [{ shot: 'all-ramp', action: 'Shoot the ramp' }, { shot: 'orca-deck', action: 'Hit the deck target' }],
  }
  const MAP_PATHLESS_GOAL = {
    id: 'g-map-pathless', title: 'Attract Mode Secret', category: 'secret', summary: 's', difficulty: 1,
    steps: [], instructions: ['Hold both flippers in attract mode.'],
  }
  // THE RETARGET'S SUBJECT (2026-08-15). A pathless 'progression' goal — the
  // hero you pick, the gear you carry — which the Study tab's CHARACTER door
  // now owns. It sits beside MAP_PATHLESS_GOAL on purpose: the two are the same
  // shape to every test in this sheet EXCEPT the one rule being added, so a
  // retarget that widened to "any pathless goal" would move both and be caught
  // by the secret's own tests below.
  const MAP_CHARACTER_GOAL = {
    id: 'g-map-character', title: 'Pick Your Shark', category: 'progression', summary: 's', difficulty: 2,
    steps: [], instructions: ['Cycle with the right flipper before the plunge.'],
  }
  const MAP_GOALS = [ROUTED_GOAL, BLOCKED_GOAL, MAP_PATHLESS_GOAL, MAP_CHARACTER_GOAL]

  /** The AppState surface the real mountMap2D touches. setTrim notifies (it is
   *  the whole subject of the MODEL-switch test below); select/clearSelection
   *  mirror the real AppStateImpl. */
  function makeMapState(trim = 'premium-le') {
    const listeners = new Set()
    const st = {
      machines: [],
      machine: { id: 'p7b-machine', name: 'P7b Machine', shortTitle: 'P7B' },
      data: { machine: 'P7b Machine', shots: MAP_SHOTS, goals: MAP_GOALS, sources: [], playfields: [] },
      shotsByID: new Map(MAP_SHOTS.map((s) => [s.id, s])),
      selectedGoal: null,
      stepIndex: 0,
      ballPosition: 'any',
      highlightMode: 'auto',
      trailStyle: 'dash',
      ballTracer: true,
      shotLines: true,
      trim,
      celebrationLevel: 0,
      routeStartedAt: 0,
      setTrailStyle() {},
      setBallTracer() {},
      setShotLines() {},
      setTrim(v) {
        if (st.trim === v) return
        st.trim = v
        st.notify()
      },
      setCelebrationLevel() {},
      async selectMachine() {},
      select(g) {
        st.selectedGoal = g
        st.stepIndex = 0
        st.notify()
      },
      clearSelection() {
        st.selectedGoal = null
        st.stepIndex = 0
        st.notify()
      },
      nextStep() {},
      prevStep() {},
      goToStep() {},
      restartGoal() {},
      pauseHighlight() {},
      resumeHighlight() {},
      onChange(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      notify() {
        for (const fn of [...listeners]) fn()
      },
    }
    return st
  }

  /** Mounts the real map into a fresh fake DOM and opens its goal sheet.
   *  `jumpToGoalDetail` is recorded rather than stubbed away — "the tap fired
   *  the callback with THIS goal" is the claim. `jumpToStudyCharacter`
   *  (2026-08-15) is recorded the same way, and the two recorders are separate
   *  arrays because the whole point of the retarget is WHICH door a row opens.
   *
   *  `wireJump` / `wireCharacter` are independent so both degradations can be
   *  driven: no Goals-tab jump at all (the row goes dead, as it always did),
   *  and a Goals-tab jump WITHOUT the Study door (a character row falls back to
   *  the instructions rather than to nothing). */
  function withMap({ trim = 'premium-le', wireJump = true, wireCharacter = true } = {}) {
    resetDom()
    const jumps = []
    const charJumps = []
    const state = makeMapState(trim)
    const host = new FakeElement('div')
    host.clientWidth = 600
    host.clientHeight = 900
    bodyEl.appendChild(host)
    const onJump = wireJump ? (goal) => jumps.push(goal) : undefined
    const onCharacter = wireCharacter ? () => charJumps.push(Date.now()) : undefined
    const handle = mountMap2D(host, state, onJump, undefined, onCharacter)
    return { host, state, handle, jumps, charJumps, openSheet: () => host.find('map-goal-pill').click() }
  }

  const rowTitle = (row) => row.find('map-gsheet-row-title').textContent
  const rowFor = (host, title) => host.findAll('map-gsheet-row').find((r) => rowTitle(r) === title)
  /** The reason line belonging to `title`'s row. It is deliberately NOT a
   *  child of the row button (see the containment test below), so it is found
   *  through the wrapper the two share. */
  const reasonFor = (host, title) => rowFor(host, title)?.parentElement?.find('map-gsheet-row-reason') ?? null
  /** Walks up from `node` to `stopAt`, collecting any ancestor that is a
   *  disabled control. Empty means the node is reachable by a browse mode that
   *  skips disabled subtrees. */
  const disabledAncestorsOf = (node, stopAt) => {
    const out = []
    for (let el = node?.parentElement; el && el !== stopAt; el = el.parentElement) {
      if (el.disabled === true) out.push(el.className || el.tagName)
    }
    return out
  }

  {
    const { host, state, handle, jumps, charJumps, openSheet } = withMap({ trim: 'pro' })
    openSheet()

    test('EVERY goal gets a row — routed, trim-blocked and pathless alike', () => {
      const rows = host.findAll('map-gsheet-row')
      assert(rows.length === MAP_GOALS.length, `expected ${MAP_GOALS.length} rows, got ${rows.length}: ${rows.map(rowTitle).join(' | ')}`)
      for (const g of MAP_GOALS) assert(rowFor(host, g.title), `no row for ${JSON.stringify(g.title)}`)
      return rows.map(rowTitle).join(' | ')
    })

    test('and the sheet\'s own "N LOADED" header now agrees with what it drew', () => {
      const meta = host.find('pg-sheet-meta')
      assert(meta, 'expected the sheet meta line')
      const claimed = Number(/(\d+) LOADED/.exec(meta.textContent)?.[1])
      const drawn = host.findAll('map-gsheet-row').length
      assert(Number.isFinite(claimed), `could not read a count out of ${JSON.stringify(meta.textContent)}`)
      assert(claimed === drawn, `the header claims ${claimed} goals, the body drew ${drawn}`)
      return `${meta.textContent} -> ${drawn} rows`
    })

    test('the TRIM-BLOCKED row is disabled, dimmed, and says why — keeping its category bar', () => {
      const row = rowFor(host, 'Orca Deck Frenzy')
      assert(row.disabled === true, 'the row must be a disabled button')
      assert(row.className.split(/\s+/).includes('map-gsheet-row-disabled'), `got className ${JSON.stringify(row.className)}`)
      const reason = reasonFor(host, 'Orca Deck Frenzy')
      assert(reason, 'expected a reason line with the row')
      assert(reason.textContent === 'Needs Premium/LE — switch MODEL', `got ${JSON.stringify(reason.textContent)}`)
      const bar = row.find('map-gsheet-row-bar')
      assert(bar && bar.style.background, 'the category bar must survive the dimming — it is still a goal of that kind')
      return `${reason.textContent} (bar ${bar.style.background})`
    })

    // K3 review, 2026-08-14. `disabled` is kept as the containment mechanism
    // (nothing here weakens it to aria-disabled), but a disabled button's
    // SUBTREE is not reliably exposed to assistive tech in browse/swipe
    // navigation — so the one sentence explaining why the row cannot be used
    // must not live inside it. This is the pin: reachability of the reason,
    // asserted structurally rather than assumed from a comment.
    test('REACHABILITY: the reason is NOT inside the disabled button — it is a sibling of it', () => {
      const row = rowFor(host, 'Orca Deck Frenzy')
      const reason = reasonFor(host, 'Orca Deck Frenzy')
      assert(reason, 'expected the reason line')
      assert(!row.find('map-gsheet-row-reason'), 'the reason must NOT be a descendant of the disabled button')
      const sheetBody = host.find('pg-sheet-body')
      const blocking = disabledAncestorsOf(reason, sheetBody)
      assert(blocking.length === 0, `the reason sits inside ${blocking.length} disabled subtree(s): ${blocking.join(', ')}`)
      assert(reason.parentElement === row.parentElement, 'the reason and its row must share a wrapper, so they stay one unit')
      assert(
        row.parentElement.className.split(/\s+/).includes('map-gsheet-row-wrap'),
        `expected the pair inside .map-gsheet-row-wrap, got ${JSON.stringify(row.parentElement.className)}`,
      )
      // Order matters for a browse cursor: the row, then its explanation.
      const kids = row.parentElement.children
      assert(kids[0] === row && kids[1] === reason, 'the reason must follow its row, not precede it')
      return `reason is a sibling of a ${row.disabled ? 'disabled' : 'live'} row, 0 disabled ancestors`
    })

    test('and it is NOT tappable: a click selects nothing and leaves the sheet open', () => {
      const row = rowFor(host, 'Orca Deck Frenzy')
      // No click listener is registered at all for a disabled row, so this
      // dispatch reaches nothing — the same outcome a real browser produces for
      // a disabled <button>, proven here without relying on the fake DOM to
      // enforce `disabled` for us.
      row.dispatchEvent({ type: 'click' })
      assert(state.selectedGoal === null, `a blocked row selected ${state.selectedGoal?.id} — it would draw a route with a missing target`)
      assert(host.find('pg-sheet-panel'), 'the sheet must stay open — nothing happened')
    })

    test('the PATHLESS row is enabled, offers no route, and points at the instructions', () => {
      const row = rowFor(host, 'Attract Mode Secret')
      assert(row.disabled === false, 'the pathless row must stay tappable — it has somewhere to go')
      assert(!row.className.split(/\s+/).includes('map-gsheet-row-disabled'), 'it must not be dimmed')
      const meta = row.find('map-gsheet-row-meta')
      assert(meta.textContent === 'No map route — opens instructions', `got ${JSON.stringify(meta.textContent)}`)
      assert(!/step/.test(meta.textContent), '"0 steps" is not a fact worth printing about a pathless goal')
      assert(row.find('map-gsheet-row-jump'), 'expected the › that says this row leaves the Map tab')
      assert(!row.find('map-gsheet-row-pips'), 'the difficulty pips slot is the jump chevron on a pathless row')
      return meta.textContent
    })

    test('TAPPING IT closes the sheet and jumps to THAT goal — without selecting it on the map', () => {
      rowFor(host, 'Attract Mode Secret').dispatchEvent({ type: 'click' })
      assert(jumps.length === 1, `expected exactly 1 jump, got ${jumps.length}`)
      assert(jumps[0] === MAP_PATHLESS_GOAL, `jumped with ${jumps[0]?.id}, expected ${MAP_PATHLESS_GOAL.id}`)
      assert(!host.find('pg-sheet-panel'), 'the sheet must close on the way out')
      assert(state.selectedGoal === null, 'a pathless goal must NOT become the map\'s selected goal — there is no route to draw')
      return `jumped to ${jumps[0].id}, sheet closed, map selection untouched`
    })

    test('an ORDINARY row still just picks the goal and closes the sheet (nothing about the normal path moved)', () => {
      host.find('map-goal-pill').click()
      rowFor(host, 'Chum Multiball').dispatchEvent({ type: 'click' })
      assert(state.selectedGoal === ROUTED_GOAL, `expected the routed goal selected, got ${state.selectedGoal?.id}`)
      assert(!host.find('pg-sheet-panel'), 'the sheet closes on a pick, as it always did')
    })

    // ---- THE CHARACTER RETARGET (2026-08-15) ------------------------------
    // OWNER: "drop character dev info from shots and only have it in study."
    // Reconciled with P7b's honesty contract: the ROW STAYS (this sheet lists
    // every goal the machine has, and a silent omission is the bug that
    // contract exists to end), and what changes is the door it opens.
    test('the CHARACTER row says which door it opens, and it is not the Goals tab', () => {
      host.find('map-goal-pill').click()
      const row = rowFor(host, 'Pick Your Shark')
      assert(row, 'the character goal must still HAVE a row — P7b lists every goal the machine has')
      assert(row.disabled === false, 'it has somewhere to go, so it must be tappable')
      const meta = row.find('map-gsheet-row-meta')
      assert(meta.textContent === 'No map route — opens CHARACTER in Study', `got ${JSON.stringify(meta.textContent)}`)
      assert(row.find('map-gsheet-row-jump'), 'expected the › that says this row leaves the Shots tab')
      assert(!row.find('map-gsheet-row-pips'), 'the pips slot is the jump chevron on a row that leaves')
      // ...and it is in its own category section, where it always was — the
      // retarget changes a destination, not the sheet's shape.
      const sections = host.findAll('map-gsheet-section-label').map((el) => el.textContent)
      assert(sections.includes('PROGRESSION'), `expected a PROGRESSION section, got ${JSON.stringify(sections)}`)
      return meta.textContent
    })

    test('TAPPING IT fires the Study jump — not the Goals-tab one — and closes the sheet', () => {
      const jumpsBefore = jumps.length
      // Whatever the map had selected before the tap (the test above left the
      // routed goal on it) — a pathless row must not touch it in either
      // direction: not select itself, not clear what is drawn.
      const selectedBefore = state.selectedGoal
      rowFor(host, 'Pick Your Shark').dispatchEvent({ type: 'click' })
      assert(charJumps.length === 1, `expected exactly 1 Study-CHARACTER jump, got ${charJumps.length}`)
      assert(jumps.length === jumpsBefore, `the Goals-tab jump fired too (${jumps.length - jumpsBefore} extra) — a row must open ONE door`)
      assert(!host.find('pg-sheet-panel'), 'the sheet must close on the way out')
      assert(state.selectedGoal === selectedBefore, `the map's selection changed to ${state.selectedGoal?.id} — a pathless goal has no route to draw`)
      assert(state.selectedGoal !== MAP_CHARACTER_GOAL, 'the character goal must never become the selected goal')
      return 'CHARACTER jump fired, Goals jump untouched, sheet closed, selection untouched'
    })

    test('THE OTHER PATHLESS ROW IS UNCHANGED — the retarget is the progression category, not "anything pathless"', () => {
      // The mutation this catches: widening the retarget to every pathless goal
      // would send the attract-mode SECRET to the CHARACTER door too, where it
      // does not appear at all — a jump to a sheet that does not contain what
      // you tapped.
      host.find('map-goal-pill').click()
      const secret = rowFor(host, 'Attract Mode Secret')
      assert(secret.find('map-gsheet-row-meta').textContent === 'No map route — opens instructions', `the secret row was retargeted: ${JSON.stringify(secret.find('map-gsheet-row-meta').textContent)}`)
      const charBefore = charJumps.length
      const jumpsBefore = jumps.length
      secret.dispatchEvent({ type: 'click' })
      assert(jumps.length === jumpsBefore + 1 && jumps.at(-1) === MAP_PATHLESS_GOAL, 'the secret must still open its instructions on the Goals tab')
      assert(charJumps.length === charBefore, 'the secret must NEVER open the CHARACTER door')
      return 'secret -> Goals tab, character -> Study'
    })

    handle.destroy()
  }

  {
    // Degrading WITHOUT the Study door, but with the Goals-tab jump: a
    // character row falls back to the instructions rather than going dead. This
    // is what every 3- and 4-argument mountMap2D call site still gets.
    const { host, jumps, charJumps, handle, openSheet } = withMap({ wireCharacter: false })
    openSheet()

    test('mounted without the Study door, the character row behaves exactly as it did before this pass', () => {
      const row = rowFor(host, 'Pick Your Shark')
      assert(row.disabled === false, 'it must not go dead — the Goals tab still renders it')
      assert(row.find('map-gsheet-row-meta').textContent === 'No map route — opens instructions', `got ${JSON.stringify(row.find('map-gsheet-row-meta').textContent)}`)
      row.dispatchEvent({ type: 'click' })
      assert(charJumps.length === 0, 'there is no Study door wired — nothing may call it')
      assert(jumps.length === 1 && jumps[0] === MAP_CHARACTER_GOAL, `expected the Goals-tab fallback, got ${JSON.stringify(jumps.map((g) => g.id))}`)
      return 'falls back to the Goals tab, does not go dead'
    })

    handle.destroy()
  }

  {
    // The same blocked goal under the OTHER model: the disable is a fact about
    // the MODEL setting, not a property of the goal.
    const { host, state, handle, openSheet } = withMap({ trim: 'premium-le' })
    openSheet()

    test('under PREM/LE the same goal is an ordinary, tappable row with no reason line', () => {
      const row = rowFor(host, 'Orca Deck Frenzy')
      assert(row.disabled === false, 'it must be selectable on the model that has the shot')
      assert(!reasonFor(host, 'Orca Deck Frenzy'), 'nothing to explain when nothing is blocked')
      assert(!host.find('map-gsheet-row-wrap'), 'and no wrapper either — an unblocked sheet is the plain row list it always was')
      row.dispatchEvent({ type: 'click' })
      assert(state.selectedGoal === BLOCKED_GOAL, `expected it to select, got ${state.selectedGoal?.id}`)
    })

    handle.destroy()
  }

  {
    // Degrading without app.ts's wiring: a listed row that silently does
    // nothing is the exact failure this pass exists to remove.
    const { host, handle, openSheet } = withMap({ wireJump: false })
    openSheet()

    test('mounted WITHOUT the jump callback, the pathless row is disabled and says where to read it', () => {
      const row = rowFor(host, 'Attract Mode Secret')
      const reason = reasonFor(host, 'Attract Mode Secret')
      assert(row.disabled === true, 'with nowhere to send the visitor, the row must not look tappable')
      assert(reason && reason.textContent === 'Read it on the Goals tab', `got ${JSON.stringify(reason?.textContent)}`)
      assert(row.find('map-gsheet-row-meta').textContent === 'No map route', `got ${JSON.stringify(row.find('map-gsheet-row-meta').textContent)}`)
      assert(!row.find('map-gsheet-row-jump'), 'no chevron on a row that goes nowhere')
      // Same reachability pin as the trim-blocked row: this reason is the ONLY
      // thing telling the visitor where the goal actually lives.
      assert(disabledAncestorsOf(reason, host.find('pg-sheet-body')).length === 0, 'the reason must not sit inside a disabled subtree')
    })

    handle.destroy()
  }

  {
    // ---- MODEL switched while that goal is SELECTED -----------------------
    // The decision here is "disclose, do not clear" — see announceTrimChange's
    // doc comment in overlay/map2d.ts for the three reasons. These tests pin
    // both halves: the announcement happens, and the selection survives it.
    const { host, state, handle } = withMap({ trim: 'premium-le' })
    state.select(BLOCKED_GOAL)

    test('switching MODEL under the selected goal announces it — and does NOT clear the selection', () => {
      assert(!bodyEl.find('pg-toast'), 'precondition: no pill up yet')
      state.setTrim('pro')
      const toast = bodyEl.find('pg-toast')
      assert(toast, 'expected the status pill to say what just happened')
      assert(
        toast.find('pg-toast-text').textContent === 'Orca Deck Frenzy — needs Premium/LE',
        `got ${JSON.stringify(toast.find('pg-toast-text').textContent)}`,
      )
      assert(toast.find('pg-toast-check').textContent === '!', 'a ✓ would read as "done"; this is a notice, not a completion')
      assert(state.selectedGoal === BLOCKED_GOAL, 'the selection must survive — the route still draws, and the sheet can no longer re-pick it')
      return toast.find('pg-toast-text').textContent
    })

    test('the goal pill carries the fact after the pill times out (2.4s is an announcement, not a state)', () => {
      const chip = host.find('map-goal-pill-chip')
      assert(chip, 'expected the pill chip element')
      assert(chip.hidden === false, 'the chip must be visible while the selected goal is blocked')
      assert(chip.textContent === 'NOT ON PRO', `got ${JSON.stringify(chip.textContent)}`)
      // A button's aria-label REPLACES its contents, so the chip alone would
      // announce as nothing — the disclosure has to be in the label too, or it
      // is sighted-only.
      const label = host.find('map-goal-pill').getAttribute('aria-label')
      assert(
        label === 'Choose a goal — Orca Deck Frenzy: Needs Premium/LE — switch MODEL',
        `got ${JSON.stringify(label)}`,
      )
      return label
    })

    test('switching BACK clears the chip and says nothing — there is nothing wrong to report', () => {
      mapDismissToast()
      assert(!bodyEl.find('pg-toast'), 'setup: pill dismissed')
      state.setTrim('premium-le')
      assert(!bodyEl.find('pg-toast'), 'a switch that fixes the problem must not announce a problem')
      assert(host.find('map-goal-pill-chip').hidden === true, 'the chip must go away with the block')
      assert(
        host.find('map-goal-pill').getAttribute('aria-label') === 'Choose a goal',
        'the pill label must return to exactly what it has always been when there is nothing to disclose',
      )
      assert(state.selectedGoal === BLOCKED_GOAL, 'and the selection is still untouched')
    })

    test('a MODEL switch with a goal that is fine says nothing at all', () => {
      state.select(ROUTED_GOAL)
      state.setTrim('pro')
      assert(!bodyEl.find('pg-toast'), 'an all-trim goal is unaffected by the MODEL — no announcement')
      assert(host.find('map-goal-pill-chip').hidden === true, 'and no chip')
    })

    test('the announcement is mounted on document.body, not inside the map panel', () => {
      // Surface-independence, structurally. The map is a long-lived mount that
      // is HIDDEN rather than unmounted when you leave the tab, so a pill
      // parented into its host would be invisible the moment the visitor is
      // anywhere else. ui/toast.ts's own contract is document.body at z-index
      // 210 (above the shell's z-20 chrome, under the sign-up gate) — this
      // pins that the map's announcement really does go through that layer.
      state.select(BLOCKED_GOAL)
      state.setTrim('premium-le')
      state.setTrim('pro')
      const toast = bodyEl.find('pg-toast')
      assert(toast, 'expected the pill')
      assert(toast.parentElement === bodyEl, `the pill is parented to ${toast.parentElement?.className || toast.parentElement?.tagName}, not document.body`)
      assert(!host.find('pg-toast'), 'nothing may leave a pill inside the map host — it is hidden on every other tab')
      mapDismissToast()
      return 'pill on document.body, not in #map-host'
    })

    test('…and it does NOT fire while this tab is off screen — the Study rail can switch MODEL too', () => {
      // THE COST OF A SECOND MODEL CONTROL, paid here. ui/toast.ts is a
      // singleton on document.body, so a trim change made from the Study rail
      // would otherwise drop a pill about the SHOTS tab's selected goal over a
      // tab that shows no goal at all. announceTrimChange is gated on
      // isRendered(host); this drives that gate the only way a fake DOM can —
      // by giving the host the getClientRects a hidden panel would report.
      state.select(BLOCKED_GOAL)
      state.setTrim('premium-le')
      mapDismissToast()
      const realRects = host.getClientRects
      host.getClientRects = () => ({ length: 0 })
      try {
        state.setTrim('pro')
        assert(!bodyEl.find('pg-toast'), 'a MODEL switch made while the Shots tab is hidden must not toast over another tab')
        // And the STATE still landed — this suppresses an announcement, not
        // the change it was announcing.
        assert(state.trim === 'pro', 'the trim itself must still have changed')
        assert(host.find('map-goal-pill-chip').hidden === false, 'the pill chip must still carry the fact, for when the visitor comes back')
      } finally {
        if (realRects === undefined) delete host.getClientRects
        else host.getClientRects = realRects
      }
      // COMING BACK MUST NOT FIRE IT LATE either: lastTrim was updated through
      // the guard, so the next notify has no change to report.
      state._notify?.()
      assert(!bodyEl.find('pg-toast'), 'returning to the tab must not replay an announcement about a switch made minutes ago')
      state.setTrim('premium-le')
      mapDismissToast()
      return 'hidden host: no toast, trim still written, chip still correct'
    })

    // K3 pin 5a. THE ANSWER IS "NO SHARED REGION EXISTS", proven rather than
    // asserted: neither the sheet rows nor anything else the map mounts
    // creates a role="status" element (the source scan below), and the ONE
    // live region in this path — ui/toast.ts's pill — is built fresh per
    // announcement and removed on dismissal, so there is no long-lived node
    // whose text is mutated across instances. ui/toast.ts's module state is a
    // teardown handle (the element + its timer), not the region itself.
    test('LIVE REGIONS: the pill is a per-announcement element, never a reused shared node', () => {
      state.select(BLOCKED_GOAL)
      state.setTrim('premium-le')
      state.setTrim('pro')
      const first = bodyEl.find('pg-toast')
      assert(first && first.getAttribute('role') === 'status', 'expected a role=status pill')
      state.setTrim('premium-le')
      state.setTrim('pro')
      const second = bodyEl.find('pg-toast')
      assert(second, 'expected a pill for the second announcement')
      assert(second !== first, 'the second announcement must be a NEW element, not the first one re-textContent-ed')
      assert(first.parentElement === null, 'the first region must be REMOVED from the document, not left behind muted')
      const regions = bodyEl.all().filter((el) => el.getAttribute?.('role') === 'status')
      assert(regions.length === 1, `expected exactly 1 live region in the document, found ${regions.length}`)
      mapDismissToast()
      assert(bodyEl.all().filter((el) => el.getAttribute?.('role') === 'status').length === 0, 'dismissal must leave no region behind')
      return 'fresh element per announcement, 1 in the document at a time, 0 after dismissal'
    })

    mapDismissToast()
    handle.destroy()
  }

  // -------------------------------------------------------------------------
  // K3 pin: WHO CAN CHANGE MODEL — REVISED 2026-08-14, and the revision is the
  // point. This used to require exactly ONE caller (overlay/map2d.ts) on two
  // stated grounds: the block copy said "switch MODEL in settings", and
  // announceTrimChange toasts from the map's own subscriber. Its failure
  // message named the price of widening it — "the 'switch MODEL in settings'
  // copy and the map-scoped announcement both have to move" — and both have
  // now moved, because the Study rail grew the same control (rolo: "the
  // buttons on the side still aren't changing the playfield", on a Pro whose
  // only deck is Premium/LE, with the switch three surfaces away):
  //
  //   * trimBlockCopy says "switch MODEL" — the control's LABEL, which is the
  //     same word on both surfaces, instead of a room only one of them has.
  //   * announceTrimChange is gated on isRendered(host), so a switch made in
  //     the Study rail cannot drop a document.body toast about the Shots tab's
  //     selected goal over a tab that shows no goal (pinned below).
  //
  // WHAT THE PIN STILL DOES, and why it is not weakened to nothing: the caller
  // set is CLOSED and enumerated. Every .ts under src/ is scanned, so a THIRD
  // surface writing trim fails this test and has to come back here and argue
  // for itself — which is the same forcing function as before, just with the
  // list at two instead of one. Both entries also have to be the file's own
  // MODEL control (asserted immediately below), not an incidental write.
  // -------------------------------------------------------------------------
  {
    const walk = (dir) => {
      const out = []
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, e.name)
        if (e.isDirectory()) out.push(...walk(full))
        else if (e.name.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const tsFiles = walk(srcDir)

    test('state.setTrim has exactly TWO callers in the whole app, and both are a MODEL control', () => {
      assert(tsFiles.length > 20, `the scan found only ${tsFiles.length} files — it is not walking the tree`)
      const callers = []
      for (const f of tsFiles) {
        // `.setTrim(` is the CALL form. state.ts's own declaration and impl
        // (`setTrim(v: ...)`) carry no leading dot, and map2d.ts's prose
        // mention of "state.setTrim -> notify" carries no paren.
        const hits = (readFileSync(f, 'utf8').match(/\.setTrim\(/g) || []).length
        if (hits > 0) callers.push(`${relative(srcDir, f)} x${hits}`)
      }
      const files = callers.map((c) => c.split(' ')[0]).sort()
      assert(
        files.length === 2 && files[0] === 'overlay/map2d.ts' && files[1] === 'ui/study.ts',
        `MODEL is written from ${files.length} file(s): ${callers.join(', ')} — the closed set is the map's settings ` +
        `popover and the Study rail. A third writer means the "switch MODEL" copy, the isRendered gate on the ` +
        `map's toast, and this pin all have to be re-argued for that surface.`,
      )
      return `${tsFiles.length} .ts files scanned, callers: ${callers.join(', ')}`
    })

    test('neither MODEL control keeps its own copy of the trim — both read state.trim back', () => {
      // THE SYNC CONTRACT, at the source. Two controls stay in step because
      // each one is a pure function of AppState.trim re-run on every notify;
      // the moment either caches "which half is lit" in a local, they can
      // disagree — and the disagreement is invisible until someone flips one
      // and walks to the other tab.
      const map = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
      const study = readFileSync(resolve(srcDir, 'ui/study.ts'), 'utf8')
      for (const [name, src, fn] of [['overlay/map2d.ts', map, 'refreshModelControl'], ['ui/study.ts', study, 'refreshModelControl']]) {
        const body = new RegExp(`function ${fn}\\(\\): void \\{([\\s\\S]*?)\\n  \\}`).exec(src)
        assert(body, `${name}: could not find ${fn}'s body to inspect`)
        assert(/state\.trim/.test(body[1]), `${name}: ${fn} must read state.trim, not a local mirror`)
        assert(!/setTrim/.test(body[1]), `${name}: ${fn} must only REFLECT the trim — writing it from a refresh is a loop`)
      }
      // And the Study control is refreshed by the same subscription that
      // refreshes its LEVEL control, so a trim written on the OTHER tab lands
      // here too.
      assert(
        /refreshModelControl\(\)\n\s*refreshLevelControl\(\)/.test(study),
        'ui/study.ts must refresh MODEL alongside LEVEL in its state.onChange path — otherwise a switch made on the Shots tab leaves this rail lit wrong',
      )
      return 'both controls are pure reads of state.trim, refreshed on notify'
    })

    test('and those calls are the settings popover\'s PRO / PREM-LE buttons — the popover the map owns', () => {
      const src = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
      assert(/modelProBtn\.addEventListener\('click', \(\) => \{\s*state\.setTrim\('pro'\)/.test(src), 'the PRO button must be the pro call site')
      assert(/modelPremBtn\.addEventListener\('click', \(\) => \{\s*state\.setTrim\('premium-le'\)/.test(src), 'the PREM/LE button must be the premium-le call site')
      // Both buttons live in the popover mountMap2D builds. The map's toast is
      // gated on this host being on screen (isRendered), so the announcement
      // is only ever fired at someone standing on this tab — the Study rail's
      // own PRO / PREM-LE pair writes the same state without it. The pill is on
      // document.body regardless (tested above), so this is a claim about the
      // COPY being accurate, not about the pill being visible.
      assert(/modelTrack\.append\(modelProBtn, modelPremBtn\)/.test(src), 'expected both buttons in the popover\'s MODEL track')
      return 'MODEL lives in the map settings popover only'
    })

    test('no role="status" region is created by the map or its goal sheet (K3 5a: nothing shared to go stale)', () => {
      const src = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
      assert(
        !/['"]status['"]/.test(src),
        'overlay/map2d.ts now creates a live region of its own — it must be per-instance, not a shared node reused across announcements',
      )
      // The four that DO exist in the tree, none of them the map's: app.ts's
      // own live line, ui/toast.ts's pill, ui/library.ts's result count, and
      // ui/study.ts's sheet announce region (P8 — its per-instance ownership is
      // proven in study.test.mjs's two-mounted-tabs section, which is exactly
      // the "same per-instance check" this gate demands of new entrants).
      // ui/quiz.ts joined 2026-10-14: its answer-feedback region is built
      // fresh with every question inside each open sheet, never shared —
      // proven in quiz.test.mjs section g ("live region is per question").
      // ui/offline.ts's offline pill (same day) is the sixth: its
      // per-instance proof is offline.test.mjs's PER-INSTANCE section (one
      // pill however many `offline` events fire, removed on `online`, and a
      // fresh node next time — never a shared one left to go stale).
      const owners = tsFiles
        .filter((f) => /setAttribute\('role', 'status'\)/.test(readFileSync(f, 'utf8')))
        .map((f) => relative(srcDir, f))
        .sort()
      assert(
        owners.join(',') === 'app.ts,ui/library.ts,ui/offline.ts,ui/quiz.ts,ui/study.ts,ui/toast.ts',
        `the set of live-region owners changed: ${owners.join(', ')} — a new one needs the same per-instance check`,
      )
      return `live-region owners: ${owners.join(', ')} (map2d.ts: none)`
    })
  }

  // =========================================================================
  section('9b. P9 — the map speaks: canvas alt text + the spoken readout')
  // =========================================================================
  //
  // Two claims, both about the half of this tab that has never had any words
  // at all:
  //
  //   1. THE CANVAS IS A PICTURE WITH A NAME. A bare <canvas> has no implicit
  //      role and no accessible name — the biggest element on the screen
  //      announces as nothing. role=img + "Playfield map of <machine>", and
  //      the name follows the machine (a label naming the game you switched
  //      away from is worse than none).
  //   2. THE READOUT HAS A SPOKEN MIRROR. The ‹ SHOT 3 OF 5 › pill is a
  //      passive <div>; nothing tells a screen reader to look at it again
  //      after arrival. map2d writes a sentence-case line through a writer
  //      app.ts hands it (the region itself is app.ts's — section 11, and the
  //      owner-set gate directly above, are the other half of that story).
  //
  // The interesting part is what it must NOT say: auto mode marches the
  // highlight on its own and calls updateControls every time it moves, so the
  // naive mirror is a voice interrupting itself every 2.5 seconds forever.
  // "Exactly one line while auto-cycling" is the load-bearing claim here, and
  // the burst tests are the other one — a held › must not queue nine
  // announcements a polite region would faithfully read all of.
  {
    // A HAND-DRIVEN CLOCK. The coalescing window is a window.setTimeout, and
    // this suite's fake `window` deliberately has no timers (nothing else
    // here schedules one). Installed for this block only and removed at the
    // end, so nothing after it inherits a clock that never ticks.
    const timers = new Map()
    let timerSeq = 0
    window.setTimeout = (fn) => {
      timerSeq += 1
      timers.set(timerSeq, fn)
      return timerSeq
    }
    window.clearTimeout = (id) => {
      timers.delete(id)
    }
    /** Fires every ARMED timer once. The announcer re-arms inside its own
     *  callback; the snapshot is taken first, so a re-arm survives this tick
     *  instead of running inside it. */
    const tick = () => {
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) fn()
      return due.length
    }
    /** Runs the coalescing chain out to quiet — it terminates on its own (a
     *  flush with nothing pending does not re-arm), so this is bounded. */
    const settle = () => {
      for (let i = 0; i < 6 && timers.size > 0; i += 1) tick()
    }

    // A 5-step goal, because a burst needs somewhere to burst to, and two
    // skill shots, because "SKILL SHOT 2 OF 2" needs a carousel to be 2 of.
    const LONG_GOAL = {
      id: 'g-long', title: 'Shark Frenzy', category: 'mode', summary: 's', difficulty: 2,
      steps: [
        { shot: 'all-ramp', action: 'a' }, { shot: 'orca-deck', action: 'b' }, { shot: 'all-ramp', action: 'c' },
        { shot: 'orca-deck', action: 'd' }, { shot: 'all-ramp', action: 'e' },
      ],
    }
    const SKILL_A = {
      id: 'g-skill-a', title: 'Super Skill Shot', category: 'skillshot', summary: 's', difficulty: 2,
      steps: [{ shot: 'all-ramp', action: 'plunge soft' }],
    }
    const SKILL_B = {
      id: 'g-skill-b', title: 'Secret Skill Shot', category: 'skillshot', summary: 's', difficulty: 3,
      steps: [{ shot: 'orca-deck', action: 'plunge full' }],
    }

    /** The real map, mounted with a RECORDING writer as its fourth argument.
     *
     *  goToStep/pauseHighlight/resumeHighlight are no-ops on the shared
     *  makeMapState (section 9 never steps); they are given the real
     *  AppStateImpl behaviour here — mutate, then notify — because the whole
     *  subject of this block is what a step SAYS. */
    function withSpeakingMap({ trim = 'premium-le', speak = true } = {}) {
      resetDom()
      timers.clear()
      const spoken = []
      const state = makeMapState(trim)
      state.data = { ...state.data, goals: [...MAP_GOALS, LONG_GOAL, SKILL_A, SKILL_B] }
      state.goToStep = (i) => {
        state.stepIndex = i
        state.notify()
      }
      state.pauseHighlight = () => {
        if (state.highlightMode === 'manual') return
        state.highlightMode = 'manual'
        state.notify()
      }
      state.resumeHighlight = () => {
        if (state.highlightMode === 'auto') return
        state.highlightMode = 'auto'
        state.notify()
      }
      const host = new FakeElement('div')
      host.clientWidth = 600
      host.clientHeight = 900
      bodyEl.appendChild(host)
      const handle = speak
        ? mountMap2D(host, state, () => {}, (text) => spoken.push(text))
        : mountMap2D(host, state, () => {})
      const stepBtns = host.findAll('map-step-btn')
      if (stepBtns.length !== 2) throw new Error(`expected the ‹ › pair, found ${stepBtns.length} .map-step-btn`)
      return {
        host, state, handle, spoken,
        prev: stepBtns[0],
        next: stepBtns[1],
        readout: host.find('map-step-readout'),
        canvas: host.find('map-canvas'),
      }
    }

    // ---- 1. The canvas is a picture with a name ----------------------------

    test('the map canvas is a named IMAGE, not an unlabelled box', () => {
      const { canvas } = withSpeakingMap()
      assert(canvas, 'expected the map canvas')
      assert(canvas.getAttribute('role') === 'img', `role is ${JSON.stringify(canvas.getAttribute('role'))} — a bare <canvas> announces as nothing`)
      assert(
        canvas.getAttribute('aria-label') === 'Playfield map of P7b Machine',
        `got ${JSON.stringify(canvas.getAttribute('aria-label'))}`,
      )
      return `role=img · ${canvas.getAttribute('aria-label')}`
    })

    test('and the name FOLLOWS the machine — a switch relabels it', () => {
      const { canvas, state } = withSpeakingMap()
      state.machine = { id: 'jaws', name: 'Jaws', shortTitle: 'JAWS' }
      state.data = { ...state.data, machine: 'Jaws' }
      state.notify()
      assert(
        canvas.getAttribute('aria-label') === 'Playfield map of Jaws',
        `after the switch the label is ${JSON.stringify(canvas.getAttribute('aria-label'))} — it names the machine you left`,
      )
      // Nothing loaded: the unqualified name, never a stale one.
      state.machine = null
      state.data = null
      state.notify()
      assert(canvas.getAttribute('aria-label') === 'Playfield map', `got ${JSON.stringify(canvas.getAttribute('aria-label'))}`)
      return 'P7b Machine -> Jaws -> (none) = "Playfield map"'
    })

    // ---- 2. What a manual move says ---------------------------------------

    test('a manual ‹ › step speaks the position AND the shot, in sentence case', () => {
      const m = withSpeakingMap()
      m.state.select(LONG_GOAL)
      m.readout.click() // AUTO -> PAUSED (manual)
      settle()
      const before = m.spoken.length
      m.next.click()
      settle()
      assert(m.spoken.length === before + 1, `expected exactly one new line, got ${JSON.stringify(m.spoken.slice(before))}`)
      assert(
        m.spoken.at(-1) === 'Shot 2 of 5 — Orca Deck',
        `got ${JSON.stringify(m.spoken.at(-1))} — spoken text is sentence case (a voice shouts or spells out SHOT 2 OF 5)`,
      )
      m.prev.click()
      settle()
      assert(m.spoken.at(-1) === 'Shot 1 of 5 — All Ramp', `‹ said ${JSON.stringify(m.spoken.at(-1))}`)
      m.handle.destroy()
      return `${m.spoken.slice(-2).join(' | ')}`
    })

    test('a step whose shot id is missing from the dataset still says WHERE you are', () => {
      const m = withSpeakingMap()
      const ORPHAN = {
        id: 'g-orphan', title: 'Orphan', category: 'mode', summary: 's', difficulty: 1,
        steps: [{ shot: 'all-ramp', action: 'a' }, { shot: 'no-such-shot', action: 'b' }],
      }
      m.state.select(ORPHAN)
      m.readout.click()
      settle()
      m.next.click()
      settle()
      assert(m.spoken.at(-1) === 'Shot 2 of 2', `got ${JSON.stringify(m.spoken.at(-1))} — the position is true, only the name is unknown`)
      m.handle.destroy()
      return m.spoken.at(-1)
    })

    test('the skill-shot carousel speaks its own position and title', () => {
      const m = withSpeakingMap()
      m.state.select(SKILL_B)
      m.state.pauseHighlight()
      settle()
      assert(
        m.spoken.at(-1) === 'Skill shot 2 of 2 — Secret Skill Shot',
        `got ${JSON.stringify(m.spoken.at(-1))}`,
      )
      // The same n OF m the pill is showing — one derivation, two voices.
      const pill = m.host.find('map-step-readout-label').textContent
      assert(pill === 'SKILL SHOT 2 OF 2 · Secret Skill Shot', `the pill says ${JSON.stringify(pill)}`)
      m.handle.destroy()
      return `${pill}  ->  ${m.spoken.at(-1)}`
    })

    // ---- 3. THE AUTO-MODE GUARD (the mutation gate) ------------------------

    test('AUTO MODE SAYS ONE LINE, no matter how many times the readout moves', () => {
      const m = withSpeakingMap()
      m.state.select(LONG_GOAL) // auto is the default
      assert(m.spoken.length === 1, `selecting a goal should say one thing, said ${JSON.stringify(m.spoken)}`)
      assert(m.spoken[0] === 'Auto-cycling the route — Shark Frenzy', `got ${JSON.stringify(m.spoken[0])}`)
      // Every path that redraws the readout, twenty times over: the auto
      // march calls updateControls from render() on each index move, and
      // every notify() calls it too. Both funnel through the same announcer.
      for (let i = 0; i < 20; i += 1) {
        m.state.stepIndex = i % LONG_GOAL.steps.length
        m.state.notify()
        settle()
      }
      assert(
        m.spoken.length === 1,
        `auto mode announced ${m.spoken.length} times — a voice interrupting itself every 2.5s: ${JSON.stringify(m.spoken)}`,
      )
      m.handle.destroy()
      return `20 readout moves in auto -> ${m.spoken.length} announcement`
    })

    test('and the skill-shot carousel rolling goal-to-goal on its own stays just as quiet', () => {
      const m = withSpeakingMap()
      m.state.select(SKILL_A)
      assert(m.spoken.at(-1) === 'Auto-cycling the skill shots', `got ${JSON.stringify(m.spoken.at(-1))}`)
      const after = m.spoken.length
      // Feature 6's auto-cycle SELECTS the next skill shot every hold — the
      // one case where auto changes the goal itself, which is exactly why
      // this line carries no title.
      m.state.select(SKILL_B)
      m.state.select(SKILL_A)
      settle()
      assert(m.spoken.length === after, `the carousel spoke ${m.spoken.length - after} extra times: ${JSON.stringify(m.spoken.slice(after))}`)
      m.handle.destroy()
      return `2 carousel rolls -> ${m.spoken.length - after} extra announcements`
    })

    test('a SELECTION change still speaks in auto mode — it is the one thing auto does not do by itself', () => {
      const m = withSpeakingMap()
      m.state.select(LONG_GOAL)
      settle()
      m.state.select(ROUTED_GOAL)
      settle()
      assert(
        m.spoken.at(-1) === 'Auto-cycling the route — Chum Multiball',
        `got ${JSON.stringify(m.spoken.at(-1))} — picking a goal must say WHICH goal`,
      )
      m.handle.destroy()
      return m.spoken.at(-1)
    })

    test('clearing and re-picking the SAME goal announces again (the repeat guard forgets)', () => {
      const m = withSpeakingMap()
      m.state.select(LONG_GOAL)
      settle()
      const after = m.spoken.length
      m.state.clearSelection()
      settle()
      assert(m.spoken.length === after, 'clearing the selection has nothing to say')
      m.state.select(LONG_GOAL)
      settle()
      assert(
        m.spoken.length === after + 1 && m.spoken.at(-1) === 'Auto-cycling the route — Shark Frenzy',
        `re-picking said ${JSON.stringify(m.spoken.slice(after))} — identical text is still a NEW announcement after a clear`,
      )
      m.handle.destroy()
      return 'select -> clear -> select = 2 announcements'
    })

    // ---- 4. Bursts ---------------------------------------------------------

    test('a BURST of manual steps is one immediate line plus one trailing line, not nine', () => {
      const m = withSpeakingMap()
      m.state.select(LONG_GOAL)
      m.readout.click() // manual
      settle()
      const before = m.spoken.length
      // A held › — four moves inside one window.
      m.next.click()
      m.next.click()
      m.next.click()
      m.next.click()
      const immediate = m.spoken.slice(before)
      assert(
        immediate.length === 1 && immediate[0] === 'Shot 2 of 5 — Orca Deck',
        `the FIRST move must speak at once (no waiting for a window), got ${JSON.stringify(immediate)}`,
      )
      const fired = tick()
      assert(fired === 1, `expected one armed window, fired ${fired}`)
      const trailing = m.spoken.slice(before)
      assert(
        trailing.length === 2 && trailing[1] === 'Shot 5 of 5 — All Ramp',
        `the trailing write must carry the LAST position, got ${JSON.stringify(trailing)}`,
      )
      // The chain terminates on its own: one more window with nothing pending.
      tick()
      assert(m.spoken.slice(before).length === 2, `the chain spoke again after the burst: ${JSON.stringify(m.spoken.slice(before))}`)
      assert(timers.size === 0, `${timers.size} timer(s) still armed after the chain ran out`)
      m.handle.destroy()
      return `4 rapid steps -> ${trailing.join(' | ')}`
    })

    test('destroy() cancels a pending announcement — no voice from a torn-down tab', () => {
      const m = withSpeakingMap()
      m.state.select(LONG_GOAL)
      m.readout.click()
      settle()
      m.next.click()
      m.next.click() // one pending inside the window
      const before = m.spoken.length
      m.handle.destroy()
      assert(timers.size === 0, `destroy left ${timers.size} timer(s) armed`)
      tick()
      assert(m.spoken.length === before, `a torn-down map spoke: ${JSON.stringify(m.spoken.slice(before))}`)
      return 'pending write cancelled with the mount'
    })

    // ---- 5. Degrading without a writer -------------------------------------

    test('a map mounted WITHOUT the writer is silent, not broken (trailing-optional)', () => {
      const m = withSpeakingMap({ speak: false })
      m.state.select(LONG_GOAL)
      m.readout.click()
      m.next.click()
      m.next.click()
      assert(m.spoken.length === 0, 'nothing can be spoken with no writer')
      assert(timers.size === 0, `a silent map armed ${timers.size} coalescing timer(s) — it should not schedule at all`)
      const label = m.host.find('map-step-readout-label').textContent
      assert(label === 'SHOT 3 OF 5', `the visible readout still works: got ${JSON.stringify(label)}`)
      m.handle.destroy()
      return `3-argument mount: 0 announcements, visible pill still "${label}"`
    })

    delete window.setTimeout
    delete window.clearTimeout
  }

  await rm(tmpMap, { recursive: true, force: true })
}

// ===========================================================================
section('10. P7b — app.ts owns the jump, and switches tab BEFORE selecting')
// ===========================================================================
{
  resetDom()
  globalThis.__mapMounts = []
  const state = makeState({ selectedGoal: PATHFUL_GOAL, stepIndex: 1 })
  const root = mount(state)
  // Visiting the Shots tab is what lazily mounts the map — the same path a
  // real tap takes. loadChunk resolves the (stubbed) import a task later.
  root.find('step-btn-map').click()
  await flushTask()

  await testAsync('mountMap2D is handed a jumpToGoalDetail callback', async () => {
    assert(globalThis.__mapMounts.length === 1, `expected 1 map mount, got ${globalThis.__mapMounts.length}`)
    assert(
      typeof globalThis.__mapMounts[0].jumpToGoalDetail === 'function',
      'app.ts mounted the map without the third argument — every pathless row in the sheet would be a dead end',
    )
  })

  await testAsync('calling it lands on the Goals tab with THAT goal\'s detail open', async () => {
    const { jumpToGoalDetail } = globalThis.__mapMounts[0]
    const panels = root.findAll('tab-panel')
    const goalsPanel = panels.find((p) => p.id === 'goals-view')
    const mapPanel = panels.find((p) => p.id === 'map-host')
    assert(mapPanel.hidden === false, 'precondition: we are on the Shots tab')

    jumpToGoalDetail(PATHLESS_GOAL)

    assert(goalsPanel.hidden === false, 'the Goals panel must be showing')
    assert(mapPanel.hidden === true, 'the Shots panel must be hidden')
    const goalsTab = root.findAll('tab-btn').find((b) => b.id === 'tab-goals')
    assert(goalsTab.getAttribute('aria-selected') === 'true', 'the Goals tab must be the selected tab')
    assert(state.selectedGoal === PATHLESS_GOAL, `expected ${PATHLESS_GOAL.id} selected, got ${state.selectedGoal?.id}`)
    assert(root.find('goal-instructions'), 'expected the goal DETAIL (its instructions), not the goal list')
    return 'goals panel shown, detail rendered'
  })

  await testAsync('THE ORDER: the tab switch (which clears the selection) runs BEFORE the select', async () => {
    // The Goals tab handler calls state.clearSelection() — "tapping Goals
    // always lands back on the list". Select-then-switch would therefore wipe
    // the selection the jump just made and land on the list instead.
    const order = state.calls.order
    const tail = order.slice(-2)
    assert(
      tail[0] === 'clearSelection' && tail[1] === 'select',
      `expected [...clearSelection, select] at the end, got ${JSON.stringify(order)}`,
    )
    assert(state.calls.select.at(-1) === PATHLESS_GOAL.id, `the last select() was ${state.calls.select.at(-1)}`)
    return order.join(' -> ')
  })
}

// ===========================================================================
section('11. P9 — app.ts owns the spoken region, and the Study canvas has a name')
// ===========================================================================
//
// The map's half of P9 is section 9b. This is the shell's half, and it is
// where the OWNERSHIP claim is proven rather than asserted: the live region
// the map speaks through is built by app.ts, outside all four tab panels, and
// map2d is handed nothing but a function. The source-scan gate at the end of
// section 9 pins the same fact from the other direction (map2d.ts creates no
// region of its own); this pins that the region app.ts does create is in a
// place where an announcement can actually happen — a region inside a
// `hidden` panel is not announced, and one built at the same moment as its
// first text is announced unreliably.
{
  resetDom()
  globalThis.__mapMounts = []
  const state = makeState({ selectedGoal: PATHFUL_GOAL })
  const root = mount(state)
  root.find('step-btn-map').click()
  await flushTask()

  const mainEl = root.all().find((el) => el.id === 'main-content')
  const panelOf = (el) => {
    for (let p = el?.parentElement; p; p = p.parentElement) {
      if (p.className.split(/\s+/).includes('tab-panel')) return p
    }
    return null
  }
  const hiddenAncestor = (el) => {
    for (let p = el; p; p = p.parentElement) if (p.hidden === true) return p
    return null
  }

  await testAsync('app.ts hands mountMap2D a writer as its fourth argument', async () => {
    assert(globalThis.__mapMounts.length === 1, `expected 1 map mount, got ${globalThis.__mapMounts.length}`)
    assert(
      typeof globalThis.__mapMounts[0].speakReadout === 'function',
      'the map was mounted with no writer — every ‹ › step would be silent for a screen reader',
    )
  })

  await testAsync('the words land in exactly ONE polite region, and no tab panel owns it', async () => {
    const { speakReadout } = globalThis.__mapMounts[0]
    speakReadout('Shot 2 of 3 — Right Ramp')

    const regions = root.all().filter((el) => el.getAttribute?.('role') === 'status')
    assert(regions.length === 1, `expected exactly 1 live region in the shell, found ${regions.length}`)
    const live = regions[0]
    assert(live.className.split(/\s+/).includes('sr-only'), `the region must be visually hidden, got className ${JSON.stringify(live.className)}`)
    assert(live.textContent === 'Shot 2 of 3 — Right Ramp', `the region says ${JSON.stringify(live.textContent)}`)
    assert(live.parentElement === mainEl, `the region is parented to ${live.parentElement?.id || live.parentElement?.className} — it belongs to the shell, not a tab`)
    assert(panelOf(live) === null, `the region sits inside the ${panelOf(live)?.id} panel — a region in a hidden panel is not announced`)
    // Written again, not replaced: this is a long-lived node whose text
    // changes, which is the shape a polite region has to have.
    speakReadout('Shot 3 of 3 — Center Scoop')
    const after = root.all().filter((el) => el.getAttribute?.('role') === 'status')
    assert(after.length === 1 && after[0] === live, 'the second write must reuse the same region, not build a second one')
    assert(live.textContent === 'Shot 3 of 3 — Center Scoop', `got ${JSON.stringify(live.textContent)}`)
    return `1 region, on #${live.parentElement?.id}, written twice`
  })

  await testAsync('and it stays announceable when the Shots tab is hidden behind another tab', async () => {
    const live = root.all().find((el) => el.getAttribute?.('role') === 'status')
    const mapPanel = root.findAll('tab-panel').find((p) => p.id === 'map-host')
    const tabBtn = (id) => root.findAll('tab-btn').find((b) => b.id === id)
    tabBtn('tab-goals').click()
    assert(mapPanel.hidden === true, 'precondition: the Shots panel is hidden now')
    assert(hiddenAncestor(live) === null, `the region went hidden with the tab (${hiddenAncestor(live)?.id}) — nothing in it would ever be read`)
    tabBtn('tab-map').click()
    return 'region outside the hidden subtree'
  })

  await testAsync('the Study canvas is a named IMAGE too, and the name follows the machine', async () => {
    // ui/study.ts is not edited by this pass, so app.ts labels the canvas
    // mountStudy builds. The canvas here stands in for that one: same place
    // (a child of the study panel), same lifetime. The source check below is
    // what ties this stand-in to the real thing.
    const studyPanel = root.findAll('tab-panel').find((p) => p.id === 'study-host')
    const canvas = fakeDocument.createElement('canvas')
    studyPanel.appendChild(canvas)
    state.notify()
    assert(canvas.getAttribute('role') === 'img', `role is ${JSON.stringify(canvas.getAttribute('role'))}`)
    assert(canvas.getAttribute('aria-label') === 'Study view of Test Machine', `got ${JSON.stringify(canvas.getAttribute('aria-label'))}`)

    state.machine = { ...MACHINE, name: 'Jaws' }
    state.notify()
    assert(canvas.getAttribute('aria-label') === 'Study view of Jaws', `after the switch: ${JSON.stringify(canvas.getAttribute('aria-label'))}`)
    state.machine = MACHINE
    canvas.remove()
    return 'Study view of Test Machine -> Study view of Jaws'
  })

  await testAsync('the lookup walks the tree — a canvas one wrapper deep is still found', async () => {
    const studyPanel = root.findAll('tab-panel').find((p) => p.id === 'study-host')
    const wrap = fakeDocument.createElement('div')
    const canvas = fakeDocument.createElement('canvas')
    wrap.appendChild(canvas)
    studyPanel.appendChild(wrap)
    state.notify()
    assert(canvas.getAttribute('aria-label') === 'Study view of Test Machine', `got ${JSON.stringify(canvas.getAttribute('aria-label'))}`)
    wrap.remove()
    return 'nested canvas labelled'
  })

  await testAsync('and ui/study.ts really does put its canvas where that lookup will find it', async () => {
    // The stand-in above is only honest if the real mountStudy parents its
    // canvas into the host app.ts hands it. Read, not assumed.
    const studySrc = readFileSync(resolve(srcDir, 'ui/study.ts'), 'utf8')
    assert(/const canvas = document\.createElement\('canvas'\)/.test(studySrc), 'ui/study.ts no longer builds a canvas')
    assert(
      /host\.append\(canvas,/.test(studySrc),
      'ui/study.ts no longer appends its canvas into the mount host — app.ts\'s label lookup would find nothing',
    )
    return "study.ts: host.append(canvas, …)"
  })
}


// ===========================================================================
section('12. CHARACTER — app.ts owns the Shots -> Study jump, including the lazy mount')
// ===========================================================================
//
// The map's half of this is section 9's retarget tests (which row, which
// wording, which callback). This is the SHELL's half, and it is the half with
// the timing problem in it: the Study tab is mounted lazily and
// ASYNCHRONOUSLY, so the very first character-row tap — the common case, since
// the visitor is by definition standing on the Shots tab — arrives with no
// Study module loaded at all. A jump that fired straight into a null handle
// would land on a Study tab with nothing open and no way to tell that anything
// had been asked for.
{
  resetDom()
  globalThis.__mapMounts = []
  globalThis.__studyMounts = []
  const state = makeState({ selectedGoal: PATHFUL_GOAL, stepIndex: 1 })
  const root = mount(state)
  root.find('step-btn-map').click()
  await flushTask()

  const panelById = (id) => root.findAll('tab-panel').find((p) => p.id === id)
  const tabBtn = (id) => root.findAll('tab-btn').find((b) => b.id === id)

  await testAsync('mountMap2D is handed a jumpToStudyCharacter callback as its FIFTH argument', async () => {
    assert(globalThis.__mapMounts.length === 1, `expected 1 map mount, got ${globalThis.__mapMounts.length}`)
    assert(
      typeof globalThis.__mapMounts[0].jumpToStudyCharacter === 'function',
      'app.ts mounted the map without the fifth argument — every character row would fall back to the Goals tab',
    )
    // ...and it did not lose the fourth on the way (the arguments are
    // positional, and a shifted one is a silent behaviour swap).
    assert(typeof globalThis.__mapMounts[0].speakReadout === 'function', 'the spoken-readout writer moved or was dropped')
    assert(typeof globalThis.__mapMounts[0].jumpToGoalDetail === 'function', 'the Goals-tab jump moved or was dropped')
  })

  await testAsync('THE FIRST JUMP, with Study never visited: it switches tab, mounts, and OPENS — in that order', async () => {
    const { jumpToStudyCharacter } = globalThis.__mapMounts[0]
    assert(globalThis.__studyMounts.length === 0, 'precondition: the Study tab has never been visited')
    assert(panelById('map-host').hidden === false, 'precondition: we are on the Shots tab')

    jumpToStudyCharacter()

    // The tab switch is synchronous...
    assert(panelById('study-host').hidden === false, 'the Study panel must be showing')
    assert(panelById('map-host').hidden === true, 'the Shots panel must be hidden')
    assert(tabBtn('tab-study').getAttribute('aria-selected') === 'true', 'the Study tab must be the selected tab')
    // ...the mount is not: loadChunk resolves a dynamic import a task later.
    // This is the exact window in which a naive implementation would call
    // openCharacter() on a null handle and silently do nothing.
    assert(globalThis.__studyMounts.length === 0, 'setup: the chunk has not resolved yet, which is the whole point of this test')
    await flushTask()

    assert(globalThis.__studyMounts.length === 1, `expected the Study tab to mount, got ${globalThis.__studyMounts.length} mounts`)
    assert(globalThis.__studyMounts[0].handle.opens === 1, `expected the CHARACTER sheet to be opened once on arrival, got ${globalThis.__studyMounts[0].handle.opens}`)
    return 'tab switched, chunk resolved, sheet opened once'
  })

  await testAsync('and it does NOT select the goal — the door is a collection, not a detail view', async () => {
    // jumpToGoalDetail must select (a detail screen is about one goal);
    // this one must not, or the Shots map behind it would silently change
    // what it is drawing every time somebody read about their character.
    assert(state.calls.select.length === 0, `something selected a goal on the way to Study: ${JSON.stringify(state.calls.select)}`)
    assert(state.selectedGoal === PATHFUL_GOAL, `the map's selection changed to ${state.selectedGoal?.id}`)
    return 'no select() on the character path'
  })

  await testAsync('THE SECOND JUMP, with Study already mounted: it opens immediately and mounts nothing new', async () => {
    const { jumpToStudyCharacter } = globalThis.__mapMounts[0]
    tabBtn('tab-goals').click()
    assert(panelById('study-host').hidden === true, 'setup: away from the Study tab')

    jumpToStudyCharacter()

    // No await: with the module already loaded there is nothing to wait for,
    // and a second mount would mean the shell forgot it had one.
    assert(panelById('study-host').hidden === false, 'the Study panel must be showing again')
    assert(globalThis.__studyMounts.length === 1, `the Study tab was mounted a second time (${globalThis.__studyMounts.length})`)
    assert(globalThis.__studyMounts[0].handle.opens === 2, `expected a second open, got ${globalThis.__studyMounts[0].handle.opens}`)
    await flushTask()
    assert(globalThis.__studyMounts[0].handle.opens === 2, 'the pending-jump flag fired again on a mount that had already happened')
    return 'opened on arrival, one mount, two opens'
  })

  await testAsync('a plain visit to the Study tab opens NOTHING — the flag is consumed, not sticky', async () => {
    const opensBefore = globalThis.__studyMounts[0].handle.opens
    tabBtn('tab-goals').click()
    tabBtn('tab-study').click()
    await flushTask()
    assert(
      globalThis.__studyMounts[0].handle.opens === opensBefore,
      `visiting the Study tab by hand opened the CHARACTER sheet (${globalThis.__studyMounts[0].handle.opens} vs ${opensBefore}) — the jump flag is sticky`,
    )
    return `${opensBefore} opens before, ${globalThis.__studyMounts[0].handle.opens} after a manual visit`
  })
}

// ===========================================================================
section('13. THE LANDING — boot and every machine switch land on Study with HOW IT PLAYS open (2026-10-14)')
// ===========================================================================
//
// rolo's first-time-visitor walk: the app booted onto the Goals list while the
// best beginner screen, HOW IT PLAYS, sat two taps deep on Study. This is the
// SHELL's half of the fix — which tab is showing, and that app.ts asked the
// Study handle for HOW IT PLAYS (the stub counts it). The sheet itself, its
// top-scroll and its open-not-toggle rule are tests/study.test.mjs section
// (al)'s subject, against a harness that can mount the real tab.
{
  /** Enough of a schema-v9 howItPlays for app.ts's structural check. */
  const HIP = {
    objective: 'Read me first.',
    loop: ['One.', 'Two.', 'Three.'],
    lights: [{ id: 'l', name: 'L', kind: 'status', sites: [{ shot: SHOTS[0].id }], lit: 'lit', then: 'then' }],
    laneChange: 'unknown',
    scoring: [],
  }
  const MACHINE_B = { id: 'machine-b', name: 'Machine B', shortTitle: 'B', resource: 'b_goals' }
  const panelById = (root, id) => root.findAll('tab-panel').find((p) => p.id === id)
  const tabBtn = (root, id) => root.findAll('tab-btn').find((b) => b.id === id)
  /** Stands in for a successful state.selectMachine(): the real loadMachine
   *  replaces machine + data + selection, then notifies once. */
  function switchMachine(state, machine, data) {
    state.machine = machine
    state.data = data
    state.selectedGoal = null
    state.stepIndex = 0
    state.notify()
  }

  resetDom()
  globalThis.__studyMounts = []
  const state = makeState()
  state.data.howItPlays = HIP
  const root = mount(state)
  // Read SYNCHRONOUSLY, before any await lets the chunk's import resolve.
  const mountsAtFirstPaint = globalThis.__studyMounts.length

  await testAsync('BOOT: the Study tab is selected and showing at first paint — Goals is hidden', async () => {
    assert(panelById(root, 'study-host').hidden === false, 'the Study panel is not showing')
    assert(panelById(root, 'goals-view').hidden === true, 'the Goals panel is still showing')
    assert(tabBtn(root, 'tab-study').getAttribute('aria-selected') === 'true', 'the Study tab is not the selected tab')
    assert(tabBtn(root, 'tab-study').tabIndex === 0 && tabBtn(root, 'tab-goals').tabIndex === -1, 'the roving tab stop did not follow the landing')
  })

  await testAsync('BOOT: once the Study chunk lands, HOW IT PLAYS is opened exactly once (and CHARACTER is not)', async () => {
    assert(mountsAtFirstPaint === 0, 'setup: the chunk had already resolved at first paint — the pending slot is untested')
    await flushTask()
    assert(globalThis.__studyMounts.length === 1, `expected one Study mount, got ${globalThis.__studyMounts.length}`)
    const handle = globalThis.__studyMounts[0].handle
    assert(handle.hipOpens === 1, `expected one HOW IT PLAYS open, got ${handle.hipOpens}`)
    assert(handle.opens === 0, 'the landing opened CHARACTER')
    await flushTask()
    assert(handle.hipOpens === 1, 'the pending slot fired twice')
  })

  await testAsync('A MACHINE SWITCH from the Goals tab lands on Study + HOW IT PLAYS — after the notify, not inside it', async () => {
    tabBtn(root, 'tab-goals').click()
    assert(panelById(root, 'goals-view').hidden === false, 'setup: on Goals')
    const handle = globalThis.__studyMounts[0].handle
    switchMachine(state, MACHINE_B, { machine: MACHINE_B.name, shots: SHOTS, goals: [PATHFUL_GOAL], sources: [], howItPlays: HIP })
    // Deferred to a microtask on purpose: the real Study tab's own listener
    // runs AFTER app.ts's in the same notify and closes every sheet on a
    // machine change, so an open made inside the notify would be undone.
    assert(handle.hipOpens === 1, 'opened INSIDE the notify — the Study tab would close it again one listener later')
    await flushTask()
    assert(panelById(root, 'study-host').hidden === false, 'the switch did not land on Study')
    assert(handle.hipOpens === 2, `expected a second HOW IT PLAYS open, got ${handle.hipOpens}`)
    assert(globalThis.__studyMounts.length === 1, 'the landing re-mounted Study')
  })

  await testAsync('a notify that is NOT a machine switch (a goal picked, a pref changed) does not land anywhere', async () => {
    tabBtn(root, 'tab-goals').click()
    const handle = globalThis.__studyMounts[0].handle
    const before = handle.hipOpens
    state.select(PATHFUL_GOAL)
    state.notify()
    await flushTask()
    assert(panelById(root, 'goals-view').hidden === false, 'a non-switch notify moved the visitor off the Goals tab')
    assert(handle.hipOpens === before, 'a non-switch notify opened HOW IT PLAYS')
    // ...and the Goals tab's own contract survives the landing work: a tap
    // on Goals with a detail open still returns to the LIST.
    const clears = state.calls.clearSelection
    tabBtn(root, 'tab-goals').click()
    assert(state.calls.clearSelection === clears + 1 && state.selectedGoal === null, 'the Goals tab no longer returns to the list')
  })

  await testAsync('FALLBACK: switching to a machine with NO howItPlays keeps the current tab (the old behaviour)', async () => {
    const handle = globalThis.__studyMounts[0].handle
    const before = handle.hipOpens
    switchMachine(state, MACHINE, { machine: MACHINE.name, shots: SHOTS, goals: [PATHFUL_GOAL], sources: [] })
    await flushTask()
    assert(panelById(root, 'goals-view').hidden === false, 'a machine without HOW IT PLAYS still pulled the visitor to Study')
    assert(handle.hipOpens === before, 'opened a HOW IT PLAYS that does not exist')
  })
}

{
  resetDom()
  globalThis.__studyMounts = []
  const state = makeState({ selectedGoal: PATHFUL_GOAL, stepIndex: 0 })
  state.data.howItPlays = { objective: 'x', loop: ['a'], lights: [], laneChange: 'unknown', scoring: [] }
  const root = mount(state)
  await testAsync('a ?goal= DEEP LINK keeps the Goals boot — the link lands on the goal\'s steps, not under a sheet', async () => {
    await flushTask()
    assert(root.findAll('tab-panel').find((p) => p.id === 'goals-view').hidden === false, 'the deep-linked goal detail was buried by the landing')
    assert(root.find('goal-detail'), 'the goal detail is not rendered')
    assert(globalThis.__studyMounts.length === 0, 'Study was mounted for a deep-linked boot')
  })
}

{
  resetDom()
  globalThis.__studyMounts = []
  const root = mount(makeState())
  await testAsync('a machine with NO howItPlays boots on Goals exactly as before', async () => {
    await flushTask()
    assert(root.findAll('tab-panel').find((p) => p.id === 'goals-view').hidden === false, 'no HOW IT PLAYS, yet the boot left Goals')
    assert(globalThis.__studyMounts.length === 0, 'Study was mounted with nothing to land on')
  })
}

test('showGoalOnMap\'s machine switch is NOT a landing (source pin: the Achievements tab is session-gated, so its SHOW ME path is not mountable here)', () => {
  const appSrcNow = readFileSync(appPath, 'utf8')
  const fn = /async function showGoalOnMap[\s\S]*?\n {2}\}\n/.exec(appSrcNow)?.[0] ?? ''
  assert(fn, 'showGoalOnMap not found in app.ts')
  assert(/suppressLanding = true\s*\n\s*try \{\s*\n\s*await state\.selectMachine\(machine\)\s*\n\s*\} finally \{\s*\n\s*suppressLanding = false/.test(fn), 'showGoalOnMap no longer suppresses the landing around its selectMachine')
  assert(/if \(!suppressLanding\) queueMicrotask\(landOnHowItPlays\)/.test(appSrcNow), 'renderAll no longer honours suppressLanding')
})

await rm(tmp, { recursive: true, force: true })

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
