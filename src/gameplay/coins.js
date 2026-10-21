// Gold coins scattered around the map (most of them up high, so parkour pays off).
// Offline the session owns them; online the SERVER owns them (spawns, validated pickups,
// respawns) and this class only mirrors its messages. Coins grabbed in a match are paid out
// with the end-of-match award, so they are also server-checked online.
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { bus } from '../core/events.js';

let sharedGeo = null;
let sharedMat = null;
let glowMat = null;

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
    glowMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  }
}

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

  spawn(id, pos) {
    if (this.coins.has(id)) return;
    const mesh = new THREE.Mesh(sharedGeo, sharedMat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.castShadow = true;
    const glow = new THREE.Sprite(glowMat);
    glow.scale.set(1.4, 1.4, 1);
    mesh.add(glow);
    this.s.game.scene.add(mesh);
    this.coins.set(id, { id, pos: { x: pos.x, y: pos.y, z: pos.z }, mesh, phase: this.rng() * 6 });
  }

  /** Remove a coin; `by` = player id that grabbed it (for effects). */
  take(id, by) {
    const c = this.coins.get(id);
    this.pending.delete(id);
    if (!c) return;
    this.coins.delete(id);
    this.s.game.scene.remove(c.mesh);
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
          this.respawns.push(this.cfg.respawn);
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
    for (const c of this.coins.values()) {
      c.mesh.rotation.y = time * 2.4 + c.phase;
      c.mesh.position.y = c.pos.y + Math.sin(time * 2 + c.phase) * 0.12;
    }
  }

  /** Coin positions for bots that like shiny things. */
  positions() {
    return [...this.coins.values()].map((c) => c.pos);
  }

  dispose() {
    for (const c of this.coins.values()) this.s.game.scene.remove(c.mesh);
    this.coins.clear();
  }
}
