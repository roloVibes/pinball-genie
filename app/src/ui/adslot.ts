// ui/adslot.ts — the app shell's single bottom ad strip, mounted once by
// app.ts's mountApp() as a flex sibling between #main-content and the tab
// bar (root.append(header.el, main, adSlot, tabBar.el) — ABOVE the tab bar,
// so thumb-reach nav stays on the physical edge, the conventional mobile-app
// ad placement).
//
// Two things ship in this file, deliberately kept apart:
//
// 1. mountAdSlot() — always renders. Right now (2026-07-30) there is no ad
//    network wired in at all (62-machine catalog, tiny audience — see repo
//    business notes), so the only creative this ever shows is a self-hosted
//    "house" banner: plain DOM promoting the app's own Instagram, styled
//    with this app's own amber/charcoal tokens. NO third-party script, NO
//    iframe — so this ships with ZERO CSP change. The "ADVERTISEMENT" label
//    renders unconditionally too, even though the house banner isn't a paid
//    ad — an ad-policy requirement (the slot must never read as in-app
//    content, whether or not a real ad is in it yet) and it also means the
//    label doesn't have to be wired in again later the day a real network ad
//    replaces this banner.
//
// 2. shouldRenderNetworkAds() — a seam for that future network ad, built now
//    rather than bolted on later. See its own doc comment for the invalid-
//    traffic reasoning. It has no real call site yet (nothing calls it
//    besides this file's own commented-out example below) because there is
//    no network creative to gate — the house banner always renders
//    regardless of this function's result.

import './adslot.css'
// Single source of truth for the profile URL, the handle, and the glyph — this
// link appears on five surfaces and a stale handle in any one of them points a
// visitor at a stranger's profile (ui/instagram.ts's header).
import { INSTAGRAM_ARIA, INSTAGRAM_URL, renderInstagramGlyph } from './instagram'

/** Builds the ad slot element. Always renders the house banner; never
 *  throws, never depends on network/auth state (mountApp() calls this
 *  synchronously at boot, same as buildHeader/buildTabBar). */
export function mountAdSlot(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'ad-slot'

  const label = document.createElement('span')
  label.className = 'ad-slot-label'
  label.textContent = 'Advertisement'
  // NOT aria-hidden (was, until 2026-07-30). This label is a policy
  // requirement — ad networks require paid placements to be identifiable as
  // advertising — so it is a disclosure, not decoration. Hiding it from
  // assistive tech would disclose the placement to sighted users only, which
  // is precisely the reader most likely to need it stated.

  // THREE SIBLINGS, NOT TWO (2026-08-14, rolo: "I see the follow pinball
  // genie text on a bottom banner is not centered, make sure that gets
  // centered"). The "Follow" pill used to live INSIDE the banner link, which
  // made the row [label][link[copy][pill]] — and a copy that can only ever be
  // centered inside the link's own box, i.e. pushed right by exactly half the
  // label's width. Measured in Chrome before the change: the copy's centre sat
  // 10px left of the viewport centre at 390px and 11px right of it at 320px.
  //
  // As three siblings the label and the pill are the row's two END SLOTS, and
  // adslot.css sizes them `flex: 1 1 0` so they resolve to the SAME width
  // whenever there is room — which puts the copy on the row's true centre with
  // no measured constants anywhere. See that stylesheet for what happens when
  // there isn't room.
  el.append(label, renderHouseBanner(), renderHouseCta())

  // Network-ad seam (not wired in yet — see this file's header comment). The
  // day a real network lands, its creative replaces/joins the house banner
  // here, gated like:
  //   if (shouldRenderNetworkAds(currentUser)) el.append(renderNetworkCreative())
  // `shouldRenderNetworkAds` is exported now so that gate exists from day
  // one instead of being added under time pressure once an account is
  // already at risk.

  return el
}

/** Self-hosted house banner — "Follow @pinballgenie" linking out to
 *  Instagram. A real <a>, not a <button>, since it's plain outbound
 *  navigation with no in-app side effect (matches ui/footer.ts's Instagram
 *  link and ui/howto.ts's install buttons' own real-vs-synthetic-control
 *  convention). */
function renderHouseBanner(): HTMLElement {
  const a = document.createElement('a')
  a.className = 'ad-slot-creative'
  a.href = INSTAGRAM_URL
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.setAttribute('aria-label', INSTAGRAM_ARIA)

  const copy = document.createElement('span')
  copy.className = 'ad-slot-copy'
  // 2026-07-30: was the 📷 emoji, which rendered as a different picture on
  // every platform (and as a tofu box on some Androids). Now the shared
  // inline-SVG glyph from ui/instagram.ts — one drawing everywhere, inherits
  // this row's colour, no extra request, no CSP change.
  copy.append(renderInstagramGlyph(16))
  const copyText = document.createElement('span')
  copyText.innerHTML = 'Follow <b>@pinballgenie</b>'
  copy.append(copyText)

  a.append(copy)
  return a
}

