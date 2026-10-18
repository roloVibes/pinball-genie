// ui/howto.ts — full-screen step-by-step guide overlay. New file (field-test
// fix pass, 2026-07-11): the AR flow field test showed rolo never saw a
// working setup step ("Start camera" used to fall straight into OCR
// identify, then a defaulted auto-detect calibration that never locked on).
// This is the plain-language companion: numbered steps for the whole app,
// auto-shown once on first launch and reachable any time.
//
// Entry points (wired by callers, not this module): app.ts's header "?"
// button and main.ts's boot-time first-launch check (see
// maybeAutoOpenHowTo() below). Mounted straight into document.body (like
// app.ts's identify-modal used to be) since it needs to sit above the whole
// app regardless of which tab is active when it's opened.
//
// 2026-07-29 (AR removal — UNIMPORT pattern, app.ts's header comment): this
// guide is rewritten map-first. The corner-tap calibration walkthrough (old
// steps 4/5, including the `renderCornerOrderDiagram` illustration import
// from ar/calibrate.ts) and the freeze/recalibrate steps (old 7/8) are cut
// entirely — there's no camera anywhere in this web app to set up. Old step
// 6 ("pick a shot path") is repurposed to describe the Shots tab's always-
// visible GOAL pill instead of AR's. Dropping the `renderCornerOrderDiagram`
// import is also what frees ar/calibrate.ts from the CORE bundle — it was
// the only runtime call site pulling calibrate.ts's ~730 lines + calibrate.css
// into every visitor's initial download, whether or not they ever opened AR
// (see the AR-removal inventory's §3). ar/calibrate.ts itself is untouched
// and stays fully on disk, just unimported now — same UNIMPORT pattern as
// ar/arview.ts.
//
// 2026-08-11 (wave 2, owner-specced tab-bar rework — see app.ts's own header
// note for the full rationale): three changes here, mirroring app.ts's tab
// bar exactly —
//   - ALL CARD INFO IS REMOVED (owner explicit: "the Card step/bullet added
//     recently gets deleted entirely"). The 2026-08-11 "card beside map"
//     step this note used to sit above, and the intro list's Card bullet,
//     are both gone outright — not reworded, not merged elsewhere. The
//     mobile Card tab itself is retired (app.ts); this guide simply stops
//     mentioning it.
//   - EVERY MENTION OF THE TAB BY ITS OLD NAME BECOMES "Shots" (prose and
//     comments alike, for internal consistency) — the tab is relabeled Shots
//     in app.ts's tab bar (label-only; nothing else about it changed), so a
//     reader hunting for a tab literally called "Map" would find nothing.
//     Bare mentions of "the map"/"the schematic playfield" (the on-screen
//     diagram itself, not the tab's name) are untouched.
//   - A NEW step + intro bullet cover the Study tab (ui/study.ts) — a
//     step-through tour of every shot on the machine, no goal involved. See
//     STEPS' own new entry below for the exact copy.
// The guide's own "Four tabs across the bottom" framing and its four-bullet
// intro list are both PRESERVED AS FOUR (owner: "keep the guide's four-tab
// count") — Study's bullet effectively takes Card's old slot, not an
// addition past four.

import './howto.css'
import { fetchCatalog } from '../models'
import { canInstall, onInstallAvailabilityChange, promptInstall } from './install'
import { FOOTER_LINKS } from './footer'
import './instagram.css'
import { renderInstagramLink } from './instagram'
// THE GUIDE JOINS THE OVERLAY STACK (2026-10-14). It never needed to while it
// was the only dialog up at boot. Since the Study tab became the landing
// screen, the HOW IT PLAYS sheet opens UNDER this guide on a first visit (see
// app.ts's landOnHowItPlays) — and that sheet's keyboard handler only stands
// down for a dialog it can see in ui/overlayStack.ts. Unregistered, this guide
// read as "nothing above me": the sheet's Tab trap pulled focus out of the
// guide into a sheet behind it, and one Escape closed both.
import { claimOverlayKey, isTopmost, popOverlay, pushOverlay, topmostOverlay, OVERLAY_TIER_OVERLAY } from './overlayStack'
import { containsNode, focusableWithin } from './focusRing'

const SEEN_KEY = 'pg_howto_seen'

