// The nightmares' behaviour, engine-free: when they come, where, how they hunt, what drives them
// off, when they catch you. The renderer only draws what this decides.
import { mulberry32 } from './heightfield';

export type NightmareKind = 'wraith' | 'crawler';

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
  /** The thorn patch it crawled out of. */
  thorns: { x: number; z: number; yaw: number; scale: number };
}

export interface BrainEvents {
  spawned: NightmareState[];
  removed: NightmareState[];
  caught: NightmareKind[];
  sighted: boolean;
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
  private t = 0;
  private rnd = mulberry32(6661);

  constructor(private height: (x: number, z: number) => number) {}

  /** The little light flares; every nightmare within reach bursts. False while on cooldown. */
  flare(at: Point) {
    if (this.flareT > 0) return false;
    this.flareT = 20;
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

  /** Try to bring one out of the dark 45-80 m away, never near a light. */
  spawn(kind: NightmareKind, player: Point, lights: LightSource[]): NightmareState | null {
    for (let tries = 0; tries < 20; tries++) {
      const a = this.rnd() * Math.PI * 2;
      const d = 45 + this.rnd() * 35;
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
      };
      this.live.push(n);
      return n;
    }
    return null;
  }

  /** threat: 0 (none) to 1 (deep night). canSpawn: false until there is something to draw them with. */
  update(dt: number, player: Point, playerSpeed: number, threat: number, lights: LightSource[], canSpawn = true): BrainEvents {
    const ev: BrainEvents = { spawned: [], removed: [], caught: [], sighted: false };
    this.t += dt;
    this.flareT = Math.max(0, this.flareT - dt);
    const wanted = threat <= 0 ? 0 : Math.round(1 + threat * 4);
    const alive = this.live.filter((n) => !n.dissolving).length;
    this.spawnT -= dt;
    if (alive < wanted && this.spawnT <= 0 && canSpawn) {
      const n = this.spawn(this.rnd() < 0.35 + threat * 0.25 ? 'crawler' : 'wraith', player, lights);
      if (n) ev.spawned.push(n);
      this.spawnT = 14 - threat * 8;
    }
    if (threat <= 0) for (const n of this.live) n.dissolving = true;

    let dread = 0;
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
      let speed: number;
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
      let diff = Math.atan2(dx, dz) - n.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      n.yaw += diff * Math.min(1, dt * (n.kind === 'crawler' ? 5 : 2));
      const nx = n.x + Math.sin(n.yaw) * speed * dt;
      const nz = n.z + Math.cos(n.yaw) * speed * dt;
      // Wraiths drift over anything; crawlers keep to dry land.
      if (n.kind === 'wraith' || this.height(nx, nz) > 0.1) {
        n.x = nx;
        n.z = nz;
      }
      n.phase += dt * speed * (n.kind === 'crawler' ? 3.2 : 0.6);
      const ground = Math.max(this.height(n.x, n.z), n.kind === 'wraith' ? 0 : -5);
      n.y = ground + (n.kind === 'wraith' ? 0.35 + Math.sin(this.t / 0.7 + n.x) * 0.15 : 0);
      dread = Math.max(dread, Math.min(1, (45 - d) / 35));
      if (!this.sighted && d < 45) {
        this.sighted = true;
        ev.sighted = true;
      }
      if (d < (n.kind === 'crawler' ? 1.6 : 1.4) + (playerSpeed > 0 ? 0 : 0.2)) {
        n.dissolving = true;
        ev.caught.push(n.kind);
      }
    }
    this.live = this.live.filter((n) => !(n.dissolving && n.presence <= 0));
    this.dread += (Math.max(0, dread) - this.dread) * Math.min(1, dt * 1.5);
    return ev;
  }
}
