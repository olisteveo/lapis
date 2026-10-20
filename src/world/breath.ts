import * as THREE from 'three/webgpu';
import { color, length, smoothstep, uniform, uv } from 'three/tsl';

/**
 * Her breath in the cold: soft puffs that leave just below the view and drift away, only once warmth
 * is running low, and quicker when running. Part of how the cold shows without a gauge.
 */
export class Breath {
  readonly group = new THREE.Group();
  private puffs: { sprite: THREE.Sprite; fade: { value: number }; age: number; vel: THREE.Vector3 }[] = [];
  private next = 0;
  private fwd = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < 5; i++) {
      const fade = uniform(0);
      const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
      const r = length(uv().sub(0.5)).mul(2);
      mat.colorNode = color(0xdfe8ff);
      mat.opacityNode = smoothstep(1, 0.2, r).mul(fade);
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 5;
      this.group.add(sprite);
      this.puffs.push({ sprite, fade, age: 99, vel: new THREE.Vector3() });
    }
  }

  /** cold: 0..1 (from warmth); running: breathing harder. */
  update(dt: number, camera: THREE.Camera, cold: number, running: boolean) {
    this.next -= dt;
    if (cold > 0.12 && this.next <= 0) {
      this.next = running ? 1.3 : 2.8;
      const p = this.puffs.find((q) => q.age > 1.8);
      if (p) {
        camera.getWorldDirection(this.fwd);
        p.age = 0;
        p.sprite.position.copy(camera.position).addScaledVector(this.fwd, 0.55);
        p.sprite.position.y -= 0.22;
        p.vel.copy(this.fwd).multiplyScalar(0.55).add(new THREE.Vector3(0, 0.12, 0));
      }
    }
    for (const p of this.puffs) {
      p.age += dt;
      const life = p.age / 1.8;
      p.sprite.visible = life < 1;
      if (life >= 1) continue;
      p.sprite.position.addScaledVector(p.vel, dt);
      p.sprite.scale.setScalar(0.12 + life * 0.45);
      // Swells in quickly, thins away slowly; fainter when only a little cold.
      p.fade.value = Math.min(1, life * 6) * (1 - life) * Math.min(1, cold * 1.6) * 0.38;
    }
  }
}
