// Composed score (public/audio/music). Picks a track for where you are, crossfades between
// areas, and leaves stretches of silence between plays so the island's own sound breathes.

export type MusicArea = 'opening' | 'shore' | 'jungle' | 'sea' | 'deep';

const TRACKS: Record<MusicArea | 'memory' | 'ending', string> = {
  opening: 'storybook.mp3',
  shore: 'coral_shore.mp3',
  jungle: 'jungle.mp3',
  sea: 'beyond_the_sea.mp3',
  deep: 'dark_water.mp3',
  memory: 'memory.mp3',
  ending: 'let_go.mp3',
};

const AREA_VOLUME: Record<MusicArea, number> = { opening: 0.85, shore: 0.6, jungle: 0.55, sea: 0.65, deep: 0.55 };

interface Playing {
  area: MusicArea;
  src: AudioBufferSourceNode;
  gain: GainNode;
}

export class MusicDirector {
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private current: Playing | null = null;
  private wanted: MusicArea = 'opening';
  private candidate: MusicArea = 'opening';
  private candidateFor = 0;
  /** Seconds of silence left before the current area's track plays again. */
  private rest = 0;
  private duck: GainNode | null = null;
  /** True whenever composed music is sounding (the generated pad steps aside). */
  active = false;

  constructor(private ctx: () => AudioContext | null, private out: () => AudioNode | null) {}

  private load(file: string) {
    let p = this.buffers.get(file);
    if (!p) {
      const ctx = this.ctx()!;
      p = fetch(`/audio/music/${file}`)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b));
      this.buffers.set(file, p);
    }
    return p;
  }

  /** Warm the decode cache so area changes don't wait on a download. */
  preload() {
    for (const f of Object.values(TRACKS)) this.load(f).catch(() => {});
  }

  private bus() {
    const ctx = this.ctx();
    const out = this.out();
    if (!ctx || !out) return null;
    if (!this.duck) {
      this.duck = ctx.createGain();
      this.dreadGain = ctx.createGain();
      this.duck.connect(this.dreadGain).connect(out);
    }
    return this.duck;
  }

  private dreadGain: GainNode | null = null;

  /** 0..1: the score sinks away while nightmares are close. */
  setDread(d: number) {
    const ctx = this.ctx();
    if (!ctx || !this.dreadGain) return;
    this.dreadGain.gain.setTargetAtTime(1 - d * 0.85, ctx.currentTime, d > 0.05 ? 0.6 : 2);
  }

  private async start(area: MusicArea, fadeIn: number) {
    const ctx = this.ctx();
    const bus = this.bus();
    if (!ctx || !bus) return;
    const buf = await this.load(TRACKS[area]);
    // The area may have changed while decoding.
    if (this.wanted !== area || (this.current && this.current.area === area)) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(AREA_VOLUME[area], ctx.currentTime, fadeIn / 3);
    src.connect(gain).connect(bus);
    src.start();
    const playing = { area, src, gain };
    this.current = playing;
    this.active = true;
    src.onended = () => {
      if (this.current !== playing) return;
      this.current = null;
      this.active = false;
      this.rest = 30 + Math.random() * 40;
    };
  }

  private stop(fadeOut: number) {
    const ctx = this.ctx();
    const c = this.current;
    if (!ctx || !c) return;
    c.gain.gain.cancelScheduledValues(ctx.currentTime);
    c.gain.gain.setTargetAtTime(0, ctx.currentTime, fadeOut / 3);
    c.src.stop(ctx.currentTime + fadeOut * 1.6);
    this.current = null;
    this.active = false;
  }

  /** Begin the opening track right away (call from the click that starts the game). */
  beginOpening() {
    this.wanted = 'opening';
    this.candidate = 'opening';
    this.start('opening', 4).catch(() => {});
  }

  /** A short glassy sting over the music while a memory plays; the score ducks under it. */
  async memory() {
    const ctx = this.ctx();
    const out = this.out();
    const bus = this.bus();
    if (!ctx || !out || !bus) return;
    const buf = await this.load(TRACKS.memory);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    // Only the opening phrase: in, hold, and away again.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.75, t + 1.2);
    g.gain.setValueAtTime(0.75, t + 11);
    g.gain.linearRampToValueAtTime(0, t + 15);
    src.connect(g).connect(out);
    src.start(t);
    src.stop(t + 15.5);
    bus.gain.cancelScheduledValues(t);
    bus.gain.setTargetAtTime(0.3, t, 0.6);
    bus.gain.setTargetAtTime(1, t + 13, 1.5);
  }

  /**
   * Called every frame with where the player is. Areas must hold steady for a few seconds
   * before the score changes, so walking along a jungle edge doesn't flip tracks.
   */
  update(dt: number, area: MusicArea) {
    if (!this.ctx()) return;
    if (area !== this.candidate) {
      this.candidate = area;
      this.candidateFor = 0;
    }
    this.candidateFor += dt;
    const settled = this.candidateFor > (area === 'deep' ? 8 : 5);
    if (settled && area !== this.wanted) {
      this.wanted = area;
      if (this.current && this.current.area !== area) this.stop(5);
      this.rest = 2;
    }
    if (!this.current) {
      this.rest -= dt;
      if (this.rest <= 0) {
        this.rest = 1e9; // until this play ends or the area changes
        this.start(this.wanted, 5).catch(() => (this.rest = 10));
      }
    }
  }
}
