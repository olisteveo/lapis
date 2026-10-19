import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/heightfield';
import type { Flora } from '../world/flora';
import type { ShootingStar } from '../world/sky';
import type { PlayerController } from '../game/player';
import type { Audio } from '../audio/audio';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Narrative } from './narrative';
import { THE_BOAT, LINES } from './content';
import { Constellation } from './constellation';
import { FallenStars } from './fallenStars';
import { createFootprints, createNote, DistantFigure } from './prologue';
import type { PrologueLayout } from './placement';

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
    this.stars.update(dt, camera);
    if (this.figure.update(dt, camera) && !this.seen('figure')) this.narrative.say(LINES.figure);
    this.flora.glow.value += (this.glowTarget - this.flora.glow.value) * Math.min(1, dt * 0.4);

    this.prompt = '';
    this.pendingAction = null;
    if (!playing) return;
    this.narrative.objective(THE_BOAT.name, this.save.collected.length, THE_BOAT.fragments.length);

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
