// ui/account.ts — full-screen "Account" overlay: signed-in identity, Export
// my data, Sign out, Delete my account. New file (D3, 2026-07-29 security
// review — the reason Phase 5 could not ship).
//
// D3: both legal pages (server/legal/*.html, not this file's to edit) state
// as FACT that a signed-in user can export their data or delete their
// account "from your account settings, no email required" — and, before
// this file existed, a grep for "account settings" / "/auth/delete" /
// "/auth/export" / "sign out" across the whole client turned up ZERO hits.
// This file is that settings surface, making the legal pages' claim true
// instead of a lie a signed-in user could actually go looking for and not
// find.
//
// ENTRY POINT / WHY NOT THE HEADER OR A 4TH TAB: ui/achievements.ts's
// render() appends a "Manage account" row (see that file's
// renderAccountBanner()) only when signed in, which dynamic-imports this
// module on tap — same lazy-chunk pattern as ui/glossary.ts from app.ts's
// header ("not the user's only instructions, so lazy is fine"). Two places
// were considered and rejected:
//   - A 4th tab: the build brief explicitly rules this out.
//   - A header icon button (the ui/howto.ts "?" model the brief suggests
//     as a SHAPE reference): styles.css's own .brand-mark comment already
//     documents header-top as width-constrained on narrow phones ("with
//     both the wordmark and the Help button present, the machine-name
//     select truncated at 393pt" — the wordmark TEXT was cut for the Help
//     button's sake). Bolting a 5th control onto that row for a feature
//     only signed-in users ever see is exactly the kind of layout debt that
//     comment is warning the next person off. Achievements is ALREADY the
//     one per-user, session-aware tab in this app (ui/achievements.ts's own
//     header comment) — it is where a signed-in user already looks for
//     "my stuff", it needs no new network call (achievements.ts's boot()
//     already has the session from ui/session.ts's shared getSession()),
//     and it keeps this feature's entire footprint out of the always-
//     visible chrome for the ~all visitors who never sign in at all.
// The full-screen-overlay SHAPE (fixed inset, header + close X, scrolling
// body) is exactly ui/howto.ts's model, per the brief — see account.css's
// header comment for the shared recipe.
//
// SERVER CONTRACT THIS FILE ASSUMES — READ BEFORE TOUCHING pinball_auth.py:
//   GET  /auth/export  -> EXISTS today (pinball_auth.py's _do_export):
//                          session-gated, 200 + Content-Disposition:
//                          attachment. Wired below as a real <a href>, not a
//                          fetch+blob — same "plain navigation, no in-app
//                          side effect" convention ui/instagram.ts documents
//                          for its own outbound link, and it lets the
//                          browser's native download handling do the work.
//   POST /auth/delete  -> EXISTS today (_do_delete_account): 200
//                          {"deleted":true}, clears the session cookie.
//                          Wired below as a real fetch(), gated behind an
//                          explicit confirm step (see buildDeleteSection).
//   POST /auth/signout -> DOES NOT EXIST YET as of this file's writing —
//                          confirmed by reading server/pinball_auth.py's
//                          do_POST() directly, 2026-07-30: only
//                          "/auth/request" and "/auth/delete" are routed;
//                          anything else 404s. THIS MUST BE ADDED SERVER-
//                          SIDE (a route that clears the session cookie the
//                          same way _do_delete_account does, minus the
//                          delete) for real sign-out to work at all — flag
//                          this loudly for reconciliation with whoever owns
//                          pinball_auth.py this run. Until it exists,
//                          signOut() below gets a 404 every time and
//                          degrades to an honest "not available yet"
//                          message (see buildSignOutSection) rather than
//                          claiming success it can't deliver — a 30-day
//                          HttpOnly cookie cannot be cleared from this
//                          module any other way (client JS can't touch an
//                          HttpOnly cookie by design).

import './account.css'
import { forgetSession } from './session'

export interface AccountInfo {
  /** /whoami's opaque uid is intentionally never surfaced as a human-facing
   *  identity (see session.ts's own note on the server's stated reasoning)
   *  — `email` is the only thing this overlay ever displays, and only if
   *  present. It currently never will be (the server contract as of this
   *  writing has no `email` field on /whoami at all) — see buildIdentity()
   *  below for the honest fallback copy used in that (current, real) case. */
  email?: string
}

