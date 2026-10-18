#!/usr/bin/env node
// app/tests/guide-pages.test.mjs — SUITE 8: Phase 4 SEO guide-page generator
// (app/scripts/gen-guides.mjs).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/guide-pages.test.mjs"
// or from app/:
//   node tests/guide-pages.test.mjs
//
// Pattern differs slightly from this repo's other suites: gen-guides.mjs is
// already plain ESM JavaScript (no TypeScript, no DOM/CSS imports), so there
// is nothing for esbuild to bundle — this suite imports it directly and
// calls its exported functions, then (Section 3 on) runs the REAL main() to
// regenerate app/public/machines/** + sitemap.xml from the REAL
// data/catalog.json + whatever data/guides.json currently contains, and
// makes every assertion against those actual files on disk. No fixture
// duplication in this test file — if gen-guides.mjs's header comment or
// data/guides.json's shape drifts, this suite reads the same files the real
// build does and will feel it immediately.
//
// COVERAGE NOTE (read before "fixing" a skip). data/guides.json is, as of
// this writing, a 3-machine FIXTURE (jaws/godzilla/breakshot) — the content
// agent producing the real 62-machine file runs separately (see
// gen-guides.mjs's header). Section 5's "every catalog machine has a page"
// check is written as a REAL assertion, not hand-waved away — it just
// SKIPS itself while guides.json has fewer entries than catalog.json,
// via skippableTest() below, so it activates automatically (no edit
// needed here) the moment guides.json reaches full coverage.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const publicDir = resolve(appDir, 'public')
const machinesDir = resolve(publicDir, 'machines')

// pathToFileURL, not string concatenation — the repo path contains a space
// ("Pinball Genie"), which a bare `'file://' + path` would mangle.
const gen = await import(pathToFileURL(resolve(appDir, 'scripts/gen-guides.mjs')).href)

// ---------------------------------------------------------------------------
// Minimal test harness (no vitest/tsx in this repo — see adslot-gate.test.mjs's
// header). Adds skippableTest() alongside the usual section/test/assert —
// see the COVERAGE NOTE above for why one check in this suite needs it.
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

