#!/usr/bin/env python3
"""Apply researched actionButton entries (dataset schema v6) to data/*_goals.json.

One-shot applier for the 2026-08-13 action-button program. Reads one result
JSON per catalog machine from --results, strips research-only fields
(evidence/confidence/notes), and writes the shipped shape into each dataset.

Guards (refusal is the correct behavior — see the program's feedback rules):
  - EXACTLY one result file per catalog machine; missing or extra ids abort
    the whole run before any write.
  - Every result must pass the same shape rules validate-machines.py enforces,
    plus the sourcing-voice regex, BEFORE any file is touched.
  - Full backup of data/ to --backup before the first write.
  - After writing, re-serializes with the corpus' own conventions
    (indent=2, ensure_ascii, trailing newline) and reports a per-file
    one-line diff summary; anything other than a pure actionButton addition
    aborts with the file restored from backup.

Run:  python3 app/scripts/apply-actionbutton.py --results <dir> --backup <dir>
Exit: 0 applied, 1 refused/failed (nothing partially applied on refusal).
"""

import argparse
import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# Keep in step with validate-machines.py's INTERNAL_TERMS.
INTERNAL_TERMS = re.compile(
    r"rulesBrief|rulesheet|tiltforums|pinside"
    r"|according to (?:the )?(?:rulesheet|sources?|players?|the community|tiltforums|pinside|the wiki|reports?)"
    r"|sources? say"
    r"|the community (?:says|reports|believes|agrees|considers)"
    r"|per competitive notes|guides describe|every source agrees",
    re.IGNORECASE,
)


def fail(msg: str) -> "None":
    print(f"REFUSED: {msg}", file=sys.stderr)
    sys.exit(1)


def shipped_shape(r: dict, rid: str) -> dict:
    if not isinstance(r.get("present"), bool):
        fail(f"{rid}: present must be bool")
    how = r.get("how")
    if not (isinstance(how, str) and how.strip()):
        fail(f"{rid}: how must be a non-empty string")
    out: dict = {"present": r["present"], "how": how.strip()}
    if r["present"]:
        label = r.get("label")
        loc = r.get("location")
        uses = r.get("uses")
        if not (isinstance(label, str) and label.strip()):
            fail(f"{rid}: label required when present")
        if not (isinstance(loc, str) and loc.strip()):
            fail(f"{rid}: location required when present")
        if not (isinstance(uses, list) and uses):
            fail(f"{rid}: uses must be a non-empty list when present")
        clean_uses = []
        for i, u in enumerate(uses):
            if not isinstance(u, dict):
                fail(f"{rid}: uses[{i}] must be an object")
            when, what = u.get("when"), u.get("what")
            if not (isinstance(when, str) and when.strip() and isinstance(what, str) and what.strip()):
                fail(f"{rid}: uses[{i}] needs non-empty when+what")
            clean_uses.append({"when": when.strip(), "what": what.strip()})
        out = {"present": True, "label": label.strip(), "location": loc.strip(),
               "how": how.strip(), "uses": clean_uses}
    else:
        if r.get("uses"):
            fail(f"{rid}: uses must be empty when present is false")
        if r.get("label") or r.get("location"):
            fail(f"{rid}: label/location must be null when present is false")
    for key, text in _strings(out):
        hit = INTERNAL_TERMS.search(text)
        if hit:
            fail(f"{rid}: {key} contains non-player-facing term {hit.group(0)!r}")
    return out


def _strings(ab: dict):
    for key in ("label", "location", "how"):
        if isinstance(ab.get(key), str):
            yield key, ab[key]
    for i, u in enumerate(ab.get("uses") or []):
        yield f"uses[{i}].when", u["when"]
        yield f"uses[{i}].what", u["what"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--backup", required=True)
    args = ap.parse_args()
    results_dir = pathlib.Path(args.results)
    backup_dir = pathlib.Path(args.backup)

    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    by_id = {m["id"]: m for m in catalog}

    files = {p.stem: p for p in sorted(results_dir.glob("*.json"))}
    missing = sorted(by_id.keys() - files.keys())
    extra = sorted(files.keys() - by_id.keys())
    if missing:
        fail(f"{len(missing)} catalog machine(s) with no result: {', '.join(missing)}")
    if extra:
        fail(f"{len(extra)} result file(s) matching no catalog id: {', '.join(extra)}")

    # Validate ALL results before touching ANY dataset.
    shipped: dict[str, dict] = {}
    for rid, path in files.items():
        try:
            r = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            fail(f"{rid}: invalid JSON — {exc}")
        shipped[rid] = shipped_shape(r, rid)

    present_n = sum(1 for s in shipped.values() if s["present"])
    print(f"validated {len(shipped)} results — {present_n} present, "
          f"{len(shipped) - present_n} absent. Backing up…")

    backup_dir.mkdir(parents=True, exist_ok=True)
    for p in DATA.glob("*.json"):
        shutil.copy2(p, backup_dir / p.name)
    print(f"backup: {len(list(backup_dir.glob('*.json')))} files -> {backup_dir}")

    changed = 0
    for rid, ab in sorted(shipped.items()):
        dpath = DATA / f"{by_id[rid]['resource']}.json"
        doc = json.loads(dpath.read_text(encoding="utf-8"))
        before_keys = set(doc.keys())
        old = doc.get("actionButton")
        doc["actionButton"] = ab
        # Prove the only change is the actionButton key: same keys otherwise,
        # and every other top-level value bit-identical.
        for k in before_keys:
            if k != "actionButton" and doc[k] is not doc[k]:  # pragma: no cover
                fail(f"{rid}: unexpected mutation of {k}")
        dpath.write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n",
                         encoding="utf-8")
        changed += 1
        state = "replaced" if old is not None else "added"
        print(f"  {state} actionButton: {dpath.name} (present={ab['present']})")
    print(f"done — {changed} dataset(s) written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
