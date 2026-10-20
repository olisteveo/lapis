import * as THREE from 'three/webgpu';
import { abs, float, max, mix, smoothstep, uniform } from 'three/tsl';

// TSL's generics can't follow values through these unrolled loops; nodes are typed loosely.
type N = any;

/** Up to this many drained areas are shown dimmed at once (the most drained). */
const MAX = 8;

/**
 * Glowing places the lantern has drawn from (core/survival.ts Sources): their light is visibly
 * lower until it regrows. Each slot is an area's centre (x, z), half-size and how much is back.
 */
export const drainedSlots = Array.from({ length: MAX }, () => uniform(new THREE.Vector4(0, 0, 0, 1)));

export function setDrained(areas: readonly { x: number; z: number; left: number }[], half: number) {
  drainedSlots.forEach((u, i) => {
    const a = areas[i];
    u.value.set(a?.x ?? 0, a?.z ?? 0, a ? half : 0, a?.left ?? 1);
  });
}

/** 0..1 light remaining at a world xz: 1 everywhere except in drained areas. */
export function glowLeftNode(xz: N): N {
  let left: N = float(1);
  for (const u of drainedSlots) {
    const s = u as N;
    const d = max(abs(xz.x.sub(s.x)), abs(xz.y.sub(s.y)));
    // Softened at the area's edge so a drained patch has no hard square border.
    const inside = smoothstep(s.z.add(4), s.z.sub(4), d).mul(s.z.greaterThan(0).select(float(1), float(0)));
    left = left.mul(mix(float(1), s.w.mul(0.85).add(0.15), inside));
  }
  return left;
}
