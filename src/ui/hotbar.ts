import { KEEPSAKES, type KeepsakeId } from '../story/keepsakes';
import { GLYPH } from './satchel';

/**
 * The keepsakes you carry, along the bottom of the view: one slot each, numbered for the key that
 * raises it. Empty slots stay as faint outlines so you know how many are still out there.
 */
export class Hotbar {
  private root: HTMLElement;
  private key = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'hotbar';
    document.body.appendChild(this.root);
  }

  set visible(v: boolean) {
    this.root.classList.toggle('show', v);
  }

  /** fresh: a keepsake just added, which flares in its slot for a moment. */
  update(owned: KeepsakeId[], held: KeepsakeId | null, fresh: KeepsakeId | null = null) {
    const key = `${owned.join(',')}|${held}|${fresh}`;
    if (key === this.key) return;
    this.key = key;
    this.root.innerHTML = KEEPSAKES.map((k, i) => {
      const has = owned.includes(k.id);
      const cls = ['slot', has ? 'has' : '', held === k.id ? 'held' : '', fresh === k.id ? 'fresh' : ''].join(' ');
      return `<div class="${cls}" title="${has ? k.name : ''}"><svg viewBox="0 0 40 40">${has ? GLYPH[k.id] : ''}</svg><span>${i + 1}</span></div>`;
    }).join('');
  }
}
