// ui/machinecard.ts — the Card tab: the at-the-machine surface (phase B3,
// 2026-08-10). Everything else in this app (Goals, Map, Achievements) is a
// study-at-home tool; this one is the opposite — big type, glanceable in the
// few seconds between balls, with hands still on the flipper buttons. Born
// from rolo's own tournament feedback: nobody re-reads a step-by-step goal
// walker while standing at the glass.
//
// RETIRED 2026-08-11 (owner: "Remove all cards. That feature has been
// removed."). This module is UNIMPORTED by anything in the app — the same
// UNIMPORT pattern as ar/arview.ts (2026-07-29) and fx/celebrate.ts
// (2026-07-28); see app.ts's own header for that pattern's full rationale
// and for this retirement's own entry. It stays on disk and still
// typechecks (models.ts keeps the CardEntry/MachineCard types for exactly
// that reason), but ships in no bundle. Card data itself is stripped from
// the 5 machines that had it (data/{jaws,evil_dead,halloween,harry_potter,
// sonic_the_hedgehog}_goals.json). Everything below this notice documents
// the module AS IT WAS BUILT (phase B3, then extended 2026-08-11 by "card
// beside map") for whoever next needs to understand what it did — none of
// it currently runs.
//
// Sections render in a FIXED order, each omitted entirely when it has no
// content (models.ts's MachineCard/CardEntry/Drill doc comments are the
// source contract this mirrors):
//   SKILL SHOT — the one pick, why.
//   THE LINE   — the curated tournament path, numbered 1..n.
//   SAFE       — repeatable, low-drain-risk shots.
//   DANGER     — shots/situations that drain; each entry's text says why.
//   REMINDERS  — plain bullets, no tap affordance (they're not CardEntry —
//                just strings, see MachineCard.reminders).
//   PRACTICE   — drills (GameData.drills), independent of `card` itself: if
//                drills exist but `card` doesn't, PRACTICE still renders
//                below the "no card yet" stub rather than being swallowed
//                by it.
//
// If `data.card` is absent outright, a single quiet stub renders in its
// place ("No card yet for this machine") — never an invented card. Most
// machines have neither `card` nor `drills` yet (ease-layer schema v5 was
// just added; this is the FIRST machine-agnostic consumer of it, ahead of
// the real data-authoring pass — see app/tests/card.test.mjs's header for
// how that test suite stays honest about running on synthetic fixtures
// until the real jaws card lands).
//
// Mount pattern, BACK WHEN THIS MOUNTED ANYWHERE, mirrored overlay/map2d.ts,
// the other lazily-imported, NOT-account-gated tab (app.ts's loadChunk call
// site): mounted once on first visit to the tab, subscribed to
// state.onChange itself, and was never destroyed/re-mounted afterward.
// Unlike Map, there was no per-goal overlay state to own, so there was no
// returned handle to speak of.
//
// 2026-08-11 ("card beside map" — now itself also retired, see the notice at
// the top of this file): the section-building body was factored out as the
// exported renderMachineCard(root, state, showGoalOnMap) — a single render
// PASS with no subscription of its own — so overlay/map2d.ts's then-new
// wide-viewport card column could reuse the exact same section layout
// without a second, drifting copy of this logic. mountMachineCard (below)
// is a thin wrapper: it owns the `.mcard-root` element and the
// state.onChange render LOOP. Neither function has a live caller any more.
//
// GOAL LINKS: a CardEntry/Drill's optional `goal` id is resolved against
// state.data.goals BY ID (never trusted as a foreign/stale Goal reference)
// and, when it resolves, jumps to the Map tab via the exact same
// showGoalOnMap() app.ts already built for Achievements' "SHOW ME" — see
// app.ts's own comment on that function. An unresolvable id (stale dataset,
// same fail-soft posture as ui/achievements.ts's SHOW ME) falls back to a
// plain, non-interactive row rather than a dead button.
//
// TRIM: CardEntry.trim === 'premium-le' renders a small "PREM/LE" chip after
// the entry's text (renderEntryControl). As of phase A3 (2026-08-10,
// state.trim / entryVisibleForTrim below), a premium-le entry is HIDDEN
// OUTRIGHT — not merely chipped — when the current MODEL selector is 'pro':
// a Pro player has no code to make that shot, so listing it (even chipped)
// would be misleading advice. Under 'premium-le' every entry still renders
// with its existing chip, unchanged. Drills carry no `trim` field
// (models.ts) so this never applies to PRACTICE rows.
//
// CSS: unlike most ui/*.ts modules (ui/achievements.ts + achievements.css,
// ui/adslot.ts + adslot.css, ui/howto.ts + howto.css, …), this module has NO
// sibling machinecard.css. Phase B3's scope was app.ts / this file /
// styles.css (additions only) / tests — no new CSS file — so every
// `.mcard-*` class here is defined in the shared app/src/styles.css instead,
// under its own "Card tab" header comment. Retirement (see the top-of-file
// notice) left that CSS block in place too, same reasoning as this file
// staying on disk — it's dead weight, not a live stylesheet, since nothing
// builds a `.mcard-*` element anywhere any more.

