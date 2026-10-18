#!/usr/bin/env node
// app/tests/tokens.test.mjs — SUITE 20: the design-token gate.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/tokens.test.mjs"
//
// WHY THIS SUITE EXISTS. app/src/styles.css's :root block is the single
// source for every colour this app ships. Two things stop that from being
// true on its own, and both fail SILENTLY — the app builds, the types check,
// nothing throws, and the only symptom is that a reskin misses a spot:
//
//   1. CANVAS CANNOT READ A CUSTOM PROPERTY. CanvasRenderingContext2D
//      .fillStyle takes a colour string, and the render loop is not calling
//      getComputedStyle() every frame to resolve one. So the colours the 2D
//      playfield renderers need are MIRRORED as TypeScript constants:
//      src/theme.ts (card gradient, letterbox) and overlay/drawing.ts's
//      CATEGORY_COLOR (the nine goal categories). A mirror that drifts is two
//      different colours for one thing — e.g. a 'wizard' goal whose chip is
//      one yellow in the DOM and a different yellow on the playfield.
//      TypeScript enforces that a category KEY exists (CATEGORY_COLOR is a
//      Record<GoalCategory, string>); nothing but this file enforces that the
//      VALUE matches.
//
//   2. A STYLESHEET CAN JUST RE-TYPE THE HEX. Until 2026-08-14 six of this
//      app's stylesheets had zero var() references and carried their own
//      copies of the same charcoal/amber/glass values — 137 literals that a
//      palette change would have had to find by grep. Section 4 below locks
//      that in for the files P2 migrated, so a new rule in them cannot
//      reintroduce a copy.
//
// WHAT IS DELIBERATELY *NOT* CHECKED: near-misses are not rounded onto
// tokens. rgba(242,240,234,.42) is not --text-soft (.72) and must stay
// literal — folding it would be a visual change smuggled in under a refactor.
// The gate only ever objects to an EXACT duplicate of a token's value.
//
// The --cat-* half of section 1 lived in pathless-goals.test.mjs (its "every
// category has BOTH a --cat-* CSS var and a matching canvas hex" test) until
// 2026-08-14. It moved here, and got stronger on the way (see section 1), so
// that every palette gate has one home.
//
// Harness pattern follows pathless-goals.test.mjs: no test framework in this
// project (see scripts/run-tests.mjs) — a suite prints its own PASS/FAIL and
// exits non-zero when something failed.

import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')

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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(resolve(srcDir, rel), 'utf8')
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every colour literal, in either notation.
 *  The `i` flag is load-bearing on the rgba? branch, not decoration: without
 *  it a rule written `RGBA( 20,22,28,.96 )` — legal CSS, and exactly what a
 *  paste from a design tool looks like — walked straight past this gate. Found
 *  by a seeded mutation, not by reading. (The hex branches spell out a-fA-F
 *  and never depended on the flag.) */
const COLOR_RE = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^)]*\)/gi

/** Parse ANY CSS colour literal this repo can contain into the four 8-bit
 *  channels a rasteriser actually paints, plus how it was written.
 *
 *  The notations matter because the gate's job is to catch a token value
 *  PASTED BACK IN, and a design tool will hand you the same colour in whatever
 *  shape it likes. All of these are --glass-bg (rgba(16,18,23,.72)):
 *      rgba(16, 18, 23, 0.72)     legacy comma
 *      rgba(16 18 23 / 0.72)      modern space + slash
 *      rgb(16 18 23 / 72%)        modern, percent alpha, rgb() spelling
 *      #101217b8                  8-digit hex  (0.72 * 255 = 183.6 -> 0xb8)
 *  Comparing on bytes collapses all four to (16,18,23,184) without a table of
 *  string spellings to keep up to date.
 *
 *  OUT OF SCOPE, deliberately: hsl()/hwb()/lab()/color-mix() re-expressions of
 *  a token — there is no hsl() anywhere in this repo, and converting a token
 *  to another colour space is evasion, not a paste accident; this gate targets
 *  accidents.
 *
 *  Returns null for anything unparseable (a var(), a gradient keyword, a
 *  malformed literal) so callers can skip it rather than guess.
 *
 *  @returns {{r:number,g:number,b:number,a:number,hasAlpha:boolean,isFunctional:boolean}|null}
 */
function parseColor(raw) {
  const c = String(raw).trim()
  if (c.startsWith('#')) {
    let h = c.slice(1).toLowerCase()
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('')
    if (h.length !== 6 && h.length !== 8) return null
    if (!/^[0-9a-f]+$/.test(h)) return null
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
      hasAlpha: h.length === 8,
      isFunctional: false,
    }
  }
  const lp = c.indexOf('(')
  const rp = c.lastIndexOf(')')
  if (lp < 0 || rp < lp) return null
  // `/` separates alpha in modern syntax; legacy puts it 4th in the list.
  const [head, tail] = [c.slice(lp + 1, rp).split('/')[0], c.slice(lp + 1, rp).split('/')[1]]
  const chans = head.trim().split(/[\s,]+/).filter(Boolean)
  let alphaTok = tail === undefined ? null : tail.trim()
  if (alphaTok === null && chans.length === 4) alphaTok = chans.pop()
  if (chans.length !== 3) return null
  const chan = (t) => (t.endsWith('%') ? Math.round((parseFloat(t) * 255) / 100) : Math.round(parseFloat(t)))
  const [r, g, b] = chans.map(chan)
  if (![r, g, b].every(Number.isFinite)) return null
  let a = 255
  const hasAlpha = alphaTok !== null && alphaTok !== ''
  if (hasAlpha) {
    a = alphaTok.endsWith('%') ? Math.round((parseFloat(alphaTok) * 255) / 100) : Math.round(parseFloat(alphaTok) * 255)
    if (!Number.isFinite(a)) return null
  }
  const clamp = (n) => Math.max(0, Math.min(255, n))
  return { r: clamp(r), g: clamp(g), b: clamp(b), a: clamp(a), hasAlpha, isFunctional: true }
}

