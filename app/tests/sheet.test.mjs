#!/usr/bin/env node
// app/tests/sheet.test.mjs — SUITE 21: the shared bottom sheet (ui/sheet.ts),
// P4 (2026-08-14).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/sheet.test.mjs"
// or from app/:
//   node tests/sheet.test.mjs
//
// WHY THIS SUITE EXISTS. Until P4, createSheet() was chrome and nothing else:
// no role, no Escape, no focus management. Two things happened this phase and
// both need pinning:
//
//   1. The shell became a real dialog — role/aria-modal/aria-labelledby,
//      Escape, focus in on open and back to the opener on close, Tab wrap.
//      A11y wiring is exactly the kind of thing that rots invisibly: nothing
//      renders differently when an aria-labelledby stops resolving.
//   2. Two call sites MOVED ONTO it — the Map tab's goal sheet (which had
//      always used the shell) and the Glossary (which had forked a private
//      copy of the whole recipe because the shell could not mount above the
//      app header). Sections i/j drive the REAL modules end to end, because
//      "the migration compiles" is not the same claim as "the sheet still
//      lists goals / still lists terms".
//
// Pattern: esbuild bundles the REAL .ts sources into a temp ESM file, driven
// against a hand-rolled fake DOM — the same technique as study.test.mjs and
// celebrate.test.mjs (no test framework in this repo; see run-tests.mjs).
// This file's FakeElement adds two things theirs don't need: a real
// document.activeElement round-trip (focus assertions) and a way to fire
// document-level keydown (Escape/Tab).
//
// Sections:
//   a. Dialog wiring: role/aria-modal/aria-labelledby -> the title's own
//      generated id; the panel is focusable as a last resort; the chrome
//      classes and the maxHeightVh contract are unchanged.
//   b. Focus: moves in on open, returns to the opener on destroy, and is NOT
//      stolen back when focus has already moved elsewhere.
//   c. Escape and the backdrop dismiss THROUGH onDismiss (never by tearing
//      the sheet down behind the caller's back), and the listener is removed
//      on destroy.
//   d. variant 'overlay' mounts to document.body and carries the fixed-tier
//      class; 'local' (default) mounts into the host.
//   e. closeButton renders the ✕ with the caller's aria-label and dismisses.
//   f. Tab wraps inside the panel, in both directions, and cannot escape a
//      sheet with no focusable content at all.
//   g. CALLER — the Map tab's goal sheet still lists goals, is a dialog, and
//      survives an Escape-then-reopen (the bookkeeping bug that a
//      self-destroying Escape would cause).
//   h. CALLER — the Glossary renders its terms/filter through the shared
//      shell, on document.body, and its forked chrome is gone from the
//      source tree.
//   i. Tab-wrap freshness, stacked sheets, and dead-class hygiene.
//   j. STACKED TRAPS (P8 review): the Study tab's bespoke sheet with the REAL
//      glossary opened OVER it. Two dialogs, two document-level keydown
//      listeners, two focus traps — ui/overlayStack.ts decides which one owns
//      the keyboard, so Tab cycles inside the glossary only, Escape closes
//      the glossary alone, and the study sheet's own trap re-engages when it
//      becomes topmost again.
//
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const sheetPath = resolve(srcDir, 'ui/sheet.ts')
const map2dPath = resolve(srcDir, 'overlay/map2d.ts')
const glossaryPath = resolve(srcDir, 'ui/glossary.ts')
const studyPath = resolve(srcDir, 'ui/study.ts')
const overlayStackPath = resolve(srcDir, 'ui/overlayStack.ts')
const sheetCssPath = resolve(srcDir, 'ui/sheet.css')
const glossaryCssPath = resolve(srcDir, 'ui/glossary.css')

const sheetCss = readFileSync(sheetCssPath, 'utf8')
const glossaryCss = readFileSync(glossaryCssPath, 'utf8')
const glossarySrc = readFileSync(glossaryPath, 'utf8')

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

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------
const W = 600
const H = 900

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
    this.dataset = {}
    this.clientWidth = W
    this.clientHeight = H
    this.width = 0
    this.height = 0
    const classSet = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      toggle: (c, force) => {
        const want = force === undefined ? !classSet.has(c) : force
        if (want) classSet.add(c)
        else classSet.delete(c)
        return want
      },
      contains: (c) => classSet.has(c),
    }
    // setProperty joins removeProperty as REAL API surface (P9 follow-up):
    // ui/study.ts publishes the card's drawn top edge as `--study-card-top`
    // for `.study-rail`'s padding-top, and a bare {} makes that throw. Custom
    // properties are kept in their own map so a test can read back exactly
    // what was written.
    const styleObj = {
      removeProperty: (prop) => {
        delete styleObj[prop]
        delete styleObj._vars[prop]
      },
      _vars: Object.create(null),
      setProperty: (prop, value) => {
        styleObj._vars[prop] = value
        styleObj[prop] = value
      },
      getPropertyValue: (prop) => styleObj._vars[prop] ?? '',
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
  /** Only ever assigned '' by this app's sources (a clear-the-list idiom —
   *  ui/glossary.ts's renderTermList/renderUnavailable). Modelled as the real
   *  thing does it: emptying innerHTML empties the child list. */
  set innerHTML(v) {
    this._html = v
    if (v === '') this.children = []
  }
  get innerHTML() {
    return this._html
  }
  appendChild(child) {
    // A DocumentFragment's CHILDREN move, not the fragment — the real DOM's
    // rule, and the one ui/linkTerms.ts's output depends on (2026-10-14: the
    // Study prose is built as a fragment and appended into its paragraph).
    if (child && child.tagName === '#DOCUMENT-FRAGMENT') {
      for (const c of [...child.children]) this.appendChild(c)
      child.children = []
      return child
    }
    this.children.push(child)
    child.parentElement = this
    return child
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n))
  }
  replaceChildren(...nodes) {
    this.children = []
    nodes.forEach((n) => this.appendChild(n))
  }
  remove() {
    if (!this.parentElement) return
    const i = this.parentElement.children.indexOf(this)
    if (i >= 0) this.parentElement.children.splice(i, 1)
    this.parentElement = null
  }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    return child
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
  querySelector() {
    return null
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }
  }
  focus() {
    domActiveElement = this
  }
  /** find-FIRST by class, depth-first — the convention every suite here uses. */
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

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function recordingCtx() {
  const noop = () => {}
  return {
    canvas: { clientWidth: W, clientHeight: H, width: W, height: H },
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    save: noop,
    restore: noop,
    clip: noop,
    setLineDash: noop,
    setTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    arcTo: noop,
    arc: noop,
    rect: noop,
    roundRect: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fill: noop,
    stroke: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
  }
}

/** Installs fake document/window/rAF/ResizeObserver/performance for `fn`, and
 *  always restores them. `fn` gets `{ doc, body, key }` — `key(k, shift)`
 *  fires a document-level keydown exactly the way a browser would deliver one
 *  to ui/sheet.ts's own listener, and returns whether preventDefault ran. */
