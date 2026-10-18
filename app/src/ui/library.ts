// ui/library.ts — the Machine Library (P6, 2026-08-14).
//
// WHAT THIS REPLACES. Until now the only way to change machine was a native
// `<select>` in the header holding 134 `<option>` rows. On a phone that renders
// as an OS wheel picker: no search, no thumbnails, no memory of what you play,
// no way to tell a 1977 Gottlieb from a 2024 Stern, and no route from the app
// to the SEO guide page that was written for the same machine. Picking a table
// is the single most common thing a visitor does in an arcade, and it was the
// least considered surface in the app.
//
// SHAPE: a full-screen overlay on document.body at z-200 — the same shell
// ui/howto.ts uses, not the bottom sheet (ui/sheet.ts). Two reasons. A sheet
// capped at ~62vh would show a handful of rows of a 134-machine list, and the
// overlay's contents are a whole screen's worth of navigation rather than a
// detail panel over something you are still looking at. It is deliberately NOT
// a fifth tab either: the tab bar is 38px of hard-won vertical space, and
// picking a machine is a pass-through context switch, not a place you dwell.
//
// THE BODY IS A LIST, NOT A GRID (2026-08-14). It shipped as a 2-up grid of
// playfield cards. rolo, using it on an arcade floor the next morning: "I like
// the new look, but showing the playfields for each game makes it harder to
// find the game … there needs to be a drop down for the games to pick from …
// searching via a scrolling list was very helpful and we need that back." He
// chose compact rows plus an iPhone-contacts A-Z rail from the options put to
// him, and that is what this is. The grid is REMOVED, not toggled: a rejected
// design left behind a flag is a rejected design you ship twice.
//
// MOUNT-ONCE / HIDE, not build-and-destroy: painted thumbnail canvases (P6 L4)
// survive a close, so re-opening is instant and repaints nothing.
//
// DATA: /data/library.json, generated at build time by
// app/scripts/gen-library.mjs — coordinates and counts, no prose (that
// generator's header explains why that is a property of the code and not a
// promise). FAIL-SOFT: if the fetch fails, the library still opens, built from
// the in-memory catalog the app booted with; it simply has no thumbnails. A
// machine picker that cannot open because a decoration failed to download
// would be a worse product than the `<select>` it replaced.

import './library.css'
import type { AppState } from '../state'
import type { Machine } from '../models'
// Memoized /whoami (ui/session.ts) — the SAME call the Achievements tab and
// the account overlay share, so asking here costs nothing extra.
import { getSession } from './session'
// The playfield card's own colours, MIRRORED from styles.css's :root (see
// theme.ts's header). Imported, never re-typed: app/tests/tokens.test.mjs
// asserts these three hexes appear in exactly two files under app/src, so a
// call site that pastes #071834 instead of importing CARD_GRADIENT_A fails the
// build. That is also why the thumbnail card looks like the map's card without
// anyone having to remember to keep them in step.
import { CARD_GRADIENT_A, CARD_GRADIENT_B } from '../theme'
import { containsNode } from './focusRing'

// ---------------------------------------------------------------------------
// The build-time index (data/library.json). Types live HERE, not in models.ts:
// models.ts describes the *_goals.json dataset that the native apps share,
// while this file's schema is a web-only build artifact of this one feature.
// Keep in step with app/scripts/gen-library.mjs's LIBRARY_SHAPE.
// ---------------------------------------------------------------------------

/** One shot's position. `p` marks a shot sitting on a raised/sunken deck. */
export interface LibraryShot {
  x: number
  y: number
  p?: 1
}

export interface LibraryZone {
  x: number
  y: number
  w: number
  h: number
  k: string
}

export interface LibraryFlipper {
  x: number
  y: number
  s: 'l' | 'r'
}

export interface LibraryEntry {
  id: string
  /** Full catalog display name — what the header button shows. */
  name: string
  /** The name with its "(Manufacturer, Year)" tail removed — what a card shows. */
  title: string
  shortTitle: string
  mfr: string
  mfrGroup: string
  year: number
  goals: number
  ach: number
  zones: LibraryZone[]
  flippers: LibraryFlipper[]
  /** Where the machine's plunge sits across the table, or null when it models
   *  none. CARRIED, NOT DRAWN since 2026-08-14: drawThumb used to paint a
   *  shooter-lane channel from it and no longer paints anything from it (see
   *  the note in drawThumb). The field stays because the fact is real and the
   *  generator/validator already publish it. */
  plungeX: number | null
  shots: LibraryShot[]
}

interface LibraryDoc {
  v: number
  machines: LibraryEntry[]
}

/** The schema version this file knows how to read. A document announcing
 *  anything else is treated exactly like a failed fetch (fall back to the
 *  catalog) rather than being parsed on optimism. */
const LIBRARY_SCHEMA_VERSION = 1

/** How many Recent rows the default view shows.
 *
 *  In practice fewer: state.ts caps `recentMachineIds` at RECENT_MACHINES_CAP
 *  (6) INCLUDING the machine currently loaded, and the current machine has its
 *  own strip at the top of this overlay, so it is filtered out of this section
 *  rather than shown twice. Six is therefore a ceiling this rarely reaches, not
 *  a target. */
const RECENT_SHOWN = 6

/** How many Pinned rows the browse view shows before it defers to the chip.
 *
 *  There is no cap on how many machines a visitor may star, and without one
 *  here a visitor who starred the whole catalog would get every machine
 *  rendered twice on one screen (Pinned, then All machines) — twice the rows
 *  and twice the painted bitmaps, for a section that exists to surface a
 *  handful. 30 is well past what "the ones I care about" means in practice and
 *  still bounded; anything beyond it is one tap away on the Pinned chip, which
 *  is not capped. */
const PINNED_SHOWN = 30

// ---------------------------------------------------------------------------
// Pure helpers — exported for app/tests/library.test.mjs, which drives them as
// arithmetic rather than through a mounted overlay.
// ---------------------------------------------------------------------------

