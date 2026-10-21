// Visual + audio feedback for abilities. Gameplay lives in src/gameplay/abilities.js.
import * as THREE from 'three';
import { audio } from '../audio/audio.js';

const anims = []; // short-lived meshes animated by update()

export function update(dt) {
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i];
    a.t += dt;
    const k = a.t / a.life;
    if (k >= 1) {
      a.parent.remove(a.obj);
      a.obj.geometry?.dispose();
      a.obj.material?.dispose();
      anims.splice(i, 1);
      continue;
    }
    a.tick(k, a.obj);
  }
}

function addAnim(parent, obj, life, tick) {
  parent.add(obj);
  anims.push({ parent, obj, life, t: 0, tick });
}

function glowMat(color, opacity = 0.8) {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  m.toneMapped = false;
  return m;
}

// ------------------------------------------------------------------ blink
export function blinkFx(session, p, from, to, isLocal) {
  const fx = session.game.effects;
  const scene = session.game.scene;
  session.game.perfectFx?.spawnGhost(p, '#3df5ff', 0.45, from);
  fx.burst({ x: from.x, y: from.y + 1, z: from.z }, '#3df5ff', { count: 22, speed: 4, size: 0.2, life: 0.4, up: 0.5, grav: 0, spread: 0.6 });
  // a lightning streak along the teleport path
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    fx.burst({ x: from.x + (to.x - from.x) * t, y: from.y + 1 + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t }, i % 2 ? '#ffffff' : '#3df5ff', { count: 2, speed: 0.6, size: 0.24, life: 0.35, up: 0, grav: 0 });
  }
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const j = i === 0 || i === 10 ? 0 : 0.25;
    pts.push(new THREE.Vector3(from.x + (to.x - from.x) * t + (Math.random() - 0.5) * j, from.y + 1 + (to.y - from.y) * t + (Math.random() - 0.5) * j, from.z + (to.z - from.z) * t + (Math.random() - 0.5) * j));
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#bffcff', transparent: true }));
  line.material.toneMapped = false;
  addAnim(scene, line, 0.25, (k, o) => (o.material.opacity = 1 - k));
  fx.ring(to, '#3df5ff', 2.4, 0.35);
  fx.burst({ x: to.x, y: to.y + 1, z: to.z }, '#ffffff', { count: 16, speed: 3, size: 0.18, life: 0.3, up: 0.5 });
  audio.play('blink', { pos: to });
  if (isLocal) session.game.perfectFx?.pulse({ chroma: 0.9, zoom: 0.35, ms: 220 });
}

// ------------------------------------------------------------------ rocket jump
export function rocketFx(session, p, isLocal) {
  const fx = session.game.effects;
  const pos = p.renderPos;
  fx.burst({ x: pos.x, y: pos.y + 0.2, z: pos.z }, '#ff7a2f', { count: 34, speed: 6, size: 0.3, life: 0.5, up: -2, grav: 2, spread: 0.4 });
  fx.burst({ x: pos.x, y: pos.y + 0.2, z: pos.z }, '#ffd23d', { count: 18, speed: 4, size: 0.24, life: 0.35, up: -1 });
  fx.burst({ x: pos.x, y: pos.y + 0.1, z: pos.z }, '#8a8f99', { count: 14, speed: 2.5, size: 0.6, life: 1.0, up: 0.4, grav: -0.5, spread: 0.2 });
  fx.ring(pos, '#ff7a2f', 2.8, 0.4);
  audio.play('rocket', { pos });
  if (isLocal) {
    session.game.cameraRig.shake(0.25);
    session.game.perfectFx?.pulse({ zoom: 0.4, ms: 200 });
  }
  p.rocketTrail = 0.6; // flame trail for a moment (rendered in tickTrails)
}

/** Ongoing per-player effects: rocket flame trail. */
export function tickTrails(session, dt) {
  for (const p of session.players.values()) {
    if (!(p.rocketTrail > 0)) continue;
    p.rocketTrail -= dt;
    if (Math.random() < 0.8) session.game.effects.burst({ x: p.renderPos.x, y: p.renderPos.y + 0.3, z: p.renderPos.z }, Math.random() < 0.5 ? '#ff7a2f' : '#ffd23d', { count: 2, speed: 1, size: 0.3, life: 0.35, up: -1, grav: 1 });
  }
}

// ------------------------------------------------------------------ grapple
export function createRope(session, p, anchor) {
  const scene = session.game.scene;
  const geo = new THREE.BufferGeometry();
  const arr = new Float32Array(6);
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#7dff6b' }));
  line.material.toneMapped = false;
  line.frustumCulled = false;
  const hook = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), glowMat('#7dff6b', 1));
  hook.position.set(anchor.x, anchor.y, anchor.z);
  scene.add(line, hook);
  session.game.effects.burst(anchor, '#7dff6b', { count: 16, speed: 3, size: 0.18, life: 0.35, up: 0.5 });
  session.game.effects.ring({ x: anchor.x, y: anchor.y - 0.08, z: anchor.z }, '#7dff6b', 1.2, 0.3);
  return {
    age: 0,
    update(pl, dt) {
      this.age += dt;
      const h = pl.renderPos;
      // the rope shoots out over the first 0.08 s, then stays taut
      const k = Math.min(1, this.age / 0.08);
      arr[0] = h.x; arr[1] = h.y + 1.35; arr[2] = h.z;
      arr[3] = h.x + (anchor.x - h.x) * k; arr[4] = h.y + 1.35 + (anchor.y - h.y - 1.35) * k; arr[5] = h.z + (anchor.z - h.z) * k;
      geo.attributes.position.needsUpdate = true;
      hook.rotation.y += dt * 8;
    },
    dispose() {
      scene.remove(line, hook);
      geo.dispose();
      line.material.dispose();
      hook.geometry.dispose();
      hook.material.dispose();
    },
  };
}

