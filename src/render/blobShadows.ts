import * as THREE from 'three/webgpu';
import { attribute, color, float, length, mix, mx_noise_float, smoothstep, time, uv, vec2, vec4 } from 'three/tsl';

type N = any;

/**
 * Soft shadows laid on the ground under moving things, so they sit in the world instead of
 * floating over it. One instanced draw for all of them. An "ink" variant spreads a wobbling
 * pool with a crimson rim, for the nightmares.
 */
export class BlobShadows {
  readonly mesh: THREE.Mesh;
  private data: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;

  constructor(readonly capacity: number, ink = false) {
    const base = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', base.attributes.position);
    this.geo.setAttribute('uv', base.attributes.uv);
    this.geo.setIndex(base.index);
    // x, y, z, radius (0 hides it)
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.data.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('blob', this.data);
    this.geo.instanceCount = capacity;
    const B = attribute('blob', 'vec4') as N;
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const local = attribute('position', 'vec3') as N;
    mat.positionNode = local.mul(B.w).add(B.xyz);
    const p = uv().sub(0.5).mul(2) as N;
    if (ink) {
      // A pool of ink that never quite holds still: wobbling edge, darker heart, a bruised rim.
      const wob = mx_noise_float(vec2(p.x.mul(2.2), p.y.mul(2.2)).add(vec2(time.mul(0.25), B.x.mul(0.1))) as N).mul(0.18);
      const r = length(p).add(wob);
      const body = smoothstep(0.95, 0.55, r);
      const rim = smoothstep(0.6, 0.85, r).mul(smoothstep(1.0, 0.85, r));
      mat.colorNode = vec4(mix(color(0x030108), color(0x5a0f2a), rim.mul(0.8)), body.add(rim.mul(0.6)).min(1).mul(0.85));
    } else {
      const r = length(p);
      mat.colorNode = vec4(color(0x05061a), smoothstep(1.0, 0.25, r).mul(float(0.5)));
    }
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  set(i: number, x: number, y: number, z: number, radius: number) {
    this.data.setXYZW(i, x, y + 0.06, z, radius);
  }

  hide(i: number) {
    this.data.setW(i, 0);
  }

  commit() {
    this.data.needsUpdate = true;
  }
}
