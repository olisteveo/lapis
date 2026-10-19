// The parity test world. Mirrored exactly by sbox/Lapis.Parity/TestWorld.cs: any change here
// must be made there too, or the traces stop meaning anything.
import type { Colliders, Platforms, WorldQuery } from './ts/player.ts';

const TAU = Math.PI * 2;

/** Spiral stair tower, a cut-down LighthouseClimb: treads every 0.25 m, stacked turns, a newel and a wall with one door. */
export const TOWER = { x: -20, y: 2, z: 0 };
const RISE = 0.25;
const STEP_ANGLE = 0.314159;
const START = 0.6;
const STEPS = 40;
const NEWEL = 0.35;
const WALL_IN = 2.5;
const WALL_OUT = 2.85;
const DOOR_WIDTH = 1.4;

/** A flat-topped rock ledge you have to jump onto, and a tall pillar to glide from. */
export const LEDGE = { x0: -10, x1: -6, z0: 6, z1: 10, top: 2.0 };
export const PILLAR = { x: -4, z: 20, r: 1.5, top: 12 };
export const ROCK = { x: 32, z: -9.5, r: 2 };

export function height(x: number, z: number) {
  let h = 1.5 + 0.35 * Math.sin(0.21 * x + 0.3) + 0.3 * Math.cos(0.17 * z) + 0.15 * Math.sin(0.13 * (x + z));
  h -= 0.3 * Math.max(0, x - 12);
  // A level pad around the tower, blended so the walk in is gentle.
  const d = Math.hypot(x - TOWER.x, z - TOWER.z);
  const w = Math.max(0, Math.min(1, (8 - d) / 3));
  return h + (TOWER.y - h) * w;
}

export function flow(x: number, z: number) {
  // A star current running north over open water beyond x = 30, z > 20.
  if (x < 30) return { x: 0, z: 0 };
  const s = 4 * Math.max(0, Math.min(1, (z - 20) / 10));
  return { x: 0.6 * Math.sin(z * 0.1) * s * 0.25, z: s };
}

export const world: WorldQuery = { height, flow };

const CIRCLES: [number, number, number][] = [
  [5, 8, 0.6],
  [-4, 3, 0.8],
  [2, -6, 0.5],
];

export const colliders: Colliders = {
  near(x, z, reach, visit) {
    for (const [cx, cz, r] of CIRCLES) if (Math.hypot(x - cx, z - cz) <= reach + r) visit(cx, cz, r);
  },
};

const angleGap = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI);

function towerLocal(x: number, z: number) {
  const dx = x - TOWER.x;
  const dz = z - TOWER.z;
  if (Math.abs(dx) > 7 || Math.abs(dz) > 7) return null;
  const phi = ((Math.atan2(-dz, dx) % TAU) + TAU) % TAU;
  return { r: Math.hypot(dx, dz), phi };
}

function towerSurfaces(r: number, phi: number) {
  const out: number[] = [];
  if (r > NEWEL - 0.05 && r <= WALL_IN + 0.05) {
    for (let k = 0; k < 4; k++) {
      const i = Math.floor((((phi - START + TAU) % TAU) + k * TAU) / STEP_ANGLE);
      if (i >= STEPS) break;
      out.push((i + 1) * RISE);
    }
  }
  return out;
}

export const platforms: Platforms = {
  top(x, z, y = Infinity) {
    let best = -Infinity;
    if (x >= LEDGE.x0 && x <= LEDGE.x1 && z >= LEDGE.z0 && z <= LEDGE.z1) best = LEDGE.top;
    if (Math.hypot(x - PILLAR.x, z - PILLAR.z) <= PILLAR.r) best = Math.max(best, PILLAR.top);
    const L = towerLocal(x, z);
    if (L) {
      const h = y - TOWER.y;
      for (const s of towerSurfaces(L.r, L.phi)) if (s <= h + 0.55 && TOWER.y + s > best) best = TOWER.y + s;
    }
    return best;
  },
  blocked(x, z, y, b = 0.35) {
    const L = towerLocal(x, z);
    if (!L) return false;
    const h = y - TOWER.y;
    if (L.r < NEWEL + b && h < 12) return true;
    if (L.r > WALL_IN - b && L.r < WALL_OUT + b && h < 12) {
      const inDoor = h < 1.5 && angleGap(L.phi, 0) * L.r < DOOR_WIDTH / 2 - b * 0.5;
      if (!inDoor) return true;
    }
    for (const s of towerSurfaces(L.r, L.phi)) if (s > h + 0.55 && s - 0.32 < h + 1.75) return true;
    return false;
  },
  ceiling(x, z, y) {
    const L = towerLocal(x, z);
    if (!L) return Infinity;
    const h = y - TOWER.y;
    let best = Infinity;
    for (const s of towerSurfaces(L.r, L.phi)) if (s - 0.32 > h + 0.55 && s - 0.32 < best) best = s - 0.32;
    return TOWER.y + best;
  },
  blocksBoat(x, z, radius) {
    return Math.hypot(x - ROCK.x, z - ROCK.z) < ROCK.r + radius;
  },
};
