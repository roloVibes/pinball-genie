#!/usr/bin/env node
// app/tests/chunk-guard.test.mjs — every dynamic import() in the shipped source
// must go through loadChunk().
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/chunk-guard.test.mjs"
//
// WHY THIS SUITE EXISTS. Vite splits the app into content-hashed chunks and
// deploy-prod.sh deletes the whole `assets/` directory before uploading the new
// build (step (b)). A visitor holding the app open across a deploy is still
// running the previous index-<hash>.js, which asks for chunk filenames that no
// longer exist. Every lazy call site used to be `void import('...').then(...)`
// with no rejection handler, so that 404 was completely silent: the Map,
// Achievements and Manage-account buttons simply did nothing, which reads as
// "the app is broken" and is impossible for a user to report usefully. That is
// how the Manage-account bug reached rolo's phone (2026-07-31). ui/chunkError.ts
// exists to make the failure visible and offer the only real fix (a reload).
//
// The fix was applied to all five call sites — but nothing stops the SIXTH from
// being written the old way. `tsc` is happy with a bare import(), the build is
// happy, and the regression only shows up as a dead button on somebody's phone
// after the next deploy. So this suite is a tripwire: it keeps the fixed state
// fixed. Nothing here re-tests loadChunk's behaviour, only its coverage.
//
// HOW AN OCCURRENCE IS JUDGED. Three steps, all on the real source text:
//
//   1. Comments, string bodies and regex literals are blanked out (offsets
//      preserved, and each blanked offset remembers WHICH state blanked it) so
//      that prose ABOUT dynamic imports — this repo has plenty, including in
//      app.ts and chunkError.ts itself — is never mistaken for a call site.
//      Template interpolations `${ ... }` are the exception: they are real code
//      and stay visible.
//   2. For each surviving `import(`, walk BACKWARD over the code counting
//      bracket pairs until an unmatched opener appears. If it is `(`, the
//      identifier in front of it is the enclosing call; anything else (`{`, `[`,
//      or running off the top) means the import is not an argument to a call at
//      all. That enclosing call must be `loadChunk`.
//   3. THE CROSS-CHECK (see below) re-reads the RAW source and proves that no
//      import( token went missing between the two.
//
// Walking the brackets rather than eyeballing an N-line window matters: a bare
// `void import('./x')` written on the line AFTER a real loadChunk(...) call sits
// inside any window you would draw and would pass. The bracket walk asks the
// question that actually matters — "whose argument is this?" — and section 3
// proves it says no to exactly that case.
//
// WHY THE BLANKING PASS IS A REAL TOKENIZER. A cheaper scanner that only knows
// quotes and comments desyncs on constructs this codebase contains, and desyncs
// SILENTLY — if the stray quotes happen to come in pairs, an end-state check
// still reads clean while a whole region of code has been swallowed as "string",
// taking any bare import() in it out of sight. Measured on this tree before the
// rework: a `/[`]/` regex hid everything up to the next backtick, and 118
// template interpolations across 16 files were being read as string. So regex
// literals, nested templates and interpolations are all parsed properly. There
// is no JSX in this project, so none is handled.
//
// WHY THE CROSS-CHECK EXISTS ANYWAY (2026-08-14 review). No hand-written
// tokenizer is provably right, and the failure that matters is the SILENT one:
// a misjudged `/` swallows a region, the import( inside it disappears, and this
// suite goes green on a codebase that just regressed. Step 3 closes that off
// structurally rather than by adding more tokenizer cases. It scans the RAW
// source for import( tokens and demands every one be accounted for:
//
//   (a) the blanked scan found it (a real call site, or a `typeof import(`), or
//   (b) it sits in a region blanked as a COMMENT or a single/double-quoted
//       STRING — the two states where prose about imports legitimately lives.
//
// A token blanked by TEMPLATE or REGEX state, or unaccounted for by any of the
// above, FAILS the suite and asks a human to look. That is deliberately noisy:
// a regex whose body reads `import(` is exactly the case where the tokenizer's
// judgement should not be trusted quietly. The property this buys is the one
// worth having — a tokenizer bug can make this suite LOUD, never blind.
//
// Pattern follows pathless-goals.test.mjs (asserts source-level wiring by
// reading the real src/ tree).

import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')

