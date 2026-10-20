import * as THREE from 'three/webgpu';
import { PALETTE, QUALITY, RENDER, SKY, getQualityName, onQualityChange } from './config';
import { settings, onSettingsChange } from './settings';
import { PauseMenu } from './ui/menu';
import { JournalMap } from './ui/map';
import { Satchel } from './ui/satchel';
import { Hotbar } from './ui/hotbar';
import { LightGauge } from './ui/lightGauge';
import { TUNING } from './core/survival';
import { darkAt, darkReach } from './core/darkWater';
import { SquallClock } from './core/squalls';
import { createRain } from './world/rain';
import { weather } from './render/weather';
import { setDarkWater } from './render/darkWater';
import { MemoryFilm } from './ui/memoryFilm';
import { HeldKeepsake } from './game/held';
import { KEEPSAKES } from './story/keepsakes';
import { LAGOONS } from './core/heightfield';
import { createHeightfield, findSpawn } from './core/heightfield';
import { Terrain, WorkerPool } from './world/terrain';
import { createReflectionProxy, createTerrainMaterial } from './world/terrainMaterial';
import { createWater } from './world/water';
import { createSky } from './world/sky';
import { createSparkles } from './world/sparkles';
import { createMotes, regionMotes } from './world/motes';
import { Moonbeams } from './world/moonbeams';
import { Landmarks, layoutLandmarks, CompositeColliders } from './world/landmarks';
import { Wildlife } from './world/wildlife';
import { Fauna } from './world/fauna';
import { Wonders, layoutWonders } from './world/wonders';
import { Puzzles, layoutPuzzles, skyFeatures } from './world/puzzles';
import { Waterfalls, layoutFalls } from './world/waterfalls';
import { LighthouseClimb } from './core/lighthouseClimb';
import { Nightmares, type LightSource, type Senses } from './world/nightmares';
import { layoutRegionStars } from './core/placement';
import { Stones, layoutStones } from './world/stones';
import { Currents } from './world/currents';
import { Flora } from './world/flora';
import { createPost } from './render/post';
import { Grade } from './render/grade';
import { DynamicResolution } from './render/dynamicResolution';
import { PlayerController } from './core/player';
import { Input } from './game/input';
import { Avatar } from './game/avatar';
import { CameraRig } from './game/cameraRig';
import { Wisp } from './game/wisp';
import { Audio, type Surface } from './audio/audio';
import { Story } from './story/story';
import { layoutPrologue } from './core/placement';
import { LINES, STORYBOOK } from './core/content';

const SEED = 1337;
const $ = (id: string) => document.getElementById(id)!;
const debug = new URLSearchParams(location.search).has('debug');
// ?reset wipes progress before anything reads it (puzzles and the chart load state before the story does).
if (new URLSearchParams(location.search).has('reset')) {
  try {
    localStorage.removeItem('lapis.save.v1');
    localStorage.removeItem('lapis.map.v1');
  } catch {
    // Nothing stored.
  }
}

