// WebSocket client for the authoritative PRO TAG server (server/main.py).
// JSON messages: { t: type, ...payload }. Handles heartbeat/RTT, server clock sync,
// reconnection with a session token, and exposes everything through the event bus as "net:<type>".
import { bus } from '../core/events.js';
import { loadJSON, saveJSON, loadSession, saveSession } from '../core/storage.js';

export const PROTOCOL_VERSION = 1;

export class NetClient {
  constructor() {
    this.ws = null;
    this.status = 'offline'; // offline | connecting | online | reconnecting | error
    this.id = null;
    this.rtt = 0;
    this.clockOffset = null; // serverTime - localTime (seconds)
    this.lastError = null;
    this.room = null;
    this.wantReconnect = false;
    this.reconnectTries = 0;
    this.pingTimer = null;
    this.connectPromise = null;
    this.serverUrl = loadJSON('serverUrl', '');
    this.tag = null; // our friend code, confirmed by the server
    this.shareUrls = []; // addresses friends can use to reach this server
  }

  defaultUrl() {
    if (this.serverUrl) return this.serverUrl;
    if (location.protocol === 'file:') return 'ws://localhost:8080/ws';
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  setServerUrl(url) {
    this.serverUrl = url.trim();
    saveJSON('serverUrl', this.serverUrl);
  }

  now() {
    return performance.now() / 1000;
  }

  serverNow() {
    return this.now() + (this.clockOffset ?? 0);
  }

  _setStatus(s) {
    this.status = s;
    bus.emit('net:status', s);
  }

  /** Connect and say hello. Resolves with the welcome message. */
  connect(profile) {
    if (this.status === 'online') return Promise.resolve({ id: this.id });
    if (this.connectPromise) return this.connectPromise;
    this.profile = profile;
    this._setStatus('connecting');
    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.defaultUrl());
      } catch (err) {
        this.connectPromise = null;
        this._setStatus('error');
        reject(new Error(`Invalid server address: ${err.message}`));
        return;
      }
      this.ws = ws;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        this.connectPromise = null;
        this._setStatus('error');
        reject(new Error('Connection timed out. Is the server running? (python server/main.py)'));
      }, 5000);
      ws.onopen = () => {
        const token = loadSession('netToken', null);
        this._send({ t: 'hello', v: PROTOCOL_VERSION, name: profile.name, cosm: profile.cosmetics, token, tag: profile.tag });
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          console.warn('[net] bad message', e.data);
          return;
        }
        if (msg.t === 'welcome' && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.id = msg.id;
          this.tag = msg.tag;
          this.shareUrls = Array.isArray(msg.share) ? msg.share : [];
          saveSession('netToken', msg.token);
          this._setStatus('online');
          this.reconnectTries = 0;
          this._startPing();
          this.connectPromise = null;
          resolve(msg);
        }
        this._handle(msg);
      };
      ws.onerror = () => {
        this.lastError = 'socket error';
      };
      ws.onclose = (ev) => {
        clearInterval(this.pingTimer);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.connectPromise = null;
          this._setStatus('error');
          reject(new Error('Could not reach the game server. Start it with: python server/main.py'));
          return;
        }
        this.ws = null;
        const wasOnline = this.status === 'online';
        this._setStatus('offline');
        bus.emit('net:closed', { code: ev.code, reason: ev.reason, wasOnline });
        if (this.wantReconnect && wasOnline) this._tryReconnect();
      };
    });
    return this.connectPromise;
  }

  async _tryReconnect() {
    if (this.reconnectTries >= 5) {
      bus.emit('net:reconnect_failed');
      return;
    }
    this.reconnectTries++;
    this._setStatus('reconnecting');
    await new Promise((r) => setTimeout(r, 600 * this.reconnectTries));
    try {
      await this.connect(this.profile);
      bus.emit('net:reconnected');
    } catch {
      this._tryReconnect();
    }
  }

  disconnect() {
    this.wantReconnect = false;
    clearInterval(this.pingTimer);
    if (this.ws) {
      try { this.ws.close(1000, 'bye'); } catch { /* ignore */ }
    }
    this.ws = null;
    this.room = null;
    this._setStatus('offline');
  }

  _startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this._send({ t: 'ping', c: this.now() }), 1000);
    // a quick burst first so the server clock estimate (used to place remote players) settles fast
    for (let i = 0; i < 5; i++) setTimeout(() => this._send({ t: 'ping', c: this.now() }), i * 120);
  }

  _handle(msg) {
    switch (msg.t) {
      case 'pong': {
        const now = this.now();
        const rtt = now - msg.c;
        this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
        const offset = msg.s + rtt / 2 - now;
        // trust the lowest-latency samples most: a slow round trip says little about the offset
        this.minRtt = Math.min(this.minRtt ?? Infinity, rtt);
        const w = rtt <= this.minRtt * 1.25 ? 0.25 : 0.04;
        this.clockOffset = this.clockOffset == null ? offset : this.clockOffset * (1 - w) + offset * w;
        break;
      }
      case 'room':
        this.room = msg.room;
        break;
      case 'left_room':
        this.room = null;
        break;
      default:
        break;
    }
    bus.emit(`net:${msg.t}`, msg);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  send(t, payload = {}) {
    return this._send({ t, ...payload });
  }
}

export const net = new NetClient();
