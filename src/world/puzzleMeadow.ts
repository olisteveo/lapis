import * as THREE from 'three/webgpu';
import { color, exp, length, mix, positionWorld, sin, smoothstep, time, uniform, uv, vec2, vec4 } from 'three/tsl';
import { DewTrailRule, FirefliesRule } from '../core/puzzleRules';
import { stoneMaterial, type PlayerState, type PuzzleHooks, type PuzzleImpl, type PuzzleSite } from './puzzles';

function glowSprite(tint: number, strength: number, size: number) {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const r = length(uv().sub(0.5)).mul(2);
  m.colorNode = vec4(color(tint).mul(exp(r.mul(-5)).add(exp(r.mul(-16)).mul(1.5))).mul(strength), 1);
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}

const SWARM = 16;

/**
 * The firefly jar. The jar is shut until a moonflower is put in it; then the fireflies want to go
 * in, but they are shy of you. Walk them there gently, round the boulders. Run, and they flee home.
 */
export class Fireflies implements PuzzleImpl {
  readonly group = new THREE.Group();
  /** The rules (src/core); this class only draws them. */
  readonly rule: FirefliesRule;
  private flies: { s: THREE.Sprite; seed: number }[] = [];
  private flower: THREE.Sprite;
  private held: THREE.Sprite;
  private jarGlow = uniform(0);
  private lid: THREE.Mesh;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.rule = new FirefliesRule(site, solved);
    const j = site.jar!;
    const glass = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    glass.colorNode = mix(color(0x6a7ac8).mul(0.18), color(0xffe08a).mul(1.4), this.jarGlow);
    const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 1.1, 16, 1, true).translate(0, 0.55, 0), glass);
    jar.position.set(j.x, j.y, j.z);
    this.lid = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.08, 16), stoneMaterial());
    this.lid.position.set(j.x, j.y + 1.14, j.z);
    if (solved) {
      this.jarGlow.value = 1;
      this.lid.position.y += 0.4;
    }
    this.group.add(jar, this.lid);
    for (const r of site.rocks!) {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r.r, 0), stoneMaterial());
      rock.position.set(r.x, r.y + r.r * 0.4, r.z);
      rock.scale.y = 0.75;
      this.group.add(rock);
    }
    const f = site.flower!;
    this.flower = glowSprite(0xece0ff, 1.6, 0.9);
    this.flower.position.set(f.x, f.y + 0.6, f.z);
    this.flower.visible = !solved;
    this.held = glowSprite(0xece0ff, 1.2, 0.35);
    this.held.visible = false;
    this.group.add(this.flower, this.held);
    for (let k = 0; k < SWARM; k++) {
      const s = glowSprite(0xd8ff8a, 1.8, 0.22);
      this.flies.push({ s, seed: k * 1.7 });
      this.group.add(s);
    }
    if (solved) for (const fl of this.flies) fl.s.visible = false;
  }

  get solved() {
    return this.rule.solved;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const r of this.site.rocks!) if (Math.abs(r.x - x) < reach + r.r && Math.abs(r.z - z) < reach + r.r) visit(r.x, r.z, r.r * 0.9);
  }

  interaction(x: number, z: number) {
    if (this.solved) return null;
    const f = this.site.flower!;
    const j = this.site.jar!;
    if (!this.rule.carrying && this.rule.state === 'shut' && Math.hypot(f.x - x, f.z - z) < 2.2)
      return { prompt: 'E   pick a moonflower', act: () => this.pick() };
    if (Math.hypot(j.x - x, j.z - z) < 2.3) {
      if (this.rule.carrying) return { prompt: 'E   put the moonflower in the jar', act: () => this.open() };
      if (this.rule.state === 'shut') return { prompt: 'the jar is shut tight', act: () => {} };
    }
    return null;
  }

  private pick() {
    this.rule.pick();
    this.flower.visible = false;
    this.held.visible = true;
    this.hooks.note(2);
  }

  private open() {
    this.rule.open();
    this.held.visible = false;
    this.hooks.note(4);
  }

  update(dt: number, player: PlayerState) {
    const t = performance.now() / 1000;
    const R = this.rule;
    if (R.carrying) this.held.position.set(player.x, player.y + 1.0, player.z);
    if (R.state === 'open') this.lid.position.y += (this.site.jar!.y + 1.55 - this.lid.position.y) * Math.min(1, dt * 2);
    if (R.state === 'solved') {
      this.jarGlow.value += (1 - this.jarGlow.value) * Math.min(1, dt);
      return;
    }
    const event = R.update(dt, player);
    if (event === 'scattered') this.hooks.fail(this.site);
    const S = R.swarm;
    const spread = R.scatterT > 0 ? 3.5 : 1.3;
    this.flies.forEach(({ s, seed }) => {
      s.position.set(
        S.x + Math.sin(t * 1.3 + seed) * spread * Math.cos(seed),
        S.y + Math.sin(t * 2.1 + seed * 2) * 0.5,
        S.z + Math.cos(t * 1.1 + seed * 1.3) * spread * Math.sin(seed + 1),
      );
      s.visible = Math.sin(t * (2 + (seed % 1.3)) + seed * 4) > -0.6;
    });
    if (event === 'solved') {
      for (const fl of this.flies) fl.s.visible = false;
      this.hooks.solve(this.site);
    }
  }
}

