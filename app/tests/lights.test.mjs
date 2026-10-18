import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const lightsPath = path.join(repoRoot, 'app', 'src', 'ui', 'lights.ts');
const map2dPath = path.join(repoRoot, 'app', 'src', 'overlay', 'map2d.ts');

// Create temporary entry file that re-exports everything from lights.ts
const tempDir = mkdtempSync(path.join(tmpdir(), 'pinball-lights-test-'));
const entryPath = path.join(tempDir, 'entry.ts');
writeFileSync(entryPath, `export * from '${lightsPath.replace(/\\/g, '\\\\')}';\n` +
  `export { drawLitInsert, drawLitSites } from '${map2dPath.replace(/\\/g, '\\\\')}';\n`);

let bundlePath;
try {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    loader: { '.css': 'empty' },
    outfile: path.join(tempDir, 'bundle.mjs'),
    write: false,
  });
  bundlePath = path.join(tempDir, 'bundle.mjs');
  writeFileSync(bundlePath, result.outputFiles[0].text);
} catch (e) {
  rmSync(tempDir, { recursive: true, force: true });
  console.error('Bundling failed:', e);
  process.exit(1);
}

let mod;
try {
  mod = await import(bundlePath);
} catch (e) {
  rmSync(tempDir, { recursive: true, force: true });
  console.error('Import failed:', e);
  process.exit(1);
}

// Cleanup temp files
rmSync(tempDir, { recursive: true, force: true });

// Destructure all needed functions and constants
const {
  howItPlaysOf,
  resolveSites,
  groupsForShot,
  inputLabel,
  controlLine,
  laneChangeLine,
  isLaneChangeDemo,
  demoSiteCount,
  stepAt,
  glowAt,
  animationEndS,
  PULSE_S,
  STEP_S,
  DEMO_CYCLES,
  PULSE_CYCLES,
} = mod;

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`PASS: ${msg}`);
  } else {
    fail++;
    console.error(`FAIL: ${msg}`);
  }
}

// Helper to create a valid HowItPlays for testing
function makeValidHip(overrides = {}) {
  return {
    objective: 'Score big points',
    loop: ['Shoot ramp', 'Light lock', 'Start multiball'],
    lights: [
      { id: 'g1', name: 'Group1', kind: 'lanes', sites: [], lit: 'Lit', then: 'Shoot', control: null, goals: null },
      { id: 'g2', name: 'Group2', kind: 'multiplier', sites: [], lit: 'Lit', then: 'Shoot', control: null, goals: null },
    ],
    laneChange: 'unknown',
    laneChangeNote: null,
    scoring: [
      { tier: 'ball-one', text: 'Start ball', goals: null },
      { tier: 'building', text: 'Build', goals: null },
      { tier: 'the-big-one', text: 'Big one', goals: null },
    ],
    ...overrides,
  };
}

// ---- howItPlaysOf tests ----
assert(howItPlaysOf(null) === null, 'howItPlaysOf(null) -> null');
assert(howItPlaysOf(undefined) === null, 'howItPlaysOf(undefined) -> null');
assert(howItPlaysOf({}) === null, 'howItPlaysOf({}) -> null (no howItPlays)');
assert(howItPlaysOf({ howItPlays: null }) === null, 'howItPlaysOf({howItPlays:null}) -> null');
assert(howItPlaysOf({ howItPlays: {} }) === null, 'howItPlaysOf({howItPlays:{}}) -> null (missing fields)');
const invalidLaneChange = makeValidHip({ laneChange: 'garbage' });
assert(howItPlaysOf({ howItPlays: invalidLaneChange }) === null, 'howItPlaysOf invalid laneChange -> null');
const invalidScoringLen = makeValidHip({ scoring: [{ tier: 'ball-one', text: 'x' }] });
assert(howItPlaysOf({ howItPlays: invalidScoringLen }) === null, 'howItPlaysOf scoring len!=3 -> null');
const validHip = makeValidHip();
assert(howItPlaysOf({ howItPlays: validHip }) === validHip, 'howItPlaysOf valid returns same object');

