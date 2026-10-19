import * as THREE from 'three/webgpu';
import {
  attribute, color, float, mix, mx_fractal_noise_float, mx_noise_float, normalWorld, positionWorld, smoothstep,
  texture, vec2, vec3, screenUV, max,
} from 'three/tsl';
import { PALETTE } from '../config';

/**
 * Reflection source shared by the water and the wet sand. The water's reflector owns the
 * render target; terrain samples it through this proxy, which is pointed at a dummy while
 * the reflection pass itself is drawing (sampling your own render target is illegal).
 */
export function createReflectionProxy() {
  const dummy = new THREE.DataTexture(new Uint8Array([12, 22, 80, 255]), 1, 1);
  dummy.needsUpdate = true;
  return { node: texture(dummy), dummy };
}

/**
 * Painterly terrain: sand that blushes pink, mirror-wet shorelines, near-black jungle,
 * granite walls with vertical rain streaks, all broken up by brush-scale noise.
 */
export function createTerrainMaterial(reflection: THREE.TextureNode) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const attrs = attribute<'vec2'>('terrainAttrs', 'vec2');
  const rock = attrs.x;
  const grove = attrs.y;
  const p = positionWorld;
  const h = p.y;
  const up = normalWorld.y;
  const slope = up.oneMinus();

  const brush = mx_fractal_noise_float(vec3(p.x.mul(0.06), p.y.mul(0.02), p.z.mul(0.06)), 3);
  const fine = mx_noise_float(vec2(p.x.mul(0.7), p.z.mul(0.7)));
  const large = mx_fractal_noise_float(vec3(p.x.mul(0.004), 0, p.z.mul(0.004)), 3);

  const sand = mix(color(PALETTE.sand), color(0xd9b3b0), brush.mul(0.5).add(0.5)).mul(fine.mul(0.06).add(0.97));
  const jungle = mix(color(PALETTE.jungle), color(PALETTE.jungleLit), smoothstep(-0.3, 0.6, brush.add(large.mul(0.5))).mul(0.6));
  // Vertical streaking: stretch noise along Y so granite walls read as rain-washed faces.
  const streak = mx_noise_float(vec3(p.x.mul(0.09), p.y.mul(0.006), p.z.mul(0.09)));
  const granite = mix(color(PALETTE.rock), color(PALETTE.rockLit), smoothstep(-0.6, 0.8, streak.add(brush.mul(0.5)))).mul(0.85);
  const grass = mix(color(0x16302a), color(0x29504a), brush.mul(0.5).add(0.5));

  const sandMask = smoothstep(2.6, 1.2, h.add(brush.mul(0.8))).mul(smoothstep(0.55, 0.25, slope));
  const vegMask = smoothstep(0.15, 0.55, grove.add(brush.mul(0.15)));
  let base = mix(grass, jungle, vegMask);
  base = mix(base, granite, max(rock, smoothstep(0.55, 0.8, slope)));
  base = mix(base, sand, sandMask);

  // Mirror-wet band at the waterline reuses the water's reflection target (refs 2 and 3).
  const wetMask = smoothstep(0.75, 0.05, h.add(fine.mul(0.08))).mul(sandMask);
  const ripple = vec2(fine.mul(0.004), mx_noise_float(vec2(p.x.mul(0.3), p.z.mul(0.3))).mul(0.004));
  const mirrored = reflection.sample(screenUV.flipX().add(ripple)).rgb;
  const wetColor = mix(color(PALETTE.wetSand), mirrored.mul(1.1), 0.9);
  mat.colorNode = mix(base, wetColor, wetMask);
  mat.roughnessNode = mix(float(0.95), float(0.25), wetMask);

  // Moonlit silver on upward-facing high ground, like the snow-dusted peaks in refs 1 and 4.
  const silver = smoothstep(0.35, 0.85, up).mul(smoothstep(120, 520, h)).mul(smoothstep(-0.2, 0.5, brush.add(streak.mul(0.5))));
  mat.colorNode = mix(mat.colorNode, color(0xaab8ec), silver.mul(0.7));
  const rim = smoothstep(0.55, 1.0, up).mul(smoothstep(60, 400, h)).mul(0.03).add(silver.mul(0.05));
  mat.emissiveNode = vec3(0.3, 0.36, 0.7).mul(rim);
  return mat;
}
