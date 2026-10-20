/**
 * Utilitaires partagés par les tests.
 */
import { MemoryBackend, Namespace } from '../src/kernel/storage.js';
import { EventBus } from '../src/kernel/events.js';

export function memoryStore(name = 'test', backend = new MemoryBackend()) {
  return new Namespace(backend, name);
}

/** Horloge contrôlable. */
export function fakeClock(start = new Date(2026, 0, 15, 10, 0, 0).getTime()) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  now.set = (value) => (t = value);
  return now;
}

/** Minuteries manuelles pour les services qui planifient des rappels. */
export function fakeTimers(clock) {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock() + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Avance le temps et exécute les minuteries échues, dans l'ordre. */
    advance(ms) {
      const target = clock() + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock.set(due[1].at);
        due[1].fn();
      }
      clock.set(target);
    },
    get size() {
      return pending.size;
    },
  };
}

/** Enregistre les événements émis sur un bus. */
export function recorder(events = new EventBus()) {
  const log = [];
  events.on('*', (payload, type) => log.push({ type, payload }));
  return { events, log, of: (type) => log.filter((e) => e.type === type).map((e) => e.payload) };
}
