import * as THREE from 'three/webgpu';
import { color, dot, mix, normalWorld, saturate, vec3 } from 'three/tsl';
import { SKY } from '../config';
import { BIOMES, mulberry32, type Heightfield } from './heightfield';
import type { Wonder } from './wonders';
import type { Colliders } from '../game/player';
import { CONSTELLATIONS } from '../story/content';
import { StoneRing } from './puzzleStones';
import { BellPool } from './puzzleBells';
import { DewTrail, Fireflies } from './puzzleMeadow';
import { Glowcaps, MirrorCaps } from './puzzleWood';

export type Region = 'meadow' | 'lantern' | 'dunes' | 'drowned';
export type PuzzleKind = 'fireflies' | 'footprints' | 'glowcaps' | 'mirrors' | 'stones' | 'bells';
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
  /** Where its star falls, if not in the middle (the end of a trail). */
  reward?: { x: number; z: number };
  /** Fireflies: the jar to herd them into, the moonflower that opens it, boulders in the way. */
  jar?: Spot;
  flower?: Spot;
  rocks?: (Spot & { r: number })[];
  /** Dew footprints: her trail (with gaps), and your prints beside it that fork off to dead ends. */
  trail?: (Spot & { yaw: number })[];
  decoyTrail?: (Spot & { yaw: number })[];
  /** Glowcaps: the mushrooms, the roots between them, and which start lit. */
  caps?: Spot[];
  links?: number[][];
  start?: boolean[];
  /** Mirror caps: source stone, caps, shrine (as node indices), and which nodes each cap can aim at. */
  nodes?: Spot[];
  aims?: number[][];
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
  meadow: ['fireflies', 'footprints'],
  lantern: ['glowcaps', 'mirrors'],
  dunes: ['stones', 'stones'],
  drowned: ['bells', 'bells'],
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
      const radius = kind === 'stones' ? 7 : slot === 0 ? 7 : 9;
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
          const dry = (px: number, pz: number) => hf.height(px, pz) > 0.6 && slope(px, pz) < 2.5;
          const at = (px: number, pz: number) => ({ x: px, y: hf.height(px, pz), z: pz });
          if (kind === 'fireflies') {
            // The jar stands a good walk from where the swarm gathers; boulders sit between them, and
            // the moonflower that opens the jar grows further off again.
            const ja = a + 1.3;
            const jx = x + Math.sin(ja) * 28;
            const jz = z + Math.cos(ja) * 28;
            const fa = a - 1.9;
            const fx = x + Math.sin(fa) * 38;
            const fz = z + Math.cos(fa) * 38;
            if (!dry(jx, jz) || !dry(fx, fz)) continue;
            site.jar = at(jx, jz);
            site.flower = at(fx, fz);
            site.rocks = [0.35, 0.55, 0.72].map((t, k) => {
              const off = (k % 2 ? 1 : -1) * (2 + k);
              const rx = x + (jx - x) * t + Math.cos(ja) * off;
              const rz = z + (jz - z) * t - Math.sin(ja) * off;
              return { ...at(rx, rz), r: 1.6 + k * 0.4 };
            });
            site.reward = { x: jx, z: jz };
          } else if (kind === 'footprints') {
            // Her small prints wander about 140 m. Yours walk beside hers, but twice they split off to
            // dead ends; twice hers cross wet ground where no prints show at all.
            const walk = (x0: number, z0: number, h0: number, n: number, wobble: number) => {
              const out: (Spot & { yaw: number })[] = [];
              let px = x0;
              let pz = z0;
              let heading = h0;
              for (let k = 0; k < n; k++) {
                heading += (rnd() - 0.5) * wobble + Math.sin(k / 9) * 0.1;
                px += Math.sin(heading) * 1.1;
                pz += Math.cos(heading) * 1.1;
                if (!dry(px, pz)) return null;
                out.push({ ...at(px, pz), yaw: heading });
              }
              return out;
            };
            const path = walk(x, z, a, 125, 0.45);
            if (!path) continue;
            const side = (p: Spot & { yaw: number }, d: number) => at(p.x + Math.cos(p.yaw) * d, p.z - Math.sin(p.yaw) * d);
            const child: (Spot & { yaw: number })[] = [];
            const adult: (Spot & { yaw: number })[] = [];
            const gaps = [[48, 57], [96, 104]];
            const forks = [30, 74];
            let bad = false;
            path.forEach((p, k) => {
              const foot = k % 2 ? 0.12 : -0.12;
              if (!gaps.some(([g0, g1]) => k >= g0 && k <= g1)) child.push({ ...side(p, foot), yaw: p.yaw });
              // Your prints keep pace beside hers, except after each fork, where they wander off.
              const forked = forks.some((f) => k >= f && k < f + 30);
              if (!forked && k % 2 === 0) adult.push({ ...side(p, 0.75), yaw: p.yaw });
            });
            for (const f of forks) {
              const turn = (rnd() > 0.5 ? 1 : -1) * (0.7 + rnd() * 0.4);
              const branch = walk(path[f].x, path[f].z, path[f].yaw + turn, 26, 0.35);
              if (!branch) {
                bad = true;
                break;
              }
              branch.forEach((p, k) => k % 2 === 0 && adult.push({ ...side(p, 0.2), yaw: p.yaw }));
            }
            if (bad) continue;
            site.trail = child;
            site.decoyTrail = adult;
            site.reward = { x: path[path.length - 1].x, z: path[path.length - 1].z };
          } else if (kind === 'glowcaps') {
            // Six mushrooms joined by roots. Touching one flips it and every mushroom its roots reach.
            const caps: Spot[] = [];
            for (let k = 0; k < 6; k++) {
              const ca = a + (k / 6) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
              const cr = 8 + rnd() * 5;
              caps.push(at(x + Math.sin(ca) * cr, z + Math.cos(ca) * cr));
            }
            if (caps.some((c) => !dry(c.x, c.z))) continue;
            const links: number[][] = caps.map(() => []);
            const join = (i: number, j: number) => {
              if (!links[i].includes(j)) links[i].push(j);
              if (!links[j].includes(i)) links[j].push(i);
            };
            for (let k = 0; k < 6; k++) join(k, (k + 1) % 6);
            join(0, 3);
            join(1, 4);
            // Scramble from all-lit with presses the player has to undo: always solvable.
            const lit = caps.map(() => true);
            const presses = new Set<number>();
            while (presses.size < 3) presses.add(Math.floor(rnd() * 6));
            for (const k of presses) for (const j of [k, ...links[k]]) lit[j] = !lit[j];
            if (lit.every(Boolean)) continue;
            site.caps = caps;
            site.links = links;
            site.start = lit;
          } else if (kind === 'mirrors') {
            // Source, five caps, shrine. The caps lie along a hidden route (each within reach of the
            // next), then the beam must visit every cap before the shrine will wake.
            const reach = 14;
            const nodes: Spot[] = [at(x, z)];
            let px = x;
            let pz = z;
            let heading = a;
            for (let k = 0; k < 5; k++) {
              heading += (rnd() > 0.5 ? 1 : -1) * (1.2 + rnd() * 0.9);
              const d = 8 + rnd() * 4;
              px += Math.sin(heading) * d;
              pz += Math.cos(heading) * d;
              nodes.push(at(px, pz));
            }
            heading += (rnd() - 0.5) * 1.4;
            nodes.push(at(px + Math.sin(heading) * 10, pz + Math.cos(heading) * 10));
            if (nodes.some((n) => !dry(n.x, n.z))) continue;
            if (nodes.some((n, i) => nodes.some((m, j) => j > i && Math.hypot(n.x - m.x, n.z - m.z) < 4))) continue;
            const last = nodes.length - 1;
            site.aims = nodes.map((n, i) =>
              i === 0 ? [1] : i === last ? [] : nodes.map((_, j) => j).filter((j) => j !== i && j !== 0 && Math.hypot(nodes[j].x - n.x, nodes[j].z - n.z) <= reach),
            );
            site.nodes = nodes;
            site.reward = { x: nodes[last].x, z: nodes[last].z };
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

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  speed: number;
}

