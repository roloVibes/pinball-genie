#!/usr/bin/env python3
"""P3 (plunge/technique) + P3.5 (skillshot structural) applier — dataset
schema v5 (see app/src/models.ts's GoalStep doc comments: plunge/plungeTo/
technique/flipper/direct/link) and CONTRACTS-PLAYFIELDS.md.

Two passes in one run, both validator-gated per machine with rollback. Guard
philosophy copied from app/scripts/p2-apply.py and apply-structured.py: each
guard exists because a prior applier shipped a defect without it; refusals
are expected output, not failures.

PASS A — apply confirmed P3 findings
=====================================
Consumes _Business/catalog-passes/p3/batch-{1..12}.json (research findings:
{machines:[{machine, findings:[{path, kind, current, proposed, reason,
evidence, confidence}], noHintNeeded}]}) + verify-{1,2,3}.json (independent
verification pass over BOTH findings and noHintNeeded entries: {machines:
[{machine, verdicts:[{path, verdict, why}]}]} — verify-1/2/3 are a strict
partition of the 135 machines that have any P3 content, never overlapping,
so there is no cross-file conflict to reconcile).

SELECTION RULE: apply ONLY findings whose verify verdict (matched by exact
`path` string) is 'confirmed'. noHintNeeded verdicts are never applied (they
assert nothing needs to change — a confirmed noHintNeeded is a no-op by
definition). refuted/uncertain findings are reported in refused[], not
applied — high refusal rates are correct when P3's own verification pass
disagreed with its research pass.

Guards:
  * round-trip no-op self-test, checked ONCE per file at load time (not
    per-write): json.dumps(doc, indent=2)+"\\n" must reproduce the file
    byte-for-byte. Computed once because it can only ever get MORE true
    during a run that writes exclusively through the same dump(), never
    less — checking once at load is equivalent to checking before every
    write and far simpler. 5 of 139 files fail this today (avatar, csi,
    cue_ball_wizard, starship_troopers, tron_legacy) — all for the same
    reason: the source has trailing-zero floats (0.30, 0.60, 0.10, 0.20)
    that json.dumps normalizes to 0.3/0.6/0.1/0.2, which would turn a
    single-field patch into a diff touching every such float in the file.
    starship_troopers has 2 CONFIRMED P3 findings that are refused by this
    guard for exactly that reason — verified against the real file before
    this run, not assumed.
  * verbatim `current` match for step patches: every key in a finding's
    `current` dict must equal the live step's value for that key (JSON
    absent-key and explicit-null read the same way validate-machines.py's
    own checks do), or the finding is refused — the file moved since P3's
    research ran. All 50 confirmed findings were checked against live data
    before this script was written; 0 mismatches at that time, but the
    live check below is authoritative, not that pre-check.
  * partial step objects MERGE: a proposed dict is merged key-by-key onto
    the existing step object (mirrors apply-structured.py's set_at 'steps'
    special case). `shot` may never appear in a proposed step-patch dict —
    if the file moved enough that the target shot changed, that is a
    conflict this script refuses rather than silently reassigns.
  * one-write-per-path conflict refusal + (path,proposed) exact dedupe,
    scoped per machine (a `path` string is only unique within one file) —
    both checked before any file is touched.
  * title-fix strings (a plain single field, e.g. goals[id].title): whole
    -string replace with verbatim current-match. UNEXERCISED by this run's
    actual P3 corpus (all 72 findings are `goals[id].steps[idx]` shape) but
    implemented per the task's guard list, sharing apply-structured.py's own
    path grammar (shots|goals collections; `.field` or `.field[idx]` chains).
  * flagship exclusion: JAWS/EVIL_DEAD/HALLOWEEN are skipped entirely — the
    owner hand-authored their skill shots (Jaws' skillshot-level-3 IS the
    template Pass B restructures everything else to match). ANY finding
    touching them is refused as 'flagship-owned', independent of verdict.
  * per-machine backup to scratchpad/data-backup-p3/ before that machine's
    (single, combined) write; validate-machines.py must stay clean for
    THIS machine's file (checked by ERROR-line filename prefix, matching
    p2-apply.py/apply-structured.py's own convention — the validator
    re-checks all 139 files every invocation, so scoping by prefix avoids
    blaming machine B for a problem introduced while writing machine A
    earlier in the same run) or the pre-write backup is restored and the
    run continues with the remaining machines either way.

PASS B — P3.5 structural restructure (rolo's route-truth rule, 2026-08-11)
============================================================================
Mechanical detector over ALL 139 files, run strictly AFTER Pass A commits
(so it sees any technique/flipper fields Pass A just wrote): every
skillshot-category goal with EXACTLY ONE step whose target shot is (a) not
type 'plunge', (b) not lane-adjacent (x>=0.9, or x>=0.84 && y<=0.6), and
(c) not a plunge-reachable landing (y<0.72 && x>=0.57 — classifyPlunge's own
Case A2 partial band) models a shot that the renderer draws as a bare full
-send plunge continuation. RESTRUCTURE per the Jaws skillshot-level-3
template: step 0 becomes a synthetic plunge-to-the-flippers leg (shot = the
machine's own type:'plunge' shot id — skip the machine if it has none, or
more than one, since there is no way to pick without guessing), step 1 keeps
the original shot/action/detail.

*** JUDGMENT CALL, FLAGGED FOR REVIEW (read this before trusting the output) ***
The literal 3-condition geometric rule above, applied blind, has real false
positives: 129 non-flagship goals match it, but a full read of every one
shows dozens are genuine ONE-CONTINUOUS-MOTION plunges that just happen to
land outside the two geometric escape bands (e.g. ac_dc's axe-lanes: "The
plunge will more or less always go into the scoop up top. From there, it'll
kick out into the AXE lanes" — no flipper touches the ball at all; guardians'
skill_standard literally says "no flipper touch = hands-free 2x"; wizard_of_
oz's oz-skillshot says "The flippers can't steer which lane is flashing").
Restructuring those would insert a fabricated "Plunge through to the
flippers" step for a shot that never reaches the flippers — a regression,
not a fix. This is exactly the failure mode the task's own "ambiguous ->
skip, never guess" and ">6 per machine -> cap" escape hatches anticipate.

So Pass B adds a second, narrower gate on top of the geometric candidate
set: RESTRUCTURE only fires when there is a positive, checkable signal that
a flipper genuinely intervenes between the plunge and a DISTINCT target —
(1) a technique tag from the flipper-mediated half of the closed vocabulary
(everything except 'nudge', which is body english, not a flipper action),
(2) a STEP-level `flipper` override (deliberately NOT the target shot's own
base .flipper — that is a general fact used by every goal referencing the
shot and produced false positives here, e.g. centigrade_37's pure single-
phase soft-plunge-into-a-lane goal only matched because its target lane
carries a default .flipper value unrelated to this specific goal), or (3)
explicit catch/hold/trap/cradle/"from the flipper" language in the step's
own action or detail text. An explicit NEGATION ("no flipper touch",
"without touching the flippers", "flippers can't steer") always wins and
forces skip. Absent any of these, the goal defaults to SKIP — under-fixing
is the safe direction here, not over-fixing.

Three goals matched the text regex but read, in full sentence context, as
describing something OTHER than the shot's own mechanism (a miss-recovery
fallback or post-score ball-safety aside, not how the shot is made) — hand-
reviewed and excluded via TEXT_MATCH_FALSE_POSITIVE below, each with its own
citation, mirroring p2-apply.py's NEWSHOT_DROP/SHOT_FIELD_STRIP convention
(narrow (machine,goal) pairs, never a blanket heuristic).

Preserves `link`/`technique` on the target step per the task spec, PLUS
`flipper` (an extension beyond the task's literal 2-field list): Pass A can
author a CONFIRMED flipper field onto one of these exact steps in the SAME
run (iron_maiden, medieval_madness, pokemon all do, this run) — dropping it
two phases later would silently revert work Pass A just committed. Never
invents a NEW flipper hint (task's explicit instruction) — only carries one
forward if it is already there after Pass A.

A separate scan flags "ambiguous: target in the plunge-reachable band but
plunge hint is 'full'" (classifyPlunge's hint-beats-geometry rule means the
render doesn't actually treat these as reachable) — the task's own named
example of what to skip-and-list rather than resolve either way, since
classifyPlunge's doc comment cites a second, equally valid explanation
(James Bond's right-orbit-class full-strength direct plunge).

Run:
  python3 app/scripts/p3-apply.py --dry-run
  python3 app/scripts/p3-apply.py --apply
"""