/**
 * Footprints in the dew: her small prints and your larger ones, shown only up close and only while
 * you walk gently. Yours fork off to dead ends; hers cross wet ground where nothing shows.
 */
export class DewTrail implements PuzzleImpl {
  readonly group = new THREE.Group();
  private player = uniform(new THREE.Vector3(1e9, 0, 1e9));
  private gentle = uniform(1);
  /** The rules (src/core); this class only draws them. */
  readonly rule: DewTrailRule;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.rule = new DewTrailRule(site, solved);
    const prints = (list: (PuzzleSite['trail'] & object)[number][], w: number, l: number) => {
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const p = uv().sub(0.5).mul(vec2(2, 2));
      // A foot: an oval sole and a rounded heel, soft-edged.
      const sole = smoothstep(1.0, 0.6, length(p.mul(vec2(1.25, 0.9))));
      const near = smoothstep(7.5, 2.5, length(positionWorld.xz.sub((this.player as any).xz)));
      const shimmer = sin(time.mul(2).add(positionWorld.x.mul(3))).mul(0.15).add(0.85);
      mat.colorNode = vec4(color(0xbfe0ff).mul(sole).mul(near).mul(this.gentle).mul(shimmer).mul(1.1), 1);
      const geo = new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2);
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      list.forEach((f, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw);
        m.compose(new THREE.Vector3(f.x, f.y + 0.04, f.z), q, new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m);
      });
      mesh.frustumCulled = false;
      return mesh;
    };
    this.group.add(prints(site.trail!, 0.11, 0.22), prints(site.decoyTrail!, 0.15, 0.32));
    // Where it starts: a flat stone with a small glowing handprint.
    const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.35, 9), stoneMaterial());
    stone.position.set(site.x, site.y + 0.1, site.z);
    const hand = glowSprite(0xbfe0ff, 1.2, 0.5);
    hand.position.set(site.x, site.y + 0.55, site.z);
    this.group.add(stone, hand);
  }

  get solved() {
    return this.rule.solved;
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    if (Math.abs(this.site.x - x) < reach + 1 && Math.abs(this.site.z - z) < reach + 1) visit(this.site.x, this.site.z, 0.6);
  }

  interaction() {
    return null;
  }

  update(dt: number, player: PlayerState) {
    this.player.value.set(player.x, player.y, player.z);
    // Dew only holds a print for someone moving gently; running blurs them all away.
    if (this.rule.update(dt, player)) this.hooks.solve(this.site);
    this.gentle.value = this.rule.gentle;
  }
}

