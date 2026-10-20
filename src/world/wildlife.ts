import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, color, cos, dot, exp, float, floor, length, mix, normalGeometry, normalView, positionLocal, saturate, sin, smoothstep, time, uniform, uv, vec3, vec4, vertexColor } from 'three/tsl';
import { hash } from '../render/seed';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, SKY } from '../config';
import type { Heightfield } from '../core/heightfield';

type N = any;

function rnd(i: number, k: number) {
  let h = Math.imul(i + 3, 374761393) ^ Math.imul(k + 11, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
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

function mergedGeometry(root: THREE.Object3D) {
  const parts: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    parts.push(g.index ? g.toNonIndexed() : g);
  });
  // Concatenate non-indexed parts (keeps position, normal, color).
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const size = name === 'color' ? 4 : 3;
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const g of parts) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      const n = g.attributes.position.count;
      // getComponent applies normalisation: glTF vertex colours arrive as 16-bit integers.
      if (a) for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) arr[(o + i) * size + c] = c < a.itemSize ? a.getComponent(i, c) : 1;
      o += n;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  const idx = new Uint32Array(total).map((_, i) => i);
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

const FLOCKS = 5;
const PER_FLOCK = 12;
const JELLIES = 70;

/**
 * The world's living things. Everything is placed relative to the player and animated in
 * the vertex shader, so it costs almost nothing when there's nothing nearby.
 */
export class Wildlife {
  readonly group = new THREE.Group();
  private flockCentres: THREE.Vector3[] = [];
  private birdAttrs: Record<string, THREE.InstancedBufferAttribute> | null = null;
  private jellyAttrs: Record<string, THREE.InstancedBufferAttribute> | null = null;
  private jellyGlow: THREE.InstancedBufferAttribute | null = null;
  private lastJelly = new THREE.Vector3(1e9, 0, 1e9);
  private fish: { mesh: THREE.Object3D; t: number; from: THREE.Vector3; dir: THREE.Vector3; height: number }[] = [];
  private fishTimer = 3;
  private whale: THREE.Object3D | null = null;
  private whaleT = -1;
  private whaleTimer = 45;
  private whaleFrom = new THREE.Vector3();
  private whaleDir = new THREE.Vector3();
  private rings: { sprite: THREE.Sprite; t: number; life: number; size: number; strength: { value: number } }[] = [];
  /** Called with (kind, world position) so audio can play splashes and song. */
  onEvent: ((kind: 'splash' | 'bigSplash' | 'whale', at: THREE.Vector3) => void) | null = null;