function withFakeDom(fn) {
  const prior = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    performance: globalThis.performance,
  }
  const listeners = new Map()
  const body = new FakeElement('body')
  const ctx = recordingCtx()
  let fakeClock = 0
  let pendingFrame = null
  domActiveElement = null
  const doc = {
    createElement(tag) {
      const el = new FakeElement(tag)
      if (String(tag).toLowerCase() === 'canvas') el.getContext = (type) => (type === '2d' ? ctx : null)
      return el
    },
    createTextNode(t) {
      const n = new FakeElement('#text')
      n.textContent = t
      return n
    },
    // ui/linkTerms.ts (2026-10-14) builds the Study tab's prose as one.
    createDocumentFragment() {
      return new FakeElement('#document-fragment')
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(cb)
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb)
    },
    get activeElement() {
      return domActiveElement
    },
    body,
  }
  globalThis.document = doc
  // window.setTimeout/clearTimeout: ui/study.ts's live-region coalescing uses
  // them, and mountStudy runs in this harness as of the stacked-trap section.
  // Deliberately INERT — callbacks are recorded and never fire on their own —
  // so no timer can come due after these fake globals are torn down.
  const parkedTimers = new Map()
  let parkedSeq = 0
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia: (q) => ({ matches: false, media: q }),
    setTimeout: (cb) => (parkedTimers.set(++parkedSeq, cb), parkedSeq),
    clearTimeout: (id) => void parkedTimers.delete(id),
  }
  globalThis.requestAnimationFrame = (cb) => {
    pendingFrame = cb
    return 1
  }
  globalThis.cancelAnimationFrame = () => {
    pendingFrame = null
  }
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.performance = { now: () => fakeClock }
  function key(k, shiftKey = false) {
    let prevented = false
    const ev = { type: 'keydown', key, shiftKey, preventDefault: () => (prevented = true) }
    ev.key = k
    for (const cb of [...(listeners.get('keydown') || [])]) cb(ev)
    return prevented
  }
  function step(elapsedMs) {
    fakeClock = elapsedMs
    const cb = pendingFrame
    if (!cb) return false
    cb(fakeClock)
    return true
  }
  function restore() {
    globalThis.document = prior.document
    globalThis.window = prior.window
    globalThis.requestAnimationFrame = prior.requestAnimationFrame
    globalThis.cancelAnimationFrame = prior.cancelAnimationFrame
    globalThis.ResizeObserver = prior.ResizeObserver
    globalThis.performance = prior.performance
  }
  // An ASYNC `fn` (section h awaits the glossary's fetch) must keep the fake
  // globals installed until it actually settles — a plain try/finally restores
  // them at the first `await`, which is how the real modules end up calling
  // `document.createElement` on the undefined Node global. Await-aware here,
  // once, rather than a second near-identical harness.
  try {
    const out = fn({ doc, body, key, step, docKeydownCount: () => (listeners.get('keydown')?.size ?? 0), parkedTimerCount: () => parkedTimers.size })
    if (out && typeof out.then === 'function') return out.then((v) => (restore(), v), (e) => (restore(), Promise.reject(e)))
    restore()
    return out
  } catch (err) {
    restore()
    throw err
  }
}

