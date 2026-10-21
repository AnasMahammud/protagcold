// Offline match: the local rules engine is authoritative; bots fill the lobby.
// Also used (with attract=true) for the live, bot-only match behind the main menu.
import * as R from './rules.js';
import { MatchSession } from './session.js';
import { BotBrain } from '../ai/bot.js';
import { mulberry32, shuffle } from '../core/mathUtil.js';
import { settings } from '../core/settings.js';
import { bus } from '../core/events.js';
import { audio } from '../audio/audio.js';
import { progression, computeAward } from '../progression/progression.js';
import { randomCosmetics } from '../progression/cosmetics.js';
import { ABILITY_IDS } from './abilities.js';
import { MapCoins } from './coins.js';
import { EventScheduler, eventsForMap, eventMods } from './mapEvents.js';

export const BOT_NAMES = ['Dash', 'Blitz', 'Nova', 'Pixel', 'Turbo', 'Echo', 'Zippy', 'Raven', 'Comet', 'Juno', 'Rook', 'Vex', 'Kite', 'Bolt', 'Mako', 'Skye', 'Flint', 'Rally'];

export class LocalMatch extends MatchSession {
  static async create(game, opts) {
    await game.loadMap(opts.mapId);
    const nav = game.getNav();
    const m = new LocalMatch(game, opts, nav);
    m.setup();
    return m;
  }

  constructor(game, opts, nav) {
    super(game, opts);
    this.nav = nav;
    this.rng = mulberry32(opts.seed ?? (Date.now() & 0xffffffff));
    this.lastCount = null;
    this.endTimer = 0;
    this.allowSlowmo = !this.attract; // offline: a perfect dodge really slows the world down
  }

  setup() {
    const cfg = this.cfg;
    const opts = this.opts;
    const map = this.game.map.data;
    const spawns = shuffle(map.spawns.slice(), this.rng);
    const roster = [];
    if (!this.attract && !opts.headless) {
      this.localId = 'you';
      roster.push(this.addPlayer({ id: 'you', name: settings.data.player.name, kind: 'local', cosmetics: progression.profile.cosmetics }));
    }
    const names = shuffle(BOT_NAMES.slice(), this.rng);
    const diff = cfg.bots[opts.difficulty] || cfg.bots.normal;
    const nBots = Math.min(cfg.match.maxPlayers - roster.length, opts.bots);
    for (let i = 0; i < nBots; i++) {
      const p = this.addPlayer({ id: `bot${i}`, name: names[i % names.length], kind: 'bot', cosmetics: randomCosmetics(this.rng) });
      p.brain = new BotBrain(p, this.nav, diff, Math.floor(this.rng() * 1e9));
      // bots get random abilities by difficulty (easy: none, normal: 1, hard: 2)
      this.abilities.setLoadout(p, shuffle(ABILITY_IDS.slice(), this.rng).slice(0, diff.abilities || 0));
      roster.push(p);
    }
    if (this.local) this.abilities.setLoadout(this.local, progression.loadout);
    this.coins = new MapCoins(this, { authoritative: true, rng: this.rng });
    this.mapEvent = null;
    this.eventPlan = this.attract || opts.headless ? null : new EventScheduler(cfg.mapEvents, eventsForMap(map), this.rng);
    const cx = (map.bounds[0] + map.bounds[2]) / 2, cz = (map.bounds[1] + map.bounds[3]) / 2;
    roster.forEach((p, i) => {
      const s = spawns[i % spawns.length];
      const yaw = Math.atan2(-(cx - s[0]), -(cz - s[2]));
      p.spawn(s[0], s[1], s[2], yaw);
    });

    // starting IT: practice -> a bot (so you practise evading first); otherwise random
    let startIt;
    const ids = roster.map((p) => p.id);
    if (this.mode === 'practice' && roster.length > 1) startIt = [ids.filter((id) => id !== this.localId)[Math.floor(this.rng() * (ids.length - 1))]];
    else startIt = [ids[Math.floor(this.rng() * ids.length)]];
    const rulesMode = this.attract ? 'practice' : this.mode;
    this.rules = R.createMatch({
      mode: rulesMode,
      players: roster.map((p) => ({ id: p.id, name: p.name })),
      startIt,
      cfg,
      countdown: this.attract ? 0 : cfg.match.countdown,
      zone: rulesMode === 'zone' ? zonePlan(map, this.rng) : undefined,
    });
    this.syncFlags();
    if (this.local) this.game.cameraRig.snapBehind(this.local.ctrl.yaw);
    this.game.cameraRig.pivotInit = false;
  }

