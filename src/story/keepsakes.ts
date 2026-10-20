import * as THREE from 'three/webgpu';
import { atan, color, cos, exp, float, length, mix, normalWorld, positionLocal, positionWorld, sin, time, uv, vec3, vec4, vertexColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { P } from '../core/placement';
import { mulberry32 } from '../core/heightfield';
import { PropCollision } from '../core/propCollision';
import { drawnSurface, penLines } from '../render/drawn';
import { gridFromObject } from '../world/propGrid';

export { KEEPSAKES, layoutKeepsakes, type KeepsakeDef, type KeepsakeId } from '../core/keepsakes';
import { KEEPSAKES, type KeepsakeId } from '../core/keepsakes';

type N = any;

/** Painted colour per material in keepsakes.glb (tools/blender/keepsakes.py). */
const TINT: Record<string, number> = {
  ks_stone: 0x5b6890, ks_wood: 0x6b5450, ks_sand: 0xa898bc, ks_iron: 0x2a2e48, ks_rope: 0x8a7a68,
  ks_shell: 0xe8909f, ks_paper: 0xffb46a, ks_wing: 0xbab2de, ks_brass: 0xd8a85a, ks_ribbon: 0xff8fa8, ks_glow: 0x9ff0e0, ks_dial: 0xe6d8b8,
};
/** Parts that give off their own light: the lantern's paper, the compass face, the eye-spots on the wings. */
const GLOWS: Record<string, number> = { ks_paper: 0.9, ks_glow: 0.75 };
/** The lantern's axis sits this far along x from its setting's origin (keepsakes.py, build_lantern). */
const LANTERN_AXIS = 0.62;

/** Drawn shading for keepsake models; item = the keepsake itself (it catches the light a little). */
export function keepsakeMaterial(name: string, item: boolean, tint: number, lanternAxis = LANTERN_AXIS) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const vc = vertexColor();
  const base = color(TINT[name] ?? 0x34405e);
  const pulse = sin(time.mul(1.7)).mul(0.25).add(0.85);
  let col: N;
  if (name === 'ks_paper') {
    // Lit from within: warmest round its middle, with the bamboo ribs inked dark against the glow.
    const lp = positionLocal as N;
    const ang = atan(lp.z, lp.x.sub(lanternAxis));
    const ribs = penLines(ang.mul(12 / (Math.PI * 2)), 1.6);
    const belly = sin(vc.r.mul(Math.PI)).mul(0.5).add(0.5);
    col = mix(base.mul(GLOWS[name]).mul(belly).mul(pulse), color(0x5a2a10), ribs.mul(0.75));
  } else if (GLOWS[name]) {
    col = base.mul(GLOWS[name]).mul(vc.r.mul(0.3).add(0.8)).mul(pulse);
  } else {
    col = drawnSurface(base.mul(vc.b.mul(0.15).add(0.85)), normalWorld, positionWorld, { spacing: 0.35 });
    // Her things catch the moonlight more than the world around them, so they can be found.
    if (item) col = col.add(color(tint).mul(0.12).mul(pulse));
  }
  mat.colorNode = col;
  // Paper wings and ribbon tails stir in the breeze, more toward their free ends.
  const cloth = vc.g.greaterThan(0.9).select(float(1), float(0)).mul(vc.r);
  const ph = vc.b.mul(6.283);
  mat.positionNode = positionLocal.add(vec3(sin(time.mul(2.6).add(ph)), sin(time.mul(1.9).add(ph)).mul(0.4), cos(time.mul(2.1).add(ph))).mul(cloth.mul(0.035)));
  return mat;
}

/** Swaps a keepsake model's placeholder materials for drawn ones. */
export function dressKeepsake(o: THREE.Object3D, item: boolean, tint: number, lanternAxis = LANTERN_AXIS) {
  const cache = new Map<string, THREE.Material>();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    const name = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material).name;
    if (!cache.has(name)) cache.set(name, keepsakeMaterial(name, item, tint, lanternAxis));
    m.material = cache.get(name)!;
  });
}