/**
 * Search folding: case, diacritics and separators all stop mattering.
 *
 * Every part of this is a real machine in the catalog, not a hypothetical:
 *   - diacritics: "Pokémon" must be findable by typing `pokemon`
 *   - the interpunct: "The Machine: Bride of Pin·Bot" by typing `pin bot`
 *   - hyphens/underscores: "Black Knight 2000" vs `black-knight`
 *   - apostrophes: "Elvira's House of Horrors" by typing `elviras`
 *
 * Separators collapse to a SINGLE SPACE rather than to nothing, because the
 * query is then matched token-by-token (see matchesQuery): removing spaces
 * entirely would make "attack mars" fail against "attackfrommars", which is
 * exactly the kind of half-remembered title people actually type.
 */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    // Unicode combining marks — what NFD just split "é" into (e + U+0301).
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Apostrophes CLOSE UP ("elvira's" -> "elviras") rather than becoming a
    // space, so the possessive stays one token.
    .replace(/['’]/g, '')
    .replace(/[-_·:.,\/&!?()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Two rules, OR'd, because people type a title two different ways.
 *
 * 1. EVERY TOKEN PRESENT. Word order does not matter ("mars attack" finds
 *    Attack from Mars) and a partial word still narrows ("godz" finds
 *    Godzilla).
 * 2. RUN-TOGETHER FALLBACK, for a single-token query only: the query is also
 *    tried against the haystack with its separators removed. This is what
 *    makes `acdc` find "AC/DC" and `pinbot` find "The Machine: Bride of
 *    Pin·Bot" — the punctuation the title carries is invisible to someone
 *    typing it from memory, and rule 1 alone rejects both (the folded
 *    haystacks are "ac dc" and "… pin bot", which do not contain "acdc" or
 *    "pinbot" as substrings).
 *
 * ONLY THE HAYSTACK COLLAPSES — never the query. That asymmetry is what keeps
 * rule 2 from inventing matches across word boundaries: a query the visitor
 * typed WITH a space still carries that space, so it cannot be found inside a
 * haystack that has had all of its separators removed. "kfr om" therefore does
 * not match "Attack from Mars", while "kfrom" does. (An earlier draft also
 * guarded on `tokens.length === 1`; a seeded mutation proved that condition
 * could never change an outcome — the asymmetry above already enforces it — so
 * it is gone rather than left as a line that looks load-bearing and is not.)
 *
 * The mirror direction needs no special case either: "ac dc" typed against a
 * hypothetical "ACDC" haystack matches under rule 1, because both tokens are
 * substrings of it.
 */
export function matchesQuery(foldedHaystack: string, query: string): boolean {
  const q = foldText(query)
  if (!q) return true
  if (q.split(' ').every((token) => foldedHaystack.includes(token))) return true
  return foldedHaystack.split(' ').join('').includes(q)
}

/** The searchable text for one machine: title, short title, maker (as written
 *  AND folded to its family, so `stern` finds a "Stern Pinball" machine) and
 *  year. */
export function haystackFor(e: LibraryEntry): string {
  return foldText(`${e.title} ${e.shortTitle} ${e.mfr} ${e.mfrGroup} ${e.year}`)
}

/** A-Z sort key that ignores a leading article, so The Evil Dead files under
 *  E and The Addams Family under A.
 *
 *  This rule came from rolo (2026-08-11): he could not find Evil Dead in the
 *  old `<select>` because 14 machines were hiding under T. It lived in app.ts's
 *  sortedByName, which existed only to order that select's options; the select
 *  is gone as of this file, so the rule moved here with it. */
export function machineSortKey(name: string): string {
  return name.replace(/^the\s+/i, '')
}

export function sortForDisplay(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort((a, b) =>
    machineSortKey(a.title).localeCompare(machineSortKey(b.title), undefined, { sensitivity: 'base' }),
  )
}

// ---------------------------------------------------------------------------
// Letter sections and the A-Z rail (2026-08-14, owner feedback).
//
// WHY THIS EXISTS. The browse scroller was a 2-up grid of playfield thumbnails.
// rolo, using it in an arcade: "showing the playfields for each game makes it
// harder to find the game … searching via a scrolling list was very helpful and
// we need that back." A thumbnail grid answers "what does this table look
// like"; picking a machine asks "where is the name I already have in my head".
// Those are different questions and the grid was answering the wrong one.
//
// So the scroller is a list of compact NAME-first rows, and the way you cross 134
// of them quickly is the iPhone-contacts index: letter headers down the list
// and a continuous A-Z rail down the right edge. That pattern is what rolo
// picked from the options put to him.
// ---------------------------------------------------------------------------

/** The letter a machine files under, using the SAME strip-"The" key the sort
 *  uses — so "The Addams Family" sits under A, next to where its name actually
 *  sorted. A title that does not start with a letter groups under '#'. */
export function letterFor(title: string): string {
  const ch = machineSortKey(title).trim().charAt(0).toUpperCase()
  return ch >= 'A' && ch <= 'Z' ? ch : '#'
}

export interface LetterGroup {
  letter: string
  entries: LibraryEntry[]
}

/**
 * Splits an ALREADY-SORTED list into runs of the same letter.
 *
 * Derived from the array's own order rather than from an alphabet, which is
 * what keeps the rail honest: the rail lists letters in the order the list
 * presents them, so a '#' group (which localeCompare sorts before A) leads the
 * rail as well as the list. Today's catalog has no such title — 134 machines,
 * all A-Z — but the grouping is generic so the first one to arrive files itself
 * without anybody editing this.
 */
export function groupByLetter(sorted: readonly LibraryEntry[]): LetterGroup[] {
  const out: LetterGroup[] = []
  for (const e of sorted) {
    const letter = letterFor(e.title)
    const last = out[out.length - 1]
    if (last && last.letter === letter) last.entries.push(e)
    else out.push({ letter, entries: [e] })
  }
  return out
}

export const RAIL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** Every letter the rail offers: the full alphabet always (a letter with no
 *  machines renders dimmed, so the rail's geometry does not shift as filters
 *  change under the finger), plus '#' at the FRONT when the list actually opens
 *  with one — the same order groupByLetter produced. */
export function railLetters(groups: readonly LetterGroup[]): string[] {
  const hasHash = groups.some((g) => g.letter === '#')
  return hasHash ? ['#', ...RAIL_ALPHABET] : [...RAIL_ALPHABET]
}

/**
 * How many rows the A-Z view needs before the rail earns its column.
 *
 * A 390x844 phone shows ~15 of these 48px rows at once. Under 20 the whole list
 * is one-and-a-half swipes, and a 27-letter index down the side of it is a
 * control that costs a column and saves nothing — noise, in the task's words.
 * 20 is that break-even rounded to where the second swipe starts.
 */
export const RAIL_MIN_ROWS = 20

/**
 * Is this render a LETTERED one — letter headers in the list AND the rail
 * beside it? The two ship together on purpose: a header with no rail is
 * clutter, and a rail with nothing to jump to is a dead control.
 *
 * NEVER while a search is running. A query is already a jump-to-what-you-mean,
 * the results are ranked by nothing alphabetical in the visitor's head, and
 * "S" over four matches is a worse index than the four matches themselves.
 */
export function showRail(opts: { query: string; rows: number }): boolean {
  return foldText(opts.query) === '' && opts.rows >= RAIL_MIN_ROWS
}

/**
 * Which of `count` equal zones down a rail of `height` px starting at `top`
 * contains `y` — the whole of the rail's hit-testing, as arithmetic.
 *
 * CLAMPED rather than rejected outside the rail: a finger that drags past
 * either end of the index pins to the first or last letter instead of dropping
 * the scrub, which is what every contacts list on the platform does and what a
 * thumb travelling fast down the edge of a phone actually produces.
 */
export function railIndexAt(y: number, top: number, height: number, count: number): number {
  if (count <= 0 || height <= 0) return -1
  const i = Math.floor(((y - top) / height) * count)
  return Math.max(0, Math.min(count - 1, i))
}

/** A filter chip. `kind` drives the predicate; `value` carries the decade or
 *  maker group it names. */
export interface LibraryFilter {
  kind: 'all' | 'pinned' | 'recent' | 'decade' | 'maker'
  value?: string
  label: string
}

export const ALL_FILTER: LibraryFilter = { kind: 'all', label: 'All' }

/**
 * The chip row, derived from the entries themselves — never a hardcoded list
 * of decades or makers, so a new machine from a maker nobody has registered
 * before brings its own chip with it.
 *
 * Order: All · Pinned · Recent, then decades oldest-first, then maker groups
 * by how many machines each holds. Makers are sorted by size rather than
 * alphabetically because the row scrolls horizontally: putting Stern (49) and
 * Williams (30) first means the chips most people want are reachable without
 * scrolling, and the long tail (Capcom, one machine) is where a tail belongs.
 *
 * Pinned/Recent chips are omitted when the visitor has neither — a filter that
 * can only ever return nothing is a dead control.
 */
export function buildFilters(
  entries: readonly LibraryEntry[],
  opts: { hasPinned: boolean; hasRecent: boolean },
): LibraryFilter[] {
  const out: LibraryFilter[] = [ALL_FILTER]
  if (opts.hasPinned) out.push({ kind: 'pinned', label: 'Pinned' })
  if (opts.hasRecent) out.push({ kind: 'recent', label: 'Recent' })

  const decades = new Set<number>()
  const makers = new Map<string, number>()
  for (const e of entries) {
    if (Number.isFinite(e.year)) decades.add(Math.floor(e.year / 10) * 10)
    makers.set(e.mfrGroup, (makers.get(e.mfrGroup) ?? 0) + 1)
  }
  for (const d of [...decades].sort((a, b) => a - b)) {
    out.push({ kind: 'decade', value: String(d), label: `${d}s` })
  }
  for (const [maker] of [...makers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out.push({ kind: 'maker', value: maker, label: maker })
  }
  return out
}

/** Does this machine pass the active chip? */
export function passesFilter(
  e: LibraryEntry,
  filter: LibraryFilter,
  lists: { pinned: readonly string[]; recent: readonly string[] },
): boolean {
  switch (filter.kind) {
    case 'pinned':
      return lists.pinned.includes(e.id)
    case 'recent':
      return lists.recent.includes(e.id)
    case 'decade':
      return String(Math.floor(e.year / 10) * 10) === filter.value
    case 'maker':
      return e.mfrGroup === filter.value
    default:
      return true
  }
}

export interface LibrarySection {
  /** null on the single flat list a search/filter produces. */
  title: string | null
  /** Stable identifier for this section, used as half of the thumbnail cache
   *  key: one machine can appear in two sections at once, and each occurrence
   *  is a separate live canvas element. */
  slot: 'pinned' | 'recent' | 'all'
  entries: LibraryEntry[]
  /** Pinned only: how many pins are NOT shown because the section is capped. */
  overflow?: number
}

/**
 * What the scroller renders.
 *
 * TWO MODES, deliberately. With no query and the All chip active, the view is
 * SECTIONED — Pinned, then Recent, then everything A-Z — because that is a
 * browse surface and the visitor's own machines should be at the top of it.
 * The moment a search or a filter is active the sections COLLAPSE to one flat
 * ranked list: a query that matches two pinned machines and one other would
 * otherwise render three sections of one row each, which reads as a bug.
 *
 * The current machine is excluded from Recent (it has its own strip at the top
 * of the overlay) but not from the A-Z list, where its absence would be the
 * strange thing.
 */
export function computeSections(
  entries: readonly LibraryEntry[],
  opts: {
    query: string
    filter: LibraryFilter
    pinned: readonly string[]
    recent: readonly string[]
    currentId: string | null
  },
): LibrarySection[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const matching = entries.filter(
    (e) => matchesQuery(haystackFor(e), opts.query) && passesFilter(e, opts.filter, opts),
  )
  const searching = foldText(opts.query) !== '' || opts.filter.kind !== 'all'
  // SLOT 'all', not a slot of its own: searching COLLAPSES the sections, so a
  // machine can never occupy a results row and an A-Z row at the same time.
  // Sharing the key is what lets the FIRST keystroke reuse the browse view's
  // already-painted thumbnails instead of repainting every visible row.
  if (searching) return [{ title: null, slot: 'all', entries: sortForDisplay(matching) }]

  const sections: LibrarySection[] = []
  const allPinned = opts.pinned.map((id) => byId.get(id)).filter((e): e is LibraryEntry => !!e)
  if (allPinned.length) {
    // CAPPED. Nothing stops a visitor starring every machine in the catalog,
    // and an uncapped Pinned section would then render the whole catalog TWICE
    // — once here and once under All machines — doubling the rows, the
    // thumbnails and the bitmaps for a section whose whole point is "the few
    // you care about". The overflow row below routes to the Pinned CHIP, which
    // is uncapped, so nothing is unreachable.
    sections.push({
      title: 'Pinned',
      slot: 'pinned',
      entries: allPinned.slice(0, PINNED_SHOWN),
      overflow: Math.max(0, allPinned.length - PINNED_SHOWN),
    })
  }
  const recent = opts.recent
    .filter((id) => id !== opts.currentId)
    .map((id) => byId.get(id))
    .filter((e): e is LibraryEntry => !!e)
    .slice(0, RECENT_SHOWN)
  if (recent.length) sections.push({ title: 'Recent', slot: 'recent', entries: recent })
  sections.push({ title: 'All machines', slot: 'all', entries: sortForDisplay(matching) })
  return sections
}

/** Manufacturer -> the family a chip names. MIRRORS gen-library.mjs's
 *  MFR_GROUPS, and is only ever consulted on the fail-soft path below.
 *
 *  It has to exist, and being a duplicate is the lesser evil. Without it the
 *  fallback chip row splits into "Stern" AND "Stern Pinball" (and Sega, and
 *  Jersey Jack) — the catalog carries both spellings because the machines were
 *  registered at different times, and two chips holding 11 and 49 machines is a
 *  bug that reads as a dataset error. Caught by running the suite's own
 *  index-404 test and reading the chips it reported, not by inspection. */
const MFR_GROUPS: Record<string, string> = {
  'Stern Pinball': 'Stern',
  'Sega Pinball': 'Sega',
  'Jersey Jack Pinball': 'Jersey Jack',
  'Spooky Pinball': 'Spooky',
  'Chicago Gaming Company': 'Chicago Gaming',
}

/**
 * The FAIL-SOFT index: everything the library can know from the catalog the app
 * already booted with, when /data/library.json could not be fetched or is a
 * version this build does not understand.
 *
 * The name regex mirrors gen-library.mjs's NAME_RE on purpose. It is four lines
 * of duplication in exchange for the library still opening — with working
 * search, working maker and decade chips, and only the thumbnails missing — on
 * a connection too poor to fetch a 16 KB file. A machine whose name does not
 * parse keeps an empty maker and a year of 0, and simply never matches a
 * maker/decade chip; it is still listed, still searchable, still pickable.
 */
export function entriesFromCatalog(machines: readonly Machine[]): LibraryEntry[] {
  return machines.map((m) => {
    const parsed = /^(.+) \(([^,()]+), (\d{4})\)$/.exec(m.name)
    const mfr = parsed ? parsed[2]! : ''
    return {
      id: m.id,
      name: m.name,
      title: parsed ? parsed[1]! : m.name,
      shortTitle: m.shortTitle,
      mfr,
      mfrGroup: MFR_GROUPS[mfr] ?? mfr,
      year: parsed ? Number(parsed[3]) : 0,
      goals: 0,
      ach: 0,
      zones: [],
      flippers: [],
      plungeX: null,
      shots: [],
    }
  })
}

// ---------------------------------------------------------------------------
// drawThumb — the mini-playfield micro-renderer (P6 L4).
// ---------------------------------------------------------------------------

/** Highest devicePixelRatio a thumbnail is painted at.
 *
 *  A 3x phone painting a list of small thumbnails at full ratio costs 2.25x
 *  the pixels of 2x for detail that is, at this size, below what the eye
 *  resolves — the whole image is a handful of dots and two wedges. The cap is on the
 *  RATIO, not the size, so the thumbnail still fills its box exactly. */
export const THUMB_DPR_CAP = 2

/**
 * Size used when a canvas is painted before layout has given it one (the
 * no-IntersectionObserver fallback path). 3:4, matching the CSS aspect-ratio.
 *
 * 30, not the 132 the card grid used, because the browse scroller is now 134 ROWS
 * whose accent is a 30x40 sliver and one strip thumbnail at 44. That path
 * paints EVERY thumbnail at once, so the fallback size is multiplied by 134:
 * at 132 CSS px it allocates 363 KB per canvas (measured, DPR 2) — 48 MB — for
 * bitmaps that CSS then shrinks into a 30px box. Guessing small costs one
 * strip thumbnail a 1.5x upscale on a browser old enough to lack
 * IntersectionObserver. Guessing large costs the device its memory.
 */
const THUMB_FALLBACK_W = 30

/**
 * Shot-dot radius for a thumbnail `w` CSS px wide — ~1% of the width, clamped.
 *
 * MEASURED, against all 134 machines in data/library.json (median 24 shots):
 * a FIXED 1.6px dot covers 0.59% of a 158x211 grid card and 16.42% of a 30x40
 * row accent — 28x the relative ink for the same drawing. At that density the
 * flipper wedge (0.13 UV = 3.9px of reach) is only 1.22x a dot's diameter, so
 * the one landmark the image is read against stops being distinguishable from
 * the shots around it, and the constellation — the whole point of the thumbnail
 * — turns to speckle.
 *
 * The ceiling keeps every existing card and the 150x200 the drawThumb tests
 * drive at exactly 1.6, so nothing about the large thumbnails moved. The floor
 * is what a dot still needs to READ: 0.6 CSS px is 1.2 device px at the DPR-2
 * cap, and anything under one device pixel is antialiased into the plate rather
 * than drawn on it. At the floor a 30x40 accent lands at 2.31% coverage.
 *
 * (The alternative — keep painting at card size and let CSS shrink the cached
 * canvas — was measured and rejected: 521 KB per thumbnail instead of 18.8 KB,
 * and the 5.27x downsample puts a 1.6px dot on 1.22 device pixels, which is the
 * same disappearing act by a more expensive route.)
 */
export function dotRadiusFor(w: number): number {
  return Math.max(0.6, Math.min(1.6, w / 90))
}

/**
 * Paint one machine's playfield into `ctx`, in a `w` x `h` CSS-pixel box.
 *
 * NOT overlay/map2d.ts's drawPlayfieldArt, and the reasons are worth stating
 * because "reuse the real renderer" is the obvious first instinct:
 *   - it lives in the 48 KB map2d chunk, which this overlay would then have to
 *     drag in just to draw postage stamps;
 *   - it needs full `Shot` objects (types, feeds, apexes, trims, names) — the
 *     whole dataset — where this has coordinates;
 *   - and at 120 px its output is not legible anyway. Lane curves, insert
 *     shapes, bumper rings and slingshot triangles all collapse into the same
 *     grey smudge at a tenth of the size they were designed for.
 *
 * SHOTS ARE PLAIN DOTS, ON PURPOSE (1.6 px at card size, scaled down for the
 * row accent — see dotRadiusFor). The BACKGLASS reskin gives the map
 * neon "insert" shapes per shot family, and reproducing them here was tried and
 * rejected: at this scale a 3 px rounded rectangle and a 3 px circle are the
 * same three pixels, so the shapes carry no information and only add noise to
 * an image whose whole job is "which table is this". What DOES identify a table
 * at a glance is the constellation — the arrangement of shots, and whether
 * there is a deck — and that is exactly what this draws. Deck shots (p:1) drop
 * to a lower alpha so the plate under them still reads.
 *
 * Everything drawn comes from the machine's own data. No shots, no dots; no
 * zones, no plates. (The shooter-lane channel that used to be drawn from
 * `plungeX` was deleted 2026-08-14 — see the note where it stood.)
 */
export function drawThumb(ctx: CanvasRenderingContext2D, entry: LibraryEntry, w: number, h: number): void {
  // UV -> thumb pixels. u runs left->right; v runs FLIPPERS->BACK, and canvas y
  // grows downward, so v is inverted — the same mapping overlay/map2d.ts's
  // MapFn contract defines (models.ts).
  const pad = 1
  const iw = w - pad * 2
  const ih = h - pad * 2
  const mx = (u: number): number => pad + u * iw
  const my = (v: number): number => pad + (1 - v) * ih

  // ---- the card itself: the map's own gradient, corner to corner ----------
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, CARD_GRADIENT_A)
  grad.addColorStop(1, CARD_GRADIENT_B)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // ---- NO SHOOTER LANE (deleted 2026-08-14, with the map's) --------------
  // A dark channel down whichever side `plungeX` sat on used to be the first
  // thing drawn here. rolo: "I don't like the tiny ramp on the side on
  // playfields that show the plunger ramp. Remove those everywhere" — and
  // "everywhere" includes these postage stamps, which is where the strip was
  // LEAST defensible: at 30x40 the accent it drew was a tenth of the image's
  // width, spent on the one region of a playfield nobody aims into.
  //
  // `plungeX` STAYS on LibraryEntry and in library.json (gen-library.mjs still
  // emits it, tests/gen-library.test.mjs still validates it): the DATA is a
  // real fact about the machine and cheap to carry, and dropping a published
  // field to delete a drawing would be a schema change dressed up as a visual
  // fix. Nothing paints it any more, here or in overlay/map2d.ts.

  // ---- deck plates: the footprint only, no label -------------------------
  for (const z of entry.zones) {
    const x = mx(z.x)
    const y = my(z.y + z.h)
    const zw = z.w * iw
    const zh = z.h * ih
    ctx.fillStyle = z.k === 'lower' ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 255, 255, 0.06)'
    ctx.fillRect(x, y, zw, zh)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, zw - 1), Math.max(0, zh - 1))
  }

  // ---- the flipper pair: the landmark the whole image is read against -----
  // Same red bat and the same 0.13 UV reach map2d.ts's paintFlipper uses, drawn
  // as a straight wedge rather than its four-point shape (the taper is under a
  // pixel here).
  for (const f of entry.flippers) {
    const inward = f.s === 'l' ? 1 : -1
    const tip = f.x + 0.13 * inward
    ctx.beginPath()
    ctx.moveTo(mx(f.x), my(f.y + 0.022))
    ctx.lineTo(mx(tip), my(f.y - 0.016))
    ctx.lineTo(mx(tip), my(f.y - 0.036))
    ctx.lineTo(mx(f.x), my(f.y - 0.014))
    ctx.closePath()
    ctx.fillStyle = 'rgba(195, 63, 42, 0.85)'
    ctx.fill()
  }

  // ---- the shots ---------------------------------------------------------
  const dotR = dotRadiusFor(w)
  for (const s of entry.shots) {
    ctx.beginPath()
    ctx.arc(mx(s.x), my(s.y), dotR, 0, Math.PI * 2)
    ctx.fillStyle = s.p === 1 ? 'rgba(178, 214, 255, 0.34)' : 'rgba(178, 214, 255, 0.66)'
    ctx.fill()
  }

  // ---- border ------------------------------------------------------------
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1))
}

