# PinballGenieWeb — module contracts (build-time coordination)

Every module is coded against these interfaces so parallel work integrates cleanly.
`app/src/models.ts` already exists (canonical data types — do not redefine its types).
Native sources of truth live in `../PinballGenieAndroid/` and `../PinballGenieIOS/`
(parent dir has a SPACE: "Pinball Genie"). Specs: `~/Documents/obsidian/vibes/github/PinballARPipeline/specs/`.

## Layout

```
PinballGenieWeb/
  data/                  # 37 *_goals.json + catalog.json (already present)
  server/                # pinball_auth.py, login.html, pinball-auth.service, auth.json (present)
  deploy.sh
  app/                   # Vite + vanilla TypeScript, NO framework
    index.html
    vite.config.ts tsconfig.json package.json
    src/
      main.ts            # boot: fetch catalog, restore state, mount shell
      state.ts           # AppState port
      app.ts             # shell: header, machine picker, tabs (Goals | Map | AR), goal browser
      styles.css
      models.ts          # (present)
      overlay/drawing.ts # OverlayDrawing port  [owner: overlay agent]
      overlay/map2d.ts   # Playfield2DView port [owner: overlay agent]
      ar/camera.ts       # getUserMedia layer   [owner: camera agent]
      ar/homography.ts   # DLT + apply          [owner: camera agent]
      ar/calibrate.ts    # corner UI + state    [owner: camera agent]
      ar/quaddetect.worker.ts + ar/quaddetect.ts  [owner: camera agent] — DEFERRED 2026-07-11, on disk unimported
      ar/tracker.ts + ar/tracker.worker.ts        [owner: tracker agent]
      ar/arview.ts       # AR mode composition  [owner: integrator]
      identify/matcher.ts + identify/scan.ts      [owner: identify agent] — DEFERRED 2026-07-11, on disk unimported
      fx/celebrate.ts + fx/sound.ts               [owner: fx agent]
      ui/sheet.ts        # shared bottom-sheet chrome
      ui/howto.ts        # full-screen step-by-step guide, added 2026-07-11
```

## Shared contracts

