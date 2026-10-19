import * as THREE from 'three/webgpu';
import { color, dot, mix, normalWorld, saturate, sin, time, uniform } from 'three/tsl';
import { KEY, stoneMaterial, type PlayerState, type PuzzleHooks, type PuzzleImpl, type PuzzleSite, type Spot } from './puzzles';

const lambert = () => saturate(dot(normalWorld, KEY).mul(0.55).add(0.45));

/** A glowing mushroom whose cap brightens with `lit` (0..1). */
function mushroom(at: Spot, lit: { value: number }, tint: number, size = 1) {
  const g = new THREE.Group();
  const stemMat = new THREE.MeshBasicNodeMaterial();
  stemMat.colorNode = mix(color(0x8a86b8), color(0xd8d0f0), lambert()).mul(0.8);
  const capMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const breathe = sin(time.mul(1.8)).mul(0.12).add(1);
  capMat.colorNode = mix(mix(color(0x1a1636), color(0x3a2a72), lambert()), color(tint).mul(2.2).mul(breathe), lit as any);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * size, 0.24 * size, 1.4 * size, 8).translate(0, 0.7 * size, 0), stemMat);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.75 * size, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1), capMat);
  cap.position.y = 1.35 * size;
  g.add(stem, cap);
  g.position.set(at.x, at.y - 0.05, at.z);
  return { g, cap };
}

/** A glowing strip along the ground from a to b (a root, or a beam when raised). */
function strip(a: Spot, b: Spot, height: number, width: number, mat: THREE.Material) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const m = new THREE.Mesh(new THREE.BoxGeometry(width, width * 0.5, len), mat);
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 + height, (a.z + b.z) / 2);
  m.lookAt(b.x, b.y + height, b.z);
  return m;
}

function shrine(site: PuzzleSite, glow: { value: number }) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 1.0, 8).translate(0, 0.4, 0), stoneMaterial());
  const crystalMat = new THREE.MeshBasicNodeMaterial();
  crystalMat.colorNode = mix(color(0x2a3060), color(0xbfe8ff).mul(3), glow as any);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0).scale(1, 1.6, 1), crystalMat);
  crystal.position.y = 1.6;
  g.add(base, crystal);
  return { g, crystal };
}

/**
 * Glowcaps: eight mushrooms joined by roots. Touching one flips it and every mushroom its roots reach.
 * Light them all at once to wake the shrine. The obvious moves undo each other.
 */
export class Glowcaps implements PuzzleImpl {
  readonly group = new THREE.Group();
  private lit: boolean[];
  private glows: { value: number }[];
  private shrineGlow = uniform(0);
  private crystal: THREE.Mesh;
  private isSolved: boolean;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.isSolved = solved;
    this.lit = solved ? site.caps!.map(() => true) : [...site.start!];
    this.glows = this.lit.map((l) => uniform(l ? 1 : 0));
    const rootMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    rootMat.colorNode = color(0x5fe8d8).mul(sin(time.mul(1.2)).mul(0.15).add(0.45));
    site.links!.forEach((ls, i) => ls.forEach((j) => j > i && this.group.add(strip(site.caps![i], site.caps![j], 0.05, 0.12, rootMat))));
    site.caps!.forEach((c, i) => this.group.add(mushroom(c, this.glows[i], 0x5fe8d8, 1.2).g));
    const s = shrine(site, this.shrineGlow);
    s.g.position.set(site.x, site.y, site.z);
    this.crystal = s.crystal;
    this.group.add(s.g);
    if (solved) this.shrineGlow.value = 1;
  }

  get solved() {
    return this.isSolved;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const c of this.site.caps!) if (Math.abs(c.x - x) < reach + 1 && Math.abs(c.z - z) < reach + 1) visit(c.x, c.z, 0.3);
    visit(this.site.x, this.site.z, 1.1);
  }

  interaction(x: number, z: number) {
    if (this.isSolved) return null;
    const i = this.site.caps!.findIndex((c) => Math.hypot(c.x - x, c.z - z) < 2.4);
    return i >= 0 ? { prompt: 'E   touch the glowcap', act: () => this.touch(i) } : null;
  }

  /** Seconds each cap has been lit; a cap left burning too long gutters out again. */
  private age: number[] = [];
  static readonly FADE = 45;

  private touch(i: number) {
    for (const j of [i, ...this.site.links![i]]) {
      this.lit[j] = !this.lit[j];
      this.age[j] = 0;
    }
    this.hooks.note(i);
    if (this.lit.every(Boolean)) {
      this.isSolved = true;
      this.hooks.solve(this.site);
    }
  }

  update(dt: number) {
    if (!this.isSolved)
      this.lit.forEach((l, i) => {
        if (!l) return;
        this.age[i] = (this.age[i] ?? 0) + dt;
        if (this.age[i] > Glowcaps.FADE) this.lit[i] = false;
      });
    // Dimming toward the end of its time, so you can see which caps are about to go out.
    this.lit.forEach((l, i) => {
      const fading = l && !this.isSolved ? 1 - Math.max(0, ((this.age[i] ?? 0) - Glowcaps.FADE * 0.6) / (Glowcaps.FADE * 0.4)) * 0.6 : l ? 1 : 0;
      this.glows[i].value += (fading - this.glows[i].value) * Math.min(1, dt * 6);
    });
    if (this.isSolved) this.shrineGlow.value += (1 - this.shrineGlow.value) * Math.min(1, dt);
    this.crystal.rotation.y += dt * 0.6;
  }
}

