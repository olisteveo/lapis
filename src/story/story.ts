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
import type { Wonders } from '../world/wonders';
import { NightClock, type NightCue } from './night';
import { settings } from '../settings';
import type { Wisp, WispCall, WispMood } from '../game/wisp';

const SAVE_KEY = 'lapis.save.v1';

interface Save {
  /** Banked stars: carried to a lighthouse, lit in the sky for good. */
  collected: string[];
  seen: string[];
  /** Beacons whose lamps you've lit. */
  lit?: number[];
  lastBeacon?: number;
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
  /** Night progress 0..1 each frame (drives frost and dimming). */
  onNight: ((progress: number) => void) | null = null;
  /** She wakes: move the Keeper to this spot (the last lit light, or the first beach). */
  onWake: ((spot: { x: number; z: number }) => void) | null = null;
  readonly night = new NightClock(20 * 60);
  private landmarks: Landmarks | null = null;
  private wonders: Wonders | null = null;
  wisp: Wisp | null = null;
  private wispTargetUntil = 0;
  private wispForced: THREE.Vector3 | null = null;

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
    this.night.onCue = (cue) => this.nightCue(cue);
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

  /** Beacons exist once the props have loaded; re-light the ones lit in earlier sessions. */
  attachBeacons(landmarks: Landmarks) {
    this.landmarks = landmarks;
    for (const i of this.save.lit ?? []) landmarks.lightBeacon(i, true);
  }

  attachWonders(wonders: Wonders) {
    this.wonders = wonders;
  }

  /** Wonders found so far, for the HUD and the map. */
  get wondersFound() {
    return this.wonders?.list.filter((w) => this.save.seen.includes(`wonder-${w.id}`)) ?? [];
  }

  get waitingStars() {
    return this.stars.waiting;
  }

  /** Has this place been found (a lagoon, a wonder)? */
  hasSeen(key: string) {
    return this.save.seen.includes(key);
  }

  /** The companion speaks: a call, its line in the speech box, and it swoops into view. */
  guide(text: string, call: WispCall = 'hey', mood: WispMood = 'calm') {
    if (!this.wisp?.awake) {
      this.narrative.say(text, 'hint');
      return;
    }
    this.narrative.say(text, 'wisp');
    this.audio.fairy(call).catch(() => {});
    this.wisp.speak(4.5, mood);
  }

  /** F: ask the light what to do next. */
  askGuide(player: PlayerController) {
    if (!this.wisp?.awake) return;
    const lm = this.landmarks;
    const carried = this.stars.carriedIds.length;
    const compass = (to: { x: number; z: number }) => {
      const dx = to.x - player.x;
      const dz = to.z - player.z;
      const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
      const az = (Math.atan2(dx, -dz) + Math.PI * 2) % (Math.PI * 2);
      const d = Math.hypot(dx, dz);
      const dist = d < 60 ? 'close by' : `about ${Math.round(d / 50) * 50} metres away`;
      return `to the ${names[Math.round(az / (Math.PI / 4)) % 8]}, ${dist}`;
    };
    if (carried && settings.nights && lm) {
      const nb = lm.nearestBeacon(player.x, player.z);
      if (nb.index >= 0) {
        const spot = lm.beacons[nb.index].placed;
        this.point(new THREE.Vector3(spot.x, spot.y + 8, spot.z));
        this.guide(`Listen! You're carrying ${carried > 1 ? 'stars' : 'a star'}. There's a lighthouse ${compass(spot)}. Get there before she wakes!`, 'listen', 'warn');
        return;
      }
    }
    const star = this.stars.nearest(player.x, player.z);
    // An unfound wonder nearer than the next star gets a mention: a reason to wander off the path.
    const wonder = this.wonders?.list
      .filter((w) => !this.save.seen.includes(`wonder-${w.id}`))
      .map((w) => ({ w, d: Math.hypot(w.x - player.x, w.z - player.z) }))
      .sort((a, b) => a.d - b.d)[0];
    const rumour = wonder && (!star || wonder.d < star.dist) ? ` And something strange is humming ${compass(wonder.w)}...` : '';
    if (star) {
      this.point(star.pos.clone());
      this.guide(`Look! There's a fallen star ${compass(star.pos)}.${rumour}`, 'look', 'star');
      return;
    }
    if (wonder) {
      this.point(new THREE.Vector3(wonder.w.x, wonder.w.y + 4, wonder.w.z));
      this.guide(`Hmm? Something strange is humming ${compass(wonder.w)}. Let's go and see!`, 'hmm');
      return;
    }
    this.guide("Hey! The brightest star's in the north, past the lake. Follow it.", 'hey');
  }

