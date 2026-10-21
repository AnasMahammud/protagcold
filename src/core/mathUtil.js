// Small math helpers shared across systems (no three.js dependency so they run in tests and workers).

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential smoothing factor. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export function dampAngle(current, target, lambda, dt) {
  const diff = wrapAngle(target - current);
  return current + diff * (1 - Math.exp(-lambda * dt));
}

export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Moves a 2D vector (x,z) toward a target vector by at most maxDelta. Returns [x, z]. */
export function moveTowards2(x, z, tx, tz, maxDelta) {
  const dx = tx - x;
  const dz = tz - z;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d === 0) return [tx, tz];
  return [x + (dx / d) * maxDelta, z + (dz / d) * maxDelta];
}

export const dist2 = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Deterministic PRNG (mulberry32) so maps, bots and tests are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatSeconds(seconds) {
  return `${seconds.toFixed(1)}s`;
}