from __future__ import annotations

import argparse
import copy
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
BIZ = ROOT / "_Business"
SCRATCH = ROOT / "scratchpad"
P3 = BIZ / "catalog-passes" / "p3"
VALIDATE = ROOT / "app" / "scripts" / "validate-machines.py"
BACKUP_A = SCRATCH / "data-backup-p3"
BACKUP_B = SCRATCH / "data-backup-p3.5-restructure"
OUTPUT = BIZ / "P3-APPLY-2026-08-11.json"

# Bare machine keys, as used throughout the P3 corpus's "machine" field
# (NOT "_goals" suffixed) — skipped entirely in BOTH passes regardless of
# verdict/geometry: the owner hand-authored their skill shots directly.
FLAGSHIP = {"jaws", "evil_dead", "halloween"}


def dump(doc: dict) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def run_validator() -> tuple[int, str]:
    val = subprocess.run([sys.executable, str(VALIDATE)], capture_output=True, text=True, cwd=ROOT)
    return val.returncode, val.stdout + val.stderr


def load_all_docs():
    """Loads every data/*_goals.json once. Returns (docs, roundtrip_ok) —
    docs[stem] is mutated in place by both passes; roundtrip_ok[stem] is
    computed once against the ORIGINAL on-disk bytes (see module docstring
    for why once-at-load is equivalent to checking before every write)."""
    docs: dict[str, dict] = {}
    roundtrip_ok: dict[str, bool] = {}
    for f in sorted(DATA.glob("*_goals.json")):
        raw = f.read_text(encoding="utf-8")
        doc = json.loads(raw)
        docs[f.stem] = doc
        roundtrip_ok[f.stem] = (dump(doc) == raw)
    return docs, roundtrip_ok


