import * as THREE from 'three/webgpu';
import { PALETTE, QUALITY, RENDER, SKY, getQualityName, onQualityChange } from './config';
import { settings, onSettingsChange } from './settings';
import { PauseMenu } from './ui/menu';
import { JournalMap } from './ui/map';
import { Satchel } from './ui/satchel';
import { LAGOONS } from './world/heightfield';
import { createHeightfield, findSpawn } from './world/heightfield';
import { Terrain, WorkerPool } from './world/terrain';
import { createReflectionProxy, createTerrainMaterial } from './world/terrainMaterial';
import { createWater } from './world/water';
import { createSky } from './world/sky';
import { createSparkles } from './world/sparkles';
import { createMotes } from './world/motes';
import { Moonbeams } from './world/moonbeams';
import { Landmarks, layoutLandmarks, CompositeColliders } from './world/landmarks';
import { Wildlife } from './world/wildlife';
import { Fauna } from './world/fauna';
import { Wonders, layoutWonders } from './world/wonders';
import { Puzzles, layoutPuzzles } from './world/puzzles';
import { LighthouseClimb } from './world/lighthouseClimb';
import { Nightmares, type LightSource } from './world/nightmares';
import { layoutRegionStars } from './story/placement';
import { Stones, layoutStones } from './world/stones';
import { Currents } from './world/currents';
import { Flora } from './world/flora';
import { createPost } from './render/post';
import { PlayerController } from './game/player';
import { Input } from './game/input';
import { Avatar } from './game/avatar';
import { CameraRig } from './game/cameraRig';
import { Wisp } from './game/wisp';
import { Audio } from './audio/audio';
import { Story } from './story/story';
import { layoutPrologue } from './story/placement';
import { LINES, STORYBOOK } from './story/content';

const SEED = 1337;
const $ = (id: string) => document.getElementById(id)!;
const debug = new URLSearchParams(location.search).has('debug');

