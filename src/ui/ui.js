// Menu system and game flow. Every button here performs a real action; there are no
// placeholder screens. Screens are rendered from templates and wired via data-action.
import { bus } from '../core/events.js';
import { settings, ACTIONS, describeCode, DEFAULT_BINDINGS } from '../core/settings.js';
import { loadJSON, saveJSON } from '../core/storage.js';
import { getConfig } from '../core/config.js';
import { audio } from '../audio/audio.js';
import { loadMapIndex } from '../maps/mapLoader.js';
import { LocalMatch } from '../gameplay/localMatch.js';
import { OnlineMatch } from '../multiplayer/onlineMatch.js';
import { progression, xpForLevel } from '../progression/progression.js';
import { HATS, COLORS, TRAILS, TAG_EFFECTS, EMOTES, EMOTE_IDS, TITLES, isUnlocked, describeUnlock } from '../progression/cosmetics.js';
import * as BP from '../progression/battlepass.js';
import { formatSeconds } from '../core/mathUtil.js';
import { Hud, esc } from './hud.js';
import { CharacterPreview } from './preview.js';
import { EndScreenFx, animateResults } from './endScreen.js';
import { friends } from '../multiplayer/friends.js';
import { ABILITY_IDS, ABILITY_INFO } from '../gameplay/abilities.js';
import { abilityIcon, COIN_SVG } from './abilityIcons.js';
import { VERSION, CHANGELOG } from '../core/version.js';

const NEW_EMOTES = new Set(['salute', 'chicken', 'chill', 'moonwalk']); // "NEW" badge in Customise (v1.04)

const MODE_INFO = () => {
  const m = getConfig().modes;
  return ONLINE_MODE_IDS.map((id) => ({ id, name: m[id].name, desc: m[id].short, duration: m[id].duration }));
};
const ONLINE_MODE_IDS = ['classic', 'infection', 'elimination', 'hotpotato', 'zone'];
const ATTRACT_MAPS = ['rooftops', 'docks', 'arena', 'mall', 'waterpark', 'factory'];

export class UI {
  constructor({ game, input, net, touch }) {
    this.game = game;
    this.input = input;
    this.net = net;
    this.touch = touch;
    this.root = document.getElementById('screens');
    this.hud = new Hud(document.getElementById('hud'));
    this.current = null;
    this.stack = [];
    this.maps = [];
    this.inMatch = false;
    this.paused = false;
    this.preview = null;
    this.attractBusy = false;
    this.offline = { mode: 'classic', mapId: 'rooftops', bots: 5, difficulty: 'normal', ...loadJSON('lastOffline', {}) };
    this.practice = { mapId: 'training', bots: 3, difficulty: 'easy', ...loadJSON('lastPractice', {}) };
    this.online = { public: true, mode: 'classic', map: 'rooftops' };
    this.settingsTab = 'audio';
    this.lastResult = null;
    this.matchToken = 0;

    this.root.addEventListener('click', (e) => this._onClick(e));
    this.root.addEventListener('input', (e) => this._onInput(e));
    this.root.addEventListener('change', (e) => this._onInput(e));
    this.root.addEventListener('mouseover', (e) => {
      const t = e.target.closest('.btn, .card, .swatch, .seg button, .tabs button');
      if (t && t !== this._hovered && !t.disabled) {
        this._hovered = t;
        audio.play('uiHover');
      }
    });
    // switch to touch controls the moment a real touch happens during a match
    window.addEventListener('touchstart', () => {
      if (this.inMatch && !this.paused && !this.touch.enabled && !this.game.session?.ended) this.touch.setEnabled(true);
    }, { passive: true });
    document.getElementById('game').addEventListener('click', () => {
      if (this.inMatch && !this.paused && !this.input.pointerLocked) this.input.requestPointerLock();
    });
    bus.on('ui:nav', (dir) => this._nav(dir));
    bus.on('game:pauseToggle', () => (this.paused ? this.resume() : this.pause()));
    bus.on('input:pointerlock', ({ locked }) => {
      // Esc releases pointer lock in the browser itself; treat that as a pause request
      if (!locked && this.inMatch && !this.paused && !this.game.session?.ended && !this.touch.enabled && !this._suppressPause) this.pause();
    });
    bus.on('match:end', (m) => this.onMatchEnd(m));
    bus.on('match:outro', (o) => this.onMatchOutro(o));
    bus.on('net:room', (m) => this.onRoom(m.room));
    bus.on('net:match_start', (m) => this.onOnlineMatchStart(m));
    bus.on('net:error', (m) => this.toast(m.msg || 'Server error', 'error'));
    bus.on('net:kicked', (m) => this.toast(m.msg || 'Removed from room', 'error'));
    bus.on('net:status', () => this._refreshNetPill());
    bus.on('net:closed', ({ wasOnline }) => {
      if (wasOnline && (this.net.room || this.inMatchOnline)) this.toast('Connection lost — reconnecting…', 'error');
    });
    bus.on('net:reconnected', () => {
      this.toast('Reconnected', 'good');
      if (this.lastRoomCode) this.net.send('rejoin', { code: this.lastRoomCode });
    });
    bus.on('net:reconnect_failed', () => {
      this.toast('Could not reconnect to the server', 'error');
      if (this.inMatchOnline) this.leaveMatch(true);
      else if (this.current === 'lobby') this.show('play');
    });
    bus.on('game:error', (err) => this.toast(`Error: ${err.message}`, 'error'));

    // ---- lobbies with friends: chat, lobby browser, presence, invites
    this.chat = { code: null, list: [] };
    this.roomList = null;
    this.pollTimer = null;
    this.expectRoom = false;
    friends.attach(net);
    // keep the server's copy of our name/outfit current (friends and lobbies show it)
    const syncProfile = () => {
      if (this.net.status === 'online') this.net.send('profile', { name: settings.data.player.name, cosm: progression.profile.cosmetics });
    };
    bus.on('settings:changed', ({ path }) => path === 'player.name' && syncProfile());
    bus.on('profile:changed', syncProfile);
    bus.on('net:chat_history', (m) => {
      this.chat = { code: m.code, list: m.list || [] };
      this._renderPart('#chat-log', this.chatHtml(), true);
    });
    bus.on('net:chat', (m) => {
      if (this.chat.code !== m.code) this.chat = { code: m.code, list: [] };
      this.chat.list = [...this.chat.list, m.msg].slice(-60);
      this._appendChat(m.msg);
    });
    bus.on('net:rooms', (m) => {
      this.roomList = m.rooms || [];
      if (this.current === 'browse') this._renderPart('#lobby-list', this.lobbyListHtml());
    });
    bus.on('net:left_room', () => {
      if (this.current === 'lobby' && !this.inMatch) this.show('play', { replace: true });
    });
    bus.on('net:invite_sent', (m) => {
      const who = friends.list.find((f) => f.tag === m.tag)?.name || m.tag;
      this.toast(m.delivered ? `Invite sent to ${who}` : `${who} is offline right now — send them your invite link instead`, m.delivered ? 'good' : '');
    });
    bus.on('friends:presence', () => this._refreshSocial());
    bus.on('friends:changed', () => this._refreshSocial());
    bus.on('friends:invites', (m) => {
      if (m) this._showInvite(friends.invites[0]);
      this._refreshSocial();
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'chat-input') this._sendChat();
      else if (e.target.id === 'friend-code') this.actions.addFriend();
      else if (e.target.id === 'room-name') e.target.blur(); // commits via the change event
    });

