# AR Calibration — deep analysis & test report (2026-07-28)

> **STATUS UPDATE (2026-07-28, same day — FIXES SHIPPED):** every finding below
> was fixed across a two-round pass and DEPLOYED (bundle `index-BNtPxtQw.js`).
> P0: camera state now replays to new subscribers (RECALIBRATE/machine-switch
> work); tracker RPC has timeouts + worker error handling + settled promises
> (30s init / 5s track, falls back to the STATIC path instead of hanging);
> `quadProblem()` validation blocks degenerate/bowtie/mirrored corner sets at
> Accept (red outline + reason, Accept disabled) with an onCalibrated
> try/catch+reset backstop; Accept is metadata-gated with a `loadedmetadata`
> re-render. P1: stage-resize >24px invalidates taps with a notice;
> freeze-resize overlay stretch-compensates; STATIC state gets an honest
> banner; per-frame tracker H gated at ≥8 inliers (worker floor is 12
> survivors); camera errors after first-live surface during calibrating;
> track-ended rebuilds while visible. P2: HUD actions moved LEFT off the
> corner-2 zone; taps gated on camera 'live'; visibilitychange/tracker-worker/
> calibrate-handle leaks fixed (+ in-flight wake-lock race); screen wake lock
> (single-sentinel); `play()` nudges on BOTH video re-parents; persistent
> aria-live slots + focus preservation + 44px buttons + keyboard-movable
> handles; demo hint restored at corner 1. Post-Accept HUD is now a buttonless
> "Locking on…" (the local Recalibrate desync affordance was removed).
> Suites grew 82 → **122 tests, all green**, with defect-probes inverted to
> pin the fixes, source-pin assertions, and mutation-verified coverage
> (inlier gate, metadata backstop, wake-lock race, freeze stretch).
> The `homography.ts` solver itself is intentionally unchanged — its
> degenerate-input behavior is documented by the math suite and guarded
> upstream in `calibrate.ts`.

Multi-agent deep-testing pass over the AR calibration pipeline (`ar/calibrate.ts`,
`ar/camera.ts`, `ar/homography.ts`, `ar/arview.ts` calibration seams, plus
`ar/tracker.ts`/`tracker.worker.ts` where calibration hands off). 3 test-builder
agents + 3 audit lenses (geometry, real-world/iOS, state-machine/a11y) + 10
adversarial verification passes. 46 raw findings → deduped, verified where
capped. **Every test below re-run and confirmed by the orchestrator.**

## Test suites (permanent, re-runnable — commands in each file's header)

| Suite | File(s) | Result |
|---|---|---|
| DLT homography math (fuzz, degenerate, chain replica) | `homography.deep.test.mjs` | 13 ✓ / 0 ✗ |
| calibrate.ts DOM/interaction (Playwright, real module) | `calibrate.harness.mjs` + `calibrate.e2e.py` | 21 ✓ / 0 ✗ |
| arview.ts integration seams | `arview-seams.test.mjs` | 14 ✓ / 0 ✗ |
| AR phase machine / dead-ends / a11y (Playwright) | `arview-statemachine.e2e.py` | 21 ✓ / 0 ✗ |
| Geometry chain audit probes | `geometry-chain.test.mjs` | 13 ✓ / 0 ✗ |

Total: **82 tests, all passing.** "Passing" means the suites *characterize* the
current behavior — many tests prove a defect exists (marked `probe_*` /
evidence-style names). Playwright interpreter:
`~/.local/share/uv/tools/crawl4ai/bin/python` (crawl4ai uv venv, cached
headless Chromium).

## What is SOLID (validated, no action needed)

- The DLT solver is exact on 200+ fuzzed convex perspective quads (≤1e-6
  round-trip), well-conditioned even on a 4px quad.
- The full tap→cover-fit→keyframe-H→identity-tracker→screen chain reproduces
  tapped corners to 1e-6; launch anchor (0.5, 0.03) lands correctly.
- Tap placement, 10px slop guard, 500ms long-press guard, Undo/Start-over,
  handle drag + edge clamping, 5th-tap rejection, Accept payload — all correct
  in headless Chromium against the real module.
- The new HUD bar's tap-through works: taps on the bar's text place corners;
  taps on buttons don't.

## CONFIRMED DEFECTS — ranked by field impact

### P0 — dead ends a user at the machine

1. **RECALIBRATE (and machine-switch during AR) is a dead end.**
   `createCalibrationUI` starts with `cameraState='stopped'` (calibrate.ts:155)
   and only learns state from `feed.onStateChange`; its `void feed.start()`
   hits camera.ts:87's `if (starting || state === 'live') return` — a silent
   no-op that emits nothing. On any SECOND mount over an already-live feed the
   HUD is stuck on "Starting camera…", handles never render (gated on `live`),
   Accept never appears — yet taps ARE silently recorded (pointerup never
   checks cameraState). Verified by direct code read + suite-4 probes.
   *Fix shape: emit current state to new subscribers (camera.ts replays state
   on subscribe), or have restart() re-emit 'live' on the no-op path.*

