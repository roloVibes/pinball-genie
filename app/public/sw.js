// public/sw.js — the offline fallback (2026-10-14). Plain JS, no build step:
// Vite copies app/public/ verbatim, so this lands at dist/sw.js and is served
// as /sw.js. It MUST live at the site root — a service worker only controls
// URLs at or below its own path, and the shell is "/".
//
// WHY IT EXISTS. Pinball Genie is used standing at a machine in a bar or an
// expo hall, on venue Wi-Fi that drops in and out. Before this file, losing
// the network mid-session meant the next machine switch (a /data/*.json fetch)
// or a reload showed nothing at all. This keeps the last copy of everything
// the visitor already loaded, and hands it back ONLY when the network fails.
//
// THE ONE RULE: NETWORK FIRST, ALWAYS. Every request this worker handles goes
// to the network first; the cache is consulted only when the network throws,
// times out (below), or answers 5xx. Never cache-first. deploy-prod.sh deletes the whole
// /assets/ directory on every deploy (see ui/chunkError.ts), so a cache-first
// shell would keep booting an index.html whose hashed chunks no longer exist
// on the server — stranding people on a build that can never finish loading.
// Network-first means an online visitor always gets exactly what the server
// has, and the cache is purely a fallback. The one bounded exception is a
// network that answers NOTHING for NETWORK_TIMEOUT_MS while a saved copy
// exists — see that constant below.
//
// WHAT IT TOUCHES (an ALLOWLIST — everything else passes straight through to
// the browser as if this file did not exist):
//   /  and  /index.html  — the app shell (stored under one key, see SHELL_KEY)
//   /assets/*            — Vite's content-hashed JS/CSS chunks
//   /data/*.json         — catalog, library, glossary, per-machine goals
//   /fonts/*, /icons/*, /favicon.ico, /favicon-48.png
//
// WHAT IT NEVER TOUCHES, checked BEFORE the allowlist so no future widening
// of the allowlist can swallow them: /auth/*, /api/*, /whoami (per-user,
// session-gated state — a cached "you are signed in" or a cached progress
// blob would be a lie, and a cached one from another account a leak), and
// /manifest.webmanifest (fetched with credentials; leave it to the browser).
// Non-GET requests and other origins are never intercepted either.

// Bump ONLY when this file's caching format changes (e.g. how keys are
// built). It is NOT a per-deploy number: network-first already picks up every
// deploy, and stale chunks are purged by the shell check below. On activate,
// every cache with a different name is deleted.
const CACHE_VERSION = 'v1'
const CACHE_NAME = `pinball-genie-${CACHE_VERSION}`

// The shell is requested as "/", "/index.html", and with throwaway query
// strings ("/?_r=<timestamp>" from ui/chunkError.ts's reload button,
// "/?verified=1" after sign-in). Storing each spelling separately would grow
// the cache on every reload AND miss offline when the spelling differs, so all
// of them share this one key.
const SHELL_KEY = '/'

const NEVER = ['/auth/', '/api/']
const NEVER_EXACT = ['/whoami', '/manifest.webmanifest']
const PREFIXES = ['/assets/', '/fonts/', '/icons/']
const EXACT = ['/', '/index.html', '/favicon.ico', '/favicon-48.png']

/** Which requests this worker handles. Returns false for everything it must
 *  leave alone; the caller then does not call respondWith() at all. */
function shouldHandle(request) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  const p = url.pathname
  if (NEVER.some((pre) => p.startsWith(pre)) || NEVER_EXACT.includes(p)) return false
  if (EXACT.includes(p) || PREFIXES.some((pre) => p.startsWith(pre))) return true
  return p.startsWith('/data/') && p.endsWith('.json')
}

/** The cache key for a handled request: the shell collapses to SHELL_KEY, and
 *  everything else drops its query string (the app never sends a meaningful
 *  one to these paths, and the server ignores it). */
function cacheKey(request) {
  const url = new URL(request.url)
  const isShell = url.pathname === '/' || url.pathname === '/index.html'
  return new URL(isShell ? SHELL_KEY : url.pathname, self.location.origin).href
}

/** Only a plain, final 200-range same-origin answer is worth keeping.
 *  - !ok: a 404 for a pruned chunk (or a 5xx) must never overwrite a good
 *    copy — that is the classic way an offline cache poisons itself.
 *  - redirected: on the session-gated staging host an anonymous "/" is
 *    redirected to /login; caching that under "/" would serve the login page
 *    as the app shell forever after. */
function isCacheable(response) {
  return response.ok && !response.redirected && response.type === 'basic'
}

/** A NEW deploy has been seen when the freshly fetched shell differs from the
 *  stored one. Its chunk names are all new, and the old ones have just been
 *  deleted from the server, so the cached old chunks are dead weight — drop
 *  them, or the cache grows by one build's worth of chunks every deploy.
 *  This runs BEFORE the new shell is handed to the page, so no chunk the new
 *  shell goes on to request can be cached early and then swept away here. */
