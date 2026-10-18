#!/usr/bin/env node
// app/tests/hit-areas.test.mjs — SUITE 22: the ::after tap-target overlays
// (P4, 2026-08-14).
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/hit-areas.test.mjs"
// or from app/:
//   node tests/hit-areas.test.mjs
//
// WHY THIS SUITE EXISTS. P4 grew several controls' TAP targets to 44px without
// changing their drawn size, using the standard trick: `position: relative` on
// the control plus an absolutely positioned, transparent `::after` with
// negative insets. That trick has exactly two silent failure modes, and both
// produce a control that LOOKS identical, tests green on behaviour, and simply
// never grew:
//
//   1. NO POSITIONING CONTEXT. Without `position: relative` (or another
//      positioned value) on the control itself, the overlay resolves against
//      some distant ancestor and lands nowhere near the button.
//   2. A CLIPPING ANCESTOR. An absolutely positioned box is clipped by an
//      ancestor with a non-visible `overflow` WHEN that ancestor is in its
//      containing-block chain. `position: relative` on the control makes the
//      control itself exactly such an ancestor — so a control that clips its
//      own content (the classic: `overflow: hidden` for `text-overflow:
//      ellipsis`) clips its own hit area back to its drawn size.
//
//   Failure 2 was NOT hypothetical: `.map-settings-segmented-btn` (MODEL /
//   LEVEL / TRAIL STYLE) carried `overflow: hidden` for its ellipsis, so the
//   44px target its ::after claimed to create did not exist. The fix moved the
//   ellipsis onto an inner `.map-settings-segmented-label` span; this suite is
//   what stops it — or any future copy of it — coming back.
//
// The CONTROL MAP below is the enumerated audit itself: per control, its
// declared drawn size, the overlay's insets, the DOM ancestor chain up to the
// nearest element that could clip, and the source of the spacing that decides
// how far the overlay may safely reach. It is data, not prose, so the tests
// re-check it on every run instead of trusting a table someone wrote once.
//
// Sections:
//   1. Every hit-area ::after in the tree is positioned and unclipped by its
//      own control (mechanical — finds rules this file never named).
//   2. The audited ancestor chains carry no clipping overflow.
//   3. Neighbour spacing: each overlay's reach is <= the clear space it has.
//      Also the one control that deliberately does NOT meet 44px per item and
//      is still correct: the Machine Library's A-Z rail, where 26 letters x
//      44px = 1144px of column does not fit any phone, so the platform's
//      continuous-surface pattern applies instead. The argument and the
//      geometry that makes it true are both asserted there.
//   4. The settings popover's real row pitch, and its viewport independence
//      (it is a fixed-px panel, so 320px changes nothing about the math).
//   5. Controls that deliberately do NOT use an overlay (the goal-step chips
//      grew by padding instead) are confirmed to still meet their floor.
//
// Exits non-zero on any FAIL.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')

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
    console.log(`  FAIL  ${name}\n          ${err && err.message ? err.message : err}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------------------
// Every stylesheet, parsed into flat top-level rules.
// ---------------------------------------------------------------------------
const SHEETS = [
  'styles.css',
  'overlay/map2d.css',
  'ui/sheet.css',
  'ui/glossary.css',
  'ui/howto.css',
  'ui/account.css',
  'ui/achievements.css',
  'ui/adslot.css',
  'ui/signupgate.css',
  'ui/footer.css',
  'ui/instagram.css',
  'ui/cookieWarning.css',
  // P6 (2026-08-14). Adding a stylesheet HERE is what makes section 1's
  // "found by scanning" claim true of it: the scan is mechanical over the
  // rules parsed from this list, so a sheet missing from the list is a sheet
  // whose hit areas nobody checks. library.css brought two.
  'ui/library.css',
]

/** { selectors: [...], body, file } for every top-level rule, comments and
 *  @media/@keyframes bodies stripped of their wrapper so inner rules still
 *  parse (nested rules read as top-level here, which is what we want: a
 *  declaration inside @media still applies). */
const rules = []
for (const file of SHEETS) {
  let css
  try {
    css = readFileSync(resolve(srcDir, file), 'utf8')
  } catch {
    continue // a stylesheet that no longer exists is not this gate's problem
  }
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    const selectorText = m[1].trim()
    if (selectorText.startsWith('@')) continue // @media/@keyframes wrappers
    rules.push({ selectors: selectorText.split(',').map((s) => s.trim()), body: m[2], file })
  }
}

const rulesFor = (sel) => rules.filter((r) => r.selectors.includes(sel))

/** Resolved longhand for `sel` across every rule naming it (source order =
 *  cascade order; every selector here is single-class, i.e. equal
 *  specificity). null when never declared. */
function cssValue(sel, prop) {
  let value = null
  for (const r of rulesFor(sel)) {
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g')
    let m
    while ((m = re.exec(r.body))) value = m[1].trim()
  }
  return value
}

/** Does `sel` clip its own absolutely positioned descendants? */
function clipsDescendants(sel) {
  for (const prop of ['overflow', 'overflow-x', 'overflow-y']) {
    const v = cssValue(sel, prop)
    if (v && /\b(hidden|clip|auto|scroll)\b/.test(v)) return `${prop}: ${v}`
  }
  return null
}

const px = (v) => (v === null ? null : Number(/(-?\d+(?:\.\d+)?)px/.exec(v)?.[1] ?? NaN))

// ---------------------------------------------------------------------------
// THE AUDIT TABLE. One entry per control that grew a hit area in P4.
//   drawn      — the control's painted size, from its own rule.
//   insets     — what the ::after declares.
//   chain      — DOM ancestors that must NOT clip, nearest first (asserted in
//                section 2). Sourced by reading the builders, not guessed:
//                app.ts buildTabBar, overlay/map2d.ts's goal-pill row +
//                settings popover, ui/sheet.ts, ui/howto.ts, ui/account.ts.
//   scrollport  — the one ancestor that IS allowed to clip, where the control
//                lives inside a scrolling panel. Not a defect and not exempt:
//                it gets its own test stating exactly how far it bounds the
//                overlay (section 2's second test).
//   clearance  — how much room the overlay may claim on the axis it grows,
//                and where that number comes from.
// ---------------------------------------------------------------------------
const CONTROLS = [
  {
    control: '.tab-btn',
    drawn: 'content-sized, ~38px tall (--tabbar-h)',
    grows: 'top only',
    chain: ['.tab-bar'],
    clearance: 'full width, no gap: .tab-bar is a plain flex row of flex:1 buttons, so neighbours abut exactly and cannot overlap',
  },
  {
    control: '.map-settings-btn',
    drawn: '36x36',
    grows: 'all sides',
    chain: ['.map-goal-pill-row'],
    clearance: '.map-goal-pill-row gap: 8px (declared px) -> 4px each side meets in the middle, never overlaps',
  },
  {
    control: '.map-goal-clear',
    drawn: '36x36',
    grows: 'all sides',
    chain: ['.map-goal-pill-row'],
    clearance: 'same 8px declared gap',
  },
  {
    control: '.map-settings-toggle',
    drawn: '42x24',
    grows: 'vertical only',
    chain: ['.map-settings-row'],
    scrollport: '.map-settings-popover',
    clearance: '.map-settings-row padding: 10px 0 -> 24 + 20 = exactly one row of pitch',
  },
  {
    control: '.map-settings-segmented-btn',
    drawn: 'min-height 26px',
    grows: 'vertical only',
    chain: ['.map-settings-segmented'],
    scrollport: '.map-settings-popover',
    clearance: '.map-settings-segmented gap: 2px is HORIZONTAL, and this overlay grows vertically only',
  },
  {
    control: '.map-settings-scroller-btn',
    drawn: '26x26',
    grows: 'vertical only',
    chain: ['.map-settings-scroller'],
    scrollport: '.map-settings-popover',
    clearance: '.map-settings-scroller gap: 6px is HORIZONTAL; vertical-only growth cannot reach the label between the two buttons',
  },
  {
    control: '.pg-sheet-close',
    drawn: '36x36',
    grows: 'all sides',
    chain: ['.pg-sheet-header', '.pg-sheet-panel'],
    clearance: '.pg-sheet-header gap: 10px, and its only neighbour is the title text (not a tap target)',
  },
  {
    control: '.pg-howto-close',
    drawn: '36x36',
    grows: 'all sides',
    chain: ['.pg-howto-header', '.pg-howto-overlay'],
    clearance: '.pg-howto-header gap: 12px, neighbour is the title text',
  },
  {
    control: '.pg-account-close',
    drawn: '36x36',
    grows: 'all sides',
    chain: ['.pg-account-header', '.pg-account-overlay'],
    clearance: '.pg-account-header gap: 12px, neighbour is the title text',
  },
  // ---- P6 (2026-08-14), the Machine Library overlay -----------------------
  {
    control: '.pg-library-close',
    drawn: '36x36',
    grows: 'all sides',
    chain: ['.pg-library-header', '.pg-library-overlay'],
    clearance: '.pg-library-header gap: 12px, neighbour is the title text',
  },
  {
    control: '.pg-library-pin',
    drawn: '34x34',
    grows: 'all sides',
    chain: ['.pg-library-rowwrap'],
    clearance:
      "the star is the trailing item of a 48px row, so 5px of growth leaves 7px of clear space above and below before it could reach the star in the next row. Rightward it grows into the body's own right padding (16px, or 8px with the rail up), so it never reaches the rail's surface either. Leftward it overlaps its OWN row button, which is the intent: a tap in that corner is meant to hit the star.",
  },
]

// The A-Z rail is NOT in the table above, on purpose: it does not use the
// ::after recipe at all, and section 1 asserts every entry here is found among
// the scanned ::after rules. It has its own test in section 3, because its
// geometry is a different argument entirely — see there.

// ===========================================================================
section('1. Every hit-area ::after in the tree is positioned by its control and not clipped by it')
// ===========================================================================

/** Every `X::after` rule that is a hit-area overlay: absolutely positioned,
 *  empty content, and at least one negative offset. Found by SCANNING, so a
 *  new one added next month is audited even though this file never names it. */
const overlayRules = rules.filter((r) => {
  if (!r.selectors.some((s) => /::after$/.test(s))) return false
  if (!/position:\s*absolute/.test(r.body)) return false
  return /(?:^|;)\s*(?:inset|top|right|bottom|left)\s*:\s*[^;]*-\d/.test(r.body)
})

test('the scan finds every overlay this phase added (and would find one it did not)', () => {
  assert(overlayRules.length >= CONTROLS.length, `scanned ${overlayRules.length} hit-area ::after rules but the audit table lists ${CONTROLS.length}`)
  const scanned = new Set(overlayRules.flatMap((r) => r.selectors.map((s) => s.replace(/::after$/, ''))))
  const missing = CONTROLS.map((c) => c.control).filter((c) => !scanned.has(c))
  assert(missing.length === 0, `audited but not found in CSS: ${missing.join(', ')}`)
  return [...scanned].sort().join(', ')
})

test('each one has a POSITIONING CONTEXT on its own control — without it the overlay lands somewhere else entirely', () => {
  const bad = []
  for (const r of overlayRules) {
    for (const sel of r.selectors) {
      const base = sel.replace(/::after$/, '')
      const pos = cssValue(base, 'position')
      if (!pos || !/relative|absolute|fixed|sticky/.test(pos)) bad.push(`${base} (position: ${pos ?? 'static/undeclared'})`)
    }
  }
  assert(bad.length === 0, `these controls do not establish a containing block for their ::after: ${bad.join(', ')}`)
  return `${overlayRules.length} overlays, all anchored`
})

/** Every rule that targets `control` (e.g. `.pg-library-pin`) as its RIGHTMOST
 *  simple selector — i.e. every rule that styles that element in ANY context,
 *  not just the one whose selector is exactly the control. */
function rulesTargeting(control) {
  return rules.filter((r) =>
    r.selectors.some((sel) => sel.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() === control),
  )
}

test('no rule ANYWHERE un-positions a control that owns a hit overlay — the bug that made the machine list untappable', () => {
  // WHY THIS EXISTS, and why the gate above was not enough.
  //
  // That gate resolves `position` from rules whose selector is EXACTLY the
  // control's class. `.pg-library-pin` declares `position: relative`, so it
  // passed — while `.pg-library-current .pg-library-pin`, a more specific rule
  // styling the SAME element in the current-machine strip, reset it to
  // `position: static`. The star's `::after { position: absolute; inset: -5px }`
  // then resolved against its nearest POSITIONED ancestor, which was no longer
  // the star: it was `.pg-library-overlay { position: fixed; inset: 0 }`. So
  // "44px around a 34px star" silently became "the whole screen, plus 5px" —
  // one transparent box covering the entire overlay, painted above every static
  // in-flow row beneath it (absolutely positioned content paints in a later
  // phase than in-flow content, so DOM order does not rescue the rows).
  //
  // Every tap on every machine name in the library hit that box instead of the
  // row. rolo, from the live site: "When I click the title of the name of the
  // game list it doesn't select the game and move to that selected game's shots
  // or map or anything." Nothing threw. Nothing rendered wrong. And a synthetic
  // `.click()` on the row button passed the whole time, because a synthetic
  // click skips hit-testing — which is the only thing this bug touched.
  //
  // There is no legitimate reason to un-position a control that owns a hit
  // overlay, so this is a flat prohibition rather than a cascade simulation.
  const controls = [...new Set(overlayRules.flatMap((r) => r.selectors.map((s) => s.replace(/::after$/, ''))))]
  const bad = []
  // A GATE THAT MATCHES NOTHING PASSES EVERYTHING. Every control must resolve
  // to at least its own base rule, or the scan is inspecting an empty set and
  // the green below means nothing. (This fired while the check was being
  // written — the first draft stripped the leading dot and matched zero rules.)
  for (const control of controls) {
    const n = rulesTargeting(control).length
    assert(n > 0, `the scan found no rules at all for ${control} — it is not matching selectors, so its verdict is meaningless`)
  }
  for (const control of controls) {
    for (const r of rulesTargeting(control)) {
      const m = /(?:^|;)\s*position\s*:\s*([^;]+)/.exec(r.body)
      if (m && m[1].trim() === 'static') {
        bad.push(`${r.selectors.join(', ')} { position: static } in ${r.file} — ${control}'s ::after would escape to its nearest positioned ancestor`)
      }
    }
  }
  assert(bad.length === 0, bad.join(' | '))
  const scanned = controls.map((c) => `${c} (${rulesTargeting(c).length} rules)`)
  return `${controls.length} hit-overlay controls, every rule that styles them checked: ${scanned.join(', ')}`
})