async function boot() {
  if (!('gpu' in navigator)) console.warn('WebGPU unavailable; three.js will fall back to WebGL2.');
  const renderer = new THREE.WebGPURenderer({ antialias: false });
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
  const world = { height: (x: number, z: number) => hf.height(x, z), flow: (x: number, z: number) => currents.flow(x, z) };
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
  scene.add(sky.group, terrain.group, water.mesh, water.target, sparkles.group, flora.group, avatar.boat, motes, beams.group);

  const spawn = findSpawn(hf);
  const layout = layoutPrologue(hf, spawn);
  const player = new PlayerController(world);
  const stones = new Stones(layoutStones(hf));
  const landmarks = new Landmarks(layoutLandmarks(hf, spawn));
  const climb = new LighthouseClimb(
    landmarks.placed.filter((p) => p.type === 'Beacon' || p.type === 'Lighthouse').map((p) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale })),
  );
  player.platforms = {
    top: (x, z, y) => Math.max(stones.top(x, z), climb.top(x, z, y)),
    blocksBoat: (x, z, r) => stones.blocksBoat(x, z, r),
    confine: (x, z, y, b) => climb.confine(x, z, y, b),
  };
  const wildlife = new Wildlife(hf);
  const fauna = new Fauna(hf);
  const wonders = new Wonders(layoutWonders(hf));
  const puzzleSites = layoutPuzzles(hf, wonders.list);
  const puzzles = new Puzzles(puzzleSites, (id) => {
    try {
      return (JSON.parse(localStorage.getItem('lapis.save.v1') ?? '{}').seen ?? []).includes(id);
    } catch {
      return false;
    }
  });
  player.colliders = new CompositeColliders([flora, landmarks, fauna, wonders, puzzles]);
  const nightmares = new Nightmares(hf);
  const CLEAR: Record<string, number> = { RuinArch: 4, RuinWall: 4, RuinSteps: 3, Beacon: 14, Lighthouse: 14, Hut: 6, Wreck: 7, Jetty: 4, Swing: 2.5, Cairn: 2, StoneLantern: 1.5 };
  flora.setClearings([
    ...landmarks.placed.map((p) => ({ x: p.x, z: p.z, r: (CLEAR[p.type] ?? 2) * p.scale })),
    // Wonders stand in open ground so they can be seen from the edge of their clearing.
    ...puzzleSites.map((p) => ({ x: p.x, z: p.z, r: p.slot === 0 ? 11 : 16 })),
    ...wonders.list.filter((w) => w.id !== 'rocks').map((w) => ({ x: w.x, z: w.z, r: { whale: 26, ring: 30, moontree: 24, bell: 12 }[w.id] ?? 16 })),
  ]);
  scene.add(landmarks.group, wildlife.group, fauna.group, wonders.group, puzzles.group, nightmares.group, stones.mesh, currents.group);
  player.place(spawn.x, spawn.z, Math.PI);
  player.placeBoat(layout.boat.x, layout.boat.z, layout.boat.heading);

  const audio = new Audio();
  const story = new Story(layout, hf, flora, sky.shooting, audio, layoutRegionStars(hf, wonders.list, puzzleSites), puzzles);
  story.attachWonders(wonders);
  const wisp = new Wisp();
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
    flora.setMirror(mirror);
    proxy.node.value = mirror || settleFrames > 0 ? proxy.dummy : water.reflection.value;
  };
  scene.onAfterRender = (_r, _s, cam) => {
    if (cam !== camera) {
      sparkles.group.visible = true;
      motes.visible = true;
      beams.group.visible = beams.wanted;
      wildlife.setMirror(false);
      fauna.group.visible = true;
      flora.setMirror(false);
      proxy.node.value = settleFrames > 0 ? proxy.dummy : water.reflection.value;
    }
  };

  const input = new Input(renderer.domElement);
  const rig = new CameraRig(camera, hf);
  let post = createPost(renderer, scene, camera);
  let postSteps = QUALITY.strokeSteps;
  let memoryUntil = 0;
  let frostTarget = 0;
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
    avatar.load('/models/keeper.glb', '/models/boat.glb').then(() => {
      if (!avatar.keeperGltf) return;
      story.loadFigure(avatar.keeperGltf);
      story.setupEchoes(avatar.keeperGltf, landmarks);
    }),
    flora.load('/models/flora.glb', '/models/biomes.glb').then((types) => debug && console.log('flora types', types)),
  ]);

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
    if (e.code === 'KeyE' && !e.repeat) ePressed = true;
    if (e.code === 'KeyF' && !e.repeat && state === 'play' && !menu.open && !chart.open) story.askGuide(player);
    if (e.code === 'KeyQ' && !e.repeat && state === 'play' && !menu.open && !chart.open && wisp.awake) {
      if (nightmares.flare(camera.position)) {
        wisp.speak(1.2, 'star');
        flareFlash = 1;
        audio.chime(5);
      }
    }
    if ((e.code === 'KeyI' || e.code === 'Tab') && !e.repeat && state === 'play' && !menu.open && !chart.open) {
      e.preventDefault();
      if (satchel.open) {
        satchel.hide();
        audio.setPaused(false);
      } else {
        satchel.show(story.satchelState());
        audio.setPaused(true);
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
    const surface = h < -0.05 ? 'water' : h < 0.75 ? 'wet' : h < 2.8 && s.grove < 0.3 ? 'sand' : 'jungle';
    audio.step(surface, speed);
  };
  let lastStroke = 0;
  let playStarted = 0;
  player.onEvent = (e) => {
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
    Object.assign(window, {
      lapis: {
        player, input, camera, hf, flora, sparkles, story, layout, audio, landmarks, wildlife, currents, stones, fauna, wonders, nightmares, puzzles, climb,
        get post() {
          return post;
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
    renderer.setPixelRatio(Math.min(devicePixelRatio, RENDER.maxPixelRatio));
    renderer.setSize(innerWidth, innerHeight);
    settleFrames = 3;
    if (QUALITY.strokeSteps !== postSteps) {
      postSteps = QUALITY.strokeSteps;
      (post.pipeline as unknown as { dispose?: () => void }).dispose?.();
      post = createPost(renderer, scene, camera);
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
  let flareFlash = 0;
  nightmares.onCatch = () => story.caught();
  nightmares.onSighted = () => story.nightmaresSighted();
  story.onNewNight = () => nightmares.clear();
  chart.markers = () => [
    ...landmarks.beacons.map((b, i) => ({ kind: landmarks.isLit(i) ? 'beaconLit' : 'beacon', x: b.placed.x, z: b.placed.z }) as const),
    ...LAGOONS.flatMap((L, i) => (story.hasSeen(`lagoon-${i}`) ? [{ kind: 'lagoon' as const, x: L.x, z: L.z, label: 'secret lagoon' }] : [])),
    ...wonders.list.map((w) =>
      story.hasSeen(`wonder-${w.id}`) ? { kind: 'wonder' as const, x: w.x, z: w.z, label: w.name } : { kind: 'mystery' as const, x: w.x, z: w.z },
    ),
    ...puzzleSites.filter((p) => story.hasSeen(p.id)).map((p) => ({ kind: 'lagoon' as const, x: p.x, z: p.z, label: 'lanterns' })),
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
    if (menu.open || chart.open || satchel.open) {
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
        moveX: story.narrative.reading ? 0 : input.moveX,
        moveY: story.narrative.reading ? 0 : input.moveY,
        sprint: input.down('ShiftLeft', 'ShiftRight'),
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
    // Frost only shows in the last part of the night.
    post.frost.value += (Math.max(0, (frostTarget - 0.55) / 0.45) - post.frost.value) * Math.min(1, dt * 0.8);
    const memTarget = performance.now() / 1000 < memoryUntil ? 1 : 0;
    post.memoryMix.value += (memTarget - post.memoryMix.value) * Math.min(1, dt * (memTarget ? 1.2 : 0.7));
    const mix = { ...story.audioMix(player), dread: nightmares.dread };
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
    sky.shooting.update(dt, camera);
    focus.copy(camera.position);
    terrain.update(focus);
    flora.update(focus, now);
    beams.update(dt, focus);
    landmarks.update(focus, dt);
    wildlife.update(dt, focus, camera, player.mode === 'boat' || story.audioMix(player).sea > 0.55);
    fauna.update(dt, focus, player.mode === 'walk' ? player.speed : 0);
    wonders.update(dt, focus);
    if (state === 'play') {
      const lights: LightSource[] = [];
      landmarks.beacons.forEach((b, i) => landmarks.isLit(i) && lights.push({ x: b.placed.x, z: b.placed.z, r: 55 }));
      for (const p of landmarks.placed)
        if (p.type === 'StoneLantern' || p.type === 'Hut' || p.type === 'Cairn') lights.push({ x: p.x, z: p.z, r: p.type === 'Hut' ? 12 : 8 });
      for (const p of puzzleSites) if (story.hasSeen(p.id)) lights.push({ x: p.x, z: p.z, r: 16 });
      // The paper lantern: a small circle of light that goes where you go.
      if (story.hasKeepsake('lantern')) lights.push({ x: player.x, z: player.z, r: 6 });
      player.canGlide = story.hasKeepsake('wings');
      const threat = settings.nights ? Math.min(1, Math.max(0, (story.night.progress - 0.45) / 0.4)) : 0;
      nightmares.update(dt, camera.position, player.mode === 'walk' ? player.speed : 0, player.mode === 'boat' ? 0 : threat, lights);
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
      statsEl.textContent = `${Math.round(frames / fpsT)} fps  draws ${info.render.drawCalls}  tris ${(info.render.triangles / 1e6).toFixed(2)}M  jobs ${pool.busy}  terrain ${(terrain.loadedRatio * 100).toFixed(0)}%  pos ${player.x.toFixed(0)},${player.z.toFixed(0)}`;
      frames = 0;
      fpsT = 0;
    }
  };
  // Capped: a 120Hz display would otherwise render twice as many frames for no visible gain.
  // Unfocused windows drop to a trickle so the game doesn't heat the machine in the background.
  renderer.setAnimationLoop((t: number) => {
    const cap = !document.hasFocus() ? 8 : menu.open || chart.open || satchel.open ? 30 : QUALITY.fps;
    if (t - lastRender < 1000 / cap - 2) return;
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
