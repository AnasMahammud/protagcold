// Dynamic map events: power outages, coin rain, low gravity, conveyor overdrive, wet floors,
// speed surges, slide rush and fog banks. Offline the match schedules them (EventScheduler);
// online the SERVER does and sends { kind, start, end } (match time) with the rules snapshot.
// MapEventDirector turns the current event into lighting, fog, rain, HUD and movement changes.
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { bus } from '../core/events.js';
import { POWER } from '../maps/decor2.js';

export const EVENT_INFO = {
  blackout: { icon: '⚡', color: '#ffd23d', desc: 'The lights are out and the radar is offline' },
  coinrain: { icon: '🪙', color: '#ffd23d', desc: 'Bonus coins are falling from the sky — grab them!' },
  lowgrav: { icon: '🪐', color: '#b48cff', desc: 'Jump higher, fall slower' },
  overdrive: { icon: '⚙', color: '#ff8a2f', desc: 'Every conveyor belt reverses at double speed' },
  slick: { icon: '💦', color: '#3df5ff', desc: 'Sprinklers on: the floors are slippery' },
  surge: { icon: '🏃', color: '#7dff6b', desc: 'Everyone runs 15% faster' },
  sliderush: { icon: '🌊', color: '#2fd8e8', desc: 'The water slides go 50% faster' },
  fog: { icon: '🌫', color: '#cfd8e6', desc: 'A thick fog rolls in' },
};

/** Which events each map theme can throw (a map's env.events overrides this). */
const THEME_EVENTS = {
  city: ['blackout', 'coinrain', 'lowgrav', 'fog'],
  arena: ['blackout', 'coinrain', 'surge'],
  docks: ['fog', 'coinrain', 'surge', 'lowgrav'],
  training: ['coinrain', 'lowgrav', 'surge'],
  mall: ['blackout', 'slick', 'coinrain', 'surge'],
  waterpark: ['slick', 'sliderush', 'coinrain', 'surge'],
  factory: ['blackout', 'overdrive', 'lowgrav', 'coinrain'],
};

export function eventsForMap(mapData) {
  return mapData.env?.events || THEME_EVENTS[mapData.theme] || ['coinrain'];
}

/** Offline schedule (the server runs the same logic in Python). */
export class EventScheduler {
  constructor(cfg, kinds, rng) {
    this.cfg = cfg;
    this.kinds = kinds;
    this.rng = rng;
    this.next = this._rand(cfg.firstAt);
    this.cur = null;
    this.last = null;
  }

  _rand([a, b]) {
    return a + this.rng() * (b - a);
  }

  /** Advance to match time t. Returns { ev, started } (started: the event began this step). */
  step(t, duration) {
    if (!this.kinds.length) return { ev: null, started: false };
    if (this.cur && t >= this.cur.end) {
      this.cur = null;
      this.next = t + this._rand(this.cfg.gap);
    }
    if (!this.cur && t >= this.next - this.cfg.warn) {
      if (duration > 0 && this.next + 12 > duration) {
        this.next = Infinity; // too close to the end of the match
      } else {
        const pool = this.kinds.length > 1 ? this.kinds.filter((k) => k !== this.last) : this.kinds;
        const kind = pool[Math.floor(this.rng() * pool.length)];
        this.last = kind;
        this.cur = { kind, start: this.next, end: this.next + this.cfg.events[kind].duration, fired: false };
      }
    }
    let started = false;
    if (this.cur && !this.cur.fired && t >= this.cur.start) {
      this.cur.fired = true;
      started = true;
    }
    return { ev: this.cur, started };
  }
}

/** Movement / perception modifiers of the event active at time t. */
export function eventMods(ev, t) {
  const kind = ev && t >= ev.start && t < ev.end ? ev.kind : null;
  return {
    kind,
    gravity: kind === 'lowgrav' ? 0.45 : 1,
    traction: kind === 'slick' ? 0.22 : 1,
    speed: kind === 'surge' ? 1.15 : 1,
    radar: kind !== 'blackout',
    dark: kind === 'blackout',
  };
}

export class MapEventDirector {
  constructor(session) {
    this.s = session;
    this.game = session.game;
    this.active = null;
    this.warned = null;
    this.dark = 0;
    this.fogK = 0;
    this.rain = null;
    const fog = this.game.scene.fog;
    this.base = {
      near: fog?.near ?? 60,
      far: fog?.far ?? 200,
      fogColor: fog ? fog.color.clone() : new THREE.Color('#888'),
      exposure: this.game.renderer.toneMappingExposure,
    };
    this._c = new THREE.Color();
  }

