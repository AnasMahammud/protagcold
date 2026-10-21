// Builds renderable geometry for a map from the same collider data used for physics.
// All boxes/ramps sharing a material are merged into one mesh (one draw call per material),
// with world-space UVs so textures tile at a consistent real-world scale.
import * as THREE from 'three';
import { surfaceMaterial } from './textures.js';
import { Collider } from '../movement/collision.js';
import { buildDecor, waterNormalTexture } from './decor.js';
import { buildScenery } from './scenery.js';
import { batchStatic } from './batch.js';

const WINDOW_VARIANTS = new Set(['brick', 'concrete']);

class GeoBucket {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }

  quad(a, b, c, d, scale, uvMode) {
    // Flat normal. Ramp sides can have coincident vertices (a triangle, not a quad), so try
    // each corner until a non-degenerate triangle is found. A zero normal would become NaN
    // in the lighting shader and the bloom blur would smear it into big black rectangles.
    let n = null;
    for (const [p, q, r] of [[a, b, c], [a, c, d], [b, c, d], [a, b, d]]) {
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-9) {
        n = [nx / l, ny / l, nz / l];
        break;
      }
    }
    if (!n) return; // zero-area face: nothing to draw
    const [nx, ny, nz] = n;
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      if (uvMode === 'y') this.uv.push(p[0] / scale, p[2] / scale);
      else if (uvMode === 'x') this.uv.push(p[2] / scale, p[1] / scale);
      else this.uv.push(p[0] / scale, p[1] / scale);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function buildMapVisuals(map, scene, quality) {
  const group = new THREE.Group();
  group.name = `map:${map.id}`;
  const buckets = new Map();
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, new GeoBucket());
    return buckets.get(name);
  };
  const edgePts = [];
  const night = map.theme === 'city';

  map.solids.forEach((s, i) => {
    if (s.m === 'invisible' || s.hide) return; // hide: collides, but a decor prefab draws it
    const c = new Collider(s, i);
    let sideName = s.m;
    if (s.v === 'building' && night && WINDOW_VARIANTS.has(s.m) && c.y1 - c.y0 >= 3) sideName = `${s.m}_windows`;
    const topName = s.mt || s.m;
    const sideMat = surfaceMaterial(sideName);
    const topMat = surfaceMaterial(topName);
    const sb = bucket(sideName);
    const tb = bucket(topName);
    const { x0, y0, z0, x1, z1 } = c;
    const h00 = c.topAt(x0, z0), h10 = c.topAt(x1, z0), h11 = c.topAt(x1, z1), h01 = c.topAt(x0, z1);
    const t00 = [x0, h00, z0], t10 = [x1, h10, z0], t11 = [x1, h11, z1], t01 = [x0, h01, z1];
    const b00 = [x0, y0, z0], b10 = [x1, y0, z0], b11 = [x1, y0, z1], b01 = [x0, y0, z1];
    tb.quad(t00, t01, t11, t10, topMat.scale, 'y');
    if (y0 > 0.01) sb.quad(b00, b10, b11, b01, sideMat.scale, 'y');
    if (h00 > y0 + 1e-3 || h10 > y0 + 1e-3) sb.quad(b00, t00, t10, b10, sideMat.scale, 'z');
    if (h01 > y0 + 1e-3 || h11 > y0 + 1e-3) sb.quad(b01, b11, t11, t01, sideMat.scale, 'z');
    if (h00 > y0 + 1e-3 || h01 > y0 + 1e-3) sb.quad(b00, b01, t01, t00, sideMat.scale, 'x');
    if (h10 > y0 + 1e-3 || h11 > y0 + 1e-3) sb.quad(b10, t10, t11, b11, sideMat.scale, 'x');

    // top-edge trim makes walkable surfaces readable at speed
    const isFloor = (x1 - x0) * (z1 - z0) > 1500;
    if (!isFloor && s.m !== 'glass') {
      const e = 0.012;
      edgePts.push(
        x0, h00 + e, z0, x1, h10 + e, z0,
        x1, h10 + e, z0, x1, h11 + e, z1,
        x1, h11 + e, z1, x0, h01 + e, z1,
        x0, h01 + e, z1, x0, h00 + e, z0,
      );
    }
  });

  const animated = [];
  // switches flipped by map events (see gameplay/mapEvents.js)
  const live = { conveyorScale: 1, beltSpeed: map.env?.beltSpeed ?? 3 };
  for (const [name, b] of buckets) {
    const { material, scale, scroll } = surfaceMaterial(name);
    if (scroll) {
      // conveyor belts / escalators: the texture scrolls the way the surface carries you
      animated.push((dt) => { material.map.offset.x -= (live.beltSpeed * live.conveyorScale * dt) / scale; });
    }
    const mesh = new THREE.Mesh(b.build(), material);
    mesh.name = `solids:${name}`;
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  if (edgePts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(edgePts, 3));
    const edgeColor = { city: '#ff9be8', arena: '#ffffff', docks: '#fff2c8', training: '#ffffff', mall: '#e8f0d8', waterpark: '#ffffff', factory: '#fff2b0' }[map.theme] || '#ffffff';
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: map.theme === 'city' ? 0.55 : 0.35 }));
    lines.name = 'edges';
    lines.matrixAutoUpdate = false;
    group.add(lines);
  }

  // jump pads
  const pads = new THREE.Group();
  pads.name = 'pads';
  for (const p of map.pads || []) pads.add(makePad(p));
  group.add(pads);

  // water surfaces (zones of kind "water" with a surface height)
  const waterZones = (map.zones || []).filter((z) => z.k === 'water' && z.surf != null);
  if (waterZones.length) group.add(makeWater(waterZones, animated));
  // water slides: open striped channels along each ride path, with a glowing entry ring
  const rides = new THREE.Group();
  rides.name = 'rides';
  (map.rides || []).forEach((r, i) => rides.add(makeRide(r, i)));
  group.add(rides);

  const decor = buildDecor(map, quality, animated);
  group.add(decor);
  const scenery = buildScenery(map, quality, animated);
  group.add(scenery);
  // merge everything that never moves: one draw call per material instead of one per prop
  group.userData.batch = [batchStatic(decor), batchStatic(scenery), batchStatic(pads), batchStatic(rides)];

  scene.add(group);
  const lights = scenery.userData.lights;
  return {
    group,
    live,
    lights,
    update(dt, t, ctx) {
      for (const a of animated) a(dt, t, ctx);
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.userData.ownMaterial) {
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
        }
      });
    },
  };
}

