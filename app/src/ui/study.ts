// ui/study.ts — the Study tab (wave 2, owner-specced, 2026-08-11): "a step
// thru of everything on the playfield." Replaces the mobile Card tab in the
// bottom tab bar (Goals · Shots · Study · Achievements — see app.ts's own
// header note on the rename/replacement). Mounted lazily, exactly like Map/
// Achievements (app.ts's loadChunk call site) — first-visit-only, never
// destroyed/re-mounted afterward, own state.onChange subscription.
//
// WHAT THIS IS NOT: there is no goal, no route, no plunge gauge, no
// celebration burst. This tab has one job — walk every shot on the machine,
// one at a time, and let the player learn what each one is. The "goal" the
// rest of the app is built around simply doesn't exist here.
//
// REUSE CONTRACT (owner spec: "reuse map2d's exported drawPlayfieldArt +
// drawShotDots + playfieldRect/mapping in a tour configuration — export a
// minimal helper from map2d.ts if needed rather than duplicating"). This
// file imports FOUR things from overlay/map2d.ts:
//   - drawPlayfieldArt   — the per-machine background furniture (flippers,
//     ramps/orbits lane lines, bumpers, slings, deck plates). Unmodified.
//   - drawShotDots       — the dot layer. Passing a routeShotIDs set
//     containing only the CURRENT tour shot's id gets two things for free:
//     the dot renders brighter (its existing "on route" treatment), and —
//     because that set is non-empty — drawShotDots' own declutter rule
//     (map2d.ts's t14 comment) suppresses every ambient/major-shot label.
//     That is exactly "ONLY the current target's NAME floats" for the price
//     of one Set. (drawShotDots' own onRoute label draw is dead code as of
//     this writing — declutter's `continue` fires before it can run for ANY
//     non-empty routeShotIDs, so this file draws the floating name itself
//     below — see drawCurrentLabel.)
//   - playfieldRect      — was private; exported this wave (map2d.ts's own
//     doc comment on the export) so this file's canvas fits/centers the
//     playfield exactly the way the Map tab's does, with no second copy of
//     that fit-and-center math.
//   - zoneScreenRect     — NEW export this wave, factored out of
//     drawPlayfieldArt's own zone-plate loop (same file, same commit) so
//     TAP-TO-INSPECT's zone-plate hit-test uses the identical rectangle
//     drawPlayfieldArt actually painted, not a second corner-flip
//     computation that could silently drift from it.
// The MapFn closure itself (`(u, v) => ({ x, y })`) is NOT imported — it is
// a one-line closure over a Rect, and this file's own header note on
// map2d.ts's `withAlpha`/`disc`/`ring` precedent already documents this
// codebase's rule: a trivial one-liner is cheaper to duplicate locally than
// to widen a module's export surface for. Card-background chrome (gradient
// + clip + border) is likewise a local, minimal reimplementation
// (drawStudyCardBackground below) rather than importing map2d.ts's own
// drawMapCardBackground — that function's remaining job beyond exactly
// these four pieces is painting a GOAL-CATEGORY-colored glow, a concept
// that doesn't exist here (no goal, ever) — reusing it would mean importing
// dead-weight parameters just to always pass null.
//
// ui/machinecard.ts is UNTOUCHED by this wave, per the owner spec — Card
// content survives ONLY in the wide-viewport column beside the Map tab's own
// canvas (overlay/map2d.ts's "card beside map" feature, already shipped).
// There is now no mobile/narrow-viewport surface for the Card content at
// all — see app.ts's header note and this phase's own report for that gap.
//
// TOUR ORDER (owner: "data order or top-to-bottom spatial — pick,
// document"): TOP-TO-BOTTOM SPATIAL. Sorted by descending `shot.y` (UV
// grows toward the BACK of the table; map() inverts v to canvas y, so high-y
// shots sit near the canvas TOP) — ties broken by ascending `shot.x` (left
// before right). Chosen over authoring/data order because a study tool's
// whole point is teaching the PHYSICAL table: walking back-to-front, left-
// to-right on ties, mirrors how a player's eye actually scans the machine,
// and is stable across every dataset regardless of how goals happened to be
// authored. Deck shots are NOT special-cased — PlayfieldZone's own doc
// comment in models.ts is explicit that a deck shot "keeps its true
// flattened (x, y)" in MAIN-playfield UV, so sorting the whole roster by
// that one field already interleaves deck shots into the walk at their real
// physical position — no separate merge step needed.
//
// SHUFFLE (auto-advance): the tour auto-advances one shot every
// HIGHLIGHT_HOLD_S (overlay/drawing.ts's existing 2.5s cadence, reused
// rather than inventing a second magic number the Map tab's own marching
// highlight already owns) and WRAPS at the ends (a carousel, matching
// map2d.ts's own documented choice for its skill-shot browse: "wraps...
// it's a browse carousel", not a linear walk with dead ends). This is
// SESSION-LOCAL closure state, never AppState — the exact same "local,
// never persisted" rule map2d.ts's own `mapLevel`/`settings` already
// establish for view state that has no business surviving a tab switch.
// A manual ‹ › press, a tap-to-inspect hit, or opening LEARN all pause it
// (mode -> 'manual'); the readout's own tap toggles it back, exactly
// mirroring the Map tab's auto/manual highlight language and button.
//
// THE TOUR STARTS PAUSED (2026-10-14, rolo's first-time-visitor walk). It used
// to start in 'auto', so arriving on this tab began shuffling through every
// shot on the machine before the visitor had read what the machine is even
// about — and since Study is now the LANDING tab with HOW IT PLAYS open over
// it (app.ts's landOnHowItPlays), that shuffle would have been the first thing
// anyone ever saw move. Mount and every machine switch now leave `mode` at
// 'manual', the readout says 'PAUSED · TAP FOR AUTO' (the wording that state
// already had), and the shuffle starts only when the visitor taps the readout;
// ‹ › step one shot without starting it, as they always have. Nothing about
// the shuffle itself changed — it is the same carousel, behind one tap.
// REDUCED MOTION is untouched by this and still keeps the feature: a reduced-
// motion visitor who taps the readout gets the same auto-advance (a discrete
// jump every HIGHLIGHT_HOLD_S, which is a content change, not an animation),
// with the lamp pulse and the sheet motion already pinned still elsewhere in
// this file.
//
// LEARN SHEET — BESPOKE, NOT ui/sheet.ts's createSheet. ONE requirement
// createSheet's shared chrome doesn't meet (it was three when this was
// written; the other two have since been closed IN the shared shell rather
// than worked around here):
//   1. STILL TRUE — "field stays visible above" wants a TRANSPARENT
//      tap-catcher behind the panel (the exposed playfield reads as still
//      fully live), not createSheet's dark modal scrim (sheet.css's
//      `var(--scrim)`). This is the whole reason this panel survives as its
//      own thing.
//   2. CLOSED 2026-08-14 (P2). "Reduced-motion: instant show/hide" — this
//      file's own `.study-learn-panel` rule carries that guard directly
//      (styles.css). When this was written createSheet's shared
//      `.pg-sheet-panel` played its slide-up unconditionally; sheet.css now
//      carries the same guard.
//   3. CLOSED 2026-08-14 (P4). Focus management (role=dialog, aria-modal,
//      aria-labelledby, Escape-to-dismiss, focus on open/return-focus on
//      close) — createSheet's shell had none of it, and this panel's
//      hand-rolled version below was the DONOR that P4 lifted into the
//      shared sheet, which also added Tab wrapping. Do not read the
//      toggleStudySheet/closeStudySheet pair below as evidence that the shared
//      sheet still lacks this; it does not.
//
// ONE SHEET, FIVE KINDS (P4 addendum 2026-08-14; P8 2026-08-14; ALT MODES
// 2026-08-14; LEARN absorbed ALL SHOTS 2026-08-15; CHARACTER 2026-08-15).
// LEARN, ACTION BUTTON, DRILLS, ALT MODES and CHARACTER are all the SAME panel
// showing different content — toggleStudySheet('learn' | 'action' | 'drills' |
// 'altmodes' | 'character') — not five sheets that close each other. The ones
// added after P4 are bodies, not shells: they inherit the transparent
// backdrop, the fixed height, the crossfade, the Escape/focus discipline and
// the press-the-showing-pill-to-close contract for free, and there is exactly
// one panel element and one Escape listener no matter how many kinds exist.
// buildSheetContent is the one table every kind is declared in, so a sixth
// cannot half-happen.
//
// CHARACTER — CONDITIONAL, on the DRILLS/ALT MODES rule: hidden when no goal
//   matches goalMeta's isCharacterGoal (a 'progression' goal with no playfield
//   route), because "this machine has no character system" is not an answer
//   anyone came for. One card per matching goal — title, difficulty, the
//   goal's own summary, its instruction lines VERBATIM, and a reward line when
//   the dataset has one. THE INSTRUCTION LINES ARE THE PAYLOAD: this material
//   is what the hero you pick, the gear you bank and the XP you carry actually
//   DO, and it is the one layer of a modern machine that a route drawing
//   cannot express at all.
//   THE SHOTS TAB GAVE THIS UP TO GET IT (owner: "drop character dev info from
//   shots and only have it in study"). Those goals still have a ROW in the
//   Shots tab's goal sheet — P7b's honesty contract is that the sheet lists
//   every goal the machine has, and dropping the rows would resurrect exactly
//   the silent omission that contract exists to end — but the row now says
//   "opens CHARACTER in Study" and jumps HERE instead of to the Goals tab.
//   overlay/map2d.ts's goalRowOpts owns that branch, off the SAME predicate,
//   and app.ts owns the jump itself (mountStudy's openCharacter below).
//
// LEARN IS ONE DOOR NOW (2026-08-15, owner: "als learn and all shots are like
// the same thing, i think we can combine those two buttons and their
// material"). He is right, and the two pills were the tell: LEARN was the
// CURRENT shot and ALL SHOTS was the same tour listed out, so the answer to
// "what is this shot" and "what else is there" lived behind two buttons that
// each hid the other's half. The LEARN sheet is now BOTH — the current shot's
// detail on top, the whole scoped tour listed below it — and the ALL SHOTS
// pill is DELETED (the button dies, the material lives on).
//
//   THE SPLIT. Detail takes its natural height, capped at 40% of the panel
//     (styles.css `.study-learn-detail`: 22dvh of the panel's 55dvh — long
//     notes scroll INSIDE that cap rather than pushing the list off-screen);
//     the list takes the rest and scrolls independently. Two scroll regions,
//     one for each half, so neither can consume the other. Numbers at 667px:
//     panel 366.9, head 44, body 300.9 -> detail <= 146.7, list >= 154.1.
//   THE LIST IS NEVER REBUILT BY A JUMP. Tapping a row (or stepping ‹ ›)
//     replaces the DETAIL's children only — renderLearnDetail — and moves the
//     ✓/aria-current marks in place with markIndexRows. That is what keeps a
//     keyboard user's focus AND the list's scroll position across a jump: the
//     row elements are the same nodes they were. The only path that does
//     rebuild the rows is a MODEL change, which really does change the tour
//     (syncFromState), and that one re-homes focus deliberately.
//   THE LIST IS THE SCOPED TOUR, always: `tourShots`, which is whatever the
//     LEVEL control is walking — a zone level lists that deck's shots, ALL
//     lists the whole machine. It cannot disagree with the ‹ › walk because it
//     is built from the same array.
//   ALT MODES — CONDITIONAL, hidden when no goal in the dataset carries an
//     `altMode` flag (dataset schema v7). One card per flagged goal: the
//     title, a type chip (VIDEO MODE / MENU / RULESET), the goal's own
//     summary, its how-lines, and a reward line when the dataset has one.
//     DUPLICATION IS THE DESIGN, not an oversight: every one of these goals
//     STAYS on the Goals tab, in the Map picker and on its guide page. This
//     sheet is a COLLECTION — the owner's "a lot of games have alternate modes
//     and that should be its own button" — and a collection that moved its
//     members would be a reorganisation nobody asked for.
//   DRILLS — CONDITIONAL, hidden when the dataset has no `drills[]` (the same
//     fail-soft rule the ACTION pill uses for datasets with no actionButton).
//     Rendering is a LOCAL implementation, deliberately not an import of
//     ui/machinecard.ts's renderPracticeSection: that module is UNIMPORTED
//     (see its own note + app.ts's UNIMPORT block) and importing it here to
//     reuse ~30 lines would drag the whole dead Card renderer, its
//     goal-resolution helpers and its stripped `.mcard-*` stylesheet back
//     into the shipped bundle.
//
// DRILL `focus` IS FREE PROSE, NOT AN ENUM (measured 2026-08-14): the 30
// authored drills across the five machines that have them carry 29 DISTINCT
// focus values, from tags ('timing', 'accuracy') to whole sentences
// ('Avoiding the SDTM reject on the bash toys'). So there is no fixed
// category set to colour-code against — the chip renders the authored text on
// the neutral .study-learn-chip recipe, and a categorical treatment would
// need a dataset schema change (a closed `focus` vocabulary) before it could
// mean anything. Noted rather than faked.
//
// NOT WIRED HERE: a drill's `goal` field. Jumping from a drill to that goal's
// detail needs the Goals-tab bridge callback (Program B's jumpToGoalDetail),
// which is threaded from app.ts through mountMap2D — files this phase does
// not own. The hook is a one-parameter widening of mountStudy when that
// bridge lands; the `goal` field is read by nothing here today.
//
// THE OWNER'S "REALLY JUMPY" WAS TWO FAULTS STACKED, and the first one is the
// reason the second was never noticed:
//
//   1. THE PILL ROW WAS UNDER THE SHEET'S OWN BACKDROP. `.study-top-row`
//      shipped at z-index 4; `.study-learn-backdrop` is `inset: 0` at 9. So a
//      TAP on ACTION BUTTON while LEARN was open never reached the pill — it
//      hit the backdrop, which dismissed the sheet. The pill only worked on
//      the SECOND tap, by which point there was nothing to switch from, so
//      what the owner saw was: sheet vanishes, sheet climbs back up from
//      off-screen. A keyboard user, whose focus order z-index cannot touch,
//      got a different behaviour entirely from the same button. styles.css
//      now stacks the row at 10 (above the backdrop, level with the panel).
//   2. EVEN THEN, SWITCHING REBUILT THE SHEET. Each kind's open() closed the
//      other, so the panel was removed and a new one inserted — replaying the
//      full 0.25s studySheetUp slide, with two focus() calls in the same tick
//      (which on iOS adds its own scroll-into-view lurch).
//
// So: the pills are live controls above the backdrop, pressing the pill of the
// kind already showing closes it (the dismissal the backdrop tap used to
// provide), and a switch keeps the panel where it is and swaps only its body —
// swapSheetBody: a fresh body element so the 120ms fade-in plays on insertion,
// plus a measured from -> to height transition so the two sheets' different
// heights do not snap. Both are behind prefers-reduced-motion, in CSS and in
// JS, and reduced motion keeps the swap while dropping the motion.
//
// The entrance animation was never at fault and did not need touching: it
// animates `transform` only (styles.css pins that with a test).
//
// CLOSED 2026-08-14 (P8) — STEPPING WHILE A SHEET IS OPEN, BY FINGER. The
// bottom ‹ › bar is under the backdrop AND geometrically under the panel
// (`.study-controls` sits at bottom:8px; the sheet covers the bottom 55dvh),
// so no z-index change could ever make it reachable — it worked by keyboard
// only, which is what the note that used to sit here documented. The fix is
// the second of the two options that note named: a compact ‹ › pair INSIDE
// the sheet's own header row (buildSheetHead below), calling the SAME
// stepManual() the bottom bar does, so there is one stepping implementation
// and the in-place body update is the same code path either way.
//   They are shown for the LEARN kind ONLY, and that is a content judgement,
//   not an oversight: LEARN is the only body whose subject is the CURRENT
//   SHOT. ACTION BUTTON, DRILLS and ALT MODES are machine-level (stepping
//   would change nothing on screen but the tour position behind the sheet).
//   THEY SURVIVED THE MERGE (2026-08-15) even though LEARN now carries the
//   list, which was the old reason ALL SHOTS had no steppers of its own: the
//   two controls answer different questions. ‹ › walks to the NEXT shot
//   without knowing its name; a row is for the shot you can already see and
//   want by name. Dropping the pair would also make a 26-row list the only way
//   to move one shot along.
//   The head is a FIXED height whether the steppers are showing or not, so
//   swapping kinds never moves the body's top edge (P5's "one standard
//   height, nothing resizes" rule, applied to the head as well as the panel).
//
// SHEET-WHILE-STEPPING (owner: "pick this unless it's janky — document").
// Implemented AS SPECIFIED — stepping ‹ › while LEARN is open updates the
// sheet's content in place, sheet stays open, tour position actually moves.
// The naive way to do "update in place" — remove and rebuild the WHOLE
// panel element on every step — IS janky: `.study-learn-panel`'s CSS
// carries the slide-up entrance animation, so recreating that element on
// every ‹ › press would replay the slide-up transition on every single
// step, which reads as the sheet re-opening itself repeatedly rather than
// updating in place. The fix: the panel SHELL (backdrop, panel, back
// button, body container) is built exactly ONCE per open
// (toggleStudySheet()); stepping while open calls renderLearnBody() alone,
// which only replaces the body container's CHILDREN — the panel element
// itself, and its animation, are never touched again until close. That is
// what makes "update in place" non-janky here, so the spec's default is
// what shipped.
//
// TAP-TO-INSPECT hit-testing reuses the exact pattern map2d.ts's own
// tap-to-identify uses (`lastShotPoints`, closest insert within a fixed
// CSS-px halo, recomputed every render() call) — see that file's own t12c
// comment — and, since P8, the exact same SHAPE-AWARE measurement: map2d.ts's
// exported insertHitDistance, so a shot is tappable in the same places on
// both tabs. Plus a second pass against `lastZoneRects` (zoneScreenRect's
// output, one per visible zone) for a tap that lands on a deck plate rather
// than a dot. A dot hit always wins over a zone-plate hit when both would
// match (dots are checked first, and return immediately) — the more precise
// target should never lose to the coarser one underneath it.
//
// LEVEL v2 (2026-08-15) — "I can't flip thru the different playfield levels
// here. Would be nice to scroll thru which level to show, plus I'd like to see
// the upper deck and the main playfield at once." Two things, one pass.
//
//   1. THE SCROLLER. The stacked list of level buttons became one fixed
//      scroller: a full-width name plate over a 70x44 ‹ › pair, cycling
//      MAIN -> each visible zone -> ALL LEVELS -> MAIN. It is parked at the
//      FOOT of the rail, and that half is the actual fix for "I can't flip
//      thru" — the list WORKED, it just would not hold still, because
//      `.study-rail`'s padding-top is the drawn card's own top edge and the
//      card's top edge depends on the level you just picked. Measured in
//      Chrome: Jaws at 390x780 threw the rows 171px down the screen on the
//      first press; Halloween at 375x667 pushed two of three rows onto the
//      readout bar and let the rail's `overflow: hidden` clip 74px of column.
//      refreshLevelControl's own comment carries the full measurement.
//
//   2. THE COMBINED LEVEL. `LEVEL_ALL` draws the main playfield AND every
//      visible deck at once, each as its own card, decks above and
//      `kind:'lower'` windows below — the honest positions. computeStackRects
//      owns that geometry and is pure and exported so the arithmetic is
//      testable at any viewport; renderAllLevel owns what is painted into it.
//      The tour on ALL is the WHOLE machine, the same roster MAIN walks; what
//      changes is which card each shot lands on. Every sheet, the readout, the
//      announcements and tap-to-inspect are unchanged — they all read
//      `tourShots`, which ALL does not touch.
//
//   A TRIM-HIDDEN ZONE IS NO LONGER A STOP in the cycle (a scroller's label is
//   its live selection, so a stop that cannot be shown would be the control
//   lying), but it keeps its explanation as a line under the scroller — the
//   whole point of the 2026-08-14 revision, which came from rolo failing to
//   find Jaws's Orca deck on a Pro. See studyLevels' own note.
//
// LEVEL v3 + MODEL (2026-08-14) — "The buttons on the side still aren't
// changing the playfield." Reported on a Pro, where Jaws's only zone (the Orca
// deck) is Premium/LE: the cycle collapsed to MAIN alone, and the ‹ › pair sat
// there DISABLED — 70x44, amber, at 0.4 opacity, in a rail where everything
// else is live. Two changes, and the second is why the first is safe:
//
//   1. NO ARROWS WHEN THERE IS NOWHERE TO GO. The row hides outright with one
//      reachable level (refreshLevelControl). A control that is present is a
//      promise; dimming is not a retraction. If a disabled arrow is ever left
//      on screen by some future path, styles.css now makes it read faint and
//      unlit rather than amber.
//
//   2. MODEL MOVED INTO THE RAIL. PRO | PREM/LE, under LEVEL, on any machine
//      with trim-restricted content — the SAME state.setTrim and the SAME
//      machineHasVariants predicate the Shots tab's settings popover uses, so
//      the two controls are two views of one field and cannot disagree. The
//      reason line under LEVEL therefore stops saying "switch MODEL in
//      settings" (a direction to another tab) and simply names the deck and
//      the model it needs; the switch itself is the next thing down the rail.
//
// A11Y: the ‹ › buttons carry real aria-labels; the sheet (any kind) gets
// role="dialog"/aria-modal/aria-labelledby, traps Escape AND Tab, focuses its
// back button on open, and returns focus to whatever was focused before it
// opened — see toggleStudySheet()/closeStudySheet() below.
//
// THE TAB TRAP IS NEW IN P8, AND IT IS A FIX, NOT AN ADDITION. This panel has
// declared `aria-modal="true"` since P4 while handling only Escape — Tab
// walked straight out of it into the pills, the canvas and the tab bar behind.
// That was survivable when the sheet's ONLY focusable was the Back button
// (one Tab and you were plainly outside). P8 puts up to a dozen in there — a
// list row per shot, a "Study …" per drill, two steppers — so a keyboard
// user now walks a long list and then silently leaks onto controls that are
// visually covered by the sheet they are still "in". The wrap below is the
// same hand-rolled shape ui/sheet.ts's shared shell uses (focusableWithin +
// first/last swap); it is duplicated rather than imported for the same reason
// everything else here is — that module's helper is private, and this panel
// is bespoke on purpose (transparent backdrop).
//
// THE JUMP ANNOUNCEMENT (P8). Tapping a row in LEARN's list, or a drill's
// "Study …", moves the tour BEHIND a sheet that deliberately stays open. A
// sighted user sees the map move and the ✓ hop; a screen-reader user got
// nothing at all — the readout that says "SHOT 4 OF 6" is outside the dialog
// and is not a live region. So the panel carries ONE polite `role="status"`
// (visually hidden, `.sr-only`) that every tour move writes "Shot 4 of 6 —
// Mid Left" into. It lives on the PANEL, not in the body, for two reasons: a
// live region has to be in the document BEFORE its text changes to be
// announced reliably, and the body is the thing kind-switching throws away.
// Auto-shuffle is paused for as long as any sheet is open, so this can only
// ever fire on a deliberate move — there is no 2.5s announcement spam.

