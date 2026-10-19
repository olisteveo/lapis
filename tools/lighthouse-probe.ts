// Walks the real player controller into every part of a lighthouse and reports any frame where
// its body is inside solid wall, the newel or the glazing. `npm run probe:lighthouse [runs]`
import { PlayerController, type PlayerInput } from '../src/core/player.ts';
import { LighthouseClimb, solidAt } from '../src/core/lighthouseClimb.ts';

const runs = Number(process.argv[2] ?? 3000);
const TAU = Math.PI * 2;
const BODY = 0.35;
const TOL = 0.12;

let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

interface Leak {
  what: string;
  world: string;
  r: number;
  phi: number;
  h: number;
}

function probe(world: string, height: (x: number, z: number) => number) {
  const tower = { x: 0, y: 0, z: 0, yaw: 0.6, scale: 1 };
  const climb = new LighthouseClimb([tower]);
  const leaks: Leak[] = [];
  for (let run = 0; run < runs; run++) {
    const p = new PlayerController({ height });
    p.platforms = climb;
    p.placeBoat(1000, 1000, 0);
    // Start anywhere standable: ground floor, a tread, the top floor, the gallery or outside.
    const a = rnd() * TAU;
    const r = 0.5 + rnd() * 6;
    const yRef = rnd() < 0.3 ? 0.5 : rnd() * 24;
    p.place(Math.cos(a) * r, -Math.sin(a) * r, rnd() * TAU, yRef);
    if (climb.blocked(p.x, p.z, p.y, BODY)) continue;
    const input: PlayerInput = { moveX: 0, moveY: 1, sprint: false, interact: false, jump: false, cameraYaw: 0 };
    for (let f = 0; f < 60 * 8; f++) {
      if (f % 30 === 0) {
        input.cameraYaw = rnd() * TAU;
        input.moveX = rnd() * 2 - 1;
        input.moveY = rnd() * 2 - 1;
        input.sprint = rnd() < 0.4;
      }
      input.jump = rnd() < 0.03;
      p.update(1 / 60, input);
      const pr = Math.hypot(p.x - tower.x, p.z - tower.z);
      const phi = (((Math.atan2(-(p.z - tower.z), p.x - tower.x) - tower.yaw) % TAU) + TAU) % TAU;
      const what = solidAt(pr, phi, p.y - tower.y, BODY - TOL);
      if (what) {
        leaks.push({ what, world, r: +pr.toFixed(2), phi: +phi.toFixed(2), h: +(p.y - tower.y).toFixed(2) });
        break;
      }
    }
  }
  return leaks;
}

/** The route a player takes: in the door, up the stair, out of the lamp room, once round the gallery. */
function route(world: string, height: (x: number, z: number) => number) {
  const tower = { x: 0, y: 0, z: 0, yaw: 0.6, scale: 1 };
  const climb = new LighthouseClimb([tower]);
  const p = new PlayerController({ height });
  p.platforms = climb;
  p.placeBoat(1000, 1000, 0);
  const at = (r: number, phi: number) => ({ x: Math.cos(phi + tower.yaw) * r, z: -Math.sin(phi + tower.yaw) * r });
  const polar = () => ({ r: Math.hypot(p.x, p.z), phi: (((Math.atan2(-p.z, p.x) - tower.yaw) % TAU) + TAU) % TAU });
  const start = at(6, 0);
  p.place(start.x, start.z, 0);
  const input: PlayerInput = { moveX: 0, moveY: 0, sprint: false, interact: false, jump: false, cameraYaw: 0 };
  const stages: [string, () => { x: number; z: number }, () => boolean][] = [
    ['through the door', () => at(1.2, 0.1), () => polar().r < 1.4],
    ['up the stair', () => at(1.4, polar().phi + 0.5), () => p.y > 21.9],
    ['to the gallery door', () => at(1.2, 4.32), () => polar().r < 1.4 && Math.abs(polar().phi - 4.32) < 0.2],
    ['out on the gallery', () => at(3.4, 4.32), () => polar().r > 3.2],
    ['round the gallery', () => at(3.4, polar().phi + 0.4), () => false],
  ];
  let stage = 0;
  let turned = 0;
  let last = polar().phi;
  for (let f = 0; f < 60 * 240 && stage < stages.length; f++) {
    const [, target, done] = stages[stage];
    if (done()) {
      stage++;
      continue;
    }
    const t = target();
    const l = Math.hypot(t.x - p.x, t.z - p.z) || 1;
    input.moveX = (t.x - p.x) / l;
    input.moveY = -(t.z - p.z) / l;
    p.update(1 / 60, input);
    if (stage === 4) {
      const now = polar().phi;
      turned += ((now - last + Math.PI * 3) % TAU) - Math.PI;
      last = now;
      if (Math.abs(p.y - 22) > 0.1) return `${world}: fell off the gallery at r ${polar().r.toFixed(2)}`;
      if (turned > TAU) return '';
    } else last = polar().phi;
  }
  return `${world}: stuck ${stages[stage]?.[0] ?? ''} at r ${polar().r.toFixed(2)} phi ${polar().phi.toFixed(2)} h ${p.y.toFixed(2)}`;
}

const routes = [route('flat', () => 0.3), route('slope', (x, z) => 0.3 + 0.12 * x + 0.05 * z)].filter(Boolean);
for (const r of routes) console.log(r);

const all = [
  ...probe('flat', () => 0.3),
  ...probe('slope', (x, z) => 0.3 + 0.12 * x + 0.05 * z),
];
const byKind = new Map<string, Leak[]>();
for (const l of all) byKind.set(`${l.world} ${l.what}`, [...(byKind.get(`${l.world} ${l.what}`) ?? []), l]);
for (const [k, ls] of byKind) console.log(`${k}: ${ls.length}`, ls.slice(0, 4).map((l) => `r${l.r} phi${l.phi} h${l.h}`).join('  '));
console.log(all.length ? `${all.length} leaks in ${runs * 2} runs` : `no leaks in ${runs * 2} runs`);
console.log(routes.length ? 'route blocked' : 'route clear: door, stair, gallery door, round the gallery');
process.exit(all.length || routes.length ? 1 : 0);