/** The "Follow" pill — the row's RIGHT END SLOT, and the counterweight that
 *  lets the copy sit on the row's centre (see mountAdSlot's note).
 *
 *  IT IS STILL ONE CONTROL TO ANYONE WHO IS LISTENING. The pill was already
 *  `aria-hidden` decoration inside the banner link; it stays `aria-hidden`
 *  and takes `tabindex="-1"`, so assistive tech and the keyboard still see
 *  EXACTLY ONE link in this strip — the labelled one above — and the tab order
 *  is unchanged. It is a real <a> rather than a <span> only so that the thing
 *  that most looks pressable still navigates when a thumb lands on it, which
 *  is what it did when it was inside the banner. */
function renderHouseCta(): HTMLElement {
  const a = document.createElement('a')
  a.className = 'ad-slot-cta'
  a.href = INSTAGRAM_URL
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.setAttribute('aria-hidden', 'true')
  a.tabIndex = -1
  // The capsule is a CHILD, not the anchor: the anchor is the row's right end
  // SLOT (as wide as the label's, adslot.css), and an amber pill stretched to
  // that width would read as a button the size of a third of the strip.
  const pill = document.createElement('span')
  pill.className = 'ad-slot-cta-pill'
  pill.textContent = 'Follow'
  a.append(pill)
  return a
}

/** Hostname network ads are allowed to render on — the production apex only.
 *  Any dev/staging/preview host (localhost, a droplet's bare IP/nip.io
 *  address during a deploy check, etc.) is never a real visitor, so it must
 *  never generate a network-ad impression either. */
const PRODUCTION_HOSTNAME = 'pinball-genie.com'

/** localStorage escape hatch for the owner's own devices — flipped on
 *  manually (browser devtools), never surfaced in any UI. */
const KILL_SWITCH_KEY = 'pg_ads_kill_switch'

/**
 * Gate for a FUTURE network ad creative (AdSense or similar) — NOT the
 * self-hosted house banner above, which always renders regardless of this
 * function's result.
 *
 * WHY this seam exists before any network is even wired in: ad networks'
 * invalid-traffic policies (Google's AdSense program policies are the
 * concrete case here) treat impressions/clicks generated by the site owner,
 * their friends/family/coworkers, or non-representative dev/test traffic as
 * a policy violation — and the penalty for a pattern of that isn't just
 * losing those impressions' revenue, it's escalation up to PERMANENT closure
 * of the entire AdSense ACCOUNT (every site on it, not just this one). This
 * app's audience is tiny right now, which means a large fraction of any
 * early traffic is guaranteed to be the owner or people he knows testing the
 * app — exactly the profile invalid-traffic detection is built to catch.
 * Building the gate in now, before a network is even chosen, means every
 * future network-ad call site is forced through it from day one, instead of
 * the gate being an afterthought added (or forgotten) only after an account
 * already got flagged.
 *
 * Checks, any one of which disqualifies (fails CLOSED — i.e. "don't render"
 * — on anything ambiguous, since the downside of one wrongly-served
 * impression is negligible but the downside of the account-closure scenario
 * above is not):
 *   - a session exists (`user` is a signed-in username, not null/undefined)
 *     — the owner and anyone he's handed a login to must never generate
 *     network-ad impressions on their own visits;
 *   - `location.hostname` isn't the production apex — catches localhost, any
 *     droplet bare-IP/nip.io host used for deploy checks, and any future
 *     staging subdomain;
 *   - the `pg_ads_kill_switch` localStorage flag is set — a manual, no-UI
 *     escape hatch for the owner's own devices (belt-and-suspenders on top
 *     of the hostname check, e.g. if a device is ever pointed at prod
 *     through some tunnel/proxy that makes the hostname check pass).
 *
 * LEGAL PRECONDITION (rolo, 2026-08-13): the FIRST network-ad call site must
 * land in the same deploy as the legal-page updates, not before them. The
 * disclosure text for a Google network is already pre-written in
 * server/legal/privacy.html ("Advertising" — cookies, Ads Settings and
 * aboutads.info opt-outs); activating ads means rewriting that section from
 * future tense to present, bumping the effective date on /privacy (and /terms
 * if the vendor's terms require flow-down language), and naming any non-Google
 * vendor. Same rule for any feature that changes what's collected or who
 * receives it — analytics, AI calls on user data, uploads, payments: the
 * policy edit ships with the feature, never behind it.
 *
 * @param user The signed-in username, or null/undefined if signed out (same
 *   shape ui/achievements.ts's fetchWhoami() resolves to — pass its result
 *   straight through once a real network call site exists).
 */
export function shouldRenderNetworkAds(user: string | null | undefined): boolean {
  if (user) return false // signed-in session — never our own impressions

  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    return false // can't verify hostname — fail closed rather than guess
  }
  if (window.location.hostname !== PRODUCTION_HOSTNAME) return false

  try {
    // Any non-empty value other than an explicit "off" counts as ON. The
    // earlier `=== '1'` test meant the natural things an owner would actually
    // type into a devtools console on their own phone —
    // `localStorage.pg_ads_kill_switch = true`, or `'yes'`, or `'on'` —
    // silently left ads serving while looking like the switch was thrown. For
    // a control whose entire job is failing closed, a spelling the user is
    // likely to get "wrong" must not be the one that fails open.
    const flag = window.localStorage.getItem(KILL_SWITCH_KEY)
    if (flag !== null && flag !== '' && flag !== '0' && flag !== 'false') return false
  } catch {
    return false // localStorage unavailable (private mode / disabled) — fail closed
  }

  return true
}
