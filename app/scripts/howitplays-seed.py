#!/usr/bin/env python3
"""EXTRACT step of the HOW IT PLAYS content program (D5, step 1).

Read-only over data/: builds one per-machine authoring brief per catalog entry
so authors never have to grep the raw machine files. Every regex below is kept
verbatim from the measured baseline (2026-08) so the counter table printed at
the end reproduces the plan-of-record numbers — if you "improve" a regex you
break the counters' comparability across waves.

WHY THE GUARDS EXIST:
- Sentences are harvested from a FIXED field list (shots[].notes, goals
  summary/reward/instructions/steps, drills[].text, achievements[].desc) with
  stable loc strings, because Verifier A answers per claim path and needs to
  walk straight back to the field a claim came from.
- laneChange negatives are NEG applied to a POS sentence only: a bare "won't"
  in prose is usually about a shot, not about lane change, and promoting it
  would inflate the negative count past the measured 6 machines.
- canon()/SHEET_OVERRIDES are COPIED from detect-lifted-text.py (not imported)
  per house rule: scripts are gated on their own exit code and must not gain a
  sibling-module dependency that can drift under them.

Run:
  python3 app/scripts/howitplays-seed.py --out _Business/HOWITPLAYS/briefs \
      --sheets scratchpad/sheets --transcripts scratchpad/transcripts \
      --counters-json _Business/HOWITPLAYS/extract-counters.json
  python3 app/scripts/howitplays-seed.py --out _Business/HOWITPLAYS/briefs --machines jaws,bad_cats
"""

import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# --- verbatim baseline regexes (do not edit; counters depend on them) ---
RE_LIT = re.compile(r"\blit\b|flashing")
RE_CONTROL_POS = re.compile(
    r"lane[- ]change|flipper buttons? (?:to )?(?:move|rotate|walk|steer|shift|cycle|change)"
    r"|(?:move|rotate|walk|steer|shift|cycle|change) the (?:lit|flashing) "
    r"(?:lane|lamp|light|position|letter)|(?:both|either) flipper(?:s| buttons?)? "
    r"(?:rotate|move|cycle|shift|walk)"
)
RE_CONTROL_NEG = re.compile(
    r"will not|won't|cannot|can't|does not|doesn't|stays put|no lane[- ]change"
)
RE_MULT = re.compile(
    r"bonus (?:x|multiplier)|playfield (?:x|multiplier)|\b\d+x\b|multiplier"
)
RE_SPELL = re.compile(r"\bspell|\bletters?\b|[A-Z](?:-[A-Z]){2,}")
RE_LANE_NAME = re.compile(r"inlane|outlane|top lane|rollover", re.I)
RE_STATUS = re.compile(
    r"ball save|extra ball|special|kickback|mystery|lock is lit|lights? lock"
    r"|light(s)? (the )?jackpot"
)
RE_ARROW_STEP = re.compile(r"arrow|shot|jackpot", re.I)
RE_BALLONE = re.compile(r"beginner|first 30|opener|safe|control", re.I)
RE_LADDER = re.compile(r"ladder|advance|level|mark|stage", re.I)
RE_AWARD = re.compile(r"\d+(?:\.\d+)?\s*(?:million|m|billion|b|k)\b", re.I)

AWARD_SCALE = {"million": 1e6, "m": 1e6, "billion": 1e9, "b": 1e9, "k": 1e3}

SENT_SPLIT = re.compile(r"(?<=[.!?;])\s+")


