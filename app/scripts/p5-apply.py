#!/usr/bin/env python3
"""P5 applier — vision coordinate pass (Task A) + flagship zone unlock
(Task B). Dataset schema v5 (see app/src/models.ts's Shot/PlayfieldZone doc
comments).

Consumes _Business/catalog-passes/p5/batch-{1..12}.json (vision sweep:
{machines:[{machine, image:{url,verdict,...}, calibration?, results:[{id,
data:{x,y}, placed:{x,y}, delta, verdict, confidence, landmark}],
reviewQueue:[ids], bounds?}]}) — 141 machines, exactly 1:1 with data/*.json
(checked live, zero misses). Also reads
_Business/FLAGSHIP-DEEP-PASS-2026-08-10.json (a research+verify pair for
jaws/evil_dead/halloween whose own zone/bounds FINDINGS were REFUTED by its
own verify pass on methodology grounds — a PCB fabrication drawing misread
as a deck schematic for evil_dead, a shared-chassis Ultraman photo's wrong
quadrant for halloween) and _Business/VISION-PILOT-JAWS-2026-08-10.json (the
triage philosophy this whole pass follows: confidence is the load-bearing
signal, banks/regions score presence-only, high-confidence flags are the
ones worth a second look).

`machine` KEY FORMAT is INCONSISTENT across the 12 batch files (checked
live) — three conventions in play: bare stem ("abra_ca_dabra", batches
1-3/8), "_goals"-suffixed bare key ("jaws_goals", batches 6/11/12), and the
data file's own display `machine` string ("Godzilla (Stern, 2021)", batches
4/5/7/9/10). resolve_machine() below handles all three uniformly; checked
live that it resolves every one of the 141 entries to exactly one
data/*.json stem, zero collisions, zero misses.

TASK A — coordinate fixes
==========================
Conservative by design: apply a result's `placed` (x,y) over the shot's
existing `data` (x,y) ONLY when EVERY one of these holds (checked live
against the full corpus before writing the selection logic, not assumed):

  * the machine's image verdict is affirmatively usable — exactly 'ok',
    'found', or 'usable' (NOT 'found-partial'/'ok-partial': these mean the
    photo does not cover part of the machine, e.g. ac_dc's Pro-edition photo
    physically missing the Premium/LE-only Underworld deck — a distinct,
    weaker verdict than bare 'ok', not a synonym for it; conservative-by-
    design cuts the same way here, so a *-partial machine's results all
    fall through to reviewQueue uniformly rather than being individually
    re-examined) AND calibration is present. Checked live: every non-
    'no-image' machine in this corpus already carries calibration (0
    counterexamples) — this clause is a no-op safety net today, kept
    because the task's guard list asks for it explicitly.
  * the result's own `confidence` is exactly 'high' — not 'medium-high',
    'low-medium', 'n/a', or absent (the corpus uses all four); exact string
    match only.
  * `delta` is present (non-null) and <= 0.30. Beyond that this run treats
    the disagreement as a PLACEMENT error (the sweep misread the photo), not
    a DATA error — refused into reviewQueue, not trusted.
  * the result is NOT a bank/multi-instance (regional-presence) entry.
    Checked live: this corpus spells bank-class verdicts nine different ways
    across batches (region-check, region-ok, regional, regional-presence,
    region, bank-region, bank-regional, bank-regional-only, regional-bank)
    — matched here with one `region|bank` substring regex rather than a
    9-way exact-string enumeration: verified live this reproduces the exact
    same 283-entry set the nine literal strings do, zero false positives
    against 'flagged'/'ok'/'unlocatable'. NOT redundant with the delta check
    above — checked live, 142 of those 283 bank-class results carry a
    NON-NULL delta (some under 0.30); without this separate check a handful
    of bank entries would silently pass as ordinary single-point fixes.
  * the landmark note names a specific visual anchor, not a hedge. Checked
    live: all 417 'high'-confidence results in this corpus already have
    landmark text clear of "by elimination"/"assumed" (0 exceptions) — this
    guard is unexercised today, kept per the task's explicit guard list as
    defense-in-depth against a future/different corpus, not dead code.
  * the shot is not a `type:'flipper'` sitting at the templated pivot
    (0.33,0.05) or (0.67,0.05) EXACTLY — that pair is a convention stamped
    across dozens of files (detect-coverage.py's own templated_flipper_pairs
    counter), not a measured position; a "fix" against it would overwrite a
    deliberate placeholder, not correct an error.
  * the machine is NOT flagship (jaws/evil_dead/halloween): a qualifying
    flagship result is diverted to `flagshipCoordFlags` for owner review
    instead of `coordFixes` — never auto-applied, same carve-out
    p2/p3/p4/anchor-apply.py all make for these three files, just on
    different fields.

Everything that fails any of the above — including an unresolvable shot id,
a non-numeric `placed`, a *-partial image machine, or a write-phase refusal
below — lands in `reviewQueue`: a lightweight {count, byMachine} tally per
the task's own output shape, not an itemized list (the console summary
prints a fuller reason-kind breakdown for visibility, matching p3/p4's own
"refusal_kinds" convention).

Guards on the WRITE path (house pattern — read p3/p4/anchor-apply.py before
touching this file: each guard exists because a prior applier shipped a
defect without it; refusals are expected output, not failures):
  * round-trip no-op self-test per file, checked ONCE per file at load time:
    json.dumps(doc, indent=2)+"\\n" must reproduce the file byte-for-byte.
    6 of 141 files fail this today (checked live) — avatar, csi,
    cue_ball_wizard, harry_potter, starship_troopers, tron_legacy (one more
    than p3/p4's own 5 — harry_potter, per anchor-apply.py's own finding,
    for a DIFFERENT reason: literal \\u2014 escapes json.dumps normalizes
    away). cue_ball_wizard/starship_troopers/tron_legacy have zero real
    candidates here regardless (no-image or *-partial image verdict);
    avatar/csi/harry_potter do and are refused by this guard specifically.
  * verbatim current-match: the target shot's LIVE (x,y) must equal the
    result's own `data` (x,y) exactly at write time, or the fix is refused
    as 'file moved since the sweep' — this run does not assume nothing else
    touched data/ between the sweep and this apply.
  * one-write-per-shot: a (machine,shot) pair proposed twice in one run
    (never happens in this corpus — checked live, 0 duplicate result ids
    within any machine's results[] — implemented anyway per the same
    unexercised-guard convention) is refused as a conflict, not silently
    resolved by taking the last one.
  * per-machine backup to scratchpad/data-backup-p5/ before that machine's
    single combined write; validate-machines.py must stay clean for THIS
    machine's file (ERROR-line filename prefix, matching every prior
    applier's convention) or the pre-write backup is restored (file +
    in-memory doc, both via atomic_write — anchor-apply.py's own upgrade
    over p2/p3/p4's plain write_text/shutil.copy2, since the vision-sweep
    workflow and this run both touch data/ around the same time) and the
    run continues with the remaining machines either way.

TASK B — zone unlock (evil_dead's basement, halloween's house/sanitarium)
============================================================================
The vision sweep's `bounds{}` block is the ONLY bounds source used here —
FLAGSHIP-DEEP-PASS's own numeric bounds/coordinate proposals were REFUTED
(evil_dead: bounds read off a PCB fabrication drawing, not a deck schematic;
halloween: bounds read off the wrong quadrant of a shared-chassis photo) and
are treated as superseded. FLAGSHIP-DEEP-PASS is read here ONLY for
non-numeric, verify-CONFIRMED facts that don't depend on its refuted
geometry — e.g. that evil_dead's existing `cellar-door` shot (pre-existing
canonical data, notes already read "drops the ball to the RGB-lit
fruit-cellar lower playfield") is genuinely the basement's entry mechanism.

Both zone attempts share ONE mechanism (attempt_zone_unlock): build the
zone(s) + member playfield refs from the sweep's bounds, mutate a fresh copy
of the doc, run it through the SAME write_validate_rollback used by Task A
(backup, atomic write, validate-machines.py, rollback on ANY red — "per
machine", i.e. evil_dead's one zone and halloween's two zones each live or
die as a single combined write, matching every P-series applier's own
one-combined-write-per-machine convention). A machine's zone report is
"applied" only if that validator run comes back clean; otherwise "parked"
with the validator's own error lines as the reason. This is a REAL, live
determination — not asserted here — because a mechanical check (run before
writing this script, replicating validate-machines.py's own containment
math exactly) found something the task's own conservative recoordination
rule was clearly built to handle: EVERY one of the 3 evil_dead basement
members and ALL 9 halloween deck members sit outside the newly-extracted
bounds using their EXISTING (pre-sweep) coordinates, and NONE of the 12
carries a 'high'-confidence sweep placement to recoordinate to (evil_dead:
medium/medium/low; halloween: low/low/low/medium/low for house, medium x3 +
low for sanitarium) — so the task's own rule ("re-coordinate ... only if
... high confidence, else leave and let the zone eps-tolerance ride") holds
these coordinates fixed, and fixed-but-outside-bounds is exactly the shape
validate-machines.py's containment check (±0.02 eps) errors on. Confirmed
directly against the codebase's OWN prior art too: app/tests/deck-route.
test.mjs's section-h header comment (unedited by this run — the task
forbids touching tests) already says "Evil Dead's is parked" as of this
writing. Members are still built (recoordinate-if-high-confidence-else-
leave, per the task) and the write is still attempted for real per machine
— this module does not shortcut to "parked" by assertion; it runs the
actual guarded write and reports whatever the validator actually says.

  * evil_dead → zone 'basement' (kind 'lower', bounds from the sweep's
    bounds.basement, schema fields only). entries:['cellar-door'] (the
    file's OWN pre-existing shot; its identity as the basement's entry
    mechanism was never disputed by FLAGSHIP-DEEP-PASS's verdict — only the
    exit point and the bounds METHOD were). exits: absent — the one
    proposed exit point was explicitly refuted ('Subway' is a wiring-harness
    ground-row label, not a ball path) and no replacement was ever sourced;
    per the task's own "anything unknowable stays absent". Members:
    lock-and-load, book-target, lower-playfield-flipper (+bat:{size:'mini'}
    on the flipper, per this task's explicit instruction — independent of
    FLAGSHIP-DEEP-PASS's own unresolved sourcing dispute over that exact
    field, which this task's own instruction supersedes).
  * halloween → zones 'house-deck' ("Strode House", pulled verbatim from
    this file's OWN pre-existing house-left-spinner.notes text) and
    'sanitarium-deck' ("Smith's Grove Sanitarium", pulled verbatim from
    sanitarium-entry-scoop's own pre-existing notes) — kind taken directly
    from the sweep's own bounds.house.kind/bounds.sanitarium.kind ('upper'/
    'mini'). entries: house-deck:['center-ramp'], sanitarium-deck:
    ['sanitarium-entry-scoop'] — both per the task's explicit instruction
    and both shots' own pre-existing notes. Members: the sweep's own
    bounds.house/bounds.sanitarium "Shots living here" prose names 10 shots
    total; sanitarium-entry-scoop is one of them but the task explicitly
    classes it as an ENTRY, not a member — leaving exactly the task's stated
    9 (5 house + 4 sanitarium). exits: absent both zones — the sweep's
    bounds{} block carries no exits sub-key for either deck, so there is
    nothing extracted to place ("exits where extracted" — none was).
    Overlap check: house y-range and sanitarium y-range are disjoint in the
    sweep's own numbers (confirmed independently, matching the sweep's own
    non_overlapping_check note) — resolve_zone_overlaps() is still run for
    real (not skipped) and reports 0 shrinks fired.

Run:
  python3 app/scripts/p5-apply.py --dry-run
  python3 app/scripts/p5-apply.py --apply
"""