/**
 * Which canvases have actually been painted.
 *
 * A WeakSet, and NOT `canvas.width > 0`, which is the obvious-looking test and
 * is wrong: a freshly created `<canvas>` reports the spec's default 300x150
 * before anything has ever been drawn into it, so that check marks every blank
 * canvas as finished and the cache below never paints anything. (The fake DOM
 * in app/tests/library.test.mjs left `width` undefined, which HID this — the
 * harness now models the 300x150 default so it cannot hide it again.)
 */
const paintedThumbs = new WeakSet<HTMLCanvasElement>()

/** Has this canvas already had a thumbnail drawn into it? Exported so the
 *  cache-hit path and the tests ask the same question. */
export function isThumbPainted(canvas: HTMLCanvasElement): boolean {
  return paintedThumbs.has(canvas)
}

/** Sizes a canvas to its laid-out box at a capped ratio and paints it.
 *  Returns whether anything was drawn — false when there is no 2D context
 *  (canvas unsupported) or the entry has no geometry to draw. */
export function paintThumbCanvas(canvas: HTMLCanvasElement, entry: LibraryEntry): boolean {
  if (entry.shots.length === 0 && entry.flippers.length === 0) return false
  const cssW = canvas.clientWidth || THUMB_FALLBACK_W
  const cssH = canvas.clientHeight || Math.round((cssW * 4) / 3)
  const dpr = Math.min(THUMB_DPR_CAP, window.devicePixelRatio || 1)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  // Draw in CSS pixels; the transform does the ratio. Set rather than
  // multiplied, so a repaint of the same canvas cannot compound the scale.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawThumb(ctx, entry, cssW, cssH)
  paintedThumbs.add(canvas)
  return true
}