// ---------------------------------------------------------------------------
// Bundle the real modules.
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-sheet-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  [
    `export { createSheet } from ${JSON.stringify(sheetPath)}`,
    `export { mountMap2D } from ${JSON.stringify(map2dPath)}`,
    `export { openGlossary } from ${JSON.stringify(glossaryPath)}`,
    `export { mountStudy } from ${JSON.stringify(studyPath)}`,
    `export { overlayDepth, resetOverlayStack } from ${JSON.stringify(overlayStackPath)}`,
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
const { createSheet, mountMap2D, openGlossary, mountStudy, overlayDepth, resetOverlayStack } =
  await import(pathToFileURL(outfile).href)

/** Opens a sheet in a fake DOM with an "opener" button already focused, so
 *  every focus-return assertion has something real to return TO. */
function withSheet(opts, fn) {
  return withFakeDom((env) => {
    const host = env.doc.createElement('div')
    const opener = env.doc.createElement('button')
    opener.className = 'opener'
    host.appendChild(opener)
    env.body.appendChild(host)
    opener.focus()
    let dismissed = 0
    const handle = createSheet(host, { ...opts, onDismiss: () => (dismissed += 1) })
    return fn({ ...env, host, opener, handle, dismissals: () => dismissed })
  })
}

// ===========================================================================
section('a. Dialog wiring: role, aria-modal, aria-labelledby -> the title id')
// ===========================================================================

withSheet({ title: 'Goals', meta: 'JAWS · 12 LOADED', maxHeightVh: 62 }, ({ host }) => {
  const panel = host.find('pg-sheet-panel')

  test('the panel is role="dialog" + aria-modal="true"', () => {
    assert(panel, 'expected a .pg-sheet-panel element')
    assert(panel.getAttribute('role') === 'dialog', `expected role="dialog", got ${JSON.stringify(panel.getAttribute('role'))}`)
    assert(panel.getAttribute('aria-modal') === 'true', `expected aria-modal="true", got ${JSON.stringify(panel.getAttribute('aria-modal'))}`)
  })

  test('aria-labelledby RESOLVES: it names the id of the title element that carries the sheet title', () => {
    const labelledBy = panel.getAttribute('aria-labelledby')
    assert(labelledBy, 'expected an aria-labelledby attribute')
    const title = host.find('pg-sheet-title')
    assert(title, 'expected a .pg-sheet-title element')
    assert(title.id === labelledBy, `aria-labelledby is ${JSON.stringify(labelledBy)} but the title's id is ${JSON.stringify(title.id)}`)
    assert(title.textContent === 'Goals', `expected the title text "Goals", got ${JSON.stringify(title.textContent)}`)
    return `${labelledBy} -> "${title.textContent}"`
  })

  test('the panel itself is focusable (tabindex -1) — a body with no controls must still take focus', () => {
    assert(panel.getAttribute('tabindex') === '-1', `expected tabindex="-1", got ${JSON.stringify(panel.getAttribute('tabindex'))}`)
  })

  test('the existing chrome is unchanged: backdrop + grabber + header + meta + body, and maxHeightVh still bounds the BODY only', () => {
    assert(host.find('pg-sheet-backdrop'), 'expected a .pg-sheet-backdrop element')
    assert(host.find('pg-sheet-grabber'), 'expected a .pg-sheet-grabber element')
    assert(host.find('pg-sheet-header'), 'expected a .pg-sheet-header element')
    assert(host.find('pg-sheet-meta').textContent === 'JAWS · 12 LOADED', 'expected the meta text to survive')
    const body = host.find('pg-sheet-body')
    assert(body, 'expected a .pg-sheet-body element')
    assert(body.style.maxHeight === '62dvh', `expected the body max-height to be 62dvh, got ${JSON.stringify(body.style.maxHeight)}`)
    return `body max-height ${body.style.maxHeight}`
  })

})

withSheet({ title: 'Goals', maxHeightVh: 62 }, ({ host, handle }) => {
  test('setBody() installs exactly the element it is given (and replaces, not appends)', () => {
    const first = document.createElement('div')
    first.className = 'first-body'
    const second = document.createElement('div')
    second.className = 'second-body'
    handle.setBody(first)
    handle.setBody(second)
    const body = host.find('pg-sheet-body')
    assert(body.children.length === 1, `expected exactly 1 body child, got ${body.children.length}`)
    assert(body.children[0] === second, 'expected the SECOND setBody call to replace the first')
    assert(!host.find('first-body'), 'the first body content should be gone')
  })
})

// ===========================================================================
section('b. Focus: in on open, back to the opener on destroy, never stolen')
// ===========================================================================

withSheet({ title: 'Goals', maxHeightVh: 62 }, ({ host, opener, handle }) => {
  test('opening moves focus off the opener and into the sheet (the panel, when the chrome has no button)', () => {
    const panel = host.find('pg-sheet-panel')
    assert(document.activeElement === panel, 'expected focus to land on the panel')
    assert(document.activeElement !== opener, 'focus must not still be on the opener')
  })

  test('destroy() returns focus to whatever was focused before the sheet opened', () => {
    handle.destroy()
    assert(document.activeElement === opener, 'expected focus to return to the opener button')
  })

  test('destroy() is idempotent (calling it twice does not throw and does not re-remove)', () => {
    handle.destroy()
    assert(!host.find('pg-sheet-panel'), 'the panel should still be gone')
  })
})

withSheet({ title: 'Goals', maxHeightVh: 62 }, ({ host, opener, handle }) => {
  test('focus is NOT dragged back to the opener when it has already moved elsewhere (e.g. the settings button that closed the sheet)', () => {
    const elsewhere = document.createElement('button')
    elsewhere.className = 'elsewhere'
    host.appendChild(elsewhere)
    elsewhere.focus()
    handle.destroy()
    assert(document.activeElement === elsewhere, 'expected focus to stay on the control the user actually pressed')
    assert(document.activeElement !== opener, 'destroy() must not steal focus back from outside the sheet')
  })
})

// ===========================================================================
section('c. Dismissal routes through onDismiss, and the key listener is cleaned up')
// ===========================================================================

withSheet({ title: 'Goals', maxHeightVh: 62 }, ({ host, key, handle, dismissals, docKeydownCount }) => {
  test('Escape calls onDismiss() and does NOT tear the sheet down by itself (the caller owns the teardown)', () => {
    key('Escape')
    assert(dismissals() === 1, `expected exactly 1 onDismiss call, got ${dismissals()}`)
    assert(host.find('pg-sheet-panel'), 'the panel must still exist — only the caller’s destroy() removes it')
  })

  test('the backdrop click also routes through onDismiss, but only when the backdrop ITSELF is the target', () => {
    const backdrop = host.find('pg-sheet-backdrop')
    backdrop.dispatchEvent({ type: 'click', target: host.find('pg-sheet-panel') })
    assert(dismissals() === 1, 'a click that started on the panel must not dismiss')
    backdrop.dispatchEvent({ type: 'click', target: backdrop })
    assert(dismissals() === 2, `expected a backdrop-target click to dismiss; dismissals=${dismissals()}`)
  })

  test('destroy() removes the document keydown listener — Escape afterwards is inert', () => {
    const before = docKeydownCount()
    handle.destroy()
    assert(docKeydownCount() === before - 1, `expected one fewer document keydown listener (had ${before}, now ${docKeydownCount()})`)
    key('Escape')
    assert(dismissals() === 2, `a destroyed sheet must not answer Escape; dismissals=${dismissals()}`)
  })
})

// ===========================================================================
section("d. variant: 'overlay' mounts to document.body; 'local' mounts to the host")
// ===========================================================================

withFakeDom(({ doc, body }) => {
  const host = doc.createElement('div')
  body.appendChild(host)
  const handle = createSheet(doc.body, { title: 'Glossary', maxHeightVh: 68, variant: 'overlay', onDismiss: () => {} })

  test('both chrome elements land on document.body, not inside the host', () => {
    assert(body.children.includes(handleBackdrop(body)), 'expected the backdrop on document.body')
    const panel = body.find('pg-sheet-panel')
    assert(panel && panel.parentElement === body, 'expected the panel to be a direct child of document.body')
    assert(!host.find('pg-sheet-panel'), 'the panel must NOT be inside the host element')
  })

  test('both carry the .pg-sheet-overlay class the fixed z-index 200/201 rules key off', () => {
    const panel = body.find('pg-sheet-panel')
    const backdrop = body.find('pg-sheet-backdrop')
    assert(panel.className.split(/\s+/).includes('pg-sheet-overlay'), `panel className is ${JSON.stringify(panel.className)}`)
    assert(backdrop.className.split(/\s+/).includes('pg-sheet-overlay'), `backdrop className is ${JSON.stringify(backdrop.className)}`)
    return panel.className
  })

  test('sheet.css actually gives that class the fixed/above-everything treatment (z-index 200 backdrop / 201 panel)', () => {
    const css = sheetCss.replace(/\/\*[\s\S]*?\*\//g, '')
    assert(/\.pg-sheet-backdrop\.pg-sheet-overlay\s*\{[^}]*position:\s*fixed/.test(css), 'no fixed-position rule for the overlay backdrop')
    assert(/\.pg-sheet-backdrop\.pg-sheet-overlay\s*\{[^}]*z-index:\s*200/.test(css), 'overlay backdrop is not at z-index 200')
    assert(/\.pg-sheet-panel\.pg-sheet-overlay\s*\{[^}]*position:\s*fixed/.test(css), 'no fixed-position rule for the overlay panel')
    assert(/\.pg-sheet-panel\.pg-sheet-overlay\s*\{[^}]*z-index:\s*201/.test(css), 'overlay panel is not at z-index 201')
    return 'backdrop fixed/200, panel fixed/201 — above the app header + tab bar (z-index 20)'
  })

  handle.destroy()

  test('destroy() removes it from document.body', () => {
    assert(!body.find('pg-sheet-panel'), 'expected the overlay panel to be gone')
    assert(!body.find('pg-sheet-backdrop'), 'expected the overlay backdrop to be gone')
  })

  function handleBackdrop(root) {
    return root.find('pg-sheet-backdrop')
  }
})

withFakeDom(({ doc, body }) => {
  const host = doc.createElement('div')
  body.appendChild(host)
  createSheet(host, { title: 'Goals', maxHeightVh: 62, onDismiss: () => {} })
  test("the default ('local') variant mounts into the host and carries no overlay class", () => {
    const panel = host.find('pg-sheet-panel')
    assert(panel && panel.parentElement === host, 'expected the panel inside the host')
    assert(!panel.className.split(/\s+/).includes('pg-sheet-overlay'), `local panel must not be overlay-classed: ${panel.className}`)
  })
})

// ===========================================================================
section('e. closeButton renders the ✕ with the caller’s label, and dismisses')
// ===========================================================================

withSheet({ title: 'Glossary', maxHeightVh: 68, closeButton: true, closeLabel: 'Close glossary' }, ({ host, dismissals }) => {
  test('the ✕ exists in the header with the aria-label the caller passed', () => {
    const btn = host.find('pg-sheet-close')
    assert(btn, 'expected a .pg-sheet-close element')
    assert(btn.tagName === 'BUTTON' && btn.type === 'button', 'expected a real <button type="button">')
    assert(btn.getAttribute('aria-label') === 'Close glossary', `expected the caller's label, got ${JSON.stringify(btn.getAttribute('aria-label'))}`)
    assert(btn.parentElement === host.find('pg-sheet-header'), 'expected the ✕ inside the sheet header')
    return `aria-label="${btn.getAttribute('aria-label')}"`
  })

  test('the header takes the align-items:center modifier ONLY when there is a ✕ (a 36px button cannot share a text baseline)', () => {
    const header = host.find('pg-sheet-header')
    assert(header.className.split(/\s+/).includes('pg-sheet-header-with-close'), `header className is ${JSON.stringify(header.className)}`)
    const css = sheetCss.replace(/\/\*[\s\S]*?\*\//g, '')
    assert(/\.pg-sheet-header-with-close\s*\{[^}]*align-items:\s*center/.test(css), 'sheet.css has no align-items:center for the with-close header')
  })

  test('focus lands ON the ✕ when there is one (the sheet’s own primary affordance)', () => {
    assert(document.activeElement === host.find('pg-sheet-close'), 'expected focus on the close button')
  })

  test('clicking it dismisses through onDismiss', () => {
    host.find('pg-sheet-close').dispatchEvent({ type: 'click' })
    assert(dismissals() === 1, `expected 1 onDismiss call, got ${dismissals()}`)
  })

  test('its 44px hit area is an OVERLAY, not a size change (the button is still drawn at 36px)', () => {
    const css = sheetCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const base = /\.pg-sheet-close\s*\{([^}]*)\}/.exec(css)
    assert(base, 'no .pg-sheet-close rule in sheet.css')
    assert(/width:\s*36px/.test(base[1]) && /height:\s*36px/.test(base[1]), `expected a 36x36 visual, got ${base[1].trim()}`)
    assert(/position:\s*relative/.test(base[1]), 'the ::after overlay needs .pg-sheet-close to be a containing block')
    const after = /\.pg-sheet-close::after\s*\{([^}]*)\}/.exec(css)
    assert(after, 'no .pg-sheet-close::after hit-area rule')
    assert(/position:\s*absolute/.test(after[1]) && /inset:\s*-4px/.test(after[1]), `expected inset:-4px absolute overlay, got ${after[1].trim()}`)
    return '36px drawn + 4px on every side = 44x44 effective'
  })
})

withSheet({ title: 'Goals', maxHeightVh: 62 }, ({ host }) => {
  test('no ✕ unless the caller asks for one (the Map tab’s goal sheet keeps its backdrop-tap dismissal)', () => {
    assert(!host.find('pg-sheet-close'), 'expected no close button by default')
    assert(!host.find('pg-sheet-header').className.split(/\s+/).includes('pg-sheet-header-with-close'), 'the with-close modifier must not be applied')
  })
})

// ===========================================================================
section('f. Tab wraps inside the panel and cannot leave it')
// ===========================================================================

withSheet({ title: 'Glossary', maxHeightVh: 68, closeButton: true }, ({ host, key, handle }) => {
  const rows = document.createElement('div')
  const made = []
  for (const label of ['row-a', 'row-b', 'row-c']) {
    const b = document.createElement('button')
    b.className = label
    b.textContent = label
    rows.appendChild(b)
    made.push(b)
  }
  handle.setBody(rows)
  const closeBtn = host.find('pg-sheet-close')

  test('Tab from the LAST focusable wraps to the first (which is the ✕ in the header)', () => {
    made[2].focus()
    const prevented = key('Tab')
    assert(prevented, 'expected the wrap to preventDefault the browser’s own Tab')
    assert(document.activeElement === closeBtn, 'expected focus to wrap to the header ✕')
  })

  test('Shift+Tab from the FIRST focusable wraps to the last', () => {
    closeBtn.focus()
    const prevented = key('Tab', true)
    assert(prevented, 'expected the backward wrap to preventDefault')
    assert(document.activeElement === made[2], 'expected focus to wrap to the last body row')
  })

  test('Tab in the MIDDLE is left alone — the browser’s own sequential navigation still applies', () => {
    made[0].focus()
    const prevented = key('Tab')
    assert(!prevented, 'a mid-list Tab must not be intercepted')
    assert(document.activeElement === made[0], 'the trap must not move focus on a mid-list Tab')
  })

  test('Shift+Tab from the PANEL itself (the initial focus target when there is no button) wraps to the last', () => {
    const panel = host.find('pg-sheet-panel')
    panel.focus()
    key('Tab', true)
    assert(document.activeElement === made[2], 'expected Shift+Tab from the panel to wrap to the last focusable')
  })
})

withSheet({ title: 'Goals', maxHeightVh: 62 }, ({ host, key }) => {
  test('a sheet with NO focusable content at all keeps focus on the panel instead of letting Tab escape the dialog', () => {
    const empty = document.createElement('div')
    empty.className = 'state-message'
    empty.textContent = 'No goals loaded for this machine yet.'
    host.find('pg-sheet-body').appendChild(empty)
    const panel = host.find('pg-sheet-panel')
    const prevented = key('Tab')
    assert(prevented, 'expected Tab to be prevented when there is nothing to move to')
    assert(document.activeElement === panel, 'expected focus to stay on the panel')
  })
})

// ===========================================================================
section('g. CALLER — the Map tab’s goal sheet, through the REAL mountMap2D')
// ===========================================================================

const GOAL_SHOTS = [
  { id: 's-left', name: 'Left Ramp', type: 'ramp', x: 0.25, y: 0.7, trim: 'all' },
  { id: 's-right', name: 'Right Orbit', type: 'orbit', x: 0.75, y: 0.7, trim: 'all' },
]
const GOALS = [
  { id: 'g-1', title: 'Start Multiball', category: 'multiball', difficulty: 2, steps: [{ shot: 's-left' }, { shot: 's-right' }] },
  { id: 'g-2', title: 'Light The Lock', category: 'mode', difficulty: 1, steps: [{ shot: 's-right' }] },
]

function fakeMapState() {
  const listeners = new Set()
  const shotsByID = new Map(GOAL_SHOTS.map((s) => [s.id, s]))
  const st = {
    machines: [],
    machine: { id: 'sheet-test', name: 'Sheet Test Machine', shortTitle: 'STM' },
    data: { machine: 'Sheet Test Machine', shots: GOAL_SHOTS, goals: GOALS, sources: [], playfields: [] },
    shotsByID,
    selectedGoal: null,
    stepIndex: 0,
    ballPosition: 'any',
    highlightMode: 'auto',
    trailStyle: 'dash',
    ballTracer: true,
    shotLines: true,
    trim: 'premium-le',
    celebrationLevel: 0,
    routeStartedAt: 0,
    setTrailStyle() {},
    setBallTracer() {},
    setShotLines() {},
    setTrim() {},
    setCelebrationLevel() {},
    async selectMachine() {},
    select(goal) {
      st.selectedGoal = goal
      for (const fn of listeners) fn()
    },
    clearSelection() {
      st.selectedGoal = null
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
  }
  return st
}

withFakeDom(({ doc, body, key, docKeydownCount }) => {
  const host = doc.createElement('div')
  body.appendChild(host)
  const handle = mountMap2D(host, fakeMapState())
  const pill = host.find('map-goal-pill')

  test('tapping the GOAL pill opens the shared sheet — and it is a dialog now', () => {
    assert(pill, 'expected a .map-goal-pill element')
    pill.dispatchEvent({ type: 'click' })
    const panel = host.find('pg-sheet-panel')
    assert(panel, 'expected the shared .pg-sheet-panel to be mounted into the map host')
    assert(panel.getAttribute('role') === 'dialog', 'the goal sheet must be role=dialog')
    assert(panel.getAttribute('aria-modal') === 'true', 'the goal sheet must be aria-modal')
    const title = host.find('pg-sheet-title')
    assert(panel.getAttribute('aria-labelledby') === title.id, 'the goal sheet’s aria-labelledby must resolve to its own title')
    assert(title.textContent === 'Goals', `expected the title "Goals", got ${JSON.stringify(title.textContent)}`)
  })

  test('THE MIGRATION DID NOT EAT THE CONTENT: the sheet still lists every goal row', () => {
    const rows = host.findAll('map-gsheet-row')
    assert(rows.length === GOALS.length, `expected ${GOALS.length} .map-gsheet-row entries, got ${rows.length}`)
    const titles = rows.map((r) => r.find('map-gsheet-row-title').textContent)
    assert(
      titles.some((t) => t.includes('Start Multiball')) && titles.some((t) => t.includes('Light The Lock')),
      `expected both goal titles, got ${JSON.stringify(titles)}`,
    )
    return titles.join(' | ')
  })

  test('Escape closes the goal sheet, restores focus to the pill, and leaves NO listener behind', () => {
    // Deterministic setup regardless of what the previous test left open:
    // close, put focus on the pill, then open THROUGH the pill so it is the
    // element the sheet recorded as its opener.
    if (host.find('pg-sheet-panel')) key('Escape')
    const opener = host.find('map-goal-pill')
    opener.focus()
    pill.dispatchEvent({ type: 'click' })
    assert(host.find('pg-sheet-panel'), 'setup: sheet open')
    const before = docKeydownCount()
    assert(before >= 1, 'setup: the sheet registered its Escape listener')
    key('Escape')
    assert(!host.find('pg-sheet-panel'), 'expected the goal sheet to be gone after Escape')
    assert(docKeydownCount() === before - 1, `expected the Escape listener torn down (had ${before}, now ${docKeydownCount()})`)
    assert(document.activeElement === opener, 'expected focus back on the goal pill that opened it')
    // SPAM IT. A second Escape must be a no-op — if the listener were still
    // alive it would run onDismiss against an already-destroyed sheet.
    key('Escape')
    key('Escape')
    assert(!host.find('pg-sheet-panel'), 'still closed after two more Escapes')
    assert(docKeydownCount() === before - 1, 'a dead sheet must not resurrect a listener')
    return `listeners ${before} -> ${docKeydownCount()}, focus restored`
  })

  // THE BOOKKEEPING PIN. map2d.ts's openGoalSheet toggles on `sheetHandle !==
  // null`. If Escape had called destroy() directly instead of the caller's
  // onDismiss, that variable would still hold a handle to a removed panel and
  // the NEXT tap on the pill would "toggle it closed" — i.e. do nothing at
  // all, forever. This test is the whole reason ui/sheet.ts dismisses through
  // onDismiss.
  test('and the pill still works afterwards — Escape left no stale handle behind', () => {
    pill.dispatchEvent({ type: 'click' })
    assert(host.find('pg-sheet-panel'), 'expected the sheet to reopen on the next tap')
    assert(host.findAll('map-gsheet-row').length === GOALS.length, 'expected the reopened sheet to list the goals again')
  })

  test('opening the settings popover closes the sheet, and does not fight it for the Escape key', () => {
    const settingsBtn = host.find('map-settings-btn')
    assert(settingsBtn, 'expected a .map-settings-btn element')
    settingsBtn.dispatchEvent({ type: 'click' })
    assert(!host.find('pg-sheet-panel'), 'expected the goal sheet to close when the popover opens')
    const popover = host.find('map-settings-popover')
    assert(popover && popover.hidden === false, 'expected the settings popover to be open')
    // REVERSED 2026-08-14, and the reversal is the fix. This used to assert
    // that Escape must NOT close the popover, on the reasoning that dismissal
    // was the pointerdown path's job. Driven by hand in real Chrome, that
    // reads as a broken control: every other dismissible surface in this app
    // takes Escape (how-to, glossary, this tab's goal sheet, all four Study
    // sheets), so a keyboard visitor pressed it, nothing happened, and the
    // only way out was to find the ≡ button again.
    //
    // "Does not fight it" is still the claim in the name, and is still true:
    // the two are mutually exclusive (each opener closes the other), and the
    // popover's handler no-ops unless the popover is open — proven directly
    // below.
    key('Escape')
    assert(popover.hidden === true, 'Escape must close the settings popover — it is the only keyboard way out of it')
    return 'Escape dismisses the popover'
  })

  test('...and with the popover CLOSED, its Escape handler is inert — the sheet still owns the key', () => {
    // The half that stops the fix from becoming a new bug: a document-level
    // keydown that fired unconditionally would close a popover nobody opened,
    // and — worse — could act on an Escape a layered dialog was handling.
    // FOCUS THE PILL FIRST. ui/sheet.ts returns focus to whatever was focused
    // when the sheet opened, and the test above deliberately left it on the ≡
    // button (that is where its own Escape put it) — so without this line the
    // sheet would legitimately return focus there and the assertion below
    // would be measuring the previous test's tail, not this one's claim.
    pill.focus()
    pill.dispatchEvent({ type: 'click' })
    assert(host.find('pg-sheet-panel'), 'setup: the goal sheet is open')
    const popover = host.find('map-settings-popover')
    assert(popover.hidden === true, 'setup: the popover is closed')
    key('Escape')
    assert(!host.find('pg-sheet-panel'), 'the sheet must still take the Escape')
    assert(popover.hidden === true, 'and the popover stays closed')
    // FOCUS IS THE PART THAT ACTUALLY BREAKS if the guard is dropped. A
    // handler that ran unconditionally would still "close" an already-closed
    // popover invisibly — but it would also yank focus to the ≡ button, out
    // from under the sheet's own return-to-opener contract. That is the
    // observable damage, so that is what is asserted.
    assert(
      document.activeElement === pill,
      `Escape with no popover open must leave focus where the sheet put it (the pill), got ${JSON.stringify(document.activeElement?.className)}`,
    )
    assert(document.activeElement !== host.find('map-settings-btn'), 'the popover must not steal focus on an Escape it had no part in')
    return 'sheet closed, popover untouched, focus back on the pill'
  })

  test('destroy() takes the popover\'s document listener with it', () => {
    // A map that has been torn down (a tab switch never does this, but
    // app.ts's teardown paths do) must leave nothing on `document`. A
    // surviving keydown handler would answer Escapes on behalf of a popover
    // whose host is gone — the same class of leak the sheet's own
    // "leaves NO listener behind" test above pins for ui/sheet.ts.
    const before = docKeydownCount()
    assert(before >= 1, `setup: the mounted map should own a document keydown listener, saw ${before}`)
    handle.destroy()
    assert(docKeydownCount() === before - 1, `expected the map's keydown listener removed (had ${before}, now ${docKeydownCount()})`)
    return `document keydown listeners ${before} -> ${docKeydownCount()}`
  })
})

// ===========================================================================
section('h. CALLER — the Glossary, through the REAL openGlossary()')
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
    { id: 'technique', title: 'Technique', terms: [{ term: 'Nudge', def: 'Moving the machine to influence the ball.' }] },
  ],
}

