import * as THREE from 'three/webgpu';
import { float, length, smoothstep, uniform, vec2 } from 'three/tsl';
import { EDGE, type Refuge } from '../core/darkWater';

// TSL's generics can't follow values through these unrolled loops; nodes are typed loosely.
type N = any;

/** Up to this many clear circles (restored regions and the waking shore). */
const MAX_REFUGES = 6;

/**
 * The Dark Water field on the GPU, the same as core/darkWater.ts darkAt(): the water, sparkles,
 * palms and fog all read it so they agree on where the dark has reached.
 */
export const darkUniforms = {
  reach: uniform(1e9),
  refuges: Array.from({ length: MAX_REFUGES }, () => uniform(new THREE.Vector4(0, 0, 0, 0))),
  /** 0..1: how much of the sea has gone dark, for the fog. */
  gloom: uniform(0),
};

export function setDarkWater(reach: number, refuges: readonly Refuge[], gloom: number) {
  darkUniforms.reach.value = Number.isFinite(reach) ? reach : 1e9;
  darkUniforms.refuges.forEach((u, i) => {
    const f = refuges[i];
    u.value.set(f?.x ?? 0, f?.z ?? 0, f?.r ?? 0, f ? 1 : 0);
  });
  darkUniforms.gloom.value = gloom;
}

/** 0 clear to 1 fully dark at a world xz position. */
export function darkAtNode(xz: N): N {
  const reach = darkUniforms.reach as N;
  let dark: N = smoothstep(reach.sub(EDGE), reach.add(EDGE), length(xz));
  for (const u of darkUniforms.refuges) {
    const f = u as N;
    const d = length(xz.sub(vec2(f.x, f.y)));
    dark = dark.mul(float(1).sub(smoothstep(f.z.mul(1.8), f.z.mul(1.2), d).mul(f.w)));
  }
  return dark;
}
