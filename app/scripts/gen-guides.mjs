#!/usr/bin/env node
// app/scripts/gen-guides.mjs — Phase 4 SEO: per-machine static guide pages.
//
// WHY THIS EXISTS. pinball-genie.com is a single-page app today, so it can
// rank for roughly one search query. This script generates 62 standalone,
// no-JS-required HTML pages — one per catalog machine, at
// /machines/<slug>/ — plus a /machines/ index, so a player searching e.g.
// "jaws pinball rules" or "how to start multiball godzilla pinball" has a
// real, indexable page to land on, with a call to action into the app.
//
// INPUT CONTRACT — data/guides.json (owned by a different agent; this
// script only READS it, never writes it). A JSON array, one object per
// machine:
//   {
//     "slug": string,          // matches a data/catalog.json `id`, modulo
//                               // normalizeSlug() below (58 of 62 catalog
//                               // ids already match a RULES-*.md stem
//                               // directly; 4 differ only by underscore vs
//                               // hyphen — e.g. black_knight_2000 vs
//                               // black-knight-2000 — so this script
//                               // normalizes on [-_] rather than hand-
//                               // maintaining a mapping table, same fix
//                               // applied to the same 4 machines here)
//     "name": string,          // display name, e.g. "Jaws" (no year/mfr)
//     "manufacturer": string,  // e.g. "Stern Pinball"
//     "year": number,
//     "description": string,  // meta description, written for the search
//                              // query a player actually types; MUST be
//                              // original prose — see the provenance ban
//                              // below
//     "wordCount": number,
//     "body": [                // structured content nodes, in order
//       { "tag": "h2" | "h3", "text": string } |
//       { "tag": "p", "text": string } |
//       { "tag": "ul", "items": string[] }
//     ]
//   }
//
// 2026-07-30: data/guides.json did not exist yet when this script was
// written (the content agent producing it runs separately/in parallel).
// The checked-in data/guides.json right now is a 3-machine FIXTURE (jaws,
// godzilla, breakshot) with clearly-labeled placeholder prose, written only
// so this generator could be built and tested end to end. IT IS NOT REAL
// GUIDE COPY and the content agent's real 62-machine file is expected to
// overwrite it wholesale. This script does not care how many entries it
// finds — it generates a page for every guides.json entry that matches a
// catalog.json machine and logs (not throws) anything left over, so the
// build stays green while the two halves of Phase 4 land independently.
//
// 🔴 THE PROVENANCE BAN — READ THIS BEFORE TOUCHING RENDERING CODE.
// RULES-*.md (the native apps' internal research notes) are full of source
// attribution — "Tilt Forums rulesheet", "Kineticist", "Pinside", "IPDB",
// "FSPA" — because they're research notes, not publishable copy. The
// project's provenance policy (2026-07-28) is that close paraphrase of a
// community rulesheet is the top infringement risk, so the published text
// ASSERTS it is original rather than volunteering any comparison. The same
// sentence was cut from about.html on 2026-07-30 for exactly this reason
// (see that file's own comment). This script must never render ANY of:
// data/*_goals.json's `sources` array (present in all 62 files — confirmed
// by grep, 2026-07-30), or guide.description/body if they happen to contain
// a provenance term (defense in depth — the content agent shouldn't put one
// there, but this script checks anyway and refuses to write a page that
// does). See PROVENANCE_TERMS below and its use in assertNoProvenance().
//
// Run: node scripts/gen-guides.mjs   (from app/, or `node
// app/scripts/gen-guides.mjs` from repo root — paths below resolve off
// import.meta.url, not cwd). Wired as an npm "prebuild" script (see
// package.json) so `npm run build` can't ship a stale or missing
// /machines/** — see README's existing "npm run build" instructions, no new
// step to remember.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, '../../data')
const PUBLIC_DIR = resolve(__dirname, '../public')
const MACHINES_DIR = resolve(PUBLIC_DIR, 'machines')
const SITE_ORIGIN = 'https://pinball-genie.com'

// Fixed, not `new Date()`: sitemap.xml's existing entries all use a
// hand-set lastmod (see that file's own header) rather than a build
// timestamp, specifically so re-running the build doesn't churn every
// <lastmod> on every deploy with no real content change — a generated file
// gets to keep that property too. Bump this only when guide CONTENT
// actually changes.
const GENERATED_DATE = '2026-07-30'

// The exact non-affiliation sentence from server/legal/about.html's "Who's
// behind it" section — copied verbatim on purpose (about.html's own comment
// says not to write a new variant, and there are at least 3 other worded
// variants elsewhere in this repo; this is the one the task brief names).
const NON_AFFILIATION_LINE =
  "Pinball Genie is an independent, solo-built project operated by Pinball Genie LLC. It is not affiliated with, endorsed by, or sponsored by any pinball manufacturer or theme rights holder."

// See the big provenance-ban comment above. Lowercase; checked against
// lowercased text. "system-j" / "sdpc" included even though each appears in
// only one RULES file (System-J, SDPC) — cheap to check, and this list is
// meant to be exhaustive against research-note vocabulary, not just the
// common cases.
export const PROVENANCE_TERMS = [
  // Named sources.
  'tilt forums',
  'tiltforums',
  'rulesheet',
  'pinside',
  'kineticist',
  'ipdb',
  'fspa',
  'system-j',
  'sdpc',
  // RESEARCH VOICE (added 2026-07-31). The list above is proper nouns only,
  // and that is exactly how seven strings reached the public pages: "community
  // reports up to 6 laps/ball (uncorroborated)", "per community consensus",
  // "the tournament line (attributed to Noah)", "a documented endless loop".
  // None of those name a source, so none tripped the guard — but every one of
  // them tells a reader we are relaying somebody else's research rather than
  // explaining a machine, which is a posture this project deliberately avoids.
  // They arrived via data/*_goals.json, a file family the editorial pass never
  // audited but which the generator renders onto every page.
  //
  // A guide page should describe the MACHINE. If a claim is uncertain, say the
  // claim is uncertain ("repeatable, but not on every machine") rather than
  // citing who reported it.
  'uncorroborated',
  'community report',
  'community consensus',
  'attributed to',
  'a documented',
  'anecdotal',
  'per reports',
  'this dataset',
  'the dataset',
  'our dataset',
]

