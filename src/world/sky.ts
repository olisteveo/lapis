import * as THREE from 'three/webgpu';
import {
  cameraPosition, color, dot, exp, float, fract, floor, hash, instancedBufferAttribute, length, mix, mx_fractal_noise_float,
  normalize, positionGeometry, positionLocal, pow, saturate, sin, smoothstep, step, time, uniform, uv, vec2, vec3, vec4, abs, max,
} from 'three/tsl';
import { PALETTE, SKY } from '../config';
import { mulberry32 } from './heightfield';
import { starShape } from '../render/starShape';

const SKY_RADIUS = 15000;
const STAR_RADIUS = 12000;

function skyDome() {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  mat.positionNode = positionLocal.mul(SKY_RADIUS).add(cameraPosition);
  const dir = normalize(positionGeometry);
  const el = dir.y;
  const moonDir = vec3(SKY.moon.x, SKY.moon.y, SKY.moon.z);
  const starDir = vec3(SKY.brightStar.x, SKY.brightStar.y, SKY.brightStar.z);

  let col = mix(color(PALETTE.horizon), color(PALETTE.sky), smoothstep(-0.02, 0.22, el));
  col = mix(col, color(PALETTE.zenith), smoothstep(0.18, 0.95, el));
  col = mix(col, color(PALETTE.fog).mul(0.7), smoothstep(0.0, -0.08, el));

  const toMoon = saturate(dot(dir, moonDir));
  col = col.add(color(PALETTE.moon).mul(pow(toMoon, 30).mul(0.22).add(pow(toMoon, 6).mul(0.025))));
  col = col.add(color(PALETTE.starWhite).mul(pow(saturate(dot(dir, starDir)), 900).mul(0.12)));

  // Long horizontal cloud streaks low on the horizon, as in the lake painting.
  const cn = mx_fractal_noise_float(vec3(dir.x.mul(2.4), dir.y.mul(30), dir.z.mul(2.4)).add(vec3(time.mul(0.002), 0, 0)), 4);
  const band = smoothstep(-0.01, 0.04, el).mul(smoothstep(0.24, 0.06, el));
  const cloud = smoothstep(0.02, 0.4, cn).mul(band);
  const cloudLit = mix(color(PALETTE.cloud).mul(0.55), color(PALETTE.cloud), smoothstep(-0.2, 0.4, cn)).add(color(PALETTE.moon).mul(pow(toMoon, 6).mul(0.4)));
  col = mix(col, cloudLit, cloud.mul(0.5));

  // Dust of tiny stars, denser along a Milky Way band that runs toward the bright one.
  const bandN = normalize(vec3(0.9, 0.25, 0.35));
  const milky = exp(pow(dot(dir, bandN).div(0.2), 2).negate());
  const cell = floor(dir.mul(900));
  const seed = hash(dot(cell, vec3(12.9898, 78.233, 37.719)));
  const thresh = mix(0.9965, 0.985, milky);
  const twinkle = sin(time.mul(seed.mul(1.2).add(0.4)).add(seed.mul(100))).mul(0.12).add(0.88);
  const tiny = step(thresh, seed).mul(twinkle).mul(smoothstep(0.0, 0.08, el)).mul(cloud.oneMinus());
  const tint = mix(color(PALETTE.starWhite), color(PALETTE.starGold), fract(seed.mul(17)));
  col = col.add(tint.mul(tiny).mul(0.9));
  col = col.add(vec3(0.05, 0.06, 0.16).mul(milky).mul(smoothstep(0.0, 0.2, el)));

  mat.colorNode = col;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return mesh;
}

function starField(count: number) {
  const rnd = mulberry32(99);
  const a = new Float32Array(count * 4);
  const b = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const azm = rnd() * Math.PI * 2;
    // Bias toward the horizon slightly; real skies look fuller low down.
    const el = Math.asin(Math.pow(rnd(), 1.4) * 0.97 + 0.02);
    a[i * 4] = Math.sin(azm) * Math.cos(el);
    a[i * 4 + 1] = Math.sin(el);
    a[i * 4 + 2] = -Math.cos(azm) * Math.cos(el);
    a[i * 4 + 3] = 0.0016 + 0.0075 * Math.pow(rnd(), 9);
    const gold = rnd() < 0.55 ? 1 : 0;
    b[i * 4] = gold;
    b[i * 4 + 1] = rnd();
    b[i * 4 + 2] = 0.4 + rnd() * 0.6;
    b[i * 4 + 3] = 0;
  }
  const dirSize = instancedBufferAttribute(new THREE.InstancedBufferAttribute(a, 4), 'vec4') as any;
  const meta = instancedBufferAttribute(new THREE.InstancedBufferAttribute(b, 4), 'vec4') as any;

  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  mat.positionNode = cameraPosition.add(dirSize.xyz.mul(STAR_RADIUS));
  const tw = sin(time.mul(meta.y.mul(1.1).add(0.3)).add(meta.y.mul(40))).mul(0.1).add(0.9);
  mat.scaleNode = vec2(dirSize.w.mul(STAR_RADIUS));
  const shape = starShape(uv(), dirSize.w.mul(110).min(0.95), float(0));
  const tint = mix(color(PALETTE.starWhite), color(PALETTE.starGold), meta.x);
  const fade = smoothstep(0.0, 0.06, dirSize.y);
  mat.colorNode = vec4(tint.mul(shape).mul(meta.z).mul(tw).mul(fade).mul(1.6), 1);
  const sprite = new THREE.Sprite(mat);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = -9;
  sprite.name = 'stars';
  return sprite;
}