function skippableTest(name, skipReason, fn) {
  const full = `${currentSection} :: ${name}`
  if (skipReason) {
    results.push({ name: full, outcome: 'skip' })
    console.log(`  SKIP  ${name}\n          ${skipReason}`)
    return
  }
  test(name, fn)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ===========================================================================
section('1. normalizeSlug() folds [-_] the same way for both directions')
// ===========================================================================
// The 4 catalog ids that differ from their RULES-*.md stem only by
// underscore vs hyphen (task brief: black_knight_2000 vs black-knight-2000,
// and 3 others) are exactly the case this function exists for.
test('hyphen and underscore forms normalize identically', () => {
  assert(gen.normalizeSlug('black-knight-2000') === gen.normalizeSlug('black_knight_2000'), 'expected both forms to fold to the same string')
  assert(gen.normalizeSlug('THEATRE_OF_MAGIC') === gen.normalizeSlug('theatre-of-magic'), 'expected case + separator folding together')
})
test('a genuinely different slug does not collide', () => {
  assert(gen.normalizeSlug('jaws') !== gen.normalizeSlug('godzilla'), 'different machines must not normalize to the same key')
})

// ===========================================================================
section('2. escapeHtml() and assertNoProvenance()')
// ===========================================================================
test('escapeHtml() escapes all 5 XML entities', () => {
  const out = gen.escapeHtml(`<a href="x">D&D's "best"</a>`)
  assert(!out.includes('<') && !out.includes('>'), `expected no raw angle brackets, got: ${out}`)
  assert(out.includes('&amp;'), 'expected & to be escaped')
  assert(out.includes('&quot;'), 'expected " to be escaped')
  assert(out.includes('&#39;'), "expected ' to be escaped")
  return out
})
test('assertNoProvenance() throws on each known provenance term', () => {
  for (const term of gen.PROVENANCE_TERMS) {
    let threw = false
    try {
      gen.assertNoProvenance(`some text mentioning ${term} in passing`, 'test string')
    } catch {
      threw = true
    }
    assert(threw, `expected assertNoProvenance() to throw on "${term}"`)
  }
  return `verified all ${gen.PROVENANCE_TERMS.length} terms trip the guard`
})
test('assertNoProvenance() does not throw on ordinary guide prose', () => {
  gen.assertNoProvenance('Shoot the ramp to start multiball, then bash the drop targets for the jackpot.', 'test string')
})

// ===========================================================================
section('3. matchGuidesToCatalog() against the REAL catalog.json + guides.json')
// ===========================================================================
const catalog = gen.loadCatalog()
const guides = gen.loadGuides()
const { matched, unmatchedCatalog, unmatchedGuides } = gen.matchGuidesToCatalog(catalog, guides)

// Deliberately NOT a hardcoded count. This assertion used to read `=== 62` and
// broke the moment machines were added (2026-07-31, the Pinball Hall of Fame
// import), which is a false failure: a growing catalog is the normal case and
// the number here was never the thing under test. What this actually needs to
// guarantee is that a real catalog loaded at all — an empty or unparsed
// catalog.json would make every downstream matching assertion below vacuously
// pass.
test('precondition: catalog.json loaded with machines', () => {
  assert(Array.isArray(catalog), 'expected catalog.json to parse to an array')
  assert(catalog.length > 0, `expected a non-empty catalog, got ${catalog.length}`)
  return `${catalog.length} catalog machines`
})
test('precondition: guides.json loaded (fixture or real)', () => {
  assert(Array.isArray(guides) && guides.length > 0, 'expected at least one guides.json entry to develop/test against')
  return `${guides.length} guides.json entr${guides.length === 1 ? 'y' : 'ies'}: ${guides.map((g) => g.slug).join(', ')}`
})
test('every guides.json entry matches exactly one catalog machine', () => {
  assert(unmatchedGuides.length === 0, `expected every guides.json slug to match a catalog id, unmatched: ${unmatchedGuides.join(', ')}`)
  assert(matched.length === guides.length, `expected ${guides.length} matches, got ${matched.length}`)
})

// ===========================================================================
section('4. Regenerate app/public/machines/** + sitemap.xml from real data')
// ===========================================================================
test('main() runs without throwing against the real data/ directory', () => {
  gen.main()
})

const catalogById = new Map(catalog.map((c) => [c.id, c]))
const machineDirs = readdirSync(machinesDir).filter((f) => statSync(resolve(machinesDir, f)).isDirectory())

test('one directory per matched machine, no extras, no 404s', () => {
  const expected = matched.map((m) => m.catalogEntry.id).sort()
  assert(
    JSON.stringify(machineDirs.slice().sort()) === JSON.stringify(expected),
    `expected directories ${JSON.stringify(expected)}, got ${JSON.stringify(machineDirs.slice().sort())}`,
  )
  return `${machineDirs.length} machine director${machineDirs.length === 1 ? 'y' : 'ies'} on disk`
})

test('guide.css and machines/index.html were both written', () => {
  assert(statSync(resolve(machinesDir, 'guide.css')).isFile(), 'expected app/public/machines/guide.css')
  assert(statSync(resolve(machinesDir, 'index.html')).isFile(), 'expected app/public/machines/index.html')
})

// ===========================================================================
section('5. Per-page content requirements (title/description/canonical/CSP/provenance)')
// ===========================================================================
const pages = machineDirs.map((slug) => ({
  slug,
  html: readFileSync(resolve(machinesDir, slug, 'index.html'), 'utf8'),
}))
const indexHtml = readFileSync(resolve(machinesDir, 'index.html'), 'utf8')
const guideCss = readFileSync(resolve(machinesDir, 'guide.css'), 'utf8')

skippableTest(
  'every catalog machine (all 62) has a generated page',
  guides.length < catalog.length
    ? `guides.json currently has ${guides.length}/${catalog.length} entries (see gen-guides.mjs header: this is a content-agent fixture, not the real dataset) — this check activates for real once guides.json reaches full 62-machine coverage`
    : null,
  () => {
    const missing = [...catalogById.keys()].filter((id) => !machineDirs.includes(id))
    assert(missing.length === 0, `catalog machines with no generated page: ${missing.join(', ')}`)
  },
)

test('every page has a unique <title>', () => {
  const titles = pages.map((p) => p.html.match(/<title>([^<]*)<\/title>/)?.[1])
  assert(titles.every(Boolean), 'every page must have a non-empty <title>')
  assert(new Set(titles).size === titles.length, `expected unique titles, got: ${JSON.stringify(titles)}`)
  return titles.join(' | ')
})

test('every page has a unique meta description', () => {
  const descs = pages.map((p) => p.html.match(/<meta name="description" content="([^"]*)"/)?.[1])
  assert(descs.every((d) => typeof d === 'string' && d.length > 0), 'every page must have a non-empty meta description')
  assert(new Set(descs).size === descs.length, 'expected unique meta descriptions across pages')
})

test('every page has a matching canonical URL', () => {
  for (const { slug, html } of pages) {
    const canon = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1]
    assert(canon === `https://pinball-genie.com/machines/${slug}`, `${slug}: expected canonical https://pinball-genie.com/machines/${slug}, got ${canon}`)
  }
})

