// XP, levels and lifetime stats (stored locally).
// Offline: XP is computed here from the match result.
// Online: the SERVER computes the award (server/progression.py, same formula) and the client
// only applies what the server sent. Local storage is still editable by the player, so this
// is honest anti-abuse for online matches, not tamper-proof persistence (see docs/LIMITATIONS).

import { loadJSON, saveJSON } from '../core/storage.js';
import { bus } from '../core/events.js';
import { DEFAULT_COSMETICS, HATS, TRAILS, TAG_EFFECTS, EMOTES, COLORS, isUnlocked } from './cosmetics.js';

const DEFAULT_PROFILE = {
  version: 1,
  level: 1,
  xp: 0,
  totalXp: 0,
  cosmetics: DEFAULT_COSMETICS,
  stats: { matches: 0, wins: 0, tags: 0, tagged: 0, survival: 0, longestSurvival: 0, itTime: 0, playTime: 0, online: 0 },
  history: [],
};

export function xpForLevel(level, cfg) {
  return cfg.levelBaseXp + cfg.levelStepXp * (level - 1);
}

/** Pure XP formula (mirrored in server/progression.py). */
export function computeXp(result, playerId, cfg) {
  const row = result.ranking.find((r) => r.id === playerId);
  if (!row) return { total: 0, parts: [] };
  const parts = [];
  parts.push(['Participation', cfg.xpParticipation]);
  if (row.tags) parts.push([`Tags ×${row.tags}`, row.tags * cfg.xpPerTag]);
  const surv = Math.floor(row.survival * cfg.xpPerSurvivalSecond);
  if (surv > 0) parts.push(['Survival', surv]);
  if (row.winner) parts.push(['Victory', cfg.xpWin]);
  else if (row.place <= 3 && result.ranking.length >= 4) parts.push(['Top 3', cfg.xpTop3]);
  const total = parts.reduce((a, [, v]) => a + v, 0);
  return { total, parts };
}

class Progression {
  constructor() {
    const saved = loadJSON('profile', null);
    this.profile = mergeProfile(saved);
  }

  get level() {
    return this.profile.level;
  }

  save() {
    saveJSON('profile', this.profile);
  }

  setCosmetic(key, value) {
    this.profile.cosmetics = { ...this.profile.cosmetics, [key]: value };
    this.save();
    bus.emit('profile:changed', this.profile);
  }

  /**
   * Record a finished match.
   * @param result rules result
   * @param playerId local player's id
   * @param award { total, parts } computed locally (offline) or by the server (online)
   */
  recordMatch(result, playerId, award, cfg, { online = false } = {}) {
    const row = result.ranking.find((r) => r.id === playerId);
    const p = this.profile;
    const before = { level: p.level, unlocks: this.unlockedIds() };
    if (row) {
      p.stats.matches++;
      if (row.winner) p.stats.wins++;
      p.stats.tags += row.tags;
      p.stats.tagged += row.tagged;
      p.stats.survival += row.survival;
      p.stats.itTime += row.itTime;
      p.stats.longestSurvival = Math.max(p.stats.longestSurvival, row.survival);
      if (online) p.stats.online++;
    }
    p.stats.playTime += result.duration;
    p.xp += award.total;
    p.totalXp += award.total;
    while (p.xp >= xpForLevel(p.level, cfg)) {
      p.xp -= xpForLevel(p.level, cfg);
      p.level++;
    }
    p.history.unshift({ at: Date.now(), mode: result.mode, place: row?.place ?? null, winner: !!row?.winner, xp: award.total, tags: row?.tags ?? 0 });
    p.history = p.history.slice(0, 20);
    this.save();
    const after = this.unlockedIds();
    const newUnlocks = after.filter((id) => !before.unlocks.includes(id));
    bus.emit('profile:changed', p);
    return { levelsGained: p.level - before.level, newUnlocks };
  }

  unlockedIds() {
    const ids = [];
    const p = this.profile;
    for (const [k, v] of Object.entries(HATS)) if (isUnlocked(v.unlock, p)) ids.push(`hat:${k}`);
    for (const [k, v] of Object.entries(TRAILS)) if (isUnlocked(v.unlock, p)) ids.push(`trail:${k}`);
    for (const [k, v] of Object.entries(TAG_EFFECTS)) if (isUnlocked(v.unlock, p)) ids.push(`tagfx:${k}`);
    for (const [k, v] of Object.entries(EMOTES)) if (isUnlocked(v.unlock, p)) ids.push(`emote:${k}`);
    for (const c of COLORS) if (isUnlocked(c.unlock, p)) ids.push(`color:${c.id}`);
    return ids;
  }

  emoteUnlocked(id) {
    return isUnlocked(EMOTES[id]?.unlock, this.profile);
  }

  reset() {
    this.profile = mergeProfile(null);
    this.save();
    bus.emit('profile:changed', this.profile);
  }
}

function mergeProfile(saved) {
  const base = structuredClone(DEFAULT_PROFILE);
  if (!saved || typeof saved !== 'object') return base;
  return {
    ...base,
    ...saved,
    cosmetics: { ...base.cosmetics, ...(saved.cosmetics || {}) },
    stats: { ...base.stats, ...(saved.stats || {}) },
    history: Array.isArray(saved.history) ? saved.history : [],
  };
}

export const progression = new Progression();
