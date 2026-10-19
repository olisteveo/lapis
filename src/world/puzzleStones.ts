import * as THREE from 'three/webgpu';
import { color, exp, length, mix, texture, uniform, uv, vec4 } from 'three/tsl';
import { PALETTE } from '../config';
import { stoneMaterial, type PuzzleHooks, type PuzzleImpl, type PuzzleSite, type SkyFeature } from './puzzles';

/** A disc carved with one sky feature: its stars and the lines between them, inked in gold. */
function symbolTexture(f: SkyFeature) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  if (f.stars.length === 1) {
    // The brightest star: one large four-point glint.
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const r = k % 2 ? 9 : 44;
      g.lineTo(64 + Math.sin(a) * r, 64 - Math.cos(a) * r);
    }
    g.fill();
  } else {
    const xs = f.stars.map((s) => s[0]);
    const ys = f.stars.map((s) => s[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.1);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const P = (s: [number, number]) => [64 + ((s[0] - cx) / span) * 84, 64 - ((s[1] - cy) / span) * 84];
    g.lineWidth = 3;
    for (const [a, b] of f.lines) {
      const [ax, ay] = P(f.stars[a]);
      const [bx, by] = P(f.stars[b]);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
    }
    for (const s of f.stars) {
      const [x, y] = P(s);
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/**
 * Constellation stones: standing stones round a circle, each carved with a dial you can turn.
 * Every stone must show what it is looking at: the sky feature that hangs in the direction it faces.
 */
export class StoneRing implements PuzzleImpl {
  readonly group = new THREE.Group();
  private shown: number[];
  private glow = uniform(0);
  private dials: { value: THREE.Texture }[] = [];
  private textures: THREE.CanvasTexture[];
  private isSolved: boolean;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks, private features: SkyFeature[]) {
    this.isSolved = solved;
    this.textures = features.map(symbolTexture);
    const stones = site.stones!;
    // Start every dial on a wrong face (deterministic, so it's the same puzzle each visit).
    this.shown = stones.map((s, i) => (solved ? s.answer : (s.answer + 1 + ((i * 7 + 3) % (features.length - 1))) % features.length));
    if (solved) this.glow.value = 1;
    const mat = stoneMaterial();
    const slab = new THREE.BoxGeometry(1.5, 3.2, 0.7).translate(0, 1.4, 0);
    const disc = new THREE.CircleGeometry(0.62, 24);
    stones.forEach((s, i) => {
      const stone = new THREE.Mesh(slab, mat);
      stone.position.set(s.x, s.y - 0.2, s.z);
      // The face looks back toward the circle's centre, so you read it from the middle.
      stone.rotation.y = Math.atan2(site.x - s.x, site.z - s.z);
      this.group.add(stone);
      const face = new THREE.Mesh(disc, this.faceMaterial(i));
      face.position.set(0, 2.05, 0.36);
      stone.add(face);
    });
    // A low plinth in the middle where you stand to read the stones.
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.9, 0.4, 14).translate(0, 0, 0), mat);
    plinth.position.set(site.x, site.y, site.z);
    this.group.add(plinth);
  }

  private faceMaterial(i: number) {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const dial = texture(this.textures[this.shown[i]]);
    this.dials[i] = dial as unknown as { value: THREE.Texture };
    const ink = dial.r;
    const rim = exp(length(uv().sub(0.5)).mul(2).sub(1).abs().mul(-30)).mul(0.6);
    const lit = mix(color(0xa8c0ff).mul(1.2), color(PALETTE.starGold).mul(2.4), this.glow);
    m.colorNode = vec4(mix(color(0x1a2040), lit, ink.max(rim)), 1);
    return m;
  }

  get solved() {
    return this.isSolved;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const s of this.site.stones!) if (Math.abs(s.x - x) < reach + 1 && Math.abs(s.z - z) < reach + 1) visit(s.x, s.z, 0.85);
  }

  interaction(x: number, z: number) {
    if (this.isSolved) return null;
    const i = this.site.stones!.findIndex((s) => Math.hypot(s.x - x, s.z - z) < 2.4);
    if (i < 0) return null;
    return { prompt: 'E   turn the stone', act: () => this.turn(i) };
  }

  private turn(i: number) {
    this.shown[i] = (this.shown[i] + 1) % this.features.length;
    this.dials[i].value = this.textures[this.shown[i]];
    this.hooks.note(this.shown[i]);
    if (this.site.stones!.every((s, k) => this.shown[k] === s.answer)) {
      this.isSolved = true;
      this.glow.value = 1;
      this.hooks.solve(this.site);
    }
  }

  update() {}
}