```ts
// The single most important type — everything draws through it (native parity).
export type MapFn = (u: number, v: number) => { x: number; y: number }  // CSS px

// overlay/drawing.ts
export interface OverlayOpts {
  shotsByID: Map<string, Shot>
  goal: Goal
  stepIndex: number
  ballPosition: BallPosition        // 'any' | ... ; start point per BALL_ANCHORS for flippers, but 'plunger'
                                     // (and 'any' when the goal starts from the plunger) resolves to the
                                     // dynamic (laneX, 0.02) anchor instead — see the 2026-07-28 note below
  map: MapFn
  time: number                      // ms, for marching highlight animation
  showLabels?: boolean              // gates the action-label bubble only; default true
  lineBrightness?: number           // multiplies connector/arrowhead stroke alpha only; default 1
  highlightIndex?: number | null    // manual mode: parks the highlight on this step instead of auto-walking; omit/null for auto
}
export function drawGoalOverlay(ctx: CanvasRenderingContext2D, o: OverlayOpts): void
// Port routing EXACTLY per SPEC-PATHVIZ + OverlayDrawing.kt:
// routeSegment / directControl / bowControl / chooseFlipper / resolveFeedUV /
// rampExtensionLegs,
// return-route waypoint (0.5, 0.06), upper-half direct exception,
// launch segment direct.
// 2026-07-29: legs are STRAIGHT, not bowed — control = chord midpoint (a
// degenerate quadratic). Rule 3's obstacle nudge is REMOVED (curves around
// bumpers/mechs don't happen on a real table, and the coords it measured
// against were only approximate) — drop curveClears/distanceToSegment,
// there is no obstacle to nudge away from anymore. The only curves left in
// the whole routing system are the shooter-lane ARCH legs below (rule 5
// Cases B/C), which trace real playfield ramp/loop geometry.
// 2026-07-29: rules 6-7 (dataset schema v3). Rule 6 (chooseFlipper) resolves
// a "shooting flipper" per segment — precedence step.flipper > target
// shot.flipper > cross-flipper heuristic > same side as origin — off the
// EXISTING FLIPPER_ANCHORS (leftFlipper/rightFlipper) + FLIPPER_SNAP (0.08
// normalized); viaWaypoint now pivots the return-route through the CHOSEN
// flipper's anchor instead of the flat (0.5, 0.06) point, or snap-directs
// under FLIPPER_SNAP. Rule 7 (rampExtensionLegs/resolveFeedUV) appends two
// straight ELEVATED legs (entrance -> apex -> feed point) after any step
// whose shot resolves a feed point (ramps/orbits/loops via `feeds`, gated on
// feed presence not `type === 'ramp'`), ending in a landing marker — not an
// arrowhead — at the feed point; the NEXT segment's origin becomes that feed
// point (UV + mapped), feeding rule 6's flipper resolution for the following
// segment. Rule 7's re-origination wins over rule 5: a plunge step that
// resolved a feed exit does NOT make the following segment plunger-origin
// (2026-07-29, D1).
// 2026-07-28: rule 5 LANE ROUTE for plunger-origin segments (launch segment
// when the effective launch anchor is the plunger, or any segment whose FROM
// shot is type 'plunge' AND whose step resolved no rule-7 feed exit — a
// plunge-with-feeds step re-originates the next segment at the feed point,
// routed by rule 6, never the lane route; 2026-07-29, D1) — chained 1-3
// quad-curve legs (plunger -> lane top -> arch/entry -> target), never
// direct/viaWaypoint. The effective launch
// anchor itself is computed inside drawGoalOverlay per SPEC-BALLSTART's
// "plunger launch realism" amendment: a plunge-first/skillshot-off-the-plunge
// goal anchors at the machine's plunge-shot x (clamped 0.93-0.98), not the
// flat (0.5, 0.03) default.

// overlay/map2d.ts — self-contained 2D map component
export function mountMap2D(host: HTMLElement, state: AppState): { destroy(): void }
// Uses a static rect MapFn: u→x left→right, v→y INVERTED (v=0 flippers at BOTTOM).

// state.ts — AppState port (mirror AppState.kt semantics)
export interface AppState {
  machines: Machine[]
  machine: Machine | null
  data: GameData | null
  shotsByID: Map<string, Shot>
  selectedGoal: Goal | null
  stepIndex: number
  ballPosition: BallPosition   // fixed 'any' (no UI setter — BALL AT picker removed 2026-07-13)
  highlightMode: 'auto' | 'manual'   // marching-highlight mode; reset to 'auto' by select()/clearSelection()/restartGoal()/machine loads
  selectMachine(m: Machine): Promise<void>   // resets selection
  select(g: Goal): void; clearSelection(): void
  nextStep(): void; prevStep(): void; goToStep(i: number): void
  pauseHighlight(): void      // enter manual mode, parking the highlight on stepIndex; no-op with no goal or already manual
  resumeHighlight(): void     // back to auto-marching; no-op when already auto
  onChange(fn: () => void): () => void       // subscribe, returns unsubscribe
}
// Goal filtering by ballPosition (SPEC-BALLSTART): 'any' shows all;
// 'plunger' → goals whose first step shot is the plunge shot (type 'plunge');
// flippers → goals whose first step is NOT a plunge. (Verify exact rule in
// native GoalBrowser.kt / SPEC-BALLSTART.md and match it.)

// ar/camera.ts
export interface CameraFeed {
  video: HTMLVideoElement            // playsinline muted autoplay, object-fit cover
  start(): Promise<void>             // must be called from a user gesture
  stop(): void
  onStateChange(fn: (s: 'live'|'suspended'|'stopped'|'error', err?: Error) => void): () => void  // returns unsubscribe
  grabFrame(maxDim?: number): { canvas: HTMLCanvasElement; scaleToVideo: number } // downscaled grayscale-ready RGBA
}
export function createCameraFeed(): CameraFeed
// Handles: visibilitychange rebuild, iOS quirks, facingMode environment.
// 2026-07-28 fix pass: onStateChange(fn) replays the CURRENT state to `fn`
// SYNCHRONOUSLY before returning (a late subscriber over an already-live
// feed — RECALIBRATE, switchMachine — always learns real state instead of
// waiting for the next transition, which may never come). stop() is
// terminal: it also detaches the document `visibilitychange` listener and
// the video element's `ended` listener (callers always discard the whole
// CameraFeed and build a fresh one via createCameraFeed() rather than
// reusing a stopped one).

// ar/homography.ts
export type H = number[]             // row-major 3x3
export function computeHomography(src: [number,number][], dst: [number,number][]): H  // 4-pt DLT
export function applyH(h: H, x: number, y: number): { x: number; y: number }
export function makeMapFn(h: H): MapFn   // (u,v) → px through H
// Convention: playfield unit square (u,v) with v=0 at FLIPPER edge maps to the
// four tapped corners ordered BL, BR, TR, TL (native tap order).

// ar/calibrate.ts
// 2026-07-11 field-test fix pass: manual tap-to-place is the ONLY mode now
// (auto-detect + setProposal removed — see calibrate.ts's header comment).
// ar/quaddetect.ts stays on disk, unimported (tree-shaken out of the bundle).
export interface Calibration { corners: [number,number][]  /* BL,BR,TR,TL in video-display px */ }
export function createCalibrationUI(host: HTMLElement, feed: CameraFeed,
  onCalibrated: (c: Calibration) => void): { reset(): void; destroy(): void }
export function renderCornerOrderDiagram(): SVGSVGElement  // shared with ui/howto.ts

// ar/quaddetect.ts (worker wrapper) — DEFERRED, unimported (see calibrate.ts)
export function createQuadDetector(): {
  detect(frame: ImageData): Promise<[number,number][] | null>  // 4 corners, frame px, or null
  destroy(): void
}
// Worker ports QuadDetector.kt EXACTLY: downscale luma ~120px → Sobel →
// binarize mean+1.5σ → largest 8-connected edge component → monotone-chain
// hull → farthest-point 4 corners. Stability (5 frames, ≥20% viewport,
// <3% diag movement) lived in calibrate.ts, per SPEC-AUTOCAL, before this
// pass removed the auto-detect flow.

// ar/tracker.ts (worker wrapper; OpenCV.js in worker only)
export interface Tracker {
  init(keyframe: ImageData, quad: [number,number][]): Promise<boolean>
  track(frame: ImageData): Promise<{ h: H | null; inliers: number; fps: number }> // H maps keyframe px → frame px
  destroy(): void
}
export function createTracker(): Tracker
// 2026-07-28 fix pass: init()/track() RPCs are timeout-bounded (init 30s —
// generous for the 10.3MB OpenCV.js chunk on slow arcade Wi-Fi; track 5s)
// and NEVER reject — a timeout resolves with the same fallback callers
// already treat as failure (init -> ok:false; track -> h:null). worker.onerror
// / onmessageerror settle every in-flight call with its fallback and mark
// the tracker dead (later calls resolve immediately, no more posting to a
// crashed Worker). destroy() also settles every in-flight call with its
// fallback before terminating, so an awaited init()/track() can never strand
// its caller's continuation.

// identify/matcher.ts — pure port of MachineIdentifier (SPEC-MACHINE-ID)
export function machineTokens(name: string): string[]      // up-to-"—", uppercase, fold diacritics, len≥3
export function matchMachines(ocrWords: Set<string>, machines: Machine[]): Machine[] // all-tokens-whole-word hits, tie: token count desc

// identify/scan.ts — one-shot Tesseract on a crop; UI w/ progress; returns Machine|null

// fx/celebrate.ts — export function celebrate(host: HTMLElement, fxTheme: string|null): void
// Canvas particles + WebAudio synth per native fx/ (FXTheme.kt themes, SoundSynth.kt).
```

## Rules
- Vanilla TS + DOM only. No frameworks, no runtime deps except: `@techstark/opencv-js` (tracker worker) and `tesseract.js` (scan). Everything self-hosted — the app sits behind auth; NO CDN/external requests at runtime.
- All fetches are same-origin relative paths (auth cookie rides along).
- Mobile-first dark UI. Big touch targets. The native apps' vibe: dark charcoal + amber/gold accents.
- Each agent owns ONLY its listed files. Do not create/modify others' files. Do not touch package.json (scaffold owns it; deps above are pre-declared).
- Every port cites the native file it mirrors in a header comment.
