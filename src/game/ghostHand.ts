import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, float, floor, hash, mx_noise_float, normalize, normalWorld, positionLocal, positionWorld, sin, smoothstep, time, uniform } from 'three/tsl';

/**
 * The look of the Keeper's hand (Hand_<id> in keepsakes.glb): a shadow more than a hand, dark and
 * smoky in the middle with a cold light at its edges, thinning away toward the wrist so it never
 * shows where it ends, with a few motes drifting inside as if it were made of starlight.
 */
export function ghostHandMaterial(fade: { value: number }) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide });
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = dot(normalWorld, view).abs();
  const rim: any = float(1).sub(facing).pow(2.4);
  const p = positionLocal;
  // Smoke drifting through it: the shadow is never quite the same shape twice.
  const smoke = mx_noise_float(p.mul(38).add(time.mul(0.35)) as never).mul(0.5).add(0.5);
  const cell = floor(p.mul(120));
  const mote: any = smoothstep(0.95, 1, hash(cell.x.add(cell.y.mul(57)).add(cell.z.mul(113)))).mul(sin(time.mul(2.1).add(cell.x)).mul(0.5).add(0.5));
  mat.colorNode = (color(0x1c2148) as any).add(color(0x9fb6ff).mul(rim.mul(1.5))).add(color(0x3a4a8a).mul(facing.mul(0.25))).add(color(0xdfe8ff).mul(mote.mul(0.7)));
  // Fingers toward -z; the wrist sits at about +0.085 and dissolves before it.
  const wrist = smoothstep(0.085, 0.02, p.z);
  mat.opacityNode = rim.mul(0.5).add(0.5).mul(smoke.mul(0.35).add(0.75)).mul(wrist).mul(fade as never).min(1);
  return mat;
}

/** One hand per keepsake grip, sharing one material and one fade. */
export class GhostHands {
  readonly group = new THREE.Group();
  readonly fade = uniform(0);
  private hands = new Map<string, THREE.Object3D>();

  setModels(templates: THREE.Object3D, ids: readonly string[]) {
    const mat = ghostHandMaterial(this.fade);
    for (const id of ids) {
      const t = templates.getObjectByName(`Hand_${id}`);
      if (!t) continue;
      const hand = t.clone(true);
      hand.position.set(0, 0, 0);
      hand.rotation.set(0, 0, 0);
      hand.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = mat;
          m.renderOrder = 6;
          m.frustumCulled = false;
        }
      });
      hand.visible = false;
      this.hands.set(id, hand);
      this.group.add(hand);
    }
  }

  show(id: string | null) {
    for (const [k, h] of this.hands) h.visible = k === id;
  }
}
