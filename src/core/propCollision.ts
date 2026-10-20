// Collision for props, built from their own meshes. Each prop type is rasterised once into columns
// of solid height intervals (a 20 cm grid seen from above); a walker stands on the highest interval
// within a step, and anything between a step and head height in the body's columns is in the way.
// Decks, steps, posts, walls and arches all fall out of the geometry with no hand-made shapes.
import type { Platforms } from './player';

const CELL = 0.2;
/** Heights closer than this in one column are one solid: a plank's top and bottom, a wall's run. */
const GAP = 0.3;
const STEP = 0.55;
const HEAD = 1.75;
const FOOT = 0.2;

export class ColumnGrid {
  private constructor(
    readonly x0: number,
    readonly z0: number,
    readonly nx: number,
    readonly nz: number,
    /** Per cell: offset into spans (in intervals); length nx * nz + 1. */
    private start: Int32Array,
    /** Interleaved lo, hi pairs. */
    private spans: Float32Array,
    /** Furthest any part reaches from the origin, seen from above. */
    readonly radius: number,
  ) {}

  /** Triangles in the prop's local space (y up). index may be null for a triangle soup. */
  static fromTriangles(pos: ArrayLike<number>, index: ArrayLike<number> | null): ColumnGrid {
    const triCount = (index ? index.length : pos.length / 3) / 3;
    const vi = (t: number, k: number) => (index ? index[t * 3 + k] : t * 3 + k);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, radius = 0;
    for (let i = 0; i < pos.length; i += 3) {
      x0 = Math.min(x0, pos[i]);
      x1 = Math.max(x1, pos[i]);
      z0 = Math.min(z0, pos[i + 2]);
      z1 = Math.max(z1, pos[i + 2]);
      radius = Math.max(radius, Math.hypot(pos[i], pos[i + 2]));
    }
    if (!Number.isFinite(x0)) return new ColumnGrid(0, 0, 0, 0, new Int32Array(1), new Float32Array(0), 0);
    const nx = Math.floor((x1 - x0) / CELL) + 1;
    const nz = Math.floor((z1 - z0) / CELL) + 1;
    const heights: number[][] = Array.from({ length: nx * nz }, () => []);
    const put = (x: number, y: number, z: number) => {
      const cx = Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / CELL)));
      const cz = Math.min(nz - 1, Math.max(0, Math.floor((z - z0) / CELL)));
      heights[cz * nx + cx].push(y);
    };
    for (let t = 0; t < triCount; t++) {
      const a = vi(t, 0) * 3, b = vi(t, 1) * 3, c = vi(t, 2) * 3;
      const edge = Math.max(
        Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]),
        Math.hypot(pos[b] - pos[c], pos[b + 1] - pos[c + 1], pos[b + 2] - pos[c + 2]),
        Math.hypot(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]),
      );
      // Sample densely enough that every column the triangle crosses, and every height band of a
      // wall, gets a point.
      const n = Math.max(1, Math.ceil(edge / (CELL * 0.45)));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const u = i / n, v = j / n, w = 1 - u - v;
          put(
            pos[a] * w + pos[b] * u + pos[c] * v,
            pos[a + 1] * w + pos[b + 1] * u + pos[c + 1] * v,
            pos[a + 2] * w + pos[b + 2] * u + pos[c + 2] * v,
          );
        }
      }
    }
    const start = new Int32Array(nx * nz + 1);
    const out: number[] = [];
    for (let k = 0; k < heights.length; k++) {
      start[k] = out.length / 2;
      const hs = heights[k].sort((p, q) => p - q);
      if (!hs.length) continue;
      let lo = hs[0], hi = hs[0];
      for (let i = 1; i < hs.length; i++) {
        if (hs[i] - hi > GAP) {
          out.push(lo, hi);
          lo = hs[i];
        }
        hi = hs[i];
      }
      out.push(lo, hi);
    }
    start[heights.length] = out.length / 2;
    return new ColumnGrid(x0, z0, nx, nz, start, new Float32Array(out), radius);
  }

  /** Visits every solid interval in the column under local (x, z). */
  column(x: number, z: number, visit: (lo: number, hi: number) => void) {
    const cx = Math.floor((x - this.x0) / CELL);
    const cz = Math.floor((z - this.z0) / CELL);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return;
    const k = cz * this.nx + cx;
    for (let s = this.start[k]; s < this.start[k + 1]; s++) visit(this.spans[s * 2], this.spans[s * 2 + 1]);
  }

  /** Visits the intervals of every column within r of local (x, z). */
  disc(x: number, z: number, r: number, visit: (lo: number, hi: number) => void) {
    const steps = Math.ceil(r / CELL);
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) {
        if ((i * i + j * j) * CELL * CELL > (r + CELL * 0.5) ** 2) continue;
        this.column(x + i * CELL, z + j * CELL, visit);
      }
    }
  }
}

