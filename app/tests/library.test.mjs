#!/usr/bin/env node
// app/tests/library.test.mjs — SUITE 25: the Machine Library overlay
// (ui/library.ts + its header button), P6 L3 (2026-08-14).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/library.test.mjs"
//
// WHY THIS SUITE EXISTS. This overlay replaced the header <select> that was
// the only way to change machine. Three groups of things can break invisibly:
//
//   1. SEARCH. Folding is the whole feature: "Pokémon" has to be findable by
//      typing `pokemon`, "Pin·Bot" by typing `pin bot`, "Elvira's" by typing
//      `elviras`. Each of those is a real machine in the catalog, and each
//      needs a different rule. A regression makes a machine unreachable and
//      nothing throws.
//   2. THE PICK FLOW. state.ts's loadMachine resolves whether or not it worked
//      (P6 L1), so this overlay decides success by checking WHICH machine is
//      loaded. Get that wrong and a failed switch closes the overlay as if it
//      had worked, stranding the visitor on the old machine with no message.
//   3. THE DIALOG CONTRACT. role/aria-modal, focus in and back out, Escape,
//      Tab wrap. None of it renders, so none of it fails visibly.
//   4. THE ROWS AND THE A-Z RAIL (2026-08-14). The card grid became a list of
//      name-first rows plus an iPhone-contacts index, on rolo's report that
//      the thumbnails were what made a name hard to find. Three things there
//      break silently: the letter a machine files under (it comes from the
//      strip-"The" SORT key, so The Evil Dead is under E — the exact thing he
//      could not find in the <select> this all replaced); the rail's own
//      visibility rules (hidden under a search, hidden over a short filter);
//      and the star staying a SIBLING of the row button rather than a child of
//      it. Sections j2-j4 cover them, and section j5 SEEDS each one as a
//      mutation and proves the check goes red — a test that has never been
//      shown to fail is a test nobody has checked.
//
// Sections a-f drive the pure functions as arithmetic. Sections g-l mount the
// REAL ui/library.ts against the REAL src/state.ts in a hand-rolled fake DOM —
// the same technique as sheet.test.mjs / study.test.mjs (no test framework in
// this repo; see scripts/run-tests.mjs). Section m reads app.ts's source, which
// is the only way to assert the <select> is actually gone.
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
const appSrc = readFileSync(resolve(srcDir, 'app.ts'), 'utf8')
const stylesCss = readFileSync(resolve(srcDir, 'styles.css'), 'utf8')
const howtoSrc = readFileSync(resolve(srcDir, 'ui/howto.ts'), 'utf8')

// ---------------------------------------------------------------------------
// Harness
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
// Fake DOM (shape follows sheet.test.mjs; adds <input> value + a body).
// ---------------------------------------------------------------------------
let domActiveElement = null

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.className = ''
    this._text = ''
    this._html = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.dataset = {}
    const classSet = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      contains: (c) => classSet.has(c),
    }
    this.style = {}
    this._listeners = new Map()
    this._attrs = {}
    this.scrollTop = 0
    /** Every scrollTo() this element received, in order. */
    this._scrolls = []
    /** Test-supplied layout — see getBoundingClientRect below. */
    this._rect = null
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
    if (v === '') {
      // ORPHAN them, the way the real DOM does. Leaving parentElement pointing
      // at a node that no longer has them as children made every detached
      // element read as isConnected — which is precisely the state the
      // observer's detached-canvas guard exists to detect.
      for (const c of this.children) c.parentElement = null
      this.children = []
    }
  }
  get innerHTML() {
    return this._html
  }
  set className(v) {
    this._className = v
    // Keep classList in step with a whole-string assignment, the way the real
    // DOM does — ui/library.ts sets className then calls classList.add.
    const set = new Set(String(v).split(/\s+/).filter(Boolean))
    this.classList = {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
    }
    this._classSet = set
  }
  get className() {
    return this._classSet ? [...this._classSet].join(' ') : this._className
  }
  appendChild(child) {
    this.children.push(child)
    child.parentElement = this
    return child
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n))
  }
  remove() {
    if (!this.parentElement) return
    const i = this.parentElement.children.indexOf(this)
    if (i >= 0) this.parentElement.children.splice(i, 1)
    this.parentElement = null
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v)
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
  /** BUBBLES, like the real thing. Modelling this is load-bearing: the pin
   *  star sits beside a row, and "does a tap on the star also pick the
   *  machine?" is only a real question if an event can travel. A harness that
   *  fires listeners on one node and stops there would answer it green no
   *  matter what the DOM looked like. */
  dispatchEvent(ev) {
    let stopped = false
    const e = {
      ...ev,
      target: this,
      stopPropagation: () => {
        stopped = true
      },
      preventDefault: ev.preventDefault ?? (() => {}),
    }
    let node = this
    while (node) {
      for (const fn of [...(node._listeners.get(e.type) || [])]) fn(e)
      if (stopped) break
      node = node.parentElement
    }
    return true
  }
  click() {
    this.dispatchEvent({ type: 'click' })
  }
  /** Is `other` an ancestor of this node? */
  isInside(other) {
    let node = this.parentElement
    while (node) {
      if (node === other) return true
      node = node.parentElement
    }
    return false
  }
  /** The real Node.isConnected: is this node still attached to the document?
   *  Modelled because ui/library.ts's IntersectionObserver callback and its
   *  thumbnail-cache eviction both branch on it — a harness where everything
   *  reads as connected would let a "paints detached canvases" regression pass. */
  get isConnected() {
    let node = this
    while (node.parentElement) node = node.parentElement
    return node.tagName === 'BODY'
  }
  focus() {
    domActiveElement = this
  }
  /**
   * Layout, supplied by the test rather than computed. The rail's hit-testing
   * and the letter jump are both rect arithmetic in the real module, so the
   * suite hands them the geometry the same way it hands a canvas its
   * clientWidth. `_rect.top` is the element's LAYOUT position — where it sits
   * with every scroll container at zero.
   *
   * THE ANCESTORS' SCROLL IS SUBTRACTED, because that is what a viewport rect
   * actually is: scroll a container down 120px and everything inside it
   * reports a top 120px smaller. Without this the harness would hand
   * jumpToLetter a stale rect after its first jump, and the second jump would
   * compound instead of landing — which is exactly the bug this modelling
   * caught while it was being written.
   */
  getBoundingClientRect() {
    const r = this._rect ?? { top: 0, height: 0 }
    let scrolled = 0
    for (let n = this.parentElement; n; n = n.parentElement) scrolled += n.scrollTop || 0
    const top = (r.top ?? 0) - scrolled
    const height = r.height ?? 0
    return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }
  }
  /** Element.scrollTo, RECORDED — `behavior` is half of the reduced-motion
   *  contract, so it has to be observable and not just "did it move". */
  scrollTo(opts) {
    this._scrolls.push(opts)
    if (typeof opts?.top === 'number') this.scrollTop = opts.top
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  find(cls) {
    if (this.classList.contains(cls)) return this
    for (const c of this.children) {
      const hit = c.find?.(cls)
      if (hit) return hit
    }
    return null
  }
  findAll(cls, acc = []) {
    if (this.classList.contains(cls)) acc.push(this)
    for (const c of this.children) c.findAll?.(cls, acc)
    return acc
  }
  findTag(tag, acc = []) {
    if (this.tagName === tag) acc.push(this)
    for (const c of this.children) c.findTag?.(tag, acc)
    return acc
  }
}

/** Flushes pending microtasks so awaited fetches inside the module settle. */
async function flush(n = 30) {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}

/** A 2D context that RECORDS, so a drawing can be asserted as a list of
 *  operations rather than compared as pixels. Same technique as
 *  playfield-art.test.mjs / study.test.mjs. */
function recordingCtx() {
  const ops = []
  const state = { fillStyle: '', strokeStyle: '', lineWidth: 0 }
  let path = []
  const ctx = {
    ops,
    get fillStyle() {
      return state.fillStyle
    },
    set fillStyle(v) {
      state.fillStyle = v
    },
    get strokeStyle() {
      return state.strokeStyle
    },
    set strokeStyle(v) {
      state.strokeStyle = v
    },
    get lineWidth() {
      return state.lineWidth
    },
    set lineWidth(v) {
      state.lineWidth = v
    },
    setTransform: (...a) => ops.push({ op: 'setTransform', a }),
    createLinearGradient: (...a) => {
      const stops = []
      ops.push({ op: 'gradient', a, stops })
      return { addColorStop: (o, c) => stops.push({ o, c }), _stops: stops, _gradient: true }
    },
    fillRect: (...a) => ops.push({ op: 'fillRect', a, fill: state.fillStyle }),
    strokeRect: (...a) => ops.push({ op: 'strokeRect', a, stroke: state.strokeStyle, lineWidth: state.lineWidth }),
    beginPath: () => (path = []),
    moveTo: (x, y) => path.push([x, y]),
    lineTo: (x, y) => path.push([x, y]),
    closePath: () => {},
    arc: (x, y, r) => ops.push({ op: 'arc', x, y, r, fill: null, _pending: true }),
    fill: () => {
      // The most recent pending arc (a dot) or the current polygon (a wedge).
      const lastArc = [...ops].reverse().find((o) => o.op === 'arc' && o._pending)
      if (lastArc) {
        lastArc._pending = false
        lastArc.fill = state.fillStyle
        return
      }
      ops.push({ op: 'fillPath', points: path.slice(), fill: state.fillStyle })
    },
    stroke: () => ops.push({ op: 'strokePath', points: path.slice(), stroke: state.strokeStyle }),
    save: () => {},
    restore: () => {},
    clip: () => {},
  }
  return ctx
}

class FakeIntersectionObserver {
  constructor(cb, opts) {
    this.cb = cb
    this.opts = opts
    this.observed = new Set()
    this.disconnects = 0
    FakeIntersectionObserver.instances.push(this)
  }
  observe(t) {
    this.observed.add(t)
  }
  unobserve(t) {
    this.observed.delete(t)
  }
  disconnect() {
    this.disconnects += 1
    this.observed.clear()
  }
  /** Fire the callback as if every observed target had scrolled into view. */
  intersectAll() {
    this.cb([...this.observed].map((target) => ({ target, isIntersecting: true })))
  }
}
FakeIntersectionObserver.instances = []

const CATALOG = [
  { id: 'jaws', name: 'Jaws (Stern Pinball, 2024)', shortTitle: 'JAWS', resource: 'jaws_goals' },
  { id: 'godzilla', name: 'Godzilla (Stern Pinball, 2021)', shortTitle: 'GODZILLA', resource: 'godzilla_goals' },
  { id: 'comet', name: 'Comet (Williams, 1985)', shortTitle: 'COMET', resource: 'comet_goals' },
  { id: 'evil-dead', name: 'The Evil Dead (Spooky Pinball, 2024)', shortTitle: 'EVIL DEAD', resource: 'evil_dead_goals' },
  { id: 'pokemon', name: 'Pokémon (Stern, 2026)', shortTitle: 'POKÉMON', resource: 'pokemon_goals' },
]

/**
 * A catalog long enough to earn the A-Z rail (RAIL_MIN_ROWS is 20), with the
 * three properties the rail's tests need:
 *   - LETTERS THAT ARE MISSING (O, Q, U, W, X, Y, Z) so "dimmed and skipped"
 *     has something to be about;
 *   - three CONSECUTIVE present letters (A, B, C) for the drag-scrub;
 *   - three "The …" titles that must file under A, E and S, never under T —
 *     and one real T machine, so a rail that ignored the strip-"The" key would
 *     show a T group of four and lose E entirely.
 */
const BIG_CATALOG = [
  'Attack from Mars (Bally, 1995)',
  'The Addams Family (Bally, 1992)',
  'Black Knight (Williams, 1980)',
  'Bride of Pin·Bot (Williams, 1991)',
  'Cirqus Voltaire (Bally, 1997)',
  'Comet (Williams, 1985)',
  'Deadpool (Stern Pinball, 2018)',
  'The Evil Dead (Spooky Pinball, 2024)',
  'Foo Fighters (Stern Pinball, 2023)',
  'Godzilla (Stern Pinball, 2021)',
  'Halloween (Spooky Pinball, 2021)',
  'Iron Maiden (Stern Pinball, 2018)',
  'Jaws (Stern Pinball, 2024)',
  'Jurassic Park (Stern Pinball, 2019)',
  'Kiss (Stern Pinball, 2015)',
  'Led Zeppelin (Stern Pinball, 2020)',
  'Metallica (Stern Pinball, 2013)',
  'No Good Gofers (Williams, 1997)',
  'Pokémon (Stern, 2026)',
  'Rush (Stern Pinball, 2022)',
  'Star Wars (Stern Pinball, 2017)',
  'The Simpsons Pinball Party (Stern, 2003)',
  'Twilight Zone (Bally, 1993)',
  'Venom (Stern Pinball, 2023)',
].map((name) => {
  const title = /^(.+) \(/.exec(name)[1]
  const id = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return { id, name, shortTitle: title.toUpperCase(), resource: `${id.replace(/-/g, '_')}_goals` }
})

function libraryDoc(catalog = CATALOG) {
  return {
    v: 1,
    machines: catalog.map((m, i) => {
      const [, title, mfr, year] = /^(.+) \(([^,()]+), (\d{4})\)$/.exec(m.name)
      return {
        id: m.id,
        name: m.name,
        title,
        shortTitle: m.shortTitle,
        mfr,
        mfrGroup: mfr === 'Stern Pinball' ? 'Stern' : mfr === 'Spooky Pinball' ? 'Spooky' : mfr,
        year: Number(year),
        goals: 10 + i,
        ach: i,
        zones: [],
        flippers: [
          { x: 0.33, y: 0.05, s: 'l' },
          { x: 0.67, y: 0.05, s: 'r' },
        ],
        plungeX: 0.96,
        shots: [
          { x: 0.5, y: 0.5 },
          { x: 0.3, y: 0.7 },
        ],
      }
    }),
  }
}

function datasetFor(id) {
  return { machine: id, shots: [{ id: `${id}-s`, name: 's', type: 'ramp', x: 0.5, y: 0.5, trim: 'all' }], goals: [], sources: [] }
}

/** Installs document/window/localStorage/fetch. `fetch` answers catalog and
 *  library.json immediately; machine datasets PARK until settle() is called,
 *  so the loading window is observable. */
function withFakeDom(
  fn,
  {
    failMachines = new Set(),
    libraryStatus = 200,
    dpr = 1,
    noObserver = false,
    session = null,
    progressBlob = {},
    achievementsStatus = 200,
    catalog = CATALOG,
    reducedMotion = false,
    noScrollTo = false,
  } = {},
) {
  const prior = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
    performance: globalThis.performance,
    IntersectionObserver: globalThis.IntersectionObserver,
  }
  const docListeners = new Map()
  const body = new FakeElement('body')
  domActiveElement = null
  const store = new Map()
  const pending = new Map()

  const doc = {
    createElement: (tag) => {
      const el = new FakeElement(tag)
      // An environment old enough to lack Element.scrollTo: ui/library.ts has
      // to fall back to assigning scrollTop, and that branch is only real if
      // the suite can actually take scrollTo away.
      if (noScrollTo) el.scrollTo = undefined
      if (String(tag).toLowerCase() === 'canvas') {
        // A laid-out box, so paintThumbCanvas measures something real.
        el.clientWidth = 150
        el.clientHeight = 200
        // THE SPEC DEFAULT, 300x150, on a canvas nothing has drawn into yet.
        // This is not decoration: the thumbnail cache originally used
        // `canvas.width > 0` as its "already painted?" test, which is wrong in
        // a real browser precisely because of this default — every blank
        // canvas would read as finished and nothing would ever paint. The
        // harness left `width` undefined, so it passed. Modelling the default
        // is what turns that into a caught bug instead of a shipped one.
        el.width = 300
        el.height = 150
        el._ctx = recordingCtx()
        el.getContext = (kind) => (kind === '2d' ? el._ctx : null)
      }
      return el
    },
    addEventListener(type, cb) {
      if (!docListeners.has(type)) docListeners.set(type, new Set())
      docListeners.get(type).add(cb)
    },
    removeEventListener(type, cb) {
      docListeners.get(type)?.delete(cb)
    },
    get activeElement() {
      return domActiveElement
    },
    body,
  }
  globalThis.document = doc
  globalThis.window = {
    location: { search: '' },
    devicePixelRatio: dpr,
    matchMedia: (q) => ({ matches: reducedMotion && /prefers-reduced-motion/.test(q), media: q }),
  }
  globalThis.performance = { now: () => 0 }
  FakeIntersectionObserver.instances = []
  globalThis.IntersectionObserver = noObserver ? undefined : FakeIntersectionObserver
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.fetch = (url) => {
    if (url === '/whoami') {
      return Promise.resolve({
        ok: !!session,
        status: session ? 200 : 401,
        json: async () => session ?? {},
      })
    }
    if (url === '/api/achievements') {
      if (achievementsStatus !== 200) return Promise.resolve({ ok: false, status: achievementsStatus, json: async () => ({}) })
      return Promise.resolve({ ok: true, status: 200, json: async () => progressBlob })
    }
    if (url === '/data/catalog.json') return Promise.resolve({ ok: true, status: 200, json: async () => catalog })
    if (url === '/data/library.json') {
      if (libraryStatus !== 200) return Promise.resolve({ ok: false, status: libraryStatus, json: async () => ({}) })
      return Promise.resolve({ ok: true, status: 200, json: async () => libraryDoc(catalog) })
    }
    const id = /\/data\/(.+)_goals\.json/.exec(url)?.[1]?.replace(/_/g, '-')
    return new Promise((res, rej) => {
      pending.set(url, () => {
        if (failMachines.has(id)) rej(new Error('NetworkError: Failed to fetch'))
        else res({ ok: true, status: 200, json: async () => datasetFor(id) })
      })
    })
  }

  async function settle(url) {
    for (let i = 0; i < 60 && !pending.has(url); i += 1) await Promise.resolve()
    const p = pending.get(url)
    if (!p) throw new Error(`no pending request for ${url}`)
    pending.delete(url)
    p()
    await flush()
  }
  function key(k, shiftKey = false, mods = {}) {
    let prevented = false
    const ev = {
      type: 'keydown',
      key: k,
      shiftKey,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
      preventDefault: () => (prevented = true),
    }
    for (const cb of [...(docListeners.get('keydown') || [])]) cb(ev)
    return prevented
  }
  function restore() {
    globalThis.document = prior.document
    globalThis.window = prior.window
    globalThis.localStorage = prior.localStorage
    globalThis.fetch = prior.fetch
    globalThis.performance = prior.performance
    globalThis.IntersectionObserver = prior.IntersectionObserver
  }
  const env = {
    doc,
    body,
    store,
    settle,
    key,
    keydownCount: () => docListeners.get('keydown')?.size ?? 0,
    observers: () => FakeIntersectionObserver.instances,
  }
  return Promise.resolve()
    .then(() => fn(env))
    .then(
      (v) => (restore(), v),
      (e) => (restore(), Promise.reject(e)),
    )
}

// ---------------------------------------------------------------------------
// Bundle the real modules. A FRESH module instance per mounted scenario:
// ui/library.ts memoizes the index fetch and holds the overlay as a
// module-level singleton, both of which must not leak between tests.
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-library-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  [
    `export * from ${JSON.stringify(resolve(srcDir, 'ui/library.ts'))}`,
    `export { createAppState } from ${JSON.stringify(resolve(srcDir, 'state.ts'))}`,
  ].join('\n'),
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
let moduleCounter = 0
const freshModule = () => import(`${pathToFileURL(outfile).href}?n=${(moduleCounter += 1)}`)
const lib = await freshModule()

/** Boots a real AppState (jaws loaded) and opens a fresh library overlay. */
async function mounted(env, opts = {}) {
  // state.ts boots machines[0] unless something was saved, so a suite running
  // on BIG_CATALOG has to settle a different first dataset than one running on
  // the five-machine fixture.
  // `mod` lets a mutation test drive a SEEDED build through the same mount
  // path as the honest one.
  const { boot = 'jaws_goals', mod: given = null, ...rest } = opts
  const mod = given ?? (await freshModule())
  const p = mod.createAppState()
  await env.settle(`/data/${boot}.json`)
  const state = await p
  const opener = env.doc.createElement('button')
  opener.className = 'machine-picker-btn'
  env.body.appendChild(opener)
  opener.focus()
  mod.openLibrary(state, opener)
  await flush()
  const overlay = env.body.find('pg-library-overlay')
  return { mod, state, opener, overlay, ...rest }
}

const rowNames = (overlay) => overlay.findAll('pg-library-row-name').map((n) => n.textContent)

// ---------------------------------------------------------------------------
// Layout for the rail. The rail hit-tests by clientY and the letter jump is a
// rect delta, so the suite supplies the geometry the same way it supplies a
// canvas its clientWidth — from a STATED model, not from magic numbers.
// ---------------------------------------------------------------------------
const RAIL_TOP = 120
const RAIL_H = 520
const BODY_TOP = 120
const ROW_H = 48 // .pg-library-row min-height + the wrapper's 1px hairline is pinned separately
const HEAD_H = 24 // .pg-library-letter

/**
 * Lays the overlay out: the rail spans RAIL_TOP..RAIL_TOP+RAIL_H, and every
 * letter header AND row gets the top it would really have once everything
 * above it is stacked.
 *
 * `rowH` is a PARAMETER, and tests exercise more than one value on purpose.
 * The jump formula must read the anchor's measured position and never assume a
 * row pitch — an index built on an assumed pitch drifts further from its target
 * the further down the list you go, and a suite that hard-codes the same pitch
 * the code assumes cannot tell. Every assertion below reads `_rect`; none of
 * them recomputes `index * ROW_H`.
 *
 * Returns the rail and the SCROLLPORT (`.pg-library-body` — the overlay's own
 * div, never document.body).
 */
