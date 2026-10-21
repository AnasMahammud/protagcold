// Safe localStorage wrapper. Storage can throw (private mode, blocked site data),
// so every access is guarded and the game keeps working with in-memory fallbacks.

const PREFIX = 'protag.';
const memory = new Map();

export function loadJSON(key, fallback) {
  const k = PREFIX + key;
  try {
    const raw = window.localStorage.getItem(k);
    if (raw == null) return memory.has(k) ? structuredClone(memory.get(k)) : fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[storage] could not read ${k}`, err);
    return memory.has(k) ? structuredClone(memory.get(k)) : fallback;
  }
}

export function saveJSON(key, value) {
  const k = PREFIX + key;
  memory.set(k, structuredClone(value));
  try {
    window.localStorage.setItem(k, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[storage] could not write ${k}`, err);
    return false;
  }
}

export function removeKey(key) {
  const k = PREFIX + key;
  memory.delete(k);
  try {
    window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function loadSession(key, fallback) {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveSession(key, value) {
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
