// Port of the shared goal-overlay drawing routines. Canonical source:
//   PinballGenieAndroid/app/src/main/java/com/rolo/pinballgenie/ui/OverlayDrawing.kt
//   (object OverlayDrawing — drawGoalOverlay, routeSegment, directControl,
//   bowControl, drawHighlightTarget, drawRoute/drawLeg/drawFallback,
//   strokeShotCurve/strokeQuietCurve, drawArrowhead, drawBadge, drawLabel).
// Cross-checked against:
//   PinballGenieIOS/PinballGenie/Views/OverlayDrawing.swift (drawGoal — the
//   iOS reference the Kotlin file itself is a "direct port" of; iOS draws in
//   points with no dp→px scale, which is why this file treats every native
//   `N.dpPx(this)` literal as a bare CSS-px number: 1 dp == 1 pt == 1 CSS px
//   here, matching iOS 1:1)
//   PinballARPipeline/specs/SPEC-PATHVIZ.md (routing rules, marching
//   highlight cadence) and SPEC-BALLSTART.md (launch anchor per ballPosition,
//   "Any" default (0.5, 0.03)).
//
// 2026-07-28: SPEC-PATHVIZ rule 5 + the SPEC-BALLSTART "plunger launch
// realism" amendment added the LANE ROUTE (plunger -> shooter lane ->
// playfield -> target) and the "effective launch anchor" computed inside
// drawGoalOverlay (a plunge-first/skillshot-off-the-plunge goal anchors at
// the machine's plunge-shot x, not the flat (0.5, 0.03) default; mid-sequence
// re-plunges lane-route too). Android/iOS are being updated in the same
// change — see OverlayDrawing.kt / OverlayDrawing.swift.
//
// 2026-07-28 "Shot Coach" (design_handoff_shot_coach/README.md, corrected by
// the orchestrator's shotcoach-corrections.md — that file wins wherever it
// disagrees with the README): the marching highlight that jumped every
// HIGHLIGHT_HOLD_S is replaced by flattened-polyline routes + a constant-
// speed tracer ball (tracerAt) that flies the whole combo and drives which
// step is "active"/"done"/"quiet". ROUTING MATH ITSELF — routeSegment,
// directControl, bowControl, curveClears, laneRoute, distanceToSegment — is
// UNCHANGED; only how a computed route is turned into pixels changed:
//   - every route segment is flattened into a FlatSegment polyline (22
//     samples per surviving quadratic-Bézier leg, chained through leg
//     origins, degenerate legs skipped exactly as drawRoute used to skip
//     them when stroking directly);
//   - tracerAt(flats, tMs) reports which segment is being flown / just
//     landed on, driving THREE leg states (active/done/quiet) instead of two
//     (highlighted/quiet), plus the tracer ball + comet trail (Pass 3) and an
//     impact-flash ring (Pass 2);
//   - manual highlight mode (o.highlightIndex a finite number) and
//     o.ballTracer===false both bypass the flying ball — see
//     ActiveState/resolveActiveState below — but manual mode still gets the
//     new done-leg/ring treatment (shotcoach-corrections.md #10's "manual
//     bypass shape"), while ballTracer:false's AUTO fallback reproduces the
//     OLD two-state autoHighlightIndex/ease behavior byte-for-byte (nothing
//     about that path changed — same README 1b/1e guarantee).
//
// 2026-07-29: the "ROUTING MATH ITSELF ... is UNCHANGED" claim two paragraphs
// up no longer holds for two of the named functions (recorded here rather
// than edited into the 2026-07-28 paragraph, which is left as it was
// written). bowControl now returns the chord midpoint instead of a
// perpendicular-bowed point — a quadratic Bézier whose control point is the
// midpoint of its own endpoints degenerates to an exact straight line, and
// real pinball shot trajectories ARE straight, so the old bow/nudge
// curvature was cosmetic, not physical. directControl's obstacle-clearance
// nudge went with it (curveClears and distanceToSegment, its only callers,
// are deleted); directControl now also just returns the chord midpoint.
// laneRoute's shooter-lane ARCH legs (archControl, in Case B/C) are
// UNCHANGED and still deliberately curved — the shooter-lane arch is a real
// physical feature of the table, not synthesized curvature.
// 2026-07-29 (later same day): SPEC-PATHVIZ rules 6-7 (dataset schema v3,
// additive/fail-soft — see models.ts's FeedRef/Shot.apex/Shot.feeds/
// Shot.flipper/GoalStep.feeds/GoalStep.flipper doc comments).
//   RULE 6 "flipper-anchored launches/returns": every non-direct,
//   non-plunge-origin segment now resolves a shooting flipper (chooseFlipper
//   — step.flipper > shot.flipper > geometric heuristic off the target's x,
//   center-band tie-break off the origin's x) and routes through THAT
//   flipper's anchor (FLIPPER_ANCHORS, derived from models.ts's
//   BALL_ANCHORS.leftFlipper/rightFlipper via the existing anchorToPt)
//   instead of the fixed RETURN_WAYPOINT_UV (tombstoned below, kept for spec
//   history). A segment whose origin is already within FLIPPER_SNAP of that
//   anchor (e.g. an inlane feed returning to its own flipper) snap-directs
//   to a single straight leg instead of detouring through a waypoint the
//   ball is already sitting on. A non-plunger launch with ballPosition 'any'
//   anchors the SAME way, at the cross flipper of step 0's target (tie-break
//   origin = the flat DEFAULT_LAUNCH_UV) — an explicitly selected
//   leftFlipper/rightFlipper/plunger ballPosition is NEVER overridden. This
//   is a real behavior change for plain (no schema-v3 fields at all) goals
//   too, since the heuristic is pure geometry — see plunger-route.test.mjs's
//   sections d/e/f, updated alongside this change with comments explaining
//   the new expected anchors.
//   RULE 7 "ramp continuation": when a step's shot (or the step's own
//   `feeds` override) resolves a feed point, TWO more straight legs — flagged
//   `elevated` — are chained on past the entrance ring: entrance->apex
//   (authored `shot.apex` or synthesized) then apex->feed. The arrowhead
//   still caps the last NON-elevated leg (into the entrance); the elevated
//   tail ends in a small landing-marker ring+dot at the feed point instead.
//   The NEXT segment then originates at that feed point, not the entrance
//   ring, and is itself routed by rule 6. Rendered with a dotted, thinner
//   "ball-on-wireform" stroke (strokeRampLeg) with its own active/done/quiet
//   alphas. Fail-soft throughout: absent/unresolvable feeds, or a non-finite
//   mapped elevated point, drops just the extension — everything else (the
//   main route, and every goal with no feeds data at all) renders exactly as
//   it did before this rule existed. Activation gate is FEEDS PRESENCE, not
//   `shot.type === 'ramp'` — orbits/loops generalize for free as pure data.
//
// 2026-07-28 degenerate-leg review: the ARROWHEAD_MIN_LEG_PX gate the
// pre-Shot-Coach source had (suppressing an arrowhead on a very short final
// leg) was dropped during the initial port on the theory that reading the
// angle off the flattened polyline's last 4 samples, rather than a raw
// control point, made the detached-chevron problem it guarded against moot.
// The review proved that wrong: the arrowhead's `back` pull-back (up to 30px
// for the active state) can still exceed a short leg's own length, detaching
// the chevron from the line it caps regardless of how the angle is derived.
// Finding 3 REINSTATES the gate (see ARROWHEAD_MIN_LEG_PX below) — a segment
// still draws its connector line below the threshold, it just skips the
// arrowhead.
//
// 2026-08-10 (phase A1, map-art/route geometry unification): DEFAULT_LAUNCH_UV,
// FLIPPER_ANCHORS, FLIPPER_SNAP, the shooter-lane constants (LANE_MIN_X/
// LANE_MAX_X/LANE_TOP_V/LANE_BOTTOM_V/ARCH_ENTRY_UV), resolveFeedUV,
// chooseFlipper, and the rule-7 apex-synthesis formula (now synthesizeApex)
// moved to ./shotgeom.ts — a PURE module (no DOM/canvas) that is now the
// single source of geometric truth both this file's routing AND
// ./map2d.ts's background playfield art import from, so the two can never
// disagree again (map2d.ts's lane lines used to pick their own flipper with
// a naive `x < 0.5` guess, independent of chooseFlipper's cross-flipper
// heuristic — see shotgeom.ts's approachLine doc comment). Imported back in
// above and re-exported for any existing importer of this file. Route
// output is UNCHANGED by this move — same values, same formulas, just
// relocated.
//
// 2026-08-10 (phase A2, same-day follow-up): two additive changes, both
// scoped to plunger-origin routing/drawing only.
//   1) models.ts schema v5's GoalStep.plungeTo — an authored stop height for
//      a `plunge:'partial'` step — now reaches laneRoute's Case A2 exit leg
//      (`classifyPlunge`, factored out of laneRoute for this: see its doc
//      comment). An authored value wins outright (clamped to
//      [0.10, LANE_TOP_V]); an absent value reproduces the pre-existing
//      `min(t.y + 0.06, 0.8)` exit byte-for-byte. Threaded additively through
//      routeSegment/laneRoute's new trailing `plungeTo` parameter.
//   2) drawPlungeGauge (new) — a visible plunge-strength cue (a filled
//      vertical track + ball-dot + SOFT/FULL PLUNGE label, just inboard of
//      the shooter lane) drawn by drawGoalOverlay's new Pass 1.5, whenever
//      the ACTIVE step is plunger-origin. Reads the same classifyPlunge
//      result laneRoute used for that step's own leg (via the hoisted
//      per-step `fromPlungerAt` array — also new, replacing an inline
//      per-segment computation that only routing used to read), so the
//      gauge and the drawn route can never show a different plunge strength.
//
// 2026-08-10 (phase A4, same-day follow-up): deck/PlayfieldZone routing
// (dataset schema v5 — models.ts's PlayfieldZone/Shot.playfield/Shot.bat doc
// comments). OverlayOpts gains `playfields` (a machine's raised/sunken
// zones); when present and non-empty, every step's shooting anchor is
// resolved via shotgeom.ts's (now deck-aware) resolveShootingAnchor instead
// of a bare chooseFlipper 'left'|'right' — a target on a zone with its own
// bat anchors there (`deck: true`) instead of FLIPPER_ANCHORS. Three call
// sites changed: routeSegment's viaWaypoint/snap-direct anchor (now
// `anchorUV: Pt`, not `flipper: 'left'|'right'`) plus a new `samePlayfield`
// guard on the both-upper direct exception (two shots on different
// playfields never draw a straight line through a deck wall), and the
// launch-anchor block (a goal starting on a deck shot launches from that
// deck bat, beating the skillshot y>=0.15 plunger heuristic — a deck shot
// cannot be plunged directly). FAIL-SOFT throughout, gated on `o.playfields`
// being present/non-empty: a machine with no `playfields` (the ~139 as of
// this writing) takes none of this new code and renders byte-identical to
// before this phase. Climbing onto/off a deck needed no new mechanism — an
// entry shot's own `feeds` (rule 7's elevated legs) already handles it.
//
// 2026-08-11 (phases A5/A6 + live GAUGE feedback, same-day follow-up to A4):
//   A5 "orbit/loop continuation arcs": rampExtensionLegs' two elevated legs
//   (entrance->apex->feed) now arch — control point y = apex.y+0.06, clamped
//   to 0.99 — instead of the plain chord-midpoint bowControl, but ONLY when
//   BOTH `shot.type` is 'orbit'/'loop' AND the resolved feed sits far enough
//   across the table (`|feed.x - entrance.x| > 0.3`) to read as a real rail
//   rather than a short hop. Every other shot type, and any orbit/loop whose
//   feed is close by, still gets the straight chord — the 2026-07-29
//   amendment's "curves only for real rails" rule (CONTRACTS-PLAYFIELDS.md
//   rule 5) now has an actual curve to draw for the case it was written for.
//   A6 "decel soft-plunge tracer": a partial-plunge LANE segment
//   (classifyPlunge's 'partial' case) now flags its FlatSegment
//   `easing:'decel'` — threaded from laneRoute's new `partial` return field
//   through routeSegment's 'lane' SegmentRoute and flattenSegment. tracerAt's
//   flying-ball progress on such a segment maps its raw time-fraction `u`
//   through `1-(1-u)**2` before sampling position: the ball covers ground
//   fast right off the plunger and visibly slows into its landing, matching
//   a soft pull that leaves with a burst of speed and decelerates climbing
//   the lane. Every other segment (no `easing` field) is completely
//   unaffected — same linear time-to-arc-length mapping as before.
//   GAUGE (rolo's live design feedback, supersedes phase A2's position/
//   color): drawPlungeGauge moves from just inboard of the shooter lane to
//   OUTSIDE the playfield's right edge — track x = u≈1.035, relying on
//   MapFn's linear extrapolation past u=1 (no clamping, per CONTRACTS.md) to
//   land roughly where a real machine's plunger rod actually sits, clear of
//   the table instead of overlapping it (map2d.ts's playfieldRect reserves a
//   right-edge gutter so this and its label always have canvas room). The
//   fill is no longer the goal's category color (rolo: it read as part of
//   the route line) — it's now a FIXED green/yellow/red strength gradient
//   (ctx.createLinearGradient over the track's full extent, so a given fill
//   HEIGHT always reads the same strength regardless of how far any one
//   plunge reaches) painted as a filled bar (ctx.fillStyle = gradient, not a
//   stroked line) rising to classifyPlunge's resolved stop height exactly as
//   before; the track stays a thin, dim, category-independent neutral line
//   and the fill-top dot is now fixed white rather than category-colored, so
//   nothing on the gauge is category-tinted any more. No pre-existing
//   fill-pull-in animation was found on drawPlungeGauge to preserve — it was
//   (and remains) a static bar to the resolved height; only position and
//   fill style change here.
//
// 2026-08-11 (phase A7, same-day follow-up to A5/A6 — rolo, reviewing
// production: "I don't like the plunger pull line representation, completely
// remove that... shots need the flippers to complete, many times you can't
// just go right thru the board"): a plunger-origin segment (routeSegment's
// `fromPlunger` branch — the very first launch AND every mid-sequence
// re-plunge alike) now draws NO lane leg at all — no climb, no arch, no
// descent, no lane path. drawPlungeGauge (phase A2, repainted 2026-08-11
// above) is the ONLY visual plunge representation left. classifyPlunge/
// laneRoute are UNCHANGED and fully intact — routeSegment still calls
// laneRoute (so `partial`, and therefore the gauge's SOFT/FULL label + fill
// height, are computed exactly as before) and just discards its `legs`. The
// plunge TARGET keeps its own ring/badge/highlight (Pass 2 never read route
// legs to begin with) and, if that target's own shot resolves a `feeds`
// point, rule 7's post-landing continuation (entrance->apex->feed) still
// draws past it exactly as before — that is the target's own onward travel,
// not the (now-removed) plunge representation. flattenSegment special-cases
// the now-legless lane route so the shared "entrance ring" point the
// extension chains from still exists even though nothing strokes to reach
// it (see its own doc comment). The A6 decel-easing tag is dormant, not
// deleted, for the same reason: no lane FlatSegment is ever produced any
// more to carry `easing:'decel'`, so tracerAt's easing branch simply never
// fires (see its own one-line note). The tracer itself needed no other
// changes — a plunger-origin segment's flattenSegment result is null (or,
// extension-only, has zero "main" length) exactly like the pre-existing
// degenerate-leg case (plunger-route.test.mjs section k), and tracerAt
// already treats a null/near-zero-length flat as a dwell-only phase (no
// travel, ball/u stay null, no NaN, nothing gets stuck).
//
// 2026-08-11 (phase A8, rolo's route-truth rule): "from flipper to a target
// is just one shot; rarely would it go flipper to target to target." The
// OLD geometric exception in routeSegment — two consecutive targets both in
// the upper half (y>0.5) and within 0.35 UV of each other drew a DIRECT
// chord, no flipper anchor in between — is GONE. Direct topology now
// survives ONLY when the step carries an AUTHORED `direct:true`
// (GoalStep.direct, models.ts — already validator-enforced to never appear
// on step 0). Every other non-launch, non-plunge-origin segment — INCLUDING
// two shots on the SAME deck, which used to qualify for the old geometric
// exception just as readily as two main-playfield shots — now routes via
// rule 6's shooting anchor (resolveShootingAnchor) by default, same as any
// other segment. The phase A4 same-playfield guard survives unchanged
// alongside it: an authored `direct:true` is honored only when
// `samePlayfield` also holds (never draw a straight line through a deck
// wall, authored or not) — see routeSegment's own doc comment for the
// combined `direct && samePlayfield` gate. FLIPPER_SNAP's own short-circuit
// (a segment already sitting on its shooting anchor collapses to one
// straight leg) is UNCHANGED — that is flipper->target, the case rule 6
// always drew directly, not the killed target->target heuristic. Blast
// radius: every existing test fixture that relied on the geometric
// exception (rather than the FLIPPER_SNAP short-circuit, which is untouched)
// needed either an authored `direct:true` added or its expected route
// topology reworked from a direct chord to a viaWaypoint run — see
// plunger-route.test.mjs section t's "obstacle regression" fixture and
// deck-route.test.mjs section c, both updated alongside this phase.
//
// 2026-08-11 (phase A9, "feed-loop coil rendering" — models.ts FeedRef.loop,
// schema v5): a resolved feed can now carry a `loop` waypoint — "on the way
// to the feed point the ball physically WRAPS this element" (Jaws' shooter-
// lane plunge coiling around the fishing-reel spinner before dropping at the
// mini flipper is the reference case, data/jaws_goals.json). When present
// and resolving, rampExtensionLegs' continuation swaps the synthesized/
// authored apex crest for a visible COIL around the loop point instead — see
// loopCoilLegs' own doc comment for the exact geometry (a parametric circle
// swept ~1.25 turns, flattened into the SAME dotted elevated-leg polyline
// style as every other rule-7 continuation — no changes needed anywhere
// else: flattenSegment/tracerAt/Pass 1 already chain an arbitrary number of
// elevated LaneLegs, so the tracer walks a coil exactly like it walks any
// other polyline). Absent/unresolvable `loop` (the overwhelming majority of
// feeds, including every one shipped before this phase) is entirely
// unaffected — pure fail-soft addition.
//
// 2026-08-11 (phase A10, "skillshot = target-only rendering", rolo — this
// SUPERSEDES phases A8/A9 for `goal.category === 'skillshot'` ONLY): a drawn
// path through the plunger/mini-flipper/whatever else implies touching
// things that VOID a skill shot — Jaws L2/L3 name exactly this in their own
// step detail text. So a skillshot goal now draws NO route legs at ALL by
// default: no flipper-anchored legs (rule 6), no feed continuations, no loop
// coils (rule 7/phase A9) — only the plunge gauge (per the active plunger-
// origin step, entirely unchanged — it was never a "leg") and every step's
// ring/badge/highlight, exactly as for any other goal. This is implemented
// as an INVERSION of GoalStep.link's existing default for this one category
// only: `link:'none'` already meant "suppress the connector leg into this
// step, keep the ring/badge" for any-order goals (models.ts's own doc
// comment) — for a skillshot goal, EVERY step now behaves as if `link` were
// 'none' UNLESS it explicitly carries `link:'route'` (the escape hatch,
// e.g. a video-verified case where the drawn approach really is safe to
// show). `link:'route'` on a non-skillshot step is a no-op (today's default
// already draws it). See stepLinkSuppressed below — the single predicate
// both Pass 1's leg-suppression and the extLegs/loop-coil gate read, so the
// two can never disagree about which steps are suppressed. Every other
// category's default is completely unchanged.
//
// 2026-08-11 (phase A11, "map-scoped celebration", owner request — see
// app.ts's header comment, which records that the PRODUCT-WIDE full-screen
// celebration removal still stands; this is a narrower, MAP-SCOPED return):
// Pass 5 (new, after Pass 4) draws a small emoji burst — 8 copies of the
// goal's resolved fx glyph scattering/spinning outward — centered on the
// LAST step's target, whenever the caller opts in via `o.celebrate` AND the
// active step is that last step. This file stays STATELESS/pure as
// everywhere else: AUTO/tracer mode times the burst off `active.sinceHit`
// (already resets every loop cycle — "celebrate every loop arrival" falls
// out for free with no new state). MANUAL mode has no such per-frame clock
// (resolveActiveState parks `sinceHit` null there) and "celebrate ONCE per
// arrival, never while sitting" is an edge-triggered rule only a caller with
// cross-frame memory can enforce — see `o.celebrate.manualStartedAt`'s own
// doc comment. The caller (overlay/map2d.ts's mountMap2D) owns that arming
// state machine entirely; this file only ever draws however many elapsed ms
// it's told. Respects prefers-reduced-motion (originally a single static
// glyph pulse, no scatter/spin; REWORKED 2026-08-11, phase A17, to a
// level-scaled static frame — see the phase A17 note below and
// drawCelebrationBurst's own doc comment).
//
// 2026-08-11 (phase A12, rolo's live-review batch — five requested changes in
// one pass; items renumbered here to match the work order, not necessarily
// the order rolo listed them):
//   1) PLUNGE GAUGE REMOVED OUTRIGHT ("the gradient line for the plunger —
//      remove that feature"). drawPlungeGauge, Pass 1.5, and the
//      PLUNGE_GAUGE_X/PLUNGE_GAUGE_BOTTOM_V/PLUNGE_GAUGE_FILL_HALF_W
//      constants are deleted — there is now NO visual plunge-strength cue on
//      either render surface. classifyPlunge/laneRoute are UNCHANGED
//      (routeSegment's `fromPlunger` branch still calls laneRoute to compute
//      `partial`, which nothing downstream reads any more, but leaving the
//      call in place is simpler and cheaper than carving a `partial`-less
//      path out of it) — classifyPlunge is now EXPORTED so plungeTo's clamp
//      behavior can be unit-tested directly instead of through gauge
//      fill-rect geometry that no longer exists. goalMeta.ts's stepChips
//      SOFT/FULL PLUNGE text chips (derived from `step.plunge`, never from
//      this file) are UNTOUCHED — those were always a DOM chip, never this
//      canvas gauge, and rolo's ask named "the gradient line" specifically.
//      map2d.ts's GAUGE_GUTTER right-edge canvas reservation is reclaimed by
//      playfieldRect the same day — see that file's own header.
//   2) CELEBRATION BURST FIXED TO ACTUALLY CLEAR THE RING ("have the emojis
//      blow up or spin out of the target circle so it's not confined within
//      the target"). drawCelebrationBurst's scatter distance used to run
//      10->56px — 10px sits INSIDE every ring this file draws (the plain
//      `strokeCircle(..., 14, ...)`, let alone the active tracer/highlight
//      ring's own ~19-25px pulse), so the glyphs spent the opening part of
//      the burst still overlapping the ring instead of visibly leaving it.
//      Distance is now `RING_RADIUS + RING_RADIUS*3*ease` (14 -> 56px, i.e.
//      exactly 1x -> 4x the same ring radius every other Pass-2 ring stroke
//      in this file uses) — glyphs now start AT the ring's own edge and
//      finish at 4x its radius, inside the spec'd 3-5x range. The end
//      distance (56px) is numerically unchanged; only the start moved from
//      inside the ring to its edge. "Only show celebration for the last
//      shot" was already true (Pass 5's own `active.index === steps.length -
//      1` gate, unchanged) — restated here because rolo's request named it,
//      not because anything about that gate changed.
//   3) BANNER LABEL EXCLUSION ("target NAME labels near the top of the
//      playfield get covered by the goal banner/pill" — the always-visible
//      `.map-goal-pill-row` is `position:absolute` OVER the canvas, per
//      map2d.css, not a sibling that pushes the canvas down). Pass 2.5's
//      ring-caption clamp used to be `Math.max(target.y - 13, topInset + 8)`
//      — that only ever pushes a too-high candidate position DOWN to
//      `topInset + 8`, which for a ring already at/below that line just
//      leaves the label exactly where it was computed, still possibly
//      overlapping the ring itself rather than flipping to its far side the
//      way drawActionLabel's caption already does. Pass 2.5 now flips to
//      `target.y + 26` (the same "below the ring" offset the old collision
//      fallback used) whenever the above-the-ring position would land inside
//      the reserved band, floored at `topInset + 8` either way so the result
//      can never land inside the band regardless of how close to the top the
//      ring itself sits. map2d.ts's zone-plate micro-labels
//      (drawPlayfieldArt's drawZoneLabel calls) and drawShotDots' ambient
//      major-shot labels get the analogous fix — see that file's own header.
//   4) ACTIVE-TARGET-ONLY DISPLAY ("only display the name of the target you
//      need to hit for that specific spot of all shots"). Pass 1/2/2.5 now
//      only ever process `active.index` — the currently-active step's own
//      leg/ring/badge/caption draws; every OTHER step's is suppressed
//      outright, not merely dimmed. The marching highlight now reveals one
//      target at a time instead of showing the whole goal's rings
//      simultaneously (base shot dots, drawn separately by map2d.ts's
//      drawShotDots, are UNAFFECTED — they stay). Pass 4's action label and
//      Pass 5's celebration already only ever read `active.index`, so they
//      needed no change to agree; map2d.ts's tap-to-identify hit-tests the
//      full shot list independent of any goal route and also needed no
//      change (see that file's own header). Route/leg drawing follows the
//      same gate: a non-active step's connector leg (and any rule-7/loop-coil
//      continuation chained off it) no longer draws either — a skillshot
//      goal already drew no legs at all (phase A10) and is unaffected in
//      substance, just in the mechanism that now also applies to every other
//      category. The old three-state active/done/quiet LEG treatment
//      (strokeActiveLeg survives; strokeQuietLeg/strokeDoneLeg are deleted)
//      and the ring/badge done-vs-quiet split for OTHER steps are retired
//      along with the steps they used to distinguish — there is only ever
//      the active step's own arrived-vs-still-flying microstate left to
//      show (drawBadge's checkmark still flashes on arrival, unchanged).
//
// 2026-08-11 (Feature 7, phase A14, "celebration intensity slider" — owner
// request: "Make the celebrations bigger... Create a slider that goes from
// 0 - no celebration to the slider all the way to the right with 7 emojis
// pop out or spiral way out of the circle and very noticeable at the right
// side. What we have now could be level 1. Have bigger celebrations that
// take up more screen the further right the toggle is selected."): the map
// settings popover's Feature 3 CELEBRATION on/off toggle becomes a 0-5
// intensity SLIDER (state.ts's `celebrationLevel`, superseding the boolean
// `celebration`). Level 0 is still expressed exactly as before — the caller
// passes `celebrate: null` and Pass 5 draws nothing — so the ARMING rules
// (once-per-arrival in manual mode, last-step-only, every-loop in auto
// mode) are completely untouched by this phase; only what gets drawn once
// armed changes. `celebrationParams(level)` (new, exported) is the single
// source of truth for how each level 1-5 scales the burst, read by both
// drawCelebrationBurst (the actual pixels) and drawGoalOverlay's Pass 5
// gate (the window `elapsedMs` must fall inside, since duration itself now
// scales too): glyph COUNT 8->14, glyph font SIZE 20->40px (2x), the radial
// REACH coefficient `k` in `dist = CELEBRATE_RING_RADIUS*(1+k*ease)` 3->15
// (i.e. the burst's max travel grows from 4x to 16x CELEBRATE_RING_RADIUS,
// 56px->224px — "way out of the circle, very noticeable"), an extra SPIRAL
// angular-drift term added on top of the existing shared `p*1.4*Math.PI` fan
// rotation starting at level 3 (0 below it — a plain radiating starburst,
// matching level 1/2's original look), and the hold DURATION 1800->2400ms
// ("up modestly" — still comfortably under HIGHLIGHT_HOLD_S's 2500ms
// auto-march hold, so a level-5 burst finishes before the tracer would move
// on). Level 1 reproduces every Feature 3 constant EXACTLY — same count,
// size, reach formula, duration, no spiral — so drawCelebrationBurst's
// level-1 output, and therefore every pre-Feature-7 test in this file's own
// suite that never passes `level` at all, stays byte-identical.
//
// 2026-08-11 (Feature 8, phase A15, "shot lines toggle" — owner request: "I
// think an on off button to remove the shot lines can be helpful. Then just
// the targets are displayed, it gives the user to just see each target shot
// without being confused with the line."): `o.shotLines` (state.ts's
// `shotLines`/setShotLines, default true) gates the WHOLE route-line
// subsystem for the WHOLE goal — false suppresses every flipper-anchored leg
// (Pass 1), every rule-7 feed continuation/loop coil (extLegs), AND the
// flying tracer ball (Pass 3, since a tracer needs a continuous path to fly
// — same reasoning any-order goals already established, see the 2026-08-02
// note a few paragraphs up). The per-step ring/badge/name-caption/action-
// label march exactly as before: none of Passes 2/2.5/3(dwell-only)/4/5 read
// this flag directly. SINGLE GATE POINT: `o.shotLines === false` makes
// `stepLinkSuppressed` (drawGoalOverlay, below — already the ONE predicate
// both Pass 1's leg-suppression and extLegs' rule-7/loop-coil gate read, per
// phase A10's own note above) return true for EVERY step regardless of
// category or authored `link` — the exact same "leg suppressed, ring/badge
// still marches" mechanism any-order goals and skillshot already use, just
// applied unconditionally. Skillshot goals were already legless by their own
// existing rule (phase A10) — this flag changes nothing about how they
// render, on or off. Default true reproduces today's exact behavior (a call
// site that omits the field, or every pre-existing test in this file's own
// suite, is completely unaffected).
//
// 2026-08-11 (phase A16, "celebration reach to 7 + canvas-relative travel" —
// owner, reviewing level 5/5: "the animation for celebration is all the same
// still. the celebration explosion needs to almost take up the entire screen
// when you chose 7/7."): two changes, both scoped to celebrationParams/
// drawCelebrationBurst (Pass 5's own drawing, below) and state.ts's
// celebrationLevel clamp (see that file's own phase A16 note) — the arming
// rules (once-per-arrival, last-step-only, every-loop-in-auto), reduced-
// motion fallback, and level-0-draws-nothing gate are all UNCHANGED.
//   1) RANGE 1-5 -> 1-7. celebrationParams' clamp, and the Pass-5 call
//      site's own `o.celebrate.level` clamp, both move their ceiling to the
//      new CELEBRATE_LEVEL_MAX (7). The level-1 anchor is untouched (count
//      8, px 20, durationMs 1800); the level-7 anchor is new: count 20, px
//      56, durationMs 3000. Every level 2-6 is a plain linear interpolation
//      between the level-1 and level-7 anchors (6 equal steps) — there is no
//      more per-level breakpoint table, just the one formula (see
//      celebrationParams' own doc comment for the exact arithmetic). Spiral
//      drift keeps its pre-A16 per-level coefficient (0.9π per level from
//      level 3 up) unchanged in FORM — it simply now runs two levels further
//      (4.5π at level 7, vs. 2.7π at the old level-5 ceiling), which is
//      already "stronger at 7" with no formula change needed.
//   2) REACH IS NOW CANVAS-RELATIVE — the actual fix the owner's report was
//      about: a level-5 burst maxing out at a FIXED 70px (5x the 14px ring
//      radius) reads as identical-looking "the same" on a phone-sized canvas
//      and a tablet-sized one, and can never "take up the entire screen" on
//      either, because it was never expressed in terms of the screen at all.
//      celebrationParams' `reachCoefficient` (a multiplier on
//      CELEBRATE_RING_RADIUS) is replaced by `reachFraction` — a fraction of
//      the CANVAS's own min(width,height), read via `ctx.canvas.clientWidth
//      || ctx.canvas.width` / `...clientHeight || ...height` (the exact same
//      "real CSS-px dimension, DOM-layout value preferred over the backing-
//      store pixel count" idiom Pass 2.5's ring-caption clamp and Pass 4's
//      action-label bubble already use a few hundred lines below — this
//      phase adds no new dimension-reading idiom to the file, it reuses the
//      established one). Level 1's reach is 0.10x canvas-min (close to, but
//      — since it now depends on the canvas instead of a fixed pixel value —
//      no longer byte-identical to, the pre-A14 Feature-3 burst); level 7 is
//      0.94x canvas-min, i.e. the scatter's own outer edge sweeps to within
//      6% of the canvas's shorter side — "almost take up the entire screen."
//      drawCelebrationBurst takes a new `canvasMin` parameter (resolved once
//      by its one caller, Pass 5, below) rather than reading `ctx.canvas`
//      itself, keeping the function a pure "given these numbers, draw"
//      routine like the rest of this file. The glyphs still start exactly AT
//      the ring's own edge regardless of level or canvas size
//      (CELEBRATE_RING_RADIUS, unchanged, phase A12 item 2's own invariant)
//      — only the OUTER end of the scatter is canvas-relative; the formula
//      is `dist = RING + (max(RING, reachFraction*canvasMin) - RING) * ease`,
//      which degrades to holding steady at the ring radius (never traveling
//      backward/inward as the burst progresses) on a degenerate near-zero
//      canvas instead of producing a negative or NaN travel distance.
//
// 2026-08-11 (phase A17, "reduced-motion was the actual bug" — owner report,
// a full day of "celebrations are all the same" despite the 0-7 canvas-
// relative (phase A16) rebuild being verifiably live): the REDUCED-MOTION
// branch below was still Feature 3's original single-glyph pulse, completely
// untouched by phases A14/A16 — fixed 28px font, fixed alpha-fade-from-1,
// never reading celebrationParams(level) at all. Every level looked
// IDENTICAL under prefers-reduced-motion because the code drawing it never
// once consulted `level`. Fixed the way the owner's brief for this phase put
// it: "keep honoring the preference by removing MOTION, not the FEATURE."
// drawCelebrationBurst's reduced-motion branch now draws the exact same
// `celebrationParams(level).count` glyphs at the exact same `.px` font size
// and the exact same canvas-relative `.reachFraction` outer distance as the
// animated path — frozen at that path's own FINAL pose (ease===1: the shared
// base+spiral angle at p===1, `dist===maxTravelPx`) instead of travelling
// there, and cross-faded by OPACITY ALONE (a ramp 0->1 over the first 30% of
// the level's own duration, held, then 1->0 over the last 30% — the same
// "0.3 of duration" tail shape the animated path's own alpha fade already
// uses, reused here for both edges instead of just one) — no position/
// rotation/scale change at any point, so "reduced motion" now means exactly
// what it says: motion is gone, intensity scaling is not. `maxTravelPx` (the
// shared outer-reach distance both branches read) is hoisted above the
// reduceMotion branch so the two paths — and the new diagnostic below — can
// never compute it differently. Also added: a one-line `console.debug` at
// the top of drawCelebrationBurst (every call, both branches) logging
// level/glyph-count/travel-px/canvas-min/reducedMotion — so a future "it
// looks the same" report is answerable by opening the console instead of
// re-deriving this whole investigation again. tests/celebrate.test.mjs's
// section e is reworked to match (level 1 vs level 7 under reduced motion
// now differ in count/px/reach, same as the animated path); sections
// b/c/d/f-m (the animated path) are untouched.
//
// Draws entirely in CSS px. devicePixelRatio scaling is the caller's job
// (`ctx.scale(dpr, dpr)` before calling in) — see CONTRACTS.md.
//
// Deviation from the native source (intentional, contract-driven): the
// shared `MapFn` here is `(u, v) => {x, y}` — non-nullable, per CONTRACTS.md
// — whereas the native `map` closure returns an optional point and every
// call site has an explicit "control point fell outside the frame, degrade
// to a straight bow" fallback. Since a MapFn can never return `null`/`undefined`
// under this contract, those fallback branches are reachable only if a future
// homography-backed MapFn (ar/*) produces non-finite numbers (e.g. dividing
// near the vanishing line); this file keeps the fallback path alive by
// checking `Number.isFinite` on mapped control points instead of null.