def validate_and_maybe_rollback(stem: str, doc: dict, backup_dir: pathlib.Path,
                                 pre_mutation_doc: dict, docs: dict) -> tuple[bool, list[str]]:
    """Writes `doc` to data/<stem>.json (already backed up by the caller),
    runs the validator, and rolls back (file + in-memory docs[stem]) on any
    ERROR line attributable to this file. Returns (ok, error_lines)."""
    data_file = DATA / f"{stem}.json"
    data_file.write_text(dump(doc), encoding="utf-8")
    rc, out = run_validator()
    stem_file = f"{stem}.json"
    stem_errors = [l for l in out.splitlines() if l.startswith(f"ERROR {stem_file}:")]
    if rc != 0:
        all_errors = [l for l in out.splitlines() if l.startswith("ERROR ")]
        errs = stem_errors or all_errors or [f"validate-machines.py exited {rc} with no ERROR lines captured"]
        shutil.copy2(backup_dir / data_file.name, data_file)
        docs[stem] = pre_mutation_doc
        return False, errs
    return True, []


# =============================================================================
# PASS A
# =============================================================================

PATH_RE = re.compile(
    r"^(?P<coll>shots|goals)\[(?P<id>[a-zA-Z0-9_-]+)\]"
    r"(?P<rest>(?:\.[A-Za-z]+(?:\[\d+\])?)*)$"
)
REST_RE = re.compile(r"\.(?P<field>[A-Za-z]+)(?:\[(?P<idx>\d+)\])?")


def load_p3_corpus():
    batch_by_machine: dict[str, dict] = {}
    for i in range(1, 13):
        d = json.loads((P3 / f"batch-{i}.json").read_text(encoding="utf-8"))
        for m in d["machines"]:
            batch_by_machine[m["machine"]] = m
    verify_by_machine: dict[str, dict] = {}
    for i in (1, 2, 3):
        d = json.loads((P3 / f"verify-{i}.json").read_text(encoding="utf-8"))
        for m in d["machines"]:
            verify_by_machine[m["machine"]] = m
    return batch_by_machine, verify_by_machine


