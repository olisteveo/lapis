// Engine-agnostic player logic: walking, jumping, wading, swimming and diving, boarding and rowing.
// No three.js here on purpose; this maps 1:1 onto an s&box component later.

export interface WorldQuery {
  height(x: number, z: number): number;
  /** Optional water current (m/s) at a point: star currents that carry the boat. */
  flow?(x: number, z: number): { x: number; z: number };
}

/** Circular solids the walker can't pass through (tree trunks, the beached hull). */
export interface Colliders {
  /** Visits every collider near (x, z) as (cx, cz, radius). */
  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void): void;
}

/** Standable surfaces above the terrain: stepping stones. */
export interface Platforms {
  /** Highest standable top at (x, z) within a step of height y (stacked surfaces, like a stair), or -Infinity. */
  top(x: number, z: number, y?: number): number;
  /** Optionally: is a walker (body radius, default 0.35) at (x, z, y) inside a wall, rail or under a low ceiling? */
  blocked?(x: number, z: number, y: number, body?: number): boolean;
  /** Optionally: where a walker at (x, z, y) overlapping a wall should be slid to, or null if clear. */
  push?(x: number, z: number, y: number, body: number): { x: number; z: number } | null;
  /** Optionally: height of the lowest thing overhead at (x, z) for a walker at y, where a jump bonks. */
  ceiling?(x: number, z: number, y: number): number;
  /** True if something solid in the water blocks a hull at (x, z). */
  blocksBoat(x: number, z: number, radius: number): boolean;
}

export type PlayerEvent = 'jump' | 'land' | 'fall' | 'respawn' | 'powerStroke' | 'weakStroke' | 'callBoat' | 'swim' | 'climbOut' | 'dive' | 'surface';

export interface PlayerInput {
  /** Raw stick/keys: x = right, y = forward, each -1..1. */
  moveX: number;
  moveY: number;
  sprint: boolean;
  interact: boolean;
  /** Space: jump on foot, long stroke in the boat. */
  jump: boolean;
  /** Camera yaw in radians; walking is camera-relative. */
  cameraYaw: number;
  /** In the water: dive down (held). */
  dive?: boolean;
}

export type Mode = 'walk' | 'boat' | 'swim';
export type Anim = 'idle' | 'walk' | 'row' | 'sit';

const BODY_RADIUS = 0.35;
const WALK_SPEED = 3.2;
const SPRINT_SPEED = 6.5;
const WADE_DEPTH = -0.85;
const MAX_CLIMB = 1.05; // rise per metre travelled
// Bare ground steeper than this (about 52 degrees) can't be walked up: cliffs have to be jumped round.
const MAX_SLOPE = 1.3;
const STEP_UP = 0.5; // a ledge you can step onto without jumping
const JUMP_V = 5.4;
const HEAD = 1.75;
const GRAVITY = 14;
const BOAT_DRAFT = -0.4;
const STROKE_PERIOD = 1.7;
const BOAT_MAX = 9;
// Swimming: feet hang this far below the surface (the eye just clears it), and how fast you go.
const SWIM_Y = -1.42;
const SWIM_SPEED = 1.9;
const SWIM_SPRINT = 3.0;
const DIVE_SPEED = 1.5;
const RISE_SPEED = 1.7;
/** Seconds of breath underwater before you're carried back up. */
const BREATH = 30;
/** From the surface you can haul yourself onto a stone, pier or bank up to this far above your feet. */
const CLIMB_OUT = 2.25;

export interface BoatState {
  x: number;
  z: number;
  heading: number;
  speed: number;
  /** 0..1 position in the rowing cycle; 0 = catch. */
  stroke: number;
  rowing: boolean;
  bob: number;
  /** 0..1 how strongly a star current is carrying the boat right now. */
  current: number;
}

