import * as THREE from 'three/webgpu';
import { abs, attribute, color, float, length, mix, mx_noise_float, smoothstep, time, uniform, uv, vec2, vec4 } from 'three/tsl';
import { LAGOONS, type Heightfield } from '../core/heightfield';
import { penLines } from '../render/drawn';

type N = any;

export interface Fall {
  /** Where the curtain meets the pool. */
  x: number;
  z: number;
  /** Lip of the notch it pours from. */
  lip: THREE.Vector3;
  /** Unit direction from the lagoon's centre toward the falls. */
  dir: { x: number; z: number };
  /** A spot on the ledge behind the curtain. */
  behind: { x: number; z: number };
}

/** One waterfall per lagoon, over the wall opposite its cleft. */
export function layoutFalls(hf: Heightfield): Fall[] {
  return LAGOONS.map((L, i) => {
    const a = hf.lagoonGaps[i] + Math.PI;
    const dir = { x: Math.sin(a), z: Math.cos(a) };
    const at = (d: number) => ({ x: L.x + dir.x * d, z: L.z + dir.z * d });
    // The lip is the first point on the way out where the wall reaches most of its height.
    let top = -Infinity;
    for (let d = L.r - 6; d < L.r + 30; d += 0.5) top = Math.max(top, hf.height(at(d).x, at(d).z));
    let lipD = L.r + 8;
    for (let d = L.r - 6; d < L.r + 30; d += 0.5)
      if (hf.height(at(d).x, at(d).z) > top * 0.88) {
        lipD = d;
        break;
      }
    const lip = at(lipD);
    const land = at(L.r - 11);
    return { x: land.x, z: land.z, lip: new THREE.Vector3(lip.x, hf.height(lip.x, lip.z) + 0.3, lip.z), dir, behind: at(L.r - 7.5) };
  });
}

function puff(tint: number, strength: number) {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const r = length(uv().sub(0.5)).mul(2);
  const edge = mx_noise_float(uv().mul(5).add(time.mul(0.3)) as N).mul(0.15);
  m.colorNode = vec4(color(tint).mul(strength), smoothstep(1.0, 0.35, r.add(edge)).mul(0.7));
  return m;
}

/** Waterfalls drawn like the rest of the dream: a streaming curtain, churning foam, mist and rings. */
export class Waterfalls {
  readonly group = new THREE.Group();
  private sprites: { s: THREE.Sprite; base: THREE.Vector3; k: number; kind: 'foam' | 'mist' }[] = [];
  private rings: { m: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; fade: { value: number }; k: number; at: THREE.Vector3 }[] = [];

  constructor(readonly falls: Fall[]) {
    this.group.name = 'waterfalls';
    const curtainMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const u = uv().x;
    const t = uv().y; // 0 at the lip, 1 at the pool
    const seed = attribute<'float'>('seed', 'float') as N;
    // Long streaks running down, quicker as the water falls.
    const flow = t.mul(t).mul(6).add(t.mul(3)).sub(time.mul(1.4));
    const streak = mx_noise_float(vec2(u.mul(22).add(seed), flow.mul(1.2)) as N).mul(0.5).add(0.5);
    const fine = mx_noise_float(vec2(u.mul(60).add(seed), flow.mul(3)) as N).mul(0.5).add(0.5);
    // Faint ink flow lines, a drawing's idea of falling water.
    const inkLines = penLines(u.mul(16).add(mx_noise_float(vec2(u.mul(4), t.mul(2).add(seed)) as N).mul(0.6)), 1.0).mul(smoothstep(0.1, 0.4, t)).mul(0.35);
    const edges = smoothstep(0.5, 0.36, abs(u.sub(0.5)));
    const foam = smoothstep(0.55, 1.0, t).mul(0.8).add(smoothstep(0.38, 0.5, abs(u.sub(0.5))).mul(0.6)).add(smoothstep(0.75, 0.95, fine).mul(0.5));
    // Kept mostly below the bloom threshold, or the whole curtain blooms into one white blob.
    const lagoonGlow = color(0x6ff4ee).mul(0.42);
    let col: N = mix(lagoonGlow.mul(streak.mul(0.7).add(0.45)), color(0xf2ece0).mul(0.62), foam.min(1)).add(color(0xffffff).mul(smoothstep(0.9, 0.98, fine).mul(0.5)));
    col = mix(col, color(0x0b1030), inkLines);
    const alpha = streak.mul(0.35).add(0.5).add(foam.mul(0.3)).mul(edges).mul(smoothstep(0.0, 0.05, t)).min(0.95);
    curtainMat.colorNode = vec4(col, alpha);

    const ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
    const foamMat = puff(0xf2ece0, 0.5);
    const mistMat = puff(0xbfe8f0, 0.28);

    this.falls.forEach((f, i) => {
      this.group.add(this.curtain(f, i, curtainMat));
      const base = new THREE.Vector3(f.x, 0.4, f.z);
      for (let k = 0; k < 10; k++) {
        const s = new THREE.Sprite(foamMat);
        s.scale.setScalar(2.2 + (k % 3) * 0.8);
        this.group.add(s);
        this.sprites.push({ s, base, k: k + i * 13, kind: 'foam' });
      }
      for (let k = 0; k < 8; k++) {
        const s = new THREE.Sprite(mistMat);
        s.scale.setScalar(5 + (k % 3) * 2);
        this.group.add(s);
        this.sprites.push({ s, base, k: k * 0.37 + i * 3, kind: 'mist' });
      }
      for (let k = 0; k < 3; k++) {
        const fade = uniform(0);
        const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
        mat.colorNode = vec4(color(0xe6f4f2) as N, float(0.5).mul(fade as N));
        const m = new THREE.Mesh(ringGeo, mat);
        m.position.set(f.x, 0.06, f.z);
        this.group.add(m);
        this.rings.push({ m, mat, fade, k: k / 3, at: base });
      }
    });
  }

