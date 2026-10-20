import * as THREE from 'three/webgpu';
import { KEEPSAKES, dressKeepsake, type KeepsakeId } from '../story/keepsakes';

interface Pose {
  /** Where it sits in front of the eye, in camera space (x right, y up, -z ahead). */
  at: [number, number, number];
  /** Extra turn in camera space, so its best side shows. */
  turn: [number, number, number];
  /** Its largest dimension once held, in metres. */
  size: number;
}

// Each is held the way you would hold it: the shell up to your ear, the wings spread in front of you,
// the lantern out to the side, the compass flat in your palm, the ribbon looped over your fingers.
const POSES: Record<KeepsakeId, Pose> = {
  shell: { at: [0.25, -0.06, -0.4], turn: [0.2, -0.9, 0.3], size: 0.14 },
  wings: { at: [0, -0.16, -0.8], turn: [-0.15, 0, 0], size: 0.45 },
  lantern: { at: [0.23, -0.14, -0.62], turn: [0, 0.3, 0], size: 0.2 },
  compass: { at: [0.05, -0.13, -0.42], turn: [0.85, Math.PI, 0], size: 0.14 },
  ribbon: { at: [0.2, -0.15, -0.55], turn: [0.1, -0.2, 0], size: 0.2 },
};

const NEEDLE_LIFT = 0.052;

/**
 * A keepsake raised in first person. One at a time: switching lowers the current one out of view
 * before the next comes up. The Keeper's hands are never drawn, only the thing they hold.
 */
export class HeldKeepsake {
  readonly group = new THREE.Group();
  private holders = new Map<KeepsakeId, THREE.Group>();
  private needle: THREE.Object3D | null = null;
  private needleYaw = 0;
  private lamp = new THREE.PointLight(0xffb060, 0, 9, 1.6);
  private showing: KeepsakeId | null = null;
  private raise = 0;
  private t = 0;
  private mirror = false;

  constructor() {
    this.group.name = 'held';
    this.group.visible = false;
  }

  /** Builds the held versions from keepsakes.glb (Held_<id>, plus the compass's own needle). */
  setModels(templates: THREE.Object3D) {
    for (const def of KEEPSAKES) {
      const t = templates.getObjectByName(`Held_${def.id}`);
      if (!t) continue;
      const pose = POSES[def.id];
      const model = t.clone(true);
      dressKeepsake(model, true, def.tint, 0);
      const box = new THREE.Box3().setFromObject(model);
      const dim = box.getSize(new THREE.Vector3());
      model.scale.setScalar(pose.size / Math.max(dim.x, dim.y, dim.z, 1e-3));
      if (def.id === 'compass') {
        const n = templates.getObjectByName('Held_needle')?.clone(true);
        if (n) {
          dressKeepsake(n, true, def.tint, 0);
          n.position.set(0, NEEDLE_LIFT, 0);
          model.add(n);
          this.needle = n;
        }
      }
      const holder = new THREE.Group();
      holder.add(model);
      if (def.id === 'lantern') holder.add(this.lamp);
      holder.visible = false;
      this.holders.set(def.id, holder);
      this.group.add(holder);
    }
  }

  setMirror(mirror: boolean) {
    this.mirror = mirror;
    this.group.visible = !mirror && this.raise > 0.01;
  }

  /** Which keepsake is fully up (effects that need it in hand wait for the raise). */
  get raised(): KeepsakeId | null {
    return this.raise > 0.6 ? this.showing : null;
  }

  /**
   * held: what the Keeper wants in hand. needleTo: where the compass should point (world x, z), or null
   * to let it wander. speed: walking speed, for the sway.
   */
  update(dt: number, camera: THREE.Camera, held: KeepsakeId | null, needleTo: { x: number; z: number } | null, speed: number) {
    this.t += dt;
    if (held !== this.showing) {
      this.raise = Math.max(0, this.raise - dt * 4);
      if (this.raise === 0) this.showing = held;
    } else if (held) this.raise = Math.min(1, this.raise + dt * 3);
    for (const [id, h] of this.holders) h.visible = id === this.showing;
    this.group.visible = !this.mirror && this.raise > 0.01 && !!this.showing;
    this.lamp.intensity = this.showing === 'lantern' ? this.raise * (1.5 + Math.sin(this.t * 11) * 0.08) : 0;
    if (!this.showing) return;
    const pose = POSES[this.showing];
    const ease = this.raise * this.raise * (3 - 2 * this.raise);
    const walk = Math.min(1, speed / 3.2);
    const bob = Math.sin(this.t * 6.5) * 0.008 * walk + Math.sin(this.t * 1.3) * 0.004;
    const holder = this.holders.get(this.showing)!;
    camera.updateMatrixWorld();
    const off = new THREE.Vector3(pose.at[0], pose.at[1] - (1 - ease) * 0.45 + bob, pose.at[2]).applyQuaternion(camera.quaternion);
    holder.position.copy(camera.position).add(off);
    const swing = this.showing === 'lantern' ? Math.sin(this.t * 1.7) * 0.08 * (0.4 + walk) : 0;
    holder.quaternion.copy(camera.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.turn[0], pose.turn[1], pose.turn[2] + swing)));
    holder.updateMatrixWorld(true);

    if (this.needle && this.showing === 'compass') {
      let want = this.needleYaw + Math.sin(this.t * 0.9) * 0.6 * dt;
      if (needleTo) {
        // The dial is tilted toward the eye, so find the needle angle whose heading, seen from above,
        // is the target's: a coarse sweep, then a finer one round the best.
        const heading = Math.atan2(needleTo.x - camera.position.x, needleTo.z - camera.position.z);
        const q = new THREE.Quaternion();
        this.needle.parent!.getWorldQuaternion(q);
        const v = new THREE.Vector3();
        const miss = (a: number) => {
          v.set(Math.cos(a), 0, -Math.sin(a)).applyQuaternion(q);
          const d = Math.atan2(v.x, v.z) - heading;
          return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
        };
        let best = 0;
        for (let k = 0; k < 72; k++) if (miss((k / 72) * Math.PI * 2) < miss(best)) best = (k / 72) * Math.PI * 2;
        const coarse = best;
        for (let k = -10; k <= 10; k++) if (miss(coarse + k * 0.01) < miss(best)) best = coarse + k * 0.01;
        want = best + Math.sin(this.t * 3.1) * 0.04;
      }
      let diff = want - this.needleYaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.needleYaw += diff * Math.min(1, dt * 4);
      this.needle.rotation.y = this.needleYaw;
    }
  }
}
