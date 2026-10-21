// Records reference traces from the TypeScript PlayerController and NightClock (copied verbatim
// from git HEAD into ./ts/) for the C# parity test in sbox/Lapis.Parity.
//   node --experimental-transform-types --no-warnings tools/parity/trace.ts
// Inputs are written alongside state, so the C# side replays exactly what was fed here even
// where a scenario steers closed-loop off the player's position.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlayerController, type PlayerEvent, type PlayerInput } from './ts/player.ts';
import { NightClock, type NightCue } from './ts/night.ts';
import { LightStore, RestReturns, Sources, TUNING, Warmth, type Exposure } from './ts/survival.ts';
import { darkAt, darkReach, type Refuge } from './ts/darkWater.ts';
import { SquallClock } from './ts/squalls.ts';
import { colliders, platforms, TOWER, world } from './world.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../sbox/parity');
const DT = 1 / 60;

interface Setup {
  /** x, z, heading, and optionally the level on stacked surfaces. */
  place: [number, number, number] | [number, number, number, number];
  boat: [number, number, number];
  canGlide?: boolean;
}

type Driver = (p: PlayerController, step: number, t: number) => Partial<PlayerInput>;

/** Camera yaw that makes "forward" (moveY = 1) point along (dx, dz). */
const yawToward = (dx: number, dz: number) => Math.atan2(-dx, -dz);

function run(name: string, setup: Setup, seconds: number, drive: Driver) {
  const p = new PlayerController(world);
  p.colliders = colliders;
  p.platforms = platforms;
  p.canGlide = setup.canGlide ?? false;
  p.placeBoat(...setup.boat);
  p.place(...setup.place);
  let events: PlayerEvent[] = [];
  p.onEvent = (e) => events.push(e);
  const steps = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const input: PlayerInput = { moveX: 0, moveY: 0, sprint: false, interact: false, jump: false, cameraYaw: 0, dive: false, ...drive(p, i, i * DT) };
    events = [];
    p.update(DT, input);
    const b = p.boat;
    steps.push({
      in: input,
      x: p.x, y: p.y, z: p.z, heading: p.heading, speed: p.speed, vy: p.vy,
      mode: p.mode, airborne: p.airborne, falling: p.falling, anim: p.anim, animRate: p.animRate, prompt: p.prompt, breath: p.breath,
      boat: { x: b.x, z: b.z, heading: b.heading, speed: b.speed, stroke: b.stroke, rowing: b.rowing, bob: b.bob, current: b.current },
      events,
    });
  }
  const all = steps.flatMap((s) => s.events);
  writeFileSync(join(OUT, `player-${name}.json`), JSON.stringify({ name, dt: DT, setup: { canGlide: false, ...setup }, steps }));
  const last = steps[steps.length - 1];
  console.log(`${name.padEnd(16)} ${n} steps  end (${last.x.toFixed(2)}, ${last.y.toFixed(2)}, ${last.z.toFixed(2)}) ${last.mode}  events: ${all.join(',') || '-'}`);
}

mkdirSync(OUT, { recursive: true });
const farBoat: [number, number, number] = [60, -60, 0];

// Flat-ish walk: turns, sprint, strafe, and brushing a tree trunk at (5, 8).
run('walk_sprint', { place: [0, 3, 0], boat: farBoat }, 8, (_p, _i, t) => {
  if (t < 2) return { moveY: 1, cameraYaw: yawToward(1, 1) };
  if (t < 4) return { moveY: 1, sprint: true, cameraYaw: yawToward(1, 1) + (t - 2) * 0.6 };
  if (t < 5.5) return { moveX: -1, moveY: 0.4, cameraYaw: 1.2 };
  if (t < 6.5) return { moveX: 0.05, moveY: 0.05 }; // inside the dead zone
  return { moveY: -0.7, moveX: 0.7, cameraYaw: 2.5 };
});

