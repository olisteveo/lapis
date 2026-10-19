import * as THREE from 'three/webgpu';
import {
  abs, color, cos, dot, float, instancedBufferAttribute, length, max, mix, mx_noise_float, normalGeometry, normalView, positionLocal, smoothstep, uv, vec2, vec4, saturate, sin, time, uniform, vec3, vertexColor,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SKY } from '../config';
import type { Heightfield } from './heightfield';
import { BlobShadows } from '../render/blobShadows';

type N = any;
type Kind = 'wraith' | 'crawler';

interface Nightmare {
  kind: Kind;
  obj: THREE.Object3D;
  thorns: THREE.Object3D;
  x: number;
  z: number;
  yaw: number;
  /** 0 = just emerging, 1 = fully here; dissolving runs it back down. */
  presence: number;
  dissolving: boolean;
  phase: { value: number };
  fade: { value: number };
  lunge: number;
  rest: number;
}

const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);

export interface LightSource {
  x: number;
  z: number;
  r: number;
}

/**
 * Her despair, given shape. As the night grows late, ink creatures crawl out of thorn patches in
 * the dark and come for the Keeper. Light drives them back; a touch scatters what you carry.
 */
export class Nightmares {
  readonly group = new THREE.Group();
  private templates = new Map<string, THREE.Object3D>();
  private live: Nightmare[] = [];
  private spawnT = 8;
  private flareT = 0;
  private rnd = Math.random;
  /** 0..1: how close the nearest one is, for the curdled post-process and the music. */
  dread = 0;
  /** Called when one reaches the Keeper. */
  onCatch: ((kind: Kind) => void) | null = null;
  /** Called when one first comes into view, for a warning. */
  onSighted: (() => void) | null = null;
  private sighted = false;
  /** Pools of ink under each nightmare and its thorns. */
  private pools = new BlobShadows(24, true);
  /** Ink smoke left behind as they move: x, y, z, age 0..1 (1 = gone). */
  private smoke: THREE.InstancedBufferAttribute;
  private smokeNext = 0;
  private emitT = 0;
  private static readonly SMOKE = 200;

