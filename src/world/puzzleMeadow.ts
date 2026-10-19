import * as THREE from 'three/webgpu';
import { color, exp, length, mix, positionWorld, sin, smoothstep, time, uniform, uv, vec2, vec4 } from 'three/tsl';
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
  private state: 'shut' | 'open' | 'solved';
  private carrying = false;
  private swarm = new THREE.Vector3();
  private scatterT = 0;
  private dodge = 0;
  private flies: { s: THREE.Sprite; seed: number }[] = [];
  private flower: THREE.Sprite;
  private held: THREE.Sprite;
  private jarGlow = uniform(0);
  private lid: THREE.Mesh;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.state = solved ? 'solved' : 'shut';
    this.swarm.set(site.x, site.y + 1.3, site.z);
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
    return this.state === 'solved';
  }

  near(x: number, z: number, reach: number, visit: (cx: number, cz: number, r: number) => void) {
    for (const r of this.site.rocks!) if (Math.abs(r.x - x) < reach + r.r && Math.abs(r.z - z) < reach + r.r) visit(r.x, r.z, r.r * 0.9);
  }

  interaction(x: number, z: number) {
    if (this.solved) return null;
    const f = this.site.flower!;
    const j = this.site.jar!;
    if (!this.carrying && this.state === 'shut' && Math.hypot(f.x - x, f.z - z) < 2.2)
      return { prompt: 'E   pick a moonflower', act: () => this.pick() };
    if (Math.hypot(j.x - x, j.z - z) < 2.3) {
      if (this.carrying) return { prompt: 'E   put the moonflower in the jar', act: () => this.open() };
      if (this.state === 'shut') return { prompt: 'the jar is shut tight', act: () => {} };
    }
    return null;
  }

  private pick() {
    this.carrying = true;
    this.flower.visible = false;
    this.held.visible = true;
    this.hooks.note(2);
  }

  private open() {
    this.carrying = false;
    this.held.visible = false;
    this.state = 'open';
    this.hooks.note(4);
  }

  update(dt: number, player: PlayerState) {
    const t = performance.now() / 1000;
    if (this.carrying) this.held.position.set(player.x, player.y + 1.0, player.z);
    if (this.state === 'open') this.lid.position.y += (this.site.jar!.y + 1.55 - this.lid.position.y) * Math.min(1, dt * 2);
    if (this.state === 'solved') {
      this.jarGlow.value += (1 - this.jarGlow.value) * Math.min(1, dt);
      return;
    }
    const S = this.swarm;
    const home = this.site;
    const j = this.site.jar!;
    const dx = S.x - player.x;
    const dz = S.z - player.z;
    const d = Math.hypot(dx, dz);
    this.scatterT = Math.max(0, this.scatterT - dt);
    // Startled: a running Keeper, or one who comes too close. They bolt for home.
    if (this.scatterT <= 0 && (d < 4 || (d < 14 && player.speed > 4.2))) {
      this.scatterT = 3.5;
      this.hooks.fail(this.site);
    }
    const move = new THREE.Vector2();
    if (this.scatterT > 0) move.set(home.x - S.x, home.z - S.z).clampLength(0, 1).multiplyScalar(7);
    else {
      // Shy, but flighty: they dart away from you at a slant that keeps changing, so you have to
      // keep stepping round to steer them.
      this.dodge += (Math.sin(t * 0.7 + this.site.x) * 0.9 + Math.sin(t * 1.9) * 0.5 - this.dodge) * Math.min(1, dt * 2);
      if (d < 7.5) move.add(new THREE.Vector2(dx / d, dz / d).rotateAround(new THREE.Vector2(), this.dodge).multiplyScalar((7.5 - d) * 1.1));
      // They wander on their own as well.
      move.add(new THREE.Vector2(Math.sin(t * 0.43 + 1), Math.cos(t * 0.31)).multiplyScalar(0.45));
      // With the moonflower in it, the jar's scent pulls them gently.
      if (this.state === 'open') move.add(new THREE.Vector2(j.x - S.x, j.z - S.z).normalize().multiplyScalar(0.25));
      // Left alone, they wander back to the long grass where they live.
      if (d > 18) move.add(new THREE.Vector2(home.x - S.x, home.z - S.z).clampLength(0, 1).multiplyScalar(0.5));
    }
    S.x += move.x * dt;
    S.z += move.y * dt;
    for (const r of this.site.rocks!) {
      const rx = S.x - r.x;
      const rz = S.z - r.z;
      const rd = Math.hypot(rx, rz);
      if (rd < r.r + 1) {
        S.x = r.x + (rx / rd) * (r.r + 1);
        S.z = r.z + (rz / rd) * (r.r + 1);
      }
    }
    S.y += (Math.max(this.site.y, j.y) + 1.3 - S.y) * Math.min(1, dt);
    const spread = this.scatterT > 0 ? 3.5 : 1.3;
    this.flies.forEach(({ s, seed }) => {
      s.position.set(
        S.x + Math.sin(t * 1.3 + seed) * spread * Math.cos(seed),
        S.y + Math.sin(t * 2.1 + seed * 2) * 0.5,
        S.z + Math.cos(t * 1.1 + seed * 1.3) * spread * Math.sin(seed + 1),
      );
      s.material.opacity = 1;
      s.visible = Math.sin(t * (2 + (seed % 1.3)) + seed * 4) > -0.6;
    });
    if (this.state === 'open' && Math.hypot(S.x - j.x, S.z - j.z) < 1.2) {
      this.state = 'solved';
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
  private isSolved: boolean;

  constructor(readonly site: PuzzleSite, solved: boolean, private hooks: PuzzleHooks) {
    this.isSolved = solved;
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
    return this.isSolved;
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
    const want = player.speed > 4.2 ? 0 : 1;
    this.gentle.value += (want - this.gentle.value) * Math.min(1, dt * 3);
    const r = this.site.reward!;
    if (!this.isSolved && Math.hypot(r.x - player.x, r.z - player.z) < 2.5) {
      this.isSolved = true;
      this.hooks.solve(this.site);
    }
  }
}