from __future__ import annotations

import argparse
import collections
import copy
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
BIZ = ROOT / "_Business"
SCRATCH = ROOT / "scratchpad"
P5 = BIZ / "catalog-passes" / "p5"
VALIDATE = ROOT / "app" / "scripts" / "validate-machines.py"
BACKUP_DIR = SCRATCH / "data-backup-p5"
OUTPUT = BIZ / "P5-APPLY-2026-08-11.json"
FLAGSHIP_DEEP_PASS = BIZ / "FLAGSHIP-DEEP-PASS-2026-08-10.json"

FLAGSHIP = {"jaws_goals", "evil_dead_goals", "halloween_goals"}

IMAGE_OK_VERDICTS = {"ok", "found", "usable"}
DELTA_MAX = 0.30
BANK_RE = re.compile(r"region|bank", re.IGNORECASE)
WEAK_LANDMARK_RE = re.compile(r"by elimination|\bassumed\b", re.IGNORECASE)
PIVOT_PTS = {(0.33, 0.05), (0.67, 0.05)}
ZONE_EPS = 0.02  # mirrors validate-machines.py

EVIL_DEAD_STEM = "evil_dead_goals"
HALLOWEEN_STEM = "halloween_goals"
EVIL_DEAD_ENTRIES = ["cellar-door"]
EVIL_DEAD_MEMBERS: dict[str, dict] = {
    "lock-and-load": {},
    "book-target": {},
    "lower-playfield-flipper": {"bat": {"size": "mini"}},
}
HOUSE_MEMBERS = [
    "house-left-spinner", "house-right-spinner", "house-balcony",
    "house-crossover", "house-upper-drop-target",
]
SANITARIUM_MEMBERS = [
    "sanitarium-middle-left-target", "sanitarium-middle-right-target",
    "sanitarium-middle-drop-target", "sanitarium-super-exit",
]


