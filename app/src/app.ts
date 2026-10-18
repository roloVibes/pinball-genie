// App shell: sticky header (machine picker + Help/Glossary), the Goals|Card|Map|
// Achievements tab bar, and the Goals tab's category-grouped goal list/detail
// view. Native
// references:
//   PinballGenieAndroid/.../ui/GoalBrowser.kt (goal cards, step controls, chips)
//   PinballGenieAndroid/.../Models.kt (GoalCategory label/color)
// Adapted for mobile-first single-column web: native shows a horizontal goal
// card rail + a persistent step-controls bar; this port instead drill-downs
// from a category-grouped list into a full goal-detail screen (more room per
// goal on a narrow viewport, still same underlying state machine).
//
// Map ("#map-host") is mounted lazily (dynamic import(), first-visit-only) by
// mountApp below, wiring overlay/map2d.ts — owned by another agent/the
// integrator. The header "?" how-to button is wired the same way, via
// ui/howto.ts. Keeping these behind dynamic import() is what the
// integrator's build brief calls "so the core app stays light".
//
// 2026-07-11 field-test fix pass: the header's camera-driven "Identify"
// button + full-screen OCR modal is removed (manual machine picking only).
//
// 2026-07-29 (AR removal — UNIMPORT pattern): the AR tab, its "#ar-host"
// panel, and the `ar`-branch of the tab-select handler are gone from this
// shell. ar/arview.ts (and everything it alone reaches — ar/camera.ts,
// ar/tracker.ts(+worker), the runtime half of ar/homography.ts) stays on
// disk, fully unimported, so it keeps typechecking without shipping in any
// bundle — same "on disk, unreferenced" pattern already used for
// identify/scan.ts, ar/quaddetect.ts, and fx/celebrate.ts/sound.ts (see
// those files' own header comments). AR returns only in the native apps.
// The Map-renderer prefs that used to live only in AR's settings popover
// (Trail style / Ball tracer / Path labels / Line brightness) now have a
// Map-side home — see mountMap2D's own settings-popover block in
// overlay/map2d.ts; trailStyle/ballTracer are unchanged AppState fields
// (same persisted keys), showLabels/lineBrightness are local to map2d.ts,
// same as they were local to arview.ts before.
//
// 2026-07-28 (Shot Coach, design_handoff_shot_coach/README.md "State" /
// shotcoach-corrections.md #11): celebrations are removed from the product
// entirely — no full-screen FX, no inline "Goal complete" state anywhere.
// Goal-detail's last-step completion now just calls state.clearSelection()
// immediately, same as tapping "‹ Goals". fx/celebrate.ts + fx/sound.ts stay
// on disk, unimported by this file (same pattern as ar/quaddetect.ts). The
// fx theme table lives on as ui/fxGlyphs.ts's glyphFor(), which this file
// used for each goal row's leading emoji until BACKGLASS (P5, 2026-08-14)
// dropped that glyph from LIST rows — see renderGoalRow's own note. glyphFor
// is still live in overlay/map2d.ts (the map celebration burst), so the
// module is not dead; this file simply no longer imports it.
//
// 2026-08-11 (Feature 3, owner request): a NARROWER, MAP-SCOPED celebration
// returned — a small emoji-burst Pass drawn by overlay/drawing.ts's
// drawGoalOverlay (Pass 5) at the goal's LAST step, armed by
// overlay/map2d.ts's mountMap2D closure and toggled by the map settings
// popover's CELEBRATION switch (state.ts's `celebration` pref, default ON).
// THE FULL-SCREEN REMOVAL DESCRIBED ABOVE STILL STANDS: this file (the
// non-AR Goals tab) is completely unchanged by Feature 3 — goal-detail's
// last-step completion still just calls state.clearSelection(), no toast,
// [SUPERSEDED 2026-08-14 as to the toast only — see the P7a entry at the end
// of this header; the full-screen removal below is untouched]
// no banner, no full-viewport FX; fx/celebrate.ts's own `celebrate()` (the
// full-screen DOM-canvas version) is STILL unimported by anything in the
// product (checked before building Feature 3 — its independent rAF/
// setTimeout lifecycle, banner, and sound don't fit a per-frame Pass inside
// drawGoalOverlay's existing render loop; Feature 3 built a minimal
// map-scoped burst instead of reusing it — see drawing.ts's own header
// note). Only the Map tab's canvas gained anything back.
//
// 2026-07-13 ("remove the BALL AT selector"): design turn t14's "BALL AT
// filter on the goal sheet" (Start now / Needs setup / Plunger-only-hidden
// footer, entry-flipper chips) is REVERTED — renderGoalList() is back to
// design turn t8's plain category-grouped list of every goal on the
// machine, unconditionally (see state.ts's header note: `ballPosition` is
// now a fixed 'any', so there's nothing left to filter/group by). The BALL
// AT chip row itself is gone from buildHeader() too — the 2D map and AR
// overlay already draw each goal's route starting from its own first-step
// shot, which made manually telling the app "where the ball is" redundant.
// Goal-detail's step rows are now individually tappable (state.goToStep) —
// see renderGoalDetail() below — and the Goals tab bottom-bar button always
// returns to the list (see mountApp's tab-select handler).
//
// 2026-07-29 (Achievements): a 3rd tab, "Achievements", sits next to Map —
// mounted lazily via dynamic import() the same way Map is (see
// ui/achievements.ts's own header for the per-user server-backed feature
// this owns). buildTabBar() now returns a `select()` handle in addition to
// its element, so this file's showGoalOnMap() (achievements' "SHOW ME"
// affordance) can drive the SAME tab-switch path a manual tap does —
// "reuse the exact state.select/tab-switch flow goals use today" per the
// feature spec — rather than duplicating panel-visibility/aria-selected
// bookkeeping a second time.
//
// 2026-08-10 (Card tab, phase B3): a 4th tab, "Card", shipped for one day —
// the at-the-machine surface (SKILL SHOT / THE LINE / SAFE / DANGER /
// REMINDERS / PRACTICE, big type, read between balls), mounted lazily like
// Map (ui/machinecard.ts's mountMachineCard), not account-gated. SUPERSEDED
// 2026-08-11 by the wave-2 entry directly below: the mobile Card TAB is
// gone, replaced by Study. ui/machinecard.ts itself is untouched and still
// mounts — see that entry for where its content actually lives now.
//
// 2026-08-11 (wave 2, owner-specced): tab bar is now Goals · Shots · Study ·
// Achievements — three changes, each documented at more length where it's
// implemented:
//   - "Map" is RENAMED to "Shots" — LABEL ONLY. The internal TabId stays
//     'map' (see the TabId union below), `#map-host`'s id is unchanged,
//     overlay/map2d.ts/mountMap2D/every `tabBar.select('map')` call site
//     (showGoalOnMap below) are all untouched. A full TabId rename would
//     ripple into map2d.ts, which this wave's scope restricts to
//     exports/reuse only — the owner spec explicitly offered this label-only
//     escape hatch for exactly that reason. Icon changes too: the old 🗺️
//     emoji is replaced with the plain text glyph '◎' (U+25CE BULLSEYE,
//     default text presentation, not emoji-presentation) — a literal target,
//     and in line with Card/Achievements' existing "no new emoji" rule
//     (buildTabBar's own comment) now that this tab is being touched anyway.
//   - "Card" is REMOVED as a mobile/narrow tab outright — no
//     `if (tab === 'card' ...)` branch, no `cardPanel`, no `cardMounted`
//     below. ui/machinecard.ts (mountMachineCard/renderMachineCard) is
//     UNCHANGED and still mounts — but only from overlay/map2d.ts's own
//     wide-viewport "card beside map" column (>=900px). There is now NO
//     mobile/narrow-viewport surface for Card content at all — a real,
//     acknowledged gap (see this phase's own report), not an oversight.
//   - "Study" is NEW — ui/study.ts's mountStudy, a step-through tour of
//     every shot on the machine (no goal, no route). Mounted lazily the
//     exact way Map/Card were, NOT account-gated (content, like Goals/Map).
//     No clearSelection()-equivalent on tap, same reasoning Card's own
//     now-superseded note above gave: study.ts owns its own tour-position/
//     LEARN-sheet state entirely internally (state.onChange subscription,
//     same pattern map2d.ts's local `mapLevel`/`settings` already
//     establish for view state with no business in AppState), so there is
//     nothing here for a tab tap to reset. `lastOpenTab`'s existing
//     `if (tab !== 'achievements') lastOpenTab = tab` needs no change
//     either — 'study' (like 'card' before it) is just another non-
//     Achievements tab as far as that line is concerned. Icon is '▤'
//     (U+25A4 SQUARE WITH HORIZONTAL FILL) — REUSED from the just-removed
//     Card tab (freed up by its removal) rather than the settings-popover's
//     own '☰' glyph, which ui/howto.ts's copy already uses in prose to mean
//     "the Map/Shots tab's settings button" — reusing that one for a
//     different tab risked exactly the kind of glyph-means-two-things
//     confusion the "no new emoji" rule exists to avoid in the first place.
//
// 2026-08-11 (owner: "Remove all cards. That feature has been removed."):
// closes out the "Card" story the two entries directly above tell. The
// overlay/map2d.ts wide-viewport "card beside map" column — the ONLY
// remaining mount point ui/machinecard.ts had, per the wave-2 entry above —
// is itself now removed. ui/machinecard.ts (and its CardEntry/MachineCard
// types, models.ts) goes fully on-disk-only: the same UNIMPORT pattern as
// ar/arview.ts (2026-07-29) and fx/celebrate.ts (2026-07-28, both above) —
// unimported by anything in this app, still typechecks, ships in no bundle.
// data/*_goals.json's `card` key is stripped from the 5 machines that had
// it (jaws/evil_dead/halloween/harry_potter/sonic_the_hedgehog). `drills`
// data is untouched (the owner named cards, not drills) but, with
// machinecard.ts unmounted, currently has no surface that renders it either
// — dormant, not retired.
//
// 2026-08-14 (P7a, Goals ⇄ Map bridge). Three things land in this file, and
// the first one SUPERSEDES A DECISION RECORDED ABOVE — flagged here rather
// than quietly edited out of the 2026-08-11 entry, because that entry's
// reasoning is still the reason there is no celebration:
//
//   1. COMPLETION FEEDBACK, and the "no toast" line above with it. Finishing
//      a goal cleared the selection and the screen simply vanished — the same
//      thing that happens when you give up and tap "‹ Goals", which made the
//      one moment the app should acknowledge the least eventful thing in it.
//      The last step's ✓ now shows ui/toast.ts's 2.4s status pill ("<title>
//      — done") and marks the row it drops you back onto (see
//      `justCompletedGoalId` in mountApp: a transient local, one render, no
//      persistence). What is NOT back: the full-screen FX, the banner, the
//      sound, fx/celebrate.ts (still unimported by anything). This is one
//      element and one timer — see ui/toast.ts's header for the shape.
//   2. SHOW ON MAP. Goal detail's sticky step-controls bar gains a ◎ button
//      that jumps to the Shots tab on the goal you are already reading, via
//      the same tabBar.select('map') path showGoalOnMap() below uses. It does
//      NOT re-select the goal: select() resets stepIndex, and jumping to the
//      map mid-goal has to keep your place. Pathless goals never get one —
//      that branch of renderGoalDetail returns before the controls bar exists,
//      which is also the honest answer (they have no route to show).
//   3. GLOSSARY ANCHORS. The step technique chips pass their vocabulary term
//      to openGlossary(term) instead of opening the sheet at the top of a
//      70-term list. Match rule (and the measurement behind it — the two most
//      common chips in the catalog are glossary ALIASES, not term names) is
//      in ui/glossary.ts's findTerm. A chip whose term has no entry at all
//      still opens at the top, which is exactly today's behaviour.
//
// The other half of the bridge — `/?machine=X&goal=Y` — is in state.ts
// (parseDeepLink), and app/scripts/gen-guides.mjs now wraps every guide-page
// goal title in one of those links.
//
// 2026-08-14 (P7b, the bridge's return leg). ONE line changes in this file —
// mountMap2D gains a third argument — but it is what lets the Map tab stop
// hiding goals. Its goal sheet used to silently drop every pathless goal and
// every goal whose route needs a shot the current MODEL doesn't have, so the
// same machine had two different goal lists depending on which tab you were
// standing on, and nothing on screen accounted for the difference. Those rows
// are listed now; a pathless one hands the visitor back HERE, to the goal
// detail that renders its instructions (jumpToGoalDetail in mountApp — the
// tab switch has to come first, see its own comment). The Goals tab's own
// treatment of trim-restricted goals is unchanged and always was the honest
// one: renderGoalRow chips them PREM/LE and never hides them.
//
// 2026-10-14 (rolo walked prod as a first-time visitor). THE LANDING SCREEN
// MOVES FROM GOALS TO STUDY -> HOW IT PLAYS. Boot, and every machine switch
// from the header picker / Machine Library, now selects the Study tab and
// opens its HOW IT PLAYS sheet at the top — landOnHowItPlays in mountApp owns
// it, and its comment carries the reasoning, the deep-link and no-howItPlays
// exceptions, and why the machine-switch half runs in a microtask. What does
// NOT change: the Goals tab's "tap always returns to the list" contract (its
// tab handler is untouched), and all four cross-tab doors (jumpToGoalDetail,
// showGoalOnShots, jumpToStudyCharacter, showGoalOnMap) behave exactly as
// before — showGoalOnMap's own machine switch is explicitly NOT a landing.
// No last-tab is persisted anywhere (state.ts stores machine/trim/prefs only),
// so there was no saved tab for the landing to override.