  private point(at: THREE.Vector3) {
    this.wispForced = at;
    this.wispTargetUntil = performance.now() + 9000;
  }

  /** What the light should hover over right now. */
  private wispTarget(player: PlayerController) {
    if (this.wispForced && performance.now() < this.wispTargetUntil) return this.wispForced;
    const s = this.stars.nearest(player.x, player.z);
    if (s && s.dist < 35) return s.pos;
    if (this.landmarks) {
      const nb = this.landmarks.nearestBeacon(player.x, player.z);
      if (nb.index >= 0 && nb.dist < 40 && !this.landmarks.isLit(nb.index)) {
        const p = this.landmarks.beacons[nb.index].placed;
        return new THREE.Vector3(p.x, p.y + 6, p.z);
      }
    }
    return null;
  }

  private nightCue(cue: NightCue) {
    if (cue === 'late') this.guide("Hey! The night's getting late. Find a light!", 'watch', 'warn');
    else if (cue === 'cold') {
      this.narrative.say(LINES.cold, 'whisper');
      this.audio.voice('night-cold').catch(() => {});
    } else if (cue === 'eyes') {
      this.narrative.say(LINES.eyes, 'whisper');
      this.audio.voice('night-eyes').catch(() => {});
      setTimeout(() => this.guide('Hurry! She’s falling asleep. Find a lighthouse!', 'watch', 'warn'), 5000);
    } else this.wake();
  }

  /** The night runs out: carried stars fall back, and you wake at your last light. */
  private wake() {
    const carried = this.stars.carriedIds;
    for (const id of carried) this.stars.drop(id);
    this.night.reset();
    const b = this.save.lastBeacon;
    const spot = this.landmarks && b !== undefined && b >= 0 ? this.landmarks.beaconRestSpot(b) : this.layout.spawn;
    this.onWake?.(spot);
    setTimeout(() => {
      this.narrative.say(LINES.waking);
      if (carried.length) this.narrative.say(LINES.lost);
    }, 3200);
  }

  /** Light a beacon (first visit) or rest by it: bank carried stars and begin a new night. */
  private rest(i: number) {
    const lm = this.landmarks!;
    const first = !lm.isLit(i);
    if (first) {
      lm.lightBeacon(i);
      this.save.lit = [...(this.save.lit ?? []), i];
      this.narrative.say(LINES.lit);
      this.audio.chime(4);
    }
    this.save.lastBeacon = i;
    this.bankCarried();
    this.night.reset();
    if (!first) this.narrative.say(LINES.rest);
    this.persist();
  }

