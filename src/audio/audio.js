// Procedural audio engine (Web Audio API). All sound effects are synthesised at runtime:
// no sample files, no licensing issues. Buses: master -> music / sfx / ui / ambience.
import { settings } from '../core/settings.js';
import { bus } from '../core/events.js';
import { MusicPlayer } from './music.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
    this.voiceCounts = new Map();
    this.lastPlayed = new Map();
    this.slideNodes = new Map();
    this.ambience = null;
    this.music = null;
    bus.on('settings:changed', ({ path }) => {
      if (path.startsWith('audio')) this.applyVolumes();
    });
    window.addEventListener('blur', () => this._focus(false));
    window.addEventListener('focus', () => this._focus(true));
  }

  /** Must be called from a user gesture (browser autoplay policy). Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      const c = this.ctx;
      this.master = c.createGain();
      this.comp = c.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.ratio.value = 4;
      // "slow-motion" filter: everything goes muffled while time is slowed
      this.slowFilter = c.createBiquadFilter();
      this.slowFilter.type = 'lowpass';
      this.slowFilter.frequency.value = 20000;
      this.slowFilter.Q.value = 0.9;
      this.master.connect(this.slowFilter).connect(this.comp).connect(c.destination);
      this.musicBus = c.createGain();
      this.sfxBus = c.createGain();
      this.uiBus = c.createGain();
      this.ambBus = c.createGain();
      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.uiBus.connect(this.master);
      this.ambBus.connect(this.master);
      this.noiseBuf = this._makeNoise(2);
      this.music = new MusicPlayer(c, this.musicBus, this.noiseBuf);
      this.ready = true;
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  _focus(focused) {
    if (!this.ready) return;
    const mute = settings.data.audio.muteUnfocused && !focused;
    this.master.gain.setTargetAtTime(mute ? 0 : settings.data.audio.master, this.ctx.currentTime, 0.1);
  }

  applyVolumes() {
    if (!this.ready) return;
    const a = settings.data.audio;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(a.master, t, 0.05);
    this.musicBus.gain.setTargetAtTime(a.music * 0.55, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(a.sfx, t, 0.05);
    this.uiBus.gain.setTargetAtTime(a.sfx * 0.7, t, 0.05);
    this.ambBus.gain.setTargetAtTime(a.sfx * 0.6, t, 0.05);
  }

  _makeNoise(seconds) {
    const c = this.ctx;
    const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setListener(pos, yaw) {
    this.listener.x = pos.x;
    this.listener.y = pos.y;
    this.listener.z = pos.z;
    this.listener.rx = Math.cos(yaw);
    this.listener.rz = -Math.sin(yaw);
  }

  /** Spatial gain/pan for a world position. */
  _spatial(p) {
    if (!p) return { gain: 1, pan: 0 };
    const dx = p.x - this.listener.x, dy = p.y - this.listener.y, dz = p.z - this.listener.z;
    const d = Math.hypot(dx, dy, dz);
    const gain = 1 / (1 + Math.max(0, d - 2) * 0.16);
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * this.listener.rx + dz * this.listener.rz) / d)) * 0.8 : 0;
    return { gain, pan, d };
  }

  /** Throttle: avoids stacking identical sounds into noise. */
  _allow(key, minGap, maxVoices = 6) {
    const now = this.ctx.currentTime;
    if (now - (this.lastPlayed.get(key) || -1) < minGap) return false;
    if ((this.voiceCounts.get(key) || 0) >= maxVoices) return false;
    this.lastPlayed.set(key, now);
    return true;
  }

  _voice(key, dur) {
    this.voiceCounts.set(key, (this.voiceCounts.get(key) || 0) + 1);
    setTimeout(() => this.voiceCounts.set(key, Math.max(0, (this.voiceCounts.get(key) || 1) - 1)), dur * 1000 + 50);
  }

  _out(busNode, gain, pan) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = Number.isFinite(gain) ? gain : 0; // a bad position must never break the frame
    if (pan && Number.isFinite(pan)) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(busNode);
    } else {
      g.connect(busNode);
    }
    return g;
  }

  _noise(out, t, dur, { type = 'bandpass', freq = 800, q = 1, gain = 0.5, attack = 0.002, freqEnd = null, rate = 1 } = {}) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = rate;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  _tone(out, t, dur, { type = 'sine', freq = 440, freqEnd = null, gain = 0.3, attack = 0.005, release = null } = {}) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (release ?? dur));
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + (release ?? dur) + 0.05);
  }

  // ------------------------------------------------------------------ gameplay sfx
  play(name, opts = {}) {
    if (!this.ready || this.ctx.state !== 'running') return;
    const fn = SFX[name];
    if (!fn) return;
    const sp = this._spatial(opts.pos);
    if (sp.gain < 0.03) return;
    const key = opts.key || name + (opts.ownerId || '');
    const spec = THROTTLE[name] || [0.03, 6];
    if (!this._allow(key, spec[0], spec[1])) return;
    const bus = UI_SOUNDS.has(name) ? this.uiBus : this.sfxBus;
    const out = this._out(bus, sp.gain * (opts.volume ?? 1), sp.pan);
    const dur = fn(this, out, this.ctx.currentTime + 0.005, opts) || 0.5;
    this._voice(key, dur);
  }

  /** Continuous slide scrape for an entity; call stopSlide when it ends. */
  startSlide(id, pos) {
    if (!this.ready || this.slideNodes.has(id)) return;
    const c = this.ctx;
    const sp = this._spatial(pos);
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.22 * sp.gain + 0.001, c.currentTime + 0.04);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start();
    this.slideNodes.set(id, { src, g, f });
  }

  stopSlide(id) {
    const n = this.slideNodes.get(id);
    if (!n) return;
    const t = this.ctx.currentTime;
    n.g.gain.setTargetAtTime(0.0001, t, 0.05);
    n.src.stop(t + 0.3);
    this.slideNodes.delete(id);
  }

  stopAllLoops() {
    for (const id of [...this.slideNodes.keys()]) this.stopSlide(id);
  }

  // ------------------------------------------------------------------ ambience & music
  setAmbience(theme) {
    if (!this.ready) return;
    if (this.ambience) {
      const old = this.ambience;
      old.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.4);
      setTimeout(() => old.stop(), 2000);
      this.ambience = null;
    }
    if (!theme) return;
    this.ambience = makeAmbience(this, theme);
  }

  playMusic(track) {
    if (!this.ready) return;
    this.music.play(track);
  }

  setMusicIntensity(v) {
    if (this.ready) this.music.setIntensity(v);
  }

  /** 0 = normal, 1 = deep slow-motion muffle. */
  setSlowmo(amount) {
    if (!this.ready) return;
    const f = 20000 * Math.pow(500 / 20000, Math.max(0, Math.min(1, amount)));
    this.slowFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.03);
  }

  stopMusic() {
    if (this.ready) this.music.stop();
  }

  update(dt) {
    if (this.ambience?.update) this.ambience.update(dt);
  }

  crowdCheer(strength = 1) {
    if (this.ambience?.cheer) this.ambience.cheer(strength);
  }
}

