#!/usr/bin/env python3
"""Apply the altMode program's two data changes to data/*_goals.json.

Dataset schema v7 (2026-08-14). Two additive edits, one applier, because they
ship in the same commit and must pass the same purity gate:

  1. `Goal.altMode` — 'video' | 'menu' | 'ruleset' on the goals that are an
     ALTERNATIVE to normal ball-in-play rather than part of it. Keyed on
     (machine, goalId).
  2. `Drill.shots[]` — the shot ids a drill's authored text actually names, so
     the Study tab's DRILLS sheet can offer a "Study <shot> >" jump. Keyed on
     (machine, drillId).

THE STANDARD THIS FOLLOWS is the 2026-08-13 actionButton program's: a guarded
script, never hand edits, and REFUSAL IS THE CORRECT OUTCOME whenever the
inputs are ambiguous. Every guard below aborts the WHOLE run before the first
byte is written — there is no partially-applied state to clean up.

  - Every (machine, goalId) / (machine, drillId) key must resolve to EXACTLY
    ONE object in EXACTLY ONE catalog dataset. Unknown machine, unknown goal,
    unknown drill, unknown shot id -> refuse.
  - Duplicate keys in either input -> refuse (two rows about one target is an
    unresolved disagreement, not an instruction).
  - A target that ALREADY carries the field -> REFUSE, deliberately NOT
    idempotent. Re-running is not a no-op: it is the signal that either the
    apply already happened or something else wrote the field, and only a human
    can tell those apart. (Re-applying after a `git checkout data/` is the
    supported repeat path.)
  - `altMode` values are checked against the closed vocabulary, not merely
    "is a string".
  - An empty `proposedShots` writes NOTHING — absence is the schema's idiom
    for a shotless drill (measured across the corpus: 12 drills with no
    `shots` key, 0 with an empty array), so an empty array would be a new,
    third state nothing reads.
  - Every target file must ROUND-TRIP byte-identically through
    json.dumps(indent=2, ensure_ascii=True) + "\\n" BEFORE it is touched.
    Without that, the re-serialisation itself would rewrite lines the edit
    never asked to change and the purity proof below would be meaningless.

AND THE PROOF, run after the writes and again on --verify:
  - STRUCTURAL: strip the added fields back out of the written document and it
    must compare equal to the original INCLUDING KEY ORDER (a plain == on
    dicts ignores order; this walks it).
  - TEXTUAL: `git diff -U0` for each file must contain only added lines that
    are the expected field, plus at most the comma-only rewrite an insertion
    causes on the line above it ("x" -> "x",). Anything else restores the file
    from the backup and exits 1.

Run:
  python3 app/scripts/apply-altmode.py --flags <altmode-final.json> \\
      --drills <drill-links.json> --backup <dir> [--dry-run]
Exit: 0 applied (or dry-run clean), 1 refused/failed.
"""

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# Mirrors ALT_MODES in validate-machines.py and AltMode in app/src/models.ts.
ALT_MODES = ("video", "menu", "ruleset")

# WHERE THE KEY GOES, and both positions are chosen so the textual diff is a
# PURE ADDITION rather than a rewrite:
#   goals  — immediately after 'category', which every goal has and none ends
#            with, so the line above already carries its comma.
#   drills — last, matching the corpus' own 18 authored examples and the field
#            order in models.ts's Drill. This one DOES cost a comma-only
#            rewrite of the previous line; the alternative was breaking the
#            dataset's key order for 11 of 30 drills, which is worse.
GOAL_ANCHOR = "category"


def fail(msg: str) -> None:
    print(f"REFUSED: {msg}", file=sys.stderr)
    sys.exit(1)


def canon(doc) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=True) + "\n"


