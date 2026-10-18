// ui/instagram.ts — the shared "Follow @pinballgenie on Instagram" call-to-action
// and its glyph. New 2026-07-30 (rolo: "add an instagram image that sends a user
// to https://www.instagram.com/pinballgenie/ … in the opening statements when
// people register and the help section").
//
// ONE definition, used everywhere, because this link now appears in five
// places (how-to sheet, ad-slot house banner, both footers, the login page) and
// a stale handle or a broken URL in any of them sends a visitor to a stranger's
// profile.
//
// Why the glyph is an INLINE SVG drawn here rather than an image file:
//
//   * CSP. The production header set (deploy-prod.sh) has no permissive
//     `img-src`, and adding a remote origin for one logo would widen the policy
//     on the origin that holds session cookies. Inline SVG in markup is not
//     covered by `style-src`/`script-src` at all — it needs zero CSP change and
//     zero network request. (An <img> pointing at a self-hosted PNG would also
//     work, but costs a request and a raster asset per density.)
//   * Trademark. This is deliberately the generic rounded-square-camera glyph
//     in the app's own amber, NOT a reproduction of Instagram's gradient
//     wordmark/logo. Using a plain camera outline to label an outbound link to
//     our own Instagram profile is referential use of the same kind the Terms'
//     Trademarks clause describes for machine names — we identify the
//     destination without dressing our UI in someone else's brand asset. Do not
//     "improve" this by pasting in the official gradient logo.
//
// The canonical profile URL is the www/trailing-slash form rolo supplied. Both
// that and the bare `instagram.com/pinballgenie` resolve, but keep one spelling
// so every surface is provably identical.

export const INSTAGRAM_URL = 'https://www.instagram.com/pinballgenie/'
export const INSTAGRAM_HANDLE = '@pinballgenie'

/** Accessible name shared by every Instagram control. Says where it goes and
 *  that it leaves the app — the icon alone is not a label. */
export const INSTAGRAM_ARIA = 'Follow Pinball Genie on Instagram (opens in a new tab)'

/**
 * The camera glyph as a detached <svg> element.
 *
 * `aria-hidden` because it is always accompanied by real text ("Follow
 * @pinballgenie") or sits inside a link that already carries
 * INSTAGRAM_ARIA — announcing it twice is noise for a screen-reader user.
 *
 * @param size Edge length in CSS px (square). Defaults to 18, which lines up
 *   with the 13px body copy the how-to sheet and footers use.
 */
export function renderInstagramGlyph(size = 18): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  // currentColor so the glyph inherits whatever amber/dim tone its container
  // already uses, in every one of the five placements, with no extra CSS.
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('pg-ig-glyph')

  // Body: rounded square.
  const body = document.createElementNS(NS, 'rect')
  body.setAttribute('x', '3')
  body.setAttribute('y', '3')
  body.setAttribute('width', '18')
  body.setAttribute('height', '18')
  body.setAttribute('rx', '5')
  svg.appendChild(body)

  // Lens: centre circle.
  const lens = document.createElementNS(NS, 'circle')
  lens.setAttribute('cx', '12')
  lens.setAttribute('cy', '12')
  lens.setAttribute('r', '4.2')
  svg.appendChild(lens)

  // Flash: filled dot, top-right.
  const flash = document.createElementNS(NS, 'circle')
  flash.setAttribute('cx', '17.2')
  flash.setAttribute('cy', '6.8')
  flash.setAttribute('r', '1.15')
  flash.setAttribute('fill', 'currentColor')
  flash.setAttribute('stroke', 'none')
  svg.appendChild(flash)

  return svg
}

/**
 * A complete outbound Instagram link: glyph + "Follow @pinballgenie".
 *
 * A real `<a>` (not a button) because it is plain outbound navigation with no
 * in-app side effect, and `rel="noopener noreferrer"` because it opens a new
 * tab — without `noopener` the opened page gets a handle on our `window`.
 *
 * @param className Extra class for the host surface's own styling. The link
 *   always carries `pg-ig-link` so instagram.css can style all five placements
 *   at once.
 * @param label Override the visible text (e.g. a shorter form in tight chrome).
 */
export function renderInstagramLink(className?: string, label = `Follow ${INSTAGRAM_HANDLE}`): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = className ? `pg-ig-link ${className}` : 'pg-ig-link'
  a.href = INSTAGRAM_URL
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.setAttribute('aria-label', INSTAGRAM_ARIA)

  const text = document.createElement('span')
  text.className = 'pg-ig-text'
  text.textContent = label

  a.append(renderInstagramGlyph(), text)
  return a
}
