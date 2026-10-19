import { BIOMES, LAGOONS, mulberry32, type Heightfield } from './heightfield';
import type { P } from './placement';

export type KeepsakeId = 'shell' | 'wings' | 'lantern' | 'compass' | 'ribbon';

export interface KeepsakeDef {
  id: KeepsakeId;
  name: string;
  /** Her memory of it, shown when found. */
  memory: string;
  /** What it does, in the satchel. */
  effect: string;
  /** Where to look, shown for keepsakes not yet found. */
  hint: string;
  tint: number;
}

export const KEEPSAKES: KeepsakeDef[] = [
  { id: 'shell', name: 'The Seashell', memory: 'Hold it to your ear. You can hear the stars in it.', effect: 'Hums when a hidden star is near. The closer, the brighter it sings.', hint: 'behind falling water, where the sea is still and full of light', tint: 0xffb8c8 },
  { id: 'wings', name: 'Moth Wings', memory: 'I made you wings. Now you can fly too.', effect: 'Hold Space in the air to glide.', hint: 'on high ground in the meadows', tint: 0xe8e0ff },
  { id: 'lantern', name: 'Paper Lantern', memory: 'Take it. Then the dark has to stay back.', effect: 'Nightmares keep their distance, and you can spot star glints from further away.', hint: 'deep in the Lantern Wood', tint: 0xffc070 },
  { id: 'compass', name: 'The Compass', memory: "It always knows where home is. Even when I don't.", effect: 'Shows where you are on the chart.', hint: 'among the dunes', tint: 0x9ff0e0 },
  { id: 'ribbon', name: 'Her Ribbon', memory: 'Keep it till I come back. Then you have to give it back.', effect: 'She sleeps more soundly: the nights last longer.', hint: 'in the drowned town', tint: 0xff8fa8 },
];

/** Each keepsake lies somewhere a little out of the way: a lagoon, a hilltop, the heart of a region. */
export function layoutKeepsakes(hf: Heightfield, spawn: P): Record<KeepsakeId, P> {
  const rnd = mulberry32(777);
  const out = {} as Record<KeepsakeId, P>;
  // The seashell waits on the ledge behind the waterfall, in the secret lagoon nearest where you wake.
  const order = LAGOONS.map((L, i) => ({ L, i })).sort((a, b) => Math.hypot(a.L.x - spawn.x, a.L.z - spawn.z) - Math.hypot(b.L.x - spawn.x, b.L.z - spawn.z));
  const { L, i } = order[0];
  const fa = hf.lagoonGaps[i] + Math.PI;
  out.shell = { x: L.x + Math.sin(fa) * (L.r - 7.5), z: L.z + Math.cos(fa) * (L.r - 7.5) };
  const regional: [KeepsakeId, keyof typeof BIOMES][] = [['wings', 'meadow'], ['lantern', 'lantern'], ['compass', 'dunes'], ['ribbon', 'drowned']];
  for (const [id, region] of regional) {
    const B = BIOMES[region];
    let best: P = { x: B.x, z: B.z };
    let bestScore = -Infinity;
    for (let k = 0; k < 300; k++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * B.r * (region === 'drowned' ? 1.2 : 0.85);
      const x = B.x + Math.sin(a) * d;
      const z = B.z + Math.cos(a) * d;
      const h = hf.height(x, z);
      if (h < (region === 'drowned' ? -1 : 0.8)) continue;
      // The wings sit on the highest ground; the others favour a quiet spot well inside.
      const score = region === 'meadow' ? h : -d * 0.01 + rnd() * 3 + (region === 'drowned' ? -Math.abs(h + 0.6) : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    out[id] = best;
  }
  return out;
}