2. **`tracker.init()` can hang forever → stuck after Accept.**
   tracker.ts's RPC `send()` is a Promise with no reject, no timeout; no
   `worker.onerror`/`onmessageerror` anywhere. The worker loads the **10.3 MB
   OpenCV chunk** — on arcade Wi-Fi a failed/hung load leaves `await
   tracker.init()` (arview.ts:669) pending forever: calibration UI shows
   "Locked on" and never transitions. Two audit lenses flagged independently.
   *Fix shape: timeout + worker.onerror → treat as initOk=false.*

3. **Degenerate/crossed quads produce silent garbage (or a silent stuck screen).**
   Proven by test: coincident pair (fat-finger double-tap) and 3-collinear
   corners do NOT trip the solver's pivot guard — finite garbage H, overlay
   scrambled, no feedback. Bowtie (corners out of order): center maps 1300px
   off-playfield. Fully-collinear DOES throw — inside the un-awaited
   `void onCalibrated(c)` → unhandled rejection, calibrate UI stays "Locked
   on" forever. *Fix shape: validate in `acceptManual()` (convex + correct
   winding + min area) and disable Accept with a "corners look wrong" hint;
   try/catch in onCalibrated as backstop.*

### P1 — wrong overlay, no error shown

4. **Accept before video metadata → overlay off by ~947px, permanently.**
   `feed.video.videoWidth || 1` (arview.ts:649) bakes a 1×1-video cover fit
   into `calibrationHKeyframe`; nothing waits for `loadedmetadata`, nothing
   recomputes. Also reachable in the live loop after an iOS background
   stream-rebuild (videoWidth=0 frames). Proven by chain math test.

5. **Stage resize mid-calibration silently corrupts corners.** iOS toolbar
   collapse / rotation between taps: stored px never re-clamped or
   invalidated (proven: handle stranded outside a shrunken stage, still in
   the Accept payload; 60px height change → measurable multi-px drift for all
   subsequent mapping). Freeze-phase rotation: frozen photo re-stretches but
   `freezeMapFn` doesn't → 321px overlay drift (proven).

6. **Blurred/dark keyframe → silent identity overlay.** `tracker.init()`
   returning false still enters live with `trackingEnabled=false`; overlay
   renders via IDENTITY_H (frozen pose), only the tiny quality pill says
   "STATIC". Your blurry field screenshot is exactly this input. Related: the
   per-frame tracker H has **no inlier gate** (tracker.worker.ts:531 commits
   any RANSAC result; arview.ts:737 stores it regardless of `res.inliers`) —
   glass reflections can yank the overlay with confidence.

7. **Camera death after first going live surfaces nothing during calibrating.**
   Error card gated on `!cameraEverLive` (arview.ts:517); the reacquire banner
   gated on live/freeze phases. Phone call / camera claim mid-calibration →
   frozen video, no error, no retry. Related: a track that dies while the page
   stays VISIBLE only sets 'suspended' (camera.ts 'ended' handler) — the only
   rebuild path is visibilitychange.

### P2 — quality-of-life / leaks / a11y (fix opportunistically)

8. **HUD buttons sit where the BOTTOM-RIGHT corner gets tapped on small
   phones** (proven on 320px viewport: "Start over" — destructive, no confirm
   — occupies x218-298 exactly where corner 2 lands). Appear after 1st tap.
9. **Taps recorded while camera isn't live** (black stage) — pointerup doesn't
   gate on cameraState (proven).
10. **Leaks:** one document `visibilitychange` listener per Start-camera cycle
    (camera.ts:122, no dispose; proven ×5); tracker Worker leaked per repeat
    onCalibrated (arview.ts:663 overwrites without destroy);
    `calibrateHandle` overwritten without destroy on switchMachine mid-
    calibration; `tracker.destroy()` strands in-flight init/track promises.
11. **No Screen Wake Lock** — phone auto-locks mid-study; the product's core
    loop is "no touches for tens of seconds".
12. **iOS video re-parent without `play()`** (arview.ts:678-681) — classic
    paused-live-video risk on re-entry to the frame.
13. **A11y:** aria-live region is rebuilt wholesale every render (announcement
    unreliable, esp. VoiceOver); `innerHTML=''` throws focus to `<body>` per
    update (proven); HUD buttons 40px (<44px min the base rule sets); handles
    are `role=slider` with no value/keyboard support; no non-pointer
    calibration path at all.
14. **No demo/discoverability path** since the "tap any table" hint was
    removed — nothing in-app says calibration can be tried without a machine.

## Refuted (checked, NOT defects)

- "acceptManual commits 'Locked on' before onCalibrated with no error
  boundary" — ordering accurate but proven-failure was a harness artifact
  (the real trigger doesn't exist as described; the REAL stuck-screen paths
  are #2/#3 above).
- "Corners retained across camera suspend" — intended behavior (resume where
  you left off), not a bug.

## Suggested fix batches (not yet applied)

- **Batch A (field-critical, small):** #1 state replay on subscribe; #2 init
  timeout+onerror; #3 quad validation in acceptManual + try/catch in
  onCalibrated; #4 gate Accept until videoWidth>0 (`loadedmetadata`).
- **Batch B (robustness):** #5 invalidate corners on stage resize >N px (toast
  "hold steady — start over"), rebuild freezeMapFn on resize; #6 surface
  STATIC state plainly + inlier gate; #7 un-gate the error card, rebuild on
  'ended' while visible.
- **Batch C:** #8-14 (move HUD actions, cameraState tap gate, leak fixes, wake
  lock, video.play() after re-parent, a11y, demo hint).
