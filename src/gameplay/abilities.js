// Abilities: unlocked with coins in the shop, two equipped per player (slots F / R).
// The same code runs for humans and bots offline; online the client predicts its own movement
// abilities and the SERVER validates every use (cooldowns, loadout, movement allowance, impulses).
import { CharacterController } from '../movement/controller.js';
import { CharacterModel } from '../player/characterModel.js';
import { audio } from '../audio/audio.js';
import { bus } from '../core/events.js';
import * as AFX from '../effects/abilityFx.js';

export const ABILITY_IDS = ['blink', 'rocket', 'decoy', 'grapple', 'cloak', 'shockwave'];

/** Presentation info (gameplay numbers live in config/game.json -> abilities). */
export const ABILITY_INFO = {
  blink: { icon: 'blink', color: '#3df5ff', desc: 'Teleport up to 9 m the way you are moving (or looking). Stops at walls — no clipping through.' },
  rocket: { icon: 'rocket', color: '#ff7a2f', desc: 'Blast yourself into the air with a small forward kick. Works mid-air: reach rooftops in one move.' },
  decoy: { icon: 'decoy', color: '#ffd23d', desc: 'Drop a hologram of yourself that sprints off in your direction. Bots (and careless friends) chase it.' },
  grapple: { icon: 'grapple', color: '#7dff6b', desc: 'Fire a hook at whatever is under your crosshair (24 m) and zip to it. Jump to let go early.' },
  cloak: { icon: 'cloak', color: '#b48cff', desc: 'Turn almost invisible for 4 s: no name tag, no arrow pointing at you, bots lose track of you.' },
  shockwave: { icon: 'shockwave', color: '#ff3df0', desc: 'Blast everyone within 6 m away from you and into the air. Escape a corner — or knock runners off a roof.' },
};

/** Two positional slots (F / R): [id|null, id|null], no duplicates, unknown ids dropped. */
export function validLoadout(ids) {
  const out = [null, null];
  (ids || []).slice(0, 2).forEach((id, i) => {
    if (ABILITY_IDS.includes(id) && !out.includes(id)) out[i] = id;
  });
  return out;
}

export class AbilitySystem {
  constructor(session) {
    this.s = session;
    this.cfg = session.cfg.abilities;
    this.decoys = [];
    this.time = 0;
    this.ropes = new Map(); // player id -> rope visual while grappling
    this.decoySeq = 0;
  }

  setLoadout(p, ids) {
    p.loadout = validLoadout(ids);
    p.abilityCd = {};
    p.cloakUntil = -1;
  }

  cooldown(p, id) {
    return Math.max(0, p.abilityCd?.[id] || 0);
  }

  isCloaked(p) {
    return (p.cloakUntil ?? -1) > this.time;
  }

  /**
   * Use the ability in `slot` (0/1). `aim` = { move: {x,z}, look: {x,y,z}, anchor: {x,y,z}|null }.
   * Returns { ok, id, reason, data }.
   */
  use(p, slot, aim) {
    const id = p.loadout?.[slot];
    if (!id) return { ok: false, reason: 'empty' };
    if (p.out || p.frozen || !p.connected) return { ok: false, id, reason: 'unavailable' };
    if (this.cooldown(p, id) > 0) return { ok: false, id, reason: 'cooldown' };
    const res = this.execute(p, id, aim);
    if (res.ok) {
      p.abilityCd[id] = this.cfg[id].cooldown;
      this.s.onAbilityUsed?.(p, id, res.data || {});
    } else if (p.id === this.s.localId) {
      audio.play('abilityDenied');
      bus.emit('hud:feed', { kind: 'info', text: res.reason === 'no_target' ? 'Grapple: aim at a surface within range' : res.reason === 'blocked' ? 'Blink: no room to teleport there' : 'Cannot use that right now' });
    }
    return { ...res, id };
  }

