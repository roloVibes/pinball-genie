#!/usr/bin/env node
// app/scripts/gen-library.mjs — P6 (Machine Library): the browse index.
//
// WHY THIS EXISTS. The library overlay shows every machine in the catalog as a
// card with a procedural mini-playfield thumbnail. Drawing that thumbnail needs
// each machine's SHAPE — where its shots are, where the shooter lane is, which
// decks it has — and there are only two ways to get it:
//
//   1. Fetch all 134 data/*_goals.json files. That is ~9 MB of goal prose,
//      instructions, achievements and step choreography to draw 134 postage
//      stamps. Nobody is doing that on a phone in an arcade.
//   2. Precompute, at build time, the ~1% of that data a thumbnail actually
//      reads. That is this file: one ~110 KB (~17 KB gzipped) JSON containing
//      coordinates, counts and nothing else.
//
// 🔴 NO PROSE, BY CONSTRUCTION. Every field emitted below is either a number, a
// controlled-vocabulary token (a shot `type`), or a string that came from
// data/catalog.json's own machine NAME. No `notes`, no `summary`, no goal
// titles, no achievement descriptions, no `sources` — not filtered out, never
// read in the first place. That matters for the same reason gen-guides.mjs's
// provenance ban does (see its header): data/*_goals.json carries research
// vocabulary, and this file is uploaded to a public webroot by deploy-prod.sh.
// Two independent guards enforce it rather than trusting the above:
//   - buildEntry() constructs objects from a fixed key list — a new prose field
//     appearing in the dataset cannot leak through a spread or a copy.
//   - assertNoProvenance() re-reads the SERIALIZED output and refuses to write
//     a file containing any PROVENANCE_TERMS needle (imported from
//     gen-guides.mjs, so the two generators can never drift apart on the list).
//
// DETERMINISTIC. No timestamps, no build ids, no `new Date()` — re-running this
// on unchanged data produces byte-identical output, so a rebuild does not churn
// the deploy. (Same property gen-guides.mjs's fixed GENERATED_DATE gives its
// sitemap, and for the same reason.)
//
// OUTPUT: data/library.json, which deploy-prod.sh's PG-12 allowlist names
// explicitly — see the `case` block there. Wired as an npm "prebuild" step
// alongside gen-guides.mjs (package.json), so `npm run build` cannot ship a
// stale index.
//
// Run: node scripts/gen-library.mjs   (from app/, or `node
// app/scripts/gen-library.mjs` from repo root — paths resolve off
// import.meta.url, not cwd).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PROVENANCE_TERMS } from './gen-guides.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, '../../data')
const OUT_PATH = resolve(DATA_DIR, 'library.json')

/** Schema version of the emitted document. Bumped when a field's MEANING
 *  changes; the reader (src/ui/library.ts) treats an unknown version as
 *  "fall back to the in-memory catalog with placeholder thumbnails" rather
 *  than guessing. */
export const LIBRARY_SCHEMA_VERSION = 1

/** Hard ceiling on the emitted file. The whole point of this index is that it
 *  is cheap enough to fetch on a phone the first time the library opens; a
 *  version of it that has quietly grown to half a megabyte would defeat that
 *  silently. Measured output today is 105,991 bytes (16.5 KB gzipped), so 150
 *  KB is ~41% headroom — enough for the catalog to keep growing, not enough to
 *  hide a schema mistake (carrying one unused string field per shot cost 40 KB
 *  and would have eaten the entire margin; see buildEntry's note).
 *  app/tests/gen-library.test.mjs asserts the SHIPPED file against the same
 *  number. */
export const LIBRARY_MAX_BYTES = 150 * 1024

/** Machine display names are "<Title> (<Manufacturer>, <Year>)" — all 134
 *  catalog entries match, verified before this script was written. A name that
 *  does NOT match is a hard failure rather than a silently blank chip: the
 *  library's maker/decade filters are built from these two captures. */
const NAME_RE = /^(.+) \(([^,()]+), (\d{4})\)$/

/** Manufacturer name -> the FAMILY a filter chip names.
 *
 *  Stern Pinball and Stern are the same company (the catalog carries both
 *  spellings because the machines were registered at different times); so are
 *  Sega Pinball / Sega and Jersey Jack Pinball / Jersey Jack. Without this fold
 *  the maker chip row would show "Stern" and "Stern Pinball" as two separate
 *  filters holding 11 and 38 machines, which is a bug that looks like a
 *  dataset error. Anything not named here keeps its own name as its group —
 *  the map is a fold list, not an allowlist. */
