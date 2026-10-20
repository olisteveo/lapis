// The nightmares' behaviour, engine-free: when they come, where, how they hunt, what drives them
// off, when they catch you. The renderer only draws what this decides.
//
// They don't know where you are (docs/SURVIVAL.md). Each one prowls, and hears and sees the Keeper
// through Senses: running is loud, creeping in the grass and shadow is nearly silent and unseen.
// Noticed enough, it hunts; lose it for a while and it searches where it last knew you were, then
// gives up. Late in the night they come in packs: when one finds you they all hunt, and the
// flankers try to get between you and the nearest light.
import { mulberry32 } from './heightfield';

export type NightmareKind = 'wraith' | 'crawler';
export type NightmareMode = 'prowl' | 'search' | 'hunt';

/** How the Keeper can be perceived this frame, measured by the game. */
export interface Senses {
  /** Radius (m) within which the Keeper can be heard. */
  noise: number;
  /** 0..1: how easily seen. Light and open ground raise it; cover, shadow and creeping lower it. */
  visibility: number;
}

/** Perceived from anywhere: the old behaviour, for callers that measure nothing. */
export const OBVIOUS: Senses = { noise: 1e9, visibility: 1 };

/** How far each kind sees a fully visible Keeper, and the half-angle of its gaze (radians). */
const SIGHT = { wraith: { range: 34, cone: 1.05 }, crawler: { range: 26, cone: 0.8 } };
/** Close enough to sense you whatever you do (less if you're keeping still). */
const FEEL = 4;
/** Prowlers patrol a ring this far around you, never homing in. */
const PATROL = [18, 42];
/** Seconds hunting without perceiving you before it falls back to searching, and searching before it gives up. */
const LOSE_AFTER = 4;
const SEARCH_FOR = 12;

export interface LightSource {
  x: number;
  z: number;
  r: number;
}

export interface NightmareState {
  id: number;
  kind: NightmareKind;
  x: number;
  z: number;
  /** Ground height (wraiths hover above it) and bob, for the renderer. */
  y: number;
  yaw: number;
  /** 0 = just emerging, 1 = fully here; dissolving runs it back down. */
  presence: number;
  dissolving: boolean;
  /** Walk / ripple phase for the renderer's animation. */
  phase: number;
  lunge: number;
  rest: number;
  mode: NightmareMode;
  /** 0..1: how sure it is you're there. Reaching 1 starts a hunt. */
  alert: number;
  /** Where it last perceived you. */
  lastX: number;
  lastZ: number;
  /** Seconds since it last perceived you (hunting), or left to search. */
  lostT: number;
  searchT: number;
  /** Prowling heading, drifting slowly. */
  wander: number;
  /** Pack it belongs to (0: alone), and its part in the hunt. */
  pack: number;
  role: 'chaser' | 'flanker';
  /** The thorn patch it crawled out of. */
  thorns: { x: number; z: number; yaw: number; scale: number };
}

export interface BrainEvents {
  spawned: NightmareState[];
  removed: NightmareState[];
  caught: NightmareKind[];
  sighted: boolean;
  /** How many started hunting this frame (a pack counts once). */
  alerted: number;
  /** Hunts that ended with you lost. */
  lost: number;
}

interface Point {
  x: number;
  z: number;
}

export class NightmareBrain {
  live: NightmareState[] = [];
  /** 0..1: how close the nearest one is, for the curdled picture and the music. */
  dread = 0;
  private spawnT = 8;
  private flareT = 0;
  private sighted = false;
  private nextId = 1;
  private nextPack = 1;
  private t = 0;
  private rnd = mulberry32(6661);

  constructor(private height: (x: number, z: number) => number) {}

  /** The little light flares; every nightmare within reach bursts. False while on cooldown. */
  flare(at: Point, cooldown = 20) {
    if (this.flareT > 0) return false;
    this.flareT = cooldown;
    for (const n of this.live) if (Math.hypot(n.x - at.x, n.z - at.z) < 26) n.dissolving = true;
    return true;
  }

  get flareReady() {
    return this.flareT <= 0;
  }

  /** Resting at a light or waking: the night's nightmares all sink away. */
  clear() {
    for (const n of this.live) n.dissolving = true;
    this.spawnT = 20;
  }

  /** True while any nightmare is hunting the Keeper. */
  get hunted() {
    return this.live.some((n) => n.mode === 'hunt' && !n.dissolving);
  }

