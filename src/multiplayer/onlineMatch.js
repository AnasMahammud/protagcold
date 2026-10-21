// Online match session. The SERVER is authoritative for match state, IT status, tags,
// eliminations, timers and results. The client predicts only its own movement (so controls
// feel instant), streams it to the server for validation, and renders everyone else from
// interpolated server snapshots. A tag only happens when the server confirms it.
import { MatchSession } from '../gameplay/session.js';
import { MS } from '../movement/controller.js';
import { bus } from '../core/events.js';
import { audio } from '../audio/audio.js';
import { progression } from '../progression/progression.js';
import { reasonText } from '../gameplay/localMatch.js';

export class OnlineMatch extends MatchSession {
  static async create(game, net, start) {
    await game.loadMap(start.map);
    const m = new OnlineMatch(game, { mode: start.mode, mapId: start.map, online: true }, net, start);
    m.setup(start);
    return m;
  }

  constructor(game, opts, net, start) {
    super(game, opts);
    this.net = net;
    this.localId = net.id;
    this.seq = 0;
    this.sendT = 0;
    this.sendInterval = 1 / this.cfg.tick.netSendHz;
    this.rules = start.rules;
    this.rulesAt = net.now();
    this.tagCooldown = new Map();
    this.remotePrev = new Map();
    this.lastCount = null;
    this.offs = [];
    this.matchId = start.matchId;
  }

  setup(start) {
    for (const pl of start.players) {
      const kind = pl.id === this.localId ? 'local' : 'remote';
      const p = this.addPlayer({ id: pl.id, name: pl.name, kind, cosmetics: pl.cosm });
      const s = start.spawns[pl.id] || [0, 0, 0, 0];
      p.spawn(s[0], s[1], s[2], s[3] || 0);
    }
    this.applyRules(this.rules);
    if (this.local) this.game.cameraRig.snapBehind(this.local.ctrl.yaw);
    this.game.cameraRig.pivotInit = false;
    const on = (t, fn) => this.offs.push(bus.on(`net:${t}`, fn));
    on('snap', (m) => this.onSnap(m));
    on('rules', (m) => this.applyRules(m.rules));
    on('event', (m) => this.onEvent(m.ev));
    on('correct', (m) => this.onCorrect(m));
    on('match_end', (m) => this.onMatchEnd(m));
    on('emote', (m) => {
      const p = this.players.get(m.id);
      if (p && m.id !== this.localId) p.model.playEmote(m.e);
    });
    on('player_left', (m) => {
      const p = this.players.get(m.id);
      if (p) {
        p.connected = false;
        bus.emit('hud:feed', { kind: 'info', text: `${p.name} disconnected` });
      }
    });
    on('player_back', (m) => {
      const p = this.players.get(m.id);
      if (p) {
        p.connected = true;
        bus.emit('hud:feed', { kind: 'info', text: `${p.name} reconnected` });
      }
    });
  }

  applyRules(r) {
    this.rules = r;
    this.rulesAt = this.net.now();
    for (const rp of r.players) {
      const p = this.players.get(rp.id);
      if (!p) continue;
      p.it = rp.it;
      p.out = rp.out;
      p.frozen = rp.fz > 0;
      p.protected = rp.pr > 0;
      p.boostLeft = rp.bo || 0;
      p.boosted = p.boostLeft > 0;
      p.connected = rp.c;
    }
    if (r.phase === 'countdown') {
      const n = Math.ceil(r.countdown);
      if (n !== this.lastCount && n > 0) {
        this.lastCount = n;
        audio.play('countdown');
        bus.emit('hud:banner', { text: String(n), sub: this.objectiveText(), color: '#ffffff', ms: 900, big: true });
      }
    }
  }

  onSnap(m) {
    for (const s of m.p) {
      const [id, x, y, z, vx, vy, vz, yaw, st, fl, sc] = s;
      if (id === this.localId) continue;
      const p = this.players.get(id);
      if (!p) continue;
      p.pushSnapshot(m.ts, { x, y, z, vx, vy, vz, yaw, state: st, grounded: !!(fl & 1), sprinting: !!(fl & 2), scriptProgress: sc || 0 });
    }
  }

  onEvent(ev) {
    this.feedback(ev);
  }

  onCorrect(m) {
    // the server rejected our movement (speed/teleport/solid check): snap back
    const p = this.local;
    if (!p) return;
    p.ctrl.teleport(m.p[0], m.p[1], m.p[2], p.ctrl.yaw);
    p.prev.x = m.p[0]; p.prev.y = m.p[1]; p.prev.z = m.p[2];
    console.warn('[net] movement corrected by server:', m.reason);
  }

  onMatchEnd(m) {
    if (this.ended) return;
    this.ended = true;
    const result = m.result;
    const award = m.award || { total: 0, parts: [] };
    const prog = progression.recordMatch(result, this.localId, award, this.cfg.progression, { online: true });
    const won = result.winners.includes(this.localId);
    audio.play(won ? 'victory' : 'defeat');
    for (const id of result.winners) {
      const p = this.players.get(id);
      if (p) this.game.effects.confetti(p.renderPos);
    }
    bus.emit('hud:banner', { text: won ? 'VICTORY' : 'MATCH OVER', sub: reasonText(result), color: won ? '#ffd23d' : '#ffffff', ms: 2200, big: true });
    setTimeout(() => {
      if (this.disposed) return;
      bus.emit('match:end', { result, award, prog, localId: this.localId, online: true, opts: this.opts, localName: this.local?.name });
    }, 2300);
  }

