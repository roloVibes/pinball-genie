#!/usr/bin/env node
// app/tests/offline.test.mjs — ui/offline.ts: the offline pill and the
// service-worker registration (2026-10-14).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/offline.test.mjs"
//
// WHAT IT CLAIMS.
//   1. THE PILL is a live region (role="status"), so goal-bridge.test.mjs's
//      live-region-owner gate demands this module prove it is PER-INSTANCE:
//      exactly one on screen however many `offline` events fire, removed (not
//      hidden) on `online`, and a FRESH node the next time — never a shared
//      node left behind to go stale. Plus the body class that lifts the toast.
//   2. REGISTRATION is production-only, waits for `load`, targets /sw.js, and
//      a rejected register() is swallowed (a warning, never an unhandled
//      rejection). The service worker itself is sw.test.mjs's subject.
//
// HOW. esbuild bundles the REAL ui/offline.ts (never edited, never copied)
// twice — once with import.meta.env.PROD defined true, once false — and each
// bundle runs against a small fake window/document/navigator built here.

import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const offlinePath = resolve(__dirname, '../src/ui/offline.ts')
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-offline-'))

async function bundle(prod) {
  const outfile = resolve(tmp, `offline-${prod ? 'prod' : 'dev'}.mjs`)
  await build({
    entryPoints: [offlinePath],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    define: { 'import.meta.env.PROD': prod ? 'true' : 'false' },
  })
  // A query string makes each import a distinct module instance, so module
  // state (the one pill) never leaks from one scenario into the next.
  return (tag) => import(`${pathToFileURL(outfile).href}?${tag}`)
}

// ---- fake DOM: just enough for ui/offline.ts ---------------------------------

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentElement = null
    this.attrs = {}
    this.className = ''
    this._text = ''
    const classes = new Set()
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    }
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null
  }
  append(...kids) {
    for (const k of kids) this.appendChild(k)
  }
  appendChild(k) {
    k.parentElement = this
    this.children.push(k)
    return k
  }
  remove() {
    if (!this.parentElement) return
    const sib = this.parentElement.children
    sib.splice(sib.indexOf(this), 1)
    this.parentElement = null
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('')
  }
  set textContent(v) {
    this._text = String(v)
  }
  byClass(c) {
    return this.children.filter((k) => k.className.split(/\s+/).includes(c))
  }
}

/** Installs a fresh fake environment on globalThis. Returns its handles. */
function installEnv({ onLine = true, readyState = 'complete', sw = 'ok' } = {}) {
  const listeners = {}
  const registered = []
  const warnings = []
  const body = new El('body')
  globalThis.document = { body, readyState, createElement: (t) => new El(t) }
  globalThis.window = {
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
  }
  const nav = { onLine }
  if (sw !== 'absent') {
    nav.serviceWorker = {
      register: (url) => {
        registered.push(url)
        return sw === 'reject' ? Promise.reject(new Error('blocked')) : Promise.resolve({})
      },
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true })
  console.warn = (...a) => warnings.push(a.join(' '))
  const fire = (type) => {
    for (const fn of listeners[type] || []) fn()
  }
  return { body, listeners, registered, warnings, fire, nav }
}

// ---- runner ------------------------------------------------------------------

const realWarn = console.warn
let failed = 0
let passed = 0
let n = 0
async function test(name, fn) {
  try {
    const detail = await fn()
    passed++
    console.log(`PASS  ${name}${detail ? `\n        ${detail}` : ''}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n        ${err && err.message ? err.message : err}`)
  }
}
function assert(c, m) {
  if (!c) throw new Error(m)
}
const pills = (body) => body.byClass('pg-offline')
const prodMod = await bundle(true)
const devMod = await bundle(false)

// ---- 1. the pill ---------------------------------------------------------------

await test('online at boot: no pill, no body class', async () => {
  const env = installEnv({ onLine: true })
  const m = await prodMod(++n)
  m.installOfflineIndicator()
  assert(pills(env.body).length === 0, 'a pill appeared while online')
  assert(!env.body.classList.contains('pg-is-offline'), 'body class set while online')
})

