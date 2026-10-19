import * as THREE from 'three/webgpu';
import type { Heightfield } from '../core/heightfield';
import type { Flora } from '../world/flora';
import type { ShootingStar } from '../world/sky';
import type { PlayerController } from '../core/player';
import type { Audio } from '../audio/audio';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Narrative } from './narrative';
import { THE_BOAT, LINES, CONSTELLATIONS, TOTAL_STARS, ENDING } from '../core/content';
import { BIOMES, LAGOONS, RIVER } from '../core/heightfield';
import { Constellation } from './constellation';
import { FallenStars } from './fallenStars';
import { createFootprints, createNote, DistantFigure } from './prologue';
import type { P, PrologueLayout } from '../core/placement';
import type { Puzzles, PuzzleSite } from '../world/puzzles';
import { Echoes, type EchoDef } from './echoes';
import type { Landmarks } from '../world/landmarks';
import type { LighthouseClimb } from '../core/lighthouseClimb';
import type { Wonders } from '../world/wonders';
import { NightClock, type NightCue } from '../core/night';
import { Progress, type SaveStore } from '../core/progress';
import { KEEPSAKES, Keepsakes, layoutKeepsakes, type KeepsakeId } from './keepsakes';
import { SEE_RANGE } from './fallenStars';
import { settings } from '../settings';
import type { Wisp, WispCall, WispMood } from '../game/wisp';

const REGION_WONDER = { meadow: 'moontree', lantern: 'ring', dunes: 'whale', drowned: 'bell' } as const;

const browserStore: SaveStore = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
};

