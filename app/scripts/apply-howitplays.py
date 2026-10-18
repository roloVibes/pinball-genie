#!/usr/bin/env python3
"""Apply schema v9 `howItPlays` to registered machine datasets — the guarded
writer for the HOW IT PLAYS content program (plan: this-is-for-pinball-staged-kahan.md).

THE STANDARD THIS FOLLOWS is apply-altmode.py's (v7) / apply-actionbutton.py's (v6):
a guarded script, never hand edits, and REFUSAL IS THE CORRECT OUTCOME whenever the
inputs are ambiguous. Every guard below aborts the WHOLE run before the first byte is
written — there is no partially-applied state to clean up.

WHY EACH GUARD EXISTS (each one is a defect a prior applier shipped without it):
- round-trip byte gate: a file that does not reproduce through the canonical dump has
  hidden float/indent drift; writing it would make every later diff unreadable, so it
  is refused, not normalised.
- REFUSE if `howItPlays` already present: deliberately NOT idempotent (like v7/v8). A
  second apply over an authored field would silently overwrite hand-fixes; the supported
  repeat path is `git checkout data/` or restore-from-backup, then re-apply.
- `actionButton` must be the LAST top-level key: the field is appended after it, so the
  only textual change is one `}`→`},` on the actionButton close plus the new block. If
  actionButton is not last, the diff stops being a pure addition and the textual proof
  can no longer certify it.
- canonical key order is IMPOSED, not trusted: the written field is built key-by-key in
  models.ts order (authors' key order is irrelevant), so the structural proof only has to
  certify that stripping the key reproduces the original.
- free `{x,y,name}` lamps are refused unless --allow-free-lamps AND the result names an
  existing placementArtifact: invented coordinates are the one failure the honesty rule
  cannot survive (a lamp drawn where no shot attests it). The content program authors
  {shot} sites only; free lamps ride a photo-placement pass (Iron Man).
- INTERNAL_TERMS + PROVENANCE_TERMS over every player-facing string: this data is rendered
  on public guide pages, where gen-guides' assertNoProvenance would fail the BUILD; catch
  it here where the fix is cheap. Both lists are copied verbatim from their sources.

AND THE PROOF, run after the writes and again on --verify:
- STRUCTURAL: strip `howItPlays` back out of the written document and it must compare equal
  to the original INCLUDING KEY ORDER (a plain == on dicts ignores order; this walks it).
- TEXTUAL: `git diff -U0` for each file must contain only the one `}`→`},` rewrite on the
  actionButton close plus the added `"howItPlays": {` … block — nothing else.
- Then `validate-machines.py` must exit 0, or every written file is restored from the
  backup and the run exits 1.

Run:
  python3 app/scripts/apply-howitplays.py --results _Business/HOWITPLAYS/results \
      --machines _Business/HOWITPLAYS/waves/wave-1.json \
      --backup scratchpad/data-backup-howitplays-wave1-YYYYMMDD [--dry-run] [--verify] [--allow-free-lamps]
"""

import argparse
import datetime
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# Copied verbatim from app/scripts/validate-machines.py (2026-08-15 revision, incl.
# service manual|confirmed by|coil chart). Kept in step with that file by hand.
INTERNAL_TERMS = re.compile(
    r"rulesBrief|rulesheet|tiltforums|pinside"
    r"|according to (?:the )?(?:rulesheet|sources?|players?|the community|tiltforums|pinside|the wiki|reports?)"
    r"|sources? say"
    r"|the community (?:says|reports|believes|agrees|considers)"
    r"|per competitive notes|guides describe|every source agrees"
    r"|service manual|confirmed by|coil chart",
    re.IGNORECASE,
)

# Copied from app/scripts/gen-guides.mjs PROVENANCE_TERMS (word-boundary matched).
PROVENANCE_TERMS = [
    "tilt forums", "tiltforums", "rulesheet", "pinside", "kineticist", "ipdb",
    "fspa", "system-j", "sdpc", "uncorroborated", "community report",
    "community consensus", "attributed to", "a documented", "anecdotal",
    "per reports", "this dataset", "the dataset", "our dataset",
]
PROVENANCE_RE = re.compile(
    "|".join(r"\b" + re.escape(t) for t in PROVENANCE_TERMS), re.IGNORECASE)

# Canonical key orders — the models.ts declaration order. The written field is
# rebuilt in this order regardless of the result file's own ordering.
HIP_KEYS = ["objective", "loop", "lights", "laneChange", "laneChangeNote", "scoring"]
GROUP_KEYS = ["id", "name", "kind", "sites", "lit", "flashing", "control", "then", "goals"]
CONTROL_KEYS = ["input", "effect", "when"]
SITE_SHOT_KEYS = ["shot", "lamps"]
SITE_FREE_KEYS = ["x", "y", "name"]
SCORING_KEYS = ["tier", "text", "goals"]