const MFR_GROUPS = new Map([
  ['Stern Pinball', 'Stern'],
  ['Sega Pinball', 'Sega'],
  ['Jersey Jack Pinball', 'Jersey Jack'],
  ['Spooky Pinball', 'Spooky'],
  ['Chicago Gaming Company', 'Chicago Gaming'],
])

/** 3 decimals ≈ 1 part in 1000 of the playfield's width. On the ~120 px
 *  thumbnail this renderer feeds, one unit of the third decimal is 0.12 px —
 *  a tenth of a pixel, i.e. below what any display can show. Rounding here is
 *  worth roughly 20% of the file: the datasets carry values like
 *  0.6299999999999999 that would otherwise be serialized in full. */
function round3(n) {
  return Math.round(n * 1000) / 1000
}

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

/** Is this shot one of the MAIN (lower) flipper pair?
 *
 *  Deliberately a COPY of overlay/map2d.ts's isMainFlipper rule, not an import:
 *  this is a build script (plain ESM, no TypeScript toolchain) and map2d.ts is
 *  a 48 KB browser module full of canvas code. The rule itself is four lines
 *  and is pinned by app/tests/gen-library.test.mjs against the same fixture
 *  cases map2d's own tests use — a machine whose mini-flipper got promoted to
 *  a main flipper here would draw a bat a third of the way up the thumbnail,
 *  which is exactly the bug map2d.ts's own comment describes. */
function isMainFlipper(shot) {
  const name = String(shot?.name ?? '').toLowerCase().trim()
  const type = String(shot?.type ?? '').toLowerCase()
  const namedFlipper = /^(lower\s+)?(left|right)\s+flipper$/.test(name) || name === 'flipper'
  if (type !== 'flipper' && !namedFlipper) return false
  return isFiniteNum(shot?.y) && shot.y <= 0.25
}

/** The main flipper PAIR, as {x, y, s} with s = 'l' | 'r'.
 *
 *  Same resolution order the map's own art uses: a shot whose name states the
 *  side wins, then the first flipper shot on that half of the table, then the
 *  standard body position. The defaults (0.33 / 0.67 at y 0.05) are map2d.ts's
 *  ART_DEFAULT_*_FLIPPER values — a machine with no flipper shot modelled still
 *  gets the landmark that makes a thumbnail read as a playfield at all. */
function mainFlippers(shots) {
  const flipperShots = shots.filter(isMainFlipper)
  const named = (side) => flipperShots.find((s) => new RegExp(side).test(String(s.name ?? '').toLowerCase()))
  const left = named('left') ?? flipperShots.find((s) => s.x < 0.5) ?? { x: 0.33, y: 0.05 }
  const right = named('right') ?? flipperShots.find((s) => s.x >= 0.5) ?? { x: 0.67, y: 0.05 }
  return [
    { x: round3(left.x), y: round3(left.y), s: 'l' },
    { x: round3(right.x), y: round3(right.y), s: 'r' },
  ]
}

/** Where the shooter lane is, as an x in [0,1], or null when the machine models
 *  no plunge at all. Same "side comes from where that shot IS, not from an
 *  assumption" rule as map2d.ts's own shooter-lane art. */
function plungeX(shots) {
  const plunge = shots.find(
    (s) =>
      String(s.type ?? '').toLowerCase() === 'plunge' ||
      /shooter|plunger|plunge/.test(String(s.name ?? '').toLowerCase()),
  )
  return plunge && isFiniteNum(plunge.x) ? round3(plunge.x) : null
}

/** The document's shape, PER LEVEL: which keys each kind of object may carry,
 *  and which of those keys hold nested objects of a named kind.
 *
 *  LEVEL-AWARE ON PURPOSE. The first version of this gate was one flat set of
 *  every legal key at any depth, and a seeded mutation walked straight through
 *  it: a PlayfieldZone's `name` — "Orca Deck", real prose from the dataset —
 *  is undeclared on a zone but perfectly legal on a MACHINE, so a flat set had
 *  no objection to it. The same hole covered `shots[i].name`, `zones[i].id` and
 *  every other prose field whose key happens to be spelled the same as a legal
 *  one somewhere else in the document. Declaring the shape level by level is
 *  what closes it. */
