#!/usr/bin/env node
// app/tests/sw.test.mjs — the offline service worker (app/public/sw.js).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/sw.test.mjs"
//
// WHY THIS SUITE EXISTS. A service worker's bugs are the worst kind to find in
// the field: they persist across reloads, they only show up after a deploy or
// on bad Wi-Fi, and the visitor cannot clear them by doing anything obvious.
// The two that matter for THIS app, both checked below:
//   * caching a non-OK response (a 404 for a chunk deploy-prod.sh pruned) and
//     then serving it forever, and
//   * answering from cache while the network is up — after a deploy that
//     strands people on an index.html whose chunks no longer exist.
//
// HOW. sw.js is plain JS with no imports, so it is evaluated as-is in a
// node:vm context whose `self`, `caches` and `fetch` are fakes recorded here.
// Response/Request/URL are Node's real WHATWG implementations, so body
// cloning and `.ok` behave exactly as in a browser. Every test gets a fresh
// context: nothing leaks from one scenario into the next.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SW_SRC = readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8')
const ORIGIN = 'https://pinball-genie.com'

// ---- fakes -----------------------------------------------------------------

/** One named cache, keyed by absolute URL (what the real Cache API matches on
 *  for a GET with no Vary). match() hands back a CLONE, like the real thing, so
 *  a test reading a body never empties the stored copy. */
class FakeCache {
  constructor() {
    this.store = new Map()
  }
  #key(k) {
    return typeof k === 'string' ? new URL(k, ORIGIN).href : k.url
  }
  async match(k) {
    const r = this.store.get(this.#key(k))
    return r ? r.clone() : undefined
  }
  async put(k, res) {
    this.store.set(this.#key(k), res)
  }
  async delete(k) {
    return this.store.delete(this.#key(k))
  }
  async keys() {
    return [...this.store.keys()].map((url) => new Request(url))
  }
}

class FakeCacheStorage {
  constructor() {
    this.map = new Map()
  }
  async open(name) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache())
    return this.map.get(name)
  }
  async keys() {
    return [...this.map.keys()]
  }
  async delete(name) {
    return this.map.delete(name)
  }
}

/** What a browser's same-origin fetch() resolves to: a Response whose `type`
 *  is 'basic'. Node's constructor always says 'default' and cannot be told
 *  otherwise, so the property is set on the instance. */
function net(body, status = 200) {
  const r = new Response(body, { status })
  Object.defineProperty(r, 'type', { value: 'basic' })
  return r
}

/** A same-origin answer that followed a redirect (also not constructible). */
function redirectedResponse(body) {
  const r = net(body)
  Object.defineProperty(r, 'redirected', { value: true })
  return r
}

/** Boots sw.js in a fresh context. `net` decides what the network does for
 *  each request: return a Response, or throw to simulate being offline. */
