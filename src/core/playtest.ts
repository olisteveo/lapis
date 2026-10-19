// Simulated playtesters: skill-profiled bots that play the real puzzle logic in fast-forward.
// Movement, presses and puzzle state are real; what a human would perceive (a reflection, a
// constellation, which footprints are hers) is modelled as a chance of noticing or misreading.
import { mulberry32 } from './heightfield';
import type { PuzzleSite, SkyFeature } from './puzzles';
import { BellsRule, FirefliesRule, GlowcapsRule, MirrorsRule, StonesRule } from './puzzleRules';


export interface Skill {
  name: string;
  /** Chance of noticing a clue that is in front of them. */
  perception: number;
  /** How well they think a problem through rather than poking at it. */
  reasoning: number;
  /** Chance per second of breaking into a run when they should be gentle. */
  impatience: number;
  /** Seconds of thought per decision. */
  think: number;
  /** Minutes before they give up. */
  patience: number;
  /** Seconds to react to what a moving thing does (herding). */
  reaction: number;
}

export const SKILLS: Skill[] = [
  { name: 'novice', perception: 0.35, reasoning: 0.2, impatience: 0.08, think: 4, patience: 10, reaction: 1.2 },
  { name: 'casual', perception: 0.6, reasoning: 0.45, impatience: 0.03, think: 3, patience: 15, reaction: 0.8 },
  { name: 'skilled', perception: 0.8, reasoning: 0.75, impatience: 0.01, think: 2.5, patience: 25, reaction: 0.5 },
  { name: 'expert', perception: 0.95, reasoning: 0.95, impatience: 0.002, think: 2, patience: 40, reaction: 0.3 },
];

export interface Run {
  solved: boolean;
  seconds: number;
  mistakes: number;
  note: string;
}

const WALK = 3.2;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

interface Ctx {
  rnd: () => number;
  skill: Skill;
  t: number;
  mistakes: number;
  solved: boolean;
  out(): boolean;
}

function ctx(skill: Skill, seed: number): Ctx {
  const c: Ctx = {
    rnd: mulberry32(seed),
    skill,
    t: 0,
    mistakes: 0,
    solved: false,
    out: () => c.t > skill.patience * 60,
  };
  return c;
}

// ---------------------------------------------------------------- firefly jar

function fireflies(site: PuzzleSite, c: Ctx): string {
  const p = new FirefliesRule(site, false);
  const f = site.flower!;
  const j = site.jar!;
  // Working out that the jar wants something sweet: the hint helps, reasoning helps more.
  const twigs = c.rnd() < 0.35 + 0.6 * c.skill.reasoning;
  c.t += twigs ? 20 : 60 + c.rnd() * 240 * (1 - c.skill.perception);
  if (c.out()) return 'never thought to open the jar';
  c.t += (dist(site, f) + dist(f, j)) / WALK + c.skill.think * 2;
  p.pick();
  p.open();
  // Herding, simulated with the real swarm. They aim to stay behind it at a chosen distance;
  // the less skilled crowd it, steer badly, and sometimes run.
  const player = { x: 0, y: site.y, z: 0, speed: WALK };
  const S = p.swarm;
  const away = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const d = Math.max(dist(a, b), 1e-3);
    return { x: (a.x - b.x) / d, z: (a.z - b.z) / d };
  };
  let u = away(S, j);
  player.x = S.x + u.x * 9;
  player.z = S.z + u.z * 9;
  const gap = 4.2 + c.skill.reasoning * 1.6 + (c.rnd() - 0.5);
  let runT = 0;
  const dt = 0.1;
  let tx = player.x;
  let tz = player.z;
  let react = 0;
  while (!c.solved && !c.out()) {
    // People correct late: they re-aim only every so often, at where the swarm was.
    react -= dt;
    if (react <= 0) {
      react = c.skill.reaction * (0.6 + c.rnd() * 0.8);
      u = away(S, j);
      const wobble = (c.rnd() - 0.5) * (1 - c.skill.perception) * 3;
      tx = S.x + u.x * gap + u.z * wobble;
      tz = S.z + u.z * gap - u.x * wobble;
    }
    if (runT <= 0 && c.rnd() < c.skill.impatience * dt) runT = 1.2;
    runT -= dt;
    const speed = runT > 0 ? 6.5 : WALK;
    const dx = tx - player.x;
    const dz = tz - player.z;
    const dd = Math.hypot(dx, dz);
    const step = Math.min(dd, speed * dt);
    if (dd > 0.01) {
      player.x += (dx / dd) * step;
      player.z += (dz / dd) * step;
    }
    player.speed = dd > 0.05 ? speed : 0;
    const ev = p.update(dt, player);
    if (ev === 'scattered') c.mistakes++;
    if (ev === 'solved') c.solved = true;
    c.t += dt;
  }
  return c.solved ? '' : 'could not herd them in';
}

