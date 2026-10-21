// Props for the v1.02 maps (Overgrown Mall, Splash Kingdom waterpark, Toy Factory).
// Visual only: collision always comes from map.solids. Static props are merged by batchStatic;
// moving parts flag themselves with userData.dynamic so only they stay separate draw calls.
import * as THREE from 'three';
import { textTexture, surfaceMaterial } from './textures.js';

const DEG = Math.PI / 180;

/**
 * Lights that map events can switch (power outage). Shared materials: switching one switches
 * every ceiling panel / emergency strip on the map, even after they were merged.
 */
export const POWER = {
  lights: new THREE.MeshBasicMaterial({ color: '#fff6dc' }),
  emergency: new THREE.MeshBasicMaterial({ color: '#2a0d0d' }),
  window: new THREE.MeshBasicMaterial({ color: '#7fd6ff' }),
};
for (const m of Object.values(POWER)) m.toneMapped = false;

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...extra });

function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.userData.ownMaterial = true;
  return m;
}

/** Merge geometries with per-vertex colours into one mesh (props with many small coloured parts). */
function colouredMerge(parts) {
  const pos = [], nor = [], col = [], idx = [];
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const c = new THREE.Color();
  for (const { geo, matrix, color } of parts) {
    const base = pos.length / 3;
    nm.getNormalMatrix(matrix);
    c.set(color);
    const P = geo.attributes.position, N = geo.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(matrix);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nor.push(v.x, v.y, v.z);
      col.push(c.r, c.g, c.b);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) idx.push(base + geo.index.getX(i));
    else for (let i = 0; i < P.count; i++) idx.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const M4 = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));

let _vineTex = null;
function vineTexture() {
  if (_vineTex) return _vineTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 64, 256);
  x.strokeStyle = '#3f5a26'; x.lineWidth = 3;
  x.beginPath(); x.moveTo(32, 0);
  for (let y = 0; y <= 256; y += 16) x.lineTo(32 + Math.sin(y * 0.08) * 6, y);
  x.stroke();
  for (let y = 6; y < 250; y += 9) {
    const side = (y / 9) % 2 ? 1 : -1;
    x.fillStyle = ['#4f7a2c', '#6a9a38', '#3d6624', '#82b04a'][(y / 9) % 4 | 0];
    x.beginPath();
    x.ellipse(32 + side * 9 + Math.sin(y * 0.08) * 6, y, 9, 5.5, side * 0.6, 0, Math.PI * 2);
    x.fill();
  }
  _vineTex = new THREE.CanvasTexture(c);
  _vineTex.colorSpace = THREE.SRGBColorSpace;
  return _vineTex;
}

let _grassTex = null;
function grassTexture() {
  if (_grassTex) return _grassTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  for (let i = 0; i < 70; i++) {
    const bx = 4 + Math.random() * 120;
    x.strokeStyle = ['#5d8a32', '#7aa83f', '#4a7428', '#9ac25a'][i % 4];
    x.lineWidth = 2;
    x.beginPath(); x.moveTo(bx, 128); x.quadraticCurveTo(bx + (Math.random() - 0.5) * 20, 70, bx + (Math.random() - 0.5) * 30, 20 + Math.random() * 60); x.stroke();
  }
  _grassTex = new THREE.CanvasTexture(c);
  _grassTex.colorSpace = THREE.SRGBColorSpace;
  return _grassTex;
}

let _vineMat = null, _grassMat = null;