/** What every puzzle reports back to the manager. */
export interface PuzzleHooks {
  note(k: number): void;
  fail(site: PuzzleSite): void;
  solve(site: PuzzleSite): void;
}

/** One puzzle of any kind. */
export interface PuzzleImpl {
  readonly site: PuzzleSite;
  readonly solved: boolean;
  readonly group: THREE.Object3D;
  interaction(x: number, z: number): { prompt: string; act: () => void } | null;
  update(dt: number, player: PlayerState): void;
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

/** All the island's puzzles: lantern circles, constellation stones and reflection bells. */
export class Puzzles implements Colliders {
  readonly group = new THREE.Group();
  private impls: PuzzleImpl[];
  private discovered = new Set<string>();
  onNote: ((k: number) => void) | null = null;
  onFail: ((site: PuzzleSite) => void) | null = null;
  onSolve: ((site: PuzzleSite) => void) | null = null;
  /** First time someone comes near an unsolved puzzle. */
  onDiscover: ((site: PuzzleSite) => void) | null = null;

  constructor(readonly sites: PuzzleSite[], solved: (id: string) => boolean, features: SkyFeature[]) {
    this.group.name = 'puzzles';
    const hooks: PuzzleHooks = {
      note: (k) => this.onNote?.(k),
      fail: (s) => this.onFail?.(s),
      solve: (s) => this.onSolve?.(s),
    };
    this.impls = sites.map((s) => {
      const done = solved(s.id);
      switch (s.kind) {
        case 'stones':
          return new StoneRing(s, done, hooks, features);
        case 'bells':
          return new BellPool(s, done, hooks);
        case 'fireflies':
          return new Fireflies(s, done, hooks);
        case 'footprints':
          return new DewTrail(s, done, hooks);
        case 'glowcaps':
          return new Glowcaps(s, done, hooks);
        default:
          return new MirrorCaps(s, done, hooks);
      }
    });
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

  update(dt: number, player: PlayerState) {
    for (const p of this.impls) {
      if (!this.discovered.has(p.site.id) && Math.hypot(p.site.x - player.x, p.site.z - player.z) < 22) {
        this.discovered.add(p.site.id);
        if (!p.solved) this.onDiscover?.(p.site);
      }
      p.update(dt, player);
    }
  }
}
