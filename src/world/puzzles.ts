import * as THREE from 'three/webgpu';
import { color, dot, exp, length, mix, normalWorld, saturate, sin, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import { PALETTE, SKY } from '../config';
import { BIOMES, mulberry32, type Heightfield } from './heightfield';
import type { Wonder } from './wonders';
import type { Colliders } from '../game/player';
import { CONSTELLATIONS } from '../story/content';
import { StoneRing } from './puzzleStones';
import { BellPool } from './puzzleBells';

export type Region = 'meadow' | 'lantern' | 'dunes' | 'drowned';
export type PuzzleKind = 'lanterns' | 'stones' | 'bells';
export type Spot = { x: number; y: number; z: number };

export interface PuzzleSite {
  id: string;
  region: Region;
  kind: PuzzleKind;
  /** Which of the region's puzzle stars it guards (0 or 1). */
  slot: number;
  x: number;
  y: number;
  z: number;
  /** Lantern circles: the lanterns and the tune (lantern indices). */
  lanterns?: Spot[];
  tune?: number[];
  /** Constellation stones: each stone's spot, the azimuth it looks toward, and the sky feature it must show. */
  stones?: (Spot & { az: number; answer: number })[];
  /** Reflection bells: the bells, the true order (shown only in the water), and false marks on the real bells. */
  bells?: Spot[];
  order?: number[];
  decoy?: number[];
}

/** Sky features a stone can show: the five constellations, then the brightest star. */
export interface SkyFeature {
  name: string;
  az: number;
  stars: [number, number][];
  lines: [number, number][];
}

export function skyFeatures(boatAzimuth: number): SkyFeature[] {
  const b = SKY.brightStar;
  const brightAz = ((THREE.MathUtils.radToDeg(Math.atan2(b.x, -b.z)) % 360) + 360) % 360;
  return [
    ...CONSTELLATIONS.map((c) => ({ name: c.name, az: c.id === 'boat' ? boatAzimuth : c.azimuth, stars: c.stars, lines: c.lines })),
    { name: 'The Brightest Star', az: brightAz, stars: [[0, 0]] as [number, number][], lines: [] },
  ];
}

const KIND: Record<Region, [PuzzleKind, PuzzleKind]> = {
  meadow: ['lanterns', 'lanterns'],
  lantern: ['lanterns', 'lanterns'],
  dunes: ['stones', 'stones'],
  drowned: ['bells', 'bells'],
};
const LANTERN_SIZE: Record<Region, [number, number][]> = {
  meadow: [[4, 4], [5, 5]],
  lantern: [[5, 5], [5, 6]],
  dunes: [[5, 6], [6, 7]],
  drowned: [[6, 7], [6, 8]],
};

/** Two puzzles per region, on open ground away from the wonder; the drowned town's stand in the shallows. */
export function layoutPuzzles(hf: Heightfield, wonders: Wonder[], boatAzimuth: number): PuzzleSite[] {
  const out: PuzzleSite[] = [];
  const rnd = mulberry32(4242);
  const features = skyFeatures(boatAzimuth);
  const slope = (x: number, z: number) =>
    Math.abs(hf.height(x + 6, z) - hf.height(x - 6, z)) + Math.abs(hf.height(x, z + 6) - hf.height(x, z - 6));
  for (const region of Object.keys(KIND) as Region[]) {
    const B = BIOMES[region];
    for (let slot = 0; slot < 2; slot++) {
      const kind = KIND[region][slot];
      const radius = kind === 'lanterns' ? (slot === 0 ? 7 : 12) : kind === 'stones' ? 7 : slot === 0 ? 7 : 9;
      for (let tries = 0; tries < 900; tries++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * B.r * (region === 'drowned' ? 1.1 : 0.8);
        const x = B.x + Math.sin(a) * d;
        const z = B.z + Math.cos(a) * d;
        const h = hf.height(x, z);
        if (wonders.some((w) => Math.hypot(w.x - x, w.z - z) < 140)) continue;
        if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 220)) continue;
        const ring = (n: number, r: number, off = 0) =>
          Array.from({ length: n }, (_, k) => {
            const la = (k / n) * Math.PI * 2 + off;
            const lx = x + Math.sin(la) * r;
            const lz = z + Math.cos(la) * r;
            return { x: lx, y: hf.height(lx, lz), z: lz };
          });
        const site: PuzzleSite = { id: `puzzle-${region}-${slot}`, region, kind, slot, x, y: h, z };
        if (kind === 'bells') {
          // Every bell must stand in water deep enough to mirror it, shallow enough to wade to.
          const n = slot === 0 ? 5 : 6;
          const bells = ring(n, radius, a);
          if (h > -0.15 || h < -0.8 || bells.some((b) => b.y > -0.15 || b.y < -0.8)) continue;
          site.bells = bells;
          site.order = shuffle(n, rnd);
          let decoy = shuffle(n, rnd);
          while (decoy.every((v, i) => v === site.order![i])) decoy = shuffle(n, rnd);
          if (slot === 1) site.decoy = decoy;
        } else {
          if (h < 0.8 || slope(x, z) > (region === 'dunes' ? 3.5 : 2)) continue;
          if (kind === 'lanterns') {
            const [count, tuneLength] = LANTERN_SIZE[region][slot];
            site.lanterns = ring(count, radius, a);
            const tune: number[] = [];
            for (let k = 0; k < tuneLength; k++) {
              let n = Math.floor(rnd() * count);
              if (n === tune[k - 1]) n = (n + 1) % count;
              tune.push(n);
            }
            site.tune = tune;
          } else {
            // Each stone stands on the ring at the bearing of the sky feature it must show.
            const pick = slot === 0 ? pickSeparated(features, 4) : features.map((_, i) => i);
            site.stones = pick.map((i) => {
              const az = THREE.MathUtils.degToRad(features[i].az);
              const sx = x + Math.sin(az) * radius;
              const sz = z - Math.cos(az) * radius;
              return { x: sx, y: hf.height(sx, sz), z: sz, az, answer: i };
            });
          }
        }
        out.push(site);
        break;
      }
    }
  }
  return out;
}