// src/ar, src/identify and src/fx are the "unimported" directories: nothing in
// the shipped bundle reaches them (grep for `from './ar/` etc. — no hits), they
// are kept on disk purely so `tsc --noEmit` keeps covering them, and they are
// documented that way in app.ts's header and VENDOR-REMOVED.md. ar/arview.ts
// still holds two of the old bare `void import(...)` call sites; they ship to
// nobody, so they are out of scope here rather than rewritten.
const DEAD_DIRS = new Set(['ar', 'identify', 'fx'])

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
// Detector
// ---------------------------------------------------------------------------

// Which state blanked a given offset. 0 = never blanked (real code).
const ST = { CODE: 0, LINE: 1, BLOCK: 2, SQ: 3, DQ: 4, TPL: 5, REGEX: 6 }
const ST_NAME = ['code', 'line comment', 'block comment', "'string'", '"string"', 'template', 'regex']

// A `/` starts a regex literal (rather than dividing) when the last significant
// code character before it can only be followed by an expression. `>` covers
// arrow bodies (`() => /re/.test(x)`); the arithmetic and bitwise operators are
// here because misreading a regex as division is the DANGEROUS direction (the
// regex body then gets scanned as code and can flip the string state), whereas
// misreading a division as a regex only blanks the rest of a line — and the
// cross-check turns any import( lost that way into a loud failure.
//
// `)` and `]` are DELIBERATELY absent: after them `/` is division far more often
// than not (`(a + b) / 2`, `arr[i] / 2`). The one case that costs us is a
// brace-less `if (cond) /re/.test(x)`, which is lexically undecidable without a
// real parser; this repo braces its ifs, and if one ever appears the cross-check
// makes the resulting swallow loud rather than silent.
const REGEX_MAY_FOLLOW = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '}', '>',
  '+', '-', '*', '%', '^', '~', '<',
])
const REGEX_MAY_FOLLOW_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'void', 'delete', 'await', 'yield',
])

/**
 * The identifier ending at `idx` (exclusive), skipping whitespace first, plus
 * the offset it starts at. Takes a string or a char array, so the blanking pass
 * can ask about the output it is still building without joining it every time.
 */
function precedingWord(code, idx) {
  let j = idx - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  const end = j + 1
  while (j >= 0 && /[A-Za-z_$]/.test(code[j])) j--
  let word = ''
  for (let k = j + 1; k < end; k++) word += code[k]
  return { word, start: j + 1 }
}

/** The nearest non-whitespace character before `idx`, or '' at the start. */
function precedingChar(code, idx) {
  let j = idx - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  return j >= 0 ? code[j] : ''
}

/**
 * Blanks out comments, string bodies and regex literals, replacing them with
 * spaces so every surviving character keeps its original offset (line numbers
 * stay honest). Template interpolations are left as code.
 *
 * Returns the blanked source, a per-offset record of which state blanked each
 * character (ST.*), and the state the scan ENDED in — anything other than
 * 'code' means an unterminated construct confused the scan.
 */
