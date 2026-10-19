// Deterministic world generator. Pure maths, no three.js: shared by the terrain
// workers, gameplay collision, and the offline heightmap exporter (s&box port).
import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';

export const WORLD_SIZE = 8192;
export const WORLD_HALF = WORLD_SIZE / 2;
export const SEA_LEVEL = 0;

// Story layout (+Z is south, the bright star sits due north at -Z).
export const LAKE = { x: 0, z: -250, r: 720 };
/**
 * Secret lagoons: rock-ringed pools on the coast, reached only across stepping stones
 * through a flooded cleft. The first sits near where you wake and teaches the jump.
 */
export const LAGOONS = [
  { x: -720, z: 2080, r: 58 },
  { x: 240, z: 2720, r: 64 },
  { x: -1720, z: 2560, r: 60 },
  { x: 800, z: 1480, r: 56 },
];

/** The Keeper's home lighthouse stands on the islet at the lake's centre. */
export const LIGHTHOUSE = { x: LAKE.x, z: LAKE.z };
export const RIVER = { zStart: -600, zEnd: -4000 };

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function fbm(n: NoiseFunction2D, x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n(x * freq, z * freq);
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

export interface TerrainSample {
  height: number;
  /** 0..1 how strongly this point belongs to karst tower country. */
  rock: number;
  /** 0..1 jungle/grove density hint for vegetation and shading. */
  grove: number;
  /** Region weights 0..1 (the Coral Shore is wherever these are all low). */
  meadow: number;
  lantern: number;
  dunes: number;
  drowned: number;
}

/**
 * Regions of the dream, each with its own ground, plants, creatures and wonder.
 * The Coral Shore (south, where you wake) and the Karst Highlands (north) are the defaults.
 */
export const BIOMES = {
  meadow: { x: -1950, z: 250, r: 1250 },
  lantern: { x: 1850, z: 450, r: 1150 },
  dunes: { x: 1350, z: -2150, r: 1000 },
  drowned: { x: -2330, z: 520, r: 240 },
};

export interface Heightfield {
  seed: number;
  height(x: number, z: number): number;
  sample(x: number, z: number): TerrainSample;
  riverX(z: number): number;
  /** Angle (atan2(dx, dz) convention) of each lagoon's cleft, in LAGOONS order. */
  lagoonGaps: number[];
}

export function createHeightfield(seed = 1337): Heightfield {
  const rand = mulberry32(seed);
  const nShape = createNoise2D(rand);
  const nIsles = createNoise2D(rand);
  const nHills = createNoise2D(rand);
  const nKarst = createNoise2D(rand);
  const nDetail = createNoise2D(rand);
  const nGrove = createNoise2D(rand);
  const nRegion = createNoise2D(rand);
  const nRidge = createNoise2D(rand);

  // Ridged multifractal: sharp crests, deep V valleys, like jungle-clad Serra do Mar ridgelines.
  function ridged(x: number, z: number, octaves: number): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let weight = 1;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(nRidge(x * freq, z * freq));
      n *= n;
      n *= weight;
      weight = Math.min(1, n * 1.8);
      sum += n * amp;
      freq *= 2.1;
      amp *= 0.5;
    }
    return sum;
  }

  /** 0 lowland, ~0.5 hill country, 1 highland. Coral Shore in the south is kept gentle. */
  function relief(x: number, z: number): number {
    const r = fbm(nRegion, x / 2200, z / 2200, 3) + 0.35 * smoothstep(-500, -2200, z) - 0.6 * smoothstep(600, 1700, z);
    return smoothstep(-0.15, 0.35, r);
  }

  const riverX = (z: number) => 220 * Math.sin(z / 420 + 0.6) + 90 * Math.sin(z / 170);

  function baseMask(x: number, z: number): number {
    const edge = smoothstep(WORLD_HALF * 0.97, WORLD_HALF * 0.72, Math.max(Math.abs(x), Math.abs(z)));
    // Main island carries the lake; noise islands scatter the archipelago.
    const ex = x / 2500;
    const ez = (z + 250) / 2900;
    // Domain warp gives the coast long inlets and headlands instead of a round blob.
    const wx = x + fbm(nShape, x / 900 + 7, z / 900, 3) * 520;
    const wz = z + fbm(nShape, x / 900, z / 900 - 7, 3) * 520;
    const main = 1 - Math.sqrt(ex * ex + ez * ez) + fbm(nShape, wx / 1500, wz / 1500, 5) * 0.62;
    const isles = fbm(nIsles, wx / 780, wz / 780, 4) * 1.25 - 0.36;
    return Math.max(main, isles) * edge - (1 - edge) * 0.6;
  }

  // Granite domes (inselbergs) in the manner of Rio's Sugarloaf and Fernando de Noronha:
  // sparse, discrete, steep-walled and round-topped, many rising straight from the sea.
  interface Dome { x: number; z: number; r: number; h: number; e: number; c: number; s: number }
  const DOME_CELL = 520;
  const domeCache = new Map<number, Dome[]>();
  let extraDomes: Dome[] = [];
  const hash2 = (i: number, j: number, k: number) => {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k + seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  function domesInCell(i: number, j: number): Dome[] {
    const key = (i + 512) * 1024 + (j + 512);
    const cached = domeCache.get(key);
    if (cached !== undefined) return cached;
    let dome: Dome | null = null;
    extraDomes = [];
    const cx = (i + 0.15 + 0.7 * hash2(i, j, 1)) * DOME_CELL;
    const cz = (j + 0.15 + 0.7 * hash2(i, j, 2)) * DOME_CELL;
    const m = baseMask(cx, cz);
    const dLake = Math.hypot(cx - LAKE.x, cz - LAKE.z);
    const north = smoothstep(-300, -1400, cz);
    const ring = smoothstep(LAKE.r - 100, LAKE.r + 150, dLake) * smoothstep(LAKE.r + 900, LAKE.r + 400, dLake);
    const coast = smoothstep(-0.35, -0.1, m) * smoothstep(0.15, 0.0, m);
    const inLake = smoothstep(LAKE.r - 150, LAKE.r - 350, dLake);
    const edge = smoothstep(WORLD_HALF * 0.9, WORLD_HALF * 0.7, Math.max(Math.abs(cx), Math.abs(cz)));
    const south = smoothstep(800, 1600, cz);
    let density = (0.02 + north * 0.22 + ring * 0.25 + coast * 0.28 + inLake * 0.2) * edge * (1 - south * 0.9);
    if (cz < RIVER.zStart + 300) {
      const dr = Math.abs(cx - riverX(cz));
      if (dr < 260) density = 0;
    }
    if (hash2(i, j, 3) < density) {
      // Size skews small with the occasional giant, like a real inselberg field.
      const r = 85 + 270 * Math.pow(hash2(i, j, 4), 1.8);
      dome = {
        x: cx,
        z: cz,
        r,
        h: Math.min(980, r * (1.7 + 1.5 * hash2(i, j, 5)) * (0.75 + north * 0.35)),
        e: 1 + 0.9 * hash2(i, j, 6),
        c: Math.cos(hash2(i, j, 7) * Math.PI),
        s: Math.sin(hash2(i, j, 7) * Math.PI),
      };
      // Shoulder lobes merge into the main dome so they read as massifs, not lone eggs.
      const lobes = Math.floor(hash2(i, j, 8) * 3);
      for (let k = 0; k < lobes; k++) {
        const a = hash2(i, j, 10 + k) * Math.PI * 2;
        const off = r * (0.7 + 0.5 * hash2(i, j, 20 + k));
        const lr = r * (0.4 + 0.35 * hash2(i, j, 30 + k));
        extraDomes.push({
          x: cx + Math.cos(a) * off,
          z: cz + Math.sin(a) * off,
          r: lr,
          h: dome.h * (0.35 + 0.35 * hash2(i, j, 40 + k)),
          e: 1 + 0.5 * hash2(i, j, 50 + k),
          c: Math.cos(a),
          s: Math.sin(a),
        });
      }
    }
    const list = dome ? [dome, ...extraDomes] : [];
    domeCache.set(key, list);
    return list;
  }

  function domes(x: number, z: number): { h: number; rock: number } {
    const ci = Math.floor(x / DOME_CELL);
    const cj = Math.floor(z / DOME_CELL);
    let best = 0;
    let rock = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++)
        for (const d of domesInCell(ci + di, cj + dj)) {
        const lx = x - d.x;
        const lz = z - d.z;
        const u = (lx * d.c + lz * d.s) / (d.r * d.e);
        const v = (-lx * d.s + lz * d.c) / d.r;
        let q = Math.sqrt(u * u + v * v);
        if (q > 1.7) continue;
        // Lumpy outline and gullies: warp the radial distance so no dome is a clean ellipse.
        const ang = Math.atan2(v, u);
        q *= 1 + 0.22 * fbm(nDetail, Math.cos(ang) * 1.6 + d.x * 0.01, Math.sin(ang) * 1.6 + d.z * 0.01, 3)
          + 0.12 * fbm(nKarst, lx / 70, lz / 70, 2);
        // Gullies running down the walls.
        q += 0.05 * Math.abs(Math.sin(ang * (5 + (d.x & 3)) + d.z)) * q;
        if (q > 1.4) continue;
        // Steep walls, rounded crown: already ~half height at 90% of the radius.
        const body = q < 1 ? Math.pow(1 - Math.pow(q, 2.4), 0.42) : 0;
        const apron = 0.03 * smoothstep(1.4, 1.0, q);
        const hh = d.h * (body + apron);
        if (hh > best) {
          best = hh;
          // Bare granite on the walls; the crown and the apron keep their jungle.
          rock = body > 0 ? smoothstep(0.25, 0.75, q) * smoothstep(1.02, 0.92, q) : 0;
        }
      }
    return { h: best, rock };
  }

  // Each lagoon's cleft faces the land, so the stepping-stone path starts on a beach.
  const lagoonGaps = LAGOONS.map((L) => {
    let best = 0;
    let high = -Infinity;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const v = baseMask(L.x + Math.sin(a) * (L.r + 60), L.z + Math.cos(a) * (L.r + 60));
      if (v > high) {
        high = v;
        best = a;
      }
    }
    return best;
  });

  /** Returns the carved height for lagoons (or null when outside every lagoon's reach). */
  function lagoon(x: number, z: number, h: number): { h: number; rock: number } | null {
    for (let i = 0; i < LAGOONS.length; i++) {
      const L = LAGOONS[i];
      const dx = x - L.x;
      const dz = z - L.z;
      const d = Math.hypot(dx, dz);
      if (d > L.r + 45) continue;
      const ang = Math.atan2(dx, dz);
      let da = Math.abs(ang - lagoonGaps[i]);
      da = Math.min(da, Math.PI * 2 - da);
      const gapHalf = 10 / (L.r + 10); // ~10m half-width cleft
      const inGap = smoothstep(gapHalf * 1.4, gapHalf * 0.8, da);
      const n = fbm(nDetail, x / 18, z / 18, 3);
      const wallH = 24 + n * 10 + fbm(nKarst, x / 50, z / 50, 2) * 8;
      const wall = smoothstep(L.r + 34, L.r + 12, d) * smoothstep(L.r - 6, L.r + 6, d);
      let out = h;
      // Interior: a still pool with a sandy inner beach.
      if (d < L.r + 2) out = lerp(-2.6, 0.55 + n * 0.15, smoothstep(L.r - 22, L.r - 8, d));
      // The ring of rock, broken by the flooded cleft.
      out = lerp(out, Math.max(out, wallH), wall * (1 - inGap));
      out = lerp(out, -2.4 + n * 0.3, wall * inGap);
      // A short flooded run beyond the cleft, so the stones start from the outside beach.
      const outside = smoothstep(L.r + 40, L.r + 22, d) * smoothstep(L.r + 8, L.r + 20, d) * inGap;
      out = lerp(out, -2.4, outside);
      return { h: out, rock: wall * (1 - inGap) };
    }
    return null;
  }

  /** Soft region weights, with warped borders so regions bleed into each other naturally. */
  function regions(x: number, z: number) {
    const wx = x + fbm(nRegion, x / 700 + 3, z / 700, 3) * 380;
    const wz = z + fbm(nRegion, x / 700, z / 700 - 3, 3) * 380;
    const w = (b: { x: number; z: number; r: number }) => smoothstep(b.r * 1.15, b.r * 0.5, Math.hypot(wx - b.x, wz - b.z));
    // The sunken town keeps a crisp edge: it's a place, not a mood.
    const dr = BIOMES.drowned;
    const drowned = smoothstep(dr.r, dr.r * 0.6, Math.hypot(x - dr.x, z - dr.z) + fbm(nDetail, x / 60, z / 60, 2) * 40);
    return { meadow: w(BIOMES.meadow), lantern: w(BIOMES.lantern), dunes: w(BIOMES.dunes), drowned };
  }

  function sample(x: number, z: number): TerrainSample {
    let m = baseMask(x, z);
    m += fbm(nDetail, x / 180, z / 180, 3) * 0.06;
    const R = regions(x, z);

    const inland = smoothstep(0.04, 0.3, m);
    let h: number;
    if (m > 0) {
      h = m * 55 + fbm(nHills, x / 340, z / 340, 4) * 22 * inland;
      const rel = relief(x, z);
      // Hill country: steep rounded morros. Highlands: ridged mountains up to ~500m.
      const hills = Math.pow(smoothstep(0.0, 0.6, fbm(nKarst, x / 300, z / 300, 4) + 0.15), 1.6) * 140;
      const mountains = ridged(x / 1100, z / 1100, 6) * 620;
      h += (hills * smoothstep(0.1, 0.5, rel) + mountains * smoothstep(0.45, 1.0, rel)) * inland;
      // Meadows: long, soft, rolling hills under a big sky, no crags.
      const meadowH = m * 48 + (fbm(nHills, x / 560, z / 560, 4) * 0.5 + 0.5) * 42 * inland;
      h = lerp(h, meadowH, R.meadow);
      // Dunes: low ground shaped into wind-combed crests.
      const crest = 1 - Math.abs(Math.sin((x * 0.6 + z * 0.8) / 42 + fbm(nDetail, x / 240, z / 240, 2) * 3.2));
      const duneH = m * 18 + crest * crest * 9 * inland + 1.2;
      h = lerp(h, duneH, R.dunes);
    } else {
      // Continuous with the land at m = 0: a step here traced the coast as hard straight edges.
      h = Math.max(-70, m * 110 - 1.5 * smoothstep(0, -0.03, m));
    }

    // Lake basin: blend down to a sandy shelf so the shore forms naturally.
    const dLake = Math.hypot(x - LAKE.x, z - LAKE.z);
    const lakeR = LAKE.r + fbm(nShape, x / 300, z / 300, 2) * 120;
    h = lerp(h, -16, smoothstep(lakeR, lakeR - 220, dLake));
    // The home lighthouse's islet: a rocky knoll in the middle of the lake.
    const isle = smoothstep(70, 18, dLake + fbm(nDetail, x / 25, z / 25, 2) * 8);
    h = Math.max(h, lerp(-16, 9 + fbm(nDetail, x / 12, z / 12, 2) * 2.5, isle));

    // Domes go on after the sea and lake so they can rise straight out of the water.
    const dm = domes(x, z);
    // Few domes in the open regions: they'd break the meadow skyline and bury the dunes.
    dm.h *= 1 - 0.75 * Math.max(R.meadow, R.dunes);
    if (dm.h > 0) {
      const streaks = fbm(nDetail, x / 25, z / 25, 2) * 0.5 + fbm(nDetail, x / 90, z / 90, 2);
      h = Math.max(h, dm.h * (1 + 0.025 * streaks));
    }
    let rock = dm.rock;
    const lg = lagoon(x, z, h);
    if (lg) {
      h = lg.h;
      rock = Math.max(rock, lg.rock);
    }

    // River of Light: a channel snaking north from the lake to the far sea.
    if (z < RIVER.zStart + 200) {
      const along = smoothstep(RIVER.zStart + 200, RIVER.zStart - 100, z);
      const w = 55 + 25 * Math.sin(z / 260);
      const dr = Math.abs(x - riverX(z));
      h = lerp(h, -5, smoothstep(w + 70, w, dr) * along);
    }

    // The drowned town: a broad shallow shelf you can wade across among the ruins.
    // Kept above wading depth (-0.85) so the whole town can be walked, knee-deep.
    if (R.drowned > 0) h = lerp(h, -0.5 + fbm(nDetail, x / 30, z / 30, 2) * 0.25, R.drowned);

    // Sandbars and runnels so the waterline wanders instead of following one smooth contour.
    if (Math.abs(h) < 4) h += (fbm(nDetail, x / 24, z / 24, 3) * 0.45 + fbm(nDetail, x / 7, z / 7, 2) * 0.12) * smoothstep(4, 0.5, Math.abs(h));

    // Beaches: compress the band just above sea level into wide, gently sloping sand.
    if (h > 0 && h < 5) h = h * 0.32;
    else if (h >= 5) h = 1.6 + (h - 5);

    let grove = Math.max(0, fbm(nGrove, x / 180, z / 180, 3) + 0.6) * (1 - rock) * smoothstep(0.2, 2.0, h) * smoothstep(120, 30, h);
    // Open country: meadows keep only scattered copses, dunes none.
    grove *= (1 - R.meadow * 0.85) * (1 - R.dunes) * (1 - R.drowned);
    rock = Math.max(rock, smoothstep(140, 260, h) * 0.5) * (1 - R.dunes);

    return { height: h, rock: Math.min(1, rock), grove: Math.min(1, grove * 1.4), ...R };
  }

  return { seed, height: (x, z) => sample(x, z).height, sample, riverX, lagoonGaps };
}

/** Finds a gently sloping beach on the south coast for the opening scene. */
export function findSpawn(hf: Heightfield): { x: number; z: number; facing: number } {
  let best = { x: 0, z: 1800, score: -Infinity, facing: 0 };
  for (let x = -1200; x <= 1200; x += 30) {
    let prev = hf.height(x, 900);
    for (let z = 910; z < WORLD_HALF; z += 6) {
      const h = hf.height(x, z);
      if (prev > 0.3 && h <= 0.3) {
        const slope = Math.abs(hf.height(x, z - 20) - hf.height(x, z + 20));
        const inlandOk = hf.height(x, z - 120) > 1.5 ? 1 : 0;
        const score = -slope * 4 - Math.abs(x) / 600 + inlandOk * 2;
        if (score > best.score) best = { x, z: z - 6, score, facing: 0 };
        break;
      }
      prev = h;
    }
  }
  return { x: best.x, z: best.z, facing: best.facing };
}
