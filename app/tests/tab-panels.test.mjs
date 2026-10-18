#!/usr/bin/env node
// app/tests/tab-panels.test.mjs — SUITE: the tab system's HIDE contract.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/tab-panels.test.mjs"
//
// WHY THIS SUITE EXISTS — a production outage, 2026-08-14 evening.
//
// app.ts hides the three inactive tab panels by setting the `hidden`
// attribute, and ONE stylesheet rule turns that into an actual hide:
//
//     .tab-panel[hidden] { display: none }        specificity 0-2-0
//
// The Study tab's two-column layout then added, on the same element:
//
//     #study-host { display: flex }               specificity 1-0-0
//
// An ID beats a class plus an attribute, so `display: flex` won on the hidden
// panel too. The Study panel never hid again: its pill rail painted over the
// Shots tab, and because all four panels were suddenly in flow together every
// canvas split the leftover height and shrank. The owner found it within the
// hour, with screenshots. Nothing in the suite noticed, because every test
// that touches layout drives a FAKE DOM with no cascade at all — the bug was
// pure CSS specificity, which is exactly the class of thing those harnesses
// cannot see.
//
// So this suite reads the SOURCE and enforces the general rule the outage
// taught, not the specific rule that broke:
//
//   For every element the tab system toggles with `hidden`, any stylesheet
//   rule that sets `display` on that element at specificity >= the hider's
//   MUST be accompanied by a matching `[hidden] { display: none }` rule of at
//   least equal specificity.
//
// The panel list is READ OUT of app.ts's PANEL_ID map rather than copied, so
// a fifth tab is covered the day it is added.
//
// WHAT THIS SUITE DELIBERATELY DOES NOT DO: resolve the cascade against the
// fake DOM the other suites use. Those FakeElements have no stylesheet, no
// computed style and no specificity model, so a "computed display" assertion
// there would be this file's own re-implementation of CSS grading itself —
// green because it agrees with itself. The real-cascade check is a browser
// walking the built app, which is a deploy-time step (and was run for the
// hotfix and again for the sweep that followed it); this is the gate that
// runs on every commit.
//
// Exits non-zero on any FAIL.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')
const appPath = resolve(srcDir, 'app.ts')

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
    console.log(`  FAIL  ${name}\n          ${err && err.stack ? err.stack : err}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------------------
// CSS reading
// ---------------------------------------------------------------------------

/** Every .css file under app/src, so a NEW stylesheet is covered the day it is
 *  added — the same "scan the tree, don't keep a list" discipline
 *  tokens.test.mjs's denylist uses. */
function allStylesheets(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) allStylesheets(full, acc)
    else if (entry.endsWith('.css')) acc.push(full)
  }
  return acc
}

/** Flat list of {selector, body, file, media} for every rule in `css`.
 *
 *  Brace-matching rather than a regex, because @media blocks nest and the
 *  naive `([^{}]+)\{([^{}]*)\}` this repo uses elsewhere silently mis-attributes
 *  the first rule inside one. */
function parseRules(css, file) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let i = 0
  const walk = (media) => {
    let prelude = ''
    while (i < src.length) {
      const ch = src[i]
      if (ch === '}') {
        i++
        return
      }
      if (ch === '{') {
        i++
        const sel = prelude.trim()
        prelude = ''
        if (sel.startsWith('@')) {
          // At-rule with a block: recurse for @media/@supports (their inner
          // rules are real rules), skip the body of @keyframes/@font-face.
          if (/^@(media|supports|layer|container)/i.test(sel)) {
            walk(media ? `${media} and ${sel}` : sel)
          } else {
            let depth = 1
            while (i < src.length && depth > 0) {
              if (src[i] === '{') depth++
              else if (src[i] === '}') depth--
              i++
            }
          }
        } else {
          const start = i
          let depth = 1
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            i++
          }
          rules.push({ selector: sel, body: src.slice(start, i - 1), file, media })
        }
        continue
      }
      prelude += ch
      i++
    }
  }
  walk(null)
  return rules
}

/** CSS specificity of ONE selector, as [ids, classes, elements]. Good enough
 *  for the selectors this app writes (no :is/:where/:not nesting games); the
 *  gate below fails loudly rather than guessing if it ever meets one. */
function specificity(sel) {
  assert(!/:is\(|:where\(|:not\(|:has\(/.test(sel), `specificity(): ${sel} uses a functional pseudo-class this grader does not model`)
  const ids = (sel.match(/#[\w-]+/g) || []).length
  const classes = (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/\[[^\]]*\]/g) || []).length + (sel.match(/:[a-z-]+(?![\w-]*\()/gi) || []).length
  const elements = (sel.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[a-z-]+/gi, ' ').match(/\b[a-z][\w-]*/gi) || []).length
  return [ids, classes, elements]
}

const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const specStr = (s) => s.join('-')

/** The last compound in a complex selector — the element the rule actually
 *  styles. `#study-host canvas` styles a canvas, not the panel. */
function subjectCompound(sel) {
  return sel.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? ''
}

// ---------------------------------------------------------------------------
const stylesheets = allStylesheets(srcDir)
const rules = stylesheets.flatMap((f) => parseRules(readFileSync(f, 'utf8'), relative(srcDir, f)))
const appSrc = readFileSync(appPath, 'utf8')

/** The panel element ids the tab system toggles, READ from app.ts. */
function panelIds() {
  const m = /const PANEL_ID: Record<TabId, string> = \{([\s\S]*?)\}/.exec(appSrc)
  assert(m, 'app.ts no longer declares `const PANEL_ID: Record<TabId, string>` — this suite cannot find the panels it guards')
  const ids = [...m[1].matchAll(/:\s*'([^']+)'/g)].map((x) => x[1])
  assert(ids.length >= 4, `expected at least the four tab panels in PANEL_ID, found ${ids.length}`)
  return ids
}

const PANELS = panelIds()

/** Rules that declare `display` for `prop`-matching selectors. */
function displayRules() {
  return rules.filter((r) => /(?:^|;)\s*display\s*:/.test(r.body))
}

// ===========================================================================
section('a. The panel list, and the one rule that hides them')
// ===========================================================================

test('the panels are read from app.ts, not copied into this file', () => {
  assert(PANELS.includes('study-host'), `expected study-host among the panels, got ${JSON.stringify(PANELS)}`)
  // Every id must actually be toggled by the tab handler, or the list is stale.
  for (const id of PANELS) {
    const varName = /goals/.test(id) ? 'goalsPanel' : /map/.test(id) ? 'mapPanel' : /study/.test(id) ? 'studyPanel' : 'achievementsPanel'
    assert(new RegExp(`${varName}\\.hidden = tab !==`).test(appSrc), `app.ts does not toggle ${varName}.hidden — the panel list and the hider have drifted`)
  }
  return PANELS.join(', ')
})

test('.tab-panel[hidden] { display: none } is still the hider, and every panel carries .tab-panel', () => {
  const hider = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '.tab-panel[hidden]') && /display\s*:\s*none/.test(r.body))
  assert(hider, 'no `.tab-panel[hidden] { display: none }` rule found — the whole tab system depends on it')
  assert(!hider.media, `the hider is inside ${hider.media}, so panels stay visible outside that condition`)
  assert(/panel\.className = 'tab-panel'/.test(appSrc), 'app.ts no longer gives its panels the .tab-panel class the hider matches')
  const spec = specificity('.tab-panel[hidden]')
  return `${hider.file}: .tab-panel[hidden] (specificity ${specStr(spec)})`
})