test('MUTATION — re-introducing `position: static` on the strip star turns the gate above RED', () => {
  // The regression that shipped, seeded back in and run through the very check
  // written to catch it. A gate for a bug that has never been shown to fire is
  // a gate nobody has checked.
  const css = readFileSync(resolve(srcDir, 'ui/library.css'), 'utf8')
  const mutated = css.replace(
    /(\.pg-library-current \.pg-library-pin \{)/,
    '$1\n  position: static;',
  )
  assert(mutated !== css, 'the mutation did not apply — .pg-library-current .pg-library-pin no longer exists')
  // Parse the mutant the same way this file parses everything else.
  const mutantRules = []
  const body = mutated.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(body))) {
    const sel = m[1].trim()
    if (sel.startsWith('@')) continue
    mutantRules.push({ selectors: sel.split(',').map((s) => s.trim()), body: m[2] })
  }
  const offenders = mutantRules.filter(
    (r) =>
      r.selectors.some((sel) => sel.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() === '.pg-library-pin') &&
      /(?:^|;)\s*position\s*:\s*static/.test(r.body),
  )
  assert(offenders.length === 1, `the seeded regression should be caught exactly once, got ${offenders.length}`)
  assert(
    offenders[0].selectors.includes('.pg-library-current .pg-library-pin'),
    `caught the wrong rule: ${offenders[0].selectors.join(', ')}`,
  )
  return `seeded \`position: static\` on .pg-library-current .pg-library-pin -> caught (${offenders[0].selectors.join(', ')})`
})