// ---------------------------------------------------------------- footprints

function footprints(site: PuzzleSite, c: Ctx): string {
  const trail = site.trail!;
  const length = trail.reduce((s, q, i) => s + (i ? dist(q, trail[i - 1]) : 0), 0);
  c.t += length / (WALK * 0.8);
  // Running blurs the prints away: each slip costs a search to find them again.
  const slips = Math.round(c.skill.impatience * (length / WALK) * 1.5);
  for (let k = 0; k < slips; k++) {
    c.mistakes++;
    c.t += 15 + c.rnd() * 40 * (1 - c.skill.perception);
  }
  // Two forks: yours wander off. Telling the sizes apart is perception.
  for (let k = 0; k < 2; k++) {
    if (c.rnd() > 0.45 + 0.55 * c.skill.perception) {
      c.mistakes++;
      c.t += (2 * 29) / WALK + c.skill.think * 3;
      // Some never realise it was the wrong set and give up at the dead end.
      if (c.rnd() > 0.5 + 0.5 * c.skill.reasoning) return 'lost at a dead end';
    }
  }
  // Two wet gaps with no prints: searching the far side.
  for (let k = 0; k < 2; k++) {
    let found = false;
    for (let tries = 0; tries < 6 && !found; tries++) {
      c.t += 12 + c.rnd() * 25;
      found = c.rnd() < 0.3 + 0.6 * c.skill.perception;
      if (!found) c.mistakes++;
    }
    if (!found) return 'lost the trail at a wet gap';
  }
  if (c.out()) return 'ran out of patience';
  c.solved = true;
  return '';
}

// ---------------------------------------------------------------- glowcaps

function glowcaps(site: PuzzleSite, c: Ctx): string {
  const p = new GlowcapsRule(site, false);
  const caps = site.caps!;
  const links = site.links!;
  const flip = (lit: boolean[], i: number) => {
    const l = [...lit];
    for (const j of [i, ...links[i]]) l[j] = !l[j];
    return l;
  };
  const key = (l: boolean[]) => l.map((b) => (b ? 1 : 0)).join('');
  const seen = new Set<string>([key(p.lit)]);
  // Experts reason it out: the shortest set of presses.
  let plan: number[] = [];
  if (c.rnd() < c.skill.reasoning * c.skill.reasoning) {
    for (let m = 1; m < 256 && !plan.length; m++) {
      let l = [...p.lit];
      const ps = caps.map((_, i) => i).filter((i) => (m >> i) & 1);
      for (const i of ps) l = flip(l, i);
      if (l.every(Boolean)) plan = ps;
    }
    c.t += 30 + 60 * (1 - c.skill.reasoning);
  }
  // The fewest presses that would do it, so extra presses count as mistakes.
  let best = caps.length;
  for (let m = 1; m < 256; m++) {
    let l = [...p.lit];
    const ps = caps.map((_, i) => i).filter((i) => (m >> i) & 1);
    for (const i of ps) l = flip(l, i);
    if (l.every(Boolean)) best = Math.min(best, ps.length);
  }
  let presses = 0;
  let at = caps[0];
  let last = -1;
  while (!c.solved && !c.out()) {
    let i: number;
    if (plan.length) i = plan.shift()!;
    else if (c.rnd() < c.skill.reasoning) {
      // Greedy: the press that lights the most, avoiding states already seen (if they remember).
      const options = caps.map((_, k) => k).filter((k) => k !== last);
      const score = (k: number) => {
        const l = flip(p.lit, k);
        return l.filter(Boolean).length - (c.skill.reasoning > 0.5 && seen.has(key(l)) ? 10 : 0) + c.rnd() * 0.5;
      };
      i = options.sort((a, b) => score(b) - score(a))[0];
    } else i = Math.floor(c.rnd() * caps.length);
    const spent = dist(at, caps[i]) / WALK + c.skill.think;
    c.t += spent;
    // Time passes for the caps too: anything left burning too long gutters out.
    p.update(spent);
    at = caps[i];
    if (p.touch(i)) c.solved = true;
    presses++;
    seen.add(key(p.lit));
    last = i;
  }
  c.mistakes = Math.max(0, presses - best);
  return c.solved ? '' : 'went round in circles';
}