interface Step {
  n: number
  title: string
  body: string
}

const STEPS: Step[] = [
  {
    // 2026-07-30 (public launch): was "Log in — Sign in with the credentials
    // you were given." maybeAutoOpenHowTo() shows this guide unprompted on
    // first launch, so that made step 1 of the very first thing a public
    // visitor sees an instruction they cannot follow — there are no
    // credentials to hand out any more. Signing in is now strictly optional
    // and only buys cross-device achievement sync.
    n: 1,
    title: 'Start studying',
    body: 'No account needed — pick a machine and go. Sign in only if you want your achievement progress saved across devices.',
  },
  {
    // 2026-08-14 (P6 L3): the header picker is no longer a dropdown of names —
    // it opens the Machine Library, so this step now describes what is
    // actually there. The old copy ("Use the machine picker at the top to
    // choose the game you're playing") would send a reader hunting for a
    // dropdown that no longer exists.
    n: 2,
    title: 'Pick your machine',
    body: 'Tap the machine name at the top to browse every machine we cover. Search by title, maker or year, filter by decade, and tap the ★ on any machine to keep it at the top of the list — the ones you played most recently are up there too.',
  },
  {
    n: 3,
    title: 'Study goals',
    body: 'Browse every goal for the machine on the Goals tab, grouped by type — each one lists its shot-by-step sequence, difficulty, and reward.',
  },
  {
    n: 4,
    title: 'Watch the path draw on the Shots tab',
    body: 'Switch to the Shots tab, tap the GOAL pill at the top, and pick a goal — its shot path draws right on the schematic playfield, starting where the first shot begins. Tap the ‹ readout › bar at the bottom to pause on a single shot, or let it auto-cycle through the whole route.',
  },
  {
    n: 5,
    title: 'Tune the path to how you study',
    body: 'Tap the ☰ button next to the GOAL pill for Trail style (dash or neon), Ball tracer, Path labels, and Line brightness — pick whatever’s easiest for you to read.',
  },
  {
    // 2026-08-11 (wave 2): the Study tab (ui/study.ts) — a step-through tour
    // of every shot on the machine, independent of any goal. Placed right
    // after the Shots-tab steps since both read the same schematic
    // playfield, before Achievements closes the guide out.
    n: 6,
    title: 'Learn a machine on the Study tab',
    body: 'The Study tab walks the same schematic playfield with no goal picked. Start with HOW IT PLAYS at the top of the rail — the machine’s objective and how to start ranking up points. Then press LEARN: it shuffles through every TARGET on the machine, including deck parts, and every LIGHT the playfield uses, lighting each one on the field above as it goes, so you can see exactly what the write-up is describing. Use ‹ › to step, or tap any dot (or a raised/lower deck plate, or a light in the list) to jump straight there; each write-up also has a link to see that shot performed on the Shots tab. Press ACTION BUTTON to see what this machine’s own action button does and when to press it — and if the game has no button, it says that too. Everything here follows the MODEL selector, same as the Shots tab.',
  },
  {
    n: 7,
    title: 'Track your progress',
    body: 'The Achievements tab checks off goals as you complete them and keeps a running tally for every machine you study.',
  },
]

/** Opens the full-screen guide, mounted into document.body. Marks the guide
 *  as seen immediately (covers both the manual "?"/"How to use" entry
 *  points and the auto-open-on-first-launch path — see
 *  maybeAutoOpenHowTo()). Returns a handle so a caller could close it
 *  programmatically, though none currently need to. */