test('and NONE of them is clipped by its own control — the .map-settings-segmented-btn bug, generalised into a gate', () => {
  const clipped = []
  for (const r of overlayRules) {
    for (const sel of r.selectors) {
      const base = sel.replace(/::after$/, '')
      const clip = clipsDescendants(base)
      if (clip) clipped.push(`${base} { ${clip} } silently clips its own hit area back to its drawn size`)
    }
  }
  assert(clipped.length === 0, clipped.join('; '))
  return 'no control clips its own overlay'
})

test('the ellipsis that used to do exactly that now lives on an inner span, not on the button', () => {
  assert(clipsDescendants('.map-settings-segmented-btn') === null, '.map-settings-segmented-btn is clipping again')
  const label = '.map-settings-segmented-label'
  assert(rulesFor(label).length > 0, `expected a ${label} rule to own the ellipsis`)
  assert(/hidden/.test(cssValue(label, 'overflow') ?? ''), `${label} must be the box that clips the text`)
  assert(cssValue(label, 'text-overflow') === 'ellipsis', `${label} must ellipsize`)
  assert(cssValue(label, 'white-space') === 'nowrap', `${label} must not wrap`)
  // …and the button must actually build one, or the CSS is decoration.
  const map2dSrc = readFileSync(resolve(srcDir, 'overlay/map2d.ts'), 'utf8')
  assert(map2dSrc.includes("text.className = 'map-settings-segmented-label'"), 'overlay/map2d.ts does not build the label span')
  assert(
    (map2dSrc.match(/className = 'map-settings-segmented-btn'/g) || []).length === 1,
    'every segmented button must come from the one buildSegmentedBtn helper, or a copy will skip the span',
  )
  return 'ellipsis on .map-settings-segmented-label; one builder'
})

