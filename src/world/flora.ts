import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, color, cos, dot, float, mix, normalGeometry, normalize, positionLocal, saturate, sin, smoothstep, step, time, uniform, vec2, vec3, vertexColor, length, varying, atan, floor } from 'three/tsl';
import { hash } from '../render/seed';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FLORA, PALETTE, QUALITY, SKY, onQualityChange } from '../config';
import { drawnSurface, penLines } from '../render/drawn';
import { WORLD_HALF } from '../core/heightfield';
import type { WorkerPool } from './terrain';
import type { FloraResult } from './terrainWorker';
import type { Colliders } from '../core/player';

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
  // Lantern Wood
  GiantMushroomA: { hi: 90, far: 900, sway: 0.04 },
  GiantMushroomB: { hi: 90, far: 900, sway: 0.04 },
  LanternTree: { hi: 80, far: 600, sway: 0.15 },
  MushroomCluster: { hi: 40, far: 90, sway: 0 },
  // Moonflower Meadows
  Moonflowers: { hi: 45, far: 170, sway: 0.22 },
  MeadowGrass: { hi: 35, far: 95, sway: 0.4 },
  // Glass Dunes
  CrystalA: { hi: 60, far: 700, sway: 0 },
  CrystalB: { hi: 60, far: 700, sway: 0 },
  DuneGrass: { hi: 35, far: 110, sway: 0.3 },
};

// Trunk radius at scale 1. Ferns, bushes and ground cover stay soft so you can push through.
const TRUNKS: Record<string, number> = {
  PalmTall: 0.3, PalmMid: 0.3, PalmLean: 0.28, PalmYoung: 0.25,
  CanopyA: 1.3, CanopyB: 1.0, Understory: 0.3, TreeFern: 0.35, Banana: 0.45,
  GiantMushroomA: 0.7, GiantMushroomB: 0.7, LanternTree: 0.45, CrystalA: 0.6, CrystalB: 0.6,
};

// Soft plants you walk through: they part around you instead of stopping you.
// Plants that carry flowers on their outer leaves.
const FLOWERING = new Set(['Bush0', 'Bush1', 'Groundcover', 'Understory', 'Banana']);
const SOFT = new Set(['FernA', 'FernB', 'Groundcover', 'Bush0', 'Bush1', 'Moonflowers', 'MeadowGrass', 'DuneGrass', 'Vines']);

// Base radii; the live ones (and the shader uniforms) scale with the quality preset.
const BASE = Object.fromEntries(Object.entries(TYPES).map(([k, c]) => [k, { hi: c.hi, far: c.far }]));
const RADII = Object.fromEntries(Object.keys(TYPES).map((k) => [k, { hi: uniform(0), far: uniform(0) }]));
function applyRadii() {
  for (const [k, cfg] of Object.entries(TYPES)) {
    cfg.hi = BASE[k].hi * QUALITY.flora;
    cfg.far = BASE[k].far * QUALITY.flora;
    RADII[k].hi.value = cfg.hi;
    RADII[k].far.value = cfg.far;
  }
}
applyRadii();

// Plants whose light can be drawn into the lantern (docs/SURVIVAL.md).
const GLOWING = ['GiantMushroomA', 'GiantMushroomB', 'MushroomCluster', 'LanternTree', 'Moonflowers', 'CrystalA', 'CrystalB'];
const GLOW_PARTS = new Set(['trunk', 'frond', 'fruit', 'flower']);
// Each region glows in its own colour: teal spores, gold lanterns, pale petals, icy crystal.
const REGION_GLOW: Record<string, [number, number]> = {
  // Shared by hundreds of small caps: kept modest, or their bloom floods the whole frame.
  mushroom_glow: [0x5fe8d8, 0.7],
  lantern_glow: [0xffc070, 1.8],
  moonflower_glow: [0xece0ff, 1.6],
  crystal: [0xc6b6ff, 0.75],
};
const REGION_BASE: Record<string, number> = {
  mushroom_cap: 0x3a2a72,
  mushroom_stem: 0x8a86b8,
  grass: 0x3a6a60,
};

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
    this.mesh.visible = false;
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
    // An empty batch still costs a draw call.
    this.mesh.visible = n > 0;
  }
}

