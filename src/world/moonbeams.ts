import * as THREE from 'three/webgpu';
import { abs, color, exp, float, sin, smoothstep, time, uniform, uv, vec4 } from 'three/tsl';
import type { Heightfield } from '../core/heightfield';

const CELL = 13;
const RADIUS = 85;
const POOL = 48;

/**
 * Shafts of moonlight falling through gaps in the canopy around you. Placed from a hash
 * grid so the same gaps are always in the same places, only where the jungle is thick.
 */
export class Moonbeams {
  readonly group = new THREE.Group();
  private sprites: THREE.Sprite[] = [];
  private fades: { value: number }[] = [];
  private last = new THREE.Vector3(1e9, 0, 1e9);
  /** Whether the beams should draw this frame (the reflection pass restores to this). */
  wanted = false;

  constructor(private hf: Heightfield) {
    this.group.name = 'moonbeams';
    for (let i = 0; i < POOL; i++) {
      const fade = uniform(0);
      const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const across = exp(abs(uv().x.sub(0.5)).mul(-5));
      // Brightest where it breaks through the canopy, thinning toward the floor.
      const along = smoothstep(0.0, 0.25, uv().y).mul(smoothstep(1.0, 0.7, uv().y).mul(0.5).add(0.5));
      const drift = sin(time.mul(0.4).add(float(i * 1.7))).mul(0.25).add(0.75);
      mat.colorNode = vec4(color(0x9fb4ff).mul(across.mul(along).mul(drift).mul(0.42).mul(fade)), 1);
      const s = new THREE.Sprite(mat);
      s.center.set(0.5, 0);
      s.visible = false;
      this.sprites.push(s);
      this.fades.push(fade);
      this.group.add(s);
    }
  }

  private hash(i: number, j: number) {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  update(dt: number, focus: THREE.Vector3) {
    if (focus.distanceToSquared(this.last) > 36) {
      this.last.copy(focus);
      let n = 0;
      const i0 = Math.floor((focus.x - RADIUS) / CELL);
      const j0 = Math.floor((focus.z - RADIUS) / CELL);
      for (let j = j0; j <= j0 + (2 * RADIUS) / CELL && n < POOL; j++)
        for (let i = i0; i <= i0 + (2 * RADIUS) / CELL && n < POOL; i++) {
          if (this.hash(i, j) > 0.22) continue;
          const x = (i + this.hash(i + 7, j)) * CELL;
          const z = (j + this.hash(i, j + 7)) * CELL;
          if (Math.hypot(x - focus.x, z - focus.z) > RADIUS) continue;
          const s = this.hf.sample(x, z);
          if (s.grove < 0.45 || s.height < 3 || s.rock > 0.1) continue;
          const sp = this.sprites[n++];
          sp.position.set(x, s.height - 0.5, z);
          sp.scale.set(2.5 + this.hash(i, j + 3) * 3, 22 + this.hash(i + 3, j) * 10, 1);
          sp.visible = true;
        }
      for (let k = n; k < POOL; k++) this.sprites[k].visible = false;
    }
    // Beams only make sense from under the canopy; from the shore or the sea they read as searchlights.
    const inside = Math.min(1, Math.max(0, (this.hf.sample(focus.x, focus.z).grove - 0.35) / 0.3));
    for (let k = 0; k < POOL; k++) {
      const s = this.sprites[k];
      const d = s.visible ? Math.hypot(s.position.x - focus.x, s.position.z - focus.z) : RADIUS;
      // Fade with distance, and fade out when you're standing right in one.
      const target = s.visible ? Math.min(1, (RADIUS - d) / 25) * Math.min(1, d / 6) * inside : 0;
      this.fades[k].value += (target - this.fades[k].value) * Math.min(1, dt * 2);
      if (this.fades[k].value < 0.01 && target === 0) this.fades[k].value = 0;
    }
    // Don't draw at all outside the jungle (saves fill-rate, and guarantees no stray shafts).
    this.wanted = inside > 0.01 || this.fades.some((f) => f.value > 0.01);
    this.group.visible = this.wanted;
  }
}