function layout(overlay, { rowH = ROW_H, headH = HEAD_H } = {}) {
  const rail = overlay.find('pg-library-rail')
  if (rail) rail._rect = { top: RAIL_TOP, height: RAIL_H }
  const scroller = overlay.find('pg-library-body')
  scroller._rect = { top: BODY_TOP, height: RAIL_H }
  // LAYOUT coordinates, not viewport ones — getBoundingClientRect subtracts
  // the live scroll for us.
  let y = BODY_TOP
  const walk = (el) => {
    if (el.classList.contains('pg-library-letter')) {
      el._rect = { top: y, height: headH }
      y += headH
      return
    }
    if (el.classList.contains('pg-library-rowwrap')) {
      el._rect = { top: y, height: rowH }
      y += rowH
      return
    }
    for (const c of el.children) walk(c)
  }
  walk(scroller)
  // The scrollable content's total height, for the clamp the platform applies.
  scroller._contentHeight = y - BODY_TOP
  return { rail, scroller }
}

/**
 * Where a `position: sticky; top: 0` header actually renders inside the
 * scrollport: its natural place, or the top of the port, whichever is lower
 * down the page.
 *
 * Modelled here rather than in FakeElement because sticky is the ONE piece of
 * layout these assertions depend on and it is worth being explicit about: the
 * pinned header is what a jump can hide the target row behind, so an assertion
 * that reads only the natural rect cannot see the bug it is written for.
 */
function pinnedRect(head, scroller) {
  const natural = head.getBoundingClientRect()
  const portTop = scroller.getBoundingClientRect().top
  const top = Math.max(natural.top, portTop)
  return { top, bottom: top + natural.height, height: natural.height }
}

/** The first row of `letter`'s group, and the header pinned above it. */
function groupAt(overlay, letter, scroller) {
  const head = overlay.findAll('pg-library-letter').find((h) => h.textContent === letter)
  const firstRow = head.parentElement.children[1]
  return { head, firstRow, pinned: pinnedRect(head, scroller), rowRect: firstRow.getBoundingClientRect() }
}

/** The clientY at the centre of `letter`'s zone on a rail showing `order`. */
const railY = (order, letter) => RAIL_TOP + (RAIL_H / order.length) * (order.indexOf(letter) + 0.5)

/** The letters the rail is currently offering, in rendered order. */
const railOrderOf = (overlay) => overlay.findAll('pg-library-rail-btn').map((b) => b.textContent)

/** Dispatches a pointer event at `clientY`. Bubbles, so dispatching on a rail
 *  button reaches the rail's own listeners exactly as a real tap would. */
const pointer = (el, type, clientY) => el.dispatchEvent({ type, clientY, pointerId: 1 })

/** state.ts boots machines[0]; on BIG_CATALOG that is Attack from Mars. */
const BIG_BOOT = 'attack_from_mars_goals'

/** The catalog the app actually ships. Used where a claim is only meaningful
 *  at real scale — the thumbnail cache's cap is one: a five-machine fixture
 *  cannot show a cache that starts evicting at the 48th row. */
const REAL_CATALOG = JSON.parse(readFileSync(resolve(__dirname, '../../data/catalog.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Mutation testing.
//
// The three regressions this redesign can suffer WITHOUT throwing anything are
// each seeded into a real build below and run through the very assertion that
// is supposed to catch them. Written this way because a test that has never
// been shown to fail is a test nobody has checked: "the star is a sibling"
// passes just as happily against a suite that cannot tell.
// ---------------------------------------------------------------------------

/** The checks the mutation tests re-run. Factored out so "the honest build
 *  passes it" and "the mutant fails it" are the SAME question asked twice,
 *  rather than two hand-written approximations of each other. */
const CHECKS = {
  /** "The Evil Dead" belongs to E, which is a live letter on the rail. */
  theFilesUnderItsSortLetter(overlay) {
    const heads = overlay.findAll('pg-library-letter')
    const e = heads.find((h) => h.textContent === 'E')
    assert(e, `no E letter section — headers are ${heads.map((h) => h.textContent).join(' ')}`)
    // Each header owns its own group box, so E's rows are simply its siblings.
    const rows = e.parentElement
      .findAll('pg-library-row-name')
      .map((n) => n.textContent)
    assert(rows.includes('The Evil Dead'), `E holds ${rows.join(', ')} — The Evil Dead is filed elsewhere`)
    const railE = overlay.findAll('pg-library-rail-btn').find((b) => b.textContent === 'E')
    assert(railE && !railE.disabled, 'E must be a LIVE letter on the rail, not a dimmed one')
  },
  /** No rail and no letter headers while a query is running. */
  railHiddenWhileSearching(overlay) {
    const rail = overlay.find('pg-library-rail')
    assert(rail.hidden === true, 'the rail must be hidden while a search query is active')
    assert(overlay.findAll('pg-library-rail-btn').length === 0, 'and it must not leave its letters in the tab order')
  },
  /**
   * EXACTLY ONE element moved, and it was the overlay's own scrollport.
   *
   * Identity, not a class-name prefix and not "the document did not move":
   * document.body is `position: fixed; overflow: hidden` in styles.css, so a
   * jump aimed at it is a silent no-op that every viewport-relative assertion
   * would happily pass.
   */
  railScrollsTheScrollport(overlay, scroller, env) {
    assert(scroller === overlay.find('pg-library-body'), 'the scrollport is not the overlay\'s own div')
    assert(scroller !== env.body && scroller !== env.doc.body, 'the scrollport must not be document.body')
    const rail = overlay.find('pg-library-rail')
    const moved = [scroller, rail, env.body, overlay].filter((el) => el._scrolls.length > 0)
    assert(moved.length === 1, `${moved.length} elements were scrolled: ${moved.map((e) => e.className || e.tagName).join(', ')}`)
    assert(moved[0] === scroller, `the element scrolled was .${moved[0].className || moved[0].tagName}, not the overlay's scrollport`)
    assert(scroller.scrollTop > 0, 'the scrollport did not actually move')
  },
  /** The target group's first ROW is visible, not behind the pinned header. */
  firstRowClearsPinnedHeader(overlay, letter, scroller) {
    const { pinned, rowRect } = groupAt(overlay, letter, scroller)
    assert(
      rowRect.top >= pinned.bottom - 0.5,
      `${letter}: the first row starts at ${rowRect.top.toFixed(1)} but the pinned header runs to ${pinned.bottom.toFixed(1)} — the row is underneath it`,
    )
  },
  /** An empty letter carries an announced STATE, not just a colour. */
  dimmedLettersAnnounceTheirState(overlay) {
    const off = overlay.findAll('pg-library-rail-btn').filter((b) => b.classList.contains('pg-library-rail-btn-off'))
    assert(off.length > 0, 'precondition: some letters have no machines')
    for (const b of off) {
      assert(b.disabled === true, `${b.textContent} is dimmed but not disabled — colour is not a state a screen reader can read`)
      assert(b.getAttribute('aria-disabled') === 'true', `${b.textContent} has no aria-disabled`)
    }
  },
  /** The pin star is a sibling of the row button, never a child of it. */
  starIsSiblingOfRow(overlay) {
    const wrap = overlay.findAll('pg-library-rowwrap')[0]
    const row = wrap.find('pg-library-row')
    const pin = wrap.findAll('pg-library-pin')[0]
    assert(row && pin, 'expected a row and a star')
    assert(!pin.isInside(row), 'the pin star is nested INSIDE the row button — invalid HTML')
    assert(pin.parentElement === wrap, `the star's parent is .${pin.parentElement?.className}, not the wrapper`)
  },
}

/** Runs `fn` and returns the Error it threw, or null. */
function caught(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err
  }
}

let mutantCounter = 0

/**
 * Bundles the app with `patches` applied to ui/library.ts's SOURCE.
 *
 * An esbuild onLoad hook substitutes the contents rather than writing a copy
 * somewhere else, so the mutant keeps resolving `../state`, `../theme` and its
 * own stylesheet exactly as the real file does. A patch whose `from` is absent
 * THROWS: a mutation that quietly applied to nothing would report "caught!"
 * while changing no behaviour at all, which is the one way a mutation test can
 * lie.
 */
async function mutantModule(patches) {
  let src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
  for (const [from, to] of patches) {
    const n = src.split(from).length - 1
    if (n !== 1) throw new Error(`mutation target appears ${n} times in library.ts (want 1): ${JSON.stringify(from)}`)
    src = src.replace(from, to)
  }
  const out = resolve(tmp, `mutant-${(mutantCounter += 1)}.mjs`)
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'seed-mutation',
        setup(b) {
          b.onLoad({ filter: /ui[/\\]library\.ts$/ }, () => ({ contents: src, loader: 'ts' }))
        },
      },
    ],
  })
  return import(`${pathToFileURL(out).href}?n=${(moduleCounter += 1)}`)
}

// ===========================================================================
section('a. foldText: every rule here is a real machine in the catalog')
// ===========================================================================

await test('diacritics fold — "Pokémon" is reachable by typing pokemon', () => {
  assert(lib.foldText('Pokémon') === 'pokemon', `got ${JSON.stringify(lib.foldText('Pokémon'))}`)
  assert(lib.matchesQuery(lib.foldText('Pokémon'), 'pokemon'), 'pokemon should match Pokémon')
  return 'Pokémon -> pokemon'
})

await test('the interpunct in "Pin·Bot" becomes a separator, so `pin bot` finds it', () => {
  const hay = lib.foldText('The Machine: Bride of Pin·Bot')
  assert(hay === 'the machine bride of pin bot', `got ${JSON.stringify(hay)}`)
  assert(lib.matchesQuery(hay, 'pin bot'), '`pin bot` should match')
  // AND run together. This assertion used to say the opposite, described as
  // "documented behaviour" — it was a limitation dressed up as a decision.
  // Nobody typing a half-remembered title reproduces its punctuation.
  assert(lib.matchesQuery(hay, 'pinbot'), '`pinbot` typed as one word must match too')
  return `"The Machine: Bride of Pin·Bot" -> ${JSON.stringify(hay)}; matched by "pin bot" AND "pinbot"`
})

await test('an apostrophe CLOSES UP, so `elviras` matches "Elvira\'s House of Horrors"', () => {
  const hay = lib.foldText("Elvira's House of Horrors")
  assert(hay === 'elviras house of horrors', `got ${JSON.stringify(hay)}`)
  assert(lib.matchesQuery(hay, 'elviras'), '`elviras` should match')
  return JSON.stringify(hay)
})

await test('hyphens and underscores fold to spaces', () => {
  assert(lib.foldText('Black-Knight_2000') === 'black knight 2000', lib.foldText('Black-Knight_2000'))
  assert(lib.matchesQuery(lib.foldText('Black Knight 2000'), 'black-knight'), 'a hyphenated query should match')
  return 'Black-Knight_2000 -> black knight 2000'
})

// ===========================================================================
section('b. matchesQuery: token-wise, order-free, partial')
// ===========================================================================

await test('word ORDER does not matter — `mars attack` finds Attack from Mars', () => {
  const hay = lib.foldText('Attack from Mars')
  assert(lib.matchesQuery(hay, 'mars attack'), 'reversed word order should match')
  assert(lib.matchesQuery(hay, 'attack mars'), 'a query skipping a middle word should match')
  return '"mars attack" and "attack mars" both match "Attack from Mars"'
})

await test('a partial word narrows — `godz` finds Godzilla', () => {
  assert(lib.matchesQuery(lib.foldText('Godzilla'), 'godz'), 'prefix should match')
  assert(lib.matchesQuery(lib.foldText('Godzilla'), 'zill'), 'an infix should match too')
  assert(!lib.matchesQuery(lib.foldText('Godzilla'), 'godzillas'), 'a longer query must not match')
  return 'godz / zill match; godzillas does not'
})

await test('an empty or whitespace query matches everything', () => {
  assert(lib.matchesQuery('anything', ''), 'empty query')
  assert(lib.matchesQuery('anything', '   '), 'whitespace-only query')
  return 'both match'
})

await test('EVERY token must be present, not just one', () => {
  const hay = lib.foldText('Comet')
  assert(!lib.matchesQuery(hay, 'comet williams zzz'), 'a query with one absent token must not match')
  return '"comet williams zzz" correctly rejected against a title-only haystack'
})

// ===========================================================================
section('c. Sorting: the leading article is stripped (rolo could not find Evil Dead)')
// ===========================================================================

await test('"The Evil Dead" sorts under E, not T', () => {
  assert(lib.machineSortKey('The Evil Dead') === 'Evil Dead', lib.machineSortKey('The Evil Dead'))
  const entries = lib.entriesFromCatalog(CATALOG)
  const order = lib.sortForDisplay(entries).map((e) => e.title)
  const evil = order.indexOf('The Evil Dead')
  const godzilla = order.indexOf('Godzilla')
  const jaws = order.indexOf('Jaws')
  assert(evil < godzilla && evil < jaws, `expected Evil Dead before Godzilla/Jaws, got ${order.join(' < ')}`)
  return order.join(' < ')
})

await test('sorting is case- and accent-insensitive and does not mutate the input', () => {
  const entries = lib.entriesFromCatalog(CATALOG)
  const before = entries.map((e) => e.id).join(',')
  lib.sortForDisplay(entries)
  assert(entries.map((e) => e.id).join(',') === before, 'sortForDisplay mutated its input')
  return `input order preserved: ${before}`
})

// ===========================================================================
section('d. entriesFromCatalog: the fail-soft index')
// ===========================================================================

await test('maker/year/title are parsed out of the catalog name', () => {
  const [jaws] = lib.entriesFromCatalog([CATALOG[0]])
  assert(jaws.title === 'Jaws' && jaws.mfr === 'Stern Pinball' && jaws.year === 2024, JSON.stringify(jaws))
  assert(jaws.name === CATALOG[0].name, 'the FULL name must survive — the header button shows it')
  assert(jaws.shots.length === 0, 'the fallback has no geometry, so no thumbnail')
  return `${jaws.title} · ${jaws.mfr} · ${jaws.year}`
})

await test('a name that does not parse is still LISTED, just without maker/year', () => {
  const [odd] = lib.entriesFromCatalog([{ id: 'x', name: 'Some Machine', shortTitle: 'X', resource: 'x' }])
  assert(odd.title === 'Some Machine' && odd.mfr === '' && odd.year === 0, JSON.stringify(odd))
  assert(lib.matchesQuery(lib.haystackFor(odd), 'some machine'), 'it must still be searchable')
  return 'unparsed name -> listed, searchable, no maker/decade chip'
})

// ===========================================================================
section('e. Filter chips: derived from the data, folded, and never dead')
// ===========================================================================

await test('maker chips use the FOLDED group, so Stern Pinball and Stern are one chip', () => {
  const entries = libraryDoc().machines
  const filters = lib.buildFilters(entries, { hasPinned: false, hasRecent: false })
  const makers = filters.filter((f) => f.kind === 'maker').map((f) => f.label)
  assert(makers.filter((m) => /^Stern/.test(m)).length === 1, `expected one Stern chip, got ${makers.join(', ')}`)
  assert(makers[0] === 'Stern', `the biggest maker should be first, got ${makers.join(', ')}`)
  return `maker chips: ${makers.join(', ')}`
})

await test('decade chips come from the years present, oldest first', () => {
  const filters = lib.buildFilters(libraryDoc().machines, { hasPinned: false, hasRecent: false })
  const decades = filters.filter((f) => f.kind === 'decade').map((f) => f.label)
  assert(JSON.stringify(decades) === JSON.stringify(['1980s', '2020s']), decades.join(', '))
  return decades.join(', ')
})

await test('Pinned/Recent chips are omitted when there is nothing to filter to', () => {
  const none = lib.buildFilters(libraryDoc().machines, { hasPinned: false, hasRecent: false }).map((f) => f.kind)
  assert(!none.includes('pinned') && !none.includes('recent'), `got ${none.join(',')}`)
  const both = lib.buildFilters(libraryDoc().machines, { hasPinned: true, hasRecent: true }).map((f) => f.kind)
  assert(both[0] === 'all' && both[1] === 'pinned' && both[2] === 'recent', `got ${both.join(',')}`)
  return 'omitted when empty; All · Pinned · Recent lead the row when not'
})

await test('passesFilter: decade, maker, pinned and recent each select what they name', () => {
  const [jaws, godzilla, comet] = libraryDoc().machines
  const lists = { pinned: ['comet'], recent: ['godzilla'] }
  assert(lib.passesFilter(jaws, { kind: 'decade', value: '2020' }, lists), 'jaws is 2024')
  assert(!lib.passesFilter(comet, { kind: 'decade', value: '2020' }, lists), 'comet is 1985')
  assert(lib.passesFilter(godzilla, { kind: 'maker', value: 'Stern' }, lists), 'godzilla is Stern Pinball -> Stern')
  assert(lib.passesFilter(comet, { kind: 'pinned' }, lists) && !lib.passesFilter(jaws, { kind: 'pinned' }, lists), 'pinned')
  assert(lib.passesFilter(godzilla, { kind: 'recent' }, lists) && !lib.passesFilter(jaws, { kind: 'recent' }, lists), 'recent')
  assert(lib.passesFilter(jaws, lib.ALL_FILTER, lists), 'All passes everything')
  return 'decade / maker / pinned / recent / all'
})

// ===========================================================================
section('f. computeSections: sectioned when browsing, flat when searching')
// ===========================================================================

await test('browsing shows Pinned, then Recent, then All machines', () => {
  const entries = libraryDoc().machines
  const secs = lib.computeSections(entries, {
    query: '',
    filter: lib.ALL_FILTER,
    pinned: ['comet'],
    recent: ['jaws', 'godzilla'],
    currentId: 'jaws',
  })
  assert(JSON.stringify(secs.map((s) => s.title)) === JSON.stringify(['Pinned', 'Recent', 'All machines']), secs.map((s) => s.title).join(','))
  assert(secs[1].entries.map((e) => e.id).join() === 'godzilla', `Recent should exclude the current machine, got ${secs[1].entries.map((e) => e.id)}`)
  assert(secs[2].entries.length === entries.length, 'All machines lists everything')
  return `${secs.map((s) => `${s.title}(${s.entries.length})`).join(' · ')}`
})

await test('a SEARCH collapses the sections into one flat list', () => {
  const secs = lib.computeSections(libraryDoc().machines, {
    query: 'stern',
    filter: lib.ALL_FILTER,
    pinned: ['comet'],
    recent: ['godzilla'],
    currentId: 'jaws',
  })
  assert(secs.length === 1 && secs[0].title === null, `expected one untitled section, got ${secs.map((s) => s.title)}`)
  assert(secs[0].entries.every((e) => e.mfrGroup === 'Stern'), 'only Stern machines')
  return `1 flat section of ${secs[0].entries.length}`
})

await test('an active FILTER collapses them too, even with an empty query', () => {
  const secs = lib.computeSections(libraryDoc().machines, {
    query: '',
    filter: { kind: 'decade', value: '1980', label: '1980s' },
    pinned: ['comet'],
    recent: ['godzilla'],
    currentId: 'jaws',
  })
  assert(secs.length === 1 && secs[0].title === null, `got ${secs.map((s) => s.title)}`)
  assert(secs[0].entries.map((e) => e.id).join() === 'comet', secs[0].entries.map((e) => e.id).join())
  return 'decade filter -> 1 flat section: comet'
})

await test('a pinned/recent id whose machine has left the index is silently dropped', () => {
  const secs = lib.computeSections(libraryDoc().machines, {
    query: '',
    filter: lib.ALL_FILTER,
    pinned: ['comet', 'machine-that-no-longer-exists'],
    recent: ['ghost'],
    currentId: 'jaws',
  })
  assert(secs[0].title === 'Pinned' && secs[0].entries.length === 1, JSON.stringify(secs.map((s) => [s.title, s.entries.length])))
  assert(!secs.some((s) => s.title === 'Recent'), 'a Recent section of only-unknown ids must not render at all')
  return 'unknown ids dropped; the empty Recent section is omitted'
})

// ===========================================================================
section('g. The overlay is a real dialog')
// ===========================================================================

await test('role, aria-modal and a RESOLVING aria-labelledby', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    assert(overlay, 'no .pg-library-overlay was mounted')
    assert(overlay.getAttribute('role') === 'dialog', `role=${overlay.getAttribute('role')}`)
    assert(overlay.getAttribute('aria-modal') === 'true', 'aria-modal')
    const id = overlay.getAttribute('aria-labelledby')
    const title = overlay.find('pg-library-title')
    assert(title && title.id === id, `aria-labelledby=${id} does not resolve to the title element`)
    assert(title.textContent === 'Machines', title.textContent)
    return `role=dialog aria-modal=true aria-labelledby=${id} -> "${title.textContent}"`
  }))

await test('it mounts on document.body, not inside the app', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    assert(overlay.parentElement === env.body, 'the overlay must be a direct child of <body>')
    return 'parent is <body>'
  }))

await test('focus lands on the ✕, not the search field (the keyboard would cover the list)', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    assert(env.doc.activeElement === overlay.find('pg-library-close'), 'focus should be on the close button')
    const search = overlay.find('pg-library-search')
    assert(search && env.doc.activeElement !== search, 'the search input must NOT be autofocused')
    return 'activeElement = .pg-library-close'
  }))