const UI_SOUNDS = new Set(['introRise', 'introWhoosh', 'scrambled', 'eventWarn', 'eventStart', 'powerDown', 'powerUp', 'zoneClosing', 'perfectDodge', 'timeResume', 'boost', 'outplayed', 'uiHover', 'uiClick', 'uiBack', 'countdown', 'go', 'victory', 'defeat', 'levelUp', 'unlock', 'error', 'purchase', 'abilityDenied', 'abilityReady']);

const THROTTLE = {
  footstep: [0.07, 8],
  uiHover: [0.04, 3],
  land: [0.08, 4],
  sprint: [0.6, 1],
  tag: [0.1, 3],
  coin: [0.05, 4],
  fuseTick: [0.08, 2],
  zoneWarn: [0.4, 1],
  abilityDenied: [0.25, 1],
};

const SURFACE = {
  metal: { freq: 2200, q: 3, ring: 1 },
  grate: { freq: 2600, q: 4, ring: 1 },
  pipe: { freq: 2000, q: 3, ring: 1 },
  container: { freq: 1500, q: 2.5, ring: 1 },
  wood: { freq: 520, q: 1.4, ring: 0 },
  pad: { freq: 380, q: 0.8, ring: 0 },
  default: { freq: 900, q: 1.1, ring: 0 },
};

