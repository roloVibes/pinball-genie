#!/usr/bin/env python3
"""P4 (feeds) applier — dataset schema v5 (see app/src/models.ts's FeedRef /
Shot.feeds doc comments) and SPEC-PATHVIZ rule 7.

Consumes _Business/catalog-passes/p4/batch-{1..11}.json (research findings:
{machines:[{machine, findings:[{path:'shots[<id>].feeds', kind:'feeds',
current:null, proposed:<FeedRef>, reason, evidence, confidence}], unknowns,
contradictions}]}) + verify-{1,2,3}.json (independent verification pass:
{machines:[{machine, verdicts:[{path, verdict, why}]}]}).

SELECTION RULE: apply ONLY findings whose verify verdict (matched by exact
`path` string) is 'confirmed'. refuted/uncertain/no-matching-verdict findings
are reported in refused[], not applied — high refusal rates are correct when
verify disagreed with research. Every finding in this corpus carries
`current: null` (checked live before this script was written: 0 exceptions
across all 299 findings) — a P4 finding only ever proposes a feeds value for
a shot that had none; a disagreement with an EXISTING feeds value is what
contradictions[] is for (see below, never applied by this script). Some
verify files also carry an extra verdict entry for a path that is NOT in
findings[] at all (star_wars_fote's shots[center-ramp].feeds is verify
independently re-confirming a contradiction, not a proposal) — harmless here
because selection iterates findings and looks up a verdict by path, never
the reverse, so a verify-only path is simply never visited.

FLAGSHIPS (jaws/evil_dead/halloween): the owner hand-authors these tables'
feeds directly (Jaws' shooter-lane loop-coil around the fishing-reel spinner
is the reference case drawing.ts's own loop-coil code cites). ANY finding
touching one of these three is refused unconditionally, before the verdict
is even consulted, and reported in `skippedFlagship` rather than `refused`
per the task's explicit 4-way output split. Checked live: only 1 such
finding exists in the whole corpus (jaws' shots[left-orbit].feeds — itself
verify-CONFIRMED, refused anyway); evil_dead and halloween have zero P4
findings.

Guards (philosophy follows p2-apply.py/p3-apply.py's own house pattern —
read both before touching this file: each guard exists because a prior
applier shipped a defect without it; refusals are expected output, not
failures):

  * round-trip no-op self-test per file, checked ONCE per file at load time
    (not per-write): json.dumps(doc, indent=2)+"\\n" must reproduce the file
    byte-for-byte. 5 of 139 files fail this today, same reason p3-apply.py
    found (trailing-zero floats json.dumps normalizes away): avatar, csi,
    cue_ball_wizard, starship_troopers, tron_legacy. starship_troopers is
    named in the task brief as a known offender — confirmed live: it carries
    2 CONFIRMED P4 findings, both refused by this guard. 11 confirmed
    findings total are refused across all 5 files.
  * verbatim current-match: every confirmed finding's `current` is null, so
    this collapses to "the target shot's LIVE `feeds` must be null/absent
    right now" (JSON absent-key and explicit-null read the same way
    validate-machines.py's own checks do) — else refused as 'file moved'.
    Checked live against real data before this script was written (0
    mismatches at that time across all 226 non-flagship confirmed
    findings), but the live check in apply_finding_to_doc is authoritative,
    not that pre-check. A finding whose OWN `current` is non-null (never
    happens in this corpus) is refused outright — this applier only knows
    how to verbatim-match the null shape the task and the corpus both use.
  * FeedRef shape check: keys outside x/y/shot/loop are refused outright
    (never silently dropped the way p2-apply.py drops zones' known-universal
    stray `estimate` key — there is no analogous KNOWN stray key here, so an
    unexpected one is a shape defect worth a human look, not noise to
    discard). A `shot` / `loop.shot` reference must resolve to an existing
    shot id on the SAME machine. `x`/`y` (outer or loop) must be numeric in
    [0,1]. NEW, beyond the task's literal "shot refs must resolve; loop refs
    must resolve" wording but squarely inside its intent: the OUTER ref must
    itself carry a resolvable point (`shot`, or BOTH `x` and `y`) — a
    `loop`-only proposed value (no top-level shot/x/y) is refused, because
    shotgeom.ts's resolveFeedUV returns null for an outer ref with neither,
    and drawing.ts's rampExtensionLegs bails out on that
    (`if (!feedUV) return null`) BEFORE it ever reads `.loop` — applying one
    would silently render nothing, exactly the "invisible-in-review" defect
    class validate-machines.py's own check_feedref docstring cites as its
    reason for existing (the street_fighter_ii right-ramp shipped that way
    once). Verified UNEXERCISED by the confirmed set — all 4 loop-only
    proposals in the whole corpus (beetlejuice, big_hurt x2, breakshot) were
    independently refuted by verify already, for unrelated evidentiary
    reasons — but implemented per the task's guard list anyway, the same way
    p3-apply.py keeps its own unexercised title-fix guard.
  * one-write-per-path conflict refusal + (path,proposed) exact dedupe,
    scoped per machine — both checked before any file is touched. Neither
    fires on this corpus (checked: 0 machines have two confirmed findings
    naming the same shot's feeds), implemented for the same reason as above.
  * per-machine backup to scratchpad/data-backup-p4/ before that machine's
    (single, combined) write; validate-machines.py must stay clean for THIS
    machine's file (ERROR-line filename prefix, matching p2/p3's own
    convention) or the pre-write backup is restored (file + in-memory doc)
    and the run continues with the remaining machines either way.

CONTRADICTIONS (informational only, no data touched): each batch machine's
`contradictions[]` list names an EXISTING (already-shipped) feeds value the
video evidence disagrees with — 3 across the whole corpus (cactus_canyon
train-ramp, mandalorian right-ramp — evidence genuinely conflicting, not
resolved either way — and star_wars_fote center-ramp, independently
re-confirmed by verify-3). Per the task's explicit instruction this run
NEVER edits an existing feeds value (that is the flipper-anchor review's
call, not this script's) — they are only collected into the output's
`contradictionsForReview` for that review.

Run:
  python3 app/scripts/p4-apply.py --dry-run
  python3 app/scripts/p4-apply.py --apply
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
P4 = BIZ / "catalog-passes" / "p4"
VALIDATE = ROOT / "app" / "scripts" / "validate-machines.py"
BACKUP_DIR = SCRATCH / "data-backup-p4"
OUTPUT = BIZ / "P4-APPLY-2026-08-11.json"

# Bare machine keys, as used throughout the P4 corpus's "machine" field (NOT
# "_goals" suffixed) — skipped entirely regardless of verdict: the owner
# hand-authored their feeds directly.
FLAGSHIP = {"jaws", "evil_dead", "halloween"}

PATH_RE = re.compile(r"^shots\[(?P<id>[a-zA-Z0-9_-]+)\]\.feeds$")
FEEDREF_FIELDS = ("x", "y", "shot", "loop")
FEEDREF_LOOP_FIELDS = ("x", "y", "shot")


def dump(doc: dict) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def run_validator() -> tuple[int, str]:
    val = subprocess.run([sys.executable, str(VALIDATE)], capture_output=True, text=True, cwd=ROOT)
    return val.returncode, val.stdout + val.stderr


def load_all_docs():
    """Loads every data/*_goals.json once. docs[stem] is mutated in place by
    apply_plan; roundtrip_ok[stem] is computed once against the ORIGINAL
    on-disk bytes (see module docstring for why once-at-load is equivalent
    to checking before every write)."""
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


def load_p4_corpus():
    batch_by_machine: dict[str, dict] = {}
    for i in range(1, 12):
        d = json.loads((P4 / f"batch-{i}.json").read_text(encoding="utf-8"))
        for m in d["machines"]:
            batch_by_machine[m["machine"]] = m
    verify_by_machine: dict[str, dict] = {}
    for i in (1, 2, 3):
        d = json.loads((P4 / f"verify-{i}.json").read_text(encoding="utf-8"))
        for m in d["machines"]:
            verify_by_machine[m["machine"]] = m
    return batch_by_machine, verify_by_machine


def validate_feedref_shape(proposed, shot_ids: set[str]) -> str | None:
    """Returns a refusal reason, or None if the shape is OK. See module
    docstring's FeedRef-shape guard paragraph for why each check exists."""
    if not isinstance(proposed, dict):
        return f"proposed feeds value must be an object, got {type(proposed).__name__}"
    extra = sorted(set(proposed.keys()) - set(FEEDREF_FIELDS))
    if extra:
        return f"proposed FeedRef carries unexpected key(s) {extra} outside x/y/shot/loop"
    sid = proposed.get("shot")
    if sid is not None and sid not in shot_ids:
        return f"proposed shot ref {sid!r} does not resolve to an existing shot on this machine"
    for axis in ("x", "y"):
        v = proposed.get(axis)
        if v is not None and not (isinstance(v, (int, float)) and 0.0 <= v <= 1.0):
            return f"proposed {axis}={v!r} outside the 0..1 playfield"
    loop = proposed.get("loop")
    if loop is not None:
        if not isinstance(loop, dict):
            return "proposed feeds.loop must be an object"
        lextra = sorted(set(loop.keys()) - set(FEEDREF_LOOP_FIELDS))
        if lextra:
            return f"proposed feeds.loop carries unexpected key(s) {lextra}"
        lsid = loop.get("shot")
        if lsid is not None and lsid not in shot_ids:
            return f"proposed feeds.loop shot ref {lsid!r} does not resolve to an existing shot on this machine"
        for axis in ("x", "y"):
            v = loop.get(axis)
            if v is not None and not (isinstance(v, (int, float)) and 0.0 <= v <= 1.0):
                return f"proposed feeds.loop {axis}={v!r} outside the 0..1 playfield"
    has_shot = proposed.get("shot") is not None
    has_xy = proposed.get("x") is not None and proposed.get("y") is not None
    if not has_shot and not has_xy:
        return (
            "no resolvable OUTER point (needs `shot`, or both `x` and `y` — a lone `x`, lone `y`, "
            "or `loop`-only value never resolves): resolveFeedUV returns null for the outer ref, and "
            "rampExtensionLegs bails out on that before it ever reads `.loop` — this would silently "
            "render nothing, the invisible-in-review defect class check_feedref's own docstring cites "
            "(street_fighter_ii's right-ramp shipped that way once)"
        )
    return None


def apply_finding_to_doc(doc: dict, path: str, current, proposed) -> tuple[bool, str | None]:
    """Mutates `doc` in place on success (sets shots[id].feeds = proposed).
    Returns (ok, why_if_refused)."""
    m = PATH_RE.match(path)
    if not m:
        return False, f"unparseable path: {path!r} — p4's corpus is 100% shots[<id>].feeds, this is out of scope"
    ident = m.group("id")
    shots = doc.get("shots") or []
    shot = next((s for s in shots if s.get("id") == ident), None)
    if shot is None:
        return False, f"shot not found: shots[{ident}] does not exist in file — the file moved since research"
    if current is not None:
        return False, f"non-null current: finding carries {current!r} — this applier only handles the corpus's current:null shape"
    actual = shot.get("feeds")
    if actual is not None:
        return False, f"current mismatch: expected null (no existing feeds), file already has {actual!r} — the file moved since research"
    shot_ids = {s.get("id") for s in shots}
    shape_err = validate_feedref_shape(proposed, shot_ids)
    if shape_err:
        return False, f"shape: {shape_err}"
    shot["feeds"] = copy.deepcopy(proposed)
    return True, None


def build_selection(batch_by_machine: dict, verify_by_machine: dict):
    """Data-shape guards that don't need file I/O: flagship exclusion,
    verdict==confirmed, (path,proposed) dedupe, one-write-per-path conflict.
    Returns (plan: {machine: [finding, ...]}, refused: [...],
    skipped_flagship: [...])."""
    plan: dict[str, list[dict]] = {}
    refused: list[dict] = []
    skipped_flagship: list[dict] = []

    for machine, bm in sorted(batch_by_machine.items()):
        vm = verify_by_machine.get(machine)
        verdict_by_path: dict[str, str] = {}
        why_by_path: dict[str, str] = {}
        if vm:
            for v in vm["verdicts"]:
                verdict_by_path[v["path"]] = v["verdict"]
                why_by_path[v["path"]] = v.get("why") or ""

        selected: list[dict] = []
        for f in bm["findings"]:
            path = f["path"]
            if machine in FLAGSHIP:
                skipped_flagship.append({
                    "machine": machine, "path": path, "proposed": f["proposed"],
                    "why": "flagship-owned (JAWS/EVIL_DEAD/HALLOWEEN skipped entirely, regardless of "
                           "verdict — owner hand-authored feeds are canonical)",
                })
                continue
            verdict = verdict_by_path.get(path)
            if verdict != "confirmed":
                why = (why_by_path.get(path) or "no matching verify verdict")[:300]
                refused.append({"machine": machine, "path": path, "why": f"verdict {verdict!r}: {why}"})
                continue
            selected.append(f)

        # dedupe: identical (path, proposed) collapses to the first
        seen: dict[tuple[str, str], dict] = {}
        deduped: list[dict] = []
        for f in selected:
            key = (f["path"], json.dumps(f["proposed"], sort_keys=True))
            if key in seen:
                refused.append({
                    "machine": machine, "path": f["path"],
                    "why": "duplicate: another confirmed finding with identical (path,proposed) already selected",
                })
                continue
            seen[key] = f
            deduped.append(f)

        # one-write-per-path conflict
        by_path: dict[str, list[dict]] = {}
        for f in deduped:
            by_path.setdefault(f["path"], []).append(f)
        conflict_paths = {p for p, fs in by_path.items() if len(fs) > 1}
        if conflict_paths:
            kept = []
            for f in deduped:
                if f["path"] in conflict_paths:
                    n = len(by_path[f["path"]])
                    refused.append({
                        "machine": machine, "path": f["path"],
                        "why": f"conflict: {n} confirmed findings target this same path",
                    })
                else:
                    kept.append(f)
            deduped = kept

        if deduped:
            plan[machine] = deduped

    return plan, refused, skipped_flagship


def apply_plan(docs: dict, roundtrip_ok: dict, plan: dict, refused: list[dict], dry_run: bool):
    """Extends `refused` in place with any write-phase refusals; returns
    (applied, refused) — `refused` is the SAME list passed in, per p3-apply.py's
    own two-phase accumulation convention."""
    applied: list[dict] = []

    for machine, items in sorted(plan.items()):
        stem = f"{machine}_goals"
        if stem not in docs:
            for f in items:
                refused.append({"machine": machine, "path": f["path"], "why": f"data file {stem}.json does not exist"})
            continue
        if not roundtrip_ok[stem]:
            for f in items:
                refused.append({
                    "machine": machine, "path": f["path"],
                    "why": "round-trip no-op self-test failed for this file (pre-existing formatting "
                           "drift, e.g. trailing-zero floats) — refusing to touch it, a patch here "
                           "would diff every such value in the file, not just the intended field",
                })
            continue

        doc = docs[stem]
        pre_mutation = copy.deepcopy(doc)
        machine_ok: list[tuple[str, dict]] = []  # (shot id, proposed FeedRef)
        for f in items:
            ok, why = apply_finding_to_doc(doc, f["path"], f["current"], f["proposed"])
            if ok:
                ident = PATH_RE.match(f["path"]).group("id")
                machine_ok.append((ident, f["proposed"]))
            else:
                refused.append({"machine": machine, "path": f["path"], "why": why})

        if not machine_ok:
            continue

        shots_out = [{"id": i, "feeds": p} for i, p in machine_ok]

        if dry_run:
            applied.append({"machine": machine, "shots": shots_out})
            continue

        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        data_file = DATA / f"{stem}.json"
        shutil.copy2(data_file, BACKUP_DIR / data_file.name)
        ok, errs = validate_and_maybe_rollback(stem, doc, BACKUP_DIR, pre_mutation, docs)
        if not ok:
            for ident, _proposed in machine_ok:
                refused.append({
                    "machine": machine, "path": f"shots[{ident}].feeds",
                    "why": f"validator red post-write, ROLLED BACK: {'; '.join(errs[:5])}",
                })
            continue

        applied.append({"machine": machine, "shots": shots_out})

    return applied, refused


def collect_contradictions(batch_by_machine: dict) -> list[dict]:
    out: list[dict] = []
    for machine, bm in sorted(batch_by_machine.items()):
        for c in bm.get("contradictions") or []:
            entry = {"machine": machine}
            entry.update(c)
            out.append(entry)
    return out


def print_summary(report: dict) -> None:
    print()
    print("=" * 78)
    print("P4 APPLY (feeds)")
    print(f"  applied machines   : {len(report['applied'])}")
    print(f"  applied shots      : {sum(len(a['shots']) for a in report['applied'])}")
    print(f"  refused            : {len(report['refused'])}")
    refusal_kinds: dict[str, int] = {}
    for r in report["refused"]:
        key = r["why"].split(":")[0].split(" (")[0][:40]
        refusal_kinds[key] = refusal_kinds.get(key, 0) + 1
    for k, v in sorted(refusal_kinds.items(), key=lambda kv: -kv[1]):
        print(f"      {v:3d}  {k}")
    print(f"  skippedFlagship    : {len(report['skippedFlagship'])}")
    for s in report["skippedFlagship"]:
        print(f"      {s['machine']}: {s['path']}")
    print(f"  contradictionsForReview: {len(report['contradictionsForReview'])}")
    for c in report["contradictionsForReview"]:
        print(f"      {c['machine']}: {c.get('shot')}")
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

    batch_by_machine, verify_by_machine = load_p4_corpus()
    plan, refused, skipped_flagship = build_selection(batch_by_machine, verify_by_machine)
    applied, refused = apply_plan(docs, roundtrip_ok, plan, refused, dry_run)
    contradictions = collect_contradictions(batch_by_machine)

    report = {
        "applied": applied,
        "refused": refused,
        "skippedFlagship": skipped_flagship,
        "contradictionsForReview": contradictions,
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
