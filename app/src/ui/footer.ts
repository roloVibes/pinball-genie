// ui/footer.ts — compact, low-chrome legal/contact footer. Reused at the end
// of the Goals tab's goal list (app.ts's renderGoalList) and the
// Achievements tab's overview (ui/achievements.ts's renderOverview) — the
// bottom of each panel's SCROLLABLE content, not a fixed strip (app.ts's
// shell already spends its fixed-strip budget on the ad slot + tab bar; see
// ui/adslot.ts's header comment — a third one isn't in scope here). The
// How-To sheet's own `.pg-howto-legal` block (ui/howto.ts) gets the same five
// links appended inline in ITS own established style instead of importing
// this component wholesale — that block predates this file and already
// carries the fuller non-affiliation/IP copy this footer intentionally
// doesn't repeat (this footer is meant to stay compact).

import './footer.css'

// Re-exported through ui/instagram.ts so all five surfaces that link the
// profile share one URL and one handle spelling (that file's header explains
// why this is worth centralising).
import { INSTAGRAM_HANDLE, INSTAGRAM_URL } from './instagram'

const CONTACT_EMAIL = 'admin@pinball-genie.com'

interface FooterLink {
  label: string
  href: string
  external?: boolean
}

/** Shared by ui/howto.ts's legal block too (same five destinations, just
 *  rendered in that file's own markup/classes) — single source of truth for
 *  the actual hrefs so the two places can't drift apart. */
export const FOOTER_LINKS: FooterLink[] = [
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
  { label: `Follow ${INSTAGRAM_HANDLE}`, href: INSTAGRAM_URL, external: true },
  // admin@ added 2026-07-30: _Business/LAUNCH-CHECKLIST.md specifies the
  // footer as "© … · Privacy · Terms · About · @pinballgenie · admin@", and
  // an ad network's site review looks for a reachable operator contact in
  // page chrome, not only on a /contact page it has to find first.
  { label: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}` },
]

/** Builds the footer element (a <footer>, one copyright line + a wrapping
 *  row of links). Pure/stateless — no AppState dependency, so any panel can
 *  append it without wiring anything else up. */
export function renderFooter(): HTMLElement {
  const footer = document.createElement('footer')
  footer.className = 'pg-footer'

  const copyright = document.createElement('div')
  copyright.className = 'pg-footer-copyright'
  copyright.textContent = '© 2026 Pinball Genie LLC'

  const nav = document.createElement('nav')
  nav.className = 'pg-footer-links'
  nav.setAttribute('aria-label', 'Legal and contact')

  for (const link of FOOTER_LINKS) {
    const a = document.createElement('a')
    a.className = 'pg-footer-link'
    a.href = link.href
    a.textContent = link.label
    if (link.external) {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
    nav.appendChild(a)
  }

  footer.append(copyright, nav)
  return footer
}