  syncFlags() {
    const t = this.rules.time;
    for (const p of this.players.values()) {
      const rp = this.rules.players[p.id];
      if (!rp) continue;
      p.it = rp.it;
      p.out = rp.out;
      p.frozen = this.rules.phase === 'playing' && t < rp.frozenUntil;
      p.protected = t < rp.protectedUntil;
      p.boostLeft = Math.max(0, rp.boostUntil - t);
      p.boosted = p.boostLeft > 0;
    }
  }

  simStep(dt, inp) {
    const rules = this.rules;
    const evs = this.ended ? [] : R.tick(rules, dt);
    if (rules.phase === 'countdown') {
      const n = Math.ceil(rules.countdown);
      if (n !== this.lastCount && n > 0) {
        this.lastCount = n;
        audio.play('countdown');
        bus.emit('hud:banner', { text: String(n), sub: this.objectiveText(), color: '#ffffff', ms: 900, big: true });
      }
    }
    this.handleRuleEvents(evs);
    this.syncFlags();

    const playing = rules.phase === 'playing' && !this.ended;
    if (playing && this.eventPlan) {
      const { ev, started } = this.eventPlan.step(rules.time, rules.duration);
      this.mapEvent = ev;
      if (started && ev.kind === 'coinrain') this.coins.rain(this.cfg.mapEvents.rainCoins);
    }
    const mods = eventMods(this.mapEvent, rules.time);
    const botCtx = playing ? this.botContext() : null;
    if (botCtx) botCtx.dark = mods.dark;
    const tagCfg = this.cfg.tag;
    for (const p of this.players.values()) {
      p.beginStep();
      if (p.out) continue;
      let input = ZERO;
      if (p.kind === 'local') input = rules.phase === 'countdown' ? ZERO : inp;
      else if (p.brain) {
        input = this.ended ? ZERO : p.brain.update(dt, botCtx || { players: [], world: this.world, phase: rules.phase });
        if (playing && input.ability != null) this.abilities.use(p, input.ability, input.aim || {});
      }
      p.ctrl.frozen = p.frozen || rules.phase === 'countdown';
      p.ctrl.speedMultiplier = (p.it ? tagCfg.itSpeedBonus : 1) * (p.boosted ? this.cfg.perfectDodge.boostSpeed : 1) * mods.speed;
      p.ctrl.gravityScale = mods.gravity;
      p.ctrl.traction = mods.traction;
      p.ctrl.step(input, dt);
      this.handleMoveEvents(p);
    }
    this.abilities.step(dt);
    if (playing) {
      this.coins?.step(dt);
      this.detectPerfectDodges();
      this.detectTags();
      if (rules.zone) this.checkZone(dt);
    }
    if (this.ended) this.endTimer += dt;
  }