test('every page has exactly one Article+BreadcrumbList JSON-LD block (not HowTo, not FAQ)', () => {
  for (const { slug, html } of pages) {
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    assert(scripts.length === 1, `${slug}: expected exactly 1 ld+json script, found ${scripts.length}`)
    const parsed = JSON.parse(scripts[0][1])
    const types = parsed['@graph'].map((n) => n['@type'])
    assert(types.includes('Article'), `${slug}: expected an Article node in @graph`)
    assert(types.includes('BreadcrumbList'), `${slug}: expected a BreadcrumbList node in @graph`)
    assert(!types.includes('HowTo'), `${slug}: HowTo rich results were removed — must not reappear`)
    assert(!types.includes('FAQPage'), `${slug}: FAQ was deprecated 2026-05-07 — must not reappear`)
  }
})

test('every page links into the app (CTA href targets "/")', () => {
  for (const { slug, html } of pages) {
    assert(
      new RegExp(`class="cta" href="/\\?machine=${slug}"`).test(html),
      `${slug}: expected a .cta link back into the app with this machine's slug`,
    )
  }
})

test('machines/index.html links to every generated machine page', () => {
  for (const { slug } of pages) {
    assert(indexHtml.includes(`href="/machines/${slug}"`), `machines/index.html: missing a link to /machines/${slug}`)
  }
})

test('no page contains any provenance term (Tilt Forums / rulesheet / Pinside / etc.)', () => {
  const allFiles = [...pages.map((p) => ({ name: p.slug, html: p.html })), { name: 'machines/index.html', html: indexHtml }]
  for (const { name, html } of allFiles) {
    const lower = html.toLowerCase()
    for (const term of gen.PROVENANCE_TERMS) {
      // WORD BOUNDARY, matching gen-guides.mjs's assertNoProvenance exactly
      // (2026-07-31). A plain includes() here flagged "attributed to" inside
      // "frequently MISattributed to George Gomez" — a fact about who designed
      // Breakshot, not a citation — and failed a build whose pages were clean.
      // The generator and this test MUST use the same matching rule; two
      // copies that drift is how a guard ends up either crying wolf or silent.
      const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
      assert(!re.test(lower), `${name}: contains banned provenance term "${term}" — see gen-guides.mjs header for why this must never ship`)
    }
  }
  return `scanned ${allFiles.length} files against ${gen.PROVENANCE_TERMS.length} provenance terms`
})

// about.html word-wraps this sentence across 3 lines of source (indentation
// + newlines inside the <p>), so the precondition check below collapses
// whitespace runs before comparing — it's still byte-exact on every actual
// WORD, just tolerant of how the HTML happens to be line-wrapped. The
// generated guide pages render it as one unbroken string (see
// NON_AFFILIATION_LINE in gen-guides.mjs), so those are compared exactly.
const collapseWs = (s) => s.replace(/\s+/g, ' ').trim()

test('every page contains the exact non-affiliation sentence from about.html', () => {
  const sentence =
    'Pinball Genie is an independent, solo-built project operated by Pinball Genie LLC. It is not affiliated with, endorsed by, or sponsored by any pinball manufacturer or theme rights holder.'
  const aboutSrc = readFileSync(resolve(appDir, '../server/legal/about.html'), 'utf8')
  assert(
    collapseWs(aboutSrc).includes(sentence),
    'precondition failed: about.html no longer contains the expected sentence verbatim (whitespace-collapsed) — update the copied constant in gen-guides.mjs AND this test together',
  )
  for (const { slug, html } of pages) {
    assert(html.includes(sentence), `${slug}: missing the exact non-affiliation sentence copied from about.html`)
  }
})

test('CSP conformance: no style="" attributes, no on*= handlers anywhere', () => {
  for (const { slug, html } of pages.concat([{ slug: 'machines/index.html', html: indexHtml }])) {
    assert(!/\sstyle\s*=\s*"/.test(html), `${slug}: found a style="" attribute — CSP is style-src 'self', no unsafe-inline`)
    assert(!/\son[a-z]+\s*=\s*"/i.test(html), `${slug}: found an on*= event-handler attribute — CSP is script-src 'self', no unsafe-inline`)
  }
})

test('CSP conformance: every machine page has exactly one <script> tag, the ld+json block', () => {
  // machines/index.html carries no JSON-LD (it's a directory listing, not
  // an Article) and so is correctly script-free — scoped to per-machine
  // pages only, unlike the attribute check above which applies to both.
  for (const { slug, html } of pages) {
    const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)]
    assert(scriptTags.length === 1, `${slug}: expected exactly 1 <script> tag (the ld+json block), found ${scriptTags.length}`)
    assert(/<script type="application\/ld\+json">/.test(html), `${slug}: the one <script> tag must be the ld+json block`)
  }
})