/** One canonical spelling per colour, so `#F5A623`, `#f5a623`,
 *  `rgba(245, 166, 35, 1)` and `rgb(245 166 35)` all compare equal.
 *  Thin wrapper over parseColor so there is ONE colour parser in this file. */
function normalizeColor(raw) {
  const c = parseColor(raw)
  return c ? `rgba(${c.r},${c.g},${c.b},${c.a})` : String(raw).trim().toLowerCase()
}

/** The :root custom-property table from styles.css — the source of truth. */
function readRootTokens() {
  const css = stripCssComments(read('styles.css'))
  const open = css.indexOf('{', css.indexOf(':root'))
  check(open > 0, 'styles.css has no :root block')
  let depth = 0
  let close = open
  for (; close < css.length; close++) {
    if (css[close] === '{') depth++
    else if (css[close] === '}' && --depth === 0) break
  }
  const body = css.slice(open + 1, close)
  const tokens = new Map()
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim())
  check(tokens.size > 20, `only ${tokens.size} tokens parsed from :root — the parser is wrong`)
  return tokens
}

const rootTokens = readRootTokens()
const stylesSrc = read('styles.css')
const drawingSrc = read('overlay/drawing.ts')
const themeSrc = read('theme.ts')

// ---------------------------------------------------------------------------
section('1. Goal-category palette: styles.css --cat-* === drawing.ts CATEGORY_COLOR')
// ---------------------------------------------------------------------------
// Stronger than the check this replaced: that one walked the categories the
// shipped DATA happens to use, so a category defined in both files but used by
// no machine yet was never compared. This walks BOTH tables and requires them
// to be the same set, which also catches a --cat-* with no canvas mirror and a
// CATEGORY_COLOR entry with no CSS var. (Data -> GoalCategory union coverage
// stays in pathless-goals.test.mjs; the union -> CATEGORY_COLOR link is tsc's,
// via Record<GoalCategory, string>.)

