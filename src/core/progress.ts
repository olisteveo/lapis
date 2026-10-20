// What the player has done, engine-free: banked stars, places found, lamps lit, keepsakes, and
// how much of her sky is lit. Storage is behind a tiny interface so any engine can supply it.
import { CONSTELLATIONS, TOTAL_STARS } from './content';
import type { KeepsakeId } from './keepsakes';

export const SAVE_KEY = 'lapis.save.v1';

export interface Save {
  /** Banked stars: carried to a lighthouse, lit in the sky for good. */
  collected: string[];
  /** Things found or already said (lagoons, wonders, puzzles, one-off hints). */
  seen: string[];
  /** Beacons whose lamps you've lit. */
  lit?: number[];
  lastBeacon?: number;
  keepsakes?: KeepsakeId[];
  /** The night in progress, so a reload can't reset the cold (docs/SURVIVAL.md). */
  night?: { progress: number; warmth: number; light: number; restTower: number; restStreak: number };
}

export interface SaveStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Fragment id -> which constellation, which of its stars. */
export const STAR_REFS: ReadonlyMap<string, { c: number; i: number }> = new Map(
  CONSTELLATIONS.flatMap((c, ci) => c.fragments.map((f, i) => [f.id, { c: ci, i }] as const)),
);

export class Progress {
  readonly save: Save;

  constructor(private store: SaveStore | null, reset = false) {
    this.save = this.load(reset);
  }

  private load(reset: boolean): Save {
    try {
      if (reset) this.store?.remove(SAVE_KEY);
      const raw = this.store?.get(SAVE_KEY);
      if (raw) {
        const save = JSON.parse(raw) as Save;
        // Older saves called the seashell by its old name.
        if (save.keepsakes) save.keepsakes = save.keepsakes.map((k) => ((k as string) === 'conch' ? 'shell' : k));
        return save;
      }
    } catch {
      // Private windows and blocked storage: just play without persistence.
    }
    return { collected: [], seen: [] };
  }

  persist() {
    try {
      this.store?.set(SAVE_KEY, JSON.stringify(this.save));
    } catch {
      // Ignore: progress just won't survive a reload.
    }
  }

  hasSeen(key: string) {
    return this.save.seen.includes(key);
  }

  /** Marks something as seen. Returns true if it already was (so one-off lines play once). */
  seen(key: string) {
    if (this.hasSeen(key)) return true;
    this.save.seen.push(key);
    this.persist();
    return false;
  }

  hasKeepsake(id: KeepsakeId) {
    return (this.save.keepsakes ?? []).includes(id);
  }

  addKeepsake(id: KeepsakeId) {
    if (this.hasKeepsake(id)) return;
    this.save.keepsakes = [...(this.save.keepsakes ?? []), id];
    this.persist();
  }

  isBanked(id: string) {
    return this.save.collected.includes(id);
  }

  bank(id: string) {
    if (!this.isBanked(id)) this.save.collected.push(id);
    this.persist();
  }

  isBeaconLit(i: number) {
    return (this.save.lit ?? []).includes(i);
  }

  /** Light a beacon (first time) and make it the place you wake. Returns true if newly lit. */
  restAt(i: number) {
    const first = !this.isBeaconLit(i);
    if (first) this.save.lit = [...(this.save.lit ?? []), i];
    this.save.lastBeacon = i;
    this.persist();
    return first;
  }

  /** How many of constellation c's stars are banked. */
  litCount(c: number) {
    return CONSTELLATIONS[c].fragments.filter((f) => this.isBanked(f.id)).length;
  }

  isComplete(c: number) {
    return this.litCount(c) === CONSTELLATIONS[c].fragments.length;
  }

  get allLit() {
    return CONSTELLATIONS.every((_, c) => this.isComplete(c));
  }

  get starsLit() {
    return this.save.collected.length;
  }

  get totalStars() {
    return TOTAL_STARS;
  }
}
