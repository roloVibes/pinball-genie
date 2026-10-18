#!/usr/bin/env node
// scripts/selftest.mjs — runs ar/homography.ts's homographySelfTest() and
// identify/matcher.ts's selfTest() outside a browser. This project has no
// test runner wired in (vitest/tsx aren't installed — see README/package.json);
// esbuild IS already a transitive vite dependency, so this bundles both pure
// (no-DOM-dependency) modules' self-tests into a temp ESM file via esbuild's
// Node API and runs it, exiting non-zero on any failure so it's CI-usable.
//
// Usage: node scripts/selftest.mjs

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')

const entry = `
import { homographySelfTest } from ${JSON.stringify(resolve(srcDir, 'ar/homography.ts'))}
import { selfTest } from ${JSON.stringify(resolve(srcDir, 'identify/matcher.ts'))}

const homographyOk = homographySelfTest()
const matcher = selfTest()

console.log(JSON.stringify(
  {
    homographySelfTest: homographyOk ? 'PASS' : 'FAIL',
    matcherSelfTest: { passed: matcher.passed, failed: matcher.failedLabels.length, failedLabels: matcher.failedLabels },
  },
  null,
  2,
))

if (!homographyOk || matcher.failedLabels.length > 0) {
  process.exitCode = 1
}
`

const tmpDir = await mkdtemp(resolve(tmpdir(), 'pg-selftest-'))
const outfile = resolve(tmpDir, 'out.mjs')
try {
  await build({
    stdin: { contents: entry, resolveDir: srcDir, loader: 'ts', sourcefile: 'selftest-entry.ts' },
    bundle: true,
    write: true,
    outfile,
    format: 'esm',
    platform: 'node',
    target: 'node18',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(tmpDir, { recursive: true, force: true })
}