// ---- resolveSites tests ----
const groupShotSite = {
  id: 'gps',
  name: 'Group PS',
  kind: 'lanes',
  sites: [
    { shot: 'shot1', lamps: 2 },
    { shot: 'shotMissing', lamps: null },
    { x: 10, y: 20, name: 'freeLamp' },
  ],
  lit: 'Lit',
  then: 'Then',
};
const shotsByID = {
  shot1: { x: 100, y: 200, type: 'ramp', trim: 'all' },
  shotPremium: { x: 300, y: 400, type: 'standup', trim: 'premium-le' },
};

// Test trim = 'pro'
let resolved = resolveSites(groupShotSite, shotsByID, 'pro');
assert(resolved.length === 2, 'resolveSites drops missing shot and keeps free lamp under pro (2 total)');
assert(resolved[0].shotId === 'shot1' && resolved[0].x === 100 && resolved[0].y === 200, 'resolveSites correct coords for shot site');
assert(resolved[0].shape === 'arrow', 'resolveSites shape from type arrow');
assert(resolved[0].lamps === 2, 'resolveSites carries lamps');
assert(resolved[1].shotId === null && resolved[1].shape === 'dot', 'free lamp has shotId null and shape dot');
assert(resolved[1].x === 10 && resolved[1].y === 20, 'free lamp coords preserved');

// Add premium shot to group
groupShotSite.sites.push({ shot: 'shotPremium', lamps: null });
resolved = resolveSites(groupShotSite, shotsByID, 'pro');
assert(resolved.length === 2, 'premium-le shot dropped under trim pro');
resolved = resolveSites(groupShotSite, shotsByID, 'premium-le');
assert(resolved.length === 3, 'premium-le shot kept under trim premium-le');

// ---- groupsForShot tests ----
const hipForGroups = makeValidHip();
hipForGroups.lights[0].sites = [{ shot: 'shared', lamps: null }];
hipForGroups.lights[1].sites = [{ x: 5, y: 6, name: 'free' }];
assert(JSON.stringify(groupsForShot('shared', hipForGroups)) === '["g1"]', 'groupsForShot returns correct group id');
assert(groupsForShot('nonexistent', hipForGroups).length === 0, 'groupsForShot returns empty for unknown shot');

// ---- inputLabel tests ----
assert(inputLabel('left-flipper') === 'Left flipper', 'inputLabel left-flipper');
assert(inputLabel('right-flipper') === 'Right flipper', 'inputLabel right-flipper');
assert(inputLabel('either-flipper') === 'Either flipper', 'inputLabel either-flipper');
assert(inputLabel('both-flippers') === 'Both flippers', 'inputLabel both-flippers');
assert(inputLabel('action-button') === 'Action button', 'inputLabel action-button');
assert(inputLabel('plunger') === 'Plunger', 'inputLabel plunger');
assert(inputLabel('none') === 'None', 'inputLabel none');

// ---- controlLine tests ----
assert(controlLine(null) === 'Game decides', 'controlLine null -> Game decides');
assert(controlLine({ input: 'none', effect: 'nothing' }) === 'No player control', 'controlLine none -> No player control');
assert(controlLine({ input: 'left-flipper', effect: 'changes lane', when: 'when lit' }) === 'Left flipper: changes lane (when lit)', 'controlLine with when');
assert(controlLine({ input: 'action-button', effect: 'starts mode' }) === 'Action button: starts mode', 'controlLine no when');

// ---- laneChangeLine tests ----
const hipUnknown = makeValidHip({ laneChange: 'unknown' });
assert(laneChangeLine(hipUnknown) === 'Not verified for this machine yet.', 'laneChangeLine unknown');
const hipFlippersNote = makeValidHip({ laneChange: 'flippers', laneChangeNote: 'rotates XYZ' });
assert(laneChangeLine(hipFlippersNote) === 'Flipper buttons move the lit lane. rotates XYZ', 'laneChangeLine flippers with note');
const hipAction = makeValidHip({ laneChange: 'action-button' });
assert(laneChangeLine(hipAction) === 'The action button moves the lit lane.', 'laneChangeLine action-button no note');
const hipNone = makeValidHip({ laneChange: 'none' });
assert(laneChangeLine(hipNone) === "The lit lane can't be moved - plunge or aim for the one you want.", 'laneChangeLine none');