export function openHowTo(): { destroy(): void } {
  markHowToSeen()

  const overlay = document.createElement('div')
  overlay.className = 'pg-howto-overlay'
  // Dialog semantics (P4, 2026-08-14) — mirrors ui/signupgate.ts, which has
  // shipped this since it was written. This overlay covers the entire app;
  // without role/aria-modal a screen reader keeps announcing the tab bar and
  // goal list underneath it as if they were still reachable, and without the
  // Escape handler below a keyboard user's only exit is to find the ✕.
  // Visuals are untouched: none of this renders.
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'pg-howto-title')

  const header = document.createElement('div')
  header.className = 'pg-howto-header'
  const title = document.createElement('div')
  title.className = 'pg-howto-title'
  title.id = 'pg-howto-title'
  title.textContent = 'How to use Pinball Genie'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'pg-howto-close'
  closeBtn.setAttribute('aria-label', 'Close guide')
  closeBtn.textContent = '✕' // ✕
  header.append(title, closeBtn)

  const body = document.createElement('div')
  body.className = 'pg-howto-body'

  const intro = document.createElement('div')
  intro.className = 'pg-howto-intro'
  intro.innerHTML =
    '<p class="pg-howto-intro-text">Pinball Genie is a <b>study tool</b>: it shows you the shot paths for a machine’s goals so you can learn them, then play.</p>' +
    '<p class="pg-howto-intro-text">Four tabs across the bottom:</p>' +
    '<ul class="pg-howto-tabs">' +
    '<li><b>Goals</b> — every goal for the machine, grouped by type, with its step-by-step shots.</li>' +
    '<li><b>Shots</b> — a flat top-down diagram of the playfield with the selected goal’s path drawn on it — dashed or neon trail, with an optional tracer ball (tap the ☰ button next to the GOAL pill to change either).</li>' +
    '<li><b>Study</b> — step through every shot on the playfield one at a time, no goal needed; tap any shot to jump to it, and press LEARN to read what it does.</li>' +
    '<li><b>Achievements</b> — tracks which goals you’ve completed on each machine.</li>' +
    '</ul>' +
    '<p class="pg-howto-intro-text">It runs in <b>any modern phone browser</b> — Safari, Chrome, Firefox, Edge, Samsung Internet — with nothing to install. Adding it to your Home Screen is optional; it just gets you a full-screen app with no address bar. The two cards below cover that for iPhone and Android.</p>' +
    '<p class="pg-howto-intro-disclaimer">Pinball Genie is an independent study tool — not affiliated with or endorsed by any pinball manufacturer. Machine names are trademarks of their respective owners, used only to identify the machines you’re studying.</p>'
  body.appendChild(intro)

  for (const step of STEPS) {
    const row = document.createElement('div')
    row.className = 'pg-howto-step'

    const num = document.createElement('div')
    num.className = 'pg-howto-step-num'
    num.textContent = String(step.n)

    const stepBody = document.createElement('div')
    stepBody.className = 'pg-howto-step-body'
    const stepTitle = document.createElement('div')
    stepTitle.className = 'pg-howto-step-title'
    stepTitle.textContent = step.title
    const stepText = document.createElement('p')
    stepText.className = 'pg-howto-step-text'
    stepText.textContent = step.body
    stepBody.append(stepTitle, stepText)

    row.append(num, stepBody)
    body.appendChild(row)
  }

  const androidInstall = renderAndroidInstallSection()
  body.append(androidInstall.el, renderIOSInstallSection(), renderFollowSection())

  const legal = document.createElement('div')
  legal.className = 'pg-howto-legal'
  const legalTitle = document.createElement('div')
  legalTitle.className = 'pg-howto-legal-title'
  legalTitle.textContent = 'About & legal'
  const legalText = document.createElement('p')
  legalText.className = 'pg-howto-legal-text'
  legalText.textContent =
    'Pinball Genie is an independent study tool. It is not affiliated with, endorsed by, or sponsored by Stern Pinball, Inc., Spooky Pinball LLC, Chicago Gaming Company, Bally, Williams, Gottlieb, Sega, Data East, Capcom, or any other pinball manufacturer or theme/franchise rights holder.'
  const legalText2 = document.createElement('p')
  legalText2.className = 'pg-howto-legal-text'
  legalText2.textContent =
    'All machine names, manufacturer names, and trademarks are the property of their respective owners and are used here only nominatively — to identify the physical machines this app provides study information for. Pinball Genie ships no manufacturer artwork, logos, audio, or game code; all overlays are original schematic diagrams and all goal descriptions are original instructional text written for this app.'
  const legalText3 = document.createElement('p')
  legalText3.className = 'pg-howto-legal-copyright'
  // Pinball Genie LLC is the legal entity as of 2026-07-29 (formed; the
  // placeholder that stood here is retired — non-affiliation-disclaimer.md).
  legalText3.textContent = '© 2026 Pinball Genie LLC. All rights reserved.'
  legal.append(legalTitle, legalText, legalText2, legalText3, renderLegalLinks())
  body.appendChild(legal)

  const footer = document.createElement('div')
  footer.className = 'pg-howto-footer'
  const gotItBtn = document.createElement('button')
  gotItBtn.type = 'button'
  gotItBtn.className = 'pg-howto-gotit'
  gotItBtn.textContent = 'Got it'
  footer.appendChild(gotItBtn)

  // Build-version stamp — diagnostic for "am I on the newest build?"
  // (vite.config.ts's `define`, declared in build-stamp.d.ts). Small/dim so
  // it doesn't compete with the "Got it" CTA above it.
  const buildStamp = document.createElement('div')
  buildStamp.className = 'pg-howto-build-stamp'
  // Machine count is READ FROM THE CATALOG, never hardcoded — the old literal
  // said "56 machines" for weeks after the count reached 62 (2026-07-29).
  // Renders the build id immediately and appends the count when the catalog
  // resolves (same /data/catalog.json the app already fetched, so this is a
  // warm cache hit); a failed fetch just leaves the count off.
  buildStamp.textContent = `Build ${__BUILD_STAMP__}`
  void fetchCatalog()
    .then((machines) => {
      buildStamp.textContent = `Build ${__BUILD_STAMP__} · ${machines.length} machines`
    })
    .catch(() => {})
  footer.appendChild(buildStamp)

  overlay.append(header, body, footer)
  const priorFocus = (document.activeElement as HTMLElement | null) ?? null
  document.body.appendChild(overlay)
  // Full-screen and fixed at z-index 200 (howto.css): the overlay tier.
  pushOverlay(overlay, OVERLAY_TIER_OVERLAY)

  let destroyed = false
  function close(): void {
    if (destroyed) return
    destroyed = true
    document.removeEventListener('keydown', onKey)
    popOverlay(overlay)
    androidInstall.destroy()
    overlay.remove()
    restoreFocus()
  }

  /** WHERE FOCUS GOES WHEN THE GUIDE CLOSES (2026-10-14). Usually back to
   *  whatever opened it (the header "?" chip, the Goals-tab banner). But on a
   *  FIRST visit the landing HOW IT PLAYS sheet opened underneath this guide
   *  while it was up — and deliberately did not take focus (study.ts
   *  toggleStudySheet) — so "what opened it" is nothing at all, or something
   *  behind an aria-modal sheet. Dropping focus there leaves a keyboard or
   *  screen-reader user outside the dialog they are now looking at. So: if
   *  another registered dialog is still on screen, focus goes into IT — back
   *  to the prior element when that was already inside it, else to its first
   *  stop (the sheet's Back button). Only with no dialog left does the prior
   *  element get focus unconditionally. */
  function restoreFocus(): void {
    const top = topmostOverlay() as HTMLElement | null
    if (top) {
      if (priorFocus && containsNode(top, priorFocus)) priorFocus.focus?.()
      else focusableWithin(top)[0]?.focus?.()
      return
    }
    priorFocus?.focus?.()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // CLAIMED, so the same keypress cannot also close a sheet underneath
      // once this one has popped itself mid-dispatch — see claimOverlayKey.
      if (claimOverlayKey(e)) close()
      return
    }
    // TAB WRAP — the other half of aria-modal="true" (2026-10-14). Without
    // it, Tab past the last link walked out of a full-screen dialog into the
    // page behind it (on a first visit, the landing sheet the guide covers).
    // Only while this guide is the dialog on top, and claimed like Escape so
    // no sheet underneath runs its own trap on the same keypress.
    if (e.key !== 'Tab' || !isTopmost(overlay) || !claimOverlayKey(e)) return
    const ring = focusableWithin(overlay)
    if (ring.length === 0) return
    const first = ring[0]!
    const last = ring[ring.length - 1]!
    const active = document.activeElement
    const inside = containsNode(overlay, active)
    // Focus already outside the guide (it started behind it, or escaped) goes
    // to the first stop (the last, on Shift+Tab): the page behind is not
    // reachable while the guide is up.
    if (!inside) {
      e.preventDefault?.()
      ;(e.shiftKey ? last : first).focus?.()
      return
    }
    // Interior Tabs are left to the browser, so its own tab order stands.
    if (e.shiftKey ? active === first || active === overlay : active === last) {
      e.preventDefault?.()
      ;(e.shiftKey ? last : first).focus?.()
    }
  }
  closeBtn.addEventListener('click', close)
  gotItBtn.addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  // Focus the ✕, not the "Got it" button at the very bottom. signupgate.ts
  // focuses ITS primary action because that card is short and the action is
  // the point; this overlay is a long scrolling guide, and focusing a control
  // below ~1200px of content would scroll a keyboard/screen-reader user
  // straight past everything they opened it to read.
  closeBtn.focus?.()

  return { destroy: close }
}

