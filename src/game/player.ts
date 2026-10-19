// Engine-agnostic player logic: walking, wading, boarding and rowing.
// No three.js here on purpose; this maps 1:1 onto an s&box component later.

export interface WorldQuery {
  height(x: number, z: number): number;
}

/** Circular solids the walker can't pass through (tree trunks, the beached hull). */
export interface Colliders {
  /** Visits every collider near (x, z) as (cx, cz, radius). */
  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void): void;
}

const BODY_RADIUS = 0.35;

export interface PlayerInput {
  /** Raw stick/keys: x = right, y = forward, each -1..1. */
  moveX: number;
  moveY: number;
  sprint: boolean;
  interact: boolean;
  /** Camera yaw in radians; walking is camera-relative. */
  cameraYaw: number;
}

export type Mode = 'walk' | 'boat';
export type Anim = 'idle' | 'walk' | 'row' | 'sit';

const WALK_SPEED = 3.2;
const SPRINT_SPEED = 6.5;
const WADE_DEPTH = -0.85;
const MAX_CLIMB = 1.05; // rise per metre travelled
const BOAT_DRAFT = -0.4;
const STROKE_PERIOD = 1.7;

export interface BoatState {
  x: number;
  z: number;
  heading: number;
  speed: number;
  /** 0..1 position in the rowing cycle; 0 = catch. */
  stroke: number;
  rowing: boolean;
  bob: number;
}

export class PlayerController {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  speed = 0;
  mode: Mode = 'walk';
  anim: Anim = 'idle';
  animRate = 1;
  prompt = '';
  boat: BoatState = { x: 0, z: 0, heading: 0, speed: 0, stroke: 0, rowing: false, bob: 0 };
  private interactLatch = false;
  private t = 0;

  colliders: Colliders | null = null;

  constructor(private world: WorldQuery) {}

  /** Push the walker out of trunks and the boat hull, sliding along them rather than stopping. */
  private resolve() {
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
    if (d < min && d > 1e-4) {
      this.x = px + (dx / d) * min;
      this.z = pz + (dz / d) * min;
    }
  }

  place(x: number, z: number, heading: number) {
    this.x = x;
    this.z = z;
    this.y = Math.max(this.world.height(x, z), WADE_DEPTH);
    this.heading = heading;
  }

  placeBoat(x: number, z: number, heading: number) {
    Object.assign(this.boat, { x, z, heading, speed: 0, stroke: 0 });
  }

  update(dt: number, input: PlayerInput) {
    this.t += dt;
    const pressed = input.interact && !this.interactLatch;
    this.interactLatch = input.interact;
    if (this.mode === 'walk') this.walk(dt, input, pressed);
    else this.row(dt, input, pressed);
    this.boat.bob = Math.sin(this.t * 1.3) * 0.04 + Math.sin(this.t * 0.7 + 1) * 0.03;
  }

  private walkable(x: number, z: number, fromH: number, stepLen: number) {
    const h = this.world.height(x, z);
    if (h < WADE_DEPTH) return false;
    return (h - fromH) / Math.max(stepLen, 1e-3) < MAX_CLIMB;
  }

  private walk(dt: number, input: PlayerInput, pressed: boolean) {
    const len = Math.hypot(input.moveX, input.moveY);
    const target = len > 0.1 ? (input.sprint ? SPRINT_SPEED : WALK_SPEED) * Math.min(1, len) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 8);
    if (len > 0.1) {
      // Camera forward is -Z rotated by yaw.
      const fx = -Math.sin(input.cameraYaw);
      const fz = -Math.cos(input.cameraYaw);
      const rx = -fz;
      const rz = fx;
      const dx = fx * input.moveY + rx * input.moveX;
      const dz = fz * input.moveY + rz * input.moveX;
      const want = Math.atan2(dx, dz);
      let diff = want - this.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.heading += diff * Math.min(1, dt * 10);
    }
    const step = this.speed * dt;
    const hNow = this.world.height(this.x, this.z);
    const mx = Math.sin(this.heading) * step;
    const mz = Math.cos(this.heading) * step;
    if (this.walkable(this.x + mx, this.z + mz, hNow, step)) {
      this.x += mx;
      this.z += mz;
    } else if (this.walkable(this.x + mx, this.z, hNow, Math.abs(mx))) {
      this.x += mx;
    } else if (this.walkable(this.x, this.z + mz, hNow, Math.abs(mz))) {
      this.z += mz;
    } else {
      this.speed *= 0.5;
    }
    this.resolve();
    const ground = Math.max(this.world.height(this.x, this.z), WADE_DEPTH);
    this.y += (ground - this.y) * Math.min(1, dt * 18);
    this.anim = this.speed > 0.3 ? 'walk' : 'idle';
    this.animRate = Math.max(0.6, this.speed / WALK_SPEED);

    const db = Math.hypot(this.boat.x - this.x, this.boat.z - this.z);
    const boatAfloat = this.world.height(this.boat.x, this.boat.z) < BOAT_DRAFT * 0.5;
    this.prompt = db < 3.6 && boatAfloat ? 'E   step into the boat' : '';
    if (pressed && this.prompt) {
      this.mode = 'boat';
      this.speed = 0;
    }
  }

  private row(dt: number, input: PlayerInput, pressed: boolean) {
    const b = this.boat;
    const pull = input.moveY;
    b.rowing = Math.abs(pull) > 0.1 || Math.abs(input.moveX) > 0.1;
    if (b.rowing) b.stroke = (b.stroke + dt / STROKE_PERIOD) % 1;
    else b.stroke += (0 - b.stroke) * Math.min(1, dt * 1.5);
    // Thrust arrives in pulses during the drive phase of each stroke, not as a constant push.
    const drive = Math.max(0, Math.sin(b.stroke * Math.PI * 2 - 0.4));
    b.speed += pull * drive * 3.2 * dt * (input.sprint ? 1.5 : 1);
    b.speed *= Math.exp(-0.55 * dt);
    const turn = -input.moveX * (0.55 + Math.min(1, Math.abs(b.speed) * 0.25)) * (b.rowing ? 1 : 0.3);
    b.heading += turn * dt;

    const nx = b.x + Math.sin(b.heading) * b.speed * dt;
    const nz = b.z + Math.cos(b.heading) * b.speed * dt;
    const bowX = nx + Math.sin(b.heading) * 1.9 * Math.sign(b.speed || 1);
    const bowZ = nz + Math.cos(b.heading) * 1.9 * Math.sign(b.speed || 1);
    if (this.world.height(bowX, bowZ) < BOAT_DRAFT && this.world.height(nx, nz) < BOAT_DRAFT) {
      b.x = nx;
      b.z = nz;
    } else {
      b.speed *= -0.2; // gentle bump off the shallows
    }
    this.x = b.x;
    this.z = b.z;
    this.y = b.bob;
    this.heading = b.heading;
    this.anim = b.rowing ? 'row' : 'sit';
    this.animRate = 1;

    const shore = this.findShore();
    this.prompt = shore && Math.abs(b.speed) < 1.2 ? 'E   step ashore' : '';
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
        const h = this.world.height(x, z);
        if (h > 0.05 && h < 2.5 && (!best || r < best.d)) best = { x, z, d: r };
      }
    return best;
  }
}
