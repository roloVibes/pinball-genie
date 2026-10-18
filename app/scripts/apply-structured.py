#!/usr/bin/env python3
"""Structured-findings applier for the playfield-truth data program (P1+).

Consumes a research artifact (_Business/FLAGSHIP-DEEP-PASS-*.json shape:
{machines: [{machine, research: {findings, card, drills}, verdicts}]}) and
applies ACCEPTED findings to data/<machine>_goals.json. This is the program's
only sanctioned bulk writer for structural (non-prose) changes — hand edits
are reserved for owner-review corrections.

Guards (each one exists because a prior applier shipped a defect without it):
  * round-trip no-op self-test per file: json.dumps of the untouched doc must
    reproduce the file byte-for-byte, or the file is refused (indent drift
    would make every later diff unreadable)
  * verbatim `current` match: a finding carrying `current` is applied only if
    the file still holds exactly that value at the path — anything else means
    the file moved since research, and the finding is REFUSED, not forced
  * one write per path: two accepted findings addressing the same path refuse
    each other (conflict), they are never merged silently
  * dedupe by (path, proposed): identical duplicates collapse to one
  * open-audit-items skip: any target whose (machine, id) pair appears in
    _Business/AUDIT-OPEN-ITEMS.md is skipped and printed — that backlog is
    adjudicated separately and this script must not collide with it
  * post-apply gate: validate-machines.py must exit 0 or ALL of this run's
    writes are rolled back from the pre-write backup
  * refusals are expected output, not failures — high refusal rates are
    correct when inputs are stale or conflicting

Path grammar (matches the research findings' `path` field):
  shots[<id>].<field>[.<sub>]      patch a field on an existing shot
  shots[+<id>]                     append a new shot (proposed = whole object)
  goals[<id>].<field>              patch a goal field
  goals[<id>].steps[<n>].<field>   patch a step field
  goals[+<id>]                     append a new goal
  playfields[+<id>]                append a zone (creates playfields[])
  playfields[<id>].<field>         patch a zone field
  card / drills                    replace the whole top-level value

Run:
  python3 app/scripts/apply-structured.py \
      --findings _Business/FLAGSHIP-DEEP-PASS-2026-08-10.json \
      --machine jaws --accept confirmed [--accept-index N ...] \
      [--reject-index N ...] [--with-card] [--with-drills] \
      [--label p1-jaws] --dry-run|--apply
"""

import argparse
import datetime
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

PATH_RE = re.compile(
    r"^(?P<coll>shots|goals|playfields|achievements)\[(?P<new>\+?)(?P<id>[a-z0-9_-]+)\]"
    r"(?P<rest>(?:\.[A-Za-z]+(?:\[\d+\])?)*)$"
)
REST_RE = re.compile(r"\.(?P<field>[A-Za-z]+)(?:\[(?P<idx>\d+)\])?")


def load_open_audit_ids() -> set[tuple[str, str]]:
    """(machine-stem, item-id) pairs from AUDIT-OPEN-ITEMS.md lines like
    'jaws · fish-finder-awards · misleading'."""
    f = BIZ / "AUDIT-OPEN-ITEMS.md"
    pairs: set[tuple[str, str]] = set()
    if not f.exists():
        return pairs
    for m in re.finditer(r"^[#\-\s]*([a-z0-9_]+) · ([a-z0-9_-]+) ·",
                         f.read_text(encoding="utf-8"), re.MULTILINE):
        pairs.add((m.group(1), m.group(2)))
    return pairs


def resolve(doc: dict, path: str):
    """Returns (kind, ...) descriptor for a path — see apply()."""
    if path in ("card", "drills"):
        return ("top", path)
    m = PATH_RE.match(path)
    if not m:
        return None
    coll, is_new, ident, rest = m.group("coll"), bool(m.group("new")), m.group("id"), m.group("rest")
    fields = [(f.group("field"), f.group("idx")) for f in REST_RE.finditer(rest)]
    if is_new:
        return ("append", coll, ident) if not fields else None
    return ("patch", coll, ident, fields)


