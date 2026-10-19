import * as THREE from 'three/webgpu';
import type { WorldQuery, PlayerController } from './player';
import type { Input } from './input';

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const EYE = 1.62;
// Seated eye point in boat-local space (bow toward +X), just aft of the oarlocks.
const BOAT_EYE = new THREE.Vector3(-0.15, 0.68, 0);

/**
 * First person. The Keeper is never seen: no body, no reflection, no face. Only the world
 * and the things the Keeper touches (the boat, the oars, the lantern) are ever visible.
 */
export class CameraRig {
  private stepPhase = 0;
  private eyeY = 0;
  private lastBoatHeading = 0;
  private wasBoat = false;
  private boatEye = new THREE.Vector3();
  private lastStep = 0;
  /** Fired once per footfall, synced to the head-bob. */
  onStep: ((speed: number) => void) | null = null;

  constructor(private camera: THREE.PerspectiveCamera, private world: WorldQuery) {
    camera.rotation.order = 'YXZ';
  }

  private aim(input: Input, roll = 0) {
    this.camera.rotation.set(input.pitch, input.yaw, roll);
  }

  follow(dt: number, p: PlayerController, input: Input, boatObject: THREE.Object3D) {
    if (p.mode === 'boat') {
      // The view turns with the hull, so steering the boat steers your gaze.
      if (!this.wasBoat) {
        input.yaw = p.boat.heading + Math.PI;
        this.lastBoatHeading = p.boat.heading;
      }
      input.yaw += p.boat.heading - this.lastBoatHeading;
      this.lastBoatHeading = p.boat.heading;
      boatObject.updateMatrixWorld();
      this.boatEye.copy(BOAT_EYE).applyMatrix4(boatObject.matrixWorld);
      // Lean back a little on each drive stroke.
      const lean = p.boat.rowing ? Math.sin(p.boat.stroke * Math.PI * 2) * 0.06 : 0;
      this.boatEye.x -= Math.sin(p.boat.heading) * lean;
      this.boatEye.z -= Math.cos(p.boat.heading) * lean;
      this.camera.position.copy(this.boatEye);
      this.aim(input, Math.sin(p.boat.bob * 20) * 0.02);
      this.wasBoat = true;
      this.eyeY = this.boatEye.y;
      return;
    }
    this.wasBoat = false;
    const moving = Math.min(1, p.speed / 3.2);
    this.stepPhase += dt * (5.2 + p.speed * 0.9) * (moving > 0.05 ? 1 : 0);
    const bob = Math.sin(this.stepPhase * 2) * 0.035 * moving;
    const step = Math.floor((this.stepPhase * 2 + Math.PI / 2) / (Math.PI * 2));
    if (step !== this.lastStep && moving > 0.1) this.onStep?.(p.speed);
    this.lastStep = step;
    const sway = Math.sin(this.stepPhase) * 0.025 * moving;
    const target = p.y + EYE + bob;
    // Ease vertical changes so stepping up roots and dunes doesn't jolt the view.
    this.eyeY += (target - this.eyeY) * Math.min(1, dt * 14);
    const rx = Math.cos(input.yaw);
    const rz = -Math.sin(input.yaw);
    this.camera.position.set(p.x + rx * sway, Math.max(this.eyeY, this.world.height(p.x, p.z) + 0.4), p.z + rz * sway);
    this.aim(input, sway * 0.15);
  }

  /**
   * Opening: on your back in the surf, staring straight up. A star falls. You sit up, and
   * the world comes into view.
   */
  intro(t: number, p: PlayerController, input: Input) {
    const ground = Math.max(this.world.height(p.x, p.z), -0.3);
    const rise = ease((t - 9) / 4.5);
    const breathe = Math.sin(t * 0.9) * 0.012 * (1 - rise);
    this.eyeY = ground + 0.28 + (EYE - 0.28) * rise + breathe;
    this.camera.position.set(p.x, this.eyeY, p.z);
    // Mouse can wander a little while lying there; sitting up brings the gaze to the horizon.
    const lookUp = 1.28;
    const pitch = lookUp + (input.pitch - lookUp) * rise;
    this.camera.rotation.set(pitch, input.yaw, Math.sin(t * 0.4) * 0.03 * (1 - rise));
  }
}