import type { BallPosition, FeedRef, Goal, GoalCategory, MapFn, PlayfieldZone, Shot } from '../models'
import { BALL_ANCHORS } from '../models'
import {
  ARCH_ENTRY_UV,
  DEFAULT_LAUNCH_UV,
  feedForTrim,
  FLIPPER_ANCHORS,
  FLIPPER_SNAP,
  LANE_BOTTOM_V,
  LANE_MAX_X,
  LANE_MIN_X,
  LANE_TOP_V,
  resolveFeedUV,
  resolveShootingAnchor,
  synthesizeApex,
} from './shotgeom'
import type { ShootingAnchor } from './shotgeom'
// Re-exported for compatibility — these used to be defined in this file;
// they now live in ./shotgeom.ts (the single pure geometry module both this
// file's routing and map2d.ts's background art import their shot geometry
// from, per shotgeom.ts's own header comment) and are imported back in
// above. Re-exporting keeps any existing importer of this file compiling
// unchanged even though the symbols moved.
export {
  ARCH_ENTRY_UV,
  chooseFlipper,
  DEFAULT_LAUNCH_UV,
  FLIPPER_ANCHORS,
  FLIPPER_SNAP,
  LANE_BOTTOM_V,
  LANE_MAX_X,
  LANE_MIN_X,
  LANE_TOP_V,
  resolveFeedUV,
  synthesizeApex,
} from './shotgeom'

