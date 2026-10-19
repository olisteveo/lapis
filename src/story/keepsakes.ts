import * as THREE from 'three/webgpu';
import { color, exp, length, sin, time, uv, vec4 } from 'three/tsl';
import { BIOMES, LAGOONS, mulberry32, type Heightfield } from '../world/heightfield';
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

/** The keepsakes lying in the world: a small soft light on a stone, with a ring of motes. */
export class Keepsakes {
  readonly group = new THREE.Group();
  private items = new Map<KeepsakeId, { obj: THREE.Group; pos: THREE.Vector3 }>();

  constructor(spots: Record<KeepsakeId, P>, height: (x: number, z: number) => number, owned: (id: KeepsakeId) => boolean) {
    this.group.name = 'keepsakes';
    const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 0.6, 9).translate(0, 0.2, 0), new THREE.MeshBasicNodeMaterial({ color: 0x3a4470 }));
    for (const def of KEEPSAKES) {
      if (owned(def.id)) continue;
      const s = spots[def.id];
      const y = Math.max(height(s.x, s.z), -0.4);
      const obj = new THREE.Group();
      obj.position.set(s.x, y, s.z);
      obj.add(stone.clone());
      const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const r = length(uv().sub(0.5)).mul(2);
      const pulse = sin(time.mul(1.7)).mul(0.2).add(1);
      mat.colorNode = vec4(color(def.tint).mul(exp(r.mul(-5)).mul(1.8).add(exp(r.mul(-16)).mul(2.5))).mul(pulse), 1);
      const glow = new THREE.Sprite(mat);
      glow.position.y = 1.1;
      glow.scale.setScalar(1.1);
      obj.add(glow);
      // A slow ring of motes circling it, so it reads as special rather than another star.
      const ringMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      ringMat.colorNode = vec4(color(def.tint).mul(exp(r.mul(-7)).mul(1.4)), 1);
      for (let k = 0; k < 6; k++) {
        const m = new THREE.Sprite(ringMat);
        m.scale.setScalar(0.18);
        m.userData.k = k;
        obj.add(m);
      }
      this.group.add(obj);
      this.items.set(def.id, { obj, pos: new THREE.Vector3(s.x, y + 1.1, s.z) });
    }
  }

  nearest(x: number, z: number) {
    let best: { id: KeepsakeId; dist: number; pos: THREE.Vector3 } | null = null;
    for (const [id, it] of this.items) {
      const d = Math.hypot(it.pos.x - x, it.pos.z - z);
      if (!best || d < best.dist) best = { id, dist: d, pos: it.pos };
    }
    return best;
  }

  take(id: KeepsakeId) {
    const it = this.items.get(id);
    if (!it) return;
    this.group.remove(it.obj);
    this.items.delete(id);
  }

  update() {
    const t = performance.now() / 1000;
    for (const it of this.items.values())
      for (const c of it.obj.children)
        if (c.userData.k !== undefined) {
          const a = t * 0.8 + (c.userData.k / 6) * Math.PI * 2;
          c.position.set(Math.cos(a) * 0.7, 1.1 + Math.sin(t * 1.3 + c.userData.k) * 0.15, Math.sin(a) * 0.7);
        }
  }
}