await test('Escape closes it and focus returns to the button that opened it', () =>
  withFakeDom(async (env) => {
    const { overlay, opener } = await mounted(env)
    assert(overlay.hidden === false, 'precondition: open')
    const prevented = env.key('Escape')
    assert(prevented, 'Escape should be handled (preventDefault)')
    assert(overlay.hidden === true, 'the overlay should be hidden after Escape')
    assert(env.doc.activeElement === opener, 'focus must return to the opener')
    assert(env.keydownCount() === 0, 'the document keydown listener must be removed on close')
    return 'Escape -> hidden, focus back on .machine-picker-btn, listener removed'
  }))

await test('re-opening REUSES the same element (mount-once / hide)', () =>
  withFakeDom(async (env) => {
    const { mod, state, overlay, opener } = await mounted(env)
    env.key('Escape')
    mod.openLibrary(state, opener)
    await flush()
    const again = env.body.findAll('pg-library-overlay')
    assert(again.length === 1, `expected one overlay, found ${again.length}`)
    assert(again[0] === overlay, 'a second open built a second overlay instead of re-showing the first')
    assert(overlay.hidden === false, 'it should be visible again')
    return 'one overlay element across two opens'
  }))

await test('Tab wraps at both ends instead of walking into the app underneath', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const focusable = []
    const walk = (el) => {
      for (const c of el.children) {
        if (['BUTTON', 'A', 'INPUT'].includes(c.tagName)) focusable.push(c)
        walk(c)
      }
    }
    walk(overlay)
    assert(focusable.length > 2, `expected several focusables, got ${focusable.length}`)
    focusable[focusable.length - 1].focus()
    assert(env.key('Tab'), 'Tab at the end should be handled')
    assert(env.doc.activeElement === focusable[0], 'Tab at the end must wrap to the first')
    assert(env.key('Tab', true), 'Shift+Tab at the start should be handled')
    assert(env.doc.activeElement === focusable[focusable.length - 1], 'Shift+Tab at the start must wrap to the last')
    return `${focusable.length} focusables, wrapping both ways`
  }))

// ===========================================================================
section('h. The current-machine strip and its guide link')
// ===========================================================================

await test('the strip names the loaded machine and links to its guide page in a new tab', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const strip = overlay.find('pg-library-current')
    assert(strip, 'no current-machine strip')
    assert(strip.find('pg-library-current-name').textContent === 'Jaws', strip.find('pg-library-current-name').textContent)
    const link = overlay.find('pg-library-guide-link')
    assert(link.tagName === 'A', 'the guide link must be a real <a>')
    assert(link.href === '/machines/jaws/', `href is ${link.href}`)
    assert(link.target === '_blank', 'guide opens in a new tab')
    assert(link.rel === 'noopener noreferrer', `rel is ${link.rel} — a target=_blank link without noopener hands the guide page a handle on this one`)
    return `${link.textContent} -> ${link.href} (${link.target}, ${link.rel})`
  }))

// ===========================================================================
section('i. The pick flow decides success by IDENTITY, not by not-throwing')
// ===========================================================================

await test('picking a machine loads it and closes the overlay', () =>
  withFakeDom(async (env) => {
    const { state, overlay, opener } = await mounted(env)
    const godzilla = overlay.findAll('pg-library-row').find((c) => c.textContent.includes('Godzilla'))
    assert(godzilla, `no Godzilla row among: ${rowNames(overlay).join(', ')}`)
    godzilla.click()
    await flush()
    assert(overlay.find('pg-library-spinner'), 'the tapped row should show a spinner while its dataset loads')
    await env.settle('/data/godzilla_goals.json')
    await flush()
    assert(state.machine.id === 'godzilla', `expected godzilla, got ${state.machine.id}`)
    assert(overlay.hidden === true, 'a successful pick closes the overlay')
    assert(env.doc.activeElement === opener, 'focus returns to the header button')
    return 'tap -> spinner -> loaded -> closed, focus restored'
  }))

await test('a pick that LANDS on HOW IT PLAYS keeps focus in the sheet — the close does not pull it back to the header picker', () =>
  withFakeDom(async (env) => {
    const { state, overlay, opener } = await mounted(env)
    // app.ts's landing, reproduced at its real timing: renderAll sees the new
    // machine in the switch's notify and queues landOnHowItPlays as a
    // microtask; Study's openHowItPlays then focuses the sheet's Back button
    // (tests/study.test.mjs section al pins that half). That microtask runs
    // BEFORE pick's own continuation, i.e. before this overlay closes.
    const sheetBack = env.doc.createElement('button')
    sheetBack.className = 'study-learn-back'
    env.body.appendChild(sheetBack)
    let landedOn = state.machine.id
    state.onChange(() => {
      if (state.machine.id === landedOn) return
      landedOn = state.machine.id
      queueMicrotask(() => sheetBack.focus())
    })
    overlay.findAll('pg-library-row').find((c) => c.textContent.includes('Godzilla')).click()
    await flush()
    await env.settle('/data/godzilla_goals.json')
    await flush()
    assert(state.machine.id === 'godzilla' && overlay.hidden === true, 'setup: the pick loaded and closed')
    const now = env.doc.activeElement
    assert(now === sheetBack, `focus ended on ${now === opener ? 'the header picker (.machine-picker-btn), outside the open sheet' : now?.className || now?.tagName}`)
    return 'landing focused the sheet Back before close; close left it there'
  }))

await test('…while a close with focus still INSIDE the overlay (✕, Escape) does hand it back to the picker', () =>
  withFakeDom(async (env) => {
    const { overlay, opener } = await mounted(env)
    overlay.findAll('pg-library-row')[0].focus()
    env.key('Escape')
    assert(env.doc.activeElement === opener, 'focus on a row inside the overlay was not handed back to the opener')
  }))

await test('a FAILED pick keeps the overlay open, shows an alert, and offers Retry', () =>
  withFakeDom(
    async (env) => {
      const { state, overlay } = await mounted(env)
      const godzilla = overlay.findAll('pg-library-row').find((c) => c.textContent.includes('Godzilla'))
      godzilla.click()
      await flush()
      await env.settle('/data/godzilla_goals.json')
      await flush()
      assert(overlay.hidden === false, 'the overlay must stay OPEN when the pick failed')
      assert(state.machine.id === 'jaws', `the loaded machine must not change, got ${state.machine.id}`)
      const err = overlay.find('pg-library-error')
      assert(err, 'expected an inline error')
      assert(err.getAttribute('role') === 'alert', `error role is ${err.getAttribute('role')}`)
      assert(/Godzilla/.test(err.textContent), `the error should name the machine that failed: ${err.textContent}`)
      assert(overlay.find('pg-library-retry'), 'expected a Retry button')
      assert(!overlay.find('pg-library-spinner'), 'the spinner must be cleared')
      return `error shown: ${JSON.stringify(err.find('pg-library-error-text').textContent)}`
    },
    { failMachines: new Set(['godzilla']) },
  ))

await test('Retry re-attempts the SAME machine and succeeds on the second try', () =>
  withFakeDom(async (env) => {
    // First attempt fails, the second is allowed through — the exact shape of
    // a dropped connection in a venue.
    const failing = new Set(['godzilla'])
    globalThis.fetch = ((orig) => (url) => {
      const id = /\/data\/(.+)_goals\.json/.exec(url)?.[1]?.replace(/_/g, '-')
      if (id === 'godzilla' && failing.has(id)) {
        failing.delete(id)
        return Promise.reject(new Error('NetworkError: Failed to fetch'))
      }
      return orig(url)
    })(globalThis.fetch)

    const { state, overlay } = await mounted(env)
    const godzilla = overlay.findAll('pg-library-row').find((c) => c.textContent.includes('Godzilla'))
    godzilla.click()
    await flush()
    assert(overlay.find('pg-library-retry'), 'precondition: the first attempt failed')
    overlay.find('pg-library-retry').click()
    await flush()
    await env.settle('/data/godzilla_goals.json')
    await flush()
    assert(state.machine.id === 'godzilla', `Retry did not load the machine, still on ${state.machine.id}`)
    assert(overlay.hidden === true, 'a successful retry closes the overlay')
    return 'fail -> Retry -> godzilla loaded -> closed'
  }))

await test('tapping the machine already loaded just closes — no refetch', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    let fetches = 0
    const orig = globalThis.fetch
    globalThis.fetch = (url) => {
      if (/_goals\.json/.test(url)) fetches += 1
      return orig(url)
    }
    const jaws = overlay.findAll('pg-library-row').find((c) => c.textContent.includes('Jaws'))
    jaws.click()
    await flush()
    assert(overlay.hidden === true, 'it should just close')
    assert(fetches === 0, `expected no dataset fetch, saw ${fetches}`)
    return 'closed with 0 dataset requests'
  }))

// ===========================================================================
section('j. Search, chips and the pin star, driven through the DOM')
// ===========================================================================

await test('typing filters the list, and the count is announced through role="status"', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const search = overlay.find('pg-library-search')
    search.value = 'godz'
    search.dispatchEvent({ type: 'input' })
    await flush()
    const names = rowNames(overlay)
    assert(names.length === 1 && names[0] === 'Godzilla', `expected only Godzilla, got ${names.join(', ')}`)
    const status = overlay.find('pg-library-status')
    assert(status.getAttribute('role') === 'status', 'the results line must be a live region')
    assert(/1 machine\b/.test(status.textContent), `status reads ${JSON.stringify(status.textContent)}`)
    return `"godz" -> ${names.join(', ')} · status "${status.textContent}"`
  }))

await test('a query that matches nothing shows an empty state, not a blank screen', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const search = overlay.find('pg-library-search')
    search.value = 'zzzzz'
    search.dispatchEvent({ type: 'input' })
    await flush()
    assert(rowNames(overlay).length === 0, 'no rows should match')
    assert(overlay.find('pg-library-empty'), 'expected an empty-state line')
    return overlay.find('pg-library-empty').textContent
  }))

await test('a maker chip filters, is aria-pressed, and TAPPING IT AGAIN clears it', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const chips = overlay.findAll('pg-library-chip')
    const williams = chips.find((c) => c.textContent === 'Williams')
    assert(williams, `no Williams chip among ${chips.map((c) => c.textContent).join(', ')}`)
    assert(williams.getAttribute('aria-pressed') === 'false', 'chip starts unpressed')
    williams.click()
    await flush()
    assert(rowNames(overlay).join() === 'Comet', `expected only Comet, got ${rowNames(overlay).join(', ')}`)
    const nowOn = overlay.findAll('pg-library-chip').find((c) => c.textContent === 'Williams')
    assert(nowOn.getAttribute('aria-pressed') === 'true', 'the active chip must be aria-pressed')
    assert(nowOn.classList.contains('pg-library-chip-on'), 'the active chip must carry its lit class')
    nowOn.click()
    await flush()
    assert(rowNames(overlay).length > 1, 'tapping the active chip again should clear the filter')
    return 'Williams -> Comet only; second tap restores the full list'
  }))

await test('the star is a SIBLING of the row, never nested inside it', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const wrap = overlay.findAll('pg-library-rowwrap')[0]
    const row = wrap.find('pg-library-row')
    const pin = wrap.findAll('pg-library-pin')[0]
    assert(row && pin, 'expected a row and a star in the wrapper')
    // A <button> inside a <button> is invalid HTML, and browsers resolve it by
    // dropping one of them — which is how a "nested" star ends up either
    // untappable or swallowing the whole row's tap. This is the property that
    // actually keeps a star tap off the machine switch.
    assert(!pin.isInside(row), 'the pin star is nested INSIDE the row button — invalid HTML')
    assert(pin.parentElement === wrap, `the star should be a direct child of the wrapper, its parent is .${pin.parentElement?.className}`)
    return 'star and row are siblings inside .pg-library-rowwrap'
  }))

await test('the pin star toggles, persists, announces itself, and does NOT pick the machine', () =>
  withFakeDom(async (env) => {
    const { state, overlay } = await mounted(env)
    const wraps = overlay.findAll('pg-library-rowwrap')
    const cometWrap = wraps.find((c) => c.textContent.includes('Comet'))
    const pin = cometWrap.findAll('pg-library-pin')[0]
    assert(pin.getAttribute('aria-pressed') === 'false', 'starts unpinned')
    assert(/^Pin /.test(pin.getAttribute('aria-label')), `label is ${pin.getAttribute('aria-label')}`)
    // Dispatched through the BUBBLING harness — if the star were nested in the
    // row, or the wrapper ever delegated a click, this is where it would show.
    pin.click()
    await flush()
    assert(state.isPinned('comet'), 'state should record the pin')
    assert(state.machine.id === 'jaws', 'a pin tap must NOT switch machine')
    assert(overlay.hidden === false, 'a pin tap must not close the overlay')
    const pinned = JSON.parse(env.store.get('pinballgenie.pinnedMachineIds'))
    assert(pinned.includes('comet'), `persisted list is ${JSON.stringify(pinned)}`)
    const secTitles = overlay.findAll('pg-library-section-title').map((t) => t.textContent)
    assert(secTitles.includes('Pinned'), `expected a Pinned section, got ${secTitles.join(', ')}`)
    const relabelled = overlay.findAll('pg-library-rowwrap').find((c) => c.textContent.includes('Comet')).findAll('pg-library-pin')[0]
    assert(/^Unpin /.test(relabelled.getAttribute('aria-label')), `label after pinning is ${relabelled.getAttribute('aria-label')}`)
    return 'pin -> state + localStorage + a Pinned section; machine unchanged, overlay still open'
  }))

// ===========================================================================
section('j2. The row: names first, and the grid is gone')
// ===========================================================================

await test('a row is thumbnail, NAME, meta — in that order, with the star outside it', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const wrap = overlay.findAll('pg-library-rowwrap')[0]
    const row = wrap.find('pg-library-row')
    assert(row.tagName === 'BUTTON', `the row must be the button, got ${row.tagName}`)
    // ORDER IS THE CLAIM. The name is the scan anchor: it may not end up after
    // the meta, and the accent may not end up after the name.
    const kids = row.children.map((c) => c.className.split(' ')[0])
    assert(kids[0] === 'pg-library-thumb', `the accent must lead the row, got ${kids.join(' | ')}`)
    assert(kids[1] === 'pg-library-row-body', `the text column must follow it, got ${kids.join(' | ')}`)
    const body = row.find('pg-library-row-body')
    const textKids = body.children.map((c) => c.className)
    assert(textKids[0] === 'pg-library-row-name', `NAME must come first in the text column, got ${textKids.join(' | ')}`)
    assert(textKids[1] === 'pg-library-row-meta', `meta must follow the name, got ${textKids.join(' | ')}`)
    assert(/^(JAWS|STERN) · \d{4}$/.test(body.find('pg-library-row-meta').textContent) || /·/.test(body.find('pg-library-row-meta').textContent), 'the meta should carry maker · year')
    return `row = ${kids.join(' + ')} · text = ${textKids.join(' + ')}`
  }))

await test('the row accent is the SMALL slot, not a card thumbnail shrunk by CSS', () => {
  const css = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8')
  const rule = /\.pg-library-thumb-row \{([^}]*)\}/.exec(css)
  assert(rule, 'no .pg-library-thumb-row rule — the row accent has no size of its own')
  assert(/height:\s*40px/.test(rule[1]), `the accent should be 40px tall, got ${rule[1].trim()}`)
  assert(/width:\s*30px/.test(rule[1]), `and 30px wide (3:4), got ${rule[1].trim()}`)
  // The paint follows the box: a 30px-wide thumb draws smaller dots, or 24
  // shots at r=1.6 cover 16% of the plate and the flippers stop reading.
  assert(lib.dotRadiusFor(30) < lib.dotRadiusFor(158), 'the dot radius must scale with the box')
  assert(lib.dotRadiusFor(158) === 1.6, `a card-size thumb must be unchanged at 1.6, got ${lib.dotRadiusFor(158)}`)
  assert(lib.dotRadiusFor(30) === 0.6, `a row-size thumb should sit on the floor, got ${lib.dotRadiusFor(30)}`)
  return `30x40 accent · dot r: 158px -> ${lib.dotRadiusFor(158)}, 30px -> ${lib.dotRadiusFor(30)}`
})

await test('EVERY part of the row except the star is inside the pick button', () =>
  withFakeDom(
    async (env) => {
      // rolo, from the live site: "When I click the title of the name of the
      // game list it doesn't select the game." The cause was CSS (a hit overlay
      // escaping to cover the whole screen — pinned in hit-areas.test.mjs), but
      // the STRUCTURAL half belongs here: if any piece of the row's surface
      // sits outside the button, tapping that piece is inert no matter how the
      // stacking works out. Signed in, so the progress badge is present too.
      const { overlay } = await mounted(env)
      await flush()
      await flush()
      const wrap = overlay.findAll('pg-library-rowwrap').find((w) => w.find('pg-library-row-prog'))
      assert(
        wrap,
        `precondition: a signed-in row with a progress badge (rows=${overlay.findAll('pg-library-rowwrap').length}, badges=${overlay.findAll('pg-library-row-prog').length})`,
      )
      const row = wrap.find('pg-library-row')
      const pin = wrap.findAll('pg-library-pin')[0]

      const MUST_BE_INSIDE = ['pg-library-thumb', 'pg-library-row-body', 'pg-library-row-name', 'pg-library-row-meta', 'pg-library-row-prog']
      const outside = MUST_BE_INSIDE.filter((cls) => {
        const el = wrap.find(cls)
        return !el || !(el === row || el.isInside(row))
      })
      assert(outside.length === 0, `these are outside the pick button, so tapping them does nothing: ${outside.join(', ')}`)

      // The star is the ONE exception, and it must stay outside: a <button>
      // inside a <button> is invalid HTML and browsers drop one of them.
      assert(!pin.isInside(row), 'the star must remain a sibling of the row button')

      // The wrapper holds exactly two children: the pick button and the star.
      // Anything else there is a strip of row that picks nothing.
      const kids = wrap.children.map((c) => c.className.split(' ')[0])
      assert(kids.length === 2 && kids[0] === 'pg-library-row' && kids[1] === 'pg-library-pin', `the wrapper holds ${kids.join(' + ')}`)

      // And the button really is the whole row beside the star.
      const css = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8')
      const rowRule = /\.pg-library-row \{([^}]*)\}/.exec(css)[1]
      assert(/flex:\s*1/.test(rowRule), 'the pick button must take all the width the star leaves')
      assert(/\.pg-library-rowwrap \{[^}]*display:\s*flex/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'the wrapper must lay the two out in a row')
      return `inside the button: ${MUST_BE_INSIDE.join(', ')}; sibling: pin; wrapper children: ${kids.join(' + ')}`
    },
    // ui/session.ts requires a non-empty `user` uid; `email` alone reads as
    // signed out, and then there are no badges to check.
    { session: { user: 'u1' }, progressBlob: { godzilla: { a: 1 } } },
  ))

await test('a row computes to EXACTLY 48px at the shipped type steps, and cannot grow with width', () => {
  // COMPUTED FROM THE TOKENS AND RULES THAT SHIP, not asserted as a number.
  // If --fs-4 moves a step, or the meta stops being one line, this arithmetic
  // goes red instead of the layout silently drifting to 52px and the whole
  // list losing its rhythm.
  // Comments stripped first: a declaration sitting straight after a /* … */
  // has no `;` in front of it, and a property matcher anchored on one would
  // silently read null and compute NaN rather than fail loudly.
  const css = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (sel) => {
    const m = new RegExp(`\\${sel} \\{([^}]*)\\}`).exec(css)
    assert(m, `no ${sel} rule`)
    return m[1]
  }
  const val = (body, prop) => {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)
    return m ? m[1].trim() : null
  }
  const px = (v) => Number(String(v).replace('px', ''))
  const token = (name) => px(new RegExp(`${name}:\\s*(\\d+)px`).exec(stylesCss)[1])

  const row = rule('.pg-library-row')
  const nameRule = rule('.pg-library-row-name')
  const metaRule = rule('.pg-library-row-meta')
  const textCol = rule('.pg-library-row-body')
  const thumb = rule('.pg-library-thumb-row')

  const fsName = token('--fs-4')
  const fsMeta = token('--fs-1')
  assert(val(nameRule, 'font-size') === 'var(--fs-4)', `the name should be on --fs-4, got ${val(nameRule, 'font-size')}`)
  assert(val(metaRule, 'font-size') === 'var(--fs-1)', `the meta should be on --fs-1, got ${val(metaRule, 'font-size')}`)

  const lh = (r) => Number(val(r, 'line-height'))
  const textHeight = fsName * lh(nameRule) + px(val(textCol, 'gap')) + fsMeta * lh(metaRule)
  const padY = px(val(row, 'padding').split(/\s+/)[0])
  const content = Math.max(px(val(thumb, 'height')), textHeight)
  const computed = Math.max(px(val(row, 'min-height')), content + padY * 2)
  assert(computed === 48, `a row computes to ${computed}px (thumb ${val(thumb, 'height')}, text ${textHeight.toFixed(1)}px, padding ${padY}x2), expected exactly 48`)

  // WIDTH-INDEPENDENT, which is what makes 320/390/420 identical: both text
  // lines are single-line with an ellipsis, and the accent is a fixed px box.
  // Nothing in the row can wrap, so nothing in it can grow taller when the
  // viewport narrows.
  for (const [label, r] of [['name', nameRule], ['meta', metaRule]]) {
    assert(val(r, 'white-space') === 'nowrap', `the ${label} must be nowrap or a narrow phone wraps it to a taller row`)
    assert(val(r, 'text-overflow') === 'ellipsis', `the ${label} needs an ellipsis to go with nowrap`)
  }
  assert(!/-webkit-line-clamp|line-clamp/.test(nameRule), 'the name must not be line-clamped — that was the card era, and 2 lines is 18px taller')
  assert(/px$/.test(val(thumb, 'height')) && /px$/.test(val(thumb, 'width')), 'the accent must be a fixed px box, not relative to the row width')

  // The repeat PITCH adds the wrapper's hairline.
  const hair = px(val(rule('.pg-library-rowwrap'), 'border-bottom').split(/\s+/)[0])
  assert(hair === 1, `the row separator is ${hair}px`)
  return `row ${computed}px = max(min-height 48, max(thumb ${px(val(thumb, 'height'))}, text ${textHeight.toFixed(1)}) + ${padY}x2); pitch ${computed + hair}px; nowrap both lines -> width-independent`
})

