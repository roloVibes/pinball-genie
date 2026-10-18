#!/usr/bin/env python3
"""Structural validator for data/*_goals.json and data/catalog.json.

WHY THIS EXISTS (2026-07-31). The catalog-wide accuracy audit found a ~19% error
rate in *content*, but content errors are the expensive kind to catch — they need
sources. What this script catches instead is the cheap kind that nonetheless
breaks the app at runtime and is invisible in review: a goal step pointing at a
shot id that does not exist, a category the UI has no metadata for, an
achievement whose `goal` was renamed, a machine present in data/ but missing
from catalog.json (so it never appears), a coordinate outside the unit square
(so it renders off the playfield).

Every one of those ships silently — Vite does not read these files, tsc does not
type them, and the map just draws nothing where the shot should be.

Run:  python3 app/scripts/validate-machines.py
Exit: 0 clean, 1 if any ERROR. Warnings never fail the run.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# Mirrors GoalCategory in app/src/models.ts and CATEGORY_META in ui/goalMeta.ts.
# A category outside this set renders with no icon and no section heading.
CATEGORIES = {
    "skillshot", "combo", "multiball", "mode", "multiplier",
    "wizard", "strategy", "secret", "progression",
}
TIERS = {"easy", "medium", "hard", "epic"}
SOURCES = {"derived", "insider"}

# Mirrors AltMode in app/src/models.ts (dataset schema v7, 2026-08-14).
# NOT a requiredness rule — ABSENCE IS THE NORM, and is the positive statement
# that a goal is normal play rather than an alternative to it. Only the VALUE
# is checked: an unknown one would render as a chip saying nothing in the
# Study tab's ALT MODES sheet and would silently pass every other gate.
ALT_MODES = {"video", "menu", "ruleset"}

# Mirrors LightKind / LightInput / laneChange / ScoringTier in app/src/models.ts
# (dataset schema v9). Closed vocabularies that must not drift: a kind outside
# LIGHT_KINDS renders with no icon, an input outside LIGHT_INPUTS breaks the
# control chip, and a scoring tier outside order breaks the scoring sheet.
LIGHT_KINDS = {"shot-arrow", "letters", "ladder", "lanes", "multiplier", "status", "mode"}
LIGHT_INPUTS = {"left-flipper", "right-flipper", "either-flipper", "both-flippers",
                "action-button", "plunger", "none"}
LANE_CHANGE = {"flippers", "action-button", "none", "unknown"}
SCORING_TIERS = ["ball-one", "building", "the-big-one"]  # order is the data contract

# --- Dataset schema v5 (2026-08-10, playfield-truth overhaul) ---------------
# Mirrors the doc comments in app/src/models.ts — the TS types are the prose
# authority; these sets are the mechanical mirror the data passes gate on.
ZONE_KINDS = {"upper", "mini", "lower"}
BAT_SIDES = {"left", "right"}
BAT_SIZES = {"full", "mini"}
TRIM_VALUES = {"all", "premium-le"}
# feedsByTrim keys are trim SELECTIONS (base `feeds` is already the Pro truth,
# so only 'premium-le' should ever appear in practice — 'pro' allowed for an
# explicit override-to-null shape).
FEED_TRIM_KEYS = {"pro", "premium-le"}
# Closed technique vocabulary (GoalStep.technique). Plunge strength is NOT
# here on purpose: SOFT/FULL PLUNGE chips derive from plunge/plungeTo so the
# two can never disagree.
TECHNIQUES = {
    "backhand", "forehand", "on-the-fly", "from-cradle", "early-flip",
    "late-flip", "hold-flipper", "drop-catch", "live-catch", "dead-bounce",
    "post-pass", "tap-pass", "nudge",
}
# Shot (x,y) may sit this far outside its declared playfield's bounds before
# it errors — bounds are authored to the deck's visible plate, and a shot dot
# can legitimately ride the plate's edge.
ZONE_EPS = 0.02

# The seven datasets that exist in data/ but are DELIBERATELY not in
# catalog.json (shelved; whether to ship them is rolo's product decision —
# see the plan's out-of-scope list). They flow through every check in this
# file like any other machine; only the catalog-presence rule downgrades to a
# warning for them. A NEW unregistered file is still an ERROR — this list is
# an inventory of known intent, not a hole in the gate.
KNOWN_UNREGISTERED = {
    "jurassic_park_data_east_goals", "ripleys_believe_it_or_not_goals",
    "rollercoaster_tycoon_goals", "star_wars_data_east_goals",
    "street_fighter_ii_goals", "terminator_3_goals", "x_men_stern_2012_goals",
}

# Mirrors NEW_CATEGORIES in app/tests/pathless-goals.test.mjs. Only these two
# categories are allowed to have `steps: []`.
PATHLESS_CATEGORIES = {"secret", "progression"}

# Strings that must NEVER reach a player. `rulesBrief` is an INTERNAL field name from the
# data pipeline; it leaked into three Baywatch strings and shipped live (found 2026-08-01).
# The rest are research/sourcing voice — the app speaks to a player standing at a machine,
# never about where the information came from. URLs inside sources[] are exempt: that array
# is never rendered (gen-guides.mjs drops it).
#
# Both "according to" and "the community" are ORDINARY ENGLISH as well as sourcing
# voice, so neither can be matched bare. Batman 66 legitimately says "1M to 1.2M
# according to how many arrows are lit" — meaning *depending on* — and Monopoly's
# "the Community Chest light" is a feature name. Each therefore requires a
# source-like object before it counts. (Same false-positive class already fixed in
# app/tests/pathless-goals.test.mjs; keep the two in step.)
# The 2026-08-15 additions — "service manual", "confirmed by", "coil chart" —
# close the hole two World Poker Tour flipper notes shipped through: research
# voice citing the DOCUMENT ("Confirmed by the Stern service manual's coil
# chart ('13 UPPER PF LEFT FLIPPER', 23-1100 ohm, 50v DC)…"). A player standing
# at the glass never needs to know which paperwork the fact came from.
# "confirmed by" is matched bare on purpose and "confirmed to exist" is NOT a
# hit: ac_dc/foo_fighters/game_of_thrones legitimately say a flipper is
# "confirmed to exist", which is about the MACHINE, not about a source. The one
# other pre-existing hit (night_moves' "confirmed by the manual, instruction
# card, and every collector source found") was the same defect and was fixed in
# the same commit rather than exempted.
INTERNAL_TERMS = re.compile(
    r"rulesBrief|rulesheet|tiltforums|pinside"
    r"|according to (?:the )?(?:rulesheet|sources?|players?|the community|tiltforums|pinside|the wiki|reports?)"
    r"|sources? say"
    r"|the community (?:says|reports|believes|agrees|considers)"
    r"|per competitive notes|guides describe|every source agrees"
    r"|service manual|confirmed by|coil chart",
    re.IGNORECASE,
)

# Both kebab- and snake_case are in use across the shipped machines and both
# work fine — these ids are only ever dictionary keys. The rule that matters is
# that they contain nothing needing escaping.
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

# ---------------------------------------------------------------------------
# Shot-text <-> shot-id consistency (added 2026-08-01).
#
# WHY: Elvira shipped a goal whose step said "Shoot the House Entrance…" while
# steps[].shot was `left_ramp` — app.ts renders the assigned shot's NAME as the
# label and map2d draws the arrow at the assigned shot's coordinates, so the
# player read one instruction and was pointed at a different shot. Text audits
# only catch this by luck; this check makes the mismatch mechanical.
#
# RULE: inside a step's `action`, find full shot-NAME phrases belonging to this
# machine's own shots (longest-first, matched spans masked so "Left Ramp" does
# not also count as a mention of a shot named "Ramp"). If exactly one OTHER
# shot is named, the assigned shot is not, and — after masking — none of the
# assigned shot's distinctive name tokens appear either, that is an ERROR.
# Mentions of two or more other shots are ignored: multi-shot phrasing
# ("either ramp, then the scoop") is normal and legitimate.
#
# Direction words alone are not distinctive, so they never rescue a mismatch:
# assigned "Right Ramp" does not escape just because the action says "left".
_GENERIC_NAME_TOKENS = {"left", "right", "center", "centre", "upper", "lower",
                        "top", "bottom", "side", "mini", "main", "the"}

# (filename, goal_id, step_index) triples exempted after evidence-based review —
# actions that legitimately name one other shot (consequence "…to light X", feed
# relationship "ramp delivers into X", or entry-vs-feature granularity). Every
# entry's sheet-quoted justification lives in
# _Business/LINT-TRIAGE-VERDICTS-2026-08-01.json — do not add entries without one.
SHOT_TEXT_ALLOW: set[tuple[str, str, int]] = {
    ("addams_family_goals.json", "strategy-rooms-before-vault", 3),
    ("big_hurt_goals.json", "catches", 0),
    ("bride_of_pinbot_goals.json", "strategy-tournament-line", 1),
    ("medieval_madness_goals.json", "wizard-royal", 0),
    ("party_zone_goals.json", "eat-drink-be-merry", 2),
    ("space_jam_goals.json", "full-court-frenzy", 0),
    ("space_jam_goals.json", "two-on-two-multiball", 0),
    ("space_station_goals.json", "bumper-value", 0),
    ("dr_dude_goals.json", "light-the-lock", 0),
    ("firepower_goals.json", "center-targets", 0),
    ("fish_tales_goals.json", "multiball-priorities", 2),
    ("fish_tales_goals.json", "stretch-the-truth", 0),
    ("flintstones_goals.json", "bowling-power-up", 1),
    ("game_of_thrones_goals.json", "spinner-ladder", 1),
    ("gameshow_goals.json", "extra-ball", 0),
    ("goldeneye_goals.json", "guard-targets", 2),
    ("goldeneye_goals.json", "virtual-locks", 0),
    ("goldeneye_goals.json", "virtual-locks", 2),
    ("guns_n_roses_goals.json", "snake-lanes", 1),
    ("james_bond_goals.json", "strat-build-to-7x", 2),
    ("jaws_goals.json", "smile-wizard", 4),
    ("jurassic_park_goals.json", "mode_trex_rampage", 0),
    ("metallica_goals.json", "combo-snake-multiball", 0),
    ("munsters_goals.json", "mb-grandpa-lab", 2),
    ("mustang_goals.json", "burnout-multiball", 1),
    ("nba_fastbreak_goals.json", "power-hoops", 0),
    ("no_fear_goals.json", "combo-payback-over-edge", 0),
    ("playboy_goals.json", "super-bonus-lockin", 0),
    ("popeye_goals.json", "save-the-animals", 0),
    ("roller_games_goals.json", "skate-targets", 2),
    ("rush_goals.json", "big-money-mode", 1),
    ("safe_cracker_goals.json", "sudden-death", 1),
    ("scared_stiff_goals.json", "beat-the-crate", 0),
    ("scared_stiff_goals.json", "monster-multiball", 0),
    ("surf_n_safari_goals.json", "arcade-value", 1),
    ("surf_n_safari_goals.json", "extra-ball-round", 0),
    # "left and right ramps" both-shots instruction; arrow anchors the first.
    ("tmnt_goals.json", "episode-pizza-o-meter", 0),
    ("terminator_2_goals.json", "payback-multiball-stack", 0),
    ("terminator_2_goals.json", "payback-multiball-stack", 1),
    ("white_water_goals.json", "extra-ball-two-ways", 0),
    ("white_water_goals.json", "mode-camera-craze", 2),
    ("white_water_goals.json", "strategy-5x-stack", 0),
    ("who_dunnit_goals.json", "phone-work", 0),
    ("world_cup_soccer_goals.json", "mb-build-and-lock", 1),
    ("world_cup_soccer_goals.json", "strat-best-opener-build-fast", 1),
}


def _norm_shot_text(s: str) -> str:
    s = s.lower().replace("·", " ")  # Pin·Bot style interpuncts
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return " ".join(s.split())


def check_shot_text(name: str, doc: dict) -> None:
    shot_names = {}
    for s in doc.get("shots", []):
        n = _norm_shot_text(s.get("name") or "")
        if s.get("id") and len(n) >= 4:
            shot_names[s["id"]] = n

    by_len = sorted(shot_names.items(), key=lambda kv: -len(kv[1]))
    for goal in doc.get("goals", []):
        for j, step in enumerate(goal.get("steps") or []):
            action = step.get("action")
            assigned = step.get("shot")
            if not action or not assigned or assigned not in shot_names:
                continue
            text = f" {_norm_shot_text(action)} "
            mentioned = []
            for sid, phrase in by_len:
                for variant in (f" {phrase} ", f" {phrase}s "):
                    if variant in text:
                        mentioned.append(sid)
                        text = text.replace(variant, " § ")
                        break
            if not mentioned or assigned in mentioned or len(mentioned) != 1:
                continue
            # Technique modifiers, not targets: "hold the left flipper and
            # plunge", "backhand from the right flipper". A flipper mention
            # never contradicts the arrow.
            if "flipper" in shot_names[mentioned[0]]:
                continue
            # Skill shots: the arrow correctly sits on the plunger/shooter
            # lane while the action names the destination the plunge should
            # reach ("plunge to the right orbit").
            if any(w in shot_names[assigned] or w in assigned
                   for w in ("plunger", "plunge", "shooter")):
                continue
            # masked-text escape: a distinctive token of the assigned shot's own
            # name still present means the action does talk about its shot.
            masked_words = {w.rstrip("s") for w in text.split()}
            assigned_toks = {t.rstrip("s") for t in shot_names[assigned].split()
                             if len(t) > 3 and t not in _GENERIC_NAME_TOKENS}
            if assigned_toks & masked_words:
                continue
            if (name, goal.get("id", ""), j) in SHOT_TEXT_ALLOW:
                continue
            other = mentioned[0]
            err(
                name,
                f"goals[{goal.get('id')}].steps[{j}] action names shot "
                f"{shot_names[other]!r} ({other}) but steps[].shot is {assigned!r} "
                f"({shot_names[assigned]}) — label/arrow will contradict the text",
            )

errors: list[str] = []
warnings: list[str] = []


def err(machine: str, msg: str) -> None:
    errors.append(f"{machine}: {msg}")


def warn(machine: str, msg: str) -> None:
    warnings.append(f"{machine}: {msg}")


def check_feedref(name: str, where: str, ref, shot_ids: set[str]) -> None:
    """FeedRef shape + resolution. An unresolvable `shot` is an ERROR here even
    though the renderer fail-softs it (treats the whole ref as absent): a feed
    that silently draws nothing is exactly the invisible-in-review defect this
    validator exists for (the street_fighter_ii right-ramp shipped that way)."""
    if ref is None:
        return
    if not isinstance(ref, dict):
        err(name, f"{where} feed ref must be an object, got {type(ref).__name__}")
        return
    sid = ref.get("shot")
    if sid is not None and sid not in shot_ids:
        err(name, f"{where} feed shot {sid!r} does not resolve to a shot id")
    for axis in ("x", "y"):
        v = ref.get(axis)
        if v is not None and (
            not isinstance(v, (int, float)) or not (0.0 <= v <= 1.0)
        ):
            err(name, f"{where} feed {axis}={v!r} outside the 0..1 playfield")
    lp = ref.get("loop")
    if lp is not None:
        if not isinstance(lp, dict):
            err(name, f"{where} feed loop must be an object")
        else:
            if lp.get("shot") is not None and lp["shot"] not in shot_ids:
                err(name, f"{where} feed loop shot {lp['shot']!r} does not resolve")
            for axis in ("x", "y"):
                w = lp.get(axis)
                if w is not None and (not isinstance(w, (int, float)) or not (0.0 <= w <= 1.0)):
                    err(name, f"{where} feed loop {axis}={w!r} outside the 0..1 playfield")


def _player_strings(doc: dict):
    """Yield (location, text) for every string a player can actually see."""
    for s in doc.get("shots", []):
        if s.get("notes"):
            yield f"shots[{s.get('id')}].notes", s["notes"]
    for g in doc.get("goals", []):
        for key in ("title", "summary", "reward"):
            if g.get(key):
                yield f"goals[{g.get('id')}].{key}", g[key]
        for i, st in enumerate(g.get("steps") or []):
            for key in ("action", "detail"):
                if st.get(key):
                    yield f"goals[{g.get('id')}].steps[{i}].{key}", st[key]
        for i, ins in enumerate(g.get("instructions") or []):
            yield f"goals[{g.get('id')}].instructions[{i}]", ins
    for a in doc.get("achievements", []):
        for key in ("title", "desc"):
            if a.get(key):
                yield f"achievements[{a.get('id')}].{key}", a[key]
    # Card + drills (schema v5) are player-facing too — same sourcing-voice
    # and IP rules as every other string a player can read.
    card = doc.get("card")
    if isinstance(card, dict):
        entries = [("card.skillShot", card.get("skillShot"))]
        for key in ("line", "safeShots", "dangerShots"):
            for i, e in enumerate(card.get(key) or []):
                entries.append((f"card.{key}[{i}]", e))
        for loc, e in entries:
            if isinstance(e, dict) and e.get("text"):
                yield loc, e["text"]
        for i, r in enumerate(card.get("reminders") or []):
            if isinstance(r, str):
                yield f"card.reminders[{i}]", r
    for d in doc.get("drills") or []:
        if isinstance(d, dict):
            for key in ("title", "text", "reps"):
                # Non-string values are a shape error the drills block reports;
                # this iterator must never crash the whole run on them.
                if d.get(key) and isinstance(d[key], str):
                    yield f"drills[{d.get('id')}].{key}", d[key]
    # Action button (schema v6) — every string here is rendered verbatim in
    # the Study tab, so it carries the same sourcing-voice/IP rules.
    ab = doc.get("actionButton")
    if isinstance(ab, dict):
        for key in ("label", "location", "how"):
            if ab.get(key) and isinstance(ab[key], str):
                yield f"actionButton.{key}", ab[key]
        for i, u in enumerate(ab.get("uses") or []):
            if isinstance(u, dict):
                for key in ("when", "what"):
                    if u.get(key) and isinstance(u[key], str):
                        yield f"actionButton.uses[{i}].{key}", u[key]

    # How it plays (schema v9) — same player-facing string rule: every
    # rendered string must pass the sourcing-voice and IP gates.
    hip = doc.get("howItPlays")
    if isinstance(hip, dict):
        if isinstance(hip.get("objective"), str) and hip["objective"].strip():
            yield "howItPlays.objective", hip["objective"]
        for i, line in enumerate(hip.get("loop") or []):
            if isinstance(line, str) and line.strip():
                yield f"howItPlays.loop[{i}]", line
        if isinstance(hip.get("laneChangeNote"), str) and hip["laneChangeNote"].strip():
            yield "howItPlays.laneChangeNote", hip["laneChangeNote"]
        for i, lg in enumerate(hip.get("lights") or []):
            if isinstance(lg, dict):
                for key in ("name", "lit", "then"):
                    if isinstance(lg.get(key), str) and lg[key].strip():
                        yield f"howItPlays.lights[{i}].{key}", lg[key]
                if isinstance(lg.get("flashing"), str) and lg["flashing"].strip():
                    yield f"howItPlays.lights[{i}].flashing", lg["flashing"]
                ctrl = lg.get("control")
                if isinstance(ctrl, dict):
                    if isinstance(ctrl.get("effect"), str) and ctrl["effect"].strip():
                        yield f"howItPlays.lights[{i}].control.effect", ctrl["effect"]
                    if isinstance(ctrl.get("when"), str) and ctrl["when"].strip():
                        yield f"howItPlays.lights[{i}].control.when", ctrl["when"]
                for j, site in enumerate(lg.get("sites") or []):
                    # Only free lamps carry a player-facing name; shot-anchored
                    # sites use the shot's own name, not a separate string.
                    if isinstance(site, dict) and "shot" not in site and isinstance(site.get("name"), str) and site["name"].strip():
                        yield f"howItPlays.lights[{i}].sites[{j}].name", site["name"]
        for i, step in enumerate(hip.get("scoring") or []):
            if isinstance(step, dict) and isinstance(step.get("text"), str) and step["text"].strip():
                yield f"howItPlays.scoring[{i}].text", step["text"]


def check_machine(path: pathlib.Path) -> None:
    name = path.name
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        err(name, f"invalid JSON — {exc}")
        return

    for key in ("machine", "shots", "goals"):
        if key not in doc:
            err(name, f"missing required key {key!r}")
            return

    shot_ids: set[str] = set()
    shots_by_id: dict[str, dict] = {}
    for i, shot in enumerate(doc["shots"]):
        where = f"shots[{i}]"
        for key in ("id", "name", "type", "x", "y"):
            if key not in shot:
                err(name, f"{where} missing {key!r}")
        sid = shot.get("id", "")
        if sid in shot_ids:
            err(name, f"{where} duplicate shot id {sid!r}")
        shot_ids.add(sid)
        if sid:
            shots_by_id.setdefault(sid, shot)
        if sid and not ID_RE.match(sid):
            err(name, f"{where} id {sid!r} is not lowercase-kebab")
        for axis in ("x", "y"):
            v = shot.get(axis)
            if isinstance(v, (int, float)) and not (0.0 <= v <= 1.0):
                err(name, f"{where} {axis}={v} outside the 0..1 playfield")
        if shot.get("trim") not in (None, "all", "premium-le"):
            warn(name, f"{where} unusual trim {shot.get('trim')!r}")

    # --- playfields[] (schema v5) ------------------------------------------
    zones: dict[str, dict] = {}
    pfs = doc.get("playfields")
    if pfs is not None and not isinstance(pfs, list):
        err(name, "playfields must be a list")
        pfs = None
    for i, z in enumerate(pfs or []):
        where = f"playfields[{i}]"
        if not isinstance(z, dict):
            err(name, f"{where} must be an object")
            continue
        for key in ("id", "name", "kind", "bounds"):
            if key not in z:
                err(name, f"{where} missing {key!r}")
        zid = z.get("id", "")
        if zid in zones:
            err(name, f"{where} duplicate playfield id {zid!r}")
        if zid and not ID_RE.match(zid):
            err(name, f"{where} id {zid!r} is not lowercase-kebab")
        if z.get("kind") not in ZONE_KINDS:
            err(name, f"{where} kind {z.get('kind')!r} is not upper/mini/lower")
        b = z.get("bounds")
        if isinstance(b, dict):
            if not all(isinstance(b.get(k), (int, float)) for k in ("x", "y", "w", "h")):
                err(name, f"{where} bounds needs numeric x/y/w/h")
                b = None
            else:
                if b["w"] <= 0 or b["h"] <= 0:
                    err(name, f"{where} bounds w/h must be > 0")
                if (b["x"] < 0 or b["y"] < 0
                        or b["x"] + b["w"] > 1.0 + 1e-9
                        or b["y"] + b["h"] > 1.0 + 1e-9):
                    err(name, f"{where} bounds leave the 0..1 playfield")
        elif b is not None:
            err(name, f"{where} bounds must be an object")
            b = None
        if z.get("trim") not in (None, *TRIM_VALUES):
            warn(name, f"{where} unusual trim {z.get('trim')!r}")
        for j, e in enumerate(z.get("entries") or []):
            if e not in shot_ids:
                err(name, f"{where}.entries[{j}] {e!r} does not resolve to a shot id")
        for j, x in enumerate(z.get("exits") or []):
            check_feedref(name, f"{where}.exits[{j}]", x, shot_ids)
        if zid:
            zones[zid] = {**z, "bounds": b}

    # Decks are physically distinct surfaces — overlapping bounds is the
    # Halloween bug class (House and Sanitarium colliding in the back strip).
    zlist = [(zid, z["bounds"]) for zid, z in zones.items() if isinstance(z.get("bounds"), dict)]
    for a in range(len(zlist)):
        for b2 in range(a + 1, len(zlist)):
            (ida, ba), (idb, bb) = zlist[a], zlist[b2]
            ox = min(ba["x"] + ba["w"], bb["x"] + bb["w"]) - max(ba["x"], bb["x"])
            oy = min(ba["y"] + ba["h"], bb["y"] + bb["h"]) - max(ba["y"], bb["y"])
            if ox > 0.005 and oy > 0.005:
                err(name, f"playfields {ida!r} and {idb!r} bounds overlap — decks are physically distinct surfaces")

    # --- shots second pass: v5 fields that need the full id set -------------
    for i, shot in enumerate(doc["shots"]):
        sid = shot.get("id", "")
        where = f"shots[{i}]({sid})"
        check_feedref(name, where, shot.get("feeds"), shot_ids)
        fbt = shot.get("feedsByTrim")
        if fbt is not None:
            if not isinstance(fbt, dict):
                err(name, f"{where} feedsByTrim must be an object")
            else:
                for k, v in fbt.items():
                    if k not in FEED_TRIM_KEYS:
                        err(name, f"{where} feedsByTrim key {k!r} is not one of {sorted(FEED_TRIM_KEYS)}")
                    check_feedref(name, f"{where}.feedsByTrim[{k}]", v, shot_ids)
        pf = shot.get("playfield")
        if pf is not None:
            if pf not in zones:
                err(name, f"{where} playfield {pf!r} does not resolve to a playfields[] id")
            else:
                b = zones[pf].get("bounds")
                x, y = shot.get("x"), shot.get("y")
                if (isinstance(b, dict) and isinstance(x, (int, float))
                        and isinstance(y, (int, float))
                        and not (b["x"] - ZONE_EPS <= x <= b["x"] + b["w"] + ZONE_EPS
                                 and b["y"] - ZONE_EPS <= y <= b["y"] + b["h"] + ZONE_EPS)):
                    err(name, f"{where} ({x}, {y}) lies outside its playfield {pf!r} bounds (±{ZONE_EPS})")
        bat = shot.get("bat")
        if bat is not None:
            if shot.get("type") != "flipper":
                warn(name, f"{where} bat on a non-flipper shot (type {shot.get('type')!r})")
            if not isinstance(bat, dict):
                err(name, f"{where} bat must be an object")
            else:
                if bat.get("side") not in (None, *BAT_SIDES):
                    err(name, f"{where} bat.side {bat.get('side')!r} is not left/right")
                if bat.get("size") not in (None, *BAT_SIZES):
                    err(name, f"{where} bat.size {bat.get('size')!r} is not full/mini")
        bh = shot.get("backhand")
        if bh is not None and (
            not isinstance(bh, list) or any(v not in BAT_SIDES for v in bh)
        ):
            err(name, f"{where} backhand must be a list of 'left'/'right'")
        # `flap` (models.ts Shot.flap): the footprint of a ramp plate the game
        # raises and lowers, w/h in UV CENTRED on the shot. map2d's
        # drawPlayfieldArt paints that rectangle as background furniture, so a
        # bad number here is a shape drawn over parts of the table the mech
        # does not occupy — the exact "the map quietly lies" failure the art
        # rewrite exists to prevent. Hence ERRORs, not warnings.
        flap = shot.get("flap")
        if flap is not None:
            if not isinstance(flap, dict):
                err(name, f"{where} flap must be an object")
            else:
                fw, fh = flap.get("w"), flap.get("h")
                if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (fw, fh)):
                    err(name, f"{where} flap needs numeric w/h")
                elif fw <= 0 or fh <= 0 or fw > 1 or fh > 1:
                    err(name, f"{where} flap w/h must be in (0, 1] — got w={fw}, h={fh}")
                else:
                    x, y = shot.get("x"), shot.get("y")
                    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and (
                        x - fw / 2 < -1e-9 or x + fw / 2 > 1 + 1e-9
                        or y - fh / 2 < -1e-9 or y + fh / 2 > 1 + 1e-9
                    ):
                        err(name, f"{where} flap footprint leaves the 0..1 playfield")
                if shot.get("type") != "ramp":
                    warn(name, f"{where} flap on a non-ramp shot (type {shot.get('type')!r})")
        # A flipper drawn inside a deck's footprint but not claimed by it will
        # anchor deck routes at the MAIN flippers — almost certainly a missing
        # playfield ref (P6 promotes this once the catalog is authored).
        if shot.get("type") == "flipper" and pf is None:
            x, y = shot.get("x"), shot.get("y")
            if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                for zid, z in zones.items():
                    b = z.get("bounds")
                    if (isinstance(b, dict)
                            and b["x"] <= x <= b["x"] + b["w"]
                            and b["y"] <= y <= b["y"] + b["h"]):
                        warn(name, f"{where} is a flipper inside playfield {zid!r} bounds but carries no playfield ref")

    goal_ids: set[str] = set()
    # Goal dependencies (dataset schema v8) — collected here, RESOLVED after the
    # loop. `requires` may legitimately name a goal defined further down the
    # file, so nothing can be resolved against `goal_ids` until every id is in
    # it. Keyed by index so a duplicate id still reports against its own entry.
    requires_by_goal: list[tuple[str, str, list]] = []  # (where, gid, requires)
    for i, goal in enumerate(doc["goals"]):
        where = f"goals[{i}]"
        for key in ("id", "title", "category", "summary", "steps"):
            if key not in goal:
                err(name, f"{where} missing {key!r}")
        gid = goal.get("id", "")
        if gid in goal_ids:
            err(name, f"{where} duplicate goal id {gid!r}")
        goal_ids.add(gid)
        if gid and not ID_RE.match(gid):
            err(name, f"{where} id {gid!r} is not lowercase-kebab")

        cat = goal.get("category")
        if cat not in CATEGORIES:
            err(name, f"{where} unknown category {cat!r}")

        # altMode (dataset schema v7) — VALUE ONLY, never presence. `null` is
        # accepted as an explicit "no flag" (models.ts types it `AltMode | null`
        # so an author can write the absence down); anything else is an error.
        # The isinstance test is not belt-and-braces: `["video"] not in <set>`
        # raises TypeError (unhashable), which would abort the whole run with a
        # traceback instead of failing this one machine — measured 2026-08-14.
        if "altMode" in goal and goal["altMode"] is not None:
            am = goal["altMode"]
            if not isinstance(am, str) or am not in ALT_MODES:
                err(name, f"{where} unknown altMode {am!r} "
                          f"(closed vocabulary: {'/'.join(sorted(ALT_MODES))} — see models.ts)")

        diff = goal.get("difficulty")
        if diff is not None and diff not in (1, 2, 3):
            err(name, f"{where} difficulty {diff!r} is not 1, 2 or 3")

        # Any-order rendering flags (2026-08-02): goal-level `ordered` must be
        # a boolean; per-step `link` must be 'route'/'none'. A wrong type here
        # silently renders as the default (ordered route), which is exactly
        # the misleading-lines defect the flag exists to fix.
        if "ordered" in goal and goal["ordered"] is not None and not isinstance(goal["ordered"], bool):
            err(name, f"{where} 'ordered' must be a boolean, got {goal['ordered']!r}")

        # --- Goal dependencies (dataset schema v8, 2026-08-15) --------------
        # SHAPE here; RESOLUTION/self-reference/cycles after the loop (see
        # requires_by_goal above for why they cannot be done in one pass).
        # A malformed `requires` is the quiet kind of wrong: the UI reads it
        # with `Array.isArray`, so a bare string or a list of objects renders
        # NO dependency line at all and the goal simply looks ungated.
        req = goal.get("requires")
        if req is not None:
            if not isinstance(req, list):
                err(name, f"{where} 'requires' must be a list of goal ids, got {req!r}")
            else:
                for r in req:
                    if not isinstance(r, str) or not r.strip():
                        err(name, f"{where} 'requires' entry {r!r} is not a goal id string")
                if len(set(req)) != len(req):
                    err(name, f"{where} 'requires' lists the same goal twice: {req!r}")
        # requiresNote MAY STAND ALONE (models.ts: a threshold prerequisite has
        # no goal to point at), so this is a type check and never a
        # "note without requires" error. Empty string is caught because an
        # empty note renders an empty line rather than nothing.
        note = goal.get("requiresNote")
        if note is not None and (not isinstance(note, str) or not note.strip()):
            err(name, f"{where} 'requiresNote' must be non-empty text, got {note!r}")
        if isinstance(req, list):
            requires_by_goal.append((where, gid, req))

        steps = goal.get("steps") or []
        for j, step in enumerate(steps):
            if "shot" not in step:
                err(name, f"{where}.steps[{j}] missing 'shot'")
                continue
            if step["shot"] not in shot_ids:
                err(name, f"{where}.steps[{j}] references unknown shot {step['shot']!r}")
            if step.get("link") not in (None, "route", "none"):
                err(name, f"{where}.steps[{j}] link {step['link']!r} is not 'route'/'none'")
            if step.get("plunge") not in (None, "partial", "full"):
                err(name, f"{where}.steps[{j}] plunge {step['plunge']!r} is not 'partial'/'full'")
            # A plunge hint describes the leg INTO this step, so it only means
            # anything on a plunger-origin step: step 0, or a step right after
            # a `type:'plunge'` shot (the JAWS mid-goal re-plunge). Anywhere
            # else the renderer never reads it — an authoring mistake that
            # would otherwise ship silently.
            if step.get("plunge") is not None and j > 0:
                prev = shots_by_id.get((steps[j - 1] or {}).get("shot", ""), {})
                if prev.get("type") != "plunge":
                    err(name, f"{where}.steps[{j}] has a plunge hint but is not plunger-origin "
                              "(not step 0, and the previous step's shot is not type 'plunge')")
            pt = step.get("plungeTo")
            if pt is not None:
                if not isinstance(pt, (int, float)) or not (0.10 <= pt <= 0.88):
                    err(name, f"{where}.steps[{j}] plungeTo {pt!r} outside [0.10, 0.88]")
                if step.get("plunge") != "partial":
                    warn(name, f"{where}.steps[{j}] plungeTo without plunge:'partial' — it is a stop height, not a hint, and will be ignored")
            fl = step.get("flipper")
            if fl is not None and fl not in ("left", "right"):
                flipper_ids = {s.get("id") for s in doc["shots"] if s.get("type") == "flipper"}
                if fl not in flipper_ids:
                    err(name, f"{where}.steps[{j}] flipper {fl!r} is neither left/right nor a flipper-typed shot id")
            if step.get("direct") is not None and not isinstance(step["direct"], bool):
                err(name, f"{where}.steps[{j}] direct must be a boolean")
            if step.get("direct") and j == 0:
                err(name, f"{where}.steps[0] cannot be direct — there is no previous target to travel from")
            tech = step.get("technique")
            if tech is not None:
                if not isinstance(tech, list):
                    err(name, f"{where}.steps[{j}] technique must be a list")
                else:
                    for t in tech:
                        if t not in TECHNIQUES:
                            err(name, f"{where}.steps[{j}] unknown technique {t!r} (closed vocabulary — see models.ts)")
            check_feedref(name, f"{where}.steps[{j}]", step.get("feeds"), shot_ids)
            # Renderer band ambiguity (drawing.ts Case A2: partial ⇔ x>=0.57
            # && y<0.72 when unhinted): a skillshot opener whose target sits
            # NEAR the x cutoff flips route topology on a small coordinate
            # error. An explicit hint makes the geometry irrelevant.
            if j == 0 and cat == "skillshot" and step.get("plunge") is None:
                ts = shots_by_id.get(step.get("shot", ""), {})
                tx, ty = ts.get("x"), ts.get("y")
                if (isinstance(tx, (int, float)) and isinstance(ty, (int, float))
                        and 0.54 <= tx <= 0.60 and ty < 0.72):
                    warn(name, f"{where}.steps[0] target x={tx} sits in the partial-plunge ambiguity band with no plunge hint")
            for key in ("action", "detail"):
                if key not in step:
                    warn(name, f"{where}.steps[{j}] missing {key!r}")

        # Pathless goals (steps: []) must carry instructions, or the goal renders
        # as an empty card — see app/tests/pathless-goals.test.mjs.
        if not steps:
            instr = goal.get("instructions")
            if not instr:
                err(name, f"{where} has no steps and no instructions — would render empty")
            elif not isinstance(instr, list):
                err(name, f"{where} instructions must be a list")
            # ...and only the two categories the pathless contract covers may be
            # pathless at all. app.ts routes pathless goals down a separate branch
            # and map2d.ts filters them OUT of the Map picker, so a pathless goal
            # in any other category silently disappears from the map rather than
            # erroring. Caught here as well as in pathless-goals.test.mjs so the
            # pre-deploy validator fails on it too, not just the test run.
            elif cat not in PATHLESS_CATEGORIES:
                err(
                    name,
                    f"{where} is pathless but category is {cat!r} — only "
                    f"{'/'.join(sorted(PATHLESS_CATEGORIES))} may be pathless "
                    "(give it real steps, or recategorise it)",
                )

    # --- Goal dependencies: resolution, self-reference, cycles -------------
    # (dataset schema v8, 2026-08-15 — see Goal.requires in app/src/models.ts.)
    # A dangling id is invisible in the app: every surface looks the required
    # goal up and renders nothing when the lookup misses, so a renamed goal
    # silently un-gates the one that depended on it.
    dep_edges: dict[str, list[str]] = {}
    for where, gid, req in requires_by_goal:
        for r in req:
            if not isinstance(r, str):
                continue  # shape already reported in the loop above
            if r == gid:
                err(name, f"{where} 'requires' names itself ({r!r})")
                continue
            if r not in goal_ids:
                err(name, f"{where} 'requires' references unknown goal {r!r}")
                continue
            dep_edges.setdefault(gid, []).append(r)

    # Cycles are DATA CORRUPTION rather than a very hard game: a set of goals
    # each waiting on the next describes a set none of which can ever be
    # first, and it leaves the Map carousel's ladder ordering undefined.
    # Iterative DFS over a WHITE/GREY/BLACK colouring — the explicit stack is
    # what lets the message name the actual cycle instead of just asserting one
    # exists.
    WHITE, GREY, BLACK = 0, 1, 2
    color: dict[str, int] = {}
    reported: set[frozenset] = set()
    for start in sorted(dep_edges):
        if color.get(start, WHITE) != WHITE:
            continue
        color[start] = GREY
        dfs_path = [start]
        stack = [(start, iter(dep_edges.get(start, ())))]
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                color[node] = BLACK
                stack.pop()
                dfs_path.pop()
                continue
            c = color.get(nxt, WHITE)
            if c == GREY:
                cycle = dfs_path[dfs_path.index(nxt):] + [nxt]
                key = frozenset(cycle)
                if key not in reported:
                    reported.add(key)
                    err(name, "goals 'requires' cycle: " + " -> ".join(cycle))
                continue
            if c == BLACK:
                continue
            color[nxt] = GREY
            dfs_path.append(nxt)
            stack.append((nxt, iter(dep_edges.get(nxt, ()))))

    for i, ach in enumerate(doc.get("achievements", [])):
        where = f"achievements[{i}]"
        for key in ("id", "title", "desc", "tier"):
            if key not in ach:
                err(name, f"{where} missing {key!r}")
        if ach.get("tier") not in TIERS:
            err(name, f"{where} unknown tier {ach.get('tier')!r}")
        if ach.get("source") not in SOURCES:
            err(name, f"{where} unknown source {ach.get('source')!r}")
        ref = ach.get("goal")
        if ref and ref not in goal_ids:
            err(name, f"{where} references unknown goal {ref!r}")

    # --- card (ease-layer schema v5) ---------------------------------------
    # RETIRED 2026-08-11 (owner: "Remove all cards"): card is stripped from every data/*_goals.json file now, so the checks below are vacuous in practice — left in place, harmless, to catch it reappearing by accident.
    card = doc.get("card")
    if card is not None and not isinstance(card, dict):
        err(name, "card must be an object")
        card = None
    if card is not None:
        def card_entry(cwhere: str, e) -> None:
            if not isinstance(e, dict) or not e.get("text"):
                err(name, f"{cwhere} needs text")
                return
            if e.get("shot") is not None and e["shot"] not in shot_ids:
                err(name, f"{cwhere} references unknown shot {e['shot']!r}")
            if e.get("goal") is not None and e["goal"] not in goal_ids:
                err(name, f"{cwhere} references unknown goal {e['goal']!r}")
            if e.get("trim") not in (None, *TRIM_VALUES):
                warn(name, f"{cwhere} unusual trim {e.get('trim')!r}")

        if "skillShot" not in card:
            err(name, "card missing skillShot")
        else:
            card_entry("card.skillShot", card["skillShot"])
        for key in ("line", "safeShots", "dangerShots"):
            v = card.get(key)
            if not isinstance(v, list) or not v:
                err(name, f"card.{key} must be a non-empty list")
            else:
                for i, e in enumerate(v):
                    card_entry(f"card.{key}[{i}]", e)
        rem = card.get("reminders")
        if rem is not None and (
            not isinstance(rem, list) or any(not isinstance(r, str) for r in rem)
        ):
            err(name, "card.reminders must be a list of strings")

    # --- drills (ease-layer schema v5) -------------------------------------
    drills = doc.get("drills")
    if drills is not None and not isinstance(drills, list):
        err(name, "drills must be a list")
        drills = None
    drill_ids: set[str] = set()
    for i, d in enumerate(drills or []):
        where = f"drills[{i}]"
        if not isinstance(d, dict):
            err(name, f"{where} must be an object")
            continue
        for key in ("id", "title", "text"):
            if not d.get(key):
                err(name, f"{where} missing {key!r}")
        did = d.get("id", "")
        if did in drill_ids:
            err(name, f"{where} duplicate drill id {did!r}")
        drill_ids.add(did)
        if did and not ID_RE.match(did):
            err(name, f"{where} id {did!r} is not lowercase-kebab")
        if d.get("goal") is not None and d["goal"] not in goal_ids:
            err(name, f"{where} references unknown goal {d['goal']!r}")
        for key in ("reps", "focus"):
            if d.get(key) is not None and not isinstance(d[key], str):
                err(name, f"{where} {key} must be a string, got {type(d[key]).__name__}")
        for j, s in enumerate(d.get("shots") or []):
            if s not in shot_ids:
                err(name, f"{where}.shots[{j}] references unknown shot {s!r}")

    # --- actionButton (dataset schema v6, 2026-08-13) ----------------------
    # REQUIRED on every registered machine (owner: "Every game needs an
    # explanation of the action button"). present:false is a legitimate,
    # complete answer — but it must still SAY something (`how`), so the app
    # never renders a machine that can't answer "what does the button do?".
    ab = doc.get("actionButton")
    if ab is None:
        if path.stem in KNOWN_UNREGISTERED:
            warn(name, "no actionButton (shelved dataset — required before it ships)")
        else:
            err(name, "missing actionButton — every registered machine must explain "
                      "its action button (or explain that it has none)")
    elif not isinstance(ab, dict):
        err(name, "actionButton must be an object")
    else:
        known_ab_keys = {"present", "label", "location", "how", "uses"}
        for k in ab.keys() - known_ab_keys:
            warn(name, f"actionButton has unknown key {k!r}")
        if not isinstance(ab.get("present"), bool):
            err(name, "actionButton.present must be true or false")
        how = ab.get("how")
        if not (isinstance(how, str) and how.strip()):
            err(name, "actionButton.how must be a non-empty string")
        uses = ab.get("uses")
        if uses is not None and not isinstance(uses, list):
            err(name, "actionButton.uses must be a list")
            uses = None
        if ab.get("present") is True:
            if not (isinstance(ab.get("label"), str) and ab["label"].strip()):
                err(name, "actionButton.label required when present")
            if not (isinstance(ab.get("location"), str) and ab["location"].strip()):
                err(name, "actionButton.location required when present")
            if not uses:
                err(name, "actionButton.uses must be non-empty when present")
            elif not (2 <= len(uses) <= 8):
                warn(name, f"actionButton.uses has {len(uses)} entries — expected 2-8")
            for i, u in enumerate(uses or []):
                if not isinstance(u, dict):
                    err(name, f"actionButton.uses[{i}] must be an object")
                    continue
                for key in ("when", "what"):
                    if not (isinstance(u.get(key), str) and u[key].strip()):
                        err(name, f"actionButton.uses[{i}] missing {key!r}")
        elif ab.get("present") is False:
            if uses:
                err(name, "actionButton.uses must be empty when present is false")
            for key in ("label", "location"):
                if ab.get(key):
                    err(name, f"actionButton.{key} must be null/absent when present is false")

    hip = doc.get("howItPlays")
    if hip is None:
        if path.stem in KNOWN_UNREGISTERED:
            warn(name, "no howItPlays (shelved dataset - required before it ships)")
        else:
            err(name, "missing howItPlays - every registered machine must explain "
                      "how it plays (v9 content program complete 2026-09-08)")
    elif not isinstance(hip, dict):
        err(name, "howItPlays must be an object")
    else:
        known_hip_keys = {"objective", "loop", "lights", "laneChange", "laneChangeNote", "scoring"}
        for k in hip.keys() - known_hip_keys:
            warn(name, f"howItPlays has unknown key {k!r}")

        # objective
        obj = hip.get("objective")
        if not (isinstance(obj, str) and obj.strip()):
            err(name, "howItPlays.objective must be a non-empty string")
        elif len(re.findall(r"[.!?](\s|$)", obj)) > 2:
            warn(name, "howItPlays.objective is longer than 2 sentences")

        # loop
        loop = hip.get("loop")
        if not isinstance(loop, list):
            err(name, "howItPlays.loop must be a list")
        else:
            for i, line in enumerate(loop):
                if not (isinstance(line, str) and line.strip()):
                    err(name, f"howItPlays.loop[{i}] must be a non-empty string")
            if len(loop) == 0:
                err(name, "howItPlays.loop must have at least one step")
            elif not (3 <= len(loop) <= 5):
                warn(name, f"howItPlays.loop has {len(loop)} entries — expected 3-5")

        # lights
        lights = hip.get("lights")
        if not isinstance(lights, list):
            err(name, "howItPlays.lights must be a list")
            lights = []  # avoid further errors on non-list
        else:
            if len(lights) == 0:
                err(name, "howItPlays.lights must have at least one group")
            elif not (2 <= len(lights) <= 10):
                warn(name, f"howItPlays.lights has {len(lights)} groups — expected 2-10")

        group_ids_seen = set()
        for i, lg in enumerate(lights):
            if not isinstance(lg, dict):
                err(name, f"howItPlays.lights[{i}] must be an object")
                continue

            for k in set(lg.keys()) - {"id", "name", "kind", "sites", "lit", "flashing", "control", "then", "goals"}:
                warn(name, f"howItPlays.lights[{i}] has unknown key {k!r}")

            # id
            gid = lg.get("id")
            if not isinstance(gid, str) or not ID_RE.match(gid):
                err(name, f"howItPlays.lights[{i}].id must be lowercase-kebab")
            elif gid in group_ids_seen:
                err(name, f"duplicate howItPlays.lights id {gid!r}")
            else:
                group_ids_seen.add(gid)

            # name, lit, then
            for key in ("name", "lit", "then"):
                if not (isinstance(lg.get(key), str) and lg[key].strip()):
                    err(name, f"howItPlays.lights[{i}].{key} must be a non-empty string")

            # kind
            if lg.get("kind") not in LIGHT_KINDS:
                err(name, f"howItPlays.lights[{i}].kind must be one of {sorted(LIGHT_KINDS)}")

            # flashing
            flashing = lg.get("flashing")
            if flashing is not None and not (isinstance(flashing, str) and flashing.strip()):
                err(name, f"howItPlays.lights[{i}].flashing must be a non-empty string or null")

            # sites
            sites = lg.get("sites")
            if not isinstance(sites, list):
                err(name, f"howItPlays.lights[{i}].sites must be a list")
                sites = []
            else:
                if len(sites) < 1:
                    err(name, f"howItPlays.lights[{i}].sites must have at least 1 site")
                if len(sites) > 12:
                    warn(name, f"howItPlays.lights[{i}].sites has {len(sites)} sites — expected 1-12")
            for j, site in enumerate(sites):
                if not isinstance(site, dict):
                    err(name, f"howItPlays.lights[{i}].sites[{j}] must be an object")
                    continue
                has_shot = "shot" in site
                has_free = all(k in site for k in ("x", "y", "name")) and \
                           isinstance(site.get("x"), (int, float)) and \
                           isinstance(site.get("y"), (int, float)) and \
                           0.0 <= site["x"] <= 1.0 and 0.0 <= site["y"] <= 1.0 and \
                           isinstance(site.get("name"), str) and site["name"].strip()
                has_free = bool(has_free)
                if has_shot == has_free:
                    err(name, f"howItPlays.lights[{i}].sites[{j}] must have exactly one form: "
                              f"shot OR free lamp (x,y,name)")
                allowed_site = {"shot", "lamps"} if has_shot else {"x", "y", "name"}
                for k in set(site.keys()) - allowed_site:
                    warn(name, f"howItPlays.lights[{i}].sites[{j}] has unknown key {k!r}")
                if has_shot:
                    shot_id = site["shot"]
                    if not isinstance(shot_id, str) or shot_id not in shot_ids:
                        err(name, f"howItPlays.lights[{i}].sites[{j}].shot references unknown shot {shot_id!r}")
                # lamps (only applies to shot-anchored)
                if has_shot and site.get("lamps") is not None:
                    lamps = site.get("lamps")
                    if isinstance(lamps, bool) or not isinstance(lamps, int) or lamps < 1:
                        err(name, f"howItPlays.lights[{i}].sites[{j}].lamps must be a positive integer or null")

            # control
            control = lg.get("control")
            if control is not None and not isinstance(control, dict):
                err(name, f"howItPlays.lights[{i}].control must be an object or null")
            elif isinstance(control, dict):
                for k in set(control.keys()) - {"input", "effect", "when"}:
                    warn(name, f"howItPlays.lights[{i}].control has unknown key {k!r}")
                if control.get("input") not in LIGHT_INPUTS:
                    err(name, f"howItPlays.lights[{i}].control.input must be one of {sorted(LIGHT_INPUTS)}")
                if not (isinstance(control.get("effect"), str) and control["effect"].strip()):
                    err(name, f"howItPlays.lights[{i}].control.effect must be a non-empty string")
                when = control.get("when")
                if when is not None and not (isinstance(when, str) and when.strip()):
                    err(name, f"howItPlays.lights[{i}].control.when must be a non-empty string or null")

            # goals
            goals = lg.get("goals")
            if goals is not None:
                if not isinstance(goals, list):
                    err(name, f"howItPlays.lights[{i}].goals must be a list or null")
                else:
                    for g_idx, goal in enumerate(goals):
                        if goal not in goal_ids:
                            err(name, f"howItPlays.lights[{i}].goals[{g_idx}] references unknown goal {goal!r}")
                    if len(set(goals)) != len(goals):
                        err(name, f"howItPlays.lights[{i}].goals has duplicate goal ids")

        # laneChange
        lc = hip.get("laneChange")
        if lc not in LANE_CHANGE:
            err(name, f"howItPlays.laneChange must be one of {sorted(LANE_CHANGE)}")
        if lc == "unknown":
            warn(name, "laneChange is 'unknown' — not verified yet")
        lcn = hip.get("laneChangeNote")
        if lc != "unknown":
            if not (isinstance(lcn, str) and lcn.strip()):
                err(name, "howItPlays.laneChangeNote is required when laneChange is not 'unknown'")
        else:
            if lcn is not None and not (isinstance(lcn, str) and lcn.strip()):
                err(name, "howItPlays.laneChangeNote must be a non-empty string or null when laneChange is 'unknown'")

        # scoring
        scoring = hip.get("scoring")
        if not isinstance(scoring, list) or len(scoring) != 3:
            err(name, "howItPlays.scoring must be a list of exactly 3 steps (ball-one, building, the-big-one)")
        else:
            for i, step in enumerate(scoring):
                if not isinstance(step, dict):
                    err(name, f"howItPlays.scoring[{i}] must be an object")
                    continue
                for k in set(step.keys()) - {"tier", "text", "goals"}:
                    warn(name, f"howItPlays.scoring[{i}] has unknown key {k!r}")
                if step.get("tier") != SCORING_TIERS[i]:
                    err(name, f"howItPlays.scoring[{i}].tier must be {SCORING_TIERS[i]!r} (got {step.get('tier')!r})")
                if not (isinstance(step.get("text"), str) and step["text"].strip()):
                    err(name, f"howItPlays.scoring[{i}].text must be a non-empty string")
                goals = step.get("goals")
                if goals is not None:
                    if not isinstance(goals, list):
                        err(name, f"howItPlays.scoring[{i}].goals must be a list or null")
                    else:
                        for g_idx, goal in enumerate(goals):
                            if goal not in goal_ids:
                                err(name, f"howItPlays.scoring[{i}].goals[{g_idx}] references unknown goal {goal!r}")
                        if len(set(goals)) != len(goals):
                            err(name, f"howItPlays.scoring[{i}].goals has duplicate goal ids")
    # --- shots referenced by nothing (P0, 2026-08-10) ----------------------
    # One summary line per file, WARN only. Purpose: surface real, makeable
    # features that no goal routes to (the Jaws shark-bash class), which is
    # invisible in per-goal review. `type:'flipper'` shots are excluded —
    # they exist as art/anchor furniture and are legitimately unrouted.
    referenced: set[str] = set()
    for g in doc["goals"]:
        for st in g.get("steps") or []:
            if isinstance(st, dict):
                if st.get("shot"):
                    referenced.add(st["shot"])
                f = st.get("feeds")
                if isinstance(f, dict) and f.get("shot"):
                    referenced.add(f["shot"])
    for s in doc["shots"]:
        f = s.get("feeds")
        if isinstance(f, dict) and f.get("shot"):
            referenced.add(f["shot"])
        for v in (s.get("feedsByTrim") or {}).values():
            if isinstance(v, dict) and v.get("shot"):
                referenced.add(v["shot"])
    for z in zones.values():
        referenced.update(z.get("entries") or [])
        for x in z.get("exits") or []:
            if isinstance(x, dict) and x.get("shot"):
                referenced.add(x["shot"])
    if card is not None:
        centries = [card.get("skillShot")]
        for key in ("line", "safeShots", "dangerShots"):
            centries.extend(card.get(key) or [])
        for e in centries:
            if isinstance(e, dict) and e.get("shot"):
                referenced.add(e["shot"])
    for d in drills or []:
        if isinstance(d, dict):
            referenced.update(d.get("shots") or [])
    unrouted = sorted(
        sid for sid, s in shots_by_id.items()
        if sid not in referenced and s.get("type") != "flipper"
    )
    if unrouted:
        warn(name, f"{len(unrouted)} shot(s) referenced by zero goals/feeds/card: {', '.join(unrouted)}")

    # Player-facing strings only — sources[] is deliberately excluded.
    for loc, text in _player_strings(doc):
        hit = INTERNAL_TERMS.search(text)
        if hit:
            err(name, f"{loc} contains non-player-facing term {hit.group(0)!r}")

    check_shot_text(name, doc)

    if not doc.get("sources"):
        warn(name, "no sources[] — every machine should cite where its rules came from")


def main() -> int:
    files = sorted(DATA.glob("*_goals.json"))
    for path in files:
        check_machine(path)

    # catalog.json and data/ must agree in BOTH directions: a machine file with no
    # catalog entry is invisible in the app, and a catalog entry with no file is a
    # 404 the moment someone taps it.
    catalog = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    listed = {entry["resource"] for entry in catalog}
    on_disk = {p.stem for p in files}

    for missing in sorted(on_disk - listed):
        if missing in KNOWN_UNREGISTERED:
            warnings.append(
                f"catalog.json: {missing}.json is deliberately unregistered "
                "(shelved — registering it is a product decision)"
            )
        else:
            errors.append(f"catalog.json: {missing}.json exists in data/ but is not listed")
    for orphan in sorted(listed - on_disk):
        errors.append(f"catalog.json: lists {orphan!r} but data/{orphan}.json does not exist")

    ids = [entry["id"] for entry in catalog]
    for dupe in {i for i in ids if ids.count(i) > 1}:
        errors.append(f"catalog.json: duplicate machine id {dupe!r}")

    for line in warnings:
        print(f"WARN  {line}")
    for line in errors:
        print(f"ERROR {line}")

    print(
        f"\n{len(files)} machines, {len(catalog)} catalog entries, "
        f"{len(errors)} errors, {len(warnings)} warnings"
    )
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