let _waterMat = null;
function makeWater(zones, animated) {
  if (!_waterMat) {
    const normal = waterNormalTexture().clone();
    normal.needsUpdate = true;
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(0.25, 0.25);
    _waterMat = new THREE.MeshStandardMaterial({ color: '#3cc8f0', transparent: true, opacity: 0.62, roughness: 0.08, metalness: 0.15, normalMap: normal, normalScale: new THREE.Vector2(0.5, 0.5), depthWrite: false });
  }
  const mat = _waterMat;
  animated.push((dt) => {
    mat.normalMap.offset.x += dt * 0.03;
    mat.normalMap.offset.y += dt * 0.017;
  });
  const g = new THREE.Group();
  g.name = 'water';
  for (const z of zones) {
    let geo;
    if (z.c) {
      geo = new THREE.CircleGeometry(z.r, 48);
      geo.rotateX(-Math.PI / 2);
      geo.translate(z.c[0], z.surf, z.c[1]);
    } else {
      const [x0, , z0, x1, , z1] = z.b;
      geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      geo.rotateX(-Math.PI / 2);
      geo.translate((x0 + x1) / 2, z.surf, (z0 + z1) / 2);
    }
    // world-space UVs so the ripples tile at the same scale everywhere
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 4, p.getZ(i) / 4);
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 2;
    m.receiveShadow = true;
    g.add(m);
  }
  g.userData.dynamic = true; // shared animated material: no need to batch (and keeps sorting simple)
  return g;
}

