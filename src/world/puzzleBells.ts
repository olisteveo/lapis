import * as THREE from 'three/webgpu';
import { color, dot, mix, normalWorld, saturate, texture, uniform, vec4 } from 'three/tsl';
import { BellsRule, type PlayerState } from '../core/puzzleRules';
import { KEY, stoneMaterial, type PuzzleHooks, type PuzzleImpl, type PuzzleSite } from './puzzles';

/** n dots in a little ring (one in the middle for 1): how many-th to ring this bell. */
function marksTexture(n: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 96, 96);
  g.fillStyle = '#fff';
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 - Math.PI / 2;
    const r = n === 1 ? 0 : 26;
    g.beginPath();
    g.arc(48 + Math.cos(a) * r, 48 + Math.sin(a) * r, 9, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/**
 * Bells in the drowned square. The order to ring them is written above them, but only the water
 * remembers it: the marks appear in the reflection, never in the air. In the second pool the
 * bells themselves carry marks too, and those are lies.
 */
export class BellPool implements PuzzleImpl {
  readonly group = new THREE.Group();
  private truth: THREE.Sprite[] = [];
  private lies: THREE.Sprite[] = [];
  private bells: THREE.Object3D[] = [];
  private swing: number[];
  /** The rules (src/core); this class only draws them. */
  readonly rule: BellsRule;
  private glow = uniform(0);

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.rule = new BellsRule(site, solved);
    if (solved) this.glow.value = 1;
    const stone = stoneMaterial();
    const bronze = new THREE.MeshBasicNodeMaterial();
    const lambert = saturate(dot(normalWorld, KEY).mul(0.55).add(0.45));
    bronze.colorNode = mix(mix(color(0x2a4a4a), color(0x7aa8a0), lambert), color(0xffd08a).mul(1.4), this.glow);
    const post = new THREE.CylinderGeometry(0.16, 0.24, 2.6, 7).translate(0, 1.3, 0);
    const beam = new THREE.BoxGeometry(1.1, 0.16, 0.16).translate(0, 2.6, 0);
    const bellGeo = new THREE.CylinderGeometry(0.12, 0.38, 0.6, 12, 1, true).translate(0, -0.3, 0);
    const marks = Array.from({ length: 9 }, (_, n) => marksTexture(n));
    const order = site.order!;
    this.swing = site.bells!.map(() => 0);
    site.bells!.forEach((b, i) => {
      const p = new THREE.Mesh(post, stone);
      p.position.set(b.x, b.y, b.z);
      const bar = new THREE.Mesh(beam, stone);
      bar.position.copy(p.position);
      const bell = new THREE.Mesh(bellGeo, bronze);
      // Hung from the beam's end so it swings when rung.
      bell.position.set(b.x, b.y + 2.55, b.z);
      this.group.add(p, bar, bell);
      this.bells.push(bell);
      const mark = (n: number, tint: number) => {
        const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        m.colorNode = vec4(color(tint).mul(texture(marks[n]).r).mul(2.2), 1);
        const s = new THREE.Sprite(m);
        s.position.set(b.x, 4.4, b.z);
        s.scale.setScalar(1.4);
        this.group.add(s);
        return s;
      };
      // Truth: when to ring this bell (a bell rung twice carries two marks, one above the other).
      // Hidden from the real camera.
      const when = (seq: number[]) => seq.map((b, k) => (b === i ? k + 1 : 0)).filter(Boolean);
      when(order).forEach((n, k) => {
        const t = mark(n, 0x8ff0e6);
        t.position.y += k * 1.5;
        t.visible = false;
        this.truth.push(t);
      });
      if (site.decoy)
        when(site.decoy).forEach((n, k) => {
          const l = mark(n, 0xffc878);
          l.position.y += k * 1.5;
          this.lies.push(l);
        });
    });
  }

  get solved() {
    return this.rule.solved;
  }

  setMirror(mirror: boolean) {
    // Wading makes ripples that break the reflection up: the true marks need still water.
    for (const t of this.truth) t.visible = mirror && this.rule.marksVisible;
    for (const l of this.lies) l.visible = !mirror && !this.rule.solved;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const b of this.site.bells!) if (Math.abs(b.x - x) < reach + 1 && Math.abs(b.z - z) < reach + 1) visit(b.x, b.z, 0.3);
  }

  interaction(x: number, z: number) {
    if (this.rule.solved) return null;
    const i = this.site.bells!.findIndex((b) => Math.hypot(b.x - x, b.z - z) < 2.2);
    return i >= 0 ? { prompt: 'E   ring the bell', act: () => this.ring(i) } : null;
  }

  private ring(i: number) {
    this.swing[i] = 1;
    this.hooks.note(i);
    const result = this.rule.ring(i);
    if (result === 'wrong') {
      setTimeout(() => this.hooks.fail(this.site), 400);
      return;
    }
    if (result === 'solved') {
      this.glow.value = 1;
      this.setMirror(false);
      this.hooks.solve(this.site);
    }
  }

  update(dt: number, player: PlayerState) {
    const t = performance.now() / 1000;
    this.rule.update(dt, player);
    this.bells.forEach((b, i) => {
      this.swing[i] = Math.max(0, this.swing[i] - dt * 0.5);
      b.rotation.z = Math.sin(t * 7) * 0.35 * this.swing[i];
    });
  }
}