// Run at the ledge, fail to step onto it, then jump onto it, a standing hop, and walk off the far side.
run('jump_ledge', { place: [-8, 2, 0], boat: farBoat }, 6, (p, _i, t) => {
  const yaw = yawToward(0, 1);
  if (t < 1.2) return { moveY: 1, cameraYaw: yaw };
  if (t < 1.4) return { moveY: 1, cameraYaw: yaw, jump: true };
  if (t < 2.4) return { moveY: 1, cameraYaw: yaw };
  if (t < 3) return {};
  if (t < 3.1) return { jump: true };
  if (t < 3.2) return {};
  return { moveY: 1, sprint: true, cameraYaw: yaw, jump: !p.airborne && t > 4 && t < 4.05 };
});

// Through the tower door, then round and up the spiral stair (treads every 0.25 m, stacked turns).
run('spiral_stair', { place: [-14, 0.4, -Math.PI / 2], boat: farBoat }, 14, (p) => {
  const ox = p.x - TOWER.x;
  const oz = p.z - TOWER.z;
  const r = Math.hypot(ox, oz);
  const phi = Math.atan2(-oz, ox);
  if (r > 1.6 && Math.abs(phi) < 0.5 && p.y < TOWER.y + 0.3) return { moveY: 1, cameraYaw: yawToward(-ox, -oz - 0.05) };
  // Tangent for increasing phi, plus a radial pull to hold r = 1.5.
  const tx = oz / r - (ox / r) * (r - 1.5) * 1.5;
  const tz = -ox / r - (oz / r) * (r - 1.5) * 1.5;
  return { moveY: 1, cameraYaw: yawToward(tx, tz) };
});

// Under the stair: hop until your head bonks the tread above, then shuffle along under lower treads.
const under = { phi: 4.84, r: 1.5 };
run('stair_bonk', { place: [TOWER.x + Math.cos(under.phi) * under.r, TOWER.z - Math.sin(under.phi) * under.r, 0, TOWER.y], boat: farBoat }, 8, (p, _i, t) => {
  const ox = p.x - TOWER.x;
  const oz = p.z - TOWER.z;
  const r = Math.hypot(ox, oz);
  const jump = t % 1 < 0.1;
  if (t < 4) return { jump };
  return { moveY: 1, jump, cameraYaw: yawToward(-oz / r, ox / r) };
});

// Wade out to waist depth, sprint through the shallows, stop at the deep edge, come back.
run('wading', { place: [14, -6, Math.PI / 2], boat: farBoat }, 8, (_p, _i, t) => {
  if (t < 3) return { moveY: 1, cameraYaw: yawToward(1, 0) };
  if (t < 5) return { moveY: 1, sprint: true, cameraYaw: yawToward(1, 0.15) };
  if (t < 5.5) return {};
  return { moveY: 1, cameraYaw: yawToward(-1, 0) };
});

// Run off the shore and jump into deep water: fall, sink, wake on the last safe ground.
run('deep_water', { place: [15, 12, Math.PI / 2], boat: farBoat }, 6, (p, _i, t) => {
  const yaw = yawToward(1, 0);
  if (t < 3.5) {
    const ahead = world.height(p.x + 0.8, p.z);
    return { moveY: 1, sprint: true, cameraYaw: yaw, jump: !p.airborne && ahead < -0.7 };
  }
  return {};
});

// Swim: wade off the shelf, swim out, dive to the bottom and stay down, come back up, swim home
// and wade out onto the shore.
run('swim_dive', { place: [15, 12, Math.PI / 2], boat: farBoat }, 26, (p, _i, t) => {
  const out = yawToward(1, 0);
  const home = yawToward(-1, 0);
  if (t < 5) return { moveY: 1, cameraYaw: out };
  if (t < 9) return { moveY: 0.4, cameraYaw: out, dive: true };
  if (t < 14) return { dive: true };
  if (t < 16) return { jump: true };
  return { moveY: 1, sprint: t < 20, cameraYaw: home };
});

// Moth wings: hop off the tall pillar and hold jump to glide down.
run('glide', { place: [-4, 19.5, Math.PI], boat: farBoat, canGlide: true }, 7, (_p, _i, t) => {
  const yaw = yawToward(0, -1);
  if (t < 0.3) return { moveY: 1, cameraYaw: yaw };
  if (t < 3.5) return { moveY: 1, cameraYaw: yaw, jump: true };
  if (t < 4) return { moveY: 1, cameraYaw: yaw }; // release: free fall
  return { moveY: 1, cameraYaw: yaw, jump: true };
});

