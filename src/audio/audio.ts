// Plays the pre-rendered sound set from tools/audio/build_sounds.py.

type Surface = 'sand' | 'wet' | 'water' | 'jungle';

const LOOPS = ['surf', 'lapping', 'wind', 'jungle', 'music'] as const;
type LoopName = (typeof LOOPS)[number];

export interface AudioMix {
  /** 0..1 how much open water is around you. */
  sea: number;
  /** 0..1 jungle density underfoot. */
  jungle: number;
  /** Metres above sea level. */
  altitude: number;
  inBoat: boolean;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private loops = new Map<LoopName, GainNode>();
  private musicDuck = 1;

  /** Must be called from a user gesture (browsers block audio until then). */
  async start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime + 0.5, 2.5);

    const names = [
      ...LOOPS.map((l) => `loop_${l}`),
      ...['sand', 'wet', 'water', 'jungle'].flatMap((s) => [0, 1, 2, 3, 4, 5].map((i) => `step_${s}_${i}`)),
      'oar_dip_0', 'oar_dip_1', 'oar_dip_2', 'oar_drip_0', 'oar_drip_1',
      ...[0, 1, 2, 3, 4, 5].map((i) => `chime_${i}`),
      'memory_swell', 'star_fall',
    ];
    await Promise.all(
      names.map(async (n) => {
        const res = await fetch(`/audio/${n}.wav`);
        this.buffers.set(n, await ctx.decodeAudioData(await res.arrayBuffer()));
      }),
    );
    for (const l of LOOPS) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.get(`loop_${l}`)!;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.master);
      // Offset start points so loops of similar length don't phase together audibly.
      src.start(0, Math.random() * src.buffer.duration);
      this.loops.set(l, g);
    }
  }

  private one(name: string, gain = 1, rate = 1) {
    const ctx = this.ctx;
    const buf = this.buffers.get(name);
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start();
  }

  step(surface: Surface, speed: number) {
    const i = Math.floor(Math.random() * 6);
    const loud = Math.min(1, 0.35 + speed / 7);
    this.one(`step_${surface}_${i}`, loud * (surface === 'water' ? 0.8 : 0.6), 0.94 + Math.random() * 0.12);
  }

  oarDip() {
    this.one(`oar_dip_${Math.floor(Math.random() * 3)}`, 0.55, 0.95 + Math.random() * 0.1);
  }

  oarDrip() {
    this.one(`oar_drip_${Math.floor(Math.random() * 2)}`, 0.3);
  }

  chime(index: number) {
    this.one(`chime_${index % 6}`, 0.7);
  }

  memory() {
    this.one('memory_swell', 0.55);
    this.duck(10);
  }

  starFall() {
    this.one('star_fall', 0.35);
  }

  private duck(seconds: number) {
    this.musicDuck = 0.35;
    setTimeout(() => (this.musicDuck = 1), seconds * 1000);
  }

  update(mix: AudioMix) {
    const ctx = this.ctx;
    if (!ctx || !this.loops.size) return;
    const now = ctx.currentTime;
    const set = (l: LoopName, v: number) => this.loops.get(l)!.gain.setTargetAtTime(v, now, 0.6);
    const shore = mix.inBoat ? 0.4 : mix.sea;
    set('surf', shore * 0.85 * Math.max(0, 1 - mix.altitude / 120));
    set('lapping', mix.inBoat ? 0.55 : mix.sea * 0.25);
    set('wind', 0.12 + Math.min(0.6, mix.altitude / 400) + (mix.inBoat ? 0.15 : 0));
    set('jungle', mix.jungle * 0.6 * (1 - mix.sea * 0.4));
    set('music', 0.32 * this.musicDuck);
  }
}