  private bankCarried() {
    for (const id of this.stars.carriedIds) {
      const index = THE_BOAT.fragments.findIndex((f) => f.id === id);
      this.stars.collect(id, this.boat.dirs[index]);
      if (!this.save.collected.includes(id)) this.save.collected.push(id);
    }
    this.persist();
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
        defs.push({ id: 'echo-point', line: "Which one's the brightest star? That one? That one?", x, y: h(x, z), z,
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
    if (this.wisp) {
      this.wisp.target = playing ? this.wispTarget(player) : null;
      this.wisp.update(dt, camera, settings.nights && this.night.progress > 0.75 ? 'warn' : 'calm');
    }
    if (this.figure.update(dt, camera) && !this.seen('figure')) this.narrative.say(LINES.figure);
    this.flora.glow.value += (this.glowTarget - this.flora.glow.value) * Math.min(1, dt * 0.4);

    this.prompt = '';
    this.pendingAction = null;
    if (!playing) return;
    // Nights: the clock runs while you play; turned off, anything carried is kept at once.
    const carried = this.stars.carriedIds.length;
    if (settings.nights) this.night.update(dt);
    else if (carried) this.bankCarried();
    this.onNight?.(settings.nights ? this.night.progress : 0);
    const found = LAGOONS.filter((_, i) => this.save.seen.includes(`lagoon-${i}`)).length;
    const wonders = this.wondersFound.length;
    const extra = [
      settings.nights ? this.night.phrase : '',
      found ? `secret lagoons ${found} / ${LAGOONS.length}` : '',
      wonders ? `wonders ${wonders} / ${this.wonders!.list.length}` : '',
    ].filter(Boolean).join('   ·   ');
    const w = this.wonders?.at(player.x, player.z, player.y);
    if (w && !this.seen(`wonder-${w.id}`)) {
      this.guide(w.line, w.id === 'bell' ? 'listen' : w.id === 'rocks' ? 'look' : 'oh', 'star');
      setTimeout(() => this.narrative.say(w.name, 'title'), 4800);
      this.audio.chime(5);
    }
    this.narrative.objective(THE_BOAT.name, this.save.collected.length, THE_BOAT.fragments.length, extra, carried);
    LAGOONS.forEach((L, i) => {
      if (Math.hypot(L.x - player.x, L.z - player.z) < L.r - 6 && !this.seen(`lagoon-${i}`)) {
        this.guide('Oh! A hidden lagoon. Look how the water glows!', 'oh');
        this.audio.chime(3);
      }
      // Near a lagoon's stones for the first time: teach the jump.
      if (Math.hypot(L.x - player.x, L.z - player.z) < L.r + 55 && Math.hypot(L.x - player.x, L.z - player.z) > L.r + 20 && !this.seen('stones')) {
        this.guide('Hey! Stones lead through the rocks. Space to jump, and run to jump further!', 'hey');
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

    // Lighthouses: light the lamp, or rest by it.
    if (this.landmarks && walking) {
      const nb = this.landmarks.nearestBeacon(px, pz);
      if (nb.index >= 0 && nb.dist < 60 && !this.landmarks.isLit(nb.index) && !this.seen('lightHint'))
        this.guide('Look! A lighthouse. Light its lamp, and you can rest there.', 'look');
      if (nb.index >= 0 && nb.dist < 7.5) {
        const lit = this.landmarks.isLit(nb.index);
        const n = this.stars.carriedIds.length;
        this.prompt = !lit ? 'E   light the lamp' : n ? `E   rest by the light  ·  ${n} star${n > 1 ? 's' : ''} carried` : 'E   rest by the light';
        this.pendingAction = () => this.rest(nb.index);
      }
    }

    const star = this.stars.nearest(px, pz);
    if (star && this.save.collected.length === 0 && star.dist < 18 && !this.seen('warm')) this.guide("Look! A fallen star. It's still warm!", 'look', 'star');
    if (star && star.dist < (walking ? 2.6 : 4.2)) {
      this.prompt = 'E   gather the fallen star';
      this.pendingAction = () => this.gather(star.id, star.index);
    }

    // Stars fall more often as the night runs down.
    this.skyTimer -= dt * (1 + (settings.nights ? this.night.progress * 3 : 0));
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
    if (settings.nights) {
      // Carried until you reach a lighthouse; lost if she wakes first.
      this.stars.carry(id);
      if (!this.seen('carryHint')) setTimeout(() => this.guide("Listen! Carry it to a lighthouse before the night runs out, or it'll fall back.", 'listen'), 7000);
    } else {
      this.stars.collect(id, this.boat.dirs[index]);
      this.save.collected.push(id);
      this.persist();
    }
    this.audio.chime(index);
    this.audio.memory();
    this.narrative.say(fragment.line, 'memory');
    this.audio.voice(fragment.id).catch(() => {});
    this.onMemory?.(8);
    const n = this.save.collected.length + this.stars.carriedIds.length;
    if (n === 1) setTimeout(() => this.guide('Look up! Six stars fell along this shore. You can see their light rising.', 'look'), 15000);
    if (n === 3) this.guide("Listen! Some fell out at sea. The boat's waiting.", 'listen');
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
