import { settings, updateSettings } from '../settings';
import type { QualityName } from '../config';

type View = 'main' | 'settings' | 'controls' | 'confirm';

const CONTROLS: [string, string][] = [
  ['W A S D', 'walk'],
  ['Mouse', 'look'],
  ['Shift', 'run'],
  ['Space', 'jump  ·  long stroke in the boat, as the oars dip'],
  ['E', 'gather, read, light a lamp, step into or out of the boat'],
  ['F', 'ask the little light what to do next'],
  ['M', 'the chart: everywhere you have been'],
  ['Hold E', 'at the water’s edge: call the boat'],
  ['Esc', 'pause'],
];

/** Pause menu: resume, settings (graphics, sound, mouse), controls, start over. */
export class PauseMenu {
  private root: HTMLElement;
  private view: View = 'main';
  open = false;
  onResume: (() => void) | null = null;
  onStartOver: (() => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'menu';
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!t) return;
      e.stopPropagation();
      this.act(t.dataset.act!, t.dataset.value);
    });
    this.root.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.setting === 'invertY') updateSettings({ invertY: t.checked });
      else if (t.dataset.setting === 'nights') updateSettings({ nights: t.checked });
      else if (t.dataset.setting) updateSettings({ [t.dataset.setting]: Number(t.value) } as never);
      if (t.dataset.setting === 'nights') this.render();
    });
    this.render();
  }

  show() {
    this.open = true;
    this.view = 'main';
    this.render();
    this.root.classList.add('open');
  }

  hide() {
    this.open = false;
    this.root.classList.remove('open');
  }

  /** Escape inside the menu: back out of a sub-view, or resume from the main one. */
  back() {
    if (this.view !== 'main') {
      this.view = 'main';
      this.render();
    } else this.onResume?.();
  }

  private act(act: string, value?: string) {
    if (act === 'resume') this.onResume?.();
    else if (act === 'view') {
      this.view = value as View;
      this.render();
    } else if (act === 'quality') {
      updateSettings({ quality: value as QualityName });
      this.render();
    } else if (act === 'startOver') this.onStartOver?.();
  }

  private render() {
    const q = settings.quality;
    const seg = (name: QualityName, label: string) =>
      `<button class="seg ${q === name ? 'on' : ''}" data-act="quality" data-value="${name}">${label}</button>`;
    const slider = (key: 'master' | 'music' | 'sfx' | 'sensitivity', label: string, min: number, max: number, stepV: number) =>
      `<label class="row"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${stepV}" value="${settings[key]}" data-setting="${key}"></label>`;
    let body = '';
    if (this.view === 'main') {
      body = `
        <button class="item" data-act="resume">Resume</button>
        <button class="item" data-act="view" data-value="settings">Settings</button>
        <button class="item" data-act="view" data-value="controls">Controls</button>
        <button class="item quiet" data-act="view" data-value="confirm">Start over</button>`;
    } else if (this.view === 'settings') {
      body = `
        <div class="group"><div class="label">Graphics</div>
          <div class="segs">${seg('low', 'Low')}${seg('medium', 'Medium')}${seg('high', 'High')}</div>
          <div class="note">${q === 'low' ? 'Cooler and quieter: 30fps, lighter effects.' : q === 'high' ? 'Full detail. Runs hot on laptops.' : 'Balanced: 60fps.'}</div>
        </div>
        <div class="group"><div class="label">Play</div>
          <label class="row"><span>Night cycle</span><input type="checkbox" data-setting="nights" ${settings.nights ? 'checked' : ''}></label>
          <div class="note">${settings.nights ? 'Carry fallen stars to a lighthouse before she wakes.' : 'Free wandering: no nights, stars are kept as soon as you gather them.'}</div>
        </div>
        <div class="group"><div class="label">Sound</div>
          ${slider('master', 'Master', 0, 1, 0.01)}
          ${slider('music', 'Music', 0, 1, 0.01)}
          ${slider('sfx', 'Effects', 0, 1, 0.01)}
        </div>
        <div class="group"><div class="label">Mouse</div>
          ${slider('sensitivity', 'Sensitivity', 0.3, 2.5, 0.05)}
          <label class="row"><span>Invert Y</span><input type="checkbox" data-setting="invertY" ${settings.invertY ? 'checked' : ''}></label>
        </div>
        <button class="item back" data-act="view" data-value="main">Back</button>`;
    } else if (this.view === 'controls') {
      body = `<div class="controls">${CONTROLS.map(([k, v]) => `<div class="key">${k}</div><div class="what">${v}</div>`).join('')}</div>
        <button class="item back" data-act="view" data-value="main">Back</button>`;
    } else {
      body = `<p class="confirm">Start over from the very beginning?<br><span>Every star you have gathered and everything you have found will be forgotten.</span></p>
        <button class="item danger" data-act="startOver">Start over</button>
        <button class="item back" data-act="view" data-value="main">Keep playing</button>`;
    }
    this.root.innerHTML = `<div class="panel"><div class="title">LAPIS</div><div class="sub">${this.view === 'main' ? 'paused' : this.view === 'confirm' ? '' : this.view}</div>${body}</div>`;
  }
}
