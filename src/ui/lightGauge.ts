/**
 * The light you carry, above the keepsakes: one pip per flare's worth, each filling as light is
 * gathered. A full pip glows; the row brightens while light streams in. Warmth has no gauge: the
 * frost on the picture is its gauge (docs/SURVIVAL.md).
 */
export class LightGauge {
  private root: HTMLElement;
  private pips: HTMLElement[] = [];
  private cap = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'light-gauge';
    document.body.appendChild(this.root);
  }

  set visible(v: boolean) {
    this.root.classList.toggle('show', v);
  }

  update(value: number, cap: number, gathering: boolean, ready: boolean) {
    if (cap !== this.cap) {
      this.cap = cap;
      this.root.innerHTML = '<span class="key">Q</span>' + '<i></i>'.repeat(Math.round(cap));
      this.pips = [...this.root.querySelectorAll('i')] as HTMLElement[];
    }
    this.pips.forEach((p, i) => {
      const fill = Math.min(1, Math.max(0, value - i));
      p.style.setProperty('--fill', fill.toFixed(3));
      p.classList.toggle('full', fill >= 0.999);
    });
    this.root.classList.toggle('gathering', gathering);
    this.root.classList.toggle('ready', ready && value >= 1 - 1e-6);
  }

  /** A flare just left the store. */
  spent() {
    this.root.classList.remove('spent');
    void this.root.offsetWidth;
    this.root.classList.add('spent');
  }
}