  constructor(private hf: Heightfield) {
    this.group.name = 'nightmares';
    this.group.add(this.pools.mesh);
    const n = Nightmares.SMOKE;
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) a[i * 4 + 3] = 1;
    this.smoke = new THREE.InstancedBufferAttribute(a, 4);
    this.smoke.setUsage(THREE.DynamicDrawUsage);
    const S = instancedBufferAttribute(this.smoke, 'vec4') as N;
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.positionNode = S.xyz;
    const age = S.w;
    mat.scaleNode = vec2(age.mul(1.8).add(0.5).mul(age.lessThan(1).select(float(1), float(0))));
    const r = length(uv().sub(0.5)).mul(2);
    const edge = mx_noise_float(uv().mul(4).add(age.mul(3)) as N).mul(0.2);
    const alpha = smoothstep(1, 0.3, r.add(edge)).mul(smoothstep(0, 0.12, age)).mul(float(1).sub(age)).mul(0.55);
    mat.colorNode = vec4(mix(color(0x030108), color(0x2a0a20), smoothstep(0.4, 1, r)), alpha);
    const sprite = new THREE.Sprite(mat);
    sprite.count = n;
    sprite.frustumCulled = false;
    sprite.renderOrder = 3;
    this.group.add(sprite);
  }

  /** Smoke and pools follow the live nightmares. */
  private trails(dt: number) {
    this.emitT += dt;
    const arr = this.smoke.array as Float32Array;
    const emit = this.emitT > 0.05;
    if (emit) this.emitT = 0;
    let p = 0;
    for (const n of this.live) {
      const ground = this.hf.height(n.x, n.z);
      const pr = Math.max(0, n.presence);
      if (p < 24) this.pools.set(p++, n.x, ground, n.z, (n.kind === 'wraith' ? 2.6 : 1.9) * pr);
      if (p < 24) this.pools.set(p++, n.thorns.position.x, n.thorns.position.y, n.thorns.position.z, 2.4 * pr);
      if (emit && pr > 0.5 && !n.dissolving) {
        const i = this.smokeNext;
        this.smokeNext = (this.smokeNext + 1) % Nightmares.SMOKE;
        const h = n.kind === 'wraith' ? 0.3 + this.rnd() * 2.2 : 0.2 + this.rnd() * 0.5;
        arr.set([n.x + (this.rnd() - 0.5) * 1.2, ground + h, n.z + (this.rnd() - 0.5) * 1.2, 0], i * 4);
      }
    }
    for (; p < 24; p++) this.pools.hide(p);
    this.pools.commit();
    // Smoke rises, drifts and thins over a couple of seconds.
    for (let i = 0; i < Nightmares.SMOKE; i++) {
      if (arr[i * 4 + 3] >= 1) continue;
      arr[i * 4 + 1] += dt * 0.7;
      arr[i * 4] += Math.sin(i * 1.7 + arr[i * 4 + 1]) * dt * 0.3;
      arr[i * 4 + 3] = Math.min(1, arr[i * 4 + 3] + dt / 2.2);
    }
    this.smoke.needsUpdate = true;
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    for (const n of ['Wraith', 'Crawler', 'NightmareThorns']) {
      const o = gltf.scene.getObjectByName(n);
      if (o) this.templates.set(n, o);
    }
    return [...this.templates.keys()];
  }

  private dress(template: THREE.Object3D, kind: Kind | 'thorns', phase: { value: number }, fade: { value: number }) {
    const obj = template.clone(true);
    obj.position.set(0, 0, 0);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material).name;
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      const vc = vertexColor() as N;
      const lp = positionLocal as N;
      const F = fade as N;
      const P = phase as N;
      let pos: N;
      if (kind === 'crawler') {
        // Tripod gait from the walker encoding: legs (G=1) swing by R with per-leg phase B.
        const leg = vc.g.greaterThan(0.75).select(float(1), float(0));
        const a = P.add(vc.b.mul(Math.PI * 2));
        pos = vec3(lp.x.add(sin(a).mul(vc.r).mul(0.22).mul(leg)), lp.y.add(max(cos(a), 0).mul(vc.r).mul(0.14).mul(leg)), lp.z);
      } else {
        // Tendrils and fingers ripple like ink in water, stronger toward their tips.
        const w = sin(time.mul(2.4).add(vc.b.mul(6.28)).add(vc.r.mul(5))).mul(vc.r).mul(vc.g.mul(0.8).add(0.2));
        pos = vec3(lp.x.add(w.mul(0.12)), lp.y.add(w.mul(kind === 'thorns' ? 0.08 : 0.18)), lp.z.add(cos(time.mul(1.9).add(vc.b.mul(6.28))).mul(vc.r).mul(0.1)));
      }
      // The ink never holds still: the whole surface boils outward and back along its normals.
      const boil = mx_noise_float(lp.mul(1.6).add(vec3(0, time.mul(0.9), P.mul(0.1))) as N).mul(kind === 'thorns' ? 0.03 : 0.06).mul(vc.r.add(1));
      pos = pos.add(normalGeometry.mul(boil));
      // Emerging and dissolving: they rise out of (and sink back into) the ground.
      mat.positionNode = vec3(pos.x, pos.y.sub(float(1).sub(F).mul(kind === 'thorns' ? 2.6 : 3.2)), pos.z);
      const lambert = saturate(abs(dot(normalGeometry, key)).mul(0.5).add(0.5));
      // Crimson veins crawling slowly under the ink, pulsing like something breathing.
      const v = abs(mx_noise_float(lp.mul(2.4).add(vec3(0, time.mul(0.25), P.mul(0.05))) as N));
      const pulse = sin(time.mul(1.7).add(P)).mul(0.35).add(0.75);
      const veins = smoothstep(0.07, 0.0, v).mul(pulse);
      if (name.includes('eye')) {
        // Embers that flare and gutter, bright enough to bloom.
        const flicker = sin(time.mul(7).add(P)).mul(0.5).add(sin(time.mul(17.3).add(P.mul(2))).mul(0.3));
        mat.colorNode = color(0xff6a2a).mul(float(3.6).add(flicker));
      } else if (name.includes('edge')) mat.colorNode = mix(color(0x2a0c3a), color(0x7a1a3a), lambert).add(color(0xb0183a).mul(veins.mul(0.6)));
      else {
        // Glossy ink with a bruised crimson rim, so the silhouette reads against the night.
        const rim = float(1).sub(abs(normalView.z)).pow(3);
        mat.colorNode = mix(color(0x020108), color(0x1a1430), lambert.mul(lambert))
          .add(color(0x5a0f2a).mul(rim.mul(0.7)))
          .add(color(0xc0183a).mul(veins.mul(kind === 'thorns' ? 0.9 : 0.55)));
      }
      m.material = mat;
      m.frustumCulled = false;
    });
    return obj;
  }

  /** Q: the little light flares; every nightmare within reach bursts. Returns false on cooldown. */
  flare(at: THREE.Vector3) {
    if (this.flareT > 0) return false;
    this.flareT = 20;
    for (const n of this.live) if (Math.hypot(n.x - at.x, n.z - at.z) < 26) n.dissolving = true;
    return true;
  }

  get flareReady() {
    return this.flareT <= 0;
  }

  /** Resting at a light or waking: the night's nightmares all sink away. */
  clear() {
    for (const n of this.live) n.dissolving = true;
    this.spawnT = 20;
  }

  private spawn(kind: Kind, player: THREE.Vector3, lights: LightSource[]) {
    const body = this.templates.get(kind === 'wraith' ? 'Wraith' : 'Crawler');
    const thornT = this.templates.get('NightmareThorns');
    if (!body || !thornT) return;
    for (let tries = 0; tries < 20; tries++) {
      const a = this.rnd() * Math.PI * 2;
      const d = 45 + this.rnd() * 35;
      const x = player.x + Math.sin(a) * d;
      const z = player.z + Math.cos(a) * d;
      if (this.hf.height(x, z) < 0.3) continue;
      if (lights.some((l) => Math.hypot(l.x - x, l.z - z) < l.r + 10)) continue;
      const phase = uniform(0);
      const fade = uniform(0);
      const obj = this.dress(body, kind, phase, fade);
      const thorns = this.dress(thornT, 'thorns', phase, fade);
      const y = this.hf.height(x, z);
      thorns.position.set(x, y, z);
      thorns.rotation.y = this.rnd() * 6.28;
      thorns.scale.setScalar(0.9 + this.rnd() * 0.6);
      this.group.add(obj, thorns);
      this.live.push({ kind, obj, thorns, x, z, yaw: 0, presence: 0, dissolving: false, phase, fade, lunge: 0, rest: 2 + this.rnd() * 3 });
      return;
    }
  }

  /**
   * threat: 0 (none) to 1 (deep night). The player is caught on contact; lights repel.
   */
  update(dt: number, player: THREE.Vector3, playerSpeed: number, threat: number, lights: LightSource[]) {
    this.flareT = Math.max(0, this.flareT - dt);
    const wanted = threat <= 0 ? 0 : Math.round(1 + threat * 4);
    const alive = this.live.filter((n) => !n.dissolving).length;
    this.spawnT -= dt;
    if (alive < wanted && this.spawnT <= 0 && this.templates.size) {
      this.spawn(this.rnd() < 0.35 + threat * 0.25 ? 'crawler' : 'wraith', player, lights);
      this.spawnT = 14 - threat * 8;
    }
    if (threat <= 0) for (const n of this.live) n.dissolving = true;

    let dread = 0;
    for (const n of this.live) {
      const dx = player.x - n.x;
      const dz = player.z - n.z;
      const d = Math.hypot(dx, dz);
      // Light burns them: any nightmare that strays inside a light's reach comes apart.
      if (lights.some((l) => Math.hypot(l.x - n.x, l.z - n.z) < l.r)) n.dissolving = true;
      if (d > 160) n.dissolving = true;
      n.presence = n.dissolving ? n.presence - dt * 0.7 : Math.min(1, n.presence + dt * 0.35);
      n.fade.value = Math.max(0, n.presence);
      if (n.presence <= 0 && n.dissolving) {
        this.group.remove(n.obj, n.thorns);
        continue;
      }
      if (n.presence < 0.9 || n.dissolving) {
        // Still emerging from the thorns.
        n.obj.position.set(n.x, this.hf.height(n.x, n.z), n.z);
        continue;
      }
      let speed: number;
      if (n.kind === 'wraith') speed = 2.4 + threat * 0.8;
      else {
        // Crawlers stalk at a distance, then lunge, then have to rest.
        if (n.lunge > 0) {
          n.lunge -= dt;
          speed = 8.5;
        } else if (n.rest > 0) {
          n.rest -= dt;
          speed = d > 25 ? 3.2 : 0.6;
        } else {
          n.lunge = 1.8;
          n.rest = 4 + this.rnd() * 3;
          speed = 8.5;
        }
      }
      const want = Math.atan2(dx, dz);
      let diff = want - n.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      n.yaw += diff * Math.min(1, dt * (n.kind === 'crawler' ? 5 : 2));
      const nx = n.x + Math.sin(n.yaw) * speed * dt;
      const nz = n.z + Math.cos(n.yaw) * speed * dt;
      // Wraiths drift over anything; crawlers keep to dry land.
      if (n.kind === 'wraith' || this.hf.height(nx, nz) > 0.1) {
        n.x = nx;
        n.z = nz;
      }
      n.phase.value += dt * speed * (n.kind === 'crawler' ? 3.2 : 0.6);
      const ground = Math.max(this.hf.height(n.x, n.z), n.kind === 'wraith' ? 0 : -5);
      const bob = n.kind === 'wraith' ? 0.35 + Math.sin(performance.now() / 700 + n.x) * 0.15 : 0;
      n.obj.position.set(n.x, ground + bob, n.z);
      // Models face +X; heading 0 faces +Z.
      n.obj.rotation.y = n.yaw - Math.PI / 2;
      dread = Math.max(dread, Math.min(1, (45 - d) / 35));
      if (!this.sighted && d < 45) {
        this.sighted = true;
        this.onSighted?.();
      }
      if (d < (n.kind === 'crawler' ? 1.6 : 1.4) + (playerSpeed > 0 ? 0 : 0.2)) {
        n.dissolving = true;
        this.onCatch?.(n.kind);
      }
    }
    this.live = this.live.filter((n) => !(n.dissolving && n.presence <= 0));
    this.trails(dt);
    this.dread += (Math.max(0, dread) - this.dread) * Math.min(1, dt * 1.5);
  }
}
