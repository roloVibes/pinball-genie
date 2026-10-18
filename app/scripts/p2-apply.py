#!/usr/bin/env python3
"""P2 deck-inventory applier — writes verifier-upheld playfield zones into
data/<machine>_goals.json (dataset schema v5, see app/src/models.ts's
PlayfieldZone/Shot doc comments).

Consumes _Business/catalog-passes/p2/batch-{1..5}.json (research findings:
{batch, machines:[{stem, verdict:'has-deck'|'no-deck'|'unverified', zone?,
zones?, memberShots?, newShots?, evidence, notes?}], extraFlagged}) and
verify-{1,2}.json (verification pass: {machines:[{stem, original,
verdict:'upheld'|'overturned'|'uncertain', corrected?, why}]}).

SELECTION RULE (owner spec, 2026-08-11): apply ONLY machines whose research
verdict is 'has-deck' AND whose verify verdict is 'upheld' (use the batch
finding as-authored) or 'overturned' WITH a corrected has-deck zone/zones
object (use the corrected one). Skip uncertain / overturned-without-
correction / no-deck — report them, don't apply them. A research verdict of
'unverified' does NOT satisfy "research verdict is has-deck", even if verify
later overturns it to has-deck with a full correction (this happened once,
lord_of_the_rings_goals — see verify-1.json) — that machine is deliberately
SKIPPED, not force-applied, and flagged distinctly in the report so a human
can decide. Flagship machines (jaws/evil_dead/halloween) are P1-owned and
always excluded here regardless of what the P2 artifacts say about them.

SHAPE NOTE: a "zone" proposal is normally a single object under the key
`zone`, but 5 machines in this dataset (wizard_of_oz -- 2 real decks --,
world_poker_tour, wwf_royal_rumble, x_men, and popeye's verify-corrected
object) use the plural `zones: [{zone, memberShots, newShots}, ...]` instead.
Both shapes are handled uniformly (extract_zone_specs below) and a machine
can end up with more than one new playfields[] entry in one write.

Guards (each one exists because a prior applier shipped a defect without
it — see apply-structured.py's own header for the same philosophy):
  * round-trip no-op self-test per file: indent=2 json.dumps of the untouched
    doc must reproduce the file byte-for-byte, or the file is refused.
  * backup before write: scratchpad/data-backup-p2-zones/<file>, once per
    machine, before its (single, combined) write.
  * referential checks, computed BEFORE any mutation: zone id must not
    already exist in the file's playfields[]; every memberShots id must
    resolve to an existing shot; every newShots id must NOT collide with an
    existing shot id; zone.entries ids must resolve to existing shots;
    zone.exits[].shot refs must resolve to an existing OR same-machine
    newShot id; every member/new shot's (x,y) must fall inside its zone's
    bounds (±0.02, mirrors validate-machines.py's ZONE_EPS) or the write is
    refused outright rather than shipped to fail the validator blind.
  * NEVER overwrite: an existing playfields[] zone id, an existing shot id
    (for newShots), or a shot's existing non-null `.playfield`. Any of these
    refuses that whole machine (reported in failed[], nothing written).
  * schema-key filtering: PlayfieldZone/Shot objects are rebuilt keeping only
    fields models.ts actually declares — this drops `bounds.estimate` (every
    proposed zone in this dataset carries it; the schema has no such field)
    and any other stray key, rather than shipping it into the data file.
    `estimate` never appears anywhere else in this dataset (checked), but the
    filter is general, not a special case for that one key.
  * memberShotCoordinateFix (verify-authored, currently only munsters):  a
    corrected zone's tighter bounds can leave its OWN pre-existing member
    shots geometrically outside the box (the finding says so explicitly) —
    when the correction supplies `memberShotCoordinateFix: {shots: {id:
    {x,y}}}`, those EXISTING shots' x/y are patched as part of the same
    write, so the zone it belongs to is geometrically valid the moment it
    ships instead of shipping broken and relying on validate-machines.py's
    rollback to notice.
  * excludeFromZones (verify-authored, currently only popeye): asserted
    against the machine's own computed member/new-shot id set — a
    contradiction (an excluded id ending up assigned anyway) is a hard
    failure, not a silent drop.
  * post-write gate: validate-machines.py must stay clean for THIS machine's
    file or its pre-write backup is restored and the errors are recorded;
    the run continues with the remaining machines either way.

Run:
  python3 app/scripts/p2-apply.py --dry-run     # plan + referential checks only, no writes
  python3 app/scripts/p2-apply.py --apply       # writes data/, then the OUTPUT report
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
BIZ = ROOT / "_Business"
SCRATCH = ROOT / "scratchpad"
P2 = BIZ / "catalog-passes" / "p2"
VALIDATE = ROOT / "app" / "scripts" / "validate-machines.py"
BACKUP_DIR = SCRATCH / "data-backup-p2-zones"
OUTPUT = BIZ / "P2-APPLY-2026-08-11.json"

FLAGSHIP_EXCLUDED = {"jaws_goals", "evil_dead_goals", "halloween_goals"}

# Mirrors app/src/models.ts exactly — anything outside these sets is a
# research/verify-artifact-only field (evidence, notes, estimate, ...) and
# must never reach the data file.
ZONE_FIELDS = ("id", "name", "kind", "bounds", "trim", "entries", "exits")
BOUNDS_FIELDS = ("x", "y", "w", "h")
SHOT_FIELDS = (
    "id", "name", "type", "x", "y", "trim", "notes", "apex", "feeds",
    "flipper", "playfield", "bat", "feedsByTrim", "backhand",
)
BAT_FIELDS = ("side", "size")
ZONE_EPS = 0.02  # matches validate-machines.py

# Owner style rule (2026-08-11): zone display names stay concise — no
# "(Upper Playfield)"/"(Lower Playfield)" suffix restating the `kind` field
# that's already structured data (cf. jaws' shipped "Orca Deck", not "Orca
# Deck (Upper Playfield)"). 5 of the 27 proposed names in this dataset
# violate that (hand-reviewed, not regex-stripped — a generic transform
# risks mangling a name shape not seen here): 3 lead with the generic term
# ("Upper Playfield (Springfield Elementary Rooftop)" etc — backwards from
# the rule's own example but the same redundancy), 1 trails it exactly like
# the rule's example, and 1 (popeye) partially restates 'upper' while also
# carrying real information ('Fixed', distinguishing it from the sibling
# Kneedeep zone) that a plain "Animals" name doesn't need to keep — the two
# zones are already distinguished by name alone. Keyed by (stem, zone id) so
# a rename never accidentally hits a same-named zone on another machine.
ZONE_NAME_OVERRIDES: dict[tuple[str, str], str] = {
    ("munsters_goals", "munsters-grandpa-lab-zone"): "Grandpa's Laboratory",
    ("popeye_goals", "popeye-animals-zone"): "Animals",
    ("simpsons_pinball_party_goals", "deck-springfield-upper"): "Springfield Elementary Rooftop",
    ("space_station_goals", "deck-mini-playfield"): "1-2-3 Lanes",
    ("super_mario_bros_goals", "deck-raised-platform"): "Raised Platform",
}

# Two targeted, hand-reviewed overrides discovered by the FIRST --apply run
# (both surfaced by validate-machines.py's per-machine gate, both root-caused
# before deciding what to do — neither is a blanket heuristic, both are
# narrow (stem, id) pairs so they can never silently fire on a future batch):
#
# 1. indiana_jones_goals' proposed newShot poa-the-pit ("The Pit") triggers
#    check_shot_text: existing goal "the-pit" already has a step whose action
#    names "The Pit" while steps[].shot is the pre-existing AGGREGATE shot
#    path-of-adventure — introducing a new shot actually named "The Pit"
#    makes that read as a label/arrow contradiction. The finding's OWN notes
#    call this decomposition "Optional... goals ('the-pit', achievement
#    'ij-pit') already reference the aggregate shot id, so splitting this out
#    needs a goals-linkage pass too" — i.e. the researcher already flagged
#    this newShot as contingent on follow-up work this apply does not do.
#    Dropped; the zone itself and its real member (path-of-adventure) are
#    unaffected and still applied.
NEWSHOT_DROP: set[tuple[str, str]] = {
    ("indiana_jones_goals", "poa-the-pit"),
}

# 2. wizard_of_oz_goals' proposed newShot castle-search-orbit carries a
#    `notes` field written entirely in research-provenance voice ("Named
#    'Search Orbit' in the machine's own rulesheet text... no diagram
#    found") — trips INTERNAL_TERMS ('rulesheet'). Shot.notes is optional;
#    the shot itself (id/name/type/x/y/playfield, sourced and geometrically
#    clean) is unaffected by the finding's caveats and is kept. Dropping the
#    field rather than rewriting it: authoring replacement player-facing
#    prose is outside this script's "apply structural findings" mandate.
SHOT_FIELD_STRIP: dict[tuple[str, str], set[str]] = {
    ("wizard_of_oz_goals", "castle-search-orbit"): {"notes"},
}


def dump(doc: dict) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def clean_bounds(b: dict) -> dict:
    return {k: b[k] for k in BOUNDS_FIELDS}


FEEDREF_FIELDS = ("x", "y", "shot", "loop")
FEEDREF_LOOP_FIELDS = ("x", "y", "shot")


def clean_feedref(ref, path: str) -> tuple[object, list[str]]:
    """A zone's `exits[]` entries are FeedRef objects (x?/y?/shot?/loop?) —
    the SAME shape Shot.feeds uses, and just as prone to carrying a stray
    proposal-only 'estimate' key (found live: space_station's exit). Cleaned
    the same way clean_zone/clean_shot are, so it's never special-cased
    again."""
    if not isinstance(ref, dict):
        return ref, []
    dropped = [f"{path}.{k}" for k in ref if k not in FEEDREF_FIELDS]
    out = {k: ref[k] for k in FEEDREF_FIELDS if k in ref}
    if isinstance(out.get("loop"), dict):
        loop_dropped = [f"{path}.loop.{k}" for k in out["loop"] if k not in FEEDREF_LOOP_FIELDS]
        dropped.extend(loop_dropped)
        out["loop"] = {k: out["loop"][k] for k in FEEDREF_LOOP_FIELDS if k in out["loop"]}
    return out, dropped


def clean_zone(zone: dict) -> tuple[dict, list[str]]:
    dropped = [k for k in zone if k not in ZONE_FIELDS]
    out = {}
    for k in ZONE_FIELDS:
        if k == "bounds":
            out["bounds"] = clean_bounds(zone["bounds"])
            if "estimate" in zone["bounds"]:
                dropped.append("bounds.estimate")
        elif k == "exits" and zone.get("exits"):
            cleaned_exits = []
            for i, ex in enumerate(zone["exits"]):
                cex, ex_dropped = clean_feedref(ex, f"exits[{i}]")
                cleaned_exits.append(cex)
                dropped.extend(ex_dropped)
            out["exits"] = cleaned_exits
        elif k in zone:
            out[k] = zone[k]
    return out, dropped


def clean_shot(shot: dict) -> tuple[dict, list[str]]:
    dropped = [k for k in shot if k not in SHOT_FIELDS]
    out = {k: shot[k] for k in SHOT_FIELDS if k in shot}
    if isinstance(out.get("bat"), dict):
        bat_dropped = [k for k in out["bat"] if k not in BAT_FIELDS]
        if bat_dropped:
            dropped.extend(f"bat.{k}" for k in bat_dropped)
            out["bat"] = {k: out["bat"][k] for k in BAT_FIELDS if k in out["bat"]}
    if out.get("feeds") is not None:
        out["feeds"], fd = clean_feedref(out["feeds"], "feeds")
        dropped.extend(fd)
    if isinstance(out.get("feedsByTrim"), dict):
        cleaned_fbt = {}
        for tk, tv in out["feedsByTrim"].items():
            cleaned_fbt[tk], fd = clean_feedref(tv, f"feedsByTrim.{tk}")
            dropped.extend(fd)
        out["feedsByTrim"] = cleaned_fbt
    return out, dropped


def extract_zone_specs(obj: dict | None):
    """obj carries either 'zone' (single dict) or 'zones' (list of
    {zone, memberShots, newShots}). Returns a list of
    (zone_dict, memberShots, newShots) tuples, or None if neither is usable."""
    if not obj:
        return None
    if obj.get("zones"):
        return [
            (zw["zone"], zw.get("memberShots") or [], zw.get("newShots") or [])
            for zw in obj["zones"]
            if zw.get("zone")
        ]
    if obj.get("zone"):
        return [(obj["zone"], obj.get("memberShots") or [], obj.get("newShots") or [])]
    return None


def load_indexed(pattern: str, count: int, start: int = 1) -> dict[str, dict]:
    by_stem = {}
    for i in range(start, start + count):
        f = P2 / (pattern % i)
        d = json.loads(f.read_text(encoding="utf-8"))
        for m in d["machines"]:
            by_stem[m["stem"]] = m
    return by_stem


def build_plan():
    """Returns (applied_plan, skipped) where applied_plan is a list of
    dicts {stem, source, zone_specs, extra} and skipped is [(stem, why)]."""
    batch_by_stem = load_indexed("batch-%d.json", 5)
    verify_by_stem = load_indexed("verify-%d.json", 2)

    plan = []
    skipped = []
    for stem, bm in sorted(batch_by_stem.items()):
        if stem in FLAGSHIP_EXCLUDED:
            skipped.append((stem, "flagship-owned (handled in P1) — excluded from P2 regardless of verdict"))
            continue

        research_verdict = bm.get("verdict")
        if research_verdict != "has-deck":
            note = ""
            vm = verify_by_stem.get(stem)
            if vm and vm.get("verdict") == "overturned":
                c = vm.get("corrected") or {}
                if c.get("verdict") == "has-deck" and extract_zone_specs(c):
                    note = (" [FLAGGED FOR MANUAL REVIEW: verify overturned this to has-deck with a "
                             "full corrected zone, but research verdict was not 'has-deck' so the task's "
                             "AND-gated apply rule does not cover it — not auto-applied]")
            skipped.append((stem, f"research verdict {research_verdict!r} (not has-deck){note}"))
            continue

        vm = verify_by_stem.get(stem)
        if vm is None:
            skipped.append((stem, "has-deck research with NO matching verify entry — refusing to apply unverified"))
            continue

        vv = vm.get("verdict")
        if vv == "upheld":
            specs = extract_zone_specs(bm)
            if not specs:
                skipped.append((stem, "upheld but the research entry carries no zone/zones payload — refusing"))
                continue
            plan.append({"stem": stem, "source": "upheld", "zone_specs": specs, "extra": {}})
        elif vv == "overturned":
            corrected = vm.get("corrected")
            if not isinstance(corrected, dict):
                skipped.append((stem, "overturned without a corrected object"))
                continue
            if corrected.get("verdict") != "has-deck":
                why = (corrected.get("notes") or vm.get("why") or "")[:200]
                skipped.append((stem, f"overturned -> corrected verdict {corrected.get('verdict')!r} (not has-deck): {why}"))
                continue
            specs = extract_zone_specs(corrected)
            if not specs:
                skipped.append((stem, "overturned -> has-deck but no corrected zone/zones object — refusing"))
                continue
            extra = {
                "memberShotCoordinateFix": corrected.get("memberShotCoordinateFix"),
                "excludeFromZones": corrected.get("excludeFromZones") or [],
            }
            plan.append({"stem": stem, "source": "overturned-corrected", "zone_specs": specs, "extra": extra})
        elif vv == "uncertain":
            skipped.append((stem, f"uncertain: {(vm.get('why') or '')[:200]}"))
        else:
            skipped.append((stem, f"unrecognized verify verdict {vv!r}"))

    return plan, skipped


def check_and_prepare(stem: str, zone_specs, extra: dict, doc: dict):
    """Read-only validation against the in-memory doc. Returns
    (errors, cleaned_specs, coord_fix, all_dropped, caveats); nothing is
    mutated here — caveats records the NEWSHOT_DROP/SHOT_FIELD_STRIP
    overrides actually exercised, for the final report."""
    errors = []
    caveats = []
    existing_ids = {s["id"] for s in doc.get("shots", [])}
    existing_zone_ids = {z["id"] for z in (doc.get("playfields") or [])}

    all_new_ids = set()
    for _zone, _members, news in zone_specs:
        for ns in news:
            if (stem, ns.get("id")) in NEWSHOT_DROP:
                continue  # never resolvable — dropped before it would be written
            if ns["id"] in all_new_ids:
                errors.append(f"newShot id {ns['id']!r} proposed twice for this machine")
            all_new_ids.add(ns["id"])

    all_member_ids = set()
    zone_ids_this_run = set()
    cleaned_specs = []  # (clean_zone_dict, members, cleaned_newshots)
    all_dropped = []

    for zone, members, news in zone_specs:
        zid = zone.get("id")
        if not zid:
            errors.append("zone missing 'id'")
            continue
        if zid in existing_zone_ids:
            errors.append(f"zone id {zid!r} already exists in playfields[] — NEVER overwrite, refusing")
        if zid in zone_ids_this_run:
            errors.append(f"zone id {zid!r} proposed twice in this same apply")
        zone_ids_this_run.add(zid)

        cz, dropped = clean_zone(zone)
        if dropped:
            all_dropped.extend(f"playfields[{zid}].{d}" for d in dropped)
        override = ZONE_NAME_OVERRIDES.get((stem, zid))
        if override:
            cz["name"] = override
        if cz.get("kind") not in ("upper", "mini", "lower"):
            errors.append(f"zone {zid!r} kind {cz.get('kind')!r} is not upper/mini/lower")
        b = cz.get("bounds") or {}

        for mid in members:
            if mid not in existing_ids:
                errors.append(f"memberShot {mid!r} (zone {zid!r}) does not resolve to an existing shot")
                continue
            all_member_ids.add(mid)
            existing_shot = next(s for s in doc["shots"] if s["id"] == mid)
            if existing_shot.get("playfield") not in (None, zid):
                errors.append(f"memberShot {mid!r} already has playfield {existing_shot.get('playfield')!r} set — NEVER overwrite, refusing")
            x, y = existing_shot.get("x"), existing_shot.get("y")
            fix = ((extra.get("memberShotCoordinateFix") or {}).get("shots") or {}).get(mid)
            if fix:
                x, y = fix.get("x", x), fix.get("y", y)
            if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                if not (b.get("x", 0) - ZONE_EPS <= x <= b.get("x", 0) + b.get("w", 0) + ZONE_EPS
                        and b.get("y", 0) - ZONE_EPS <= y <= b.get("y", 0) + b.get("h", 0) + ZONE_EPS):
                    errors.append(f"memberShot {mid!r} ({x},{y}) lies outside zone {zid!r} bounds (±{ZONE_EPS}) even after any coordinate fix")

        cleaned_news = []
        for ns in news:
            nid = ns.get("id")
            if not nid:
                errors.append(f"a newShot for zone {zid!r} is missing 'id'")
                continue
            if (stem, nid) in NEWSHOT_DROP:
                caveats.append(f"newShot {nid!r} DROPPED — see NEWSHOT_DROP in p2-apply.py for the reviewed reason")
                continue
            if nid in existing_ids:
                errors.append(f"newShot id {nid!r} collides with an existing shot id — NEVER overwrite, refusing")
                continue
            cs, dropped_s = clean_shot(ns)
            for f in SHOT_FIELD_STRIP.get((stem, nid), ()):
                if f in cs:
                    del cs[f]
                    caveats.append(f"newShot {nid!r} field {f!r} STRIPPED — see SHOT_FIELD_STRIP in p2-apply.py for the reviewed reason")
            if dropped_s:
                all_dropped.extend(f"shots[+{nid}].{d}" for d in dropped_s)
            if cs.get("playfield") != zid:
                errors.append(f"newShot {nid!r} playfield={cs.get('playfield')!r} does not match its own zone id {zid!r}")
            x, y = cs.get("x"), cs.get("y")
            if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                if not (b.get("x", 0) - ZONE_EPS <= x <= b.get("x", 0) + b.get("w", 0) + ZONE_EPS
                        and b.get("y", 0) - ZONE_EPS <= y <= b.get("y", 0) + b.get("h", 0) + ZONE_EPS):
                    errors.append(f"newShot {nid!r} ({x},{y}) lies outside its own zone {zid!r} bounds (±{ZONE_EPS})")
            cleaned_news.append(cs)

        for eid in (cz.get("entries") or []):
            if eid not in existing_ids:
                errors.append(f"zone {zid!r} entries references unknown shot {eid!r}")
        for ex in (cz.get("exits") or []) or []:
            if isinstance(ex, dict) and ex.get("shot"):
                sid = ex["shot"]
                if sid not in existing_ids and sid not in all_new_ids:
                    errors.append(f"zone {zid!r} exits references unknown shot {sid!r}")

        cleaned_specs.append((cz, members, cleaned_news))

    exclude = set(extra.get("excludeFromZones") or [])
    contradiction = exclude & (all_member_ids | all_new_ids)
    if contradiction:
        errors.append(f"excludeFromZones {sorted(contradiction)} ended up assigned to a zone anyway — contradiction, refusing")

    coord_fix = (extra.get("memberShotCoordinateFix") or {}).get("shots") or {}
    for sid in coord_fix:
        if sid not in existing_ids:
            errors.append(f"memberShotCoordinateFix references unknown shot {sid!r}")
        elif sid not in all_member_ids:
            errors.append(f"memberShotCoordinateFix targets {sid!r} which is not a memberShot of any proposed zone here")

    return errors, cleaned_specs, coord_fix, all_dropped, caveats


def apply_mutations(doc: dict, cleaned_specs, coord_fix: dict):
    zone_ids, new_shot_ids, member_ids = [], [], []
    playfields = doc.setdefault("playfields", [])
    for cz, members, cleaned_news in cleaned_specs:
        playfields.append(cz)
        zone_ids.append(cz["id"])
        for mid in members:
            shot = next(s for s in doc["shots"] if s["id"] == mid)
            shot["playfield"] = cz["id"]
            member_ids.append(mid)
        for cs in cleaned_news:
            doc["shots"].append(cs)
            new_shot_ids.append(cs["id"])
    for sid, coords in coord_fix.items():
        shot = next(s for s in doc["shots"] if s["id"] == sid)
        if "x" in coords:
            shot["x"] = coords["x"]
        if "y" in coords:
            shot["y"] = coords["y"]
    return zone_ids, new_shot_ids, member_ids


def run_validator() -> tuple[int, str]:
    val = subprocess.run([sys.executable, str(VALIDATE)], capture_output=True, text=True, cwd=ROOT)
    return val.returncode, val.stdout + val.stderr


def main() -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    plan, skipped = build_plan()

    print(f"P2 apply: {len(plan)} machines planned, {len(skipped)} skipped (of {len(plan) + len(skipped)} researched)")
    print()

    applied_out, failed_out = [], []
    dropped_keys_seen: list[str] = []
    caveats_seen: list[str] = []

    for item in plan:
        stem = item["stem"]
        data_file = DATA / f"{stem}.json"
        if not data_file.exists():
            failed_out.append({"stem": stem, "errors": [f"data file {data_file.name} does not exist"]})
            print(f"  FAIL   {stem}: data file missing")
            continue

        raw = data_file.read_text(encoding="utf-8")
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError as exc:
            failed_out.append({"stem": stem, "errors": [f"invalid JSON: {exc}"]})
            print(f"  FAIL   {stem}: invalid JSON")
            continue

        if dump(doc) != raw:
            failed_out.append({"stem": stem, "errors": ["round-trip no-op self-test failed — refusing to touch this file"]})
            print(f"  FAIL   {stem}: round-trip self-test failed")
            continue

        errors, cleaned_specs, coord_fix, dropped, caveats = check_and_prepare(stem, item["zone_specs"], item["extra"], doc)
        if dropped:
            dropped_keys_seen.extend(f"{stem}:{d}" for d in dropped)
        if caveats:
            caveats_seen.extend(f"{stem}: {c}" for c in caveats)
        if errors:
            failed_out.append({"stem": stem, "errors": errors})
            print(f"  FAIL   {stem}: {len(errors)} referential/containment error(s)")
            for e in errors:
                print(f"           - {e}")
            continue

        zone_ids = [cz["id"] for cz, _m, _n in cleaned_specs]
        if args.dry_run:
            nmembers = sum(len(m) for _cz, m, _n in cleaned_specs)
            nnew = sum(len(n) for _cz, _m, n in cleaned_specs)
            print(f"  PLAN   {stem} [{item['source']}] zones={zone_ids} members={nmembers} newShots={nnew}")
            applied_out.append({"stem": stem, "zones": zone_ids, "newShots": [], "members": [], "source": item["source"], "dry_run": True})
            continue

        # --- real write path -------------------------------------------------
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(data_file, BACKUP_DIR / data_file.name)

        zone_ids, new_shot_ids, member_ids = apply_mutations(doc, cleaned_specs, coord_fix)
        data_file.write_text(dump(doc), encoding="utf-8")

        rc, out = run_validator()
        stem_file = f"{stem}.json"
        stem_errors = [l for l in out.splitlines() if l.startswith(f"ERROR {stem_file}:")]
        if rc != 0:
            all_errors = [l for l in out.splitlines() if l.startswith("ERROR ")]
            errs = stem_errors or all_errors or [f"validate-machines.py exited {rc} with no ERROR lines captured"]
            shutil.copy2(BACKUP_DIR / data_file.name, data_file)
            failed_out.append({"stem": stem, "errors": errs})
            print(f"  FAIL   {stem}: validator red post-write, ROLLED BACK. {len(errs)} error(s):")
            for e in errs:
                print(f"           - {e}")
            continue

        entry = {
            "stem": stem, "zones": zone_ids, "newShots": new_shot_ids, "members": member_ids,
            "source": item["source"],
        }
        if coord_fix:
            entry["coordinateFixApplied"] = sorted(coord_fix.keys())
        if item["extra"].get("excludeFromZones"):
            entry["excludeFromZones_honored"] = item["extra"]["excludeFromZones"]
        if caveats:
            entry["caveats"] = caveats
        applied_out.append(entry)
        print(f"  OK     {stem} [{item['source']}] zones={zone_ids} members={len(member_ids)} newShots={len(new_shot_ids)}")

    skipped_out = [{"stem": s, "why": w} for s, w in skipped]

    print()
    print(f"applied={len(applied_out)} skipped={len(skipped_out)} failed={len(failed_out)}  (total researched={len(applied_out)+len(skipped_out)+len(failed_out)})")
    if dropped_keys_seen:
        print(f"non-schema keys stripped before writing ({len(dropped_keys_seen)}):")
        for d in dropped_keys_seen:
            print(f"  - {d}")
    else:
        print("non-schema keys stripped before writing: none")
    if caveats_seen:
        print(f"reviewed overrides exercised (NEWSHOT_DROP / SHOT_FIELD_STRIP, {len(caveats_seen)}):")
        for c in caveats_seen:
            print(f"  - {c}")

    if args.dry_run:
        print("\ndry-run: no writes, no output file")
        return 0

    BIZ.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(
        {"applied": applied_out, "skipped": skipped_out, "failed": failed_out},
        indent=2, ensure_ascii=False,
    ) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")

    return 1 if failed_out else 0


if __name__ == "__main__":
    sys.exit(main())
