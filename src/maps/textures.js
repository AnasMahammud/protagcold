// Procedural canvas textures: every surface in PRO TAG is generated at runtime, so the game
// ships no third-party image assets and has no licensing concerns.
import * as THREE from 'three';
import { mulberry32 } from '../core/mathUtil.js';

const cache = new Map();
let maxAniso = 4;

export function setMaxAnisotropy(v) {
  maxAniso = v;
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function noise(ctx, size, rng, alpha, count, minR = 0.5, maxR = 1.5, colors = ['#000', '#fff']) {
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = alpha * rng();
    ctx.fillStyle = colors[(rng() * colors.length) | 0];
    const r = minR + rng() * (maxR - minR);
    ctx.fillRect(rng() * size, rng() * size, r, r);
  }
  ctx.globalAlpha = 1;
}

function finish(canvas, { repeat = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const GEN = {
  concrete(ctx, s, rng) {
    ctx.fillStyle = '#8d8f94'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.18, 9000, 1, 3, ['#6f7177', '#a8aab0', '#5d5f63']);
    ctx.strokeStyle = 'rgba(40,40,45,0.35)'; ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);
    for (let i = 0; i < 6; i++) { ctx.globalAlpha = 0.08; ctx.fillStyle = '#3a3a3e'; ctx.beginPath(); ctx.ellipse(rng() * s, rng() * s, 20 + rng() * 40, 10 + rng() * 30, rng() * 3, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
  },
  roof(ctx, s, rng) {
    ctx.fillStyle = '#4b4d55'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.5, 14000, 1, 2.5, ['#3a3c43', '#62646d', '#55575f', '#2e3036']);
    ctx.strokeStyle = 'rgba(25,25,30,0.55)'; ctx.lineWidth = 3;
    for (let i = 0; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(0, (i * s) / 2); ctx.lineTo(s, (i * s) / 2); ctx.stroke(); }
  },
  brick(ctx, s, rng) {
    ctx.fillStyle = '#3b2a2c'; ctx.fillRect(0, 0, s, s);
    const rows = 16, bw = s / 4, bh = s / rows;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? bw / 2 : 0;
      for (let c = -1; c < 5; c++) {
        const shade = 0.75 + rng() * 0.35;
        ctx.fillStyle = `rgb(${(120 * shade) | 0},${(56 * shade) | 0},${(50 * shade) | 0})`;
        ctx.fillRect(c * bw + off + 2, r * bh + 2, bw - 4, bh - 4);
      }
    }
    noise(ctx, s, rng, 0.15, 5000, 1, 2, ['#000', '#d9a090']);
  },
  metal(ctx, s, rng) {
    const g = ctx.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, '#7b8492'); g.addColorStop(1, '#5d6572');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 400; i++) { ctx.globalAlpha = 0.05; ctx.fillStyle = rng() > 0.5 ? '#fff' : '#000'; ctx.fillRect(0, rng() * s, s, 1); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) { ctx.beginPath(); ctx.arc(x * s / 4 + 12, y * s / 4 + 12, 3, 0, 7); ctx.fill(); }
  },
  pipe(ctx, s, rng) {
    ctx.fillStyle = '#c9a227'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#2a2a2a';
    for (let i = -s; i < s * 2; i += 64) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 32, 0); ctx.lineTo(i + 32 - s, s); ctx.lineTo(i - s, s); ctx.fill(); }
    noise(ctx, s, rng, 0.12, 3000, 1, 2);
  },
  wood(ctx, s, rng) {
    ctx.fillStyle = '#8a5a32'; ctx.fillRect(0, 0, s, s);
    const planks = 6;
    for (let i = 0; i < planks; i++) {
      const shade = 0.8 + rng() * 0.3;
      ctx.fillStyle = `rgb(${(150 * shade) | 0},${(100 * shade) | 0},${(58 * shade) | 0})`;
      ctx.fillRect(0, (i * s) / planks + 2, s, s / planks - 4);
      for (let k = 0; k < 18; k++) { ctx.globalAlpha = 0.15; ctx.strokeStyle = '#4a2a10'; ctx.beginPath(); const y = (i * s) / planks + rng() * (s / planks); ctx.moveTo(0, y); ctx.bezierCurveTo(s / 3, y + rng() * 6 - 3, (2 * s) / 3, y + rng() * 6 - 3, s, y); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  },
  crate(ctx, s, rng) {
    GEN.wood(ctx, s, rng);
    ctx.strokeStyle = '#5a3818'; ctx.lineWidth = s / 14;
    ctx.strokeRect(s / 28, s / 28, s - s / 14, s - s / 14);
    ctx.beginPath(); ctx.moveTo(s / 14, s / 14); ctx.lineTo(s - s / 14, s - s / 14); ctx.stroke();
  },
  glass(ctx, s) {
    ctx.fillStyle = '#9fe8ff'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#3c5560'; ctx.lineWidth = 8;
    for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo((i * s) / 4, 0); ctx.lineTo((i * s) / 4, s); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();
  },
  planter(ctx, s, rng) {
    ctx.fillStyle = '#6d6a64'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.25, 6000, 1, 3, ['#55524d', '#85827a']);
  },
  grass(ctx, s, rng) {
    ctx.fillStyle = '#3f7a35'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.6, 16000, 1, 3, ['#2f6a28', '#4f9a42', '#6ab052', '#2a5522']);
  },
  container(ctx, s, rng, color = '#b33a2e') {
    ctx.fillStyle = color; ctx.fillRect(0, 0, s, s);
    const ribs = 16;
    for (let i = 0; i < ribs; i++) {
      const x = (i * s) / ribs;
      const g = ctx.createLinearGradient(x, 0, x + s / ribs, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.28)'); g.addColorStop(0.5, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = g; ctx.fillRect(x, 0, s / ribs, s);
    }
    noise(ctx, s, rng, 0.25, 2500, 1, 4, ['#3b2418', '#000']);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, 0, s, 6); ctx.fillRect(0, s - 6, s, 6);
  },
  pad(ctx, s, rng, color = '#2f6fe0') {
    ctx.fillStyle = color; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.08, 5000, 1, 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, s - 4, s - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, s - 16, s - 16);
  },
  pad_floor(ctx, s, rng) {
    ctx.fillStyle = '#25324a'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.08, 6000, 1, 2, ['#000', '#5a6a8a']);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 3;
    for (let i = 0; i <= 2; i++) { ctx.beginPath(); ctx.moveTo((i * s) / 2, 0); ctx.lineTo((i * s) / 2, s); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, (i * s) / 2); ctx.lineTo(s, (i * s) / 2); ctx.stroke(); }
  },
  grate(ctx, s) {
    ctx.fillStyle = '#2b2f36'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#8b95a5'; ctx.lineWidth = 3;
    for (let i = 0; i < s; i += 16) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke(); }
  },
  asphalt(ctx, s, rng) {
    ctx.fillStyle = '#3a3b3f'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.45, 18000, 1, 2.5, ['#2b2c30', '#4c4d52', '#55565b']);
    ctx.fillStyle = 'rgba(230,200,60,0.75)'; ctx.fillRect(s * 0.48, 0, s * 0.04, s * 0.4);
  },
  corrugated(ctx, s, rng) {
    GEN.container(ctx, s, rng, '#7f8a93');
  },
  roof_metal(ctx, s, rng) {
    GEN.container(ctx, s, rng, '#5b6670');
  },
  crane(ctx, s, rng) {
    ctx.fillStyle = '#e8b82a'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.2, 3000, 1, 3, ['#7a5a10', '#000']);
  },
  grid(ctx, s, rng) {
    ctx.fillStyle = '#d9dee6'; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.05, 3000, 1, 2);
    ctx.strokeStyle = '#9aa6b8'; ctx.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo((i * s) / 4, 0); ctx.lineTo((i * s) / 4, s); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, (i * s) / 4); ctx.lineTo(s, (i * s) / 4); ctx.stroke(); }
    ctx.strokeStyle = '#5d6b82'; ctx.lineWidth = 4; ctx.strokeRect(0, 0, s, s);
  },
  helipad(ctx, s, rng) {
    GEN.concrete(ctx, s, rng);
  },
  solar(ctx, s) {
    ctx.fillStyle = '#1b2a4a'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#8fa8d8'; ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { ctx.beginPath(); ctx.moveTo((i * s) / 8, 0); ctx.lineTo((i * s) / 8, s); ctx.stroke(); }
    for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(0, (i * s) / 4); ctx.lineTo(s, (i * s) / 4); ctx.stroke(); }
  },
  windows(ctx, s, rng, base = '#3b2a2c', lit = 0.45) {
    ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
    noise(ctx, s, rng, 0.2, 4000, 1, 2);
    const cols = 4, rows = 4;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = (c + 0.2) * (s / cols), y = (r + 0.25) * (s / rows);
      ctx.fillStyle = '#0d1018'; ctx.fillRect(x - 3, y - 3, s / cols * 0.6 + 6, s / rows * 0.5 + 6);
      ctx.fillStyle = rng() < lit ? ['#ffd28a', '#fff1c4', '#9fd8ff', '#ff9fd8'][(rng() * 4) | 0] : '#1a2030';
      ctx.fillRect(x, y, s / cols * 0.6, s / rows * 0.5);
    }
  },
};