function shuffle(n: number, rnd: () => number) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A handful of features spread well apart around the horizon, so the first ring is unambiguous. */
function pickSeparated(features: SkyFeature[], n: number) {
  const chosen: number[] = [];
  const order = [5, 2, 0, 1, 3, 4];
  for (const i of order) {
    if (chosen.length >= n) break;
    const gap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    if (chosen.every((c) => gap(features[c].az, features[i].az) > 40)) chosen.push(i);
  }
  return chosen;
}

/** What every puzzle reports back to the manager. */
export interface PuzzleHooks {
  note(k: number): void;
  fail(): void;
  solve(site: PuzzleSite): void;
}

/** One puzzle of any kind. */
export interface PuzzleImpl {
  readonly site: PuzzleSite;
  readonly solved: boolean;
  readonly group: THREE.Object3D;
  interaction(x: number, z: number): { prompt: string; act: () => void } | null;
  update(dt: number): void;
  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void): void;
  setMirror?(mirror: boolean): void;
}

export const KEY = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);

export function stoneMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  const lambert = saturate(dot(normalWorld, KEY).mul(0.55).add(0.45));
  m.colorNode = mix(color(0x2c3557), color(0x7a84b4), lambert);
  return m;
}

/** Lantern circles: stand on the dais to hear the tune, then light the lanterns in its order. */
class LanternCircle implements PuzzleImpl {
  readonly group = new THREE.Group();
  private flames: { value: number }[] = [];
  private state: 'idle' | 'showing' | 'input' | 'solved';
  private step = 0;
  private t = 0;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.state = solved ? 'solved' : 'idle';
    const stone = stoneMaterial();
    const post = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 7).translate(0, 0.75, 0);
    // The cap floats clear of the bowl so the flame between them is always visible.
    const cap = new THREE.ConeGeometry(0.42, 0.45, 7).translate(0, 2.55, 0);
    const bowl = new THREE.CylinderGeometry(0.34, 0.26, 0.18, 7).translate(0, 1.58, 0);
    const daisMat = new THREE.MeshBasicNodeMaterial();
    const lambert = saturate(dot(normalWorld, KEY).mul(0.55).add(0.45));
    // A star carved into the dais, glowing faintly so it reads as somewhere to stand.
    const carve = exp(length(uv().sub(0.5).mul(2)).mul(-3)).mul(0.25);
    daisMat.colorNode = mix(color(0x2a3158), color(0x5b6797), lambert).add(color(PALETTE.starGold).mul(carve));
    const d = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 0.5, 18).translate(0, -0.05, 0), daisMat);
    d.position.set(site.x, site.y, site.z);
    this.group.add(d);
    site.lanterns!.forEach((l, k) => {
      for (const g of [post, bowl, cap]) {
        const m = new THREE.Mesh(g, stone);
        m.position.set(l.x, l.y - 0.1, l.z);
        this.group.add(m);
      }
      const flame = uniform(solved ? 1 : 0);
      this.flames.push(flame);
      const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const r = length(uv().sub(0.5)).mul(2);
      const flicker = sin(time.mul(11).add(k * 3)).mul(0.08).add(sin(time.mul(23).add(k)).mul(0.05)).add(0.9);
      // Unlit: a cold ember so the circle is legible. Lit: warm gold.
      const tint = mix(color(0x5a6ab0).mul(0.35), color(PALETTE.starGold).mul(2.4), flame);
      mat.colorNode = vec4(tint.mul(exp(r.mul(-4.5)).add(exp(r.mul(-14)).mul(1.5))).mul(flicker), 1);
      const s = new THREE.Sprite(mat);
      s.position.set(l.x, l.y + 1.95, l.z);
      s.scale.setScalar(1.1);
      this.group.add(s);
    });
  }

  get solved() {
    return this.state === 'solved';
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const l of this.site.lanterns!) if (Math.abs(l.x - x) < reach + 1 && Math.abs(l.z - z) < reach + 1) visit(l.x, l.z, 0.35);
  }

  private reset() {
    this.step = 0;
    this.flames.forEach((f) => (f.value = 0));
  }

  interaction(x: number, z: number) {
    const s = this.site;
    if (this.solved) return null;
    if (Math.hypot(s.x - x, s.z - z) < 2.6 && this.state !== 'showing')
      return {
        prompt: 'E   listen to the lanterns',
        act: () => {
          this.reset();
          this.state = 'showing';
          this.t = -0.6;
        },
      };
    if (this.state !== 'input') return null;
    const k = s.lanterns!.findIndex((l) => Math.hypot(l.x - x, l.z - z) < 2.3);
    return k >= 0 ? { prompt: 'E   light the lantern', act: () => this.press(k) } : null;
  }

  private press(k: number) {
    this.hooks.note(k);
    this.flames[k].value = 1;
    if (k !== this.site.tune![this.step]) {
      setTimeout(() => {
        this.reset();
        this.hooks.fail();
      }, 450);
      return;
    }
    this.step++;
    if (this.step >= this.site.tune!.length) {
      this.state = 'solved';
      this.flames.forEach((f) => (f.value = 1));
      this.hooks.solve(this.site);
    }
  }

  update(dt: number) {
    if (this.state !== 'showing') return;
    // The demonstration: each lantern of the tune flares in turn with its note.
    const tune = this.site.tune!;
    const prev = Math.floor(this.t / 0.9);
    this.t += dt;
    const now = Math.floor(this.t / 0.9);
    if (this.t >= 0 && now !== prev && now < tune.length) {
      this.flames.forEach((f) => (f.value = 0));
      this.flames[tune[now]].value = 1;
      this.hooks.note(tune[now]);
    }
    if (this.t >= 0 && this.t % 0.9 > 0.6) this.flames.forEach((f) => (f.value = 0));
    if (this.t > tune.length * 0.9 + 0.3) {
      this.flames.forEach((f) => (f.value = 0));
      this.state = 'input';
      this.step = 0;
    }
  }
}