# Research-only result keys (evidence, openQuestions, sourceTier, placementArtifact,
# machine) are SIBLINGS of howItPlays and excluded by construction — only the
# howItPlays object is ever extracted. A research key mistakenly NESTED inside
# howItPlays is caught by unknown_nested_keys() below and refused.


def canon_dump(doc):
    return json.dumps(doc, indent=2, ensure_ascii=True) + "\n"


def reorder(d, order):
    """A new dict with `order` keys first (when present), then any extras in
    their original order — so an unexpected key is preserved for the validator
    to reject rather than silently dropped."""
    out = {}
    for k in order:
        if k in d:
            out[k] = d[k]
    for k in d:
        if k not in out:
            out[k] = d[k]
    return out


def build_canonical_hip(raw):
    """Rebuild howItPlays in models.ts key order. Does not validate — that is the
    validator's job post-write; this only imposes deterministic ordering so the
    structural/textual proofs mean something."""
    hip = reorder(raw, HIP_KEYS)
    groups = []
    for g in hip.get("lights", []) or []:
        if not isinstance(g, dict):
            groups.append(g)
            continue
        g = reorder(g, GROUP_KEYS)
        sites = []
        for s in g.get("sites", []) or []:
            if isinstance(s, dict) and "shot" in s:
                sites.append(reorder(s, SITE_SHOT_KEYS))
            elif isinstance(s, dict):
                sites.append(reorder(s, SITE_FREE_KEYS))
            else:
                sites.append(s)
        g["sites"] = sites
        if isinstance(g.get("control"), dict):
            g["control"] = reorder(g["control"], CONTROL_KEYS)
        groups.append(g)
    hip["lights"] = groups
    hip["scoring"] = [reorder(s, SCORING_KEYS) if isinstance(s, dict) else s
                      for s in hip.get("scoring", []) or []]
    return hip


def unknown_nested_keys(hip):
    """Every key inside howItPlays that is not in the models.ts contract. A typo'd
    optional key (e.g. "flashng") would otherwise ship as a dead key while its
    intended value silently vanishes — the applier refuses rather than warn."""
    out = []
    for k in set(hip.keys()) - set(HIP_KEYS):
        out.append(("howItPlays", k))
    for i, g in enumerate(hip.get("lights", []) or []):
        if not isinstance(g, dict):
            continue
        for k in set(g.keys()) - set(GROUP_KEYS):
            out.append((f"lights[{i}]", k))
        ctrl = g.get("control")
        if isinstance(ctrl, dict):
            for k in set(ctrl.keys()) - set(CONTROL_KEYS):
                out.append((f"lights[{i}].control", k))
        for j, s in enumerate(g.get("sites", []) or []):
            if not isinstance(s, dict):
                continue
            allowed = set(SITE_SHOT_KEYS) if "shot" in s else set(SITE_FREE_KEYS)
            for k in set(s.keys()) - allowed:
                out.append((f"lights[{i}].sites[{j}]", k))
    for i, st in enumerate(hip.get("scoring", []) or []):
        if isinstance(st, dict):
            for k in set(st.keys()) - set(SCORING_KEYS):
                out.append((f"scoring[{i}]", k))
    return out


def hip_player_strings(hip):
    """Yield (loc, text) for every player-facing string — the same set the
    validator routes through INTERNAL_TERMS."""
    if isinstance(hip.get("objective"), str):
        yield "objective", hip["objective"]
    for i, line in enumerate(hip.get("loop", []) or []):
        if isinstance(line, str):
            yield f"loop[{i}]", line
    if isinstance(hip.get("laneChangeNote"), str):
        yield "laneChangeNote", hip["laneChangeNote"]
    for i, g in enumerate(hip.get("lights", []) or []):
        if not isinstance(g, dict):
            continue
        for key in ("name", "lit", "flashing", "then"):
            if isinstance(g.get(key), str):
                yield f"lights[{i}].{key}", g[key]
        ctrl = g.get("control")
        if isinstance(ctrl, dict):
            for key in ("effect", "when"):
                if isinstance(ctrl.get(key), str):
                    yield f"lights[{i}].control.{key}", ctrl[key]
        for j, s in enumerate(g.get("sites", []) or []):
            if isinstance(s, dict) and "shot" not in s and isinstance(s.get("name"), str):
                yield f"lights[{i}].sites[{j}].name", s["name"]
    for i, step in enumerate(hip.get("scoring", []) or []):
        if isinstance(step, dict) and isinstance(step.get("text"), str):
            yield f"scoring[{i}].text", step["text"]