export class PlayerController {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  speed = 0;
  vy = 0;
  airborne = false;
  mode: Mode = 'walk';
  anim: Anim = 'idle';
  animRate = 1;
  prompt = '';
  boat: BoatState = { x: 0, z: 0, heading: 0, speed: 0, stroke: 0, rowing: false, bob: 0, current: 0 };
  colliders: Colliders | null = null;
  platforms: Platforms | null = null;
  /** Moth wings found: hold jump while falling to glide. */
  canGlide = false;
  /** How fast a glide sinks (m/s): moth wings spread wide sink slower. */
  glideSink = 1.6;
  onEvent: ((e: PlayerEvent) => void) | null = null;
  /** >0 while sinking after a missed jump; the view fades and you return to safe ground. */
  falling = 0;
  /** 0..1 breath left while swimming underwater; refills at the surface. */
  breath = 1;
  private wasUnder = false;
  private interactLatch = false;
  private jumpLatch = false;
  private holdE = 0;
  private t = 0;
  private safe = { x: 0, y: 0, z: 0 };
  private safeTimer = 0;
  private strokeUsed = -1;
  private boatCall: { x: number; z: number } | null = null;
  private hasBoarded = false;

  constructor(private world: WorldQuery) {}

  private ground(x: number, z: number, yRef = this.y) {
    return Math.max(this.world.height(x, z), this.platforms?.top(x, z, yRef) ?? -Infinity);
  }

  private pushOutOfWalls() {
    const out = this.platforms?.push?.(this.x, this.z, this.y, BODY_RADIUS);
    if (out) {
      this.x = out.x;
      this.z = out.z;
    }
  }