function blankCommentsAndStrings(src) {
  const out = src.split('')
  const states = new Uint8Array(src.length)
  const blank = (n, st) => {
    if (n >= out.length) return
    states[n] = st
    if (out[n] !== '\n') out[n] = ' '
  }
  // One frame per open `${ ... }`, holding the brace depth inside it, so the
  // `}` that closes the interpolation is told apart from `}`s of objects and
  // blocks written within it.
  const interpolations = []
  let state = 'code'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]

    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line'
        blank(i, ST.LINE); blank(i + 1, ST.LINE)
        i += 2
        continue
      }
      if (c === '/' && d === '*') {
        state = 'block'
        blank(i, ST.BLOCK); blank(i + 1, ST.BLOCK)
        i += 2
        continue
      }
      if (c === '/') {
        // Regex or division? Decide from what precedes it in the already-blanked
        // output, so comments are transparent and closing quotes are visible.
        const prev = precedingChar(out, i)
        const { word, start } = precedingWord(out, i)
        // A keyword used as a PROPERTY name is not a regex position:
        // `foo.return / 2` divides. Only a free-standing keyword counts.
        const keywordIsFree = word !== '' && precedingChar(out, start) !== '.'
        const isRegex = prev === '' ||
          REGEX_MAY_FOLLOW.has(prev) ||
          (keywordIsFree && REGEX_MAY_FOLLOW_KEYWORD.has(word))
        if (isRegex) {
          state = 'regex'
          blank(i, ST.REGEX)
          i++
          continue
        }
        i++
        continue
      }
      if (c === "'") { state = 'sq'; i++; continue }
      if (c === '"') { state = 'dq'; i++; continue }
      if (c === '`') { state = 'tpl'; i++; continue }
      if (c === '{') {
        if (interpolations.length > 0) interpolations[interpolations.length - 1]++
        i++
        continue
      }
      if (c === '}') {
        if (interpolations.length > 0) {
          if (interpolations[interpolations.length - 1] === 0) {
            interpolations.pop()
            state = 'tpl'
            i++
            continue
          }
          interpolations[interpolations.length - 1]--
        }
        i++
        continue
      }
      i++
      continue
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; i++; continue }
      blank(i, ST.LINE)
      i++
      continue
    }

    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code'
        blank(i, ST.BLOCK); blank(i + 1, ST.BLOCK)
        i += 2
        continue
      }
      blank(i, ST.BLOCK)
      i++
      continue
    }

    if (state === 'regex') {
      if (c === '\\') { blank(i, ST.REGEX); blank(i + 1, ST.REGEX); i += 2; continue }
      if (c === '[') { state = 'regexClass'; blank(i, ST.REGEX); i++; continue }
      if (c === '/') { state = 'code'; blank(i, ST.REGEX); i++; continue }
      // A regex literal cannot span a line; treating a newline as the end stops
      // a misjudged division from swallowing the rest of the file.
      if (c === '\n') { state = 'code'; i++; continue }
      blank(i, ST.REGEX)
      i++
      continue
    }

    if (state === 'regexClass') {
      if (c === '\\') { blank(i, ST.REGEX); blank(i + 1, ST.REGEX); i += 2; continue }
      if (c === ']') { state = 'regex'; blank(i, ST.REGEX); i++; continue }
      if (c === '\n') { state = 'code'; i++; continue }
      blank(i, ST.REGEX)
      i++
      continue
    }

    if (state === 'tpl') {
      if (c === '\\') { blank(i, ST.TPL); blank(i + 1, ST.TPL); i += 2; continue }
      if (c === '`') { state = 'code'; i++; continue }
      if (c === '$' && d === '{') {
        // The interpolation body is code: leave `${` visible and stop blanking.
        interpolations.push(0)
        state = 'code'
        i += 2
        continue
      }
      blank(i, ST.TPL)
      i++
      continue
    }

    // 'sq' / 'dq': the quote characters stay, the body is blanked (so `import(`
    // written inside a string is never counted).
    const strState = state === 'sq' ? ST.SQ : ST.DQ
    if (c === '\\') { blank(i, strState); blank(i + 1, strState); i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) {
      state = 'code'
      i++
      continue
    }
    if (c === '\n') { state = 'code'; i++; continue } // unterminated — bail loudly
    blank(i, strState)
    i++
  }

  let endState = state
  if (endState === 'code' && interpolations.length > 0) endState = 'template-interpolation'
  return { code: out.join(''), states, endState }
}

/**
 * Name of the call whose argument list directly encloses `idx`, or null when
 * the position is not inside one (a statement, a block, an array literal).
 *
 * Known and accepted: `x.loadChunk(` resolves to "x.loadChunk" and
 * `loadChunk?.(` to "." — neither equals 'loadChunk', so both would FAIL. That
 * is the safe direction (loud, not silent) and this repo imports { loadChunk }
 * directly, so neither form exists. Widen this only alongside a test.
 */
function enclosingCall(code, idx) {
  let depth = 0
  for (let i = idx - 1; i >= 0; i--) {
    const c = code[i]
    if (c === ')' || c === ']' || c === '}') {
      depth++
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) {
        depth--
        continue
      }
      if (c !== '(') return null
      let j = i - 1
      while (j >= 0 && /\s/.test(code[j])) j--
      const end = j + 1
      while (j >= 0 && /[A-Za-z0-9_$.]/.test(code[j])) j--
      return code.slice(j + 1, end) || null
    }
  }
  return null
}

const lineOf = (src, offset) => src.slice(0, offset).split('\n').length

/**
 * Every RUNTIME dynamic import in `src`, with its line, offset and enclosing
 * call, plus the offsets that were deliberately passed over.
 *
 * `typeof import('./x')` is skipped: a type-level query erases at compile time
 * and fetches nothing, so loadChunk has nothing to wrap. `obj.import('./x')` is
 * skipped too — that is a method call on some object, not the import operator.
 * The tree has neither today; the exemptions exist so the gate cannot cry wolf.
 */
