import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/heightfield';
import type { Flora } from '../world/flora';
import type { ShootingStar } from '../world/sky';
import type { PlayerController } from '../game/player';
import type { Audio } from '../audio/audio';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Narrative } from './narrative';
import { THE_BOAT, LINES } from './content';
import { LAGOONS } from '../world/heightfield';
import { Constellation } from './constellation';
import { FallenStars } from './fallenStars';
import { createFootprints, createNote, DistantFigure } from './prologue';
import type { PrologueLayout } from './placement';
import { Echoes, type EchoDef } from './echoes';
import type { Landmarks } from '../world/landmarks';

const SAVE_KEY = 'lapis.save.v1';

interface Save {
  collected: string[];
  seen: string[];
}

function loadSave(): Save {
  try {
    if (new URLSearchParams(location.search).has('reset')) localStorage.removeItem(SAVE_KEY);
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return JSON.parse(raw) as Save;
  } catch {
    // Private windows and blocked storage: just play without persistence.
  }
  return { collected: [], seen: [] };
}

/** Runs the prologue: clues on the beach, the six fallen stars, and The Boat in the sky. */
export class Story {
  readonly narrative = new Narrative();
  readonly group = new THREE.Group();
  private save = loadSave();
  private boat: Constellation;
  private stars: FallenStars;
  private figure: DistantFigure;
  private prompt = '';
  private pendingAction: (() => void) | null = null;
  private skyTimer = 90;
  private glowTarget = 1;
  private wasBoat = false;
  /** Fired when a memory plays, with its duration in seconds (drives the duotone wash). */
  onMemory: ((seconds: number) => void) | null = null;

  constructor(
    private layout: PrologueLayout,
    private hf: Heightfield,
    private flora: Flora,
    private shooting: ShootingStar,
    private audio: Audio,
  ) {
    this.group.name = 'story';
    const h = (x: number, z: number) => hf.height(x, z);
    // Hang The Boat over the open sea as seen from where you wake.
    const seaAz = THREE.MathUtils.radToDeg(Math.atan2(layout.seaward.x, -layout.seaward.z));
    this.boat = new Constellation({ ...THE_BOAT, azimuth: seaAz });
    this.stars = new FallenStars(THE_BOAT.fragments.map((f) => f.id), layout.stars, h);
    this.figure = new DistantFigure(layout.figureSpots, h);
    this.group.add(this.boat.group, this.stars.group, createFootprints(layout, h), createNote(layout.note, h), this.figure.group);

    const done = new Set(this.save.collected);
    this.stars.markCollected(done);
    THE_BOAT.fragments.forEach((f, i) => done.has(f.id) && this.boat.light(i, true));
    if (this.boat.isComplete) this.glowTarget = 1.35;
    for (let i = 0; i < Math.min(2, Math.floor(done.size / 2)); i++) this.figure.advance();

    this.stars.onArrive = (i) => {
      this.boat.light(i);
      if (this.boat.isComplete) this.onConstellationComplete();
    };
  }

  /** Opening: hide the first star until it's seen to fall, and keep pillars dark. */
  prepareOpening() {
    if (!this.save.collected.includes(THE_BOAT.fragments[0].id)) this.stars.hold(0);
    this.stars.showPillars(false);
  }

  get firstStarPosition() {
    return this.stars.position(0);
  }

  landFirstStar() {
    this.stars.land(0);
  }

  beginPlay() {
    this.stars.showPillars(true);
    this.stars.land(0);
  }

  /** Yaw that faces the sea from the spawn: the boat, the footprints and The Boat overhead. */
  get wakeYaw() {
    return Math.atan2(-this.layout.seaward.x, -this.layout.seaward.z);
  }

  loadFigure(keeper: GLTF) {
    this.figure.load(keeper);
  }

  private echoes: Echoes | null = null;

