import * as THREE from 'three/webgpu';
import { color, float, length, mix, positionLocal, positionWorld, sin, smoothstep, time, uniform, uv, vertexColor, normalWorld, saturate, vec3 } from 'three/tsl';
import { hash } from '../render/seed';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE } from '../config';
import { drawnSurface } from '../render/drawn';
import { interiorShade, masonry } from '../render/lighthouseShading';
import { BIOMES, LIGHTHOUSE, WORLD_HALF, type Heightfield } from '../core/heightfield';
import type { Colliders } from '../core/player';
import { PropCollision, type ColumnGrid } from '../core/propCollision';
import { gridFromObject } from './propGrid';

export interface Placed {
  type: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rand(i: number, k: number) {
  let h = Math.imul(i + 1, 374761393) ^ Math.imul(k + 7, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Direction (unit xz) from a shore point toward deeper water, or null if not near a shore. */
function seaward(hf: Heightfield, x: number, z: number, r = 40) {
  let best: { x: number; z: number } | null = null;
  let low = Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const v = hf.height(x + Math.sin(a) * r, z + Math.cos(a) * r);
    if (v < low) {
      low = v;
      best = { x: Math.sin(a), z: Math.cos(a) };
    }
  }
  return low < -0.6 ? best : null;
}

/**
 * Deterministic landmark layout for the whole world. Coastal pieces sit where gentle beaches
 * meet water; inland pieces follow the jungle; the lighthouse stands on its lake islet.
 */
export function layoutLandmarks(hf: Heightfield, spawn: { x: number; z: number }): Placed[] {
  const out: Placed[] = [];
  const h = (x: number, z: number) => hf.height(x, z);
  const slope = (x: number, z: number) => Math.abs(h(x + 2, z) - h(x - 2, z)) + Math.abs(h(x, z + 2) - h(x, z - 2));
  const far = (x: number, z: number, d: number) => out.every((p) => Math.hypot(p.x - x, p.z - z) > d);

  out.push({ type: 'Lighthouse', x: LIGHTHOUSE.x, y: h(LIGHTHOUSE.x, LIGHTHOUSE.z) - 0.1, z: LIGHTHOUSE.z, yaw: 0.6, scale: 1 });

  // Coastal candidates on a jittered grid; spawn's own coast gets denser coverage.
  const coast: { x: number; z: number; sea: { x: number; z: number } }[] = [];
  for (let gz = -WORLD_HALF * 0.85; gz < WORLD_HALF * 0.85; gz += 60)
    for (let gx = -WORLD_HALF * 0.85; gx < WORLD_HALF * 0.85; gx += 60) {
      const i = Math.round(gx * 7 + gz * 13);
      const x = gx + (rand(i, 1) - 0.5) * 55;
      const z = gz + (rand(i, 2) - 0.5) * 55;
      const v = h(x, z);
      if (v < 0.4 || v > 2.4 || slope(x, z) > 0.8) continue;
      const sea = seaward(hf, x, z);
      if (sea) coast.push({ x, z, sea });
    }
  coast.sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z));

  // Beacons: small harbour lighthouses on the coast, the places you save and rest. One within
  // reach of where you wake, then one roughly every kilometre along the shore.
  const bands: [number, number][] = [[200, 480], [850, 1400], [1700, 2500], [2700, 3600]];
  for (const [lo, hi] of bands) {
    const c = coast.find((c) => {
      const d = Math.hypot(c.x - spawn.x, c.z - spawn.z);
      return d >= lo && d <= hi && far(c.x, c.z, 300);
    });
    if (!c) continue;
    const x = c.x - c.sea.x * 7;
    const z = c.z - c.sea.z * 7;
    out.push({ type: 'Beacon', x, y: h(x, z) - 0.3, z, yaw: Math.atan2(c.sea.z, c.sea.x), scale: 1 });
  }

