// Deterministic placement of the prologue around the spawn beach, read from the heightfield
// so it survives any retune of the world generator.
import type { Heightfield } from '../world/heightfield';

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

export function layoutPrologue(hf: Heightfield, spawn: P): PrologueLayout {
  const h = (x: number, z: number) => hf.height(x, z);
  const slope = (x: number, z: number) => Math.abs(h(x + 2, z) - h(x - 2, z)) + Math.abs(h(x, z + 2) - h(x, z - 2));

  // Seaward: the direction around the spawn where the ground falls lowest.
  let sea = { x: 0, z: 1 };
  let lowest = Infinity;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const v = h(spawn.x + Math.sin(a) * 30, spawn.z + Math.cos(a) * 30);
    if (v < lowest) {
      lowest = v;
      sea = { x: Math.sin(a), z: Math.cos(a) };
    }
  }
  const side = { x: -sea.z, z: sea.x };

  // Footprints: from beside where you wake, straight down the beach and into the water.
  const footprints: PrologueLayout['footprints'] = [];
  let px = spawn.x + side.x * 1.6 + sea.x * 1.5;
  let pz = spawn.z + side.z * 1.6 + sea.z * 1.5;
  let underwater = 0;
  for (let i = 0; i < 70 && underwater < 5; i++) {
    const left = i % 2 === 0;
    const off = left ? 0.1 : -0.1;
    footprints.push({ x: px + side.x * off, z: pz + side.z * off, yaw: Math.atan2(sea.x, sea.z), left });
    px += sea.x * 0.58;
    pz += sea.z * 0.58;
    if (h(px, pz) < 0.05) underwater++;
  }

  // Boat beached in the shallows a little along the shore.
  const boatBase = search({ x: spawn.x + side.x * 7, z: spawn.z + side.z * 7 }, 4, 40,
    (x, z) => h(x, z) < -0.75 && h(x, z) > -2.5, (x, z) => -dist({ x, z }, spawn)) ?? { x: spawn.x + sea.x * 20, z: spawn.z + sea.z * 20 };
  const boat = { ...boatBase, heading: Math.atan2(side.x, side.z) };

  // The note: on dry sand between where you wake and the boat, pinned by a stone.
  const note = search({ x: (spawn.x + boat.x) / 2, z: (spawn.z + boat.z) / 2 }, 0, 10,
    (x, z) => h(x, z) > 0.2 && h(x, z) < 1.2, (x, z) => -Math.abs(dist({ x, z }, spawn) - 5)) ?? { x: spawn.x + side.x * 4, z: spawn.z + side.z * 4 };

  const land = { x: -sea.x, z: -sea.z };
  const stars: P[] = [];
  const used = (x: number, z: number) => stars.every((s) => dist(s, { x, z }) > 60);
  const pushStar = (p: P | null, fallback: P) => stars.push(p ?? fallback);

  // 1: right in front of you when you sit up, on the sand by the palms.
  pushStar(search(spawn, 22, 45, (x, z) => h(x, z) > 0.4 && h(x, z) < 4 && slope(x, z) < 1.5,
    (x, z) => (x - spawn.x) * land.x + (z - spawn.z) * land.z), { x: spawn.x + land.x * 30, z: spawn.z + land.z * 30 });
  // 2: in the shallows by the boat, so you meet the boat while chasing it.
  pushStar(search(boat, 5, 14, (x, z) => h(x, z) < -0.15 && h(x, z) > -0.7, (x, z) => -dist({ x, z }, boat)), { x: boat.x + side.x * 6, z: boat.z + side.z * 6 });
  // 3: along the beach.
  pushStar(search(spawn, 110, 220, (x, z) => h(x, z) > 0.15 && h(x, z) < 1.4 && used(x, z),
    (x, z) => Math.abs((x - spawn.x) * side.x + (z - spawn.z) * side.z)), { x: spawn.x + side.x * 150, z: spawn.z + side.z * 150 });
  // 4: in the grove, under the glowing palms.
  pushStar(search(spawn, 80, 170, (x, z) => { const s = hf.sample(x, z); return s.grove > 0.45 && s.height > 3 && s.height < 30 && slope(x, z) < 2 && used(x, z); },
    (x, z) => hf.sample(x, z).grove), { x: spawn.x + land.x * 120, z: spawn.z + land.z * 120 });
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
