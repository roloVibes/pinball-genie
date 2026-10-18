// ui/cookieWarning.ts — "your browser blocked our sign-in cookie" banner.
// New file (D8, 2026-07-29 security review, reproduced).
//
// THE BUG: a magic-link click reaches GET /auth/verify, succeeds server-
// side (token consumed, Set-Cookie issued), and redirects to "/" — but if
// the browser drops that Set-Cookie (third-party-cookie blocking, Safari
// ITP in some configurations, a locked-down/incognito profile, an
// extension), the visitor lands back on a completely normal-looking
// signed-out page with NO indication anything went wrong. The natural next
// move is requesting ANOTHER link and clicking THAT one too — same silent
// outcome, forever, with no error ever surfacing. This banner exists to
// break that loop with a plain-language explanation instead of silence.
//
// TRIGGER CONTRACT — COORDINATE WITH WHOEVER OWNS server/pinball_auth.py
// THIS RUN: main.ts's boot() looks for `?verified=1` in the URL on first
// load (see main.ts's own comment). pinball_auth.py's _success_login() was
// read directly, 2026-07-30, and confirmed to redirect bare to "/" with NO
// query string at all today — so THIS BANNER CANNOT FIRE YET. D8 is only
// half-fixed until _success_login() is changed to redirect to
// "/?verified=1" specifically (and only) on a successful /auth/verify.
// main.ts fails completely silently in the meantime (by design — a missing
// marker must never be mistaken for "the user isn't signed in", which is
// the normal, majority case on a public site and must never show this
// banner) — but that silence also means this half of D8 is NOT actually
// closed end-to-end without that one-line server redirect change.
//
// Exported as a plain render function (no mount-into-body side effect, no
// closure state) so app/tests/account-settings.test.mjs can assert on the
// real DOM it produces the same way achievements.ts's renderSignInBanner is
// tested — see that file's own comment on why.

import './cookieWarning.css'

export function renderCookieBlockedBanner(): HTMLElement {
  const banner = document.createElement('div')
  banner.className = 'pg-cookie-banner'

  const text = document.createElement('p')
  text.className = 'pg-cookie-banner-text'
  // Names the actual mechanism (a blocked cookie), not a vague "something
  // went wrong" — a reader who doesn't know what a cookie is still gets
  // "your browser" + "try a different browser" as an actionable next step.
  text.textContent =
    "Your sign-in link worked, but your browser blocked the cookie that keeps you signed in — so you're still signed out. Check your browser's cookie or privacy settings for this site, or try a different browser."

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'pg-cookie-banner-close'
  closeBtn.setAttribute('aria-label', 'Dismiss')
  closeBtn.textContent = '✕' // ✕
  closeBtn.addEventListener('click', () => banner.remove())

  banner.append(text, closeBtn)
  return banner
}
