import * as THREE from 'three/webgpu';
import {
  abs, color, cos, dot, float, instancedBufferAttribute, length, max, mix, mx_noise_float, normalGeometry, normalView, positionLocal, smoothstep, uv, vec2, vec4, saturate, sin, time, uniform, vec3, vertexColor,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SKY } from '../config';
import type { Heightfield } from '../core/heightfield';
import { BlobShadows } from '../render/blobShadows';
import { NightmareBrain, type LightSource, type NightmareKind, type NightmareState } from '../core/nightmareBrain';

type N = any;
type Kind = NightmareKind;

interface View {
  obj: THREE.Object3D;
  thorns: THREE.Object3D;
  phase: { value: number };
  fade: { value: number };
}

const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);

export type { LightSource } from '../core/nightmareBrain';

/**
 * Her despair, given shape. As the night grows late, ink creatures crawl out of thorn patches in
 * the dark and come for the Keeper. Light drives them back; a touch scatters what you carry.
 */
export class Nightmares {
  readonly group = new THREE.Group();
  private templates = new Map<string, THREE.Object3D>();
  /** What they do lives in src/core; this class only draws it. */
  readonly brain: NightmareBrain;
  private views = new Map<number, View>();
  private rnd = Math.random;
  /** Called when one reaches the Keeper. */
  onCatch: ((kind: Kind) => void) | null = null;
  /** Called when one first comes into view, for a warning. */
  onSighted: (() => void) | null = null;
  /** Pools of ink under each nightmare and its thorns. */
  private pools = new BlobShadows(24, true);
  /** Ink smoke left behind as they move: x, y, z, age 0..1 (1 = gone). */
  private smoke: THREE.InstancedBufferAttribute;
  private smokeNext = 0;
  private emitT = 0;
  private static readonly SMOKE = 200;

  constructor(private hf: Heightfield) {
    this.group.name = 'nightmares';
    this.brain = new NightmareBrain((x, z) => hf.height(x, z));
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
    mat.scaleNode = vec2(age.mul(2.4).add(0.6).mul(age.lessThan(1).select(float(1), float(0))));
    const r = length(uv().sub(0.5)).mul(2);
    const edge = mx_noise_float(uv().mul(4).add(age.mul(3)) as N).mul(0.2);
    const alpha = smoothstep(1, 0.3, r.add(edge)).mul(smoothstep(0, 0.12, age)).mul(float(1).sub(age)).mul(0.85);
    // A bruised crimson fringe, so the smoke reads against the dark as well as the sand.
    mat.colorNode = vec4(mix(color(0x030108), color(0x5a1030), smoothstep(0.35, 0.95, r)), alpha);
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
    for (const n of this.brain.live) {
      const ground = this.hf.height(n.x, n.z);
      const pr = Math.max(0, n.presence);
      if (p < 24) this.pools.set(p++, n.x, ground, n.z, (n.kind === 'wraith' ? 2.6 : 1.9) * pr);
      if (p < 24) this.pools.set(p++, n.thorns.x, this.hf.height(n.thorns.x, n.thorns.z), n.thorns.z, 2.4 * pr);
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

  /** 0..1: how close the nearest one is, for the curdled post-process and the music. */
  get dread() {
    return this.brain.dread;
  }

  get live() {
    return this.brain.live;
  }

  /** Q: the little light flares; every nightmare within reach bursts. Returns false on cooldown. */
  /** cooldown: seconds before the next; the light store gates flares itself and passes 0. */
  flare(at: THREE.Vector3, cooldown = 20) {
    return this.brain.flare(at, cooldown);
  }

  get flareReady() {
    return this.brain.flareReady;
  }

  /** Resting at a light or waking: the night's nightmares all sink away. */
  clear() {
    this.brain.clear();
  }

  /** Debug: bring one out now. */
  spawn(kind: Kind, player: THREE.Vector3, lights: LightSource[]) {
    const n = this.brain.spawn(kind, player, lights);
    if (n) this.makeView(n);
  }

  private makeView(n: NightmareState) {
    const body = this.templates.get(n.kind === 'wraith' ? 'Wraith' : 'Crawler');
    const thornT = this.templates.get('NightmareThorns');
    if (!body || !thornT) return;
    const phase = uniform(0);
    const fade = uniform(0);
    const obj = this.dress(body, n.kind, phase, fade);
    const thorns = this.dress(thornT, 'thorns', phase, fade);
    thorns.position.set(n.thorns.x, this.hf.height(n.thorns.x, n.thorns.z), n.thorns.z);
    thorns.rotation.y = n.thorns.yaw;
    thorns.scale.setScalar(n.thorns.scale);
    this.group.add(obj, thorns);
    this.views.set(n.id, { obj, thorns, phase, fade });
  }

  /**
   * threat: 0 (none) to 1 (deep night). The player is caught on contact; lights repel.
   */
  update(dt: number, player: THREE.Vector3, playerSpeed: number, threat: number, lights: LightSource[]) {
    const ev = this.brain.update(dt, player, playerSpeed, threat, lights, this.templates.size > 0);
    for (const n of ev.spawned) this.makeView(n);
    for (const n of ev.removed) {
      const v = this.views.get(n.id);
      if (v) this.group.remove(v.obj, v.thorns);
      this.views.delete(n.id);
    }
    if (ev.sighted) this.onSighted?.();
    for (const kind of ev.caught) this.onCatch?.(kind);
    for (const n of this.brain.live) {
      const v = this.views.get(n.id);
      if (!v) continue;
      v.fade.value = Math.max(0, n.presence);
      v.phase.value = n.phase;
      v.obj.position.set(n.x, n.y, n.z);
      // Models face +X; heading 0 faces +Z.
      v.obj.rotation.y = n.yaw - Math.PI / 2;
    }
    this.trails(dt);
  }
}