  constructor(private hf: Heightfield) {
    this.group.name = 'wildlife';
    for (let i = 0; i < 10; i++) this.rings.push(this.makeRing());
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const get = (n: string) => gltf.scene.getObjectByName(n);
    const bird = get('Bird');
    const jelly = get('Jellyfish');
    const fish = get('Fish');
    const whale = get('Whale');
    if (bird) this.buildBirds(mergedGeometry(bird));
    if (jelly) this.buildJellies(mergedGeometry(jelly));
    if (fish) {
      const geo = mergedGeometry(fish);
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      mat.colorNode = mix(color(0x9fb4ff), color(PALETTE.starWhite), vertexColor().g.mul(0.5)).mul(1.3);
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.visible = false;
        this.group.add(m);
        this.fish.push({ mesh: m, t: -1, from: new THREE.Vector3(), dir: new THREE.Vector3(), height: 2 });
      }
    }
    if (whale) this.buildWhale(mergedGeometry(whale));
    return { bird: !!bird, jelly: !!jelly, fish: !!fish, whale: !!whale };
  }

  // ---------------------------------------------------------------- birds

  private buildBirds(base: THREE.BufferGeometry) {
    const count = FLOCKS * PER_FLOCK;
    const { geometry, attrs } = instanced(base, count, { flock: 4, bird: 4 });
    this.birdAttrs = attrs;
    for (let f = 0; f < FLOCKS; f++) this.flockCentres.push(new THREE.Vector3(1e9, 0, 1e9));
    for (let i = 0; i < count; i++) {
      const b = attrs.bird.array as Float32Array;
      const dirSign = rnd(Math.floor(i / PER_FLOCK), 5) > 0.5 ? 1 : -1;
      b[i * 4] = (0.12 + rnd(i, 1) * 0.05) * dirSign; // angular speed
      b[i * 4 + 1] = rnd(i, 2) * Math.PI * 2; // phase around the circle
      b[i * 4 + 2] = rnd(i, 3); // personal offset
      b[i * 4 + 3] = 0.8 + rnd(i, 4) * 0.4; // size
    }
    const fl = attrs.flock;
    const bd = attrs.bird;
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const F = attribute('flock', 'vec4') as N;
    const B = attribute('bird', 'vec4') as N;
    const vc = vertexColor() as N;
    const a = time.mul(B.x).add(B.y);
    const r = F.w.mul(B.z.mul(0.5).add(0.75));
    const tx = sin(a).negate().mul(B.x.sign());
    const tz = cos(a).mul(B.x.sign());
    const centre: N = vec3(F.x, F.y.add(sin(time.mul(0.6).add(B.y)).mul(2.5)).add(B.z.mul(6)), F.z);
    const pos = centre.add(vec3(cos(a).mul(r) as N, 0, sin(a).mul(r) as N));
    // Wings beat in bursts, then glide.
    const beat = sin(time.mul(7.5).add(B.y.mul(5))).mul(smoothstep(-0.2, 0.4, sin(time.mul(0.9).add(B.z.mul(9)))));
    const lp = positionLocal.mul(B.w) as N;
    const flapped: N = vec3(lp.x, lp.y.add(abs(lp.z).mul(beat).mul(0.7).mul(vc.g)), lp.z);
    // Yaw the bird so +X follows its heading, and bank into the turn.
    const yaw: N = tz.atan(tx).negate();
    const cy: N = cos(yaw);
    const sy: N = sin(yaw);
    const bank = float(0.35).mul(B.x.sign());
    const by: N = flapped.y.mul(cos(bank)).sub(flapped.z.mul(sin(bank)));
    const bz: N = flapped.y.mul(sin(bank)).add(flapped.z.mul(cos(bank)));
    mat.positionNode = vec3(flapped.x.mul(cy).add(bz.mul(sy)), by, bz.mul(cy).sub(flapped.x.mul(sy))).add(pos);
    const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);
    mat.colorNode = color(0xe9e0d4).mul(saturate(abs(dot(normalGeometry, key))).mul(0.4).add(0.55));
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.frustumCulled = false;
    mesh.name = 'birds';
    this.group.add(mesh);
    void fl;
    void bd;
  }

  private updateBirds(focus: THREE.Vector3) {
    if (!this.birdAttrs) return;
    const fl = this.birdAttrs.flock.array as Float32Array;
    let dirty = false;
    this.flockCentres.forEach((c, f) => {
      if (Math.hypot(c.x - focus.x, c.z - focus.z) < 650) return;
      // Re-seat the flock over a stretch of coast or open water near the player.
      for (let tries = 0; tries < 40; tries++) {
        const ang = Math.random() * Math.PI * 2;
        const d = 120 + Math.random() * 380;
        const x = focus.x + Math.sin(ang) * d;
        const z = focus.z + Math.cos(ang) * d;
        const h = this.hf.height(x, z);
        if (h > 6 || (f % 2 === 0 && h < -4)) continue;
        c.set(x, Math.max(h, 0) + 18 + Math.random() * 18, z);
        break;
      }
      for (let i = 0; i < PER_FLOCK; i++) {
        const k = f * PER_FLOCK + i;
        fl[k * 4] = c.x;
        fl[k * 4 + 1] = c.y;
        fl[k * 4 + 2] = c.z;
        fl[k * 4 + 3] = 22 + rnd(f, 9) * 30;
      }
      dirty = true;
    });
    if (dirty) this.birdAttrs.flock.needsUpdate = true;
  }

  // ---------------------------------------------------------------- jellyfish

  private buildJellies(base: THREE.BufferGeometry) {
    const { geometry, attrs } = instanced(base, JELLIES, { jelly: 4 });
    this.jellyAttrs = attrs;
    const J = attribute('jelly', 'vec4') as N;
    const vc = vertexColor() as N;
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pulse = sin(time.mul(1.8).add(J.w.mul(6.28)));
    const lp = positionLocal.mul(J.w.mul(0.0).add(0.9)) as N;
    const bell = float(1).sub(vc.g);
    const squeeze = vec3(float(1).add(pulse.mul(0.12).mul(bell)), float(1).sub(pulse.mul(0.08).mul(bell)), float(1).add(pulse.mul(0.12).mul(bell)));
    const sway = vec3(sin(time.mul(1.1).add(vc.r.mul(4)).add(J.w.mul(20))).mul(vc.r).mul(0.25) as N, 0, cos(time.mul(0.9).add(vc.r.mul(3))).mul(vc.r).mul(0.25) as N).mul(vc.g);
    // Jellyfish model is Z-up with origin at its centre; drift slowly in a small circle.
    const drift = vec3(sin(time.mul(0.07).add(J.w.mul(30))).mul(3), sin(time.mul(0.5).add(J.w.mul(9))).mul(0.06), cos(time.mul(0.06).add(J.w.mul(30))).mul(3));
    mat.positionNode = lp.mul(squeeze).add(sway).add(J.xyz).add(drift);
    const tint = mix(color(PALETTE.coral), color(0x8fd4ff), smoothstep(0.3, 0.7, J.w));
    // Tentacles stay faint and the whole animal fades up close: a bright additive strand next to
    // the camera would streak right across the view.
    const camDist = (cameraPosition as N).sub(J.xyz).length();
    const nearFade = smoothstep(4, 12, camDist);
    mat.colorNode = tint.mul(bell.mul(0.7).add(vc.g.mul(float(1).sub(vc.r)).mul(0.15))).mul(pulse.mul(0.2).add(0.9)).mul(nearFade);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.name = 'jellyfish';
    this.group.add(mesh);

    // A soft halo on the surface above each one, so the glow reads through the water.
    const glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(JELLIES * 4), 4);
    glowAttr.setUsage(THREE.DynamicDrawUsage);
    this.jellyGlow = glowAttr;
    const G = (attribute as N)('jellyGlow', 'vec4');
    const halo = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    halo.positionNode = vec3(G.x.add(sin(time.mul(0.07).add(G.w.mul(30))).mul(3)), 0.08, G.z.add(cos(time.mul(0.06).add(G.w.mul(30))).mul(3)));
    halo.scaleNode = vec3(2.4, 2.4, 1) as N;
    const rr = length(uv().sub(0.5)).mul(2);
    halo.colorNode = vec4(mix(color(PALETTE.coral), color(0x8fd4ff), smoothstep(0.3, 0.7, G.w)).mul(exp(rr.mul(-4)).mul(0.5).mul(smoothstep(1, 0.7, rr))).mul(sin(time.mul(1.8).add(G.w.mul(6.28))).mul(0.3).add(0.8)), 1);
    const sprite = new THREE.Sprite(halo);
    sprite.count = JELLIES;
    sprite.frustumCulled = false;
    sprite.renderOrder = 3;
    sprite.name = 'jellyHalo';
    sprite.geometry = sprite.geometry.clone();
    (sprite.geometry as THREE.BufferGeometry).setAttribute('jellyGlow', glowAttr);
    this.group.add(sprite);
  }

  private updateJellies(focus: THREE.Vector3) {
    if (!this.jellyAttrs || focus.distanceToSquared(this.lastJelly) < 400) return;
    this.lastJelly.copy(focus);
    const a = this.jellyAttrs.jelly.array as Float32Array;
    const g = this.jellyGlow!.array as Float32Array;
    let n = 0;
    const CELL = 18;
    const R = 170;
    const i0 = Math.floor((focus.x - R) / CELL);
    const j0 = Math.floor((focus.z - R) / CELL);
    for (let j = j0; j < j0 + (2 * R) / CELL && n < JELLIES; j++)
      for (let i = i0; i < i0 + (2 * R) / CELL && n < JELLIES; i++) {
        if (rnd(i, j * 3 + 1) > 0.16) continue;
        const x = (i + rnd(i, j)) * CELL;
        const z = (j + rnd(j, i)) * CELL;
        const h = this.hf.height(x, z);
        if (h > -0.7 || h < -9) continue;
        const ph = rnd(i + 17, j);
        a.set([x, -0.35, z, ph], n * 4);
        g.set([x, 0, z, ph], n * 4);
        n++;
      }
    for (let k = n; k < JELLIES; k++) {
      a.set([0, -9999, 0, 0], k * 4);
      g.set([0, -9999, 0, 0], k * 4);
    }
    this.jellyAttrs.jelly.needsUpdate = true;
    this.jellyGlow!.needsUpdate = true;
  }

  // ---------------------------------------------------------------- splash rings

  private makeRing() {
    const strength = uniform(0);
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = length(uv().sub(0.5)).mul(2);
    const ring = exp(abs(r.sub(0.75)).mul(-18)).add(exp(r.mul(-6)).mul(0.25));
    mat.colorNode = vec4(color(PALETTE.foam).mul(ring).mul(strength), 1);
    const s = new THREE.Sprite(mat);
    s.visible = false;
    this.group.add(s);
    return { sprite: s, t: -1, life: 1.2, size: 3, strength };
  }

  private ring(at: THREE.Vector3, size: number, life = 1.4) {
    const r = this.rings.find((x) => x.t < 0) ?? this.rings[0];
    r.t = 0;
    r.life = life;
    r.size = size;
    r.sprite.position.set(at.x, 0.12, at.z);
    r.sprite.visible = true;
  }

  // ---------------------------------------------------------------- fish

  private updateFish(dt: number, focus: THREE.Vector3, camera: THREE.Camera) {
    if (!this.fish.length) return;
    this.fishTimer -= dt;
    if (this.fishTimer <= 0) {
      this.fishTimer = 2.5 + Math.random() * 5;
      const f = this.fish.find((x) => x.t < 0);
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      if (f) {
        const ang = Math.atan2(fwd.x, fwd.z) + (Math.random() - 0.5) * 1.6;
        const d = 18 + Math.random() * 90;
        const x = focus.x + Math.sin(ang) * d;
        const z = focus.z + Math.cos(ang) * d;
        if (this.hf.height(x, z) < -1.5) {
          const dir = Math.random() * Math.PI * 2;
          f.from.set(x, 0, z);
          f.dir.set(Math.sin(dir), 0, Math.cos(dir));
          f.height = 1 + Math.random() * 1.6;
          f.t = 0;
          f.mesh.visible = true;
          this.ring(f.from, 2.2);
          this.onEvent?.('splash', f.from);
        }
      }
    }
    for (const f of this.fish) {
      if (f.t < 0) continue;
      f.t += dt / 0.9;
      const t = Math.min(1, f.t);
      const p = f.from.clone().addScaledVector(f.dir, t * 3.2);
      p.y = 4 * f.height * t * (1 - t) - 0.2;
      f.mesh.position.copy(p);
      const vy = 4 * f.height * (1 - 2 * t);
      f.mesh.rotation.set(0, Math.atan2(-f.dir.z, f.dir.x), Math.atan2(vy, 3.2), 'YXZ');
      f.mesh.scale.setScalar(1.1);
      if (f.t >= 1) {
        f.t = -1;
        f.mesh.visible = false;
        this.ring(p, 1.8);
      }
    }
  }

  // ---------------------------------------------------------------- whale

  private buildWhale(geo: THREE.BufferGeometry) {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const p = positionLocal as N;
    const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);
    // A whale made of the night sky: deep blue body, scattered with its own stars.
    // Stars big enough to read from a few hundred metres: a soft disc in one cell in eight.
    const sp = p.mul(0.9) as N;
    const cell = floor(sp) as N;
    const h = hash(cell.x.add(cell.y.mul(57)).add(cell.z.mul(113)));
    const disc = smoothstep(0.32, 0.08, length(sp.sub(cell).sub(0.5)));
    const stars = smoothstep(0.86, 0.95, h).mul(disc).mul(sin(time.mul(3).add(h.mul(50))).mul(0.3).add(0.9));
    const lambert = saturate(dot(normalGeometry, key).mul(0.5).add(0.5));
    const rim = float(1).sub(abs(normalView.z)).pow(2.5);
    // A pale, luminous belly, like the Milky Way along its underside.
    const belly = smoothstep(0.2, -0.6, normalGeometry.y);
    mat.colorNode = color(0x14205a).mul(lambert.mul(0.8).add(0.3))
      .add(color(0x8fa8ff).mul(rim).mul(0.45))
      .add(color(0x9fb8ff).mul(belly.mul(0.35)))
      .add(color(PALETTE.starWhite).mul(stars).mul(2.4));
    const whale = new THREE.Mesh(geo, mat);
    whale.visible = false;
    whale.frustumCulled = false;
    whale.name = 'whale';
    this.whale = whale;
    this.group.add(whale);
  }

  private updateWhale(dt: number, focus: THREE.Vector3, camera: THREE.Camera, atSea: boolean) {
    const w = this.whale;
    if (!w) return;
    if (this.whaleT < 0) {
      if (!atSea) return;
      this.whaleTimer -= dt;
      if (this.whaleTimer > 0) return;
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      for (let tries = 0; tries < 20; tries++) {
        const ang = Math.atan2(fwd.x, fwd.z) + (Math.random() - 0.5) * 1.4;
        const d = 180 + Math.random() * 260;
        const x = focus.x + Math.sin(ang) * d;
        const z = focus.z + Math.cos(ang) * d;
        if (this.hf.height(x, z) > -14) continue;
        const heading = ang + Math.PI / 2 + (Math.random() - 0.5);
        this.whaleFrom.set(x, 0, z);
        this.whaleDir.set(Math.sin(heading), 0, Math.cos(heading));
        this.whaleT = 0;
        w.visible = true;
        this.onEvent?.('whale', this.whaleFrom);
        break;
      }
      this.whaleTimer = 150 + Math.random() * 150;
      return;
    }
    this.whaleT += dt / 7;
    const s = this.whaleT;
    // Rise steeply, clear the water, roll, and fall back on its side.
    const y = -16 + 26 * Math.sin(Math.PI * Math.min(1, s * 1.05));
    const vy = 26 * Math.PI * 1.05 * Math.cos(Math.PI * Math.min(1, s * 1.05));
    const p = this.whaleFrom.clone().addScaledVector(this.whaleDir, s * 24);
    p.y = y;
    w.position.copy(p);
    w.rotation.set(s * 1.8, Math.atan2(-this.whaleDir.z, this.whaleDir.x), Math.atan2(vy, 24 / 7 * 7) * 0.9, 'YZX');
    w.scale.setScalar(1);
    const prevY = -16 + 26 * Math.sin(Math.PI * Math.min(1, (s - dt / 7) * 1.05));
    if ((prevY < 0 && y >= 0) || (prevY > 0 && y <= 0)) {
      this.ring(p, 22, 3);
      this.ring(p, 12, 2);
      this.onEvent?.('bigSplash', p);
    }
    if (s >= 1) {
      this.whaleT = -1;
      w.visible = false;
    }
  }

  update(dt: number, focus: THREE.Vector3, camera: THREE.Camera, atSea: boolean) {
    this.updateBirds(focus);
    this.updateJellies(focus);
    this.updateFish(dt, focus, camera);
    this.updateWhale(dt, focus, camera, atSea);
    for (const r of this.rings) {
      if (r.t < 0) continue;
      r.t += dt / r.life;
      r.sprite.scale.setScalar(r.size * (0.3 + r.t * 1.2));
      r.strength.value = (1 - r.t) * 0.9;
      if (r.t >= 1) {
        r.t = -1;
        r.sprite.visible = false;
      }
    }
  }

  private mirrorHidden: THREE.Object3D[] = [];

  /** The reflection camera sits under the sea and would see the jellyfish unobstructed. */
  setMirror(mirror: boolean) {
    if (!this.mirrorHidden.length) this.group.children.forEach((c) => (c.name === 'jellyfish' || c.name === 'jellyHalo') && this.mirrorHidden.push(c));
    for (const o of this.mirrorHidden) o.visible = !mirror;
  }

  /** Debug: force a whale breach on the next frame. */
  summonWhale() {
    this.whaleTimer = 0;
  }
}