export const LIBRARY_SHAPE = {
  doc: { keys: ['v', 'machines'], children: { machines: 'machine' } },
  machine: {
    keys: [
      'id',
      'name',
      'title',
      'shortTitle',
      'mfr',
      'mfrGroup',
      'year',
      'goals',
      'ach',
      'zones',
      'flippers',
      'plungeX',
      'shots',
    ],
    children: { zones: 'zone', flippers: 'flipper', shots: 'shot' },
  },
  zone: { keys: ['x', 'y', 'w', 'h', 'k'], children: {} },
  flipper: { keys: ['x', 'y', 's'], children: {} },
  shot: { keys: ['x', 'y', 'p'], children: {} },
}

/** Flattened view of LIBRARY_SHAPE — every key legal SOMEWHERE. Kept for the
 *  "what does this document contain" reporting in the test suite; the gate
 *  itself uses the per-level shape above, never this. */
export const LIBRARY_KEYS = new Set(Object.values(LIBRARY_SHAPE).flatMap((s) => s.keys))

/**
 * One machine's index entry. THE KEY LIST IS EXHAUSTIVE AND LITERAL — no
 * spread of the source object anywhere in this function, which is what makes
 * "no prose by construction" a property of the code rather than a promise.
 *
 *   id         catalog id (the app's own machine key)
 *   name       the FULL catalog display name, unchanged — this is what the
 *              header button shows, so it has to stay byte-identical to what
 *              the <select> it replaces showed
 *   title      the same name with the "(Manufacturer, Year)" tail removed —
 *              what a card shows, because a 2-up grid has no room to repeat
 *              the maker and year that are already on the card's own meta line
 *   shortTitle the catalog's uppercase short form, searched alongside `title`
 *   mfr        manufacturer as written; mfrGroup the folded family (chips)
 *   year       number
 *   goals/ach  counts, for the card's meta line and the progress badge's
 *              denominator — counts, never the goal or achievement text
 *   zones      deck footprints [{x,y,w,h,k}] in main-playfield UV; NO zone
 *              NAMES ("Orca Deck" is prose and unreadable at 120 px anyway)
 *   flippers   the main pair [{x,y,s}]
 *   plungeX    shooter-lane x, or null
 *   shots      [{x,y,p?}] — p:1 marks a shot sitting on a deck zone
 *              (drawThumb dims those so the deck plate underneath still reads)
 *
 * NO SHOT `type` FIELD — a deliberate departure from the P6 design note's
 * `{x,y,t,p?}`, made on measurement. The thumbnail renderer draws every shot
 * as the SAME 1.5-2 px dot (insert shapes are noise at 120 px — that decision
 * is documented at drawThumb itself), so nothing reads a type; the shooter
 * lane and the flipper pair, the two places type mattered, are resolved HERE
 * at build time into `plungeX` and `flippers`. Carrying the strings anyway
 * cost 39,816 bytes — 27% of a 149,090-byte file — to feed a renderer that
 * never branches on them. Dropping them puts the output at 103.5 KB raw /
 * 16.5 KB gzipped, which is where the design note's own size estimate
 * (~110 KB / ~17 KB) expected it to land.
 */
function buildEntry(catalogEntry, goalsDoc) {
  const m = NAME_RE.exec(catalogEntry.name)
  if (!m) {
    throw new Error(
      `gen-library: catalog machine ${catalogEntry.id} has a name this script cannot parse: ` +
        `${JSON.stringify(catalogEntry.name)} — expected "<Title> (<Manufacturer>, <Year>)". ` +
        `The library's maker and decade filters are built from that parse; a blank chip is not an acceptable fallback.`,
    )
  }
  const [, title, mfr, yearStr] = m

  const shots = Array.isArray(goalsDoc.shots) ? goalsDoc.shots : []
  const usableShots = shots.filter((s) => isFiniteNum(s?.x) && isFiniteNum(s?.y))
  const zones = Array.isArray(goalsDoc.playfields) ? goalsDoc.playfields : []

  return {
    id: catalogEntry.id,
    name: catalogEntry.name,
    title,
    shortTitle: catalogEntry.shortTitle,
    mfr,
    mfrGroup: MFR_GROUPS.get(mfr) ?? mfr,
    year: Number(yearStr),
    goals: Array.isArray(goalsDoc.goals) ? goalsDoc.goals.length : 0,
    ach: Array.isArray(goalsDoc.achievements) ? goalsDoc.achievements.length : 0,
    zones: zones
      .filter((z) => z?.bounds && isFiniteNum(z.bounds.x) && isFiniteNum(z.bounds.y))
      .map((z) => ({
        x: round3(z.bounds.x),
        y: round3(z.bounds.y),
        w: round3(z.bounds.w),
        h: round3(z.bounds.h),
        k: String(z.kind ?? 'upper'),
      })),
    flippers: mainFlippers(usableShots),
    plungeX: plungeX(usableShots),
    shots: usableShots.map((s) => {
      const out = { x: round3(s.x), y: round3(s.y) }
      if (s.playfield) out.p = 1
      return out
    }),
  }
}