/** Card meta line: "STERN · 2024", or just the maker/year that is known. */
export function metaLineFor(e: LibraryEntry): string {
  const parts: string[] = []
  if (e.mfrGroup) parts.push(e.mfrGroup.toUpperCase())
  if (e.year) parts.push(String(e.year))
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// The index fetch (memoized for the page's lifetime).
// ---------------------------------------------------------------------------

let indexPromise: Promise<LibraryEntry[] | null> | null = null

/** Resolves to the build-time index, or null when it could not be used for any
 *  reason at all (offline, 404, malformed, wrong schema version). NEVER
 *  rejects — every caller's fallback is the same, and a rejection here would
 *  only be an unhandled one. */
export function fetchLibraryIndex(): Promise<LibraryEntry[] | null> {
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const r = await fetch('/data/library.json')
        if (!r.ok) return null
        const doc = (await r.json()) as LibraryDoc
        if (!doc || doc.v !== LIBRARY_SCHEMA_VERSION || !Array.isArray(doc.machines)) return null
        return doc.machines
      } catch {
        return null
      }
    })()
  }
  return indexPromise
}

// ---------------------------------------------------------------------------
// Progress badges (P6 L5) — how far the visitor has got on each machine.
// ---------------------------------------------------------------------------

/** machineId -> how many of its achievements are recorded as done. */
export type ProgressCounts = Record<string, number>

/**
 * Collapses the server's progress blob (`{ machineId: { achId: epochMs } }` —
 * ui/achievements.ts owns the format) into one count per machine.
 *
 * Shape-guarded rather than trusted: a machine whose value is not an object of
 * timestamps contributes nothing instead of throwing inside a render. The
 * count is NOT clamped here — the denominator is not known at this layer — but
 * the badge clamps it, because an id recorded for an achievement the dataset
 * has since dropped would otherwise render "13/12".
 */
export function countProgress(blob: unknown): ProgressCounts {
  const out: ProgressCounts = {}
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return out
  for (const [machineId, perMachine] of Object.entries(blob as Record<string, unknown>)) {
    if (!perMachine || typeof perMachine !== 'object' || Array.isArray(perMachine)) continue
    const done = Object.values(perMachine as Record<string, unknown>).filter(
      (ts) => typeof ts === 'number' && Number.isFinite(ts),
    ).length
    if (done > 0) out[machineId] = done
  }
  return out
}

/** ONE request, only for a signed-in visitor, and never rejecting: badges are
 *  an enhancement, and a library that failed to open because a progress fetch
 *  404'd would be a bad trade. Resolves null when signed out or unavailable —
 *  which is the difference between "no badges" and "0/12 everywhere". */