// ------------------------------------------------------------------ cloak
export function cloakFx(session, p) {
  const pos = p.renderPos;
  session.game.effects.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, '#b48cff', { count: 30, speed: 2.5, size: 0.22, life: 0.6, up: 0.6, grav: -0.5, spread: 0.8 });
  session.game.effects.ring(pos, '#b48cff', 2, 0.35);
  audio.play('cloak', { pos });
}

/** Every frame: shimmering near-invisibility while cloaked (you still see yourself faintly). */
export function cloakVisual(p, cloaked, isLocal, time) {
  if (!cloaked) {
    if (p.cloakShown) {
      p.cloakShown = false;
      p.model.setCloak(null);
    }
    return;
  }
  p.cloakShown = true;
  p.model.setCloak(isLocal ? 0.3 : 0.05 + 0.04 * Math.sin(time * 23 + p.renderPos.x));
}

// ------------------------------------------------------------------ decoy
export function makeHologram(model) {
  model.setCloak(0.8);
  model.root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m.emissive) continue;
      m.emissive.set('#3df5ff');
      m.emissiveIntensity = 0.25;
    }
  });
  model.blob.visible = true;
}

export function hologramFlicker(model, time) {
  // subtle flicker that an observant player can spot
  const f = Math.sin(time * 31) > 0.93 ? 0.35 : 0.8;
  model.setCloak(f);
}

export function decoyFx(session, owner, pos) {
  session.game.effects.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, '#ffd23d', { count: 18, speed: 2.5, size: 0.2, life: 0.5, up: 0.8 });
  audio.play('decoy', { pos });
}

export function decoyPopFx(session, pos) {
  session.game.effects.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, '#ffd23d', { count: 30, speed: 4, size: 0.22, life: 0.6, up: 1.5 });
  session.game.effects.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, '#3df5ff', { count: 16, speed: 3, size: 0.18, life: 0.5, up: 1 });
  audio.play('decoyPop', { pos });
}

// ------------------------------------------------------------------ shockwave
export function shockwaveFx(session, p, radius) {
  const scene = session.game.scene;
  const pos = { x: p.renderPos.x, y: p.renderPos.y, z: p.renderPos.z };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), glowMat('#ff3df0', 0.55));
  dome.position.set(pos.x, pos.y, pos.z);
  addAnim(scene, dome, 0.45, (k, o) => {
    const s = 0.3 + (radius - 0.3) * (1 - (1 - k) * (1 - k));
    o.scale.set(s, s * 0.8, s);
    o.material.opacity = 0.55 * (1 - k);
  });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), glowMat('#ffffff', 0.25));
  shell.position.set(pos.x, pos.y + 1, pos.z);
  addAnim(scene, shell, 0.25, (k, o) => {
    const s = 0.5 + radius * 0.6 * k;
    o.scale.setScalar(s);
    o.material.opacity = 0.25 * (1 - k);
  });
  session.game.effects.ring(pos, '#ff3df0', radius, 0.45);
  session.game.effects.ring(pos, '#ffffff', radius * 0.6, 0.3);
  session.game.effects.burst({ x: pos.x, y: pos.y + 0.3, z: pos.z }, '#ff3df0', { count: 40, speed: 9, size: 0.22, life: 0.45, up: 0.8, spread: 0.3, grav: 3 });
  audio.play('shockwave', { pos });
  const me = session.local;
  if (me && Math.hypot(me.renderPos.x - pos.x, me.renderPos.z - pos.z) < radius + 2) {
    session.game.cameraRig.shake(0.45);
    session.game.perfectFx?.pulse({ chroma: 0.8, zoom: 0.5, ms: 260 });
  }
}

const keepAlive = []; // warm-up materials, never disposed (see prewarmObjects)

/**
 * One throwaway object per material TYPE the ability effects use, so Game.prewarmEffects can
 * compile their shaders while the match loads. three.js shares a compiled program between all
 * materials with the same settings and deletes it when the last one is disposed, so the warm-up
 * MATERIALS are kept alive forever (only the geometry is thrown away): every later blink streak,
 * grapple rope or shockwave dome reuses the program instead of stalling a frame to compile it.
 */
export function prewarmObjects() {
  if (!keepAlive.length) {
    const lineFade = new THREE.LineBasicMaterial({ color: '#bffcff', transparent: true });
    const line = new THREE.LineBasicMaterial({ color: '#7dff6b' });
    lineFade.toneMapped = line.toneMapped = false;
    keepAlive.push(glowMat('#ff3df0', 0.5), lineFade, line);
  }
  const g = new THREE.Group();
  const seg = () => new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0.01, 0)]);
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), keepAlive[0]));
  g.add(new THREE.Line(seg(), keepAlive[1]));
  g.add(new THREE.Line(seg(), keepAlive[2]));
  return g;
}

export function disposeObjects(g) {
  g.traverse((o) => o.geometry?.dispose()); // materials stay alive on purpose
}

export function clear() {
  for (const a of anims) {
    a.parent.remove(a.obj);
    a.obj.geometry?.dispose();
    a.obj.material?.dispose();
  }
  anims.length = 0;
}
