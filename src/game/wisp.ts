import * as THREE from 'three/webgpu';
import { abs, color, exp, float, length, mix, sin, time, uniform, uv, vec2, vec4, max } from 'three/tsl';

export type WispMood = 'calm' | 'star' | 'warn';
export type WispCall = 'hey' | 'listen' | 'look' | 'oh' | 'hmm' | 'watch';

const MOOD_COLOR: Record<WispMood, THREE.Color> = {
  calm: new THREE.Color(0x9fd4ff),
  star: new THREE.Color(0xffc878),
  warn: new THREE.Color(0xff9fb0),
};

/**
 * The little light that keeps you company: hovers at your shoulder, darts off to hover over
 * things worth finding, and swoops into view to speak. A Navi for a dream.
 */
export class Wisp {
  readonly group = new THREE.Group();
  private sprite: THREE.Sprite;
  private light = new THREE.PointLight(0x9fd4ff, 0.8, 8, 2);
  private tint = uniform(new THREE.Color(0x9fd4ff));
  private glow = uniform(1);
  private pos = new THREE.Vector3();
  private speakT = 0;
  private placed = false;
  private mood: WispMood = 'calm';
  /** Where it should hover instead of following (a star, a lighthouse), if anywhere. */
  target: THREE.Vector3 | null = null;
  /** Before it has "woken", it stays hidden in the surf. */
  awake = false;

  constructor() {
    this.group.name = 'wisp';
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const p = uv().sub(0.5).mul(2);
    const r = length(p);
    const core = exp(r.mul(-9)).mul(2.2).add(exp(r.mul(-3.2)).mul(0.5));
    // Two tiny wings either side, beating fast.
    const beat = sin(time.mul(38)).mul(0.5).add(0.5);
    const wingShape = (side: number) => {
      const q = vec2(p.x.sub(side * 0.38), p.y.sub(0.08)).mul(vec2(float(2.6), float(1).div(beat.mul(0.6).add(0.4)).mul(2.2)));
      return exp(length(q).mul(-5)).mul(0.45);
    };
    const wings = max(wingShape(1), wingShape(-1)).mul(abs(p.x).greaterThan(0.12).select(float(1), float(0)));
    mat.colorNode = vec4(mix(this.tint, color(0xffffff), core.mul(0.35).min(0.7)).mul(core.add(wings)).mul(this.glow), 1);
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.setScalar(0.32);
    this.sprite.renderOrder = 6;
    this.group.add(this.sprite, this.light);
    this.group.visible = false;
  }

  /** Start speaking: it swoops into view for `seconds`. */
  speak(seconds: number, mood: WispMood = 'calm') {
    this.speakT = seconds;
    this.mood = mood;
  }

  /** Rise out of the surf beside you (the opening). */
  wake(from: THREE.Vector3) {
    this.awake = true;
    this.pos.copy(from);
    this.placed = true;
    this.group.visible = true;
  }

  update(dt: number, camera: THREE.Camera, ambientMood: WispMood) {
    if (!this.awake) return;
    const t = performance.now() / 1000;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    let want: THREE.Vector3;
    if (this.speakT > 0) {
      // Front and a little to the right, where your eye will find it.
      this.speakT -= dt;
      want = camera.position.clone().addScaledVector(fwd, 1.5).addScaledVector(right, 0.42).add(new THREE.Vector3(0, 0.08, 0));
    } else if (this.target && this.target.distanceTo(camera.position) < 45) {
      // Hover over the thing worth finding, bobbing as if pleased with itself.
      want = this.target.clone().add(new THREE.Vector3(Math.sin(t * 2.1) * 0.6, 2.2 + Math.sin(t * 3.3) * 0.25, Math.cos(t * 1.7) * 0.6));
    } else {
      // At your shoulder, drifting in a lazy figure of eight.
      want = camera.position
        .clone()
        .addScaledVector(fwd, 1.1)
        .addScaledVector(right, 0.95 + Math.sin(t * 0.9) * 0.25)
        .add(new THREE.Vector3(0, 0.35 + Math.sin(t * 1.8) * 0.12, 0));
    }
    if (!this.placed) {
      this.pos.copy(want);
      this.placed = true;
    }
    const speed = this.speakT > 0 ? 6 : this.target ? 2.2 : 3.5;
    this.pos.lerp(want, Math.min(1, dt * speed));
    this.group.position.copy(this.pos);
    const mood = this.speakT > 0 ? this.mood : this.target ? 'star' : ambientMood;
    this.tint.value.lerp(MOOD_COLOR[mood], Math.min(1, dt * 3));
    this.light.color.copy(this.tint.value);
    // Pulse while talking; steady glow otherwise.
    this.glow.value = this.speakT > 0 ? 1.1 + Math.sin(t * 14) * 0.25 : 0.9 + Math.sin(t * 2.4) * 0.1;
    this.light.intensity = 0.7 * this.glow.value;
  }
}