import type { Goal, GoalCategory, Machine } from './models'
import type { AppState } from './state'
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  clampDifficulty,
  goalReferencesPremiumLe,
  hasDependency,
  instructionsFor,
  isPathless,
  pipsText,
  pipsTextWithEmpty,
  stepChips,
  stepProvenance,
  unlocksAfterText,
} from './ui/goalMeta'
import { getSession } from './ui/session'
import { openSignupGate } from './ui/signupgate'
// Static import (not the previous lazy import('./ui/howto')): the guide is the
// user's only instructions, so opening it must never silently fail on a chunk-
// load hiccup (flaky venue Wi-Fi / iOS Safari cache). The module is a few KB;
// bundling it into the core is worth the guaranteed reliability.
import { openHowTo } from './ui/howto'
import { mountAdSlot } from './ui/adslot'
import { renderFooter } from './ui/footer'
// Static, like the how-to guide and for a smaller version of the same reason:
// the module is ~1KB with no dependencies, and a completion acknowledgement
// that arrives after a network round trip (or not at all, on arcade Wi-Fi)
// is worse than no acknowledgement — the moment it is acknowledging is over.
import { showToast } from './ui/toast'
// Statically imported on purpose: a module whose entire job is to handle "a
// chunk failed to load" must never itself be behind a chunk load. See its
// header for the silent-failure bug this closes.
import { loadChunk, prefetchChunk } from './ui/chunkError'

// 'map' is the SHOTS tab (label-only rename — see the header note above);
// 'card' is retired (no mobile Card tab any more — ui/machinecard.ts lives
// on only via overlay/map2d.ts's wide-viewport card column); 'study' is new.
type TabId = 'goals' | 'map' | 'study' | 'achievements'

/** Element id of the <section> each tab controls, and — via `tab-${id}` — of
 *  the tab button itself. ONE table, read by both mountApp (which stamps the
 *  ids onto the panels and points each panel's aria-labelledby back at its
 *  tab) and buildTabBar (which points each tab's aria-controls at its panel).
 *  A11y linkage that is retyped in two places is a11y linkage that silently
 *  breaks the first time a panel id changes. */
const PANEL_ID: Record<TabId, string> = {
  goals: 'goals-view',
  map: 'map-host',
  study: 'study-host',
  achievements: 'achievements-host',
}
const tabButtonId = (tab: TabId): string => `tab-${tab}`

/** How the shell opens the Machine Library. `focus` says where focus lands —
 *  see ui/library.ts's openLibrary for why a tap and a keyboard activation
 *  want different answers. */
type BrowseMachines = (opener: HTMLElement, focus?: 'close' | 'search') => void

/** One-time nudge toward the Machine Library (P6 L5, 2026-08-14).
 *
 *  The library does NOT auto-open on first launch — ui/howto.ts owns the one
 *  modal a first-time visitor is allowed to be shown, and stacking a second
 *  full-screen overlay behind it would be two things to dismiss before seeing
 *  the app. Instead: a dismissible one-line banner under the how-to banner, and
 *  a single amber pulse on the header button, both of which disappear the
 *  moment the visitor opens the library by any route — including from the
 *  header button itself, which is the thing they were being pointed at. */
const LIBRARY_HINT_KEY = 'pinballgenie.libraryHintSeen'

function libraryHintSeen(): boolean {
  try {
    return localStorage.getItem(LIBRARY_HINT_KEY) === '1'
  } catch {
    // Storage blocked (private mode): treat the hint as seen rather than
    // showing it on every single load forever.
    return true
  }
}

function markLibraryHintSeen(): void {
  try {
    localStorage.setItem(LIBRARY_HINT_KEY, '1')
  } catch {
    /* nothing to do — the in-session state below still hides it */
  }
}

// `sortedByName` used to live here — an alphabetized COPY of state.machines
// that existed solely to order the header <select>'s options, with the
// leading-"The" strip rolo asked for (2026-08-11: he couldn't find Evil Dead,
// because 14 machines were hiding under T). The select is gone as of P6 L3 and
// the rule moved with it, to ui/library.ts's machineSortKey/sortForDisplay,
// which is now the only place a machine list gets sorted for display.
//
// CATEGORY_ORDER/CATEGORY_META/clampDifficulty/pipsText moved to
// ./ui/goalMeta.ts (imported above) so the AR machine/goal sheets share this
// exact metadata instead of duplicating it — see that file's header
// comment. Behavior here is unchanged.

