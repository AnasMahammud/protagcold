// Battle pass: seasons of 30 tiers with a free track for everyone and a Premium track that is
// unlocked with coins earned by playing (PRO TAG has no real-money purchases). Pass XP comes from
// every match (the same XP as levels) plus daily and weekly challenges. Pure functions on the
// profile object, so they are easy to test; progression.js persists the profile.

export const SEASON = {
  id: 's1',
  number: 1,
  name: 'Glitch Season',
  ends: '2026-12-31T23:59:59',
  tierXp: 300,
  premiumPrice: 600,
  // tier n (1-based) -> rewards; { coins } or { item: 'kind:id' }
  rewards: [
    { free: { item: 'title:rookie' }, premium: { item: 'hat:cone' } },
    { free: { coins: 50 }, premium: { item: 'color:toxic' } },
    { free: { item: 'emote:salute' }, premium: { coins: 100 } },
    { free: { coins: 50 }, premium: { item: 'tagfx:glitch' } },
    { free: { item: 'hat:partyhat' }, premium: { item: 'title:chaser' } },
    { free: { coins: 75 }, premium: { item: 'color:chrome' } },
    { free: { item: 'color:peach' }, premium: { coins: 100 } },
    { free: { coins: 50 }, premium: { item: 'trail:glitch' } },
    { free: { coins: 50 }, premium: { item: 'emote:chicken' } },
    { free: { item: 'hat:catears' }, premium: { coins: 150 } },
    { free: { coins: 75 }, premium: { item: 'color:grape' } },
    { free: { coins: 50 }, premium: { item: 'title:glitched' } },
    { free: { item: 'emote:chill' }, premium: { item: 'hat:visor' } },
    { free: { coins: 75 }, premium: { coins: 100 } },
    { free: { item: 'title:untaggable' }, premium: { item: 'trail:gold' } },
    { free: { coins: 50 }, premium: { coins: 100 } },
    { free: { coins: 75 }, premium: { item: 'tagfx:fireworks' } },
    { free: { item: 'color:midnight' }, premium: { coins: 100 } },
    { free: { coins: 50 }, premium: { item: 'hat:propeller' } },
    { free: { coins: 100 }, premium: { item: 'title:potato' } },
    { free: { coins: 50 }, premium: { coins: 150 } },
    { free: { item: 'title:slider' }, premium: { item: 'color:hologram' } },
    { free: { coins: 75 }, premium: { coins: 100 } },
    { free: { coins: 50 }, premium: { item: 'title:scrambler' } },
    { free: { coins: 100 }, premium: { coins: 150 } },
    { free: { coins: 50 }, premium: { item: 'emote:moonwalk' } },
    { free: { coins: 75 }, premium: { coins: 100 } },
    { free: { coins: 100 }, premium: { item: 'title:legend' } },
    { free: { coins: 75 }, premium: { coins: 200 } },
    { free: { item: 'hat:goldcap' }, premium: { item: 'hat:neoncrown' } },
  ],
};
export const TIERS = SEASON.rewards.length;

