#!/usr/bin/env python3
"""
app/tests/calibrate.e2e.py — SUITE 2: deep DOM/interaction tests of the REAL
app/src/ar/calibrate.ts, driven in headless Chromium via Playwright.

Run (must be this interpreter — it's the one with playwright.sync_api and the
cached headless Chromium; the project's own Node toolchain has no Python):

  ~/.local/share/uv/tools/crawl4ai/bin/python app/tests/calibrate.e2e.py

What it does:
  1. Rebuilds the harness (`node tests/calibrate.harness.mjs`) first, so this
     always exercises the CURRENT app/src/ar/calibrate.ts — never a stale
     bundle.
  2. Serves app/tests/.build/ over real HTTP (127.0.0.1:<free port>, plain
     http.server) — not file://, so ResizeObserver/fetch-adjacent semantics
     behave like production.
  3. Drives it with Playwright's sync API at a 390x654 viewport with
     has_touch=True (a real phone's dimensions), using page.mouse for
     precise, timed pointer sequences (down/move/up) — Chromium dispatches
     real `PointerEvent`s for mouse input, which is what calibrate.ts's
     tapzone/handle listeners are attached to.
  4. Runs every REQUIRED assertion from the test spec, plus targeted tests of
     the defects the 2026-07-28 analysis pass found — each is now written
     against the FIXED calibrate.ts (2026-07-28 field-test fix pass: A1/A3/
     A4/B5/C13 in ar/calibrate.ts). Findings recorded below are for anything
     that's genuinely still open, not for the fixed items.

2026-07-28 UPDATE (post-fix-pass test rewrite): the suite's probe_defectN_*
tests previously PROVED a defect existed (bowtie/collinear quads silently
accepted, taps recorded while the camera wasn't live, stale corners surviving
a stage resize, the aria-live region being torn down and rebuilt every
render). Each of those defects is now fixed in ar/calibrate.ts, so the probes
below are INVERTED (same scenario, opposite — now correct — expected
outcome), not deleted; their function names keep the `probe_defectN` lineage
in a comment for traceability. New tests were added for the fix-pass items
that had no test coverage before: quadProblem() unit cases (the exported pure
validator), stage-resize-jitter no-op, and Accept gating on videoWidth===0.

Every test starts from `window.__mountFresh()` (see calibrate.harness.mjs) —
a brand-new mock CameraFeed + brand-new createCalibrationUI() mount, AND a
reset #host size back to 390x654 (a test-isolation fix made alongside this
rewrite — see calibrate.harness.mjs's __mountFresh comment) — so tests are
isolated from each other without the cost of a full page reload.

Prints one JSON object to stdout: {"results": [...], "findings": [...]}.
Exit code 1 if any test's own assertions failed (a real problem with the
harness/test, or a deviation severe enough that the test couldn't complete
its check); exit 0 otherwise — the findings list is where behavioral
deviations in calibrate.ts itself are reported, per the task instructions
("deviations are findings, not test bugs, unless the harness mock is at
fault").
"""

import functools
import http.server
import json
import socket
import socketserver
import subprocess
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

TESTS_DIR = Path(__file__).resolve().parent
APP_DIR = TESTS_DIR.parent
BUILD_DIR = TESTS_DIR / ".build"
HARNESS_MJS = TESTS_DIR / "calibrate.harness.mjs"

VIEWPORT = {"width": 390, "height": 654}

results = []
findings = []


def record(name, outcome, evidence=""):
    results.append({"name": name, "outcome": outcome, "evidence": evidence})


def finding(title, detail, severity="major", proven_by=None, line=None):
    findings.append(
        {
            "file": "app/src/ar/calibrate.ts",
            "line": line,
            "title": title,
            "detail": detail,
            "severity": severity,
            "provenBy": proven_by,
        }
    )


# ---------------------------------------------------------------------------
# Harness helpers
# ---------------------------------------------------------------------------


def mount_fresh(page):
    page.evaluate("window.__mountFresh()")


def set_state(page, state, err_name=None):
    if err_name:
        page.evaluate("(n) => window.__mockFeed.setState('error', {name: n})", err_name)
    else:
        page.evaluate("(s) => window.__mockFeed.setState(s)", state)


def get_handles(page):
    return page.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-handle')).map(h => "
        "({left: h.style.left, top: h.style.top, aria: h.getAttribute('aria-label')}))"
    )


def hud_step(page):
    return page.evaluate("document.querySelector('.pg-cal-hud-step')?.textContent ?? null")


def hud_detail(page):
    return page.evaluate("document.querySelector('.pg-cal-hud-detail')?.textContent ?? null")


def hud_buttons(page):
    return page.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn')).map(b => b.textContent)"
    )


def hud_buttons_full(page):
    """Like hud_buttons but with disabled state — needed for the A3/A4 gating
    tests (Accept present-but-disabled is a different state than absent)."""
    return page.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn')).map(b => "
        "({text: b.textContent, disabled: b.disabled}))"
    )