/**
 * The keepsakes lying in the world, each in its own small setting: the seashell on a wet rock shelf
 * behind the falls, the moth wings tied to a staff on the meadow peak, the paper lantern hung from a
 * crook in the Lantern Wood, the compass on a half-buried chest in the dunes, the ribbon round a
 * drowned post. The settings stay once their keepsake is taken.
 */
export class Keepsakes {
  readonly group = new THREE.Group();
  /** The settings as solids to stand on and walk round. */
  readonly solids = new PropCollision();
  private items = new Map<KeepsakeId, { obj: THREE.Object3D; pos: THREE.Vector3 }>();

  constructor(
    private spots: Record<KeepsakeId, P>,
    private height: (x: number, z: number) => number,
    private owned: (id: KeepsakeId) => boolean,
  ) {
    this.group.name = 'keepsakes';
  }

  /** A soft halo and a slow ring of motes round the keepsake, so it reads as something special. */
  private halo(tint: number) {
    const g = new THREE.Group();
    const r = length(uv().sub(0.5)).mul(2);
    const pulse = sin(time.mul(1.7)).mul(0.2).add(1);
    const glowMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    glowMat.colorNode = vec4(color(tint).mul(exp(r.mul(-4)).mul(0.16)).mul(pulse), 1);
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(1.6);
    g.add(glow);
    const ringMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    ringMat.colorNode = vec4(mix(color(tint), color(0xffffff), 0.3).mul(exp(r.mul(-7)).mul(1.4)), 1);
    for (let k = 0; k < 6; k++) {
      const m = new THREE.Sprite(ringMat);
      m.scale.setScalar(0.16);
      m.userData.k = k;
      g.add(m);
    }
    return g;
  }

  /** The loaded models, kept for the first-person held versions (Held_<id>). */
  templates: THREE.Object3D | null = null;

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.templates = gltf.scene;
    gltf.scene.updateMatrixWorld(true);
    const rnd = mulberry32(4242);
    for (const def of KEEPSAKES) {
      const s = this.spots[def.id];
      const y = Math.max(this.height(s.x, s.z), -0.4);
      const yaw = rnd() * Math.PI * 2;
      const place = (o: THREE.Object3D) => {
        o.position.set(s.x, y, s.z);
        o.rotation.set(0, yaw, 0);
        o.updateMatrixWorld(true);
      };
      const setting = gltf.scene.getObjectByName(`Setting_${def.id}`);
      if (setting) {
        this.solids.add(gridFromObject(setting), { x: s.x, y, z: s.z, yaw, scale: 1 });
        const obj = setting.clone(true);
        dressKeepsake(obj, false, def.tint);
        place(obj);
        this.group.add(obj);
      }
      const keepsake = gltf.scene.getObjectByName(`Keepsake_${def.id}`);
      if (!keepsake || this.owned(def.id)) continue;
      const obj = new THREE.Group();
      const model = keepsake.clone(true);
      dressKeepsake(model, true, def.tint);
      obj.add(model);
      place(obj);
      const pos = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
      const halo = this.halo(def.tint);
      halo.position.copy(obj.worldToLocal(pos.clone()));
      halo.userData.halo = true;
      obj.add(halo);
      this.group.add(obj);
      this.items.set(def.id, { obj, pos });
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
    for (const it of this.items.values()) {
      const halo = it.obj.children.find((c) => c.userData.halo);
      if (!halo) continue;
      for (const c of halo.children)
        if (c.userData.k !== undefined) {
          const a = t * 0.8 + (c.userData.k / 6) * Math.PI * 2;
          c.position.set(Math.cos(a) * 0.55, Math.sin(t * 1.3 + c.userData.k) * 0.12, Math.sin(a) * 0.55);
        }
    }
  }
}