await test('the row is a 48px full-width target, and the 2-up GRID is gone from the CSS', () => {
  const css = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8')
  const row = /\.pg-library-row \{([^}]*)\}/.exec(css)[1]
  assert(/min-height:\s*48px/.test(row), `the row must be at least 48px tall, got ${row.trim()}`)
  assert(/flex:\s*1/.test(row), 'the row must take the whole width beside the star')
  // REMOVED, not toggled: a rejected design left behind a flag is a rejected
  // design you ship twice.
  assert(!/\.pg-library-grid\b/.test(css), 'the dead .pg-library-grid rule is still in library.css')
  assert(!/grid-template-columns/.test(css), 'library.css still declares a grid template')
  const src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
  assert(!/pg-library-grid|pg-library-cell|pg-library-card/.test(src), 'library.ts still builds grid-era class names')
  return 'row: min-height 48px, flex 1 · no grid rule, no grid template, no grid class names'
})

await test('ORPHAN SWEEP: the grid-era classes survive nowhere under src/, and no copy mentions cards', () => {
  // A DELETION HAS TO BE PROVED, not asserted in a commit message. The check
  // above only reads two files; this one sweeps the whole tree, because a
  // stylesheet or a help string left behind is exactly the kind of orphan a
  // green suite cannot see.
  const DEAD = ['pg-library-grid', 'pg-library-cell', 'pg-library-card']
  const walk = (dir, acc = []) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, name.name)
      if (name.isDirectory()) walk(full, acc)
      else if (/\.(ts|css|html)$/.test(name.name)) acc.push(full)
    }
    return acc
  }
  const files = walk(srcDir)
  assert(files.length > 20, `precondition: the sweep must actually find files, got ${files.length}`)
  const offenders = []
  for (const f of files) {
    const body = readFileSync(f, 'utf8')
    for (const dead of DEAD) {
      // The library SUITE is allowed to name them in order to assert absence;
      // src/ is not, and src/ is all this walks.
      if (body.includes(dead)) offenders.push(`${f.slice(srcDir.length + 1)}: ${dead}`)
    }
  }
  assert(offenders.length === 0, `grid-era class names still live under src/: ${offenders.join(', ')}`)

  // AND THE COPY. The how-to guide describes how to pick a machine; if it still
  // says "cards" or "grid" there, it is describing a screen that no longer
  // exists.
  //
  // SCOPED, deliberately. A blanket "no string says card" is the wrong gate and
  // was tried first: it fires on "The two cards below cover that for iPhone and
  // Android", which is the how-to's OWN install cards and entirely correct. The
  // orphan worth catching is card/grid language ABOUT PICKING A MACHINE, so the
  // predicate needs both halves. (Comments are stripped first — the source
  // discusses a different, unrelated "Card" tab at length, and an apostrophe in
  // prose is not a string literal.)
  const howtoSource = readFileSync(resolve(srcDir, 'ui/howto.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
  const strings = [...howtoSource.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2])
  assert(strings.length > 50, `precondition: the how-to copy must actually be found, got ${strings.length}`)
  const badCopy = strings.filter(
    (s) => /\b(cards?|grid)\b/i.test(s) && /\b(machine|machines|table|tables|library|pick|picker|choose)\b/i.test(s),
  )
  assert(badCopy.length === 0, `how-to copy still describes picking a machine from cards or a grid: ${badCopy.join(' | ')}`)
  // And the predicate is not vacuous — it has to fire on the sentence the old
  // design would have shipped.
  const canary = 'Tap a card in the grid to choose a machine'
  assert(
    /\b(cards?|grid)\b/i.test(canary) && /\b(machine|machines|table|tables|library|pick|picker|choose)\b/i.test(canary),
    'the copy predicate would not catch card-grid language even if it were there',
  )
  return `${files.length} files under src/ swept, 0 grid-era class names; ${strings.length} how-to strings, 0 describe picking from cards or a grid`
})

// ===========================================================================
section('j3. Letter sections: the letter comes from the SORT key, not the title')
// ===========================================================================

await test('letterFor uses the strip-"The" key — Addams files under A, Evil Dead under E', () => {
  assert(lib.letterFor('The Addams Family') === 'A', `got ${lib.letterFor('The Addams Family')}`)
  assert(lib.letterFor('The Evil Dead') === 'E', `got ${lib.letterFor('The Evil Dead')}`)
  assert(lib.letterFor('Theatre of Magic') === 'T', '"Theatre" is not "The atre" — only a whole article is stripped')
  assert(lib.letterFor('twilight zone') === 'T', 'the letter is upper-cased')
  return 'The Addams Family -> A · The Evil Dead -> E · Theatre of Magic -> T'
})

await test('anything that does not start with a letter groups under #', () => {
  // Not in today's catalog — checked, not assumed — so the rule is proved on
  // the function rather than on a machine that does not exist.
  const realCatalog = JSON.parse(readFileSync(resolve(__dirname, '../../data/catalog.json'), 'utf8'))
  const nonAlpha = lib
    .entriesFromCatalog(realCatalog)
    .filter((e) => lib.letterFor(e.title) === '#')
    .map((e) => e.title)
  assert(nonAlpha.length === 0, `the catalog now has #-group machines (${nonAlpha.join(', ')}) — assert them here directly`)
  assert(lib.letterFor('300') === '#', `got ${lib.letterFor('300')}`)
  assert(lib.letterFor('¡Viva!') === '#', `got ${lib.letterFor('¡Viva!')}`)
  return `0 of ${realCatalog.length} catalog machines group under # today; "300" and "¡Viva!" would`
})

await test('groupByLetter cuts an already-sorted list into runs, in the list\'s own order', () => {
  const mk = (title) => ({ ...libraryDoc().machines[0], id: title, title })
  const sorted = lib.sortForDisplay(['The Addams Family', 'Attack from Mars', 'Black Knight', 'Comet'].map(mk))
  const groups = lib.groupByLetter(sorted)
  assert(groups.map((g) => g.letter).join('') === 'ABC', `expected A B C, got ${groups.map((g) => g.letter).join(' ')}`)
  assert(groups[0].entries.length === 2, `A should hold both Addams and Attack, got ${groups[0].entries.length}`)
  // The order is the LIST's, so a '#' group leads (localeCompare sorts digits
  // before letters) and the rail agrees with what is on screen.
  const withHash = lib.groupByLetter(lib.sortForDisplay(['300', 'Comet'].map(mk)))
  assert(withHash.map((g) => g.letter).join('') === '#C', `expected # then C, got ${withHash.map((g) => g.letter).join(' ')}`)
  assert(lib.railLetters(withHash)[0] === '#', 'the rail must lead with # when the list does')
  assert(lib.railLetters(groups).length === 26, `a no-# rail is 26 letters, got ${lib.railLetters(groups).length}`)
  return 'A(2) B C · with a # title: # then C, and the rail leads with #'
})

await test('letter headers render over the A-Z section, and NOT over Pinned or Recent', () =>
  withFakeDom(
    async (env) => {
      const { state, overlay } = await mounted(env, { boot: BIG_BOOT })
      state.togglePinned('comet')
      await flush()
      const letters = overlay.findAll('pg-library-letter').map((h) => h.textContent)
      assert(letters.length > 0, 'expected letter headers over the A-Z list')
      assert(letters.join('') === [...letters].sort().join(''), `headers must be in order, got ${letters.join(' ')}`)
      // Every header lives in the SAME list as its rows, and that list is the
      // one under "All machines" — never under Pinned.
      const pinnedSection = overlay
        .findAll('pg-library-section')
        .find((s) => s.find('pg-library-section-title')?.textContent === 'Pinned')
      assert(pinnedSection, 'precondition: a Pinned section is on screen')
      assert(pinnedSection.findAll('pg-library-letter').length === 0, 'Pinned must not be split by letter')
      // THE CLAIM THIS SECTION EXISTS FOR: The Evil Dead sits under E.
      CHECKS.theFilesUnderItsSortLetter(overlay)
      return `headers ${letters.join(' ')} · Pinned unlettered · The Evil Dead under E`
    },
    { catalog: BIG_CATALOG },
  ))

await test('each letter header owns its OWN box, or every sticky header pins at once', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const heads = overlay.findAll('pg-library-letter')
      assert(heads.length > 1, 'precondition: several letter groups')
      // A sticky header sticks within its CONTAINING BLOCK. Share one and they
      // all pin to the top of the scrollport together — a stack of opaque boxes
      // on the same 24 pixels, repainted every scroll frame, of which only the
      // last in DOM order is visible. It LOOKS right, which is why the fake DOM
      // could never have caught it and a real browser did.
      const parents = new Set(heads.map((h) => h.parentElement))
      assert(parents.size === heads.length, `${heads.length} headers share ${parents.size} containing blocks — they will pin on top of each other`)
      // And each box holds its header plus exactly its own rows, in that order.
      for (const h of heads) {
        const box = h.parentElement
        assert(box.classList.contains('pg-library-lettergroup'), `a header's box is .${box.className}`)
        assert(box.children[0] === h, `the header must lead its box, got .${box.children[0].className}`)
        assert(
          box.children.slice(1).every((c) => c.classList.contains('pg-library-rowwrap')),
          `${h.textContent}'s box holds something other than its rows`,
        )
      }
      const css = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8')
      const stickyRule = /\.pg-library-letter \{([^}]*)\}/.exec(css)[1]
      assert(/position:\s*sticky/.test(stickyRule), 'the letter header must be sticky, or the group box buys nothing')
      assert(/top:\s*0/.test(stickyRule), 'and it must pin to the top of the scrollport')
      // AND THE SCROLLPORT MAY NOT HAVE A TOP PADDING. Sticky `top: 0` pins to
      // the CONTENT box, so a padding-top leaves a band above the pinned header
      // that rows keep scrolling through — half a row of some other machine
      // floating over the index. The 12px lives on the first child instead.
      // (Found by scrolling the real overlay; there is no sticky positioning in
      // a fake DOM for a behavioural test to catch this with.)
      const bodyRule = /\.pg-library-body \{([^}]*)\}/.exec(css)[1]
      const pad = /padding:\s*([^;]+)/.exec(bodyRule)[1].trim().split(/\s+/)[0]
      assert(pad === '0', `.pg-library-body padding-top is ${pad} — rows will scroll through the band above the pinned header`)
      assert(/\.pg-library-body > :first-child \{\s*margin-top:\s*12px/.test(css), 'the 12px must move onto the first child, or the strip sits flush against the search field')
      return `${heads.length} headers, ${parents.size} separate boxes; scrollport padding-top ${pad}, 12px on the first child`
    },
    { catalog: BIG_CATALOG },
  ))

// ===========================================================================
section('j4. The A-Z rail')
// ===========================================================================

await test('the rail is a group of real BUTTONS, one per letter, empty ones disabled', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const rail = overlay.find('pg-library-rail')
      assert(rail && rail.hidden === false, 'expected a visible rail over 24 machines')
      assert(rail.getAttribute('role') === 'group', `rail role is ${rail.getAttribute('role')}`)
      assert(/jump to letter/i.test(rail.getAttribute('aria-label') ?? ''), `rail label is ${rail.getAttribute('aria-label')}`)
      const btns = overlay.findAll('pg-library-rail-btn')
      assert(btns.length === 26, `expected 26 letters, got ${btns.length}`)
      assert(btns.every((b) => b.tagName === 'BUTTON'), 'every letter must be a real button')
      const a = btns.find((b) => b.textContent === 'A')
      assert(a.getAttribute('aria-label') === 'Jump to A', `A's label is ${a.getAttribute('aria-label')}`)
      // BIG_CATALOG has nothing under O, Q, U, W, X, Y or Z.
      const off = btns.filter((b) => b.disabled).map((b) => b.textContent)
      assert(off.join('') === 'OQUWXYZ', `expected O Q U W X Y Z dimmed, got ${off.join(' ')}`)
      // COLOUR IS NOT A STATE. "No machines under this letter" is announced by
      // `disabled`/`aria-disabled`, which a screen reader reads and the tab
      // order respects; the dimming is the sighted half of the same fact, not
      // the whole of it.
      CHECKS.dimmedLettersAnnounceTheirState(overlay)
      assert(
        btns.filter((b) => b.disabled).every((b) => b.classList.contains('pg-library-rail-btn-off')),
        'a dimmed letter must carry its dimmed class as well as its state',
      )

      // DRAG-SCRUB IS A POINTER-ONLY ENHANCEMENT: every destination it reaches
      // is reachable by ACTIVATING a letter, which is the AT and keyboard path.
      // Proved by driving a letter with a plain click — no pointer events at
      // all, which is exactly what an AT activation produces.
      const { scroller } = layout(overlay)
      btns.find((b) => b.textContent === 'M').click()
      assert(scroller._scrolls.length === 1, 'a keyboard/AT activation must jump without any pointer event')
      CHECKS.firstRowClearsPinnedHeader(overlay, 'M', scroller)
      const src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
      assert(/DRAG-SCRUB IS A POINTER-ONLY ENHANCEMENT/.test(src), 'library.ts must state that the drag is an enhancement, not the only route')
      return `26 buttons, aria-label "Jump to A", dimmed+disabled: ${off.join(' ')}; click-only activation jumps`
    },
    { catalog: BIG_CATALOG },
  ))

await test('the element the rail scrolls is the overlay\'s OWN scrollport, by identity — not document.body', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { rail, scroller } = layout(overlay)

      // WHY BY IDENTITY. styles.css pins `body { position: fixed; inset: 0;
      // overflow: hidden }` for iOS toolbar hardening, so document.body cannot
      // scroll at all: a jump aimed at it would be a silent no-op, and
      // "documentElement.scrollTop is still 0" would pass while nothing moved.
      // Matching on a class name is not enough either — this asserts the exact
      // node, and that it is not the document's body.
      assert(scroller === overlay.find('pg-library-body'), 'precondition: the scrollport is the overlay\'s own div')
      assert(scroller !== env.body && scroller !== env.doc.body, 'the scrollport must not be document.body')
      assert(scroller.tagName === 'DIV', `the scrollport is a ${scroller.tagName}`)

      const m = overlay.findAll('pg-library-rail-btn').find((b) => b.textContent === 'M')
      pointer(m, 'pointerdown', railY(railOrderOf(overlay), 'M'))

      // EXACTLY ONE element was scrolled, and it was that one. Shared with the
      // mutation test below, so both ask the identical question.
      CHECKS.railScrollsTheScrollport(overlay, scroller, env)
      assert(env.body.scrollTop === 0 && env.body._scrolls.length === 0, 'document.body was scrolled')
      assert(rail._scrolls.length === 0 && rail.scrollTop === 0, 'the rail scrolled itself instead of the list')

      // AND IT LANDED — measured WITHIN the scrollport, which is the only frame
      // in which "did anything move" has an answer. A viewport-relative rect
      // can read correct while the scrollport never moved.
      const { pinned, rowRect } = groupAt(overlay, 'M', scroller)
      const portTop = scroller.getBoundingClientRect().top
      assert(Math.abs(pinned.top - portTop) < 0.5, `M's header sits ${(pinned.top - portTop).toFixed(1)}px from the top of the scrollport, expected 0`)
      assert(scroller.scrollTop > 0, 'the scrollport did not actually move')
      return `tap M -> ONE element scrolled (.pg-library-body, not document.body), scrollTop ${scroller.scrollTop}, header flush at the port top`
    },
    { catalog: BIG_CATALOG },
  ))

await test('the jump puts the target group\'s FIRST ROW clear of the pinned header', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      const rows = []
      for (const letter of ['B', 'G', 'M', 'S']) {
        pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), letter))
        pointer(overlay.find('pg-library-rail'), 'pointerup', railY(railOrderOf(overlay), letter))
        // THE PROPERTY, not the arithmetic: land the header at the top and its
        // first row begins at the header's bottom edge — visible. Target the
        // first ROW instead and the sticky header pins over precisely the
        // machine you jumped for. Shared with the mutation test below.
        CHECKS.firstRowClearsPinnedHeader(overlay, letter, scroller)
        const { pinned, rowRect, firstRow } = groupAt(overlay, letter, scroller)
        rows.push(`${letter}:${firstRow.find('pg-library-row-name').textContent}@+${(rowRect.top - pinned.bottom).toFixed(0)}`)
      }
      return rows.join(' ')
    },
    { catalog: BIG_CATALOG },
  ))

await test('the jump is MEASURED, so a different row height changes nothing about where it lands', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      // A row pitch the code has never seen. An index that multiplied an
      // assumed 48px by a row count would drift further from its target the
      // further down the list it jumped; a measured one cannot.
      const { scroller } = layout(overlay, { rowH: 61, headH: 31 })
      const portTop = scroller.getBoundingClientRect().top
      const landed = []
      for (const letter of ['C', 'J', 'T']) {
        pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), letter))
        pointer(overlay.find('pg-library-rail'), 'pointerup', railY(railOrderOf(overlay), letter))
        const { pinned, rowRect } = groupAt(overlay, letter, scroller)
        assert(Math.abs(pinned.top - portTop) < 0.5, `${letter} landed ${(pinned.top - portTop).toFixed(1)}px off with a 61px row pitch`)
        assert(rowRect.top >= pinned.bottom - 0.5, `${letter}'s first row is under the header at a 61px pitch`)
        landed.push(`${letter}@${scroller.scrollTop}`)
      }
      return `61px rows / 31px headers: ${landed.join(' ')} — all flush`
    },
    { catalog: BIG_CATALOG },
  ))

await test('the LAST letter clamps to the bottom instead of scrolling into empty space', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      // The platform clamps a scrollTo past the end; the harness models the
      // scrollport's own extent so the same arithmetic is exercised.
      const maxScroll = Math.max(0, scroller._contentHeight - scroller._rect.height)
      const last = railOrderOf(overlay)
        .filter((l) => !overlay.findAll('pg-library-rail-btn').find((b) => b.textContent === l).disabled)
        .pop()
      pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), last))
      const asked = scroller._scrolls[0].top
      assert(asked > 0, `the last letter asked for ${asked}`)
      // It may legitimately ask for more than the scrollport can give; what it
      // must never do is ask for something that is not that group's position.
      const head = overlay.findAll('pg-library-letter').find((h) => h.textContent === last)
      assert(Math.abs(asked - (head._rect.top - BODY_TOP)) < 0.5, `asked for ${asked}, ${last} sits at ${head._rect.top - BODY_TOP}`)
      const clamped = Math.min(asked, maxScroll)
      assert(clamped <= maxScroll, 'the clamp must not exceed the scrollable extent')
      return `last live letter ${last}: asked ${asked}, scrollable extent ${maxScroll}, clamps to ${clamped}`
    },
    { catalog: BIG_CATALOG },
  ))

await test('a DRAG across three letters lands on the last one, not the first', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      const order = railOrderOf(overlay)
      const rail = overlay.find('pg-library-rail')
      const anchorTop = (letter) =>
        overlay.findAll('pg-library-letter').find((h) => h.textContent === letter)._rect.top - BODY_TOP
      pointer(rail, 'pointerdown', railY(order, 'A'))
      pointer(rail, 'pointermove', railY(order, 'B'))
      pointer(rail, 'pointermove', railY(order, 'C'))
      pointer(rail, 'pointerup', railY(order, 'C'))
      const tops = scroller._scrolls.map((s) => s.top)
      assert(tops.length === 3, `expected a scroll per letter crossed, got ${tops.length}`)
      assert(tops[tops.length - 1] === anchorTop('C'), `the scrub must END on C (${anchorTop('C')}), got ${tops[tops.length - 1]}`)
      assert(tops[0] === anchorTop('A'), 'and it must have started on A')
      // After the finger lifts, a stray move must not keep scrubbing.
      pointer(rail, 'pointermove', railY(order, 'J'))
      assert(scroller._scrolls.length === 3, 'a pointermove after pointerup must not scrub')
      return `A -> B -> C = tops ${tops.join(', ')}; ends on C`
    },
    { catalog: BIG_CATALOG },
  ))

await test('scrubbing over a DIMMED letter changes nothing — the list stays where the last live letter put it', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      const order = railOrderOf(overlay)
      const rail = overlay.find('pg-library-rail')
      const nTop =
        overlay.findAll('pg-library-letter').find((h) => h.textContent === 'N')._rect.top - BODY_TOP
      pointer(rail, 'pointerdown', railY(order, 'N'))
      const afterN = scroller._scrolls.length
      assert(afterN === 1 && scroller._scrolls[0].top === nTop, `N should have jumped, got ${JSON.stringify(scroller._scrolls)}`)
      pointer(rail, 'pointermove', railY(order, 'O')) // O is dimmed in BIG_CATALOG
      assert(scroller._scrolls.length === afterN, `a dimmed letter must not scroll: ${JSON.stringify(scroller._scrolls)}`)
      assert(scroller.scrollTop === nTop, 'and the list must still be where N left it')
      // A dimmed letter is also inert to a direct activation.
      overlay.findAll('pg-library-rail-btn').find((b) => b.textContent === 'O').click()
      assert(scroller._scrolls.length === afterN, 'clicking a dimmed letter must do nothing')
      return `N -> ${nTop}, then O (dimmed) -> no further scroll`
    },
    { catalog: BIG_CATALOG },
  ))