// ===========================================================================
section('2. The audited ancestor chains carry no clipping overflow')
// ===========================================================================

test('no ancestor between an expanded control and its panel clips — the second silent failure mode', () => {
  const offenders = []
  const lines = []
  for (const c of CONTROLS) {
    for (const anc of c.chain) {
      const clip = clipsDescendants(anc)
      if (clip) offenders.push(`${c.control} <- ${anc} { ${clip} }`)
    }
    const tail = c.scrollport ? ` <- [${c.scrollport} — scrollport, bounded]` : ''
    lines.push(`${c.control.padEnd(28)} ${c.drawn.padEnd(28)} ${c.grows.padEnd(14)} chain: ${c.chain.join(' <- ')}${tail}`)
  }
  assert(offenders.length === 0, `clipping ancestors: ${offenders.join('; ')}`)
  return lines.join('\n          ')
})

test('the ONE clipping ancestor in the tree is named and bounded: .map-settings-popover scrolls, so it clips at its own edges only', () => {
  const clip = clipsDescendants('.map-settings-popover')
  assert(clip, 'expected the popover to be a scroll container (it has max-height + overflow-y)')
  // It is not in any control's `chain` above for a reason: it clips at the
  // popover's boundary, not around each row. The only real consequence is the
  // FIRST and LAST rows, whose 10px of outward growth is bounded by the
  // popover's own padding before the scrollport edge takes over.
  const padding = cssValue('.map-settings-popover', 'padding')
  const padY = px(padding.split(/\s+/)[0])
  assert(Number.isFinite(padY) && padY > 0, `expected a px vertical padding on the popover, got ${padding}`)
  return `${clip}; ${padY}px of padding bounds the first/last row's outward growth (mid-list rows are unaffected)`
})

