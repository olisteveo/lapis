import * as THREE from 'three/webgpu';
import { color, exp, length, sin, time, uv, vec4 } from 'three/tsl';
import type { P } from '../core/placement';

export { KEEPSAKES, layoutKeepsakes, type KeepsakeDef, type KeepsakeId } from '../core/keepsakes';
import { KEEPSAKES, type KeepsakeId } from '../core/keepsakes';

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