// ---- isLaneChangeDemo and demoSiteCount tests ----
// group with 2 shot sites, kind 'lanes', hip laneChange flippers
const group2Sites = {
  id: 'g2s',
  name: 'Two sites',
  kind: 'lanes',
  sites: [{ shot: 'a', lamps: null }, { shot: 'b', lamps: null }],
  control: null,
};
assert(demoSiteCount(group2Sites) === 2, 'demoSiteCount 2 sites = 2');
assert(isLaneChangeDemo(group2Sites, makeValidHip({ laneChange: 'flippers' })) === true, 'isLaneChangeDemo true for lanes + flippers + 2 sites');

// single site with lamps=3
const group1SiteLamps = {
  id: 'g1l',
  name: 'One site lamps',
  kind: 'lanes',
  sites: [{ shot: 'a', lamps: 3 }],
  control: null,
};
assert(demoSiteCount(group1SiteLamps) === 3, 'demoSiteCount single site lamps=3 -> 3');
assert(isLaneChangeDemo(group1SiteLamps, makeValidHip({ laneChange: 'flippers' })) === true, 'isLaneChangeDemo true for single site lamps>=2 with flippers laneChange');

// flipper control on non-lanes group
const groupFlipperControl = {
  id: 'gfc',
  name: 'Flipper control',
  kind: 'multiplier',
  sites: [{ shot: 'a', lamps: null }, { shot: 'b', lamps: null }],
  control: { input: 'left-flipper', effect: 'do thing' },
};
assert(isLaneChangeDemo(groupFlipperControl, makeValidHip({ laneChange: 'none' })) === true, 'isLaneChangeDemo true for flipper control');
// false cases
assert(isLaneChangeDemo(group2Sites, makeValidHip({ laneChange: 'none' })) === false, 'isLaneChangeDemo false when laneChange none');
const groupNoFlipper = { ...group2Sites, control: { input: 'action-button', effect: 'x' } };
assert(isLaneChangeDemo(groupNoFlipper, makeValidHip({ laneChange: 'flippers' })) === false, 'isLaneChangeDemo false for action-button control');
const groupLanesNoFlipperChange = { ...group2Sites, kind: 'status' };
assert(isLaneChangeDemo(groupLanesNoFlipperChange, makeValidHip({ laneChange: 'flippers' })) === false, 'isLaneChangeDemo false when kind not lanes and no flipper control');
assert(demoSiteCount({ sites: [{ shot: 'a', lamps: null }] }) === 0, 'demoSiteCount 0 for 1 site no lamps');

// ---- stepAt tests ----
assert(stepAt(0, 3, false) === 0, 'stepAt t=0 -> 0');
assert(stepAt(0.69, 3, false) === 0, 'stepAt t=0.69 -> 0');
assert(stepAt(0.7, 3, false) === 1, 'stepAt t=0.7 -> 1');
assert(stepAt(1.4, 3, false) === 2, 'stepAt t=1.4 -> 2');
assert(stepAt(2.1, 3, false) === 0, 'stepAt t=2.1 second cycle -> 0');
const totalDemoTime = 3 * DEMO_CYCLES * STEP_S; // 4.2
assert(stepAt(totalDemoTime, 3, false) === null, 'stepAt at end -> null');
assert(stepAt(totalDemoTime + 0.1, 3, false) === null, 'stepAt after end -> null');
assert(stepAt(0, 3, true) === null, 'stepAt reducedMotion -> null');
assert(stepAt(0, 0, false) === null, 'stepAt n=0 -> null');

// ---- glowAt tests ----
assert(glowAt(0, true) === 1, 'glowAt reducedMotion -> 1');
const pulseEnd = PULSE_CYCLES * PULSE_S;
assert(glowAt(pulseEnd, false) === 1, 'glowAt at pulse end -> 1');
assert(glowAt(pulseEnd + 1, false) === 1, 'glowAt after pulse end -> 1');
assert(glowAt(0, false) === 1, 'glowAt t=0 -> 1 (sin 0)');
assert(glowAt(PULSE_S / 4, false) > 1, 'glowAt quarter pulse > 1');
assert(glowAt(PULSE_S / 2, false) === 1, 'glowAt half pulse -> 1');