export function surfaceFor(m) {
  if (!m) return 'default';
  if (m.startsWith('container') || m === 'corrugated' || m === 'roof_metal') return 'container';
  if (m.startsWith('pad') || m === 'wall_pad') return 'pad';
  if (m === 'wood' || m === 'crate') return 'wood';
  if (m === 'metal' || m === 'grate' || m === 'pipe' || m === 'crane' || m === 'solar') return 'metal';
  return 'default';
}

const SFX = {
  footstep(a, out, t, o) {
    const s = SURFACE[o.surface] || SURFACE.default;
    const v = 0.22 + Math.min(0.25, (o.speed || 6) * 0.02);
    a._noise(out, t, 0.07, { freq: s.freq * (0.85 + Math.random() * 0.3), q: s.q, gain: v });
    a._tone(out, t, 0.06, { freq: 90 + Math.random() * 20, freqEnd: 50, gain: v * 0.5 });
    if (s.ring) a._tone(out, t, 0.12, { type: 'triangle', freq: 800 + Math.random() * 300, gain: 0.03 });
    return 0.12;
  },
  jump(a, out, t) {
    a._noise(out, t, 0.18, { freq: 500, freqEnd: 1800, q: 0.7, gain: 0.18, attack: 0.02 });
    a._tone(out, t, 0.09, { type: 'triangle', freq: 220, freqEnd: 330, gain: 0.06 });
    return 0.2;
  },
  land(a, out, t, o) {
    const k = Math.min(1, (o.speed || 8) / 16);
    a._tone(out, t, 0.18, { freq: 110, freqEnd: 40, gain: 0.25 + k * 0.3 });
    a._noise(out, t, 0.12, { freq: 700, q: 0.8, gain: 0.15 + k * 0.25 });
    return 0.2;
  },
  walljump(a, out, t) {
    a._noise(out, t, 0.06, { freq: 1500, q: 2, gain: 0.25 });
    a._noise(out, t + 0.02, 0.2, { freq: 600, freqEnd: 2000, q: 0.7, gain: 0.15, attack: 0.02 });
    return 0.25;
  },
  vault(a, out, t) {
    a._noise(out, t, 0.05, { freq: 1200, q: 2, gain: 0.2 });
    a._noise(out, t + 0.03, 0.3, { freq: 400, freqEnd: 1600, q: 0.6, gain: 0.16, attack: 0.05 });
    return 0.35;
  },
  mantle(a, out, t) {
    a._noise(out, t, 0.06, { freq: 900, q: 1.5, gain: 0.2 });
    a._noise(out, t + 0.12, 0.08, { freq: 700, q: 1.5, gain: 0.16 });
    return 0.25;
  },
  dodge(a, out, t) {
    a._noise(out, t, 0.22, { freq: 2400, freqEnd: 600, q: 0.6, gain: 0.22, attack: 0.01 });
    return 0.25;
  },
  perfectDodge(a, out, t) {
    // reverse-swell whoosh -> sub drop -> glassy shimmer chord
    a._noise(out, t, 0.5, { freq: 300, freqEnd: 6000, q: 0.6, gain: 0.35, attack: 0.35 });
    a._tone(out, t + 0.32, 1.4, { freq: 110, freqEnd: 32, gain: 0.7, attack: 0.01 });
    a._noise(out, t + 0.32, 0.25, { type: 'highpass', freq: 3000, q: 0.5, gain: 0.25 });
    for (const [i, f] of [1046.5, 1318.5, 1568, 2093].entries()) a._tone(out, t + 0.34 + i * 0.05, 1.6, { type: 'sine', freq: f, freqEnd: f * 0.985, gain: 0.08, attack: 0.02 });
    a._tone(out, t + 0.34, 1.2, { type: 'triangle', freq: 261.63, gain: 0.12 });
    return 2.0;
  },
  timeResume(a, out, t) {
    a._noise(out, t, 0.35, { freq: 6000, freqEnd: 400, q: 0.7, gain: 0.3, attack: 0.005 });
    a._tone(out, t, 0.25, { type: 'square', freq: 880, freqEnd: 1760, gain: 0.06 });
    a._tone(out, t + 0.04, 0.4, { freq: 70, freqEnd: 45, gain: 0.5 });
    return 0.5;
  },
  stunned(a, out, t) {
    a._tone(out, t, 0.12, { type: 'square', freq: 420, freqEnd: 180, gain: 0.12 });
    a._tone(out, t, 0.2, { freq: 140, freqEnd: 70, gain: 0.4 });
    for (let i = 0; i < 6; i++) a._tone(out, t + 0.15 + i * 0.09, 0.08, { type: 'sine', freq: 2400 + (i % 2) * 500, gain: 0.04 });
    return 0.8;
  },
  boost(a, out, t) {
    a._tone(out, t, 0.6, { type: 'sawtooth', freq: 220, freqEnd: 880, gain: 0.07, attack: 0.05 });
    a._tone(out, t + 0.05, 0.6, { type: 'square', freq: 440, freqEnd: 1760, gain: 0.04, attack: 0.05 });
    a._noise(out, t, 0.5, { freq: 800, freqEnd: 5000, q: 0.6, gain: 0.12, attack: 0.1 });
    return 0.7;
  },
  outplayed(a, out, t) {
    a._tone(out, t, 0.6, { type: 'sawtooth', freq: 300, freqEnd: 60, gain: 0.12 });
    a._noise(out, t, 0.4, { freq: 2000, freqEnd: 200, q: 0.8, gain: 0.2 });
    return 0.7;
  },
  sprint(a, out, t) {
    // burst of wind + a quick breath when kicking into a sprint
    a._noise(out, t, 0.35, { freq: 700, freqEnd: 1900, q: 0.5, gain: 0.12, attack: 0.06 });
    a._noise(out, t + 0.02, 0.12, { type: 'highpass', freq: 2500, q: 0.4, gain: 0.05, attack: 0.02 });
    return 0.4;
  },
  slide(a, out, t) {
    a._noise(out, t, 0.12, { freq: 400, q: 0.8, gain: 0.2 });
    return 0.15;
  },
  pad(a, out, t) {
    a._tone(out, t, 0.45, { type: 'sawtooth', freq: 180, freqEnd: 900, gain: 0.08, attack: 0.01 });
    a._tone(out, t, 0.45, { type: 'sine', freq: 360, freqEnd: 1800, gain: 0.1 });
    a._noise(out, t, 0.4, { freq: 300, freqEnd: 3000, q: 0.5, gain: 0.15 });
    return 0.5;
  },
  tag(a, out, t) {
    a._tone(out, t, 0.25, { freq: 160, freqEnd: 45, gain: 0.55 });
    a._noise(out, t, 0.15, { freq: 1800, q: 0.7, gain: 0.35 });
    for (const [i, f] of [523.25, 659.25, 783.99].entries()) a._tone(out, t + 0.02 + i * 0.015, 0.4, { type: 'triangle', freq: f, gain: 0.09 });
    return 0.45;
  },
  becomeIt(a, out, t) {
    for (const [i, f] of [880, 698.46, 554.37, 440].entries()) a._tone(out, t + i * 0.09, 0.16, { type: 'sawtooth', freq: f, gain: 0.07 });
    a._tone(out, t, 0.6, { freq: 110, freqEnd: 55, gain: 0.3 });
    return 0.6;
  },
  escaped(a, out, t) {
    for (const [i, f] of [523.25, 659.25, 783.99, 1046.5].entries()) a._tone(out, t + i * 0.06, 0.2, { type: 'triangle', freq: f, gain: 0.08 });
    return 0.45;
  },
  eliminated(a, out, t) {
    a._tone(out, t, 0.7, { type: 'sawtooth', freq: 440, freqEnd: 70, gain: 0.12 });
    a._noise(out, t, 0.4, { freq: 1200, freqEnd: 200, q: 0.8, gain: 0.2 });
    return 0.7;
  },
  countdown(a, out, t) {
    a._tone(out, t, 0.18, { type: 'square', freq: 660, gain: 0.08 });
    return 0.2;
  },
  go(a, out, t) {
    a._tone(out, t, 0.45, { type: 'square', freq: 1320, gain: 0.08 });
    a._tone(out, t, 0.45, { type: 'triangle', freq: 660, gain: 0.12 });
    return 0.5;
  },
  victory(a, out, t) {
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
    notes.forEach((f, i) => a._tone(out, t + i * 0.12, i === notes.length - 1 ? 0.8 : 0.2, { type: 'triangle', freq: f, gain: 0.12 }));
    a._tone(out, t + 0.6, 0.9, { type: 'sine', freq: 261.63, gain: 0.15 });
    return 1.6;
  },
  defeat(a, out, t) {
    [392, 349.23, 311.13, 261.63].forEach((f, i) => a._tone(out, t + i * 0.18, 0.3, { type: 'triangle', freq: f, gain: 0.1 }));
    return 1.0;
  },
  levelUp(a, out, t) {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => a._tone(out, t + i * 0.07, 0.3, { type: 'square', freq: f, gain: 0.05 }));
    return 0.8;
  },
  unlock(a, out, t) {
    [880, 1174.66, 1760].forEach((f, i) => a._tone(out, t + i * 0.08, 0.35, { type: 'sine', freq: f, gain: 0.1 }));
    return 0.6;
  },
  uiHover(a, out, t) {
    a._tone(out, t, 0.04, { type: 'sine', freq: 1800, gain: 0.035 });
    return 0.05;
  },
  uiClick(a, out, t) {
    a._tone(out, t, 0.07, { type: 'triangle', freq: 900, freqEnd: 1300, gain: 0.08 });
    return 0.08;
  },
  uiBack(a, out, t) {
    a._tone(out, t, 0.08, { type: 'triangle', freq: 900, freqEnd: 600, gain: 0.08 });
    return 0.09;
  },
  // ---------------------------------------------------------------- abilities & coins
  blink(a, out, t) {
    // zap: falling sine sweep + bright crackle, then a "pop" on arrival
    a._tone(out, t, 0.18, { type: 'sine', freq: 2400, freqEnd: 300, gain: 0.18 });
    a._noise(out, t, 0.12, { type: 'highpass', freq: 4000, q: 0.5, gain: 0.22 });
    a._tone(out, t + 0.12, 0.2, { type: 'triangle', freq: 300, freqEnd: 1600, gain: 0.12 });
    a._noise(out, t + 0.12, 0.25, { freq: 1200, freqEnd: 5000, q: 0.8, gain: 0.12, attack: 0.01 });
    return 0.4;
  },
  rocket(a, out, t) {
    a._tone(out, t, 0.35, { freq: 90, freqEnd: 35, gain: 0.7, attack: 0.005 });
    a._noise(out, t, 0.12, { freq: 900, q: 0.6, gain: 0.5 });
    a._noise(out, t + 0.03, 0.9, { type: 'lowpass', freq: 2400, freqEnd: 300, q: 0.4, gain: 0.3, attack: 0.04 });
    return 1.0;
  },
  grapple(a, out, t) {
    a._noise(out, t, 0.08, { type: 'highpass', freq: 3000, q: 0.7, gain: 0.25 });
    a._tone(out, t, 0.3, { type: 'sawtooth', freq: 1200, freqEnd: 300, gain: 0.05 });
    a._tone(out, t + 0.05, 0.02, { type: 'square', freq: 2600, gain: 0.08 });
    a._noise(out, t + 0.08, 0.6, { freq: 500, freqEnd: 2600, q: 1.5, gain: 0.12, attack: 0.08 });
    return 0.7;
  },
  cloak(a, out, t) {
    a._noise(out, t, 0.6, { freq: 4000, freqEnd: 300, q: 0.5, gain: 0.18, attack: 0.02 });
    a._tone(out, t, 0.6, { type: 'sine', freq: 880, freqEnd: 220, gain: 0.08 });
    a._tone(out, t + 0.04, 0.6, { type: 'sine', freq: 1320, freqEnd: 330, gain: 0.05 });
    return 0.7;
  },
  decoy(a, out, t) {
    for (const [i, f] of [660, 990, 1320].entries()) a._tone(out, t + i * 0.04, 0.25, { type: 'square', freq: f, freqEnd: f * 1.06, gain: 0.035 });
    a._noise(out, t, 0.3, { freq: 2200, q: 2, gain: 0.08 });
    return 0.4;
  },
  decoyPop(a, out, t) {
    a._tone(out, t, 0.25, { type: 'square', freq: 1400, freqEnd: 200, gain: 0.06 });
    a._noise(out, t, 0.2, { type: 'highpass', freq: 2500, q: 0.6, gain: 0.2 });
    return 0.3;
  },
  shockwave(a, out, t) {
    a._tone(out, t, 0.7, { freq: 70, freqEnd: 28, gain: 0.9, attack: 0.004 });
    a._noise(out, t, 0.5, { type: 'lowpass', freq: 3000, freqEnd: 150, q: 0.6, gain: 0.5 });
    a._tone(out, t, 0.25, { type: 'sawtooth', freq: 400, freqEnd: 60, gain: 0.12 });
    return 0.8;
  },
  introRise(a, out, t) {
    // the arena reveal: an airy riser and a wide chord
    a._noise(out, t, 2.2, { freq: 300, freqEnd: 2400, q: 0.5, gain: 0.12, attack: 1.2 });
    for (const [i, f] of [196, 246.94, 293.66, 392].entries()) a._tone(out, t + 0.35 + i * 0.05, 2.4, { type: 'triangle', freq: f, gain: 0.045, attack: 0.5 });
    return 2.6;
  },
  introWhoosh(a, out, t) {
    a._noise(out, t, 0.9, { freq: 1800, freqEnd: 250, q: 0.7, gain: 0.3, attack: 0.25 });
    a._tone(out, t + 0.6, 0.35, { freq: 90, freqEnd: 45, gain: 0.35 });
    return 1.0;
  },
  scramble(a, out, t) {
    // a glitchy, bit-crushed arpeggio sweeping out from the caster
    const notes = [1046.5, 1568, 784, 1318.5, 659.25, 1975.5, 880, 1174.7];
    notes.forEach((f, i) => a._tone(out, t + i * 0.035, 0.05, { type: 'square', freq: f, freqEnd: f * (i % 2 ? 0.7 : 1.3), gain: 0.05 }));
    a._noise(out, t, 0.45, { type: 'bandpass', freq: 1800, freqEnd: 500, q: 2, gain: 0.25 });
    a._tone(out, t, 0.4, { type: 'sawtooth', freq: 140, freqEnd: 70, gain: 0.12 });
    return 0.5;
  },
  scrambled(a, out, t) {
    // your controls just got mixed up: a wobbly descending "error" warble
    for (let i = 0; i < 5; i++) a._tone(out, t + i * 0.07, 0.07, { type: 'square', freq: 660 - i * 70, freqEnd: 900 - i * 90, gain: 0.05 });
    a._noise(out, t, 0.3, { type: 'highpass', freq: 3500, q: 0.6, gain: 0.12 });
    return 0.45;
  },
  knocked(a, out, t) {
    a._tone(out, t, 0.18, { freq: 180, freqEnd: 60, gain: 0.35 });
    a._noise(out, t, 0.25, { freq: 900, freqEnd: 2600, q: 0.6, gain: 0.18 });
    return 0.3;
  },
  eventWarn(a, out, t) {
    for (let i = 0; i < 3; i++) a._tone(out, t + i * 0.22, 0.14, { type: 'square', freq: 880, gain: 0.05 });
    return 0.8;
  },
  eventStart(a, out, t) {
    a._tone(out, t, 0.7, { type: 'sawtooth', freq: 180, freqEnd: 540, gain: 0.08, attack: 0.05 });
    a._noise(out, t, 0.6, { freq: 600, freqEnd: 3000, q: 0.6, gain: 0.15, attack: 0.1 });
    for (const [i, f] of [523.25, 659.25, 783.99].entries()) a._tone(out, t + 0.3 + i * 0.06, 0.4, { type: 'triangle', freq: f, gain: 0.08 });
    return 1.0;
  },
  powerDown(a, out, t) {
    a._tone(out, t, 1.4, { type: 'sawtooth', freq: 220, freqEnd: 30, gain: 0.14, attack: 0.01 });
    a._noise(out, t, 0.25, { type: 'highpass', freq: 3000, q: 0.5, gain: 0.25 });
    a._tone(out, t + 0.05, 0.6, { freq: 60, freqEnd: 30, gain: 0.5 });
    return 1.5;
  },
  powerUp(a, out, t) {
    a._tone(out, t, 1.0, { type: 'sawtooth', freq: 40, freqEnd: 240, gain: 0.1, attack: 0.2 });
    a._tone(out, t + 0.6, 0.3, { type: 'square', freq: 1320, gain: 0.04 });
    return 1.1;
  },
  explode(a, out, t) {
    a._tone(out, t, 1.0, { freq: 75, freqEnd: 25, gain: 1.0, attack: 0.004 });
    a._noise(out, t, 1.2, { type: 'lowpass', freq: 4000, freqEnd: 120, q: 0.5, gain: 0.9, attack: 0.003 });
    a._noise(out, t + 0.02, 0.4, { type: 'highpass', freq: 2500, q: 0.4, gain: 0.25 });
    return 1.3;
  },
  fuseTick(a, out, t) {
    a._tone(out, t, 0.06, { type: 'square', freq: 1760, gain: 0.05 });
    a._noise(out, t, 0.05, { type: 'highpass', freq: 5000, q: 0.5, gain: 0.05 });
    return 0.08;
  },
  zoneWarn(a, out, t) {
    a._tone(out, t, 0.18, { type: 'sawtooth', freq: 520, freqEnd: 440, gain: 0.06 });
    return 0.2;
  },
  zoneClosing(a, out, t) {
    for (const [i, f] of [220, 277.18, 329.63].entries()) a._tone(out, t + i * 0.02, 1.4, { type: 'sawtooth', freq: f, freqEnd: f * 0.98, gain: 0.05, attack: 0.15 });
    a._noise(out, t, 1.2, { freq: 300, freqEnd: 1200, q: 0.6, gain: 0.12, attack: 0.4 });
    return 1.5;
  },
  rideStart(a, out, t) {
    a._noise(out, t, 1.2, { freq: 400, freqEnd: 1600, q: 0.6, gain: 0.25, attack: 0.15 });
    a._tone(out, t, 0.5, { type: 'triangle', freq: 330, freqEnd: 660, gain: 0.06 });
    return 1.3;
  },
  splash(a, out, t) {
    a._noise(out, t, 0.5, { type: 'lowpass', freq: 3500, freqEnd: 400, q: 0.5, gain: 0.45, attack: 0.005 });
    a._noise(out, t + 0.05, 0.6, { type: 'highpass', freq: 2500, q: 0.4, gain: 0.15, attack: 0.03 });
    a._tone(out, t, 0.15, { freq: 160, freqEnd: 60, gain: 0.3 });
    return 0.7;
  },
  wade(a, out, t) {
    a._noise(out, t, 0.18, { freq: 900, freqEnd: 500, q: 0.8, gain: 0.16, attack: 0.01 });
    return 0.2;
  },
  coin(a, out, t) {
    // classic two-note pickup
    a._tone(out, t, 0.08, { type: 'square', freq: 987.77, gain: 0.05 });
    a._tone(out, t + 0.07, 0.3, { type: 'square', freq: 1318.5, gain: 0.05 });
    a._tone(out, t + 0.07, 0.3, { type: 'sine', freq: 2637, gain: 0.03 });
    return 0.4;
  },
  purchase(a, out, t) {
    for (const [i, f] of [1318.5, 1567.98, 2093, 2637].entries()) a._tone(out, t + i * 0.05, 0.25, { type: 'square', freq: f, gain: 0.035 });
    a._noise(out, t, 0.4, { type: 'highpass', freq: 5000, q: 0.5, gain: 0.08 });
    a._tone(out, t + 0.2, 0.7, { type: 'triangle', freq: 523.25, gain: 0.1 });
    return 0.9;
  },
  abilityReady(a, out, t) {
    a._tone(out, t, 0.12, { type: 'sine', freq: 1568, gain: 0.05 });
    a._tone(out, t + 0.06, 0.18, { type: 'sine', freq: 2093, gain: 0.05 });
    return 0.25;
  },
  abilityDenied(a, out, t) {
    a._tone(out, t, 0.1, { type: 'square', freq: 220, freqEnd: 180, gain: 0.05 });
    return 0.12;
  },
  error(a, out, t) {
    a._tone(out, t, 0.12, { type: 'square', freq: 200, gain: 0.06 });
    a._tone(out, t + 0.13, 0.15, { type: 'square', freq: 160, gain: 0.06 });
    return 0.3;
  },
};

