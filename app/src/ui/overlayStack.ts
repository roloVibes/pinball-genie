// ui/overlayStack.ts — WHICH DIALOG OWNS THE KEYBOARD RIGHT NOW.
//
// THE BUG THIS EXISTS FOR (P8 review, 2026-08-14). This app can legitimately
// have two modal panels on screen at once: a tab-local one (ui/study.ts's
// LEARN/ALL SHOTS/DRILLS sheet at z-index 10, or ui/sheet.ts's `local`
// variant at 9/10) and the glossary ON TOP of it (ui/sheet.ts's `overlay`
// variant at 200/201, reachable from the app header while any tab is open).
// tests/sheet.test.mjs calls that stack out as intended, not accidental.
//
// Both of those panels install a `keydown` listener on `document`, and both
// of them own a focus trap. Neither knew the other existed, so with the
// glossary open over a study sheet:
//
//   * TAB was fought over. The study trap sees an activeElement that is not
//     in ITS panel's focus ring, concludes focus has escaped its aria-modal
//     dialog, and pulls focus back into a sheet the user cannot even see —
//     out of the glossary they are actually reading. Whether the glossary's
//     own trap then pulls it back depends on which listener document happens
//     to call second, i.e. on registration order.
//   * ESCAPE closed BOTH at once, for the same reason: two live handlers,
//     one key, no notion of which dialog the key was meant for.
//
// Registration order is not a contract, and "it works because the glossary
// registers last" is not a fix. This module makes the question explicit.
//
// TIER, NOT JUST ORDER. `isTopmost` does not simply return "the most recently
// pushed": it returns the entry that is actually painted on top, which is the
// highest TIER first and the latest push only as a tie-break. That is what
// makes the answer independent of registration order — a `local` sheet that
// somehow opened while an `overlay` was up still would not steal the
// keyboard, because it is still underneath. Tiers are the z-index bands the
// stylesheets already use, named here so the two stay in step.
//
// SCOPE: this is a keyboard-ownership registry, nothing more. It does not
// mount, paint, focus or dismiss anything — each sheet keeps owning its own
// lifecycle, and simply asks "am I on top?" before acting on a key. A panel
// that never registers never enforces, which is why both call sites push in
// their open path and pop in EVERY teardown path (close, dismiss, destroy).

/** The z-index bands sheets are painted in — styles.css `.study-learn-panel`
 *  (10) and ui/sheet.css `.pg-sheet-panel` / `.pg-sheet-overlay` (9/10 and
 *  200/201). Keep in step with those rules; the ORDER is all this module
 *  needs, not the exact numbers. */
export const OVERLAY_TIER_LOCAL = 10
export const OVERLAY_TIER_OVERLAY = 200

interface Entry {
  panel: unknown
  tier: number
  /** Monotonic push counter — the tie-break within one tier. */
  seq: number
}

let seq = 0
let stack: Entry[] = []

/** Registers `panel` as an open modal surface. Idempotent per panel: pushing
 *  the same panel twice re-dates it rather than stacking it on itself. */
export function pushOverlay(panel: unknown, tier: number = OVERLAY_TIER_LOCAL): void {
  if (!panel) return
  stack = stack.filter((e) => e.panel !== panel)
  stack.push({ panel, tier, seq: ++seq })
}

/** Unregisters `panel`. Removes it from ANYWHERE in the stack, not just the
 *  top: sheets do close out of order (a tab teardown can destroy a local
 *  sheet while the glossary is still up), and a pop that only ever removed
 *  the last entry would leave a dead panel owning the keyboard. Safe to call
 *  for a panel that was never pushed, and safe to call twice. */
export function popOverlay(panel: unknown): void {
  stack = stack.filter((e) => e.panel !== panel)
}

