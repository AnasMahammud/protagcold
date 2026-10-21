// Loads the shared gameplay configuration (config/game.json).
// The same file is read by the Python server, so tuning values live in exactly one place.

let CONFIG = null;

export async function loadConfig(url = 'config/game.json') {
  if (CONFIG) return CONFIG;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  CONFIG = deepFreeze(await res.json());
  return CONFIG;
}

export function getConfig() {
  if (!CONFIG) throw new Error('Config not loaded yet - call loadConfig() first');
  return CONFIG;
}

/** For tests: install a config object directly. */
export function setConfig(cfg) {
  CONFIG = deepFreeze(cfg);
  return CONFIG;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
