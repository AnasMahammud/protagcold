// Loads map JSON produced by tools/build_maps.py (shared with the server).
const cache = new Map();
let indexPromise = null;

export function loadMapIndex() {
  if (!indexPromise) {
    indexPromise = fetch('assets/maps/index.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`Map index missing (HTTP ${r.status}). Run: python tools/build_maps.py`);
        return r.json();
      })
      .then((j) => j.maps)
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

export async function loadMap(id) {
  if (cache.has(id)) return cache.get(id);
  const res = await fetch(`assets/maps/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load map "${id}" (HTTP ${res.status})`);
  const data = await res.json();
  cache.set(id, data);
  return data;
}