const priorFetch = globalThis.fetch
let fetchedUrl = null
globalThis.fetch = async (url) => {
  fetchedUrl = url
  return { ok: true, status: 200, json: async () => GLOSSARY_FIXTURE }
}

await withFakeDom(async ({ body, key, docKeydownCount }) => {
  const opener = document.createElement('button')
  opener.className = 'glossary-opener'
  body.appendChild(opener)
  opener.focus()

  const handle = openGlossary()
  // loadGlossary() is a fetch + two .then hops.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  test('it now uses the SHARED sheet, mounted on document.body at the overlay tier', () => {
    const panel = body.find('pg-sheet-panel')
    assert(panel, 'expected the shared .pg-sheet-panel — the glossary must not build its own panel any more')
    assert(panel.parentElement === body, 'expected it mounted on document.body')
    assert(panel.className.split(/\s+/).includes('pg-sheet-overlay'), 'expected the fixed overlay variant')
    assert(panel.getAttribute('role') === 'dialog', 'expected role=dialog')
    assert(body.find('pg-sheet-title').textContent === 'Glossary', 'expected the sheet titled "Glossary"')
    assert(!body.find('pg-glossary-panel'), 'the forked .pg-glossary-panel must be gone')
    assert(!body.find('pg-glossary-backdrop'), 'the forked .pg-glossary-backdrop must be gone')
  })

  test('the ✕ is the shared one, still labelled "Close glossary"', () => {
    const btn = body.find('pg-sheet-close')
    assert(btn, 'expected the shared .pg-sheet-close')
    assert(btn.getAttribute('aria-label') === 'Close glossary', `got ${JSON.stringify(btn.getAttribute('aria-label'))}`)
    assert(!body.find('pg-glossary-close'), 'the forked .pg-glossary-close must be gone')
  })

  test('THE MIGRATION DID NOT EAT THE CONTENT: the fetched terms still render, grouped and alphabetised', () => {
    assert(fetchedUrl === '/data/glossary.json', `expected the real data URL, got ${JSON.stringify(fetchedUrl)}`)
    const terms = body.findAll('pg-glossary-term')
    assert(terms.length === 3, `expected 3 .pg-glossary-term rows, got ${terms.length}`)
    const names = body.findAll('pg-glossary-term-name').map((n) => n.textContent)
    assert(names.join(',') === 'Orbit,Ramp,Nudge', `expected Orbit,Ramp,Nudge (alphabetical within category), got ${names.join(',')}`)
    assert(body.findAll('pg-glossary-section').length === 2, 'expected both category sections')
    return names.join(' | ')
  })

  test('the live filter still filters (term + aliases + def), inside the shared body', () => {
    const input = body.find('pg-glossary-filter')
    assert(input, 'expected the .pg-glossary-filter input')
    input.value = 'nudge'
    input.dispatchEvent({ type: 'input' })
    const names = body.findAll('pg-glossary-term-name').map((n) => n.textContent)
    assert(names.join(',') === 'Nudge', `expected only Nudge, got ${JSON.stringify(names)}`)
    input.value = 'loop' // an ALIAS of Orbit
    input.dispatchEvent({ type: 'input' })
    const byAlias = body.findAll('pg-glossary-term-name').map((n) => n.textContent)
    assert(byAlias.join(',') === 'Orbit', `expected the alias match Orbit, got ${JSON.stringify(byAlias)}`)
    input.value = ''
    input.dispatchEvent({ type: 'input' })
    assert(body.findAll('pg-glossary-term').length === 3, 'expected all three terms back on an empty filter')
  })

  test('Escape closes it EVEN WITH FOCUS IN THE SEARCH BOX, and returns focus to whatever opened it', () => {
    // The realistic case: someone is typing a filter and hits Escape. The
    // handler is document-level, so this works today — the pin exists so that
    // a future input-level Escape handler (search inputs love to grow one for
    // "clear the field") cannot silently swallow the dismissal by forgetting
    // to let the event through.
    body.find('pg-glossary-filter').focus()
    assert(document.activeElement === body.find('pg-glossary-filter'), 'setup: focus in the search box')
    const before = docKeydownCount()
    key('Escape')
    assert(!body.find('pg-sheet-panel'), 'expected the glossary sheet to be removed')
    assert(document.activeElement === opener, 'expected focus back on the opener')
    assert(docKeydownCount() === before - 1, `expected the Escape listener torn down (had ${before}, now ${docKeydownCount()})`)
    // Spam: a second and third Escape must be inert.
    key('Escape')
    key('Escape')
    assert(!body.find('pg-sheet-panel'), 'still closed')
    assert(docKeydownCount() === before - 1, 'no listener may survive the close')
    return `listeners ${before} -> ${docKeydownCount()}`
  })

  test('the returned handle stays safe to call after that', () => {
    handle.destroy()
    assert(!body.find('pg-sheet-panel'), 'still gone')
  })
})

