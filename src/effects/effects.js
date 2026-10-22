// Gameplay effects: a pooled GPU particle system, shockwave rings, lightning arcs and
// ribbon trails. Everything is pooled (no allocation during play) and scaled by the
// graphics preset's particle budget. Effects are brief and readable, never obscuring play.
import * as THREE from 'three';
import { settings } from '../core/settings.js';

const PARTICLE_VS = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const PARTICLE_FS = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.15, d) * vAlpha;
  gl_FragColor = vec4(vColor, a);
}`;

class ParticlePool {
  constructor(scene, capacity) {
    this.n = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    g.setAttribute('aColor', this.aColor);
    this.mat = new THREE.ShaderMaterial({ vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, transparent: true, depthWrite: false });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.active = 0;
  }

  spawn(x, y, z, vx, vy, vz, color, size, life, grav = 9, drag = 1.5) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.col[k] = color.r; this.col[k + 1] = color.g; this.col[k + 2] = color.b;
    this.size[i] = this.size0[i] = size;
    this.alpha[i] = 1;
    this.life[i] = this.maxLife[i] = life;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.active = Math.max(this.active, 1);
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const k = i * 3;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= d; this.vel[k + 1] = this.vel[k + 1] * d - this.grav[i] * dt; this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 2.5);
      this.size[i] = this.size0[i] * (0.4 + 0.6 * t);
    }
    if (any || this.active) {
      this.aPos.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = this.aColor.needsUpdate = true;
      this.active = any ? 1 : 0;
    }
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.active = 1;
  }

  dispose(scene) {
    scene.remove(this.points);
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

class Trail {
  constructor(scene, style, color) {
    this.segs = 22;
    this.points = [];
    this.style = style;
    this.color = new THREE.Color(color);
    const g = new THREE.BufferGeometry();
    this.posArr = new Float32Array(this.segs * 2 * 3);
    this.colArr = new Float32Array(this.segs * 2 * 4);
    this.aPos = new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.colArr, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('color', this.aCol);
    const idx = [];
    for (let i = 0; i < this.segs - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    this.mesh.frustumCulled = false;
    this.mesh.material.toneMapped = false;
    scene.add(this.mesh);
    this.tmp = new THREE.Color();
  }

  update(pos, speed, dt, time) {
    const active = speed > 8.2;
    const p = { x: pos.x, y: pos.y + 0.95, z: pos.z, w: active ? 1 : 0 };
    this.points.unshift(p);
    if (this.points.length > this.segs) this.points.length = this.segs;
    for (let i = 0; i < this.segs; i++) {
      const q = this.points[Math.min(i, this.points.length - 1)] || p;
      const t = i / (this.segs - 1);
      const w = 0.16 * (1 - t) * q.w;
      const k = i * 6;
      this.posArr[k] = q.x; this.posArr[k + 1] = q.y + w; this.posArr[k + 2] = q.z;
      this.posArr[k + 3] = q.x; this.posArr[k + 4] = q.y - w; this.posArr[k + 5] = q.z;
      let c = this.color;
      if (this.style === 'rainbow') c = this.tmp.setHSL((time * 0.5 + t) % 1, 1, 0.55);
      else if (this.style === 'ember') c = this.tmp.setRGB(1, 0.35 + 0.3 * (1 - t), 0.1);
      else if (this.style === 'glitch') c = this.tmp.set((i + Math.floor(time * 20)) % 4 < 2 ? '#7dff6b' : '#ff3df0');
      else if (this.style === 'gold') c = this.tmp.setRGB(1, 0.78 + 0.22 * t, 0.2 + 0.8 * t);
      const a = (1 - t) * 0.7 * q.w;
      const ck = i * 8;
      for (const o of [0, 4]) {
        this.colArr[ck + o] = c.r; this.colArr[ck + o + 1] = c.g; this.colArr[ck + o + 2] = c.b; this.colArr[ck + o + 3] = a;
      }
    }
    this.aPos.needsUpdate = this.aCol.needsUpdate = true;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class Effects {
  constructor(scene, quality) {
    this.scene = scene;
    this.budget = quality.particles;
    this.pool = new ParticlePool(scene, Math.round(2400 * Math.max(0.4, quality.particles)));
    this.rings = [];
    this.bolts = [];
    this.trails = new Map();
    this.c = new THREE.Color();
    const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.MeshBasicMaterial({ color: '#fff', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
      m.toneMapped = false;
      const r = new THREE.Mesh(ringGeo, m);
      r.rotation.x = -Math.PI / 2;
      r.visible = false;
      r.userData = { t: 0, dur: 0.5, max: 4 };
      scene.add(r);
      this.rings.push(r);
    }
    this.flashEl = document.getElementById('screen-flash');
  }

  _n(base) {
    return Math.max(1, Math.round(base * this.budget));
  }

  burst(pos, color, { count = 30, speed = 6, size = 0.25, life = 0.6, up = 2, grav = 9, spread = 1 } = {}) {
    const c = this.c.set(color);
    const n = this._n(count);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.3) * spread;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.pool.spawn(pos.x, pos.y, pos.z, Math.cos(a) * s, up + e * s, Math.sin(a) * s, c, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), grav);
    }
  }

  ring(pos, color, max = 4, dur = 0.45) {
    const r = this.rings.find((x) => !x.visible) || this.rings[0];
    r.position.set(pos.x, pos.y + 0.08, pos.z);
    r.material.color.set(color);
    r.userData = { t: 0, dur, max };
    r.visible = true;
  }

  lightning(a, b, color) {
    const pts = [];
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const j = i === 0 || i === n ? 0 : 0.35;
      pts.push(new THREE.Vector3(a.x + (b.x - a.x) * t + (Math.random() - 0.5) * j, a.y + (b.y - a.y) * t + (Math.random() - 0.5) * j, a.z + (b.z - a.z) * t + (Math.random() - 0.5) * j));
    }
    const m = new THREE.LineBasicMaterial({ color, transparent: true });
    m.toneMapped = false;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m);
    line.userData.t = 0.25;
    this.scene.add(line);
    this.bolts.push(line);
  }

  /** Tag confirmation. style = tagger's chosen tag effect. */
  tag(pos, style, color) {
    const p = { x: pos.x, y: pos.y + 1.1, z: pos.z };
    this.burst(p, color, { count: 26, speed: 7, size: 0.22, life: 0.5, up: 1.5 });
    this.burst(p, '#ffffff', { count: 10, speed: 4, size: 0.3, life: 0.3, up: 1 });
    this.ring(pos, color, 3.2, 0.4);
    if (style === 'shockwave') {
      this.ring(pos, '#ffffff', 5.5, 0.6);
      this.burst({ x: pos.x, y: pos.y + 0.2, z: pos.z }, color, { count: 30, speed: 10, size: 0.18, life: 0.4, up: 0.3, spread: 0.2, grav: 2 });
    } else if (style === 'confetti') {
      for (const col of ['#ff3df0', '#3df5ff', '#ffd23d', '#7dff6b']) this.burst(p, col, { count: 10, speed: 5, size: 0.2, life: 1.2, up: 5, grav: 7 });
    } else if (style === 'glitch') {
      this.ring(pos, '#7dff6b', 4.2, 0.35);
      this.ring(pos, '#ff3df0', 2.6, 0.25);
      this.burst(p, '#7dff6b', { count: 20, speed: 6, size: 0.16, life: 0.4, up: 0.5, grav: 0, spread: 0.5 });
      this.burst(p, '#ff3df0', { count: 14, speed: 5, size: 0.14, life: 0.35, up: 0.5, grav: 0, spread: 0.5 });
    } else if (style === 'fireworks') {
      const cols = ['#ff3df0', '#3df5ff', '#ffd23d', '#7dff6b', '#ff7a2f'];
      for (let i = 0; i < 4; i++) {
        setTimeout(() => {
          const c = cols[(i + Math.floor(Math.random() * 5)) % 5];
          const q = { x: pos.x + (Math.random() - 0.5) * 2, y: pos.y + 2.6 + Math.random() * 1.6, z: pos.z + (Math.random() - 0.5) * 2 };
          this.burst(q, c, { count: 26, speed: 6, size: 0.18, life: 0.9, up: 0.5, grav: 4 });
        }, i * 140);
      }
    } else if (style === 'lightning') {
      for (let i = 0; i < 3; i++) this.lightning({ x: pos.x, y: pos.y + 6, z: pos.z }, { x: pos.x + (Math.random() - 0.5), y: pos.y + 0.8, z: pos.z + (Math.random() - 0.5) }, '#bfe8ff');
    }
  }

  becomeIt(pos, color) {
    this.ring(pos, color, 2.2, 0.5);
    this.burst({ x: pos.x, y: pos.y + 0.3, z: pos.z }, color, { count: 24, speed: 3, size: 0.25, life: 0.9, up: 4, grav: -1, spread: 0.3 });
  }

  eliminated(pos) {
    this.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, '#9aa6b8', { count: 40, speed: 4, size: 0.3, life: 1.2, up: 3, grav: -2 });
    this.ring(pos, '#9aa6b8', 3, 0.6);
  }

  dust(pos, intensity = 1, color = '#c9c2b5') {
    this.burst({ x: pos.x, y: pos.y + 0.05, z: pos.z }, color, { count: 10 * intensity, speed: 2.5 * intensity, size: 0.35, life: 0.45, up: 0.6, grav: 1, spread: 0.3 });
  }

  pad(pos, color) {
    this.burst({ x: pos.x, y: pos.y + 0.2, z: pos.z }, color, { count: 30, speed: 3, size: 0.25, life: 0.6, up: 8, grav: 8, spread: 0.2 });
    this.ring(pos, color, 2, 0.35);
  }

  confetti(pos) {
    for (const col of ['#ff3df0', '#3df5ff', '#ffd23d', '#7dff6b', '#ff5a3d']) {
      this.burst({ x: pos.x, y: pos.y + 2.5, z: pos.z }, col, { count: 24, speed: 6, size: 0.22, life: 2.4, up: 7, grav: 6, spread: 0.8 });
    }
  }

  sparks(pos, color) {
    this.burst({ x: pos.x, y: pos.y + 0.9, z: pos.z }, color, { count: 2, speed: 1, size: 0.14, life: 0.35, up: 0.4, grav: 2 });
  }

  flash(color = 'rgba(255,255,255,0.35)', ms = 140) {
    if (!this.flashEl || settings.data.accessibility.reduceFlashing) return;
    this.flashEl.style.background = color;
    this.flashEl.style.opacity = '1';
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => {
      this.flashEl.style.opacity = '0';
    }, ms);
  }

  setTrail(id, style, color) {
    const existing = this.trails.get(id);
    if (existing && existing.style === style && existing.color.getHexString() === new THREE.Color(color).getHexString()) return;
    if (existing) existing.dispose(this.scene);
    this.trails.delete(id);
    if (style && style !== 'none' && style !== 'sparks') this.trails.set(id, new Trail(this.scene, style, color));
  }

  updateTrail(id, pos, speed, dt, time) {
    const t = this.trails.get(id);
    if (t) t.update(pos, speed, dt, time);
  }

  removeTrail(id) {
    const t = this.trails.get(id);
    if (t) t.dispose(this.scene);
    this.trails.delete(id);
  }

  update(dt) {
    this.pool.update(dt);
    for (const r of this.rings) {
      if (!r.visible) continue;
      const u = r.userData;
      u.t += dt;
      const k = u.t / u.dur;
      if (k >= 1) {
        r.visible = false;
        continue;
      }
      const s = 0.3 + (u.max - 0.3) * (1 - (1 - k) * (1 - k));
      r.scale.set(s, s, s);
      r.material.opacity = 0.9 * (1 - k);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.userData.t -= dt;
      b.material.opacity = Math.max(0, b.userData.t * 4);
      if (b.userData.t <= 0) {
        this.scene.remove(b);
        b.geometry.dispose();
        b.material.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  clear() {
    this.pool.clear();
    for (const r of this.rings) r.visible = false;
    for (const id of [...this.trails.keys()]) this.removeTrail(id);
  }

  dispose() {
    this.clear();
    this.pool.dispose(this.scene);
    for (const r of this.rings) {
      this.scene.remove(r);
      r.material.dispose();
    }
  }
}