  /** Push the walker out of walls, trunks and the boat hull, sliding along them rather than stopping. */
  private resolve() {
    this.pushOutOfWalls();
    this.colliders?.near(this.x, this.z, 3, (cx, cz, r) => {
      const dx = this.x - cx;
      const dz = this.z - cz;
      const min = r + BODY_RADIUS;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 < 1e-8) return;
      const d = Math.sqrt(d2);
      this.x = cx + (dx / d) * min;
      this.z = cz + (dz / d) * min;
    });
    // The hull is a capsule along the boat's heading.
    const b = this.boat;
    const ax = Math.sin(b.heading);
    const az = Math.cos(b.heading);
    const t = Math.max(-1.5, Math.min(1.5, (this.x - b.x) * ax + (this.z - b.z) * az));
    const px = b.x + ax * t;
    const pz = b.z + az * t;
    const dx = this.x - px;
    const dz = this.z - pz;
    const min = 0.62 + BODY_RADIUS;
    const d = Math.hypot(dx, dz);
    if (d < min && d > 1e-4 && this.y < 1.2) {
      this.x = px + (dx / d) * min;
      this.z = pz + (dz / d) * min;
    }
  }

  /** y picks the level on stacked surfaces (a stair): the default is the highest. */
  place(x: number, z: number, heading: number, y = Infinity) {
    this.x = x;
    this.z = z;
    this.y = Math.max(this.ground(x, z, y), WADE_DEPTH);
    this.heading = heading;
    this.airborne = false;
    this.vy = 0;
    this.safe = { x, y: this.y, z };
  }

  placeBoat(x: number, z: number, heading: number) {
    Object.assign(this.boat, { x, z, heading, speed: 0, stroke: 0 });
  }

  update(dt: number, input: PlayerInput) {
    this.t += dt;
    const pressed = input.interact && !this.interactLatch;
    this.interactLatch = input.interact;
    const jumped = input.jump && !this.jumpLatch;
    this.jumpLatch = input.jump;
    this.holdE = input.interact ? this.holdE + dt : 0;
    if (this.mode === 'walk') this.walk(dt, input, pressed, jumped);
    else if (this.mode === 'swim') this.swim(dt, input, pressed, jumped);
    else this.row(dt, input, pressed, jumped);
    this.boat.bob = Math.sin(this.t * 1.3) * 0.04 + Math.sin(this.t * 0.7 + 1) * 0.03;
    this.glideCalledBoat(dt);
  }

  private walk(dt: number, input: PlayerInput, pressed: boolean, jumped: boolean) {
    if (this.falling > 0) {
      // Sinking: drift down, then wake back on the last solid ground.
      this.falling -= dt;
      this.y -= dt * 0.9;
      this.speed = 0;
      if (this.falling <= 0) {
        this.place(this.safe.x, this.safe.z, this.heading, this.safe.y);
        this.onEvent?.('respawn');
      }
      this.prompt = '';
      return;
    }
    const len = Math.hypot(input.moveX, input.moveY);
    const target = len > 0.1 ? (input.sprint ? SPRINT_SPEED : WALK_SPEED) * Math.min(1, len) : 0;
    // You can steer a little in the air, but momentum mostly carries you.
    this.speed += (target - this.speed) * Math.min(1, dt * (this.airborne ? 1.5 : 8));
    if (len > 0.1) {
      const fx = -Math.sin(input.cameraYaw);
      const fz = -Math.cos(input.cameraYaw);
      const dx = fx * input.moveY - fz * input.moveX;
      const dz = fz * input.moveY + fx * input.moveX;
      let diff = Math.atan2(dx, dz) - this.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.heading += diff * Math.min(1, dt * (this.airborne ? 3 : 10));
    }

    const step = this.speed * dt;
    const mx = Math.sin(this.heading) * step;
    const mz = Math.cos(this.heading) * step;
    const canMoveTo = (x: number, z: number, len2: number) => {
      // Never trap anyone: already overlapping something (a respawn, a jump's arc), you may move
      // anywhere that overlaps no deeper, which lets you slide out but never through a wall.
      const P = this.platforms;
      if (P?.blocked?.(x, z, this.y)) {
        let clear = BODY_RADIUS;
        while (clear > 0.04 && P.blocked(this.x, this.z, this.y, clear)) clear -= 0.05;
        if (clear >= BODY_RADIUS || P.blocked(x, z, this.y, clear)) return false;
      }
      const g = this.ground(x, z);
      if (this.airborne) return g <= this.y + 0.15; // only a wall stops you mid-air
      if (g < WADE_DEPTH) return true; // deep water: wade on in and swim
      // On bare ground the hill itself decides, measured on the terrain rather than your feet (which
      // lag it, so the per-step allowance below would let you walk up a cliff in small steps).
      const t0 = this.world.height(this.x, this.z);
      const t1 = this.world.height(x, z);
      if (g - t1 < 0.05 && t1 > t0 && (t1 - t0) / Math.max(len2, 1e-3) > MAX_SLOPE) return false;
      return g - this.y <= STEP_UP || (g - this.y) / Math.max(len2, 1e-3) < MAX_CLIMB;
    };
    if (canMoveTo(this.x + mx, this.z + mz, step)) {
      this.x += mx;
      this.z += mz;
    } else if (canMoveTo(this.x + mx, this.z, Math.abs(mx))) {
      this.x += mx;
    } else if (canMoveTo(this.x, this.z + mz, Math.abs(mz))) {
      this.z += mz;
    } else if (!this.airborne) {
      this.speed *= 0.5;
    }
    this.resolve();

    const g = this.ground(this.x, this.z);
    if (!this.airborne) {
      if (jumped) {
        this.airborne = true;
        this.vy = JUMP_V;
        // Jumping commits you: an instant push the way you're steering, so a standing hop
        // off a small stone still carries. Running jumps go further.
        if (len > 0.1) {
          this.speed = Math.max(this.speed, input.sprint ? 5.0 : 3.6);
          const fx = -Math.sin(input.cameraYaw);
          const fz = -Math.cos(input.cameraYaw);
          this.heading = Math.atan2(fx * input.moveY - fz * input.moveX, fz * input.moveY + fx * input.moveX);
        }
        this.onEvent?.('jump');
      } else if (g < this.y - 0.6) {
        this.airborne = true; // stepped off an edge
        this.vy = 0;
      }
    }
    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      // Moth wings: holding jump on the way down turns the fall into a long glide.
      if (this.canGlide && input.jump && this.vy < -this.glideSink) {
        this.vy = -this.glideSink;
        this.speed = Math.max(this.speed, 5.5);
      }
      const ceiling = this.vy > 0 ? (this.platforms?.ceiling?.(this.x, this.z, this.y) ?? Infinity) : Infinity;
      this.y += this.vy * dt;
      if (this.y + HEAD > ceiling) {
        this.y = Math.max(ceiling - HEAD, this.y - this.vy * dt);
        this.vy = 0;
      }
      if (this.y <= Math.max(g, SWIM_Y) && this.vy <= 0 && g < WADE_DEPTH) {
        // Into the water: you go under with the fall's momentum, then come up swimming.
        this.enterSwim(Math.min(0, this.vy) * 0.25);
        this.onEvent?.('fall');
        return;
      }
      if (this.y <= g && this.vy <= 0) {
        this.y = g;
        this.airborne = false;
        this.vy = 0;
        this.onEvent?.('land');
      }
      this.pushOutOfWalls();
    } else {
      if (g < WADE_DEPTH) {
        // Walked off the shelf into deep water.
        this.enterSwim(0);
        this.onEvent?.('swim');
        return;
      }
      this.y += (Math.max(g, WADE_DEPTH) - this.y) * Math.min(1, dt * 18);
      // Remember solid footing so a missed jump puts you back somewhere sensible: dry land itself,
      // never a stone or post standing in the water, so falling off stepping stones means starting over.
      this.safeTimer += dt;
      if (g > -0.3 && this.world.height(this.x, this.z) > -0.3 && this.safeTimer > 0.25) {
        this.safe = { x: this.x, y: this.y, z: this.z };
        this.safeTimer = 0;
      }
    }
    this.anim = this.speed > 0.3 && !this.airborne ? 'walk' : 'idle';
    this.animRate = Math.max(0.6, this.speed / WALK_SPEED);

    // Boarding, or calling the boat to you from the water's edge.
    const db = Math.hypot(this.boat.x - this.x, this.boat.z - this.z);
    const boatAfloat = this.world.height(this.boat.x, this.boat.z) < BOAT_DRAFT * 0.5;
    this.prompt = '';
    if (db < 3.6 && boatAfloat && !this.airborne) {
      this.prompt = 'E   step into the boat';
      if (pressed) {
        this.mode = 'boat';
        this.speed = 0;
        this.boatCall = null;
        this.hasBoarded = true;
      }
    } else if (this.hasBoarded && db > 40 && !this.boatCall && !this.airborne) {
      const water = this.nearbyWater();
      if (water) {
        this.prompt = this.holdE > 0 ? 'calling...' : 'hold E   call the boat';
        if (this.holdE > 0.9) {
          this.boatCall = water;
          this.holdE = -999;
          this.onEvent?.('callBoat');
        }
      }
    }
  }

  /** True when the eye is below the water: diving. */
  get underwater() {
    return this.mode === 'swim' && this.y < SWIM_Y - 0.2;
  }

  private enterSwim(vy: number) {
    this.mode = 'swim';
    this.airborne = false;
    this.vy = vy;
    this.y = Math.min(this.y, SWIM_Y);
    this.speed = Math.min(this.speed, SWIM_SPRINT);
  }

  private swim(dt: number, input: PlayerInput, pressed: boolean, jumped: boolean) {
    const len = Math.hypot(input.moveX, input.moveY);
    const target = len > 0.1 ? (input.sprint ? SWIM_SPRINT : SWIM_SPEED) * Math.min(1, len) : 0;
    // Water drags: speed builds and fades slowly.
    this.speed += (target - this.speed) * Math.min(1, dt * 2.5);
    if (len > 0.1) {
      const fx = -Math.sin(input.cameraYaw);
      const fz = -Math.cos(input.cameraYaw);
      const dx = fx * input.moveY - fz * input.moveX;
      const dz = fz * input.moveY + fx * input.moveX;
      let diff = Math.atan2(dx, dz) - this.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.heading += diff * Math.min(1, dt * 5);
    }
    const atSurface = this.y > SWIM_Y - 0.15;

    // Up and down: Space rises, dive sinks, otherwise you float gently back to the surface. With no
    // breath left you're carried up whatever you do.
    const wantDown = !!input.dive && this.breath > 0;
    const vyTarget = wantDown ? -DIVE_SPEED : input.jump ? RISE_SPEED : this.y < SWIM_Y ? 0.7 : 0;
    this.vy += (vyTarget - this.vy) * Math.min(1, dt * 4);

    const step = this.speed * dt;
    const nx = this.x + Math.sin(this.heading) * step;
    const nz = this.z + Math.cos(this.heading) * step;
    const P = this.platforms;
    const terrain = this.world.height(nx, nz);
    const top = P?.top(nx, nz, this.y + CLIMB_OUT) ?? -Infinity;
    const wall = P?.blocked?.(nx, nz, this.y) ?? false;
    if (atSurface && terrain >= WADE_DEPTH && top < terrain + 0.05) {
      // Swum into the shallows: stand up and wade out.
      this.mode = 'walk';
      this.x = nx;
      this.z = nz;
      this.y = Math.max(terrain, WADE_DEPTH);
      this.vy = 0;
      this.breath = 1;
      this.onEvent?.('climbOut');
      return;
    }
    if (atSurface && top > SWIM_Y && top - this.y <= CLIMB_OUT && (jumped || pressed)) {
      // Haul yourself up onto a stone, a pier or a ledge.
      this.mode = 'walk';
      this.x = nx;
      this.z = nz;
      this.y = top;
      this.vy = 0;
      this.breath = 1;
      this.onEvent?.('climbOut');
      return;
    }
    // At the surface any water too deep to stand in can be swum; below it, rock above your feet stops you.
    const swimmable = !wall && top <= this.y + 0.2 && (atSurface || terrain < this.y + 0.2);
    if (swimmable) {
      this.x = nx;
      this.z = nz;
    } else this.speed *= 0.5;
    this.resolve();

    const floor = this.world.height(this.x, this.z) + 0.3;
    this.y = Math.min(SWIM_Y, Math.max(floor, this.y + this.vy * dt));
    if (this.y >= SWIM_Y && this.vy > 0) this.vy = 0;
    const under = this.y < SWIM_Y - 0.2;
    if (under) this.breath = Math.max(0, this.breath - dt / BREATH);
    else this.breath = Math.min(1, this.breath + dt / 4);
    if (this.wasUnder && !under) this.onEvent?.('surface');
    if (!this.wasUnder && under) this.onEvent?.('dive');
    this.wasUnder = under;
    this.anim = this.speed > 0.2 ? 'walk' : 'idle';
    this.animRate = Math.max(0.5, this.speed / SWIM_SPEED) * 0.6;

    // Boarding from the water.
    const db = Math.hypot(this.boat.x - this.x, this.boat.z - this.z);
    this.prompt = '';
    if (db < 3.6 && atSurface) {
      this.prompt = 'E   climb into the boat';
      if (pressed) {
        this.mode = 'boat';
        this.speed = 0;
        this.breath = 1;
        this.boatCall = null;
        this.hasBoarded = true;
      }
    } else if (atSurface && Number.isFinite(top) && top > SWIM_Y && top - this.y <= CLIMB_OUT) {
      this.prompt = 'Space   climb out';
    }
  }

  private nearbyWater(): { x: number; z: number } | null {
    for (let r = 2.5; r <= 10; r += 1.5)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = this.x + Math.sin(a) * r;
        const z = this.z + Math.cos(a) * r;
        if (this.world.height(x, z) < -0.9 && !(this.platforms?.blocksBoat(x, z, 1.5) ?? false)) return { x, z };
      }
    return null;
  }

  /** The called boat drifts to you across the water, ignoring the shallows like a dream would. */
  private glideCalledBoat(dt: number) {
    const c = this.boatCall;
    if (!c || this.mode === 'boat') return;
    const b = this.boat;
    const dx = c.x - b.x;
    const dz = c.z - b.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.8) {
      this.boatCall = null;
      return;
    }
    const v = Math.min(d, 6 * dt + d * 0.6 * dt);
    b.x += (dx / d) * v;
    b.z += (dz / d) * v;
    let diff = Math.atan2(dx, dz) - b.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    b.heading += diff * Math.min(1, dt * 1.5);
  }

  private row(dt: number, input: PlayerInput, pressed: boolean, jumped: boolean) {
    const b = this.boat;
    const pull = input.moveY;
    b.rowing = Math.abs(pull) > 0.1 || Math.abs(input.moveX) > 0.1;
    if (b.rowing) b.stroke = (b.stroke + dt / STROKE_PERIOD) % 1;
    else b.stroke += (0 - b.stroke) * Math.min(1, dt * 1.5);
    // Thrust arrives in pulses during the drive phase of each stroke, not as a constant push.
    const drive = Math.max(0, Math.sin(b.stroke * Math.PI * 2 - 0.4));
    b.speed += pull * drive * 3.2 * dt * (input.sprint ? 1.5 : 1);

    // Long stroke: Space on the catch, once per stroke, for a surge.
    const cycle = Math.floor(this.t / STROKE_PERIOD);
    if (jumped && b.rowing && this.strokeUsed !== cycle) {
      this.strokeUsed = cycle;
      const onCatch = b.stroke > 0.86 || b.stroke < 0.16;
      if (onCatch) {
        b.speed += 2.6 * Math.sign(pull || 1);
        this.onEvent?.('powerStroke');
      } else {
        b.speed += 0.4 * Math.sign(pull || 1);
        this.onEvent?.('weakStroke');
      }
    }
    b.speed = Math.max(-2.5, Math.min(BOAT_MAX, b.speed * Math.exp(-0.5 * dt)));
    const turn = -input.moveX * (0.55 + Math.min(1, Math.abs(b.speed) * 0.25)) * (b.rowing ? 1 : 0.3);
    b.heading += turn * dt;

    const f = this.world.flow?.(b.x, b.z) ?? { x: 0, z: 0 };
    const fm = Math.hypot(f.x, f.z);
    b.current += (Math.min(1, fm / 6) - b.current) * Math.min(1, dt * 2);
    const nx = b.x + (Math.sin(b.heading) * b.speed + f.x) * dt;
    const nz = b.z + (Math.cos(b.heading) * b.speed + f.z) * dt;
    const dirSign = Math.sign(b.speed || 1);
    const bowX = nx + Math.sin(b.heading) * 1.9 * dirSign;
    const bowZ = nz + Math.cos(b.heading) * 1.9 * dirSign;
    const blocked = (x: number, z: number) => this.world.height(x, z) >= BOAT_DRAFT || (this.platforms?.blocksBoat(x, z, 1.1) ?? false);
    if (!blocked(bowX, bowZ) && !blocked(nx, nz)) {
      b.x = nx;
      b.z = nz;
    } else {
      b.speed *= -0.2; // gentle bump off the shallows or a stone
    }
    // Currents gently swing the bow to follow them.
    if (fm > 0.5) {
      let diff = Math.atan2(f.x, f.z) - b.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      b.heading += diff * Math.min(1, dt * 0.25) * (b.rowing ? 0.3 : 1);
    }
    this.x = b.x;
    this.z = b.z;
    this.y = b.bob;
    this.heading = b.heading;
    this.anim = b.rowing ? 'row' : 'sit';
    this.animRate = 1;

    const shore = this.findShore();
    this.prompt = shore && Math.abs(b.speed) < 1.6 ? 'E   step ashore' : '';
    if (pressed && shore && this.prompt) {
      this.mode = 'walk';
      b.speed = 0;
      b.rowing = false;
      this.place(shore.x, shore.z, Math.atan2(shore.x - b.x, shore.z - b.z));
    }
  }

  private findShore(): { x: number; z: number } | null {
    let best: { x: number; z: number; d: number } | null = null;
    for (let r = 2.2; r <= 4.4; r += 0.7)
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = this.boat.x + Math.sin(a) * r;
        const z = this.boat.z + Math.cos(a) * r;
        const h = this.ground(x, z);
        if (h > 0.05 && h < 2.5 && (!best || r < best.d)) best = { x, z, d: r };
      }
    return best;
  }
}
