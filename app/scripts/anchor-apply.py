#!/usr/bin/env python3
"""Anchor applier (flipper-anchor / bat-size / feeds-correction) — dataset
schema v5 (see app/src/models.ts's Shot.flipper / Shot.bat / FeedRef doc
comments) and SPEC-PATHVIZ rules 6/7.

Consumes _Business/catalog-passes/anchor/research-{1,2,3}.json (research
findings: {machines:[{machine, findings:[{path, kind:'flipper-anchor'|
'feeds-correction'|'bat-size', current, proposed, reason, evidence,
confidence}]}]}) + verify.json (independent verification pass: {machines:
[{machine, verdicts:[{path, verdict, why}]}]}). Guard philosophy follows
p3-apply.py/p4-apply.py's own house pattern (read both before touching this
file): each guard exists because a prior applier shipped a defect without
it; refusals are expected output, not failures.

Unlike p3/p4, this corpus's `machine` field is ALREADY `_goals`-suffixed
(e.g. "ac_dc_goals", "jaws_goals" — verified live: every one of the 184
findings' machine strings matches a real data/<machine>.json file 1:1), so
this script uses it directly as the file stem rather than appending
"_goals" the way p3/p4's bare-key corpus required.

SELECTION RULE: apply ONLY findings whose verify verdict (matched by exact
`path` string) is 'confirmed'. This corpus's verify.json is a clean 1:1 with
research's findings — checked live: all 184 findings have exactly one
verify verdict and there are zero verify-only paths (no p4-style "extra
confirmatory entry" to worry about). Verdict split: 155 confirmed / 26
uncertain / 3 refuted across all 184; refuted/uncertain findings are
reported in refused[], not applied — high refusal rates are correct when
verify disagreed with research.

PATH SHAPE: every finding in this corpus is a single-field whole-value
replace on a shot — `shots[<id>].flipper` (175), `shots[<id>].bat` (8), or
`shots[<id>].feeds` (1) — never a goals[]/steps[] patch. Dispatch below is
by this PATH SUFFIX, not by the finding's own `kind` label, because the
corpus has a confirmed labeling defect: 2 findings (star_trek_the_next_
generation's upper-right-flipper, street_fighter_ii's upper-left-flipper)
carry `kind: 'flipper-anchor'` but target a `.bat` path with a bat-shaped
`{"size": "full"}` proposed value — genuine "Black-Knight-class exception"
bat findings, just mislabeled. Path-driven dispatch handles them correctly
without special-casing; the report below still echoes each finding's own
(mislabeled) `kind` field verbatim for corpus fidelity.

Guards:
  * round-trip no-op self-test, checked ONCE per file at load time (not
    per-write): json.dumps(doc, indent=2)+"\\n" must reproduce the file
    byte-for-byte. Checked once because it can only ever get MORE true
    during a run that writes exclusively through the same dump(), never
    less. 6 of 141 files fail this TODAY — avatar, csi, cue_ball_wizard,
    harry_potter, starship_troopers, tron_legacy — one MORE than the 5
    named in this task's own brief (avatar/csi/cue_ball_wizard/
    starship_troopers/tron_legacy): harry_potter_goals is a fresh offender,
    diffed live before this script was written, and for a DIFFERENT root
    cause than the other five's trailing-zero floats — its source file
    spells em dashes as literal `\\u2014` escapes, which json.dumps(...,
    ensure_ascii=False) normalizes to the raw `—` character. avatar and
    cue_ball_wizard have zero findings in this corpus (inconsequential);
    csi(1)/harry_potter(2)/starship_troopers(6)/tron_legacy(4) = 13
    confirmed non-flagship findings are refused by this guard.
  * verbatim `current` match: every finding's `current` is either `null`
    (flipper-anchor, bat-size: 183 of 184) or a full FeedRef dict (the
    single feeds-correction: mandalorian's shots[right-ramp].feeds, current
    {"shot":"left-inlane"}) — this collapses to "the target shot's LIVE
    value at this field must equal `current` exactly right now" (JSON
    absent-key and explicit-null read the same way validate-machines.py's
    own checks do), else refused as 'file moved'. Checked live against real
    data before this script was written: 0 mismatches across all 184
    findings — but the live check in apply_finding_to_doc is authoritative,
    not that pre-check.
  * field-specific proposed-value guards (never silently coerced):
      - flipper: proposed must be a string, and either 'left'/'right' or
        resolve to an existing `type:'flipper'` shot id on the SAME
        machine. This mirrors validate-machines.py's OWN rule for
        GoalStep.flipper (line ~526) — but Shot.flipper (what every one of
        this corpus's 175 real .flipper findings targets) has NO validator
        check on its value at all today, confirmed by reading
        validate-machines.py in full before writing this guard. Without it,
        a bad anchor would ship silently. Checked live: 0 of 175 proposed
        values fail this.
      - bat: proposed must be an object with keys only from {side, size},
        side in (None,'left','right'), size in (None,'full','mini') — the
        exact shape of models.ts's `Shot['bat']`. validate-machines.py DOES
        check this post-write (side/size legality; object shape), so this
        pre-write guard mainly avoids a wasted backup+rollback cycle; the
        extra-key check is NEW beyond what the validator does (mirrors p4-
        apply.py's own stray-key discipline for FeedRef — no known stray
        key exists here, so an unexpected one is a shape defect worth a
        human look). All 8 confirmed-shape proposals are `{"size": "full"|
        "mini"}` with no `side` — checked live.
      - feeds: identical FeedRef shape guard as p4-apply.py's
        validate_feedref_shape (ported near-verbatim: x/y/shot/loop only;
        `shot`/`loop.shot` must resolve to an existing shot id on this
        machine; x/y in [0,1]; the OUTER ref must itself carry a resolvable
        point). Unlike P4 (which only ever finds current:null and never
        touches an existing feeds value), this pass's ONE feeds-correction
        finding explicitly REPLACES an existing, non-null FeedRef — that is
        this task's point (P4 deliberately routed contradictions here
        instead of resolving them itself) — gated the same way as every
        other field by the verbatim current-match above, not by nullness.
  * one-write-per-path conflict refusal + (path,proposed) exact dedupe,
    scoped per machine — both checked before any file is touched. Neither
    fires on this corpus (checked live: 0 machines have two findings on the
    same path, and no machine name repeats across research-1/2/3), kept for
    the same reason p3/p4 keep their own unexercised guards.
  * flagship exclusion: JAWS/EVIL_DEAD/HALLOWEEN (as `jaws_goals`/
    `evil_dead_goals`/`halloween_goals`, this corpus's own machine-key
    convention) are skipped entirely — the owner hand-authored their own
    anchors; ANY finding touching them is refused as flagship-owned,
    independent of verdict, and reported separately in `skippedFlagship`
    rather than `refused`. Checked live: 6 such findings exist (jaws'
    ship-wheel-spinner/lookout-tower-ramp/radio-target, evil_dead's lock-
    and-load/book-target/shotgun-targets, all kind flipper-anchor, all
    path shots[<id>].flipper) — halloween has zero findings in this corpus.
  * per-machine backup to scratchpad/data-backup-anchor/ before that
    machine's (single, combined) write; validate-machines.py must stay
    clean for THIS machine's file (ERROR-line filename prefix, matching
    p2/p3/p4's own convention) or the pre-write backup is restored (file +
    in-memory doc) and the run continues with the remaining machines
    either way.

Expected shape of a clean run (all pre-checked live before writing this
script, not asserted after the fact): 6 findings skippedFlagship; 28
refused by verdict (25 uncertain + 3 refuted); 13 refused by the round-trip
guard; up to 137 applied (130 flipper + 6 bat + 1 feeds) pending only the
post-write validator gate, which nothing here is expected to trip since (a)
Shot.flipper carries no validator check to fail and (b) the bat/feeds
guards above are exact mirrors of the validator's own checks.

Run:
  python3 app/scripts/anchor-apply.py --dry-run
  python3 app/scripts/anchor-apply.py --apply
"""

