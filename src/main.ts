import * as THREE from 'three/webgpu';
import { PALETTE, RENDER, SKY } from './config';
import { createHeightfield, findSpawn } from './world/heightfield';
import { Terrain, WorkerPool } from './world/terrain';
import { createReflectionProxy, createTerrainMaterial } from './world/terrainMaterial';
import { createWater } from './world/water';
import { createSky } from './world/sky';
import { createSparkles } from './world/sparkles';
import { createMotes } from './world/motes';
import { Flora } from './world/flora';
import { createPost } from './render/post';
import { PlayerController } from './game/player';
import { Input } from './game/input';
import { Avatar } from './game/avatar';
import { CameraRig } from './game/cameraRig';
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
  const pool = new WorkerPool(Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2)));

  const water = createWater();
  const proxy = createReflectionProxy();
  const terrain = new Terrain(pool, createTerrainMaterial(proxy.node), SEED);
  const sky = createSky();
  const sparkles = createSparkles();
  const motes = createMotes();
  const flora = new Flora(pool, SEED);
  const avatar = new Avatar();
  // First person: the Keeper's body is never added to the scene.
  scene.add(sky.group, terrain.group, water.mesh, water.target, sparkles.group, flora.group, avatar.boat, motes);

  const spawn = findSpawn(hf);
  const layout = layoutPrologue(hf, spawn);
  const player = new PlayerController(hf);
  player.colliders = flora;
  player.place(spawn.x, spawn.z, Math.PI);
  player.placeBoat(layout.boat.x, layout.boat.z, layout.boat.heading);

  const audio = new Audio();
  const story = new Story(layout, hf, flora, sky.shooting, audio);
  scene.add(story.group);

  // Reflection pass rules: the Keeper casts no reflection (twist clue #1), sparkles stay out
  // of the mirror, and terrain must not sample the render target it is being drawn into.
  // The reflector reallocates its target on resize mid-frame; keep terrain off it briefly.
  let settleFrames = 0;
  scene.onBeforeRender = (_r, _s, cam) => {
    const mirror = cam !== camera;
    sparkles.group.visible = !mirror;
    motes.visible = !mirror;
    flora.setMirror(mirror);
    proxy.node.value = mirror || settleFrames > 0 ? proxy.dummy : water.reflection.value;
  };
  scene.onAfterRender = (_r, _s, cam) => {
    if (cam !== camera) {
      sparkles.group.visible = true;
      motes.visible = true;
      flora.setMirror(false);
      proxy.node.value = settleFrames > 0 ? proxy.dummy : water.reflection.value;
    }
  };

  const input = new Input(renderer.domElement);
  const rig = new CameraRig(camera, hf);
  const post = createPost(renderer, scene, camera);

  await Promise.all([
    avatar.load('/models/keeper.glb', '/models/boat.glb').then(() => avatar.keeperGltf && story.loadFigure(avatar.keeperGltf)),
    flora.load('/models/flora.glb').then((types) => debug && console.log('flora types', types)),
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
  input.onFirstGesture = () => {
    if (state !== 'title') return;
    state = 'intro';
    audio.start().catch((e) => console.warn('audio failed', e));
    $('hint').style.opacity = '0';
    $('title').style.opacity = '0';
    fade.style.transitionDuration = '0.8s';
    fade.style.opacity = '1';
    setTimeout(() => STORYBOOK.forEach((line) => story.narrative.say(line, 'whisper')), 1200);
  };
  const skipIntro = () => {
    INTRO_DARK = Math.min(INTRO_DARK, introT);
    INTRO_END = INTRO_DARK + WAKE_LEN;
    introT = INTRO_END;
    fade.style.opacity = '0';
  };
  let ePressed = false;
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && state === 'intro') skipIntro();
    if (e.code === 'KeyE' && !e.repeat) ePressed = true;
  });
  rig.onStep = (speed) => {
    const h = hf.height(player.x, player.z);
    const s = hf.sample(player.x, player.z);
    const surface = h < -0.05 ? 'water' : h < 0.75 ? 'wet' : h < 2.8 && s.grove < 0.3 ? 'sand' : 'jungle';
    audio.step(surface, speed);
  };
  let lastStroke = 0;

  if (debug) {
    // Console handle for art direction: lapis.view(x, z, yaw, pitch), lapis.player, etc.
    Object.assign(window, {
      lapis: {
        player, input, camera, hf, post, flora, sparkles, story, layout, audio,
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

  renderer.setAnimationLoop(() => {
    if (settleFrames > 0) settleFrames--;
    fitCanvas();
    clock.update();
    const dt = Math.min(clock.getDelta(), 1 / 20);
    const now = clock.getElapsed();

    const pressed = ePressed;
    ePressed = false;
    if (state === 'title' || state === 'intro') {
      if (state === 'intro') introT += dt;
      rig.intro(Math.max(0, introT - INTRO_DARK), player, input);
      if (state === 'intro') {
        if (INTRO_DARK > 900 && introT > 3 && !story.narrative.busy) {
          INTRO_DARK = introT + 0.8;
          INTRO_END = INTRO_DARK + WAKE_LEN;
          setTimeout(() => {
            fade.style.transitionDuration = '2.5s';
            fade.style.opacity = '0';
          }, 600);
        }
        if (!shot && introT > INTRO_DARK + 2.6) {
          shot = true;
          sky.shooting.fire(new THREE.Vector3(-0.55, 0.85, -0.6), new THREE.Vector3(0.25, 0.08, -1));
          audio.starFall();
        }
        if (!titleShown && introT > INTRO_DARK + 4) {
          titleShown = true;
          $('title').style.opacity = '1';
        }
        if (introT > INTRO_DARK + 8.5) $('title').style.opacity = '0';
        if (introT >= INTRO_END) {
          state = 'play';
          $('title').style.opacity = '0';
          story.narrative.say('WASD  walk      mouse  look      shift  run      E  use', 'hint', 7);
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
        interact: pressed && !storyUsed,
        cameraYaw: input.yaw,
      });
      rig.follow(dt, player, input, avatar.boat);
      if (player.mode === 'boat' && player.boat.rowing) {
        const st = player.boat.stroke;
        if (lastStroke < 0.05 && st >= 0.05) audio.oarDip();
        if (lastStroke < 0.55 && st >= 0.55) audio.oarDrip();
        lastStroke = st;
      }
    }
    story.update(dt, player, camera, state === 'play');
    audio.update(story.audioMix(player));
    const promptEl = $('prompt');
    const prompt = story.currentPrompt || player.prompt;
    promptEl.textContent = prompt;
    promptEl.style.opacity = prompt && state === 'play' ? '1' : '0';

    avatar.update(dt, player, camera);
    sky.shooting.update(dt);
    focus.copy(camera.position);
    terrain.update(focus);
    flora.update(focus, now);
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
  });
}

boot().catch((err) => {
  console.error(err);
  const el = $('error');
  el.style.display = 'flex';
  el.textContent = `Lapis failed to start: ${err?.message ?? err}`;
});
