import * as THREE from 'three/webgpu';
import { TERRAIN } from '../config';
import { WORLD_HALF } from './heightfield';
import type { ChunkResult, FloraResult, WorkerRequest } from './terrainWorker';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Job = { req: WorkerRequest; priority: number; resolve: (r: ChunkResult | FloraResult) => void };

/** Small priority-scheduled pool so the nearest work always lands first. */
export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private pending = new Map<number, Job>();
  private nextId = 1;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<ChunkResult | FloraResult>) => {
        const job = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        this.idle.push(w);
        job?.resolve(e.data);
        this.pump();
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run<T extends ChunkResult | FloraResult>(req: DistOmit<WorkerRequest, 'id'>, priority: number): Promise<T> {
    return new Promise((resolve) => {
      const full = { ...req, id: this.nextId++ } as WorkerRequest;
      this.queue.push({ req: full, priority, resolve: resolve as Job['resolve'] });
      this.pump();
    });
  }

  reprioritise(fn: (req: WorkerRequest) => number) {
    for (const j of this.queue) j.priority = fn(j.req);
  }

  get busy() {
    return this.queue.length + this.pending.size;
  }

  private pump() {
    if (!this.idle.length || !this.queue.length) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.idle.length && this.queue.length) {
      const job = this.queue.shift()!;
      const w = this.idle.pop()!;
      this.pending.set(job.req.id, job);
      w.postMessage(job.req);
    }
  }
}

interface Chunk {
  cx: number;
  cz: number;
  mesh: THREE.Mesh | null;
  segs: number;
  wanted: number;
  inFlight: number;
}

export class Terrain {
  readonly group = new THREE.Group();
  private chunks = new Map<string, Chunk>();
  private grid: number;

  constructor(
    private pool: WorkerPool,
    private material: THREE.Material,
    private seed: number,
  ) {
    this.group.name = 'terrain';
    this.grid = Math.ceil((WORLD_HALF * 2) / TERRAIN.chunkSize);
    for (let j = 0; j < this.grid; j++)
      for (let i = 0; i < this.grid; i++) this.chunks.set(`${i},${j}`, { cx: i, cz: j, mesh: null, segs: 0, wanted: 0, inFlight: 0 });
  }

  private lodFor(dist: number) {
    for (const [d, s] of TERRAIN.lods) if (dist < d) return s;
    return 16;
  }

  update(focus: THREE.Vector3) {
    const size = TERRAIN.chunkSize;
    for (const c of this.chunks.values()) {
      const x0 = -WORLD_HALF + c.cx * size;
      const z0 = -WORLD_HALF + c.cz * size;
      const dx = Math.max(x0 - focus.x, 0, focus.x - (x0 + size));
      const dz = Math.max(z0 - focus.z, 0, focus.z - (z0 + size));
      const dist = Math.hypot(dx, dz);
      const segs = this.lodFor(dist);
      c.wanted = segs;
      if (segs === c.segs || segs === c.inFlight) continue;
      c.inFlight = segs;
      this.pool
        .run<ChunkResult>({ kind: 'chunk', seed: this.seed, x0, z0, size, segs }, dist)
        .then((r) => {
          if (c.inFlight === segs) c.inFlight = 0;
          // A newer LOD request may have superseded this one while it was in flight.
          if (c.wanted !== segs && c.mesh) return;
          this.install(c, r, x0, z0, segs);
        });
    }
  }

  private install(c: Chunk, r: ChunkResult, x0: number, z0: number, segs: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
    geo.setAttribute('terrainAttrs', new THREE.BufferAttribute(r.attrs, 2));
    geo.setAttribute('biomeAttrs', new THREE.BufferAttribute(r.biome, 4));
    geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
    const s = TERRAIN.chunkSize;
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, r.minY - 20, 0), new THREE.Vector3(s, r.maxY, s));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(x0, 0, z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = false;
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    c.mesh = mesh;
    c.segs = segs;
    this.group.add(mesh);
  }

  get loadedRatio() {
    let n = 0;
    for (const c of this.chunks.values()) if (c.mesh) n++;
    return n / this.chunks.size;
  }
}

