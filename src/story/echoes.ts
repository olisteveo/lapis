import * as THREE from 'three/webgpu';
import { abs, color, float, hash, mix, normalView, positionLocal, sin, time, uniform } from 'three/tsl';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE } from '../config';

type Pose = 'stand' | 'point' | 'sit' | 'lookUp';

export interface EchoDef {
  id: string;
  line: string;
  x: number;
  y: number;
  z: number;
  /** Direction the pair faces, radians (three yaw: 0 faces +Z). */
  yaw: number;
  adult: Pose;
  child: Pose;
  /** Child offset from the adult in the pair's local frame (x right, z forward). */
  childOffset: [number, number];
}

interface Live {
  def: EchoDef;
  group: THREE.Group;
  fade: { value: number };
  mixers: THREE.AnimationMixer[];
  overrides: (() => void)[];
  state: 'waiting' | 'dissolving' | 'gone';
}

/**
 * Memory echoes: two figures made of light, a parent and a small child, replaying a moment
 * in the place it happened. They dissolve as you come close, and her voice is left behind.
 */
export class Echoes {
  readonly group = new THREE.Group();
  private live: Live[] = [];
  onTrigger: ((def: EchoDef) => void) | null = null;

  constructor(private defs: EchoDef[], private seen: (id: string) => boolean) {
    this.group.name = 'echoes';
  }

  load(keeper: GLTF) {
    for (const def of this.defs) {
      if (this.seen(def.id)) continue;
      const fade = uniform(0);
      const mat = this.material(fade);
      const group = new THREE.Group();
      group.position.set(def.x, def.y, def.z);
      group.rotation.y = def.yaw;
      const mixers: THREE.AnimationMixer[] = [];
      const overrides: (() => void)[] = [];
      const make = (pose: Pose, scale: number, offset: [number, number]) => {
        const body = cloneSkinned(keeper.scene);
        body.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.material = mat;
            m.frustumCulled = false;
          }
        });
        body.scale.setScalar(scale);
        body.position.set(offset[0], 0, offset[1]);
        const mixer = new THREE.AnimationMixer(body);
        const clip = keeper.animations.find((a) => a.name === (pose === 'sit' ? 'sit' : 'idle'));
        if (clip) mixer.clipAction(clip).play();
        mixers.push(mixer);
        // Sanitised glTF bone names drop the dot: "upperarm.R" -> "upperarmR".
        const bone = (n: string) => body.getObjectByName(n);
        if (pose === 'point') {
          const arm = bone('upperarmR');
          const fore = bone('forearmR');
          const head = bone('head');
          overrides.push(() => {
            if (arm) arm.rotation.set(-2.5, 0, -0.25);
            if (fore) fore.rotation.set(-0.15, 0, 0);
            if (head) head.rotation.x = -0.45;
          });
        } else if (pose === 'lookUp') {
          const head = bone('head');
          const neck = bone('neck');
          overrides.push(() => {
            if (head) head.rotation.x = -0.6;
            if (neck) neck.rotation.x = -0.2;
          });
        }
        group.add(body);
      };
      make(def.adult, 1, [0, 0]);
      make(def.child, 0.58, def.childOffset);
      this.group.add(group);
      this.live.push({ def, group, fade, mixers, overrides, state: 'waiting' });
    }
  }

  private material(fade: { value: number }) {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // Brighter at the silhouette edge, faint in the middle: a figure drawn in light.
    const rim = float(1).sub(abs(normalView.z)).pow(1.6);
    const shimmer = hash(positionLocal.y.mul(40).floor().add(time.mul(12).floor())).mul(0.35).add(0.75);
    const breathe = sin(time.mul(0.8)).mul(0.1).add(0.9);
    mat.colorNode = mix(color(0xffe2b8), color(PALETTE.starGold), rim)
      .mul(rim.mul(1.1).add(0.12))
      .mul(shimmer)
      .mul(breathe)
      .mul(fade as never);
    return mat;
  }

  update(dt: number, player: THREE.Vector3) {
    for (const e of this.live) {
      if (e.state === 'gone') continue;
      const d = Math.hypot(e.def.x - player.x, e.def.z - player.z);
      for (const m of e.mixers) m.update(dt);
      for (const o of e.overrides) o();
      if (e.state === 'waiting') {
        // Fade in as you come within sight; start dissolving when you're close.
        const target = d < 160 ? 1 : 0;
        e.fade.value += (target - e.fade.value) * Math.min(1, dt * 0.8);
        if (d < 11) {
          e.state = 'dissolving';
          this.onTrigger?.(e.def);
        }
      } else {
        e.fade.value = Math.max(0, e.fade.value - dt * 0.35);
        e.group.position.y += dt * 0.25;
        if (e.fade.value <= 0) {
          e.state = 'gone';
          e.group.visible = false;
        }
      }
    }
  }
}