  /** Try to bring one out of the dark 45-80 m away, never near a light. at: a bearing and distance to use. */
  spawn(kind: NightmareKind, player: Point, lights: LightSource[], at?: { a: number; d: number }, pack = 0): NightmareState | null {
    for (let tries = 0; tries < 20; tries++) {
      const a = at ? at.a + (this.rnd() - 0.5) * 0.5 : this.rnd() * Math.PI * 2;
      const d = at ? at.d + (this.rnd() - 0.5) * 8 : 45 + this.rnd() * 35;
      const x = player.x + Math.sin(a) * d;
      const z = player.z + Math.cos(a) * d;
      if (this.height(x, z) < 0.3) continue;
      if (lights.some((l) => Math.hypot(l.x - x, l.z - z) < l.r + 10)) continue;
      const n: NightmareState = {
        id: this.nextId++,
        kind,
        x,
        z,
        y: this.height(x, z),
        yaw: 0,
        presence: 0,
        dissolving: false,
        phase: 0,
        lunge: 0,
        rest: 2 + this.rnd() * 3,
        thorns: { x, z, yaw: this.rnd() * 6.28, scale: 0.9 + this.rnd() * 0.6 },
        mode: 'prowl',
        alert: 0,
        lastX: player.x,
        lastZ: player.z,
        lostT: 0,
        searchT: 0,
        wander: Math.atan2(player.x - x, player.z - z) + (this.rnd() - 0.5) * 1.6,
        pack,
        role: 'chaser',
      };
      this.live.push(n);
      return n;
    }
    return null;
  }