import { CANVAS_LABEL_HALO, CANVAS_LETTERBOX, CARD_GRADIENT_A, CARD_GRADIENT_B } from '../theme'
import type { AppState } from '../state'
import type { ActionButtonInfo, AltMode, Drill, Goal, HowItPlays, LightGroup, MapFn, PlayfieldZone, Shot } from '../models'
import {
  drawPlayfieldArt,
  drawShotDots,
  drawZoneArt,
  insertHitDistance,
  insertShapeFor,
  machineZones,
  playfieldRect,
  resolveMapLevel,
  zoneLocalMap,
  zoneMemberShots,
  zoneScreenRect,
  drawLitSites,
  type LitSite,
  INSERT_DRAW_RADIUS,
  PLAYFIELD_ASPECT,
  type Rect,
} from '../overlay/map2d'
import { drawHaloLabel, rectXBounds, roundedRectPath, HIGHLIGHT_HOLD_S } from '../overlay/drawing'
// HOW IT PLAYS + LIGHTS (schema v9). The pure lamp logic lives in ./lights so
// the sheet and the map read one contract; controlLine/laneChangeLine own the
// copy so it cannot drift between the sheet and the guide page.
import { howItPlaysOf, lightGroups, groupsForShot, controlLine, laneChangeLine, resolveSites, glowAt, stepAt, isLaneChangeDemo, demoSiteCount, animationEndS } from './lights'
import { loadChunk } from './chunkError'
// INLINE TERMS (2026-10-14). The pure matcher/builder; the glossary DATA it
// links against arrives asynchronously (see `glossaryData` in mountStudy), so
// only the TYPE is imported from ./glossary here — the module itself stays a
// lazy import, exactly as the "Lane change ›" button already loads it.
import { linkTerms } from './linkTerms'
import type { GlossaryData } from './glossary'
import { isShotVisible, isZoneVisible } from '../overlay/shotgeom'
// The rail's MODEL control shows itself under the SAME predicate the Shots
// tab's settings popover uses (map2d.ts's refreshModelControl) — imported, not
// re-derived, so the two controls can never disagree about whether a machine
// has variants at all.
import {
  altModeGoals,
  characterGoals,
  clampDifficulty,
  instructionsFor,
  isPathless,
  machineHasVariants,
  pipsTextWithEmpty,
  ALT_MODE_LABEL,
} from './goalMeta'
import { claimOverlayKey, isRendered, isTopmost, popOverlay, pushOverlay, OVERLAY_TIER_LOCAL } from './overlayStack'

/** BACKGLASS (P5, 2026-08-14) — the canvas half of styles.css's --display,
 *  written out because `ctx.font` cannot read a custom property. Kept in step
 *  with overlay/map2d.ts's DISPLAY_STACK (same string, same reason that file
 *  has its own copy: neither module imports the other's private constants). */
const DISPLAY_STACK = `'Chakra Petch', 'DIN Alternate', system-ui, sans-serif`

/** Generous tap-target HALO in CSS px, matching map2d.ts's own HIT_RADIUS
 *  exactly (an insert is ~5px of ink, far too small to reliably hit on a
 *  phone). Not imported — see this file's header on trivial-constant
 *  duplication.
 *
 *  2026-08-14 (P8): this used to be the radius of a circle centred on the
 *  shot's POINT. It is now the width of a halo AROUND THE DRAWN SHAPE — see
 *  onCanvasClick's insertHitDistance call. Same number, and the same number
 *  map2d.ts uses, so the two tabs still agree about what is tappable. */
const HIT_RADIUS = 16

/** Vertical band the drawn card is inset by at the TOP.
 *
 *  P9 (2026-08-14) RE-DERIVED THIS RATHER THAN SHRINKING IT. Until the rail
 *  landed, 60 was the depth of `.study-top-row` — a band reserved so the pill
 *  row had somewhere to float that was not on top of the playfield. The pills
 *  have their own column now and nothing at all sits over the canvas's top
 *  edge, so the obvious move was to shrink this and let the card grow. That
 *  is WRONG, and the reason is in BOTTOM_CLEARANCE's own note: playfieldRect
 *  centres the card in the reduced height and `rect.y += TOP_PAD / 2` then
 *  pushes it down, so HALF of this band comes off the BOTTOM. Shrinking it
 *  moves the card's bottom edge DOWN, under the readout bar — the exact P3
 *  bug. The card's real vertical budget is bounded by the bar, not by this
 *  number; 60 is what puts the bottom edge 2px clear of it, and 60 it stays.
 *  It is now purely a centring/bottom-clearance mechanism, no longer a
 *  reservation for chrome that no longer exists there. */
const TOP_PAD = 60

/** How close to the canvas's TOP EDGE the one floating shot-name label may be
 *  drawn before drawCurrentLabel flips it BELOW its dot instead.
 *
 *  192 -> 8 (P9). This used to be STACK_CLEAR: the depth of the four-pill
 *  stack that floated over the card's top-right, because a label drawn under
 *  a solid amber pill is unreadable. With the pills moved into their own rail
 *  there is nothing over the canvas to clear, so the band collapses to what
 *  it always really was underneath — a margin that keeps the label from being
 *  drawn half off the top of the canvas. The label may now use the full card
 *  height, which is the point: on the tallest shots it no longer flips to the
 *  wrong side of its own dot for a reason that has been deleted.
 *
 *  8px is the same MARGIN playfieldRect insets the card by, so a label at the
 *  very top of the card sits on the letterbox strip rather than on the card's
 *  own border. drawCurrentLabel adds its own 10px of slack on top. */
const LABEL_TOP_MARGIN = 8

/** Clearance above `.study-controls` (styles.css: 44px bar at bottom:8px) —
 *  same geometry/reasoning as map2d.ts's CONTROLS_CLEARANCE, duplicated
 *  rather than imported (it's a private constant there, and Study's bar,
 *  unlike Map's, is unconditionally visible so the two aren't really "the
 *  same constant").
 *
 *  THE MATH (render() below, playfieldRect's MARGIN = 8):
 *    availableHeight = H - BOTTOM_CLEARANCE - TOP_PAD
 *    card bottom     = availableHeight - MARGIN + TOP_PAD / 2
 *                    = H - BOTTOM_CLEARANCE - TOP_PAD / 2 - MARGIN
 *  Note TOP_PAD/2 lands in there too: playfieldRect centers the rect in the
 *  reduced space and `rect.y += TOP_PAD / 2` then pushes it down, so half the
 *  top band comes off the BOTTOM as well. The bar's top edge is at
 *  H - 8 - 44 = H - 52. (That line is the HEIGHT-constrained case, i.e. every
 *  phone: on a viewport wide enough to clamp on width instead, the card is
 *  shorter and its bottom edge sits even higher, so this is the worst case.)
 *
 *  2026-08-14: 10 -> 16. At 10 (with this tab's TOP_PAD of 60) the card's
 *  bottom edge landed at H - 10 - 30 - 8 = H - 48 — FOUR PIXELS BELOW the
 *  bar's top edge, i.e. the controls bar covered the drawn flippers/drain on
 *  every render, on every phone, unconditionally. It was never the same
 *  geometry as Map's despite sharing the number, because Map reserves
 *  TOP_PAD 72 to this tab's 60 and that difference lands half-and-half on
 *  both edges. 16 puts the card bottom at H - 16 - 30 - 8 = H - 54, 2px clear
 *  of the bar — exactly the clearance map2d.ts's 10 buys on the Shots tab.
 *  Re-derive this whenever TOP_PAD, MARGIN, or `.study-controls`'s
 *  bottom/height changes; tests/study.test.mjs section (l) pins it. */
const BOTTOM_CLEARANCE = 16

/** Coalescing window for the sheet's live region, in ms — see announceTour.
 *  250ms is under the ~300ms at which a deliberate action stops feeling
 *  instant (the first write is not delayed by it at all), and long enough to
 *  swallow an autorepeating key, which fires every ~30-50ms after its initial
 *  delay. */
const ANNOUNCE_WINDOW_MS = 250

/** The id of the COMBINED level — main playfield AND every visible deck, all
 *  drawn at once (LEVEL v2, 2026-08-15, owner: "I'd like to see the upper deck
 *  and the main playfield at once"). Not a zone id: `playfields[]` ids come
 *  from the dataset, and this one is the app's own. Kept out of any dataset
 *  namespace by being checked FIRST everywhere `studyLevel` is read. */
const LEVEL_ALL = 'all'

/** Gap between two stacked cards on the ALL level, in CSS px. Small on
 *  purpose: the cards are a single object seen in section, so the gap has to
 *  read as "these are different surfaces" without spending height that the
 *  main card can use. */
const STACK_GAP = 6

/** Inset the ALL stack keeps on all four sides — playfieldRect's own MARGIN,
 *  duplicated for the same reason every other map2d constant in this file is
 *  (it is private there). A stack laid out with a different margin from the
 *  single-card levels would make the card's left edge JUMP as you flip
 *  through, which is the exact complaint this whole pass answers. */
const STACK_MARGIN = 8

/** The shortest a deck card may be drawn before it stops being worth drawing.
 *  MEASURED against the shipped datasets rather than picked: the shallowest
 *  authored deck is Lord of the Rings' Paths of the Dead at bounds.h 0.12, so
 *  at true relative scale on a 375x667 phone it would come out 42px tall — two
 *  insert shapes and no room for either one's name. 64 is the floor at which a
 *  deck card still holds a dot, its label and its floor plate. */
const MIN_DECK_HEIGHT = 64

/** The share of the stack's height the MAIN card keeps no matter what. The
 *  deck floor above is a floor, not a claim on the budget: a machine with two
 *  decks (halloween, wizard_of_oz, popeye) can ask for 128px of deck on a
 *  414px-tall host, which would leave the playfield itself a minority of its
 *  own screen. When the two rules collide the decks yield — the main card is
 *  the subject and a deck is context, and a 47px deck you can still see is a
 *  better answer than a main card you cannot read. */
const MAIN_MIN_SHARE = 0.7

/** One card in the ALL level's stack: the surface it draws, and where.
 *  `zone: null` is the main playfield. */
export interface StackCard {
  zone: PlayfieldZone | null
  rect: Rect
}

/** THE ALL LEVEL'S LAYOUT, as a pure function of the canvas box and the
 *  machine's VISIBLE zones — exported so tests/study.test.mjs can drive the
 *  arithmetic directly at any viewport, without mounting a canvas.
 *
 *  ORDER (the honest position, which is the whole point of drawing them
 *  together): every `kind:'lower'` zone is drawn BELOW the main card, because
 *  that is where it is — a sunken window under the playfield. Everything else
 *  (upper decks, mini-playfields) is drawn ABOVE it. Within each group the
 *  cards run in the tour's own top-to-bottom spatial order (descending
 *  `bounds.y`), so two upper decks stack the way they sit on the table.
 *
 *  A DECK'S SHAPE IS ITS TRUE SHAPE HERE, and this is the ONE thing the ALL
 *  level does differently from the single-zone level. Alone on the card, a
 *  zone is drawn at `bounds.w / bounds.h` — map2d.ts's renderZoneLevel and
 *  this file's own zone path both do that, "own scale, keep aspect of
 *  bounds", which frames the deck to fill the screen. That framing is a
 *  2.2x horizontal magnification, because UV is not isotropic: u spans the
 *  table's 20.25" width and v its 45" length. It costs nothing when the deck
 *  is the only thing on screen and it is a visible lie the moment the table
 *  is drawn next to it — Black Knight 2000's upper deck (bounds.w 0.72) would
 *  come out 1.6x WIDER than the whole playfield it sits on. So the stack uses
 *  `PLAYFIELD_ASPECT * bounds.w / bounds.h`, which makes a deck card exactly
 *  `bounds.w` of the main card's width and `bounds.h` of its height — its real
 *  footprint, at a glance.
 *
 *  THE HEIGHT MATH, in three passes:
 *    1. TRUE SCALE. The stack is `1 + Σ bounds.h` main-card-heights tall, so
 *       the main card gets `budget / that`, capped by what the width allows.
 *    2. READABILITY. Any deck under MIN_DECK_HEIGHT is lifted to it.
 *    3. MAJORITY. If the lifts left the main card under MAIN_MIN_SHARE of the
 *       budget, every deck is scaled back proportionally until it is not.
 *  Worked numbers for the shipped machines are in tests/study.test.mjs
 *  section (ae).
 *
 *  Returns [] when the box is too small to lay anything out — render() then
 *  falls back to the single-card path rather than drawing garbage. */
export function computeStackRects(
  width: number,
  availableHeight: number,
  zones: readonly PlayfieldZone[],
): StackCard[] {
  const w0 = width - 2 * STACK_MARGIN
  const h0 = availableHeight - 2 * STACK_MARGIN
  const n = zones.length
  const budget = h0 - n * STACK_GAP
  // NO EARLY GUARD ON `w0 <= 0 || budget <= 0` HERE. One was written, and the
  // mutation battery proved it inert: a non-positive width makes `widthCap`
  // non-positive, and a non-positive budget cannot survive having deck heights
  // subtracted from it, so BOTH cases already fall out of the `mainH <= 0`
  // check below. Two guards for one condition is a second place to get it
  // wrong; see this repo's own precedent for deleting a line no test can
  // observe rather than keeping it for comfort.
  const zoneH = (z: PlayfieldZone): number => Math.max(0, z.bounds.h)
  const widthCap = w0 / PLAYFIELD_ASPECT

  // (1) true relative scale
  const share = zones.reduce((a, z) => a + zoneH(z), 0)
  const trueMain = Math.min(budget / (1 + share), widthCap)
  // (2) readability floor
  let decks = zones.map((z) => Math.max(trueMain * zoneH(z), MIN_DECK_HEIGHT))
  let deckSum = decks.reduce((a, b) => a + b, 0)
  // (3) the main card keeps its majority
  if (deckSum > 0 && budget - deckSum < MAIN_MIN_SHARE * budget) {
    const k = (budget * (1 - MAIN_MIN_SHARE)) / deckSum
    decks = decks.map((d) => d * k)
    deckSum = decks.reduce((a, b) => a + b, 0)
  }
  const mainH = Math.min(budget - deckSum, widthCap)
  if (mainH <= 0) return []

  const byPosition = (a: PlayfieldZone, b: PlayfieldZone): number => b.bounds.y - a.bounds.y
  const above = zones.filter((z) => z.kind !== 'lower').sort(byPosition)
  const below = zones.filter((z) => z.kind === 'lower').sort(byPosition)
  const heightOf = (z: PlayfieldZone): number => decks[zones.indexOf(z)] ?? MIN_DECK_HEIGHT

  const ordered: { zone: PlayfieldZone | null; h: number; w: number }[] = [
    ...above.map((z) => ({ zone: z, h: heightOf(z), w: heightOf(z) * zoneAspect(z) })),
    { zone: null, h: mainH, w: mainH * PLAYFIELD_ASPECT },
    ...below.map((z) => ({ zone: z, h: heightOf(z), w: heightOf(z) * zoneAspect(z) })),
  ]

  const stackH = ordered.reduce((a, c) => a + c.h, 0) + n * STACK_GAP
  let y = (availableHeight - stackH) / 2
  const out: StackCard[] = []
  for (const card of ordered) {
    out.push({ zone: card.zone, rect: { x: (width - card.w) / 2, y, w: card.w, h: card.h } })
    y += card.h + STACK_GAP
  }
  return out
}

/** A zone's TRUE on-table aspect — see computeStackRects' own note for why
 *  this is not `bounds.w / bounds.h`. Falls back to the whole-table aspect for
 *  a degenerate zone rather than dividing by zero. */
function zoneAspect(zone: PlayfieldZone): number {
  if (zone.bounds.h <= 0 || zone.bounds.w <= 0) return PLAYFIELD_ASPECT
  return (PLAYFIELD_ASPECT * zone.bounds.w) / zone.bounds.h
}

/** The LEVEL cycle, in ‹ › order: MAIN, then one entry per VISIBLE zone, then
 *  ALL — and ALL only exists when there is at least one visible zone to
 *  combine with. Exported for direct testing of the cycle's own shape.
 *
 *  A TRIM-HIDDEN ZONE IS NOT A STOP, and that is a deliberate reversal of the
 *  shape this control had as a list. In a list, a disabled row you can see and
 *  cannot press is a fact about your machine, stated where you went looking
 *  for it (rolo's Orca-deck report). In a SCROLLER the label IS the live
 *  selection — landing on 'ORCA DECK' with the main playfield still on the
 *  canvas underneath would be a control lying about what it is showing. So the
 *  zone leaves the cycle and keeps its explanation as a static line under the
 *  scroller (buildLevelReasons below): the deck is still discoverable, and
 *  every stop in the cycle is a surface you can actually see. */
export function studyLevels(zones: readonly PlayfieldZone[]): { id: string; label: string }[] {
  const levels = [{ id: 'main', label: 'MAIN' }, ...zones.map((z) => ({ id: z.id, label: z.name.toUpperCase() }))]
  // 'ALL LEVELS', not 'ALL'. It was written to dodge a collision with the ALL
  // SHOTS pill 100px up the same 158px column; that pill is gone (2026-08-15)
  // and the label stays anyway, because the word it dodged with is the one
  // that says what the stop IS — 'ALL' alone would leave a scroller whose
  // live selection reads as a quantity of nothing in particular.
  if (zones.length > 0) levels.push({ id: LEVEL_ALL, label: 'ALL LEVELS' })
  return levels
}

/** Resolves `current` after the visible-zone roster changes — map2d.ts's
 *  resolveMapLevel, plus the one level it cannot know about. ALL survives only
 *  while there is something to combine: a MODEL switch that hides every zone
 *  degenerates it to MAIN rather than leaving a "combined" view of one
 *  surface. */
export function resolveStudyLevel(current: string, zones: readonly PlayfieldZone[]): string {
  if (current === LEVEL_ALL) return zones.length > 0 ? LEVEL_ALL : 'main'
  return resolveMapLevel(current, zones)
}

function must2DContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('study: 2D canvas context unavailable')
  return ctx
}

/** Every visible shot for the CURRENT trim, in tour order — see this file's
 *  header "TOUR ORDER" note. Exported for direct unit testing
 *  (tests/study.test.mjs) without mounting the full DOM/canvas tree. */
export function buildTour(shots: readonly Shot[], trim: 'pro' | 'premium-le'): Shot[] {
  return shots.filter((s) => isShotVisible(s, trim)).sort((a, b) => b.y - a.y || a.x - b.x)
}

/** Card background — a deliberately MINIMAL local reimplementation of
 *  map2d.ts's drawMapCardBackground (gradient + clip + drawPlayfieldArt +
 *  border), with its glow block dropped outright: the glow is always a
 *  selected GOAL's category color, and Study never has one. See this file's
 *  header for why this is a local copy rather than an import. */
/** The card itself — gradient, clipped interior, border — with `paintInside`
 *  drawing whatever surface this level shows. Factored out 2026-08-14 for the
 *  LEVEL feature: a zone level paints map2d.ts's drawZoneArt inside exactly
 *  the same card the main playfield gets, so switching level changes what is
 *  ON the card and nothing about the card. */
function drawStudyCardChrome(ctx: CanvasRenderingContext2D, rect: Rect, paintInside: () => void): void {
  const corner = 12
  const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h)
  gradient.addColorStop(0, CARD_GRADIENT_A)
  gradient.addColorStop(1, CARD_GRADIENT_B)
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.fillStyle = gradient
  ctx.fill()

  ctx.save()
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.clip()
  paintInside()
  ctx.restore()

  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, corner)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.lineWidth = 2
  ctx.stroke()
}

function drawStudyCardBackground(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  map: MapFn,
  tSec: number,
  shots: readonly Shot[],
  playfields: readonly PlayfieldZone[],
): void {
  drawStudyCardChrome(ctx, rect, () => {
    // LABEL_TOP_MARGIN, not TOP_PAD (P9): map2d.ts uses this purely as a floor
    // for zone-plate LABELS (`Math.max(..., topInset + 8)`), never for layout,
    // and the band those labels used to have to dodge was the pill row that
    // now lives in the rail.
    drawPlayfieldArt(ctx, map, tSec, 0.85, shots, playfields, LABEL_TOP_MARGIN)
  })
}

/** The floating current-target NAME (owner spec point 2: "ONLY the current
 *  target's NAME floats on the field... banner-safe: never under any
 *  header"). Sits 15px above the dot by default, same halo-label recipe
 *  map2d.ts's own route caption uses; when that position would land inside
 *  the reserved top band it flips BELOW the dot instead — the exact
 *  "banner exclusion" rule map2d.ts's ambient-major label / zone-plate label
 *  already apply (see that file's phase A12 item 3 comments), applied here
 *  to the one label this tab ever draws. */
function drawCurrentLabel(
  ctx: CanvasRenderingContext2D,
  shot: Shot,
  point: { x: number; y: number },
  topInset: number,
  /** The DRAWN CARD, not the MapFn. cardXBounds asks the map where u = 0 and
   *  u = 1 land, which is the card's edges on a main playfield and four times
   *  the card on a zone (zoneLocalMap re-bases u into the zone's footprint) —
   *  that shipped once as "Ship's Wheel Spinner" clipped to "Wheel Spinner" on
   *  the Orca deck. The rect is the card on every level. */
  rect: Rect,
): void {
  const aboveY = point.y - 15
  const labelY = aboveY < topInset + 10 ? Math.max(point.y + 18, topInset + 10) : aboveY
  // BACKGLASS: the floating current-target name is display-face amber-white
  // on the same dark plate the concept draws under its lit shot's label.
  //
  // HORIZONTALLY CLAMPED TO THE CARD (owner, 2026-08-14: "make sure the names
  // of sections on playfields don't disappear over the edge"). This label has
  // had the VERTICAL flip since it was written — it dodges the top edge — and
  // no horizontal guard at all, so a shot near the left edge with a long name
  // ran off the canvas: Jaws's "Ship's Wheel Spinner" rendered as "ip's Wheel
  // Spinner". drawHaloLabel does the clamping; the halo and the lit insert
  // under it are drawn from the shot's real point either way, so a clamped
  // name still reads as belonging to its dot.
  //
  // IT CAN STILL LAND ON A ZONE PLATE'S NAME ('ORCA DECK'), and that is
  // ACCEPTED rather than unnoticed — the owner's screenshot showed it. The
  // mechanism, checked rather than assumed: map2d.ts's labelPacker is created
  // INSIDE drawShotDots and only ambient-major labels are registered in it,
  // while plate names are drawn earlier still, by drawPlayfieldArt, which has
  // no packer at all. So plate names are exempt from collision in both
  // directions, and this label — the one thing the tab exists to show — is
  // drawn last and always wins. Its halo plate is what keeps it legible over
  // whatever it lands on. Making the two aware of each other means threading
  // one packer through two exported renderers that both tabs call, which is a
  // bigger change than the overlap costs.
  drawHaloLabel(ctx, shot.name, point.x, labelY, `700 15px ${DISPLAY_STACK}`, '#ffc85f', CANVAS_LABEL_HALO, rectXBounds(rect))
}

