import { MusicDirector } from './music';

// Plays the pre-rendered sound set from tools/audio/build_sounds.py.

type Surface = 'sand' | 'wet' | 'water' | 'jungle';

const LOOPS = ['surf', 'lapping', 'wind', 'jungle', 'music', 'dread'] as const;
type LoopName = (typeof LOOPS)[number];

export interface AudioMix {
  /** 0..1 how much open water is around you. */
  sea: number;
  /** 0..1 jungle density underfoot. */
  jungle: number;
  /** Metres above sea level. */
  altitude: number;
  inBoat: boolean;
  /** 0..1 how close the nearest nightmare is. */
  dread?: number;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private volumes = { master: 0.9, music: 0.8, sfx: 0.9 };
  private pausedDuck = 1;
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
    this.master.gain.setTargetAtTime(this.volumes.master, ctx.currentTime + 0.5, 2.5);
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.gain.value = this.volumes.music;
    this.sfxBus.gain.value = this.volumes.sfx;
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);

    const names = [
      ...LOOPS.map((l) => `loop_${l}`),
      ...['sand', 'wet', 'water', 'jungle'].flatMap((s) => [0, 1, 2, 3, 4, 5].map((i) => `step_${s}_${i}`)),
      'oar_dip_0', 'oar_dip_1', 'oar_dip_2', 'oar_drip_0', 'oar_drip_1',
      ...[0, 1, 2, 3, 4, 5].map((i) => `chime_${i}`),
      'fairy_hey', 'fairy_listen', 'fairy_look', 'fairy_oh', 'fairy_hmm', 'fairy_watch',
      'memory_swell', 'star_fall', 'splash_small_0', 'splash_small_1', 'splash_small_2', 'splash_big', 'whale_song',
    ];
    await Promise.all(
      names.map(async (n) => {
        // A composed nightmare track (no vocals) replaces the synthesised dread when present.
        if (n === 'loop_dread') {
          const composed = await fetch('/audio/music/nightmare.mp3').catch(() => null);
          if (composed?.ok && composed.headers.get('content-type')?.includes('audio')) {
            this.buffers.set(n, await ctx.decodeAudioData(await composed.arrayBuffer()));
            return;
          }
        }
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
      src.connect(g).connect(l === 'music' || l === 'dread' ? this.musicBus : this.sfxBus);
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
    src.connect(g).connect(this.sfxBus);
    src.start();
  }

  step(surface: Surface, speed: number) {
    const i = Math.floor(Math.random() * 6);
    const loud = Math.min(1, 0.35 + speed / 7);
    this.one(`step_${surface}_${i}`, loud * (surface === 'water' ? 0.45 : 0.32), 0.95 + Math.random() * 0.1);
  }

  oarDip() {
    this.one(`oar_dip_${Math.floor(Math.random() * 3)}`, 0.55, 0.95 + Math.random() * 0.1);
  }

  oarDrip() {
    this.one(`oar_drip_${Math.floor(Math.random() * 2)}`, 0.3);
  }

  jump() {
    this.one(`step_sand_${Math.floor(Math.random() * 6)}`, 0.22, 1.15);
  }

  land(onWater: boolean) {
    this.one(onWater ? `splash_small_${Math.floor(Math.random() * 3)}` : `step_wet_${Math.floor(Math.random() * 6)}`, onWater ? 0.4 : 0.38, 0.85);
  }

  powerStroke() {
    this.one(`oar_dip_${Math.floor(Math.random() * 3)}`, 0.7, 0.85);
    this.one(`chime_${Math.floor(Math.random() * 3)}`, 0.18, 1.5);
  }

  chime(index: number) {
    this.one(`chime_${index % 6}`, 0.7);
  }

  /** A lantern's note: eight steps, the top two an octave-ish above. */
  note(k: number) {
    this.one(`chime_${k % 6}`, 0.7, k >= 6 ? 1.5 : 1);
  }

  /** A wrong note: two chimes slowed into a sour low clash. */
  discord() {
    this.one('chime_0', 0.5, 0.5);
    this.one('chime_3', 0.4, 0.53);
  }

  memory() {
    this.one('memory_swell', 0.3);
    this.duck(10);
    this.music.memory().catch(() => {});
  }

  private voiceChain: AudioNode | null = null;

  /**
   * Mara's recorded lines (public/audio/voice/<id>.mp3 or .wav), if they exist. Played through
   * a soft "remembered" chain: a little room, the top end rolled off, a faint tape drift.
   */
  async voice(id: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    let buf: AudioBuffer | null = null;
    for (const ext of ['mp3', 'wav']) {
      try {
        const res = await fetch(`/audio/voice/${id}.${ext}`);
        // The dev server answers missing files with the HTML page, so check the type.
        if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio')) continue;
        buf = await ctx.decodeAudioData(await res.arrayBuffer());
        break;
      } catch {
        // Try the next extension.
      }
    }
    if (!buf) return;
    if (!this.voiceChain) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6800;
      const dry = ctx.createGain();
      dry.gain.value = 0.85;
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      const room = ctx.createConvolver();
      const len = Math.floor(ctx.sampleRate * 1.8);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-i / len) * 5);
      }
      room.buffer = ir;
      lp.connect(dry).connect(this.sfxBus);
      lp.connect(room).connect(wet).connect(this.sfxBus);
      this.voiceChain = lp;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Slow pitch drift, like an old tape of a memory.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.35;
    const depth = ctx.createGain();
    depth.gain.value = 6;
    lfo.connect(depth).connect(src.detune);
    const g = ctx.createGain();
    g.gain.value = 1.1;
    src.connect(g).connect(this.voiceChain);
    lfo.start();
    src.start(ctx.currentTime + 0.6);
    src.onended = () => lfo.stop();
  }

  private fairyOverride = new Map<string, AudioBuffer | null>();

  /** The companion's call. A recorded public/audio/voice/fairy-<call>.mp3 wins over the synth. */
  async fairy(call: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.fairyOverride.has(call)) {
      this.fairyOverride.set(call, null);
      try {
        const res = await fetch(`/audio/voice/fairy-${call}.mp3`);
        if (res.ok && (res.headers.get('content-type') ?? '').startsWith('audio'))
          this.fairyOverride.set(call, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // No recording: use the synthesised call.
      }
    }
    const rec = this.fairyOverride.get(call);
    if (rec) {
      const src = ctx.createBufferSource();
      src.buffer = rec;
      const g = ctx.createGain();
      g.gain.value = 0.8;
      src.connect(g).connect(this.sfxBus);
      src.start();
    } else this.one(`fairy_${call}`, 0.55, 0.97 + Math.random() * 0.06);
  }

  /** Composed score, routed through the music volume. */
  readonly music = new MusicDirector(() => this.ctx, () => this.musicBus ?? null);

  setVolumes(v: { master: number; music: number; sfx: number }) {
    this.volumes = { ...v };
    const ctx = this.ctx;
    if (!ctx) return;
    this.master.gain.setTargetAtTime(v.master * this.pausedDuck, ctx.currentTime, 0.1);
    this.musicBus.gain.setTargetAtTime(v.music, ctx.currentTime, 0.1);
    this.sfxBus.gain.setTargetAtTime(v.sfx, ctx.currentTime, 0.1);
  }

  /** The world goes quiet behind the pause menu; music stays faintly. */
  setPaused(paused: boolean) {
    this.pausedDuck = paused ? 0.35 : 1;
    const ctx = this.ctx;
    if (!ctx) return;
    this.master.gain.setTargetAtTime(this.volumes.master * this.pausedDuck, ctx.currentTime, 0.25);
  }

  /** Distance-attenuated one-shots for the wildlife. */
  splash(distance: number, big = false) {
    const g = Math.max(0, 1 - distance / (big ? 700 : 140));
    if (g <= 0.02) return;
    if (big) this.one('splash_big', 0.9 * g, 0.9);
    else this.one(`splash_small_${Math.floor(Math.random() * 3)}`, 0.5 * g, 0.9 + Math.random() * 0.25);
  }

  whale(distance: number) {
    this.one('whale_song', Math.max(0.25, 1 - distance / 900) * 0.8);
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
    // The generated pad only fills in when no composed track is sounding.
    const dread = mix.dread ?? 0;
    set('music', this.music.active ? 0 : 0.2 * this.musicDuck * (1 - dread));
    // Nightmares near: the dread rises and the score sinks under it.
    this.loops.get('dread')!.gain.setTargetAtTime(Math.pow(dread, 0.7) * 0.95, now, dread > 0.05 ? 0.8 : 2.5);
    this.music.setDread(dread);
  }
}