import type { AppState } from '../state'
import type { CardEntry, Drill, Goal, Machine } from '../models'

/** Exported (2026-08-11, "card beside map") so overlay/map2d.ts's card
 *  column can type its own local jump-to-goal callback against the exact
 *  same shape mountMachineCard's caller (app.ts) already provides, without
 *  either file importing the other's implementation. */
export type ShowGoalOnMap = (machine: Machine, goal: Goal) => Promise<void>

/** Resolves a CardEntry/Drill's optional `goal` id against this machine's
 *  own goals array, by id — mirrors ui/achievements.ts's goalsById
 *  resolution discipline (never trust a foreign/stale Goal object). Returns
 *  null for both "no goal id at all" and "id doesn't resolve" — callers
 *  don't need to distinguish the two; either way the entry isn't tappable. */
function resolveGoal(id: string | null | undefined, goals: Goal[]): Goal | null {
  if (!id) return null
  return goals.find((g) => g.id === id) ?? null
}

/** A CardEntry with real, non-blank text — the only kind worth rendering.
 *  Every CardEntry-bearing field on MachineCard is typed as required
 *  (models.ts), but the dataset is hand-authored JSON with no runtime
 *  enforcement, so this stays defensive the same way the rest of this app's
 *  data-consuming code is (e.g. ui/achievements.ts's isValidProgressBlob). */
function hasEntryText(entry: CardEntry | null | undefined): entry is CardEntry {
  return !!entry && typeof entry.text === 'string' && entry.text.trim().length > 0
}

/** A3 (2026-08-10): whether `entry` should render at all under the current
 *  MODEL selector — see this file's header "TRIM" note. Hides a premium-le
 *  entry outright when `currentTrim` is 'pro' (a Pro player cannot make that
 *  shot, so even a chipped mention would be misleading); every other
 *  combination renders. No CardEntry in the dataset ever carries
 *  trim:'pro' (models.ts's only marker value is 'premium-le'), so this is a
 *  one-directional filter, not a two-way switch. */
function entryVisibleForTrim(entry: CardEntry, currentTrim: 'pro' | 'premium-le'): boolean {
  return !(currentTrim === 'pro' && entry.trim === 'premium-le')
}

/** Builds the tappable-or-not control for one row: a real `<button>` when
 *  `onTap` is given (a resolved goal), a plain `<div>` otherwise — per this
 *  phase's brief, "tappable entries are <button>", which by implication
 *  means a non-tappable entry carries no interactive/button semantics at
 *  all, rather than a disabled button. */
function buildEntryControl(onTap: (() => void) | undefined): HTMLElement {
  if (onTap) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.addEventListener('click', onTap)
    return btn
  }
  return document.createElement('div')
}

function appendChevronIfTappable(control: HTMLElement, tappable: boolean): void {
  if (!tappable) return
  const chevron = document.createElement('span')
  chevron.className = 'mcard-entry-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.textContent = '›' // ›
  control.appendChild(chevron)
}

