// Pure, deterministic tag-rules engine (no rendering, no networking).
// Offline matches run this directly. Online matches run the Python port in server/rules.py,
// and BOTH implementations are checked against tests/shared/rules_cases.json for parity.
//
// Modes: classic, infection, elimination (Last Runner), practice, hotpotato, zone.

export const MODES = ['classic', 'infection', 'elimination', 'practice', 'hotpotato', 'zone'];
// modes where tagged / exploded / caught players are out (and late joiners spectate)
const KNOCKOUT = new Set(['elimination', 'hotpotato', 'zone']);

/**
 * `zone` (Shrinking Zone only): { x0, z0, x1, z1, r0 } = where the ring starts (centre + radius)
 * and where it ends up; the final radius and timing come from cfg.modes.zone.
 */
export function createMatch({ mode, players, startIt, cfg, countdown, zone }) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
  const modeCfg = cfg.modes[mode];
  const state = {
    mode,
    phase: 'setup', // initial players must not be treated as late joiners
    countdown: countdown ?? cfg.match.countdown,
    time: 0,
    duration: modeCfg.duration,
    tagCfg: cfg.tag,
    order: [],
    players: {},
    events: [],
    result: null,
    tagCount: 0,
  };
  if (mode === 'hotpotato') {
    // the potato's fuse burns while it is held; it never resets on a tag (that's the point)
    state.potato = { fuse: modeCfg.fuse, max: modeCfg.fuse, min: modeCfg.fuseMin, step: modeCfg.fuseStep, round: 1 };
  }
  if (mode === 'zone') {
    const z = zone || { x0: 0, z0: 0, x1: 0, z1: 0, r0: 60 };
    state.zone = { x0: z.x0, z0: z.z0, x1: z.x1, z1: z.z1, r0: z.r0, r1: modeCfg.minRadius, hold: modeCfg.zoneHold, end: modeCfg.zoneEnd, limit: modeCfg.outsideLimit };
  }
  for (const p of players) addPlayer(state, p.id, p.name);
  state.phase = state.countdown > 0 ? 'countdown' : 'playing';
  for (const id of startIt) {
    if (state.players[id]) {
      state.players[id].it = true;
      state.players[id].wasIt = true;
    }
  }
  if (state.phase === 'playing') state.events.push({ type: 'start' });
  return state;
}

export function addPlayer(state, id, name) {
  if (state.players[id]) {
    state.players[id].connected = true;
    return state.players[id];
  }
  const p = {
    id,
    name: name || id,
    it: false,
    wasIt: false,
    out: false,
    outAt: null,
    connected: true,
    tags: 0,
    tagged: 0,
    itTime: 0,
    aliveTime: 0,
    lastTagAt: -1e9,
    frozenUntil: -1e9,
    protectedUntil: -1e9,
    noTagBackFrom: null,
    noTagBackUntil: -1e9,
    boostUntil: -1e9,
    perfectDodges: 0,
    lastPerfectAt: -1e9,
    coinsPicked: 0,
    stormTime: 0,
  };
  // Late joiners in infection join the infected; in knockout modes they spectate.
  if (state.phase === 'playing') {
    if (state.mode === 'infection') { p.it = true; p.wasIt = true; }
    if (KNOCKOUT.has(state.mode)) { p.out = true; p.outAt = state.time; }
    p.protectedUntil = state.time + state.tagCfg.spawnProtection;
  }
  state.players[id] = p;
  state.order.push(id);
  return p;
}

const live = (state) => state.order.map((id) => state.players[id]).filter((p) => p.connected);

export function itPlayers(state) {
  return live(state).filter((p) => p.it && !p.out);
}

export function runners(state) {
  return live(state).filter((p) => !p.it && !p.out);
}

/** Advance the match clock. Returns the events generated during this tick (and appends to state.events). */
export function tick(state, dt) {
  const out = [];
  if (state.phase === 'countdown') {
    state.countdown -= dt;
    if (state.countdown <= 0) {
      state.countdown = 0;
      state.phase = 'playing';
      out.push({ type: 'start' });
    }
  } else if (state.phase === 'playing') {
    state.time += dt;
    for (const p of live(state)) {
      if (p.out) continue;
      if (p.it) p.itTime += dt;
      else p.aliveTime += dt;
    }
    if (state.potato) {
      state.potato.fuse -= dt;
      if (state.potato.fuse <= 0) out.push(...explode(state));
    }
    if (state.phase === 'playing' && state.duration > 0 && state.time >= state.duration) {
      out.push(...endMatch(state, 'time'));
    }
  }
  state.events.push(...out);
  return out;
}