/** Mounts the whole app shell into `root` and subscribes to `state`. */
export function mountApp(root: HTMLElement, state: AppState): void {
  root.innerHTML = ''

  /** Opens the Machine Library from anywhere in the shell, and retires the
   *  first-run hint on the way — "dismissed by use" (P6 L5). Both entry points
   *  (the header button and the Goals-list banner) go through here so the hint
   *  cannot survive the visitor doing the thing it was nudging them toward.
   *  `renderAll()` afterwards is what actually takes the pulse off the button
   *  and the banner off the list: nothing in AppState changed, so no onChange
   *  is coming. */
  function openMachineLibrary(opener: HTMLElement, focus: 'close' | 'search' = 'close'): void {
    if (!libraryHintSeen()) {
      markLibraryHintSeen()
      renderAll()
    }
    loadChunk(() => import('./ui/library'), 'the machine list', ({ openLibrary }) =>
      openLibrary(state, opener, focus),
    )
  }

  const header = buildHeader(state, openMachineLibrary)

  const main = document.createElement('main')
  main.id = 'main-content'

  /** A tabpanel with no aria-labelledby is an unnamed region: the tab says
   *  "Shots, tab, 2 of 4" and the panel it opens announces nothing at all.
   *  Pointing it back at its own tab button (P4, 2026-08-14) is the other
   *  half of buildTabBar's aria-controls — the two together are what make
   *  this a real tablist rather than four buttons and four sections. */
  function buildPanel(tab: TabId, hidden: boolean): HTMLElement {
    const panel = document.createElement('section')
    panel.id = PANEL_ID[tab]
    panel.className = 'tab-panel'
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tabButtonId(tab))
    panel.hidden = hidden
    return panel
  }

  const goalsPanel = buildPanel('goals', false)
  const mapPanel = buildPanel('map', true)
  const studyPanel = buildPanel('study', true)
  const achievementsPanel = buildPanel('achievements', true)

  /** THE SHOTS TAB'S SPOKEN READOUT (P9, 2026-08-14), owned here.
   *
   *  The map's ‹ SHOT 3 OF 5 › pill is a passive <div> that changes as you
   *  step — a screen reader reads it once, on arrival, and never again. This
   *  is its polite mirror: overlay/map2d.ts writes a sentence-case line into
   *  it on every manual step and every selection change (and exactly once,
   *  not every 2.5s, while the route is auto-cycling).
   *
   *  WHY THE REGION IS APP.TS'S AND NOT THE MAP'S. mountMap2D
   *  replaceChildren()es its host at mount and empties it at destroy(), so a
   *  region built in that file would be destroyed and rebuilt by its own
   *  owner — and a live region has to be in the document BEFORE its text
   *  changes to be announced at all. This one is created with the shell,
   *  outside all four panels (a region inside a `hidden` panel is not
   *  announced), and lives as long as the app does. map2d gets the WRITER,
   *  not the node — the same additive shape as jumpToGoalDetail.
   *  (tests/goal-bridge.test.mjs pins the set of files that own one of these,
   *  and asserts overlay/map2d.ts is not among them.) */
  const mapLive = document.createElement('div')
  mapLive.className = 'sr-only'
  mapLive.setAttribute('role', 'status')

  main.append(goalsPanel, mapPanel, studyPanel, achievementsPanel, mapLive)

  // Mounted once, lazily, on first visit to each tab; all three modules
  // manage their own state.onChange subscriptions afterward (machine
  // switches, goal selection, etc. propagate without re-mounting). Switching
  // tabs thereafter is just the hidden-attribute toggle below.
  let studyMounted = false
  let mapMounted = false
  let achievementsMounted = false
  /** The mounted Study tab, held ONLY so the Shots tab's character rows can
   *  open its CHARACTER sheet (jumpToStudyCharacter below) and the landing can
   *  open HOW IT PLAYS (landOnHowItPlays below). Everything else about that
   *  tab is internal to its own closure — this shell holds a handle, not a
   *  remote control. */
  let studyHandle: { destroy(): void; openCharacter(): void; openHowItPlays(): void } | null = null
  /** A sheet-opening jump into Study that arrived before the Study chunk
   *  finished loading. The tab mount is lazy AND asynchronous (loadChunk
   *  resolves a dynamic import), so the very first such jump — a CHARACTER
   *  row tapped on the Shots tab by someone who never opened Study, or the
   *  LANDING on boot, which always arrives before the chunk — happens with
   *  `studyHandle` still null. Without this it would land on a Study tab with
   *  no sheet open and no way to tell that anything was asked for.
   *  ONE SLOT, LAST REQUEST WINS (2026-10-14: it was a CHARACTER-only boolean
   *  until the landing became a second caller). Two requests inside one chunk
   *  load can only mean the later one is what the visitor is now doing. */
  let pendingStudySheet: 'character' | 'howitplays' | null = null
  // ui/achievements.ts owns its own fetch/save lifecycle rather than
  // subscribing to state.onChange (it's a self-contained, per-user
  // server-backed feature — see that file's header) — the only thing this
  // shell needs back from it is onShow(), so a pending failed save gets
  // retried when the user returns to the tab (feature spec item 5) without
  // this file reaching into its internals.
  let achievementsHandle: { destroy(): void; onShow(): void; onReselect(): void } | null = null

  // The tab the visitor was on before tapping Achievements, so dismissing the
  // sign-up gate puts them back where they were instead of on a blank panel.
  let lastOpenTab: TabId = 'goals'
  // Guards the re-entrant tabBar.select() the dismiss path performs: select()
  // fires this same callback, and without this the gate could re-open itself.
  let returningFromGate = false
  let gateOpen = false
  /** The tab currently shown, so the handler can tell a SWITCH from a
   *  RE-TAP of the tab already active — buildTabBar's onSelect fires on
   *  every click, not only on changes. */
  let activeTab: TabId = 'goals'

  const tabBar = buildTabBar((tab) => {
    // ACHIEVEMENTS IS ACCOUNT-GATED (rolo, 2026-07-31). Everything else in the
    // app — every machine, goals, shot paths, map, glossary — stays open to
    // anyone with no account; this is the single feature that needs an
    // identity, because per-user progress is meaningless without a "who".
    //
    // The check happens HERE rather than inside ui/achievements.ts on purpose:
    // the module must not be imported at all for a signed-out visitor, so the
    // gate cannot be bypassed by anything that module might render, and its
    // chunk isn't downloaded by people who can't use it.
    //
    // getSession() is memoized (ui/session.ts), so this costs one /whoami per
    // page load, not one per tab tap. The `undefined` third state matters:
    // peeking synchronously would show the gate to an already-signed-in user
    // during the first load's in-flight request, so we always await.
    if (tab === 'achievements' && !returningFromGate) {
      void getSession().then((session) => {
        if (session) return // signed in — fall through to the normal mount below
        if (gateOpen) return
        gateOpen = true
        openSignupGate(() => {
          gateOpen = false
          returningFromGate = true
          try {
            tabBar.select(lastOpenTab)
          } finally {
            returningFromGate = false
          }
        })
      })
    }
    const wasReselect = tab === activeTab
    activeTab = tab
    if (tab !== 'achievements') lastOpenTab = tab

    goalsPanel.hidden = tab !== 'goals'
    mapPanel.hidden = tab !== 'map'
    studyPanel.hidden = tab !== 'study'
    achievementsPanel.hidden = tab !== 'achievements'
    // Tapping the Goals tab always lands back on the goal LIST, even if a
    // goal's detail screen was open (also covers tapping Goals again while
    // already there with a detail open — buildTabBar's onSelect fires on
    // every click, not just tab switches). clearSelection() notifies
    // subscribers, so renderAll()/renderGoalsPanel() below re-runs and
    // state.selectedGoal being null makes it render the list.
    if (tab === 'goals') state.clearSelection()
    // Study has no list/detail split for a tab tap to reset — its tour
    // position and LEARN-sheet state are entirely internal to ui/study.ts's
    // own mountStudy closure (state.onChange subscription), the same
    // "nothing here for app.ts to reset" shape the now-removed mobile Card
    // tab had (see the TabId union's own header note above).
    if (tab === 'study' && !studyMounted) {
      studyMounted = true
      loadChunk(
        () => import('./ui/study'),
        'the study map',
        ({ mountStudy }) => {
          studyHandle = mountStudy(studyPanel, state, jumpToGoalDetail, showGoalOnShots)
          // The canvas exists only now — label it the moment it does, rather
          // than waiting for whatever state change happens to come next.
          refreshStudyCanvasLabel()
          // A jump that arrived BEFORE this chunk finished loading is served
          // here — see `pendingStudySheet` for why the slot exists at all.
          const pending = pendingStudySheet
          pendingStudySheet = null
          if (pending === 'character') studyHandle.openCharacter()
          else if (pending === 'howitplays') studyHandle.openHowItPlays()
        },
        () => {
          studyMounted = false
          // The chunk failed, so nothing is going to consume a pending jump:
          // drop it rather than leaving it to fire on some unrelated later
          // visit to the tab.
          pendingStudySheet = null
        },
      )
    }
    if (tab === 'map' && !mapMounted) {
      mapMounted = true
      loadChunk(
        () => import('./overlay/map2d'),
        'the map',
        ({ mountMap2D }) => mountMap2D(mapPanel, state, jumpToGoalDetail, speakMapReadout, jumpToStudyCharacter),
        () => {
          mapMounted = false
        },
      )
    }
    if (tab === 'achievements') {
      // Gated: only import/mount once a session is confirmed. A signed-out
      // visitor gets the prompt above and is bounced back, and this module is
      // never fetched for them at all.
      void getSession().then((session) => {
        if (!session) return
        if (!achievementsMounted) {
          achievementsMounted = true
          loadChunk(
            () => import('./ui/achievements'),
            'achievements',
            ({ mountAchievements }) => {
              achievementsHandle = mountAchievements(achievementsPanel, state, showGoalOnMap)
            },
            () => {
              achievementsMounted = false
            },
          )
        } else if (wasReselect) {
          // Same tab tapped again -> back to THIS machine's achievements, the
          // way re-tapping Goals returns to the goal list.
          achievementsHandle?.onReselect()
        } else {
          achievementsHandle?.onShow()
        }
      })
    }
  })

  /** Achievements tab's "SHOW ME" affordance (feature spec item 4): switches
   *  to `machine` if it isn't already the active one (awaiting the same
   *  selectMachine() a manual header-picker change uses), selects `goal` on
   *  it, then jumps to the Map tab via the SAME tabBar.select() path a
   *  manual tap on the tab bar drives — so the Map tab picks the goal up
   *  exactly as if the user had picked it there themselves. Re-resolves
   *  `goal` against the just-loaded state.data.goals
   *  by id (falling back to the passed-in object if that fails) rather than
   *  trusting the achievements module's own — possibly separately-fetched —
   *  Goal reference, so a goal selected this way is never a stale/foreign
   *  object relative to the machine now actually loaded into state. */
  async function showGoalOnMap(machine: Machine, goal: Goal): Promise<void> {
    if (state.machine?.id !== machine.id) {
      // Not a landing — see `suppressLanding`. The notify that carries the new
      // machine fires INSIDE this await, which is exactly the window the flag
      // covers.
      suppressLanding = true
      try {
        await state.selectMachine(machine)
      } finally {
        suppressLanding = false
      }
    }
    const resolved = state.data?.goals.find((g) => g.id === goal.id) ?? goal
    state.select(resolved)
    tabBar.select('map')
  }

  /** Goal detail's ◎ button (P7a): show the goal you are ALREADY reading on
   *  the Shots map. Deliberately just the tab switch — no state.select().
   *
   *  The goal is already `state.selectedGoal` (that is the only way this
   *  screen is on-screen), and select() resets stepIndex to 0 and highlight
   *  mode to auto. Someone on step 4 of 6 who taps this wants to see step 4
   *  drawn, not to be sent back to the start of the route: the map reads
   *  state.stepIndex, so doing nothing but switching tabs is what preserves
   *  their place. (showGoalOnMap above DOES select, and must: it arrives from
   *  the Achievements tab with a goal that may belong to another machine.)
   *
   *  Not applicable to pathless goals — renderGoalDetail never builds the
   *  button for one; see its own comment. */
  function showSelectedGoalOnMap(): void {
    tabBar.select('map')
  }

  /** The other direction (P7b): the Map tab's goal sheet lists PATHLESS goals
   *  now instead of dropping them, and a pathless goal has no route for that
   *  canvas to draw — so tapping its row hands the visitor to the only screen
   *  that can render it, this tab's goal detail with its instructions.
   *  overlay/map2d.ts's mountMap2D takes this as its trailing-optional third
   *  argument; the sheet closes itself before calling.
   *
   *  THE ORDER IS THE WHOLE FUNCTION. tabBar.select('goals') runs this file's
   *  own tab handler, which calls state.clearSelection() ("tapping the Goals
   *  tab always lands back on the goal LIST"). Selecting first and switching
   *  second would therefore land on the list with the selection wiped — the
   *  detail screen the visitor asked for would flash and vanish. Switch, THEN
   *  select: the clear happens on an empty selection and the select that
   *  follows is what renderAll draws. */
  function jumpToGoalDetail(goal: Goal): void {
    tabBar.select('goals')
    state.select(goal)
  }

  /** Study's "See it on the playfield" door (2026-09-08, rolo). A LEARN detail
   *  — a target or a light — hands the visitor to the Shots tab with one of
   *  this machine's goals SELECTED, so the schematic draws and animates that
   *  goal's route. Same machine (the study tour is always on state.machine), so
   *  no selectMachine — unlike showGoalOnMap, which arrives from the
   *  Achievements tab with a goal that may belong to another. Select FIRST, then
   *  switch: the Shots tab's handler does not clear the selection (only the
   *  Goals tab does), so the map renders the goal the moment it is shown. */
  function showGoalOnShots(goal: Goal): void {
    state.select(goal)
    tabBar.select('map')
  }

  /** The third direction (2026-08-15): the Shots tab's goal sheet lists a
   *  machine's CHARACTER goals — pathless 'progression' entries, the hero you
   *  pick and the gear you carry — and those now have a door of their own on
   *  the Study tab. Tapping such a row lands there instead of on the Goals tab
   *  (owner: "drop character dev info from shots and only have it in study").
   *  overlay/map2d.ts's mountMap2D takes this as its trailing-optional fifth
   *  argument; the sheet closes itself before calling.
   *
   *  NO state.select() HERE, unlike jumpToGoalDetail. That function opens a
   *  DETAIL view, which is a screen for one goal and therefore has to be told
   *  which; this opens a COLLECTION of every character goal on the machine, so
   *  selecting one would only change what the Shots tab draws behind it. The
   *  machine is unchanged by the jump either way.
   *
   *  THE ORDER IS tabBar.select() FIRST, and for a different reason than
   *  jumpToGoalDetail's: selecting the tab is what LAZILY MOUNTS Study on a
   *  first visit, so calling openCharacter() before it would be calling into a
   *  module that has not loaded. On that first visit the handle is still null
   *  even after the switch (the import resolves a task later), which is what
   *  `pendingStudySheet` is for — the mount callback serves it. */
  function jumpToStudyCharacter(): void {
    tabBar.select('study')
    if (studyHandle) studyHandle.openCharacter()
    else pendingStudySheet = 'character'
  }

  /** HOW IT PLAYS IS THE LANDING SCREEN (2026-10-14, rolo's first-time-visitor
   *  walk of prod). The app used to boot onto the Goals tab — a flat list of a
   *  machine's goals, which is the right screen for someone who already knows
   *  the machine and the wrong one for someone meeting it — while the best
   *  beginner screen in the app, the Study tab's HOW IT PLAYS sheet (the
   *  objective, the loop, how to start scoring), sat two taps deep. So: on
   *  boot, and on every machine switch from the header picker / Machine
   *  Library, the visitor lands on Study with HOW IT PLAYS open, at the top,
   *  for the machine that is loaded. Everything else is one tap from there —
   *  Back closes the sheet onto the playfield, the tab bar is unchanged.
   *
   *  SAME TWO-STEP SHAPE AS jumpToStudyCharacter, for the same reason: the
   *  tab switch is what lazily mounts Study, so the open is either served now
   *  (handle in hand) or parked in `pendingStudySheet` for the mount callback.
   *
   *  FALLBACK: a machine with no howItPlays (the validator ERRORs on that for
   *  catalog machines, so this should never trigger) keeps the old behaviour
   *  exactly — no tab switch at all. `hasHowItPlays` is a cheap structural
   *  check, not ui/lights.ts's full howItPlaysOf: that module imports
   *  overlay/map2d.ts, and pulling it into this file would move the whole map
   *  renderer into the core bundle to answer a yes/no. The Study handle's own
   *  openHowItPlays() is the authoritative gate and is inert when the field is
   *  present but unrenderable. */
  function landOnHowItPlays(): void {
    if (!hasHowItPlays(state)) return
    tabBar.select('study')
    if (studyHandle) studyHandle.openHowItPlays()
    else pendingStudySheet = 'howitplays'
  }

  /** The machine the landing last ran for — a machine SWITCH is a change of
   *  this, observed in renderAll. Seeded with the boot machine, so the boot
   *  landing (end of mountApp) is the only one boot gets. */
  let landedMachineId: string | null = state.machine?.id ?? null
  /** Set across showGoalOnMap's machine switch: that path switches machine on
   *  its way to the SHOTS tab with a goal selected (Achievements' SHOW ME), and
   *  landing on Study in the middle of it would leave a HOW IT PLAYS sheet
   *  open on a tab the visitor was never sent to. Only a switch the visitor
   *  made AS a switch — the header picker / Machine Library, or the error
   *  card's retry of one — lands. */
  let suppressLanding = false

  /** The goal whose row should be marked as JUST FINISHED on the next render,
   *  and only that one — consumed and cleared by renderAll below.
   *
   *  A local, not AppState: "which goal did you finish 400ms ago" is view
   *  state with a lifetime of one render, exactly like map2d.ts's `mapLevel`
   *  and study.ts's tour position (both local for the same reason). Nothing
   *  persists it, nothing else reads it, and it survives no re-render — the
   *  app has no concept of a completed goal and this does not sneak one in. */
  let justCompletedGoalId: string | null = null

  /** Last step's ✓ — the whole completion sequence, in the order it has to
   *  happen in. The toast goes up BEFORE clearSelection(), because
   *  clearSelection() notifies synchronously: renderAll() runs inside it, and
   *  the list it renders is the one the toast is describing. */
  function completeGoal(goal: Goal): void {
    showToast(`${goal.title} — done`)
    justCompletedGoalId = goal.id
    state.clearSelection()
  }

  // 2026-07-30 (footer+ad-slot pass): `adSlot` sits ABOVE the tab bar (the
  // conventional mobile placement — thumb-reach nav stays on the physical
  // edge), as a real flex child of `root` (#app) between `main` and
  // `tabBar.el` — NOT appended after tabBar.el, which would render behind
  // the (formerly fixed, now flex) tab bar. See styles.css's `--ad-h` token
  // and ui/adslot.ts's own header comment.
  const adSlot = mountAdSlot()
  root.append(header.el, main, adSlot, tabBar.el)

  /** The one line overlay/map2d.ts is handed to speak with — see `mapLive`
   *  above for why the node stays on this side of the boundary. */
  function speakMapReadout(text: string): void {
    mapLive.textContent = text
  }

  /** First <canvas> under `el`, found by walking `.children` rather than with
   *  a selector — the same reason ui/sheet.ts's focusableWithin walks by hand:
   *  this app's suites drive the real modules against hand-rolled fake DOM
   *  elements that implement children/tagName but no selector engine, and a
   *  label no test can prove is a label that quietly stops existing. */
  function firstCanvas(el: HTMLElement): HTMLElement | null {
    const kids = (el.children ?? []) as unknown as ArrayLike<unknown>
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as HTMLElement | undefined
      if (!child || typeof child.tagName !== 'string') continue
      if (child.tagName === 'CANVAS') return child
      const nested = firstCanvas(child)
      if (nested) return nested
    }
    return null
  }

  /** P9 (2026-08-14): the Study tab's canvas gets the same text alternative
   *  the map's does — role=img plus a name that follows the machine, because
   *  a bare <canvas> is announced as nothing at all.
   *
   *  DONE FROM HERE, not from ui/study.ts, purely so that file is untouched
   *  by this pass; it is a two-attribute write, not a feature living in the
   *  wrong module, and the honest note is that its natural home is
   *  mountStudy's own canvas construction (one line, at ui/study.ts's
   *  `canvas.className = 'study-canvas'`). Safe from here because study.ts
   *  builds that canvas exactly once per mount and never replaces it: the
   *  lookup is re-done on every render anyway, so even a rebuild would be
   *  re-labelled by the next state change. No-op until the tab is visited. */
  function refreshStudyCanvasLabel(): void {
    const canvas = firstCanvas(studyPanel)
    if (!canvas) return
    canvas.setAttribute('role', 'img')
    const name = state.machine?.name ?? state.data?.machine ?? null
    canvas.setAttribute('aria-label', name ? `Study view of ${name}` : 'Study view')
  }

  function renderAll(): void {
    header.update(state)
    // Machine switches arrive here like everything else — the canvas labels
    // have to follow the machine or they name the one you left.
    refreshStudyCanvasLabel()
    renderGoalsPanel(goalsPanel, state, openMachineLibrary, showSelectedGoalOnMap, completeGoal, justCompletedGoalId)
    // CONSUMED. Clearing it here — after the render that used it, not inside
    // the completion handler — is what makes the cue last exactly one render:
    // the very next thing that redraws this list (a step tap, a machine
    // switch, anything) draws it plain.
    justCompletedGoalId = null

    // A MACHINE SWITCH LANDS ON HOW IT PLAYS (see landOnHowItPlays). DEFERRED
    // to a microtask, and the deferral is load-bearing: this listener was
    // subscribed first, so it runs BEFORE the Study tab's own state.onChange
    // handler in the same notify — and that handler, seeing a new machine,
    // closes every open sheet and resets its tour (study.ts syncFromState).
    // Opening HOW IT PLAYS synchronously here would be undone one listener
    // later. The microtask runs after the whole notify has finished, on a
    // Study tab that has already settled onto the new machine.
    const machineId = state.machine?.id ?? null
    if (machineId !== landedMachineId) {
      landedMachineId = machineId
      if (!suppressLanding) queueMicrotask(landOnHowItPlays)
    }
  }

  state.onChange(renderAll)
  renderAll()

  // THE BOOT LANDING — see landOnHowItPlays. Two cases keep the old Goals-tab
  // boot, and both are the visitor having asked for something more specific:
  //   - a `?goal=` deep link (state.ts selects it before mountApp runs, and
  //     "the link lands on the steps" — on the Goals tab's detail screen). A
  //     tab switch here would bury the very goal the link named.
  //   - a machine with no howItPlays (landOnHowItPlays' own fallback).
  // NOTHING IS PERSISTED about the last tab (state.ts stores the machine,
  // trim and prefs, never a tab), so there is no saved tab for this to win
  // against — it IS the boot tab. The first-run how-to guide (main.ts,
  // maybeAutoOpenHowTo) opens over this in the overlay tier; see main.ts.
  if (!state.selectedGoal) landOnHowItPlays()
}

