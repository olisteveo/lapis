// Dark Water: her despair, as starless black water that creeps in from the horizon through the night
// (docs/STORY.md, docs/SURVIVAL.md). Restored constellations hold it back around their regions.
// Engine-agnostic: the water, sparkles, palms and fog read the same field through render/darkWater.ts.

import type { SurvivalMode } from './survival';

/** A clear circle the Dark Water can't enter: a restored region, or the shore you woke on. */
export interface Refuge {
  x: number;
  z: number;
  r: number;
}

/** Distance from the island's heart at which the Dark Water starts, and how close it comes by dawn. */
export const REACH_FAR = 6200;
export const REACH_NEAR: Record<Exclude<SurvivalMode, 'wander'>, number> = { survival: 2300, story: 3300 };
/** Width of its soft edge, in metres. */
export const EDGE = 180;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How far from the island's heart the Dark Water has reached at this point of the night. */
export function darkReach(night: number, mode: SurvivalMode) {
  if (mode === 'wander') return Infinity;
  return REACH_FAR - (REACH_FAR - REACH_NEAR[mode]) * smooth(0.2, 0.95, night);
}

/** 0 clear to 1 fully dark at (x, z). Refuges clear it out to 1.2 r, fading to nothing by 1.8 r. */
export function darkAt(x: number, z: number, reach: number, refuges: readonly Refuge[]) {
  if (!Number.isFinite(reach)) return 0;
  let dark = smooth(reach - EDGE, reach + EDGE, Math.hypot(x, z));
  if (dark <= 0) return 0;
  for (const f of refuges) dark *= 1 - smooth(f.r * 1.8, f.r * 1.2, Math.hypot(x - f.x, z - f.z));
  return dark;
}