from __future__ import annotations

import argparse
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
ANCHOR = BIZ / "catalog-passes" / "anchor"
VALIDATE = ROOT / "app" / "scripts" / "validate-machines.py"
BACKUP_DIR = SCRATCH / "data-backup-anchor"
OUTPUT = BIZ / "ANCHOR-APPLY-2026-08-11.json"

# This corpus's own `machine` field IS the file stem (e.g. "jaws_goals"),
# unlike p3/p4's bare-key convention — verified live against data/*.json.
FLAGSHIP = {"jaws_goals", "evil_dead_goals", "halloween_goals"}

PATH_RE = re.compile(r"^shots\[(?P<id>[a-zA-Z0-9_-]+)\]\.(?P<field>flipper|bat|feeds)$")
BAT_FIELDS = ("side", "size")
BAT_SIDES = ("left", "right")
BAT_SIZES = ("full", "mini")
FEEDREF_FIELDS = ("x", "y", "shot", "loop")
FEEDREF_LOOP_FIELDS = ("x", "y", "shot")


def dump(doc: dict) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def atomic_write(path: pathlib.Path, text: str) -> None:
    """Writes `text` to `path` atomically (temp file in the same directory +
    os.replace) so a concurrent reader — the vision-sweep workflow also
    reading data/ during this run — never observes a partially-written
    file. Used for BOTH the accepted-write and the rollback-restore below;
    neither ever goes through a plain write_text/copy2 onto a live path in
    data/. One write per file per call, matching the module docstring's
    per-machine single-combined-write contract."""
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
    atomic_write(data_file, dump(doc))
    rc, out = run_validator()
    stem_file = f"{stem}.json"
    stem_errors = [l for l in out.splitlines() if l.startswith(f"ERROR {stem_file}:")]
    if rc != 0:
        all_errors = [l for l in out.splitlines() if l.startswith("ERROR ")]
        errs = stem_errors or all_errors or [f"validate-machines.py exited {rc} with no ERROR lines captured"]
        backup_text = (backup_dir / data_file.name).read_text(encoding="utf-8")
        atomic_write(data_file, backup_text)
        docs[stem] = pre_mutation_doc
        return False, errs
    return True, []


