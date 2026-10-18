#!/usr/bin/env node
// app/tests/gen-library.test.mjs — SUITE 24: the Machine Library's build-time
// browse index (scripts/gen-library.mjs -> data/library.json), P6 L2
// (2026-08-14).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/gen-library.test.mjs"
//
// WHY THIS SUITE EXISTS. data/library.json is a GENERATED file that
// deploy-prod.sh's PG-12 allowlist uploads to a public webroot. Three distinct
// things can go wrong with it, and none of them is visible in the browser:
//
//   1. IT CAN CARRY PROSE IT SHOULD NOT. The datasets it reads are full of
//      `notes`, `summary`, `instructions` and `sources` — research vocabulary
//      that gen-guides.mjs already refuses to render onto a public page (see
//      its provenance ban). This generator builds every entry from a literal
//      key list, but "the code looks careful" is not a gate; section c drives
//      both guards with material that MUST be refused.
//   2. IT CAN GO STALE. The file is checked in, so a dataset change that
//      nobody regenerates for ships a library describing last week's catalog.
//      Section a rebuilds from the live data and compares BYTES.
//      (`npm run build`'s prebuild chain regenerates it; this is the gate that
//      catches a commit made without one.)
//   3. IT CAN QUIETLY BLOAT. Section f pins the size budget the generator
//      enforces, because a phone in an arcade fetches this file.
//
// Sections:
//   a. The shipped file is CURRENT — regenerating produces identical bytes.
//   b. Shape: one entry per catalog machine, ids match, every field present
//      and in range, flipper pair well-formed, coordinates rounded to 3dp.
//   c. No prose: the key gate refuses an undeclared field, the provenance
//      gate refuses each term, and the shipped bytes are clean of both.
//   d. Manufacturer/year parse, and the maker fold (Stern Pinball == Stern).
//   e. The main-flipper rule does not promote a mini flipper (the exact bug
//      overlay/map2d.ts's own isMainFlipper comment describes).
//   f. Size: the shipped file is inside the generator's own budget.
//
// Harness pattern: no test framework in this repo (see scripts/run-tests.mjs)
// — a suite prints its own PASS/FAIL and exits non-zero when something failed.
//
// Exits non-zero on any FAIL.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(__dirname, '../../data')
const libraryPath = resolve(dataDir, 'library.json')

const gen = await import('../scripts/gen-library.mjs')
const { PROVENANCE_TERMS } = await import('../scripts/gen-guides.mjs')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const results = []
let currentSection = ''
function section(name) {
  currentSection = name
  console.log(`\n=== ${name} ===`)
}
function test(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = fn()
    results.push({ name: full, outcome: 'pass' })
    console.log(`  PASS  ${name}${evidence ? `\n          ${evidence}` : ''}`)
  } catch (err) {
    results.push({ name: full, outcome: 'fail' })
    console.log(`  FAIL  ${name}\n          ${err && err.message ? err.message : err}`)
  }
}
function check(cond, msg) {
  if (!cond) throw new Error(msg)
}

const catalog = JSON.parse(readFileSync(resolve(dataDir, 'catalog.json'), 'utf8'))
const shippedText = readFileSync(libraryPath, 'utf8')
const shipped = JSON.parse(shippedText)

// ===========================================================================
section('a. The shipped data/library.json is CURRENT, not stale')
// ===========================================================================

test('regenerating from the live datasets produces byte-identical output', () => {
  const rebuilt = JSON.stringify(gen.buildLibrary())
  check(
    rebuilt === shippedText,
    `data/library.json is STALE — regenerating it changes ${Math.abs(rebuilt.length - shippedText.length)} bytes ` +
      `(shipped ${shippedText.length}, rebuilt ${rebuilt.length}). Run \`node app/scripts/gen-library.mjs\` and commit the result.`,
  )
  return `${shippedText.length} bytes, byte-identical on rebuild`
})

test('the generator is DETERMINISTIC (two runs, same bytes, no timestamp)', () => {
  const a = JSON.stringify(gen.buildLibrary())
  const b = JSON.stringify(gen.buildLibrary())
  check(a === b, 'two consecutive builds differ — something non-deterministic (a clock? a Set iteration?) got in')
  check(!/\b20\d\d-\d\d-\d\dT/.test(a), 'the output contains an ISO timestamp — rebuilds would churn the deploy')
  return 'two runs identical; no ISO timestamp in the output'
})

// ===========================================================================
section('b. Shape: one entry per catalog machine, every field in range')
// ===========================================================================

