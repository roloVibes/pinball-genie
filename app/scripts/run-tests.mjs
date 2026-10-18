#!/usr/bin/env node
// app/scripts/run-tests.mjs — runs every suite in app/tests/*.test.mjs.
//
// This project has no test framework (vitest/jest aren't installed — see
// package.json): each suite is a self-contained ESM script that prints its own
// PASS/FAIL lines and exits non-zero when something failed. That works by hand
// and not at all as a gate, because nothing ran them together — deploy-prod.sh
// built and shipped without a single suite executing. Its (a0) step calls this.
//
// THE RULE HERE: a suite's verdict is spawnSync's `status` — the child's DIRECT
// exit code — and nothing else. No shell, no pipeline, no grepping the output.
// `runner | grep` reports grep's exit status, which is how a failing check once
// rode along on a green deploy (2026-08-02). Passing an argv array with the
// default shell:false also means this repo's path (it contains a space) can
// never be word-split.
//
// Usage: npm test                 (from app/)
//        node scripts/run-tests.mjs

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const testsDir = resolve(__dirname, '../tests')
const repoRoot = resolve(__dirname, '../..')
const SUITE_TIMEOUT_MS = 120_000

const suites = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

if (suites.length === 0) {
  console.log(`FATAL: no *.test.mjs suites found in ${testsDir}`)
  console.log('A test gate that finds nothing to run must fail, not report success.')
  process.exit(1)
}

console.log(`Running ${suites.length} suites from app/tests/\n`)

const nameWidth = Math.max(...suites.map((s) => s.length))
const failures = []
const started = Date.now()

for (const suite of suites) {
  const file = resolve(testsDir, suite)
  const t0 = Date.now()
  // cwd is pinned to the repo root — every suite resolves its own paths from
  // import.meta.url, so this is only so `npm test` and a hand-run are identical.
  const res = spawnSync(process.execPath, [file], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // A wedged suite must FAIL, not hang deploy-prod.sh's (a0) step forever
    // waiting on it. ETIMEDOUT arrives as res.error, which reads as FAIL below.
    // The slowest suite today is ~2s, so this only ever fires on a real hang.
    timeout: SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  const ms = Date.now() - t0
  const output = `${res.stdout || ''}${res.stderr || ''}`

  let reason = ''
  if (res.error && res.error.code === 'ETIMEDOUT') reason = `hung — killed after ${SUITE_TIMEOUT_MS / 1000}s`
  else if (res.error) reason = `could not run: ${res.error.message}`
  else if (res.status === null) reason = `killed by ${res.signal || 'a signal'} (no exit code)`
  else if (res.status !== 0) reason = `exit ${res.status}`

  const label = suite.padEnd(nameWidth)
  if (reason) {
    failures.push({ suite, reason, output })
    console.log(`  FAIL  ${label}  ${String(ms).padStart(6)} ms  (${reason})`)
  } else {
    console.log(`  PASS  ${label}  ${String(ms).padStart(6)} ms`)
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
const passed = suites.length - failures.length

if (failures.length > 0) {
  for (const f of failures) {
    console.log(`\n${'='.repeat(75)}\nFAILED: ${f.suite} — ${f.reason}\n${'='.repeat(75)}`)
    console.log(f.output.trimEnd() || '(the suite produced no output)')
  }
  console.log(`\nFAILED SUITES:`)
  for (const f of failures) console.log(`  - ${f.suite} (${f.reason})`)
}

console.log(`\n${passed} passed, ${failures.length} failed (${suites.length} suites, ${seconds}s)`)
if (failures.length > 0) process.exit(1)