/** Normalizes a catalog id / RULES stem / guides.json slug so
 * black_knight_2000 and black-knight-2000 (etc.) compare equal, matching
 * the same [-_] fold the task brief describes for RULES-*.md stems. */
export function normalizeSlug(s) {
  return String(s).toLowerCase().replace(/[_-]+/g, '-')
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Throws if any needle in PROVENANCE_TERMS appears in `text` (case-
 * insensitive). `where` is just for a useful error message. This is the
 * generator's own safety net — it does not trust guides.json to have been
 * scrubbed already. */
export function assertNoProvenance(text, where) {
  const lower = String(text).toLowerCase()
  for (const term of PROVENANCE_TERMS) {
    // WORD BOUNDARY, not substring (2026-07-31). A plain `includes()` matched
    // "attributed to" inside "frequently MISattributed to George Gomez" —
    // which is a fact about who designed Breakshot, the opposite of a citation
    // to our sources — and failed the whole build. A guard that cries wolf on
    // legitimate prose gets widened until it catches nothing, so make it
    // precise instead: require a word boundary before the term. "misattributed
    // to" has no boundary between "mis" and "attributed", so it correctly no
    // longer matches, while a real "attributed to Noah" still does.
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
    if (re.test(lower)) {
      throw new Error(
        `gen-guides: provenance term "${term}" found in ${where} — refusing to publish a page that volunteers a rulesheet/forum comparison or relays somebody else's research (see this script's header comment). Fix the source text in data/guides.json or data/*_goals.json.`,
      )
    }
  }
}

export function loadCatalog() {
  return JSON.parse(readFileSync(resolve(DATA_DIR, 'catalog.json'), 'utf8'))
}

export function loadGuides() {
  const path = resolve(DATA_DIR, 'guides.json')
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Best-effort load of a machine's goals file (data/<resource>.json). Goals
 * are real added value beyond the prose guide — and, unlike RULES-*.md,
 * their `sources` array is the ONLY provenance-bearing field in these files
 * (confirmed by grep across all 62 *_goals.json, 2026-07-30), so callers
 * must read `.goals` only and never touch `.sources`. Returns null rather
 * than throwing if the file is missing, so one bad `resource` reference
 * degrades to "no goals section" instead of failing the whole build. */
export function loadGoals(resource) {
  const path = resolve(DATA_DIR, `${resource}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Matches guides.json entries to catalog.json machines by normalized slug.
 * Returns { matched, unmatchedCatalog, unmatchedGuides } — the two
 * "unmatched" lists are reported (console.warn), never thrown, so a
 * partial guides.json (e.g. today's 3-machine fixture) still builds. */
export function matchGuidesToCatalog(catalog, guides) {
  const guideByNorm = new Map()
  for (const g of guides) {
    guideByNorm.set(normalizeSlug(g.slug), g)
  }
  const matched = []
  const unmatchedCatalog = []
  const usedNorms = new Set()
  for (const entry of catalog) {
    const norm = normalizeSlug(entry.id)
    const guide = guideByNorm.get(norm)
    if (guide) {
      matched.push({ catalogEntry: entry, guide })
      usedNorms.add(norm)
    } else {
      unmatchedCatalog.push(entry.id)
    }
  }
  const unmatchedGuides = guides.filter((g) => !usedNorms.has(normalizeSlug(g.slug))).map((g) => g.slug)
  return { matched, unmatchedCatalog, unmatchedGuides }
}

function difficultyLabel(n) {
  // Every data/*_goals.json goal.difficulty observed is 1-3 (grep-verified,
  // 2026-07-30) — no attempt to handle a wider range gracefully beyond this.
  if (n <= 1) return 'Easy'
  if (n === 2) return 'Medium'
  return 'Hard'
}

/** Renders the "Goals in this guide" section from a machine's goals file.
 * Deliberately reads ONLY id/title/category/summary/difficulty/reward —
 * never `.sources` (provenance) and never `.steps` (references internal
 * shot ids like "shooter-lane", which reads as debug output rather than
 * guide prose). Returns '' if there are no goals to show.
 *
 * `slug` (P7a, 2026-08-14) turns each goal TITLE into a deep link into the
 * app — `/?machine=<slug>&goal=<id>`, which src/state.ts's parseDeepLink
 * resolves on boot and lands on that goal's step-by-step detail screen. Until
 * now the page's only route into the app was the one CTA at the top, which
 * opens the machine and leaves the reader to find again, by hand, the goal
 * they were just reading about. Relative and self-origin (the CTA above uses
 * the identical form); ids are already the app's own, and both halves are
 * percent-encoded anyway.
 *
 * A goal with no id renders its title as plain text rather than a link to
 * `?goal=undefined` — one broken link is worse than one missing link. Same
 * for a missing `slug`.
 *
 * rel="nofollow" ON EVERY ONE (K3 review, 2026-08-14). These are UX
 * affordances, not content: 2905 links pointing at 2905 query-string variants
 * of ONE app shell. Left followable they invite a crawler to spend this site's
 * budget re-fetching the same document with different parameters, and they
 * spread each guide page's own link equity across thirty outbound links to a
 * page that has nothing to index. The three facts behind this decision were
 * verified rather than assumed:
 *   - app/public/robots.txt has NO query-string rule at all (its directives
 *     are Allow: / + Allow: /machines/ and four path Disallows), so
 *     `/?machine=X&goal=Y` IS crawlable — nothing else was stopping this.
 *   - app/index.html:22 already carries
 *     `<link rel="canonical" href="https://pinball-genie.com/" />`, and it
 *     survives the Vite build into dist/index.html — so any param URL that
 *     does get indexed consolidates onto the root. That is the safety net;
 *     nofollow is the thing that stops the crawl in the first place.
 *   - the guide pages' own self-canonicals are untouched, and so is the one
 *     CTA link at the top of each page (`/?machine=<slug>`, no goal): that
 *     one IS the page's editorial call to action and stays followable. */
export function renderGoalsSection(goalsDoc, machineName, slug) {
  const goals = goalsDoc && Array.isArray(goalsDoc.goals) ? goalsDoc.goals : []
  if (goals.length === 0) return ''
  const items = goals
    .map((g) => {
      assertNoProvenance(`${g.title ?? ''} ${g.summary ?? ''} ${g.reward ?? ''}`, `goal "${g.id}"`)
      const cat = g.category ? escapeHtml(g.category) : ''
      const diff = typeof g.difficulty === 'number' ? difficultyLabel(g.difficulty) : ''
      const metaBits = [cat, diff].filter(Boolean).join(' · ')
      const label = escapeHtml(g.title ?? '')
      // &amp; because this is HTML, not a bare URL: an unescaped & in an
      // attribute is a character reference waiting to be misparsed. Browsers
      // resolve it back to a single & before the request.
      const href = `/?machine=${encodeURIComponent(slug)}&amp;goal=${encodeURIComponent(g.id)}`
      const titleHtml = slug && g.id ? `<a href="${href}" rel="nofollow">${label}</a>` : label
      return `        <li class="goal-item">
          <p class="goal-title">${titleHtml}${metaBits ? ` <span class="goal-meta">${metaBits}</span>` : ''}</p>
          ${g.summary ? `<p class="goal-summary">${escapeHtml(g.summary)}</p>` : ''}
          ${g.reward ? `<p class="goal-reward"><strong>Reward:</strong> ${escapeHtml(g.reward)}</p>` : ''}
        </li>`
    })
    .join('\n')
  return `
        <h2>Goals in ${escapeHtml(machineName)}</h2>
        <p class="dek-secondary">Every goal below is tracked step-by-step, with shot paths drawn on the playfield map, inside the app.</p>
        <ul class="goal-list">
${items}
        </ul>`
}

/** Renders "The Action Button" section from the machine's goals file
 * (dataset schema v6 `actionButton` — see app/src/models.ts). Rendered
 * straight from the dataset, not guides.json, so the guide pages can never
 * drift from what the app teaches. present:false still renders — "this game
 * has no action button" is a real answer to a real search query. Returns ''
 * only when the dataset hasn't been patched with the field at all. */
export function renderActionButtonSection(goalsDoc, machineName) {
  const ab = goalsDoc && typeof goalsDoc.actionButton === 'object' ? goalsDoc.actionButton : null
  if (!ab || typeof ab.how !== 'string') return ''
  const uses = Array.isArray(ab.uses) ? ab.uses : []
  uses.forEach((u, i) => assertNoProvenance(`${u.when ?? ''} ${u.what ?? ''}`, `actionButton.uses[${i}]`))
  assertNoProvenance(`${ab.label ?? ''} ${ab.location ?? ''} ${ab.how}`, 'actionButton')
  const heading = ab.present
    ? `The ${escapeHtml(ab.label || 'Action Button')} on ${escapeHtml(machineName)}`
    : `Does ${escapeHtml(machineName)} have an action button?`
  const locBit = ab.present && ab.location ? `<p class="dek-secondary">${escapeHtml(cap(ab.location))}.</p>` : ''
  const items = uses
    .map((u) => `          <li><strong>${escapeHtml(u.when ?? '')}:</strong> ${escapeHtml(u.what ?? '')}</li>`)
    .join('\n')
  const list = items ? `\n        <ul>\n${items}\n        </ul>` : ''
  return `
        <h2>${heading}</h2>
        ${locBit}<p>${escapeHtml(ab.how)}</p>${list}`
}

function cap(s) {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}

/**
 * Converts the small inline-markdown subset the guide prose actually uses
 * into HTML. Runs AFTER escapeHtml, so the only `<` and `>` in the string at
 * this point are the ones we are about to insert ourselves — user text can
 * never reach the output as markup.
 *
 * WHY THIS EXISTS (2026-07-31). It didn't, and that shipped 1,886 literal
 * `**bold**` spans as visible body text across all 62 pages — every single
 * page, in the primary content, reading like an abandoned scraper's output.
 * The generator had been developed and validated against a 3-machine
 * placeholder fixture whose text happened to contain no `**` at all, so the
 * gap never surfaced locally; the real prose then landed with its markdown
 * intact and nothing in 46 existing assertions ever looked at a rendered
 * word. The lesson is in guide-pages.test.mjs now: assert on what a VISITOR
 * SEES, not on the shape of the <head>.
 *
 * Deliberately a tiny hand-rolled converter and not a markdown library: this
 * repo takes no new dependencies, and the input is our own prose in a known
 * subset (measured across all 62 guides: 1,886 `**bold**`, 24 `*italic*`,
 * 22 `` `code` ``, 0 links, 0 inline headings). Anything outside that subset
 * is left alone rather than guessed at — and the test asserts no stray
 * markers survive, so a new construct fails the build instead of shipping.
 */
export function renderInline(escaped) {
  return (
    String(escaped)
      // **bold** first: doing *italic* first would eat the inner pair of a
      // `**` run and leave orphaned asterisks behind.
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      // *italic* — require a non-space after the opening star so arithmetic
      // and footnote-style asterisks aren't swallowed.
      .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
  )
}

/** True if any markdown marker survived conversion — the build's own tripwire
 *  against a construct this converter doesn't know about. */
export function hasUnconvertedMarkdown(html) {
  const stripped = String(html).replace(/<[^>]+>/g, '')
  return /\*|`|(^|\n)\s*-\s+/.test(stripped)
}

export function renderBodyNode(node) {
  assertNoProvenance(node.text ?? (node.items || []).join(' '), `body node (tag=${node.tag})`)
  const inline = (t) => renderInline(escapeHtml(t))
  switch (node.tag) {
    case 'h2':
      return `        <h2>${inline(node.text)}</h2>`
    case 'h3':
      return `        <h3>${inline(node.text)}</h3>`
    case 'p': {
      // Some paragraphs are really a lead-in followed by "- " bullets that
      // were flattened into one string upstream. Rendering those inline
      // produced runs like "repeating: - **Eight Ball** — sink 7 colors - …".
      // Split them back into a real list rather than shipping the dashes.
      const raw = String(node.text).trim()
      // A paragraph that STARTS with "- " is all bullets, no lead-in
      // (Metallica's collectibles list is the one case in the corpus).
      const startsAsList = /^-\s+/.test(raw)
      const parts = raw.replace(/^-\s+/, '').split(/\s+-\s+(?=\S)/)
      if (parts.length > 1 || startsAsList) {
        const lead = startsAsList ? '' : parts.shift()
        const items = parts.map((it) => `          <li>${inline(it)}</li>`).join('\n')
        const leadHtml = lead && lead.trim() ? `        <p>${inline(lead.trim())}</p>\n` : ''
        return `${leadHtml}        <ul>\n${items}\n        </ul>`
      }
      return `        <p>${inline(raw)}</p>`
    }
    case 'ul': {
      const items = (node.items || []).map((it) => `          <li>${inline(it)}</li>`).join('\n')
      return `        <ul>\n${items}\n        </ul>`
    }
    default:
      throw new Error(`gen-guides: unknown body node tag "${node.tag}" — guides.json contract only allows h2/h3/p/ul`)
  }
}

function jsonLd({ slug, name, description }) {
  // Article + BreadcrumbList ONLY — NOT HowTo, NOT FAQ (both explicitly
  // ruled out by the task brief: HowTo rich results were removed and FAQ
  // was deprecated 2026-05-07; neither buys anything). One <script
  // type="application/ld+json"> block via @graph rather than two separate
  // script tags — same @context, one less thing for a crawler to stitch
  // together.
  const url = `${SITE_ORIGIN}/machines/${slug}`
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: `${name} Pinball Rules & Shot Guide`,
        description,
        datePublished: GENERATED_DATE,
        dateModified: GENERATED_DATE,
        author: { '@type': 'Organization', name: 'Pinball Genie LLC' },
        publisher: { '@type': 'Organization', name: 'Pinball Genie LLC' },
        mainEntityOfPage: url,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Machines', item: `${SITE_ORIGIN}/machines` },
          { '@type': 'ListItem', position: 3, name, item: url },
        ],
      },
    ],
  }
  // No HTML-escaping needed inside a <script type="application/ld+json">
  // block (it's not parsed as HTML text), EXCEPT for the sequence `</script`
  // itself, which the HTML PARSER (not JSON) would treat as a closing tag
  // regardless of the surrounding type= attribute. None of our inputs are
  // expected to contain that, but escaping the one dangerous substring costs
  // nothing and removes the risk entirely if a machine name or description
  // ever did.
  return JSON.stringify(graph).replace(/<\/script/gi, '<\\/script')
}