function renderChip(text: string, modifier: 'trim' | 'reps'): HTMLElement {
  const chip = document.createElement('span')
  chip.className = `mcard-chip mcard-chip-${modifier}`
  chip.textContent = text
  return chip
}

/** One SKILL SHOT / THE LINE / SAFE / DANGER row. `indexLabel`, when given,
 *  renders the big numbered badge — THE LINE only (SPEC: "THE LINE numbered
 *  large"); every other section's rows carry none. */
function renderEntryControl(
  entry: CardEntry,
  goals: Goal[],
  machine: Machine,
  showGoalOnMap: ShowGoalOnMap,
  indexLabel?: number,
): HTMLElement {
  const resolved = resolveGoal(entry.goal, goals)
  const control = buildEntryControl(resolved ? () => void showGoalOnMap(machine, resolved) : undefined)
  control.classList.add('mcard-entry')
  if (resolved) control.classList.add('mcard-entry-tappable')

  if (indexLabel !== undefined) {
    const idx = document.createElement('span')
    idx.className = 'mcard-line-index'
    idx.setAttribute('aria-hidden', 'true')
    idx.textContent = String(indexLabel)
    control.appendChild(idx)
  }

  const textWrap = document.createElement('span')
  textWrap.className = 'mcard-entry-text-wrap'

  const text = document.createElement('span')
  text.className = 'mcard-entry-text'
  text.textContent = entry.text
  textWrap.appendChild(text)

  // CHIP ONLY (see this file's header "TRIM" note) — the A3 trim selector
  // adds real filtering later; for now every entry renders regardless of
  // `trim`, and this chip is the sole visual signal it's model-specific.
  if (entry.trim === 'premium-le') textWrap.appendChild(renderChip('PREM/LE', 'trim'))

  control.appendChild(textWrap)
  appendChevronIfTappable(control, resolved !== null)
  return control
}

function renderSection(label: string, key: string, body: HTMLElement): HTMLElement {
  const section = document.createElement('section')
  section.className = `mcard-section mcard-section-${key}`
  const labelId = `mcard-label-${key}`
  section.setAttribute('aria-labelledby', labelId)

  const heading = document.createElement('h2')
  heading.className = 'mcard-section-label'
  heading.id = labelId
  heading.textContent = label

  section.append(heading, body)
  return section
}

/** SKILL SHOT — a single pick, not a list (models.ts: "the skill-shot pick
 *  and why"). No <ul>/<li> wrapper: a "list of one" reads oddly to a screen
 *  reader and there's nothing to enumerate. */
function renderSkillShotSection(
  entry: CardEntry,
  goals: Goal[],
  machine: Machine,
  showGoalOnMap: ShowGoalOnMap,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mcard-entry-list'
  wrap.appendChild(renderEntryControl(entry, goals, machine, showGoalOnMap))
  return renderSection('SKILL SHOT', 'skillshot', wrap)
}

/** THE LINE / SAFE / DANGER — an actual list of entries. `numbered` is true
 *  only for THE LINE (an <ol> with the big index badge per row); SAFE/DANGER
 *  are plain <ul>s of the same row shape with no numbering. */
function renderEntryListSection(
  label: string,
  key: string,
  entries: CardEntry[],
  numbered: boolean,
  goals: Goal[],
  machine: Machine,
  showGoalOnMap: ShowGoalOnMap,
): HTMLElement {
  const list = document.createElement(numbered ? 'ol' : 'ul')
  list.className = 'mcard-entry-list' + (numbered ? ' mcard-line-list' : '')
  entries.forEach((entry, i) => {
    const li = document.createElement('li')
    li.appendChild(renderEntryControl(entry, goals, machine, showGoalOnMap, numbered ? i + 1 : undefined))
    list.appendChild(li)
  })
  return renderSection(label, key, list)
}

/** REMINDERS — plain strings (MachineCard.reminders is `string[]`, not
 *  CardEntry[]), so plain bullets: no goal link, no trim chip, never
 *  tappable. */
