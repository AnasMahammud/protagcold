// Visual-only map props (no collision; collision always comes from map.solids).
// Every prefab is built from primitives + procedural textures so the art style stays coherent.
import * as THREE from 'three';
import { textTexture, texture } from './textures.js';
import { mulberry32 } from '../core/mathUtil.js';
import { PREFABS2, POWER } from './decor2.js';

const DEG = Math.PI / 180;

function std(color, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...extra });
  return m;
}

function glow(color, opacity = 1) {
  const m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
  m.toneMapped = false;
  return m;
}

function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.userData.ownMaterial = true;
  return m;
}

export function buildDecor(map, quality, animated) {
  const root = new THREE.Group();
  root.name = 'decor';
  const lightBudget = { n: quality.pointLights ?? 0 };
  const ctx = { map, quality, animated, lightBudget, rng: mulberry32(1234) };
  // every map starts with the power on
  POWER.lights.color.set('#fff6dc');
  POWER.emergency.color.set('#2a0d0d');
  POWER.window.color.set('#7fd6ff');
  for (const d of map.decor || []) {
    const fn = PREFABS[d.t] || PREFABS2[d.t];
    if (!fn) {
      console.warn(`[decor] unknown prefab "${d.t}"`);
      continue;
    }
    const before = animated.length;
    const obj = fn(d, ctx);
    if (!obj) continue;
    // prefabs that animate keep their own meshes (unless they flagged only the moving parts
    // themselves, or declared batchSafe: the animation never moves a mesh); the rest is merged
    let marked = false;
    obj.traverse((o) => { if (o.userData.dynamic) marked = true; });
    if ((animated.length !== before && !marked && !obj.userData.batchSafe) || d.dynamic) obj.userData.dynamic = true;
    root.add(obj);
  }
  return root;
}

function addPointLight(parent, ctx, color, intensity, distance, y = 0) {
  if (ctx.lightBudget.n <= 0) return null;
  ctx.lightBudget.n--;
  const l = new THREE.PointLight(color, intensity, distance, 1.6);
  l.position.y = y;
  parent.add(l);
  return l;
}