/** Whether the loaded machine has a HOW IT PLAYS to land on — a cheap
 *  structural check (see landOnHowItPlays for why it is not howItPlaysOf). */
function hasHowItPlays(state: AppState): boolean {
  const hip = state.data?.howItPlays
  return !!hip && typeof hip.objective === 'string' && hip.objective.trim() !== ''
}

// ---------------------------------------------------------------------------
// Header: the machine picker + Help/Glossary (no brand tile — see buildHeader)
// ---------------------------------------------------------------------------

function buildHeader(
  state: AppState,
  onBrowseMachines: BrowseMachines,
): { el: HTMLElement; update: (s: AppState) => void } {
  const header = document.createElement('header')
  header.className = 'app-header'

  const top = document.createElement('div')
  top.className = 'header-top'

  // NO BRAND MARK HERE (2026-08-14, rolo). A 32px app-icon tile sat at the top
  // left of every screen doing nothing — not a link, not a control — while the
  // one element in this header with a job was running out of room: on a 390px
  // iPhone the picker truncated at "Jaws (Stern …", and Jaws is the SHORTEST
  // title in the catalog. The tile plus its 10px gap was 42px, and a phone
  // header's job is context and controls, not identity: the brand is already
  // the Home Screen icon the user tapped to get here, the install prompt, the
  // guide pages and the 404. Removing it is the whole of the fix for the
  // truncation; the picker's `flex: 1` takes the space back on its own.
  //
  // THE MACHINE PICKER (P6 L3, 2026-08-14) — a button that opens the Machine
  // Library overlay (ui/library.ts), replacing the native <select> that held
  // 134 <option> rows. That select rendered on a phone as an OS wheel picker:
  // no search, no thumbnails, no memory of what you play, no way to tell a
  // 1977 Gottlieb from a 2024 Stern, and no route to the machine's own guide
  // page. It occupies the SAME header slot at the same size, and update()
  // below keeps its label in sync exactly as it kept the select's value in
  // sync. aria-haspopup="dialog" is what tells a screen reader this opens
  // something rather than navigating.
  const picker = document.createElement('button')
  picker.type = 'button'
  picker.className = 'machine-picker-btn'
  picker.setAttribute('aria-haspopup', 'dialog')
  const pickerLabel = document.createElement('span')
  pickerLabel.className = 'machine-picker-label'
  const pickerCaret = document.createElement('span')
  pickerCaret.className = 'machine-picker-caret'
  pickerCaret.setAttribute('aria-hidden', 'true')
  pickerCaret.textContent = '▾'
  picker.append(pickerLabel, pickerCaret)
  // `detail` is 0 for a click SYNTHESISED by the keyboard (Enter/Space on a
  // focused button) and >= 1 for a real pointer press — the standard way to
  // tell the two apart without adding a keydown handler that would then have
  // to re-implement button activation. A keyboard user lands in the search
  // field (typeahead parity with the <select> this replaced); a tapping user
  // lands on the ✕, because an autofocused input would raise the on-screen
  // keyboard over the grid they came to look at.
  picker.addEventListener('click', (ev) => onBrowseMachines(picker, ev.detail === 0 ? 'search' : 'close'))
  // Warm the chunk while the visitor is reading the goals list, so the first
  // tap opens instantly rather than after a round trip on arcade Wi-Fi.
  // requestIdleCallback where it exists (not Safari as of this writing), a
  // short timeout otherwise — either way after first paint, never competing
  // with it. Silent on failure by design: see prefetchChunk's own note.
  const warmLibrary = (): void => prefetchChunk(() => import('./ui/library'))
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warmLibrary, { timeout: 3000 })
  else setTimeout(warmLibrary, 1500)

  const helpBtn = document.createElement('button')
  helpBtn.type = 'button'
  helpBtn.className = 'help-btn'
  helpBtn.setAttribute('aria-label', 'How to use Pinball Genie')
  helpBtn.innerHTML = '<span class="help-btn-mark" aria-hidden="true">?</span><span class="help-btn-text">Help</span>'
  helpBtn.addEventListener('click', () => openHowTo())

  // Glossary sits right next to Help (design constraint: same surface as
  // How-To). Dynamic-imported on tap — unlike Help, the glossary isn't the
  // user's only setup instructions, so this stays lazy (ui/glossary.ts's own
  // header comment / CONTRACTS.md's "keep the core app light" ethos), same
  // pattern ar/arview.ts already uses for its own "How to use" button.
  const glossaryBtn = document.createElement('button')
  glossaryBtn.type = 'button'
  glossaryBtn.className = 'help-btn glossary-btn'
  glossaryBtn.setAttribute('aria-label', 'Glossary of pinball terms')
  glossaryBtn.innerHTML = '<span class="help-btn-text">Glossary</span>'
  glossaryBtn.addEventListener('click', () => {
    loadChunk(() => import('./ui/glossary'), 'the glossary', ({ openGlossary }) => openGlossary())
  })

  top.append(picker, helpBtn, glossaryBtn)

  header.append(top)

  function syncPicker(s: AppState): void {
    // The button shows the machine that IS loaded, never the one being loaded:
    // a switch that fails leaves state.machine untouched (state.ts P6 L1), and
    // the header must not claim a machine the app is not showing.
    const machine = s.machine
    const fullName = machine?.name ?? 'Pick a machine'
    // VISIBLE TEXT IS THE SHORT TITLE, not the full "Title (Manufacturer,
    // Year)". The header has one job — say which machine you are on — and the
    // maker and year were spending most of the width to lose the name to an
    // ellipsis: "Jaws (Stern Pinball, 2024)" truncated at "Jaws (Stern …" on a
    // 390px phone. The Library overlay carries maker and year on every row and
    // in its NOW STUDYING strip, so nothing is lost by leaving them there.
    //
    // The catalog's `shortTitle` is an EDITORIAL field, not a substring: 18 of
    // the 134 are hand-written abbreviations that no algorithm would produce
    // ("D&D", "TMNT", "007", "SW: EMPIRE", "BRIDE OF PINBOT"), which is exactly
    // what a cramped header wants. It is typed as required, so the `||` is a
    // guard against an empty string rather than an absent field — a machine
    // registered with `shortTitle: ""` would otherwise render a blank header.
    const shown = machine ? machine.shortTitle.trim() || machine.name : fullName
    if (pickerLabel.textContent !== shown) pickerLabel.textContent = shown
    // ACCESSIBLE NAME KEEPS THE FULL CONTEXT (the P6 contract) — and now it is
    // the only place carrying it, so it matters more than before: the visible
    // text is an abbreviation, and a screen-reader user should still hear which
    // Star Wars, from which maker, in which year. Naming the action as well is
    // the difference between a label and an affordance; `aria-haspopup="dialog"`
    // above then says it opens rather than navigates.
    picker.setAttribute('aria-label', `${fullName} — change machine, opens the machine library`)
    // The one-time pulse (P6 L5). A CLASS, not an inline style, so the
    // reduced-motion branch lives in CSS next to the animation it replaces —
    // and so removing it is one line rather than unwinding a style property.
    if (libraryHintSeen()) picker.classList.remove('machine-picker-hint')
    else picker.classList.add('machine-picker-hint')
  }
  syncPicker(state)

  return {
    el: header,
    update: syncPicker,
  }
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

