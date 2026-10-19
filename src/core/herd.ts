// The star deer herd's behaviour, engine-free: where a herd lives, grazing and wandering,
// bolting from a running Keeper. The renderer only poses the deer this moves.
import { mulberry32, type Heightfield } from './heightfield';

export interface Deer {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  target: number;
  phase: number;
  state: 'graze' | 'walk' | 'flee';
  timer: number;
  scale: number;
}

interface Point {
  x: number;
  z: number;
}

export class Herd {
  readonly deer: Deer[] = [];
  /** Where the herd lives; far away when there is no herd near the Keeper. */
  readonly home = { x: 1e9, y: 0, z: 1e9 };
  private rnd = mulberry32(77);

  constructor(private hf: Heightfield, count: number) {
    for (let i = 0; i < count; i++)
      this.deer.push({ x: 0, y: -9999, z: 0, yaw: 0, speed: 0, target: 0, phase: this.rnd() * 6, state: 'graze', timer: this.rnd() * 5, scale: 0.85 + this.rnd() * 0.3 });
  }

  get present() {
    return this.home.x < 1e8;
  }

  private place(focus: Point) {
    // A herd lives where the meadows and the wood are; find open ground near you there.
    for (let tries = 0; tries < 60; tries++) {
      const a = this.rnd() * Math.PI * 2;
      const d = 70 + this.rnd() * 160;
      const x = focus.x + Math.sin(a) * d;
      const z = focus.z + Math.cos(a) * d;
      const s = this.hf.sample(x, z);
      if (s.height < 1 || s.rock > 0.2 || Math.max(s.meadow, s.lantern * 0.6) < 0.35) continue;
      Object.assign(this.home, { x, y: s.height, z });
      this.deer.forEach((dr, i) => {
        dr.x = x + Math.cos(i * 2.3) * (3 + i * 1.3);
        dr.z = z + Math.sin(i * 2.3) * (3 + i * 1.3);
        dr.yaw = this.rnd() * Math.PI * 2;
        dr.state = 'graze';
      });
      return true;
    }
    return false;
  }

  /** Returns true on a frame when the herd bolts. */
  update(dt: number, focus: Point, playerSpeed: number) {
    const here = this.hf.sample(focus.x, focus.z);
    if (Math.hypot(this.home.x - focus.x, this.home.z - focus.z) > 450) {
      if (Math.max(here.meadow, here.lantern) < 0.25 || !this.place(focus)) {
        Object.assign(this.home, { x: 1e9, y: 0, z: 1e9 });
        for (const d of this.deer) d.y = -9999;
        return false;
      }
    }
    let fled = false;
    for (const d of this.deer) {
      const dx = d.x - focus.x;
      const dz = d.z - focus.z;
      const dist = Math.hypot(dx, dz);
      // Startle: a running Keeper, or anyone too close.
      if (d.state !== 'flee' && (dist < 9 || (dist < 22 && playerSpeed > 5))) {
        d.state = 'flee';
        d.timer = 4 + this.rnd() * 2;
        d.target = Math.atan2(dx, dz);
        fled = true;
      }
      d.timer -= dt;
      if (d.timer <= 0) {
        if (d.state === 'flee' || d.state === 'walk') {
          d.state = 'graze';
          d.timer = 3 + this.rnd() * 6;
        } else {
          d.state = 'walk';
          d.timer = 2 + this.rnd() * 4;
          // Wander, drifting back toward the herd's home.
          const home = Math.atan2(this.home.x - d.x, this.home.z - d.z);
          d.target = home + (this.rnd() - 0.5) * 2.2;
        }
      }
      const want = d.state === 'flee' ? 8 : d.state === 'walk' ? 1.3 : 0;
      d.speed += (want - d.speed) * Math.min(1, dt * (d.state === 'flee' ? 4 : 1.5));
      let diff = d.target - d.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (d.state !== 'graze') d.yaw += diff * Math.min(1, dt * 3);
      const nx = d.x + Math.sin(d.yaw) * d.speed * dt;
      const nz = d.z + Math.cos(d.yaw) * d.speed * dt;
      if (this.hf.height(nx, nz) > 0.4) {
        d.x = nx;
        d.z = nz;
      } else d.target += Math.PI * 0.5;
      d.phase += dt * (d.speed * 2.6 + (d.state === 'graze' ? 0 : 0.5));
      d.y = this.hf.height(d.x, d.z);
    }
    return fled;
  }
}