def load_anchor_corpus():
    """Returns (machine_findings, verify_by_machine). Accumulates findings
    per machine via list-extend (not a dict overwrite keyed by machine, the
    way p3/p4 do it) — a research-N.json machine key repeating across files
    would silently drop the earlier file's entries under overwrite; verified
    live that this corpus has zero such repeats, but extend is correct
    either way and costs nothing."""
    machine_findings: dict[str, list[dict]] = {}
    for i in (1, 2, 3):
        d = json.loads((ANCHOR / f"research-{i}.json").read_text(encoding="utf-8"))
        for m in d["machines"]:
            machine_findings.setdefault(m["machine"], []).extend(m["findings"])
    verify_by_machine: dict[str, dict] = {}
    d = json.loads((ANCHOR / "verify.json").read_text(encoding="utf-8"))
    for m in d["machines"]:
        verify_by_machine[m["machine"]] = m
    return machine_findings, verify_by_machine


def validate_flipper_value(proposed, flipper_shot_ids: set[str]) -> str | None:
    """Mirrors validate-machines.py's own rule for GoalStep.flipper (there
    is no equivalent check for Shot.flipper in the validator itself — see
    module docstring). Returns a refusal reason, or None if legal."""
    if not isinstance(proposed, str):
        return f"proposed flipper value must be a string, got {type(proposed).__name__}"
    if proposed in ("left", "right"):
        return None
    if proposed in flipper_shot_ids:
        return None
    return f"proposed flipper {proposed!r} is neither 'left'/'right' nor a type:'flipper' shot id in this file"