interface PlatformRow {
  title: string
  body: string
}

// 2026-07-29 (Android install parity): Chrome's "Add to Home screen"/"Install
// app" menu item always works without any help from this app — this row is
// just telling people where to find it. The second row plugs in the actual
// live "Install app" button (renderAndroidInstallSection() below) for the
// subset of visits where Chrome has already handed this page a captured
// 'beforeinstallprompt' (see ui/install.ts) — tapping it drives the exact
// same native install flow the menu item does, one tap closer.
// 2026-07-31 (rolo: "Can android users add the app to their home screen too
// and perform the same as iOS? Can this work on any browser?").
//
// Verified before writing this, rather than assumed: the app ships 78 KB of
// its own JavaScript, zero third-party code, no camera/WebGL/engine-specific
// APIs in the bundle (getUserMedia appears only in unimported AR source — 0
// occurrences in dist), and every -webkit- CSS property is paired with its
// unprefixed form. Nothing in it is tied to one engine, so the STUDY TOOL
// itself runs in any current mobile browser with no install at all.
//
// Installing to the Home Screen is the only part that differs, and it differs
// because of the browsers, not because of us:
//   - Chromium-family on Android (Chrome, Edge, Samsung Internet) fires
//     'beforeinstallprompt', so ui/install.ts's live "Install app" button
//     appears by itself. Nothing to explain.
//   - Firefox on Android installs fine but never fires that event, so the
//     button stays hidden and the user needs the menu path. The old copy said
//     only "In Chrome, tap the ⋮ menu", which left those users with no
//     instructions at all.
//   - On iOS every browser is WebKit underneath, and Safari's Share sheet is
//     the dependable route.
//
// Android also has NO equivalent of the iOS sign-in trap: a Chromium PWA
// shares the browser's cookie jar, so a session created in the browser is
// already there in the installed app. That is stated explicitly so an Android
// reader doesn't apply the iPhone section's "sign in FIRST" warning and
// conclude something is broken when it isn't.
const ANDROID_ROWS: PlatformRow[] = [
  {
    title: 'Install it (Chrome, Edge, Samsung Internet)',
    body: 'An "Install app" button appears in this guide as soon as your browser offers it — just tap that. If you don’t see it, use the ⋮ menu and pick "Install app" or "Add to Home screen". Genie then opens full-screen with no address bar.',
  },
  {
    title: 'On Firefox for Android',
    body: 'Firefox installs Genie fine, it just doesn’t offer the one-tap button. Tap the ⋮ menu and choose "Install" (older versions say "Add to Home screen").',
  },
  {
    title: 'Your sign-in carries straight over',
    body: 'Unlike iPhone, the installed app on Android shares your browser’s sign-in — if you were signed in before installing, you still are, and signing in later in either place works too. The "sign in first" warning in the iPhone section below does not apply to you.',
  },
]

