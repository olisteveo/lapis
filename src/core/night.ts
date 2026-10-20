// The night: how long Mara can stay asleep before she surfaces. Engine-agnostic.

export type NightCue = 'late' | 'cold' | 'eyes' | 'wake';

/** Fraction of the night at which each cue fires. */
const CUES: [number, NightCue][] = [
  [0.6, 'late'],
  [0.78, 'cold'],
  [0.92, 'eyes'],
  [1, 'wake'],
];

export class NightClock {
  /** 0 at dusk, 1 when she wakes. */
  progress = 0;
  private fired = new Set<NightCue>();
  onCue: ((cue: NightCue) => void) | null = null;

  constructor(public length: number) {}

  /** A fresh night: resting at a lighthouse, or after waking. */
  reset() {
    this.progress = 0;
    this.fired.clear();
  }

  /** Pick up a saved night: cues already passed count as heard, so none replay. */
  resume(progress: number) {
    this.progress = Math.min(1, Math.max(0, progress));
    this.fired.clear();
    for (const [at, cue] of CUES) if (at <= this.progress) this.fired.add(cue);
  }

  /** Give back a share of the elapsed night (1 = a fresh night); cues not yet reached fire again. */
  rewind(share: number) {
    this.progress *= 1 - Math.min(1, Math.max(0, share));
    for (const [at, cue] of CUES) if (at > this.progress) this.fired.delete(cue);
  }

  update(dt: number) {
    this.progress = Math.min(1, this.progress + dt / this.length);
    for (const [at, cue] of CUES) {
      if (this.progress >= at && !this.fired.has(cue)) {
        this.fired.add(cue);
        this.onCue?.(cue);
      }
    }
  }

  /** A gentle word for the HUD, so the night can be read without a bar. */
  get phrase() {
    if (this.progress < 0.35) return 'the night is young';
    if (this.progress < 0.6) return 'the night wears on';
    if (this.progress < 0.8) return 'the night grows late';
    return 'dawn is close';
  }
}
