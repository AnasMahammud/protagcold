// Minimal typed-by-convention event bus used to decouple gameplay, UI, audio and effects.

export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${type}" threw`, err);
      }
    }
  }

  clear() {
    this.handlers.clear();
  }
}

/** Global bus shared by every system. */
export const bus = new EventBus();
