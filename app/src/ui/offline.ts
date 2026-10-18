// ui/offline.ts — the service worker registration and the "you are offline"
// pill (2026-10-14).
//
// WHY THESE TWO LIVE TOGETHER. public/sw.js makes the app keep working on the
// venue Wi-Fi of a bar or expo hall by falling back to what was already
// loaded. That fallback is silent by nature — a saved table looks exactly like
// a live one — so the visitor also needs to be TOLD they are looking at saved
// copies, or a machine they never opened failing to load reads as the app
// being broken. One feature, one module.
//
// THE PILL. Same visual family as ui/toast.ts (a glass pill above the tab bar,
// mounted on document.body, role="status", text assigned after the append for
// the live-region reason toast.ts's header gives) but PERSISTENT: it stays for
// exactly as long as navigator.onLine is false and goes on the `online` event.
// While it is up, body gets `pg-is-offline`, which lifts .pg-toast one slot so
// a goal-done acknowledgement stacks above this pill instead of covering it.
// No animation at all, so there is no reduced-motion case to answer.
//
// navigator.onLine is a coarse signal — false means definitely offline, true
// only means "has a network interface". That asymmetry is fine here: the pill
// only ever claims the definite case, and the worker's network-first fallback
// covers the "connected but nothing gets through" case on its own.

const OFFLINE_TEXT = 'Offline — showing saved tables'
const BODY_CLASS = 'pg-is-offline'

let pill: HTMLElement | null = null

function showOfflinePill(): void {
  if (pill) return
  const el = document.createElement('div')
  el.className = 'pg-offline'
  el.setAttribute('role', 'status')

  const dot = document.createElement('span')
  dot.className = 'pg-offline-dot'
  // Decorative: the words carry the meaning.
  dot.setAttribute('aria-hidden', 'true')

  const label = document.createElement('span')
  label.className = 'pg-offline-text'

  el.append(dot, label)
  document.body.appendChild(el)
  document.body.classList.add(BODY_CLASS)
  // AFTER the append — see ui/toast.ts's live-region note.
  label.textContent = OFFLINE_TEXT
  pill = el
}

function hideOfflinePill(): void {
  document.body.classList.remove(BODY_CLASS)
  if (!pill) return
  pill.remove()
  pill = null
}

/** Wires the offline pill to the browser's online/offline events and shows it
 *  immediately if the page booted offline (served by the worker's cache). */
export function installOfflineIndicator(): void {
  window.addEventListener('offline', showOfflinePill)
  window.addEventListener('online', hideOfflinePill)
  if (!navigator.onLine) showOfflinePill()
}

/** Registers public/sw.js. Fire-and-forget and called only after boot has
 *  painted: registration is an optimisation for the NEXT load, so nothing on
 *  this page waits for it, and a failure (unsupported browser, private mode,
 *  an http:// dev origin) is logged and otherwise ignored.
 *
 *  Production builds only. Under `vite dev` the app is served from /src/*
 *  module URLs the worker deliberately does not handle, and a worker left
 *  registered on localhost from a dev session only confuses the next one. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return
  const register = (): void => {
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.warn('[pinball-genie] service worker registration failed', err)
    })
  }
  // After `load`, so the worker's own script fetch never competes with the
  // page's first-paint requests on a slow connection.
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
