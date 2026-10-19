import * as THREE from 'three/webgpu';
import {
  cameraPosition, color, dot, float, fract, floor, hash, instancedBufferAttribute, length, mix, mod, normalize, pow, reflect,
  saturate, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4, mx_noise_float,
} from 'three/tsl';
import { PALETTE, QUALITY, SKY, onQualityChange } from '../config';
import { mulberry32 } from './heightfield';
import { starShape } from '../render/starShape';

/**
 * Fallen stars on the water: thousands of four-point glints that wrap around the camera.
 * Each sprite has a random facet normal that re-rolls a few times a second; it lights up
 * when that facet mirrors the bright star, so the glints gather into a path pointing home.
 */
// Where the glitter path points: the bright one by default, your next goal when at sea.
const guide = uniform(new THREE.Vector3(SKY.brightStar.x, SKY.brightStar.y, SKY.brightStar.z));

function layer(count: number, span: number, seed: number, sizeScale: number, near: number) {
  const rnd = mulberry32(seed);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    a[i * 4] = rnd();
    a[i * 4 + 1] = rnd();
    a[i * 4 + 2] = rnd();
    a[i * 4 + 3] = rnd();
  }
  const s = instancedBufferAttribute(new THREE.InstancedBufferAttribute(a, 4), 'vec4') as any;
  const intensity = uniform(1);

  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const half = float(span / 2);
  const cam = cameraPosition.xz;
  const base = vec2(s.x, s.y).mul(span);
  const xz = mod(base.sub(cam).add(half), float(span)).sub(half).add(cam);
  const wave = mx_noise_float(vec3(xz.mul(0.05), time.mul(0.2)) as any).mul(0.12);
  const pos = vec3(xz.x, wave.add(0.06), xz.y);
  mat.positionNode = pos;

  const rate = s.z.mul(3).add(1.5);
  const tick = floor(time.mul(rate).add(s.w.mul(10)));
  const phase = fract(time.mul(rate).add(s.w.mul(10)));
  const h1 = hash(tick.add(s.x.mul(9137)));
  const h2 = hash(tick.add(s.y.mul(5711)));
  const facet = normalize(vec3(h1.sub(0.5).mul(0.9), 1, h2.sub(0.5).mul(0.9)));
  const v = normalize(cameraPosition.sub(pos));
  const glint = pow(saturate(dot(reflect(v.negate(), facet), normalize(guide))), 9);
  // A second, sparser population twinkles anywhere so open water never goes dead.
  const ambient = pow(hash(tick.add(s.z.mul(3001))), 14).mul(0.7);
  const envelope = sin(phase.mul(Math.PI));
  const d = length(xz.sub(cam));
  const edgeFade = smoothstep(half, half.mul(0.75), d);
  // Keep glints off the camera: up close a single sprite would fill the view with rays.
  const nearFade = smoothstep(float(near), float(near * 3), d);
  const bright = glint.mul(1.6).add(ambient).mul(envelope).mul(edgeFade).mul(nearFade).mul(intensity);

  const size = float(0.4).add(d.mul(0.0045)).mul(bright.min(1.6).mul(0.8).add(0.25)).mul(sizeScale);
  mat.scaleNode = vec2(size.mul(bright.greaterThan(0.02).select(float(1), float(0))) as any);
  const shape = starShape(uv(), bright.mul(0.5).add(0.45).min(1), float(0));
  const warm = smoothstep(0.55, 0.85, s.w);
  const tint = mix(color(PALETTE.starWhite), color(PALETTE.starGold), warm);
  mat.colorNode = vec4(tint.mul(shape).mul(bright).mul(1.8), 1);

  const sprite = new THREE.Sprite(mat);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = 2;
  return { sprite, intensity };
}

export function createSparkles() {
  // Each layer keeps its glints far enough out that none can swell across the view.
  // Allocated at full size; quality just changes how many are drawn.
  const near = layer(22000, 240, 7, 1.1, 5);
  const mid = layer(22000, 900, 9, 1.4, 40);
  const far = layer(18000, 2600, 8, 2.0, 160);
  const applyCounts = () => {
    near.sprite.count = Math.round(22000 * QUALITY.sparkles);
    mid.sprite.count = Math.round(22000 * QUALITY.sparkles);
    far.sprite.count = Math.round(18000 * QUALITY.sparkles);
  };
  applyCounts();
  onQualityChange(applyCounts);
  const group = new THREE.Group();
  group.name = 'sparkles';
  group.add(near.sprite, mid.sprite, far.sprite);
  return {
    group,
    /** Point the glitter path toward a world position (or back to the bright one with null). */
    guideTo(from: THREE.Vector3 | null, to: THREE.Vector3 | null, dt: number) {
      const want = new THREE.Vector3(SKY.brightStar.x, SKY.brightStar.y, SKY.brightStar.z);
      if (from && to) {
        const d = new THREE.Vector3(to.x - from.x, 0, to.z - from.z).normalize();
        // Keep it low in the sky so the path runs long across the water toward the goal.
        want.set(d.x, 0.32, d.z).normalize();
      }
      guide.value.lerp(want, Math.min(1, dt * 0.8)).normalize();
    },
    setIntensity(v: number) {
      near.intensity.value = v;
      mid.intensity.value = v;
      far.intensity.value = v;
    },
  };
}
