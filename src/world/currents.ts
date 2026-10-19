import * as THREE from 'three/webgpu';
import { abs, attribute, color, fract, mix, mx_noise_float, sin, smoothstep, time, vec2 } from 'three/tsl';
import { LAKE, RIVER, type Heightfield } from './heightfield';

type N = any;

interface Path {
  pts: { x: number; z: number }[];
  speed: number;
  width: number;
}

/**
 * Star currents: rivers of fallen starlight on the sea that carry the boat. One loops the
 * main island offshore; the River of Light flows north toward the bright one.
 */
export class Currents {
  readonly group = new THREE.Group();
  private paths: Path[] = [];
  private grid = new Map<string, { p: number; i: number }[]>();

  constructor(private hf: Heightfield) {
    this.group.name = 'currents';
    this.paths.push(this.ring());
    this.paths.push(this.river());
    for (const p of this.paths) this.group.add(this.ribbon(p));
    this.index();
  }

  /** Offshore loop: for each bearing from the island's heart, the first deep water past the coast. */
  private ring(): Path {
    const c = { x: LAKE.x, z: LAKE.z };
    const raw: { x: number; z: number }[] = [];
    for (let k = 0; k < 180; k++) {
      const a = (k / 180) * Math.PI * 2;
      let wasLand = false;
      for (let r = 900; r < 3900; r += 15) {
        const x = c.x + Math.sin(a) * r;
        const z = c.z + Math.cos(a) * r;
        const h = this.hf.height(x, z);
        if (h > 0) wasLand = true;
        if (wasLand && h < -9) {
          raw.push({ x: x + Math.sin(a) * 60, z: z + Math.cos(a) * 60 });
          break;
        }
      }
    }
    // Smooth hard so it reads as a flowing stream, not a coastline trace.
    const pts = raw.map((_, i) => {
      let sx = 0;
      let sz = 0;
      for (let k = -6; k <= 6; k++) {
        const q = raw[(i + k + raw.length) % raw.length];
        sx += q.x;
        sz += q.z;
      }
      return { x: sx / 13, z: sz / 13 };
    });
    pts.push(pts[0]);
    return { pts, speed: 7, width: 34 };
  }

  private river(): Path {
    const pts: { x: number; z: number }[] = [];
    for (let z = RIVER.zStart + 50; z > RIVER.zEnd; z -= 30) pts.push({ x: this.hf.riverX(z), z });
    return { pts, speed: 5.5, width: 40 };
  }

  private ribbon(p: Path) {
    const n = p.pts.length;
    const positions = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const indices: number[] = [];
    let along = 0;
    for (let i = 0; i < n; i++) {
      const a = p.pts[Math.max(0, i - 1)];
      const b = p.pts[Math.min(n - 1, i + 1)];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl;
      const nz = tx / tl;
      if (i > 0) along += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].z - p.pts[i - 1].z);
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        positions.set([p.pts[i].x + nx * side * p.width * 0.5, 0.07, p.pts[i].z + nz * side * p.width * 0.5], (i * 2 + s) * 3);
        uvs.set([along, s], (i * 2 + s) * 2);
      }
      if (i < n - 1) indices.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('flowUv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const fuv = attribute('flowUv', 'vec2') as N;
    const across = fuv.y.sub(0.5).mul(2);
    const edge = smoothstep(1.0, 0.35, abs(across));
    // Streaks travel along the current; their speed in metres matches the boat push.
    const flowPos = fuv.x.sub(time.mul(p.speed));
    const lanes = mx_noise_float(vec2(flowPos.mul(0.012), across.mul(3.2))).mul(0.5).add(0.5);
    const streak = smoothstep(0.62, 0.9, lanes).mul(sin(flowPos.mul(0.09).add(across.mul(4))).mul(0.3).add(0.7));
    const glints = smoothstep(0.985, 1.0, fract(sin(flowPos.floor().mul(12.9898).add(across.mul(37.1).floor())).mul(43758.5)));
    const tint = mix(color(0xffd6a0), color(0xbcd0ff), lanes);
    mat.colorNode = tint.mul(streak.mul(0.32).add(glints.mul(1.2)).mul(edge));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  private index() {
    this.paths.forEach((p, pi) =>
      p.pts.forEach((pt, i) => {
        const key = `${Math.floor(pt.x / 100)},${Math.floor(pt.z / 100)}`;
        const list = this.grid.get(key) ?? [];
        list.push({ p: pi, i });
        this.grid.set(key, list);
      }),
    );
  }

  /** Current velocity at a point: along the nearest path segment, fading toward its edges. */
  flow(x: number, z: number) {
    let best = { x: 0, z: 0 };
    let bestD = Infinity;
    const gx = Math.floor(x / 100);
    const gz = Math.floor(z / 100);
    for (let j = gz - 1; j <= gz + 1; j++)
      for (let i = gx - 1; i <= gx + 1; i++)
        for (const e of this.grid.get(`${i},${j}`) ?? []) {
          const p = this.paths[e.p];
          const a = p.pts[e.i];
          const b = p.pts[Math.min(p.pts.length - 1, e.i + 1)];
          const tx = b.x - a.x;
          const tz = b.z - a.z;
          const tl2 = tx * tx + tz * tz || 1;
          const t = Math.max(0, Math.min(1, ((x - a.x) * tx + (z - a.z) * tz) / tl2));
          const d = Math.hypot(x - (a.x + tx * t), z - (a.z + tz * t));
          if (d < p.width * 0.5 && d < bestD) {
            bestD = d;
            const tl = Math.sqrt(tl2);
            const k = p.speed * (1 - (d / (p.width * 0.5)) ** 2);
            best = { x: (tx / tl) * k, z: (tz / tl) * k };
          }
        }
    return best;
  }
}