// ------------------------------------------------------------------ challenges
// stat: what to count from a finished match (see matchStats); mode: only matches of that mode
const DAILY = [
  { id: 'd_play3', text: 'Play 3 matches', stat: 'matches', n: 3 },
  { id: 'd_tags5', text: 'Tag 5 runners', stat: 'tags', n: 5 },
  { id: 'd_survive', text: 'Survive 3 minutes as a runner (in total)', stat: 'survival', n: 180 },
  { id: 'd_coins5', text: 'Grab 5 gold coins', stat: 'coins', n: 5 },
  { id: 'd_win', text: 'Win a match', stat: 'wins', n: 1 },
  { id: 'd_abil5', text: 'Use your abilities 5 times', stat: 'abilities', n: 5 },
  { id: 'd_emote3', text: 'Emote 3 times during matches', stat: 'emotes', n: 3 },
  { id: 'd_potato', text: 'Play a Hot Potato match', stat: 'matches', mode: 'hotpotato', n: 1 },
  { id: 'd_zone', text: 'Play a Shrinking Zone match', stat: 'matches', mode: 'zone', n: 1 },
  { id: 'd_slides', text: 'Ride 2 water slides', stat: 'slides', n: 2 },
  { id: 'd_dodge', text: 'Land a perfect dodge', stat: 'dodges', n: 1 },
  { id: 'd_infect', text: 'Play an Infection match', stat: 'matches', mode: 'infection', n: 1 },
];
const WEEKLY = [
  { id: 'w_play15', text: 'Play 15 matches', stat: 'matches', n: 15 },
  { id: 'w_tags40', text: 'Tag 40 runners', stat: 'tags', n: 40 },
  { id: 'w_wins5', text: 'Win 5 matches', stat: 'wins', n: 5 },
  { id: 'w_coins30', text: 'Grab 30 gold coins', stat: 'coins', n: 30 },
  { id: 'w_dodge5', text: 'Land 5 perfect dodges', stat: 'dodges', n: 5 },
  { id: 'w_scramble', text: 'Scramble 8 players', stat: 'scrambles', n: 8 },
  { id: 'w_survive', text: 'Survive 15 minutes as a runner (in total)', stat: 'survival', n: 900 },
  { id: 'w_abil30', text: 'Use your abilities 30 times', stat: 'abilities', n: 30 },
  { id: 'w_slides10', text: 'Ride 10 water slides', stat: 'slides', n: 10 },
  { id: 'w_potato5', text: 'Play 5 Hot Potato matches', stat: 'matches', mode: 'hotpotato', n: 5 },
];
export const CHALLENGE_XP = { daily: 150, weekly: 600 };
const PER_DAY = 3, PER_WEEK = 4;
const DAY = 86400000;

/** Local calendar day number (days since 1970 in the player's time zone). */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return Math.floor((now - d.getTimezoneOffset() * 60000) / DAY);
}

/** Week number, weeks starting on Monday (local time). */
export function weekKey(now = Date.now()) {
  return Math.floor((dayKey(now) + 3) / 7); // 1970-01-01 was a Thursday
}

