import * as THREE from 'three/webgpu';
import {
  abs, attribute, color, cos, dot, exp, float, length, max, mix, normalGeometry, positionLocal, saturate, sin, smoothstep, time,
  uv, vec3, vec4, vertexColor, instancedBufferAttribute, cameraPosition, mod, uniform, positionWorld, hash, floor, normalWorld,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, SKY } from '../config';
import { drawnSurface, penLines } from '../render/drawn';
import { BlobShadows } from '../render/blobShadows';
import { Herd } from '../core/herd';
import { BIOMES, mulberry32, type Heightfield } from '../core/heightfield';
import type { Colliders } from '../core/player';

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

const DEER = 14;
const MANTAS = 6;

/** The dream's animals: star deer, sky mantas, lantern moths and the island tortoise. */
export class Fauna implements Colliders {
  readonly group = new THREE.Group();
  /** How the herd behaves lives in src/core; this class only poses them. */
  readonly herd: Herd;
  private deerAttrs: Record<string, THREE.InstancedBufferAttribute> | null = null;
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

  /** Soft shadows under the deer (and one for the tortoise). */
  private shadows = new BlobShadows(DEER + 1);

  constructor(private hf: Heightfield) {
    this.group.name = 'fauna';
    this.herd = new Herd(hf, DEER);
    this.group.add(this.shadows.mesh);
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
        // Pale moonlit coats, inked like the rest of the world, flecked with a few twinkling stars:
        // they are dream animals, made of the same light as the sky.
        const coat = drawnSurface(mix(color(0x8a86c0), color(0xd8d0f2), lambert.mul(0.5).add(0.5)).mul(0.8), n, positionWorld, { spacing: 0.45 });
        const rest = positionLocal.mul(G.z).mul(7) as N;
        const cell = floor(rest) as N;
        const h = hash(cell.x.add(cell.y.mul(57)).add(cell.z.mul(113)));
        const inCell = smoothstep(0.22, 0.05, length(rest.sub(cell).sub(0.5)));
        const twinkle = sin(time.mul(h.mul(3).add(1.5)).add(h.mul(40))).mul(0.5).add(0.5);
        const fleck = smoothstep(0.93, 0.99, h).mul(inCell).mul(twinkle);
        mat.colorNode = coat.add(vec3(0.05, 0.06, 0.12).mul(saturate(n.y))).add(color(0xe8f0ff).mul(fleck.mul(1.8)));
      }
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.deerAttrs = shared;
  }

  private updateDeer(dt: number, focus: THREE.Vector3, playerSpeed: number) {
    if (!this.deerAttrs) return;
    const fled = this.herd.update(dt, focus, playerSpeed);
    const pose = this.deerAttrs.pose.array as Float32Array;
    const gd = this.deerAttrs.gaitData.array as Float32Array;
    this.herd.deer.forEach((d, i) => {
      // Model faces +X; heading convention faces +Z, so rotate by heading - 90 degrees.
      pose.set([d.x, d.y, d.z, d.yaw - Math.PI / 2], i * 4);
      gd.set([d.phase, 0, d.scale, d.state === 'graze' ? 1 : 0], i * 4);
      if (this.herd.present) this.shadows.set(i, d.x, d.y, d.z, 1.2 * d.scale);
      else this.shadows.hide(i);
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
      else {
        // Deep-sea blues, inked, with bioluminescent stripes rippling out along the wings.
        const nm = yawed(normalGeometry, heading);
        // Seen mostly from below: a pale moonlit belly under a deep blue back, so they read against the sky.
        const belly = smoothstep(0.15, -0.5, nm.y);
        const back = drawnSurface(mix(color(0x1a2660), color(0x4a60b0), lambert), nm, positionWorld, { spacing: 1.2, strength: 0.5 });
        const body = mix(back, color(0x9fb0e8).mul(0.75), belly);
        // Rows of glowing spots along the wings, a pulse travelling out to the tips.
        const span = abs(lp.z);
        const row = penLines(span.mul(0.9).add(lp.x.mul(0.2)), 2.4);
        const spots = smoothstep(0.35, 0.8, sin(lp.x.mul(5).add(span.mul(2))));
        const ripple = sin(time.mul(2.2).sub(span.mul(1.3)).add(M.y)).mul(0.5).add(0.5);
        mat.colorNode = body.add(color(0x6ff4ee).mul(row.mul(spots).mul(smoothstep(0.9, 1.6, span)).mul(ripple.mul(1.4).add(0.3))));
      }
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
    const count = 240;
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
    // Big enough to see: moths a hand across, wings beating.
    mat.scaleNode = vec3(float(0.26).mul(wing.mul(0.6).add(0.5)), 0.18, 1) as N;
    mat.colorNode = vec4(mix(color(0xc6b8ff), color(0x8ff0e6), s.w).mul(exp(r.mul(-3.2)).mul(1.9)).mul(this.mothStrength as N), 1);
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
      // Darker than the pale dunes it walks on, so it reads as a creature from a distance.
      const [dark, light] = name.includes('moss') ? [0x1a4038, 0x4f9078] : name.includes('shell') ? [0x161c40, 0x48528a] : [0x24223e, 0x6a6890];
      let col: N = drawnSurface(mix(color(dark), color(light), lambert.mul(0.5).add(0.5)).mul(0.9), normalWorld, positionWorld, { spacing: 1.4 });
      if (name.includes('moss')) {
        // A little world of its own on its back: glowing spores drifting in the moss.
        const sp = positionLocal.mul(2.2) as N;
        const cell = floor(sp) as N;
        const h = hash(cell.x.add(cell.y.mul(31)).add(cell.z.mul(97)));
        const dotOn = smoothstep(0.9, 0.98, h).mul(smoothstep(0.3, 0.08, length(sp.sub(cell).sub(0.5))));
        col = col.add(color(0x9ff0c8).mul(dotOn.mul(sin(time.mul(1.3).add(h.mul(30))).mul(0.4).add(0.9))));
      }
      mat.colorNode = col;
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
    this.shadows.set(DEER, x, t.position.y + 0.2, z, 7.5);
    this.tortoisePhase.value += dt * 0.9;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    const t = this.tortoise;
    if (t && Math.abs(t.position.x - x) < reach + 8 && Math.abs(t.position.z - z) < reach + 8) visit(t.position.x, t.position.z, 6.5);
  }

  update(dt: number, focus: THREE.Vector3, playerSpeed: number) {
    this.updateDeer(dt, focus, playerSpeed);
    this.shadows.commit();
    this.updateMantas(focus);
    this.updateTortoise(dt);
    const lantern = this.hf.sample(focus.x, focus.z).lantern;
    this.mothStrength.value += (lantern - this.mothStrength.value) * Math.min(1, dt);
    if (this.moths) this.moths.visible = this.mothStrength.value > 0.02;
  }
}
