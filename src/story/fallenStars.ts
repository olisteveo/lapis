import * as THREE from 'three/webgpu';
import { cameraPosition, color, exp, float, length, mix, positionWorld, sin, smoothstep, time, uniform, uv, vec4, abs } from 'three/tsl';
import { PALETTE } from '../config';
import { starShape } from '../render/starShape';
import type { P } from '../core/placement';

/** How far an unmarked star's glint can be seen; the paper lantern pushes it out. */
export const SEE_RANGE = uniform(75);

interface Star {
  id: string;
  index: number;
  home: THREE.Vector3;
  group: THREE.Group;
  core: THREE.Sprite;
  pillar: THREE.Sprite;
  alpha: { value: number };
  pillarAlpha: { value: number };
  landT: number;
  collected: boolean;
  carried: boolean;
  /** Tutorial stars send up a column of light; the rest must be found. */
  beacon: boolean;
  /** Hidden until revealed (inside a wonder, behind a puzzle, or still to fall in the opening). */
  held: boolean;
  flightFrom: THREE.Vector3;
  flight: number;
  target: THREE.Vector3;
}

/**
 * A fallen star resting on the world: a hovering four-point glint and a faint column of
 * light that can be seen from across the bay, so there is always somewhere to walk toward.
 */
export class FallenStars {
  readonly group = new THREE.Group();
  private stars: Star[] = [];
  private light = new THREE.PointLight(PALETTE.starGold, 3, 22, 1.6);
  private pillarTarget = 0;
  onArrive: ((id: string) => void) | null = null;

  constructor(entries: { id: string; pos: P; beacon: boolean }[], height: (x: number, z: number) => number) {
    this.group.name = 'fallenStars';
    this.group.add(this.light);
    entries.forEach(({ id, pos: s, beacon }, i) => {
      const y = Math.max(height(s.x, s.z), 0) + 1.1;
      const home = new THREE.Vector3(s.x, y, s.z);
      const alpha = uniform(1);
      const pillarAlpha = uniform(0);
      const group = new THREE.Group();
      group.position.copy(home);

      const coreMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const tw = sin(time.mul(2.3).add(i * 1.7)).mul(0.15).add(1);
      // Unmarked stars only show themselves when you are close: a glint in the undergrowth, not a beacon.
      const seen: any = beacon ? float(1) : smoothstep(SEE_RANGE, SEE_RANGE.mul(0.33), length(positionWorld.sub(cameraPosition)));
      coreMat.colorNode = vec4(mix(color(PALETTE.starWhite), color(PALETTE.starGold), 0.4).mul(starShape(uv(), float(0.9), float(0.5))).mul(tw).mul(beacon ? 2.6 : 1.6).mul(alpha).mul(seen), 1);
      const core = new THREE.Sprite(coreMat);
      core.scale.setScalar(beacon ? 1.3 : 0.9);

      const pillarMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const d = length(positionWorld.xz.sub(cameraPosition.xz));
      // Visible across the bay, gone when you're standing in it.
      const reach = smoothstep(1400, 300, d).mul(smoothstep(6, 35, d));
      const across = exp(abs(uv().x.sub(0.5)).mul(-14));
      const up = float(1).sub(uv().y).pow(1.6);
      const shimmer = sin(uv().y.mul(40).sub(time.mul(1.5))).mul(0.15).add(0.85);
      pillarMat.colorNode = vec4(color(PALETTE.starGold).mul(across.mul(up).mul(shimmer).mul(reach).mul(0.55)).mul(alpha).mul(pillarAlpha), 1);
      const pillar = new THREE.Sprite(pillarMat);
      pillar.center.set(0.5, 0);
      pillar.scale.set(2.2, 90, 1);
      pillar.position.y = -1;

      pillar.visible = beacon;
      group.add(core, pillar);
      this.group.add(group);
      this.stars.push({ id, index: i, home, group, core, pillar, alpha, pillarAlpha, landT: -1, collected: false, carried: false, beacon, held: false, flightFrom: new THREE.Vector3(), flight: -1, target: new THREE.Vector3() });
    });
  }

  private pillarHeight() {
    return this.pillarTarget > 0 ? 90 : 7;
  }

  /** Pillars stay dark through the opening and rise once you're up and exploring. */
  showPillars(on: boolean) {
    this.pillarTarget = on ? 1 : 0;
  }

  /** Keep a star out of the world until the opening shows it falling. */
  hold(index: number) {
    const s = this.stars[index];
    if (s && !s.collected) {
      s.group.visible = false;
      s.held = true;
    }
  }

  indexOf(id: string) {
    return this.stars.findIndex((s) => s.id === id);
  }

  isHeld(id: string) {
    return !!this.stars.find((s) => s.id === id)?.held;
  }

  position(index: number) {
    return this.stars[index]?.home;
  }

  /** The star arrives: a flash where it lands, then its column of light climbs. */
  land(index: number) {
    const s = this.stars[index];
    // Already down (seen falling in the opening): don't replay the arrival.
    if (!s || s.collected || (!s.held && s.group.visible && s.pillarAlpha.value > 0.5)) return;
    s.held = false;
    s.group.visible = true;
    s.landT = 0;
  }