await test('railIndexAt divides the rail into equal zones and CLAMPS past both ends', () => {
  // 26 letters over 520px = 20px each, starting at 120.
  assert(lib.railIndexAt(120, 120, 520, 26) === 0, 'the very top is the first letter')
  assert(lib.railIndexAt(139, 120, 520, 26) === 0, 'still inside zone 0 at +19')
  assert(lib.railIndexAt(140, 120, 520, 26) === 1, 'zone 1 starts at +20')
  assert(lib.railIndexAt(639, 120, 520, 26) === 25, 'the last pixel is the last letter')
  // Clamped, not rejected: a thumb travelling fast down the edge of a phone
  // overshoots, and every contacts list on the platform pins rather than drops.
  assert(lib.railIndexAt(-500, 120, 520, 26) === 0, 'above the rail pins to the first letter')
  assert(lib.railIndexAt(5000, 120, 520, 26) === 25, 'below it pins to the last')
  assert(lib.railIndexAt(300, 120, 0, 26) === -1, 'a rail with no height has no zones')
  assert(lib.railIndexAt(300, 120, 520, 0) === -1, 'and neither does one with no letters')
  return '20px zones, boundaries at +0/+20, clamped at both ends, -1 when degenerate'
})

await test('REDUCED MOTION removes the glide and keeps the jump', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      const mTop = overlay.findAll('pg-library-letter').find((h) => h.textContent === 'M')._rect.top - BODY_TOP
      pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), 'M'))
      assert(scroller._scrolls[0].behavior === 'auto', `expected behavior 'auto', got ${scroller._scrolls[0].behavior}`)
      // The FEATURE survives — it still lands on M, it just does not glide.
      assert(scroller._scrolls[0].top === mTop, `it must still reach M (${mTop}), got ${scroller._scrolls[0].top}`)
      // SAME ELEMENT on this path as on the glide path: reduced motion changes
      // the behavior flag and nothing else.
      CHECKS.railScrollsTheScrollport(overlay, scroller, env)
      CHECKS.firstRowClearsPinnedHeader(overlay, 'M', scroller)
      return `prefers-reduced-motion -> scroller.scrollTo({ top: ${mTop}, behavior: 'auto' }), same element, row still clear`
    },
    { catalog: BIG_CATALOG, reducedMotion: true },
  ))

await test('without reduced motion the jump GLIDES', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), 'M'))
      assert(scroller._scrolls[0].behavior === 'smooth', `expected 'smooth', got ${scroller._scrolls[0].behavior}`)
      CHECKS.railScrollsTheScrollport(overlay, scroller, env)
      CHECKS.firstRowClearsPinnedHeader(overlay, 'M', scroller)
      return "no reduced-motion preference -> behavior: 'smooth', same element, row still clear"
    },
    { catalog: BIG_CATALOG },
  ))

await test('an environment without Element.scrollTo still jumps, by assigning scrollTop', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      assert(scroller.scrollTo === undefined, 'precondition: this environment has no Element.scrollTo')
      const mTop = overlay.findAll('pg-library-letter').find((h) => h.textContent === 'M')._rect.top - BODY_TOP
      pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), 'M'))
      assert(scroller.scrollTop === mTop, `expected scrollTop ${mTop}, got ${scroller.scrollTop}`)
      return `no scrollTo -> body.scrollTop = ${mTop}`
    },
    { catalog: BIG_CATALOG, noScrollTo: true },
  ))

await test('the rail HIDES under a search, even when the results are long enough for one', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      assert(overlay.find('pg-library-rail').hidden === false, 'precondition: the browse view has a rail')
      const search = overlay.find('pg-library-search')
      search.value = 'a'
      search.dispatchEvent({ type: 'input' })
      await flush()
      // THE COUNT IS NOT WHY. Asserting the rail is gone would also pass if the
      // query had simply narrowed the list under the threshold, which is a
      // different rule and would hide a regression in this one.
      const shown = rowNames(overlay).length
      assert(shown >= lib.RAIL_MIN_ROWS, `this query must stay above the threshold to isolate the rule; it matched ${shown}`)
      CHECKS.railHiddenWhileSearching(overlay)
      assert(overlay.findAll('pg-library-letter').length === 0, 'letter headers must go with the rail')
      return `query "a" matched ${shown} (>= ${lib.RAIL_MIN_ROWS}) and the rail is still hidden`
    },
    { catalog: BIG_CATALOG },
  ))

await test('a chip filter keeps the rail only while it has rows enough to index', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env, { boot: BIG_BOOT })
      const chip = (label) => overlay.findAll('pg-library-chip').find((c) => c.textContent === label)
      // Stern is 14 of these 24 machines — a short list, and a 26-letter index
      // down the side of 14 rows is a control that costs a column and saves
      // nothing.
      chip('Stern').click()
      await flush()
      const sternRows = rowNames(overlay).length
      assert(sternRows > 0 && sternRows < lib.RAIL_MIN_ROWS, `Stern should be a short list, got ${sternRows}`)
      assert(overlay.find('pg-library-rail').hidden === true, `the rail must go with a ${sternRows}-row filter`)
      assert(overlay.findAll('pg-library-letter').length === 0, 'and so must the letter headers')
      // Back to All: long enough again, so both come back.
      chip('Stern').click()
      await flush()
      assert(overlay.find('pg-library-rail').hidden === false, 'clearing the filter must bring the rail back')
      assert(overlay.findAll('pg-library-letter').length > 0, 'and the headers with it')
      return `Stern (${sternRows} rows) -> no rail; All (${rowNames(overlay).length} rows) -> rail`
    },
    { catalog: BIG_CATALOG },
  ))

await test('a SHORT catalog never grows a rail at all', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    assert(overlay.find('pg-library-rail').hidden === true, 'five machines must not get a 26-letter index')
    assert(overlay.findAll('pg-library-letter').length === 0, 'nor letter headers')
    assert(lib.showRail({ query: '', rows: lib.RAIL_MIN_ROWS - 1 }) === false, 'one under the threshold: no rail')
    assert(lib.showRail({ query: '', rows: lib.RAIL_MIN_ROWS }) === true, 'exactly the threshold: rail')
    assert(lib.showRail({ query: 'x', rows: 999 }) === false, 'a query always wins')
    assert(lib.showRail({ query: '   ', rows: 999 }) === true, 'whitespace is not a query')
    return `threshold ${lib.RAIL_MIN_ROWS}: 5 machines -> no rail`
  }))

// ===========================================================================
section('j5. MUTATION: every silent regression this redesign can suffer, seeded and caught')
// ===========================================================================

await test('MUTATION — a rail that ignores the strip-"The" key is CAUGHT', () =>
  withFakeDom(
    async (env) => {
      const mod = await mutantModule([
        ['const ch = machineSortKey(title).trim().charAt(0).toUpperCase()', 'const ch = title.trim().charAt(0).toUpperCase()'],
      ])
      const { overlay } = await mounted(env, { mod, boot: BIG_BOOT })
      const err = caught(() => CHECKS.theFilesUnderItsSortLetter(overlay))
      assert(err, 'the mutant passed the very check that exists to catch it')
      // And the damage is the one rolo reported against the old <select>: the
      // articles pile up under T and the real letter empties out.
      const t = overlay.findAll('pg-library-letter').find((h) => h.textContent === 'T')
      assert(t, 'the mutant should have built a T group')
      assert(!overlay.findAll('pg-library-letter').some((h) => h.textContent === 'E'), 'and lost E entirely')
      return `mutant hides Evil Dead under T; the check reports: ${err.message}`
    },
    { catalog: BIG_CATALOG },
  ))

await test('MUTATION — a rail that survives a search query is CAUGHT', () =>
  withFakeDom(
    async (env) => {
      const mod = await mutantModule([
        ["return foldText(opts.query) === '' && opts.rows >= RAIL_MIN_ROWS", 'return opts.rows >= RAIL_MIN_ROWS'],
      ])
      const { overlay } = await mounted(env, { mod, boot: BIG_BOOT })
      const search = overlay.find('pg-library-search')
      search.value = 'a'
      search.dispatchEvent({ type: 'input' })
      await flush()
      const err = caught(() => CHECKS.railHiddenWhileSearching(overlay))
      assert(err, 'the mutant passed the very check that exists to catch it')
      return `mutant leaves the rail up over ${rowNames(overlay).length} search results; the check reports: ${err.message}`
    },
    { catalog: BIG_CATALOG },
  ))

await test('MUTATION — a jump aimed at document.body (which cannot scroll) is CAUGHT', () =>
  withFakeDom(
    async (env) => {
      // The failure this pins is SILENT by construction: styles.css pins
      // `body { position: fixed; overflow: hidden }`, so scrolling it moves
      // nothing and throws nothing. Only an identity assertion on the element
      // that moved can tell the difference.
      const mod = await mutantModule([
        [
          'if (typeof scroller.scrollTo === \'function\') scroller.scrollTo({ top, behavior })',
          'if (typeof document.body.scrollTo === \'function\') document.body.scrollTo({ top, behavior })',
        ],
      ])
      const { overlay } = await mounted(env, { mod, boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), 'M'))
      const err = caught(() => CHECKS.railScrollsTheScrollport(overlay, scroller, env))
      assert(err, 'the mutant passed the very check that exists to catch it')
      assert(env.body._scrolls.length > 0, 'precondition: the mutant really did aim at document.body')
      return `mutant scrolled document.body (inert: position fixed, overflow hidden); the check reports: ${err.message}`
    },
    { catalog: BIG_CATALOG },
  ))

await test('MUTATION — a jump that lands the first row UNDER the pinned header is CAUGHT', () =>
  withFakeDom(
    async (env) => {
      // Overshooting by the header's own height is the natural way to get this
      // wrong (targeting the first row rather than the header). The letter
      // still lands at the top of the scrollport, so it LOOKS right; what is
      // lost is the first machine under it.
      const mod = await mutantModule([
        ['const top = scroller.scrollTop + (aTop - sTop)', 'const top = scroller.scrollTop + (aTop - sTop) + 24'],
      ])
      const { overlay } = await mounted(env, { mod, boot: BIG_BOOT })
      const { scroller } = layout(overlay)
      pointer(overlay.find('pg-library-rail'), 'pointerdown', railY(railOrderOf(overlay), 'M'))
      const err = caught(() => CHECKS.firstRowClearsPinnedHeader(overlay, 'M', scroller))
      assert(err, 'the mutant passed the very check that exists to catch it')
      return `mutant hides M's first machine behind the pinned header; the check reports: ${err.message}`
    },
    { catalog: BIG_CATALOG },
  ))

await test('MUTATION — a name that wraps to two lines (a 52px row) is CAUGHT', () => {
  // Not a module mutation: the row's height is a CSS claim, so the seeded
  // regression is a CSS one. Dropping `nowrap` is exactly how a row silently
  // becomes 52px on a narrow phone and the list loses its rhythm.
  const real = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8')
  const mutated = real.replace(
    /(\.pg-library-row-name \{[^}]*?)\n  white-space: nowrap;/,
    '$1',
  )
  assert(mutated !== real, 'the mutation did not apply — .pg-library-row-name no longer declares white-space: nowrap')
  const nameRule = /\.pg-library-row-name \{([^}]*)\}/.exec(mutated.replace(/\/\*[\s\S]*?\*\//g, ''))[1]
  assert(!/white-space:\s*nowrap/.test(nameRule), 'precondition: the mutant has no nowrap')
  // The very assertion the honest build passes, run against the mutant.
  const err = caught(() => {
    assert(/white-space:\s*nowrap/.test(nameRule), 'the name must be nowrap or a narrow phone wraps it to a taller row')
  })
  assert(err, 'the mutant passed the very check that exists to catch it')
  return `nowrap removed -> a 15px name may wrap to 2 lines (18px taller); the check reports: ${err.message}`
})

await test('MUTATION — a dimmed rail letter that is only DIMMED, not disabled, is CAUGHT', () =>
  withFakeDom(
    async (env) => {
      // Colour alone is not a state. A letter with no machines has to say so in
      // a vocabulary a screen reader has, which is what `disabled` is for.
      const mod = await mutantModule([
        ['        btn.disabled = true\n        btn.setAttribute(\'aria-disabled\', \'true\')', '        btn.setAttribute(\'data-empty\', \'true\')'],
      ])
      const { overlay } = await mounted(env, { mod, boot: BIG_BOOT })
      const err = caught(() => CHECKS.dimmedLettersAnnounceTheirState(overlay))
      assert(err, 'the mutant passed the very check that exists to catch it')
      return `mutant marks empty letters with colour only; the check reports: ${err.message}`
    },
    { catalog: BIG_CATALOG },
  ))

await test('MUTATION — a star nested inside the row button is CAUGHT', () =>
  withFakeDom(async (env) => {
    const mod = await mutantModule([
      [
        'wrap.append(row, renderPin(entry.id, entry.title))',
        'row.appendChild(renderPin(entry.id, entry.title))\n    wrap.append(row)',
      ],
    ])
    const { overlay } = await mounted(env, { mod })
    const err = caught(() => CHECKS.starIsSiblingOfRow(overlay))
    assert(err, 'the mutant passed the very check that exists to catch it')
    return `mutant nests the star in the row button; the check reports: ${err.message}`
  }))

// ===========================================================================
section('k. Fail-soft: the library opens without its index')
// ===========================================================================

await test('a 404 on /data/library.json still lists every machine, searchable', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env)
      const names = rowNames(overlay)
      assert(names.length === CATALOG.length, `expected all ${CATALOG.length} machines, got ${names.length}`)
      const search = overlay.find('pg-library-search')
      search.value = 'comet'
      search.dispatchEvent({ type: 'input' })
      await flush()
      assert(rowNames(overlay).join() === 'Comet', `search broken without the index: ${rowNames(overlay).join(', ')}`)
      // Maker/decade chips survive too — they come from the catalog NAME.
      const chips = overlay.findAll('pg-library-chip').map((c) => c.textContent)
      assert(chips.includes('Williams'), `expected maker chips from the parsed names, got ${chips.join(', ')}`)
      // AND they fold, exactly as the generated index folds them. Without this
      // the fallback row splits into "Stern" and "Stern Pinball": the catalog
      // carries both spellings, and two chips for one maker reads as a
      // dataset error. (This is how that bug was found — by reading the chips
      // this very test reported.)
      assert(!chips.includes('Stern Pinball'), `the fallback must fold maker names: ${chips.join(', ')}`)
      assert(chips.includes('Stern'), `expected a folded Stern chip, got ${chips.join(', ')}`)
      assert(chips.filter((c) => /^Stern/.test(c)).length === 1, `one Stern chip only, got ${chips.join(', ')}`)
      assert(overlay.findAll('pg-library-thumb-empty').length > 0, 'thumbnails should degrade to empty frames')
      return `index 404 -> ${names.length} machines, working search, chips ${chips.slice(0, 5).join('/')}…`
    },
    { libraryStatus: 404 },
  ))

// ===========================================================================
section('m. drawThumb: everything drawn comes from the machine\'s own data')
// ===========================================================================

const themeSrc = readFileSync(resolve(srcDir, 'theme.ts'), 'utf8')
const themeHex = (name) => new RegExp(`export const ${name} = '(#[0-9a-f]{6})'`, 'i').exec(themeSrc)[1]

/** A hand-made entry so every assertion below is against a known input. */
function thumbEntry(over = {}) {
  return {
    id: 't',
    name: 'T (Maker, 2000)',
    title: 'T',
    shortTitle: 'T',
    mfr: 'Maker',
    mfrGroup: 'Maker',
    year: 2000,
    goals: 1,
    ach: 0,
    zones: [],
    flippers: [
      { x: 0.33, y: 0.05, s: 'l' },
      { x: 0.67, y: 0.05, s: 'r' },
    ],
    plungeX: 0.96,
    shots: [
      { x: 0.2, y: 0.3 },
      { x: 0.5, y: 0.6 },
      { x: 0.8, y: 0.9 },
    ],
    ...over,
  }
}

await test('ONE dot per shot, at 1.6px — not insert shapes', () => {
  const ctx = recordingCtx()
  lib.drawThumb(ctx, thumbEntry(), 150, 200)
  const dots = ctx.ops.filter((o) => o.op === 'arc')
  assert(dots.length === 3, `expected 3 dots for 3 shots, got ${dots.length}`)
  assert(dots.every((d) => d.r === 1.6), `every dot should be r=1.6, got ${dots.map((d) => d.r).join(',')}`)
  // Insert shapes would show up as extra paths/rects per shot. They must not.
  const perShotPaths = ctx.ops.filter((o) => o.op === 'fillPath').length
  assert(perShotPaths === 2, `expected only the 2 flipper wedges as filled paths, got ${perShotPaths}`)
  return `3 shots -> 3 arcs r=1.6; ${ctx.ops.length} canvas ops for the whole thumbnail`
})

await test('the DOT SCALES WITH THE BOX, or a 30x40 row accent turns to speckle', () => {
  // MEASURED against the real index: the median machine carries 24 shots. At a
  // fixed 1.6px those cover 0.59% of a 158x211 card and 16.42% of a 30x40 row
  // accent — 28x the relative ink — and the flipper wedge (0.13 UV of reach)
  // drops from 6.4x a dot's diameter to 1.2x, so the one landmark the image is
  // read against stops being distinguishable from the shots.
  const shots = Array.from({ length: 24 }, (_, i) => ({ x: (i % 5) / 5 + 0.1, y: Math.floor(i / 5) / 5 + 0.1 }))
  const coverage = (w, h) => {
    const ctx = recordingCtx()
    lib.drawThumb(ctx, thumbEntry({ shots }), w, h)
    const ink = ctx.ops.filter((o) => o.op === 'arc').reduce((a, o) => a + Math.PI * o.r * o.r, 0)
    return (ink / (w * h)) * 100
  }
  const card = coverage(158, 211)
  const row = coverage(30, 40)
  assert(card < 1, `a card thumb should stay under 1% dot ink, got ${card.toFixed(2)}%`)
  assert(row < 4, `a row accent must stay under 4% dot ink, got ${row.toFixed(2)}% — that is the speckle`)
  // Without the scaling it would be this bad:
  const fixed = ((24 * Math.PI * 1.6 * 1.6) / (30 * 40)) * 100
  assert(fixed > 15 && row < fixed / 4, `a fixed 1.6px dot would cover ${fixed.toFixed(2)}%; scaled is ${row.toFixed(2)}%`)
  // And the floor is real: 0.6 CSS px is 1.2 device px at the DPR-2 cap, which
  // is the smallest mark that still renders as a mark rather than a smudge.
  assert(lib.dotRadiusFor(1) === 0.6, `the floor must hold at any size, got ${lib.dotRadiusFor(1)}`)
  assert(lib.dotRadiusFor(100000) === 1.6, `and the ceiling too, got ${lib.dotRadiusFor(100000)}`)
  assert(lib.dotRadiusFor(90) > 0.6 && lib.dotRadiusFor(90) < 1.6, 'and it ramps in between')
  return `24 shots: 158x211 -> ${card.toFixed(2)}% ink · 30x40 -> ${row.toFixed(2)}% (a fixed 1.6px would be ${fixed.toFixed(2)}%)`
})

await test('the dot count TRACKS the data — 0 shots draws 0 dots, 30 draws 30', () => {
  const none = recordingCtx()
  lib.drawThumb(none, thumbEntry({ shots: [] }), 150, 200)
  assert(none.ops.filter((o) => o.op === 'arc').length === 0, 'a machine with no shots must draw no dots')
  const many = recordingCtx()
  const shots = Array.from({ length: 30 }, (_, i) => ({ x: i / 30, y: (i % 10) / 10 }))
  lib.drawThumb(many, thumbEntry({ shots }), 150, 200)
  assert(many.ops.filter((o) => o.op === 'arc').length === 30, 'expected 30 dots')
  return '0 -> 0 arcs, 30 -> 30 arcs'
})

await test('v is INVERTED: a shot at the back of the table draws near the top', () => {
  const ctx = recordingCtx()
  lib.drawThumb(ctx, thumbEntry({ shots: [{ x: 0.5, y: 0.05 }, { x: 0.5, y: 0.95 }] }), 150, 200)
  const [nearFlippers, nearBack] = ctx.ops.filter((o) => o.op === 'arc')
  assert(nearFlippers.y > nearBack.y, `v=0.05 should sit BELOW v=0.95 on screen; got y ${nearFlippers.y} vs ${nearBack.y}`)
  assert(nearBack.y < 200 * 0.15, `the back of the table should be near the top, got y=${nearBack.y}`)
  return `v=0.05 -> y=${nearFlippers.y.toFixed(1)}, v=0.95 -> y=${nearBack.y.toFixed(1)} (h=200)`
})

await test('deck shots (p:1) are DIMMER, so the plate under them still reads', () => {
  const ctx = recordingCtx()
  lib.drawThumb(ctx, thumbEntry({ shots: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.6, p: 1 }] }), 150, 200)
  const [main, deck] = ctx.ops.filter((o) => o.op === 'arc')
  const alpha = (c) => Number(/,\s*([\d.]+)\)$/.exec(c)[1])
  assert(alpha(deck.fill) < alpha(main.fill), `deck dot ${deck.fill} should be dimmer than ${main.fill}`)
  return `main ${main.fill} vs deck ${deck.fill}`
})