def validate_bat_value(proposed) -> str | None:
    """Mirrors validate-machines.py's own shots[].bat checks (side/size
    legality), plus a stray-key check the validator itself does not do
    (mirrors p4-apply.py's own FeedRef stray-key discipline)."""
    if not isinstance(proposed, dict):
        return f"proposed bat value must be an object, got {type(proposed).__name__}"
    extra = sorted(set(proposed.keys()) - set(BAT_FIELDS))
    if extra:
        return f"proposed bat carries unexpected key(s) {extra} outside side/size"
    side = proposed.get("side")
    if side not in (None, *BAT_SIDES):
        return f"proposed bat.side {side!r} is not left/right"
    size = proposed.get("size")
    if size not in (None, *BAT_SIZES):
        return f"proposed bat.size {size!r} is not full/mini"
    return None


def validate_feedref_shape(proposed, shot_ids: set[str]) -> str | None:
    """Ported near-verbatim from p4-apply.py — identical FeedRef type, same
    reasoning (see that file's own docstring for the full rationale on each
    check, in particular why a loop-only outer ref is refused)."""
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
            "render nothing, the invisible-in-review defect class check_feedref's own docstring cites"
        )
    return None


def apply_finding_to_doc(doc: dict, path: str, current, proposed) -> tuple[bool, str | None, str | None]:
    """Mutates `doc` in place on success (sets shots[id].<field> = proposed).
    Returns (ok, why_if_refused, field_if_matched)."""
    m = PATH_RE.match(path)
    if not m:
        return False, f"unparseable path {path!r} — this applier only handles shots[<id>].flipper|bat|feeds", None
    ident, field = m.group("id"), m.group("field")
    shots = doc.get("shots") or []
    shot = next((s for s in shots if s.get("id") == ident), None)
    if shot is None:
        return False, f"shot not found: shots[{ident}] does not exist in file — the file moved since research", field

    actual = shot.get(field)
    if actual != current:
        return False, f"current mismatch: expected {current!r}, file has {actual!r} — the file moved since research", field

    if field == "flipper":
        flipper_shot_ids = {s.get("id") for s in shots if s.get("type") == "flipper"}
        shape_err = validate_flipper_value(proposed, flipper_shot_ids)
    elif field == "bat":
        shape_err = validate_bat_value(proposed)
    else:  # feeds
        shot_ids = {s.get("id") for s in shots}
        shape_err = validate_feedref_shape(proposed, shot_ids)

    if shape_err:
        return False, f"shape: {shape_err}", field

    shot[field] = copy.deepcopy(proposed)
    return True, None, field