// ===========================================================================
section('b. THE GATE: no panel may out-specify its own hider without restating it')
// ===========================================================================

test('every display rule on a tab panel is matched by a [hidden] rule of at least equal specificity', () => {
  const HIDER = specificity('.tab-panel[hidden]')
  const offenders = []
  const covered = []

  for (const id of PANELS) {
    // Rules whose SUBJECT is this panel element and that set `display`.
    const onPanel = []
    for (const r of displayRules()) {
      for (const sel of r.selector.split(',').map((s) => s.trim())) {
        if (!sel) continue
        const subject = subjectCompound(sel)
        if (!subject.includes(`#${id}`)) continue
        onPanel.push({ ...r, sel, spec: specificity(sel), hidesWhenHidden: /\[hidden\]/.test(sel) && /display\s*:\s*none/.test(r.body) })
      }
    }
    if (onPanel.length === 0) continue

    const guards = onPanel.filter((r) => r.hidesWhenHidden)
    for (const r of onPanel) {
      if (r.hidesWhenHidden) continue
      // A rule weaker than the hider is harmless: the hider still wins.
      if (cmpSpec(r.spec, HIDER) < 0) continue
      const guard = guards.find((g) => cmpSpec(g.spec, r.spec) >= 0 && !g.media)
      if (guard) covered.push(`${r.sel} (${specStr(r.spec)}) <- ${guard.sel} (${specStr(guard.spec)})`)
      else offenders.push(`${r.file}: \`${r.sel}\` sets display at specificity ${specStr(r.spec)}, which beats .tab-panel[hidden] (${specStr(HIDER)})`)
    }
  }

  assert(
    offenders.length === 0,
    'A tab panel sets its own `display` at a specificity that DEFEATS the shared hider, with no [hidden] rule to restate it.\n' +
      'That panel will stay visible on every other tab — its content paints over the active tab and every panel\n' +
      'competes for the same space (this is the 2026-08-14 outage, verbatim).\n' +
      'FIX: add `<the same selector>[hidden] { display: none }` next to the offending rule.\n' +
      offenders.map((o) => `  - ${o}`).join('\n'),
  )
  assert(covered.length > 0, 'this gate found nothing to check — either the panels stopped setting display, or the scan is broken')
  return `${covered.length} guarded: ${covered.join('; ')}`
})