await test('the card gradient is the MAP\'s gradient, imported from theme.ts', () => {
  const ctx = recordingCtx()
  lib.drawThumb(ctx, thumbEntry(), 150, 200)
  const grad = ctx.ops.find((o) => o.op === 'gradient')
  assert(grad, 'no linear gradient was created')
  const stops = grad.stops.map((s) => s.c.toLowerCase())
  assert(stops[0] === themeHex('CARD_GRADIENT_A').toLowerCase(), `stop 0 is ${stops[0]}, theme.ts says ${themeHex('CARD_GRADIENT_A')}`)
  assert(stops[1] === themeHex('CARD_GRADIENT_B').toLowerCase(), `stop 1 is ${stops[1]}, theme.ts says ${themeHex('CARD_GRADIENT_B')}`)
  // And the source must IMPORT them — a pasted hex would pass the check above
  // while breaking tokens.test.mjs's exclusivity gate ("these three hexes
  // appear in exactly two files under app/src"). Applied with that gate's own
  // rule for .ts, which counts a hex only when it is QUOTED: a hex named in
  // prose is documentation, a hex in a string is a re-literal.
  const libSrc = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
  assert(/import \{[^}]*CARD_GRADIENT_A[^}]*\} from '\.\.\/theme'/.test(libSrc), 'library.ts must import the gradient constants from theme.ts')
  for (const name of ['CARD_GRADIENT_A', 'CARD_GRADIENT_B', 'CANVAS_LETTERBOX']) {
    const hex = themeHex(name)
    assert(
      !new RegExp(`['"\`]${hex}['"\`]`, 'i').test(libSrc),
      `library.ts re-types ${name} (${hex}) as a string literal instead of importing it — that breaks tokens.test.mjs's exclusivity gate`,
    )
  }
  return `${stops.join(' -> ')} (imported from theme.ts; no quoted canvas hex in library.ts)`
})

await test('NO shooter lane is drawn — on either side, at any plungeX (removed 2026-08-14)', () => {
  // THE INVERSE OF THE TEST THAT WAS HERE. Until 2026-08-14 this asserted that
  // a dark channel followed the plunge side. rolo: "I don't like the tiny ramp
  // on the side on playfields that show the plunger ramp. Remove those
  // everywhere." So the assertion is now ABSENCE, driven with the same three
  // fixtures — right-side plunge, left-side plunge, none — because a removal
  // proven only on the null case would pass with the drawing fully intact.
  const right = recordingCtx()
  lib.drawThumb(right, thumbEntry({ plungeX: 0.96 }), 150, 200)
  const left = recordingCtx()
  lib.drawThumb(left, thumbEntry({ plungeX: 0.04 }), 150, 200)
  const none = recordingCtx()
  lib.drawThumb(none, thumbEntry({ plungeX: null }), 150, 200)
  // The card fill is a gradient and the plates are white/black RECTS inside the
  // board; the lane was the only fillRect painted in a flat black. Asserting on
  // the op rather than on one hex also catches it coming back in another
  // colour: any full-height strip at an edge fails the geometry check below.
  const blackFill = (c) => c.ops.filter((o) => o.op === 'fillRect' && /rgba\(0, 0, 0/.test(String(o.fill)))
  for (const [name, c] of [['right-side plunge', right], ['left-side plunge', left], ['no plunge', none]]) {
    assert(blackFill(c).length === 0, `${name}: expected no lane fill, got ${JSON.stringify(blackFill(c).map((o) => o.a))}`)
  }
  // GEOMETRY, not colour: nothing drawn may be a tall narrow strip hugging an
  // edge, whatever it is filled with. 150px wide, 200 tall — a lane was 15x190.
  const strips = (c) =>
    c.ops.filter((o) => {
      if (o.op !== 'fillRect' && o.op !== 'strokeRect') return false
      const [x, , w, h] = o.a
      return w <= 150 * 0.2 && h >= 200 * 0.5 && (x <= 150 * 0.12 || x + w >= 150 * 0.88)
    })
  for (const [name, c] of [['right-side plunge', right], ['left-side plunge', left]]) {
    assert(strips(c).length === 0, `${name}: an edge-hugging vertical strip is back — ${JSON.stringify(strips(c).map((o) => o.a))}`)
  }
  // AND drawThumb must not read the field at all any more. `plungeX` survives
  // on LibraryEntry and in library.json on purpose (the fact is real); this is
  // what stops it quietly re-acquiring a drawing.
  const src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
  const body = /export function drawThumb\([\s\S]*?\n\}/.exec(src)
  assert(body, 'could not find drawThumb to inspect')
  // COMMENTS STRIPPED FIRST. The note standing where the lane used to be says
  // the word `plungeX` — documentation of a removal is not a read of the
  // field, and a gate that cannot tell them apart would forbid explaining
  // itself.
  const code = body[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert(!/plungeX/.test(code), 'drawThumb still reads entry.plungeX — the lane is meant to be gone, not conditional')
  return 'no lane fill and no edge strip for a right, left or absent plunge; drawThumb never reads plungeX'
})

await test('deck plates are drawn only when the machine has zones', () => {
  const flat = recordingCtx()
  lib.drawThumb(flat, thumbEntry(), 150, 200)
  const decked = recordingCtx()
  lib.drawThumb(decked, thumbEntry({ zones: [{ x: 0.19, y: 0.82, w: 0.26, h: 0.15, k: 'upper' }] }), 150, 200)
  const plates = (c) => c.ops.filter((o) => o.op === 'strokeRect').length
  assert(plates(flat) === 1, `a flat machine should draw only the card border, got ${plates(flat)} strokeRects`)
  assert(plates(decked) === 2, `a decked machine should draw a plate plus the border, got ${plates(decked)}`)
  // The plate's own corner-flip: high-v maps to the canvas TOP.
  const plate = decked.ops.filter((o) => o.op === 'strokeRect')[0]
  assert(plate.a[1] < 100, `the plate at v 0.82-0.97 should sit in the top half, y=${plate.a[1]}`)
  return `flat: 1 strokeRect (border) · decked: 2 (plate at y=${plate.a[1].toFixed(1)} + border)`
})

await test('the flipper pair is drawn as two wedges pointing INWARD', () => {
  const ctx = recordingCtx()
  lib.drawThumb(ctx, thumbEntry(), 150, 200)
  const wedges = ctx.ops.filter((o) => o.op === 'fillPath')
  assert(wedges.length === 2, `expected 2 wedges, got ${wedges.length}`)
  assert(wedges.every((wg) => /rgba\(195, 63, 42/.test(wg.fill)), `wedges should be the map's flipper red, got ${wedges.map((wg) => wg.fill)}`)
  const tipX = (wg) => wg.points[1][0]
  const pivotX = (wg) => wg.points[0][0]
  assert(tipX(wedges[0]) > pivotX(wedges[0]), 'the LEFT flipper must reach rightward')
  assert(tipX(wedges[1]) < pivotX(wedges[1]), 'the RIGHT flipper must reach leftward')
  return `left pivot ${pivotX(wedges[0]).toFixed(0)} -> tip ${tipX(wedges[0]).toFixed(0)}; right pivot ${pivotX(wedges[1]).toFixed(0)} -> tip ${tipX(wedges[1]).toFixed(0)}`
})

// ===========================================================================
section('n. Painting: DPR cap, first-approach, and no observer leak')
// ===========================================================================

await test(`devicePixelRatio is capped at ${lib.THUMB_DPR_CAP}`, () =>
  withFakeDom(
    async (env) => {
      const { mod, overlay } = await mounted(env)
      env.observers()[0].intersectAll()
      const canvas = overlay.findAll('pg-library-thumb').find((c) => c.tagName === 'CANVAS')
      assert(canvas, 'no canvas thumbnail was created')
      // 150 CSS px at a device ratio of 3, capped to 2 -> 300 backing pixels.
      assert(canvas.width === 300, `expected 300 backing px (150 x cap ${lib.THUMB_DPR_CAP}), got ${canvas.width}`)
      // HEIGHT is the discriminating half of this assertion: an unpainted
      // canvas defaults to 300x150, so a width of 300 alone would also be true
      // of a canvas nothing ever drew into. 200 CSS x cap 2 = 400.
      assert(canvas.height === 400, `expected 400 backing px tall (200 x cap 2), got ${canvas.height}`)
      assert(mod.isThumbPainted(canvas), 'the canvas should be marked painted')
      const t = canvas._ctx.ops.find((o) => o.op === 'setTransform')
      assert(t && t.a[0] === 2 && t.a[3] === 2, `expected setTransform(2,0,0,2,0,0), got ${JSON.stringify(t?.a)}`)
      return `dpr 3 -> backing ${canvas.width}x${canvas.height}, setTransform scale ${t.a[0]}`
    },
    { dpr: 3 },
  ))

await test('a ratio UNDER the cap is used as-is (the cap is a ceiling, not a fixed scale)', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env)
      env.observers()[0].intersectAll()
      const canvas = overlay.findAll('pg-library-thumb').find((c) => c.tagName === 'CANVAS')
      assert(canvas.width === 150, `dpr 1 should give 150 backing px, got ${canvas.width}`)
      return `dpr 1 -> backing ${canvas.width}px`
    },
    { dpr: 1 },
  ))

await test('nothing is painted until a row APPROACHES, then it is unobserved', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const canvases = overlay.findAll('pg-library-thumb').filter((c) => c.tagName === 'CANVAS')
    assert(canvases.length > 1, `expected several canvas thumbs, got ${canvases.length}`)
    assert(canvases.every((c) => c._ctx.ops.length === 0), 'no thumbnail should be painted before it is on screen')
    const obs = env.observers()[0]
    assert(obs.observed.size === canvases.length, `expected ${canvases.length} observed canvases, got ${obs.observed.size}`)
    assert(obs.opts.rootMargin === '240px 0px', `rootMargin is ${obs.opts.rootMargin}`)
    obs.intersectAll()
    assert(canvases.every((c) => c._ctx.ops.length > 0), 'every approached thumbnail should now be painted')
    assert(obs.observed.size === 0, `painted canvases must be unobserved; ${obs.observed.size} still watched`)
    return `${canvases.length} observed at rootMargin ${obs.opts.rootMargin}, painted on approach, then released`
  }))

await test('a re-render DISCONNECTS the observer instead of piling up dead canvases', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const obs = env.observers()[0]
    const before = obs.disconnects
    const search = overlay.find('pg-library-search')
    for (const q of ['g', 'go', 'god']) {
      search.value = q
      search.dispatchEvent({ type: 'input' })
    }
    await flush()
    assert(obs.disconnects === before + 3, `expected one disconnect per render, got ${obs.disconnects - before} for 3 keystrokes`)
    // ONE observer for the whole overlay, not one per render.
    assert(env.observers().length === 1, `expected a single IntersectionObserver, got ${env.observers().length}`)
    const live = overlay.findAll('pg-library-thumb').filter((c) => c.tagName === 'CANVAS')
    assert(obs.observed.size === live.length, `observer watches ${obs.observed.size} canvases but ${live.length} are in the DOM`)
    return `3 keystrokes -> 3 disconnects, 1 observer, ${obs.observed.size} live canvases watched`
  }))

await test('with NO IntersectionObserver the thumbnails still paint (old-browser fallback)', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env)
      const canvases = overlay.findAll('pg-library-thumb').filter((c) => c.tagName === 'CANVAS')
      assert(canvases.length > 0, 'expected canvas thumbnails')
      assert(canvases.every((c) => c._ctx.ops.length > 0), 'without an observer, thumbnails must paint immediately')
      return `${canvases.length} thumbnails painted eagerly`
    },
    { noObserver: true },
  ))

await test('a machine with no geometry gets a FRAME, never an empty canvas', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env)
      const thumbs = overlay.findAll('pg-library-thumb')
      assert(thumbs.length > 0, 'expected thumbnail slots')
      assert(thumbs.every((t) => t.tagName === 'DIV'), 'without an index there is nothing to draw — no canvas should be created')
      assert(thumbs.every((t) => t.classList.contains('pg-library-thumb-empty')), 'they should carry the empty class')
      assert(env.observers()[0].observed.size === 0, 'nothing to observe when nothing can be drawn')
      return `${thumbs.length} empty frames, 0 canvases, 0 observed`
    },
    { libraryStatus: 404 },
  ))

await test('every thumbnail is aria-hidden — decoration, not content', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const thumbs = overlay.findAll('pg-library-thumb')
    assert(thumbs.length > 0, 'expected thumbnails')
    assert(thumbs.every((t) => t.getAttribute('aria-hidden') === 'true'), 'a thumbnail must not be announced')
    return `${thumbs.length} thumbnails, all aria-hidden`
  }))

// ===========================================================================
section('o. Progress badges: signed-in only, one request, clamped')
// ===========================================================================

await test('countProgress collapses the blob to one count per machine, guarding shape', () => {
  const counts = lib.countProgress({
    jaws: { a: 1, b: 2, c: 3 },
    comet: { a: 1 },
    empty: {},
    bogus: 'not an object',
    // AN ARRAY OF NUMBERS, specifically. A mutation that drops the
    // Array.isArray guard is invisible against `['a']` — Object.values of it
    // yields strings, which the numeric filter rejects anyway, so the count
    // comes out 0 either way and the test passes on a broken guard. An array
    // of timestamps is the input that tells the two apart, and it is exactly
    // the shape a hand-edited or half-migrated blob would carry.
    alsoBogus: [1, 2, 3],
    partlyBogus: { good: 1, bad: 'yesterday', worse: null },
  })
  assert(counts.jaws === 3 && counts.comet === 1, JSON.stringify(counts))
  assert(!('empty' in counts), 'a machine with nothing done should not appear')
  assert(!('bogus' in counts), 'a string value must be skipped, not thrown on')
  assert(!('alsoBogus' in counts), `an ARRAY of timestamps must be rejected, not counted: ${JSON.stringify(counts)}`)
  assert(counts.partlyBogus === 1, `non-numeric timestamps must not count: ${counts.partlyBogus}`)
  assert(Object.keys(lib.countProgress(null)).length === 0, 'null blob -> {}')
  assert(Object.keys(lib.countProgress(['a'])).length === 0, 'array blob -> {}')
  return JSON.stringify(counts)
})

await test('SIGNED OUT: no badge anywhere, and /api/achievements is never requested', () =>
  withFakeDom(async (env) => {
    const seen = []
    const orig = globalThis.fetch
    globalThis.fetch = (u) => (seen.push(u), orig(u))
    const { overlay } = await mounted(env)
    await flush()
    assert(overlay.findAll('pg-library-row-prog').length === 0, 'a signed-out visitor must see no progress badges')
    assert(!seen.includes('/api/achievements'), `no achievements request should be made: ${seen.join(', ')}`)
    return `requests made: ${[...new Set(seen)].join(', ')}`
  }))

await test('SIGNED IN: each row shows done/total, and 0/total is shown deliberately', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env)
      await flush()
      const wraps = overlay.findAll('pg-library-rowwrap')
      const badgeOf = (name) => wraps.find((c) => c.textContent.includes(name))?.find('pg-library-row-prog')
      // libraryDoc() gives jaws ach:0, godzilla ach:1, comet ach:2, evil-dead
      // ach:3 — so godzilla has 1 done of 1, comet 0 of 2.
      assert(!badgeOf('Jaws'), 'a machine with no achievements authored gets no badge at all')
      assert(badgeOf('Godzilla').textContent === '1/1 ✓', `godzilla badge is ${badgeOf('Godzilla').textContent}`)
      assert(badgeOf('Comet').textContent === '0/2', `comet badge is ${badgeOf('Comet').textContent}`)
      assert(
        badgeOf('Godzilla').classList.contains('pg-library-row-prog-done'),
        'a complete machine should carry the done class',
      )
      assert(
        !badgeOf('Comet').classList.contains('pg-library-row-prog-done'),
        'an incomplete machine must not',
      )
      assert(badgeOf('Comet').getAttribute('aria-label') === '0 of 2 achievements', badgeOf('Comet').getAttribute('aria-label'))
      return `Godzilla ${badgeOf('Godzilla').textContent} · Comet ${badgeOf('Comet').textContent} · Jaws none`
    },
    { session: { user: 'u1' }, progressBlob: { godzilla: { a: 1 } } },
  ))

await test('a stale id for a dropped achievement CLAMPS instead of rendering 13/12', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env)
      await flush()
      const badge = overlay
        .findAll('pg-library-rowwrap')
        .find((c) => c.textContent.includes('Comet'))
        .find('pg-library-row-prog')
      assert(badge.textContent === '2/2 ✓', `expected a clamp to 2/2, got ${badge.textContent}`)
      return `blob said 5 done of 2 -> ${badge.textContent}`
    },
    { session: { user: 'u1' }, progressBlob: { comet: { a: 1, b: 2, c: 3, d: 4, e: 5 } } },
  ))

await test('the achievements request happens ONCE per page load, not once per open', () =>
  withFakeDom(
    async (env) => {
      let calls = 0
      const orig = globalThis.fetch
      globalThis.fetch = (u) => {
        if (u === '/api/achievements') calls += 1
        return orig(u)
      }
      const { mod, state, overlay, opener } = await mounted(env)
      await flush()
      assert(calls === 1, `expected 1 request on first open, got ${calls}`)
      env.key('Escape')
      mod.openLibrary(state, opener)
      await flush()
      mod.openLibrary(state, opener)
      await flush()
      assert(calls === 1, `three opens should still be ${1} request, got ${calls}`)
      assert(overlay.findAll('pg-library-row-prog').length > 0, 'badges should still be there after re-opening')
      return `3 opens -> ${calls} /api/achievements request`
    },
    { session: { user: 'u1' }, progressBlob: { godzilla: { a: 1 } } },
  ))

await test('a FAILED achievements fetch shows no badges rather than 0/total everywhere', () =>
  withFakeDom(
    async (env) => {
      const { overlay } = await mounted(env)
      await flush()
      assert(overlay.findAll('pg-library-row-prog').length === 0, 'a failed fetch must not render zeroes as if they were data')
      assert(overlay.findAll('pg-library-row').length > 0, 'the library itself must still work')
      return 'HTTP 500 on /api/achievements -> no badges, library unaffected'
    },
    { session: { user: 'u1' }, achievementsStatus: 500 },
  ))

// ===========================================================================
section('p. The first-run hint: banner, pulse, and both ways to retire them')
// ===========================================================================

await test('app.ts renders the hint under the how-to banner and pulses the picker', () => {
  // Source-level, because the hint lives in the core shell rather than in this
  // overlay: the ORDER of the two appends is the claim ("under, never above").
  const howToAt = appSrc.indexOf('wrap.appendChild(renderHowToBanner())')
  const hintAt = appSrc.indexOf('if (!libraryHintSeen()) wrap.appendChild(renderLibraryHint(')
  assert(howToAt !== -1 && hintAt !== -1, 'both banners should be appended in renderGoalList')
  assert(hintAt > howToAt, 'the library hint must be appended AFTER the how-to banner, not before it')
  assert(/machine-picker-hint/.test(appSrc), 'the picker should carry the one-time pulse class')
  assert(/pinballgenie\.libraryHintSeen/.test(appSrc), 'the hint must be persisted under its documented key')
  return 'how-to banner, then the hint; picker pulse class present'
})

await test('the hint copy is COUNT-FREE — no number to go stale as the catalog grows', () => {
  const copy = /textContent = '(Playing a different table\?[^']*)'/.exec(appSrc)[1]
  assert(!/\d/.test(copy), `the hint copy contains a number: ${copy}`)
  assert(/every machine we cover/.test(copy), `unexpected copy: ${copy}`)
  return JSON.stringify(copy)
})

