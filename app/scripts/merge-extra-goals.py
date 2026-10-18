#!/usr/bin/env python3
"""Merge researched 'secret' / 'progression' goals into data/<machine>_goals.json.

    python3 app/scripts/merge-extra-goals.py --check       # dry run, exit 1 on any problem
    python3 app/scripts/merge-extra-goals.py --write       # apply

WHY THIS EXISTS RATHER THAN A HAND-EDIT. The research passes produce goals in a
DIFFERENT SHAPE from the app's data model, and three of the differences are the
kind that corrupt silently rather than crash:

  1. `difficulty` is a STRING ("easy"/"medium"/"hard") in the research output and
     a NUMBER 1..3 in the app. clampDifficulty() does Math.round() on it — feed
     it a string and every difficulty pip renders NaN, with no error anywhere.
  2. `steps` is a LIST OF STRINGS in the research output; the app's GoalStep is
     an OBJECT {shot, action, detail} whose `shot` must resolve to a real entry
     in that machine's `shots` array. Copying prose in as `steps` would leave
     every step with an undefined shot, which the Map tab would try to draw a
     route through.
  3. These goals have NO playfield route at all ("hold both flippers in attract
     mode"), so they become PATHLESS goals: `steps: []` plus `instructions`.
     See Goal.instructions in app/src/models.ts for that contract.

So the conversion is mechanical but not trivial, and doing it 40+ times by hand
is how one machine ends up subtly wrong. This script is also IDEMPOTENT — it
matches on goal id and replaces in place — so it can be re-run after a research
correction without duplicating anything.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(REPO, "data")

DIFFICULTY = {"easy": 1, "medium": 2, "hard": 3}
ALLOWED_CATEGORIES = {"secret", "progression"}

# Phrases that betray research voice in player-facing copy. The guide-page
# generator (gen-guides.mjs) REJECTS pages containing these, so a goal carrying
# one would break the build later rather than here — catch it at the door.
# Word-boundary matched: "attributed to" must not fire inside
# "misattributed to", which is a real sentence in this dataset.
PROVENANCE = [
    r"according to", r"\bsources?\s+say", r"the community", r"reportedly",
    r"\bit is said\b", r"rulesheet", r"tiltforums", r"pinside", r"\bwiki\b",
    r"\battributed to\b", r"\bapparently\b", r"players report",
    r"is believed", r"\bsupposedly\b",
]
PROVENANCE_RE = re.compile("|".join(PROVENANCE), re.I)


def slug_to_path(slug: str) -> str:
    return os.path.join(DATA, f"{slug.replace('-', '_')}_goals.json")


def load_catalog_slugs() -> set:
    with open(os.path.join(DATA, "catalog.json"), encoding="utf-8") as f:
        cat = json.load(f)
    machines = cat.get("machines", cat) if isinstance(cat, dict) else cat
    return {m["id"] for m in machines}


def normalize(goal: dict, slug: str, problems: list) -> "dict | None":
    """Research shape -> app Goal shape. Returns None if the goal must be dropped."""
    gid = goal.get("id")
    if not gid or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", gid):
        problems.append(f"{slug}: bad or missing goal id {gid!r} (need kebab-case)")
        return None

    cat = goal.get("category")
    if cat not in ALLOWED_CATEGORIES:
        problems.append(f"{slug}/{gid}: category {cat!r} not in {sorted(ALLOWED_CATEGORIES)}")
        return None

    raw_diff = goal.get("difficulty")
    if isinstance(raw_diff, str):
        diff = DIFFICULTY.get(raw_diff.strip().lower())
        if diff is None:
            problems.append(f"{slug}/{gid}: difficulty {raw_diff!r} not one of {sorted(DIFFICULTY)}")
            return None
    elif isinstance(raw_diff, int) and 1 <= raw_diff <= 3:
        diff = raw_diff
    else:
        problems.append(f"{slug}/{gid}: difficulty {raw_diff!r} is neither a known word nor 1..3")
        return None

    steps = goal.get("steps") or []
    if not all(isinstance(s, str) for s in steps):
        problems.append(f"{slug}/{gid}: expected prose steps (list of strings), got {type(steps)}")
        return None
    instructions = [s.strip() for s in steps if s and s.strip()]
    if not instructions:
        problems.append(f"{slug}/{gid}: no instructions after cleaning — nothing to teach")
        return None

    title = (goal.get("title") or "").strip()
    summary = (goal.get("summary") or "").strip()
    reward = (goal.get("reward") or "").strip()
    if not title or not summary:
        problems.append(f"{slug}/{gid}: missing title or summary")
        return None

    for field, text in (("title", title), ("summary", summary), ("reward", reward)):
        hit = PROVENANCE_RE.search(text)
        if hit:
            problems.append(f"{slug}/{gid}: research voice in {field}: {hit.group(0)!r}")
            return None
    for i, line in enumerate(instructions):
        hit = PROVENANCE_RE.search(line)
        if hit:
            problems.append(f"{slug}/{gid}: research voice in step {i + 1}: {hit.group(0)!r}")
            return None

    out = {
        "id": gid,
        "title": title,
        "category": cat,
        "summary": summary,
        "difficulty": diff,
        # PATHLESS: no shots, prose instead. See models.ts's Goal.instructions.
        "steps": [],
        "instructions": instructions,
    }
    if reward:
        out["reward"] = reward
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="apply changes (default is a dry run)")
    ap.add_argument("--check", action="store_true", help="dry run; exit 1 if anything is wrong")
    ap.add_argument(
        "--source", action="append", default=[],
        help="a JSON file of {slug: {goals:[...]}} or [{machine, goals:[...]}]; repeatable",
    )
    args = ap.parse_args()
    if not args.source:
        # NOT under data/: that directory is the PUBLIC webroot and deploy-prod.sh
        # uploads data/*.json wholesale, so a build INPUT left there gets
        # published (it was, at /data/secrets-pass.json). Authoring sources live
        # beside the scripts that consume them.
        args.source = [os.path.join(HERE, "sources", "secrets-pass.json")]

    catalog = load_catalog_slugs()
    problems: list = []
    incoming: "dict[str, list]" = {}

    for src in args.source:
        if not os.path.exists(src):
            print(f"  skip (missing): {src}")
            continue
        with open(src, encoding="utf-8") as f:
            blob = json.load(f)
        if isinstance(blob, dict):
            items = [(slug, rec) for slug, rec in blob.items()]
        else:
            items = [(rec.get("machine"), rec) for rec in blob]
        for slug, rec in items:
            if not rec:
                continue
            goals = rec.get("goals", rec) if isinstance(rec, dict) else rec
            if not isinstance(goals, list) or not goals:
                continue
            if slug not in catalog:
                problems.append(f"{slug}: not a slug in catalog.json (typo? renamed machine?)")
                continue
            incoming.setdefault(slug, []).extend(goals)
        print(f"  read {src}: {len(items)} machine entries")

    added = updated = 0
    touched = []
    for slug, goals in sorted(incoming.items()):
        path = slug_to_path(slug)
        if not os.path.exists(path):
            problems.append(f"{slug}: catalog knows it but {os.path.basename(path)} does not exist")
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        existing = data.get("goals", [])
        by_id = {g["id"]: i for i, g in enumerate(existing)}
        machine_changed = False
        for raw in goals:
            norm = normalize(raw, slug, problems)
            if norm is None:
                continue
            if norm["id"] in by_id:
                idx = by_id[norm["id"]]
                if existing[idx] != norm:
                    existing[idx] = norm
                    updated += 1
                    machine_changed = True
            else:
                existing.append(norm)
                by_id[norm["id"]] = len(existing) - 1
                added += 1
                machine_changed = True
        # Sanity: ids must be unique within a machine after the merge.
        ids = [g["id"] for g in existing]
        if len(ids) != len(set(ids)):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            problems.append(f"{slug}: duplicate goal ids after merge: {dupes}")
        if machine_changed:
            touched.append(slug)
            data["goals"] = existing
            if args.write:
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=1, ensure_ascii=False)
                    f.write("\n")
                os.replace(tmp, path)

    print(f"\n  machines touched : {len(touched)}")
    print(f"  goals added      : {added}")
    print(f"  goals updated    : {updated}")
    if touched:
        print(f"  slugs            : {' '.join(sorted(touched))}")
    if problems:
        print(f"\n  PROBLEMS ({len(problems)}):")
        for p in problems:
            print(f"    - {p}")
    if not args.write:
        print("\n  DRY RUN — nothing written. Re-run with --write to apply.")
    return 1 if (problems and (args.check or args.write)) else 0


if __name__ == "__main__":
    sys.exit(main())