function siteHeader() {
  return `    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="/">
          <span class="brand-ball" aria-hidden="true"></span>
          Pinball Genie
        </a>
        <a class="back-link" href="/">&larr; Back to the app</a>
      </div>
    </header>`
}

function siteFooter() {
  // Same structure/class names as server/legal/about.html's footer, styled
  // by this file's OWN stylesheet (guide.css) rather than importing
  // legal.css — these pages ship from a different path (/machines/*) than
  // /legal/* does, and the task brief is explicit that guide.css is its own
  // asset, not an import of legal.css.
  return `    <footer class="site-footer">
      <div class="footer-inner">
        <nav class="footer-links" aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
        </nav>
        <p class="footer-contact">
          <a href="https://instagram.com/pinballgenie">@pinballgenie</a> ·
          <a href="mailto:admin@pinball-genie.com">admin@pinball-genie.com</a>
        </p>
        <p class="footer-copy">&copy; 2026 Pinball Genie LLC</p>
      </div>
    </footer>`
}


/** Renders the "How <Machine> plays" section from the machine's goals file
 * (dataset schema v9 `howItPlays` — see app/src/models.ts). Like the action
 * button section above, it reads the DATASET, not guides.json, so the guide
 * pages can never drift from what the app teaches: guides.json is editorial
 * prose owned by a separate agent, while howItPlays is the same structured
 * field the app itself renders. Every authored string passes
 * assertNoProvenance for the same reason body text does (see the header
 * ban): a brand-new field is a brand-new hole in the provenance audit, and
 * this generator never trusts a data file to arrive already scrubbed.
 * escapeHtml only, never renderInline — this content is authored structured
 * data, not guide prose, and there is no markdown contract to honor, so no
 * marker ever gets converted and a stray `*` stays a visible `*` instead of
 * silently becoming emphasis. Returns '' when the dataset hasn't been
 * patched with the field (or it's null/malformed), so today's build — no
 * dataset carries the field yet — produces zero page diffs. Fail-soft
 * throughout: any non-array/non-string sub-field is treated as absent, and
 * the only thing this function ever throws is a provenance violation. */
