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
  /** What it does when held up (keys 1 to 5). */
  use: string;
  /** The little light's line when you first find it: how to hold it. */
  how: string;
  tint: number;
}

export const KEEPSAKES: KeepsakeDef[] = [
  { id: 'shell', name: 'The Seashell', memory: 'Hold it to your ear. You can hear the stars in it.', effect: 'Hums when a hidden star is near. The closer, the brighter it sings.', hint: 'behind falling water, where the sea is still and full of light', use: 'it sings toward the nearest hidden star, and a pink shimmer shows which way.', how: 'Listen! Press 1 to hold the seashell to your ear. It sings toward hidden stars!', tint: 0xffb8c8 },
  { id: 'wings', name: 'Moth Wings', memory: 'I made you wings. Now you can fly too.', effect: 'Hold Space in the air to glide.', hint: 'on high ground in the meadows', use: 'spread wide, they carry a glide much further.', how: 'Look! Wings! Hold Space while you fall to glide. Press 2 to spread them wide and glide even further.', tint: 0xe8e0ff },
  { id: 'lantern', name: 'Paper Lantern', memory: 'Take it. Then the dark has to stay back.', effect: 'Nightmares keep their distance, and you can spot star glints from further away.', hint: 'deep in the Lantern Wood', use: 'its light drives nightmares back twice as far and shows star glints from further still.', how: 'Oh! Press 3 to hold the lantern up. The nightmares hate it!', tint: 0xffc070 },
  { id: 'compass', name: 'The Compass', memory: "It always knows where home is. Even when I don't.", effect: 'Shows where you are on the chart.', hint: 'among the dunes', use: 'its needle points to the nearest lighthouse while you carry stars, otherwise to the nearest sky still dark.', how: 'Hey! Press 4 to look at the compass. The needle knows where you should go!', tint: 0x9ff0e0 },
  { id: 'ribbon', name: 'Her Ribbon', memory: 'Keep it till I come back. Then you have to give it back.', effect: 'She sleeps more soundly: the nights last longer.', hint: 'in the drowned town', use: 'while you hold it, she sleeps deeper still and the night slows.', how: 'Listen... Press 5 to hold her ribbon. While you do, the night goes slower.', tint: 0xff8fa8 },
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
      // Each sits in a small setting (a staff, a crook, a chest, a post) that needs level ground.
      const slope = Math.max(...[[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dz]) => Math.abs(hf.height(x + dx, z + dz) - h) / 2));
      if (slope > 0.3) continue;
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
