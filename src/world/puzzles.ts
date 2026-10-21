import * as THREE from 'three/webgpu';
import { cameraPosition, color, length, normalWorld, positionLocal, positionWorld, sin, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { drawnSurface } from '../render/drawn';
import { SKY } from '../config';
import type { Colliders } from '../core/player';
import { StoneRing } from './puzzleStones';
import { BellPool } from './puzzleBells';
import { DewTrail, Fireflies } from './puzzleMeadow';
import { Glowcaps, MirrorCaps } from './puzzleWood';

export type { Region, PuzzleKind, Spot, PuzzleSite, SkyFeature } from '../core/puzzles';
export { skyFeatures, layoutPuzzles } from '../core/puzzles';
import type { PuzzleSite, SkyFeature } from '../core/puzzles';

export type { PlayerState } from '../core/puzzleRules';
import type { PlayerState } from '../core/puzzleRules';

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
  m.colorNode = drawnSurface(color(0x6a74a8), normalWorld, positionWorld);
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
  /** First time an unsolved puzzle's thread of light comes within sight (350 m). */
  onSpotted: ((site: PuzzleSite) => void) | null = null;
  private spotted = new Set<string>();

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
    // A thread of light over every unsolved puzzle, rising high enough to see across a region and
    // fading as you arrive, so puzzles can be found by looking rather than stumbled on.
    for (const p of this.impls) {
      const fade = uniform(p.solved ? 0 : 1);
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const h = positionLocal.y.div(70).add(0.5);
      const d = length(positionWorld.xz.sub(cameraPosition.xz));
      const shimmer = sin(time.mul(1.3).add(h.mul(9)).add(p.site.x)).mul(0.25).add(0.75);
      mat.colorNode = color(0xbfe6ff).mul(smoothstep(1, 0.15, h).mul(smoothstep(0, 0.05, h)).mul(shimmer).mul(smoothstep(30, 90, d)).mul(smoothstep(1200, 700, d)).mul(fade).mul(0.55));
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.6, 70, 10, 1, true), mat);
      beam.position.set(p.site.x, p.site.y + 35, p.site.z);
      beam.frustumCulled = false;
      this.group.add(beam);
      this.markers.push({ impl: p, fade });
    }
  }

  private markers: { impl: PuzzleImpl; fade: { value: number } }[] = [];

  /** The nearest unsolved puzzle within r of (x, z), optionally in one region. */
  nearestUnsolved(x: number, z: number, r: number, region?: string) {
    let best: PuzzleSite | null = null;
    let bestD = r;
    for (const p of this.impls) {
      if (p.solved || (region && p.site.region !== region)) continue;
      const d = Math.hypot(p.site.x - x, p.site.z - z);
      if (d < bestD) {
        bestD = d;
        best = p.site;
      }
    }
    return best;
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
      // Far puzzles cost no draw calls; their solved light (a scene light) is handled elsewhere.
      p.group.visible = Math.hypot(p.site.x - player.x, p.site.z - player.z) < 800;
      if (!p.solved && !this.spotted.has(p.site.id) && Math.hypot(p.site.x - player.x, p.site.z - player.z) < 350) {
        this.spotted.add(p.site.id);
        this.onSpotted?.(p.site);
      }
      if (!this.discovered.has(p.site.id) && Math.hypot(p.site.x - player.x, p.site.z - player.z) < 22) {
        this.discovered.add(p.site.id);
        if (!p.solved) this.onDiscover?.(p.site);
      }
      p.update(dt, player);
    }
    for (const m of this.markers) m.fade.value += ((m.impl.solved ? 0 : 1) - m.fade.value) * Math.min(1, dt * 0.5);
  }
}