test('machines/index.html has no <script> tag at all', () => {
  assert(![...indexHtml.matchAll(/<script\b[^>]*>/gi)].length, 'machines/index.html should be script-free (no JSON-LD needed for a plain listing page)')
})

test('guide.css has no @import (would be a cross-origin/self-only CSP risk) and is non-empty', () => {
  assert(guideCss.length > 500, 'expected a substantial stylesheet, not a stub')
  assert(!/@import/i.test(guideCss), 'guide.css must not @import another stylesheet')
})

test('guide.css is NOT an import of legal.css (task brief: separate file, same recipe)', () => {
  const legalCss = readFileSync(resolve(appDir, '../server/legal/legal.css'), 'utf8')
  assert(guideCss !== legalCss, 'guide.css should be its own file, not a byte-for-byte copy re-served')
  // Still the same house recipe — BACKGLASS values as of P5 (2026-08-14):
  // the ground moved #16181d -> #0a0b10 and the accent #f5a623 -> #ffb02e,
  // and these pages have to move WITH the app or the site reads as two
  // different products. Pinned here (rather than left to eyeballing) because
  // guide.css is a standalone copy of the palette by design — see its own
  // header comment in scripts/gen-guides.mjs.
  assert(guideCss.includes('#0a0b10') && guideCss.includes('#ffb02e'), 'expected the BACKGLASS ground/amber palette')
  // And the display face: the guides self-host the same Chakra Petch files
  // the app ships, from the same /fonts/ webroot path.
  assert(/@font-face/.test(guideCss), 'guide.css must declare its own @font-face — these pages do not load the app bundle')
  assert(
    /url\('\/fonts\/ChakraPetch-[A-Za-z]+-latin\.woff2'\)/.test(guideCss),
    'guide.css must reference the self-hosted /fonts/*.woff2 the app already deploys',
  )
  assert(!/https?:\/\//.test(guideCss), 'guide.css must not reference an external origin (strict CSP)')
  // The chrome pinball is gone from the brand mark (BACKGLASS): no radial
  // gradient masquerading as a steel ball anywhere in this stylesheet.
  assert(!/radial-gradient\(circle at 35% 30%/.test(guideCss), 'the .brand-ball chrome-ball recipe must be gone')
})

test('EVERY standalone stylesheet loads the font from an ABSOLUTE /fonts/ path — a relative one 404s at these pages\' nesting depths', () => {
  // K3 fast-follow #7 (2026-08-14). Three stylesheets outside the Vite bundle
  // carry their own @font-face: the generated guide pages, the sign-in page,
  // and the legal pages. They are served from DIFFERENT depths —
  // /machines/<slug>/ (two deep), / and /legal/ — so a relative
  // `url('./fonts/...')` or `url('fonts/...')` resolves against the page's own
  // directory and 404s on at least one of them, silently: the browser just
  // falls back to system-ui and nobody sees an error. One absolute path works
  // from every depth, and deploy-prod.sh puts the files at the webroot
  // (app/dist/. uploaded wholesale, Vite having copied public/fonts into it).
  const sheets = [
    ['machines/guide.css', guideCss],
    ['server/login.css', readFileSync(resolve(appDir, '../server/login.css'), 'utf8')],
    ['server/legal/legal.css', readFileSync(resolve(appDir, '../server/legal/legal.css'), 'utf8')],
  ]
  const rows = []
  for (const [name, css] of sheets) {
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])
    assert(faces.length > 0, `${name} declares no @font-face — its pages would render in the system stack while the rest of the site does not`)
    for (const face of faces) {
      const url = /url\(['"]?([^'")]+)['"]?\)/.exec(face)
      assert(url, `${name} has an @font-face with no url()`)
      assert(
        url[1].startsWith('/fonts/'),
        `${name} loads a font from ${JSON.stringify(url[1])} — it must be an ABSOLUTE /fonts/... path`,
      )
      assert(/font-display:\s*swap/.test(face), `${name}'s @font-face must declare font-display: swap`)
    }
    assert(!/https?:\/\//.test(css), `${name} references an external origin — the CSP forbids it`)
    rows.push(`${name}: ${faces.length} face(s)`)
  }
  return rows.join('; ')
})

// ===========================================================================
section('6. sitemap.xml lists exactly the pages that exist — no 404s, no omissions')
// ===========================================================================
const sitemapXml = readFileSync(resolve(publicDir, 'sitemap.xml'), 'utf8')
const sitemapLocs = [...sitemapXml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])
const sitemapMachineSlugs = sitemapLocs
  .filter((loc) => loc.startsWith('https://pinball-genie.com/machines/'))
  .map((loc) => loc.replace('https://pinball-genie.com/machines/', ''))