function loadWorker(net) {
  const listeners = {}
  const fetchLog = []
  const caches = new FakeCacheStorage()
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type, fn) => {
      listeners[type] = fn
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  const fetchFn = async (req) => {
    fetchLog.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`)
    return net(req)
  }
  // MANUAL timers: nothing fires until a test calls fireTimers(), so "the
  // timer won" and "the network won" are decided by the test, not by the
  // machine's speed — and no test ever sleeps 3.5 real seconds.
  const timers = []
  const fakeSetTimeout = (fn, ms) => {
    timers.push({ fn, ms, cleared: false, fired: false })
    return timers.length - 1
  }
  const fakeClearTimeout = (h) => {
    if (timers[h]) timers[h].cleared = true
  }
  const fireTimers = () => {
    for (const t of timers) {
      if (!t.cleared && !t.fired) {
        t.fired = true
        t.fn()
      }
    }
  }
  const ctx = vm.createContext({
    self, caches, fetch: fetchFn, URL, Request, Response, Promise, console,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  })
  vm.runInContext(SW_SRC, ctx, { filename: 'sw.js' })

  /** Dispatches a fetch event WITHOUT awaiting it. `response` is the promise
   *  handed to respondWith (null = passthrough); `kept` settles when every
   *  promise handed to waitUntil has — i.e. when the worker could be stopped. */
  function start(path, init = {}) {
    let responded = null
    const extended = []
    const event = {
      request: new Request(new URL(path, ORIGIN).href, init),
      respondWith: (p) => {
        responded = p
      },
      waitUntil: (p) => {
        extended.push(p)
      },
    }
    listeners.fetch(event)
    return { response: responded, kept: Promise.all(extended) }
  }

  /** Dispatches a fetch event. Resolves to the Response the worker answered
   *  with, or to the string 'passthrough' if it did not call respondWith(). */
  async function dispatch(path, init = {}) {
    const { response, kept } = start(path, init)
    if (response === null) return 'passthrough'
    const r = await response
    await kept
    return r
  }
  return { listeners, caches, fetchLog, dispatch, start, timers, fireTimers }
}

/** A promise the test resolves by hand: the network "taking its time". */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

/** Lets every already-queued promise reaction run (several turns, since the
 *  worker chains a few awaits between steps). */
const flush = () => new Promise((r) => setImmediate(r))

const ok = (body) => net(body)
const offline = () => {
  throw new TypeError('Failed to fetch')
}

// ---- runner ----------------------------------------------------------------

let failed = 0
let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
async function cachedPaths(caches) {
  const names = await caches.keys()
  assert(names.length === 1, `expected exactly one cache, found ${JSON.stringify(names)}`)
  const c = await caches.open(names[0])
  return [...c.store.keys()].map((u) => new URL(u).pathname).sort()
}

// ---- tests -----------------------------------------------------------------

await test('registers install, activate and fetch listeners', async () => {
  const w = loadWorker(() => ok('x'))
  for (const t of ['install', 'activate', 'fetch']) assert(typeof w.listeners[t] === 'function', `no ${t} listener`)
})

await test('non-GET requests pass through untouched (POST, PUT, DELETE, HEAD)', async () => {
  const w = loadWorker(() => ok('x'))
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    // Even on a path the worker otherwise handles.
    const r = await w.dispatch('/data/catalog.json', { method })
    assert(r === 'passthrough', `${method} was intercepted`)
  }
  assert(w.fetchLog.length === 0, `worker fetched on its own: ${w.fetchLog}`)
})

await test('excluded paths pass through: /auth/*, /api/*, /whoami, /manifest.webmanifest', async () => {
  const w = loadWorker(() => ok('x'))
  for (const p of ['/auth/verify?token=a.b', '/auth/export', '/api/achievements', '/whoami', '/manifest.webmanifest']) {
    assert((await w.dispatch(p)) === 'passthrough', `${p} was intercepted`)
  }
  assert((await w.caches.keys()).length === 0, 'an excluded path created a cache')
})

await test('paths outside the allowlist and other origins pass through', async () => {
  const w = loadWorker(() => ok('x'))
  for (const p of ['/login', '/privacy', '/machines/jaws/', '/data/notes.txt', 'https://example.com/assets/x.js']) {
    assert((await w.dispatch(p)) === 'passthrough', `${p} was intercepted`)
  }
})

await test('allowlisted paths are handled: shell, assets, data json, fonts, icons, favicons', async () => {
  const w = loadWorker(() => ok('x'))
  for (const p of [
    '/',
    '/index.html',
    '/assets/index-abc123.js',
    '/data/catalog.json',
    '/fonts/ChakraPetch-Bold-latin.woff2',
    '/icons/icon-192.png',
    '/favicon.ico',
    '/favicon-48.png',
  ]) {
    const r = await w.dispatch(p)
    assert(r instanceof Response, `${p} was not handled`)
  }
})

await test('network-first: online, the NETWORK answer is served even when a cached copy exists', async () => {
  let version = 'v1'
  const w = loadWorker(() => ok(`catalog ${version}`))
  assert((await (await w.dispatch('/data/catalog.json')).text()) === 'catalog v1', 'first fetch wrong')
  version = 'v2'
  const r = await w.dispatch('/data/catalog.json')
  assert((await r.text()) === 'catalog v2', 'served the cached copy while the network was up (cache-first)')
  assert(w.fetchLog.length === 2, `expected 2 network fetches, got ${w.fetchLog.length}`)
})

await test('cache fallback: offline, the last good copy is served', async () => {
  let up = true
  const w = loadWorker(() => (up ? ok('goals for jaws') : offline()))
  await w.dispatch('/data/jaws_goals.json')
  up = false
  const r = await w.dispatch('/data/jaws_goals.json')
  assert(r instanceof Response && (await r.text()) === 'goals for jaws', 'offline did not fall back to the cache')
})

await test('offline with NOTHING cached rejects (a real network error), not a fabricated response', async () => {
  const w = loadWorker(offline)
  let threw = false
  try {
    await w.dispatch('/data/never_seen_goals.json')
  } catch {
    threw = true
  }
  assert(threw, 'expected the respondWith promise to reject')
})

await test('shell spellings share ONE cache key ("/", "/index.html", "/?_r=…")', async () => {
  let up = true
  const w = loadWorker(() => (up ? ok('<html>shell</html>') : offline()))
  await w.dispatch('/?_r=1700000000000')
  await w.dispatch('/index.html')
  await w.dispatch('/?verified=1')
  assert(JSON.stringify(await cachedPaths(w.caches)) === '["/"]', `shell stored under several keys: ${await cachedPaths(w.caches)}`)
  up = false
  for (const p of ['/', '/index.html', '/?_r=42']) {
    const r = await w.dispatch(p)
    assert((await r.text()) === '<html>shell</html>', `offline ${p} missed the shell`)
  }
})

await test('non-OK responses are NOT cached (404 pruned chunk, 500)', async () => {
  const w = loadWorker((req) => (new URL(req.url).pathname.endsWith('gone.js') ? net('not found', 404) : net('boom', 500)))
  const r404 = await w.dispatch('/assets/index-gone.js')
  assert(r404.status === 404, `expected the real 404 to pass through, got ${r404.status}`)
  const r500 = await w.dispatch('/data/catalog.json')
  assert(r500.status === 500, `expected the real 500 to pass through, got ${r500.status}`)
  const c = await w.caches.open((await w.caches.keys())[0])
  assert(c.store.size === 0, `a non-OK response was cached: ${[...c.store.keys()]}`)
})

await test('non-OK with a cached copy: serves the cache, and the good copy survives', async () => {
  let status = 200
  const w = loadWorker(() => net(status === 200 ? 'good data' : 'server error', status))
  await w.dispatch('/data/catalog.json')
  status = 503
  const r = await w.dispatch('/data/catalog.json')
  assert(r.status === 200 && (await r.text()) === 'good data', 'did not fall back to the cached good copy')
  const c = await w.caches.open((await w.caches.keys())[0])
  assert((await (await c.match('/data/catalog.json')).text()) === 'good data', 'the 503 overwrote the good copy')
})

// ---- deliberate server answers beat the saved copy -------------------------
// Only a network failure, the deadline, or a 5xx may swap in the cached copy.
// A redirect or an auth/404 answer is the server DECIDING something, and
// covering it with the saved copy would show the app to a visitor the session
// gate just turned away (or hide a pruned chunk from ui/chunkError.ts).

/** What a navigation fetch with redirect:'manual' resolves to on a 3xx: an
 *  'opaqueredirect' response with status 0. Node cannot construct one, so it
 *  is Response.error() (also status 0) relabelled. */
function opaqueRedirect() {
  const r = Response.error()
  Object.defineProperty(r, 'type', { value: 'opaqueredirect' })
  return r
}

/** Seeds a good copy of `path`, then flips the network to `later()`. */
async function cachedThen(path, seedBody, later) {
  const gate = { seeded: false }
  const w = loadWorker(() => (gate.seeded ? later() : ok(seedBody)))
  await w.dispatch(path)
  gate.seeded = true
  return w
}

await test('cached SHELL + opaqueredirect (signed out → /login): the redirect is returned, not the cached app', async () => {
  const w = await cachedThen('/', '<html>good shell</html>', opaqueRedirect)
  const r = await w.dispatch('/')
  assert(r.type === 'opaqueredirect', `expected the redirect, got type=${r.type} status=${r.status}`)
  const c = await w.caches.open((await w.caches.keys())[0])
  assert((await (await c.match('/')).text()) === '<html>good shell</html>', 'the redirect overwrote the saved shell')
})

await test('cached SHELL + followed redirect (redirected:true) and a 302: returned as-is, never cached', async () => {
  for (const make of [() => redirectedResponse('<html>login page</html>'), () => net('', 302)]) {
    const w = await cachedThen('/', '<html>good shell</html>', make)
    const r = await w.dispatch('/')
    const body = await r.text()
    assert(body !== '<html>good shell</html>', `a ${r.status}${r.redirected ? ' redirected' : ''} answer was replaced by the cached shell`)
    const c = await w.caches.open((await w.caches.keys())[0])
    assert((await (await c.match('/')).text()) === '<html>good shell</html>', 'the redirect overwrote the saved shell')
  }
})

await test('cached DATA + 401 / 403: the auth answer is returned, not the cached copy', async () => {
  for (const status of [401, 403]) {
    const w = await cachedThen('/data/catalog.json', 'good data', () => net('nope', status))
    const r = await w.dispatch('/data/catalog.json')
    assert(r.status === status, `expected the real ${status}, got ${r.status}`)
    const c = await w.caches.open((await w.caches.keys())[0])
    assert((await (await c.match('/data/catalog.json')).text()) === 'good data', `the ${status} overwrote the saved copy`)
  }
})

await test('cached CHUNK + 404 (deploy pruned it): the 404 is returned so chunkError.ts can see it', async () => {
  const w = await cachedThen('/assets/index-old.js', 'old chunk', () => net('not found', 404))
  const r = await w.dispatch('/assets/index-old.js')
  assert(r.status === 404, `expected the real 404, got ${r.status}`)
})

await test('cached + 503 / 500: the cached copy is served (a 5xx is a failure, not a decision)', async () => {
  for (const status of [500, 503]) {
    const w = await cachedThen('/data/catalog.json', 'good data', () => net('server error', status))
    const r = await w.dispatch('/data/catalog.json')
    assert(r.status === 200 && (await r.text()) === 'good data', `a ${status} was not covered by the saved copy`)
  }
})

await test('a REDIRECTED shell (staging: "/" → /login) is not cached as the app', async () => {
  const w = loadWorker(() => redirectedResponse('<html>login page</html>'))
  await w.dispatch('/')
  const c = await w.caches.open((await w.caches.keys())[0])
  assert(c.store.size === 0, 'cached the login redirect under the shell key')
})

await test('a NEW shell (deploy) purges cached /assets/* but keeps data, fonts and the new shell', async () => {
  let build = 'A'
  const w = loadWorker((req) => {
    const p = new URL(req.url).pathname
    return ok(p === '/' ? `<html>build ${build}</html>` : `body of ${p}`)
  })
  await w.dispatch('/')
  await w.dispatch('/assets/index-AAAA.js')
  await w.dispatch('/data/catalog.json')
  await w.dispatch('/fonts/ChakraPetch-Bold-latin.woff2')
  // Same shell again: nothing purged.
  await w.dispatch('/')
  assert((await cachedPaths(w.caches)).includes('/assets/index-AAAA.js'), 'purged assets on an UNCHANGED shell')
  // Deploy.
  build = 'B'
  await w.dispatch('/')
  await w.dispatch('/assets/index-BBBB.js')
  const paths = await cachedPaths(w.caches)
  const want = ['/', '/assets/index-BBBB.js', '/data/catalog.json', '/fonts/ChakraPetch-Bold-latin.woff2']
  assert(JSON.stringify(paths) === JSON.stringify(want), `after deploy expected ${JSON.stringify(want)}, got ${JSON.stringify(paths)}`)
  const c = await w.caches.open((await w.caches.keys())[0])
  assert((await (await c.match('/')).text()) === '<html>build B</html>', 'shell not updated to the new build')
})

// ---- slow-but-connected (lie-fi): the 3500 ms deadline ----------------------

/** Seeds one cached copy of `path`, then makes every later fetch hang on a
 *  deferred the test resolves by hand. */
async function slowWorkerWithCached(path, seedBody) {
  const gate = { d: null }
  const w = loadWorker(() => (gate.d ? gate.d.promise : ok(seedBody)))
  await w.dispatch(path)
  assert(w.timers.length === 0, 'the seeding fetch (nothing cached yet) armed a timer')
  gate.d = deferred()
  return { w, d: gate.d }
}

await test('SLOW + cached: the timer wins → cached copy served, cache refreshed when the network lands', async () => {
  const { w, d } = await slowWorkerWithCached('/data/catalog.json', 'catalog v1')
  const { response, kept } = w.start('/data/catalog.json')
  let answered = false
  response.then(() => (answered = true))
  await flush()
  assert(!answered, 'answered from cache BEFORE the deadline — that is cache-first')
  const armed = w.timers.filter((t) => !t.cleared && !t.fired)
  assert(armed.length === 1 && armed[0].ms === 3500, `expected one 3500 ms timer, got ${JSON.stringify(armed.map((t) => t.ms))}`)
  w.fireTimers()
  const r = await response
  assert((await r.text()) === 'catalog v1', 'the timed-out request did not get the cached copy')
  let released = false
  kept.then(() => (released = true))
  await flush()
  assert(!released, 'waitUntil released while the background fetch was still running — the worker could be killed first')
  d.resolve(net('catalog v2'))
  await kept
  const c = await w.caches.open((await w.caches.keys())[0])
  assert((await (await c.match('/data/catalog.json')).text()) === 'catalog v2', 'the late network answer did not refresh the cache')
  return 'cached v1 at the deadline, cache = v2 once the network returned'
})

await test('SLOW + cached: a late NON-OK / REDIRECTED answer does not overwrite the saved copy', async () => {
  for (const late of [net('server error', 503), redirectedResponse('<html>login</html>')]) {
    const { w, d } = await slowWorkerWithCached('/', '<html>good shell</html>')
    const { response, kept } = w.start('/')
    await flush()
    w.fireTimers()
    assert((await (await response).text()) === '<html>good shell</html>', 'timed-out shell request not served from cache')
    d.resolve(late)
    await kept
    const c = await w.caches.open((await w.caches.keys())[0])
    assert((await (await c.match('/')).text()) === '<html>good shell</html>', `a late ${late.status}${late.redirected ? ' redirect' : ''} overwrote the shell`)
  }
})

await test('SLOW + cached: a background SHELL refresh still runs the new-deploy asset purge', async () => {
  let slow = null
  const w = loadWorker((req) => {
    const p = new URL(req.url).pathname
    if (p === '/' && slow) return slow.promise
    return ok(p === '/' ? '<html>build A</html>' : `body of ${p}`)
  })
  await w.dispatch('/')
  await w.dispatch('/assets/index-AAAA.js')
  slow = deferred()
  const { response, kept } = w.start('/')
  await flush()
  w.fireTimers()
  assert((await (await response).text()) === '<html>build A</html>', 'timed-out shell request not served from cache')
  // The deploy's new shell arrives late, in the background.
  slow.resolve(net('<html>build B</html>'))
  await kept
  const paths = await cachedPaths(w.caches)
  assert(JSON.stringify(paths) === '["/"]', `old-build chunk survived a background shell change: ${JSON.stringify(paths)}`)
  const c = await w.caches.open((await w.caches.keys())[0])
  assert((await (await c.match('/')).text()) === '<html>build B</html>', 'background refresh did not store the new shell')
})

await test('SLOW + NOTHING cached: no deadline — the request waits for the real answer', async () => {
  const d = deferred()
  const w = loadWorker(() => d.promise)
  const { response } = w.start('/data/first_visit_goals.json')
  let answered = false
  response.then(() => (answered = true))
  await flush()
  assert(w.timers.length === 0, 'a timer was armed with nothing cached to fall back to')
  w.fireTimers()
  await flush()
  assert(!answered, 'answered without the network (nothing cached — there is nothing to answer with)')
  d.resolve(net('the real goals'))
  assert((await (await response).text()) === 'the real goals', 'did not get the network answer')
})

await test('cached + the network answers BEFORE the deadline → the network response, timer cleared', async () => {
  const { w, d } = await slowWorkerWithCached('/data/catalog.json', 'catalog v1')
  const { response, kept } = w.start('/data/catalog.json')
  await flush()
  d.resolve(net('catalog v2'))
  const r = await response
  await kept
  assert((await r.text()) === 'catalog v2', 'served the cache although the network answered in time')
  const t = w.timers[w.timers.length - 1]
  assert(t && t.cleared && !t.fired, 'the deadline timer was not cleared after the network won')
})

await test('activate deletes every cache except the current one', async () => {
  const w = loadWorker(() => ok('x'))
  // Learn the current cache name the honest way: let the worker create it.
  await w.dispatch('/data/catalog.json')
  const [current] = await w.caches.keys()
  await w.caches.open('pinball-genie-v0')
  await w.caches.open('some-other-old-cache')
  let pending = null
  w.listeners.activate({ waitUntil: (p) => (pending = p) })
  assert(pending, 'activate did not call waitUntil')
  await pending
  const left = await w.caches.keys()
  assert(JSON.stringify(left) === JSON.stringify([current]), `expected only ${current}, have ${JSON.stringify(left)}`)
  assert(/^pinball-genie-v\d+$/.test(current), `cache name ${current} does not carry a version`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
