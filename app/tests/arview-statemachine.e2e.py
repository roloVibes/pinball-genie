#!/usr/bin/env python3
# app/tests/arview-statemachine.e2e.py — SUITE 4: AR phase machine, error
# dead-ends, and calibration a11y (Playwright, headless Chromium).
#
# Run (from repo root — the path has a space, so quote it):
#   ~/.local/share/uv/tools/crawl4ai/bin/python "app/tests/arview-statemachine.e2e.py"
# Or from app/:
#   ~/.local/share/uv/tools/crawl4ai/bin/python tests/arview-statemachine.e2e.py
# Exits non-zero if any test fails. Add -v for full per-test evidence.
#
# WHAT IS REAL HERE
#   The page under test mounts the REAL src/ar/arview.ts mountAR(), which
#   mounts the REAL src/ar/calibrate.ts and src/ar/camera.ts, styled by the
#   REAL ar/arview.css + ar/calibrate.css (esbuild bundles the actual .ts/.css
#   — nothing under src/ is copied or modified). The camera is a REAL
#   getUserMedia stream from Chromium's fake capture device
#   (--use-fake-device-for-media-stream), so videoWidth/videoHeight, the
#   'live' state transition and object-fit:cover geometry are all genuine
#   (1280x720). Corner taps are real pointer events at real coordinates.
#
#   The ONLY substitution is src/ar/tracker.ts -> tests/harness/tracker.stub.ts,
#   because the real one spawns a module Worker pulling ~10 MB of OpenCV wasm.
#   Each stub mode models a state the real tracker provably reaches — see that
#   file's header for the line-by-line justification ('hang' == a rejected
#   ensureCv() in tracker.worker.ts line 439/566, which posts nothing back and
#   which tracker.ts never times out or surfaces).
#
#   IMPORTANT SCOPE NOTE (2026-07-28 fix-pass rewrite): the A2 tracker RPC
#   hardening (30s init timeout + worker.onerror/onmessageerror, fixing the
#   "tracker.init() can hang forever" defect) lives entirely inside
#   ar/tracker.ts's send() — a module this suite deliberately REPLACES with
#   tracker.stub.ts to avoid the 10MB OpenCV worker. That means this suite
#   structurally CANNOT exercise the A2 timeout fix; the stub's own 'hang'
#   mode still hangs forever regardless of the real fix, because the fix
#   never runs. The A2 fix is verified for real in
#   app/tests/arview-seams.test.mjs SECTION 2, which bundles the REAL
#   ar/tracker.ts. Section 2 below keeps a 'hang'-mode check (now clearly
#   labeled) purely as a sanity check on this harness's own stub, NOT as
#   evidence the app-level defect is still open.
#
# SECTIONS
#   1. Recalibrate / machine-switch — FIXED by camera.ts's onStateChange
#      replay-on-subscribe (A1); double-mount leak FIXED by
#      startCalibration()'s calibrateHandle?.destroy() (C10).
#   2. Post-Accept error handling — collinear-quad throw FIXED (blocked
#      before Accept, by calibrate.ts's quadProblem() — A3); tracker-leak
#      partially FIXED (tracker?.destroy() before reassigning — C10); the
#      init-timeout half is out of this suite's reach (see note above).
#   3. Camera-loss during 'calibrating' — FIXED: a track that ends while the
#      page stays visible now auto-rebuilds (camera.ts's one-shot 'ended'
#      listener — C10/B7), and a genuinely failed rebuild now surfaces the
#      error card even after cameraEverLive (arview.ts's phase==='calibrating'
#      carve-out — B7).
#   4. HUD a11y + destructive-control placement — aria-live node stability,
#      44px buttons, focus preservation, and handle keyboard support all
#      FIXED (C13); HUD actions moved off the corner-2 tap zone FIXED (C8).

import argparse
import functools
import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)

# A normal, well-conditioned trapezoid quad in BL,BR,TR,TL tap order on the
# 390x780 stage (the default iPhone-ish viewport used below).
CORNERS = [(60, 620), (330, 620), (300, 200), (90, 200)]

# C11 coverage — a spy navigator.wakeLock mock, injected via add_init_script
# (must exist before arview.ts's module code ever runs). Overwrites the
# accessor with Object.defineProperty (Chromium's real Navigator.prototype
# 'wakeLock' getter is otherwise non-writable by plain assignment — same
# reason arview-seams.test.mjs's camera.ts stub redefines `navigator`).
# request()'s resolution can be delayed via window.__wakeLockRequestDelayMs
# (default 0) so a test can race Exit AR against a still-pending request —
# see arview.ts's own wakeLockAcquiring flag + its post-await
# `destroyed || phase === 'idle'` bail, which this specifically exercises.
# window.__wakeLockLog.{created,released} count independently of whatever
# arview.ts does with the sentinel, so "at most one live sentinel" can be
# verified from OUTSIDE the app's own bookkeeping.
WAKE_LOCK_MOCK_JS = """
window.__wakeLockLog = { created: 0, released: 0 };
window.__wakeLockRequestDelayMs = 0;
Object.defineProperty(navigator, 'wakeLock', {
  configurable: true,
  value: {
    request: function () {
      return new Promise(function (resolve) {
        window.setTimeout(function () {
          window.__wakeLockLog.created++;
          var released = false;
          var listeners = [];
          var sentinel = {
            release: function () {
              if (!released) {
                released = true;
                window.__wakeLockLog.released++;
                listeners.forEach(function (fn) { fn(); });
              }
              return Promise.resolve();
            },
            addEventListener: function (type, fn) {
              if (type === 'release') listeners.push(fn);
            },
          };
          resolve(sentinel);
        }, window.__wakeLockRequestDelayMs || 0);
      });
    },
  },
});
"""

results = []
VERBOSE = False