/** Is `panel` actually being rendered?
 *
 *  THE CASE THIS EXISTS FOR (QA sweep, 2026-08-14): the Study tab's sheet
 *  survives a tab switch — it is still in the DOM, still registered here, and
 *  its own keydown handler is still on `document` — but its whole panel is
 *  inside a `display: none` tab panel. Measured in Chrome on the built app:
 *  with LEARN open, switching to Shots left TAB being intercepted by the
 *  invisible sheet's focus trap (so a keyboard user on Shots was pulled into a
 *  dialog they could not see) and ESCAPE closing that invisible sheet instead
 *  of doing nothing. A dialog nobody can see must not own the keyboard.
 *
 *  getClientRects() rather than offsetParent: `position: fixed` sets
 *  offsetParent to null, and the glossary IS fixed — that test would have
 *  silently disabled the overlay tier's own trap. An element in a
 *  display:none subtree has no client rects; a fixed one has plenty.
 *
 *  Fake elements (this app's suites drive the real modules against hand-rolled
 *  DOM with no layout at all) have no getClientRects, and are treated as
 *  rendered — the alternative is every existing focus test silently asserting
 *  nothing. */
export function isRendered(panel: unknown): boolean {
  if (!panel) return false
  const el = panel as { isConnected?: boolean; getClientRects?: () => { length: number } }
  if (el.isConnected === false) return false
  if (typeof el.getClientRects !== 'function') return true
  return el.getClientRects().length > 0
}

/** The panel currently painted on top, or null when nothing is registered.
 *
 *  UNRENDERED SURFACES ARE SKIPPED, not just ignored by their own handler: a
 *  sheet left open on a tab the user has switched away from would otherwise
 *  stay "topmost" and shadow a dialog that IS on screen — the glossary opened
 *  from the header would find itself outranked by an invisible sheet. */
export function topmostOverlay(): unknown {
  let best: Entry | null = null
  for (const e of stack) {
    if (!isRendered(e.panel)) continue
    if (!best || e.tier > best.tier || (e.tier === best.tier && e.seq > best.seq)) best = e
  }
  return best ? best.panel : null
}

/** Does `panel` own the keyboard right now?
 *
 *  An UNREGISTERED panel is only topmost when the stack is empty. That
 *  default is deliberate: a surface that forgot to register should fall back
 *  to behaving like a lone dialog (its trap keeps working when it is the only
 *  thing open) but must never out-rank a sheet that did register. */
export function isTopmost(panel: unknown): boolean {
  const top = topmostOverlay()
  return top === null ? true : top === panel
}

/** Events one dialog has already answered. A WeakSet so a key event that
 *  nothing claims is not retained for a moment longer than the browser keeps
 *  it. */
const claimed = new WeakSet<object>()

/** Claims `ev` for the caller, returning false if another dialog already
 *  answered it.
 *
 *  ISTOPMOST ALONE IS NOT ENOUGH, and the test that proved it is in
 *  tests/sheet.test.mjs. Every open dialog listens on `document`, so one
 *  keypress runs every handler IN REGISTRATION ORDER. The topmost dialog
 *  answers Escape by TEARING ITSELF DOWN, which pops it from the stack —
 *  and the handlers that have not run yet then ask "am I topmost?" in a world
 *  where the answer has just changed to yes. One Escape closed the glossary
 *  AND the sheet underneath it, which is the exact bug the stack was added to
 *  prevent, surviving in a subtler form.
 *
 *  So topmost-ness decides WHO may answer, and this decides that a key is
 *  answered ONCE: the state that matters is the state at the start of the
 *  dispatch, and a claim is how a handler records that the dispatch is spent. */
export function claimOverlayKey(ev: object): boolean {
  if (!ev) return true
  if (claimed.has(ev)) return false
  claimed.add(ev)
  return true
}

/** How many surfaces are registered. Test-facing: a leak here is a dialog
 *  that closed without releasing the keyboard, which is invisible until the
 *  next one behaves strangely. */
export function overlayDepth(): number {
  return stack.length
}

/** Test-only reset, so one suite's leaked entry cannot change another test's
 *  answer. Not called by app code — production teardown is pop, not clear. */
export function resetOverlayStack(): void {
  stack = []
  seq = 0
}
