import * as THREE from 'three/webgpu';
import { cameraPosition, color, exp, float, length, mix, positionWorld, sin, smoothstep, time, uniform, uv, vec4, abs } from 'three/tsl';
import { PALETTE } from '../config';
import { starShape } from '../render/starShape';
import type { P } from './placement';

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
  onArrive: ((index: number) => void) | null = null;

  constructor(ids: string[], spots: P[], height: (x: number, z: number) => number) {
    this.group.name = 'fallenStars';
    this.group.add(this.light);
    ids.forEach((id, i) => {
      const s = spots[i];
      const y = Math.max(height(s.x, s.z), 0) + 1.1;
      const home = new THREE.Vector3(s.x, y, s.z);
      const alpha = uniform(1);
      const pillarAlpha = uniform(0);
      const group = new THREE.Group();
      group.position.copy(home);

      const coreMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const tw = sin(time.mul(2.3).add(i * 1.7)).mul(0.15).add(1);
      coreMat.colorNode = vec4(mix(color(PALETTE.starWhite), color(PALETTE.starGold), 0.4).mul(starShape(uv(), float(0.9), float(0.5))).mul(tw).mul(2.6).mul(alpha), 1);
      const core = new THREE.Sprite(coreMat);
      core.scale.setScalar(1.3);

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

      group.add(core, pillar);
      this.group.add(group);
      this.stars.push({ id, index: i, home, group, core, pillar, alpha, pillarAlpha, landT: -1, collected: false, flight: -1, target: new THREE.Vector3() });
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
    if (s && !s.collected) s.group.visible = false;
  }

  position(index: number) {
    return this.stars[index]?.home;
  }

  /** The star arrives: a flash where it lands, then its column of light climbs. */
  land(index: number) {
    const s = this.stars[index];
    // Already down (seen falling in the opening): don't replay the arrival.
    if (!s || s.collected || (s.group.visible && s.pillarAlpha.value > 0.5)) return;
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

  /** Nearest uncollected star to the player. */
  nearest(x: number, z: number) {
    let best: Star | null = null;
    let bd = Infinity;
    for (const s of this.stars) {
      if (s.collected) continue;
      const d = Math.hypot(s.home.x - x, s.home.z - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best ? { id: best.id, index: best.index, dist: bd, pos: best.home } : null;
  }

  /** Lift the star away toward its place in the constellation. */
  collect(id: string, skyTarget: THREE.Vector3) {
    const s = this.stars.find((v) => v.id === id);
    if (!s || s.collected) return;
    s.collected = true;
    s.flight = 0;
    s.target.copy(skyTarget);
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
        s.group.position.lerpVectors(s.home, to, e * e);
        s.group.position.y += Math.sin(k * Math.PI) * 6;
        s.pillar.visible = false;
        s.alpha.value = 1 - Math.max(0, (k - 0.75) / 0.25);
        if (s.flight >= 1) {
          s.flight = -1;
          s.group.visible = false;
          this.onArrive?.(s.index);
        }
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
