// Boot entry point. No native 1:1 source (native apps boot via
// MainActivity.kt / PinballGenieApp.swift + SwiftUI @main); this is the
// vanilla-DOM equivalent: fetch the catalog, restore persisted state, mount
// the shell.
//
// 2026-07-28 (Shot Coach, README "State" / shotcoach-corrections.md #11):
// celebrations are removed from the product, so the WebAudio-unlock wiring
// that primed fx/sound.ts for playCelebration() is gone too — nothing left
// in the app calls it. fx/sound.ts stays on disk, unimported by anything
// (same pattern as ar/quaddetect.ts).
import { createAppState } from './state'
import { mountApp } from './app'
// Static import: the how-to guide is now bundled into the core (app.ts imports
// it too, for the always-reliable Help button/banner), so there is no separate
// chunk to lazily fetch and no chance of a silent chunk-load failure. Using
// maybeAutoOpenHowTo() keeps the first-run gate logic in one place.
import { maybeAutoOpenHowTo } from './ui/howto'
// D8 (2026-07-29 review, reproduced) — both static imports, same reasoning
// as ui/howto.ts above: this is boot-critical error surfacing, not a lazy
// feature, so it must never be at the mercy of a second chunk load.
import { renderCookieBlockedBanner } from './ui/cookieWarning'
import { getSession } from './ui/session'
// Offline support (2026-10-14) — static import for the same reason as the two
// above: the module that explains "the network is gone" cannot itself sit
// behind a network fetch.
import { installOfflineIndicator, registerServiceWorker } from './ui/offline'

// D8: the query-param name a successful GET /auth/verify would need to
// redirect back to "/" with — see ui/cookieWarning.ts's header for the full
// contract and the (confirmed, as of this writing) fact that
// pinball_auth.py's _success_login() does NOT send this yet. One literal
// here, not re-derived anywhere else in this module.
const VERIFIED_PARAM = 'verified'

async function boot(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) {
    throw new Error('main.ts: #app root element missing from index.html')
  }

  // D8: read + immediately strip the marker BEFORE anything else touches
  // location.search — a page refresh or back-navigation to this exact URL
  // must never re-run this check a second time for the same landing (that
  // way lies the "loops forever" bug this whole feature exists to end).
  // Absence of the param is the OVERWHELMINGLY common case (every normal
  // page load, every signed-out visitor) and must do nothing whatsoever —
  // see cookieWarning.ts's header for why a false positive here would be
  // worse than the silent failure mode this replaces.
  const justVerified = new URLSearchParams(location.search).get(VERIFIED_PARAM) === '1'
  if (justVerified) {
    const url = new URL(location.href)
    url.searchParams.delete(VERIFIED_PARAM)
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }

  // Before the catalog fetch, so a visitor who boots offline from the worker's
  // cache sees why — even if that fetch then fails and the error path renders.
  installOfflineIndicator()

  try {
    const state = await createAppState()
    mountApp(root, state)
    // STACKING ORDER WITH THE LANDING (2026-10-14). mountApp lands on the
    // Study tab and asks for its HOW IT PLAYS sheet (app.ts landOnHowItPlays);
    // that sheet actually opens a moment later, when the Study chunk arrives.
    // On a FIRST visit this guide opens now, in the overlay tier, ON TOP of
    // it — deliberately: the guide is about using the app at all and is shown
    // once, HOW IT PLAYS is about this machine and is where the visitor lands
    // every time, so read the guide, close it, and the machine's objective is
    // what is underneath. The sheet opens without taking focus while the guide
    // is up (study.ts toggleStudySheet asks overlayStack), and the guide is
    // registered there so the sheet's Tab/Escape handling stands down for it
    // (ui/howto.ts). Returning visitors never see the guide and land straight
    // on HOW IT PLAYS.
    maybeAutoOpenHowTo()
    if (justVerified) {
      // Fire-and-forget: never blocks first paint on a network round trip.
      // getSession() is the SAME shared /whoami call ui/achievements.ts and
      // ui/account.ts use (ui/session.ts's memoization) — this doesn't cost
      // a second request even if the Achievements tab is opened moments
      // later.
      void getSession().then((session) => {
        if (!session) root.prepend(renderCookieBlockedBanner())
      })
    }
  } catch (err) {
    root.innerHTML = ''
    const msg = document.createElement('div')
    msg.className = 'state-message error'
    msg.textContent =
      err instanceof Error
        ? `Couldn't load Pinball Genie: ${err.message}`
        : "Couldn't load Pinball Genie."
    root.appendChild(msg)
    console.error('[pinball-genie] boot failed', err)
  }
}

// The worker registers AFTER boot settles (success or failure alike) and is
// fire-and-forget: it only affects the NEXT load, so first paint never waits
// on it. A boot that failed for lack of network is exactly the visitor the
// worker exists for, hence `finally`.
void boot().finally(registerServiceWorker)
