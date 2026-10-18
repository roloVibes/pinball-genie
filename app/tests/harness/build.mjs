#!/usr/bin/env node
// app/tests/harness/build.mjs — bundles the SUITE 4 browser harness.
//
// Run (from repo root, path has a space — quote it):
//   node "app/tests/harness/build.mjs" <outDir>
// Normally you don't run this by hand: ../arview-statemachine.e2e.py invokes
// it into a temp dir before launching Playwright.
//
// What it does:
//   - esbuild-bundles tests/harness/arview-entry.ts (which imports the REAL
//     src/ar/arview.ts -> calibrate.ts / camera.ts / homography.ts /
//     overlay / ui) into one IIFE, src/ NEVER modified.
//   - Substitutes ONLY `./tracker` with tests/harness/tracker.stub.ts (see
//     that file's header: the real one needs a 10 MB OpenCV worker, and its
//     timing is the variable under test).
//   - CSS: `import './x.css'` statements are bundled by esbuild into
//     harness.css, so the REAL ar/arview.css + ar/calibrate.css rules
//     (button sizes, HUD pointer-events, stacking) are what the browser
//     applies — this suite measures them.

import { build } from 'esbuild'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(process.argv[2] ?? resolve(__dirname, '.out'))
await mkdir(outDir, { recursive: true })

/** Redirect ar/arview.ts's `import { createTracker } from './tracker'` to the
 *  stub, without touching any file under src/. */
const trackerStubPlugin = {
  name: 'tracker-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\/tracker$/ }, (args) => {
      if (!args.importer.replace(/\\/g, '/').endsWith('/src/ar/arview.ts')) return null
      return { path: resolve(__dirname, 'tracker.stub.ts') }
    })
  },
}

await build({
  entryPoints: [resolve(__dirname, 'arview-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  outfile: resolve(outDir, 'harness.js'),
  define: { __BUILD_STAMP__: JSON.stringify('suite4-harness') },
  plugins: [trackerStubPlugin],
  logLevel: 'warning',
})

await writeFile(
  resolve(outDir, 'index.html'),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUITE 4 harness — arview state machine</title>
<link rel="stylesheet" href="./harness.css">
<style>
  html,body { margin:0; height:100%; background:#05060a; }
  /* app/src/styles.css is not part of this bundle; #ar-host mirrors the real
     app's AR panel box (full-bleed inside the viewport). */
  #ar-host { position:fixed; inset:0; }
</style>
</head><body><div id="ar-host"></div><script src="./harness.js"></script></body></html>
`,
)

console.log(outDir)