// ===========================================================================
section('3. Neighbour spacing: every overlay reaches no further than its clear space')
// ===========================================================================

test('.map-settings-btn / .map-goal-clear: 4px each side into a DECLARED 8px flex gap — they meet, they never overlap', () => {
  const gap = px(cssValue('.map-goal-pill-row', 'gap'))
  assert(gap === 8, `expected a declared 8px gap, got ${cssValue('.map-goal-pill-row', 'gap')}`)
  // The gap must be a real length, not space-between: a percentage/auto gap
  // shrinks at narrow widths and the inset math stops holding.
  assert(!/space-between|space-around|space-evenly/.test(cssValue('.map-goal-pill-row', 'justify-content') ?? ''), 'spacing must come from a declared gap, not from justify-content')
  for (const sel of ['.map-settings-btn', '.map-goal-clear']) {
    const inset = px(cssValue(`${sel}::after`, 'inset'))
    assert(inset === -4, `${sel}::after inset is ${cssValue(`${sel}::after`, 'inset')}, expected -4px`)
    assert(-inset * 2 <= gap, `${sel} grows ${-inset}px each side into an ${gap}px gap — the two overlays would overlap`)
    const w = px(cssValue(sel, 'width'))
    const h = px(cssValue(sel, 'height'))
    assert(w === 36 && h === 36, `${sel} is drawn ${w}x${h}, expected 36x36`)
    assert(w - inset * 2 >= 44, `${sel} effective target is ${w - inset * 2}px, under 44`)
  }
  return '36 + 4 + 4 = 44 effective, into an 8px gap'
})