    game.onFrame = (dt) => this._frame(dt);
  }

  async init() {
    try {
      this.maps = await loadMapIndex();
    } catch (err) {
      this.fatal(err.message);
      return;
    }
    this.show('main');
    // first launch of a new version: show what changed (once)
    if (loadJSON('lastSeenVersion', null) !== VERSION) this.show('updates');
    // Stay connected in the background (when served by the game server) so friends can see
    // you online and invite you. Failure is silent: offline play never needs the server.
    if (location.protocol.startsWith('http')) {
      this.connectOnline({ silent: true }).then((ok) => ok && this._handleJoinLink());
    }
    await this.ensureAttract();
  }

  /** Invite links look like http://host:8080/?join=ABCDE */
  _handleJoinLink() {
    const params = new URLSearchParams(location.search);
    const code = (params.get('join') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    this.toast(`Joining lobby ${code}…`);
    this.expectRoom = true;
    this.net.send('join_room', { code });
  }

  // ------------------------------------------------------------------ helpers
  toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), 4200);
    if (kind === 'error') audio.play('error');
  }

  fatal(msg) {
    this.root.innerHTML = `<div class="screen center dim"><div class="panel" style="max-width:560px"><h2 class="title">Something went wrong</h2><p class="subtitle">${esc(msg)}</p><button class="btn primary" data-action="reload"><span class="t">Reload</span></button></div></div>`;
  }

  _mapName(id) {
    return this.maps.find((m) => m.id === id)?.name || id;
  }

  async ensureAttract() {
    if (this.inMatch || this.attractBusy) return;
    const s = this.game.session;
    if (s && s.attract) return;
    this.attractBusy = true;
    try {
      const mapId = ATTRACT_MAPS[Math.floor(Math.random() * ATTRACT_MAPS.length)];
      const m = await LocalMatch.create(this.game, { mode: 'classic', mapId, bots: 7, difficulty: 'normal', attract: true });
      if (!this.inMatch) {
        this.game.setSession(m);
        this._envAudio(mapId, true);
      } else {
        m.dispose();
      }
    } catch (err) {
      if (!err.superseded) console.error('[ui] attract mode failed', err);
    } finally {
      this.attractBusy = false;
    }
  }

  _envAudio(mapId, menu) {
    const env = this.game.map?.data?.env || {};
    audio.playMusic(menu ? 'menu' : env.music || 'night');
    audio.setMusicIntensity(menu ? 0.55 : 0.5);
    audio.setAmbience(this.game.map?.data?.theme || null);
  }

  // ------------------------------------------------------------------ navigation
  show(name, opts = {}) {
    if (this.endFx && name !== 'results') {
      // leaving the results: the confetti / rays layer goes too
      this.endFx.dispose();
      this.endFx = null;
    }
    if (this.preview && name !== 'customise') {
      this.preview.dispose();
      this.preview = null;
    }
    if (!opts.replace && this.current && this.current !== name && !['pause', 'results'].includes(this.current)) this.stack.push(this.current);
    this.current = name;
    const fn = this[`screen_${name}`];
    if (!fn) throw new Error(`No screen ${name}`);
    this.root.innerHTML = fn.call(this);
    this[`bind_${name}`]?.call(this);
    // live data for social screens (stopped as soon as another screen is shown)
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (name === 'browse') {
      this.net.send('list_rooms');
      this.pollTimer = setInterval(() => this.net.send('list_rooms'), 3000);
    }
    if (['friends', 'lobby', 'play', 'main'].includes(name)) friends.startPolling(name === 'main' ? 15000 : 4000);
    else friends.stopPolling();
    if (name === 'lobby') {
      const log = this.root.querySelector('#chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
    this._refreshSocial();
    // focus the first control for keyboard/controller users
    if (this.input.lastDevice === 'gamepad') this.root.querySelector('.btn, .card, button')?.focus();
  }

  back() {
    audio.play('uiBack');
    if (this.current === 'lobby') {
      this.net.send('leave_room');
      this.lastRoomCode = null;
      this.stack = this.stack.filter((s) => s !== 'lobby');
    }
    if (this.inMatch && this.paused) {
      this.show('pause', { replace: true });
      return;
    }
    const prev = this.stack.pop() || 'main';
    this.show(prev === this.current ? 'main' : prev, { replace: true });
  }

  hideScreens() {
    this.root.innerHTML = '';
    this.current = null;
  }

  _nav(dir) {
    if (dir === 'back') {
      if (this.current === 'pause') this.resume();
      else if (this.current && this.current !== 'main') this.back();
      return;
    }
    if (dir === 'start' && this.current === 'pause') {
      this.resume();
      return;
    }
    const items = [...this.root.querySelectorAll('button:not(:disabled), input, .card, .swatch')].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const cur = document.activeElement && items.includes(document.activeElement) ? document.activeElement : null;
    if (dir === 'accept') {
      if (cur) cur.click();
      else items[0].focus();
      return;
    }
    if (!cur) {
      items[0].focus();
      return;
    }
    if (cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      const step = Number(cur.step) || 1;
      cur.value = Number(cur.value) + (dir === 'right' ? step : -step);
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null;
    let bd = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const dx = x - cx, dy = y - cy;
      const ok = (dir === 'up' && dy < -4) || (dir === 'down' && dy > 4) || (dir === 'left' && dx < -4) || (dir === 'right' && dx > 4);
      if (!ok) continue;
      const primary = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
      const secondary = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      const d = primary + secondary * 2.5;
      if (d < bd) {
        bd = d;
        best = el;
      }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: 'nearest' });
      audio.play('uiHover');
    }
  }

  _onClick(e) {
    audio.unlock();
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled || t.classList.contains('locked')) return;
    const a = t.dataset.action;
    const fn = this.actions[a];
    if (!fn) {
      console.warn('[ui] unknown action', a);
      return;
    }
    audio.play(a === 'back' ? 'uiBack' : 'uiClick');
    fn.call(this, t, e);
  }

  _onInput(e) {
    const t = e.target;
    if (t.dataset.setting) {
      const v = t.type === 'range' ? Number(t.value) : t.value;
      settings.set(t.dataset.setting, v);
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = fmtSetting(t.dataset.setting, v);
    } else if (t.id === 'name-input' && e.type === 'change') {
      const name = t.value.replace(/[^\w\- ]/g, '').trim().slice(0, 16) || settings.data.player.name;
      settings.set('player.name', name);
      t.value = name;
    } else if (t.id === 'room-name' && e.type === 'change') {
      this.net.send('room_settings', { name: t.value });
    } else if (t.id === 'server-url' && e.type === 'change') {
      this.net.setServerUrl(t.value);
      this.net.disconnect();
      this.toast('Server address saved');
    }
  }

  // ------------------------------------------------------------------ per-frame
  _frame(dt) {
    const s = this.game.session;
    if (this.inMatch && s && !s.attract) {
      const hs = s.hudState();
      this.hud.update(hs, { fps: this.game.fps, resScale: this.game.dynScale, showLockHint: !this.paused && !this.touch.enabled && !this.input.pointerLocked && !s.ended && this.current === null });
      if (this.touch.enabled) this.touch.setCooldowns(hs.abilities);
      const rv = s.rulesView();
      if (rv.timeLeft !== Infinity && rv.phase === 'playing') audio.setMusicIntensity(rv.timeLeft < 30 ? 1 : rv.timeLeft < 70 ? 0.8 : 0.6);
    } else if (this.current) {
      this.input.pollMenuNav(dt);
      if (s?.attract) s.paused = false;
    }
  }

  // ------------------------------------------------------------------ game flow
  async startOffline(opts) {
    audio.unlock();
    const token = ++this.matchToken;
    this.loading('Loading arena…');
    try {
      this.inMatch = true;
      this.inMatchOnline = false;
      const m = await LocalMatch.create(this.game, opts);
      if (token !== this.matchToken) {
        m.dispose();
        return;
      }
      this.game.setSession(m);
      await this._enterMatch();
    } catch (err) {
      if (err.superseded) return; // a newer start replaced this one
      console.error(err);
      this.inMatch = false;
      this.toast(`Could not start match: ${err.message}`, 'error');
      this.show('main', { replace: true });
      this.ensureAttract();
    }
  }

  async onOnlineMatchStart(msg) {
    const token = ++this.matchToken;
    this.loading(`Loading ${this._mapName(msg.map)}…`);
    try {
      this.inMatch = true;
      this.inMatchOnline = true;
      const m = await OnlineMatch.create(this.game, this.net, msg);
      if (token !== this.matchToken) {
        m.dispose();
        return;
      }
      this.game.setSession(m);
      await this._enterMatch();
      // only now: the server starts the countdown once everyone is really ready to play
      this.net.send('loaded', { matchId: msg.matchId, loadout: progression.loadout });
    } catch (err) {
      console.error(err);
      this.inMatch = false;
      this.toast(`Could not load match: ${err.message}`, 'error');
      this.show('lobby', { replace: true });
    }
  }

  async _enterMatch() {
    const s = this.game.session;
    if (this.current !== 'loading') this.loading('Getting ready…');
    else this.root.querySelector('.label').textContent = 'Getting ready…';
    // offline: hold the countdown while shaders compile behind the loading screen
    const offline = !this.inMatchOnline;
    if (offline && s) s.paused = true;
    await this.game.prewarmEffects();
    if (s !== this.game.session || !this.inMatch) return; // left (or restarted) meanwhile
    this.hideScreens();
    this.stack = [];
    this.paused = false;
    this.input.gameplayActive = true;
    this.input.clearEdges();
    this._envAudio(this.game.map.id, false);
    // the map cutscene: a slow spin over the arena, then down to you (the countdown waits for it)
    if (s && settings.data.camera.intro !== false) {
      this.hud.show(false);
      await s.playIntro({ duration: offline ? 6.5 : 5 });
      if (s !== this.game.session || !this.inMatch) return;
    }
    if (offline && s) s.paused = false;
    this.hud.show(true);
    this.input.clearEdges();
    this.touch.setAbilities(this.game.session?.local?.loadout || []);
    this.touch.setEnabled(this.touch.constructor.supported());
    this.input.requestPointerLock();
  }

  loading(msg) {
    this.current = 'loading';
    this.root.innerHTML = `<div class="screen center dim"><div class="stack" style="align-items:center"><div class="spinner"></div><div class="label" style="margin-top:12px">${esc(msg)}</div></div></div>`;
  }

  pause() {
    if (!this.inMatch || this.paused) return;
    this.paused = true;
    const s = this.game.session;
    if (s) {
      if (this.inMatchOnline) s.inputBlocked = true; // online: never pauses the server
      else s.paused = true;
    }
    this.input.gameplayActive = false;
    this.input.exitPointerLock();
    this.show('pause', { replace: true });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const s = this.game.session;
    if (s) {
      s.paused = false;
      s.inputBlocked = false;
    }
    this.hideScreens();
    this.input.gameplayActive = true;
    this.input.clearEdges();
    this.input.requestPointerLock();
  }

  leaveMatch(toMenu = true) {
    this.endFx?.dispose();
    this.endFx = null;
    this.matchToken++;
    this._suppressPause = true;
    this.input.exitPointerLock();
    setTimeout(() => (this._suppressPause = false), 200);
    const wasOnline = this.inMatchOnline;
    this.inMatch = false;
    this.inMatchOnline = false;
    this.paused = false;
    this.input.gameplayActive = false;
    this.hud.show(false);
    this.touch.setEnabled(false);
    this.game.setSession(null);
    audio.stopAllLoops();
    if (wasOnline && !toMenu && this.net.room) {
      this.show('lobby', { replace: true });
    } else {
      if (wasOnline) {
        this.net.send('leave_room');
        this.lastRoomCode = null;
      }
      this.show('main', { replace: true });
    }
    this.ensureAttract();
    audio.playMusic('menu');
  }

  /** The match just ended: the VICTORY / DEFEAT slam (the results follow in a moment). */
  onMatchOutro(o) {
    this.endFx?.dispose();
    this.hud.show(false);
    this.input.exitPointerLock();
    this.endFx = new EndScreenFx(o.won, { title: o.won ? 'VICTORY' : 'DEFEAT', sub: o.sub, place: o.place, total: o.total });
  }

  onMatchEnd(m) {
    this.lastResult = m;
    this.endFx?.toResults();
    this.paused = false;
    this.hud.show(false);
    this._suppressPause = true;
    this.input.exitPointerLock();
    setTimeout(() => (this._suppressPause = false), 200);
    this.input.gameplayActive = false;
    this.touch.setEnabled(false);
    this.show('results', { replace: true });
    if (m.prog.levelsGained > 0) {
      setTimeout(() => {
        audio.play('levelUp');
        this.toast(`Level up! You are now level ${progression.level}`, 'good');
      }, 700);
    }
    if (m.prog.newUnlocks.length) {
      setTimeout(() => {
        audio.play('unlock');
        this.toast(`New unlocks: ${m.prog.newUnlocks.length} — check Customise`, 'good');
      }, 1500);
    }
  }

  onRoom(room) {
    if (!room) return;
    this.lastRoomCode = room.code;
    if (this.current === 'lobby') {
      this._rerenderLobby();
    } else if (!this.inMatch && (this.expectRoom || ['play', 'connecting', 'join', 'browse'].includes(this.current))) {
      this.expectRoom = false;
      this.show('lobby');
    } else if (this.current === 'friends') {
      this._refreshSocial();
    }
    if (room.phase === 'lobby' && this.inMatchOnline && this.game.session?.ended && this.current === 'results') {
      // server has returned the room to its lobby: refresh results buttons
      this.root.querySelector('[data-action="toLobby"]')?.removeAttribute('disabled');
    }
  }

  async connectOnline({ silent = false } = {}) {
    try {
      await this.net.connect({ name: settings.data.player.name, cosmetics: progression.profile.cosmetics, tag: friends.myCode });
      this.net.wantReconnect = true;
      return true;
    } catch (err) {
      if (!silent) this.toast(err.message, 'error');
      return false;
    }
  }

  // ------------------------------------------------------------------ social helpers
  _renderPart(sel, html, scrollToEnd = false) {
    const el = this.root.querySelector(sel);
    if (!el) return;
    el.innerHTML = html;
    if (scrollToEnd) el.scrollTop = el.scrollHeight;
  }

  _refreshSocial() {
    if (this.current === 'friends') {
      this._renderPart('#friends-list', this.friendsListHtml());
      this._renderPart('#invites-list', this.invitesHtml());
      this._renderPart('#recent-list', this.recentHtml());
    } else if (this.current === 'lobby') {
      this._renderPart('#invite-friends', this.inviteFriendsHtml());
    }
    const online = friends.list.filter((f) => friends.status(f.tag).online).length;
    for (const el of this.root.querySelectorAll('.friends-online')) el.textContent = online ? `${online} online` : '';
  }

  /** Re-render the lobby without losing what the player is typing. */
  _rerenderLobby() {
    const chat = this.root.querySelector('#chat-input');
    const name = this.root.querySelector('#room-name');
    const keep = {
      chat: chat?.value || '',
      chatFocus: document.activeElement === chat,
      name: name?.value,
      nameFocus: document.activeElement === name,
    };
    this.root.innerHTML = this.screen_lobby();
    const c2 = this.root.querySelector('#chat-input');
    if (c2) {
      c2.value = keep.chat;
      if (keep.chatFocus) c2.focus();
    }
    const n2 = this.root.querySelector('#room-name');
    if (n2 && keep.nameFocus) {
      n2.value = keep.name;
      n2.focus();
    }
    const log = this.root.querySelector('#chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  _sendChat() {
    const input = this.root.querySelector('#chat-input');
    const text = input?.value.trim();
    if (!text) return;
    this.net.send('chat', { text });
    input.value = '';
  }

  chatLineHtml(m) {
    if (m.system) return `<div class="chat-line sys">${esc(m.text)}</div>`;
    const p = this.net.room?.players.find((x) => x.id === m.id);
    const color = p?.cosm?.primary || '#9fd8ff';
    return `<div class="chat-line ${m.id === this.net.id ? 'mine' : ''}"><b style="color:${esc(color)}">${esc(m.name)}</b> ${esc(m.text)}</div>`;
  }

  chatHtml() {
    const list = this.chat.code === this.net.room?.code ? this.chat.list : [];
    return list.length ? list.map((m) => this.chatLineHtml(m)).join('') : '<div class="chat-line sys">Say hi to your lobby!</div>';
  }

  _appendChat(m) {
    const log = this.root.querySelector('#chat-log');
    if (!log) return;
    if (log.querySelector('.chat-line.sys:only-child')) log.innerHTML = '';
    log.insertAdjacentHTML('beforeend', this.chatLineHtml(m));
    while (log.children.length > 60) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    if (!m.system && m.id !== this.net.id) audio.play('uiHover');
  }

  /** The address a friend should open: a LAN/public address when we are on localhost. */
  inviteBase() {
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
    if (local && this.net.shareUrls.length) return this.net.shareUrls[0];
    return location.origin;
  }

  inviteLink() {
    return `${this.inviteBase()}/?join=${this.net.room?.code || ''}`;
  }

  async copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(okMsg, 'good');
    } catch {
      // clipboard API needs a secure context (https/localhost): fall back to a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (ok) this.toast(okMsg, 'good');
      else window.prompt('Copy this:', text);
    }
  }

  _showInvite(inv) {
    if (!inv) return;
    audio.play('unlock');
    document.getElementById('invite-pop')?.remove();
    const r = inv.room;
    const el = document.createElement('div');
    el.id = 'invite-pop';
    el.className = 'invite-pop panel';
    const where = `${getConfig().modes[r.mode]?.name || r.mode} · ${this._mapName(r.map)} · ${r.players}/${r.max} players`;
    el.innerHTML = `
      <div class="label">Lobby invite</div>
      <div class="invite-title"><b>${esc(inv.from.name)}</b> invited you to <b>${esc(r.name)}</b></div>
      <div class="invite-sub">${esc(where)}</div>
      <div class="row end" style="margin-top:12px">
        <button class="btn small ghost" data-inv="later"><span class="t">Later</span></button>
        <button class="btn small primary" data-inv="join"><span class="t">${this.inMatch ? 'Join after match' : 'Join'}</span></button>
      </div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-inv]');
      if (!b) return;
      el.remove();
      if (b.dataset.inv === 'join') {
        if (this.inMatch) {
          this.toast('Invite saved — open Friends after the match to join.', 'good');
          return;
        }
        friends.takeInvite(r.code);
        this.expectRoom = true;
        this.net.send('join_room', { code: r.code });
      }
    });
    document.body.append(el);
    clearTimeout(this._invTimer);
    this._invTimer = setTimeout(() => el.remove(), 20000);
  }

  _refreshNetPill() {
    const s = this.net.status;
    if (this.current === 'play' && s !== this._playNetStatus && (s === 'online' || s === 'error' || s === 'offline')) {
      // re-render so the online panel shows the right buttons/help for the new status
      const code = this.root.querySelector('#join-code')?.value || '';
      this.show('play', { replace: true });
      const input = this.root.querySelector('#join-code');
      if (input) input.value = code;
      return;
    }
    const pill = this.root.querySelector('.net-pill');
    if (!pill) return;
    pill.className = `net-pill ${s === 'online' ? 'ok' : s === 'connecting' || s === 'reconnecting' ? 'wait' : s === 'error' ? 'bad' : ''}`;
    pill.querySelector('span').textContent = { online: 'Server online', connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Server unreachable', offline: 'Not connected' }[s];
    for (const b of this.root.querySelectorAll('[data-needs-net]')) b.disabled = s !== 'online';
  }

  // ------------------------------------------------------------------ actions
  actions = {
    reload: () => location.reload(),
    back: () => this.back(),
    goto: (t) => this.show(t.dataset.target),
    play: () => this.show('play'),
    practice: () => this.show('practice'),
    selectOffline: (t) => {
      this.offline[t.dataset.key] = t.dataset.value;
      saveJSON('lastOffline', this.offline);
      this.show('play', { replace: true });
    },
    selectPractice: (t) => {
      this.practice[t.dataset.key] = t.dataset.key === 'bots' ? Number(t.dataset.value) : t.dataset.value;
      saveJSON('lastPractice', this.practice);
      this.show('practice', { replace: true });
    },
    botsDelta: (t) => {
      this.offline.bots = Math.max(1, Math.min(9, this.offline.bots + Number(t.dataset.d)));
      saveJSON('lastOffline', this.offline);
      this.show('play', { replace: true });
    },
    startOffline: () => this.startOffline({ ...this.offline, bots: Number(this.offline.bots) }),
    startPractice: () => this.startOffline({ mode: 'practice', mapId: this.practice.mapId, bots: Number(this.practice.bots), difficulty: this.practice.difficulty }),
    connect: async () => {
      if (await this.connectOnline()) this.show('play', { replace: true });
      else this._refreshNetPill();
    },
    quickPlay: async () => {
      if (!(await this.connectOnline())) return;
      this.expectRoom = true;
      this.net.send('quick_play', { mode: this.online.mode, map: this.online.map });
    },
    createRoom: async () => {
      if (!(await this.connectOnline())) return;
      this.expectRoom = true;
      this.net.send('create_room', { public: this.online.public, mode: this.online.mode, map: this.online.map });
    },
    browse: async () => {
      if (!(await this.connectOnline())) return;
      this.roomList = null;
      this.show('browse');
    },
    refreshLobbies: () => this.net.send('list_rooms'),
    joinCode: async (t) => {
      if (!(await this.connectOnline())) return;
      this.expectRoom = true;
      friends.takeInvite(t.dataset.code);
      this.net.send('join_room', { code: t.dataset.code });
    },
    friendsScreen: async () => {
      this.show('friends');
      if (this.net.status !== 'online') await this.connectOnline({ silent: true });
      friends.refresh();
    },
    addFriend: () => {
      const input = this.root.querySelector('#friend-code');
      const res = friends.add(input?.value || '');
      this.toast(res.msg, res.ok ? 'good' : 'error');
      if (res.ok && input) input.value = '';
    },
    addFriendTag: (t) => {
      const res = friends.add(t.dataset.tag, t.dataset.name);
      this.toast(res.ok ? `${t.dataset.name || t.dataset.tag} added to your friends` : res.msg, res.ok ? 'good' : 'error');
      if (this.current === 'lobby') this._rerenderLobby();
    },
    removeFriend: (t) => {
      if (confirm(`Remove ${t.dataset.name || t.dataset.tag} from your friends?`)) friends.remove(t.dataset.tag);
    },
    inviteFriend: (t) => {
      if (!this.net.room) {
        this.toast('Create or join a lobby first, then invite friends.', 'error');
        return;
      }
      friends.invite(t.dataset.tag);
    },
    copyFriendCode: () => this.copyText(friends.codeFormatted, 'Friend code copied'),
    copyRoomCode: () => this.copyText(this.net.room?.code || '', 'Lobby code copied'),
    copyInvite: () => this.copyText(this.inviteLink(), 'Invite link copied — send it to your friends'),
    sendChat: () => this._sendChat(),
    kick: (t) => {
      if (confirm(`Remove ${t.dataset.name} from the lobby?`)) this.net.send('kick', { id: t.dataset.id });
    },
    joinRoom: async () => {
      const code = this.root.querySelector('#join-code')?.value.trim().toUpperCase();
      if (!code || code.length < 4) {
        this.toast('Enter the 5-letter room code', 'error');
        return;
      }
      if (!(await this.connectOnline())) return;
      this.net.send('join_room', { code });
    },
    onlineOpt: (t) => {
      const k = t.dataset.key;
      this.online[k] = k === 'public' ? t.dataset.value === 'true' : t.dataset.value;
      this.show('play', { replace: true });
    },
    ready: () => {
      const me = this.net.room?.players.find((p) => p.id === this.net.id);
      this.net.send('ready', { ready: !me?.ready });
    },
    hostSet: (t) => this.net.send('room_settings', { [t.dataset.key]: t.dataset.value }),
    startOnline: () => this.net.send('start_match'),
    leaveRoom: () => this.back(),
    resume: () => this.resume(),
    restart: () => {
      const opts = this.game.session?.opts;
      if (!opts || this.inMatchOnline) return;
      this.leaveMatchSilently();
      this.startOffline(opts);
    },
    pauseSettings: () => this.show('settings'),
    pauseControls: () => this.show('controls'),
    leaveMatch: () => this.leaveMatch(true),
    toLobby: () => this.leaveMatch(false),
    rematch: () => {
      const m = this.lastResult;
      if (!m) return;
      if (m.online) {
        this.leaveMatch(false);
        this.net.send('ready', { ready: true });
      } else {
        this.leaveMatchSilently();
        this.startOffline(m.opts);
      }
    },
    toMenu: () => this.leaveMatch(true),
    toPlayMenu: () => {
      this.leaveMatch(true);
      this.show('play');
    },
    tab: (t) => {
      this.settingsTab = t.dataset.tab;
      this.show('settings', { replace: true });
    },
    toggle: (t) => {
      const path = t.dataset.setting;
      settings.set(path, !settings.get(path));
      t.classList.toggle('on', settings.get(path));
      if (path === 'accessibility.largeText') document.body.classList.toggle('large-text', settings.get(path));
    },
    seg: (t) => {
      const path = t.dataset.setting;
      const raw = t.dataset.value;
      settings.set(path, isNaN(Number(raw)) ? raw : Number(raw));
      this.show(this.current, { replace: true });
    },
    rebind: (t) => {
      t.classList.add('listening');
      t.textContent = 'Press…';
      this.input.captureNext((code) => {
        if (code) settings.setBinding(t.dataset.bind, Number(t.dataset.idx), code);
        this.show('settings', { replace: true });
      });
    },
    resetBindings: () => {
      settings.set('controls.bindings', structuredClone(DEFAULT_BINDINGS));
      this.show('settings', { replace: true });
    },
    resetSection: (t) => {
      settings.resetSection(t.dataset.section);
      document.body.classList.toggle('large-text', settings.data.accessibility.largeText);
      this.show('settings', { replace: true });
    },
    fullscreen: () => {
      if (document.fullscreenElement) {
        navigator.keyboard?.unlock?.();
        document.exitFullscreen?.();
      } else {
        document.documentElement.requestFullscreen?.()
          // in fullscreen the Keyboard Lock API stops browser shortcuts (e.g. Ctrl+W) from firing mid-game
          .then(() => navigator.keyboard?.lock?.().catch(() => {}))
          .catch(() => this.toast('Fullscreen not available', 'error'));
      }
      setTimeout(() => this.show(this.current, { replace: true }), 250);
    },
    cosmetic: (t) => {
      progression.setCosmetic(t.dataset.key, t.dataset.value);
      this.show('customise', { replace: true });
    },
    previewMode: (t) => this.preview?.setMode(t.dataset.mode),
    updatesSeen: () => {
      saveJSON('lastSeenVersion', VERSION);
      this.back();
    },
    buyAbility: (t) => {
      const res = progression.buyAbility(t.dataset.id);
      if (res.ok) {
        audio.play('purchase');
        this.toast(`${res.msg} Equipped abilities are used with ${describeCode(settings.data.controls.bindings.ability1?.[0])} / ${describeCode(settings.data.controls.bindings.ability2?.[0])}.`, 'good');
      } else {
        audio.play('error');
        this.toast(res.msg, 'error');
      }
      this.show('abilities', { replace: true });
      this.root.querySelector(`[data-card="${t.dataset.id}"]`)?.classList.add('just-bought');
    },
    equipAbility: (t) => {
      const slot = Number(t.dataset.slot);
      const id = t.dataset.id;
      progression.equip(slot, progression.profile.abilities.loadout[slot] === id ? null : id);
      this.show('abilities', { replace: true });
    },
    claimPass: (t) => {
      const r = progression.claimPass(t.dataset.track, Number(t.dataset.tier));
      if (r.ok) this._claimed([r.reward]);
      this.show('pass', { replace: true });
    },
    claimAllPass: () => {
      this._claimed(progression.claimAllPass());
      this.show('pass', { replace: true });
    },
    buyPremium: () => {
      const r = progression.buyPremiumPass();
      audio.play(r.ok ? 'purchase' : 'error');
      this.toast(r.ok ? `${r.msg} Every tier you've reached is ready to claim.` : r.msg, r.ok ? 'good' : 'error');
      this.show('pass', { replace: true });
    },
    resetProfile: () => {
      if (confirm('Reset your level, stats and unlocks? This cannot be undone.')) {
        progression.reset();
        this.show('profile', { replace: true });
      }
    },
  };

  leaveMatchSilently() {
    this.endFx?.dispose();
    this.endFx = null;
    this.matchToken++;
    this.game.setSession(null);
    this.inMatch = false;
    this.hud.show(false);
  }

  // ------------------------------------------------------------------ screens
  screen_main() {
    const p = progression.profile;
    const need = xpForLevel(p.level, getConfig().progression);
    return `
    <div class="screen menu-main">
      <h1 class="logo">Pro Tag<span>Chase · Evade · Tag</span></h1>
      <p class="tagline">Fast parkour tag across neon rooftops, an overgrown mall, a giant waterpark, a toy factory and more. Vault, slide, wall-jump — and don't get caught.</p>
      <div class="menu-list">
        <button class="btn menu-item primary" data-action="play"><span class="t">▶&nbsp; Play</span></button>
        <button class="btn menu-item" data-action="practice"><span class="t">Practice</span></button>
        <button class="btn menu-item" data-action="friendsScreen"><span class="t">Friends</span><span class="badge ready friends-online"></span></button>
        <button class="btn menu-item" data-action="goto" data-target="abilities"><span class="t">Abilities</span><span class="coin-chip">${COIN_SVG}${progression.coins}</span></button>
        <button class="btn menu-item pass-item" data-action="goto" data-target="pass"><span class="t">★ Battle Pass</span><span class="pass-chip">Tier ${BP.tierOf(progression.pass.xp).tier}${BP.claimable(p).length ? ` · <b>${BP.claimable(p).length} to claim</b>` : ''}</span></button>
        <button class="btn menu-item" data-action="goto" data-target="customise"><span class="t">Customise</span></button>
        <button class="btn menu-item" data-action="goto" data-target="profile"><span class="t">Profile</span></button>
        <button class="btn menu-item" data-action="goto" data-target="settings"><span class="t">Settings</span></button>
        <button class="btn menu-item" data-action="goto" data-target="controls"><span class="t">Controls</span></button>
        <button class="btn menu-item" data-action="goto" data-target="updates"><span class="t">What's new</span>${loadJSON('lastSeenVersion', null) !== VERSION ? '<span class="badge new-inline">NEW</span>' : `<span class="ver-chip">v${VERSION}</span>`}</button>
      </div>
      <div class="player-card panel">
        <div class="label">Player</div>
        <div class="row between"><div class="name">${esc(settings.data.player.name)}</div><div class="badge you">LVL ${p.level}</div></div>
        ${p.cosmetics.title && p.cosmetics.title !== 'none' && TITLES[p.cosmetics.title] ? `<div class="ptitle">${esc(TITLES[p.cosmetics.title].name)}</div>` : ''}
        <div class="xpbar"><i style="width:${Math.round((p.xp / need) * 100)}%"></i></div>
        <div class="row between" style="margin-top:6px;font-size:12px;color:var(--muted)"><span>${p.xp} / ${need} XP</span><span>${p.stats.wins} wins · ${p.stats.tags} tags</span></div>
        <div class="row between" style="margin-top:8px"><span class="coin-chip big">${COIN_SVG}${progression.coins}</span><span class="loadout-mini">${progression.loadout.map((id, i) => `<i title="${id ? ABILITY_INFO[id] && getConfig().abilities[id].name : 'Empty slot'}" style="--c:${id ? ABILITY_INFO[id].color : '#555'}">${id ? abilityIcon(id) : ''}<b>${i ? 'R' : 'F'}</b></i>`).join('')}</span></div>
      </div>
      <div class="version">PRO TAG v${VERSION} · <button class="link-btn" data-action="goto" data-target="credits">Credits</button> · ${esc(this.game.glInfo || '')}</div>
    </div>`;
  }

  screen_play() {
    const o = this.offline;
    const modes = MODE_INFO();
    const maps = this.maps;
    const net = this.net.status;
    this._playNetStatus = net;
    const pill = `<span class="net-pill ${net === 'online' ? 'ok' : net === 'error' ? 'bad' : net === 'connecting' ? 'wait' : ''}"><i></i><span>${{ online: 'Server online', connecting: 'Connecting…', error: 'Server unreachable', offline: 'Not connected', reconnecting: 'Reconnecting…' }[net]}</span></span>`;
    const onl = this.online;
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page">
        <h2 class="title">Play</h2>
        <p class="subtitle">Pick a mode and an arena. Offline matches fill up with bots; online rooms are real players on the PRO TAG server.</p>
        <div class="grid2">
          <div class="panel">
            <div class="label">Game mode</div>
            <div class="cards" style="margin:10px 0 18px">
              ${modes.map((m) => `<button class="card ${o.mode === m.id ? 'selected' : ''}" data-action="selectOffline" data-key="mode" data-value="${m.id}"><div class="name">${m.name}</div><div class="desc">${m.desc}</div><div class="desc">${m.duration ? `${Math.round(m.duration / 60)} min` : 'No clock'}</div>${['hotpotato', 'zone'].includes(m.id) ? '<span class="badge new">NEW</span>' : ''}</button>`).join('')}
            </div>
            <div class="label">Arena</div>
            <div class="cards" style="margin:10px 0 18px">
              ${maps.map((m) => `<button class="card ${o.mapId === m.id ? 'selected' : ''}" data-action="selectOffline" data-key="mapId" data-value="${m.id}"><div class="map-swatch ${m.theme}"></div><div class="name">${esc(m.name)}</div></button>`).join('')}
            </div>
          </div>
          <div class="stack">
            <div class="panel">
              <div class="label">Offline vs bots</div>
              <div class="row" style="margin:12px 0">
                <span>Bots</span>
                <button class="btn small ghost" data-action="botsDelta" data-d="-1"><span class="t">−</span></button>
                <b style="min-width:24px;text-align:center;font-size:20px">${o.bots}</b>
                <button class="btn small ghost" data-action="botsDelta" data-d="1"><span class="t">+</span></button>
              </div>
              <div class="seg" style="margin-bottom:16px">
                ${['easy', 'normal', 'hard'].map((d) => `<button class="${o.difficulty === d ? 'on' : ''}" data-action="selectOffline" data-key="difficulty" data-value="${d}">${d}</button>`).join('')}
              </div>
              <button class="btn primary big" style="width:100%" data-action="startOffline"><span class="t">Start offline match</span></button>
            </div>
            <div class="panel">
              <div class="row between"><div class="label">Online with friends</div>${pill}</div>
              ${net === 'online' ? '' : `<p class="subtitle" style="margin:10px 0">Online play needs a PRO TAG website: open your friend's game address, or make your own with <span class="kbd">publish-website.bat</span> (README: "Your own website").</p>`}
              <div class="row" style="margin:12px 0 10px">
                <span class="label" style="margin-right:4px">New lobby</span>
                <div class="seg"><button class="${onl.public ? 'on' : ''}" data-action="onlineOpt" data-key="public" data-value="true">Public</button><button class="${!onl.public ? 'on' : ''}" data-action="onlineOpt" data-key="public" data-value="false">Friends only</button></div>
              </div>
              <div class="row">
                ${net === 'online' ? '' : `<button class="btn cyan" data-action="connect"><span class="t">Connect</span></button>`}
                <button class="btn primary" data-action="createRoom"><span class="t">Create lobby</span></button>
                <button class="btn" data-action="browse"><span class="t">Browse lobbies</span></button>
              </div>
              <div class="row" style="margin-top:10px">
                <button class="btn" data-action="quickPlay"><span class="t">Quick play</span></button>
                <button class="btn" data-action="friendsScreen"><span class="t">Friends</span><span class="badge ready friends-online"></span></button>
              </div>
              <div class="row" style="margin-top:12px">
                <input type="text" id="join-code" class="code" maxlength="5" placeholder="CODE" aria-label="Lobby code" />
                <button class="btn" data-action="joinRoom"><span class="t">Join with code</span></button>
              </div>
              <p class="subtitle" style="margin:12px 0 0;font-size:13px">The host picks the mode and arena inside the lobby. "Friends only" lobbies are hidden from the browser and Quick play — friends join with the code, your invite link, or an invite from the Friends screen.</p>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  bind_play() {
    const input = this.root.querySelector('#join-code');
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.actions.joinRoom();
    });
    if (this.net.status === 'offline') this.connectOnline().then(() => this.current === 'play' && this._refreshNetPill());
  }

  screen_practice() {
    const p = this.practice;
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page panel" style="max-width:820px">
        <h2 class="title">Practice</h2>
        <p class="subtitle">No clock, no pressure. Train vaults, slides, mantles, wall jumps and jump pads, and chase or evade bots. Press <span class="kbd">T</span> in game to swap who is IT.</p>
        <div class="label">Arena</div>
        <div class="cards" style="margin:10px 0 18px">
          ${this.maps.map((m) => `<button class="card ${p.mapId === m.id ? 'selected' : ''}" data-action="selectPractice" data-key="mapId" data-value="${m.id}"><div class="map-swatch ${m.theme}"></div><div class="name">${esc(m.name)}</div><div class="desc">${esc(m.description)}</div></button>`).join('')}
        </div>
        <div class="grid2">
          <div><div class="label">Bots</div><div class="seg" style="margin-top:8px">${[0, 1, 3, 5, 7].map((n) => `<button class="${Number(p.bots) === n ? 'on' : ''}" data-action="selectPractice" data-key="bots" data-value="${n}">${n}</button>`).join('')}</div></div>
          <div><div class="label">Bot difficulty</div><div class="seg" style="margin-top:8px">${['easy', 'normal', 'hard'].map((d) => `<button class="${p.difficulty === d ? 'on' : ''}" data-action="selectPractice" data-key="difficulty" data-value="${d}">${d}</button>`).join('')}</div></div>
        </div>
        <div class="row end" style="margin-top:22px"><button class="btn primary big" data-action="startPractice"><span class="t">Start practice</span></button></div>
      </div>
    </div>`;
  }

  screen_lobby() {
    const room = this.net.room;
    if (!room) {
      if (this.expectRoom) return `<div class="screen center dim"><div class="panel"><div class="spinner"></div></div></div>`;
      return `<div class="screen center dim"><div class="panel" style="max-width:420px"><h2 class="title">Not in a lobby</h2><p class="subtitle">The lobby closed or you left it.</p><button class="btn primary" data-action="play"><span class="t">Back to Play</span></button></div></div>`;
    }
    const me = room.players.find((p) => p.id === this.net.id);
    const isHost = room.host === this.net.id;
    const allReady = room.players.length >= 2 && room.players.every((p) => p.ready);
    const cfg = getConfig();
    const countdown = room.phase === 'starting' ? `<div class="winner-banner" style="font-size:28px;color:var(--sun)">Match starting…</div>` : room.phase === 'playing' ? `<div class="label" style="color:var(--sun)">Match in progress — you will join the next one</div>` : '';
    const localOnly = this.inviteBase().includes('localhost') || this.inviteBase().includes('127.0.0.1');
    const sizes = [];
    for (let n = Math.max(2, room.players.length); n <= cfg.match.maxPlayers; n += n < 6 ? 1 : 2) sizes.push(n);
    if (!sizes.includes(cfg.match.maxPlayers)) sizes.push(cfg.match.maxPlayers);
    const playerRow = (p) => {
      const mine = p.id === this.net.id;
      const addBtn = !mine && p.tag && !friends.isFriend(p.tag) ? `<button class="btn small ghost" data-action="addFriendTag" data-tag="${esc(p.tag)}" data-name="${esc(p.name)}" title="Add as friend"><span class="t">+ Friend</span></button>` : '';
      const kickBtn = isHost && !mine ? `<button class="btn small danger" data-action="kick" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="Remove from lobby"><span class="t">Kick</span></button>` : '';
      return `<div class="prow"><span class="dot" style="background:${esc(p.cosm?.primary || '#888')}"></span><span class="pname">${esc(p.name)} <span class="tagcode">#${esc(p.tag || '')}</span>${TITLES[p.cosm?.title] && p.cosm.title !== 'none' ? `<span class="ptitle">${esc(TITLES[p.cosm.title].name)}</span>` : ''}</span>${p.id === room.host ? '<span class="badge host">Host</span>' : ''}${mine ? '<span class="badge you">You</span>' : ''}${p.connected === false ? '<span class="badge wait">Reconnecting</span>' : ''}<span class="badge ${p.ready ? 'ready' : 'wait'}">${p.ready ? 'Ready' : 'Not ready'}</span>${addBtn}${kickBtn}</div>`;
    };
    return `
    <div class="screen center dim">
      <div class="page" style="max-width:1080px">
        <div class="row between lobby-head">
          <div style="flex:1;min-width:260px">
            ${isHost ? `<input type="text" id="room-name" class="room-name" maxlength="24" value="${esc(room.name)}" aria-label="Lobby name" title="Rename the lobby" />` : `<h2 class="title">${esc(room.name)}</h2>`}
            <p class="subtitle" style="margin:4px 0 0">${room.public ? 'Public lobby — listed in the lobby browser and Quick play.' : 'Friends-only lobby — join with the code, an invite link or an invite.'} Host: <b>${esc(room.players.find((p) => p.id === room.host)?.name || '?')}</b></p>
          </div>
          <div style="text-align:right">
            <div class="label">Lobby code</div>
            <div class="room-code">${esc(room.code)}</div>
            <div class="row end" style="gap:6px">
              <button class="btn small" data-action="copyRoomCode"><span class="t">Copy code</span></button>
              <button class="btn small cyan" data-action="copyInvite"><span class="t">Copy invite link</span></button>
            </div>
          </div>
        </div>
        ${localOnly ? `<p class="subtitle hint-box">Friends can't reach this copy of the game — it only runs on your PC. To play with friends, give them a website: run <span class="kbd">publish-website.bat</span> once (see README "Your own website"), or use <span class="kbd">start-online.bat</span> for a quick temporary link.</p>` : ''}
        <div class="grid2" style="grid-template-columns:1.15fr 1fr;margin-top:14px">
          <div class="stack">
            <div class="panel">
              <div class="row between"><div class="label">Players ${room.players.length}/${room.max}</div><span class="net-pill ok"><i></i><span>Ping ${Math.round(this.net.rtt * 1000)} ms</span></span></div>
              <div class="plist" style="margin-top:12px">${room.players.map(playerRow).join('')}</div>
            </div>
            <div class="panel">
              <div class="label">Lobby chat</div>
              <div class="chat-log" id="chat-log">${this.chatHtml()}</div>
              <div class="row" style="flex-wrap:nowrap">
                <input type="text" id="chat-input" maxlength="140" placeholder="Message the lobby…" aria-label="Chat message" style="flex:1;min-width:0" />
                <button class="btn small" data-action="sendChat"><span class="t">Send</span></button>
              </div>
            </div>
          </div>
          <div class="stack">
            <div class="panel">
              <div class="label">Mode</div>
              <div class="seg" style="margin:8px 0 10px">${ONLINE_MODE_IDS.map((m) => `<button class="${room.mode === m ? 'on' : ''}" ${isHost ? `data-action="hostSet" data-key="mode" data-value="${m}"` : 'disabled'}>${cfg.modes[m].name}</button>`).join('')}</div>
              <div class="desc" style="color:var(--muted);font-size:13px;margin-bottom:12px">${esc(cfg.modes[room.mode]?.short || '')}</div>
              <div class="label">Arena</div>
              <div class="seg" style="margin:8px 0 12px">${this.maps.map((m) => `<button class="${room.map === m.id ? 'on' : ''}" ${isHost ? `data-action="hostSet" data-key="map" data-value="${m.id}"` : 'disabled'}>${esc(m.name)}</button>`).join('')}</div>
              <div class="label">Who can join</div>
              <div class="seg" style="margin:8px 0 12px"><button class="${room.public ? 'on' : ''}" ${isHost ? 'data-action="hostSet" data-key="public" data-value="true"' : 'disabled'}>Public</button><button class="${!room.public ? 'on' : ''}" ${isHost ? 'data-action="hostSet" data-key="public" data-value="false"' : 'disabled'}>Friends only</button></div>
              <div class="label">Lobby size</div>
              <div class="seg" style="margin:8px 0 6px">${sizes.map((n) => `<button class="${room.max === n ? 'on' : ''}" ${isHost ? `data-action="hostSet" data-key="max" data-value="${n}"` : 'disabled'}>${n}</button>`).join('')}</div>
              ${isHost ? '' : '<div class="label" style="color:var(--dim);margin-top:8px">Only the host can change lobby settings.</div>'}
              <!-- BOT CONTROLS -->
              ${countdown}
            </div>
            <div class="panel">
              <div class="row between"><div class="label">Invite friends</div><button class="btn small ghost" data-action="friendsScreen"><span class="t">Manage friends</span></button></div>
              <div id="invite-friends" class="plist" style="margin-top:10px">${this.inviteFriendsHtml()}</div>
            </div>
          </div>
        </div>
        <div class="row between" style="margin-top:18px">
          <button class="btn danger" data-action="leaveRoom"><span class="t">Leave room</span></button>
          <div class="row">
            <button class="btn ${me?.ready ? '' : 'cyan'}" data-action="ready" ${room.phase === 'lobby' || room.phase === 'results' ? '' : 'disabled'}><span class="t">${me?.ready ? 'Unready' : 'Ready up'}</span></button>
            ${isHost ? `<button class="btn primary" data-action="startOnline" ${allReady && room.phase === 'lobby' ? '' : 'disabled'} title="${allReady ? '' : 'Needs at least 2 players, all ready'}"><span class="t">Start match</span></button>` : ''}
          </div>
        </div>
        ${isHost && !allReady ? `<p class="subtitle" style="text-align:right;margin-top:8px">Start unlocks when at least ${cfg.match.minPlayersOnline} players are in and everyone is ready.</p>` : ''}
      </div>
    </div>`;
  }

  screen_browse() {
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page panel" style="max-width:900px">
        <div class="row between">
          <div><h2 class="title">Lobby browser</h2><p class="subtitle" style="margin:0">Public lobbies on this server. Friends-only lobbies don't appear here.</p></div>
          <div class="row"><button class="btn small" data-action="refreshLobbies"><span class="t">Refresh</span></button><button class="btn small primary" data-action="createRoom"><span class="t">Create lobby</span></button></div>
        </div>
        <div id="lobby-list" class="plist" style="margin-top:16px">${this.lobbyListHtml()}</div>
      </div>
    </div>`;
  }

  lobbyListHtml() {
    if (this.roomList === null) return '<div class="prow"><div class="spinner" style="width:20px;height:20px;border-width:3px"></div><span class="pname">Looking for lobbies…</span></div>';
    if (!this.roomList.length) return '<div class="prow empty"><span class="pname">No public lobbies right now. Create one and invite your friends!</span></div>';
    const cfg = getConfig();
    return this.roomList.map((r) => {
      const full = r.players >= r.max;
      const state = r.phase === 'lobby' ? (full ? 'Full' : 'Open') : r.phase === 'results' ? 'Results' : 'In match';
      return `<div class="prow lobby-row">
        <div class="pname"><b>${esc(r.name)}</b><div class="desc">Host ${esc(r.host)} · ${esc(cfg.modes[r.mode]?.name || r.mode)} · ${esc(this._mapName(r.map))}</div></div>
        <span class="badge ${r.phase === 'lobby' && !full ? 'ready' : 'wait'}">${state}</span>
        <span class="badge you">${r.players}/${r.max}</span>
        <button class="btn small ${full ? '' : 'primary'}" data-action="joinCode" data-code="${esc(r.code)}" ${full ? 'disabled' : ''}><span class="t">Join</span></button>
      </div>`;
    }).join('');
  }

  screen_friends() {
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page" style="max-width:980px">
        <h2 class="title">Friends</h2>
        <p class="subtitle">Swap friend codes once — after that you can see when friends are online, invite them to your lobby, or jump into theirs.</p>
        <div class="grid2" style="grid-template-columns:1fr 1.25fr">
          <div class="stack">
            <div class="panel">
              <div class="label">Your friend code</div>
              <div class="row between" style="margin-top:6px">
                <div class="room-code" style="font-size:34px">${esc(friends.codeFormatted)}</div>
                <button class="btn small cyan" data-action="copyFriendCode"><span class="t">Copy</span></button>
              </div>
              <p class="subtitle" style="font-size:13px;margin:8px 0 0">Give this to friends so they can add you. It stays the same on this device.</p>
            </div>
            <div class="panel">
              <div class="label">Add a friend</div>
              <div class="row" style="margin-top:8px;flex-wrap:nowrap">
                <input type="text" id="friend-code" maxlength="9" placeholder="ABC-123" aria-label="Friend code" style="flex:1;min-width:0;text-transform:uppercase;letter-spacing:.15em" />
                <button class="btn primary" data-action="addFriend"><span class="t">Add</span></button>
              </div>
            </div>
            <div class="panel">
              <div class="label">Invites</div>
              <div id="invites-list" class="plist" style="margin-top:8px">${this.invitesHtml()}</div>
            </div>
          </div>
          <div class="stack">
            <div class="panel">
              <div class="row between"><div class="label">Friends</div><span class="badge ready friends-online"></span></div>
              <div id="friends-list" class="plist" style="margin-top:10px">${this.friendsListHtml()}</div>
            </div>
            <div class="panel">
              <div class="label">Recently played with</div>
              <div id="recent-list" class="plist" style="margin-top:10px">${this.recentHtml()}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  friendStatusHtml(st) {
    if (this.net.status !== 'online') return '<span class="presence off"></span><span class="desc">Not connected to the server</span>';
    if (!st.online) return '<span class="presence off"></span><span class="desc">Offline</span>';
    if (!st.room) return '<span class="presence on"></span><span class="desc">Online — in the menus</span>';
    const r = st.room;
    const where = r.phase === 'lobby' ? 'in lobby' : r.phase === 'results' ? 'finishing a match in' : 'playing in';
    return `<span class="presence busy"></span><span class="desc">${where} <b>${esc(r.name)}</b> (${r.players}/${r.max})${r.code ? '' : ' · friends-only'}</span>`;
  }

  friendsListHtml() {
    if (!friends.list.length) return '<div class="prow empty"><span class="pname">No friends yet. Add a friend code, or press "+ Friend" next to a player in a lobby.</span></div>';
    const order = (f) => {
      const st = friends.status(f.tag);
      return st.online ? (st.room ? 0 : 1) : 2;
    };
    return friends.list.slice().sort((a, b) => order(a) - order(b) || (a.name || a.tag).localeCompare(b.name || b.tag)).map((f) => {
      const st = friends.status(f.tag);
      const inMyRoom = st.room && this.net.room && st.room.code === this.net.room.code;
      let btn = '';
      if (inMyRoom) btn = '<span class="badge you">In your lobby</span>';
      else if (st.room?.code && st.room.players < st.room.max) btn = `<button class="btn small primary" data-action="joinCode" data-code="${esc(st.room.code)}"><span class="t">Join</span></button>`;
      if (st.online && this.net.room && !inMyRoom) btn += `<button class="btn small cyan" data-action="inviteFriend" data-tag="${esc(f.tag)}"><span class="t">Invite</span></button>`;
      return `<div class="prow friend-row">
        <div class="pname"><b>${esc(f.name || 'Friend')}</b> <span class="tagcode">#${esc(f.tag)}</span><div class="status-line">${this.friendStatusHtml(st)}</div></div>
        ${btn}
        <button class="btn small ghost" data-action="removeFriend" data-tag="${esc(f.tag)}" data-name="${esc(f.name || '')}" title="Remove friend"><span class="t">✕</span></button>
      </div>`;
    }).join('');
  }

  invitesHtml() {
    if (!friends.invites.length) return '<div class="prow empty"><span class="pname">No pending invites.</span></div>';
    return friends.invites.map((i) => `<div class="prow">
      <div class="pname"><b>${esc(i.from.name)}</b> invited you to <b>${esc(i.room.name)}</b><div class="desc">${esc(getConfig().modes[i.room.mode]?.name || '')} · ${esc(this._mapName(i.room.map))}</div></div>
      <button class="btn small primary" data-action="joinCode" data-code="${esc(i.room.code)}"><span class="t">Join</span></button>
    </div>`).join('');
  }

  recentHtml() {
    const list = friends.recent.filter((r) => !friends.isFriend(r.tag));
    if (!list.length) return '<div class="prow empty"><span class="pname">Players you meet in lobbies show up here.</span></div>';
    return list.map((r) => `<div class="prow">
      <div class="pname"><b>${esc(r.name)}</b> <span class="tagcode">#${esc(r.tag)}</span></div>
      <button class="btn small" data-action="addFriendTag" data-tag="${esc(r.tag)}" data-name="${esc(r.name)}"><span class="t">+ Friend</span></button>
    </div>`).join('');
  }

  inviteFriendsHtml() {
    if (!friends.list.length) return '<div class="prow empty"><span class="pname">Add friends (Friends screen) to invite them here — or just send the invite link.</span></div>';
    const room = this.net.room;
    const rows = friends.list.map((f) => {
      const st = friends.status(f.tag);
      const here = st.room && room && st.room.code === room.code;
      const btn = here ? '<span class="badge you">Here</span>' : st.online ? `<button class="btn small cyan" data-action="inviteFriend" data-tag="${esc(f.tag)}"><span class="t">Invite</span></button>` : '<span class="badge wait">Offline</span>';
      return { online: st.online ? 1 : 0, html: `<div class="prow"><span class="presence ${st.online ? (st.room ? 'busy' : 'on') : 'off'}"></span><span class="pname">${esc(f.name || f.tag)}</span>${btn}</div>` };
    });
    return rows.sort((a, b) => b.online - a.online).map((r) => r.html).join('');
  }

  screen_pause() {
    const online = this.inMatchOnline;
    return `
    <div class="screen center dim">
      <div class="panel" style="width:min(420px,92vw)">
        <h2 class="title">Paused</h2>
        <p class="subtitle">${online ? 'Online match — the game keeps running for everyone else.' : 'The match is paused.'}</p>
        <div class="stack">
          <button class="btn primary" data-action="resume"><span class="t">Resume</span></button>
          <button class="btn" data-action="pauseSettings"><span class="t">Settings</span></button>
          <button class="btn" data-action="pauseControls"><span class="t">Controls</span></button>
          ${online ? '<button class="btn" data-action="toLobby"><span class="t">Return to lobby</span></button>' : '<button class="btn" data-action="restart"><span class="t">Restart match</span></button>'}
          <button class="btn danger" data-action="leaveMatch"><span class="t">Leave match</span></button>
        </div>
      </div>
    </div>`;
  }

  screen_results() {
    const m = this.lastResult;
    const r = m.result;
    const me = r.ranking.find((x) => x.id === m.localId);
    const won = r.winners.includes(m.localId);
    const winnersNames = r.ranking.filter((x) => x.winner).map((x) => x.name);
    let headline = won ? 'You won the match' : 'Better luck next time';
    if (r.mode === 'infection') headline = r.team === 'runners' ? (won ? 'You survived the infection!' : 'The runners held out') : won ? 'The infection spread to everyone' : 'You were infected';
    if (r.mode === 'hotpotato') headline = won ? 'Last one standing!' : me?.out ? 'You exploded' : 'The potato got you';
    if (r.mode === 'elimination' || r.mode === 'zone') headline = won ? 'Last runner standing!' : me?.out ? 'You were knocked out' : 'So close';
    const p = progression.profile;
    const cfg = getConfig();
    const need = xpForLevel(p.level, cfg.progression);
    const xpBefore = m.prog.levelsGained ? 0 : Math.max(0, p.xp - m.award.total);
    const session = this.game.session;
    const colorOf = (id) => session?.players?.get(id)?.cosmetics?.primary || '#8a93a6';
    const stat = (x) => (r.mode === 'classic' ? `${formatSeconds(x.itTime)} as IT` : r.mode === 'hotpotato' ? (x.out ? 'Exploded' : 'Survived') : `${x.tags} tag${x.tags === 1 ? '' : 's'}`);
    const cols = r.mode === 'classic' ? ['Tags', 'Time as IT', 'Survived'] : r.mode === 'infection' ? ['Tags', 'Survived', 'Status'] : r.mode === 'hotpotato' ? ['Passes', 'Held the potato', 'Status'] : ['Eliminations', 'Survived', 'Status'];
    const rowCells = (x) => {
      if (r.mode === 'classic') return `<td>${x.tags}</td><td>${formatSeconds(x.itTime)}</td><td>${formatSeconds(x.survival)}</td>`;
      if (r.mode === 'hotpotato') return `<td>${x.tags}</td><td>${formatSeconds(x.itTime)}</td><td>${x.out ? 'Exploded' : 'Survived'}</td>`;
      const status = x.it ? (r.mode === 'infection' ? 'Infected' : 'Hunter') : x.out ? 'Eliminated' : 'Survived';
      return `<td>${x.tags}</td><td>${formatSeconds(x.survival)}</td><td>${status}</td>`;
    };
    // podium: 2nd, 1st, 3rd
    const top = r.ranking.slice(0, 3);
    const order = [top[1], top[0], top[2]];
    const podium = order.map((x, i) => {
      if (!x) return '<div class="pod empty"></div>';
      const place = x.place;
      const h = place === 1 ? 108 : place === 2 ? 78 : 56;
      const d = [0.55, 0.85, 0.35][i];
      return `<div class="pod p${place} ${x.id === m.localId ? 'me' : ''}" style="--c:${esc(colorOf(x.id))};--h:${h}px;--d:${d}s">
        <div class="pod-av">${place === 1 ? '<i class="pod-crown">👑</i>' : ''}</div>
        <div class="pod-name">${esc(x.name)}</div>
        <div class="pod-stat">${esc(stat(x))}</div>
        <div class="pod-block"><span>${place}</span></div>
      </div>`;
    }).join('');
    return `
    <div class="screen results-screen ${won ? 'win' : 'lose'}">
      <div class="rs-wrap">
        <header class="rs-head">
          <div class="rs-meta">${esc(cfg.modes[r.mode]?.name || r.mode)} · ${esc(this._mapName(m.opts?.mapId))} · ${formatSeconds(r.duration)}</div>
          <h1 class="rs-title" data-text="${won ? 'VICTORY' : 'DEFEAT'}">${won ? 'VICTORY' : 'DEFEAT'}</h1>
          <div class="rs-sub"><b>${esc(headline)}</b>${me ? ` · You placed <b>#${me.place}</b> of ${r.ranking.length}` : ''} · Winner${winnersNames.length > 1 ? 's' : ''}: ${esc(winnersNames.join(', ') || '—')}</div>
        </header>
        <div class="rs-grid">
          <section class="rs-card rs-podium" style="--d:0.15s">
            <div class="podium">${podium}</div>
            <table class="results">
              <tr><th>#</th><th>Player</th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>
              ${r.ranking.map((x, n) => `<tr class="${x.id === m.localId ? 'me' : ''} ${x.winner ? 'winner' : ''}" style="--n:${n}"><td>${x.place}</td><td><span class="rs-dot" style="background:${esc(colorOf(x.id))}"></span>${esc(x.name)}${x.connected ? '' : ' <span class="badge wait">left</span>'}</td>${rowCells(x)}</tr>`).join('')}
            </table>
          </section>
          <section class="rs-side">
            <div class="rs-card rs-stats" style="--d:0.25s">
              <div class="rs-tile"><b data-count="${me?.place ?? 0}" data-pre="#">#0</b><span>Place</span></div>
              <div class="rs-tile"><b data-count="${me?.tags ?? 0}" data-delay="100">0</b><span>Tags</span></div>
              <div class="rs-tile"><b>${me ? formatSeconds(me.survival) : '—'}</b><span>Survived</span></div>
              <div class="rs-tile"><b>${me ? formatSeconds(me.itTime) : '—'}</b><span>Time as IT</span></div>
            </div>
            <div class="rs-card rs-xp" style="--d:0.35s">
              <div class="row between"><div class="label">XP earned</div><b class="rs-big xp" data-count="${m.award.total}" data-pre="+" data-delay="300">+0</b></div>
              <div class="rs-lines">${m.award.parts.map(([k, v], i) => `<div style="--n:${i}"><span>${esc(k)}</span><b>+${v}</b></div>`).join('')}</div>
              <div class="row between" style="font-size:13px"><span>Level ${p.level}${m.prog.levelsGained ? ' <span class="badge ready lvl-up">LEVEL UP!</span>' : ''}</span><span style="color:var(--muted)">${p.xp}/${need}</span></div>
              <div class="xpbar rs-bar"><i style="width:${Math.round((xpBefore / need) * 100)}%" data-fill="${Math.round((p.xp / need) * 100)}"></i></div>
              ${m.online ? '<div class="label" style="margin-top:8px;color:var(--dim)">XP and coins awarded by the server</div>' : ''}
            </div>
            ${this._passResults(m.prog?.pass)}
            <div class="rs-card rs-coins" style="--d:0.55s">
              <div class="row between"><div class="label">Coins earned</div><b class="rs-big coin">${COIN_SVG}<span data-count="${m.award.coins || 0}" data-pre="+" data-delay="600">+0</span></b></div>
              <div class="rs-lines coin-lines">${(m.award.coinParts || []).map(([k, v], i) => `<div style="--n:${i}"><span>${esc(k)}</span><b>+${v}</b></div>`).join('')}</div>
              <div class="row between" style="font-size:13px"><span>Balance: <b style="color:var(--sun)">${progression.coins}</b></span>${this._affordable() ? '<span class="badge host">Something new is affordable!</span>' : ''}</div>
            </div>
            <div class="rs-actions" style="--d:0.7s">
              <button class="btn primary rs-rematch" data-action="rematch"><span class="t">${m.online ? 'Ready for rematch' : 'Rematch'}</span></button>
              ${m.online ? '<button class="btn" data-action="toLobby"><span class="t">Return to lobby</span></button>' : '<button class="btn" data-action="toPlayMenu"><span class="t">Change mode / arena</span></button>'}
              ${m.online ? '' : '<button class="btn" data-action="goto" data-target="abilities"><span class="t">Ability shop</span></button>'}
              <button class="btn ghost" data-action="toMenu"><span class="t">Main menu</span></button>
            </div>
          </section>
        </div>
      </div>
    </div>`;
  }

  bind_results() {
    animateResults(this.root);
  }

  /** Battle Pass panel on the results screen. */
  _passResults(res) {
    if (!res) return '';
    const { tier, into, need } = BP.tierOf(progression.pass.xp);
    const up = res.tiersAfter - res.tiersBefore;
    const before = up > 0 ? 0 : Math.max(0, into - res.xp);
    return `<div class="rs-card pass-result" style="--d:0.45s">
      <div class="row between"><div class="label">★ Battle Pass</div><b class="rs-big pass" data-count="${res.xp}" data-pre="+" data-delay="450">+0</b></div>
      ${res.completed.map((c, i) => `<div class="pass-done" style="--n:${i}">✓ ${esc(c.text)} <b>+${c.xp}</b></div>`).join('')}
      <div class="row between" style="font-size:13px;margin-top:8px"><span>Tier ${tier}${up > 0 ? ` <span class="badge ready lvl-up">+${up} TIER${up > 1 ? 'S' : ''}</span>` : ''}</span><span style="color:var(--muted)">${tier >= BP.TIERS ? 'Complete' : `${into}/${need}`}</span></div>
      <div class="xpbar pass-bar rs-bar"><i style="width:${Math.round((before / need) * 100)}%" data-fill="${Math.round((into / need) * 100)}"></i></div>
      ${BP.claimable(progression.profile).length ? '<button class="btn small" data-action="goto" data-target="pass" style="margin-top:10px"><span class="t">Rewards to claim →</span></button>' : ''}
    </div>`;
  }

  /** True when some locked ability is within the player's budget. */
  _affordable() {
    const A = getConfig().abilities;
    return ABILITY_IDS.some((id) => !progression.owns(id) && A[id].price <= progression.coins);
  }

  screen_abilities() {
    const A = getConfig().abilities;
    const C = getConfig().coins;
    const lo = progression.profile.abilities.loadout;
    const keys = [0, 1].map((i) => describeCode(settings.data.controls.bindings[i ? 'ability2' : 'ability1']?.[0]));
    const slot = (i) => {
      const id = lo[i] && progression.owns(lo[i]) ? lo[i] : null;
      return `<div class="ld-slot ${id ? '' : 'empty'}" style="--c:${id ? ABILITY_INFO[id].color : '#556'}"><span class="key">${esc(keys[i])}</span><div class="ico">${id ? abilityIcon(id) : ''}</div><div><div class="label">Slot ${i + 1}</div><b>${id ? esc(A[id].name) : 'Empty'}</b></div></div>`;
    };
    const stat = (id) => {
      const a = A[id];
      const bits = [`${a.cooldown}s cooldown`];
      if (a.range) bits.push(`${a.range} m range`);
      if (a.duration) bits.push(`${a.duration}s`);
      if (a.radius) bits.push(`${a.radius} m radius`);
      return bits.join(' · ');
    };
    const card = (id) => {
      const a = A[id];
      const info = ABILITY_INFO[id];
      const owned = progression.owns(id);
      const short = a.price - progression.coins;
      const eq = lo.indexOf(id);
      let actions;
      if (!owned) {
        actions = short > 0
          ? `<button class="btn small" disabled><span class="t">${COIN_SVG} ${a.price} · need ${short} more</span></button>`
          : `<button class="btn small primary" data-action="buyAbility" data-id="${id}"><span class="t">Unlock · ${COIN_SVG} ${a.price}</span></button>`;
      } else {
        actions = [0, 1].map((i) => `<button class="btn small ${eq === i ? 'on' : ''}" data-action="equipAbility" data-id="${id}" data-slot="${i}"><span class="t">${eq === i ? '✓ ' : ''}Slot ${i + 1} (${esc(keys[i])})</span></button>`).join('');
      }
      return `<div class="ab-card ${owned ? 'owned' : short > 0 ? 'locked' : 'buyable'} ${eq >= 0 ? 'equipped' : ''}" data-card="${id}" style="--c:${info.color}">
        <div class="ab-top"><div class="ico">${abilityIcon(id)}</div><div><div class="name">${esc(a.name)}${id === 'scramble' && !owned ? ' <span class="badge new">NEW</span>' : ''}</div><div class="meta">${stat(id)}</div></div>${owned ? `<span class="badge ${eq >= 0 ? 'ready' : 'wait'}">${eq >= 0 ? `ON ${esc(keys[eq])}` : 'OWNED'}</span>` : ''}</div>
        <p class="desc">${esc(info.desc)}</p>
        <div class="row ab-actions">${actions}</div>
      </div>`;
    };
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page" style="max-width:1080px">
        <div class="row between shop-head">
          <div><h2 class="title">Abilities</h2><p class="subtitle">Unlock abilities with coins and equip two. Earn coins every match: tags, survival, wins, perfect dodges (+${C.perPerfectDodge}) and the gold coins scattered around each arena (+${C.perPickup} each, mostly up high).</p></div>
          <div class="coin-balance">${COIN_SVG}<b>${progression.coins}</b><span>coins</span></div>
        </div>
        <div class="loadout-bar">${slot(0)}${slot(1)}<p class="subtitle">Bots use abilities too (Normal: one, Hard: two). Online, the server checks every ability.</p></div>
        <div class="ab-grid">${ABILITY_IDS.map(card).join('')}</div>
      </div>
    </div>`;
  }

  screen_customise() {
    const prof = progression.profile;
    const c = prof.cosmetics;
    const colorRow = (key) => `<div class="swatches">${COLORS.map((col) => {
      const ok = isUnlocked(col.unlock, prof);
      return `<button class="swatch ${c[key] === col.hex ? 'selected' : ''} ${ok ? '' : 'locked'}" style="background:${col.hex}" title="${ok ? col.id : describeUnlock(col.unlock)}" ${ok ? `data-action="cosmetic" data-key="${key}" data-value="${col.hex}"` : ''}></button>`;
    }).join('')}</div>`;
    const cardSet = (key, cat) => `<div class="cards">${Object.entries(cat).map(([id, v]) => {
      const ok = isUnlocked(v.unlock, prof);
      return `<button class="card ${c[key] === id ? 'selected' : ''} ${ok ? '' : 'locked'}" ${ok ? `data-action="cosmetic" data-key="${key}" data-value="${id}"` : ''}><div class="name">${esc(v.name)}</div>${ok ? '' : `<div class="lock">🔒 ${describeUnlock(v.unlock)}</div>`}</button>`;
    }).join('')}</div>`;
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page">
        <h2 class="title">Customise</h2>
        <p class="subtitle">Cosmetics are purely visual — they never change speed, size or hitboxes. Unlock more by levelling up and through achievements.</p>
        <div class="grid2" style="grid-template-columns:1fr 1.3fr">
          <div class="panel">
            <canvas id="preview-canvas"></canvas>
            <div class="row" style="margin-top:12px">
              <button class="btn small" data-action="previewMode" data-mode="idle"><span class="t">Idle</span></button>
              <button class="btn small" data-action="previewMode" data-mode="run"><span class="t">Run</span></button>
              ${Object.entries(EMOTES).map(([id, e]) => (progression.emoteUnlocked(id) ? `<button class="btn small" data-action="previewMode" data-mode="${id}"><span class="t">${e.name}</span></button>` : '')).join('')}
            </div>
            <div class="field" style="margin-top:16px"><label class="label" for="name-input">Display name</label><input type="text" id="name-input" maxlength="16" value="${esc(settings.data.player.name)}" /></div>
          </div>
          <div class="panel">
            <div class="label">Suit colour</div>${colorRow('primary')}
            <div class="label" style="margin-top:14px">Trim colour</div>${colorRow('secondary')}
            <div class="label" style="margin-top:14px">Accent glow</div>${colorRow('accent')}
            <div class="label" style="margin-top:16px">Headwear</div>${cardSet('hat', HATS)}
            <div class="label" style="margin-top:16px">Trail</div>${cardSet('trail', TRAILS)}
            <div class="label" style="margin-top:16px">Tag effect</div>${cardSet('tagEffect', TAG_EFFECTS)}
            <div class="label" style="margin-top:16px">Title</div>${cardSet('title', TITLES)}
            <div class="label" style="margin-top:16px">Emotes <span style="color:var(--dim)">(keys 1–9, 0)</span></div>
            <div class="cards">${EMOTE_IDS.map((id, i) => {
              const e = EMOTES[id];
              const ok = isUnlocked(e.unlock, prof);
              const key = describeCode(settings.data.controls.bindings[`emote${i + 1}`]?.[0]);
              return `<div class="card ${ok ? '' : 'locked'}"><div class="name">${e.name}${NEW_EMOTES.has(id) ? ' <span class="badge new">NEW</span>' : ''}</div>${ok ? `<div class="desc">Key ${esc(key)}</div>` : `<div class="lock">🔒 ${describeUnlock(e.unlock)}</div>`}</div>`;
            }).join('')}</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  bind_customise() {
    const canvas = this.root.querySelector('#preview-canvas');
    try {
      this.preview = new CharacterPreview(canvas);
      this.preview.setCosmetics(progression.profile.cosmetics);
      this.preview.start();
    } catch (err) {
      console.warn('[ui] preview unavailable', err);
    }
  }

  screen_profile() {
    const p = progression.profile;
    const s = p.stats;
    const need = xpForLevel(p.level, getConfig().progression);
    const unlocked = progression.unlockedIds().length;
    const total = Object.keys(HATS).length + Object.keys(TRAILS).length + Object.keys(TAG_EFFECTS).length + Object.keys(EMOTES).length + COLORS.length;
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page panel" style="max-width:900px">
        <div class="row between">
          <div><h2 class="title">${esc(settings.data.player.name)}</h2><p class="subtitle">Level ${p.level} · ${p.totalXp} lifetime XP · ${unlocked}/${total} cosmetics unlocked</p></div>
          <div class="badge you" style="font-size:18px;padding:8px 14px">LVL ${p.level}</div>
        </div>
        <div class="xpbar"><i style="width:${Math.round((p.xp / need) * 100)}%"></i></div>
        <div style="font-size:12px;color:var(--muted);margin:6px 0 20px">${p.xp} / ${need} XP to level ${p.level + 1}</div>
        <div class="stat-grid">
          <div class="stat"><div class="v">${s.matches}</div><div class="k">Matches</div></div>
          <div class="stat"><div class="v">${s.wins}</div><div class="k">Wins</div></div>
          <div class="stat"><div class="v">${s.matches ? Math.round((s.wins / s.matches) * 100) : 0}%</div><div class="k">Win rate</div></div>
          <div class="stat"><div class="v">${s.tags}</div><div class="k">Lifetime tags</div></div>
          <div class="stat"><div class="v">${s.tagged}</div><div class="k">Times tagged</div></div>
          <div class="stat"><div class="v">${formatSeconds(s.longestSurvival)}</div><div class="k">Best survival</div></div>
          <div class="stat"><div class="v">${Math.round(s.survival / 60)}m</div><div class="k">Total survival</div></div>
          <div class="stat"><div class="v">${s.online}</div><div class="k">Online matches</div></div>
        </div>
        <div class="sep"></div>
        <div class="label">Recent matches</div>
        <table class="results" style="margin-top:8px">
          <tr><th>When</th><th>Mode</th><th>Place</th><th>Tags</th><th>XP</th></tr>
          ${p.history.length ? p.history.map((h) => `<tr class="${h.winner ? 'winner' : ''}"><td>${new Date(h.at).toLocaleString()}</td><td>${getConfig().modes[h.mode]?.name || h.mode}</td><td>${h.place ? `#${h.place}` : '—'}${h.winner ? ' 🏆' : ''}</td><td>${h.tags}</td><td>+${h.xp}</td></tr>`).join('') : '<tr><td colspan="5" style="color:var(--muted)">No matches yet — go play!</td></tr>'}
        </table>
        <div class="row end" style="margin-top:18px"><button class="btn danger small" data-action="resetProfile"><span class="t">Reset profile</span></button></div>
      </div>
    </div>`;
  }

  screen_settings() {
    const S = settings.data;
    const tab = this.settingsTab;
    const tabs = [['audio', 'Audio'], ['controls', 'Controls'], ['camera', 'Camera'], ['graphics', 'Graphics'], ['access', 'Accessibility'], ['network', 'Network']];
    const slider = (path, label, min, max, step, hint = '') => {
      const v = settings.get(path);
      return `<div class="setting"><div>${label}${hint ? `<span class="hint">${hint}</span>` : ''}</div><div class="range-wrap"><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-setting="${path}" aria-label="${label}"/><output>${fmtSetting(path, v)}</output></div></div>`;
    };
    const toggle = (path, label, hint = '') => `<div class="setting"><div>${label}${hint ? `<span class="hint">${hint}</span>` : ''}</div><button class="toggle ${settings.get(path) ? 'on' : ''}" data-action="toggle" data-setting="${path}" aria-label="${label}"></button></div>`;
    const seg = (path, label, options, hint = '') => `<div class="setting"><div>${label}${hint ? `<span class="hint">${hint}</span>` : ''}</div><div class="seg" style="justify-self:end">${options.map(([v, l]) => `<button class="${String(settings.get(path)) === String(v) ? 'on' : ''}" data-action="seg" data-setting="${path}" data-value="${v}">${l}</button>`).join('')}</div></div>`;
    let body = '';
    if (tab === 'audio') {
      body = slider('audio.master', 'Master volume', 0, 1, 0.05) + slider('audio.music', 'Music volume', 0, 1, 0.05) + slider('audio.sfx', 'Sound effects volume', 0, 1, 0.05) + toggle('audio.muteUnfocused', 'Mute when the window is in the background') + `<div class="row end" style="margin-top:12px"><button class="btn small ghost" data-action="resetSection" data-section="audio"><span class="t">Reset audio</span></button></div>`;
    } else if (tab === 'controls') {
      body = slider('controls.mouseSensX', 'Mouse sensitivity (horizontal)', 0.1, 3, 0.05) + slider('controls.mouseSensY', 'Mouse sensitivity (vertical)', 0.1, 3, 0.05) + toggle('controls.invertY', 'Invert vertical look') + toggle('controls.autoSprint', 'Always sprint', 'Sprint whenever you move (stamina still applies)') + slider('controls.gamepadSens', 'Controller look sensitivity', 0.2, 3, 0.05) + slider('controls.touchSens', 'Touch look sensitivity', 0.2, 3, 0.05);
      body += `<div class="sep"></div><div class="row between"><div class="label">Key bindings</div><button class="btn small ghost" data-action="resetBindings"><span class="t">Reset bindings</span></button></div>`;
      body += ACTIONS.map(([a, label]) => {
        const codes = S.controls.bindings[a] || [];
        return `<div class="setting"><div>${label}</div><div class="row end">${[0, 1].map((i) => `<button class="bind-btn" data-action="rebind" data-bind="${a}" data-idx="${i}">${describeCode(codes[i])}</button>`).join('')}</div></div>`;
      }).join('');
      body += `<p class="subtitle" style="margin-top:10px">Click a binding, then press a key or mouse button (Esc cancels). Assigning a key removes it from any other action. Tip: binding Ctrl is safest in fullscreen — in a normal browser window Ctrl+W closes the tab.</p>`;
    } else if (tab === 'camera') {
      body = slider('camera.fov', 'Field of view', 60, 105, 1) + slider('camera.distance', 'Camera distance', 2.5, 7, 0.1) + toggle('camera.sprintFov', 'Speed FOV effect', 'Widen the view slightly when sprinting and sliding') + toggle('camera.shake', 'Camera shake', 'Small shake when tagging or being tagged') + toggle('camera.landingDip', 'Landing camera dip');
    } else if (tab === 'graphics') {
      body = seg('graphics.quality', 'Quality preset', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], 'Shadows, bloom, particle budget, draw distance, resolution') + slider('graphics.renderScale', 'Resolution scale', 0.5, 1.5, 0.05, 'Rendering resolution relative to your screen') + seg('graphics.fpsLimit', 'Frame-rate limit', [[0, 'Off'], [30, '30'], [60, '60'], [120, '120'], [144, '144']]) + toggle('graphics.dynamicRes', 'Dynamic resolution', 'When the graphics card is the bottleneck, briefly render fewer pixels instead of dropping frames') + toggle('camera.intro', 'Map intro cutscene', 'A short fly-over of the arena before every match (any key skips it)') + toggle('graphics.motionBlur', 'Motion blur', 'A slight blur when the camera turns fast and at top speed (screen edges only). Not on the Low preset') + toggle('graphics.showFps', 'Show FPS counter') + `<div class="setting"><div>Fullscreen<span class="hint">Currently ${document.fullscreenElement ? 'fullscreen' : 'windowed'}</span></div><button class="btn small" data-action="fullscreen" style="justify-self:end"><span class="t">${document.fullscreenElement ? 'Exit fullscreen' : 'Go fullscreen'}</span></button></div>` + `<div class="setting"><div>VSync<span class="hint">Browsers always synchronise rendering to the display. Use the frame-rate limit above to cap FPS.</span></div><div style="justify-self:end;color:var(--muted)">Always on</div></div>` + `<p class="subtitle">Real-time lights and decoration density apply when the next arena loads; anti-aliasing applies after reloading the page.</p>`;
    } else if (tab === 'access') {
      body = toggle('accessibility.reduceFlashing', 'Reduce flashing & shake', 'Disables screen flashes, danger vignette and camera shake') + toggle('accessibility.dodgeAssist', 'Perfect-dodge assist', 'Flashes NOW! inside the perfect-dodge window. Off = you time it from the shrinking ring alone') + slider('accessibility.hudScale', 'HUD scale', 0.75, 1.5, 0.05) + toggle('accessibility.largeText', 'Larger menu text') + `<p class="subtitle" style="margin-top:12px">The IT player is always shown with a shape (spinning crown-flame and ground ring), not just a colour, so it stays readable for colour-blind players.</p>`;
    } else if (tab === 'network') {
      body = `<div class="field"><label class="label" for="server-url">Game server address</label><input type="text" id="server-url" value="${esc(this.net.serverUrl)}" placeholder="${esc(this.net.defaultUrl())}" /><span class="hint" style="color:var(--dim);font-size:12px">Leave empty to use the server this page was loaded from. Example: ws://192.168.1.20:8080/ws</span></div>`;
    }
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page panel" style="max-width:860px">
        <h2 class="title">Settings</h2>
        <p class="subtitle">Changes apply immediately and are saved on this device.</p>
        <div class="tabs">${tabs.map(([id, l]) => `<button class="${tab === id ? 'on' : ''}" data-action="tab" data-tab="${id}">${l}</button>`).join('')}</div>
        ${body}
      </div>
    </div>`;
  }

  screen_controls() {
    const b = settings.data.controls.bindings;
    const k = (a) => (b[a] || []).map((c) => `<span class="kbd">${describeCode(c)}</span>`).join(' ');
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page panel" style="max-width:980px">
        <h2 class="title">Controls</h2>
        <p class="subtitle">Tagging is automatic: if you are IT, touch a runner. Keyboard bindings can be changed in Settings → Controls.</p>
        <div class="controls-guide">
          <div><h4>Keyboard & mouse</h4>
            <div class="cg"><span>Move</span><span>${k('forward')} ${k('left')} ${k('back')} ${k('right')}</span></div>
            <div class="cg"><span>Look</span><span>Mouse</span></div>
            <div class="cg"><span>Jump / wall jump</span><span>${k('jump')}</span></div>
            <div class="cg"><span>Sprint</span><span>${k('sprint')}</span></div>
            <div class="cg"><span>Slide</span><span>${k('slide')}</span></div>
            <div class="cg"><span>Dodge</span><span>${k('dodge')}</span></div>
            <div class="cg"><span>Vault / climb</span><span>${k('vault')}</span></div>
            <div class="cg"><span>Ability slot 1 / 2</span><span>${k('ability1')} ${k('ability2')}</span></div>
            <div class="cg"><span>Emotes</span><span>${['emote1', 'emote2', 'emote3', 'emote4', 'emote5', 'emote6', 'emote7', 'emote8', 'emote9', 'emote10'].map(k).join(' ')}</span></div>
            <div class="cg"><span>Scoreboard</span><span>${k('scoreboard')}</span></div>
            <div class="cg"><span>Practice: swap IT</span><span>${k('swapIt')}</span></div>
            <div class="cg"><span>Pause</span><span>${k('pause')}</span></div>
          </div>
          <div><h4>Controller</h4>
            <div class="cg"><span>Move / Look</span><span>Left stick / Right stick</span></div>
            <div class="cg"><span>Jump</span><span>A / Cross</span></div>
            <div class="cg"><span>Slide</span><span>B / Circle or LT</span></div>
            <div class="cg"><span>Vault / climb</span><span>X / Square</span></div>
            <div class="cg"><span>Sprint</span><span>RB / R1 (hold) or L3</span></div>
            <div class="cg"><span>Dodge</span><span>LB / L1</span></div>
            <div class="cg"><span>Ability slot 1 / 2</span><span>Y / Triangle · RT / R2</span></div>
            <div class="cg"><span>Emotes</span><span>D-pad ↑ ← → · R3 cycles Griddy / Buggin' / Robot</span></div>
            <div class="cg"><span>Scoreboard</span><span>View / Select</span></div>
            <div class="cg"><span>Practice: swap IT</span><span>D-pad ↓</span></div>
            <div class="cg"><span>Pause</span><span>Menu / Start</span></div>
            <div class="cg"><span>Menus</span><span>D-pad + A, B = back</span></div>
          </div>
          <div><h4>Touch</h4>
            <div class="cg"><span>Move</span><span>Drag on the left half</span></div>
            <div class="cg"><span>Look</span><span>Drag on the right half</span></div>
            <div class="cg"><span>Sprint</span><span>Toggle button, or push the stick fully</span></div>
            <div class="cg"><span>Jump · Slide · Dodge · Vault · Abilities</span><span>On-screen buttons</span></div>
            <div class="cg"><span>Pause</span><span>❚❚ top right</span></div>
            <h4 style="margin-top:16px">Movement tips</h4>
            <div class="cg"><span>Run into a low wall</span><span>Auto-vault</span></div>
            <div class="cg"><span>Jump at a ledge</span><span>Mantle up</span></div>
            <div class="cg"><span>Jump while touching a wall</span><span>Wall jump (×2)</span></div>
            <div class="cg"><span>Jump out of a slide</span><span>Keeps momentum</span></div>
            <div class="cg"><span>Dodge the instant IT reaches you</span><span>PERFECT DODGE: slow-mo, IT stunned, 5 s speed boost (8 s cooldown)</span></div>
            <div class="cg"><span>Grapple</span><span>Aim the crosshair until it turns into a green ring</span></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  screen_updates() {
    saveJSON('lastSeenVersion', VERSION);
    const [latest, ...older] = CHANGELOG;
    const section = ([title, items]) => `<div class="cl-sec"><div class="label">${esc(title)}</div><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page panel changelog" style="max-width:860px">
        <div class="row between cl-head">
          <div><div class="label">Update</div><h2 class="title">${esc(latest.title)}</h2></div>
          <div class="cl-version">v${esc(latest.version)}<span>${esc(latest.date)}</span></div>
        </div>
        <div class="cl-grid">${latest.sections.map(section).join('')}</div>
        <div class="row end" style="margin-top:14px"><button class="btn primary" data-action="updatesSeen"><span class="t">Let's play!</span></button></div>
        <div class="sep"></div>
        <div class="label">Earlier updates</div>
        ${older.map((u) => `<details class="cl-old"><summary><b>v${esc(u.version)}</b> · ${esc(u.title)} <span>${esc(u.date)}</span></summary>${u.sections.map(section).join('')}</details>`).join('')}
      </div>
    </div>`;
  }

  // ------------------------------------------------------------------ battle pass
  /** Icon, name and kind of a pass reward ({ coins } or { item: 'kind:id' }). */
  _reward(r) {
    if (r.coins) return { icon: COIN_SVG, name: `${r.coins} coins`, kind: 'Coins' };
    const [kind, id] = r.item.split(':');
    if (kind === 'color') {
      const col = COLORS.find((c) => c.id === id);
      return { icon: `<span class="pr-swatch" style="background:${col?.hex || '#888'}"></span>`, name: `${id[0].toUpperCase()}${id.slice(1)} colour`, kind: 'Colour' };
    }
    const cat = { hat: [HATS, '🧢', 'Headwear'], emote: [EMOTES, '💃', 'Emote'], trail: [TRAILS, '✨', 'Trail'], tagfx: [TAG_EFFECTS, '💥', 'Tag effect'], title: [TITLES, '🏷️', 'Title'] }[kind];
    return { icon: `<span class="pr-emoji">${cat?.[1] || '🎁'}</span>`, name: cat?.[0][id]?.name || id, kind: cat?.[2] || 'Item' };
  }

  screen_pass() {
    const prof = progression.profile;
    const pass = progression.pass;
    const { tier, into, need } = BP.tierOf(pass.xp);
    const left = Math.max(0, Date.parse(BP.SEASON.ends) - Date.now());
    const days = Math.ceil(left / 86400000);
    const over = BP.seasonOver();
    const ready = BP.claimable(prof);
    const price = BP.SEASON.premiumPrice;
    const cell = (t, track) => {
      const r = BP.SEASON.rewards[t - 1][track];
      const info = this._reward(r);
      const claimed = pass.claimed[track].includes(t);
      const can = BP.canClaim(prof, track, t);
      const locked = track === 'premium' && !pass.premium;
      const state = claimed ? 'claimed' : can ? 'ready' : t <= tier && !locked ? 'ready' : 'locked';
      return `<div class="pr ${track} ${state} ${locked ? 'nopremium' : ''}" title="${esc(info.kind)}: ${esc(info.name)}">
        <div class="pr-ico">${info.icon}</div>
        <div class="pr-name">${esc(info.name)}</div>
        <div class="pr-kind">${esc(info.kind)}</div>
        ${claimed ? '<div class="pr-state">✓ Claimed</div>' : can ? `<button class="btn small primary" data-action="claimPass" data-track="${track}" data-tier="${t}"><span class="t">Claim</span></button>` : `<div class="pr-state">${locked ? '🔒 Premium' : `Tier ${t}`}</div>`}
      </div>`;
    };
    const cols = BP.SEASON.rewards.map((_, i) => {
      const t = i + 1;
      return `<div class="tier-col ${t <= tier ? 'reached' : ''} ${t === tier + 1 ? 'next' : ''}" data-tier="${t}"><div class="tnum">${t}</div>${cell(t, 'free')}${cell(t, 'premium')}</div>`;
    }).join('');
    const now = Date.now();
    const nextDay = (BP.dayKey(now) + 1) * 86400000 + new Date(now).getTimezoneOffset() * 60000;
    const hrs = Math.max(1, Math.ceil((nextDay - now) / 3600000));
    const nextWeekDays = 7 - ((BP.dayKey(now) + 3) % 7);
    const chList = (set, kind) => set.list.map((ch) => {
      const def = BP.challengeDef(ch.id);
      const pct = Math.round((ch.progress / def.n) * 100);
      const shown = def.stat === 'survival' ? `${Math.floor(ch.progress / 60)}:${String(ch.progress % 60).padStart(2, '0')} / ${def.n / 60}:00` : `${ch.progress} / ${def.n}`;
      return `<div class="ch ${ch.done ? 'done' : ''}"><div class="row between"><span>${ch.done ? '✓ ' : ''}${esc(def.text)}</span><b>+${BP.CHALLENGE_XP[kind]} XP</b></div><div class="xpbar"><i style="width:${pct}%"></i></div><div class="ch-n">${shown}</div></div>`;
    }).join('');
    return `
    <div class="screen center dim solid">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page pass-page" style="max-width:1120px">
        <div class="pass-head">
          <div>
            <div class="label">Battle Pass · Season ${BP.SEASON.number}</div>
            <h2 class="title">${esc(BP.SEASON.name)}</h2>
            <p class="subtitle">${over ? 'This season has ended. A new one arrives with the next update.' : `Ends in ${days} day${days === 1 ? '' : 's'} · every match gives pass XP, and challenges give lots more.`}</p>
          </div>
          <div class="pass-tier"><span>Tier</span><b>${tier}</b><span>of ${BP.TIERS}</span></div>
        </div>
        <div class="pass-progress">
          <div class="xpbar big"><i style="width:${Math.round((into / need) * 100)}%"></i></div>
          <span>${tier >= BP.TIERS ? 'Pass complete!' : `${into} / ${need} XP to tier ${tier + 1}`}</span>
        </div>
        <div class="pass-actions">
          ${pass.premium
            ? '<span class="badge ready premium-badge">★ PREMIUM UNLOCKED</span>'
            : `<button class="btn small ${progression.coins >= price ? 'primary' : ''}" data-action="buyPremium" ${progression.coins >= price ? '' : 'disabled'}><span class="t">★ Unlock Premium · ${COIN_SVG} ${price}${progression.coins >= price ? '' : ` (need ${price - progression.coins} more)`}</span></button>
               <span class="pass-note">Premium adds a second reward on every tier (the Neon Crown, the Moonwalk, a trail, a tag effect…) and pays back over 1,300 coins. Bought with coins you earn by playing, never real money.</span>`}
          ${ready.length ? `<button class="btn small primary claim-all" data-action="claimAllPass"><span class="t">Claim all (${ready.length})</span></button>` : ''}
        </div>
        <div class="pass-track-wrap">
          <div class="track-labels"><div></div><div>Free</div><div>★ Premium</div></div>
          <div class="pass-track" id="pass-track">${cols}</div>
        </div>
        <div class="grid2 pass-challenges">
          <div class="panel"><div class="row between"><div class="label">Daily challenges</div><span class="pass-reset">New in ${hrs} h</span></div>${chList(pass.daily, 'daily')}</div>
          <div class="panel"><div class="row between"><div class="label">Weekly challenges</div><span class="pass-reset">New in ${nextWeekDays} day${nextWeekDays === 1 ? '' : 's'}</span></div>${chList(pass.weekly, 'weekly')}</div>
        </div>
      </div>
    </div>`;
  }

  bind_pass() {
    const track = this.root.querySelector('#pass-track');
    if (!track) return;
    if (this._passScroll != null) track.scrollLeft = this._passScroll;
    else {
      const next = track.querySelector('.tier-col.next') || track.querySelector('.tier-col.reached:last-of-type');
      if (next) track.scrollLeft = Math.max(0, next.offsetLeft - track.clientWidth / 2 + next.clientWidth / 2);
    }
    track.addEventListener('scroll', () => (this._passScroll = track.scrollLeft), { passive: true });
    // mouse wheel scrolls the track sideways
    track.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        track.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
  }

  _claimed(rewards) {
    if (!rewards.length) return;
    audio.play('unlock');
    const items = rewards.filter((r) => r.item).map((r) => this._reward(r).name);
    const coins = rewards.reduce((a, r) => a + (r.coins || 0), 0);
    const parts = [];
    if (items.length) parts.push(items.join(', '));
    if (coins) parts.push(`${coins} coins`);
    this.toast(`Claimed: ${parts.join(' + ')}${items.length ? ' — equip new items in Customise' : ''}`, 'good');
  }

  screen_credits() {
    return `
    <div class="screen center dim">
      <button class="btn ghost small back-btn" data-action="back"><span class="t">← Back</span></button>
      <div class="page panel" style="max-width:720px">
        <h1 class="logo" style="font-size:72px">Pro Tag</h1>
        <p class="subtitle" style="margin-top:16px">An original 3D parkour tag game.</p>
        <div class="stack" style="font-size:14px;line-height:1.6">
          <div><div class="label">Design & development</div>Anas Studios, built with Claude (Anthropic)</div>
          <div><div class="label">Engine</div>three.js r170 (MIT licence) · custom kinematic character controller, navigation and networking</div>
          <div><div class="label">Art</div>All characters, props, textures and environments are procedurally generated from primitives at runtime. No third-party art assets.</div>
          <div><div class="label">Audio</div>All music and sound effects are synthesised in real time with the Web Audio API. No samples.</div>
          <div><div class="label">Server</div>Python 3 standard library (asyncio WebSockets)</div>
          <div><div class="label">Inspiration</div>The pace and obstacle-course style of competitive chase tag. PRO TAG is an independent project and is not affiliated with any league, broadcaster or brand.</div>
        </div>
      </div>
    </div>`;
  }
}

function fmtSetting(path, v) {
  if (path.startsWith('audio')) return `${Math.round(v * 100)}%`;
  if (path === 'camera.fov') return `${v}°`;
  if (path === 'camera.distance') return `${Number(v).toFixed(1)}m`;
  if (path === 'graphics.renderScale' || path === 'accessibility.hudScale') return `${Math.round(v * 100)}%`;
  return Number(v).toFixed(2);
}
