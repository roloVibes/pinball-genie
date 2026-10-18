#!/usr/bin/env node
// app/tests/card.test.mjs — SUITE 13: was the Card tab (phase B3,
// ui/machinecard.ts) — the at-the-machine surface: SKILL SHOT / THE LINE /
// SAFE / DANGER / REMINDERS / PRACTICE — plus app.ts's tab-bar suite.
//
// RETIRED 2026-08-11 (owner: "Remove all cards. That feature has been
// removed."). Sections 1-5, which mounted ui/machinecard.ts against
// synthetic fixtures and asserted on its rendered SKILL SHOT/THE LINE/SAFE/
// DANGER/REMINDERS/PRACTICE sections, are DELETED — that surface no longer
// exists anywhere in the app (ui/machinecard.ts is unimported, UNIMPORT
// pattern, see its own header). What remains below is section 6 only: the
// app.ts tab-bar suite (Goals/Shots/Study/Achievements), which never tested
// card content and is unaffected by the removal. Filename is unchanged —
// "Rename nothing" — so this suite keeps living in card.test.mjs even
// though it no longer covers a card.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/card.test.mjs"
// or from app/:
//   node tests/card.test.mjs
//
// Pattern: identical to signup-gate.test.mjs / account-cta.test.mjs —
// esbuild bundles the REAL .ts source (never edited, never copied) into a
// temp ESM file, dynamically imported and exercised against a minimal
// hand-rolled DOM stub. app.ts is the one entry point bundled here (section
// 6, the tab bar) — needed because buildTabBar() is not exported and has no
// existing execution-based test to extend (signup-gate.test.mjs's app.ts
// checks are all source-string regexes, never execution); see section 6's
// own comment for exactly what DOM/window surface a bare, no-click
// mountApp() call touches and why the stub below is sufficient for it.
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
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
// Minimal DOM stub used by the bundle() harness below.
// createElement, .className, .classList.add(), .textContent, .innerHTML,
// .setAttribute, .append/.appendChild, .id, and host.replaceChildren() —
// originally sized to cover both app.ts AND ui/machinecard.ts's DOM usage
// (the latter's sections are gone, see this file's header, but the stub
// itself is unchanged: it's generic and app.ts still needs all of it).
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
  /** Depth-first find/findAll by class — same technique signup-gate.test.mjs
   *  and account-cta.test.mjs use, so a harmless future reorder of sibling
   *  elements doesn't break these tests on layout position alone. */
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
// TIME (its own header comment explains why) — so `window` must exist with a
// working addEventListener before the app.ts bundle is even imported, not
// just before mountApp() runs.
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

// ===========================================================================
section('6. app.ts: the tab bar is Goals/Shots/Study/Achievements (wave 2, 2026-08-11) — Study is un-gated, Map is label-only renamed to Shots, Card is retired as a mobile tab')
// ===========================================================================
const { mod: appMod, tmp: appTmp } = await bundle(appPath, 'app')
const { mountApp } = appMod
const appSrc = readFileSync(appPath, 'utf8')

test("source: TabId keeps 'map' (label-only rename to Shots) and gains 'study'; 'card' is gone from the union", () => {
  assert(
    /type TabId = 'goals' \| 'map' \| 'study' \| 'achievements'/.test(appSrc),
    "expected the TabId union to read exactly 'goals' | 'map' | 'study' | 'achievements'",
  )
})

