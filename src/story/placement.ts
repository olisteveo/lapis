// Deterministic placement of the prologue around the spawn beach, read from the heightfield
// so it survives any retune of the world generator.
import { BIOMES, LAGOONS, mulberry32, type Heightfield } from '../world/heightfield';
import type { Wonder } from '../world/wonders';
import type { PuzzleSite } from '../world/puzzles';
import { CONSTELLATIONS } from './content';

export interface P {
  x: number;
  z: number;
}

export interface PrologueLayout {
  spawn: P;
  seaward: P;
  boat: P & { heading: number };
  note: P;
  footprints: (P & { yaw: number; left: boolean })[];
  stars: P[];
  figureSpots: P[];
}

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z);

function search(centre: P, rMin: number, rMax: number, ok: (x: number, z: number) => boolean, score: (x: number, z: number) => number) {
  let best: P | null = null;
  let bestScore = -Infinity;
  for (let r = rMin; r <= rMax; r += Math.max(3, (rMax - rMin) / 30))
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const x = centre.x + Math.sin(a) * r;
      const z = centre.z + Math.cos(a) * r;
      if (!ok(x, z)) continue;
      const s = score(x, z);
      if (s > bestScore) {
        bestScore = s;
        best = { x, z };
      }
    }
  return best;
}

/**
 * Flood-fills boat-deep water from the edges of a window around `from` (which, for a coastal
 * spawn, reach open sea) and returns the reachable water cell nearest to `from`.
 */
function nearestOpenWater(h: (x: number, z: number) => number, from: P): P {
  const CELL = 8;
  const HALF = 1400;
  const N = Math.floor((HALF * 2) / CELL);
  const x0 = from.x - HALF;
  const z0 = from.z - HALF;
  const DEEP = -0.9;
  const deep = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) deep[j * N + i] = h(x0 + i * CELL, z0 + j * CELL) < DEEP ? 1 : 0;
  const seen = new Uint8Array(N * N);
  const queue: number[] = [];
  // Seeds: deep cells on the window border that are properly open water, not a shallow nook.
  for (let k = 0; k < N; k++)
    for (const idx of [k, (N - 1) * N + k, k * N, k * N + N - 1])
      if (deep[idx] && !seen[idx] && h(x0 + (idx % N) * CELL, z0 + Math.floor(idx / N) * CELL) < -6) {
        seen[idx] = 1;
        queue.push(idx);
      }
  for (let q = 0; q < queue.length; q++) {
    const idx = queue[q];
    const i = idx % N;
    const j = (idx - i) / N;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const n = nj * N + ni;
      if (deep[n] && !seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  let best = { x: from.x, z: from.z + 60 };
  let bd = Infinity;
  for (const idx of queue) {
    const x = x0 + (idx % N) * CELL;
    const z = z0 + Math.floor(idx / N) * CELL;
    const d = Math.hypot(x - from.x, z - from.z);
    if (d < bd) {
      bd = d;
      best = { x, z };
    }
  }
  return best;
}

export function layoutPrologue(hf: Heightfield, spawn: P): PrologueLayout {
  const h = (x: number, z: number) => hf.height(x, z);
  const slope = (x: number, z: number) => Math.abs(h(x + 2, z) - h(x - 2, z)) + Math.abs(h(x, z + 2) - h(x, z - 2));

  // Seaward: toward the nearest water that actually connects to the open ocean. Inland ponds
  // and lagoon pools are excluded by flood-filling outward from the sea on a coarse grid.
  const water = nearestOpenWater(h, spawn);
  const nearest = Math.hypot(water.x - spawn.x, water.z - spawn.z) || 1;
  const sea = { x: (water.x - spawn.x) / nearest, z: (water.z - spawn.z) / nearest };
  const side = { x: -sea.z, z: sea.x };

  // Footprints: from beside where you wake, straight down the beach and into the water.
  const footprints: PrologueLayout['footprints'] = [];
  let px = spawn.x + side.x * 1.6 + sea.x * 1.5;
  let pz = spawn.z + side.z * 1.6 + sea.z * 1.5;
  let underwater = 0;
  for (let i = 0; i < 120 && underwater < 5; i++) {
    const left = i % 2 === 0;
    const off = left ? 0.1 : -0.1;
    footprints.push({ x: px + side.x * off, z: pz + side.z * off, yaw: Math.atan2(sea.x, sea.z), left });
    px += sea.x * 0.58;
    pz += sea.z * 0.58;
    if (h(px, pz) < 0.05) underwater++;
  }

  // Boat afloat at that nearest deep water, lying along the shore, lantern lit.
  const boat = { x: water.x + sea.x * 2.5, z: water.z + sea.z * 2.5, heading: Math.atan2(side.x, side.z) };

  // The note: on dry sand between where you wake and the boat, pinned by a stone.
  const note = search({ x: (spawn.x + boat.x) / 2, z: (spawn.z + boat.z) / 2 }, 0, 10,
    (x, z) => h(x, z) > 0.2 && h(x, z) < 1.2, (x, z) => -Math.abs(dist({ x, z }, spawn) - 5)) ?? { x: spawn.x + side.x * 4, z: spawn.z + side.z * 4 };

  const stars: P[] = [];
  const used = (x: number, z: number) => stars.every((s) => dist(s, { x, z }) > 60);
  const pushStar = (p: P | null, fallback: P) => stars.push(p ?? fallback);

  // 1: the star you watch fall in the opening. It lands on the sand in front of you, toward the sea.
  pushStar(search(spawn, 14, 30, (x, z) => h(x, z) > 0.15 && h(x, z) < 2.5 && slope(x, z) < 1.5,
    (x, z) => ((x - spawn.x) * sea.x + (z - spawn.z) * sea.z) / Math.hypot(x - spawn.x, z - spawn.z) - Math.abs(Math.hypot(x - spawn.x, z - spawn.z) - 20) * 0.02),
    { x: spawn.x + sea.x * 20, z: spawn.z + sea.z * 20 });
  // 2: in the shallows by the boat, so you meet the boat while chasing it.
  pushStar(search(boat, 5, 14, (x, z) => h(x, z) < -0.15 && h(x, z) > -0.7, (x, z) => -dist({ x, z }, boat)), { x: boat.x + side.x * 6, z: boat.z + side.z * 6 });
  // 3: along the beach.
  pushStar(search(spawn, 110, 220, (x, z) => h(x, z) > 0.15 && h(x, z) < 1.4 && used(x, z),
    (x, z) => Math.abs((x - spawn.x) * side.x + (z - spawn.z) * side.z)), { x: spawn.x + side.x * 150, z: spawn.z + side.z * 150 });
  // 4: hidden in the first secret lagoon, on its inner beach across from the cleft.
  {
    const L = LAGOONS[0];
    const g = hf.lagoonGaps[0];
    stars.push({ x: L.x - Math.sin(g) * (L.r - 13), z: L.z - Math.cos(g) * (L.r - 13) });
  }
  // 5: across the water, on a far shore. Walk around or row.
  pushStar(search(spawn, 260, 480, (x, z) => {
    if (h(x, z) < 0.2 || h(x, z) > 1.6 || !used(x, z)) return false;
    for (let t = 0.2; t < 0.9; t += 0.1) if (h(spawn.x + (x - spawn.x) * t, spawn.z + (z - spawn.z) * t) < -1.5) return true;
    return false;
  }, (x, z) => -dist({ x, z }, spawn)), { x: spawn.x + sea.x * 300, z: spawn.z + sea.z * 300 });
  // 6: on an islet only the boat can reach.
  pushStar(search(spawn, 350, 1300, (x, z) => {
    if (h(x, z) < 0.5) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (h(x + Math.sin(a) * 140, z + Math.cos(a) * 140) > -1) return false;
    }
    return true;
  }, (x, z) => -dist({ x, z }, spawn)), { x: spawn.x + sea.x * 600, z: spawn.z + sea.z * 600 });

  // The distant figure stands at the waterline, always a beach or two away.
  const figureSpots = [stars[2], stars[4], stars[5]].map((s, i) =>
    search(s, 40 + i * 10, 90, (x, z) => h(x, z) > 0.1 && h(x, z) < 0.8, (x, z) => dist({ x, z }, spawn)) ?? s);

  return { spawn, seaward: sea, boat, note, footprints, stars, figureSpots };
}