function renderRemindersSection(reminders: string[]): HTMLElement {
  const list = document.createElement('ul')
  list.className = 'mcard-reminders-list'
  for (const line of reminders) {
    const li = document.createElement('li')
    li.className = 'mcard-reminder-row'
    li.textContent = line
    list.appendChild(li)
  }
  return renderSection('REMINDERS', 'reminders', list)
}

/** One PRACTICE row: title + text + an optional reps chip (models.ts Drill:
 *  "`reps` is prose on purpose"). Same goal-link/tappability rule as a
 *  CardEntry, resolved the same way — Drill just isn't a CardEntry (no
 *  `trim`, and `title`/`text` are two separate fields instead of one). */
function renderDrillRow(drill: Drill, goals: Goal[], machine: Machine, showGoalOnMap: ShowGoalOnMap): HTMLElement {
  const resolved = resolveGoal(drill.goal, goals)
  const control = buildEntryControl(resolved ? () => void showGoalOnMap(machine, resolved) : undefined)
  control.classList.add('mcard-entry', 'mcard-drill')
  if (resolved) control.classList.add('mcard-entry-tappable')

  const textWrap = document.createElement('span')
  textWrap.className = 'mcard-entry-text-wrap'

  const title = document.createElement('span')
  title.className = 'mcard-drill-title'
  title.textContent = drill.title
  textWrap.appendChild(title)

  const text = document.createElement('span')
  text.className = 'mcard-entry-text mcard-drill-text'
  text.textContent = drill.text
  textWrap.appendChild(text)

  if (drill.reps) textWrap.appendChild(renderChip(drill.reps, 'reps'))

  control.appendChild(textWrap)
  appendChevronIfTappable(control, resolved !== null)

  const li = document.createElement('li')
  li.appendChild(control)
  return li
}

function renderPracticeSection(
  drills: Drill[],
  goals: Goal[],
  machine: Machine,
  showGoalOnMap: ShowGoalOnMap,
): HTMLElement {
  const list = document.createElement('ul')
  list.className = 'mcard-entry-list'
  for (const d of drills) list.appendChild(renderDrillRow(d, goals, machine, showGoalOnMap))
  return renderSection('PRACTICE', 'practice', list)
}

/** The "not authored yet" stub — quiet on purpose: no amber upgrade-invite
 *  styling (compare ui/achievements.ts's sign-in banner), because this isn't
 *  an upsell, it's a plain absence. Renders whenever `data.card` itself is
 *  absent, independent of whether PRACTICE also renders below it (drills are
 *  authored separately from the card — see this file's header). */
function renderStub(): HTMLElement {
  const stub = document.createElement('div')
  stub.className = 'mcard-stub'

  const title = document.createElement('div')
  title.className = 'mcard-stub-title'
  title.textContent = 'No card yet for this machine'

  const text = document.createElement('p')
  text.className = 'mcard-stub-text'
  text.textContent =
    "The at-the-machine card — skill shot, the line, safe and danger shots — hasn't been authored for this machine yet."

  stub.append(title, text)
  return stub
}

/**
 * Renders the Card tab's whole content into `root` (fully replacing its
 * children) for the CURRENT `state.data`/`state.machine` — the one-shot
 * render pass shared by mountMachineCard's own subscription below AND
 * overlay/map2d.ts's card column (2026-08-11, "card beside map" — a
 * right-hand column on the Map tab at wide viewports needs the identical
 * section layout/behavior without a second copy of this function's body).
 * Callers own the render LOOP (call this once, then again on every
 * `state.onChange` — see mountMachineCard immediately below for the
 * reference shape); this function itself does not subscribe to anything, so
 * it's safe to call from more than one mount point against the same
 * `state`. `showGoalOnMap` is per-caller: app.ts's real cross-machine/
 * cross-tab handler for the Card TAB, but map2d.ts's card column passes its
 * own simpler local callback instead (that column is always already on the
 * Map tab showing the current machine, so it never needs to switch either).
 */