/** All the island's puzzles: lantern circles, constellation stones and reflection bells. */
export class Puzzles implements Colliders {
  readonly group = new THREE.Group();
  private impls: PuzzleImpl[];
  private discovered = new Set<string>();
  onNote: ((k: number) => void) | null = null;
  onFail: (() => void) | null = null;
  onSolve: ((site: PuzzleSite) => void) | null = null;
  /** First time someone comes near an unsolved puzzle. */
  onDiscover: ((site: PuzzleSite) => void) | null = null;

  constructor(readonly sites: PuzzleSite[], solved: (id: string) => boolean, features: SkyFeature[]) {
    this.group.name = 'puzzles';
    const hooks: PuzzleHooks = {
      note: (k) => this.onNote?.(k),
      fail: () => this.onFail?.(),
      solve: (s) => this.onSolve?.(s),
    };
    this.impls = sites.map((s) =>
      s.kind === 'stones' ? new StoneRing(s, solved(s.id), hooks, features) : s.kind === 'bells' ? new BellPool(s, solved(s.id), hooks) : new LanternCircle(s, solved(s.id), hooks),
    );
    for (const p of this.impls) this.group.add(p.group);
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const p of this.impls) if (Math.abs(p.site.x - x) < reach + 16 && Math.abs(p.site.z - z) < reach + 16) p.near(x, z, reach, visit);
  }

  interaction(x: number, z: number) {
    for (const p of this.impls) {
      if (Math.hypot(p.site.x - x, p.site.z - z) > 20) continue;
      const i = p.interaction(x, z);
      if (i) return i;
    }
    return null;
  }

  /** The reflection pass is drawing (or has finished): some marks exist only in the water. */
  setMirror(mirror: boolean) {
    for (const p of this.impls) p.setMirror?.(mirror);
  }

  update(dt: number, player: { x: number; z: number }) {
    for (const p of this.impls) {
      if (!this.discovered.has(p.site.id) && Math.hypot(p.site.x - player.x, p.site.z - player.z) < 22) {
        this.discovered.add(p.site.id);
        if (!p.solved) this.onDiscover?.(p.site);
      }
      p.update(dt);
    }
  }
}