/** Deck (zone) label for the LEARN sheet's context chip — "ORCA DECK ·
 *  UPPER" — null when the shot names no `playfield`, or it doesn't resolve
 *  (fail-soft, same discipline every other zone lookup in this app uses).
 *  Looked up against the FULL (unfiltered) playfields list, not the
 *  trim-visible subset used for drawing — a shot already in the tour is, in
 *  the overwhelming case, on a zone that's ALSO trim-visible, but this is
 *  strictly about naming the zone a shot already claims to live on, not
 *  about whether that zone's plate itself is currently drawn. */
function deckLabelFor(shot: Shot, playfields: readonly PlayfieldZone[]): string | null {
  if (!shot.playfield) return null
  const zone = playfields.find((z) => z.id === shot.playfield)
  if (!zone) return null
  return `${zone.name.toUpperCase()} · ${zone.kind.toUpperCase()}`
}

/**
 * Mounts the Study tab into `host` (an app.ts tab panel, shown/hidden like
 * Map/Achievements — never destroyed on tab switch, only hidden). See this
 * file's header for the full design.
 *
 * THE HANDLE CARRIES TWO DOORS BESIDES destroy(): openCharacter(), the arrival
 * the Shots tab's retargeted character rows land on (2026-08-15), and
 * openHowItPlays(), the arrival app.ts's landing uses on boot and on every
 * machine switch (2026-10-14). They are methods on the handle rather than
 * module-level functions for the reason every piece of state in here is a
 * closure variable — the sheet, its kind and its focus belong to THIS mount,
 * and a second mounted Study must not be able to open the first one's sheet.
 */
export interface StudyHandle {
  destroy(): void
  openCharacter(): void
  openHowItPlays(): void
}