  // One lighthouse in the heart of each region, so every constellation has a light to carry stars to.
  for (const B of [BIOMES.meadow, BIOMES.lantern, BIOMES.dunes, { ...BIOMES.drowned, r: 520 }]) {
    let best: { x: number; z: number; s: number } | null = null;
    for (let k = 0; k < 500; k++) {
      const a = k * 2.39996;
      const d = Math.sqrt(k / 500) * B.r * 0.7 + 60;
      const x = B.x + Math.cos(a) * d;
      const z = B.z + Math.sin(a) * d;
      const v = h(x, z);
      if (v < 0.8 || !out.filter((p) => p.type === 'Beacon').every((p) => Math.hypot(p.x - x, p.z - z) > 500)) continue;
      const s = slope(x, z) + d * 0.002;
      if (!best || s < best.s) best = { x, z, s };
    }
    if (best) out.push({ type: 'Beacon', x: best.x, y: h(best.x, best.z) - 0.2, z: best.z, yaw: rand(Math.round(best.x), 9) * 6.28, scale: 1 });
  }

  const quotas: [string, number, number][] = [
    ['Jetty', 9, 420],
    ['Wreck', 6, 600],
    ['Hut', 6, 500],
    ['Swing', 3, 700],
  ];
  // The first of each sits within reach of the opening beach; the rest spread out.
  for (const [type, count, spacing] of quotas) {
    let placed = 0;
    for (const c of coast) {
      if (placed >= count) break;
      const d0 = Math.hypot(c.x - spawn.x, c.z - spawn.z);
      if (placed === 0 && (d0 < 60 || d0 > 450)) continue;
      if (!far(c.x, c.z, placed === 0 ? 40 : spacing)) continue;
      const yaw = Math.atan2(c.sea.z, c.sea.x);
      // The deck's shore end is 1.2 m up the model: sunk so it meets the sand as a single step.
      if (type === 'Jetty') out.push({ type, x: c.x, y: h(c.x, c.z) - 0.8, z: c.z, yaw: -yaw, scale: 1 });
      else if (type === 'Wreck') {
        const x = c.x + c.sea.x * 8;
        const z = c.z + c.sea.z * 8;
        out.push({ type, x, y: h(x, z) - 0.5, z, yaw: -yaw + rand(placed, 3), scale: 1 });
      } else if (type === 'Hut') {
        const x = c.x - c.sea.x * 14;
        const z = c.z - c.sea.z * 14;
        if (slope(x, z) > 1.2 || h(x, z) < 0.6) continue;
        out.push({ type, x, y: h(x, z), z, yaw: -yaw + Math.PI / 2, scale: 1 });
      } else {
        const x = c.x - c.sea.x * 9;
        const z = c.z - c.sea.z * 9;
        out.push({ type, x, y: h(x, z), z, yaw: -yaw, scale: 1 });
      }
      placed++;
    }
  }

  // Cairns on beaches and high open ground; lanterns along the jungle.
  for (let k = 0; k < 4000 && out.filter((p) => p.type === 'Cairn').length < 40; k++) {
    const x = (rand(k, 11) - 0.5) * WORLD_HALF * 1.6;
    const z = (rand(k, 12) - 0.5) * WORLD_HALF * 1.6;
    const s = hf.sample(x, z);
    if (s.height < 0.4 || s.rock > 0.3 || slope(x, z) > 1.5 || s.grove > 0.5 || !far(x, z, 150)) continue;
    out.push({ type: 'Cairn', x, y: s.height - 0.05, z, yaw: rand(k, 13) * 6.28, scale: 0.8 + rand(k, 14) * 0.5 });
  }
  for (let k = 0; k < 6000 && out.filter((p) => p.type === 'StoneLantern').length < 36; k++) {
    const x = (rand(k, 21) - 0.5) * WORLD_HALF * 1.6;
    const z = (rand(k, 22) - 0.5) * WORLD_HALF * 1.6;
    const s = hf.sample(x, z);
    if (s.height < 3 || s.rock > 0.1 || slope(x, z) > 1.2 || s.grove < 0.4 || !far(x, z, 120)) continue;
    out.push({ type: 'StoneLantern', x, y: s.height - 0.1, z, yaw: rand(k, 23) * 6.28, scale: 0.9 + rand(k, 24) * 0.3 });
  }