export function renderHowItPlaysSection(goalsDoc, machineName, slug) {
  const h =
    goalsDoc && typeof goalsDoc.howItPlays === 'object' && goalsDoc.howItPlays !== null
      ? goalsDoc.howItPlays
      : null
  if (!h || typeof h.objective !== 'string' || h.objective.trim() === '') return ''
  assertNoProvenance(h.objective, 'howItPlays.objective')
  // Fail-soft accessors: schema violations degrade to "absent", never throw.
  const str = (v) => (typeof v === 'string' ? v : '')
  const arr = (v) => (Array.isArray(v) ? v : [])
  const goals = goalsDoc && Array.isArray(goalsDoc.goals) ? goalsDoc.goals : []

  const KIND_LABELS = {
    'shot-arrow': 'shot arrows',
    letters: 'letters',
    ladder: 'ladder',
    lanes: 'lanes',
    multiplier: 'multiplier',
    status: 'status',
    mode: 'mode',
  }
  const INPUT_LABELS = {
    'left-flipper': 'Left flipper button',
    'right-flipper': 'Right flipper button',
    'either-flipper': 'Either flipper button',
    'both-flippers': 'Both flipper buttons',
    'action-button': 'Action button',
    plunger: 'Plunger',
    none: 'No button',
  }
  const TIER_LABELS = {
    'ball-one': 'Ball one',
    building: 'Building',
    'the-big-one': 'The big one',
  }
  const LANE_CHANGE_SENTENCES = {
    flippers: 'Lane change: the flipper buttons move the lit lane.',
    'action-button': 'Lane change: the action button moves the lit lane.',
    none: 'Lane change: the lit lane cannot be moved by the buttons.',
    unknown: 'Lane change: not verified for this machine yet.',
  }

  const loopItems = arr(h.loop)
    .filter((l) => typeof l === 'string' && l.trim() !== '')
    .map((l, i) => {
      assertNoProvenance(l, `howItPlays.loop[${i}]`)
      return `          <li>${escapeHtml(l)}</li>`
    })
    .join('\n')

  const lightItems = arr(h.lights)
    .map((g, i) => {
      if (!g || typeof g !== 'object') return ''
      const name = str(g.name)
      const lit = str(g.lit)
      const flashing = str(g.flashing)
      const then = str(g.then)
      const control = g.control && typeof g.control === 'object' ? g.control : null
      assertNoProvenance(name, `howItPlays.lights[${i}].name`)
      assertNoProvenance(lit, `howItPlays.lights[${i}].lit`)
      if (flashing) assertNoProvenance(flashing, `howItPlays.lights[${i}].flashing`)
      assertNoProvenance(then, `howItPlays.lights[${i}].then`)
      if (control) {
        assertNoProvenance(str(control.effect), `howItPlays.lights[${i}].control.effect`)
        if (str(control.when)) assertNoProvenance(str(control.when), `howItPlays.lights[${i}].control.when`)
      }
      // A group without name/lit/then can't say anything useful; skip rather
      // than render a broken sentence (fail-soft, same posture as above).
      if (!name || !lit || !then) return ''
      const kindBit = g.kind && KIND_LABELS[g.kind] ? ` (${KIND_LABELS[g.kind]})` : ''
      const bits = [`lit: ${escapeHtml(lit)}`]
      if (flashing) bits.push(`flashing: ${escapeHtml(flashing)}`)
      bits.push(`then: ${escapeHtml(then)}`)
      if (control) {
        const label = control.input && INPUT_LABELS[control.input] ? INPUT_LABELS[control.input] : 'No button'
        const whenBit = str(control.when) ? ` (${escapeHtml(str(control.when))})` : ''
        bits.push(`control: ${label}: ${escapeHtml(str(control.effect))}${whenBit}`)
      }
      return `          <li><strong>${escapeHtml(name)}</strong>${kindBit} — ${bits.join(' · ')}</li>`
    })
    .filter(Boolean)
    .join('\n')

  const laneChange = h.laneChange && LANE_CHANGE_SENTENCES[h.laneChange] ? h.laneChange : 'unknown'
  const laneNote = str(h.laneChangeNote)
  assertNoProvenance(laneNote, 'howItPlays.laneChangeNote')
  const laneLine = laneNote
    ? `${LANE_CHANGE_SENTENCES[laneChange]} ${escapeHtml(laneNote)}`
    : LANE_CHANGE_SENTENCES[laneChange]

  const scoringItems = arr(h.scoring)
    .map((s, i) => {
      if (!s || typeof s !== 'object') return ''
      const text = str(s.text)
      assertNoProvenance(text, `howItPlays.scoring[${i}].text`)
      if (!text) return ''
      const label = s.tier && TIER_LABELS[s.tier] ? TIER_LABELS[s.tier] : 'Ball one'
      // Same anchor shape as renderGoalsSection, and same rule: an id that
      // doesn't resolve in this file renders NOTHING — one broken link is
      // worse than one missing link.
      const links = arr(s.goals)
        .map((id) => {
          const g = goals.find((x) => x && x.id === id)
          return g && slug && g.id ? { id, title: str(g.title) } : null
        })
        .filter(Boolean)
        .map(
          ({ id, title }) =>
            `<a href="/?machine=${encodeURIComponent(slug)}&amp;goal=${encodeURIComponent(id)}" rel="nofollow">${escapeHtml(title)}</a>`,
        )
      return `          <li><strong>${escapeHtml(label)}</strong> — ${escapeHtml(text)}${
        links.length ? ` — ${links.join(', ')}` : ''
      }</li>`
    })
    .filter(Boolean)
    .join('\n')

  const loopHtml = loopItems
    ? `\n        <h3>The loop</h3>\n        <ol>\n${loopItems}\n        </ol>`
    : ''
  const lightsHtml = lightItems
    ? `\n        <h3>Reading the lights</h3>\n        <ul>\n${lightItems}\n        </ul>`
    : ''
  const scoringHtml = scoringItems
    ? `\n        <h3>Start scoring</h3>\n        <ul>\n${scoringItems}\n        </ul>`
    : ''
  return `
        <section class="guide-howitplays">
        <h2>How ${escapeHtml(machineName)} plays</h2>
        <p class="dek">${escapeHtml(h.objective)}</p>${loopHtml}${lightsHtml}
        <p class="guide-lanechange">${laneLine}</p>${scoringHtml}
        </section>`
}