// 2026-07-29 (AR removal): rows 1/3/4/5 of the original 6 ("Use Safari for
// AR", "the Home Screen copy is a separate app to iOS" [camera permission],
// "if the camera never prompts", "first calibration downloads the tracker")
// are cut — all camera-specific, and there's no camera anywhere in this web
// app. The remaining two are general iOS-PWA advice, unrelated to the
// camera: "Add to Home Screen" is kept verbatim; "Low Power Mode" is kept
// but trimmed to drop its now-nonexistent camera-feed clause (it still
// throttles the Shots tab's rAF tracer/marching-highlight animation, so the
// rest of the advice is still true).
// 2026-07-31, from rolo hitting both of these on his own phone.
//
// The sign-in row USED to say "the first time you open it, log in once more".
// That advice does not work, and it is worth understanding why rather than
// rewording it: iOS gives a Home Screen app its own storage container,
// separate from Safari's. A magic link arrives in Mail, and Mail opens links
// in SAFARI — so the session lands in Safari's container, never the installed
// app's. Signing in "from inside" the installed app is therefore impossible
// as long as the link round-trips through an email client, which it always
// does. The only sequence that works is: sign in in Safari FIRST, then
// install — the install inherits the signed-in state. So that is what this
// now says, as step one, before the install instructions.
const IOS_ROWS: PlatformRow[] = [
  {
    title: 'Sign in FIRST, then install',
    body: 'iOS gives a Home Screen app its own separate storage, and a sign-in link opened from Mail always lands in Safari — so tapping the link can leave the installed copy still signed out. That is why the sign-in email also carries a short code. Open Genie from your Home Screen, tap Sign in, enter your address, then type that code on the same screen — it signs in the app you are actually standing in. (Signing in first and installing afterwards still works too.)',
  },
  {
    title: 'Add it to your Home Screen',
    body: 'In Safari, tap the Share button at the bottom of the screen (the square with the arrow), scroll down, tap "Add to Home Screen", then Add. Genie opens full-screen with no browser bars.',
  },
  {
    title: 'Getting updates',
    body: 'Genie updates itself — but iOS can hold on to an old copy while the app is only backgrounded. If something looks stale or a fix you were expecting is missing, swipe Genie away in the app switcher and reopen it; that fetches the current version. Deleting and re-adding it also works and is the sure fix, but you should rarely need it.',
  },
  {
    title: 'Low Power Mode throttles the Shots tab',
    body: 'iOS caps frame rate and background work in Low Power Mode, so the Shots tab’s shot-path animation gets choppy. Turn it off before a study session.',
  },
]