def canvas_ink(page):
    """Non-transparent pixel count on calibrate.ts's outline canvas — used to
    confirm the outline was actually cleared (not just the handles/HUD)."""
    return page.evaluate(
        "(()=>{const c=document.querySelector('.pg-cal-canvas');if(!c)return -1;"
        "const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;"
        "let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>0)n++;return n})()"
    )


def calibrations(page):
    return page.evaluate("window.__calibrations")


def quad_problem(page, corners):
    """Calls the real exported ar/calibrate.ts `quadProblem()` pure helper
    directly (window.PGCal.quadProblem — confirmed present in the IIFE bundle:
    esbuild's globalName export object includes every named export, verified
    by grepping tests/.build/calibrate.bundle.js for `quadProblem: () =>`)."""
    return page.evaluate("(c) => window.PGCal.quadProblem(c)", corners)


def click_btn(page, text):
    """Clicks the HUD button with exact text via raw coordinates (not
    locator.click()'s actionability machinery) so it exercises the same
    'browser picks the real hit target' path as the tap-through tests. Also
    used to confirm a DISABLED button's raw pointer down/up does NOT fire its
    click handler (HTML's disabled-control semantics), used by the A3 tests
    below instead of relying on locator.click() (which would itself refuse
    to click a disabled element and never prove anything about the app)."""
    box = page.evaluate(
        """(t) => {
        const btn = Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn'))
          .find(b => b.textContent === t);
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }""",
        text,
    )
    assert box is not None, f"click_btn: no HUD button with text {text!r} found"
    page.mouse.move(box["x"], box["y"])
    page.mouse.down()
    page.mouse.up()


def tap(page, x, y):
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.up()


def place_corners(page, points):
    for x, y in points:
        tap(page, x, y)


# A realistic, non-degenerate BL/BR/TR/TL-shaped quad well clear of the
# bottom HUD bar (which lives roughly in the last ~90px of the 654px stage).
QUAD = [(60, 400), (330, 400), (330, 150), (60, 150)]


# ---------------------------------------------------------------------------
# Required-assertion tests
# ---------------------------------------------------------------------------


def test_start_called_once_on_mount(page, page_errors):
    n = page.evaluate("window.__mockFeed.startCallCount")
    assert n == 1, f"expected feed.start() called exactly once on mount, got {n}"


def test_tap_places_handle_and_advances_hud(page, page_errors):
    set_state(page, "live")
    tap(page, 60, 400)
    handles = get_handles(page)
    assert len(handles) == 1, f"expected 1 handle after 1 tap, got {handles}"
    left = float(handles[0]["left"].replace("px", ""))
    top = float(handles[0]["top"].replace("px", ""))
    assert abs(left - 60) <= 1, f"handle left {left} not within 1px of tap x=60"
    assert abs(top - 400) <= 1, f"handle top {top} not within 1px of tap y=400"
    step = hud_step(page)
    assert step is not None and "BOTTOM-RIGHT" in step and "1/4" in step, f"HUD did not advance: {step!r}"


def test_slop_guard_drag_no_corner(page, page_errors):
    set_state(page, "live")
    page.mouse.move(150, 300)
    page.mouse.down()
    page.mouse.move(150 + 20, 300 + 20)  # hypot ~28px > TOUCH_SLOP_PX(10)
    page.mouse.up()
    handles = get_handles(page)
    assert len(handles) == 0, f"expected slop guard to block placement, got {handles}"
    step = hud_step(page)
    assert step is not None and "BOTTOM-LEFT" in step and "0/4" in step, f"HUD advanced despite slop guard: {step!r}"


def test_long_press_guard_no_corner(page, page_errors):
    set_state(page, "live")
    page.mouse.move(150, 300)
    page.mouse.down()
    page.wait_for_timeout(650)  # LONG_PRESS_MS(500) + margin, no movement
    page.mouse.up()
    handles = get_handles(page)
    assert len(handles) == 0, f"expected long-press guard to block placement, got {handles}"
    step = hud_step(page)
    assert step is not None and "BOTTOM-LEFT" in step and "0/4" in step, (
        f"HUD advanced despite long-press guard: {step!r}"
    )


