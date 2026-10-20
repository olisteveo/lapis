// Headless checks for the survival rules (docs/SURVIVAL.md): stealth, packs, warmth timings and
// squall rhythm. Run with `npm run check:survival`; exits non-zero when a rule drifts out of range,
// so retuning can't silently make the night unfair or toothless.
import { NightmareBrain, type Senses } from '../src/core/nightmareBrain.ts';
import { TUNING, Warmth, type Exposure } from '../src/core/survival.ts';
import { SquallClock } from '../src/core/squalls.ts';
import { darkAt, darkReach } from '../src/core/darkWater.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} ${detail}`);
  if (!ok) failed++;
};

// ---- Stealth and packs, on flat ground with no lights.
const flat = () => 5;
function run(threat: number, senses: (t: number) => Senses, move: (t: number, p: { x: number; z: number }) => void, secs = 160) {
  const b = new NightmareBrain(flat);
  const p = { x: 0, z: 0 };
  let alerted = 0;
  let caught = 0;
  for (let i = 0; i < secs * 30; i++) {
    move(i / 30, p);
    const ev = b.update(1 / 30, p, 1, threat, [], true, senses(i / 30));
    alerted += ev.alerted;
    caught += ev.caught.length;
  }
  return { alerted, caught };
}
const LOUD = { noise: 26, visibility: 0.6 };
const sprint = run(0.5, () => LOUD, () => {});
check('sprinting in the open gets you found', sprint.alerted > 0, `${sprint.alerted} hunts`);
const hidden = run(0.5, () => ({ noise: 0, visibility: 0.12 }), () => {});
check('keeping still in dark grass stays hidden', hidden.alerted === 0 && hidden.caught === 0, `${hidden.alerted} hunts, ${hidden.caught} caught`);
const creep = run(0.5, () => ({ noise: 3, visibility: 0.22 }), (_t, p) => (p.z += 0.05));
check('creeping through the dark stays hidden', creep.alerted === 0, `${creep.alerted} hunts`);

{
  const b = new NightmareBrain(flat);
  const p = { x: 0, z: 0 };
  const light = [{ x: 40, z: 0, r: 12 }];
  let between = 0;
  let samples = 0;
  let packs = 0;
  for (let i = 0; i < 90 * 30; i++) {
    b.update(1 / 30, p, 1, 0.95, light, true, LOUD);
    packs = Math.max(packs, new Set(b.live.filter((n) => n.pack).map((n) => n.pack)).size);
    for (const n of b.live)
      if (n.mode === 'hunt' && n.role === 'flanker' && n.presence >= 0.9) {
        samples++;
        if (n.x > 3 && n.x < 30 && Math.abs(n.z) < 12) between++;
      }
  }
  check('late night brings packs', packs > 0, `${packs} packs`);
  check('flankers cut you off from the light', samples > 0 && between / samples > 0.4, `${((between / Math.max(1, samples)) * 100).toFixed(0)}% of the time`);
}
{
  // One catch per encounter: a whole pack on top of you still costs you once.
  const b = new NightmareBrain(flat);
  const p = { x: 0, z: 0 };
  for (let k = 0; k < 3; k++) {
    const n = b.spawn('crawler', p, [], { a: 0, d: 50 }, 9)!;
    n.x = 0.5 + k * 0.2;
    n.z = 0.5;
    n.presence = 1;
    n.mode = 'hunt';
  }
  let caught = 0;
  for (let i = 0; i < 4 * 30; i++) caught += b.update(1 / 30, p, 1, 0.95, [], true, LOUD).caught.length;
  check('a pack catches you once, not once each', caught === 1, `${caught} catches from ${b.live.length} nightmares`);
}

// ---- Warmth: seconds from warm to collapse.
function collapseAfter(mode: 'survival' | 'story', e: Exposure) {
  const w = new Warmth();
  for (let t = 0; t < 3600; t += 0.1) if (w.update(0.1, e, TUNING[mode])) return Math.round(t);
  return Infinity;
}
const dark = (night: number, extra: Partial<Exposure> = {}): Exposure => ({ lit: 0, inWater: false, wind: 0, night, ...extra });
const dusk = collapseAfter('survival', dark(0));
const late = collapseAfter('survival', dark(0.9));
const squall = collapseAfter('survival', dark(0.9, { rain: 1, wind: 0.9 }));
const sheltered = collapseAfter('survival', dark(0.9, { rain: 0.25, wind: 0.45 }));
const glade = collapseAfter('survival', dark(0.9, { glow: 1 }));
check('dark at dusk: room to explore (300-600 s)', dusk >= 300 && dusk <= 600, `${dusk} s`);
check('dark late at night: tighter (150-300 s)', late >= 150 && late <= 300, `${late} s`);
check('late squall in the open: a real danger (45-120 s)', squall >= 45 && squall <= 120, `${squall} s`);
check('sheltering from a squall buys time (x1.5)', sheltered >= squall * 1.5, `${sheltered} s`);
check('a glowing glade softens the cold (x2)', glade >= late * 2, `${glade} s`);
const lantern = collapseAfter('survival', dark(0.9, { glow: 0.45 }));
check('the raised lantern alone never makes the dark safe', Number.isFinite(lantern), `${lantern} s`);
check('Story mode is gentle (over 10 min, late night)', collapseAfter('story', dark(0.9)) > 600, `${collapseAfter('story', dark(0.9))} s`);
{
  const w = new Warmth();
  w.value = 0;
  let t = 0;
  while (w.value < 1 && t < 120) {
    w.update(0.1, { lit: 1, inWater: false, wind: 0, night: 0.9 }, TUNING.survival);
    t += 0.1;
  }
  check('a real light warms you back up fast (under 20 s)', t < 20, `${t.toFixed(1)} s`);
}

// ---- Squalls: rhythm over a 20-minute night at rising pressure.
{
  const sq = new SquallClock();
  let first = -1;
  let count = 0;
  for (let t = 0; t < 1200; t += 0.05) {
    if (sq.update(0.05, t / 1200) === 'building') {
      count++;
      if (first < 0) first = t;
    }
  }
  check('the first squall waits past the opening (over 150 s)', first > 150, `${first.toFixed(0)} s`);
  check('a night has a few squalls (2-8)', count >= 2 && count <= 8, `${count}`);
}

// ---- Dark Water: clear early, closing in late, held back by a restored region.
check('Dark Water is far out at dusk', darkAt(0, 2800, darkReach(0, 'survival'), []) === 0, 'clear at 2.8 km');
check('Dark Water reaches 2.8 km by dawn', darkAt(0, 2800, darkReach(0.95, 'survival'), []) > 0.9, 'dark at 2.8 km');
check('a restored region holds it back', darkAt(0, 2800, darkReach(0.95, 'survival'), [{ x: 0, z: 2800, r: 400 }]) === 0, 'clear inside');

console.log(failed ? `${failed} check(s) failed.` : 'All survival checks pass.');
process.exit(failed ? 1 : 0);