export function renderMachinePage({ catalogEntry, guide, goalsDoc }) {
  const slug = catalogEntry.id
  const name = guide.name
  assertNoProvenance(guide.description, `guides.json "${slug}".description`)
  const title = `${name} Pinball Rules & Shot Guide — Pinball Genie`
  const canonical = `${SITE_ORIGIN}/machines/${slug}`
  const bodyHtml = (guide.body || []).map(renderBodyNode).join('\n')
  const actionButtonHtml = renderActionButtonSection(goalsDoc, name)
  const howItPlaysHtml = renderHowItPlaysSection(goalsDoc, name, slug)
  const goalsHtml = renderGoalsSection(goalsDoc, name, slug)
  const yearBit = guide.year ? `, ${guide.year}` : ''
  const mfrBit = guide.manufacturer ? escapeHtml(guide.manufacturer) : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(guide.description)}" />
    <meta name="theme-color" content="#0a0b10" />
    <meta name="color-scheme" content="dark" />
    <link rel="canonical" href="${canonical}" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
    <link rel="apple-touch-icon" href="/icons/icon-192.png" />
    <link rel="stylesheet" href="/machines/guide.css" />
    <script type="application/ld+json">${jsonLd({ slug, name, description: guide.description })}</script>
  </head>
  <body>