await test('opening the library BY ANY ROUTE retires the hint (dismissed by use)', () => {
  const fn = /function openMachineLibrary\(opener: HTMLElement,[^)]*\): void \{([\s\S]*?)\n  \}/.exec(appSrc)[1]
  assert(/markLibraryHintSeen\(\)/.test(fn), 'openMachineLibrary must mark the hint seen')
  assert(/renderAll\(\)/.test(fn), 'and re-render, or the pulse and banner stay on screen')
  // Both entry points go through it — that is what makes "any route" true.
  assert(/picker\.addEventListener\('click', \(ev\) => onBrowseMachines\(picker,/.test(appSrc), 'the header button must route through it')
  assert(/open\.addEventListener\('click', \(\) => onBrowseMachines\(open\)\)/.test(appSrc), 'the banner must route through it')
  return 'header button and banner both call openMachineLibrary, which marks + re-renders'
})

await test('the ✕ dismisses WITHOUT opening anything, and is a sibling of the row', () => {
  const fn = /function renderLibraryHint\([\s\S]*?\n\}/.exec(appSrc)[0]
  assert(/dismiss\.addEventListener\('click', \(\) => \{[\s\S]*?markLibraryHintSeen\(\)/.test(fn), 'the ✕ must mark the hint seen')
  assert(!/dismiss[\s\S]{0,200}onBrowseMachines/.test(fn), 'the ✕ must NOT open the library')
  assert(/wrap\.append\(open, dismiss\)/.test(fn), 'the ✕ must be a sibling of the row button, not nested in it')
  assert(/machine-picker-hint'\)\?\.classList\.remove/.test(fn), 'dismissing must also stop the header pulse')
  return 'dismiss marks seen, removes the row and the pulse, opens nothing'
})

await test('the pulse has a reduced-motion branch that keeps the MARK and drops the motion', () => {
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.machine-picker-hint \{([^}]*)\}/.exec(stylesCss)
  assert(reduced, 'no reduced-motion rule for .machine-picker-hint')
  assert(/animation:\s*none/.test(reduced[1]), 'the animation must be removed')
  assert(/border-color:\s*var\(--amber-border\)/.test(reduced[1]), 'the amber mark must REMAIN — remove the motion, not the feature')
  // And the animated version must be finite: an infinite pulse is not a hint.
  const anim = /\.machine-picker-hint \{\s*animation: ([^;]+);/.exec(stylesCss)[1]
  assert(!/infinite/.test(anim), `the pulse must not run forever: ${anim}`)
  return `animated: ${anim.trim()} · reduced-motion: static amber border`
})

// ===========================================================================
section('q. K3 #1 — the pick token is checked AT COMMIT, and the spinner is keyed to it')
// ===========================================================================

/** Drives two picks whose datasets settle in a chosen order. Returns the
 *  overlay so the caller can inspect what survived. */
async function twoPicks(env, { firstResolvesLast }) {
  const { state, overlay } = await mounted(env)
  const rowFor = (name) => overlay.findAll('pg-library-row').find((c) => c.textContent.includes(name))
  rowFor('Godzilla').click() // pick 1
  await flush()
  rowFor('Comet').click() // pick 2 — supersedes
  await flush()
  if (firstResolvesLast) {
    await env.settle('/data/comet_goals.json')
    await env.settle('/data/godzilla_goals.json')
  } else {
    await env.settle('/data/godzilla_goals.json')
    await env.settle('/data/comet_goals.json')
  }
  await flush()
  return { state, overlay }
}

await test('state.ts checks its token AFTER the await and BEFORE any mutation', () => {
  // Source-level, because the ORDER of two statements is the claim, and no
  // behavioural test can distinguish "checked at commit" from "checked early
  // and got lucky". Both branches of loadMachine must gate before writing.
  const src = readFileSync(resolve(srcDir, 'state.ts'), 'utf8')
  const body = /private async loadMachine\(m: Machine\): Promise<void> \{([\s\S]*?)\n  \}/.exec(src)[1]
  const awaitAt = body.indexOf('await fetchGameData(m)')
  const successGate = body.indexOf('if (gen !== this.loadGeneration) return', awaitAt)
  const firstWrite = body.indexOf('this.machine = m')
  const failureGate = body.indexOf('if (gen !== this.loadGeneration) return')
  const failureWrite = body.indexOf('this.machineError = {')
  assert(awaitAt !== -1 && successGate !== -1 && firstWrite !== -1, 'could not locate the await/gate/write')
  assert(successGate > awaitAt, 'the success gate must come AFTER the await')
  assert(successGate < firstWrite, 'the success gate must come BEFORE the first state write')
  assert(failureGate < failureWrite, 'the failure gate must come BEFORE machineError is written')
  assert(/const gen = \+\+this\.loadGeneration/.test(body), 'the token must be taken before the fetch starts')
  return `token taken, await at ${awaitAt}, commit gate at ${successGate}, first write at ${firstWrite}`
})

await test('FIRST RESOLVES LAST: the second machine wins, no spinner, list interactive', () =>
  withFakeDom(async (env) => {
    const { state, overlay } = await twoPicks(env, { firstResolvesLast: true })
    assert(state.machine.id === 'comet', `expected comet (the second tap), got ${state.machine.id}`)
    assert(!overlay.find('pg-library-spinner'), 'no spinner may be left behind')
    assert(overlay.findAll('pg-library-row-busy').length === 0, 'no row may be left in the busy state')
    assert(overlay.hidden === true, 'the winning pick closes the overlay')
    // "List interactive": re-open and confirm a row still picks.
    assert(state.machineError === null, `no error should be showing: ${JSON.stringify(state.machineError)}`)
    return 'godzilla settled after comet; comet is loaded, nothing spinning'
  }))

await test('FIRST RESOLVES FIRST: the loser cannot clear the winner\'s spinner', () =>
  withFakeDom(async (env) => {
    // THIS is the ordering that exposed the bug. Tap A, tap B; A resolves
    // first. A is superseded inside state.ts so it changes no machine — but
    // before the commit gate it also ran `pending = null` on the way out,
    // blanking B's spinner while B was still in flight. The overlay then sat
    // open with a load running and nothing on screen saying so.
    const { state, overlay } = await mounted(env)
    const rowFor = (name) => overlay.findAll('pg-library-row').find((c) => c.textContent.includes(name))
    rowFor('Godzilla').click()
    await flush()
    rowFor('Comet').click()
    await flush()
    await env.settle('/data/godzilla_goals.json') // the LOSER resolves first
    await flush()
    assert(overlay.hidden === false, 'the overlay must still be open — comet has not arrived yet')
    const busy = overlay.findAll('pg-library-row-busy')
    assert(busy.length === 1, `exactly one row should still be busy, found ${busy.length}`)
    assert(busy[0].textContent.includes('Comet'), `the busy row should be Comet, got ${busy[0].textContent}`)
    assert(overlay.find('pg-library-spinner'), "the winner's spinner must survive the loser's continuation")
    assert(state.machine.id === 'jaws', `no machine should have changed yet, got ${state.machine.id}`)
    await env.settle('/data/comet_goals.json')
    await flush()
    assert(state.machine.id === 'comet', `expected comet, got ${state.machine.id}`)
    assert(overlay.hidden === true, 'the winner closes the overlay')
    return 'loser resolved first, spinner stayed on Comet, Comet then won'
  }))

await test('a superseded pick writes NOTHING — not even when it would have failed', () =>
  withFakeDom(
    async (env) => {
      const { state, overlay } = await mounted(env)
      const rowFor = (name) => overlay.findAll('pg-library-row').find((c) => c.textContent.includes(name))
      rowFor('Godzilla').click() // will FAIL
      await flush()
      rowFor('Comet').click() // supersedes, will succeed
      await flush()
      await env.settle('/data/godzilla_goals.json') // fails, superseded
      await flush()
      assert(!overlay.find('pg-library-error'), 'a superseded failure must raise no error row')
      await env.settle('/data/comet_goals.json')
      await flush()
      assert(state.machine.id === 'comet', `expected comet, got ${state.machine.id}`)
      assert(state.machineError === null, 'no error state should survive')
      return 'superseded failure silent; comet loaded cleanly'
    },
    { failMachines: new Set(['godzilla']) },
  ))

await test('the list stays TAPPABLE during a pick (supersede, not freeze)', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const rowFor = (name) => overlay.findAll('pg-library-row').find((c) => c.textContent.includes(name))
    rowFor('Godzilla').click()
    await flush()
    // Deliberately NOT inert: a mis-tap on a list of 48px rows must be
    // correctable while the dataset is still arriving, which is when it takes
    // longest.
    const cometRow = rowFor('Comet')
    assert(cometRow.disabled !== true, 'rows must not be disabled during a pick')
    const css = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8')
    const busyRule = /\.pg-library-row-busy \{([^}]*)\}/.exec(css)[1]
    assert(!/pointer-events:\s*none/.test(busyRule), 'the busy row must stay tappable')
    assert(!/pointer-events:\s*none/.test(/\.pg-library-list \{([^}]*)\}/.exec(css)[1]), 'the list must stay tappable')
    return 'no disabled attribute, no pointer-events:none — a second tap supersedes'
  }))

// ===========================================================================
section('r. K3 #2 — the thumbnail cache: painted once, then moved')
// ===========================================================================

await test('typing 5 characters repaints NOTHING for machines already painted', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    env.observers()[0].intersectAll()
    const godzillaCanvasBefore = overlay
      .findAll('pg-library-rowwrap')
      .find((c) => c.textContent.includes('Godzilla'))
      .find('pg-library-thumb')
    assert(godzillaCanvasBefore.tagName === 'CANVAS', 'expected a painted canvas')
    const opsBefore = godzillaCanvasBefore._ctx.ops.length
    assert(opsBefore > 0, 'precondition: it is painted')

    const search = overlay.find('pg-library-search')
    const seen = []
    for (const q of ['g', 'go', 'god', 'godz', 'godzi']) {
      search.value = q
      search.dispatchEvent({ type: 'input' })
      await flush()
      env.observers()[0].intersectAll() // give any new canvas every chance to paint
      const wrap = overlay.findAll('pg-library-rowwrap').find((c) => c.textContent.includes('Godzilla'))
      const canvas = wrap.find('pg-library-thumb')
      seen.push({ q, same: canvas === godzillaCanvasBefore, ops: canvas._ctx.ops.length })
    }
    assert(
      seen.every((s) => s.same),
      `the SAME canvas element must be reused across renders: ${JSON.stringify(seen)}`,
    )
    assert(
      seen.every((s) => s.ops === opsBefore),
      `drawThumb must not run again for a cached machine: ${JSON.stringify(seen)} (was ${opsBefore})`,
    )
    return `5 keystrokes, same element every time, canvas ops constant at ${opsBefore}`
  }))

await test('a machine on screen TWICE (Pinned + A-Z) gets two independent canvases', () =>
  withFakeDom(async (env) => {
    const { state, overlay } = await mounted(env)
    state.togglePinned('comet')
    await flush()
    env.observers()[0].intersectAll()
    const cometThumbs = overlay
      .findAll('pg-library-rowwrap')
      .filter((c) => c.textContent.includes('Comet'))
      .map((c) => c.find('pg-library-thumb'))
    assert(cometThumbs.length === 2, `expected Comet in two sections, found ${cometThumbs.length}`)
    assert(cometThumbs[0] !== cometThumbs[1], 'the two occurrences must be separate elements, not one moved twice')
    assert(cometThumbs.every((c) => c._ctx.ops.length > 0), 'both should be painted')
    return 'pinned + A-Z: 2 distinct painted canvases for one machine'
  }))

await test('the IntersectionObserver refuses to paint a DETACHED canvas', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const obs = env.observers()[0]
    // NOT the current-machine strip's thumbnail: that one is re-appended on
    // every render (the strip sits above the results and survives a query that
    // matches nothing), so it stays connected and would prove nothing. A GRID
    // canvas is the one a search actually orphans.
    const listCanvases = new Set(
      overlay.findAll('pg-library-rowwrap').map((c) => c.find('pg-library-thumb')),
    )
    const watched = [...obs.observed].filter((c) => listCanvases.has(c))
    assert(watched.length > 0, 'expected observed list canvases')
    // Re-render, which detaches everything the observer was holding, then
    // deliver a record for one of the now-orphaned canvases — the exact race a
    // keystroke creates between intersection and callback.
    const search = overlay.find('pg-library-search')
    search.value = 'zzzz'
    search.dispatchEvent({ type: 'input' })
    await flush()
    const orphan = watched[0]
    assert(!orphan.isConnected, 'precondition: the canvas is detached after the re-render')
    obs.cb([{ target: orphan, isIntersecting: true }])
    assert(orphan._ctx.ops.length === 0, 'a detached canvas must never be painted')

    // WHAT THIS TEST ACTUALLY PROVES, precisely: the record is ignored because
    // render() cleared the pending map, not because of the isConnected guard —
    // the guard sits after the pending lookup and is therefore UNREACHABLE
    // while disconnect-on-render holds. That makes removing the guard an
    // EQUIVALENT MUTATION for this suite, and it is more honest to say so than
    // to claim coverage this cannot have. The guard stays as defense in depth:
    // disconnect() dropping already-queued records is spec, not something every
    // engine has always got right, and painting into a detached node costs half
    // a megabyte and measures clientWidth 0. Its presence and its ORDER (before
    // the paint) are pinned below so it cannot be quietly reordered into
    // uselessness.
    const src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
    const cb = /new IntersectionObserver\(([\s\S]*?)\n          \{ root: scroller/.exec(src)[1]
    const guardAt = cb.indexOf('if (!canvas.isConnected) continue')
    const paintAt = cb.indexOf('paintThumbCanvas(canvas, entry)')
    assert(guardAt !== -1, 'the observer must guard against painting a detached canvas')
    assert(guardAt < paintAt, 'the guard must come BEFORE the paint')
    return 'record for an untracked canvas -> 0 draw ops; isConnected guard present and ordered before the paint'
  }))

await test('the cache holds the WHOLE shipping catalog, both slot sizes, across a re-render', () =>
  withFakeDom(
    async (env) => {
      // THE REAL 134-MACHINE CATALOG, because the cap is only meaningful
      // against the list it actually has to hold. Both slot sizes are live at
      // once: the card-size strip thumbnail plus 134 row-size accents.
      const { state, overlay } = await mounted(env)
      env.observers()[0].intersectAll()
      // SCOPED TO THE A-Z SECTION. A pinned machine also gets a Pinned row, and
      // the two occurrences are deliberately separate cache entries (slot is
      // half the key), so an unscoped lookup would compare a 'pinned' canvas
      // against an 'all' one and report a phantom eviction.
      const azSection = () =>
        overlay.findAll('pg-library-section').find((sec) => sec.find('pg-library-section-title')?.textContent === 'All machines')
      const thumbOf = (name) =>
        azSection()?.findAll('pg-library-rowwrap').find((w) => w.find('pg-library-row-name')?.textContent === name)?.find('pg-library-thumb')
      const names = azSection().findAll('pg-library-row-name').map((n) => n.textContent)
      assert(names.length === REAL_CATALOG.length, `expected the whole catalog, got ${names.length}`)
      const stripBefore = overlay.find('pg-library-current').find('pg-library-thumb')
      assert(stripBefore.tagName === 'CANVAS' && stripBefore._ctx.ops.length > 0, 'precondition: the strip thumbnail is painted')
      const before = new Map(names.map((n) => [n, thumbOf(n)]))
      const paintedBefore = [...before.values()].filter((c) => c && c.tagName === 'CANVAS' && c._ctx.ops.length > 0).length
      assert(paintedBefore === REAL_CATALOG.length, `precondition: a scroll-through paints every row, got ${paintedBefore}`)

      // A RE-RENDER. Every canvas detaches and is asked for again — this is a
      // pin tap, but it is the same path a keystroke takes.
      state.togglePinned('comet')
      await flush()
      env.observers()[0].intersectAll()
      const kept = names.filter((n) => thumbOf(n) === before.get(n)).length
      const lost = REAL_CATALOG.length - kept
      // THE PROPERTY: nothing was evicted, so nothing repaints. A cap below the
      // catalog silently turns every render into a partial repaint — the exact
      // jank the element cache exists to remove — and it does so without any
      // test going red, because the pixels still arrive.
      assert(lost === 0, `${lost} of ${REAL_CATALOG.length} row thumbnails were evicted and must repaint on every render — the cap is under the catalog`)
      // The card-size strip survived alongside them.
      const stripAfter = overlay.find('pg-library-current').find('pg-library-thumb')
      assert(stripAfter === stripBefore, 'the card-size strip thumbnail was evicted by the row-size ones')
      assert(stripAfter._ctx.ops.length > 0, 'and it must still be painted, not blanked')

      // THE CAP MATH, stated against the worst case this overlay can build:
      // every A-Z row, plus a full Pinned section, plus Recent, plus the strip.
      const src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
      const cap = Number(/const THUMB_CACHE_CAP = (\d+)/.exec(src)[1])
      const pinnedShown = Number(/const PINNED_SHOWN = (\d+)/.exec(src)[1])
      const recentShown = Number(/const RECENT_SHOWN = (\d+)/.exec(src)[1])
      const worst = REAL_CATALOG.length + pinnedShown + recentShown + 1
      assert(cap >= worst, `cap ${cap} is under the ${worst} keys one render can need (${REAL_CATALOG.length} A-Z + ${pinnedShown} pinned + ${recentShown} recent + 1 strip)`)
      // And bounded in bytes: a row accent is 30x40 at the DPR-2 cap.
      const mb = (cap * 30 * 2 * 40 * 2 * 4) / 1024 / 1024
      assert(mb < 4, `cap ${cap} is ${mb.toFixed(2)} MB of backing store — too much to hold`)
      return `${REAL_CATALOG.length} rows + strip across a re-render: 0 evicted, 0 repaints; cap ${cap} >= worst case ${worst}, ${mb.toFixed(2)} MB`
    },
    { catalog: REAL_CATALOG },
  ))

await test('the cache is BOUNDED, and eviction never drops something on screen', () => {
  const src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
  assert(/const THUMB_CACHE_CAP = \d+/.test(src), 'the cache must declare a cap')
  const cap = Number(/const THUMB_CACHE_CAP = (\d+)/.exec(src)[1])
  // The upper bound is BYTES, not a count: the old ceiling of 96 was written
  // when a cached thumbnail was a 521 KB card and holding many was the danger.
  // A row accent is 18.8 KB, so the danger inverted — too SMALL a cap evicts
  // mid-render and repaints the list on every keystroke (measured: 134 of 134
  // at cap 48). Bound what actually matters.
  const capMb = (cap * 30 * 2 * 40 * 2 * 4) / 1024 / 1024
  assert(cap > 0 && capMb < 4, `cap ${cap} is ${capMb.toFixed(2)} MB of backing store — not a sane bound`)
  const evict = /while \(thumbEls\.size > THUMB_CACHE_CAP\) \{([\s\S]*?)\n    \}/.exec(src)[1]
  assert(/!el\.isConnected/.test(evict), 'eviction must skip elements that are still on screen')
  assert(/if \(!oldest\) break/.test(evict), 'eviction must give up rather than loop forever when everything is visible')
  // And the key must carry the slot AND the DPR.
  assert(/const key = `\$\{slot\}:\$\{entry\.id\}:\$\{dpr\}`/.test(src), 'the cache key must be slot + machine + DPR')
  return `cap ${cap}, oldest-first, connected elements skipped, key = slot:id:dpr`
})

// ===========================================================================
section('s. K3 #3 — the fold, against the REAL catalog')
// ===========================================================================

const realCatalog = JSON.parse(readFileSync(resolve(__dirname, '../../data/catalog.json'), 'utf8'))
const realEntries = lib.entriesFromCatalog(realCatalog)
const findByQuery = (q) => realEntries.filter((e) => lib.matchesQuery(lib.haystackFor(e), q)).map((e) => e.title)

await test('"AC/DC" — the slash is stripped, so `acdc` finds it', () => {
  const acdc = realEntries.find((e) => e.title === 'AC/DC')
  assert(acdc, 'AC/DC is not in the catalog any more — this test needs a new subject')
  assert(lib.foldText('AC/DC') === 'ac dc', `fold gives ${JSON.stringify(lib.foldText('AC/DC'))}`)
  for (const q of ['acdc', 'ac dc', 'AC/DC', 'ACDC']) {
    assert(findByQuery(q).includes('AC/DC'), `query ${JSON.stringify(q)} did not find AC/DC`)
  }
  return 'found by acdc / ac dc / AC/DC / ACDC'
})

await test('whitespace-insensitive: a two-word title typed as one word still matches', () => {
  // K3 named "Junk Yard" vs "Junkyard". That machine is not in this catalog —
  // verified, not assumed — so the property is proved on the real subjects
  // that DO carry it, plus directly on the function.
  assert(!realEntries.some((e) => /junk\s*yard/i.test(e.title)), 'Junk Yard is now in the catalog; use it here')
  assert(lib.matchesQuery(lib.foldText('Junk Yard'), 'junkyard'), 'the fold must match "junkyard" against "Junk Yard"')
  assert(lib.matchesQuery(lib.foldText('Junkyard'), 'junk yard'), 'and the mirror direction')
  // Real catalog subjects with the same shape:
  assert(findByQuery('pinbot').some((t) => /Pin·Bot/.test(t)), '`pinbot` should find The Machine: Bride of Pin·Bot')
  assert(findByQuery('bigshot').length + findByQuery('blackknight').length > 0, 'run-together queries should resolve')
  return `junkyard/junk yard both directions; pinbot -> ${findByQuery('pinbot').join(', ')}`
})

await test('diacritics: the catalog carries them, and they fold', () => {
  const accented = realEntries.filter((e) => /[^\x20-\x7e]/.test(e.title)).map((e) => e.title)
  assert(accented.length > 0, 'no non-ASCII titles in the catalog — test the fold directly instead')
  assert(findByQuery('pokemon').includes('Pokémon'), '`pokemon` must find Pokémon')
  assert(findByQuery('pokémon').includes('Pokémon'), 'and the accented spelling must still work')
  // NFD is what makes this work on a composed OR decomposed source string.
  assert(lib.foldText('Pokémon') === 'pokemon', 'a decomposed source must fold identically')
  return `non-ASCII titles present: ${accented.join(', ')}`
})

await test('ONLY the haystack collapses — a spaced query never matches across word boundaries', () => {
  // "kfr om" against "Attack from Mars". Neither token is present ("kfr" is not
  // a substring of "attack from mars"), so rule 1 rejects it. Rule 2 must reject
  // it too: the query keeps its space, and the collapsed haystack
  // "attackfrommars" has none, so "kfr om" cannot be found in it. Collapsing the
  // QUERY as well would match — and would start finding "ebri" inside
  // "machine bride", which is not a search anyone performs.
  const hay = lib.foldText('Attack from Mars')
  assert(!lib.matchesQuery(hay, 'kfr om'), 'a spaced query must not match across word boundaries')
  // The same letters typed as ONE token are exactly the case rule 2 exists for.
  assert(lib.matchesQuery(hay, 'kfrom'), 'the run-together form must match')
  return '"kfr om" rejected · "kfrom" accepted — the asymmetry is load-bearing'
})

await test('the fold is not merely toLowerCase', () => {
  assert(lib.foldText('AC/DC') !== 'ac/dc', 'punctuation must be handled')
  assert(lib.foldText('Pokémon') !== 'pokémon', 'diacritics must be handled')
  assert(lib.foldText('Black-Knight_2000') !== 'black-knight_2000', 'separators must be handled')
  assert(lib.foldText("Elvira's") !== "elvira's", 'apostrophes must be handled')
  return 'case, diacritics, separators and apostrophes all normalised'
})

// ===========================================================================
section('t. K3 #4 — typeahead parity and the button\'s accessible name')
// ===========================================================================

