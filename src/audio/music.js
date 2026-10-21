// Procedural music sequencer: original synth tracks generated in real time.
// Look-ahead scheduling (Chris Wilson's "A Tale of Two Clocks" technique) keeps timing tight.
// `intensity` (0..1) adds/removes layers so the music builds as a match nears its end.

const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

// pattern strings: 16 steps per bar. 'x' = hit, '.' = rest. Bass/arp use scale-degree digits.
const TRACKS = {
  menu: {
    bpm: 98, root: 45, scale: MINOR, prog: [0, 5, 3, 4],
    kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.',
    bass: '0...0.0.....0...', arp: '0.2.4.2.0.2.4.7.', pad: true, lead: null, swing: 0.0,
  },
  night: {
    bpm: 116, root: 40, scale: MINOR, prog: [0, 5, 6, 4],
    kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xx',
    bass: '0.0.0.0.0.0.0.07', arp: '0.4.7.4.2.4.7.9.', pad: true, lead: '7...6...4.......', swing: 0.0,
  },
  arena: {
    bpm: 128, root: 43, scale: DORIAN, prog: [0, 3, 4, 3],
    kick: 'x...x...x...x...', snare: '....x.......x..x', hat: '..x...x...x...x.',
    bass: '0..0..0.0..0..30', arp: '0.7.4.7.0.7.5.7.', pad: true, lead: '4...2...0...2...', swing: 0.0,
  },
  sunset: {
    bpm: 108, root: 41, scale: DORIAN, prog: [0, 3, 0, 4],
    kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx',
    bass: '0..0.2.4..0.3.2.', arp: '4.2.0.2.4.5.4.2.', pad: true, lead: null, swing: 0.12,
  },
  training: {
    bpm: 104, root: 48, scale: MAJOR, prog: [0, 4, 5, 3],
    kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    bass: '0...0...0.4.0...', arp: '0.2.4.7.4.2.0.4.', pad: true, lead: null, swing: 0.08,
  },
  // v1.02: an empty mall's dreamy lounge music, a sunny waterpark bop, a clanky factory groove
  mall: {
    bpm: 92, root: 46, scale: DORIAN, prog: [0, 3, 5, 4],
    kick: 'x.......x..x....', snare: '....x.......x...', hat: '..x...x...x...xx',
    bass: '0.....0.2...4...', arp: '4.2.0.2.4.6.4.2.', pad: true, lead: '6.......4...2...', swing: 0.14,
  },
  waterpark: {
    bpm: 122, root: 50, scale: MAJOR, prog: [0, 3, 4, 3],
    kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x.x.x.',
    bass: '0.0...0.2.0...4.', arp: '0.2.4.5.4.2.4.7.', pad: true, lead: '4...5...7...4...', swing: 0.06,
  },
  factory: {
    bpm: 118, root: 42, scale: MINOR, prog: [0, 0, 5, 4],
    kick: 'x..x..x...x..x..', snare: '....x.......x.x.', hat: 'xxx.xxx.xxx.xxx.',
    bass: '0.0.3.0.0.0.5.4.', arp: '0.4.0.7.0.4.0.9.', pad: false, lead: '7...7...6...4...', swing: 0.0,
  },
};