test('the four close buttons: 36 -> 44, and their only neighbour is title TEXT, not another target', () => {
  const rows = []
  for (const [sel, header, gapExpect] of [
    ['.pg-sheet-close', '.pg-sheet-header', 10],
    ['.pg-howto-close', '.pg-howto-header', 12],
    ['.pg-account-close', '.pg-account-header', 12],
    ['.pg-library-close', '.pg-library-header', 12],
  ]) {
    const inset = px(cssValue(`${sel}::after`, 'inset'))
    assert(inset === -4, `${sel}::after inset is ${cssValue(`${sel}::after`, 'inset')}, expected -4px`)
    const w = px(cssValue(sel, 'width'))
    assert(w === 36, `${sel} drawn width ${w}, expected 36`)
    assert(w - inset * 2 === 44, `${sel} effective ${w - inset * 2}px`)
    const gap = px(cssValue(header, 'gap'))
    assert(gap === gapExpect, `${header} gap is ${cssValue(header, 'gap')}, expected ${gapExpect}px`)
    assert(-inset <= gap, `${sel} reaches ${-inset}px into a ${gap}px gap`)
    rows.push(`${sel} 36->44 in ${header} (gap ${gap}px)`)
  }
  return rows.join('; ')
})

test('the settings-popover controls grow VERTICALLY ONLY, because their neighbours are horizontal', () => {
  for (const sel of ['.map-settings-toggle', '.map-settings-segmented-btn', '.map-settings-scroller-btn']) {
    const inset = cssValue(`${sel}::after`, 'inset')
    assert(inset === '-10px 0', `${sel}::after inset is ${JSON.stringify(inset)}, expected '-10px 0' (vertical only)`)
  }
  // Horizontal neighbours confirmed present, which is WHY it is vertical-only.
  assert(px(cssValue('.map-settings-segmented', 'gap')) === 2, 'segmented buttons sit 2px apart — sideways growth would collide')
  assert(px(cssValue('.map-settings-scroller', 'gap')) === 6, 'the scroller ‹ › flank a label 6px away')
  return 'toggle / segmented / scroller: inset -10px 0'
})

test('.pg-library-pin: 34 -> 44, and its reach fits the 48px row pitch it grows into', () => {
  const inset = px(cssValue('.pg-library-pin::after', 'inset'))
  assert(inset === -5, `.pg-library-pin::after inset is ${cssValue('.pg-library-pin::after', 'inset')}, expected -5px`)
  const w = px(cssValue('.pg-library-pin', 'width'))
  const h = px(cssValue('.pg-library-pin', 'height'))
  assert(w === 34 && h === 34, `.pg-library-pin is drawn ${w}x${h}, expected 34x34`)
  assert(w - inset * 2 >= 44, `effective target is ${w - inset * 2}px, under 44`)
  // The overlay needs the star itself as its containing block. In the grid the
  // star was `position: absolute` and got that for free; as a laid-out row item
  // it has to DECLARE `position: relative`, or the ::after resolves against
  // some distant ancestor — failure mode 1 in this file's header, reintroduced
  // by a layout change rather than by anyone touching the ::after.
  const pos = cssValue('.pg-library-pin', 'position')
  assert(/^(relative|absolute|sticky|fixed)$/.test(pos ?? ''), `.pg-library-pin position is ${pos} — its ::after has no positioning context`)
  // VERTICAL is the tight axis now: the star is centred in a 48px row, so it
  // has (48 - 34) / 2 = 7px of clear space before it would reach the star in
  // the row above or below.
  const pitch = px(cssValue('.pg-library-row', 'min-height'))
  assert(pitch === 48, `.pg-library-row min-height is ${cssValue('.pg-library-row', 'min-height')}, expected 48px`)
  const clear = (pitch - h) / 2
  assert(-inset <= clear, `the star grows ${-inset}px into ${clear}px of clear space — adjacent rows' stars would overlap`)
  // RIGHTWARD it grows into the body's own padding, and with the rail up that
  // padding is the only thing between the star and the rail's live surface.
  const railedPad = px(cssValue('.pg-library-body-railed', 'padding-right'))
  assert(-inset <= railedPad, `the star reaches ${-inset}px right into a ${railedPad}px gutter — it would land on the rail`)
  // And the wrapper must not clip it back to 34.
  assert(clipsDescendants('.pg-library-rowwrap') === null, ".pg-library-rowwrap clips its own star's hit area")
  return `34 + 5 + 5 = ${w - inset * 2} effective; ${clear}px vertical clearance in a ${pitch}px row, ${railedPad}px to the rail`
})