/** Amber "ON ANDROID" section — same card styling as the iPhone section
 *  below it (shared `.pg-howto-ios` class; the class name predates Android
 *  support and is left as-is rather than churning every call site for a
 *  rename). Renders first: Android is the more common install path for new
 *  users of a web app with no App Store listing, and there's no reliable,
 *  worth-the-complexity way to detect the visitor's platform up front to
 *  order these dynamically instead.
 *
 *  Also renders the live "Install app" button: hidden/disabled until
 *  ui/install.ts's canInstall() is true (Chrome has handed over a captured
 *  'beforeinstallprompt'), and kept in sync afterward via
 *  onInstallAvailabilityChange() — covers both "prompt arrives after this
 *  guide is already open" and "user installs, so hide the button again"
 *  without the caller needing to re-open the guide to see the right state.
 *  Returns a `destroy()` so the caller (openHowTo's close()) can unsubscribe
 *  when the overlay is torn down instead of leaking a listener per open. */
function renderAndroidInstallSection(): { el: HTMLElement; destroy(): void } {
  const android = document.createElement('div')
  android.className = 'pg-howto-ios'

  const eyebrow = document.createElement('div')
  eyebrow.className = 'pg-howto-ios-eyebrow'
  eyebrow.textContent = 'ON ANDROID'
  android.appendChild(eyebrow)

  for (const row of ANDROID_ROWS) {
    const rowEl = document.createElement('div')
    rowEl.className = 'pg-howto-ios-row'
    const title = document.createElement('div')
    title.className = 'pg-howto-ios-row-title'
    title.textContent = row.title
    const text = document.createElement('p')
    text.className = 'pg-howto-ios-row-text'
    text.textContent = row.body
    rowEl.append(title, text)
    android.appendChild(rowEl)
  }

  const installRow = document.createElement('div')
  installRow.className = 'pg-howto-ios-row pg-howto-install-row'
  const installTitle = document.createElement('div')
  installTitle.className = 'pg-howto-ios-row-title'
  installTitle.textContent = 'Or install it right here'
  const installText = document.createElement('p')
  installText.className = 'pg-howto-ios-row-text'
  installText.textContent =
    'When your browser offers it, this button does the same thing as the menu above in one tap.'
  const installBtn = document.createElement('button')
  installBtn.type = 'button'
  installBtn.className = 'pg-howto-install-btn'
  installBtn.textContent = 'Install app'

  function sync(): void {
    // Hide the whole ROW, not just the button — otherwise iOS/desktop (where
    // beforeinstallprompt never fires) shows a heading + copy pointing at a
    // control that isn't there (review defect, 2026-07-29).
    installRow.hidden = !canInstall()
  }
  sync()

  installBtn.addEventListener('click', () => {
    void promptInstall()
  })
  const unsubscribe = onInstallAvailabilityChange(sync)

  installRow.append(installTitle, installText, installBtn)
  android.appendChild(installRow)

  return { el: android, destroy: unsubscribe }
}