if (priorFetch === undefined) delete globalThis.fetch
else globalThis.fetch = priorFetch

test('ui/glossary.css no longer carries a forked copy of the sheet chrome', () => {
  const css = glossaryCss.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const gone of ['.pg-glossary-panel', '.pg-glossary-backdrop', '.pg-glossary-grabber', '.pg-glossary-header', '.pg-glossary-title', '.pg-glossary-close', 'pgGlossarySheetUp']) {
    assert(!css.includes(gone), `${gone} is still in ui/glossary.css — the chrome half was supposed to be deleted`)
  }
  // …and the content half is still there.
  for (const kept of ['.pg-glossary-filter', '.pg-glossary-list', '.pg-glossary-term', '.pg-glossary-section']) {
    assert(css.includes(kept), `${kept} was deleted from ui/glossary.css — only the CHROME was supposed to go`)
  }
  return 'chrome rules gone, filter/term-list rules kept'
})

// ===========================================================================
section('i. Tab-wrap freshness, stacked sheets, and dead-class hygiene (P4 review)')
// ===========================================================================

withSheet({ title: 'Glossary', maxHeightVh: 68, closeButton: true }, ({ host, key, handle }) => {
  test('the Tab-wrap focusable list is recomputed PER KEYDOWN, not cached at open', () => {
    // A cached list is the subtle bug here: the glossary's body arrives
    // asynchronously (after the fetch resolves) and re-renders on every
    // keystroke in the filter, so a list captured at open time would wrap to
    // rows that no longer exist — or, worse, to hidden ones.
    const rows = document.createElement('div')
    handle.setBody(rows)
    const closeBtn = host.find('pg-sheet-close')
    closeBtn.focus()
    key('Tab', true) // shift+Tab from the first focusable, with an EMPTY body
    assert(document.activeElement === closeBtn, 'with nothing else focusable, the wrap must stay on the ✕')

    // Now grow the body — exactly what loadGlossary().then does.
    const late = document.createElement('button')
    late.className = 'late-row'
    rows.appendChild(late)
    closeBtn.focus()
    key('Tab', true)
    assert(document.activeElement === late, 'shift+Tab must wrap to the row added AFTER the sheet opened — the query is stale/cached')

    // …and a row that is hidden must drop back out of the wrap.
    late.hidden = true
    closeBtn.focus()
    key('Tab', true)
    assert(document.activeElement === closeBtn, 'a hidden row must not be a wrap target')
    return 'empty -> 1 late row -> hidden again, re-queried each time'
  })
})