def apply_finding_to_doc(doc: dict, path: str, current, proposed) -> tuple[bool, str | None]:
    """Mutates `doc` in place on success. Returns (ok, why_if_refused)."""
    m = PATH_RE.match(path)
    if not m:
        return False, f"unparseable path {path!r}"
    coll, ident, rest = m.group("coll"), m.group("id"), m.group("rest")
    fields = [(f.group("field"), f.group("idx")) for f in REST_RE.finditer(rest)]
    obj = next((it for it in (doc.get(coll) or []) if it.get("id") == ident), None)
    if obj is None:
        return False, f"{coll}[{ident}] not found in file"

    if len(fields) == 1 and fields[0][0] == "steps" and fields[0][1] is not None:
        idx = int(fields[0][1])
        steps = obj.get("steps") or []
        if idx >= len(steps):
            return False, f"steps[{idx}] does not exist (goal has {len(steps)} steps) — the file moved"
        step = steps[idx]
        if not isinstance(current, dict) or not isinstance(proposed, dict):
            return False, "a goals[].steps[] finding must carry dict current/proposed"
        for k, v in current.items():
            actual = step.get(k)
            if actual != v:
                return False, f"current mismatch at {k!r}: expected {v!r}, file has {actual!r} — the file moved since research"
        if "shot" in proposed:
            return False, "proposed step patch sets 'shot' — merge-only guard refuses this (never include/replace shot)"
        for k, v in proposed.items():
            step[k] = v
        return True, None

    # Single-field whole-value replace (e.g. goals[id].title, shots[id].name)
    # -- unexercised by this run's real corpus, implemented per the guard list.
    if len(fields) != 1 or fields[0][1] is not None:
        return False, f"unsupported path shape for a non-step finding: {path!r}"
    field = fields[0][0]
    if not isinstance(current, str) or not isinstance(proposed, str):
        return False, "a non-step finding must carry whole-string current/proposed"
    actual = obj.get(field)
    if actual != current:
        return False, f"current mismatch: expected {current!r}, file has {actual!r} — the file moved since research"
    obj[field] = proposed
    return True, None


def build_pass_a_selection(batch_by_machine, verify_by_machine):
    """Data-shape guards that don't need file I/O: verdict==confirmed,
    flagship exclusion, (path,proposed) dedupe, one-write-per-path conflict.
    Returns (plan: {machine: [(index, finding), ...]}, refused: [...])."""
    plan: dict[str, list[tuple[int, dict]]] = {}
    refused: list[dict] = []

    for machine, bm in sorted(batch_by_machine.items()):
        vm = verify_by_machine.get(machine)
        verdict_by_path: dict[str, str] = {}
        why_by_path: dict[str, str] = {}
        if vm:
            for v in vm["verdicts"]:
                verdict_by_path[v["path"]] = v["verdict"]
                why_by_path[v["path"]] = v.get("why") or ""

        selected: list[tuple[int, dict]] = []
        for idx, f in enumerate(bm["findings"]):
            path = f["path"]
            if machine in FLAGSHIP:
                refused.append({
                    "machine": machine, "path": path,
                    "why": "flagship-owned (JAWS/EVIL_DEAD/HALLOWEEN skipped entirely — owner "
                           "hand-authored their skill shots; any P3 finding touching them is "
                           "refused regardless of verdict)",
                })
                continue
            verdict = verdict_by_path.get(path)
            if verdict != "confirmed":
                why = (why_by_path.get(path) or "no matching verify verdict")[:300]
                refused.append({"machine": machine, "path": path, "why": f"verdict {verdict!r}: {why}"})
                continue
            selected.append((idx, f))

        # dedupe: identical (path, proposed) collapses to the first
        seen: dict[tuple[str, str], int] = {}
        deduped: list[tuple[int, dict]] = []
        for idx, f in selected:
            key = (f["path"], json.dumps(f["proposed"], sort_keys=True))
            if key in seen:
                refused.append({
                    "machine": machine, "path": f["path"],
                    "why": f"duplicate of finding index {seen[key]} with identical (path,proposed)",
                })
                continue
            seen[key] = idx
            deduped.append((idx, f))

        # one-write-per-path conflict
        by_path: dict[str, list[int]] = {}
        for idx, f in deduped:
            by_path.setdefault(f["path"], []).append(idx)
        conflict_idxs = {idx for idxs in by_path.values() if len(idxs) > 1 for idx in idxs}
        if conflict_idxs:
            for idx, f in deduped:
                if idx in conflict_idxs:
                    n = len(by_path[f["path"]])
                    refused.append({
                        "machine": machine, "path": f["path"],
                        "why": f"conflict: {n} confirmed findings target this same path",
                    })
            deduped = [(idx, f) for idx, f in deduped if idx not in conflict_idxs]

        if deduped:
            plan[machine] = deduped

    return plan, refused