export class Flora implements Colliders {
  readonly group = new THREE.Group();
  /** Story hook: palms glow brighter as constellations are restored. */
  readonly glow = uniform(1);
  /** Where the walker is, so soft plants part around them. */
  readonly walker = uniform(new THREE.Vector3(1e6, 0, 1e6));
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
    onQualityChange(() => {
      applyRadii();
      this.lastHi.set(1e9, 0, 1e9);
      this.loDirty = true;
    });
  }

  /** Loads one or more flora files; missing optional files are skipped. */
  async load(...urls: string[]) {
    const loader = new GLTFLoader();
    const scenes = await Promise.all(urls.map((u) => loader.loadAsync(u).then((g) => g.scene).catch(() => null)));
    for (const scene of scenes) if (scene) this.collectTypes(scene);
    this.buildBatches();
    return [...this.parts.keys()];
  }

  private collectTypes(scene: THREE.Object3D) {
    scene.updateMatrixWorld(true);
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
    for (const child of scene.children) {
      const match = /^(.+)_(hi|lo)$/.exec(child.name);
      if (!match) continue;
      const [, type, lod] = match;
      if (!TYPES[type]) continue;
      const entry = this.parts.get(type) ?? { hi: [], lo: [] };
      entry[lod as 'hi' | 'lo'] = collect(child);
      this.parts.set(type, entry);
    }
  }

  private buildBatches() {
    for (const [type, { hi, lo }] of this.parts) {
      const cfg = TYPES[type];
      const b = {
        hi: hi.map((p) => new Batch(p, this.material(p.material, cfg, 'hi', type))),
        lo: (lo.length ? lo : hi).map((p) => new Batch(p, this.material(p.material, cfg, 'lo', type))),
      };
      for (const x of [...b.hi, ...b.lo]) this.group.add(x.mesh);
      if (!type.startsWith('Palm')) this.mirrorHidden.push(...[...b.hi, ...b.lo].map((x) => x.mesh));
      this.batches.set(type, b);
    }
  }

  private material(partName: string, cfg: TypeCfg, lod: 'hi' | 'lo', type: string) {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const inst = attribute<'vec4'>('inst', 'vec4');
    const scl = attribute<'float'>('scl', 'float');
    const vc = vertexColor();
    const c = cos(inst.w);
    const s = sin(inst.w);
    const lp = positionLocal.mul(scl);
    const d = length(inst.xz.sub(cameraPosition.xz));
    const R = RADII[type];
    const keep = lod === 'hi' ? step(d, R.hi) : step(R.hi, d).mul(step(d, R.far));

    // Vine strands are wood-tagged but hang free, so they sway along their whole length.
    const woodSway = partName === 'vine' ? 1 : 0.35;
    const swayW = vc.r.mul(vc.r).mul(vc.g.greaterThan(0.25).select(float(1), float(woodSway)));
    const gust = sin(time.mul(0.35).add(inst.x.mul(0.004)).add(inst.z.mul(0.003))).mul(0.4).add(0.8);
    const ph = vc.b.mul(6.283);
    const sway = vec2(
      sin(time.mul(1.15).add(inst.x.mul(0.07)).add(ph)),
      sin(time.mul(0.93).add(inst.z.mul(0.07)).add(ph).add(1.3)),
    ).mul(swayW).mul(gust).mul(cfg.sway).mul(scl);

    let world: any = vec3(
      lp.x.mul(c).add(lp.z.mul(s)).add(sway.x),
      lp.y,
      lp.z.mul(c).sub(lp.x.mul(s)).add(sway.y),
    ).mul(keep).add(inst.xyz);
    if (SOFT.has(type)) {
      // Brushing through: leaves within reach of the walker lean away, roots stay put, and only
      // what is at body height moves (vines overhead and grass underfoot alike).
      const away = world.xz.sub(this.walker.xz);
      const near = smoothstep(1.4, 0.25, length(away));
      const rooted = smoothstep(0.0, 0.5, lp.y);
      const reach = smoothstep(2.3, 1.7, world.y.sub(this.walker.y)).mul(smoothstep(-0.6, -0.1, world.y.sub(this.walker.y)));
      const bend = away.normalize().mul(near.mul(rooted).mul(reach).mul(0.55));
      world = world.add(vec3(bend.x, near.mul(rooted).mul(reach).mul(-0.12), bend.y));
    }
    mat.positionNode = world;
    const wp: any = varying(world);

    const ng = normalGeometry;
    const n = vec3(ng.x.mul(c).add(ng.z.mul(s)), ng.y, ng.z.mul(c).sub(ng.x.mul(s)));
    const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);
    // Leaves are double-sided cards, so light them by |N.L| with a wrap term.
    const lambert = saturate(abs(dot(n, key)).mul(0.7).add(0.3));
    const variety = hash(inst.x.mul(0.37).add(inst.z.mul(1.91)));
    const fade = smoothstep(R.far, R.far.mul(0.85), d);

    let col;
    // Light that sits on top of the drawn shading rather than under its ink.
    let emit: any = null;
    if (REGION_GLOW[partName]) {
      const [hex, k] = REGION_GLOW[partName];
      const breathe = sin(time.mul(0.7).add(variety.mul(20))).mul(0.15).add(0.9);
      col = color(hex).mul(k).mul(vc.r.mul(0.4).add(0.7)).mul(breathe);
      if (partName === 'mushroom_glow') {
        // Gills drawn as fine radial ink lines; the light gathers at the rim and dies toward the stem.
        const rel = wp.xz.sub(inst.xz);
        const r = length(rel);
        const ang = atan(rel.y, rel.x);
        const gills = penLines(ang.div(Math.PI * 2).mul(44), 2.4).mul(smoothstep(0.4, 1.2, r));
        const rim = smoothstep(0.6, 4.5, r);
        const mottle = hash(floor(ang.mul(9)).add(variety.mul(13))).mul(0.3).add(0.75);
        // Keep the inner gills below the bloom threshold (a big evenly bright surface blooms over
        // its own lines); only the rim burns bright.
        col = mix(col.mul(rim.mul(rim).mul(1.1).add(0.12)).mul(mottle), color(0x0b1030), gills.mul(0.85));
      } else if (partName === 'crystal') {
        // Light climbs the crystals in slow bands, and facets flash white as they turn to face you.
        const view = normalize(cameraPosition.sub(wp));
        const band = smoothstep(0.7, 1.0, sin(wp.y.mul(1.4).sub(time.mul(1.6)).add(variety.mul(12)))).mul(0.6);
        const facet = smoothstep(0.88, 0.99, abs(dot(n, view)));
        emit = color(0xd8ccff).mul(band).add(color(0xffffff).mul(facet).mul(1.6));
      } else if (partName === 'moonflower_glow') {
        // Each bloom shimmers faintly out of step with the rest, like breath on a cold night.
        const shimmer = sin(time.mul(3.1).add(variety.mul(50))).mul(sin(time.mul(1.7).add(variety.mul(23)))).mul(0.25).add(1);
        col = col.mul(shimmer);
      }
    } else if (REGION_BASE[partName] !== undefined) {
      col = color(REGION_BASE[partName]).mul(lambert.mul(0.6).add(0.3)).mul(variety.mul(0.25).add(0.85));
      if (partName === 'mushroom_cap') {
        // Bioluminescent caps: freckled with cold glowing spots that each twinkle on their own
        // clock, and a translucent rim where the light inside shows through at grazing angles.
        const p = varying(positionLocal).mul(1.1);
        const cell = floor(p);
        const h = (o: number) => hash(cell.x.mul(127.1).add(cell.y.mul(311.7)).add(cell.z.mul(74.7)).add(variety.mul(91)).add(o));
        const centre = cell.add(vec3(h(0), h(1), h(2)).mul(0.5).add(0.25));
        const spot = smoothstep(0.3, 0.1, length(p.sub(centre))).mul(step(0.3, h(3)));
        const twinkle = sin(time.mul(h(4).mul(1.6).add(0.6)).add(h(5).mul(40))).mul(0.4).add(0.7);
        const view = normalize(cameraPosition.sub(wp));
        const rim = smoothstep(0.55, 0.0, abs(dot(n, view)));
        emit = color(0x3fd8e0).mul(rim).mul(0.6).add(color(0xc8fbff).mul(spot).mul(twinkle).mul(4));
      }
    } else if (GLOW_PARTS.has(partName)) {
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
      // Not one green: each plant takes a hue from a small palette, grouped into patches across the
      // ground so colours drift naturally (dark and light greens mostly, then brown, plum, maroon).
      const patch = hash(floor(inst.x.div(22)).mul(41.3).add(floor(inst.z.div(22)).mul(17.9)));
      const pick = variety.mul(0.55).add(patch.mul(0.65)).fract();
      let hue: any = color(0x163a2c);
      hue = mix(hue, color(0x3f7a4a), step(0.34, pick));
      hue = mix(hue, color(0x5b4a2a), step(0.58, pick));
      hue = mix(hue, color(0x4a2f66), step(0.73, pick));
      hue = mix(hue, color(0x5e2233), step(0.87, pick));
      const baseCol = mix(hue.mul(0.75), hue.mul(1.2), vc.r.mul(0.6).add(variety.mul(0.4)));
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
      if (FLOWERING.has(type) && !dark) {
        // Blossoms freckling the outer leaves of most bushes and low plants, one colour per plant.
        const q = varying(positionLocal).mul(2.6);
        const cell = floor(q);
        const h = (o: number) => hash(cell.x.mul(91.7).add(cell.y.mul(213.1)).add(cell.z.mul(57.3)).add(variety.mul(77)).add(o));
        const centre = cell.add(vec3(h(0), h(1), h(2)).mul(0.5).add(0.25));
        const bloom = smoothstep(0.3, 0.14, length(q.sub(centre))).mul(step(0.55, h(3))).mul(step(0.3, variety)).mul(smoothstep(0.15, 0.5, vc.r));
        const tint = hash(inst.x.mul(3.1).add(inst.z.mul(7.7)));
        let petal: any = color(0xff8fb8);
        petal = mix(petal, color(0xffd36a), step(0.3, tint));
        petal = mix(petal, color(0xf4eefe), step(0.5, tint));
        petal = mix(petal, color(0xe2424e), step(0.7, tint));
        petal = mix(petal, color(0xc39bff), step(0.85, tint));
        // A touch brighter than the leaves so they read in the night, but well below a glow.
        col = mix(col, petal.mul(lambert.mul(0.4).add(0.95)), bloom);
      }
    }
    // Trunks, bark and mushroom flesh are drawn: flat tones and vertical pen strokes on the
    // shadow side, anchored in the world so they don't swim. Leaves stay painted.
    const drawn = partName === 'trunk' || partName.includes('bark') || partName.includes('core') || partName.startsWith('mushroom_') && !partName.includes('glow');
    if (drawn) col = drawnSurface(col, n, wp);
    if (emit) col = col.add(emit);
    mat.colorNode = col.mul(fade.mul(0.3).add(0.7));
    return mat;
  }

  /** In the water's reflection only the glowing palms matter; skip the jungle there. */
  setMirror(mirror: boolean) {
    for (const m of this.mirrorHidden) m.visible = !mirror && (m.geometry as THREE.InstancedBufferGeometry).instanceCount > 0;
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

  /** Is a walker at (x, z), feet at y, brushing through a fern, bush, grass or flowers? */
  softAt(x: number, z: number, y: number) {
    const B = FLORA.blockSize;
    const b = this.blocks.get(`${Math.floor((x + WORLD_HALF) / B)},${Math.floor((z + WORLD_HALF) / B)}`);
    if (!b?.sets) return false;
    for (const type of SOFT) {
      const set = b.sets[type];
      if (!set) continue;
      for (let k = 0; k < set.length; k += 5) {
        const r = 0.9 * Math.max(0.6, set[k + 4]);
        if (Math.abs(set[k] - x) < r && Math.abs(set[k + 2] - z) < r && Math.abs(set[k + 1] - y) < 1.2) return true;
      }
    }
    return false;
  }

  /** How many glowing plants (mushrooms, lantern trees, moonflowers, crystals) stand within r of (x, z). */
  glowNear(x: number, z: number, r: number) {
    const B = FLORA.blockSize;
    let n = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const b = this.blocks.get(`${Math.floor((x + WORLD_HALF) / B) + di},${Math.floor((z + WORLD_HALF) / B) + dj}`);
        if (!b?.sets) continue;
        for (const type of GLOWING) {
          const set = b.sets[type];
          if (!set) continue;
          for (let k = 0; k < set.length; k += 5) if (Math.hypot(set[k] - x, set[k + 2] - z) < r + set[k + 4]) n++;
        }
      }
    return n;
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