  update(dt, ev, t) {
    const cfg = this.game.cfg.mapEvents;
    const info = ev ? cfg.events[ev.kind] : null;
    const active = ev && t >= ev.start && t < ev.end ? ev.kind : null;
    if (ev && t < ev.start && this.warned !== ev.start) {
      this.warned = ev.start;
      audio.play('eventWarn');
      bus.emit('hud:feed', { kind: 'info', text: `${EVENT_INFO[ev.kind].icon} ${info.name} incoming…` });
    }
    if (active !== this.active) {
      const prev = this.active;
      this.active = active;
      if (active) {
        const ei = EVENT_INFO[active];
        audio.play(active === 'blackout' ? 'powerDown' : 'eventStart');
        bus.emit('hud:banner', { text: cfg.events[active].name.toUpperCase(), sub: ei.desc, color: ei.color, ms: 2200 });
      } else if (prev === 'blackout') {
        audio.play('powerUp');
      }
    }
    const w = this.game.map.world;
    const live = this.game.map.visuals.live;
    w.conveyorScale = active === 'overdrive' ? -2 : 1;
    live.conveyorScale = w.conveyorScale;
    w.rideScale = active === 'sliderush' ? 1.5 : 1;
    this._lighting(dt, active === 'blackout');
    this._fog(dt, active === 'fog');
    this._rain(dt, active === 'slick');
  }

  _lighting(dt, on) {
    const target = on ? 1 : 0;
    // the power dies with a flicker, and comes back with one
    const flicker = Math.abs(this.dark - target) > 0.05 && Math.random() < 0.25 ? 0.6 : 1;
    this.dark += (target - this.dark) * Math.min(1, dt * (on ? 3 : 1.5));
    const d = Math.min(1, this.dark * flicker);
    const L = this.game.map.visuals.lights;
    if (L) {
      L.hemi.intensity = L.hemiBase * (1 - 0.85 * d);
      L.sun.intensity = L.sunBase * (1 - 0.93 * d);
    }
    this.game.renderer.toneMappingExposure = this.base.exposure * (1 - 0.3 * d);
    POWER.lights.color.set('#fff6dc').lerp(this._c.set('#05060a'), d);
    const blink = d > 0.5 ? 0.6 + 0.4 * Math.sin(performance.now() / 180) : 1;
    POWER.emergency.color.set('#2a0d0d').lerp(this._c.set('#ff2a1a'), d * blink);
    POWER.window.color.set('#7fd6ff').lerp(this._c.set('#0a1622'), d);
  }

  _fog(dt, on) {
    const fog = this.game.scene.fog;
    if (!fog) return;
    this.fogK += ((on ? 1 : 0) - this.fogK) * Math.min(1, dt * 0.8);
    fog.near = this.base.near * (1 - 0.8 * this.fogK);
    fog.far = this.base.far * (1 - 0.78 * this.fogK);
    fog.color.copy(this.base.fogColor).lerp(this._c.set('#c9ced6'), this.fogK);
  }

  _rain(dt, on) {
    if (!on && !this.rain) return;
    if (!this.rain) {
      const n = Math.round(1400 * Math.max(0.4, this.game.quality.particles));
      const pos = new Float32Array(n * 6);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color: '#cfefff', transparent: true, opacity: 0.45 });
      this.rain = new THREE.LineSegments(g, mat);
      this.rain.frustumCulled = false;
      this.rain.userData.drops = Array.from({ length: n }, () => ({ x: (Math.random() - 0.5) * 40, y: Math.random() * 18, z: (Math.random() - 0.5) * 40 }));
      this.game.scene.add(this.rain);
    }
    const r = this.rain;
    r.visible = on || r.material.opacity > 0.02;
    r.material.opacity += ((on ? 0.45 : 0) - r.material.opacity) * Math.min(1, dt * 2);
    if (!r.visible) return;
    const c = this.game.camera.position;
    const arr = r.geometry.attributes.position.array;
    r.userData.drops.forEach((p, i) => {
      p.y -= dt * 16;
      if (p.y < -2) {
        p.y = 16 + Math.random() * 2;
        p.x = (Math.random() - 0.5) * 40;
        p.z = (Math.random() - 0.5) * 40;
      }
      const x = c.x + p.x, y = c.y + p.y - 6, z = c.z + p.z;
      arr.set([x, y, z, x + 0.05, y + 0.6, z], i * 6);
    });
    r.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    const L = this.game.map?.visuals?.lights;
    if (L) {
      L.hemi.intensity = L.hemiBase;
      L.sun.intensity = L.sunBase;
    }
    this.game.renderer.toneMappingExposure = this.base.exposure;
    const fog = this.game.scene.fog;
    if (fog) {
      fog.near = this.base.near;
      fog.far = this.base.far;
      fog.color.copy(this.base.fogColor);
    }
    POWER.lights.color.set('#fff6dc');
    POWER.emergency.color.set('#2a0d0d');
    POWER.window.color.set('#7fd6ff');
    if (this.game.map) {
      this.game.map.world.conveyorScale = 1;
      this.game.map.world.rideScale = 1;
      this.game.map.visuals.live.conveyorScale = 1;
    }
    if (this.rain) {
      this.game.scene.remove(this.rain);
      this.rain.geometry.dispose();
      this.rain.material.dispose();
    }
  }
}