export async function fetchProgress(): Promise<ProgressCounts | null> {
  try {
    const session = await getSession()
    if (!session) return null
    const r = await fetch('/api/achievements', { credentials: 'same-origin' })
    if (!r.ok) return null
    return countProgress((await r.json()) as unknown)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The overlay.
// ---------------------------------------------------------------------------

/** Where focus lands on open. See openLibrary's own note for why this is not
 *  one fixed answer. */
export type LibraryFocus = 'close' | 'search'

interface LibraryHandle {
  show(opener: HTMLElement | null, focus: LibraryFocus): void
}

let handle: LibraryHandle | null = null

/**
 * Opens the library, building it on first call and re-showing it after that.
 * `opener` is the control that summoned it — focus returns there on close (the
 * same priorFocus discipline ui/howto.ts and ui/study.ts use).
 *
 * `focus` differs by HOW it was opened, because the right answer differs:
 *   - 'close' (a tap): focusing the search field would raise the on-screen
 *     keyboard over the list, so the first thing a visitor sees of a browse
 *     surface would be two or three rows.
 *   - 'search' (a keyboard activation): there is no on-screen keyboard to
 *     raise, and a keyboard user opening a picker is overwhelmingly about to
 *     type a name — this is the typeahead the native <select> gave for free.
 * app.ts decides from the click event's `detail` (0 for keyboard-synthesised
 * activations, >= 1 for a real pointer press).
 */
export function openLibrary(state: AppState, opener: HTMLElement | null, focus: LibraryFocus = 'close'): void {
  if (!handle) handle = buildLibrary(state)
  handle.show(opener, focus)
}

function buildLibrary(state: AppState): LibraryHandle {
  const overlay = document.createElement('div')
  overlay.className = 'pg-library-overlay'
  overlay.hidden = true
  // Dialog semantics, mirroring ui/howto.ts's post-P4 shell: this covers the
  // whole app, so without role/aria-modal a screen reader keeps announcing the
  // tab bar and goal list underneath as if they were still reachable.
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'pg-library-title')

  // ---- chrome ----
  const header = document.createElement('div')
  header.className = 'pg-library-header'
  const title = document.createElement('div')
  title.className = 'pg-library-title'
  title.id = 'pg-library-title'
  title.textContent = 'Machines'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'pg-library-close'
  closeBtn.setAttribute('aria-label', 'Close machine list')
  closeBtn.textContent = '✕'
  header.append(title, closeBtn)

  const searchWrap = document.createElement('div')
  searchWrap.className = 'pg-library-searchwrap'
  const search = document.createElement('input')
  search.className = 'pg-library-search'
  // type="search" gets the iOS keyboard's own clear button and Search key.
  search.type = 'search'
  search.setAttribute('aria-label', 'Search machines')
  search.placeholder = 'Search machines, makers, years'
  // NO autofocus, on purpose: focusing a text input on open raises the
  // on-screen keyboard over the list, so the first thing a visitor sees of a
  // browse surface would be two or three rows. They tap the field when they
  // want to type.
  search.autocomplete = 'off'
  searchWrap.appendChild(search)

  // THE SCROLL AREA is a row: the scrolling scroller, and the A-Z rail beside it.
  //
  // The rail is a SIBLING of the scrollport, not a child of it — a child would
  // scroll away with the list it indexes, which is the one thing an index must
  // never do. Laying them out as flex siblings (rather than floating the rail
  // over the scroller with position:absolute) also means the rows' own width
  // shrinks by exactly the rail's column when it appears, so nothing ever
  // scrolls underneath it.
  const scrollArea = document.createElement('div')
  scrollArea.className = 'pg-library-scrollarea'

  const scroller = document.createElement('div')
  scroller.className = 'pg-library-body'

  const rail = document.createElement('div')
  rail.className = 'pg-library-rail'
  // A GROUP OF REAL BUTTONS, not role="slider".
  //
  // Both were on the table. A slider would have to invent a value ("what
  // number is the letter S?"), own its own arrow-key handling, and announce
  // itself as a range when it is a set of 27 named destinations. Buttons are
  // what these are: each has one job, one accessible name, keyboard activation
  // for free, and a disabled state that says "no machines under this letter"
  // in the one vocabulary a screen reader already has. The continuous drag
  // surface below is layered ON the buttons rather than replacing them.
  rail.setAttribute('role', 'group')
  rail.setAttribute('aria-label', 'Jump to letter')
  rail.hidden = true

  scrollArea.append(scroller, rail)
  overlay.append(header, searchWrap, scrollArea)
  document.body.appendChild(overlay)

  // ---- state local to the overlay ----
  let entries: LibraryEntry[] = []
  let query = ''
  let filter: LibraryFilter = ALL_FILTER
  /** The pick currently in flight — WHICH row, and which generation of tap it
   *  belongs to, so a superseded pick cannot clear a newer one's spinner. See
   *  pick() for the sequence that made the bare id insufficient. */
  let pending: { id: string; gen: number } | null = null
  let pickGeneration = 0
  /** Per-machine achievement counts, or null for a signed-out visitor (no
   *  badges at all — see fetchProgress). Fetched once per page load. */
  let progress: ProgressCounts | null = null
  let progressRequested = false
  let priorFocus: HTMLElement | null = null
  let unsubscribe: (() => void) | null = null
  let open = false

  /** Which entry each unpainted canvas is waiting to draw. A Map (not a
   *  WeakMap) because it is cleared wholesale on every render — see below. */
  const pendingThumbs = new Map<HTMLCanvasElement, LibraryEntry>()

  /**
   * THE PAINT CACHE — canvas ELEMENTS, kept and re-appended, not repainted.
   *
   * THE PROBLEM IT SOLVES. render() rebuilds the whole scroller, and it runs on
   * every keystroke in the search field. Without this, each of those renders
   * created a fresh <canvas> per visible row, and the observer then painted
   * every one of them again: a screenful of backing-store reallocations plus a
   * screenful of gradient fills, per character typed. That is exactly the shape
   * of search jank on a mid-range phone.
   *
   * WHY ELEMENT REUSE RATHER THAN A BITMAP CACHE + drawImage. Blitting from a
   * cached source still allocates the destination canvas on every render, so it
   * removes the drawing but not the allocation. Keeping the ELEMENT removes
   * both: `appendChild` MOVES an existing node, and a moved canvas keeps its
   * bitmap. A cache hit costs one DOM move and zero pixels. (The other option
   * K3 offered — rebuilding only the list subtree — was not taken: the sections
   * THEMSELVES change shape as you type, so "only the list" is most of the
   * scroller anyway, and it would leave the per-render allocation in place for
   * every row that did move.)
   *
   * KEY: slot + machine + DPR. The slot matters because one machine can be on
   * screen twice at once (its Pinned row and its A-Z row are two elements);
   * the DPR matters because a window dragged to a different-density display
   * must repaint rather than upscale a stale bitmap.
   *
   * CAP: it must cover a WHOLE RENDER, and 48 did not.
   *
   * The old cap was sized against 521 KB card thumbnails, where holding the
   * catalog would have cost 25 MB and a working-set cap was the only option.
   * Row accents are 18.8 KB — 28x cheaper — and that changes the answer, but
   * the constant was carried over unchanged and quietly stopped working:
   * render() rebuilds the ENTIRE list, so 134 row canvases are created per
   * render; past the 48th, eviction found the ones this very render had just
   * created (they are not appended yet, so they read as disconnected) and
   * dropped them. MEASURED at cap 48 against the real catalog: 134 of 134 row
   * thumbnails evicted per re-render, i.e. the element cache — the whole point
   * of this map — was defeating itself at catalog scale and repainting
   * everything on every keystroke. The five-machine fixture the older tests
   * used could never show it.
   *
   * So the cap is now the worst case one render can ask for, not a working set:
   *
   *     134 A-Z rows + 30 Pinned (PINNED_SHOWN) + 6 Recent (RECENT_SHOWN)
   *     + 1 current-machine strip  =  171 keys, one DPR
   *
   * 176 leaves a little headroom and costs 176 x 18.8 KB = 3.2 MB worst case —
   * an eighth of what the old 48-card cap could hold, while now actually
   * holding everything. app/tests/library.test.mjs re-derives this against the
   * SHIPPING catalog, so a catalog that outgrows the cap turns that test red
   * instead of silently reintroducing the repaint.
   *
   * Eviction is oldest-first and SKIPS anything still on screen — dropping a
   * connected element from the map would blank a thumbnail the visitor is
   * looking at; an evicted detached one is rebuilt the next time it is needed,
   * which costs one 60x80 backing-store allocation (18.8 KB) plus ~1.5K pixel
   * writes for the gradient, plates, wedges and dots.
   */
  const THUMB_CACHE_CAP = 176
  const thumbEls = new Map<string, HTMLCanvasElement>()

  function cachedThumbEl(slot: string, entry: LibraryEntry, cls: string): HTMLCanvasElement {
    const dpr = Math.min(THUMB_DPR_CAP, window.devicePixelRatio || 1)
    const key = `${slot}:${entry.id}:${dpr}`
    const hit = thumbEls.get(key)
    if (hit) {
      // Refresh recency (insertion-ordered Map == LRU when you re-insert).
      thumbEls.delete(key)
      thumbEls.set(key, hit)
      hit.className = cls
      return hit
    }
    const canvas = document.createElement('canvas')
    canvas.className = cls
    canvas.setAttribute('aria-hidden', 'true')
    thumbEls.set(key, canvas)
    while (thumbEls.size > THUMB_CACHE_CAP) {
      const oldest = [...thumbEls.entries()].find(([, el]) => !el.isConnected)
      if (!oldest) break // everything cached is on screen; nothing safe to drop
      thumbEls.delete(oldest[0])
    }
    return canvas
  }

  /**
   * PAINT ON FIRST APPROACH — re-measured for rows, and it still wins.
   *
   * The honest question the row redesign raised: a row accent is 28x smaller
   * than a card thumbnail, so is the observer still worth its own machinery, or
   * should the overlay just paint all 134 on open? MEASURED, at 48px rows in a
   * ~700px scrollport:
   *
   *   EAGER  134 canvases · 2.45 MB of backing store · 223K px written
   *   LAZY    20 canvases · 375 KB · 33K px written   (15 visible + 5 lookahead)
   *
   * 6.7x the allocations and the memory, for pixels nobody has scrolled to. And
   * eager painting would quietly DEFEAT the cache cap above: all 134 elements
   * would be connected, eviction skips connected elements by design, so the map
   * would simply grow to 134 and the bound would stop existing. Lazy stays.
   *
   * `rootMargin` starts the paint 240px before a row scrolls into view, so a
   * thumbnail is finished by the time it arrives rather than popping in behind
   * the scroll. It is unchanged from the grid era and did not need to change:
   * 240px was roughly one card of warning then and is FIVE rows of warning now,
   * over a paint that costs 28x less. Each canvas is UNOBSERVED the moment it
   * is painted: the observer's job is a one-shot trigger, not a subscription.
   *
   * The observer is DISCONNECTED at the top of every render (see render()),
   * because render() rebuilds the scroller and every canvas it was holding is now
   * detached. An observer keeps a strong reference to its targets, so not
   * disconnecting would pin a growing pile of dead canvases — one per keystroke
   * in the search field — for the lifetime of the page.
   */
  const observer: IntersectionObserver | null =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (records) => {
            for (const rec of records) {
              if (!rec.isIntersecting) continue
              const canvas = rec.target as HTMLCanvasElement
              const entry = pendingThumbs.get(canvas)
              if (!entry) continue
              pendingThumbs.delete(canvas)
              observer?.unobserve(canvas)
              // A record can be delivered for a target that was detached
              // between the intersection and this callback — a keystroke
              // re-rendering the scroller is exactly that race. Painting it would
              // allocate a bitmap into a node nobody will ever see, and measure
              // clientWidth 0 while doing it.
              if (!canvas.isConnected) continue
              paintThumbCanvas(canvas, entry)
            }
          },
          { root: scroller, rootMargin: '240px 0px' },
        )
      : null

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function renderCurrentStrip(): HTMLElement | null {
    const machine = state.machine
    if (!machine) return null
    const entry = entries.find((e) => e.id === machine.id)
    const strip = document.createElement('div')
    strip.className = 'pg-library-current'

    strip.appendChild(renderThumb('strip', entry, 'pg-library-thumb-lg'))

    const bodyEl = document.createElement('div')
    bodyEl.className = 'pg-library-current-body'
    const eyebrow = document.createElement('div')
    eyebrow.className = 'pg-library-current-eyebrow'
    eyebrow.textContent = 'NOW STUDYING'
    const name = document.createElement('div')
    name.className = 'pg-library-current-name'
    name.textContent = entry?.title ?? machine.name
    // The app's first link INTO its own SEO pages. The guide is a full
    // no-JS rules write-up for the same machine, generated by
    // scripts/gen-guides.mjs at /machines/<id>/; until now nothing in the app
    // pointed at it, so the two halves of the product never met. New tab,
    // because the visitor is mid-session in a study tool and should come back
    // to it, not have to navigate back.
    const guide = document.createElement('a')
    guide.className = 'pg-library-guide-link'
    guide.href = `/machines/${machine.id}/`
    guide.target = '_blank'
    guide.rel = 'noopener noreferrer'
    guide.textContent = 'Full rules guide ›'
    bodyEl.append(eyebrow, name, guide)

    strip.append(bodyEl, renderPin(machine.id, entry?.title ?? machine.name))
    return strip
  }

  function renderPin(id: string, label: string): HTMLElement {
    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'pg-library-pin'
    const on = state.isPinned(id)
    if (on) pin.classList.add('pg-library-pin-on')
    pin.setAttribute('aria-pressed', String(on))
    pin.setAttribute('aria-label', on ? `Unpin ${label}` : `Pin ${label}`)
    pin.textContent = '★'
    pin.addEventListener('click', (ev) => {
      // A pin is NOT a machine switch. The star is a SIBLING of the row (see
      // renderRow), so this stopPropagation is not what saves it today — a
      // tap here cannot bubble through a sibling. It is here because the star
      // and the row share a wrapper: the day anything delegates a click
      // handler on .pg-library-rowwrap or the list, the sibling arrangement
      // stops being enough on its own. What actually keeps a pin tap from
      // picking the machine is the DOM shape, and that shape is asserted
      // directly in app/tests/library.test.mjs.
      ev.stopPropagation()
      state.togglePinned(id)
      render()
    })
    return pin
  }

  /**
   * The thumbnail slot: a <canvas> painted on FIRST APPROACH, or a plain frame
   * when there is nothing to draw (no index — the fail-soft path — or a
   * machine with no modelled geometry).
   *
   * `aria-hidden` either way. It is decoration: the row's own name is what a
   * screen reader should read, and "a schematic of a pinball playfield"
   * announced 134 times is worse than silence.
   */
  function renderThumb(slot: string, entry: LibraryEntry | undefined, extraClass?: string): HTMLElement {
    const cls = 'pg-library-thumb' + (extraClass ? ` ${extraClass}` : '')
    if (!entry || (entry.shots.length === 0 && entry.flippers.length === 0)) {
      const frame = document.createElement('div')
      frame.className = `${cls} pg-library-thumb-empty`
      frame.setAttribute('aria-hidden', 'true')
      return frame
    }
    const canvas = cachedThumbEl(slot, entry, cls)
    // ALREADY PAINTED: nothing to observe and nothing to draw. This is the
    // cache hit — the element is about to be moved back into the tree with its
    // bitmap intact.
    if (isThumbPainted(canvas)) return canvas
    pendingThumbs.set(canvas, entry)
    if (observer) observer.observe(canvas)
    // No IntersectionObserver (very old browsers): paint immediately rather
    // than ship an overlay full of empty boxes. The cost is 134 paints instead
    // of the 20 on screen — worth it only as a fallback, which is exactly what
    // this is, and why THUMB_FALLBACK_W is sized for a row and not a card.
    else paintThumbCanvas(canvas, entry)
    return canvas
  }

  /**
   * ONE MACHINE, ONE ROW. This replaced a 2-up grid of playfield cards, on
   * rolo's report from an arcade floor: the thumbnails were what made a name
   * hard to find.
   *
   * ANATOMY, left to right: a small playfield accent, the NAME on the display
   * face at the goal-row type step, the maker/year meta under it, the progress
   * badge trailing, and the pin star as a sibling control at the right edge.
   *
   * NAME AND META ARE STACKED, not one line — measured against the real
   * catalog rather than guessed. A single line would have to reserve room for
   * a meta that runs from 10 to 29 characters ("INTERNATIONAL CONCEPTS · 1989"
   * is a real one), and every character it reserves comes out of the name
   * column. Stacked, the name gets the full width: ~96% of the 134 titles fit
   * without ellipsis, against ~85% on a shared line. The name is the thing this
   * redesign exists to protect, so the layout that protects it wins.
   */
  function renderRow(slot: string, entry: LibraryEntry): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'pg-library-rowwrap'

    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'pg-library-row'
    const isCurrent = state.machine?.id === entry.id
    if (isCurrent) row.classList.add('pg-library-row-current')
    if (pending?.id === entry.id) row.classList.add('pg-library-row-busy')
    if (isCurrent) row.setAttribute('aria-current', 'true')

    row.appendChild(renderThumb(slot, entry, 'pg-library-thumb-row'))

    const text = document.createElement('span')
    text.className = 'pg-library-row-body'

    const name = document.createElement('span')
    name.className = 'pg-library-row-name'
    name.textContent = entry.title

    const meta = document.createElement('span')
    meta.className = 'pg-library-row-meta'
    meta.textContent = metaLineFor(entry)

    text.append(name, meta)
    row.appendChild(text)

    // PROGRESS BADGE (P6 L5) — signed-in visitors only, and only on machines
    // that actually have achievements authored. `0/12` is shown deliberately:
    // it is the denominator that makes the badge useful ("this table has 12
    // to find"), and hiding it until the first one is earned would make the
    // badge appear out of nowhere later.
    if (progress && entry.ach > 0) {
      const total = entry.ach
      // Clamped: a stored id for an achievement the dataset has since dropped
      // must not render "13/12".
      const done = Math.min(progress[entry.id] ?? 0, total)
      const badge = document.createElement('span')
      badge.className = 'pg-library-row-prog'
      if (done === total) badge.classList.add('pg-library-row-prog-done')
      badge.textContent = done === total ? `${done}/${total} ✓` : `${done}/${total}`
      badge.setAttribute('aria-label', `${done} of ${total} achievements`)
      row.appendChild(badge)
    }

    if (pending?.id === entry.id) {
      const spin = document.createElement('span')
      spin.className = 'pg-library-spinner'
      spin.setAttribute('aria-hidden', 'true')
      row.appendChild(spin)
    }

    row.addEventListener('click', () => {
      void pick(entry)
    })

    // The pin is a SIBLING of the row, never a child: a <button> inside a
    // <button> is invalid HTML, and browsers resolve it by dropping one of
    // them — which is how a "nested" star ends up either untappable or
    // swallowing the whole row's tap.
    wrap.append(row, renderPin(entry.id, entry.title))
    return wrap
  }

  function renderError(): HTMLElement | null {
    const err = state.machineError
    if (!err) return null
    const failed = state.machines.find((m) => m.id === err.machineId)
    const box = document.createElement('div')
    box.className = 'pg-library-error'
    box.setAttribute('role', 'alert')
    const text = document.createElement('span')
    text.className = 'pg-library-error-text'
    const label = entries.find((e) => e.id === err.machineId)?.title ?? failed?.name ?? 'that machine'
    text.textContent = `Couldn't load ${label}. Check your connection and try again.`
    box.appendChild(text)
    if (failed) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'pg-library-retry'
      retry.textContent = 'Retry'
      retry.addEventListener('click', () => {
        const entry = entries.find((e) => e.id === err.machineId)
        if (entry) void pick(entry)
      })
      box.appendChild(retry)
    }
    return box
  }

  // -------------------------------------------------------------------------
  // The A-Z rail
  // -------------------------------------------------------------------------

  /** letter -> its header element in the CURRENT render. Rebuilt every render;
   *  the rail's handlers read it at call time so they can never hold a stale
   *  anchor from a list that has since been filtered away. */
  const letterAnchors = new Map<string, HTMLElement>()
  /** The letters the rail is showing, in rendered order — the axis
   *  railIndexAt() divides. */
  let railOrder: string[] = []
  let railDragging = false
  let railLastLetter: string | null = null

  /** The OS "reduce motion" preference, read LIVE (it can change mid-session on
   *  iOS), the same way ui/study.ts reads it. */
  function prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  }

  /**
   * Scroll the list to a letter's header.
   *
   * THE FORMULA, stated once because every assertion about the rail measures
   * against it:
   *
   *     top = scroller.scrollTop + (anchor.rect.top - scroller.rect.top)
   *
   * That is the anchor's offset WITHIN the scrollport's own scrolled content —
   * the rect delta converts a viewport-relative pair into a scrollport-relative
   * offset, and adding the live scrollTop makes it absolute. It is MEASURED,
   * never derived from a row count times a row height: rows are 48px today and
   * a longer title, a bigger type step or a different accent would change that
   * silently, and an index built on an assumed pitch drifts further from its
   * target the further down the list you jump.
   *
   * THE TARGET IS THE HEADER, NOT THE FIRST ROW, and that is what makes the
   * sticky header behave. Land the header at the top of the scrollport and it
   * sits at its natural position with zero sticky offset, so its group's first
   * row begins exactly at the header's bottom edge — visible, not underneath
   * it. Scrolling the first ROW to the top instead would put it precisely
   * where the pinned header covers it, hiding the machine you jumped for.
   * app/tests/library.test.mjs asserts the first row clears the header's
   * bottom, which is the property, not the arithmetic.
   *
   * THE INNER SCROLLPORT, NEVER THE DOCUMENT. `scrollIntoView()` is the obvious
   * call and the wrong one: it scrolls every scrollable ancestor it can find,
   * up to and including the document. It would also be silently useless here —
   * styles.css pins `body { position: fixed; inset: 0; overflow: hidden }` for
   * iOS toolbar hardening, so the document does not scroll at all and a jump
   * aimed at it would move nothing while appearing to succeed. `scroller` is
   * the `.pg-library-body` div this overlay built; it is deliberately NOT named
   * `body`, because a `body` identifier in a module that also calls
   * `document.body.appendChild` is one careless line away from that exact
   * no-op.
   *
   * A DIMMED LETTER IS INERT, and that is the whole of "skipped when
   * scrubbing": there is no anchor, so nothing moves and the list stays where
   * the last live letter put it. Snapping to a nearest neighbour would scroll
   * the list to somewhere the finger never was.
   *
   * CLAMPING IS THE BROWSER'S. A jump into the last letter asks for an offset
   * past `scrollHeight - clientHeight`; the platform pins it to the bottom, and
   * the sticky header rides along, so the final group ends flush instead of
   * scrolling into empty space.
   */
  function jumpToLetter(letter: string): void {
    const anchor = letterAnchors.get(letter)
    if (!anchor) return
    const aTop = anchor.getBoundingClientRect?.().top
    const sTop = scroller.getBoundingClientRect?.().top
    if (typeof aTop !== 'number' || typeof sTop !== 'number') return
    const top = scroller.scrollTop + (aTop - sTop)
    // Reduced motion removes the MOTION, not the feature: the jump still
    // happens, it just happens on one frame instead of gliding.
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior })
    else scroller.scrollTop = top
  }

  /** Which letter the rail's continuous surface has under `clientY`. */
  function railLetterAtY(clientY: number): string | null {
    const rect = rail.getBoundingClientRect?.()
    if (!rect) return null
    const i = railIndexAt(clientY, rect.top, rect.height, railOrder.length)
    return i < 0 ? null : railOrder[i] ?? null
  }

  /** One step of a scrub. Guarded on the letter CHANGING, so a finger resting
   *  inside one zone does not re-issue the same jump every pointermove. */
  function railScrubTo(clientY: number): void {
    const letter = railLetterAtY(clientY)
    if (!letter || letter === railLastLetter) return
    railLastLetter = letter
    jumpToLetter(letter)
  }

  // THE CONTINUOUS SURFACE, layered on the buttons rather than replacing them.
  //
  // DRAG-SCRUB IS A POINTER-ONLY ENHANCEMENT. Every destination it can reach is
  // reachable by ACTIVATING one letter button, which is the assistive-tech path
  // and the keyboard path both: nothing here is available only to a finger that
  // can travel. That is why the rail is buttons with a drag layered on, and not
  // a slider whose whole value lives in the dragging.
  //
  // preventDefault() on pointerdown is load-bearing, not hygiene: it suppresses
  // the compatibility click, which would otherwise fire on the button that was
  // under the finger when the drag STARTED and yank the list back there after a
  // scrub ended three letters away. A keyboard activation produces no pointer
  // events at all, so the per-button click handler below is untouched by this.
  rail.addEventListener('pointerdown', (ev) => {
    ev.preventDefault()
    railDragging = true
    railLastLetter = null
    rail.setPointerCapture?.(ev.pointerId)
    railScrubTo(ev.clientY)
  })
  rail.addEventListener('pointermove', (ev) => {
    if (railDragging) railScrubTo(ev.clientY)
  })
  const endRailDrag = (ev: PointerEvent): void => {
    if (!railDragging) return
    railDragging = false
    railLastLetter = null
    rail.releasePointerCapture?.(ev.pointerId)
  }
  rail.addEventListener('pointerup', endRailDrag)
  rail.addEventListener('pointercancel', endRailDrag)

  /**
   * Build the rail for this render, or hide it.
   *
   * REBUILT WHOLESALE rather than diffed. It is 27 buttons, and the renders
   * that show it are chip taps and pin toggles — never keystrokes, because a
   * query hides it. Diffing would buy nothing measurable and would introduce
   * the one bug class this cannot afford: a button still holding a letter the
   * list no longer has.
   */
  function renderRail(groups: readonly LetterGroup[] | null): void {
    rail.innerHTML = ''
    railOrder = []
    if (!groups) {
      rail.hidden = true
      scroller.classList.remove('pg-library-body-railed')
      return
    }
    rail.hidden = false
    scroller.classList.add('pg-library-body-railed')
    railOrder = railLetters(groups)
    const live = new Set(groups.map((g) => g.letter))
    for (const letter of railOrder) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pg-library-rail-btn'
      btn.textContent = letter
      const has = live.has(letter)
      if (!has) {
        btn.classList.add('pg-library-rail-btn-off')
        // DISABLED, NOT MERELY FADED. "No machines under this letter" is a
        // STATE, so it is carried by one — announced by a screen reader and out
        // of the tab order — rather than by the dimming alone, which is a
        // colour difference nobody who cannot see it can use.
        btn.disabled = true
        btn.setAttribute('aria-disabled', 'true')
      }
      btn.setAttribute('aria-label', `Jump to ${letter === '#' ? 'numbers and symbols' : letter}`)
      // The keyboard path. A pointer tap never reaches here — pointerdown
      // preventDefault()s the compatibility click — so this cannot double-fire.
      btn.addEventListener('click', () => jumpToLetter(letter))
      rail.appendChild(btn)
    }
  }

  function render(): void {
    // Everything the observer was watching is about to be detached — release
    // it before it becomes a leak (see the observer's own note above).
    observer?.disconnect()
    pendingThumbs.clear()
    letterAnchors.clear()
    scroller.innerHTML = ''

    const strip = renderCurrentStrip()
    if (strip) scroller.appendChild(strip)

    const err = renderError()
    if (err) scroller.appendChild(err)

    // ---- chips ----
    const chipRow = document.createElement('div')
    chipRow.className = 'pg-library-chips'
    chipRow.setAttribute('role', 'group')
    chipRow.setAttribute('aria-label', 'Filter machines')
    const filters = buildFilters(entries, {
      hasPinned: state.pinnedMachineIds.length > 0,
      hasRecent: state.recentMachineIds.some((id) => id !== state.machine?.id),
    })
    // A chip that has just been emptied (the last pin removed while its own
    // filter was active) must not leave the view stuck on nothing.
    if (!filters.some((f) => f.kind === filter.kind && f.value === filter.value)) filter = ALL_FILTER
    for (const f of filters) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'pg-library-chip'
      const on = f.kind === filter.kind && f.value === filter.value
      if (on) chip.classList.add('pg-library-chip-on')
      chip.setAttribute('aria-pressed', String(on))
      chip.textContent = f.label
      chip.addEventListener('click', () => {
        // Tapping the active chip turns it OFF (back to All) rather than doing
        // nothing — the alternative is a filter you can enter and not leave
        // without hunting for the All chip at the far left of a scrolled row.
        filter = on ? ALL_FILTER : f
        render()
      })
      chipRow.appendChild(chip)
    }
    scroller.appendChild(chipRow)

    // ---- results ----
    const sections = computeSections(entries, {
      query,
      filter,
      pinned: state.pinnedMachineIds,
      recent: state.recentMachineIds,
      currentId: state.machine?.id ?? null,
    })
    const total = sections.reduce((n, s) => n + s.entries.length, 0)

    const status = document.createElement('div')
    status.className = 'pg-library-status'
    // role="status" so a screen reader hears the result count change as the
    // visitor types, instead of the list silently rearranging. The number is
    // DERIVED at render time from the filtered array — never a written-down
    // count that can go stale.
    status.setAttribute('role', 'status')
    status.textContent = describeResults(total, query, filter)
    scroller.appendChild(status)

    if (total === 0) {
      const empty = document.createElement('div')
      empty.className = 'pg-library-empty'
      empty.textContent = 'No machines match that. Try a shorter search, or clear the filter.'
      scroller.appendChild(empty)
      renderRail(null)
      return
    }

    // LETTER SECTIONS AND THE RAIL SHIP TOGETHER, and only over the A-Z
    // section — Pinned and Recent are the visitor's own short lists and file
    // under nothing. A chip filter still collapses to one 'all' section, so a
    // maker with enough machines (Stern's 49) keeps its index while a maker
    // with one does not.
    const allSection = sections.find((s) => s.slot === 'all')
    const lettered = showRail({ query, rows: allSection?.entries.length ?? 0 })
    let railGroups: LetterGroup[] | null = null

    for (const sec of sections) {
      if (sec.entries.length === 0) continue
      const secEl = document.createElement('div')
      secEl.className = 'pg-library-section'
      if (sec.title) {
        const h = document.createElement('div')
        h.className = 'pg-library-section-title'
        h.textContent = sec.title
        secEl.appendChild(h)
      }
      const list = document.createElement('div')
      list.className = 'pg-library-list'
      // The SLOT is what lets one machine hold two live thumbnails at once
      // (its Pinned row and its A-Z row are separate elements) without the
      // two fighting over one cache entry.
      if (lettered && sec === allSection) {
        railGroups = groupByLetter(sec.entries)
        for (const group of railGroups) {
          // EACH GROUP IS ITS OWN BOX, and that is load-bearing rather than
          // tidiness. A sticky header sticks within its CONTAINING BLOCK, so
          // with every header a direct child of one long list they all pin at
          // the top of the scrollport at once — 22 opaque boxes stacked on the
          // same 24 pixels, repainted on every scroll frame, with only the last
          // one in DOM order visible. It happens to LOOK right, which is why it
          // survived the fake-DOM suite and was caught by measuring the real
          // thing. One box per group gives each header exactly the travel its
          // own rows have: it pins while its letter is on screen and is pushed
          // out by the next.
          const groupEl = document.createElement('div')
          groupEl.className = 'pg-library-lettergroup'
          const head = document.createElement('div')
          head.className = 'pg-library-letter'
          head.textContent = group.letter
          groupEl.appendChild(head)
          letterAnchors.set(group.letter, head)
          for (const e of group.entries) groupEl.appendChild(renderRow(sec.slot, e))
          list.appendChild(groupEl)
        }
      } else {
        for (const e of sec.entries) list.appendChild(renderRow(sec.slot, e))
      }
      secEl.appendChild(list)
      if (sec.overflow) {
        // The capped remainder is one tap away, not hidden: this jumps to the
        // Pinned CHIP, which lists all of them.
        const more = document.createElement('button')
        more.type = 'button'
        more.className = 'pg-library-more'
        more.textContent = `…and ${sec.overflow} more pinned`
        more.addEventListener('click', () => {
          filter = { kind: 'pinned', label: 'Pinned' }
          render()
        })
        secEl.appendChild(more)
      }
      scroller.appendChild(secEl)
    }

    // LAST, so it is built from the anchors this render actually produced
    // rather than from what it intended to produce.
    renderRail(railGroups)
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  /**
   * A SECOND TAP CLEANLY SUPERSEDES THE FIRST — the list is deliberately NOT
   * made inert while a pick is in flight.
   *
   * Both are defensible; this is the one that serves the visitor. Freezing the
   * list means a mis-tap on a list of 48px rows cannot be corrected
   * until a dataset finishes arriving over arcade Wi-Fi, which is precisely
   * when it takes longest. Superseding costs one generation token and makes
   * the wrong tap self-healing.
   *
   * THE TOKEN IS CHECKED AT COMMIT TIME — after the await, before anything is
   * written — for the same reason state.ts's loadMachine checks its own there:
   * the ONLY safe moment to ask "is this still wanted" is the moment before
   * acting. Without it, a losing pick's continuation runs `pending = null` and
   * clears the WINNER's spinner while the winner is still loading (tap A, tap
   * B, A resolves first: A is superseded inside state.ts, so it changes no
   * machine — but it used to blank B's spinner on the way out, leaving the
   * overlay with a load in flight and nothing saying so). Now a superseded
   * pick returns having touched nothing at all.
   */
  async function pick(entry: LibraryEntry): Promise<void> {
    const machine = state.machines.find((m) => m.id === entry.id)
    if (!machine) return
    if (state.machine?.id === machine.id && !state.machineError) {
      close()
      return
    }
    const gen = ++pickGeneration
    pending = { id: entry.id, gen }
    render()
    await state.selectMachine(machine)
    // COMMIT GATE. A newer tap owns the overlay now; this one writes nothing.
    if (gen !== pickGeneration) return
    pending = null
    // SUCCESS IS AN IDENTITY CHECK, not the absence of a throw: state.ts's
    // loadMachine resolves either way by design (see its own note), so "did it
    // work" is "is this machine the one now loaded".
    if (state.machine?.id === machine.id) close()
    else render()
  }

  function focusables(): HTMLElement[] {
    // Hand-rolled rather than a library: this overlay's focusable set is
    // exactly buttons, links and the one input, all of them ours.
    const out: HTMLElement[] = []
    const walk = (el: Element): void => {
      for (const child of Array.from(el.children)) {
        const tag = child.tagName
        if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') {
          if (!(child as HTMLButtonElement).disabled) out.push(child as HTMLElement)
        }
        walk(child)
      }
    }
    walk(overlay)
    return out
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    // TYPEAHEAD PARITY WITH THE NATIVE <select> THIS REPLACED. A select gives
    // first-letter jump for free; losing it would be a real regression for a
    // keyboard user. The search field is a strictly better version of the same
    // affordance (it matches maker and year too, not just the first letter) —
    // but only if typing REACHES it. So a printable character pressed while
    // focus is anywhere else in the dialog is forwarded here: the visitor types
    // and the list narrows, exactly as it did in the select, without having to
    // discover the field first.
    //
    // Guards: modifier chords are shortcuts, not text; a multi-character
    // `key` is a named key (Tab/Enter/ArrowUp); and if focus is ALREADY in the
    // field the browser handles it.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== search) {
      e.preventDefault()
      search.focus?.()
      search.value += e.key
      query = search.value
      render()
      return
    }
    if (e.key !== 'Tab') return
    // Tab wrap. Without it, tabbing off the last control walks into the app
    // underneath — which is still there, just inert and invisible.
    const items = focusables()
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const active = document.activeElement as HTMLElement | null
    const i = active ? items.indexOf(active) : -1
    if (e.shiftKey && (i <= 0)) {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (!e.shiftKey && i === items.length - 1) {
      e.preventDefault()
      items[0]?.focus()
    }
  }

  function close(): void {
    if (!open) return
    open = false
    // Read BEFORE the re-render below, which rebuilds the rows: a focused row
    // is about to be detached, and "was focus ours" is a question about the
    // overlay as the visitor left it. See the restore at the end.
    const active = document.activeElement
    const focusWasOurs = !active || active === document.body || containsNode(overlay, active)
    overlay.hidden = true
    // ABANDON any pick still in flight, as far as THIS overlay is concerned.
    // The switch itself is not cancelled — state.ts owns that, and a machine
    // the visitor asked for should still finish loading behind the closed
    // overlay — but nothing here should act on it any more, and no row should
    // stay dressed as busy. The re-render below is what actually clears the
    // spinner markup; it is one rebuild of a hidden panel, off the critical
    // path (the visitor is already looking at the machine that just loaded),
    // and it means re-opening shows correct state on the first frame.
    pending = null
    pickGeneration += 1
    render()
    document.removeEventListener('keydown', onKey)
    unsubscribe?.()
    unsubscribe = null
    // Back to the header button that opened this — the same priorFocus
    // discipline ui/howto.ts uses. Guarded: if something else took focus in
    // the meantime, do not yank it back.
    //
    // "SOMETHING ELSE" MEANS OUTSIDE THIS OVERLAY (2026-10-14 review). The
    // guard used to be `activeElement !== priorFocus`, which yanked focus back
    // from ANYWHERE — and a successful pick is exactly when something else
    // takes it: the machine switch lands on HOW IT PLAYS (app.ts
    // landOnHowItPlays, a microtask after the switch's notify), whose sheet
    // focuses its Back button BEFORE this close runs (pick awaits
    // selectMachine, so its continuation is queued behind that microtask).
    // Restoring then pulled focus out of an open aria-modal sheet onto the
    // header picker behind it. Focus still inside this overlay (the ✕, a row,
    // the search field) or parked nowhere is ours to hand back; focus the app
    // has deliberately placed elsewhere is not. (Measured at the top of this
    // function, before the rows were rebuilt.)
    if (priorFocus && focusWasOurs && document.activeElement !== priorFocus) priorFocus.focus?.()
    priorFocus = null
  }

  function show(opener: HTMLElement | null, focus: LibraryFocus): void {
    if (open) return
    open = true
    priorFocus = opener ?? (document.activeElement as HTMLElement | null)
    overlay.hidden = false
    // Re-subscribe on every open, not once at build: a hidden overlay
    // re-rendering on every goal selection is pure waste.
    unsubscribe = state.onChange(render)
    document.addEventListener('keydown', onKey)
    render()
    // See openLibrary's note: the ✕ for a tap (an autofocused text field would
    // raise the keyboard over the list), the search field for a keyboard
    // activation (that IS the typeahead the native select used to give).
    if (focus === 'search') search.focus?.()
    else closeBtn.focus?.()
    void fetchLibraryIndex().then((loaded) => {
      if (loaded && loaded.length) {
        entries = loaded
        if (open) render()
      }
    })
    // Once per page load, on the first open — not at boot: a visitor who never
    // opens the library should never pay for this request, and one who opens
    // it five times should pay for it once.
    if (!progressRequested) {
      progressRequested = true
      void fetchProgress().then((counts) => {
        if (!counts) return // signed out, or unavailable — no badges, no noise
        progress = counts
        if (open) render()
      })
    }
  }

  closeBtn.addEventListener('click', close)
  search.addEventListener('input', () => {
    query = search.value
    render()
  })

  // Seed from the in-memory catalog immediately, so the very first open paints
  // a full list on the same frame instead of waiting on a fetch.
  entries = entriesFromCatalog(state.machines)

  return { show }
}

/** The role="status" line. Count derived at render time; phrasing avoids
 *  claiming a total the catalog owns. */
export function describeResults(n: number, query: string, filter: LibraryFilter): string {
  const searching = foldText(query) !== '' || filter.kind !== 'all'
  if (!searching) return 'Every machine we cover'
  if (n === 0) return 'No matches'
  return `${n} ${n === 1 ? 'machine' : 'machines'}`
}
