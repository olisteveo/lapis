import * as THREE from 'three/webgpu';
import {
  abs, attribute, color, cos, dot, exp, float, length, max, mix, normalGeometry, positionLocal, saturate, sin, smoothstep, time,
  uv, vec3, vec4, vertexColor, instancedBufferAttribute, cameraPosition, mod, uniform,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, SKY } from '../config';
import { BIOMES, mulberry32, type Heightfield } from './heightfield';
import type { Colliders } from '../game/player';

type N = any;

function merge(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const parts: { geo: THREE.BufferGeometry; mat: string }[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    parts.push({ geo: g, mat: ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material).name });
  });
  return parts;
}

function instanced(base: THREE.BufferGeometry, count: number, attrs: Record<string, number>) {
  const g = new THREE.InstancedBufferGeometry();
  for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a);
  g.setIndex(base.index);
  const out: Record<string, THREE.InstancedBufferAttribute> = {};
  for (const [name, size] of Object.entries(attrs)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
    out[name] = a;
  }
  g.instanceCount = count;
  return { geometry: g, attrs: out };
}

const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);

/** Yaw a local position around Y. */
function yawed(p: N, yaw: N): N {
  const c = cos(yaw);
  const s = sin(yaw);
  return vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.z.mul(c).sub(p.x.mul(s)));
}

/**
 * A walk cycle from vertex colours: legs (G=1) swing fore and aft by their swing weight (R)
 * with a per-leg phase (B), lifting on the forward swing.
 */
function gait(lp: N, vc: N, phase: N, stride: number, lift: number): N {
  const leg = vc.g.greaterThan(0.75).select(float(1), float(0));
  const a = phase.add(vc.b.mul(Math.PI * 2));
  const swing = sin(a).mul(vc.r).mul(stride).mul(leg);
  const up = max(cos(a), 0).mul(vc.r).mul(lift).mul(leg);
  return vec3(lp.x.add(swing), lp.y.add(up), lp.z);
}

interface Deer {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  target: number;
  phase: number;
  state: 'graze' | 'walk' | 'flee';
  timer: number;
  scale: number;
}

const DEER = 14;
const MANTAS = 6;

/** The dream's animals: star deer, sky mantas, lantern moths and the island tortoise. */
export class Fauna implements Colliders {
  readonly group = new THREE.Group();
  private deer: Deer[] = [];
  private deerAttrs: Record<string, THREE.InstancedBufferAttribute> | null = null;
  private deerHome = new THREE.Vector3(1e9, 0, 1e9);
  private mantaAttrs: Record<string, THREE.InstancedBufferAttribute> | null = null;
  private mantaHome = new THREE.Vector3(1e9, 0, 1e9);
  private tortoise: THREE.Object3D | null = null;
  private tortoisePhase = uniform(0);
  private tortoiseT = 0;
  private moths: THREE.Sprite | null = null;
  private mothStrength = uniform(0);
  private rnd = mulberry32(77);
  /** Called when the herd bolts (for a little sound). */
  onFlee: (() => void) | null = null;

  constructor(private hf: Heightfield) {
    this.group.name = 'fauna';
    this.buildMoths();
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const get = (n: string) => gltf.scene.getObjectByName(n);
    const deer = get('StarDeer');
    const manta = get('SkyManta');
    const tort = get('Tortoise');
    if (deer) this.buildDeer(merge(deer));
    if (manta) this.buildMantas(merge(manta));
    if (tort) this.buildTortoise(tort);
    return { deer: !!deer, manta: !!manta, tortoise: !!tort };
  }

  // ---------------------------------------------------------------- star deer