${siteHeader()}

    <main>
      <div class="container">
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <a href="/">Home</a> <span aria-hidden="true">&rsaquo;</span>
          <a href="/machines">Machines</a> <span aria-hidden="true">&rsaquo;</span>
          <span>${escapeHtml(name)}</span>
        </nav>

        <h1>${escapeHtml(name)}</h1>
        <p class="dek">${mfrBit}${yearBit ? escapeHtml(yearBit) : ''} &mdash; shot-by-shot rules and strategy guide.</p>

        <a class="cta" href="/?machine=${encodeURIComponent(slug)}">Open ${escapeHtml(name)} in the Pinball Genie app &rarr;</a>

${[bodyHtml, howItPlaysHtml, actionButtonHtml, goalsHtml].filter(Boolean).join('\n')}

        <div class="callout">
          <p>${NON_AFFILIATION_LINE}</p>
        </div>
      </div>
    </main>

${siteFooter()}
  </body>
</html>
`
}

export function renderIndexPage(matched) {
  const rows = matched
    .slice()
    .sort((a, b) => a.guide.name.localeCompare(b.guide.name))
    .map(({ catalogEntry, guide }) => {
      const bits = [guide.manufacturer, guide.year].filter(Boolean).join(', ')
      return `          <li>
            <a href="/machines/${catalogEntry.id}">${escapeHtml(guide.name)}</a>
            ${bits ? `<span class="index-meta">${escapeHtml(bits)}</span>` : ''}
          </li>`
    })
    .join('\n')

  const title = 'Pinball Machine Rules & Shot Guides — Pinball Genie'
  // Count-free on purpose (standing rule): durable public copy never claims a
  // machine count, so it can't go stale the next time the catalog moves.
  const description = `Rules and shot-path guides for pinball machines, from modern Stern titles to classics — pick a machine to learn its shots before you play.`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="#0a0b10" />
    <meta name="color-scheme" content="dark" />
    <link rel="canonical" href="${SITE_ORIGIN}/machines" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
    <link rel="apple-touch-icon" href="/icons/icon-192.png" />
    <link rel="stylesheet" href="/machines/guide.css" />
  </head>
  <body>
${siteHeader()}

    <main>
      <div class="container">
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <a href="/">Home</a> <span aria-hidden="true">&rsaquo;</span>
          <span>Machines</span>
        </nav>

        <h1>Pinball Machine Guides</h1>
        <p class="dek">Rules and shot-path guides, machine by machine. Pick one to learn its shots before you play.</p>

        <ul class="machine-index">
${rows}
        </ul>

        <div class="callout">
          <p>${NON_AFFILIATION_LINE}</p>
        </div>
      </div>
    </main>

${siteFooter()}
  </body>
</html>
`
}

export function buildSitemapXml(matched) {
  const staticUrls = [
    { loc: '/', changefreq: 'weekly', priority: '1.0' },
    { loc: '/machines', changefreq: 'weekly', priority: '0.8' },
    { loc: '/about', changefreq: 'monthly', priority: '0.6' },
    { loc: '/privacy', changefreq: 'yearly', priority: '0.4' },
    { loc: '/terms', changefreq: 'yearly', priority: '0.4' },
    { loc: '/contact', changefreq: 'monthly', priority: '0.4' },
  ]
  const machineUrls = matched
    .slice()
    .sort((a, b) => a.catalogEntry.id.localeCompare(b.catalogEntry.id))
    .map((m) => ({ loc: `/machines/${m.catalogEntry.id}`, changefreq: 'monthly', priority: '0.7' }))

  const urlXml = (u) => `  <url>
    <loc>${SITE_ORIGIN}${u.loc}</loc>
    <lastmod>${GENERATED_DATE}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  sitemap.xml — pinball-genie.com (Pinball Genie LLC).

  GENERATED FILE — do not hand-edit. Produced by app/scripts/gen-guides.mjs
  from data/catalog.json + data/guides.json as part of the "prebuild" npm
  script (see app/package.json), which always runs before "vite build". If
  you need to change what's in here, change gen-guides.mjs's
  buildSitemapXml() (or the underlying data), then rerun the build — a
  manual edit will just be overwritten by the next build.

  This replaced the Phase 1-3 hand-written 5-URL version on ${GENERATED_DATE}
  (Phase 4), per that file's own comment saying this was coming. It lists
  every URL that is a real, server-rendered document: the app shell, the
  four legal pages, /machines, and one entry per catalog machine that
  currently has a guides.json entry — a catalog machine with no guide entry
  yet is simply absent from this list, which is expected, not a defect. No
  machine count is stated here on purpose: this file is public, and a number
  written into it goes stale the moment the catalog moves — this comment used
  to interpolate one and had already drifted into naming two different totals
  in the same sentence. /login and /auth/ stay OUT on purpose (see robots.txt's
  Disallow rules for both).
-->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticUrls, ...machineUrls].map(urlXml).join('\n')}
</urlset>
`
}