const PREFABS = {
  water_tank(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const wood = texture('wood');
    const woodV = wood.clone();
    woodV.needsUpdate = true;
    woodV.rotation = Math.PI / 2;
    woodV.repeat.set(6, 1.5);
    const body = mesh(new THREE.CylinderGeometry(d.r, d.r, d.h, 28), std('#c58a55', { map: woodV, roughness: 0.85 }));
    body.position.y = d.h / 2;
    g.add(body);
    const roof = mesh(new THREE.ConeGeometry(d.r * 1.08, 1.4, 28), std('#5a4f4a', { roughness: 0.7 }));
    roof.position.y = d.h + 0.7;
    g.add(roof);
    const bandMat = std('#2c2c30', { metalness: 0.8, roughness: 0.4 });
    for (const y of [0.5, d.h * 0.5, d.h - 0.4]) {
      const band = mesh(new THREE.TorusGeometry(d.r + 0.02, 0.05, 6, 32), bandMat, { cast: false });
      band.rotation.x = Math.PI / 2;
      band.position.y = y;
      g.add(band);
    }
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.9), new THREE.MeshBasicMaterial({ map: textTexture('PRO TAG', { color: '#ff3df0', glow: 18 }), transparent: true }));
    logo.material.toneMapped = false;
    logo.position.set(0, d.h * 0.55, d.r + 0.03);
    g.add(logo);
    return g;
  },

  neon_sign(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    g.rotation.y = (d.rot || 0) * DEG;
    const back = mesh(new THREE.BoxGeometry(d.w + 0.3, d.h + 0.3, 0.15), std('#14141c', { roughness: 0.5, metalness: 0.5 }), { cast: false });
    back.position.z = 0.08;
    g.add(back);
    const mat = new THREE.MeshBasicMaterial({ map: textTexture(d.text, { color: d.color, glow: 30 }), transparent: true });
    mat.toneMapped = false;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), mat);
    face.position.z = 0.17;
    g.add(face);
    const light = addPointLight(g, ctx, d.color, 6, 9, 0);
    if (light) light.position.z = 1.2;
    const rng = ctx.rng;
    const seed = rng() * 100;
    ctx.animated.push((dt, t) => {
      // occasional flicker, like a real worn neon tube
      const f = Math.sin(t * 13 + seed) > 0.985 || Math.sin(t * 0.7 + seed) > 0.995 ? 0.25 : 1;
      mat.opacity = f;
      if (light) light.intensity = 6 * f;
    });
    return g;
  },

  billboard(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const legMat = std('#3b3f48', { metalness: 0.7, roughness: 0.4 });
    for (const x of [-d.w / 2 + 0.6, d.w / 2 - 0.6]) {
      const leg = mesh(new THREE.BoxGeometry(0.25, 3, 0.25), legMat);
      leg.position.set(x, 1.5, 0);
      g.add(leg);
    }
    const frame = mesh(new THREE.BoxGeometry(d.w + 0.4, d.h + 0.4, 0.3), legMat);
    frame.position.y = 3 + d.h / 2;
    g.add(frame);
    const canvasTex = textTexture(d.text, { color: '#ffffff', bg: '#101826', glow: 24, sub: 'NEON ROOFTOPS  •  CHASE LEAGUE', subColor: d.color });
    const panelMat = new THREE.MeshBasicMaterial({ map: canvasTex });
    panelMat.toneMapped = false;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), panelMat);
    panel.position.set(0, 3 + d.h / 2, 0.16);
    g.add(panel);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(d.w + 0.4, 0.12, 0.12), glow(d.color));
    strip.position.set(0, 3 + d.h + 0.26, 0.15);
    g.add(strip);
    return g;
  },

  string_lights(d) {
    const g = new THREE.Group();
    const a = new THREE.Vector3(...d.a);
    const b = new THREE.Vector3(...d.b);
    const n = 18;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = a.clone().lerp(b, t);
      p.y -= Math.sin(Math.PI * t) * 1.1; // sag
      pts.push(p);
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#222' }));
    g.add(line);
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), glow(d.color), n - 1);
    const m = new THREE.Matrix4();
    for (let i = 1; i < n; i++) {
      m.makeTranslation(pts[i].x, pts[i].y - 0.12, pts[i].z);
      bulbs.setMatrixAt(i - 1, m);
    }
    g.add(bulbs);
    return g;
  },

  lamp(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const poleMat = std('#2a2d35', { metalness: 0.7, roughness: 0.35 });
    const pole = mesh(new THREE.CylinderGeometry(0.07, 0.1, d.h, 8), poleMat);
    pole.position.y = d.h / 2;
    g.add(pole);
    const arm = mesh(new THREE.BoxGeometry(0.08, 0.08, 0.8), poleMat);
    arm.position.set(0, d.h, 0.35);
    g.add(arm);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), glow(d.color));
    bulb.position.set(0, d.h - 0.12, 0.7);
    g.add(bulb);
    const light = addPointLight(g, ctx, d.color, 10, 12, d.h - 0.3);
    if (light) light.position.z = 0.7;
    // cheap fake light pool on the ground (always on, costs one transparent quad)
    const pool = new THREE.Mesh(new THREE.CircleGeometry(3.2, 24), new THREE.MeshBasicMaterial({ map: poolTexture(), color: d.color, transparent: true, opacity: light ? 0.25 : 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.02, 0.7);
    pool.renderOrder = 1;
    g.add(pool);
    return g;
  },

  antenna(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const mat = std('#6d7380', { metalness: 0.8, roughness: 0.3 });
    const mast = mesh(new THREE.CylinderGeometry(0.05, 0.08, d.h, 6), mat);
    mast.position.y = d.h / 2;
    g.add(mast);
    for (let i = 1; i <= 3; i++) {
      const bar = mesh(new THREE.BoxGeometry(1.2 - i * 0.25, 0.04, 0.04), mat, { cast: false });
      bar.position.y = d.h * (0.4 + i * 0.15);
      g.add(bar);
    }
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), glow('#ff2a2a'));
    tip.position.y = d.h + 0.05;
    g.add(tip);
    const seed = ctx.rng() * 6;
    ctx.animated.push((dt, t) => {
      tip.visible = Math.sin(t * 3 + seed) > 0.2;
    });
    return g;
  },

  dish(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const mat = std('#d8dde6', { metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
    const stand = mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.9, 8), std('#555'));
    stand.position.y = 0.45;
    g.add(stand);
    const bowl = mesh(new THREE.SphereGeometry(d.r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 4), mat);
    bowl.position.y = 0.9;
    bowl.rotation.x = -Math.PI / 3;
    g.add(bowl);
    return g;
  },

  steam(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const count = Math.round(6 * ctx.quality.particles) || 2;
    const tex = puffTexture();
    const puffs = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, color: '#c8c8d8', transparent: true, opacity: 0.25, depthWrite: false });
      const s = new THREE.Sprite(mat);
      s.userData.phase = i / count;
      g.add(s);
      puffs.push(s);
    }
    ctx.animated.push((dt, t) => {
      for (const s of puffs) {
        const p = (t * 0.35 + s.userData.phase) % 1;
        s.position.set(Math.sin(p * 4 + s.userData.phase * 9) * 0.3, p * 3.2, Math.cos(p * 3) * 0.2);
        const sc = 0.5 + p * 1.8;
        s.scale.set(sc, sc, sc);
        s.material.opacity = 0.3 * (1 - p) * Math.min(1, p * 6);
      }
    });
    return g;
  },

  helipad_mark(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const ring = new THREE.Mesh(new THREE.RingGeometry(d.r - 0.25, d.r, 48), new THREE.MeshStandardMaterial({ color: '#f2d33a', roughness: 0.8 }));
    ring.rotation.x = -Math.PI / 2;
    ring.receiveShadow = true;
    g.add(ring);
    const h = new THREE.Mesh(new THREE.PlaneGeometry(d.r * 1.3, d.r * 1.3), new THREE.MeshStandardMaterial({ map: textTexture('H', { color: '#f4f4f4', width: 256, height: 256, font: '900 220px "Segoe UI", sans-serif' }), transparent: true, roughness: 0.8 }));
    h.rotation.x = -Math.PI / 2;
    h.position.y = 0.002;
    h.receiveShadow = true;
    g.add(h);
    return g;
  },

  plants(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const geo = new THREE.IcosahedronGeometry(0.45, 0);
    const mats = ['#3e8f43', '#5aa84a', '#2f7a3d'].map((c) => std(c, { roughness: 0.9, flatShading: true }));
    for (let i = 0; i < 14; i++) {
      const b = mesh(geo, mats[i % 3]);
      b.position.set((ctx.rng() - 0.5) * d.w, 0.35 + ctx.rng() * 0.3, (ctx.rng() - 0.5) * d.d);
      b.scale.setScalar(0.6 + ctx.rng() * 0.9);
      g.add(b);
    }
    return g;
  },

  scoreboard(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const body = mesh(new THREE.BoxGeometry(d.w, d.h, d.w), std('#111318', { metalness: 0.6, roughness: 0.4 }), { cast: false });
    g.add(body);
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 256;
    const c2 = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    mat.toneMapped = false;
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(d.w * 0.92, d.h * 0.86), mat);
      p.rotation.y = (i * Math.PI) / 2;
      p.position.set(Math.sin(p.rotation.y) * (d.w / 2 + 0.01), 0, Math.cos(p.rotation.y) * (d.w / 2 + 0.01));
      g.add(p);
    }
    const cable = mesh(new THREE.CylinderGeometry(0.03, 0.03, 3, 4), std('#222'), { cast: false });
    cable.position.y = d.h / 2 + 1.5;
    g.add(cable);
    let last = '';
    g.userData.batchSafe = true; // only the canvas texture changes
    ctx.animated.push((dt, t, info) => {
      const time = info?.clock ?? 'PULSE';
      const sub = info?.itName ? `IT: ${info.itName}` : 'CHASE TAG';
      const key = time + sub;
      if (key === last) return;
      last = key;
      c2.fillStyle = '#05070c'; c2.fillRect(0, 0, 512, 256);
      c2.textAlign = 'center';
      c2.fillStyle = '#ff5a3d'; c2.font = '900 120px "Segoe UI", sans-serif';
      c2.fillText(time, 256, 125);
      c2.fillStyle = '#9fd8ff'; c2.font = '700 44px "Segoe UI", sans-serif';
      c2.fillText(sub.slice(0, 20), 256, 210);
      tex.needsUpdate = true;
    });
    return g;
  },

  arena_lights(d) {
    const g = new THREE.Group();
    const panelMat = glow('#eaf2ff');
    const rigMat = std('#1a1d24', { metalness: 0.7 });
    for (let x = -15; x <= 15; x += 10) {
      for (let z = -15; z <= 15; z += 10) {
        const rig = mesh(new THREE.BoxGeometry(4.2, 0.3, 1.4), rigMat, { cast: false });
        rig.position.set(x, d.h, z);
        g.add(rig);
        const p = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 1.0), panelMat);
        p.rotation.x = Math.PI / 2;
        p.position.set(x, d.h - 0.16, z);
        g.add(p);
      }
    }
    const ceiling = mesh(new THREE.PlaneGeometry(80, 80), std('#0d1018', { roughness: 1 }), { cast: false });
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = 14;
    g.add(ceiling);
    return g;
  },

  bleachers(d, ctx) {
    const g = new THREE.Group();
    const seatMat = std('#2a3550', { roughness: 0.8 });
    const rows = 7;
    const count = Math.round(260 * ctx.quality.decorDensity);
    const people = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 0.45, 2, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), count * 4);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const palette = ['#ff5a3d', '#3d9bff', '#ffd23d', '#e9edf5', '#7dff6b', '#ff3df0', '#1f2b45'];
    let n = 0;
    for (let side = 0; side < 4; side++) {
      const rotY = (side * Math.PI) / 2;
      const sGroup = new THREE.Group();
      sGroup.rotation.y = rotY;
      for (let r = 0; r < rows; r++) {
        const step = mesh(new THREE.BoxGeometry(48, 0.6, 1.4), seatMat, { cast: false });
        step.position.set(0, 2.5 + r * 0.9, -(d.inner + 1.5 + r * 1.4));
        sGroup.add(step);
      }
      g.add(sGroup);
      for (let i = 0; i < count; i++) {
        const r = Math.floor(ctx.rng() * rows);
        const x = (ctx.rng() - 0.5) * 46;
        const z = -(d.inner + 1.5 + r * 1.4);
        const y = 2.5 + r * 0.9 + 0.3 + 0.45;
        const p = new THREE.Vector3(x, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
        m.makeTranslation(p.x, p.y, p.z);
        people.setMatrixAt(n, m);
        people.setColorAt(n, col.set(palette[(ctx.rng() * palette.length) | 0]));
        n++;
      }
    }
    people.count = n;
    // the crowd bounces: animated in the vertex shader (cheap, no per-instance CPU work)
    const uniforms = { uTime: { value: 0 } };
    people.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n float ph = float(gl_InstanceID) * 1.7;\n transformed.y += max(0.0, sin(uTime * 4.0 + ph)) * 0.18;',
      );
    };
    ctx.animated.push((dt, t) => { uniforms.uTime.value = t; });
    people.userData.dynamic = true;
    g.add(people);
    const wall = mesh(new THREE.BoxGeometry(70, 16, 1), std('#0f1420'), { cast: false });
    for (let side = 0; side < 4; side++) {
      const w = wall.clone();
      w.position.set(0, 8, -(d.inner + 12)).applyAxisAngle(new THREE.Vector3(0, 1, 0), (side * Math.PI) / 2);
      w.rotation.y = (side * Math.PI) / 2;
      g.add(w);
    }
    return g;
  },

  banner(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    g.rotation.y = (d.rot || 0) * DEG;
    const mat = new THREE.MeshBasicMaterial({ map: textTexture(d.text, { color: '#ffffff', bg: d.color, glow: 0, font: '900 150px "Segoe UI", sans-serif' }) });
    mat.toneMapped = false;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), mat);
    p.position.z = 0.05;
    g.add(p);
    return g;
  },

  floor_lines(d) {
    const mat = glow('#ff5a3d', 0.75);
    const ring = new THREE.Mesh(new THREE.RingGeometry(d.r - 0.12, d.r, 64), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    return ring;
  },

  crane(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const yellow = std('#e8b82a', { metalness: 0.5, roughness: 0.5 });
    const dark = std('#2b2f36', { metalness: 0.6 });
    const beam = mesh(new THREE.BoxGeometry(d.span + 1.6, 1.2, 1.2), yellow);
    beam.position.set(0, d.h, -d.depth / 2 + 6);
    for (const z of [-6, 6]) {
      const b = beam.clone();
      b.position.set(0, d.h, z);
      g.add(b);
    }
    const boom = mesh(new THREE.BoxGeometry(2.0, 1.0, 46), yellow);
    boom.position.set(0, d.h + 1.6, 14);
    g.add(boom);
    const cab = mesh(new THREE.BoxGeometry(3, 2.4, 3), dark);
    cab.position.set(0, d.h + 3.2, -2);
    g.add(cab);
    const cable = mesh(new THREE.CylinderGeometry(0.04, 0.04, 9, 4), dark, { cast: false });
    cable.position.set(0, d.h - 3, 20);
    g.add(cable);
    const hook = mesh(new THREE.BoxGeometry(1.6, 0.8, 1.6), dark);
    hook.position.set(0, d.h - 7.6, 20);
    g.add(hook);
    const seed = ctx.rng() * 10;
    ctx.animated.push((dt, t) => {
      const sway = Math.sin(t * 0.6 + seed) * 0.12;
      hook.rotation.z = sway;
      hook.position.x = Math.sin(t * 0.6 + seed) * 0.5;
    });
    return g;
  },

  water(d, ctx) {
    const geo = new THREE.PlaneGeometry(600, 600, 1, 1);
    const normal = waterNormalTexture();
    normal.repeat.set(60, 60);
    const mat = new THREE.MeshStandardMaterial({ color: '#1c4a6b', roughness: 0.12, metalness: 0.55, normalMap: normal, normalScale: new THREE.Vector2(0.6, 0.6) });
    const w = new THREE.Mesh(geo, mat);
    w.rotation.x = -Math.PI / 2;
    w.position.y = d.y;
    w.receiveShadow = true;
    ctx.animated.push((dt) => {
      normal.offset.x += dt * 0.012;
      normal.offset.y += dt * 0.007;
    });
    return w;
  },

  ship(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const hull = mesh(new THREE.BoxGeometry(d.len, 10, 18), std('#2b3240', { roughness: 0.7 }), { cast: false });
    hull.position.y = 3;
    g.add(hull);
    const stripe = mesh(new THREE.BoxGeometry(d.len + 0.2, 1.2, 18.2), std('#9a2a2a'), { cast: false });
    stripe.position.y = -1;
    g.add(stripe);
    const bridge = mesh(new THREE.BoxGeometry(12, 12, 16), std('#e6e6e6'), { cast: false });
    bridge.position.set(-d.len / 2 + 10, 14, 0);
    g.add(bridge);
    const colors = ['#b5382c', '#2d5fa8', '#2f8a4c', '#d9762a', '#d8b12b'];
    for (let i = 0; i < 26; i++) {
      const c = mesh(new THREE.BoxGeometry(6, 2.6, 2.44), std(colors[i % 5], { roughness: 0.6 }), { cast: false });
      c.position.set(-d.len / 2 + 22 + (i % 13) * 6.4, 9.3 + Math.floor(i / 13) * 2.6, ((i * 7) % 5 - 2) * 2.6);
      g.add(c);
    }
    return g;
  },

  gulls(d, ctx) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const shape = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.6, 0.15, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.6, 0.15, 0)]);
    const birds = [];
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Line(shape, new THREE.LineBasicMaterial({ color: '#f4f4f4' }));
      b.userData = { r: 14 + ctx.rng() * 18, s: 0.15 + ctx.rng() * 0.2, ph: ctx.rng() * 6, h: ctx.rng() * 8 };
      g.add(b);
      birds.push(b);
    }
    ctx.animated.push((dt, t) => {
      for (const b of birds) {
        const u = b.userData;
        const a = t * u.s + u.ph;
        b.position.set(Math.cos(a) * u.r, u.h + Math.sin(t * 0.5 + u.ph) * 1.5, Math.sin(a) * u.r);
        b.rotation.y = -a;
        b.scale.y = 1 + Math.sin(t * 8 + u.ph) * 0.6;
      }
    });
    return g;
  },

  station_sign(d) {
    const g = new THREE.Group();
    g.position.set(...d.p);
    const post = mesh(new THREE.BoxGeometry(0.12, 2.2, 0.12), std('#33415a'));
    post.position.y = 1.1;
    g.add(post);
    const mat = new THREE.MeshStandardMaterial({ map: textTexture(d.text, { color: '#ffffff', bg: '#1f6feb', sub: d.sub, subColor: '#dfeaff', font: '900 110px "Segoe UI", sans-serif' }), roughness: 0.6 });
    const panel = mesh(new THREE.BoxGeometry(3.2, 0.8, 0.06), std('#1f6feb'), { cast: true });
    panel.position.y = 2.4;
    g.add(panel);
    const front = new THREE.PlaneGeometry(3.2, 0.8).translate(0, 0, 0.031);
    const back = new THREE.PlaneGeometry(3.2, 0.8).rotateY(Math.PI).translate(0, 0, -0.031);
    const faces = mesh(mergeTwo(front, back), mat, { cast: false });
    faces.position.y = 2.4;
    g.add(faces);
    return g;
  },

  trees(d, ctx) {
    const g = new THREE.Group();
    const count = Math.round(d.count * ctx.quality.decorDensity);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.3, 2, 6), std('#6b4a2e'), count);
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1.8, 4.5, 7), std('#2f7a3d', { flatShading: true, roughness: 0.9 }), count);
    trunk.castShadow = crown.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + ctx.rng() * 0.2;
      const r = d.ring + ctx.rng() * 18;
      const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.75;
      const sc = 0.8 + ctx.rng() * 0.8;
      s.set(sc, sc, sc);
      m.compose(new THREE.Vector3(x, sc, z), q, s);
      trunk.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, sc * 4, z), q, s);
      crown.setMatrixAt(i, m);
    }
    g.add(trunk, crown);
    return g;
  },
};