def canon(s: str) -> str:
    s = s.lower()
    s = re.sub(r"\b(the|a|an)\b", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


# Copied verbatim from app/scripts/detect-lifted-text.py (2026-08-02) so this
# script resolves sheet stems identically to the lift detector without a
# runtime dependency on it. None = "no sheet — never canon-match by name".
SHEET_OVERRIDES = {
    "jurassic-park": "jurassicparkstern",
    "jurassic-park-data-east": "jurassicparkdataeast",
    "star-wars": "starwars",
    "star-wars-data-east": "starwarsdataeast",
    "getaway-high-speed-2": "getaway",
    "x-men": None,
    "x-men-stern-2012": "xmen",
}


def split_sentences(text: str):
    return [s.strip() for s in SENT_SPLIT.split(text) if s and s.strip()]


def harvest_sentences(doc: dict):
    """(loc, text) in stable file order — authors and verifiers cite these locs."""
    out = []
    for i, s in enumerate(doc.get("shots", [])):
        if s.get("notes"):
            out.append((f"shots[{s.get('id', i)}].notes", s["notes"]))
    for g in doc.get("goals", []):
        gid = g.get("id", "?")
        for key in ("summary", "reward"):
            if g.get(key):
                out.append((f"goals[{gid}].{key}", g[key]))
        for j, ins in enumerate(g.get("instructions") or []):
            out.append((f"goals[{gid}].instructions[{j}]", ins))
        for j, st in enumerate(g.get("steps") or []):
            for key in ("action", "detail"):
                if st.get(key):
                    out.append((f"goals[{gid}].steps[{j}].{key}", st[key]))
    for d in doc.get("drills", []):
        if d.get("text"):
            out.append((f"drills[{d.get('id', '?')}].text", d["text"]))
    for a in doc.get("achievements", []):
        if a.get("desc"):
            out.append((f"achievements[{a.get('id', '?')}].desc", a["desc"])
            )
    return [(loc, txt) for loc, txt in out for txt in split_sentences(txt)]


def era_of(name: str) -> str:
    m = re.search(r"\b(19|20)\d{2}\b", name)
    if not m:
        return "DMD"  # no year on record; DMD is the catalog's modal era
    y = int(m.group(0))
    if y < 1979:
        return "EM"
    if y <= 1990:
        return "early-SS"
    if y <= 2013:
        return "DMD"
    return "modern"


def sheet_stem(entry: dict):
    if entry["id"] in SHEET_OVERRIDES:
        return SHEET_OVERRIDES[entry["id"]]
    return canon(entry["name"].split("(")[0]) or canon(entry["id"])


def award_value(text: str) -> float:
    best = 0.0
    for m in RE_AWARD.finditer(text):
        unit = m.group(0).lower()
        unit = re.sub(r"^[\d.\s]+", "", unit).strip()
        num = float(re.match(r"[\d.]+", m.group(0)).group(0))
        best = max(best, num * AWARD_SCALE.get(unit, 0))
    return best


def mentions(sent_text: str, shot: dict) -> bool:
    low = sent_text.lower()
    name = (shot.get("name") or "").lower()
    return bool(name and name in low) or shot.get("id", "").lower() in low


def excerpt_from(text: str, cap: int = 6000):
    """Regex-selected sentences, capped — briefs stay small enough to author from."""
    picked, total = [], 0
    for s in split_sentences(text):
        if not (RE_LIT.search(s) or RE_MULT.search(s) or RE_SPELL.search(s)
                or RE_CONTROL_POS.search(s)):
            continue
        if total + len(s) > cap:
            break
        picked.append(s)
        total += len(s) + 1
    return picked


def build_guide(entry: dict, guides: list):
    name_key = canon(entry["name"].split("(")[0])
    for g in guides:
        if g.get("slug") == entry["id"] or canon(g.get("name", "").split("(")[0]) == name_key:
            sections, cur = [], None
            for block in g.get("body", []):
                tag = block.get("tag")
                if tag == "h2":
                    cur = {"h2": block.get("text", ""), "paragraphs": [], "bullets": []}
                    sections.append(cur)
                elif tag == "p":
                    if cur is None:
                        cur = {"h2": "", "paragraphs": [], "bullets": []}
                        sections.append(cur)
                    cur["paragraphs"].append(block.get("text", ""))
                elif tag == "ul":
                    if cur is None:
                        cur = {"h2": "", "paragraphs": [], "bullets": []}
                        sections.append(cur)
                    cur["bullets"].extend(block.get("items", []))
            return {"description": g.get("description", ""), "sections": sections}
    return None


def build_brief(entry: dict, doc: dict, guides: list, sheet_path, transcript_path):
    sents = harvest_sentences(doc)
    shots = doc.get("shots", [])
    goals = doc.get("goals", [])

    lit = [{"loc": l, "text": t} for l, t in sents if RE_LIT.search(t)]
    pos = [{"loc": l, "text": t} for l, t in sents if RE_CONTROL_POS.search(t)]
    neg = [{"loc": l, "text": t} for l, t in sents
           if RE_CONTROL_POS.search(t) and RE_CONTROL_NEG.search(t)]
    mult = [{"loc": l, "text": t} for l, t in sents if RE_MULT.search(t)]
    spell = [{"loc": l, "text": t} for l, t in sents if RE_SPELL.search(t)]

    shot_rows = []
    for i, s in enumerate(shots):
        shot_rows.append({
            "id": s.get("id", str(i)),
            "type": s.get("type", ""),
            "name": s.get("name", ""),
            "trim": s.get("trim", ""),
            "playfield": s.get("playfield", ""),
        })

    groups = []

    def add_group(kind, site_shots, evidence):
        if site_shots:
            groups.append({"kind": kind,
                           "siteShots": sorted(set(site_shots)),
                           "evidence": evidence})

    # lanes
    lane_ids, lane_ev = [], []
    for i, s in enumerate(shots):
        sid = s.get("id", str(i))
        if (s.get("type") in {"lane", "rollover", "outlane"}
                or RE_LANE_NAME.search(s.get("name", ""))):
            lane_ids.append(sid)
            for l, t in sents:
                if mentions(t, s) and (RE_LIT.search(t) or RE_LANE_NAME.search(t)):
                    lane_ev.append({"loc": l, "text": t})
                    break
    add_group("lanes", lane_ids, lane_ev)

    # letters: spelling shots named by a SPELL sentence
    letter_ids, letter_ev = [], []
    for i, s in enumerate(shots):
        if s.get("type") not in {"standup", "target-bank", "drop-target"}:
            continue
        for l, t in spell:
            if mentions(t, s):
                letter_ids.append(s.get("id", str(i)))
                letter_ev.append({"loc": l, "text": t})
                break
    add_group("letters", letter_ids, letter_ev)

    # shot-arrow: LIT + arrow/shot/jackpot steps pointing at flow shots
    arrow_ids, arrow_ev = [], []
    for g in goals:
        steps = g.get("steps") or []
        for j, st in enumerate(steps):
            blob = " ".join(filter(None, [st.get("action"), st.get("detail")]))
            if not (RE_LIT.search(blob) and RE_ARROW_STEP.search(blob)):
                continue
            st_shot = st.get("shot")
            for i, s in enumerate(shots):
                sid = s.get("id", str(i))
                if sid != st_shot:
                    continue
                if s.get("type") in {"ramp", "orbit", "loop", "scoop", "saucer", "lane"}:
                    arrow_ids.append(sid)
                    for key in ("action", "detail"):
                        if st.get(key):
                            arrow_ev.append({"loc": f"goals[{g.get('id','?')}].steps[{j}].{key}",
                                             "text": st[key]})
    add_group("shot-arrow", arrow_ids, arrow_ev)

    # multiplier: shots driven by multiplier goals or MULT-flavored notes
    mult_goal_shots = set()
    mult_ev = []
    for g in goals:
        if g.get("category") != "multiplier":
            continue
        for j, st in enumerate(g.get("steps") or []):
            if st.get("shot"):
                mult_goal_shots.add(st["shot"])
                if st.get("detail"):
                    mult_ev.append({"loc": f"goals[{g.get('id','?')}].steps[{j}].detail",
                                    "text": st["detail"]})
    for i, s in enumerate(shots):
        sid = s.get("id", str(i))
        if sid in mult_goal_shots:
            continue
        if s.get("notes") and RE_MULT.search(s["notes"]):
            mult_goal_shots.add(sid)
            mult_ev.append({"loc": f"shots[{sid}].notes", "text": s["notes"]})
    add_group("multiplier", sorted(mult_goal_shots), mult_ev)

    # status: notes about saves / locks / specials
    status_ids, status_ev = [], []
    for i, s in enumerate(shots):
        if s.get("notes") and RE_STATUS.search(s["notes"]):
            sid = s.get("id", str(i))
            status_ids.append(sid)
            status_ev.append({"loc": f"shots[{sid}].notes", "text": s["notes"]})
    add_group("status", status_ids, status_ev)

    # mode: first-step shot of each 'mode' goal
    mode_ids, mode_ev = [], []
    for g in goals:
        if g.get("category") != "mode":
            continue
        steps = g.get("steps") or []
        if steps and steps[0].get("shot"):
            mode_ids.append(steps[0]["shot"])
            if g.get("summary"):
                mode_ev.append({"loc": f"goals[{g.get('id','?')}].summary",
                                "text": g["summary"]})
    add_group("mode", mode_ids, mode_ev)

    # ladder: progression goals written as a ladder
    ladder_ids, ladder_ev = [], []
    for g in goals:
        if g.get("category") != "progression":
            continue
        summ = " ".join(filter(None, [g.get("title"), g.get("summary")]))
        if not RE_LADDER.search(summ or ""):
            continue
        named = [st.get("shot") for st in (g.get("steps") or []) if st.get("shot")]
        if named:
            ladder_ids.extend(named)
            if g.get("summary"):
                ladder_ev.append({"loc": f"goals[{g.get('id','?')}].summary",
                                  "text": g["summary"]})
    add_group("ladder", ladder_ids, ladder_ev)

    # scoringSeeds — the three authoring tiers, in priority order
    def seed(g):
        return {"goal": g.get("id", "?"), "title": g.get("title", ""),
                "summary": g.get("summary", "")}

    ball_one = [seed(g) for g in goals
                if g.get("category") == "skillshot"
                or (g.get("category") == "strategy"
                    and RE_BALLONE.search(" ".join(filter(None, [g.get("title"), g.get("summary")])) or ""))]
    building = [seed(g) for g in goals
                if g.get("category") in {"multiball", "multiplier"}]
    big_one = [seed(g) for g in goals if g.get("category") == "wizard"]
    if not big_one:
        best_val, best_g = 0.0, None
        for g in goals:
            v = award_value(" ".join(filter(None, [g.get("reward"), g.get("summary")])))
            if v > best_val:
                best_val, best_g = v, g
        if best_g is not None and best_val > 0:
            big_one = [seed(best_g)]

    if sheet_path is not None:
        tier = "T1"
    elif transcript_path is not None:
        tier = "T2"
    else:
        tier = "T3"

    return {
        "machine": entry["id"],
        "resource": entry["resource"],
        "name": entry["name"],
        "era": era_of(entry["name"]),
        "sourceTier": tier,
        "sheet": str(sheet_path) if sheet_path else None,
        "transcript": str(transcript_path) if transcript_path else None,
        "shots": shot_rows,
        "candidateGroups": groups,
        "laneChangeEvidence": {"positive": pos, "negative": neg},
        "multiplierEvidence": mult,
        "spellEvidence": spell,
        "litSentences": lit,
        "scoringSeeds": {"ballOne": ball_one, "building": building, "bigOne": big_one},
        "goalIndex": [{"id": g.get("id", "?"), "category": g.get("category", ""),
                       "title": g.get("title", ""), "difficulty": g.get("difficulty")}
                      for g in goals],
        "guide": build_guide(entry, guides),
        "sheetExcerpt": (excerpt_from(sheet_path.read_text(encoding="utf-8", errors="replace"))
                         if sheet_path else []),
        "transcriptExcerpt": (excerpt_from(transcript_path.read_text(encoding="utf-8",
                                                                    errors="replace"))
                              if transcript_path else []),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--sheets")
    ap.add_argument("--transcripts")
    ap.add_argument("--machines")
    ap.add_argument("--counters-json")
    args = ap.parse_args()

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    sheets_dir = pathlib.Path(args.sheets) if args.sheets else None
    transcripts_dir = pathlib.Path(args.transcripts) if args.transcripts else None

    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    guides_path = DATA / "guides.json"
    guides = (json.loads(guides_path.read_text(encoding="utf-8"))
              if guides_path.exists() else [])

    subset = set(args.machines.split(",")) if args.machines else None
    counters = {"machines": 0, "laneChangePositive": 0, "laneChangeNegative": 0,
                "laneChangeNone": 0, "multiplier": 0, "spell": 0, "lit": 0,
                "tiers": {"T1": 0, "T2": 0, "T3": 0},
                "groupsByKind": {}}

    for entry in catalog:
        if subset and entry["id"] not in subset:
            continue
        doc_path = DATA / f"{entry['resource']}.json"
        if not doc_path.exists():
            print(f"skip {entry['id']}: missing {doc_path.name}", file=sys.stderr)
            continue
        doc = json.loads(doc_path.read_text(encoding="utf-8"))

        stem = sheet_stem(entry)
        sheet_path = None
        if stem and sheets_dir and sheets_dir.exists():
            cand = sheets_dir / f"{stem}.txt"
            if cand.exists():
                sheet_path = cand
        transcript_path = None
        if transcripts_dir and transcripts_dir.exists():
            hits = sorted(transcripts_dir.glob(f"{entry['id']}*.txt"))
            if hits:
                transcript_path = hits[0]

        brief = build_brief(entry, doc, guides, sheet_path, transcript_path)
        (out_dir / f"{entry['id']}.json").write_text(
            json.dumps(brief, indent=1, sort_keys=True, ensure_ascii=False),
            encoding="utf-8")

        counters["machines"] += 1
        if brief["laneChangeEvidence"]["positive"]:
            counters["laneChangePositive"] += 1
        elif brief["laneChangeEvidence"]["negative"]:
            counters["laneChangeNegative"] += 1
        else:
            counters["laneChangeNone"] += 1
        if brief["multiplierEvidence"]:
            counters["multiplier"] += 1
        if brief["spellEvidence"]:
            counters["spell"] += 1
        if brief["litSentences"]:
            counters["lit"] += 1
        counters["tiers"][brief["sourceTier"]] += 1
        for grp in brief["candidateGroups"]:
            counters["groupsByKind"][grp["kind"]] = \
                counters["groupsByKind"].get(grp["kind"], 0) + 1

    print("HOW IT PLAYS extract counters")
    print(f"  machines              : {counters['machines']}")
    print(f"  laneChange positive   : {counters['laneChangePositive']}")
    print(f"  laneChange negative   : {counters['laneChangeNegative']}")
    print(f"  laneChange none       : {counters['laneChangeNone']}")
    print(f"  multiplier language   : {counters['multiplier']}")
    print(f"  spell-out language    : {counters['spell']}")
    print(f"  lit/flashing language : {counters['lit']}")
    print("  source tiers          : "
          + " ".join(f"{k}={v}" for k, v in sorted(counters["tiers"].items())))
    for kind in sorted(counters["groupsByKind"]):
        print(f"  candidate groups {kind:<12}: {counters['groupsByKind'][kind]}")

    if args.counters_json:
        pathlib.Path(args.counters_json).write_text(
            json.dumps(counters, indent=1, sort_keys=True), encoding="utf-8")
        print(f"wrote {args.counters_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
