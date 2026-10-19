import * as THREE from 'three/webgpu';
import { color, float, hash, positionWorld, sin, time, uniform, uv, vertexColor, normalWorld, saturate, dot, vec3 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, SKY } from '../config';
import { LIGHTHOUSE, WORLD_HALF, type Heightfield } from './heightfield';
import type { Colliders } from '../game/player';

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

  out.push({ type: 'Lighthouse', x: LIGHTHOUSE.x, y: h(LIGHTHOUSE.x, LIGHTHOUSE.z) - 0.4, z: LIGHTHOUSE.z, yaw: 0.6, scale: 1 });

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
    out.push({ type: 'Beacon', x, y: h(x, z) - 0.3, z, yaw: Math.atan2(c.sea.z, c.sea.x), scale: 0.55 });
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
      if (type === 'Jetty') out.push({ type, x: c.x, y: h(c.x, c.z) - 0.3, z: c.z, yaw: -yaw, scale: 1 });
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
  return out;
}

// Footprint radius per landmark for collision (scaled by placement scale).
const SOLID: Record<string, number> = { Lighthouse: 4.2, Beacon: 4.2, Hut: 2.2, Cairn: 0.5, StoneLantern: 0.35, Wreck: 0 };
/** Lamp-room height of the lighthouse model, before placement scale. */
const LAMP_Y = 23.5;
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

  constructor(readonly placed: Placed[]) {
    this.group.name = 'landmarks';
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(PALETTE.starGold, 0, 10, 1.8);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  /** Beacons (and the home lighthouse): the lights you save at. */
  readonly beacons: { placed: Placed; lit: { value: number }; litTarget: number; beam: THREE.Group; lampY: number }[] = [];

  private material(name: string, lamp?: { value: number }) {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);
    const lambert = saturate(dot(normalWorld, key).mul(0.6).add(0.4));
    const variety = hash(positionWorld.x.mul(0.31).add(positionWorld.z.mul(0.17)).floor());
    const vc = vertexColor();
    const glow = name.includes('glow') || name === 'lamp_glass';
    if (glow) {
      // Candle and lamp glass: warm, flickering, bright enough to bloom into grain.
      const flicker = sin(time.mul(9).add(variety.mul(40))).mul(0.08).add(sin(time.mul(23).add(variety.mul(13))).mul(0.05)).add(0.9);
      const strength: any = name === 'lamp_glass' ? float(0.15).add(float(3.2).mul((lamp ?? this.lamp) as never)) : float(2.2);
      mat.colorNode = color(PALETTE.starGold).mul(strength).mul(flicker);
      return mat;
    }
    const base: Record<string, number> = {
      wood: 0x6b5450, thatch: 0x7a6650, stone: 0x5b6890, rope: 0x8a7a68, sail: 0xe8dfd0,
      lighthouse_white: 0xd9d2c6, lighthouse_band: PALETTE.coral,
    };
    const tint = color(base[name] ?? 0x34405e);
    // A cool moonlit lift on top faces so built things read against the dark jungle.
    const moonlit = saturate(normalWorld.y).mul(0.12);
    mat.colorNode = tint.mul(lambert).mul(variety.mul(0.2).add(0.85)).mul(vc.r.mul(0.25).add(0.8)).add(vec3(0.08, 0.1, 0.22).mul(moonlit));
    return mat;
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const mats = new Map<string, THREE.Material>();
    const templates = new Map<string, THREE.Object3D>();
    for (const child of gltf.scene.children) templates.set(child.name, child);
    for (const p of this.placed) {
      const isLight = p.type === 'Beacon' || p.type === 'Lighthouse';
      const t = templates.get(p.type === 'Beacon' ? 'Lighthouse' : p.type);
      if (!t) continue;
      const obj = t.clone(true);
      const lamp = isLight ? uniform(0) : undefined;
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const name = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material).name || 'wood';
        // Each light has its own lamp glass so they can be lit one at a time.
        if (lamp && name === 'lamp_glass') {
          m.material = this.material(name, lamp);
          return;
        }
        if (!mats.has(name)) mats.set(name, this.material(name));
        m.material = mats.get(name)!;
      });
      if (isLight && lamp) {
        const lampY = p.y + LAMP_Y * p.scale;
        const beam = this.makeBeam(p.scale);
        beam.position.set(p.x, lampY, p.z);
        beam.visible = false;
        this.group.add(beam);
        this.beacons.push({ placed: p, lit: lamp, litTarget: 0, beam, lampY });
      }
      obj.position.set(p.x, p.y, p.z);
      obj.rotation.set(0, p.yaw, 0);
      obj.scale.setScalar(p.scale);
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      this.group.add(obj);
    }
    return [...templates.keys()];
  }

  /** Two soft cones of light sweeping round from the lamp room, visible from far away. */
  private makeBeam(scale: number) {
    const g = new THREE.Group();
    const length = 160 * Math.max(0.7, scale);
    const geo = new THREE.CylinderGeometry(0.35 * scale, 7, length, 16, 1, true);
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
      const r = (SOLID[p.type] ?? 0) * p.scale;
      if (r > 0 && Math.abs(p.x - x) < reach + r && Math.abs(p.z - z) < reach + r) visit(p.x, p.z, r);
    }
  }

  /** The nearest few lamps get real point lights so they pool warm light on the ground. */
  update(focus: THREE.Vector3, dt = 0.016) {
    for (const b of this.beacons) {
      b.lit.value += (b.litTarget - b.lit.value) * Math.min(1, dt * 0.8);
      b.beam.visible = b.lit.value > 0.05;
      b.beam.rotation.y += dt * 0.35;
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