  // The Drowned Town: a sunken street grid on the west shelf, ruins standing in the shallows.
  const D = BIOMES.drowned;
  const RUINS = ['RuinColumn', 'RuinColumn', 'RuinColumnBroken', 'RuinColumnBroken', 'RuinWall', 'RuinArch', 'RuinSteps'];
  const streetYaw = 0.35;
  let k = 0;
  for (let gz = -D.r; gz <= D.r; gz += 26)
    for (let gx = -D.r; gx <= D.r; gx += 26) {
      k++;
      const jx = gx + (rand(k, 31) - 0.5) * 10;
      const jz = gz + (rand(k, 32) - 0.5) * 10;
      if (Math.hypot(jx, jz) > D.r * (0.75 + rand(k, 33) * 0.25) || rand(k, 34) < 0.25) continue;
      const x = D.x + jx * Math.cos(streetYaw) - jz * Math.sin(streetYaw);
      const z = D.z + jx * Math.sin(streetYaw) + jz * Math.cos(streetYaw);
      const y = h(x, z);
      if (y < -3.5 || y > 2.5) continue;
      const type = RUINS[Math.floor(rand(k, 35) * RUINS.length)];
      // Walls and arches follow the old streets; broken pieces lean wherever they fell.
      const aligned = type === 'RuinWall' || type === 'RuinArch' || type === 'RuinSteps';
      const yaw = aligned ? -streetYaw + (rand(k, 36) < 0.5 ? 0 : Math.PI / 2) : rand(k, 36) * 6.28;
      out.push({ type, x, y: y - 0.3, z, yaw, scale: 0.9 + rand(k, 37) * 0.35 });
    }
  return out;
}

// Footprint radius per landmark for collision (scaled by placement scale).
/** What each prop sounds like underfoot; anything not listed is stone. */
const WOODEN = new Set(['Jetty', 'Wreck', 'Hut', 'Swing']);
const SOLID: Record<string, number> = { Lighthouse: 0, Beacon: 0, Hut: 2.2, Cairn: 0.5, StoneLantern: 0.35, Wreck: 0, RuinColumn: 0.7, RuinColumnBroken: 0.7 };
/** Lamp-room height of the lighthouse model, before placement scale. */
const LAMP_Y = 25;
const LIGHTS: Record<string, [number, number, number]> = {
  // [height of the light, intensity, range]
  Hut: [1.6, 2.4, 14],
  Cairn: [1.3, 1.2, 7],
  StoneLantern: [1.0, 1.6, 9],
};

/** Renders, lights and collides the landmark layout. */
export class Landmarks implements Colliders {
  readonly group = new THREE.Group();
  private lights: THREE.PointLight[] = [];
  /** Story hook: the home lighthouse's lamp. 0 = dark, 1 = lit (Act 2 midpoint). */
  readonly lamp = uniform(0);

  /** Props that drop out of the scene beyond their reach r, so far ones cost no draw calls. */
  private far: { obj: THREE.Object3D; x: number; z: number; r: number }[] = [];
  private cullTick = 0;