test('SINGLE-SHEET INVARIANT: per call site it is enforced in code; ACROSS call sites two sheets may legitimately stack', () => {
  // Documented rather than asserted-away, because "only one sheet can exist"
  // is FALSE for this app and pretending otherwise would be the wrong pin:
  //   * overlay/map2d.ts guards its own (`if (sheetHandle) { close; return }`)
  //     and closes the settings popover before opening — one sheet per tab.
  //   * ui/study.ts's toggleStudySheet has a single `sheetKind` — LEARN,
  //     ACTION BUTTON, DRILLS and ALT MODES are literally the same panel, so
  //     two cannot coexist. (P8 named that union `SheetKind` when it grew from
  //     two members to four; 2026-08-15 took it back to four by folding ALL
  //     SHOTS into LEARN. What this pins is that there is still exactly ONE
  //     such variable, not the length of the union.)
  //   * ui/glossary.ts is an OVERLAY-tier sheet reachable from the app header
  //     while a tab-local sheet is open. That stack is intended: it is why
  //     variant:'overlay' exists at all (z-index 200/201 over the header's 20).
  const map2dSrc = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
  assert(/if \(sheetHandle\) \{\s*closeGoalSheet\(\)/.test(map2dSrc), 'map2d.ts no longer guards against opening a second goal sheet')
  const studySrc = readFileSync(resolve(srcDir, 'ui/study.ts'), 'utf8')
  const kindDecls = studySrc.match(/^\s*let sheetKind\b.*$/gm) || []
  assert(kindDecls.length === 1, `study.ts must keep ONE sheetKind — two flags is how two panels get mounted at once (found ${kindDecls.length})`)
  assert(/let sheetKind: SheetKind \| null = null/.test(kindDecls[0]), `study.ts's sheet flag is no longer a single nullable kind: ${kindDecls[0].trim()}`)
  assert(/type SheetKind = (?:'[a-z]+' \| )+'[a-z]+'/.test(studySrc), 'expected SheetKind to be a closed union of kind names')
  return 'one sheet per call site; glossary-over-tab-sheet is the one intended stack'
})

withFakeDom(({ doc, body, key }) => {
  test('and that intended stack behaves: Escape dismisses the TOPMOST sheet only, then the one under it', () => {
    // CHANGED BY THE P8 REVIEW, and the old expectation was the bug. This
    // used to assert that ONE Escape dismissed BOTH sheets — which is what
    // happened, because both panels installed a document-level keydown
    // listener and neither knew the other existed. That is not modal
    // behaviour: pressing Escape with the glossary open over a tab's sheet
    // should close the glossary and leave the reader where they were, not
    // tear down the surface behind it too. ui/overlayStack.ts decides who
    // owns the keyboard; see its header for the Tab half of the same bug.
    const host = doc.createElement('div')
    body.appendChild(host)
    let localClosed = 0
    let overlayClosed = 0
    const local = createSheet(host, { title: 'Goals', maxHeightVh: 62, onDismiss: () => (localClosed++, local.destroy()) })
    const over = createSheet(doc.body, { title: 'Glossary', maxHeightVh: 68, variant: 'overlay', onDismiss: () => (overlayClosed++, over.destroy()) })
    assert(body.findAll('pg-sheet-panel').length === 2, 'setup: both sheets mounted')

    key('Escape')
    assert(overlayClosed === 1, `the overlay (topmost) should dismiss, got ${overlayClosed}`)
    assert(localClosed === 0, `the sheet UNDERNEATH must be left alone, got localClosed=${localClosed}`)
    assert(body.findAll('pg-sheet-panel').length === 1, 'expected exactly the local panel to survive')

    // With the overlay gone the local sheet is topmost again, and its own
    // Escape works — the gate suppresses, it does not permanently disable.
    key('Escape')
    assert(localClosed === 1, `the now-topmost local sheet should dismiss on the SECOND Escape, got ${localClosed}`)
    assert(body.findAll('pg-sheet-panel').length === 0, 'expected both panels removed by now')
    key('Escape') // no listeners left; must not throw
    return 'overlay dismisses first, local re-engages and dismisses second'
  })

  test('…and the same order holds when the LOCAL sheet is created last (tier beats registration order)', () => {
    // The half that makes this a fix rather than luck: if "topmost" were just
    // "most recently registered", opening a tab-local sheet after the overlay
    // would hand it the keyboard even though it paints underneath.
    const host = doc.createElement('div')
    body.appendChild(host)
    let localClosed = 0
    let overlayClosed = 0
    const over = createSheet(doc.body, { title: 'Glossary', maxHeightVh: 68, variant: 'overlay', onDismiss: () => (overlayClosed++, over.destroy()) })
    const local = createSheet(host, { title: 'Goals', maxHeightVh: 62, onDismiss: () => (localClosed++, local.destroy()) })
    key('Escape')
    assert(overlayClosed === 1 && localClosed === 0, `the overlay must still win despite being registered FIRST, got local=${localClosed} overlay=${overlayClosed}`)
    local.destroy()
    return 'overlay tier wins regardless of registration order'
  })
})

test('nothing anywhere still references the glossary’s retired close-button class — checked as CODE, not as prose', () => {
  // Comments legitimately still name it: both stylesheets explain what was
  // deleted and why. Same distinction card.test.mjs draws for the retired
  // Card tab — a bare substring search would fail on its own changelog.
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const offenders = []
  const checked = []
  for (const rel of ['ui/glossary.ts', 'ui/glossary.css', 'ui/sheet.ts', 'ui/sheet.css', 'app.ts', 'ar/arview.ts']) {
    let text
    try {
      text = readFileSync(resolve(srcDir, rel), 'utf8')
    } catch {
      continue
    }
    checked.push(rel)
    if (strip(text).includes('pg-glossary-close')) offenders.push(rel)
  }
  assert(checked.length >= 5, `only scanned ${checked.length} files — the walk is broken`)
  assert(offenders.length === 0, `these still name .pg-glossary-close in live code: ${offenders.join(', ')}`)
  // Prove the strip did not simply blank the files out.
  assert(strip(readFileSync(resolve(srcDir, 'ui/glossary.css'), 'utf8')).includes('.pg-glossary-filter'), 'the comment strip ate the real rules too')
  return `${checked.length} files, 0 live references (comments documenting the deletion are allowed)`
})

test('ui/glossary.ts builds no sheet chrome of its own any more — it calls createSheet', () => {
  assert(glossarySrc.includes("createSheet(document.body"), 'expected ui/glossary.ts to call createSheet against document.body')
  assert(glossarySrc.includes("variant: 'overlay'"), 'expected the overlay variant')
  for (const gone of ['pg-glossary-panel', 'pg-glossary-backdrop', 'pg-glossary-grabber', 'pg-glossary-header', 'pg-glossary-title', 'pg-glossary-close']) {
    assert(!glossarySrc.includes(`'${gone}'`), `ui/glossary.ts still creates a .${gone} element`)
  }
})

// ===========================================================================
section('j. STACKED TRAPS: the REAL glossary over the REAL Study sheet (P8 review blocker)')
// ===========================================================================
// THE BUG. Both surfaces are aria-modal dialogs with their own document-level
// keydown listener and their own focus trap, and section (i) above documents
// that they can legitimately be on screen together. Neither knew the other
// existed:
//   * TAB — the study trap sees an activeElement that is not in ITS ring,
//     concludes focus escaped, and drags the user out of the glossary they
//     are reading into a sheet they cannot see.
//   * ESCAPE — both handlers fire, so one press closes both.
// Neither is a study bug or a sheet bug; it is a missing answer to "who owns
// the keyboard", which ui/overlayStack.ts now gives. This section drives the
// REAL modules — mountStudy and openGlossary — against one document.

const STUDY_SHOTS = [
  { id: 's-a', name: 'Top Shot', type: 'ramp', x: 0.5, y: 0.9, trim: 'all', notes: 'Notes.' },
  { id: 's-b', name: 'Mid Shot', type: 'standup', x: 0.3, y: 0.5, trim: 'all' },
  { id: 's-c', name: 'Low Shot', type: 'lane', x: 0.6, y: 0.1, trim: 'all' },
]
function studyState() {
  return {
    machine: { id: 'stack-test', name: 'Stack Test', shortTitle: 'STACK', resource: 'stack_goals' },
    data: { machine: 'Stack Test', shots: STUDY_SHOTS, goals: [], sources: [], playfields: [] },
    trim: 'premium-le',
    onChange: () => () => {},
  }
}

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => GLOSSARY_FIXTURE })