export function renderMachineCard(root: HTMLElement, state: AppState, showGoalOnMap: ShowGoalOnMap): void {
  root.innerHTML = ''

  // Defensive, not really reachable in practice: main.ts awaits
  // createAppState() (which awaits the first machine's full load) before
  // mountApp() ever runs, so state.data/state.machine are already set by
  // the time any tab — including a lazily-mounted one — can be opened.
  // Matches renderGoalsPanel()'s identical guard in app.ts.
  if (!state.data || !state.machine) {
    const msg = document.createElement('div')
    msg.className = 'state-message'
    msg.textContent = 'Loading…'
    root.appendChild(msg)
    return
  }

  const machine = state.machine
  const data = state.data
  const goals = data.goals
  const card = data.card ?? null
  const drills = Array.isArray(data.drills) ? data.drills : []

  const nameEl = document.createElement('div')
  nameEl.className = 'mcard-machine-name'
  nameEl.textContent = data.machine
  root.appendChild(nameEl)

  if (card) {
    // A3 (2026-08-10): the current MODEL selector — see entryVisibleForTrim
    // above. Read once per render so every section filters consistently.
    const currentTrim = state.trim
    if (hasEntryText(card.skillShot) && entryVisibleForTrim(card.skillShot, currentTrim)) {
      root.appendChild(renderSkillShotSection(card.skillShot, goals, machine, showGoalOnMap))
    }
    const line = Array.isArray(card.line)
      ? card.line.filter(hasEntryText).filter((e) => entryVisibleForTrim(e, currentTrim))
      : []
    if (line.length > 0) {
      root.appendChild(renderEntryListSection('THE LINE', 'line', line, true, goals, machine, showGoalOnMap))
    }
    const safe = Array.isArray(card.safeShots)
      ? card.safeShots.filter(hasEntryText).filter((e) => entryVisibleForTrim(e, currentTrim))
      : []
    if (safe.length > 0) {
      root.appendChild(renderEntryListSection('SAFE', 'safe', safe, false, goals, machine, showGoalOnMap))
    }
    const danger = Array.isArray(card.dangerShots)
      ? card.dangerShots.filter(hasEntryText).filter((e) => entryVisibleForTrim(e, currentTrim))
      : []
    if (danger.length > 0) {
      root.appendChild(renderEntryListSection('DANGER', 'danger', danger, false, goals, machine, showGoalOnMap))
    }
    const reminders = Array.isArray(card.reminders)
      ? card.reminders.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : []
    if (reminders.length > 0) {
      root.appendChild(renderRemindersSection(reminders))
    }
  } else {
    // data.card is ABSENT — the one condition that shows the stub (see
    // renderStub()'s own comment). A `card` object that's merely
    // incomplete (e.g. malformed authoring leaves every section empty)
    // renders nothing beyond the machine name/PRACTICE below, rather than
    // showing an inaccurate "no card yet" next to a card that does exist.
    root.appendChild(renderStub())
  }

  // PRACTICE is independent of `card` — authored separately (GameData.drills
  // vs GameData.card), so it renders whenever drills exist, card or not.
  if (drills.length > 0) {
    root.appendChild(renderPracticeSection(drills, goals, machine, showGoalOnMap))
  }
}

/**
 * Mounts the Card tab into `host` (an app.ts tab panel, shown/hidden like
 * Map — never destroyed on tab switch, only hidden). Renders for
 * `state.machine`/`state.data` and re-renders on every `state.onChange`
 * (covers machine switches — there's no other mutable state this tab reads).
 * `showGoalOnMap` is app.ts's shared SHOW ME handler — see this file's
 * header "GOAL LINKS" note. Thin wrapper over renderMachineCard (above) —
 * owns the `.mcard-root` element and the render loop, nothing else.
 */
export function mountMachineCard(host: HTMLElement, state: AppState, showGoalOnMap: ShowGoalOnMap): void {
  const root = document.createElement('div')
  root.className = 'mcard-root'
  host.replaceChildren(root)

  function render(): void {
    renderMachineCard(root, state, showGoalOnMap)
  }

  render()
  state.onChange(render)
}
