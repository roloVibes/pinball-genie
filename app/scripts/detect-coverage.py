#!/usr/bin/env python3
"""Coverage gauge for the playfield-truth data program (P0, 2026-08-10).

Prints the FULL-population counters the program is measured by — never a
sample ("measure, don't sample"): deck-candidate machines, the plunge
adjudication population, feeds/apex coverage, templated flipper pairs, and
schema-v5 authoring progress (playfields/plungeTo/technique/cards/drills).

Run:  python3 app/scripts/detect-coverage.py [--write]
      --write also refreshes _Business/BASELINE-COUNTS-2026-08.json the first
      time and _Business/COVERAGE-LATEST.json every time (stable key order, so
      `git diff` shows exactly which counter moved).

These counts gate the passes: P2 works the deck-candidate list, P3 drives
plunge coverage to 100% adjudicated, P4 drives feeds coverage up, P5 drives
coords_vision_checked. Counts must never silently regress — run this before
every deploy alongside validate-machines.py.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
BIZ = ROOT / "_Business"

DECK_LANG = re.compile(
    r"upper playfield|mini[- ]playfield|basement|balcony|upper deck"
    r"|lower playfield|powerfield|\bdeck\b",
    re.IGNORECASE,
)
FEED_TYPES = {"ramp", "orbit", "loop", "scoop"}
# Back-of-cabinet furniture that clusters at high y without being a deck.
CLUSTER_EXEMPT_TYPES = {"orbit", "lane", "plunge"}


def texts_of(doc):
    for s in doc.get("shots", []):
        yield s.get("name") or ""
        yield s.get("notes") or ""
    for g in doc.get("goals", []):
        yield g.get("title") or ""
        yield g.get("summary") or ""


def main() -> int:
    write = "--write" in sys.argv
    files = sorted(DATA.glob("*_goals.json"))

    deck_by_lang, deck_by_cluster, deck_by_type = [], [], []
    plunge_pop = plunge_hinted = plunge_to = 0
    skillshot_goals = skillshot_steps = plunge_target_steps = 0
    feed_pop = feed_have = 0
    feed_by_type = {t: [0, 0] for t in FEED_TYPES}  # type -> [have, total]
    apex_n = feeds_n = flipper_n = technique_steps = backhand_shots = 0
    templated_pairs, zone_files, card_files, drill_files = [], [], [], []
    shots_total = goals_total = zones_total = 0

    for path in files:
        doc = json.loads(path.read_text(encoding="utf-8"))
        stem = path.stem
        shots = doc.get("shots", [])
        goals = doc.get("goals", [])
        shots_total += len(shots)
        goals_total += len(goals)
        by_id = {s.get("id"): s for s in shots}

        # -- deck candidates ------------------------------------------------
        if any(DECK_LANG.search(t) for t in texts_of(doc)):
            deck_by_lang.append(stem)
        if any(s.get("type") == "mini-playfield" for s in shots):
            deck_by_type.append(stem)
        cluster = [
            s for s in shots
            if isinstance(s.get("y"), (int, float)) and s["y"] >= 0.85
            and s.get("type") not in CLUSTER_EXEMPT_TYPES
        ]
        if len(cluster) >= 3:
            deck_by_cluster.append(stem)

        # -- plunge population ---------------------------------------------
        for g in goals:
            is_skill = g.get("category") == "skillshot"
            if is_skill:
                skillshot_goals += 1
            for j, st in enumerate(g.get("steps") or []):
                target = by_id.get(st.get("shot"), {})
                is_plunge_target = target.get("type") == "plunge"
                if is_plunge_target:
                    plunge_target_steps += 1
                if is_skill:
                    skillshot_steps += 1
                if is_skill or is_plunge_target:
                    plunge_pop += 1
                    if st.get("plunge") is not None:
                        plunge_hinted += 1
                if st.get("plungeTo") is not None:
                    plunge_to += 1
                if st.get("technique"):
                    technique_steps += 1

        # -- feeds/apex coverage -------------------------------------------
        for s in shots:
            t = s.get("type")
            if t in FEED_TYPES:
                feed_pop += 1
                feed_by_type[t][1] += 1
                if s.get("feeds") or s.get("feedsByTrim"):
                    feed_have += 1
                    feed_by_type[t][0] += 1
            if s.get("apex"):
                apex_n += 1
            if s.get("feeds"):
                feeds_n += 1
            if s.get("flipper"):
                flipper_n += 1
            if s.get("backhand"):
                backhand_shots += 1

        # -- templated flipper pair ----------------------------------------
        pts = {(s.get("x"), s.get("y")) for s in shots}
        if (0.33, 0.05) in pts and (0.67, 0.05) in pts:
            templated_pairs.append(stem)

        # -- schema v5 authoring progress ----------------------------------
        if doc.get("playfields"):
            zone_files.append(stem)
            zones_total += len(doc["playfields"])
        if doc.get("card"):
            card_files.append(stem)
        if doc.get("drills"):
            drill_files.append(stem)

    deck_union = sorted(set(deck_by_lang) | set(deck_by_cluster) | set(deck_by_type))

    report = {
        "generated_for": "playfield-truth data program",
        "files": len(files),
        "shots": shots_total,
        "goals": goals_total,
        "deck_candidates": {
            "by_language": len(deck_by_lang),
            "by_cluster_y085": len(deck_by_cluster),
            "by_type_mini_playfield": len(deck_by_type),
            "union": len(deck_union),
            "union_files": deck_union,
        },
        "plunge": {
            "population_steps": plunge_pop,
            "hinted": plunge_hinted,
            "with_plungeTo": plunge_to,
            "skillshot_goals": skillshot_goals,
            "skillshot_steps": skillshot_steps,
            "plunge_target_steps": plunge_target_steps,
        },
        "feeds": {
            "population_ramp_orbit_loop_scoop": feed_pop,
            "have_feeds": feed_have,
            "by_type": {t: {"have": v[0], "total": v[1]} for t, v in sorted(feed_by_type.items())},
            "shots_with_feeds_any_type": feeds_n,
        },
        "apex_shots": apex_n,
        "flipper_hint_shots": flipper_n,
        "backhand_shots": backhand_shots,
        "technique_steps": technique_steps,
        "templated_flipper_pairs": {
            "count": len(templated_pairs),
            "files": templated_pairs,
        },
        "schema_v5": {
            "files_with_playfields": len(zone_files),
            "playfield_zones": zones_total,
            "files_with_card": len(card_files),
            "files_with_drills": len(drill_files),
        },
    }

    print(json.dumps({k: v for k, v in report.items()
                      if k not in ("deck_candidates", "templated_flipper_pairs")},
                     indent=2))
    print(f"deck candidates: lang={len(deck_by_lang)} cluster={len(deck_by_cluster)} "
          f"type={len(deck_by_type)} UNION={len(deck_union)}")
    print(f"templated flipper pairs: {len(templated_pairs)}")

    if write:
        BIZ.mkdir(exist_ok=True)
        latest = BIZ / "COVERAGE-LATEST.json"
        latest.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {latest.relative_to(ROOT)}")
        baseline = BIZ / "BASELINE-COUNTS-2026-08.json"
        if not baseline.exists():
            baseline.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(f"wrote {baseline.relative_to(ROOT)} (immutable before-picture)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