test('sitemap contains no duplicate URLs', () => {
  assert(new Set(sitemapLocs).size === sitemapLocs.length, 'expected every <loc> to be unique')
})

test('every /machines/<slug> URL in the sitemap has a real generated page (no 404s)', () => {
  const missing = sitemapMachineSlugs.filter((slug) => !machineDirs.includes(slug))
  assert(missing.length === 0, `sitemap references machine pages that do not exist: ${missing.join(', ')}`)
})

test('every generated machine page is listed in the sitemap (no omissions)', () => {
  const omitted = machineDirs.filter((slug) => !sitemapMachineSlugs.includes(slug))
  assert(omitted.length === 0, `generated pages missing from sitemap: ${omitted.join(', ')}`)
})

test('sitemap also lists /machines and the 5 pre-existing static URLs', () => {
  const required = ['https://pinball-genie.com/', 'https://pinball-genie.com/machines', 'https://pinball-genie.com/about', 'https://pinball-genie.com/privacy', 'https://pinball-genie.com/terms', 'https://pinball-genie.com/contact']
  for (const url of required) {
    assert(sitemapLocs.includes(url), `sitemap missing required URL: ${url}`)
  }
})

// ===========================================================================
section('7. Build wiring — prebuild cannot be forgotten')
// ===========================================================================
test('package.json has a "prebuild" script that runs gen-guides.mjs', () => {
  const pkg = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8'))
  assert(pkg.scripts && typeof pkg.scripts.prebuild === 'string', 'expected a "prebuild" script in app/package.json')
  assert(pkg.scripts.prebuild.includes('gen-guides.mjs'), `expected prebuild to run gen-guides.mjs, got: ${pkg.scripts.prebuild}`)
  // npm runs "pre<script>" automatically before "<script>" for any script
  // name (documented npm-lifecycle behavior, not special-cased here) — so
  // "build": "vite build" needs no change; this assertion just pins down
  // that the hook script itself is present, since a missing/renamed
  // prebuild is the actual way this could silently stop running.
})

// ===========================================================================
// ===========================================================================
section('9. How it plays (schema v9)')
// ===========================================================================
// Dataset schema v9 adds an optional top-level `howItPlays` field. No dataset
// carries it yet, so the contract here is two-sided: a FULL synthetic doc
// must render the whole section correctly (escaping, control labels, tier
// order, resolvable goal links only), and a real doc WITHOUT the field must
// render nothing at all — the schema-v9 slice has to ship as a zero-diff
// change to today's 62 pages.

test('renders nothing when howItPlays is absent or null (fail-soft, zero page diffs today)', () => {
  assert(gen.renderHowItPlaysSection({}, 'X', 'x') === '', 'expected empty string for a doc with no howItPlays')
  assert(gen.renderHowItPlaysSection({ howItPlays: null }, 'X', 'x') === '', 'expected empty string for howItPlays: null')
})