  simStep(dt, inp) {
    const p = this.local;
    if (!p) return;
    const phase = this.rules.phase;
    p.beginStep();
    if (!p.out) {
      p.ctrl.frozen = p.frozen || phase === 'countdown' || this.ended;
      // boost time counts down locally between server snapshots
      if (p.boostLeft > 0) {
        p.boostLeft = Math.max(0, p.boostLeft - dt);
        p.boosted = p.boostLeft > 0;
      }
      p.ctrl.speedMultiplier = (p.it ? this.cfg.tag.itSpeedBonus : 1) * (p.boosted ? this.cfg.perfectDodge.boostSpeed : 1);
      p.ctrl.step(phase === 'countdown' ? ZERO : inp, dt);
      // tell the server the moment we dodge: it decides whether it was a PERFECT dodge
      if (p.ctrl.events.some((e) => e.type === 'dodge')) this.net.send('dodge', {});
      this.handleMoveEvents(p);
    }
    // stream our state to the server for validation + relay
    this.sendT += dt;
    if (this.sendT >= this.sendInterval) {
      this.sendT = 0;
      const c = p.ctrl;
      const fl = (c.grounded ? 1 : 0) | (c.sprinting ? 2 : 0);
      this.net.send('state', {
        s: ++this.seq,
        p: [r3(c.pos.x), r3(c.pos.y), r3(c.pos.z)],
        v: [r2(c.vel.x), r2(c.vel.y), r2(c.vel.z)],
        y: r2(c.yaw),
        st: c.state,
        fl,
        sc: r2(c.scriptProgress),
      });
    }
    if (phase === 'playing' && p.it && !p.out && !p.frozen) this.requestTags();
  }

  /** Ask the server to validate tags on runners we are touching (it decides). */
  requestTags() {
    const me = this.local.ctrl.pos;
    const range = this.cfg.tag.range + 0.25;
    const now = this.net.now();
    for (const p of this.players.values()) {
      if (p.id === this.localId || p.it || p.out || p.protected || !p.connected) continue;
      const dx = p.ctrl.pos.x - me.x, dz = p.ctrl.pos.z - me.z, dy = p.ctrl.pos.y - me.y;
      if (dx * dx + dz * dz > range * range || Math.abs(dy) > 1.8) continue;
      if (now - (this.tagCooldown.get(p.id) || 0) < 0.15) continue;
      this.tagCooldown.set(p.id, now);
      this.net.send('tag', { target: p.id });
      this.local.model.lunge();
    }
  }

  renderPlayers(dt, time, alpha) {
    const renderT = this.net.serverNow() - this.cfg.tick.interpDelayMs / 1000;
    for (const p of this.players.values()) {
      if (p.kind !== 'remote') continue;
      const prev = this.remotePrev.get(p.id) || { state: MS.GROUND, grounded: true, vy: 0 };
      const s = p.sampleRemote(renderT);
      this.remoteFeedback(p, prev, s);
      this.remotePrev.set(p.id, { state: s.state, grounded: s.grounded, vy: s.vy });
    }
    super.renderPlayers(dt, time, alpha);
  }

  /** Derive movement sounds/particles for remote players from snapshot transitions. */
  remoteFeedback(p, prev, s) {
    const pos = p.renderPos;
    if (s.state !== prev.state) {
      if (s.state === MS.VAULT) audio.play('vault', { pos, ownerId: p.id });
      else if (s.state === MS.MANTLE) audio.play('mantle', { pos, ownerId: p.id });
      else if (s.state === MS.DODGE) audio.play('dodge', { pos, ownerId: p.id });
    }
    if (prev.grounded && !s.grounded && s.vy > 4) {
      audio.play(s.vy > 14 ? 'pad' : 'jump', { pos, ownerId: p.id });
    }
    if (!prev.grounded && s.grounded && prev.vy < -7) {
      audio.play('land', { pos, speed: -prev.vy, ownerId: p.id });
      this.game.effects.dust(pos, Math.min(2, -prev.vy / 8));
      p.model.landed(-prev.vy);
    }
  }

  onFell(p) {
    if (p.id === this.localId) this.net.send('respawn');
  }

  emote(id, emote) {
    super.emote(id, emote);
    if (id === this.localId) this.net.send('emote', { e: emote });
  }

  rulesView() {
    const r = this.rules;
    const elapsed = r.phase === 'playing' ? this.net.now() - this.rulesAt : 0;
    const time = r.time + elapsed;
    const cd = r.phase === 'countdown' ? Math.max(0, r.countdown - (this.net.now() - this.rulesAt)) : 0;
    const scoreboard = r.players.map((rp) => {
      const p = this.players.get(rp.id);
      return { id: rp.id, name: p?.name ?? rp.id, it: rp.it, out: rp.out, tags: rp.tags, itTime: rp.itTime, survival: rp.alive, me: rp.id === this.localId, bot: false };
    });
    return {
      phase: r.phase,
      countdown: cd,
      timeLeft: r.duration > 0 ? Math.max(0, r.duration - time) : Infinity,
      localTags: r.players.find((x) => x.id === this.localId)?.tags ?? 0,
      scoreboard,
    };
  }

  netStatus() {
    return `Ping ${Math.round(this.net.rtt * 1000)} ms`;
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
    super.dispose();
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const ZERO = Object.freeze({ mx: 0, mz: 0, jumpPressed: false, jumpHeld: false, sprint: false, slidePressed: false, dodgePressed: false, vaultPressed: false });