  /**
   * threat: 0 (none) to 1 (deep night). canSpawn: false until there is something to draw them with.
   * senses: how the Keeper can be perceived; OBVIOUS makes every nightmare know where you are.
   */
  update(dt: number, player: Point, playerSpeed: number, threat: number, lights: LightSource[], canSpawn = true, senses: Senses = OBVIOUS): BrainEvents {
    const ev: BrainEvents = { spawned: [], removed: [], caught: [], sighted: false, alerted: 0, lost: 0 };
    this.t += dt;
    this.flareT = Math.max(0, this.flareT - dt);
    const wanted = threat <= 0 ? 0 : Math.round(1 + threat * 4);
    const alive = this.live.filter((n) => !n.dissolving).length;
    this.spawnT -= dt;
    if (alive < wanted && this.spawnT <= 0 && canSpawn) {
      // Deep in the night they come together: a pack of two or three out of one patch of dark.
      const size = threat > 0.65 ? Math.min(wanted - alive, 2 + (this.rnd() < threat - 0.5 ? 1 : 0)) : 1;
      if (size > 1) {
        const at = { a: this.rnd() * Math.PI * 2, d: 50 + this.rnd() * 25 };
        const pack = this.nextPack++;
        for (let k = 0; k < size; k++) {
          const n = this.spawn(k === 0 || this.rnd() < 0.5 ? 'crawler' : 'wraith', player, lights, at, pack);
          if (!n) continue;
          n.role = k === 0 ? 'chaser' : 'flanker';
          ev.spawned.push(n);
        }
      } else {
        const n = this.spawn(this.rnd() < 0.35 + threat * 0.25 ? 'crawler' : 'wraith', player, lights);
        if (n) ev.spawned.push(n);
      }
      this.spawnT = 14 - threat * 8;
    }
    if (threat <= 0) for (const n of this.live) n.dissolving = true;

    // The light you'd run for: flankers try to stand between it and you.
    let refuge: LightSource | null = null;
    let refugeD = Infinity;
    for (const l of lights) {
      const d = Math.hypot(l.x - player.x, l.z - player.z) - l.r;
      if (d > 0 && d < refugeD && d < 120) {
        refuge = l;
        refugeD = d;
      }
    }

    let dread = 0;
    const packsAlerted = new Set<number>();
    for (const n of this.live) {
      const dx = player.x - n.x;
      const dz = player.z - n.z;
      const d = Math.hypot(dx, dz);
      // Light burns them: any nightmare that strays inside a light's reach comes apart.
      if (lights.some((l) => Math.hypot(l.x - n.x, l.z - n.z) < l.r)) n.dissolving = true;
      if (d > 160) n.dissolving = true;
      n.presence = n.dissolving ? n.presence - dt * 0.7 : Math.min(1, n.presence + dt * 0.35);
      if (n.presence <= 0 && n.dissolving) {
        ev.removed.push(n);
        continue;
      }
      if (n.presence < 0.9 || n.dissolving) {
        // Still emerging from the thorns.
        n.y = this.height(n.x, n.z);
        continue;
      }

      // ---- Senses: heard within the noise radius, seen within its gaze, felt when very close.
      const sight = SIGHT[n.kind];
      let off = Math.atan2(dx, dz) - n.yaw;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      const seen = d < sight.range * senses.visibility && Math.abs(off) < sight.cone;
      const heard = d < senses.noise;
      const perceived = seen || heard || d < (playerSpeed > 0.3 ? FEEL : FEEL * 0.5);
      if (perceived) {
        const keen = (seen ? 1.4 : 0.9) * (n.mode === 'search' ? 1.6 : 1) * (1 + Math.max(0, 1 - d / 30));
        n.alert = Math.min(1, n.alert + dt * keen);
        n.lastX = player.x;
        n.lastZ = player.z;
        n.lostT = 0;
      } else n.alert = Math.max(0, n.alert - dt * (n.mode === 'hunt' ? 0.05 : 0.12));
      if (n.mode !== 'hunt' && n.alert >= 1) {
        n.mode = 'hunt';
        if (!n.pack) ev.alerted++;
        else if (!packsAlerted.has(n.pack)) {
          packsAlerted.add(n.pack);
          ev.alerted++;
        }
      } else if (n.mode === 'hunt' && !perceived) {
        n.lostT += dt;
        if (n.lostT > LOSE_AFTER) {
          n.mode = 'search';
          n.searchT = SEARCH_FOR;
          n.alert = 0.5;
        }
      } else if (n.mode === 'search') {
        n.searchT -= dt;
        if (n.searchT <= 0) {
          n.mode = 'prowl';
          n.alert = 0;
          ev.lost++;
        }
      }

      // ---- Where it's going and how fast.
      let tx = n.lastX;
      let tz = n.lastZ;
      let speed: number;
      if (n.mode === 'hunt') {
        // Straight at you while it can sense you; otherwise to where it last did.
        if (perceived) {
          tx = player.x;
          tz = player.z;
        }
        if (n.role === 'flanker' && refuge && d > 9) {
          // Cut you off: a point on your line to the light, kept just outside its reach.
          const lx = refuge.x - player.x;
          const lz = refuge.z - player.z;
          const ld = Math.hypot(lx, lz) || 1;
          const along = Math.min(ld - refuge.r - 3, Math.max(6, ld * 0.45));
          tx = player.x + (lx / ld) * along;
          tz = player.z + (lz / ld) * along;
        }
        if (n.kind === 'wraith') speed = 2.4 + threat * 0.8;
        else if (n.lunge > 0) {
          // Crawlers stalk at a distance, then lunge, then have to rest.
          n.lunge -= dt;
          speed = 8.5;
        } else if (n.rest > 0) {
          n.rest -= dt;
          speed = d > 25 ? 3.2 : 0.6;
        } else {
          n.lunge = 1.8;
          n.rest = 4 + this.rnd() * 3;
          speed = 8.5;
        }
      } else if (n.mode === 'search') {
        // Go to where you were, then cast about around it.
        const near = Math.hypot(n.lastX - n.x, n.lastZ - n.z) < 4;
        if (near) {
          n.wander += (this.rnd() - 0.5) * dt * 3;
          tx = n.x + Math.sin(n.wander) * 5;
          tz = n.z + Math.cos(n.wander) * 5;
        }
        speed = near ? 1.2 : 2.6;
      } else {
        // Prowling: a slow patrol around your part of the island. Too far and it closes in, too
        // near and it turns along the ring, so only noise or sight brings it to you.
        n.wander += (this.rnd() - 0.5) * dt * 1.2;
        const toward = Math.atan2(dx, dz);
        const goal = d > PATROL[1] ? toward : d < PATROL[0] ? toward + Math.PI * 0.6 * Math.sign(Math.sin(n.id * 12.9898) || 1) : n.wander;
        let pull = goal - n.wander;
        pull = Math.atan2(Math.sin(pull), Math.cos(pull));
        n.wander += pull * dt * 0.6;
        tx = n.x + Math.sin(n.wander) * 5;
        tz = n.z + Math.cos(n.wander) * 5;
        speed = n.kind === 'wraith' ? 1.1 : 1.4;
      }
      let diff = Math.atan2(tx - n.x, tz - n.z) - n.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      n.yaw += diff * Math.min(1, dt * (n.kind === 'crawler' ? 5 : 2));
      const nx = n.x + Math.sin(n.yaw) * speed * dt;
      const nz = n.z + Math.cos(n.yaw) * speed * dt;
      // Wraiths drift over anything; crawlers keep to dry land. Only a hunter strays into light.
      const intoLight = n.mode !== 'hunt' && lights.some((l) => Math.hypot(l.x - nx, l.z - nz) < l.r + 2);
      if ((n.kind === 'wraith' || this.height(nx, nz) > 0.1) && !intoLight) {
        n.x = nx;
        n.z = nz;
      } else n.wander += Math.PI * 0.5;
      n.phase += dt * speed * (n.kind === 'crawler' ? 3.2 : 0.6);
      const ground = Math.max(this.height(n.x, n.z), n.kind === 'wraith' ? 0 : -5);
      n.y = ground + (n.kind === 'wraith' ? 0.35 + Math.sin(this.t / 0.7 + n.x) * 0.15 : 0);
      dread = Math.max(dread, Math.min(1, (45 - d) / 35) * (n.mode === 'hunt' ? 1 : 0.55));
      if (!this.sighted && d < 45) {
        this.sighted = true;
        ev.sighted = true;
      }
      if (d < (n.kind === 'crawler' ? 1.6 : 1.4) + (playerSpeed > 0 ? 0 : 0.2)) {
        n.dissolving = true;
        ev.caught.push(n.kind);
      }
    }
    // One of a pack found you: the whole pack hunts.
    for (const n of this.live)
      if (n.pack && packsAlerted.has(n.pack) && n.mode !== 'hunt' && !n.dissolving) {
        n.mode = 'hunt';
        n.alert = 1;
        n.lastX = player.x;
        n.lastZ = player.z;
        n.lostT = 0;
      }
    this.live = this.live.filter((n) => !(n.dissolving && n.presence <= 0));
    this.dread += (Math.max(0, dread) - this.dread) * Math.min(1, dt * 1.5);
    return ev;
  }
}
