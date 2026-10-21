// Survival: warmth, the light you carry, and what a rest buys. Engine-agnostic (docs/SURVIVAL.md).

export type SurvivalMode = 'wander' | 'story' | 'survival';

export interface SurvivalTuning {
  /** Warmth lost per second in full dark at dusk; scaled up as the night grows late. */
  drainDark: number;
  /** Extra drain per second standing in the sea, and out in the wind. */
  drainWater: number;
  drainWind: number;
  /** Extra drain per second at the heart of the Dark Water. */
  drainDarkWater: number;
  /** Extra drain per second out in the full rain of a squall, unsheltered. */
  drainRain: number;
  /** Extra drain per second with your head under the water, on top of being in it. */
  drainDive: number;
  /** Drain per second in a lagoon's starlit water: it freezes you in seconds. */
  drainLagoon: number;
  /** How much faster the dark drains at the very end of the night (1 = no change). */
  lateFactor: number;
  /** Warmth gained per second in full light. */
  refill: number;
  /** Light units the wisp holds alone, and with the paper lantern. One flare costs flareCost. */
  wispCap: number;
  lanternCap: number;
  flareCost: number;
  /** Seconds between flares, so a full store can't be emptied in a blink. */
  flareCooldown: number;
  /** Light gained per second walking through the densest motes, and drawing from a fresh source. */
  moteRate: number;
  drawRate: number;
}

export const TUNING: Record<Exclude<SurvivalMode, 'wander'>, SurvivalTuning> = {
  survival: {
    drainDark: 1 / 420,
    drainWater: 1 / 60,
    drainWind: 1 / 240,
    drainDarkWater: 1 / 40,
    drainRain: 1 / 150,
    drainDive: 1 / 90,
    drainLagoon: 1 / 7,
    lateFactor: 2.2,
    refill: 1 / 12,
    wispCap: 1,
    lanternCap: 3,
    flareCost: 1,
    flareCooldown: 3,
    moteRate: 1 / 90,
    drawRate: 1 / 8,
  },
  // The story without the struggle: the cold is slow, flares are free.
  story: {
    drainDark: 1 / 1200,
    drainWater: 1 / 240,
    drainWind: 0,
    drainDarkWater: 1 / 160,
    drainRain: 1 / 400,
    drainDive: 1 / 300,
    drainLagoon: 1 / 14,
    lateFactor: 1.5,
    refill: 1 / 6,
    wispCap: 1,
    lanternCap: 3,
    flareCost: 0,
    flareCooldown: 20,
    moteRate: 1 / 90,
    drawRate: 1 / 8,
  },
};

/** What the Keeper is exposed to this frame, measured by the game. */
export interface Exposure {
  /** 0 in full dark, 1 standing in strong light (lamps, huts, lighthouses, your raised lantern). */
  lit: number;
  /** 0..1: glowing plants around her. They soften the cold but, unlike a real light, never warm her back up. */
  glow?: number;
  inWater: boolean;
  /** 0 sheltered, 1 out in the open wind (high ground, open dunes, at sea). */
  wind: number;
  /** night.progress, 0 at dusk to 1 at waking. */
  night: number;
  /** 0..1: how deep in the Dark Water (core/darkWater.ts). */
  dark?: number;
  /** 0..1: how hard a squall's rain is falling on her (shelter already taken off). */
  rain?: number;
  /** Swimming with her head under. */
  submerged?: boolean;
  /** In a lagoon's starlit water. */
  lagoon?: boolean;
}

/** How warm she is: 1 warm, 0 collapsed. Drains in the dark, water and wind; light warms her. */
export class Warmth {
  value = 1;

  /** Returns true on the frame warmth runs out. */
  update(dt: number, e: Exposure, t: SurvivalTuning) {
    const dark = 1 - Math.min(1, Math.max(0, e.lit + (e.glow ?? 0) * 0.6));
    const late = 1 + (t.lateFactor - 1) * e.night * e.night;
    const drain = (t.drainDark * dark * late + (e.inWater ? t.drainWater : 0) + t.drainWind * e.wind * dark + t.drainDarkWater * (e.dark ?? 0) + t.drainRain * (e.rain ?? 0) + (e.submerged ? t.drainDive : 0) + (e.lagoon ? t.drainLagoon : 0)) * dt;
    const gain = t.refill * Math.max(0, e.lit) * dt;
    const before = this.value;
    this.value = Math.min(1, Math.max(0, this.value - drain + gain));
    return before > 0 && this.value === 0;
  }

  reset() {
    this.value = 1;
  }
}

/** The light you carry: the wisp's to begin with, more once the paper lantern is found. */
export class LightStore {
  value: number;
  private cooldown = 0;

  constructor(public cap: number) {
    this.value = cap;
  }

  gain(amount: number) {
    this.value = Math.min(this.cap, this.value + amount);
  }

  /** Spend a flare's worth. False (and nothing spent) without enough light or while cooling down. */
  flare(t: SurvivalTuning) {
    if (this.cooldown > 0 || this.value < t.flareCost - 1e-9) return false;
    this.value -= t.flareCost;
    this.cooldown = t.flareCooldown;
    return true;
  }

  update(dt: number) {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  get ready() {
    return this.cooldown <= 0;
  }
}

/** Share of the night a rest restores, by how many times in a row you've rested at that tower. */
export const REST_RETURNS = [1, 0.6, 0.35, 0.2];

/** Repeated rests at one lighthouse buy less night each time; a different lighthouse restores it all. */
export class RestReturns {
  tower = -1;
  streak = 0;

  /** Rest at tower i: returns the share of the elapsed night given back (1 = a whole new night). */
  restAt(i: number) {
    this.streak = i === this.tower ? this.streak + 1 : 0;
    this.tower = i;
    return REST_RETURNS[Math.min(this.streak, REST_RETURNS.length - 1)];
  }

  /** Waking after the night runs out starts the count again. */
  clear() {
    this.tower = -1;
    this.streak = 0;
  }
}

/** Glowing places you draw light from dim, then regrow over regrowSeconds. Keyed by world cell. */
export class Sources {
  private drawn = new Map<string, number>();

  constructor(
    public cell = 24,
    public regrowSeconds = 180,
  ) {}

  private key(x: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /** How much light is left at (x, z) at time now (seconds): 1 fresh, 0 drawn dry. */
  left(x: number, z: number, now: number) {
    const at = this.drawn.get(this.key(x, z));
    if (at === undefined) return 1;
    return Math.min(1, Math.max(0, (now - at) / this.regrowSeconds));
  }

  /** Areas still regrowing: their centres and how much light is back (0..1), most drained first. */
  drained(now: number) {
    const out: { x: number; z: number; left: number }[] = [];
    for (const [key, at] of this.drawn) {
      const left = Math.min(1, Math.max(0, (now - at) / this.regrowSeconds));
      if (left >= 1) {
        this.drawn.delete(key);
        continue;
      }
      const [i, j] = key.split(',').map(Number);
      out.push({ x: (i + 0.5) * this.cell, z: (j + 0.5) * this.cell, left });
    }
    return out.sort((a, b) => a.left - b.left);
  }

  /** Draw for dt seconds at drawRate; returns the light taken. The source dims as it gives. */
  draw(x: number, z: number, now: number, dt: number, rate: number) {
    const left = this.left(x, z, now);
    if (left <= 0) return 0;
    const taken = Math.min(left, rate * dt);
    // Store the moment it would have been dry, so left() falls by exactly what was taken.
    this.drawn.set(this.key(x, z), now - (left - taken) * this.regrowSeconds);
    return taken;
  }
}