def check(name, ok, evidence):
    results.append((name, ok, evidence))
    print(("  PASS  " if ok else "  FAIL  ") + name)
    if VERBOSE or not ok:
        print("          " + str(evidence))


def section(title):
    print("\n=== " + title + " ===")


# ---------------------------------------------------------------------------
# Harness build + static server
# ---------------------------------------------------------------------------
def build_harness():
    out = tempfile.mkdtemp(prefix="pg-suite4-")
    subprocess.run(
        ["node", os.path.join(HERE, "harness", "build.mjs"), out],
        check=True,
        cwd=APP,
        stdout=subprocess.PIPE,
    )
    return out


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(QuietHandler, directory=directory)
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


# ---------------------------------------------------------------------------
# Page helpers
# ---------------------------------------------------------------------------
def new_page(ctx, port, mode="ok", init_delay_ms=0):
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append("PAGEERROR: " + str(e)))
    pg.add_init_script(
        "window.__trackerMode = %s; window.__trackerInitDelayMs = %d;"
        % (json.dumps(mode), init_delay_ms)
    )
    pg.goto("http://127.0.0.1:%d/index.html" % port)
    pg.wait_for_function("window.__arReady === true")
    return pg


def start_calibration(pg):
    """Idle -> 'Start camera' -> calibrating, with the camera actually live."""
    pg.click(".ar-idle-btn")
    pg.wait_for_selector(".pg-cal-stage")
    # 2026-07-28 chrome redesign (correction 13): the per-corner HUD line is
    # now the single combined handoff-copy line "Tap the BOTTOM-LEFT (NEAR
    # THE LEFT FLIPPER) corner of the playfield glass — 0/4" — "0/4" (n
    # corners placed, 0-indexed) is the stable substring for "waiting on the
    # first tap", replacing the old "Corner 1 of 4" prefix.
    pg.wait_for_function(
        "document.querySelector('.pg-cal-hud-step')?.textContent.includes('0/4')",
        timeout=10000,
    )


def tap(pg, x, y):
    pg.mouse.move(x, y)
    pg.mouse.down()
    pg.mouse.up()


def tap_corners(pg, corners=None):
    for c in corners or CORNERS:
        tap(pg, *c)


def huds(pg):
    # Scoped to .pg-cal-hud-text (the step/detail column), not the whole
    # .pg-cal-hud pill — the pill now also carries a static "LINE UP THE
    # MACHINE" eyebrow (2026-07-28 chrome redesign, correction 13), which
    # would otherwise prefix every one of this helper's exact-text checks.
    return pg.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-text')).map(h=>h.textContent)"
    )


def visible_buttons(pg):
    return pg.evaluate(
        "Array.from(document.querySelectorAll('button'))"
        ".filter(b=>b.offsetParent!==null)"
        ".map(b=>(b.textContent||b.getAttribute('aria-label')||'').trim())"
    )


def accept(pg):
    pg.click("button:has-text('Accept')")


def canvas_ink(pg):
    """Non-transparent pixel count on calibrate.ts's outline canvas."""
    return pg.evaluate(
        "(()=>{const c=document.querySelector('.pg-cal-canvas');if(!c)return -1;"
        "const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;"
        "let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>0)n++;return n})()"
    )


def end_track(pg):
    """Simulates a real 'track ended for external reasons' event (device
    unplugged / another app claimed the camera / OS reclaimed it). Dispatches
    'ended' on the TRACK itself, not the <video> element — per the WebRTC
    spec (confirmed empirically against Chromium's fake device: calling
    track.stop() alone does NOT fire the track's own 'ended' event; only a
    genuine external end does) track.stop() never fires 'ended', so an
    application-initiated .stop() cannot be used to simulate this. This is
    exactly the trigger camera.ts's new one-shot per-track 'ended' listener
    (C10/B7) exists for."""
    pg.evaluate(
        "(()=>{const v=document.querySelector('video');"
        "const t=v.srcObject.getTracks()[0];"
        "t.stop();"
        "t.dispatchEvent(new Event('ended'))})()"
    )


