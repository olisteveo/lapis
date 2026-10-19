// Builds terrain chunk meshes and flora scatter off the main thread.
import { createHeightfield, type Heightfield } from './heightfield';

export type WorkerRequest =
  | { kind: 'chunk'; id: number; seed: number; x0: number; z0: number; size: number; segs: number }
  | { kind: 'flora'; id: number; seed: number; x0: number; z0: number; size: number };

export interface ChunkResult {
  kind: 'chunk';
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  attrs: Float32Array;
  indices: Uint32Array;
  minY: number;
  maxY: number;
}

/** Per flora type: packed [x, y, z, rotY, scale] instances in world space. */
export interface FloraResult {
  kind: 'flora';
  id: number;
  sets: Record<string, Float32Array>;
}

let hf: Heightfield | null = null;

function field(seed: number) {
  if (!hf || hf.seed !== seed) hf = createHeightfield(seed);
  return hf;
}

function buildChunk(req: Extract<WorkerRequest, { kind: 'chunk' }>): ChunkResult {
  const h = field(req.seed);
  const n = req.segs;
  const step = req.size / n;
  const stride = n + 3;
  // One-cell border so normals on the edges match neighbouring chunks.
  const heights = new Float32Array(stride * stride);
  const rock = new Float32Array((n + 1) * (n + 1));
  const grove = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j < stride; j++)
    for (let i = 0; i < stride; i++) {
      const x = req.x0 + (i - 1) * step;
      const z = req.z0 + (j - 1) * step;
      if (i >= 1 && j >= 1 && i <= n + 1 && j <= n + 1) {
        const s = h.sample(x, z);
        heights[j * stride + i] = s.height;
        rock[(j - 1) * (n + 1) + (i - 1)] = s.rock;
        grove[(j - 1) * (n + 1) + (i - 1)] = s.grove;
      } else {
        heights[j * stride + i] = h.height(x, z);
      }
    }

  const gridVerts = (n + 1) * (n + 1);
  const skirtVerts = 4 * (n + 1);
  const total = gridVerts + skirtVerts;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const attrs = new Float32Array(total * 2);
  let minY = Infinity;
  let maxY = -Infinity;

  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const v = j * (n + 1) + i;
      const hy = heights[(j + 1) * stride + (i + 1)];
      positions[v * 3] = i * step;
      positions[v * 3 + 1] = hy;
      positions[v * 3 + 2] = j * step;
      const hl = heights[(j + 1) * stride + i];
      const hr = heights[(j + 1) * stride + i + 2];
      const hd = heights[j * stride + i + 1];
      const hu = heights[(j + 2) * stride + i + 1];
      let nx = hl - hr;
      let ny = 2 * step;
      let nz = hd - hu;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      attrs[v * 2] = rock[v];
      attrs[v * 2 + 1] = grove[v];
      minY = Math.min(minY, hy);
      maxY = Math.max(maxY, hy);
    }

  const quads = n * n + 4 * n;
  const indices = new Uint32Array(quads * 6);
  let k = 0;
  const quad = (a: number, b: number, c: number, d: number) => {
    indices[k++] = a;
    indices[k++] = c;
    indices[k++] = b;
    indices[k++] = b;
    indices[k++] = c;
    indices[k++] = d;
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      quad(a, a + 1, a + n + 1, a + n + 2);
    }

  // Skirts hang below each edge to hide cracks between chunks at different LODs.
  const drop = step * 1.5 + 4;
  const edges: number[][] = [[], [], [], []];
  for (let i = 0; i <= n; i++) {
    edges[0].push(i);
    edges[1].push(n * (n + 1) + i);
    edges[2].push(i * (n + 1));
    edges[3].push(i * (n + 1) + n);
  }
  let sv = gridVerts;
  edges.forEach((edge, e) => {
    const start = sv;
    for (const v of edge) {
      positions[sv * 3] = positions[v * 3];
      positions[sv * 3 + 1] = positions[v * 3 + 1] - drop;
      positions[sv * 3 + 2] = positions[v * 3 + 2];
      normals.copyWithin(sv * 3, v * 3, v * 3 + 3);
      attrs.copyWithin(sv * 2, v * 2, v * 2 + 2);
      sv++;
    }
    for (let i = 0; i < n; i++) {
      const a = edge[i];
      const b = edge[i + 1];
      const c = start + i;
      const d = start + i + 1;
      // Winding flips per edge so every skirt faces outward.
      if (e === 0 || e === 3) quad(a, b, c, d);
      else quad(b, a, d, c);
    }
  });

  return { kind: 'chunk', id: req.id, positions, normals, attrs, indices, minY, maxY };
}