def apply_pass_a(docs: dict, roundtrip_ok: dict, dry_run: bool):
    batch_by_machine, verify_by_machine = load_p3_corpus()
    plan, refused = build_pass_a_selection(batch_by_machine, verify_by_machine)
    applied: list[dict] = []

    for machine, items in sorted(plan.items()):
        stem = f"{machine}_goals"
        if stem not in docs:
            for _idx, f in items:
                refused.append({"machine": machine, "path": f["path"], "why": f"data file {stem}.json does not exist"})
            continue
        if not roundtrip_ok[stem]:
            for _idx, f in items:
                refused.append({
                    "machine": machine, "path": f["path"],
                    "why": "round-trip no-op self-test failed for this file (pre-existing formatting "
                           "drift, e.g. trailing-zero floats) — refusing to touch it, a patch here "
                           "would diff every such value in the file, not just the intended field",
                })
            continue

        doc = docs[stem]
        pre_mutation = copy.deepcopy(doc)
        machine_ok: list[dict] = []
        for _idx, f in items:
            ok, why = apply_finding_to_doc(doc, f["path"], f["current"], f["proposed"])
            if ok:
                machine_ok.append(f)
            else:
                refused.append({"machine": machine, "path": f["path"], "why": why})

        if not machine_ok:
            continue

        if dry_run:
            for f in machine_ok:
                applied.append({"machine": machine, "path": f["path"], "kind": f.get("kind"), "proposed": f["proposed"]})
            continue

        BACKUP_A.mkdir(parents=True, exist_ok=True)
        data_file = DATA / f"{stem}.json"
        shutil.copy2(data_file, BACKUP_A / data_file.name)
        ok, errs = validate_and_maybe_rollback(stem, doc, BACKUP_A, pre_mutation, docs)
        if not ok:
            for f in machine_ok:
                refused.append({
                    "machine": machine, "path": f["path"],
                    "why": f"validator red post-write, ROLLED BACK: {'; '.join(errs[:5])}",
                })
            continue

        for f in machine_ok:
            applied.append({"machine": machine, "path": f["path"], "kind": f.get("kind"), "proposed": f["proposed"]})

    return applied, refused


# =============================================================================
# PASS B
# =============================================================================

def lane_adjacent(x: float, y: float) -> bool:
    return x >= 0.9 or (x >= 0.84 and y <= 0.6)


def plunge_reachable_band(x: float, y: float) -> bool:
    return y < 0.72 and x >= 0.57


FLIPPER_TECHNIQUES = {
    "backhand", "forehand", "on-the-fly", "from-cradle", "early-flip",
    "late-flip", "hold-flipper", "drop-catch", "live-catch", "dead-bounce",
    "post-pass", "tap-pass",
}  # excludes 'nudge': body english (table/machine nudging), not a flipper action

NEGATION_RE = re.compile(
    r"without (?:touching|holding) (?:the |a )?flipper|no flipper (?:touch|held|use)"
    r"|hands-free|flippers? can'?t steer|do not hold (?:a |the )?flipper|don'?t hold (?:a |the )?flipper"
    r"|no flipper held",
    re.IGNORECASE,
)
POSITIVE_RE = re.compile(
    r"hold(?:ing)?[- ](?:the |a )?(?:left |right |upper |lower )?flipper"
    r"|from the (?:left |right |upper |lower )*flipper"
    r"|off (?:the |your )(?:left |right |upper |lower )*flipper"
    r"|on (?:the |your )(?:left |right |upper |lower )*flipper"
    r"|catch.{0,25}flipper|flipper.{0,25}catch"
    r"|trap.{0,15}(?:up|flipper)|flipper.{0,15}trap"
    r"|cradle",
    re.IGNORECASE,
)