# ---------------------------------------------------------------------------
# SECTION 1 — Recalibrate / machine-switch dead-end (FIXED)
# ---------------------------------------------------------------------------
def section1(ctx, port):
    section("SECTION 1 — RECALIBRATE / machine switch (fixed: camera.ts replays current state on subscribe — A1)")

    # 1a-1d. The headline: RECALIBRATE from the live phase now works.
    pg = new_page(ctx, port)
    start_calibration(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    pg.click("button:has-text('RECALIBRATE')")
    pg.wait_for_timeout(500)
    hud_after = huds(pg)
    check(
        "1a RECALIBRATE immediately shows the corner-1 prompt (was: stuck forever on 'Starting camera...')",
        len(hud_after) == 1 and "BOTTOM-LEFT" in hud_after[0] and "0/4" in hud_after[0],
        "hud=%r; video present in stage=%r"
        % (hud_after, pg.evaluate("!!document.querySelector('.pg-cal-stage video')")),
    )

    tap_corners(pg)
    pg.wait_for_timeout(200)
    ink = canvas_ink(pg)
    has_accept = pg.evaluate(
        "!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Accept')"
    )
    handles = pg.evaluate("document.querySelectorAll('.pg-cal-handle').length")
    check(
        "1b after RECALIBRATE the 4 taps place normal handles and Accept appears (was: outline drawn but 0 handles, no Accept, ever)",
        ink > 0 and handles == 4 and has_accept,
        "outline pixels=%d, handles=%d, Accept button present=%r, hud=%r"
        % (ink, handles, has_accept, huds(pg)),
    )

    accept(pg)
    pg.wait_for_timeout(500)
    check(
        "1c the second Accept completes normally: calibration UI unmounts, the live frame resumes",
        huds(pg) == [] and pg.evaluate("document.querySelector('.ar-frame').hidden") is False,
        "hud=%r, frame hidden=%r" % (huds(pg), pg.evaluate("document.querySelector('.ar-frame').hidden")),
    )
    check(
        "1d no camera watchdog / error card ever fires during a normal RECALIBRATE round-trip",
        pg.evaluate("document.querySelector('.ar-error-card').hidden") is True,
        "error card hidden=%r" % (pg.evaluate("document.querySelector('.ar-error-card').hidden"),),
    )
    pg.close()

    # 1e. Same root cause via the machine pill from the live phase — also fixed.
    pg = new_page(ctx, port)
    start_calibration(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    pg.click(".ar-machine-pill")
    pg.wait_for_selector(".ar-msheet-row")
    for row in pg.query_selector_all(".ar-msheet-row"):
        if "GODZILLA" in row.inner_text():
            row.click()
            break
    pg.wait_for_timeout(800)
    hud_1e = huds(pg)
    check(
        "1e switching machines from the live phase now re-enters a WORKING calibration flow",
        len(hud_1e) == 1 and "BOTTOM-LEFT" in hud_1e[0] and "0/4" in hud_1e[0],
        "hud=%r" % (hud_1e,),
    )
    tap_corners(pg)
    pg.wait_for_timeout(200)
    check(
        "1e-confirm taps after the machine switch place real handles",
        pg.evaluate("document.querySelectorAll('.pg-cal-handle').length") == 4,
        "handles=%d" % pg.evaluate("document.querySelectorAll('.pg-cal-handle').length"),
    )
    pg.close()

    # 1f/1g. Machine switch DURING calibration no longer double-mounts the UI
    # (startCalibration()'s calibrateHandle?.destroy() before reassigning — C10).
    pg = new_page(ctx, port)
    start_calibration(pg)
    tap(pg, *CORNERS[0])
    tap(pg, *CORNERS[1])
    pg.click(".ar-machine-pill")
    pg.wait_for_selector(".ar-msheet-row")
    for row in pg.query_selector_all(".ar-msheet-row"):
        if "GODZILLA" in row.inner_text():
            row.click()
            break
    pg.wait_for_timeout(600)
    stages = pg.evaluate("document.querySelectorAll('.ar-cal-wrap .pg-cal-stage').length")
    check(
        "1f machine switch mid-calibration mounts exactly ONE calibration UI (was: a second, without destroying the first)",
        stages == 1,
        "stage count=%d" % (stages,),
    )
    video_in_the_stage = pg.evaluate(
        "(()=>{const v=document.querySelector('video'); return !!v && v.closest('.pg-cal-stage') === document.querySelector('.pg-cal-stage')})()"
    )
    check(
        "1g the live <video> lives in the (only) stage the user can actually tap",
        video_in_the_stage,
        "video parented in the sole stage=%r" % (video_in_the_stage,),
    )
    pg.close()


# ---------------------------------------------------------------------------
# SECTION 2 — post-Accept dead-ends
# ---------------------------------------------------------------------------
def section2(ctx, port):
    section("SECTION 2 — Accept validation (A3, fixed) and tracker-leak reduction (C10, fixed)")

    # 2a. Degenerate corners are now BLOCKED by calibrate.ts's quadProblem()
    #     BEFORE Accept can ever fire — no throw ever reaches arview.ts.
    pg = new_page(ctx, port)
    start_calibration(pg)
    tap_corners(pg, [(60, 600), (160, 600), (260, 600), (360, 600)])  # collinear
    hud_2a = huds(pg)
    accept_disabled = pg.evaluate(
        "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Accept')?.disabled"
    )
    check(
        "2a collinear corners: Accept renders DISABLED with 'Corners look wrong' (was: silent Accept -> unhandled rejection -> stuck 'Locked on')",
        accept_disabled is True and "Corners look wrong" in hud_2a[0],
        "hud=%r; accept disabled=%r" % (hud_2a, accept_disabled),
    )
    pg.wait_for_timeout(500)
    check(
        "2a-confirm no pageerror/unhandled-rejection ever fires and the frame never shows (Accept genuinely never ran)",
        pg.errors == [] and pg.evaluate("document.querySelector('.ar-frame').hidden") is True,
        "pageerrors=%r; frame hidden=%r" % (pg.errors, pg.evaluate("document.querySelector('.ar-frame').hidden")),
    )
    pg.close()

    # 2b. HARNESS SCOPE NOTE — see this file's header. tracker.stub.ts's
    # 'hang' mode bypasses ar/tracker.ts entirely, so it cannot exercise the
    # A2 30s-timeout fix (which lives inside ar/tracker.ts's send()). This
    # check is a sanity check on the STUB's own documented behavior, not a
    # test of app-level tracker-timeout handling — see
    # arview-seams.test.mjs SECTION 2 for the real coverage of that fix.
    # R5 UPDATE: the stuck post-Accept HUD is now the buttonless 'Locking
    # on…' progress state (was: 'Locked on' + a local Recalibrate button
    # that called calibrate.ts's own fullReset() without arview.ts's
    # sessionGen ever learning about it — see calibrate.ts's calibrated-
    # branch comment for the full story of why that affordance was removed).
    pg = new_page(ctx, port, mode="hang")
    start_calibration(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_timeout(2000)
    hud_2b = huds(pg)
    buttons_2b = pg.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn')).map(b=>b.textContent)"
    )
    check(
        "2b (harness-scope note, not an app-defect check) tracker.stub.ts's 'hang' mode behaves as documented: init() never settles because this suite substitutes tracker.ts entirely — the real 30s timeout fix is verified in arview-seams.test.mjs SECTION 2, not here. Stuck HUD is the buttonless 'Locking on…' state (R5) — ZERO buttons of any kind (was: 'Locked on' + a Recalibrate button)",
        hud_2b == ["Locking on…Loading the tracking engine — first run can take a few seconds"]
        and buttons_2b == []
        and pg.evaluate("document.querySelector('.ar-quality-pill-text').textContent") == "CALIBRATING",
        "hud=%r; buttons in HUD=%r; quality pill=%r"
        % (hud_2b, buttons_2b, pg.evaluate("document.querySelector('.ar-quality-pill-text').textContent")),
    )

    # 2c. R5 REDESIGN (was: probing calibrate.ts's own local 'Recalibrate'
    #     button — R5 deleted it; a raw Playwright click on that selector now
    #     resolves to arview.ts's bottom-stack RECALIBRATE button instead,
    #     which is hidden during 'calibrating' (bottomStack is live/freeze
    #     only) — hence the addendum's TimeoutError. From the stuck-hung
    #     'Locking on…' state there is now NO calibrate.ts affordance at all
    #     (2b's structural check above: zero buttons) — calibrate.ts's own
    #     comment says arview.ts owns recovery from here on. The ONLY
    #     reachable escape hatch is the header's ✕ Exit AR button
    #     (stopCamera(): bumpGen() + teardownTracking() -> tracker?.destroy()),
    #     which must cleanly release the hung tracker and tear all the way
    #     back to idle — not leave a stray Worker/session behind.
    pg.click(".ar-exit-btn")
    pg.wait_for_timeout(300)
    log_after_exit = pg.evaluate("window.__trackerLog")
    check(
        "2c the ONLY escape from the stuck-hung 'Locking on…' state is the header's Exit AR button (calibrate.ts's own local Recalibrate affordance is gone — R5): it destroys the hung tracker and tears all the way back to idle",
        log_after_exit["created"] == 1
        and log_after_exit["destroyed"] == 1
        and log_after_exit["liveInstances"] == 0
        and pg.evaluate("document.querySelector('.ar-idle').hidden") is False,
        "tracker log=%r; idle panel hidden=%r"
        % (log_after_exit, pg.evaluate("document.querySelector('.ar-idle').hidden")),
    )
    pg.close()

    # 2d. R5 REDESIGN (was: probing the local-Recalibrate-during-slow-init
    #     desync race documented as a known, out-of-scope asymmetry in
    #     arview-seams.test.mjs SECTION 2's code-trace — acceptManual() had
    #     already committed to 'Locked on' when calibrate.ts's own local
    #     Recalibrate button reset its internal state WITHOUT going through
    #     arview.ts's recalibrate()/bumpGen(), so the pending onCalibrated
    #     continuation could land later and yank the user back out of their
    #     restarted calibration). R5 deletes that button entirely, so this
    #     race is now STRUCTURALLY unreachable, not just fixed at the
    #     tracker-leak layer — this test confirms both halves: (a) the
    #     mid-init HUD has zero buttons (nothing to trigger a second
    #     onCalibrated from), and (b) the slow-init happy path still
    #     completes cleanly end-to-end with no leak.
    pg = new_page(ctx, port, mode="slow", init_delay_ms=1500)
    start_calibration(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_timeout(250)
    mid_hud = huds(pg)
    mid_buttons = pg.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn')).map(b=>b.textContent)"
    )
    check(
        "2d-mid mid-init (still awaiting the slow tracker.init()) the calibration HUD is the buttonless 'Locking on…' state — ZERO buttons of any kind, so there is structurally no way to re-trigger onCalibrated from here (the R5-deleted desync path)",
        mid_hud == ["Locking on…Loading the tracking engine — first run can take a few seconds"] and mid_buttons == [],
        "hud during init=%r; buttons during init=%r" % (mid_hud, mid_buttons),
    )
    pg.wait_for_timeout(2000)
    log = pg.evaluate("window.__trackerLog")
    check(
        "2d-confirm the slow-init happy path still completes cleanly with the desync affordance gone: exactly ONE onCalibrated call, ONE tracker, no leak, session reaches live",
        log["created"] == 1
        and log["destroyed"] == 0
        and log["liveInstances"] == 1
        and huds(pg) == []
        and pg.evaluate("document.querySelector('.ar-frame').hidden") is False,
        "tracker log=%r; final hud=%r; frame hidden=%r"
        % (log, huds(pg), pg.evaluate("document.querySelector('.ar-frame').hidden")),
    )
    pg.close()

    # 2e. Control: a fast double-tap on Accept does NOT double-fire.
    #     (unaffected by this fix pass — calibrate.ts's acceptManual() now
    #     ALSO has an explicit `if (calibrated) return` guard as a second
    #     line of defense, on top of render() detaching the button first.)
    pg = new_page(ctx, port, mode="slow", init_delay_ms=1500)
    start_calibration(pg)
    tap_corners(pg)
    box = pg.query_selector("button:has-text('Accept')").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    pg.mouse.move(x, y)
    pg.mouse.down(); pg.mouse.up()
    pg.mouse.down(); pg.mouse.up()
    pg.wait_for_timeout(300)
    log = pg.evaluate("window.__trackerLog")
    check(
        "2e (control) double-tapping Accept does not fire onCalibrated twice",
        log["created"] == 1,
        "tracker log=%r" % (log,),
    )
    pg.close()


# ---------------------------------------------------------------------------
# SECTION 3 — camera loss during 'calibrating' (FIXED)
# ---------------------------------------------------------------------------
def section3(ctx, port):
    section("SECTION 3 — camera loss after the feed was once live (fixed: camera.ts one-shot track 'ended' listener — C10/B7)")

    # 3a. A track that ends for real (device unplugged / claimed by another
    #     app) while the page stays visible now auto-rebuilds — calibration
    #     state (already-placed corner) survives the blip untouched.
    pg = new_page(ctx, port)
    start_calibration(pg)
    tap(pg, *CORNERS[0])
    end_track(pg)
    pg.wait_for_timeout(2000)
    hud_3a = huds(pg)
    handles_3a = pg.evaluate("document.querySelectorAll('.pg-cal-handle').length")
    check(
        "3a camera death mid-calibration now auto-recovers: back to the corner-2 prompt with the earlier tap intact (was: 'Camera paused' forever, no watchdog, no retry)",
        hud_3a and "BOTTOM-RIGHT" in hud_3a[0] and "1/4" in hud_3a[0] and handles_3a == 1,
        "hud=%r; handles=%d" % (hud_3a, handles_3a),
    )
    pg.close()

    # 3b. When the rebuild GENUINELY fails (not just a transient blip), the
    #     error card now shows during 'calibrating' regardless of
    #     cameraEverLive (arview.ts's onCameraStateChange carve-out — B7);
    #     previously it was gated on !cameraEverLive, which was already
    #     false by the time a camera died mid-calibration (the feed had
    #     already gone live once to get INTO calibrating), so nothing ever
    #     showed.
    pg = new_page(ctx, port)
    start_calibration(pg)
    tap(pg, *CORNERS[0])
    pg.evaluate(
        "() => { navigator.mediaDevices.getUserMedia = () => "
        "Promise.reject(Object.assign(new Error('device busy'), {name:'NotReadableError'})); }"
    )
    end_track(pg)
    pg.wait_for_timeout(1000)
    check(
        "3b a rebuild that genuinely fails now shows the camera error card with Try again/Exit, even though the camera had already gone live once this session",
        pg.evaluate("document.querySelector('.ar-error-card').hidden") is False
        and "Try again" in visible_buttons(pg)
        and "Exit" in visible_buttons(pg),
        "error card hidden=%r; visible buttons=%r; error msg=%r"
        % (
            pg.evaluate("document.querySelector('.ar-error-card').hidden"),
            visible_buttons(pg),
            pg.evaluate("document.querySelector('.ar-error-msg')?.textContent"),
        ),
    )
    check(
        "3b-confirm calibrate.ts's own HUD agrees (camera unavailable), not fighting the error card",
        "Camera problem" in huds(pg)[0],
        "hud=%r" % (huds(pg),),
    )
    pg.close()


# ---------------------------------------------------------------------------
# SECTION 4 — HUD a11y + destructive-control placement (FIXED — C13, C8)
# ---------------------------------------------------------------------------
def section4(ctx, port):
    section("SECTION 4 — HUD a11y (fixed: persistent slots/focus/keyboard — C13) + control placement (fixed: order:-1 — C8)")

    pg = new_page(ctx, port)
    start_calibration(pg)

    pg.evaluate("window.__lr = document.querySelector('[aria-live]')")
    tap(pg, *CORNERS[0])
    same_node = pg.evaluate("window.__lr === document.querySelector('[aria-live]')")
    old_in_dom = pg.evaluate("document.contains(window.__lr)")
    check(
        "4a the aria-live region is now a STABLE node across renders (children mutate, the node itself never moves) — was: a brand-new node every render",
        same_node and old_in_dom and pg.evaluate("document.querySelectorAll('[aria-live]').length") == 1,
        "same node after tap=%r; previous region still in DOM=%r; regions now=%d"
        % (same_node, old_in_dom, pg.evaluate("document.querySelectorAll('[aria-live]').length")),
    )

    boxes = pg.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn'))"
        ".map(b=>{const r=b.getBoundingClientRect();return [b.textContent,Math.round(r.width),Math.round(r.height)]})"
    )
    check(
        "4b HUD buttons are now >=44px tall (was: 40px, below the 44px base-rule touch minimum)",
        len(boxes) > 0 and all(b[2] >= 44 for b in boxes),
        "button boxes=%r" % (boxes,),
    )

    # 4c. Focus preservation — must start from a state where a same-labeled
    #     button STILL EXISTS **and is enabled** after the action (Undo from
    #     n=2 -> n=1, not n=1 -> n=0). Since the 2026-07-28 chrome redesign
    #     (correction 13) Undo/Start over/Accept are ALWAYS present (disabled
    #     state now carries what used to be presence/absence), but a DISABLED
    #     button cannot receive focus at all (native HTML semantics) — at
    #     n=1 -> n=0 the post-Undo "Undo" button exists but is disabled
    #     (nothing left to undo), so restoring focus to it would silently
    #     fail for that reason alone, not proving anything about the fix.
    #     n=2 -> n=1 keeps Undo enabled on both sides, still the right
    #     scenario.
    tap(pg, *CORNERS[1])  # now n=2
    pg.evaluate(
        "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Undo').focus()"
    )
    before = pg.evaluate("document.activeElement.textContent")
    pg.click("button:has-text('Undo')")
    pg.wait_for_timeout(100)
    after_tag = pg.evaluate("document.activeElement.tagName")
    after_text = pg.evaluate("document.activeElement.textContent")
    check(
        "4c pressing Undo (with a same-labeled button still available after) now RESTORES focus to the new Undo button (was: card.innerHTML='' dropped focus to <body> unconditionally)",
        before == "Undo" and after_tag == "BUTTON" and after_text == "Undo",
        "focus before=%r, after tag=%r, after text=%r" % (before, after_tag, after_text),
    )

    tap(pg, *CORNERS[0])
    tap(pg, *CORNERS[1])
    handle_attrs = pg.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-handle')).map(h=>({"
        "role:h.getAttribute('role'),tabindex:h.getAttribute('tabindex'),"
        "valuetext:h.getAttribute('aria-valuetext')}))"
    )
    check(
        "4d corner handles are now keyboard-focusable (tabindex=0) with a live aria-valuetext (was: role=slider with no tabindex and no aria-value* at all — unfocusable, invalid ARIA)",
        all(h["role"] == "slider" and h["tabindex"] == "0" and h["valuetext"] for h in handle_attrs),
        "handles=%r" % (handle_attrs,),
    )

    # Functional keyboard-move check (new C13 behavior, not just attributes).
    handle0 = pg.locator(".pg-cal-handle").nth(0)
    before_pos = pg.evaluate(
        "(()=>{const h=document.querySelectorAll('.pg-cal-handle')[0]; return [h.style.left, h.style.top]})()"
    )
    handle0.focus()
    pg.keyboard.press("ArrowRight")
    after_pos = pg.evaluate(
        "(()=>{const h=document.querySelectorAll('.pg-cal-handle')[0]; return [h.style.left, h.style.top]})()"
    )
    before_x = float(before_pos[0].replace("px", ""))
    after_x = float(after_pos[0].replace("px", ""))
    check(
        "4d-confirm ArrowRight on a focused handle actually moves the corner 2px (functional, not just attribute presence)",
        after_x == before_x + 2,
        "before=%r after=%r" % (before_pos, after_pos),
    )

    tapzone = pg.evaluate(
        "(()=>{const t=document.querySelector('.pg-cal-tapzone');"
        "return {role:t.getAttribute('role'),label:t.getAttribute('aria-label'),tabindex:t.getAttribute('tabindex')}})()"
    )
    focusables = pg.evaluate(
        "Array.from(document.querySelectorAll('button,[tabindex],input,a[href]'))"
        ".filter(e=>e.offsetParent!==null && !e.disabled)"
        ".map(e=>(e.textContent||e.getAttribute('aria-label')||e.tagName).trim().slice(0,24))"
    )
    corner_focusables = [f for f in focusables if f.startswith("Corner")]
    check(
        "4e PARTIAL fix, correctly scoped: already-placed corner handles are now keyboard-focusable/adjustable (2+ 'Corner N' entries in the focus order) — but the tapzone itself STILL has no role/label/tabindex, so there is still no way to place a corner for the FIRST time (or add a 5th/replacement corner) without a pointer. This is an accurate, narrower restatement of the original finding, not a regression: C13 fixed REFINING already-placed corners via keyboard, not INITIAL placement.",
        len(corner_focusables) >= 2 and tapzone == {"role": None, "label": None, "tabindex": None},
        "tapzone=%r; corner-labeled focusables=%r; all focusables=%r" % (tapzone, corner_focusables, focusables),
    )

    hud_hit = pg.evaluate(
        "(()=>{const h=document.querySelector('.pg-cal-hud');const r=h.getBoundingClientRect();"
        "return document.elementFromPoint(r.x+4, r.y+r.height/2).className})()"
    )
    check(
        "4f (control, unaffected by this fix pass) the HUD bar itself is still tap-through: a tap on the bar (not a button) reaches the tapzone",
        hud_hit == "pg-cal-tapzone",
        "elementFromPoint on the bar = %r" % (hud_hit,),
    )
    pg.close()

    # 4g. Destructive control no longer sits on top of a corner tap target
    #     (small phone). 2026-07-28 chrome redesign (correction 13) supersedes
    #     the old single-bar 'order:-1' left-clustering trick (C8) entirely —
    #     Undo/Start over/Accept now live in their own bottom action row,
    #     with the four VISUAL corner-guide rings (GUIDE_FRACS, y=0.845 for
    #     the bottom two) placed to clear it. Assert that invariant directly:
    #     the action row's top edge sits BELOW the guide-ring y on a short
    #     320x568 viewport, so a tap anywhere near a real corner can never
    #     land on a button.
    ctx2 = pg.context.browser.new_context(viewport={"width": 320, "height": 568}, permissions=["camera"])
    pg = new_page(ctx2, port)
    start_calibration(pg)
    tap(pg, 40, 500)  # corner 1 (BOTTOM-LEFT)
    before_hud = huds(pg)[0]

    stage_h = pg.evaluate("document.querySelector('.pg-cal-stage').getBoundingClientRect().height")
    guide_y = 0.845 * stage_h
    bottom_bar_top = pg.evaluate("document.querySelector('.pg-cal-hud-bottom').getBoundingClientRect().top")
    check(
        "4g the bottom action row's top edge sits below the BOTTOM-LEFT/BOTTOM-RIGHT corner-guide fraction (y=0.845) on a short 320x568 viewport — buttons structurally cannot contend with a real corner tap",
        bottom_bar_top > guide_y,
        "stage height=%.1f; guide y=%.1f; action-row top=%.1f" % (stage_h, guide_y, bottom_bar_top),
    )

    btns = pg.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn'))"
        ".map(b=>{const r=b.getBoundingClientRect();return [b.textContent,r.x,r.y,r.width,r.height]})"
    )
    start_over = [b for b in btns if b[0] == "Start over"][0]
    tap(pg, start_over[1] + start_over[3] / 2, start_over[2] + start_over[4] / 2)
    pg.wait_for_timeout(150)
    after_hud = huds(pg)[0]
    check(
        "4g-confirm 'Start over' still works normally from its new position in the dedicated bottom action row",
        "BOTTOM-RIGHT" in before_hud and "1/4" in before_hud and "BOTTOM-LEFT" in after_hud and "0/4" in after_hud,
        "hud before=%r; hud after=%r" % (before_hud, after_hud),
    )
    pg.close()
    ctx2.close()