// ---- animationEndS tests ----
assert(animationEndS(group2Sites, makeValidHip({ laneChange: 'none' }), true) === 0, 'animationEndS reducedMotion -> 0');
assert(animationEndS(group2Sites, makeValidHip({ laneChange: 'none' }), false) === pulseEnd, 'animationEndS non-demo -> pulseEnd');
const demoGroupBigN = {
  id: 'gbn',
  name: 'Big N demo',
  kind: 'lanes',
  sites: [{ shot: 'a', lamps: null }, { shot: 'b', lamps: null }, { shot: 'c', lamps: null }, { shot: 'd', lamps: null }, { shot: 'e', lamps: null }],
  control: null,
};
const demoEndBig = 5 * DEMO_CYCLES * STEP_S; // 7.0
assert(animationEndS(demoGroupBigN, makeValidHip({ laneChange: 'flippers' }), false) === demoEndBig, 'animationEndS demo with big n -> demoEnd (7s)');
const demoGroupSmall = group2Sites; // 2 sites, demoEnd=2*2*0.7=2.8 < 3.3
assert(animationEndS(demoGroupSmall, makeValidHip({ laneChange: 'flippers' }), false) === pulseEnd, 'animationEndS demo with small n -> pulseEnd (3.3s)');

// ---- summary ----

// ---- map primitive: drawLitInsert / drawLitSites (recording context) ----
function recCtx() {
  const calls = [];
  const rec = {};
  for (const m of ['save','restore','beginPath','moveTo','lineTo','arc','arcTo','quadraticCurveTo','bezierCurveTo','closePath','fill','stroke','rect','ellipse','setLineDash','translate','scale','rotate','clip']) {
    rec[m] = (...a) => calls.push([m, ...a]);
  }
  for (const prop of ['shadowColor','shadowBlur','fillStyle','strokeStyle','lineWidth','globalAlpha','font','lineJoin','lineCap']) {
    let v;
    Object.defineProperty(rec, prop, { get: () => v, set: (x) => { v = x; calls.push(['set:' + prop, x]); }, configurable: true });
  }
  rec._calls = calls;
  return rec;
}
const litMap = (u, v) => ({ x: u * 100, y: v * 100 });
const litSites = [{ u: 0.1, v: 0.2, shape: 'arrow' }, { u: 0.3, v: 0.4, shape: 'bar' }];

let lctx = recCtx();
mod.drawLitSites(lctx, litSites, litMap, {});
const translates = lctx._calls.filter((c) => c[0] === 'translate');
assert(translates.length === 2 && translates[0][1] === 10 && translates[0][2] === 20, 'drawLitSites translates once per site at mapped points');
assert(lctx._calls.filter((c) => c[0] === 'set:shadowBlur' && c[1] === 16).length === 2, 'drawLitSites only:null lights every site (2 halos)');

lctx = recCtx();
mod.drawLitSites(lctx, litSites, litMap, { only: 0 });
assert(lctx._calls.filter((c) => c[0] === 'set:shadowBlur' && c[1] === 16).length === 1, 'drawLitSites only:0 lights just that index (1 halo)');
assert(lctx._calls.filter((c) => c[0] === 'translate').length === 2, 'drawLitSites only:0 still positions every site');

lctx = recCtx();
mod.drawLitInsert(lctx, 'arrow', 5.5, 1);
assert(lctx._calls.some((c) => c[0] === 'set:strokeStyle' && c[1] === '#ffc85f'), 'drawLitInsert glow1: amber stroke #ffc85f');
assert(lctx._calls.some((c) => c[0] === 'set:lineWidth' && c[1] === 1.6), 'drawLitInsert glow1: lineWidth 1.6');
assert(lctx._calls.some((c) => c[0] === 'set:shadowBlur' && c[1] === 16), 'drawLitInsert glow1: shadowBlur 16');
assert(lctx._calls.some((c) => c[0] === 'set:fillStyle' && /rgba\(255, 176, 46, 0\.550\)/.test(String(c[1]))), 'drawLitInsert glow1: fill amber 0.55');
assert(lctx._calls.some((c) => c[0] === 'set:shadowColor' && /rgba\(255, 176, 46, 0\.850\)/.test(String(c[1]))), 'drawLitInsert glow1: halo amber 0.85');


console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