async function purgeAssetsIfShellChanged(cache, freshShell) {
  const old = await cache.match(SHELL_KEY)
  if (!old) return
  const [a, b] = await Promise.all([old.text(), freshShell.clone().text()])
  if (a === b) return
  const keys = await cache.keys()
  const assetsPrefix = new URL('/assets/', self.location.origin).href
  await Promise.all(keys.filter((k) => k.url.startsWith(assetsPrefix)).map((k) => cache.delete(k)))
}

/** The network half: fetch, and store the answer if (and only if) it passes
 *  isCacheable — including the shell-change purge. This one function is the
 *  ONLY writer to the cache, whether its result reaches the page or arrives
 *  after the page was already answered from cache (the background refresh
 *  below), so both paths get exactly the same ok/redirect/same-origin checks.
 *  Rejects on a network failure; resolves with the response either way. */
async function fetchAndStore(cache, request, key) {
  const response = await fetch(request)
  if (isCacheable(response)) {
    if (key === new URL(SHELL_KEY, self.location.origin).href) {
      await purgeAssetsIfShellChanged(cache, response)
    }
    // Awaited, not fire-and-forget: a put that is still in flight when the
    // worker is stopped is simply lost. The clone is what goes in the cache;
    // the original body goes to the page.
    await cache.put(key, response.clone())
  }
  return response
}

// SLOW-BUT-CONNECTED ("lie-fi"): a captive portal or an overloaded expo-hall
// access point does not FAIL a request, it just never finishes it — so plain
// network-first would sit on a blank screen until the browser gives up, which
// can be a minute or more. When a saved copy exists, the network gets this
// long to answer; after that the saved copy is served and the network request
// keeps running in the background, refreshing the cache if it does come back
// OK. With NO saved copy there is no timeout at all: a first visit must get
// the real answer, however slowly — giving up would leave nothing to show.
const NETWORK_TIMEOUT_MS = 3500
const TIMED_OUT = Symbol('timed out')
const FAILED = Symbol('network failed')

/** Resolves to { response, settled }. `response` is what the page gets;
 *  `settled` resolves once the network request (and any cache write it makes)
 *  has finished — the fetch listener keeps the worker alive until then, so a
 *  background refresh is not killed half-way. */
async function networkFirst(request) {
  const key = cacheKey(request)
  const cache = await caches.open(CACHE_NAME)
  // Matched BEFORE the fetch starts, so a purge triggered by this very fetch
  // (a new shell) cannot pull the fallback out from under this request.
  const cached = await cache.match(key)
  const network = fetchAndStore(cache, request, key)
  const settled = network.then(
    () => {},
    () => {},
  )

  if (!cached) {
    // Nothing saved: the network's answer, whatever it is and however long it
    // takes. A rejection is the same failure the page would have seen with no
    // service worker; a non-OK status passes through untouched, so
    // ui/chunkError.ts still sees the 404 it was written for.
    return { response: network, settled }
  }

  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), NETWORK_TIMEOUT_MS)
  })
  const winner = await Promise.race([network.catch(() => FAILED), deadline])
  clearTimeout(timer)
  // Timed out, network failure (offline, DNS, reset), or a 5xx: the saved
  // copy. An overloaded server never replaces good data on screen.
  if (winner === TIMED_OUT || winner === FAILED || isServerFailure(winner)) {
    return { response: cached, settled }
  }
  // Everything else the server answered on purpose goes to the page as-is,
  // even with a saved copy in hand (fetchAndStore has already declined to
  // cache it). A redirect — a 3xx, the 'opaqueredirect' a navigation's
  // redirect:'manual' fetch produces, or a followed one (redirected:true) — is
  // usually the session gate sending a signed-out visitor to /login; a 401 or
  // 403 says the same thing in words. Answering those with the cached shell
  // would show the app to someone the server just turned away. A 404 is the
  // deploy having pruned a chunk: ui/chunkError.ts exists to see that 404 and
  // offer a reload, and a cached old chunk would hide it.
  return { response: winner, settled }
}

/** A 5xx is the server failing, not deciding — the one HTTP answer that is
 *  treated like a dropped connection. An opaqueredirect has status 0, so it is
 *  never one. */
function isServerFailure(response) {
  return response.status >= 500 && response.status <= 599
}

self.addEventListener('install', () => {
  // No precache, so there is nothing for a waiting worker to protect: take
  // over immediately instead of waiting for every tab to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  if (!shouldHandle(event.request)) return
  // waitUntil is called HERE, synchronously during dispatch, with a promise
  // released once networkFirst knows what its background work is. Calling it
  // later from inside networkFirst would race the event going inactive after
  // respondWith settles — exactly the moment a timed-out request's refresh
  // is still running.
  let release
  event.waitUntil(new Promise((resolve) => (release = resolve)))
  const work = networkFirst(event.request)
  work.then(({ settled }) => release(settled), () => release())
  event.respondWith(work.then(({ response }) => response))
})