function pick(pool, n, seed) {
  // deterministic shuffle: everyone gets the same challenges on the same day
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export function dailyChallenges(day) {
  return pick(DAILY, PER_DAY, day * 7 + 1);
}

export function weeklyChallenges(week) {
  return pick(WEEKLY, PER_WEEK, week * 13 + 5);
}

// ------------------------------------------------------------------ profile state
export function freshPass() {
  return { season: SEASON.id, xp: 0, premium: false, claimed: { free: [], premium: [] }, daily: null, weekly: null };
}

/** Make sure the profile has a pass for the current season and today's / this week's challenges. */
export function ensurePass(profile, now = Date.now()) {
  if (!profile.pass || profile.pass.season !== SEASON.id) profile.pass = freshPass(); // new season: start again
  const pass = profile.pass;
  const d = dayKey(now), w = weekKey(now);
  if (!pass.daily || pass.daily.key !== d) pass.daily = { key: d, list: dailyChallenges(d).map((c) => ({ id: c.id, progress: 0, done: false })) };
  if (!pass.weekly || pass.weekly.key !== w) pass.weekly = { key: w, list: weeklyChallenges(w).map((c) => ({ id: c.id, progress: 0, done: false })) };
  if (!Array.isArray(profile.items)) profile.items = [];
  return pass;
}

export function challengeDef(id) {
  return DAILY.find((c) => c.id === id) || WEEKLY.find((c) => c.id === id) || null;
}

export function seasonOver(now = Date.now()) {
  return now > Date.parse(SEASON.ends);
}

/** { tier (0..TIERS), into (xp into the next tier), need } */
export function tierOf(xp) {
  const tier = Math.min(TIERS, Math.floor(xp / SEASON.tierXp));
  return { tier, into: tier >= TIERS ? SEASON.tierXp : xp - tier * SEASON.tierXp, need: SEASON.tierXp };
}

/**
 * The numbers a finished match contributes to challenges.
 * row: the local player's result row; extra: counters the session kept ({ abilities, emotes, slides, scrambles }).
 */
export function matchStats(result, row, extra = {}) {
  return {
    mode: result.mode,
    matches: 1,
    tags: row?.tags || 0,
    survival: Math.floor(row?.survival || 0), // time spent as a runner
    coins: row?.coins || 0,
    wins: row?.winner ? 1 : 0,
    dodges: row?.dodges || 0,
    abilities: extra.abilities || 0,
    emotes: extra.emotes || 0,
    slides: extra.slides || 0,
    scrambles: extra.scrambles || 0,
  };
}

/**
 * Apply a finished match to the pass: match XP + challenge progress (+ their XP).
 * Returns { xp, tiersBefore, tiersAfter, completed: [{ id, text, xp, kind }] }.
 */
export function applyMatch(profile, matchXp, stats, now = Date.now()) {
  const pass = ensurePass(profile, now);
  const before = tierOf(pass.xp).tier;
  if (seasonOver(now)) return { xp: 0, tiersBefore: before, tiersAfter: before, completed: [] };
  let xp = Math.max(0, Math.round(matchXp || 0));
  const completed = [];
  for (const [kind, set] of [['daily', pass.daily], ['weekly', pass.weekly]]) {
    for (const ch of set.list) {
      if (ch.done) continue;
      const def = challengeDef(ch.id);
      if (!def || (def.mode && def.mode !== stats.mode)) continue;
      ch.progress = Math.min(def.n, ch.progress + (stats[def.stat] || 0));
      if (ch.progress >= def.n) {
        ch.done = true;
        xp += CHALLENGE_XP[kind];
        completed.push({ id: ch.id, text: def.text, xp: CHALLENGE_XP[kind], kind });
      }
    }
  }
  pass.xp += xp;
  return { xp, tiersBefore: before, tiersAfter: tierOf(pass.xp).tier, completed };
}

/** Can this reward be claimed right now? */
export function canClaim(profile, track, tier) {
  const pass = ensurePass(profile);
  const r = SEASON.rewards[tier - 1];
  if (!r || !r[track]) return false;
  if (track === 'premium' && !pass.premium) return false;
  if (tierOf(pass.xp).tier < tier) return false;
  return !pass.claimed[track].includes(tier);
}

/** Claim one reward. Returns { ok, reward } and grants it (coins or an item). */
export function claim(profile, track, tier) {
  if (!canClaim(profile, track, tier)) return { ok: false };
  const reward = SEASON.rewards[tier - 1][track];
  profile.pass.claimed[track].push(tier);
  if (reward.coins) profile.coins = (profile.coins ?? 0) + reward.coins;
  if (reward.item && !profile.items.includes(reward.item)) profile.items.push(reward.item);
  return { ok: true, reward };
}

/** Every reward that can be claimed now: [{ track, tier }]. */
export function claimable(profile) {
  const out = [];
  for (let t = 1; t <= TIERS; t++) for (const track of ['free', 'premium']) if (canClaim(profile, track, t)) out.push({ track, tier: t });
  return out;
}

/** Unlock the Premium track with coins. Rewards for tiers already reached become claimable. */
export function buyPremium(profile) {
  const pass = ensurePass(profile);
  if (pass.premium) return { ok: false, msg: 'You already have the Premium pass.' };
  const have = profile.coins ?? 0;
  if (have < SEASON.premiumPrice) return { ok: false, msg: `You need ${SEASON.premiumPrice - have} more coins.` };
  profile.coins = have - SEASON.premiumPrice;
  pass.premium = true;
  return { ok: true, msg: 'Premium pass unlocked!' };
}