  /** Perform an ability (also used to replay other players' abilities online, with remote=true). */
  execute(p, id, aim = {}, remote = false) {
    const c = this.cfg[id];
    const fx = this.s.game.effects;
    const isLocal = p.id === this.s.localId;
    switch (id) {
      case 'blink': {
        if (remote) {
          AFX.blinkFx(this.s, p, aim.from || p.renderPos, aim.to || p.renderPos, false);
          return { ok: true };
        }
        let dx = aim.move?.x || 0, dz = aim.move?.z || 0;
        if (Math.hypot(dx, dz) < 0.2) {
          dx = aim.look?.x ?? -Math.sin(p.ctrl.yaw);
          dz = aim.look?.z ?? -Math.cos(p.ctrl.yaw);
        }
        const r = p.ctrl.blink(dx, dz, c.range);
        if (!r) return { ok: false, reason: 'blocked' };
        p.prev.x = p.ctrl.pos.x; p.prev.y = p.ctrl.pos.y; p.prev.z = p.ctrl.pos.z; // no smear between frames
        AFX.blinkFx(this.s, p, r.from, r.to, isLocal);
        return { ok: true, data: { from: r.from, to: r.to } };
      }
      case 'rocket': {
        if (!remote && !p.ctrl.rocket(c.velocity, c.forward)) return { ok: false, reason: 'unavailable' };
        AFX.rocketFx(this.s, p, isLocal);
        return { ok: true };
      }
      case 'grapple': {
        const a = aim.anchor;
        if (!a) return { ok: false, reason: 'no_target' };
        if (!remote) {
          const d = Math.hypot(a.x - p.ctrl.pos.x, a.y - (p.ctrl.pos.y + 1), a.z - p.ctrl.pos.z);
          if (d > c.range + 0.5 || d < 2) return { ok: false, reason: 'no_target' };
          p.ctrl.startGrapple(a, c.speed, c.maxTime);
        }
        this.ropes.set(p.id, AFX.createRope(this.s, p, a));
        audio.play('grapple', { pos: p.renderPos });
        return { ok: true, data: { anchor: { x: a.x, y: a.y, z: a.z } } };
      }
      case 'cloak': {
        p.cloakUntil = this.time + c.duration;
        AFX.cloakFx(this.s, p);
        return { ok: true };
      }
      case 'decoy': {
        const dir = aim.dir || { x: -Math.sin(p.ctrl.yaw), z: -Math.cos(p.ctrl.yaw) };
        this.spawnDecoy(p, aim.pos || p.ctrl.pos, dir, c.duration, aim.decoyId);
        return { ok: true, data: { pos: { ...p.ctrl.pos }, dir } };
      }
      case 'shockwave': {
        AFX.shockwaveFx(this.s, p, c.radius);
        if (!remote && !this.s.online) this.pushAround(p, c); // offline: push now; online the server pushes
        return { ok: true };
      }
      default:
        return { ok: false, reason: 'unknown' };
    }
  }

  /** Offline shockwave: push every other player in range (online the server does this). */
  pushAround(p, c) {
    for (const q of this.s.players.values()) {
      if (q === p || q.out || !q.connected) continue;
      const dx = q.ctrl.pos.x - p.ctrl.pos.x, dz = q.ctrl.pos.z - p.ctrl.pos.z, dy = q.ctrl.pos.y - p.ctrl.pos.y;
      const d = Math.hypot(dx, dz);
      if (d > c.radius || Math.abs(dy) > 3) continue;
      const k = 1 - (d / c.radius) * 0.5;
      const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
      q.ctrl.applyImpulse(nx * c.force * k, c.lift * k, nz * c.force * k);
    }
    for (const dcy of this.decoys) dcy.t = Math.max(dcy.t, dcy.life - 0.05); // holograms pop
  }

  spawnDecoy(owner, pos, dir, life, id) {
    const s = this.s;
    const ctrl = new CharacterController(s.world, s.cfg.movement);
    ctrl.teleport(pos.x, pos.y, pos.z, Math.atan2(-dir.x, -dir.z));
    const model = new CharacterModel(owner.cosmetics);
    model.setName(owner.name, '#ffffff');
    AFX.makeHologram(model);
    s.game.scene.add(model.root);
    const d = { id: id || `decoy${++this.decoySeq}`, owner: owner.id, ctrl, model, dir: { x: dir.x, z: dir.z }, t: 0, life, stuck: 0 };
    this.decoys.push(d);
    AFX.decoyFx(s, owner, pos);
    return d;
  }