# Hand-reviewed (2026-08-11): POSITIVE_RE matched free text but full-sentence
# reading shows the flipper mention describes something OTHER than this
# goal's own scoring mechanism. Narrow (machine, goal) pairs, never a
# blanket heuristic — see module docstring.
TEXT_MATCH_FALSE_POSITIVE: dict[tuple[str, str], str] = {
    ("batman_66", "penguin-skillshot"):
        "detail's flipper mention ('miss the catch and it rolls to the flippers instead') "
        "is the MISS-RECOVERY fallback, not the primary mechanism — the goal's own target "
        "(the scoop) is reached by a direct feathered-plunge catch, no flipper on the make.",
    ("gorgar", "skillshot-b-lane"):
        "detail's flipper mention ('dead-bounce or trap on a flipper, since an uncontrolled "
        "exit can feed the right outlane') is POST-SCORE ball-safety advice for the bumper-"
        "nest exit that follows — the B-lane skill shot itself is a direct soft/medium "
        "plunge off the arch rail, already complete before that sentence starts.",
    ("x_men", "skill-cerebro"):
        "detail's flipper mention ('settles safely on the left flipper') describes where "
        "the ball lands AFTER scoring — the shot itself ('the ball feeds the left ramp for "
        "the collect') is a direct, automatic plunge feed with no flipper role in making it.",
}

# theatre_of_magic's trunk-skill-shot detail is TRUNCATED in the source data
# (ends mid-word: "...put the ball in the hole rathe") — a pre-existing,
# out-of-scope data bug found while auditing this restructure, flagged in
# the run report but not fixed here. Reusing it verbatim on the new step 1
# (it contains "Plunging"/"plunge") would duplicate the broken string into a
# second field; forcing the neutral fallback there avoids that without
# touching step 2's copy, which the template keeps verbatim regardless.
FORCE_NEUTRAL_DETAIL: set[tuple[str, str]] = {
    ("theatre_of_magic", "trunk-skill-shot"),
}

NEUTRAL_DETAIL = "Bring the ball down to the flippers — the skill shot is made with a flipper."


def detect_candidates(doc: dict):
    """Primary geometric detector (task's literal 3-condition rule). Returns
    [(goal, step, shot), ...]."""
    shots_by_id = {s["id"]: s for s in doc.get("shots", [])}
    out = []
    for g in doc.get("goals", []):
        if g.get("category") != "skillshot":
            continue
        steps = g.get("steps") or []
        if len(steps) != 1:
            continue
        step = steps[0]
        shot = shots_by_id.get(step.get("shot"))
        if shot is None or shot.get("type") == "plunge":
            continue
        x, y = shot.get("x"), shot.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        if lane_adjacent(x, y) or plunge_reachable_band(x, y):
            continue
        out.append((g, step, shot))
    return out


def detect_ambiguous_hint_band(doc: dict):
    """'target in the partial band but hint says full' (task's own named
    ambiguous example). Returns [(goal, x, y), ...] — always reported,
    never restructured; see module docstring."""
    shots_by_id = {s["id"]: s for s in doc.get("shots", [])}
    out = []
    for g in doc.get("goals", []):
        if g.get("category") != "skillshot":
            continue
        steps = g.get("steps") or []
        if len(steps) != 1:
            continue
        step = steps[0]
        shot = shots_by_id.get(step.get("shot"))
        if shot is None or shot.get("type") == "plunge":
            continue
        x, y = shot.get("x"), shot.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        if lane_adjacent(x, y) or not plunge_reachable_band(x, y):
            continue
        if step.get("plunge") == "full":
            out.append((g, x, y))
    return out


