// ui/sheet.ts — shared bottom-sheet chrome (backdrop, grabber, header,
// scrollable body, backdrop-tap-dismiss, slide-up animation). New file: the
// design introduces two bottom sheets (Machine picker, Goal browser) that
// share one visual/interaction recipe — DESIGN-NOTES.md:
//   §2 items 7-8 ("Machine sheet" / "Goal sheet") — grabber, title + mono
//     meta on the right, hairline-separated scrollable rows, max-height.
//   §3 "Glass surface recipe" — sheets: `rgba(20,22,28,.96)`, `blur(16px)`,
//     `border-top:1px solid rgba(255,255,255,.14)`, radius `18px 18px 0 0`.
//   §3 "Animation specs" — `pgSheetUp` 0.25s `cubic-bezier(.2,.8,.2,1)`.
// ar/arview.ts and overlay/map2d.ts own the CONTENT of each sheet (machine
// rows / goal rows — tightly coupled to their own phase/tab transitions);
// this file owns only the shared shell so that chrome isn't duplicated
// between the call sites.
//
// P4 (2026-08-14) — THIS IS NOW THE DIALOG-GRADE SHEET. Until this phase the
// shell was chrome only: no role, no Escape, no focus management. Every sheet
// in the app that went through it was, to a screen reader, an unannounced pile
// of divs, and to a keyboard an inescapable one. That gap is also the reason
// ui/glossary.ts forked its own copy (read its header): it needed a
// document.body-mounted overlay ABOVE the app header/tab bar (z-index 20),
// which this file's absolutely-positioned z-index 9/10 backdrop/panel cannot
// be. Both are fixed here rather than around:
//
//   * role="dialog" + aria-modal="true" + aria-labelledby (the title element
//     gets a generated id) — the exact wiring ui/study.ts's bespoke LEARN
//     sheet already shipped, which was this phase's donor pattern.
//   * Escape closes, via opts.onDismiss() — NEVER by calling destroy()
//     directly. Callers track open-ness by their own handle (map2d.ts's
//     `sheetHandle !== null` toggle); a sheet that tore itself down behind
//     their back would leave them believing it was still open.
//   * Focus moves into the sheet on open and returns to the previously
//     focused element on destroy(), and Tab wraps inside the panel.
//   * `variant: 'overlay'` mounts to document.body as position:fixed at
//     z-index 200/201 (ui/howto.css's tier) — what the glossary forked for.
//   * `closeButton: true` renders the ✕ affordance overlay sheets need (a
//     backdrop tap is not discoverable when the sheet fills the screen).
//
// STILL BESPOKE ON PURPOSE: ui/study.ts's LEARN/ACTION panels. They need a
// TRANSPARENT tap-catcher (the playfield above must read as live) where this
// shell has a dark modal scrim — see that file's header.

import './sheet.css'
import { claimOverlayKey, isRendered, isTopmost, popOverlay, pushOverlay, OVERLAY_TIER_LOCAL, OVERLAY_TIER_OVERLAY } from './overlayStack'
import { containsNode, focusableWithin } from './focusRing'

export interface SheetHandle {
  /** Replaces the sheet's scrollable body content. */
  setBody(content: HTMLElement): void
  /** Removes the sheet from the DOM. Safe to call more than once. */
  destroy(): void
}

export interface SheetOptions {
  title: string
  meta?: string
  maxHeightVh: number
  onDismiss: () => void
  /** Renders a ✕ button in the header (36px visual, 44px hit area — see
   *  sheet.css). Off by default: the AR/Map sheets sit inside their own tab
   *  with the app's chrome visible around them, so the backdrop tap is
   *  discoverable. An `overlay` sheet covers everything and needs the
   *  explicit affordance. */
  closeButton?: boolean
  /** aria-label for that ✕ (it has no accessible text of its own — the glyph
   *  is decorative). Defaults to a bare "Close". */
  closeLabel?: string
  /** 'local' (default) — absolutely positioned inside `host`, which must be
   *  position:relative, at z-index 9/10: BELOW the app header/tab bar
   *  (z-index 20), correct for a sheet that belongs to one tab.
   *  'overlay' — mounted into document.body as position:fixed at z-index
   *  200/201, above everything, for a sheet reachable from anywhere. */
  variant?: 'local' | 'overlay'
}

/** Unique per document lifetime — aria-labelledby needs a real id, and two
 *  sheets can legitimately coexist (the glossary opens over whatever tab is
 *  showing). Never reset: reuse would re-point a live aria-labelledby. */
let sheetSeq = 0

// focusableWithin / containsNode live in ui/focusRing.ts (shared with the
// first-run guide's trap; see that file's header for why not here).

/**
 * Mounts a bottom sheet (backdrop + slide-up panel with grabber/header) into
 * `host` (expected `position:relative`, e.g. the Map tab's own root) — or,
 * with `variant: 'overlay'`, into document.body as a fixed overlay, in which
 * case `host` is ignored and callers should pass `document.body` so the call
 * site reads truthfully. `maxHeightVh` bounds the scrollable body only
 * (DESIGN-NOTES: machine sheet 56dvh, goal sheet 62dvh) — the panel itself
 * already caps at 80dvh so the header stays visible even on short viewports.
 */
