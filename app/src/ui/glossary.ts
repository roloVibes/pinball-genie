// ui/glossary.ts — Glossary of pinball terms: a bottom sheet listing the
// five fixed categories (shots/anatomy/technique/rules/editions), each with
// its terms alphabetized, plus a sticky live text filter (term + aliases +
// def, case-insensitive contains).
//
// Mounted straight into document.body — same reason as ui/howto.ts: it must
// be reachable (and sit above whichever tab/AR phase is active) from BOTH
// the app header (app.ts) and the AR idle screen (ar/arview.ts), neither of
// which shares a common position:relative ancestor.
//
// P4 (2026-08-14) — THE SHEET CHROME IS NO LONGER FORKED. This file used to
// recreate sheet.css's whole glass bottom-sheet recipe (backdrop, panel,
// grabber, header, slide-up animation) privately, because createSheet() was
// absolute-positioned inside a caller's `root` at z-index 9/10, BELOW the app
// header/tab bar (z-index 20) — correct for the AR/Map tab's own pickers,
// wrong for a globally reachable overlay. ui/sheet.ts now takes a
// `variant: 'overlay'` that mounts to document.body as position:fixed at
// howto.css's 200/201 tier, which is exactly what that fork existed for, so
// this file uses createSheet() like everything else and got role="dialog",
// Escape, focus capture/return and Tab wrapping for free. What remains below
// is only what is actually glossary-specific: the fetch/cache, the filter,
// and the term list — all unchanged, and all still `.pg-glossary-*` classed.
//
// Entry points (wired by callers, not this module): app.ts's header
// "Glossary" chip (next to Help) and ar/arview.ts's idle-screen "Glossary"
// text button (next to "How to use") — both dynamic-import this module on
// click, the same lazy pattern ar/arview.ts already uses for ui/howto.ts.
//
// Content file: data/glossary.json, served exactly like the machine/goal
// data (models.ts's fetchCatalog/fetchGameData fetch the identical
// `/data/*.json` shape). Fetched once and cached in memory (loadGlossary()
// below); ANY problem — network failure, non-2xx status, or a body that
// doesn't pass the isValidGlossary() shape guard — resolves to `null`
// rather than throwing, so the sheet fails soft: no crash, no console spam,
// just a plain "Glossary unavailable" row in place of the term list.

import './glossary.css'
import { createSheet, type SheetHandle } from './sheet'

export interface GlossaryTerm {
  term: string
  aliases?: string[]
  def: string
}

export interface GlossaryCategory {
  id: string
  title: string
  terms: GlossaryTerm[]
}

export interface GlossaryData {
  version: number
  categories: GlossaryCategory[]
}

/** Colors reuse the EXISTING goal-category CSS vars (styles.css's --cat-*)
 *  — a different semantic mapping than goalMeta.ts's GoalCategory (these
 *  are glossary-section ids, not GoalCategory values), but the same visual
 *  language and the same mechanism app.ts/ar/arview.ts already use for
 *  their own category dots (a `var(--cat-*)` string assigned via inline
 *  style) — no new design tokens added. */
const CATEGORY_COLOR: Record<string, string> = {
  shots: 'var(--cat-skillshot)',
  anatomy: 'var(--cat-mode)',
  technique: 'var(--cat-multiplier)',
  rules: 'var(--cat-combo)',
  editions: 'var(--cat-wizard)',
}
const FALLBACK_COLOR = 'var(--amber)'

export function colorForCategory(id: string): string {
  return CATEGORY_COLOR[id] ?? FALLBACK_COLOR
}

/** Light shape guard — enough that a malformed real file fails soft instead
 *  of crashing the sheet; not a full schema validator. Anything that fails
 *  this resolves to `null` in loadGlossary() below. */
export function isValidGlossary(data: unknown): data is GlossaryData {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.categories)) return false
  return d.categories.every((c) => {
    if (!c || typeof c !== 'object') return false
    const cat = c as Record<string, unknown>
    return typeof cat.id === 'string' && typeof cat.title === 'string' && Array.isArray(cat.terms)
  })
}

/** Case-insensitive contains match against term + every alias + def — the
 *  full filterable surface per spec ("live-filters term + aliases + def
 *  text"). Empty/whitespace-only query matches everything. */
export function matchesFilter(t: GlossaryTerm, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (t.term.toLowerCase().includes(q)) return true
  if (t.def.toLowerCase().includes(q)) return true
  return (t.aliases ?? []).some((a) => a.toLowerCase().includes(q))
}