test('the A-Z rail: the COLUMN is the target, because 26 letters at 44px each cannot exist', () => {
  // THE ARGUMENT, since this is the one control in the app that does not meet
  // 44px per item and is still correct.
  //
  // 26 letters x 44px = 1144px of column. This rail spans the scrollport — the
  // viewport less the header, the search field and both safe areas — which on
  // the tallest phone this app runs on is roughly 700px and on a small one
  // closer to 480. A per-letter 44px index is not a thing that can be built at
  // any screen size that exists. So the platform builds ONE continuous surface
  // ~28px wide and hit-tests along it: the TARGET is the rail, and the letters
  // are its printed scale. Every point inside the column is live, so there is
  // no dead space to miss — which is the property the 44px floor exists to buy.
  const railWidth = px((cssValue('.pg-library-rail', 'flex') ?? '').split(/\s+/).pop())
  assert(railWidth >= 28, `.pg-library-rail is ${railWidth}px wide, under the 28px continuous-surface floor`)
  assert(26 * 44 > 1144 - 1, 'sanity: the impossibility this test documents is 1144px')
  // The whole column has to be live, which means the letters may not be
  // islands inside it: each takes an equal share of the height and the full
  // width. The equal share is also what railIndexAt() divides in TS — the two
  // may never drift apart.
  const btn = rulesFor('.pg-library-rail-btn')[0]
  assert(btn, 'no .pg-library-rail-btn rule')
  assert(/flex:\s*1\b/.test(btn.body), `each letter must take an equal share of the rail, got ${btn.body.trim()}`)
  assert(/width:\s*100%/.test(btn.body), 'and the full width of it, or the column has vertical dead strips')
  // A scrub down the index must not also drag the list behind it.
  const touch = cssValue('.pg-library-rail', 'touch-action')
  assert(touch === 'none', `.pg-library-rail touch-action is ${touch}, expected none`)
  // Nothing may clip the rail, or its lower letters stop responding.
  assert(clipsDescendants('.pg-library-rail') === null, '.pg-library-rail clips its own letters')
  assert(clipsDescendants('.pg-library-scrollarea') === null, '.pg-library-scrollarea clips the rail')
  return `rail column ${railWidth}px, fully live; 26 x 44 = 1144px is taller than any scrollport this app has`
})

test('.tab-btn grows upward only, and the 38px bar is NOT regrown', () => {
  const after = rulesFor('.tab-btn::after')[0]
  assert(after, 'no .tab-btn::after rule')
  assert(px(cssValue('.tab-btn::after', 'top')) === -7, `expected top:-7px, got ${cssValue('.tab-btn::after', 'top')}`)
  for (const side of ['right', 'bottom', 'left']) {
    assert(cssValue('.tab-btn::after', side) === '0', `expected ${side}:0, got ${cssValue('.tab-btn::after', side)}`)
  }
  assert(cssValue('.tab-bar', 'height') === null, 'the tab bar must stay content-sized — an explicit height is how it gets regrown by accident')
  assert(clipsDescendants('.tab-bar') === null, '.tab-bar must not clip, or the upward overlay is cut off')
  return '38px drawn + 7px upward = ~45px effective'
})