  private buildDeer(parts: { geo: THREE.BufferGeometry; mat: string }[]) {
    for (let i = 0; i < DEER; i++)
      this.deer.push({ x: 0, z: 0, yaw: 0, speed: 0, target: 0, phase: this.rnd() * 6, state: 'graze', timer: this.rnd() * 5, scale: 0.85 + this.rnd() * 0.3 });
    let shared: Record<string, THREE.InstancedBufferAttribute> | null = null;
    for (const part of parts) {
      const { geometry, attrs } = instanced(part.geo, DEER, { pose: 4, gaitData: 4 });
      if (shared) {
        geometry.setAttribute('pose', shared.pose);
        geometry.setAttribute('gaitData', shared.gaitData);
      } else shared = attrs;
      const P = attribute('pose', 'vec4') as N;
      const G = attribute('gaitData', 'vec4') as N;
      const vc = vertexColor() as N;
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      const lp = gait(positionLocal.mul(G.z) as N, vc, G.x, 0.28, 0.12);
      // Grazing: the head dips (vertices toward +X and up, i.e. the neck and head).
      const headDip = smoothstep(0.4, 1.2, lp.x).mul(smoothstep(0.9, 1.6, lp.y)).mul(G.w).mul(-0.55);
      mat.positionNode = yawed(vec3(lp.x, lp.y.add(headDip), lp.z), P.w).add(P.xyz);
      const n = yawed(normalGeometry, P.w);
      const lambert = saturate(abs(dot(n, key)).mul(0.6).add(0.35));
      if (part.mat.includes('glow')) {
        mat.colorNode = color(PALETTE.starWhite).mul(1.9).mul(sin(time.mul(2).add(P.x)).mul(0.2).add(0.9));
      } else {
        // Pale, moonlit coats with a faint glow along the back.
        mat.colorNode = mix(color(0x6e6aa0), color(0xcfc6ea), lambert).mul(0.75).add(vec3(0.05, 0.06, 0.12).mul(saturate(n.y)));
      }
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.deerAttrs = shared;
  }

  private placeHerd(focus: THREE.Vector3) {
    // A herd lives where the meadows and the wood are; find open ground near you there.
    for (let tries = 0; tries < 60; tries++) {
      const a = this.rnd() * Math.PI * 2;
      const d = 70 + this.rnd() * 160;
      const x = focus.x + Math.sin(a) * d;
      const z = focus.z + Math.cos(a) * d;
      const s = this.hf.sample(x, z);
      if (s.height < 1 || s.rock > 0.2 || Math.max(s.meadow, s.lantern * 0.6) < 0.35) continue;
      this.deerHome.set(x, s.height, z);
      this.deer.forEach((dr, i) => {
        dr.x = x + Math.cos(i * 2.3) * (3 + i * 1.3);
        dr.z = z + Math.sin(i * 2.3) * (3 + i * 1.3);
        dr.yaw = this.rnd() * Math.PI * 2;
        dr.state = 'graze';
      });
      return true;
    }
    return false;
  }

  private updateDeer(dt: number, focus: THREE.Vector3, playerSpeed: number) {
    if (!this.deerAttrs) return;
    const here = this.hf.sample(focus.x, focus.z);
    if (Math.hypot(this.deerHome.x - focus.x, this.deerHome.z - focus.z) > 450) {
      if (Math.max(here.meadow, here.lantern) < 0.25 || !this.placeHerd(focus)) {
        this.deerHome.set(1e9, 0, 1e9);
        this.deerAttrs.pose.array.fill(0);
        for (let i = 0; i < DEER; i++) (this.deerAttrs.pose.array as Float32Array)[i * 4 + 1] = -9999;
        this.deerAttrs.pose.needsUpdate = true;
        return;
      }
    }
    let fled = false;
    const pose = this.deerAttrs.pose.array as Float32Array;
    const gd = this.deerAttrs.gaitData.array as Float32Array;
    this.deer.forEach((d, i) => {
      const dx = d.x - focus.x;
      const dz = d.z - focus.z;
      const dist = Math.hypot(dx, dz);
      // Startle: a running Keeper, or anyone too close.
      if (d.state !== 'flee' && (dist < 9 || (dist < 22 && playerSpeed > 5))) {
        d.state = 'flee';
        d.timer = 4 + this.rnd() * 2;
        d.target = Math.atan2(dx, dz);
        fled = true;
      }
      d.timer -= dt;
      if (d.timer <= 0) {
        if (d.state === 'flee' || d.state === 'walk') {
          d.state = 'graze';
          d.timer = 3 + this.rnd() * 6;
        } else {
          d.state = 'walk';
          d.timer = 2 + this.rnd() * 4;
          // Wander, drifting back toward the herd's home.
          const home = Math.atan2(this.deerHome.x - d.x, this.deerHome.z - d.z);
          d.target = home + (this.rnd() - 0.5) * 2.2;
        }
      }
      const want = d.state === 'flee' ? 8 : d.state === 'walk' ? 1.3 : 0;
      d.speed += (want - d.speed) * Math.min(1, dt * (d.state === 'flee' ? 4 : 1.5));
      let diff = d.target - d.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (d.state !== 'graze') d.yaw += diff * Math.min(1, dt * 3);
      const nx = d.x + Math.sin(d.yaw) * d.speed * dt;
      const nz = d.z + Math.cos(d.yaw) * d.speed * dt;
      if (this.hf.height(nx, nz) > 0.4) {
        d.x = nx;
        d.z = nz;
      } else d.target += Math.PI * 0.5;
      d.phase += dt * (d.speed * 2.6 + (d.state === 'graze' ? 0 : 0.5));
      const y = this.hf.height(d.x, d.z);
      // Model faces +X; heading convention faces +Z, so rotate by heading - 90 degrees.
      pose.set([d.x, y, d.z, d.yaw - Math.PI / 2], i * 4);
      gd.set([d.phase, 0, d.scale, d.state === 'graze' ? 1 : 0], i * 4);
    });
    this.deerAttrs.pose.needsUpdate = true;
    this.deerAttrs.gaitData.needsUpdate = true;
    if (fled) this.onFlee?.();
  }

  // ---------------------------------------------------------------- sky mantas

  private buildMantas(parts: { geo: THREE.BufferGeometry; mat: string }[]) {
    let shared: Record<string, THREE.InstancedBufferAttribute> | null = null;
    for (const part of parts) {
      const { geometry, attrs } = instanced(part.geo, MANTAS, { orbit: 4, mantaData: 4 });
      if (shared) {
        geometry.setAttribute('orbit', shared.orbit);
        geometry.setAttribute('mantaData', shared.mantaData);
      } else shared = attrs;
      const O = attribute('orbit', 'vec4') as N; // centre xyz, radius
      const M = attribute('mantaData', 'vec4') as N; // speed, phase, scale, height wobble
      const vc = vertexColor() as N;
      const a = time.mul(M.x).add(M.y);
      const lp = positionLocal.mul(M.z) as N;
      // Slow, deep wingbeats rolling out to the tips.
      const beat = sin(time.mul(0.9).add(M.y).sub(vc.r.mul(1.4))).mul(vc.r).mul(vc.g).mul(abs(lp.z).mul(0.35).add(0.3));
      const local = vec3(lp.x, lp.y.add(beat), lp.z);
      // Nose along the orbit's tangent: velocity is (-sin a, cos a) times the orbit's direction.
      const dir = M.x.sign();
      const heading = cos(a).mul(dir).negate().atan(sin(a).mul(dir).negate());
      const pos = vec3(O.x.add(cos(a).mul(O.w)), O.y.add(sin(time.mul(0.25).add(M.y)).mul(M.w)), O.z.add(sin(a).mul(O.w)));
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: true });
      mat.positionNode = yawed(local, heading).add(pos);
      const lambert = saturate(abs(dot(normalGeometry, key)).mul(0.5).add(0.4));
      if (part.mat.includes('glow')) mat.colorNode = color(0x7ff0ff).mul(1.6).mul(sin(time.mul(1.5).add(M.y)).mul(0.25).add(0.85));
      else mat.colorNode = mix(color(0x0f1a4a), color(0x4a5fb0), lambert);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.mantaAttrs = shared;
  }

