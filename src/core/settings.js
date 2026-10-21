// Persistent player settings. Every value here is wired to a real system:
// audio -> AudioEngine buses, controls -> InputManager, camera -> CameraRig,
// graphics -> Renderer/quality presets, accessibility -> effects/camera/HUD.

import { loadJSON, saveJSON } from './storage.js';
import { bus } from './events.js';

export const ACTIONS = [
  ['forward', 'Move forward'],
  ['back', 'Move back'],
  ['left', 'Move left'],
  ['right', 'Move right'],
  ['jump', 'Jump / wall jump'],
  ['sprint', 'Sprint (hold)'],
  ['slide', 'Slide'],
  ['dodge', 'Dodge'],
  ['vault', 'Vault / climb'],
  ['ability1', 'Ability 1'],
  ['ability2', 'Ability 2'],
  ['emote1', 'Emote: wave'],
  ['emote2', 'Emote: dance'],
  ['emote3', 'Emote: flex'],
  ['scoreboard', 'Scoreboard (hold)'],
  ['swapIt', 'Practice: become IT'],
  ['pause', 'Pause'],
];

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  // Ctrl is deliberately NOT a default: Ctrl+W (slide + forward) would close the browser tab.
  slide: ['KeyC'],
  dodge: ['KeyQ', 'Mouse2'],
  vault: ['KeyE'],
  ability1: ['KeyF'],
  ability2: ['KeyR'],
  emote1: ['Digit1'],
  emote2: ['Digit2'],
  emote3: ['Digit3'],
  scoreboard: ['Tab'],
  swapIt: ['KeyT'],
  pause: ['Escape', 'KeyP'],
};

// maxPixelRatio caps devicePixelRatio x renderScale; pointLights is the real-time light budget;
// dynamicShadows=false bakes the static map shadows once and uses blob shadows for characters.
export const QUALITY_PRESETS = {
  low: { maxPixelRatio: 0.75, shadows: false, dynamicShadows: false, shadowMapSize: 512, bloom: false, bloomRes: 0, pointLights: 0, particles: 0.4, drawDistance: 0.7, antialias: false, decorDensity: 0.4 },
  medium: { maxPixelRatio: 1.0, shadows: true, dynamicShadows: false, shadowMapSize: 1024, bloom: false, bloomRes: 0, pointLights: 0, particles: 0.7, drawDistance: 0.85, antialias: true, decorDensity: 0.7 },
  high: { maxPixelRatio: 1.0, shadows: true, dynamicShadows: true, shadowMapSize: 2048, bloom: true, bloomRes: 0.33, pointLights: 3, particles: 1.0, drawDistance: 1.0, antialias: true, decorDensity: 1.0 },
  ultra: { maxPixelRatio: 2.0, shadows: true, dynamicShadows: true, shadowMapSize: 4096, bloom: true, bloomRes: 0.5, pointLights: 6, particles: 1.3, drawDistance: 1.2, antialias: true, decorDensity: 1.0 },
};

/** Pick a sensible default preset for this GPU on first launch. */
export function detectQuality(gpuName = '') {
  const g = gpuName.toLowerCase();
  const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
  if (mobile || /swiftshader|llvmpipe|software|basic render/.test(g)) return 'low';
  if (/intel|uhd|iris|mali|adreno|powervr|apple gpu/.test(g)) return 'medium';
  return 'high';
}

export const DEFAULT_SETTINGS = {
  audio: { master: 0.8, music: 0.5, sfx: 0.85, muteUnfocused: true },
  controls: {
    mouseSensX: 1.0,
    mouseSensY: 1.0,
    invertY: false,
    gamepadSens: 1.0,
    touchSens: 1.0,
    autoSprint: false,
    bindings: DEFAULT_BINDINGS,
  },
  camera: { fov: 78, distance: 4.4, sprintFov: true, shake: true, landingDip: true },
  graphics: { quality: 'high', renderScale: 1.0, fpsLimit: 0, showFps: false, vsync: true, autoDetected: false, dynamicRes: true },
  accessibility: { reduceFlashing: false, hudScale: 1.0, itOutline: true, largeText: false, dodgeAssist: false },
  player: { name: '' },
};

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = {};
  for (const k of Object.keys(base)) out[k] = deepMerge(base[k], over ? over[k] : undefined);
  // keep unknown binding keys out; keep everything else the user had only if it exists in defaults
  return out;
}

/**
 * A key may belong to one action only. Saves from older versions can collide with actions added
 * since (F used to be a second Slide key; it is now Ability 1): the key stays with the action
 * whose DEFAULT primary key it is, otherwise with the first action listed. Returns true if fixed.
 */
export function dedupeBindings(b) {
  const owner = new Map();
  for (const [a, codes] of Object.entries(DEFAULT_BINDINGS)) if (codes[0] && !owner.has(codes[0])) owner.set(codes[0], a);
  const users = new Map();
  for (const [a, codes] of Object.entries(b)) for (const c of codes || []) users.set(c, [...(users.get(c) || []), a]);
  let changed = false;
  for (const [c, acts] of users) {
    if (acts.length < 2) continue;
    const keep = acts.includes(owner.get(c)) ? owner.get(c) : acts[0];
    for (const a of acts) {
      if (a === keep) continue;
      b[a] = b[a].filter((x) => x !== c);
      if (!b[a].length) b[a] = DEFAULT_BINDINGS[a].filter((x) => !users.has(x)); // never leave an action unbound
      changed = true;
    }
  }
  return changed;
}

class Settings {
  constructor() {
    this.data = deepMerge(DEFAULT_SETTINGS, loadJSON('settings', {}));
    if (dedupeBindings(this.data.controls.bindings)) this.save();
    if (!this.data.player.name) {
      this.data.player.name = `Runner${Math.floor(100 + Math.random() * 900)}`;
      this.save();
    }
  }

  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    let o = this.data;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
    this.save();
    bus.emit('settings:changed', { path, value });
  }

  setBinding(action, index, code) {
    const list = (this.data.controls.bindings[action] || []).slice();
    // a key can only belong to one action: remove it elsewhere
    for (const [a, codes] of Object.entries(this.data.controls.bindings)) {
      const i = codes.indexOf(code);
      if (i >= 0 && !(a === action && i === index)) this.data.controls.bindings[a] = codes.filter((c) => c !== code);
    }
    list[index] = code;
    this.data.controls.bindings[action] = list.filter(Boolean);
    this.save();
    bus.emit('settings:changed', { path: 'controls.bindings', value: this.data.controls.bindings });
  }

  resetSection(section) {
    this.data[section] = deepMerge(DEFAULT_SETTINGS[section], undefined);
    this.save();
    bus.emit('settings:changed', { path: section, value: this.data[section] });
  }

  quality() {
    return QUALITY_PRESETS[this.data.graphics.quality] || QUALITY_PRESETS.high;
  }

  save() {
    saveJSON('settings', this.data);
  }
}

export const settings = new Settings();

export function describeCode(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const names = {
    Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', AltRight: 'R-Alt', Escape: 'Esc', Tab: 'Tab', Enter: 'Enter', Backspace: 'Bksp',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB',
    Mouse3: 'Mouse4', Mouse4: 'Mouse5', CapsLock: 'Caps',
  };
  return names[code] || code;
}