  /** Memory echoes anchored to the opening beach and the nearest landmarks. */
  setupEchoes(keeper: GLTF, landmarks: Landmarks) {
    const L = this.layout;
    const h = (x: number, z: number) => this.hf.height(x, z);
    const side = { x: -L.seaward.z, z: L.seaward.x };
    const defs: EchoDef[] = [];
    // A parent pointing out the stars to a child, along the beach from where you wake.
    for (let d = 26; d < 60; d += 2) {
      const x = L.spawn.x + side.x * d;
      const z = L.spawn.z + side.z * d;
      if (h(x, z) > 0.2 && h(x, z) < 1.4) {
        defs.push({ id: 'echo-point', line: "Which one's the bright one? That one? That one?", x, y: h(x, z), z,
          yaw: Math.atan2(L.seaward.x, L.seaward.z), adult: 'point', child: 'lookUp', childOffset: [0.75, 0.25] });
        break;
      }
    }
    const jetty = landmarks.nearest('Jetty', L.spawn.x, L.spawn.z);
    if (jetty) {
      const dx = Math.cos(jetty.yaw);
      const dz = -Math.sin(jetty.yaw);
      const x = jetty.x + dx * 15;
      const z = jetty.z + dz * 15;
      defs.push({ id: 'echo-jetty', line: 'Can we stay out till the lamp comes on?', x, y: jetty.y + 1.2 - 0.42, z,
        yaw: Math.atan2(dx, dz), adult: 'sit', child: 'sit', childOffset: [0.65, 0] });
    }
    const cairn = landmarks.nearest('Cairn', L.spawn.x + L.seaward.x * -200, L.spawn.z + L.seaward.z * -200);
    if (cairn) {
      defs.push({ id: 'echo-cairn', line: 'One more stone. For luck. For you.', x: cairn.x + 1.3, y: cairn.y, z: cairn.z,
        yaw: -Math.PI / 2, adult: 'stand', child: 'lookUp', childOffset: [-0.2, 0.7] });
    }
    this.echoes = new Echoes(defs, (id) => this.save.seen.includes(id));
    this.echoes.load(keeper);
    this.echoes.onTrigger = (def) => {
      this.seen(def.id);
      this.narrative.say(def.line, 'memory');
      this.audio.memory();
      this.audio.voice(def.id).catch(() => {});
      this.onMemory?.(6);
    };
    this.group.add(this.echoes.group);
  }

  private seen(key: string) {
    if (this.save.seen.includes(key)) return true;
    this.save.seen.push(key);
    this.persist();
    return false;
  }