def test_four_taps_all_placed_and_buttons(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    step = hud_step(page)
    assert step == "Drag to refine, then Accept.", f"unexpected HUD text after 4 taps: {step!r}"
    # Correction 13: three ALWAYS-present, equal buttons (Undo / Start over /
    # Accept in README order) — disabled state carries what used to be
    # presence/absence, so all three exist, none disabled, for a sane quad
    # with a ready video.
    btns = hud_buttons_full(page)
    assert [b["text"] for b in btns] == ["Undo", "Start over", "Accept"], f"unexpected button set: {btns}"
    assert all(b["disabled"] is False for b in btns), f"expected all 3 buttons enabled for a sane quad: {btns}"


def test_undo_removes_last_and_steps_back(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    click_btn(page, "Undo")
    handles = get_handles(page)
    assert len(handles) == 3, f"expected 3 handles after Undo from 4, got {len(handles)}"
    step = hud_step(page)
    assert step is not None and "TOP-LEFT" in step and "3/4" in step, f"HUD did not step back correctly: {step!r}"


def test_start_over_clears_all(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD[:2])
    click_btn(page, "Start over")
    handles = get_handles(page)
    assert len(handles) == 0, f"expected 0 handles after Start over, got {handles}"
    step = hud_step(page)
    assert step == "Tap the BOTTOM-LEFT (NEAR THE LEFT FLIPPER) corner of the playfield glass — 0/4", (
        f"unexpected HUD after Start over: {step!r}"
    )
    # Correction 13: buttons are always present now — at 0 corners Undo and
    # Start over are disabled (nothing to undo/reset) and Accept is disabled
    # (not 4/4 yet), rather than not existing at all.
    btns = hud_buttons_full(page)
    assert [b["text"] for b in btns] == ["Undo", "Start over", "Accept"], f"unexpected button set: {btns}"
    assert all(b["disabled"] is True for b in btns), f"expected all 3 buttons disabled at 0 corners, got {btns}"


def test_drag_handle_moves_corner(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    box = page.locator(".pg-cal-handle").nth(0).bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(200, 350, steps=5)
    page.mouse.up()
    handles = get_handles(page)
    assert handles[0]["left"] == "200px" and handles[0]["top"] == "350px", (
        f"drag did not move handle 0 to (200,350): {handles[0]}"
    )
    # other 3 corners must be untouched
    for i, (x, y) in list(enumerate(QUAD))[1:]:
        assert handles[i]["left"] == f"{x}px" and handles[i]["top"] == f"{y}px", (
            f"drag of handle 0 disturbed handle {i}: {handles[i]}"
        )


def test_drag_handle_clamps_at_stage_edges(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    box = page.locator(".pg-cal-handle").nth(0).bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(-80, -80, steps=5)  # off top-left
    page.mouse.up()
    h = get_handles(page)[0]
    assert h["left"] == "0px" and h["top"] == "0px", f"expected clamp to (0,0), got {h}"

    box2 = page.locator(".pg-cal-handle").nth(0).bounding_box()
    cx2, cy2 = box2["x"] + box2["width"] / 2, box2["y"] + box2["height"] / 2
    page.mouse.move(cx2, cy2)
    page.mouse.down()
    page.mouse.move(900, 900, steps=5)  # off bottom-right; stage is 390x654
    page.mouse.up()
    h2 = get_handles(page)[0]
    assert h2["left"] == "390px" and h2["top"] == "654px", f"expected clamp to (390,654), got {h2}"


def test_fifth_tap_ignored(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    before = get_handles(page)
    tap(page, 200, 470)  # a 5th, distinct point
    after = get_handles(page)
    assert after == before, f"5th tap changed handle set: before={before} after={after}"
    step = hud_step(page)
    assert step == "Drag to refine, then Accept.", f"5th tap changed HUD text: {step!r}"


def test_tap_through_hud_text_places_corner(page, page_errors):
    set_state(page, "live")
    tap(page, 60, 400)  # n=1: HUD now shows diagram + text + Undo/Start-over
    box = page.evaluate(
        "(() => { const r = document.querySelector('.pg-cal-hud-text').getBoundingClientRect();"
        " return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()"
    )
    tap(page, box["x"], box["y"])
    handles = get_handles(page)
    assert len(handles) == 2, f"tap on HUD text area did not place a corner through the bar: {handles}"
    left = float(handles[1]["left"].replace("px", ""))
    top = float(handles[1]["top"].replace("px", ""))
    assert abs(left - box["x"]) <= 2 and abs(top - box["y"]) <= 2, (
        f"corner placed by tap-through not at the tapped point: handle={handles[1]} tap={box}"
    )


def test_tap_on_undo_button_does_not_place_corner(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD[:2])  # n=2, Undo button present
    before = len(get_handles(page))
    box = page.evaluate(
        "(() => { const btns = Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn'));"
        " const undo = btns.find(b => b.textContent === 'Undo');"
        " const r = undo.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()"
    )
    tap(page, box["x"], box["y"])
    after = get_handles(page)
    assert len(after) == before - 1, (
        f"tap on Undo button should only Undo (n-1), not also place a corner: before={before} after={len(after)}"
    )


def test_camera_suspended_swaps_hud_and_records_stale_corners(page, page_errors):
    set_state(page, "live")
    tap(page, 60, 400)
    assert len(get_handles(page)) == 1

    set_state(page, "suspended")
    handles_suspended = get_handles(page)
    step = hud_step(page)
    detail = hud_detail(page)
    assert step == "Line up the machine", f"unexpected HUD step while suspended: {step!r}"
    assert detail == "Camera paused", f"unexpected HUD detail while suspended: {detail!r}"
    assert handles_suspended == [], f"expected handles hidden while suspended, got {handles_suspended}"

    set_state(page, "live")
    handles_after = get_handles(page)
    step_after = hud_step(page)
    assert len(handles_after) == 1 and handles_after[0]["left"] == "60px" and handles_after[0]["top"] == "400px", (
        f"expected the pre-suspend corner to reappear unchanged once live again, got {handles_after}"
    )
    assert step_after is not None and "BOTTOM-RIGHT" in step_after and "1/4" in step_after, (
        f"HUD did not resume at the correct step after suspend/live cycle: {step_after!r}"
    )
    finding(
        "Corner data is retained (not invalidated) while camera state is 'suspended' — INTENTIONAL, not a defect",
        "calibrate.ts's manualCorners array is never touched by camera-state changes: placing a corner then "
        "backgrounding the tab (state -> 'suspended', handles hidden via updateHandles()'s cameraState !== 'live' "
        "guard) and returning to the foreground (state -> 'live') brings the SAME corner back at the SAME "
        "position with no re-validation. The 2026-07-28 analysis pass explicitly refuted this as a defect "
        "('Corners retained across camera suspend' — intended behavior, resume where you left off) — recorded "
        "here only as a confirmed characterization, not a problem. Contrast with the B5 fix (stage RESIZE while "
        "corners are placed DOES now clear them — a real geometry change, unlike a suspend/resume with no resize).",
        severity="minor",
        proven_by="test_camera_suspended_swaps_hud_and_records_stale_corners",
    )


def test_camera_error_swaps_hud(page, page_errors):
    set_state(page, "live")
    tap(page, 60, 400)
    set_state(page, "error", "NotAllowedError")
    step = hud_step(page)
    detail = hud_detail(page)
    assert step == "Camera problem", f"unexpected HUD step on camera error: {step!r}"
    assert detail == "Camera access denied — allow it in your browser settings and reload", (
        f"unexpected HUD detail on camera error: {detail!r}"
    )
    assert get_handles(page) == [], f"expected handles hidden on camera error, got {get_handles(page)}"


def test_accept_fires_onCalibrated_with_refined_corners(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    box = page.locator(".pg-cal-handle").nth(0).bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(250, 380, steps=5)
    page.mouse.up()
    handles_before_accept = get_handles(page)

    click_btn(page, "Accept")
    cals = calibrations(page)
    assert len(cals) == 1, f"expected exactly 1 onCalibrated call, got {len(cals)}"
    corners = cals[0]["corners"]
    assert len(corners) == 4, f"expected 4 [x,y] pairs, got {len(corners)}: {corners}"
    for i, h in enumerate(handles_before_accept):
        hx = float(h["left"].replace("px", ""))
        hy = float(h["top"].replace("px", ""))
        cx_, cy_ = corners[i]
        assert abs(cx_ - hx) <= 1e-6 and abs(cy_ - hy) <= 1e-6, (
            f"corner {i} {corners[i]} does not match refined handle {h}"
        )
    assert corners[0][0] == 250 and corners[0][1] == 380, f"refined corner 0 not reflected in Accept payload: {corners[0]}"


def test_reset_after_accept_returns_to_corner1(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    click_btn(page, "Accept")
    # R5: post-Accept the HUD is the buttonless "Locking on…" progress state
    # (was: "Locked on" + a local Recalibrate button — that button called
    # this module's own fullReset() without arview.ts's sessionGen ever
    # learning about it, so the tracker.init() continuation could yank the
    # user back out of a restart they'd already made — see calibrate.ts's
    # calibrated-branch comment). reset() below is arview.ts's own escape
    # hatch (degenerate-catch), not anything reachable from the HUD itself.
    assert hud_step(page) == "Locking on…", f"expected the buttonless Locking-on HUD post-Accept, got {hud_step(page)!r}"

    page.evaluate("window.__handle.reset()")
    step = hud_step(page)
    assert step == "Tap the BOTTOM-LEFT (NEAR THE LEFT FLIPPER) corner of the playfield glass — 0/4", (
        f"reset() did not return to corner-1 state: {step!r}"
    )
    assert get_handles(page) == [], f"expected no handles after reset(), got {get_handles(page)}"

    # Functional check, not just visual: tapping now must actually place a
    # corner again (calibrated flag really cleared, not just its HUD text).
    tap(page, 60, 400)
    assert len(get_handles(page)) == 1, "reset() left the UI unable to accept new taps (calibrated flag stuck?)"


# ---------------------------------------------------------------------------
# quadProblem() unit tests (A3 — new pure-function coverage). Exact vectors
# below were empirically verified against the real bundled function before
# being written as assertions (not guessed from the source's own doc
# comment) — see the source's BL=(0,100)/BR=(100,100)/TR=(100,0)/TL=(0,0)
# concrete example for the winding-sign derivation this exercises.
# ---------------------------------------------------------------------------


def test_quadproblem_sane_trapezoid_is_null(page, page_errors):
    sane = [[60, 400], [330, 400], [330, 150], [60, 150]]  # correct BL,BR,TR,TL
    assert quad_problem(page, sane) is None, f"expected a sane trapezoid to pass, got {quad_problem(page, sane)!r}"


def test_quadproblem_coincident_pair(page, page_errors):
    coincident = [[100, 300], [103, 302], [260, 40], [40, 40]]  # BL/BR ~3.6px apart (<8px)
    reason = quad_problem(page, coincident)
    assert reason == "Two corners are on top of each other", f"unexpected reason: {reason!r}"


def test_quadproblem_bowtie(page, page_errors):
    # BL/BR swapped relative to a clean trapezoid — self-intersecting.
    bowtie = [[300, 500], [50, 500], [300, 100], [50, 100]]
    reason = quad_problem(page, bowtie)
    assert reason is not None and "crossed" in reason, f"expected a crossed/bowtie reason, got {reason!r}"


def test_quadproblem_mirrored_tap_order(page, page_errors):
    # A fully correct-shaped quad tapped in the WRONG (reversed/clockwise)
    # order — TL,TR,BR,BL instead of BL,BR,TR,TL. Uniform edge signs, but the
    # wrong sign (this is exactly what the source doc comment calls out as
    # the second thing the single sign-check catches, distinct from a bowtie).
    mirrored = [[0, 0], [100, 0], [100, 100], [0, 100]]
    reason = quad_problem(page, mirrored)
    assert reason is not None and "crossed" in reason, f"expected mirrored tap order to be flagged, got {reason!r}"


def test_quadproblem_tiny_area(page, page_errors):
    tiny = [[100, 120], [120, 120], [120, 100], [100, 100]]  # correct winding, 20x20=400px^2 < 1000
    reason = quad_problem(page, tiny)
    assert reason == "Corners are too close together", f"unexpected reason: {reason!r}"


def test_quadproblem_wrong_corner_count(page, page_errors):
    reason = quad_problem(page, [[0, 0], [1, 0], [1, 1]])
    assert reason == "Need exactly 4 corners", f"unexpected reason for a 3-corner input: {reason!r}"


# ---------------------------------------------------------------------------
# Fixed-defect tests (2026-07-28 field-test fix pass). Each of these used to
# be a probe_defectN_* that PROVED a defect; now inverted to assert the fix.
# Former names kept in each docstring for traceability.
# ---------------------------------------------------------------------------


def test_defect1_collinear_corners_now_blocked(page, page_errors):
    """Was probe_defect1_throwing_onCalibrated. 4 collinear taps (the exact
    input that used to make ar/homography.ts's computeHomography() throw
    downstream in arview.ts) are now caught by quadProblem() at the calibrate
    UI itself, BEFORE Accept can ever fire — Accept renders disabled and a
    raw pointer down/up on it (bypassing locator.click()'s own disabled-
    element refusal) does nothing, proving the guard is real HTML `disabled`
    state, not just visual styling."""
    set_state(page, "live")
    place_corners(page, [(60, 400), (150, 400), (240, 400), (330, 400)])  # all y=400
    step = hud_step(page)
    assert step == "Corners look wrong", f"expected collinear taps to be flagged, got {step!r}"
    detail = hud_detail(page)
    assert detail is not None and "crossed or out of order" in detail, f"unexpected detail: {detail!r}"
    btns = hud_buttons_full(page)
    accept_btn = next((b for b in btns if b["text"] == "Accept"), None)
    assert accept_btn is not None and accept_btn["disabled"] is True, f"expected a disabled Accept button, got {btns}"

    # Raw-coordinate click attempt on the disabled button — must not fire.
    click_btn(page, "Accept")
    page.wait_for_timeout(50)
    cals = calibrations(page)
    assert cals == [], f"clicking a disabled Accept must not fire onCalibrated, got {cals}"
    assert hud_step(page) == "Corners look wrong", "HUD state changed despite Accept being disabled"


def test_defect2_bowtie_now_blocked(page, page_errors):
    """Was probe_defect2_bowtie_no_validation. A self-intersecting (bowtie)
    tap order is now caught the same way as the collinear case above —
    Accept disabled, click is a no-op, no onCalibrated call."""
    set_state(page, "live")
    bowtie = [(50, 100), (300, 500), (50, 500), (300, 100)]  # crosses itself in tap order
    place_corners(page, bowtie)
    step = hud_step(page)
    assert step == "Corners look wrong", f"expected bowtie quad to be flagged, got {step!r}"
    btns = hud_buttons_full(page)
    accept_btn = next((b for b in btns if b["text"] == "Accept"), None)
    assert accept_btn is not None and accept_btn["disabled"] is True, f"expected a disabled Accept button, got {btns}"
    click_btn(page, "Accept")
    page.wait_for_timeout(50)
    assert calibrations(page) == [], "Accept on a bowtie quad must not fire onCalibrated"
    # Undo/Start over must still work from this blocked state (not a dead end).
    click_btn(page, "Undo")
    step_after_undo = hud_step(page)
    assert step_after_undo is not None and "TOP-LEFT" in step_after_undo and "3/4" in step_after_undo, (
        f"Undo from a blocked bad-quad state did not step back correctly: {step_after_undo!r}"
    )


def test_defect3_stage_resize_now_invalidates_corners(page, page_errors):
    """Was probe_defect3_stale_corners_on_stage_resize. A resize >24px
    (STAGE_RESIZE_JITTER_PX) with in-progress taps now CLEARS manualCorners,
    shows a 'Screen changed — start over' notice, and clears the outline
    canvas — instead of silently keeping stale off-stage px."""
    set_state(page, "live")
    # Correction 13 always draws 4 static corner-guide rings on this same
    # canvas (guides only, unrelated to placed corners), so "cleared" no
    # longer means literally 0 ink — sanity-check the guides-only baseline
    # renders before any taps, then assert the post-resize canvas is back to
    # THAT (guides only, no quad outline), not literally empty.
    baseline_ink = canvas_ink(page)
    assert baseline_ink > 0, f"expected the 4 static corner-guide rings to render even with 0 corners placed, got {baseline_ink}"
    tap(page, 370, 300)  # near the right edge of the 390-wide stage
    tap(page, 370, 450)
    handles_before = get_handles(page)
    assert len(handles_before) == 2

    page.evaluate("window.__setStageSize(150, 654)")  # simulate a drastic width collapse (>24px)
    page.wait_for_timeout(150)  # let the ResizeObserver callback run

    rect_after = page.evaluate("window.__stageRect()")
    assert rect_after["width"] == 150, f"harness resize control did not take effect: {rect_after}"
    handles_after = get_handles(page)
    assert handles_after == [], f"expected corners cleared after a >24px resize, got {handles_after}"
    step = hud_step(page)
    assert step == "Screen changed — start over", f"expected the resize notice, got {step!r}"
    detail = hud_detail(page)
    assert detail == "Corner taps reset because the view resized (rotation/toolbar)", f"unexpected detail: {detail!r}"
    ink = canvas_ink(page)
    assert ink > 0, f"expected the (resized) corner-guide rings still present, got {ink} ink px"

    # Functional, not just visual: tapping now places a FRESH corner 1.
    tap(page, 60, 400)
    assert len(get_handles(page)) == 1, "resize notice left tapping unable to place a new corner 1"
    post_resize_step = hud_step(page)
    assert post_resize_step is not None and "BOTTOM-RIGHT" in post_resize_step and "1/4" in post_resize_step, (
        f"post-resize tap did not advance the HUD normally: {post_resize_step!r}"
    )


def test_stage_resize_jitter_under_threshold_is_a_noop(page, page_errors):
    """New coverage alongside the B5 fix: a resize AT OR UNDER
    STAGE_RESIZE_JITTER_PX (24px — safe-area/URL-bar micro-shifts) must NOT
    clear in-progress corners. Without this the fix above would be trivial
    to over-trigger (any 1px layout jitter wiping a user's taps)."""
    page.evaluate("window.__setStageSize(390, 654)")  # explicit baseline (belt-and-suspenders with mountFresh's own reset)
    set_state(page, "live")
    tap(page, 370, 300)
    tap(page, 370, 450)
    handles_before = get_handles(page)
    assert len(handles_before) == 2

    page.evaluate("window.__setStageSize(380, 654)")  # 10px < 24px threshold
    page.wait_for_timeout(150)

    handles_after = get_handles(page)
    assert handles_after == handles_before, f"a sub-threshold (10px) resize must not clear corners: {handles_after}"
    step = hud_step(page)
    assert step is not None and "TOP-RIGHT" in step and "2/4" in step, (
        f"HUD state disturbed by jitter-level resize: {step!r}"
    )


def test_defect5_aria_live_node_now_stable(page, page_errors):
    """Was probe_defect5_aria_live_node_replaced_each_render. The persistent-
    slots fix (C13) means updateCardDom() clears the SLOTS' children, never
    the textWrap node itself — a screen reader tracking the aria-live region
    by node identity now sees mutations on a stable node, not a stream of
    inserted/removed elements."""
    set_state(page, "live")
    marked = page.evaluate(
        "(() => { const el = document.querySelector('[aria-live]'); "
        "if (!el) return false; el.dataset.pgProbe = 'x'; return el.dataset.pgProbe === 'x'; })()"
    )
    assert marked, "setup failed: could not mark the initial [aria-live] node"
    tap(page, 60, 400)  # advances HUD, forces a re-render
    still_marked = page.evaluate("document.querySelector('[aria-live]')?.dataset.pgProbe === 'x'")
    node_count = page.evaluate("document.querySelectorAll('[aria-live]').length")
    assert still_marked is True, "the [aria-live] node was replaced by a re-render instead of being reused"
    assert node_count == 1, f"expected exactly one [aria-live] node at all times, found {node_count}"
    step = hud_step(page)
    assert step is not None and "BOTTOM-RIGHT" in step and "1/4" in step, (
        f"HUD text did not actually update on the stable node: {step!r}"
    )


def test_extra_tap_now_ignored_while_camera_not_live(page, page_errors):
    """Was probe_extra_tap_recorded_while_camera_not_live. The tapzone's
    pointerup handler now gates on cameraState === 'live' (A4) — a tap
    against the black 'Starting camera…' stage is dropped outright, not
    silently pre-filled and revealed later once the feed catches up."""
    state = page.evaluate("window.__mockFeed.getState()")
    assert state == "stopped", f"harness assumption violated: expected initial state 'stopped', got {state!r}"
    tap(page, 60, 400)
    handles_after_tap_while_stopped = get_handles(page)
    assert handles_after_tap_while_stopped == [], f"tap while not-live rendered a handle immediately: {handles_after_tap_while_stopped}"

    set_state(page, "live")
    handles_after_going_live = get_handles(page)
    step_after_going_live = hud_step(page)
    assert handles_after_going_live == [], (
        f"tap taken while camera wasn't live was silently recorded and revealed once live: {handles_after_going_live}"
    )
    assert step_after_going_live == "Tap the BOTTOM-LEFT (NEAR THE LEFT FLIPPER) corner of the playfield glass — 0/4", (
        f"HUD advanced from a tap that should have been dropped: {step_after_going_live!r}"
    )

    # Functional confirmation: NOW that the camera is live, the same tap
    # location works normally.
    tap(page, 60, 400)
    assert len(get_handles(page)) == 1, "a tap made after going live should place a corner normally"


# ---------------------------------------------------------------------------
# A4 — Accept gating on videoWidth===0 (new coverage; no prior probe existed
# for this specific defect, which was previously an unguarded arview.ts-side
# ~947px overlay-offset bug — see homography.deep.test.mjs section f4/f5's
# 2026-07-28 update for the arview-side half of this fix).
# ---------------------------------------------------------------------------


def test_accept_disabled_when_videoWidth_zero(page, page_errors):
    page.evaluate("window.__mockFeed.setVideoSize(0, 0)")
    set_state(page, "live")  # cameraState can be 'live' before the first frame has real dimensions
    place_corners(page, QUAD)
    step = hud_step(page)
    assert step == "All 4 corners placed", f"unexpected HUD step: {step!r}"
    detail = hud_detail(page)
    assert detail == "Camera still starting — one moment", f"unexpected detail: {detail!r}"
    btns = hud_buttons_full(page)
    accept_btn = next((b for b in btns if b["text"] == "Accept"), None)
    assert accept_btn is not None and accept_btn["disabled"] is True, f"expected disabled Accept, got {btns}"
    click_btn(page, "Accept")
    page.wait_for_timeout(50)
    assert calibrations(page) == [], "Accept must not fire onCalibrated while videoWidth===0"

    # Self-heals once real video metadata is available (R3): calibrate.ts
    # now wires `feed.video.addEventListener('loadedmetadata', onVideoMeta)`
    # (onVideoMeta = () => render()) in createCalibrationUI, removed again in
    # destroy() — so the honest trigger is a real 'loadedmetadata' Event
    # dispatched on the mock <video> element itself, NOT another camera-state
    # transition (re-firing 'live' would only coincidentally re-render via
    # the SEPARATE onStateChange listener, masking whether the dedicated
    # metadata listener actually exists).
    page.evaluate("window.__mockFeed.setVideoSize(1280, 720)")
    page.evaluate(
        "document.querySelector('.pg-cal-stage video').dispatchEvent(new Event('loadedmetadata'))"
    )
    # Correction 13: the ready n===4 state is the single adopted handoff line
    # (no separate detail line), not the old two-line 'All 4 corners placed'
    # / 'Drag the handles to refine' pair.
    step2 = hud_step(page)
    assert step2 == "Drag to refine, then Accept.", f"expected the self-heal once video is ready, got {step2!r}"
    detail2 = hud_detail(page)
    assert detail2 is None, f"expected no separate detail line once ready, got {detail2!r}"
    btns2 = hud_buttons_full(page)
    accept_btn2 = next((b for b in btns2 if b["text"] == "Accept"), None)
    assert accept_btn2 is not None and accept_btn2["disabled"] is False, f"expected Accept re-enabled, got {btns2}"
    click_btn(page, "Accept")
    assert len(calibrations(page)) == 1, "Accept should fire normally once video dimensions are real"


# ---------------------------------------------------------------------------
# C13 a11y: button sizing + handle keyboard support (new coverage)
# ---------------------------------------------------------------------------


def test_hud_buttons_are_44px_min_height(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD[:2])  # n=2, Undo/Start over present
    sizes = page.evaluate(
        "Array.from(document.querySelectorAll('.pg-cal-hud-actions .pg-cal-btn')).map(b => {"
        "const r = b.getBoundingClientRect(); return [b.textContent, Math.round(r.height)]; })"
    )
    assert len(sizes) > 0, "expected at least one HUD button to measure"
    for label, h in sizes:
        assert h >= 44, f"button {label!r} is {h}px tall, below the 44px touch-target minimum: {sizes}"


def test_handle_keyboard_arrow_moves_corner(page, page_errors):
    set_state(page, "live")
    place_corners(page, QUAD)
    handle = page.locator(".pg-cal-handle").nth(0)
    assert handle.get_attribute("tabindex") == "0", "corner handles must be keyboard-focusable (tabindex=0)"
    before = get_handles(page)[0]
    handle.focus()
    page.keyboard.press("ArrowRight")
    page.keyboard.press("ArrowDown")
    after = get_handles(page)[0]
    left_before = float(before["left"].replace("px", ""))
    left_after = float(after["left"].replace("px", ""))
    top_before = float(before["top"].replace("px", ""))
    top_after = float(after["top"].replace("px", ""))
    assert left_after == left_before + 2, f"ArrowRight should move the corner 2px (ARROW_STEP_PX): {before} -> {after}"
    assert top_after == top_before + 2, f"ArrowDown should move the corner 2px: {before} -> {after}"
    valuetext = page.evaluate("document.querySelectorAll('.pg-cal-handle')[0].getAttribute('aria-valuetext')")
    assert valuetext == f"Corner 1 at {int(left_after)}, {int(top_after)}", f"aria-valuetext not updated: {valuetext!r}"

    # Shift+Arrow uses the larger 10px step.
    page.keyboard.press("Shift+ArrowRight")
    after2 = get_handles(page)[0]
    left_after2 = float(after2["left"].replace("px", ""))
    assert left_after2 == left_after + 10, f"Shift+ArrowRight should move 10px (ARROW_STEP_SHIFT_PX): {after} -> {after2}"


TESTS = [
    ("start_called_once_on_mount", test_start_called_once_on_mount),
    ("tap_places_handle_and_advances_hud", test_tap_places_handle_and_advances_hud),
    ("slop_guard_drag_no_corner", test_slop_guard_drag_no_corner),
    ("long_press_guard_no_corner", test_long_press_guard_no_corner),
    ("four_taps_all_placed_and_buttons", test_four_taps_all_placed_and_buttons),
    ("undo_removes_last_and_steps_back", test_undo_removes_last_and_steps_back),
    ("start_over_clears_all", test_start_over_clears_all),
    ("drag_handle_moves_corner", test_drag_handle_moves_corner),
    ("drag_handle_clamps_at_stage_edges", test_drag_handle_clamps_at_stage_edges),
    ("fifth_tap_ignored", test_fifth_tap_ignored),
    ("tap_through_hud_text_places_corner", test_tap_through_hud_text_places_corner),
    ("tap_on_undo_button_does_not_place_corner", test_tap_on_undo_button_does_not_place_corner),
    ("camera_suspended_swaps_hud_and_records_stale_corners", test_camera_suspended_swaps_hud_and_records_stale_corners),
    ("camera_error_swaps_hud", test_camera_error_swaps_hud),
    ("accept_fires_onCalibrated_with_refined_corners", test_accept_fires_onCalibrated_with_refined_corners),
    ("reset_after_accept_returns_to_corner1", test_reset_after_accept_returns_to_corner1),
    ("quadproblem_sane_trapezoid_is_null", test_quadproblem_sane_trapezoid_is_null),
    ("quadproblem_coincident_pair", test_quadproblem_coincident_pair),
    ("quadproblem_bowtie", test_quadproblem_bowtie),
    ("quadproblem_mirrored_tap_order", test_quadproblem_mirrored_tap_order),
    ("quadproblem_tiny_area", test_quadproblem_tiny_area),
    ("quadproblem_wrong_corner_count", test_quadproblem_wrong_corner_count),
    ("defect1_collinear_corners_now_blocked", test_defect1_collinear_corners_now_blocked),
    ("defect2_bowtie_now_blocked", test_defect2_bowtie_now_blocked),
    ("defect3_stage_resize_now_invalidates_corners", test_defect3_stage_resize_now_invalidates_corners),
    ("stage_resize_jitter_under_threshold_is_a_noop", test_stage_resize_jitter_under_threshold_is_a_noop),
    ("defect5_aria_live_node_now_stable", test_defect5_aria_live_node_now_stable),
    ("extra_tap_now_ignored_while_camera_not_live", test_extra_tap_now_ignored_while_camera_not_live),
    ("accept_disabled_when_videoWidth_zero", test_accept_disabled_when_videoWidth_zero),
    ("hud_buttons_are_44px_min_height", test_hud_buttons_are_44px_min_height),
    ("handle_keyboard_arrow_moves_corner", test_handle_keyboard_arrow_moves_corner),
]


# ---------------------------------------------------------------------------
# Server plumbing
# ---------------------------------------------------------------------------


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_server(directory, port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))

    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    httpd = ReusableTCPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def run_test(page, name, fn):
    page_errors = []
    handler = lambda e: page_errors.append(str(e))
    page.on("pageerror", handler)
    try:
        mount_fresh(page)
        fn(page, page_errors)
        record(name, "pass", "")
    except AssertionError as e:
        record(name, "fail", str(e))
    except Exception as e:  # noqa: BLE001 - test harness catch-all, reported not swallowed
        record(name, "fail", f"{type(e).__name__}: {e}")
    finally:
        page.remove_listener("pageerror", handler)


def main():
    build = subprocess.run(["node", str(HARNESS_MJS)], cwd=str(APP_DIR), capture_output=True, text=True)
    if build.returncode != 0:
        print(json.dumps({"results": [], "findings": [], "buildError": build.stdout + build.stderr}, indent=2))
        sys.exit(1)

    port = free_port()
    httpd = start_server(BUILD_DIR, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport=VIEWPORT, has_touch=True)
            page = context.new_page()
            page.goto(f"http://127.0.0.1:{port}/index.html")
            page.wait_for_load_state("networkidle")

            for name, fn in TESTS:
                run_test(page, name, fn)

            browser.close()
    finally:
        httpd.shutdown()

    report = {"results": results, "findings": findings}
    print(json.dumps(report, indent=2))
    failed = sum(1 for r in results if r["outcome"] != "pass")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
