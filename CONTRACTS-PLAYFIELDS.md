# CONTRACTS-PLAYFIELDS — dataset schema v5 + deck/trim/plunge rendering (2026-08-10)

Amendments to CONTRACTS.md and (on unfreeze) SPEC-PATHVIZ/SPEC-BALLSTART, from
the playfield-truth overhaul. The prose authority for field semantics is
`app/src/models.ts`'s doc comments; `app/scripts/validate-machines.py` is the
mechanical mirror. This file records the RULES the renderer now obeys.

## Schema v5 (all additive, fail-soft)
- `GameData.playfields[]`: PlayfieldZone {id, name, kind upper|mini|lower,
  bounds{x,y,w,h} in MAIN UV, trim?, entries?, exits?}. A zone is a labeled
  region of the same unit square — MapFn untouched, no second coordinate space.
- `Shot.playfield` (zone id), `Shot.bat` {side?, size full|mini} (flipper shots
  only; presence retires the name-regex bat detection for that shot),
  `Shot.feedsByTrim` {trim: FeedRef} (resolution: step.feeds ?? feedsByTrim[trim]
  ?? feeds; `??` semantics — a null override cannot suppress a base feed),
  `Shot.backhand` ('left'/'right' list).
- `GoalStep.plunge` 'partial'|'full' + `plungeTo` (UV y stop height, clamp
  [0.10,0.88]) + `technique[]` (13-term closed vocab; plunge chips derive from
  plunge fields, never live in technique). `GameData.drills[]` (dormant —
  no surface renders it; `card` RETIRED 2026-08-11 by owner and stripped
  from the catalog, types kept only so unimported machinecard.ts typechecks).

## Rendering rules added
1. **One geometry source**: `overlay/shotgeom.ts` (pure, DOM-free) owns lane
   constants, anchors, chooseFlipper, resolveFeedUV, synthesizeApex,
   resolveShootingAnchor, isShotVisible/isZoneVisible, feedForTrim,
   approachLine. Art lane-lines use the router's flipper choice (cross-flipper
   truth — changed origins on 126/139 machines, playfield-art §12d pins it).
2. **Plunge**: classifyPlunge() is the single source of partial-vs-full and the
   lane exit height; explicit hints beat geometric bands both ways; the plunge
   gauge (Pass 1.5) draws only when the ACTIVE step is plunger-origin and fills
   to the same resolved height the route uses. Soft-plunge tracer segments ease
   (decel); hint position rule: step 0 or immediately after a type:'plunge'
   step (validator-enforced).
3. **Trim**: `state.trim` 'pro'|'premium-le' per machine (localStorage,
   default premium-le = pre-v5 render). Map filters dots/art/hit-test through
   isShotVisible UNIONED with the selected goal's step shots — the filter
   never subtracts what the selected goal needs; shotsByID stays unfiltered.
   Map goal picker LISTS premium-only goals under Pro, disabled with a stated
   reason (P7b, 2026-08-14 — it used to omit them, so the two tabs showed
   different goal lists for one machine); the pill chips the selected goal if a
   MODEL switch strands it, and the selection is never cleared out from under
   the visitor. Goals rows chip+dim. Zone plates respect zone.trim.
4. **Decks**: targets on a zone with >=1 bat anchor at the DECK bat
   (stepFlipper > shot.flipper > cross-side re-centered on zone midline >
   nearest-by-x). Direct target-to-target legs require authored GoalStep.direct:true
   AND same playfield (2026-08-11: the geometric both-upper default is gone —
   every leg routes via its shooting flipper/deck bat; skillshot category
   draws no legs at all unless a step authors link:route). Goals starting on a deck launch at the deck bat (beats the
   skillshot y>=0.15 plunger heuristic). Climbing on/off = entry shot's feeds
   through the existing rule-7 elevated legs — no new mechanism. Art: upper/
   mini = raised plate (elevation edge + micro-label + bats at half scale for
   'mini'), lower = dashed "· BELOW DECK" inset. All of it gated on
   playfields presence: zone-less machines render byte-identical (deck-route
   §f proves it against real data dynamically).
5. **Orbit/loop continuation** legs arch (control y = apex.y+0.06) when
   |feed.x − entrance.x| > 0.3 — curves only for real rails; everything else
   stays straight per the 2026-07-29 amendment.

## Native-port checklist (iOS/Android are ~5 weeks behind; all v5 is additive
so stale natives keep rendering — port in this order)
1. Decode-safety FIRST: iOS GoalCategory enum throws on 'secret'/'progression';
   Android returns null. Fix before any data sync.
2. Case A2 partial plunge + plungeTo + gauge (drawing.ts classifyPlunge port).
3. shotgeom extraction + art/route flipper unification.
4. Trim selector + feedsByTrim resolution.
5. PlayfieldZone rendering + deck anchors + same-playfield guard.
6. Technique chips + provenance line (goalMeta helpers). (Card feature RETIRED 2026-08-11 — do not port.)
7. Sync data files (web data/ is source of truth; natives ship stale copies).

## Data program state (see _Business/)
BASELINE-COUNTS-2026-08.json = before-picture; COVERAGE-LATEST.json moves with
every pass. FLAGSHIP-DEEP-PASS-2026-08-10.json applied (confirmed-only) via
app/scripts/apply-structured.py — refuted/uncertain parked; ED basement + HW
deck bounds wait on the vision pass (VISION-PILOT-JAWS-2026-08-10.json has the
method + its 5 scale-up fixes). catalog-passes/p2 (deck inventory) and p3
(plunge+technique) artifacts land from workflows; apply is always
dry-run → verdict-gated → validator-gated → rollback-on-red.