/** Achievements tab icon is a plain checkmark glyph (U+2713, default text
 *  presentation — same family as the goal-row checkmark / map sheet checks
 *  elsewhere in this app), NOT an emoji, per the de-trademarking brief's "no
 *  trophy/gamerscore icon clones, no emoji anywhere": Goals' 🎯 is a
 *  pictographic emoji from before that rule existed, left as-is (out of
 *  scope to change), but new/changed tabs don't add another. Card
 *  (2026-08-10, since retired as a mobile tab — see the TabId union's own
 *  header note) established '▤' (U+25A4 SQUARE WITH HORIZONTAL FILL) for
 *  this rule. Wave 2 (2026-08-11) touches the other two: Shots (was "Map")
 *  drops its 🗺️ emoji for '◎' (U+25CE BULLSEYE — a literal target, default
 *  text presentation) now that this tab is being renamed anyway; Study
 *  reuses Card's now-freed '▤' rather than inventing a fourth glyph. */
function buildTabBar(onSelect: (tab: TabId) => void): { el: HTMLElement; select: (tab: TabId) => void } {
  const nav = document.createElement('nav')
  nav.className = 'tab-bar'
  nav.setAttribute('role', 'tablist')

  // 2026-07-29 (AR removal): the 'ar' tab is gone — see this file's header
  // comment. 2026-08-11 (wave 2): Goals · Shots · Study · Achievements is
  // the complete tab set now — Map is relabeled Shots (TabId 'map'
  // unchanged), the mobile Card tab is retired, Study is new. See this
  // file's header note (near the TabId union) for the full rationale.
  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'goals', label: 'Goals', icon: '\u{1F3AF}' }, // 🎯
    { id: 'map', label: 'Shots', icon: '◎' }, // ◎
    { id: 'study', label: 'Study', icon: '▤' }, // ▤
    { id: 'achievements', label: 'Achievements', icon: '✓' }, // ✓
  ]

  let active: TabId = 'goals'
  const buttons: HTMLButtonElement[] = []

  /** Drives a tab switch through the exact same path a tap on that tab's
   *  button does (aria-selected bookkeeping + onSelect) — exposed as
   *  `select()` below so code outside this closure (app.ts's
   *  showGoalOnMap()) can jump tabs programmatically without re-deriving
   *  this bookkeeping a second time.
   *
   *  ROVING TABINDEX (P4, 2026-08-14) is maintained here and nowhere else,
   *  precisely because every path into a tab change already funnels through
   *  this one function. A tablist is ONE tab stop: Tab enters it at the
   *  selected tab (tabindex 0) and Tab again leaves it — the arrows below,
   *  not Tab, move between tabs. Four buttons all at tabindex 0 (what this
   *  shipped as until now) makes a keyboard user press Tab four times to get
   *  past a bar they may not have wanted to enter at all. */
  function activate(tab: TabId): void {
    active = tab
    buttons.forEach((b, i) => {
      const isActive = tabs[i]?.id === active
      b.setAttribute('aria-selected', String(isActive))
      b.tabIndex = isActive ? 0 : -1
    })
    onSelect(active)
  }

  /** ArrowLeft/ArrowRight/Home/End — the WAI-ARIA tablist keyboard contract,
   *  with WRAP at both ends (this bar is a ring of four peers; a dead end at
   *  Goals/Achievements would be arbitrary). Automatic activation: moving
   *  focus also selects, which is correct for tabs this cheap to switch
   *  between and is what the pointer already does.
   *
   *  Achievements is not special-cased even though selecting it while signed
   *  out opens the sign-up gate: an arrow key must do exactly what a tap
   *  does, and app.ts's dismiss path already puts the visitor back on the
   *  tab they came from. */
  function onKeydown(ev: KeyboardEvent, index: number): void {
    let next: number
    switch (ev.key) {
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length
        break
      case 'ArrowRight':
        next = (index + 1) % tabs.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tabs.length - 1
        break
      default:
        return
    }
    ev.preventDefault()
    const target = tabs[next]
    if (!target) return
    buttons[next]?.focus?.()
    activate(target.id)
  }

  tabs.forEach((t, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tab-btn'
    btn.id = tabButtonId(t.id)
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-selected', String(t.id === active))
    btn.setAttribute('aria-controls', PANEL_ID[t.id])
    btn.tabIndex = t.id === active ? 0 : -1

    const icon = document.createElement('span')
    icon.className = 'tab-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = t.icon

    const label = document.createElement('span')
    label.textContent = t.label

    btn.append(icon, label)
    btn.addEventListener('click', () => activate(t.id))
    btn.addEventListener('keydown', (ev) => onKeydown(ev, i))

    buttons.push(btn)
    nav.appendChild(btn)
  })

  return { el: nav, select: activate }
}

