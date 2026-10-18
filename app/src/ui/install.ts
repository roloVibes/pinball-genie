// ui/install.ts — Android/Chrome native "Install app" affordance.
//
// Chrome (and other installability-aware Chromium browsers — Edge, Samsung
// Internet) fire 'beforeinstallprompt' once they judge the page installable
// (valid manifest + qualifying icons + served over https + not already
// installed). The event must be captured and preventDefault()'d as soon as
// it fires or the browser falls back to its own address-bar/menu-only flow
// and the deferred prompt() handle is lost for good — so this module wires
// the listener at module load (top level, below), not lazily behind a
// click. iOS Safari and desktop Safari never dispatch this event at all:
// there this module just sits idle forever, canInstall() stays permanently
// false, and promptInstall() is a no-op — the correct behavior on every
// platform that doesn't support the API, with no platform sniffing needed.
//
// Imported statically by ui/howto.ts (itself a static import of app.ts —
// see that file's header comment on why), so the listener attaches at app
// boot rather than only if/when the user happens to open the how-to guide.
// A user can open the guide before Chrome has decided to fire the event, or
// while it's already open when Chrome does — onInstallAvailabilityChange()
// below lets ui/howto.ts's Android section keep its button in sync either
// way instead of only reflecting a snapshot taken at render time.

// Minimal shape of the (still non-standard, Chromium-only) event — no
// lib.dom.d.ts type ships one, so it's declared locally rather than pulling
// in a whole @types package for a single event.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
// Sticky once true: guards against a stray repeat 'beforeinstallprompt'
// re-arming the button in the same session after the browser has already
// told us (via 'appinstalled') that the app is on the home screen.
let installed = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  deferredPrompt = event as BeforeInstallPromptEvent
  notify()
})

window.addEventListener('appinstalled', () => {
  deferredPrompt = null
  installed = true
  notify()
})

/** True once Chrome has handed over a captured install prompt this session
 *  and the app isn't already installed. Always false on iOS/desktop Safari
 *  and any other browser that never fires 'beforeinstallprompt'. */
export function canInstall(): boolean {
  return deferredPrompt !== null && !installed
}

/** Fires the captured native install prompt and waits for the user's
 *  answer to the OS-level dialog. A no-op if canInstall() is false — safe
 *  to call from a click handler without re-checking first, e.g. if
 *  'appinstalled' raced the tap. The browser only allows a captured prompt
 *  to be used once, so the reference is cleared immediately regardless of
 *  outcome (accepted or dismissed) or of the call throwing. */
export async function promptInstall(): Promise<void> {
  const prompt = deferredPrompt
  if (!prompt) return
  deferredPrompt = null
  notify()
  try {
    await prompt.prompt()
    await prompt.userChoice
  } catch {
    // Nothing to recover from — canInstall() already reflects that this
    // captured event is spent either way.
  }
}

/** Subscribes to canInstall() transitions (prompt captured, prompt spent,
 *  or app installed). Returns an unsubscribe function — callers that
 *  render a UI tied to this (ui/howto.ts's Android "Install app" button)
 *  should unsubscribe when that UI is torn down. */
export function onInstallAvailabilityChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