test('the guard is not itself inside a media query — a conditional hide is not a hide', () => {
  for (const r of rules) {
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      if (!PANELS.some((id) => subjectCompound(sel).includes(`#${id}`))) continue
      if (!/\[hidden\]/.test(sel) || !/display\s*:\s*none/.test(r.body)) continue
      assert(!r.media, `${r.file}: \`${sel}\` only hides inside \`${r.media}\` — outside it the panel is visible again`)
    }
  }
  return 'all panel [hidden] guards are unconditional'
})

// ===========================================================================
section('c. The same trap, one level out: nothing may out-specify a [hidden] hide')
// ===========================================================================
// The panels are the case that broke. The same cascade mistake is available to
// every other element this app hides with the attribute, and two of them are
// controls the Study rail depends on.

test('the conditional pills still hide: nothing outranks .study-action-btn[hidden] / .study-drills-btn[hidden]', () => {
  for (const cls of ['study-action-btn', 'study-drills-btn']) {
    const guard = rules.find((r) => r.selector.split(',').some((s) => s.trim() === `.${cls}[hidden]`) && /display\s*:\s*none/.test(r.body))
    assert(guard, `no \`.${cls}[hidden] { display: none }\` rule — a machine without that data would show a dead pill`)
    const guardSpec = specificity(`.${cls}[hidden]`)
    for (const r of displayRules()) {
      for (const sel of r.selector.split(',').map((s) => s.trim())) {
        if (subjectCompound(sel) !== `.${cls}`) continue
        assert(
          cmpSpec(specificity(sel), guardSpec) < 0,
          `${r.file}: \`${sel}\` (${specStr(specificity(sel))}) sets display at or above \`.${cls}[hidden]\` (${specStr(guardSpec)}) — the hidden pill would render anyway`,
        )
      }
    }
  }
  return 'both conditional pills hide at a specificity nothing in the tree beats'
})

test('the LEVEL control still hides on a machine with no zones', () => {
  // Added with the LEVEL feature (2026-08-14). `.study-level-group` sets its
  // own `display: flex`, which is exactly the shape of the rule that took the
  // Study panel down — a lower-specificity `[hidden]` would lose and a
  // zone-less machine would show an empty LEVEL heading in the rail.
  const guard = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '.study-level-group[hidden]') && /display\s*:\s*none/.test(r.body))
  assert(guard, 'no `.study-level-group[hidden] { display: none }` rule')
  assert(!guard.media, `the guard is inside ${guard.media}`)
  const guardSpec = specificity('.study-level-group[hidden]')
  for (const r of displayRules()) {
    for (const sel of r.selector.split(',').map((x) => x.trim())) {
      if (subjectCompound(sel) !== '.study-level-group') continue
      assert(
        cmpSpec(specificity(sel), guardSpec) < 0,
        `${r.file}: \`${sel}\` (${specStr(specificity(sel))}) sets display at or above the group's own [hidden] rule (${specStr(guardSpec)})`,
      )
    }
  }
  return 'the LEVEL group hides at a specificity nothing in the tree beats'
})