export const PREFABS2 = {
  // ------------------------------------------------------------------ mall
  vines(d, ctx) {
    // strands of ivy hanging from a balcony edge (a -> b), random lengths up to d.len
    if (!_vineMat) _vineMat = new THREE.MeshStandardMaterial({ map: vineTexture(), transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
    const g = new THREE.Group();
    const a = new THREE.Vector3(...d.a), b = new THREE.Vector3(...d.b);
    const n = Math.max(2, Math.round((a.distanceTo(b) / 1.6) * (d.density ?? 1) * ctx.quality.decorDensity));
    const along = b.clone().sub(a);
    const yaw = Math.atan2(along.x, along.z);
    for (let i = 0; i < n; i++) {
      if (ctx.rng() < 0.25) continue;
      const len = d.len * (0.35 + ctx.rng() * 0.65);
      const geo = new THREE.PlaneGeometry(0.55, len);
      geo.translate(0, -len / 2, 0);
      // map the strand texture so leaves keep their size whatever the length
      const uv = geo.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) * (len / 3) + 1 - len / 3);
      const m = mesh(geo, _vineMat, { cast: false });
      m.position.copy(a).lerp(b, (i + ctx.rng() * 0.8) / n);
      m.position.x += (ctx.rng() - 0.5) * 0.3;
      m.position.z += (ctx.rng() - 0.5) * 0.3;
      m.rotation.y = yaw + Math.PI / 2 + (ctx.rng() - 0.5) * 0.6;
      g.add(m);
    }
    return g;
  },

  tree_big(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const s = d.s || 1;
    const trunk = mesh(new THREE.CylinderGeometry(0.22 * s, 0.38 * s, 4.2 * s, 8), std('#5b4330', { roughness: 0.95 }));
    trunk.position.y = 2.1 * s;
    g.add(trunk);
    const greens = ['#4e7d2e', '#6a9a3a', '#3f6b27', '#7fae49'];
    const leafGeo = new THREE.IcosahedronGeometry(1.4 * s, 0);
    for (let i = 0; i < 7; i++) {
      const b = mesh(leafGeo, std(greens[i % 4], { flatShading: true, roughness: 0.95 }));
      const a = (i / 7) * Math.PI * 2;
      const r = i === 0 ? 0 : 1.2 * s;
      b.position.set(Math.cos(a) * r, (4.4 + (i === 0 ? 0.9 : ctx.rng() * 0.8)) * s, Math.sin(a) * r);
      b.scale.setScalar(0.8 + ctx.rng() * 0.5);
      g.add(b);
    }
    return g;
  },

  shrubs(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    const mats = ['#4e7d2e', '#6a9a3a', '#3f6b27'].map((c) => std(c, { flatShading: true, roughness: 0.95 }));
    const n = Math.round((d.n || 10) * ctx.quality.decorDensity) + 2;
    for (let i = 0; i < n; i++) {
      const b = mesh(geo, mats[i % 3]);
      b.position.set((ctx.rng() - 0.5) * d.w, 0.3 + ctx.rng() * 0.25, (ctx.rng() - 0.5) * d.d);
      b.scale.set(0.8 + ctx.rng(), 0.6 + ctx.rng() * 0.6, 0.8 + ctx.rng());
      g.add(b);
    }
    return g;
  },

  grass(d, ctx) {
    if (!_grassMat) _grassMat = new THREE.MeshStandardMaterial({ map: grassTexture(), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 1 });
    const g = new THREE.Group();
    g.position.set(...d.p);
    const n = Math.round((d.n || 16) * ctx.quality.decorDensity) + 3;
    for (let i = 0; i < n; i++) {
      const h = 0.4 + ctx.rng() * 0.5;
      const geo = new THREE.PlaneGeometry(0.9, h);
      geo.translate(0, h / 2, 0);
      for (const rot of [0, Math.PI / 2]) {
        const m = mesh(geo, _grassMat, { cast: false });
        m.position.set((ctx.rng() - 0.5) * d.w, 0, (ctx.rng() - 0.5) * d.d);
        m.rotation.y = rot + ctx.rng();
        g.add(m);
      }
    }
    return g;
  },

  chandelier(d) {
    // a hanging sculpture of rusty oval rings (the mall's landmark)
    const g = new THREE.Group();
    g.position.set(...d.p);
    const mat = std('#b0805a', { metalness: 0.6, roughness: 0.55 });
    for (let i = 0; i < 9; i++) {
      const r = d.r * (1 - i * 0.075);
      const ring = mesh(new THREE.CylinderGeometry(r, r, 0.45, 40, 1, true), mat, { cast: false });
      ring.material.side = THREE.DoubleSide;
      ring.scale.z = 0.62;
      ring.position.y = -i * 0.55;
      ring.rotation.y = i * 0.12;
      g.add(ring);
    }
    const cable = mesh(new THREE.CylinderGeometry(0.03, 0.03, 4, 4), std('#333'), { cast: false });
    cable.position.y = 2.2;
    g.add(cable);
    return g;
  },

  skylight(d) {
    const g = new THREE.Group();
    const w = d.x1 - d.x0, dd = d.z1 - d.z0;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, dd), new THREE.MeshStandardMaterial({ color: '#cfefff', transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false }));
    glass.rotation.x = Math.PI / 2;
    glass.position.set((d.x0 + d.x1) / 2, d.y, (d.z0 + d.z1) / 2);
    glass.userData.ownMaterial = true;
    g.add(glass);
    const frameMat = std('#8a6a50', { metalness: 0.5, roughness: 0.5 });
    for (let x = d.x0; x <= d.x1 + 0.01; x += 4) {
      const bar = mesh(new THREE.BoxGeometry(0.18, 0.25, dd), frameMat, { cast: true });
      bar.position.set(x, d.y, (d.z0 + d.z1) / 2);
      g.add(bar);
    }
    for (let z = d.z0; z <= d.z1 + 0.01; z += 4) {
      const bar = mesh(new THREE.BoxGeometry(w, 0.25, 0.18), frameMat, { cast: true });
      bar.position.set((d.x0 + d.x1) / 2, d.y, z);
      g.add(bar);
    }
    return g;
  },

  ceiling(d) {
    // flat dark ceiling (with holes), never casts shadows so the floors below stay lit
    const g = new THREE.Group();
    const mat = std(d.color || '#7c807c', { roughness: 0.95, side: THREE.DoubleSide, emissive: d.emissive || '#24262a' });
    for (const [x0, z0, x1, z1] of rectMinus(d.x0, d.z0, d.x1, d.z1, d.holes || [])) {
      const p = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat, { cast: false });
      p.rotation.x = Math.PI / 2;
      p.position.set((x0 + x1) / 2, d.y, (z0 + z1) / 2);
      g.add(p);
    }
    return g;
  },

  ceiling_lights(d, ctx) {
    // rows of light panels under a ceiling; they black out in a power outage
    const g = new THREE.Group();
    const geo = new THREE.PlaneGeometry(2.4, 0.5);
    geo.rotateX(Math.PI / 2);
    const holes = d.holes || [];
    for (let x = d.x0 + d.step / 2; x < d.x1; x += d.step) {
      for (let z = d.z0 + d.step / 2; z < d.z1; z += d.step) {
        if (holes.some(([a, b, c, e]) => x > a - 1 && x < c + 1 && z > b - 1 && z < e + 1)) continue;
        if (ctx.rng() < (d.broken ?? 0)) continue;
        const p = new THREE.Mesh(geo, POWER.lights);
        p.position.set(x, d.y, z);
        g.add(p);
      }
    }
    return g;
  },

  emergency_lights(d) {
    // little red lamps along the walls: dark until the power fails
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.5, 0.18, 0.18);
    for (const p of d.pts) {
      const m = new THREE.Mesh(geo, POWER.emergency);
      m.position.set(...p);
      g.add(m);
    }
    return g;
  },

  shop_sign(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    g.rotation.y = (d.rot || 0) * DEG;
    const back = mesh(new THREE.BoxGeometry(d.w + 0.2, 0.9, 0.12), std('#1c1f24', { roughness: 0.5 }), { cast: false });
    g.add(back);
    const mat = new THREE.MeshBasicMaterial({ map: textTexture(d.text, { color: d.color, glow: 10, width: 512, height: 128, font: '900 84px "Segoe UI", sans-serif' }), transparent: true });
    mat.toneMapped = false;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(d.w, 0.75), mat);
    face.position.z = 0.07;
    g.add(face);
    return g;
  },

  mannequin(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    g.rotation.y = (d.rot || 0) * DEG;
    const mat = std(d.color || '#e8e2d8', { roughness: 0.4 });
    const body = mesh(new THREE.CapsuleGeometry(0.2, 0.7, 4, 10), mat);
    body.position.y = 1.15;
    const head = mesh(new THREE.SphereGeometry(0.15, 12, 8), mat);
    head.position.y = 1.75;
    const stand = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), std('#555'));
    stand.position.y = 0.35;
    const base = mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16), std('#555'));
    for (const s of [-1, 1]) {
      const arm = mesh(new THREE.CapsuleGeometry(0.06, 0.55, 3, 6), mat);
      arm.position.set(s * 0.28, 1.15, 0);
      arm.rotation.z = s * 0.15;
      g.add(arm);
    }
    g.add(body, head, stand, base);
    return g;
  },

  fountain(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const rim = mesh(new THREE.TorusGeometry(d.r, 0.28, 10, 48), std('#cfc9be', { roughness: 0.5 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.3;
    g.add(rim);
    const floor = mesh(new THREE.CircleGeometry(d.r, 40), std('#3a7f8a', { roughness: 0.6 }), { cast: false });
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.015;
    g.add(floor);
    // the jets: animated, so they keep their own mesh
    const jetMat = new THREE.MeshBasicMaterial({ color: '#d8f6ff', transparent: true, opacity: 0.55, depthWrite: false });
    jetMat.toneMapped = false;
    const jets = new THREE.Group();
    jets.userData.dynamic = true;
    for (let i = 0; i < 6; i++) {
      const j = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, 1.6, 6), jetMat);
      const a = (i / 6) * Math.PI * 2;
      j.position.set(Math.cos(a) * 1.2, 2.4 + 0.8, Math.sin(a) * 1.2);
      j.rotation.z = Math.cos(a) * 0.5;
      j.rotation.x = -Math.sin(a) * 0.5;
      jets.add(j);
    }
    g.add(jets);
    ctx.animated.push((dt, t) => {
      jetMat.opacity = 0.45 + Math.sin(t * 9) * 0.1;
      jets.scale.y = 1 + Math.sin(t * 6) * 0.06;
    });
    return g;
  },

  light_shafts(d) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: '#fff3c8', transparent: true, opacity: 0.07, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    mat.toneMapped = false;
    for (const p of d.pts) {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(d.r * 0.6, d.r, d.h, 16, 1, true), mat);
      shaft.position.set(p[0], p[1] - d.h / 2, p[2]);
      shaft.rotation.z = 0.12;
      g.add(shaft);
    }
    return g;
  },

  rubble(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const mats = ['#8c8a84', '#a9a69e', '#6f6d68'].map((c) => std(c, { flatShading: true, roughness: 1 }));
    const geo = new THREE.DodecahedronGeometry(0.4, 0);
    for (let i = 0; i < (d.n || 14); i++) {
      const r = mesh(geo, mats[i % 3]);
      r.position.set((ctx.rng() - 0.5) * d.w, 0.15, (ctx.rng() - 0.5) * d.d);
      r.scale.set(0.5 + ctx.rng(), 0.3 + ctx.rng() * 0.5, 0.5 + ctx.rng());
      r.rotation.set(ctx.rng() * 3, ctx.rng() * 3, 0);
      g.add(r);
    }
    return g;
  },

  // ------------------------------------------------------------------ waterpark
  steps(d) {
    // visible staircase over a smooth collision slope (spiral towers)
    const g = new THREE.Group();
    const [x0, y0, z0, x1, y1, z1] = d.b;
    const { material } = surfaceMaterial(d.m || 'concrete');
    const rise = (y1 - y0) / d.n;
    for (let i = 0; i < d.n; i++) {
      const t0 = i / d.n, t1 = (i + 1) / d.n;
      const h = rise * (i + 0.5); // half steps at both ends: the collision slope runs through the middle of every tread
      let bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
      if (d.dir === '+x') { bx0 = x0 + (x1 - x0) * t0; bx1 = x0 + (x1 - x0) * t1; }
      if (d.dir === '-x') { bx1 = x1 - (x1 - x0) * t0; bx0 = x1 - (x1 - x0) * t1; }
      if (d.dir === '+z') { bz0 = z0 + (z1 - z0) * t0; bz1 = z0 + (z1 - z0) * t1; }
      if (d.dir === '-z') { bz1 = z1 - (z1 - z0) * t0; bz0 = z1 - (z1 - z0) * t1; }
      const geo = new THREE.BoxGeometry(bx1 - bx0, h, bz1 - bz0);
      // world-space-ish UVs are not needed: one tile per tread reads as a staircase
      const m = mesh(geo, material);
      m.position.set((bx0 + bx1) / 2, y0 + h / 2, (bz0 + bz1) / 2);
      g.add(m);
    }
    return g;
  },

  palm(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const h = d.h || 6;
    const bark = std('#8a6a48', { roughness: 0.95 });
    const segs = 6;
    let x = 0, z = 0;
    const lean = (ctx.rng() - 0.5) * 0.5, dir = ctx.rng() * Math.PI * 2;
    for (let i = 0; i < segs; i++) {
      const s = mesh(new THREE.CylinderGeometry(0.17 - i * 0.012, 0.22 - i * 0.012, h / segs + 0.05, 7), bark);
      const k = i / segs;
      x = Math.cos(dir) * lean * k * k * h * 0.4;
      z = Math.sin(dir) * lean * k * k * h * 0.4;
      s.position.set(x, (i + 0.5) * (h / segs), z);
      g.add(s);
    }
    const leaf = std('#3f8f3a', { side: THREE.DoubleSide, roughness: 0.8 });
    const frond = new THREE.PlaneGeometry(0.7, 3.2, 1, 4);
    frond.translate(0, 1.6, 0);
    // droop: bend the frond along its length
    const pp = frond.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const yy = pp.getY(i);
      pp.setZ(i, -(yy * yy) * 0.12);
    }
    frond.computeVertexNormals();
    for (let i = 0; i < 8; i++) {
      const f = mesh(frond, leaf);
      f.position.set(x, h, z);
      f.rotation.set(-1.05 + ctx.rng() * 0.2, (i / 8) * Math.PI * 2, 0, 'YXZ');
      g.add(f);
    }
    const nut = mesh(new THREE.SphereGeometry(0.28, 8, 6), std('#5a4630'));
    nut.position.set(x, h - 0.15, z);
    g.add(nut);
    return g;
  },

  pool(d) {
    // round pool: tiled floor seen through the water + a smooth stone rim
    const g = new THREE.Group();
    const floorTex = textTexturePool();
    const floor = mesh(new THREE.CircleGeometry(d.r, 48), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.4 }), { cast: false });
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(d.c[0], 0.012, d.c[1]);
    g.add(floor);
    const rim = mesh(new THREE.TorusGeometry(d.r, 0.3, 8, 64), std('#d9dde3', { roughness: 0.4 }));
    rim.rotation.x = Math.PI / 2;
    rim.scale.z = 0.5;
    rim.position.set(d.c[0], 0.12, d.c[1]);
    g.add(rim);
    // pool ladder
    const rail = std('#c9ced6', { metalness: 0.8, roughness: 0.25 });
    for (const s of [-0.3, 0.3]) {
      const l = mesh(new THREE.TorusGeometry(0.35, 0.03, 6, 12, Math.PI), rail, { cast: false });
      l.position.set(d.c[0] + s, 0.6, d.c[1] - d.r);
      l.rotation.y = Math.PI / 2;
      g.add(l);
    }
    return g;
  },

  umbrella(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const pole = mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 6), std('#eeeeee'));
    pole.position.y = 1.2;
    const top = mesh(new THREE.ConeGeometry(1.4, 0.55, 12, 1, true), std(d.color || '#f4f4f4', { side: THREE.DoubleSide, roughness: 0.8 }));
    top.position.y = 2.45;
    g.add(pole, top);
    return g;
  },

  funnel(d) {
    // the big checkered funnel ride (decorative; its core column collides)
    const g = new THREE.Group();
    g.position.set(...d.p);
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push(new THREE.Vector2(0.9 + Math.pow(t, 2.2) * d.r, t * d.h));
    }
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#3d5ed8' : '#2fbfd0'; x.fillRect(i * 16, j * 16, 16, 16); }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 3);
    tex.colorSpace = THREE.SRGBColorSpace;
    const f = mesh(new THREE.LatheGeometry(pts, 40), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.35 }));
    f.position.y = d.base || 3;
    g.add(f);
    const stem = mesh(new THREE.CylinderGeometry(0.9, 1.1, d.base || 3, 20), std('#3d5ed8'));
    stem.position.y = (d.base || 3) / 2;
    g.add(stem);
    return g;
  },

  mushroom(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const stem = mesh(new THREE.CylinderGeometry(0.35, 0.45, d.h, 16), std('#f2ead8'));
    stem.position.y = d.h / 2;
    const cap = mesh(new THREE.SphereGeometry(d.r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), std('#e2322f', { roughness: 0.5 }));
    cap.position.y = d.h;
    cap.scale.y = 0.55;
    g.add(stem, cap);
    const spot = std('#ffffff');
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const s = mesh(new THREE.CircleGeometry(0.22, 10), spot, { cast: false });
      const r = d.r * 0.7;
      s.position.set(Math.cos(a) * r, d.h + d.r * 0.32, Math.sin(a) * r);
      s.lookAt(Math.cos(a) * r * 3, d.h + d.r * 1.2, Math.sin(a) * r * 3);
      g.add(s);
    }
    return g;
  },

  bunting(d, ctx) {
    const g = new THREE.Group();
    const a = new THREE.Vector3(...d.a), b = new THREE.Vector3(...d.b);
    const n = Math.max(4, Math.round(a.distanceTo(b) / 0.8));
    const cols = d.colors || ['#ff3db0', '#2fd8e8', '#ffd23d', '#7dff6b'];
    const flag = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.22, 0, 0), new THREE.Vector3(0.22, 0, 0), new THREE.Vector3(0, -0.45, 0)]);
    flag.setIndex([0, 2, 1]);
    flag.computeVertexNormals();
    const mats = cols.map((c) => std(c, { side: THREE.DoubleSide }));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const p = a.clone().lerp(b, t);
      p.y -= Math.sin(Math.PI * t) * 0.9;
      const f = mesh(flag, mats[i % mats.length], { cast: false });
      f.position.copy(p);
      f.lookAt(p.x + (b.z - a.z), p.y, p.z - (b.x - a.x));
      g.add(f);
    }
    return g;
  },

  // ------------------------------------------------------------------ toy factory
  robot_arm(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    g.rotation.y = (d.rot || 0) * DEG;
    const body = std(d.color || '#f08a3c', { metalness: 0.3, roughness: 0.45 });
    const dark = std('#2b2f36', { metalness: 0.6 });
    const base = mesh(new THREE.CylinderGeometry(0.6, 0.75, 0.6, 16), dark);
    base.position.y = 0.3;
    g.add(base);
    // the moving part keeps its own meshes
    const turret = new THREE.Group();
    turret.position.y = 0.6;
    turret.userData.dynamic = true;
    const lower = mesh(new THREE.BoxGeometry(0.35, 1.8, 0.35), body);
    lower.position.y = 0.9;
    const elbow = new THREE.Group();
    elbow.position.y = 1.8;
    const upper = mesh(new THREE.BoxGeometry(0.28, 1.5, 0.28), body);
    upper.position.y = 0.75;
    const claw = mesh(new THREE.BoxGeometry(0.5, 0.2, 0.2), dark);
    claw.position.y = 1.55;
    elbow.add(upper, claw);
    turret.add(lower, elbow);
    g.add(turret);
    const seed = ctx.rng() * 6;
    ctx.animated.push((dt, t) => {
      turret.rotation.y = Math.sin(t * 0.7 + seed) * 1.2;
      lower.rotation.z = 0;
      elbow.rotation.z = -0.6 + Math.sin(t * 1.3 + seed) * 0.5;
    });
    return g;
  },

  gear(d, ctx) {
    const shape = new THREE.Shape();
    const teeth = d.teeth || 12;
    for (let i = 0; i < teeth * 2; i++) {
      const r = i % 2 ? d.r * 0.82 : d.r;
      const a0 = (i / (teeth * 2)) * Math.PI * 2, a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
      if (i === 0) shape.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
      shape.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
      shape.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
    }
    const hole = new THREE.Path();
    hole.absarc(0, 0, d.r * 0.25, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false });
    geo.translate(0, 0, -0.15);
    const m = mesh(geo, std(d.color || '#c9a227', { metalness: 0.7, roughness: 0.35 }));
    m.position.set(...d.p);
    m.rotation.y = (d.rot || 0) * DEG;
    m.userData.dynamic = true;
    const speed = (d.speed ?? 0.5) * (ctx.rng() < 0.5 ? 1 : -1);
    ctx.animated.push((dt) => { m.rotateZ(speed * dt); });
    return m;
  },

  toy_pile(d, ctx) {
    // a heap of brightly coloured toy parts on top of a bin (one draw call per heap)
    const cols = ['#e23b3b', '#2f7ae0', '#f2c230', '#3cb54a', '#8a4fd8', '#ff8a3c', '#ffffff'];
    const geos = [new THREE.BoxGeometry(0.4, 0.25, 0.25), new THREE.SphereGeometry(0.2, 8, 6), new THREE.CylinderGeometry(0.15, 0.15, 0.35, 8), new THREE.TorusGeometry(0.16, 0.06, 6, 12), new THREE.ConeGeometry(0.18, 0.35, 8)];
    const parts = [];
    const n = Math.round(((d.x1 - d.x0) * (d.z1 - d.z0)) * 2.2 * ctx.quality.decorDensity) + 6;
    const cx = (d.x0 + d.x1) / 2, cz = (d.z0 + d.z1) / 2;
    for (let i = 0; i < n; i++) {
      const x = d.x0 + 0.2 + ctx.rng() * (d.x1 - d.x0 - 0.4), z = d.z0 + 0.2 + ctx.rng() * (d.z1 - d.z0 - 0.4);
      // heaped: higher in the middle
      const k = 1 - Math.max(Math.abs(x - cx) / ((d.x1 - d.x0) / 2), Math.abs(z - cz) / ((d.z1 - d.z0) / 2));
      const y = d.y + 0.1 + ctx.rng() * 0.25 + k * (d.heap ?? 0.5);
      parts.push({ geo: geos[i % geos.length], matrix: M4(x, y, z, ctx.rng() * 3, ctx.rng() * 3, ctx.rng() * 3), color: cols[(ctx.rng() * cols.length) | 0] });
    }
    return mesh(colouredMerge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }), { cast: false });
  },

  ball_pit(d, ctx) {
    const cols = ['#e23b3b', '#2f7ae0', '#f2c230', '#3cb54a', '#ff6bd6', '#ffffff'];
    const geo = new THREE.IcosahedronGeometry(0.19, 0);
    const parts = [];
    const n = Math.round(((d.x1 - d.x0) * (d.z1 - d.z0)) * 5 * Math.max(0.5, ctx.quality.decorDensity));
    for (let i = 0; i < n; i++) {
      const x = d.x0 + ctx.rng() * (d.x1 - d.x0), z = d.z0 + ctx.rng() * (d.z1 - d.z0);
      parts.push({ geo, matrix: M4(x, d.y - ctx.rng() * 0.35, z), color: cols[(ctx.rng() * cols.length) | 0] });
    }
    return mesh(colouredMerge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35 }), { cast: false });
  },

  duck(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    g.rotation.y = (d.rot || 0) * DEG;
    const s = d.s || 1;
    const yellow = std('#ffd23d', { roughness: 0.35 });
    const body = mesh(new THREE.SphereGeometry(1.4 * s, 24, 16), yellow);
    body.scale.set(1.25, 0.85, 1);
    body.position.y = 1.1 * s;
    const head = mesh(new THREE.SphereGeometry(0.85 * s, 20, 14), yellow);
    head.position.set(0.9 * s, 2.4 * s, 0);
    const beak = mesh(new THREE.ConeGeometry(0.32 * s, 0.7 * s, 12), std('#ff7a2f', { roughness: 0.4 }));
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(1.95 * s, 2.3 * s, 0);
    g.add(body, head, beak);
    for (const z of [-0.45, 0.45]) {
      const eye = mesh(new THREE.SphereGeometry(0.12 * s, 8, 6), std('#111'));
      eye.position.set(1.55 * s, 2.65 * s, z * s);
      g.add(eye);
    }
    return g;
  },

  teddy(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    g.rotation.y = (d.rot || 0) * DEG;
    const s = d.s || 1;
    const fur = std('#a8703f', { roughness: 0.95 });
    const light = std('#e2c49a', { roughness: 0.95 });
    const add = (geo, mat, x, y, z) => { const m = mesh(geo, mat); m.position.set(x * s, y * s, z * s); g.add(m); return m; };
    add(new THREE.SphereGeometry(1.1 * s, 18, 12), fur, 0, 1.1, 0).scale.y = 1.1;
    add(new THREE.SphereGeometry(0.75 * s, 18, 12), fur, 0, 2.6, 0);
    add(new THREE.SphereGeometry(0.3 * s, 12, 8), light, 0, 2.45, 0.62);
    for (const x of [-0.55, 0.55]) {
      add(new THREE.SphereGeometry(0.28 * s, 12, 8), fur, x, 3.2, 0);
      add(new THREE.SphereGeometry(0.4 * s, 12, 8), fur, x * 1.9, 1.5, 0.1);
      add(new THREE.SphereGeometry(0.45 * s, 12, 8), fur, x * 1.1, 0.35, 0.45);
      add(new THREE.SphereGeometry(0.08 * s, 8, 6), std('#111'), x * 0.45, 2.75, 0.62);
    }
    return g;
  },

  wall_windows(d) {
    // glowing window panes along a wall (they dim with the power)
    const g = new THREE.Group();
    const frame = std('#3a4048', { metalness: 0.5 });
    const horiz = d.axis === 'x';
    const from = d.from_ ?? d.from;
    for (let i = 0; i < d.count; i++) {
      const t = (i + 0.5) / d.count;
      const x = horiz ? from + (d.to - from) * t : d.at;
      const z = horiz ? d.at : from + (d.to - from) * t;
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), POWER.window);
      pane.position.set(x, d.y, z);
      pane.rotation.y = horiz ? (d.facing || 0) : Math.PI / 2 * (d.facing || 1);
      g.add(pane);
      const f = mesh(new THREE.BoxGeometry(horiz ? d.w + 0.3 : 0.12, d.h + 0.3, horiz ? 0.12 : d.w + 0.3), frame, { cast: false });
      f.position.set(x, d.y, z);
      g.add(f);
      const bar = mesh(new THREE.BoxGeometry(horiz ? 0.12 : 0.14, d.h, horiz ? 0.14 : 0.12), frame, { cast: false });
      bar.position.set(x, d.y, z);
      g.add(bar);
    }
    return g;
  },

  pipes(d) {
    const g = new THREE.Group();
    const curve = new THREE.CatmullRomCurve3(d.pts.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.1);
    const m = mesh(new THREE.TubeGeometry(curve, Math.max(16, d.pts.length * 10), d.r || 0.3, 10, false), std(d.color || '#9aa6b8', { metalness: 0.6, roughness: 0.35 }));
    g.add(m);
    return g;
  },

  hazard(d) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 32;
    const x = c.getContext('2d');
    x.fillStyle = '#f2c230'; x.fillRect(0, 0, 128, 32);
    x.fillStyle = '#1a1a1a';
    for (let i = -32; i < 160; i += 32) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 16, 0); x.lineTo(i - 16, 32); x.lineTo(i - 32, 32); x.fill(); }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, d.w / 2), 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = mesh(new THREE.PlaneGeometry(d.w, d.d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }), { cast: false });
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = (d.rot || 0) * DEG;
    m.position.set(d.p[0], d.p[1] + 0.015, d.p[2]);
    return m;
  },
};