// ---------------------------------------------------------------- mirror caps

function mirrors(site: PuzzleSite, c: Ctx): string {
  const p = new MirrorsRule(site, false);
  const n = site.nodes!;
  const last = n.length - 1;
  const aims = site.aims!;
  // Does the player take in the rule (visit every cap), or just try to reach the shrine?
  const knowsRule = c.rnd() < 0.4 + 0.6 * c.skill.perception;
  // A route through every cap, found by thinking (depth-first) with occasional slips.
  const route = (): number[] | null => {
    const walk = (path: number[]): number[] | null => {
      const cur = path[path.length - 1];
      if (path.length === last && aims[cur].includes(last)) return [...path, last];
      for (const j of aims[cur]) if (j !== last && !path.includes(j)) {
        const r = walk([...path, j]);
        if (r) return r;
      }
      return null;
    };
    return walk([0, 1]);
  };
  let at = n[0];
  const setAim = (i: number, j: number) => {
    let guard = 0;
    while (p.aim[i] !== j && guard++ < 12 && !c.solved) {
      if (p.turn(i)) c.solved = true;
      c.t += 1.2;
    }
    c.t += dist(at, n[i]) / WALK + c.skill.think;
    at = n[i];
  };
  while (!c.solved && !c.out()) {
    if (knowsRule && c.rnd() < c.skill.reasoning) {
      c.t += 40 * (1.2 - c.skill.reasoning);
      const r = route();
      if (!r) return 'no route';
      for (let k = 1; k < r.length - 1; k++) {
        // A slip: they aim a cap at the wrong neighbour and have to come back to it.
        if (c.rnd() < (1 - c.skill.reasoning) * 0.3) {
          c.mistakes++;
          const wrong = aims[r[k]].find((j) => j !== r[k + 1]);
          if (wrong !== undefined) setAim(r[k], wrong);
        }
        setAim(r[k], r[k + 1]);
      }
    } else {
      // Poking: follow the beam to where it stops, and turn that cap toward somewhere new.
      const seenNodes = new Set<number>([0]);
      let cur = 0;
      while (p.aim[cur] >= 0 && !seenNodes.has(p.aim[cur]) && p.aim[cur] !== last) {
        cur = p.aim[cur];
        seenNodes.add(cur);
      }
      const target = cur === 0 ? 1 : cur;
      if (target === last || target === 0) {
        const i = 1 + Math.floor(c.rnd() * (last - 1));
        setAim(i, aims[i][Math.floor(c.rnd() * aims[i].length)]);
      } else {
        const fresh = aims[target].filter((j) => !seenNodes.has(j));
        const pool = fresh.length ? fresh : aims[target];
        setAim(target, pool[Math.floor(c.rnd() * pool.length)]);
      }
      c.mistakes++;
    }
  }
  return c.solved ? '' : knowsRule ? 'could not find the route' : 'never understood it had to touch every cap';
}

// ---------------------------------------------------------------- constellation stones

function stones(site: PuzzleSite, c: Ctx, features: SkyFeature[]): string {
  const p = new StonesRule(site, features.length, false);
  const st = site.stones!;
  // Getting the idea: stand behind a stone and look where it looks.
  let understood = c.rnd() < 0.3 + 0.35 * c.skill.perception + 0.35 * c.skill.reasoning;
  while (!c.solved && !c.out()) {
    if (!understood) {
      // Turning dials at random until it clicks (or they give up).
      const i = Math.floor(c.rnd() * st.length);
      if (p.turn(i)) c.solved = true;
      c.t += 4 + c.skill.think;
      c.mistakes++;
      if (c.rnd() < 0.004 + 0.01 * c.skill.reasoning) understood = true;
      continue;
    }
    // A pass round the ring: look past each stone, identify the shape, turn the dial to it.
    for (let i = 0; i < st.length && !c.solved; i++) {
      c.t += 8 + c.skill.think + 7 / WALK;
      const misread = c.rnd() < (1 - c.skill.perception) * 0.4;
      const want = misread ? (st[i].answer + 1 + Math.floor(c.rnd() * (features.length - 1))) % features.length : st[i].answer;
      let guard = 0;
      while (p.shown[i] !== want && guard++ < features.length && !c.solved) {
        if (p.turn(i)) c.solved = true;
        c.t += 1.2;
      }
      if (misread) c.mistakes++;
    }
  }
  return c.solved ? '' : understood ? 'kept misreading the sky' : 'never worked out what the stones wanted';
}

