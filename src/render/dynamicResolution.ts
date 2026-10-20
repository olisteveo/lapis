/**
 * Keeps the frame rate steady by trading resolution for time. When the GPU falls behind the frame
 * budget, the render scale drops; after a long calm it creeps back up, but never straight back to a
 * scale that just failed, since every change reallocates the render targets and would itself hitch.
 * The painted look hides a lower resolution far better than it hides a stutter.
 */
export class DynamicResolution {
  scale = 1;
  private samples: number[] = [];
  private calm = 0;
  private ceiling = 1;
  private ceilingUntil = 0;

  constructor(
    public min = 0.55,
    private window = 40,
  ) {}

  /** frameMs: the interval between rendered frames; budgetMs: the target interval. True when the scale changed. */
  update(frameMs: number, budgetMs: number, now: number) {
    this.samples.push(frameMs);
    if (this.samples.length < this.window) return false;
    const sorted = this.samples.sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    this.samples = [];
    if (now > this.ceilingUntil) this.ceiling = 1;
    if (p80 > budgetMs * 1.15 && this.scale > this.min) {
      // Behind: drop in proportion to how far behind, and don't come back above this for a while.
      this.ceiling = this.scale - 0.05;
      this.ceilingUntil = now + 20000;
      this.scale = Math.max(this.min, snap(this.scale * Math.sqrt(budgetMs / p80) * 0.95));
      this.calm = 0;
      return true;
    }
    if (p80 < budgetMs * 1.05) {
      // On budget for about four seconds: try a little more detail.
      if (++this.calm >= 6 && this.scale < Math.min(1, this.ceiling)) {
        this.scale = Math.min(1, this.ceiling, snap(this.scale + 0.05));
        this.calm = 0;
        return true;
      }
    } else this.calm = 0;
    return false;
  }

  reset() {
    this.scale = 1;
    this.samples = [];
    this.calm = 0;
    this.ceiling = 1;
  }
}

const snap = (v: number) => Math.round(v * 20) / 20;
