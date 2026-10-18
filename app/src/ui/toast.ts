// ui/toast.ts — the app's ONE transient status pill (P7a, 2026-08-14).
//
// WHAT IT IS FOR. Finishing a goal used to be the least eventful thing in the
// app: tapping ✓ on the last step called state.clearSelection() and the detail
// screen simply vanished, indistinguishable from tapping "‹ Goals" to give up.
// This is the acknowledgement — a glass pill above the ad slot reading
// "<goal title> — done" — and it is deliberately the SMALLEST possible one.
//
// THIS IS NOT THE OLD CELEBRATION, and does not reopen that decision. The
// full-screen FX (fx/celebrate.ts: its own rAF loop, a banner, sound) stays
// removed and unimported; the map-scoped emoji burst (2026-08-11, Feature 3)
// stays the map's. This module has no canvas, no sound, no rAF, and nothing
// to dismiss: one element, one timer, gone in 2.4 seconds. app.ts's header
// note records the supersession of its own "no toast" line.
//
// SHAPE (deliberate, each point load-bearing):
//   * SINGLETON, replace-not-stack. Completing two goals quickly must not
//     stack two pills up the screen or leave the first one's timer to yank
//     the second one away early — the second call tears the first down and
//     starts clean, so what is on screen always describes the last thing that
//     happened.
//   * role="status" (a polite live region), with the TEXT ASSIGNED AFTER the
//     element is in the document. A live region that arrives with its content
//     already in place is a change to the tree, not a change to the region,
//     and screen readers vary on whether they announce it at all; mutating it
//     one statement later is the case the ARIA spec actually describes. Both
//     statements are in the same synchronous task, so nothing about the
//     rendered frame or this module's testability changes.
//   * pointer-events: none (styles.css). It floats over the tab bar's top
//     edge for a moment; it must never eat a tap meant for the app.
//   * ENTER-ONLY animation, teardown is a plain removal. No animationend
//     listener, no exit transition — the same discipline every other
//     animation in this app follows (P2's audit: all of them are enter-only),
//     which is why reduced motion needs nothing here but `animation: none` in
//     CSS: the pill still appears, still announces, still disappears on time.
//     Removing the motion must never remove the feature.

/** How long the pill stays up. Exported so app/tests/goal-bridge.test.mjs
 *  asserts the real number instead of a copy of it. */
export const TOAST_MS = 2400

/** The one pill that may exist at a time, and its dismissal timer. */
let current: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null

/** Removes the pill on screen, if any, and cancels its pending dismissal.
 *  Safe to call at any time, including when nothing is showing. */
export function dismissToast(): void {
  if (!current) return
  clearTimeout(current.timer)
  current.el.remove()
  current = null
}

/** Shows `text` in the status pill for TOAST_MS, replacing whatever was
 *  showing. Mounted on document.body (like ui/howto.ts and the glossary
 *  sheet): it must sit above the app header and tab bar, which are z-index 20
 *  inside #app, and nothing in the shell is a common positioned ancestor.
 *
 *  `glyph` is trailing-optional and defaults to the ✓ this pill was born with
 *  (P7a's "<goal title> — done"), so every existing call site is byte-for-byte
 *  unchanged. It exists because P7b added the pill's first NON-completion
 *  message — overlay/map2d.ts's "<goal title> — needs Premium/LE" when a MODEL
 *  switch strands the selected goal — and a ✓ in front of that reads as
 *  "done", which is the one thing it does not mean. The glyph is decorative
 *  and aria-hidden either way; the words carry the meaning. */
export function showToast(text: string, glyph: string = '✓'): void {
  dismissToast()

  const el = document.createElement('div')
  el.className = 'pg-toast'
  el.setAttribute('role', 'status')

  const check = document.createElement('span')
  check.className = 'pg-toast-check'
  // Decorative: the label says what happened in words, so announcing "check
  // mark" ahead of it would be noise.
  check.setAttribute('aria-hidden', 'true')
  check.textContent = glyph

  const label = document.createElement('span')
  label.className = 'pg-toast-text'

  el.append(check, label)
  document.body.appendChild(el)
  // AFTER the append — see the live-region note in this file's header.
  label.textContent = text

  const timer = setTimeout(() => {
    // Guard against a stale timer outliving its pill (a second showToast()
    // clears this one, but belt-and-braces: never tear down someone else's).
    if (current?.el !== el) return
    dismissToast()
  }, TOAST_MS)

  current = { el, timer }
}
