import * as THREE from 'three/webgpu';
import { ColumnGrid } from '../core/propCollision';

/** A prop template's triangles in its own space (whatever transform the template root carries is
 * replaced on placement), rasterised into a collision grid. skip: mesh names to leave out. */
export function gridFromObject(root: THREE.Object3D, skip: (o: THREE.Object3D) => boolean = () => false) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const pos: number[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || skip(mesh)) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const p = g.attributes.position;
    if (!p) return;
    m.multiplyMatrices(toRoot, mesh.matrixWorld);
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
    }
  });
  return ColumnGrid.fromTriangles(pos, null);
}