  private persist() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.save));
    } catch {
      // Ignore: progress just won't survive a reload.
    }
  }

  /** Called on the frame E is pressed. Returns true if the story used the press. */
  interact(): boolean {
    if (this.narrative.dismiss()) return true;
    if (!this.pendingAction) return false;
    this.pendingAction();
    return true;
  }

  get currentPrompt() {
    return this.prompt;
  }

  update(dt: number, player: PlayerController, camera: THREE.Camera, playing: boolean) {
    this.narrative.update(dt);
    this.boat.update(dt, camera);
    if (playing) this.echoes?.update(dt, camera.position);
    this.stars.update(dt, camera);
    if (this.figure.update(dt, camera) && !this.seen('figure')) this.narrative.say(LINES.figure);
    this.flora.glow.value += (this.glowTarget - this.flora.glow.value) * Math.min(1, dt * 0.4);

    this.prompt = '';
    this.pendingAction = null;
    if (!playing) return;
    const found = LAGOONS.filter((_, i) => this.save.seen.includes(`lagoon-${i}`)).length;
    this.narrative.objective(THE_BOAT.name, this.save.collected.length, THE_BOAT.fragments.length, found ? `secret lagoons ${found} / ${LAGOONS.length}` : '');
    LAGOONS.forEach((L, i) => {
      if (Math.hypot(L.x - player.x, L.z - player.z) < L.r - 6 && !this.seen(`lagoon-${i}`)) {
        this.narrative.say(LINES.lagoon);
        this.audio.chime(3);
      }
      // Near a lagoon's stones for the first time: teach the jump.
      if (Math.hypot(L.x - player.x, L.z - player.z) < L.r + 55 && Math.hypot(L.x - player.x, L.z - player.z) > L.r + 20 && !this.seen('stones')) {
        this.narrative.say(LINES.stonesHint, 'hint', 7);
      }
    });

    const px = player.x;
    const pz = player.z;
    const walking = player.mode === 'walk';

    // First time in the boat: the carved seat.
    if (!walking && !this.wasBoat && !this.seen('seat')) this.narrative.say(LINES.seat);
    this.wasBoat = !walking;

    const fp = this.layout.footprints;
    for (let i = 0; i < Math.min(8, fp.length); i++)
      if (Math.hypot(fp[i].x - px, fp[i].z - pz) < 3.5 && walking) {
        if (!this.seen('footprints')) this.narrative.say(LINES.footprints);
        break;
      }

    if (this.narrative.reading) return;

    const note = this.layout.note;
    if (walking && Math.hypot(note.x - px, note.z - pz) < 2.2) {
      this.prompt = 'E   read the note';
      this.pendingAction = () => {
        this.narrative.note(LINES.note);
        this.seen('note');
      };
    }

    const star = this.stars.nearest(px, pz);
    if (star && this.save.collected.length === 0 && star.dist < 18 && !this.seen('warm')) this.narrative.say(LINES.warm);
    if (star && star.dist < (walking ? 2.6 : 4.2)) {
      this.prompt = 'E   gather the fallen star';
      this.pendingAction = () => this.gather(star.id, star.index);
    }

    this.skyTimer -= dt;
    if (this.skyTimer <= 0) {
      this.skyTimer = 70 + Math.random() * 70;
      const az = Math.random() * Math.PI * 2;
      const from = new THREE.Vector3(Math.sin(az), 0.9 + Math.random() * 0.5, -Math.cos(az));
      const to = new THREE.Vector3(Math.sin(az + 0.6), 0.08, -Math.cos(az + 0.6));
      this.shooting.fire(from, to);
      this.audio.starFall();
      if (!this.seen('skyFalls')) this.narrative.say(LINES.skyFalls);
    }
  }

  private gather(id: string, index: number) {
    const fragment = THE_BOAT.fragments[index];
    this.stars.collect(id, this.boat.dirs[index]);
    this.save.collected.push(id);
    this.persist();
    this.audio.chime(index);
    this.audio.memory();
    this.narrative.say(fragment.line, 'memory');
    this.audio.voice(fragment.id).catch(() => {});
    this.onMemory?.(8);
    const n = this.save.collected.length;
    if (n === 1) this.narrative.say(LINES.firstStar);
    if (n === 3) this.narrative.say(LINES.atSea);
    if (n === 2 || n === 4) this.figure.advance();
  }

  private onConstellationComplete() {
    if (this.seen('boatDone')) return;
    this.glowTarget = 1.35;
    this.audio.chime(5);
    this.narrative.say(THE_BOAT.name.toUpperCase(), 'title');
    this.narrative.say(LINES.boatDone);
    this.narrative.say(LINES.next);
  }

  /** Where the glitter path should point: the nearest fallen star still waiting. */
  guideTarget(player: PlayerController) {
    return this.stars.nearest(player.x, player.z)?.pos ?? null;
  }

  /** Lean on the heightfield for the audio mix around the listener. */
  audioMix(player: PlayerController) {
    let wet = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      if (this.hf.height(player.x + Math.sin(a) * 28, player.z + Math.cos(a) * 28) < -0.3) wet++;
    }
    const s = this.hf.sample(player.x, player.z);
    return { sea: wet / 12, jungle: s.height > 2 ? s.grove : 0, altitude: Math.max(0, player.y), inBoat: player.mode === 'boat' };
  }
}