function findDynamicImports(src) {
  const { code, states, endState } = blankCommentsAndStrings(src)
  const found = []
  const exempt = []
  const re = /\bimport\s*\(/g
  let m
  while ((m = re.exec(code))) {
    if (precedingChar(code, m.index) === '.') continue // obj.import(...) — a method
    if (precedingWord(code, m.index).word === 'typeof') {
      exempt.push(m.index)
      continue
    }
    found.push({
      offset: m.index,
      line: lineOf(code, m.index),
      via: enclosingCall(code, m.index),
    })
  }
  return { found, exempt, states, endState }
}

// A raw import( token: the same operator, matched on the ORIGINAL source with no
// tokenizing at all. The lookbehind drops method calls (`obj.import(`) and
// identifiers that merely end in "import".
//
// INVARIANT: RAW_IMPORT must detect at least everything the blanked-side matcher
// can. Comments blank to spaces over there, so `import/* x */(` reads as
// `import       (` and matches — the raw side therefore has to skip comments
// explicitly, or the belt would be narrower than the thing it is checking.
const RAW_IMPORT = /(?<![.\w$])import(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/g

/**
 * Proves the tokenizer did not lose an import( token. Returns one complaint per
 * raw token that is neither a scan result nor sitting in a comment/string, plus
 * a tally of where every raw token landed (for evidence, not for judging).
 */
function crossCheck(src, scan) {
  // The 'scanned as code' bucket trusts findDynamicImports' offsets: a scanner
  // FALSE POSITIVE is counted here rather than complained about. That fails
  // toward detection — assertion 3 still judges whatever the scan found — and
  // never toward hiding a token.
  const accounted = new Set([...scan.found.map((f) => f.offset), ...scan.exempt])
  const complaints = []
  const tally = {}
  RAW_IMPORT.lastIndex = 0
  let m
  while ((m = RAW_IMPORT.exec(src))) {
    const st = scan.states[m.index]
    const bucket = accounted.has(m.index) ? 'scanned as code' : ST_NAME[st]
    tally[bucket] = (tally[bucket] || 0) + 1
    if (accounted.has(m.index)) continue
    if (st === ST.LINE || st === ST.BLOCK || st === ST.SQ || st === ST.DQ) continue
    complaints.push({ line: lineOf(src, m.index), state: ST_NAME[st] })
  }
  return { complaints, tally }
}

// ---------------------------------------------------------------------------
// Collect the shipped source
// ---------------------------------------------------------------------------
function walk(dir, rel = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const relPath = rel ? `${rel}/${name}` : name
    if (statSync(full).isDirectory()) {
      if (!rel && DEAD_DIRS.has(name)) continue
      out.push(...walk(full, relPath))
    } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith('.d.ts')) {
      // .d.ts files are declarations only — every import() in one is type-level.
      out.push({ full, rel: relPath })
    }
  }
  return out
}

const files = walk(srcDir).map((f) => ({ ...f, src: readFileSync(f.full, 'utf8') }))
const scanned = files.map((f) => {
  const scan = findDynamicImports(f.src)
  return { ...f, ...scan, ...crossCheck(f.src, scan) }
})
const withImports = scanned.filter((f) => f.found.length > 0)
const allImports = withImports.flatMap((f) => f.found.map((o) => ({ ...o, file: f.rel })))

section('1. The detector is reading the source correctly')

test('every scanned file parses cleanly (no unterminated comment, quote or template)', () => {
  const confused = scanned.filter((f) => f.endState !== 'code')
  check(confused.length === 0,
    `the source scan ended in state '${confused[0] && confused[0].endState}' in ` +
    `${confused.map((f) => f.rel).join(', ')} — every verdict below is unreliable until that is understood`)
  return `${scanned.length} files under src/ (excluding ${[...DEAD_DIRS].map((d) => `${d}/`).join(' ')} and *.d.ts)`
})

test('cross-check: no import( token in the raw source went missing', () => {
  const bad = scanned.filter((f) => f.complaints.length > 0)
  check(bad.length === 0,
    `scanner uncertainty — an import( token was hidden by template/regex blanking: ` +
    `${bad.map((f) => f.complaints.map((c) => `${f.rel}:${c.line} (blanked as ${c.state})`).join(', ')).join('; ')} ` +
    `— inspect and add a documented exemption if it is prose`)
  const tally = {}
  for (const f of scanned) for (const [k, n] of Object.entries(f.tally)) tally[k] = (tally[k] || 0) + n
  return Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')
})