export interface OverlayOpts {
  shotsByID: Map<string, Shot>
  goal: Goal
  stepIndex: number
  ballPosition: BallPosition
  map: MapFn
  time: number // ms, for tracer/marching-highlight animation. Relative to
  // whatever epoch the caller anchors to (state.ts's routeStartedAt, once the
  // AR/Map surfaces are updated to subtract it — see shotcoach-corrections.md
  // #9) — this file does no subtraction of its own, it just treats `time` as
  // the clock tracerAt/autoHighlightIndex evaluate against.
  /** Gates ONLY Pass 4's action-label bubble (the rounded "what to do" pop-up
   *  pinned to the top band) — no effect on routing/rings/badges. As of
   *  2026-08-11 (phase A13 — rolo: "if you remove path bubbles from the map
   *  setting only remove the bubble; keep the name of the targets popping
   *  up") it also has no effect on Pass 2.5's ring caption: the active
   *  target's NAME label always draws now, same as its ring/badge — see that
   *  pass's own note. Default true (omitting this field reproduces the exact
   *  prior bubble behavior, so overlay/map2d.ts's existing call site is
   *  unaffected). Wired from the AR/Map settings popover's "Path labels"
   *  toggle (DESIGN-NOTES §5). Additive/optional — not a geometry change. */
  showLabels?: boolean
  /** Multiplier on Pass 1's connector-line/arrowhead stroke alphas only —
   *  rings, badges, and the label bubble are untouched, matching the raw
   *  design's `br` scope exactly (`Pinball Genie AR.dc.html`'s `drawPlay`:
   *  `br` only ever multiplies leg/arrowhead alpha, never ring/badge/label
   *  alpha). Default 1 reproduces the exact prior behavior (omit this field
   *  and every stroke alpha below is unchanged). Design range 0.4-1.8;
   *  callers are expected to pass the raw slider value — this file clamps
   *  each product to a max of 1 per-site, exactly like the design's
   *  `Math.min(1, ...)` guards, rather than clamping the input itself.
   *  Wired from the AR settings popover's "Line brightness" slider
   *  (DESIGN-NOTES §5/§9 "Settings popover"). Additive/optional — not a
   *  geometry change. */
  lineBrightness?: number
  /** Manual highlight override. When a number, the marching highlight parks on
   *  this step (clamped to [0, steps.length-1]) — no ball, no impact flash —
   *  instead of auto-walking/flying the sequence; the pulse still animates in
   *  place, and Pass 1's done-leg treatment now applies too (steps before
   *  this one read as "already flown" — shotcoach-corrections.md #10's
   *  "manual bypass shape"). Omit/null for the auto default (tracer when
   *  `ballTracer` is on, the old autoHighlightIndex walk when it's off). */
  highlightIndex?: number | null
  /** prefers-reduced-motion, resolved by the CALLER and threaded in (this
   *  file draws pixels from what it is handed; the media query lives with the
   *  render loop that has to re-render when it changes — overlay/map2d.ts's
   *  `reduceMotion` live matchMedia).
   *
   *  WHAT IT REMOVES, and nothing else — the feature survives, only the
   *  motion goes (the same rule ui/sheet.css and .study-learn-panel already
   *  follow):
   *    - the marching-dash offset freezes (t -> 0 into strokeActiveLeg, so
   *      the dash pattern and the neon sheen both stop travelling),
   *    - the flying tracer ball + its comet are replaced by the existing
   *      STEPPED highlight (`ballTracerOn` forced false), which still
   *      AUTO-ADVANCES step to step on HIGHLIGHT_HOLD_S — a user who asked
   *      for less motion did not ask to lose the walkthrough,
   *    - the ring's sine pulse freezes (same t -> 0) and its cross-fade-in
   *      lands fully bloomed (`ease` -> 1) instead of animating up.
   *  The celebration burst has its own long-standing guard inside Pass 5
   *  (it reads the media query directly and draws one static frame); this
   *  flag deliberately does not touch that clock.
   *
   *  Default false/undefined reproduces today's exact render. */
  reducedMotion?: boolean
  /** `'dash'` (default) is the shipping marching-dash look, unchanged from
   *  before Shot Coach. `'neon'` is the new bloom/body/core/travelling-sheen
   *  treatment (README §1c). Independent of `ballTracer` — not a 3-way. */
  trailStyle?: 'dash' | 'neon'
  /** Default true. Flies a constant-speed tracer ball the whole route
   *  (tracerAt) and adds the three-state active/done/quiet leg treatment.
   *  false reproduces the pre-Shot-Coach two-state (highlighted/quiet) look
   *  driven by autoHighlightIndex, with no ball/comet/impact-flash — see the
   *  file header's ActiveState note. Manual mode (`highlightIndex` set)
   *  always bypasses the flying ball regardless of this flag. */
  ballTracer?: boolean
  /** Feature 8 (2026-08-11, phase A15) — master ON/OFF for the WHOLE
   *  route-line subsystem (owner: "an on off button to remove the shot
   *  lines... just the targets are displayed"). Default true reproduces
   *  today's exact behavior (omitting this field takes none of this
   *  phase's new code — see the file header's own Feature 8 note). false
   *  suppresses every step's connector leg (Pass 1), rule-7 feed
   *  continuation/loop coil (extLegs), and the flying tracer ball (no line
   *  to fly along) for the WHOLE goal, regardless of category or any
   *  per-step `link` — the per-step ring/badge/name caption still march
   *  exactly as before. Wired from the map settings popover's "Shot lines"
   *  toggle (same buildToggleRow recipe as "Ball tracer"/"Path labels").
   *  Additive/optional — not a geometry change. */
  shotLines?: boolean
  /** CSS-px band reserved at the TOP of the canvas (AR's header-pill HUD,
   *  the Map's goal pill — map2d.css's `.map-goal-pill-row` is
   *  `position:absolute` OVER the canvas, not a sibling that pushes it down,
   *  so this is a real exclusion zone, not just visual tidiness) that the
   *  active step's ring caption and action-label bubble must clear. The
   *  caption (Pass 2.5) flips to below the ring instead of colliding with
   *  the band when the default above-the-ring position would land inside it
   *  (phase A12 item 3, 2026-08-11 — see the file header note); the action
   *  bubble (Pass 4) is unconditionally PINNED to the band itself, not
   *  ring-relative (README §1f, then rolo's later 2026-07-31 "stomps over
   *  the targets" fix — see drawActionLabel's own doc comment). Default 0
   *  (omitting this field reproduces the exact prior behavior — nothing to
   *  clear). */
  topInset?: number
  /** Per-model feed resolution (dataset schema v5, phase A3 2026-08-10) —
   *  which trim's `feedsByTrim` override (if any) wins when resolving a
   *  step's ramp/orbit/loop continuation (rule 7), via shotgeom.ts's
   *  feedForTrim. Resolved internally as `o.trim === 'pro' ? 'pro' :
   *  'premium-le'` — the same back-compat-safe default state.ts's own
   *  AppState.trim field defaults to, so an unrecognized value or an omitted
   *  field both reproduce today's (pre-A3) render. Does NOT affect shot
   *  VISIBILITY here — this file draws whatever shotsByID/goal it's handed;
   *  overlay/map2d.ts's render() is what filters the shot roster before
   *  calling in (state.trim, the same value, passed straight through).
   *  Typed as a bare `string` rather than the narrower 'pro'|'premium-le'
   *  union so this options bag doesn't have to import state.ts's literal
   *  type. */
  trim?: string
  /** Raised/sunken playfields (dataset schema v5, phase A4 2026-08-10) — see
   *  models.ts's PlayfieldZone doc comment. Optional/additive: omitting this
   *  (or passing an empty array) reproduces EXACTLY the pre-A4 route/anchor
   *  behavior — the same-playfield direct-line guard and the deck-bat
   *  launch/anchor overrides are both gated on this being present AND
   *  non-empty, so every one of the ~139 zone-less machines renders
   *  byte-identical to before this phase. A machine's own `GameData.playfields`
   *  array, passed straight through by the caller (overlay/map2d.ts's
   *  render()). */
  playfields?: PlayfieldZone[]
  /** Map-scoped celebration burst (phase A11, 2026-08-11) — see the file
   *  header's own note. Omit/null: draws nothing, ever (celebration pref
   *  OFF, or the caller has nothing to celebrate with). Non-null: Pass 5
   *  draws the burst whenever the ACTIVE step is this goal's LAST step —
   *  gated internally on which highlight mode is driving (see
   *  `manualStartedAt`'s own doc comment for the manual-mode half). Feature
   *  7 (2026-08-11, phase A14) added the `level` sub-field below — the
   *  on/off toggle this used to be gated by is now a 0-5 intensity slider,
   *  with 0 expressed by the CALLER passing `celebrate: null` outright
   *  (map2d.ts never builds this object at level 0), so `level` itself is
   *  never observed <= 0 in practice; Pass 5's own gate below treats <=0
   *  defensively the same as null anyway. */
  celebrate?: {
    /** The resolved emoji to scatter — ui/fxGlyphs.ts's glyphFor(goal.fx ??
     *  data.defaultFx), resolved by the CALLER. This file doesn't know
     *  about GameData.defaultFx and deliberately doesn't import
     *  ui/fxGlyphs.ts — drawing.ts draws pixels from data it's handed, it
     *  doesn't resolve fx-theme names (the same division of labor
     *  CATEGORY_COLOR already draws on `o.goal.category`, which — unlike
     *  the fx glyph — needs no data outside this options bag). */
    glyph: string
    /** Celebration intensity, 1-7 (Feature 7, 2026-08-11, phase A14; range
     *  widened 1-5 -> 1-7, and reach made canvas-relative, in phase A16 the
     *  same day) — see state.ts's `celebrationLevel` doc comment and
     *  celebrationParams below for exactly how each level scales the burst.
     *  Omitted (every pre-Feature-7 call site, including most of this
     *  suite's existing tests) defaults to 1 — Feature 3's original count
     *  (8 glyphs), size (20px), and hold (CELEBRATE_DURATION_MS, 1800ms),
     *  with no spiral drift, all reproduced exactly; the travel distance is
     *  now `0.10 * canvas-min` (phase A16) rather than the old fixed
     *  `1x->4x CELEBRATE_RING_RADIUS`, so level 1 is close to but no longer
     *  BYTE-IDENTICAL to the pre-Feature-7 burst pixel-for-pixel. */
    level?: number
    /** MANUAL-mode-only arming timestamp, in the same relative-ms clock
     *  space as `time`. AUTO/tracer mode ignores this entirely — it times
     *  the burst off the tracer's own per-step `sinceHit`, which already
     *  resets every loop cycle with no caller bookkeeping needed. Manual
     *  mode (`highlightIndex` a finite number) has no such clock
     *  (resolveActiveState parks `sinceHit` null there), and "celebrate
     *  ONCE per arrival, never while sitting, re-arm on leaving/returning
     *  or picking another goal" is an edge-triggered rule this stateless
     *  function has no cross-frame memory to enforce — so in manual mode
     *  the burst draws ONLY while this is a finite number, timed as
     *  `o.time - manualStartedAt`. The caller's arming state machine
     *  (map2d.ts's mountMap2D closure) owns entirely WHEN this is set vs
     *  cleared; this file just draws however many elapsed ms it's given. */
    manualStartedAt?: number | null
  } | null
}

type Pt = { x: number; y: number }

// ---- category colors (Models.kt GoalCategory.color — "iOS system palette,
// matching the SwiftUI colors used on iPhone"). ----
//
// THIS IS A MIRROR, NOT A SOURCE. app/src/styles.css's :root block is the
// single source for every colour this app ships (see its header comment); the
// nine --cat-* custom properties there are the authority, and this table
// copies them. The copy exists because CanvasRenderingContext2D.fillStyle
// takes a colour string and cannot resolve a CSS custom property —
// CATEGORY_META's colors (ui/goalMeta.ts) are `var(--cat-skillshot)`-style
// strings, fine for DOM styles, useless to canvas.
//
// app/tests/tokens.test.mjs is the gate: it reads both files and fails if any
// --cat-* hex here differs from styles.css. (That parity check lived in
// pathless-goals.test.mjs until 2026-08-14; it moved so every palette gate —
// these nine, plus src/theme.ts's canvas-surface mirror — has one home.)
// TypeScript enforces that a category KEY exists; only that test can enforce
// that the VALUE matches.
//
// Exported (2026-07-28 Shot Coach, additive) so ./map2d's card background can
// paint a goal-category-colored glow through the same canvas gradient API.
// The other canvas-side colour mirrors (playfield card gradient, letterbox)
// live in src/theme.ts, not here — this table stays put because its consumers
// are drawing.ts-internal.
export const CATEGORY_COLOR: Record<GoalCategory, string> = {
  // BACKGLASS (P5, 2026-08-14): the nine iOS-system hexes these replace were
  // uneven in perceived brightness (Lhk span 19.3) and one of them
  // (progression) failed a contrast floor outright. This set is banded on
  // Helmholtz-Kohlrausch corrected lightness — see styles.css's --cat-* block
  // and design3/BACKGLASS-NOTES.md §3 for the derivation. Do not touch one of
  // these without its --cat-* twin: tokens.test.mjs compares the two tables
  // hex-for-hex and fails the build on any drift.
  skillshot: '#00cf5d',
  combo: '#ff6b26',
  multiball: '#ff4f5e',
  mode: '#33c2ff',
  multiplier: '#bf47ff',
  wizard: '#dcc200',
  strategy: '#00d3c1',
  // Mirrors styles.css's --cat-secret (#ff3fa4) — same lockstep rule as every
  // entry above, enforced by tokens.test.mjs (see this table's header).
  secret: '#ff3fa4',
  // Mirrors --cat-progression (#5e5ce6). In practice
  // nothing in this canvas renderer ever draws a 'progression' goal, because
  // those are pathless (no steps, so no route) and the Map tab's picker omits
  // them entirely — but the Record<GoalCategory, string> type requires the key,
  // and leaving it out would be a compile error rather than a silent gap.
  progression: '#788eff',
}

/** The "step already flown" badge fill. Was `#34c759` (Color(0xFF34C759),
 *  mirroring the native source, and the same literal the old skillshot
 *  category used). BACKGLASS (P5, 2026-08-14) moves it onto the new insert
 *  family's green — the same value as --cat-skillshot again, and for the same
 *  reason it matched before: BACKGLASS-NOTES §2 says there is no second
 *  structural accent, so a success colour comes from the category family or
 *  it does not exist. Kept as its OWN constant, not a CATEGORY_COLOR lookup,
 *  because "done" is a state, not a category — if the family's green ever
 *  moves for category reasons, this is free to stay put. */
const DONE_COLOR = '#00cf5d'

const FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`

// Emoji shot-type glyph chips (SHOT_TYPE_GLYPH, Shot Coach README §1e)
// REMOVED 2026-07-29 — rolo: emoji on the playfield read as clutter, too
// distracting. The chips, the `emojiMarkers` option/state/pref, and the AR
// settings toggle are all gone; git history has the table if it's ever
// wanted back. Goal-LIST emoji (ui/fxGlyphs.ts menu rows) are unaffected —
// they never drew on the playfield.

/** models.ts's BALL_ANCHORS uses {u, v}; this file's routing math uses {x, y}. */
function anchorToPt(anchor: { u: number; v: number }): Pt {
  return { x: anchor.u, y: anchor.v }
}

// Tombstone (kept for spec/port history only — SPEC-PATHVIZ's original
// fixed "flipper-zone return waypoint"). Superseded 2026-07-29 by rule 6:
// viaWaypoint's waypoint is now FLIPPER_ANCHORS[chosenFlipper] (chosen
// per-segment — see chooseFlipper/routeSegment below), never this flat
// point.
// const RETURN_WAYPOINT_UV: Pt = { x: 0.5, y: 0.06 }

const OBSTACLE_TYPES = new Set(['mech', 'bumpers', 'bumper', 'captive-ball', 'captive'])

// ---- small color/geometry helpers ----

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Kotlin `Long.mod` / non-negative modulo (JS `%` can return negatives). */
function positiveMod(n: number, m: number): number {
  return ((n % m) + m) % m
}

/** Numeric clamp — kept local rather than pulling in a utils module. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

// ---- marching highlight cadence (fallback path only, see ActiveState below)
// — the single source of "which step is the auto-walking highlight on at
// time t" when ballTracer is off, shared by drawGoalOverlay's own fallback
// AND overlay/map2d.ts's / ar/arview.ts's ‹ › controls. ----
export const HIGHLIGHT_HOLD_S = 2.5 // was 1.0 — slower shot-to-shot cadence
const HIGHLIGHT_EASE_S = 0.3 // was 0.2 — gentler cross-fade

/** Index the auto-marching highlight is on at `timeMs` for `stepCount` steps.
 *  Returns 0 when stepCount <= 0 (guards mod-by-zero). Still exported/used
 *  directly by overlay/map2d.ts and ar/arview.ts for their own ‹ › base index
 *  outside of drawGoalOverlay (e.g. before a goal is drawn at all). */
export function autoHighlightIndex(timeMs: number, stepCount: number): number {
  if (stepCount <= 0) return 0
  return positiveMod(Math.floor(timeMs / 1000 / HIGHLIGHT_HOLD_S), stepCount)
}

function fillCircle(ctx: CanvasRenderingContext2D, center: Pt, radius: number, color: string): void {
  ctx.beginPath()
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

function strokeCircle(
  ctx: CanvasRenderingContext2D,
  center: Pt,
  radius: number,
  color: string,
  lineWidth: number,
): void {
  ctx.beginPath()
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

// ---- Routing (SPEC-PATHVIZ) — legs straightened 2026-07-29 (see the header
// note); topology unchanged. ----

/** One leg of a lane route: the control point for the leg arriving AT toUV.
 *  The leg's origin is implicit — the previous leg's toUV, or the segment's
 *  own origin for the first leg (chained by the caller). `elevated` (rule 7,
 *  additive) flags a rampExtensionLegs leg — the entrance->apex->feed tail
 *  drawn with the dotted "ball-on-wireform" style instead of a normal
 *  connector; unset/false for every other leg in this file. */
type LaneLeg = { controlUV: Pt; toUV: Pt; elevated?: boolean }

type SegmentRoute =
  | { kind: 'direct'; controlUV: Pt }
  | { kind: 'viaWaypoint'; waypointUV: Pt; returnControlUV: Pt; shotControlUV: Pt }
  // `partial` (phase A6, additive): laneRoute's own classifyPlunge verdict for
  // THIS segment — true only for the Case A2 partial-plunge shape. Read by
  // flattenSegment to flag the resulting FlatSegment `easing:'decel'` (now
  // dormant — see routeSegment's `fromPlunger` branch); every other consumer
  // of a 'lane' route (legsForRoute) ignores it entirely.
  // `legs` (2026-08-11, phase A7): routeSegment always returns this EMPTY
  // now — a plunger-origin segment draws no lane leg any more (and, since
  // phase A12 item 1 removed drawPlungeGauge too, there is no other visual
  // plunge representation left either). Kept typed as
  // `LaneLeg[]` rather than narrowed to `never[]`/removed so legsForRoute's
  // switch and flattenSegment's shape stay untouched; see routeSegment's own
  // doc comment for the full rationale.
  | { kind: 'lane'; legs: LaneLeg[]; partial: boolean }

/** Straight-line control point: the chord midpoint. A quadratic Bézier whose
 *  control point sits at the midpoint of its own two endpoints degenerates
 *  exactly to a straight line — real pinball shot trajectories ARE straight;
 *  every leg this file used to bow was cosmetic curvature with no physical
 *  basis. The `bowControl` name is kept (rather than inlining `midpoint` at
 *  every call site) for port parity with the iOS/Android sources, which are
 *  being updated the same way. 2026-07-29. */
function bowControl(a: Pt, b: Pt): Pt {
  return midpoint(a, b)
}

/** Chord midpoint — the control point for every straight leg (see bowControl). */
function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Control point for a direct segment: the chord midpoint (straight line).
 *
 * 2026-07-29: the obstacle nudge — pushing the control perpendicular off the
 * chord, in whichever direction cleared first, until a quadratic sampled
 * along its length stayed OBSTACLE_CLEARANCE away from every obstacle — was
 * removed. A shot curving around a bumper/mech doesn't happen on a real
 * pinball table (the ball travels in a straight line until something hits
 * it), and the goal-data obstacle coordinates are approximate to begin with,
 * so "nudging around" one was cosmetic, not physical. `obstacles` and the
 * `Pt | null` return type are kept only so every call site (routeSegment,
 * laneRoute) keeps compiling unchanged; this function no longer returns
 * null. Restoring the pre-2026-07-29 body (git history) restores the old
 * nudge + blocked-both-sides-falls-back-to-null behavior.
 */
function directControl(a: Pt, b: Pt, obstacles: Pt[]): Pt | null {
  return midpoint(a, b)
}

// ---- Lane route (SPEC-PATHVIZ rule 5, added 2026-07-28) — the shooter-lane
// geometry a plunger-origin segment actually travels: plunger -> lane top ->
// (top arch / full-arch entry) -> target. UNCHANGED, additive only. ----
/** Which of laneRoute's cases a plunger-origin segment lands in, WITHOUT
 *  building its legs — factored out (2026-08-10, phase A2) so drawPlungeGauge
 *  (the visible plunge-strength cue drawn by drawGoalOverlay's Pass 1.5,
 *  DELETED 2026-08-11 phase A12 item 1 — see this file's header note) could
 *  read the exact same classification/height laneRoute itself used, instead
 *  of re-deriving it. Kept EXPORTED post-removal (phase A12) as the single
 *  source of plunge-strength truth for laneRoute/routeSegment AND for direct
 *  unit testing (tests/plunger-route.test.mjs), now that the gauge that used
 *  to make it observable is gone. 'caseA' (the lane-adjacent one-leg
 *  short-circuit, checked before any hint) and 'full' (an explicit
 *  `plunge:'full'`, the geometric band's non-partial side, or a high/
 *  over-the-top target) both read as a full send; only 'partial' carries a
 *  resolved stop height `v`. */
type PlungeClass = { kind: 'caseA' | 'full' } | { kind: 'partial'; v: number }

/**
 * `t`/`plungeHint` classify the case; `plungeTo` (models.ts GoalStep.plungeTo
 * doc comment, schema v5) only matters for the 'partial' result, where it is
 * the UV y the ball dies at in the shooter lane — an authored stop height
 * wins outright over the geometric default, clamped to [0.10, LANE_TOP_V].
 * An absent `plungeTo` reproduces the pre-2026-08-10 exit formula
 * `min(t.y + 0.06, 0.8)` byte-for-byte: that default is always <= 0.8 <
 * LANE_TOP_V (0.88), so the upper clamp bound never fires for it by
 * construction, and the lower bound (0.10) doesn't fire for any goal in this
 * repo's shipped data either — verified against plunger-route.test.mjs's
 * pre-existing partial-plunge assertions (section m2), which stay
 * byte-identical.
 *
 * EXPORTED (2026-08-11, phase A12 item 1 — plunge gauge removal): this used
 * to be reachable from tests only indirectly, through drawPlungeGauge's own
 * rendered SOFT/FULL PLUNGE label and fill height. With the gauge gone, this
 * is the only remaining way to observe classifyPlunge's/plungeTo's clamp
 * behavior at all, so tests/plunger-route.test.mjs now calls it directly.
 */
export function classifyPlunge(t: Pt, plungeHint?: 'partial' | 'full' | null, plungeTo?: number | null): PlungeClass {
  if ((t.x >= 0.9 && t.y <= 0.8) || (t.x >= 0.84 && t.y <= 0.6)) return { kind: 'caseA' }
  // Case A2 — PARTIAL PLUNGE (2026-08-02, rolo at Jaws): a light pull that
  // dies partway up the lane and drops into a lane-adjacent target (Jaws'
  // pops at (0.74,0.45)). Before this case these drew Case C: a full climb
  // over the arch — the map showed a hard plunge to the back of the playfield
  // for what is really a soft, short pull. Bands sized from the repo-wide
  // 2026-08-02 review: y<0.72 closes the 0.70–0.72 dead band (exactly one
  // goal, Popeye's skill wheel); x>=0.57 admits the Addams Thing eject (0.57)
  // and TFTC's guillotine bank (0.58) — never go below 0.56 or Stranger
  // Things' full-strength cross-table plunge regresses to a stub.
  // A step's explicit `plunge` hint beats the geometry both ways: some lanes
  // eject clear across the table at coordinates the bands would call partial
  // (James Bond's full-pull right orbit), and geometry cannot know pull
  // strength — only the data can.
  const partial = plungeHint === 'partial' || (plungeHint !== 'full' && t.x >= 0.57 && t.y < 0.72)
  if (!partial) return { kind: 'full' }
  return { kind: 'partial', v: clamp(plungeTo ?? Math.min(t.y + 0.06, 0.8), 0.10, LANE_TOP_V) }
}

/**
 * Chained legs for a plunger-origin segment from `o` to target `t`. `o` is
 * whatever the segment's real origin is (the plunger anchor for the launch
 * segment, or the previous step's target for a mid-sequence re-plunge) — NOT
 * necessarily on the lane's centerline, so `laneX` reprojects it there.
 * `plungeTo` (2026-08-10, phase A2, additive) is threaded straight through
 * to classifyPlunge — see its doc comment.
 *
 * Returns `partial` alongside the legs (2026-08-11, phase A6, additive) —
 * classifyPlunge's own verdict for this call, so routeSegment/flattenSegment
 * can flag the resulting FlatSegment `easing:'decel'` for the ball-tracer
 * without a second classifyPlunge call re-deriving what this function
 * already computed.
 *
 * 2026-08-11 (phase A7): routeSegment now discards this function's `legs`
 * outright — a plunger-origin segment draws no lane leg any more (see
 * routeSegment's `fromPlunger` branch) — and keeps only `partial`. The
 * case-by-case leg geometry below is left fully intact regardless: it is
 * still correct, still exercised (every call still runs the Case A/A2/B/C
 * branching to reach `partial`), and deleting working geometry code for a
 * currently-unused half of its output is not worth the churn.
 */
function laneRoute(
  o: Pt,
  t: Pt,
  obstacles: Pt[],
  plungeHint?: 'partial' | 'full' | null,
  plungeTo?: number | null,
): { legs: LaneLeg[]; partial: boolean } {
  const laneX = clamp(o.x, LANE_MIN_X, LANE_MAX_X)
  const cls = classifyPlunge(t, plungeHint, plungeTo)
  const partial = cls.kind === 'partial'
  if (cls.kind === 'caseA') {
    // Case A — target in/beside the lane: one straight leg.
    return { legs: [{ controlUV: midpoint(o, t), toUV: t }], partial }
  }
  if (cls.kind === 'partial') {
    const exit: Pt = { x: laneX, y: cls.v }
    return {
      legs: [
        { controlUV: midpoint(o, exit), toUV: exit },
        { controlUV: midpoint(exit, t), toUV: t },
      ],
      partial,
    }
  }
  const top: Pt = { x: laneX, y: LANE_TOP_V }
  if (t.y >= 0.72) {
    // Case B — high target: straight climb, then arch down onto it.
    const archControl: Pt = { x: (laneX + t.x) / 2, y: Math.min(0.99, Math.max(t.y, LANE_TOP_V) + 0.1) }
    return {
      legs: [
        { controlUV: midpoint(o, top), toUV: top },
        { controlUV: archControl, toUV: t },
      ],
      partial,
    }
  }
  // Case C — the full trip: straight climb, arch over the top into the
  // playfield, then descend to the target. (2026-07-29: this descent leg
  // used to get rule-3's obstacle nudge; directControl now always returns
  // the chord midpoint, so the descent is a straight leg like every other
  // non-arch leg — see directControl's doc comment.)
  const archControl: Pt = { x: (laneX + ARCH_ENTRY_UV.x) / 2, y: 0.97 }
  const descentControl = directControl(ARCH_ENTRY_UV, t, obstacles) ?? bowControl(ARCH_ENTRY_UV, t)
  return {
    legs: [
      { controlUV: midpoint(o, top), toUV: top },
      { controlUV: archControl, toUV: ARCH_ENTRY_UV },
      { controlUV: descentControl, toUV: t },
    ],
    partial,
  }
}

/**
 * Decide how one connector segment is routed:
 * - plunger-origin (SPEC-PATHVIZ rule 5) -> the LANE route, always, before
 *   any other rule — never direct, never the return route. UNTOUCHED by
 *   rule 6/7. 2026-08-11 (phase A7): the lane route's `legs` are now always
 *   empty (see this branch's own inline comment) — in practice this produces
 *   a `{kind:'lane', legs:[], partial}` SegmentRoute that draws no main
 *   polyline at all; `partial` (and therefore classifyPlunge) is still
 *   computed regardless — cheap, and simpler than carving a `partial`-less
 *   path out of laneRoute — even though nothing downstream of routeSegment
 *   reads it any more since drawPlungeGauge, its last consumer, was removed
 *   (phase A12 item 1; classifyPlunge is now exported for direct testing
 *   instead — see its own doc comment).
 * - launch segment -> DIRECT: a straight chord from the effective launch
 *   anchor to step 0's target (2026-07-29 — directControl used to nudge the
 *   control point around obstacles and could return null if both sides
 *   stayed blocked, falling back to the return route below; it now always
 *   returns the chord midpoint, so that fallback is unreachable in practice
 *   but the `if (control)` check/return-route path is left in place since
 *   directControl's return type is still `Pt | null`).
 * - AUTHORED direct (`direct`, phase A8, 2026-08-11 — rolo's route-truth
 *   rule) AND `samePlayfield` -> DIRECT: a straight chord straight from the
 *   PREVIOUS step's target to this one, no flipper anchor in between. This
 *   is the ONLY way a non-launch segment goes direct now — the old geometric
 *   "both shots upper-half and close together" heuristic that used to imply
 *   this is GONE (see the file header's phase A8 note for the full
 *   rationale and the blast radius on existing pins). `samePlayfield` still
 *   gates it exactly as it gated the old geometric exception: an authored
 *   `direct:true` never draws a straight line through a deck wall — a step
 *   whose predecessor sits on a DIFFERENT playfield falls through to rule 6
 *   below regardless of the authored flag (fail-soft: bad/surprising data
 *   degrades to the safe default, not a line through furniture).
 * - everything else (the default for every non-launch, non-direct segment,
 *   INCLUDING two shots sharing the same deck) -> rule 6: routed through
 *   `anchorUV` (the caller's resolveShootingAnchor result —
 *   FLIPPER_ANCHORS[side] for a main-playfield target, or a deck bat's own
 *   (x, y) for a target on a zone with one, phase A4) — snap-direct to a
 *   single straight leg when the origin is already within FLIPPER_SNAP of
 *   that anchor (6c — "a feed landing at the anchor still snap-directs", the
 *   ball genuinely already sits on its shooting flipper, unlike the killed
 *   heuristic above), otherwise the return route via that anchor as its
 *   waypoint (replacing the tombstoned fixed RETURN_WAYPOINT_UV).
 *
 * `samePlayfield` (phase A4, 2026-08-10, gate widened to cover authored
 * `direct` in phase A8): true unconditionally when the machine has no
 * `playfields` authored at all (or when either step's shot id doesn't
 * resolve) — every zone-less machine's `direct:true` steps are therefore
 * governed by `direct` alone, reproducing this function's pre-A4 same-
 * playfield behavior exactly.
 */
function routeSegment(
  fromUV: Pt,
  toUV: Pt,
  isLaunch: boolean,
  fromPlunger: boolean,
  obstacles: Pt[],
  anchorUV: Pt,
  direct: boolean,
  samePlayfield: boolean,
  plungeHint?: 'partial' | 'full' | null,
  plungeTo?: number | null,
): SegmentRoute {
  if (fromPlunger) {
    // 2026-08-11 (phase A7 — rolo, reviewing production: "I don't like the
    // plunger pull line representation, completely remove that... shots
    // need the flippers to complete, many times you can't just go right thru
    // the board"): a plunger-origin segment no longer draws ANY lane leg —
    // no climb, no arch, no descent. drawPlungeGauge (Pass 1.5) was the ONLY
    // visual plunge representation left after that — and it too was removed
    // 2026-08-11 (phase A12 item 1, this same day): there is now NO visual
    // plunge representation of any kind. laneRoute is still called here, in
    // full — its Case A/A2/B/C branching (and the classifyPlunge call inside
    // it) is exactly what `partial` (partial-vs-full + the A6 decel flag)
    // needs, and this file's own convention is "classify once, read
    // everywhere" (see fromPlungerAt's own hoisting note in drawGoalOverlay)
    // — but `legs` is discarded outright. flattenSegment reads an empty
    // `legs` array as "no main polyline for this segment" (see its own doc
    // comment) and skips the A6 `easing:'decel'` tag for the same reason (no
    // lane FlatSegment is ever produced to carry it any more — dormant, not
    // deleted; see tracerAt's own easing branch below).
    const { partial } = laneRoute(fromUV, toUV, obstacles, plungeHint, plungeTo)
    return { kind: 'lane', legs: [], partial }
  }
  if (isLaunch) {
    const control = directControl(fromUV, toUV, obstacles) ?? bowControl(fromUV, toUV)
    return { kind: 'direct', controlUV: control }
  }
  // 2026-08-11 (phase A8, rolo's route-truth rule): the OLD geometric
  // "both shots upper-half and close together -> direct" heuristic lived
  // here (bothUpper/close locals, now deleted). Direct topology now
  // requires an AUTHORED `direct:true` — see this function's own doc
  // comment above for the full rule and the file header for the blast
  // radius on pre-existing pins.
  if (direct && samePlayfield) {
    const control = directControl(fromUV, toUV, obstacles)
    if (control) return { kind: 'direct', controlUV: control }
  }
  if (Math.hypot(fromUV.x - anchorUV.x, fromUV.y - anchorUV.y) < FLIPPER_SNAP) {
    // Rule 6(c) — the ball is already effectively on the shooting anchor (a
    // main flipper, or — phase A4 — a deck bat); a detour through its own
    // near-coincident waypoint would be pointless. UNCHANGED by phase A8 —
    // this is flipper->target (the anchor IS the origin), not the killed
    // target->target heuristic.
    return { kind: 'direct', controlUV: bowControl(fromUV, toUV) }
  }
  return {
    kind: 'viaWaypoint',
    waypointUV: anchorUV,
    returnControlUV: bowControl(fromUV, anchorUV),
    shotControlUV: bowControl(anchorUV, toUV),
  }
}

/**
 * Rule 7's ramp continuation: two chained, straight legs — flagged
 * `elevated` — extending past `entranceUV` (the step's shot's own ring) to
 * its resolved feed point: entrance->apex (authored `shot.apex`, or
 * synthesized identically on every platform) then apex->feed. `stepFeeds`
 * (the GoalStep's own override) beats the per-trim `feedsByTrim[trim]`
 * override, which beats the shot's base `feeds` — feedForTrim's resolution
 * order (phase A3, 2026-08-10, threaded through via the `trim` parameter
 * below; every shot in the shipped data still resolves identically to the
 * pre-A3 `stepFeeds ?? shot.feeds`, since none yet author a `feedsByTrim`
 * override).
 * Returns null when nothing resolves (fail-soft: most shots have no feeds
 * at all, and an unresolvable ref is treated the same as an absent one) —
 * the caller then draws exactly as it did before this rule existed.
 *
 * D5 (2026-07-29 review): an authored `shot.apex` is used ONLY when it has
 * finite numeric x AND y (`isFinitePt`) — a partial object ({x} alone), a
 * malformed value, or a stray `{shot:...}`-shaped ref never resolves through
 * here; any of those fall back to synthesis exactly like a fully-absent
 * apex, instead of producing a NaN control point that drops the whole
 * extension.
 *
 * Synthesis formula amended (2026-07-29 review) — the crest can no longer
 * sit below the landing point: `apex.y = min(0.95, max(e.y+0.22, f.y+0.02))`.
 * The added `max(..., f.y+0.02)` only changes anything for upper-playfield
 * feeds (f.y well above the usual ~0.10 down-feed — e.g. Twilight Zone's
 * right-ramp feed, `{shot:"bridge-diverter"}` up at (0.32, 0.9), or Jaws'
 * lookout-tower-ramp at y=0.82); for a normal down-feeding ramp this is
 * byte-identical to the old `min(0.95, e.y+0.22)`. The formula itself now
 * lives in ./shotgeom.ts's synthesizeApex (2026-08-10, phase A1 extraction)
 * — this function just supplies entrance/feed and defers to it.
 *
 * Phase A5 (2026-08-11, CONTRACTS-PLAYFIELDS.md rule 5): the two elevated
 * legs ARCH — control y = apex.y+0.06, clamped to 0.99 — instead of the
 * plain chord-midpoint bowControl, when BOTH `shot.type` is 'orbit' or
 * 'loop' AND the resolved feed is far enough across the table
 * (`|feedUV.x - entranceUV.x| > 0.3`) to read as a real rail rather than a
 * short hop. Every other case — ramps regardless of feed distance, and a
 * short-hop orbit/loop whose feed sits nearby — keeps the straight chord:
 * "curves only for real rails" (the 2026-07-29 straightness amendment this
 * rule carves an exception into), not curvature for its own sake.
 */
function rampExtensionLegs(
  entranceUV: Pt,
  shot: Shot,
  stepFeeds: FeedRef | null | undefined,
  shotsByID: Map<string, Shot>,
  trim: 'pro' | 'premium-le',
): LaneLeg[] | null {
  const resolvedFeedRef = feedForTrim(shot, stepFeeds, trim)
  const feedUV = resolveFeedUV(resolvedFeedRef, shotsByID)
  if (!feedUV) return null
  // Phase A9 (2026-08-11, "feed-loop coil rendering" — models.ts
  // FeedRef.loop, schema v5): a resolving `loop` swaps the synthesized/
  // authored apex crest for a coil around the loop point instead — see
  // loopCoilLegs' own doc comment. `resolvedFeedRef?.loop` structurally
  // matches FeedRef (same optional x/y/shot shape), so resolveFeedUV's own
  // `shot` beats `x`/`y`, unresolvable-shot-is-absent resolution rules apply
  // identically to the loop waypoint as to the outer feed ref itself.
  // Absent/unresolvable (the overwhelming majority, including every feed
  // shipped before this phase) falls through to the pre-existing apex path
  // below, byte-identical to before this phase.
  const loopUV = resolveFeedUV(resolvedFeedRef?.loop, shotsByID)
  if (loopUV) return loopCoilLegs(entranceUV, loopUV, feedUV)
  const authoredApex = shot.apex
  const apexUV: Pt = authoredApex && isFinitePt(authoredApex) ? authoredApex : synthesizeApex(entranceUV, feedUV)
  const isRailShot = shot.type === 'orbit' || shot.type === 'loop'
  const crossesTable = Math.abs(feedUV.x - entranceUV.x) > 0.3
  const archY = Math.min(0.99, apexUV.y + 0.06)
  const leg1Control: Pt =
    isRailShot && crossesTable ? { x: (entranceUV.x + apexUV.x) / 2, y: archY } : bowControl(entranceUV, apexUV)
  const leg2Control: Pt =
    isRailShot && crossesTable ? { x: (apexUV.x + feedUV.x) / 2, y: archY } : bowControl(apexUV, feedUV)
  return [
    { controlUV: leg1Control, toUV: apexUV, elevated: true },
    { controlUV: leg2Control, toUV: feedUV, elevated: true },
  ]
}

function isFinitePt(p: Pt): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y)
}

// ---- Feature 4 / phase A9 (2026-08-11): loop-coil continuation ----------
// models.ts FeedRef.loop: "on the way to the feed point the ball physically
// WRAPS this element" — Jaws' shooter-lane plunge coiling around the
// fishing-reel spinner before dropping at the mini flipper is the reference
// case (data/jaws_goals.json). The loop point (a real, AUTHORED element the
// ball wraps) takes over the synthesized/authored apex's job of being the
// route's visual pivot — the apex formula plays no role when a loop
// resolves. Every leg produced here is flagged `elevated`, the SAME dotted
// "ball-on-wireform" style as the plain 2-leg case it replaces, and each
// coil sample is just one more `LaneLeg` — flattenSegment/tracerAt/Pass 1
// already chain an arbitrary number of elevated legs with no changes
// needed, so the tracer walks a coil exactly like it walks any other
// polyline.

/** Coil radius, in UV units — small enough to read as "wrapping one
 *  element" rather than a second loop shot of its own. */
const LOOP_COIL_RADIUS_UV = 0.035
/** How many full turns the coil sweeps — deliberately > 1 (not an exact
 *  lap) so the drawn spiral visibly overlaps itself once, reading as a
 *  wrap rather than a closed ring. */
const LOOP_COIL_TURNS = 1.25
/** Samples around the swept arc (parametric circle) — enough for a smooth-
 *  reading spiral once flattened through FLATTEN_SAMPLES-per-leg sampling;
 *  each consecutive pair becomes its own short straight LaneLeg below. */
const LOOP_COIL_SAMPLES = 16

/** LOOP_COIL_SAMPLES+1 points swept LOOP_COIL_TURNS around `center`, in UV
 *  space, starting at the angle FROM `center` TOWARD `entranceUV` — so the
 *  ball enters the coil heading roughly the direction it was already
 *  travelling from, rather than jumping to an arbitrary point on the
 *  circle. */
function loopCoilPoints(entranceUV: Pt, center: Pt): Pt[] {
  const startAngle = Math.atan2(entranceUV.y - center.y, entranceUV.x - center.x)
  const sweep = LOOP_COIL_TURNS * 2 * Math.PI
  const pts: Pt[] = []
  for (let i = 0; i <= LOOP_COIL_SAMPLES; i++) {
    const a = startAngle + sweep * (i / LOOP_COIL_SAMPLES)
    pts.push({ x: center.x + LOOP_COIL_RADIUS_UV * Math.cos(a), y: center.y + LOOP_COIL_RADIUS_UV * Math.sin(a) })
  }
  return pts
}

/**
 * entrance -> coil (around `loopUV`) -> feed, as a chain of elevated
 * LaneLegs: one straight chord onto the coil's first sample, one short
 * straight chord per consecutive pair of coil samples (LOOP_COIL_SAMPLES of
 * them), then one straight chord off the coil's last sample to the feed
 * point. Every leg keeps the same plain chord-midpoint control the rest of
 * this file uses for non-arch legs (rolo 2026-07-29's straightness
 * amendment) — the coil sweep itself is where all the visible curvature
 * lives, so the bookend legs deliberately stay simple rather than also
 * threading the orbit/loop arch rule (phase A5): every reference case for
 * this feature is a `type:'plunge'` shot, which the arch rule (gated on
 * shot.type being 'orbit'/'loop') would never have touched anyway.
 */
function loopCoilLegs(entranceUV: Pt, loopUV: Pt, feedUV: Pt): LaneLeg[] {
  const coil = loopCoilPoints(entranceUV, loopUV)
  const legs: LaneLeg[] = [{ controlUV: bowControl(entranceUV, coil[0]!), toUV: coil[0]!, elevated: true }]
  for (let i = 0; i < coil.length - 1; i++) {
    legs.push({ controlUV: midpoint(coil[i]!, coil[i + 1]!), toUV: coil[i + 1]!, elevated: true })
  }
  legs.push({ controlUV: bowControl(coil[coil.length - 1]!, feedUV), toUV: feedUV, elevated: true })
  return legs
}

// ---- Flattening (NEW, 2026-07-28 Shot Coach — README §1a) ----
//
// Routing decides WHERE a segment goes (routeSegment, above); flattening
// decides HOW MANY pixels of polyline represent it, so a tracer ball can
// walk it at constant speed. Everything downstream of routeSegment changed
// in the 2026-07-28 Shot Coach work; routeSegment itself did not (leg
// CURVATURE was later removed 2026-07-29 — see the header note).

export interface FlatSegment {
  pts: Pt[]
  cum: number[]
  len: number
  /** Rule 7 (additive): `pts` index where the FIRST surviving elevated
   *  (ramp-continuation) leg's samples begin — `pts[rampIdx - 1]` is the
   *  shared entrance-ring point, `pts[rampIdx..]` is the entrance->apex->
   *  feed tail. undefined when this segment has no surviving extension
   *  (the overwhelmingly common case — most shots have no `feeds` at all). */
  rampIdx?: number
  /** Phase A6 (2026-08-11, additive): 'decel' when this WHOLE segment is a
   *  partial-plunge LANE route (classifyPlunge's 'partial' case — see
   *  laneRoute's `partial` return field, threaded through routeSegment's
   *  'lane' SegmentRoute). tracerAt eases this segment's raw time-fraction
   *  `u` through `1-(1-u)**2` before sampling position (a soft pull leaves
   *  the plunger fast and decelerates climbing the lane, instead of
   *  travelling at the same constant screen-speed every other leg in this
   *  file uses) — see tracerAt's own call sites below. undefined (the
   *  overwhelming majority of segments) reproduces the exact prior linear
   *  time-to-arc-length mapping. */
  easing?: 'decel'
}

/** Samples each quadratic Bézier as 22 view-space points (README §1a) and
 *  appends them to `out`. */
const FLATTEN_SAMPLES = 22

function sampleQuadInto(out: Pt[], a: Pt, c: Pt, b: Pt, n: number): void {
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const mt = 1 - t
    out.push({ x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y })
  }
}

function buildFlat(pts: Pt[]): FlatSegment {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  }
  return { pts, cum, len: cum[cum.length - 1]! }
}

/** A FlatSegment covering `f.pts[i0..i1]` (inclusive), with `cum` re-based
 *  to start at 0 at `i0` — no re-sampling, just a view onto the existing
 *  arc-length table. Used (Pass 1, rule 7) to split a flattened polyline at
 *  `rampIdx` into its "main" (entrance-bound) and "rampPart" (elevated
 *  entrance->apex->feed tail) pieces for independent stroke treatments. */
function sliceFlat(f: FlatSegment, i0: number, i1: number): FlatSegment {
  const pts = f.pts.slice(i0, i1 + 1)
  const base = f.cum[i0]!
  const cum = f.cum.slice(i0, i1 + 1).map((c) => c - base)
  return { pts, cum, len: cum[cum.length - 1]! }
}

/** A routed segment's legs, in UV space, as an ordered chain — the same
 *  per-kind unpacking drawRoute used to do while stroking directly, now used
 *  by flattening instead. `toUV` is threaded in because 'direct' routes
 *  don't carry their own target (the caller already has it). */
function legsForRoute(route: SegmentRoute, toUV: Pt): LaneLeg[] {
  switch (route.kind) {
    case 'direct':
      return [{ controlUV: route.controlUV, toUV }]
    case 'viaWaypoint':
      return [
        { controlUV: route.returnControlUV, toUV: route.waypointUV },
        { controlUV: route.shotControlUV, toUV },
      ]
    case 'lane':
      return route.legs
    default: {
      const exhaustive: never = route
      return exhaustive
    }
  }
}

/** Lane-route degenerate-leg threshold, in view units (CSS px / pt / dp —
 *  SPEC-PATHVIZ rule 5, "Degenerate legs"). A leg shorter than this is a
 *  same-spot hop (e.g. the plunger anchor sitting on/near the plunge ring)
 *  and is skipped entirely — chaining still walks through its endpoint so
 *  surviving legs stay geometrically connected. */
const DEGENERATE_LEG_MIN_PX = 1

/**
 * Map + flatten one routed segment into a view-space polyline. Mirrors the
 * old drawRoute's per-kind view-space mapping, non-finite-junction fallback
 * (collapse the WHOLE segment to one straight bow, same as before — a bad
 * waypoint/junction taints every leg through it), and degenerate-leg skip —
 * just producing points instead of issuing stroke calls directly. Returns
 * null when nothing survives to draw (all legs degenerate, or — 2026-08-11
 * phase A7 — a plunger-origin segment with no surviving extension either),
 * matching the old "segment draws nothing" case.
 *
 * `extLegs` (rule 7, additive) is rampExtensionLegs' output for THIS step,
 * appended after the main route reaches the entrance ring. Its finiteness is
 * checked SEPARATELY from the main route's own junctions (above) so a bad
 * elevated point drops just the extension — the main leg(s), real or
 * fallen-back-to-a-bow, are completely undisturbed either way. The extension
 * is normally only attempted when the main route actually produced points
 * (an entrance ring with nothing drawn for it has nothing to extend past) —
 * EXCEPT for a plunger-origin segment (`route.kind==='lane'` with `legs`
 * forced empty, phase A7), which seeds a single point at the entrance ring
 * (`toView`) with nothing stroked to reach it, specifically so a plunge
 * TARGET's own post-landing continuation (e.g. a full-send shot that feeds
 * the flippers) can still be appended below — the removed lane climb and the
 * (unrelated) post-landing continuation are orthogonal; see routeSegment's
 * own doc comment. drawGoalOverlay's Pass 1 additionally checks
 * `main.pts.length > 1` before stroking, so this seed-only point never emits
 * an empty moveTo-with-no-lineTo draw call.
 */
function flattenSegment(
  fromView: Pt,
  toView: Pt,
  toUV: Pt,
  route: SegmentRoute,
  map: MapFn,
  extLegs?: LaneLeg[] | null,
): FlatSegment | null {
  const legs = legsForRoute(route, toUV)
  const mappedLegs = legs.map((leg) => ({
    control: map(leg.controlUV.x, leg.controlUV.y),
    target: map(leg.toUV.x, leg.toUV.y),
  }))
  let pts: Pt[]
  let chainOrigin: Pt
  if (mappedLegs.some((leg) => !isFinitePt(leg.control) || !isFinitePt(leg.target))) {
    const control = bowControl(fromView, toView)
    pts = [fromView]
    sampleQuadInto(pts, fromView, control, toView, FLATTEN_SAMPLES)
    chainOrigin = toView
  } else if (legs.length === 0) {
    // 2026-08-11 (phase A7): a plunger-origin segment (routeSegment's 'lane'
    // kind, `legs` forced empty — see its own doc comment) draws no main
    // polyline of its own. `pts` starts with just the entrance-ring point
    // (`toView`, the plunge target) rather than empty, so a surviving rule-7
    // extension below still has the same shared "entrance" point to
    // continue from that every other kind relies on (see this function's
    // own doc comment) — drawGoalOverlay's Pass 1 skips stroking a 1-point
    // `main` so nothing actually renders for the (nonexistent) lane leg.
    pts = [toView]
    chainOrigin = toView
  } else {
    pts = []
    chainOrigin = fromView
    for (const leg of mappedLegs) {
      const length = Math.hypot(leg.target.x - chainOrigin.x, leg.target.y - chainOrigin.y)
      if (length >= DEGENERATE_LEG_MIN_PX) {
        if (pts.length === 0) pts.push(chainOrigin)
        sampleQuadInto(pts, chainOrigin, leg.control, leg.target, FLATTEN_SAMPLES)
      }
      chainOrigin = leg.target
    }
    if (pts.length === 0) return null
  }

  let rampIdx: number | undefined
  if (extLegs && extLegs.length > 0) {
    const mappedExt = extLegs.map((leg) => ({
      control: map(leg.controlUV.x, leg.controlUV.y),
      target: map(leg.toUV.x, leg.toUV.y),
    }))
    if (!mappedExt.some((leg) => !isFinitePt(leg.control) || !isFinitePt(leg.target))) {
      let extOrigin = chainOrigin
      for (const leg of mappedExt) {
        const length = Math.hypot(leg.target.x - extOrigin.x, leg.target.y - extOrigin.y)
        if (length >= DEGENERATE_LEG_MIN_PX) {
          if (rampIdx === undefined) rampIdx = pts.length
          sampleQuadInto(pts, extOrigin, leg.control, leg.target, FLATTEN_SAMPLES)
        }
        extOrigin = leg.target
      }
    }
  }
  // 2026-08-11 (phase A7): the `legs.length===0` branch above seeds `pts`
  // with only the entrance point — if no extension leg survived either,
  // `pts.length` is still exactly 1: nothing at all to draw, the same
  // "nothing survived" result the pre-existing `=== 0` check above already
  // covered for every other kind (that branch's `pts` is always either 0 or
  // >=23 — see its own comment — never 1), so widening it to `<= 1` here
  // changes nothing for any pre-existing case.
  if (pts.length <= 1) return null

  const flat = buildFlat(pts)
  const withRamp = rampIdx !== undefined ? { ...flat, rampIdx } : flat
  // Phase A6 (2026-08-11, additive): a partial-plunge lane route (laneRoute's
  // own classifyPlunge verdict, carried on `route.partial`) flags the WHOLE
  // flattened segment 'decel' — read by tracerAt below to ease the flying
  // ball's progress. Every other route kind (direct/viaWaypoint) and every
  // non-partial lane route (Case A/B/C — a full send) leaves `easing`
  // undefined, reproducing the exact prior linear progress. `legs.length > 0`
  // (2026-08-11, phase A7) additionally excludes a plunger-origin segment —
  // there is no lane climb left in `pts` to ease (at most an unrelated
  // post-landing extension survives), so this never fires for one any more
  // even when `route.partial` is true; the tag simply has no lane
  // FlatSegment left to land on (tracerAt's own decel branch is dormant, not
  // deleted — see its own one-line note).
  return route.kind === 'lane' && route.partial && legs.length > 0 ? { ...withRamp, easing: 'decel' } : withRamp
}

/** Point on a flattened polyline at arc-length `dist` (clamped to
 *  [0, flat.len]), with the tangent angle of the span it falls in. Exported
 *  for direct unit testing (tests/plunger-route.test.mjs). */
export function pointAt(flat: FlatSegment, dist: number): Pt & { angle: number } {
  const { pts, cum } = flat
  const d = clamp(dist, 0, cum[cum.length - 1]!)
  let i = 1
  while (i < cum.length - 1 && cum[i]! < d) i++
  const span = cum[i]! - cum[i - 1]! || 1
  const t = (d - cum[i - 1]!) / span
  const a = pts[i - 1]!
  const b = pts[i]!
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) }
}

// ---- Tracer schedule (NEW, 2026-07-28 Shot Coach — README §1b) ----

export interface TracerState {
  /** Segment being flown (or the one just landed on during dwell) — drives
   *  Pass 1/2's "active" leg/ring. */
  index: number
  /** Count of targets already reached this cycle — drives Pass 1/2's "done"
   *  (already-flown) treatment: `i < done`. */
  done: number
  /** Current ball position + heading while travelling; null during dwell. */
  ball: (Pt & { angle: number }) | null
  /** Fraction (0..1) travelled along `flats[index]` while travelling; null
   *  during dwell — Pass 3's comet-tail head is `u * flats[index].len`. */
  u: number | null
  /** ms since the tracer CROSSED the entrance ring — D8 (2026-07-29 review):
   *  "crossing" means traveled distance reached `flats[index]`'s "main"
   *  length (the arc length up to its `rampIdx` junction when a rule-7
   *  elevated entrance->apex->feed tail survived, else the whole `len`), NOT
   *  when the flight finishes. Null before that crossing; non-null from the
   *  instant it happens through the rest of travel (down the elevated tail,
   *  if any), the dwell at the feed point, and the end pause. The ball/dwell
   *  position itself is untouched by this — it still ends at the feed point,
   *  the ball really does travel there — only the RING's impact-flash timing
   *  (drawn at the fixed entrance point, Pass 2) is decoupled from it. */
  sinceHit: number | null
  /** True during the end-pause gap after the last target, before the cycle
   *  repeats. */
  finished: boolean
}

const TRACER_SPEED = 340 // px/s
const TRACER_DWELL_MS = 620
const TRACER_END_PAUSE_MS = 900
const TRACER_MIN_TRAVEL_MS = 220

/**
 * Where the tracer ball is at time `tMs`, and which step the HUD should
 * emphasize. EVERY segment gets a phase in the schedule, keyed by its
 * ORIGINAL index `i` — including degenerate (mapped `len < 1`) and absent
 * (`null`) ones. A real segment travels (`max(220, len/speed*1000)`) then
 * dwells, same as always; a degenerate/absent segment instead gets a
 * DWELL-ONLY phase: 0ms travel, `dwell` ms parked, `ball`/`u` null
 * throughout, `sinceHit` still counting up from arrival so the ring pulses/
 * flashes on its beat.
 *
 * 2026-07-28 degenerate-leg review, finding 1: this used to SKIP such
 * segments from the schedule entirely (shotcoach-corrections.md #4's
 * original fix, which only addressed the ball freezing on a near-zero
 * "flight" — `max(220, 0)` travel + a full dwell). That over-corrected: a
 * skipped segment never became the active `index`, so consecutive steps
 * referencing the SAME shot (or any same-spot hop) never got their ring/
 * action-text beat at all. Giving every index a phase — real or dwell-only —
 * fixes that, and finding 2's `done`/end-pause bug (done undercounting to
 * `phases.length` when phases.length was less than `flats.length`, so
 * already-flown real legs after a skipped one wrongly reverted to "quiet"
 * during the end pause) falls out for free: `phases.length` now always
 * equals `flats.length`, so `done` and the end-pause `index` (the LAST
 * array entry's original index) are correct without any special-casing.
 *
 * D8 (2026-07-29 review): each phase also carries `crossAt` — the instant
 * traveled distance reaches the segment's "main" length (up to its rule-7
 * entrance ring, `f.cum[f.rampIdx-1]`, when an elevated tail survived; `f.len`
 * itself otherwise, so `crossAt` collapses to the ordinary `dwellStart` and
 * nothing changes for the overwhelming majority of segments with no `feeds`
 * at all). `sinceHit` is measured from `crossAt`, not `dwellStart` — the
 * entrance ring's impact flash (Pass 2, drawn at the fixed entrance point)
 * fires the moment the tracer passes it, even while it keeps traveling on
 * down a ramp/orbit's elevated tail, rather than waiting for the whole
 * (possibly much longer) flight to finish and dwell at the far-away feed
 * point.
 */
export function tracerAt(
  flats: (FlatSegment | null)[],
  tMs: number,
  speed = TRACER_SPEED,
  dwell = TRACER_DWELL_MS,
): TracerState {
  const phases: { i: number; start: number; travel: number; dwellStart: number; crossAt: number }[] = []
  let total = 0
  flats.forEach((f, i) => {
    const real = f !== null && f.len >= 1
    const travel = real ? Math.max(TRACER_MIN_TRAVEL_MS, (f!.len / speed) * 1000) : 0
    const mainLen = real && f!.rampIdx != null && f!.rampIdx > 0 ? f!.cum[f!.rampIdx - 1]! : real ? f!.len : 0
    const crossAt = total + (real ? travel * (mainLen / f!.len) : travel)
    phases.push({ i, start: total, travel, dwellStart: total + travel, crossAt })
    total += travel + dwell
  })
  const cycle = total + TRACER_END_PAUSE_MS || 1
  const t = positiveMod(tMs, cycle)
  if (phases.length === 0) return { index: 0, done: 0, ball: null, u: null, sinceHit: null, finished: false }
  if (t >= total) {
    const last = phases[phases.length - 1]!
    return { index: last.i, done: phases.length, ball: null, u: null, sinceHit: t - last.crossAt, finished: true }
  }
  for (const p of phases) {
    if (t < p.dwellStart) {
      const flat = flats[p.i]!
      const rawU = (t - p.start) / p.travel
      // Phase A6 (2026-08-11): a partial-plunge segment's raw (linear,
      // constant-screen-speed) time-fraction is eased through 1-(1-u)^2 —
      // front-loaded progress, so the ball covers ground fast right off the
      // plunger and visibly decelerates into its landing. `u` below is the
      // EASED value throughout (not just for `ball`) so Pass 3's comet-tail
      // head (`u * flat.len`, drawTracerBall) stays self-consistent with
      // where the ball actually is. Every non-'decel' flat (the overwhelming
      // majority) reproduces the exact prior linear mapping.
      // 2026-08-11 (phase A7): dormant, not deleted — flattenSegment never
      // tags a lane segment 'decel' any more (drawn plunge legs are gone),
      // so this branch has nothing left to fire on; kept intact in case a
      // future drawn-lane-leg feature returns.
      const u = flat.easing === 'decel' ? 1 - (1 - rawU) ** 2 : rawU
      const sinceHit = t >= p.crossAt ? t - p.crossAt : null
      return { index: p.i, done: p.i, ball: pointAt(flat, u * flat.len), u, sinceHit, finished: false }
    }
    if (t < p.dwellStart + dwell) {
      return { index: p.i, done: p.i + 1, ball: null, u: null, sinceHit: t - p.crossAt, finished: false }
    }
  }
  return { index: 0, done: 0, ball: null, u: null, sinceHit: null, finished: false }
}

/** What Pass 1/2/3 render off of — either the real flying tracer, the
 *  manual-mode bypass (shotcoach-corrections.md #10: same shape, no
 *  ball/flash, `done` == the parked index so already-passed legs still read
 *  as "flown"), or — only when `ballTracer` is explicitly off AND not manual
 *  — the untouched pre-Shot-Coach two-state autoHighlightIndex fallback
 *  (`done` pinned at 0, so nothing ever gets the new done-leg/ring
 *  treatment; `ease` drives the old cross-fade-in glow, HIGHLIGHT_EASE_S). */
interface ActiveState {
  index: number
  done: number
  ball: (Pt & { angle: number }) | null
  u: number | null
  sinceHit: number | null
  /** true for the tracer's pulse-ring styling (README §1e "Active"); false
   *  only for the ballTracer:false auto fallback, which keeps the old
   *  ease-based drawHighlightTarget look. */
  tracerRing: boolean
  ease: number
}

function resolveActiveState(
  flats: (FlatSegment | null)[],
  stepCount: number,
  tMs: number,
  tSec: number,
  manualIndex: number | null,
  ballTracerOn: boolean,
): ActiveState {
  if (manualIndex !== null) {
    return { index: manualIndex, done: manualIndex, ball: null, u: null, sinceHit: null, tracerRing: true, ease: 1 }
  }
  if (ballTracerOn) {
    const trc = tracerAt(flats, tMs)
    return { ...trc, tracerRing: true, ease: 1 }
  }
  const index = autoHighlightIndex(tMs, stepCount)
  const phase = tSec - Math.floor(tSec / HIGHLIGHT_HOLD_S) * HIGHLIGHT_HOLD_S
  const ease = Math.min(phase / HIGHLIGHT_EASE_S, 1)
  // Phase A11 (2026-08-11, additive): `sinceHit` used to be hardcoded null
  // in this branch — nothing else here reads it (Pass 2 branches on
  // `tracerRing` to call drawHighlightTarget instead of drawTracerRing,
  // which is the only OTHER consumer of `sinceHit`). Repurposed as "ms
  // since this HIGHLIGHT_HOLD_S hold began" (`phase` is already exactly
  // that, in seconds) so Pass 5's celebration burst has a usable "time
  // since arrival" clock even with ballTracer explicitly off — every
  // pre-existing reader of this branch's output is unaffected.
  return { index, done: 0, ball: null, u: null, sinceHit: phase * 1000, tracerRing: false, ease }
}

// ---- leg strokes (README §1c/§1d) ----

function tracePolyline(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  ctx.beginPath()
  ctx.moveTo(pts[0]!.x, pts[0]!.y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
}

/** Minimum flattened-polyline length (view units — CSS px / pt / dp) for an
 *  arrowhead to draw at all; below this, the connector line still strokes,
 *  it just draws no chevron. Reinstated from the pre-Shot-Coach source's
 *  ARROWHEAD_MIN_LEG_PX gate (2026-07-28 degenerate-leg review finding 3):
 *  the arrowhead's `back` pull-back (up to 30px for the active state, see
 *  drawArrowheadFromTail below) can exceed a short leg's own length,
 *  detaching the chevron from the line it's supposed to cap. Applied to
 *  Pass 1's (sole, since phase A12 item 4) active-leg arrowhead call below —
 *  before that phase this also gated the now-deleted done/quiet arrowheads,
 *  the same way. */
const ARROWHEAD_MIN_LEG_PX = 40

function drawArrowheadFromTail(
  ctx: CanvasRenderingContext2D,
  flat: FlatSegment,
  color: string,
  size = 13,
  back = 30,
  lineWidth = 4,
): void {
  const pts = flat.pts
  const tip = pts[pts.length - 1]!
  const prev = pts[Math.max(0, pts.length - 4)]!
  const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x)
  const basePoint = { x: tip.x - Math.cos(angle) * back, y: tip.y - Math.sin(angle) * back }
  const a1 = angle + Math.PI * 0.82
  const a2 = angle - Math.PI * 0.82
  ctx.save()
  ctx.setLineDash([])
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(basePoint.x + Math.cos(a1) * size, basePoint.y + Math.sin(a1) * size)
  ctx.lineTo(basePoint.x, basePoint.y)
  ctx.lineTo(basePoint.x + Math.cos(a2) * size, basePoint.y + Math.sin(a2) * size)
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.stroke()
  ctx.restore()
}

// strokeQuietLeg/strokeDoneLeg (the "not yet reached" / "already flown this
// cycle" leg treatments) were DELETED 2026-08-11 (phase A12 item 4,
// active-target-only display) — Pass 1 below only ever draws the ACTIVE
// step's own leg now, so there is no "quiet" or "done" OTHER leg left to
// stroke. git history has both bodies if this three-state treatment is ever
// wanted back.

/** Active leg: the marching-dash look (unchanged) or the new neon
 *  bloom/body/core + travelling sheen (README §1c). `t` in seconds. */
function strokeActiveLeg(
  ctx: CanvasRenderingContext2D,
  flat: FlatSegment,
  color: string,
  t: number,
  brightness: number,
  style: 'dash' | 'neon',
): void {
  const pts = flat.pts
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (style === 'dash') {
    ctx.setLineDash([])
    tracePolyline(ctx, pts)
    ctx.strokeStyle = withAlpha(color, Math.min(1, 0.25 * brightness))
    ctx.lineWidth = 9
    ctx.stroke()
    tracePolyline(ctx, pts)
    ctx.strokeStyle = withAlpha(color, Math.min(1, brightness))
    ctx.lineWidth = 4
    ctx.setLineDash([12, 8])
    ctx.lineDashOffset = positiveMod(-t * 36, 20)
    ctx.stroke()
    ctx.setLineDash([])
  } else {
    ctx.setLineDash([])
    ctx.shadowColor = color
    ctx.shadowBlur = 18 * Math.min(1.4, brightness)
    tracePolyline(ctx, pts)
    ctx.strokeStyle = withAlpha(color, Math.min(1, 0.3 * brightness))
    ctx.lineWidth = 12
    ctx.stroke()
    ctx.shadowBlur = 12
    tracePolyline(ctx, pts)
    ctx.strokeStyle = withAlpha(color, Math.min(1, 0.9 * brightness))
    ctx.lineWidth = 4.5
    ctx.stroke()
    ctx.shadowBlur = 0
    tracePolyline(ctx, pts)
    ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(0.95, 0.85 * brightness)})`
    ctx.lineWidth = 1.5
    ctx.stroke()
    // travelling sheen: only the points whose cumulative length falls in the window
    const total = flat.len
    const win = Math.min(110, total * 0.4)
    const head = positiveMod(t * 260, total + win) - win * 0.5
    ctx.shadowColor = '#fff'
    ctx.shadowBlur = 16
    ctx.strokeStyle = 'rgba(255, 255, 255, .9)'
    ctx.lineWidth = 3
    ctx.beginPath()
    let started = false
    for (let i = 0; i < pts.length; i++) {
      const d = flat.cum[i]!
      if (d >= head && d <= head + win) {
        if (!started) {
          ctx.moveTo(pts[i]!.x, pts[i]!.y)
          started = true
        } else {
          ctx.lineTo(pts[i]!.x, pts[i]!.y)
        }
      }
    }
    if (started) ctx.stroke()
  }
  ctx.restore()
}

