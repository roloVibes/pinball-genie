#!/usr/bin/env node
// PinballGenieWeb — scripts/prepare-vendor.mjs
//
// Vendors the Tesseract.js runtime assets identify/scan.ts needs so OCR runs
// fully self-hosted at runtime (the app sits behind auth; zero CDN requests
// — see CONTRACTS.md "Rules"). By default tesseract.js fetches its worker
// script, wasm core, and language data from jsdelivr CDN URLs baked into the
// package (see node_modules/tesseract.js/src/worker/browser/defaultOptions.js
// and worker-script/browser/getCore.js) — this script copies the equivalent
// local files into app/public/vendor/tesseract/ so scan.ts can point
// workerPath/corePath/langPath at same-origin paths instead.
//
// Copies:
//   - tesseract.js's worker script (dist/worker.min.js)
//   - tesseract.js-core's LSTM-only wasm builds (both the plain and SIMD
//     variant — getCore.js feature-detects SIMD at runtime and picks
//     between them; the app always creates its worker with the default
//     OEM.LSTM_ONLY, see identify/scan.ts, so the non-LSTM legacy builds
//     are never requested and aren't vendored)
//   - both packages' Apache-2.0 license text, for redistribution
// Fetches (skipped if already present):
//   - eng.traineddata, gzipped locally, from the official
//     tesseract-ocr/tessdata_fast GitHub repo. tesseract.js's browser loader
//     defaults to fetching `<langPath>/eng.traineddata.gz` (gzip: true) —
//     tessdata_fast ships the raw .traineddata (its GitHub "releases" carry
//     no binary assets, just source tags), so this script downloads the raw
//     file and gzips it with node:zlib (standard gzip — the same format
//     tesseract.js's bundled `zlibjs` gunzip decodes, and what the official
//     @tesseract.js-data CDN artifacts are).
//
// Run: node scripts/prepare-vendor.mjs   (paths below resolve relative to
// this file, so the cwd it's invoked from doesn't matter).

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')
const nodeModules = path.join(appDir, 'node_modules')
const vendorDir = path.join(appDir, 'public', 'vendor', 'tesseract')

const TESSDATA_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata'

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function copy(relDest, srcFile) {
  if (!existsSync(srcFile)) {
    throw new Error(`missing source file (npm install ran?): ${srcFile}`)
  }
  const dest = path.join(vendorDir, relDest)
  copyFileSync(srcFile, dest)
  const size = statSync(dest).size
  console.log(`  copied   ${relDest.padEnd(34)} ${fmtBytes(size)}`)
  return { relDest, size }
}

async function main() {
  mkdirSync(vendorDir, { recursive: true })
  console.log(`Vendoring Tesseract assets into ${path.relative(appDir, vendorDir)}/`)

  const report = []

  // 1) Worker script — classic script, loaded via `new Worker(workerPath)`
  //    (see node_modules/tesseract.js/src/worker/browser/spawnWorker.js).
  report.push(copy('worker.min.js', path.join(nodeModules, 'tesseract.js/dist/worker.min.js')))

  // 2) tesseract.js-core — LSTM-only builds (plain + SIMD variant) only.
  const corePkg = path.join(nodeModules, 'tesseract.js-core')
  for (const variant of ['tesseract-core-lstm', 'tesseract-core-simd-lstm']) {
    for (const ext of ['.js', '.wasm', '.wasm.js']) {
      report.push(copy(`${variant}${ext}`, path.join(corePkg, `${variant}${ext}`)))
    }
  }

  // 3) Third-party license text for the vendored binaries (both Apache-2.0).
  report.push(copy('LICENSE.tesseract.js.md', path.join(nodeModules, 'tesseract.js/LICENSE.md')))
  report.push(copy('LICENSE.tesseract.js-core.txt', path.join(corePkg, 'LICENSE')))

  // 4) English fast-model traineddata, gzipped.
  const gzDest = path.join(vendorDir, 'eng.traineddata.gz')
  if (existsSync(gzDest)) {
    const size = statSync(gzDest).size
    console.log(`  skip     eng.traineddata.gz (already present, ${fmtBytes(size)})`)
    report.push({ relDest: 'eng.traineddata.gz', size })
  } else {
    console.log(`  fetch    ${TESSDATA_URL}`)
    const res = await fetch(TESSDATA_URL)
    if (!res.ok) {
      throw new Error(`tessdata_fast fetch failed: HTTP ${res.status} ${res.statusText}`)
    }
    const raw = Buffer.from(await res.arrayBuffer())
    const gz = gzipSync(raw, { level: 9 })
    await writeFile(gzDest, gz)
    console.log(`  wrote    eng.traineddata.gz               ${fmtBytes(gz.length)}  (from ${fmtBytes(raw.length)} raw)`)
    report.push({ relDest: 'eng.traineddata.gz', size: gz.length })
  }

  console.log(`\nDone — ${report.length} files in public/vendor/tesseract/:`)
  for (const { relDest, size } of report) {
    console.log(`  ${relDest.padEnd(34)} ${fmtBytes(size)}`)
  }
}

main().catch((err) => {
  console.error('[prepare-vendor] failed:', err)
  process.exitCode = 1
})
