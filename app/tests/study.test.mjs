#!/usr/bin/env node
// app/tests/study.test.mjs — SUITE: the Study tab (wave 2, owner-specced,
// 2026-08-11, ui/study.ts) — "a step thru of everything on the playfield."
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/study.test.mjs"
// or from app/:
//   node tests/study.test.mjs
//
// Pattern: esbuild bundles the REAL .ts sources (ui/study.ts +
// overlay/map2d.ts's playfieldRect/zoneScreenRect, never edited, never
// copied) into a temp ESM file, exercised two ways — buildTour() directly as
// a pure function (section a), and the REAL mountStudy() against a fake DOM/
// canvas/ResizeObserver/rAF/performance harness (sections b+), the same
// "mount the real thing, drive it deterministically, read back canvas draw
// calls" pattern app/tests/celebrate.test.mjs's own integration section (l)
// established for overlay/map2d.ts's mountMap2D.
//
// FIXTURE: one synthetic machine, 6 shots (mixed trim, one on a
// PlayfieldZone deck) — see SHOTS/DECK_ZONE below. Top-to-bottom order
// (descending shot.y, x tie-break) is: s-top, s-premium, s-deck,
// s-mid-left, s-mid-right, s-bottom under trim 'premium-le' (6 shots);
// s-premium drops out under 'pro' (5 shots), proving both the ORDER and the
// TRIM FILTER at once.
//
// Sections:
//   a. buildTour() (PURE, no DOM) — order + trim filtering, deck shot
//      included.
//   b. Full mount: initial render shows the first shot's name floating;
//      stepping ‹ › moves the tour and the floating name changes with it.
//   c. Tap-to-inspect: a click at a shot dot's real recorded canvas
//      coordinates jumps the tour straight to it.
//   d. Tap-to-inspect: a click inside a zone's plate (zoneScreenRect's own
//      output) jumps to that zone's member (deck) shot.
//   e. LEARN sheet: opens with the current shot's name/type/notes/PREM-LE
//      chip, role=dialog + focus moves to its Back button.
//   f. Dismiss via the sheet's Back button: sheet closes, shuffle resumes
//      (rAF rescheduled, readout back to SHUFFLE), focus returns.
//   g. Dismiss via tapping the exposed field (the backdrop) — same resume
//      contract as (f), different trigger.
//   h. Stepping ‹ › WHILE the sheet is open updates its content in place —
//      sheet stays open, the SAME panel element (no re-triggered slide-up
//      animation), body text changes to the new current shot.
//   i. Full-mount trim: trim 'pro' draws exactly 5 dots (not 6) — the
//      premium-le shot never reaches the canvas.
//   j. ui/howto.ts source: all Card info is gone, the Study section exists,
//      "Map tab" phrasing is gone (renamed to "Shots tab"), tab-list bullet
//      order is Goals/Shots/Study/Achievements.
//   k. ACTION sheet: the machine action-button explainer (dataset schema v6).
//   l. Phone-canvas geometry (P3, 2026-08-14) — LAYOUT pins that no behavioural
//      test can see: the drawn card's real bottom edge (recovered from two
//      recorded dot positions) must clear .study-controls; BOTTOM_CLEARANCE
//      >= 16; both readout pills must compute SHORTER than their 44px buttons
//      (all five line-heights explicit, never the `font:` shorthand's
//      per-platform `normal`); .study-controls must pass taps through to the
//      canvas; index.html must not block pinch-zoom.
//
//   m. LEARN <-> ACTION BUTTON switching (P4 addendum, 2026-08-14): the
//      switch swaps the OPEN panel's content in place instead of closing one
//      sheet and opening another (which replayed the slide-up — the reported
//      "jumpy" motion); reduced motion keeps the swap and drops the fade.
//   n. The ACTION BUTTON pill: its label, and its promotion to LEARN's own
//      solid-amber weight.
//   o. ONE standard sheet height — the pinned height, its timer and their four
//      races are gone rather than well-owned.
//   p. Sheet focus + LEARN stepping: nothing stranded, nothing regressed.
//   q. The pill row stacks above the sheet backdrop, so a swap is reachable by
//      touch.
//   (r. was the 320px eyebrow-crowding measurement; the eyebrow was removed on
//      2026-08-15 — "the text study jaws under the buttons is unnecessary" —
//      and the 320px pill fit it shared a fixture with lives in section w.)
//
//   --- P8 (2026-08-14); s. REWRITTEN 2026-08-15 for the merge ---
//   s. THE COMBINED LEARN SHEET (owner: "als learn and all shots are like the
//      same thing… we can combine those two buttons and their material"): the
//      current shot's DETAIL over the whole scoped tour's LIST, tapping a row
//      jumps the tour and LEAVES THE SHEET OPEN with the ✓ moved and the
//      DETAIL swapped — by EDITING the rows, never rebuilding them, so the
//      list keeps its nodes, its focus and its scroll offset. Plus the
//      removal: no ALL SHOTS pill, no 'shots' kind, and the list scoped to
//      whatever LEVEL is walking.
//   t. DRILLS: the conditional pill (hidden with no drills, checked against
//      the REAL jaws/godzilla datasets as well as the fixture), one card per
//      drill, reps line / focus chip only where authored, and the "Study …"
//      jump that appears only when the current MODEL still shows that shot.
//  ah. CHARACTER (2026-08-15): the door the progression layer gets to itself —
//      the one predicate three surfaces read, the conditional pill, the cards
//      and their VERBATIM instruction lines, and the two ways a machine has
//      nothing to show. Real datasets, including the pair that author the same
//      character select twice.
//   u. The in-sheet ‹ ›, which close the phone-only gap section (h) could
//      only reach by keyboard: shown for LEARN, hidden for the other three,
//      built once, stepping in place — and, since the merge, moving the list's
//      mark and revealing the row as well as swapping the detail.
//   v. FOUR kinds, ONE sheet: cycling leaks no panel, backdrop or Escape
//      listener; a MODEL change rebuilds the shot-dependent bodies in place.
//   w. Rail geometry: the rail fits the widest pill, the card never runs under
//      it, the first pill's top edge is the card's top edge, and the pill
//      column against the readout bar at 667px AND at the shortest host the
//      CSS permits — restated 2026-08-15 for four pills and no eyebrow.
//   x. Shape-aware tap-to-inspect: study.ts uses map2d.ts's insertHitDistance
//      rather than a second hit test, and its INSERT_SHAPE mirror is pinned
//      byte-identical to map2d.ts's private table.
//
//   --- P8 review follow-up (2026-08-14) ---
//   y. A11y on a sheet that STAYS OPEN while the tour moves underneath it:
//      the one polite live region and what it says, aria-current on the
//      tapped row, focus surviving a jump (and being re-homed to the CURRENT
//      row on the one path that does rebuild the list), and the Tab trap
//      `aria-modal="true"` had been claiming since P4 without owning —
//      exercised against every kind, both directions, plus the
//      focus-parked-outside-the-ring case.
//   z. Machine switch with a sheet open: every kind closes (the designed
//      behaviour, documented in study.ts), nothing is left behind, and the
//      canvas label band is the NEW machine's pill count on the first frame —
//      measured through the label's own above/below-the-dot placement.
//  aa. The free-prose focus chip cannot overflow its card: the longest
//      AUTHORED value is pinned, shown to overflow a 320px card without the
//      guard, and the three CSS properties that make overflow impossible for
//      ARBITRARY future strings are asserted individually.
//
// Exits non-zero on any FAIL.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const studyPath = resolve(srcDir, 'ui/study.ts')
const goalMetaPath = resolve(srcDir, 'ui/goalMeta.ts')
const map2dPath = resolve(srcDir, 'overlay/map2d.ts')
const drawingPath = resolve(srcDir, 'overlay/drawing.ts')
const howtoPath = resolve(srcDir, 'ui/howto.ts')
const stylesPath = resolve(srcDir, 'styles.css')
const indexHtmlPath = resolve(__dirname, '../index.html')

// ---------------------------------------------------------------------------
// Sources read as TEXT (not bundled), for section (l)'s layout pins — and for
// section (d)'s prediction constants, which were hand-copied numbers that went
// stale the moment study.ts's own changed (they did, 2026-08-14).
// ---------------------------------------------------------------------------
const studySrc = readFileSync(studyPath, 'utf8')
const stylesSrc = readFileSync(stylesPath, 'utf8')
const indexHtmlSrc = readFileSync(indexHtmlPath, 'utf8')

/** A top-level `const NAME = <number>` out of a .ts source — AS SHIPPED. */
function tsConst(src, name, where) {
  const m = new RegExp(`^const ${name} = (-?\\d+(?:\\.\\d+)?)\\s*$`, 'm').exec(src)
  if (!m) throw new Error(`${where}: no top-level \`const ${name} = <number>\` found`)
  return Number(m[1])
}

/** Bodies of every top-level styles.css rule whose comma-separated selector
 *  list contains `selector` EXACTLY, in source order — the cascade's own
 *  model, so a property set in a grouped rule (`.a, .b { … }`) counts for both
 *  and a `:disabled`/`:focus-visible` variant never counts for the base. */
function cssRuleBodies(selector) {
  const src = stylesSrc.replace(/\/\*[\s\S]*?\*\//g, '')
  const bodies = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(src))) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) bodies.push(m[2])
  }
  return bodies
}

/** Resolved value of a longhand for `selector`: last declaration wins across
 *  every rule naming it (source order = cascade order; all of these rules are
 *  single-class, i.e. equal specificity). null when never declared. */
function cssValue(selector, prop) {
  let value = null
  for (const body of cssRuleBodies(selector)) {
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g')
    let m
    while ((m = re.exec(body))) value = m[1].trim()
  }
  return value
}

/** Rendered height in CSS px of one of the two ‹ › readout pills, computed
 *  from the CSS as shipped: its stacked text lines (font-size x line-height)
 *  plus its own vertical padding and border. The pills are content-sized, and
 *  the bar they sit in is bottom-anchored — see .map-step-readout's comment. */
function pillHeight(pillSelector, lineSelectors) {
  let text = 0
  for (const sel of lineSelectors) {
    const bodies = cssRuleBodies(sel)
    if (bodies.length === 0) throw new Error(`styles.css has no ${sel} rule`)
    const font = cssValue(sel, 'font')
    if (!font) throw new Error(`${sel} has no \`font:\` shorthand`)
    const size = /(\d+(?:\.\d+)?)px/.exec(font)
    if (!size) throw new Error(`${sel}'s \`font:\` shorthand has no px size: ${font}`)
    const lh = cssValue(sel, 'line-height')
    if (!lh) throw new Error(`${sel} never declares line-height — the \`font:\` shorthand resets it to \`normal\` (a per-platform font metric), so this pill's height is not knowable here or on a phone`)
    // The shorthand RESETS line-height, so a longhand only counts if it comes
    // after it — checked here rather than assumed.
    const body = bodies.join(';')
    if (body.indexOf('line-height') < body.indexOf('font:')) {
      throw new Error(`${sel} declares line-height BEFORE its \`font:\` shorthand, which resets it — the declaration has no effect`)
    }
    text += Number(size[1]) * Number(lh)
  }
  const pad = /(\d+(?:\.\d+)?)px/.exec(cssValue(pillSelector, 'padding') || '')
  const border = /(\d+(?:\.\d+)?)px/.exec(cssValue(pillSelector, 'border') || '')
  return text + 2 * Number(pad ? pad[1] : 0) + 2 * Number(border ? border[1] : 0)
}

/** Top edge of a bottom-anchored ‹ › bar, in canvas px from the host's top:
 *  the bar is as tall as the taller of its 44px buttons and its content-sized
 *  pill, and sits `bottom` px above the host's bottom edge. */
function barTop(hostHeight, barSelector, btnSelector, pillPx) {
  const bottom = /(\d+(?:\.\d+)?)px/.exec(cssValue(barSelector, 'bottom') || '')
  const btnH = /(\d+(?:\.\d+)?)px/.exec(cssValue(btnSelector, 'height') || '')
  if (!bottom) throw new Error(`${barSelector} has no \`bottom: <n>px\``)
  if (!btnH) throw new Error(`${btnSelector} has no \`height: <n>px\``)
  return {
    bottom: Number(bottom[1]),
    height: Math.max(Number(btnH[1]), pillPx),
    top: hostHeight - Number(bottom[1]) - Math.max(Number(btnH[1]), pillPx),
  }
}

// ---------------------------------------------------------------------------
// Harness (identical shape to every other suite here)
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
    console.log(`  FAIL  ${name}\n          ${err && err.stack ? err.stack : err}`)
  }
}
/** test(), for a body that awaits (2026-10-14: the glossary's async load). */
async function testAsync(name, fn) {
  const full = `${currentSection} :: ${name}`
  try {
    const evidence = await fn()
    results.push({ name: full, outcome: 'pass' })
    console.log(`  PASS  ${name}${evidence ? `\n          ${evidence}` : ''}`)
  } catch (err) {
    results.push({ name: full, outcome: 'fail' })
    console.log(`  FAIL  ${name}\n          ${err && err.stack ? err.stack : err}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** Is `node` anywhere inside `root`'s subtree? Walks parentElement, which the
 *  FakeElement below maintains — used where a test's real claim is
 *  containment, not a direct parent/child relationship. */
function descends(root, node) {
  for (let el = node; el; el = el.parentElement) if (el === root) return true
  return false
}

// ---------------------------------------------------------------------------
// Bundle the real modules.
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(resolve(tmpdir(), 'pg-study-'))
const entry = resolve(tmp, 'entry.ts')
await writeFile(
  entry,
  [
    `export { mountStudy, buildTour, computeStackRects, studyLevels, resolveStudyLevel } from ${JSON.stringify(studyPath)}`,
    `export { playfieldRect, zoneScreenRect, insertHitDistance, INSERT_DRAW_RADIUS, PLAYFIELD_ASPECT } from ${JSON.stringify(map2dPath)}`,
    `export { cardXBounds, clampLabelCenterX, LABEL_EDGE_PAD } from ${JSON.stringify(drawingPath)}`,
    // The CHARACTER door's rule (2026-08-15), exported so the predicate can be
    // driven DIRECTLY as well as through the mounted rail — the pill and the
    // sheet are only provably one rule if the rule itself is testable.
    `export { characterGoals, isCharacterGoal } from ${JSON.stringify(goalMetaPath)}`,
    // INLINE TERMS (2026-10-14): the pure matcher and the DOM builder, driven
    // directly on real dataset strings in section (aj) — plus the overlay
    // stack, so section (al) can put a dialog ABOVE the Study sheet and prove
    // the landing open does not steal focus from it. Same bundle, so the
    // stack is the very module instance study.ts registers with.
    `export { linkTerms, matchTerms, shotNameParts } from ${JSON.stringify(resolve(srcDir, 'ui/linkTerms.ts'))}`,
    `export { pushOverlay, popOverlay, OVERLAY_TIER_OVERLAY } from ${JSON.stringify(resolve(srcDir, 'ui/overlayStack.ts'))}`,
    // THE REAL FIRST-RUN GUIDE (2026-10-14), in the SAME bundle so it shares
    // the overlay stack with the Study sheet — section (al) opens it over the
    // landing HOW IT PLAYS and proves its Tab trap and where focus lands when
    // it closes. Its two browser-only leaves are stubbed below.
    `export { openHowTo } from ${JSON.stringify(howtoPath)}`,
  ].join('\n'),
)
/** ui/install.ts registers window listeners AT IMPORT (before any fake window
 *  exists here) and ui/instagram.ts draws its glyph with createElementNS,
 *  which this fake document has no use for. Neither is what the guide's focus
 *  handling is about, so both are replaced by inert stand-ins with the same
 *  export names; the Instagram link stays a real <a href> in the guide. */
const stubGuideLeaves = {
  name: 'stub-guide-leaves',
  setup(b) {
    b.onResolve({ filter: /^\.\/(install|instagram)$/ }, (args) => ({ path: args.path.slice(2), namespace: 'pg-guide-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'pg-guide-stub' }, (args) => ({
      loader: 'js',
      contents: args.path === 'install'
        ? 'export const canInstall = () => false\nexport async function promptInstall() {}\nexport const onInstallAvailabilityChange = () => () => {}'
        : [
            "export const INSTAGRAM_URL = 'https://www.instagram.com/pinballgenie/'",
            "export const INSTAGRAM_HANDLE = '@pinballgenie'",
            'export function renderInstagramLink() {',
            "  const a = document.createElement('a')",
            "  a.className = 'pg-ig-link'",
            "  a.setAttribute('href', INSTAGRAM_URL)",
            '  return a',
            '}',
          ].join('\n'),
    }))
  },
}
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  define: { __BUILD_STAMP__: '"test"' },
  plugins: [stubGuideLeaves],
})
const {
  mountStudy,
  buildTour,
  computeStackRects,
  studyLevels,
  resolveStudyLevel,
  playfieldRect,
  zoneScreenRect,
  insertHitDistance,
  INSERT_DRAW_RADIUS,
  PLAYFIELD_ASPECT,
  cardXBounds,
  clampLabelCenterX,
  LABEL_EDGE_PAD,
  characterGoals,
  isCharacterGoal,
  linkTerms,
  matchTerms,
  shotNameParts,
  pushOverlay,
  popOverlay,
  OVERLAY_TIER_OVERLAY,
  openHowTo,
} = await import(pathToFileURL(outfile).href)

// THE REAL GLOSSARY, SERVED (2026-10-14). mountStudy loads data/glossary.json
// in the background for its inline term links (ui/glossary.ts loadGlossary,
// memoised for the life of the module). Installed ONCE, before any mount, and
// never removed: the memo means the FIRST load decides every mount's answer,
// so a fetch that 404'd for the early sections would leave the glossary null
// for the sections that test it. Every other fetch is refused, loudly.
const REAL_GLOSSARY = JSON.parse(readFileSync(resolve(__dirname, '../../data/glossary.json'), 'utf8'))
globalThis.fetch = async (url) => {
  if (String(url) === '/data/glossary.json') return { ok: true, status: 200, json: async () => REAL_GLOSSARY }
  return { ok: false, status: 404, json: async () => null }
}
/** One turn of the real event loop — enough for the glossary's chunk + fetch
 *  + .then hops to settle. NOT the harness's setTimeout, which is a fake
 *  clock inside a mount. */
const settle = () => new Promise((r) => setImmediate(r))

// ---------------------------------------------------------------------------
// Synthetic fixture — see this file's header for the expected tour order.
// ---------------------------------------------------------------------------
const DECK_ZONE = { id: 'z-deck', name: 'Test Deck', kind: 'upper', bounds: { x: 0.5, y: 0.55, w: 0.25, h: 0.2 } }
const SHOTS = [
  {
    id: 's-top',
    name: 'Top Shot',
    type: 'ramp',
    x: 0.5,
    y: 0.9,
    trim: 'all',
    notes: 'A crowd-pleaser — softly plunge it for the skill shot.',
  },
  { id: 's-mid-left', name: 'Mid Left', type: 'standup', x: 0.2, y: 0.5, trim: 'all' },
  { id: 's-mid-right', name: 'Mid Right', type: 'standup', x: 0.8, y: 0.5, trim: 'all', notes: 'Watch the rebound.' },
  { id: 's-bottom', name: 'Bottom Shot', type: 'lane', x: 0.5, y: 0.1, trim: 'all' },
  { id: 's-premium', name: 'Premium Only Shot', type: 'orbit', x: 0.35, y: 0.7, trim: 'premium-le' },
  { id: 's-deck', name: 'Deck Shot', type: 'standup', x: 0.6, y: 0.65, trim: 'all', playfield: 'z-deck' },
]
/** The live region's coalescing window, READ OUT of ui/study.ts rather than
 *  copied — a test that waits a hand-typed 250ms would silently stop waiting
 *  long enough the moment the constant moved. */
const ANNOUNCE_WINDOW_MS = tsConst(studySrc, 'ANNOUNCE_WINDOW_MS', 'ui/study.ts')

/** The pill rail's width, READ OUT of styles.css. `--study-rail-w` is
 *  declared twice — the base value and the <360px step-down — and the first
 *  is the base. */
function railWidthFor(viewportPx) {
  const decls = [...stylesSrc.matchAll(/--study-rail-w:\s*(\d+)px/g)].map((m) => Number(m[1]))
  if (decls.length < 2) throw new Error(`styles.css: expected a base --study-rail-w and a small-phone step-down, found ${decls.length}`)
  return viewportPx < 360 ? decls[1] : decls[0]
}
const RAIL_W = railWidthFor(9999)

const TOUR_ORDER_PREMIUM_LE = ['s-top', 's-premium', 's-deck', 's-mid-left', 's-mid-right', 's-bottom']
const TOUR_ORDER_PRO = ['s-top', 's-deck', 's-mid-left', 's-mid-right', 's-bottom']

/** Drills fixture (P8). Deliberately covers every optional field's presence
 *  AND absence, because each one is an independent branch in buildDrillCard:
 *   - full         reps + focus + a shot that IS in the tour under both trims
 *   - premium-only reps + focus + a shot only the premium-le tour has (so the
 *                  "Study …" button must disappear under trim 'pro')
 *   - bare         no reps, no focus, no shots at all (Jaws' real drills carry
 *                  no `shots`, so this is the shipped shape, not a hypothetical) */
/** A present:true action button, for the sections that need all four pills up
 *  at once (the stack's geometry, and the four-kind cycle). */
const ACTION_BUTTON = {
  present: true,
  label: 'Action Button',
  location: 'lockdown bar',
  how: 'Big red button on the lockdown bar. It fires whatever the game has armed.',
  uses: [{ when: 'During Smart Missile', what: 'Press to collect every lit shot at once.' }],
}

const DRILLS = [
  {
    id: 'd-full',
    title: 'Ramp Repeats',
    text: 'Feed the top ramp and take the return in one motion, over and over.',
    reps: '20',
    focus: 'Backhand timing on the left flipper',
    goal: 'combo-left-ramp-loop',
    shots: ['s-top'],
  },
  {
    id: 'd-premium',
    title: 'Deck Access',
    text: 'Full-strength ramp shots only — anything soft returns to the mini flipper.',
    reps: '10 attempts',
    focus: 'ramp strength',
    shots: ['s-premium'],
  },
  {
    id: 'd-bare',
    title: 'Outlane Discipline',
    text: 'Play a few balls deliberately favouring the flipper nearer the outlane.',
  },
]

/** ALT MODES fixtures (dataset schema v7). Deliberately one of each shape the
 *  shipped corpus actually contains, because the card body branches on all
 *  three: a PATHLESS menu (instructions, no steps — Jaws' attract menu), a
 *  ROUTED video mode (steps, no instructions — Attack from Mars'), and a
 *  ruleset with NO reward authored. Plus an unflagged goal, so "the sheet
 *  shows only the flagged ones" is a real measurement rather than "it shows
 *  the goals array". */
const ALT_GOALS = [
  {
    id: 'g-plain',
    title: 'Left Ramp Loop',
    category: 'combo',
    summary: 'Ordinary ball-in-play content — carries no flag and must never reach the ALT MODES sheet.',
    difficulty: 1,
    reward: '5M',
    steps: [{ shot: 's-top', action: 'Shoot the left ramp' }],
  },
  {
    id: 'g-menu',
    title: 'Attract-Mode Challenge Menu',
    category: 'secret',
    altMode: 'menu',
    summary: 'A second menu of ways to play, behind the attract screen.',
    difficulty: 1,
    reward: 'Access to Competition and a standalone challenge',
    steps: [],
    instructions: ['Hold both flipper buttons in attract mode', 'Choose a mode, then start your game'],
  },
  {
    id: 'g-video',
    title: 'Video Mode: Shark Hunter',
    category: 'secret',
    altMode: 'video',
    summary: 'The flippers stop flipping and start firing harpoons.',
    difficulty: 2,
    reward: 'Up to 60M',
    steps: [
      { shot: 's-top', action: 'Collect the award that arms it' },
      { shot: 's-bottom', action: 'Shoot the right ramp to launch it' },
    ],
  },
  {
    id: 'g-ruleset',
    title: 'Casual Mode Off',
    category: 'secret',
    altMode: 'ruleset',
    summary: 'A boot-time flipper hold that swaps the stripped-down ruleset for the full one.',
    difficulty: 1,
    steps: [],
    instructions: ['Hold the left flipper as the game boots'],
  },
]

/** CHARACTER fixtures (2026-08-15). The door's rule is `category ===
 *  'progression' && isPathless`, so this covers BOTH sides of BOTH conjuncts,
 *  because each one is a branch something could silently widen:
 *   - g-char-select   progression + pathless, reward authored      -> IN
 *   - g-char-gear     progression + pathless, NO reward authored   -> IN
 *   - g-char-routed   progression but ROUTED (steps)               -> OUT
 *  and ALT_GOALS above supplies the other exclusion this door was specified
 *  against: `g-menu`/`g-ruleset` are PATHLESS 'secret' goals, which is the
 *  shape of the duplicate character selects the real corpus authors twice
 *  (dnd's class-select-flipper-cycle beside character-and-city-select; tmnt's
 *  pregame-turtle-select beside turtle-select-perks). */
const CHARACTER_GOALS = [
  {
    id: 'g-char-select',
    title: 'Pick Your Hero and Your Starting Town',
    category: 'progression',
    summary: 'Two decisions get made before the ball ever launches.',
    difficulty: 1,
    reward: 'A campaign-long perk plus control over where the story begins',
    steps: [],
    instructions: [
      'On the select screen, press the right flipper button to cycle through the available characters',
      'Press the left flipper button on that same screen to cycle the starting town',
      'Anya, the halfling rogue, carries more luck, which makes rarer items turn up in treasure more often',
    ],
  },
  {
    id: 'g-char-gear',
    title: 'The Six Pieces of Gear and What Each One Buys You',
    category: 'progression',
    summary: 'Gear is banked at the right ramp and each piece changes a different rule.',
    difficulty: 3,
    steps: [],
    instructions: ['Barrel hook: another ball is launched when your multiball falls back to one', 'Oxygen tank: ball save timers and mode timers all run longer'],
  },
  {
    id: 'g-char-routed',
    title: 'Bank the Level-Up at the Scoop',
    category: 'progression',
    summary: 'A progression goal that DOES have a route — this door is not for it.',
    difficulty: 2,
    reward: '10M',
    steps: [{ shot: 's-top', action: 'Shoot the ramp to arm it' }, { shot: 's-bottom', action: 'Bank it at the scoop' }],
  },
]

/** Every goal fixture that lights a pill, for the sections whose subject is the
 *  rail with ALL FIVE showing at once. */
const ALL_PILL_GOALS = [...ALT_GOALS, ...CHARACTER_GOALS]
// A minimal VALID howItPlays (schema v9) — enough for howItPlaysOf to accept it
// and for both new pills to mount visible. Site shots reference the SHOTS
// fixture; goals are omitted (the pills' visibility does not depend on them).
const HOW_IT_PLAYS = {
  objective: 'Build the armour and reach the wizard mode.',
  loop: ['Shoot the lit arrows.', 'Spell the letters.', 'Start a multiball.'],
  lights: [
    { id: 'lg-arrows', name: 'Shot arrows', kind: 'shot-arrow', sites: [{ shot: 's-top' }], lit: 'A lit arrow scores its shot.', then: 'Shoot the lit arrow.', control: null, goals: null },
    { id: 'lg-lanes', name: 'Top lanes', kind: 'lanes', sites: [{ shot: 's-bottom' }, { shot: 's-mid-left' }], lit: 'The lit lane pays and advances the bonus.', then: 'Roll through the lit lane.', control: { input: 'either-flipper', effect: 'moves the lit lane', when: 'any time in play' }, goals: null },
  ],
  laneChange: 'flippers',
  laneChangeNote: 'Either flipper button rotates the lit top lane.',
  scoring: [
    { tier: 'ball-one', text: 'Take the safe lit shots first.', goals: null },
    { tier: 'building', text: 'Stack a multiball with the multiplier.', goals: null },
    { tier: 'the-big-one', text: 'Reach the wizard mode.', goals: null },
  ],
}

function makeMachine() {
  return { id: 'test-machine', name: 'Test Machine', shortTitle: 'TEST', resource: 'test_goals' }
}
function makeData(shots = SHOTS, playfields = [DECK_ZONE], drills = null, goals = []) {
  const data = { machine: 'Test Machine', shots, goals, sources: [], playfields }
  // Absent, not null-valued, when there are none: `drills` is an optional
  // dataset field and the shipped no-drills machines simply do not carry it.
  if (drills) data.drills = drills
  return data
}

// ===========================================================================
section('a. buildTour() (PURE, no DOM) — top-to-bottom spatial order + trim filtering')
// ===========================================================================

test("trim 'premium-le': all 6 shots, in the documented top-to-bottom order", () => {
  const tour = buildTour(SHOTS, 'premium-le')
  const ids = tour.map((s) => s.id)
  assert(ids.join(',') === TOUR_ORDER_PREMIUM_LE.join(','), `expected [${TOUR_ORDER_PREMIUM_LE.join(', ')}], got [${ids.join(', ')}]`)
  return ids.join(' -> ')
})

test("trim 'pro': the premium-le shot drops out (5 remain), order otherwise unchanged, deck shot still included", () => {
  const tour = buildTour(SHOTS, 'pro')
  const ids = tour.map((s) => s.id)
  assert(ids.join(',') === TOUR_ORDER_PRO.join(','), `expected [${TOUR_ORDER_PRO.join(', ')}], got [${ids.join(', ')}]`)
  assert(ids.includes('s-deck'), 'expected the deck shot to remain in the pro tour')
  assert(!ids.includes('s-premium'), 'expected the premium-le shot to be excluded under pro')
})

// ===========================================================================
// DOM/canvas harness — mirrors celebrate.test.mjs's withMountedMap2D exactly
// (FakeElement, FakeResizeObserver, fake rAF/performance), plus a shared
// `domActiveElement` so document.activeElement/Element.focus() round-trip
// for this file's a11y checks (celebrate.test.mjs never needed that).
// ===========================================================================
const W = 600
const H = 900

/** The CURRENT fake viewport. Defaults to W x H (what every test that does not
 *  ask for a size gets); withMountedStudy's `viewportW`/`viewportH` options
 *  swap them for the duration of one mount, which is how the alignment section
 *  drives the same real module at 320/390/430 and at tall/short heights. */
let VIEW_W = W
let VIEW_H = H

let domActiveElement = null

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.className = ''
    this._text = ''
    this.hidden = false
    this.disabled = false
    this.clientHeight = VIEW_H
    this.width = 0
    this.height = 0
    const classSet = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      contains: (c) => classSet.has(c),
    }
    // removeProperty is REAL API surface here, not a nicety: ui/study.ts's
    // pinned-height cleanup calls style.removeProperty('height'), and a bare
    // {} made that throw — i.e. this stub silently could not run the code path
    // section (o) below exists to test.
    // setProperty joins removeProperty as REAL API surface (P9 follow-up):
    // ui/study.ts publishes the card's drawn top edge as `--study-card-top`
    // for `.study-rail`'s padding-top, and a bare {} makes that throw. Custom
    // properties are kept in their own map so a test can read back exactly
    // what was written.
    const styleObj = {
      removeProperty: (prop) => {
        delete styleObj[prop]
        delete styleObj._vars[prop]
      },
      _vars: Object.create(null),
      setProperty: (prop, value) => {
        styleObj._vars[prop] = value
        styleObj[prop] = value
      },
      getPropertyValue: (prop) => styleObj._vars[prop] ?? '',
    }
    this.style = styleObj
    this._listeners = new Map()
    this._attrs = {}
    /** Every scrollIntoView request made against this element — see the method
     *  below. */
    this._scrolls = []
  }
  /** FAKE LAYOUT, and the only piece of it this suite needs (P9). #study-host
   *  is a flex ROW — [canvas | rail] — so the canvas element is NARROWER than
   *  its host by exactly the rail's width. Everything else keeps reporting the
   *  host width. Without this the suite would drive a canvas that still
   *  believes it is full-width, and would prove nothing about the layout it is
   *  supposed to be testing (ui/study.ts's resize() reads THIS number). */
  get clientWidth() {
    if (this._clientWidth !== undefined) return this._clientWidth
    if (typeof this.className === 'string' && this.className.split(/\s+/).includes('study-canvas')) {
      return VIEW_W - railWidthFor(VIEW_W)
    }
    return VIEW_W
  }

  set clientWidth(v) {
    this._clientWidth = v
  }

  /** A CONTENT-DEPENDENT height, so ui/study.ts's measure -> pin -> transition
   *  path (which no-ops when offsetHeight is unmeasurable) actually runs here,
   *  and LEARN vs ACTION really do measure differently. Deliberately crude:
   *  a fixed chrome height plus a per-descendant-node cost. Anything that
   *  changes the subtree changes the number, which is the only property the
   *  height dance depends on. */
  get offsetHeight() {
    if (this._offsetHeight !== undefined) return this._offsetHeight
    let nodes = 0
    const walk = (el) => {
      nodes++
      for (const c of el.children) if (c instanceof FakeElement) walk(c)
    }
    walk(this)
    return 20 + 12 * nodes
  }
  set offsetHeight(v) {
    this._offsetHeight = v
  }
  set textContent(v) {
    this._text = v
    this.children = []
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => (c instanceof FakeElement ? c.textContent : c._text ?? '')).join('')
    return this._text
  }
  appendChild(child) {
    // A DocumentFragment's CHILDREN move, not the fragment — the real DOM's
    // rule, and the one ui/linkTerms.ts's output depends on (2026-10-14: the
    // Study prose is built as a fragment and appended into its paragraph).
    if (child && child.tagName === '#DOCUMENT-FRAGMENT') {
      for (const c of [...child.children]) this.appendChild(c)
      child.children = []
      return child
    }
    this.children.push(child)
    child.parentElement = this
    return child
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n))
  }
  replaceChildren(...nodes) {
    this.children = []
    nodes.forEach((n) => this.appendChild(n))
  }
  remove() {
    if (!this.parentElement) return
    const i = this.parentElement.children.indexOf(this)
    if (i >= 0) this.parentElement.children.splice(i, 1)
    this.parentElement = null
  }
  setAttribute(k, v) {
    this._attrs[k] = v
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn)
  }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) || []) fn(ev)
    return true
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }
  }
  focus() {
    domActiveElement = this
  }
  /** RECORDED, not stubbed. ui/study.ts's revealCurrentRow calls this on the
   *  row the tour just moved to, and in a harness with no layout that call IS
   *  the only observable "the list brought the current row into view" — the
   *  alternative would be re-implementing scroll geometry here and testing this
   *  file against itself. `block: 'nearest'` is the browser's own "only if
   *  off-screen" rule, so what is asserted is the REQUEST, not a pixel. */
  scrollIntoView(opts) {
    this._scrolls.push(opts)
  }
  find(cls) {
    if (typeof this.className === 'string' && this.className.split(/\s+/).includes(cls)) return this
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        const hit = c.find(cls)
        if (hit) return hit
      }
    }
    return null
  }
  findAll(cls, acc = []) {
    if (typeof this.className === 'string' && this.className.split(/\s+/).includes(cls)) acc.push(this)
    for (const c of this.children) if (c instanceof FakeElement) c.findAll(cls, acc)
    return acc
  }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function recordingCtx() {
  const calls = []
  const rec = (method) => (...args) => calls.push({ method, args })
  const noop = () => {}
  const ctx = {
    canvas: { clientWidth: W, clientHeight: H, width: W * 2, height: H * 2 },
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    save: noop,
    restore: noop,
    clip: noop,
    setLineDash: noop,
    setTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    arcTo: rec('arcTo'),
    arc: rec('arc'),
    rect: rec('rect'),
    roundRect: rec('roundRect'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    clearRect: noop,
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fill: rec('fill'),
    stroke: rec('stroke'),
    // RECORDED, not a noop, since BACKGLASS (P5): drawShotDots translates to
    // each shot's screen point before tracing its insert shape, which makes
    // this the one shape-independent "where is this shot drawn" signal.
    // See dotPositions().
    translate: rec('translate'),
    rotate: noop,
    scale: noop,
  }
  return { ctx, calls }
}

function makeFakeDocument(canvasCtx) {
  const listeners = new Map()
  return {
    createElement(tag) {
      const el = new FakeElement(tag)
      if (String(tag).toLowerCase() === 'canvas') {
        el.getContext = (type) => (type === '2d' ? canvasCtx : null)
      }
      return el
    },
    // ui/linkTerms.ts (2026-10-14) builds the Study tab's prose as a fragment
    // of Text nodes and term buttons. A text node here is a FakeElement whose
    // tag is '#text', so the existing textContent/find walks need no change.
    createTextNode(t) {
      const n = new FakeElement('#text')
      n.textContent = t
      return n
    },
    createDocumentFragment() {
      return new FakeElement('#document-fragment')
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    get activeElement() {
      return domActiveElement
    },
    /** Test-only. How many document-level listeners of `type` are alive —
     *  the only way to prove the merged sheet registers ONE Escape handler
     *  and tears it down, rather than leaking one per open. */
    _listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    },
    /** Test-only. Delivers a document-level key event the way a browser
     *  would, and reports whether anything called preventDefault. */
    _fireKey(key, init = {}) {
      let prevented = false
      const ev = { type: 'keydown', key, preventDefault: () => (prevented = true), ...init }
      for (const fn of [...(listeners.get('keydown') || [])]) fn(ev)
      return prevented
    },
  }
}

/** Every shot INSERT drawShotDots recorded, IN TOUR ORDER, as its centre.
 *
 *  This used to filter `arc` calls with radius exactly 3.5 — every shot was a
 *  3.5px circle. BACKGLASS (P5, 2026-08-14) draws each shot as its own
 *  playfield-insert silhouette instead (diamond lanes, bar targets, ring
 *  scoops, arrow ramps...), so most shot types emit no `arc` at all and a
 *  radius filter would silently report ZERO dots — a vacuous pass on every
 *  geometry assertion below.
 *
 *  drawShotDots therefore wraps each insert in `save()/translate(x, y)/
 *  restore()` and draws the shape around the origin, which gives exactly one
 *  recorded `translate` per shot regardless of its type. That is now the
 *  contract this helper reads (and drawShotDots' own comments name it as
 *  such). Nothing else in the Study render path translates — the only other
 *  `ctx.translate` callers in the app are drawing.ts's celebration glyphs,
 *  and Study has no celebration. */
function dotPositions(calls) {
  return calls.filter((c) => c.method === 'translate').map((c) => ({ x: c.args[0], y: c.args[1] }))
}

function fillTexts(calls) {
  return calls.filter((c) => c.method === 'fillText').map((c) => c.args[0])
}

/** Mounts the REAL mountStudy against the fake DOM above, installing fake
 *  document/window/ResizeObserver/rAF/performance for the duration of `fn`,
 *  then tears everything down (including the real `destroy()`) and restores
 *  the prior globals — even if `fn` throws. Mirrors celebrate.test.mjs's
 *  withMountedMap2D. `fn` gets `{ step, calls, host, handle }` — `handle` is
 *  mountStudy's own return value, which grew a second method (openCharacter)
 *  on 2026-08-15 and is otherwise only used to tear the mount down. */
function withMountedStudy(state, fn, { reducedMotion = false, viewportW = W, viewportH = H, jumpToGoalDetail = null, showGoalOnShots = null } = {}) {
  const priorView = { w: VIEW_W, h: VIEW_H }
  VIEW_W = viewportW
  VIEW_H = viewportH
  const { ctx, calls } = recordingCtx()
  const doc = makeFakeDocument(ctx)
  const prior = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    performance: globalThis.performance,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  let fakeClock = 0
  let pendingFrame = null
  domActiveElement = null
  globalThis.document = doc
  // matchMedia answers the ONE query ui/study.ts asks — prefers-reduced-motion
  // — from the harness flag, so the reduced-motion path is a real code path
  // this suite can drive, not an assumption.
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia: (q) => ({ matches: reducedMotion && /prefers-reduced-motion/.test(q), media: q }),
    // A browser's window.setTimeout IS the global one, and the app's timer
    // call sites spell it `window.` (map2d.ts's callout, study.ts's announce
    // coalescing). These forward at CALL time, not capture time, so they land
    // on the controllable clock installed below rather than on the real timers
    // that were live when this object was built.
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  }
  globalThis.requestAnimationFrame = (cb) => {
    pendingFrame = cb
    return 1
  }
  globalThis.cancelAnimationFrame = () => {
    pendingFrame = null
  }
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.performance = { now: () => fakeClock }

  // ---- Controllable timers (P4 review, 2026-08-14) ----------------------
  // ui/study.ts's pinned-height cleanup is a setTimeout, and the race it had
  // is only observable if a test can decide WHEN that callback runs relative
  // to the next user action. Real timers can't express "the user tapped again
  // 80ms in". These can: every scheduled callback is held with its due time,
  // and advanceTimers(ms) fires exactly those that have come due.
  const timers = new Map()
  let nextTimerId = 1
  let timerClock = 0
  globalThis.setTimeout = (cb, delay = 0) => {
    const id = nextTimerId++
    timers.set(id, { cb, due: timerClock + delay })
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
  }
  /** Advances the timer clock by `ms` and runs everything now due, in due
   *  order. Returns how many callbacks actually fired. */
  function advanceTimers(ms) {
    timerClock += ms
    const due = [...timers.entries()].filter(([, t]) => t.due <= timerClock).sort((a, b) => a[1].due - b[1].due)
    for (const [id, t] of due) {
      timers.delete(id)
      t.cb()
    }
    return due.length
  }
  const pendingTimerCount = () => timers.size

  let handle
  function cleanup() {
    handle?.destroy()
    VIEW_W = priorView.w
    VIEW_H = priorView.h
    globalThis.document = prior.document
    globalThis.window = prior.window
    globalThis.requestAnimationFrame = prior.requestAnimationFrame
    globalThis.cancelAnimationFrame = prior.cancelAnimationFrame
    globalThis.ResizeObserver = prior.ResizeObserver
    globalThis.performance = prior.performance
    globalThis.setTimeout = prior.setTimeout
    globalThis.clearTimeout = prior.clearTimeout
  }
  // AWAIT-AWARE (2026-10-14), the shape sheet.test.mjs's withFakeDom already
  // has: an ASYNC `fn` (the inline-term sections await the glossary's load)
  // keeps the fake globals installed until it settles. A plain finally would
  // tear them down at the first `await`, and the glossary would then land in
  // a destroyed mount and prove nothing.
  let isAsync = false
  try {
    const host = doc.createElement('div')
    handle = mountStudy(host, state, jumpToGoalDetail ?? undefined, showGoalOnShots ?? undefined)
    function step(elapsedMs) {
      fakeClock = elapsedMs
      const cb = pendingFrame
      if (!cb) return false
      cb(fakeClock)
      return true
    }
    function pendingFrameScheduled() {
      return pendingFrame !== null
    }
    const out = fn({ step, calls, host, handle, pendingFrameScheduled, advanceTimers, pendingTimerCount, doc })
    if (out && typeof out.then === 'function') {
      isAsync = true
      return out.then(
        (v) => (cleanup(), v),
        (e) => (cleanup(), Promise.reject(e)),
      )
    }
    return out
  } finally {
    if (!isAsync) cleanup()
  }
}

/** Minimal fake AppState — only the fields/methods ui/study.ts's mountStudy
 *  actually touches (state.data/state.machine/state.trim/state.onChange). */
function fakeAppState({ trim = 'premium-le', shots = SHOTS, playfields = [DECK_ZONE], drills = null, actionButton = null, goals = [], howItPlays = null } = {}) {
  const listeners = new Set()
  const data = makeData(shots, playfields, drills, goals)
  if (actionButton) data.actionButton = actionButton
  if (howItPlays) data.howItPlays = howItPlays
  return {
    machine: makeMachine(),
    data,
    // Real API surface, not a convenience: AppState builds this index once per
    // machine (state.ts) and map2d.ts's zone path reads it to find a zone's
    // flipper bats. The LEVEL feature made ui/study.ts a second caller.
    shotsByID: new Map(shots.map((sh) => [sh.id, sh])),
    trim,
    /** The real AppState.setTrim, minus its localStorage write: assign, then
     *  notify, and NO-OP (no notify) when the value is unchanged. The rail's
     *  MODEL control is a real caller of this since 2026-08-14, so a fake that
     *  merely stored the value would let a control that never notifies pass —
     *  the no-op guard is part of the contract being tested (pressing the
     *  selected half must announce nothing). */
    setTrim(v) {
      if (this.trim === v) return
      this.trim = v
      this._notify()
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** Test-only: fire the subscription the real AppState fires, so the
     *  MODEL-change paths (which re-filter the tour and rebuild an open ALL
     *  SHOTS / DRILLS body) are reachable from a test. */
    _notify() {
      for (const fn of [...listeners]) fn()
    },
  }
}

// ===========================================================================
section('b. Full mount: initial render shows the first shot floating; ‹ › moves the tour and the floating name changes with it')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host, calls }) => {
  test('mounts synchronously: readout reads "SHOT 1 OF 6" (top-to-bottom order, all 6 visible under premium-le)', () => {
    const label = host.find('study-readout-label')
    assert(label, 'expected a .study-readout-label element')
    assert(label.textContent === 'SHOT 1 OF 6', `expected "SHOT 1 OF 6", got ${JSON.stringify(label.textContent)}`)
  })

  // P4 (2026-08-14): the auto sub-line says SHUFFLE here and AUTO on the Map
  // tab, because they are different behaviours — a wrapping tour of every
  // shot vs a march along one selected goal's route. Both halves are pinned
  // (the second from map2d.ts's source) so "unify the wording" cannot quietly
  // re-merge two things that only looked the same.
  // 2026-10-14: the tour STARTS PAUSED (study.ts header, "THE TOUR STARTS
  // PAUSED"), so on arrival the sub-line is the PAUSED wording; the auto
  // wording is reached by the visitor's own tap, which section (ai) drives in
  // a mount of its own (a tap here would repaint, and the dot-count test
  // below counts exactly one paint). This keeps the WORDING pins.
  test("the auto sub-line reads 'SHUFFLE · TAP TO PAUSE' (not AUTO — that word belongs to the Map tab's route march)", () => {
    const sub = host.find('study-readout-sub')
    assert(sub, 'expected a .study-readout-sub element')
    assert(sub.textContent === 'PAUSED · TAP FOR AUTO', `expected the tour to arrive paused, got ${JSON.stringify(sub.textContent)}`)
    assert(studySrc.includes("'SHUFFLE · TAP TO PAUSE'"), "ui/study.ts no longer carries the 'SHUFFLE · TAP TO PAUSE' auto wording")
    const map2dSrc = readFileSync(map2dPath, 'utf8')
    assert(
      map2dSrc.includes("'AUTO · TAP TO PAUSE'"),
      "map2d.ts no longer says 'AUTO · TAP TO PAUSE' — the Map tab's route march is supposed to KEEP that wording",
    )
    assert(!studySrc.includes("'AUTO · TAP TO PAUSE'"), 'ui/study.ts still contains the old AUTO sub-line')
    return 'study: SHUFFLE · TAP TO PAUSE / map2d: AUTO · TAP TO PAUSE'
  })

  test('the floating name is the FIRST tour shot ("Top Shot"), drawn via fillText', () => {
    assert(fillTexts(calls).includes('Top Shot'), `expected a fillText("Top Shot", ...) call; got texts: ${JSON.stringify(fillTexts(calls))}`)
  })

  test('exactly 6 dots are drawn (drawShotDots ran once per tour shot)', () => {
    assert(dotPositions(calls).length === 6, `expected 6 dot arcs, got ${dotPositions(calls).length}`)
  })

  test('pressing › three times steps the tour to "Mid Left" (index 3) and its name replaces "Top Shot" on the field', () => {
    const nextBtn = host.findAll('study-step-btn')[1]
    assert(nextBtn, 'expected two .study-step-btn elements (‹ and ›)')
    const before = calls.length
    nextBtn.dispatchEvent({ type: 'click' })
    nextBtn.dispatchEvent({ type: 'click' })
    nextBtn.dispatchEvent({ type: 'click' })
    const label = host.find('study-readout-label')
    assert(label.textContent === 'SHOT 4 OF 6', `expected "SHOT 4 OF 6" after 3 presses, got ${JSON.stringify(label.textContent)}`)
    const newTexts = fillTexts(calls.slice(before))
    assert(newTexts.includes('Mid Left'), `expected the LAST click's render to float "Mid Left", got ${JSON.stringify(newTexts)}`)
  })

  test('‹ › pauses the shuffle (readout sub reads PAUSED, not SHUFFLE)', () => {
    const sub = host.find('study-readout-sub')
    assert(sub.textContent === 'PAUSED · TAP FOR AUTO', `expected the paused sub-label, got ${JSON.stringify(sub.textContent)}`)
  })
})

// ===========================================================================
section('c. Tap-to-inspect: a click at a shot dot\'s real recorded coordinates jumps the tour to it')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host, calls }) => {
  test('clicking the LAST dot (bottom-of-tour, "Bottom Shot") jumps straight to it, wherever it currently is', () => {
    const dots = dotPositions(calls) // in tour order — index 5 is "Bottom Shot"
    assert(dots.length === 6, `expected 6 recorded dots, got ${dots.length}`)
    const target = dots[5]
    const canvas = host.find('study-canvas')
    assert(canvas, 'expected a .study-canvas element')
    canvas.dispatchEvent({ type: 'click', clientX: target.x, clientY: target.y })
    const label = host.find('study-readout-label')
    assert(label.textContent === 'SHOT 6 OF 6', `expected "SHOT 6 OF 6" after tapping the last dot, got ${JSON.stringify(label.textContent)}`)
    const sub = host.find('study-readout-sub')
    assert(sub.textContent === 'PAUSED · TAP FOR AUTO', 'expected tap-to-inspect to also pause the shuffle')
  })
})

// ===========================================================================
section('d. Tap-to-inspect: a click inside a zone plate jumps to that zone\'s deck shot')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host }) => {
  test('clicking the center of zoneScreenRect(DECK_ZONE, map) lands the tour on "Deck Shot"', () => {
    // Re-derive the SAME map() closure mountStudy builds internally, using the
    // REAL, bundled playfieldRect/zoneScreenRect — not a hand re-derivation of
    // their own math. TOP_PAD/BOTTOM_CLEARANCE are READ OUT of study.ts rather
    // than copied: they were hardcoded here as 60/10, and when
    // BOTTOM_CLEARANCE became 16 (2026-08-14) this prediction silently stopped
    // describing the code it was predicting.
    const TOP_PAD = tsConst(studySrc, 'TOP_PAD', 'ui/study.ts')
    const BOTTOM_CLEARANCE = tsConst(studySrc, 'BOTTOM_CLEARANCE', 'ui/study.ts')
    const availableHeight = H - BOTTOM_CLEARANCE - TOP_PAD
    // W - RAIL_W, not W (P9): the canvas is the LEFT COLUMN of #study-host's
    // flex row now, so the card is fitted into the host width MINUS the pill
    // rail. This prediction failing on the day the rail landed is the test
    // working — it is derived from the real geometry, not copied from it.
    const rect = playfieldRect(W - RAIL_W, availableHeight)
    rect.y += TOP_PAD / 2
    const map = (u, v) => ({ x: rect.x + u * rect.w, y: rect.y + rect.h - v * rect.h })
    const zr = zoneScreenRect(DECK_ZONE, map)
    const cx = zr.x + zr.w / 2
    const cy = zr.y + zr.h / 2

    const canvas = host.find('study-canvas')
    canvas.dispatchEvent({ type: 'click', clientX: cx, clientY: cy })
    const label = host.find('study-readout-label')
    // "Deck Shot" is tour index 2 under premium-le (s-top, s-premium, s-deck, ...).
    assert(label.textContent === 'SHOT 3 OF 6', `expected "SHOT 3 OF 6" (Deck Shot) after tapping the zone plate, got ${JSON.stringify(label.textContent)}`)
  })
})

// ===========================================================================
section('e. LEARN sheet: opens with the current shot\'s name/type/notes/PREM-LE chip; a11y (role=dialog, focus)')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host }) => {
  test('LEARN opens the sheet showing "Top Shot"\'s real notes text (not the empty-notes placeholder)', () => {
    const learnBtn = host.find('study-learn-btn')
    assert(learnBtn, 'expected a .study-learn-btn element')
    learnBtn.dispatchEvent({ type: 'click' })
    const panel = host.find('study-learn-panel')
    assert(panel, 'expected a .study-learn-panel to be appended')
    assert(panel.getAttribute('role') === 'dialog', 'expected role="dialog"')
    assert(panel.getAttribute('aria-modal') === 'true', 'expected aria-modal="true"')
    const notes = panel.find('study-learn-notes')
    assert(
      notes.textContent === 'A crowd-pleaser — softly plunge it for the skill shot.',
      `expected the shot's real notes text, got ${JSON.stringify(notes.textContent)}`,
    )
    const title = panel.find('study-learn-title')
    assert(title.textContent === 'Top Shot', `expected the sheet title to be the shot's name, got ${JSON.stringify(title.textContent)}`)
  })

  test('the type chip and NO PREM/LE chip render for a plain "all"-trim shot', () => {
    const panel = host.find('study-learn-panel')
    const chips = panel.findAll('study-learn-chip')
    const chipTexts = chips.map((c) => c.textContent)
    assert(chipTexts.includes('RAMP'), `expected a "RAMP" type chip, got ${JSON.stringify(chipTexts)}`)
    assert(!panel.find('study-learn-chip-trim'), 'expected no PREM/LE chip for an "all"-trim shot')
  })

  test('focus moved to the sheet\'s Back button on open', () => {
    const backBtn = host.find('study-learn-back')
    assert(backBtn, 'expected a .study-learn-back element')
    assert(domActiveElement === backBtn, 'expected document.activeElement to be the Back button after opening')
  })

  // THE MERGE (2026-08-15). One press of LEARN now has to produce BOTH halves
  // — the shot's detail and the whole tour — or the owner's "combine those two
  // buttons and their material" shipped as "delete one of them".
  test('LEARN carries BOTH halves: the shot DETAIL over the whole tour as a LIST', () => {
    const panel = host.find('study-learn-panel')
    const detail = panel.find('study-learn-detail')
    const list = panel.find('study-learn-list')
    assert(detail, 'expected a .study-learn-detail region (the current shot)')
    assert(list, 'expected a .study-learn-list region (the tour)')
    assert(descends(detail, panel.find('study-learn-title')), 'the shot name must live in the DETAIL half')
    assert(descends(detail, panel.find('study-learn-notes')), 'the notes must live in the DETAIL half')
    assert(descends(list, panel.find('study-index-list')), 'the row list must live in the LIST half')
    const names = list.findAll('study-index-name').map((n) => n.textContent)
    assert(names.length === 6, `expected the whole tour listed under the detail, got ${names.length} rows`)
    assert(names[0] === 'Top Shot', `expected the list in tour order, got ${JSON.stringify(names)}`)
    return `detail: "${panel.find('study-learn-title').textContent}" + list: ${names.length} rows`
  })

  test('the LEARN body is ONE scroll region, not the old split (rolo 2026-09-08)', () => {
    // Was a split — the detail its own 22dvh scroll box and the target/light
    // lists each their own — which put two or three scrollbars in one sheet.
    // rolo: "why does this break into 2 sets of scrolling sections? too much
    // going on." It is one scrolling document now: the detail flows, then
    // TARGETS, then LIGHTS, all under the body's one scrollbar.
    const body = host.find('study-learn-body')
    assert(
      !body.className.split(/\s+/).includes('study-learn-split'),
      `the LEARN body must no longer carry .study-learn-split, got ${JSON.stringify(body.className)}`,
    )
    assert(cssValue('.study-learn-body', 'overflow-y') === 'auto', 'the body itself is the one scroll region')
    assert(cssValue('.study-learn-detail', 'overflow-y') !== 'auto', 'the detail must NOT be its own scroll box any more')
    assert(cssValue('.study-learn-list', 'overflow-y') !== 'auto', 'the list must NOT be its own scroll box any more')
    // …and the modifier must not ship as a dead selector.
    assert(!/\.study-learn-split\b/.test(stylesSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'styles.css still has a .study-learn-split rule')
    return 'one scroll on the body; detail + lists flow; split rule gone'
  })
})

// A shot that DOES carry a premium-le trim + a deck ref, to check the PREM/LE
// and deck chips render together (isolated fresh mount).
withMountedStudy(fakeAppState(), ({ host }) => {
  test('the deck chip and PREM/LE chip both render for a premium-le deck shot', () => {
    // Step to "Premium Only Shot" (tour index 1), which is NOT a deck shot —
    // step once more to "Deck Shot" (index 2) and check ITS deck chip
    // instead, then separately confirm the PREM/LE chip logic on the actual
    // premium-le shot.
    const nextBtn = host.findAll('study-step-btn')[1]
    nextBtn.dispatchEvent({ type: 'click' }) // -> s-premium (index 1)
    const learnBtn = host.find('study-learn-btn')
    learnBtn.dispatchEvent({ type: 'click' })
    const panel = host.find('study-learn-panel')
    const trimChip = panel.find('study-learn-chip-trim')
    assert(trimChip, 'expected a PREM/LE chip for the premium-le shot')
    assert(trimChip.textContent === 'PREM/LE', `expected chip text "PREM/LE", got ${JSON.stringify(trimChip.textContent)}`)
    assert(
      panel.find('study-learn-notes').textContent === 'No notes yet for this shot.',
      'expected the honest no-notes placeholder for a shot with no authored notes',
    )
  })
})

withMountedStudy(fakeAppState(), ({ host }) => {
  test('the deck (zone) chip names the zone for "Deck Shot"', () => {
    const nextBtn = host.findAll('study-step-btn')[1]
    nextBtn.dispatchEvent({ type: 'click' }) // s-premium
    nextBtn.dispatchEvent({ type: 'click' }) // s-deck
    const learnBtn = host.find('study-learn-btn')
    learnBtn.dispatchEvent({ type: 'click' })
    const panel = host.find('study-learn-panel')
    const chips = panel.findAll('study-learn-chip').map((c) => c.textContent)
    assert(chips.some((t) => t.includes('TEST DECK')), `expected a deck chip naming "TEST DECK", got ${JSON.stringify(chips)}`)
  })
})

// ===========================================================================
section('f. Dismiss via the sheet\'s Back button: sheet closes, shuffle resumes, focus returns')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host, pendingFrameScheduled }) => {
  test('setup: LEARN button focused BEFORE opening, so we can prove focus returns to it', () => {
    // The tour arrives PAUSED (2026-10-14); this section's subject is the
    // RESUME of a running shuffle, so the visitor starts it first.
    host.find('study-readout').dispatchEvent({ type: 'click' })
    assert(pendingFrameScheduled(), 'setup: tapping the readout must start the shuffle')
    const learnBtn = host.find('study-learn-btn')
    learnBtn.focus()
    assert(domActiveElement === learnBtn, 'setup failed: expected the LEARN button to be focused')
  })

  test('opening LEARN pauses the shuffle (no rAF frame pending)', () => {
    const learnBtn = host.find('study-learn-btn')
    learnBtn.dispatchEvent({ type: 'click' })
    assert(!pendingFrameScheduled(), 'expected opening LEARN to cancel the auto-shuffle rAF loop')
  })

  test('tapping Back closes the sheet, resumes the shuffle (rAF rescheduled, readout back to SHUFFLE), and returns focus to the LEARN button', () => {
    const backBtn = host.find('study-learn-back')
    assert(backBtn, 'expected a .study-learn-back element')
    backBtn.dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'expected the sheet panel to be removed')
    assert(!host.find('study-learn-backdrop'), 'expected the sheet backdrop to be removed')
    const sub = host.find('study-readout-sub')
    assert(sub.textContent === 'SHUFFLE · TAP TO PAUSE', `expected the shuffle to resume (SHUFFLE), got ${JSON.stringify(sub.textContent)}`)
    assert(pendingFrameScheduled(), 'expected the auto-shuffle rAF loop to be rescheduled after resuming')
    const learnBtn = host.find('study-learn-btn')
    assert(domActiveElement === learnBtn, 'expected focus to return to the LEARN button (what was focused before the sheet opened)')
  })
})

// ===========================================================================
section('g. Dismiss via tapping the exposed field (the backdrop): same resume contract, different trigger')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host, pendingFrameScheduled }) => {
  test('LEARN -> tapping the backdrop (not the panel) closes the sheet and resumes the shuffle', () => {
    // Started by hand: the tour arrives paused since 2026-10-14.
    host.find('study-readout').dispatchEvent({ type: 'click' })
    const learnBtn = host.find('study-learn-btn')
    learnBtn.dispatchEvent({ type: 'click' })
    const backdrop = host.find('study-learn-backdrop')
    assert(backdrop, 'expected a .study-learn-backdrop element')
    // Only a click whose target IS the backdrop dismisses (matches
    // ui/study.ts's own `ev.target === sheetBackdrop` guard — a click that
    // started on the panel and drifted out must not fire this).
    backdrop.dispatchEvent({ type: 'click', target: backdrop })
    assert(!host.find('study-learn-panel'), 'expected the sheet panel to be removed after a backdrop tap')
    const sub = host.find('study-readout-sub')
    assert(sub.textContent === 'SHUFFLE · TAP TO PAUSE', `expected the shuffle to resume (SHUFFLE), got ${JSON.stringify(sub.textContent)}`)
    assert(pendingFrameScheduled(), 'expected the auto-shuffle rAF loop to be rescheduled')
  })

  test('a click that only DRIFTED across the backdrop (target !== backdrop) does NOT dismiss', () => {
    const learnBtn = host.find('study-learn-btn')
    learnBtn.dispatchEvent({ type: 'click' })
    const backdrop = host.find('study-learn-backdrop')
    const panel = host.find('study-learn-panel')
    backdrop.dispatchEvent({ type: 'click', target: panel }) // target is the PANEL, not the backdrop
    assert(host.find('study-learn-panel'), 'expected the sheet to stay open when the click target was not the backdrop itself')
  })
})

// ===========================================================================
section('h. Stepping ‹ › WHILE the sheet is open updates its content in place (spec\'s default — proven non-janky)')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host }) => {
  test('LEARN on "Top Shot", then › while open: sheet stays open, SAME panel element (no re-triggered entrance animation), body now shows "Mid Left"', () => {
    const learnBtn = host.find('study-learn-btn')
    learnBtn.dispatchEvent({ type: 'click' })
    const panelBefore = host.find('study-learn-panel')
    assert(panelBefore.find('study-learn-title').textContent === 'Top Shot', 'expected the sheet to open on "Top Shot"')

    const nextBtn = host.findAll('study-step-btn')[1]
    nextBtn.dispatchEvent({ type: 'click' }) // -> s-premium
    nextBtn.dispatchEvent({ type: 'click' }) // -> s-deck
    nextBtn.dispatchEvent({ type: 'click' }) // -> s-mid-left

    const panelAfter = host.find('study-learn-panel')
    assert(panelAfter, 'expected the sheet to STILL be open after stepping')
    assert(panelAfter === panelBefore, 'expected the SAME panel element — rebuilding it would replay the slide-up animation on every step')
    assert(
      panelAfter.find('study-learn-title').textContent === 'Mid Left',
      `expected the sheet body to update to "Mid Left", got ${JSON.stringify(panelAfter.find('study-learn-title').textContent)}`,
    )
    const readoutLabel = host.find('study-readout-label')
    assert(readoutLabel.textContent === 'SHOT 4 OF 6', `expected the tour position to have actually moved, got ${JSON.stringify(readoutLabel.textContent)}`)
  })

  test('…and the LIST underneath is not rebuilt by the stepping — same rows, mark moved, current row revealed', () => {
    // The merge's load-bearing half. Rebuilding the body on every step was
    // free when the body WAS the detail; now it would drop 6 row elements, a
    // keyboard user's focus and the list's scroll offset on every ‹ › press.
    const rowsBefore = host.findAll('study-index-row')
    const namesBefore = host.findAll('study-index-name').map((n) => n.textContent)
    const nextBtn = host.findAll('study-step-btn')[1]
    nextBtn.dispatchEvent({ type: 'click' }) // -> s-mid-right (index 4)
    const rowsAfter = host.findAll('study-index-row')
    assert(rowsAfter.length === rowsBefore.length, `the list changed length on a step (${rowsBefore.length} -> ${rowsAfter.length})`)
    for (let i = 0; i < rowsBefore.length; i++) {
      assert(rowsAfter[i] === rowsBefore[i], `row ${i} was REBUILT by a step — focus and scroll position cannot survive that`)
    }
    assert(host.findAll('study-index-name').map((n) => n.textContent).join('|') === namesBefore.join('|'), 'the list contents must not change when only the tour position did')
    const marked = rowsAfter.findIndex((r) => r.className.includes('study-index-row-current'))
    assert(marked === 4, `expected the mark to have moved to row 4, got ${marked}`)
    assert(rowsAfter[4]._scrolls.length > 0, 'the current row must be asked into view after a step')
    assert(rowsAfter[4]._scrolls.at(-1).block === 'nearest', `expected block:'nearest' (scroll only if off-screen), got ${JSON.stringify(rowsAfter[4]._scrolls.at(-1))}`)
    return `6 rows survived, mark on row ${marked}, revealed with ${JSON.stringify(rowsAfter[4]._scrolls.at(-1))}`
  })
})

// REDUCED MOTION removes the SMOOTHNESS, not the scroll — the same rule the
// sheet's own animations follow, applied to the one scroll this tab requests.
withMountedStudy(fakeAppState(), ({ host }) => {
  test('reduced motion: the row is still brought into view, instantly', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    const row = host.findAll('study-index-row')[1]
    assert(row._scrolls.length > 0, 'the feature must survive: the row is still revealed under reduced motion')
    assert(row._scrolls.at(-1).behavior === 'auto', `expected behavior:'auto' under reduced motion, got ${JSON.stringify(row._scrolls.at(-1))}`)
  })
}, { reducedMotion: true })

withMountedStudy(fakeAppState(), ({ host }) => {
  test('…and with motion allowed it is a smooth scroll (so the reduced-motion branch is a real branch)', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    const row = host.findAll('study-index-row')[1]
    assert(row._scrolls.at(-1).behavior === 'smooth', `expected a smooth scroll with motion allowed, got ${JSON.stringify(row._scrolls.at(-1))}`)
  })
})

// ===========================================================================
section("i. Full mount: trim 'pro' excludes the premium-le shot — only 5 dots ever reach the canvas")
// ===========================================================================

withMountedStudy(fakeAppState({ trim: 'pro' }), ({ host, calls }) => {
  test('readout reads "SHOT 1 OF 5" under trim pro', () => {
    const label = host.find('study-readout-label')
    assert(label.textContent === 'SHOT 1 OF 5', `expected "SHOT 1 OF 5", got ${JSON.stringify(label.textContent)}`)
  })

  test('exactly 5 dots are drawn (the premium-le shot never reaches drawShotDots)', () => {
    assert(dotPositions(calls).length === 5, `expected 5 dot arcs under trim pro, got ${dotPositions(calls).length}`)
  })

  test('"Premium Only Shot" is never floated as the current name across a full lap', () => {
    const nextBtn = host.findAll('study-step-btn')[1]
    const seen = new Set(fillTexts(calls))
    for (let i = 0; i < 5; i++) {
      const before = calls.length
      nextBtn.dispatchEvent({ type: 'click' })
      for (const t of fillTexts(calls.slice(before))) seen.add(t)
    }
    assert(!seen.has('Premium Only Shot'), `expected "Premium Only Shot" never drawn under trim pro; saw: ${JSON.stringify([...seen])}`)
  })
})

await rm(tmp, { recursive: true, force: true })

// ===========================================================================
section('j. ui/howto.ts source: Card info gone, Study section present, "Map tab" renamed to "Shots tab"')
// ===========================================================================
const howtoSrc = readFileSync(howtoPath, 'utf8')

test('the old "Check the Card between balls" step is gone', () => {
  assert(!howtoSrc.includes('Check the Card between balls'), 'expected this step title to be removed entirely')
})

test('the intro\'s Card tab bullet ("<b>Card</b> — the at-the-machine brief...") is gone', () => {
  assert(!/<li><b>Card<\/b>/.test(howtoSrc), 'expected no remaining <li><b>Card</b> bullet')
})

test('a new Study step exists, covering HOW IT PLAYS + LEARN (targets & lights) + Shots link + version-aware + deck parts', () => {
  assert(howtoSrc.includes('Learn a machine on the Study tab'), 'expected the new Study step title')
  const idx = howtoSrc.indexOf('Learn a machine on the Study tab')
  const nearby = howtoSrc.slice(idx, idx + 900)
  assert(/tap any dot/i.test(nearby), 'expected the Study step to mention tapping a dot/step')
  assert(/HOW IT PLAYS/.test(nearby), 'expected the Study step to name HOW IT PLAYS (the lead pill)')
  assert(/LEARN/.test(nearby), 'expected the Study step to mention pressing LEARN')
  assert(/TARGET/.test(nearby) && /LIGHT/.test(nearby), 'expected LEARN described as carrying targets AND lights')
  assert(/Shots tab/.test(nearby), 'expected the Study step to mention the link to the Shots tab')
  assert(/MODEL selector/.test(nearby), 'expected the Study step to be version/MODEL-aware')
  assert(/deck/i.test(nearby), 'expected the Study step to mention deck parts')
})

test('the intro tab-list bullet order is Goals, Shots, Study, Achievements', () => {
  const iGoals = howtoSrc.indexOf('<li><b>Goals</b>')
  const iShots = howtoSrc.indexOf('<li><b>Shots</b>')
  const iStudy = howtoSrc.indexOf('<li><b>Study</b>')
  const iAch = howtoSrc.indexOf('<li><b>Achievements</b>')
  assert([iGoals, iShots, iStudy, iAch].every((i) => i !== -1), 'expected all four <li><b>...</b> bullets to be present')
  assert(iGoals < iShots && iShots < iStudy && iStudy < iAch, `expected order Goals < Shots < Study < Achievements, got indices ${JSON.stringify([iGoals, iShots, iStudy, iAch])}`)
})

test('the guide still frames itself as "Four tabs" (owner: keep the four-tab count)', () => {
  assert(howtoSrc.includes('Four tabs across the bottom'), 'expected the "Four tabs across the bottom" intro line to remain')
})

test('no "Map tab" phrasing remains anywhere (renamed to "Shots tab")', () => {
  assert(!/Map tab/.test(howtoSrc), `expected zero remaining "Map tab" occurrences`)
  assert(/Shots tab/.test(howtoSrc), 'expected at least one "Shots tab" occurrence')
})

// ===========================================================================
section('k. ACTION sheet: machine action-button explainer (dataset schema v6)')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host }) => {
  test('dataset WITHOUT actionButton: the ACTION pill mounts hidden (fail-soft, like achievements)', () => {
    const btn = host.find('study-action-btn')
    assert(btn, 'expected a .study-action-btn element')
    assert(btn.hidden === true, 'expected the ACTION pill to be hidden when data.actionButton is absent')
  })
})

{
  const state = fakeAppState()
  state.data.actionButton = {
    present: true,
    label: 'Action Button',
    location: 'center of the lockdown bar',
    how: 'Big red button on the lockdown bar. It fires whatever the game has armed.',
    uses: [
      { when: 'During Smart Missile', what: 'Press to collect every lit shot at once.' },
      { when: 'Video mode', what: 'Tap to fire at the targets.' },
    ],
  }
  withMountedStudy(state, ({ host, pendingFrameScheduled }) => {
    test('present:true — ACTION pill visible; tapping it opens a dialog titled with the label, location chip, how text, and one row per use', () => {
      // The shuffle is started by hand first (the tour arrives paused since
      // 2026-10-14) — the pause/resume test below is about a RUNNING shuffle.
      host.find('study-readout').dispatchEvent({ type: 'click' })
      const btn = host.find('study-action-btn')
      assert(btn.hidden === false, 'expected the ACTION pill to be visible')
      btn.dispatchEvent({ type: 'click' })
      const panel = host.find('study-ab-panel')
      assert(panel, 'expected a .study-ab-panel to be appended')
      assert(panel.getAttribute('role') === 'dialog', 'expected role="dialog"')
      assert(panel.getAttribute('aria-labelledby') === 'study-ab-title', 'expected aria-labelledby="study-ab-title"')
      const title = panel.find('study-learn-title')
      assert(title.textContent === 'Action Button', `expected the label as title, got ${JSON.stringify(title.textContent)}`)
      const chip = panel.find('study-learn-chip')
      assert(chip.textContent === 'CENTER OF THE LOCKDOWN BAR', `expected the uppercased location chip, got ${JSON.stringify(chip.textContent)}`)
      const notes = panel.find('study-learn-notes')
      assert(notes.textContent.startsWith('Big red button'), `expected the how text, got ${JSON.stringify(notes.textContent)}`)
      const rows = panel.findAll('study-ab-use')
      assert(rows.length === 2, `expected 2 use rows, got ${rows.length}`)
      assert(rows[0].find('study-ab-when').textContent === 'During Smart Missile', 'expected the first use\'s when')
      assert(rows[1].find('study-ab-what').textContent === 'Tap to fire at the targets.', 'expected the second use\'s what')
    })

    test('opening ACTION pauses the shuffle; Back closes, resumes SHUFFLE, and the panel/backdrop are removed', () => {
      assert(!pendingFrameScheduled(), 'expected opening ACTION to cancel the auto-shuffle rAF loop')
      const backBtn = host.find('study-learn-back')
      backBtn.dispatchEvent({ type: 'click' })
      assert(!host.find('study-ab-panel'), 'expected the ACTION panel to be removed')
      assert(!host.find('study-learn-backdrop'), 'expected the backdrop to be removed')
      const sub = host.find('study-readout-sub')
      assert(sub.textContent === 'SHUFFLE · TAP TO PAUSE', `expected the shuffle to resume (SHUFFLE), got ${JSON.stringify(sub.textContent)}`)
      assert(pendingFrameScheduled(), 'expected the auto-shuffle rAF loop to be rescheduled after resuming')
    })

    test('ACTION and LEARN are mutually exclusive: opening LEARN closes the ACTION sheet', () => {
      host.find('study-action-btn').dispatchEvent({ type: 'click' })
      assert(host.find('study-ab-panel'), 'setup: expected the ACTION panel open')
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      assert(!host.find('study-ab-panel'), 'expected the ACTION panel to close when LEARN opens')
      const learnPanel = host.find('study-learn-panel')
      assert(learnPanel && !learnPanel.className.includes('study-ab-panel'), 'expected the LEARN panel to be the one open')
    })
  })
}

{
  const state = fakeAppState()
  state.data.actionButton = {
    present: false,
    label: null,
    location: null,
    how: 'No action button on this one — flippers, plunger, and nudging are the whole interface.',
    uses: [],
  }
  withMountedStudy(state, ({ host }) => {
    test('present:false — sheet still opens, titled "No Action Button", with the how line and NO uses list', () => {
      const btn = host.find('study-action-btn')
      assert(btn.hidden === false, 'expected the ACTION pill to be visible for present:false too — absence is still an answer')
      btn.dispatchEvent({ type: 'click' })
      const panel = host.find('study-ab-panel')
      assert(panel, 'expected the ACTION panel to open')
      const title = panel.find('study-learn-title')
      assert(title.textContent === 'No Action Button', `expected "No Action Button", got ${JSON.stringify(title.textContent)}`)
      assert(panel.find('study-learn-notes'), 'expected the how text to render')
      assert(!panel.find('study-ab-uses'), 'expected no uses list')
      assert(!panel.find('study-learn-chip'), 'expected no location chip')
    })
  })
}

// ===========================================================================
section('l. Phone-canvas geometry (P3): the ‹ › bar must not cover, or swallow taps on, the canvas')
// ===========================================================================
// These four fixes are invisible in a unit test that only checks behaviour —
// they are all LAYOUT, spread across a .ts constant, five CSS rules and an
// HTML meta tag, and every one of them regresses silently. So they are pinned
// at the source, and the headline check derives the drawn card's real bottom
// edge from the REAL recorded canvas calls rather than re-deriving the
// formula it is supposed to be checking.

// Lazy + memoized on purpose: pillHeight/barTop THROW when the CSS they read
// stops saying what they need (that is the check). Evaluating them at module
// scope would abort the whole file with a bare stack trace instead of failing
// the tests that depend on them, and would take the unrelated ones down too.
const memo = (fn) => {
  let value
  let done = false
  return () => {
    if (!done) {
      value = fn()
      done = true
    }
    return value
  }
}
const studyPill = memo(() => pillHeight('.study-readout', ['.study-readout-label', '.study-readout-sub']))
const mapPill = memo(() => pillHeight('.map-step-readout', ['.map-step-readout-meta', '.map-step-readout-label', '.map-step-readout-sub']))
const studyBar = memo(() => barTop(H, '.study-controls', '.study-step-btn', studyPill()))

test('both readout pills are pinned SHORTER than the 44px buttons beside them (all five line-heights explicit, not `normal`)', () => {
  const STUDY_PILL_PX = studyPill()
  const MAP_PILL_PX = mapPill()
  // A pill taller than the buttons grows the bottom-anchored bar UPWARD, past
  // the strip BOTTOM_CLEARANCE/CONTROLS_CLEARANCE reserved — the failure mode
  // `line-height: normal` (a per-platform mono font metric, ~1.2 to ~1.45)
  // makes untestable and platform-dependent. pillHeight() throws if any of
  // the five stops declaring it, or declares it before the `font:` shorthand
  // that resets it.
  assert(STUDY_PILL_PX <= 44, `.study-readout computes to ${STUDY_PILL_PX}px, taller than the 44px buttons`)
  assert(MAP_PILL_PX <= 44, `.map-step-readout computes to ${MAP_PILL_PX}px, taller than the 44px buttons`)
  for (const sel of ['.map-step-readout-meta', '.map-step-readout-label', '.map-step-readout-sub', '.study-readout-label', '.study-readout-sub']) {
    assert(cssValue(sel, 'line-height') === '1.2', `${sel} line-height is ${JSON.stringify(cssValue(sel, 'line-height'))}, expected "1.2"`)
  }
  return `study pill ${STUDY_PILL_PX}px, map pill ${MAP_PILL_PX.toFixed(1)}px — both under 44`
})

test("the Study card's drawn bottom edge clears the .study-controls bar", () => {
  const bar = studyBar()
  // The card rect is recovered from TWO real dot positions rather than
  // re-computing playfieldRect: map(u,v).y = rect.y + rect.h - v*rect.h, so
  // the top-of-tour shot (v=0.9) and the bottom-of-tour shot (v=0.1) pin
  // rect.y and rect.h exactly. Nothing here duplicates study.ts's math.
  let dots = null
  withMountedStudy(fakeAppState(), ({ calls }) => {
    dots = dotPositions(calls)
  })
  assert(dots.length === 6, `expected 6 recorded dots, got ${dots.length}`)
  const yTop = dots[0].y // s-top,    shot.y 0.9
  const yBottom = dots[5].y // s-bottom, shot.y 0.1
  const rectH = (yBottom - yTop) / 0.8
  const cardBottom = yTop - 0.1 * rectH + rectH
  assert(
    cardBottom <= bar.top,
    `the drawn card's bottom edge is y=${cardBottom} but the controls bar's top edge is y=${bar.top} — ` +
      `the bar covers the bottom ${(cardBottom - bar.top).toFixed(1)}px of the playfield (the flippers/drain, ` +
      `where shots sit at v ~ 0.01-0.05), and eats their taps. Raise BOTTOM_CLEARANCE in ui/study.ts.`,
  )
  assert(
    bar.top - cardBottom <= 12,
    `the card stops ${(bar.top - cardBottom).toFixed(1)}px above the bar — clear, but that is wasted playfield ` +
      `("the bottom should almost touch the buttons"). Lower BOTTOM_CLEARANCE in ui/study.ts.`,
  )
  return `bar: bottom:${bar.bottom} + ${bar.height}px tall -> top y=${bar.top}; card bottom y=${cardBottom} — ${(bar.top - cardBottom).toFixed(1)}px clear (H=${H})`
})

test('every readout line clears 4.5:1 AA — measured THROUGH the dot-matrix texture, not against the flat pill', () => {
  // K3 fast-follow #4 (2026-08-14). BACKGLASS put a DMD dot-matrix overlay on
  // the readout pills' ground. The review asked whether the texture pushes the
  // 8/9px meta/sub lines under AA, and if so to exempt them from it.
  //
  // MEASURED ANSWER: the texture is not the problem. It costs 0.01-0.11 of
  // contrast ratio. What the measurement DID find is that the map pill's meta
  // line was at 3.42:1 on the flat pill — under AA already, and under it since
  // before the reskin (the pre-BACKGLASS rule carried the same 0.4 alpha in
  // the old warm ink). Exempting it from the texture would have moved it to
  // 3.42 and fixed nothing. Raising its alpha to --text-muted (0.5) fixes it.
  //
  // So this test pins the thing that actually matters — the COMPUTED contrast
  // of every line, through the texture — rather than the presence or absence
  // of an overlay.
  const srgb = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
    return (hi + 0.05) / (lo + 0.05)
  }
  const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha))
  /** rgba(...) or a 6-digit hex — --text resolves to #e9edf7, the dim/muted
   *  tokens to rgba(). Both spellings appear among the five lines. */
  const rgba = (v) => {
    if (!v) return null
    const hex = /^#([0-9a-f]{6})$/i.exec(v.trim())
    if (hex) {
      const h = hex[1]
      return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 }
    }
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(v)
    if (!m) return null
    return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) }
  }
  /** A token's value from styles.css :root. */
  const token = (name) => {
    const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(stylesSrc)
    return m ? m[1].trim() : null
  }
  const resolve1 = (v) => (v && v.startsWith('var(') ? token(/var\((--[\w-]+)\)/.exec(v)[1]) : v)

  // WORST CASE, deliberately: the pill is translucent glass, so its effective
  // background is its own fill composited over whatever is behind it. The
  // LIGHTEST thing behind it is the playfield gradient's light stop, which is
  // the worst case for light text. A darker backdrop only raises contrast.
  const pfLight = [0x0e, 0x2b, 0x52] // --card-gradient-b
  const glass = rgba(token('--glass-bg-strong'))
  assert(glass, '--glass-bg-strong must be an rgba() for this measurement')
  const pill = over(glass.rgb, glass.a, pfLight)
  const dotMatrix = rgba(token('--dotmatrix'))
  assert(dotMatrix, '--dotmatrix must carry an rgba() for this measurement')
  const textured = over(dotMatrix.rgb, dotMatrix.a, pill)

  const LINES = [
    ['.map-step-readout-meta', 8],
    ['.map-step-readout-label', 12],
    ['.map-step-readout-sub', 9],
    ['.study-readout-label', 17],
    ['.study-readout-sub', 10],
  ]
  const rows = []
  for (const [sel, px] of LINES) {
    const raw = resolve1(cssValue(sel, 'color'))
    const c = rgba(raw)
    assert(c, `${sel}'s color (${raw}) did not resolve to an rgba() this measurement can read`)
    const inkOnTexture = over(c.rgb, c.a, textured)
    const r = ratio(inkOnTexture, textured)
    // Every one of these is small text (well under 18pt / 14pt bold), so the
    // AA threshold is 4.5:1 with no large-text exemption available.
    assert(
      r >= 4.5,
      `${sel} (${px}px) computes to ${r.toFixed(2)}:1 through the dot-matrix texture, under the 4.5:1 AA floor for text this size. ` +
        `NOTE: the texture is worth ~0.1 of this — check the line's own alpha first.`,
    )
    rows.push(`${sel.replace('.map-step-readout-', 'map ').replace('.study-readout-', 'study ')} ${r.toFixed(2)}`)
  }
  return `through the texture: ${rows.join(', ')} (all >= 4.5:1)`
})

test('ui/study.ts BOTTOM_CLEARANCE is >= 16, and its comment still describes the real CSS', () => {
  const clearance = tsConst(studySrc, 'BOTTOM_CLEARANCE', 'ui/study.ts')
  assert(clearance >= 16, `BOTTOM_CLEARANCE is ${clearance}; below 16 the card is drawn under the bar at every viewport height (it was 10 until 2026-08-14)`)
  const bar = studyBar()
  const doc = studySrc.slice(0, studySrc.indexOf('const BOTTOM_CLEARANCE')).split('/** Clearance above').pop()
  assert(
    doc.includes(`${bar.height}px bar at bottom:${bar.bottom}px`),
    `BOTTOM_CLEARANCE's doc comment no longer matches styles.css (.study-controls is now ${bar.height}px tall at bottom:${bar.bottom}px)`,
  )
  return `BOTTOM_CLEARANCE = ${clearance}`
})

test('.study-controls uses the pass-through recipe, and EVERY control it actually mounts takes pointer events back', () => {
  // Without this the full-width strip pinned over the canvas eats
  // tap-to-inspect (section c/d's clicks) everywhere in the bottom band,
  // including the gaps between the three controls. .map-step-controls has had
  // the recipe since it was written; .study-controls, a "standalone copy" of
  // it, was missing it entirely.
  assert(cssValue('.study-controls', 'pointer-events') === 'none', `.study-controls pointer-events is ${JSON.stringify(cssValue('.study-controls', 'pointer-events'))}, expected "none"`)
  let mounted = []
  withMountedStudy(fakeAppState(), ({ host }) => {
    const bar = host.find('study-controls')
    assert(bar, 'expected a .study-controls element')
    mounted = [...new Set(bar.children.map((c) => c.className.trim()).filter(Boolean))]
  })
  assert(mounted.length > 0, 'expected .study-controls to have children')
  for (const cls of mounted) {
    const sel = `.${cls.split(/\s+/)[0]}`
    assert(
      cssValue(sel, 'pointer-events') === 'auto',
      `${sel} is a child of the pass-through .study-controls but never sets pointer-events:auto — it is mounted but untappable`,
    )
  }
  return `${mounted.length} controls, all auto: ${mounted.join(', ')}`
})

test('index.html lets people pinch-zoom (no user-scalable=no / maximum-scale)', () => {
  const meta = /<meta\s+name="viewport"[^>]*content="([^"]*)"/.exec(indexHtmlSrc)
  assert(meta, 'expected a <meta name="viewport" content="..."> in app/index.html')
  const content = meta[1]
  assert(/width=device-width/.test(content), `expected width=device-width, got ${JSON.stringify(content)}`)
  assert(!/user-scalable\s*=\s*no/.test(content), `viewport still blocks zoom with user-scalable=no: ${JSON.stringify(content)} (WCAG 2.1 SC 1.4.4 — and there are no pinch/gesture handlers for it to protect)`)
  assert(!/maximum-scale/.test(content), `viewport still caps zoom with maximum-scale: ${JSON.stringify(content)}`)
  return content
})

test('nothing in src/ registers a pinch/gesture/touchmove handler — the reason the zoom lock was removable', () => {
  // If this ever starts failing, the viewport change above needs re-thinking
  // rather than the handler being deleted: a real gesture handler is the only
  // thing user-scalable=no was ever protecting.
  const offenders = []
  for (const [name, src] of [['ui/study.ts', studySrc], ['overlay/map2d.ts', readFileSync(map2dPath, 'utf8')]]) {
    for (const ev of ['gesturestart', 'gesturechange', 'touchmove', 'touchstart']) {
      if (src.includes(`'${ev}'`)) offenders.push(`${name}: ${ev}`)
    }
  }
  assert(offenders.length === 0, `found gesture handlers on the canvases: ${offenders.join(', ')}`)
  return 'canvases listen for plain click only'
})

// ===========================================================================
section('m. LEARN <-> ACTION BUTTON switching (P4 addendum): swap in place, never replay the slide')
// ===========================================================================
// THE REPORTED BUG (owner, 2026-08-14): the ACTION sheet's motion is "really
// jumpy and kinda weird". The cause was mechanical, and so is this pin — each
// sheet's open() used to close the other, so a switch REMOVED the panel and
// inserted a new one, which replays `.study-learn-panel`'s 0.25s studySheetUp
// entrance from off-screen. A fake DOM cannot see an animation, but it can see
// the thing that triggers one: whether the panel ELEMENT survived the switch.
// That identity check is the whole test.
{
  const state = fakeAppState()
  state.data.actionButton = {
    present: true,
    label: 'Action Button',
    location: 'lockdown bar',
    how: 'Big red button on the lockdown bar.',
    uses: [{ when: 'During Smart Missile', what: 'Press to collect every lit shot at once.' }],
  }

  withMountedStudy(state, ({ host }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const learnPanel = host.find('study-learn-panel')
    const learnBackdrop = host.find('study-learn-backdrop')
    const learnBody = host.find('study-learn-body')
    host.find('study-action-btn').dispatchEvent({ type: 'click' })

    test('switching LEARN -> ACTION BUTTON keeps the SAME panel element (so the entrance animation cannot replay)', () => {
      const nowPanel = host.find('study-learn-panel')
      assert(nowPanel === learnPanel, 'the panel element was recreated — that is exactly what replays the slide-up')
      assert(host.find('study-learn-backdrop') === learnBackdrop, 'the backdrop was recreated too')
      assert(host.findAll('study-learn-panel').length === 1, 'expected exactly one sheet panel on screen')
    })

    test('…and it is now the ACTION sheet: class, aria-labelledby and content all switched', () => {
      assert(learnPanel.className.split(/\s+/).includes('study-ab-panel'), `expected the ab class, got ${JSON.stringify(learnPanel.className)}`)
      assert(learnPanel.getAttribute('aria-labelledby') === 'study-ab-title', 'expected aria-labelledby to follow the content')
      assert(learnPanel.find('study-learn-title').textContent === 'Action Button', 'expected the ACTION content')
      assert(learnPanel.findAll('study-ab-use').length === 1, 'expected the use rows')
    })

    test('the BODY element is replaced (and carries the fade class) — that is what makes the 120ms crossfade play on insertion', () => {
      const nowBody = host.find('study-learn-body')
      assert(nowBody !== learnBody, 'expected a NEW body element — a CSS animation only runs on insertion')
      assert(nowBody.className.split(/\s+/).includes('study-learn-body-swap'), `expected the swap class, got ${JSON.stringify(nowBody.className)}`)
      assert(nowBody.parentElement === learnPanel, 'expected the new body inside the surviving panel')
      return nowBody.className
    })

    test('switching BACK to LEARN swaps in place too, and drops the ab class again', () => {
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      const nowPanel = host.find('study-learn-panel')
      assert(nowPanel === learnPanel, 'expected the same panel element on the way back')
      assert(!nowPanel.className.split(/\s+/).includes('study-ab-panel'), 'expected the ab class to come off')
      assert(nowPanel.getAttribute('aria-labelledby') === 'study-learn-title', 'expected the LEARN label id back')
      assert(nowPanel.find('study-learn-title').textContent === 'Top Shot', 'expected the current tour shot again')
    })

    test('a swap does NOT re-pause or re-resume the tour, and does not move focus a second time', () => {
      const sub = host.find('study-readout-sub')
      assert(sub.textContent === 'PAUSED · TAP FOR AUTO', `a sheet is open, so the readout must say paused; got ${JSON.stringify(sub.textContent)}`)
      assert(domActiveElement === host.find('study-learn-back'), 'focus should still be on the one Back button, not bounced through the pill')
    })

    test('Back still closes whatever kind is showing, once', () => {
      host.find('study-learn-back').dispatchEvent({ type: 'click' })
      assert(!host.find('study-learn-panel'), 'expected the sheet to close')
      assert(!host.find('study-learn-backdrop'), 'expected the backdrop to go with it')
    })
  })

  // REDUCED MOTION: the swap still happens, it just arrives instantly. The
  // house rule is that a reduced-motion path removes MOTION, never the
  // feature — a swap that silently stopped swapping would be the bug.
  withMountedStudy(
    state,
    ({ host }) => {
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      const panel = host.find('study-learn-panel')
      const body = host.find('study-learn-body')
      host.find('study-action-btn').dispatchEvent({ type: 'click' })

      test('prefers-reduced-motion: the content STILL swaps (feature intact) but the fade class is not applied (motion gone)', () => {
        const nowBody = host.find('study-learn-body')
        assert(nowBody !== body, 'the body must still be replaced — reduced motion removes motion, not the feature')
        assert(host.find('study-learn-panel') === panel, 'still an in-place swap')
        assert(!nowBody.className.split(/\s+/).includes('study-learn-body-swap'), `expected NO fade class under reduced motion, got ${JSON.stringify(nowBody.className)}`)
        assert(panel.find('study-learn-title').textContent === 'Action Button', 'expected the ACTION content to be there')
        assert(panel.style.height === undefined || panel.style.height === '', 'no inline height dance under reduced motion')
      })
    },
    { reducedMotion: true },
  )
}

test('the entrance animates TRANSFORM ONLY — the one candidate cause of jank this fix did NOT need to touch', () => {
  const frames = /@keyframes studySheetUp\s*\{([\s\S]*?)\n\}/.exec(stylesSrc)
  assert(frames, 'no @keyframes studySheetUp block in styles.css')
  const props = [...frames[1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
  assert(props.length > 0, 'the keyframes declare nothing at all')
  assert(props.every((p) => p === 'transform'), `studySheetUp animates ${JSON.stringify([...new Set(props)])} — layout properties are not compositor-safe here`)
  return `animates ${[...new Set(props)].join(', ')} only`
})

test('the swap fade + panel height transition are both behind prefers-reduced-motion', () => {
  const reduced = stylesSrc.slice(stylesSrc.indexOf('@media (prefers-reduced-motion: reduce)', stylesSrc.indexOf('.study-learn-panel')))
  assert(/\.study-learn-panel\s*\{[^}]*animation:\s*none/.test(reduced), 'the panel entrance is not disabled under reduced motion')
  assert(/\.study-learn-panel\s*\{[^}]*transition:\s*none/.test(reduced), 'the panel HEIGHT transition is not disabled under reduced motion')
  assert(/\.study-learn-body-swap\s*\{[^}]*animation:\s*none/.test(reduced), 'the swap fade is not disabled under reduced motion')
})

// ===========================================================================
section('n. The ACTION BUTTON pill (P4 addendum): label + co-equal weight')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host }) => {
  test("the pill reads 'ACTION BUTTON', and its aria-label still CONTAINS that visible text (WCAG 2.5.3)", () => {
    const btn = host.find('study-action-btn')
    assert(btn.textContent === 'ACTION BUTTON', `expected "ACTION BUTTON", got ${JSON.stringify(btn.textContent)}`)
    const label = btn.getAttribute('aria-label')
    assert(label && label.toLowerCase().includes('action button'), `aria-label ${JSON.stringify(label)} must contain the visible label`)
    return `"${btn.textContent}" / aria-label "${label}"`
  })

  test('the guide describes it by the same name (a guide naming a control that does not exist is worse than no guide)', () => {
    const howtoSrc = readFileSync(howtoPath, 'utf8')
    assert(howtoSrc.includes('Press ACTION BUTTON'), 'ui/howto.ts still tells people to press "ACTION"')
  })
})

test('the pill is now CO-EQUAL with LEARN: same solid amber fill + on-amber ink, no dim variant left', () => {
  const fill = cssValue('.study-action-btn', 'background')
  const ink = cssValue('.study-action-btn', 'color')
  assert(fill === 'var(--amber)', `expected var(--amber) fill, got ${JSON.stringify(fill)}`)
  assert(ink === 'var(--text-on-amber)', `expected var(--text-on-amber) ink, got ${JSON.stringify(ink)}`)
  assert(cssValue('.study-learn-btn', 'background') === fill, 'LEARN and ACTION BUTTON must carry the SAME fill to be co-equal')
  assert(cssValue('.study-learn-btn', 'color') === ink, 'LEARN and ACTION BUTTON must carry the same ink')
  assert(cssValue('.study-action-btn', 'border') === null, 'the dim variant’s border should be gone — LEARN has none')
  return `${fill} on ${ink}, matching .study-learn-btn`
})

test('and every pill is still 36px tall, which is what the rail\'s own geometry is derived from', () => {
  const h = cssValue('.study-action-btn', 'height')
  assert(h === cssValue('.study-learn-btn', 'height'), `pill heights differ: ${h} vs ${cssValue('.study-learn-btn', 'height')}`)
  assert(h === '36px', `expected 36px pills, got ${h}`)
  assert(/box-sizing:\s*border-box/.test(stylesSrc), 'the border-drop claim above depends on global border-box sizing')
  return `pills 36px each`
})

// ===========================================================================
section('o. ONE standard sheet height, ONE motion — the pin, the timer and their four races are gone')
// ===========================================================================
// WHAT THIS SECTION REPLACED, and why the replacement is smaller. It used to
// pin six tests on a pinned-height TIMER: swapSheetBody measured the panel,
// set an inline height, transitioned to the new one, and cleared the pin on a
// setTimeout that raced in four directions (switch-switch cleared the live
// transition mid-flight; switch-close and switch-destroy fired against a
// detached panel; switch-step left the new body clipped). Those tests were
// correct and they all passed — they were testing that a complicated thing
// was correctly owned.
//
// The panel is now ONE FIXED HEIGHT for both kinds (styles.css
// .study-learn-panel), so it never resizes: there is nothing to animate,
// nothing to pin, and no timer to own. Every one of those four races is now
// unreachable because the state they raced over does not exist. So the tests
// below do not check that the timer is well-behaved — they check that NO
// TIMER AND NO INLINE HEIGHT EXIST AT ALL, on every path that used to make
// one. That is a stronger claim and a much shorter one.

/** The panel's inline height. MUST always be null now: nothing sets one. */
function inlineHeight(host) {
  const h = host.find('study-learn-panel')?.style.height
  return h === undefined || h === '' ? null : h
}

function actionState() {
  const state = fakeAppState()
  state.data.actionButton = {
    present: true,
    label: 'Action Button',
    location: 'lockdown bar',
    how: 'Big red button on the lockdown bar. It fires whatever the game has armed.',
    uses: [
      { when: 'During Smart Missile', what: 'Press to collect every lit shot at once.' },
      { when: 'Video mode', what: 'Tap to fire at the targets.' },
    ],
  }
  return state
}

test('the panel declares ONE height for both kinds — no max-height, no height transition', () => {
  // The CSS is the whole mechanism now, so it is pinned directly. A
  // `max-height` returning would bring back the variable size the timer
  // existed to paper over.
  const height = cssValue('.study-learn-panel', 'height')
  assert(height, '.study-learn-panel must declare an explicit height — that is what makes both sheets one size')
  assert(/dvh|vh|px/.test(height), `expected a real length for the panel height, got ${JSON.stringify(height)}`)
  assert(
    cssValue('.study-learn-panel', 'max-height') === null,
    'a max-height means the panel is content-sized again, which is exactly the variable height this change removed',
  )
  // No `transition` in ANY rule naming this panel (cssRuleBodies walks the
  // @media blocks too, so this covers the reduced-motion copy as well).
  for (const body of cssRuleBodies('.study-learn-panel')) {
    assert(!/transition\s*:/.test(body), `the height transition must be gone, found it in: ${body.trim()}`)
  }
  // And the body must be able to SCROLL inside that fixed panel rather than
  // pushing it taller — `min-height: 0` is load-bearing on a flex child.
  assert(cssValue('.study-learn-body', 'overflow-y') === 'auto', 'the body must scroll when content exceeds the fixed panel')
  assert(cssValue('.study-learn-body', 'flex') === '1', 'the body must take the panel’s remaining space')
  assert(
    cssValue('.study-learn-body', 'min-height') === '0',
    'without min-height:0 a flex child refuses to shrink below its content, so a long ACTION list would push the panel past its own height instead of scrolling',
  )
  return `height ${height}, no max-height, no transition; body flex:1 min-height:0 overflow-y:auto`
})

test('the one motion is the open slide — and reduced motion removes exactly that, nothing else', () => {
  // cssRuleBodies returns every rule naming the selector IN SOURCE ORDER,
  // including the copy inside @media (prefers-reduced-motion), so read the
  // two ends rather than the cascaded value (which would just report the
  // media block's `none` and prove nothing about the default).
  const bodies = cssRuleBodies('.study-learn-panel')
  assert(bodies.length >= 2, `expected a base rule plus a reduced-motion rule, got ${bodies.length}`)
  assert(/animation:[^;]*studySheetUp/.test(bodies[0]), `expected the studySheetUp slide in the base rule, got ${bodies[0].trim()}`)
  assert(/animation:\s*none/.test(bodies[bodies.length - 1]), 'reduced motion must still cancel the slide')
  const swapBodies = cssRuleBodies('.study-learn-body-swap')
  assert(/animation:\s*none/.test(swapBodies[swapBodies.length - 1]), 'reduced motion must still cancel the content cross-fade')
  return 'open = studySheetUp only; reduced motion cancels the slide and the swap fade'
})

withMountedStudy(actionState(), ({ host, advanceTimers, pendingTimerCount }) => {
  test('a swap schedules NO timer and pins NO height — the mechanism is gone, not merely well-owned', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(pendingTimerCount() === 0, 'a fresh open must schedule nothing')
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    assert(inlineHeight(host) === null, `a swap must not set an inline height, got ${inlineHeight(host)}`)
    assert(pendingTimerCount() === 0, `a swap must schedule no timer, got ${pendingTimerCount()}`)
    advanceTimers(500)
    assert(inlineHeight(host) === null, 'and nothing appears later either')
    assert(pendingTimerCount() === 0, 'still nothing scheduled')
    return 'open + swap: 0 timers, 0 inline heights, before and after 500ms'
  })
})

withMountedStudy(actionState(), ({ host, advanceTimers, pendingTimerCount }) => {
  test('SWITCH SPAM (four taps in one tick) — the case that used to race hardest — schedules nothing at all', () => {
    for (const id of ['study-learn-btn', 'study-action-btn', 'study-learn-btn', 'study-action-btn']) {
      host.find(id).dispatchEvent({ type: 'click' })
      assert(pendingTimerCount() === 0, `tap on ${id} scheduled a timer (${pendingTimerCount()})`)
      assert(inlineHeight(host) === null, `tap on ${id} pinned a height (${inlineHeight(host)})`)
    }
    // The panel must still be showing ACTION, i.e. the spam did not lose the
    // last press.
    assert(host.find('study-ab-panel') || host.find('study-ab-uses'), 'expected the ACTION body after the last tap')
    advanceTimers(500)
    assert(pendingTimerCount() === 0, 'nothing fired late')
    return '4 switches in one tick: 0 timers, 0 pins, last press wins'
  })
})

withMountedStudy(actionState(), ({ host, advanceTimers, pendingTimerCount }) => {
  test('SWITCH-THEN-CLOSE and SWITCH-THEN-STEP leave nothing behind (the detached-panel and clipped-body races)', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' }) // ›
    // ONE timer is expected here as of the P8 review, and it is not the
    // pinned-height timer this section buried — that one measured layout and
    // raced four ways. This is the live region's coalescing window: it touches
    // one text node, no layout, no focus and no DOM structure, and the step
    // that opened it is a tour move, which is exactly what it exists for.
    // Pinned as EXACTLY ONE rather than waived, so a second timer arriving on
    // this path still fails.
    assert(pendingTimerCount() === 1, `stepping should leave exactly the announce window, got ${pendingTimerCount()} timers`)
    assert(inlineHeight(host) === null, 'stepping after a swap must leave no pinned height')
    host.find('study-learn-back').dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'setup: the sheet closed')
    assert(pendingTimerCount() === 0, 'a closed sheet must leave NO timer behind — closeStudySheet cancels the announce window with the region it writes to')
    advanceTimers(500) // would have thrown against a detached node in the old design
    assert(!host.find('study-learn-panel'), 'still closed, still no error')
    return 'switch -> step -> close: the announce window and nothing else, cancelled on close; 0 pins throughout'
  })
})

{
  // destroy() (tab teardown) mid-interaction — the fourth old race.
  let leaked = null
  withMountedStudy(actionState(), ({ host, pendingTimerCount }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    leaked = pendingTimerCount // captured; withMountedStudy calls destroy() on the way out
  })
  test('destroy() has no swap timer left to clear — a torn-down tab schedules nothing against a dead closure', () => {
    assert(leaked !== null, 'setup did not run')
    assert(leaked() === 0, `expected 0 timers after destroy(), got ${leaked()}`)
  })
}

withMountedStudy(actionState(), ({ host }) => {
  test('the swap still works: SAME panel node across a switch (no re-slide) + the fresh body carries the fade class', () => {
    // This is the behaviour the deleted machinery was protecting, so it has
    // to be re-proven against the simpler implementation.
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const panelBefore = host.find('study-learn-panel')
    const bodyBefore = host.find('study-learn-body')
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    const panelAfter = host.find('study-learn-panel')
    const bodyAfter = host.find('study-learn-body')
    assert(panelAfter === panelBefore, 'the panel must be the SAME node across a swap — a new node replays the slide-up')
    assert(bodyAfter !== bodyBefore, 'the body must be a NEW node, which is what makes the 120ms fade play on insertion')
    assert(
      String(bodyAfter.className).includes('study-learn-body-swap'),
      `expected the fade class on the fresh body, got ${JSON.stringify(String(bodyAfter.className))}`,
    )
    return 'panel node identical, body node replaced and carrying study-learn-body-swap'
  })
})


// ===========================================================================
section('p. Sheet focus + LEARN stepping (P4 review): nothing is stranded, nothing regressed')
// ===========================================================================

withMountedStudy(actionState(), ({ host, doc }) => {
  test('the Back button lives OUTSIDE the swapped body, so a swap cannot destroy the element the user is focused on', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const back = host.find('study-learn-back')
    const body = host.find('study-learn-body')
    // P8 moved Back from being a DIRECT child of the panel into the sheet's
    // header row (.study-sheet-head), which also holds the in-sheet ‹ ›. The
    // contract this test exists for is unchanged and is asserted directly
    // rather than through a parent-identity proxy: Back must be inside the
    // PANEL and outside the BODY, because the body is the thing swapSheetBody
    // throws away on a kind switch.
    assert(descends(host.find('study-learn-panel'), back), 'Back must live inside the sheet PANEL')
    assert(!descends(body, back), 'Back must not be inside the swapped body')
    assert(!body.findAll('study-learn-back').length, 'Back must not be inside the swapped body')
    assert(domActiveElement === back, 'setup: focus starts on Back')
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-learn-back') === back, 'the Back button element must survive the swap')
    assert(domActiveElement === back, 'focus must still be on that same button after the swap')
  })

  test('and if focus WERE inside the body when it is swapped, it is re-homed to Back rather than dropped', () => {
    // Simulates the future in which a LEARN/ACTION body grows a link: focus
    // something inside the body, swap, and the sheet must still own focus.
    const bodyChild = host.find('study-learn-body').children[0]
    bodyChild.focus()
    assert(domActiveElement === bodyChild, 'setup: focus inside the body')
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(domActiveElement === host.find('study-learn-back'), 'focus was left on a destroyed node instead of re-homed')
  })

  test('exactly ONE document Escape listener exists while a sheet is open, whatever kind it is showing', () => {
    assert(doc._listenerCount('keydown') === 1, `expected 1 keydown listener, got ${doc._listenerCount('keydown')}`)
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    assert(doc._listenerCount('keydown') === 1, 'a swap must not register a second listener')
  })

  test('Escape closes the merged sheet, and a second Escape is inert (the listener is really gone)', () => {
    doc._fireKey('Escape')
    assert(!host.find('study-learn-panel'), 'expected Escape to close the sheet')
    assert(doc._listenerCount('keydown') === 0, 'expected the Escape listener torn down with the sheet')
    doc._fireKey('Escape') // must be a no-op, not a throw or a second teardown
    assert(!host.find('study-learn-panel'), 'still closed')
  })
})

withMountedStudy(actionState(), ({ host }) => {
  test('STEPPING does not route through the swap path: same body element, no fade class, no per-step teardown', () => {
    // Shuffle started by hand (the tour arrives paused since 2026-10-14): the
    // last test in this block is about restoring a RUNNING shuffle on close.
    host.find('study-readout').dispatchEvent({ type: 'click' })
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const body = host.find('study-learn-body')
    const back = host.find('study-learn-back')
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    const after = host.find('study-learn-body')
    assert(after === body, 'stepping replaced the body element — that would replay the 120ms fade on every ‹ › press')
    assert(!after.className.split(/\s+/).includes('study-learn-body-swap'), 'stepping must not add the swap/fade class')
    assert(host.find('study-learn-back') === back, 'the stepper must not tear down the Back button')
  })

  test('the LEARN sheet still follows the tour while stepping (content actually changed)', () => {
    const title = host.find('study-learn-title').textContent
    assert(title === 'Premium Only Shot', `expected the 2nd tour shot after one ›, got ${JSON.stringify(title)}`)
  })

  test('LEARN -> ACTION -> LEARN preserves the tour position (the step index is not reset by a switch)', () => {
    const labelBefore = host.find('study-readout-label').textContent
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === labelBefore, `readout moved: ${labelBefore} -> ${host.find('study-readout-label').textContent}`)
    assert(host.find('study-learn-title').textContent === 'Premium Only Shot', 'expected the SAME shot back, not a reset to shot 1')
    return `${labelBefore} across LEARN -> ACTION -> LEARN`
  })

  test('the readout keeps telling the truth across a switch: PAUSED while EITHER kind is open, never a stale SHUFFLE', () => {
    const sub = host.find('study-readout-sub')
    assert(sub.textContent === 'PAUSED · TAP FOR AUTO', `expected PAUSED with a sheet open, got ${JSON.stringify(sub.textContent)}`)
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    // Before this phase, opening ACTION never called updateControls() at all,
    // so the readout went on claiming SHUFFLE while the tour was actually
    // frozen behind the sheet. That is the stale leak this pins.
    assert(sub.textContent === 'PAUSED · TAP FOR AUTO', 'the ACTION sheet pauses the tour too — the readout must say so')
  })

  test('closing restores the mode the tour had BEFORE the sheet opened (auto here — stepping inside the sheet is navigation, not a pause command)', () => {
    host.find('study-learn-back').dispatchEvent({ type: 'click' })
    const sub = host.find('study-readout-sub')
    assert(sub.textContent === 'SHUFFLE · TAP TO PAUSE', `expected the pre-sheet auto mode back, got ${JSON.stringify(sub.textContent)}`)
  })
})

withMountedStudy(actionState(), ({ host, pendingFrameScheduled }) => {
  test('…and the other direction: a tour PAUSED before the sheet opened is still paused after a LEARN/ACTION round trip', () => {
    const readout = host.find('study-readout')
    // Arrives paused (2026-10-14); start it and pause it again, so the pause
    // under test is a DELIBERATE one made by the control that owns it.
    readout.dispatchEvent({ type: 'click' }) // manual -> auto
    readout.dispatchEvent({ type: 'click' }) // auto -> manual
    assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', 'setup: paused before opening anything')
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    host.find('study-learn-back').dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', 'a deliberate pause must survive the sheet, not be undone by closing it')
    assert(!pendingFrameScheduled(), 'and the shuffle loop must NOT be running')
  })
})

// ===========================================================================
section('q. The pill row is ABOVE the sheet backdrop (P4 review) — the swap is reachable by touch')
// ===========================================================================
// This is the finding that made the addendum matter: `.study-learn-backdrop`
// is `inset: 0` at z-index 9, and `.study-top-row` shipped at 4 — so a TAP on
// the ACTION BUTTON pill while LEARN was open never reached the pill. It hit
// the backdrop, which dismissed the sheet; a second tap then opened ACTION
// with a full slide-up. Keyboard users got the in-place swap (focus order
// ignores z-index); finger users got the vanish-and-climb. Same control, two
// behaviours, and the jumpier one was the one the owner had.

test('.study-rail stacks above .study-learn-backdrop, so the pills are live while a sheet is open', () => {
  // P9 moved this contract from `.study-top-row` to `.study-rail`, and it is
  // MORE fragile in the new layout, not less: the rail is an in-flow flex
  // item, so it has no z-index of its own by default and the sheet's
  // `inset: 0` backdrop at z-index 9 would cover every pill. (z-index does
  // apply to a static flex item — CSS Flexbox 1 §5.4 — which is why no
  // positioning is needed to fix it.) Without this, tapping ACTION BUTTON
  // while LEARN is open dismisses the sheet instead of switching to it: the
  // exact two-tap "jumpy" behaviour P4 tracked down.
  const railZ = Number(cssValue('.study-rail', 'z-index'))
  const backdropZ = Number(cssValue('.study-learn-backdrop', 'z-index'))
  const panelZ = Number(cssValue('.study-learn-panel', 'z-index'))
  assert(Number.isFinite(railZ) && Number.isFinite(backdropZ), 'expected numeric z-indexes on both')
  assert(railZ > backdropZ, `.study-rail (${railZ}) must sit ABOVE .study-learn-backdrop (${backdropZ}) or its pills cannot be tapped`)
  assert(railZ <= panelZ, `.study-rail (${railZ}) must not paint over the sheet panel (${panelZ}) where the two overlap`)
  return `rail ${railZ} > backdrop ${backdropZ}, panel ${panelZ}`
})

withMountedStudy(actionState(), ({ host }) => {
  test('pressing the pill of the kind ALREADY showing closes the sheet (the dismissal that tap used to get from the backdrop)', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-learn-panel'), 'setup: LEARN open')
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'a second press on LEARN must close it, not sit inert')
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-ab-panel'), 'setup: ACTION open')
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'a second press on ACTION BUTTON must close it too')
  })

  test('the exposed field still dismisses — raising the pill row did not take the backdrop tap away', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const backdrop = host.find('study-learn-backdrop')
    backdrop.dispatchEvent({ type: 'click', target: backdrop })
    assert(!host.find('study-learn-panel'), 'tapping the exposed field must still close the sheet')
  })
})

// ===========================================================================
section('s. THE COMBINED LEARN SHEET (2026-08-15): one door, both halves')
// ===========================================================================
// OWNER, verbatim: "als learn and all shots are like the same thing, i think
// we can combine those two buttons and their material." So LEARN is the shot's
// DETAIL over the whole scoped tour's LIST, and the ALL SHOTS pill is gone.
// What used to be section (s)'s subject — the list, its order, its ✓, its
// stays-open row tap — is all still here; what changed is the door it is
// behind, and that the DETAIL now has to follow along with the mark.

for (const [trim, expected] of [
  ['premium-le', TOUR_ORDER_PREMIUM_LE],
  ['pro', TOUR_ORDER_PRO],
]) {
  withMountedStudy(fakeAppState({ trim }), ({ host }) => {
    test(`trim '${trim}': the rows ARE the tour, in tour order (${expected.length} of them)`, () => {
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      const panel = host.find('study-learn-panel')
      assert(panel, 'expected the LEARN panel to open')
      assert(panel.getAttribute('role') === 'dialog', 'expected role="dialog"')
      // The dialog is named by the SHOT, which is the sheet's subject; the list
      // below carries its own heading (the label the pill used to hold).
      assert(panel.getAttribute('aria-labelledby') === 'study-learn-title', 'expected aria-labelledby="study-learn-title"')
      const heading = panel.find('study-learn-list-title')
      // 'TARGETS' since the LIGHTS merge (2026-09-08) — the first of the two
      // section labels (with no howItPlays here, there is no LIGHTS section).
      assert(heading && heading.textContent === 'TARGETS', `expected the TARGETS heading, got ${JSON.stringify(heading && heading.textContent)}`)
      // THE HEADING IS OUTSIDE THE SCROLL REGION. Inside it, measured in
      // Chrome, it scrolled away with the rows and rendered as a half-cut
      // amber sliver at every non-zero offset. It is a fixed row of the split.
      assert(!descends(panel.find('study-learn-list'), heading), 'the TARGETS heading must not live inside the scrolling list')
      assert(descends(panel.find('study-learn-body'), heading), '…but it must still be part of the split body')
      assert(
        panel.find('study-index-list').getAttribute('aria-labelledby') === 'study-learn-targets-title',
        'the list must be NAMED by that heading — it is no longer named by a button',
      )
      const names = panel.findAll('study-index-name').map((n) => n.textContent)
      // Compared against the tour built by the REAL buildTour for this trim,
      // not a second hand-written order — the whole claim is that the list and
      // the ‹ › walk cannot disagree.
      const tourNames = buildTour(SHOTS, trim).map((s) => s.name)
      assert(names.join(' | ') === tourNames.join(' | '), `expected [${tourNames.join(', ')}], got [${names.join(', ')}]`)
      assert(names.length === expected.length, `expected ${expected.length} rows under ${trim}, got ${names.length}`)
      return names.join(' -> ')
    })

    test(`trim '${trim}': every row carries its type tag, and only the CURRENT row is marked`, () => {
      const panel = host.find('study-learn-panel')
      const types = panel.findAll('study-index-type').map((t) => t.textContent)
      assert(types.length === expected.length, `expected one type tag per row, got ${types.length}`)
      assert(types.every((t) => t.length > 0), `expected every type tag to be non-empty, got ${JSON.stringify(types)}`)
      const marked = panel.findAll('study-index-row').filter((r) => r.className.includes('study-index-row-current'))
      assert(marked.length === 1, `expected exactly one marked row, got ${marked.length}`)
      const checks = panel.findAll('study-index-check').map((c) => c.textContent)
      assert(checks.filter((c) => c === '✓').length === 1, `expected exactly one ✓, got ${JSON.stringify(checks)}`)
      assert(checks[0] === '✓', 'expected the ✓ on the FIRST row (the tour opens on shot 1)')
      const current = panel.findAll('study-index-row')[0]
      assert(current.getAttribute('aria-current') === 'true', 'expected aria-current="true" on the marked row')
      assert(panel.findAll('study-index-row')[1].getAttribute('aria-current') === 'false', 'expected aria-current="false" elsewhere')
      // ...and the DETAIL above it is the same shot the ✓ is on, which is the
      // whole reason the two halves are one sheet.
      assert(panel.find('study-learn-title').textContent === buildTour(SHOTS, trim)[0].name, 'the detail must open on the shot the ✓ marks')
      return `${types.length} tagged rows, 1 marked, detail agrees`
    })
  })
}

withMountedStudy(fakeAppState(), ({ host }) => {
  test('tapping row k jumps the tour to k+1, pauses the shuffle, LEAVES THE SHEET OPEN, moves the ✓ AND swaps the detail', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-learn-panel')
    const rows = panel.findAll('study-index-row')
    assert(rows.length === 6, `setup: expected 6 rows, got ${rows.length}`)
    assert(panel.find('study-learn-title').textContent === 'Top Shot', 'setup: the detail opens on shot 1')
    rows[3].dispatchEvent({ type: 'click' }) // 4th row -> "SHOT 4 OF 6"

    assert(host.find('study-readout-label').textContent === 'SHOT 4 OF 6', `expected "SHOT 4 OF 6", got ${JSON.stringify(host.find('study-readout-label').textContent)}`)
    assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', 'a row tap is manual navigation — it must pause the shuffle')
    // THE POINT OF THIS SURFACE: the sheet does not close, because the field
    // behind it is still readable (the backdrop is transparent by design).
    assert(host.find('study-learn-panel') === panel, 'the sheet must stay OPEN, and be the same panel element')
    const marked = panel.findAll('study-index-row').findIndex((r) => r.className.includes('study-index-row-current'))
    assert(marked === 3, `expected the mark on row 3 (0-based), got ${marked}`)
    assert(panel.findAll('study-index-check')[3].textContent === '✓', 'expected the ✓ to have moved to the tapped row')
    assert(panel.findAll('study-index-check')[0].textContent === '', 'expected the old row to give the ✓ up')
    // THE MERGE'S OWN ASSERTION: the half above the list followed the tap.
    assert(
      panel.find('study-learn-title').textContent === 'Mid Left',
      `expected the DETAIL to swap to the tapped shot, got ${JSON.stringify(panel.find('study-learn-title').textContent)}`,
    )
    assert(panel.find('study-learn-notes'), 'the detail must still be a full detail after the swap, notes and all')
    return 'SHOT 4 OF 6, sheet open, ✓ on row 4, detail = Mid Left'
  })

  test('the row ELEMENTS survive the jump — the mark is an edit, not a rebuild (a rebuild would drop a keyboard user AND the scroll)', () => {
    const panel = host.find('study-learn-panel')
    const rows = panel.findAll('study-index-row')
    const listBefore = panel.find('study-learn-list')
    rows[0].focus()
    assert(domActiveElement === rows[0], 'setup: focus on the first row')
    rows[1].dispatchEvent({ type: 'click' })
    const after = host.find('study-learn-panel').findAll('study-index-row')
    assert(after[0] === rows[0] && after[1] === rows[1], 'the rows were rebuilt — focus inside the list cannot survive that')
    assert(domActiveElement === rows[0], 'focus must still be on the element it was on')
    assert(host.find('study-learn-panel').find('study-learn-list') === listBefore, 'the LIST CONTAINER was replaced — its scroll offset goes with it')
  })

  test('the DETAIL element is replaced in place while the list container is not — the swap is scoped to one half', () => {
    const panel = host.find('study-learn-panel')
    const detail = panel.find('study-learn-detail')
    const list = panel.find('study-learn-list')
    const body = panel.find('study-learn-body')
    panel.findAll('study-index-row')[5].dispatchEvent({ type: 'click' })
    assert(panel.find('study-learn-body') === body, 'the BODY must survive a jump — replacing it is the crossfade, which is for a change of KIND')
    assert(panel.find('study-learn-detail') === detail, 'the detail CONTAINER survives; only its children are replaced')
    assert(panel.find('study-learn-list') === list, 'the list container survives')
    assert(panel.find('study-learn-title').textContent === 'Bottom Shot', 'and the detail really did re-render')
  })

  test('pressing LEARN again closes it (the same-kind-pill-closes contract, now for the one door)', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'a second press on LEARN must close it')
    assert(!host.find('study-learn-backdrop'), 'and take the backdrop with it')
  })
})

// THE REMOVAL, asserted as an absence. "Combine those two buttons" is only
// done when the second button is gone — a hidden or disabled ALL SHOTS pill
// would be the version of this change where nothing was combined.
test('THE ALL SHOTS PILL IS GONE: not in the rail, not in the source, not in the stylesheet', () => {
  let pills = []
  withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: [...ALT_GOALS, ...CHARACTER_GOALS] }), ({ host }) => {
    assert(!host.find('study-index-btn'), 'a .study-index-btn is still mounted — hidden or not, it is still the second door')
    pills = host.find('study-pill-stack').children.map((c) => String(c.className).trim().split(/\s+/)[0])
  })
  // SEVEN since QUIZ ME joined (2026-10-14; six since the LIGHTS pill folded
  // into LEARN, 2026-09-08): HOW IT PLAYS leads, then LEARN, then CHARACTER,
  // then ACTION / DRILLS / ALT MODES, then QUIZ ME last — the slot rule every
  // later pill follows. ALL SHOTS is still not among them.
  assert(pills.length === 7, `expected seven pills, got ${JSON.stringify(pills)}`)
  assert(
    pills.join(',') === 'study-howitplays-btn,study-learn-btn,study-character-btn,study-action-btn,study-drills-btn,study-altmodes-btn,study-quiz-btn',
    `unexpected pill set/order: ${JSON.stringify(pills)}`,
  )
  // The class must not ship at all — a dead selector in a stylesheet is how a
  // removed surface comes back by accident.
  assert(!/\.study-index-btn\b/.test(stylesSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'styles.css still has a .study-index-btn rule')
  // And the KIND is gone from the union, not merely unreachable — 'shots' AND
  // now 'lights' are both out of it.
  const union = /type SheetKind = ([^\n]+)/.exec(studySrc)
  assert(union, 'ui/study.ts no longer declares a SheetKind union')
  assert(!/'shots'/.test(union[1]), `the 'shots' kind is still in the union: ${union[1].trim()}`)
  assert(!/'lights'/.test(union[1]), `the 'lights' kind is still in the union: ${union[1].trim()}`)
  assert(union[1].split('|').length === 6, `expected six kinds, got ${union[1].trim()}`)
  return `${pills.length} pills: ${pills.join(' / ')} ; SheetKind = ${union[1].trim()}`
})

// LEVEL SCOPING of the list is exercised in section (ad), where the zone
// fixtures and the scroller helpers live — see "THE LIST IS THE SCOPED TOUR"
// there.

withMountedStudy(fakeAppState({ shots: [] }), ({ host }) => {
  test('no visible shots: the LEARN pill is DISABLED (neither half has anything to show), and pressing it opens nothing', () => {
    const btn = host.find('study-learn-btn')
    assert(btn.disabled === true, 'expected the pill disabled when the MODEL leaves no shots')
    btn.dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'a disabled pill must not open an empty sheet')
  })
})

// ===========================================================================
section('t. DRILLS (P8): conditional pill, one card per drill, jump wiring')
// ===========================================================================

withMountedStudy(fakeAppState(), ({ host }) => {
  test('dataset with NO drills: the pill mounts hidden (the ACTION-pill fail-soft rule)', () => {
    const btn = host.find('study-drills-btn')
    assert(btn, 'expected a .study-drills-btn element to exist')
    assert(btn.hidden === true, 'expected it hidden when data.drills is absent')
    assert(btn.textContent === 'DRILLS', `expected the label "DRILLS", got ${JSON.stringify(btn.textContent)}`)
  })
})

withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON }), ({ host }) => {
  test('dataset WITH drills: the pill is visible and opens a "Practice Drills" dialog, one card per drill', () => {
    const btn = host.find('study-drills-btn')
    assert(btn.hidden === false, 'expected the pill visible')
    btn.dispatchEvent({ type: 'click' })
    const panel = host.find('study-drills-panel')
    assert(panel, 'expected a .study-drills-panel to open')
    assert(panel.getAttribute('role') === 'dialog', 'expected role="dialog"')
    assert(panel.getAttribute('aria-labelledby') === 'study-drills-title', 'expected aria-labelledby="study-drills-title"')
    assert(panel.find('study-learn-title').textContent === 'Practice Drills', 'expected the sheet title')
    const cards = panel.findAll('study-drill')
    assert(cards.length === DRILLS.length, `expected ${DRILLS.length} cards (one per drill), got ${cards.length}`)
    assert(
      cards.map((c) => c.find('study-drill-title').textContent).join(' | ') === DRILLS.map((d) => d.title).join(' | '),
      'expected the cards in authored order, titled by the drill',
    )
    assert(cards[0].find('study-drill-text').textContent === DRILLS[0].text, "expected the drill's text")
    return `${cards.length} cards`
  })

  test('reps renders as a labelled LINE only where authored; focus renders as a chip only where authored', () => {
    const cards = host.find('study-drills-panel').findAll('study-drill')
    assert(cards[0].find('study-drill-reps').textContent === 'REPS · 20', `expected "REPS · 20", got ${JSON.stringify(cards[0].find('study-drill-reps')?.textContent)}`)
    assert(cards[1].find('study-drill-reps').textContent === 'REPS · 10 attempts', 'expected the second drill\'s prose reps')
    assert(!cards[2].find('study-drill-reps'), 'a drill with no reps must render no reps line at all')

    assert(cards[0].find('study-drill-focus').textContent === DRILLS[0].focus, 'expected the focus chip to carry the authored text VERBATIM')
    assert(cards[1].find('study-drill-focus').textContent === 'ramp strength', "expected the second drill's focus")
    assert(!cards[2].find('study-drill-focus'), 'a drill with no focus must render no chip')
    // The chip rides the shared recipe, so it is geometry-identical to the
    // LEARN sheet's type chip — only the uppercase transform comes off.
    assert(cards[0].find('study-drill-focus').className.split(/\s+/).includes('study-learn-chip'), 'the focus chip must ride the shared .study-learn-chip recipe')
    assert(cssValue('.study-drill-focus', 'text-transform') === 'none', 'authored focus PROSE must not be uppercased by the chip recipe')
  })

  test('"Study …" appears only for a drill whose shot is in the CURRENT tour, and names that shot', () => {
    const cards = host.find('study-drills-panel').findAll('study-drill')
    const link = cards[0].find('study-drill-link')
    assert(link, 'expected a jump button on the drill that names an in-tour shot')
    assert(link.textContent.includes('Top Shot'), `expected the button to name the shot it jumps to, got ${JSON.stringify(link.textContent)}`)
    assert(!cards[2].find('study-drill-link'), 'a drill naming no shots must offer no jump')
  })

  test('tapping it jumps the tour and LEAVES THE SHEET OPEN (same contract as a LEARN list row)', () => {
    // Move away first, so the jump is observable rather than a no-op.
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 3 OF 6', 'setup: moved off the first shot')
    const panel = host.find('study-drills-panel')
    panel.findAll('study-drill')[0].find('study-drill-link').dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 1 OF 6', 'expected the tour to jump to "Top Shot" (tour index 0)')
    assert(host.find('study-drills-panel') === panel, 'the sheet must stay open, same panel element')
  })

  test('pressing DRILLS again closes it', () => {
    host.find('study-drills-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-drills-panel'), 'a second press on DRILLS must close it')
  })
})

// The MODEL-dependent half: a drill pointing at a Premium/LE-only shot has
// nowhere to send a Pro player, and must not pretend otherwise.
withMountedStudy(fakeAppState({ drills: DRILLS, trim: 'pro' }), ({ host }) => {
  test("trim 'pro': the drill whose only shot is Premium/LE-only offers no jump (the shot is not on this model's field)", () => {
    host.find('study-drills-btn').dispatchEvent({ type: 'click' })
    const cards = host.find('study-drills-panel').findAll('study-drill')
    assert(cards.length === 3, 'the CARDS are not trim-filtered — a drill is still worth reading')
    assert(cards[0].find('study-drill-link'), 'the all-trim shot still offers its jump')
    assert(!cards[1].find('study-drill-link'), 'the premium-le-only shot must NOT offer a jump under pro')
  })
})

// REAL DATASETS, not the synthetic fixture: the pill's conditional is only
// worth anything if it matches what actually shipped.
//
// WHAT CHANGED 2026-08-15: the catalog-wide drills program authored drills for
// the other 129 registered machines, so godzilla — this block's old "machine
// with none" — now has six of its own and NO shipped dataset exercises the
// hidden branch any more. Both halves are still covered, honestly: the shipped
// data is asserted to be complete (every registered machine carries drills),
// and the hidden branch is driven by a real dataset with its `drills` key taken
// back off, which is the only way left to reach it.
{
  const dataDir = resolve(__dirname, '../../data')
  const catalog = JSON.parse(readFileSync(resolve(dataDir, 'catalog.json'), 'utf8'))
  const jaws = JSON.parse(readFileSync(resolve(dataDir, 'jaws_goals.json'), 'utf8'))
  const godzilla = JSON.parse(readFileSync(resolve(dataDir, 'godzilla_goals.json'), 'utf8'))
  const noDrills = JSON.parse(readFileSync(resolve(dataDir, 'godzilla_goals.json'), 'utf8'))
  delete noDrills.drills

  test('the shipped data backs the pill: EVERY registered machine carries drills', () => {
    const missing = catalog
      .map((m) => [m.id, JSON.parse(readFileSync(resolve(dataDir, `${m.resource}.json`), 'utf8'))])
      .filter(([, doc]) => !Array.isArray(doc.drills) || doc.drills.length === 0)
      .map(([id]) => id)
    assert(missing.length === 0, `machines with no drills: ${missing.join(', ')}`)
    assert(jaws.drills.length === 6, `jaws keeps its 6 authored drills, found ${jaws.drills.length}`)
    return `${catalog.length} registered machines, every one with drills`
  })

  for (const [label, id, data, visible] of [
    ['data/jaws_goals.json', 'jaws', jaws, true],
    ['data/godzilla_goals.json', 'godzilla', godzilla, true],
    ['data/godzilla_goals.json with `drills` removed', 'godzilla', noDrills, false],
  ]) {
    const state = fakeAppState()
    state.data = data
    state.machine = { id, name: id, shortTitle: id.toUpperCase(), resource: `${id}_goals` }
    withMountedStudy(state, ({ host }) => {
      test(`REAL ${label}: the DRILLS pill is ${visible ? 'visible' : 'hidden'}`, () => {
        assert(host.find('study-drills-btn').hidden === !visible, `expected hidden=${!visible} for ${label}`)
        if (!visible) return `${id}: hidden`
        host.find('study-drills-btn').dispatchEvent({ type: 'click' })
        const cards = host.find('study-drills-panel').findAll('study-drill')
        assert(cards.length === data.drills.length, `expected ${data.drills.length} cards, got ${cards.length}`)
        return `${id}: ${cards.length} cards from the shipped dataset`
      })
    })
  }
}

// ===========================================================================
section('ag. ALT MODES (dataset schema v7, 2026-08-14): the collection, and the pill that is not there without one')
// ===========================================================================
// OWNER: "in jaws, there are video game modes… I think a lot of games have
// alternate modes and that should be its own button and info in study mode."
//
// The three things that can go wrong, and are pinned here:
//   1. A pill that opens nothing (shown by one predicate, filled by another).
//   2. A collection that MOVES its members. Duplication is the design — every
//      flagged goal stays on the Goals tab, in the Map picker and on its guide
//      page — so the test asserts the goals array is untouched.
//   3. A card that drops the half of the goal it did not expect: the corpus
//      has PATHLESS flagged goals (a menu's `instructions`) and ROUTED ones
//      (a video mode's `steps`), and a body that only read one would show
//      Attack from Mars' video mode with no way to start it.

const altState = fakeAppState({ goals: ALT_GOALS, drills: DRILLS, actionButton: ACTION_BUTTON })
withMountedStudy(altState, ({ host }) => {
  test('the pill exists, reads ALT MODES, and its aria-label CONTAINS that visible text (WCAG 2.5.3)', () => {
    const btn = host.find('study-altmodes-btn')
    assert(btn, 'expected a .study-altmodes-btn element')
    assert(btn.hidden === false, 'a machine with flagged goals must show the pill')
    assert(btn.textContent === 'ALT MODES', `expected "ALT MODES", got ${JSON.stringify(btn.textContent)}`)
    const label = btn.getAttribute('aria-label')
    assert(label && label.toLowerCase().includes('alt modes'), `aria-label ${JSON.stringify(label)} must contain the visible label`)
    return `"${btn.textContent}" / aria-label "${label}"`
  })

  test('it opens the SHARED sheet with one card per FLAGGED goal — the unflagged one never appears', () => {
    host.find('study-altmodes-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-altmodes-panel')
    assert(panel, 'expected the panel to carry .study-altmodes-panel')
    assert(panel.className.split(/\s+/).includes('study-learn-panel'), 'it must ride the SHARED sheet shell, not a second panel recipe')
    assert(panel.getAttribute('role') === 'dialog' && panel.getAttribute('aria-modal') === 'true', 'the shared shell\'s dialog wiring must apply')
    const cards = panel.findAll('study-altmode')
    const flagged = ALT_GOALS.filter((g) => g.altMode)
    assert(cards.length === flagged.length, `expected ${flagged.length} cards, got ${cards.length}`)
    const titles = cards.map((c) => c.find('study-altmode-title').textContent)
    assert(!titles.includes('Left Ramp Loop'), `the unflagged goal leaked into the collection: ${JSON.stringify(titles)}`)
    // DATASET ORDER, not re-sorted: the collection reads as a subset of a list
    // the player has already seen on the Goals tab.
    assert(titles.join(' | ') === flagged.map((g) => g.title).join(' | '), `expected dataset order, got ${JSON.stringify(titles)}`)
    return titles.join(' | ')
  })

  test('each card carries the TYPE CHIP for its own flag, from the closed vocabulary', () => {
    const cards = host.find('study-altmodes-panel').findAll('study-altmode')
    const chips = cards.map((c) => c.find('study-altmode-chip').textContent)
    assert(chips.join(' | ') === 'MENU | VIDEO MODE | RULESET', `got ${JSON.stringify(chips)}`)
    // The chip rides the shared recipe, so it is geometry-identical to the
    // LEARN sheet's type chip — only the amber tint/border/ink come on.
    assert(
      cards[0].find('study-altmode-chip').className.split(/\s+/).includes('study-learn-chip'),
      'the type chip must ride the shared .study-learn-chip recipe',
    )
    // A CLOSED vocabulary, unlike a drill's free-prose `focus`, so it KEEPS
    // the recipe's uppercase rather than turning it off.
    assert(cssValue('.study-altmode-chip', 'text-transform') === null, 'the closed-vocabulary chip must not opt out of the recipe\'s uppercase')
    assert(cssValue('.study-altmode-chip', 'color') === 'var(--amber)', 'BACKGLASS tokens only — the chip ink must be var(--amber)')
    assert(cssValue('.study-altmode-chip', 'background') === 'var(--amber-faint)', 'BACKGLASS tokens only — the chip tint must be var(--amber-faint)')
    return chips.join(' | ')
  })

  test('the how-list RESTATES list-style, or the global ol reset deletes every number', () => {
    // Found in Chrome, 2026-08-15: styles.css opens with a global
    // `ul, ol { list-style: none }`, which wins the tie and silently deletes
    // the markers — the ::marker rule became dead code and the steps rendered
    // as an indented, unnumbered wall. Same cascade trap as the [hidden]
    // restatements, and `.goal-instructions` already carries the same fix.
    const globalReset = /\bul,\s*\n?\s*ol\s*\{[^}]*list-style:\s*none/.test(stylesSrc)
    assert(globalReset, 'setup: the global ol reset is what makes this restatement necessary — if it is gone, so is this test\'s reason')
    assert(cssValue('.study-altmode-how', 'list-style') === 'decimal', `the how-list must restate list-style, got ${JSON.stringify(cssValue('.study-altmode-how', 'list-style'))}`)
    assert(/\.study-altmode-how li::marker\s*\{/.test(stylesSrc), 'the ::marker rule must exist to colour the numbers the restatement brings back')
    return 'list-style: decimal restated over the global reset'
  })

  test('the HOW lines come from instructions when pathless and from the STEPS\' actions when routed', () => {
    const cards = host.find('study-altmodes-panel').findAll('study-altmode')
    const linesOf = (card) => card.find('study-altmode-how').children.map((li) => li.textContent)
    // g-menu: pathless, so its two authored instructions.
    assert(linesOf(cards[0]).join(' / ') === ALT_GOALS[1].instructions.join(' / '), `menu card: got ${JSON.stringify(linesOf(cards[0]))}`)
    // g-video: ROUTED (two steps, no instructions), so the steps' actions.
    // This is the branch that would silently show a video mode with no way to
    // start it if the body only read `instructions`.
    assert(linesOf(cards[1]).join(' / ') === ALT_GOALS[2].steps.map((s) => s.action).join(' / '), `video card: got ${JSON.stringify(linesOf(cards[1]))}`)
    // ...and the shot IDS are never rendered — this sheet is not a route.
    assert(!linesOf(cards[1]).some((l) => /s-top|s-bottom/.test(l)), 'a raw shot id reached a player-facing line')
    return `menu ${linesOf(cards[0]).length} lines (instructions), video ${linesOf(cards[1]).length} lines (steps)`
  })

  test('the summary is always there, and the REWARD line only when the dataset authored one', () => {
    const cards = host.find('study-altmodes-panel').findAll('study-altmode')
    assert(cards[0].find('study-altmode-summary').textContent === ALT_GOALS[1].summary, 'expected the goal\'s own summary')
    assert(cards[1].find('study-altmode-reward').textContent === `REWARD · ${ALT_GOALS[2].reward}`, 'expected a labelled reward line')
    // g-ruleset authors no reward — an empty 'REWARD ·' would be worse than none.
    assert(!cards[2].find('study-altmode-reward'), 'a goal with no authored reward must render no reward line')
    return 'summary always, reward only when authored'
  })

  test('DUPLICATION IS THE DESIGN: opening the collection moves nothing out of the goals array', () => {
    // The collection is a VIEW over the dataset. If it ever became a MOVE —
    // a filter that spliced, a sort in place, a flag stripped on read — the
    // Goals tab and the Map picker would quietly lose these goals, and the
    // only symptom would be a machine that stopped listing its own content.
    const goals = altState.data.goals
    assert(goals.length === ALT_GOALS.length, `the dataset lost goals: ${goals.length} of ${ALT_GOALS.length} left`)
    assert(goals.map((g) => g.id).join(',') === ALT_GOALS.map((g) => g.id).join(','), 'the dataset was reordered')
    // Same OBJECTS, and every flag still on them — not copies the sheet made.
    for (let i = 0; i < goals.length; i++) {
      assert(goals[i] === ALT_GOALS[i], `goals[${i}] is no longer the object the dataset shipped`)
      assert(goals[i].altMode === ALT_GOALS[i].altMode, `goals[${i}] lost its altMode flag on read`)
    }
    return `${goals.length} goals still in the dataset, ${goals.filter((g) => g.altMode).length} of them flagged`
  })

  test('pressing ALT MODES again closes it (the same contract every pill has)', () => {
    assert(host.find('study-altmodes-panel'), 'setup: open')
    host.find('study-altmodes-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-altmodes-panel'), 'a second press on ALT MODES must close it')
  })
})

test('a machine with NO flagged goal hides the pill, and the hide actually wins the cascade', () => {
  withMountedStudy(fakeAppState({ goals: [ALT_GOALS[0]] }), ({ host }) => {
    const btn = host.find('study-altmodes-btn')
    assert(btn, 'the pill must exist in the DOM (hidden), like every other conditional in this rail')
    assert(btn.hidden === true, 'a machine whose goals carry no altMode must not offer the pill')
    btn.dispatchEvent({ type: 'click' })
    assert(!host.find('study-altmodes-panel'), 'and pressing it (however you reach it) must open nothing')
  })
  // `.study-learn-btn, …, .study-altmodes-btn { display: flex }` beats the UA's
  // [hidden] display:none, so the hide MUST be restated at equal specificity —
  // the cascade trap that took the whole Study panel down on 2026-08-14.
  assert(cssValue('.study-altmodes-btn', 'display') === 'flex', 'setup: the pill sets its own display')
  assert(cssValue('.study-altmodes-btn[hidden]', 'display') === 'none', 'the [hidden] restatement is missing — every unflagged machine would show a dead ALT MODES pill')
  return 'hidden in the DOM, inert on press, and the CSS hide wins'
})

test('the collection is NOT trim-filtered — a MODEL switch changes shots, never which games the code can play', () => {
  for (const trim of ['pro', 'premium-le']) {
    withMountedStudy(fakeAppState({ goals: ALT_GOALS, trim }), ({ host }) => {
      host.find('study-altmodes-btn').dispatchEvent({ type: 'click' })
      const n = host.find('study-altmodes-panel').findAll('study-altmode').length
      assert(n === 3, `trim ${trim}: expected all three flagged goals, got ${n}`)
    })
  }
  return 'three cards under both models'
})

// REAL DATASETS, not the synthetic fixture — including the four machines the
// owner actually owns, so "nothing to update there" is a measurement.
{
  const dataDir = resolve(__dirname, '../../data')
  const read = (f) => JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
  const REAL = [
    ['jaws', read('jaws_goals.json'), ['menu', 'video']],
    ['evil-dead', read('evil_dead_goals.json'), ['video', 'menu']],
    ['jurassic-park', read('jurassic_park_goals.json'), ['menu']],
    ['pulp-fiction', read('pulp_fiction_goals.json'), []],
    ['bone-busters', read('bone_busters_goals.json'), []],
  ]

  for (const [name, data, wantChips] of REAL) {
    const state = fakeAppState()
    state.data = data
    state.machine = { id: name, name, shortTitle: name.toUpperCase(), resource: `${name}_goals` }
    withMountedStudy(state, ({ host }) => {
      test(`REAL ${name}: the ALT MODES pill is ${wantChips.length ? 'visible' : 'hidden'} and shows exactly the shipped flags`, () => {
        const flagged = data.goals.filter((g) => g.altMode)
        assert(
          flagged.map((g) => g.altMode).join(',') === wantChips.join(','),
          `the shipped dataset changed under this test: expected [${wantChips}], data has [${flagged.map((g) => g.altMode)}]`,
        )
        assert(host.find('study-altmodes-btn').hidden === (wantChips.length === 0), `expected hidden=${wantChips.length === 0} for ${name}`)
        if (wantChips.length === 0) return `${name}: no flagged goal, no pill`
        host.find('study-altmodes-btn').dispatchEvent({ type: 'click' })
        const cards = host.find('study-altmodes-panel').findAll('study-altmode')
        assert(cards.length === flagged.length, `expected ${flagged.length} cards, got ${cards.length}`)
        const chips = cards.map((c) => c.find('study-altmode-chip').textContent)
        const want = flagged.map((g) => ({ video: 'VIDEO MODE', menu: 'MENU', ruleset: 'RULESET' })[g.altMode])
        assert(chips.join(',') === want.join(','), `expected ${JSON.stringify(want)}, got ${JSON.stringify(chips)}`)
        // Every card must be able to say HOW — a card with a title, a chip and
        // nothing else is the failure mode a flag on a thin goal would produce.
        for (const c of cards) {
          assert(c.find('study-altmode-how'), `${name}: a card rendered with no how-lines at all`)
        }
        return `${name}: ${chips.join(' + ')} — ${cards.map((c) => c.find('study-altmode-title').textContent).join(' | ')}`
      })
    })
  }

  test('the shipped corpus carries exactly the program\'s 57 flags, in the closed vocabulary', () => {
    const catalog = JSON.parse(readFileSync(resolve(dataDir, 'catalog.json'), 'utf8'))
    const counts = { video: 0, menu: 0, ruleset: 0 }
    let machines = 0
    for (const m of catalog) {
      const doc = JSON.parse(readFileSync(resolve(dataDir, `${m.resource}.json`), 'utf8'))
      const flagged = doc.goals.filter((g) => g.altMode !== undefined && g.altMode !== null)
      for (const g of flagged) {
        assert(g.altMode in counts, `${m.id}/${g.id}: altMode ${JSON.stringify(g.altMode)} is outside the closed vocabulary`)
        counts[g.altMode] += 1
      }
      if (flagged.length) machines += 1
    }
    const total = counts.video + counts.menu + counts.ruleset
    assert(total === 57, `expected 57 flags across the catalog, found ${total}`)
    assert(counts.video === 33 && counts.menu === 15 && counts.ruleset === 9, `expected 33/15/9, got ${JSON.stringify(counts)}`)
    return `${total} flags (${counts.video} video / ${counts.menu} menu / ${counts.ruleset} ruleset) across ${machines} machines`
  })

  test('the 11 drill shot-lists the program applied are on disk and resolve to real shots', () => {
    const want = {
      jaws_goals: { 'skill-shot-ladder': 5, 'quickshot-farm-reps': 3, 'fishing-reel-trap-flip': 2, 'boost-bank-start': 3, 'orca-deck-access': 3, 'beach-closing-loop': 1 },
      harry_potter_goals: { 'under-flipper-reps': 2, 'death-eater-duel-drill': 2 },
      sonic_the_hedgehog_goals: { 'skill-shot-lane-reps': 1, 'bash-dash-timing': 2, 'inline-drop-clears': 1 },
    }
    let n = 0
    for (const [res, drills] of Object.entries(want)) {
      const doc = JSON.parse(readFileSync(resolve(dataDir, `${res}.json`), 'utf8'))
      const ids = new Set(doc.shots.map((s) => s.id))
      for (const [did, count] of Object.entries(drills)) {
        const d = doc.drills.find((x) => x.id === did)
        assert(d, `${res}: no drill ${did}`)
        assert(Array.isArray(d.shots) && d.shots.length === count, `${res}/${did}: expected ${count} shot links, got ${JSON.stringify(d.shots)}`)
        for (const s of d.shots) assert(ids.has(s), `${res}/${did}: shot ${s} does not exist on this machine`)
        n += 1
      }
    }
    // ...and the one that is shotless BY DESIGN stays that way, with NO key —
    // absence is the schema's idiom (measured: the corpus has 12 drills with
    // no `shots` key and none with an empty array).
    const hp = JSON.parse(readFileSync(resolve(dataDir, 'harry_potter_goals.json'), 'utf8'))
    const combo = hp.drills.find((d) => d.id === 'combo-chain-drill')
    assert(combo && !('shots' in combo), 'combo-chain-drill must stay shotless with NO shots key — an empty array is a third state nothing reads')
    // ...and harry-potter's OWN skill-shot-ladder, which already had links,
    // was not touched by the program.
    const ladder = hp.drills.find((d) => d.id === 'skill-shot-ladder')
    assert(ladder.shots.join(',') === 'left-inlane,right-inlane', `harry-potter's authored skill-shot-ladder links were overwritten: ${JSON.stringify(ladder.shots)}`)
    return `${n} drills linked, combo-chain-drill still keyless, harry-potter's own ladder untouched`
  })
}

// ===========================================================================
section('ah. CHARACTER (2026-08-15): the progression layer gets its own door')
// ===========================================================================
// OWNER: "drop character dev info from shots and only have it in study."
//
// WHAT THIS DOOR IS. A modern machine has a layer that a route drawing cannot
// express at all — the hero you pick, the gear you bank, the XP and the account
// progress that outlive a ball. The dataset already carries it, as 'progression'
// goals with no `steps`; before this pass the app's only home for it was the
// Goals tab, and the Shots tab's own goal sheet could do nothing with such a row
// but hand it back there.
//
// THE RULE IS ONE FUNCTION — ui/goalMeta.ts's isCharacterGoal, and the
// characterGoals collection defined in terms of it — and THREE surfaces read
// it: this pill's visibility, this sheet's contents, and (in
// tests/goal-bridge.test.mjs section 12) the Shots tab's retargeted row. So the
// predicate is driven directly here AND through the mounted rail: "the pill and
// the sheet agree" is worth nothing unless both are provably the same function.
//
// THE THREE FAILURE MODES this section exists to catch:
//   1. A pill shown by one rule and filled by another (ALT MODES' own lesson).
//   2. A widened rule. Both conjuncts are load-bearing — dropping `pathless`
//      would pull in routed progression goals the Shots map already draws;
//      dropping the category test would pull in every secret in the corpus,
//      including the SECOND copy of a character select that several machines
//      author twice (dnd, tmnt).
//   3. A collection that MOVES its members. Duplication is the design here
//      exactly as it is for ALT MODES: these goals stay on the Goals tab and in
//      the Map picker.

// --- the predicate, driven directly ----------------------------------------
test('the rule is `progression` AND pathless — both conjuncts, both directions', () => {
  const data = { goals: [...ALT_GOALS, ...CHARACTER_GOALS] }
  const picked = characterGoals(data).map((g) => g.id)
  assert(picked.join(',') === 'g-char-select,g-char-gear', `expected the two pathless progression goals, got ${JSON.stringify(picked)}`)
  // Each exclusion, named, so a widening says WHICH conjunct it broke.
  assert(!picked.includes('g-char-routed'), 'a ROUTED progression goal is drawn by the Shots map — it must not be in this door')
  assert(!picked.includes('g-menu') && !picked.includes('g-ruleset'), 'a PATHLESS secret is not a character system')
  assert(!picked.includes('g-plain') && !picked.includes('g-video'), 'ordinary ball-in-play content must not leak in')
  // ...and the member test agrees with the collection on every single goal,
  // because they are the same rule and one is defined from the other.
  for (const g of data.goals) {
    assert(isCharacterGoal(g) === picked.includes(g.id), `isCharacterGoal(${g.id}) disagrees with the collection`)
  }
  return picked.join(' | ')
})

test('DATASET ORDER, and the dataset itself is never touched', () => {
  const goals = [...ALT_GOALS, ...CHARACTER_GOALS]
  const before = goals.map((g) => g.id).join(',')
  const picked = characterGoals({ goals })
  assert(goals.map((g) => g.id).join(',') === before, 'characterGoals reordered or spliced the array it was given')
  assert(goals.length === ALT_GOALS.length + CHARACTER_GOALS.length, 'the dataset lost goals')
  // Same OBJECTS, not copies — a copy is how a flag gets stripped on read.
  const first = picked[0]
  assert(first === CHARACTER_GOALS[0], 'the collection returned a copy rather than the dataset\'s own object')
  // And the order is the order they were authored in, not difficulty or title.
  assert(picked.map((g) => g.id).join(',') === 'g-char-select,g-char-gear', `expected dataset order, got ${picked.map((g) => g.id)}`)
  return `${picked.length} of ${goals.length}, in place`
})

test('no data at all is an empty collection, never a throw (the boot path)', () => {
  assert(characterGoals(null).length === 0, 'null must be empty')
  assert(characterGoals(undefined).length === 0, 'undefined must be empty')
  return 'null/undefined -> []'
})

// --- the pill --------------------------------------------------------------
const charState = fakeAppState({ goals: ALL_PILL_GOALS, drills: DRILLS, actionButton: ACTION_BUTTON })
withMountedStudy(charState, ({ host, handle }) => {
  test('the pill exists, reads CHARACTER, and its aria-label CONTAINS that visible text (WCAG 2.5.3)', () => {
    const btn = host.find('study-character-btn')
    assert(btn, 'expected a .study-character-btn element')
    assert(btn.hidden === false, 'a machine with character goals must show the pill')
    assert(btn.textContent === 'CHARACTER', `expected "CHARACTER", got ${JSON.stringify(btn.textContent)}`)
    const label = btn.getAttribute('aria-label')
    assert(label && label.toLowerCase().includes('character'), `aria-label ${JSON.stringify(label)} must contain the visible label`)
    return `"${btn.textContent}" / aria-label "${label}"`
  })

  test('it opens the SHARED sheet with one card per matching goal — and nothing else from the dataset', () => {
    host.find('study-character-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-character-panel')
    assert(panel, 'expected the panel to carry .study-character-panel')
    assert(panel.className.split(/\s+/).includes('study-learn-panel'), 'it must ride the SHARED sheet shell, not a fifth panel recipe')
    assert(panel.getAttribute('role') === 'dialog' && panel.getAttribute('aria-modal') === 'true', 'the shared shell\'s dialog wiring must apply')
    assert(panel.getAttribute('aria-labelledby') === 'study-characters-title', 'the dialog must be named by its own title')
    const cards = panel.findAll('study-character')
    assert(cards.length === 2, `expected two cards, got ${cards.length}`)
    const titles = cards.map((c) => c.find('study-character-title').textContent)
    assert(titles.join(' | ') === 'Pick Your Hero and Your Starting Town | The Six Pieces of Gear and What Each One Buys You', `got ${JSON.stringify(titles)}`)
    return titles.join(' | ')
  })

  test('THE INSTRUCTION LINES ARE VERBATIM — this is the payload, not a summary of it', () => {
    const cards = host.find('study-character-panel').findAll('study-character')
    for (let i = 0; i < cards.length; i++) {
      const lines = cards[i].find('study-character-how').children.map((li) => li.textContent)
      const authored = CHARACTER_GOALS[i].instructions
      assert(lines.length === authored.length, `card ${i}: expected ${authored.length} lines, got ${lines.length}`)
      for (let j = 0; j < authored.length; j++) {
        // Byte-for-byte. Truncation, re-sentencing or a trailing full stop
        // added "for consistency" would all read as fine on screen and would
        // all be this app rewriting the dataset's own words.
        assert(lines[j] === authored[j], `card ${i} line ${j}:\n            got      ${JSON.stringify(lines[j])}\n            authored ${JSON.stringify(authored[j])}`)
      }
    }
    return `${CHARACTER_GOALS[0].instructions.length} + ${CHARACTER_GOALS[1].instructions.length} lines, byte-for-byte`
  })

  test('a <ul>, not the <ol> ALT MODES uses — an inventory is not a procedure', () => {
    const list = host.find('study-character-panel').find('study-character-how')
    assert(list.tagName === 'UL', `expected a <ul>, got <${list.tagName.toLowerCase()}>`)
    // The same cascade trap .study-altmode-how documents: the global
    // `ul, ol { list-style: none }` reset wins the tie and deletes every
    // marker, so the restatement is what makes the ::marker rule mean anything.
    const globalReset = /\bul,\s*\n?\s*ol\s*\{[^}]*list-style:\s*none/.test(stylesSrc)
    assert(globalReset, 'setup: the global list reset is what makes this restatement necessary')
    assert(cssValue('.study-character-how', 'list-style') === 'disc', `the how-list must restate list-style, got ${JSON.stringify(cssValue('.study-character-how', 'list-style'))}`)
    assert(/\.study-character-how li::marker\s*\{/.test(stylesSrc), 'the ::marker rule must exist to colour the bullets the restatement brings back')
    assert(cssValue('.study-altmode-how', 'list-style') === 'decimal', 'setup: the alt-mode list is still the NUMBERED one — the two differ on purpose')
    return 'ul + list-style: disc restated over the global reset'
  })

  test('difficulty is shown as three-slot pips WITH a text alternative', () => {
    const cards = host.find('study-character-panel').findAll('study-character')
    const pips = cards.map((c) => c.find('study-character-pips'))
    assert(pips[0].textContent === '●○○', `difficulty 1 must render ●○○, got ${JSON.stringify(pips[0].textContent)}`)
    assert(pips[1].textContent === '●●●', `difficulty 3 must render ●●●, got ${JSON.stringify(pips[1].textContent)}`)
    // "●●○" read aloud is three circles. The label is what a screen reader
    // actually gets, and it must agree with the glyphs.
    assert(pips[0].getAttribute('aria-label') === 'Difficulty 1 of 3', `got ${JSON.stringify(pips[0].getAttribute('aria-label'))}`)
    assert(pips[1].getAttribute('aria-label') === 'Difficulty 3 of 3', `got ${JSON.stringify(pips[1].getAttribute('aria-label'))}`)
    assert(cssValue('.study-character-pips', 'color') === 'var(--amber)', 'BACKGLASS tokens only — the pips must be var(--amber)')
    return `${pips[0].textContent} / ${pips[1].textContent}`
  })

  test('the summary is always there, and the REWARD line only when the dataset authored one', () => {
    const cards = host.find('study-character-panel').findAll('study-character')
    assert(cards[0].find('study-character-summary').textContent === CHARACTER_GOALS[0].summary, 'expected the goal\'s own summary')
    assert(cards[1].find('study-character-summary').textContent === CHARACTER_GOALS[1].summary, 'expected the goal\'s own summary')
    assert(cards[0].find('study-character-reward').textContent === `REWARD · ${CHARACTER_GOALS[0].reward}`, 'expected a labelled reward line')
    // g-char-gear authors no reward — an empty 'REWARD ·' would be worse than
    // none, the same rule the alt-mode card follows.
    assert(!cards[1].find('study-character-reward'), 'a goal with no authored reward must render no reward line')
    return 'summary always, reward only when authored'
  })

  test('the sheet is COUNT-FREE: it says how much it holds by holding it', () => {
    const panel = host.find('study-character-panel')
    // The HEADING, found by its id — deliberately a different string from the
    // per-card `.study-character-title` class, so this cannot accidentally
    // measure the first card. (It did, before the id was made plural: the
    // first thing this assertion read was "Pick Your Hero and Your Starting
    // Town".)
    const heading = panel.findAll('study-learn-title').find((el) => el.id === 'study-characters-title')
    assert(heading, 'expected a heading with id study-characters-title')
    assert(heading.textContent === 'Character & Progress', `got ${JSON.stringify(heading.textContent)}`)
    assert(!panel.findAll('study-character-title').some((el) => el.id === 'study-characters-title'), 'the heading id and the card title class must stay distinct strings')
    // No "2 SYSTEMS", no "N of M" anywhere in the body — the same rule the
    // LEARN list's own heading follows.
    const text = panel.textContent
    assert(!/\b\d+\s+(goals?|systems?|entries|items|cards?)\b/i.test(text), `a count leaked into the sheet: ${JSON.stringify(text.slice(0, 120))}`)
    return 'Character & Progress'
  })

  test('DUPLICATION IS THE DESIGN: opening the door moves nothing out of the goals array', () => {
    const goals = charState.data.goals
    assert(goals.length === ALL_PILL_GOALS.length, `the dataset lost goals: ${goals.length} of ${ALL_PILL_GOALS.length} left`)
    for (let i = 0; i < goals.length; i++) {
      assert(goals[i] === ALL_PILL_GOALS[i], `goals[${i}] is no longer the object the dataset shipped`)
    }
    return `${goals.length} goals still in the dataset, ${goals.filter(isCharacterGoal).length} of them character goals`
  })

  test('pressing CHARACTER again closes it (the same contract every pill has)', () => {
    assert(host.find('study-character-panel'), 'setup: open')
    host.find('study-character-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-character-panel'), 'a second press on CHARACTER must close it')
  })

  test('openCharacter() OPENS and never toggles — an arrival is not a press', () => {
    // The Shots tab's retargeted row calls this (app.ts's jumpToStudyCharacter).
    // Tapping such a row twice must land on an OPEN sheet both times; a toggle
    // would shut it on the second arrival.
    assert(!host.find('study-character-panel'), 'setup: closed')
    handle.openCharacter()
    assert(host.find('study-character-panel'), 'openCharacter() must open the sheet')
    handle.openCharacter()
    assert(host.find('study-character-panel'), 'a second arrival must leave it open, not close it')
    // ...and arriving while ANOTHER kind is showing swaps to CHARACTER rather
    // than doing nothing.
    host.find('study-drills-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-drills-panel'), 'setup: DRILLS showing')
    handle.openCharacter()
    assert(host.find('study-character-panel') && !host.find('study-drills-panel'), 'an arrival must swap the open sheet to CHARACTER')
    host.find('study-character-btn').dispatchEvent({ type: 'click' }) // leave it closed
    return 'open, open again, and swap from another kind'
  })
})

// --- the two ways a machine has nothing to show ----------------------------
test('a machine whose progression goals are all ROUTED shows NO pill (and opens nothing)', () => {
  // The exact case the `pathless` half of the rule exists for: this machine HAS
  // progression content, and the Shots map already draws every bit of it.
  withMountedStudy(fakeAppState({ goals: [ALT_GOALS[0], CHARACTER_GOALS[2]] }), ({ host }) => {
    const btn = host.find('study-character-btn')
    assert(btn, 'the pill must exist in the DOM (hidden), like every other conditional in this rail')
    assert(btn.hidden === true, 'a machine with only routed progression goals must not offer the door')
    btn.dispatchEvent({ type: 'click' })
    assert(!host.find('study-character-panel'), 'and pressing it (however you reach it) must open nothing')
  })
  return 'routed progression -> no pill, inert on press'
})

test('a machine with NO progression goals at all shows no pill either, and the hide wins the cascade', () => {
  withMountedStudy(fakeAppState({ goals: ALT_GOALS }), ({ host }) => {
    const btn = host.find('study-character-btn')
    assert(btn.hidden === true, 'a machine with no progression goal must not offer the door')
    btn.dispatchEvent({ type: 'click' })
    assert(!host.find('study-character-panel'), 'pressing it must open nothing')
  })
  // `.study-learn-btn, …, .study-character-btn { display: flex }` beats the
  // UA's [hidden] display:none, so the hide MUST be restated at equal
  // specificity — the cascade trap that took the whole Study panel down on
  // 2026-08-14.
  assert(cssValue('.study-character-btn', 'display') === 'flex', 'setup: the pill sets its own display')
  assert(cssValue('.study-character-btn[hidden]', 'display') === 'none', 'the [hidden] restatement is missing — every machine with no character goals would show a dead CHARACTER pill')
  return 'hidden in the DOM, inert on press, and the CSS hide wins'
})

test('the collection is NOT trim-filtered — a MODEL switch changes shots, never what you carry', () => {
  for (const trim of ['pro', 'premium-le']) {
    withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, trim }), ({ host }) => {
      host.find('study-character-btn').dispatchEvent({ type: 'click' })
      const n = host.find('study-character-panel').findAll('study-character').length
      assert(n === 2, `trim ${trim}: expected both cards, got ${n}`)
    })
  }
  return 'two cards under both models'
})

// --- REAL DATASETS, including the owner's own machines ----------------------
{
  const dataDir = resolve(__dirname, '../../data')
  const read = (f) => JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'))
  // Counts MEASURED on disk 2026-08-15, then re-derived from the file by the
  // test itself — the literal is here so a dataset edit that changes what this
  // door shows fails loudly instead of silently re-baselining.
  const REAL = [
    ['dnd', 'dnd_goals.json', 5],
    ['jaws', 'jaws_goals.json', 3],
    ['venom', 'venom_goals.json', 3],
    ['tmnt', 'tmnt_goals.json', 3],
    ['bone-busters', 'bone_busters_goals.json', 0],
  ]
  for (const [name, file, want] of REAL) {
    const data = read(file)
    const state = fakeAppState()
    state.data = data
    state.machine = { id: name, name, shortTitle: name.toUpperCase(), resource: file.replace('.json', '') }
    withMountedStudy(state, ({ host }) => {
      test(`REAL ${name}: the CHARACTER pill is ${want ? 'visible, with one card per shipped goal' : 'hidden'}`, () => {
        const onDisk = data.goals.filter((g) => g.category === 'progression' && g.steps.length === 0)
        assert(onDisk.length === want, `the shipped dataset changed under this test: expected ${want} character goals on ${name}, found ${onDisk.length}`)
        assert(host.find('study-character-btn').hidden === (want === 0), `expected hidden=${want === 0} for ${name}`)
        if (want === 0) return `${name}: no character goal, no pill`
        host.find('study-character-btn').dispatchEvent({ type: 'click' })
        const cards = host.find('study-character-panel').findAll('study-character')
        assert(cards.length === want, `expected ${want} cards, got ${cards.length}`)
        assert(
          cards.map((c) => c.find('study-character-title').textContent).join(' | ') === onDisk.map((g) => g.title).join(' | '),
          'the cards are not the dataset\'s goals in the dataset\'s order',
        )
        // Every card must be able to say what its pieces DO — a card with a
        // title, pips and a summary is the failure mode a thin goal produces.
        for (let i = 0; i < cards.length; i++) {
          const how = cards[i].find('study-character-how')
          assert(how, `${name}: "${onDisk[i].title}" rendered with no instruction lines at all`)
          const lines = how.children.map((li) => li.textContent)
          assert(lines.join(' ') === (onDisk[i].instructions ?? []).join(' '), `${name}: "${onDisk[i].title}" did not render its lines verbatim`)
        }
        return `${name}: ${cards.length} cards — ${cards.map((c) => c.find('study-character-title').textContent).join(' | ')}`
      })
    })
  }

  test('the SECRET twin of a character select stays out — measured on the two machines that author both', () => {
    // dnd and tmnt each carry the same pre-game choice TWICE: once as a
    // 'secret' (the flipper-cycle trick) and once as 'progression' (what the
    // choice DOES). A rule that took every pathless goal would put both in the
    // sheet, and the duplicate would be the most obvious thing on screen.
    const pairs = [
      ['dnd_goals.json', 'class-select-flipper-cycle', 'character-and-city-select'],
      ['tmnt_goals.json', 'pregame-turtle-select', 'turtle-select-perks'],
    ]
    for (const [file, secretId, progressionId] of pairs) {
      const data = read(file)
      const secret = data.goals.find((g) => g.id === secretId)
      const progression = data.goals.find((g) => g.id === progressionId)
      assert(secret && progression, `setup: ${file} no longer authors both ${secretId} and ${progressionId}`)
      assert(secret.category === 'secret' && secret.steps.length === 0, `setup: ${secretId} is no longer a pathless secret`)
      assert(isCharacterGoal(progression) === true, `${progressionId} must be in the door`)
      assert(isCharacterGoal(secret) === false, `${secretId} is a SECOND copy of the same choice — it must not be`)
    }
    return 'dnd + tmnt: the progression copy in, the secret copy out'
  })

  test('the whole corpus, counted once: the door is conditional in practice, not in theory', () => {
    const catalog = JSON.parse(readFileSync(resolve(dataDir, 'catalog.json'), 'utf8'))
    let machines = 0
    let goals = 0
    for (const m of catalog) {
      const doc = JSON.parse(readFileSync(resolve(dataDir, `${m.resource}.json`), 'utf8'))
      const n = characterGoals(doc).length
      if (n > 0) machines += 1
      goals += n
    }
    // A door that opened on every machine, or on almost none, would be the
    // wrong shape for a conditional pill — this is the measurement that says
    // which it is. The numbers are pinned so a dataset edit has to say so.
    //
    // COUNTED OVER THE CATALOG, not over data/*.json, and the difference is
    // real: seven goal files on disk are not registered in catalog.json, and
    // six of them carry ten character goals between them. Those machines
    // cannot be selected in the app at all, so counting them would overstate
    // what this door reaches (148 across 79 on disk; 138 across 73 shipped before
    // Fallout; Fallout (2026-10-14) adds its character pick + S.P.E.C.I.A.L. -> 140 across 74).
    assert(machines === 74 && goals === 140, `expected 140 character goals across 74 catalog machines, found ${goals} across ${machines}`)
    assert(machines < catalog.length, 'setup: if every machine had one, this pill would not need to be conditional')
    return `${goals} character goals across ${machines} of ${catalog.length} machines`
  })
}

// ===========================================================================
section('u. In-sheet ‹ › (P8): the stepping the bottom bar cannot reach while a sheet covers it')
// ===========================================================================
// THE GAP THIS CLOSES: `.study-controls` sits at bottom:8px and the sheet
// covers the bottom 55dvh, so the bottom ‹ › are GEOMETRICALLY under the
// panel while a sheet is open — no z-index could ever fix that, and until now
// stepping-with-the-sheet-open worked by keyboard only. ui/study.ts's header
// documented it as a deliberate non-fix; this is the fix.

withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: ALL_PILL_GOALS }), ({ host }) => {
  test('LEARN shows a ‹ › pair inside the sheet, both real 44px targets, outside the swapped body', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const steps = host.find('study-sheet-steps')
    assert(steps, 'expected a .study-sheet-steps element in the sheet')
    assert(steps.hidden === false, 'expected them SHOWN for the LEARN kind')
    const btns = host.findAll('study-sheet-step')
    assert(btns.length === 2, `expected two ‹ › buttons, got ${btns.length}`)
    assert(btns[0].getAttribute('aria-label') === 'Previous shot', 'expected a real aria-label on ‹')
    assert(btns[1].getAttribute('aria-label') === 'Next shot', 'expected a real aria-label on ›')
    assert(!descends(host.find('study-learn-body'), btns[0]), 'the steppers must live outside the swapped body, like Back')
    const panel = host.find('study-learn-panel')
    assert(panel.children[0] === host.find('study-sheet-head'), 'the head must be the panel\'s FIRST child — below the body it would render under the content')
    assert(cssValue('.study-sheet-step', 'width') === '44px' && cssValue('.study-sheet-step', 'height') === '44px', 'the in-sheet steppers must be 44px targets')
    assert(cssValue('.study-sheet-head', 'height') === '44px', 'the head is a FIXED height, or the body top edge jumps between kinds')
  })

  test('pressing › inside the sheet moves the tour AND updates the body in place — same panel, same body element', () => {
    const panel = host.find('study-learn-panel')
    const body = host.find('study-learn-body')
    assert(panel.find('study-learn-title').textContent === 'Top Shot', 'setup: opened on the first tour shot')
    host.findAll('study-sheet-step')[1].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 2 OF 6', 'the tour must actually move')
    assert(host.find('study-learn-panel') === panel, 'the panel must survive (a new one replays the slide-up)')
    assert(host.find('study-learn-body') === body, 'the BODY must survive too — stepping is not a change of subject, so no fade')
    assert(panel.find('study-learn-title').textContent === 'Premium Only Shot', 'expected the body to follow the tour')
  })

  test('and ‹ goes back the other way, wrapping like the bottom bar does', () => {
    host.findAll('study-sheet-step')[0].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 1 OF 6', 'expected ‹ to step back')
    host.findAll('study-sheet-step')[0].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 6 OF 6', 'expected ‹ from shot 1 to WRAP to the last shot')
  })

  test('pressing › also moves the LIST\'s mark and reveals the row — the two halves cannot disagree', () => {
    // The merge's other direction: the stepper is a control over the detail,
    // but the list is showing the same tour position, so it has to follow.
    const rows = host.findAll('study-index-row')
    const markedBefore = rows.findIndex((r) => r.className.includes('study-index-row-current'))
    host.findAll('study-sheet-step')[1].dispatchEvent({ type: 'click' })
    const after = host.findAll('study-index-row')
    assert(after[0] === rows[0], 'the steppers must not rebuild the list')
    const markedAfter = after.findIndex((r) => r.className.includes('study-index-row-current'))
    assert(markedAfter === (markedBefore + 1) % rows.length, `expected the mark to follow the stepper (${markedBefore} -> ${markedAfter})`)
    assert(after[markedAfter].getAttribute('aria-current') === 'true', 'and aria-current with it')
    assert(after[markedAfter]._scrolls.length > 0, 'the newly current row must be brought into view')
    return `mark ${markedBefore} -> ${markedAfter}, revealed`
  })

  test('they HIDE for the four kinds whose content is not about the current shot', () => {
    for (const [pill, kindPanel] of [
      ['study-action-btn', 'study-ab-panel'],
      ['study-drills-btn', 'study-drills-panel'],
      ['study-altmodes-btn', 'study-altmodes-panel'],
      ['study-character-btn', 'study-character-panel'],
    ]) {
      host.find(pill).dispatchEvent({ type: 'click' })
      assert(host.find(kindPanel), `setup: expected ${kindPanel} showing`)
      assert(host.find('study-sheet-steps').hidden === true, `expected the in-sheet ‹ › hidden for ${kindPanel}`)
    }
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-sheet-steps').hidden === false, 'and shown again on the way back to LEARN')
    return 'shown for LEARN only'
  })

  test('the head is built ONCE: the same ‹ › elements survive every kind switch, like Back', () => {
    const btns = host.findAll('study-sheet-step')
    host.find('study-drills-btn').dispatchEvent({ type: 'click' })
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const after = host.findAll('study-sheet-step')
    assert(after[0] === btns[0] && after[1] === btns[1], 'the steppers were rebuilt by a swap — the head must be outside the body')
  })
})

withMountedStudy(fakeAppState({ shots: [] }), ({ host }) => {
  test('with no shots there is no sheet to step in, and the bottom bar is disabled — the two stay consistent', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'LEARN cannot open with no current shot')
    assert(host.findAll('study-step-btn').every((b) => b.disabled === true), 'the bottom ‹ › must be disabled')
  })
})

// ===========================================================================
section('v. FIVE kinds, ONE sheet (P8; ALT MODES 2026-08-14; ALL SHOTS absorbed + CHARACTER 2026-08-15): cycling never leaks a panel or a listener')
// ===========================================================================

withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: ALL_PILL_GOALS }), ({ host, doc }) => {
  test('LEARN -> ACTION -> DRILLS -> ALT MODES -> CHARACTER -> LEARN: one panel node throughout, one Escape listener, one backdrop', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-learn-panel')
    const backdrop = host.find('study-learn-backdrop')
    assert(doc._listenerCount('keydown') === 1, 'setup: exactly one Escape listener on open')

    for (const pill of ['study-action-btn', 'study-drills-btn', 'study-altmodes-btn', 'study-character-btn', 'study-learn-btn']) {
      host.find(pill).dispatchEvent({ type: 'click' })
      assert(host.find('study-learn-panel') === panel, `${pill} rebuilt the panel — that replays the slide-up`)
      assert(host.find('study-learn-backdrop') === backdrop, `${pill} rebuilt the backdrop`)
      assert(host.findAll('study-learn-panel').length === 1, `expected exactly one panel after ${pill}`)
      assert(doc._listenerCount('keydown') === 1, `${pill} left ${doc._listenerCount('keydown')} Escape listeners`)
    }
    assert(host.find('study-learn-title').textContent === 'Top Shot', 'expected to land back on LEARN content')
    return 'one panel, one backdrop, one listener across the full cycle'
  })

  test('each swap replaces the BODY (so the 120ms crossfade plays) and re-labels the dialog', () => {
    const kinds = [
      ['study-drills-btn', 'study-drills-title', 'study-drills-panel', false],
      ['study-altmodes-btn', 'study-altmodes-title', 'study-altmodes-panel', false],
      ['study-character-btn', 'study-characters-title', 'study-character-panel', false],
      ['study-action-btn', 'study-ab-title', 'study-ab-panel', false],
      ['study-learn-btn', 'study-learn-title', null, false],
    ]
    for (const [pill, labelId, panelClass, split] of kinds) {
      const before = host.find('study-learn-body')
      host.find(pill).dispatchEvent({ type: 'click' })
      const after = host.find('study-learn-body')
      assert(after !== before, `${pill} did not replace the body — the crossfade only runs on insertion`)
      assert(after.className.split(/\s+/).includes('study-learn-body-swap'), `${pill}'s fresh body is missing the fade class`)
      assert(host.find('study-learn-panel').getAttribute('aria-labelledby') === labelId, `${pill} did not move aria-labelledby to ${labelId}`)
      if (panelClass) assert(host.find(panelClass), `${pill} did not put ${panelClass} on the panel`)
      else {
        assert(
          !host.find('study-drills-panel') && !host.find('study-ab-panel') && !host.find('study-altmodes-panel') && !host.find('study-character-panel'),
          'LEARN must drop every other kind\'s modifier class',
        )
      }
      // The two-region split is RETIRED (rolo 2026-09-08): no kind carries
      // `.study-learn-split` any more, LEARN included — every body is one
      // scrolling document now.
      assert(
        after.className.split(/\s+/).includes('study-learn-split') === split,
        `${pill}: no body should carry .study-learn-split now, got ${JSON.stringify(after.className)}`,
      )
    }
  })

  test('Escape still closes whatever kind is showing, and takes the one listener with it', () => {
    for (const pill of ['study-drills-btn', 'study-altmodes-btn', 'study-character-btn']) {
      host.find(pill).dispatchEvent({ type: 'click' })
      assert(host.find('study-learn-panel'), `setup: ${pill} opened nothing`)
      doc._fireKey('Escape')
      assert(!host.find('study-learn-panel'), `expected Escape to close the ${pill} kind too`)
      assert(doc._listenerCount('keydown') === 0, 'expected the listener torn down')
    }
  })
})

withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON }), ({ host }) => {
  test('stepping after swapping AWAY from LEARN does not write into the discarded rows (the stale-row bug this guards)', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const oldRows = host.findAll('study-index-row')
    assert(oldRows.length === 6, 'setup: LEARN is open, with its list')
    host.find('study-drills-btn').dispatchEvent({ type: 'click' }) // swap away; rows are gone
    // The BOTTOM bar, because the in-sheet steppers are hidden for DRILLS —
    // same stepManual(), and the only stepping a user has from here.
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 2 OF 6', 'stepping must still work after leaving LEARN')
    // The discarded rows must NOT have been re-marked: they are detached, and
    // writing to them is the tell that the bookkeeping was not released.
    assert(oldRows[1].className === 'study-index-row', `a detached row was re-marked: ${JSON.stringify(oldRows[1].className)}`)
    assert(oldRows[1]._scrolls.length === 0, 'a detached row was scrolled into view — the reveal is not gated on the kind either')
  })
})

// A MODEL change with a shot-dependent body open — the tour is re-filtered
// underneath it, so both new bodies have to be rebuilt against the new tour.
{
  const state = fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON })
  withMountedStudy(state, ({ host }) => {
    test('MODEL premium-le -> pro with LEARN open: the list re-filters in place, still one panel', () => {
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      const panel = host.find('study-learn-panel')
      assert(panel.findAll('study-index-row').length === 6, 'setup: 6 rows under premium-le')
      state.trim = 'pro'
      state._notify()
      assert(host.find('study-learn-panel') === panel, 'the panel must survive a MODEL change')
      const names = host.find('study-learn-panel').findAll('study-index-name').map((n) => n.textContent)
      assert(names.length === 5, `expected 5 rows under pro, got ${names.length}`)
      assert(!names.includes('Premium Only Shot'), 'the premium-le shot must leave the list')
      const marked = host.find('study-learn-panel').findAll('study-index-row').filter((r) => r.className.includes('study-index-row-current'))
      assert(marked.length === 1, `expected the ✓ to survive the refilter on exactly one row, got ${marked.length}`)
      // ...and the DETAIL is rebuilt with it, still naming the marked shot.
      const markedName = marked[0].find('study-index-name').textContent
      assert(
        host.find('study-learn-panel').find('study-learn-title').textContent === markedName,
        'the detail and the mark must still agree after a re-filter',
      )
      return `6 -> 5 rows, mark intact, detail = ${markedName}`
    })

    test('a notify that does NOT change the tour leaves the list alone — the rows, and their scroll, are not collateral', () => {
      // AppState notifies for everything (a goal picked on the Shots tab, a
      // celebration slider), and this sheet survives a tab switch. Rebuilding
      // on every notify would throw the list's scroll position away because
      // somebody pressed something on another tab.
      const rows = host.find('study-learn-panel').findAll('study-index-row')
      state._notify()
      state._notify()
      const after = host.find('study-learn-panel').findAll('study-index-row')
      assert(after.length === rows.length, 'setup: the tour did not change')
      for (let i = 0; i < rows.length; i++) assert(after[i] === rows[i], `row ${i} was rebuilt by a notify that changed nothing`)
      return `${rows.length} rows survived two no-op notifies`
    })

    test('…and with DRILLS open, the jump buttons re-decide: the premium-le drill loses its "Study …"', () => {
      state.trim = 'premium-le'
      state._notify()
      host.find('study-drills-btn').dispatchEvent({ type: 'click' })
      assert(host.find('study-drills-panel').findAll('study-drill')[1].find('study-drill-link'), 'setup: the premium drill has its jump under premium-le')
      state.trim = 'pro'
      state._notify()
      const cards = host.find('study-drills-panel').findAll('study-drill')
      assert(!cards[1].find('study-drill-link'), 'the jump must disappear when the MODEL loses that shot')
      assert(cards[0].find('study-drill-link'), 'the all-trim drill keeps its jump')
    })
  })
}

// ===========================================================================
section('w. THE RAIL (P9): a two-column Study tab, and zero chrome on the card')
// ===========================================================================
// The owner's report was a screenshot: four solid amber pills sitting on
// Jaws's Orca deck. Every earlier pass treated that as a clearance problem
// (TOP_PAD reserved a band, STACK_CLEAR pushed the floating label around); it
// is a LAYOUT problem, and #study-host is a flex row now. These tests are the
// measurement that says so.

/** Advance width in CSS px of a pill label, from the SHIPPED font — the same
 *  fontTools measurement (hmtx/upm on ChakraPetch-Bold-latin.woff2) the
 *  earlier 320px test used, now at the two sizes the rail ships:
 *  12px/0.16em tracking, and 11px/0.12em under 360px. Re-measure if the face,
 *  size or tracking changes; the assertions below fail loudly if the CSS
 *  moves out from under these numbers. */
const PILL_TEXT_PX = {
  base: { LEARN: 47.8, 'ACTION BUTTON': 118.1, DRILLS: 52.3, 'ALT MODES': 83.2 },
  small: { LEARN: 40.6, 'ACTION BUTTON': 102.5, DRILLS: 45.3, 'ALT MODES': 72.3 },
}

/** Everything about the Study tab's boxes at a given viewport, derived from
 *  the CSS and the REAL playfieldRect — never from a copy of its math. */
function studyLayout(viewportW, viewportH) {
  const SHELL_CHROME = 154 // header 59 + ad slot 51 + tab bar 44; see section (l)
  const hostH = viewportH - SHELL_CHROME
  const rail = railWidthFor(viewportW)
  const canvasW = viewportW - rail
  const TOP_PAD = tsConst(studySrc, 'TOP_PAD', 'ui/study.ts')
  const BOTTOM_CLEARANCE = tsConst(studySrc, 'BOTTOM_CLEARANCE', 'ui/study.ts')
  const card = playfieldRect(canvasW, hostH - BOTTOM_CLEARANCE - TOP_PAD)
  card.y += TOP_PAD / 2
  return { hostH, rail, canvasW, card, cardRight: card.x + card.w }
}

test('the rail fits the WIDEST pill at both type sizes — it is measured, not a fraction of the viewport', () => {
  const padBase = Number(/(\d+(?:\.\d+)?)px/.exec(cssValue('.study-action-btn', 'padding').split(/\s+/)[1])[1])
  const railPad = (side) => Number(/(\d+(?:\.\d+)?)px/.exec(cssValue('.study-rail', `padding-${side}`))[1])
  const gutters = railPad('right') + railPad('left')

  for (const [band, viewport, pad] of [
    ['base', 390, padBase],
    ['small', 320, 10],
  ]) {
    const rail = railWidthFor(viewport)
    for (const [label, text] of Object.entries(PILL_TEXT_PX[band])) {
      const needed = text + pad * 2 + gutters
      assert(
        needed <= rail,
        `at ${viewport}px the rail is ${rail}px but '${label}' needs ${needed.toFixed(1)}px (${text} of type + ${pad * 2} pill padding + ${gutters} rail gutters) — the label would wrap or clip`,
      )
    }
    // ...and not WILDLY oversized either: a rail with 30px of slack is 30px
    // of playfield thrown away.
    const widest = Math.max(...Object.values(PILL_TEXT_PX[band])) + pad * 2 + gutters
    assert(rail - widest <= 12, `the rail is ${(rail - widest).toFixed(1)}px wider than its widest pill needs — that is playfield`)
  }
  // The owner's "right 1/6" is intent, not arithmetic: a literal sixth cannot
  // hold the labels, and this records why the spec's number was not taken.
  assert(RAIL_W > 390 / 6, `a literal 1/6 of a 390px phone is 65px; the widest label alone needs ${PILL_TEXT_PX.base['ACTION BUTTON'].toFixed(0)}px of type`)
  return `rail ${railWidthFor(390)}px (>=360px) / ${railWidthFor(320)}px (<360px), widest label fits both`
})

test('the canvas is narrowed by EXACTLY the rail, and the card is re-centred in what is left', () => {
  const { canvasW, card } = studyLayout(390, 844)
  assert(canvasW === 390 - railWidthFor(390), `expected the canvas to be the viewport minus the rail, got ${canvasW}`)
  // Re-centred, not merely shifted: playfieldRect centres in the width it is
  // given, so the card's left and right gutters inside the canvas must match.
  const leftGutter = card.x
  const rightGutter = canvasW - (card.x + card.w)
  assert(Math.abs(leftGutter - rightGutter) < 0.5, `card not centred in the canvas column: ${leftGutter.toFixed(1)} vs ${rightGutter.toFixed(1)}`)
  return `canvas ${canvasW}px, card ${card.w.toFixed(0)}x${card.h.toFixed(0)} centred with ${leftGutter.toFixed(1)}px gutters`
})

test('ZERO overlap: at 320, 390 and 430 the card ends before the rail begins', () => {
  const rows = []
  for (const [vw, vh] of [
    [320, 568],
    [390, 844],
    [430, 932],
  ]) {
    const { canvasW, card, cardRight, rail } = studyLayout(vw, vh)
    // The pills are rail children, so the leftmost pixel any pill can occupy
    // is the rail's own left padding.
    const railPadLeft = Number(/(\d+(?:\.\d+)?)px/.exec(cssValue('.study-rail', 'padding-left'))[1])
    const pillLeft = canvasW + railPadLeft
    assert(cardRight <= canvasW, `at ${vw}px the card runs to ${cardRight.toFixed(1)} but the canvas ends at ${canvasW}`)
    assert(pillLeft >= cardRight, `at ${vw}px a pill can start at ${pillLeft} which is inside the card (ends ${cardRight.toFixed(1)})`)
    rows.push(`${vw}: card->${cardRight.toFixed(0)} | rail@${canvasW} pill@${pillLeft} (${(pillLeft - cardRight).toFixed(0)}px clear)`)
  }
  return rows.join(' ; ')
})

test('the pills are IN the rail — not absolutely positioned back over the canvas', () => {
  // The geometric test above only holds while the pills are in flow. This is
  // the structural half: nothing in the pill/rail cascade may position itself
  // out of the column and back onto the playfield.
  for (const sel of ['.study-rail', '.study-learn-btn', '.study-action-btn', '.study-drills-btn', '.study-altmodes-btn', '.study-character-btn', '.study-pill-stack']) {
    const pos = cssValue(sel, 'position')
    assert(pos === null || pos === 'relative' || pos === 'static', `${sel} is \`position: ${pos}\` — a positioned pill can be painted anywhere, including back on the card`)
    assert(cssValue(sel, 'left') === null && cssValue(sel, 'right') === null, `${sel} sets an inset offset, which only means anything for a positioned box escaping the column`)
  }
  assert(cssValue('#study-host', 'display') === 'flex', '#study-host must be the flex row the two columns live in')
  assert(cssValue('#study-host', 'flex-direction') === 'row', 'expected a row, or the rail is stacked above the canvas rather than beside it')
  assert(cssValue('.study-canvas', 'flex') === '1', 'the canvas must take everything the rail does not')
  assert(cssValue('.study-canvas', 'min-width') === '0', 'without min-width:0 a flex canvas refuses to shrink and pushes the rail off-screen')
  return 'rail + 5 pills + the stack all in flow'
})

test('THE MOUNTED CANVAS agrees: the real render fits the card inside the narrowed column', () => {
  // Recorded canvas coordinates, not the formula above: two dots pin the
  // card's real rect (the section (l) pattern), and the card must sit wholly
  // inside the canvas element's own width.
  let dots = null
  withMountedStudy(fakeAppState(), ({ calls }) => {
    dots = dotPositions(calls)
  })
  assert(dots.length === 6, `expected 6 recorded inserts, got ${dots.length}`)
  const xs = dots.map((d) => d.x)
  const canvasW = W - RAIL_W
  assert(Math.max(...xs) <= canvasW, `a shot is drawn at x=${Math.max(...xs).toFixed(1)}, past the canvas's right edge (${canvasW})`)
  // s-mid-left (u 0.2) and s-mid-right (u 0.8) pin the card's width exactly.
  const tour = buildTour(SHOTS, 'premium-le')
  const iLeft = tour.findIndex((t) => t.id === 's-mid-left')
  const iRight = tour.findIndex((t) => t.id === 's-mid-right')
  const cardW = (dots[iRight].x - dots[iLeft].x) / 0.6
  const cardLeft = dots[iLeft].x - 0.2 * cardW
  assert(cardLeft >= 0, `the card starts at x=${cardLeft.toFixed(1)}, off the left edge`)
  assert(cardLeft + cardW <= canvasW + 0.5, `the card runs to ${(cardLeft + cardW).toFixed(1)} but the canvas ends at ${canvasW}`)
  return `card x ${cardLeft.toFixed(1)}..${(cardLeft + cardW).toFixed(1)} inside a ${canvasW}px canvas (host ${W})`
})

test("the BACKING STORE is sized from the canvas box, not the host's", () => {
  // The failure this catches is invisible in every other assertion here: if
  // resize() keeps sizing the backing store from the HOST, the canvas element
  // is `hostW - rail` CSS px wide but its bitmap is `hostW * dpr`, so the
  // browser squashes the drawing horizontally and every tap lands off-target.
  // The drawn COORDINATES would still look right to the rest of this suite,
  // because render() reads the canvas box — which is exactly why the two have
  // to be pinned together.
  let backing = null
  let box = null
  withMountedStudy(fakeAppState(), ({ host }) => {
    const canvas = host.find('study-canvas')
    backing = { w: canvas.width, h: canvas.height }
    box = { w: canvas.clientWidth, h: canvas.clientHeight }
  })
  const dpr = 1 // the harness's fake window
  assert(box.w === W - RAIL_W, `setup: the fake layout should give the canvas ${W - RAIL_W}px, got ${box.w}`)
  assert(backing.w === Math.round(box.w * dpr), `backing store is ${backing.w}px wide for a ${box.w}px canvas — it is still being sized from the host (${W})`)
  assert(backing.h === Math.round(box.h * dpr), `backing store is ${backing.h}px tall for a ${box.h}px canvas`)
  return `backing ${backing.w}x${backing.h} = canvas box ${box.w}x${box.h} at dpr ${dpr}`
})

test('the label band collapsed with the pills: LABEL_TOP_MARGIN, not a stack depth', () => {
  const margin = tsConst(studySrc, 'LABEL_TOP_MARGIN', 'ui/study.ts')
  assert(margin > 0 && margin <= 16, `expected a small top margin, got ${margin}`)
  // The dead constants must be GONE, not merely unused — a stale STACK_CLEAR
  // is the next person's false lead about what the layout does.
  assert(!/const STACK_CLEAR\b/.test(studySrc), 'STACK_CLEAR still exists; the pills are not over the canvas any more')
  assert(!/stackClearFor/.test(studySrc), 'stackClearFor still exists')
  assert(!/study-top-row|study-btn-col/.test(stylesSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'the old floating row/col rules are still in styles.css')
  // And the label logic actually uses it.
  assert(
    /drawCurrentLabel\(ctx, current, map\(current\.x, current\.y\), LABEL_TOP_MARGIN, rect\)/.test(studySrc),
    'the floating label is not being placed against LABEL_TOP_MARGIN',
  )
  return `LABEL_TOP_MARGIN ${margin}`
})

test('a label near the TOP of the card is no longer flipped below its dot — the band that pushed it there is gone', () => {
  // s-top sits at v 0.9, near the card's top edge. Under the old 192px band
  // its name was drawn BELOW the dot; with the band at LABEL_TOP_MARGIN it is
  // drawn above, which is the whole user-visible point of the collapse.
  const margin = tsConst(studySrc, 'LABEL_TOP_MARGIN', 'ui/study.ts')
  let labelY = null
  let dotY = null
  withMountedStudy(fakeAppState(), ({ calls }) => {
    const hits = calls.filter((c) => c.method === 'fillText' && c.args[0] === 'Top Shot')
    labelY = hits.length ? hits[hits.length - 1].args[2] : null
    dotY = dotPositions(calls)[0].y
  })
  assert(labelY !== null, 'expected the current shot name to be drawn')
  assert(dotY - 15 >= margin + 10, `setup: the top shot's dot (y=${dotY.toFixed(0)}) must clear the ${margin}px band for this test to mean anything`)
  assert(labelY < dotY, `expected the name ABOVE its dot (label ${labelY.toFixed(0)}, dot ${dotY.toFixed(0)}) — it is still being pushed below`)
  assert(Math.abs(labelY - (dotY - 15)) < 0.01, `expected the standard 15px-above placement, got ${(dotY - labelY).toFixed(1)}px`)
  return `label ${labelY.toFixed(0)} = dot ${dotY.toFixed(0)} - 15, above the dot`
})

test('LEARN LEADS THE RAIL, and it is the one pill that must clear the open sheet', () => {
  // WHAT THIS USED TO MEASURE, and why it changed. The order was grouped by
  // SCOPE — shot-scoped LEARN and ALL SHOTS above machine-scoped ACTION BUTTON
  // and DRILLS — because aligning the rail to the card's top edge (the owner's
  // P9 request) moves every pill down by the card's top gutter, which on a
  // 667px viewport is 38 rather than 12, and that pushes the THIRD pill under
  // the 55dvh sheet. ALL SHOTS had to be above it: it was the one surface you
  // were explicitly meant to reach WITH a sheet open.
  //
  // Since the merge (2026-08-15) that surface is INSIDE the LEARN sheet, so the
  // requirement collapses onto one pill in slot 0 — and the arithmetic below is
  // still run, because "slot 0 clears" is a claim about the alignment offset
  // and the sheet height, not a tautology.
  let pillOrder = []
  withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: ALT_GOALS }), ({ host }) => {
    // Read from `.study-pill-stack`, not the rail: the pills live in their own
    // scroll box (2026-08-15 — see the stack's own rule in styles.css).
    pillOrder = host
      .find('study-pill-stack')
      .children.map((c) => String(c.className).trim().split(/\s+/)[0])
      .filter((c) => c.endsWith('-btn'))
  })
  assert(pillOrder.length === 7, `expected seven pills in the rail (QUIZ ME joined 2026-10-14), got ${JSON.stringify(pillOrder)}`)
  const slotOf = (cls) => pillOrder.indexOf(cls)
  // HOW IT PLAYS leads, LEARN second, CHARACTER third (rolo 2026-09-08), then
  // ACTION -> DRILLS -> ALT MODES.
  assert(slotOf('study-howitplays-btn') === 0, `HOW IT PLAYS must lead the rail, got slot ${slotOf('study-howitplays-btn')}`)
  assert(slotOf('study-learn-btn') === 1, `LEARN must be second, got slot ${slotOf('study-learn-btn')}`)
  assert(slotOf('study-character-btn') === 2, `CHARACTER must be third, got slot ${slotOf('study-character-btn')}`)
  assert(
    slotOf('study-character-btn') < slotOf('study-action-btn') &&
      slotOf('study-action-btn') < slotOf('study-drills-btn') &&
      slotOf('study-drills-btn') < slotOf('study-altmodes-btn'),
    `expected CHARACTER -> ACTION BUTTON -> DRILLS -> ALT MODES, got ${JSON.stringify(pillOrder)}`,
  )

  // The card is height-limited at 667px, so its top edge — which the rail's
  // alignment spacer tracks — is playfieldRect's MARGIN (8) + TOP_PAD/2.
  const TOP_PAD = tsConst(studySrc, 'TOP_PAD', 'ui/study.ts')
  const cardTop = 8 + TOP_PAD / 2
  const pillH = Number(/(\d+)px/.exec(cssValue('.study-learn-btn', 'height'))[1])
  const gap = Number(/(\d+)px/.exec(cssValue('.study-pill-stack', 'gap'))[1])
  const bottomOf = (slot) => cardTop + (slot + 1) * pillH + slot * gap
  const hostH = 667 - 154 // shell chrome, see section (l)
  const panelTop = hostH - 0.55 * 667

  const firstBottom = bottomOf(0)
  assert(
    firstBottom <= panelTop,
    `the lead pill ends ${firstBottom}px down but the sheet starts at ${panelTop.toFixed(1)} — the first pill you must be able ` +
      `to press while a sheet is open would be under it. Either the pill order regressed or the alignment offset grew.`,
  )
  // The check that keeps this honest: the THIRD slot does not clear, so "slot
  // 0" is a real constraint rather than a free win, and a future pill that
  // needs mid-sheet access cannot simply be appended.
  assert(
    bottomOf(2) > panelTop,
    'this test no longer discriminates: the third slot would ALSO clear the sheet, so the pill order is free',
  )
  return `card top ${cardTop}: lead pill (slot 0) ends ${firstBottom} <= sheet ${panelTop.toFixed(0)}; slot 2 would end ${bottomOf(2)} (covered)`
})

test("THE FIRST PILL'S TOP EDGE IS THE CARD'S TOP EDGE, at every viewport the card is fitted differently", () => {
  // OWNER, 2026-08-14: "Move the buttons down in the study tab so that the top
  // of the first button aligns with the top of the playfield. Right now
  // buttons are above the playfield."
  //
  // The offset is `.study-rail-spacer`'s HEIGHT, published by the draw path.
  // (It was the rail's own `padding-top` until LEVEL v2 — see that rule's note
  // for why an unconditional padding clipped the column on a short deck card.)
  // So the check is: the number ui/study.ts publishes must equal the card's
  // REAL drawn top edge, recovered from recorded canvas coordinates — the same
  // two-dot recovery section (l) uses, never a re-derivation of the formula
  // under test. Both a height-limited fit (short viewports, top gutter =
  // MARGIN) and a width-limited one (tall viewports, the spare height splits
  // above and below) are covered, because they produce very different numbers
  // and an offset that only tracked one of them would look aligned on a phone
  // and wrong on a tablet.
  assert(
    cssValue('.study-rail-spacer', 'height') === 'var(--study-card-top, 12px)',
    `.study-rail-spacer must take its height from the published card top, got ${JSON.stringify(cssValue('.study-rail-spacer', 'height'))}`,
  )
  assert(cssValue('.study-rail-spacer', 'order') === '-1', 'the spacer must be the column\'s FIRST item, or it pushes the wrong things down')
  assert(cssValue('.study-rail', 'padding-top') === '0', `the rail must not ALSO pad the top, or the offset is applied twice (got ${JSON.stringify(cssValue('.study-rail', 'padding-top'))})`)
  // ...and the spacer must be the ONLY thing that yields when the column runs
  // out of room. Every other rail child holds its size, so the whole deficit
  // lands here and no control is ever clipped.
  // SHRINKABLE, AND FIRST IN LINE. The factor is 1000 rather than 1 since
  // 2026-08-15: `.study-pill-stack` is shrinkable too now, and flexbox splits
  // a deficit in proportion to shrink-factor x base size — at factor 1 the
  // spacer would keep ~23px of purely cosmetic alignment at 390x553 while the
  // pills scrolled two of themselves out of sight. The ORDER of yielding is
  // the contract; the magnitude is just how it is spelled.
  const spacerShrink = Number(cssValue('.study-rail-spacer', 'flex').split(/\s+/)[1])
  const stackShrink = Number(cssValue('.study-pill-stack', 'flex').split(/\s+/)[1])
  assert(cssValue('.study-rail-spacer', 'flex').startsWith('0 '), `the spacer must be shrinkable, got ${JSON.stringify(cssValue('.study-rail-spacer', 'flex'))}`)
  assert(spacerShrink > 0 && stackShrink > 0, 'both the spacer and the pill stack must be able to yield')
  assert(
    spacerShrink >= stackShrink * 100,
    `the spacer (shrink ${spacerShrink}) must collapse well before the pill stack (shrink ${stackShrink}) — alignment is cosmetic, a control you cannot reach is not`,
  )
  assert(cssValue('.study-rail-spacer', 'min-height') === '0', 'without min-height:0 a flex item refuses to shrink below its own height')
  assert(cssValue('.study-pill-stack', 'min-height') === '0', 'without min-height:0 the stack pushes LEVEL/MODEL out of the rail instead of scrolling')
  assert(cssValue('.study-pill-stack', 'overflow-y') === 'auto', 'the pill stack must SCROLL when it cannot fit, not be clipped by the rail')
  for (const sel of ['.study-learn-btn', '.study-action-btn', '.study-drills-btn', '.study-altmodes-btn', '.study-character-btn']) {
    assert(cssValue(sel, 'flex-shrink') === '0', `${sel} must not shrink — a squashed pill is a broken tap target; the STACK scrolls instead`)
  }
  // ...and the pinned two never yield, whatever the viewport. (It was three
  // until the eyebrow was removed on 2026-08-15.)
  for (const sel of ['.study-level-group', '.study-model-group']) {
    const f = cssValue(sel, 'flex') ?? ''
    const shrink = cssValue(sel, 'flex-shrink') ?? f.split(/\s+/)[1]
    assert(String(shrink) === '0', `${sel} must stay pinned at full size (got shrink ${JSON.stringify(shrink)})`)
  }
  assert(cssValue('.study-level-group', 'flex-shrink') === '0', 'the LEVEL control must not shrink — it is the control this whole pass exists to keep reachable')

  const rows = []
  for (const [vw, vh] of [
    [320, 568],
    [390, 844],
    [430, 932],
    [390, 667],
    [390, 553],
  ]) {
    let published = null
    let dots = null
    withMountedStudy(fakeAppState(), ({ host, calls }) => {
      published = host.style.getPropertyValue('--study-card-top')
      dots = dotPositions(calls)
    }, { viewportW: vw, viewportH: vh })

    assert(published, `no --study-card-top published at ${vw}x${vh}`)
    const publishedPx = Number(/(-?\d+(?:\.\d+)?)px/.exec(published)[1])

    // Recover the card's real rect from two dots: map(u,v).y = rect.y + rect.h
    // - v*rect.h, so the v=0.9 and v=0.1 shots pin rect.y and rect.h exactly.
    const tour = buildTour(SHOTS, 'premium-le')
    const iTop = tour.findIndex((t) => t.id === 's-top') // v 0.9
    const iBottom = tour.findIndex((t) => t.id === 's-bottom') // v 0.1
    const rectH = (dots[iBottom].y - dots[iTop].y) / 0.8
    const cardTop = dots[iTop].y - 0.1 * rectH

    const dpr = 1 // the harness's fake window
    assert(
      Math.abs(publishedPx - cardTop) <= 1 / dpr,
      `at ${vw}x${vh} the rail is padded to ${publishedPx} but the card is drawn at ${cardTop.toFixed(2)} — the first pill would sit ${(cardTop - publishedPx).toFixed(1)}px ${cardTop > publishedPx ? 'ABOVE' : 'below'} the playfield`,
    )
    // Snapped to whole device pixels, or two edges that "align" land on
    // different physical rows.
    assert(publishedPx * dpr === Math.round(publishedPx * dpr), `${publishedPx}px is not a whole device pixel at dpr ${dpr}`)
    rows.push(`${vw}x${vh}: ${publishedPx}`)
  }
  // The two fits really are different, or this test proves one case twice.
  const values = new Set(rows.map((r) => r.split(': ')[1]))
  assert(values.size > 1, `every viewport produced the same card top (${[...values]}) — the width-limited case is not being exercised`)
  return rows.join(' ; ')
})

test('the published value is written ONLY when it changes — a custom property per frame is a style recalc per frame', () => {
  let writes = 0
  withMountedStudy(fakeAppState(), ({ host, step }) => {
    const style = host.style
    const real = style.setProperty
    style.setProperty = (...a) => {
      writes += 1
      return real(...a)
    }
    // Twenty shuffle frames with no resize: the card cannot move, so nothing
    // may be republished.
    for (let i = 1; i <= 20; i++) step(i * 100)
  })
  assert(writes === 0, `expected no republish across 20 static frames, got ${writes}`)
})

/** Rail-child heights in CSS px, MEASURED in real Chrome on the built app
 *  (2026-08-15, 390x667 and 390x553, Jaws) — the same provenance rule
 *  PILL_TEXT_PX follows for font advances. Re-measure if any of these rules
 *  change their type, padding or control sizes; the assertions below fail
 *  loudly if the counts move out from under them.
 *
 *  `eyebrow: 29.2` is gone with the element (2026-08-15), and LEVEL's own
 *  margin-top went from 8px to `auto` when it took over as the rail's foot
 *  anchor — an auto margin contributes 0 to the column's HEIGHT REQUIREMENT,
 *  which is what this model is about, so it simply leaves the sum. */
const RAIL_BOX_PX = { levelGroup: 91, modelGroup: 61, modelMarginTop: 8 }

/** The FIVE-pill column height, MEASURED IN CHROME (2026-08-15, Jaws on the
 *  built app, CHARACTER landed): stack 212 + LEVEL 91 + MODEL 61 + MODEL's 8px
 *  margin + three 8px rail gaps. The model below must reproduce it. It was 352
 *  with four pills; one pill plus one stack gap is 44 more.
 *
 *  The name still says 390 because that is the WIDTH the rail's own numbers are
 *  for (`--study-rail-w` steps down below 360). The Chrome run that produced it
 *  pinned the app root to each viewport HEIGHT rather than opening a 390-wide
 *  window — that Chrome would not open a window shorter than 337px of viewport
 *  — which exercises the identical flex layout, because the rail is a fixed
 *  158px column at every width down to 360. */
const RAIL_COLUMN_390 = 396

test('SIX PILLS: with howItPlays the stack scrolls to keep every control reachable, nothing cut', () => {
  // One net new pill since the 5-pill baseline: HOW IT PLAYS added, the LIGHTS
  // pill folded back into LEARN (2026-09-08), so six show at once. The model
  // below (columnFor) is calibrated against Chrome at FIVE pills
  // (RAIL_COLUMN_390); pills are uniform so the per-pill term extrapolates. This
  // test asserts the INVARIANT — when the column over-fills, the pill STACK
  // scrolls (overflow-y auto) while LEVEL and MODEL stay pinned (flex-shrink: 0)
  // and at least three whole pills stay on screen — and asserts the tight height
  // (553) over-fills. Exact px shrink is re-checked in the Chrome walk at 6
  // pills rather than hard-coded from the stale 7-pill measurement.
  const SHELL_CHROME = 154 // header 59 + ad slot 51 + tab bar 44; see section (l)
  const px = (sel, prop) => Number(/(-?\d+(?:\.\d+)?)px/.exec(cssValue(sel, prop))[1])
  const pillH = px('.study-learn-btn', 'height')
  const gap = px('.study-rail', 'gap')
  const stackGap = px('.study-pill-stack', 'gap')
  const padBottom = px('.study-rail', 'padding-bottom')
  assert(stackGap === gap, `the stack gap (${stackGap}) must match the rail's (${gap})`)
  assert(cssValue('.study-level-group', 'margin-top') === 'auto', 'LEVEL must carry the column\'s one auto margin (the rail\'s foot anchor)')
  assert(px('.study-model-group', 'margin-top') === RAIL_BOX_PX.modelMarginTop, 'MODEL margin-top moved; re-measure RAIL_BOX_PX')

  let pills = 0
  let railKids = 0
  withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    pills = host.find('study-pill-stack').children.length
    railKids = host.find('study-rail').children.length
  })
  assert(pills === 7, `expected seven pills with howItPlays (QUIZ ME joined 2026-10-14), got ${pills}`)
  assert(railKids === 4, `expected four rail children (spacer, stack, LEVEL, MODEL), got ${railKids}`)

  const pinned = RAIL_BOX_PX.levelGroup + RAIL_BOX_PX.modelGroup + RAIL_BOX_PX.modelMarginTop
  const columnFor = (n) => n * pillH + (n - 1) * stackGap + pinned + (railKids - 1) * gap
  assert(Math.abs(columnFor(5) - RAIL_COLUMN_390) <= 1, `the model says the five-pill column is ${columnFor(5).toFixed(1)}px; Chrome measured ${RAIL_COLUMN_390}`)
  const six = columnFor(6)

  const rows = []
  for (const vh of [667, 553]) {
    const railBox = vh - SHELL_CHROME
    const content = railBox - padBottom
    const deficit = Math.max(0, six - content)
    const visibleStack = content - pinned - (railKids - 1) * gap
    const wholePills = Math.floor((visibleStack + stackGap) / (pillH + stackGap))
    if (deficit > 0) {
      // Whenever the column over-fills, the STACK scrolls (asserted below) and
      // at least three whole pills stay reachable — never a peephole.
      assert(wholePills >= 3, `at 390x${vh} only ${wholePills} whole pill(s) of the stack are on screen (${visibleStack.toFixed(1)}px) — a peephole, not a scroll`)
    }
    rows.push(`${vh}: column ${six.toFixed(1)} vs content ${content.toFixed(1)} -> ${deficit > 0 ? `stack scrolls ${deficit.toFixed(1)}px (${wholePills} pills visible)` : 'fits'}, LEVEL+MODEL pinned`)
  }
  // The tight phone height MUST over-fill — that is the case the scroll exists
  // for; if six pills fit at 553 the whole scroll path is untested.
  {
    const content553 = 553 - SHELL_CHROME - padBottom
    assert(six - content553 > 0, `at 390x553 six pills (${six.toFixed(1)}px) must exceed the ${content553.toFixed(1)}px content box so the stack scrolls`)
  }
  assert(cssValue('.study-pill-stack', 'overflow-y') === 'auto', 'the pills must scroll when the column over-fills')
  assert(cssValue('.study-rail', 'overflow') === 'hidden', 'the rail still clips — which is exactly why the stack must be able to scroll')
  return rows.join(' ; ')
})

test('.study-rail passes taps through, and every CONTROL in it takes them back', () => {
  // Same recipe and same reason as .study-controls: the rail is a full-height
  // column whose lower two-thirds is empty, and a column that swallows events
  // is a column that cannot be dragged over.
  assert(cssValue('.study-rail', 'pointer-events') === 'none', `.study-rail pointer-events is ${JSON.stringify(cssValue('.study-rail', 'pointer-events'))}, expected "none"`)
  let mounted = []
  withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: ALL_PILL_GOALS }), ({ host }) => {
    const rail = host.find('study-rail')
    assert(rail, 'expected a .study-rail element')
    mounted = rail.children.map((c) => String(c.className).trim().split(/\s+/)[0]).filter(Boolean)
  })
  assert(mounted.length === 4, `expected the alignment spacer + the pill stack + the LEVEL group + the MODEL group in the rail, got ${JSON.stringify(mounted)}`)
  assert(!mounted.includes('study-eyebrow'), 'the eyebrow was removed 2026-08-15 — "the text study jaws under the buttons is unnecessary"')
  // ...and the five pills live INSIDE the stack, which is the one child that
  // is allowed to hold more (2026-08-15).
  let stacked = []
  withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: ALL_PILL_GOALS }), ({ host }) => {
    stacked = host.find('study-pill-stack').children.map((c) => String(c.className).trim().split(/\s+/)[0])
  })
  assert(stacked.length === 7, `expected seven pills inside .study-pill-stack (QUIZ ME joined 2026-10-14), got ${JSON.stringify(stacked)}`)
  // The LEVEL and MODEL groups are WRAPPERS — their own buttons take pointer
  // events back, not the container, exactly like .study-rail itself. The spacer
  // is an empty aria-hidden box and must stay pass-through: it sits directly
  // over the canvas's top gutter, and a spacer that ate taps would kill
  // tap-to-inspect for every shot near the top of the card.
  assert(cssValue('.study-rail-spacer', 'pointer-events') === null, 'the spacer must inherit the rail\'s pass-through — it must never take a tap')
  const wrappers = ['study-level-group', 'study-model-group', 'study-rail-spacer']
  for (const cls of mounted.filter((c) => !wrappers.includes(c))) {
    assert(
      cssValue(`.${cls}`, 'pointer-events') === 'auto',
      `.${cls} is a child of the pass-through .study-rail but never sets pointer-events:auto — it is mounted but untappable`,
    )
  }
  assert(cssValue('.study-level-arrow', 'pointer-events') === 'auto', 'the LEVEL ‹ › must take pointer events back')
  assert(cssValue('.study-model-btn', 'pointer-events') === 'auto', 'the MODEL PRO / PREM-LE pair must take pointer events back')
  return `${mounted.length} rail children: ${mounted.join(', ')}`
})

// ===========================================================================
section('x. Shape-aware tap-to-inspect (P8): Study measures the drawn insert, exactly like the Shots tab')
// ===========================================================================

test('ui/study.ts calls map2d.ts\'s insertHitDistance — it does not hand-roll a second hit test', () => {
  assert(/insertHitDistance\(insertShapeFor\(entry\.shot\.type\), entry\.point, INSERT_DRAW_RADIUS, x, y\)/.test(studySrc), 'expected the shared helper at the tap site')
  assert(!/Math\.hypot\(lastShotPoints/.test(studySrc), 'the old point-radius test is still in the tap path')
  assert(/from '\.\.\/overlay\/map2d'/.test(studySrc), 'expected the helper to be imported, not copied')
})

test('the INSERT_SHAPE MIRROR IS GONE — map2d.ts exports the table and study.ts imports it', () => {
  // WHAT THIS REPLACED: a parity gate that parsed both files and compared 25
  // rows, because map2d.ts's table was private and ui/study.ts carried a
  // hand-kept copy. Its own failure message told the next person the real fix
  // was one word — `export` — and 2026-08-14 is when that happened. The gate
  // now asserts the DUPLICATION IS GONE rather than that two copies still
  // agree, which is the stronger statement and needs no parser.
  const map2dSrc = readFileSync(map2dPath, 'utf8')
  assert(/export const INSERT_SHAPE: Record<string, InsertShape> = \{/.test(map2dSrc), 'map2d.ts must EXPORT the insert-shape table')
  assert(/export function insertShapeFor\(/.test(map2dSrc), 'map2d.ts must export the resolver that owns the lower-casing and the dot fallback')
  assert(!/const INSERT_SHAPE/.test(studySrc), 'ui/study.ts still declares its own INSERT_SHAPE — the mirror is back')
  assert(!/insertShapeForType/.test(studySrc), "ui/study.ts still has its own shape resolver")
  assert(/insertShapeFor/.test(studySrc) && /from '\.\.\/overlay\/map2d'/.test(studySrc), 'ui/study.ts must import the shared resolver')
  // And the table still has to be the real thing, not an emptied stub.
  const rows = [...map2dSrc.matchAll(/^\s*'?[\w-]+'?:\s*'(diamond|bar|ring|blade|arrow|chevron|cluster|dot)',?\s*$/gm)]
  assert(rows.length >= 20, `expected the full shape table in map2d.ts, found ${rows.length} rows`)
  return `one table, ${rows.length} rows, exported from map2d.ts`
})

// The behavioural half: a tap at a shape's real visual EXTENT registers, where
// a point-radius test measured from the centre would have been the same
// distance for a shot that draws nothing out there.
withMountedStudy(fakeAppState(), ({ host, calls }) => {
  test('a tap at the far edge of a wide BAR insert (a standup) hits it — the drawn box is the target', () => {
    const dots = dotPositions(calls)
    assert(dots.length === 6, `expected 6 recorded inserts, got ${dots.length}`)
    // Tour index 3 is s-mid-left, type 'standup' -> the 'bar' shape, whose
    // metrics span 1.35r horizontally. A tap 1.3r to its right is INSIDE the
    // drawn bar and 6px from the centre point.
    const target = dots[3]
    const canvas = host.find('study-canvas')
    canvas.dispatchEvent({ type: 'click', clientX: target.x + 1.3 * 4.6, clientY: target.y })
    assert(host.find('study-readout-label').textContent === 'SHOT 4 OF 6', `expected the bar-shaped shot to take the tap, got ${JSON.stringify(host.find('study-readout-label').textContent)}`)
  })
})

withMountedStudy(fakeAppState(), ({ host, calls }) => {
  test('a tap in a RING insert\'s hole still hits it (the hole is a graphic, not a gap in the target)', () => {
    // No 'ring'-typed shot in the fixture, so this proves the rule the helper
    // implements rather than a fixture coincidence: the ring is hit-tested as
    // a FILLED disc, so its centre — where nothing is painted — is distance 0.
    const d = insertHitDistance('ring', { x: 100, y: 100 }, 4.6, 100, 100)
    assert(d === 0, `expected 0 at a ring's centre, got ${d}`)
    // And the identical claim on the surface: tapping a dot's exact centre
    // still selects it, i.e. adopting the shape rule did not break the
    // ordinary case section (c) already covers.
    const dots = dotPositions(calls)
    const canvas = host.find('study-canvas')
    canvas.dispatchEvent({ type: 'click', clientX: dots[5].x, clientY: dots[5].y })
    assert(host.find('study-readout-label').textContent === 'SHOT 6 OF 6', 'a centre tap must still select')
  })
})

// ===========================================================================
section('y. A11Y on a sheet that stays open (P8 review): focus, aria-current, announcement, Tab trap')
// ===========================================================================
// WHAT WAS ALREADY TRUE, pinned here so the review's two hypotheses cannot be
// re-asked: a list row tap does NOT re-render the list (markIndexRows edits
// className/aria-current/✓ on the SAME nodes), so focus is not dropped
// AND the ✓ is not stale — section (s) proves both. What was MISSING was any
// announcement: the tour moves behind a sheet that deliberately stays open,
// and the readout that says so is outside the dialog and is not a live region.

withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON }), ({ host, advanceTimers }) => {
  /** Past the coalescing window, so a test reads the SETTLED announcement.
   *  Real users' taps are seconds apart; only a burst lands inside one
   *  window, and the burst is section (ab)'s subject. */
  const settle = () => advanceTimers(ANNOUNCE_WINDOW_MS + 50)

  test('the sheet mounts ONE polite live region, on the panel and outside the swapped body', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-learn-panel')
    const live = panel.findAll('sr-only')
    assert(live.length === 1, `expected exactly one .sr-only region in the sheet, got ${live.length}`)
    assert(live[0].getAttribute('role') === 'status', 'expected role="status" (polite), not an assertive alert')
    assert(!descends(host.find('study-learn-body'), live[0]), 'a live region inside the swapped body would be destroyed and re-created on every kind switch')
    // It must exist BEFORE any text is written into it — a region inserted in
    // the same tick as its content is announced unreliably.
    assert(live[0].textContent === '', `expected the region to mount empty, got ${JSON.stringify(live[0].textContent)}`)
  })

  test('tapping a row announces the jump politely: "Shot 4 of 6 — Mid Left"', () => {
    host.find('study-learn-panel').findAll('study-index-row')[3].dispatchEvent({ type: 'click' })
    settle()
    const live = host.find('study-learn-panel').find('sr-only')
    assert(live.textContent === 'Shot 4 of 6 — Mid Left', `expected the spoken position and name, got ${JSON.stringify(live.textContent)}`)
    // Sentence case, not the readout's 'SHOT 4 OF 6': this string is only ever
    // spoken, and all-caps runs are spelled out or shouted by some voices.
    assert(!/SHOT \d+ OF/.test(live.textContent), 'the announcement must not be the shouted readout string')
    return live.textContent
  })

  test('the tapped row is the one marked aria-current, and it still holds focus (no re-render)', () => {
    const rows = host.find('study-learn-panel').findAll('study-index-row')
    rows[2].focus()
    rows[2].dispatchEvent({ type: 'click' })
    settle()
    assert(rows[2].getAttribute('aria-current') === 'true', 'the tapped row must be aria-current="true"')
    assert(rows.filter((r) => r.getAttribute('aria-current') === 'true').length === 1, 'exactly one row may be aria-current')
    assert(domActiveElement === rows[2], 'the row must still hold focus — the ✓ moves by EDITING nodes, never rebuilding them')
    assert(host.find('study-learn-panel').find('sr-only').textContent === 'Shot 3 of 6 — Deck Shot', 'and the announcement follows')
  })

  test("DRILLS' \"Study …\" gets the same treatment: tour moves, sheet stays, jump announced", () => {
    host.find('study-drills-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-drills-panel')
    const link = panel.findAll('study-drill')[0].find('study-drill-link')
    link.focus()
    link.dispatchEvent({ type: 'click' })
    settle()
    assert(host.find('study-drills-panel') === panel, 'the sheet must stay open')
    assert(domActiveElement === link, 'focus must stay on the link (the drills body is not rebuilt by a jump)')
    assert(host.find('study-learn-panel').find('sr-only').textContent === 'Shot 1 of 6 — Top Shot', `expected the jump announced, got ${JSON.stringify(host.find('study-learn-panel').find('sr-only').textContent)}`)
  })

  test('the in-sheet ‹ › announce too — LEARN changes content a sighted user can see and a screen reader could not', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    host.findAll('study-sheet-step')[1].dispatchEvent({ type: 'click' })
    settle()
    assert(host.find('study-learn-panel').find('sr-only').textContent === 'Shot 2 of 6 — Premium Only Shot', 'expected the step announced')
  })
})

// THE ONE PATH THAT DOES REPLACE THE ROWS: a MODEL change re-filters the tour,
// so an open LEARN body is rebuilt. A row tap never gets here (it edits), but
// this path throws away the node the user is standing on.
{
  const state = fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON })
  withMountedStudy(state, ({ host }) => {
    test('when a MODEL change DOES rebuild the list, focus lands on the new CURRENT row — not on Back, and not on nothing', () => {
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      const rows = host.find('study-learn-panel').findAll('study-index-row')
      rows[4].dispatchEvent({ type: 'click' }) // tour -> Mid Right (index 4)
      rows[4].focus()
      assert(domActiveElement === rows[4], 'setup: focus is on a row that is about to be destroyed')

      state.trim = 'pro'
      state._notify()

      const after = host.find('study-learn-panel').findAll('study-index-row')
      assert(after[0] !== rows[0], 'setup: the list really was rebuilt by the MODEL change')
      const currentIdx = after.findIndex((r) => r.className.includes('study-index-row-current'))
      assert(currentIdx !== -1, 'expected a marked row after the refilter')
      assert(
        domActiveElement === after[currentIdx],
        'focus must be re-homed to the row the tour is on — Back is the fallback, not the answer, and <body> would strand the user outside an aria-modal dialog',
      )
      assert(domActiveElement !== host.find('study-learn-back'), 'specifically NOT the generic Back fallback')
      return `rebuilt list, focus on row ${currentIdx} (${after[currentIdx].find('study-index-name').textContent})`
    })

    test('…and for a kind with no equivalent row, the Back fallback still applies', () => {
      host.find('study-drills-btn').dispatchEvent({ type: 'click' })
      const link = host.find('study-drills-panel').findAll('study-drill')[0].find('study-drill-link')
      link.focus()
      state.trim = 'premium-le'
      state._notify()
      assert(domActiveElement === host.find('study-learn-back'), 'a rebuilt DRILLS body has no "current" card, so focus goes to Back rather than to <body>')
    })
  })
}

// THE TAB TRAP. This panel has declared aria-modal="true" since P4 while
// handling Escape only — survivable when Back was its ONLY focusable, a real
// leak now that a body can hold a dozen.
withMountedStudy(fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, goals: ALT_GOALS }), ({ host, doc }) => {
  /** The tab ring as a BROWSER would see it — which is what the trap has to
   *  agree with. A `hidden` element is `display: none`, so it and EVERYTHING
   *  UNDER IT are untabbable: this walk therefore does not descend into a
   *  hidden subtree. (Written the shallow way first, which is how the
   *  `hidden` stepper GROUP — whose two buttons are not themselves marked
   *  hidden — ended up in the expected ring and disagreed with the code.) */
  const focusablesIn = (panel) => {
    const out = []
    const walk = (el) => {
      for (const c of el.children) {
        if (c.hidden) continue
        if (c.tagName === 'BUTTON' && c.disabled !== true) out.push(c)
        walk(c)
      }
    }
    walk(panel)
    return out
  }

  test('every kind traps Tab: from the LAST focusable it wraps to the FIRST, and Shift+Tab back', () => {
    for (const [pill, kind] of [
      ['study-learn-btn', 'LEARN'],
      ['study-action-btn', 'ACTION BUTTON'],
      ['study-drills-btn', 'DRILLS'],
      ['study-altmodes-btn', 'ALT MODES'],
      ['study-character-btn', 'CHARACTER'],
    ]) {
      host.find(pill).dispatchEvent({ type: 'click' })
      const panel = host.find('study-learn-panel')
      const f = focusablesIn(panel)
      assert(f.length >= 1, `${kind}: expected at least one focusable in the sheet`)
      f[f.length - 1].focus()
      assert(doc._fireKey('Tab') === true, `${kind}: Tab from the last focusable must be prevented, not allowed out of an aria-modal dialog`)
      assert(domActiveElement === f[0], `${kind}: Tab from the last focusable must wrap to the first`)
      f[0].focus()
      assert(doc._fireKey('Tab', { shiftKey: true }) === true, `${kind}: Shift+Tab from the first must be prevented`)
      assert(domActiveElement === f[f.length - 1], `${kind}: Shift+Tab from the first must wrap to the last`)
    }
    return 'all four kinds wrap in both directions'
  })

  test('a Tab from OUTSIDE the open sheet is pulled back in (the leak in the other direction)', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const outside = host.find('study-learn-btn') // a pill, visually behind the sheet
    outside.focus()
    assert(doc._fireKey('Tab') === true, 'expected the Tab to be intercepted')
    assert(descends(host.find('study-learn-panel'), domActiveElement), 'focus must land back inside the dialog')
  })

  test('Tab in the MIDDLE of the list is left alone — a trap that hijacks every Tab is not a trap, it is a cage', () => {
    const panel = host.find('study-learn-panel')
    const f = focusablesIn(panel)
    assert(f.length > 2, 'setup: need an interior focusable')
    f[1].focus()
    assert(doc._fireKey('Tab') === false, 'an interior Tab must be allowed through to the browser')
    assert(domActiveElement === f[1], 'and the handler must not move focus itself')
  })

  test('hidden controls are skipped, so the wrap never targets something untabbable', () => {
    // The in-sheet steppers sit in a `hidden` GROUP for every kind but LEARN.
    // The buttons themselves carry no hidden flag — display:none on the parent
    // is what takes them out of the tab order — so a ring built by looking at
    // each button in isolation would include them and the wrap would put focus
    // on an invisible control.
    host.find('study-drills-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-sheet-steps').hidden === true, 'setup: the stepper GROUP is hidden for DRILLS')
    assert(host.findAll('study-sheet-step')[0].hidden === false, 'setup: the buttons themselves are not individually hidden — that is the trap')
    const f = focusablesIn(host.find('study-learn-panel'))
    assert(!f.includes(host.findAll('study-sheet-step')[0]), 'a stepper inside a hidden group must not be in the tab ring')
    f[f.length - 1].focus()
    doc._fireKey('Tab')
    assert(domActiveElement === f[0], 'the wrap target must be a visible, enabled control')
  })

  test('the tab ring excludes exactly what a BROWSER excludes: hidden subtrees AND disabled controls', () => {
    // The hidden half is exercised behaviourally above. The disabled half is
    // NOT reachable through today's UI — the only controls this sheet ever
    // disables are the in-sheet steppers, and they are disabled only when the
    // tour is empty, which is also the one case where they are hidden. So it
    // is pinned at the source rather than left as an untested branch: a ring
    // that includes a disabled control makes the wrap call focus() on
    // something the browser refuses to focus, and the trap then fails
    // SILENTLY (focus simply stays put, one Tab from leaking).
    const fn = /function focusableWithin\(root: HTMLElement\): HTMLElement\[\] \{[\s\S]*?\n  \}\n/.exec(studySrc)
    assert(fn, 'ui/study.ts no longer has a focusableWithin — the Tab trap has nothing to walk')
    assert(/if \(child\.hidden\) continue/.test(fn[0]), 'the ring must skip a hidden element AND its subtree (display:none is inherited by children that carry no flag of their own)')
    assert(/disabled !== true/.test(fn[0]), 'the ring must skip disabled buttons, or the wrap targets a control the browser will not focus')
    return 'hidden subtrees + disabled controls both excluded'
  })

  test('focus parked on an untabbable control inside the sheet is pulled back to a real stop, not leaked', () => {
    // The case the branch above covers: activeElement is INSIDE the panel but
    // not in the ring (a stepper in the hidden group). Tab must not fall
    // through to the page behind an aria-modal dialog.
    const stepper = host.findAll('study-sheet-step')[1]
    stepper.focus()
    assert(doc._fireKey('Tab') === true, 'expected the Tab to be intercepted')
    assert(domActiveElement === focusablesIn(host.find('study-learn-panel'))[0], 'expected focus pulled to the first real stop')
  })
})

// ===========================================================================
section('z. MACHINE SWITCH while a sheet is open (P8 review)')
// ===========================================================================
// The designed behaviour is CLOSE, for every kind — all four bodies are about
// the machine that was showing, and for DRILLS/ACTION the new machine may have
// no such content at all, so "carry it across" would have to vanish on some
// switches and not others. ui/study.ts's syncFromState documents the choice.

{
  // A BAND PROBE SHOT, and why it has to exist. The only observable effect of
  // the exclusion band is whether the floating name is drawn ABOVE its dot or
  // pushed BELOW it, and the two bands (2 pills = 104, 4 pills = 192) only
  // disagree for a dot in a narrow horizontal strip. At this harness's 900px
  // host the drawn card runs y = 845.75 - 807.5v, so v = 0.84 puts a dot at
  // y ~ 167 — inside the strip, where four pills push the label down and two
  // do not. Without it the test passes vacuously against any band at all, and
  // the assertion below fails LOUDLY rather than silently if it ever drifts
  // out of the strip.
  const BAND_SHOTS = [...SHOTS, { id: 's-band', name: 'Band Probe', type: 'lane', x: 0.45, y: 0.84, trim: 'all' }]
  // Machine A: drills + actionButton + flagged goals = FOUR pills.
  // Machine B: none of the three = ONE.
  const state = fakeAppState({ drills: DRILLS, actionButton: ACTION_BUTTON, shots: BAND_SHOTS, goals: ALL_PILL_GOALS })
  withMountedStudy(state, ({ host, calls }) => {
    test('every kind closes on a machine switch — deliberately, and the same way each time', () => {
      for (const pill of ['study-learn-btn', 'study-action-btn', 'study-drills-btn', 'study-altmodes-btn', 'study-character-btn']) {
        // Re-arm: a fresh machine each time, so each kind is tested against a
        // real switch rather than an already-closed sheet.
        state.machine = { ...makeMachine(), id: `m-${pill}` }
        state._notify()
        host.find(pill).dispatchEvent({ type: 'click' })
        assert(host.find('study-learn-panel'), `setup: ${pill} opened a sheet`)
        state.machine = { ...makeMachine(), id: `after-${pill}` }
        state._notify()
        assert(!host.find('study-learn-panel'), `${pill}: the sheet must close on a machine switch`)
        assert(!host.find('study-learn-backdrop'), `${pill}: the backdrop must go with it`)
      }
      return 'all five kinds close'
    })

    test('the switch leaves nothing behind: no Escape listener, no live region, no index rows', () => {
      // Proven from the outside: a key event that would have closed a sheet is
      // inert, and re-opening builds a NEW panel rather than resurrecting one.
      const panelsBefore = host.findAll('study-learn-panel').length
      assert(panelsBefore === 0, `expected no panel after the switch, got ${panelsBefore}`)
      // The SHEET's region goes with the sheet. The TAB's own region (added
      // with the LEVEL feature, for announcements that happen with no sheet
      // open) is mounted once and stays — so the count drops to one, not zero.
      assert(host.findAll('sr-only').length === 1, `expected only the tab's own live region to remain, got ${host.findAll('sr-only').length}`)
      assert(!host.find('study-learn-panel'), 'and no panel to hold a second one')
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      assert(host.findAll('study-learn-panel').length === 1, 'expected exactly one panel on re-open')
      host.find('study-learn-back').dispatchEvent({ type: 'click' })
    })

    test('the label band does not depend on the machine at all any more — the pills left the canvas', () => {
      // WHAT THIS REPLACED: a measurement that the exclusion band tracked the
      // NEW machine's pill count, because the band used to BE the pill stack's
      // depth and a stale one would have drawn labels under a pill. With the
      // rail there is no per-machine band left to go stale — the constant is
      // the whole story, and that is a stronger guarantee than the test it
      // replaces, so it is asserted as an absence.
      const margin = tsConst(studySrc, 'LABEL_TOP_MARGIN', 'ui/study.ts')
      assert(!/visiblePillCount/.test(studySrc), 'the pill count still feeds canvas geometry somewhere')
      assert(
        !new RegExp(`drawCurrentLabel\\([^)]*(?:actionBtn|drillsBtn|pill)`, 'i').test(studySrc),
        'the label placement still reads the pills',
      )

      // And behaviourally: switch from a four-pill machine to a one-pill one
      // and the label for the same shot is drawn in the SAME place.
      const labelY = () => {
        const hits = calls.filter((c) => c.method === 'fillText' && c.args[0] === 'Top Shot')
        return hits.length ? hits[hits.length - 1].args[2] : null
      }
      state.machine = { ...makeMachine(), id: 'band-a' }
      state._notify()
      const many = labelY()
      state.data = makeData(BAND_SHOTS, [DECK_ZONE], null, [])
      state.machine = { ...makeMachine(), id: 'band-b' }
      state._notify()
      assert(
        host.find('study-drills-btn').hidden === true &&
          host.find('study-action-btn').hidden === true &&
          host.find('study-altmodes-btn').hidden === true,
        'setup: the new machine shows one pill',
      )
      const one = labelY()
      assert(many !== null && one !== null, 'expected the label drawn on both machines')
      assert(Math.abs(many - one) < 0.01, `the label moved (${many.toFixed(1)} -> ${one.toFixed(1)}) when the pill count changed — the band is still coupled to the rail`)
      return `LABEL_TOP_MARGIN ${margin}, label y ${one.toFixed(0)} on both a 4-pill and a 1-pill machine`
    })
  })
}

// ===========================================================================
section('aa. The free-prose focus chip cannot overflow its card (P8 review)')
// ===========================================================================

/** The longest `focus` value authored across the five machines that have
 *  drills, and its MEASURED width. From app/public/fonts/
 *  ChakraPetch-SemiBold-latin.woff2 (hmtx/upm) at the chip recipe's 10px with
 *  0.1em letter-spacing — the same fontTools measurement the pill widths in
 *  section (w) come from. Re-measure if the face, size or tracking changes. */
const LONGEST_FOCUS = 'Sequencing discipline before chasing anything else'
const LONGEST_FOCUS_PX = 292.1

test('the longest AUTHORED focus value really is the one pinned here, and it is prose (not an enum member)', () => {
  const dataDir = resolve(__dirname, '../../data')
  const values = []
  for (const f of readdirSync(dataDir)) {
    if (!f.endsWith('_goals.json')) continue
    for (const d of JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')).drills ?? []) {
      if (d.focus) values.push(d.focus)
    }
  }
  assert(values.length > 0, 'expected some authored focus values in app/../data')
  const longest = values.reduce((a, b) => (b.length > a.length ? b : a))
  // Pinned by LENGTH, not by width: this test's job is to notice when the data
  // grows a longer string than the one the measurement below was taken for.
  assert(
    longest.length <= LONGEST_FOCUS.length,
    `a longer focus value has been authored (${longest.length} chars: ${JSON.stringify(longest)}) than the ${LONGEST_FOCUS.length} this test measured — re-measure LONGEST_FOCUS_PX`,
  )
  // And the finding that killed the plan's colour-coded enum, kept honest.
  assert(new Set(values).size > 4, `focus is supposed to be free prose; found only ${new Set(values).size} distinct values — if it has become a closed vocabulary, colour the chip by value`)
  return `${values.length} values, ${new Set(values).size} distinct, longest ${longest.length} chars`
})

test('that value OVERFLOWS a 320px card unless the chip is allowed to wrap — so the guard is load-bearing', () => {
  // Every box read from the CSS as shipped, outermost in: the panel is
  // left:0/right:0 in #study-host, so at a 320px viewport it is 320 wide.
  const pad = (sel, i) => Number(/(\d+(?:\.\d+)?)px/.exec(cssValue(sel, 'padding').split(/\s+/)[i])[1])
  const border = (sel) => Number(/(\d+(?:\.\d+)?)px/.exec(cssValue(sel, 'border') || '0px')[1])
  const bodyBox = 320 - pad('.study-learn-body', 1) * 2
  const cardBox = bodyBox - pad('.study-drill', 1) * 2 - border('.study-drill') * 2
  const chipBox = cardBox - pad('.study-learn-chip', 1) * 2 - border('.study-learn-chip') * 2
  assert(
    LONGEST_FOCUS_PX > chipBox,
    `the longest authored focus (${LONGEST_FOCUS_PX}px) now FITS the ${chipBox}px chip box — this test no longer proves the wrap is needed`,
  )
  return `320px -> body ${bodyBox} -> card ${cardBox} -> chip text box ${chipBox}; longest value ${LONGEST_FOCUS_PX}px`
})

test('the chip carries all three properties that make overflow impossible for ANY string', () => {
  // Not "fits today" — cannot overflow, for arbitrary future dataset strings.
  assert(cssValue('.study-drill-focus', 'max-width') === '100%', 'without max-width the chip is free to be wider than the card')
  assert(
    cssValue('.study-drill-focus', 'min-width') === '0',
    'the chip is a FLEX ITEM of .study-learn-chips, whose default min-width:auto refuses to shrink below its content — max-width alone does not hold it',
  )
  assert(
    cssValue('.study-drill-focus', 'overflow-wrap') === 'anywhere',
    'normal wrapping breaks at SPACES, so one long unbroken token would still spill; overflow-wrap:anywhere is what makes this hold for data nobody has authored yet',
  )
  // A nowrap anywhere in the chip's cascade would defeat all three.
  for (const sel of ['.study-drill-focus', '.study-learn-chip']) {
    assert(cssValue(sel, 'white-space') !== 'nowrap', `${sel} must not force a single line — the chip has to be allowed to wrap`)
  }
  // And the alternative that was rejected must not be half-applied: an
  // ellipsis with no title is content silently truncated on a touch device.
  assert(cssValue('.study-drill-focus', 'text-overflow') === null, 'this chip wraps rather than ellipsizing — see its CSS comment for why (title is inert on touch)')
})

withMountedStudy(fakeAppState({ drills: [{ id: 'd-long', title: 'Longest Focus', text: 'x', focus: LONGEST_FOCUS }] }), ({ host }) => {
  test('and the real longest value renders VERBATIM in the chip — not truncated in JS on the way in', () => {
    host.find('study-drills-btn').dispatchEvent({ type: 'click' })
    const chip = host.find('study-drills-panel').find('study-drill-focus')
    assert(chip, 'expected the focus chip')
    assert(chip.textContent === LONGEST_FOCUS, `expected the value verbatim, got ${JSON.stringify(chip.textContent)}`)
    assert(chip.getAttribute('title') === null, 'no title attribute: the text is all visible, so a tooltip would be duplicate content')
  })
})

// ===========================================================================
section('ab. Announce coalescing + per-instance ownership (P8 final review)')
// ===========================================================================

/** Counts WRITES to a live region rather than sampling its value: the whole
 *  claim is about how many times a screen reader is handed something new,
 *  which a final-value assertion cannot see. An own accessor shadows
 *  FakeElement's prototype one. */
function countWrites(el) {
  const writes = []
  let value = el.textContent
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get: () => value,
    set: (v) => {
      value = v
      writes.push(v)
    },
  })
  return writes
}

withMountedStudy(fakeAppState(), ({ host, advanceTimers, pendingTimerCount }) => {
  test('A SINGLE move announces IMMEDIATELY — no debounce delay on the common case', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const live = host.find('study-learn-panel').find('sr-only')
    const writes = countWrites(live)
    host.find('study-learn-panel').findAll('study-index-row')[2].dispatchEvent({ type: 'click' })
    // Before ANY timer runs.
    assert(writes.length === 1, `expected the first move to be spoken immediately, got ${writes.length} writes`)
    assert(writes[0] === 'Shot 3 of 6 — Deck Shot', `got ${JSON.stringify(writes[0])}`)
    // The window is open, but with nothing pending it must not write again.
    advanceTimers(ANNOUNCE_WINDOW_MS + 50)
    assert(writes.length === 1, `a lone move must not be re-announced on the trailing edge, got ${JSON.stringify(writes)}`)
    assert(pendingTimerCount() === 0, 'and the window must close rather than re-arming for ever')
    return `1 write, immediate: ${writes[0]}`
  })
})

withMountedStudy(fakeAppState(), ({ host, advanceTimers, pendingTimerCount }) => {
  test('AN 8-MOVE BURST inside one window collapses to 2 writes: the first, and the last', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const live = host.find('study-learn-panel').find('sr-only')
    const writes = countWrites(live)
    const next = host.findAll('study-step-btn')[1]

    // Eight moves with no clock advance at all — the burst a held ›, or an
    // autorepeating key, actually produces.
    for (let i = 0; i < 8; i++) next.dispatchEvent({ type: 'click' })
    assert(writes.length === 1, `only the LEADING write may have landed during the burst, got ${writes.length}`)

    advanceTimers(ANNOUNCE_WINDOW_MS + 50)
    // ceil(8 moves / 1 window) + 1 = 2 — the leading edge plus one trailing.
    const BOUND = Math.ceil(8 / 8) + 1
    assert(writes.length <= BOUND, `expected at most ${BOUND} writes for an 8-move burst, got ${writes.length}: ${JSON.stringify(writes)}`)
    assert(writes.length === 2, `expected exactly the leading and the trailing write, got ${JSON.stringify(writes)}`)

    // THE FINAL TEXT IS CORRECT — coalescing must never lose the destination.
    // 8 steps from shot 1 wraps the 6-shot tour: 1 -> 3.
    assert(host.find('study-readout-label').textContent === 'SHOT 3 OF 6', 'setup: the tour really moved 8 times')
    assert(writes[writes.length - 1] === 'Shot 3 of 6 — Deck Shot', `the trailing write must carry the LAST position, got ${JSON.stringify(writes[writes.length - 1])}`)
    assert(live.textContent === writes[writes.length - 1], 'and the region must be left holding it')

    // THE CHAIN TERMINATES. A flush that spoke something opens one more window
    // (that re-arm is what holds a sustained hold to one announcement per
    // window — see flushAnnounce); the flush after it finds nothing pending
    // and stops. So a quiet tour is timer-free within two windows, and never
    // re-arms for ever.
    assert(pendingTimerCount() === 1, 'the trailing flush re-arms exactly one window')
    advanceTimers(ANNOUNCE_WINDOW_MS + 50)
    assert(pendingTimerCount() === 0, 'and the empty window closes rather than re-arming again')
    assert(writes.length === 2, 'the empty flush must not write anything')
    return `8 moves -> ${writes.length} writes: ${JSON.stringify(writes)}`
  })
})

withMountedStudy(fakeAppState(), ({ host, advanceTimers }) => {
  test('a burst SPANNING windows still speaks per window, not per move', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const live = host.find('study-learn-panel').find('sr-only')
    const writes = countWrites(live)
    const next = host.findAll('study-step-btn')[1]
    // Three windows' worth: 4 moves, tick, 4 moves, tick, 4 moves, tick.
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 4; i++) next.dispatchEvent({ type: 'click' })
      advanceTimers(ANNOUNCE_WINDOW_MS + 10)
    }
    assert(writes.length <= 4, `12 moves across 3 windows must not produce 12 announcements, got ${writes.length}`)
    // 12 steps around a 6-shot tour lands back on shot 1 — and the region has
    // to be holding THAT, not some position from the middle of the burst.
    assert(host.find('study-readout-label').textContent === 'SHOT 1 OF 6', 'setup: 12 steps wrap the 6-shot tour exactly twice')
    assert(live.textContent === 'Shot 1 of 6 — Top Shot', `expected the region to hold the settled position, got ${JSON.stringify(live.textContent)}`)
    return `12 moves across 3 windows -> ${writes.length} writes, settled on ${JSON.stringify(live.textContent)}`
  })
})

// ---- INSTANCE OWNERSHIP (verification asks) --------------------------------
// Two Study tabs mounted at once is not a shipped configuration; it is the
// cheapest way to ASK whether anything here is module-scoped. A singleton live
// region or a shared ring would announce one tab's jump out of the other's
// dialog, and neither failure is visible with a single instance on screen.
{
  const stateA = fakeAppState()
  const stateB = fakeAppState({ shots: SHOTS.slice(0, 3) })
  withMountedStudy(stateA, ({ host: hostA, advanceTimers }) => {
    withMountedStudy(stateB, ({ host: hostB }) => {
      test('(a) each panel instance owns its OWN role=status region — not a module singleton', () => {
        hostA.find('study-learn-btn').dispatchEvent({ type: 'click' })
        hostB.find('study-learn-btn').dispatchEvent({ type: 'click' })
        const liveA = hostA.find('study-learn-panel').find('sr-only')
        const liveB = hostB.find('study-learn-panel').find('sr-only')
        assert(liveA && liveB, 'expected a live region in each open sheet')
        assert(liveA !== liveB, 'the two sheets share ONE live region — a module singleton would announce one tab out of the other')
        // Two per instance now: the tab's own persistent one, and the open
        // sheet's. Both must still be PER INSTANCE — that is the claim.
        assert(hostA.findAll('sr-only').length === 2 && hostB.findAll('sr-only').length === 2, `expected the tab + sheet region per instance, got ${hostA.findAll('sr-only').length}/${hostB.findAll('sr-only').length}`)
        for (const el of hostA.findAll('sr-only')) assert(!hostB.findAll('sr-only').includes(el), 'a live region is shared between two mounted tabs')

        // And writing in one must not touch the other.
        hostA.find('study-learn-panel').findAll('study-index-row')[2].dispatchEvent({ type: 'click' })
        advanceTimers(ANNOUNCE_WINDOW_MS + 50)
        assert(liveA.textContent === 'Shot 3 of 6 — Deck Shot', `expected A's own announcement, got ${JSON.stringify(liveA.textContent)}`)
        assert(liveB.textContent === '', `instance B's region must be untouched, got ${JSON.stringify(liveB.textContent)}`)
        return 'two instances, two regions, no crosstalk'
      })

      test('(b) the trap ring is per-instance state: each sheet wraps within ITS OWN panel', () => {
        // The rings are genuinely different sizes here (B's machine has three
        // shots, A's has six), so a module-scoped ring would visibly wrap one
        // sheet using the other's controls.
        const ringOf = (panel) => {
          const out = []
          const walk = (el) => {
            for (const c of el.children) {
              if (c.hidden) continue
              if (c.tagName === 'BUTTON' && c.disabled !== true) out.push(c)
              walk(c)
            }
          }
          walk(panel)
          return out
        }
        const ringA = ringOf(hostA.find('study-learn-panel'))
        const ringB = ringOf(hostB.find('study-learn-panel'))
        assert(ringA.length !== ringB.length, `setup: the two rings must differ (got ${ringA.length} and ${ringB.length})`)
        for (const el of ringA) assert(!ringB.includes(el), 'the two rings share a control — they cannot be per-instance')
        // Source-level, because "no module-scoped ring" is a claim about
        // absence: the ring is computed inside the handler from the instance's
        // own sheetPanel, and never cached anywhere a second mount could see.
        assert(
          /const focusable = focusableWithin\(sheetPanel\)/.test(studySrc),
          'the ring must be recomputed per keydown from THIS instance’s panel',
        )
        assert(
          !/^let (focusable|ring|lastRing)\b/m.test(studySrc),
          'a module-scoped ring cache would be shared by every mounted Study tab',
        )
        return `rings ${ringA.length} vs ${ringB.length}, disjoint`
      })
    })
  })
}

// ===========================================================================
section('ac. Playfield label CLAMPING (P9 follow-up): no name runs off the card')
// ===========================================================================
// OWNER, with a screenshot of Jaws: the current-shot name rendered as "ip's
// Wheel Spinner" — "make sure the names of sections on playfields don't
// disappear over the edge". The shot sits at u 0.198, the label centres on the
// dot, and the text box ran past the card's left edge. The vertical flip had
// been there since the label was written; there was no horizontal guard at all.

const drawingSrc = readFileSync(drawingPath, 'utf8')
const map2dSrcText = readFileSync(map2dPath, 'utf8')

/** A fake ctx that measures exactly like the harness's recordingCtx, so a
 *  width computed here is the width the assertions below read back. */
const measuringCtx = { measureText: (t) => ({ width: String(t).length * 6 }) }

test('cardXBounds derives the CARD edges from the MapFn every renderer already has, minus the pad', () => {
  // A card from x=100 to x=300, i.e. the closure study.ts and map2d.ts build.
  const rect = { x: 100, y: 0, w: 200, h: 400 }
  const map = (u, v) => ({ x: rect.x + u * rect.w, y: rect.y + rect.h - v * rect.h })
  const b = cardXBounds(map)
  assert(b.left === rect.x + LABEL_EDGE_PAD, `expected left ${rect.x + LABEL_EDGE_PAD}, got ${b.left}`)
  assert(b.right === rect.x + rect.w - LABEL_EDGE_PAD, `expected right ${rect.x + rect.w - LABEL_EDGE_PAD}, got ${b.right}`)
  return `card ${rect.x}..${rect.x + rect.w} -> bounds ${b.left}..${b.right} (pad ${LABEL_EDGE_PAD})`
})

test('clampLabelCenterX moves the TEXT BOX inside, leaves a fitting label alone, and centres one that cannot fit', () => {
  const bounds = { left: 100, right: 300 }
  const text = 'ABCDEFGHIJ' // 10 chars -> 60px wide, half 30
  // Already inside: untouched, because a label that fits must not drift.
  assert(clampLabelCenterX(measuringCtx, text, 200, bounds) === 200, 'a fitting label must not move')
  // Off the left edge: pushed just far enough that its box starts at left.
  assert(clampLabelCenterX(measuringCtx, text, 0, bounds) === 130, `expected 130, got ${clampLabelCenterX(measuringCtx, text, 0, bounds)}`)
  // Off the right edge.
  assert(clampLabelCenterX(measuringCtx, text, 999, bounds) === 270, `expected 270, got ${clampLabelCenterX(measuringCtx, text, 999, bounds)}`)
  // Wider than the bounds: centred, so it loses the same amount at both ends
  // rather than all of it at one.
  const huge = 'X'.repeat(80) // 480px
  assert(clampLabelCenterX(measuringCtx, huge, 0, bounds) === 200, 'an unfittable label must centre')
})

// --- THE REAL REPRO -------------------------------------------------------
{
  const jaws = JSON.parse(readFileSync(resolve(__dirname, '../../data/jaws_goals.json'), 'utf8'))
  const REPRO = "Ship's Wheel Spinner"
  const repro = jaws.shots.find((sh) => sh.name === REPRO)

  test(`the reported shot is still in the dataset where the screenshot found it (${REPRO})`, () => {
    assert(repro, `data/jaws_goals.json no longer has a shot named ${JSON.stringify(REPRO)} — re-point this repro`)
    assert(repro.x < 0.25, `the repro depends on this shot being near the LEFT edge, got x=${repro.x}`)
    return `x=${repro.x} y=${repro.y} trim=${repro.trim}`
  })

  /** Every label the render drew, with its measured box, plus the card rect
   *  recovered from two recorded inserts — the section (l) pattern, so nothing
   *  here re-derives the geometry it is checking. */
  function labelBoxes(vw, vh, targetName) {
    const state = fakeAppState()
    state.data = jaws
    state.machine = { id: 'jaws', name: 'Jaws', shortTitle: 'JAWS', resource: 'jaws_goals' }
    state.trim = 'premium-le'
    let out = null
    withMountedStudy(
      state,
      ({ host, calls }) => {
        const tour = buildTour(jaws.shots, 'premium-le')
        const idx = tour.findIndex((t) => t.name === targetName)
        assert(idx !== -1, `${targetName} is not in the premium-le tour`)
        const next = host.findAll('study-step-btn')[1]
        for (let i = 0; i < idx; i++) next.dispatchEvent({ type: 'click' })
        assert(host.find('study-readout-label').textContent === `SHOT ${idx + 1} OF ${tour.length}`, 'setup: failed to step to the target shot')

        const dots = dotPositions(calls).slice(-tour.length)
        // Recover the card from the two extreme-u shots actually drawn.
        let lo = 0
        let hi = 0
        tour.forEach((t, i) => {
          if (t.x < tour[lo].x) lo = i
          if (t.x > tour[hi].x) hi = i
        })
        const cardW = (dots[hi].x - dots[lo].x) / (tour[hi].x - tour[lo].x)
        const cardLeft = dots[lo].x - tour[lo].x * cardW
        // The DRAWN text, which may be an ellipsised prefix when the name is
        // too long for the card — its width is what has to fit, not the
        // authored name's.
        const isTarget = (t) => typeof t === 'string' && (t === targetName || (t.endsWith('\u2026') && targetName.startsWith(t.slice(0, -1))))
        const hits = calls.filter((c) => c.method === 'fillText' && isTarget(c.args[0]))
        assert(hits.length > 0, `${targetName} was never drawn`)
        const drawn = hits[hits.length - 1].args[0]
        const cx = hits[hits.length - 1].args[1]
        const halfW = (String(drawn).length * 6) / 2
        out = { cardLeft, cardRight: cardLeft + cardW, left: cx - halfW, right: cx + halfW, cx, drawn }
      },
      { viewportW: vw, viewportH: vh },
    )
    return out
  }

  for (const [vw, vh] of [
    [320, 568],
    [390, 844],
    [430, 932],
  ]) {
    test(`${vw}x${vh}: "${REPRO}" is drawn ENTIRELY inside the card`, () => {
      const b = labelBoxes(vw, vh, REPRO)
      assert(
        b.left >= b.cardLeft + LABEL_EDGE_PAD - 0.01,
        `label starts at ${b.left.toFixed(1)}, past the card's left edge ${b.cardLeft.toFixed(1)} (+${LABEL_EDGE_PAD} pad) — this is the reported "ip's Wheel Spinner" clipping`,
      )
      assert(b.right <= b.cardRight - LABEL_EDGE_PAD + 0.01, `label ends at ${b.right.toFixed(1)}, past the card's right edge ${b.cardRight.toFixed(1)}`)
      return `card ${b.cardLeft.toFixed(0)}..${b.cardRight.toFixed(0)}, label ${b.left.toFixed(0)}..${b.right.toFixed(0)} ${JSON.stringify(b.drawn)}`
    })
  }

  // The other edge, and the longest authored name on the machine — the case
  // that would run off the RIGHT.
  const longRight = jaws.shots
    .filter((sh) => sh.x > 0.6)
    .reduce((a, b) => (b.name.length > a.name.length ? b : a))

  test(`the right edge too: "${longRight.name}" (${longRight.name.length} chars at u ${longRight.x}) stays inside at 320/390/430`, () => {
    const rows = []
    for (const [vw, vh] of [
      [320, 568],
      [390, 844],
      [430, 932],
    ]) {
      const b = labelBoxes(vw, vh, longRight.name)
      assert(b.right <= b.cardRight - LABEL_EDGE_PAD + 0.01, `at ${vw}x${vh} the label ends at ${b.right.toFixed(1)}, past the card's right edge ${b.cardRight.toFixed(1)}`)
      assert(b.left >= b.cardLeft + LABEL_EDGE_PAD - 0.01, `at ${vw}x${vh} the label starts at ${b.left.toFixed(1)}, past the card's left edge`)
      rows.push(`${vw}: ${JSON.stringify(b.drawn)} ${b.left.toFixed(0)}..${b.right.toFixed(0)} in ${b.cardLeft.toFixed(0)}..${b.cardRight.toFixed(0)}`)
    }
    return rows.join(' ; ')
  })

  test('the clamp only moves the TEXT — the insert it names is still drawn at the shot\'s own point', () => {
    const b = labelBoxes(320, 568, REPRO)
    // The label had to move right to fit, so its centre is no longer the dot's
    // x; that is the whole mechanism. What must NOT change is the dot.
    const state = fakeAppState()
    state.data = jaws
    state.machine = { id: 'jaws', name: 'Jaws', shortTitle: 'JAWS', resource: 'jaws_goals' }
    state.trim = 'premium-le'
    let dotX = null
    withMountedStudy(
      state,
      ({ calls }) => {
        const tour = buildTour(jaws.shots, 'premium-le')
        const idx = tour.findIndex((t) => t.name === REPRO)
        dotX = dotPositions(calls).slice(-tour.length)[idx].x
      },
      { viewportW: 320, viewportH: 568 },
    )
    assert(dotX !== null, 'expected the insert to be drawn')
    assert(b.cx > dotX, `setup: at 320px the label must have been pushed right of its dot (label ${b.cx.toFixed(1)}, dot ${dotX.toFixed(1)})`)
    assert(dotX >= b.cardLeft - 0.01, 'the dot itself is inside the card, as it always was')
    return `dot x ${dotX.toFixed(1)}, label centre ${b.cx.toFixed(1)} — text moved, insert did not`
  })
}

// --- EVERY playfield text site, audited at the source ----------------------
test('every playfield label call passes horizontal bounds — the audit, so a new call site cannot skip the clamp', () => {
  // Behavioural coverage above is Study's label only; the map's ambient names,
  // zone plate titles, edge markers, route caption and tap callout draw in
  // suites with different harnesses. This checks the property that matters at
  // every one of them: the bounds argument is present and is not the
  // do-not-clamp 0.
  const sites = []
  for (const [name, src] of [
    ['ui/study.ts', studySrc],
    ['overlay/map2d.ts', map2dSrcText],
    ['overlay/drawing.ts', drawingSrc],
  ]) {
    // drawHaloLabel AND its wrapper drawZoneLabel — the zone plate names
    // ('ORCA DECK') go through the wrapper, and scanning only the primitive
    // let a plate call site drop its bounds without failing anything.
    for (const fn of ['drawHaloLabel', 'drawZoneLabel']) {
      const re = new RegExp(`${fn}\\(([\\s\\S]*?)\\)\\s*(?:$|\\n)`, 'gm')
      let m
      while ((m = re.exec(src))) {
        const call = m[1].replace(/\s+/g, ' ').trim()
        if (call.startsWith('ctx: CanvasRenderingContext2D')) continue // the definition
        sites.push({ file: name, fn, call })
      }
    }
  }
  assert(sites.length >= 8, `expected to find the playfield label call sites, found ${sites.length}`)
  assert(sites.some((x) => x.fn === 'drawZoneLabel'), 'the zone plate name sites are not being scanned')
  const unclamped = sites.filter((s) => !/cardXBounds|rectXBounds|bounds|Bounds/.test(s.call))
  assert(
    unclamped.length === 0,
    `these label draws pass no horizontal bounds, so a long name at the card's edge will run off it:\n` +
      unclamped.map((u) => `  ${u.file}: ${u.fn}(${u.call.slice(0, 90)}…`).join('\n'),
  )
  // The tap-callout pill does its own clamping rather than going through
  // drawHaloLabel, so it is pinned separately.
  assert(/cardBounds \? cardBounds\.left : 0/.test(map2dSrcText), "the tap-to-identify callout no longer clamps to the card")
  assert(/rectXBounds\(playfieldRect\(width, availableHeight\)\)/.test(map2dSrcText), 'the callout is not being handed the card to clamp to')
  return `${sites.length} label sites, all bounded`
})

// ===========================================================================
section('ad. LEVEL v2: one scroller that holds still, and a cycle you can flip through')
// ===========================================================================
// Feature, 2026-08-14; REBUILT 2026-08-15 (owner: "I can't flip thru the
// different playfield levels here. Would be nice to scroll thru which level to
// show").
//
// WHAT THE FIRST CUT GOT RIGHT, and this section keeps proving: the tour can
// walk a raised deck's own shots instead of only meeting them flattened onto
// the main card, it uses the SAME zone-render path the Shots tab draws its
// zone level with, and a trim-hidden zone still explains itself rather than
// vanishing (rolo, on a Pro, went looking for Jaws's Orca deck and found no
// control at all — absence reads as a broken app).
//
// WHAT IT GOT WRONG, measured in real Chrome before the rebuild: the control
// MOVED WHEN YOU USED IT. `.study-rail`'s padding-top is `--study-card-top`,
// the drawn card's own top edge, and the card's top edge depends on the
// selected level's aspect — so on Jaws at 390x780 the rows jumped 171px down
// the screen the instant ORCA DECK was pressed (card top 38 -> 242.5), and on
// Halloween at 375x667 picking SANITARIUM put two of the three rows ON the
// readout bar (y444/480/516 vs a bar top of 521) while the rail's own
// `overflow: hidden` clipped 74px of column (scrollHeight 587, clientHeight
// 513) and swallowed the rail's foot label whole.
//
// The fix is two things and both are pinned below: a fixed-height SCROLLER
// instead of N rows (so it fits), and the column's one `margin-top: auto` —
// carried by the eyebrow until it was removed on 2026-08-15, by this group
// since (so the rail's own bottom edge holds it, and the card's top edge
// cannot reach it). The pills keep their P9 card alignment.

const PREM_ZONE = { id: 'z-prem', name: 'Upper Deck', kind: 'upper', trim: 'premium-le', bounds: { x: 0.3, y: 0.6, w: 0.4, h: 0.3 } }
/** A `kind:'lower'` zone — a sunken window UNDER the playfield, which is where
 *  the ALL stack has to draw it. Low on the table (bounds.y 0.1) as every
 *  shipped lower zone is (ac_dc 0.14, evil_dead 0.169, munsters 0.12). */
const LOWER_ZONE = { id: 'z-low', name: 'The Cellar', kind: 'lower', bounds: { x: 0.28, y: 0.1, w: 0.3, h: 0.18 } }
const ZONE_SHOTS = [
  ...SHOTS,
  // DECK_ZONE is bounds { x: 0.5, y: 0.55, w: 0.25, h: 0.2 }. These two sit on
  // its left and right EDGES, so zoneLocalMap puts them at local u 0 and 1 —
  // the full width of the zone card — while the main mapping leaves them a
  // quarter of the board apart. That 4x gap is what makes the mapping
  // testable rather than merely plausible.
  { id: 's-deck-l', name: 'Deck Left', type: 'ramp', x: 0.5, y: 0.6, trim: 'all', playfield: 'z-deck' },
  { id: 's-deck-r', name: 'Deck Right', type: 'ramp', x: 0.75, y: 0.62, trim: 'all', playfield: 'z-deck' },
]
/** A machine with one raised deck AND one sunken window, plus a shot on each —
 *  the fixture the ALL stack's ordering rule is read off. */
const BOTH_SHOTS = [
  ...ZONE_SHOTS,
  { id: 's-cellar', name: 'Cellar Target', type: 'standup', x: 0.4, y: 0.15, trim: 'all', playfield: 'z-low' },
]

/** The scroller's two arrows, in ‹ › order. */
const arrows = (host) => host.findAll('study-level-arrow')
const levelName = (host) => host.find('study-level-name').textContent

test('a machine with NO authored zones shows no LEVEL control at all', () => {
  withMountedStudy(fakeAppState({ playfields: [] }), ({ host }) => {
    const group = host.find('study-level-group')
    assert(group, 'the control should exist in the DOM (hidden), so nothing has to be re-created later')
    assert(group.hidden === true, 'expected the LEVEL control hidden when the machine has no zones — there is nothing to explain')
    // AND IT MUST ACTUALLY HIDE. `.study-level-group` sets `display: flex`,
    // which beats the UA's `[hidden]` rule — the same cascade trap that took
    // the Study PANEL down on 2026-08-14. tests/tab-panels.test.mjs owns the
    // general form of this; this is the local one, and LEVEL v2 adds the
    // scroller's own arrows to it.
    assert(cssValue('.study-level-group', 'display') === 'flex', 'setup: the group is a flex column')
    assert(
      cssValue('.study-level-group[hidden]', 'display') === 'none',
      'the group sets its own display, so it MUST restate [hidden] — otherwise a machine with no zones shows an empty LEVEL heading',
    )
    assert(cssValue('.study-level-arrow', 'display') === 'flex', 'setup: an arrow is a flex box (to centre its glyph)')
    assert(
      cssValue('.study-level-arrow[hidden]', 'display') === 'none',
      'the arrow sets its own display, so it MUST restate [hidden] at >= specificity or a hidden arrow stays painted',
    )
  })
})

test('THE CONTROL HOLDS STILL: it CARRIES the rail\'s one auto margin, so the card cannot push it', () => {
  // The defect this replaced, as a cascade fact rather than a screenshot.
  // `.study-rail` is a flex column whose top offset is `--study-card-top`;
  // anything laid out from the TOP of that column moves whenever the drawn
  // card does. An auto margin eats all the free space, so the item carrying it
  // — and everything ordered after — is measured from the rail's bottom edge
  // instead, an edge the card's top cannot reach.
  //
  // THE ANCHOR MOVED HERE 2026-08-15, when the eyebrow that used to carry it
  // was removed ("the text study jaws under the buttons is unnecessary"). Same
  // mechanism, one element earlier in the column: what matters is that exactly
  // one item has it and that it is at or above the controls being pinned.
  const levelOrder = Number(cssValue('.study-level-group', 'order'))
  const modelOrder = Number(cssValue('.study-model-group', 'order'))
  assert(cssValue('.study-level-group', 'margin-top') === 'auto', 'the LEVEL group is the rail\'s foot anchor; without margin-top:auto nothing is pinned')
  assert(
    modelOrder > levelOrder,
    `MODEL (order ${modelOrder}) must be ordered after the auto-margin item (LEVEL, order ${levelOrder}) or it is not pinned by it`,
  )
  // The pill stack, which is NOT pinned, must be ordered before it — otherwise
  // the free space lands between LEVEL and MODEL and splits the foot group.
  const stackOrder = Number(cssValue('.study-pill-stack', 'order') ?? 0)
  assert(!Number.isFinite(stackOrder) || stackOrder < levelOrder, `the pill stack (order ${stackOrder}) must precede the anchored foot group (order ${levelOrder})`)
  // AND IT MUST BE THE ONLY AUTO MARGIN IN THE COLUMN. Two of them split the
  // free space between them, which un-pins BOTH — the level group would drift
  // by half the card's top gutter instead of all of it, which is the same bug
  // wearing a smaller number.
  const autos = ['.study-rail', '.study-rail-spacer', '.study-pill-stack', '.study-level-group', '.study-level-scroller', '.study-level-name', '.study-level-arrows', '.study-model-group', '.study-learn-btn', '.study-action-btn', '.study-drills-btn', '.study-altmodes-btn', '.study-character-btn'].filter(
    (sel) => cssValue(sel, 'margin-top') === 'auto',
  )
  assert(autos.length === 1 && autos[0] === '.study-level-group', `expected exactly one margin-top:auto in the rail column, found ${JSON.stringify(autos)}`)
  return `LEVEL order ${levelOrder} carries margin-top:auto -> MODEL order ${modelOrder}, both pinned to the rail foot`
})

test('the ‹ › are real 44px targets — this is the control the owner flips with', () => {
  const h = /(\d+(?:\.\d+)?)px/.exec(cssValue('.study-level-arrow', 'height') || '')
  assert(h && Number(h[1]) >= 44, `expected a >= 44px tall arrow, got ${cssValue('.study-level-arrow', 'height')}`)
  // Width comes from `flex: 1` inside the rail's content box, so it is
  // computed rather than declared: 144px of rail content, two arrows, a 4px
  // gap = 70px each. Pin the inputs.
  assert(cssValue('.study-level-arrow', 'flex') === '1', 'the arrows must split the rail width, not size to their glyph')
  const gap = /(\d+(?:\.\d+)?)px/.exec(cssValue('.study-level-arrows', 'gap') || '0px')
  const railW = RAIL_W - Number(/(\d+(?:\.\d+)?)px/.exec(cssValue('.study-rail', 'padding-left'))[1]) - Number(/(\d+(?:\.\d+)?)px/.exec(cssValue('.study-rail', 'padding-right'))[1])
  const arrowW = (railW - Number(gap[1])) / 2
  assert(arrowW >= 44, `each arrow computes to ${arrowW}px wide in a ${railW}px rail content box — under the 44px minimum`)
  // The old list's rows were 32px tall, which is what a `‹ NAME ›` single row
  // would have had to go back to in order to leave the name any width at all.
  assert(!/\.study-level-btn\b/.test(stylesSrc), 'the old 32px .study-level-btn rows are still in styles.css')
  return `arrow ${arrowW}x${h[1]} in a ${railW}px rail content box`
})

// --- the cycle -------------------------------------------------------------
test('studyLevels: MAIN, then each visible zone, then ALL LEVELS — and no ALL with nothing to combine', () => {
  assert(studyLevels([]).map((l) => l.id).join(',') === 'main', 'a machine with no visible zone has exactly one level')
  const one = studyLevels([DECK_ZONE])
  assert(one.map((l) => l.id).join(',') === 'main,z-deck,all', `got ${JSON.stringify(one.map((l) => l.id))}`)
  assert(one.map((l) => l.label).join(' | ') === 'MAIN | TEST DECK | ALL LEVELS', `got ${JSON.stringify(one.map((l) => l.label))}`)
  const two = studyLevels([DECK_ZONE, LOWER_ZONE])
  assert(two.map((l) => l.id).join(',') === 'main,z-deck,z-low,all', `got ${JSON.stringify(two.map((l) => l.id))}`)
  return two.map((l) => l.label).join(' -> ')
})

test('resolveStudyLevel: ALL survives only while there is something to combine', () => {
  assert(resolveStudyLevel('all', [DECK_ZONE]) === 'all', 'ALL is valid with a visible zone')
  assert(resolveStudyLevel('all', []) === 'main', 'ALL degenerates to MAIN when the MODEL hides every zone')
  assert(resolveStudyLevel('z-deck', [DECK_ZONE]) === 'z-deck', 'a visible zone survives')
  assert(resolveStudyLevel('z-deck', []) === 'main', 'a hidden zone drops to main')
  assert(resolveStudyLevel('main', []) === 'main', 'main is always valid')
})

withMountedStudy(fakeAppState({ shots: ZONE_SHOTS }), ({ host }) => {
  test('a machine WITH a zone starts on MAIN and offers a cycle', () => {
    const group = host.find('study-level-group')
    assert(group.hidden === false, 'expected the LEVEL control shown')
    assert(levelName(host) === 'MAIN', `expected MAIN selected on mount, got ${JSON.stringify(levelName(host))}`)
    assert(host.find('study-level-name').className === 'study-level-name', 'MAIN is the resting state and must NOT carry the amber wash')
    assert(arrows(host).length === 2, 'expected a ‹ and a ›')
    assert(arrows(host).every((a) => a.disabled === false), 'both arrows are live when there is more than one level')
    return levelName(host)
  })

  test('› cycles MAIN -> zone -> ALL LEVELS -> MAIN (wraps), and ‹ walks it backwards', () => {
    const next = arrows(host)[1]
    const seen = [levelName(host)]
    for (let i = 0; i < 3; i++) {
      next.dispatchEvent({ type: 'click' })
      seen.push(levelName(host))
    }
    assert(seen.join(' -> ') === 'MAIN -> TEST DECK -> ALL LEVELS -> MAIN', `got ${seen.join(' -> ')}`)
    const prev = arrows(host)[0]
    const back = []
    for (let i = 0; i < 3; i++) {
      prev.dispatchEvent({ type: 'click' })
      back.push(levelName(host))
    }
    assert(back.join(' -> ') === 'ALL LEVELS -> TEST DECK -> MAIN', `‹ must walk the same cycle backwards, got ${back.join(' -> ')}`)
    return `${seen.join(' -> ')} ; back ${back.join(' -> ')}`
  })

  test('a level off MAIN carries the amber wash; MAIN does not', () => {
    assert(host.find('study-level-name').className === 'study-level-name', 'setup: back on MAIN')
    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(
      host.find('study-level-name').className.split(/\s+/).includes('study-level-name-on'),
      `expected the lit treatment on a zone level, got ${JSON.stringify(host.find('study-level-name').className)}`,
    )
    arrows(host)[0].dispatchEvent({ type: 'click' })
    assert(host.find('study-level-name').className === 'study-level-name', 'and it goes out again on MAIN')
  })

  test('a zone level scopes the TOUR to that zone\'s shots, and the readout with it', () => {
    const mainCount = host.find('study-readout-label').textContent
    arrows(host)[1].dispatchEvent({ type: 'click' })
    const zoneShots = ZONE_SHOTS.filter((sh) => sh.playfield === 'z-deck')
    assert(zoneShots.length === 3, 'setup: the fixture deck has three shots')
    assert(
      host.find('study-readout-label').textContent === `SHOT 1 OF ${zoneShots.length}`,
      `expected the tour scoped to the deck, got ${JSON.stringify(host.find('study-readout-label').textContent)} (main was ${mainCount})`,
    )
    return `${mainCount} -> SHOT 1 OF ${zoneShots.length}`
  })

  test('each level ANNOUNCES itself in the tab\'s own live region', () => {
    const live = host.findAll('sr-only')
    assert(live.length >= 1, 'expected the tab live region')
    assert(live[0].getAttribute('role') === 'status', 'polite, not an alert')
    assert(live[0].textContent === 'Test Deck. 3 shots.', `expected the zone named and counted, got ${JSON.stringify(live[0].textContent)}`)
    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(live[0].textContent === 'All playfields. 8 shots.', `expected the combined level announced, got ${JSON.stringify(live[0].textContent)}`)
    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(live[0].textContent === 'Main playfield. 8 shots.', `expected the wrap back to main announced, got ${JSON.stringify(live[0].textContent)}`)
    return 'Test Deck. 3 shots. -> All playfields. 8 shots. -> Main playfield. 8 shots.'
  })

  test('THE LIST IS THE SCOPED TOUR: on a zone level LEARN lists only that zone\'s shots', () => {
    // Extended 2026-08-15: this used to open the ALL SHOTS sheet. The list is
    // the lower half of LEARN now, and the claim is the same one — it is
    // `tourShots`, so it is whatever LEVEL is walking and cannot disagree with
    // the ‹ › walk or the dots on the card behind it.
    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(levelName(host) === 'TEST DECK', 'setup: on the deck')
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const names = host.find('study-learn-panel').findAll('study-index-name').map((n) => n.textContent)
    assert(names.length === 3, `expected the deck's three shots, got ${JSON.stringify(names)}`)
    assert(names.every((n) => ['Deck Shot', 'Deck Left', 'Deck Right'].includes(n)), `got ${JSON.stringify(names)}`)
    // ...and the DETAIL above it is a shot from that same deck, not a leftover
    // from the level we came off.
    assert(names.includes(host.find('study-learn-panel').find('study-learn-title').textContent), 'the detail must be one of the listed shots')
    host.find('study-learn-back').dispatchEvent({ type: 'click' })
    // (A LEVEL CHANGE ALSO CLOSES THE SHEET, which is what makes a stale list
    // impossible rather than merely unlikely — pinned two tests below, where
    // the level can be moved without disturbing this mount's position.)
    return names.join(' -> ')
  })

  test('every level change starts the tour at its first shot', () => {
    // STEP FIRST, so "starts at its first shot" is a real claim: a tour
    // position means nothing across surfaces, and carrying index 2 from a
    // three-shot deck into an eight-shot main tour would land the player
    // somewhere arbitrary.
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 2 OF 3', 'setup: moved off the first shot of the deck')
    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(levelName(host) === 'ALL LEVELS', 'setup: on the combined level')
    assert(host.find('study-readout-label').textContent === 'SHOT 1 OF 8', `expected the whole machine again from its first shot, got ${JSON.stringify(host.find('study-readout-label').textContent)}`)
    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(levelName(host) === 'MAIN', 'and wrapped back to MAIN')
  })

  test('changing level CLOSES any open sheet — its content was about the other surface', () => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-learn-panel'), 'setup: a sheet is open')
    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(!host.find('study-learn-panel'), 'the sheet must close when the surface under it changes')
  })
})

// --- THE OWNER'S CASE: a Premium-only zone, seen from a Pro ----------------
{
  const proState = fakeAppState({ trim: 'pro', shots: SHOTS, playfields: [PREM_ZONE] })
  withMountedStudy(proState, ({ host }) => {
    test("on Pro, a Premium-only zone is NOT a stop in the cycle — but it still explains itself (rolo's Orca deck)", () => {
      const group = host.find('study-level-group')
      assert(group.hidden === false, 'the control must NOT vanish: that is what read as a missing feature')
      assert(levelName(host) === 'MAIN', `the only level on this MODEL is MAIN, got ${JSON.stringify(levelName(host))}`)
      // A scroller's label IS its live selection, so a stop you cannot show
      // would be the control lying about what is on the canvas. The zone
      // leaves the cycle and keeps its explanation as a line underneath.
      const reason = host.find('study-level-reason')
      assert(reason, 'expected a reason line for the zone this MODEL hides')
      assert(/upper deck/i.test(reason.textContent), `the reason must NAME the deck, got ${JSON.stringify(reason.textContent)}`)
      assert(/premium\/le/i.test(reason.textContent), `the reason must name the MODEL it needs, got ${JSON.stringify(reason.textContent)}`)
      // AND IT NO LONGER SENDS ANYONE ANYWHERE. It used to end "switch MODEL in
      // settings" — a direction to another tab's popover. The switch is now the
      // next control down this rail, so the sentence that pointed at it would
      // be pointing past the button it describes.
      assert(!/settings/i.test(reason.textContent), `the reason must not direct anyone to a settings popover, got ${JSON.stringify(reason.textContent)}`)
      assert(host.find('study-model-group').hidden === false, 'the MODEL control must be present — it is what the short reason line now relies on')
      return reason.textContent
    })

    test('and the arrows are GONE, not merely disabled — one level is nothing to scroll', () => {
      // THE OWNER'S BUG, pinned. Until 2026-08-14 the pair rendered disabled
      // here: two 70x44 amber glyphs at 0.4 opacity, in a rail where every
      // other control is live. rolo read it exactly the way it looks — "the
      // buttons on the side still aren't changing the playfield" — because a
      // control that is present is a promise, and dimming is not a retraction.
      const row = host.find('study-level-arrows')
      assert(row, 'the arrows row must still EXIST (it is never rebuilt, only hidden)')
      assert(row.hidden === true, 'the arrows row must be hidden when MAIN is the only level')
      // The row sets its own display, so [hidden] has to be restated or the
      // hide loses the cascade — the trap that took the whole Study panel down.
      assert(cssValue('.study-level-arrows', 'display') === 'flex', 'setup: the row is a flex box')
      assert(cssValue('.study-level-arrows[hidden]', 'display') === 'none', 'the arrows row sets its own display and MUST restate [hidden] — otherwise the "removed" arrows render anyway')
      // Belt AND braces, deliberately: `disabled` keeps them out of the focus
      // ring and inert if any future rule ever out-specifies the hide.
      assert(arrows(host).every((a) => a.disabled === true), 'the arrows must also be disabled — hidden alone is a visual claim, disabled is a behavioural one')
      const before = host.find('study-readout-label').textContent
      arrows(host)[1].dispatchEvent({ type: 'click' })
      assert(levelName(host) === 'MAIN', 'a hidden arrow must not move the level')
      assert(host.find('study-readout-label').textContent === before, 'nor the tour')
      return 'row hidden, both disabled, a click changes nothing'
    })

    test('a disabled arrow, if one is ever left on screen, reads disabled — faint, no amber', () => {
      // Unreachable in the shipped app (the row hides first), which is exactly
      // why it is asserted at the stylesheet: nothing behavioural would notice
      // this rule rotting, and the amber-at-0.4 treatment it replaced is the
      // visual half of the bug above.
      assert(cssValue('.study-level-arrow', 'color') === 'var(--amber)', 'setup: a live arrow is amber')
      assert(cssValue('.study-level-arrow:disabled', 'color') === 'var(--text-faint)', 'a disabled arrow must drop the amber — that is what made a dead control look live')
      assert(!/amber/.test(String(cssValue('.study-level-arrow:disabled', 'background'))), 'a disabled arrow must not keep a lit background')
      return 'disabled: var(--text-faint), transparent background'
    })
  })
}

// --- MODEL switched out from under a level ---------------------------------
{
  const state = fakeAppState({ trim: 'premium-le', shots: SHOTS, playfields: [PREM_ZONE] })
  withMountedStudy(state, ({ host }) => {
    test('on Premium/LE the zone is in the cycle, and the tour follows it', () => {
      assert(!host.find('study-level-reason'), 'a visible zone needs no reason line')
      assert(host.find('study-level-arrows').hidden === false, 'with a cycle to walk, the arrows are on screen')
      assert(arrows(host).every((a) => a.disabled === false), 'the arrows are live')
      arrows(host)[1].dispatchEvent({ type: 'click' })
      assert(levelName(host) === 'UPPER DECK', `got ${JSON.stringify(levelName(host))}`)
    })

    test('switching MODEL to Pro DROPS the level to main and says why', () => {
      state.trim = 'pro'
      state._notify()
      assert(levelName(host) === 'MAIN', 'expected the drop back to MAIN')
      assert(host.find('study-level-arrows').hidden === true, 'and the arrows leave with the cycle they served')
      assert(arrows(host).every((a) => a.disabled === true), 'and nothing left to scroll to')
      const reason = host.find('study-level-reason')
      assert(reason && /upper deck/i.test(reason.textContent), 'the reason line must appear with the drop')
      const live = host.findAll('sr-only')[0]
      assert(
        /needs premium\/le/i.test(live.textContent) && /main playfield/i.test(live.textContent),
        `the drop must be announced with its reason, got ${JSON.stringify(live.textContent)}`,
      )
      assert(host.find('study-readout-label').textContent === 'SHOT 1 OF 5', `expected the main pro tour, got ${JSON.stringify(host.find('study-readout-label').textContent)}`)
      return live.textContent
    })
  })
}

// --- ALL degenerates when the MODEL takes the last zone away ---------------
{
  const state = fakeAppState({ trim: 'premium-le', shots: SHOTS, playfields: [PREM_ZONE] })
  withMountedStudy(state, ({ host, calls }) => {
    test('a MODEL switch that hides every zone takes ALL LEVELS down to MAIN, and says so', () => {
      arrows(host)[0].dispatchEvent({ type: 'click' }) // ‹ from MAIN wraps straight to ALL LEVELS
      assert(levelName(host) === 'ALL LEVELS', `setup: expected ALL LEVELS, got ${JSON.stringify(levelName(host))}`)
      state.trim = 'pro'
      state._notify()
      assert(levelName(host) === 'MAIN', 'ALL must degenerate to MAIN with nothing left to combine')
      const live = host.findAll('sr-only')[0]
      assert(
        /no extra playfields/i.test(live.textContent) && /main playfield/i.test(live.textContent),
        `the degeneration must be announced, got ${JSON.stringify(live.textContent)}`,
      )
      // And exactly one card is drawn afterwards — not a "stack" of one.
      const before = calls.length
      host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
      const cards = calls.slice(before).filter((c) => c.method === 'roundRect' || c.method === 'quadraticCurveTo').length
      assert(cards > 0, 'setup: the re-render drew a card')
      return live.textContent
    })
  })
}

// --- a machine switch clears the level -------------------------------------
{
  const state = fakeAppState({ shots: ZONE_SHOTS })
  withMountedStudy(state, ({ host }) => {
    test('a MACHINE switch resets the level to MAIN — a zone id from the old machine means nothing here', () => {
      arrows(host)[1].dispatchEvent({ type: 'click' })
      assert(levelName(host) === 'TEST DECK', 'setup: on the zone')
      state.machine = { ...makeMachine(), id: 'other-machine' }
      state.data = makeData(SHOTS, [DECK_ZONE])
      state._notify()
      assert(levelName(host) === 'MAIN', 'expected MAIN after a machine switch')
      assert(host.find('study-readout-label').textContent === 'SHOT 1 OF 6', 'and the new machine\'s full tour')
    })
  })
}

// --- the shared render path -------------------------------------------------
test('the zone view uses map2d.ts\'s OWN zone-render path, not a second copy', () => {
  const map2dSrc = readFileSync(map2dPath, 'utf8')
  assert(/export function drawZoneArt\(/.test(map2dSrc), 'map2d.ts must export the zone-art path')
  assert(/export function zoneMemberShots\(/.test(map2dSrc), 'map2d.ts must export the zone roster rule')
  // The Shots tab's own zone level must be calling it too, or "shared" is a
  // claim about one caller.
  const callers = (map2dSrc.match(/drawZoneArt\(ctx/g) || []).length
  assert(callers >= 1, 'map2d.ts renderZoneLevel no longer calls drawZoneArt — the two tabs have forked again')
  assert(/drawZoneArt\(ctx, rect, map, zone, state\.shotsByID, state\.trim\)/.test(studySrc), 'ui/study.ts must draw its zone through the shared path')
  // ...and the ALL level's deck cards go through the SAME function, so a
  // combined view cannot drift from the single-zone one it is made of.
  assert(
    /drawZoneArt\(ctx, card\.rect, map, card\.zone!, state\.shotsByID, state\.trim\)/.test(studySrc),
    'the ALL level draws its deck cards some other way than drawZoneArt',
  )
  // And no second copy of the bat rules, whose unauthored default 23 shipped
  // deck flippers depend on.
  assert(!/bat\.size === 'full'/.test(studySrc), 'ui/study.ts has its own copy of the bat-scale rule')
  assert(!/paintFlipper/.test(studySrc), 'ui/study.ts is painting its own flippers')
  return 'one drawZoneArt, called by both tabs and by both of this tab\'s zone paths'
})

test('a zone level MAPS through zoneLocalMap — the deck fills its own card', () => {
  // The deck's edge shots are at main u 0.5 and 0.75. Drawn with the MAIN
  // mapping they stay a quarter of the board apart; drawn through
  // zoneLocalMap they are local u 0 and 1 and span the whole card. Both
  // numbers come from recorded canvas coordinates in one mount.
  let mainSpan = null
  let zoneSpan = null
  withMountedStudy(fakeAppState({ shots: ZONE_SHOTS }), ({ host, calls }) => {
    const mainTour = buildTour(ZONE_SHOTS, 'premium-le')
    const mainDots = dotPositions(calls).slice(-mainTour.length)
    const iL = mainTour.findIndex((t) => t.id === 's-deck-l')
    const iR = mainTour.findIndex((t) => t.id === 's-deck-r')
    mainSpan = Math.abs(mainDots[iR].x - mainDots[iL].x)

    arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 1 OF 3', 'setup: the tour is scoped to the deck')
    const zoneTour = buildTour(
      ZONE_SHOTS.filter((sh) => sh.playfield === 'z-deck'),
      'premium-le',
    )
    const zoneDots = dotPositions(calls).slice(-zoneTour.length)
    const zL = zoneTour.findIndex((t) => t.id === 's-deck-l')
    const zR = zoneTour.findIndex((t) => t.id === 's-deck-r')
    zoneSpan = Math.abs(zoneDots[zR].x - zoneDots[zL].x)
  })
  assert(mainSpan > 0 && zoneSpan > 0, 'setup: both renders drew the two edge shots')
  assert(
    zoneSpan > mainSpan * 2.5,
    `the deck's edge shots span ${zoneSpan.toFixed(0)}px on the zone card vs ${mainSpan.toFixed(0)}px on the main card — ` +
      `a zone level drawn with the MAIN mapping would barely change that, so the view is not going through zoneLocalMap`,
  )
  return `edge shots ${mainSpan.toFixed(0)}px apart on the main card, ${zoneSpan.toFixed(0)}px on the zone card`
})

test('a label on a ZONE level is clamped to the ZONE card — the trap cardXBounds walks into', () => {
  // FOUND IN CHROME, on the first build of this feature: on Jaws's Orca deck
  // "Ship's Wheel Spinner" rendered as "Wheel Spinner", clipped at the card's
  // left edge, even though P9's clamp was in place. cardXBounds asks the map
  // where u = 0 and u = 1 land — the card's edges on a MAIN map, and four
  // times the card on a zone map, because zoneLocalMap re-bases u into the
  // zone's footprint. So the clamp was computing a range far wider than the
  // card and doing nothing. Bounds come from the RECT now, on both levels.
  const LONG = "Ship's Wheel Spinner On The Orca Deck"
  const zoneShots = [
    ...SHOTS,
    // Hard against the deck's LEFT edge, where a long name runs off.
    { id: 's-edge', name: LONG, type: 'ramp', x: 0.5, y: 0.6, trim: 'all', playfield: 'z-deck' },
  ]
  let box = null
  let card = null
  withMountedStudy(fakeAppState({ shots: zoneShots }), ({ host, calls }) => {
    arrows(host)[1].dispatchEvent({ type: 'click' })
    const tour = buildTour(
      zoneShots.filter((sh) => sh.playfield === 'z-deck'),
      'premium-le',
    )
    const idx = tour.findIndex((t) => t.name === LONG)
    // Step to it so it becomes the floating current-shot label.
    const next = host.findAll('study-step-btn')[1]
    for (let i = 0; i < idx; i++) next.dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === `SHOT ${idx + 1} OF ${tour.length}`, 'setup: on the edge shot')

    const isIt = (t) => typeof t === 'string' && (t === LONG || (t.endsWith('…') && LONG.startsWith(t.slice(0, -1))))
    const hits = calls.filter((c) => c.method === 'fillText' && isIt(c.args[0]))
    assert(hits.length > 0, 'the edge shot was never labelled')
    const drawn = hits[hits.length - 1].args[0]
    const cx = hits[hits.length - 1].args[1]
    const half = (String(drawn).length * 6) / 2
    box = { left: cx - half, right: cx + half, drawn }

    // The deck's leftmost drawn shot. It sits at local u 0 — the zone card's
    // own left edge — which is the edge the reported clipping ran off. (The
    // rightmost dot is NOT the card's right edge: this fixture's deck shots
    // stop short of it, so only the left side is pinned here.)
    const dots = dotPositions(calls).slice(-tour.length)
    card = { left: Math.min(...dots.map((d) => d.x)), right: Math.max(...dots.map((d) => d.x)) }
  })
  assert(box && card, 'setup failed')
  assert(
    box.left >= card.left - 0.01,
    `the label starts at ${box.left.toFixed(1)} but the deck's leftmost shot is at ${card.left.toFixed(1)} — it is running off the zone card, which is the reported clipping`,
  )
  return `zone card's left edge ${card.left.toFixed(0)} (deck dots to ${card.right.toFixed(0)}), label ${box.left.toFixed(0)}..${box.right.toFixed(0)}`
})

test('nothing draws playfield labels off a MapFn whose domain it cannot know', () => {
  // The general form, pinned at the source: a zone map makes cardXBounds lie,
  // so every call site that HAS a rect must use rectXBounds. cardXBounds
  // survives only for the main-playfield paths that genuinely have no rect.
  const map2dSrc = readFileSync(map2dPath, 'utf8')
  const drawingSrc = readFileSync(drawingPath, 'utf8')
  assert(/export function rectXBounds\(/.test(drawingSrc), 'drawing.ts must export the rect-based bounds')
  // CODE ONLY — the comment in drawCurrentLabel explains why cardXBounds was
  // wrong here, and scanning the whole file would fail on the explanation.
  const studyCode = studySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(!/cardXBounds/.test(studyCode), 'ui/study.ts must take its bounds from the drawn rect, not the map')
  // The two zone paths in map2d are the ones that would lie.
  assert(/drawZoneEdgeMarkers\(ctx, map, zone, shotsById, trim, rectXBounds\(rect\)\)/.test(map2dSrc), 'the zone edge markers must clamp to the zone card')
  assert(/labelBounds: rectXBounds\(rect\)/.test(map2dSrc), "the Shots tab's zone dots must clamp to the zone card")
  assert(/labelBounds: rectXBounds\(rect\)/.test(studySrc), "the Study tab's dots must clamp to the drawn card")
  // ...and the ALL level, whose cards each need their OWN bounds — one shared
  // clamp across a stack would let a deck's label run over the main card.
  assert(/labelBounds: rectXBounds\(card\.rect\)/.test(studySrc), "the ALL level's dots must clamp PER CARD")
  return 'zone paths use rectXBounds; cardXBounds is main-map only'
})

// ===========================================================================
section('ae. THE ALL LEVEL: main and every deck on one canvas, at honest scale')
// ===========================================================================
// The headline of LEVEL v2 (owner: "I'd like to see the upper deck and the
// main playfield at once").
//
// THE LAYOUT IS A PURE FUNCTION (computeStackRects), so the arithmetic below
// is driven directly at the viewports this app actually ships to — measured in
// real Chrome through an iframe harness: the host is the viewport minus 154px
// of shell chrome, and the canvas column is the viewport minus the rail
// (--study-rail-w, 158 or 137 under 360px).
//
// THE DECK'S SHAPE IS ITS TRUE SHAPE HERE, and that is the one deliberate
// difference from the single-zone level. UV is NOT isotropic — u spans the
// table's 20.25" width and v its 45" length — so a zone drawn at
// `bounds.w / bounds.h` (what "own scale, keep aspect of bounds" gives the
// single-zone view, on both tabs) is stretched 2.2x horizontally. Harmless
// when the deck is alone on the screen; a visible lie next to the table it
// sits on. Black Knight 2000's upper deck is the proof: bounds.w 0.72 would
// draw it 1.6x WIDER than the whole playfield.

/** The host box a viewport gives the Study tab, MEASURED in Chrome (iframe
 *  harness, 2026-08-15): 667 -> 513, 780 -> 626, i.e. 154px of shell chrome
 *  above and below on every one of them. */
const hostHeightFor = (viewportH) => viewportH - 154
const canvasWidthFor = (viewportW) => viewportW - railWidthFor(viewportW)
/** ui/study.ts's own band constants, READ from the source so this arithmetic
 *  cannot drift from the render path's. */
const T_TOP_PAD = tsConst(studySrc, 'TOP_PAD', 'ui/study.ts')
const T_BOTTOM_CLEARANCE = tsConst(studySrc, 'BOTTOM_CLEARANCE', 'ui/study.ts')
const MIN_DECK_HEIGHT = tsConst(studySrc, 'MIN_DECK_HEIGHT', 'ui/study.ts')
const MAIN_MIN_SHARE = tsConst(studySrc, 'MAIN_MIN_SHARE', 'ui/study.ts')
const STACK_GAP = tsConst(studySrc, 'STACK_GAP', 'ui/study.ts')
const STACK_MARGIN = tsConst(studySrc, 'STACK_MARGIN', 'ui/study.ts')

/** The (width, availableHeight) computeStackRects is called with, for a
 *  viewport — the same two numbers render() derives. */
function stackBox(viewportW, viewportH) {
  return { w: canvasWidthFor(viewportW), h: hostHeightFor(viewportH) - T_BOTTOM_CLEARANCE - T_TOP_PAD }
}

/** The REAL shipped zones, so this section measures the machines the owner
 *  actually walks rather than a fixture that flatters the math. */
const REAL = {
  jaws: [{ id: 'orca-deck', name: 'Orca Deck', kind: 'upper', bounds: { x: 0.19, y: 0.82, w: 0.26, h: 0.15 } }],
  acdc: [{ id: 'underworld', name: 'The Underworld (Hell)', kind: 'lower', bounds: { x: 0.36, y: 0.14, w: 0.28, h: 0.16 } }],
  halloween: [
    { id: 'house-deck', name: 'Strode House', kind: 'upper', bounds: { x: 0.59, y: 0.65, w: 0.28, h: 0.28 } },
    { id: 'sanitarium-deck', name: 'Sanitarium', kind: 'mini', bounds: { x: 0.28, y: 0.16, w: 0.36, h: 0.26 } },
  ],
  bk2000: [{ id: 'upper-deck', name: 'The Upper Deck', kind: 'upper', bounds: { x: 0.06, y: 0.58, w: 0.72, h: 0.34 } }],
  lotr: [{ id: 'paths', name: 'The Paths of the Dead', kind: 'upper', bounds: { x: 0.16, y: 0.88, w: 0.28, h: 0.12 } }],
}

test('a deck card is bounds.w of the main card WIDE and bounds.h of it TALL — its real footprint', () => {
  // The honest-scale claim, checked where nothing clamps it: a tall viewport
  // where neither the readability floor nor the majority rule can fire.
  const { w, h } = stackBox(430, 932)
  const stack = computeStackRects(w, h, REAL.jaws)
  assert(stack.length === 2, `expected main + one deck, got ${stack.length}`)
  const main = stack.find((c) => c.zone === null).rect
  const deck = stack.find((c) => c.zone !== null).rect
  const z = REAL.jaws[0].bounds
  assert(deck.h > MIN_DECK_HEIGHT + 1, `setup: the floor must not be what set this height (${deck.h.toFixed(1)} vs floor ${MIN_DECK_HEIGHT})`)
  assert(Math.abs(deck.h / main.h - z.h) < 0.001, `deck height is ${(deck.h / main.h).toFixed(3)} of main, expected bounds.h ${z.h}`)
  assert(Math.abs(deck.w / main.w - z.w) < 0.001, `deck width is ${(deck.w / main.w).toFixed(3)} of main, expected bounds.w ${z.w}`)
  // ...and the main card is still the whole-table aspect it has on every other
  // level, so the stack has not quietly reshaped the playfield to fit.
  assert(Math.abs(main.w / main.h - PLAYFIELD_ASPECT) < 0.001, `main card aspect ${(main.w / main.h).toFixed(3)}, expected ${PLAYFIELD_ASPECT.toFixed(3)}`)
  return `430x932: MAIN ${main.w.toFixed(0)}x${main.h.toFixed(0)}, Orca Deck ${deck.w.toFixed(0)}x${deck.h.toFixed(0)} (= ${z.w}w x ${z.h}h of main)`
})

test('the WIDEST authored deck is still narrower than the playfield — the 2.2x stretch is gone', () => {
  // Black Knight 2000, bounds.w 0.72. At the single-zone view's `w/h` aspect
  // this card would be 0.72 / PLAYFIELD_ASPECT = 1.6x the main card's width.
  const { w, h } = stackBox(430, 932)
  const stack = computeStackRects(w, h, REAL.bk2000)
  const main = stack.find((c) => c.zone === null).rect
  const deck = stack.find((c) => c.zone !== null).rect
  const naive = deck.h * (REAL.bk2000[0].bounds.w / REAL.bk2000[0].bounds.h)
  assert(naive > main.w, `setup: the naive UV aspect should overflow (naive ${naive.toFixed(0)} vs main ${main.w.toFixed(0)})`)
  assert(deck.w < main.w, `the deck card (${deck.w.toFixed(0)}) must be narrower than the playfield (${main.w.toFixed(0)})`)
  assert(deck.w <= w - 2 * STACK_MARGIN + 0.01, `the deck card runs past the canvas (${deck.w.toFixed(0)} > ${w - 2 * STACK_MARGIN})`)
  return `naive ${naive.toFixed(0)}px wide -> true ${deck.w.toFixed(0)}px, inside a ${main.w.toFixed(0)}px playfield`
})

test('every shipped machine fits its stack, at every shipped viewport, with MAIN keeping the majority', () => {
  const rows = []
  for (const [vw, vh] of [[320, 568], [375, 667], [390, 780], [430, 932]]) {
    const { w, h } = stackBox(vw, vh)
    for (const [name, zones] of Object.entries(REAL)) {
      const stack = computeStackRects(w, h, zones)
      assert(stack.length === zones.length + 1, `${name} at ${vw}x${vh}: expected ${zones.length + 1} cards, got ${stack.length}`)
      const main = stack.find((c) => c.zone === null).rect
      const decks = stack.filter((c) => c.zone !== null).map((c) => c.rect)
      const content = main.h + decks.reduce((a, r) => a + r.h, 0)
      const top = Math.min(...stack.map((c) => c.rect.y))
      const bottom = Math.max(...stack.map((c) => c.rect.y + c.rect.h))
      // Inside the box, both ways.
      assert(top >= -0.01, `${name} at ${vw}x${vh}: the stack starts at y=${top.toFixed(1)}`)
      assert(bottom <= h + 0.01, `${name} at ${vw}x${vh}: the stack runs to y=${bottom.toFixed(1)} in a ${h}px box`)
      for (const r of stack) {
        assert(r.rect.x >= STACK_MARGIN - 0.01, `${name} at ${vw}x${vh}: a card starts at x=${r.rect.x.toFixed(1)}`)
        assert(r.rect.x + r.rect.w <= w - STACK_MARGIN + 0.01, `${name} at ${vw}x${vh}: a card runs to x=${(r.rect.x + r.rect.w).toFixed(1)} in a ${w}px canvas`)
      }
      // The majority rule.
      assert(
        main.h / content >= MAIN_MIN_SHARE - 0.005,
        `${name} at ${vw}x${vh}: the main card is ${((main.h / content) * 100).toFixed(0)}% of the stack, under the ${MAIN_MIN_SHARE * 100}% floor`,
      )
      rows.push(`${name}@${vw}: main ${main.w.toFixed(0)}x${main.h.toFixed(0)} + ${decks.map((r) => `${r.w.toFixed(0)}x${r.h.toFixed(0)}`).join('+')} (${((main.h / content) * 100).toFixed(0)}%)`)
    }
  }
  return rows.filter((r) => /@375|@430/.test(r)).join(' ; ')
})

test('a shallow deck is LIFTED to the readability floor; two decks yield to the majority rule instead', () => {
  // LOTR's Paths of the Dead is the shallowest authored deck (bounds.h 0.12).
  // At true scale on a 375x667 phone it comes out under the floor, so the
  // floor is what sets its height — that is the lift working.
  const box = stackBox(375, 667)
  const lotr = computeStackRects(box.w, box.h, REAL.lotr)
  const deck = lotr.find((c) => c.zone !== null).rect
  const main = lotr.find((c) => c.zone === null).rect
  const trueH = main.h * REAL.lotr[0].bounds.h
  assert(trueH < MIN_DECK_HEIGHT, `setup: true scale should be under the floor, got ${trueH.toFixed(1)}`)
  assert(Math.abs(deck.h - MIN_DECK_HEIGHT) < 0.01, `expected the deck lifted to ${MIN_DECK_HEIGHT}, got ${deck.h.toFixed(1)}`)

  // Halloween asks for TWO lifted decks on a 320px phone, which would take the
  // main card under its majority. The decks give the height back instead.
  const small = stackBox(320, 568)
  const hw = computeStackRects(small.w, small.h, REAL.halloween)
  const hwMain = hw.find((c) => c.zone === null).rect
  const hwDecks = hw.filter((c) => c.zone !== null).map((c) => c.rect)
  assert(hwDecks.every((r) => r.h < MIN_DECK_HEIGHT), `expected both decks scaled BACK under the floor, got ${hwDecks.map((r) => r.h.toFixed(0))}`)
  const share = hwMain.h / (hwMain.h + hwDecks.reduce((a, r) => a + r.h, 0))
  assert(Math.abs(share - MAIN_MIN_SHARE) < 0.005, `expected the main card held at exactly its floor, got ${(share * 100).toFixed(1)}%`)
  return `LOTR lifted ${trueH.toFixed(0)} -> ${deck.h.toFixed(0)}; Halloween at 320 yields to ${hwDecks.map((r) => r.h.toFixed(0)).join('+')} for a ${(share * 100).toFixed(0)}% main`
})

test('a lower zone is drawn BELOW the main card; everything else above it, in table order', () => {
  const { w, h } = stackBox(390, 780)
  // AC/DC's Underworld — the shipped lower zone.
  const acdc = computeStackRects(w, h, REAL.acdc)
  const acMain = acdc.find((c) => c.zone === null).rect
  const acLow = acdc.find((c) => c.zone !== null).rect
  assert(acLow.y > acMain.y, `a kind:'lower' window must sit below the playfield (low y=${acLow.y.toFixed(0)}, main y=${acMain.y.toFixed(0)})`)
  assert(acLow.y >= acMain.y + acMain.h - 0.01, 'and clear of it, not overlapping')

  // Halloween's two zones are BOTH non-lower, so both go above — and the one
  // higher up the table (Strode House, bounds.y 0.65) is the one nearer the
  // canvas top.
  const hw = computeStackRects(w, h, REAL.halloween)
  const order = hw.map((c) => (c.zone ? c.zone.id : 'MAIN'))
  assert(order.join(' -> ') === 'house-deck -> sanitarium-deck -> MAIN', `expected the decks above main in table order, got ${order.join(' -> ')}`)

  // And a machine with one of each puts the playfield in the middle.
  const both = computeStackRects(w, h, [DECK_ZONE, LOWER_ZONE])
  assert(both.map((c) => (c.zone ? c.zone.id : 'MAIN')).join(' -> ') === 'z-deck -> MAIN -> z-low', `got ${both.map((c) => (c.zone ? c.zone.id : 'MAIN')).join(' -> ')}`)
  return `AC/DC: main y${acMain.y.toFixed(0)} then Underworld y${acLow.y.toFixed(0)} ; Halloween: ${order.join(' -> ')}`
})

test('a degenerate box lays nothing out rather than drawing garbage', () => {
  assert(computeStackRects(0, 600, REAL.jaws).length === 0, 'a zero-width canvas must lay out nothing')
  assert(computeStackRects(300, 0, REAL.jaws).length === 0, 'a zero-height canvas must lay out nothing')
  assert(computeStackRects(300, 2 * STACK_MARGIN + STACK_GAP, REAL.jaws).length === 0, 'a box with no budget left must lay out nothing')
  // No zones at all is not degenerate — it is exactly the MAIN card.
  const { w, h } = stackBox(390, 780)
  const alone = computeStackRects(w, h, [])
  assert(alone.length === 1 && alone[0].zone === null, 'zero zones must give exactly the main card')
  const solo = playfieldRect(w, h)
  assert(
    Math.abs(alone[0].rect.w - solo.w) < 0.01 && Math.abs(alone[0].rect.h - solo.h) < 0.01 && Math.abs(alone[0].rect.y - solo.y) < 0.01,
    `with no decks the stack must BE playfieldRect's card, got ${JSON.stringify(alone[0].rect)} vs ${JSON.stringify(solo)}`,
  )
  return 'degenerate boxes empty; zero zones == playfieldRect'
})

// --- the mounted ALL level -------------------------------------------------
withMountedStudy(fakeAppState({ shots: BOTH_SHOTS, playfields: [DECK_ZONE, LOWER_ZONE] }), ({ host, calls }) => {
  /** Steps the scroller to ALL LEVELS and returns the calls recorded since. */
  function toAllLevel() {
    let guard = 0
    while (levelName(host) !== 'ALL LEVELS' && guard++ < 8) arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(levelName(host) === 'ALL LEVELS', 'setup: could not reach the combined level')
  }

  test('ALL walks the WHOLE machine, not one surface', () => {
    const mainCount = host.find('study-readout-label').textContent
    toAllLevel()
    assert(
      host.find('study-readout-label').textContent === mainCount,
      `ALL must walk the same roster MAIN does, got ${JSON.stringify(host.find('study-readout-label').textContent)} vs ${JSON.stringify(mainCount)}`,
    )
    return `${mainCount} on both MAIN and ALL LEVELS`
  })

  test('every shot is drawn EXACTLY ONCE, and a deck shot lands on its own deck card', () => {
    const before = calls.length
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    const dots = dotPositions(calls.slice(before))
    const tour = buildTour(BOTH_SHOTS, 'premium-le')
    assert(dots.length === tour.length, `expected one insert per tour shot (${tour.length}), got ${dots.length} — a shot is being drawn on two cards, or dropped`)

    // The three cards' vertical bands, from the layout function itself.
    const box = { w: W - RAIL_W, h: H - T_BOTTOM_CLEARANCE - T_TOP_PAD }
    const stack = computeStackRects(box.w, box.h, [DECK_ZONE, LOWER_ZONE]).map((c) => ({ ...c, rect: { ...c.rect, y: c.rect.y + T_TOP_PAD / 2 } }))
    const bandOf = (y) => {
      const hit = stack.find((c) => y >= c.rect.y - 0.5 && y <= c.rect.y + c.rect.h + 0.5)
      return hit ? (hit.zone ? hit.zone.id : 'MAIN') : 'OFF-CARD'
    }
    // dotPositions is in draw order, which is card order: deck, main, lower.
    const deckShots = tour.filter((s) => s.playfield === 'z-deck')
    const lowShots = tour.filter((s) => s.playfield === 'z-low')
    const mainShots = tour.filter((s) => !s.playfield)
    assert(deckShots.length === 3 && lowShots.length === 1 && mainShots.length === 5, `setup: ${deckShots.length}/${lowShots.length}/${mainShots.length}`)
    const bands = dots.map((d) => bandOf(d.y))
    const want = [...deckShots.map(() => 'z-deck'), ...mainShots.map(() => 'MAIN'), ...lowShots.map(() => 'z-low')]
    assert(bands.join(',') === want.join(','), `expected each shot on its own card [${want.join(', ')}], got [${bands.join(', ')}]`)
    return `${dots.length} inserts: ${want.filter((b) => b === 'z-deck').length} on the deck card, ${want.filter((b) => b === 'MAIN').length} on main, ${want.filter((b) => b === 'z-low').length} on the lower card`
  })

  test('the CURRENT shot\'s floating name is drawn on the card its shot is on', () => {
    // Step to a deck shot and check the label lands inside the DECK card's
    // band, not over the main playfield where the shot used to be flattened.
    const tour = buildTour(BOTH_SHOTS, 'premium-le')
    const target = tour.findIndex((s) => s.playfield === 'z-deck')
    assert(target !== -1, 'setup: the fixture has a deck shot')
    toAllLevel()
    // WALK FROM WHEREVER THE TOUR ACTUALLY IS, read off the readout, rather
    // than assuming a previous test left it on shot 1 — the ‹ › wrap makes
    // "step N times" meaningless without a known start.
    const at = Number(/SHOT (\d+) OF/.exec(host.find('study-readout-label').textContent)[1]) - 1
    const next = host.findAll('study-step-btn')[1]
    const before = calls.length
    for (let i = 0; i < (target - at + tour.length) % tour.length; i++) next.dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === `SHOT ${target + 1} OF ${tour.length}`, `setup: expected to land on shot ${target + 1}, got ${JSON.stringify(host.find('study-readout-label').textContent)}`)
    const name = tour[target].name
    // TRUNCATION IS EXPECTED and is itself the per-card clamp working: a deck
    // card is a fraction of the main card's width, so drawHaloLabel ellipsizes
    // a name that will not fit INSIDE THAT CARD rather than letting it run
    // over the playfield below. Match the clamped spelling the same way
    // section ad's zone-clamp test does.
    const isIt = (t) => typeof t === 'string' && (t === name || (t.endsWith('…') && name.startsWith(t.slice(0, -1))))
    const hits = calls.slice(before).filter((c) => c.method === 'fillText' && isIt(c.args[0]))
    assert(hits.length > 0, `the current shot "${name}" was never labelled`)
    const labelY = hits[hits.length - 1].args[2]
    const labelX = hits[hits.length - 1].args[1]
    const drawnW = String(hits[hits.length - 1].args[0]).length * 6

    const box = { w: W - RAIL_W, h: H - T_BOTTOM_CLEARANCE - T_TOP_PAD }
    const stack = computeStackRects(box.w, box.h, [DECK_ZONE, LOWER_ZONE]).map((c) => ({ ...c, rect: { ...c.rect, y: c.rect.y + T_TOP_PAD / 2 } }))
    const deck = stack.find((c) => c.zone && c.zone.id === 'z-deck').rect
    const main = stack.find((c) => c.zone === null).rect
    // The label is drawn 15px above its dot, so it may sit just off the card's
    // top edge — what it must never do is land on the MAIN card below.
    assert(labelY < main.y, `"${name}" is labelled at y=${labelY.toFixed(0)}, on the main card (y ${main.y.toFixed(0)}..${(main.y + main.h).toFixed(0)}) rather than its own deck (y ${deck.y.toFixed(0)}..${(deck.y + deck.h).toFixed(0)})`)
    // PER-CARD CLAMPING, measured: the text box is inside the DECK card, not
    // inside the (much wider) main card it sits above. A stack that shared one
    // clamp would pass a `labelX` check against the canvas and still run this
    // name off its own card.
    assert(
      labelX - drawnW / 2 >= deck.x - 0.51 && labelX + drawnW / 2 <= deck.x + deck.w + 0.51,
      `the label spans ${(labelX - drawnW / 2).toFixed(1)}..${(labelX + drawnW / 2).toFixed(1)} but its deck card is ${deck.x.toFixed(1)}..${(deck.x + deck.w).toFixed(1)} — it is running off the card it belongs to`,
    )
    assert(deck.w < main.w, 'setup: the deck card must be narrower than main, or this clamp proves nothing')
    return `"${name}" -> "${hits[hits.length - 1].args[0]}" at y${labelY.toFixed(0)} x${(labelX - drawnW / 2).toFixed(0)}..${(labelX + drawnW / 2).toFixed(0)}, inside deck card ${deck.x.toFixed(0)}..${(deck.x + deck.w).toFixed(0)} (main is ${main.w.toFixed(0)}px wide, starts y${main.y.toFixed(0)})`
  })

  test('TAP-TO-INSPECT works on every card: a click at a deck dot jumps the tour to that shot', () => {
    toAllLevel()
    const before = calls.length
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    const dots = dotPositions(calls.slice(before))
    const tour = buildTour(BOTH_SHOTS, 'premium-le')
    const deckShots = tour.filter((s) => s.playfield === 'z-deck')
    const lowShots = tour.filter((s) => s.playfield === 'z-low')
    // Draw order is deck, main, lower — so the LAST dot is the lower-zone shot.
    const lowDot = dots[dots.length - 1]
    const canvas = host.find('study-canvas')
    canvas.dispatchEvent({ type: 'click', clientX: lowDot.x, clientY: lowDot.y })
    const want = tour.findIndex((s) => s.id === lowShots[0].id)
    assert(
      host.find('study-readout-label').textContent === `SHOT ${want + 1} OF ${tour.length}`,
      `a tap on the lower card's dot must jump to that shot (${want + 1}), got ${JSON.stringify(host.find('study-readout-label').textContent)}`,
    )
    // ...and the deck card's first dot, on the other side of the main card.
    const deckDot = dots[0]
    canvas.dispatchEvent({ type: 'click', clientX: deckDot.x, clientY: deckDot.y })
    const wantDeck = tour.findIndex((s) => s.id === deckShots[0].id)
    assert(
      host.find('study-readout-label').textContent === `SHOT ${wantDeck + 1} OF ${tour.length}`,
      `a tap on the deck card's dot must jump to that shot (${wantDeck + 1}), got ${JSON.stringify(host.find('study-readout-label').textContent)}`,
    )
    return `lower dot -> shot ${want + 1}, deck dot -> shot ${wantDeck + 1}`
  })

  test('the sheets follow the tour on ALL exactly as they do on MAIN', () => {
    toAllLevel()
    const tour = buildTour(BOTH_SHOTS, 'premium-le')
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const names = host.find('study-learn-panel').findAll('study-index-name').map((n) => n.textContent)
    assert(names.length === tour.length, `LEARN's list must show the whole machine on the combined level, got ${names.length} of ${tour.length}`)
    assert(names.join(',') === tour.map((s) => s.name).join(','), 'and in the tour\'s own order')
    // A row still jumps the tour and leaves the sheet up.
    const rows = host.find('study-learn-panel').findAll('study-index-row')
    rows[2].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === `SHOT 3 OF ${tour.length}`, 'a row must still jump the tour')
    assert(host.find('study-learn-panel'), 'and the sheet must stay open')
    assert(host.find('study-learn-panel').find('study-learn-title').textContent === tour[2].name, 'and the detail must follow it')
    host.find('study-learn-back').dispatchEvent({ type: 'click' })
    // LEARN names the shot the tour is on, whichever card that is.
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-learn-title').textContent === tour[2].name, `LEARN must follow the tour across cards, got ${JSON.stringify(host.find('study-learn-title').textContent)}`)
    host.find('study-learn-back').dispatchEvent({ type: 'click' })
    return `${names.length} rows, LEARN on "${tour[2].name}"`
  })

  test('the rail aligns to the TOP CARD of the stack, so the pills still start where the drawing does', () => {
    toAllLevel()
    const published = Number(String(host.style.getPropertyValue('--study-card-top')).replace('px', ''))
    const box = { w: W - RAIL_W, h: H - T_BOTTOM_CLEARANCE - T_TOP_PAD }
    const stack = computeStackRects(box.w, box.h, [DECK_ZONE, LOWER_ZONE])
    const top = stack[0].rect.y + T_TOP_PAD / 2
    assert(Math.abs(published - top) < 0.51, `--study-card-top is ${published}, expected the top card's edge ${top.toFixed(1)}`)
    return `--study-card-top ${published}px = top card y${top.toFixed(1)}`
  })
})

// --- ALL under a MODEL that hides one of two decks -------------------------
test('a trim-hidden deck simply does not render — the stack is what this MODEL has', () => {
  const zones = [DECK_ZONE, { ...PREM_ZONE, kind: 'mini' }]
  const shots = [...ZONE_SHOTS, { id: 's-prem-deck', name: 'Prem Deck Shot', type: 'ramp', x: 0.4, y: 0.7, trim: 'premium-le', playfield: 'z-prem' }]
  const box = { w: W - RAIL_W, h: H - T_BOTTOM_CLEARANCE - T_TOP_PAD }
  /** The main card's DRAWN height, recovered from two shots at known v — the
   *  same two-dot recovery sections (l) and (w) use. This is the measurement
   *  that makes the claim real: an unfiltered stack has one more card, so the
   *  budget is split differently and the MAIN card comes out a different size
   *  even though every hidden SHOT was already filtered out of the tour. A
   *  dot COUNT alone cannot see that, and did not. */
  function drawnMainHeight(trim) {
    let h = null
    let reason = null
    withMountedStudy(fakeAppState({ trim, shots, playfields: zones }), ({ host, calls }) => {
      let guard = 0
      while (levelName(host) !== 'ALL LEVELS' && guard++ < 8) arrows(host)[1].dispatchEvent({ type: 'click' })
      const before = calls.length
      host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
      const dots = dotPositions(calls.slice(before))
      const tour = buildTour(shots, trim)
      assert(dots.length === tour.length, `${trim}: expected one insert per tour shot (${tour.length}), got ${dots.length}`)
      // Draw order is deck cards, then MAIN, then lower cards — so the main
      // card's own shots are a contiguous run, and s-top (v 0.9) / s-bottom
      // (v 0.1) inside it pin the card exactly.
      const mainShots = tour.filter((s) => !s.playfield)
      const offset = tour.filter((s) => s.playfield && s.playfield !== 'z-low').length
      const iTop = mainShots.findIndex((s) => s.id === 's-top')
      const iBottom = mainShots.findIndex((s) => s.id === 's-bottom')
      assert(iTop !== -1 && iBottom !== -1, 'setup: the main card must hold the two pinning shots')
      h = (dots[offset + iBottom].y - dots[offset + iTop].y) / 0.8
      reason = host.find('study-level-reason')?.textContent ?? null
    })
    return { h, reason }
  }

  const prem = drawnMainHeight('premium-le')
  const pro = drawnMainHeight('pro')
  const wantPrem = computeStackRects(box.w, box.h, zones).find((c) => c.zone === null).rect.h
  const wantPro = computeStackRects(box.w, box.h, [DECK_ZONE]).find((c) => c.zone === null).rect.h
  assert(Math.abs(wantPrem - wantPro) > 20, `setup: the two stacks must differ enough to measure (${wantPrem.toFixed(1)} vs ${wantPro.toFixed(1)})`)
  assert(Math.abs(prem.h - wantPrem) < 0.6, `Premium/LE drew a ${prem.h.toFixed(1)}px main card; a 3-card stack wants ${wantPrem.toFixed(1)}`)
  assert(
    Math.abs(pro.h - wantPro) < 0.6,
    `Pro drew a ${pro.h.toFixed(1)}px main card, but a 2-card stack wants ${wantPro.toFixed(1)} (a 3-card stack would want ${wantPrem.toFixed(1)}) — ` +
      `the hidden deck is still taking room in the stack`,
  )
  // The reason line is still there, so the deck is still discoverable.
  assert(pro.reason && /upper deck/i.test(pro.reason), 'the hidden deck must still explain itself under the scroller')
  assert(prem.reason === null, 'a visible deck needs no reason line')
  return `main card ${prem.h.toFixed(0)}px in a 3-card stack -> ${pro.h.toFixed(0)}px in the 2-card Pro stack; hidden deck explained, not drawn`
})


// ===========================================================================
section('af. MODEL in the rail: the same switch, where the person who needs it is')
// ===========================================================================
// 2026-08-14, rolo, on a Pro whose only deck is Premium/LE: "The buttons on
// the side still aren't changing the playfield."
//
// He was right twice. The LEVEL arrows were dead (fixed in section ad), and
// the thing that would have made them live — MODEL — lived in a popover on
// another tab, named only by a reason line that said "switch MODEL in
// settings". This section pins the second half: the same control, mounted in
// the rail, writing the SAME state.
//
// THE SYNC CLAIM IS THE WHOLE POINT, so it is tested from both directions:
// pressing PREM/LE here writes state.trim (which is what the Shots popover
// reads on its own next notify), and a trim written ANYWHERE re-lights this
// control through the subscription it already had. Neither control caches its
// selection — tests/goal-bridge.test.mjs asserts that at the source for both
// files, and asserts the caller set is closed at two.

/** DECK_ZONE, restricted to Premium/LE — Jaws's Orca deck in miniature, which
 *  is the exact machine rolo was holding. Same `id` as DECK_ZONE on purpose so
 *  ZONE_SHOTS' three `playfield: 'z-deck'` shots belong to it, which is what
 *  makes "the tour count follows the MODEL" a real measurement. */
const PREM_ZONE_DECK = { ...DECK_ZONE, trim: 'premium-le' }

const modelBtns = (host) => host.findAll('study-model-btn')
const selectedModel = (host) =>
  modelBtns(host)
    .filter((b) => String(b.className).split(/\s+/).includes('selected'))
    .map((b) => b.textContent)

test('a machine with NO trim-restricted content shows no MODEL control', () => {
  // Same rule the Shots popover uses (goalMeta's machineHasVariants, imported
  // rather than re-derived): nothing to switch between, so no switch. SHOTS
  // here are all trim:'all' and the machine has no zones at all.
  const flat = SHOTS.map((s) => ({ ...s, trim: 'all' }))
  withMountedStudy(fakeAppState({ shots: flat, playfields: [] }), ({ host }) => {
    const group = host.find('study-model-group')
    assert(group, 'the control should exist in the DOM (hidden), like every other conditional in this rail')
    assert(group.hidden === true, 'a machine with no variants must not offer a MODEL choice with no effect')
    assert(cssValue('.study-model-group', 'display') === 'flex', 'setup: the group is a flex column')
    assert(
      cssValue('.study-model-group[hidden]', 'display') === 'none',
      'the group sets its own display, so it MUST restate [hidden] — otherwise every flat machine shows a dead MODEL heading',
    )
    return 'hidden, and the hide actually wins the cascade'
  })
})

test('a machine WITH variants shows PRO | PREM/LE, lit to the current trim', () => {
  withMountedStudy(fakeAppState({ trim: 'pro', shots: SHOTS, playfields: [PREM_ZONE] }), ({ host }) => {
    assert(host.find('study-model-group').hidden === false, 'expected the control shown')
    const labels = modelBtns(host).map((b) => b.textContent)
    assert(labels.join(' | ') === 'PRO | PREM/LE', `got ${JSON.stringify(labels)}`)
    assert(selectedModel(host).join() === 'PRO', `on Pro, PRO must be the lit half, got ${JSON.stringify(selectedModel(host))}`)
    // aria-pressed carries the same fact for a screen reader — two buttons
    // that each state their own on/off, no roving tabindex to get wrong.
    assert(modelBtns(host)[0].getAttribute('aria-pressed') === 'true', 'PRO must report itself pressed')
    assert(modelBtns(host)[1].getAttribute('aria-pressed') === 'false', 'PREM/LE must report itself unpressed')
    return `${labels.join(' | ')}, PRO lit`
  })
})

{
  // THE OWNER'S OWN PATH, end to end: a Pro, a deck he cannot reach, one tap.
  const state = fakeAppState({ trim: 'pro', shots: ZONE_SHOTS, playfields: [PREM_ZONE_DECK] })
  withMountedStudy(state, ({ host }) => {
    test('setup: on Pro the deck is hidden, there is no cycle, and the reason names it', () => {
      assert(levelName(host) === 'MAIN', 'the only reachable level is MAIN')
      assert(host.find('study-level-arrows').hidden === true, 'no arrows, because there is nowhere to go')
      assert(/test deck/i.test(host.find('study-level-reason').textContent), 'the reason line names the deck')
      return host.find('study-level-reason').textContent
    })

    test('pressing PREM/LE writes the trim, lights itself, and makes the deck REACHABLE — live', () => {
      modelBtns(host)[1].dispatchEvent({ type: 'click' })
      assert(state.trim === 'premium-le', `the control must write AppState.trim, got ${JSON.stringify(state.trim)}`)
      assert(selectedModel(host).join() === 'PREM/LE', `the lit half must follow, got ${JSON.stringify(selectedModel(host))}`)
      // The deck is now a stop in the cycle, so the arrows come back...
      assert(host.find('study-level-arrows').hidden === false, 'the arrows must return with the second level')
      assert(arrows(host).every((a) => a.disabled === false), 'and be live')
      // ...and it is reachable by pressing one.
      arrows(host)[1].dispatchEvent({ type: 'click' })
      assert(levelName(host) === 'TEST DECK', `expected the deck, got ${JSON.stringify(levelName(host))}`)
      assert(!host.find('study-level-reason'), 'and the reason line is gone — the deck is no longer hidden')
      return 'PRO -> PREM/LE -> arrows back -> ORCA-class deck on screen'
    })

    test('the tour count follows the MODEL, and the level change is still announced', () => {
      // Back to MAIN first so the count being compared is the main tour's.
      arrows(host)[0].dispatchEvent({ type: 'click' })
      assert(levelName(host) === 'MAIN', 'setup: on MAIN')
      const premCount = host.find('study-readout-label').textContent
      modelBtns(host)[0].dispatchEvent({ type: 'click' })
      assert(state.trim === 'pro', 'setup: back on Pro')
      const proCount = host.find('study-readout-label').textContent
      assert(premCount !== proCount, `the tour must re-filter with the MODEL (${premCount} vs ${proCount})`)
      const live = host.findAll('sr-only')[0]
      assert(/premium\/le/i.test(live.textContent) || /main playfield/i.test(live.textContent), `the drop must still be announced, got ${JSON.stringify(live.textContent)}`)
      return `${premCount} -> ${proCount}`
    })

    test('pressing the half that is ALREADY lit does nothing at all', () => {
      // setTrim's own no-op guard. Without it, a second press re-notifies —
      // which re-runs the whole sync path and re-announces a level change
      // nobody made.
      const live = host.findAll('sr-only')[0]
      live.textContent = 'SENTINEL'
      modelBtns(host)[0].dispatchEvent({ type: 'click' })
      assert(state.trim === 'pro', 'the trim must be unchanged')
      assert(live.textContent === 'SENTINEL', 'a no-op press must not announce anything')
      return 'no write, no notify, no announcement'
    })

    test('a MODEL switch made ELSEWHERE (the Shots popover) re-lights this control', () => {
      // The other direction of the same contract. The popover writes
      // state.trim and notifies; this rail has no idea that happened except
      // through the subscription — which is exactly how they stay in sync.
      state.trim = 'premium-le'
      state._notify()
      assert(selectedModel(host).join() === 'PREM/LE', `the rail must follow a trim written elsewhere, got ${JSON.stringify(selectedModel(host))}`)
      state.trim = 'pro'
      state._notify()
      assert(selectedModel(host).join() === 'PRO', 'and back')
      return 'external write -> rail relights, both ways'
    })
  })
}

test('the MODEL buttons are a real tap target, and the rail can still hold everything', () => {
  const h = /(\d+(?:\.\d+)?)px/.exec(cssValue('.study-model-btn', 'height') || '')
  assert(h && Number(h[1]) >= 44, `expected a >= 44px tall MODEL button, got ${cssValue('.study-model-btn', 'height')}`)
  assert(cssValue('.study-model-btn', 'flex') === '1', 'the two halves must split the rail width, not size to their text')
  // Ordered AFTER the LEVEL group, which carries the column's margin-top:auto
  // — that is what pins them to the rail's bottom edge, where the drawn card's
  // top edge cannot drag them (see section ad's note for the incident).
  const levelOrder = Number(cssValue('.study-level-group', 'order'))
  const modelOrder = Number(cssValue('.study-model-group', 'order'))
  assert(modelOrder > levelOrder, `MODEL (order ${modelOrder}) must sit below LEVEL (order ${levelOrder})`)
  assert(cssValue('.study-model-group', 'flex-shrink') === '0', 'the MODEL control must not shrink — the spacer is the shrinkable box in this column')
  return `44px halves, order ${levelOrder} -> ${modelOrder}`
})

// ===========================================================================
section('ak. HOW IT PLAYS + LIGHTS (schema v9): the two surfaces the pills open')
// ===========================================================================

test('HOW IT PLAYS hides without the field and shows with it — and there is no separate LIGHTS pill', () => {
  let hidden = null
  let shown = null
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS }), ({ host }) => {
    hidden = host.find('study-howitplays-btn').hidden
    assert(!host.find('study-lights-btn'), 'the standalone LIGHTS pill must be gone (folded into LEARN, 2026-09-08)')
  })
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    shown = host.find('study-howitplays-btn').hidden
    assert(!host.find('study-lights-btn'), 'still no LIGHTS pill even with howItPlays')
  })
  assert(hidden === true, 'HOW IT PLAYS mounts hidden without the field')
  assert(shown === false, 'HOW IT PLAYS shows with a valid howItPlays')
  return 'HOW IT PLAYS hides/shows; no LIGHTS pill'
})

test('HOW IT PLAYS opens the shared shell and renders objective / loop / lane change / scoring verbatim', () => {
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-howitplays-panel')
    assert(panel, 'expected .study-howitplays-panel')
    assert(panel.className.split(/\s+/).includes('study-learn-panel'), 'it must ride the SHARED sheet shell')
    assert(panel.getAttribute('role') === 'dialog' && panel.getAttribute('aria-modal') === 'true', 'the shared dialog wiring must apply')
    assert(panel.getAttribute('aria-labelledby') === 'study-howitplays-title', 'named by its own title')
    const text = panel.textContent
    assert(text.includes(HOW_IT_PLAYS.objective), 'objective verbatim')
    for (const line of HOW_IT_PLAYS.loop) assert(text.includes(line), `loop line verbatim: ${line}`)
    for (const step of HOW_IT_PLAYS.scoring) assert(text.includes(step.text), `scoring text verbatim: ${step.text}`)
    assert(/BALL ONE/.test(text) && /BUILDING/.test(text) && /THE BIG ONE/.test(text), 'the three tier labels are present')
    assert(text.includes('Flipper buttons move the lit lane'), 'the flippers lane-change line')
    assert(!/\b\d+\s+(lights?|groups?|lanes?)\b/i.test(text), 'count-free copy')
    return `objective + ${HOW_IT_PLAYS.loop.length} loop + 3 tiers, count-free`
  })
})

test('LEARN carries a LIGHTS section under the TARGETS, and jumping to a light shows LIT / CONTROL / THEN', () => {
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    // Two labelled sections: TARGETS then LIGHTS (rolo's distinction).
    const headings = host.findAll('study-learn-list-title').map((h) => h.textContent)
    assert(headings.includes('TARGETS'), `expected a TARGETS heading, got ${JSON.stringify(headings)}`)
    assert(headings.includes('LIGHTS'), `expected a LIGHTS heading, got ${JSON.stringify(headings)}`)
    const lists = host.findAll('study-index-list')
    assert(lists.length === 2, `expected two index lists (targets + lights), got ${lists.length}`)
    const lightRows = lists[1].findAll('study-index-row')
    assert(lightRows.length === HOW_IT_PLAYS.lights.length, `expected ${HOW_IT_PLAYS.lights.length} light rows, got ${lightRows.length}`)
    assert(lightRows[0].textContent.includes('Shot arrows'), 'the first light row names its group')
    // Jump to the lanes group (lg-lanes, index 1) — the detail above swaps to it.
    lightRows[1].dispatchEvent({ type: 'click' })
    const detail = host.find('study-learn-detail')
    assert(detail.textContent.includes('Top lanes'), 'the detail names the selected light')
    assert(detail.textContent.includes(HOW_IT_PLAYS.lights[1].lit), 'LIT text shown in the detail')
    assert(detail.textContent.includes(HOW_IT_PLAYS.lights[1].then), 'THEN text shown in the detail')
    assert(detail.textContent.includes('CONTROL'), 'the lanes group shows its CONTROL line')
    return 'TARGETS + LIGHTS sections; light detail shows LIT/CONTROL/THEN'
  })
})

test('HOW IT PLAYS cross-links into LEARN on the same panel node', () => {
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    const panelBefore = host.find('study-howitplays-panel')
    assert(panelBefore, 'HOW IT PLAYS panel is open')
    host.find('study-hip-crosslink').dispatchEvent({ type: 'click' })
    assert(!host.find('study-howitplays-panel'), 'it is no longer HOW IT PLAYS after the cross-link')
    const learn = host.find('study-learn-panel')
    assert(learn === panelBefore, 'the swap reuses the same panel node (shared shell)')
    assert(host.findAll('study-index-list').length === 2, 'LEARN shows its TARGETS + LIGHTS lists after the swap')
  })
})

test('LEARN "Part of" jumps the tour to that light item, in place', () => {
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const chip = host.find('study-hip-partof-chip')
    assert(chip, 'expected a PART OF chip in the first shot detail (it belongs to a group)')
    assert(chip.textContent === 'Shot arrows', `the chip names the group, got ${JSON.stringify(chip.textContent)}`)
    chip.dispatchEvent({ type: 'click' })
    const detail = host.find('study-learn-detail')
    assert(detail.textContent.includes('Shot arrows'), 'the detail swapped to the named light group')
    assert(detail.textContent.includes(HOW_IT_PLAYS.lights[0].lit), 'and shows that group LIT text')
    assert(host.find('study-learn-panel') && !host.find('study-lights-panel'), 'stayed in LEARN — no separate LIGHTS sheet')
  })
})

test('goal chips call jumpToGoalDetail only when the callback is supplied', () => {
  const withGoals = { ...HOW_IT_PLAYS, scoring: HOW_IT_PLAYS.scoring.map((st, i) => (i === 0 ? { ...st, goals: ['g-plain'] } : st)) }
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: withGoals }), ({ host }) => {
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-hip-goal-chip'), 'no goal chip without the jump callback')
  })
  let called = null
  withMountedStudy(
    fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: withGoals }),
    ({ host }) => {
      host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
      const chip = host.find('study-hip-goal-chip')
      assert(chip, 'expected a goal chip with the callback')
      chip.dispatchEvent({ type: 'click' })
    },
    { jumpToGoalDetail: (g) => { called = g.id } },
  )
  assert(called === 'g-plain', `expected the chip to jump to g-plain, got ${called}`)
})

test('jumping to a LIGHT item lights its sites on the map and runs the pulse', () => {
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host, calls, step, pendingFrameScheduled }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const lightRows = host.findAll('study-index-list')[1].findAll('study-index-row')
    // lg-lanes is the second light: two sites (s-bottom, s-mid-left).
    lightRows[1].dispatchEvent({ type: 'click' })
    // A jump onto a light schedules the pulse rAF rather than painting inline —
    // fire one frame, then count the draws.
    const mark = calls.length
    step(100)
    const translatesAfter = calls.slice(mark).filter((c) => c.method === 'translate').length
    // The frame draws the shot dots PLUS the two lit sites.
    assert(translatesAfter >= 2, `expected the lit group's sites drawn (>=2 extra translates), got ${translatesAfter}`)
    assert(pendingFrameScheduled() === true, 'the pulse loop runs while the tour is on a lit group (motion on)')
    // moving to a TARGET clears the lit group and stops the loop
    host.findAll('study-index-list')[0].findAll('study-index-row')[0].dispatchEvent({ type: 'click' })
    assert(pendingFrameScheduled() === false, 'moving to a target clears the group and stops the lamp loop')
    return `${translatesAfter} translates on the light, loop on then off`
  })
})

test('reduced motion pins the lit group steady — no animation loop, still drawn', () => {
  withMountedStudy(
    fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }),
    ({ host, calls, pendingFrameScheduled }) => {
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      const lightRows = host.findAll('study-index-list')[1].findAll('study-index-row')
      const mark = calls.length
      lightRows[1].dispatchEvent({ type: 'click' })
      const translatesAfter = calls.slice(mark).filter((c) => c.method === 'translate').length
      assert(translatesAfter >= 2, 'the sites are still drawn under reduced motion')
      assert(pendingFrameScheduled() === false, 'reduced motion must not start the pulse loop')
    },
    { reducedMotion: true },
  )
})

test('the lit group follows the tour, not the sheet — it survives a pill swap', () => {
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host, calls, step, pendingFrameScheduled }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    host.findAll('study-index-list')[1].findAll('study-index-row')[1].dispatchEvent({ type: 'click' }) // lg-lanes lit
    assert(pendingFrameScheduled() === true, 'setup: the tour is on a lit group, pulse running')
    // Swap to CHARACTER — the tour did NOT move, so the lit group stays with it.
    host.find('study-character-btn').dispatchEvent({ type: 'click' })
    assert(host.find('study-character-panel'), 'CHARACTER is the open sheet now')
    assert(pendingFrameScheduled() === true, 'the lit group and its pulse survive the swap (tour-driven, not sheet-driven)')
    const mark = calls.length
    step(1200)
    const translates = calls.slice(mark).filter((c) => c.method === 'translate').length
    assert(translates >= 2, 'the group sites still draw behind the new sheet')
    return 'lit state is tour state, survives the pill swap'
  })
})

test('each LEARN detail links to the Shots tab, and the link calls showGoalOnShots (rolo 2026-09-08)', () => {
  // No callback wired: no link (a dead door is worse than none).
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    assert(!host.find('study-shots-link'), 'no Shots-tab link without the host bridge')
  })
  // Callback wired: the first shot (s-top) is a step of g-char-routed, so its
  // detail offers "See it on the playfield", and the link selects that goal.
  let shown = null
  withMountedStudy(
    fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }),
    ({ host }) => {
      host.find('study-learn-btn').dispatchEvent({ type: 'click' })
      const link = host.find('study-shots-link')
      assert(link, 'expected a "See it on the playfield" link in the shot detail')
      link.dispatchEvent({ type: 'click' })
    },
    { showGoalOnShots: (g) => { shown = g.id } },
  )
  // goalForShot returns the FIRST goal whose route touches the shot (whichever
  // that is in the fixture) — and by construction it does feature the shot, so
  // asserting a real routed goal was passed is the honest contract.
  assert(shown, `expected the link to select a goal, got ${shown}`)
  const picked = ALL_PILL_GOALS.find((g) => g.id === shown)
  assert(picked && (picked.steps ?? []).length > 0, `expected a real goal with a route, got ${shown}`)
  return 'no link without the bridge; with it, jumps a routed goal featuring the shot'
})

test('both TARGETS and LIGHTS ride the launch rotation (auto shuffle reaches a light)', () => {
  withMountedStudy(fakeAppState({ goals: ALL_PILL_GOALS, howItPlays: HOW_IT_PLAYS }), ({ host, step, pendingFrameScheduled }) => {
    // At launch, no sheet is open and the tour is PAUSED (2026-10-14); one tap
    // on the readout starts the shuffle over the COMBINED tour (targets, then
    // lights). Each frame whose clock has moved a full hold past the last
    // advance steps exactly one item; a 10s delta safely clears any hold. Walk
    // it and confirm the readout eventually names a LIGHT.
    assert(pendingFrameScheduled() === false, 'the tour arrives paused — nothing scheduled before the tap')
    host.find('study-readout').dispatchEvent({ type: 'click' })
    assert(pendingFrameScheduled() === true, 'the auto rotation runs once the readout is tapped')
    const label = () => host.find('study-readout-label')?.textContent ?? ''
    assert(/SHOT/.test(label()), 'the rotation starts on a target')
    let sawLight = false
    for (let i = 1; i <= 40 && !sawLight; i++) {
      step(i * 10000)
      if (/LIGHT/.test(label())) sawLight = true
    }
    assert(sawLight, 'the auto rotation must reach a LIGHT item (readout shows "LIGHT n OF m")')
    return 'the shuffle walks targets then lights'
  })
})

// --- regression guards for the two fixes the adversarial verifier flagged ---

test('the LIGHTS section rides the MAIN level only — ALL LEVELS has none (guards c926528)', () => {
  // computeTour used to add tourLights on the ALL level too, but render() takes
  // the renderAllLevel path there and returns before the lit-sites draw, so a
  // light in the tour on ALL could never paint. c926528 gates it on
  // studyLevel==='main'; this reaches ALL and asserts the LIGHTS section is gone.
  withMountedStudy(fakeAppState({ shots: BOTH_SHOTS, playfields: [DECK_ZONE, LOWER_ZONE], howItPlays: HOW_IT_PLAYS }), ({ host }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    let headings = host.findAll('study-learn-list-title').map((h) => h.textContent)
    assert(headings.includes('LIGHTS'), `setup: on MAIN a LIGHTS section is expected, got ${JSON.stringify(headings)}`)
    // Cycle to ALL LEVELS (selectLevel closes the open sheet on the way).
    let guard = 0
    while (levelName(host) !== 'ALL LEVELS' && guard++ < 8) arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(levelName(host) === 'ALL LEVELS', 'setup: could not reach ALL LEVELS')
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    headings = host.findAll('study-learn-list-title').map((h) => h.textContent)
    assert(!headings.includes('LIGHTS'), `on ALL the LIGHTS section must be gone (renderAllLevel cannot paint lit sites), got ${JSON.stringify(headings)}`)
    assert(host.findAll('study-index-list').length === 1, 'ALL shows only the TARGETS list, no LIGHTS list')
    return 'LIGHTS on MAIN, absent on ALL'
  })
})

test('a MODEL switch re-resolves a lit group under a stable id — no stale premium lamp on Pro (guards verifier HIGH)', () => {
  // A light whose ONLY site is the premium-le shot: on Pro that site drops, so
  // the lit set must become empty. The cheap-guard used to skip the re-resolve
  // when the group id was unchanged, bleeding the premium lamp onto the Pro
  // playfield (Jaws' last light, Premium -> Pro).
  const premLight = { id: 'lg-prem', name: 'Premium Lamp', kind: 'shot-arrow', sites: [{ shot: 's-premium' }], lit: 'lit', then: 'shoot it', control: null, goals: null }
  const state = fakeAppState({ trim: 'premium-le', howItPlays: { ...HOW_IT_PLAYS, lights: [premLight] } })
  withMountedStudy(state, ({ host, calls, step }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    const lightRows = host.findAll('study-index-list')[1].findAll('study-index-row')
    assert(lightRows.length === 1, `setup: expected the one premium light row, got ${lightRows.length}`)
    lightRows[0].dispatchEvent({ type: 'click' }) // jump to it — lit on premium-le
    let mark = calls.length
    step(100)
    const proShots = buildTour(SHOTS, 'pro').length
    const litOnPrem = calls.slice(mark).filter((c) => c.method === 'translate').length
    assert(litOnPrem > proShots, `setup: the premium site must draw on premium-le (got ${litOnPrem} translates, pro has ${proShots} shots)`)
    // Switch to Pro: s-premium drops, so the lit set must re-resolve to empty.
    modelBtns(host)[0].dispatchEvent({ type: 'click' })
    assert(state.trim === 'pro', 'setup: on Pro now')
    mark = calls.length
    step(200)
    const proTranslates = calls.slice(mark).filter((c) => c.method === 'translate').length
    assert(proTranslates <= proShots, `a stale premium lamp bled onto Pro: ${proTranslates} translates > ${proShots} pro shot dots`)
    return `premium-le drew ${litOnPrem}, Pro draws ${proTranslates} <= ${proShots} shots (no stale lamp)`
  })
})

// ===========================================================================
section('ai. THE TOUR STARTS PAUSED (2026-10-14) — arrival, the one tap that starts it, machine switch, reduced motion')
// ===========================================================================
// rolo's first-time-visitor walk: the tour shuffled through every shot the
// moment the tab opened, before the objective had been read. It now arrives in
// the paused state it always had, saying so, and moves only on the visitor's
// own tap. These pin the arrival, the start, and the two ways it could quietly
// start itself again (a machine switch restoring the old machine's mode, and
// reduced motion being mistaken for "no shuffle at all").

withMountedStudy(fakeAppState(), ({ host, step, pendingFrameScheduled }) => {
  test("arrives PAUSED: the readout says 'PAUSED · TAP FOR AUTO' and NO frame is scheduled", () => {
    const sub = host.find('study-readout-sub').textContent
    assert(sub === 'PAUSED · TAP FOR AUTO', `expected the paused wording on arrival, got ${JSON.stringify(sub)}`)
    assert(!pendingFrameScheduled(), 'a frame is scheduled on arrival — something is animating a tour that should be still')
    return sub
  })

  test('time passing moves nothing: there is no frame to run, and the readout stays on SHOT 1', () => {
    assert(step(60_000) === false, 'a frame ran after a minute of a paused tour')
    const label = host.find('study-readout-label').textContent
    assert(label === 'SHOT 1 OF 6', `the paused tour moved: ${label}`)
  })

  test('› steps one shot and does NOT start the shuffle (stepping is navigation, not a mode change)', () => {
    host.findAll('study-step-btn')[1].dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-label').textContent === 'SHOT 2 OF 6', 'expected › to step to shot 2')
    assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', 'stepping started the shuffle')
    assert(!pendingFrameScheduled(), 'stepping scheduled a shuffle frame')
  })

  test("a tap on the readout starts it: 'SHUFFLE · TAP TO PAUSE', a frame scheduled, and time now advances the tour", () => {
    host.find('study-readout').dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-sub').textContent === 'SHUFFLE · TAP TO PAUSE', 'the readout tap did not start the shuffle')
    assert(pendingFrameScheduled(), 'started, but no frame scheduled')
    // The tap stamped autoStartedAt at the fake clock step() last set (60s);
    // a frame 10s later is four holds past it, and the shuffle steps ONE item
    // per frame that has crossed a hold.
    step(70_000)
    const label = host.find('study-readout-label').textContent
    assert(label === 'SHOT 3 OF 6', `expected the shuffle to step once to shot 3, got ${label}`)
    return label
  })
})

{
  const state = fakeAppState({ actionButton: ACTION_BUTTON })
  withMountedStudy(state, ({ host, pendingFrameScheduled }) => {
    test('a MACHINE SWITCH lands paused, even when the old machine was SHUFFLING with a sheet open over it', () => {
      // The trap this pins: closeStudySheet restores the mode the tour had
      // before the sheet opened, and the switch closes the sheet AFTER setting
      // 'manual' — so without clearing that memory, the old machine's shuffle
      // would be handed straight to the new one.
      host.find('study-readout').dispatchEvent({ type: 'click' })
      assert(host.find('study-readout-sub').textContent === 'SHUFFLE · TAP TO PAUSE', 'setup: shuffling')
      host.find('study-action-btn').dispatchEvent({ type: 'click' })
      assert(host.find('study-ab-panel'), 'setup: a sheet is open over the shuffle')
      state.machine = { ...makeMachine(), id: 'second-machine', name: 'Second Machine' }
      state.data = makeData(SHOTS.filter((s) => s.id !== 's-premium'), [])
      state.shotsByID = new Map(state.data.shots.map((s) => [s.id, s]))
      state._notify()
      assert(!host.find('study-learn-panel'), 'a machine switch must close the sheet (the designed behaviour, section z)')
      assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', `the new machine inherited the old one's shuffle: ${host.find('study-readout-sub').textContent}`)
      assert(!pendingFrameScheduled(), 'a shuffle frame is scheduled on the new machine')
      return host.find('study-readout-label').textContent
    })
  })
}

{
  // THE SAME SWITCH WITH NO SHEET OPEN (2026-10-14 review, surviving mutant
  // M7). The test above passes even if the switch forgot its own
  // `mode = 'manual'`, because closeStudySheet then overwrites `mode` from the
  // cleared memory. With nothing open, closeStudySheet returns early and the
  // switch's own line is the ONLY thing pausing the tour — and the landing
  // (app.ts opens HOW IT PLAYS right after every switch) would then record the
  // stray shuffle as "running before the sheet" and restart it on Back.
  const state = fakeAppState({ howItPlays: HOW_IT_PLAYS })
  withMountedStudy(state, ({ host, handle, pendingFrameScheduled }) => {
    test('a MACHINE SWITCH with NO sheet open, mid-shuffle: lands paused, and closing the landing HOW IT PLAYS does not start the shuffle', () => {
      host.find('study-readout').dispatchEvent({ type: 'click' })
      assert(host.find('study-readout-sub').textContent === 'SHUFFLE · TAP TO PAUSE', 'setup: shuffling')
      assert(!host.find('study-learn-panel'), 'setup: no sheet is open')
      state.machine = { ...makeMachine(), id: 'second-machine', name: 'Second Machine' }
      state.data = makeData(SHOTS.filter((s) => s.id !== 's-premium'), [])
      state.data.howItPlays = HOW_IT_PLAYS
      state.shotsByID = new Map(state.data.shots.map((s) => [s.id, s]))
      state._notify()
      assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', `the new machine kept the old one's shuffle: ${host.find('study-readout-sub').textContent}`)
      assert(!pendingFrameScheduled(), 'a shuffle frame is scheduled on the new machine')
      // The landing, as app.ts does it after the switch.
      handle.openHowItPlays()
      assert(host.find('study-howitplays-panel'), 'setup: the landing sheet opened')
      host.find('study-learn-back').dispatchEvent({ type: 'click' })
      assert(!host.find('study-learn-panel'), 'setup: Back closed the sheet')
      assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', `closing the landing started a shuffle nobody asked for: ${host.find('study-readout-sub').textContent}`)
      assert(!pendingFrameScheduled(), 'a shuffle frame is scheduled after closing the landing')
    })
  })
}

withMountedStudy(
  fakeAppState(),
  ({ host, step, pendingFrameScheduled }) => {
    test('REDUCED MOTION arrives paused too — and the readout tap STILL starts the shuffle (the feature is kept)', () => {
      assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', 'reduced motion: expected the paused arrival')
      assert(!pendingFrameScheduled(), 'reduced motion: nothing should be scheduled on arrival')
      host.find('study-readout').dispatchEvent({ type: 'click' })
      assert(host.find('study-readout-sub').textContent === 'SHUFFLE · TAP TO PAUSE', 'reduced motion removed the shuffle instead of the motion')
      step(10_000)
      assert(host.find('study-readout-label').textContent === 'SHOT 2 OF 6', 'reduced motion: the started shuffle must still advance')
    })
  },
  { reducedMotion: true },
)

// ===========================================================================
section('aj. linkTerms / matchTerms (PURE) — real Jaws HOW IT PLAYS strings against the real glossary')
// ===========================================================================
// The words rolo hit on prod: bash boat, chum line, 3-bank, inlane, machete.
// Measured here against the shipped files, not a fixture: two of them are this
// machine's own SHOTS (bash boat, left 3-bank), one is a glossary term
// (inlane), and two have NO entry anywhere in the app (chum line, machete) —
// those stay plain text, and that is a content gap, not a matcher bug.

const JAWS = JSON.parse(readFileSync(resolve(__dirname, '../../data/jaws_goals.json'), 'utf8'))
const JAWS_HIP = JAWS.howItPlays
const linkOpts = (trim = 'premium-le') => ({ glossary: REAL_GLOSSARY, shots: buildTour(JAWS.shots, trim) })
const linksOf = (segs) =>
  segs.filter((s) => s.kind !== 'text').map((s) => (s.kind === 'shot' ? `shot:${s.text}->${s.shotId}` : `glossary:${s.text}->${s.term}`))
/** The loop line that starts with `prefix` — found by content, so a reorder of
 *  the dataset fails here with a clear message rather than testing the wrong
 *  sentence. */
function jawsLoop(prefix) {
  const line = JAWS_HIP.loop.find((l) => l.startsWith(prefix))
  if (!line) throw new Error(`fixture drift: no Jaws howItPlays.loop line starts with ${JSON.stringify(prefix)}`)
  return line
}

test('"Hit the bash boat…": the SHOT "bash boat" (from "Captive Ball / Bash Boat") and the glossary "mode"', () => {
  const links = linksOf(matchTerms(jawsLoop('Hit the bash boat'), linkOpts()))
  const want = ['shot:bash boat->captive-ball', 'glossary:mode->Mode']
  assert(JSON.stringify(links) === JSON.stringify(want), `got ${JSON.stringify(links)}`)
  return links.join(', ')
})

test('"Complete the left 3-bank…": the SHOT "left 3-bank", the glossary "inlane" — and "machete" stays plain (no entry exists)', () => {
  const line = jawsLoop('Complete the left 3-bank')
  const segs = matchTerms(line, linkOpts())
  const links = linksOf(segs)
  const want = ['shot:left 3-bank->fish-finder-bank', 'glossary:inlane->Inlane']
  assert(JSON.stringify(links) === JSON.stringify(want), `got ${JSON.stringify(links)}`)
  assert(segs.some((s) => s.kind === 'text' && s.text.includes('machete')), 'machete should be in a plain-text run')
  return links.join(', ')
})

test('"Feed the chum line…": "chum line" stays plain (no glossary entry, no shot of that name); "Multiball" links', () => {
  const links = linksOf(matchTerms(jawsLoop('Feed the chum line'), linkOpts()))
  assert(JSON.stringify(links) === JSON.stringify(['glossary:Multiball->Multiball']), `got ${JSON.stringify(links)}`)
  return links.join(', ')
})

test('the BUILDING tier: a plural ("inlanes") anchors on the entry\'s own name, and order follows the sentence', () => {
  const building = JAWS_HIP.scoring.find((s) => s.tier === 'building')
  const links = linksOf(matchTerms(building.text, linkOpts()))
  const want = ['glossary:multiplier->Multiplier', 'shot:left 3-bank->fish-finder-bank', 'glossary:inlanes->Inlane', 'glossary:Multiball->Multiball', 'glossary:mode->Mode']
  assert(JSON.stringify(links) === JSON.stringify(want), `got ${JSON.stringify(links)}`)
  return links.join(', ')
})

test('ROUND TRIP: for every Jaws prose string the sheet renders, the segments concatenate back to the exact original', () => {
  const texts = [
    JAWS_HIP.objective,
    ...JAWS_HIP.loop,
    ...JAWS_HIP.scoring.map((s) => s.text),
    ...JAWS.shots.map((s) => s.notes || '').filter(Boolean),
    ...JAWS_HIP.lights.flatMap((l) => [l.lit, l.flashing || '', l.then].filter(Boolean)),
  ]
  let links = 0
  for (const t of texts) {
    const segs = matchTerms(t, linkOpts())
    const back = segs.map((s) => s.text).join('')
    assert(back === t, `round trip changed the text:\n  in:  ${t}\n  out: ${back}`)
    links += segs.filter((s) => s.kind !== 'text').length
  }
  return `${texts.length} strings, ${links} links, every character preserved`
})

test('ONCE PER PARAGRAPH: the second "inlane" in one call is plain text', () => {
  const links = linksOf(matchTerms('Roll a lit inlane, then the other inlane.', linkOpts()))
  assert(JSON.stringify(links) === JSON.stringify(['glossary:inlane->Inlane']), `got ${JSON.stringify(links)}`)
})

test('LONGEST FIRST: "left inlane" is the SHOT, not the glossary "inlane" inside it', () => {
  const links = linksOf(matchTerms('It returns to the left inlane.', linkOpts()))
  assert(JSON.stringify(links) === JSON.stringify(['shot:left inlane->left-inlane']), `got ${JSON.stringify(links)}`)
})

test('EQUAL LENGTH: the machine\'s own shot beats the glossary entry ("captive ball" is both on Jaws)', () => {
  const links = linksOf(matchTerms('Shoot the captive ball.', linkOpts()))
  assert(JSON.stringify(links) === JSON.stringify(['shot:captive ball->captive-ball']), `got ${JSON.stringify(links)}`)
  // ...and with no shots supplied, the same words go to the glossary.
  const glossOnly = linksOf(matchTerms('Shoot the captive ball.', { glossary: REAL_GLOSSARY, shots: [] }))
  assert(JSON.stringify(glossOnly) === JSON.stringify(['glossary:captive ball->Captive ball']), `got ${JSON.stringify(glossOnly)}`)
})

test('WHOLE WORD: "Pro" links but "progress" does not; "Lock" inside "Flip-Lock" does not (the hyphen is inside a word)', () => {
  const links = linksOf(matchTerms('Track progress on the Pro, then use Flip-Lock.', linkOpts()))
  assert(JSON.stringify(links) === JSON.stringify(['glossary:Pro->Pro']), `got ${JSON.stringify(links)}`)
})

test("ACRONYMS ARE CASE-SENSITIVE: the 'Em of \"Ride 'Em Cowboy\" is not EM; \"EM tilt\" is", () => {
  const none = linksOf(matchTerms("Home of Ride 'Em Cowboy.", { glossary: REAL_GLOSSARY, shots: [] }))
  assert(none.length === 0, `got ${JSON.stringify(none)}`)
  const em = linksOf(matchTerms('EM tilt ends the whole game.', { glossary: REAL_GLOSSARY, shots: [] }))
  assert(JSON.stringify(em) === JSON.stringify(['glossary:EM->EM', 'glossary:tilt->Tilt']), `got ${JSON.stringify(em)}`)
})

test('STOPWORDS: head / special / gate / trap are not linked mid-sentence; the specific alias "one-way gate" still is', () => {
  const none = linksOf(matchTerms("Rath's head drops; a Special Attack; the harpoon gate; a trap door.", { glossary: REAL_GLOSSARY, shots: [] }))
  assert(none.length === 0, `got ${JSON.stringify(none)}`)
  const gate = linksOf(matchTerms('A one-way gate registers partial shots.', { glossary: REAL_GLOSSARY, shots: [] }))
  assert(JSON.stringify(gate) === JSON.stringify(['glossary:one-way gate->Gate']), `got ${JSON.stringify(gate)}`)
})

test('an ALIAS anchors on its entry\'s own name ("hold flipper" -> "Flipper hold"), hyphen == space ("lane-change")', () => {
  const a = linksOf(matchTerms('Hold flipper to trap it.', { glossary: REAL_GLOSSARY, shots: [] }))
  assert(JSON.stringify(a) === JSON.stringify(['glossary:Hold flipper->Flipper hold']), `got ${JSON.stringify(a)}`)
  const b = linksOf(matchTerms('Lane-change with the flipper buttons.', { glossary: REAL_GLOSSARY, shots: [] }))
  assert(b[0] === 'glossary:Lane-change->Lane change', `got ${JSON.stringify(b)}`)
})

test('the SHOT ROSTER is the caller\'s: a Premium/LE-only shot is a link on Premium/LE and plain text on Pro', () => {
  const text = 'Eight shots to the Lookout Tower ramp light an extra ball.'
  const prem = linksOf(matchTerms(text, linkOpts('premium-le')))
  const pro = linksOf(matchTerms(text, linkOpts('pro')))
  assert(prem.includes('shot:Lookout Tower ramp->lookout-tower-ramp'), `premium-le: ${JSON.stringify(prem)}`)
  assert(!pro.some((l) => l.startsWith('shot:')), `pro offered a shot link to a shot it does not have: ${JSON.stringify(pro)}`)
  // study.ts hands prose() exactly that roster — the main tour at the current MODEL.
  assert(/shots: buildTour\(state\.data\?\.shots \?\? \[\], state\.trim\)/.test(studySrc), 'prose() no longer passes the main tour at the current trim')
})

test('shotNameParts: full name always; derived parts only at TWO words or more ("left", "lock", "House" are not names)', () => {
  const cases = [
    ['Captive Ball / Bash Boat', ['Captive Ball / Bash Boat', 'Captive Ball', 'Bash Boat']],
    ['Left 3-Bank (Fish Finder)', ['Left 3-Bank (Fish Finder)', 'Left 3-Bank', 'Fish Finder']],
    ['Track Orbit (left)', ['Track Orbit (left)', 'Track Orbit']],
    ['Groot Mouth (Lock)', ['Groot Mouth (Lock)', 'Groot Mouth']],
    ['Mansion Entrance / House', ['Mansion Entrance / House', 'Mansion Entrance']],
    ['Upper (Right) Flipper', ['Upper (Right) Flipper', 'Upper Flipper']],
    ['Spinner', ['Spinner']],
  ]
  for (const [name, want] of cases) {
    const got = shotNameParts(name)
    assert(JSON.stringify(got) === JSON.stringify(want), `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
  return `${cases.length} shapes`
})

test('no glossary and no shots (data not loaded yet / failed): plain text, no throw', () => {
  const segs = matchTerms('Roll a lit inlane.', { glossary: null, shots: null })
  assert(segs.length === 1 && segs[0].kind === 'text' && segs[0].text === 'Roll a lit inlane.', JSON.stringify(segs))
  assert(matchTerms('', linkOpts()).length === 0, 'empty text must give no segments')
})

/** linkTerms builds DOM through the global `document`; this installs the
 *  suite's fake one for the length of `fn`. */
function withFakeDocument(fn) {
  const prior = globalThis.document
  globalThis.document = makeFakeDocument(recordingCtx().ctx)
  try {
    return fn()
  } finally {
    globalThis.document = prior
  }
}

test('linkTerms builds Text nodes and real <button type="button"> terms, prose casing kept, accessible name starts with the word', () => {
  withFakeDocument(() => {
    const frag = linkTerms(jawsLoop('Hit the bash boat'), linkOpts())
    const kinds = frag.children.map((c) => (c.tagName === '#TEXT' ? 'text' : c.tagName))
    assert(JSON.stringify(kinds) === JSON.stringify(['text', 'BUTTON', 'text', 'BUTTON', 'text']), `got ${JSON.stringify(kinds)}`)
    const [shotBtn, glossBtn] = frag.children.filter((c) => c.tagName === 'BUTTON')
    assert(shotBtn.type === 'button' && glossBtn.type === 'button', 'term buttons must be type="button"')
    assert(shotBtn.className === 'term-link term-link-shot', `shot class: ${shotBtn.className}`)
    assert(glossBtn.className === 'term-link term-link-glossary', `glossary class: ${glossBtn.className}`)
    assert(shotBtn.textContent === 'bash boat' && glossBtn.textContent === 'mode', 'the visible word must be the prose spelling')
    for (const b of [shotBtn, glossBtn]) {
      assert(b.getAttribute('aria-label').startsWith(b.textContent), `Label in Name: ${b.getAttribute('aria-label')}`)
    }
  })
})

test('linkTerms clicks: a shot term calls onShot(id), a glossary term calls onGlossaryTerm(entry name), and neither bubbles', () => {
  withFakeDocument(() => {
    const got = []
    const frag = linkTerms(jawsLoop('Complete the left 3-bank'), {
      ...linkOpts(),
      onShot: (id) => got.push(`shot:${id}`),
      onGlossaryTerm: (t) => got.push(`term:${t}`),
    })
    let stopped = 0
    for (const b of frag.children.filter((c) => c.tagName === 'BUTTON')) b.dispatchEvent({ type: 'click', stopPropagation: () => stopped++ })
    assert(JSON.stringify(got) === JSON.stringify(['shot:fish-finder-bank', 'term:Inlane']), `got ${JSON.stringify(got)}`)
    assert(stopped === 2, `expected both clicks to stop propagation (the sheet backdrop must not see them), got ${stopped}`)
  })
})

test('SANITISED: markup in the data is TEXT — no element but the term buttons is ever created, and every character survives', () => {
  withFakeDocument(() => {
    const hostile = 'Shoot the <img src=x onerror=alert(1)> inlane & <b>bash boat</b> now.'
    const frag = linkTerms(hostile, linkOpts())
    const tags = frag.children.map((c) => c.tagName)
    assert(tags.every((t) => t === '#TEXT' || t === 'BUTTON'), `unexpected node types: ${JSON.stringify(tags)}`)
    const text = frag.children.map((c) => c.textContent).join('')
    assert(text === hostile, `text changed: ${text}`)
    const linkSrc = readFileSync(resolve(srcDir, 'ui/linkTerms.ts'), 'utf8').replace(/\/\/.*$/gm, '')
    assert(!/innerHTML|insertAdjacentHTML|outerHTML/.test(linkSrc), 'ui/linkTerms.ts writes HTML from a string')
    return `${tags.length} nodes, ${tags.filter((t) => t === 'BUTTON').length} buttons, text identical`
  })
})

// ===========================================================================
section('ak. Inline terms in the MOUNTED Study tab — real Jaws: HOW IT PLAYS, LEARN detail, the shot jump')
// ===========================================================================

/** A fake AppState over a REAL dataset file — fakeAppState's shape exactly. */
function realAppState(file, { trim = 'premium-le' } = {}) {
  const data = JSON.parse(readFileSync(resolve(__dirname, '../../data', file), 'utf8'))
  const listeners = new Set()
  return {
    machine: { id: file.replace(/_goals\.json$/, ''), name: data.machine, shortTitle: 'REAL', resource: file.replace(/\.json$/, '') },
    data,
    shotsByID: new Map(data.shots.map((s) => [s.id, s])),
    trim,
    setTrim(v) {
      if (this.trim === v) return
      this.trim = v
      this._notify()
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    _notify() {
      for (const fn of [...listeners]) fn()
    },
  }
}
const JAWS_TOUR = buildTour(JAWS.shots, 'premium-le')
const tourLabelFor = (shotId, tour = JAWS_TOUR) => `SHOT ${tour.findIndex((s) => s.id === shotId) + 1} OF ${tour.length}`
const hipLoopItems = (host) => host.find('study-hip-loop').children
const termLinks = (el, kind) => el.findAll(kind ? `term-link-${kind}` : 'term-link')

await testAsync('HOW IT PLAYS opens with SHOT links at once, gains GLOSSARY links when the glossary lands — same panel, scroll kept', async () => {
  return withMountedStudy(realAppState('jaws_goals.json'), async ({ host }) => {
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-howitplays-panel')
    assert(panel, 'HOW IT PLAYS did not open')
    const first = hipLoopItems(host)[0]
    assert(termLinks(first, 'shot').map((b) => b.textContent).join() === 'bash boat', `shot links before the glossary: ${termLinks(first, 'shot').map((b) => b.textContent)}`)
    assert(termLinks(first, 'glossary').length === 0, 'glossary links present before the glossary could have loaded — the relink path is untested')
    const body = host.find('study-learn-body')
    body.scrollTop = 37
    await settle()
    const firstAfter = hipLoopItems(host)[0]
    assert(termLinks(firstAfter, 'glossary').map((b) => b.textContent).join() === 'mode', `glossary links after load: ${termLinks(firstAfter, 'glossary').map((b) => b.textContent)}`)
    assert(host.find('study-howitplays-panel') === panel, 'the relink rebuilt the panel instead of its body')
    assert(host.find('study-learn-body').scrollTop === 37, `the relink threw the reader back to the top (scrollTop ${host.find('study-learn-body').scrollTop})`)
    const all = termLinks(host.find('study-learn-body'))
    return `${all.length} term links in the sheet after the glossary landed`
  })
})

await testAsync('tapping the SHOT "bash boat" lights it: the tour moves to the captive ball, the sheet STAYS OPEN, the tour stays PAUSED', async () => {
  return withMountedStudy(realAppState('jaws_goals.json'), async ({ host, pendingFrameScheduled }) => {
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    await settle()
    const link = termLinks(hipLoopItems(host)[0], 'shot')[0]
    link.dispatchEvent({ type: 'click' })
    const label = host.find('study-readout-label').textContent
    assert(label === tourLabelFor('captive-ball'), `expected ${tourLabelFor('captive-ball')}, got ${label}`)
    assert(host.find('study-howitplays-panel'), 'the sheet closed — the reader was mid-sentence in it')
    assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', 'the tap started the shuffle')
    assert(!pendingFrameScheduled(), 'a shuffle frame is scheduled after a shot tap')
    // PEEK (integration, 2026-10-14): the captive ball sits in the lower half
    // of the table, behind a 55dvh sheet — so the sheet must DUCK (class on the
    // SAME panel node, never a rebuild) and come back on the first tap into it.
    const panel = host.find('study-howitplays-panel')
    assert(panel.classList.contains('study-sheet-peek'), 'the sheet did not duck — the lit shot is behind it')
    panel.dispatchEvent({ type: 'pointerdown' })
    assert(!panel.classList.contains('study-sheet-peek'), 'a tap back into the sheet did not restore its height')
    assert(host.find('study-howitplays-panel') === panel, 'restoring rebuilt the panel')
    // A second shot tap ducks again (the one-shot restore listeners re-arm).
    termLinks(hipLoopItems(host)[0], 'shot')[0].dispatchEvent({ type: 'click' })
    assert(panel.classList.contains('study-sheet-peek'), 'the second shot tap did not duck the sheet')
    return label
  })
})

await testAsync('PEEK restores on KEYBOARD focus too: a focusin inside the ducked panel brings it back to full height (surviving mutant M12)', async () => {
  // The pointerdown restore is pinned above; this is the other listener. A
  // keyboard reader who Tabs on after a shot tap never touches the screen, so
  // without it the sheet would stay ducked at 17dvh with focus inside it.
  return withMountedStudy(realAppState('jaws_goals.json'), async ({ host }) => {
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    await settle()
    termLinks(hipLoopItems(host)[0], 'shot')[0].dispatchEvent({ type: 'click' })
    const panel = host.find('study-howitplays-panel')
    assert(panel.classList.contains('study-sheet-peek'), 'setup: the shot tap ducked the sheet')
    panel.dispatchEvent({ type: 'focusin' })
    assert(!panel.classList.contains('study-sheet-peek'), 'focus moving back into the ducked sheet did not restore its height')
    assert(host.find('study-howitplays-panel') === panel, 'restoring rebuilt the panel')
    // One-shot, like pointerdown: a second focusin is a no-op, and a fresh
    // shot tap ducks again.
    termLinks(hipLoopItems(host)[0], 'shot')[0].dispatchEvent({ type: 'click' })
    assert(panel.classList.contains('study-sheet-peek'), 'the second shot tap did not duck the sheet')
  })
})

// A MODEL CHANGE WITH HOW IT PLAYS OPEN (2026-10-14 review). Shot names in
// the prose link only when the CURRENT model has that shot (prose() links
// against the main tour at state.trim). refreshOpenSheetForTour used to
// rebuild LEARN and DRILLS only, so the open HOW IT PLAYS kept the old
// model's links: a Premium/LE shot stayed a button on a Pro.
const shotLinkTexts = (host) => termLinks(host.find('study-learn-body'), 'shot').map((b) => b.textContent)

await testAsync('MODEL switch with HOW IT PLAYS open (real Game of Thrones): the Premium/LE-only "Iron Throne" link goes on Pro and comes back — same panel, scroll kept', async () => {
  const got = JSON.parse(readFileSync(resolve(__dirname, '../../data/game_of_thrones_goals.json'), 'utf8'))
  const throne = got.shots.find((sh) => sh.name === 'Iron Throne')
  assert(throne && throne.trim === 'premium-le', 'setup: data/game_of_thrones_goals.json no longer has a Premium/LE-only "Iron Throne" — re-point this test')
  const state = realAppState('game_of_thrones_goals.json')
  return withMountedStudy(state, async ({ host }) => {
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    await settle()
    const panel = host.find('study-howitplays-panel')
    const before = shotLinkTexts(host)
    assert(before.includes('Iron Throne'), `setup: on Premium/LE "Iron Throne" should be a shot link; links: ${before}`)
    host.find('study-learn-body').scrollTop = 41
    state.setTrim('pro')
    const onPro = shotLinkTexts(host)
    assert(!onPro.includes('Iron Throne'), `on Pro the prose still offers "Iron Throne" — a tap that cannot land; links: ${onPro}`)
    assert(onPro.join('|') !== before.join('|'), 'the link set did not change with the model')
    assert(host.find('study-howitplays-panel') === panel, 'the MODEL switch rebuilt the panel rather than its body')
    assert(host.find('study-learn-body').scrollTop === 41, `the reader was thrown back to the top (scrollTop ${host.find('study-learn-body').scrollTop})`)
    state.setTrim('premium-le')
    assert(shotLinkTexts(host).includes('Iron Throne'), 'switching back to Premium/LE did not restore the link')
    return `${before.length} shot links on Premium/LE, ${onPro.length} on Pro`
  })
})

test('MODEL switch while a DECK level is walking: the walked tour holds still, yet the prose\'s Premium/LE link still goes', () => {
  const hip = { ...HOW_IT_PLAYS, loop: ['Shoot the Premium Only Shot to start.', ...HOW_IT_PLAYS.loop.slice(1)] }
  const state = fakeAppState({ howItPlays: hip })
  withMountedStudy(state, ({ host }) => {
    const onDeck = () => levelName(host).toUpperCase() === DECK_ZONE.name.toUpperCase()
    for (let i = 0; i < 4 && !onDeck(); i++) arrows(host)[1].dispatchEvent({ type: 'click' })
    assert(onDeck(), `setup: could not reach the deck level (on ${levelName(host)})`)
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    assert(shotLinkTexts(host).includes('Premium Only Shot'), `setup: the premium shot should link on Premium/LE; links: ${shotLinkTexts(host)}`)
    const tourBefore = host.find('study-readout-label').textContent
    state.setTrim('pro')
    assert(onDeck() && host.find('study-readout-label').textContent === tourBefore, 'setup: the deck tour should be untouched by the model switch')
    assert(!shotLinkTexts(host).includes('Premium Only Shot'), `the Pro prose still links a Premium/LE-only shot; links: ${shotLinkTexts(host)}`)
  })
})

await testAsync('QUIZ ME: the seventh pill is wired to the lazy quiz chunk and hands it the Shots door (source pin)', async () => {
  assert(/quizBtn\.addEventListener\('click', \(\) =>\s*loadChunk\(\(\) => import\('\.\/quiz'\), 'the quiz'/.test(studySrc), 'QUIZ ME no longer opens ui/quiz through loadChunk')
  assert(/m\.openQuiz\(state, \{\s*showGoalOnShots:/.test(studySrc), 'openQuiz is not handed the showGoalOnShots door')
  return withMountedStudy(fakeAppState(), ({ host }) => {
    const btn = host.find('study-quiz-btn')
    assert(btn, 'no .study-quiz-btn mounted')
    assert(btn.textContent === 'QUIZ ME', `label: ${btn.textContent}`)
    assert(/quiz me/i.test(btn.getAttribute('aria-label') ?? ''), 'aria-label must contain the visible label (WCAG 2.5.3)')
    return btn.getAttribute('aria-label')
  })
})

await testAsync('…and STAYS paused after the sheet closes, even if the visitor had the shuffle running before opening it', async () => {
  return withMountedStudy(realAppState('jaws_goals.json'), async ({ host, pendingFrameScheduled }) => {
    host.find('study-readout').dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-sub').textContent === 'SHUFFLE · TAP TO PAUSE', 'setup: shuffling')
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    await settle()
    termLinks(hipLoopItems(host)[0], 'shot')[0].dispatchEvent({ type: 'click' })
    host.find('study-learn-back').dispatchEvent({ type: 'click' })
    assert(host.find('study-readout-sub').textContent === 'PAUSED · TAP FOR AUTO', 'closing restored the old shuffle and will carry the asked-for shot away')
    assert(host.find('study-readout-label').textContent === tourLabelFor('captive-ball'), 'the tour left the shot that was asked for')
    assert(!pendingFrameScheduled(), 'a shuffle frame is scheduled')
  })
})

await testAsync('a shot OFF the current level (Orca deck showing, "left 3-bank" tapped) returns the tour to MAIN without closing the sheet', async () => {
  return withMountedStudy(realAppState('jaws_goals.json'), async ({ host }) => {
    const mainLabel = host.find('study-level-name').textContent
    host.findAll('study-level-arrow')[1].dispatchEvent({ type: 'click' })
    assert(host.find('study-level-name').textContent !== mainLabel, 'setup: expected › to leave the main level')
    assert(host.find('study-readout-label').textContent.endsWith(`OF ${JAWS.shots.filter((s) => s.playfield === 'orca-deck').length}`), `setup: expected the deck tour, got ${host.find('study-readout-label').textContent}`)
    host.find('study-howitplays-btn').dispatchEvent({ type: 'click' })
    await settle()
    const link = termLinks(hipLoopItems(host)[2], 'shot').find((b) => b.textContent === 'left 3-bank')
    assert(link, 'setup: no "left 3-bank" link in the third loop line')
    link.focus()
    link.dispatchEvent({ type: 'click' })
    assert(host.find('study-level-name').textContent === mainLabel, `the level did not return to main: ${host.find('study-level-name').textContent}`)
    assert(host.find('study-readout-label').textContent === tourLabelFor('fish-finder-bank'), `got ${host.find('study-readout-label').textContent}`)
    assert(host.find('study-howitplays-panel'), 'the level change closed the sheet')
    // Same MODEL, so the prose's links are unchanged: the body is NOT rebuilt
    // (2026-10-14 review fix — the MODEL relink must not fire here), and a
    // keyboard reader stays on the link they pressed.
    assert(descends(host.find('study-learn-body'), link), 'the HOW IT PLAYS body was rebuilt by a level change that moved no links')
    assert(domActiveElement === link, `focus left the pressed link for ${domActiveElement?.className}`)
    return host.find('study-readout-label').textContent
  })
})

await testAsync('LEARN detail: shot NOTES are linked, and tapping a shot link that holds FOCUS re-homes focus to the new current row (never <body>)', async () => {
  return withMountedStudy(realAppState('jaws_goals.json'), async ({ host }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    await settle()
    const centerIdx = JAWS_TOUR.findIndex((s) => s.id === 'center-ramp')
    host.findAll('study-index-row')[centerIdx].dispatchEvent({ type: 'click' })
    assert(host.find('study-learn-title').textContent === 'Center Ramp (North Beach)', `setup: ${host.find('study-learn-title').textContent}`)
    const notes = host.find('study-learn-detail').find('study-learn-notes')
    const link = termLinks(notes, 'shot').find((b) => b.textContent === 'left inlane')
    assert(link, `no "left inlane" shot link in the Center Ramp notes: ${termLinks(notes).map((b) => b.textContent)}`)
    link.focus()
    link.dispatchEvent({ type: 'click' })
    assert(host.find('study-learn-title').textContent === 'Left Inlane', `the detail did not follow: ${host.find('study-learn-title').textContent}`)
    const row = host.findAll('study-index-row')[JAWS_TOUR.findIndex((s) => s.id === 'left-inlane')]
    assert(domActiveElement === row, `focus was left on ${domActiveElement?.className ?? domActiveElement} instead of the new current row`)
    return 'Center Ramp notes -> Left Inlane, focus on its row'
  })
})

await testAsync('LEARN light detail: the LIT/THEN values are linked prose; the LIT label is not', async () => {
  return withMountedStudy(realAppState('jaws_goals.json'), async ({ host }) => {
    host.find('study-learn-btn').dispatchEvent({ type: 'click' })
    await settle()
    const lightRows = host.findAll('study-index-list')[1].findAll('study-index-row')
    lightRows[JAWS_HIP.lights.findIndex((l) => l.id === 'machete-arm-lanes')].dispatchEvent({ type: 'click' })
    const kv = host.find('study-learn-detail').findAll('study-light-kv')
    const lit = kv.find((p) => p.find('study-light-kv-label').textContent === 'LIT')
    assert(lit, 'no LIT row')
    assert(termLinks(lit.find('study-light-kv-label')).length === 0, 'the LIT label grew a link')
    const words = termLinks(lit.find('study-light-kv-value')).map((b) => b.textContent)
    assert(JSON.stringify(words) === JSON.stringify(['inlane', 'multiplier']), `LIT value links: ${JSON.stringify(words)}`)
    return words.join(', ')
  })
})

test('the glossary half of a tap is wired to openGlossary(term) through the lazy chunk (source pin — the overlay needs a real document.body)', () => {
  assert(/onGlossaryTerm: openGlossaryAt/.test(studySrc), 'prose() no longer hands linkTerms the glossary opener')
  assert(/function openGlossaryAt\(term: string\): void \{\s*loadChunk\(\(\) => import\('\.\/glossary'\), 'the glossary', \(m\) => m\.openGlossary\(term\)\)/.test(studySrc), 'openGlossaryAt no longer opens the glossary AT the term')
})

// ===========================================================================
section('al. openHowItPlays() — the landing door on the Study handle')
// ===========================================================================

withMountedStudy(fakeAppState({ howItPlays: HOW_IT_PLAYS, actionButton: ACTION_BUTTON }), ({ host, handle }) => {
  test('opens HOW IT PLAYS at the TOP, with focus on Back when nothing is above it', () => {
    handle.openHowItPlays()
    assert(host.find('study-howitplays-panel'), 'no HOW IT PLAYS panel')
    assert(host.find('study-learn-body').scrollTop === 0, 'not at the top')
    assert(domActiveElement === host.find('study-learn-back'), 'focus did not move into the sheet')
  })
  test('OPEN, NOT TOGGLE: a second call keeps it open and scrolls back to the top', () => {
    host.find('study-learn-body').scrollTop = 120
    handle.openHowItPlays()
    assert(host.find('study-howitplays-panel'), 'the second call closed it')
    assert(host.find('study-learn-body').scrollTop === 0, `expected the top, got ${host.find('study-learn-body').scrollTop}`)
  })
  test('from ANOTHER kind it swaps in place — same panel element, now HOW IT PLAYS', () => {
    host.find('study-action-btn').dispatchEvent({ type: 'click' })
    const panel = host.find('study-ab-panel')
    assert(panel, 'setup: ACTION open')
    handle.openHowItPlays()
    assert(host.find('study-howitplays-panel') === panel, 'expected the SAME panel element, swapped')
  })
})

withMountedStudy(fakeAppState(), ({ host, handle }) => {
  test('INERT on a machine with no howItPlays — no empty sheet', () => {
    handle.openHowItPlays()
    assert(!host.find('study-learn-panel'), 'opened a sheet with nothing to show')
  })
})

withMountedStudy(fakeAppState({ howItPlays: HOW_IT_PLAYS }), ({ host, handle, doc }) => {
  test('UNDER A HIGHER DIALOG (the first-run guide) it opens WITHOUT taking focus, and Escape is the dialog\'s, not the sheet\'s', () => {
    const guide = doc.createElement('div') // no getClientRects: overlayStack treats a fake element as rendered
    const inGuide = doc.createElement('button')
    pushOverlay(guide, OVERLAY_TIER_OVERLAY)
    try {
      inGuide.focus()
      handle.openHowItPlays()
      assert(host.find('study-howitplays-panel'), 'the sheet should still open underneath')
      assert(domActiveElement === inGuide, `focus was pulled out of the dialog above (now on ${domActiveElement?.className || domActiveElement?.tagName})`)
      doc._fireKey('Escape')
      assert(host.find('study-howitplays-panel'), 'an Escape meant for the dialog above closed the sheet beneath it')
    } finally {
      popOverlay(guide)
    }
    doc._fireKey('Escape')
    assert(!host.find('study-learn-panel'), 'with the dialog gone, Escape belongs to the sheet again')
  })
})

// THE REAL FIRST-RUN GUIDE over the landing sheet (2026-10-14 review). The
// test above stands a bare registered element in for the guide; these open
// ui/howto.ts itself. Before this, the guide was aria-modal with no Tab trap
// (Tab past its last control walked into the sheet behind it), and closing it
// dropped focus on whatever had it before the guide opened — on a first visit
// that is nothing, so a keyboard user landed outside the sheet now showing.

/** Opens the real guide inside a mounted Study harness: the fake document
 *  gets a body to mount into and the module a localStorage to mark "seen" in.
 *  Returns the guide's root plus its two buttons. */
function openGuide(doc) {
  if (!doc.body) doc.body = doc.createElement('body')
  if (!globalThis.localStorage) {
    const store = new Map()
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  }
  const handle = openHowTo()
  const root = doc.body.children.find((c) => c.className === 'pg-howto-overlay')
  assert(root, 'setup: the guide did not mount into document.body')
  return { handle, root, closeBtn: root.find('pg-howto-close'), gotIt: root.find('pg-howto-gotit') }
}

withMountedStudy(fakeAppState({ howItPlays: HOW_IT_PLAYS }), ({ host, handle, doc }) => {
  test('FIRST VISIT: guide up, HOW IT PLAYS lands underneath, "Got it" closes the guide and focus lands on the sheet\'s Back', () => {
    const guide = openGuide(doc)
    assert(domActiveElement === guide.closeBtn, 'setup: the guide focuses its close button')
    handle.openHowItPlays()
    assert(domActiveElement === guide.closeBtn, 'setup: the landing sheet must not take focus from the guide above it')
    guide.gotIt.dispatchEvent({ type: 'click' })
    assert(!doc.body.children.includes(guide.root), 'the guide did not close')
    assert(host.find('study-howitplays-panel'), 'closing the guide closed the sheet too')
    const back = host.find('study-learn-back')
    assert(domActiveElement === back, `focus landed on ${domActiveElement?.className || domActiveElement?.tagName || 'nothing'}, not the sheet's Back button`)
  })
})

withMountedStudy(fakeAppState({ howItPlays: HOW_IT_PLAYS }), ({ host, handle, doc }) => {
  test('Escape closes ONLY the guide (it claims the key) and focus goes into the sheet that is left', () => {
    const guide = openGuide(doc)
    handle.openHowItPlays()
    doc._fireKey('Escape')
    assert(!doc.body.children.includes(guide.root), 'Escape did not close the guide')
    assert(host.find('study-howitplays-panel'), 'one Escape closed the guide AND the sheet beneath it')
    assert(domActiveElement === host.find('study-learn-back'), 'focus did not move into the remaining sheet')
  })
})

withMountedStudy(fakeAppState({ howItPlays: HOW_IT_PLAYS }), ({ host, handle, doc }) => {
  test('TAB TRAP: Tab from the guide\'s last stop wraps to its first, Shift+Tab from the first wraps to the last', () => {
    const guide = openGuide(doc)
    handle.openHowItPlays()
    try {
      guide.gotIt.focus()
      assert(doc._fireKey('Tab') === true, 'Tab on the last stop was not intercepted')
      assert(domActiveElement === guide.closeBtn, `Tab from "Got it" went to ${domActiveElement?.className}, not the close button`)
      assert(doc._fireKey('Tab', { shiftKey: true }) === true, 'Shift+Tab on the first stop was not intercepted')
      assert(domActiveElement === guide.gotIt, `Shift+Tab from the close button went to ${domActiveElement?.className}, not "Got it"`)
      // An interior Tab is the browser's: nothing intercepted, nothing moved.
      guide.closeBtn.focus()
      assert(doc._fireKey('Tab') === false, 'an interior Tab was intercepted — the browser\'s own tab order should stand')
    } finally {
      guide.handle.destroy()
    }
  })
  test('TAB TRAP: focus parked BEHIND the guide (on the sheet underneath) is pulled into the guide, not kept by the sheet\'s trap', () => {
    handle.openHowItPlays()
    const guide = openGuide(doc)
    try {
      host.find('study-learn-back').focus()
      assert(doc._fireKey('Tab') === true, 'Tab with focus behind the guide was not intercepted')
      assert(domActiveElement === guide.closeBtn, `focus went to ${domActiveElement?.className}, not the guide's first stop`)
      host.find('study-learn-back').focus()
      doc._fireKey('Tab', { shiftKey: true })
      assert(domActiveElement === guide.gotIt, 'Shift+Tab from behind the guide did not land on its last stop')
    } finally {
      guide.handle.destroy()
    }
  })
})

withMountedStudy(fakeAppState({ howItPlays: HOW_IT_PLAYS }), ({ host, doc }) => {
  test('with NO dialog left underneath, closing the guide returns focus to what opened it', () => {
    const opener = doc.createElement('button')
    host.appendChild(opener)
    opener.focus()
    const guide = openGuide(doc)
    assert(domActiveElement === guide.closeBtn, 'setup: the guide took focus')
    guide.closeBtn.dispatchEvent({ type: 'click' })
    assert(domActiveElement === opener, `focus went to ${domActiveElement?.className || domActiveElement?.tagName}, not the opener`)
  })
})

withMountedStudy(fakeAppState({ howItPlays: HOW_IT_PLAYS }), ({ host, handle, doc }) => {
  test('opened FROM INSIDE an open sheet, closing returns focus to that exact control, not the sheet\'s first stop', () => {
    handle.openHowItPlays()
    const inSheet = doc.createElement('button')
    host.find('study-learn-body').appendChild(inSheet)
    inSheet.focus()
    const guide = openGuide(doc)
    guide.gotIt.dispatchEvent({ type: 'click' })
    assert(domActiveElement === inSheet, `focus went to ${domActiveElement?.className || domActiveElement?.tagName}, not the control the guide was opened from`)
  })
})

test('…and the first-run guide registers in the overlay tier and pops on close (source pin)', () => {
  // The behaviour is the tests above; this pins the registration itself.
  const howtoSrc = readFileSync(howtoPath, 'utf8')
  assert(/pushOverlay\(overlay, OVERLAY_TIER_OVERLAY\)/.test(howtoSrc), 'the guide does not register in the overlay tier')
  assert(/popOverlay\(overlay\)/.test(howtoSrc), 'the guide does not unregister on close')
})

{
  const state = fakeAppState({ howItPlays: HOW_IT_PLAYS })
  withMountedStudy(state, ({ host, handle }) => {
    test('after a MACHINE SWITCH (which closes every sheet) it opens on the NEW machine\'s objective', () => {
      handle.openHowItPlays()
      state.machine = { ...makeMachine(), id: 'second-machine' }
      state.data = makeData()
      state.data.howItPlays = { ...HOW_IT_PLAYS, objective: 'A different machine entirely.' }
      state.shotsByID = new Map(state.data.shots.map((s) => [s.id, s]))
      state._notify()
      assert(!host.find('study-learn-panel'), 'setup: the switch closes the sheet (study.ts syncFromState)')
      handle.openHowItPlays()
      const objective = host.find('study-howitplays-panel').find('study-learn-notes').textContent
      assert(objective === 'A different machine entirely.', `got ${JSON.stringify(objective)}`)
    })
  })
}

// ===========================================================================
// Summary
// ===========================================================================
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