export class MusicPlayer {
  constructor(ctx, out, noiseBuf) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(out);
    this.noise = noiseBuf;
    this.track = null;
    this.trackName = null;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
    this.intensity = 0.5;
    // shared effects: a little delay makes the synths feel bigger
    this.delay = ctx.createDelay(1.0);
    this.delayGain = ctx.createGain();
    this.delayGain.gain.value = 0.22;
    this.delay.connect(this.delayGain).connect(this.delay);
    this.delayGain.connect(this.out);
  }

  play(name) {
    if (this.trackName === name && this.timer) return;
    const t = TRACKS[name] || TRACKS.menu;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.25);
    const start = () => {
      this.track = t;
      this.trackName = name;
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.05;
      this.delay.delayTime.value = (60 / t.bpm) * 0.75;
      this.out.gain.setTargetAtTime(1, this.ctx.currentTime, 0.6);
      if (!this.timer) this.timer = setInterval(() => this._schedule(), 25);
    };
    if (this.timer) setTimeout(start, 700);
    else start();
  }

  stop() {
    const now = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, now, 0.3);
    setTimeout(() => {
      clearInterval(this.timer);
      this.timer = null;
      this.trackName = null;
    }, 1200);
  }

  setIntensity(v) {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  _schedule() {
    const t = this.track;
    if (!t) return;
    const stepDur = 60 / t.bpm / 4;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      const s = this.step % 16;
      const bar = Math.floor(this.step / 16) % t.prog.length;
      const swing = s % 2 === 1 ? stepDur * t.swing : 0;
      this._playStep(t, s, bar, this.nextTime + swing, stepDur);
      this.nextTime += stepDur;
      this.step++;
    }
  }

  _deg(t, chordRoot, deg) {
    const scale = t.scale;
    const d = chordRoot + deg;
    const oct = Math.floor(d / scale.length);
    return t.root + scale[((d % scale.length) + scale.length) % scale.length] + 12 * oct;
  }

  _playStep(t, s, bar, time, stepDur) {
    const I = this.intensity;
    const chord = t.prog[bar];
    if (t.kick[s] === 'x' && (I > 0.15 || s % 8 === 0)) this._kick(time);
    if (t.snare[s] === 'x' && I > 0.25) this._snare(time);
    if (t.hat[s] === 'x' && I > 0.35) this._hat(time, s % 4 === 2 ? 0.05 : 0.03);
    if (I > 0.85 && s % 2 === 1) this._hat(time, 0.02);
    const b = t.bass[s];
    if (b && b !== '.') this._bass(time, NOTE(this._deg(t, chord, Number(b)) - 12), stepDur * 1.6);
    const a = t.arp[s];
    if (a && a !== '.' && I > 0.45) this._arp(time, NOTE(this._deg(t, chord, Number(a)) + 12), stepDur);
    if (t.lead && I > 0.7) {
      const l = t.lead[s];
      if (l && l !== '.') this._lead(time, NOTE(this._deg(t, chord, Number(l)) + 12), stepDur * 3.5);
    }
    if (t.pad && s === 0) {
      const notes = [0, 2, 4].map((d) => NOTE(this._deg(t, chord, d)));
      this._pad(time, notes, stepDur * 16);
    }
  }

  _env(time, peak, attack, dur) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    return g;
  }

  _kick(time) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140, time);
    o.frequency.exponentialRampToValueAtTime(42, time + 0.12);
    const g = this._env(time, 0.55, 0.002, 0.3);
    o.connect(g).connect(this.out);
    o.start(time);
    o.stop(time + 0.32);
  }

  _snare(time) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1400;
    const g = this._env(time, 0.18, 0.002, 0.18);
    src.connect(f).connect(g).connect(this.out);
    src.start(time, Math.random());
    src.stop(time + 0.2);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, time);
    o.frequency.exponentialRampToValueAtTime(140, time + 0.08);
    const g2 = this._env(time, 0.12, 0.002, 0.1);
    o.connect(g2).connect(this.out);
    o.start(time);
    o.stop(time + 0.12);
  }

  _hat(time, vol) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = this._env(time, vol, 0.001, 0.05);
    src.connect(f).connect(g).connect(this.out);
    src.start(time, Math.random());
    src.stop(time + 0.06);
  }

  _bass(time, freq, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, time);
    f.frequency.exponentialRampToValueAtTime(180, time + dur);
    f.Q.value = 6;
    const g = this._env(time, 0.16, 0.005, dur);
    o.connect(f).connect(g).connect(this.out);
    o.start(time);
    o.stop(time + dur + 0.05);
  }

  _arp(time, freq, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2600;
    const g = this._env(time, 0.035, 0.003, dur * 0.9);
    o.connect(f).connect(g);
    g.connect(this.out);
    g.connect(this.delay);
    o.start(time);
    o.stop(time + dur);
  }

  _lead(time, freq, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 5.5;
    const vg = this.ctx.createGain();
    vg.gain.value = freq * 0.006;
    vib.connect(vg).connect(o.frequency);
    const g = this._env(time, 0.06, 0.04, dur);
    o.connect(g);
    g.connect(this.out);
    g.connect(this.delay);
    o.start(time);
    vib.start(time);
    o.stop(time + dur);
    vib.stop(time + dur);
  }

  _pad(time, freqs, dur) {
    for (const fr of freqs) {
      for (const det of [-7, 7]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = fr;
        o.detune.value = det;
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 900;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(0.018, time + dur * 0.25);
        g.gain.linearRampToValueAtTime(0.0001, time + dur);
        o.connect(f).connect(g).connect(this.out);
        o.start(time);
        o.stop(time + dur + 0.05);
      }
    }
  }
}