// Each region's constellation wonder: its hidden star lies at the wonder's feet.
const REGION_WONDER = { meadow: 'moontree', lantern: 'ring', dunes: 'whale', drowned: 'bell' } as const;

/**
 * Where every regional star lies, by fragment id. Open stars are scattered through the region,
 * well apart and preferring awkward places (hilltops, the far side of things) so they take finding.
 */
export function layoutRegionStars(hf: Heightfield, wonders: Wonder[], puzzles: PuzzleSite[]): Record<string, P> {
  const out: Record<string, P> = {};
  const rnd = mulberry32(9001);
  for (const c of CONSTELLATIONS) {
    if (!c.region) continue;
    const B = BIOMES[c.region];
    const wonder = wonders.find((w) => w.id === REGION_WONDER[c.region!]);
    const regionPuzzles = puzzles.filter((p) => p.region === c.region);
    const taken: P[] = [...regionPuzzles, ...(wonder ? [wonder] : [])];
    let puzzleSlot = 0;
    for (const f of c.fragments) {
      if (f.source === 'wonder' && wonder) {
        const a = rnd() * Math.PI * 2;
        const r = wonder.id === 'whale' ? 6 : wonder.id === 'bell' ? 9 : 12;
        out[f.id] = { x: wonder.x + Math.sin(a) * r, z: wonder.z + Math.cos(a) * r };
        continue;
      }
      if (f.source === 'puzzle') {
        const p = regionPuzzles[puzzleSlot++];
        if (p) out[f.id] = { x: p.x, z: p.z };
        continue;
      }
      let best: P | null = null;
      let bestScore = -Infinity;
      for (let k = 0; k < 220; k++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * B.r * 0.9;
        const x = B.x + Math.sin(a) * d;
        const z = B.z + Math.cos(a) * d;
        const h = hf.height(x, z);
        if (h < (c.region === 'drowned' ? -1.1 : 0.6)) continue;
        const gap = Math.min(...taken.map((t) => dist(t, { x, z })), 1e9);
        if (gap < 110) continue;
        // Prefer high ground over its surroundings: hilltops and ledges you have to climb to.
        const rise = h - (hf.height(x + 25, z) + hf.height(x - 25, z) + hf.height(x, z + 25) + hf.height(x, z - 25)) / 4;
        const score = Math.min(gap, 400) * 0.02 + rise * 0.6 + rnd() * 2;
        if (score > bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
      if (best) {
        out[f.id] = best;
        taken.push(best);
      }
    }
  }
  return out;
}