// ---------------------------------------------------------------------------
// GUIDE_CSS — the machine-guide pages' own stylesheet (NOT an import of
// server/legal/legal.css: these pages ship from /machines/*, a different
// path served straight out of the Vite build's dist/, whereas legal.css is
// served by pinball_auth.py alongside /legal/*). Same charcoal/amber recipe
// as legal.css (read, not imported, per the task brief) plus a few
// guide-specific rules: the CTA button, the goal-list cards, and the
// machine-index grid, none of which legal.css has any equivalent for.
// CSP is `style-src 'self'` with no 'unsafe-inline' — every rule MUST live
// in this file; no page may use a style="" attribute or a <style> tag.
// ---------------------------------------------------------------------------
export const GUIDE_CSS = `/* Pinball Genie machine guides — BACKGLASS palette (P5, 2026-08-14).
 * Deliberately a STANDALONE stylesheet, not an import of the app bundle:
 * these pages are static HTML served straight from the webroot and must not
 * depend on a hashed Vite asset name. It carries its own copy of the palette
 * and its own @font-face — kept in step with app/src/styles.css by hand, and
 * app/tests/guide-pages.test.mjs pins the ground/accent hexes so a divergence
 * fails a gate rather than shipping two different-looking sites.
 *
 * The font files it points at are the SAME ones the app ships: Vite copies
 * app/public/ into dist/ verbatim, and deploy-prod.sh uploads dist/ wholesale,
 * so /fonts/*.woff2 exists in the webroot for both. */
@font-face {
  font-family: 'Chakra Petch';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/ChakraPetch-SemiBold-latin.woff2') format('woff2');
}
@font-face {
  font-family: 'Chakra Petch';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/ChakraPetch-Bold-latin.woff2') format('woff2');
}
:root {
  color-scheme: dark;
  --display: 'Chakra Petch', 'DIN Alternate', system-ui, sans-serif;
}
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  padding: 0;
  background: #0a0b10;
  background-image: radial-gradient(circle at 50% -10%, rgba(255, 176, 46, 0.12), transparent 55%);
  background-repeat: no-repeat;
  background-attachment: fixed;
}
body {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  color: #e9edf7;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a {
  color: #ffb02e;
}
a:hover,
a:focus {
  color: #ffc85f;
}

/* ---- header ---- */
.site-header {
  border-bottom: 1px solid rgba(142, 170, 222, 0.1);
}
.header-inner {
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
  padding: 18px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--display);
  font-weight: 700;
  letter-spacing: 0.19em;
  text-transform: uppercase;
  font-size: 13px;
  color: #e9edf7;
}
.brand:hover,
.brand:focus {
  color: #e9edf7;
}
/* BACKGLASS brand mark. Was \`.brand-ball\`, a chrome pinball drawn as a
   radial gradient — a third, different mark from the app header's icon tile
   and the login page's, and the one thing on the page that still looked like
   the old warm-charcoal build. It is now the same LIT AMBER TILE treatment
   the app uses: a rounded square with the amber bloom, no chrome, no
   highlight. Class name kept so the generated markup does not have to
   change. */
.brand-ball {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  flex-shrink: 0;
  background: linear-gradient(150deg, #ffc85f, #e07d00);
  box-shadow: 0 0 14px rgba(255, 176, 46, 0.28);
}
.back-link {
  font-family: var(--display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

/* ---- main content ---- */
main {
  flex: 1;
  width: 100%;
}
.container {
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 24px 64px;
}
.breadcrumbs {
  font-size: 12.5px;
  color: rgba(233, 237, 247, 0.5);
  margin-bottom: 18px;
}
.breadcrumbs a {
  color: rgba(233, 237, 247, 0.7);
}
.breadcrumbs span[aria-hidden] {
  margin: 0 4px;
}
h1 {
  font-family: var(--display);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1.25;
  margin: 0 0 6px;
  color: #e9edf7;
}
.dek {
  font-size: 15.5px;
  line-height: 1.6;
  color: rgba(233, 237, 247, 0.65);
  margin: 0 0 20px;
}
.dek-secondary {
  font-size: 13.5px;
  line-height: 1.6;
  color: rgba(233, 237, 247, 0.55);
  margin: 0 0 16px;
}
h2 {
  font-family: var(--display);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.01em;
  margin: 34px 0 12px;
  color: #ffc85f;
}
h3 {
  font-family: var(--display);
  font-size: 14.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  margin: 22px 0 8px;
  color: #ffc85f;
}
p,
li {
  font-size: 15.5px;
  line-height: 1.7;
  color: rgba(233, 237, 247, 0.88);
}
p {
  margin: 0 0 14px;
}
ul {
  padding-left: 22px;
  margin: 0 0 14px;
}
li {
  margin-bottom: 8px;
}
strong {
  color: #e9edf7;
}

/* ---- call to action (the entire point of these pages) ---- */
.cta {
  display: inline-block;
  background: #ffb02e;
  color: #1a1200;
  font-family: var(--display);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  text-decoration: none;
  padding: 13px 20px;
  border-radius: 999px;
  margin: 4px 0 28px;
  box-shadow: 0 0 0 1px rgba(255, 176, 46, 0.55), 0 0 10px rgba(255, 176, 46, 0.34),
    0 0 28px rgba(255, 176, 46, 0.13);
}
.cta:hover,
.cta:focus {
  background: #ffc85f;
  color: #1a1200;
}

/* ---- goal list ---- */
.goal-list {
  list-style: none;
  padding-left: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.goal-item {
  background: #171a24;
  border: 1px solid rgba(142, 170, 222, 0.1);
  border-radius: 14px;
  padding: 16px 18px;
  margin: 0;
}
.goal-title {
  font-family: var(--display);
  font-weight: 600;
  letter-spacing: 0.015em;
  color: #e9edf7;
  margin: 0 0 6px;
}
/* Each goal title deep-links into the app (P7a) — but a page of thirty amber
 * headings would read as a link farm, so the link keeps the title's own ink
 * and takes an underline instead, going amber only on hover/focus. Both
 * colours are this stylesheet's existing pair (see the \`a\` rule above); no
 * new value is introduced. */
.goal-title a {
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.goal-title a:hover,
.goal-title a:focus {
  color: #ffb02e;
}
.goal-meta {
  font-family: var(--display);
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: rgba(255, 176, 46, 0.85);
}
.goal-summary {
  margin: 0 0 6px;
  color: rgba(233, 237, 247, 0.78);
}
.goal-reward {
  margin: 0;
  font-size: 13.5px;
  color: rgba(233, 237, 247, 0.6);
}

/* ---- /machines index ---- */
.machine-index {
  list-style: none;
  padding-left: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin: 20px 0 8px;
}
.machine-index li {
  background: #171a24;
  border: 1px solid rgba(142, 170, 222, 0.1);
  border-radius: 12px;
  padding: 14px 16px;
  margin: 0;
}
.machine-index a {
  font-weight: 700;
  font-size: 15px;
  text-decoration: none;
  display: block;
}
.index-meta {
  display: block;
  font-size: 12px;
  color: rgba(233, 237, 247, 0.5);
  margin-top: 3px;
}

/* ---- non-affiliation callout ---- */
.callout {
  background: #171a24;
  border: 1px solid rgba(142, 170, 222, 0.1);
  border-radius: 14px;
  padding: 16px 18px;
  margin: 28px 0 0;
}
.callout p {
  margin: 0;
  font-size: 13.5px;
  color: rgba(233, 237, 247, 0.6);
}

/* ---- footer ---- */
.site-footer {
  border-top: 1px solid rgba(142, 170, 222, 0.1);
  margin-top: auto;
}
.footer-inner {
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
  padding: 24px 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.footer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  font-family: var(--display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.footer-contact {
  font-size: 13px;
  color: rgba(233, 237, 247, 0.6);
}
.footer-copy {
  font-size: 11.5px;
  color: rgba(233, 237, 247, 0.35);
}

@media (min-width: 560px) {
  h1 {
    font-size: 32px;
  }
}
`