function hash(x: number, z: number, k: number) {
  let h = Math.imul(Math.floor(x) | 0, 374761393) ^ Math.imul(Math.floor(z) | 0, 668265263) ^ Math.imul(k, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Rule {
  cell: number;
  /** Returns instance probability for this location, or 0. */
  p: (hgt: number, slope: number, rock: number, grove: number, x: number, z: number) => number;
  types: [string, number][];
  scale: [number, number];
  sink?: number;
}

// Jungle structure: emergent canopy over understory over ferns and ground cover, with
// glowing palm groves fringing the beaches. Probabilities read from height, slope and grove.
const RULES: Rule[] = [
  {
    cell: 11,
    p: (h, sl, r, g, _x, z) =>
      smooth(0.5, 1.6, h) * smooth(35, 6, h) * (sl < 0.35 ? 1 : 0) * (1 - r) * (0.35 + g) * (0.55 + 0.6 * smooth(500, 1500, z)),
    types: [['PalmLean', 0.35], ['PalmYoung', 0.25], ['PalmMid', 0.25], ['PalmTall', 0.15]],
    scale: [0.85, 1.2],
  },
  {
    cell: 13,
    // Sparse emergent palms glowing above the canopy, so the jungle still carries the coral light.
    p: (h, sl, r, g) => smooth(8, 30, h) * smooth(420, 200, h) * (sl < 0.55 ? 1 : 0) * (1 - r) * smooth(0.15, 0.6, g) * 0.07,
    types: [['PalmTall', 0.5], ['PalmMid', 0.5]],
    scale: [0.9, 1.25],
  },
  {
    cell: 11,
    p: (h, sl, r, g) => smooth(5, 16, h) * (sl < 0.7 ? 1 : 0) * (1 - r) * smooth(0.1, 0.5, g) * 0.9,
    types: [['CanopyA', 0.55], ['CanopyB', 0.45]],
    scale: [0.8, 1.35],
    sink: 0.4,
  },
  {
    // Lianas hang from canopy height in the densest jungle.
    cell: 16,
    p: (h, sl, r, g) => smooth(6, 20, h) * (sl < 0.5 ? 1 : 0) * (1 - r) * smooth(0.35, 0.8, g) * 0.5,
    types: [['Vines', 1]],
    scale: [0.9, 1.25],
    sink: 0,
  },
  {
    cell: 5.5,
    p: (h, sl, r, g) => smooth(3, 10, h) * (sl < 0.7 ? 1 : 0) * (1 - r) * smooth(0.05, 0.4, g) * 0.7,
    types: [['Understory', 0.4], ['TreeFern', 0.3], ['Banana', 0.3]],
    scale: [0.8, 1.25],
  },
  {
    cell: 2.3,
    p: (h, sl, r, g) => smooth(2, 6, h) * (sl < 0.75 ? 1 : 0) * (1 - r) * smooth(0.0, 0.35, g) * 0.85,
    types: [['FernA', 0.35], ['FernB', 0.3], ['Groundcover', 0.2], ['Bush0', 0.15]],
    scale: [0.7, 1.4],
  },
  {
    cell: 9,
    p: (h, sl, r, g) => smooth(1.4, 4, h) * smooth(60, 20, h) * (sl < 0.5 ? 1 : 0) * (1 - r) * (0.25 + g * 0.5) * 0.45,
    types: [['Bush1', 0.6], ['Bush0', 0.4]],
    scale: [0.7, 1.3],
  },
];

function buildFlora(req: Extract<WorkerRequest, { kind: 'flora' }>): FloraResult {
  const h = field(req.seed);
  const buckets: Record<string, number[]> = {};
  RULES.forEach((rule, ri) => {
    const cells = Math.ceil(req.size / rule.cell);
    for (let j = 0; j < cells; j++)
      for (let i = 0; i < cells; i++) {
        const gx = Math.floor(req.x0 / rule.cell) + i;
        const gz = Math.floor(req.z0 / rule.cell) + j;
        const x = (gx + hash(gx, gz, ri * 7 + 1)) * rule.cell;
        const z = (gz + hash(gx, gz, ri * 7 + 2)) * rule.cell;
        if (x < req.x0 || z < req.z0 || x >= req.x0 + req.size || z >= req.z0 + req.size) continue;
        const s = h.sample(x, z);
        if (s.height < 0.3) continue;
        const slope = Math.abs(h.height(x + 2, z) - h.height(x - 2, z)) / 4 + Math.abs(h.height(x, z + 2) - h.height(x, z - 2)) / 4;
        const p = rule.p(s.height, slope, s.rock, s.grove, x, z);
        if (hash(gx, gz, ri * 7 + 3) > p) continue;
        let pick = hash(gx, gz, ri * 7 + 4);
        let type = rule.types[0][0];
        for (const [t, w] of rule.types) {
          if (pick < w) {
            type = t;
            break;
          }
          pick -= w;
        }
        const sc = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * hash(gx, gz, ri * 7 + 5);
        (buckets[type] ??= []).push(x, s.height - (rule.sink ?? 0.15), z, hash(gx, gz, ri * 7 + 6) * Math.PI * 2, sc);
      }
  });
  const sets: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(buckets)) sets[k] = new Float32Array(v);
  return { kind: 'flora', id: req.id, sets };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.kind === 'chunk') {
    const r = buildChunk(req);
    (self as unknown as Worker).postMessage(r, [r.positions.buffer, r.normals.buffer, r.attrs.buffer, r.indices.buffer]);
  } else {
    const r = buildFlora(req);
    (self as unknown as Worker).postMessage(r, Object.values(r.sets).map((a) => a.buffer));
  }
};
