import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, color, cos, exp, float, fract, instancedBufferAttribute, length, mix, mod, positionLocal, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4, vertexColor } from 'three/tsl';
import type { Heightfield } from '../core/heightfield';

type N = any;

function rnd(i: number, k: number) {
  let h = Math.imul(i + 7, 374761393) ^ Math.imul(k + 29, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const SCHOOLS = 8;
const PER_SCHOOL = 26;
const KELP = 360;
const PLANKTON = 700;

/**
 * What you find when you dive: shoals of fish wheeling in the blue, kelp swaying on the seabed with
 * glowing tips, and plankton glinting round you. Placed around wherever you are in deep enough water,
 * re-laid as you swim; shoals and kelp are seen from the boat too, the plankton only underwater.
 */
export class SeaLife {
  readonly group = new THREE.Group();
  /** 0..1, how far under the eye is: the plankton only shows below. */
  readonly under = uniform(0);
  private schools = Array.from({ length: SCHOOLS }, () => uniform(new THREE.Vector4(0, -9999, 0, 0)));
  private kelpAttr: THREE.InstancedBufferAttribute | null = null;
  private lastAt = new THREE.Vector3(1e9, 0, 1e9);

  constructor(private hf: Heightfield) {
    this.group.name = 'sealife';
    this.buildKelp();
    this.buildPlankton();
  }

  /** The fish model (+X forward), from creatures.glb. */
  buildShoals(fish: THREE.BufferGeometry) {
    const g = new THREE.InstancedBufferGeometry();
    for (const [k, a] of Object.entries(fish.attributes)) g.setAttribute(k, a);
    g.setIndex(fish.index);
    const data = new Float32Array(SCHOOLS * PER_SCHOOL * 4);
    for (let s = 0; s < SCHOOLS; s++)
      for (let k = 0; k < PER_SCHOOL; k++) {
        const i = s * PER_SCHOOL + k;
        data.set([s, rnd(s, k), 2 + rnd(k, s) * 4.5, rnd(k + 3, s + 5) - 0.5], i * 4);
      }
    g.setAttribute('fishData', new THREE.InstancedBufferAttribute(data, 4));
    g.instanceCount = SCHOOLS * PER_SCHOOL;
    const F = attribute('fishData', 'vec4') as N;
    // Each fish wheels round its shoal's centre; the shoal centres come from the CPU.
    let centre: N = vec4(0, -9999, 0, 0);
    this.schools.forEach((u, s) => {
      centre = F.x.equal(s).select(u as N, centre);
    });
    const speed = float(0.55).add(F.w.mul(0.1));
    const a = time.mul(speed).add(F.y.mul(6.2832)).add(centre.w.mul(10));
    const r = F.z;
    const bob = sin(time.mul(0.8).add(F.y.mul(17))).mul(0.5).add(F.w.mul(1.6));
    const phi = a.negate().sub(Math.PI / 2);
    const lp = positionLocal.mul(1.1) as N;
    // A swimming wiggle down the body (nose at +X).
    const wig = sin(time.mul(9).add(F.y.mul(40)).sub(lp.x.mul(14))).mul(0.03).mul(smoothstep(0.05, -0.2, lp.x));
    const local: N = vec3(lp.x, lp.y, lp.z.add(wig));
    const rx: N = local.x.mul(cos(phi)).add(local.z.mul(sin(phi)));
    const rz: N = local.x.negate().mul(sin(phi)).add(local.z.mul(cos(phi)));
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    mat.positionNode = vec3(rx.add(centre.x).add(cos(a).mul(r)), local.y.add(centre.y).add(bob), rz.add(centre.z).add(sin(a).mul(r)));
    // Silver-blue backs with a few glowing flank spots, fading into the blue with distance.
    const vc = vertexColor() as N;
    const spots = smoothstep(0.92, 1, fract(sin(F.y.mul(91.7).add(lp.x.mul(60))).mul(437.5))).mul(0.8);
    const dist = length(vec3(centre.x, centre.y, centre.z).sub(cameraPosition));
    mat.colorNode = mix(color(0x5a7ab8), color(0xe0ecff), vc.g.mul(0.6).add(0.2)).mul(1.4).add(color(0x7ff0ff).mul(spots)).mul(smoothstep(60, 15, dist).mul(0.5).add(0.5));
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.name = 'shoals';
    this.group.add(mesh);
  }

  private buildKelp() {
    const base = new THREE.PlaneGeometry(0.28, 1, 1, 8);
    base.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a);
    g.setIndex(base.index);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(KELP * 4), 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('kelp', attr);
    g.instanceCount = KELP;
    this.kelpAttr = attr;
    const K = attribute('kelp', 'vec4') as N;
    const h = positionLocal.y as N; // 0 at the root, 1 at the tip
    const tall = float(2.2).add(fract(K.w.mul(13.1)).mul(4.5));
    const sway = sin(time.mul(0.9).add(K.w.mul(30)).add(h.mul(2.2))).mul(h.mul(h)).mul(0.9);
    const turn = K.w.mul(6.2832);
    const lx = positionLocal.x.mul(float(1).sub(h.mul(0.5)));
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    mat.positionNode = vec3(K.x.add(lx.mul(cos(turn))).add(sway), K.y.add(h.mul(tall)), K.z.add(lx.mul(sin(turn))).add(sway.mul(0.6)));
    const tip = smoothstep(0.82, 1, h);
    mat.colorNode = mix(color(0x0d2a24), color(0x2f6a50), h).add(color(0x5ff2e0).mul(tip).mul(sin(time.mul(1.4).add(K.w.mul(40))).mul(0.3).add(0.8)));
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.name = 'kelp';
    this.group.add(mesh);
  }

  private buildPlankton() {
    const span = 22;
    const a = new Float32Array(PLANKTON * 4);
    for (let i = 0; i < PLANKTON * 4; i++) a[i] = rnd(i, 91);
    const s = instancedBufferAttribute(new THREE.InstancedBufferAttribute(a, 4), 'vec4') as N;
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const half = float(span / 2);
    const drift = vec3(sin(time.mul(0.2).add(s.w.mul(30))), sin(time.mul(0.13).add(s.x.mul(20))).mul(0.5).add(time.mul(0.05)), cos(time.mul(0.17).add(s.y.mul(25)))).mul(1.5);
    const local = mod(vec3(s.x, s.y, s.z).mul(span).add(drift).sub(cameraPosition).add(half), float(span)).sub(half) as N;
    const pos = local.add(cameraPosition) as N;
    mat.positionNode = vec3(pos.x, pos.y.min(-0.2), pos.z);
    const d = length(local);
    const twinkle = sin(time.mul(s.w.mul(3).add(1)).add(s.z.mul(60))).mul(0.5).add(0.5);
    mat.scaleNode = vec2(0.055, 0.055).mul(this.under as N) as N;
    const r = length(uv().sub(0.5)).mul(2);
    mat.colorNode = vec4(color(0x9ff8ff).mul(exp(r.mul(-6)).mul(smoothstep(1, 0.6, r))).mul(twinkle).mul(smoothstep(half, half.mul(0.4), d)).mul(this.under as N).mul(1.6), 1);
    const sprite = new THREE.Sprite(mat);
    sprite.count = PLANKTON;
    sprite.frustumCulled = false;
    sprite.renderOrder = 4;
    sprite.name = 'plankton';
    this.group.add(sprite);
  }

  /** focus: the camera; underwater: 0..1 eased by the caller. */
  update(focus: THREE.Vector3, underwater: number) {
    this.under.value = underwater;
    if (focus.distanceToSquared(this.lastAt) < 300) return;
    this.lastAt.copy(focus);
    // Shoals: deep water within reach, swimming at a depth between the seabed and the surface.
    let s = 0;
    for (let k = 0; k < 40 && s < SCHOOLS; k++) {
      const a = rnd(Math.floor(focus.x / 40) + k, Math.floor(focus.z / 40)) * Math.PI * 2;
      const d = 8 + rnd(k, Math.floor(focus.x / 40)) * 34;
      const x = Math.floor((focus.x + Math.cos(a) * d) / 20) * 20 + 10;
      const z = Math.floor((focus.z + Math.sin(a) * d) / 20) * 20 + 10;
      const h = this.hf.height(x, z);
      if (h > -4.5) continue;
      const y = Math.max(h + 2, -2.2 - rnd(x, z) * Math.min(8, -h - 3));
      this.schools[s].value.set(x, y, z, rnd(z, x));
      s++;
    }
    for (; s < SCHOOLS; s++) this.schools[s].value.set(0, -9999, 0, 0);
    // Kelp: seabed from 2 to 14 m down, in patches.
    const arr = this.kelpAttr!.array as Float32Array;
    let n = 0;
    const CELL = 3.2;
    const R = 60;
    const i0 = Math.floor((focus.x - R) / CELL);
    const j0 = Math.floor((focus.z - R) / CELL);
    for (let j = j0; j < j0 + (2 * R) / CELL && n < KELP; j++)
      for (let i = i0; i < i0 + (2 * R) / CELL && n < KELP; i++) {
        const patch = rnd(Math.floor(i / 6), Math.floor(j / 6));
        if (patch < 0.55 || rnd(i, j) > 0.5) continue;
        const x = (i + rnd(i + 1, j)) * CELL;
        const z = (j + rnd(j, i + 2)) * CELL;
        const h = this.hf.height(x, z);
        if (h > -2 || h < -14) continue;
        arr.set([x, h, z, rnd(i + 5, j + 9)], n * 4);
        n++;
      }
    for (let k = n; k < KELP; k++) arr.set([0, -9999, 0, 0], k * 4);
    this.kelpAttr!.needsUpdate = true;
  }
}