def build_selection(machine_findings: dict, verify_by_machine: dict):
    """Data-shape guards that don't need file I/O: flagship exclusion,
    verdict==confirmed, (path,proposed) dedupe, one-write-per-path conflict.
    Returns (plan: {machine: [finding, ...]}, refused: [...],
    skipped_flagship: [...])."""
    plan: dict[str, list[dict]] = {}
    refused: list[dict] = []
    skipped_flagship: list[dict] = []

    for machine, findings in sorted(machine_findings.items()):
        vm = verify_by_machine.get(machine)
        verdict_by_path: dict[str, str] = {}
        why_by_path: dict[str, str] = {}
        if vm:
            for v in vm["verdicts"]:
                verdict_by_path[v["path"]] = v["verdict"]
                why_by_path[v["path"]] = v.get("why") or ""

        selected: list[dict] = []
        for f in findings:
            path = f["path"]
            if machine in FLAGSHIP:
                skipped_flagship.append({
                    "machine": machine, "path": path, "kind": f.get("kind"), "proposed": f["proposed"],
                    "why": "flagship-owned (JAWS/EVIL_DEAD/HALLOWEEN skipped entirely, regardless of "
                           "verdict — owner hand-authored anchors are canonical)",
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
    (applied, refused) — `refused` is the SAME list passed in, per p3/p4's
    own two-phase accumulation convention."""
    applied: list[dict] = []

    for machine, items in sorted(plan.items()):
        stem = machine  # this corpus's machine field IS the file stem
        if stem not in docs:
            for f in items:
                refused.append({"machine": machine, "path": f["path"], "why": f"data file {stem}.json does not exist"})
            continue
        if not roundtrip_ok[stem]:
            for f in items:
                refused.append({
                    "machine": machine, "path": f["path"],
                    "why": "round-trip no-op self-test failed for this file (pre-existing formatting "
                           "drift, e.g. trailing-zero floats or unicode-escape normalization) — refusing "
                           "to touch it, a patch here would diff every such value in the file, not just "
                           "the intended field",
                })
            continue

        doc = docs[stem]
        pre_mutation = copy.deepcopy(doc)
        machine_ok: list[dict] = []  # {finding, field}
        for f in items:
            ok, why, field = apply_finding_to_doc(doc, f["path"], f["current"], f["proposed"])
            if ok:
                machine_ok.append({"finding": f, "field": field})
            else:
                refused.append({"machine": machine, "path": f["path"], "why": why})

        if not machine_ok:
            continue

        entries_out = [
            {"path": e["finding"]["path"], "kind": e["finding"].get("kind"), "field": e["field"],
             "proposed": e["finding"]["proposed"]}
            for e in machine_ok
        ]

        if dry_run:
            applied.append({"machine": machine, "changes": entries_out})
            continue

        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        data_file = DATA / f"{stem}.json"
        shutil.copy2(data_file, BACKUP_DIR / data_file.name)
        ok, errs = validate_and_maybe_rollback(stem, doc, BACKUP_DIR, pre_mutation, docs)
        if not ok:
            for e in machine_ok:
                refused.append({
                    "machine": machine, "path": e["finding"]["path"],
                    "why": f"validator red post-write, ROLLED BACK: {'; '.join(errs[:5])}",
                })
            continue

        applied.append({"machine": machine, "changes": entries_out})

    return applied, refused


def print_summary(report: dict) -> None:
    applied, refused, skipped = report["applied"], report["refused"], report["skippedFlagship"]
    n_changes = sum(len(a["changes"]) for a in applied)
    by_field: dict[str, int] = {}
    for a in applied:
        for c in a["changes"]:
            by_field[c["field"]] = by_field.get(c["field"], 0) + 1

    print()
    print("=" * 78)
    print("ANCHOR APPLY (flipper-anchor / bat-size / feeds-correction)")
    print(f"  applied machines   : {len(applied)}")
    print(f"  applied findings   : {n_changes}")
    for k, v in sorted(by_field.items(), key=lambda kv: -kv[1]):
        print(f"      {v:3d}  {k}")
    print(f"  refused            : {len(refused)}")
    refusal_kinds: dict[str, int] = {}
    for r in refused:
        key = r["why"].split(":")[0].split(" (")[0][:40]
        refusal_kinds[key] = refusal_kinds.get(key, 0) + 1
    for k, v in sorted(refusal_kinds.items(), key=lambda kv: -kv[1]):
        print(f"      {v:3d}  {k}")
    print(f"  skippedFlagship    : {len(skipped)}")
    for s in skipped:
        print(f"      {s['machine']}: {s['path']}")
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

    machine_findings, verify_by_machine = load_anchor_corpus()
    n_findings = sum(len(v) for v in machine_findings.values())
    print(f"loaded {n_findings} findings across {len(machine_findings)} machines")

    plan, refused, skipped_flagship = build_selection(machine_findings, verify_by_machine)
    applied, refused = apply_plan(docs, roundtrip_ok, plan, refused, dry_run)

    report = {
        "applied": applied,
        "refused": refused,
        "skippedFlagship": skipped_flagship,
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