test('a full howItPlays renders: escaped objective, loop list, lights with control clause, lane-change line, ordered scoring tiers, resolvable goal links only', () => {
  const howItPlaysDoc = {
    goals: [
      { id: 'g1', title: 'Hit the saucer', summary: '', reward: '' },
      { id: 'g2', title: 'Light multiball', summary: '', reward: '' },
    ],
    howItPlays: {
      objective: 'Light shots & lock balls <fast>',
      loop: ['Shoot the left lane', 'Shoot the saucer', 'Complete the lanes', 'Lock a ball'],
      lights: [
        {
          id: 'l1',
          name: 'Saucer',
          kind: 'lanes',
          sites: [{ shot: 'left lane' }],
          lit: 'Saucer is lit',
          then: 'Shoot the lit lane',
          control: { input: 'either-flipper', effect: 'rotates the lit lane', when: 'always' },
        },
      ],
      laneChange: 'flippers',
      laneChangeNote: 'The flipper buttons rotate the lit lane.',
      scoring: [
        { tier: 'ball-one', text: 'Start the first mode', goals: ['g1', 'nope'] },
        { tier: 'building', text: 'Build the multiplier' },
        { tier: 'the-big-one', text: 'Reach the wizard mode', goals: ['g2'] },
      ],
    },
  }
  const html = gen.renderHowItPlaysSection(howItPlaysDoc, 'Testmachine', 'testmachine')
  assert(html.includes('How Testmachine plays'), 'h2 heading missing')
  // The objective contains & and < on purpose: if escaping is skipped these
  // land in the page as raw markup — assert on what a visitor SEES.
  assert(
    html.includes('Light shots &amp; lock balls &lt;fast&gt;'),
    'objective was not HTML-escaped',
  )
  const ol = html.match(/<ol>([\s\S]*?)<\/ol>/)
  assert(ol, 'no loop list rendered')
  assert((ol[1].match(/<li>/g) || []).length === 4, `expected 4 loop items, got ${(ol[1].match(/<li>/g) || []).length}`)
  assert(html.includes('lit: Saucer is lit'), 'lights list missing lit text')
  assert(html.includes('then: Shoot the lit lane'), 'lights list missing then text')
  assert(html.includes('Either flipper button'), 'control clause missing input label')
  assert(
    html.includes('Lane change: the flipper buttons move the lit lane.'),
    'lane-change sentence for flippers missing',
  )
  const b1 = html.indexOf('<strong>Ball one</strong>')
  const b2 = html.indexOf('<strong>Building</strong>')
  const b3 = html.indexOf('<strong>The big one</strong>')
  assert(b1 !== -1 && b2 !== -1 && b3 !== -1, 'scoring tier labels missing')
  assert(b1 < b2 && b2 < b3, 'scoring tiers out of order')
  assert(
    html.includes('href="/?machine=testmachine&amp;goal=g1"'),
    'goal deep link missing or wrong shape',
  )
  assert(html.includes('rel="nofollow"'), 'goal deep link missing rel="nofollow"')
  assert(!html.includes('goal=nope'), 'unresolvable goal id leaked into the output as a link')
})

test('provenance guard covers howItPlays strings and names the field path', () => {
  let threw = null
  try {
    gen.renderHowItPlaysSection(
      {
        howItPlays: {
          objective: 'Shoot things.',
          loop: [],
          lights: [
            { name: 'Saucer', kind: 'lanes', lit: 'according to the rulesheet the arrow pays', then: 'Shoot it' },
          ],
          scoring: [],
        },
      },
      'X',
      'x',
    )
  } catch (err) {
    threw = err
  }
  assert(threw, 'expected assertNoProvenance to throw on a howItPlays string')
  assert(
    /howItPlays\.lights\[0\]\.lit|rulesheet/.test(threw.message),
    `error should name the field path or the banned term, got: ${threw.message}`,
  )
})

test('page order: the how-it-plays h2 precedes the action-button and goals sections', () => {
  const doc = {
    goals: [
      { id: 'g1', title: 'Hit the saucer', summary: '', reward: '' },
    ],
    actionButton: { present: true, label: 'Action Button', how: 'Press it to launch the ball.', uses: [] },
    howItPlays: {
      objective: 'Light shots and lock balls.',
      loop: ['Shoot the left lane', 'Shoot the saucer', 'Complete the lanes'],
      lights: [
        { id: 'l1', name: 'Saucer', kind: 'lanes', sites: [{ shot: 'left lane' }], lit: 'Saucer is lit', then: 'Shoot the lit lane' },
      ],
      laneChange: 'unknown',
      scoring: [{ tier: 'ball-one', text: 'Start the first mode', goals: ['g1'] }],
    },
  }
  const page = gen.renderMachinePage({
    catalogEntry: { id: 'testmachine', resource: 'testmachine_goals' },
    guide: {
      name: 'Testmachine',
      manufacturer: 'Test Pinball',
      year: 2026,
      description: 'An original guide description.',
      body: [{ tag: 'p', text: 'Body prose.' }],
    },
    goalsDoc: doc,
  })
  const hip = page.indexOf('How Testmachine plays')
  const ab = page.indexOf('The Action Button on Testmachine')
  const goals = page.indexOf('Goals in Testmachine')
  assert(hip !== -1, 'how-it-plays section missing from the rendered page')
  assert(ab !== -1, 'action-button section missing from the rendered page')
  assert(goals !== -1, 'goals section missing from the rendered page')
  assert(hip < ab && ab < goals, 'section order wrong: how-it-plays must precede action button and goals')
})

