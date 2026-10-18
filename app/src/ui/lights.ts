import type { GameData, HowItPlays, LightGroup, LightInput, LightControl } from '../models';
// Insert-shape vocabulary + mapping come from map2d (the single source of truth for
// which silhouette a shot type draws). insertShapeFor is a pure function over a plain
// string table — no canvas/DOM — so importing it keeps this module test-pure.
import { insertShapeFor, type InsertShape } from '../overlay/map2d';


export interface ResolvedSite {
  x: number;
  y: number;
  shape: InsertShape;
  shotId: string | null;   // null for free lamps
  lamps: number | null;
}

export interface ShotMinimal {
  x: number;
  y: number;
  type: string;
  trim?: string; // 'pro' | 'premium-le'
}

export const PULSE_S = 1.1;
export const STEP_S = 0.7;
export const DEMO_CYCLES = 2;
export const PULSE_CYCLES = 3;

export function howItPlaysOf(data: GameData | null | undefined): HowItPlays | null {
  if (data == null || typeof data !== 'object') return null;
  const hip = data.howItPlays;
  if (hip == null || typeof hip !== 'object') return null;

  if (typeof hip.objective !== 'string' || hip.objective.trim() === '') return null;
  // Fail-soft: show the surface whenever it is RENDERABLE, not only when it
  // hits the authoring quality bands (loop 3-5, lights 2-10) the validator warns
  // on. Empty is the only unrenderable case.
  if (!Array.isArray(hip.loop) || hip.loop.length < 1) return null;
  if (!hip.loop.every(item => typeof item === 'string')) return null;
  if (!Array.isArray(hip.lights) || hip.lights.length < 1) return null;
  if (!hip.lights.every(lg =>
    typeof lg === 'object' && lg != null &&
    typeof lg.id === 'string' && typeof lg.name === 'string' && typeof lg.kind === 'string' &&
    Array.isArray(lg.sites)  // a group with zero placeable sites still renders in the sheet (plan D2)
  )) return null;

  const laneChanges = ['flippers', 'action-button', 'none', 'unknown'];
  if (!laneChanges.includes(hip.laneChange)) return null;

  if (!Array.isArray(hip.scoring) || hip.scoring.length !== 3) return null;
  const tiers = ['ball-one', 'building', 'the-big-one'];
  for (let i = 0; i < 3; i++) {
    const step = hip.scoring[i];
    if (typeof step !== 'object' || step == null || step.tier !== tiers[i] || typeof step.text !== 'string') return null;
  }

  return hip;
}

export function lightGroups(hip: HowItPlays | null | undefined): LightGroup[] {
  return hip?.lights ?? [];
}

export function resolveSites(
  group: LightGroup,
  shotsByID: Record<string, ShotMinimal>,
  trim: 'pro' | 'premium-le'
): ResolvedSite[] {
  const resolved: ResolvedSite[] = [];
  for (const site of group.sites) {
    if ('shot' in site) {
      const shotId = site.shot;
      const shot = shotsByID[shotId];
      if (!shot) continue;
      if (trim !== 'premium-le' && shot.trim === 'premium-le') continue;
      resolved.push({
        x: shot.x,
        y: shot.y,
        shape: insertShapeFor(shot.type),
        shotId: shotId,
        lamps: site.lamps ?? null
      });
    } else {
      // Free lamp: keep always, shape 'dot'
      resolved.push({
        x: site.x,
        y: site.y,
        shape: 'dot',
        shotId: null,
        lamps: null
      });
    }
  }
  return resolved;
}

export function groupsForShot(shotId: string, hip: HowItPlays | null | undefined): string[] {
  if (!hip || !Array.isArray(hip.lights)) return [];
  const ids: string[] = [];
  for (const group of hip.lights) {
    if (group.sites.some(site => 'shot' in site && site.shot === shotId)) {
      ids.push(group.id);
    }
  }
  return ids;
}

export function inputLabel(input: LightInput): string {
  switch (input) {
    case 'left-flipper': return 'Left flipper';
    case 'right-flipper': return 'Right flipper';
    case 'either-flipper': return 'Either flipper';
    case 'both-flippers': return 'Both flippers';
    case 'action-button': return 'Action button';
    case 'plunger': return 'Plunger';
    case 'none': return 'None';
    default: return input; // fallback, should not happen
  }
}

export function controlLine(control: LightControl | null | undefined): string {
  if (!control) return 'Game decides';
  if (control.input === 'none') return 'No player control';
  let line = `${inputLabel(control.input)}: ${control.effect}`;
  if (control.when) line += ` (${control.when})`;
  return line;
}

export function laneChangeLine(hip: HowItPlays): string {
  if (!hip) return '';
  const note = hip.laneChangeNote ? ` ${hip.laneChangeNote}` : '';
  switch (hip.laneChange) {
    case 'flippers': return `Flipper buttons move the lit lane.${note}`;
    case 'action-button': return `The action button moves the lit lane.${note}`;
    case 'none': return `The lit lane can't be moved - plunge or aim for the one you want.${note}`;
    default: return 'Not verified for this machine yet.';
  }
}

export function demoSiteCount(group: LightGroup): number {
  const shotSites = group.sites.filter(site => 'shot' in site);
  if (shotSites.length === 1 && shotSites[0].lamps != null && shotSites[0].lamps >= 2) {
    return shotSites[0].lamps;
  }
  if (shotSites.length >= 2) return shotSites.length;
  return 0;
}

export function isLaneChangeDemo(group: LightGroup, hip: HowItPlays): boolean {
  const flipperInputs: LightInput[] = ['left-flipper', 'right-flipper', 'either-flipper', 'both-flippers'];
  const hasFlipperControl = group.control != null && flipperInputs.includes(group.control.input);
  // An explicit non-flipper control is authoritative for its own group and
  // suppresses the machine-level lanes demo (e.g. an action-button lanes group
  // on a table whose OTHER lanes lane-change with the flippers).
  const explicitNonFlipper = group.control != null && !flipperInputs.includes(group.control.input);
  const isLaneChangeKind = !explicitNonFlipper && hip.laneChange === 'flippers' && group.kind === 'lanes';
  if (!(hasFlipperControl || isLaneChangeKind)) return false;
  return demoSiteCount(group) > 0;
}

export function glowAt(elapsedS: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  if (elapsedS < 0) elapsedS = 0;
  const pulseDuration = PULSE_CYCLES * PULSE_S;
  if (elapsedS >= pulseDuration) return 1;
  const phase = (elapsedS % PULSE_S) / PULSE_S;
  return 1 + 0.5 * Math.sin(phase * 2 * Math.PI);
}

export function stepAt(elapsedS: number, n: number, reducedMotion: boolean): number | null {
  if (reducedMotion || n <= 0) return null;
  const totalSteps = n * DEMO_CYCLES;
  const totalTime = totalSteps * STEP_S;
  if (elapsedS >= totalTime) return null;
  return Math.floor(elapsedS / STEP_S) % n;
}

export function animationEndS(group: LightGroup, hip: HowItPlays, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const pulseEnd = PULSE_CYCLES * PULSE_S;
  if (isLaneChangeDemo(group, hip)) {
    const n = demoSiteCount(group);
    const demoEnd = n * DEMO_CYCLES * STEP_S;
    return Math.max(pulseEnd, demoEnd);
  }
  return pulseEnd;
}