test('one entry per catalog machine, ids matching exactly and in catalog order', () => {
  check(shipped.v === gen.LIBRARY_SCHEMA_VERSION, `schema version ${shipped.v} != ${gen.LIBRARY_SCHEMA_VERSION}`)
  check(
    shipped.machines.length === catalog.length,
    `library has ${shipped.machines.length} entries, catalog has ${catalog.length}`,
  )
  const libIds = shipped.machines.map((m) => m.id).join('|')
  const catIds = catalog.map((m) => m.id).join('|')
  check(libIds === catIds, 'library ids do not match catalog ids in order')
  return `${shipped.machines.length} entries, ids identical to catalog.json`
})

test('every entry carries a non-empty name/title/shortTitle/mfr and a real year', () => {
  const bad = []
  for (const m of shipped.machines) {
    for (const key of ['id', 'name', 'title', 'shortTitle', 'mfr', 'mfrGroup']) {
      if (typeof m[key] !== 'string' || m[key].trim() === '') bad.push(`${m.id}.${key}=${JSON.stringify(m[key])}`)
    }
    if (!Number.isInteger(m.year) || m.year < 1930 || m.year > 2100) bad.push(`${m.id}.year=${m.year}`)
    if (!Number.isInteger(m.goals) || m.goals < 0) bad.push(`${m.id}.goals=${m.goals}`)
    if (!Number.isInteger(m.ach) || m.ach < 0) bad.push(`${m.id}.ach=${m.ach}`)
  }
  check(bad.length === 0, `${bad.length} bad field(s): ${bad.slice(0, 6).join(', ')}`)
  const years = shipped.machines.map((m) => m.year)
  return `all ${shipped.machines.length} entries; years span ${Math.min(...years)}-${Math.max(...years)}`
})

test('`title` is the catalog name with its "(Manufacturer, Year)" tail removed', () => {
  const bad = shipped.machines.filter((m) => m.name !== `${m.title} (${m.mfr}, ${m.year})`)
  check(bad.length === 0, `${bad.length} mismatched: ${bad.slice(0, 3).map((m) => m.id).join(', ')}`)
  const diacritics = shipped.machines.filter((m) => /[^\x20-\x7e]/.test(m.title)).map((m) => m.title)
  check(diacritics.length > 0, 'expected at least one non-ASCII title to prove nothing is being stripped')
  return `name == "title (mfr, year)" for all ${shipped.machines.length}; non-ASCII titles preserved verbatim: ${diacritics.join(', ')}`
})

test('every coordinate is a finite number rounded to 3 decimal places', () => {
  const offenders = []
  const check3 = (label, n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return offenders.push(`${label}=${n}`)
    if (Math.round(n * 1000) / 1000 !== n) offenders.push(`${label}=${n}`)
  }
  let coords = 0
  for (const m of shipped.machines) {
    for (const s of m.shots) {
      check3(`${m.id}.shot.x`, s.x)
      check3(`${m.id}.shot.y`, s.y)
      coords += 2
    }
    for (const f of m.flippers) {
      check3(`${m.id}.flipper.x`, f.x)
      check3(`${m.id}.flipper.y`, f.y)
      coords += 2
    }
    for (const z of m.zones) {
      for (const k of ['x', 'y', 'w', 'h']) check3(`${m.id}.zone.${k}`, z[k])
      coords += 4
    }
    if (m.plungeX !== null) {
      check3(`${m.id}.plungeX`, m.plungeX)
      coords += 1
    }
  }
  check(offenders.length === 0, `${offenders.length} un-rounded value(s): ${offenders.slice(0, 5).join(', ')}`)
  return `${coords} coordinates, every one at <= 3dp`
})

test('every shot sits inside the playfield unit square, and no machine is empty', () => {
  const bad = []
  for (const m of shipped.machines) {
    if (m.shots.length === 0) bad.push(`${m.id} has no shots`)
    for (const s of m.shots) {
      if (!(s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1)) bad.push(`${m.id} (${s.x},${s.y})`)
      if ('p' in s && s.p !== 1) bad.push(`${m.id} p=${s.p}`)
    }
  }
  check(bad.length === 0, `${bad.length} problem(s): ${bad.slice(0, 5).join(', ')}`)
  const total = shipped.machines.reduce((n, m) => n + m.shots.length, 0)
  const decked = shipped.machines.reduce((n, m) => n + m.shots.filter((s) => s.p === 1).length, 0)
  return `${total} shots in [0,1]^2, ${decked} flagged as deck shots (p:1)`
})

test('every machine gets exactly one left + one right main flipper', () => {
  const bad = shipped.machines.filter(
    (m) => m.flippers.length !== 2 || m.flippers[0].s !== 'l' || m.flippers[1].s !== 'r' || m.flippers[0].x >= m.flippers[1].x,
  )
  check(bad.length === 0, `${bad.length} malformed pair(s): ${bad.slice(0, 3).map((m) => m.id).join(', ')}`)
  // The fallback pair is the landmark that makes a thumbnail read as a
  // playfield for a machine whose dataset models no flipper shot at all —
  // reported, not asserted at a fixed count, since datasets keep being
  // authored.
  const fallback = shipped.machines.filter((m) => m.flippers[0].x === 0.33 && m.flippers[1].x === 0.67).length
  return `all ${shipped.machines.length} pairs l<r; ${fallback} using the standard-body fallback pivots`
})