/** Two indexed geometries with the same attributes as one. */
function mergeTwo(a, b) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const A = a.attributes[name].array, B = b.attributes[name].array;
    const arr = new Float32Array(A.length + B.length);
    arr.set(A);
    arr.set(B, A.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.attributes[name].itemSize));
  }
  const n = a.attributes.position.count;
  g.setIndex([...a.index.array, ...Array.from(b.index.array, (i) => i + n)]);
  return g;
}

let _pool = null;
function poolTexture() {
  if (_pool) return _pool;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  _pool = new THREE.CanvasTexture(c);
  return _pool;
}

let _puff = null;
function puffTexture() {
  if (_puff) return _puff;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  _puff = new THREE.CanvasTexture(c);
  return _puff;
}

let _waterN = null;
function waterNormalTexture() {
  if (_waterN) return _waterN;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  const img = x.createImageData(s, s);
  const k = (Math.PI * 2) / s; // integer frequencies keep the tile seamless
  const hgt = (u, v) => Math.sin(u * k * 4) * 0.5 + Math.sin(v * k * 5 + u * k * 2) * 0.5 + Math.sin((u + v) * k * 3) * 0.4;
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      const dx = hgt(i + 1, j) - hgt(i - 1, j);
      const dy = hgt(i, j + 1) - hgt(i, j - 1);
      const k = (j * s + i) * 4;
      img.data[k] = 128 + dx * 60;
      img.data[k + 1] = 128 + dy * 60;
      img.data[k + 2] = 255;
      img.data[k + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  _waterN = new THREE.CanvasTexture(c);
  _waterN.wrapS = _waterN.wrapT = THREE.RepeatWrapping;
  return _waterN;
}

export { puffTexture, waterNormalTexture };
