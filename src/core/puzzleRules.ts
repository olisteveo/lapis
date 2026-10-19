// The puzzles' rules, engine-free: each is a small state machine the renderer reads from.
// Deterministic (own clocks, no wall time), so they port to C# and run headless in tests.
import type { PuzzleSite } from './puzzles';

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  speed: number;
}

/** Constellation stones: each dial must show the sky feature its stone faces. */
export class StonesRule {
  readonly shown: number[];
  solved: boolean;

  constructor(readonly site: PuzzleSite, readonly featureCount: number, solved: boolean) {
    this.solved = solved;
    // Every dial starts on a wrong face (deterministic, so it's the same puzzle each visit).
    this.shown = site.stones!.map((s, i) => (solved ? s.answer : (s.answer + 1 + ((i * 7 + 3) % (featureCount - 1))) % featureCount));
  }

  /** Turn stone i to its next face. Returns true if that solved it. */
  turn(i: number) {
    if (this.solved) return false;
    this.shown[i] = (this.shown[i] + 1) % this.featureCount;
    this.solved = this.site.stones!.every((s, k) => this.shown[k] === s.answer);
    return this.solved;
  }
}

export type RingResult = 'right' | 'wrong' | 'solved';

/** Reflection bells: ring them in the order only still water shows. */
export class BellsRule {
  step = 0;
  solved: boolean;
  /** Seconds the Keeper has stood still nearby; the true marks show after 1.5 s. */
  still = 0;

  constructor(readonly site: PuzzleSite, solved: boolean) {
    this.solved = solved;
  }

  get marksVisible() {
    return !this.solved && this.still > 1.5;
  }

  ring(i: number): RingResult {
    if (this.solved) return 'solved';
    if (this.site.order![this.step] !== i) {
      this.step = 0;
      return 'wrong';
    }
    this.step++;
    if (this.step >= this.site.order!.length) this.solved = true;
    return this.solved ? 'solved' : 'right';
  }

  update(dt: number, player: PlayerState) {
    const nearby = Math.hypot(player.x - this.site.x, player.z - this.site.z) < 30;
    this.still = nearby && player.speed < 0.3 ? this.still + dt : 0;
  }
}

/** Glowcaps: lights out over a root network; lit caps gutter out after a while. */
export class GlowcapsRule {
  static readonly FADE = 45;
  readonly lit: boolean[];
  readonly age: number[];
  solved: boolean;

  constructor(readonly site: PuzzleSite, solved: boolean) {
    this.solved = solved;
    this.lit = solved ? site.caps!.map(() => true) : [...site.start!];
    this.age = this.lit.map(() => 0);
  }

  /** Touch cap i: it and every cap its roots reach flip. Returns true if that solved it. */
  touch(i: number) {
    if (this.solved) return false;
    for (const j of [i, ...this.site.links![i]]) {
      this.lit[j] = !this.lit[j];
      this.age[j] = 0;
    }
    this.solved = this.lit.every(Boolean);
    return this.solved;
  }

  update(dt: number) {
    if (this.solved) return;
    this.lit.forEach((l, i) => {
      if (!l) return;
      this.age[i] += dt;
      if (this.age[i] > GlowcapsRule.FADE) this.lit[i] = false;
    });
  }

  /** 1 when freshly lit, dimming toward 0.4 as a cap nears its time (for the glow). */
  brightness(i: number) {
    if (!this.lit[i]) return 0;
    if (this.solved) return 1;
    return 1 - Math.max(0, (this.age[i] - GlowcapsRule.FADE * 0.6) / (GlowcapsRule.FADE * 0.4)) * 0.6;
  }
}

export interface Beam {
  /** Node indices the light visits, from the source. */
  path: number[];
  /** Reached the shrine. */
  reached: boolean;
  /** Reached the shrine having touched every cap. */
  complete: boolean;
}

/** Mirror caps: aim each cap so the beam touches them all before the shrine. */
export class MirrorsRule {
  readonly aim: number[];
  solved: boolean;
  beam: Beam = { path: [0], reached: false, complete: false };

  constructor(readonly site: PuzzleSite, solved: boolean) {
    this.solved = solved;
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
    this.trace();
  }

  /** Turn cap i to its next target. Returns true if that solved it. */
  turn(i: number) {
    if (this.solved) return false;
    const opts = this.site.aims![i];
    this.aim[i] = opts[(opts.indexOf(this.aim[i]) + 1) % opts.length];
    this.trace();
    return this.solved;
  }

  private trace() {
    const last = this.site.nodes!.length - 1;
    const seen = new Set<number>([0]);
    const path = [0];
    let cur = 0;
    let reached = false;
    for (;;) {
      const next = this.aim[cur];
      if (next === undefined || next < 0) break;
      path.push(next);
      if (next === last) {
        reached = true;
        break;
      }
      if (seen.has(next)) break;
      seen.add(next);
      cur = next;
    }
    const complete = reached && seen.size === last;
    this.beam = { path, reached, complete };
    if (complete) this.solved = true;
  }
}