// ---------------------------------------------------------------- reflection bells

function bells(site: PuzzleSite, c: Ctx): string {
  const p = new BellsRule(site, false);
  const b = site.bells!;
  const order = site.order!;
  // The hint is a riddle now: reading it as "look in the water" takes some insight.
  let noticed = c.rnd() < 0.15 + 0.45 * c.skill.perception + 0.3 * c.skill.reasoning;
  let knowsStill = c.rnd() < 0.1 + 0.4 * c.skill.perception + 0.3 * c.skill.reasoning;
  // In the second pool the bells' own marks lie; the trusting follow them first.
  let trustsDecoy = !!site.decoy && c.rnd() < 0.85 - 0.6 * c.skill.reasoning;
  let at = b[0];
  const ring = (seq: number[]) => {
    for (const i of seq) {
      c.t += dist(at, b[i]) / WALK + 1.5;
      at = b[i];
      const result = p.ring(i);
      if (result === 'solved') {
        c.solved = true;
        return;
      }
      if (result === 'wrong') return;
    }
  };
  while (!c.solved && !c.out()) {
    c.t += c.skill.think * 2;
    if (trustsDecoy) {
      ring(site.decoy!);
      c.mistakes++;
      if (c.rnd() < 0.3 + 0.6 * c.skill.reasoning) trustsDecoy = false;
      continue;
    }
    if (!noticed) {
      // Trying orders blind.
      const seq = [...order].sort(() => c.rnd() - 0.5);
      ring(seq);
      c.mistakes++;
      if (c.rnd() < 0.02 + 0.08 * c.skill.perception) noticed = true;
      continue;
    }
    // The marks only show in still water. Moving players see ripples and think there is nothing there.
    if (!knowsStill) {
      c.t += 20;
      c.mistakes++;
      if (c.rnd() < 0.05 + 0.25 * c.skill.perception * (1 - c.skill.impatience * 5)) knowsStill = true;
      else {
        ring([...order].sort(() => c.rnd() - 0.5));
        continue;
      }
    }
    // Reading the reflection: counting dots, with the odd miscount.
    const seq = [...order];
    if (c.rnd() < (1 - c.skill.perception) * 0.5) {
      const k = Math.floor(c.rnd() * (seq.length - 1));
      [seq[k], seq[k + 1]] = [seq[k + 1], seq[k]];
    }
    c.t += 6 * b.length * (1.2 - c.skill.perception);
    ring(seq);
    if (!c.solved) c.mistakes++;
  }
  return c.solved ? '' : noticed ? 'kept miscounting' : 'never looked at the water';
}

/** Play every puzzle with every skill, `runs` times each. */
export function playtest(sites: PuzzleSite[], features: SkyFeature[], runs = 30) {
  const rows: Record<string, string | number>[] = [];
  for (const site of sites) {
    for (const skill of SKILLS) {
      const results: Run[] = [];
      for (let r = 0; r < runs; r++) {
        const c = ctx(skill, 1000 + r * 31 + site.slot * 7);
        let note = '';
        switch (site.kind) {
          case 'fireflies':
            note = fireflies(site, c);
            break;
          case 'footprints':
            note = footprints(site, c);
            break;
          case 'glowcaps':
            note = glowcaps(site, c);
            break;
          case 'mirrors':
            note = mirrors(site, c);
            break;
          case 'stones':
            note = stones(site, c, features);
            break;
          case 'bells':
            note = bells(site, c);
            break;
        }
        results.push({ solved: c.solved, seconds: Math.min(c.t, skill.patience * 60), mistakes: c.mistakes, note });
      }
      const won = results.filter((r) => r.solved);
      const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
      const why = new Map<string, number>();
      for (const r of results) if (!r.solved) why.set(r.note, (why.get(r.note) ?? 0) + 1);
      rows.push({
        puzzle: site.id.replace('puzzle-', ''),
        kind: site.kind,
        skill: skill.name,
        solved: `${Math.round((won.length / runs) * 100)}%`,
        minutes: won.length ? +(median(won.map((r) => r.seconds)) / 60).toFixed(1) : '-',
        mistakes: won.length ? median(won.map((r) => r.mistakes)) : '-',
        stuck: [...why].sort((a, b) => b[1] - a[1]).map(([w, k]) => `${w} (${k})`).join('; '),
      });
    }
  }
  return rows;
}
