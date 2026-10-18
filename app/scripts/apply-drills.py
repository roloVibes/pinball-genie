#!/usr/bin/env python3
"""Insert authored `drills[]` into data/*_goals.json — the catalog-wide drills
program (2026-08-15, dataset schema v5's drills field, 129 machines / 760
drills).

THE STANDARD IS apply-altmode.py's and the actionButton program's before it: a
guarded script, never hand edits, and REFUSAL IS THE CORRECT OUTCOME whenever
the input is ambiguous. Every guard runs over the WHOLE input before the first
byte is written, so there is no partially-applied state to clean up.

GUARDS
  - Machine must be a catalog id (data/catalog.json) -> refuse otherwise.
  - The target file must ALREADY round-trip byte-identically through the
    corpus' own serialisation (json.dumps(indent=2, ensure_ascii=True) + "\\n").
    Without that the re-serialisation itself would rewrite lines this program
    never asked to change and the purity proof below would mean nothing.
  - A file that ALREADY carries `drills` -> REFUSE. This is the flagship guard:
    jaws / evil_dead / halloween / harry_potter / sonic_the_hedgehog carry the
    30 hand-authored originals (and jaws also just gained a goal), and this
    program must not touch a byte of them. It doubles as the not-idempotent
    guard — a second run is the signal that the apply already happened, and
    only a human can tell that from "something else wrote the field". The
    supported repeat path is `git checkout data/` then re-run.
  - Duplicate machine rows, duplicate drill ids inside a machine -> refuse.
  - Drill shape: exactly the keys of models.ts's Drill, in models.ts's order
    (id, title, text, reps?, focus?, goal?, shots?); id lowercase-kebab (the
    validator's ID_RE); title/text/reps/focus non-empty strings.
  - `focus` must be one of the four canonical values this program authored
    against. The 30 pre-existing drills use free prose (29 distinct values,
    measured 2026-08-14 — see ui/study.ts) and the schema still types it as a
    loose tag; that history is left alone, but nothing NEW gets to widen it.
  - `goal` must resolve to a goal id in the same file, every `shots` entry to a
    shot id in the same file, re-checked here at apply time against the file on
    disk rather than trusted from the input.
  - `shots` present-but-empty -> refuse. Absence is the corpus' idiom for a
    shotless technique drill (measured: 12 drills with no `shots` key, 0 with
    an empty array), so an empty array would be a third state nothing reads.

WHERE THE KEY GOES — measured from the five files that already have drills:
    jaws          ... achievements, playfields, drills, actionButton
    evil_dead     ... achievements, drills, playfields, actionButton
    halloween     ... achievements, drills, playfields, actionButton
    harry_potter  ... achievements, drills, actionButton
    sonic         ... achievements, drills, actionButton
  `drills` lands in the trailing block after `achievements` in all five, and
  before `actionButton` in all five. IMMEDIATELY AFTER `achievements` is
  therefore the idiom (4/5 exactly; jaws' order satisfies the same two
  constraints), and it is also what makes the diff a PURE ADDITION: every
  registered machine has an `actionButton` after `achievements`, so the
  anchor's closing line already carries its comma and no existing line is
  rewritten at all. If a file ever anchors at its last key, the one comma-only
  rewrite that causes is allowed and proven (apply-altmode.py's precedent).

THE PROOF, run after the writes:
  - STRUCTURAL: strip `drills` back out of the written document and it must
    compare equal to the original INCLUDING KEY ORDER (a plain == on dicts
    ignores order; this walks it).
  - TEXTUAL: `git diff -U0` per file must consist of exactly the lines this
    program expected to add — computed by serialising the planned block the
    same way the file is serialised — plus at most a comma-only rewrite of the
    anchor line. Anything else restores every written file from the backup and
    exits 1.

Run:
  python3 app/scripts/apply-drills.py --drills <final-drills.json> \\
      --backup <dir> [--dry-run]
Exit: 0 applied (or dry-run clean), 1 refused/failed.
"""

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

ANCHOR = "achievements"
DRILL_KEYS = ("id", "title", "text", "reps", "focus", "goal", "shots")
REQUIRED_KEYS = ("id", "title", "text")
# The closed vocabulary this program authored against (drills-spec.md).
FOCUS = ("skill-shot", "accuracy", "ball-control", "flow")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")  # mirrors validate-machines.py


def fail(msg: str) -> None:
    print(f"REFUSED: {msg}", file=sys.stderr)
    sys.exit(1)


def canon(doc) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=True) + "\n"


def block_lines(value, last_key: bool) -> list[str]:
    """The exact lines `"drills": <value>` occupies inside a canon()-serialised
    document at top level — which is what the textual proof compares against."""
    rendered = json.dumps({"drills": value}, indent=2, ensure_ascii=True)
    lines = rendered.split("\n")[1:-1]  # drop the wrapper's own braces
    if not last_key:
        lines[-1] += ","
    return lines