export interface AccountCallbacks {
  /** Called after a server-acknowledged sign-out (2xx). The caller
   *  (achievements.ts) does a hard page reload — see its own call site
   *  comment for why a full reload, not SPA-side teardown, is the right
   *  response to an auth-ending action: every module that cached "signed
   *  in" anywhere (this tab's in-memory progress blob, a future header
   *  affordance, etc.) needs to forget it at once, and a reload is the one
   *  mechanism that can't miss one. */
  onSignedOut(): void
  /** Called after a server-acknowledged account deletion (200
   *  {"deleted":true}). Same hard-reload rationale as onSignedOut. */
  onDeleted(): void
}

async function signOut(): Promise<'ok' | 'unavailable' | 'error'> {
  try {
    const r = await fetch('/auth/signout', { method: 'POST', credentials: 'same-origin' })
    // 404 = the route isn't deployed yet (see this file's header) — a
    // DISTINCT outcome from "the request failed", so the copy shown for
    // each can be honest about which one happened.
    if (r.status === 404) return 'unavailable'
    return r.ok ? 'ok' : 'error'
  } catch {
    return 'error'
  }
}

async function deleteAccount(): Promise<'ok' | 'error'> {
  try {
    const r = await fetch('/auth/delete', { method: 'POST', credentials: 'same-origin' })
    return r.ok ? 'ok' : 'error'
  } catch {
    return 'error'
  }
}

function buildIdentity(info: AccountInfo): HTMLElement {
  const el = document.createElement('div')
  el.className = 'pg-account-identity'
  if (info.email) {
    el.append(document.createTextNode('Signed in as '))
    const b = document.createElement('b')
    b.textContent = info.email
    el.appendChild(b)
  } else {
    // Current, real server contract (see this file's header): /whoami never
    // sends an email. A generic-but-true line beats fabricating an identity
    // this module was never given.
    el.textContent = "You're signed in on this device."
  }
  return el
}

// Exported alongside buildDeleteSection (same reasoning: account-settings.
// test.mjs drives these directly rather than standing up the whole
// openAccount() overlay + document.body stub for every assertion).
export function buildExportSection(): HTMLElement {
  const section = document.createElement('div')
  section.className = 'pg-account-section'

  const title = document.createElement('h3')
  title.className = 'pg-account-section-title'
  title.textContent = 'Export my data'

  const body = document.createElement('p')
  body.className = 'pg-account-section-body'
  body.textContent = 'Download a JSON copy of your account details and everything saved to your achievement progress.'

  // Real navigation/download, not a fetch — see this file's header comment.
  const link = document.createElement('a')
  link.className = 'pg-account-btn'
  link.href = '/auth/export'
  link.textContent = 'Export my data'

  section.append(title, body, link)
  return section
}

export function buildSignOutSection(callbacks: AccountCallbacks): HTMLElement {
  const section = document.createElement('div')
  section.className = 'pg-account-section'

  const title = document.createElement('h3')
  title.className = 'pg-account-section-title'
  title.textContent = 'Sign out'

  const body = document.createElement('p')
  body.className = 'pg-account-section-body'
  body.textContent = 'Ends your session on this device — useful on a shared or public computer.'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'pg-account-btn'
  btn.textContent = 'Sign out'

  const status = document.createElement('p')
  status.className = 'pg-account-status'

  let busy = false
  btn.addEventListener('click', () => {
    if (busy) return
    busy = true
    btn.disabled = true
    status.className = 'pg-account-status'
    status.textContent = ''
    void signOut().then((result) => {
      busy = false
      btn.disabled = false
      if (result === 'ok') {
        forgetSession()
        callbacks.onSignedOut()
        return
      }
      status.className = 'pg-account-status error'
      status.textContent =
        result === 'unavailable'
          ? "Sign-out isn't available in this build yet — clearing this site's cookies in your browser is the only way to sign out for now."
          : "Couldn't sign you out — check your connection and try again."
    })
  })

  section.append(title, body, btn, status)
  return section
}

/**
 * "Delete my account" — a real confirmation step (D3's explicit
 * requirement), not a second identical tap: the idle state shows only an
 * outline (never solid-red — see account.css) button; clicking it swaps the
 * section's content for irreversibility copy plus Cancel / "Yes, delete my
 * account", and ONLY the second click of THAT second button calls
 * deleteAccount(). Exported (not just used internally) so
 * account-settings.test.mjs can drive it directly without standing up the
 * whole openAccount() overlay.
 */
