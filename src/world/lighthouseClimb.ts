import type { Platforms } from '../game/player';

// Geometry of the DreamLighthouse model (tools/blender/lighthouse.py, public/models/lighthouse.json),
// in model units; angles are counter-clockwise from +X seen from above, i.e. atan2(-z, x).
const RISE = 0.25;
const STEP_ANGLE = 0.16065;
const STEPS = 87;
const WIDTH = 1.3;
const GALLERY = { z: 22, inner: 2.4, outer: 4.4, rail: 4.3 };
// The gallery is open above the top treads so you don't hit your head coming up.
const OPENING = { from: 6.086836, to: 1.410147 };
const TAU = Math.PI * 2;

const towerR = (z: number) => (z <= 22 ? 3.2 - (0.8 * z) / 22 : z < 25.8 ? 2.15 : 0);

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

/** The lighthouses as walkable structures: a spiral stair, a gallery at the top, a tower in the way. */
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

  /** Every standable surface at this point: treads (there are up to three stacked), gallery, plinth. */
  private surfaces(L: Local) {
    const out: { h: number; kind: 'tread' | 'gallery' | 'plinth'; inner: number; outer: number }[] = [];
    for (let k = 0; k < 3; k++) {
      const i = Math.floor((L.phi + k * TAU) / STEP_ANGLE);
      if (i >= STEPS) break;
      const top = (i + 1) * RISE;
      const inner = towerR(top);
      if (L.r >= inner - 0.05 && L.r <= inner + WIDTH) out.push({ h: top, kind: 'tread', inner, outer: inner + WIDTH });
    }
    const open = L.phi >= OPENING.from || L.phi <= OPENING.to;
    if (!open && L.r >= GALLERY.inner && L.r <= GALLERY.outer) out.push({ h: GALLERY.z, kind: 'gallery', inner: GALLERY.inner, outer: GALLERY.outer });
    if (L.r <= 5.6) out.push({ h: L.r <= 4.9 ? 0.2 : 0.06, kind: 'plinth', inner: 0, outer: 5.6 });
    return out;
  }

  /** Highest surface within a step of the given height (pass Infinity for "the top"). */
  top(x: number, z: number, y = Infinity) {
    const L = this.local(x, z, y);
    if (!L) return -Infinity;
    let best = -Infinity;
    for (const s of this.surfaces(L)) if (s.h <= L.h + 0.55 && s.h > best) best = s.h;
    return best === -Infinity ? best : L.t.y + best * L.t.scale;
  }

  blocksBoat() {
    return false;
  }

  /** Keep the walker out of the tower, on the stair (the rail), on the gallery, and out from under treads. */
  confine(x: number, z: number, y: number, body: number): { x: number; z: number } | null {
    const L = this.local(x, z, y);
    if (!L) return null;
    const t = L.t;
    let r = L.r;
    const b = body / t.scale;
    // The tower wall at your height.
    const wall = towerR(L.h + 0.9);
    if (wall > 0 && r < wall + b) r = wall + b;
    const standing = this.surfaces(L).filter((s) => Math.abs(s.h - L.h) < 0.3).sort((a, b) => b.h - a.h)[0];
    if (standing?.kind === 'gallery') r = Math.min(r, GALLERY.rail - b);
    else if (standing?.kind === 'tread' && L.h > 1.2) r = Math.min(r, standing.outer - 0.15);
    // A tread overhead that your head would pass through: step back out from under the stair.
    if (!standing || standing.kind === 'plinth') {
      const low = this.surfaces(L).find((s) => s.kind === 'tread' && s.h - 0.32 < L.h + 1.75 && s.h > L.h + 0.55);
      if (low) r = Math.max(r, low.outer + b);
    }
    if (Math.abs(r - L.r) < 1e-4) return null;
    const k = r / Math.max(L.r, 1e-4);
    return { x: t.x + (x - t.x) * k, z: t.z + (z - t.z) * k };
  }

  /** On a gallery, near the lamp room: where you rest and lift your stars. Returns the tower index. */
  atLamp(x: number, z: number, y: number) {
    const L = this.local(x, z, y);
    if (!L || Math.abs(L.h - GALLERY.z) > 0.6 || L.r > GALLERY.outer) return -1;
    return this.towers.indexOf(L.t);
  }

  /** A standing spot on the gallery, for waking at your last light. */
  gallerySpot(i: number) {
    const t = this.towers[i];
    const a = t.yaw + Math.PI; // the side away from the stair's arrival
    const r = 3.4 * t.scale;
    return { x: t.x + Math.cos(a) * r, z: t.z - Math.sin(a) * r };
  }
}