await test('offline at boot: ONE polite live region on document.body with the copy', async () => {
  const env = installEnv({ onLine: false })
  const m = await prodMod(++n)
  m.installOfflineIndicator()
  const p = pills(env.body)
  assert(p.length === 1, `expected 1 pill, got ${p.length}`)
  assert(p[0].getAttribute('role') === 'status', `role=${p[0].getAttribute('role')}`)
  assert(p[0].textContent === 'Offline — showing saved tables', `text was "${p[0].textContent}"`)
  assert(p[0].byClass('pg-offline-dot')[0]?.getAttribute('aria-hidden') === 'true', 'the dot must be aria-hidden')
  assert(env.body.classList.contains('pg-is-offline'), 'body class missing (the toast would land on the pill)')
  return `"${p[0].textContent}"`
})

await test('repeated `offline` events never stack a second pill', async () => {
  const env = installEnv({ onLine: true })
  const m = await prodMod(++n)
  m.installOfflineIndicator()
  env.fire('offline')
  env.fire('offline')
  env.fire('offline')
  assert(pills(env.body).length === 1, `expected 1 pill, got ${pills(env.body).length}`)
})

await test('`online` REMOVES the pill (not hides) and clears the body class', async () => {
  const env = installEnv({ onLine: false })
  const m = await prodMod(++n)
  m.installOfflineIndicator()
  const first = pills(env.body)[0]
  env.fire('online')
  assert(pills(env.body).length === 0, 'pill still in the document after `online`')
  assert(first.parentElement === null, 'the old node is still attached somewhere')
  assert(!env.body.classList.contains('pg-is-offline'), 'body class left behind')
})

await test('PER-INSTANCE: going offline again mounts a FRESH node, not the stale one', async () => {
  const env = installEnv({ onLine: false })
  const m = await prodMod(++n)
  m.installOfflineIndicator()
  const first = pills(env.body)[0]
  env.fire('online')
  env.fire('offline')
  const p = pills(env.body)
  assert(p.length === 1, `expected 1 pill, got ${p.length}`)
  assert(p[0] !== first, 'the stale live region was re-used')
  assert(p[0].textContent === 'Offline — showing saved tables', 'the fresh pill has no copy')
  return 'offline → online → offline: one pill, a new node'
})

// ---- 2. registration -------------------------------------------------------------

await test('production, page already loaded: registers /sw.js once', async () => {
  const env = installEnv({ readyState: 'complete' })
  const m = await prodMod(++n)
  m.registerServiceWorker()
  assert(JSON.stringify(env.registered) === '["/sw.js"]', `registered ${JSON.stringify(env.registered)}`)
})

await test('production, still loading: waits for `load`, then registers', async () => {
  const env = installEnv({ readyState: 'interactive' })
  const m = await prodMod(++n)
  m.registerServiceWorker()
  assert(env.registered.length === 0, 'registered before `load` — competes with first paint')
  env.fire('load')
  assert(JSON.stringify(env.registered) === '["/sw.js"]', `after load: ${JSON.stringify(env.registered)}`)
})

await test('dev build (vite dev): never registers', async () => {
  const env = installEnv({ readyState: 'complete' })
  const m = await devMod(++n)
  m.registerServiceWorker()
  env.fire('load')
  assert(env.registered.length === 0, 'a dev build registered the worker')
})

await test('no serviceWorker support: a silent no-op, no throw', async () => {
  installEnv({ sw: 'absent' })
  const m = await prodMod(++n)
  m.registerServiceWorker()
})

await test('a REJECTED register() is caught and logged, never an unhandled rejection', async () => {
  let unhandled = null
  const onUnhandled = (r) => (unhandled = r)
  process.on('unhandledRejection', onUnhandled)
  const env = installEnv({ sw: 'reject' })
  const m = await prodMod(++n)
  m.registerServiceWorker()
  await new Promise((r) => setTimeout(r, 20))
  process.off('unhandledRejection', onUnhandled)
  assert(unhandled === null, `unhandled rejection: ${unhandled}`)
  assert(env.warnings.some((w) => w.includes('service worker registration failed')), 'no warning logged')
})

console.warn = realWarn
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