await withFakeDom(async ({ doc, body, key, docKeydownCount }) => {
  resetOverlayStack()
  const host = doc.createElement('div')
  body.appendChild(host)
  const study = mountStudy(host, studyState())

  /** The tab ring a BROWSER would build for `panel`, which is what both traps
   *  have to agree with. Deliberately the FULL rule, not just buttons: the
   *  glossary's body carries a search INPUT, and a ring that only counted
   *  buttons put this test's idea of "the last control" somewhere the real
   *  trap does not wrap from — which reads as "the trap did not fire" when in
   *  fact the test was asking the wrong question. Hidden subtrees are skipped
   *  whole, exactly as display:none does. */
  const FOCUSABLE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'])
  const ringOf = (panel) => {
    const out = []
    const walk = (el) => {
      for (const c of el.children) {
        if (c.hidden) continue
        const tabindex = c.getAttribute?.('tabindex') ?? null
        const naturally = FOCUSABLE.has(c.tagName) && !(c.tagName === 'A' && !c.getAttribute?.('href'))
        if (c.disabled !== true && tabindex !== '-1' && (naturally || tabindex !== null)) out.push(c)
        walk(c)
      }
    }
    walk(panel)
    return out
  }

  host.find('study-learn-btn').dispatchEvent({ type: 'click' })
  const studyPanel = host.find('study-learn-panel')

  test('setup: the Study sheet is open, is a dialog, and owns the keyboard alone', () => {
    assert(studyPanel, 'expected the study sheet to open')
    assert(studyPanel.getAttribute('aria-modal') === 'true', 'expected an aria-modal dialog')
    assert(overlayDepth() === 1, `expected exactly one registered surface, got ${overlayDepth()}`)
    const ring = ringOf(studyPanel)
    ring[ring.length - 1].focus()
    assert(key('Tab') === true, 'its own trap works while it is the only dialog')
    assert(domActiveElement === ring[0], 'and wraps to its first control')
  })

  const glossary = await openGlossary()
  const glossaryPanel = body.findAll('pg-sheet-panel').find((p) => p !== studyPanel)

  test('the glossary opens ON TOP: both panels are mounted, both listeners live, and the stack knows the order', () => {
    assert(glossaryPanel, 'expected the glossary panel on document.body')
    assert(host.find('study-learn-panel') === studyPanel, 'the study sheet must still be mounted underneath')
    assert(docKeydownCount() === 2, `expected BOTH dialogs listening, got ${docKeydownCount()} — this test is worthless if only one is`)
    assert(overlayDepth() === 2, `expected two registered surfaces, got ${overlayDepth()}`)
  })

  test('TAB CYCLES INSIDE THE GLOSSARY ONLY — focus never lands in the occluded study sheet', () => {
    const gRing = ringOf(glossaryPanel)
    assert(gRing.length > 0, 'setup: the glossary has focusable controls')
    // Walk the ring past its end, twice round, and check every landing.
    for (let i = 0; i < gRing.length * 2 + 2; i++) {
      key('Tab')
      const inStudy = ringOf(studyPanel).includes(domActiveElement)
      assert(!inStudy, `Tab #${i + 1} put focus inside the OCCLUDED study sheet — that is the bug this section exists for`)
    }
    // And from the glossary's LAST control, the wrap goes to the glossary's
    // own first — not to the study sheet's Back button.
    gRing[gRing.length - 1].focus()
    assert(key('Tab') === true, 'the glossary trap must claim the Tab')
    assert(domActiveElement === gRing[0], 'expected the wrap to stay inside the glossary')
    return `${gRing.length} glossary controls, ${gRing.length * 2 + 2} Tabs, zero escapes into the sheet below`
  })

  test('SHIFT+TAB from the glossary’s first control wraps to its own last, not backwards into the sheet below', () => {
    const gRing = ringOf(glossaryPanel)
    gRing[0].focus()
    assert(key('Tab', true) === true, 'expected the glossary to claim it')
    assert(domActiveElement === gRing[gRing.length - 1], 'expected the wrap inside the glossary')
  })

  test('ESCAPE closes the GLOSSARY ONLY — the study sheet is still open behind it', () => {
    key('Escape')
    assert(!body.findAll('pg-sheet-panel').includes(glossaryPanel), 'expected the glossary panel removed')
    assert(host.find('study-learn-panel') === studyPanel, 'the study sheet must survive — one Escape, one dialog')
    assert(docKeydownCount() === 1, `expected only the study listener left, got ${docKeydownCount()}`)
    assert(overlayDepth() === 1, `expected the glossary unregistered, got depth ${overlayDepth()}`)
  })

  test('…and the STUDY trap re-engages now that it is topmost again', () => {
    const ring = ringOf(studyPanel)
    ring[ring.length - 1].focus()
    assert(key('Tab') === true, 'the study trap must answer again — the gate suppresses, it never permanently disables')
    assert(domActiveElement === ring[0], 'expected its own wrap back')
  })

  test('a second ESCAPE closes the study sheet, and nothing is left registered', () => {
    key('Escape')
    assert(!host.find('study-learn-panel'), 'expected the study sheet closed by its own Escape')
    assert(docKeydownCount() === 0, `expected no dialog listeners left, got ${docKeydownCount()}`)
    assert(overlayDepth() === 0, `expected an empty overlay stack, got ${overlayDepth()}`)
    key('Escape') // nothing left to answer; must not throw
    return 'glossary -> study -> empty, one Escape each'
  })

  glossary?.destroy?.()
  study.destroy()
})