const _rideMats = new Map();
function rideMaterial(a, b) {
  const key = a + b;
  if (_rideMats.has(key)) return _rideMats.get(key);
  const c = document.createElement('canvas');
  c.width = 8; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = a; x.fillRect(0, 0, 8, 32);
  x.fillStyle = b; x.fillRect(0, 32, 8, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.28, metalness: 0.05, side: THREE.DoubleSide });
  _rideMats.set(key, m);
  return m;
}

/** An open half-pipe channel hanging below the ride path (the rider stays visible). */
function makeRide(r) {
  const g = new THREE.Group();
  const pts = r.pts.map((p) => new THREE.Vector3(p[0], p[1] + 0.85, p[2]));
  const R = 0.95;
  const seg = 12;
  const pos = [], nor = [], uv = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  const T = new THREE.Vector3(), S = new THREE.Vector3(), U = new THREE.Vector3(), d = new THREE.Vector3();
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    T.subVectors(b, a).normalize();
    S.crossVectors(T, up);
    if (S.lengthSq() < 1e-6) S.set(1, 0, 0);
    S.normalize();
    U.crossVectors(S, T).normalize();
    if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
    for (let k = 0; k <= seg; k++) {
      const th = (k / seg) * Math.PI;
      d.copy(S).multiplyScalar(Math.cos(th)).addScaledVector(U, -Math.sin(th)); // semicircle below the line
      pos.push(pts[i].x + d.x * R, pts[i].y + d.y * R, pts[i].z + d.z * R);
      nor.push(-d.x, -d.y, -d.z);
      uv.push(k / seg, len / 2.4);
    }
    if (i > 0) {
      const r0 = (i - 1) * (seg + 1), r1 = i * (seg + 1);
      for (let k = 0; k < seg; k++) idx.push(r0 + k, r1 + k, r0 + k + 1, r0 + k + 1, r1 + k, r1 + k + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const [ca, cb] = r.col || ['#ff3db0', '#2fd8e8'];
  const tube = new THREE.Mesh(geo, rideMaterial(ca, cb));
  tube.castShadow = true;
  tube.receiveShadow = true;
  g.add(tube);
  // entry marker so players know where to hop in
  const e = r.pts[0];
  const ringMat = new THREE.MeshBasicMaterial({ color: ca, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  ringMat.toneMapped = false;
  const ring = new THREE.Mesh(new THREE.RingGeometry((r.r || 1.1) * 0.55, r.r || 1.1, 32), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(e[0], e[1] + 0.04, e[2]);
  g.add(ring);
  return g;
}

function makePad(p) {
  const g = new THREE.Group();
  g.position.set(p.p[0], p.p[1], p.p[2]);
  const color = new THREE.Color(p.c || '#3df5ff');
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(p.r, p.r * 1.1, 0.12, 32),
    new THREE.MeshStandardMaterial({ color: '#20242c', roughness: 0.5, metalness: 0.6 }),
  );
  base.position.y = 0.04;
  base.receiveShadow = true;
  base.userData.ownMaterial = true;
  g.add(base);
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  ringMat.toneMapped = false;
  const ring = new THREE.Mesh(new THREE.RingGeometry(p.r * 0.45, p.r * 0.9, 32), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.111;
  ring.userData.ownMaterial = true;
  g.add(ring);
  // arrow showing launch direction
  const dir = new THREE.Vector3(p.v[0], 0, p.v[2]);
  if (dir.lengthSq() > 0.01) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.42); shape.lineTo(0.25, 0.1); shape.lineTo(0.1, 0.1); shape.lineTo(0.1, -0.3); shape.lineTo(-0.1, -0.3); shape.lineTo(-0.1, 0.1); shape.lineTo(-0.25, 0.1);
    const arrow = new THREE.Mesh(new THREE.ShapeGeometry(shape), ringMat);
    arrow.rotation.x = -Math.PI / 2;
    arrow.rotation.z = Math.atan2(-dir.x, -dir.z) + Math.PI;
    arrow.position.y = 0.115;
    g.add(arrow);
  }
  // rising light column
  const colMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  const col = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.8, p.r * 0.9, 2.4, 24, 1, true), colMat);
  col.position.y = 1.2;
  col.userData.ownMaterial = true;
  col.userData.padColumn = true;
  g.add(col);
  g.name = 'pad';
  return g;
}