  private updateMantas(focus: THREE.Vector3) {
    if (!this.mantaAttrs || Math.hypot(this.mantaHome.x - focus.x, this.mantaHome.z - focus.z) < 700) return;
    this.mantaHome.copy(focus);
    const o = this.mantaAttrs.orbit.array as Float32Array;
    const m = this.mantaAttrs.mantaData.array as Float32Array;
    for (let i = 0; i < MANTAS; i++) {
      // They prefer the Lantern Wood and open water, gliding high above the canopy.
      const a = this.rnd() * Math.PI * 2;
      const d = 150 + this.rnd() * 450;
      const x = focus.x + Math.sin(a) * d;
      const z = focus.z + Math.cos(a) * d;
      const radius = 60 + this.rnd() * 120;
      // Clear the highest ground anywhere on the circle, not just under its centre.
      let ground = Math.max(this.hf.height(x, z), 0);
      for (let k = 0; k < 12; k++) ground = Math.max(ground, this.hf.height(x + Math.cos(k * 0.5236) * radius, z + Math.sin(k * 0.5236) * radius));
      o.set([x, ground + 45 + this.rnd() * 50, z, radius], i * 4);
      m.set([(0.025 + this.rnd() * 0.02) * (this.rnd() > 0.5 ? 1 : -1), this.rnd() * 6.28, 0.9 + this.rnd() * 0.5, 4 + this.rnd() * 6], i * 4);
    }
    this.mantaAttrs.orbit.needsUpdate = true;
    this.mantaAttrs.mantaData.needsUpdate = true;
  }

