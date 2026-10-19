import type { Platforms } from './player';

// Geometry of the hollow DreamLighthouse (tools/blender/lighthouse.py, public/models/lighthouse.json),
// in model units; angles are counter-clockwise from +X seen from above, i.e. atan2(-z, x).
const RISE = 0.25;
const STEP_ANGLE = 0.314159;
const START = 0.6;
const STEPS = 87;
const TREAD_T = 0.32;
const NEWEL = 0.35;
const WALL = 0.35;
const FLOOR = 0.2;
const TOP = { z: 22, slab: 0.3, outer: 2.05, open: { from: 5.940708, to: 2.799115 } };
const GALLERY = { z: 22, slab: 0.4, inner: 2.4, outer: 4.4, rail: 4.3 };
const PARAPET = { z: 23.02, outer: 2.52 };
const GLASS = { r: 2.15, half: 0.06, top: 26.3 };
// from: lowest feet height that counts as being in the doorway (terrain outside can sit below the sill).
const DOOR = { angle: 0, width: 1.4, from: -Infinity, spring: 2.0 };
const GALLERY_DOOR = { angle: 4.31969, width: 1.2, from: 21.6, spring: 23.7 };
// Rails stop a walker well above their real height so nobody hops one off the top of a tower.
const RAIL_STOP = 3;
const WELL_RAIL = { angle: TOP.open.from, half: 0.05 };
/** A walker's body: steps up to STEP are walked onto, anything between that and HEAD is in the way. */
const STEP = 0.55;
const HEAD = 1.75;
const TAU = Math.PI * 2;

const outerR = (z: number) => (z <= 22 ? 3.2 - (0.8 * z) / 22 : 2.4);
const innerR = (z: number) => outerR(z) - WALL;
const angleGap = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI);
const inOpen = (phi: number) => phi >= TOP.open.from || phi <= TOP.open.to;

/** The wall's radial extent at height z (inner, outer), or null above the glazing. */
function wallAt(z: number): [number, number] | null {
  if (z <= TOP.z) return [innerR(z), outerR(z)];
  if (z <= PARAPET.z) return [innerR(TOP.z), PARAPET.outer];
  if (z <= GLASS.top) return [GLASS.r - GLASS.half, GLASS.r + GLASS.half];
  return null;
}

/** Height of a doorway's arch at a sideways offset u (metres from its centre line). */
function archTop(d: typeof DOOR, u: number) {
  const half = d.width / 2;
  return d.spring + Math.sqrt(Math.max(0, half * half - u * u));
}

/** Is a body of radius b with feet at h, at radius r and angle phi, between one of the doorways' sides? */
function doorAt(r: number, phi: number, h: number, b: number) {
  for (const d of [DOOR, GALLERY_DOOR]) {
    const u = angleGap(phi, d.angle) * r;
    if (h >= d.from && u < d.width / 2 - b) return { d, u };
  }
  return null;
}

/** Top of every tread at this angle, bottom turn first. */
function treadTops(phi: number, r: number) {
  const out: number[] = [];
  if (r < NEWEL - 0.05) return out;
  for (let k = 0; k < 6; k++) {
    const i = Math.floor((((phi - START + TAU) % TAU) + k * TAU) / STEP_ANGLE);
    if (i >= STEPS) break;
    const top = (i + 1) * RISE;
    if (r <= innerR(top) + 0.05) out.push(top);
  }
  return out;
}

/** Slabs overhead or underfoot: [bottom, top] heights of treads, the top floor and the gallery here. */
function slabs(phi: number, r: number) {
  const out: [number, number][] = treadTops(phi, r).map((t) => [t - TREAD_T, t]);
  if (r >= NEWEL && r <= GALLERY.outer && (r > TOP.outer || !inOpen(phi))) out.push([TOP.z - (r > TOP.outer ? GALLERY.slab : TOP.slab), TOP.z]);
  return out;
}

/**
 * What solid part of the tower a walker's body (feet at h, radius b) is inside, or '' if none.
 * Only what is between STEP and HEAD above the feet counts: lower things are stepped onto.
 * Model units throughout; exported so the probe can test the controller against the same shapes.
 */
export function solidAt(r: number, phi: number, h: number, b: number): string {
  const lo = h + STEP;
  const hi = h + HEAD;
  if (r < NEWEL + b && lo < 22.9) return 'newel';
  for (let k = 0; k <= 6; k++) {
    const z = lo + ((hi - lo) * k) / 6;
    const w = wallAt(z);
    if (!w || z < 0 || r <= w[0] - b || r >= w[1] + b) continue;
    const door = doorAt(r, phi, h, b);
    if (door && hi < archTop(door.d, door.u + b)) continue;
    return 'wall';
  }
  if (lo < GALLERY.z + RAIL_STOP && hi > GALLERY.z && Math.abs(r - GALLERY.rail) < 0.05 + b) return 'rail';
  if (lo < TOP.z + RAIL_STOP && hi > TOP.z && r < TOP.outer && angleGap(phi, WELL_RAIL.angle) * r < WELL_RAIL.half + b)
    return 'well rail';
  for (const [bot, top] of slabs(phi, r)) if (top > lo && bot < hi) return 'ceiling';
  return '';
}