/** Amber "ON IPHONE — READ BEFORE YOU INSTALL" section (correction 15) —
 *  replaces the old plain `.pg-howto-ios` block. */
function renderIOSInstallSection(): HTMLElement {
  const ios = document.createElement('div')
  ios.className = 'pg-howto-ios'

  const eyebrow = document.createElement('div')
  eyebrow.className = 'pg-howto-ios-eyebrow'
  eyebrow.textContent = 'ON IPHONE — IF YOU INSTALL, READ THIS FIRST'
  ios.appendChild(eyebrow)

  for (const row of IOS_ROWS) {
    const rowEl = document.createElement('div')
    rowEl.className = 'pg-howto-ios-row'
    const title = document.createElement('div')
    title.className = 'pg-howto-ios-row-title'
    title.textContent = row.title
    const text = document.createElement('p')
    text.className = 'pg-howto-ios-row-text'
    text.textContent = row.body
    rowEl.append(title, text)
    ios.appendChild(rowEl)
  }

  return ios
}

/** "Follow along" card in the how-to sheet, 2026-07-30 (rolo: put the
 *  Instagram link "in the opening statements when people register and the help
 *  section"). This IS the help section; the how-to sheet is also what
 *  maybeAutoOpenHowTo() shows unprompted on a visitor's first launch, so it
 *  doubles as the opening statement until Phase 5's registration screen exists
 *  — that screen should call renderInstagramLink() too rather than
 *  re-authoring this. Sits after the install cards because installing is the
 *  more useful action for a first-time visitor. */
function renderFollowSection(): HTMLElement {
  const card = document.createElement('div')
  card.className = 'pg-howto-follow'

  const eyebrow = document.createElement('div')
  eyebrow.className = 'pg-howto-follow-eyebrow'
  eyebrow.textContent = 'FOLLOW ALONG'

  const text = document.createElement('p')
  text.className = 'pg-howto-follow-text'
  text.textContent =
    'New machines, features, and behind-the-scenes progress get posted to Instagram. Questions or requests? Reach out there or email admin@pinball-genie.com.'

  card.append(eyebrow, text, renderInstagramLink())
  return card
}

/** Legal/contact links row appended to `.pg-howto-legal`, 2026-07-30
 *  (footer+ad-slot pass) — the same five destinations as ui/footer.ts's
 *  Goals/Achievements footer (imported from there as `FOOTER_LINKS` so the
 *  two places can't drift apart on a URL), rendered in this file's own
 *  `.pg-howto-legal-*` styling rather than reusing footer.ts's markup
 *  wholesale — this block predates that footer and already carries the
 *  fuller non-affiliation/IP paragraphs above it. */
function renderLegalLinks(): HTMLElement {
  const nav = document.createElement('nav')
  nav.className = 'pg-howto-legal-links'
  nav.setAttribute('aria-label', 'Legal and contact')
  for (const link of FOOTER_LINKS) {
    const a = document.createElement('a')
    a.className = 'pg-howto-legal-link'
    a.href = link.href
    a.textContent = link.label
    if (link.external) {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
    nav.appendChild(a)
  }
  return nav
}

function markHowToSeen(): void {
  localStorage.setItem(SEEN_KEY, '1')
}

function hasSeenHowTo(): boolean {
  return localStorage.getItem(SEEN_KEY) === '1'
}

/** Auto-open-on-first-launch entry point. Cheap to call unconditionally
 *  (this module is statically imported by main.ts/app.ts — see main.ts's own
 *  boot-time check, which duplicates SEEN_KEY's literal value so returning
 *  visitors don't pay for fetching this chunk at all). */
export function maybeAutoOpenHowTo(): void {
  if (!hasSeenHowTo()) openHowTo()
}