// ---------------------------------------------------------------------------
// Goals tab
// ---------------------------------------------------------------------------

/** `showOnMap`/`onComplete`/`justCompletedGoalId` are P7a's bridge, threaded
 *  from mountApp (whose closure owns the tab bar and the transient cue) down
 *  to the two renderers that need them — internal signatures only, nothing
 *  outside this file calls any of these. */
function renderGoalsPanel(
  panel: HTMLElement,
  state: AppState,
  onBrowseMachines: BrowseMachines,
  showOnMap: () => void,
  onComplete: (goal: Goal) => void,
  justCompletedGoalId: string | null,
): void {
  panel.innerHTML = ''

  // A MACHINE SWITCH IN FLIGHT (P6 L3) — skeleton rows, not the old machine's
  // goals and not a bare "Loading…". The list underneath is about to be
  // replaced wholesale, so leaving it up would let someone start reading a
  // goal that is seconds from disappearing; a one-line message throws away the
  // shape of the page and makes the swap feel like a navigation. The skeleton
  // holds the layout still and says "same screen, new machine".
  if (state.machineLoading) {
    panel.appendChild(renderGoalsSkeleton())
    return
  }

  if (!state.data) {
    const msg = document.createElement('div')
    msg.className = 'state-message'
    msg.textContent = 'Loading…'
    panel.appendChild(msg)
    return
  }

  if (state.selectedGoal) {
    panel.appendChild(renderGoalDetail(state, state.selectedGoal, showOnMap, onComplete))
    return
  }

  panel.appendChild(renderGoalList(state, onBrowseMachines, justCompletedGoalId))
}

/** Placeholder rows shaped like the goal list they stand in for — a group
 *  header, then rows with a category bar, a title bar and a meta bar.
 *
 *  aria-hidden with a sibling live region rather than the bars themselves
 *  being announced: a screen reader reading out six empty boxes is noise, and
 *  "Loading <machine>" is the whole message. The shimmer is CSS and is removed
 *  under prefers-reduced-motion (styles.css) — the bars stay, so the state is
 *  still legible without the motion. */
function renderGoalsSkeleton(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'goal-groups'

  const live = document.createElement('div')
  live.className = 'sr-only'
  live.setAttribute('role', 'status')
  live.textContent = 'Loading machine'
  wrap.appendChild(live)

  const group = document.createElement('div')
  group.className = 'goal-skeleton'
  group.setAttribute('aria-hidden', 'true')
  const head = document.createElement('div')
  head.className = 'goal-skeleton-head skeleton-bar'
  group.appendChild(head)
  for (let i = 0; i < 6; i += 1) {
    const row = document.createElement('div')
    row.className = 'goal-skeleton-row'
    const bar = document.createElement('span')
    bar.className = 'goal-skeleton-cat'
    const bodyCol = document.createElement('span')
    bodyCol.className = 'goal-skeleton-body'
    const t = document.createElement('span')
    t.className = 'goal-skeleton-title skeleton-bar'
    const m = document.createElement('span')
    m.className = 'goal-skeleton-meta skeleton-bar'
    bodyCol.append(t, m)
    row.append(bar, bodyCol)
    group.appendChild(row)
  }
  wrap.appendChild(group)
  return wrap
}

/** The inline "that machine didn't load" card with a Retry, shown at the top
 *  of the goal list. The list BELOW it is still the machine that IS loaded and
 *  is still completely usable — state.ts leaves it untouched on a failed
 *  switch, so this is an interruption, not an error screen. */
function renderMachineErrorCard(state: AppState): HTMLElement | null {
  const err = state.machineError
  if (!err) return null
  const failed = state.machines.find((m) => m.id === err.machineId)
  const box = document.createElement('div')
  box.className = 'machine-error'
  box.setAttribute('role', 'alert')

  const text = document.createElement('span')
  text.className = 'machine-error-text'
  text.textContent = `Couldn't load ${failed?.name ?? 'that machine'}. You're still on ${state.machine?.name ?? 'the last one'}.`
  box.appendChild(text)

  if (failed) {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'machine-error-retry'
    retry.textContent = 'Retry'
    retry.addEventListener('click', () => {
      void state.selectMachine(failed)
    })
    box.appendChild(retry)
  }
  return box
}

/** Always-visible "How to use" banner at the top of the Goals list — the
 *  first screen after login. The header "Help" button is easy to miss on a
 *  phone; this makes the instructions impossible to miss. */
function renderHowToBanner(): HTMLElement {
  const banner = document.createElement('button')
  banner.type = 'button'
  banner.className = 'howto-banner'
  banner.innerHTML =
    '<span class="howto-banner-icon" aria-hidden="true">?</span>' +
    '<span class="howto-banner-body">' +
    '<span class="howto-banner-title">New here? How to use Pinball Genie</span>' +
    '<span class="howto-banner-sub">Step-by-step setup for studying shots on the map</span>' +
    '</span>' +
    '<span class="howto-banner-arrow" aria-hidden="true">›</span>'
  banner.addEventListener('click', () => openHowTo())
  return banner
}

/** The one-line first-run nudge toward the Machine Library (P6 L5).
 *
 *  Two controls, not one: the row itself opens the library, and a separate ✕
 *  dismisses it without opening anything. A banner that can only be dismissed
 *  by doing the thing it suggests is a banner you cannot decline. The ✕ is a
 *  SIBLING of the row rather than a nested button, for the same
 *  button-inside-a-button reason the library's pin star is.
 *
 *  Count-free by construction: "every machine we cover", never a number that
 *  goes stale the next time the catalog grows. */
function renderLibraryHint(onBrowseMachines: BrowseMachines): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'library-hint'

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'library-hint-open'
  const text = document.createElement('span')
  text.className = 'library-hint-text'
  text.textContent = 'Playing a different table? Browse every machine we cover'
  const arrow = document.createElement('span')
  arrow.className = 'library-hint-arrow'
  arrow.setAttribute('aria-hidden', 'true')
  arrow.textContent = '›'
  open.append(text, arrow)
  open.addEventListener('click', () => onBrowseMachines(open))

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'library-hint-dismiss'
  dismiss.setAttribute('aria-label', 'Dismiss')
  dismiss.textContent = '✕'
  dismiss.addEventListener('click', () => {
    markLibraryHintSeen()
    // Remove just this row rather than re-rendering the whole list: a full
    // re-render would rebuild every goal row and throw away the scroll
    // position for a banner going away.
    wrap.remove()
    document.querySelector('.machine-picker-hint')?.classList.remove('machine-picker-hint')
  })

  wrap.append(open, dismiss)
  return wrap
}

/** Design turn t8's plain list: the how-to banner, then every goal on the
 *  machine grouped by category in CATEGORY_ORDER — no ball-position
 *  filtering or readiness grouping (t14's three-way "Start now/Needs
 *  setup/Plunger-only" split is retired; see this file's 2026-07-13 header
 *  note — ballPosition is a fixed 'any' now, so there's nothing left to
 *  group by). */
function renderGoalList(
  state: AppState,
  onBrowseMachines: BrowseMachines,
  justCompletedGoalId: string | null,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'goal-groups'

  // Above the how-to banner: a failed machine switch is the most recent thing
  // that happened and the only thing on this screen the visitor can act on.
  const machineError = renderMachineErrorCard(state)
  if (machineError) wrap.appendChild(machineError)

  wrap.appendChild(renderHowToBanner())
  // UNDER the how-to banner, never above it: the guide is what a first-time
  // visitor needs first, and this is a nudge, not an instruction.
  if (!libraryHintSeen()) wrap.appendChild(renderLibraryHint(onBrowseMachines))

  const allGoals = state.data?.goals ?? []

  if (allGoals.length === 0) {
    const msg = document.createElement('div')
    msg.className = 'state-message'
    msg.textContent = 'No goals loaded for this machine yet.'
    wrap.appendChild(msg)
  } else {
    appendCategoryGroups(wrap, state, allGoals, justCompletedGoalId)
  }

  // Footer at the end of the Goals tab's scrollable content (not a fixed
  // bar — see ui/footer.ts's header comment) — appended unconditionally,
  // including the empty-catalog branch above, so it's never missing.
  wrap.appendChild(renderFooter())

  return wrap
}

