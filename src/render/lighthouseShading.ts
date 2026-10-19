// Drawn shading for the Dream Lighthouse: inked masonry, and the inside lit by its stair lanterns.
// Stair numbers mirror tools/blender/lighthouse.py (and src/core/lighthouseClimb.ts).
import { abs, atan, cameraPosition, color, float, length, max, min, mix, mx_noise_float, sin, smoothstep, time, vec3 } from 'three/tsl';
import { hatchAt, penLines } from './drawn';

type N = any;

const TAU = Math.PI * 2;
const START = 0.6;
const A = TAU / 20;
const RISE = 0.25;
/** First lantern's angle along the stair and the spacing between them (build_lanterns). */
const LANTERN0 = START + 1.95;
const LANTERN_STEP = 3.8;
/** Globe height above the stair's walking line, and its distance from the axis. */
const LANTERN_UP = 2.18;
const LANTERN_R = 2.0;
const LANTERN_TOP = 20.1;

const stairLine = (th: N) => th.sub(START).mul(RISE / A).add(RISE / 2);

/** Angle round the tower axis in model space, 0..2pi, matching the build script. */
export const towerAngle = (lp: N) => atan(lp.z.negate(), lp.x).add(TAU).mod(TAU);

/**
 * Stone courses on walls and flagstones on floors and treads, inked like the rest of the world.
 * Fades out with distance so the tower reads as one shape from afar. Returns 0..1 ink.
 */
export function masonry(lp: N, n: N, wp: N) {
  const r = length(lp.xz);
  const arc = towerAngle(lp).mul(r);
  const dc = length(wp.sub(cameraPosition));
  const upright = smoothstep(0.75, 0.45, abs(n.y));
  const course = lp.y.div(0.62);
  const wall = max(penLines(course, 0.8), penLines(arc.div(1.3).add(course.floor().mul(0.5)), 0.7));
  const ring = r.div(0.8);
  const flags = max(penLines(ring, 0.8), penLines(arc.div(1.1).add(ring.floor().mul(0.5)), 0.7));
  // Joints are drawn, not ruled: some fade out, as an illustrator would leave them.
  const broken = smoothstep(-0.45, -0.1, mx_noise_float(vec3(arc.mul(0.9), lp.y.mul(0.9), r.mul(0.9))));
  return mix(flags, wall, upright).mul(broken).mul(smoothstep(45, 12, dc));
}

/**
 * How brightly the stair lanterns light a point inside the tower, 0..1. Lanterns climb the stair
 * every 3.8 rad, so the nearest one is found by unwinding the point onto the stair's helix.
 */
export function lanternLight(lp: N) {
  const phi = towerAngle(lp);
  const base = phi.sub(START).mod(TAU);
  const turn = lp.y.sub(stairLine(base.add(START))).sub(LANTERN_UP).div(5).add(0.5).floor();
  const th = base.add(START).add(turn.mul(TAU));
  const k = th.sub(LANTERN0).div(LANTERN_STEP).add(0.5).floor().max(0);
  const thk = k.mul(LANTERN_STEP).add(LANTERN0);
  const r = length(lp.xz);
  const along = th.sub(thk).mul(r.max(1));
  const up = lp.y.sub(stairLine(thk).add(LANTERN_UP));
  const out = r.sub(LANTERN_R);
  const d = along.mul(along).add(up.mul(up).mul(0.7)).add(out.mul(out)).sqrt();
  const exists = smoothstep(LANTERN_TOP + 0.5, LANTERN_TOP, stairLine(thk).add(LANTERN_UP));
  const flicker = sin(time.mul(7.3).add(k.mul(2.1))).mul(0.06).add(sin(time.mul(17).add(k)).mul(0.04)).add(0.92);
  const pool = smoothstep(6, 0.8, d).mul(exists).mul(flicker);
  // The orb chains under the top floor and the lamp room's glow spill down the last turn.
  const crown = smoothstep(16.5, 21.5, lp.y).mul(0.75);
  return max(pool, crown);
}

/** The rune circle on the ground floor glows a cold blue up the first turn of the stair. */
export function runeLight(lp: N) {
  const r = length(lp.xz);
  return smoothstep(4, 0.3, lp.y).mul(smoothstep(3.2, 0.8, r).mul(0.5).add(0.5)).mul(0.62);
}

/** The inside of the tower in three lantern-lit tones, hatched where the light doesn't reach. */
export function interiorShade(tint: N, lp: N, wp: N, ink: N) {
  const warmLight = lanternLight(lp);
  const coldLight = runeLight(lp);
  const light = max(warmLight, coldLight);
  const warm = smoothstep(-0.3, 0.02, warmLight.sub(coldLight));
  const edge = sin(lp.y.mul(1.7).add(towerAngle(lp).mul(5))).mul(0.04);
  const lit1 = smoothstep(0.16, 0.22, light.add(edge));
  const lit2 = smoothstep(0.56, 0.62, light.add(edge));
  const glow = mix(color(0x8c9cff), color(0xffb85c), warm);
  const dark = tint.mul(vec3(0.13, 0.12, 0.24));
  // Mid tones lean violet: a neutral grey here falls onto the jungle's olive in the palette pass.
  const mid = tint.mul(0.18).add(glow.mul(0.12)).add(vec3(0.025, 0.0, 0.05));
  const high = tint.mul(0.32).add(glow.mul(0.24));
  const col = mix(dark, mix(mid, high, lit2), lit1);
  const dc = length(wp.sub(cameraPosition));
  const arc = towerAngle(lp).mul(length(lp.xz));
  const hatch = hatchAt(arc, dc, 0.7, 1.0, 0.3).mul(float(1).sub(lit1)).mul(0.6);
  const cross = hatchAt(lp.y.add(arc.mul(0.6)), dc, 0.7, 0.9, 0.3).mul(smoothstep(0.08, 0.0, light)).mul(0.4);
  const lines = min(max(hatch, cross).add(ink.mul(mix(0.3, 0.42, lit1))), 0.85);
  return mix(col, color(0x0b0a1e), lines);
}