  /** The curtain: leaves the lip and arcs out and down into the pool, widening as it falls. */
  private curtain(f: Fall, i: number, mat: THREE.Material) {
    const rows = 28;
    const cols = 6;
    const pos: number[] = [];
    const uvs: number[] = [];
    const seeds: number[] = [];
    const idx: number[] = [];
    const perp = { x: f.dir.z, z: -f.dir.x };
    const from = f.lip;
    const toX = f.x;
    const toZ = f.z;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      // Ballistic: steady horizontal travel, accelerating fall.
      const x = from.x + (toX - from.x) * t;
      const z = from.z + (toZ - from.z) * t;
      const y = from.y * (1 - t * t) - 0.3 * t;
      const w = 4.5 + t * 3.5;
      for (let c = 0; c <= cols; c++) {
        const u = c / cols;
        const sway = Math.sin(u * 3 + i) * 0.25 * t;
        pos.push(x + perp.x * (u - 0.5) * w + f.dir.x * sway, y, z + perp.z * (u - 0.5) * w + f.dir.z * sway);
        uvs.push(u, t);
        seeds.push(i * 7.3);
      }
    }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        idx.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 5;
    return m;
  }

  /** 0..1: how loud the nearest waterfall should be. */
  loudness(p: THREE.Vector3) {
    let best = 0;
    for (const f of this.falls) best = Math.max(best, 1 - Math.min(1, Math.hypot(f.x - p.x, f.z - p.z) / 130));
    return best * best;
  }

  update(dt: number, focus: THREE.Vector3) {
    const t = performance.now() / 1000;
    for (const { s, base, k, kind } of this.sprites) {
      const near = Math.hypot(base.x - focus.x, base.z - focus.z) < 700;
      s.visible = near;
      if (!near) continue;
      if (kind === 'foam') {
        const a = k * 2.4 + t * 0.6;
        s.position.set(base.x + Math.cos(a) * (1.5 + (k % 4) * 0.6), base.y + Math.abs(Math.sin(t * 2.3 + k)) * 0.8, base.z + Math.sin(a) * (1.5 + (k % 4) * 0.6));
      } else {
        // Mist rises from the plunge, drifts and thins, then starts again.
        const cyc = (t * 0.12 + k) % 1;
        s.position.set(base.x + Math.sin(k * 5 + t * 0.2) * 3, base.y + cyc * 14, base.z + Math.cos(k * 3 + t * 0.17) * 3);
        (s.material as THREE.SpriteNodeMaterial).opacity = 1;
        s.scale.setScalar((5 + (k % 3) * 2) * (0.6 + cyc));
      }
    }
    for (const r of this.rings) {
      const cyc = (t * 0.35 + r.k) % 1;
      r.m.scale.setScalar(2 + cyc * 9);
      r.fade.value = 1 - cyc;
      r.m.visible = Math.hypot(r.at.x - focus.x, r.at.z - focus.z) < 400;
    }
    void dt;
  }
}

