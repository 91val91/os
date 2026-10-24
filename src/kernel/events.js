/**
 * Bus d'événements du noyau.
 * Chaque service publie ses changements ici ; l'interface système et les
 * applications s'y abonnent. Le type "*" reçoit tous les événements.
 */
export class EventBus {
  #listeners = new Map();

  /** @param {(error: unknown, type: string) => void} [onError] */
  constructor(onError) {
    this.onError = onError ?? ((error, type) => console.error(`[events] ${type}`, error));
  }

  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload, t) => {
      off();
      fn(payload, t);
    });
    return off;
  }

  emit(type, payload) {
    for (const key of [type, '*']) {
      const set = this.#listeners.get(key);
      if (!set) continue;
      for (const fn of [...set]) {
        try {
          fn(payload, type);
        } catch (error) {
          this.onError(error, type);
        }
      }
    }
  }

  listenerCount(type) {
    return this.#listeners.get(type)?.size ?? 0;
  }
}