def strip_key_order_equal(a, b):
    """True iff a and b are structurally equal INCLUDING dict key order at every
    level (json.dumps with sort_keys=False captures insertion order)."""
    return json.dumps(a, ensure_ascii=True) == json.dumps(b, ensure_ascii=True)


def git_diff_is_pure_addition(rel_path):
    """The only change may be the actionButton close gaining a comma plus the
    added howItPlays block. Returns (ok, detail)."""
    r = subprocess.run(["git", "diff", "-U0", "--", rel_path],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        return False, f"git diff failed: {r.stderr[:200]}"
    lines = r.stdout.splitlines()
    hunks = [l for l in lines if l.startswith("@@")]
    removed = [l[1:] for l in lines if l.startswith("-") and not l.startswith("---")]
    added = [l[1:] for l in lines if l.startswith("+") and not l.startswith("+++")]
    # Appending a key to a JSON object is a PURE INSERTION under git's minimal
    # diff: it reuses the trailing `}`/`}` braces and shows 0 removed lines, with
    # the first added line being the previous last-key close gaining a comma
    # (`  }` -> `  },`). Some trees instead show that one line as a -/+ pair.
    # Either way there is exactly one hunk, at most one removed line, and the
    # added block is the actionButton-comma line plus the howItPlays object.
    if len(hunks) != 1:
        return False, f"expected exactly 1 hunk, got {len(hunks)}"
    if len(removed) > 1:
        return False, f"expected 0 or 1 removed lines, got {len(removed)}"
    if len(removed) == 1 and (removed[0] + ",") not in added:
        return False, "removed line does not reappear with a trailing comma"
    first = next((a for a in added if a.strip()), "")
    if first.strip() != "},":
        return False, ("first added line is %r, expected the actionButton close with a trailing comma" % first.strip())
    if not any('"howItPlays"' in a for a in added):
        return False, "no howItPlays block in the diff"
    return True, f"+{len(added)}/-{len(removed)}, 1 hunk"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--machines", required=True, help="JSON array of catalog ids (the wave)")
    ap.add_argument("--backup", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true", help="re-run the proofs on the current files, write nothing")
    ap.add_argument("--allow-free-lamps", action="store_true")
    args = ap.parse_args()

    results_dir = pathlib.Path(args.results)
    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    by_id = {e["id"]: e for e in catalog}
    wave = json.loads(pathlib.Path(args.machines).read_text(encoding="utf-8"))
    if not isinstance(wave, list) or not wave:
        sys.exit("--machines must be a non-empty JSON array of catalog ids")

    if args.verify:
        problems = []
        for mid in wave:
            if mid not in by_id:
                problems.append(f"{mid}: not a catalog id")
                continue
            target = DATA / f"{by_id[mid]['resource']}.json"
            doc = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {}
            if "howItPlays" not in doc:
                problems.append(f"{mid}: howItPlays not present")
        vr = subprocess.run(["python3", "app/scripts/validate-machines.py"],
                           cwd=ROOT, capture_output=True, text=True)
        for m in problems:
            print("  " + m)
        if problems or vr.returncode != 0:
            if vr.returncode != 0:
                print(f"  validate-machines.py exit {vr.returncode}")
            sys.exit(1)
        print(f"verify: all {len(wave)} machine(s) carry howItPlays; validator exit 0")
        return

    refusals = []
    plan = []  # (mid, entry, target_path, original_doc, canonical_hip)

    # ---- Guards, ALL before any write ----
    seen = set()
    for mid in wave:
        if mid in seen:
            refusals.append((mid, "duplicate id in the wave"))
            continue
        seen.add(mid)
        if mid not in by_id:
            refusals.append((mid, "not a catalog id"))
            continue
        res_path = results_dir / f"{mid}.json"
        if not res_path.exists():
            refusals.append((mid, f"no result file {res_path}"))
            continue
        result = json.loads(res_path.read_text(encoding="utf-8"))
        raw_hip = result.get("howItPlays")
        if not isinstance(raw_hip, dict):
            refusals.append((mid, "result has no howItPlays object"))
            continue

        entry = by_id[mid]
        target = DATA / f"{entry['resource']}.json"
        if not target.exists():
            refusals.append((mid, f"dataset {target.name} missing"))
            continue
        raw_text = target.read_text(encoding="utf-8")
        doc = json.loads(raw_text)
        if canon_dump(doc) != raw_text:
            refusals.append((mid, "dataset does not round-trip through the canonical dump"))
            continue
        if "howItPlays" in doc:
            refusals.append((mid, "dataset already carries howItPlays (non-idempotent; restore backup to redo)"))
            continue
        keys = list(doc.keys())
        if keys and keys[-1] != "actionButton":
            refusals.append((mid, f"actionButton is not the last key (last is {keys[-1]!r})"))
            continue

        hip = build_canonical_hip(raw_hip)

        extra = unknown_nested_keys(hip)
        if extra:
            refusals.append((mid, "unknown key(s): " + ", ".join(f"{loc}.{k}" for loc, k in extra[:5])))
            continue

        # free-lamp policy
        free_sites = [(i, j) for i, g in enumerate(hip.get("lights", []) or [])
                      if isinstance(g, dict)
                      for j, s in enumerate(g.get("sites", []) or [])
                      if isinstance(s, dict) and "shot" not in s]
        if free_sites:
            art = result.get("placementArtifact")
            if not args.allow_free_lamps:
                refusals.append((mid, f"{len(free_sites)} free lamp(s) without --allow-free-lamps"))
                continue
            if not art or not (ROOT / art).exists():
                refusals.append((mid, "free lamps require an existing placementArtifact"))
                continue

        # provenance / internal-term scan over player-facing strings
        term_hit = None
        for loc, text in hip_player_strings(hip):
            m = INTERNAL_TERMS.search(text)
            if m:
                term_hit = f"{loc}: internal term {m.group(0)!r}"
                break
            m = PROVENANCE_RE.search(text)
            if m:
                term_hit = f"{loc}: provenance term {m.group(0)!r}"
                break
        if term_hit:
            refusals.append((mid, term_hit))
            continue

        plan.append((mid, entry, target, doc, hip))

    if refusals:
        print("REFUSED (nothing written):")
        for mid, why in refusals:
            print(f"  {mid:28s} {why}")
        # A wave is applied whole or not at all — a partial apply would make the
        # textual proof span an inconsistent tree.
        sys.exit(1)

    if args.dry_run:
        print("DRY RUN — would write:")
        for mid, entry, target, doc, hip in plan:
            lc = hip.get("laneChange")
            print(f"  {mid:28s} {target.name}: {len(hip.get('lights', []))} groups, laneChange={lc}")
        return

    # ---- Backup, then write ----
    backup = pathlib.Path(args.backup)
    if backup.exists() and any(backup.iterdir()):
        sys.exit(f"--backup dir {backup} exists and is non-empty; choose a fresh path")
    backup.mkdir(parents=True, exist_ok=True)
    for path in DATA.glob("*_goals.json"):
        (backup / path.name).write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    (backup / "catalog.json").write_text((DATA / "catalog.json").read_text(encoding="utf-8"), encoding="utf-8")

    written = []
    report_files = []
    for mid, entry, target, doc, hip in plan:
        original = json.loads(target.read_text(encoding="utf-8"))
        new_doc = dict(doc)
        new_doc["howItPlays"] = hip  # appended last
        target.write_text(canon_dump(new_doc), encoding="utf-8")
        written.append(target)

        # STRUCTURAL proof
        check = json.loads(target.read_text(encoding="utf-8"))
        stripped = {k: v for k, v in check.items() if k != "howItPlays"}
        if not strip_key_order_equal(stripped, original):
            _restore(backup, written)
            sys.exit(f"STRUCTURAL proof failed for {mid} — restored backup")
        # TEXTUAL proof
        ok, detail = git_diff_is_pure_addition(str(target.relative_to(ROOT)))
        if not ok:
            _restore(backup, written)
            sys.exit(f"TEXTUAL proof failed for {mid}: {detail} — restored backup")
        report_files.append({"resource": entry["resource"], "added": True,
                             "groups": len(hip.get("lights", [])),
                             "laneChange": hip.get("laneChange"), "diff": detail})

    # ---- Validator gate ----
    vr = subprocess.run(["python3", "app/scripts/validate-machines.py"],
                       cwd=ROOT, capture_output=True, text=True)
    if vr.returncode != 0:
        tail = "\n".join((vr.stdout + vr.stderr).splitlines()[-8:])
        _restore(backup, written)
        sys.exit(f"validate-machines.py exit {vr.returncode} — restored backup:\n{tail}")

    summary = (vr.stdout + vr.stderr).splitlines()[-1] if vr.stdout else ""
    report = {
        "wave": pathlib.Path(args.machines).stem,
        "date": datetime.datetime.now().isoformat(timespec="seconds"),
        "files": report_files,
        "backup": str(backup),
        "validator": {"exit": vr.returncode, "summary": summary},
    }
    apply_dir = ROOT / "_Business" / "HOWITPLAYS" / "apply"
    apply_dir.mkdir(parents=True, exist_ok=True)
    out = apply_dir / f"{report['wave']}.json"
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"APPLIED {len(written)} machine(s); validator: {summary}")
    print(f"report: {out}")



def _restore(backup, written):
    for path in written:
        b = backup / path.name
        if b.exists():
            path.write_text(b.read_text(encoding="utf-8"), encoding="utf-8")


if __name__ == "__main__":
    main()
