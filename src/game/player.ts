// Engine-agnostic player logic: walking, jumping, wading, boarding and rowing.
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
  /** Optionally push a walker at (x, z, y) back inside walls and rails. */
  confine?(x: number, z: number, y: number, body: number): { x: number; z: number } | null;
  /** True if something solid in the water blocks a hull at (x, z). */
  blocksBoat(x: number, z: number, radius: number): boolean;
}

export type PlayerEvent = 'jump' | 'land' | 'fall' | 'respawn' | 'powerStroke' | 'weakStroke' | 'callBoat';

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
}

export type Mode = 'walk' | 'boat';
export type Anim = 'idle' | 'walk' | 'row' | 'sit';

const BODY_RADIUS = 0.35;
const WALK_SPEED = 3.2;
const SPRINT_SPEED = 6.5;
const WADE_DEPTH = -0.85;
const MAX_CLIMB = 1.05; // rise per metre travelled
const STEP_UP = 0.5; // a ledge you can step onto without jumping
const JUMP_V = 5.4;
const GRAVITY = 14;
const BOAT_DRAFT = -0.4;
const STROKE_PERIOD = 1.7;
const BOAT_MAX = 9;

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
  onEvent: ((e: PlayerEvent) => void) | null = null;
  /** >0 while sinking after a missed jump; the view fades and you return to safe ground. */
  falling = 0;
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

  /** Push the walker out of trunks and the boat hull, sliding along them rather than stopping. */
  private resolve() {
    const c = this.platforms?.confine?.(this.x, this.z, this.y, BODY_RADIUS);
    if (c) {
      this.x = c.x;
      this.z = c.z;
    }
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

  place(x: number, z: number, heading: number) {
    this.x = x;
    this.z = z;
    this.y = Math.max(this.ground(x, z, Infinity), WADE_DEPTH);
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
        this.place(this.safe.x, this.safe.z, this.heading);
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
      const g = this.ground(x, z);
      if (this.airborne) return g <= this.y + 0.15; // only a wall stops you mid-air
      if (g < WADE_DEPTH) return false; // deep water: jump it or stay out
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
      if (this.canGlide && input.jump && this.vy < -1.6) {
        this.vy = -1.6;
        this.speed = Math.max(this.speed, 5.5);
      }
      this.y += this.vy * dt;
      if (this.y <= g && this.vy <= 0) {
        if (g < WADE_DEPTH) {
          this.falling = 1.3;
          this.airborne = false;
          this.onEvent?.('fall');
          return;
        }
        this.y = g;
        this.airborne = false;
        this.vy = 0;
        this.onEvent?.('land');
      }
    } else {
      this.y += (Math.max(g, WADE_DEPTH) - this.y) * Math.min(1, dt * 18);
      // Remember solid footing so a missed jump puts you back somewhere sensible.
      this.safeTimer += dt;
      if (g > -0.3 && this.safeTimer > 0.25) {
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
