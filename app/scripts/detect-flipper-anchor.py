#!/usr/bin/env python3
"""Flipper-anchor detector for data/*_goals.json (2026-08-11).

WHY THIS EXISTS. shotgeom.ts landed a "Feature 1" extension the same day this
script was written: `GoalStep.flipper` / `Shot.flipper` may now name a
flipper-typed SHOT ID (not just 'left'/'right'), so a route can anchor at an
upper/mini/deck flipper instead of the two main ones — the fix was Jaws'
harpoon-lane, which is actually made from the mid-right mini flipper, not the
main right flipper the old left/right-only heuristic assumed. Before that
fix, the renderer silently drew the arrow from the wrong flipper while the
goal text said the right thing — invisible in review, exactly the class of
bug validate-machines.py's check_shot_text exists to catch for shot IDENTITY.
This script is the same idea applied to flipper PROVENANCE: it finds every
other place in the catalog where prose names a non-main flipper but nothing
in the structured data anchors there, so the renderer will fall back to the
ordinary main-flipper heuristic and silently contradict the text.

This is a READ-ONLY detector. It enumerates data/*_goals.json, prints
counts, and writes ONE output file: _Business/catalog-passes/anchor/
detector.json. It never writes under data/ and never touches git. It is
input to the task-21 "Flipper-anchor review" pass (a human/LLM review of the
detector's candidates), not a fixer itself.

THREE CHECKS, ONE OUTPUT FILE:

(a) mismatches — TEXT-VS-ANCHOR. For every goal step, scan `action` and
    `detail` for mentions of this machine's own shot NAMES using the exact
    longest-first, masked-span algorithm validate-machines.py's
    check_shot_text uses for shot-identity mentions (see _norm_shot_text /
    find_mentions below — same normalization, same "longest phrase first,
    mask the matched span, try the plural too" mechanics). Keep only
    mentions that resolve to a flipper-typed shot classified NON-MAIN (see
    (b)). If the step's own `flipper` override and the target shot's own
    `.flipper` field BOTH fail to name that same flipper shot id, the arrow
    will render from the main flippers while the prose names a different
    one — flagged as a mismatch. One finding per (goal, step); a step's
    `hits[]` lists every (field, flipper shot) pair that triggered it.

(b) upperFlipperMachines — STRUCTURAL. Any machine carrying a flipper-typed
    shot beyond its main pair. "Main pair" is decided GEOMETRICALLY, not by
    name (name alone is unreliable — Iron Maiden's true mains are
    `lower-left-flipper`/`lower-right-flipper`, not `left-flipper`/
    `right-flipper`, because that file also has `mid-right-flipper` and
    `upper-left-flipper` to disambiguate from). models.ts documents shot
    coordinates as "y 0→1 flippers→back", and app/src/models.ts's own
    FLIPPER_ANCHORS sits at v=0.04 — the main flippers live at the very
    bottom of the table. Empirically, across every flipper-typed shot in
    the current catalog (353 shots, 141 files, audited 2026-08-11), every
    shot whose id normalizes to exactly "left flipper"/"right flipper" has
    y <= 0.09, and every other flipper-typed shot has y >= 0.12 — a clean
    gap. MAIN_PAIR_Y_MAX = 0.10 sits in that gap and reproduces the plain-
    name classification exactly, while ALSO correctly classifying the non-
    obviously-named cases (Iron Maiden's lower-left/right at y=0.05 read as
    main; Road Show's middle-left/upper-left at y=0.28/0.62 both read as
    non-main — this machine's true main pair was apparently never authored
    as shots at all). No machine in the catalog has more than 2 flipper
    shots at y<=0.10, so this rule never over-selects a "main pair" bigger
    than 2. A machine is flagged the moment it has >=1 flipper-typed shot
    above that line.

(c) contradictions — carried over verbatim from
    _Business/P4-APPLY-2026-08-11.json's `contradictionsForReview`: feed
    findings a prior pass could not resolve either direction. Not
    flipper-specific, but the same "conflicting evidence, needs a human"
    shape task 21 is triaging, so it rides in the same output file instead
    of a fourth place to look.

Run:  python3 app/scripts/detect-flipper-anchor.py
Writes: _Business/catalog-passes/anchor/detector.json
Exit: always 0 — this is a report, not a gate (unlike validate-machines.py).
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
BUSINESS = ROOT / "_Business"
P4_APPLY = BUSINESS / "P4-APPLY-2026-08-11.json"
OUT_DIR = BUSINESS / "catalog-passes" / "anchor"
OUT = OUT_DIR / "detector.json"

# See docstring (b). Empirically validated 2026-08-11 against every
# flipper-typed shot in data/*_goals.json: max true-main y observed = 0.09
# (abra_ca_dabra), min non-main y observed = 0.12 (x_men's dr-mini-flipper).
# 0.10 sits in that gap. Re-validate this constant (rerun the distribution
# check in the audit notes) if a newly added machine ever trips the
# "more than 2 flippers at y<=MAIN_PAIR_Y_MAX" assertion below.
MAIN_PAIR_Y_MAX = 0.10


def _norm_shot_text(s: str) -> str:
    """Verbatim copy of validate-machines.py's _norm_shot_text — same
    normalization must produce the same mention matches for the two checks
    to agree on what counts as "this machine's shot names"."""
    s = s.lower().replace("·", " ")  # Pin·Bot style interpuncts
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return " ".join(s.split())


def find_mentions(text: str, by_len: list[tuple[str, str]]) -> list[str]:
    """Longest-first, masked-span mention finder — the exact mechanics of
    validate-machines.py's check_shot_text inner loop (same padding, same
    plural variant, same masking with '§'), generalized to return every
    shot id mentioned rather than stopping at "exactly one other shot"."""
    t = f" {_norm_shot_text(text)} "
    mentioned: list[str] = []
    for sid, phrase in by_len:
        for variant in (f" {phrase} ", f" {phrase}s "):
            if variant in t:
                mentioned.append(sid)
                t = t.replace(variant, " § ")
                break
    return mentioned


def classify_flippers(shots: list[dict]) -> tuple[set[str], set[str]]:
    """(main_ids, extra_ids) among this machine's type:'flipper' shots. See
    docstring (b) for the geometric rule and its empirical basis."""
    main_ids: set[str] = set()
    extra_ids: set[str] = set()
    for s in shots:
        if s.get("type") != "flipper":
            continue
        sid = s.get("id")
        if not sid:
            continue
        y = s.get("y")
        if isinstance(y, (int, float)) and y <= MAIN_PAIR_Y_MAX:
            main_ids.add(sid)
        else:
            extra_ids.add(sid)
    assert len(main_ids) <= 2, (
        f"classify_flippers found {len(main_ids)} flipper shots at "
        f"y<={MAIN_PAIR_Y_MAX} ({sorted(main_ids)}) — more than a pair; "
        "MAIN_PAIR_Y_MAX needs re-validating against the current catalog"
    )
    return main_ids, extra_ids


def check_machine(
    path: pathlib.Path,
    mismatches: list[dict],
    upper_flipper_machines: list[dict],
) -> None:
    name = path.name
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"WARN  {name}: invalid JSON — {exc} (skipped)")
        return

    shots = doc.get("shots", [])
    if not isinstance(shots, list):
        return
    shots_by_id = {s["id"]: s for s in shots if isinstance(s, dict) and s.get("id")}
    main_ids, extra_ids = classify_flippers(shots)

    if extra_ids:
        upper_flipper_machines.append(
            {
                "file": name,
                "machine": doc.get("machine", name),
                "mainFlippers": sorted(main_ids),
                "extraFlippers": sorted(
                    extra_ids, key=lambda sid: (shots_by_id.get(sid, {}).get("y", 0), sid)
                ),
            }
        )

    if not extra_ids:
        return  # nothing beyond the main pair — no flipper text to mis-anchor

    # Same shot_names/by_len construction as check_shot_text — built from
    # ALL shots (not just flippers) so masking behaves identically (e.g. an
    # "Upper Left Flipper" mention correctly consumes "Left Flipper" too via
    # longest-first, instead of leaving a spurious extra match behind).
    shot_names: dict[str, str] = {}
    for s in shots:
        if not isinstance(s, dict):
            continue
        n = _norm_shot_text(s.get("name") or "")
        if s.get("id") and len(n) >= 4:
            shot_names[s["id"]] = n
    by_len = sorted(shot_names.items(), key=lambda kv: -len(kv[1]))

    for goal in doc.get("goals", []):
        if not isinstance(goal, dict):
            continue
        gid = goal.get("id", "")
        for j, step in enumerate(goal.get("steps") or []):
            if not isinstance(step, dict):
                continue
            step_flipper = step.get("flipper")
            target = shots_by_id.get(step.get("shot"), {})
            target_flipper = target.get("flipper")

            hits: list[dict] = []
            for field in ("action", "detail"):
                text = step.get(field)
                if not text:
                    continue
                for sid in find_mentions(text, by_len):
                    if sid not in extra_ids:
                        continue
                    if step_flipper == sid or target_flipper == sid:
                        continue  # properly anchored — not a mismatch
                    hits.append(
                        {"field": field, "flipper": sid, "flipperName": shot_names.get(sid)}
                    )

            if hits:
                mismatches.append(
                    {
                        "file": name,
                        "machine": doc.get("machine", name),
                        "goal": gid,
                        "step": j,
                        "shot": step.get("shot"),
                        "stepFlipper": step_flipper,
                        "targetShotFlipper": target_flipper,
                        "action": step.get("action"),
                        "detail": step.get("detail"),
                        "hits": hits,
                    }
                )


def load_contradictions() -> list[dict]:
    if not P4_APPLY.exists():
        print(f"WARN  {P4_APPLY.relative_to(ROOT)} not found — contradictions[] will be empty")
        return []
    doc = json.loads(P4_APPLY.read_text(encoding="utf-8"))
    return doc.get("contradictionsForReview", [])


def main() -> int:
    files = sorted(DATA.glob("*_goals.json"))

    mismatches: list[dict] = []
    upper_flipper_machines: list[dict] = []
    for path in files:
        check_machine(path, mismatches, upper_flipper_machines)

    mismatches.sort(key=lambda m: (m["file"], m["goal"], m["step"]))
    upper_flipper_machines.sort(key=lambda m: m["file"])

    contradictions = load_contradictions()

    out = {
        "mismatches": mismatches,
        "upperFlipperMachines": upper_flipper_machines,
        "contradictions": contradictions,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    total_hits = sum(len(m["hits"]) for m in mismatches)
    print(f"{len(files)} machines scanned in {DATA.relative_to(ROOT)}/")
    print(
        f"(a) {len(mismatches)} text-vs-anchor mismatches "
        f"({total_hits} individual field/flipper hits) across "
        f"{len({m['file'] for m in mismatches})} machines"
    )
    print(
        f"(b) {len(upper_flipper_machines)} machines with a flipper-typed shot "
        "beyond the main pair"
    )
    print(f"(c) {len(contradictions)} contradictions merged from {P4_APPLY.name}")
    print(f"\nWrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