def classify(machine: str, goal_id: str, step: dict) -> tuple[str, str]:
    override = TEXT_MATCH_FALSE_POSITIVE.get((machine, goal_id))
    if override:
        return "skip", f"hand-reviewed false positive: {override}"

    action = step.get("action") or ""
    detail = step.get("detail") or ""
    text = f"{action} {detail}"
    tech = set(step.get("technique") or [])
    step_flip = step.get("flipper")

    neg = NEGATION_RE.search(text)
    if neg:
        return "skip", f"explicit no-flipper text ({neg.group(0)!r}) — restructuring would misdescribe the shot"

    signals = []
    pos_tech = tech & FLIPPER_TECHNIQUES
    if pos_tech:
        signals.append(f"technique={sorted(pos_tech)}")
    if step_flip:
        signals.append(f"step-level flipper override={step_flip!r}")
    pos_text = POSITIVE_RE.search(action) or POSITIVE_RE.search(detail)
    if pos_text:
        signals.append(f"text match {pos_text.group(0)!r}")

    if signals:
        return "restructure", "; ".join(signals)
    return "skip", ("no positive flipper signal (structural: technique/flipper field, or explicit "
                     "catch/hold/trap/cradle/\"from the flipper\" text) — default to skip rather than guess")


def find_plunge_shot(doc: dict) -> tuple[str | None, str | None]:
    plunge_shots = [s["id"] for s in doc.get("shots", []) if s.get("type") == "plunge"]
    if len(plunge_shots) == 1:
        return plunge_shots[0], None
    if len(plunge_shots) == 0:
        return None, "machine has no shot of type 'plunge' to anchor the new plunge-leg step on"
    return None, f"machine has {len(plunge_shots)} shots of type 'plunge' {plunge_shots} — ambiguous which one anchors the new step, not guessing"


def build_restructured_steps(machine: str, goal_id: str, step: dict, plunge_shot_id: str) -> list[dict]:
    original_detail = step.get("detail")
    describes_plunge = (
        bool(original_detail)
        and "plunge" in original_detail.lower()
        and (machine, goal_id) not in FORCE_NEUTRAL_DETAIL
    )

    step1: dict = {
        "shot": plunge_shot_id,
        "action": "Plunge through to the flippers",
        "detail": original_detail if describes_plunge else NEUTRAL_DETAIL,
    }
    if step.get("plunge"):
        step1["plunge"] = step["plunge"]
        if step.get("plungeTo") is not None:
            step1["plungeTo"] = step["plungeTo"]

    step2: dict = {
        "shot": step["shot"],
        "action": step.get("action"),
        "detail": original_detail,
    }
    # link/technique are the task's own explicit "preserve" list; flipper is
    # an extension (see module docstring) so Pass B never silently reverts a
    # flipper field Pass A just confirmed onto this same step.
    for k in ("link", "technique", "flipper"):
        if step.get(k) is not None:
            step2[k] = step[k]

    return [step1, step2]