/** SPEC-PATHVIZ rule 7's "ball-on-wireform" elevated-leg style — a dotted,
 *  thinner stroke than the main connector legs, used for the entrance->
 *  apex->feed tail a ramp/orbit/loop's resolved `feeds` appends. Web dash
 *  pattern [2,7]px per spec. Width/alpha are passed in by the caller rather
 *  than hardcoded here, so this stays reusable — a pre-phase-A12 caller used
 *  to pass different numbers for the (now-deleted) done/quiet leg states;
 *  Pass 1 below has only the active state left to draw (phase A12 item 4)
 *  and always passes the active numbers, 3px/0.9-alpha per spec. */
function strokeRampLeg(ctx: CanvasRenderingContext2D, flat: FlatSegment, color: string, alpha: number, lineWidth: number): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([2, 7])
  tracePolyline(ctx, flat.pts)
  ctx.strokeStyle = withAlpha(color, alpha)
  ctx.lineWidth = lineWidth
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

// ---- tracer ball + comet (README §1d) ----

const COMET_LEN_PX = 84
const COMET_PASSES: readonly [number, number, number][] = [
  [10, 0.22, 16],
  [5, 0.5, 10],
  [2, 0.95, 0],
]

function drawTracerBall(
  ctx: CanvasRenderingContext2D,
  flat: FlatSegment,
  ball: Pt,
  u: number,
  color: string,
): void {
  const head = u * flat.len
  const tail = Math.max(0, head - COMET_LEN_PX)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [lineWidth, alpha, blur] of COMET_PASSES) {
    ctx.beginPath()
    let started = false
    for (let i = 0; i < flat.pts.length; i++) {
      const d = flat.cum[i]!
      if (d >= tail && d <= head) {
        if (!started) {
          ctx.moveTo(flat.pts[i]!.x, flat.pts[i]!.y)
          started = true
        } else {
          ctx.lineTo(flat.pts[i]!.x, flat.pts[i]!.y)
        }
      }
    }
    if (started) {
      ctx.lineTo(ball.x, ball.y)
      ctx.shadowColor = '#fff'
      ctx.shadowBlur = blur
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`
      ctx.lineWidth = lineWidth
      ctx.stroke()
    }
  }
  ctx.restore()

  ctx.save()
  ctx.shadowColor = '#fff'
  ctx.shadowBlur = 18
  const grad = ctx.createRadialGradient(ball.x - 2, ball.y - 2, 0.5, ball.x, ball.y, 7)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(0.55, '#e8ecf2')
  grad.addColorStop(1, withAlpha(color, 0.9))
  ctx.beginPath()
  ctx.arc(ball.x, ball.y, 6.5, 0, Math.PI * 2)
  ctx.fillStyle = grad
  ctx.fill()
  ctx.restore()
}

// ---- rings / badges / labels (README §1e/§1f) ----

/**
 * Glow treatment for the currently-highlighted step on the OLD (ballTracer
 * off + auto) fallback path only: the active pulse (halo + bright stroke +
 * center dot) grown x1.35 over a quiet ring, with every accent scaled by
 * `ease` (0..1) so it blooms from the quiet look rather than snapping on.
 * Unchanged from the pre-Shot-Coach source — see ActiveState's doc.
 */
function drawHighlightTarget(ctx: CanvasRenderingContext2D, point: Pt, color: string, t: number, ease: number): void {
  const quietRadius = 14
  const pulse = 3 * (1 + Math.sin(t * 4)) * ease
  const radius = quietRadius * (1 + 0.35 * ease) + pulse
  strokeCircle(ctx, point, radius + 5, withAlpha(color, 0.25 * ease), 10)
  strokeCircle(ctx, point, radius, withAlpha(color, 0.35 + 0.55 * ease), 2 + 2 * ease)
  fillCircle(ctx, point, 4, withAlpha(color, ease))
}

/**
 * Pulse-ring treatment for the tracer/manual active step (README §1e
 * "Active" + "Impact flash"). Runs continuously off `t`, independent of
 * `ease` — this is the NEW ring look, used whenever a real or bypassed
 * tracer is driving the highlight (ActiveState.tracerRing).
 */
function drawTracerRing(
  ctx: CanvasRenderingContext2D,
  point: Pt,
  color: string,
  t: number,
  style: 'dash' | 'neon',
  sinceHit: number | null,
): void {
  const pulse = 3 * (1 + Math.sin(t * 4))
  const radius = 14 * 1.35 + pulse
  ctx.save()
  if (style === 'neon') {
    ctx.shadowColor = color
    ctx.shadowBlur = 14
  }
  strokeCircle(ctx, point, radius + 5, withAlpha(color, 0.25), 10)
  strokeCircle(ctx, point, radius, withAlpha(color, 0.9), 4)
  ctx.restore()
  fillCircle(ctx, point, 4, color)
  if (sinceHit != null) {
    const hit = Math.max(0, 1 - sinceHit / 420)
    if (hit > 0) {
      strokeCircle(ctx, point, radius + (1 - hit) * 30, `rgba(255, 255, 255, ${hit * 0.85})`, 3 * hit + 0.5)
      strokeCircle(ctx, point, radius + (1 - hit) * 52, withAlpha(color, hit * 0.5), 2)
    }
  }
}

/** SPEC-PATHVIZ rule 7's landing marker — a filled ~3.5px dot + ~9px ring in
 *  the goal's category color, drawn once at a ramp/orbit/loop's resolved
 *  feed point (the elevated tail's actual endpoint). Fixed color regardless
 *  of active/done/quiet state — the spec gives it one look, unlike the
 *  three-state leg/ring treatment used everywhere else in this file. */
function drawLandingMarker(ctx: CanvasRenderingContext2D, point: Pt, color: string): void {
  strokeCircle(ctx, point, 9, withAlpha(color, 0.55), 1.5)
  fillCircle(ctx, point, 3.5, color)
}

// ---- celebration burst (Feature 3 / phase A11, 2026-08-11; range widened
// 1-5 -> 1-7 and reach made canvas-relative in phase A16, 2026-08-11 same
// day — see the file header's own phase A16 note for the full rationale) --

/** How many glyph sprites the burst scatters at LEVEL 1 (Feature 3's
 *  original fixed burst) — spec range "6-10 glyphs"; 8 is the midpoint and
 *  divides the circle evenly for a symmetric scatter. Feature 7 (2026-08-11,
 *  phase A14) scales this UP per level — see celebrationParams below; this
 *  constant remains exactly level 1's count, so it stays the byte-identical
 *  baseline every pre-Feature-7 test in this suite already pins. */
const CELEBRATE_GLYPH_COUNT = 8
/** Level 7's glyph count (Feature 7; the anchor moved from level 5's 14 to
 *  level 7's 20 in phase A16, same 1.5x scale factor) — spec: "8 at L1 up to
 *  ~20 at L7". */
const CELEBRATE_GLYPH_COUNT_MAX = 20
/** Level 1's glyph font size, px (Feature 7) — the pre-Feature-7 fixed size. */
const CELEBRATE_PX_BASE = 20
/** Level 7's glyph font size, px (Feature 7; the anchor moved from level 5's
 *  40px to level 7's 56px in phase A16) — spec: "20px -> ~56px at L7". */
const CELEBRATE_PX_MAX = 56
/** Level 1's max scatter reach, as a FRACTION of the canvas's own
 *  min(width,height) (phase A16, 2026-08-11 — replaces the pre-A16
 *  `CELEBRATE_REACH_STEP` ring-radius multiplier outright: a reach expressed
 *  in multiples of the fixed 14px ring never looks different on a phone vs.
 *  a tablet canvas, which is exactly the owner's "all the same still"
 *  complaint. See the file header's own phase A16 note). 0.10 —
 *  "close to today's feel" (owner) — is the fraction of canvas-min the
 *  scatter's OUTER edge reaches on a level-1 burst; see celebrationParams'
 *  `reachFraction` field and drawCelebrationBurst's `canvasMin` param. */
const CELEBRATE_REACH_FRACTION_BASE = 0.1
/** Level 7's max scatter reach, as a fraction of canvas-min (phase A16) —
 *  "almost take up the entire screen" (owner) lands at 0.94: the scatter's
 *  outer edge sweeps to within 6% of the canvas's shorter side at level 7,
 *  comfortably inside the spec'd 0.85-0.95 range without ever literally
 *  touching the canvas edge. */
const CELEBRATE_REACH_FRACTION_MAX = 0.94
/** Extra angular drift (radians per unit of burst progress `p`), layered on
 *  top of the existing shared `p*1.4*Math.PI` fan rotation — 0 below level 3
 *  (a plain radiating starburst, matching level 1/2's original look), this
 *  much PER LEVEL from level 3 up (Feature 7 — owner: "spiral trajectories
 *  at L3+"). Unchanged in phase A16 — extending the legal range to level 7
 *  alone makes the top end "stronger" (4.5π at level 7, vs. the old 2.7π
 *  ceiling at the pre-A16 level-5 max) with no change to this per-level step. */
const CELEBRATE_SPIRAL_STEP = 0.9 * Math.PI
/** Extra hold duration, ms, per level above 1 (Feature 7 — "hold duration up
 *  modestly"; the anchor and per-level step were both recalculated in phase
 *  A16 for the new level-7 ceiling — 200ms/level, not the pre-A16 150ms/
 *  level) — level 7 reaches CELEBRATE_DURATION_MS + 1200 = 3000ms. This
 *  bounds how long Pass 5's `elapsedMs < duration` gate stays open, which
 *  only fully matters in MANUAL mode: `o.celebrate.manualStartedAt` is a
 *  caller-managed clock with no ceiling of its own, so a manual-mode
 *  celebration plays its whole configured duration start to finish. In
 *  AUTO/tracer mode the burst re-fires every loop off `active.sinceHit`
 *  (unchanged, phase A11) — which caps out at TRACER_DWELL_MS +
 *  TRACER_END_PAUSE_MS (1520ms total) before the tracer moves off the last
 *  step, shorter than even the LEVEL-1 duration (1800ms), so an AUTO-mode
 *  burst was already only ever seeing its own opening ~1520ms before this
 *  phase; a higher level's longer nominal duration doesn't change that
 *  pre-existing shape, it just means more of a high level's duration is
 *  "unused" by the AUTO path specifically (never a bug in itself — nothing
 *  before this phase depended on an AUTO-mode burst reaching its own tail). */
const CELEBRATE_DURATION_STEP_MS = 200
/** Total on-screen duration of the LEVEL-1 burst, ms — spec range "~1.5-2s".
 *  Exported so the caller (map2d.ts) can reason about its own arming
 *  window off the SAME number instead of a second hardcoded literal, and so
 *  tests can assert level 1's duration didn't drift from this baseline.
 *  Feature 7 (2026-08-11, phase A14) scales the EFFECTIVE duration up per
 *  level (see celebrationParams below) — this constant remains exactly
 *  level 1's value, unchanged again by phase A16's range widening. */
export const CELEBRATE_DURATION_MS = 1800
/** The ring radius the burst must start CLEAR of (2026-08-11, phase A12 item
 *  2 — rolo: "have the emojis blow up or spin out of the target circle so
 *  it's not confined within the target"). Matches every OTHER Pass-2 ring
 *  radius in this file (`strokeCircle(ctx, target, 14, ...)`,
 *  drawHighlightTarget's `quietRadius`, drawTracerRing's `14 * 1.35` base) —
 *  the glyphs must clear THIS ring, not float around inside it. Fixed —
 *  unaffected by phase A16's canvas-relative reach (only the OUTER end of
 *  the scatter scales with the canvas; the starting clearance is tied to the
 *  drawn ring's own fixed on-screen size, not the canvas). Exported so
 *  tests/celebrate.test.mjs can assert the scatter's actual travel distance
 *  against this SAME number instead of a duplicated magic literal. */
export const CELEBRATE_RING_RADIUS = 14
/** Maximum legal celebration intensity (phase A16, 2026-08-11 — raised from
 *  5). state.ts's setCelebrationLevel/readCelebrationLevel clamp to this
 *  same ceiling independently (that file doesn't import this one — see its
 *  own phase A16 note for why the literal is duplicated rather than shared).
 *  Used by both celebrationParams' own clamp and the Pass-5 call site's
 *  `o.celebrate.level` clamp below, so the two can never disagree about
 *  where the legal range ends. */
const CELEBRATE_LEVEL_MAX = 7

/**
 * Feature 7 (2026-08-11, phase A14; range widened 1-5 -> 1-7, and reach
 * reworked from a ring-radius multiple to a canvas-min FRACTION, in phase
 * A16 the same day) — the per-level burst parameters. `level` is clamped to
 * the legal [1, CELEBRATE_LEVEL_MAX] integer range first — never fractional,
 * never <=0 (the caller/Pass-5 gate below is what turns a 0-or-below level
 * into "don't call this at all", same as `celebrate: null`; this function
 * only ever computes params for an ACTIVE burst).
 *
 * Every field is a plain linear interpolation between the level-1 anchor and
 * the level-7 anchor, over the CELEBRATE_LEVEL_MAX-1 (6) equal steps between
 * them — replacing the old level-1..5 per-level table outright, not just
 * extending it. The full resolved table:
 *
 *   level | count | px | reachFraction | spiralPerP | durationMs
 *   ------+-------+----+---------------+------------+-----------
 *     1   |   8   | 20 |     0.10      |     0      |   1800
 *     2   |  10   | 26 |     0.24      |     0      |   2000
 *     3   |  12   | 32 |     0.38      |   0.9π     |   2200
 *     4   |  14   | 38 |     0.52      |   1.8π     |   2400
 *     5   |  16   | 44 |     0.66      |   2.7π     |   2600
 *     6   |  18   | 50 |     0.80      |   3.6π     |   2800
 *     7   |  20   | 56 |     0.94      |   4.5π     |   3000
 *
 * `reachFraction` is the scatter's max travel distance as a FRACTION of the
 * canvas's own min(width,height) — see drawCelebrationBurst's `canvasMin`
 * param, which is what actually turns this fraction into a pixel distance.
 * Level 1 is close to, but (since it now depends on canvas size rather than
 * being a fixed pixel value) no longer byte-identical to, the pre-Feature-7
 * Feature 3 burst — see the file header's own phase A16 note.
 *
 * Exported so tests/celebrate.test.mjs can assert the exact scaling table
 * directly instead of reverse-engineering it from canvas geometry — the same
 * "export the pure classifier" rationale as classifyPlunge's own doc comment.
 */
export function celebrationParams(level: number): {
  count: number
  px: number
  reachFraction: number
  spiralPerP: number
  durationMs: number
} {
  const lvl = clamp(Math.round(level), 1, CELEBRATE_LEVEL_MAX)
  const steps = CELEBRATE_LEVEL_MAX - 1 // 6 equal steps from the level-1 anchor to the level-7 anchor
  return {
    count: Math.round(CELEBRATE_GLYPH_COUNT + ((lvl - 1) * (CELEBRATE_GLYPH_COUNT_MAX - CELEBRATE_GLYPH_COUNT)) / steps),
    px: CELEBRATE_PX_BASE + ((lvl - 1) * (CELEBRATE_PX_MAX - CELEBRATE_PX_BASE)) / steps,
    reachFraction: CELEBRATE_REACH_FRACTION_BASE + ((lvl - 1) * (CELEBRATE_REACH_FRACTION_MAX - CELEBRATE_REACH_FRACTION_BASE)) / steps,
    spiralPerP: lvl >= 3 ? (lvl - 2) * CELEBRATE_SPIRAL_STEP : 0,
    durationMs: CELEBRATE_DURATION_MS + (lvl - 1) * CELEBRATE_DURATION_STEP_MS,
  }
}

/**
 * The last step's emoji burst — see the file header's phase A11 note for
 * why this is NOT a reuse of fx/celebrate.ts's `celebrate()` (that function
 * is a full-VIEWPORT, `position:fixed` DOM canvas with its own independent
 * rAF/setTimeout lifecycle, a banner, and sound — none of which fit a
 * per-frame Pass inside THIS canvas's existing draw loop; checked before
 * writing this, per the owner's brief, and built minimal instead).
 * `elapsedMs` (already clamped non-negative and under the LEVEL's own
 * duration by the caller — celebrationParams(level).durationMs) drives
 * progress `p` in [0,1] as a pure function — same "deterministic function
 * of a clock" discipline as drawTracerBall/drawHighlightTarget elsewhere in
 * this file, no internal timers.
 *
 * `reduceMotion` (REWORKED 2026-08-11, phase A17 — see the file header's own
 * phase A17 note for the full "why"): draws the SAME `celebrationParams(level)`
 * glyph count/font size/reach as the animated path below, frozen at that
 * path's own FINAL (ease===1) scattered pose — no travel, no rotation, no
 * scale change — and cross-faded in then out by opacity alone (a ramp 0->1
 * over the first 30% of the level's own duration, held at 1, then a ramp
 * 1->0 over the last 30%). Chosen over drawing nothing at all, which would
 * silently swallow the "you finished this goal" signal for a user with this
 * preference set, and over the PRE-A17 single fixed-size pulse, which looked
 * identical at every level — the owner's "celebrations are all the same"
 * report was this exact path. Canvas-relative reach (phase A16) now DOES
 * apply here — `maxTravelPx` (hoisted above this branch) is the same
 * canvas-scaled distance the animated path travels OUT TO, just held fixed
 * for the static frame instead of eased into over time. Draws at any `level`
 * >= 1 (the only levels this is ever called with — see the Pass-5 call
 * site's own gate), nothing at level 0 (never reaches this function at all).
 *
 * `level` (Feature 7, 2026-08-11, phase A14, default 1): resolved once via
 * celebrationParams — see that function's own doc comment for the exact
 * table. `canvasMin` (phase A16, 2026-08-11, REQUIRED — no default, unlike
 * `level`): the caller's own real `min(canvas width, canvas height)` in CSS
 * px, resolved ONCE by Pass 5 below via the same `ctx.canvas.clientWidth ||
 * ctx.canvas.width` idiom Pass 2.5/Pass 4 already use elsewhere in this
 * file, and passed in here rather than re-read from `ctx` — this function
 * stays a pure "given these numbers, draw" routine, like the rest of this
 * file, rather than reaching back into `ctx` for geometry a caller already
 * has in hand.
 */
function drawCelebrationBurst(
  ctx: CanvasRenderingContext2D,
  origin: Pt,
  glyph: string,
  elapsedMs: number,
  reduceMotion: boolean,
  level: number,
  canvasMin: number,
): void {
  const params = celebrationParams(level)
  const p = clamp(elapsedMs / params.durationMs, 0, 1)
  const emojiFont = (px: number) => `${px}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`
  // Canvas-relative reach (phase A16, 2026-08-11 — see CELEBRATE_REACH_
  // FRACTION_BASE/MAX's own doc comments and the file header's phase A16
  // note): the scatter's OUTER edge sits at `reachFraction * canvasMin`
  // pixels from the target, not a multiple of the fixed ring radius.
  // `Math.max(CELEBRATE_RING_RADIUS, ...)` floors that outer edge at the
  // ring radius itself so a degenerate near-zero canvas (e.g. mid-layout,
  // before the first real resize) holds the scatter steady at the ring's
  // edge instead of collapsing INWARD. HOISTED here (phase A17, 2026-08-11
  // — see the file header's own phase A17 note): both the animated scatter
  // below AND the reduced-motion static frame now read this SAME value, so
  // the two paths (and the diagnostic immediately below) can never disagree
  // about how far a given level/canvas combination reaches.
  const maxTravelPx = Math.max(CELEBRATE_RING_RADIUS, params.reachFraction * canvasMin)
  // Defensive diagnostic (phase A17, 2026-08-11 — owner: celebrations
  // reportedly "all the same" for a full day despite the phase A16 rebuild
  // being live; root cause was the reduced-motion branch below silently
  // ignoring `level` entirely — see that branch's own doc comment). One
  // line, every call (both branches, every frame this function draws) —
  // console.debug, deliberately NOT console.log/info, so it stays out of the
  // default console filter and only shows up when someone's actually
  // digging: level, resolved glyph count, resolved outer travel distance,
  // the canvas-min it was computed from, and whether reduced-motion was
  // active. Answers "did the slider actually change anything" from the
  // console in seconds instead of re-deriving this whole investigation.
  if (typeof console !== 'undefined' && typeof console.debug === 'function') {
    console.debug(
      `[celebrate] level=${level} glyphs=${params.count} travel=${Math.round(maxTravelPx)}px canvasMin=${Math.round(canvasMin)} reducedMotion=${reduceMotion}`,
    )
  }
  if (reduceMotion) {
    // Reworked 2026-08-11, phase A17 (see the file header's own phase A17
    // note): honors the preference by removing MOTION, not the FEATURE —
    // this static frame reads the exact same count/px/reach this level's
    // animated burst would, it just never travels. Concretely, every glyph
    // is frozen at the animated path's own FINAL pose (p===1, ease===1: same
    // base+spiral angle formula, `dist===maxTravelPx`, below) for the entire
    // visible window, and the ONLY thing that changes frame to frame is
    // opacity — a ramp 0->1 over the first 30% of the level's own duration
    // (never instant-on, unlike the pre-A17 pulse), held at 1, then 1->0
    // over the last 30% (the same "0.3 of duration" tail shape the animated
    // path's own fade-out uses below, reused here for both edges).
    const fadeIn = clamp(p / 0.3, 0, 1)
    const fadeOut = clamp((1 - p) / 0.3, 0, 1)
    const alpha = Math.min(fadeIn, fadeOut)
    if (alpha <= 0.01) return
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.font = emojiFont(params.px)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < params.count; i++) {
      // Same angle formula as the animated loop below with p/ease pinned to
      // 1 (the burst's own final frame) — the base fan rotation at its full
      // 1.4π, plus the FULL spiral term (0 below level 3, same as animated).
      const angle = (2 * Math.PI * i) / params.count + 1.4 * Math.PI + params.spiralPerP
      const x = origin.x + Math.cos(angle) * maxTravelPx
      const y = origin.y + Math.sin(angle) * maxTravelPx - CELEBRATE_RING_RADIUS
      ctx.save()
      ctx.translate(x, y)
      ctx.fillText(glyph, 0, 0)
      ctx.restore()
    }
    ctx.restore()
    return
  }
  const ease = 1 - (1 - p) * (1 - p)
  const alpha = p < 0.7 ? 1 : Math.max(0, 1 - (p - 0.7) / 0.3)
  if (alpha <= 0.01) return
  const dist = CELEBRATE_RING_RADIUS + (maxTravelPx - CELEBRATE_RING_RADIUS) * ease
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = emojiFont(params.px)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < params.count; i++) {
    // The shared `p * 1.4 * Math.PI` term is the original Feature 3 fan
    // rotation (unchanged, every level). `params.spiralPerP * p` is Feature
    // 7's ADDITIONAL drift, 0 below level 3 — see celebrationParams' own doc
    // comment.
    const angle = (2 * Math.PI * i) / params.count + p * 1.4 * Math.PI + params.spiralPerP * p
    const x = origin.x + Math.cos(angle) * dist
    const y = origin.y + Math.sin(angle) * dist - CELEBRATE_RING_RADIUS * ease
    const rotationDeg = (i % 2 === 0 ? 1 : -1) * 50 * p
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((rotationDeg * Math.PI) / 180)
    ctx.fillText(glyph, 0, 0)
    ctx.restore()
  }
  ctx.restore()
}

/** Dark stroke halo behind the fill so labels stay legible over shot paths/
 *  dots/gradient background — canvas equivalent of the design doc's SVG
 *  `paint-order="stroke"` text treatment. Shared by drawGoalOverlay's ring
 *  captions (Pass 2.5) and map2d's ambient/goal-pass shot labels (which
 *  imports this back, same as it already imports roundedRectPath).
 *  `haloStyle`/`boundsW` are additive (2026-07-28 Shot Coach, README §1e):
 *  omitting both reproduces the exact prior 6-arg call/behavior byte for
 *  byte (same default halo color, no x-clamping) — map2d.ts's existing call
 *  sites are unaffected. `boundsW > 0` self-clamps `x` to keep the
 *  measured text on-canvas (README §1e "Clamp x to [w/2+4, canvasWidth-w/2-4]"). */
/** Inner padding used when a label is clamped to the playfield card, in px.
 *  Small on purpose: the point is to stop text being cut off, not to push it
 *  away from the edge it belongs to. */
export const LABEL_EDGE_PAD = 6

/** Horizontal limits for a label, as SCREEN x. */
export interface LabelBounds {
  left: number
  right: number
}

/** The drawn card's horizontal extent, taken from the MapFn every playfield
 *  renderer already has — map(0, v).x and map(1, v).x ARE the card's left and
 *  right edges by construction, so no call site has to thread a Rect it was
 *  not already given.
 *
 *  WHY THE CARD AND NOT THE CANVAS (owner, 2026-08-14: "make sure the names of
 *  sections on playfields don't disappear over the edge"): a label centred on
 *  a shot near the left edge ran off the canvas and rendered as "ip's Wheel
 *  Spinner". Clamping to the canvas alone would stop the clipping but leave
 *  the text stranded on the letterbox strip, which since P9's two-column Study
 *  layout can be ~19px of empty ground beside the card. The card is the thing
 *  the label describes, so the card is what it stays inside. */
export function cardXBounds(map: MapFn, pad = LABEL_EDGE_PAD): LabelBounds {
  const a = map(0, 0).x
  const b = map(1, 0).x
  return { left: Math.min(a, b) + pad, right: Math.max(a, b) - pad }
}

/** The same bounds from the drawn RECT rather than the map.
 *
 *  USE THIS WHENEVER A RECT IS IN HAND, and cardXBounds only when it is not.
 *  cardXBounds asks the map where u = 0 and u = 1 land, which is the card's
 *  edges for a MAIN playfield map — and is nowhere near them for a ZONE map.
 *  zoneLocalMap re-bases u into the zone's own footprint ((u - zx) / zw), so
 *  on a deck occupying a quarter of the board it reports a range FOUR TIMES
 *  the card, and a label at the card's left edge is "inside" it and gets
 *  clipped anyway. That is exactly what shipped for one build of the Study
 *  LEVEL feature: "Ship's Wheel Spinner" rendered as "Wheel Spinner" on the
 *  Orca deck. The rect is the card, always, on both levels. */
export function rectXBounds(rect: { x: number; w: number }, pad = LABEL_EDGE_PAD): LabelBounds {
  return { left: rect.x + pad, right: rect.x + rect.w - pad }
}

/** The longest prefix of `text` (plus an ellipsis) that fits `maxWidth`, or
 *  `text` unchanged when it already does.
 *
 *  CLAMPING ALONE IS NOT ENOUGH, and a test found the case: Jaws's "Right Ramp
 *  (East Beach / Quint\'s Shack)" is 39 characters, and on a 320px phone the
 *  drawn card is ~145px wide. No horizontal position exists where that name
 *  fits — sliding it inside one edge pushes it out of the other, and centring
 *  it (what the clamp does with an unfittable label) loses the same text at
 *  both ends instead of all of it at one. The owner\'s ask was that names not
 *  disappear over the edge; an ellipsis is the only answer that keeps the
 *  label INSIDE the card and still says what it can. Same treatment the
 *  eyebrow and the ALL SHOTS rows already get in CSS.
 *
 *  Binary search rather than a per-character walk: measureText is the
 *  expensive call in this file\'s hot path, and this runs per label per frame. */
export function fitLabelText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) return text
  const ellipsis = '\u2026'
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis
}

/** Centre x for `text` so its BOX stays within `bounds`, given the centre the
 *  caller wanted. Returns that centre unchanged when it already fits, and the
 *  midpoint when the text is wider than the bounds (nothing can fit, so
 *  centring loses the least at both ends).
 *
 *  ONLY THE TEXT MOVES. Callers draw their connector, halo and dot from the
 *  shot's real point, so a clamped label still reads as belonging to it. */
export function clampLabelCenterX(ctx: CanvasRenderingContext2D, text: string, x: number, bounds: LabelBounds): number {
  const half = ctx.measureText(text).width / 2
  const lo = bounds.left + half
  const hi = bounds.right - half
  return lo > hi ? (bounds.left + bounds.right) / 2 : clamp(x, lo, hi)
}

export function drawHaloLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  fillStyle: string,
  haloStyle = 'rgba(5, 13, 31, 0.85)',
  /** Horizontal clamp. A NUMBER is a canvas width (the pre-2026-08-14 form,
   *  i.e. bounds of 0..w); a LabelBounds is an explicit range, which is what
   *  cardXBounds returns. 0 means "do not clamp", and is now only correct for
   *  a call site that draws at a fixed centre. */
  bounds: number | LabelBounds = 0,
): void {
  ctx.save()
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let px = x
  if (typeof bounds === 'number') {
    if (bounds > 0) {
      const halfWidth = ctx.measureText(text).width / 2 + 4
      px = clamp(x, halfWidth, Math.max(halfWidth, bounds - halfWidth))
    }
  } else {
    // Truncate FIRST, then clamp: a name too long for the card is shortened
    // until it fits, and the now-fitting box is slid inside the edges. See
    // fitLabelText for why centring an unfittable label was not enough.
    text = fitLabelText(ctx, text, bounds.right - bounds.left)
    px = clampLabelCenterX(ctx, text, x, bounds)
  }
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = haloStyle
  ctx.strokeText(text, px, y)
  ctx.fillStyle = fillStyle
  ctx.fillText(text, px, y)
  ctx.restore()
}

/** Occupied-box tracker so two labels never stack on top of each other —
 *  shared by Pass 2.5's ring captions and map2d's ambient shot labels. With
 *  all 56 machines' geometry (and AR's perspective squeeze near the
 *  flippers) captions collide and become unreadable otherwise (README §1e —
 *  e.g. Twilight Zone's "Gum-Ball Combo (2-way)"). Exported for direct unit
 *  testing (tests/plunger-route.test.mjs). */
export function labelPacker(): (x: number, y: number, w: number, h: number) => boolean {
  const boxes: { l: number; r: number; t: number; bo: number }[] = []
  return (x: number, y: number, w: number, h: number): boolean => {
    const b = { l: x - w / 2 - 3, r: x + w / 2 + 3, t: y - h / 2 - 2, bo: y + h / 2 + 2 }
    for (const o of boxes) {
      if (b.l < o.r && b.r > o.l && b.t < o.bo && b.bo > o.t) return false
    }
    boxes.push(b)
    return true
  }
}

/**
 * Does a NUMBERED step badge carry information for this goal?
 *
 * The badge answers "which step of how many is this" — a question that only
 * exists when there is more than one step to tell apart. Two goal shapes can
 * never produce anything but a circled "1", and for those the badge is not a
 * number, it is a decoration with a digit in it sitting 32px off the ring it
 * belongs to, competing with the target's own name caption:
 *
 *   1. A SINGLE-STEP goal. One step, one target, one possible label.
 *   2. ANY SKILLSHOT goal. Skill shots are ONE target to the player (rolo,
 *      2026-08-11, from a screen recording where every Jaws skill shot was
 *      badged "2"), so the badge index is pinned to 0 regardless of the
 *      goal's internal structure — the two-step plunge->target goals were
 *      leaking their internal index. Pinning it fixed the WRONG number; this
 *      removes the number that was never telling anyone anything. The Map
 *      tab's skill-shot carousel (map2d.ts's Feature 6 browse) cycles
 *      BETWEEN skillshot goals, one target each, which is exactly the case
 *      where a permanent "1" is most obviously noise.
 *
 * WHAT IS LOST, and why it is fine: drawBadge also renders a "✓" in place of
 * the number once a step reads as done. For these two shapes the arrival cue
 * is already carried twice over — drawTracerRing's impact flash fires on
 * arrival at the target itself, and Pass 5's celebration burst fires at the
 * goal's LAST step, which for a single-step goal is that same step. A third
 * arrival signal 32px off to one side is not a signal, it is clutter.
 *
 * Shared with overlay/map2d.ts's drawZoneGoalRoute (the LEVEL view draws its
 * own badges rather than calling drawBadge) so the two views cannot disagree
 * about when a badge exists.
 */
export function goalBadgesAreInformative(goal: Goal): boolean {
  if (goal.category === 'skillshot') return false
  return goal.steps.length > 1
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  index: number,
  done: boolean,
  active: boolean,
  target: Pt,
  color: string,
): void {
  const off = active ? 32 : 23
  const center = { x: target.x + off, y: target.y - off }
  const radius = active ? 13 : 10
  const background = done ? withAlpha(DONE_COLOR, 0.42) : active ? color : 'rgba(0, 0, 0, .6)'
  fillCircle(ctx, center, radius, background)
  strokeCircle(ctx, center, radius, `rgba(255, 255, 255, ${active ? 1 : done ? 0.35 : 0.6})`, active ? 2 : 1)
  const label = done ? '✓' : String(index + 1)
  ctx.save()
  ctx.setLineDash([])
  ctx.font = `700 ${active ? 14 : 11}px ${FONT_STACK}`
  ctx.fillStyle = done ? 'rgba(255, 255, 255, .7)' : '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, center.x, center.y)
  ctx.restore()
}

const LABEL_LINE_HEIGHT = 16
const LABEL_MAX_LINES = 2

/** Greedy word-wrap to at most `maxLines`, matching the intent of the native
 *  240x60pt / maxLines=2 text measurement (overflow beyond maxLines is
 *  dropped, mirroring Compose's default Clip overflow). */
function wrapLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = words[0]!
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!
    const attempt = `${current} ${word}`
    if (ctx.measureText(attempt).width <= maxWidth) {
      current = attempt
    } else {
      lines.push(current)
      current = word
      if (lines.length === maxLines) return lines
    }
  }
  lines.push(current)
  return lines.slice(0, maxLines)
}

/** Exported for reuse by ./map2d (playfield card background) — shared so the
 *  two files don't carry duplicate rounded-rect path code. */
export function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

/** Action-label bubble (README §1f) — responsive width, and flips below the
 *  ring (or clamps just under `topInset`) instead of sliding under the AR
 *  HUD band / Map goal pill. */
function drawActionLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  target: Pt,
  color: string,
  canvasSize: { width: number; height: number },
  topInset: number,
): void {
  ctx.save()
  const font = `600 13px ${FONT_STACK}`
  ctx.font = font
  const maxW = Math.min(230, Math.max(120, canvasSize.width - 42))
  const lines = wrapLabel(ctx, text, maxW, LABEL_MAX_LINES)
  const textWidth = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)))
  const textHeight = LABEL_LINE_HEIGHT * lines.length
  const padding = 9
  const width = textWidth + padding * 2
  const height = textHeight + padding
  // POSITION: PINNED TO THE TOP BAND, not floating beside the active ring.
  //
  // 2026-07-31 (rolo: "the pop up describing the shot clutters on the map and
  // almost stomps over the targets"). This used to sit 58px above the active
  // shot's ring and flip below it when that would hit the HUD band. On a real
  // machine the shots CLUSTER in the middle and lower playfield, so "just above
  // the ring" put an opaque ~90px bubble directly on top of neighbouring rings
  // and their captions — reproduced on Jaws' "Cage Dive", where it covered the
  // Center Ramp ring and its label outright.
  //
  // The bubble never had a tail or leader line, so it was not actually
  // anchored to anything visually — the proximity bought nothing while costing
  // the busiest part of the diagram. Pinning it to the top band instead puts it
  // over the upper playfield, which is the emptiest region on essentially every
  // table (the arc/orbit area), and makes its position PREDICTABLE: the eye
  // learns one place to read "what do I do now" instead of hunting for it each
  // time the step advances.
  //
  // Horizontally it still tracks the active shot, clamped to the canvas, so it
  // retains a weak spatial hint without overlapping the cluster.
  const centerX = clamp(target.x, width / 2 + 5, canvasSize.width - width / 2 - 5)
  const centerY = topInset + height / 2 + 6
  const left = centerX - width / 2
  const top = centerY - height / 2
  const cornerRadius = height / 2

  ctx.setLineDash([])
  roundedRectPath(ctx, left, top, width, height, cornerRadius)
  ctx.fillStyle = 'rgba(4, 8, 16, .82)'
  ctx.fill()
  roundedRectPath(ctx, left, top, width, height, cornerRadius)
  ctx.strokeStyle = withAlpha(color, 0.85)
  ctx.lineWidth = 1.2
  ctx.shadowColor = withAlpha(color, 0.6)
  ctx.shadowBlur = 10
  ctx.stroke()
  ctx.shadowBlur = 0

  ctx.fillStyle = '#fff'
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const startY = centerY - textHeight / 2 + LABEL_LINE_HEIGHT / 2
  lines.forEach((line, i) => ctx.fillText(line, centerX, startY + i * LABEL_LINE_HEIGHT))
  ctx.restore()
}

// drawPlungeGauge (the visible plunge-strength cue — a filled track +
// ball-dot + SOFT/FULL PLUNGE label just outside the playfield's right edge)
// and its PLUNGE_GAUGE_X/PLUNGE_GAUGE_BOTTOM_V/PLUNGE_GAUGE_FILL_HALF_W
// constants were DELETED 2026-08-11 (phase A12 item 1 — rolo, reviewing
// production: "the gradient line for the plunger — remove that feature").
// There is now NO visual plunge-strength cue on either render surface.
// classifyPlunge/laneRoute (and the plunge/plungeTo GoalStep fields, and
// goalMeta.ts's SOFT/FULL PLUNGE text CHIPS, which read `step.plunge`
// directly and never called into this gauge) are all UNCHANGED — see the
// file header's phase A12 item 1 note. git history has the deleted body if
// this cue is ever wanted back.

// ---- entry point ----

/**
 * Draws every ring/connector/badge for the goal's whole route, plus (when a
 * tracer is active — see ActiveState) a constant-speed ball flying it. See
 * SPEC-PATHVIZ and design_handoff_shot_coach/README.md §1.
 *
 * Returns the resolved active step index (shotcoach-corrections.md #9) so
 * callers can use it as their ‹ › base instead of re-deriving it via
 * autoHighlightIndex themselves; existing callers that discard the return
 * value (a bare `drawGoalOverlay(ctx, {...})` statement) are unaffected —
 * TypeScript allows a non-void expression statement.
 */
export function drawGoalOverlay(ctx: CanvasRenderingContext2D, o: OverlayOpts): { highlightIndex: number } {
  const steps = o.goal.steps
  if (steps.length === 0) return { highlightIndex: 0 }

  ctx.save()
  try {
    const color = CATEGORY_COLOR[o.goal.category]
    const map = o.map
    const lineBrightness = o.lineBrightness ?? 1
    const trailStyle = o.trailStyle ?? 'dash'
    // Per-model feed resolution (phase A3, 2026-08-10) — see OverlayOpts.trim's
    // own doc comment for why this is a narrowing comparison rather than a
    // plain `?? 'premium-le'`: `o.trim` is typed as a bare `string`, so this
    // is also the stale/unrecognized-value guard (same shape as state.ts's
    // own readTrimPref).
    const trim: 'pro' | 'premium-le' = o.trim === 'pro' ? 'pro' : 'premium-le'
    // Deck/PlayfieldZone routing (phase A4, 2026-08-10) — built ONCE per call
    // (not per-step) since resolveShootingAnchor needs a fast id->zone lookup
    // for every step. undefined (never an empty Map) when o.playfields is
    // absent/empty — resolveShootingAnchor's zoneOf treats that as "no
    // zones", and every deck-aware branch below (step0Anchor/samePlayfieldAt/
    // anchors) is gated on this same undefined-ness, so a zone-less machine
    // takes none of this phase's new code paths at all.
    const zonesById: Map<string, PlayfieldZone> | undefined =
      o.playfields && o.playfields.length > 0 ? new Map(o.playfields.map((z) => [z.id, z])) : undefined
    // Any-order goals (Goal.ordered === false, or per-step link:'none') draw
    // no connector legs — and therefore no flying ball either: a tracer needs
    // a continuous path to fly. The rings/badges still march (rolo 2026-08-02).
    //
    // Phase A10 (2026-08-11, "skillshot = target-only rendering"): a
    // 'skillshot' goal INVERTS this default — every step behaves as if it
    // carried `link:'none'` UNLESS it explicitly carries `link:'route'` (the
    // escape hatch, e.g. a video-verified case where the drawn approach
    // really is safe to show). stepLinkSuppressed is the ONE predicate both
    // Pass 1's leg-suppression (via linkNone/anyLinkNone below) and
    // extLegs' own gate (rule 7 continuations/loop coils, see below) read,
    // so the two can never disagree about which steps are suppressed.
    // Non-skillshot categories are unaffected — `link:'route'` there is a
    // no-op (today's default already draws the leg).
    //
    // Feature 8 (2026-08-11, phase A15, "shot lines toggle"): `o.shotLines
    // === false` forces stepLinkSuppressed true for EVERY step, regardless
    // of category/link — the single gate point named in the file header's
    // own Feature 8 note. This is the exact same "leg suppressed, ring/
    // badge/name still march" mechanism any-order goals and skillshot steps
    // already use, just applied unconditionally; ballTracerOn below reads
    // this same result (via anyLinkNone), so the flying tracer is
    // suppressed too — no line for it to fly along. Default true (o.shotLines
    // !== false) takes none of this branch, reproducing today's exact
    // behavior.
    const shotLinesOn = o.shotLines !== false
    const unordered = o.goal.ordered === false
    const isSkillshot = o.goal.category === 'skillshot'
    const stepLinkSuppressed = (i: number): boolean => {
      if (!shotLinesOn) return true
      const link = steps[i]?.link
      return isSkillshot ? link !== 'route' : link === 'none'
    }
    const linkNone = (i: number) => unordered || stepLinkSuppressed(i)
    const anyLinkNone = unordered || steps.some((_s, i) => stepLinkSuppressed(i))
    // Reduced motion (P5, 2026-08-14) — see OverlayOpts.reducedMotion. The
    // tracer is the biggest single source of motion on this canvas, so it is
    // the first thing to go; resolveActiveState then falls through to the
    // stepped autoHighlightIndex walk, which still advances.
    const reducedMotion = o.reducedMotion === true
    const ballTracerOn = !reducedMotion && o.ballTracer !== false && !anyLinkNone
    const topInset = o.topInset ?? 0

    const t = o.time / 1000 // ms -> s
    /** The clock every PULSING/TRAVELLING effect reads. Frozen at 0 under
     *  reduced motion, which makes the marching dash, the neon sheen and the
     *  ring's sine pulse static — while `t` itself stays live for everything
     *  that must keep ADVANCING (autoHighlightIndex's step walk). */
    const tAnim = reducedMotion ? 0 : t

    // Every drawn path starts where the ball rests (SPEC-BALLSTART); 'any'
    // falls back to the default launch origin — UNLESS the goal itself
    // starts from the plunger (2026-07-28 amendment), in which case the
    // EFFECTIVE launch anchor is the bottom of the shooter lane, not the
    // flat (0.5, 0.03) default.
    const plungeShots = [...o.shotsByID.values()].filter((s) => s.type === 'plunge')
    const plungeShot = plungeShots.length > 0 ? plungeShots.reduce((best, s) => (s.x > best.x ? s : best)) : null
    const machineLaneX = plungeShot ? clamp(plungeShot.x, LANE_MIN_X, LANE_MAX_X) : 0.97
    const plungerAnchorUV: Pt = { x: machineLaneX, y: LANE_BOTTOM_V }
    const step0Shot = o.shotsByID.get(steps[0]!.shot) ?? null
    // Deck launch (phase A4): resolved ONCE here — reused both to gate
    // startsFromPlunger below (a deck shot cannot be plunged directly, so a
    // deck-eligible step 0 must beat the skillshot y>=0.15 heuristic) and,
    // further down, as the 'any'-launch anchor itself.
    // resolveShootingAnchor's own fail-soft fall-through (no zone, or a zone
    // with no bat) makes `.deck` false here exactly when there is nothing new
    // to do, so step0DeckLaunch is false and every expression below that
    // reads it collapses to its pre-A4 form.
    const step0Anchor: ShootingAnchor | null = step0Shot
      ? resolveShootingAnchor(step0Shot, DEFAULT_LAUNCH_UV, steps[0]!.flipper, o.shotsByID, zonesById)
      : null
    const step0DeckLaunch = step0Anchor?.deck === true && step0Shot?.type !== 'plunge'
    const startsFromPlunger =
      !step0DeckLaunch &&
      (step0Shot?.type === 'plunge' || (o.goal.category === 'skillshot' && step0Shot != null && step0Shot.y >= 0.15))
    const plungerLaunch = o.ballPosition === 'plunger' || (o.ballPosition === 'any' && startsFromPlunger)
    // Rule 6(a): a non-plunger launch with ballPosition 'any' anchors at the
    // CROSS FLIPPER of step 0's target (tie-break origin = the flat
    // DEFAULT_LAUNCH_UV) instead of that flat point outright — or, as of
    // phase A4, at step 0's own DECK BAT when it has one (step0Anchor.uv is
    // already that bat's (x,y) in that case; resolveShootingAnchor folds the
    // deck-vs-main choice into one lookup, so this block doesn't need its own
    // copy of that decision). An explicitly selected leftFlipper/rightFlipper/
    // plunger ballPosition is NEVER overridden — this whole block only ever
    // touches the 'any' branch.
    const anyNonPlungerLaunch = o.ballPosition === 'any' && !plungerLaunch
    const launchAnchor: ShootingAnchor | null = anyNonPlungerLaunch ? step0Anchor : null
    const todayLaunchUV: Pt =
      o.ballPosition === 'any'
        ? launchAnchor
          ? launchAnchor.uv
          : DEFAULT_LAUNCH_UV
        : anchorToPt(BALL_ANCHORS[o.ballPosition])
    const effectiveLaunchUV: Pt = plungerLaunch ? plungerAnchorUV : todayLaunchUV
    const launchPoint = map(effectiveLaunchUV.x, effectiveLaunchUV.y)

    const stepShotTypes: (string | undefined)[] = steps.map((step) => o.shotsByID.get(step.shot)?.type)

    fillCircle(ctx, launchPoint, 5, 'rgba(255, 255, 255, .8)')
    strokeCircle(ctx, launchPoint, 9, 'rgba(255, 255, 255, .35)', 1)

    // Resolve every step's target once, in normalized playfield space (for
    // routing geometry) and mapped view space (for drawing).
    const targetsUV: (Pt | null)[] = steps.map((step) => {
      const shot = o.shotsByID.get(step.shot)
      return shot ? { x: shot.x, y: shot.y } : null
    })
    const targets: (Pt | null)[] = steps.map((_step, i) => {
      const uv = targetsUV[i]
      return uv ? map(uv.x, uv.y) : null
    })

    const obstacles: Pt[] = [...o.shotsByID.values()]
      .filter((s) => OBSTACLE_TYPES.has(s.type))
      .map((s) => ({ x: s.x, y: s.y }))

    // Rule 6/7 per-step precomputation:
    //  - exitsUV[i]: step i's resolved feed point (its own `feeds` override,
    //    else its shot's `feeds`) — becomes the ORIGIN of the NEXT segment
    //    when present (rule 7(2)), instead of the entrance ring.
    //  - extLegs[i]: the two elevated entrance->apex->feed legs appended
    //    after step i's entrance ring (rule 7(1)), or null when there's
    //    nothing to extend to (fail-soft — most shots have no feeds at all).
    //  - anchors[i]: the shooting anchor presumed to make step i's shot
    //    (rule 6, deck-aware as of phase A4), used to pick the viaWaypoint
    //    anchor for the segment ARRIVING at step i.
    //  - samePlayfieldAt[i]: phase A4's guard on the both-upper direct
    //    exception — see routeSegment's own doc comment.
    const exitsUV: (Pt | null)[] = steps.map((step) => {
      const shot = o.shotsByID.get(step.shot)
      // Per-trim resolution (phase A3): feedForTrim needs a real Shot to
      // consult feedsByTrim, so an unresolved step.shot id falls back to the
      // step's own override directly — identical to the pre-A3
      // `step.feeds ?? shot?.feeds` for that case.
      return resolveFeedUV(shot ? feedForTrim(shot, step.feeds, trim) : step.feeds, o.shotsByID)
    })
    const extLegs: (LaneLeg[] | null)[] = steps.map((step, index) => {
      // Phase A10: a suppressed skillshot step (or an any-order/link:'none'
      // step) gets NO continuation/loop-coil either — Pass 1 already skips
      // the whole index via linkNone before ever reading `f.rampIdx`, so
      // this gate is redundant with that downstream skip in practice, but
      // making it explicit here (a) documents the intent at the source
      // instead of relying on a non-obvious Pass-1 side effect, and (b)
      // avoids computing a (possibly 18-leg) loop coil that would never be
      // drawn.
      if (stepLinkSuppressed(index)) return null
      const shot = o.shotsByID.get(step.shot)
      const entranceUV = targetsUV[index]
      if (!shot || !entranceUV) return null
      return rampExtensionLegs(entranceUV, shot, step.feeds, o.shotsByID, trim)
    })
    // Rule 6's shooting anchor for the segment ARRIVING at step i — deck-aware
    // as of phase A4 (resolveShootingAnchor), replacing the old bare
    // 'left'|'right' flipperChoice: a deck target's anchor is its own zone's
    // bat, not FLIPPER_ANCHORS. Same fail-soft guard shape as the old array
    // (toUV/fromUV/shot missing -> a fallback that's never actually
    // consulted, since that step's `flats` entry drops out below regardless).
    const anchors: ShootingAnchor[] = steps.map((step, index) => {
      const shot = o.shotsByID.get(step.shot)
      const toUV = targetsUV[index]
      const fromUV = index === 0 ? DEFAULT_LAUNCH_UV : (exitsUV[index - 1] ?? targetsUV[index - 1])
      if (!toUV || !fromUV || !shot) return { uv: FLIPPER_ANCHORS.right, side: 'right', deck: false }
      return resolveShootingAnchor(shot, fromUV, step.flipper, o.shotsByID, zonesById)
    })
    // SAME-PLAYFIELD GUARD (phase A4) on routeSegment's both-upper direct
    // exception: true (i.e. "allowed, no guard") whenever no zones are
    // authored on this machine at all (zonesById undefined) — the ~139
    // zone-less machines take none of this phase's new code, byte-identical
    // to before. With zones authored, direct is allowed only when the
    // PREVIOUS step's shot and THIS step's shot carry the same `.playfield`
    // (both undefined counts as "both main" -> qualifies, same as today); an
    // unresolvable shot id on either side also reads as "same" (fail-soft —
    // a data problem elsewhere shouldn't newly block a route that used to
    // draw fine). index 0 is always true — the isLaunch branch inside
    // routeSegment never consults this argument.
    const samePlayfieldAt: boolean[] = steps.map((step, index) => {
      if (!zonesById || index === 0) return true
      const fromShot = o.shotsByID.get(steps[index - 1]!.shot)
      const toShot = o.shotsByID.get(step.shot)
      return (fromShot?.playfield ?? null) === (toShot?.playfield ?? null)
    })
    // AUTHORED direct (phase A8, 2026-08-11) — GoalStep.direct === true,
    // never true for index 0 (validator-enforced; the isLaunch branch inside
    // routeSegment never consults this argument for index 0 anyway). This is
    // the ONLY way routeSegment's non-launch direct-chord path fires now —
    // see its own doc comment and the file header's phase A8 note.
    const directAt: boolean[] = steps.map((step) => step.direct === true)

    // D1 fix (2026-07-29 review): a segment is plunger-origin ONLY when the
    // previous step's shot is a plunge AND that step resolved no feed exit.
    // Once the ball has been FED OUT of the lane (exitsUV[index-1] set —
    // rule 7(2)) it is no longer in the lane, so the segment's origin is
    // already the feed point, not the lane; routing it through laneRoute
    // anyway would clamp x back into [0.93,0.98] and draw the ball back up
    // the shooter lane it just left (18 goals across 5 machines reproduced
    // this before the fix — e.g. addams_family's skillshot-soft-plunge).
    // Hoisted into its own per-step array (2026-08-10, phase A2) — used to
    // live inline inside the flats.map below, but the new plunge-gauge pass
    // (Pass 1.5, after Pass 1) needs the exact same per-step answer for the
    // ACTIVE step, and a value this load-bearing (it decides whole-route
    // topology) should have exactly one computation both passes read, not
    // two copies that could drift apart.
    const fromPlungerAt: boolean[] = steps.map((_step, index) =>
      index === 0 ? plungerLaunch : exitsUV[index - 1] == null && stepShotTypes[index - 1] === 'plunge',
    )

    // Flatten every connector segment (launch->t0, t0->t1, ...) into a
    // view-space polyline (README §1a) — routing itself (routeSegment) picks
    // the topology, this just decides how the result gets sampled (legs
    // render straight as of 2026-07-29, see the header note). A step whose
    // PREDECESSOR resolved a feed point (exitsUV[index-1]) originates from
    // that feed point instead of the predecessor's entrance ring (rule 7(2)).
    const flats: (FlatSegment | null)[] = steps.map((_step, index) => {
      const toUV = targetsUV[index]
      const toView = targets[index]
      if (!toUV || !toView) return null
      let fromUV: Pt
      let fromView: Pt
      if (index === 0) {
        fromUV = effectiveLaunchUV
        fromView = launchPoint
      } else {
        const exitUV = exitsUV[index - 1]
        if (exitUV) {
          fromUV = exitUV
          fromView = map(exitUV.x, exitUV.y)
        } else {
          const prevUV = targetsUV[index - 1]
          const prevView = targets[index - 1]
          if (!prevUV || !prevView) return null
          fromUV = prevUV
          fromView = prevView
        }
      }
      const route = routeSegment(
        fromUV,
        toUV,
        index === 0,
        fromPlungerAt[index]!,
        obstacles,
        anchors[index]!.uv,
        directAt[index]!,
        samePlayfieldAt[index]!,
        steps[index]!.plunge,
        steps[index]!.plungeTo,
      )
      return flattenSegment(fromView, toView, toUV, route, map, extLegs[index])
    })

    // Manual mode (highlightIndex a finite number) always bypasses the
    // flying ball, tracer or not (README §1b / shotcoach-corrections.md #10).
    const manualIndex =
      typeof o.highlightIndex === 'number' && Number.isFinite(o.highlightIndex)
        ? clamp(o.highlightIndex, 0, steps.length - 1)
        : null
    const active = resolveActiveState(flats, steps.length, o.time, t, manualIndex, ballTracerOn)

    // Pass 1 — the ACTIVE step's routed connector segment (flattened
    // polyline), underneath its ring. 2026-08-11 (phase A12 item 4,
    // active-target-only display — rolo: "only display the name of the
    // target you need to hit for that specific spot of all shots"): every
    // OTHER step's leg is now suppressed outright, not just dimmed — the old
    // three-state active/done/quiet leg treatment (this loop used to run over
    // every step) is retired along with the states it distinguished; see the
    // file header's phase A12 item 4 note and strokeQuietLeg/strokeDoneLeg's
    // own tombstone comment above. The arrowhead still additionally requires
    // the polyline to clear ARROWHEAD_MIN_LEG_PX (finding 3) — the line
    // itself still always draws once the leg itself is eligible.
    //
    // Rule 7: when `f.rampIdx` is set, the flattened polyline carries an
    // elevated entrance->apex->feed tail past the entrance ring. Split it
    // (sliceFlat, no re-sampling) into `main` (what gets the active leg
    // treatment + arrowhead) and `rampPart` (the dotted wireform tail + a
    // landing marker at its end, the feed point) — the arrowhead's
    // min-length gate runs against `main.len`, not the whole (possibly much
    // longer) `f.len`.
    if (!linkNone(active.index)) {
      const f = flats[active.index]
      if (f && f.len >= 1) {
        const hasRamp = f.rampIdx != null && f.rampIdx > 0 && f.rampIdx < f.pts.length
        const main = hasRamp ? sliceFlat(f, 0, f.rampIdx! - 1) : f
        const rampPart = hasRamp ? sliceFlat(f, f.rampIdx! - 1, f.pts.length - 1) : null
        // 2026-08-11 (phase A7): `main` can now be a single-point (0-length)
        // seed — a plunger-origin segment with a surviving rule-7 extension
        // but no lane leg of its own (flattenSegment's `legs.length===0`
        // branch). Gate the leg stroke/arrowhead on there being more than
        // that one point, or strokeActiveLeg would emit a moveTo with no
        // following lineTo — harmless to paint (an empty subpath draws
        // nothing) but a spurious draw call all the same.
        const hasMain = main.pts.length > 1
        const arrowheadOK = hasMain && main.len >= ARROWHEAD_MIN_LEG_PX
        if (hasMain) strokeActiveLeg(ctx, main, color, tAnim, lineBrightness, trailStyle)
        if (rampPart) strokeRampLeg(ctx, rampPart, color, Math.min(1, 0.9 * lineBrightness), 3)
        if (arrowheadOK) drawArrowheadFromTail(ctx, main, withAlpha(color, 1))
        if (rampPart) drawLandingMarker(ctx, rampPart.pts[rampPart.pts.length - 1]!, color)
      }
    }

    // Pass 2 — the ACTIVE step's ring + numbered badge (phase A12 item 4:
    // every other step's is suppressed — see Pass 1's own note above; base
    // shot dots drawn separately by map2d.ts's drawShotDots are unaffected).
    // `isDone` still distinguishes the active step's OWN arrived-vs-
    // still-flying microstate (the brief checkmark flash on arrival, driven
    // by `active.done` catching up to `active.index` during the tracer's
    // dwell phase) — that is not a per-OTHER-step distinction, so it survives
    // unchanged.
    {
      const index = active.index
      const target = targets[index]
      if (target) {
        const isDone = index < active.done
        if (active.tracerRing) {
          drawTracerRing(ctx, target, color, tAnim, trailStyle, active.sinceHit)
        } else {
          // `ease` -> 1 under reduced motion: the ring arrives fully bloomed
          // instead of animating up over HIGHLIGHT_EASE_S.
          drawHighlightTarget(ctx, target, color, tAnim, reducedMotion ? 1 : active.ease)
        }
        // The badge draws ONLY when its number could say something other than
        // "1" — see goalBadgesAreInformative for the two shapes that can't
        // (single-step goals, and every skillshot). The ring and the name
        // caption still draw for those; they are what identifies the target.
        if (goalBadgesAreInformative(o.goal)) drawBadge(ctx, index, isDone, true, target, color)
      }
    }

    // Pass 2.5 — the ACTIVE step's ring caption, i.e. the target's NAME label
    // (phase A12 item 4 drops every other step's caption along with its
    // ring, so the old cross-step collision packer/seen-shot dedup has
    // nothing left to arbitrate between). UNCONDITIONAL as of 2026-08-11
    // (phase A13 — rolo: "if you remove path bubbles from the map setting
    // only remove the bubble; keep the name of the targets popping up"): this
    // used to be gated by showLabels alongside Pass 4's action-label bubble
    // below; now only that bubble reads the flag, so the active target's
    // name always shows regardless of the "Path labels" toggle, same as its
    // ring/badge. Banner exclusion (phase A12 item 3, "target NAME labels
    // near the top of the playfield get covered by the goal banner/pill"):
    // flips to BELOW the ring (the same offset the old collision fallback
    // used) whenever the default above-the-ring position would land inside
    // the reserved `topInset` band, floored at `topInset + 8` either way so
    // the result can never land inside that band regardless of how close to
    // the top the ring itself sits — see the file header's phase A12 item 3
    // note.
    {
      const step = steps[active.index]
      const target = targets[active.index]
      const shot = step ? o.shotsByID.get(step.shot) : undefined
      if (target && shot) {
        const canvasWidth = ctx.canvas.clientWidth || ctx.canvas.width
        const aboveY = target.y - 13
        const capY = aboveY < topInset + 8 ? Math.max(target.y + 26, topInset + 8) : aboveY
        // Card bounds, not the canvas width: see cardXBounds.
        drawHaloLabel(ctx, shot.name, target.x, capY, `600 9.5px ${FONT_STACK}`, 'rgba(255, 255, 255, .88)', 'rgba(5, 13, 31, .85)', cardXBounds(map))
      }
    }

    // Pass 3 — the tracer ball + comet, only while it's actually flying.
    if (active.ball && active.u != null) {
      const f = flats[active.index]
      if (f) drawTracerBall(ctx, f, active.ball, active.u, color)
    }

    // Pass 4 — the active step's action-label bubble rides on top. The ONLY
    // pass showLabels still gates (2026-08-11, phase A13 — see Pass 2.5's
    // note above): toggling "Path labels" off hides just this bubble, never
    // the target's name.
    const labelTarget = targets[active.index]
    if (o.showLabels !== false && labelTarget) {
      const canvasSize = { width: ctx.canvas.clientWidth || ctx.canvas.width, height: ctx.canvas.clientHeight || ctx.canvas.height }
      drawActionLabel(ctx, steps[active.index]!.action, labelTarget, color, canvasSize, topInset)
    }

    // Pass 5 — celebration burst (Feature 3 / phase A11, 2026-08-11): a
    // small emoji scatter at the LAST step's target, only when the caller
    // opts in (o.celebrate) and the active step IS that last step.
    // AUTO/tracer mode times it off active.sinceHit (resets every loop
    // cycle — "celebrate every loop arrival" needs no caller-side
    // bookkeeping; the ballTracer:false auto fallback reuses its own
    // repurposed `sinceHit`, see resolveActiveState's phase A11 note, so it
    // still fires every hold-cycle with the flying ball off). MANUAL mode
    // has no such clock (resolveActiveState parks `sinceHit` null there)
    // and is edge-triggered ("once per arrival, never while sitting") —
    // driven entirely by o.celebrate.manualStartedAt, which is the caller's
    // (map2d.ts's) own arming state machine; this file just draws whatever
    // elapsed time it's handed, or nothing when that's null (not yet
    // armed/already disarmed). Feature 7 (2026-08-11, phase A14): the
    // window `elapsedMs` must fall inside is now the resolved LEVEL's own
    // duration (celebrationParams(level).durationMs), not the flat
    // CELEBRATE_DURATION_MS constant — a higher level's modestly longer
    // hold needs a matching gate, or the burst would visibly cut off
    // mid-animation. `o.celebrate.level ?? 1 > 0` defensively treats a
    // level <= 0 exactly like `o.celebrate` being null (the caller never
    // actually does this — map2d.ts passes `celebrate: null` outright at
    // level 0 — but this file makes no assumption about its callers it
    // doesn't also enforce itself). None of this arming/gating logic
    // (once-per-arrival, last-step-only, every-loop-in-auto) changed.
    // 2026-08-11 (phase A16): the level clamp's ceiling moves from 5 to
    // CELEBRATE_LEVEL_MAX (7) — see the file header's own phase A16 note.
    if (o.celebrate && (o.celebrate.level ?? 1) > 0 && active.index === steps.length - 1) {
      const level = clamp(Math.round(o.celebrate.level ?? 1), 1, CELEBRATE_LEVEL_MAX)
      const duration = celebrationParams(level).durationMs
      const elapsedMs =
        manualIndex !== null
          ? typeof o.celebrate.manualStartedAt === 'number'
            ? o.time - o.celebrate.manualStartedAt
            : null
          : active.sinceHit
      if (elapsedMs != null && elapsedMs >= 0 && elapsedMs < duration) {
        const originView = targets[active.index]
        if (originView) {
          const reduceMotion =
            typeof window !== 'undefined' && typeof window.matchMedia === 'function'
              ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
              : false
          // Canvas-relative reach (phase A16): the same real "CSS-px canvas
          // size, DOM layout value preferred over the backing-store pixel
          // count" idiom Pass 2.5's ring-caption clamp and Pass 4's
          // action-label bubble already use above — see the file header's
          // own phase A16 note for why this is the dimension source chosen
          // over the mapped playfield rect (no new idiom introduced).
          const canvasMin = Math.min(ctx.canvas.clientWidth || ctx.canvas.width, ctx.canvas.clientHeight || ctx.canvas.height)
          drawCelebrationBurst(ctx, originView, o.celebrate.glyph, elapsedMs, reduceMotion, level, canvasMin)
        }
      }
    }

    return { highlightIndex: active.index }
  } finally {
    ctx.restore()
  }
}