/**
 * Mirror caps: a beam leaves the source stone. Turn each cap to aim at another within reach. The
 * shrine only wakes if the beam has touched every cap on its way there.
 */
export class MirrorCaps implements PuzzleImpl {
  readonly group = new THREE.Group();
  private aim: number[];
  private caps: THREE.Object3D[] = [];
  private beam = new THREE.Group();
  private beamMat: THREE.MeshBasicNodeMaterial;
  private shrineGlow = uniform(0);
  private crystal: THREE.Mesh;
  private isSolved: boolean;
  /** The beam reached the shrine but missed some caps: the shrine flickers. */
  short = false;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.isSolved = solved;
    const n = site.nodes!;
    const last = n.length - 1;
    // Solved: the hidden route. Otherwise every cap starts aimed somewhere other than its next stop.
    this.aim = n.map((_, i) => {
      if (i === 0) return 1;
      if (i === last) return -1;
      if (solved) return i + 1;
      const opts = site.aims![i].filter((j) => j !== i + 1);
      return opts.length ? opts[(i * 3) % opts.length] : i + 1;
    });
    const src = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.1, 7).translate(0, 0.45, 0), stoneMaterial());
    src.position.set(n[0].x, n[0].y, n[0].z);
    const srcGlow = new THREE.MeshBasicNodeMaterial();
    srcGlow.colorNode = color(0xfff0c8).mul(sin(time.mul(3)).mul(0.2).add(2.4));
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), srcGlow);
    orb.position.set(n[0].x, n[0].y + 1.6, n[0].z);
    this.group.add(src, orb);
    for (let i = 1; i < last; i++) {
      const m = mushroom(n[i], { value: 0.35 }, 0xb8c8ff, 1.1);
      // The cap is a tilted mirror; it turns to face where it sends the light.
      m.cap.scale.set(1, 0.35, 1);
      m.cap.rotation.x = 0.5;
      this.caps[i] = m.g;
      this.group.add(m.g);
    }
    const s = shrine(site, this.shrineGlow);
    s.g.position.set(n[last].x, n[last].y, n[last].z);
    this.crystal = s.crystal;
    this.group.add(s.g);
    this.beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.beamMat.colorNode = color(0xfff0c8).mul(sin(time.mul(6)).mul(0.15).add(1.6));
    this.group.add(this.beam);
    if (solved) this.shrineGlow.value = 1;
    this.trace();
  }

  get solved() {
    return this.isSolved;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const c of this.site.nodes!) if (Math.abs(c.x - x) < reach + 1 && Math.abs(c.z - z) < reach + 1) visit(c.x, c.z, 0.35);
  }

  interaction(x: number, z: number) {
    if (this.isSolved) return null;
    const n = this.site.nodes!;
    for (let i = 1; i < n.length - 1; i++)
      if (Math.hypot(n[i].x - x, n[i].z - z) < 2.4) return { prompt: 'E   turn the mirror cap', act: () => this.turn(i) };
    return null;
  }

  private turn(i: number) {
    const opts = this.site.aims![i];
    this.aim[i] = opts[(opts.indexOf(this.aim[i]) + 1) % opts.length];
    this.hooks.note(i);
    this.trace();
  }

  /** Follow the light from the source and redraw it; check whether it reached the shrine through every cap. */
  private trace() {
    const n = this.site.nodes!;
    const last = n.length - 1;
    for (const c of [...this.beam.children]) this.beam.remove(c);
    const seen = new Set<number>([0]);
    let cur = 0;
    let reached = false;
    while (true) {
      const next = this.aim[cur];
      if (next < 0 || next === undefined) break;
      this.beam.add(strip(n[cur], n[next], 1.55, 0.09, this.beamMat));
      if (next === last) {
        reached = true;
        break;
      }
      if (seen.has(next)) break;
      seen.add(next);
      cur = next;
    }
    for (let i = 1; i < last; i++) {
      const c = this.caps[i];
      const t = n[this.aim[i]];
      if (t) c.rotation.y = Math.atan2(t.x - n[i].x, t.z - n[i].z);
    }
    const all = seen.size === last;
    this.short = reached && !all;
    if (reached && all && !this.isSolved) {
      this.isSolved = true;
      this.hooks.solve(this.site);
    }
  }

  update(dt: number, _player: PlayerState) {
    const want = this.isSolved ? 1 : this.short ? 0.25 + Math.max(0, Math.sin(performance.now() / 90)) * 0.3 : 0;
    this.shrineGlow.value += (want - this.shrineGlow.value) * Math.min(1, dt * 4);
    this.crystal.rotation.y += dt * 0.6;
  }
}