export type FirefliesEvent = 'scattered' | 'solved' | null;

/** The firefly jar: open it with a moonflower, then herd the shy swarm in. */
export class FirefliesRule {
  state: 'shut' | 'open' | 'solved';
  carrying = false;
  readonly swarm: { x: number; y: number; z: number };
  scatterT = 0;
  private dodge = 0;
  private t = 0;

  constructor(readonly site: PuzzleSite, solved: boolean) {
    this.state = solved ? 'solved' : 'shut';
    this.swarm = { x: site.x, y: site.y + 1.3, z: site.z };
  }

  get solved() {
    return this.state === 'solved';
  }

  pick() {
    if (this.state === 'shut' && !this.carrying) this.carrying = true;
  }

  /** Put the carried moonflower in the jar. */
  open() {
    if (!this.carrying) return;
    this.carrying = false;
    this.state = 'open';
  }

  update(dt: number, player: PlayerState): FirefliesEvent {
    this.t += dt;
    if (this.state === 'solved') return null;
    const t = this.t;
    const S = this.swarm;
    const home = this.site;
    const j = this.site.jar!;
    const dx = S.x - player.x;
    const dz = S.z - player.z;
    const d = Math.max(Math.hypot(dx, dz), 1e-4);
    let event: FirefliesEvent = null;
    this.scatterT = Math.max(0, this.scatterT - dt);
    // Startled: a running Keeper, or one who comes too close. They bolt for home.
    if (this.scatterT <= 0 && (d < 4 || (d < 14 && player.speed > 4.2))) {
      this.scatterT = 3.5;
      event = 'scattered';
    }
    let mx = 0;
    let mz = 0;
    const toward = (tx: number, tz: number, cap: number, k: number) => {
      const l = Math.hypot(tx, tz);
      const s = l > cap ? cap / l : 1;
      mx += tx * s * k;
      mz += tz * s * k;
    };
    if (this.scatterT > 0) toward(home.x - S.x, home.z - S.z, 1, 7);
    else {
      // Shy, but flighty: they dart away from you at a slant that keeps changing, so you have to
      // keep stepping round to steer them.
      this.dodge += (Math.sin(t * 0.7 + this.site.x) * 0.9 + Math.sin(t * 1.9) * 0.5 - this.dodge) * Math.min(1, dt * 2);
      if (d < 7.5) {
        const c = Math.cos(this.dodge);
        const s = Math.sin(this.dodge);
        const ax = dx / d;
        const az = dz / d;
        const k = (7.5 - d) * 1.1;
        mx += (ax * c - az * s) * k;
        mz += (ax * s + az * c) * k;
      }
      // They wander on their own as well.
      mx += Math.sin(t * 0.43 + 1) * 0.45;
      mz += Math.cos(t * 0.31) * 0.45;
      // With the moonflower in it, the jar's scent pulls them gently.
      if (this.state === 'open') {
        const l = Math.max(Math.hypot(j.x - S.x, j.z - S.z), 1e-4);
        mx += ((j.x - S.x) / l) * 0.25;
        mz += ((j.z - S.z) / l) * 0.25;
      }
      // Left alone, they wander back to the long grass where they live.
      if (d > 18) toward(home.x - S.x, home.z - S.z, 1, 0.5);
    }
    S.x += mx * dt;
    S.z += mz * dt;
    for (const r of this.site.rocks!) {
      const rx = S.x - r.x;
      const rz = S.z - r.z;
      const rd = Math.max(Math.hypot(rx, rz), 1e-4);
      if (rd < r.r + 1) {
        S.x = r.x + (rx / rd) * (r.r + 1);
        S.z = r.z + (rz / rd) * (r.r + 1);
      }
    }
    S.y += (Math.max(this.site.y, j.y) + 1.3 - S.y) * Math.min(1, dt);
    if (this.state === 'open' && Math.hypot(S.x - j.x, S.z - j.z) < 1.2) {
      this.state = 'solved';
      event = 'solved';
    }
    return event;
  }
}

/** Footprints in the dew: shown only to a gentle walker; solved on reaching where she went. */
export class DewTrailRule {
  /** 0..1: how visible the prints are (they blur away while running). */
  gentle = 1;
  solved: boolean;

  constructor(readonly site: PuzzleSite, solved: boolean) {
    this.solved = solved;
  }

  /** Returns true on the frame it is solved. */
  update(dt: number, player: PlayerState) {
    const want = player.speed > 4.2 ? 0 : 1;
    this.gentle += (want - this.gentle) * Math.min(1, dt * 3);
    const r = this.site.reward!;
    if (!this.solved && Math.hypot(r.x - player.x, r.z - player.z) < 2.5) {
      this.solved = true;
      return true;
    }
    return false;
  }
}