export function createSheet(host: HTMLElement, opts: SheetOptions): SheetHandle {
  const overlay = opts.variant === 'overlay'
  const mount = overlay ? document.body : host
  const titleId = `pg-sheet-title-${++sheetSeq}`

  const backdrop = document.createElement('div')
  backdrop.className = overlay ? 'pg-sheet-backdrop pg-sheet-overlay' : 'pg-sheet-backdrop'
  backdrop.addEventListener('click', (ev) => {
    // Only the backdrop ITSELF — a click that began on the panel and drifted
    // out (a text-selection drag) must not dismiss. Same guard
    // ui/signupgate.ts and ui/study.ts's LEARN backdrop already use.
    if (ev.target === backdrop) opts.onDismiss()
  })

  const panel = document.createElement('div')
  panel.className = overlay ? 'pg-sheet-panel pg-sheet-overlay' : 'pg-sheet-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', titleId)
  // Focus target of last resort: a sheet whose body has no control at all
  // (an empty goal list, a "Glossary unavailable" message) must still be
  // able to receive focus, or opening it would leave focus behind on the
  // opener with an aria-modal dialog covering it.
  panel.setAttribute('tabindex', '-1')

  const grabber = document.createElement('div')
  grabber.className = 'pg-sheet-grabber'

  const header = document.createElement('div')
  header.className = opts.closeButton ? 'pg-sheet-header pg-sheet-header-with-close' : 'pg-sheet-header'
  const title = document.createElement('div')
  title.className = 'pg-sheet-title'
  title.id = titleId
  title.textContent = opts.title
  header.appendChild(title)
  if (opts.meta) {
    const meta = document.createElement('div')
    meta.className = 'pg-sheet-meta'
    meta.textContent = opts.meta
    header.appendChild(meta)
  }
  if (opts.closeButton) {
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'pg-sheet-close'
    closeBtn.setAttribute('aria-label', opts.closeLabel ?? 'Close')
    closeBtn.textContent = '✕' // ✕
    closeBtn.addEventListener('click', () => opts.onDismiss())
    header.appendChild(closeBtn)
  }

  const body = document.createElement('div')
  body.className = 'pg-sheet-body'
  body.style.maxHeight = `${opts.maxHeightVh}dvh`

  panel.append(grabber, header, body)
  mount.append(backdrop, panel)

  const priorFocus = (document.activeElement as HTMLElement | null) ?? null

  function onKeydown(ev: KeyboardEvent): void {
    // ONLY THE TOPMOST DIALOG ANSWERS THE KEYBOARD (P8 review, 2026-08-14).
    // Two of these can be on screen at once — a tab-local sheet with the
    // glossary overlay above it, which this app treats as an intended stack —
    // and both install a document-level listener. Before this gate, one
    // Escape dismissed BOTH, and Tab was fought over: whichever trap ran
    // second won, i.e. registration order decided where focus went. See
    // ui/overlayStack.ts, which exists entirely for this.
    // A sheet whose host tab is hidden answers nothing — the `local` variant
    // lives inside a tab panel too. See ui/overlayStack.ts's isRendered.
    if (!isRendered(panel)) return
    if (!isTopmost(panel)) return
    // ...and a key is answered ONCE. The topmost dialog's Escape handler
    // destroys it, which pops it from the stack mid-dispatch and would
    // otherwise promote the sheet underneath into answering the same
    // keypress. See claimOverlayKey.
    if (ev.key !== 'Escape' && ev.key !== 'Tab') return
    if (!claimOverlayKey(ev)) return
    if (ev.key === 'Escape') {
      // Through onDismiss, never destroy() — see this file's header.
      opts.onDismiss()
      return
    }
    if (ev.key !== 'Tab') return
    const focusable = focusableWithin(panel)
    const active = document.activeElement as HTMLElement | null
    if (focusable.length === 0) {
      // Nothing to move to; keep focus on the panel rather than letting Tab
      // walk out of an aria-modal dialog into the page behind it.
      ev.preventDefault?.()
      panel.focus?.()
      return
    }
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (ev.shiftKey ? active === first || active === panel : active === last) {
      ev.preventDefault?.()
      ;(ev.shiftKey ? last : first).focus?.()
    }
  }

  document.addEventListener('keydown', onKeydown)
  // Registered at the tier this variant actually paints in, so "topmost"
  // means what the user sees rather than what happened to open last.
  pushOverlay(panel, overlay ? OVERLAY_TIER_OVERLAY : OVERLAY_TIER_LOCAL)

  // Focus in: the close button when there is one (the sheet's own primary
  // affordance), else the panel itself. Rows arrive later via setBody(), so
  // "first focusable" is evaluated against the chrome that exists NOW —
  // Tab from the panel walks into the body content in DOM order anyway.
  const initial = focusableWithin(panel)[0] ?? panel
  initial.focus?.()

  let destroyed = false
  return {
    setBody(content: HTMLElement): void {
      body.replaceChildren(content)
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      document.removeEventListener('keydown', onKeydown)
      // Release the keyboard BEFORE anything else in teardown: a panel that
      // is gone but still registered would keep the sheet underneath it from
      // ever answering a key again.
      popOverlay(panel)
      // Restore focus ONLY if it is still inside the sheet (or nowhere).
      // Callers also close this sheet as a side effect of opening something
      // else — map2d.ts's settings popover does exactly that — and yanking
      // focus back to the sheet's opener at that moment would steal it from
      // the control the user just pressed.
      const active = document.activeElement as HTMLElement | null
      const restore = !active || active === document.body || containsNode(panel, active)
      backdrop.remove()
      panel.remove()
      if (restore) priorFocus?.focus?.()
    },
  }
}
