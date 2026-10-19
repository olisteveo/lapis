import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraPosition, color, cos, dot, float, hash, mix, normalGeometry, positionLocal, saturate, sin, smoothstep,
  step, time, uniform, vec2, vec3, vertexColor, length,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FLORA, PALETTE, QUALITY, SKY } from '../config';
import { WORLD_HALF } from './heightfield';
import type { WorkerPool } from './terrain';
import type { FloraResult } from './terrainWorker';
import type { Colliders } from '../game/player';

interface TypeCfg {
  hi: number;
  far: number;
  sway: number;
}

// Per-type draw distances: big silhouettes travel far, undergrowth only exists near the player.
const TYPES: Record<string, TypeCfg> = {
  PalmTall: { hi: FLORA.hiRadius, far: FLORA.loadRadius, sway: 0.55 },
  PalmMid: { hi: FLORA.hiRadius, far: FLORA.loadRadius, sway: 0.5 },
  PalmLean: { hi: FLORA.hiRadius, far: 1200, sway: 0.45 },
  PalmYoung: { hi: FLORA.hiRadius, far: 500, sway: 0.35 },
  // Beyond ~700m the terrain's jungle shading and the fog carry the canopy on their own.
  CanopyA: { hi: 70, far: 480, sway: 0.25 },
  CanopyB: { hi: 70, far: 480, sway: 0.25 },
  Understory: { hi: 50, far: 220, sway: 0.2 },
  TreeFern: { hi: 50, far: 220, sway: 0.25 },
  Banana: { hi: 70, far: 220, sway: 0.3 },
  Vines: { hi: 70, far: 140, sway: 0.4 },
  FernA: { hi: 30, far: 90, sway: 0.15 },
  FernB: { hi: 30, far: 90, sway: 0.15 },
  Groundcover: { hi: 40, far: 90, sway: 0.1 },
  Bush0: { hi: 45, far: 170, sway: 0.1 },
  Bush1: { hi: 60, far: 300, sway: 0.1 },
};

// Trunk radius at scale 1. Ferns, bushes and ground cover stay soft so you can push through.
const TRUNKS: Record<string, number> = {
  PalmTall: 0.3, PalmMid: 0.3, PalmLean: 0.28, PalmYoung: 0.25,
  CanopyA: 1.3, CanopyB: 1.0, Understory: 0.3, TreeFern: 0.35, Banana: 0.45,
};

// Lower quality presets pull every draw radius in proportionally.
for (const cfg of Object.values(TYPES)) {
  cfg.hi *= QUALITY.flora;
  cfg.far *= QUALITY.flora;
}

const GLOW_PARTS = new Set(['trunk', 'frond', 'fruit', 'flower']);

interface Part {
  geometry: THREE.BufferGeometry;
  material: string;
}

class Batch {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private inst!: THREE.InstancedBufferAttribute;
  private scl!: THREE.InstancedBufferAttribute;

  constructor(part: Part, material: THREE.Material) {
    this.geo = new THREE.InstancedBufferGeometry();
    for (const [k, a] of Object.entries(part.geometry.attributes)) this.geo.setAttribute(k, a);
    this.geo.setIndex(part.geometry.index);
    this.ensure(256);
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
  }

  private ensure(n: number) {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, Math.ceil(this.capacity * 1.6));
    this.inst = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.scl = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    this.scl.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('inst', this.inst);
    this.geo.setAttribute('scl', this.scl);
  }

  /** packed = [x, y, z, rot, scale] * n */
  set(packed: Float32Array, n: number) {
    this.ensure(n);
    const ia = this.inst.array as Float32Array;
    const sa = this.scl.array as Float32Array;
    for (let i = 0; i < n; i++) {
      ia[i * 4] = packed[i * 5];
      ia[i * 4 + 1] = packed[i * 5 + 1];
      ia[i * 4 + 2] = packed[i * 5 + 2];
      ia[i * 4 + 3] = packed[i * 5 + 3];
      sa[i] = packed[i * 5 + 4];
    }
    this.inst.needsUpdate = true;
    this.scl.needsUpdate = true;
    this.geo.instanceCount = n;
  }
}

