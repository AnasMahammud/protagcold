// A participant in a match: local human, bot, or remote (network) player.
// Local and bot players own a CharacterController stepped at the fixed sim rate; remote
// players are rendered from an interpolation buffer of server snapshots.
import { CharacterController, MS } from '../movement/controller.js';
import { CharacterModel } from './characterModel.js';
import { sanitizeCosmetics } from '../progression/cosmetics.js';
import { lerp, wrapAngle } from '../core/mathUtil.js';

export class Player {
  constructor({ id, name, kind, cosmetics, world, moveCfg, scene }) {
    this.id = id;
    this.name = name;
    this.kind = kind; // 'local' | 'bot' | 'remote'
    this.cosmetics = sanitizeCosmetics(cosmetics);
    this.world = world;
    this.scene = scene;
    this.ctrl = new CharacterController(world, moveCfg);
    this.prev = { x: 0, y: 0, z: 0, yaw: 0 };
    this.model = new CharacterModel(this.cosmetics);
    this.model.setName(name, kind === 'local' ? '#ffd23d' : '#ffffff');
    scene.add(this.model.root);
    this.brain = null;
    this.it = false;
    this.out = false;
    this.frozen = false;
    this.protected = false;
    this.connected = true;
    this.lastEmote = 0;
    // remote interpolation
    this.buffer = [];
    this.remoteState = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, state: MS.GROUND, grounded: true, sprinting: false, scriptProgress: 0 };
    this._groundCacheT = 0;
    this.groundY = 0;
    this.renderPos = { x: 0, y: 0, z: 0 };
  }

  spawn(x, y, z, yaw) {
    this.ctrl.teleport(x, y, z, yaw);
    this.prev.x = x; this.prev.y = y; this.prev.z = z; this.prev.yaw = yaw;
    this.buffer.length = 0;
    Object.assign(this.remoteState, { x, y, z, yaw, vx: 0, vy: 0, vz: 0 });
  }

  /** Save the pre-step state (for render interpolation). */
  beginStep() {
    const p = this.ctrl.pos;
    this.prev.x = p.x; this.prev.y = p.y; this.prev.z = p.z; this.prev.yaw = this.ctrl.yaw;
  }

  // ------------------------------------------------------------------ remote
  pushSnapshot(t, s) {
    this.buffer.push({ t, ...s });
    if (this.buffer.length > 40) this.buffer.shift();
  }

  /** Sample the interpolation buffer at render time `t` (seconds, server clock). */
  sampleRemote(t) {
    const b = this.buffer;
    const r = this.remoteState;
    if (!b.length) return r;
    if (t <= b[0].t) {
      Object.assign(r, b[0]);
    } else if (t >= b[b.length - 1].t) {
      // brief extrapolation (max 150ms) to hide packet jitter, then hold
      const last = b[b.length - 1];
      const ex = Math.min(0.15, t - last.t);
      Object.assign(r, last);
      r.x = last.x + last.vx * ex;
      r.z = last.z + last.vz * ex;
      r.y = last.y + Math.max(-2, last.vy) * ex;
    } else {
      let i = b.length - 2;
      while (i > 0 && b[i].t > t) i--;
      const a = b[i], c = b[i + 1];
      const k = (t - a.t) / Math.max(1e-6, c.t - a.t);
      r.x = lerp(a.x, c.x, k);
      r.y = lerp(a.y, c.y, k);
      r.z = lerp(a.z, c.z, k);
      r.vx = lerp(a.vx, c.vx, k);
      r.vy = lerp(a.vy, c.vy, k);
      r.vz = lerp(a.vz, c.vz, k);
      r.yaw = a.yaw + wrapAngle(c.yaw - a.yaw) * k;
      r.state = k < 0.5 ? a.state : c.state;
      r.grounded = k < 0.5 ? a.grounded : c.grounded;
      r.sprinting = c.sprinting;
      r.scriptProgress = lerp(a.scriptProgress || 0, c.scriptProgress || 0, k);
    }
    // mirror into ctrl so camera/spectator/AI code can treat all players alike
    const p = this.ctrl.pos;
    p.x = r.x; p.y = r.y; p.z = r.z;
    this.ctrl.vel.x = r.vx; this.ctrl.vel.y = r.vy; this.ctrl.vel.z = r.vz;
    this.ctrl.yaw = r.yaw;
    this.ctrl.state = r.state;
    this.ctrl.grounded = r.grounded;
    this.ctrl.sprinting = r.sprinting;
    return r;
  }

  // ------------------------------------------------------------------ render
  /** Update the visual model. alpha = fixed-step interpolation factor for local/bot players. */
  render(dt, time, alpha) {
    let s;
    if (this.kind === 'remote') {
      s = { ...this.remoteState };
    } else {
      const c = this.ctrl;
      s = {
        x: lerp(this.prev.x, c.pos.x, alpha),
        y: lerp(this.prev.y, c.pos.y, alpha),
        z: lerp(this.prev.z, c.pos.z, alpha),
        yaw: this.prev.yaw + wrapAngle(c.yaw - this.prev.yaw) * alpha,
        vx: c.vel.x, vy: c.vel.y, vz: c.vel.z,
        state: c.state,
        grounded: c.grounded,
        sprinting: c.sprinting,
        scriptProgress: c.scriptProgress,
      };
    }
    // ground height for the blob shadow (cheap, refreshed at ~20 Hz)
    this._groundCacheT -= dt;
    if (this._groundCacheT <= 0) {
      this._groundCacheT = 0.05;
      const g = this.world.groundBelow(s.x, s.z, 0.2, s.y + 0.1);
      this.groundY = g ? g.y : s.y - 50;
    }
    s.groundY = this.groundY;
    s.frozen = this.frozen;
    this.renderPos.x = s.x; this.renderPos.y = s.y; this.renderPos.z = s.z;
    this.model.update(s, dt, time);
    return s;
  }

  dispose() {
    this.scene.remove(this.model.root);
    this.model.dispose();
  }
}