function heroStar() {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const d = SKY.brightStar;
  mat.positionNode = cameraPosition.add(vec3(d.x, d.y, d.z).mul(STAR_RADIUS));
  const pulse = sin(time.mul(0.7)).mul(0.06).add(1);
  mat.scaleNode = vec2(float(STAR_RADIUS * 0.11).mul(pulse));
  const s = starShape(uv(), float(1), float(0.7));
  mat.colorNode = vec4(mix(color(PALETTE.starWhite), color(PALETTE.starGold), 0.35).mul(s).mul(2.2), 1);
  const sprite = new THREE.Sprite(mat);
  sprite.frustumCulled = false;
  sprite.renderOrder = -8;
  sprite.name = 'brightStar';
  return sprite;
}

function moon() {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const d = SKY.moon;
  mat.positionNode = cameraPosition.add(vec3(d.x, d.y, d.z).mul(STAR_RADIUS));
  mat.scaleNode = vec2(float(STAR_RADIUS * 0.09));
  const q = uv().mul(2).sub(1);
  const r = length(q);
  const disc = smoothstep(0.36, 0.33, r);
  const shadow = smoothstep(0.31, 0.35, length(q.sub(vec2(0.13, 0.06))));
  const crescent = disc.mul(shadow.mul(0.85).add(0.15));
  const halo = exp(r.mul(-6)).mul(0.04);
  // Painted texture on the disc so it reads as the orange rising moon of ref 1, not a flat circle.
  const mottling = mx_fractal_noise_float(vec3(q.mul(6), 1.0), 3).mul(0.15).add(0.92);
  // Kept below the bloom threshold: a bright moon near the horizon gets smeared into rays.
  mat.colorNode = vec4(color(PALETTE.moon).mul(crescent.mul(mottling).mul(0.62).add(halo)), 1);
  const sprite = new THREE.Sprite(mat);
  sprite.frustumCulled = false;
  sprite.renderOrder = -8;
  sprite.name = 'moon';
  return sprite;
}

/** A falling star: streaks across the sky and drops into the sea. */
export class ShootingStar {
  readonly sprite: THREE.Sprite;
  private t = uniform(-1);
  private from = uniform(new THREE.Vector3());
  private to = uniform(new THREE.Vector3());
  private angle = uniform(0);
  private life = 1.6;
  private elapsed = -1;

  constructor() {
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const k = saturate(this.t);
    const eased = k.mul(k).mul(0.6).add(k.mul(0.4));
    const dirNow = normalize(mix(this.from, this.to, eased));
    mat.positionNode = cameraPosition.add(dirNow.mul(STAR_RADIUS * 0.9));
    mat.rotationNode = this.angle;
    mat.scaleNode = vec2(float(STAR_RADIUS * 0.12), float(STAR_RADIUS * 0.012));
    const p = uv();
    // Head at the right, tail fading left.
    const head = exp(length(vec2(p.x.sub(0.92).mul(4), p.y.sub(0.5))).mul(-12));
    const tail = smoothstep(0.0, 0.92, p.x).mul(exp(abs(p.y.sub(0.5)).mul(-30)));
    const alive = step(0.0, this.t).mul(step(this.t, 1.0)).mul(smoothstep(1.0, 0.75, this.t));
    mat.colorNode = vec4(color(PALETTE.starWhite).mul(max(head.mul(3), tail.mul(1.2))).mul(alive).mul(2), 1);
    this.sprite = new THREE.Sprite(mat);
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = -7;
    this.sprite.name = 'shootingStar';
  }

  /** Fire across the sky between two directions. */
  fire(from: THREE.Vector3, to: THREE.Vector3, life = 1.6) {
    this.from.value.copy(from).normalize();
    this.to.value.copy(to).normalize();
    this.life = life;
    this.elapsed = 0;
  }

  private dirAt(t: number, out: THREE.Vector3) {
    const k = Math.min(1, Math.max(0, t));
    const e = k * k * 0.6 + k * 0.4;
    return out.copy(this.from.value).lerp(this.to.value, e).normalize();
  }

  /** Orients the streak along its actual on-screen motion, whatever way the camera faces. */
  update(dt: number, camera?: THREE.Camera) {
    if (this.elapsed < 0) return;
    this.elapsed += dt;
    const t = this.elapsed / this.life;
    this.t.value = t;
    if (camera) {
      const a = this.dirAt(t, new THREE.Vector3()).add(camera.position).project(camera);
      const b = this.dirAt(t - 0.03, new THREE.Vector3()).add(camera.position).project(camera);
      const aspect = (camera as THREE.PerspectiveCamera).aspect ?? 1;
      this.angle.value = Math.atan2(a.y - b.y, (a.x - b.x) * aspect);
    }
    if (this.elapsed > this.life) this.elapsed = -1;
  }
}

export function createSky() {
  const group = new THREE.Group();
  group.name = 'skyGroup';
  group.add(skyDome(), starField(2600), heroStar(), moon());
  const shooting = new ShootingStar();
  group.add(shooting.sprite);
  return { group, shooting };
}