# ---------------------------------------------------------------------------
# SECTION 5 — B6: TRACKER_MIN_INLIERS gate (now 8) + honest STATIC overlay
# ---------------------------------------------------------------------------
def section5(ctx, port):
    section("SECTION 5 — B6: TRACKER_MIN_INLIERS gate (8) + STATIC overlay honesty")

    # 5a. tracker.init() resolving false must not silently enter 'live' —
    #     the STATIC_OVERLAY_TEXT banner and the STATIC quality pill both
    #     surface it.
    pg = new_page(ctx, port, mode="false")
    start_calibration(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    pg.wait_for_timeout(200)
    banner_hidden = pg.evaluate("document.querySelector('.ar-banner').hidden")
    banner_text = pg.evaluate("document.querySelector('.ar-banner').textContent")
    quality_text = pg.evaluate("document.querySelector('.ar-quality-pill-text').textContent")
    check(
        "5a tracker.init() resolving false enters live honestly: the STATIC overlay banner shows (tracking couldn't start) and the quality pill reads STATIC",
        banner_hidden is False and "Static overlay" in banner_text and quality_text == "STATIC",
        "banner hidden=%r text=%r; quality pill=%r" % (banner_hidden, banner_text, quality_text),
    )
    pg.close()

    # 5b. Per-frame inliers BELOW the gate (7 < TRACKER_MIN_INLIERS=8) are
    #     treated exactly like h:null — currentTrackerH never gets set, so
    #     after the HOLD_STEADY_GRACE_MS (1000ms) window the 'Tracking lost'
    #     banner appears. Asserted behaviorally (via the visible banner), not
    #     by importing the const — the gate's exact value is 8, not the old
    #     10 (R4 widened it).
    pg = new_page(ctx, port, mode="ok")
    pg.evaluate("window.__trackerInliers = 7")
    start_calibration(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    pg.wait_for_timeout(1600)  # > HOLD_STEADY_GRACE_MS
    banner_hidden_b = pg.evaluate("document.querySelector('.ar-banner').hidden")
    banner_text_b = pg.evaluate("document.querySelector('.ar-banner').textContent")
    check(
        "5b inliers=7 (below the gate) never earns a trusted currentTrackerH — 'Tracking lost' appears once the hold-steady grace window elapses",
        banner_hidden_b is False and "Tracking lost" in banner_text_b,
        "banner hidden=%r text=%r" % (banner_hidden_b, banner_text_b),
    )
    pg.close()

    # 5c. Per-frame inliers AT the gate (8, the gate's own boundary) ARE
    #     trusted — no 'Tracking lost' banner ever appears, even well past
    #     the grace window.
    pg = new_page(ctx, port, mode="ok")
    pg.evaluate("window.__trackerInliers = 8")
    start_calibration(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    pg.wait_for_timeout(1600)
    banner_hidden_c = pg.evaluate("document.querySelector('.ar-banner').hidden")
    quality_text_c = pg.evaluate("document.querySelector('.ar-quality-pill-text').textContent")
    check(
        "5c inliers=8 (== TRACKER_MIN_INLIERS, the gate's own boundary — R4 widened it from 10 to 8) IS trusted: no 'Tracking lost' banner past the grace window, and the quality pill leaves STATIC/red",
        banner_hidden_c is True and quality_text_c != "STATIC",
        "banner hidden=%r; quality pill=%r" % (banner_hidden_c, quality_text_c),
    )
    pg.close()


# ---------------------------------------------------------------------------
# SECTION 6 — C11: wake-lock sentinel discipline (R1 — at most one live
# sentinel at any time, zero after exit; wakeLockAcquiring race included)
# ---------------------------------------------------------------------------
def section6(ctx, port):
    section("SECTION 6 — C11: wake-lock sentinel discipline (R1)")

    def new_spy_page(ctx_):
        pg_ = ctx_.new_page()
        pg_.errors = []
        pg_.on("pageerror", lambda e: pg_.errors.append("PAGEERROR: " + str(e)))
        pg_.add_init_script(WAKE_LOCK_MOCK_JS)
        pg_.goto("http://127.0.0.1:%d/index.html" % port)
        pg_.wait_for_function("window.__arReady === true")
        return pg_

    def wl_log(pg_):
        return pg_.evaluate("window.__wakeLockLog")

    # 6a. Full reachable-phase walk: Start -> calibrating -> (stub-accept) ->
    #     live -> freeze -> resume -> exit. At most one live (created-but-
    #     not-yet-released) sentinel exists at any observed checkpoint, and
    #     only ONE navigator.wakeLock.request() call happens across the
    #     WHOLE walk — every later phase transition's acquireWakeLock() call
    #     must be blocked by R1's own `if (wakeLockSentinel || wakeLockAcquiring)
    #     return` guard, not fire a fresh request.
    pg = new_spy_page(ctx)
    start_calibration(pg)
    pg.wait_for_timeout(100)
    log_calibrating = wl_log(pg)
    tap_corners(pg)
    accept(pg)
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    pg.wait_for_timeout(100)
    log_live = wl_log(pg)
    pg.click("button:has-text('FREEZE')")
    pg.wait_for_timeout(100)
    log_freeze = wl_log(pg)
    pg.click("button:has-text('RESUME')")
    pg.wait_for_timeout(100)
    log_resume = wl_log(pg)
    pg.click(".ar-exit-btn")
    pg.wait_for_timeout(100)
    log_exit = wl_log(pg)

    checkpoints = [log_calibrating, log_live, log_freeze, log_resume, log_exit]
    live_at = [c["created"] - c["released"] for c in checkpoints]
    check(
        "6a at most ONE live wake-lock sentinel exists at any observed phase (calibrating/live/freeze/resume/exit)",
        max(live_at) <= 1,
        "live sentinels at each checkpoint (calibrating,live,freeze,resume,exit)=%r" % (live_at,),
    )
    check(
        "6a-confirm exactly ONE navigator.wakeLock.request() call happens across the entire Start->calibrating->live->freeze->resume->exit walk (R1's guard blocks every later phase transition's re-acquire attempt)",
        log_exit["created"] == 1,
        "wake lock log at exit=%r" % (log_exit,),
    )
    check(
        "6a-confirm zero live sentinels remain once Exit AR has torn all the way back to idle",
        live_at[-1] == 0,
        "wake lock log at exit=%r" % (log_exit,),
    )
    pg.close()

    # 6b. wakeLockAcquiring race: a delayed request() that resolves AFTER
    #     the user has already exited must have its just-granted sentinel
    #     released immediately by the `destroyed || phase === 'idle'` bail,
    #     not stranded live forever.
    pg = new_spy_page(ctx)
    pg.evaluate("window.__wakeLockRequestDelayMs = 400")
    pg.click(".ar-idle-btn")  # startCamera() -> showOnly('calibrating') -> acquireWakeLock() fires; request() now pending
    pg.wait_for_timeout(50)  # request is in flight, not yet resolved
    mid_log = wl_log(pg)
    pg.click(".ar-exit-btn")  # Exit AR while the request is still pending
    pg.wait_for_timeout(600)  # let the delayed request() resolve well past the exit
    final_log = wl_log(pg)
    check(
        "6b exit-during-acquire test setup sanity: the request had genuinely not resolved yet when Exit AR fired",
        mid_log["created"] == 0,
        "wake lock log mid-acquire=%r" % (mid_log,),
    )
    check(
        "6b-confirm a wake-lock sentinel that resolves AFTER teardown gets released immediately (wakeLockAcquiring + the post-await destroyed||phase==='idle' bail) — zero live sentinels survive the race",
        final_log["created"] == 1 and final_log["released"] == 1,
        "wake lock log after the race=%r" % (final_log,),
    )
    pg.close()

    # 6c. wakeLockAcquiring guard, specifically (distinct from the
    #     wakeLockSentinel check 6a/6b exercise): a SLOW request() that spans
    #     the calibrating->live transition must block the SECOND
    #     acquireWakeLock() call from ever reaching navigator.wakeLock.request()
    #     a second time while the FIRST is still in flight — not merely from
    #     being ASSIGNED once it resolves. Without wakeLockAcquiring, both
    #     overlapping calls pass the (still-null) wakeLockSentinel check and
    #     each genuinely calls request() — reproducing the original R1
    #     sentinel-leak defect (an orphaned first sentinel, never released)
    #     via a different path than the wakeLockSentinel check alone.
    pg = new_spy_page(ctx)
    pg.evaluate("window.__wakeLockRequestDelayMs = 4000")
    start_calibration(pg)  # 'calibrating' -> acquireWakeLock() call #1, request() now pending for 4s
    tap_corners(pg)
    accept(pg)  # well within the 4s window -> 'live' -> acquireWakeLock() call #2 attempted while #1 is still in flight
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    pg.wait_for_timeout(4500)  # let call #1's (and, if the guard is broken, call #2's) request() resolve
    log_6c = wl_log(pg)
    check(
        "6c wakeLockAcquiring blocks a SECOND acquireWakeLock() call from ever reaching navigator.wakeLock.request() while the FIRST is still in flight (a slow request() spanning calibrating->live) — only ONE request() call happens, not two",
        log_6c["created"] == 1,
        "wake lock log after a slow request spanning calibrating->live=%r" % (log_6c,),
    )
    pg.close()


# ---------------------------------------------------------------------------
# SECTION 7 — C12: video.play() nudges on BOTH the calibrate-mount and the
# calibrating->live transitions
# ---------------------------------------------------------------------------
def section7(ctx, port):
    section("SECTION 7 — C12: video.play() nudges (calibrate.ts mount + arview.ts live transition)")

    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append("PAGEERROR: " + str(e)))
    pg.add_init_script(
        "window.__trackerMode = 'ok'; window.__trackerInitDelayMs = 0;"
        "window.__playLog = [];"
        "var __origPlay = HTMLVideoElement.prototype.play;"
        "HTMLVideoElement.prototype.play = function () { window.__playLog.push(1); return __origPlay.apply(this, arguments); };"
    )
    pg.goto("http://127.0.0.1:%d/index.html" % port)
    pg.wait_for_function("window.__arReady === true")

    start_calibration(pg)
    after_mount = pg.evaluate("window.__playLog.length")
    check(
        "7a calibrate.ts's own play() nudge fires on the idle->calibrating mount (stage.appendChild(feed.video) immediately followed by feed.video.play())",
        after_mount >= 1,
        "play() call count right after calibration mount=%d" % after_mount,
    )

    tap_corners(pg)
    accept(pg)
    pg.wait_for_function("document.querySelector('.ar-frame').hidden === false", timeout=8000)
    after_live = pg.evaluate("window.__playLog.length")
    check(
        "7b arview.ts's OWN play() nudge ALSO fires, independently, on the calibrating->live transition (frame.insertBefore(feed.video, overlayCanvas) immediately followed by feed.video.play()) — a second call beyond the mount-time one",
        after_live > after_mount,
        "play() call count: after mount=%d, after reaching live=%d" % (after_mount, after_live),
    )
    pg.close()


def main():
    global VERBOSE
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    VERBOSE = ap.parse_args().verbose

    out = build_harness()
    srv, port = serve(out)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
        )
        ctx = browser.new_context(viewport={"width": 390, "height": 780}, permissions=["camera"])
        try:
            section1(ctx, port)
            section2(ctx, port)
            section3(ctx, port)
            section4(ctx, port)
            section5(ctx, port)
            section6(ctx, port)
            section7(ctx, port)
        finally:
            browser.close()
            srv.shutdown()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print("\n%d passed, %d failed  (harness: %s)" % (passed, failed, out))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
