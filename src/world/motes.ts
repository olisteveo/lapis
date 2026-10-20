import * as THREE from 'three/webgpu';
import {
  cameraPosition, color, float, fract, instancedBufferAttribute, mix, mod, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4, length, exp,
} from 'three/tsl';
import { PALETTE, QUALITY, onQualityChange } from '../config';
import { mulberry32 } from '../core/heightfield';

/**
 * Dream motes. Fireflies: warm points drifting and blinking at head height around you.
 * Star motes: pale sparks that rise slowly off the world and fade, as if the fallen stars
 * are trying to get back up. Region motes: each region breathes its own light around you, shown
 * as far as you are inside it: spores in the Lantern Wood, pollen over the meadows, glitter blown
 * off the dunes, bubbles of sea light rising through the drowned town.
 */
interface RegionMote {
  tint: [number, number];
  /** Cycles per second of the rise, and how far (m) a mote climbs from just below your feet. */
  rise: number;
  climb: number;
  /** Wandering amplitude (m) and steady wind (m/s, x and z). */
  wander: number;
  wind: [number, number];
  size: number;
  gain: number;
}

const REGION_MOTES = {
  lantern: { tint: [0x5fe8d8, 0xd8fdff], rise: 0.06, climb: 7, wander: 0.8, wind: [0, 0], size: 0.07, gain: 2.0 },
  meadow: { tint: [0xe6d4ff, 0xfff4c8], rise: 0.025, climb: 3, wander: 1.4, wind: [0.25, 0.1], size: 0.05, gain: 1.6 },
  dunes: { tint: [0xc8d4ff, 0xffffff], rise: 0.04, climb: 1.6, wander: 0.4, wind: [1.6, 0.7], size: 0.035, gain: 2.4 },
  drowned: { tint: [0x40d8f0, 0xb8f4ff], rise: 0.05, climb: 5, wander: 0.3, wind: [0, 0], size: 0.06, gain: 1.8 },
} satisfies Record<string, RegionMote>;

/** 0..1, how deep in each region the player is (set each frame from main). */
const density = () => uniform(0);
export const regionMotes = Object.fromEntries(Object.keys(REGION_MOTES).map((k) => [k, density()])) as Record<keyof typeof REGION_MOTES, ReturnType<typeof density>>;

function cloud(count: number, span: number, seed: number, kind: 'firefly' | 'rise' | keyof typeof REGION_MOTES) {
  const region: RegionMote | null = kind === 'firefly' || kind === 'rise' ? null : REGION_MOTES[kind];
  const rnd = mulberry32(seed);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) a[i] = rnd();
  const s = instancedBufferAttribute(new THREE.InstancedBufferAttribute(a, 4), 'vec4') as any;
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const half = float(span / 2);
  const cam = cameraPosition;
  const t = time;
  const base = vec3(s.x, s.y, s.z).mul(span);
  const drift = kind === 'firefly'
    ? vec3(sin(t.mul(0.31).add(s.w.mul(40))), sin(t.mul(0.53).add(s.x.mul(30))).mul(0.4), sin(t.mul(0.27).add(s.y.mul(50)))).mul(2.2)
    : region
      ? vec3(sin(t.mul(0.5).add(s.w.mul(20))), 0, sin(t.mul(0.43).add(s.x.mul(20)))).mul(region.wander).add(vec3(region.wind[0], 0, region.wind[1]).mul(t))
      : vec3(sin(t.mul(0.2).add(s.w.mul(20))).mul(1.5), 0, sin(t.mul(0.17).add(s.x.mul(20))).mul(1.5));
  const local = mod(base.add(drift).sub(cam).add(half), float(span)).sub(half);
  let y: any;
  let life: any;
  if (kind === 'firefly') {
    y = cam.y.add(local.y.mul(0.35)).sub(0.5);
    // Slow blink: mostly dark, a soft swell of light, then gone.
    life = smoothstep(0.55, 1.0, sin(t.mul(s.w.mul(1.2).add(0.4)).add(s.z.mul(60))));
  } else if (region) {
    // Lifted off the ground around your feet, drifting up before going out.
    const cycle = fract(t.mul(region.rise).mul(s.w.mul(0.8).add(0.6)).add(s.z));
    y = cam.y.sub(1.7).add(cycle.mul(region.climb));
    life = smoothstep(0.0, 0.1, cycle).mul(smoothstep(1.0, 0.6, cycle)).mul(regionMotes[kind as keyof typeof REGION_MOTES]);
    // Glitter catches the light in flashes rather than glowing steadily.
    if (kind === 'dunes') life = life.mul(smoothstep(0.3, 1.0, sin(t.mul(4).add(s.y.mul(90)))));
  } else {
    const cycle = fract(t.mul(0.025).mul(s.w.mul(0.8).add(0.6)).add(s.z));
    y = cycle.mul(28).sub(2);
    life = smoothstep(0.0, 0.15, cycle).mul(smoothstep(1.0, 0.55, cycle));
  }
  const pos = vec3(local.x.add(cam.x), y, local.z.add(cam.z));
  mat.positionNode = pos;
  const d = length(pos.sub(cam));
  const fade = smoothstep(half, half.mul(0.6), d).mul(smoothstep(0.6, 2.0, d));
  const size = kind === 'firefly' ? float(0.09).add(d.mul(0.002)) : region ? float(region.size).add(d.mul(0.002)) : float(0.12).add(d.mul(0.0025));
  mat.scaleNode = vec2(size.mul(life.greaterThan(0.01).select(float(1), float(0))) as any);
  const r = length(uv().sub(0.5)).mul(2);
  // Clipped to the circle: the faint tail at the quad's corners shows as a square once painted.
  const glow = exp(r.mul(-5)).add(exp(r.mul(-18)).mul(2)).mul(smoothstep(1, 0.7, r));
  const tint = kind === 'firefly'
    ? mix(color(PALETTE.starGold), color(0xffe2a0), s.x)
    : region ? mix(color(region.tint[0]), color(region.tint[1]), s.y) : mix(color(0xbfd0ff), color(PALETTE.starWhite), s.y);
  mat.colorNode = vec4(tint.mul(glow).mul(life).mul(fade).mul(kind === 'firefly' ? 2.4 : region ? region.gain : 1.4), 1);
  const sprite = new THREE.Sprite(mat);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = 3;
  return sprite;
}

export function createMotes() {
  const group = new THREE.Group();
  group.name = 'motes';
  const flies = cloud(700, 70, 21, 'firefly');
  const rising = cloud(240, 260, 22, 'rise');
  const regional = (Object.keys(REGION_MOTES) as (keyof typeof REGION_MOTES)[]).map((k, i) => cloud(900, 40, 23 + i, k));
  group.add(flies, rising, ...regional);
  const apply = () => {
    flies.count = Math.round(700 * QUALITY.motes);
    rising.count = Math.round(240 * QUALITY.motes);
    for (const r of regional) r.count = Math.round(900 * QUALITY.motes);
  };
  apply();
  onQualityChange(apply);
  return group;
}