globalThis.fetch = priorFetch

// ===========================================================================
section('k. A DIALOG ON A TAB YOU HAVE LEFT OWNS NOTHING (QA sweep, 2026-08-14)')
// ===========================================================================
// FOUND IN CHROME, on the built app, walking the tab x machine matrix: open the
// Study tab's LEARN sheet, then switch to Shots. The sheet stays in the DOM by
// design (it is not torn down on a tab switch) — but its whole panel is now
// inside a `display: none` tab panel, and its keydown handler is still on
// `document`. Measured there: Tab was intercepted by the invisible dialog's
// focus trap, and Escape closed it. A keyboard user reading the Shots tab got
// pulled into a dialog they could not see.
//
// The fake DOM has no layout, so `isRendered` treats every fake element as
// rendered — which is right for every other test here, and useless for this
// one. So this section gives the panel the ONE piece of layout the rule reads:
// `getClientRects()`, empty exactly as it is for a display:none subtree.

withFakeDom(({ doc, body, key, docKeydownCount }) => {
  resetOverlayStack()
  const host = doc.createElement('div')
  body.appendChild(host)
  let dismissed = 0
  const sheet = createSheet(host, { title: 'Goals', maxHeightVh: 62, onDismiss: () => (dismissed += 1) })
  const panel = body.findAll('pg-sheet-panel')[0]
  assert(panel, 'setup: expected a sheet panel')

  test('while its panel IS rendered, the sheet answers Escape and traps Tab as usual', () => {
    assert(docKeydownCount() === 1, 'setup: the sheet is listening')
    key('Escape')
    assert(dismissed === 1, `expected the visible sheet to dismiss, got ${dismissed}`)
    assert(key('Tab') === true, 'a visible sheet still traps Tab')
  })

  test('with the panel in a display:none subtree, Escape and Tab are BOTH ignored', () => {
    // display: none — no client rects. This is the only signal isRendered reads.
    panel.getClientRects = () => []
    const before = dismissed
    key('Escape')
    assert(dismissed === before, `an unrendered dialog must not answer Escape (dismiss count ${before} -> ${dismissed})`)
    assert(key('Tab') === false, 'an unrendered dialog must not intercept Tab — that is the trap the sweep found')
  })

  test('…and it answers again the moment its tab comes back', () => {
    panel.getClientRects = () => [{ width: 300, height: 200 }]
    const before = dismissed
    key('Escape')
    assert(dismissed === before + 1, 'the guard suppresses while hidden; it must not disable the sheet for good')
  })

  test('an unrendered sheet does not SHADOW a visible one: the glossary over a left-behind tab sheet still wins', () => {
    // The other half of the fix. If a hidden panel stayed "topmost", the
    // dialog actually on screen would be outranked by one nobody can see.
    // BOTH AT THE SAME TIER, with the hidden one registered LAST. A tier
    // difference would decide this on its own and the test would pass whether
    // or not unrendered surfaces are skipped — the shadowing rule has to be
    // the only thing that can produce the right answer.
    resetOverlayStack()
    const visibleHost = doc.createElement('div')
    const hiddenHost = doc.createElement('div')
    body.append(visibleHost, hiddenHost)
    let visibleDismissed = 0
    let hiddenDismissed = 0
    const visible = createSheet(visibleHost, { title: 'On screen', maxHeightVh: 62, onDismiss: () => (visibleDismissed += 1) })
    const left = createSheet(hiddenHost, { title: 'Left behind', maxHeightVh: 62, onDismiss: () => (hiddenDismissed += 1) })
    const leftPanel = body.findAll('pg-sheet-panel').find((x) => x.find('pg-sheet-title')?.textContent === 'Left behind')
    leftPanel.getClientRects = () => [] // its tab was switched away from
    key('Escape')
    assert(hiddenDismissed === 0, `the hidden sheet must stay out of it, got ${hiddenDismissed}`)
    assert(visibleDismissed === 1, `the sheet actually on screen must answer, got ${visibleDismissed} — an invisible sheet registered later is shadowing it`)
    left.destroy()
    visible.destroy()
    return 'the later-registered INVISIBLE sheet did not shadow the visible one'
  })

  sheet.destroy()
})

// The same rule on the surface that actually exhibited it in Chrome: the
// STUDY tab's bespoke sheet, which is the one that survives a tab switch.
withFakeDom(({ doc, body, key, docKeydownCount }) => {
  resetOverlayStack()
  const host = doc.createElement('div')
  body.appendChild(host)
  const study = mountStudy(host, studyState())
  host.find('study-learn-btn').dispatchEvent({ type: 'click' })
  const panel = host.find('study-learn-panel')

  test('the STUDY sheet ignores the keyboard while its tab panel is hidden, and resumes when it is back', () => {
    assert(panel, 'setup: the study sheet is open')
    assert(docKeydownCount() === 1, 'setup: it is listening')
    // Visible: Escape closes it (the contract section j already pins).
    // Hidden: neither key reaches it. This is the exact state the QA sweep
    // caught — LEARN open, user switches to Shots, Tab gets intercepted by a
    // dialog inside a display:none panel and Escape closes it unseen.
    panel.getClientRects = () => []
    assert(key('Tab') === false, 'an invisible study sheet must not intercept Tab')
    key('Escape')
    assert(host.find('study-learn-panel') === panel, 'an invisible study sheet must not close on Escape')

    panel.getClientRects = () => [{ width: 300, height: 200 }]
    key('Escape')
    assert(!host.find('study-learn-panel'), 'and it must answer again once its tab is showing')
    return 'hidden: Tab and Escape ignored; visible: Escape closes'
  })

  study.destroy()
})

test('isRendered uses client rects, not offsetParent — the glossary is position:fixed', () => {
  // An offsetParent test would have read `null` for every overlay-variant
  // sheet and silently disabled the tier that needs the trap most.
  const src = readFileSync(resolve(srcDir, 'ui/overlayStack.ts'), 'utf8')
  // CODE ONLY — the comment there explains why offsetParent was rejected, and
  // a naive scan of the whole file would fail on the explanation itself.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(/getClientRects/.test(code), 'isRendered no longer reads getClientRects')
  assert(!/offsetParent/.test(code), 'isRendered must not use offsetParent: position:fixed elements report null for it')
  // And the fake-DOM escape hatch has to stay, or every focus test in this repo
  // starts asserting nothing at all.
  assert(/typeof el\.getClientRects !== 'function'/.test(src), 'elements with no layout API must be treated as rendered')
})

await rm(tmp, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