test('plungeX is either null or a real x, and zones carry a known kind', () => {
  const bad = []
  for (const m of shipped.machines) {
    if (m.plungeX !== null && !(m.plungeX >= 0 && m.plungeX <= 1)) bad.push(`${m.id}.plungeX=${m.plungeX}`)
    for (const z of m.zones) {
      if (!['upper', 'mini', 'lower'].includes(z.k)) bad.push(`${m.id}.zone.k=${z.k}`)
      if (!(z.w > 0 && z.h > 0)) bad.push(`${m.id}.zone ${z.w}x${z.h}`)
    }
  }
  check(bad.length === 0, `${bad.length} problem(s): ${bad.slice(0, 5).join(', ')}`)
  const noPlunge = shipped.machines.filter((m) => m.plungeX === null).map((m) => m.id)
  const zones = shipped.machines.reduce((n, m) => n + m.zones.length, 0)
  return `${zones} zones, all of a known kind; ${noPlunge.length} machine(s) model no plunge (${noPlunge.join(', ') || 'none'})`
})

// ===========================================================================
section('c. No prose: both guards refuse, and the shipped bytes are clean')
// ===========================================================================

test('the shipped file contains no key outside the declared schema', () => {
  const seen = new Set()
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        seen.add(k)
        walk(val)
      }
    }
  }
  walk(shipped)
  const undeclared = [...seen].filter((k) => !gen.LIBRARY_KEYS.has(k))
  check(undeclared.length === 0, `undeclared key(s) in the shipped file: ${undeclared.join(', ')}`)
  return `${seen.size} distinct keys, all declared: ${[...seen].sort().join(' ')}`
})

test('the key gate REFUSES a seeded prose field, at every depth it can appear', () => {
  // Driven directly, not inferred from today's clean output: a gate that has
  // stopped being called looks identical to a gate that has nothing to catch.
  const cases = [
    ['top level', (d) => (d.notes = 'x')],
    ['machine', (d) => (d.machines[0].summary = 'x')],
    ['shot', (d) => (d.machines[0].shots[0].sources = ['x'])],
    // The two below are the reason this gate is LEVEL-aware rather than one
    // flat key set: `name` is a legal MACHINE field, so a flat set had no
    // objection to a zone's own display name ("Orca Deck" — dataset prose)
    // riding along under the same spelling. Found by seeding it.
    ['zone (borrowing a key that is legal on a machine)', (d) => (d.machines.find((m) => m.zones.length).zones[0].name = 'Orca Deck')],
    ['shot (same trick, one level deeper)', (d) => (d.machines[0].shots[0].title = 'Left Orbit')],
    ['flipper', (d) => (d.machines[0].flippers[0].instructions = 'x')],
  ]
  const missed = []
  for (const [where, mutate] of cases) {
    const doc = JSON.parse(shippedText)
    mutate(doc)
    let threw = false
    try {
      gen.assertNoUnknownKeys(doc)
    } catch {
      threw = true
    }
    if (!threw) missed.push(where)
  }
  check(missed.length === 0, `the key gate missed a seeded field at: ${missed.join(', ')}`)
  // Negative control: the unmutated document must pass silently, or the
  // catches above prove nothing.
  gen.assertNoUnknownKeys(JSON.parse(shippedText))
  return `${cases.length}/${cases.length} seeded prose fields refused (${cases.map((c) => c[0]).join(' · ')}); the real document passes`
})

test('the provenance gate trips on EVERY term in the shared list', () => {
  const missed = []
  for (const term of PROVENANCE_TERMS) {
    let threw = false
    try {
      gen.assertNoProvenance(`{"machines":[{"title":"Something ${term} something"}]}`)
    } catch {
      threw = true
    }
    if (!threw) missed.push(term)
  }
  check(missed.length === 0, `${missed.length} term(s) did not trip the guard: ${missed.join(', ')}`)
  return `all ${PROVENANCE_TERMS.length} terms refused`
})

test('the provenance gate is case-insensitive (a title-cased paste is caught)', () => {
  let threw = false
  try {
    gen.assertNoProvenance('{"x":"Per Community Consensus the ramp is safe"}')
  } catch {
    threw = true
  }
  check(threw, 'a title-cased provenance term walked past the guard')
  return '"Per Community Consensus" refused'
})