/** Alphabetized COPY — never mutates the input array (same discipline as
 *  app.ts's sortedByName for the machine picker). */
export function sortTermsAlpha(terms: GlossaryTerm[]): GlossaryTerm[] {
  return [...terms].sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }))
}

/** One spelling for comparing a caller's term against a glossary entry's
 *  name: lower-cased, hyphens read as spaces, runs of whitespace collapsed.
 *  The hyphens matter — the callers are the goal-step technique chips, whose
 *  `term` is models.ts's closed vocabulary ('on-the-fly', 'drop-catch'),
 *  while the glossary writes those as prose ("On the fly", "Drop catch"). */
function termKey(s: string): string {
  return s.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ')
}

/** The entry `wanted` names, or null. Four passes, most specific first:
 *  exact on a term NAME, exact on an ALIAS, then the same two by prefix
 *  ('flip' -> "Flip timing").
 *
 *  THE PREFIX PASSES PICK THE LONGEST MATCH, NOT THE FIRST (K3 review,
 *  2026-08-14). "First" meant first in data/glossary.json's authored order —
 *  a silent dependency on how a content file happens to be sorted, where
 *  re-alphabetising the technique section could change which entry a chip
 *  opens without one line of code changing. Longest wins; equal-length
 *  candidates are settled ALPHABETICALLY, not by iteration order (see
 *  longestPrefix below — "first" as the final tiebreak leaves the original
 *  bug intact for the several real queries that tie).
 *
 *  WHAT THE REAL FILE ACTUALLY CONTAINS (measured 2026-08-14 — the first
 *  draft of this comment guessed "no collisions" and was wrong): 108 keys (77
 *  term names + 31 aliases) with SEVEN proper-prefix pairs — bonus < bonus x,
 *  flipper < flipper hold, flipper < flipper pass, loop < loop shot,
 *  playfield < playfield x, rollover < rollover lane, sling < slingshot. In
 *  every one of the seven the shorter key is ITSELF an exact name or alias, so
 *  a query spelling it is answered by the exact passes and never reaches the
 *  prefix pass at all. And every technique string authored in the shipped
 *  catalog resolves exactly too. So the tiebreak decides nothing the product
 *  does today — it decides what happens NEXT, deterministically, instead of
 *  by whatever order a content edit leaves the JSON in. Longest reads as "the
 *  most specific entry that still starts with what you tapped"; the companion
 *  suite pins all three of these facts against the real file.
 *
 *  ALIASES COUNT, and that is not a loosening — it is the difference between
 *  this feature working and not. The technique chips carry models.ts's closed
 *  vocabulary, and MEASURED against the shipped catalog (data/*_goals.json,
 *  2026-08-14) exactly six of those strings are authored anywhere:
 *  hold-flipper (22 chips), from-cradle (10), live-catch (6), backhand (4),
 *  on-the-fly (2), nudge (1). Only four have a matching term NAME — the two
 *  most common, hold-flipper and from-cradle, are authored in the glossary as
 *  ALIASES of "Flipper hold" and "Cradle". Name-only matching would therefore
 *  have missed 32 of the 45 real chips on the machines we ship, while looking
 *  perfectly correct in a unit test. An alias is a name the glossary itself
 *  authored for that entry; following one is not a guess.
 *
 *  STILL NOT FUZZIER THAN THAT. Definitions are not searched (that is the
 *  filter box's job, on the visitor's own terms) and there is no
 *  edit-distance guessing: scrolling someone to the WRONG entry and lighting
 *  it up is worse than opening at the top, which is what a miss does — and
 *  what every caller did before this parameter existed.
 *
 *  Exported for direct testing; app/tests/goal-bridge.test.mjs also runs
 *  every technique in the real dataset through it against the real glossary,
 *  so "the chips land" is a measured claim rather than this comment's word. */
