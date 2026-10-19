import * as THREE from 'three/webgpu';
import { color, dot, exp, length, mix, normalWorld, saturate, sin, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import { PALETTE, SKY } from '../config';
import { BIOMES, mulberry32, type Heightfield } from './heightfield';
import type { Wonder } from './wonders';
import type { Colliders } from '../game/player';

export type Region = 'meadow' | 'lantern' | 'dunes' | 'drowned';

export interface PuzzleSite {
  id: string;
  region: Region;
  /** Which of the region's puzzle stars it guards (0 or 1). */
  slot: number;
  x: number;
  y: number;
  z: number;
  lanterns: { x: number; y: number; z: number }[];
  tune: number[];
}

const REGIONS: Region[] = ['meadow', 'lantern', 'dunes', 'drowned'];
// Later regions ask for longer tunes from wider circles.
const SIZE: Record<Region, [number, number][]> = {
  meadow: [[4, 4], [5, 5]],
  lantern: [[5, 5], [5, 6]],
  dunes: [[5, 6], [6, 7]],
  drowned: [[6, 7], [6, 8]],
};

/** Two lantern circles per region, on open level ground away from the wonder. */
export function layoutPuzzles(hf: Heightfield, wonders: Wonder[]): PuzzleSite[] {
  const out: PuzzleSite[] = [];
  const rnd = mulberry32(4242);
  const slope = (x: number, z: number) =>
    Math.abs(hf.height(x + 6, z) - hf.height(x - 6, z)) + Math.abs(hf.height(x, z + 6) - hf.height(x, z - 6));
  for (const region of REGIONS) {
    const B = BIOMES[region];
    for (let slot = 0; slot < 2; slot++) {
      const [count, tuneLength] = SIZE[region][slot];
      const radius = slot === 0 ? 7 : 12;
      for (let tries = 0; tries < 600; tries++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * B.r * 0.8;
        const x = B.x + Math.sin(a) * d;
        const z = B.z + Math.cos(a) * d;
        const h = hf.height(x, z);
        const minH = region === 'drowned' ? -0.9 : 0.8;
        if (h < minH || slope(x, z) > (region === 'dunes' ? 3.5 : 2)) continue;
        if (wonders.some((w) => Math.hypot(w.x - x, w.z - z) < 140)) continue;
        if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 260)) continue;
        const lanterns = Array.from({ length: count }, (_, k) => {
          const la = (k / count) * Math.PI * 2 + a;
          const lx = x + Math.sin(la) * radius;
          const lz = z + Math.cos(la) * radius;
          return { x: lx, y: Math.max(hf.height(lx, lz), region === 'drowned' ? -0.6 : -10), z: lz };
        });
        // A tune visits lanterns in a shuffled order and may come back to one.
        const tune: number[] = [];
        for (let k = 0; k < tuneLength; k++) {
          let n = Math.floor(rnd() * count);
          if (n === tune[k - 1]) n = (n + 1) % count;
          tune.push(n);
        }
        out.push({ id: `puzzle-${region}-${slot}`, region, slot, x, y: Math.max(h, region === 'drowned' ? -0.6 : h), z, lanterns, tune });
        break;
      }
    }
  }
  return out;
}

const key = vec3(SKY.keyLight.x, SKY.keyLight.y, SKY.keyLight.z);

interface Live {
  site: PuzzleSite;
  flames: { value: number }[];
  lit: number[];
  state: 'idle' | 'showing' | 'input' | 'solved';
  step: number;
  t: number;
}

/**
 * Lantern circles: stand on the dais to hear the tune, then light the lanterns in its order.
 * A wrong lantern puts them all out. Solving one lets a star fall onto the dais.
 */
export class Puzzles implements Colliders {
  readonly group = new THREE.Group();
  private live: Live[] = [];
  /** Plays lantern k's note (0..7). */
  onNote: ((k: number) => void) | null = null;
  onFail: (() => void) | null = null;
  onSolve: ((site: PuzzleSite) => void) | null = null;
  /** First time someone steps onto a dais. */
  onDiscover: ((site: PuzzleSite) => void) | null = null;

