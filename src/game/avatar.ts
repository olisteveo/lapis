import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Anim, PlayerController } from './player';

// Boat-local seat for the rower (three.js axes, bow toward +X), tuned against the mesh.
const SEAT = new THREE.Vector3(-0.07, -0.52, 0);

export class Avatar {
  readonly keeper = new THREE.Group();
  readonly boat = new THREE.Group();
  private mixer!: THREE.AnimationMixer;
  private actions = new Map<Anim, THREE.AnimationAction>();
  private current: Anim | null = null;
  private oars: THREE.Object3D[] = [];
  private lantern: THREE.PointLight;
  /** Lying-down blend for the opening shot: 1 = on the sand, 0 = standing. */
  lying = 0;

  constructor() {
    this.keeper.name = 'keeper';
    this.boat.name = 'boat';
    this.lantern = new THREE.PointLight(0xffa060, 1.2, 9, 2);
  }

  async load(keeperUrl: string, boatUrl: string) {
    const loader = new GLTFLoader();
    const [k, b] = await Promise.all([loader.loadAsync(keeperUrl), loader.loadAsync(boatUrl)]);
    this.keeper.add(k.scene);
    k.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.frustumCulled = false;
    });
    this.mixer = new THREE.AnimationMixer(k.scene);
    for (const clip of k.animations) {
      const action = this.mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(0);
      this.actions.set(clip.name as Anim, action);
    }
    this.boat.add(b.scene, this.waterMask());
    b.scene.traverse((o) => {
      if (/^Oar[LR]/.test(o.name)) this.oars.push(o);
      if (o.name === 'Lantern') {
        this.lantern.position.set(0.12, 0.3, 0);
        o.add(this.lantern);
      }
      const m = o as THREE.Mesh;
      const std = m.material as THREE.MeshStandardMaterial | undefined;
      // Night scene: Blender base colours are daylight values, so pull the boat down to match.
      if (m.isMesh && std?.color && std.name !== 'lantern_glow') std.color.multiplyScalar(0.45);
      if (m.isMesh && m.material && (m.material as THREE.Material).name === 'lantern_glow') {
        const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xffb070).multiplyScalar(1.6) });
        m.material = mat;
      }
    });
  }

  /**
   * Depth-only deck at the waterline, drawn after the boat but before the water, so the sea
   * surface (and its shoreline foam) never renders inside the hull.
   */
  private waterMask() {
    const shape = new THREE.Shape();
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const halfBeam = 0.62 * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * u)), 0.55);
      pts.push(new THREE.Vector2((u - 0.5) * 3.6, halfBeam));
    }
    for (let i = 24; i >= 0; i--) pts.push(new THREE.Vector2(pts[i].x, -pts[i].y));
    shape.setFromPoints(pts);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicNodeMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const mask = new THREE.Mesh(geo, mat);
    mask.position.y = 0.03;
    mask.renderOrder = 0.9;
    mask.name = 'boatWaterMask';
    return mask;
  }

  private play(anim: Anim, rate: number, dt: number) {
    if (this.current !== anim) this.current = anim;
    for (const [name, a] of this.actions) {
      const w = a.getEffectiveWeight();
      const target = name === anim ? 1 : 0;
      a.setEffectiveWeight(w + (target - w) * Math.min(1, dt * 6));
    }
    const a = this.actions.get(anim);
    if (a) a.timeScale = rate;
  }

  update(dt: number, p: PlayerController) {
    const b = p.boat;
    this.boat.position.set(b.x, b.bob, b.z);
    this.boat.rotation.set(0, b.heading - Math.PI / 2, Math.sin(b.bob * 20) * 0.02);

    if (p.mode === 'boat') {
      if (this.keeper.parent !== this.boat) this.boat.add(this.keeper);
      this.keeper.position.copy(SEAT);
      // Rowers face the stern; the boat's bow is local +X, so face local -X.
      this.keeper.rotation.set(0, -Math.PI / 2, 0);
      const row = this.actions.get('row');
      if (row && p.anim === 'row') row.time = b.stroke * row.getClip().duration;
    } else {
      if (this.keeper.parent === this.boat) this.boat.parent?.add(this.keeper);
      this.keeper.position.set(p.x, p.y + this.lying * 0.12, p.z);
      this.keeper.rotation.set(-Math.PI / 2 * this.lying, p.heading, 0, 'YXZ');
    }
    this.play(p.anim, p.animRate, dt);
    this.mixer?.update(dt);

    // Oars: sweep fore-aft with the stroke, blade buried on the drive, feathered on recovery.
    const ph = b.stroke * Math.PI * 2;
    const inWater = b.rowing ? Math.max(0, Math.sin(ph)) : 0;
    for (const oar of this.oars) {
      const side = oar.name.startsWith('OarL') ? 1 : -1;
      const sweep = b.rowing || p.mode === 'boat' ? Math.cos(ph) * 0.55 : 0.9;
      oar.rotation.order = 'YXZ';
      oar.rotation.y = sweep * side;
      oar.rotation.x = (-0.12 - inWater * 0.18 + (1 - inWater) * 0.06) * side;
      oar.rotation.z = (1 - inWater) * 0.0 + inWater * (Math.PI / 2) * side;
    }
    this.lantern.intensity = 1.1 + Math.sin(performance.now() * 0.011) * 0.08 + Math.sin(performance.now() * 0.023) * 0.06;
  }
}