export function canTag(state, taggerId, targetId) {
  const now = state.time;
  if (state.phase !== 'playing') return { ok: false, reason: 'phase' };
  const a = state.players[taggerId];
  const b = state.players[targetId];
  if (!a || !b || !a.connected || !b.connected) return { ok: false, reason: 'invalid' };
  if (taggerId === targetId) return { ok: false, reason: 'self' };
  if (!a.it) return { ok: false, reason: 'not_it' };
  if (a.out) return { ok: false, reason: 'out' };
  if (b.out) return { ok: false, reason: 'target_out' };
  if (b.it) return { ok: false, reason: 'target_it' };
  if (now < a.frozenUntil) return { ok: false, reason: 'frozen' };
  if (now < b.protectedUntil) return { ok: false, reason: 'protected' };
  if (now - a.lastTagAt < state.tagCfg.cooldown) return { ok: false, reason: 'cooldown' };
  if (a.noTagBackFrom === targetId && now < a.noTagBackUntil) return { ok: false, reason: 'no_tagback' };
  return { ok: true, reason: 'ok' };
}

/**
 * Hot potato: the fuse ran out. Whoever holds the potato is out; it goes to the remaining player
 * who has held it the least (ties: join order) with a shorter fuse.
 */
function explode(state) {
  const evs = [];
  for (const h of itPlayers(state)) {
    h.out = true;
    h.outAt = state.time;
    h.it = false;
    evs.push({ type: 'exploded', id: h.id, time: state.time });
  }
  const alive = live(state).filter((p) => !p.out);
  const pt = state.potato;
  if (alive.length >= 2) {
    const next = alive.slice().sort((a, b) => a.itTime - b.itTime || state.order.indexOf(a.id) - state.order.indexOf(b.id))[0];
    next.it = true;
    next.wasIt = true;
    next.frozenUntil = state.time + state.tagCfg.newItFreeze;
    next.lastTagAt = state.time;
    pt.round++;
    pt.max = Math.max(pt.min, pt.max - pt.step);
    evs.push({ type: 'it', id: next.id, from: null, reason: 'potato' });
  }
  pt.fuse = pt.max;
  evs.push(...checkEnd(state));
  return evs;
}

/**
 * Shrinking zone: call every step for every player with whether they stand outside the ring.
 * Runners outside it too long are out. Returns events.
 */
export function zoneTick(state, id, dt, outside) {
  const z = state.zone;
  const p = state.players[id];
  if (!z || state.phase !== 'playing' || !p || !p.connected || p.out || p.it) return [];
  if (!outside) {
    p.stormTime = Math.max(0, p.stormTime - dt * 0.5);
    return [];
  }
  p.stormTime += dt;
  if (p.stormTime < z.limit) return [];
  p.out = true;
  p.outAt = state.time;
  const ev = { type: 'eliminated', id, by: null, reason: 'zone' };
  state.events.push(ev);
  return [ev, ...checkEnd(state)];
}

/** The ring at time t: { x, z, r, k } (k: 0 before it starts closing, 1 once fully closed). */
export function zoneAt(state, t = state.time) {
  const z = state.zone;
  if (!z) return null;
  const k = Math.max(0, Math.min(1, (t - z.hold) / (z.end - z.hold)));
  return { x: z.x0 + (z.x1 - z.x0) * k, z: z.z0 + (z.z1 - z.z0) * k, r: z.r0 + (z.r1 - z.r0) * k, k };
}

/** Validate and apply a tag. Returns { ok, reason, events }. A rejected tag changes nothing. */
export function applyTag(state, taggerId, targetId) {
  const check = canTag(state, taggerId, targetId);
  if (!check.ok) return { ...check, events: [] };
  const now = state.time;
  const t = state.tagCfg;
  const a = state.players[taggerId];
  const b = state.players[targetId];
  const events = [];
  a.tags++;
  b.tagged++;
  a.lastTagAt = now;
  state.tagCount++;
  events.push({ type: 'tag', tagger: taggerId, target: targetId, time: now, seq: state.tagCount });

  if (state.mode === 'classic' || state.mode === 'practice' || state.mode === 'hotpotato') {
    a.it = false;
    b.it = true;
    b.wasIt = true;
    b.frozenUntil = now + t.newItFreeze;
    b.lastTagAt = now;
    b.noTagBackFrom = taggerId;
    b.noTagBackUntil = now + t.noTagBackTime;
    events.push({ type: 'it', id: targetId, from: taggerId });
  } else if (state.mode === 'infection') {
    b.it = true;
    b.wasIt = true;
    b.frozenUntil = now + t.newItFreeze;
    b.lastTagAt = now;
    events.push({ type: 'infected', id: targetId, by: taggerId });
  } else if (state.mode === 'elimination' || state.mode === 'zone') {
    b.out = true;
    b.outAt = now;
    events.push({ type: 'eliminated', id: targetId, by: taggerId });
  }
  state.events.push(...events);
  const endEvents = checkEnd(state);
  events.push(...endEvents);
  return { ok: true, reason: 'ok', events };
}

