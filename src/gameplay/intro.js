// Pre-match cutscene: a slow cinematic orbit over the arena with its name, the mode and who is
// playing on a letterboxed title card, then a swoop down behind your character just before the
// countdown. Bots strike a pose or bust an emote while the camera goes round. Skippable.
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { settings, describeCode } from '../core/settings.js';
import { formatTime } from '../core/mathUtil.js';

const SWOOP = 1.2; // seconds of the final move down to the player
const BOT_EMOTES = ['griddy', 'buggin', 'wave', 'flex', 'dance', 'robot'];

export class MatchIntro {
  /** opts: { duration, onDone } */
  constructor(session, { duration = 6.5, onDone = null } = {}) {
    this.s = session;
    this.game = session.game;
    this.duration = duration;
    this.onDone = onDone;
    this.t = 0;
    this.done = false;
    this._pO = new THREE.Vector3();
    this._qO = new THREE.Quaternion();
    this._pF = new THREE.Vector3();
    this._qF = new THREE.Quaternion();
    this._planOrbit();
    this._planEmotes();
    this._buildCard();
    this._onKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      this.skip();
    };
    this._onPointer = () => this.skip();
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('pointerdown', this._onPointer);
    audio.play('introRise');
  }

  /** Frame the arena: find an orbit height and radius with a clear view all the way round. */
  _planOrbit() {
    const data = this.game.map.data;
    const w = this.game.map.world;
    const [x0, z0, x1, z1] = data.bounds;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const half = Math.max(x1 - x0, z1 - z0) / 2;
    let top = 0;
    for (const s of data.solids) if (s.m !== 'invisible' && s.b[0] > x0 - 1 && s.b[3] < x1 + 1) top = Math.max(top, s.b[4]);
    const ceiling = Math.min(Infinity, ...(data.decor || []).filter((d) => d.t === 'ceiling').map((d) => d.y));
    const indoor = Number.isFinite(ceiling);
    const pivotY = indoor ? 3 : Math.min(6, top * 0.3);
    const heights = indoor ? [ceiling - 2.5, ceiling - 4, ceiling - 6, ceiling - 8] : [Math.max(half * 0.45, top + 6)];
    const radii = indoor ? [0.62, 0.5, 0.38] : [0.9, 0.75];
    let best = null;
    for (const h of heights) {
      for (const rf of radii) {
        const r = half * rf;
        let score = 0;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
          if (!w.isFree(px, h - 0.4, pz, 0.5, 0.8)) continue;
          const dx = px - cx, dy = h - pivotY, dz = pz - cz;
          const len = Math.hypot(dx, dy, dz);
          const hit = w.raycast(cx, pivotY, cz, dx / len, dy / len, dz / len, len, true);
          score += hit ? 0.3 : 1;
        }
        score += rf * 2; // prefer the wider, more cinematic framings
        if (!best || score > best.score) best = { h, r, score };
      }
    }
    // start opposite your spawn, so the spin ends on your side of the arena
    const me = this.s.local;
    const a0 = me ? Math.atan2(me.ctrl.pos.z - cz, me.ctrl.pos.x - cx) + Math.PI * 0.85 : 0;
    this.orbit = { cx, cz, h: best.h, r: best.r, pivotY, a0, indoor };
  }

  _planEmotes() {
    const rng = Math.random;
    this.emotes = [];
    for (const p of this.s.players.values()) {
      if (p.kind !== 'bot' || rng() < 0.4) continue;
      this.emotes.push({ p, at: 0.4 + rng() * (this.duration - SWOOP - 2.5), id: BOT_EMOTES[Math.floor(rng() * BOT_EMOTES.length)] });
    }
  }

  _buildCard() {
    const s = this.s;
    const data = this.game.map.data;
    const mc = this.game.cfg.modes[s.mode] || {};
    const players = [...s.players.values()].filter((p) => p.connected);
    const clock = mc.duration > 0 ? formatTime(mc.duration) : 'No clock';
    const key = describeCode(settings.data.controls.bindings.jump?.[0]) || 'Space';
    const el = document.createElement('div');
    el.className = 'intro';
    el.innerHTML = `
      <div class="intro-bar top"></div><div class="intro-bar bottom"></div>
      <div class="intro-card">
        <div class="intro-mode"><span>${esc(mc.name || s.mode)}</span><span>${esc(clock)}</span><span>${players.length} players</span></div>
        <div class="intro-map">${esc(data.name || this.game.map.id)}</div>
        <div class="intro-desc">${esc(data.description || '')}</div>
        <div class="intro-players">${players.slice(0, 10).map((p) => `<span class="${p.id === s.localId ? 'me' : ''}" style="--c:${esc(p.cosmetics.primary)}">${esc(p.name)}</span>`).join('')}</div>
        <div class="intro-obj">${esc(s.objectiveText())}</div>
      </div>
      <div class="intro-skip">Press <span class="kbd">${esc(key)}</span> or click to skip</div>`;
    document.body.appendChild(el);
    this.el = el;
  }

  skip() {
    if (this.done) return;
    // jump straight to the swoop (or finish it if we're already swooping)
    if (this.t < this.duration - SWOOP) this.t = this.duration - SWOOP;
    else this.t = this.duration;
  }

  /** Drives the camera; returns true while the intro is still running. */
  update(dt, time) {
    if (this.done) return false;
    this.t += dt;
    const o = this.orbit;
    const cam = this.game.camera;
    for (const e of this.emotes) {
      if (!e.fired && this.t >= e.at) {
        e.fired = true;
        e.p.model.playEmote(e.id);
      }
    }
    // slow spin with a gentle descent
    const k = Math.min(1, this.t / this.duration);
    const a = o.a0 + this.t * 0.13;
    const r = o.r * (1.05 - 0.15 * k);
    const h = o.h * (1.12 - 0.22 * k);
    const pivot = new THREE.Vector3(o.cx, o.pivotY, o.cz);
    const pos = this._pO.set(o.cx + Math.cos(a) * r, h, o.cz + Math.sin(a) * r);
    // never film through a wall or floor
    const d = pos.clone().sub(pivot);
    const len = d.length();
    d.divideScalar(len);
    const hit = this.game.map.world.raycast(pivot.x, pivot.y, pivot.z, d.x, d.y, d.z, len, true);
    if (hit) pos.copy(pivot).addScaledVector(d, Math.max(2, hit.t - 0.6));
    cam.position.copy(pos);
    cam.lookAt(o.cx, o.pivotY + (o.indoor ? 0 : 1), o.cz);
    this._qO.copy(cam.quaternion);
    const fovO = 50;
    const sw = (this.t - (this.duration - SWOOP)) / SWOOP;
    const local = this.s.local;
    if (sw > 0 && local) {
      if (!this.swooping) {
        this.swooping = true;
        this.el.classList.add('out');
        audio.play('introWhoosh');
        this.game.cameraRig.snapBehind(local.ctrl.yaw);
      }
      // the gameplay camera's pose this frame, then blend into it
      this.game.cameraRig.updateFollow(dt, local.ctrl, time);
      this._pF.copy(cam.position);
      this._qF.copy(cam.quaternion);
      const fovF = cam.fov;
      const e = smoother(Math.min(1, sw));
      cam.position.lerpVectors(this._pO, this._pF, e);
      cam.quaternion.slerpQuaternions(this._qO, this._qF, e);
      cam.fov = fovO + (fovF - fovO) * e;
    } else {
      cam.fov = fovO;
    }
    cam.updateProjectionMatrix();
    if (this.t >= this.duration) this.finish();
    return !this.done;
  }

  finish() {
    if (this.done) return;
    this.done = true;
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('pointerdown', this._onPointer);
    const el = this.el;
    el.classList.add('out', 'gone');
    setTimeout(() => el.remove(), 450);
    for (const e of this.emotes) if (e.fired) e.p.model.emote = null;
    this.onDone?.();
  }

  dispose() {
    if (!this.done) {
      this.onDone = null;
      this.finish();
    }
    this.el?.remove();
  }
}

const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
