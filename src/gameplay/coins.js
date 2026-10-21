// Gold coins scattered around the map (most of them up high, so parkour pays off).
// Offline the session owns them; online the SERVER owns them (spawns, validated pickups,
// respawns) and this class only mirrors its messages. Coins grabbed in a match are paid out
// with the end-of-match award, so they are also server-checked online.
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { bus } from '../core/events.js';

let sharedGeo = null;
let sharedMat = null;
let glowTex = null;
const CAP = 128; // coin rain can put a lot of coins on the map at once

function assets() {
  if (!sharedGeo) {
    sharedGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.07, 28);
    sharedGeo.rotateX(Math.PI / 2);
    sharedMat = new THREE.MeshStandardMaterial({ color: '#ffcc33', metalness: 0.9, roughness: 0.25, emissive: '#ffaa00', emissiveIntensity: 0.55 });
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,220,120,0.9)');
    g.addColorStop(1, 'rgba(255,200,60,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    glowTex = new THREE.CanvasTexture(c);
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class MapCoins {
  /** @param authoritative true offline (we spawn + validate), false online (server does). */
  constructor(session, { authoritative, rng = Math.random }) {
    this.s = session;
    this.cfg = session.cfg.coins;
    this.authoritative = authoritative;
    this.rng = rng;
    this.spots = session.game.map.data.coinSpots || [];
    this.coins = new Map(); // id -> { id, pos, mesh, glow }
    this.pending = new Set(); // online: pickups we asked the server for
    this.respawns = [];
    this.seq = 0;
    this.collected = 0; // by the local player this match
    assets();
    // every coin is one instance: 2 draw calls for all of them (coin bodies + their glow)
    this.inst = new THREE.InstancedMesh(sharedGeo, sharedMat, CAP);
    this.inst.count = 0;
    this.inst.castShadow = true;
    this.inst.frustumCulled = false;
    this.inst.name = 'coins';
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAP * 3), 3));
    this.glow = new THREE.Points(gg, new THREE.PointsMaterial({ map: glowTex, size: 1.4, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.glow.frustumCulled = false;
    session.game.scene.add(this.inst, this.glow);
    if (authoritative) for (let i = 0; i < Math.min(this.cfg.mapCoins, this.spots.length); i++) this._spawnRandom();
  }

  _freeSpot() {
    const used = [...this.coins.values()].map((c) => c.pos);
    const options = this.spots.filter((s) => !used.some((u) => Math.hypot(u.x - s[0], u.z - s[2]) < 1));
    if (!options.length) return null;
    const s = options[Math.floor(this.rng() * options.length)];
    return { x: s[0], y: s[1], z: s[2] };
  }

  _spawnRandom() {
    const pos = this._freeSpot();
    if (pos) this.spawn(`c${++this.seq}`, pos);
  }

  spawn(id, pos, { drop = false, bonus = false } = {}) {
    if (this.coins.has(id) || this.coins.size >= CAP) return;
    this.coins.set(id, { id, pos: { x: pos.x, y: pos.y, z: pos.z }, phase: this.rng() * 6, drop: drop ? 1 : 0, bonus });
  }

  /** Coin Rain event (offline): bonus coins drop from the sky onto free spots. */
  rain(n) {
    for (let i = 0; i < n; i++) {
      const pos = this._freeSpot();
      if (!pos) break;
      this.spawn(`r${++this.seq}`, pos, { drop: true, bonus: true });
    }
  }

  /** Remove a coin; `by` = player id that grabbed it (for effects). */
  take(id, by) {
    const c = this.coins.get(id);
    this.pending.delete(id);
    if (!c) return;
    this.coins.delete(id);
    const fx = this.s.game.effects;
    fx.burst(c.pos, '#ffd23d', { count: 18, speed: 3.5, size: 0.18, life: 0.5, up: 2 });
    fx.ring({ x: c.pos.x, y: c.pos.y - 0.85, z: c.pos.z }, '#ffd23d', 1.4, 0.3);
    if (by === this.s.localId) {
      this.collected++;
      audio.play('coin');
      bus.emit('hud:coin', { count: this.collected, value: this.cfg.perPickup });
    } else {
      audio.play('coin', { pos: c.pos, volume: 0.4 });
    }
  }

  /** Fixed-step update (sim time). */
  step(dt) {
    if (this.authoritative) {
      for (let i = this.respawns.length - 1; i >= 0; i--) {
        this.respawns[i] -= dt;
        if (this.respawns[i] <= 0) {
          this.respawns.splice(i, 1);
          this._spawnRandom();
        }
      }
    }
    const r = this.cfg.pickupRadius;
    for (const c of [...this.coins.values()]) {
      for (const p of this.s.players.values()) {
        if (p.out || !p.connected) continue;
        if (!this.authoritative && p.id !== this.s.localId) continue; // online: server decides for others
        const dx = p.ctrl.pos.x - c.pos.x, dz = p.ctrl.pos.z - c.pos.z, dy = p.ctrl.pos.y + 0.9 - c.pos.y;
        if (dx * dx + dz * dz > r * r || Math.abs(dy) > 1.3) continue;
        if (this.authoritative) {
          if (this.s.onCoinPicked?.(p) === false) continue;
          this.take(c.id, p.id);
          if (!c.bonus) this.respawns.push(this.cfg.respawn);
        } else if (!this.pending.has(c.id)) {
          this.pending.add(c.id);
          this.s.net.send('pickup', { id: c.id });
        }
        break;
      }
    }
  }

  /** Per-frame visuals. */
  render(dt, time) {
    const g = this.glow.geometry.attributes.position;
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.drop > 0) c.drop = Math.max(0, c.drop - dt * 1.4); // falling in from the sky
      const y = c.pos.y + Math.sin(time * 2 + c.phase) * 0.12 + c.drop * c.drop * 16;
      _p.set(c.pos.x, y, c.pos.z);
      _q.setFromAxisAngle(_up, time * 2.4 + c.phase);
      this.inst.setMatrixAt(n, _m.compose(_p, _q, _s));
      g.setXYZ(n, c.pos.x, y, c.pos.z);
      n++;
    }
    this.inst.count = n;
    this.inst.instanceMatrix.needsUpdate = true;
    g.needsUpdate = true;
    this.glow.geometry.setDrawRange(0, n);
  }

  /** Coin positions for bots that like shiny things. */
  positions() {
    return [...this.coins.values()].map((c) => c.pos);
  }

  dispose() {
    this.coins.clear();
    this.s.game.scene.remove(this.inst, this.glow);
    this.inst.dispose();
    this.glow.geometry.dispose();
    this.glow.material.dispose();
  }
}