/**
 * Perfect dodge: the dodger evaded a tag that would have been LEGAL (same checks as a tag).
 * The tagger is frozen until `delay + stun` (delay = length of the cinematic), the dodger gets a
 * speed boost and short protection. No tag happens. Returns { ok, reason, events }.
 */
export function perfectDodge(state, taggerId, dodgerId, { delay = 0, stun = 1, boost = 5, protect = 1.5, cooldown = 0 } = {}) {
  const check = canTag(state, taggerId, dodgerId);
  if (!check.ok) return { ...check, events: [] };
  const now = state.time;
  if (now - state.players[dodgerId].lastPerfectAt < cooldown) return { ok: false, reason: 'dodge_cooldown', events: [] };
  const a = state.players[taggerId];
  const b = state.players[dodgerId];
  a.frozenUntil = Math.max(a.frozenUntil, now + delay + stun);
  a.lastTagAt = now; // the attempt is spent
  b.boostUntil = now + delay + boost;
  b.protectedUntil = Math.max(b.protectedUntil, now + delay + protect);
  b.perfectDodges++;
  b.lastPerfectAt = now;
  const ev = { type: 'perfect_dodge', tagger: taggerId, dodger: dodgerId, time: now, delay, stun, boost };
  state.events.push(ev);
  return { ok: true, reason: 'ok', events: [ev] };
}

/** A player grabbed a gold coin on the map (counted for the end-of-match coin award). */
export function collectCoin(state, id) {
  const p = state.players[id];
  if (state.phase !== 'playing' || !p || !p.connected || p.out) return false;
  p.coinsPicked++;
  return true;
}

/** Practice helper: make a player IT immediately (only allowed in practice mode). */
export function forceIt(state, id) {
  if (state.mode !== 'practice' || !state.players[id]) return false;
  for (const p of Object.values(state.players)) p.it = false;
  const p = state.players[id];
  p.it = true;
  p.wasIt = true;
  p.lastTagAt = state.time;
  state.events.push({ type: 'it', id, from: null });
  return true;
}

/** Grant temporary tag immunity (used after a respawn). */
export function protect(state, id, seconds) {
  const p = state.players[id];
  if (p) p.protectedUntil = state.time + (seconds ?? state.tagCfg.spawnProtection);
}

export function removePlayer(state, id) {
  const p = state.players[id];
  if (!p || !p.connected) return [];
  p.connected = false;
  const out = [];
  if (state.phase === 'ended') return out;
  if (p.it && !p.out && itPlayers(state).length === 0) {
    // hand IT to the next connected, non-eliminated runner in join order
    const idx = state.order.indexOf(id);
    const n = state.order.length;
    for (let k = 1; k <= n; k++) {
      const q = state.players[state.order[(idx + k) % n]];
      if (q.connected && !q.out && !q.it) {
        q.it = true;
        q.wasIt = true;
        q.frozenUntil = state.time + state.tagCfg.newItFreeze;
        q.lastTagAt = state.time;
        out.push({ type: 'it', id: q.id, from: null, reason: 'disconnect' });
        break;
      }
    }
  }
  state.events.push(...out);
  out.push(...checkEnd(state));
  return out;
}

export function checkEnd(state) {
  if (state.phase !== 'playing' && state.phase !== 'countdown') return [];
  const players = live(state);
  if (state.mode === 'practice') return [];
  if (players.length < 2) return endMatch(state, 'players');
  if (state.phase !== 'playing') return [];
  if (state.mode === 'infection' && runners(state).length === 0) return endMatch(state, 'all_infected');
  if (state.mode === 'elimination' || state.mode === 'zone') {
    const alive = runners(state);
    if (alive.length <= 1) return endMatch(state, alive.length === 1 ? 'last_runner' : 'all_out');
  }
  if (state.mode === 'hotpotato') {
    const alive = players.filter((p) => !p.out);
    if (alive.length <= 1) return endMatch(state, alive.length === 1 ? 'last_runner' : 'all_out');
  }
  return [];
}