/** Category-grouped rows in the fixed CATEGORY_ORDER (skillshot → combo →
 *  multiball → mode → multiplier → wizard → strategy), empty categories
 *  filtered out, each with a "Label · N" section header. */
function appendCategoryGroups(
  container: HTMLElement,
  state: AppState,
  goals: Goal[],
  justCompletedGoalId: string | null,
): void {
  const byCategory = new Map<GoalCategory, Goal[]>()
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, [])
  for (const g of goals) {
    byCategory.get(g.category)?.push(g)
  }

  for (const cat of CATEGORY_ORDER) {
    const catGoals = byCategory.get(cat)
    if (!catGoals || catGoals.length === 0) continue
    const meta = CATEGORY_META[cat]

    const group = document.createElement('div')
    group.className = 'goal-group'

    const groupHeader = document.createElement('div')
    groupHeader.className = 'goal-group-header'
    const dot = document.createElement('span')
    dot.className = 'goal-group-dot'
    dot.style.background = meta.color
    const title = document.createElement('span')
    title.className = 'goal-group-title'
    title.textContent = `${meta.label} · ${catGoals.length}`
    groupHeader.append(dot, title)
    group.appendChild(groupHeader)

    for (const g of catGoals) {
      group.appendChild(renderGoalRow(state, g, meta.color, g.id === justCompletedGoalId))
    }

    container.appendChild(group)
  }
}

/** Row spec unified with the AR goal sheet's (ar/arview.ts buildGoalRow):
 *  3px category bar, title, "N steps · reward" meta, filled+empty pips
 *  (pipsTextWithEmpty), amber ✓ + tint on the selected goal — design turn
 *  t8's "rows use the AR sheet spec" applied to the Goals tab too. */
function renderGoalRow(state: AppState, goal: Goal, color: string, justCompleted: boolean): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'goal-row'
  btn.addEventListener('click', () => state.select(goal))

  const bar = document.createElement('span')
  bar.className = 'goal-row-cat-bar'
  bar.style.background = color
  bar.setAttribute('aria-hidden', 'true')

  const body = document.createElement('span')
  body.className = 'goal-row-body'

  const title = document.createElement('span')
  title.className = 'goal-row-title'
  // NO LEADING fx GLYPH (BACKGLASS, P5 2026-08-14). This was
  // `${glyphFor(goal.fx ?? defaultFx)}  ${title}` (correction 11), the same
  // motif the completion FX uses. In the reskin render it was the weakest
  // element on the screen: a machine's goals nearly all share one `fx`, so
  // the list drew five identical 💀 down the left margin — a repeated bullet
  // carrying no information, in the one colour space that cannot join a
  // one-accent palette. The category BAR (and, on a selected row, its glow)
  // carries identity per row instead. The glyph survives where it is
  // one-per-screen and meaningful: the map celebration burst. Same change,
  // same reasoning, in overlay/map2d.ts's buildGoalRow.
  // See design3/BACKGLASS-NOTES.md §9.
  title.textContent = goal.title

  // Pathless goals (secret/progression) have no route, so "0 steps" would be
  // both wrong and slightly alarming. Count the prose lines instead and name
  // them as what they are. See Goal.instructions in models.ts.
  const stepCount = goal.steps.length
  const metaParts = [
    isPathless(goal)
      ? `${instructionsFor(goal).length} step${instructionsFor(goal).length === 1 ? '' : 's'} · no map route`
      : `${stepCount} step${stepCount === 1 ? '' : 's'}`,
  ]
  if (goal.reward) metaParts.push(goal.reward)
  const metaLine = document.createElement('span')
  metaLine.className = 'goal-row-meta-line'
  metaLine.textContent = metaParts.join(' · ')

  body.append(title, metaLine)

  const pips = document.createElement('span')
  pips.className = 'pips'
  pips.textContent = pipsTextWithEmpty(goal.difficulty)
  pips.setAttribute('aria-label', `difficulty ${clampDifficulty(goal.difficulty)} of 3`)
  // BACKGLASS: pips take the goal's own category colour, per instance — the
  // same convention the category bar above already uses (styles.css's .pips
  // rule keeps var(--text-faint) for every OTHER place pips appear).
  pips.style.color = color

  const check = document.createElement('span')
  check.className = 'goal-row-check'
  // THE ONE LIT ROW (BACKGLASS §5): the selected goal — the same state that
  // puts the ✓ here — is the goals list's only glowing element besides the
  // active tab. `--catglow` is this goal's category colour at 55%, which the
  // .goal-row-sel .goal-row-cat-bar rule spends on a three-stop box-shadow;
  // a box-shadow cannot read a colour out of the element it decorates, so it
  // has to arrive as a custom property.
  const isSelected = state.selectedGoal?.id === goal.id
  check.textContent = isSelected ? '✓' : ''
  if (isSelected) {
    btn.classList.add('goal-row-sel')
    // PRESENTATION ONLY — never getComputedStyle this back for logic. It is a
    // colour the browser resolves at paint time (color-mix over a var()), so
    // reading it back gives a browser-dependent string, and no code should
    // depend on one. The goal's category is the fact; this is a paint of it.
    btn.style.setProperty('--catglow', `color-mix(in srgb, ${color} 55%, transparent)`)
  }

  // JUST FINISHED (P7a) — the positional half of the completion feedback, for
  // ONE render only (mountApp's `justCompletedGoalId`, cleared by renderAll).
  // The toast says WHAT you finished; this says WHERE you are, which a toast
  // above the tab bar cannot: the list you land back on is long, grouped, and
  // scrolled to wherever it was when you left it.
  //
  // Never both at once — completing a goal clears the selection, so a row can
  // be `sel` or `done`, not the two together.
  if (justCompleted) {
    btn.classList.add('goal-row-done')
    check.textContent = '✓'
    // AFTER this render, not during it: the row is still detached here (its
    // group has not been appended to the panel yet), and scrolling a detached
    // element does nothing at all.
    //
    // requestAnimationFrame, not queueMicrotask (K3 review, 2026-08-14). Both
    // land after the list is in the document, but a microtask runs BEFORE the
    // browser has laid anything out, so scrollIntoView there forces a
    // synchronous layout in the middle of the render task to answer "where is
    // this row?". rAF is the after-render hook: layout is settled and the
    // scroll costs nothing extra. Harmlessly a no-op if a later render
    // replaced this row in the meantime; nothing to cancel either way.
    //
    // WHAT IT SCROLLS: #main-content, the app's only scrollport
    // (styles.css:725 `flex:1; min-height:0; overflow-y:auto`). The document
    // itself cannot scroll — `body` is `position:fixed; overflow:hidden` (the
    // iOS collapsing-toolbar hardening) — so there is no page scroll for this
    // to fight with.
    //
    // Optional-call on both: the suites drive this module against hand-rolled
    // fake elements (ui/sheet.ts's focusableWithin makes the same allowance).
    requestAnimationFrame?.(() => btn.scrollIntoView?.({ block: 'center' }))
  }

  // PREM/LE chip (phase A3, 2026-08-10) — informational only; the Goals tab
  // never hides a goal for trim reasons (map2d.ts's goal sheet does that
  // instead — buildGoalSheetBody's goalVisibleForTrim filter). Flags goals
  // that reference any premium-le shot, and intensifies to a "not on Pro"
  // treatment when the current MODEL selector actually is 'pro', since this
  // goal's drawn route needs a shot that model doesn't have.
  // ui/goalMeta.ts's goalReferencesPremiumLe is the single derivation both
  // this chip and the Map's hide-filter are honest about (does any step's
  // shot resolve to a premium-le-trimmed shot).
  let chip: HTMLElement | null = null
  if (goalReferencesPremiumLe(goal, state.shotsByID)) {
    chip = document.createElement('span')
    chip.className = 'goal-row-chip'
    chip.textContent = 'PREM/LE'
    if (state.trim === 'pro') {
      chip.classList.add('not-on-trim')
      chip.title = 'Not on Pro'
      chip.setAttribute('aria-label', 'Premium/LE content — not on Pro')
      btn.classList.add('goal-row-dimmed')
    }
  }

  btn.append(bar, body, ...(chip ? [chip] : []), pips, check)

  return btn
}