export class Flora implements Colliders {
  readonly group = new THREE.Group();
  /** Story hook: palms glow brighter as constellations are restored. */
  readonly glow = uniform(1);
  private parts = new Map<string, { hi: Part[]; lo: Part[] }>();
  private batches = new Map<string, { hi: Batch[]; lo: Batch[] }>();
  private blocks = new Map<string, { x: number; z: number; sets: Record<string, Float32Array> | null }>();
  private loDirty = false;
  private lastHi = new THREE.Vector3(1e9, 0, 1e9);
  private lastLo = new THREE.Vector3(1e9, 0, 1e9);
  private mirrorHidden: THREE.Mesh[] = [];
  private solids = new Float32Array(0);
  private clear = new Map<string, number[]>();
  private solidCount = 0;
  private lastLoBuild = 0;
  private scratch = new Float32Array(1 << 16);

  constructor(private pool: WorkerPool, private seed: number) {
    this.group.name = 'flora';
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const collect = (root: THREE.Object3D) => {
      const out: Part[] = [];
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const g = m.geometry.clone();
        // Bake any node transform below the asset root (glTF exports are usually identity here).
        const rel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(m.matrixWorld);
        g.applyMatrix4(rel);
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
        out.push({ geometry: g, material: mat.name || 'foliage' });
      });
      return out;
    };
    for (const child of gltf.scene.children) {
      const match = /^(.+)_(hi|lo)$/.exec(child.name);
      if (!match) continue;
      const [, type, lod] = match;
      if (!TYPES[type]) continue;
      const entry = this.parts.get(type) ?? { hi: [], lo: [] };
      entry[lod as 'hi' | 'lo'] = collect(child);
      this.parts.set(type, entry);
    }
    for (const [type, { hi, lo }] of this.parts) {
      const cfg = TYPES[type];
      const b = {
        hi: hi.map((p) => new Batch(p, this.material(p.material, cfg, 'hi'))),
        lo: (lo.length ? lo : hi).map((p) => new Batch(p, this.material(p.material, cfg, 'lo'))),
      };
      for (const x of [...b.hi, ...b.lo]) this.group.add(x.mesh);
      if (!type.startsWith('Palm')) this.mirrorHidden.push(...[...b.hi, ...b.lo].map((x) => x.mesh));
      this.batches.set(type, b);
    }
    return [...this.parts.keys()];
  }

  private material(partName: string, cfg: TypeCfg, lod: 'hi' | 'lo') {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const inst = attribute<'vec4'>('inst', 'vec4');
    const scl = attribute<'float'>('scl', 'float');
    const vc = vertexColor();
    const c = cos(inst.w);
    const s = sin(inst.w);
    const lp = positionLocal.mul(scl);
    const d = length(inst.xz.sub(cameraPosition.xz));
    const keep = lod === 'hi' ? step(d, float(cfg.hi)) : step(float(cfg.hi), d).mul(step(d, float(cfg.far)));

    // Vine strands are wood-tagged but hang free, so they sway along their whole length.
    const woodSway = partName === 'vine' ? 1 : 0.35;
    const swayW = vc.r.mul(vc.r).mul(vc.g.greaterThan(0.25).select(float(1), float(woodSway)));
    const gust = sin(time.mul(0.35).add(inst.x.mul(0.004)).add(inst.z.mul(0.003))).mul(0.4).add(0.8);
    const ph = vc.b.mul(6.283);
    const sway = vec2(
      sin(time.mul(1.15).add(inst.x.mul(0.07)).add(ph)),
      sin(time.mul(0.93).add(inst.z.mul(0.07)).add(ph).add(1.3)),
    ).mul(swayW).mul(gust).mul(cfg.sway).mul(scl);

    mat.positionNode = vec3(
      lp.x.mul(c).add(lp.z.mul(s)).add(sway.x),
      lp.y,
      lp.z.mul(c).sub(lp.x.mul(s)).add(sway.y),
    ).mul(keep).add(inst.xyz);

    const ng = normalGeometry;
    const n = vec3(ng.x.mul(c).add(ng.z.mul(s)), ng.y, ng.z.mul(c).sub(ng.x.mul(s)));
    const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);
    // Leaves are double-sided cards, so light them by |N.L| with a wrap term.
    const lambert = saturate(abs(dot(n, key)).mul(0.7).add(0.3));
    const variety = hash(inst.x.mul(0.37).add(inst.z.mul(1.91)));
    const fade = smoothstep(float(cfg.far), float(cfg.far * 0.85), d);

    let col;
    if (GLOW_PARTS.has(partName)) {
      // The palms drank the starlight: crowns glow coral, trunks warm to salmon toward the top.
      const tipRamp = vc.r;
      if (partName === 'trunk') col = mix(color(PALETTE.salmon).mul(0.12), color(PALETTE.coral).mul(0.55), tipRamp).mul(lambert.mul(0.3).add(0.7));
      else if (partName === 'fruit') col = color(PALETTE.coral).mul(0.35);
      // Banana flowers: small warm lanterns in the dark understory.
      else if (partName === 'flower') col = color(PALETTE.starGold).mul(1.4);
      else col = mix(color(PALETTE.coral), color(PALETTE.salmon), variety.mul(0.45)).mul(tipRamp.mul(0.55).add(0.5)).mul(lambert.mul(0.3).add(0.7)).mul(0.95);
      // Each palm breathes its light slowly, out of step with its neighbours.
      const breathe = sin(time.mul(0.45).add(inst.x.mul(0.013)).add(inst.z.mul(0.017))).mul(0.12).add(0.92);
      col = col.mul(this.glow).mul(variety.mul(0.35).add(0.8)).mul(breathe);
    } else {
      const dark = partName.includes('core') || partName.includes('bark') || partName === 'trunk_dark';
      const baseCol = mix(color(PALETTE.jungle), color(PALETTE.jungleLit), vc.r.mul(0.6).add(variety.mul(0.4)));
      // Keep foliage low and green: lit faces only lift a little, so the jungle reads as a
      // dark green mass (refs 2, 3) instead of frosted blue leaves.
      col = baseCol.mul(lambert.mul(0.45).add(0.22)).mul(dark ? 0.55 : 1);
      col = col.add(vec3(0.02, 0.05, 0.08).mul(saturate(n.y)).mul(0.25));
      if (partName === 'fern' || partName === 'leaf_broad') {
        // Faint starlight caught in the frond tips: lets you read the jungle floor in the dark.
        const tip = vc.r.mul(vc.r).mul(vc.r).mul(vc.g);
        const pulse = sin(time.mul(0.8).add(variety.mul(30))).mul(0.25).add(0.75);
        col = col.add(vec3(0.2, 0.6, 0.85).mul(tip).mul(pulse).mul(partName === 'fern' ? 1.1 : 0.35));
      }
    }
    mat.colorNode = col.mul(fade.mul(0.3).add(0.7));
    return mat;
  }

  /** In the water's reflection only the glowing palms matter; skip the jungle there. */
  setMirror(mirror: boolean) {
    for (const m of this.mirrorHidden) m.visible = !mirror;
  }

  update(focus: THREE.Vector3, now: number) {
    const B = FLORA.blockSize;
    const R = FLORA.loadRadius;
    const i0 = Math.floor((focus.x - R + WORLD_HALF) / B);
    const i1 = Math.floor((focus.x + R + WORLD_HALF) / B);
    const j0 = Math.floor((focus.z - R + WORLD_HALF) / B);
    const j1 = Math.floor((focus.z + R + WORLD_HALF) / B);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const key = `${i},${j}`;
        if (this.blocks.has(key)) continue;
        const x = -WORLD_HALF + i * B;
        const z = -WORLD_HALF + j * B;
        const dist = Math.hypot(x + B / 2 - focus.x, z + B / 2 - focus.z);
        if (dist > R) continue;
        const block = { x, z, sets: null as Record<string, Float32Array> | null };
        this.blocks.set(key, block);
        this.pool.run<FloraResult>({ kind: 'flora', seed: this.seed, x0: x, z0: z, size: B }, dist + 200).then((r) => {
          block.sets = r.sets;
          this.loDirty = true;
          if (dist < FLORA.hiRadius + B * 1.5) this.lastHi.set(1e9, 0, 1e9);
        });
      }
    for (const [key, b] of this.blocks) {
      if (Math.hypot(b.x + B / 2 - focus.x, b.z + B / 2 - focus.z) > R + 300) {
        this.blocks.delete(key);
        this.loDirty = true;
      }
    }

    if (focus.distanceToSquared(this.lastLo) > 900) this.loDirty = true;
    if (this.loDirty && now - this.lastLoBuild > 0.4) {
      this.lastLoBuild = now;
      this.lastLo.copy(focus);
      this.loDirty = false;
      this.rebuild(focus, 'lo');
    }
    if (focus.distanceToSquared(this.lastHi) > 64) {
      this.lastHi.copy(focus);
      this.rebuild(focus, 'hi');
    }
  }

  /** Keep plants out of these circles (landmarks). Bucketed by 64m cell for cheap lookups. */
  setClearings(circles: { x: number; z: number; r: number }[]) {
    this.clear.clear();
    for (const c of circles) {
      for (let j = Math.floor((c.z - c.r) / 64); j <= Math.floor((c.z + c.r) / 64); j++)
        for (let i = Math.floor((c.x - c.r) / 64); i <= Math.floor((c.x + c.r) / 64); i++) {
          const key = `${i},${j}`;
          const list = this.clear.get(key) ?? [];
          list.push(c.x, c.z, c.r);
          this.clear.set(key, list);
        }
    }
    this.lastHi.set(1e9, 0, 1e9);
    this.loDirty = true;
  }

  private cleared(x: number, z: number) {
    const list = this.clear.get(`${Math.floor(x / 64)},${Math.floor(z / 64)}`);
    if (!list) return false;
    for (let k = 0; k < list.length; k += 3) if (Math.hypot(list[k] - x, list[k + 1] - z) < list[k + 2]) return true;
    return false;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    const s = this.solids;
    for (let i = 0; i < this.solidCount; i++) {
      const cx = s[i * 3];
      const cz = s[i * 3 + 1];
      if (Math.abs(cx - x) < reach && Math.abs(cz - z) < reach) visit(cx, cz, s[i * 3 + 2]);
    }
  }

  private rebuildSolids(focus: THREE.Vector3) {
    const R = 40;
    const out: number[] = [];
    for (const b of this.blocks.values()) {
      if (!b.sets) continue;
      if (Math.abs(b.x + 64 - focus.x) > R + 64 || Math.abs(b.z + 64 - focus.z) > R + 64) continue;
      for (const [type, r] of Object.entries(TRUNKS)) {
        const set = b.sets[type];
        if (!set) continue;
        for (let k = 0; k < set.length; k += 5) {
          if (Math.abs(set[k] - focus.x) > R || Math.abs(set[k + 2] - focus.z) > R) continue;
          if (this.clear.size && this.cleared(set[k], set[k + 2])) continue;
          out.push(set[k], set[k + 2], r * set[k + 4]);
        }
      }
    }
    this.solids = new Float32Array(out);
    this.solidCount = out.length / 3;
  }

  private rebuild(focus: THREE.Vector3, lod: 'hi' | 'lo') {
    if (lod === 'hi') this.rebuildSolids(focus);
    const B = FLORA.blockSize;
    for (const [type, batches] of this.batches) {
      const cfg = TYPES[type];
      const radius = lod === 'hi' ? cfg.hi + 12 : cfg.far + B;
      let n = 0;
      for (const b of this.blocks.values()) {
        const set = b.sets?.[type];
        if (!set) continue;
        const bd = Math.hypot(Math.max(b.x - focus.x, 0, focus.x - b.x - B), Math.max(b.z - focus.z, 0, focus.z - b.z - B));
        if (bd > radius) continue;
        const inner = lod === 'lo' ? Math.max(0, cfg.hi - 40) : 0;
        for (let k = 0; k < set.length; k += 5) {
          const d = Math.hypot(set[k] - focus.x, set[k + 2] - focus.z);
          // Only submit what the shader can show: hi inside its radius, lo in its band.
          if (d > (lod === 'hi' ? radius : cfg.far + 20) || d < inner) continue;
          if (this.clear.size && this.cleared(set[k], set[k + 2])) continue;
          if ((n + 1) * 5 > this.scratch.length) {
            const grown = new Float32Array(this.scratch.length * 2);
            grown.set(this.scratch);
            this.scratch = grown;
          }
          this.scratch.set(set.subarray(k, k + 5), n * 5);
          n++;
        }
      }
      for (const batch of batches[lod]) batch.set(this.scratch, n);
    }
  }
}
