// Static batching: merges every mesh that never moves (map props, background scenery) into one
// mesh per material. Draw calls, not triangles, are what limit integrated GPUs (ANGLE/D3D11),
// so ~400 little prop meshes become ~30 draw calls.
import * as THREE from 'three';

/** Key that identifies materials that would render identically. */
function materialKey(m) {
  const c = (x) => (x ? x.getHexString() : '');
  return [
    m.type, c(m.color), c(m.emissive), m.emissiveIntensity ?? '', m.roughness ?? '', m.metalness ?? '',
    m.map?.uuid ?? '', m.emissiveMap?.uuid ?? '', m.normalMap?.uuid ?? '', m.transparent, m.opacity, m.side,
    m.flatShading ?? '', m.toneMapped, m.depthWrite, m.depthTest, m.blending, m.vertexColors, m.fog, m.alphaTest,
  ].join('|');
}

function canBatch(o, root) {
  if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material) || !o.geometry?.attributes?.position) return false;
  if (o.geometry.attributes.color || o.geometry.morphAttributes?.position) return false;
  if (o.material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return false; // custom shaders
  for (let a = o; a && a !== root; a = a.parent) {
    if (a.userData.dynamic || !a.visible) return false;
  }
  return true;
}

/**
 * Merge static meshes under `root` (in root's local space). Objects (or ancestors) flagged with
 * userData.dynamic = true are left alone. Returns { before, after } mesh counts.
 */
export function batchStatic(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map();
  const candidates = [];
  root.traverse((o) => {
    if (o !== root && canBatch(o, root)) candidates.push(o);
  });
  for (const o of candidates) {
    const key = `${materialKey(o.material)}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  let after = 0;
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const list of groups.values()) {
    if (list.length < 2) {
      after += list.length;
      continue;
    }
    let vcount = 0;
    let icount = 0;
    for (const o of list) {
      const g = o.geometry;
      vcount += g.attributes.position.count;
      icount += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    const idx = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
    let vo = 0;
    let io = 0;
    for (const o of list) {
      const g = o.geometry;
      if (!g.attributes.normal) g.computeVertexNormals();
      m.multiplyMatrices(inv, o.matrixWorld);
      nm.getNormalMatrix(m);
      // a mirrored transform flips the winding: reverse triangles so faces still point outward
      const flip = m.determinant() < 0;
      const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m);
        pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
        v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
        nor[(vo + i) * 3] = v.x; nor[(vo + i) * 3 + 1] = v.y; nor[(vo + i) * 3 + 2] = v.z;
        if (U) { uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i); }
      }
      const n = g.index ? g.index.count : P.count;
      for (let i = 0; i < n; i += 3) {
        const a = g.index ? g.index.getX(i) : i, b = g.index ? g.index.getX(i + 1) : i + 1, c = g.index ? g.index.getX(i + 2) : i + 2;
        idx[io++] = vo + a;
        idx[io++] = vo + (flip ? c : b);
        idx[io++] = vo + (flip ? b : c);
      }
      vo += P.count;
      o.parent.remove(o);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const first = list[0];
    const merged = new THREE.Mesh(geo, first.material);
    merged.name = 'batched';
    merged.castShadow = first.castShadow;
    merged.receiveShadow = first.receiveShadow;
    merged.renderOrder = first.renderOrder;
    merged.userData.ownMaterial = true;
    merged.matrixAutoUpdate = false;
    root.add(merged);
    after++;
  }
  // drop groups that are now empty
  const empty = [];
  root.traverse((o) => {
    if (o !== root && o.isGroup && o.children.length === 0 && !o.userData.dynamic) empty.push(o);
  });
  for (const o of empty) o.parent?.remove(o);
  return { before: candidates.length, after };
}