test("source: the tabs[] array renames Map's label to 'Shots' while keeping id 'map' (label-only rename, not a TabId rename)", () => {
  assert(
    /\{ id: 'map', label: 'Shots', icon: /.test(appSrc),
    "expected a tabs[] entry reading exactly \"{ id: 'map', label: 'Shots', icon: \" — TabId 'map' unchanged, display label 'Shots'",
  )
})

test("source: the study mount block is NOT gated by getSession() (unlike achievements)", () => {
  const start = appSrc.indexOf("if (tab === 'study'")
  assert(start !== -1, "could not find \"if (tab === 'study'\" in app.ts")
  const nextBlock = appSrc.indexOf("if (tab === 'map'", start)
  assert(nextBlock > start, 'could not find the following map-tab block to bound the study block')
  const studyBlock = appSrc.slice(start, nextBlock)
  assert(!studyBlock.includes('getSession'), 'the study tab must not be account-gated — it is content, like Goals/Map')
  assert(studyBlock.includes("import('./ui/study')"), 'expected a dynamic import of ./ui/study')
})

test("source: no mobile Card-tab wiring remains (checked as actual code patterns, not bare substrings — app.ts's own header comment legitimately still MENTIONS cardPanel/cardMounted/'card' in prose explaining the removal, quoted in backticks)", () => {
  assert(!appSrc.includes('let cardMounted'), 'expected the cardMounted flag declaration to be gone')
  assert(!appSrc.includes("cardPanel.hidden = tab !== 'card'"), 'expected the cardPanel visibility line to be gone')
  assert(!appSrc.includes('mountMachineCard(cardPanel'), 'expected the mountMachineCard(cardPanel, ...) call to be gone')
  assert(
    !appSrc.includes("import('./ui/machinecard')"),
    'expected no remaining dynamic import of ./ui/machinecard from app.ts — that module is fully unimported now (UNIMPORT pattern, 2026-08-11 card removal, app.ts header)',
  )
})

test("source: lastOpenTab's existing 'not achievements' rule needs no new branch for 'study'", () => {
  assert(
    /if \(tab !== 'achievements'\) lastOpenTab = tab/.test(appSrc),
    "expected the unchanged `if (tab !== 'achievements') lastOpenTab = tab` line — this alone already treats " +
      "'study' as a normal, landable tab; a signed-out visitor bounced off the gate can return to it",
  )
})

let appRoot
// Hoisted so the tablist tests below can re-mount a FRESH bar and assert its
// INIT state, rather than inspecting one the arrow-key tests already drove.
let appState
test('mountApp() runs to completion against a stub AppState with no thrown error', () => {
  const machine = { id: 'test-machine', name: 'Test Machine', shortTitle: 'Test', resource: 'test_goals' }
  const data = { machine: 'Test Machine', shots: [], goals: [], sources: [] }
  const state = {
    machines: [machine],
    machine,
    data,
    shotsByID: new Map(),
    selectedGoal: null,
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
  appState = state
  appRoot = new FakeElement('div')
  mountApp(appRoot, state)
})

test('the tab bar has exactly 4 tabs, in order Goals / Shots / Study / Achievements', () => {
  const tabBar = appRoot.find('tab-bar')
  assert(tabBar, 'expected a .tab-bar element')
  const buttons = tabBar.findAll('tab-btn')
  assert(buttons.length === 4, `expected 4 tab buttons, got ${buttons.length}`)
  const labels = buttons.map((b) => b.children[1]?.textContent)
  assert(
    labels.join(',') === 'Goals,Shots,Study,Achievements',
    `expected order Goals,Shots,Study,Achievements — got ${labels.join(',')}`,
  )
  return labels.join(' -> ')
})

test("Shots' icon is the plain text glyph '◎' (aria-hidden, not the old 🗺️ emoji)", () => {
  const tabBar = appRoot.find('tab-bar')
  const buttons = tabBar.findAll('tab-btn')
  const shotsBtn = buttons[1]
  const icon = shotsBtn.children[0]
  assert(icon.textContent === '◎', `expected icon glyph '◎', got ${JSON.stringify(icon.textContent)}`)
  assert(icon.getAttribute('aria-hidden') === 'true', 'expected the icon span to be aria-hidden')
})

test("Study's icon is the plain text glyph '▤' (aria-hidden — reused from the retired Card tab)", () => {
  const tabBar = appRoot.find('tab-bar')
  const buttons = tabBar.findAll('tab-btn')
  const studyBtn = buttons[2]
  const icon = studyBtn.children[0]
  assert(icon.textContent === '▤', `expected icon glyph '▤', got ${JSON.stringify(icon.textContent)}`)
  assert(icon.getAttribute('aria-hidden') === 'true', 'expected the icon span to be aria-hidden')
})

test('only Goals starts aria-selected=true (Shots/Study/Achievements start false)', () => {
  const tabBar = appRoot.find('tab-bar')
  const buttons = tabBar.findAll('tab-btn')
  const selected = buttons.map((b) => b.getAttribute('aria-selected'))
  assert(selected.join(',') === 'true,false,false,false', `expected [true,false,false,false], got ${selected.join(',')}`)
})

// ===========================================================================
section('7. app.ts: the tab bar is a real ARIA tablist (P4, 2026-08-14) — linked to its panels, one tab stop, arrow-key navigable')
// ===========================================================================
// role="tablist"/role="tab"/role="tabpanel" have been on these elements since
// they were built, and on their own they are a promise the DOM did not keep:
// nothing said WHICH panel a tab controls, the panels had no accessible name,
// and all four buttons sat in the tab order so a keyboard user pressed Tab
// four times to get past the bar. The three tests below pin the linkage in
// BOTH directions and the roving-tabindex/arrow-key contract that replaces
// those four tab stops with one.
//
// EXPECTED NOISE: driving the arrows really does activate the Shots/Study/
// Achievements tabs, which lazily import and mount those modules — and
// overlay/map2d.ts cannot mount against this file's deliberately minimal DOM
// stub (no style objects, no canvas context). ui/chunkError.ts's loadChunk
// catches that and logs "failed to load chunk for the map", which is why the
// line appears below a run of PASSes. It is the chunk-failure path doing its
// job, not a failure of these tests; the suite still exits 0.

const TABS = [
  { id: 'goals', panel: 'goals-view' },
  { id: 'map', panel: 'map-host' },
  { id: 'study', panel: 'study-host' },
  { id: 'achievements', panel: 'achievements-host' },
]

/** Fires a keydown at a tab button the way a browser would, and reports
 *  whether the handler called preventDefault. */
function pressKey(btn, key) {
  let prevented = false
  btn.fire('keydown', { key, preventDefault: () => (prevented = true) })
  return prevented
}

function clearFocusFlags(buttons) {
  for (const b of buttons) b._focused = false
}

test('every tab is linked to its panel, and every panel back to its tab (aria-controls / aria-labelledby, both resolving to real ids)', () => {
  const tabBar = appRoot.find('tab-bar')
  const buttons = tabBar.findAll('tab-btn')
  const panels = appRoot.findAll('tab-panel')
  assert(panels.length === TABS.length, `expected ${TABS.length} .tab-panel sections, got ${panels.length}`)
  const panelById = new Map(panels.map((p) => [p.id, p]))
  const evidence = []
  TABS.forEach((t, i) => {
    const btn = buttons[i]
    assert(btn.id === `tab-${t.id}`, `tab ${i} id is ${JSON.stringify(btn.id)}, expected "tab-${t.id}"`)
    const controls = btn.getAttribute('aria-controls')
    assert(controls === t.panel, `tab ${t.id} aria-controls is ${JSON.stringify(controls)}, expected "${t.panel}"`)
    const panel = panelById.get(controls)
    assert(panel, `tab ${t.id} points at "${controls}", which is not any panel's id — the linkage is broken`)
    assert(
      panel.getAttribute('aria-labelledby') === btn.id,
      `panel ${controls} is labelled by ${JSON.stringify(panel.getAttribute('aria-labelledby'))}, expected "${btn.id}"`,
    )
    evidence.push(`${btn.id} <-> ${controls}`)
  })
  return evidence.join(', ')
})

test('roving tabindex: the SELECTED tab is the bar’s only tab stop (0), the rest are -1', () => {
  const buttons = appRoot.find('tab-bar').findAll('tab-btn')
  const indices = buttons.map((b) => b.tabIndex)
  assert(indices.join(',') === '0,-1,-1,-1', `expected [0,-1,-1,-1] with Goals selected, got [${indices.join(',')}]`)
})

test('ArrowRight moves focus AND selection to the next tab, and the tab stop moves with it', () => {
  const buttons = appRoot.find('tab-bar').findAll('tab-btn')
  clearFocusFlags(buttons)
  const prevented = pressKey(buttons[0], 'ArrowRight')
  assert(prevented, 'expected preventDefault so the browser does not also scroll/caret-move')
  assert(buttons[1]._focused, 'expected focus to move to the Shots tab')
  assert(buttons.map((b) => b.getAttribute('aria-selected')).join(',') === 'false,true,false,false', 'expected Shots to become the selected tab')
  assert(buttons.map((b) => b.tabIndex).join(',') === '-1,0,-1,-1', 'expected the single tab stop to follow the selection')
})

test('Home / End jump to the ends, and ArrowLeft WRAPS from the first tab to the last', () => {
  const buttons = appRoot.find('tab-bar').findAll('tab-btn')
  clearFocusFlags(buttons)
  pressKey(buttons[1], 'End')
  assert(buttons[3]._focused, 'End should land on the last tab')
  assert(buttons[3].tabIndex === 0, 'End should move the tab stop too')

  clearFocusFlags(buttons)
  pressKey(buttons[3], 'Home')
  assert(buttons[0]._focused, 'Home should land on the first tab')

  clearFocusFlags(buttons)
  pressKey(buttons[0], 'ArrowLeft')
  assert(buttons[3]._focused, 'ArrowLeft from the FIRST tab should wrap to the last — this bar is a ring of four peers')
  assert(buttons.map((b) => b.getAttribute('aria-selected')).join(',') === 'false,false,false,true', 'the wrap must select, not just focus')
})

/** The {aria-selected, tabindex, focused} triple for the whole bar, as one
 *  comparable string — the three must never disagree, and asserting them
 *  together is the only way to catch the state where two of them drift. */
function tabState(buttons) {
  return buttons
    .map((b, i) => `${i}:${b.getAttribute('aria-selected') === 'true' ? 'sel' : '---'}/${b.tabIndex}${b._focused ? '/focus' : ''}`)
    .join(' ')
}

test('THE INIT PATH: the triple is already correct at first render, before any keyboard interaction', () => {
  // A tablist that only fixes its roving tabindex once you press something is
  // broken for the person who arrives by Tab — the first Tab would land on
  // whichever button the browser found first, not the selected one.
  const buttons = appRoot.find('tab-bar').findAll('tab-btn')
  // Re-mount cleanly so this is genuinely the INIT state, not the residue of
  // the arrow-key tests above.
  const freshRoot = new FakeElement('div')
  mountApp(freshRoot, appState)
  const fresh = freshRoot.find('tab-bar').findAll('tab-btn')
  assert(tabState(fresh) === '0:sel/0 1:---/-1 2:---/-1 3:---/-1', `init triple is "${tabState(fresh)}"`)
  assert(buttons.length === fresh.length, 'sanity: same bar shape')
  return tabState(fresh)
})

test('PROGRAMMATIC SELECT funnels through the same activate() the pointer and the arrows use', () => {
  // app.ts hands its own showGoalOnMap() a `select()`; if that were a second
  // code path it could set aria-selected without moving the tab stop. It is
  // literally the same function — pinned at the source, because the export is
  // not reachable from here.
  assert(/return \{ el: nav, select: activate \}/.test(appSrc), 'buildTabBar no longer exposes activate() itself as select()')
  // Behaviourally: End lands on the LAST tab through that same activate().
  const freshRoot = new FakeElement('div')
  mountApp(freshRoot, appState)
  const fresh = freshRoot.find('tab-bar').findAll('tab-btn')
  pressKey(fresh[0], 'End')
  assert(tabState(fresh) === '0:---/-1 1:---/-1 2:---/-1 3:sel/0/focus', `after landing on the last tab the triple is "${tabState(fresh)}"`)
  return tabState(fresh)
})

test('after ArrowRight the triple moves as ONE (selection, tab stop and focus never disagree)', () => {
  const freshRoot = new FakeElement('div')
  mountApp(freshRoot, appState)
  const fresh = freshRoot.find('tab-bar').findAll('tab-btn')
  pressKey(fresh[0], 'ArrowRight')
  assert(tabState(fresh) === '0:---/-1 1:sel/0/focus 2:---/-1 3:---/-1', `after ArrowRight the triple is "${tabState(fresh)}"`)
  return tabState(fresh)
})

test('an unrelated key is left entirely alone (no preventDefault, no selection change)', () => {
  const buttons = appRoot.find('tab-bar').findAll('tab-btn')
  const before = buttons.map((b) => b.getAttribute('aria-selected')).join(',')
  const prevented = pressKey(buttons[0], 'a')
  assert(!prevented, 'a plain letter key must not be intercepted')
  assert(buttons.map((b) => b.getAttribute('aria-selected')).join(',') === before, 'selection must not change')
})

await rm(appTmp, { recursive: true, force: true })

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
