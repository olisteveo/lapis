import * as THREE from 'three/webgpu';
import { color, length, max, smoothstep, uniform, uv, vec2 } from 'three/tsl';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { PrologueLayout, P } from '../core/placement';

/** Small footprints walking into the sea: water-filled, catching the starlight. */
export function createFootprints(layout: PrologueLayout, height: (x: number, z: number) => number) {
  const geo = new THREE.PlaneGeometry(0.12, 0.27);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const p = uv().sub(0.5).mul(vec2(2, 2));
  // Heel and ball of a child's foot as two soft ovals.
  const heel = length(p.sub(vec2(0, -0.45)).mul(vec2(1.25, 1.7)));
  const ball = length(p.sub(vec2(0.06, 0.35)).mul(vec2(1.0, 1.35)));
  const foot = max(smoothstep(0.55, 0.3, heel), smoothstep(0.62, 0.36, ball));
  mat.colorNode = color(0x9fb4ff).mul(1.4);
  mat.opacityNode = foot.mul(0.55);
  const mesh = new THREE.InstancedMesh(geo, mat, layout.footprints.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  layout.footprints.forEach((f, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw + (f.left ? 0.08 : -0.08));
    s.set(f.left ? -1 : 1, 1, 1);
    m.compose(new THREE.Vector3(f.x, height(f.x, f.z) + 0.02, f.z), q, s);
    mesh.setMatrixAt(i, m);
  });
  mesh.frustumCulled = false;
  mesh.name = 'footprints';
  return mesh;
}

/** The note: a scrap of paper under a stone, just above the tideline. */
export function createNote(at: P, height: (x: number, z: number) => number) {
  const g = new THREE.Group();
  const y = height(at.x, at.z);
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.16).rotateX(-Math.PI / 2),
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xe8dccb).multiplyScalar(0.55), side: THREE.DoubleSide }),
  );
  paper.rotation.y = 0.4;
  paper.position.y = 0.01;
  const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), new THREE.MeshStandardNodeMaterial({ color: 0x1a1d33, roughness: 0.9 }));
  stone.scale.set(1, 0.55, 0.8);
  stone.position.set(0.04, 0.03, -0.02);
  g.add(paper, stone);
  g.position.set(at.x, y + 0.01, at.z);
  g.name = 'note';
  return g;
}

/**
 * The distant figure: a silhouette at the waterline, always a beach away, gone when you
 * come close. Shares the Keeper's rig; the story knows who it really is.
 */
export class DistantFigure {
  readonly group = new THREE.Group();
  private fade = uniform(0);
  private spot = 0;
  private visibleTarget = 1;
  private mixer: THREE.AnimationMixer | null = null;
  vanished = 0;

  constructor(private spots: P[], private height: (x: number, z: number) => number) {
    this.group.name = 'distantFigure';
  }

  load(gltf: GLTF) {
    const body = cloneSkinned(gltf.scene);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true });
    // Pure silhouette: it reads as a cut-out against wet sand and sea.
    mat.colorNode = color(0x04050d);
    mat.opacityNode = this.fade;
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = mat;
        mesh.frustumCulled = false;
      }
    });
    body.scale.setScalar(0.93);
    this.group.add(body);
    this.mixer = new THREE.AnimationMixer(body);
    const idle = gltf.animations.find((a) => a.name === 'idle');
    if (idle) this.mixer.clipAction(idle).play();
    this.moveTo(0);
  }

  private moveTo(i: number) {
    this.spot = i;
    const s = this.spots[i];
    if (!s) return;
    this.group.position.set(s.x, Math.max(this.height(s.x, s.z), -0.2), s.z);
    this.visibleTarget = 1;
  }

  /** Advance to the next beach once the player has progressed. */
  advance() {
    if (this.spot + 1 < this.spots.length) this.moveTo(this.spot + 1);
  }

  /** Returns true on the frame the figure vanishes. */
  update(dt: number, camera: THREE.Camera): boolean {
    this.mixer?.update(dt);
    const p = this.group.position;
    const d = Math.hypot(camera.position.x - p.x, camera.position.z - p.z);
    // Faces you. Always.
    this.group.rotation.y = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
    let vanishedNow = false;
    if (this.visibleTarget === 1 && d < 75) {
      this.visibleTarget = 0;
      this.vanished++;
      vanishedNow = true;
    }
    this.fade.value += (this.visibleTarget - this.fade.value) * Math.min(1, dt * (this.visibleTarget ? 0.5 : 2.5));
    this.group.visible = this.fade.value > 0.01;
    return vanishedNow;
  }
}
