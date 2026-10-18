#!/usr/bin/env node
// app/tests/calibrate.harness.mjs — builds the Playwright test harness for
// SUITE 2 (deep DOM/interaction tests of the REAL ar/calibrate.ts).
//
// What it does:
//   1. esbuild-bundles the ACTUAL src/ar/calibrate.ts (no mocks, no source
//      edits) to app/tests/.build/calibrate.bundle.js as an IIFE exposing
//      `window.PGCal` ({ createCalibrationUI, renderCornerOrderDiagram }).
//      calibrate.ts's `import './calibrate.css'` is handled by esbuild's
//      built-in `css` loader, which — because the outfile is .js — writes a
//      SEPARATE companion stylesheet at app/tests/.build/calibrate.bundle.css
//      (esbuild does this automatically for any CSS pulled in by a JS/TS
//      entry point when bundling to a file; there is no need for `external:`
//      or a custom loader beyond `{'.css': 'css'}`).
//   2. Writes app/tests/.build/index.html, which links that stylesheet, loads
//      the bundle, sizes a #host element to exactly 390x654 (no scrollbars,
//      so `getBoundingClientRect()` of the stage is `{left:0, top:0, width:
//      390, height:654}` and mouse/touch viewport coordinates equal
//      stage-local coordinates — simplifies every coordinate assertion in
//      calibrate.e2e.py), and mounts `PGCal.createCalibrationUI` against a
//      MOCK CameraFeed that satisfies ar/camera.ts's real `CameraFeed`
//      interface structurally (calibrate.ts only imports that interface as a
//      TYPE — `import type { CameraFeed, CameraState } from './camera'` — so
//      camera.ts's actual implementation is never pulled into the bundle;
//      confirmed by inspecting calibrate.ts's imports and by grepping the
//      built bundle for camera.ts-only strings, see below).
//   3. Self-checks its own output (non-empty bundle containing
//      `createCalibrationUI`, non-empty CSS containing a known selector) so a
//      broken build fails loudly here rather than silently in Playwright.
//
// The mock CameraFeed is exposed on the page as `window.__mockFeed` with:
//   - `.setState(state, err?)`  — fires calibrate.ts's onStateChange
//     listener with 'live' | 'suspended' | 'stopped' | 'error' (+ optional
//     Error for 'error', matching camera.ts's real error-name-driven copy).
//   - `.getState()`             — last state pushed.
//   - `.setVideoSize(w, h)`     — controls the stub <video>'s videoWidth/
//     videoHeight (via defineProperty, since these are normally read-only)
//     for completeness against the CameraFeed contract; calibrate.ts never
//     calls grabFrame() (only ar/arview.ts does), but it DOES read
//     feed.video.videoWidth directly (R3/A4 fix, calibrate.ts ~line 544's
//     renderManualHud Accept-gate: `feed.video.videoWidth === 0` disables
//     Accept with "Camera still starting — one moment" until a real
//     'loadedmetadata' event on this stub's <video> re-renders it — see
//     calibrate.e2e.py's test_accept_disabled_when_videoWidth_zero) — so
//     this control is load-bearing, not just completeness against the
//     CameraFeed contract.
//   - `.startCallCount`         — increments each time calibrate.ts calls
//     `feed.start()` (it does so once, unconditionally, on mount).
// `window.__calibrations` accumulates every `Calibration` the mounted UI's
// `onCalibrated` callback fires, in order.
// `window.__mountFresh()` destroys the current mount (if any) and creates a
// brand new one against a brand new mock feed — used by calibrate.e2e.py to
// get a clean slate without a full page reload where a test wants to keep
// other page state.
// `window.__onCalibratedShouldThrow` (bool) — when true, the onCalibrated
// callback throws synchronously instead of recording, letting the e2e test
// prove candidate defect #1's calibrate.ts-side half (see that file for the
// full analysis): calibrate.ts calls its own render() — committing to the
// "Locked on" UI — BEFORE invoking onCalibrated, and does not catch
// anything onCalibrated throws.
//
// Run:
//   cd app && node tests/calibrate.harness.mjs
//
// Re-run this before every calibrate.e2e.py run (or let that script invoke
// it itself — it does, at the top of main()).

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const srcDir = resolve(appDir, 'src')
const entry = resolve(srcDir, 'ar/calibrate.ts')
const outDir = resolve(__dirname, '.build')
const outJs = resolve(outDir, 'calibrate.bundle.js')
const outCss = resolve(outDir, 'calibrate.bundle.css')
const outHtml = resolve(outDir, 'index.html')

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: true,
    outfile: outJs,
    format: 'iife',
    globalName: 'PGCal',
    platform: 'browser',
    target: 'es2020',
    loader: { '.css': 'css' },
    logLevel: 'info',
    metafile: true,
  })

  // ---- Self-check: bundle actually produced what we expect ----
  const jsStat = await stat(outJs).catch(() => null)
  if (!jsStat || jsStat.size === 0) {
    throw new Error(`calibrate.harness.mjs: expected non-empty ${outJs}, esbuild did not write it`)
  }
  const jsSrc = await readFile(outJs, 'utf8')
  if (!jsSrc.includes('createCalibrationUI')) {
    throw new Error('calibrate.harness.mjs: bundle.js does not contain createCalibrationUI — build produced the wrong thing')
  }
  if (!jsSrc.includes('renderCornerOrderDiagram')) {
    throw new Error('calibrate.harness.mjs: bundle.js is missing renderCornerOrderDiagram (exported alongside createCalibrationUI in calibrate.ts)')
  }
  // Confirm calibrate.ts's `import type { CameraFeed } from './camera'` did
  // NOT drag camera.ts's runtime implementation into the bundle (it should
  // not — it's a type-only import — but this is the kind of thing that
  // silently regresses if someone changes it to a value import later).
  if (jsSrc.includes('facingMode') || jsSrc.includes('getUserMedia')) {
    throw new Error(
      'calibrate.harness.mjs: bundle.js contains camera.ts runtime strings (facingMode/getUserMedia) — ' +
        "the CameraFeed import in calibrate.ts may no longer be type-only; the mock feed test setup assumption is broken",
    )
  }

  const cssStat = await stat(outCss).catch(() => null)
  if (!cssStat || cssStat.size === 0) {
    throw new Error(
      `calibrate.harness.mjs: expected non-empty ${outCss} — esbuild should emit a companion CSS file for calibrate.ts's ` +
        "'import ./calibrate.css'. If esbuild's CSS-splitting behavior has changed, switch the '.css' loader to 'text' " +
        'and inline it via a <style> tag in the harness HTML instead.',
    )
  }
  const cssSrc = await readFile(outCss, 'utf8')
  if (!cssSrc.includes('.pg-cal-hud')) {
    throw new Error('calibrate.harness.mjs: bundle.css does not contain .pg-cal-hud — wrong/stale CSS output')
  }

  // ---- Harness HTML ----
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=390, initial-scale=1" />
<title>calibrate.ts harness</title>
<link rel="stylesheet" href="./calibrate.bundle.css" />
<style>
  html, body { margin: 0; padding: 0; background: #444; }
  /* Fixed 390x654 so the stage's getBoundingClientRect() is exactly the
     Playwright viewport — every tap/drag coordinate in calibrate.e2e.py is
     therefore a stage-local coordinate with no extra translation needed. */
  #host { width: 390px; height: 654px; position: relative; overflow: hidden; }
</style>
</head>
<body>
<div id="host"></div>
<script src="./calibrate.bundle.js"></script>
<script>
(function () {
  var host = document.getElementById('host');
  window.__calibrations = [];
  window.__onCalibratedShouldThrow = false;

  function makeMockFeed() {
    var video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    var vw = 1280, vh = 720;
    Object.defineProperty(video, 'videoWidth', { get: function () { return vw; }, configurable: true });
    Object.defineProperty(video, 'videoHeight', { get: function () { return vh; }, configurable: true });

    var listeners = new Set();
    var state = 'stopped';
    var lastErr;
    var startCallCount = 0;
    var frameCanvas = null;

    var feed = {
      video: video,
      start: function () {
        startCallCount++;
        return Promise.resolve();
      },
      stop: function () {},
      onStateChange: function (fn) {
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      },
      grabFrame: function (maxDim) {
        maxDim = maxDim || 640;
        var longest = Math.max(vw, vh);
        var scale = longest > maxDim ? maxDim / longest : 1;
        var cw = Math.max(1, Math.round(vw * scale));
        var ch = Math.max(1, Math.round(vh * scale));
        if (!frameCanvas) frameCanvas = document.createElement('canvas');
        frameCanvas.width = cw;
        frameCanvas.height = ch;
        var ctx = frameCanvas.getContext('2d');
        if (ctx) { ctx.fillStyle = '#204060'; ctx.fillRect(0, 0, cw, ch); }
        return { canvas: frameCanvas, scaleToVideo: vw / cw };
      },
    };

    var control = {
      feed: feed,
      setState: function (s, err) {
        state = s;
        lastErr = err;
        listeners.forEach(function (fn) { fn(s, err); });
      },
      getState: function () { return state; },
      setVideoSize: function (w, h) { vw = w; vh = h; },
      get startCallCount() { return startCallCount; },
    };
    return control;
  }

  window.__mockFeed = makeMockFeed();
  window.__handle = null;

  function mount() {
    window.__handle = window.PGCal.createCalibrationUI(host, window.__mockFeed.feed, function (c) {
      if (window.__onCalibratedShouldThrow) {
        throw new Error('injected onCalibrated failure (calibrate.e2e.py candidate-defect-1 probe)');
      }
      window.__calibrations.push(c);
    });
  }

  // Fresh mock feed + fresh mount, no page reload needed. Also resets every
  // page-global test knob (onCalibratedShouldThrow) so tests stay isolated
  // from each other regardless of run order. Also resets #host back to its
  // default 390x654 (field-test fix: a test that called __setStageSize()
  // left the size mutated on host -- mountFresh() cleared everything else
  // but not that, so a later test's resize-jitter math silently ran against
  // whatever size the PREVIOUS test left behind instead of the documented
  // 390x654 baseline; a real, order-dependent test-isolation bug, caught
  // empirically while building the B5 resize-invalidation tests).
  window.__mountFresh = function () {
    if (window.__handle) { try { window.__handle.destroy(); } catch (e) {} }
    host.innerHTML = '';
    host.style.width = '390px';
    host.style.height = '654px';
    window.__calibrations = [];
    window.__onCalibratedShouldThrow = false;
    window.__mockFeed = makeMockFeed();
    mount();
  };

  // #host is a fixed 390x654 px box (see the <style> above) so ordinary taps
  // don't need this — it exists ONLY so calibrate.e2e.py can simulate a
  // mid-flow stage resize (iOS Safari toolbar collapse / rotation changing
  // dvh — candidate defect 3) independent of the actual browser viewport
  // size, which Playwright's set_viewport_size() cannot do here since #host
  // is not viewport-relative. Resizing #host resizes calibrate.ts's
  // .pg-cal-stage wrapper (100% of its parent), which fires calibrate.ts's
  // own internal ResizeObserver exactly as a real layout change would.
  window.__setStageSize = function (w, h) {
    host.style.width = w + 'px';
    host.style.height = h + 'px';
  };
  window.__stageRect = function () {
    var stage = document.querySelector('.pg-cal-stage');
    if (!stage) return null;
    var r = stage.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  mount();
})();
</script>
</body>
</html>
`
  await writeFile(outHtml, html, 'utf8')

  const summary = {
    outJs,
    outCss,
    outHtml,
    jsBytes: jsSrc.length,
    cssBytes: cssSrc.length,
    outputs: Object.keys(result.metafile.outputs),
  }
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
