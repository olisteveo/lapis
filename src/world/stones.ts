import * as THREE from 'three/webgpu';
import { color, mix, mx_noise_float, normalWorld, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { LAGOONS, type Heightfield } from './heightfield';
import type { Platforms } from '../game/player';

export interface Stone {
  x: number;
  z: number;
  r: number;
  top: number;
}

function rnd(i: number, k: number) {
  let h = Math.imul(i + 5, 374761393) ^ Math.imul(k + 9, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Stepping-stone paths through each lagoon's flooded cleft, from the outside beach to the
 * hidden inner beach. Spacing is tuned to the jump: most gaps are an easy hop, one or two
 * want a run-up.
 */
export function layoutStones(hf: Heightfield): Stone[] {
  const out: Stone[] = [];
  // Centre-to-centre distances. The 3.4-3.7 entries are the run-up jumps.
  const rhythm = [2.3, 2.5, 2.4, 2.7, 3.5, 2.4, 2.6, 2.3, 2.8, 3.7, 2.4, 2.5, 2.6, 2.4, 2.5, 2.3];
  LAGOONS.forEach((L, li) => {
    const g = hf.lagoonGaps[li];
    const dir = { x: Math.sin(g), z: Math.cos(g) };
    // Walk outward from the cleft to find dry ground where the path begins.
    let start = L.r + 30;
    while (start < L.r + 90 && hf.height(L.x + dir.x * start, L.z + dir.z * start) < 0.15) start += 1;
    const end = L.r - 9;
    let d = start - 1.6;
    let k = 0;
    while (d > end + 1.2 && k < 40) {
      const side = (k % 2 === 0 ? 1 : -1) * (0.2 + rnd(li * 50 + k, 1) * 0.35);
      const px = -dir.z;
      const pz = dir.x;
      const x = L.x + dir.x * d + px * side;
      const z = L.z + dir.z * d + pz * side;
      if (hf.height(x, z) < 0.05) {
        out.push({ x, z, r: 0.55 + rnd(li * 50 + k, 2) * 0.3, top: 0.3 + rnd(li * 50 + k, 3) * 0.55 + (k % 5 === 4 ? 0.35 : 0) });
      }
      d -= rhythm[k % rhythm.length];
      k++;
    }
  });
  return out;
}

export class Stones implements Platforms {
  readonly mesh: THREE.InstancedMesh;

  constructor(readonly list: Stone[]) {
    const geo = new THREE.CylinderGeometry(1, 1.25, 1, 10, 3);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // Weathered, rounded shoulders; the top stays nearly flat so it reads as standable.
      const n = Math.sin(v.x * 3.1 + v.z * 2.3) * 0.08 + Math.sin(v.z * 5.7 - v.y * 2.1) * 0.05;
      const shoulder = v.y > 0.3 ? 0.88 : 1;
      v.x *= shoulder + n;
      v.z *= shoulder + n;
      if (v.y > 0.45) v.y = 0.5 - (v.x * v.x + v.z * v.z) * 0.04;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
    const wet = smoothstep(0.35, -0.1, positionWorld.y);
    const top = smoothstep(0.6, 0.95, normalWorld.y);
    const grain = mx_noise_float(positionWorld.mul(1.7)).mul(0.5).add(0.5);
    mat.colorNode = mix(mix(color(0x2c3557), color(0x5b6797), top.mul(grain)), color(0x141a33), wet);
    mat.emissiveNode = vec3(0.04, 0.05, 0.1).mul(top);
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    const m = new THREE.Matrix4();
    list.forEach((s, i) => {
      const height = s.top + 3;
      m.compose(
        new THREE.Vector3(s.x, s.top - height * 0.5, s.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd(i, 7) * 6.28),
        new THREE.Vector3(s.r, height, s.r),
      );
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.count = list.length;
    this.mesh.name = 'steppingStones';
  }

  /** Generous footing: your feet count, not just your centre, so near-misses still land. */
  top(x: number, z: number) {
    let best = -Infinity;
    for (const s of this.list) if (Math.hypot(s.x - x, s.z - z) < s.r + 0.3) best = Math.max(best, s.top);
    return best;
  }

  blocksBoat(x: number, z: number, radius: number) {
    for (const s of this.list) if (Math.hypot(s.x - x, s.z - z) < s.r + radius) return true;
    return false;
  }
}