test('the in-sheet steppers still hide for the three kinds that do not use them', () => {
  const guard = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '.study-sheet-steps[hidden]') && /display\s*:\s*none/.test(r.body))
  assert(guard, 'no `.study-sheet-steps[hidden] { display: none }` rule — ACTION/DRILLS/ALT MODES would show ‹ › that step nothing they display')
  const guardSpec = specificity('.study-sheet-steps[hidden]')
  for (const r of displayRules()) {
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      if (subjectCompound(sel) !== '.study-sheet-steps') continue
      assert(cmpSpec(specificity(sel), guardSpec) < 0, `${r.file}: \`${sel}\` outranks the steppers' own [hidden] rule`)
    }
  }
  return 'steppers hide unconditionally'
})

// ===========================================================================
section('d. The parser this gate depends on')
// ===========================================================================
// The gate is only worth its output if it reads CSS correctly, and its two
// jobs — nesting-aware parsing and specificity grading — are exactly where a
// hand-rolled reader goes quietly wrong.

test('parseRules attributes rules inside @media to that media, and skips @keyframes bodies', () => {
  const css = `
    .a { display: block }
    @media (max-width: 359px) {
      .b { display: flex }
    }
    @keyframes spin { from { display: none } to { display: none } }
    .c { color: red }
  `
  const parsed = parseRules(css, 'test.css')
  const byName = Object.fromEntries(parsed.map((r) => [r.selector, r]))
  assert(byName['.a'] && !byName['.a'].media, '.a should be unconditional')
  assert(byName['.b'] && /max-width/.test(byName['.b'].media), '.b should be attributed to its @media')
  assert(byName['.c'] && !byName['.c'].media, '.c must not be swallowed by the @keyframes block before it')
  assert(!parsed.some((r) => r.selector === 'from' || r.selector === 'to'), 'keyframe steps are not rules')
  return `${parsed.length} rules parsed, media attributed, keyframes skipped`
})

test('specificity() grades the exact comparison the outage turned on', () => {
  assert(cmpSpec(specificity('#study-host'), specificity('.tab-panel[hidden]')) > 0, 'an ID must outrank a class+attribute — that is the bug')
  assert(cmpSpec(specificity('#study-host[hidden]'), specificity('#study-host')) > 0, 'the hotfix must outrank the rule it corrects')
  assert(specStr(specificity('#study-host')) === '1-0-0', `#study-host should be 1-0-0, got ${specStr(specificity('#study-host'))}`)
  assert(specStr(specificity('.tab-panel[hidden]')) === '0-2-0', `.tab-panel[hidden] should be 0-2-0, got ${specStr(specificity('.tab-panel[hidden]'))}`)
  assert(specStr(specificity('#study-host canvas')) === '1-0-1', `#study-host canvas should be 1-0-1, got ${specStr(specificity('#study-host canvas'))}`)
  return '#study-host 1-0-0 > .tab-panel[hidden] 0-2-0; #study-host[hidden] 1-1-0 wins'
})

test('subjectCompound picks the element a rule actually styles, not an ancestor in its path', () => {
  assert(subjectCompound('#study-host canvas') === 'canvas', 'a descendant rule styles the descendant')
  assert(subjectCompound('#study-host') === '#study-host', '')
  assert(subjectCompound('.study-rail > .study-learn-btn') === '.study-learn-btn', 'child combinator')
  // The consequence: `#study-host canvas { display: block }` must NOT be
  // reported as a panel offender, or the gate cries wolf on every tab.
  assert(!subjectCompound('#study-host canvas').includes('#study-host'), 'a canvas rule is not a panel rule')
})

test('the scan really reads every stylesheet in the tree, not a hand-kept list', () => {
  assert(stylesheets.length >= 5, `expected the app's stylesheets, found ${stylesheets.length}`)
  assert(stylesheets.some((f) => f.endsWith('styles.css')), 'styles.css is not being scanned')
  assert(rules.length > 200, `expected the full ruleset, parsed ${rules.length}`)
  return `${stylesheets.length} stylesheets, ${rules.length} rules`
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.outcome === 'pass').length
const failed = results.filter((r) => r.outcome === 'fail').length
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`)
if (failed > 0) process.exitCode = 1
