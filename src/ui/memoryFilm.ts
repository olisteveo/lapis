/**
 * Memory films: the real past, father and daughter on their island and at sea, shown full screen
 * when the star holding that memory is gathered. Films live in /memories/<fragment-id>.mp4 and are
 * listed in /memories/index.json (written by tools/memories/edit_memory.py); fragments without one
 * keep the plain memory line.
 */
export class MemoryFilm {
  private root: HTMLElement;
  private video: HTMLVideoElement;
  private available = new Set<string>();
  private done: (() => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'memory-film';
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.root.appendChild(this.video);
    document.body.appendChild(this.root);
    this.video.addEventListener('ended', () => this.close());
    this.root.addEventListener('click', () => this.close());
    fetch('/memories/index.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((ids: string[]) => ids.forEach((id) => this.available.add(id)))
      .catch(() => {});
  }

  get open() {
    return this.root.classList.contains('open');
  }

  has(id: string) {
    return this.available.has(id);
  }

  /** volume: 0..1, the player's effects volume. onDone runs when it ends or is skipped. */
  play(id: string, volume: number, onDone?: () => void) {
    if (!this.available.has(id)) return false;
    this.done = onDone ?? null;
    this.video.src = `/memories/${id}.mp4`;
    this.video.volume = Math.max(0, Math.min(1, volume));
    this.video.currentTime = 0;
    this.video.muted = false;
    this.root.classList.add('open');
    // Browsers refuse sound before the page has had a click or key press; show it silent then.
    this.video.play().catch(() => {
      this.video.muted = true;
      this.video.play().catch(() => this.close());
    });
    return true;
  }

  close() {
    if (!this.open) return;
    this.root.classList.remove('open');
    this.video.pause();
    const done = this.done;
    this.done = null;
    done?.();
  }
}
