import * as THREE from 'three/webgpu';
import { color, float, mix, sin, time, uniform, uv, vec4 } from 'three/tsl';
import { PALETTE } from '../config';
import { starShape } from '../render/starShape';
import type { ConstellationDef } from './content';

const R = 10000;

/**
 * A constellation drawn into the sky. Unlit stars sit faint and cold so you can see the
 * shape you're working toward; each gathered star ignites, and lines draw between lit pairs.
 */
export class Constellation {
  readonly group = new THREE.Group();
  readonly dirs: THREE.Vector3[];
  private lit: { value: number }[] = [];
  private litTarget: number[];
  private lines: { a: number; b: number; geo: THREE.BufferGeometry; mat: THREE.LineBasicNodeMaterial; t: number }[] = [];
  private complete = uniform(0);

  constructor(readonly def: ConstellationDef) {
    this.group.name = `constellation-${def.id}`;
    const az = THREE.MathUtils.degToRad(def.azimuth);
    const el = THREE.MathUtils.degToRad(def.elevation);
    const centre = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    const right = new THREE.Vector3().crossVectors(centre, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, centre).normalize();
    this.dirs = def.stars.map(([u, v]) => centre.clone().addScaledVector(right, u * def.scale).addScaledVector(up, v * def.scale).normalize());
    this.litTarget = def.stars.map(() => 0);

    this.dirs.forEach((d, i) => {
      const lit = uniform(0);
      this.lit.push(lit);
      const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const tw = sin(time.mul(1.3).add(i * 2.1)).mul(0.12).add(1);
      // Unlit stars stay cold but legible, so the shape you're completing is readable.
      const cold = color(0x8ea2f0).mul(sin(time.mul(0.9).add(i)).mul(0.15).add(0.75));
      const warm = mix(color(PALETTE.starWhite), color(PALETTE.starGold), 0.3).mul(float(2.4).add(this.complete.mul(sin(time.mul(2).add(i)).mul(0.8).add(0.8))));
      mat.colorNode = vec4(mix(cold, warm, lit).mul(starShape(uv(), lit.mul(0.5).add(0.35), lit.mul(0.4))).mul(tw), 1);
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(d).multiplyScalar(R);
      sprite.scale.setScalar(R * 0.028);
      sprite.renderOrder = -6;
      sprite.frustumCulled = false;
      this.group.add(sprite);
    });

    for (const [a, b] of def.lines) {
      const geo = new THREE.BufferGeometry().setFromPoints([this.dirs[a].clone().multiplyScalar(R), this.dirs[a].clone().multiplyScalar(R)]);
      const mat = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      mat.colorNode = color(PALETTE.starGold).mul(0.7);
      mat.opacity = 0;
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = -6;
      this.group.add(line);
      this.lines.push({ a, b, geo, mat, t: 0 });
    }
  }

  light(index: number, instant = false) {
    this.litTarget[index] = 1;
    if (instant) this.lit[index].value = 1;
  }

  get litCount() {
    return this.litTarget.filter((v) => v > 0).length;
  }

  get isComplete() {
    return this.litCount === this.def.stars.length;
  }

  update(dt: number, camera: THREE.Camera) {
    // Sky objects ride with the camera so they sit at infinity.
    this.group.position.copy(camera.position);
    this.lit.forEach((u, i) => (u.value += (this.litTarget[i] - u.value) * Math.min(1, dt * 1.5)));
    for (const l of this.lines) {
      const ready = this.lit[l.a].value > 0.9 && this.lit[l.b].value > 0.9;
      if (!ready) continue;
      l.t = Math.min(1, l.t + dt / 1.8);
      const p = this.dirs[l.a].clone().lerp(this.dirs[l.b], l.t).normalize().multiplyScalar(R);
      const pos = l.geo.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(1, p.x, p.y, p.z);
      pos.needsUpdate = true;
      l.mat.opacity = 0.75 * l.t;
    }
    const target = this.isComplete ? 1 : 0;
    this.complete.value += (target - this.complete.value) * Math.min(1, dt * 0.6);
  }
}
