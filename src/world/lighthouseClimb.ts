import type { Platforms } from '../game/player';

// Geometry of the hollow DreamLighthouse (tools/blender/lighthouse.py, public/models/lighthouse.json),
// in model units; angles are counter-clockwise from +X seen from above, i.e. atan2(-z, x).
const RISE = 0.25;
const STEP_ANGLE = 0.314159;
const START = 0.6;
const STEPS = 87;
const NEWEL = 0.35;
const WALL = 0.35;
const FLOOR = 0.2;
const TOP = { z: 22, outer: 2.05, open: { from: 5.940708, to: 2.799115 } };
const GALLERY = { z: 22, inner: 2.4, outer: 4.4, rail: 4.3 };
const DOOR = { angle: 0, width: 1.4, height: 2.5 };
const GALLERY_DOOR = { angle: 4.31969, width: 1.2, height: 2.3 };
const TAU = Math.PI * 2;

const outerR = (z: number) => (z <= 22 ? 3.2 - (0.8 * z) / 22 : 2.4);
const innerR = (z: number) => outerR(z) - WALL;
const angleGap = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI);

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
    const out: number[] = [];
    const wallIn = innerR(0);
    if (L.r > NEWEL - 0.05) {
      for (let k = 0; k < 6; k++) {
        const i = Math.floor((((L.phi - START + TAU) % TAU) + k * TAU) / STEP_ANGLE);
        if (i >= STEPS) break;
        const top = (i + 1) * RISE;
        if (L.r <= innerR(top) + 0.05) out.push(top);
      }
    }
    const open = L.phi >= TOP.open.from || L.phi <= TOP.open.to;
    if (!open && L.r >= NEWEL && L.r <= TOP.outer) out.push(TOP.z);
    if (L.r >= GALLERY.inner && L.r <= GALLERY.outer) out.push(GALLERY.z);
    if (L.r < wallIn) out.push(FLOOR);
    else if (L.r <= 5.6) out.push(L.r <= 4.9 ? 0.2 : 0.06);
    return out;
  }

  /** Highest surface within a step of the given height (pass Infinity for "the top"). */
  top(x: number, z: number, y = Infinity) {
    const L = this.local(x, z, y);
    if (!L) return -Infinity;
    let best = -Infinity;
    for (const h of this.surfaces(L)) if (h <= L.h + 0.55 && h > best) best = h;
    return best === -Infinity ? best : L.t.y + best * L.t.scale;
  }

  blocksBoat() {
    return false;
  }

  /** Walls, the newel, rails, and treads low enough to hit your head on. */
  blocked(x: number, z: number, y: number, body = 0.35) {
    const L = this.local(x, z, y);
    if (!L) return false;
    const b = body / L.t.scale;
    const h = L.h;
    const head = h + 0.9;
    if (L.r < NEWEL + b && h < 22.9) return true;
    // The tower wall at chest height, with its two doorways.
    if (head < 23.02 + 3.3) {
      const wallOut = head <= 23.02 ? outerR(head) : 2.15;
      const wallIn = head <= 23.02 ? innerR(head) : 2.15;
      if (L.r > wallIn - b && L.r < wallOut + b) {
        const inDoor = (d: typeof DOOR, sill: number) =>
          h >= sill - 0.4 && h < sill + d.height - 1.6 && angleGap(L.phi, d.angle) * L.r < d.width / 2 - b * 0.5;
        if (!inDoor(DOOR, 0) && !inDoor(GALLERY_DOOR, 22)) return true;
      }
    }
    // The gallery rail.
    if (Math.abs(h - GALLERY.z) < 1 && L.r > GALLERY.rail - b && L.r < GALLERY.outer + 0.6) return true;
    // A tread overhead that your head would pass through.
    for (const s of this.surfaces(L)) if (s > h + 0.55 && s - 0.32 < h + 1.75) return true;
    return false;
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