  constructor(readonly placed: Placed[]) {
    this.group.name = 'landmarks';
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(PALETTE.starGold, 0, 10, 1.8);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  /** Beacons (and the home lighthouse): the lights you save at. */
  readonly beacons: { placed: Placed; lit: { value: number }; litTarget: number; beam: THREE.Group; lampY: number; crystal: THREE.Object3D | null }[] = [];

  private material(name: string, lamp?: { value: number }, lighthouse = false) {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const variety = hash(positionWorld.x.mul(0.31).add(positionWorld.z.mul(0.17)).floor());
    const vc = vertexColor();
    const L: any = lamp ?? this.lamp;
    if (name === 'lamp_glass') {
      // See-through glass with a faint sheen that warms as the lamp is lit; the crystal shows inside.
      const glass = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      glass.colorNode = mix(color(0x6a7ac8).mul(0.08), color(PALETTE.starGold).mul(0.35), L);
      return glass;
    }
    if (name === 'star_crystal') {
      const pulse = sin(time.mul(1.6)).mul(0.15).add(1);
      mat.colorNode = mix(color(0x9fb4ff).mul(0.9), color(0xfff0d0).mul(4.5), L).mul(pulse);
      return mat;
    }
    if (name === 'rune_glow') {
      // Runes crawl with a slow light even when the lamp is cold; lit, they blaze.
      const crawl = sin(positionWorld.y.mul(0.6).sub(time.mul(1.4))).mul(0.3).add(0.75);
      mat.colorNode = mix(color(0x7a8cff).mul(0.9), color(0xb8fff4).mul(2.4), L).mul(crawl);
      return mat;
    }
    const glow = name.includes('glow');
    if (glow) {
      // Candle and lamp glass: warm, flickering, bright enough to bloom into grain.
      const flicker = sin(time.mul(9).add(variety.mul(40))).mul(0.08).add(sin(time.mul(23).add(variety.mul(13))).mul(0.05)).add(0.9);
      const strength: any = name === 'lamp_glass' ? float(0.15).add(float(3.2).mul((lamp ?? this.lamp) as never)) : float(2.2);
      mat.colorNode = color(PALETTE.starGold).mul(strength).mul(flicker);
      return mat;
    }
    const base: Record<string, number> = {
      wood: 0x6b5450, thatch: 0x7a6650, stone: 0x5b6890, rope: 0x8a7a68, sail: 0xe8dfd0,
      lighthouse_white: 0xc9c0b0, lighthouse_band: PALETTE.coral,
      ruin_stone: 0x8a90b8, ruin_moss: 0x3f6a7a, marble: 0xb8b8d8,
    };
    let tint: any = color(base[name] ?? 0x34405e);
    if (lighthouse && name === 'lighthouse_white') {
      // The doorway's wall patch is modelled in white to the ground; the base course is stone all round.
      const lp = positionLocal as any;
      const course = smoothstep(1.62, 1.58, lp.y).mul(smoothstep(2.95, 3.05, length(lp.xz)));
      tint = mix(tint, color(base.stone), course);
    }
    // A cool moonlit lift on top faces so built things read against the dark jungle.
    const moonlit = saturate(normalWorld.y).mul(0.12);
    // Painted colour first, then inked like the rest of the world: flat tones and pen hatching.
    const painted = tint.mul(variety.mul(0.2).add(0.85)).mul(vc.r.mul(0.25).add(0.8)).mul(0.85);
    let col: any = drawnSurface(painted, normalWorld, positionWorld).add(vec3(0.08, 0.1, 0.22).mul(moonlit));
    if (lighthouse) {
      const lp = positionLocal as any;
      const masoned = name === 'lighthouse_white' || name === 'stone';
      const ink: any = masoned ? masonry(lp, normalWorld, positionWorld) : float(0);
      // Weathered at the foot, where spray and moss reach: a darker wash up the first few metres.
      const foot = smoothstep(0.2, 4.5, lp.y).mul(0.22).add(0.78);
      col = mix(col.mul(foot), color(0x0b1030), ink.mul(0.42));
      // Inside the hollow tower no moonlight reaches; the stair lanterns light it in pools.
      const wallR = float(3.2).sub(lp.y.clamp(0, 22).mul(0.8 / 22));
      const tower = smoothstep(wallR.sub(0.12), wallR.sub(0.3), length(lp.xz)).mul(smoothstep(23.2, 22.8, lp.y));
      // The lamp room above, inside its glazing and the doorway's wall bay.
      const lampRoom = smoothstep(2.14, 2.1, length(lp.xz)).mul(smoothstep(22.8, 23.0, lp.y)).mul(smoothstep(26.5, 26.2, lp.y));
      const inside = tower.max(lampRoom);
      col = mix(col, interiorShade(tint, lp, positionWorld, ink), inside);
    }
    mat.colorNode = col;
    return mat;
  }

  /** Every prop except the lighthouses (which have their own climb) as a standable solid. */
  readonly solids = new PropCollision();
  private gridded = new Set<string>();

  /** Loads templates from each file; a missing file just leaves its props out. */
  async load(...urls: string[]) {
    const mats = new Map<string, THREE.Material>();
    const templates = new Map<string, THREE.Object3D>();
    const loader = new GLTFLoader();
    for (const url of urls) {
      const gltf = await loader.loadAsync(url).catch(() => null);
      if (!gltf) continue;
      gltf.scene.updateMatrixWorld(true);
      for (const child of gltf.scene.children) templates.set(child.name, child);
    }
    const grids = new Map<string, ColumnGrid>();
    for (const p of this.placed) {
      const isLight = p.type === 'Beacon' || p.type === 'Lighthouse';
      const t = isLight ? templates.get('DreamLighthouse') ?? templates.get('Lighthouse') : templates.get(p.type);
      if (!t) continue;
      if (!isLight) {
        if (!grids.has(p.type)) grids.set(p.type, gridFromObject(t));
        this.solids.add(grids.get(p.type)!, p, WOODEN.has(p.type) ? 'wood' : 'stone');
        this.gridded.add(p.type);
      }
      const obj = t.clone(true);
      const lamp = isLight ? uniform(0) : undefined;
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const name = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material).name || 'wood';
        // Each light has its own lamp glass, crystal and runes so they can be lit one at a time.
        if (lamp && (name === 'lamp_glass' || name === 'star_crystal' || name === 'rune_glow')) {
          m.material = this.material(name, lamp);
          return;
        }
        const key = isLight ? `${name}:lighthouse` : name;
        if (!mats.has(key)) mats.set(key, this.material(name, undefined, isLight));
        m.material = mats.get(key)!;
      });
      if (isLight && lamp) {
        const lampY = p.y + LAMP_Y * p.scale;
        const beam = this.makeBeam(p.scale);
        beam.position.set(p.x, lampY, p.z);
        beam.visible = false;
        this.group.add(beam);
        this.beacons.push({ placed: p, lit: lamp, litTarget: 0, beam, lampY, crystal: obj.getObjectByName('StarCrystal') ?? null });
      }
      obj.position.set(p.x, p.y, p.z);
      obj.rotation.set(0, p.yaw, 0);
      obj.scale.setScalar(p.scale);
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      // The crystal spins, so its own matrix must keep updating.
      obj.getObjectByName('StarCrystal')?.traverse((c) => (c.matrixAutoUpdate = true));
      // The model's floating rune rings read as clutter; leave them out.
      for (let k = 0; k < 3; k++) obj.getObjectByName(`RuneRing_${k}`)?.removeFromParent();
      this.group.add(obj);
      // Lighthouses are seen (and steered by) from anywhere; everything else drops out with distance.
      if (!isLight) this.far.push({ obj, x: p.x, z: p.z, r: 650 * Math.max(1, p.scale) });
    }
    return [...templates.keys()];
  }

  /** Two soft cones of light sweeping round from the lamp room, visible from far away. */
  private makeBeam(scale: number) {
    const g = new THREE.Group();
    const length = 160 * Math.max(0.7, scale);
    // Narrow at the lamp (the cylinder's bottom once shifted up), spreading to 7 m far out.
    const geo = new THREE.CylinderGeometry(7, 0.35 * scale, length, 16, 1, true);
    geo.translate(0, length / 2, 0);
    geo.rotateZ(-Math.PI / 2);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const along = uv().y; // 0 at the lamp, 1 at the far end
    mat.colorNode = color(0xffe0a8).mul(float(1).sub(along).pow(1.8).mul(0.22));
    for (const yaw of [0, Math.PI]) {
      const cone = new THREE.Mesh(geo, mat);
      cone.rotation.y = yaw;
      cone.frustumCulled = false;
      g.add(cone);
    }
    return g;
  }

  lightBeacon(i: number, instant = false) {
    const b = this.beacons[i];
    if (!b) return;
    b.litTarget = 1;
    if (instant) b.lit.value = 1;
  }

  isLit(i: number) {
    return (this.beacons[i]?.litTarget ?? 0) > 0;
  }

  /** Index and distance of the nearest beacon to a point. */
  nearestBeacon(x: number, z: number) {
    let best = -1;
    let bd = Infinity;
    this.beacons.forEach((b, i) => {
      const d = Math.hypot(b.placed.x - x, b.placed.z - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return { index: best, dist: bd };
  }

  /** A safe standing spot just in front of a beacon's door. */
  beaconRestSpot(i: number) {
    const p = this.beacons[i].placed;
    return { x: p.x + Math.cos(p.yaw) * 5, z: p.z - Math.sin(p.yaw) * 5 };
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const p of this.placed) {
      if (this.gridded.has(p.type)) continue;
      const r = (SOLID[p.type] ?? 0) * p.scale;
      if (r > 0 && Math.abs(p.x - x) < reach + r && Math.abs(p.z - z) < reach + r) visit(p.x, p.z, r);
    }
  }

  /** The nearest few lamps get real point lights so they pool warm light on the ground. */
  update(focus: THREE.Vector3, dt = 0.016) {
    // Every few frames is plenty: nothing comes into view faster than you can travel 650 m.
    if (this.cullTick++ % 12 === 0)
      for (const f of this.far) f.obj.visible = Math.abs(f.x - focus.x) < f.r && Math.abs(f.z - focus.z) < f.r && Math.hypot(f.x - focus.x, f.z - focus.z) < f.r;
    for (const b of this.beacons) {
      b.lit.value += (b.litTarget - b.lit.value) * Math.min(1, dt * 0.8);
      b.beam.visible = b.lit.value > 0.05;
      b.beam.rotation.y += dt * 0.35;
      if (b.crystal) {
        b.crystal.rotation.y += dt * (0.25 + b.lit.value * 0.6);
        b.crystal.position.y = 25 + Math.sin(performance.now() / 900) * 0.15;
      }
      b.beam.scale.setScalar(Math.min(1, b.lit.value * 1.2));
    }
    const lit = this.placed
      .filter((p) => LIGHTS[p.type])
      .map((p) => ({ p, d: Math.hypot(p.x - focus.x, p.z - focus.z) }))
      .filter((e) => e.d < 70)
      .sort((a, b) => a.d - b.d)
      .slice(0, this.lights.length);
    this.lights.forEach((l, i) => {
      const e = lit[i];
      if (!e) {
        l.intensity = 0;
        return;
      }
      const [hy, power, range] = LIGHTS[e.p.type];
      l.position.set(e.p.x, e.p.y + hy * e.p.scale, e.p.z);
      l.intensity = power * smooth(70, 40, e.d) * (0.92 + Math.sin(performance.now() * 0.009 + i) * 0.08);
      l.distance = range;
    });
  }

  /** Nearest landmark of a type to a point. */
  nearest(type: string, x: number, z: number) {
    let best: Placed | null = null;
    let bd = Infinity;
    for (const p of this.placed)
      if (p.type === type) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
    return best;
  }
}

/** Combines several collider sources into one for the player. */
export class CompositeColliders implements Colliders {
  constructor(private sources: Colliders[]) {}
  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const s of this.sources) s.near(x, z, reach, visit);
  }
}

