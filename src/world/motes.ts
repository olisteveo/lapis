import * as THREE from 'three/webgpu';
import {
  cameraPosition, color, float, fract, instancedBufferAttribute, mix, mod, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4, length, exp,
} from 'three/tsl';
import { PALETTE, QUALITY, onQualityChange } from '../config';
import { mulberry32 } from '../core/heightfield';

/**
 * Dream motes. Fireflies: warm points drifting and blinking at head height around you.
 * Star motes: pale sparks that rise slowly off the world and fade, as if the fallen stars
 * are trying to get back up. Spores: cold cyan specks the Lantern Wood's mushrooms breathe out,
 * rising from the forest floor around you; only shown as far as you are inside the wood.
 */
/** 0..1, how deep in the Lantern Wood the player is (set each frame from main). */
export const sporeDensity = uniform(0);

function cloud(count: number, span: number, seed: number, kind: 'firefly' | 'rise' | 'spore') {
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
    : kind === 'spore'
      ? vec3(sin(t.mul(0.5).add(s.w.mul(20))), 0, sin(t.mul(0.43).add(s.x.mul(20)))).mul(0.8)
      : vec3(sin(t.mul(0.2).add(s.w.mul(20))).mul(1.5), 0, sin(t.mul(0.17).add(s.x.mul(20))).mul(1.5));
  const local = mod(base.add(drift).sub(cam).add(half), float(span)).sub(half);
  let y: any;
  let life: any;
  if (kind === 'firefly') {
    y = cam.y.add(local.y.mul(0.35)).sub(0.5);
    // Slow blink: mostly dark, a soft swell of light, then gone.
    life = smoothstep(0.55, 1.0, sin(t.mul(s.w.mul(1.2).add(0.4)).add(s.z.mul(60))));
  } else if (kind === 'spore') {
    // Lifted off the floor around your feet, drifting up past head height before going out.
    const cycle = fract(t.mul(0.06).mul(s.w.mul(0.8).add(0.6)).add(s.z));
    y = cam.y.sub(1.7).add(cycle.mul(7));
    life = smoothstep(0.0, 0.1, cycle).mul(smoothstep(1.0, 0.6, cycle)).mul(sporeDensity);
  } else {
    const cycle = fract(t.mul(0.025).mul(s.w.mul(0.8).add(0.6)).add(s.z));
    y = cycle.mul(28).sub(2);
    life = smoothstep(0.0, 0.15, cycle).mul(smoothstep(1.0, 0.55, cycle));
  }
  const pos = vec3(local.x.add(cam.x), y, local.z.add(cam.z));
  mat.positionNode = pos;
  const d = length(pos.sub(cam));
  const fade = smoothstep(half, half.mul(0.6), d).mul(smoothstep(0.6, 2.0, d));
  const size = kind === 'firefly' ? float(0.09).add(d.mul(0.002)) : kind === 'spore' ? float(0.07).add(d.mul(0.002)) : float(0.12).add(d.mul(0.0025));
  mat.scaleNode = vec2(size.mul(life.greaterThan(0.01).select(float(1), float(0))) as any);
  const r = length(uv().sub(0.5)).mul(2);
  // Clipped to the circle: the faint tail at the quad's corners shows as a square once painted.
  const glow = exp(r.mul(-5)).add(exp(r.mul(-18)).mul(2)).mul(smoothstep(1, 0.7, r));
  const tint = kind === 'firefly'
    ? mix(color(PALETTE.starGold), color(0xffe2a0), s.x)
    : kind === 'spore' ? mix(color(0x5fe8d8), color(0xd8fdff), s.y) : mix(color(0xbfd0ff), color(PALETTE.starWhite), s.y);
  mat.colorNode = vec4(tint.mul(glow).mul(life).mul(fade).mul(kind === 'firefly' ? 2.4 : kind === 'spore' ? 2.0 : 1.4), 1);
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
  const spores = cloud(900, 40, 23, 'spore');
  group.add(flies, rising, spores);
  const apply = () => {
    flies.count = Math.round(700 * QUALITY.motes);
    rising.count = Math.round(240 * QUALITY.motes);
    spores.count = Math.round(900 * QUALITY.motes);
  };
  apply();
  onQualityChange(apply);
  return group;
}
