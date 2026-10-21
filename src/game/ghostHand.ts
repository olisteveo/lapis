import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, float, hash, floor, normalize, normalWorld, positionLocal, positionWorld, sin, smoothstep, time, uniform } from 'three/tsl';

/**
 * The Keeper's hand, as it is in her memory: a shadowy, half-there right hand that holds whatever
 * keepsake is raised. Built from simple capsules, palm up with the fingers pointing away (-z) and the
 * thumb to the left; `curl` closes the fingers from an open palm (0) to a fist (about 1.4).
 */
export class GhostHand {
  readonly group = new THREE.Group();
  readonly fade = uniform(0);
  private fingers: { knuckle: THREE.Group; mid: THREE.Group }[] = [];
  private thumb: THREE.Group;

  constructor() {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const view = normalize(cameraPosition.sub(positionWorld));
    const rim = float(1).sub(dot(normalWorld, view).abs()).pow(2.2);
    // A few cold motes drift inside it, as if it were made of the same light as the stars.
    const cell = floor(positionLocal.mul(90));
    const mote = smoothstep(0.93, 1, hash(cell.x.add(cell.y.mul(57)).add(cell.z.mul(113)))).mul(sin(time.mul(2.3).add(cell.x)).mul(0.5).add(0.5));
    mat.colorNode = color(0x7f95e6).mul(rim.mul(0.9).add(0.12)).add(color(0xd8e4ff).mul(mote).mul(0.5)).mul(this.fade);

    const capsule = (r: number, len: number) => {
      const g = new THREE.CapsuleGeometry(r, len, 3, 8);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, -len / 2);
      return new THREE.Mesh(g, mat);
    };
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.024, 0.088, 2, 1, 2), mat);
    palm.position.set(0, 0, 0);
    this.group.add(palm);
    // Index to little finger, left to right as seen from above with the palm up.
    const spec: [number, number][] = [
      [-0.03, 0.072],
      [-0.01, 0.08],
      [0.011, 0.076],
      [0.031, 0.062],
    ];
    for (const [x, len] of spec) {
      const knuckle = new THREE.Group();
      knuckle.position.set(x, 0.002, -0.044);
      const proximal = capsule(0.0085, len * 0.5);
      const mid = new THREE.Group();
      mid.position.set(0, 0, -len * 0.5);
      mid.add(capsule(0.0078, len * 0.5));
      knuckle.add(proximal, mid);
      this.group.add(knuckle);
      this.fingers.push({ knuckle, mid });
    }
    this.thumb = new THREE.Group();
    this.thumb.position.set(-0.042, 0, 0.01);
    this.thumb.rotation.set(0, 0.9, 0);
    const t1 = capsule(0.0095, 0.03);
    const t2 = capsule(0.0085, 0.028);
    t2.position.set(0, 0, -0.03);
    this.thumb.add(t1, t2);
    this.group.add(this.thumb);
    this.group.renderOrder = 6;
  }

  /** 0 open palm, about 1.4 a closed fist. */
  set curl(c: number) {
    for (const f of this.fingers) {
      f.knuckle.rotation.x = c * 0.6;
      f.mid.rotation.x = c * 0.8;
    }
    this.thumb.rotation.x = c * 0.35;
    this.thumb.rotation.y = 0.9 - c * 0.35;
  }
}