// Board, row out with timed and mistimed power strokes, ride the current north, past the rock, row back and step ashore.
run('boat_row', { place: [19.3, 0, Math.PI / 2], boat: [22.5, 0, Math.PI / 2] }, 40, (p, i, t) => {
  if (t < 0.2) return {};
  if (t < 0.3) return { interact: true };
  if (t < 0.5) return {};
  const b = p.boat;
  const onCatch = b.stroke > 0.88 || b.stroke < 0.12;
  if (t < 10) return { moveY: 1, jump: onCatch && i % 3 === 0 };
  if (t < 14) return { moveY: 1, moveX: t < 12 ? 0.6 : 0, sprint: true, jump: (i % 40) < 2 }; // mistimed
  if (t < 22) return { moveY: 0.3 }; // drift with the current
  if (t < 24) return {};
  if (p.mode === 'walk') return {};
  // Head back west to shore and coast in.
  let diff = -Math.PI / 2 - b.heading;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const nearShore = b.x < 23;
  if (p.prompt === 'E   step ashore') return { interact: i % 2 === 0 };
  return { moveY: nearShore ? 0 : 1, moveX: Math.max(-1, Math.min(1, -diff * 2)), jump: onCatch && i % 4 === 0 };
});

// Row into a rock: the hull bumps off it, then steer round it.
run('boat_rock', { place: [19.3, -10, Math.PI / 2], boat: [22.5, -10, Math.PI / 2] }, 14, (_p, _i, t) => {
  if (t < 0.2) return {};
  if (t < 0.3) return { interact: true };
  if (t < 0.5) return {};
  if (t < 7) return { moveY: 1 };
  if (t < 9) return { moveY: -0.5, moveX: -1 };
  return { moveY: 1, moveX: t < 10 ? 0.4 : 0 };
});

// Board and step straight back out, walk the shore 40 m away, then hold E to call the boat.
run('call_boat', { place: [18.5, 0, Math.PI / 2], boat: [21, 0, Math.PI / 2] }, 22, (p, _i, t) => {
  if (t < 0.2) return {};
  if (t < 0.3) return { interact: true };
  if (t < 0.6) return {};
  if (t < 0.7) return { interact: true };
  if (t < 1) return {};
  if (t < 10) return { moveY: 1, sprint: true, cameraYaw: yawToward(0.02, -1) };
  if (t < 11) return {};
  if (t < 12.5) return { interact: true };
  if (t < 13) return {};
  return { moveY: p.mode === 'walk' && t > 18 ? 1 : 0, cameraYaw: yawToward(1, 0), interact: t > 20 && t < 20.1 };
});

// Night clock: an uneven frame rate, a reset at a lighthouse, a partial rest, then a full night to waking.
{
  const night = new NightClock(15);
  let cues: NightCue[] = [];
  night.onCue = (c) => cues.push(c);
  const steps = [];
  for (let i = 0; i < 2400; i++) {
    const dt = 1 / 60 + 0.01 * Math.sin(i * 0.37);
    cues = [];
    if (i === 800) night.reset();
    // A partial rest late in the night: cues already passed come round again.
    const rewind = i === 1500 ? 0.6 : 0;
    if (rewind) night.rewind(rewind);
    night.update(dt);
    steps.push({ dt, reset: i === 800, rewind, progress: night.progress, phrase: night.phrase, cues });
  }
  writeFileSync(join(OUT, 'night.json'), JSON.stringify({ name: 'night', length: 15, steps }));
  console.log(`night            ${steps.length} steps  cues: ${steps.flatMap((s) => s.cues).join(',')}`);
}