export interface PropPlacement {
  x: number;
  /** Height of the prop's origin in the world. */
  y: number;
  z: number;
  /** Rotation about the vertical, as three.js applies it (rotation.y). */
  yaw: number;
  scale: number;
}

interface Placed extends PropPlacement {
  grid: ColumnGrid;
  tag: string;
  cos: number;
  sin: number;
}

const BUCKET = 32;

/** Every placed prop as a standable, blocking solid, found through a coarse spatial hash. */
export class PropCollision implements Platforms {
  private buckets = new Map<string, Placed[]>();

  /** tag: what the prop is made of (for footsteps), or anything else the caller wants back. */
  add(grid: ColumnGrid, at: PropPlacement, tag = '') {
    if (!grid.radius) return;
    const p: Placed = { x: at.x, y: at.y, z: at.z, yaw: at.yaw, scale: at.scale, grid, tag, cos: Math.cos(at.yaw), sin: Math.sin(at.yaw) };
    const r = grid.radius * at.scale;
    for (let bx = Math.floor((at.x - r) / BUCKET); bx <= Math.floor((at.x + r) / BUCKET); bx++) {
      for (let bz = Math.floor((at.z - r) / BUCKET); bz <= Math.floor((at.z + r) / BUCKET); bz++) {
        const key = `${bx},${bz}`;
        const list = this.buckets.get(key);
        if (list) list.push(p);
        else this.buckets.set(key, [p]);
      }
    }
  }

  private each(x: number, z: number, reach: number, visit: (p: Placed, lx: number, lz: number) => void) {
    const list = this.buckets.get(`${Math.floor(x / BUCKET)},${Math.floor(z / BUCKET)}`);
    if (!list) return;
    for (const p of list) {
      const dx = (x - p.x) / p.scale;
      const dz = (z - p.z) / p.scale;
      if (Math.hypot(dx, dz) > p.grid.radius + reach / p.scale) continue;
      // World to local: undo three's rotation.y (x' = x cos + z sin, z' = -x sin + z cos).
      visit(p, dx * p.cos - dz * p.sin, dx * p.sin + dz * p.cos);
    }
  }

  /** Highest surface under any part of the foot, so a walker lands on an edge rather than sinking past it. */
  top(x: number, z: number, y = Infinity) {
    let best = -Infinity;
    this.each(x, z, FOOT, (p, lx, lz) => {
      const reach = (y - p.y) / p.scale + STEP;
      p.grid.disc(lx, lz, FOOT / p.scale, (_lo, hi) => {
        if (hi <= reach) best = Math.max(best, p.y + hi * p.scale);
      });
    });
    return best;
  }

  /** The tag of the prop a walker at (x, z, y) is standing on, or null if none. */
  standingOn(x: number, z: number, y: number): string | null {
    let tag: string | null = null;
    let best = -Infinity;
    this.each(x, z, 0, (p, lx, lz) => {
      const ly = (y - p.y) / p.scale;
      p.grid.column(lx, lz, (_lo, hi) => {
        if (Math.abs(hi - ly) < 0.15 / p.scale && hi > best) {
          best = hi;
          tag = p.tag;
        }
      });
    });
    return tag;
  }

  blocked(x: number, z: number, y: number, body = 0.35) {
    let hit = false;
    this.each(x, z, body, (p, lx, lz) => {
      if (hit) return;
      const lo = (y - p.y) / p.scale + STEP;
      const hi = (y - p.y) / p.scale + HEAD;
      p.grid.disc(lx, lz, body / p.scale, (a, b) => {
        if (b > lo && a < hi) hit = true;
      });
    });
    return hit;
  }

  /** Lowest thing over any part of the body (a lintel or eave off to one side bonks a jump too). */
  ceiling(x: number, z: number, y: number, body = 0.35) {
    let best = Infinity;
    this.each(x, z, body, (p, lx, lz) => {
      const above = (y - p.y) / p.scale + STEP;
      p.grid.disc(lx, lz, body / p.scale, (lo) => {
        if (lo > above) best = Math.min(best, p.y + lo * p.scale);
      });
    });
    return best;
  }

  /** Anything solid at the waterline (posts, a hull, rocks) stops the boat. */
  blocksBoat(x: number, z: number, radius: number) {
    let hit = false;
    this.each(x, z, radius, (p, lx, lz) => {
      if (hit) return;
      const lo = (-0.6 - p.y) / p.scale;
      const hi = (1.0 - p.y) / p.scale;
      p.grid.disc(lx, lz, radius / p.scale, (a, b) => {
        if (b > lo && a < hi) hit = true;
      });
    });
    return hit;
  }
}