async function boot() {
  if (!('gpu' in navigator)) console.warn('WebGPU unavailable; three.js will fall back to WebGL2.');
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  const dynRes = new DynamicResolution();
  renderer.setPixelRatio(Math.min(devicePixelRatio, RENDER.maxPixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.body.prepend(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.zenith);
  scene.fog = new THREE.FogExp2(PALETTE.fog, RENDER.fogDensity);
  const camera = new THREE.PerspectiveCamera(RENDER.fov, innerWidth / innerHeight, RENDER.near, RENDER.far);

  const key = new THREE.DirectionalLight(0x9fb2ff, 1.5);
  key.position.copy(SKY.keyLight).multiplyScalar(1000);
  const moonFill = new THREE.DirectionalLight(PALETTE.moon, 0.35);
  moonFill.position.copy(SKY.moon).multiplyScalar(1000);
  scene.add(key, moonFill, new THREE.HemisphereLight(0x3550c0, 0x0a0d1c, 0.85));

  const hf = createHeightfield(SEED);
  const currents = new Currents(hf);
  // Squalls (docs/SURVIVAL.md, phase 4): their wind adds to the star currents, so it pushes the boat.
  const squalls = new SquallClock();
  const world = {
    height: (x: number, z: number) => hf.height(x, z),
    flow: (x: number, z: number) => {
      const f = currents.flow(x, z);
      const w = squalls.wind;
      return { x: f.x + w.x * 2.4, z: f.z + w.z * 2.4 };
    },
  };
  const pool = new WorkerPool(Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2)));

  const water = createWater();
  const proxy = createReflectionProxy();
  const terrain = new Terrain(pool, createTerrainMaterial(proxy.node), SEED);
  const sky = createSky();
  const sparkles = createSparkles();
  const motes = createMotes();
  const beams = new Moonbeams(hf);
  const flora = new Flora(pool, SEED);
  const avatar = new Avatar();
  // First person: the Keeper's body is never added to the scene.
  const rain = createRain();
  scene.add(sky.group, terrain.group, water.mesh, water.target, sparkles.group, flora.group, avatar.boat, motes, beams.group, rain);

  const spawn = findSpawn(hf);
  const layout = layoutPrologue(hf, spawn);
  const player = new PlayerController(world);
  const stones = new Stones(layoutStones(hf));
  const landmarks = new Landmarks(layoutLandmarks(hf, spawn));
  const climb = new LighthouseClimb(
    landmarks.placed.filter((p) => p.type === 'Beacon' || p.type === 'Lighthouse').map((p) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale })),
  );
  const wonders = new Wonders(layoutWonders(hf));
  // Props and wonders fill their solids in as their models load; until then they're simply empty.
  const props = [landmarks.solids, wonders.solids];
  player.platforms = {
    top: (x, z, y) => Math.max(stones.top(x, z), climb.top(x, z, y), ...props.map((s) => s.top(x, z, y))),
    blocksBoat: (x, z, r) => stones.blocksBoat(x, z, r) || props.some((s) => s.blocksBoat(x, z, r)),
    blocked: (x, z, y, body) => climb.blocked(x, z, y, body) || props.some((s) => s.blocked(x, z, y, body)),
    ceiling: (x, z, y) => Math.min(climb.ceiling(x, z, y), ...props.map((s) => s.ceiling(x, z, y))),
    push: (x, z, y, body) => climb.push(x, z, y, body),
  };
  const wildlife = new Wildlife(hf);
  const fauna = new Fauna(hf);
  // The Boat hangs over the sea as seen from where you wake; the stones need its bearing too.
  const boatAz = ((THREE.MathUtils.radToDeg(Math.atan2(layout.seaward.x, -layout.seaward.z)) % 360) + 360) % 360;
  const puzzleSites = layoutPuzzles(hf, wonders.list, boatAz);
  const puzzles = new Puzzles(puzzleSites, (id) => {
    try {
      return (JSON.parse(localStorage.getItem('lapis.save.v1') ?? '{}').seen ?? []).includes(id);
    } catch {
      return false;
    }
  }, skyFeatures(boatAz));
  player.colliders = new CompositeColliders([flora, landmarks, fauna, wonders, puzzles]);
  const nightmares = new Nightmares(hf);
  const waterfalls = new Waterfalls(layoutFalls(hf));
  const CLEAR: Record<string, number> = { RuinArch: 4, RuinWall: 4, RuinSteps: 3, Beacon: 14, Lighthouse: 14, Hut: 6, Wreck: 7, Jetty: 4, Swing: 2.5, Cairn: 2, StoneLantern: 1.5 };
  flora.setClearings([
    ...landmarks.placed.map((p) => ({ x: p.x, z: p.z, r: (CLEAR[p.type] ?? 2) * p.scale })),
    // Wonders stand in open ground so they can be seen from the edge of their clearing.
    ...puzzleSites.map((p) => ({ x: p.x, z: p.z, r: { stones: 22, glowcaps: 18, mirrors: 26, fireflies: 34, footprints: 6, bells: 11 }[p.kind] })),
    ...wonders.list.filter((w) => w.id !== 'rocks').map((w) => ({ x: w.x, z: w.z, r: { whale: 26, ring: 30, moontree: 24, bell: 12 }[w.id] ?? 16 })),
  ]);
  scene.add(landmarks.group, wildlife.group, fauna.group, wonders.group, puzzles.group, nightmares.group, waterfalls.group, stones.mesh, currents.group);
  player.place(spawn.x, spawn.z, Math.PI);
  player.placeBoat(layout.boat.x, layout.boat.z, layout.boat.heading);

  const audio = new Audio();
  const story = new Story(layout, hf, flora, sky.shooting, audio, layoutRegionStars(hf, wonders.list, puzzleSites), puzzles);
  story.attachWonders(wonders);
  props.push(story.keepsakeSolids);
  const wisp = new Wisp();
  const held = new HeldKeepsake();
  scene.add(held.group);
  story.wisp = wisp;
  scene.add(story.group, wisp.group);

  // Reflection pass rules: the Keeper casts no reflection (twist clue #1), sparkles stay out
  // of the mirror, and terrain must not sample the render target it is being drawn into.
  // The reflector reallocates its target on resize mid-frame; keep terrain off it briefly.
  let settleFrames = 0;
  scene.onBeforeRender = (_r, _s, cam) => {
    const mirror = cam !== camera;
    sparkles.group.visible = !mirror;
    motes.visible = !mirror;
    beams.group.visible = !mirror;
    wildlife.setMirror(mirror);
    fauna.group.visible = !mirror;
    puzzles.setMirror(mirror);
    flora.setMirror(mirror);
    held.setMirror(mirror);
    proxy.node.value = mirror || settleFrames > 0 ? proxy.dummy : water.reflection.value;
  };
  scene.onAfterRender = (_r, _s, cam) => {
    if (cam !== camera) {
      sparkles.group.visible = true;
      motes.visible = true;
      beams.group.visible = beams.wanted;
      wildlife.setMirror(false);
      fauna.group.visible = true;
      puzzles.setMirror(false);
      flora.setMirror(false);
      held.setMirror(false);
      proxy.node.value = settleFrames > 0 ? proxy.dummy : water.reflection.value;
    }
  };

  const input = new Input(renderer.domElement);
  const rig = new CameraRig(camera, hf);
  const grade = new Grade();
  void grade.loadAll();
  let post = createPost(renderer, scene, camera, grade);
  let postSteps = QUALITY.strokeSteps;
  let memoryUntil = 0;
  let frostTarget = 0;
  // Survival (docs/SURVIVAL.md): how cold she is, 0 warm to 1 frozen, drawn as frost.
  let cold = 0;
  const tuning = () => TUNING[settings.survival === 'survival' ? 'survival' : 'story'];
  const surviving = () => settings.survival !== 'wander';
  let outOfLightSaid = 0;
  let glowCount = 0;
  let lightningIn = 8;
  let squallWarned = 0;
  /** Squalls come more often and harder as the night grows late and as her sky is restored. */
  const updateWeather = (dt: number) => {
    const pressure = Math.min(1, story.night.progress * 0.6 + story.restoredShare * 0.6);
    const entered = squalls.update(dt, pressure, settings.nights);
    weather.storm.value = squalls.intensity;
    weather.windX.value = squalls.wind.x;
    weather.windZ.value = squalls.wind.z;
    if (entered === 'building') {
      if (squallWarned++ < 2) story.guide(player.mode === 'boat' ? "Look! A squall's coming in. Get to shore, quick!" : "Brr, a squall's coming in off the sea! Find a light to shelter by.", 'look', 'warn');
      else wisp.speak(0.8, 'warn');
    }
    // Lightning only in the heart of a squall: a flash, and the night is darker after.
    lightningIn -= dt;
    if (squalls.phase === 'raging' && lightningIn <= 0) {
      weather.flash.value = 1;
      lightningIn = 5 + Math.random() * 10;
    }
    weather.flash.value = Math.max(0, weather.flash.value - dt * 4);
  };
  let darkReachNow = Infinity;
  let refugesNow: ReturnType<typeof story.refuges> = [];
  // Stealth (docs/SURVIVAL.md, phase 2): how loud and how visible the Keeper is.
  let litHere = 0;
  let noiseBurst = 0;
  let hiddenSaid = false;
  let alertSaid = 0;
  const hiddenVeil = document.createElement('div');
  hiddenVeil.id = 'hidden-veil';
  document.body.appendChild(hiddenVeil);
  const creeping = () => input.down('KeyC');
  /** Noise radius and visibility for the nightmares' senses, from how you move and where you are. */
  const senses = (): Senses => {
    const wet = player.mode === 'walk' && hf.height(player.x, player.z) < -0.3;
    let noise: number;
    if (player.mode === 'boat') noise = player.boat.rowing ? 14 : 4;
    else if (player.speed < 0.3) noise = 0;
    else if (player.speed < 2) noise = 3;
    else if (player.speed < 4.5) noise = 11;
    else noise = 26;
    if (wet && player.speed > 0.3) noise *= 1.6;
    noise = Math.max(noise, noiseBurst);
    const cover = player.mode === 'walk' && flora.softAt(player.x, player.z, player.y);
    let visibility = 0.3 + 0.7 * litHere;
    if (cover) visibility *= 0.4;
    if (player.speed < 2) visibility *= player.speed < 0.3 ? 0.6 : 0.75;
    // Rain drums over your footsteps and veils you: a squall is cover as well as danger.
    noise *= 1 - squalls.intensity * 0.5;
    visibility *= 1 - squalls.intensity * 0.4;
    return { noise, visibility: Math.min(1, visibility) };
  };
  story.onNight = (p) => (frostTarget = p);
  // She wakes: frost whites everything out, the Keeper is moved to the last light, and it clears.
  story.onWake = (spot) => {
    fade.style.background = '#dfe6f7';
    fade.style.transitionDuration = '2.2s';
    fade.style.opacity = '1';
    setTimeout(() => {
      player.mode = 'walk';
      player.place(spot.x, spot.z, 0);
      frostTarget = 0;
      fade.style.transitionDuration = '3.5s';
      fade.style.opacity = '0';
      setTimeout(() => (fade.style.background = '#02030a'), 3600);
    }, 2600);
  };
  story.onMemory = (seconds) => (memoryUntil = performance.now() / 1000 + seconds);
  // A rest is a short sleep: the lamp's warmth closes in around the view while her stars rise and
  // the nightmares sink, then lets go. E or Space ends it early.
  const restGlow = document.createElement('div');
  restGlow.id = 'rest-glow';
  document.body.appendChild(restGlow);
  let restTimer = 0;
  const endRest = () => {
    clearTimeout(restTimer);
    restGlow.classList.remove('on');
  };
  story.onRest = (share) => {
    cold = 0;
    restGlow.classList.add('on');
    audio.chime(share < 1 ? 2 : 4);
    wisp.speak(1.6, 'calm');
    restTimer = window.setTimeout(endRest, 2800 + 1600 * share);
  };
  addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.code === 'KeyE') && restGlow.classList.contains('on') && !e.repeat) endRest();
  });

  wildlife.onEvent = (kind, at) => {
    const d = camera.position.distanceTo(at);
    if (kind === 'whale') audio.whale(d);
    else audio.splash(d, kind === 'bigSplash');
  };
  const optional = (p: Promise<unknown>, what: string) => p.catch((e) => console.warn(`${what} not loaded yet`, e?.message ?? e));
  await Promise.all([
    optional(
      landmarks.load('/models/props.glb', '/models/biomes.glb', '/models/lighthouse.glb').then((t) => {
        story.attachBeacons(landmarks, climb);
        if (debug) console.log('landmarks', t);
      }),
      'props',
    ),
    optional(wildlife.load('/models/creatures.glb').then((t) => debug && console.log('wildlife', t)), 'creatures'),
    optional(fauna.load('/models/fauna.glb').then((t) => debug && console.log('fauna', t)), 'fauna'),
    optional(nightmares.load('/models/nightmares.glb').then((t) => debug && console.log('nightmares', t)), 'nightmares'),
    optional(wonders.load('/models/wonders.glb').then((t) => debug && console.log('wonders', t)), 'wonders'),
    optional(story.loadKeepsakes('/models/keepsakes.glb').then((t) => t && held.setModels(t)), 'keepsakes'),
    avatar.load('/models/keeper.glb', '/models/boat.glb').then(() => {
      if (!avatar.keeperGltf) return;
      story.loadFigure(avatar.keeperGltf);
      story.setupEchoes(avatar.keeperGltf, landmarks);
    }),
    flora.load('/models/flora.glb', '/models/biomes.glb').then((types) => debug && console.log('flora types', types)),
  ]);
  // Build every material's shader now, in the background, rather than the first time it comes into
  // view: entering a new region otherwise stalls for a frame or two while its plants compile.
  // Empty plant batches (instanceCount 0) are skipped by the compiler, so give each one a stand-in
  // instance for the warm-up; the next flora update replaces it with the real counts.
  flora.group.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.InstancedBufferGeometry | undefined;
    if (g?.isInstancedBufferGeometry && !g.instanceCount) g.instanceCount = 1;
  });
  renderer.compileAsync(scene, camera).catch(() => {});

  // Polled rather than event-driven: embedded panes and devtools can resize without a reliable event.
  const size = new THREE.Vector2();
  const fitCanvas = () => {
    if (!innerWidth || !innerHeight) return;
    renderer.getSize(size);
    if (size.x === innerWidth && size.y === innerHeight) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    settleFrames = 3;
  };

  // Intro: the storybook is told on black; once it finishes the clock below starts.
  //   0-2   fade up, on your back staring at the sky.   2.6 a star falls.
  //   4-8.5 the title over the sky.   9-13.5 you sit up, facing the sea.
  let INTRO_DARK = 999;
  const WAKE_LEN = 13.5;
  let INTRO_END = 999;
  let state: 'title' | 'intro' | 'play' = debug && location.hash === '#play' ? 'play' : 'title';
  let introT = 0;
  let shot = false;
  let titleShown = false;
  // Wake facing the sea: the boat, the footprints, the first star, The Boat overhead.
  input.yaw = story.wakeYaw;
  input.pitch = -0.04;
  const fade = $('fade');
  story.prepareOpening();
  if (state === 'play') {
    story.beginPlay();
    wisp.wake(new THREE.Vector3(player.x + 1.5, 1, player.z + 1.5));
  }
  const beginWake = () => {
    INTRO_DARK = introT + 0.4;
    INTRO_END = INTRO_DARK + WAKE_LEN;
    fade.style.transitionDuration = '2.5s';
    fade.style.opacity = '0';
  };
  input.onFirstGesture = () => {
    if (state !== 'title') return;
    state = 'intro';
    // The storybook theme plays under the bedtime story and stays with you as you wake.
    audio
      .start()
      .catch((e) => console.warn('audio failed', e));
    audio.music.beginOpening();
    audio.music.preload();
    $('hint').style.opacity = '0';
    $('title').style.opacity = '0';
    fade.style.transitionDuration = '0.8s';
    fade.style.opacity = '1';
    setTimeout(() => story.narrative.storybook(STORYBOOK, beginWake), 900);
  };
  const skipIntro = () => {
    if (story.narrative.inStorybook) {
      story.narrative.skipStorybook();
      return;
    }
    if (INTRO_DARK > 900) beginWake();
    introT = INTRO_END;
    fade.style.opacity = '0';
  };
  let ePressed = false;
  addEventListener('keydown', (e) => {
    if ((e.code === 'Escape' || e.code === 'Space') && state === 'intro') skipIntro();
    else if (e.code === 'Escape' && state === 'play') {
      if (menu.open) menu.back();
      else openMenu();
    }
    if (film.open && (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Escape') && !e.repeat) {
      film.close();
      return;
    }
    if (e.code === 'KeyE' && !e.repeat) ePressed = true;
    const slot = /^Digit([1-5])$/.exec(e.code);
    if (slot && !e.repeat && state === 'play' && !menu.open && !chart.open) {
      story.wield(KEEPSAKES[Number(slot[1]) - 1].id);
      satchel.refresh(story.satchelState());
    }
    if (e.code === 'KeyF' && !e.repeat && state === 'play' && !menu.open && !chart.open) story.askGuide(player);
    if (e.code === 'KeyQ' && !e.repeat && state === 'play' && !menu.open && !chart.open && wisp.awake) {
      // The light store gates the flare: it costs light (free in Story mode) and has its own cooldown.
      if (story.light.flare(tuning())) {
        nightmares.flare(camera.position, 0);
        wisp.speak(1.2, 'star');
        flareFlash = 1;
        audio.chime(5);
        gauge.spent();
      } else if (story.light.ready && performance.now() - outOfLightSaid > 15000) {
        outOfLightSaid = performance.now();
        story.guide("Oh! I'm out of light. Walk through the glow, or hold the lantern up to something shining.", 'oh', 'warn');
      }
    }
    if ((e.code === 'KeyI' || e.code === 'Tab') && !e.repeat && state === 'play' && !menu.open && !chart.open) {
      e.preventDefault();
      if (satchel.open) {
        satchel.hide();
        audio.setPaused(false);
        Promise.resolve(renderer.domElement.requestPointerLock?.()).catch(() => {});
      } else {
        satchel.show(story.satchelState());
        audio.setPaused(true);
        // Let the pointer go so a keepsake can be clicked to take it in hand.
        if (document.pointerLockElement) document.exitPointerLock();
      }
    }
    if (e.code === 'KeyM' && !e.repeat && state === 'play' && !menu.open && !satchel.open) {
      if (chart.open) {
        chart.hide();
        audio.setPaused(false);
      } else {
        const fwd = camera.getWorldDirection(new THREE.Vector3());
        chart.showSelf = story.hasKeepsake('compass');
        chart.show(player, Math.atan2(fwd.x, -fwd.z));
        audio.setPaused(true);
      }
    }
  });
  rig.onStep = (speed) => {
    const h = hf.height(player.x, player.z);
    const s = hf.sample(player.x, player.z);
    // Up on something built (a deck, a stone, a tower's stair) the footstep is that, not the ground.
    const built = player.y > h + 0.12 ? (props.map((p) => p.standingOn(player.x, player.z, player.y)).find(Boolean) ?? 'stone') : null;
    const surface: Surface = (built as Surface | null) ?? (h < -0.05 ? 'water' : h < 0.75 ? 'wet' : h < 2.8 && s.grove < 0.3 ? 'sand' : 'jungle');
    audio.step(surface, speed);
    if (flora.softAt(player.x, player.z, player.y)) audio.brush(speed);
  };
  let lastStroke = 0;
  let playStarted = 0;
  player.onEvent = (e) => {
    // Jumps and landings carry: a burst of noise the nightmares can hear.
    if (e === 'jump' || e === 'land') noiseBurst = Math.max(noiseBurst, 16);
    if (e === 'jump') audio.jump();
    else if (e === 'land') audio.land(hf.height(player.x, player.z) < 0);
    else if (e === 'fall') {
      audio.splash(2);
      fade.style.transitionDuration = '1s';
      fade.style.opacity = '0.85';
      if (!story.narrative.busy) story.narrative.say(LINES.fell);
    } else if (e === 'respawn') {
      fade.style.transitionDuration = '1.4s';
      fade.style.opacity = '0';
    } else if (e === 'powerStroke') audio.powerStroke();
    else if (e === 'callBoat') audio.oarDrip();
  };
  let currentHinted = false;
  let strokeHinted = false;

  if (debug) {
    // Console handle for art direction: lapis.view(x, z, yaw, pitch), lapis.player, etc.
    const capture: { target?: THREE.RenderTarget } = {};
    Object.assign(window, {
      lapis: {
        player, input, camera, hf, flora, sparkles, story, layout, audio, landmarks, wildlife, currents, stones, fauna, wonders, nightmares, puzzles, climb, renderer, waterfalls,
        get post() {
          return post;
        },
        /** Simulated playtesters of four skills on every puzzle; prints and returns the table. */
        async playtest(runs = 30) {
          const { playtest } = await import('./core/playtest');
          const rows = playtest(puzzleSites, skyFeatures(boatAz), runs);
          console.table(rows);
          return rows;
        },
        view(x: number, z: number, yaw = input.yaw, pitch = input.pitch) {
          state = 'play';
          player.mode = 'walk';
          player.place(x, z, yaw + Math.PI);
          input.yaw = yaw;
          input.pitch = pitch;
        },
        boat() {
          state = 'play';
          player.mode = 'boat';
        },
        squalls,
        /** Bring the next squall in now. */
        squall() {
          (squalls as unknown as { t: number; length: number }).t = (squalls as unknown as { length: number }).length;
        },
        /** Try a .cube grade on a chapter live: lapis.grade('bell', '/grades/storm.cube'). */
        grade: (chapter: string, url: string) => grade.load(chapter, url),
        /**
         * The finished, painted frame as a JPEG data URL, rendered into an offscreen target and
         * read back, so it works even when the canvas isn't presenting (a hidden tab). For films.
         */
        async captureFrame(width = 1920, height = 1080, quality = 0.93) {
          capture.target ??= new THREE.RenderTarget(width, height);
          capture.target.setSize(width, height);
          // three counts frames from its animation loop, which stalls in a hidden tab, and the scene
          // pass renders once per counted frame; step the counter so this render sees the new camera.
          (renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame.update();
          renderer.setRenderTarget(capture.target);
          post.pipeline.render();
          renderer.setRenderTarget(null);
          const px = (await renderer.readRenderTargetPixelsAsync(capture.target, 0, 0, width, height)) as Uint8Array;
          const canvas = new OffscreenCanvas(width, height);
          const ctx = canvas.getContext('2d')!;
          const img = ctx.createImageData(width, height);
          img.data.set(px.subarray(0, width * height * 4));
          ctx.putImageData(img, 0, 0);
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
          return await new Promise<string>((done) => {
            const r = new FileReader();
            r.onload = () => done(r.result as string);
            r.readAsDataURL(blob);
          });
        },
      },
    });
  }

  const statsEl = $('stats');
  if (debug) statsEl.style.display = 'block';
  let frames = 0;
  let fpsT = 0;
  const clock = new THREE.Timer();
  const focus = new THREE.Vector3();

  let lastFrame = 0;
  let lastRender = 0;
  if (debug) console.log('quality', getQualityName(), QUALITY);

  // Settings apply live: resolution, paint detail, volumes, mouse.
  onQualityChange(() => {
    dynRes.reset();
    renderer.setPixelRatio(Math.min(devicePixelRatio, RENDER.maxPixelRatio));
    renderer.setSize(innerWidth, innerHeight);
    settleFrames = 3;
    if (QUALITY.strokeSteps !== postSteps) {
      postSteps = QUALITY.strokeSteps;
      (post.pipeline as unknown as { dispose?: () => void }).dispose?.();
      post = createPost(renderer, scene, camera, grade);
    }
  });
  const applySettings = () => {
    audio.setVolumes(settings);
    input.sensitivity = settings.sensitivity;
    input.invertY = settings.invertY;
  };
  onSettingsChange(applySettings);
  applySettings();

  const menu = new PauseMenu();
  const chart = new JournalMap(hf);
  const satchel = new Satchel();
  satchel.onWield = (id) => {
    story.wield(id);
    satchel.refresh(story.satchelState());
  };
  const hotbar = new Hotbar();
  const gauge = new LightGauge();
  let gathering = false;
  /**
   * One frame of survival: measure how lit, wet and windswept she is, let warmth drain or recover,
   * gather light from the motes and from glowing things the raised lantern is held to.
   */
  const surviveFrame = (dt: number, lights: LightSource[]) => {
    const t = tuning();
    const here = hf.sample(player.x, player.z);
    if (frames % 10 === 0) glowCount = flora.glowNear(player.x, player.z, 5);
    let lit = 0;
    for (const l of lights) lit = Math.max(lit, THREE.MathUtils.smoothstep(l.r - Math.hypot(l.x - player.x, l.z - player.z), 0, l.r * 0.65));
    // The raised lantern is a small real light; glowing plants only soften the cold (glow, below).
    lit = Math.min(1, lit + (held.raised === 'lantern' ? 0.25 : 0));
    const glow = Math.min(1, glowCount * 0.15);
    litHere = Math.min(1, lit + glow * 0.5);
    const ground = hf.height(player.x, player.z);
    const exposure = {
      lit,
      glow,
      inWater: player.mode === 'walk' && ground < -0.3 && player.y < 0.3,
      wind: Math.max(here.dunes * 0.8, THREE.MathUtils.smoothstep(player.y, 40, 160), player.mode === 'boat' ? 0.6 : 0, squalls.intensity * 0.9),
      // Near a real light (a lamp, a hut, a lighthouse) she shelters from the rain.
      rain: squalls.intensity * (lit > 0.5 ? 0.2 : 1),
      night: story.night.progress,
      // On or beside the Dark Water it chills fast; inland it only reaches you faintly.
      dark: darkAt(player.x, player.z, darkReachNow, refugesNow) * (player.mode === 'boat' || ground < 1 ? 1 : 0.3),
    };
    if ((exposure.dark ?? 0) > 0.35 && story.once('darkWaterHint'))
      story.guide("Oh... the water's gone black out there, and so cold. Her lit skies hold it back. Don't stay on it long!", 'oh', 'warn');
    if (story.warmth.update(dt, exposure, t)) story.collapse();
    cold = THREE.MathUtils.smoothstep(1 - story.warmth.value, 0.35, 1);
    story.light.cap = story.hasKeepsake('lantern') ? t.lanternCap : t.wispCap;
    // Drawing: the raised lantern held to glowing plants or the surf pulls their light in; they dim.
    const surf = Math.abs(ground) < 0.8 && player.mode === 'walk';
    let drawn = 0;
    if (held.raised === 'lantern' && (glowCount > 0 || surf) && story.light.value < story.light.cap)
      drawn = story.sources.draw(player.x, player.z, performance.now() / 1000, dt, t.drawRate);
    let motes = 0;
    for (const u of Object.values(regionMotes)) motes += u.value;
    const moving = player.speed > 0.5 ? 1 : 0.4;
    story.light.gain(drawn + t.moteRate * dt * Math.min(1, motes) * moving);
    gathering = drawn > 0;
  };
  const film = new MemoryFilm();
  story.onMemoryFilm = (id, after) => {
    if (!film.has(id)) return false;
    // The world goes quiet and still behind the film.
    audio.setPaused(true);
    if (document.pointerLockElement) document.exitPointerLock();
    return film.play(id, audio.effectsVolume, () => {
      audio.setPaused(false);
      after();
      Promise.resolve(renderer.domElement.requestPointerLock?.()).catch(() => {});
    });
  };
  // The seashell's hum, seen as well as heard: a pink shimmer at the edge of the view, on the star's side.
  const shellCue = document.createElement('div');
  shellCue.id = 'shell-cue';
  document.body.appendChild(shellCue);
  story.onShellHum = (dx, dz, near, inHand) => {
    const rel = Math.atan2(dx, dz) - (input.yaw + Math.PI);
    const side = -Math.sin(rel);
    audio.shellHum(near, inHand ? side * 0.9 : 0);
    shellCue.style.setProperty('--x', `${50 + side * 50}%`);
    shellCue.style.setProperty('--y', `${50 - Math.cos(rel) * 50}%`);
    shellCue.style.transition = 'none';
    shellCue.style.opacity = String((inHand ? 0.45 : 0.18) + near * (inHand ? 0.55 : 0.25));
    void shellCue.offsetWidth;
    shellCue.style.transition = '';
    shellCue.style.opacity = '0';
  };
  let flareFlash = 0;
  nightmares.onCatch = () => story.caught();
  nightmares.onSighted = () => story.nightmaresSighted();
  nightmares.onAlerted = () => {
    audio.discord();
    if (performance.now() - alertSaid > 20000) {
      alertSaid = performance.now();
      story.guide(story.once('alertHint') ? 'It heard us! Run for a light, or hold C and slip into the long grass!' : 'It found us! Run for the light!', 'watch', 'warn');
    } else wisp.speak(0.8, 'warn');
  };
  nightmares.onLost = () => story.guide("Phew. It's lost us.", 'hmm');
  story.onNewNight = () => nightmares.clear();
  // The ending: fade to black for the last page, then the end card; afterwards you may keep wandering.
  story.onEndingStart = () => {
    fade.style.transition = 'opacity 4s ease';
    fade.style.opacity = '1';
    nightmares.clear();
  };
  story.onEnding = () => {
    const card = document.createElement('div');
    card.id = 'endcard';
    card.innerHTML = `<div class="t">L A P I S</div><div class="s">beyond the sea</div><div class="thanks">thank you for playing</div><div class="go">click to keep wandering</div>`;
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('open'));
    card.addEventListener('click', () => {
      card.classList.remove('open');
      setTimeout(() => card.remove(), 1500);
      fade.style.opacity = '0';
      setTimeout(() => (fade.style.transition = ''), 4000);
    });
  };
  chart.markers = () => [
    ...landmarks.beacons.map((b, i) => ({ kind: landmarks.isLit(i) ? 'beaconLit' : 'beacon', x: b.placed.x, z: b.placed.z }) as const),
    ...LAGOONS.flatMap((L, i) => (story.hasSeen(`lagoon-${i}`) ? [{ kind: 'lagoon' as const, x: L.x, z: L.z, label: 'secret lagoon' }] : [])),
    ...wonders.list.map((w) =>
      story.hasSeen(`wonder-${w.id}`) ? { kind: 'wonder' as const, x: w.x, z: w.z, label: w.name } : { kind: 'mystery' as const, x: w.x, z: w.z },
    ),
    ...puzzleSites.filter((p) => story.hasSeen(p.id)).map((p) => ({ kind: 'lagoon' as const, x: p.x, z: p.z, label: { fireflies: 'the firefly jar', footprints: 'footprints', glowcaps: 'glowcaps', mirrors: 'mirror caps', stones: 'sky stones', bells: 'drowned bells' }[p.kind] })),
  ];
  const openMenu = () => {
    if (menu.open || state !== 'play') return;
    menu.show();
    audio.setPaused(true);
    if (document.pointerLockElement) document.exitPointerLock();
  };
  menu.onResume = () => {
    menu.hide();
    audio.setPaused(false);
    Promise.resolve(renderer.domElement.requestPointerLock?.()).catch(() => {});
  };
  menu.onStartOver = () => {
    try {
      localStorage.removeItem('lapis.save.v1');
      JournalMap.clear();
    } catch {
      // Nothing saved to clear.
    }
    location.href = location.pathname;
  };
  // The browser swallows Escape when it releases pointer lock, so losing the lock opens the menu.
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && state === 'play' && !menu.open) {
      // Escape while the chart is up just puts the chart away.
      if (chart.open || satchel.open) {
        chart.hide();
        satchel.hide();
        audio.setPaused(false);
      } else openMenu();
    }
  });
  let forcedDt = 0;
  let paused = false;
  const frame = () => {
    lastFrame = performance.now();
    if (settleFrames > 0) settleFrames--;
    fitCanvas();
    clock.update();
    const rawDt = forcedDt || Math.min(clock.getDelta(), 1 / 20);
    const dt = paused && !forcedDt ? 1e-6 : rawDt;
    const now = clock.getElapsed();

    const pressed = ePressed;
    ePressed = false;
    if (menu.open || chart.open || satchel.open || film.open) {
      // Frozen world behind the menu: keep drawing it, but nothing moves or happens.
      camera.updateMatrixWorld();
      if (renderer.domElement.clientWidth > 0 && settleFrames < 3) post.pipeline.render();
      return;
    }
    if (state === 'title' || state === 'intro') {
      if (state === 'intro') introT += dt;
      rig.intro(Math.max(0, introT - INTRO_DARK), player, input);
      if (state === 'intro') {
        if (!shot && introT > INTRO_DARK + 2.6) {
          shot = true;
          // The star you watch fall comes down onto the beach in front of you.
          // It streaks across the sky from one side to the other while you lie watching,
          // arcing down toward the beach in front of you where it lands.
          const land = story.firstStarPosition;
          const fwd = land ? land.clone().sub(camera.position).setY(0).normalize() : new THREE.Vector3(0, 0, -1);
          const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
          const from = side.clone().multiplyScalar(-0.75).addScaledVector(fwd, 0.35).add(new THREE.Vector3(0, 1.25, 0)).normalize();
          const to = side.clone().multiplyScalar(0.55).addScaledVector(fwd, 0.85).add(new THREE.Vector3(0, 0.45, 0)).normalize();
          sky.shooting.fire(from, to, 2.2);
          audio.starFall();
          setTimeout(() => story.landFirstStar(), 1500);
        }
        if (!titleShown && introT > INTRO_DARK + 4) {
          titleShown = true;
          $('title').style.opacity = '1';
        }
        if (introT > INTRO_DARK + 8.5) $('title').style.opacity = '0';
        if (introT >= INTRO_END) {
          state = 'play';
          $('title').style.opacity = '0';
          story.beginPlay();
          // The little light rises out of the surf beside you.
          wisp.wake(new THREE.Vector3(player.x + 1.5, Math.max(hf.height(player.x, player.z), 0) - 0.3, player.z + 1.5));
          setTimeout(() => story.guide("Hey! You're awake!", 'hey'), 1200);
          setTimeout(() => story.guide("Listen! Stars fell all along this shore. Let's find them.", 'listen'), 6500);
          playStarted = performance.now();
          story.narrative.say('WASD walk  ·  mouse look  ·  shift run  ·  space jump  ·  E use  ·  F ask the light', 'hint', 8);
          story.narrative.say('Esc  ·  menu and settings', 'hint', 4);
          story.narrative.say(LINES.stakes);
        }
      }
    } else {
      // The story gets first claim on E (gather, read); otherwise it boards or leaves the boat.
      const storyUsed = pressed && story.interact();
      player.update(dt, {
        moveX: story.narrative.reading ? 0 : input.moveX * (creeping() ? 0.45 : 1),
        moveY: story.narrative.reading ? 0 : input.moveY * (creeping() ? 0.45 : 1),
        // Holding C creeps: slow and quiet, for slipping past nightmares.
        sprint: input.down('ShiftLeft', 'ShiftRight') && !creeping(),
        interact: (pressed && !storyUsed) || (input.down('KeyE') && !story.currentPrompt),
        jump: input.down('Space'),
        cameraYaw: input.yaw,
      });
      rig.follow(dt, player, input, avatar.boat);
      // At sea the glitter on the water gathers into a path toward the next fallen star.
      sparkles.guideTo(player.mode === 'boat' ? camera.position : null, player.mode === 'boat' ? story.guideTarget(player) : null, dt);
      if (player.mode === 'boat') {
        if (!strokeHinted) {
          strokeHinted = true;
          story.guide('Hey! Press Space as the oars dip, for a long stroke!', 'hey');
        }
        if (!currentHinted && player.boat.current > 0.4) {
          currentHinted = true;
          story.guide('Oh! A current of starlight. Let it carry you!', 'oh');
        }
      }
      if (player.mode === 'boat' && player.boat.rowing) {
        const st = player.boat.stroke;
        if (lastStroke < 0.05 && st >= 0.05) audio.oarDip();
        if (lastStroke < 0.55 && st >= 0.55) audio.oarDrip();
        lastStroke = st;
      }
    }
    story.update(dt, player, camera, state === 'play');
    // Frost shows in the last part of the night, and whenever she's growing cold.
    post.frost.value += (Math.max(0, (frostTarget - 0.55) / 0.45, cold) - post.frost.value) * Math.min(1, dt * 0.8);
    const memTarget = performance.now() / 1000 < memoryUntil ? 1 : 0;
    post.memoryMix.value += (memTarget - post.memoryMix.value) * Math.min(1, dt * (memTarget ? 1.2 : 0.7));
    const here = hf.sample(player.x, player.z);
    for (const [k, u] of Object.entries(regionMotes)) {
      const w = here[k as keyof typeof regionMotes] * (k === 'drowned' ? 1.5 : 1);
      u.value += (THREE.MathUtils.smoothstep(w, 0.2, 0.6) - u.value) * Math.min(1, dt * 0.5);
    }
    grade.set(story.chapterAt(player));
    grade.update(dt);
    const mix = { ...story.audioMix(player), dread: nightmares.dread, falls: waterfalls.loudness(camera.position), storm: squalls.intensity };
    audio.update(mix);
    // Score follows where you are; the opening theme carries the first half-minute of play.
    const area =
      state !== 'play' || performance.now() - playStarted < 35000
        ? 'opening'
        : player.mode === 'boat'
          ? mix.sea > 0.95 && hf.height(player.x, player.z) < -15
            ? 'deep'
            : 'sea'
          : mix.jungle > 0.45
            ? 'jungle'
            : 'shore';
    audio.music.update(dt, area);
    const promptEl = $('prompt');
    const prompt = story.currentPrompt || player.prompt;
    promptEl.textContent = prompt;
    promptEl.style.opacity = prompt && state === 'play' ? '1' : '0';

    avatar.update(dt, player, camera);
    held.update(dt, camera, state === 'play' ? story.held : null, story.held === 'compass' ? story.compassTarget(player.x, player.z) : null, player.mode === 'walk' ? player.speed : 0);
    const owned = KEEPSAKES.filter((k) => story.hasKeepsake(k.id)).map((k) => k.id);
    hotbar.visible = state === 'play' && owned.length > 0;
    gauge.visible = state === 'play' && surviving();
    gauge.update(story.light.value, story.light.cap, gathering, story.light.ready);
    hotbar.update(owned, story.held, story.fresh);
    sky.shooting.update(dt, camera);
    focus.copy(camera.position);
    terrain.update(focus);
    flora.update(focus, now);
    if (player.mode === 'walk') flora.walker.value.set(player.x, player.y, player.z);
    else flora.walker.value.set(1e6, 0, 1e6);
    beams.update(dt, focus);
    landmarks.update(focus, dt);
    wildlife.update(dt, focus, camera, player.mode === 'boat' || story.audioMix(player).sea > 0.55);
    fauna.update(dt, focus, player.mode === 'walk' ? player.speed : 0);
    wonders.update(dt, focus);
    waterfalls.update(dt, focus);
    sky.blaze.value += ((story.allLit ? 1 : 0) - sky.blaze.value) * Math.min(1, dt * 0.3);
    if (state === 'play') {
      const lights: LightSource[] = [];
      landmarks.beacons.forEach((b, i) => landmarks.isLit(i) && lights.push({ x: b.placed.x, z: b.placed.z, r: 55 }));
      for (const p of landmarks.placed)
        if (p.type === 'StoneLantern' || p.type === 'Hut' || p.type === 'Cairn') lights.push({ x: p.x, z: p.z, r: p.type === 'Hut' ? 12 : 8 });
      for (const p of puzzleSites) if (story.hasSeen(p.id)) lights.push({ x: p.reward?.x ?? p.x, z: p.reward?.z ?? p.z, r: 16 });
      story.light.update(dt);
      updateWeather(dt);
      // Dark Water creeps in as the night wears on; restored regions hold it back.
      darkReachNow = settings.nights ? darkReach(story.night.progress, settings.survival) : Infinity;
      refugesNow = story.refuges();
      setDarkWater(darkReachNow, refugesNow, settings.nights ? THREE.MathUtils.smoothstep(story.night.progress, 0.2, 0.95) * (1 - story.restoredShare * 0.8) : 0);
      if (surviving()) surviveFrame(dt, lights);
      else cold = 0;
      // The paper lantern: a small circle of light that goes where you go.
      // Held up, the lantern's light reaches twice as far; spread wide, the wings sink half as fast.
      if (story.hasKeepsake('lantern')) lights.push({ x: player.x, z: player.z, r: held.raised === 'lantern' ? 12 : 6 });
      player.canGlide = story.hasKeepsake('wings');
      player.glideSink = held.raised === 'wings' ? 0.9 : 1.6;
      // Gliding, the squall carries you: harder to land where you aimed, or a lift if it's behind you.
      if (player.mode === 'walk' && player.canGlide && input.down('Space') && Math.abs(player.vy + player.glideSink) < 0.05 && squalls.intensity > 0.05) {
        const w = squalls.wind;
        player.x += w.x * 2.2 * dt;
        player.z += w.z * 2.2 * dt;
      }
      const threat = settings.nights ? Math.min(1, Math.max(0, (story.night.progress - 0.45) / 0.4)) : 0;
      const sense = senses();
      nightmares.update(dt, camera.position, player.mode === 'walk' ? player.speed : 0, player.mode === 'boat' ? 0 : threat, lights, sense);
      noiseBurst = Math.max(0, noiseBurst - dt * 32);
      // Hidden: in the dark, low and quiet, the edges of the view close in a little.
      const hidden = nightmares.live.length > 0 && sense.visibility < 0.3 && sense.noise < 4 ? 1 : 0;
      hiddenVeil.style.opacity = String(hidden * (nightmares.brain.hunted ? 0.5 : 0.85));
      if (hidden && !hiddenSaid && !nightmares.brain.hunted) {
        hiddenSaid = true;
        story.guide("Shh. Down here in the dark they can't see us. Keep low and quiet.", 'hmm');
      }
    }
    flareFlash = Math.max(0, flareFlash - dt * 2.5);
    post.nightmare.value += (Math.max(nightmares.dread, 0) * (1 - flareFlash) - post.nightmare.value) * Math.min(1, dt * 2);
    if (state === 'play') chart.reveal(player.x, player.z, dt);
    water.update(focus);
    camera.updateMatrixWorld();
    // A hidden or collapsed canvas has zero size; rendering then invalidates every target.
    // Skip the resize frame itself: post targets are reallocated and briefly invalid.
    if (renderer.domElement.clientWidth > 0 && renderer.domElement.clientHeight > 0 && settleFrames < 3) post.pipeline.render();

    frames++;
    fpsT += dt;
    if (debug && fpsT > 0.5) {
      const info = renderer.info;
      statsEl.textContent = `${Math.round(frames / fpsT)} fps  res ${(dynRes.scale * 100).toFixed(0)}%  draws ${info.render.drawCalls}  tris ${(info.render.triangles / 1e6).toFixed(2)}M  jobs ${pool.busy}  terrain ${(terrain.loadedRatio * 100).toFixed(0)}%  pos ${player.x.toFixed(0)},${player.z.toFixed(0)}`;
      frames = 0;
      fpsT = 0;
    }
  };
  // Capped: a 120Hz display would otherwise render twice as many frames for no visible gain.
  // Unfocused windows drop to a trickle so the game doesn't heat the machine in the background.
  renderer.setAnimationLoop((t: number) => {
    const cap = !document.hasFocus() ? 8 : menu.open || chart.open || satchel.open || film.open ? 30 : QUALITY.fps;
    if (t - lastRender < 1000 / cap - 2) return;
    // Only judge the GPU while playing at the full frame rate (menus and background run capped).
    if (cap === QUALITY.fps && state === 'play' && lastRender > 0 && dynRes.update(t - lastRender, 1000 / cap, t)) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, RENDER.maxPixelRatio) * dynRes.scale);
      renderer.setSize(innerWidth, innerHeight);
      settleFrames = 3;
    }
    lastRender = t;
    frame();
  });
  if (debug) {
    // Deterministic stepping for tests: advance game time regardless of display throttling.
    (window as unknown as { lapis: Record<string, unknown> }).lapis.advance = (seconds: number, step = 1 / 60) => {
      forcedDt = step;
      for (let t = 0; t < seconds; t += step) frame();
      forcedDt = 0;
    };
    (window as unknown as { lapis: Record<string, unknown> }).lapis.pause = (on: boolean) => (paused = on);
  }
  // Debug only: hidden or occluded windows stop getting animation frames; keep ticking so
  // tooling can still watch the game.
  if (debug) setInterval(() => performance.now() - lastFrame > 120 && frame(), 33);
}

boot().catch((err) => {
  console.error(err);
  const el = $('error');
  el.style.display = 'flex';
  el.textContent = `Lapis failed to start: ${err?.message ?? err}`;
});