export function findTerm(data: GlossaryData, wanted: string): GlossaryTerm | null {
  const want = termKey(wanted)
  if (!want) return null
  const all = data.categories.flatMap((c) => c.terms)
  /** Every name this entry answers to: its term first, then its aliases. */
  const namesOf = (t: GlossaryTerm): string[] => [termKey(t.term)]
  const aliasesOf = (t: GlossaryTerm): string[] => (t.aliases ?? []).map(termKey)

  const exact = (keys: (t: GlossaryTerm) => string[]): GlossaryTerm | undefined =>
    all.find((t) => keys(t).some((k) => k === want))

  /** The entry with the LONGEST key that starts with `want`; ties broken
   *  ALPHABETICALLY on the key.
   *
   *  The alphabetical tiebreak is not decoration — without it this pass is
   *  still file-order dependent, which is the whole bug. Length alone leaves
   *  real ambiguities in the shipped glossary: 'lo' prefixes both "Lock" and
   *  "Loop" (4 each), 'sh' prefixes "Shooter lane" and "Short plunge" (12
   *  each), 'in' prefixes "Inlane" and "Insert" (6 each). "First one seen"
   *  answers those, and "first" means whatever order a content editor left the
   *  JSON in. The companion suite catches this by reversing the real file and
   *  demanding identical answers — it caught exactly this, one revision ago.
   *
   *  Plain `<`, not localeCompare: this is a machine tiebreak on ASCII keys,
   *  and localeCompare's ordering depends on the runtime's ICU data, which
   *  would put the determinism back where it started. */
  const longestPrefix = (keys: (t: GlossaryTerm) => string[]): GlossaryTerm | undefined => {
    let best: GlossaryTerm | undefined
    let bestKey: string | null = null
    for (const t of all) {
      for (const k of keys(t)) {
        if (!k.startsWith(want)) continue
        if (bestKey === null || k.length > bestKey.length || (k.length === bestKey.length && k < bestKey)) {
          best = t
          bestKey = k
        }
      }
    }
    return best
  }

  return (
    exact(namesOf) ?? exact(aliasesOf) ?? longestPrefix(namesOf) ?? longestPrefix(aliasesOf) ?? null
  )
}

let cache: Promise<GlossaryData | null> | null = null

/** Fetches + caches data/glossary.json once (module-level promise — a
 *  second openGlossary() call anywhere in the same page-load never
 *  refetches). Fails soft to `null` on ANY problem; never throws. */
/** Exported (2026-10-14) for ui/study.ts's inline term links, which need the
 *  vocabulary itself rather than the sheet — the SAME memoised promise, so the
 *  Study tab and a later glossary open share one fetch. */
export function loadGlossary(): Promise<GlossaryData | null> {
  if (!cache) {
    cache = fetch('/data/glossary.json')
      .then((r) => {
        if (!r.ok) throw new Error(`glossary: HTTP ${r.status}`)
        return r.json()
      })
      .then((data: unknown) => (isValidGlossary(data) ? data : null))
      .catch(() => null)
  }
  return cache
}

/** Opens the Glossary bottom sheet, mounted into document.body. Returns a
 *  handle so a caller could close it programmatically, though none
 *  currently need to (mirrors ui/howto.ts's openHowTo() shape).
 *
 *  maxHeightVh 68: the shared panel caps itself at 80dvh and this sheet's own
 *  chrome (grabber + header + the panel's padding) runs ~10dvh on a phone, so
 *  68 keeps the body scrolling INSIDE that cap rather than fighting it —
 *  the same body-only bound the Map tab's goal sheet passes at 62.
 *
 *  `term` (P7a, 2026-08-14) — OPTIONAL anchor. Given, the sheet scrolls that
 *  entry into view and marks it (see .pg-glossary-term-hit) once the fetch
 *  lands; unknown/absent, it opens at the top exactly as it always has. This
 *  is what makes a goal step's technique chip land ON its definition instead
 *  of dumping the visitor at the top of a 70-term list to hunt for the word
 *  they just tapped. Parameter, not a second entry point, so app.ts's header
 *  "Glossary" chip and ar/arview.ts's keep calling openGlossary(). */