// Survival: warmth through dark, water, wind and light; a light store gathering and flaring; rests
// with diminishing returns; a glowing source drawn dry and regrowing. Both modes.
for (const mode of ['survival', 'story'] as const) {
  const t = TUNING[mode];
  const warmth = new Warmth();
  const light = new LightStore(t.wispCap);
  const rests = new RestReturns();
  const sources = new Sources();
  const steps = [];
  let now = 0;
  for (let i = 0; i < 3000; i++) {
    const dt = 1 / 30 + 0.008 * Math.sin(i * 0.41);
    now += dt;
    const e: Exposure = {
      lit: i % 700 < 500 ? 0 : 0.8,
      inWater: i % 900 > 700,
      wind: 0.5 + 0.5 * Math.sin(i * 0.01),
      night: (i / 3000) % 1,
      dark: 0.5 + 0.5 * Math.sin(i * 0.013),
      rain: 0.5 + 0.5 * Math.cos(i * 0.007),
      glow: i % 1100 < 400 ? 0.7 : 0,
      submerged: i % 600 > 450,
      lagoon: i % 1500 > 1440,
    };
    const collapsed = warmth.update(dt, e, t);
    if (collapsed) warmth.reset();
    light.update(dt);
    if (i === 1200) light.cap = t.lanternCap;
    const flare = i % 400 === 0 ? light.flare(t) : false;
    const drawn = i % 300 < 150 ? sources.draw(12.5, -3, now, dt, t.drawRate) : 0;
    light.gain(drawn + t.moteRate * dt * 0.5);
    const rest = i % 500 === 0 ? rests.restAt(i % 1500 === 0 ? 2 : 1) : 0;
    if (i === 2500) rests.clear();
    steps.push({
      dt, lit: e.lit, inWater: e.inWater, wind: e.wind, night: e.night, dark: e.dark, rain: e.rain, glow: e.glow, submerged: e.submerged, lagoon: e.lagoon,
      warmth: warmth.value, collapsed, light: light.value, cap: light.cap, ready: light.ready, flare,
      drawn, left: sources.left(12.5, -3, now), rest, streak: rests.streak,
    });
  }
  writeFileSync(join(OUT, `survival-${mode}.json`), JSON.stringify({ name: `survival-${mode}`, mode, steps }));
  console.log(`survival-${mode.padEnd(8)} ${steps.length} steps  collapses: ${steps.filter((s) => s.collapsed).length}  flares: ${steps.filter((s) => s.flare).length}`);
}

// Dark Water: its reach through the night in each mode, and the field across a line of the sea
// with two refuges holding it back.
{
  const refuges: Refuge[] = [{ x: 2600, z: 400, r: 900 }, { x: -1800, z: 2900, r: 600 }];
  const steps = [];
  for (let i = 0; i <= 400; i++) {
    const night = i / 400;
    const mode = i % 2 ? 'story' : 'survival';
    const reach = darkReach(night, mode);
    const x = -6000 + i * 30;
    const z = 2000 * Math.sin(i * 0.05);
    steps.push({ night, mode, reach, x, z, dark: darkAt(x, z, reach, refuges), wander: darkReach(night, 'wander') });
  }
  writeFileSync(join(OUT, 'darkwater.json'), JSON.stringify({ name: 'darkwater', refuges, steps }));
  console.log(`darkwater        ${steps.length} steps`);
}

// Squalls: a long run at a rising pressure, with a spell of wandering (disabled) in the middle.
{
  const sq = new SquallClock(4242);
  const steps = [];
  for (let i = 0; i < 24000; i++) {
    const dt = 1 / 20 + 0.01 * Math.sin(i * 0.29);
    const pressure = Math.min(1, i / 18000);
    const enabled = !(i > 9000 && i < 10200);
    const entered = sq.update(dt, pressure, enabled);
    if (i % 4 === 0 || entered) steps.push({ i, dt, pressure, enabled, entered, phase: sq.phase, intensity: sq.intensity, angle: sq.windAngle });
    else steps.push({ i, dt, pressure, enabled });
  }
  writeFileSync(join(OUT, 'squalls.json'), JSON.stringify({ name: 'squalls', seed: 4242, steps }));
  console.log(`squalls          ${steps.length} steps  squalls: ${steps.filter((s) => s.entered === 'building').length}`);
}