  // ---------------------------------------------------------------- moths

  private buildMoths() {
    const count = 500;
    const rnd = mulberry32(31);
    const a = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) a[i] = rnd();
    const s = instancedBufferAttribute(new THREE.InstancedBufferAttribute(a, 4), 'vec4') as N;
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const span = float(36);
    const half = span.mul(0.5);
    const cam = cameraPosition as N;
    // Fluttering: quick jittery loops around a slowly drifting home point.
    const t = time as N;
    const flutter = vec3(sin(t.mul(s.x.mul(4).add(3)).add(s.y.mul(30))), sin(t.mul(s.y.mul(5).add(4)).add(s.z.mul(20))).mul(0.6), cos(t.mul(s.z.mul(4).add(3)).add(s.w.mul(30)))).mul(0.9);
    const base = vec3(s.x, s.y, s.z).mul(span);
    const local = mod(base.add(flutter).sub(cam).add(half), span).sub(half) as N;
    mat.positionNode = vec3(local.x.add(cam.x), cam.y.add(local.y.mul(0.25)).sub(0.3), local.z.add(cam.z));
    const r = length(uv().sub(0.5)).mul(2);
    const wing = sin(time.mul(30).add(s.w.mul(50))).mul(0.5).add(0.5);
    mat.scaleNode = vec3(float(0.08).mul(wing.mul(0.5).add(0.6)), 0.06, 1) as N;
    mat.colorNode = vec4(mix(color(0xc6b8ff), color(0x8ff0e6), s.w).mul(exp(r.mul(-4)).mul(1.6)).mul(this.mothStrength as N), 1);
    const sprite = new THREE.Sprite(mat);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 4;
    this.moths = sprite;
    this.group.add(sprite);
  }

  // ---------------------------------------------------------------- the tortoise

  private buildTortoise(root: THREE.Object3D) {
    const t = root.clone(true);
    const phase = this.tortoisePhase;
    t.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material).name;
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      const vc = vertexColor() as N;
      mat.positionNode = gait(positionLocal, vc, phase as N, 0.9, 0.35);
      const lambert = saturate(dot(normalGeometry, key).mul(0.55).add(0.45));
      const [dark, light] = name.includes('moss') ? [0x1f4a4a, 0x5fa08a] : name.includes('shell') ? [0x2a3260, 0x6a74a8] : [0x3a3a5e, 0x8f8cb4];
      mat.colorNode = mix(color(dark), color(light), lambert).mul(0.9);
      m.material = mat;
      m.frustumCulled = false;
    });
    this.tortoise = t;
    this.group.add(t);
  }

  private updateTortoise(dt: number) {
    const t = this.tortoise;
    if (!t) return;
    // A slow loop around the dunes; one lap takes most of an hour.
    this.tortoiseT += dt * 0.0016;
    const D = BIOMES.dunes;
    const a = this.tortoiseT;
    const x = D.x + Math.cos(a) * 340;
    const z = D.z + Math.sin(a) * 260;
    const nx = D.x + Math.cos(a + 0.01) * 340;
    const nz = D.z + Math.sin(a + 0.01) * 260;
    t.position.set(x, this.hf.height(x, z) - 0.2, z);
    t.rotation.y = Math.atan2(-(nz - z), nx - x);
    this.tortoisePhase.value += dt * 0.9;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    const t = this.tortoise;
    if (t && Math.abs(t.position.x - x) < reach + 8 && Math.abs(t.position.z - z) < reach + 8) visit(t.position.x, t.position.z, 6.5);
  }

  update(dt: number, focus: THREE.Vector3, playerSpeed: number) {
    this.updateDeer(dt, focus, playerSpeed);
    this.updateMantas(focus);
    this.updateTortoise(dt);
    const lantern = this.hf.sample(focus.x, focus.z).lantern;
    this.mothStrength.value += (lantern - this.mothStrength.value) * Math.min(1, dt);
    if (this.moths) this.moths.visible = this.mothStrength.value > 0.02;
  }
}
