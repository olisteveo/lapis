import * as THREE from 'three/webgpu';
import { atan, color, float, length, mix, normalWorld, positionWorld, smoothstep, saturate, sin, time, uniform, vec3, positionLocal } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PropCollision } from '../core/propCollision';
import { gridFromObject } from './propGrid';
import { PALETTE } from '../config';
import { drawnSurface, penLines } from '../render/drawn';
import type { Colliders } from '../core/player';

type N = any;

export type { Wonder } from '../core/wonders';
export { layoutWonders } from '../core/wonders';
import type { Wonder } from '../core/wonders';

const BASE: Record<string, number> = {
  bone: 0xd8d2e6, stone: 0x6a74a8, rock: 0x4a5488, bark: 0x5a4a78, wood: 0x6b5450, bronze: 0x6a8a8a,
  mushroom_cap: 0x4a2f8a, mushroom_stem: 0xcfc6ea, moss: 0x3f6a7a, roof: 0x3a4478, leaf: 0x9fc6ff, foliage: 0x5a7ab8, grass: 0x3a6a60, ruin: 0x8a90b8,
};

/** Renders, animates and collides the wonders. */
export class Wonders implements Colliders {
  readonly group = new THREE.Group();
  private objs = new Map<string, THREE.Object3D>();
  private rocks: { obj: THREE.Object3D; base: THREE.Vector3; phase: number }[] = [];
  private near1 = uniform(0);

  constructor(readonly list: Wonder[]) {
    this.group.name = 'wonders';
  }

  private material(name: string, wonder: string) {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    if (name.includes('glow') || name.includes('light')) {
      const tint = wonder === 'moontree' ? 0xbfe4ff : wonder === 'ring' ? 0xc6a0ff : wonder === 'bell' ? 0x8ff0e6 : PALETTE.starGold;
      // Glows breathe, and brighten as you come close.
      const breathe = sin(time.mul(1.3).add(positionLocal.y.mul(0.6) as N)).mul(0.2).add(0.9);
      let glowCol: N = color(tint).mul(float(wonder === 'ring' ? 0.7 : 1.1).add(this.near1.mul(0.5))).mul(breathe);
      if (name.includes('mushroom_glow')) {
        // The ring's giant gills: radial ink lines, light gathered at the rim.
        const lp = positionLocal as N;
        const gills = penLines(atan(lp.z, lp.x).div(Math.PI * 2).mul(72), 1.2);
        glowCol = mix(glowCol.mul(smoothstep(1, 7, length(lp.xz)).mul(0.8).add(0.3)), color(0x0b1030), gills.mul(0.5));
      }
      mat.colorNode = glowCol;
      return mat;
    }
    const tint = color(BASE[Object.keys(BASE).find((k) => name.includes(k)) ?? ''] ?? 0x5b6890);
    mat.colorNode = drawnSurface(tint.mul(0.9), normalWorld, positionWorld).add(vec3(0.07, 0.09, 0.2).mul(saturate(normalWorld.y).mul(0.6)));
    return mat;
  }

  /** The wonders as solids you can stand on, walk under and bump into. */
  readonly solids = new PropCollision();
  private gridded = new Set<string>();

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const pick: Record<string, string> = { moontree: 'MoonTree', ring: 'MushroomRing', whale: 'WhaleSkeleton', bell: 'BellTower', rocks: 'FloatingRocks' };
    for (const w of this.list) {
      const t = gltf.scene.getObjectByName(pick[w.id]);
      if (!t) continue;
      const obj = t.clone(true);
      // The floating rocks drift, so they keep their simple footprint; the rest stand as built.
      if (w.id !== 'rocks') {
        this.solids.add(gridFromObject(t), w, w.id === 'moontree' ? 'wood' : w.id === 'ring' ? 'jungle' : 'stone');
        this.gridded.add(w.id);
      }
      obj.position.set(w.x, w.y, w.z);
      obj.rotation.set(0, w.yaw, 0);
      obj.scale.setScalar(w.scale);
      const mats = new Map<string, THREE.Material>();
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const name = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material).name || 'stone';
        if (!mats.has(name)) mats.set(name, this.material(name, w.id));
        m.material = mats.get(name)!;
      });
      if (w.id === 'rocks')
        obj.children.forEach((c, i) => this.rocks.push({ obj: c, base: c.position.clone(), phase: i * 1.7 }));
      this.objs.set(w.id, obj);
      this.group.add(obj);
    }
    return [...this.objs.keys()];
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const w of this.list) if (!this.gridded.has(w.id) && w.r > 0 && Math.abs(w.x - x) < reach + w.r && Math.abs(w.z - z) < reach + w.r) visit(w.x, w.z, w.r * w.scale);
  }

  /** The wonder whose discovery radius you are standing in, if any. */
  at(x: number, z: number, y = 0) {
    return this.list.find((w) => Math.hypot(w.x - x, w.z - z, w.id === 'rocks' ? (w.y - 22 - y) * 0.3 : 0) < w.reach) ?? null;
  }

  update(dt: number, focus: THREE.Vector3) {
    const t = performance.now() / 1000;
    for (const r of this.rocks) {
      r.obj.position.set(r.base.x, r.base.y + Math.sin(t * 0.4 + r.phase) * 1.4, r.base.z);
      r.obj.rotation.y += dt * 0.03 * (1 + (r.phase % 1));
    }
    let close = 0;
    for (const w of this.list) close = Math.max(close, 1 - Math.min(1, Math.hypot(w.x - focus.x, w.z - focus.z) / (w.reach * 2)));
    this.near1.value += (close - this.near1.value) * Math.min(1, dt);
  }
}