def dump(doc: dict) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def atomic_write(path: pathlib.Path, text: str) -> None:
    """Temp file in the same directory + os.replace, so a concurrent reader
    never observes a partially-written file. Used for both the accepted
    write and the rollback-restore (anchor-apply.py's own convention)."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def run_validator() -> tuple[int, str]:
    val = subprocess.run([sys.executable, str(VALIDATE)], capture_output=True, text=True, cwd=ROOT)
    return val.returncode, val.stdout + val.stderr


def load_all_docs():
    docs: dict[str, dict] = {}
    roundtrip_ok: dict[str, bool] = {}
    for f in sorted(DATA.glob("*_goals.json")):
        raw = f.read_text(encoding="utf-8")
        doc = json.loads(raw)
        docs[f.stem] = doc
        roundtrip_ok[f.stem] = (dump(doc) == raw)
    return docs, roundtrip_ok


def build_resolver(docs: dict):
    """Resolves any of the p5 corpus's 3 machine-key conventions (bare,
    _goals-suffixed, display-name) to a data/*.json stem. See module
    docstring for why all 3 exist in this corpus."""
    by_display: dict[str, list[str]] = {}
    for stem, doc in docs.items():
        by_display.setdefault(doc.get("machine"), []).append(stem)

    def resolve(key: str) -> str | None:
        if key.endswith("_goals") and key in docs:
            return key
        if (key + "_goals") in docs:
            return key + "_goals"
        cands = by_display.get(key)
        if cands and len(cands) == 1:
            return cands[0]
        return None

    return resolve


def load_p5_corpus() -> list[dict]:
    machines = []
    for i in range(1, 13):
        d = json.loads((P5 / f"batch-{i}.json").read_text(encoding="utf-8"))
        machines.extend(d["machines"])
    return machines


def write_validate_rollback(stem: str, doc: dict, docs: dict, pre_mutation: dict, dry_run: bool):
    """Shared write path for Task A and Task B: per-machine backup, atomic
    write, validate-machines.py, rollback (file + in-memory docs[stem]) on
    ANY ERROR line attributable to this file. Returns (status, errs) where
    status is 'would-apply' (dry-run, never touches disk), 'applied', or
    'rolled-back'."""
    if dry_run:
        return "would-apply", []

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    data_file = DATA / f"{stem}.json"
    shutil.copy2(data_file, BACKUP_DIR / data_file.name)
    atomic_write(data_file, dump(doc))

    rc, out = run_validator()
    stem_file = f"{stem}.json"
    stem_errors = [l for l in out.splitlines() if l.startswith(f"ERROR {stem_file}:")]
    if rc != 0:
        all_errors = [l for l in out.splitlines() if l.startswith("ERROR ")]
        errs = stem_errors or all_errors or [f"validate-machines.py exited {rc} with no ERROR lines captured"]
        backup_text = (BACKUP_DIR / data_file.name).read_text(encoding="utf-8")
        atomic_write(data_file, backup_text)
        docs[stem] = pre_mutation
        return "rolled-back", errs
    return "applied", []


# =============================================================================
# TASK A — coordinate fixes
# =============================================================================

def landmark_is_specific(landmark) -> bool:
    if not landmark or not isinstance(landmark, str):
        return False
    return not WEAK_LANDMARK_RE.search(landmark)


def is_bank_result(result: dict) -> bool:
    return bool(BANK_RE.search(result.get("verdict") or ""))


def is_pivot_template(shot: dict) -> bool:
    return shot.get("type") == "flipper" and (shot.get("x"), shot.get("y")) in PIVOT_PTS


def qualifies_for_fix(result: dict) -> tuple[bool, str | None]:
    """The 4 per-result criteria (confidence/delta/bank/landmark) — image,
    calibration, and pivot-template are checked by the caller, which has the
    shot/machine context this function doesn't."""
    conf = result.get("confidence")
    if conf != "high":
        return False, f"confidence {conf!r} (need exactly 'high')"
    delta = result.get("delta")
    if delta is None or not isinstance(delta, (int, float)):
        return False, f"delta {delta!r} (non-numeric/absent — likely unlocatable or a bank entry)"
    if delta > DELTA_MAX:
        return False, f"delta {delta} exceeds {DELTA_MAX} — placement error, not a data error"
    if is_bank_result(result):
        return False, f"bank/multi-instance (verdict {result.get('verdict')!r}) — regional-presence class, not delta-scored"
    if not landmark_is_specific(result.get("landmark")):
        return False, f"landmark not a specific visual anchor: {result.get('landmark')!r}"
    return True, None


def build_task_a_selection(p5_machines: list[dict], docs: dict, resolve):
    """Returns (plan, flagship_candidates, review, no_image,
    calibration_failed, unresolved).
      plan: [{"stem","shot","from":{x,y},"to":{x,y},"confidence","landmark"}]
        — non-flagship, all 6 criteria satisfied, pending write-phase guards.
      flagship_candidates: same shape, for jaws/evil_dead/halloween — never
        applied, reported for owner review only.
      review: [(stem, shot_id, reason)] — every disqualified result from an
        eligible (image-ok + calibrated) machine.
      no_image / calibration_failed: [{"machine","imageVerdict"}] — whole
        machines excluded before any per-result check.
      unresolved: [raw machine key] — p5 entries whose machine key didn't
        resolve to a data file (checked live: 0, kept defensively).
    """
    plan: list[dict] = []
    flagship_candidates: list[dict] = []
    review: list[tuple[str, str, str]] = []
    no_image: list[dict] = []
    calibration_failed: list[dict] = []
    unresolved: list[str] = []

    for m in p5_machines:
        stem = resolve(m["machine"])
        if stem is None:
            unresolved.append(m["machine"])
            continue

        img_verdict = (m.get("image") or {}).get("verdict")
        has_calib = bool(m.get("calibration"))
        results = m.get("results") or []

        # TRUE machine-level exclusions: no image at all (nothing to examine,
        # results skipped outright) vs. calibration missing. A *-partial
        # verdict ("found-partial"/"ok-partial") is NEITHER of these — the
        # machine DOES have a usable image, just incomplete coverage — so it
        # falls through to the per-result loop below like any other machine;
        # every one of its results is then individually refused into
        # reviewQueue with an explicit partial-coverage reason, rather than
        # being silently invisible under a misleading "noImage" label.
        if img_verdict is None or img_verdict == "no-image":
            no_image.append({"machine": stem, "imageVerdict": img_verdict})
            continue
        if not has_calib:
            calibration_failed.append({"machine": stem, "imageVerdict": img_verdict})
            continue

        doc = docs.get(stem)
        if doc is None:
            calibration_failed.append({"machine": stem, "imageVerdict": img_verdict, "why": "data file missing"})
            continue
        shots_by_id = {s["id"]: s for s in doc.get("shots", [])}

        for r in results:
            sid = r.get("id")
            shot = shots_by_id.get(sid)
            if shot is None:
                review.append((stem, sid, "shot not found in data file"))
                continue

            if img_verdict not in IMAGE_OK_VERDICTS:
                review.append((stem, sid, f"machine image verdict {img_verdict!r} is partial coverage, not a clean 'ok' — no auto-fix from an incomplete photo"))
                continue

            ok, why = qualifies_for_fix(r)
            if not ok:
                review.append((stem, sid, why))
                continue
            if is_pivot_template(shot):
                review.append((stem, sid, "flipper-pair at the known pivot template (0.33/0.67, 0.05) — convention, not error"))
                continue

            placed = r.get("placed") or {}
            px, py = placed.get("x"), placed.get("y")
            if not isinstance(px, (int, float)) or not isinstance(py, (int, float)):
                review.append((stem, sid, "placed x/y not both numeric"))
                continue
            if not (0.0 <= px <= 1.0 and 0.0 <= py <= 1.0):
                review.append((stem, sid, f"proposed ({px},{py}) outside the 0..1 playfield"))
                continue

            data_pt = r.get("data") or {}
            entry = {
                "stem": stem, "shot": sid,
                "from": {"x": data_pt.get("x"), "y": data_pt.get("y")},
                "to": {"x": px, "y": py},
                "confidence": r.get("confidence"), "landmark": r.get("landmark"),
                "delta": r.get("delta"),
            }
            if stem in FLAGSHIP:
                flagship_candidates.append(entry)
            else:
                plan.append(entry)

    return plan, flagship_candidates, review, no_image, calibration_failed, unresolved


def apply_task_a(docs: dict, roundtrip_ok: dict, plan: list[dict], dry_run: bool):
    """Groups by stem (one combined write per machine), verbatim-current-
    matches each shot against its `from`, dedupes/conflict-guards
    one-write-per-shot, writes+validates+rolls back. Returns (applied,
    refused: [(stem, shot, why)])."""
    applied: list[dict] = []
    refused: list[tuple[str, str, str]] = []

    by_stem: dict[str, list[dict]] = {}
    for f in plan:
        by_stem.setdefault(f["stem"], []).append(f)

    for stem, fixes in sorted(by_stem.items()):
        if stem not in docs:
            for f in fixes:
                refused.append((stem, f["shot"], "data file missing"))
            continue
        if not roundtrip_ok[stem]:
            for f in fixes:
                refused.append((stem, f["shot"],
                                 "round-trip no-op self-test failed for this file (pre-existing formatting "
                                 "drift) — refusing to touch it, a patch here would diff every such value "
                                 "in the file, not just the intended shot"))
            continue

        # one-write-per-shot: conflict guard within this run
        seen: dict[str, dict] = {}
        deduped: list[dict] = []
        for f in fixes:
            if f["shot"] in seen:
                refused.append((stem, f["shot"], "conflict: multiple coordinate-fix candidates target this same shot in this run"))
                continue
            seen[f["shot"]] = f
            deduped.append(f)

        doc = docs[stem]
        pre_mutation = copy.deepcopy(doc)
        shots_by_id = {s["id"]: s for s in doc.get("shots", [])}
        machine_ok: list[dict] = []
        for f in deduped:
            shot = shots_by_id.get(f["shot"])
            if shot is None:
                refused.append((stem, f["shot"], "shot not found — file moved since the sweep"))
                continue
            actual_x, actual_y = shot.get("x"), shot.get("y")
            exp = f["from"]
            if actual_x != exp["x"] or actual_y != exp["y"]:
                refused.append((stem, f["shot"],
                                 f"current mismatch: expected ({exp['x']},{exp['y']}), file has "
                                 f"({actual_x},{actual_y}) — the file moved since the sweep"))
                continue
            shot["x"] = f["to"]["x"]
            shot["y"] = f["to"]["y"]
            machine_ok.append(f)

        if not machine_ok:
            continue

        status, errs = write_validate_rollback(stem, doc, docs, pre_mutation, dry_run)
        if status == "rolled-back":
            for f in machine_ok:
                refused.append((stem, f["shot"], f"validator red post-write, ROLLED BACK: {'; '.join(errs[:5])}"))
            continue

        applied.extend(machine_ok)

    return applied, refused


# =============================================================================
# TASK B — zone unlock
# =============================================================================

def clean_bounds(raw: dict) -> dict:
    return {k: raw[k] for k in ("x", "y", "w", "h")}


def resolve_zone_overlaps(zones: list[dict]) -> list[str]:
    """Pairwise overlap check (validator's own threshold: ox>0.005 and
    oy>0.005) across `zones`. On a hit, shrinks whichever zone extends
    further along the axis with the SMALLER overlap magnitude, trimming just
    enough to leave a hairline gap — mutates that zone's bounds IN PLACE.
    Returns human-readable notes (empty list if nothing overlapped)."""
    notes: list[str] = []
    pad = 0.001
    for i in range(len(zones)):
        for j in range(i + 1, len(zones)):
            za, zb = zones[i], zones[j]
            ba, bb = za["bounds"], zb["bounds"]
            ox = min(ba["x"] + ba["w"], bb["x"] + bb["w"]) - max(ba["x"], bb["x"])
            oy = min(ba["y"] + ba["h"], bb["y"] + bb["h"]) - max(ba["y"], bb["y"])
            if not (ox > 0.005 and oy > 0.005):
                continue
            if oy <= ox:
                hi, lo = (za, zb) if ba["y"] + ba["h"] > bb["y"] + bb["h"] else (zb, za)
                new_h = round((lo["bounds"]["y"] - pad) - hi["bounds"]["y"], 4)
                notes.append(f"shrunk {hi['id']!r} height {hi['bounds']['h']:.4f}->{new_h:.4f} "
                             f"(y-axis) to clear overlap with {lo['id']!r}")
                hi["bounds"]["h"] = new_h
            else:
                hi, lo = (za, zb) if ba["x"] + ba["w"] > bb["x"] + bb["w"] else (zb, za)
                new_w = round((lo["bounds"]["x"] - pad) - hi["bounds"]["x"], 4)
                notes.append(f"shrunk {hi['id']!r} width {hi['bounds']['w']:.4f}->{new_w:.4f} "
                             f"(x-axis) to clear overlap with {lo['id']!r}")
                hi["bounds"]["w"] = new_w
    return notes


def recoordinate_or_keep(shot: dict, result: dict | None) -> tuple[float, float, str]:
    """Per the task's own rule: recoordinate to the sweep's `placed` ONLY
    when that placement's confidence is 'high'; otherwise keep the shot's
    existing (x,y) and let the zone's ±0.02 eps-tolerance carry it."""
    if result and result.get("confidence") == "high":
        placed = result.get("placed") or {}
        px, py = placed.get("x"), placed.get("y")
        if isinstance(px, (int, float)) and isinstance(py, (int, float)):
            return px, py, f"recoordinated to the sweep's placed ({px},{py}) — confidence 'high'"
    conf = (result or {}).get("confidence")
    return (shot.get("x"), shot.get("y"),
            f"left unchanged at ({shot.get('x')},{shot.get('y')}) — sweep confidence "
            f"{conf!r} is not 'high', not recoordinated per task rule; relying on the "
            f"zone's ±{ZONE_EPS} eps-tolerance")


def attempt_zone_unlock(stem: str, docs: dict, roundtrip_ok: dict, zones: list[dict],
                         member_zone_id: dict[str, str], member_extra: dict[str, dict],
                         results_by_shot: dict[str, dict], dry_run: bool) -> dict:
    """Builds the FULL proposed mutation for `stem` (all zones + all member
    playfield refs together, one combined write, matching every other
    P-series applier's per-machine granularity), attempts it for real
    through write_validate_rollback, and reports the actual outcome — never
    asserted, always the live validator's answer."""
    if stem not in docs:
        return {"status": "parked", "why": "data file missing"}
    if not roundtrip_ok.get(stem):
        return {"status": "parked",
                "why": "round-trip no-op self-test failed for this file — refusing to touch it"}

    doc = docs[stem]
    existing_zone_ids = {z["id"] for z in (doc.get("playfields") or [])}
    dupe_ids = [z["id"] for z in zones if z["id"] in existing_zone_ids]
    if dupe_ids:
        return {"status": "parked", "why": f"zone id(s) {dupe_ids} already exist in playfields[] — never overwrite"}

    shots_by_id = {s["id"]: s for s in doc.get("shots", [])}
    all_entry_ids = [e for z in zones for e in (z.get("entries") or [])]
    referenced = sorted(set(list(member_zone_id) + all_entry_ids))
    missing = [sid for sid in referenced if sid not in shots_by_id]
    if missing:
        return {"status": "parked", "why": f"referenced shot id(s) not found in file: {missing}"}

    conflict = sorted(set(member_zone_id) & set(all_entry_ids))
    if conflict:
        return {"status": "parked", "why": f"shot id(s) proposed as BOTH a zone entry and a zone member: {conflict}"}

    already_zoned = [sid for sid in member_zone_id if shots_by_id[sid].get("playfield") is not None]
    if already_zoned:
        return {"status": "parked",
                "why": f"member shot(s) already carry a playfield ref — never overwrite: {already_zoned}"}

    zones = copy.deepcopy(zones)
    overlap_notes = resolve_zone_overlaps(zones)

    pre_mutation = copy.deepcopy(doc)
    recoordination_notes: dict[str, str] = {}
    for sid in sorted(member_zone_id):
        shot = shots_by_id[sid]
        x, y, note = recoordinate_or_keep(shot, results_by_shot.get(sid))
        recoordination_notes[sid] = note
        shot["x"], shot["y"] = x, y
        shot["playfield"] = member_zone_id[sid]
        for k, v in (member_extra.get(sid) or {}).items():
            shot[k] = copy.deepcopy(v)

    playfields = doc.setdefault("playfields", [])
    for z in zones:
        playfields.append(z)

    status, errs = write_validate_rollback(stem, doc, docs, pre_mutation, dry_run)
    attempted = {
        "zoneIds": [z["id"] for z in zones],
        "entries": {z["id"]: z.get("entries") for z in zones},
        "members": sorted(member_zone_id),
        "recoordinationNotes": recoordination_notes,
        "overlapNotes": overlap_notes,
    }
    if status == "rolled-back":
        return {"status": "parked",
                "why": f"validator red post-write, ROLLED BACK: {'; '.join(errs[:8])}",
                "attempted": attempted}
    return {"status": "applied" if status == "applied" else "applied (dry-run, unvalidated)",
            **attempted}


def find_p5_entry(p5_machines: list[dict], resolve, stem: str) -> dict | None:
    for m in p5_machines:
        if resolve(m["machine"]) == stem:
            return m
    return None


def run_task_b(docs: dict, roundtrip_ok: dict, p5_machines: list[dict], resolve, dry_run: bool) -> dict:
    zones_report: dict[str, dict] = {}

    # ---- evil_dead: basement -------------------------------------------
    ed_entry = find_p5_entry(p5_machines, resolve, EVIL_DEAD_STEM)
    ed_bounds = ((ed_entry or {}).get("bounds") or {}).get("basement")
    if not ed_bounds:
        zones_report["evil_dead"] = {"status": "parked", "why": "sweep produced no usable 'basement' bounds — never guessing"}
    else:
        zone = {
            "id": "basement", "name": "Fruit Cellar Basement", "kind": "lower",
            "bounds": clean_bounds(ed_bounds), "entries": list(EVIL_DEAD_ENTRIES),
        }
        results_by_shot = {r["id"]: r for r in (ed_entry.get("results") or [])}
        zones_report["evil_dead"] = attempt_zone_unlock(
            EVIL_DEAD_STEM, docs, roundtrip_ok, [zone],
            {sid: "basement" for sid in EVIL_DEAD_MEMBERS}, EVIL_DEAD_MEMBERS,
            results_by_shot, dry_run,
        )

    # ---- halloween: house-deck + sanitarium-deck -----------------------
    hw_entry = find_p5_entry(p5_machines, resolve, HALLOWEEN_STEM)
    hw_bounds = (hw_entry or {}).get("bounds") or {}
    bh, bs = hw_bounds.get("house"), hw_bounds.get("sanitarium")
    if not bh or not bs:
        missing = [n for n, b in (("house", bh), ("sanitarium", bs)) if not b]
        zones_report["halloween"] = {"status": "parked", "why": f"sweep produced no usable bounds for: {missing} — never guessing"}
    else:
        house_zone = {
            "id": "house-deck", "name": "Strode House", "kind": bh.get("kind") or "upper",
            "bounds": clean_bounds(bh), "entries": ["center-ramp"],
        }
        sani_zone = {
            "id": "sanitarium-deck", "name": "Smith's Grove Sanitarium", "kind": bs.get("kind") or "mini",
            "bounds": clean_bounds(bs), "entries": ["sanitarium-entry-scoop"],
        }
        member_zone_id = {sid: "house-deck" for sid in HOUSE_MEMBERS}
        member_zone_id.update({sid: "sanitarium-deck" for sid in SANITARIUM_MEMBERS})
        member_extra = {sid: {} for sid in member_zone_id}
        results_by_shot = {r["id"]: r for r in (hw_entry.get("results") or [])}
        zones_report["halloween"] = attempt_zone_unlock(
            HALLOWEEN_STEM, docs, roundtrip_ok, [house_zone, sani_zone],
            member_zone_id, member_extra, results_by_shot, dry_run,
        )

    return zones_report


# =============================================================================
# main
# =============================================================================

def print_summary(report: dict, review_reasons: list[tuple[str, str, str]]) -> None:
    print()
    print("=" * 78)
    print("P5 APPLY — TASK A (vision coordinate fixes)")
    print(f"  coordFixes applied : {len(report['coordFixes'])}")
    by_m = collections.Counter(c["machine"] for c in report["coordFixes"])
    print(f"      across {len(by_m)} machines")
    print(f"  flagshipCoordFlags : {len(report['flagshipCoordFlags'])}")
    for f in report["flagshipCoordFlags"]:
        print(f"      {f['machine']}: {f['shot']} {f['from']} -> {f['to']} (delta {f['delta']})")
    print(f"  reviewQueue        : {report['reviewQueue']['count']} across {len(report['reviewQueue']['byMachine'])} machines")
    reason_kinds: dict[str, int] = {}
    for _stem, _shot, why in review_reasons:
        key = why.split(":")[0].split(" (")[0][:48]
        reason_kinds[key] = reason_kinds.get(key, 0) + 1
    for k, v in sorted(reason_kinds.items(), key=lambda kv: -kv[1])[:15]:
        print(f"      {v:5d}  {k}")
    print(f"  noImage machines   : {len(report['noImage'])}")
    print(f"  calibrationFailed  : {len(report['calibrationFailed'])}")
    print()
    print("P5 APPLY — TASK B (flagship zone unlock)")
    for machine, z in report["zones"].items():
        print(f"  {machine}: {z['status']}")
        if z.get("why"):
            print(f"      why: {z['why'][:300]}")
        if z.get("zoneIds"):
            print(f"      zones: {z['zoneIds']}  members: {z.get('members')}")
        if z.get("overlapNotes"):
            print(f"      overlap: {z['overlapNotes']}")
    print("=" * 78)


def main() -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    dry_run = args.dry_run

    docs, roundtrip_ok = load_all_docs()
    n_bad_roundtrip = sum(1 for v in roundtrip_ok.values() if not v)
    print(f"loaded {len(docs)} machine files ({n_bad_roundtrip} fail the round-trip self-test)")

    resolve = build_resolver(docs)
    p5_machines = load_p5_corpus()
    print(f"loaded {len(p5_machines)} machines from the p5 vision-sweep corpus")

    # ---- TASK A ----------------------------------------------------------
    plan, flagship_candidates, review, no_image, calibration_failed, unresolved = \
        build_task_a_selection(p5_machines, docs, resolve)
    if unresolved:
        print(f"WARNING: {len(unresolved)} p5 machine key(s) did not resolve to a data file: {unresolved}")

    applied_a, refused_a = apply_task_a(docs, roundtrip_ok, plan, dry_run)
    review.extend(refused_a)

    review_by_machine = collections.Counter(stem for stem, _shot, _why in review)

    # ---- TASK B ----------------------------------------------------------
    zones_report = run_task_b(docs, roundtrip_ok, p5_machines, resolve, dry_run)

    # ---- assemble report ---------------------------------------------------
    coord_fixes_out = [
        {"machine": f["stem"], "shot": f["shot"], "from": f["from"], "to": f["to"],
         "confidence": f["confidence"], "landmark": f["landmark"]}
        for f in applied_a
    ]
    flagship_out = [
        {"machine": f["stem"], "shot": f["shot"], "from": f["from"], "to": f["to"],
         "confidence": f["confidence"], "landmark": f["landmark"], "delta": f["delta"],
         "note": "flagship-owned (jaws/evil_dead/halloween) — never auto-applied; for owner review"}
        for f in flagship_candidates
    ]

    report = {
        "coordFixes": coord_fixes_out,
        "reviewQueue": {
            "count": len(review),
            "byMachine": dict(sorted(review_by_machine.items())),
        },
        "flagshipCoordFlags": flagship_out,
        "zones": zones_report,
        "noImage": no_image,
        "calibrationFailed": calibration_failed,
    }
    if unresolved:
        report["unresolvedMachineKeys"] = unresolved

    print_summary(report, review)

    if dry_run:
        print("\ndry-run: no writes, no output file")
        return 0

    BIZ.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