export function openGlossary(term?: string): { destroy(): void } {
  const body = document.createElement('div')
  body.className = 'pg-glossary-body'

  const filterRow = document.createElement('div')
  filterRow.className = 'pg-glossary-filter-row'
  const filterInput = document.createElement('input')
  filterInput.type = 'search'
  filterInput.className = 'pg-glossary-filter'
  filterInput.placeholder = 'Search terms'
  filterInput.setAttribute('aria-label', 'Filter glossary terms')
  filterRow.appendChild(filterInput)

  const list = document.createElement('div')
  list.className = 'pg-glossary-list'
  const loading = document.createElement('div')
  loading.className = 'state-message'
  loading.textContent = 'Loading…'
  list.appendChild(loading)

  body.append(filterRow, list)

  let destroyed = false
  let sheet: SheetHandle | null = null
  function close(): void {
    if (destroyed) return
    destroyed = true
    sheet?.destroy()
    sheet = null
  }

  sheet = createSheet(document.body, {
    title: 'Glossary',
    maxHeightVh: 68,
    variant: 'overlay',
    closeButton: true,
    closeLabel: 'Close glossary',
    onDismiss: close,
  })
  sheet.setBody(body)

  void loadGlossary().then((data) => {
    if (destroyed) return
    if (!data) {
      renderUnavailable(list)
      return
    }
    const anchor = term ? findTerm(data, term) : null
    const anchored = renderTermList(list, data, '', anchor)
    if (anchored) {
      anchored.classList.add('pg-glossary-term-hit')
      // Optional-call: this app's suites drive the real modules against
      // hand-rolled fake elements (ui/sheet.ts's own focusableWithin makes the
      // same allowance), and a browser-only line is a line no test can prove.
      // Default behaviour, never 'smooth' — an instant scroll needs no
      // reduced-motion branch. `center` because the entry is one row of many:
      // landing it mid-sheet shows the neighbours it sits between.
      anchored.scrollIntoView?.({ block: 'center' })
    }
    // NOTE the filter re-render passes no anchor: once the visitor types, the
    // list is theirs, and re-marking a row they did not ask about would fight
    // their query.
    filterInput.addEventListener('input', () => renderTermList(list, data, filterInput.value))
  })

  return { destroy: close }
}

function renderUnavailable(list: HTMLElement): void {
  list.innerHTML = ''
  const msg = document.createElement('div')
  msg.className = 'state-message'
  msg.textContent = 'Glossary unavailable'
  list.appendChild(msg)
}

/** Renders the (optionally filtered) term list into `list`. Returns the row
 *  element rendered for `anchor`, when that term survived the filter — so the
 *  caller can scroll/mark it without a selector engine (see ui/sheet.ts's
 *  focusableWithin for the same constraint). Null in every other case. */
function renderTermList(
  list: HTMLElement,
  data: GlossaryData,
  query: string,
  anchor: GlossaryTerm | null = null,
): HTMLElement | null {
  list.innerHTML = ''
  let shown = 0
  let anchorRow: HTMLElement | null = null

  for (const cat of data.categories) {
    const filtered = sortTermsAlpha(cat.terms).filter((t) => matchesFilter(t, query))
    if (filtered.length === 0) continue
    shown += filtered.length

    const section = document.createElement('div')
    section.className = 'pg-glossary-section'

    const sectionHeader = document.createElement('div')
    sectionHeader.className = 'pg-glossary-section-header'
    const dot = document.createElement('span')
    dot.className = 'pg-glossary-section-dot'
    dot.style.background = colorForCategory(cat.id)
    const label = document.createElement('span')
    label.className = 'pg-glossary-section-title'
    label.textContent = `${cat.title} · ${filtered.length}`
    sectionHeader.append(dot, label)
    section.appendChild(sectionHeader)

    for (const t of filtered) {
      const row = renderTermRow(t)
      // Identity, not name equality: findTerm returned an object out of THIS
      // data, so the row that carries it is the row to scroll to even if two
      // categories ever spell a term the same way.
      if (t === anchor) anchorRow = row
      section.appendChild(row)
    }
    list.appendChild(section)
  }

  if (shown === 0) {
    const msg = document.createElement('div')
    msg.className = 'state-message'
    msg.textContent = 'No matching terms.'
    list.appendChild(msg)
  }

  return anchorRow
}

function renderTermRow(t: GlossaryTerm): HTMLElement {
  const row = document.createElement('div')
  row.className = 'pg-glossary-term'

  const head = document.createElement('div')
  head.className = 'pg-glossary-term-head'
  const name = document.createElement('span')
  name.className = 'pg-glossary-term-name'
  name.textContent = t.term
  head.appendChild(name)
  if (t.aliases && t.aliases.length > 0) {
    const aliases = document.createElement('span')
    aliases.className = 'pg-glossary-term-aliases'
    aliases.textContent = t.aliases.join(', ')
    head.appendChild(aliases)
  }

  const def = document.createElement('p')
  def.className = 'pg-glossary-term-def'
  def.textContent = t.def

  row.append(head, def)
  return row
}