  popDecoy(d, reason) {
    const i = this.decoys.indexOf(d);
    if (i < 0) return;
    this.decoys.splice(i, 1);
    AFX.decoyPopFx(this.s, d.ctrl.pos);
    this.s.game.scene.remove(d.model.root);
    d.model.dispose();
    if (reason === 'fooled' && d.foolerId === this.s.localId) bus.emit('hud:feed', { kind: 'info', text: 'That was a decoy!' });
  }

  /** Fixed-step update (sim time). */
  step(dt) {
    this.time += dt;
    for (const p of this.s.players.values()) {
      if (!p.abilityCd) continue;
      for (const k of Object.keys(p.abilityCd)) p.abilityCd[k] = Math.max(0, p.abilityCd[k] - dt);
    }
    const range = this.s.cfg.tag.range;
    for (const d of [...this.decoys]) {
      d.t += dt;
      const before = { x: d.ctrl.pos.x, z: d.ctrl.pos.z };
      d.ctrl.step({ mx: d.dir.x, mz: d.dir.z, sprint: true, jumpPressed: false, jumpHeld: false, slidePressed: false, dodgePressed: false, vaultPressed: false }, dt);
      d.ctrl.events.length = 0;
      // decoys turn when they run into something, like a panicking player would
      if (Math.hypot(d.ctrl.pos.x - before.x, d.ctrl.pos.z - before.z) < 2 * dt) d.stuck += dt;
      else d.stuck = 0;
      if (d.stuck > 0.25) {
        const turn = (Math.random() < 0.5 ? 1 : -1) * Math.PI * 0.5;
        const cs = Math.cos(turn), sn = Math.sin(turn);
        d.dir = { x: d.dir.x * cs - d.dir.z * sn, z: d.dir.x * sn + d.dir.z * cs };
        d.stuck = 0;
      }
      let popped = d.t >= d.life || d.ctrl.pos.y < this.s.world.killY;
      for (const q of this.s.players.values()) {
        if (popped || !q.it || q.out || q.id === d.owner) continue;
        if (Math.hypot(q.ctrl.pos.x - d.ctrl.pos.x, q.ctrl.pos.z - d.ctrl.pos.z) < range && Math.abs(q.ctrl.pos.y - d.ctrl.pos.y) < 1.7) {
          d.foolerId = q.id;
          popped = 'fooled';
        }
      }
      if (popped) this.popDecoy(d, popped === 'fooled' ? 'fooled' : 'expired');
    }
  }

  /** Per-frame visuals (real time). */
  render(dt, time) {
    for (const d of this.decoys) {
      const c = d.ctrl;
      d.model.update({ x: c.pos.x, y: c.pos.y, z: c.pos.z, yaw: c.yaw, vx: c.vel.x, vy: c.vel.y, vz: c.vel.z, state: c.state, grounded: c.grounded, sprinting: true, scriptProgress: c.scriptProgress, groundY: c.pos.y }, dt, time);
      AFX.hologramFlicker(d.model, time);
    }
    for (const [id, rope] of this.ropes) {
      const p = this.s.players.get(id);
      if (!p || (!p.ctrl.grapple && p.kind !== 'remote') || (p.kind === 'remote' && rope.age > 1.6)) {
        rope.dispose();
        this.ropes.delete(id);
        continue;
      }
      rope.update(p, dt);
    }
    for (const p of this.s.players.values()) AFX.cloakVisual(p, this.isCloaked(p), p.id === this.s.localId, time);
  }

  /** Bots see decoys as runners (that's the point of them). */
  perceivables() {
    return this.decoys.map((d) => ({ id: d.id, pos: d.ctrl.pos, vel: d.ctrl.vel, it: false, out: false, protected: false, frozen: false, decoy: true, owner: d.owner }));
  }

  dispose() {
    for (const d of [...this.decoys]) this.popDecoy(d, 'expired');
    for (const rope of this.ropes.values()) rope.dispose();
    this.ropes.clear();
  }
}