const cssCats = new Map(
  [...stripCssComments(stylesSrc).matchAll(/--cat-([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((m) => [m[1], m[2]]),
)
const canvasTable = drawingSrc.match(/CATEGORY_COLOR:\s*Record<GoalCategory,\s*string>\s*=\s*\{([\s\S]*?)\n\}/)
const canvasCats = new Map(
  canvasTable ? [...canvasTable[1].matchAll(/^\s*(\w+):\s*'(#[0-9a-fA-F]{3,8})'/gm)].map((m) => [m[1], m[2]]) : [],
)

test('both category tables parse and are non-empty', () => {
  check(canvasTable, 'could not find CATEGORY_COLOR in overlay/drawing.ts — the parser below is meaningless')
  check(cssCats.size > 0, 'no --cat-* custom properties found in styles.css')
  check(canvasCats.size > 0, 'no entries parsed out of CATEGORY_COLOR')
  return `${cssCats.size} --cat-* vars, ${canvasCats.size} CATEGORY_COLOR entries`
})

test('the two tables cover exactly the same categories', () => {
  const onlyCss = [...cssCats.keys()].filter((k) => !canvasCats.has(k))
  const onlyCanvas = [...canvasCats.keys()].filter((k) => !cssCats.has(k))
  check(onlyCss.length === 0, `styles.css has --cat-${onlyCss.join(', --cat-')} with no CATEGORY_COLOR mirror in drawing.ts`)
  check(onlyCanvas.length === 0, `drawing.ts CATEGORY_COLOR has ${onlyCanvas.join(', ')} with no --cat-* in styles.css`)
  return [...cssCats.keys()].sort().join(', ')
})

test('every category is the SAME colour in both renderers', () => {
  for (const [cat, cssHex] of cssCats) {
    const canvasHex = canvasCats.get(cat)
    check(
      normalizeColor(cssHex) === normalizeColor(canvasHex),
      `--cat-${cat} is ${cssHex} in styles.css but ${canvasHex} in overlay/drawing.ts — the same category ` +
        `would render two different colours in the DOM and on the canvas`,
    )
  }
  return `${cssCats.size} categories match hex-for-hex`
})

// ---------------------------------------------------------------------------
section('2. Canvas surface palette: styles.css === src/theme.ts')
// ---------------------------------------------------------------------------
const CANVAS_MIRROR = [
  ['--canvas-letterbox', 'CANVAS_LETTERBOX'],
  ['--card-gradient-a', 'CARD_GRADIENT_A'],
  ['--card-gradient-b', 'CARD_GRADIENT_B'],
]

const themeConsts = new Map(
  [...themeSrc.matchAll(/export const (\w+)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
)

test('theme.ts exports every constant the mirror needs', () => {
  for (const [, constName] of CANVAS_MIRROR) {
    check(themeConsts.has(constName), `src/theme.ts does not export ${constName}`)
  }
  // Not a mirror of any CSS token (nothing in the DOM paints it), but it is
  // the reason theme.ts is the one home for canvas colour — assert it exists
  // so a call site can never quietly go back to inlining the halo string.
  check(themeConsts.has('CANVAS_LABEL_HALO'), 'src/theme.ts does not export CANVAS_LABEL_HALO')
  return [...themeConsts.keys()].join(', ')
})

test('each canvas constant equals its styles.css token', () => {
  for (const [tokenName, constName] of CANVAS_MIRROR) {
    const cssValue = rootTokens.get(tokenName)
    check(cssValue, `styles.css :root has no ${tokenName} — theme.ts's ${constName} has nothing to mirror`)
    const tsValue = themeConsts.get(constName)
    check(
      normalizeColor(cssValue) === normalizeColor(tsValue),
      `${tokenName} is ${cssValue} in styles.css but ${constName} is ${tsValue} in theme.ts — ` +
        `the playfield card/letterbox would not match the palette it is supposed to come from`,
    )
  }
  return CANVAS_MIRROR.map(([t, c]) => `${t} = ${rootTokens.get(t)} = ${c}`).join('; ')
})

// ---------------------------------------------------------------------------
section('3. Exclusivity: the canvas hexes exist in exactly two files')
// ---------------------------------------------------------------------------
// The mirror is only single-source if the CALL SITES import it. overlay/map2d.ts
// and ui/study.ts each used to paint these hexes inline (four gradient stops and
// two letterbox fills between them); this is what stops them coming back.
//
// Comments are excluded on both sides, deliberately and in the SAFE direction:
// in .ts a hex only counts when it is inside quotes (so map2d.ts's Kotlin
// citation `Color(0xFF050D1F)` in a comment is not a re-literal, but a quoted
// hex ANYWHERE — even in a comment — still trips the gate); in .css the /* */
// comment bodies are stripped.

/** Every source file under app/src, recursively. */
function walkSrc(dir = srcDir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSrc(full, out)
    else if (/\.(ts|css)$/.test(entry.name)) out.push(full)
  }
  return out
}
const srcFiles = walkSrc().sort()

function filesContaining(hex) {
  const found = []
  for (const full of srcFiles) {
    const rel = relative(srcDir, full)
    const body = readFileSync(full, 'utf8')
    const hits = full.endsWith('.css')
      ? stripCssComments(body).toLowerCase().includes(hex)
      : new RegExp(`['"\`]${hex}['"\`]`, 'i').test(body)
    if (hits) found.push(rel)
  }
  return found
}

// BACKGLASS (P5, 2026-08-14): all three values moved — #050d1f -> #0a0b10
// (the letterbox is now literally --bg), #081a38 -> #071834 and
// #0d294d -> #0e2b52 (the card gradient, one step deeper in the same navy).
//
// #0a0b10 appears TWICE in styles.css on purpose (--bg and --canvas-letterbox
// are deliberately the same colour — that is the "one ground" claim). This
// gate compares FILE MEMBERSHIP, not occurrence counts, so that is fine.
//
// The old #0d294d survives in fx/celebrate.ts, which mirrors FXTheme.kt's
// vocabulary table (four machine themes use that navy in their confetti
// palette). It is no longer a design token at all, so it needs no entry here
// — but the test directly below still pins it as palette-only, because "the
// hex the playfield card USED to be still appears in the tree" is exactly the
// kind of straggler a reskin should have to account for.
const ALLOWED = {
  '#0a0b10': ['styles.css', 'theme.ts'],
  '#071834': ['styles.css', 'theme.ts'],
  '#0e2b52': ['styles.css', 'theme.ts'],
}

for (const [hex, allowed] of Object.entries(ALLOWED)) {
  test(`${hex} appears only in ${allowed.join(' + ')}`, () => {
    const found = filesContaining(hex).map((p) => p.split('\\').join('/'))
    const extra = found.filter((f) => !allowed.includes(f))
    const missing = allowed.filter((f) => !found.includes(f))
    check(
      extra.length === 0,
      `${hex} is re-literalled in ${extra.join(', ')} — import it from src/theme.ts instead ` +
        `(styles.css defines it, theme.ts mirrors it for canvas; a third copy is what this gate exists to stop)`,
    )
    check(missing.length === 0, `${hex} is missing from ${missing.join(', ')} — the mirror is incomplete`)
    return found.join(', ')
  })
}

test('fx/celebrate.ts uses #0d294d only as a confetti palette entry', () => {
  // #0d294d was --card-gradient-b until BACKGLASS (P5) moved it to #0e2b52.
  // It is no longer a token, so this is no longer an "exception" to the
  // exclusivity gate above — it is the straggler check: the one place the old
  // playfield navy is still allowed to exist is a confetti palette, where it
  // is a machine-theme particle colour and nothing to do with the card.
  // celebrate.ts may name it inside a `palette: [...]` array and nowhere
  // else; a fillStyle/background use there would be a leftover copy of the
  // OLD card gradient, and this catches it.
  //
  // WHAT THIS ASSERTS, PRECISELY: that every occurrence of the hex in the file
  // falls inside the text of a `palette: [...]` array — a structural check
  // against the CURRENT shape of THEMES (a flat object literal of
  // `{ glyphs, palette, motion }` records, mirroring FXTheme.kt).
  //
  // IF celebrate.ts IS EVER REFACTORED so the palettes stop being written as
  // inline `palette: [...]` literals — pulled into a shared PALETTES table,
  // built from a data file, generated, or split across modules — this test
  // FAILS rather than rotting: `total` still counts the hexes (4) while
  // `inPalettes` drops to 0. That is the safe direction, but the failure will
  // be a false alarm about a refactor rather than a real re-literal, so at
  // that point REPLACE this shape-match with the pair it stands in for: an
  // exact COUNT of the hex in the file (4 today, one per machine theme using
  // this navy) plus an EXCLUSIVITY assertion that the only symbol painting it
  // is a palette entry. A count is refactor-proof in a way a shape-matching
  // regex is not. (The hex disappearing from the file entirely is already
  // handled: section 3's `missing` check requires celebrate.ts to contain it,
  // and fails telling you to drop the allowlist entry.)
  const src = read('fx/celebrate.ts')
  const total = (src.match(/#0d294d/gi) || []).length
  const inPalettes = (src.match(/palette:\s*\[[^\]]*\]/g) || []).join(' ').match(/#0d294d/gi) || []
  check(
    total === inPalettes.length,
    `fx/celebrate.ts has ${total} occurrence(s) of #0d294d but only ${inPalettes.length} inside a palette: [...] ` +
      `array — the rest are a re-literal of the playfield card gradient and must import CARD_GRADIENT_B`,
  )
  return `${total} occurrence(s), all in palette arrays`
})

// ---------------------------------------------------------------------------
section('4. DENYLIST: no stylesheet anywhere re-literals a token value')
// ---------------------------------------------------------------------------
// This scans EVERY .css file under app/src against EVERY colour token in
// :root — not a hand-maintained list of the files P2 happened to migrate. An
// allowlist is the wrong shape for this gate: a new stylesheet added next
// month would simply not be on it, and would be free to paste the same
// charcoal in again. The default is "must be clean"; being dirty requires an
// explicit, COUNTED entry below.
//
// LEGACY_PINS is that entry — the files P2 did not migrate, each pinned to its
// exact current number of duplicated literals. The pin is a ratchet:
//
//   * a file NOT pinned may have ZERO hits (so the 75 legacy literals cannot
//     metastasize into a new file, and a migrated file cannot regress),
//   * a pinned file going OVER its pin fails (the debt cannot grow),
//   * a pinned file going UNDER its pin ALSO fails, with the new number in
//     the message. That last one is deliberate: a pin nobody lowers is a lie
//     that quietly re-authorises literals someone already removed. Failing on
//     improvement costs one line to fix and is the only version of this
//     ratchet that cannot loosen on its own. Migrate a file to 0 and delete
//     its entry.
//
// "Token value" means every custom property in :root whose value is a colour
// — the 17 added by P2, the palette that predates it, and the nine --cat-*.
// Comparison is on the normalised value, so #F5A623 / #f5a623 / rgb(245,166,35)
// and rgba(16, 18, 23, .72) / rgba(16,18,23,0.72) all count as duplicates.
//
// BACKGLASS (P5, 2026-08-14) LOWERED EVERY PIN, and deleted two entries. The
// reskin remapped the old palette's channel values to the new ones across
// every stylesheet (the same amber becomes the same NEW amber, alphas kept
// verbatim), so these files are no longer painting warm charcoal on a
// blue-black app — but the remap left them still writing literals rather than
// var(), which is what these counts are. Two files came out at zero and their
// entries are gone. ar/* remain the largest debt and remain unmigrated on
// purpose: ar/arview.css and ar/calibrate.css are UNIMPORTED (the AR tab was
// removed 2026-07-29; see app.ts's UNIMPORT note), so not one of their rules
// reaches a shipped bundle.
const LEGACY_PINS = {
  'ar/arview.css': 37,
  'ar/calibrate.css': 6,
  'ui/achievements.css': 2,
  'ui/account.css': 3,
}

/** The tokens, as bytes, for matching literals against.
 *
 *  A token counts as a COLOUR only when its ENTIRE value is one colour
 *  literal. That guard arrived with BACKGLASS (P5, 2026-08-14), which added
 *  composite tokens — `--glow-amber-hard` (a three-stop box-shadow),
 *  `--glow-text` (a text-shadow), `--scanlines`/`--dotmatrix` (gradients) —
 *  each of which CONTAINS rgba() literals. parseColor is deliberately lenient
 *  about surrounding text (it hunts the first `(...)`), so without this
 *  `--glow-text: 0 0 10px rgba(255,176,46,.45)` registered as "the colour
 *  rgba(255,176,46,.45)", and the denylist then told a stylesheet that its
 *  own one-off amber shadow was "a copy of var(--glow-text)" — which is not
 *  something you can fix by writing var(--glow-text), because that token is a
 *  whole shadow, not a colour. Anchoring the match makes the gate mean what
 *  it says: it objects to a re-typed COLOUR token, and composite tokens are
 *  not colour tokens.
 *
 *  THAT EXCLUSION IS NOT A LICENCE (K3 fast-follow #5). Skipping composite
 *  tokens HERE is right, and it also left them as the one place in :root
 *  where a colour could enter the palette unreviewed — a future
 *  `--glow-warm: rgba(255,180,120,.5)` would introduce a hue nothing checks.
 *  Section 5 below closes that: the channels INSIDE a composite token are
 *  parsed and required to come from the palette, so a composite can compose
 *  the palette but can never smuggle a new colour into it. */
const SINGLE_COLOR_VALUE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))$/i
const colorTokens = []
const compositeTokens = []
for (const [name, value] of rootTokens) {
  const v = value.trim()
  if (SINGLE_COLOR_VALUE.test(v)) {
    const p = parseColor(v)
    if (p) colorTokens.push({ name, ...p })
  } else if (COLOR_RE.test(v)) {
    // Reset: COLOR_RE is a /g regex and `.test` advances lastIndex.
    COLOR_RE.lastIndex = 0
    compositeTokens.push({ name, value: v })
  }
  COLOR_RE.lastIndex = 0
}

/**
 * Is this literal a re-typed token? Two rules, and the line between them was
 * drawn by MEASUREMENT, not taste — see the counts in the comment below.
 *
 *  1. SAME COLOUR, ANY NOTATION. All four channels equal. This is what catches
 *     `#101217b8` and `rgb(16 18 23 / 72%)` as copies of --glass-bg.
 *
 *  2. A TOKEN'S RGB WITH THE ALPHA DROPPED, functional notation only —
 *     `rgb(16 18 23)` where a token is rgba(16,18,23,X). Copying a swatch out
 *     of a design tool often yields the solid channels without the layer
 *     opacity, so this is a real paste accident, and those channel values are
 *     otherwise arbitrary enough that a collision is not plausible.
 *     BARE HEX IS EXEMPT from rule 2 on purpose: `#fff` is the canonical way
 *     to write opaque white and appears legitimately (a bright dot, a
 *     gradient stop). Three of this repo's `#fff` uses would be flagged as
 *     "copies of --line" (rgba(255,255,255,.08)) if hex were included, and
 *     every one of them is a genuinely different colour.
 *
 * WHAT IS DELIBERATELY *NOT* RULE 3: "same RGB, any alpha". Measured against
 * this repo it produces 59 hits in files that are supposed to be clean — and
 * all 59 are the one-off alphas P2 deliberately left literal
 * (rgba(245,166,35,.05), rgba(242,240,234,.7), rgba(0,0,0,.55) ...). Adopting
 * it would not tighten the gate; it would force exactly the eyeball-rounding
 * of near-misses onto tokens that this whole phase refused to do, and would
 * change the rendered output. Same-RGB-different-alpha is a DIFFERENT COLOUR.
 */
function tokenFor(lit) {
  const exact = colorTokens.find((t) => t.r === lit.r && t.g === lit.g && t.b === lit.b && t.a === lit.a)
  if (exact) return { token: exact, why: 'the same colour' }
  if (!lit.hasAlpha && lit.isFunctional) {
    const rgb = colorTokens.find((t) => t.r === lit.r && t.g === lit.g && t.b === lit.b)
    if (rgb) return { token: rgb, why: "that token's RGB with the alpha dropped" }
  }
  return null
}

/** Strip the :root block — it is where the tokens are DEFINED. */
function withoutRoot(css) {
  const at = css.indexOf(':root')
  if (at < 0) return css
  const open = css.indexOf('{', at)
  let depth = 0
  let close = open
  for (; close < css.length; close++) {
    if (css[close] === '{') depth++
    else if (css[close] === '}' && --depth === 0) break
  }
  return css.slice(0, at) + css.slice(close + 1)
}

function duplicatedLiterals(rel) {
  const css = withoutRoot(stripCssComments(read(rel)))
  const hits = []
  for (const m of css.matchAll(COLOR_RE)) {
    const lit = parseColor(m[0])
    if (!lit) continue
    const hit = tokenFor(lit)
    if (hit) hits.push(`${m[0]} is ${hit.why} as var(${hit.token.name})`)
  }
  return hits
}

const allCss = srcFiles
  .filter((f) => f.endsWith('.css'))
  .map((f) => relative(srcDir, f).split('\\').join('/'))
  .sort()

test('the value-matcher itself: notations, 8-digit hex tokenising, and the two rules', () => {
  // A gate is only as good as its parser, and this one is regex-fronted, so
  // pin the parser's behaviour directly instead of inferring it from the tree
  // scan passing. Every case below is a claim the denylist depends on.

  // (a) An 8-digit hex is ONE match of the 8-digit branch — the 6-hex branch
  //     must not bite off `#101217` and leave `b8`, which would both miscount
  //     occurrences and mis-identify the colour.
  const eight = '#101217b8'
  const m = [...eight.matchAll(COLOR_RE)]
  check(m.length === 1, `COLOR_RE found ${m.length} matches in ${eight} — expected exactly 1`)
  check(m[0][0] === eight, `COLOR_RE matched '${m[0][0]}' instead of the whole '${eight}'`)
  const inline = [...'a:#101217b8;b:#ffb02e;'.matchAll(COLOR_RE)].map((x) => x[0])
  check(
    inline.length === 2 && inline[0] === '#101217b8' && inline[1] === '#ffb02e',
    `mixed 8-digit and 6-digit hex tokenised as ${JSON.stringify(inline)}`,
  )

  // (b) All the spellings of --glass-bg collapse to the same four bytes.
  //     BACKGLASS (P5): --glass-bg moved from rgba(16,18,23,.72) to the deep
  //     navy rgba(7,12,24,.72); 0x070c18 is its 6-digit hex, 0xb8 the .72
  //     alpha byte (unchanged).
  const glass = parseColor('rgba(7, 12, 24, 0.72)')
  check(glass && glass.a === 184, `rgba(7,12,24,.72) -> alpha byte ${glass && glass.a}, expected 184`)
  for (const spelling of ['#070c18b8', '#070C18B8', 'rgb(7 12 24 / 0.72)', 'rgb(7 12 24 / 72%)', 'RGBA( 7,12,24,.72 )']) {
    const p = parseColor(spelling)
    check(p, `parseColor returned null for ${spelling}`)
    check(
      p.r === glass.r && p.g === glass.g && p.b === glass.b && p.a === glass.a,
      `${spelling} parsed as (${p.r},${p.g},${p.b},${p.a}) but --glass-bg is (${glass.r},${glass.g},${glass.b},${glass.a})`,
    )
    check(tokenFor(p), `${spelling} is --glass-bg re-typed but the matcher did not flag it`)
  }

  // (c) Rule 2 fires for an alpha-less FUNCTIONAL rgb() carrying a token's RGB…
  const dropped = parseColor('rgb(7 12 24)')
  check(tokenFor(dropped), 'rgb(7 12 24) is --glass-bg with the alpha dropped but was not flagged')
  check(parseColor('rgb(7,12,24)') && tokenFor(parseColor('rgb(7,12,24)')), 'comma spelling of the same was not flagged')

  // (d) …and NOT for bare hex, so `#fff` stays a legitimate opaque white.
  check(!tokenFor(parseColor('#fff')), '#fff was flagged as a copy of a white alpha token — rule 2 must exempt bare hex')
  check(!tokenFor(parseColor('#ffffff')), '#ffffff was flagged — rule 2 must exempt bare hex')

  // (e) A near-miss alpha is a DIFFERENT COLOUR and must never be flagged.
  for (const near of ['rgba(255, 176, 46, 0.05)', 'rgba(233, 237, 247, 0.7)', 'rgba(0, 0, 0, 0.55)', '#ffb02e33']) {
    check(!tokenFor(parseColor(near)), `${near} is a deliberate near-miss, not a token copy, but was flagged`)
  }

  // (f) Junk parses to null rather than to some accidental colour.
  for (const junk of ['#12345', 'rgb(1 2)', 'var(--amber)', '#zzzzzz']) {
    check(parseColor(junk) === null, `parseColor('${junk}') should be null, got ${JSON.stringify(parseColor(junk))}`)
  }
  return 'hex 3/4/6/8, comma + space/slash rgb(), % alpha, case-insensitive; near-misses and #fff spared'
})

test('the denylist actually scans the whole tree (not a stale hand-written list)', () => {
  check(allCss.length >= 12, `only ${allCss.length} stylesheets discovered under app/src — the walker is broken`)
  check(colorTokens.length >= 25, `only ${colorTokens.length} colour tokens parsed from :root — the parser is broken`)
  const pinnedMissing = Object.keys(LEGACY_PINS).filter((f) => !allCss.includes(f))
  check(pinnedMissing.length === 0, `LEGACY_PINS names ${pinnedMissing.join(', ')}, which no longer exist — delete the entry`)
  return `${allCss.length} stylesheets, ${colorTokens.length} colour tokens`
})

test('no UNPINNED stylesheet contains a literal equal to a token', () => {
  const offenders = []
  for (const rel of allCss) {
    if (rel in LEGACY_PINS) continue
    const hits = duplicatedLiterals(rel)
    if (hits.length) offenders.push(`${rel}: ${hits.length} (${[...new Set(hits)].slice(0, 4).join(', ')})`)
  }
  check(
    offenders.length === 0,
    `these stylesheets duplicate a token value instead of using var():\n            ${offenders.join('\n            ')}\n` +
      `          — use the var(). If this is a NEW legacy file rather than a regression, that is not a reason ` +
      `to add a pin: pins exist for pre-P2 debt only.`,
  )
  const clean = allCss.filter((f) => !(f in LEGACY_PINS))
  return `${clean.length} stylesheet(s) clean: ${clean.join(', ')}`
})

for (const [rel, pin] of Object.entries(LEGACY_PINS)) {
  test(`${rel} stays at or below its legacy pin of ${pin}`, () => {
    const hits = duplicatedLiterals(rel)
    check(
      hits.length <= pin,
      `${rel} now has ${hits.length} literal(s) duplicating a token, over its pin of ${pin} — ` +
        `pre-P2 debt may not GROW. New rules in this file must use var(). ` +
        `Added: ${[...new Set(hits)].slice(0, 6).join(', ')}`,
    )
    check(
      hits.length === pin,
      `${rel} is down to ${hits.length} duplicated literal(s) from a pin of ${pin} — good. ` +
        `Now lower the pin: set LEGACY_PINS['${rel}'] = ${hits.length}` +
        (hits.length === 0 ? ` (or better, delete the entry — the file is clean).` : `.`),
    )
    return `${hits.length}/${pin} legacy duplicates (ratchet holding)`
  })
}

// ---------------------------------------------------------------------------
section('5. COMPOSITE tokens may COMPOSE the palette — they may not extend it')
// ---------------------------------------------------------------------------
// THE HOLE THIS CLOSES (K3 fast-follow #5, 2026-08-14). Section 4 stops a
// stylesheet re-typing a token's value, and it deliberately does not treat a
// composite token (a shadow, a gradient) as a colour — see colorTokens' own
// note for why that is right. But it left composite tokens as the ONE place a
// colour could enter this app's palette with nothing checking it: add
//
//     --glow-warm: 0 0 10px rgba(255, 180, 120, .5);
//
// and an off-palette hue is now shipping, in a token that section 4 skips by
// construction and section 1/2's mirrors never look at. Nobody re-typed
// anything, so nothing failed.
//
// So: every colour literal INSIDE a composite token is parsed, and its RGB
// channels must belong to the palette — either a single-colour token's own
// RGB (any alpha; a glow is the accent at a different opacity, which is the
// entire point of a glow) or one of the explicitly-listed non-token channel
// values below. A composite can therefore restate the palette in any shape it
// likes and can never introduce a new colour to it.
//
// This is a CHANNEL check, not an alpha check, and deliberately so: pinning
// alphas here would mean a designer cannot tune a glow's falloff without
// editing a test, which is exactly the kind of gate people start ignoring.

/** RGB triples that legitimately appear inside composite tokens without being
 *  a colour token of their own. Every entry is a deliberate palette decision
 *  and needs a reason next to it. ADDING TO THIS LIST IS A PALETTE CHANGE —
 *  that is the point of it being a list rather than a wildcard. */
const COMPOSITE_EXTRA_RGB = [
  {
    rgb: [190, 215, 255],
    why: 'the DMD texture blue — --scanlines / --dotmatrix. Never a fill or an ink: it exists only as a 2.4%/5.5% overlay on chrome bars, so it has no single-colour token of its own (BACKGLASS §6).',
  },
]

test('every composite token in :root is built ONLY from palette channels', () => {
  check(compositeTokens.length > 0, 'no composite tokens found in :root — this section would pass vacuously')
  const offenders = []
  const seen = []
  for (const { name, value } of compositeTokens) {
    for (const m of value.matchAll(COLOR_RE)) {
      const lit = parseColor(m[0])
      if (!lit) continue
      const token = colorTokens.find((t) => t.r === lit.r && t.g === lit.g && t.b === lit.b)
      const extra = COMPOSITE_EXTRA_RGB.find((e) => e.rgb[0] === lit.r && e.rgb[1] === lit.g && e.rgb[2] === lit.b)
      if (token) seen.push(`${name} <- var(${token.name})`)
      else if (extra) seen.push(`${name} <- allowlisted rgb(${extra.rgb.join(',')})`)
      else offenders.push(`${name} contains ${m[0]} — rgb(${lit.r},${lit.g},${lit.b}) is not any token's colour and is not on COMPOSITE_EXTRA_RGB`)
    }
  }
  check(
    offenders.length === 0,
    `these composite tokens introduce a colour the palette never approved:\n            ${offenders.join('\n            ')}\n` +
      `          — either express it with an existing token's channels, or add a REAL token for it (which section 4 then polices), ` +
      `or, if it genuinely has no token (a texture overlay), add it to COMPOSITE_EXTRA_RGB with a reason.`,
  )
  return `${compositeTokens.length} composite token(s), ${seen.length} inner colour(s), all from the palette`
})

test('the check itself: a composite smuggling an OLD-palette colour is caught', () => {
  // Seeded directly against the matcher, so this cannot rot into a tautology
  // if the real :root happens to stay clean forever. #f5a623 is the amber
  // BACKGLASS replaced — the single most likely thing to be pasted back in.
  const smuggled = '0 0 10px rgba(245, 166, 35, 0.45)'
  const hits = [...smuggled.matchAll(COLOR_RE)].map((m) => parseColor(m[0])).filter(Boolean)
  check(hits.length === 1, `expected to parse 1 colour out of the seeded composite, got ${hits.length}`)
  const lit = hits[0]
  const token = colorTokens.find((t) => t.r === lit.r && t.g === lit.g && t.b === lit.b)
  const extra = COMPOSITE_EXTRA_RGB.find((e) => e.rgb[0] === lit.r && e.rgb[1] === lit.g && e.rgb[2] === lit.b)
  check(!token && !extra, 'the OLD amber rgb(245,166,35) is still reachable from the palette — this gate would not catch a regression')
  // And the positive control: the CURRENT amber at an arbitrary alpha passes.
  const ok = parseColor('rgba(255, 176, 46, 0.31)')
  check(
    colorTokens.some((t) => t.r === ok.r && t.g === ok.g && t.b === ok.b),
    'the current amber at a one-off alpha must be allowed inside a composite — a glow is the accent at a different opacity',
  )
  return 'old amber rejected, current amber at any alpha accepted'
})

// ---------------------------------------------------------------------------
section('6. The display face: self-hosted, swap-declared, preloaded')
// ---------------------------------------------------------------------------
// BACKGLASS ships a webfont. Three claims were made about how (K3 fast-follow
// #2 asked for the second one specifically, which had been asserted in a
// comment and nowhere else):
//   1. Self-hosted — the app runs under a strict CSP with no external origins,
//      so an external font URL does not degrade, it simply never loads.
//   2. font-display: swap on EVERY face — without it the default is `block`,
//      and text set in the display face is INVISIBLE for up to 3s on a slow
//      connection. That is the difference between "the font arrives late" and
//      "the header is blank at a machine in a dark arcade".
//   3. Preloaded — all three weights, so the swap is one moment rather than
//      three staggered ones.

const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf8')
const FONT_WEIGHTS = [
  ['Regular', 400],
  ['SemiBold', 600],
  ['Bold', 700],
]

test('styles.css declares one @font-face per shipped weight, each self-hosted and swap-declared', () => {
  const faces = [...stylesSrc.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])
  check(faces.length === 3, `expected 3 @font-face blocks (one per shipped weight), found ${faces.length}`)
  for (const [file, weight] of FONT_WEIGHTS) {
    const face = faces.find((f) => f.includes(`ChakraPetch-${file}-latin.woff2`))
    check(face, `no @font-face references ChakraPetch-${file}-latin.woff2`)
    check(
      new RegExp(`font-weight:\\s*${weight}\\b`).test(face),
      `the ${file} face does not declare font-weight: ${weight} — a wrong weight mapping silently synthesises a fake bold`,
    )
    check(
      /font-display:\s*swap/.test(face),
      `the ${file} face does not declare font-display: swap — its text is INVISIBLE (not fallback-rendered) while the font loads`,
    )
    check(
      /url\('\/fonts\//.test(face),
      `the ${file} face must load from an ABSOLUTE /fonts/ path (see the guide/legal pages: a relative path 404s under /machines/<slug>/ and /legal/)`,
    )
  }
  check(!/@import/.test(stylesSrc), 'styles.css must not @import a stylesheet (CSP + an extra round trip)')
  return '3 faces: 400/600/700, all font-display:swap, all /fonts/*.woff2'
})

test('index.html preloads ALL THREE weights, with crossorigin', () => {
  const preloads = [...indexHtml.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0])
  const fontPreloads = preloads.filter((l) => l.includes('/fonts/'))
  check(
    fontPreloads.length === 3,
    `expected 3 font preloads (one per weight — a partial set makes the first paint swap in stages), found ${fontPreloads.length}`,
  )
  for (const [file] of FONT_WEIGHTS) {
    const tag = fontPreloads.find((l) => l.includes(`ChakraPetch-${file}-latin.woff2`))
    check(tag, `ChakraPetch-${file}-latin.woff2 is not preloaded`)
    check(/as="font"/.test(tag), `the ${file} preload needs as="font"`)
    check(/type="font\/woff2"/.test(tag), `the ${file} preload needs type="font/woff2"`)
    // Without crossorigin the preload is a SECOND, unmatched request rather
    // than a warmed cache entry — it makes the page slower, not faster.
    check(/crossorigin/.test(tag), `the ${file} preload needs crossorigin — fonts are fetched in CORS mode even same-origin`)
  }
  return '3 preloads, each as=font type=font/woff2 crossorigin'
})

test('every shipped font file actually exists on disk, and OFL.txt travels with them', () => {
  // The licence is not optional: SIL OFL 1.1 requires the notice to accompany
  // the fonts, and app/public/ is what gets deployed.
  const dir = resolve(__dirname, '../public/fonts')
  for (const [file] of FONT_WEIGHTS) {
    check(existsSync(resolve(dir, `ChakraPetch-${file}-latin.woff2`)), `app/public/fonts/ChakraPetch-${file}-latin.woff2 is missing`)
  }
  check(existsSync(resolve(dir, 'OFL.txt')), 'app/public/fonts/OFL.txt is missing — the SIL OFL requires it to ship with the fonts')
  return '3 woff2 + OFL.txt present in app/public/fonts/'
})

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed) {
  console.log('\nFAILED:')
  for (const r of results.filter((x) => x.outcome === 'fail')) console.log(`  - ${r.name}`)
  process.exit(1)
}