export function main() {
  const catalog = loadCatalog()
  const guides = loadGuides()
  const { matched, unmatchedCatalog, unmatchedGuides } = matchGuidesToCatalog(catalog, guides)

  if (unmatchedGuides.length > 0) {
    console.warn(`gen-guides: ${unmatchedGuides.length} guides.json entr${unmatchedGuides.length === 1 ? 'y has' : 'ies have'} no matching catalog machine: ${unmatchedGuides.join(', ')}`)
  }
  if (unmatchedCatalog.length > 0) {
    console.warn(
      `gen-guides: ${unmatchedCatalog.length} of ${catalog.length} catalog machines have no guides.json entry yet, so no page was generated for them: ${unmatchedCatalog.join(', ')}`,
    )
  }

  // Wipe and recreate app/public/machines/ so a machine removed from a
  // future guides.json doesn't leave a stale, unlinked page behind (the
  // sitemap test below checks the sitemap lists exactly what's on disk —
  // a stale directory would make that check meaningless).
  if (existsSync(MACHINES_DIR)) rmSync(MACHINES_DIR, { recursive: true, force: true })
  mkdirSync(MACHINES_DIR, { recursive: true })

  let totalBytes = 0
  for (const { catalogEntry, guide } of matched) {
    const goalsDoc = loadGoals(catalogEntry.resource)
    const html = renderMachinePage({ catalogEntry, guide, goalsDoc })
    const dir = resolve(MACHINES_DIR, catalogEntry.id)
    mkdirSync(dir, { recursive: true })
    const outPath = resolve(dir, 'index.html')
    writeFileSync(outPath, html, 'utf8')
    totalBytes += Buffer.byteLength(html, 'utf8')
  }

  const indexHtml = renderIndexPage(matched)
  writeFileSync(resolve(MACHINES_DIR, 'index.html'), indexHtml, 'utf8')
  totalBytes += Buffer.byteLength(indexHtml, 'utf8')

  writeFileSync(resolve(MACHINES_DIR, 'guide.css'), GUIDE_CSS, 'utf8')

  const sitemapXml = buildSitemapXml(matched)
  writeFileSync(resolve(PUBLIC_DIR, 'sitemap.xml'), sitemapXml, 'utf8')

  console.log(`gen-guides: wrote ${matched.length} machine page(s) + 1 index page (${totalBytes} bytes total) to ${MACHINES_DIR}`)
  console.log(`gen-guides: wrote sitemap.xml (${matched.length + 6} URLs)`)
}

// Only run when invoked directly (`node gen-guides.mjs`), not when imported
// by the test suite — same guard idiom as this repo's other CLI scripts
// avoid needing (they have no importers), stated explicitly here because
// this one is designed to be imported too.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) main()