  constructor(readonly sites: PuzzleSite[], solved: (id: string) => boolean) {
    this.group.name = 'puzzles';
    const stone = new THREE.MeshBasicNodeMaterial();
    const lambert = saturate(dot(normalWorld, key).mul(0.55).add(0.45));
    stone.colorNode = mix(color(0x2c3557), color(0x7a84b4), lambert);
    const post = new THREE.CylinderGeometry(0.22, 0.32, 1.5, 7).translate(0, 0.75, 0);
    // The cap floats clear of the bowl so the flame between them is always visible.
    const cap = new THREE.ConeGeometry(0.42, 0.45, 7).translate(0, 2.55, 0);
    const bowl = new THREE.CylinderGeometry(0.34, 0.26, 0.18, 7).translate(0, 1.58, 0);
    const dais = new THREE.CylinderGeometry(2.2, 2.6, 0.5, 18).translate(0, -0.05, 0);
    const daisMat = new THREE.MeshBasicNodeMaterial();
    // A star carved into the dais, glowing faintly so it reads as somewhere to stand.
    const p = uv().sub(0.5).mul(2);
    const carve = exp(length(p).mul(-3)).mul(0.25);
    daisMat.colorNode = mix(color(0x2a3158), color(0x5b6797), lambert).add(color(PALETTE.starGold).mul(carve));
    for (const site of sites) {
      const isSolved = solved(site.id);
      const live: Live = { site, flames: [], lit: [], state: isSolved ? 'solved' : 'idle', step: 0, t: 0 };
      const d = new THREE.Mesh(dais, daisMat);
      d.position.set(site.x, site.y, site.z);
      this.group.add(d);
      site.lanterns.forEach((l, k) => {
        for (const g of [post, bowl, cap]) {
          const m = new THREE.Mesh(g, stone);
          m.position.set(l.x, l.y - 0.1, l.z);
          this.group.add(m);
        }
        const flame = uniform(isSolved ? 1 : 0);
        live.flames.push(flame);
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
      this.live.push(live);
    }
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const { site } of this.live) {
      if (Math.abs(site.x - x) > reach + 16 || Math.abs(site.z - z) > reach + 16) continue;
      for (const l of site.lanterns) visit(l.x, l.z, 0.35);
    }
  }

  private reset(L: Live) {
    L.lit = [];
    L.step = 0;
    L.flames.forEach((f) => (f.value = 0));
  }

  /** The prompt and action for where the player stands, if a puzzle wants the E key. */
  interaction(x: number, z: number): { prompt: string; act: () => void } | null {
    for (const L of this.live) {
      const s = L.site;
      if (L.state === 'solved' || Math.hypot(s.x - x, s.z - z) > 18) continue;
      if (Math.hypot(s.x - x, s.z - z) < 2.6 && L.state !== 'showing')
        return { prompt: 'E   listen to the lanterns', act: () => this.show(L) };
      if (L.state !== 'input') continue;
      const k = s.lanterns.findIndex((l) => Math.hypot(l.x - x, l.z - z) < 2.3);
      if (k >= 0) return { prompt: 'E   light the lantern', act: () => this.press(L, k) };
    }
    return null;
  }

  private show(L: Live) {
    this.reset(L);
    L.state = 'showing';
    L.step = 0;
    L.t = -0.6;
  }

  private press(L: Live, k: number) {
    const want = L.site.tune[L.step];
    this.onNote?.(k);
    if (k !== want) {
      L.flames[k].value = 1;
      L.state = 'input';
      setTimeout(() => {
        this.reset(L);
        this.onFail?.();
      }, 450);
      return;
    }
    L.flames[k].value = 1;
    L.step++;
    if (L.step >= L.site.tune.length) {
      L.state = 'solved';
      L.flames.forEach((f) => (f.value = 1));
      this.onSolve?.(L.site);
    }
  }

  private discovered = new Set<string>();

  update(dt: number, player: { x: number; z: number }) {
    for (const L of this.live) {
      const s = L.site;
      if (!this.discovered.has(s.id) && Math.hypot(s.x - player.x, s.z - player.z) < 22) {
        this.discovered.add(s.id);
        if (L.state !== 'solved') this.onDiscover?.(s);
      }
      if (L.state !== 'showing') continue;
      // The demonstration: each lantern of the tune flares in turn with its note.
      const prev = Math.floor(L.t / 0.9);
      L.t += dt;
      const now = Math.floor(L.t / 0.9);
      if (L.t >= 0 && now !== prev && now < s.tune.length) {
        const k = s.tune[now];
        L.flames.forEach((f) => (f.value = 0));
        L.flames[k].value = 1;
        this.onNote?.(k);
      }
      if (L.t >= 0 && L.t % 0.9 > 0.6) L.flames.forEach((f) => (f.value = 0));
      if (L.t > s.tune.length * 0.9 + 0.3) {
        L.flames.forEach((f) => (f.value = 0));
        L.state = 'input';
        L.step = 0;
      }
    }
  }
}