test('zero-diff pin: a dataset without howItPlays renders no section (fail-soft)', () => {
  // Every catalog machine now carries howItPlays (v9 program complete 2026-09-08),
  // so this pins the fail-soft path against a SYNTHETIC no-field doc rather than a
  // real dataset: any future or shelved machine lacking the field must still
  // render the section as '' (zero page diff), never crash or emit a stub.
  const goalsDoc = { machine: 'Synthetic (Test, 2026)', shots: [], goals: [] }
  assert(!goalsDoc.howItPlays, 'fixture must have no howItPlays')
  assert(
    gen.renderHowItPlaysSection(goalsDoc, 'synthetic', 'synthetic') === '',
    "a doc with no howItPlays must render '' (zero page diffs)",
  )
  return 'pinned against a synthetic no-field doc'
})

section('8. Goal deep links into the app (P7a, 2026-08-14)')
// ===========================================================================
// Every goal title on a guide page is a link to `/?machine=<slug>&goal=<id>`,
// which src/state.ts's parseDeepLink resolves on boot. A link like that is
// only worth anything if BOTH halves are real: a typo'd slug or a goal id
// that no longer exists lands the reader on the default machine's goal list
// with no error and no clue anything went wrong — the exact silent failure
// the `?machine=` parameter itself shipped with in 2026-07-31 (this suite's
// section 5 CTA check exists for the same reason).
//
// So this section re-reads the machine's REAL goals file and checks the ids
// in the generated HTML against it, rather than checking the HTML against
// itself.

/** Goal-title cells as generated, per page: the raw <p class="goal-title">…
 *  innerHTML, which is either a bare title or an <a> wrapping one. */
function goalTitleCells(html) {
  return [...html.matchAll(/<p class="goal-title">([\s\S]*?)<\/p>/g)].map((m) => m[1])
}

test('every goal title on every page is a deep link, and every id is a REAL goal of that machine', () => {
  let linked = 0
  let unlinked = 0
  const problems = []
  for (const { slug, html } of pages) {
    const entry = catalogById.get(slug)
    const goalsDoc = entry ? gen.loadGoals(entry.resource) : null
    const realIds = new Set((goalsDoc?.goals ?? []).map((g) => g.id))
    for (const cell of goalTitleCells(html)) {
      const href = cell.match(/^<a href="([^"]*)"/)?.[1]
      if (!href) {
        unlinked += 1
        problems.push(`${slug}: a goal title is not a link (${cell.slice(0, 60)})`)
        continue
      }
      linked += 1
      // &amp; is how an ampersand must be written in an attribute; the
      // browser hands the app a single &.
      const m = href.match(/^\/\?machine=([^&]+)&amp;goal=(.+)$/)
      if (!m) {
        problems.push(`${slug}: unexpected href shape ${href}`)
        continue
      }
      const [, linkSlug, linkGoal] = m
      if (decodeURIComponent(linkSlug) !== slug) problems.push(`${slug}: link points at machine "${linkSlug}"`)
      if (!realIds.has(decodeURIComponent(linkGoal))) problems.push(`${slug}: no such goal id "${linkGoal}"`)
    }
  }
  assert(problems.length === 0, problems.slice(0, 8).join(' | '))
  assert(linked > 0, 'no goal deep links were generated at all')
  return `${linked} goal links checked against the real goals files, ${unlinked} plain titles`
})

test('EVERY goal deep link is rel="nofollow" — and the editorial CTA is NOT', () => {
  // SEO (K3 review, 2026-08-14). These links are UX affordances: 2905 of them
  // pointing at 2905 query-string variants of ONE app shell. Followable, they
  // invite a crawler to spend this site's budget re-fetching the same document
  // with different parameters, and they split each guide page's link equity
  // across thirty outbound links to a page with nothing to index.
  //
  // The CTA at the top of each page is the opposite — one editorial "open this
  // machine in the app" — and must stay followable. Asserting both directions
  // is what stops a future blanket `rel="nofollow"` sweep from nofollowing the
  // one link that should carry weight.
  let checked = 0
  for (const { slug, html } of pages) {
    for (const cell of goalTitleCells(html)) {
      const tag = cell.match(/^<a [^>]*>/)?.[0]
      if (!tag) continue
      checked += 1
      assert(/\brel="nofollow"/.test(tag), `${slug}: a goal link is missing rel="nofollow": ${tag}`)
    }
    const cta = html.match(/<a class="cta"[^>]*>/)?.[0] ?? ''
    assert(cta, `${slug}: expected the CTA link`)
    assert(!/\brel=/.test(cta), `${slug}: the editorial CTA must stay followable, got ${cta}`)
  }
  return `${checked} goal links nofollowed, ${pages.length} CTAs left followable`
})

