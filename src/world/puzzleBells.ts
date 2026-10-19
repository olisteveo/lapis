import * as THREE from 'three/webgpu';
import { color, dot, mix, normalWorld, saturate, texture, uniform, vec4 } from 'three/tsl';
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
  private step = 0;
  private isSolved: boolean;
  private glow = uniform(0);

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.isSolved = solved;
    if (solved) this.glow.value = 1;
    const stone = stoneMaterial();
    const bronze = new THREE.MeshBasicNodeMaterial();
    const lambert = saturate(dot(normalWorld, KEY).mul(0.55).add(0.45));
    bronze.colorNode = mix(mix(color(0x2a4a4a), color(0x7aa8a0), lambert), color(0xffd08a).mul(1.4), this.glow);
    const post = new THREE.CylinderGeometry(0.16, 0.24, 2.6, 7).translate(0, 1.3, 0);
    const beam = new THREE.BoxGeometry(1.1, 0.16, 0.16).translate(0, 2.6, 0);
    const bellGeo = new THREE.CylinderGeometry(0.12, 0.38, 0.6, 12, 1, true).translate(0, -0.3, 0);
    const marks = Array.from({ length: 7 }, (_, n) => marksTexture(n));
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
      // Truth: how many-th this bell is in the order. Hidden from the real camera.
      const t = mark(order.indexOf(i) + 1, 0x8ff0e6);
      t.visible = false;
      this.truth.push(t);
      if (site.decoy) this.lies.push(mark(site.decoy.indexOf(i) + 1, 0xffc878));
    });
  }

  get solved() {
    return this.isSolved;
  }

  setMirror(mirror: boolean) {
    for (const t of this.truth) t.visible = mirror && !this.isSolved;
    for (const l of this.lies) l.visible = !mirror && !this.isSolved;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const b of this.site.bells!) if (Math.abs(b.x - x) < reach + 1 && Math.abs(b.z - z) < reach + 1) visit(b.x, b.z, 0.3);
  }

  interaction(x: number, z: number) {
    if (this.isSolved) return null;
    const i = this.site.bells!.findIndex((b) => Math.hypot(b.x - x, b.z - z) < 2.2);
    return i >= 0 ? { prompt: 'E   ring the bell', act: () => this.ring(i) } : null;
  }

  private ring(i: number) {
    this.swing[i] = 1;
    this.hooks.note(i);
    if (this.site.order![this.step] !== i) {
      this.step = 0;
      setTimeout(() => this.hooks.fail(), 400);
      return;
    }
    this.step++;
    if (this.step >= this.site.order!.length) {
      this.isSolved = true;
      this.glow.value = 1;
      this.setMirror(false);
      this.hooks.solve(this.site);
    }
  }

  update(dt: number) {
    const t = performance.now() / 1000;
    this.bells.forEach((b, i) => {
      this.swing[i] = Math.max(0, this.swing[i] - dt * 0.5);
      b.rotation.z = Math.sin(t * 7) * 0.35 * this.swing[i];
    });
  }
}