/** Runs the prologue: clues on the beach, the six fallen stars, and The Boat in the sky. */
export class Story {
  readonly narrative = new Narrative();
  readonly group = new THREE.Group();
  /** The rules of progress live in src/core; the story presents them. */
  readonly progress = new Progress(browserStore, new URLSearchParams(location.search).has('reset'));
  private get save() {
    return this.progress.save;
  }
  private skies: Constellation[];
  /** Fragment id -> which constellation, which of its stars. */
  private starRef = new Map<string, { c: number; i: number }>();
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
  /** A new night begins (rest or wake): the nightmares sink away. */
  onNewNight: (() => void) | null = null;
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
    sites: Record<string, P>,
    private puzzles: Puzzles,
  ) {
    this.group.name = 'story';
    const h = (x: number, z: number) => hf.height(x, z);
    // Hang The Boat over the open sea as seen from where you wake; the rest over their regions.
    const seaAz = THREE.MathUtils.radToDeg(Math.atan2(layout.seaward.x, -layout.seaward.z));
    this.skies = CONSTELLATIONS.map((c) => new Constellation(c === THE_BOAT ? { ...c, azimuth: seaAz } : c));
    const entries: { id: string; pos: P; beacon: boolean }[] = [];
    CONSTELLATIONS.forEach((c, ci) =>
      c.fragments.forEach((f, i) => {
        const pos = ci === 0 ? layout.stars[i] : sites[f.id];
        if (!pos) return;
        this.starRef.set(f.id, { c: ci, i });
        entries.push({ id: f.id, pos, beacon: ci === 0 });
      }),
    );
    this.stars = new FallenStars(entries, h);
    this.figure = new DistantFigure(layout.figureSpots, h);
    this.keepsakes = new Keepsakes(layoutKeepsakes(hf, layout.spawn), h, (id) => this.hasKeepsake(id));
    this.applyKeepsakes();
    this.group.add(this.keepsakes.group);
    this.group.add(...this.skies.map((c) => c.group), this.stars.group, createFootprints(layout, h), createNote(layout.note, h), this.figure.group);

    const done = new Set(this.save.collected);
    this.stars.markCollected(done);
    for (const id of done) {
      const r = this.starRef.get(id);
      if (r) this.skies[r.c].light(r.i, true);
    }
    // Stars inside wonders and behind puzzles stay hidden until those are found or solved.
    for (const c of CONSTELLATIONS) {
      if (!c.region) continue;
      let slot = 0;
      for (const f of c.fragments) {
        if (done.has(f.id)) continue;
        if (f.source === 'wonder' && !this.save.seen.includes(`wonder-${REGION_WONDER[c.region]}`)) this.stars.hold(this.stars.indexOf(f.id));
        if (f.source === 'puzzle' && !this.save.seen.includes(`puzzle-${c.region}-${slot}`)) this.stars.hold(this.stars.indexOf(f.id));
        if (f.source === 'puzzle') slot++;
      }
    }
    this.glowTarget = 1 + this.skies.filter((c) => c.isComplete).length * 0.12;
    for (let i = 0; i < Math.min(2, Math.floor(done.size / 2)); i++) this.figure.advance();

    this.stars.onArrive = (id) => {
      const r = this.starRef.get(id);
      if (!r) return;
      this.skies[r.c].light(r.i);
      if (this.skies[r.c].isComplete) this.onConstellationComplete(r.c);
    };
    puzzles.onSolve = (site) => this.solvePuzzle(site);
    puzzles.onDiscover = (site) => {
      const lines: Record<string, [string, WispCall]> = {
        fireflies: ["Hey! Fireflies, and a little jar. It's shut tight... maybe something nice inside would open it? Something that smells sweet.", 'hey'],
        footprints: ["Hmm? Little footprints in the dew. They only show if you go gently. And... some of them are yours.", 'hmm'],
        glowcaps: ['Look! The mushrooms are joined by roots. Touch one and its friends change too. Can you light them all at once?', 'look'],
        mirrors: ['Listen! A beam of light, and mirror caps. The shrine wants the light to visit every one of them first.', 'listen'],
        stones: ["Hmm? Each stone has a picture of the sky. I think each one should show what it's looking at. Stand behind a stone and look up past it!", 'hmm'],
        bells: site.slot === 0
          ? ['Listen! Bells, under the water. She used to say the sea remembers things the sky forgets... when it is calm.', 'listen']
          : ["Hmm? These bells have marks on them. But I don't trust them. What does the water say?", 'hmm'],
      };
      const [text, call] = lines[site.kind];
      this.guide(text, call);
    };
    puzzles.onNote = (k) => this.audio.note(k);
    puzzles.onFail = (site) => {
      if (site.kind === 'fireflies') {
        if (!this.seen('fireflyScatter')) this.guide("Oh no, you scared them! Gently... they're shy. Come round behind them.", 'watch');
        return;
      }
      this.audio.discord();
      this.guide("Hmm? That's not how it went. Try again.", 'hmm');
    };
    this.night.onCue = (cue) => this.nightCue(cue);
  }

  private keepsakes: Keepsakes;

  hasKeepsake(id: KeepsakeId) {
    return (this.save.keepsakes ?? []).includes(id);
  }

  private applyKeepsakes() {
    this.night.length = 20 * 60 * (this.hasKeepsake('ribbon') ? 1.4 : 1);
    SEE_RANGE.value = this.hasKeepsake('lantern') ? 130 : 75;
  }

  private takeKeepsake(id: KeepsakeId) {
    const def = KEEPSAKES.find((k) => k.id === id)!;
    this.keepsakes.take(id);
    this.progress.addKeepsake(id);
    this.applyKeepsakes();
    this.audio.memory();
    this.audio.chime(5);
    this.narrative.say(def.memory, 'memory');
    this.onMemory?.(6);
    setTimeout(() => this.narrative.say(def.name.toUpperCase(), 'title'), 6500);
    setTimeout(() => this.guide(`Oh! It's hers! ${def.effect} Press I to look in your satchel.`, 'oh', 'star'), 11000);
  }

  /** Everything the satchel shows. */
  satchelState() {
    const regionName: Record<string, string> = { meadow: 'the meadows', lantern: 'the Lantern Wood', dunes: 'the dunes', drowned: 'the drowned town' };
    return {
      carried: this.stars.carriedIds.map((id) => ({ constellation: CONSTELLATIONS[this.starRef.get(id)!.c].name })),
      keepsakes: this.save.keepsakes ?? [],
      skies: this.skies.map((c) => ({ name: c.def.name, lit: c.litCount, total: c.def.stars.length, region: c.def.region ? regionName[c.def.region] : 'the coral shore' })),
      lit: this.save.collected.length,
      total: TOTAL_STARS,
    };
  }

  private shellT = 0;

  get litTotal() {
    return this.save.collected.length;
  }

  get allLit() {
    return this.progress.allLit;
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
  private climb: LighthouseClimb | null = null;

  attachBeacons(landmarks: Landmarks, climb: LighthouseClimb) {
    this.landmarks = landmarks;
    this.climb = climb;
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

  /** The constellation for wherever the player is standing: its region's, or The Boat on the shore. */
  private regionSky(player: { x: number; z: number }) {
    const s = this.hf.sample(player.x, player.z);
    const w = { meadow: s.meadow, lantern: s.lantern, dunes: s.dunes, drowned: s.drowned * 1.5 };
    const best = (Object.keys(w) as (keyof typeof w)[]).sort((a, b) => w[b] - w[a])[0];
    if (w[best] < 0.35) return 0;
    return CONSTELLATIONS.findIndex((c) => c.region === best);
  }

  private solvePuzzle(site: PuzzleSite) {
    this.seen(site.id);
    this.audio.chime(5);
    const c = CONSTELLATIONS.find((k) => k.region === site.region)!;
    const f = c.fragments.filter((k) => k.source === 'puzzle')[site.slot];
    if (f) this.stars.land(this.stars.indexOf(f.id));
    const line = {
      fireflies: 'Oh! They went in! Look how the jar glows!',
      footprints: 'Oh! This is where she was going!',
      glowcaps: 'Oh! All of them at once! The shrine is awake!',
      mirrors: 'Oh! The light found its way!',
      stones: 'Oh! The stones can see the sky!',
      bells: 'Oh! The water remembered!',
    }[site.kind];
    this.guide(`${line} A star is falling, right there!`, 'oh', 'star');
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
    const regionName = { meadow: 'the meadows', lantern: 'the Lantern Wood', dunes: 'the dunes', drowned: 'the drowned town' } as const;
    // The opening's six stars are marked and easy; after that the light only knows roughly.
    const marked = this.stars.nearest(player.x, player.z, true);
    if (marked) {
      this.point(marked.pos.clone());
      this.guide(`Look! There's a fallen star ${compass(marked.pos)}.`, 'look', 'star');
      return;
    }
    const star = this.stars.nearest(player.x, player.z);
    if (star && star.dist < 150) {
      this.guide(star.dist < 50 ? "Oh! It's really close now. Look carefully!" : "Hmm... I can feel one nearby. Keep looking!", star.dist < 50 ? 'oh' : 'hmm', 'star');
      return;
    }
    if (this.allLit) {
      this.guide('Look! Follow the River of Light north, to the brightest star!', 'look', 'star');
      return;
    }
    // Point at the nearest region whose constellation is still dark, never at the star itself.
    const dark = CONSTELLATIONS.map((c, ci) => ({ c, ci }))
      .filter(({ c, ci }) => c.region && !this.skies[ci].isComplete)
      .map(({ c }) => ({ c, d: Math.hypot(BIOMES[c.region!].x - player.x, BIOMES[c.region!].z - player.z) }))
      .sort((a, b) => a.d - b.d)[0];
    const here = this.regionSky(player);
    if (here > 0 && !this.skies[here].isComplete) {
      const c = CONSTELLATIONS[here];
      const left = c.fragments.length - this.skies[here].litCount;
      this.guide(`Listen! ${left} of ${c.name}'s stars are still lost somewhere in ${regionName[c.region!]}. Some hide in strange places...`, 'listen');
      return;
    }
    if (dark) {
      const B = BIOMES[dark.c.region!];
      this.guide(`Hey! ${dark.c.name} is still dark. Its stars fell in ${regionName[dark.c.region!]}, ${compass(B)}.`, 'hey');
      return;
    }
    this.guide('Hmm? Look up. Which shapes are still dark?', 'hmm');
  }

  private point(at: THREE.Vector3) {
    this.wispForced = at;
    this.wispTargetUntil = performance.now() + 9000;
  }

  /** What the light should hover over right now. */
  private wispTarget(player: PlayerController) {
    if (this.wispForced && performance.now() < this.wispTargetUntil) return this.wispForced;
    const s = this.stars.nearest(player.x, player.z);
    if (s && s.dist < (s.beacon ? 35 : 10)) return s.pos;
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
    this.onNewNight?.();
    const b = this.save.lastBeacon;
    // You wake where you last rested: up on the gallery of that lighthouse.
    const spot = this.climb && b !== undefined && b >= 0 ? this.climb.gallerySpot(b) : this.layout.spawn;
    this.onWake?.(spot);
    setTimeout(() => {
      this.narrative.say(LINES.waking);
      if (carried.length) this.narrative.say(LINES.lost);
    }, 3200);
  }

  /** Light a beacon (first visit) or rest by it: bank carried stars and begin a new night. */
  private rest(i: number) {
    const first = this.progress.restAt(i);
    if (first) {
      this.landmarks!.lightBeacon(i);
      this.narrative.say(LINES.lit);
      this.audio.chime(4);
    }
    this.bankCarried();
    this.night.reset();
    this.onNewNight?.();
    if (!first) this.narrative.say(LINES.rest);
    this.persist();
  }

  /** A nightmare reached you: whatever you carried falls back, and she sleeps a little worse. */
  caught() {
    const carried = this.stars.carriedIds;
    for (const id of carried) this.stars.drop(id);
    this.night.progress = Math.min(0.97, this.night.progress + 0.08);
    this.audio.discord();
    if (carried.length) this.guide(`Oh no! It took ${carried.length > 1 ? 'the stars' : 'the star'}! ${carried.length > 1 ? "They've" : "It's"} fallen back where we found ${carried.length > 1 ? 'them' : 'it'}.`, 'watch', 'warn');
    else this.guide("Watch out! Don't let them touch you!", 'watch', 'warn');
  }

  nightmaresSighted() {
    if (this.seen('nightmareHint')) this.guide('Watch out! Nightmares!', 'watch', 'warn');
    else this.guide("Watch out! Nightmares! They hate the light. Stay near a lamp, or press Q and I'll flare!", 'watch', 'warn');
  }

  private bankCarried() {
    for (const id of this.stars.carriedIds) {
      const r = this.starRef.get(id)!;
      this.stars.collect(id, this.skies[r.c].dirs[r.i]);
      this.progress.bank(id);
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
    return this.progress.seen(key);
  }

  private persist() {
    this.progress.persist();
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
    for (const c of this.skies) c.update(dt, camera);
    if (playing) this.puzzles.update(dt, player);
    if (playing) this.echoes?.update(dt, camera.position);
    this.stars.update(dt, camera);
    this.keepsakes.update();
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
      `stars in her sky ${this.save.collected.length} / ${TOTAL_STARS}`,
    ].filter(Boolean).join('   ·   ');
    const w = this.wonders?.at(player.x, player.z, player.y);
    if (w && !this.seen(`wonder-${w.id}`)) {
      this.guide(w.line, w.id === 'bell' ? 'listen' : w.id === 'rocks' ? 'look' : 'oh', 'star');
      setTimeout(() => this.narrative.say(w.name, 'title'), 4800);
      this.audio.chime(5);
      // The region's hidden star was waiting inside.
      const c = CONSTELLATIONS.find((k) => k.region && REGION_WONDER[k.region] === w.id);
      const f = c?.fragments.find((k) => k.source === 'wonder');
      if (f && this.stars.isHeld(f.id)) setTimeout(() => this.stars.land(this.stars.indexOf(f.id)), 2500);
    }
    const sky = this.skies[this.regionSky(player)];
    this.narrative.objective(sky.def.name, sky.litCount, sky.def.stars.length, extra, carried);
    if (this.allLit && player.z < RIVER.zEnd + 400 && !this.ending) this.beginEnding();
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
        this.guide('Look! A lighthouse. Climb the stair to the lamp room at the top. Light it, and you can rest there.', 'look');
      const lamp = this.climb?.atLamp(px, pz, player.y) ?? -1;
      if (lamp >= 0) {
        const lit = this.landmarks.isLit(lamp);
        const n = this.stars.carriedIds.length;
        this.prompt = !lit ? 'E   light the lamp' : n ? `E   lift ${n} star${n > 1 ? 's' : ''} into her sky, and rest` : 'E   rest by the light';
        this.pendingAction = () => this.rest(lamp);
      } else if (nb.index >= 0 && nb.dist < 9 && player.y - this.landmarks.beacons[nb.index].placed.y < 2) {
        this.prompt = 'climb the stair to the lamp room';
      }
    }

    const puzzle = walking ? this.puzzles.interaction(px, pz) : null;
    if (puzzle) {
      this.prompt = puzzle.prompt;
      this.pendingAction = puzzle.act;
    }

    // The seashell sings faster as a hidden star gets closer.
    if (this.hasKeepsake('shell')) {
      const hidden = this.stars.nearest(px, pz);
      this.shellT -= dt;
      if (hidden && !hidden.beacon && hidden.dist < 240 && this.shellT <= 0) {
        const near = 1 - hidden.dist / 240;
        this.audio.shellHum(near);
        this.shellT = 0.5 + (1 - near) * 2.6;
      }
    }

    const ks = this.keepsakes.nearest(px, pz);
    if (ks && ks.dist < 16 && !this.seen(`ks-near-${ks.id}`)) this.guide('Oh! Something glowing. Something of hers!', 'oh', 'star');
    if (ks && ks.dist < 2.4) {
      const def = KEEPSAKES.find((k) => k.id === ks.id)!;
      this.prompt = `E   pick up ${def.name.replace(/^The /, 'the ')}`;
      this.pendingAction = () => this.takeKeepsake(ks.id);
    }

    const star = this.stars.nearest(px, pz);
    if (star && this.save.collected.length === 0 && star.dist < 18 && !this.seen('warm')) this.guide("Look! A fallen star. It's still warm!", 'look', 'star');
    if (star && !star.beacon && star.dist < 14 && !this.seen(`near-${star.id}`)) this.guide('Oh! Do you see that glint? A star!', 'oh', 'star');
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
    const r = this.starRef.get(id)!;
    const fragment = CONSTELLATIONS[r.c].fragments[r.i];
    if (settings.nights) {
      // Carried until you reach a lighthouse; lost if she wakes first.
      this.stars.carry(id);
      if (!this.seen('carryHint')) setTimeout(() => this.guide("Listen! Carry it to a lighthouse before the night runs out, or it'll fall back.", 'listen'), 7000);
    } else {
      this.stars.collect(id, this.skies[r.c].dirs[r.i]);
      this.progress.bank(id);
    }
    this.audio.chime(index % 6);
    this.audio.memory();
    this.narrative.say(fragment.line, 'memory');
    this.audio.voice(fragment.id).catch(() => {});
    this.onMemory?.(8);
    if (r.c !== 0) return;
    const n = this.save.collected.length + this.stars.carriedIds.length;
    if (n === 1) setTimeout(() => this.guide('Look up! Six stars fell along this shore. You can see their light rising.', 'look'), 15000);
    if (n === 3) this.guide("Listen! Some fell out at sea. The boat's waiting.", 'listen');
    if (n === 2 || n === 4) this.figure.advance();
  }

  private onConstellationComplete(c: number) {
    const def = CONSTELLATIONS[c];
    if (this.seen(`${def.id}Done`)) return;
    this.glowTarget = 1 + this.skies.filter((k) => k.isComplete).length * 0.12;
    this.audio.chime(5);
    this.narrative.say(def.name.toUpperCase(), 'title');
    if (this.allLit) {
      this.narrative.say(LINES.allDone);
      setTimeout(() => this.guide('Look! The brightest star! Follow the River of Light north, all the way to the end!', 'look', 'star'), 6000);
    } else {
      this.narrative.say(c === 0 ? LINES.boatDone : LINES.constellationDone);
      const left = this.skies.filter((k) => !k.isComplete).length;
      setTimeout(() => this.guide(`Listen! ${left === 1 ? 'One more constellation is' : `${left} more constellations are`} still dark. Look up, you can see their shapes!`, 'listen'), 6000);
    }
  }

  private ending = false;
  /** Fired when the ending finishes, to roll the title. */
  onEnding: (() => void) | null = null;

  /** The ending begins: the world fades before the last page. */
  onEndingStart: (() => void) | null = null;

  private beginEnding() {
    this.ending = true;
    this.onEndingStart?.();
    this.audio.memory();
    this.narrative.storybook(ENDING, () => this.onEnding?.());
  }

  /** Where the glitter path should point: only the opening's marked stars, or nowhere. */
  guideTarget(player: PlayerController) {
    return this.stars.nearest(player.x, player.z, true)?.pos ?? null;
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