function makeAmbience(a, theme) {
  const c = a.ctx;
  const gain = c.createGain();
  gain.gain.value = 0.0001;
  gain.connect(a.ambBus);
  gain.gain.setTargetAtTime(1, c.currentTime, 1.0);
  const nodes = [];
  const loopNoise = (type, freq, q, vol) => {
    const src = c.createBufferSource();
    src.buffer = a.noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(gain);
    src.start();
    nodes.push(src);
    return { src, f, g };
  };
  let timer = 0;
  let update = null;
  let cheer = null;
  if (theme === 'city') {
    loopNoise('lowpass', 180, 0.5, 0.35); // distant city rumble
    const wind = loopNoise('bandpass', 500, 0.4, 0.06);
    update = (dt) => {
      timer -= dt;
      wind.f.frequency.value = 450 + Math.sin(c.currentTime * 0.3) * 150;
      if (timer <= 0) {
        timer = 9 + Math.random() * 14;
        // far-away siren
        const t = c.currentTime;
        const o = c.createOscillator();
        o.type = 'sine';
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.012, t + 1);
        g.gain.linearRampToValueAtTime(0.0001, t + 4);
        for (let i = 0; i < 8; i++) o.frequency.setValueAtTime(i % 2 ? 620 : 760, t + i * 0.5);
        o.connect(g).connect(gain);
        o.start(t);
        o.stop(t + 4.2);
      }
    };
  } else if (theme === 'arena') {
    const crowd = loopNoise('bandpass', 700, 0.6, 0.12);
    loopNoise('lowpass', 120, 0.5, 0.15);
    let boost = 0;
    update = (dt) => {
      boost = Math.max(0, boost - dt * 0.6);
      crowd.g.gain.value = 0.1 + Math.sin(c.currentTime * 0.4) * 0.02 + boost * 0.35;
      crowd.f.frequency.value = 650 + boost * 500;
    };
    cheer = (s) => { boost = Math.min(1, boost + 0.6 * s); };
  } else if (theme === 'docks') {
    const waves = loopNoise('lowpass', 400, 0.4, 0.25);
    loopNoise('bandpass', 300, 0.3, 0.04);
    update = (dt) => {
      waves.g.gain.value = 0.15 + Math.max(0, Math.sin(c.currentTime * 0.45)) * 0.2;
      timer -= dt;
      if (timer <= 0) {
        timer = 4 + Math.random() * 8;
        const t = c.currentTime;
        for (let i = 0; i < 2 + Math.random() * 2; i++) a._tone(gain, t + i * 0.22, 0.18, { type: 'triangle', freq: 1500 + Math.random() * 300, freqEnd: 1100, gain: 0.015 });
      }
    };
  } else {
    const wind = loopNoise('bandpass', 600, 0.3, 0.05);
    update = (dt) => {
      wind.f.frequency.value = 500 + Math.sin(c.currentTime * 0.2) * 200;
      timer -= dt;
      if (timer <= 0) {
        timer = 2 + Math.random() * 5;
        const t = c.currentTime;
        const base = 2400 + Math.random() * 1200;
        for (let i = 0; i < 3; i++) a._tone(gain, t + i * 0.09, 0.07, { type: 'sine', freq: base, freqEnd: base * 1.3, gain: 0.012 });
      }
    };
  }
  return {
    gain,
    update,
    cheer,
    stop() {
      for (const n of nodes) {
        try { n.stop(); } catch { /* already stopped */ }
      }
      gain.disconnect();
    },
  };
}

export const audio = new AudioEngine();