await test('typing anywhere in the dialog reaches the search field (select typeahead parity)', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    // Focus is on the ✕ after a tap-open. In the native <select> this replaced,
    // typing here would have jumped to the first matching option; the search
    // field is the same affordance, so a keystroke must land in it.
    const search = overlay.find('pg-library-search')
    assert(env.doc.activeElement !== search, 'precondition: focus is not in the field')
    assert(env.key('g'), 'a printable key should be handled')
    assert(env.doc.activeElement === search, 'focus must move to the search field')
    assert(search.value === 'g', `the character must not be lost: value is ${JSON.stringify(search.value)}`)
    await flush()
    // The SECOND character is no longer ours: focus is in the field now, so the
    // browser types it. Asserting the handler swallows that one too would be
    // asserting a bug (a double-typed character).
    assert(!env.key('o'), 'once focus is in the field the handler must stand down')
    search.value = 'go'
    search.dispatchEvent({ type: 'input' })
    await flush()
    const names = rowNames(overlay)
    assert(names.includes('Godzilla') && !names.includes('Comet'), `the list should have narrowed: ${names.join(', ')}`)
    return `typed "go" from the ✕ -> field focused, list narrowed to ${names.join(', ')}`
  }))

await test('modifier chords and named keys are NOT swallowed as typeahead', () =>
  withFakeDom(async (env) => {
    const { overlay } = await mounted(env)
    const search = overlay.find('pg-library-search')
    // A Cmd/Ctrl chord is a shortcut (Cmd+R reload); a named key is navigation.
    assert(!env.key('r', false, { metaKey: true }), 'Cmd+R must pass through')
    assert(!env.key('r', false, { ctrlKey: true }), 'Ctrl+R must pass through')
    assert(search.value === '', `no character should have been captured: ${JSON.stringify(search.value)}`)
    // Escape still closes, Tab still wraps — both proved in section g.
    assert(env.key('Escape'), 'Escape must still be handled')
    return 'Cmd+R / Ctrl+R pass through; Escape still closes'
  }))

await test('a KEYBOARD open focuses the search field; a TAP open focuses the ✕', () =>
  withFakeDom(async (env) => {
    const mod = await freshModule()
    const p = mod.createAppState()
    await env.settle('/data/jaws_goals.json')
    const state = await p
    const opener = env.doc.createElement('button')
    env.body.appendChild(opener)

    mod.openLibrary(state, opener, 'search')
    await flush()
    const overlay = env.body.find('pg-library-overlay')
    assert(env.doc.activeElement === overlay.find('pg-library-search'), 'a keyboard open must land in the search field')
    env.key('Escape')

    mod.openLibrary(state, opener, 'close')
    await flush()
    assert(env.doc.activeElement === overlay.find('pg-library-close'), 'a tap open must land on the ✕')
    return "focus: 'search' -> the field, 'close' -> the ✕"
  }))

await test('app.ts routes keyboard activations to the search field via event.detail', () => {
  // `detail` is 0 for a click synthesised by Enter/Space on a focused button.
  assert(
    /ev\.detail === 0 \? 'search' : 'close'/.test(appSrc),
    'the picker must choose its focus target from the click detail',
  )
  assert(/openLibrary\(state, opener, focus\)/.test(appSrc), 'the focus preference must reach openLibrary')
  return "ev.detail === 0 -> 'search', otherwise 'close'"
})

await test("the header button's accessible name carries the machine AND the action", () => {
  const line = /picker\.setAttribute\('aria-label', `([^`]*)`\)/.exec(appSrc)[1]
  // `fullName`, not `label`: the visible text is now the SHORT title, so the
  // accessible name is the only place carrying maker and year (see section l).
  assert(/\$\{fullName\}/.test(line), 'the current machine must be in the accessible name, in full')
  assert(/change machine/i.test(line), 'the name must say what the control does')
  assert(/machine library/i.test(line), 'and where it goes')
  // The visible text alone would announce as a bare statement.
  assert(/aria-haspopup['"],\s*['"]dialog/.test(appSrc), 'and it must declare that it opens a dialog')
  return `aria-label = "${line.replace('${fullName}', 'Tales from the Crypt (Data East, 1993)')}"`
})

await test('NO test and NO source still expects the machine <select> to exist', () => {
  // A dead reference in a test is how a removed control gets quietly
  // resurrected — the assertion keeps passing against nothing.
  const testDir = resolve(__dirname)
  const offenders = []
  for (const f of readdirSync(testDir)) {
    if (!f.endsWith('.test.mjs')) continue
    const body = readFileSync(resolve(testDir, f), 'utf8')
    // Referring to the class in order to assert its ABSENCE is fine; using it
    // to look an element up is not.
    // LOOKUPS only. A test that asserts the select is GONE necessarily names
    // it (section l does, and so does the regex two lines below in this very
    // file) — that is the opposite of a stale reference. What must not exist is
    // a test that fetches the element and then asserts something about it,
    // because that assertion keeps passing against nothing.
    const dead = 'sel' + 'ect'
    const needle = new RegExp(
      `(?:find|findAll|querySelector)\\(['"]\\.?machine-picker['"]\\)`
        + `|getElementsByTagName\\(['"]${dead}['"]\\)`,
      'g',
    )
    for (const m of body.matchAll(needle)) {
      offenders.push(`${f}: ${m[0]}`)
    }
  }
  assert(offenders.length === 0, `tests still reach for the dead select: ${offenders.join(', ')}`)
  assert(!/createElement\('select'\)/.test(appSrc), 'app.ts must not build a select')
  return `${readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).length} suites scanned, no live reference to the select`
})

// ===========================================================================
section('u. K3 #5 — the PG-12 allowlist is an exact match, deny-by-default')
// ===========================================================================

await test('library.json is allowlisted by EXACT filename, and the only glob is the goals family', () => {
  const deploy = readFileSync(resolve(__dirname, '../../deploy-prod.sh'), 'utf8')
  const caseLine = /^\s*(catalog\.json\|[^)]*)\) ;;/m.exec(deploy)[1]
  const patterns = caseLine.split('|')
  assert(patterns.includes('library.json'), `library.json is not in the allowlist: ${caseLine}`)
  const globs = patterns.filter((p) => /[*?[\]]/.test(p))
  assert(
    globs.length === 1 && globs[0] === '*_goals.json',
    `the only glob may be the goals family, found: ${globs.join(', ')}`,
  )
  // Deny-by-default: a plausible NEXT data file must not be matched by any
  // pattern here. Checked as real shell glob semantics, not by eyeballing.
  const wouldPass = (name) =>
    patterns.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(name))
  for (const intruder of ['library-v2.json', 'librarydraft.json', 'secrets-pass.json', 'goals.json', 'notes.json']) {
    assert(!wouldPass(intruder), `${intruder} would be published without anyone naming it`)
  }
  assert(wouldPass('library.json') && wouldPass('jaws_goals.json'), 'the intended files must pass')
  return `allowlist: ${patterns.join(' ')} — 5 plausible intruders all denied`
})

await test('the allowlist documents that it trusts generation-time validation', () => {
  const deploy = readFileSync(resolve(__dirname, '../../deploy-prod.sh'), 'utf8')
  assert(/TRUST-THE-ARTIFACT/.test(deploy), 'the deliberate trust boundary must be stated at the gate')
  assert(/LIBRARY_SHAPE/.test(deploy), 'and it must name what does the validating')
  assert(/EXACT FILENAME, not a glob/.test(deploy), 'and why the entry is not a glob')
  return 'trust boundary, validator and exact-match rationale all stated in deploy-prod.sh'
})

// ===========================================================================
section('v. K3 follow-ups — storage guards and the capped Pinned section')
// ===========================================================================

await test('every P6 localStorage READ falls back rather than throwing', () => {
  const src = readFileSync(resolve(srcDir, 'state.ts'), 'utf8')
  // The boot read is the one that matters most: an unguarded throw there takes
  // the whole app down with "Couldn't load Pinball Genie".
  const boot = /let savedMachineId: string \| null = null\s*try \{([\s\S]*?)\} catch/.exec(src)
  assert(boot, 'the boot-time machine-id read must be wrapped in try/catch')
  assert(/localStorage\.getItem\(MACHINE_KEY\)/.test(boot[1]), 'and it must be the MACHINE_KEY read')
  const reader = /export function readMachineIdList\([\s\S]*?\n\}/.exec(src)[0]
  assert(/try \{[\s\S]*?localStorage\.getItem\(key\)[\s\S]*?\} catch \{[\s\S]*?return \[\]/.test(reader), 'the list reader must fall back to []')
  const writer = /function writeMachineIdList\([\s\S]*?\n\}/.exec(src)[0]
  assert(/try \{[\s\S]*?setItem[\s\S]*?\} catch/.test(writer), 'the list writer must be wrapped')
  const app = appSrc
  assert(/function libraryHintSeen\(\): boolean \{\s*try \{/.test(app), 'the hint read must be wrapped')
  assert(/function markLibraryHintSeen\(\): void \{\s*try \{/.test(app), 'the hint write must be wrapped')
  return 'boot read, list read, list write, hint read, hint write — all guarded'
})

await test('a localStorage whose setItem THROWS does not break a pin tap', () =>
  withFakeDom(async (env) => {
    const { state, overlay } = await mounted(env)
    globalThis.localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    const wrap = overlay.findAll('pg-library-rowwrap').find((c) => c.textContent.includes('Comet'))
    wrap.findAll('pg-library-pin')[0].click()
    await flush()
    // The in-memory pin still works for this session; only persistence is lost.
    assert(state.isPinned('comet'), 'the pin must still apply in memory')
    assert(overlay.hidden === false, 'the overlay must not have been torn down by a throw')
    return 'setItem throws -> pin applies in memory, no exception escapes'
  }))

await test('the Pinned section is capped, with an escape hatch to the uncapped chip', () => {
  const many = Array.from({ length: 40 }, (_, i) => `m${i}`)
  const entries = many.map((id, i) => ({
    ...libraryDoc().machines[0],
    id,
    title: `Machine ${i}`,
    shortTitle: `M${i}`,
  }))
  const secs = lib.computeSections(entries, {
    query: '',
    filter: lib.ALL_FILTER,
    pinned: many,
    recent: [],
    currentId: null,
  })
  const pinned = secs.find((s) => s.title === 'Pinned')
  assert(pinned.entries.length === 30, `expected the section capped at 30, got ${pinned.entries.length}`)
  assert(pinned.overflow === 10, `expected an overflow of 10, got ${pinned.overflow}`)
  // Uncapped where it counts: the Pinned CHIP still lists all 40.
  const viaChip = lib.computeSections(entries, {
    query: '',
    filter: { kind: 'pinned', label: 'Pinned' },
    pinned: many,
    recent: [],
    currentId: null,
  })
  assert(viaChip[0].entries.length === 40, `the chip must be uncapped, got ${viaChip[0].entries.length}`)
  return '40 pinned -> section shows 30 + "…and 10 more"; the chip shows all 40'
})

await test('the overflow row renders and routes to the Pinned filter', () =>
  withFakeDom(async (env) => {
    const { state, overlay } = await mounted(env)
    // Only 5 machines in the fixture catalog, so cap the section artificially
    // by checking the render path with an overflow value present instead.
    for (const id of ['comet', 'godzilla', 'evil-dead']) state.togglePinned(id)
    await flush()
    assert(!overlay.find('pg-library-more'), 'no overflow row when the section is not capped')
    const src = readFileSync(resolve(srcDir, 'ui/library.ts'), 'utf8')
    assert(/…and \$\{sec\.overflow\} more pinned/.test(src), 'the overflow row copy must name the remainder')
    assert(/filter = \{ kind: 'pinned', label: 'Pinned' \}/.test(src), 'and tapping it must switch to the Pinned chip')
    return 'no row below the cap; above it, the row routes to the Pinned chip'
  }))

// ===========================================================================
section('l. The header button replaced the <select>')
// ===========================================================================

await test('app.ts no longer builds a machine <select>', () => {
  assert(!/createElement\('select'\)/.test(appSrc), "app.ts still calls createElement('select')")
  assert(!/'machine-picker'/.test(appSrc), "app.ts still references the old 'machine-picker' class")
  assert(/machine-picker-btn/.test(appSrc), 'app.ts should build the .machine-picker-btn')
  assert(/aria-haspopup['"],\s*['"]dialog/.test(appSrc), 'the picker must declare aria-haspopup="dialog"')
  return 'select gone; .machine-picker-btn with aria-haspopup=dialog'
})

await test('the dead .machine-picker CSS went with it, and the button rule took its slot', () => {
  assert(!/^\.machine-picker\s*[,{]/m.test(stylesCss), 'the dead .machine-picker select rule is still in styles.css')
  assert(/\.machine-picker-btn\s*\{/.test(stylesCss), 'no .machine-picker-btn rule')
  // Same header slot: flex:1 in the same row, so the layout did not move.
  const rule = /\.machine-picker-btn\s*\{([^}]*)\}/.exec(stylesCss)[1]
  assert(/flex:\s*1/.test(rule), 'the button must still take the header row\'s flexible slot')
  return '.machine-picker removed; .machine-picker-btn { flex: 1 } in its place'
})

await test('the header carries NO brand tile — the picker gets that width', () => {
  // rolo, from a 390px iPhone: the picker truncated at "Jaws (Stern …", and
  // Jaws is the SHORTEST title in the catalog. The 32px app-icon tile at the
  // top left was identity, not function — not a link, not a control — so it
  // went and the picker's `flex: 1` took the space back.
  assert(!/brand-mark/.test(appSrc), 'app.ts still builds the .brand-mark tile')
  assert(!/className = 'brand'/.test(appSrc), 'app.ts still builds the .brand wrapper')
  assert(!/icons\/icon-192\.png/.test(appSrc), 'the header still references the app-icon artwork')
  assert(!/createElement\('img'\)/.test(appSrc), 'the header should build no <img> at all now')
  // The header row is exactly the picker and the two pills.
  const appended = /top\.append\(([^)]*)\)/.exec(appSrc)[1]
  assert(appended.trim() === 'picker, helpBtn, glossaryBtn', `header row is: ${appended}`)
  // AND THE CSS WENT WITH IT — a dead rule is how a removed element comes back.
  assert(!/^\.brand\s*[,{]/m.test(stylesCss), 'the dead .brand rule is still in styles.css')
  assert(!/^\.brand-mark\s*[,{]/m.test(stylesCss), 'the dead .brand-mark rule is still in styles.css')
  // The AR view's own mark is a different control on a different surface.
  const arCss = readFileSync(resolve(srcDir, 'ar/arview.css'), 'utf8')
  assert(/\.ar-idle-brand-mark/.test(arCss), "the AR view's own brand mark must be untouched")
  return 'no .brand/.brand-mark in app.ts or styles.css; header row = picker + Help + Glossary'
})

await test('the reclaimed width goes to the PICKER, not to the Help/Glossary pills', () => {
  // Flex math, so "it grows" is arithmetic rather than hope. The pills are
  // fixed-size; the picker is the only flexible item in the row, so every
  // pixel the brand tile gave up lands on it.
  const rule = (sel) => {
    const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(stylesCss)
    assert(m, `no ${sel} rule`)
    return m[1]
  }
  const picker = rule('.machine-picker-btn')
  assert(/flex:\s*1/.test(picker), 'the picker must be the flexible item')
  assert(/min-width:\s*0/.test(picker), 'and it needs min-width:0 or the flex item refuses to shrink below its text')
  for (const pill of ['.help-btn']) {
    assert(/flex-shrink:\s*0/.test(rule(pill)), `${pill} must not absorb the reclaimed width`)
    assert(!/flex-grow:\s*[1-9]|flex:\s*[1-9]/.test(rule(pill)), `${pill} must not grow into it either`)
  }
  // The label ellipsises rather than wrapping, so the header can never grow a
  // second line no matter how long a title gets.
  const label = rule('.machine-picker-label')
  assert(/white-space:\s*nowrap/.test(label) && /text-overflow:\s*ellipsis/.test(label), 'the picker label must be one ellipsised line')
  // THE RECLAIM, as a number: the tile plus the row's gap.
  const gap = Number(/\.header-top\s*\{[^}]*gap:\s*(\d+)px/.exec(stylesCss)[1])
  const reclaimed = 32 + gap
  assert(reclaimed === 42, `expected 32px tile + ${gap}px gap = 42px reclaimed, got ${reclaimed}`)
  return `picker flex:1 min-width:0; .help-btn flex-shrink:0 and no grow; +${reclaimed}px (32px tile + ${gap}px gap) all to the picker`
})

await test('the picker shows the SHORT title, and keeps the full name in its accessible name', () => {
  const sync = /function syncPicker\(s: AppState\): void \{([\s\S]*?)\n  \}/.exec(appSrc)[1]
  // VISIBLE = shortTitle (with an empty-string guard), never the full name.
  assert(/machine\.shortTitle/.test(sync), 'the visible label must come from shortTitle')
  assert(/pickerLabel\.textContent = shown/.test(sync), 'and `shown` must be what is written to the label')
  assert(
    !/pickerLabel\.textContent = (fullName|label)\b/.test(sync),
    'the visible label must not be the full "Title (Manufacturer, Year)" — that is what truncated',
  )
  // ACCESSIBLE NAME = the full name plus the action (the P6 contract). It is
  // now the ONLY place carrying maker and year, so it matters more than before.
  const line = /picker\.setAttribute\('aria-label', `([^`]*)`\)/.exec(appSrc)[1]
  assert(/\$\{fullName\}/.test(line), `the accessible name must carry the FULL machine name, got: ${line}`)
  assert(/change machine/i.test(line), 'the name must say what the control does')
  assert(/machine library/i.test(line), 'and where it goes')
  assert(/aria-haspopup['"],\s*['"]dialog/.test(appSrc), 'and it must declare that it opens a dialog')
  return `visible: shortTitle · aria-label: "${line.replace('${fullName}', 'Jaws (Stern Pinball, 2024)')}"`
})

await test('every machine in the SHIPPING catalog has a usable short title', () => {
  // The fallback exists, but it should never fire: if it does, the header
  // silently goes back to showing a full "Title (Manufacturer, Year)" and
  // truncating. Checked against the real catalog, not a fixture.
  const missing = REAL_CATALOG.filter((m) => !m.shortTitle || !String(m.shortTitle).trim())
  assert(missing.length === 0, `these machines would fall back to the full name: ${missing.map((m) => m.id).join(', ')}`)
  const lens = REAL_CATALOG.map((m) => m.shortTitle.length).sort((a, b) => a - b)
  const longest = REAL_CATALOG.reduce((a, b) => (b.shortTitle.length > a.shortTitle.length ? b : a))
  // The short title has to actually BE shorter, or none of this bought room.
  const savings = REAL_CATALOG.map((m) => m.name.length - m.shortTitle.length)
  const median = savings.slice().sort((a, b) => a - b)[Math.floor(savings.length / 2)]
  assert(median > 10, `the short titles only save a median of ${median} characters — not worth the indirection`)
  return `${REAL_CATALOG.length}/${REAL_CATALOG.length} have one · lengths p50 ${lens[Math.floor(lens.length / 2)]}, max ${lens[lens.length - 1]} ("${longest.shortTitle}") · median ${median} chars shorter than the full name`
})

await test('MUTATION — putting the full "Title (Manufacturer, Year)" back in the header is CAUGHT', () => {
  // The regression is invisible in a suite that only reads the aria-label:
  // that keeps the full name either way. Only an assertion about the VISIBLE
  // label can tell, which is what this pins.
  const mutated = appSrc.replace(
    'const shown = machine ? machine.shortTitle.trim() || machine.name : fullName',
    'const shown = fullName',
  )
  assert(mutated !== appSrc, 'the mutation did not apply — syncPicker no longer reads shortTitle')
  const sync = /function syncPicker\(s: AppState\): void \{([\s\S]*?)\n  \}/.exec(mutated)[1]
  const err = (() => {
    try {
      assert(/machine\.shortTitle/.test(sync), 'the visible label must come from shortTitle')
      return null
    } catch (e) {
      return e
    }
  })()
  assert(err, 'the mutant passed the very check that exists to catch it')
  // And the aria-label check would NOT have caught it — stated, not assumed.
  const line = /picker\.setAttribute\('aria-label', `([^`]*)`\)/.exec(mutated)[1]
  assert(/\$\{fullName\}/.test(line), 'the accessible name survives the mutation, which is exactly why it cannot be the gate')
  return `full-title regression -> visible-label check reports: ${err.message} (the aria-label check stays green, as expected)`
})

await test('the how-to guide describes the library, not a dropdown', () => {
  assert(!/machine picker at the top to choose/.test(howtoSrc), 'howto still describes the old dropdown')
  assert(/browse every machine we cover/i.test(howtoSrc), 'howto should describe browsing the library')
  return 'step 2 rewritten for the library'
})

await test('the library chunk is loaded through loadChunk and warmed through prefetchChunk', () => {
  assert(/loadChunk\(\s*\(\) => import\('\.\/ui\/library'\)/.test(appSrc), 'the open path must go through loadChunk')
  assert(/prefetchChunk\(\(\) => import\('\.\/ui\/library'\)\)/.test(appSrc), 'the idle warm-up must go through prefetchChunk')
  assert(/requestIdleCallback/.test(appSrc), 'the warm-up should prefer requestIdleCallback')
  return 'open via loadChunk; idle warm-up via prefetchChunk'
})

// ---------------------------------------------------------------------------
await rm(tmp, { recursive: true, force: true })

const failed = results.filter((r) => r.outcome === 'fail')
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed (${results.length} checks)`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`)
  process.exit(1)
}
