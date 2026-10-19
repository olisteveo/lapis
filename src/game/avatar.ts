import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { color, exp, length, uv, vec4 } from 'three/tsl';
import type { Anim, PlayerController } from './player';

// Boat-local seat for the rower (three.js axes, bow toward +X), tuned against the mesh.
const SEAT = new THREE.Vector3(-0.07, -0.52, 0);

export class Avatar {
  readonly keeper = new THREE.Group();
  readonly boat = new THREE.Group();
  private mixer!: THREE.AnimationMixer;
  keeperGltf: GLTF | null = null;
  private actions = new Map<Anim, THREE.AnimationAction>();
  private oars: THREE.Object3D[] = [];
  private beaconSprite: THREE.Sprite | null = null;
  private lantern: THREE.PointLight;
  /** Lying-down blend for the opening shot: 1 = on the sand, 0 = standing. */
  lying = 0;

  constructor() {
    this.keeper.name = 'keeper';
    this.boat.name = 'boat';
    this.lantern = new THREE.PointLight(0xffa060, 1.4, 14, 1.8);
  }

  async load(keeperUrl: string, boatUrl: string) {
    const loader = new GLTFLoader();
    const [k, b] = await Promise.all([loader.loadAsync(keeperUrl), loader.loadAsync(boatUrl)]);
    this.keeperGltf = k;
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
        o.add(this.lantern, this.beacon());
      }
      const m = o as THREE.Mesh;
      const std = m.material as THREE.MeshStandardMaterial | undefined;
      // Night scene: Blender base colours are daylight values, so pull the boat down to match.
      if (m.isMesh && std?.color && std.name !== 'lantern_glow') std.color.multiplyScalar(0.28);
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
    // High enough that the hull's bob never dips it under the sea surface.
    mask.position.y = 0.14;
    mask.renderOrder = 0.9;
    mask.name = 'boatWaterMask';
    return mask;
  }

  /** A soft warm halo on the lantern so the boat can be found from down the beach. */
  private beacon() {
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = length(uv().sub(0.5)).mul(2);
    mat.colorNode = vec4(color(0xffa45c).mul(exp(r.mul(-5)).mul(1.4).add(exp(r.mul(-16)).mul(2.5))), 1);
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(4.5);
    s.position.set(0.12, 0.3, 0);
    this.beaconSprite = s;
    return s;
  }

  update(dt: number, p: PlayerController, camera?: THREE.Camera) {
    // The beacon is for finding the boat from afar; up close (or aboard) it would blind you.
    if (this.beaconSprite && camera) {
      const d = camera.position.distanceTo(this.boat.position);
      this.beaconSprite.visible = p.mode !== 'boat';
      this.beaconSprite.scale.setScalar(THREE.MathUtils.clamp(d * 0.05, 0.5, 4.5));
    }
    const b = p.boat;
    this.boat.position.set(b.x, b.bob, b.z);
    this.boat.rotation.set(0, b.heading - Math.PI / 2, Math.sin(b.bob * 20) * 0.02);

    // First person: the Keeper's body is never placed in the world (not even in the boat).
    void SEAT;
    void dt;

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
    this.lantern.intensity = (p.mode === 'boat' ? 0.8 : 1.4) + Math.sin(performance.now() * 0.011) * 0.08 + Math.sin(performance.now() * 0.023) * 0.05;
  }
}