export function mountStudy(host: HTMLElement, state: AppState, jumpToGoalDetail?: (goal: Goal) => void, showGoalOnShots?: (goal: Goal) => void): StudyHandle {
  host.innerHTML = ''

  if (!state.data || !state.machine) {
    const msg = document.createElement('div')
    msg.className = 'state-message'
    msg.textContent = 'Loading…'
    host.appendChild(msg)
    // Same handle shape as the real mount, so app.ts holds ONE type and never
    // has to ask which flavour of Study it got. There is no sheet to open on a
    // tab that has no data yet, and a no-op is the honest answer.
    return { destroy(): void {}, openCharacter(): void {}, openHowItPlays(): void {} }
  }

  const canvas = document.createElement('canvas')
  canvas.className = 'study-canvas'

  // THE RAIL (P9, 2026-08-14, owner: "move the playfield to the left side of
  // the screen and have the buttons take like the right 1/6 of the screen").
  // #study-host is a flex ROW now — [canvas | rail] — instead of a canvas with
  // a pill row floating over its top-right corner. See styles.css.
  const rail = document.createElement('div')
  rail.className = 'study-rail'
  // THE EYEBROW IS GONE (2026-08-15, owner: "the text study jaws under the
  // buttons is unnecessary. Remove that from all studys."). It was a pill at
  // the foot of the rail reading 'STUDY · JAWS', and it was saying two things
  // the screen already says: the tab bar shows which tab you are on, and the
  // app header carries the machine name on every tab. Removed outright rather
  // than hidden — and its `margin-top: auto` went with it, so the rail's FOOT
  // ANCHOR moved onto `.study-level-group` (styles.css). That anchor is not
  // decoration: it is what pins LEVEL and MODEL to the rail's bottom edge, a
  // box the drawn card's top edge cannot move, which is the whole of LEVEL
  // v2's "the control must hold still" fix.
  // THE CARD-ALIGNMENT SPACER (LEVEL v2, 2026-08-15). The rail used to carry
  // the card's top edge as its own `padding-top`, which made the alignment
  // UNCONDITIONAL: on a level whose card is short and centred (Halloween's
  // Sanitarium at 375x667 publishes a card top of 176px) the padding ate 176 of
  // the rail's 513, the column's content no longer fit, and `overflow: hidden`
  // clipped the bottom of it — measured in Chrome, the LEVEL control ended up
  // painted across the readout bar with its lower half gone.
  // A spacer is the same alignment expressed as a SHRINKABLE box: it is the
  // only flex-shrinkable item in the column (styles.css), so when the rail runs
  // out of room it gives its height back and the pills simply sit above the
  // card's top edge again. Alignment is cosmetic; a control you cannot reach is
  // not, and this is the flexbox that states which one yields.
  const railSpacer = document.createElement('div')
  railSpacer.className = 'study-rail-spacer'
  railSpacer.setAttribute('aria-hidden', 'true')
  const learnBtn = document.createElement('button')
  learnBtn.type = 'button'
  learnBtn.className = 'study-learn-btn'
  learnBtn.textContent = 'LEARN'
  learnBtn.setAttribute('aria-label', 'Learn about the current shot')
  // ACTION opens the machine-level action-button sheet (dataset schema v6's
  // `actionButton`). Always shown when the dataset carries the field —
  // `present: false` machines still open it, because "this game has no
  // action button" IS the answer the tapping player came for. Hidden (not
  // disabled) only when the field is missing entirely — the same fail-soft
  // rule achievements use for unpatched datasets.
  const actionBtn = document.createElement('button')
  actionBtn.type = 'button'
  actionBtn.className = 'study-action-btn'
  // 'ACTION BUTTON', not 'ACTION' (owner, 2026-08-14) — the pill names the
  // physical thing on the machine, and "ACTION" alone reads as a verb/mode.
  // The SHEET's own title stays the machine's real label for its button
  // ("Cryptkeeper Door Handle", "Action Button", …) from the dataset; this is
  // only the pill.
  actionBtn.textContent = 'ACTION BUTTON'
  // The aria-label still CONTAINS the visible text, case-insensitively
  // ("…action button"), which is what WCAG 2.5.3 Label in Name requires — a
  // voice-control user saying "tap action button" still hits it.
  actionBtn.setAttribute('aria-label', "About this machine's action button")
  // THE ALL SHOTS PILL IS GONE (2026-08-15). It opened the tour as a list;
  // that list is the lower half of the LEARN sheet now, so the button was a
  // second door onto a room LEARN was already standing in. Removed rather than
  // hidden or disabled — the owner asked for the two to be combined, and a
  // pill kept "for now" is the version of that where nothing is combined.
  // DRILLS (P8) — CONDITIONAL, exactly like ACTION BUTTON: hidden (not
  // disabled) when the dataset carries no drills, because "this machine has
  // no drills" is not an answer anyone came for, unlike "this machine has no
  // action button" which is.
  const drillsBtn = document.createElement('button')
  drillsBtn.type = 'button'
  drillsBtn.className = 'study-drills-btn'
  drillsBtn.textContent = 'DRILLS'
  drillsBtn.setAttribute('aria-label', 'Practice drills for this machine')
  // ALT MODES (2026-08-14, dataset schema v7) — CONDITIONAL on exactly the
  // DRILLS rule: hidden when this machine's dataset flags no goal, because
  // "this machine has no alternate modes" is not an answer anyone came for.
  // MACHINE-scoped, so it lives in the rail's lower group with ACTION BUTTON
  // and DRILLS, and it is appended LAST rather than slotted between them: the
  // two shot-scoped pills keep the top of the column (see the order note
  // below), and no existing pill changes slot, so nothing that was reachable
  // with a sheet open stops being reachable.
  const altBtn = document.createElement('button')
  altBtn.type = 'button'
  altBtn.className = 'study-altmodes-btn'
  altBtn.textContent = 'ALT MODES'
  // Contains the visible label case-insensitively (WCAG 2.5.3 Label in Name),
  // the same rule the ACTION BUTTON label follows.
  altBtn.setAttribute('aria-label', "This machine's alt modes — video modes, menus and alternate rulesets")
  // CHARACTER (2026-08-15) — CONDITIONAL on goalMeta's characterGoals, which is
  // exactly the rule the sheet body is filled from and exactly the rule the
  // Shots tab retargets its rows on. Appended LAST, for ALT MODES' own reason:
  // no existing pill changes slot, so nothing that was reachable with a sheet
  // open stops being reachable, and the one shot-scoped pill (LEARN) keeps the
  // top of the column.
  const characterBtn = document.createElement('button')
  characterBtn.type = 'button'
  characterBtn.className = 'study-character-btn'
  characterBtn.textContent = 'CHARACTER'
  // Contains the visible label case-insensitively (WCAG 2.5.3 Label in Name),
  // the same rule the ACTION BUTTON and ALT MODES labels follow.
  characterBtn.setAttribute('aria-label', "This machine's character and progress systems")
  // HOW IT PLAYS + LIGHTS (schema v9) — CONDITIONAL on howItPlaysOf, the same
  // fail-soft gate the two sheets read. Appended LAST for ALT MODES' reason:
  // no existing pill changes slot.
  const howItPlaysBtn = document.createElement('button')
  howItPlaysBtn.type = 'button'
  howItPlaysBtn.className = 'study-howitplays-btn'
  howItPlaysBtn.textContent = 'HOW IT PLAYS'
  howItPlaysBtn.setAttribute('aria-label', "How this machine plays: the objective and how to start scoring")
  // LEARN, ACTION BUTTON, DRILLS, ALT MODES, CHARACTER — top-anchored in the
  // rail (styles.css `order`).
  //
  // LEARN LEADS, and since the merge (2026-08-15) that is the whole ordering
  // rule rather than half of one. The order used to be grouped by SCOPE —
  // shot-scoped LEARN and ALL SHOTS above machine-scoped ACTION BUTTON and
  // DRILLS — because aligning the rail to the card's top edge pushes every
  // pill down by the card's top gutter (26px on a 667px-tall viewport), and
  // the third slot falls under the 55dvh sheet. ALL SHOTS had to clear it: it
  // was the one surface you were explicitly meant to reach WITH a sheet open.
  // Now the only shot-scoped pill is LEARN, in slot 0, and the mid-sheet
  // navigation it used to hand off to is INSIDE it — so nothing below the
  // first slot needs to be reachable while a sheet is up.
  // LEVEL (2026-08-14; v2 2026-08-15) — which surface the tour walks: the main
  // playfield, one of the machine's zones, or ALL of them at once. Parked at
  // the FOOT of the rail (styles.css `order: 3`) and not under the pills, and
  // that is the fix for the owner's "I can't flip thru the different playfield
  // levels here" as much as the scroller itself is — see this file's LEVEL v2
  // note below.
  const levelGroup = document.createElement('div')
  levelGroup.className = 'study-level-group'
  // A named group, because the two arrows below say "previous"/"next" without
  // saying what OF — the heading is a <div> for sighted users and this is the
  // same information for everyone else.
  levelGroup.setAttribute('role', 'group')
  levelGroup.setAttribute('aria-label', 'Playfield level')
  const levelLabel = document.createElement('div')
  levelLabel.className = 'study-level-label'
  levelLabel.textContent = 'LEVEL'
  // THE SCROLLER IS BUILT ONCE and never rebuilt — only its NAME and its
  // arrows' disabled state are written. The list this replaced was torn down
  // and recreated on every shape change, which map2d.ts's own levelShapeKey
  // note calls out as a way to lose a tap mid-press; a control with a fixed
  // element count does not need the guard at all.
  const levelScroller = document.createElement('div')
  levelScroller.className = 'study-level-scroller'
  const levelName = document.createElement('div')
  levelName.className = 'study-level-name'
  const levelArrows = document.createElement('div')
  levelArrows.className = 'study-level-arrows'
  const levelPrevBtn = document.createElement('button')
  levelPrevBtn.type = 'button'
  levelPrevBtn.className = 'study-level-arrow'
  levelPrevBtn.textContent = '‹'
  levelPrevBtn.setAttribute('aria-label', 'Previous playfield level')
  const levelNextBtn = document.createElement('button')
  levelNextBtn.type = 'button'
  levelNextBtn.className = 'study-level-arrow'
  levelNextBtn.textContent = '›'
  levelNextBtn.setAttribute('aria-label', 'Next playfield level')
  levelArrows.append(levelPrevBtn, levelNextBtn)
  // NAME ABOVE ARROWS, not `‹ NAME ›` on one line, and this is a MEASUREMENT
  // rather than a preference. The rail's content width is 144px (158 minus its
  // 6/8 gutters). Two 44px arrows — the tap-target minimum, and these are the
  // control the owner will press over and over — leave 56px for the name
  // between them, and the shipped zone names are prose from the dataset:
  // 'STRODE HOUSE' needs 78px at this type size, 'SANITARIUM' 65px, and
  // 'ENCOUNTER MINI-PLAYFIELD (MANDO HELMET)' is not fitting anywhere. One row
  // would have meant ellipsizing the one word the control exists to show. On
  // its own line the name gets the full 144px and two lines to use, and the
  // arrows get 70x44 each — bigger targets than a single row could ever give
  // them. It is still the popover scroller's recipe (map2d.css's
  // .map-settings-scroller: glass ‹ ›, centred label, cyclic), re-proportioned
  // for a primary rail control instead of a 230px settings popover.
  levelScroller.append(levelName, levelArrows)
  levelGroup.append(levelLabel, levelScroller)

  // MODEL (2026-08-14) — the SAME Pro/Premium-LE switch the Shots tab's
  // settings popover has carried since phase A3, mounted where the person who
  // needs it actually is.
  //
  // WHY IT IS HERE. The LEVEL control's reason line used to end "…switch MODEL
  // in settings", which is a map to another tab's popover printed under a
  // control that had just gone dead. rolo, on a Pro, read it as the app being
  // broken: "the buttons on the side still aren't changing the playfield".
  // A deck he owns was one tap away and the tap was three surfaces away.
  //
  // IT IS NOT A SECOND SOURCE OF TRUTH. There is exactly one trim: AppState's
  // `trim`, persisted per machine by `state.setTrim` (state.ts's
  // trimStorageKey). This control writes it with setTrim and reads it back in
  // refreshModelControl, which the same `state.onChange` subscription that
  // refreshes the LEVEL control runs — so flipping it here moves the popover's
  // segmented control, flipping it there moves this one, and neither one holds
  // a copy of the answer. Visibility is goalMeta's machineHasVariants, the
  // identical predicate map2d.ts's own control uses: a machine with no
  // trim-restricted content has nothing to switch between and shows nothing.
  const modelGroup = document.createElement('div')
  modelGroup.className = 'study-model-group'
  modelGroup.setAttribute('role', 'group')
  modelGroup.setAttribute('aria-label', 'Machine model')
  const modelLabel = document.createElement('div')
  modelLabel.className = 'study-model-label'
  modelLabel.textContent = 'MODEL'
  const modelTrack = document.createElement('div')
  modelTrack.className = 'study-model-track'
  /** One half of the segmented pair. `aria-pressed` rather than a radiogroup:
   *  two buttons that each state their own on/off is what the popover's
   *  segmented controls already are to a screen reader, and it needs no
   *  arrow-key roving to work. */
  function buildModelBtn(label: string, aria: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'study-model-btn'
    b.textContent = label
    b.setAttribute('aria-label', aria)
    return b
  }
  const modelProBtn = buildModelBtn('PRO', 'Pro model')
  const modelPremBtn = buildModelBtn('PREM/LE', 'Premium or LE model')
  modelTrack.append(modelProBtn, modelPremBtn)
  modelGroup.append(modelLabel, modelTrack)

  // The spacer is aria-hidden and empty, so its DOM position is free; `order`
  // decides what is painted where in any case.
  // THE PILL STACK IS A SCROLL BOX (2026-08-15, measured in Chrome when the
  // fifth pill landed). The pills used to be rail children directly, and the
  // rail's own `overflow: hidden` was their only backstop. With five of them
  // that backstop CUT: at 390x667 the column still fitted exactly (the
  // alignment spacer gave back 26.7 of its 38px and the MODEL group's bottom
  // edge landed on the readout bar's top edge to the pixel), but at 390x553 —
  // the shortest viewport this repo's geometry tests cover — the stack ran
  // 42.7px past the rail's bottom and the MODEL control was cut in half.
  //
  // THE MERGE TOOK THAT FIFTH PILL BACK OFF (2026-08-15, same day) — and
  // CHARACTER PUT ONE BACK (2026-08-15, this pass), which is the case the box
  // was built for and is now doing real work in. What changed in between is the
  // pinned block: the eyebrow's removal freed 37.2px, so five pills are no
  // longer the composition that CUT.
  //
  // MEASURED IN CHROME on the built app, Jaws (the machine that lights all
  // five), with the app root pinned to each viewport height in turn — stated
  // that way because it is what was done: this Chrome would not open a window
  // shorter than 337px of viewport, and the rail is a fixed 158px column at
  // every width down to 360, so the vertical budget is the whole measurement.
  //   viewport 667 (rail padding box 512.5): the column needs 396 against a
  //            452.5px content box — it FITS. The alignment spacer keeps its
  //            full 38px, the stack keeps all 212 of itself, nothing scrolls,
  //            and MODEL's bottom edge lands exactly on the rail's content edge.
  //   viewport 553 (rail padding box 398.5): the column needs 396 against a
  //            338.5px content box, so the spacer collapses to 0 and the stack
  //            gives up the remaining 57px — IT SCROLLS by 57 (client 155 of
  //            scrollHeight 212, three whole pills on screen and part of a
  //            fourth). Nothing is cut: LEVEL and MODEL are `flex-shrink: 0`
  //            and MODEL's bottom edge is again exactly on the content edge.
  // So the scroll box is the reason a fifth pill is safe here at all, rather
  // than a spare tyre — and the ORDER of yielding (alignment first, then the
  // stack, never LEVEL or MODEL) is what keeps the two controls this rail's
  // last three revisions exist to protect at full size on the shortest
  // viewport this repo tests. tests/study.test.mjs section (w) carries the
  // arithmetic that reproduces those Chrome numbers to the pixel.
  //
  // The PILLS are the ones that yield and nothing else does: they get the
  // `overflow-y: auto` box, and LEVEL and MODEL stay pinned at full size
  // (styles.css). The order in which things give way is stated in CSS by
  // shrink factor — the alignment spacer collapses FIRST and only then does
  // the stack start scrolling — which is the same rule LEVEL v2 wrote down
  // when it made the spacer shrinkable: alignment is cosmetic, a control you
  // cannot reach is not.
  const pillStack = document.createElement('div')
  pillStack.className = 'study-pill-stack'
  // HOW IT PLAYS · LEARN · CHARACTER, then the rest (2026-09-08, rolo). The
  // objective/scoring story reads first; LEARN — now carrying the targets AND
  // the lights — is second; CHARACTER (the hero you pick / gear you carry) is
  // third; the other machine-level pills follow. Conditional pills (HOW IT
  // PLAYS, CHARACTER, ACTION, DRILLS, ALT MODES) hide when a machine has no such
  // content, so on a machine without HOW IT PLAYS, LEARN leads. (The standalone
  // LIGHTS pill folded into LEARN.)
  // QUIZ ME (2026-10-14) — the recall half of studying. Reading a table is
  // recognition; being asked "what starts Jaws Multiball?" with four shot
  // names in front of you is retrieval, and retrieval is what sticks. The
  // questions are built from THIS machine's own shots, goals and HOW IT PLAYS
  // (ui/quiz.ts, buildQuiz — pure, seeded by machine + day so a set is stable
  // for the session). Appended LAST, the same slot rule every pill after the
  // first three has followed: nothing reachable moves. Unconditional: on a
  // machine too thin for three questions the quiz itself says so and offers
  // DONE, which is a better answer than a pill that is sometimes missing.
  const quizBtn = document.createElement('button')
  quizBtn.type = 'button'
  quizBtn.className = 'study-quiz-btn'
  quizBtn.textContent = 'QUIZ ME'
  quizBtn.setAttribute('aria-label', "Quiz me: five questions on this machine's shots, lights and goals")
  pillStack.append(howItPlaysBtn, learnBtn, characterBtn, actionBtn, drillsBtn, altBtn, quizBtn)
  rail.append(railSpacer, pillStack, levelGroup, modelGroup)

  const controls = document.createElement('div')
  controls.className = 'study-controls'
  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.className = 'study-step-btn'
  prevBtn.textContent = '‹'
  prevBtn.setAttribute('aria-label', 'Previous shot')
  const readout = document.createElement('button')
  readout.type = 'button'
  readout.className = 'study-readout'
  const readoutLabel = document.createElement('div')
  readoutLabel.className = 'study-readout-label'
  const readoutSub = document.createElement('div')
  readoutSub.className = 'study-readout-sub'
  readout.append(readoutLabel, readoutSub)
  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.className = 'study-step-btn'
  nextBtn.textContent = '›'
  nextBtn.setAttribute('aria-label', 'Next shot')
  controls.append(prevBtn, readout, nextBtn)

  // DOM ORDER IS LAYOUT ORDER now: canvas first, rail second, and the two
  // are the flex row's only in-flow children. `controls` (and the sheet, when
  // it opens) stay absolutely positioned against the host, so they still span
  // the FULL width across both columns — see styles.css.
  // THE TAB'S OWN POLITE LIVE REGION, mounted once with the tab and never
  // removed. The sheet has its own (see the header): that one is inside the
  // dialog, so a screen reader reads its updates in the dialog's context, and
  // it only exists while the dialog does. Changing LEVEL happens with no sheet
  // open and changes what the whole tab is showing, so it needs a region that
  // outlives any sheet. The two never write at once — selectLevel closes the
  // sheet before it announces.
  const hostLive = document.createElement('div')
  hostLive.className = 'sr-only'
  hostLive.setAttribute('role', 'status')

  host.append(canvas, rail, controls, hostLive)

  const ctx = must2DContext(canvas)

  let destroyed = false
  let rafId: number | null = null

  let tourShots: Shot[] = []
  /** THE LIGHTS HALF OF THE TOUR (2026-09-08). rolo folded the LIGHTS pill into
   *  LEARN and asked for both TARGETS (the shots above) and LIGHTS (the schema-v9
   *  insert groups) to ride the same rotation. `tourShots` is left exactly as it
   *  was — every shot code path (the dots, tap-to-identify, drills, the ALL
   *  level) still reads it and only it — and the light groups live in this
   *  PARALLEL array, appended AFTER the shots in the one combined index space
   *  `itemAt`/`tourLen` walk. Lights are a MAIN-LEVEL affordance only (a zone
   *  level walks that deck's shots and nothing else, the same rule the map's own
   *  `!zone` lit-sites guard follows), so this is empty off the main level. */
  let tourLights: LightGroup[] = []
  /** Which surface the tour is walking: the main playfield, one zone by id, or
   *  LEVEL_ALL (main and every visible deck at once).
   *  SESSION-LOCAL and never persisted — the same rule map2d.ts's own
   *  `mapLevel` follows, and for the same reason: it is view state, not a
   *  preference, and it has no business surviving a tab switch or a reload.
   *  DEFAULT 'main', unchanged by LEVEL v2: ALL is the answer to a question
   *  ("where does this deck sit?"), not the screen you want to land on. */
  let studyLevel: string = 'main'
  let levelShapeKey: string | null = null
  /** The reason lines under the scroller (one per trim-hidden zone), so a
   *  rebuild can drop exactly those and leave the scroller itself — the
   *  element holding the arrows — untouched. */
  let levelReasonEls: HTMLElement[] = []
  let currentIndex = 0
  // 'manual' AT MOUNT: the tour starts paused — see this file's header,
  // "THE TOUR STARTS PAUSED".
  let mode: 'auto' | 'manual' = 'manual'
  let autoStartedAt = performance.now()
  let lastMachineId: string | null = state.machine.id
  /** linkRosterSignature() as of the last syncFromState — remembered, not
   *  recomputed, because by the time a notify reaches this tab `state.trim`
   *  already holds the NEW value. */
  let lastLinkRoster: string = linkRosterSignature()

  let lastShotPoints: { shot: Shot; point: { x: number; y: number } }[] = []
  let lastZoneRects: { zone: PlayfieldZone; rect: Rect }[] = []

  // ---- THE ONE STUDY SHEET (LEARN · ACTION · DRILLS · ALT MODES) ----
  // See this file's header "SHEET-WHILE-STEPPING", and "SHEET SWITCHING"
  // below for why LEARN/ACTION used to be two independent open/close pairs and
  // are now one sheet with a `kind` — which is also why P8 added two more
  // kinds instead of two more sheets.
  //
  // 'shots' IS GONE (2026-08-15). ALL SHOTS was a fifth member of this union
  // until the owner pointed out it and LEARN were one idea; its body is now the
  // lower half of the LEARN body. The union shrinking is the load-bearing part
  // of that merge — a kind nothing can select is a kind that rots.
  type SheetKind = 'learn' | 'action' | 'drills' | 'altmodes' | 'character' | 'howitplays'
  let sheetKind: SheetKind | null = null
  // The lit light group's sites on the map (slice 3b). litSinceMs anchors the
  // pulse + lane-change step clock; litSites is resolved once on select.
  let litGroupId: string | null = null
  let litSinceMs = 0
  let litSites: LitSite[] = []
  let sheetBackdrop: HTMLElement | null = null
  let sheetPanel: HTMLElement | null = null
  let sheetBodyContainer: HTMLElement | null = null
  let sheetBackBtn: HTMLButtonElement | null = null
  let sheetSteps: HTMLElement | null = null
  let sheetStepBtns: HTMLButtonElement[] = []
  /** The sheet's one polite live region — see this file's header. PER
   *  INSTANCE, like every other handle here: two mounted Study tabs (or a
   *  future second call site) must not share one region, or one tab's jump
   *  would be announced out of the other's dialog. */
  let sheetLive: HTMLElement | null = null
  let announceTimer: number | null = null
  let pendingAnnounce: string | null = null
  /** The LEARN sheet's list rows currently on screen, tour-index-aligned, so
   *  moving the ✓ is an edit to two elements rather than a rebuild of the list
   *  (a rebuild would drop a keyboard user's focus AND the list's scroll
   *  position on every jump). Empty for every other kind, and cleared on
   *  close. */
  let indexRows: { row: HTMLElement; check: HTMLElement }[] = []
  /** The upper half of the LEARN body, held so a jump can replace the DETAIL's
   *  children and leave the LIST — its nodes, its focus and its scroll offset
   *  — completely alone. Re-pointed by every buildLearnBodyChildren, dropped on
   *  close. Only ever read while `sheetKind === 'learn'`.
   *
   *  THERE IS NO MATCHING HANDLE ON THE LIST, deliberately: nothing here ever
   *  writes to the list as a whole. Rows are edited through `indexRows` and
   *  scrolled through the row itself (revealCurrentRow), so a second handle
   *  would be state no code path reads. */
  let learnDetailEl: HTMLElement | null = null
  let wasAutoBeforeSheet = false
  let priorFocus: HTMLElement | null = null
  /** data/glossary.json, once it has loaded — the vocabulary prose() links
   *  against. Null until then, and null for good if it fails: the prose then
   *  links this machine's shot names only, which is the fail-soft answer (the
   *  glossary's own sheet already renders "Glossary unavailable" for the same
   *  failure). See the load at the foot of mountStudy and relinkOpenSheet. */
  let glossaryData: GlossaryData | null = null

  /** The lit group's sites as LitSites (UV + insert shape) for the map. Built
   *  once on select; state.shotsByID is a Map, resolveSites wants a record. */
  function resolveGroupLitSites(group: LightGroup): LitSite[] {
    const rec = Object.fromEntries(state.shotsByID) as Record<string, Shot>
    return resolveSites(group, rec, state.trim).map((rs) => ({ u: rs.x, v: rs.y, shape: rs.shape }))
  }

  /** True while a lit group is mid-animation (pulse or lane-change step).
   *  Reduced motion pins the lamps steady, so the loop never runs for them. */
  function lampsAnimating(): boolean {
    if (litGroupId == null || prefersReducedMotion()) return false
    const hip = currentHip()
    if (!hip) return false
    const group = lightGroups(hip).find((g) => g.id === litGroupId)
    if (!group) return false
    return (performance.now() - litSinceMs) / 1000 < animationEndS(group, hip, false)
  }

  /** The rAF should run for the tour's shuffle OR a lamp animation. */
  function wantsLoop(): boolean {
    return (mode === 'auto' && tourLen() > 1) || lampsAnimating()
  }

  /** ONE TOUR, TWO KINDS (2026-09-08). The rotation, the list and the DETAIL
   *  all walk this: a TARGET (a shot) for indices < tourShots.length, then a
   *  LIGHT (an insert group) for the rest. Shots keep their own array and their
   *  own index range at the FRONT, so tapping a dot — which yields a Shot and an
   *  index into tourShots — still lands on the right tour position with no
   *  remap. */
  type TourItem = { kind: 'target'; shot: Shot } | { kind: 'light'; group: LightGroup }
  function tourLen(): number {
    return tourShots.length + tourLights.length
  }
  function itemAt(i: number): TourItem | null {
    if (i < 0 || i >= tourLen()) return null
    return i < tourShots.length
      ? { kind: 'target', shot: tourShots[i]! }
      : { kind: 'light', group: tourLights[i - tourShots.length]! }
  }
  function currentItem(): TourItem | null {
    return itemAt(currentIndex)
  }
  /** The current TARGET shot, or null when the tour is on a LIGHT — which is
   *  exactly what the render's `litShotID` wants (a light lights its sites, not
   *  a single insert) and what onCanvasClick's shot lookup needs. */
  function currentShot(): Shot | null {
    const it = currentItem()
    return it && it.kind === 'target' ? it.shot : null
  }
  /** The tour index of a light group by id, or -1 — the PART OF chips and the
   *  reverse lookups jump through this. Lights sit after the shots. */
  function lightTourIndex(groupId: string): number {
    const j = tourLights.findIndex((g) => g.id === groupId)
    return j === -1 ? -1 : tourShots.length + j
  }
  /** Point the map's lit state at whatever the tour is on now (2026-09-08). A
   *  LIGHT lights its sites and starts the pulse/lane-change clock; a TARGET
   *  clears the group state so the render falls back to the single amber insert
   *  (litShotID). Called on EVERY index change. Cheap-guarded: re-landing on the
   *  same group does not restart its animation (litSinceMs stays put), which is
   *  what keeps a repeated refresh from freezing the pulse at frame zero. */
  function syncLitToCurrent(): void {
    const it = currentItem()
    if (it && it.kind === 'light') {
      // Reset the pulse clock ONLY when the group changes, so re-landing on the
      // same group does not freeze its animation at frame zero. But ALWAYS
      // re-resolve the sites: resolveGroupLitSites is TRIM-dependent (premium-le
      // sites drop on Pro), so a MODEL switch that clamps the tour back onto the
      // same group id would otherwise keep the old model's sites and paint a lamp
      // on a shot the new model has not got (verifier HIGH: Jaws' last light,
      // Premium -> Pro, the Lookout Tower Ramp lamp bled onto the Pro playfield).
      if (litGroupId !== it.group.id) {
        litGroupId = it.group.id
        litSinceMs = performance.now()
      }
      litSites = resolveGroupLitSites(it.group)
    } else if (litGroupId != null) {
      litGroupId = null
      litSites = []
    }
  }

  /** The ONE zone the tour is currently walking, or null on the main playfield
   *  AND on ALL — that level walks the whole machine, so no single zone owns
   *  it, which is exactly what the null tells every caller here (computeTour
   *  builds the full roster; render() takes the stack path before it ever
   *  asks). Resolved against the VISIBLE zones, so a level pointing at a zone
   *  the current MODEL hides reads as main — the drop is applied for real in
   *  refreshLevelControl, this is only the read. */
  function currentZone(): PlayfieldZone | null {
    if (studyLevel === 'main' || studyLevel === LEVEL_ALL) return null
    return machineZones(state.data?.playfields, state.trim).find((z) => z.id === studyLevel) ?? null
  }

  function computeTour(): void {
    const zone = currentZone()
    // A ZONE LEVEL WALKS ONLY THAT ZONE'S SHOTS, in the same top-to-bottom
    // spatial order the main tour uses — buildTour's sort is on the shot's own
    // (x, y), and a deck shot keeps its true flattened main-playfield
    // coordinates (models.ts's PlayfieldZone note), so the order a player sees
    // on the deck matches the order they would meet those shots on the main
    // card. No second sorting rule.
    tourShots = zone
      ? buildTour(zoneMemberShots(state.data?.shots, zone.id, state.trim), state.trim)
      : buildTour(state.data?.shots ?? [], state.trim)
    // LIGHTS RIDE THE PLAIN MAIN LEVEL ONLY. A zone level walks that deck's
    // shots and nothing else, and the ALL level takes render()'s renderAllLevel
    // path, which returns before the lit-sites draw (the `!zone` guard) — so a
    // light in the tour on ALL could never paint. Lights belong to main, which
    // is the launch level, so "both ride the rotation at launch" still holds.
    const hip = studyLevel === 'main' ? currentHip() : null
    tourLights = hip ? lightGroups(hip) : []
  }

  function updateControls(): void {
    const has = tourLen() > 0
    prevBtn.disabled = !has
    nextBtn.disabled = !has
    readout.disabled = !has
    // LEARN is BOTH halves now (the current shot and the list), so one pill
    // dies with the tour where two used to. DRILLS and the rest do not: they
    // are machine-level and stay readable on a MODEL whose shot list happens
    // to be empty.
    learnBtn.disabled = !has
    // The in-sheet ‹ › mirror the bottom bar's, including its disabled state.
    for (const btn of sheetStepBtns) btn.disabled = !has
    if (!has) {
      readoutLabel.textContent = 'NO SHOTS'
      readoutSub.textContent = 'to study on this model'
      return
    }
    // KIND-AWARE READOUT (2026-09-08): the rotation now walks TARGETS then
    // LIGHTS, so a bare "SHOT n of m" would mislabel a lit insert. Each kind
    // counts within its own run — "SHOT 3 OF 20", then "LIGHT 2 OF 7".
    const it = currentItem()
    if (it && it.kind === 'light') {
      readoutLabel.textContent = `LIGHT ${currentIndex - tourShots.length + 1} OF ${tourLights.length}`
    } else {
      readoutLabel.textContent = `SHOT ${currentIndex + 1} OF ${tourShots.length}`
    }
    // SHUFFLE, not AUTO (P4, 2026-08-14). This tab's auto-advance is the
    // SHUFFLE this file's header describes — a wrapping browse carousel
    // through every shot on the machine. The Map tab's readout keeps the word
    // AUTO for a genuinely different thing: marching along the SELECTED
    // GOAL'S ROUTE, in order, one step at a time. Two different behaviours
    // reading as the same word was the bug; the paused half stays
    // 'PAUSED · TAP FOR AUTO' on both because the verb there ("resume the
    // automatic thing") really is the same on either tab.
    readoutSub.textContent = mode === 'auto' ? 'SHUFFLE · TAP TO PAUSE' : 'PAUSED · TAP FOR AUTO'
  }

  function ensureLoop(): void {
    if (destroyed) return
    if (wantsLoop()) {
      if (rafId === null) rafId = requestAnimationFrame(frame)
    } else {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      render(performance.now())
    }
  }

  function frame(nowMs: number): void {
    if (destroyed) return
    if (mode === 'auto' && tourLen() > 1) {
      const elapsedS = (nowMs - autoStartedAt) / 1000
      if (elapsedS >= HIGHLIGHT_HOLD_S) {
        currentIndex = (currentIndex + 1) % tourLen()
        autoStartedAt = nowMs
        // The rotation just stepped onto a new item — if it is a light, light
        // its sites now (and start its pulse), if a target, drop any group.
        syncLitToCurrent()
        updateControls()
      }
    }
    render(nowMs)
    rafId = wantsLoop() ? requestAnimationFrame(frame) : null
  }

  function render(nowMs: number): void {
    if (destroyed) return
    const width = canvas.clientWidth || host.clientWidth
    const height = canvas.clientHeight || host.clientHeight
    if (width <= 0 || height <= 0) return

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = CANVAS_LETTERBOX
    ctx.fillRect(0, 0, width, height)

    const availableHeight = height - BOTTOM_CLEARANCE - TOP_PAD
    if (studyLevel === LEVEL_ALL) {
      renderAllLevel(nowMs, width, availableHeight)
      return
    }
    const zone = currentZone()
    // A ZONE FILLS THE CARD, at its own aspect — the same fit map2d.ts's
    // renderZoneLevel makes, so a deck looks the same on both tabs.
    const zoneAspect = zone && zone.bounds.h > 0 ? zone.bounds.w / zone.bounds.h : undefined
    const rect = zoneAspect ? playfieldRect(width, availableHeight, zoneAspect) : playfieldRect(width, availableHeight)
    rect.y += TOP_PAD / 2
    const map: MapFn = zone
      ? zoneLocalMap(zone, rect)
      : (u, v) => ({ x: rect.x + u * rect.w, y: rect.y + rect.h - v * rect.h })
    publishCardTop(rect.y)

    const playfields = (state.data?.playfields ?? []).filter((z) => isZoneVisible(z, state.trim))
    // tSec 0 under reduced motion freezes drawPlayfieldArt's pop-bumper pulse
    // — the ONE animated thing in this tab's background art. The tour itself
    // keeps advancing (the feature survives, only the motion goes), exactly
    // like the sheet animations above and map2d.ts's own canvas half.
    if (zone) {
      // The zone view's furniture comes from map2d.ts's drawZoneArt — the same
      // function the Shots tab draws its zone level with, floor and bats and
      // edge markers, so the two tabs cannot drift about what a deck looks
      // like. The card chrome around it is still this file's own.
      drawStudyCardChrome(ctx, rect, () => drawZoneArt(ctx, rect, map, zone, state.shotsByID, state.trim))
    } else {
      drawStudyCardBackground(ctx, rect, map, prefersReducedMotion() ? 0 : nowMs / 1000, tourShots, playfields)
    }

    lastShotPoints = tourShots.map((shot) => ({ shot, point: map(shot.x, shot.y) }))
    // ZONE PLATES ARE A MAIN-LEVEL AFFORDANCE. On a zone level the whole card
    // IS the zone, so there is no plate to tap into — and leaving the main
    // level's rects here would hit-test against a card that is no longer
    // drawn at those coordinates.
    lastZoneRects = zone ? [] : playfields.map((z) => ({ zone: z, rect: zoneScreenRect(z, map) }))

    const current = currentShot()
    // `litShotID` (BACKGLASS P5) — the tour's current shot is THE ONE LIT
    // INSERT on this screen (amber halo + amber outline over its own insert
    // shape). Only this tab passes it; see ShotDotsOptions.litShotID for why
    // the Map tab deliberately does not.
    drawShotDots(ctx, tourShots, map, {
      routeShotIDs: current ? new Set([current.id]) : undefined,
      // A selected light group owns the amber this screen: suppress the tour's
      // single lit insert while a group is lit — but ONLY at the main level, where
      // the lamps actually draw (F2: a zone level drew neither, losing all amber).
      litShotID: litGroupId != null && !zone ? null : current?.id ?? null,
      topInset: LABEL_TOP_MARGIN,
      labelBounds: rectXBounds(rect),
    })

    // HOW IT PLAYS / LIGHTS (schema v9): the selected group's sites, lit on the
    // MAIN playfield only — a zone level's map would misplace a main-field site.
    // The pulse breathes; a lane-change group STEPS its lit lamp to show what
    // the flipper buttons do. Reduced motion pins everything bright and steady.
    if (litGroupId != null && !zone && litSites.length > 0) {
      const hipNow = currentHip()
      const litGroup = hipNow ? lightGroups(hipNow).find((g) => g.id === litGroupId) ?? null : null
      const rm = prefersReducedMotion()
      const elapsed = (nowMs - litSinceMs) / 1000
      const glow = glowAt(elapsed, rm)
      const only = litGroup && hipNow && isLaneChangeDemo(litGroup, hipNow) ? stepAt(elapsed, demoSiteCount(litGroup), rm) : null
      drawLitSites(ctx, litSites, map, { glow, only })
    }

    if (current) {
      // Nothing floats over this canvas any more, so the only thing the label
      // has to clear is the canvas's own top edge — see LABEL_TOP_MARGIN.
      drawCurrentLabel(ctx, current, map(current.x, current.y), LABEL_TOP_MARGIN, rect)
    }
  }

  /** The map for one stack card — the main mapping for the main card, and
   *  zoneLocalMap for a deck, exactly what the single-card levels use. Kept as
   *  one helper so "which mapping does this surface get" has one answer on
   *  every level. */
  function cardMap(card: StackCard): MapFn {
    const { rect } = card
    if (card.zone) return zoneLocalMap(card.zone, rect)
    return (u, v) => ({ x: rect.x + u * rect.w, y: rect.y + rect.h - v * rect.h })
  }

  /** THE COMBINED LEVEL (LEVEL v2, 2026-08-15) — every visible surface on one
   *  canvas, each as its own true-aspect card, decks above the main card and
   *  `kind:'lower'` windows below it. computeStackRects (above) owns the
   *  geometry; this owns what is painted into it.
   *
   *  THE TOUR IS THE WHOLE MACHINE HERE, not one surface — the same roster
   *  MAIN walks (computeTour). What changes is WHERE each shot lands: a shot
   *  that names a visible zone is drawn on THAT zone's card, through
   *  zoneLocalMap, instead of flattened onto the main card at its true (x, y).
   *  So the ‹ › walk crosses cards mid-tour, which is the point — you watch the
   *  tour leave the table and arrive on the deck.
   *
   *  THE MAIN CARD STILL PAINTS THE ZONE PLATES. A deck having its own card
   *  does not stop it from having a footprint on the table, and that outline is
   *  the only thing tying the two cards together spatially — drop it and the
   *  stack is two unrelated pictures. drawPlayfieldArt draws them from the same
   *  `playfields` array the single-card MAIN level passes.
   *
   *  ONE routeShotIDs SET FOR EVERY CARD, including the cards the current shot
   *  is not on. drawShotDots' declutter rule keys off that set being NON-EMPTY
   *  (map2d.ts's t14 note) to suppress ambient labels; passing `undefined` to
   *  the other cards would let them each shout every shot name they hold, which
   *  is the exact opposite of this tab's one-name-at-a-time contract. */
  function renderAllLevel(nowMs: number, width: number, availableHeight: number): void {
    const playfields = (state.data?.playfields ?? []).filter((z) => isZoneVisible(z, state.trim))
    const stack = computeStackRects(width, availableHeight, playfields)
    if (stack.length === 0) {
      // Nothing laid out (a collapsed canvas). Draw nothing rather than
      // guessing — the next resize will have a real box.
      lastShotPoints = []
      lastZoneRects = []
      return
    }
    for (const card of stack) card.rect.y += TOP_PAD / 2
    publishCardTop(stack[0]!.rect.y)

    const zoneIds = new Set(playfields.map((z) => z.id))
    const current = currentShot()
    const routeShotIDs = current ? new Set([current.id]) : undefined
    const tSec = prefersReducedMotion() ? 0 : nowMs / 1000

    lastShotPoints = []
    for (const card of stack) {
      const map = cardMap(card)
      const shots = card.zone
        ? tourShots.filter((s) => s.playfield === card.zone!.id)
        : tourShots.filter((s) => !s.playfield || !zoneIds.has(s.playfield))
      if (card.zone) {
        drawStudyCardChrome(ctx, card.rect, () => drawZoneArt(ctx, card.rect, map, card.zone!, state.shotsByID, state.trim))
      } else {
        drawStudyCardBackground(ctx, card.rect, map, tSec, shots, playfields)
      }
      drawShotDots(ctx, shots, map, {
        routeShotIDs,
        litShotID: current?.id ?? null,
        topInset: LABEL_TOP_MARGIN,
        // PER CARD, which is the whole reason rectXBounds exists: cardXBounds
        // would ask a zone map where u = 0 and u = 1 land and get a range four
        // times the card (the "Ship's Wheel Spinner" clip, section ac).
        labelBounds: rectXBounds(card.rect),
      })
      for (const shot of shots) lastShotPoints.push({ shot, point: map(shot.x, shot.y) })
    }

    // The plates on the MAIN card stay the tap target, exactly as on the MAIN
    // level. A deck CARD is not one: its own dots are already tappable, and
    // making its whole background jump the tour would give a deck card an
    // affordance the main card deliberately does not have.
    const mainCard = stack.find((c) => c.zone === null)
    lastZoneRects = mainCard ? playfields.map((z) => ({ zone: z, rect: zoneScreenRect(z, cardMap(mainCard)) })) : []

    if (current) {
      const home = stack.find((c) => (c.zone ? c.zone.id === current.playfield : !current.playfield || !zoneIds.has(current.playfield)))
      if (home) drawCurrentLabel(ctx, current, cardMap(home)(current.x, current.y), LABEL_TOP_MARGIN, home.rect)
    }
  }

  /** THE CARD'S DRAWN TOP EDGE, published to CSS (owner, 2026-08-14: "Move
   *  the buttons down in the study tab so that the top of the first button
   *  aligns with the top of the playfield. Right now buttons are above the
   *  playfield.").
   *
   *  The rail is a flex column with a fixed padding-top; the CARD is centred
   *  vertically in the canvas column by playfieldRect, so its top edge is a
   *  number only the draw path knows — 38px on a viewport where the card is
   *  height-limited, ~97px on a tall phone where it is width-limited and the
   *  leftover height splits above and below. No static padding can track
   *  that, so the draw path hands it to CSS and `.study-rail`'s padding-top
   *  reads it. Same per-instance custom-property idiom app.ts uses for
   *  `--catglow` (a value only JS can know, consumed by a rule that cannot
   *  compute it).
   *
   *  SNAPPED TO DEVICE PIXELS, because the whole request is that two edges
   *  line up: a CSS px offset that lands on a half device-pixel renders the
   *  pill's top edge one physical row off the card's, which on a 3x phone is
   *  exactly the kind of "not quite aligned" that prompted this.
   *
   *  Written only when it CHANGES. render() runs every frame while the tour
   *  is shuffling, and setting a custom property invalidates style for the
   *  subtree — doing that 60 times a second to write the same number would
   *  put a style recalc in every frame of an animation that is otherwise
   *  pure canvas. */
  let lastPublishedCardTop: number | null = null
  /** Says something in the tab's live region. Level changes only — the tour's
   *  own position is announced inside the sheet, where the reader is. */
  function announce(text: string): void {
    hostLive.textContent = text
  }

  function publishCardTop(y: number): void {
    const dpr = window.devicePixelRatio || 1
    const snapped = Math.round(y * dpr) / dpr
    if (snapped === lastPublishedCardTop) return
    lastPublishedCardTop = snapped
    host.style.setProperty('--study-card-top', `${snapped}px`)
  }

  function jumpTo(index: number): void {
    if (index < 0 || index >= tourLen()) return
    currentIndex = index
    mode = 'manual'
    syncLitToCurrent()
    ensureLoop()
    updateControls()
    refreshSheetForTour()
  }

  function stepManual(dir: 1 | -1): void {
    if (tourLen() === 0) return
    currentIndex = (currentIndex + dir + tourLen()) % tourLen()
    mode = 'manual'
    syncLitToCurrent()
    ensureLoop()
    updateControls()
    refreshSheetForTour()
  }

  /** The tour moved (‹ ›, a list row, a tap on the field) — bring an OPEN
   *  sheet along with it, if its content depends on where the tour is. ONE of
   *  the four kinds does; ACTION BUTTON, DRILLS and ALT MODES are machine-level
   *  and deliberately sit still.
   *
   *  THREE EDITS, ONE MOVE, and they are deliberately three rather than one
   *  rebuild: the detail's children are replaced, the ✓/aria-current marks hop
   *  to the new row, and the list scrolls only if that row was off-screen.
   *  Everything else in the sheet — every row element, the list's scroll
   *  offset, whatever holds focus — is untouched. See renderLearnDetail. */
  function refreshSheetForTour(): void {
    if (sheetKind === 'learn') {
      renderLearnDetail()
      markIndexRows()
      revealCurrentRow()
    }
    announceTour()
  }

  /** Writes the tour's new position into the sheet's polite live region —
   *  see this file's header for why the announcement exists and why the
   *  region lives on the panel. No-ops when no sheet is open: the readout bar
   *  is visible then, and the canvas has its own announcement story.
   *
   *  LEADING-EDGE, THEN COALESCED (P8 review). A single move announces
   *  IMMEDIATELY — a deliberate tap or ‹ › press must not feel like it is
   *  waiting for anything, and delaying the common case to protect against
   *  the rare one is the wrong trade. A BURST (holding ›, or an autorepeating
   *  key) then collapses: every write inside ANNOUNCE_WINDOW_MS after the
   *  first is folded into one trailing write carrying the LAST position, so a
   *  screen reader reads "shot 3" and then "shot 11", not all nine in
   *  between. Politeness alone would not do this — a polite region still
   *  queues every distinct value it is given.
   *
   *  The timer is the only one in this file, and P5 deleted the last one for
   *  racing in four directions, so it is owned in exactly one place:
   *  cancelAnnounce() is called from closeStudySheet and from destroy(), and
   *  the callback re-checks `sheetLive` because the sheet can close between
   *  scheduling and firing. There is nothing else for it to race with — it
   *  touches one text node and no layout, no focus and no DOM structure. */
  function announceTour(): void {
    if (!sheetLive) return
    const it = currentItem()
    if (!it) return
    // Sentence case, not the readout's shouted 'SHOT 4 OF 6' — this string is
    // never rendered, it is spoken, and screen readers spell out or shout
    // all-caps runs depending on the voice. Kind-aware like the readout.
    const text =
      it.kind === 'light'
        ? `Light ${currentIndex - tourShots.length + 1} of ${tourLights.length} — ${it.group.name}`
        : `Shot ${currentIndex + 1} of ${tourShots.length} — ${it.shot.name}`
    if (announceTimer === null) {
      // Leading edge: say it now, and open the window.
      sheetLive.textContent = text
      pendingAnnounce = null
      announceTimer = window.setTimeout(flushAnnounce, ANNOUNCE_WINDOW_MS)
      return
    }
    // Inside the window: remember only the newest. No second timer — the
    // window is a fixed slice from the FIRST write, not a debounce that a
    // long-enough burst could postpone for ever.
    pendingAnnounce = text
  }

  /** End of a coalescing window.
   *
   *  Speaks whatever the last position was, then opens ONE more window. The
   *  re-arm is what holds a sustained burst (a held ›) to exactly one
   *  announcement per window: without it the move immediately after a flush
   *  would take the leading edge and speak at once, so a long hold would
   *  alternate leading/trailing writes and roughly double the traffic.
   *
   *  The cost is one idle timer for at most one window after the tour goes
   *  quiet — that final flush finds nothing pending and does NOT re-arm, so
   *  the chain always terminates on its own. closeStudySheet and destroy()
   *  cancel it either way, which is what keeps it from ever firing against a
   *  detached region. */
  function flushAnnounce(): void {
    announceTimer = null
    if (pendingAnnounce === null) return
    if (sheetLive) sheetLive.textContent = pendingAnnounce
    pendingAnnounce = null
    announceTimer = window.setTimeout(flushAnnounce, ANNOUNCE_WINDOW_MS)
  }

  function cancelAnnounce(): void {
    if (announceTimer !== null) window.clearTimeout(announceTimer)
    announceTimer = null
    pendingAnnounce = null
  }
  prevBtn.addEventListener('click', () => stepManual(-1))
  nextBtn.addEventListener('click', () => stepManual(1))
  readout.addEventListener('click', () => {
    if (tourLen() === 0) return
    mode = mode === 'auto' ? 'manual' : 'auto'
    if (mode === 'auto') autoStartedAt = performance.now()
    ensureLoop()
    updateControls()
  })

  // ---- Tap-to-inspect (dots, then zone plates) — see this file's header. ----
  function onCanvasClick(ev: MouseEvent): void {
    if (destroyed || sheetKind !== null) return // the exposed-field backdrop owns taps while a sheet is open
    const rect = canvas.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top

    // BEST *SHOT*, NOT BEST INDEX (LEVEL v2, 2026-08-15, found by
    // tests/study.test.mjs section ae). `lastShotPoints` used to be
    // `tourShots.map(...)`, so its index and the tour's were the same number
    // and this loop could hand its own `i` straight to jumpTo. The ALL level
    // fills that array in CARD order — every deck's shots, then the main
    // playfield's, then every lower window's — which is not tour order, so the
    // old code jumped to whatever shot happened to occupy that slot in the
    // walk: tapping the lower card's only insert landed on the last shot of
    // the main playfield. The identity of the thing tapped is the shot, so
    // that is what is carried out of the loop.
    let best: Shot | null = null
    let bestDist = HIT_RADIUS
    for (let i = 0; i < lastShotPoints.length; i++) {
      const entry = lastShotPoints[i]!
      // SHAPE-AWARE (P8, adopting map2d.ts's insertHitDistance): distance to
      // the insert the user can actually SEE, not to a centre point that a
      // ring or a wide bar draws nothing at. Zero inside the shape, so a tap
      // that lands ON something always beats a neighbour whose centre happens
      // to be marginally closer. This is the identical rule the Shots tab's
      // own tap-to-identify uses — a shot that is tappable there and not here
      // was exactly the inconsistency the shared helper exists to prevent.
      const d = insertHitDistance(insertShapeFor(entry.shot.type), entry.point, INSERT_DRAW_RADIUS, x, y)
      if (d <= bestDist) {
        bestDist = d
        best = entry.shot
      }
    }
    if (best) {
      jumpTo(tourShots.indexOf(best))
      return
    }

    for (const { zone, rect: zr } of lastZoneRects) {
      if (x < zr.x || x > zr.x + zr.w || y < zr.y || y > zr.y + zr.h) continue
      const idx = tourShots.findIndex((s) => s.playfield === zone.id)
      if (idx !== -1) jumpTo(idx)
      return
    }
  }
  canvas.addEventListener('click', onCanvasClick)

  // ---- LEARN sheet: the current shot's DETAIL, over the whole tour's LIST --
  /** The upper half — what THIS shot is. Was the entire LEARN body until the
   *  merge (2026-08-15); it is now the part that swaps as the tour moves,
   *  while the list below it holds still. */
  /** The first goal whose route touches this shot, or null — the target
   *  detail's "see it on the playfield" picks one so the Shots tab has a route
   *  to draw. */
  function goalForShot(shotId: string): Goal | null {
    return (state.data?.goals ?? []).find((g) => (g.steps ?? []).some((s) => s.shot === shotId)) ?? null
  }
  /** The first resolvable goal in a light group's authored list, or null. */
  function goalForGroup(group: LightGroup): Goal | null {
    const goals = state.data?.goals ?? []
    for (const id of group.goals ?? []) {
      const g = goals.find((x) => x.id === id)
      if (g) return g
    }
    return null
  }
  /** THE SHOTS-TAB DOOR (2026-09-08, rolo: "a link to visually seeing the shot
   *  on the other tab... performed on the playfield"). Every LEARN detail —
   *  target or light — offers it, and it hands the visitor to the Shots tab
   *  with a goal SELECTED so its route draws and animates over the schematic.
   *  No goal to show, or no bridge wired by the host, means NO button: a dead
   *  link is worse than none, the same rule goalChip follows. */
  function shotsTabLink(goal: Goal | null): HTMLElement | null {
    if (!showGoalOnShots || !goal) return null
    const target = goal
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'study-hip-crosslink study-shots-link'
    btn.textContent = 'See it on the playfield ›'
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation?.()
      showGoalOnShots!(target)
    })
    return btn
  }

  function buildShotDetailChildren(shot: Shot): HTMLElement[] {
    const title = document.createElement('div')
    title.className = 'study-learn-title'
    title.id = 'study-learn-title'
    title.textContent = shot.name

    const chips = document.createElement('div')
    chips.className = 'study-learn-chips'
    const typeChip = document.createElement('span')
    typeChip.className = 'study-learn-chip'
    typeChip.textContent = (shot.type || '').toUpperCase().replace(/-/g, ' ') || 'SHOT'
    chips.appendChild(typeChip)
    const deckLabel = deckLabelFor(shot, state.data?.playfields ?? [])
    if (deckLabel) {
      const deckChip = document.createElement('span')
      deckChip.className = 'study-learn-chip'
      deckChip.textContent = deckLabel
      chips.appendChild(deckChip)
    }
    if (shot.trim === 'premium-le') {
      const trimChip = document.createElement('span')
      trimChip.className = 'study-learn-chip study-learn-chip-trim'
      trimChip.textContent = 'PREM/LE'
      chips.appendChild(trimChip)
    }

    // Linked prose (2026-10-14) when there ARE notes; the placeholder is the
    // app's own sentence, not dataset prose, and stays plain.
    const hasNotes = !!shot.notes && shot.notes.trim().length > 0
    const notes = hasNotes ? prose('p', 'study-learn-notes', shot.notes!) : el('p', 'study-learn-notes', 'No notes yet for this shot.')

    const out: HTMLElement[] = [title, chips, notes]

    // PART OF: the light groups this shot belongs to (schema v9). The reverse
    // index from ./lights. Since the LIGHTS pill folded into LEARN (2026-09-08),
    // each chip JUMPS THE TOUR to that light item — same sheet, and the map
    // relights on the group — instead of opening a separate sheet.
    const hip = currentHip()
    const partIds = hip ? groupsForShot(shot.id, hip) : []
    if (partIds.length > 0) {
      const partOf = el('div', 'study-hip-partof')
      partOf.appendChild(el('span', 'study-hip-partof-label', 'PART OF'))
      const groups = lightGroups(hip!)
      for (const gid of partIds.slice(0, 3)) {
        const g = groups.find((x) => x.id === gid)
        if (!g) continue
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'study-hip-partof-chip'
        chip.textContent = g.name
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation?.()
          const idx = lightTourIndex(gid)
          if (idx !== -1) jumpTo(idx)
        })
        partOf.appendChild(chip)
      }
      out.push(partOf)
    }

    const link = shotsTabLink(goalForShot(shot.id))
    if (link) out.push(link)
    return out
  }

  /** THE LIGHT DETAIL (2026-09-08) — the upper half when the tour is on a LIGHT.
   *  Same title id as the shot detail so the panel's aria-labelledby resolves
   *  either way, then the group's KIND, its LIT / FLASHING / CONTROL / THEN
   *  language (the LIGHTS pill's old row body), its goal chips, and the Shots-tab
   *  door. The map is already lit on this group (syncLitToCurrent). */
  function buildLightDetailChildren(group: LightGroup): HTMLElement[] {
    const title = document.createElement('div')
    title.className = 'study-learn-title'
    title.id = 'study-learn-title'
    title.textContent = group.name

    const chips = el('div', 'study-learn-chips')
    chips.appendChild(el('span', 'study-learn-chip study-light-kind', (group.kind || '').toUpperCase().replace(/-/g, ' ')))

    const out: HTMLElement[] = [title, chips]
    const kv = (label: string, value: string) => {
      const pair = el('div', 'study-light-kv')
      pair.appendChild(el('span', 'study-light-kv-label', label))
      // The VALUE is the prose (linked, 2026-10-14); the LIT/THEN label is not.
      pair.appendChild(prose('span', 'study-light-kv-value', value))
      out.push(pair)
    }
    kv('LIT', group.lit)
    if (group.flashing) kv('FLASHING', group.flashing)
    const ctrl = controlLine(group.control)
    if (ctrl) kv('CONTROL', ctrl)
    kv('THEN', group.then)
    const goalChips = goalChipRow(group.goals)
    if (goalChips) out.push(goalChips)
    const link = shotsTabLink(goalForGroup(group))
    if (link) out.push(link)
    return out
  }

  // ---- The tour as a list (P8's ALL SHOTS body; LEARN's lower half since
  //      2026-08-15) ----
  /** The tour, as a list, in the SAME order the ‹ › walk uses — so it doubles
   *  as the legend for the dots on the field behind it. Rows are real 44px
   *  buttons; tapping one jumps the tour and LEAVES THE SHEET OPEN (this tab's
   *  backdrop is transparent on purpose, so the map stays readable while you
   *  hop from shot to shot).
   *
   *  IT IS THE SCOPED TOUR, not the machine's whole roster: `tourShots` is
   *  whatever the LEVEL control is walking, so on a zone level these are that
   *  deck's shots and on ALL they are the whole machine. Built from the same
   *  array the ‹ › walk reads, which is why the two cannot disagree. */
  /** One index row (✓ cell · name · type), a real 44px button wired to jump to
   *  a tour position. Shared by the TARGETS and LIGHTS sections (2026-09-08) so
   *  both look and behave the same and both land in the single `indexRows`
   *  array, aligned to the combined tour index. The fixed-width ✓ cell rides
   *  EVERY row (the .goal-row-check convention) so the mark moving does not
   *  shift a name by its own width. */
  function buildIndexRow(name: string, typeLabel: string, tourIdx: number): HTMLElement {
    const li = document.createElement('li')
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'study-index-row'
    const check = document.createElement('span')
    check.className = 'study-index-check'
    check.setAttribute('aria-hidden', 'true')
    const nameEl = document.createElement('span')
    nameEl.className = 'study-index-name'
    nameEl.textContent = name
    const type = document.createElement('span')
    type.className = 'study-index-type'
    type.textContent = typeLabel
    row.append(check, nameEl, type)
    row.addEventListener('click', () => jumpTo(tourIdx))
    li.appendChild(row)
    indexRows.push({ row, check })
    return li
  }

  /** The TARGETS list — the physical shots, tour indices 0..tourShots.length-1.
   *  Rows tap to jump and LEAVE THE SHEET OPEN (the backdrop is transparent so
   *  the map stays readable). It is the SCOPED tour, so on a zone level these
   *  are that deck's shots. Appends to the shared `indexRows`; the caller
   *  resets it. */
  function buildTargetsList(): HTMLElement {
    const list = document.createElement('ul')
    list.className = 'study-index-list'
    list.setAttribute('aria-labelledby', 'study-learn-targets-title')
    tourShots.forEach((shot, i) => {
      list.appendChild(buildIndexRow(shot.name, (shot.type || '').toUpperCase().replace(/-/g, ' ') || 'SHOT', i))
    })
    return list
  }

  /** The LIGHTS list — the schema-v9 insert groups, at the tour indices AFTER
   *  the shots. Distinguished from targets by its own heading (rolo). */
  function buildLightsList(): HTMLElement {
    const list = document.createElement('ul')
    list.className = 'study-index-list'
    list.setAttribute('aria-labelledby', 'study-learn-lights-title')
    tourLights.forEach((group, j) => {
      list.appendChild(buildIndexRow(group.name, (group.kind || '').toUpperCase().replace(/-/g, ' '), tourShots.length + j))
    })
    return list
  }

  /** THE COMBINED LEARN BODY (2026-08-15; LIGHTS folded in 2026-09-08) — the
   *  current item's DETAIL over the tour's LIST, and the list is now two
   *  labelled sections, TARGETS then LIGHTS, sharing one index space. The detail
   *  swaps as the tour moves (target detail or light detail); the two headings
   *  sit BETWEEN the scroll regions (the 2026-08-15 note: inside the list a
   *  heading scrolled away and rendered half-cut). `learnDetailEl` and
   *  `indexRows` are taken here and nowhere else; the two section builders fill
   *  `indexRows` in tour order, so markIndexRows lands the ✓ in one pass. */
  function buildLearnBodyChildren(): HTMLElement[] {
    const it = currentItem()
    const detail = document.createElement('div')
    detail.className = 'study-learn-detail'
    if (it) detail.append(...(it.kind === 'light' ? buildLightDetailChildren(it.group) : buildShotDetailChildren(it.shot)))
    learnDetailEl = detail

    indexRows = []

    const targetsHeading = el('div', 'study-learn-list-title', 'TARGETS')
    targetsHeading.id = 'study-learn-targets-title'
    const targetsWrap = el('div', 'study-learn-list')
    targetsWrap.append(buildTargetsList())

    const out: HTMLElement[] = [detail, targetsHeading, targetsWrap]

    // LIGHTS — the insert groups, plainly distinguished from the targets. Only
    // when the machine authored them, and only on the main level (computeTour
    // leaves tourLights empty off it).
    if (tourLights.length > 0) {
      const lightsHeading = el('div', 'study-learn-list-title study-learn-list-title-lights', 'LIGHTS')
      lightsHeading.id = 'study-learn-lights-title'
      const lightsWrap = el('div', 'study-learn-list')
      lightsWrap.append(buildLightsList())
      out.push(lightsHeading, lightsWrap)
    }

    markIndexRows()
    return out
  }

  /** Moves the ✓ (and the row's own lit treatment) to wherever the tour is
   *  now. Deliberately an EDIT, never a rebuild: a row can hold focus — it is
   *  a real button — and replacing the list under a keyboard user drops them
   *  to <body>, outside the sheet, which is the exact stranding swapSheetBody
   *  re-homes against. Writing `className` rather than classList so the fake
   *  DOM this app's suites drive the real module with sees it too. */
  function markIndexRows(): void {
    for (let i = 0; i < indexRows.length; i++) {
      const { row, check } = indexRows[i]!
      const isCurrent = i === currentIndex
      row.className = isCurrent ? 'study-index-row study-index-row-current' : 'study-index-row'
      // 'false', not a removeAttribute: aria-current="false" is the spec's own
      // way to say "not the current item" and needs no attribute removal.
      row.setAttribute('aria-current', isCurrent ? 'true' : 'false')
      check.textContent = isCurrent ? '✓' : ''
    }
  }

  // ---- DRILLS (P8) ----
  /** Tour index of the first shot this drill names that the CURRENT MODEL
   *  actually shows, or -1. Fail-soft by design, the same discipline
   *  deckLabelFor uses: a drill may name a shot that is Premium/LE-only (the
   *  Jaws Orca-deck drill does), and on a Pro machine that shot is not on the
   *  field, not in the tour, and must not be offered as somewhere to jump. */
  function drillTourIndex(drill: Drill): number {
    for (const id of drill.shots ?? []) {
      const idx = tourShots.findIndex((s) => s.id === id)
      if (idx !== -1) return idx
    }
    return -1
  }

  /** One drill card. Logic COPIED (not imported) from ui/machinecard.ts's
   *  renderPracticeSection/renderDrillRow — see this file's header for why
   *  that dead module must stay unimported. Two deliberate differences from
   *  the Card version: `focus` renders as a chip here (the Card never showed
   *  it at all), and the tappable target is the SHOT, not the goal — the goal
   *  bridge is the follow-up hook noted in the header. */
  function buildDrillCard(drill: Drill): HTMLElement {
    const card = document.createElement('li')
    card.className = 'study-drill'

    const title = document.createElement('div')
    title.className = 'study-drill-title'
    title.textContent = drill.title
    card.appendChild(title)

    const text = document.createElement('p')
    text.className = 'study-drill-text'
    text.textContent = drill.text
    card.appendChild(text)

    // `reps` is prose on purpose (models.ts's Drill) — "20", "5 chains — note
    // your longest", "3-hit sets x5" — so it is a LINE with a label, not a
    // chip that would have to fit an unknown sentence into a pill.
    if (drill.reps && drill.reps.trim().length > 0) {
      const reps = document.createElement('div')
      reps.className = 'study-drill-reps'
      reps.textContent = `REPS · ${drill.reps}`
      card.appendChild(reps)
    }

    if (drill.focus && drill.focus.trim().length > 0) {
      const chips = document.createElement('div')
      chips.className = 'study-learn-chips'
      const chip = document.createElement('span')
      // Rides the LEARN sheet's neutral chip recipe — see this file's header
      // for why there is no per-category colouring to apply.
      chip.className = 'study-learn-chip study-drill-focus'
      chip.textContent = drill.focus
      chips.appendChild(chip)
      card.appendChild(chips)
    }

    const idx = drillTourIndex(drill)
    if (idx !== -1) {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'study-drill-link'
      const label = document.createElement('span')
      // NAMES the shot rather than saying "this shot": a drill's `shots[]` can
      // list several, and this jumps to exactly one of them (the first the
      // current MODEL shows), so the button has to say which.
      label.textContent = `Study ${tourShots[idx]!.name}`
      const chevron = document.createElement('span')
      chevron.setAttribute('aria-hidden', 'true')
      chevron.textContent = '›'
      link.append(label, chevron)
      // Same contract as an ALL SHOTS row: jump the tour, leave the sheet
      // open. The map is live behind it.
      link.addEventListener('click', () => jumpTo(idx))
      card.appendChild(link)
    }

    return card
  }

  function buildDrillsBodyChildren(drills: readonly Drill[]): HTMLElement[] {
    const title = document.createElement('h2')
    title.className = 'study-learn-title'
    title.id = 'study-drills-title'
    title.textContent = 'Practice Drills'

    const list = document.createElement('ul')
    list.className = 'study-drill-list'
    for (const drill of drills) list.appendChild(buildDrillCard(drill))

    return [title, list]
  }

  // ---- ALT MODES (dataset schema v7, 2026-08-14) ----
  /** One flagged goal, as a card. Owner: "there are video game modes… that
   *  should be its own button and info in study mode."
   *
   *  THE HOW LINES come from whichever half of the goal is authored, and the
   *  branch is isPathless — models.ts's INVARIANT is that a goal is pathless
   *  iff `steps` is empty, and that the two are never both populated. So a
   *  menu ("hold both flippers in attract mode") reads its `instructions`, and
   *  a ROUTED video mode reads its steps' `action` lines: Attack from Mars'
   *  video mode is two steps — collect Stroke of Luck, then shoot the saucers
   *  with the Launch button — and a card that showed only the summary would
   *  drop the half that says how to start it. Rendering the shot ids would be
   *  the wrong reuse here: this sheet is not a route, and the Map tab already
   *  draws that.
   *
   *  NO JUMP AFFORDANCE, unlike a drill's "Study <shot> ›". A drill names ONE
   *  shot to go and stand at; an alt mode is a whole game, and the Study tour
   *  is a walk of the playfield — the surface it would jump to is the one
   *  place this content is NOT about. */
  function buildAltModeCard(goal: Goal): HTMLElement {
    const card = document.createElement('li')
    card.className = 'study-altmode'

    const title = document.createElement('div')
    title.className = 'study-altmode-title'
    title.textContent = goal.title
    card.appendChild(title)

    const chips = document.createElement('div')
    chips.className = 'study-learn-chips'
    const chip = document.createElement('span')
    // Rides the LEARN sheet's chip recipe with one modifier for the amber
    // outline — the same relationship `.study-drill-focus` has to it, so the
    // three chip surfaces in this panel stay one recipe (P8's own finding:
    // three hand-copies of one chip disagreed about font-size).
    chip.className = 'study-learn-chip study-altmode-chip'
    chip.textContent = ALT_MODE_LABEL[goal.altMode as AltMode]
    chips.appendChild(chip)
    card.appendChild(chips)

    const summary = document.createElement('p')
    summary.className = 'study-altmode-summary'
    summary.textContent = goal.summary
    card.appendChild(summary)

    const how = isPathless(goal) ? instructionsFor(goal) : goal.steps.map((s) => s.action)
    if (how.length > 0) {
      const list = document.createElement('ol')
      list.className = 'study-altmode-how'
      for (const line of how) {
        const li = document.createElement('li')
        li.textContent = line
        list.appendChild(li)
      }
      card.appendChild(list)
    }

    // Reward is optional in the dataset and empty on plenty of goals — a
    // labelled line only when there is something to label, never an empty
    // 'REWARD ·'.
    if (goal.reward && goal.reward.trim().length > 0) {
      const reward = document.createElement('div')
      reward.className = 'study-altmode-reward'
      reward.textContent = `REWARD · ${goal.reward}`
      card.appendChild(reward)
    }

    return card
  }

  function buildAltModesBodyChildren(goals: readonly Goal[]): HTMLElement[] {
    const title = document.createElement('h2')
    title.className = 'study-learn-title'
    title.id = 'study-altmodes-title'
    title.textContent = 'Alt Modes'

    const list = document.createElement('ul')
    list.className = 'study-altmode-list'
    for (const goal of goals) list.appendChild(buildAltModeCard(goal))

    return [title, list]
  }

  // ---- CHARACTER (2026-08-15) ----
  /** One character/progression goal, as a card: what this system IS (the
   *  goal's own summary) over what its pieces MEAN AND DO (its instruction
   *  lines, verbatim).
   *
   *  VERBATIM IS THE FEATURE. These lines are the only place in the app where
   *  "Anya, the halfling rogue, carries more luck, which makes rarer items turn
   *  up in treasure more often" exists — they are prose ABOUT A CHOICE, which
   *  is precisely the shape no route drawing can carry. So nothing here
   *  truncates, re-orders, re-sentences or summarises them; the card is a
   *  frame around the dataset's own words.
   *
   *  A <ul>, NOT the <ol> ALT MODES uses, and the difference is measured
   *  rather than stylistic. An alt mode's how-lines are a PROCEDURE (hold both
   *  flippers, then choose a mode; collect the award, then shoot the ramp) and
   *  a number per line is true. A character goal's lines are an INVENTORY —
   *  jaws' six gear pieces and what each one buys, venom's five shots and what
   *  each one is for, tmnt's per-turtle level effects — where "3." would assert
   *  a sequence the data does not have. (The Goals tab renders the same field
   *  as an <ol> for every pathless goal; that surface is untouched by this
   *  pass and its choice is noted here rather than quietly contradicted.)
   *
   *  DIFFICULTY IS SHOWN, unlike on an alt-mode card, and it earns its place
   *  here: this sheet is the ONLY screen that renders these goals as goals, so
   *  the one comparative fact the dataset carries about them would otherwise be
   *  reachable only by going back to the Goals tab. pipsTextWithEmpty (●●○) is
   *  the same three-slot format the Shots tab's own goal rows use, so a pip
   *  count means the same thing on both surfaces — and the glyphs carry an
   *  aria-label, because "●●○" read aloud is three circles.
   *
   *  NO JUMP AFFORDANCE, for buildAltModeCard's reason: the Study tour is a
   *  walk of the playfield, and the playfield is the one place this content is
   *  not about. */
  function buildCharacterCard(goal: Goal): HTMLElement {
    const card = document.createElement('li')
    card.className = 'study-character'

    const title = document.createElement('div')
    title.className = 'study-character-title'
    title.textContent = goal.title
    card.appendChild(title)

    const pips = document.createElement('div')
    pips.className = 'study-character-pips'
    const d = clampDifficulty(goal.difficulty)
    pips.textContent = pipsTextWithEmpty(goal.difficulty)
    pips.setAttribute('aria-label', `Difficulty ${d} of 3`)
    card.appendChild(pips)

    const summary = document.createElement('p')
    summary.className = 'study-character-summary'
    summary.textContent = goal.summary
    card.appendChild(summary)

    // instructionsFor, not `goal.instructions` — it is the shared reader for
    // this field and it enforces models.ts's own invariant (a goal is pathless
    // iff `steps` is empty), so a dataset that somehow carried both would get
    // the same answer here as everywhere else instead of a private opinion.
    // Every goal that reaches this card is pathless by construction (the
    // predicate that selected it says so), so this returns the authored lines.
    const lines = instructionsFor(goal)
    if (lines.length > 0) {
      const list = document.createElement('ul')
      list.className = 'study-character-how'
      for (const line of lines) {
        const li = document.createElement('li')
        li.textContent = line
        list.appendChild(li)
      }
      card.appendChild(list)
    }

    // Optional in the dataset — a labelled line only when there is something to
    // label, never an empty 'REWARD ·'. Same rule as the alt-mode card.
    if (goal.reward && goal.reward.trim().length > 0) {
      const reward = document.createElement('div')
      reward.className = 'study-character-reward'
      reward.textContent = `REWARD · ${goal.reward}`
      card.appendChild(reward)
    }

    return card
  }

  function buildCharacterBodyChildren(goals: readonly Goal[]): HTMLElement[] {
    const title = document.createElement('h2')
    title.className = 'study-learn-title'
    // PLURAL id against a SINGULAR card class (`.study-character-title`), the
    // same split ALT MODES already carries (`study-altmodes-title` for the
    // heading, `.study-altmode-title` per card). It is not cosmetic: one string
    // for both would make "find the character title" ambiguous for anything
    // that walks this tree — a test, a screen reader's heading list, or the
    // next person reading it — and the heading names the COLLECTION while the
    // card names ONE system.
    title.id = 'study-characters-title'
    // Names the layer rather than the pill: DRILLS opens 'Practice Drills' by
    // the same rule. 'Progress', not a count of anything — the sheet says how
    // much it holds by holding it.
    title.textContent = 'Character & Progress'

    const list = document.createElement('ul')
    list.className = 'study-character-list'
    for (const goal of goals) list.appendChild(buildCharacterCard(goal))

    return [title, list]
  }

  /** Updates the OPEN LEARN sheet in place — see this file's header
   *  "SHEET-WHILE-STEPPING" note for why this touches only the body's contents
   *  and never the panel shell itself. Deliberately NOT the swap path below:
   *  stepping ‹ › is a stream of small edits to one document, not a change of
   *  subject, so it must not fade or resize anything.
   *
   *  THE DETAIL ONLY, since the merge (2026-08-15). It used to replace the
   *  whole body, which was free when the body WAS the detail; doing that now
   *  would rebuild the list on every step — dropping a keyboard user's focus,
   *  resetting the list's scroll to the top and re-creating 26 row elements
   *  per press. The list is moved by markIndexRows instead, which edits two
   *  nodes. */
  function renderLearnDetail(): void {
    if (!learnDetailEl) return
    const it = currentItem()
    if (!it) return
    // It used to have to release an in-flight pinned height first, or the new
    // notes rendered clipped inside a panel still sized to the old shot; the
    // panel is a FIXED height now (styles.css .study-learn-panel), so there is
    // no pin, no timer, and nothing for stepping to unwind. Item-aware since
    // the LIGHTS merge (2026-09-08): a light item shows the group's language.
    // FOCUS RE-HOMING (2026-10-14). The detail is full of real buttons now —
    // inline term links, and the PART OF chips before them — and the most
    // natural thing to do with a shot link in a shot's notes is to tap it,
    // which jumps the tour and lands HERE, replacing the very button that
    // holds focus. Dropped on the floor, a keyboard user would be at <body>,
    // outside the dialog. Same answer replaceSheetBodyChildren gives: the row
    // the tour is now on (the ✓ row), else Back.
    const hadFocus = containsNode(learnDetailEl, document.activeElement)
    learnDetailEl.replaceChildren(...(it.kind === 'light' ? buildLightDetailChildren(it.group) : buildShotDetailChildren(it.shot)))
    if (hadFocus) (indexRows[currentIndex]?.row ?? sheetBackBtn)?.focus?.()
  }

  /** Scrolls the list so the row the tour just moved to is visible — and does
   *  NOTHING when it already is, which is exactly what `block: 'nearest'`
   *  means (it is the browser's own "only if off-screen" rule, so this file
   *  does not measure a scroll box it cannot see under test).
   *
   *  REDUCED MOTION DROPS THE SMOOTHNESS, NOT THE SCROLL: the row still comes
   *  into view, it just arrives instantly — the same "remove the motion, keep
   *  the feature" rule the sheet's own animations follow. `instant` says the
   *  same thing for the one non-motion case, opening the sheet, where a smooth
   *  scroll would animate a list that is only just arriving.
   *
   *  Optional-called because the element type this app's suites drive the real
   *  module with has no scrollIntoView, and a jump must not throw in a
   *  headless harness. */
  function revealCurrentRow(instant = false): void {
    // ONE-SCROLL LEARN (2026-09-08): the whole sheet is one scrolling document
    // now (detail over TARGETS over LIGHTS), so a scroll to the ✓ row yanks the
    // DETAIL up under the header. On OPEN/REBUILD (instant) start at the TOP so
    // the detail reads in full; on a live ‹ › / tap move, only bring the row
    // into view if it has scrolled off, leaving the reader's position otherwise.
    if (instant) {
      if (sheetBodyContainer) sheetBodyContainer.scrollTop = 0
      return
    }
    const row = indexRows[currentIndex]?.row
    if (!row) return
    row.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  /** Everything inside `root` a Tab can land on, in DOM order. A local copy of
   *  ui/sheet.ts's private helper of the same name (see this file's header on
   *  duplicating private constants/helpers rather than widening another
   *  module's export surface); it also has to walk `children` by hand so it
   *  works against the fake elements this app's suites drive the real modules
   *  with, which is why the shared one does too. */
  function focusableWithin(root: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = []
    const visit = (el: HTMLElement): void => {
      const kids = (el.children ?? []) as unknown as ArrayLike<unknown>
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i] as HTMLElement | undefined
        if (!child || typeof child.tagName !== 'string') continue
        if (child.hidden) continue
        if (child.tagName === 'BUTTON' && (child as HTMLButtonElement).disabled !== true) out.push(child)
        visit(child)
      }
    }
    visit(root)
    return out
  }

  function onSheetKeydown(ev: KeyboardEvent): void {
    // ONLY THE TOPMOST DIALOG ANSWERS THE KEYBOARD (P8 review, 2026-08-14).
    // The glossary (ui/sheet.ts's `overlay` variant, z-index 200) can open
    // OVER this sheet from the app header — a stack this app documents as
    // intended. Without this gate the trap below would see an activeElement
    // that is not in THIS panel's ring, conclude focus had escaped, and drag
    // the user out of the glossary they are reading and into a sheet they
    // cannot see; and Escape would close both at once. See ui/overlayStack.ts.
    // A SHEET ON A TAB YOU HAVE LEFT ANSWERS NOTHING. This panel survives a
    // tab switch, so it can be open inside a `display: none` tab panel while
    // the user is reading Shots — measured in Chrome, where Tab was being
    // intercepted by this invisible dialog's trap and Escape was closing it.
    // See ui/overlayStack.ts's isRendered.
    if (!isRendered(sheetPanel)) return
    if (!isTopmost(sheetPanel)) return
    // ...and a key is answered ONCE. The topmost dialog's Escape handler tears
    // it down, which pops it mid-dispatch and would otherwise promote THIS
    // sheet into answering the same keypress. See claimOverlayKey.
    if (ev.key !== 'Escape' && ev.key !== 'Tab') return
    if (!claimOverlayKey(ev)) return
    if (ev.key === 'Escape') {
      closeStudySheet()
      return
    }
    // TAB WRAP — the other half of `aria-modal="true"`, added in P8 when this
    // panel stopped having exactly one focusable. See this file's header.
    if (ev.key !== 'Tab' || !sheetPanel) return
    const focusable = focusableWithin(sheetPanel)
    if (focusable.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const idx = focusable.indexOf(active as HTMLElement)
    // NOT IN THE RING AT ALL — one branch covers two cases, because they want
    // the same answer. Focus may be OUTSIDE the panel (it started on the page,
    // or escaped some other way): an aria-modal dialog that can be tabbed INTO
    // from behind leaks in the other direction. Or it may be inside the panel
    // on something the ring excludes — a disabled stepper, or a control inside
    // the `hidden` stepper group. Either way the next Tab belongs to the
    // dialog's first (or, shifted, last) real stop, not to the page.
    if (idx === -1) {
      ev.preventDefault?.()
      ;(ev.shiftKey ? last : first).focus?.()
      return
    }
    // Interior Tabs are left to the browser on purpose: a handler that moved
    // focus on EVERY Tab would be re-implementing tab order, and would get it
    // wrong the moment a body's DOM order stops matching its visual order.
    if (ev.shiftKey ? idx === 0 : idx === focusable.length - 1) {
      ev.preventDefault?.()
      ;(ev.shiftKey ? last : first).focus?.()
    }
  }

  /** Replaces the OPEN sheet body's children WITHOUT the swap fade — the
   *  in-place update path, for when the same subject's content has to be
   *  rebuilt rather than edited (a MODEL change under an open LEARN or DRILLS
   *  body: the tour itself changed, so the rows really are different rows).
   *  Unlike renderLearnDetail, these bodies contain real buttons, so this
   *  carries swapSheetBody's focus re-homing: dropping the element that holds
   *  focus would strand a keyboard user OUTSIDE the sheet, which also makes
   *  closeStudySheet's "focus is still inside" guard decline to restore. */
  function replaceSheetBodyChildren(children: HTMLElement[]): void {
    if (!sheetBodyContainer) return
    const hadFocus = containsNode(sheetBodyContainer, document.activeElement)
    sheetBodyContainer.replaceChildren(...children)
    if (!hadFocus) return
    // THE NODE THE USER WAS ON IS GONE, so put them somewhere equivalent
    // rather than somewhere safe: under LEARN that is the row for the shot the
    // tour is on (built moments ago by buildLearnBodyChildren), which is both
    // the nearest thing to where they were and the row the ✓ is on. Back is
    // the fallback, and the only option for the other kinds.
    const row = sheetKind === 'learn' ? indexRows[currentIndex]?.row : null
    ;(row ?? sheetBackBtn)?.focus?.()
  }

  /** LEVEL v2 (2026-08-15). Refreshes the scroller's NAME and its arrows, and
   *  rebuilds only the reason lines under it when the zone roster changes
   *  shape.
   *
   *  WHY THE STACKED LIST IS GONE, measured in Chrome before it was replaced
   *  (owner: "I can't flip thru the different playfield levels here"). The list
   *  itself worked — every row was tappable and every switch landed. What
   *  broke was flipping: `.study-rail`'s padding-top is `--study-card-top`,
   *  the drawn card's own top edge, so SELECTING A LEVEL MOVED THE CONTROL YOU
   *  JUST PRESSED. On Jaws at 390x780 the rows jumped 171px down the screen the
   *  instant ORCA DECK was chosen (card top 38 -> 242.5); on Halloween at
   *  375x667 choosing SANITARIUM pushed the three rows to y444/480/516 with the
   *  readout bar's top edge at 521, so two of them were painted ON the bar and
   *  the rail's own `overflow: hidden` clipped 74px of column (scrollHeight 587
   *  vs clientHeight 513) — the rail's foot label disappeared entirely.
   *  Flipping through four levels meant chasing a control that relocated after
   *  every press and eventually hid under another one.
   *
   *  TWO FIXES, and both are needed. The control is now ONE fixed-height
   *  scroller instead of N rows, which is what makes it fit; and styles.css
   *  parks it at the FOOT of the rail (`order: 3`, and since the eyebrow's
   *  removal on 2026-08-15 it carries the column's one `margin-top: auto`
   *  itself), which pins it to the rail's bottom edge — a box the card's top
   *  edge cannot move. The pills above it still align to the card, which is the
   *  alignment the owner asked for in P9 and is untouched.
   *
   *  A TRIM-HIDDEN ZONE KEEPS ITS EXPLANATION, which was the whole point of
   *  the 2026-08-14 revision (rolo, on a Pro, went looking for Jaws's Orca deck
   *  and found no control at all — absence reads as a broken app). It is no
   *  longer a stop in the cycle (studyLevels' own note says why a scroller
   *  cannot hold one); it is a line under the scroller naming the deck and
   *  where the switch is. A machine with NO authored zones still shows nothing,
   *  because there is nothing to explain. */
  function refreshLevelControl(): void {
    const all = state.data?.playfields ?? []
    const visible = machineZones(all, state.trim)
    levelGroup.hidden = all.length === 0

    // A level pointing at a zone this MODEL hides drops back to main — never
    // leave the tour walking a surface that is not on the machine. ALL drops
    // the same way when the MODEL leaves nothing to combine.
    const before = studyLevel
    studyLevel = resolveStudyLevel(studyLevel, visible)
    const dropped = before !== studyLevel ? all.find((z) => z.id === before) ?? null : null
    const droppedAll = before === LEVEL_ALL && studyLevel !== LEVEL_ALL

    const shapeKey = all.map((z) => `${z.id}:${isZoneVisible(z, state.trim) ? 1 : 0}`).join('|')
    if (shapeKey !== levelShapeKey) {
      levelShapeKey = shapeKey
      // Only the reason lines are rebuilt. The scroller — the element the
      // arrows live on — is never touched after mount, so no roster change can
      // tear a button down under a finger.
      for (const el of levelReasonEls) el.remove()
      levelReasonEls = []
      for (const zone of all) {
        if (isZoneVisible(zone, state.trim)) continue
        const why = document.createElement('div')
        why.className = 'study-level-reason'
        // NAME THE DECK AND THE MODEL IT NEEDS — and stop there. This line
        // used to end "…switch MODEL in settings", which was a direction to
        // another tab's popover; the MODEL control is now the next thing down
        // the rail, so the sentence that pointed at it is redundant and the
        // shorter line survives the 144px column without wrapping to four.
        why.textContent = `${zone.name.toUpperCase()} is Premium/LE`
        levelGroup.appendChild(why)
        levelReasonEls.push(why)
      }
    }

    const levels = studyLevels(visible)
    const current = levels.find((l) => l.id === studyLevel) ?? levels[0]!
    levelName.textContent = current.label
    // AMBER ONLY WHEN THE TOUR HAS LEFT THE MAIN PLAYFIELD. MAIN is the
    // default and the resting state, so lighting it would spend the glow
    // budget (BACKGLASS §5) on "nothing is going on"; a deck or ALL is a mode
    // you chose, and the wash is how the rail says so at a glance.
    levelName.className = current.id === 'main' ? 'study-level-name' : 'study-level-name study-level-name-on'
    // ONE STOP = NO ARROWS AT ALL (2026-08-14). They used to render disabled
    // here, and rolo's report is what a disabled-but-present control actually
    // communicates: "the buttons on the side still aren't changing the
    // playfield." A 70x44 amber glyph at 0.4 opacity, in a rail where every
    // other control is live, reads as a button — so a Pro whose only deck is
    // Premium/LE got two of them that answer no press.
    //
    // A control with nothing to do is not a control. The plate still names the
    // one level that exists, `.study-level-reason` still names the deck this
    // MODEL hides, and the MODEL control below now makes that deck reachable
    // in one tap — so nothing is lost by the arrows leaving, which is exactly
    // the condition for removing them rather than dimming them.
    //
    // `disabled` IS ALSO SET, and each half earns its place: `hidden` is the
    // visual claim (styles.css restates `[hidden]` for this row, because it
    // sets its own `display` — tests/tab-panels.test.mjs owns that trap), and
    // `disabled` is the behavioural one that still holds if any future rule
    // ever out-specifies the hide, and that keeps both buttons out of the
    // sheet's focus ring regardless.
    const canCycle = levels.length > 1
    levelArrows.hidden = !canCycle
    levelPrevBtn.disabled = !canCycle
    levelNextBtn.disabled = !canCycle

    if (droppedAll) {
      announce('This model has no extra playfields. Showing the main playfield.')
    } else if (dropped) {
      // Announce the drop rather than silently changing what the tour walks.
      announce(`${dropped.name} needs Premium/LE. Showing the main playfield.`)
    }
  }

  /** Paints the MODEL control from `state.trim`, and hides it whole on a
   *  machine with no trim-restricted content.
   *
   *  READ-ONLY WITH RESPECT TO STATE. It never writes `trim` — the two click
   *  handlers below do, through `state.setTrim`, and this function only ever
   *  reflects what that left behind. That is what keeps this control and the
   *  Shots tab's popover in sync without either one knowing the other exists:
   *  both are pure functions of the same field, and both are re-run by the
   *  same notify. */
  function refreshModelControl(): void {
    modelGroup.hidden = !machineHasVariants(state.data)
    const pro = state.trim === 'pro'
    // `className =`, not classList.toggle — the same idiom the LEVEL plate's
    // amber wash uses ten lines down, and this file's only one.
    modelProBtn.className = pro ? 'study-model-btn selected' : 'study-model-btn'
    modelPremBtn.className = pro ? 'study-model-btn' : 'study-model-btn selected'
    modelProBtn.setAttribute('aria-pressed', String(pro))
    modelPremBtn.setAttribute('aria-pressed', String(!pro))
  }

  /** One press of PRO or PREM/LE.
   *
   *  Everything downstream is already wired: `setTrim` persists and notifies,
   *  and this file's own `state.onChange` handler (below) recomputes the tour,
   *  refreshes the LEVEL control — which is what makes a Premium-only deck
   *  become reachable the instant you press PREM/LE — and repaints. So this
   *  handler does NOT re-derive any of that; a second copy of the refresh
   *  sequence here is how the two paths drift. The no-op guard is setTrim's
   *  own (it returns without notifying when the value is unchanged), so
   *  pressing the selected half costs nothing and announces nothing. */
  function pickTrim(v: 'pro' | 'premium-le'): void {
    if (state.trim === v) return
    state.setTrim(v)
  }
  modelProBtn.addEventListener('click', () => pickTrim('pro'))
  modelPremBtn.addEventListener('click', () => pickTrim('premium-le'))

  /** One press of ‹ or ›. CYCLIC, no dead ends — the same "a browse carousel
   *  has no ends" choice map2d.ts's own level scroller and skill-shot browse
   *  both make, and the owner's own framing ("scroll thru which level to
   *  show") is a cycle rather than a bounded list. */
  function cycleLevel(dir: 1 | -1): void {
    const levels = studyLevels(machineZones(state.data?.playfields, state.trim))
    if (levels.length < 2) return
    const i = Math.max(0, levels.findIndex((l) => l.id === studyLevel))
    selectLevel(levels[(i + dir + levels.length) % levels.length]!.id)
  }
  levelPrevBtn.addEventListener('click', () => cycleLevel(-1))
  levelNextBtn.addEventListener('click', () => cycleLevel(1))

  /** Switches the tour to another surface. Resets to the first shot: a tour
   *  position means nothing across surfaces (shot 7 of the main playfield is
   *  not shot 7 of a four-shot deck), and carrying an index across would land
   *  the player somewhere arbitrary. */
  function selectLevel(id: string): void {
    if (studyLevel === id) return
    studyLevel = id
    closeStudySheet()
    computeTour()
    currentIndex = 0
    syncLitToCurrent()
    refreshLevelControl()
    updateControls()
    ensureLoop()
    // AND PAINT NOW. ensureLoop() only schedules: in auto mode with a frame
    // already pending it does nothing at all, so the canvas would keep showing
    // the OLD surface until the next tick. That is invisible at 60fps and very
    // visible in a test — but it is still the wrong shape for a deliberate
    // user action, and map2d.ts's own selectLevel renders explicitly for the
    // same reason.
    render(performance.now())
    const zone = currentZone()
    const count = `${tourShots.length} ${tourShots.length === 1 ? 'shot' : 'shots'}.`
    announce(
      studyLevel === LEVEL_ALL ? `All playfields. ${count}` : zone ? `${zone.name}. ${count}` : `Main playfield. ${count}`,
    )
  }

  /** The four conditional pills, hidden (not disabled) when the dataset has
   *  nothing for them. Since P9 they are rail children, so hiding one simply
   *  shortens the rail — it no longer changes any canvas geometry.
   *
   *  EVERY ONE OF THESE READS THE SAME FUNCTION ITS SHEET BODY IS BUILT FROM
   *  (buildSheetContent's own table): the collection predicates for ALT MODES
   *  and CHARACTER, `drills[]` for DRILLS, `actionButton` for ACTION. A pill
   *  shown by one rule and filled by another is how a pill that opens nothing
   *  ships. */
  function updateConditionalPills(): void {
    actionBtn.hidden = !state.data?.actionButton
    drillsBtn.hidden = (state.data?.drills?.length ?? 0) === 0
    altBtn.hidden = altModeGoals(state.data).length === 0
    characterBtn.hidden = characterGoals(state.data).length === 0
    const hip = howItPlaysOf(state.data)
    howItPlaysBtn.hidden = hip == null
  }

  /** The OS "reduce motion" preference, read live (it can change mid-session
   *  on iOS). Every animated path below routes through this: reduced motion
   *  removes the MOTION and keeps the feature — the swap still happens, it
   *  just happens instantly. */
  function prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  }

  /** `root.contains(node)`, walked by hand so it also works against the fake
   *  elements this app's suites drive the real modules with (no Node.contains
   *  there) — same reason ui/sheet.ts hand-walks its own. */
  function containsNode(root: HTMLElement, node: unknown): boolean {
    if (!node) return false
    if (root === node) return true
    const kids = (root.children ?? []) as unknown as ArrayLike<unknown>
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as HTMLElement | undefined
      if (child && typeof child.tagName === 'string' && containsNode(child, node)) return true
    }
    return false
  }

  // ---- THE PINNED-HEIGHT TIMER IS GONE (P5, 2026-08-14) ------------------
  // What used to live here: a SWAP_HEIGHT_MS constant, a swapTimer, a
  // swapGeneration counter and a clearPinnedHeight() that four separate call
  // sites had to remember to call. All of it existed for ONE reason — LEARN
  // and ACTION were different heights, so switching had to animate the
  // panel's top edge from one to the other, which meant pinning an inline
  // height and clearing it later. That timer raced in four directions, every
  // one reachable by tapping faster than 160ms (switch-switch cleared the
  // live transition mid-flight; switch-close and switch-destroy fired against
  // a detached panel; switch-step left the new content clipped).
  //
  // The fix is not a better-owned timer. The panel now has ONE STANDARD
  // HEIGHT for both kinds (styles.css .study-learn-panel), so it never
  // resizes: there is nothing to animate, nothing to pin, and no timer to
  // own. Every one of those four races is unreachable because the state they
  // raced over does not exist. A swap is a content change and nothing else.

  /** SHEET SWITCHING (P4 addendum, 2026-08-14 — owner: the ACTION sheet's
   *  motion "is really jumpy and kinda weird").
   *
   *  THE CULPRIT, since it is worth writing down: LEARN and ACTION used to be
   *  two independent sheets, and each one's open() closed the other. Tapping
   *  ACTION while LEARN was up therefore removed a panel from the DOM and
   *  inserted a brand-new one — which replayed `.study-learn-panel`'s full
   *  0.25s studySheetUp slide from off-screen, so the user saw the sheet
   *  vanish and then climb back up. Two focus() calls landed in the same tick
   *  on top of that (close returned focus to the pill, open moved it to the
   *  new Back button), which on iOS can add a scroll-into-view lurch.
   *  The entrance animation itself was never the problem — studySheetUp
   *  animates `transform` only, never a layout property.
   *
   *  So a switch no longer closes anything. The panel that is already on
   *  screen keeps its position, and only its CONTENT is replaced: a new body
   *  element, so `.study-learn-body-swap`'s 120ms fade-in plays on insertion —
   *  CSS animations run when an element carrying one enters the document, so
   *  there is no timer and no class-toggling dance to get wrong.
   *
   *  P5 (2026-08-14): the from -> to height transition this used to run went
   *  with the panel's variable height. Both kinds are one fixed size now, so
   *  the swap is a cross-fade of contents inside a panel that does not move —
   *  ONE motion, and the only one. See the note above where the timer was. */
  function swapSheetBody(children: HTMLElement[], bodyClass: string): void {
    const panel = sheetPanel
    const oldBody = sheetBodyContainer
    if (!panel || !oldBody) return

    const reduced = prefersReducedMotion()
    const fresh = document.createElement('div')
    // `bodyClass` carries the kind's own layout (LEARN's two-scroll-region
    // split; the plain scrolling column for everything else) — a per-kind
    // modifier rather than a rule that has to guess which kind is showing.
    fresh.className = reduced ? bodyClass : `${bodyClass} study-learn-body-swap`
    fresh.append(...children)

    const wasFocusInsideOldBody = containsNode(oldBody, document.activeElement)
    oldBody.remove()
    panel.append(fresh)
    sheetBodyContainer = fresh

    // FOCUS RE-HOMING. Nothing inside either body is focusable today (titles,
    // chips and notes are spans/paragraphs; the only control in the panel is
    // the Back button, which lives OUTSIDE the swapped body and therefore
    // survives every swap). But "today" is the whole risk: the moment someone
    // adds a link or a button to a LEARN/ACTION body, removing that body
    // while it holds focus drops activeElement to <body> — outside the sheet,
    // which also makes closeStudySheet's "focus is still inside" guard decline
    // to restore, stranding a keyboard user twice over. Re-home explicitly.
    if (wasFocusInsideOldBody) sheetBackBtn?.focus?.()
  }

  /** The pill for `kind`, pressed. Three outcomes, one function, because
   *  there is only ever ONE sheet: it opens, it swaps the open sheet's
   *  content to this kind, or — pressing the pill of the kind already
   *  showing — it closes.
   *
   *  THE CLOSE BRANCH IS NOT COSMETIC. Until this phase the pill row sat
   *  UNDER the sheet's own transparent backdrop (z-index 4 vs 9), so a tap on
   *  ACTION BUTTON while LEARN was open never reached the pill at all — it
   *  hit the backdrop and dismissed the sheet, and a second tap then opened
   *  ACTION with a full slide-up from off-screen. That is the "jumpy" motion
   *  the owner reported, and it also meant the in-place swap below was
   *  unreachable by touch (only by keyboard, which z-index cannot block).
   *  styles.css now lifts `.study-top-row` above the backdrop, which makes
   *  the pills live controls again — and a live pill must still toggle its
   *  own sheet shut, or the dismissal that tap used to perform would simply
   *  be gone. Same open/close-on-repeat-press contract as the Shots tab's
   *  goal pill (overlay/map2d.ts's openGoalSheet). */
  /** The sheet's header row: Back on the left, the in-sheet ‹ › on the right.
   *  Built ONCE per open, exactly like the Back button it now contains — it is
   *  outside the swapped body on purpose, so a kind switch can never destroy
   *  the element focus is sitting on (tests/study.test.mjs section p pins
   *  that). Its height is FIXED whether the steppers are showing or not, so
   *  the body's top edge does not move between kinds — the same "nothing
   *  resizes" rule the panel's own fixed height buys (P5). */
  function buildSheetHead(): HTMLElement {
    const head = document.createElement('div')
    head.className = 'study-sheet-head'

    sheetBackBtn = document.createElement('button')
    sheetBackBtn.type = 'button'
    sheetBackBtn.className = 'study-learn-back'
    const arrow = document.createElement('span')
    arrow.setAttribute('aria-hidden', 'true')
    arrow.textContent = '‹'
    const backLabel = document.createElement('span')
    backLabel.textContent = 'Back'
    sheetBackBtn.append(arrow, backLabel)
    sheetBackBtn.addEventListener('click', () => closeStudySheet())

    // The ‹ › the bottom bar cannot offer while a sheet covers it — see this
    // file's header. They call the SAME stepManual() the bottom bar does:
    // there is one stepping implementation, and the in-place LEARN body
    // update is a consequence of that call, not a second copy of it.
    sheetSteps = document.createElement('div')
    sheetSteps.className = 'study-sheet-steps'
    const stepPrev = document.createElement('button')
    stepPrev.type = 'button'
    stepPrev.className = 'study-sheet-step'
    stepPrev.textContent = '‹'
    stepPrev.setAttribute('aria-label', 'Previous shot')
    stepPrev.addEventListener('click', () => stepManual(-1))
    const stepNext = document.createElement('button')
    stepNext.type = 'button'
    stepNext.className = 'study-sheet-step'
    stepNext.textContent = '›'
    stepNext.setAttribute('aria-label', 'Next shot')
    stepNext.addEventListener('click', () => stepManual(1))
    sheetSteps.append(stepPrev, stepNext)
    sheetStepBtns = [stepPrev, stepNext]

    head.append(sheetBackBtn, sheetSteps)
    return head
  }

  /** Shows the in-sheet ‹ › for the one kind whose body is ABOUT the current
   *  shot, and hides them for the three that are not. See this file's header
   *  for why that is a content judgement rather than an omission. */
  function updateSheetSteps(): void {
    if (!sheetSteps) return
    sheetSteps.hidden = sheetKind !== 'learn'
  }

  /** Panel class + aria-labelledby + body class + body, per kind. One table
   *  rather than four branches scattered through toggleStudySheet, so adding a
   *  fifth kind cannot half-happen. Returns null when the kind has nothing to
   *  show (no current shot, no actionButton, no drills) — the pill press is
   *  then inert rather than opening an empty sheet.
   *
   *  `bodyClass` is the one field the merge added: LEARN's body is a two-region
   *  split (detail over list, each scrolling on its own) and every other kind's
   *  is the single scrolling column it always was. */
  // ---- HOW IT PLAYS + LIGHTS (schema v9) — the two surfaces, one field ----
  function currentHip(): HowItPlays | null {
    return howItPlaysOf(state.data)
  }

  function el(tag: string, cls: string, text?: string): HTMLElement {
    const e = document.createElement(tag)
    e.className = cls
    if (text != null) e.textContent = text
    return e
  }

  // ---- INLINE TERMS (2026-10-14) — see ui/linkTerms.ts's header ----------
  /** el(), but the text goes through linkTerms: glossary words become buttons
   *  that open the glossary AT that entry, and this machine's own shot names
   *  become buttons that move the tour onto that shot. Used for the prose of
   *  HOW IT PLAYS (objective, loop, lane change, scoring) and of the LEARN
   *  detail (a shot's notes, a light's LIT/FLASHING/CONTROL/THEN), and nowhere
   *  else: titles, chips and list rows are labels, not reading.
   *
   *  THE SHOTS PASSED ARE THE MAIN TOUR'S — buildTour on the whole machine at
   *  the current MODEL, the same roster the MAIN level walks — so a name only
   *  becomes a button when there is a tour position for it to move to. A
   *  Premium/LE-only shot read on a Pro stays plain text rather than offering
   *  a tap that cannot land. */
  function prose(tag: string, cls: string, text: string): HTMLElement {
    const e = el(tag, cls)
    e.append(
      linkTerms(text, {
        glossary: glossaryData,
        shots: buildTour(state.data?.shots ?? [], state.trim),
        onGlossaryTerm: openGlossaryAt,
        onShot: showShotFromProse,
      }),
    )
    return e
  }

  /** A glossary word in the prose was tapped. The same lazy load the
   *  "Lane change ›" button below already uses — openGlossary(term) is P7a's
   *  anchor (findTerm), and linkTerms hands over the ENTRY'S own name rather
   *  than the prose spelling, so the anchor is exact even for a plural or an
   *  alias ("inlanes", "Hold flipper"). The glossary is an overlay-tier sheet,
   *  so it stacks above this one and Escape closes it first (overlayStack). */
  function openGlossaryAt(term: string): void {
    loadChunk(() => import('./glossary'), 'the glossary', (m) => m.openGlossary(term))
  }

  /** A shot name in the prose was tapped: move the tour onto that shot so it
   *  lights on the map — jumpTo, the SAME move a LEARN list row or a tap on
   *  the field makes, so the map, the readout, the open sheet's detail and the
   *  spoken announcement all follow by the one existing path.
   *
   *  THE SHEET STAYS OPEN, and the TOUR STAYS PAUSED. jumpTo already leaves
   *  `mode` at 'manual'; clearing `wasAutoBeforeSheet` as well is what keeps it
   *  paused after the sheet closes — otherwise closeStudySheet would restore a
   *  shuffle the visitor had running before they opened the sheet, and the
   *  shot they just asked to see would be carried away 2.5s after they closed
   *  it. A deliberate "show me THIS one" outranks a mode set earlier.
   *
   *  A SHOT OFF THE CURRENT LEVEL moves the tour back to MAIN first. A zone
   *  level walks only its deck's shots, so "the left 3-bank" read while the
   *  Orca deck is showing has no position in that tour; the main playfield is
   *  the one level every visible shot belongs to. Done in place rather than
   *  through selectLevel, because selectLevel closes the sheet (correct for a
   *  press on the LEVEL control, wrong here — the visitor is mid-sentence in
   *  that sheet). An open LEARN body is tour-dependent, so it is re-derived
   *  for the new roster before the jump; HOW IT PLAYS is not, and is left as
   *  it is. ALL already walks the whole machine and never needs this. */
  function showShotFromProse(shotId: string): void {
    let idx = tourShots.findIndex((s) => s.id === shotId)
    if (idx === -1 && studyLevel !== 'main') {
      studyLevel = 'main'
      computeTour()
      refreshLevelControl()
      refreshOpenSheetForTour()
      announce(`Main playfield. ${tourShots.length} ${tourShots.length === 1 ? 'shot' : 'shots'}.`)
      idx = tourShots.findIndex((s) => s.id === shotId)
    }
    if (idx === -1) return
    wasAutoBeforeSheet = false
    jumpTo(idx)
    peekStudySheet()
  }

  /** PEEK (2026-10-14, integration of the inline-terms pass). The sheet is a
   *  fixed 55dvh, so a shot the prose just lit in the LOWER half of the table
   *  (the captive ball on Jaws, at 400x860) is lit BEHIND the sheet and the
   *  visitor sees nothing change — the worst possible answer to "show me".
   *  Closing the sheet would show it, at the cost of the reader's place in a
   *  paragraph they are mid-way through.
   *
   *  So the sheet DUCKS instead: `study-sheet-peek` shrinks the panel to its
   *  head plus the first lines of the body (styles.css, 17dvh), the whole map
   *  is visible with the shot lit, and the FIRST tap or keyboard focus back
   *  inside the panel restores the full height with the scroll position
   *  untouched. The sheet is never closed, re-rendered or re-measured — the
   *  panel keeps its node, its body and its listeners; only a class moves.
   *
   *  The listeners are capture-phase on the panel so a tap on ANY descendant
   *  (a term link, the back button, the body) restores first; they remove
   *  themselves on the first fire, and closeStudySheet drops the panel node
   *  with them. `focusin` covers a keyboard reader who Tabs on without
   *  touching the screen. The ducking tap itself has already dispatched by
   *  the time these are attached (we are inside its click handler), so it
   *  cannot undo its own peek. */
  function peekStudySheet(): void {
    const panel = sheetPanel
    if (!panel || panel.classList.contains('study-sheet-peek')) return
    panel.classList.add('study-sheet-peek')
    const restore = (): void => {
      panel.classList.remove('study-sheet-peek')
      panel.removeEventListener('pointerdown', restore, true)
      panel.removeEventListener('focusin', restore, true)
    }
    panel.addEventListener('pointerdown', restore, true)
    panel.addEventListener('focusin', restore, true)
  }

  /** The glossary arrived (or arrived late) — re-run linkTerms over whatever
   *  prose is ON SCREEN, so a sheet that opened before the data landed (the
   *  landing sheet, every time: it opens in the same task the tab mounts in)
   *  gains its glossary links instead of keeping shot links only.
   *
   *  HOW IT PLAYS is rebuilt WITHOUT the swap fade and with its scroll offset
   *  kept — it is the same document gaining links, not a new subject, and a
   *  reader who has already scrolled must not be thrown back to the top.
   *  LEARN rebuilds only its DETAIL (renderLearnDetail), which is the only
   *  prose in it; the list and its focus are untouched. */
  function relinkOpenSheet(): void {
    if (sheetKind === 'howitplays') {
      const hip = currentHip()
      if (!hip || !sheetBodyContainer) return
      const top = sheetBodyContainer.scrollTop
      replaceSheetBodyChildren(buildHowItPlaysBodyChildren(hip))
      sheetBodyContainer.scrollTop = top
    } else if (sheetKind === 'learn') {
      renderLearnDetail()
    }
  }

  /** A goal chip that lands on the Goals-tab detail (the drill card's own
   *  "Learn the goal" affordance). Only built when the host handed us the jump
   *  — no chip beats a dead chip. */
  function goalChip(goalId: string): HTMLElement | null {
    if (!jumpToGoalDetail) return null
    const goal = (state.data?.goals ?? []).find((g) => g.id === goalId)
    if (!goal) return null
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'study-hip-goal-chip'
    chip.textContent = goal.title
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation?.()
      jumpToGoalDetail(goal)
    })
    return chip
  }

  function goalChipRow(goalIds: readonly string[] | null | undefined): HTMLElement | null {
    const chips = (goalIds ?? []).map(goalChip).filter((c): c is HTMLElement => c != null)
    if (chips.length === 0) return null
    const row = el('div', 'study-hip-goal-chips')
    row.append(...chips)
    return row
  }

  /** A row that swaps the OPEN sheet to another kind in place — the shared-shell
   *  path toggleStudySheet already owns. The two cross-links use it. */
  function crossLinkRow(label: string, kind: SheetKind): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'study-hip-crosslink'
    btn.textContent = label
    btn.addEventListener('click', () => toggleStudySheet(kind))
    return btn
  }

  function buildHowItPlaysBodyChildren(hip: HowItPlays): HTMLElement[] {
    const title = el('h2', 'study-learn-title', 'How It Plays')
    title.id = 'study-howitplays-title'
    const out: HTMLElement[] = [title]

    // The PROSE of this sheet goes through prose() (inline glossary + shot
    // links, 2026-10-14); headings and tier labels stay plain el() — they are
    // labels, and a button inside a heading is a heading nobody can read.
    out.push(el('div', 'study-hip-heading', 'OBJECTIVE'))
    out.push(prose('p', 'study-learn-notes', hip.objective))

    out.push(el('div', 'study-hip-heading', 'THE LOOP'))
    const loop = document.createElement('ol')
    loop.className = 'study-hip-loop'
    for (const line of hip.loop) loop.appendChild(prose('li', 'study-hip-loop-item', line))
    out.push(loop)

    out.push(el('div', 'study-hip-heading', 'LANE CHANGE'))
    out.push(prose('p', 'study-hip-lanechange', laneChangeLine(hip)))
    const gloss = document.createElement('button')
    gloss.type = 'button'
    gloss.className = 'study-hip-glossary'
    gloss.textContent = 'Lane change ›'
    gloss.addEventListener('click', () => {
      loadChunk(() => import('./glossary'), 'the glossary', (m) => m.openGlossary('Lane change'))
    })
    out.push(gloss)

    out.push(el('div', 'study-hip-heading', 'START SCORING'))
    const scoring = document.createElement('ol')
    scoring.className = 'study-hip-scoring'
    const tierLabels: Record<string, string> = { 'ball-one': 'BALL ONE', building: 'BUILDING', 'the-big-one': 'THE BIG ONE' }
    for (const step of hip.scoring) {
      const li = el('li', 'study-hip-tier')
      li.appendChild(el('span', 'study-hip-tier-label', tierLabels[step.tier] ?? step.tier.toUpperCase()))
      li.appendChild(prose('span', 'study-hip-tier-text', step.text))
      const chips = goalChipRow(step.goals)
      if (chips) li.appendChild(chips)
      scoring.appendChild(li)
    }
    out.push(scoring)

    // Cross-link into LEARN, which now carries the targets AND the lights the
    // objective refers to (2026-09-08).
    out.push(crossLinkRow('See targets & lights ›', 'learn'))
    return out
  }

  function buildSheetContent(
    kind: SheetKind,
  ): { panelClass: string; labelledBy: string; bodyClass: string; children: HTMLElement[] } | null {
    if (kind === 'learn') {
      // Opens on ANY tour item now (2026-09-08) — a target OR a light — so the
      // guard is "is there anything to walk", not "is the current item a shot".
      if (tourLen() === 0) return null
      return {
        panelClass: 'study-learn-panel',
        labelledBy: 'study-learn-title',
        bodyClass: 'study-learn-body',
        children: buildLearnBodyChildren(),
      }
    }
    if (kind === 'action') {
      const ab = state.data?.actionButton ?? null
      if (!ab) return null
      return {
        panelClass: 'study-learn-panel study-ab-panel',
        labelledBy: 'study-ab-title',
        bodyClass: 'study-learn-body',
        children: buildActionSheetChildren(ab),
      }
    }
    if (kind === 'drills') {
      const drills = state.data?.drills ?? []
      if (drills.length === 0) return null
      return {
        panelClass: 'study-learn-panel study-drills-panel',
        labelledBy: 'study-drills-title',
        bodyClass: 'study-learn-body',
        children: buildDrillsBodyChildren(drills),
      }
    }
    if (kind === 'altmodes') {
      // The SAME predicate the pill's own visibility uses (goalMeta's
      // altModeGoals), not a second filter — a pill shown by one rule and
      // filled by another is how a pill that opens nothing ships.
      const alts = altModeGoals(state.data)
      if (alts.length === 0) return null
      return {
        panelClass: 'study-learn-panel study-altmodes-panel',
        labelledBy: 'study-altmodes-title',
        bodyClass: 'study-learn-body',
        children: buildAltModesBodyChildren(alts),
      }
    }
    if (kind === 'howitplays') {
      const hip = currentHip()
      if (!hip) return null
      return {
        panelClass: 'study-learn-panel study-howitplays-panel',
        labelledBy: 'study-howitplays-title',
        bodyClass: 'study-learn-body',
        children: buildHowItPlaysBodyChildren(hip),
      }
    }
    // CHARACTER, on the same terms: goalMeta's characterGoals is the pill's
    // visibility rule AND the Shots tab's retarget rule, so all three surfaces
    // are reading one function.
    const chars = characterGoals(state.data)
    if (chars.length === 0) return null
    return {
      panelClass: 'study-learn-panel study-character-panel',
      labelledBy: 'study-characters-title',
      bodyClass: 'study-learn-body',
      children: buildCharacterBodyChildren(chars),
    }
  }

  function toggleStudySheet(kind: SheetKind): void {
    if (sheetKind === kind) {
      closeStudySheet()
      return
    }
    const content = buildSheetContent(kind)
    if (!content) return
    const { panelClass, labelledBy, bodyClass, children } = content

    if (sheetKind !== null && sheetPanel) {
      sheetPanel.className = panelClass
      sheetPanel.setAttribute('aria-labelledby', labelledBy)
      // NOTE on the rows and the two half-handles the outgoing body took with
      // it: nothing clears `indexRows`/`learnDetailEl`/`learnListEl` here, and
      // nothing needs to. refreshSheetForTour dispatches on `sheetKind`, so
      // once the kind is no longer 'learn' markIndexRows and renderLearnDetail
      // are unreachable, and re-entering LEARN rebuilds all three before
      // anything reads them. A release here would be a line no test can observe
      // — it was written, mutation-tested, found to be inert, and removed.
      // closeStudySheet drops the references for real.
      // The lit group now follows the TOUR, not the sheet (2026-09-08): it is
      // set by syncLitToCurrent on every move and reflects wherever the rotation
      // sits, so swapping which sheet is open over it changes nothing about what
      // the map draws. (The old F1 clear-on-swap belonged to the standalone
      // LIGHTS kind, which no longer exists.)
      swapSheetBody(children, bodyClass)
      sheetKind = kind
      updateSheetSteps()
      updateControls()
      // Arriving at LEARN with the tour already deep in the list must open on
      // the current row, not at the top — the same reveal a jump does, minus
      // the smooth scroll, because the list is arriving rather than moving.
      if (kind === 'learn') revealCurrentRow(true)
      return
    }

    wasAutoBeforeSheet = mode === 'auto'
    mode = 'manual'
    ensureLoop()

    sheetBackdrop = document.createElement('div')
    sheetBackdrop.className = 'study-learn-backdrop'
    sheetBackdrop.addEventListener('click', (ev) => {
      // Only the backdrop itself — "tapping the exposed field above it"
      // must not fire from a click that started on the panel and drifted
      // out (a text-selection drag), same guard ui/signupgate.ts uses.
      if (ev.target === sheetBackdrop) closeStudySheet()
    })

    sheetPanel = document.createElement('div')
    sheetPanel.className = panelClass
    sheetPanel.setAttribute('role', 'dialog')
    sheetPanel.setAttribute('aria-modal', 'true')
    sheetPanel.setAttribute('aria-labelledby', labelledBy)

    const head = buildSheetHead()

    // The live region is mounted with the shell, BEFORE any announcement can
    // be written into it — a region inserted at the same moment as its text is
    // unreliably announced. It also sits outside the swapped body so a kind
    // switch cannot destroy and re-create it. See this file's header.
    sheetLive = document.createElement('div')
    sheetLive.className = 'sr-only'
    sheetLive.setAttribute('role', 'status')

    sheetBodyContainer = document.createElement('div')
    sheetBodyContainer.className = bodyClass
    sheetBodyContainer.append(...children)

    sheetPanel.append(head, sheetLive, sheetBodyContainer)
    host.append(sheetBackdrop, sheetPanel)

    document.addEventListener('keydown', onSheetKeydown)
    // This sheet is a TAB-LOCAL surface (styles.css pins the panel at z-index
    // 10), so it registers at the local tier and yields the keyboard to
    // anything in the overlay tier above it.
    pushOverlay(sheetPanel, OVERLAY_TIER_LOCAL)
    // FOCUS ONLY IF THIS SHEET IS ON TOP (2026-10-14). A pill press always is.
    // The LANDING open is not, on a first visit: app.ts opens HOW IT PLAYS
    // when this tab's chunk arrives, which is AFTER main.ts has put the
    // first-run how-to guide up in the overlay tier — and pulling focus out of
    // a full-screen dialog the visitor is reading, into a sheet underneath it,
    // is the exact leak overlayStack exists to stop. So the sheet opens, takes
    // its place in the stack, and leaves focus where it is; there is then no
    // "before" to return focus to on close either.
    if (isTopmost(sheetPanel)) {
      priorFocus = (document.activeElement as HTMLElement | null) ?? null
      sheetBackBtn!.focus()
    } else {
      priorFocus = null
    }
    sheetKind = kind
    updateSheetSteps()
    updateControls()
    // Open on the row the tour is on — see the swap path's own note.
    if (kind === 'learn') revealCurrentRow(true)
  }

  function closeStudySheet(): void {
    if (sheetKind === null) return
    sheetKind = null
    document.removeEventListener('keydown', onSheetKeydown)
    // Release the keyboard and any pending announcement before the nodes go:
    // a popped-but-registered panel would keep whatever is underneath from
    // ever answering a key, and a trailing announce timer would fire against
    // a detached region.
    popOverlay(sheetPanel)
    cancelAnnounce()
    sheetBackdrop?.remove()
    sheetPanel?.remove()
    sheetBackdrop = null
    sheetPanel = null
    sheetBodyContainer = null
    sheetBackBtn = null
    sheetSteps = null
    sheetStepBtns = []
    sheetLive = null
    indexRows = []
    learnDetailEl = null
    // The lit state follows the TOUR, not the sheet (2026-09-08): re-derive it
    // from the current item so closing the sheet leaves the map showing exactly
    // what the rotation is on — the lit group if a light, the single insert if a
    // target — rather than blanking it and flashing dark until the next tick.
    syncLitToCurrent()
    mode = wasAutoBeforeSheet ? 'auto' : 'manual'
    if (mode === 'auto') autoStartedAt = performance.now()
    const toFocus = priorFocus
    priorFocus = null
    ensureLoop()
    updateControls()
    toFocus?.focus?.()
  }
  learnBtn.addEventListener('click', () => toggleStudySheet('learn'))

  // ---- ACTION sheet (machine action-button explainer) ----
  function buildActionSheetChildren(ab: ActionButtonInfo): HTMLElement[] {
    const title = document.createElement('h2')
    title.className = 'study-learn-title'
    title.id = 'study-ab-title'
    title.textContent = ab.present ? (ab.label ?? 'Action Button') : 'No Action Button'

    const children: HTMLElement[] = [title]

    if (ab.present && ab.location) {
      const chips = document.createElement('div')
      chips.className = 'study-learn-chips'
      const loc = document.createElement('span')
      loc.className = 'study-learn-chip'
      loc.textContent = ab.location.toUpperCase()
      chips.appendChild(loc)
      children.push(chips)
    }

    const how = document.createElement('p')
    how.className = 'study-learn-notes'
    how.textContent = ab.how
    children.push(how)

    const uses = ab.uses ?? []
    if (uses.length > 0) {
      const heading = document.createElement('div')
      heading.className = 'study-ab-heading'
      heading.textContent = 'WHEN TO USE IT'
      const list = document.createElement('ul')
      list.className = 'study-ab-uses'
      for (const u of uses) {
        const row = document.createElement('li')
        row.className = 'study-ab-use'
        const when = document.createElement('span')
        when.className = 'study-ab-when'
        when.textContent = u.when
        const what = document.createElement('span')
        what.className = 'study-ab-what'
        what.textContent = u.what
        row.append(when, what)
        list.appendChild(row)
      }
      children.push(heading, list)
    }
    return children
  }

  // The ACTION sheet has no open/close pair of its own any more — it is the
  // same sheet as LEARN with different content (toggleStudySheet above). The
  // panel keeps BOTH classes when it is showing the action button:
  // `.study-learn-panel` for the shell it shares, `.study-ab-panel` as the
  // distinguishing hook (tests + any future ab-only styling).
  actionBtn.addEventListener('click', () => toggleStudySheet('action'))
  drillsBtn.addEventListener('click', () => toggleStudySheet('drills'))
  altBtn.addEventListener('click', () => toggleStudySheet('altmodes'))
  characterBtn.addEventListener('click', () => toggleStudySheet('character'))
  howItPlaysBtn.addEventListener('click', () => toggleStudySheet('howitplays'))
  // The quiz is an OVERLAY-tier sheet (ui/quiz.ts rides ui/sheet.ts's
  // 'overlay' variant, like the glossary), so it stacks above whatever local
  // sheet is open here and Escape closes it first — no toggleStudySheet, no
  // interaction with sheetKind. Lazy, through the same loadChunk door the
  // glossary uses, so a visitor who never taps it never downloads it. The
  // door it is handed is the Shots-tab jump this module already owns
  // (showGoalOnShots, mountStudy's 4th arg): a question about a goal ends in
  // "Show me on the playfield", which is exactly a LEARN detail's door.
  quizBtn.addEventListener('click', () =>
    loadChunk(() => import('./quiz'), 'the quiz', (m) =>
      m.openQuiz(state, {
        showGoalOnShots: (goal) => {
          if (showGoalOnShots) showGoalOnShots(goal)
        },
      }),
    ),
  )

  // ---- Resize / DPR (mirrors overlay/map2d.ts's resize() exactly). ----
  function resize(): void {
    const dpr = window.devicePixelRatio || 1
    // THE CANVAS'S OWN BOX, not the host's (P9). The canvas used to be
    // `width: 100%` of #study-host, so the two were the same number and this
    // read the host's. It is now the LEFT COLUMN of a flex row whose right
    // column is the pill rail, so sizing the backing store from the host would
    // make it wider than the element it is painted into — every drawn shot
    // would land to the right of where it is hit-tested. render() already read
    // the canvas box (`canvas.clientWidth || host.clientWidth`); this makes
    // the pair agree. The host fallback stays for the same reason it does
    // there: a canvas with no layout yet reports 0.
    const width = canvas.clientWidth || host.clientWidth
    const height = canvas.clientHeight || host.clientHeight
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    render(performance.now())
  }
  const resizeObserver = new ResizeObserver(() => resize())
  resizeObserver.observe(host)

  /** The tour as a string, for "did this notify actually change what an open
   *  sheet is showing?" — see syncFromState. Ids, in order, because that is
   *  exactly what the list renders and what `drillTourIndex` resolves against;
   *  a length would miss a same-size re-filter and a deep compare would cost
   *  more than the rebuild it is trying to avoid. */
  function tourSignature(): string {
    return tourShots.map((s) => s.id).join('|')
  }

  /** The roster prose() links shot names against — the MAIN tour at the
   *  current MODEL, whatever level is walking (see prose()). Tracked apart
   *  from tourSignature because the two can move independently: on a deck
   *  level a MODEL switch can leave the walked tour identical while changing
   *  which shot names in the prose have somewhere to land. */
  function linkRosterSignature(): string {
    return buildTour(state.data?.shots ?? [], state.trim)
      .map((s) => s.id)
      .join('|')
  }

  /** Re-derives an OPEN sheet's body after the TOUR changed under it (a MODEL
   *  switch, a level the MODEL just took away). Run LAST in syncFromState,
   *  after the LEVEL control and the tour have both settled — building it any
   *  earlier renders a list that the level-drop below it then invalidates.
   *
   *  LEARN IS THE ONE THAT REBUILDS, and it must: its lower half IS the tour,
   *  so a re-filter really does mean different rows. That is also why this is
   *  the rebuild path and not renderLearnDetail's edit-in-place — the row
   *  elements themselves are wrong now, and replaceSheetBodyChildren re-homes
   *  the focus they were holding. */
  function refreshOpenSheetForTour(linksMoved = false): void {
    if (sheetKind === 'learn') {
      if (tourLen() === 0) closeStudySheet()
      else {
        replaceSheetBodyChildren(buildLearnBodyChildren())
        revealCurrentRow(true)
      }
    } else if (sheetKind === 'drills') {
      // Machine-level content, but a MODEL change can take the shot a drill's
      // "Study …" jumps to off the field — drillTourIndex re-decides which
      // drills still have somewhere to send you.
      const drills = state.data?.drills ?? []
      if (drills.length === 0) closeStudySheet()
      else replaceSheetBodyChildren(buildDrillsBodyChildren(drills))
    } else if (sheetKind === 'howitplays' && linksMoved) {
      // Machine-level prose, but its SHOT LINKS are per-MODEL: a Premium/LE
      // shot named in the loop is a button on Premium and plain text on Pro
      // (prose()). Left alone, a MODEL switch with the sheet open kept the
      // old trim's links — a tap that could not land, or a real shot shown
      // as dead text. relinkOpenSheet rebuilds the body in place with the
      // reader's scroll kept, the same path the glossary's late arrival uses.
      // ONLY when the link roster moved: showShotFromProse also lands here
      // (a level change, same MODEL), and rebuilding then would take focus
      // off the very link a keyboard reader just pressed.
      relinkOpenSheet()
    }
  }

  // ---- state.onChange: machine switches (full reset) and trim changes
  // (re-filter, try to keep pointing at the same shot). ----
  function syncFromState(): void {
    const currentMachineId = state.machine?.id ?? null
    const machineChanged = currentMachineId !== lastMachineId
    lastMachineId = currentMachineId
    const prevShotId = currentShot()?.id ?? null
    const prevTour = tourSignature()
    const prevLinkRoster = lastLinkRoster
    lastLinkRoster = linkRosterSignature()
    computeTour()
    if (machineChanged) {
      // A MACHINE SWITCH CLOSES ANY OPEN SHEET, deliberately and for every
      // kind (P8 re-examined this and kept it). Every one of the four bodies
      // is about the machine that was showing: LEARN is a shot on it and its
      // tour, ACTION BUTTON is its lockdown bar, DRILLS is its
      // authored practice. Carrying a sheet across a switch would mean either
      // stale content over a new playfield, or silently swapping the subject
      // out from under a reader's finger — and for DRILLS/ACTION the new
      // machine may have no such content at all, so the sheet would have to
      // vanish on some switches and not others. Closing every time is the one
      // rule that is the same every time.
      // The rail follows the new machine in the same pass
      // (updateConditionalPills() below). Since P9 that no longer feeds any
      // canvas geometry: the pills are out of the canvas, so the label band is
      // the constant LABEL_TOP_MARGIN and cannot go stale across a switch.
      currentIndex = 0
      // PAUSED on a new machine too, for the reason mount is (this file's
      // header, "THE TOUR STARTS PAUSED"): a machine switch now lands on HOW
      // IT PLAYS (app.ts), and the objective is read before anything moves.
      // A visitor who had started the shuffle on the old machine starts it
      // again with one tap — a new machine is a new first look.
      mode = 'manual'
      autoStartedAt = performance.now()
      // The new machine's zones are its own; a level id from the old one means
      // nothing here. Clearing the shape key forces the control to rebuild.
      studyLevel = 'main'
      levelShapeKey = null
      // closeStudySheet RESTORES the pre-sheet mode — so a sheet opened while
      // the old machine was shuffling would hand 'auto' straight back to the
      // new one and undo the line above. The new machine's tour has no
      // "before the sheet"; forget the old one's.
      wasAutoBeforeSheet = false
      closeStudySheet()
    } else {
      const idx = prevShotId ? tourShots.findIndex((s) => s.id === prevShotId) : -1
      currentIndex = idx !== -1 ? idx : Math.min(currentIndex, Math.max(0, tourLen() - 1))
    }
    updateConditionalPills()
    // MODEL FIRST, then LEVEL. Both are pure reads of `state.trim`, so the
    // order is cosmetic for correctness — but this notify may BE a trim change
    // (from either control, or from the Shots popover), and refreshing the
    // segmented pair before the level control means the rail never paints a
    // frame where the reason line has already dropped its deck while the
    // MODEL buttons still show the old selection.
    refreshModelControl()
    refreshLevelControl()
    // The level may have just dropped to main (a MODEL switch hiding the zone
    // this tour was walking), so the roster is recomputed AFTER the control
    // has had its say, not before.
    computeTour()
    currentIndex = Math.min(currentIndex, Math.max(0, tourLen() - 1))
    // The lit state follows the tour, so re-point it after the roster settles —
    // a MODEL/level change can move the current item or empty the lights half.
    syncLitToCurrent()
    // AND THE OPEN SHEET IS RE-DERIVED LAST, from that settled tour — the fix
    // for a body built one line too early. The sheet used to be rebuilt up in
    // the branch above, BEFORE refreshLevelControl could drop a zone level the
    // new MODEL hides; on that path the list was built from the zone's shots
    // and the tour then became the main playfield's, so the sheet listed a
    // deck the tab was no longer walking.
    //
    // ONLY WHEN THE TOUR ACTUALLY CHANGED. AppState notifies for everything —
    // a goal picked on the Shots tab, a celebration slider, a trail style —
    // and this sheet survives a tab switch, so an unconditional rebuild would
    // throw away 26 row elements and the list's scroll position because
    // somebody pressed something on another tab. A machine switch is excluded
    // outright: it has already closed the sheet.
    if (!machineChanged) {
      const linksMoved = lastLinkRoster !== prevLinkRoster
      if (tourSignature() !== prevTour) refreshOpenSheetForTour(linksMoved)
      // The walked tour held still but the LINK roster moved (a MODEL switch
      // while a deck level is walking): only the prose's shot links are
      // stale, so only they are rebuilt — LEARN's rows are still right.
      else if (linksMoved) relinkOpenSheet()
    }
    updateControls()
    ensureLoop()
  }
  const unsubscribe = state.onChange(syncFromState)

  refreshModelControl()
  refreshLevelControl()
  computeTour()
  syncLitToCurrent()
  updateConditionalPills()
  updateControls()
  resize()
  // resize() has just painted the first frame. ensureLoop() would paint it
  // AGAIN when there is no loop to start — which, now that the tour starts
  // paused, is the normal case at mount — so it is only called when there is
  // a loop to schedule (a lamp animation; the shuffle itself is off here).
  if (wantsLoop()) ensureLoop()

  // THE GLOSSARY, for prose()'s inline links (2026-10-14). Through loadChunk
  // like every other route into ./glossary (tests/chunk-guard.test.mjs holds
  // the whole app to that), and otherwise fire-and-forget: the tab is fully
  // usable without it, and a sheet that opened first is relinked when it lands
  // (relinkOpenSheet). Two different failures, two different answers: the
  // CHUNK failing is a stale deploy, and loadChunk's reload banner is the
  // right thing to say (the term buttons it would have fed open the same
  // chunk, so they would fail too); the JSON failing is loadGlossary's own
  // fail-soft null, which says nothing and leaves the prose with its shot
  // links only.
  loadChunk(
    () => import('./glossary'),
    'the glossary',
    (m) =>
      void m.loadGlossary().then((data) => {
        if (destroyed || !data) return
        glossaryData = data
        relinkOpenSheet()
      }),
  )

  return {
    /** OPEN the HOW IT PLAYS sheet, scrolled to the top — the landing door
     *  (app.ts's landOnHowItPlays: boot, and every machine switch).
     *
     *  OPEN, NOT TOGGLE, for openCharacter's reason below: an arrival must
     *  never close the thing it is arriving at. Already showing means the body
     *  is only scrolled back to the top — a machine switch closes every sheet
     *  (syncFromState) before this runs, so in practice that branch is a
     *  re-land on the same machine. ANOTHER kind showing is SWAPPED in place
     *  by toggleStudySheet, the same path a pill press takes.
     *
     *  Inert when the machine has no renderable howItPlays (buildSheetContent
     *  returns null for the kind). app.ts's own check is a cheaper
     *  approximation of howItPlaysOf, so this is the authoritative gate. */
    openHowItPlays(): void {
      if (sheetKind !== 'howitplays') toggleStudySheet('howitplays')
      if (sheetKind === 'howitplays' && sheetBodyContainer) sheetBodyContainer.scrollTop = 0
    },
    /** OPEN the CHARACTER sheet — the Shots tab's arrival door (app.ts's
    /** OPEN the CHARACTER sheet — the Shots tab's arrival door (app.ts's
     *  jumpToStudyCharacter, handed to overlay/map2d.ts as its trailing-optional
     *  fifth argument).
     *
     *  OPEN, NOT TOGGLE, and that is the whole reason this is a method rather
     *  than a re-export of the pill's own handler: toggleStudySheet closes the
     *  kind already showing, which is right for a pill press and wrong for an
     *  arrival — tapping a character row on the Shots tab twice would land on
     *  Study with the sheet SHUT the second time. Already showing means there
     *  is nothing to do.
     *
     *  Inert when the machine has no character goals: buildSheetContent returns
     *  null for the kind, exactly as a press on a pill that should not be there
     *  would be. The row that calls this only exists on a machine that has one,
     *  and the jump does not change machine — but "inert" is the honest failure
     *  mode either way, not an empty sheet. */
    openCharacter(): void {
      if (sheetKind === 'character') return
      toggleStudySheet('character')
    },
    destroy(): void {
      destroyed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      canvas.removeEventListener('click', onCanvasClick)
      resizeObserver.disconnect()
      unsubscribe()
      cancelAnnounce()
      if (sheetKind !== null) {
        document.removeEventListener('keydown', onSheetKeydown)
        popOverlay(sheetPanel)
        sheetBackdrop?.remove()
        sheetPanel?.remove()
      }
      host.innerHTML = ''
    },
  }
}