test('the app shell carries a canonical to the bare origin, so any indexed param URL consolidates', () => {
  // The safety net behind the nofollow above: /?machine=X&goal=Y IS the app
  // shell (index.html), and robots.txt has no query-string rule — verified,
  // not assumed; its directives are Allow: / + Allow: /machines/ and four path
  // Disallows. So a param URL that gets discovered anyway (a shared link, an
  // external site) must point search engines back at the root rather than
  // registering as its own thin page.
  const robots = readFileSync(resolve(publicDir, 'robots.txt'), 'utf8')
  const directives = robots.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  assert(
    !directives.some((l) => l.includes('?')),
    `robots.txt now has a query-string rule — re-read whether the canonical is still the right mechanism: ${directives.filter((l) => l.includes('?')).join(' | ')}`,
  )
  const shell = readFileSync(resolve(appDir, 'index.html'), 'utf8')
  const canonical = shell.match(/<link rel="canonical" href="([^"]*)"/)?.[1]
  assert(
    canonical === 'https://pinball-genie.com/',
    `the app shell must canonicalise to the bare origin, got ${JSON.stringify(canonical)}`,
  )
  // And the guide pages' own self-canonicals are untouched by any of this
  // (section 5 pins each one; this just states the boundary).
  return `robots.txt: ${directives.length} directives, none query-scoped · index.html canonical -> ${canonical}`
})

test('the deep links are relative and self-origin — no absolute URL smuggled into a goal title', () => {
  for (const { slug, html } of pages) {
    for (const cell of goalTitleCells(html)) {
      const href = cell.match(/^<a href="([^"]*)"/)?.[1]
      if (!href) continue
      assert(href.startsWith('/?machine='), `${slug}: expected a root-relative link, got ${href}`)
      assert(!/^https?:|^\/\//i.test(href), `${slug}: absolute/protocol-relative goal link: ${href}`)
    }
  }
})

test("the goals section's OWN copy is still count-free and free of sourcing voice", () => {
  // The standing copy rules, re-checked on the section this phase edited.
  //
  // SCOPE, and why it is this narrow: "count-free" governs the copy THIS REPO
  // writes about its own catalog — the heading and the dek under it, which
  // must never become "All 33 goals below…". It does NOT govern the goal
  // titles/summaries/rewards, which are dataset prose about the MACHINE's
  // rules, where a number is a fact of the game ("clearing sets of 8 shots",
  // "~30M in roughly 6 shots" — both real, both correct). A first draft of
  // this check swept the whole section and flagged exactly those; a gate that
  // demands a rule be described without its numbers is a gate that would make
  // the product worse, so it is scoped to the generated wrapper instead.
  const COUNTY = /\b\d+\s+(goals?|machines?|shots?|steps?)\b/i
  let checked = 0
  for (const { slug, html } of pages) {
    const heading = html.match(/<h2>Goals in [^<]*<\/h2>/)?.[0]
    if (!heading) continue
    const dek = html.match(/<h2>Goals in [^<]*<\/h2>\s*<p class="dek-secondary">([^<]*)<\/p>/)?.[1]
    assert(typeof dek === 'string', `${slug}: expected the goals section's dek right after its heading`)
    checked += 1
    const own = `${heading} ${dek}`
    const hit = own.match(COUNTY)
    assert(!hit, `${slug}: the goals section's own copy states a count ("${hit?.[0]}")`)
    for (const term of gen.PROVENANCE_TERMS) {
      assert(
        !new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(own),
        `${slug}: provenance term "${term}" reached the goals section's own copy`,
      )
    }
  }
  assert(checked > 0, 'no goals sections were found to check')
  return `${checked} goals-section headings + deks`
})

test('nothing else moved: the sitemap lists no query-string URL, and the CTA is still the only ?machine= link outside the goal list', () => {
  const withQuery = sitemapLocs.filter((loc) => loc.includes('?'))
  assert(withQuery.length === 0, `deep links must not enter the sitemap: ${withQuery.join(', ')}`)
  for (const { slug, html } of pages) {
    const outside = html
      .replace(/<ul class="goal-list">[\s\S]*?<\/ul>/g, '')
      // The How-It-Plays section (schema v9) carries its own goal deep links in
      // the scoring ladder and light groups — the same intentional
      // ?machine=&goal= shape the goal list uses, not strays.
      .replace(/<section class="guide-howitplays">[\s\S]*?<\/section>/g, '')
    const links = [...outside.matchAll(/href="(\/\?machine=[^"]*)"/g)].map((m) => m[1])
    assert(
      links.length === 1 && links[0] === `/?machine=${slug}`,
      `${slug}: expected exactly the one CTA outside the goal list, got ${JSON.stringify(links)}`,
    )
  }
})

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
const skipped = results.filter((r) => r.outcome === 'skip').length
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (of ${results.length})`)
if (failed > 0) process.exitCode = 1
