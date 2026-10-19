// On-screen words. Kept sparse on purpose: the story is told by the world, these are the
// few lines the world can't say for itself.

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export type LineKind = 'memory' | 'whisper' | 'title' | 'observation' | 'hint';

interface Line {
  text: string;
  kind: LineKind;
  hold: number;
}

interface Channel {
  el: HTMLElement;
  queue: Line[];
  t: number;
  current: Line | null;
  phase: 'idle' | 'in' | 'hold' | 'out';
}

const FADE = { memory: 1.6, whisper: 1.4, title: 2.5, observation: 1.0, hint: 0.8 } as const;
const HOLD = { memory: 5.5, whisper: 2.6, title: 4, observation: 4.5, hint: 6 } as const;

export class Narrative {
  private center: Channel;
  private lower: Channel;
  private noteEl: HTMLElement;
  private noteOpen = false;
  private noteT = 0;

  constructor() {
    const mk = (id: string) => {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
      return el;
    };
    this.center = { el: mk('line-center'), queue: [], t: 0, current: null, phase: 'idle' };
    this.lower = { el: mk('line-lower'), queue: [], t: 0, current: null, phase: 'idle' };
    this.noteEl = mk('note');
  }

  say(text: string, kind: LineKind = 'observation', hold?: number) {
    const ch = kind === 'observation' || kind === 'hint' ? this.lower : this.center;
    ch.queue.push({ text, kind, hold: hold ?? HOLD[kind] });
  }

  get busy() {
    return this.center.phase !== 'idle' || this.center.queue.length > 0;
  }

  private book: { el: HTMLElement; lines: string[]; shown: number; t: number; done: () => void; closing: number } | null = null;

  /**
   * The bedtime story, told as a page: each line fades in and stays, then the page goes.
   * Calls `done` when it has faded out (or been skipped).
   */
  storybook(lines: string[], done: () => void) {
    const el = document.createElement('div');
    el.id = 'storybook';
    document.body.appendChild(el);
    this.book = { el, lines, shown: 0, t: 0.6, done, closing: -1 };
  }

  skipStorybook() {
    if (this.book && this.book.closing < 0) this.book.closing = 0;
  }

  get inStorybook() {
    return this.book !== null;
  }

  private stepBook(dt: number) {
    const b = this.book;
    if (!b) return;
    b.t += dt;
    if (b.closing < 0) {
      if (b.shown < b.lines.length && b.t > 2.7) {
        const p = document.createElement('p');
        p.textContent = b.lines[b.shown];
        // The last line is the rule; set it apart.
        if (b.shown === b.lines.length - 1) p.className = 'rule';
        b.el.appendChild(p);
        void p.offsetWidth;
        p.style.opacity = '1';
        b.shown++;
        b.t = 0;
      } else if (b.shown === b.lines.length && b.t > 3.6) {
        b.closing = 0;
      }
      return;
    }
    if (b.closing === 0) b.el.style.opacity = '0';
    b.closing += dt;
    if (b.closing > 1.8) {
      b.el.remove();
      this.book = null;
      b.done();
    }
  }

  /** Quiet objective in the corner of the screen. */
  objective(title: string, done: number, total: number, extra = '', carried = 0) {
    let el = document.getElementById('objective');
    if (!el) {
      el = document.createElement('div');
      el.id = 'objective';
      document.body.appendChild(el);
    }
    const dots = Array.from({ length: total }, (_, i) => `<i class="${i < done ? 'lit' : i < done + carried ? 'carried' : ''}"></i>`).join('');
    el.innerHTML = `<div class="obj-title">${escapeHtml(title)}</div><div class="obj-line">fallen stars gathered <span class="dots">${dots}</span></div>${extra ? `<div class="obj-line">${escapeHtml(extra)}</div>` : ''}`;
    el.style.opacity = '1';
  }

  note(text: string) {
    this.noteEl.innerHTML = `<p>${text}</p>`;
    this.noteEl.classList.add('open');
    this.noteOpen = true;
    this.noteT = 0;
  }

  /** Returns true if a press was used to dismiss something. */
  dismiss(): boolean {
    if (this.noteOpen && this.noteT > 0.6) {
      this.noteEl.classList.remove('open');
      this.noteOpen = false;
      return true;
    }
    return false;
  }

  get reading() {
    return this.noteOpen;
  }

  update(dt: number) {
    if (this.noteOpen) {
      this.noteT += dt;
      if (this.noteT > 9) this.dismiss();
    }
    this.stepBook(dt);
    for (const ch of [this.center, this.lower]) this.step(ch, dt);
  }

  private step(ch: Channel, dt: number) {
    if (ch.phase === 'idle') {
      const next = ch.queue.shift();
      if (!next) return;
      ch.current = next;
      ch.el.className = `line ${next.kind}`;
      // Memories are her voice; say so, quietly, so they never read as the player's thoughts.
      if (next.kind === 'memory') ch.el.innerHTML = `<span class="caption">her voice</span>${escapeHtml(next.text)}`;
      else ch.el.textContent = next.text;
      ch.el.style.transitionDuration = `${FADE[next.kind]}s`;
      // Force a style flush so the fade-in transition runs from zero.
      void ch.el.offsetWidth;
      ch.el.style.opacity = '1';
      ch.phase = 'in';
      ch.t = 0;
      return;
    }
    const line = ch.current!;
    ch.t += dt;
    if (ch.phase === 'in' && ch.t > FADE[line.kind]) {
      ch.phase = 'hold';
      ch.t = 0;
    } else if (ch.phase === 'hold' && ch.t > line.hold) {
      ch.el.style.opacity = '0';
      ch.phase = 'out';
      ch.t = 0;
    } else if (ch.phase === 'out' && ch.t > FADE[line.kind]) {
      ch.phase = 'idle';
      ch.current = null;
    }
  }
}