test('the SHIPPED bytes contain no provenance term and no dataset prose field', () => {
  gen.assertNoProvenance(shippedText) // throws on any needle
  const proseKeys = ['notes', 'summary', 'instructions', 'sources', 'desc', 'reward', 'action', 'detail', 'technique', 'how']
  const found = proseKeys.filter((k) => shippedText.includes(`"${k}":`))
  check(found.length === 0, `dataset prose key(s) present in the published file: ${found.join(', ')}`)
  return `clean against ${PROVENANCE_TERMS.length} provenance terms and ${proseKeys.length} dataset prose keys`
})

// ===========================================================================
section('d. Manufacturer and year: parsed for all, and the maker fold holds')
// ===========================================================================

test('Stern Pinball and Stern fold to one group, as do Sega and Jersey Jack', () => {
  const groups = new Map()
  for (const m of shipped.machines) {
    if (!groups.has(m.mfrGroup)) groups.set(m.mfrGroup, new Set())
    groups.get(m.mfrGroup).add(m.mfr)
  }
  // The bug this prevents: two chips reading "Stern" and "Stern Pinball".
  const splits = [...groups.keys()].filter((g) => [...groups.keys()].some((o) => o !== g && o.startsWith(`${g} `)))
  check(splits.length === 0, `these groups are split by a suffix: ${splits.join(', ')}`)
  const stern = groups.get('Stern')
  check(stern && stern.has('Stern') && stern.has('Stern Pinball'), `Stern group holds ${[...(stern ?? [])].join(' + ')}`)
  const lines = [...groups.entries()]
    .map(([g, set]) => `${g}(${shipped.machines.filter((m) => m.mfrGroup === g).length})`)
    .sort()
  return `${groups.size} maker groups: ${lines.join(' ')}`
})

test('every decade the catalog spans is representable from `year` alone', () => {
  const decades = new Set(shipped.machines.map((m) => Math.floor(m.year / 10) * 10))
  check(decades.size >= 3, `expected several decades, got ${[...decades].join(', ')}`)
  const counts = [...decades].sort().map((d) => `${d}s:${shipped.machines.filter((m) => Math.floor(m.year / 10) * 10 === d).length}`)
  return counts.join(' ')
})

// ===========================================================================
section('e. The main-flipper rule does not promote a mini flipper')
// ===========================================================================

test('JAWS: its "Mini-Flipper Lane" / "Mid-Right Mini Flipper" are NOT the main pair', () => {
  // The exact regression overlay/map2d.ts's isMainFlipper comment documents: a
  // loose test made a mini flipper at y=0.30 the right main flipper, so the
  // bat was painted a third of the way up the playfield.
  const jawsDoc = JSON.parse(readFileSync(resolve(dataDir, 'jaws_goals.json'), 'utf8'))
  const suspects = jawsDoc.shots.filter((s) => /flipper/i.test(s.name))
  check(suspects.length > 0, 'fixture drift: jaws no longer has any flipper-named shots')
  const jaws = shipped.machines.find((m) => m.id === 'jaws')
  for (const f of jaws.flippers) {
    check(f.y <= 0.25, `a main flipper at y=${f.y} is too far up the playfield`)
  }
  return `jaws flipper-named shots: ${suspects.map((s) => `${s.name}@y${s.y}`).join(', ')} -> main pair y=${jaws.flippers.map((f) => f.y).join('/')}`
})

test('no machine anywhere gets a main flipper above y=0.25', () => {
  const bad = shipped.machines.filter((m) => m.flippers.some((f) => f.y > 0.25))
  check(bad.length === 0, `${bad.length}: ${bad.slice(0, 5).map((m) => `${m.id}@${m.flippers.map((f) => f.y)}`).join(', ')}`)
  const maxY = Math.max(...shipped.machines.flatMap((m) => m.flippers.map((f) => f.y)))
  return `highest main-flipper pivot across the catalog: y=${maxY}`
})

// ===========================================================================
section('f. Size: inside the budget the generator itself enforces')
// ===========================================================================

test(`the shipped file is under the ${gen.LIBRARY_MAX_BYTES}-byte budget`, () => {
  const bytes = statSync(libraryPath).size
  check(bytes <= gen.LIBRARY_MAX_BYTES, `${bytes} bytes exceeds ${gen.LIBRARY_MAX_BYTES}`)
  const gz = gzipSync(Buffer.from(shippedText, 'utf8'), { level: 9 }).length
  const pct = ((bytes / gen.LIBRARY_MAX_BYTES) * 100).toFixed(1)
  return `${bytes} bytes raw (${(bytes / 1024).toFixed(1)} KB, ${pct}% of budget) · ${gz} bytes gzipped (${(gz / 1024).toFixed(1)} KB)`
})

// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.outcome === 'fail')
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed (${results.length} checks)`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`)
  process.exit(1)
}