// ===========================================================================
section('4. The settings popover: its real row pitch, and why 320px does not change it')
// ===========================================================================

test('the row pitch is 44px of content + a 1px hairline = 45px, which is exactly what inset:-10px 0 fills', () => {
  const rowPad = cssValue('.map-settings-row', 'padding')
  const padY = px(rowPad.split(/\s+/)[0])
  const toggleH = px(cssValue('.map-settings-toggle', 'height'))
  assert(padY === 10, `.map-settings-row vertical padding is ${rowPad}, expected 10px`)
  assert(toggleH === 24, `.map-settings-toggle height is ${cssValue('.map-settings-toggle', 'height')}, expected 24px`)
  const content = toggleH + padY * 2
  assert(content === 44, `row content box computes to ${content}px, expected 44`)
  const border = px(cssValue('.map-settings-row', 'border-bottom'))
  assert(border === 1, `expected a 1px hairline between rows, got ${cssValue('.map-settings-row', 'border-bottom')}`)
  // Two stacked toggles therefore have (10 + 1 + 10) = 21px between their drawn
  // edges, and each grows 10px — 1px of daylight, never an overlap.
  assert(padY * 2 + border - 20 >= 0, 'stacked toggles’ hit areas would overlap')
  return `pitch ${content}px content + ${border}px hairline = ${content + border}px; toggle 24 -> ${toggleH + 2 * 10}px effective`
})

test('the popover is a FIXED-px panel, so a 320px viewport changes none of the above (and it still fits)', () => {
  const width = px(cssValue('.map-settings-popover', 'width'))
  const right = px(cssValue('.map-settings-popover', 'right'))
  assert(Number.isFinite(width), `expected a fixed px width, got ${cssValue('.map-settings-popover', 'width')}`)
  assert(width === 230 && right === 12, `expected width:230px right:12px, got ${width}/${right}`)
  assert(width + right <= 320, `the popover (${width}px + ${right}px offset) does not fit a 320px viewport`)
  // No row can wrap, because the widest label plus its control fits the
  // content box with room to spare. Labels are 12px/600 (see
  // .map-settings-row-label); 0.62em per character is pessimistic for this
  // system UI stack at that weight.
  const padX = px(cssValue('.map-settings-popover', 'padding').split(/\s+/)[1])
  const contentW = width - padX * 2
  const labelSize = px(cssValue('.map-settings-row-label', 'font-size'))
  const longest = 'Line brightness' // longest shipped row label
  const labelW = longest.length * labelSize * 0.62
  const rowGap = px(cssValue('.map-settings-row', 'gap'))
  const toggleW = px(cssValue('.map-settings-toggle', 'width'))
  assert(labelW + rowGap + toggleW < contentW, `"${longest}" (${labelW.toFixed(0)}px) + ${rowGap} + ${toggleW} exceeds the ${contentW}px content box — it would wrap and change the pitch`)
  return `230px fixed panel, ${contentW}px content; "${longest}" ~${labelW.toFixed(0)}px + ${rowGap} + ${toggleW} fits`
})

// ===========================================================================
section('5. The control that deliberately did NOT get an overlay')
// ===========================================================================

test('.goal-step-chip grew by PADDING, not by ::after — so no clipping ancestor can undo it', () => {
  assert(rulesFor('.goal-step-chip::after').length === 0, '.goal-step-chip must not use an overlay: it is inside a scrolling list of tappable rows')
  const fontSize = px(cssValue('.goal-step-chip', 'font-size'))
  const lineHeight = Number(cssValue('.goal-step-chip', 'line-height'))
  const padY = px(cssValue('.goal-step-chip', 'padding').split(/\s+/)[0])
  const border = px(cssValue('.goal-step-chip', 'border'))
  const height = fontSize * lineHeight + padY * 2 + border * 2
  assert(height >= 24, `.goal-step-chip computes to ${height}px, under the WCAG 2.5.8 24px floor`)
  return `${height}px from real box properties — unclippable by construction`
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
