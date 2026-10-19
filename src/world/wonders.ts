import * as THREE from 'three/webgpu';
import { color, dot, float, normalWorld, saturate, sin, time, uniform, vec3, positionLocal } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, SKY } from '../config';
import { BIOMES, WORLD_HALF, type Heightfield } from './heightfield';
import type { Colliders } from '../game/player';

type N = any;

export interface Wonder {
  id: string;
  name: string;
  /** What the little light says when you find it. */
  line: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Footprint for collision and flora clearing. */
  r: number;
  /** How close you must come to have found it. */
  reach: number;
}

/** One wonder per region: the reason to go somewhere new. Deterministic from the heightfield. */
export function layoutWonders(hf: Heightfield): Wonder[] {
  const slope = (x: number, z: number) =>
    Math.abs(hf.height(x + 3, z) - hf.height(x - 3, z)) + Math.abs(hf.height(x, z + 3) - hf.height(x, z - 3));
  // The flattest dry spot near a centre, searched on a spiral.
  const settle = (cx: number, cz: number, radius: number, minH = 0.8) => {
    let best = { x: cx, z: cz, score: Infinity };
    for (let i = 0; i < 400; i++) {
      const a = i * 2.39996;
      const d = Math.sqrt(i / 400) * radius;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const h = hf.height(x, z);
      if (h < minH) continue;
      const score = slope(x, z) + d * 0.004;
      if (score < best.score) best = { x, z, score };
    }
    return best;
  };
  const out: Wonder[] = [];
  const M = settle(BIOMES.meadow.x, BIOMES.meadow.z, 500);
  out.push({ id: 'moontree', name: 'The Moon Tree', line: 'Oh! A tree made of moonlight. It hums when you get close!', x: M.x, y: hf.height(M.x, M.z), z: M.z, yaw: 0.4, scale: 1, r: 3, reach: 30 });
  const L = settle(BIOMES.lantern.x, BIOMES.lantern.z, 500);
  out.push({ id: 'ring', name: 'The Mushroom Ring', line: 'Oh! A fairy ring. Something danced here once...', x: L.x, y: hf.height(L.x, L.z), z: L.z, yaw: 0, scale: 1, r: 0, reach: 20 });
  const W = settle(BIOMES.dunes.x, BIOMES.dunes.z, 450);
  out.push({ id: 'whale', name: 'The Sleeping Whale', line: 'Oh! The bones of a whale. Was the sea up here once?', x: W.x, y: hf.height(W.x, W.z) - 0.6, z: W.z, yaw: 1.1, scale: 1, r: 0, reach: 35 });
  // The bell tower stands in the drowned square itself, up to its knees in the sea.
  const D = BIOMES.drowned;
  out.push({ id: 'bell', name: 'The Drowned Bell', line: 'Listen! A bell under the water. It still rings for someone.', x: D.x, y: Math.min(hf.height(D.x, D.z), -0.4), z: D.z, yaw: 0.35, scale: 1, r: 3.2, reach: 40 });
  // The floating rocks hang over the highest open ground on the island.
  let hi = { x: 0, z: 0, h: -Infinity };
  for (let gz = -WORLD_HALF * 0.8; gz < WORLD_HALF * 0.8; gz += 64)
    for (let gx = -WORLD_HALF * 0.8; gx < WORLD_HALF * 0.8; gx += 64) {
      const s = hf.sample(gx, gz);
      if (s.meadow + s.lantern + s.dunes > 0.3) continue;
      if (s.height > hi.h) hi = { x: gx, z: gz, h: s.height };
    }
  out.push({ id: 'rocks', name: 'The Sky Stones', line: 'Look up! The stones are floating! How are they doing that?', x: hi.x, y: hi.h + 22, z: hi.z, yaw: 0, scale: 1.4, r: 0, reach: 60 });
  return out;
}

const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);

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
    const lambert = saturate(dot(normalWorld, key).mul(0.55).add(0.45));
    if (name.includes('glow') || name.includes('light')) {
      const tint = wonder === 'moontree' ? 0xbfe4ff : wonder === 'ring' ? 0xc6a0ff : wonder === 'bell' ? 0x8ff0e6 : PALETTE.starGold;
      // Glows breathe, and brighten as you come close.
      const breathe = sin(time.mul(1.3).add(positionLocal.y.mul(0.6) as N)).mul(0.2).add(0.9);
      mat.colorNode = color(tint).mul(float(wonder === 'ring' ? 0.7 : 1.1).add(this.near1.mul(0.5))).mul(breathe);
      return mat;
    }
    const tint = color(BASE[Object.keys(BASE).find((k) => name.includes(k)) ?? ''] ?? 0x5b6890);
    mat.colorNode = tint.mul(lambert).add(vec3(0.07, 0.09, 0.2).mul(saturate(normalWorld.y).mul(0.6)));
    return mat;
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const pick: Record<string, string> = { moontree: 'MoonTree', ring: 'MushroomRing', whale: 'WhaleSkeleton', bell: 'BellTower', rocks: 'FloatingRocks' };
    for (const w of this.list) {
      const t = gltf.scene.getObjectByName(pick[w.id]);
      if (!t) continue;
      const obj = t.clone(true);
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
    for (const w of this.list) if (w.r > 0 && Math.abs(w.x - x) < reach + w.r && Math.abs(w.z - z) < reach + w.r) visit(w.x, w.z, w.r * w.scale);
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