def apply_pass_b(docs: dict, roundtrip_ok: dict, dry_run: bool):
    restructured: list[dict] = []
    skipped: list[dict] = []

    for stem in sorted(docs.keys()):
        if not stem.endswith("_goals"):
            continue
        machine = stem[: -len("_goals")]
        if machine in FLAGSHIP:
            continue  # skip entirely — see FLAGSHIP; already summarized via passA.skippedFlagship

        doc = docs[stem]

        for g, x, y in detect_ambiguous_hint_band(doc):
            skipped.append({
                "machine": machine, "goal": g["id"],
                "why": (f"ambiguous: target ({x},{y}) sits in the plunge-reachable geometric band "
                        f"but plunge hint is 'full', which overrides geometry at render time — "
                        f"could be a genuine flipper-made shot or a legitimate full-strength direct "
                        f"plunge (classifyPlunge's own doc comment cites this exact ambiguity); "
                        f"skipping per task instruction rather than guessing"),
            })

        candidates = detect_candidates(doc)
        if not candidates:
            continue

        plunge_shot_id, no_plunge_why = find_plunge_shot(doc)

        to_restructure: list[tuple[dict, dict]] = []
        for g, step, shot in candidates:
            decision, why = classify(machine, g["id"], step)
            if decision != "restructure":
                skipped.append({"machine": machine, "goal": g["id"], "why": why})
                continue
            if plunge_shot_id is None:
                skipped.append({"machine": machine, "goal": g["id"], "why": no_plunge_why})
                continue
            to_restructure.append((g, step))

        if not to_restructure:
            continue

        if len(to_restructure) > 6:
            for g, _step in to_restructure:
                skipped.append({
                    "machine": machine, "goal": g["id"],
                    "why": f"cap exceeded: {len(to_restructure)} skillshot goals flagged for "
                           f"restructure on this machine (>6) — flagged for review rather than "
                           f"trusted at this volume",
                })
            continue

        if not roundtrip_ok[stem]:
            for g, _step in to_restructure:
                skipped.append({
                    "machine": machine, "goal": g["id"],
                    "why": "round-trip no-op self-test failed for this file (pre-existing formatting "
                           "drift) — refusing to touch it",
                })
            continue

        # Mutate in-memory regardless of dry_run (mirrors apply_pass_a) so a
        # --dry-run preview and any downstream read of docs[stem] see the
        # real post-restructure shape; only the disk write + validator call
        # below is gated on --apply.
        pre_mutation = copy.deepcopy(doc)
        for g, step in to_restructure:
            g["steps"] = build_restructured_steps(machine, g["id"], step, plunge_shot_id)

        if dry_run:
            for g, _step in to_restructure:
                restructured.append({"machine": machine, "goal": g["id"]})
            continue

        BACKUP_B.mkdir(parents=True, exist_ok=True)
        data_file = DATA / f"{stem}.json"
        shutil.copy2(data_file, BACKUP_B / data_file.name)
        ok, errs = validate_and_maybe_rollback(stem, doc, BACKUP_B, pre_mutation, docs)
        if not ok:
            for g, _step in to_restructure:
                skipped.append({
                    "machine": machine, "goal": g["id"],
                    "why": f"validator red post-write, ROLLED BACK: {'; '.join(errs[:5])}",
                })
            continue

        for g, step in to_restructure:
            restructured.append({"machine": machine, "goal": g["id"]})

    return restructured, skipped


# =============================================================================
# main
# =============================================================================

def print_summary(report: dict) -> None:
    pa, pb = report["passA"], report["passB"]
    print()
    print("=" * 78)
    print("PASS A (plunge/technique step patches)")
    print(f"  applied            : {len(pa['applied'])}")
    print(f"  refused            : {len(pa['refused'])}")
    print(f"  skippedFlagship    : {pa['skippedFlagship']}")
    refusal_kinds: dict[str, int] = {}
    for r in pa["refused"]:
        key = r["why"].split(":")[0].split(" (")[0][:40]
        refusal_kinds[key] = refusal_kinds.get(key, 0) + 1
    for k, v in sorted(refusal_kinds.items(), key=lambda kv: -kv[1]):
        print(f"      {v:3d}  {k}")
    print()
    print("PASS B (skillshot structural restructure)")
    print(f"  restructured       : {len(pb['restructured'])}")
    by_machine: dict[str, int] = {}
    for r in pb["restructured"]:
        by_machine[r["machine"]] = by_machine.get(r["machine"], 0) + 1
    for m, n in sorted(by_machine.items()):
        print(f"      {m}: {n}")
    print(f"  skipped            : {len(pb['skipped'])}")
    skip_kinds: dict[str, int] = {}
    for s in pb["skipped"]:
        key = s["why"].split(":")[0].split(" (")[0][:40]
        skip_kinds[key] = skip_kinds.get(key, 0) + 1
    for k, v in sorted(skip_kinds.items(), key=lambda kv: -kv[1]):
        print(f"      {v:3d}  {k}")
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

    applied_a, refused_a = apply_pass_a(docs, roundtrip_ok, dry_run)
    restructured_b, skipped_b = apply_pass_b(docs, roundtrip_ok, dry_run)

    report = {
        "passA": {
            "applied": applied_a,
            "refused": refused_a,
            "skippedFlagship": sorted(FLAGSHIP),
        },
        "passB": {
            "restructured": restructured_b,
            "skipped": skipped_b,
        },
    }

    print_summary(report)

    if dry_run:
        print("\ndry-run: no writes, no output file")
        return 0

    BIZ.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
