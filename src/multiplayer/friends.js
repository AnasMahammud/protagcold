// Friends: a persistent friend code per player, a local friends list, "recently played with",
// live presence from the server and incoming lobby invites.
// No accounts: a friend code identifies this browser profile. The server only reveals the lobby
// code of a private lobby to players who were invited into it.
import { bus } from '../core/events.js';
import { loadJSON, saveJSON } from '../core/storage.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-Z0-9]{6}$/;

function newCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Normalises user input like "ab-c 12d" -> "ABC12D" (returns null if it can't be a code). */
export function normaliseCode(text) {
  const c = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(c) ? c : null;
}

class Friends {
  constructor() {
    this.myCode = loadJSON('friendCode', null);
    if (!this.myCode || !CODE_RE.test(this.myCode)) {
      this.myCode = newCode();
      saveJSON('friendCode', this.myCode);
    }
    this.list = loadJSON('friends', []).filter((f) => f && CODE_RE.test(f.tag));
    this.recent = loadJSON('recentPlayers', []).filter((f) => f && CODE_RE.test(f.tag));
    this.presence = new Map(); // tag -> { online, name, room }
    this.invites = []; // pending invites { from: {name, tag}, room, at }
    this.net = null;
    this.timer = null;
    bus.on('net:friends', (m) => this._onPresence(m.list));
    bus.on('net:invited', (m) => this._onInvite(m));
    bus.on('net:room', (m) => this._noteRoomMates(m.room));
  }

  attach(net) {
    this.net = net;
  }

  get codeFormatted() {
    return `${this.myCode.slice(0, 3)}-${this.myCode.slice(3)}`;
  }

  isFriend(tag) {
    return this.list.some((f) => f.tag === tag);
  }

  add(tag, name = '') {
    const code = normaliseCode(tag);
    if (!code) return { ok: false, msg: 'Friend codes have 6 letters/numbers, e.g. ABC-123.' };
    if (code === this.myCode) return { ok: false, msg: "That's your own friend code." };
    if (this.isFriend(code)) return { ok: false, msg: 'Already in your friends list.' };
    const known = this.recent.find((r) => r.tag === code) || this.presence.get(code);
    this.list.push({ tag: code, name: name || known?.name || '', addedAt: Date.now() });
    saveJSON('friends', this.list);
    bus.emit('friends:changed');
    this.refresh();
    return { ok: true, msg: 'Friend added.' };
  }

  remove(tag) {
    this.list = this.list.filter((f) => f.tag !== tag);
    saveJSON('friends', this.list);
    bus.emit('friends:changed');
  }

  /** Ask the server who is online (cheap; called on a timer while a social screen is open). */
  refresh() {
    if (!this.net || this.net.status !== 'online' || !this.list.length) return false;
    return this.net.send('friends_status', { tags: this.list.map((f) => f.tag) });
  }

  startPolling(ms = 4000) {
    this.stopPolling();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), ms);
  }

  stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }

  status(tag) {
    return this.presence.get(tag) || { online: false };
  }

  invite(tag) {
    return this.net?.send('invite', { tag });
  }

  takeInvite(code) {
    this.invites = this.invites.filter((i) => i.room.code !== code);
    bus.emit('friends:invites');
  }

  _onPresence(list) {
    let changed = false;
    for (const p of list || []) {
      this.presence.set(p.tag, p);
      // remember the latest display name of each friend
      const f = this.list.find((x) => x.tag === p.tag);
      if (f && p.name && f.name !== p.name) {
        f.name = p.name;
        changed = true;
      }
    }
    if (changed) saveJSON('friends', this.list);
    bus.emit('friends:presence');
  }

  _onInvite(m) {
    if (!m?.room?.code || !m.from) return;
    this.invites = this.invites.filter((i) => i.room.code !== m.room.code);
    this.invites.unshift({ from: m.from, room: m.room, at: Date.now() });
    this.invites = this.invites.slice(0, 5);
    bus.emit('friends:invites', m);
  }

  _noteRoomMates(room) {
    if (!room?.players) return;
    let changed = false;
    for (const p of room.players) {
      if (!p.tag || p.tag === this.myCode) continue;
      const i = this.recent.findIndex((r) => r.tag === p.tag);
      if (i >= 0) this.recent.splice(i, 1);
      this.recent.unshift({ tag: p.tag, name: p.name, at: Date.now() });
      changed = true;
    }
    if (changed) {
      this.recent = this.recent.slice(0, 12);
      saveJSON('recentPlayers', this.recent);
    }
  }
}

export const friends = new Friends();