export function endMatch(state, reason) {
  if (state.phase === 'ended') return [];
  state.phase = 'ended';
  state.result = computeResult(state, reason);
  const ev = { type: 'end', reason, winners: state.result.winners, team: state.result.team };
  state.events.push(ev);
  return [ev];
}

export function computeResult(state, reason) {
  const all = state.order.map((id) => state.players[id]);
  let ranked;
  let winners = [];
  let team = null;
  if (state.mode === 'classic' || state.mode === 'practice') {
    ranked = all.slice().sort((a, b) => gone(a) - gone(b) || a.itTime - b.itTime || b.tags - a.tags || cmp(a.id, b.id));
    const pool = ranked.filter((p) => p.connected);
    if (pool.length) {
      const best = pool[0].itTime;
      winners = pool.filter((p) => Math.abs(p.itTime - best) < 1e-6 && p.tags === pool[0].tags).map((p) => p.id);
    }
  } else if (state.mode === 'infection') {
    const survivors = all.filter((p) => !p.it && p.connected);
    if (survivors.length > 0) {
      team = 'runners';
      winners = survivors.map((p) => p.id);
    } else {
      team = 'infected';
      winners = all.filter((p) => p.it && p.connected).map((p) => p.id);
    }
    ranked = all.slice().sort((a, b) => gone(a) - gone(b) || Number(a.it) - Number(b.it) || b.aliveTime - a.aliveTime || b.tags - a.tags || cmp(a.id, b.id));
  } else if (state.mode === 'hotpotato') {
    // the last one(s) still holding together win; then whoever exploded LATER ranks higher
    winners = all.filter((p) => !p.out && p.connected).map((p) => p.id);
    const outAt = (p) => (p.out ? p.outAt : Infinity);
    ranked = all.slice().sort((a, b) => {
      const wa = winners.includes(a.id) ? 0 : 1;
      const wb = winners.includes(b.id) ? 0 : 1;
      return wa - wb || gone(a) - gone(b) || (outAt(b) - outAt(a) || 0) || a.itTime - b.itTime || cmp(a.id, b.id);
    });
  } else {
    // elimination, zone
    const alive = all.filter((p) => !p.it && !p.out && p.connected);
    if (alive.length > 0) {
      team = 'runners';
      winners = alive.map((p) => p.id);
    } else {
      team = 'hunters';
      winners = all.filter((p) => p.it && p.connected).map((p) => p.id);
    }
    ranked = all.slice().sort((a, b) => {
      const wa = winners.includes(a.id) ? 0 : 1;
      const wb = winners.includes(b.id) ? 0 : 1;
      return wa - wb || gone(a) - gone(b) || b.aliveTime - a.aliveTime || b.tags - a.tags || cmp(a.id, b.id);
    });
  }
  return {
    reason,
    mode: state.mode,
    duration: state.time,
    team,
    winners,
    ranking: ranked.map((p, i) => ({
      id: p.id,
      name: p.name,
      place: i + 1,
      tags: p.tags,
      tagged: p.tagged,
      itTime: round2(p.itTime),
      survival: round2(p.aliveTime),
      out: p.out,
      it: p.it,
      connected: p.connected,
      dodges: p.perfectDodges,
      coins: p.coinsPicked,
      winner: winners.includes(p.id),
    })),
  };
}

/** Compact snapshot sent over the network / used by the HUD. */
export function snapshot(state) {
  const snap = {
    mode: state.mode,
    phase: state.phase,
    countdown: round2(state.countdown),
    time: round2(state.time),
    duration: state.duration,
    players: state.order.map((id) => {
      const p = state.players[id];
      return { id, it: p.it, out: p.out, tags: p.tags, itTime: round2(p.itTime), alive: round2(p.aliveTime), c: p.connected, fz: round2(Math.max(0, p.frozenUntil - state.time)), pr: round2(Math.max(0, p.protectedUntil - state.time)), bo: round2(Math.max(0, p.boostUntil - state.time)), pd: p.perfectDodges, co: p.coinsPicked, st: round2(p.stormTime) };
    }),
  };
  if (state.potato) snap.potato = { fuse: round2(state.potato.fuse), max: state.potato.max, round: state.potato.round };
  if (state.zone) snap.zone = { ...state.zone };
  return snap;
}

export function timeLeft(state) {
  return state.duration > 0 ? Math.max(0, state.duration - state.time) : Infinity;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// players who left the match are always ranked below everyone still connected
const gone = (p) => (p.connected ? 0 : 1);

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