  markCollected(ids: Set<string>) {
    for (const s of this.stars)
      if (ids.has(s.id)) {
        s.collected = true;
        s.group.visible = false;
      }
  }

  /** Where the uncollected, not carried stars lie (for the map). */
  get waiting() {
    return this.stars.filter((s) => !s.collected && !s.carried && !s.held).map((s) => s.home);
  }

  /** Nearest uncollected, revealed star to the player (optionally only the tutorial ones). */
  nearest(x: number, z: number, beaconsOnly = false) {
    let best: Star | null = null;
    let bd = Infinity;
    for (const s of this.stars) {
      if (s.collected || s.held || (beaconsOnly && !s.beacon)) continue;
      const d = Math.hypot(s.home.x - x, s.home.z - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best ? { id: best.id, index: best.index, dist: bd, pos: best.home, beacon: best.beacon } : null;
  }

  /** Lift the star away toward its place in the constellation. */
  collect(id: string, skyTarget: THREE.Vector3) {
    const s = this.stars.find((v) => v.id === id);
    if (!s || (s.collected && !s.carried)) return;
    s.collected = true;
    s.carried = false;
    s.flight = 0;
    s.flightFrom.copy(s.group.position);
    s.target.copy(skyTarget);
  }

  /** Pick a star up: it follows you as a small light until banked or lost. */
  carry(id: string) {
    const s = this.stars.find((v) => v.id === id);
    if (!s || s.collected) return;
    s.collected = true;
    s.carried = true;
    s.pillar.visible = false;
    s.core.scale.setScalar(0.7);
  }

  /** Lost when you wake: the star drifts back to where it fell. */
  drop(id: string) {
    const s = this.stars.find((v) => v.id === id);
    if (!s || !s.carried) return;
    s.carried = false;
    s.collected = false;
    s.core.scale.setScalar(s.beacon ? 1.3 : 0.9);
    s.pillar.visible = s.beacon;
    s.group.visible = true;
    s.group.position.copy(s.home);
    s.landT = 0;
  }

  get carriedIds() {
    return this.stars.filter((s) => s.carried).map((s) => s.id);
  }

  update(dt: number, camera: THREE.Camera) {
    const t = performance.now() / 1000;
    let lightFor: Star | null = null;
    let ld = Infinity;
    for (const s of this.stars) {
      if (s.flight >= 0) {
        s.flight += dt / 3.2;
        const k = Math.min(1, s.flight);
        const e = k * k * (3 - 2 * k);
        // Rise gently, then accelerate toward the sky point (a fixed offset from the camera).
        const to = camera.position.clone().addScaledVector(s.target, 600);
        s.group.position.lerpVectors(s.flightFrom, to, e * e);
        s.group.position.y += Math.sin(k * Math.PI) * 6;
        s.pillar.visible = false;
        s.alpha.value = 1 - Math.max(0, (k - 0.75) / 0.25);
        if (s.flight >= 1) {
          s.flight = -1;
          s.group.visible = false;
          this.onArrive?.(s.id);
        }
        continue;
      }
      if (s.carried) {
        // Orbit the Keeper slowly at chest height, each carried star in its own slot.
        const carried = this.stars.filter((v) => v.carried);
        const k = carried.indexOf(s);
        const a = t * 0.7 + (k / carried.length) * Math.PI * 2;
        const want = camera.position.clone().add(new THREE.Vector3(Math.cos(a) * 1.2, -0.45 + Math.sin(t * 1.3 + k) * 0.12, Math.sin(a) * 1.2));
        s.group.position.lerp(want, Math.min(1, dt * 4));
        s.alpha.value = 0.75 + Math.sin(t * 2 + k) * 0.15;
        continue;
      }
      if (s.collected) continue;
      if (s.landT >= 0) {
        s.landT += dt;
        const k = s.landT;
        // A bright flash that settles, and the pillar growing up out of it.
        s.alpha.value = 1 + Math.max(0, 3.5 * Math.exp(-k * 2.5));
        s.pillar.scale.y = this.pillarHeight() * Math.min(1, k / 2.5) ** 0.6;
        s.pillarAlpha.value = Math.min(1, k / 1.2);
        if (k > 4) s.landT = -1;
      } else {
        // Short while you lie watching it land; full height once you're up and exploring.
        s.pillar.scale.y += (this.pillarHeight() - s.pillar.scale.y) * Math.min(1, dt * 0.6);
        s.pillarAlpha.value += (Math.max(this.pillarTarget, s.pillarAlpha.value > 0.99 ? 1 : 0) - s.pillarAlpha.value) * Math.min(1, dt * 0.8);
      }
      s.group.position.set(s.home.x, s.home.y + Math.sin(t * 1.2 + s.index) * 0.12, s.home.z);
      const d = camera.position.distanceTo(s.home);
      if (d < ld) {
        ld = d;
        lightFor = s;
      }
    }
    // One warm light follows the nearest star so it gilds the sand and water around it.
    if (lightFor && ld < 60) {
      this.light.visible = true;
      this.light.position.copy(lightFor.group.position);
      this.light.intensity = 3 + Math.sin(t * 2.3) * 0.4;
    } else this.light.visible = false;
  }
}