const MATERIAL_DEFS = {
  // name: [generator, texture metres per repeat, roughness, metalness, extra]
  roof: ['roof', 4, 0.95, 0.0],
  concrete: ['concrete', 3, 0.9, 0.0],
  brick: ['brick', 3, 0.85, 0.0],
  brick_windows: ['windows', 6, 0.7, 0.0, { emissiveFrom: 'windows', base: '#3b2a2c' }],
  concrete_windows: ['windows', 6, 0.7, 0.0, { emissiveFrom: 'windows', base: '#5a5c63' }],
  metal: ['metal', 2, 0.45, 0.65],
  pipe: ['pipe', 1.5, 0.5, 0.4],
  wood: ['wood', 2, 0.8, 0.0],
  crate: ['crate', 1.5, 0.8, 0.0],
  glass: ['glass', 4, 0.1, 0.2, { transparent: true, opacity: 0.45 }],
  planter: ['planter', 2, 0.9, 0.0],
  grass: ['grass', 3, 1.0, 0.0],
  container_red: ['container', 3, 0.6, 0.35, { color: '#b5382c' }],
  container_blue: ['container', 3, 0.6, 0.35, { color: '#2d5fa8' }],
  container_green: ['container', 3, 0.6, 0.35, { color: '#2f8a4c' }],
  container_orange: ['container', 3, 0.6, 0.35, { color: '#d9762a' }],
  container_yellow: ['container', 3, 0.6, 0.35, { color: '#d8b12b' }],
  container_teal: ['container', 3, 0.6, 0.35, { color: '#1f8f8f' }],
  pad_floor: ['pad_floor', 4, 0.75, 0.0],
  wall_pad: ['pad', 2.5, 0.8, 0.0, { color: '#1f2b45' }],
  pad_blue: ['pad', 1.5, 0.7, 0.0, { color: '#2f6fe0' }],
  pad_orange: ['pad', 1.2, 0.7, 0.0, { color: '#ff7a2f' }],
  pad_white: ['pad', 1.5, 0.7, 0.0, { color: '#e9edf5' }],
  grate: ['grate', 1, 0.6, 0.6],
  asphalt: ['asphalt', 6, 0.95, 0.0],
  corrugated: ['corrugated', 3, 0.6, 0.5],
  roof_metal: ['roof_metal', 4, 0.6, 0.5],
  crane: ['crane', 2, 0.6, 0.4],
  grid: ['grid', 4, 0.85, 0.0],
  helipad: ['helipad', 3, 0.9, 0.0],
  solar: ['solar', 1.2, 0.25, 0.6],
};