def get_at(doc: dict, desc):
    """Current value at a patch path, or ('__missing__',) sentinel."""
    _, coll, ident, fields = desc
    items = doc.get(coll) or []
    obj = next((it for it in items if it.get("id") == ident), None)
    if obj is None:
        return ("__missing__",)
    cur = obj
    for field, idx in fields:
        if not isinstance(cur, dict) or field not in cur:
            return ("__absent__", obj, field)
        cur = cur[field]
        if idx is not None:
            i = int(idx)
            if not isinstance(cur, list) or i >= len(cur):
                return ("__missing__",)
            cur = cur[i]
    return ("__value__", cur, obj)


def set_at(doc: dict, desc, value) -> None:
    _, coll, ident, fields = desc
    obj = next(it for it in (doc.get(coll) or []) if it.get("id") == ident)
    cur = obj
    for i, (field, idx) in enumerate(fields):
        last = i == len(fields) - 1
        if idx is None:
            if last:
                cur[field] = value
            else:
                cur = cur.setdefault(field, {})
        else:
            arr = cur[field]
            if last:
                existing = arr[int(idx)]
                # A step's identity is its `shot`. A proposed dict WITHOUT one
                # is a patch onto the existing step (e.g. {"plunge": "full"}),
                # not a replacement — replacing here once shipped a step with
                # no 'shot' key and the validator rolled the whole run back.
                if (field == "steps" and isinstance(value, dict)
                        and isinstance(existing, dict) and "shot" not in value):
                    arr[int(idx)] = {**existing, **value}
                else:
                    arr[int(idx)] = value
            else:
                cur = arr[int(idx)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--findings", required=True)
    ap.add_argument("--machine", required=True, help="machine id, e.g. jaws")
    ap.add_argument("--accept", nargs="*", default=["confirmed"],
                    help="verdict classes to accept (default: confirmed)")
    ap.add_argument("--accept-index", type=int, nargs="*", default=[],
                    help="explicitly accepted finding indexes (owner cherry-picks)")
    ap.add_argument("--reject-index", type=int, nargs="*", default=[],
                    help="explicitly rejected finding indexes (beats --accept)")
    ap.add_argument("--with-card", action="store_true")
    ap.add_argument("--with-drills", action="store_true")
    ap.add_argument("--label", default=None)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    artifact = json.loads(pathlib.Path(args.findings).read_text(encoding="utf-8"))
    entry = next((m for m in artifact["machines"] if m["machine"] == args.machine), None)
    if entry is None:
        print(f"FATAL: machine {args.machine!r} not in findings artifact")
        return 1

    findings = entry["research"]["findings"]
    verdict_by_index = {v["index"]: v["verdict"] for v in entry["verdicts"]["verdicts"]}

    data_file = DATA / f"{args.machine}_goals.json"
    raw = data_file.read_text(encoding="utf-8")
    doc = json.loads(raw)
    dump = lambda d: json.dumps(d, indent=2, ensure_ascii=False) + "\n"
    if dump(doc) != raw:
        print(f"FATAL: {data_file.name} fails the round-trip no-op self-test — refusing to touch it")
        return 1

    open_items = load_open_audit_ids()

    # -- select ---------------------------------------------------------
    selected: list[tuple[int, dict]] = []
    refused: list[tuple[int, str]] = []
    for i, f in enumerate(findings):
        if i in args.reject_index:
            refused.append((i, "explicitly rejected"))
            continue
        v = verdict_by_index.get(i, "unreviewed")
        if i not in args.accept_index and v not in args.accept:
            refused.append((i, f"verdict {v!r} not accepted"))
            continue
        selected.append((i, f))

    # -- guards ---------------------------------------------------------
    seen_pairs: dict[tuple[str, str], int] = {}
    by_path: dict[str, list[int]] = {}
    plan: list[tuple[int, dict, tuple]] = []
    for i, f in selected:
        path = f.get("path", "")
        proposed = f.get("proposed")
        pair = (path, json.dumps(proposed, sort_keys=True))
        if pair in seen_pairs:
            refused.append((i, f"duplicate of finding {seen_pairs[pair]}"))
            continue
        seen_pairs[pair] = i
        by_path.setdefault(path, []).append(i)

        target_id_m = PATH_RE.match(path)
        if target_id_m and (args.machine, target_id_m.group("id")) in open_items:
            refused.append((i, f"SKIPPED — open audit item for {target_id_m.group('id')!r}"))
            continue

        if isinstance(proposed, dict) and any(
            ("." in k or "[" in k) for k in proposed
        ):
            refused.append((i, "composite proposal names its own fields (path-like keys) — hand-apply only"))
            continue
        desc = resolve(doc, path)
        if desc is None:
            refused.append((i, f"unparseable path {path!r}"))
            continue
        if desc[0] == "append":
            _, coll, ident = desc
            if any(it.get("id") == ident for it in doc.get(coll) or []):
                refused.append((i, f"{coll}[{ident}] already exists — append refused"))
                continue
        elif desc[0] == "patch":
            got = get_at(doc, desc)
            if got[0] == "__missing__":
                refused.append((i, f"path target missing in file"))
                continue
            if "current" in f and f["current"] is not None:
                actual = got[1] if got[0] == "__value__" else None
                if actual != f["current"]:
                    refused.append((i, "verbatim `current` mismatch — file moved since research"))
                    continue
        plan.append((i, f, desc))

    for path, idxs in by_path.items():
        live = [i for i in idxs if any(p[0] == i for p in plan)]
        if len(live) > 1:
            for i in live:
                refused.append((i, f"conflict: {len(live)} accepted findings target {path!r}"))
            plan = [p for p in plan if p[0] not in live]

    # -- report the plan -------------------------------------------------
    print(f"{args.machine}: {len(findings)} findings → {len(plan)} to apply, {len(refused)} refused")
    for i, f, desc in plan:
        print(f"  APPLY [{i}] {f.get('kind','?'):16s} {f['path']}")
    for i, why in sorted(refused):
        print(f"  refuse [{i}] {why}")
    if args.with_card:
        print("  APPLY card (whole object)")
    if args.with_drills:
        print("  APPLY drills (whole array)")

    if args.dry_run:
        print("dry-run: no writes")
        return 0
    if not plan and not args.with_card and not args.with_drills:
        print("nothing to apply")
        return 0

    # -- backup, write, validate, rollback-on-red ------------------------
    label = args.label or f"{args.machine}-{datetime.date.today().isoformat()}"
    backup = SCRATCH / f"data-backup-{label}"
    backup.mkdir(parents=True, exist_ok=True)
    shutil.copy2(data_file, backup / data_file.name)

    for _, f, desc in plan:
        if desc[0] == "append":
            _, coll, _ident = desc
            doc.setdefault(coll, []).append(f["proposed"])
        elif desc[0] == "patch":
            set_at(doc, desc, f["proposed"])
    if args.with_card and entry["research"].get("card"):
        doc["card"] = entry["research"]["card"]
    if args.with_drills and entry["research"].get("drills"):
        doc["drills"] = entry["research"]["drills"]

    data_file.write_text(dump(doc), encoding="utf-8")

    val = subprocess.run([sys.executable, str(ROOT / "app/scripts/validate-machines.py")],
                         capture_output=True, text=True)
    if val.returncode != 0:
        shutil.copy2(backup / data_file.name, data_file)
        print("VALIDATOR RED — rolled back. First errors:")
        print("\n".join(l for l in val.stdout.splitlines() if l.startswith("ERROR"))[:2000])
        return 1

    print(f"applied + validator green; backup at {backup.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