function renderGoalDetail(
  state: AppState,
  goal: Goal,
  showOnMap: () => void,
  onComplete: (goal: Goal) => void,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'goal-detail'
  const meta = CATEGORY_META[goal.category]

  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'goal-detail-back'
  const arrow = document.createElement('span')
  arrow.setAttribute('aria-hidden', 'true')
  arrow.textContent = '‹'
  const backLabel = document.createElement('span')
  backLabel.textContent = 'Goals'
  back.append(arrow, backLabel)
  back.addEventListener('click', () => state.clearSelection())
  wrap.appendChild(back)

  const headerEl = document.createElement('div')
  headerEl.className = 'goal-detail-header'

  const catLine = document.createElement('div')
  catLine.className = 'goal-detail-cat'
  catLine.style.color = meta.color
  catLine.textContent = meta.label

  const title = document.createElement('h2')
  title.className = 'goal-detail-title'
  title.textContent = goal.title

  const pipsRow = document.createElement('div')
  pipsRow.className = 'goal-detail-pips-row'
  const pips = document.createElement('span')
  pips.className = 'pips'
  pips.textContent = pipsText(goal.difficulty)
  const stepsCount = document.createElement('span')
  // Same reasoning as the goal-row meta line above.
  const detailCount = isPathless(goal) ? instructionsFor(goal).length : goal.steps.length
  stepsCount.textContent = `${detailCount} step${detailCount === 1 ? '' : 's'}`
  pipsRow.append(pips, stepsCount)

  const summary = document.createElement('p')
  summary.className = 'goal-detail-summary'
  summary.textContent = goal.summary

  headerEl.append(catLine, title, pipsRow, summary)
  wrap.appendChild(headerEl)

  if (goal.reward) {
    const reward = document.createElement('div')
    reward.className = 'goal-detail-reward'
    reward.textContent = `Reward: ${goal.reward}`
    wrap.appendChild(reward)
  }

  // THE CHAIN LINE (dataset schema v8, 2026-08-15 — Goal.requires /
  // Goal.requiresNote in models.ts). A gated goal used to say so only in its
  // own summary prose, and only when whoever wrote that summary happened to
  // mention it: Jaws' Level 1 card said collecting it opens Level 2, while
  // Levels 2 and 3 — the cards a player actually opens to ask "why isn't this
  // lit" — said nothing at all. This line states the dependency on the goal
  // that HAS it, which is the only card where it answers a question.
  //
  // Above the steps and below the reward on purpose: it is a precondition, so
  // it belongs before the route rather than as a footnote after it, and it is
  // rendered before the pathless early-return below so a 'secret' or
  // 'progression' goal gets one too.
  if (hasDependency(goal)) {
    const chain = document.createElement('div')
    chain.className = 'goal-detail-requires'
    const unlocks = unlocksAfterText(goal, state.data)
    if (unlocks) {
      const line = document.createElement('span')
      line.className = 'goal-detail-requires-line'
      line.textContent = unlocks
      chain.appendChild(line)
    }
    // The note stands alone when nothing resolves — models.ts's own contract
    // for a prerequisite that is a threshold rather than another goal.
    if (goal.requiresNote?.trim()) {
      const note = document.createElement('span')
      note.className = 'goal-detail-requires-note'
      note.textContent = goal.requiresNote.trim()
      chain.appendChild(note)
    }
    if (chain.childElementCount > 0) wrap.appendChild(chain)
  }

  // PATHLESS GOALS (2026-07-31) — 'secret' and 'progression' entries whose
  // instructions are prose, not shots ("hold both flippers in attract mode",
  // "cycle the right flipper to choose your class"). See Goal.instructions in
  // models.ts for why these cannot be expressed as `steps`.
  //
  // Everything below this block — the tappable step rows, the ‹ › walker, the
  // "STEP n OF m" readout, the ✓-completes-the-goal button — is built around
  // stepping through a route. With zero steps it would render an empty list,
  // "STEP 1 OF 0", and a ✓ button that is simultaneously first and last. So
  // this branch returns early with a plain ordered list and no walker at all,
  // rather than trying to make the walker degrade gracefully.
  if (isPathless(goal)) {
    const list = document.createElement('ol')
    list.className = 'goal-instructions'
    for (const line of instructionsFor(goal)) {
      const li = document.createElement('li')
      li.className = 'goal-instruction'
      li.textContent = line
      list.appendChild(li)
    }
    wrap.appendChild(list)
    const note = document.createElement('p')
    note.className = 'goal-instructions-note'
    // Says it plainly so the absence of a Map path reads as intentional. A
    // user who selected this from the Goals tab and then tapped Map would
    // otherwise find the goal simply missing from the picker with no reason.
    note.textContent = 'No playfield route — this one happens at the buttons, not on the map.'
    wrap.appendChild(note)
    return wrap
  }

  const stepsWrap = document.createElement('div')
  stepsWrap.className = 'goal-steps'
  goal.steps.forEach((step, i) => {
    const el = document.createElement('div')
    el.className = 'goal-step' + (i === state.stepIndex ? ' current' : '')
    // Tappable: jump straight to any step instead of only via ‹ › (field
    // feedback — "I'm clicking steps 2 and 3 but nothing happens"). A plain
    // div carries no native button semantics, so role="button" + tabindex +
    // an Enter/Space keydown handler stand in for it (same pattern as the
    // howto-banner button elsewhere in this file, just not a real <button>
    // since goal-step's internal layout/CSS predates this and a <button>
    // would need `all: unset`-style resets to match).
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-label', `Go to step ${i + 1} of ${goal.steps.length}`)
    el.addEventListener('click', () => {
      state.goToStep(i)
      state.pauseHighlight()
    })
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault()
        state.goToStep(i)
        state.pauseHighlight()
      }
    })

    const idx = document.createElement('span')
    idx.className = 'goal-step-index'
    idx.textContent = String(i + 1)

    const body = document.createElement('span')
    body.className = 'goal-step-body'

    const shot = state.shotsByID.get(step.shot)
    if (shot) {
      const shotLabel = document.createElement('span')
      shotLabel.className = 'goal-step-shot'
      shotLabel.textContent = shot.name
      // BACKGLASS: the step's shot name takes the goal's category colour
      // (concept `.step .shot`), per instance like the row bar and pips.
      // If goal detail ever reads shouty, THIS is the first thing to revert
      // to var(--text-dim) — see BACKGLASS-NOTES.md §9 and the CSS rule.
      shotLabel.style.color = meta.color
      body.appendChild(shotLabel)
    }

    // CHOREOGRAPHY PROVENANCE (phase B1, 2026-08-10) — "FROM RIGHT FLIPPER ·
    // LEFT-RAMP RETURN", teaching where the ball comes FROM. See
    // ui/goalMeta.ts's stepProvenance for the full derivation rule; null (no
    // previous step, no authored flipper, no resolvable feed) renders
    // nothing rather than guessing.
    const provenanceText = stepProvenance(goal, i, state.shotsByID, state.trim)
    if (provenanceText) {
      const provenance = document.createElement('span')
      provenance.className = 'goal-step-provenance'
      provenance.textContent = provenanceText
      body.appendChild(provenance)
    }

    const action = document.createElement('span')
    action.className = 'goal-step-action'
    action.textContent = step.action
    body.appendChild(action)

    if (step.detail) {
      const detail = document.createElement('span')
      detail.className = 'goal-step-detail'
      detail.textContent = step.detail
      body.appendChild(detail)
    }

    // TECHNIQUE CHIPS (phase B2, 2026-08-10) — step.technique[] verbatim plus
    // a derived SOFT/FULL PLUNGE chip (ui/goalMeta.ts's stepChips, the single
    // place both this tab and the Map pill derive chips from). Each chip's
    // border is tinted with this goal's own category color (`meta.color`,
    // set above from CATEGORY_META) via the same JS `.style.` assignment
    // convention map2d.ts/this file already use for per-instance category
    // dots/bars (CSP: style-src 'self', no runtime <style> tags — see
    // map2d.css's header note).
    const chips = stepChips(step)
    if (chips.length > 0) {
      const chipsRow = document.createElement('span')
      chipsRow.className = 'goal-step-chips'
      for (const chip of chips) {
        const chipBtn = document.createElement('button')
        chipBtn.type = 'button'
        chipBtn.className = 'goal-step-chip'
        chipBtn.style.borderColor = `color-mix(in srgb, ${meta.color} 45%, transparent)`
        chipBtn.textContent = chip.label
        chipBtn.addEventListener('click', (ev) => {
          // Stop this from also bubbling to `el`'s own click handler below
          // (state.goToStep) — a chip tap should only open the glossary.
          ev.stopPropagation()
          // P7a (2026-08-14): the chip's own vocabulary term is passed through
          // — openGlossary(term) scrolls that entry into view and marks it,
          // instead of opening a 70-term list at the top and leaving the
          // visitor to find the word they just tapped. `term` is null for the
          // DERIVED plunge chips (goalMeta.ts's stepChips: plunge strength is
          // not in the technique vocabulary), and a term with no glossary
          // entry misses the same way — both open at the top, which is
          // exactly the behaviour this call had before.
          loadChunk(() => import('./ui/glossary'), 'the glossary', ({ openGlossary }) =>
            openGlossary(chip.term ?? undefined),
          )
        })
        chipsRow.appendChild(chipBtn)
      }
      body.appendChild(chipsRow)
    }

    el.append(idx, body)
    stepsWrap.appendChild(el)
  })
  wrap.appendChild(stepsWrap)

  const controls = document.createElement('div')
  controls.className = 'step-controls'

  // SHOW ON MAP (P7a) — leftmost in the sticky bar, before the ‹ › walker,
  // because it leaves this screen rather than moving within it. Same 44px
  // .step-btn recipe as its neighbours (one glass button family in this bar,
  // not two); .step-btn-map exists so the suites and any future styling have
  // a handle on it.
  //
  // ONLY PATHFUL GOALS HAVE ONE: the isPathless() branch above returns before
  // this bar is built, so a goal with no route can never offer to show you
  // one. See mountApp's showSelectedGoalOnMap for why this does not re-select
  // the goal (it would reset stepIndex and lose the step you are on).
  //
  // The glyph is the SHOTS TAB'S OWN — '◎' (U+25CE), buildTabBar's icon for
  // the tab this button jumps to. Pointing at a destination with the mark
  // already on that destination is the cheapest possible affordance, and it
  // adds no new emoji (this file's standing rule).
  const mapBtn = document.createElement('button')
  mapBtn.type = 'button'
  mapBtn.className = 'step-btn step-btn-map'
  mapBtn.textContent = '◎'
  mapBtn.setAttribute('aria-label', 'Show this goal on the Shots map')
  mapBtn.addEventListener('click', () => showOnMap())

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.className = 'step-btn'
  prevBtn.textContent = '‹'
  prevBtn.setAttribute('aria-label', 'Previous step')
  prevBtn.disabled = state.stepIndex === 0
  prevBtn.addEventListener('click', () => {
    state.prevStep()
    state.pauseHighlight()
  })

  const progress = document.createElement('span')
  progress.className = 'step-progress'
  progress.textContent = `STEP ${state.stepIndex + 1} OF ${goal.steps.length}`

  const onLast = state.stepIndex >= goal.steps.length - 1
  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.className = 'step-btn' + (onLast ? ' done' : '')
  nextBtn.textContent = onLast ? '✓' : '›'
  nextBtn.setAttribute('aria-label', onLast ? 'Finish goal' : 'Next step')
  nextBtn.addEventListener('click', () => {
    // Mirrors GoalBrowser.kt: pressing "next" on the last step doesn't
    // advance past the end — it completes the goal.
    //
    // P7a (2026-08-14): completing now goes through mountApp's completeGoal —
    // a 2.4s status pill and a one-render mark on the row you land back on,
    // THEN the same state.clearSelection() this always did. The full-screen
    // celebration stays removed (README "State" / shotcoach-corrections.md
    // #11); see this file's header for the supersession note on "no toast".
    if (onLast) {
      onComplete(goal)
    } else {
      state.nextStep()
      state.pauseHighlight()
    }
  })

  controls.append(mapBtn, prevBtn, progress, nextBtn)
  wrap.appendChild(controls)

  return wrap
}
