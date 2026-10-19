import { KEEPSAKES, type KeepsakeId } from '../story/keepsakes';

export interface SatchelState {
  carried: { constellation: string }[];
  keepsakes: KeepsakeId[];
  skies: { name: string; lit: number; total: number; region: string }[];
  lit: number;
  total: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Small inked glyphs for each keepsake, drawn rather than iconified. */
const GLYPH: Record<KeepsakeId, string> = {
  shell: '<path d="M8 30 C4 18 14 6 26 8 C34 10 36 20 30 26 C24 32 14 34 8 30 Z M14 26 C18 20 24 18 28 20" />',
  wings: '<path d="M20 22 C12 8 4 10 6 20 C8 28 16 26 20 22 C24 26 32 28 34 20 C36 10 28 8 20 22 Z M20 22 L20 32" />',
  lantern: '<path d="M14 10 H26 M15 10 C10 16 10 26 15 32 H25 C30 26 30 16 25 10 M20 4 V10 M16 32 H24 V35 H16 Z" />',
  compass: '<circle cx="20" cy="20" r="13" /><path d="M20 9 L23 20 L20 31 L17 20 Z M20 20 L20 20" />',
  ribbon: '<path d="M20 16 C12 6 6 12 10 18 C14 22 18 18 20 16 C22 18 26 22 30 18 C34 12 28 6 20 16 Z M18 18 L12 34 M22 18 L28 34" />',
};

/** The satchel: what you carry, the keepsakes you have found, and how much of her sky is lit. */
export class Satchel {
  private root: HTMLElement;
  open = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'satchel';
    document.body.appendChild(this.root);
  }

  show(s: SatchelState) {
    this.open = true;
    this.render(s);
    this.root.classList.add('open');
  }

  hide() {
    this.open = false;
    this.root.classList.remove('open');
  }

  private render(s: SatchelState) {
    const carried = s.carried.length
      ? `<p class="carry">${s.carried.length} fallen star${s.carried.length > 1 ? 's' : ''} carried, for ${[...new Set(s.carried.map((c) => esc(c.constellation)))].join(' and ')}.<br><span>Lift them from a lamp room before the night ends, or they fall back.</span></p>`
      : `<p class="carry quiet">No stars carried.</p>`;
    const items = KEEPSAKES.map((k) => {
      const has = s.keepsakes.includes(k.id);
      return `<div class="ks ${has ? 'has' : ''}">
        <svg viewBox="0 0 40 40" class="glyph">${has ? GLYPH[k.id] : '<text x="20" y="27" text-anchor="middle">?</text>'}</svg>
        <div><div class="name">${has ? esc(k.name) : 'Something of hers'}</div>
        <div class="what">${has ? esc(k.effect) : `Lost ${esc(k.hint)}.`}</div></div></div>`;
    }).join('');
    const skies = s.skies
      .map((c) => `<div class="sky ${c.lit === c.total ? 'done' : ''}"><span class="cname">${esc(c.name)}</span><span class="dots">${'<i class="on"></i>'.repeat(c.lit)}${'<i></i>'.repeat(c.total - c.lit)}</span><span class="where">${esc(c.region)}</span></div>`)
      .join('');
    this.root.innerHTML = `<div class="page">
      <div class="col">
        <div class="head">The satchel</div>
        ${carried}
        <div class="label">Keepsakes</div>
        <div class="items">${items}</div>
      </div>
      <div class="col">
        <div class="head">Her sky</div>
        <p class="goal">She is lost at sea, and her stars are falling. Carry them back to a lighthouse and lift them from the lamp room. Light every constellation, and she can find her way home.</p>
        ${skies}
        <p class="total">${s.lit} of ${s.total} stars are back in her sky.</p>
      </div>
      <div class="foot">I to close</div>
    </div>`;
  }
}