export interface Tower {
  x: number;
  /** Base height in the world (the model's z = 0). */
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

interface Local {
  r: number;
  /** Angle 0..2pi in model space. */
  phi: number;
  /** Height above the base, model units. */
  h: number;
  t: Tower;
}

/** The lighthouses as places you go into: a spiral stair inside, a lamp room and gallery at the top. */
export class LighthouseClimb implements Platforms {
  constructor(readonly towers: Tower[]) {}

  private local(x: number, z: number, y: number): Local | null {
    for (const t of this.towers) {
      const dx = (x - t.x) / t.scale;
      const dz = (z - t.z) / t.scale;
      if (Math.abs(dx) > 7 || Math.abs(dz) > 7) continue;
      const phi = (((Math.atan2(-dz, dx) - t.yaw) % TAU) + TAU) % TAU;
      return { r: Math.hypot(dx, dz), phi, h: (y - t.y) / t.scale, t };
    }
    return null;
  }

  /** Every standable surface here: stacked treads, the floors inside, the gallery, the plinth outside. */
  private surfaces(L: Local) {
    const out = slabs(L.phi, L.r).map(([, top]) => top);
    if (L.r < innerR(0)) out.push(FLOOR);
    else if (L.r <= 5.6) out.push(L.r <= 4.9 ? 0.2 : 0.06);
    return out;
  }

  /** Highest surface within a step of the given height (pass Infinity for "the top"). */
  top(x: number, z: number, y = Infinity) {
    const L = this.local(x, z, y);
    if (!L) return -Infinity;
    let best = -Infinity;
    for (const h of this.surfaces(L)) if (h <= L.h + STEP && h > best) best = h;
    return best === -Infinity ? best : L.t.y + best * L.t.scale;
  }

  blocksBoat() {
    return false;
  }

  /** Walls, the newel, rails, glazing, and anything overhead lower than your head. */
  blocked(x: number, z: number, y: number, body = 0.35) {
    const L = this.local(x, z, y);
    return !!L && solidAt(L.r, L.phi, L.h, body / L.t.scale) !== '';
  }

  /**
   * Slide a walker out of the walls, newel and rails. Climbing or jumping beside the leaning
   * wall changes how deep you'd be in it without any sideways move, so this runs every frame.
   */
  push(x: number, z: number, y: number, body = 0.35): { x: number; z: number } | null {
    const L = this.local(x, z, y);
    if (!L) return null;
    const b = body / L.t.scale;
    const lo = L.h + STEP;
    const hi = L.h + HEAD;
    let r = L.r;
    let phi = L.phi;
    if (r < NEWEL + b && lo < 22.9) r = NEWEL + b;
    let wIn = Infinity;
    let wOut = -Infinity;
    for (let k = 0; k <= 6; k++) {
      const zk = lo + ((hi - lo) * k) / 6;
      const w = wallAt(zk);
      if (!w || zk < 0) continue;
      const door = doorAt(r, phi, L.h, b);
      if (door && hi < archTop(door.d, door.u + b)) continue;
      wIn = Math.min(wIn, w[0]);
      wOut = Math.max(wOut, w[1]);
    }
    if (r > wIn - b && r < wOut + b) r = r < (wIn + wOut) / 2 ? wIn - b : wOut + b;
    if (lo < GALLERY.z + RAIL_STOP && hi > GALLERY.z && Math.abs(r - GALLERY.rail) < 0.05 + b) r = GALLERY.rail + Math.sign(r - GALLERY.rail || -1) * (0.05 + b);
    if (lo < TOP.z + RAIL_STOP && hi > TOP.z && r < TOP.outer) {
      const gap = ((phi - WELL_RAIL.angle + Math.PI * 3) % TAU) - Math.PI;
      const need = (WELL_RAIL.half + b) / Math.max(r, 0.1);
      if (Math.abs(gap) < need) phi = WELL_RAIL.angle + Math.sign(gap || 1) * need;
    }
    if (r === L.r && phi === L.phi) return null;
    const a = phi + L.t.yaw;
    return { x: L.t.x + Math.cos(a) * r * L.t.scale, z: L.t.z - Math.sin(a) * r * L.t.scale };
  }

  /** Lowest thing overhead (a tread above, the top floor, a doorway's arch): where a jump bonks. */
  ceiling(x: number, z: number, y: number) {
    const L = this.local(x, z, y);
    if (!L) return Infinity;
    let best = Infinity;
    for (const [bot] of slabs(L.phi, L.r)) if (bot > L.h + STEP && bot < best) best = bot;
    const w = wallAt(L.h + HEAD);
    const door = doorAt(L.r, L.phi, L.h, 0);
    if (door && w && L.r > w[0] - 0.35 && L.r < w[1] + 0.35) best = Math.min(best, Math.max(L.h + HEAD, archTop(door.d, door.u + 0.35)));
    return best === Infinity ? best : L.t.y + best * L.t.scale;
  }

  /** In the lamp room or out on the gallery: where you rest and lift your stars. Returns the tower index. */
  atLamp(x: number, z: number, y: number) {
    const L = this.local(x, z, y);
    if (!L || Math.abs(L.h - TOP.z) > 0.6 || L.r > GALLERY.outer) return -1;
    return this.towers.indexOf(L.t);
  }

  /** A spot on the lamp-room floor, for waking at your last light. */
  gallerySpot(i: number) {
    const t = this.towers[i];
    const a = t.yaw + GALLERY_DOOR.angle;
    const r = 1.3 * t.scale;
    return { x: t.x + Math.cos(a) * r, z: t.z - Math.sin(a) * r };
  }
}