def insert_after(d: dict, anchor: str, key: str, value) -> dict:
    out: dict = {}
    for k, v in d.items():
        out[k] = v
        if k == anchor:
            out[key] = value
    return out


def key_order_equal(a, b) -> bool:
    """Deep equality that also compares dict KEY ORDER — `==` does not, and a
    reordered file is a diff no reviewer asked for."""
    if isinstance(a, dict):
        if not isinstance(b, dict) or list(a.keys()) != list(b.keys()):
            return False
        return all(key_order_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(
            key_order_equal(x, y) for x, y in zip(a, b)
        )
    return type(a) is type(b) and a == b


def check_drill(label: str, d, goal_ids: set, shot_ids: set) -> None:
    if not isinstance(d, dict):
        fail(f"{label}: drill is not an object")
    keys = list(d.keys())
    unknown = [k for k in keys if k not in DRILL_KEYS]
    if unknown:
        fail(f"{label}: unknown drill key(s) {', '.join(unknown)}")
    for k in REQUIRED_KEYS:
        if not (isinstance(d.get(k), str) and d[k].strip()):
            fail(f"{label}: {k!r} must be a non-empty string")
    if keys != [k for k in DRILL_KEYS if k in d]:
        fail(f"{label}: key order {keys} is not models.ts's Drill order "
             f"{[k for k in DRILL_KEYS if k in d]}")
    if not ID_RE.match(d["id"]):
        fail(f"{label}: id {d['id']!r} is not lowercase-kebab")
    for k in ("reps", "focus"):
        if k in d and not (isinstance(d[k], str) and d[k].strip()):
            fail(f"{label}: {k!r} present but not a non-empty string")
    if "focus" in d and d["focus"] not in FOCUS:
        fail(f"{label}: focus {d['focus']!r} is outside this program's "
             f"vocabulary ({'/'.join(FOCUS)})")
    if "goal" in d:
        if not isinstance(d["goal"], str) or d["goal"] not in goal_ids:
            fail(f"{label}: goal {d.get('goal')!r} does not resolve in this machine's file")
    if "shots" in d:
        shots = d["shots"]
        if not isinstance(shots, list) or any(not isinstance(s, str) for s in shots):
            fail(f"{label}: shots must be a list of shot ids")
        if not shots:
            fail(f"{label}: empty shots array — a shotless drill carries NO shots key")
        if len(set(shots)) != len(shots):
            fail(f"{label}: lists a shot id twice")
        unknown_shots = [s for s in shots if s not in shot_ids]
        if unknown_shots:
            fail(f"{label}: unknown shot(s) {', '.join(unknown_shots)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--drills", required=True, help="JSON list of {machine, drills:[...]}")
    ap.add_argument("--backup", help="directory to copy data/*.json into before the first write")
    ap.add_argument("--dry-run", action="store_true", help="validate + report, write nothing")
    args = ap.parse_args()

    if not args.dry_run and not args.backup:
        fail("--backup is required for a real run")

    try:
        rows = json.loads(pathlib.Path(args.drills).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {args.drills} — {exc}")
    if not isinstance(rows, list) or not rows:
        fail("drills input: expected a non-empty list")

    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    by_id = {m["id"]: m for m in catalog}

    planned: dict[str, list] = {}   # resource -> drills
    seen_machine: set[str] = set()
    seen_resource: dict[str, str] = {}  # resource -> machine id that claimed it

    for i, row in enumerate(rows):
        label = f"rows[{i}]"
        if not isinstance(row, dict):
            fail(f"{label}: not an object")
        machine, drills = row.get("machine"), row.get("drills")
        if not isinstance(machine, str):
            fail(f"{label}: needs a string machine id")
        if machine in seen_machine:
            fail(f"{label}: duplicate machine {machine!r} — two rows about one machine "
                 "is a disagreement, not an instruction")
        seen_machine.add(machine)
        m = by_id.get(machine)
        if not m:
            fail(f"{label}: {machine!r} is not a catalog machine")
        if not isinstance(drills, list) or not drills:
            fail(f"{label} ({machine}): drills must be a non-empty list")

        res = m["resource"]
        if res in seen_resource:
            fail(f"{label}: {machine!r} and {seen_resource[res]!r} share dataset {res}.json")
        seen_resource[res] = machine
        path = DATA / f"{res}.json"
        raw = path.read_text(encoding="utf-8")
        doc = json.loads(raw)
        if canon(doc) != raw:
            fail(f"{machine}: {path.name} does not round-trip through the corpus' own "
                 "serialisation; applying would rewrite lines this program never asked to change")
        if "drills" in doc:
            fail(f"{machine}: {path.name} ALREADY carries {len(doc['drills'] or [])} drills — "
                 "this applier never overwrites authored drills and is deliberately NOT "
                 "idempotent; restore data/ and re-run")
        if ANCHOR not in doc:
            fail(f"{machine}: {path.name} has no {ANCHOR!r} key to anchor the insertion to")
        goal_ids = {g.get("id") for g in doc.get("goals") or []}
        shot_ids = {s.get("id") for s in doc.get("shots") or []}
        ids: set[str] = set()
        for j, d in enumerate(drills):
            dlabel = f"{label} ({machine}) drills[{j}]"
            check_drill(dlabel, d, goal_ids, shot_ids)
            if d["id"] in ids:
                fail(f"{dlabel}: duplicate drill id {d['id']!r} within {machine}")
            ids.add(d["id"])
        planned[res] = drills

    n_drills = sum(len(v) for v in planned.values())
    sizes = sorted({len(v) for v in planned.values()})
    print(f"validated: {n_drills} drills across {len(planned)} machine file(s) "
          f"({'/'.join(str(s) for s in sizes)} per machine)")

    if args.dry_run:
        for res in sorted(planned):
            d = planned[res]
            print(f"  would write {res}.json: +{len(d)} drills after {ANCHOR!r} "
                  f"({', '.join(x['id'] for x in d)})")
        print("dry run — nothing written.")
        return 0

    backup_dir = pathlib.Path(args.backup)
    backup_dir.mkdir(parents=True, exist_ok=True)
    for p in DATA.glob("*.json"):
        shutil.copy2(p, backup_dir / p.name)
    print(f"backup: {len(list(backup_dir.glob('*.json')))} files -> {backup_dir}")

    written: list[pathlib.Path] = []
    expected: dict[pathlib.Path, list[str]] = {}
    for res in sorted(planned):
        path = DATA / f"{res}.json"
        before = json.loads(path.read_text(encoding="utf-8"))
        doc = insert_after(json.loads(json.dumps(before)), ANCHOR, "drills", planned[res])

        # STRUCTURAL PROOF: peel the addition back off and the document must be
        # the original, key order and all.
        peeled = json.loads(json.dumps(doc))
        del peeled["drills"]
        if not key_order_equal(peeled, before):
            fail(f"{path.name}: writing would change something other than the drills key")

        last_key = list(doc.keys())[-1] == "drills"
        expected[path] = block_lines(planned[res], last_key)
        path.write_text(canon(doc), encoding="utf-8")
        written.append(path)

    print(f"wrote {len(written)} file(s)")
    if not verify_diff(written, expected, backup_dir):
        return 1
    print(f"done — {n_drills} drills in {len(written)} dataset(s), diff proven additive.")
    return 0


def verify_diff(written, expected, backup_dir) -> bool:
    """TEXTUAL PROOF, per file: the added lines must be EXACTLY the drills block
    this program planned, and any removed line must reappear with one trailing
    comma added (the anchor's own bookkeeping) and nothing else."""
    total_added = 0
    total_commas = 0
    for path in written:
        diff = subprocess.run(
            ["git", "diff", "-U0", "--", str(path)],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )
        if diff.returncode != 0:
            print(f"REFUSED: git diff failed — {diff.stderr.strip()}", file=sys.stderr)
            restore(written, backup_dir)
            return False
        added, removed = [], []
        for line in diff.stdout.splitlines():
            if line.startswith(("+++", "---", "@@", "diff ", "index ")):
                continue
            if line.startswith("+"):
                added.append(line[1:])
            elif line.startswith("-"):
                removed.append(line[1:])

        leftovers = list(added)
        for r in removed:
            want = r + ","
            if want not in leftovers:
                print(f"REFUSED: {path.name}: line removed that is not a comma-only "
                      f"rewrite: {r.strip()!r}", file=sys.stderr)
                restore(written, backup_dir)
                return False
            leftovers.remove(want)
        total_commas += len(removed)

        if leftovers != expected[path]:
            extra = [x for x in leftovers if x not in expected[path]]
            missing = [x for x in expected[path] if x not in leftovers]
            print(f"REFUSED: {path.name}: diff is not the planned drills block "
                  f"({len(leftovers)} added vs {len(expected[path])} expected; "
                  f"unexpected={extra[:3]}, missing={missing[:3]})", file=sys.stderr)
            restore(written, backup_dir)
            return False
        total_added += len(leftovers)

    print(f"diff proof: {total_added} added line(s) across {len(written)} file(s), all of them "
          f"the planned drills blocks; {total_commas} comma-only rewrite(s), 0 other changes")
    return True


def restore(written, backup_dir) -> None:
    for p in written:
        shutil.copy2(pathlib.Path(backup_dir) / p.name, p)
    print(f"restored {len(written)} file(s) from {backup_dir}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