/** Refuses any key not declared for the LEVEL it appears at (LIBRARY_SHAPE).
 *  Exported so the gate can be driven directly with a seeded prose field,
 *  rather than the test asserting the mere ABSENCE of one in today's output —
 *  which would pass just as happily if this function stopped being called. */
export function assertNoUnknownKeys(value, kind = 'doc', path = '$') {
  const shape = LIBRARY_SHAPE[kind]
  if (!shape) throw new Error(`gen-library: ${path} — no declared shape named ${JSON.stringify(kind)}`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`gen-library: ${path} should be a ${kind} object, got ${Array.isArray(value) ? 'an array' : typeof value}`)
  }
  const allowed = new Set(shape.keys)
  for (const [k, v] of Object.entries(value)) {
    if (!allowed.has(k)) {
      throw new Error(
        `gen-library: ${path}.${k} is not a declared field of a ${kind}. ` +
          `Add it to LIBRARY_SHAPE.${kind} deliberately — this gate exists so a prose field ` +
          `(notes/summary/instructions/sources, or a zone's own display NAME) can never reach a file ` +
          `that is published publicly, including when its key is spelled the same as a legal field elsewhere.`,
      )
    }
    const childKind = shape.children[k]
    if (childKind) {
      if (!Array.isArray(v)) throw new Error(`gen-library: ${path}.${k} should be an array of ${childKind}`)
      v.forEach((child, i) => assertNoUnknownKeys(child, childKind, `${path}.${k}[${i}]`))
    }
  }
}

/** Defense in depth over the SERIALIZED bytes: the same needle list
 *  gen-guides.mjs refuses to render a guide page containing. Imported from
 *  there rather than re-typed, so the two generators cannot drift. */
export function assertNoProvenance(text) {
  const lower = text.toLowerCase()
  for (const term of PROVENANCE_TERMS) {
    const at = lower.indexOf(term)
    if (at !== -1) {
      const around = text.slice(Math.max(0, at - 60), at + term.length + 60).replace(/\s+/g, ' ')
      throw new Error(
        `gen-library: the output contains the provenance term ${JSON.stringify(term)} — "…${around}…". ` +
          `data/library.json is uploaded to a public webroot; research vocabulary must not ride along.`,
      )
    }
  }
}

export function buildLibrary() {
  const catalog = JSON.parse(readFileSync(resolve(DATA_DIR, 'catalog.json'), 'utf8'))
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error('gen-library: data/catalog.json is empty or not an array')
  }
  const machines = catalog.map((entry) => {
    const path = resolve(DATA_DIR, `${entry.resource}.json`)
    if (!existsSync(path)) {
      // A catalog machine with no dataset is a broken deploy, not a thumbnail
      // to skip: the app would already 404 on selecting it.
      throw new Error(`gen-library: catalog lists ${entry.id} but ${entry.resource}.json does not exist`)
    }
    return buildEntry(entry, JSON.parse(readFileSync(path, 'utf8')))
  })
  const doc = { v: LIBRARY_SCHEMA_VERSION, machines }
  assertNoUnknownKeys(doc)
  return doc
}

function main() {
  const doc = buildLibrary()
  const text = JSON.stringify(doc)
  assertNoProvenance(text)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > LIBRARY_MAX_BYTES) {
    throw new Error(
      `gen-library: output is ${bytes} bytes, over the ${LIBRARY_MAX_BYTES}-byte budget. ` +
        `This file is fetched on a phone the first time the library opens — find out what grew before raising the ceiling.`,
    )
  }
  writeFileSync(OUT_PATH, text, 'utf8')
  const shotCount = doc.machines.reduce((n, m) => n + m.shots.length, 0)
  console.log(
    `gen-library: wrote ${doc.machines.length} machines / ${shotCount} shots (${bytes} bytes) to ${OUT_PATH}`,
  )
}

// Only run when invoked directly, not when imported by the test suite — same
// guard idiom as gen-guides.mjs.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) main()