test('the shipped source still lazy-loads something at all', () => {
  // A detector that finds nothing passes every assertion below for free. If the
  // app genuinely stops code-splitting, delete this suite deliberately rather
  // than letting it stand as a green check that tests nothing.
  check(allImports.length > 0,
    'no dynamic import() found anywhere under src/ — either lazy loading was removed ' +
    '(delete this suite on purpose) or the detector is broken (fix it)')
  return allImports.map((o) => `${o.file}:${o.line}`).join(', ')
})

section('2. Every dynamic import goes through a ui/chunkError.ts wrapper')

/** The two functions in ui/chunkError.ts a dynamic import may be an argument
 *  to. `prefetchChunk` was added by P6 (2026-08-14) for the Machine Library's
 *  idle-time warm-up, and widening this list is the ONLY reason it is here —
 *  so the widening carries its own proof, in the test directly below: the new
 *  wrapper must actually attach a rejection handler. Without that check this
 *  list is just a hole someone can add a name to. */
const CHUNK_WRAPPERS = ['loadChunk', 'prefetchChunk']

test('each wrapper named here really handles rejection (the widening is not a hole)', () => {
  const chunkErrorSrc = readFileSync(resolve(srcDir, 'ui/chunkError.ts'), 'utf8')
  for (const name of CHUNK_WRAPPERS) {
    const at = chunkErrorSrc.indexOf(`export function ${name}`)
    check(at !== -1, `${name} is allowed as a wrapper but is not exported from ui/chunkError.ts`)
    // The function body up to the next top-level `export function` (or EOF).
    const next = chunkErrorSrc.indexOf('\nexport function ', at + 1)
    const body = chunkErrorSrc.slice(at, next === -1 ? undefined : next)
    check(/\.catch\s*\(/.test(body),
      `${name} is allowed to wrap a dynamic import but its body has no .catch( — ` +
      `an unhandled rejection is the exact silent failure this whole suite exists to prevent`)
  }
  return `${CHUNK_WRAPPERS.length} wrappers, each with a .catch(: ${CHUNK_WRAPPERS.join(', ')}`
})

test('no bare import() — each one is an argument to loadChunk( or prefetchChunk(', () => {
  const bare = allImports.filter((o) => !CHUNK_WRAPPERS.includes(o.via))
  check(bare.length === 0,
    `${bare.map((o) => `${o.file}:${o.line} (enclosing call: ${o.via === null ? 'none' : o.via})`).join('; ')} ` +
    `— a dynamic import outside ${CHUNK_WRAPPERS.join('()/')}() has no rejection handler, so when the chunk 404s after a ` +
    `deploy the control silently does nothing. Wrap it: loadChunk(() => import('./x'), 'the thing', (mod) => ...). ` +
    `See ui/chunkError.ts. If this is a TYPE-position import (something like \`let x: import('./y').Foo\`) it ` +
    `fetches nothing at runtime and needs no wrapper — add a documented exemption to findDynamicImports() ` +
    `alongside a snippet test, the way \`typeof import(\` is exempt, rather than skipping this gate.`)
  const byVia = CHUNK_WRAPPERS.map((w) => `${allImports.filter((o) => o.via === w).length} via ${w}`).join(', ')
  return `${allImports.length} call sites: ${byVia}`
})

test('a chunkError wrapper is statically imported by every file that lazy-loads', () => {
  const named = CHUNK_WRAPPERS.join('|')
  for (const f of withImports) {
    check(new RegExp(`import\\s*\\{[^}]*\\b(${named})\\b[^}]*\\}\\s*from\\s*['"][^'"]+['"]`).test(f.src),
      `${f.rel} calls import() but has no static named import of ${CHUNK_WRAPPERS.join(' or ')} — ` +
      `the module that handles "the network failed" must never itself be behind a network fetch`)
  }
  return withImports.map((f) => f.rel).join(', ')
})

section('3. The tripwire can actually fail')

// Each case runs the detector over a snippet in memory — no file is written and
// nothing under src/ is touched.
function scan(lines) {
  const src = lines.join('\n')
  const result = findDynamicImports(src)
  return { ...result, ...crossCheck(src, result) }
}

test('a bare import() is reported even when it sits beside a real loadChunk call', () => {
  // The adversarial case for any line-window heuristic: the bare import is one
  // line below a correct call site.
  const { found } = scan([
    "import { loadChunk } from './ui/chunkError'",
    'function open() {',
    "  loadChunk(() => import('./ui/glossary'), 'the glossary', ({ openGlossary }) => openGlossary())",
    "  void import('./ui/howto').then(({ openHowTo }) => openHowTo())",
    '}',
  ])
  check(found.length === 2, `expected 2 call sites in the snippet, found ${found.length}`)
  check(found[0].via === 'loadChunk', `expected the wrapped one to resolve to loadChunk, got ${found[0].via}`)
  check(found[1].via !== 'loadChunk',
    'the bare import on the next line resolved to loadChunk — the detector is passing everything ' +
    'and this suite is worthless')
  return `wrapped → ${found[0].via}, bare → ${found[1].via === null ? 'no enclosing call' : found[1].via}`
})

test('a regex literal containing quotes does not hide the bare import below it', () => {
  // Without regex awareness the `'` inside the character class opens a string
  // that runs until the next apostrophe — swallowing the import() entirely.
  const { found, endState, complaints } = scan([
    'const QUOTES = /[\'"]/g',
    "void import('./ui/howto').then(({ openHowTo }) => openHowTo())",
  ])
  check(endState === 'code', `scanner ended in '${endState}' — the regex desynced it`)
  check(found.length === 1, `expected the import to stay visible, found ${found.length}`)
  check(found[0].via !== 'loadChunk', 'expected the bare import to be flagged')
  check(complaints.length === 0, 'cross-check should be clean — the token was scanned as code')
})

test('a BACKTICK inside a regex does not swallow the import on the next line', () => {
  // K3's uncontained-swallow repro. `1 - /a`b/` needs the arithmetic operators
  // in REGEX_MAY_FOLLOW to be read as a regex at all; without them the backtick
  // opens a template literal that runs to the end of the file, and the import
  // below vanishes. The suite must fail for the RIGHT reason (a bare import),
  // not silently pass.
  const { found, endState, complaints } = scan([
    'const k = 1 - /a`b/.test(s)',
    "import('./chunk-evil')",
  ])
  check(endState === 'code', `scanner ended in '${endState}' — the backtick regex desynced it`)
  check(found.length === 1, `expected the import on line 2 to survive, found ${found.length}`)
  check(found[0].line === 2, `expected line 2, got line ${found[0].line}`)
  check(found[0].via !== 'loadChunk', 'expected the bare import to be flagged')
  check(complaints.length === 0, 'cross-check should be clean — the token was scanned as code')
})

test('a keyword used as a property name divides, it does not start a regex', () => {
  // `foo.return / 2` is division. Reading it as a regex would blank the rest of
  // the line — including the import after it.
  const { found, complaints } = scan([
    "const k = foo.return / 2, m = import('./ui/howto')",
  ])
  check(found.length === 1, `expected the import to survive the division, found ${found.length}`)
  check(found[0].via !== 'loadChunk', 'expected the bare import to be flagged')
  check(complaints.length === 0, 'cross-check should be clean — the token was scanned as code')
})

test('a nested template literal does not hide the bare import below it', () => {
  // Without an interpolation stack the inner backtick closes the outer template
  // and everything after it is read in the wrong state.
  const { found, endState } = scan([
    'const label = `outer ${`inner ${x}`} end`',
    "void import('./ui/howto').then(({ openHowTo }) => openHowTo())",
  ])
  check(endState === 'code', `scanner ended in '${endState}' — the nested template desynced it`)
  check(found.length === 1, `expected the import to stay visible, found ${found.length}`)
  check(found[0].via !== 'loadChunk', 'expected the bare import to be flagged')
})

test('a bare import inside a template interpolation is reported', () => {
  // `${ ... }` is code, and a dynamic import written there fetches a chunk like
  // any other — it must not be blanked away with the surrounding text.
  const { found, endState } = scan([
    'const html = `<a href="${import(\'./ui/howto\')}">x</a>`',
  ])
  check(endState === 'code', `scanner ended in '${endState}'`)
  check(found.length === 1, `expected the interpolated import to be seen, found ${found.length}`)
  check(found[0].via !== 'loadChunk', `expected it flagged, enclosing call was ${found[0].via}`)
})

test('a type-level `typeof import()` is exempt but a runtime import beside it is not', () => {
  const { found, exempt } = scan([
    "type M = typeof import('./ui/howto')",
    "void import('./ui/howto').then(({ openHowTo }) => openHowTo())",
  ])
  check(found.length === 1, `expected only the runtime import, found ${found.length}`)
  check(found[0].line === 2, `expected the runtime import on line 2, got line ${found[0].line}`)
  check(found[0].via !== 'loadChunk', 'expected the runtime import to be flagged')
  check(exempt.length === 1, `expected the typeof import to be recorded as exempt, got ${exempt.length}`)
})

test('a comment between import and ( does not hide the call site', () => {
  // `import/* x */('./y')` is a legal dynamic import. It survives because the
  // scanner matches on the BLANKED code, where the comment is already spaces —
  // so `\bimport\s*\(` sees `import           (` and assertion 3 judges it.
  const { found, complaints } = scan(["void import/* split */('./x')"])
  check(found.length === 1, `expected the comment-separated import to be found, got ${found.length}`)
  check(found[0].via !== 'loadChunk', 'expected it flagged as bare')
  check(complaints.length === 0,
    'the raw belt must match this form too — otherwise it is narrower than the matcher it checks')
  return 'scanner flags it; raw belt accounts for it'
})

test('a method named import is not a dynamic import', () => {
  const { found, complaints } = scan(["obj.import('./x')", 'const y = 1'])
  check(found.length === 0, `expected obj.import() to be ignored, found ${found.length}`)
  check(complaints.length === 0, 'a method call is not a raw import( token either — cross-check must stay clean')
})

test('a commented-out import() is not reported', () => {
  const { found, complaints } = scan(["// this was void import('./ui/howto') once", 'const x = 1'])
  check(found.length === 0, `expected the comment to be ignored, found ${found.length} call sites`)
  check(complaints.length === 0, 'a comment is an accounted-for home for the token')
})

section('4. The cross-check catches what the tokenizer cannot judge')

test('an import( token hidden inside a regex body is reported, not swallowed', () => {
  // The tokenizer is right here — `1 - /import(x)/` IS a regex, and blanking its
  // body is correct — but "the token vanished because I decided it was a regex"
  // is exactly the judgement that must not be made silently. The cross-check
  // fails and asks a human to look.
  const { found, complaints } = scan(['const k = 1 - /import(x)/.source'])
  check(found.length === 0, `the regex body must not be read as a call site, found ${found.length}`)
  check(complaints.length === 1, `expected exactly one cross-check complaint, got ${complaints.length}`)
  check(complaints[0].line === 1, `expected line 1, got ${complaints[0].line}`)
  check(complaints[0].state === 'regex', `expected the regex bucket, got ${complaints[0].state}`)
  return `flagged line ${complaints[0].line}, blanked as ${complaints[0].state}`
})

test('an import( token hidden inside a template literal is reported', () => {
  const { found, complaints } = scan(['const doc = `call import(x) to load`'])
  check(found.length === 0, `a template body is not code, found ${found.length}`)
  check(complaints.length === 1, `expected one cross-check complaint, got ${complaints.length}`)
  check(complaints[0].state === 'template', `expected the template bucket, got ${complaints[0].state}`)
})

test('a comment-separated import hidden in a template region is still reported', () => {
  // The case the raw belt used to miss entirely: `import/**/(` is invisible to a
  // whitespace-only raw pattern, so a tokenizer misjudgment that blanked it away
  // would have gone unremarked by BOTH layers. Now the belt sees it.
  const { found, complaints } = scan(['const doc = `use import/**/(x) here`'])
  check(found.length === 0, `a template body is not code, found ${found.length}`)
  check(complaints.length === 1, `expected one cross-check complaint, got ${complaints.length}`)
  check(complaints[0].state === 'template', `expected the template bucket, got ${complaints[0].state}`)
  return `flagged line ${complaints[0].line}, blanked as ${complaints[0].state}`
})

test('prose in a comment or a quoted string is an accounted-for home', () => {
  const { complaints, tally } = scan([
    "// prose: import('./a')",
    'const s = "docs say import(x)"',
    "const t = 'or import(y)'",
  ])
  check(complaints.length === 0, `expected no complaints, got ${JSON.stringify(complaints)}`)
  return Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')
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
