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
  const player = new PlayerController(hf);
  player.colliders = flora;
  player.place(spawn.x, spawn.z, Math.PI);
  // Beach the boat in the shallows just seaward of where the Keeper wakes.
  let bz = spawn.z;
  while (hf.height(spawn.x + 4, bz) > -0.7 && bz < spawn.z + 80) bz += 0.5;
  player.placeBoat(spawn.x + 4, bz + 1.5, Math.PI * 0.5);

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
    avatar.load('/models/keeper.glb', '/models/boat.glb'),
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

  let state: 'title' | 'intro' | 'play' = debug && location.hash === '#play' ? 'play' : 'title';
  let introT = 0;
  let shot = false;
  // Wake facing north: the bright one is the first thing you see when you sit up.
  input.yaw = 0;
  input.pitch = -0.04;
  input.onFirstGesture = () => {
    if (state === 'title') {
      state = 'intro';
      $('hint').style.opacity = '0';
    }
  };
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && state === 'intro') introT = Math.max(introT, 14);
  });

  if (debug) {
    // Console handle for art direction: lapis.view(x, z, yaw, pitch), lapis.player, etc.
    Object.assign(window, {
      lapis: {
        player, input, camera, hf, post, flora, sparkles,
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

    if (state === 'title' || state === 'intro') {
      if (state === 'intro') introT += dt;
      rig.intro(introT, player, input);
      if (state === 'intro' && !shot && introT > 2.6) {
        shot = true;
        sky.shooting.fire(new THREE.Vector3(-0.55, 0.85, -0.6), new THREE.Vector3(0.25, 0.08, -1));
      }
      if (introT > 6.5) $('title').style.opacity = '0';
      if (introT > 13.5) {
        state = 'play';
        $('hint').textContent = 'WASD  walk     mouse  look     shift  run     E  boat';
        $('hint').style.opacity = '1';
        setTimeout(() => ($('hint').style.opacity = '0'), 9000);
      }
    } else {
      $('title').style.opacity = '0';
      player.update(dt, {
        moveX: input.moveX,
        moveY: input.moveY,
        sprint: input.down('ShiftLeft', 'ShiftRight'),
        interact: input.down('KeyE'),
        cameraYaw: input.yaw,
      });
      rig.follow(dt, player, input, avatar.boat);
    }
    const promptEl = $('prompt');
    promptEl.textContent = player.prompt;
    promptEl.style.opacity = player.prompt && state === 'play' ? '1' : '0';

    avatar.update(dt, player);
    sky.shooting.update(dt);
    focus.copy(camera.position);
    terrain.update(focus);
    flora.update(focus, now);
    water.update(focus);
    camera.updateMatrixWorld();
    // A hidden or collapsed canvas has zero size; rendering then invalidates every target.
    if (renderer.domElement.clientWidth > 0 && renderer.domElement.clientHeight > 0) post.pipeline.render();

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
