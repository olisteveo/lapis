// Squalls: rain and wind rolling in off the sea (docs/SURVIVAL.md, phase 4). Engine-agnostic.
// A squall builds, rages, then passes; the calm between them shortens and the squalls grow fiercer
// with pressure (how late the night is, and how near the story is to its storm).

import { mulberry32 } from './heightfield';

export type SquallPhase = 'calm' | 'building' | 'raging' | 'passing';

const BUILD = 14;
const PASS = 18;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

export class SquallClock {
  phase: SquallPhase = 'calm';
  /** 0..1: how hard it's raining and blowing right now. */
  intensity = 0;
  /** Direction the wind blows toward, radians (0 = +z). */
  windAngle = 0;
  /** Seconds spent in the current phase, and how long this phase lasts. */
  private t = 0;
  private length: number;
  private peak = 1;
  private clock = 0;
  private rnd: () => number;

  constructor(seed = 4242) {
    this.rnd = mulberry32(seed);
    this.windAngle = this.rnd() * Math.PI * 2;
    // The first one never comes in the opening minutes.
    this.length = 180 + this.rnd() * 60;
  }

  /** Wind as a vector (m/s per unit strength), scaled by intensity. */
  get wind() {
    return { x: Math.sin(this.windAngle) * this.intensity, z: Math.cos(this.windAngle) * this.intensity };
  }

  /**
   * pressure: 0..1, how late and how near the storm. enabled: false (wandering) keeps it calm.
   * Returns the phase just entered on the frame it changes, else null.
   */
  update(dt: number, pressure: number, enabled = true): SquallPhase | null {
    this.clock += dt;
    this.t += dt;
    this.windAngle += (this.rnd() - 0.5) * dt * 0.12;
    let entered: SquallPhase | null = null;
    if (!enabled) {
      if (this.phase !== 'calm') entered = this.enter('calm', pressure);
      this.intensity = Math.max(0, this.intensity - dt * 0.2);
      return entered;
    }
    if (this.t >= this.length) {
      const next: SquallPhase = this.phase === 'calm' ? 'building' : this.phase === 'building' ? 'raging' : this.phase === 'raging' ? 'passing' : 'calm';
      entered = this.enter(next, pressure);
    }
    const k = Math.min(1, this.t / this.length);
    const gust = 0.85 + 0.15 * Math.sin(this.clock * 1.7) * Math.sin(this.clock * 0.53);
    this.intensity =
      this.phase === 'building' ? smooth(k) * this.peak
      : this.phase === 'raging' ? this.peak * gust
      : this.phase === 'passing' ? (1 - smooth(k)) * this.peak
      : 0;
    return entered;
  }

  private enter(phase: SquallPhase, pressure: number): SquallPhase {
    this.phase = phase;
    this.t = 0;
    const p = Math.min(1, Math.max(0, pressure));
    if (phase === 'calm') this.length = lerp(260, 80, p) * (0.75 + this.rnd() * 0.5);
    else if (phase === 'building') {
      this.length = BUILD;
      this.peak = 0.6 + 0.4 * p;
      // Each squall comes from somewhere new.
      this.windAngle = this.rnd() * Math.PI * 2;
    } else if (phase === 'raging') this.length = lerp(45, 90, p) * (0.8 + this.rnd() * 0.4);
    else this.length = PASS;
    return phase;
  }
}