  /**
   * Perfect dodge: a runner started a dodge less than `window` seconds ago and an IT who could
   * legally tag them is closing in within (tag range + near-miss margin), or already touching.
   */
  detectPerfectDodges() {
    const pd = this.cfg.perfectDodge;
    const range = this.cfg.tag.range;
    for (const b of this.players.values()) {
      if (b.it || b.out || b.protected || b.ctrl.dodgeAge > pd.window) continue;
      for (const a of this.players.values()) {
        if (a === b || !a.it || a.out || a.frozen) continue;
        const dx = b.ctrl.pos.x - a.ctrl.pos.x, dz = b.ctrl.pos.z - a.ctrl.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > range + pd.nearMiss || Math.abs(b.ctrl.pos.y - a.ctrl.pos.y) > 1.7) continue;
        const closing = d > 1e-3 ? (a.ctrl.vel.x * dx + a.ctrl.vel.z * dz) / d : Infinity;
        if (d > range && closing < pd.closingSpeed) continue; // not actually lunging at you
        if (!this.world.lineOfSight({ x: a.ctrl.pos.x, y: a.ctrl.pos.y + 1, z: a.ctrl.pos.z }, { x: b.ctrl.pos.x, y: b.ctrl.pos.y + 1, z: b.ctrl.pos.z })) continue;
        if (this.triggerPerfectDodge(a, b)) break;
      }
    }
  }

  triggerPerfectDodge(tagger, dodger) {
    const pd = this.cfg.perfectDodge;
    // the stun starts when the cinematic ends: for your own dodge that is the slow-motion
    // cinematic's length in GAME time; other players' dodges use a short fixed beat
    const hero = dodger.id === this.localId;
    const s = pd.slowmo;
    const delay = hero ? 0.2 * (1 + s) + (pd.animTime - 0.48) * s + 0.08 : 0.4;
    const res = R.perfectDodge(this.rules, tagger.id, dodger.id, { delay, stun: pd.stunTime, boost: pd.boostTime, protect: pd.protectTime, cooldown: pd.cooldown });
    if (!res.ok) return false;
    dodger.ctrl.dodgeAge = 1e9; // one perfect dodge per dodge
    this.handleRuleEvents(res.events);
    this.syncFlags();
    return true;
  }

  /** Shrinking Zone: runners outside the ring build up "storm" time and are knocked out. */
  checkZone(dt) {
    const z = R.zoneAt(this.rules);
    for (const p of this.players.values()) {
      if (p.out || p.it) continue;
      const outside = Math.hypot(p.ctrl.pos.x - z.x, p.ctrl.pos.z - z.z) > z.r;
      const evs = R.zoneTick(this.rules, p.id, dt, outside);
      if (evs.length) {
        this.handleRuleEvents(evs);
        this.syncFlags();
      }
    }
  }

  botContext() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({ id: p.id, pos: p.ctrl.pos, vel: p.ctrl.vel, it: p.it, out: p.out, protected: p.protected, frozen: p.frozen, cloaked: this.abilities.isCloaked(p) });
    }
    players.push(...this.abilities.perceivables()); // decoys look like runners to bots
    return { players, world: this.world, phase: this.rules.phase, coins: this.coins?.positions() || [], zone: this.rules.zone ? R.zoneAt(this.rules, this.rules.time + 6) : null, fuse: this.rules.potato?.fuse ?? null };
  }

  /** A gold coin was touched: counted by the rules (paid out with the end-of-match award). */
  onCoinPicked(p) {
    return R.collectCoin(this.rules, p.id);
  }

  detectTags() {
    const range = this.cfg.tag.range;
    const w = this.world;
    for (const a of this.players.values()) {
      if (!a.it || a.out || a.frozen) continue;
      for (const b of this.players.values()) {
        if (b === a || b.it || b.out || b.protected) continue;
        const dx = b.ctrl.pos.x - a.ctrl.pos.x, dz = b.ctrl.pos.z - a.ctrl.pos.z;
        const dy = b.ctrl.pos.y - a.ctrl.pos.y;
        if (dx * dx + dz * dz > range * range || Math.abs(dy) > 1.7) continue;
        const la = { x: a.ctrl.pos.x, y: a.ctrl.pos.y + 1.0, z: a.ctrl.pos.z };
        const lb = { x: b.ctrl.pos.x, y: b.ctrl.pos.y + 1.0, z: b.ctrl.pos.z };
        if (!w.lineOfSight(la, lb)) continue;
        // touched during the perfect-dodge window: evaded instead of tagged
        if (b.ctrl.dodgeAge <= this.cfg.perfectDodge.window && this.triggerPerfectDodge(a, b)) break;
        const res = R.applyTag(this.rules, a.id, b.id);
        if (res.ok) {
          this.handleRuleEvents(res.events);
          this.syncFlags();
          break;
        }
      }
    }
  }

  handleRuleEvents(evs) {
    for (const ev of evs) {
      this.feedback(ev);
      if (ev.type === 'end') this.onEnd();
    }
  }

  onFell(p) {
    const spawns = this.game.map.data.spawns;
    const s = spawns[Math.floor(this.rng() * spawns.length)];
    p.spawn(s[0], s[1], s[2], p.ctrl.yaw);
    R.protect(this.rules, p.id);
    if (p.id === this.localId) bus.emit('hud:feed', { kind: 'info', text: 'Respawned (fell out of the map)' });
  }

  onSwapIt() {
    if (this.mode !== 'practice' || !this.localId) return;
    const me = this.rules.players[this.localId];
    if (me.it) {
      // hand IT to the nearest bot so practice can flip roles both ways
      let best = null;
      let bd = Infinity;
      for (const p of this.players.values()) {
        if (p.id === this.localId) continue;
        const d = Math.hypot(p.ctrl.pos.x - this.local.ctrl.pos.x, p.ctrl.pos.z - this.local.ctrl.pos.z);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (best) R.forceIt(this.rules, best.id);
    } else {
      R.forceIt(this.rules, this.localId);
    }
    const ev = this.rules.events[this.rules.events.length - 1];
    this.feedback(ev);
    this.syncFlags();
  }

  onEnd() {
    if (this.ended) return;
    this.ended = true;
    const result = this.rules.result;
    if (this.attract || this.opts.headless) return; // menu background / automated tests
    const local = this.local;
    const award = computeAward(result, this.localId, this.cfg);
    const prog = progression.recordMatch(result, this.localId, award, this.cfg.progression);
    const won = result.winners.includes(this.localId);
    audio.play(won ? 'victory' : 'defeat');
    for (const id of result.winners) {
      const p = this.players.get(id);
      if (p) this.game.effects.confetti(p.renderPos);
    }
    bus.emit('hud:banner', { text: won ? 'VICTORY' : 'MATCH OVER', sub: reasonText(result), color: won ? '#ffd23d' : '#ffffff', ms: 2200, big: true });
    setTimeout(() => {
      if (this.disposed) return;
      bus.emit('match:end', { result, award, prog, localId: this.localId, online: false, opts: this.opts, localName: local?.name });
    }, 2300);
  }

  rulesView() {
    const r = this.rules;
    const scoreboard = r.order.map((id) => {
      const p = r.players[id];
      return { id, name: p.name, it: p.it, out: p.out, tags: p.tags, itTime: p.itTime, survival: p.aliveTime, me: id === this.localId, bot: id.startsWith('bot') };
    });
    return {
      phase: r.phase,
      countdown: r.countdown,
      timeLeft: R.timeLeft(r),
      localTags: this.localId ? r.players[this.localId]?.tags ?? 0 : 0,
      scoreboard,
      time: r.time,
      fuse: r.potato ? Math.max(0, r.potato.fuse) : null,
      fuseMax: r.potato?.max ?? null,
      potatoRound: r.potato?.round ?? null,
      zone: r.zone ? { ...R.zoneAt(r), hold: r.zone.hold, end: r.zone.end, limit: r.zone.limit } : null,
      mapEvent: this.mapEvent,
      localStorm: this.localId ? r.players[this.localId]?.stormTime ?? 0 : 0,
    };
  }
}

/** Shrinking Zone layout: starts over the whole map, closes toward one of its spawns. */
export function zonePlan(map, rng) {
  const [x0, z0, x1, z1] = map.bounds;
  const ground = map.spawns.filter((s) => s[1] < 1);
  const pool = ground.length ? ground : map.spawns;
  const end = pool[Math.floor(rng() * pool.length)];
  return { x0: (x0 + x1) / 2, z0: (z0 + z1) / 2, x1: end[0], z1: end[2], r0: Math.hypot(x1 - x0, z1 - z0) / 2 + 2 };
}

export function reasonText(result) {
  switch (result.reason) {
    case 'all_infected': return 'Everyone was infected';
    case 'last_runner': return result.mode === 'hotpotato' ? 'Last one standing!' : 'One runner left standing';
    case 'all_out': return 'Every runner was eliminated';
    case 'players': return 'Not enough players';
    default:
      if (result.mode === 'infection') return result.team === 'runners' ? 'The survivors held out!' : 'The infection spread';
      return "Time's up";
  }
}

const ZERO = Object.freeze({ mx: 0, mz: 0, jumpPressed: false, jumpHeld: false, sprint: false, slidePressed: false, dodgePressed: false, vaultPressed: false });
