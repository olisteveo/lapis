import * as THREE from 'three/webgpu';
import { cameraPosition, color, float, fract, instancedBufferAttribute, length, mod, smoothstep, time, uv, vec2, vec3, vec4, abs } from 'three/tsl';
import { mulberry32 } from '../core/heightfield';
import { QUALITY, onQualityChange } from '../config';
import { weather } from '../render/weather';

/**
 * A squall's rain: streaks falling in a box that travels with the camera, slanted by the wind and
 * only as dense as the storm is strong. Drawn as thin additive sprites, inked lightly by the painting.
 */
export function createRain() {
  const count = 2600;
  const span = 36;
  const rnd = mulberry32(77);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) a[i] = rnd();
  const s = instancedBufferAttribute(new THREE.InstancedBufferAttribute(a, 4), 'vec4') as any;
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const half = float(span / 2);
  const cam = cameraPosition;
  // Each drop falls 14 m in a cycle at ~16 m/s, carried sideways by the wind as it goes.
  const fall = fract(time.mul(1.15).mul(s.w.mul(0.4).add(0.8)).add(s.z));
  const wind = vec3(weather.windX, 0, weather.windZ).mul(fall.mul(9));
  const base = vec3(s.x, 0, s.y).mul(span).add(wind);
  const local: any = mod(base.sub(cam).add(half), float(span)).sub(half);
  const y: any = cam.y.add(10).sub(fall.mul(14));
  const pos: any = vec3(local.x.add(cam.x), y, local.z.add(cam.z));
  mat.positionNode = pos;
  const d = length(pos.sub(cam));
  // Only some drops fall in a light shower; all of them in a full squall.
  const gate = fract(s.x.mul(7.31).add(s.y.mul(3.17))).mul(0.6);
  const on = smoothstep(gate, gate.add(0.1), weather.storm as any);
  const fade = smoothstep(half, half.mul(0.5), d).mul(smoothstep(0.8, 2.5, d)).mul(on);
  mat.scaleNode = vec2(0.028, 0.9).mul(fade.greaterThan(0.01).select(float(1), float(0))) as any;
  const u = uv();
  const streak = smoothstep(0.5, 0.0, abs(u.x.sub(0.5))).mul(smoothstep(0.0, 0.4, u.y)).mul(smoothstep(1.0, 0.6, u.y));
  mat.colorNode = vec4(color(0xb4c6f0).mul(streak).mul(fade).mul(0.75), 1);
  const sprite = new THREE.Sprite(mat);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = 4;
  const apply = () => (sprite.count = Math.round(count * Math.max(0.4, QUALITY.motes)));
  apply();
  onQualityChange(apply);
  return sprite;
}
