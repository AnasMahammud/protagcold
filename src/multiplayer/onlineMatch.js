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
import { MapCoins } from '../gameplay/coins.js';
import { zoneAt } from '../gameplay/rules.js';
import { eventMods } from '../gameplay/mapEvents.js';

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
    // adaptive interpolation delay: just enough to cover the measured arrival jitter
    this.jitter = 0.01;
    this.interpDelay = this.cfg.tick.interpDelayMs / 1000;
    this.rules = start.rules;
    this.rulesAt = net.now();
    this.tagCooldown = new Map();
    this.remotePrev = new Map();
    this.lastCount = null;
    this.offs = [];
    this.matchId = start.matchId;
    this.online = true; // abilities: the server applies knockback and validates every use
  }

  setup(start) {
    for (const pl of start.players) {
      const kind = pl.id === this.localId ? 'local' : 'remote';
      const p = this.addPlayer({ id: pl.id, name: pl.name, kind, cosmetics: pl.cosm });
      const s = start.spawns[pl.id] || [0, 0, 0, 0];
      p.spawn(s[0], s[1], s[2], s[3] || 0);
    }
    this.applyRules(this.rules);
    if (this.local) this.abilities.setLoadout(this.local, progression.loadout);
    // gold coins are owned by the server: we only mirror spawns / pickups
    this.coins = new MapCoins(this, { authoritative: false });
    for (const [id, x, y, z] of start.coins || []) this.coins.spawn(id, { x, y, z });
    if (this.local) this.game.cameraRig.snapBehind(this.local.ctrl.yaw);
    this.game.cameraRig.pivotInit = false;
    const on = (t, fn) => this.offs.push(bus.on(`net:${t}`, fn));
    on('snap', (m) => this.onSnap(m));
    on('rules', (m) => this.applyRules(m.rules));
    on('event', (m) => this.onEvent(m.ev));
    on('correct', (m) => this.onCorrect(m));
    on('match_end', (m) => this.onMatchEnd(m));
    on('ability', (m) => this.onRemoteAbility(m));
    on('ability_denied', (m) => {
      audio.play('abilityDenied');
      bus.emit('hud:feed', { kind: 'info', text: `Server blocked ${this.cfg.abilities[m.id]?.name || 'ability'} (${String(m.reason).replace('_', ' ')})` });
    });
    on('impulse', (m) => {
      const p = this.local;
      if (!p || !Array.isArray(m.v)) return;
      p.ctrl.applyImpulse(m.v[0], m.v[1], m.v[2]);
      this.game.cameraRig.shake(0.35);
    });
    on('coin_taken', (m) => this.coins.take(m.id, m.by));
    on('coin_spawn', (m) => this.coins.spawn(m.id, { x: m.p[0], y: m.p[1], z: m.p[2] }, { drop: !!m.drop }));
    on('coin_denied', (m) => this.coins.pending.delete(m.id));
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
      const [id, x, y, z, vx, vy, vz, yaw, st, fl, sc, rt] = s;
      if (id === this.localId) continue;
      const p = this.players.get(id);
      if (!p) continue;
      const t = rt ?? m.ts; // per-player receive time (newer servers), else the snapshot time
      const last = p.buffer[p.buffer.length - 1];
      if (last && t <= last.t) continue; // nothing new from this player since the last snapshot
      if (last) {
        const gap = t - last.t;
        if (gap < 0.5) this.jitter += (Math.abs(gap - this.sendInterval) - this.jitter) * 0.05;
      }
      p.pushSnapshot(t, { x, y, z, vx, vy, vz, yaw, state: st, grounded: !!(fl & 1), sprinting: !!(fl & 2), scriptProgress: sc || 0 });
    }
  }

  onEvent(ev) {
    this.feedback(ev);
  }

  /** Our ability went off locally (prediction): tell the server, which validates and relays it. */
  onAbilityUsed(p, id, data) {
    if (p.id !== this.localId) return;
    const v = (o) => [r3(o.x), r3(o.y), r3(o.z)];
    const msg = { id };
    if (data.to) msg.to = v(data.to);
    if (data.anchor) msg.anchor = v(data.anchor);
    if (data.dir) msg.dir = [r3(data.dir.x), r3(data.dir.z)];
    this.net.send('ability', msg);
  }

  /** Someone else used an ability (already validated by the server): replay its effects. */
  onRemoteAbility(m) {
    const p = this.players.get(m.by);
    if (!p || m.by === this.localId || !this.cfg.abilities[m.id]) return;
    const d = m.data || {};
    const o = (a) => (Array.isArray(a) ? { x: a[0], y: a[1], z: a[2] } : null);
    this.abilities.execute(p, m.id, {
      from: o(d.from),
      to: o(d.to),
      anchor: o(d.anchor),
      pos: o(d.pos),
      dir: Array.isArray(d.dir) ? { x: d.dir[0], z: d.dir[1] } : null,
    }, true);
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
      const mods = eventMods(this.rules.ev || null, this.rulesView().time);
      p.ctrl.speedMultiplier = (p.it ? this.cfg.tag.itSpeedBonus : 1) * (p.boosted ? this.cfg.perfectDodge.boostSpeed : 1) * mods.speed;
      p.ctrl.gravityScale = mods.gravity;
      p.ctrl.traction = mods.traction;
      p.ctrl.step(phase === 'countdown' ? ZERO : inp, dt);
      // tell the server the moment we dodge: it decides whether it was a PERFECT dodge
      if (p.ctrl.events.some((e) => e.type === 'dodge')) this.net.send('dodge', {});
      // sudden moves (jump, dodge, slide, vault, pad, slide ride...) go out right away instead
      // of waiting for the next regular update: other players see them sooner
      if (p.ctrl.events.some((e) => SNAP_NOW.has(e.type))) this.sendT = this.sendInterval;
      this.handleMoveEvents(p);
    }
    this.abilities.step(dt);
    if (phase === 'playing' && !this.ended) this.coins?.step(dt);
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
    const tk = this.cfg.tick;
    const want = Math.min(tk.interpDelayMs / 1000, Math.max((tk.minInterpDelayMs ?? 45) / 1000, this.sendInterval * 1.25 + this.jitter * 2.5 + 0.01));
    this.interpDelay += (want - this.interpDelay) * Math.min(1, dt * 0.8);
    const renderT = this.net.serverNow() - this.interpDelay;
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
    const me = r.players.find((x) => x.id === this.localId);
    return {
      phase: r.phase,
      countdown: cd,
      timeLeft: r.duration > 0 ? Math.max(0, r.duration - time) : Infinity,
      localTags: me?.tags ?? 0,
      scoreboard,
      time,
      // between server updates the fuse and the ring keep moving locally
      fuse: r.potato ? Math.max(0, r.potato.fuse - elapsed) : null,
      fuseMax: r.potato?.max ?? null,
      potatoRound: r.potato?.round ?? null,
      zone: r.zone ? { ...zoneAt({ zone: r.zone }, time), hold: r.zone.hold, end: r.zone.end, limit: r.zone.limit } : null,
      localStorm: me?.st || 0,
      mapEvent: r.ev || null,
    };
  }

  netStatus() {
    return `Ping ${Math.round(this.net.rtt * 1000)} ms · delay ${Math.round(this.interpDelay * 1000)} ms`;
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
    super.dispose();
  }
}

const SNAP_NOW = new Set(['jump', 'walljump', 'dodge', 'slide', 'vault', 'mantle', 'pad', 'ride', 'ride_end', 'blink', 'grapple', 'rocket', 'knocked']);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const ZERO = Object.freeze({ mx: 0, mz: 0, jumpPressed: false, jumpHeld: false, sprint: false, slidePressed: false, dodgePressed: false, vaultPressed: false });