export function buildDeleteSection(callbacks: AccountCallbacks): HTMLElement {
  const section = document.createElement('div')
  section.className = 'pg-account-section'

  const title = document.createElement('h3')
  title.className = 'pg-account-section-title'
  title.textContent = 'Delete my account'

  const body = document.createElement('p')
  body.className = 'pg-account-section-body'
  body.textContent = 'Permanently deletes your account and every achievement you have checked off, on every device. This cannot be undone.'

  const content = document.createElement('div')

  function renderIdle(): void {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pg-account-btn pg-account-btn-danger'
    btn.textContent = 'Delete my account'
    btn.addEventListener('click', () => renderConfirm())
    content.replaceChildren(btn)
  }

  function renderConfirm(): void {
    const wrap = document.createElement('div')

    const cTitle = document.createElement('p')
    cTitle.className = 'pg-account-confirm-title'
    cTitle.textContent = 'This cannot be undone.'

    const cBody = document.createElement('p')
    cBody.className = 'pg-account-confirm-body'
    cBody.textContent =
      'Deleting removes your account and every saved achievement immediately. There is no recovery and no grace period.'

    const row = document.createElement('div')
    row.className = 'pg-account-btn-row'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'pg-account-btn pg-account-btn-danger'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => renderIdle())

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'pg-account-btn pg-account-btn-danger-solid'
    confirm.textContent = 'Yes, delete my account'

    const status = document.createElement('p')
    status.className = 'pg-account-status'

    let busy = false
    confirm.addEventListener('click', () => {
      if (busy) return
      busy = true
      cancel.disabled = true
      confirm.disabled = true
      status.className = 'pg-account-status'
      status.textContent = ''
      void deleteAccount().then((result) => {
        if (result === 'ok') {
          forgetSession()
          callbacks.onDeleted()
          return
        }
        busy = false
        cancel.disabled = false
        confirm.disabled = false
        status.className = 'pg-account-status error'
        status.textContent = "Couldn't delete your account — check your connection and try again."
      })
    })

    row.append(cancel, confirm)
    wrap.append(cTitle, cBody, row, status)
    content.replaceChildren(wrap)
  }

  renderIdle()
  section.append(title, body, content)
  return section
}

/** Mounts the overlay into document.body (same convention as ui/howto.ts's
 *  openHowTo() — needs to sit above the whole app regardless of which tab
 *  is active). Returns a handle so its caller (achievements.ts's "Manage
 *  account" row) can close it programmatically as well as via the header's
 *  own X. */
export function openAccount(info: AccountInfo, callbacks: AccountCallbacks): { destroy(): void } {
  const overlay = document.createElement('div')
  overlay.className = 'pg-account-overlay'
  // Dialog semantics (P4, 2026-08-14) — same wiring, same reasoning as
  // ui/howto.ts's overlay and ui/signupgate.ts before it: a full-screen
  // overlay that does not say it is one leaves the app behind it announced
  // and keyboard-reachable. Nothing here renders, so the visuals are
  // byte-for-byte what they were.
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'pg-account-title')

  const header = document.createElement('div')
  header.className = 'pg-account-header'
  const title = document.createElement('div')
  title.className = 'pg-account-title'
  title.id = 'pg-account-title'
  title.textContent = 'Account'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'pg-account-close'
  closeBtn.setAttribute('aria-label', 'Close account settings')
  closeBtn.textContent = '✕' // ✕
  header.append(title, closeBtn)

  const body = document.createElement('div')
  body.className = 'pg-account-body'
  body.append(buildIdentity(info), buildExportSection(), buildSignOutSection(callbacks), buildDeleteSection(callbacks))

  overlay.append(header, body)
  const priorFocus = (document.activeElement as HTMLElement | null) ?? null
  document.body.appendChild(overlay)

  let destroyed = false
  function close(): void {
    if (destroyed) return
    destroyed = true
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    // Back to the "Manage account" row on the Achievements tab that opened it.
    priorFocus?.focus?.()
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close()
  }
  closeBtn.addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  // The ✕, for the same reason ui/howto.ts focuses its own: the destructive
  // controls (sign out, delete account) live at the bottom of this overlay
  // and must never be what a keyboard lands on.
  closeBtn.focus?.()

  return { destroy: close }
}
