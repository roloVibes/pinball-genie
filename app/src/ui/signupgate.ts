// ui/signupgate.ts — the "unlock Achievements" prompt shown when a
// signed-out visitor taps the Achievements tab.
//
// New 2026-07-31, rolo's call: "people should be able to access the app
// without registration, but if you want to unlock the achievements tab, you
// get the pop up of having to register. And it should say on the app
// something like 'we do this so you have your own account and can track your
// own achievements per account'."
//
// WHAT CHANGED, AND THE TRADE-OFF IT MAKES. Until now the Achievements tab
// was fully usable signed out: you could tick goals off, they just weren't
// saved anywhere, with a banner inviting you to sign in. That was friendlier
// to a casual visitor but quietly dishonest — the checkmarks looked like
// progress and evaporated on reload, and on a SHARED device one person's
// ticks were indistinguishable from another's because there was no "who" at
// all. Gating the tab makes the bargain explicit at the only moment the
// visitor actually cares about it: the instant they reach for the feature
// that needs an identity. Everything else — every machine, every goal, every
// shot path, the map, the glossary — stays open with no account, which is
// the whole product's promise and is unchanged.
//
// The prompt is NOT a wall. "Not now" returns the visitor to the tab they
// came from, and nothing else about the app is withheld. A modal a user
// cannot escape is how you train people to close the tab instead.
//
// The copy leads with the REASON, not the ask. "Create an account" alone
// reads as a toll booth; "so your progress is yours, on any device, and the
// next person on this phone doesn't see your checkmarks" is a benefit the
// visitor can evaluate. It also states up front that there is no password,
// because "register" makes most people brace for one.

import './signupgate.css'

/** Where the sign-in/registration flow lives. A real navigation, not an
 *  in-app route — the sign-in page is server-rendered (server/login.html) so
 *  it works with no JavaScript at all. Kept as one literal here, matching the
 *  same convention in ui/achievements.ts. */
const SIGNIN_HREF = '/login'

export interface SignupGateHandle {
  destroy(): void
}

/**
 * Shows the unlock prompt over the whole app.
 *
 * @param onDismiss Called when the visitor backs out ("Not now", the X, Esc,
 *   or a click on the backdrop). app.ts uses this to send them back to the
 *   tab they were on, so dismissing never strands them on a blank panel.
 */
export function openSignupGate(onDismiss: () => void): SignupGateHandle {
  const overlay = document.createElement('div')
  overlay.className = 'pg-gate-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'pg-gate-title')

  const card = document.createElement('div')
  card.className = 'pg-gate-card'

  const badge = document.createElement('div')
  badge.className = 'pg-gate-badge'
  badge.setAttribute('aria-hidden', 'true')
  badge.textContent = '✓'

  const title = document.createElement('h2')
  title.className = 'pg-gate-title'
  title.id = 'pg-gate-title'
  title.textContent = 'Unlock Achievements'

  const lead = document.createElement('p')
  lead.className = 'pg-gate-lead'
  lead.textContent =
    'Achievements track which goals you’ve completed on every machine you study. That needs an account, so your progress is tied to you and not to this browser.'

  const why = document.createElement('ul')
  why.className = 'pg-gate-why'
  for (const [strong, rest] of [
    ['Your progress is your own.', 'Each account tracks its own achievements, so someone else studying on this device never sees or overwrites your checkmarks.'],
    ['It follows you anywhere.', 'Sign in on your phone at the arcade and your progress is already there — it’s saved to your account, not to one browser.'],
    ['No password to make or remember.', 'Enter your email and we send you a one-time sign-in link. We never store a password, because there isn’t one.'],
  ] as const) {
    const li = document.createElement('li')
    const b = document.createElement('strong')
    b.textContent = strong
    li.append(b, document.createTextNode(' ' + rest))
    why.appendChild(li)
  }

  const note = document.createElement('p')
  note.className = 'pg-gate-note'
  note.textContent =
    'Everything else stays free and open — every machine, every goal, every shot path and the glossary need no account at all.'

  const primary = document.createElement('a')
  primary.className = 'pg-gate-primary'
  primary.href = SIGNIN_HREF
  primary.textContent = 'Create a free account'

  const secondary = document.createElement('button')
  secondary.type = 'button'
  secondary.className = 'pg-gate-secondary'
  secondary.textContent = 'Not now'

  const already = document.createElement('p')
  already.className = 'pg-gate-already'
  const alreadyLink = document.createElement('a')
  alreadyLink.href = SIGNIN_HREF
  alreadyLink.textContent = 'Sign in'
  already.append(document.createTextNode('Already have one? '), alreadyLink)

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'pg-gate-close'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.textContent = '✕'

  card.append(closeBtn, badge, title, lead, why, note, primary, secondary, already)
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  let destroyed = false
  function destroy(): void {
    if (destroyed) return
    destroyed = true
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  /** Backing out must ALWAYS route through here, so app.ts's onDismiss runs
   *  exactly once no matter which of the four escape hatches was used. */
  function dismiss(): void {
    if (destroyed) return
    destroy()
    onDismiss()
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') dismiss()
  }

  closeBtn.addEventListener('click', dismiss)
  secondary.addEventListener('click', dismiss)
  // Backdrop click, but only the backdrop itself — a click that started
  // inside the card and drifted out (a text selection drag) must not close it.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss()
  })
  document.addEventListener('keydown', onKey)

  // Focus the primary action so a keyboard user lands on the thing the dialog
  // is actually about, not on the close button.
  primary.focus()

  return { destroy }
}
