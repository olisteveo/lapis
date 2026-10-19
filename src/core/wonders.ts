import { BIOMES, WORLD_HALF, type Heightfield } from './heightfield';

export interface Wonder {
  id: string;
  name: string;
  /** What the little light says when you find it. */
  line: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Footprint for collision and flora clearing. */
  r: number;
  /** How close you must come to have found it. */
  reach: number;
}

/** One wonder per region: the reason to go somewhere new. Deterministic from the heightfield. */
export function layoutWonders(hf: Heightfield): Wonder[] {
  const slope = (x: number, z: number) =>
    Math.abs(hf.height(x + 3, z) - hf.height(x - 3, z)) + Math.abs(hf.height(x, z + 3) - hf.height(x, z - 3));
  // The flattest dry spot near a centre, searched on a spiral.
  const settle = (cx: number, cz: number, radius: number, minH = 0.8) => {
    let best = { x: cx, z: cz, score: Infinity };
    for (let i = 0; i < 400; i++) {
      const a = i * 2.39996;
      const d = Math.sqrt(i / 400) * radius;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const h = hf.height(x, z);
      if (h < minH) continue;
      const score = slope(x, z) + d * 0.004;
      if (score < best.score) best = { x, z, score };
    }
    return best;
  };
  const out: Wonder[] = [];
  const M = settle(BIOMES.meadow.x, BIOMES.meadow.z, 500);
  out.push({ id: 'moontree', name: 'The Moon Tree', line: 'Oh! A tree made of moonlight. It hums when you get close!', x: M.x, y: hf.height(M.x, M.z), z: M.z, yaw: 0.4, scale: 1, r: 3, reach: 30 });
  const L = settle(BIOMES.lantern.x, BIOMES.lantern.z, 500);
  out.push({ id: 'ring', name: 'The Mushroom Ring', line: 'Oh! A fairy ring. Something danced here once...', x: L.x, y: hf.height(L.x, L.z), z: L.z, yaw: 0, scale: 1, r: 0, reach: 20 });
  const W = settle(BIOMES.dunes.x, BIOMES.dunes.z, 450);
  out.push({ id: 'whale', name: 'The Sleeping Whale', line: 'Oh! The bones of a whale. Was the sea up here once?', x: W.x, y: hf.height(W.x, W.z) - 0.6, z: W.z, yaw: 1.1, scale: 1, r: 0, reach: 35 });
  // The bell tower stands in the drowned square itself, up to its knees in the sea.
  const D = BIOMES.drowned;
  out.push({ id: 'bell', name: 'The Drowned Bell', line: 'Listen! A bell under the water. It still rings for someone.', x: D.x, y: Math.min(hf.height(D.x, D.z), -0.4), z: D.z, yaw: 0.35, scale: 1, r: 3.2, reach: 40 });
  // The floating rocks hang over the highest open ground on the island.
  let hi = { x: 0, z: 0, h: -Infinity };
  for (let gz = -WORLD_HALF * 0.8; gz < WORLD_HALF * 0.8; gz += 64)
    for (let gx = -WORLD_HALF * 0.8; gx < WORLD_HALF * 0.8; gx += 64) {
      const s = hf.sample(gx, gz);
      if (s.meadow + s.lantern + s.dunes > 0.3) continue;
      if (s.height > hi.h) hi = { x: gx, z: gz, h: s.height };
    }
  out.push({ id: 'rocks', name: 'The Sky Stones', line: 'Look up! The stones are floating! How are they doing that?', x: hi.x, y: hi.h + 22, z: hi.z, yaw: 0, scale: 1.4, r: 0, reach: 60 });
  return out;
}