export function texture(name, opts = {}) {
  const key = name + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);
  const gen = GEN[name];
  const [canvas, ctx] = makeCanvas(opts.size || 256);
  const rng = mulberry32(hash(key));
  gen(ctx, canvas.width, rng, opts.color || opts.base, opts.lit);
  const tex = finish(canvas);
  cache.set(key, tex);
  return tex;
}

/** Emissive mask for window textures (lit windows glow at night). */
function windowsEmissive(base) {
  const key = 'windows_emissive' + base;
  if (cache.has(key)) return cache.get(key);
  const src = texture('windows', { base });
  const s = src.image.width;
  const [canvas, ctx] = makeCanvas(s);
  ctx.drawImage(src.image, 0, 0);
  const img = ctx.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (lum < 130) { d[i] = d[i + 1] = d[i + 2] = 0; }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finish(canvas);
  cache.set(key, tex);
  return tex;
}

const matCache = new Map();

/** Returns { material, scale } for a map material name. */
export function surfaceMaterial(name) {
  if (matCache.has(name)) return matCache.get(name);
  const def = MATERIAL_DEFS[name] || MATERIAL_DEFS.concrete;
  const [gen, scale, roughness, metalness, extra = {}] = def;
  const map = texture(gen, { color: extra.color, base: extra.base });
  const params = { map, roughness, metalness };
  if (extra.transparent) Object.assign(params, { transparent: true, opacity: extra.opacity, depthWrite: false, side: THREE.DoubleSide });
  if (extra.emissiveFrom === 'windows') {
    params.emissiveMap = windowsEmissive(extra.base);
    params.emissive = new THREE.Color('#ffffff');
    params.emissiveIntensity = 0.55;
  }
  const material = new THREE.MeshStandardMaterial(params);
  const entry = { material, scale };
  matCache.set(name, entry);
  return entry;
}

/** Text rendered to a canvas texture (signs, banners, station labels). */
export function textTexture(text, { color = '#ffffff', bg = 'rgba(0,0,0,0)', font = '900 120px "Segoe UI", system-ui, sans-serif', width = 1024, height = 256, glow = 0, sub = null, subColor = '#cfd8e6' } = {}) {
  const key = ['txt', text, color, bg, font, width, height, glow, sub].join('|');
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  ctx.fillStyle = color;
  // shrink to fit
  let size = parseInt(font.match(/(\d+)px/)[1], 10);
  while (ctx.measureText(text).width > width * 0.9 && size > 10) {
    size -= 4;
    ctx.font = font.replace(/\d+px/, `${size}px`);
  }
  ctx.fillText(text, width / 2, sub ? height * 0.38 : height / 2);
  if (sub) {
    ctx.shadowBlur = 0;
    ctx.font = `600 ${Math.round(height * 0.13)}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = subColor;
    ctx.fillText(sub, width / 2, height * 0.78);
  }
  const tex = finish(canvas, { repeat: false });
  cache.set(key, tex);
  return tex;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function disposeTextureCache() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
  for (const m of matCache.values()) m.material.dispose();
  matCache.clear();
}