let _poolTex = null;
function textTexturePool() {
  if (_poolTex) return _poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#1f7fd0'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
    x.fillStyle = (i + j) % 2 ? '#2a8fe0' : '#2384d6';
    x.fillRect(i * 16 + 1, j * 16 + 1, 14, 14);
  }
  x.globalAlpha = 0.2; x.strokeStyle = '#d8f6ff'; x.lineWidth = 4;
  for (let i = 0; i < 10; i++) { x.beginPath(); const y = Math.random() * 256; x.moveTo(0, y); x.bezierCurveTo(80, y + 30, 170, y - 30, 256, y); x.stroke(); }
  _poolTex = new THREE.CanvasTexture(c);
  _poolTex.wrapS = _poolTex.wrapT = THREE.RepeatWrapping;
  _poolTex.repeat.set(3, 3);
  _poolTex.colorSpace = THREE.SRGBColorSpace;
  return _poolTex;
}

/** JS twin of tools/build_maps.py rect_minus (ceilings with holes). */
function rectMinus(x0, z0, x1, z1, holes) {
  const hs = holes.map((h) => [Math.max(x0, h[0]), Math.max(z0, h[1]), Math.min(x1, h[2]), Math.min(z1, h[3])]).filter((h) => h[0] < h[2] && h[1] < h[3]);
  const xs = [...new Set([x0, x1, ...hs.flatMap((h) => [h[0], h[2]])])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1];
    const cuts = hs.filter((h) => h[0] <= a && h[2] >= b).map((h) => [h[1], h[3]]).sort((p, q) => p[0] - q[0]);
    let z = z0;
    for (const [c0, c1] of cuts) {
      if (c0 > z) out.push([a, z, b, c0]);
      z = Math.max(z, c1);
    }
    if (z < z1) out.push([a, z, b, z1]);
  }
  return out;
}