def insert_after(d: dict, anchor: str, key: str, value) -> dict:
    """A copy of `d` with `key: value` inserted directly after `anchor`,
    every other key in its original order. Python dicts preserve insertion
    order, and json.dumps writes them in that order, so this IS the on-disk
    layout."""
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
        return isinstance(b, list) and len(a) == len(b) and all(key_order_equal(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def load_rows(path: pathlib.Path, label: str) -> list:
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"{label}: cannot read {path} — {exc}")
    if not isinstance(rows, list) or not rows:
        fail(f"{label}: expected a non-empty list")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flags", required=True, help="JSON list of {machine, goalId, value}")
    ap.add_argument("--drills", required=True, help="JSON list of {machine, drillId, proposedShots}")
    ap.add_argument("--backup", help="directory to copy data/*.json into before the first write")
    ap.add_argument("--dry-run", action="store_true", help="validate + report, write nothing")
    args = ap.parse_args()

    if not args.dry_run and not args.backup:
        fail("--backup is required for a real run")

    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    by_id = {m["id"]: m for m in catalog}

    flags = load_rows(pathlib.Path(args.flags), "flags")
    drills = load_rows(pathlib.Path(args.drills), "drills")

    # ---- PLAN, with every guard, before anything is written ---------------
    # planned[resource] = {"goals": {goalId: value}, "drills": {drillId: [shots]}}
    planned: dict[str, dict] = {}
    seen_goal: set[tuple[str, str]] = set()
    seen_drill: set[tuple[str, str]] = set()
    docs: dict[str, dict] = {}

    def dataset(machine: str, rowlabel: str) -> tuple[str, dict]:
        m = by_id.get(machine)
        if not m:
            fail(f"{rowlabel}: {machine!r} is not a catalog machine")
        res = m["resource"]
        if res not in docs:
            path = DATA / f"{res}.json"
            raw = path.read_text(encoding="utf-8")
            doc = json.loads(raw)
            # The round-trip gate — see this file's docstring.
            if canon(doc) != raw:
                fail(f"{machine}: {path.name} does not round-trip through the corpus' own "
                     "serialisation; applying would rewrite lines this program never asked to change")
            docs[res] = doc
        return res, docs[res]

    for i, row in enumerate(flags):
        label = f"flags[{i}]"
        if not isinstance(row, dict):
            fail(f"{label}: not an object")
        machine, gid, value = row.get("machine"), row.get("goalId"), row.get("value")
        if not (isinstance(machine, str) and isinstance(gid, str)):
            fail(f"{label}: needs string machine + goalId")
        if value not in ALT_MODES:
            fail(f"{label} ({machine}/{gid}): altMode {value!r} is not one of {'/'.join(ALT_MODES)}")
        if (machine, gid) in seen_goal:
            fail(f"{label}: duplicate key ({machine}, {gid}) — two rows about one goal is a disagreement, not an instruction")
        seen_goal.add((machine, gid))
        res, doc = dataset(machine, label)
        hits = [g for g in doc["goals"] if g.get("id") == gid]
        if len(hits) != 1:
            fail(f"{label}: {machine}/{gid} resolves to {len(hits)} goals, expected exactly 1")
        if "altMode" in hits[0]:
            fail(f"{label}: {machine}/{gid} already carries altMode={hits[0]['altMode']!r} — "
                 "this applier is deliberately NOT idempotent; restore data/ and re-run")
        if GOAL_ANCHOR not in hits[0]:
            fail(f"{label}: {machine}/{gid} has no {GOAL_ANCHOR!r} key to anchor the insertion to")
        planned.setdefault(res, {"goals": {}, "drills": {}})["goals"][gid] = value

    for i, row in enumerate(drills):
        label = f"drills[{i}]"
        if not isinstance(row, dict):
            fail(f"{label}: not an object")
        machine, did = row.get("machine"), row.get("drillId")
        shots = row.get("proposedShots")
        if not (isinstance(machine, str) and isinstance(did, str)):
            fail(f"{label}: needs string machine + drillId")
        if not isinstance(shots, list) or any(not isinstance(s, str) for s in shots):
            fail(f"{label} ({machine}/{did}): proposedShots must be a list of shot ids")
        if (machine, did) in seen_drill:
            fail(f"{label}: duplicate key ({machine}, {did})")
        seen_drill.add((machine, did))
        res, doc = dataset(machine, label)
        hits = [d for d in (doc.get("drills") or []) if d.get("id") == did]
        if len(hits) != 1:
            fail(f"{label}: {machine}/{did} resolves to {len(hits)} drills, expected exactly 1")
        if "shots" in hits[0]:
            fail(f"{label}: {machine}/{did} already carries shots={hits[0]['shots']!r} — refusing to "
                 "overwrite authored links (harry-potter's own skill-shot-ladder is the case this guard exists for)")
        if not shots:
            print(f"  skip (shotless by design): {machine}/{did}")
            continue
        if len(set(shots)) != len(shots):
            fail(f"{label}: {machine}/{did} lists a shot id twice")
        known = {s.get("id") for s in doc["shots"]}
        unknown = [s for s in shots if s not in known]
        if unknown:
            fail(f"{label}: {machine}/{did} references unknown shot(s) {', '.join(unknown)}")
        planned.setdefault(res, {"goals": {}, "drills": {}})["drills"][did] = list(shots)

    n_goals = sum(len(p["goals"]) for p in planned.values())
    n_drills = sum(len(p["drills"]) for p in planned.values())
    by_value = {v: sum(1 for p in planned.values() for x in p["goals"].values() if x == v) for v in ALT_MODES}
    print(f"validated: {n_goals} altMode flags "
          f"({', '.join(f'{v} {by_value[v]}' for v in ALT_MODES)}) "
          f"+ {n_drills} drill shot lists, across {len(planned)} dataset(s)")

    if args.dry_run:
        for res in sorted(planned):
            p = planned[res]
            bits = []
            if p["goals"]:
                bits.append("altMode " + ", ".join(f"{g}={v}" for g, v in sorted(p["goals"].items())))
            if p["drills"]:
                bits.append("shots " + ", ".join(f"{d}[{len(s)}]" for d, s in sorted(p["drills"].items())))
            print(f"  would write {res}.json: {'; '.join(bits)}")
        print("dry run — nothing written.")
        return 0

    backup_dir = pathlib.Path(args.backup)
    backup_dir.mkdir(parents=True, exist_ok=True)
    for p in DATA.glob("*.json"):
        shutil.copy2(p, backup_dir / p.name)
    print(f"backup: {len(list(backup_dir.glob('*.json')))} files -> {backup_dir}")

    written: list[pathlib.Path] = []
    for res in sorted(planned):
        plan = planned[res]
        path = DATA / f"{res}.json"
        before = json.loads(path.read_text(encoding="utf-8"))
        doc = json.loads(json.dumps(before))  # deep copy, order preserved

        doc["goals"] = [
            insert_after(g, GOAL_ANCHOR, "altMode", plan["goals"][g["id"]]) if g.get("id") in plan["goals"] else g
            for g in doc["goals"]
        ]
        if plan["drills"]:
            doc["drills"] = [
                ({**d, "shots": plan["drills"][d["id"]]} if d.get("id") in plan["drills"] else d)
                for d in doc["drills"]
            ]

        # STRUCTURAL PROOF: peel the additions back off and the document must
        # be the original, key order and all.
        peeled = json.loads(json.dumps(doc))
        for g in peeled["goals"]:
            if g.get("id") in plan["goals"]:
                del g["altMode"]
        for d in peeled.get("drills") or []:
            if d.get("id") in plan["drills"]:
                del d["shots"]
        if not key_order_equal(peeled, before):
            fail(f"{path.name}: writing would change something other than the planned fields")

        path.write_text(canon(doc), encoding="utf-8")
        written.append(path)
        print(f"  wrote {path.name}: +{len(plan['goals'])} altMode, +{len(plan['drills'])} drill shot list(s)")

    ok = verify_diff(written, planned, backup_dir)
    if not ok:
        return 1
    print(f"done — {len(written)} dataset(s) written, diff proven additive.")
    return 0


def verify_diff(written: list[pathlib.Path], planned: dict, backup_dir: pathlib.Path) -> bool:
    """TEXTUAL PROOF. Every changed line must be an added `altMode`/`shots`
    line (or one of a shots array's own elements/brackets), or the comma-only
    rewrite an insertion causes on the line above it."""
    diff = subprocess.run(
        ["git", "diff", "-U0", "--", *[str(p) for p in written]],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    if diff.returncode != 0:
        print(f"REFUSED: git diff failed — {diff.stderr.strip()}", file=sys.stderr)
        return False

    removed: list[str] = []
    added: list[str] = []
    for line in diff.stdout.splitlines():
        if line.startswith(("+++", "---", "@@", "diff ", "index ")):
            continue
        if line.startswith("-"):
            removed.append(line[1:])
        elif line.startswith("+"):
            added.append(line[1:])

    # Each removed line must reappear among the added ones with exactly one
    # trailing comma added — the insertion's own bookkeeping and nothing else.
    leftovers = list(added)
    for r in removed:
        want = r + ","
        if want not in leftovers:
            print(f"REFUSED: line removed that is not a comma-only rewrite: {r.strip()!r}", file=sys.stderr)
            restore(written, backup_dir)
            return False
        leftovers.remove(want)

    allowed_prefixes = ('"altMode":', '"shots":')
    bad = []
    for a in leftovers:
        s = a.strip()
        # a shots array's own contents: `]`, `"shot-id"`, `"shot-id",`
        if s in ("]", "[") or (s.startswith('"') and (s.endswith('"') or s.endswith('",'))) and ":" not in s:
            continue
        if s.startswith(allowed_prefixes):
            continue
        bad.append(s)
    if bad:
        print(f"REFUSED: {len(bad)} added line(s) are neither altMode nor drill shots: {bad[:5]}", file=sys.stderr)
        restore(written, backup_dir)
        return False

    n_alt = sum(1 for a in leftovers if a.strip().startswith('"altMode":'))
    n_shots = sum(1 for a in leftovers if a.strip().startswith('"shots":'))
    want_alt = sum(len(p["goals"]) for p in planned.values())
    want_shots = sum(len(p["drills"]) for p in planned.values())
    if (n_alt, n_shots) != (want_alt, want_shots):
        print(f"REFUSED: diff carries {n_alt} altMode / {n_shots} shots lines, planned {want_alt} / {want_shots}",
              file=sys.stderr)
        restore(written, backup_dir)
        return False

    print(f"diff proof: {len(added)} added line(s), {len(removed)} rewritten line(s) — "
          f"all {len(removed)} are comma-only; {n_alt} altMode + {n_shots} shots keys, exactly as planned")
    return True


def restore(written: list[pathlib.Path], backup_dir: pathlib.Path) -> None:
    for p in written:
        shutil.copy2(backup_dir / p.name, p)
    print(f"restored {len(written)} file(s) from {backup_dir}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
