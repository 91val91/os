/**
 * Service d'alarmes (équivalent de l'AlarmManager d'Android).
 *
 * Les applications planifient des déclenchements qui survivent à leur
 * fermeture : réveils (heure + jours de répétition), minuteurs et rappels.
 * L'interface système appelle `tick()` chaque seconde ; les alarmes échues
 * sont émises via l'événement "alarm:fire".
 */
const DAY = 86_400_000;

/**
 * Prochaine occurrence de hh:mm strictement après `from`.
 * @param {number[] | null} days jours autorisés (0 = dimanche), null = tous.
 */
export function nextOccurrence(hour, minute, days, from) {
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setHours(hour, minute);
  for (let i = 0; i < 8; i++) {
    if (date.getTime() > from && (!days?.length || days.includes(date.getDay()))) return date.getTime();
    date.setDate(date.getDate() + 1);
    date.setHours(hour, minute, 0, 0);
  }
  return from + DAY;
}

export class AlarmService {
  #alarms = [];
  #nextId = 1;

  constructor({ store = null, events = null, now = Date.now, log = null } = {}) {
    this.store = store;
    this.events = events;
    this.now = now;
    this.log = log;
  }

  async load() {
    const saved = this.store ? Object.fromEntries(await this.store.entries()) : {};
    if (Array.isArray(saved.alarms)) this.#alarms = saved.alarms;
    this.#nextId = Math.max(0, ...this.#alarms.map((a) => a.id)) + 1;
    // Réarme les alarmes répétitives dont l'heure est passée pendant l'arrêt.
    const t = this.now();
    for (const alarm of this.#alarms) {
      if (alarm.enabled && alarm.at <= t && alarm.days?.length) {
        alarm.at = nextOccurrence(alarm.hour, alarm.minute, alarm.days, t);
      }
    }
    return this;
  }

  #persist() {
    this.store?.put('alarms', this.#alarms);
    this.events?.emit('alarm:change', { alarms: this.list() });
  }

  /**
   * @param {object} options
   * @param {string} options.appId
   * @param {'alarm'|'timer'|'reminder'} [options.kind]
   * @param {number} [options.at] horodatage absolu (minuteurs, rappels)
   * @param {number} [options.hour] heure (réveils)
   * @param {number} [options.minute]
   * @param {number[]} [options.days] jours de répétition
   */
  schedule({ appId, kind = 'alarm', at, hour, minute, days = [], label = '', payload = null, enabled = true, duration = null }) {
    if (!appId) throw new Error('appId requis');
    const t = this.now();
    let when = at;
    if (when == null) {
      if (hour == null || minute == null) throw new Error('Préciser `at` ou `hour`/`minute`');
      when = nextOccurrence(hour, minute, days, t);
    }
    const alarm = {
      id: this.#nextId++,
      appId,
      kind,
      at: when,
      hour: hour ?? null,
      minute: minute ?? null,
      days: [...days],
      label,
      payload,
      enabled,
      duration,
      createdAt: t,
    };
    this.#alarms.push(alarm);
    this.#persist();
    this.log?.info('alarm', `${kind} #${alarm.id} planifié pour ${new Date(when).toISOString()}`);
    return { ...alarm };
  }

  update(id, patch) {
    const alarm = this.#alarms.find((a) => a.id === id);
    if (!alarm) return null;
    Object.assign(alarm, patch);
    if (alarm.hour != null && ('hour' in patch || 'minute' in patch || 'days' in patch || patch.enabled)) {
      alarm.at = nextOccurrence(alarm.hour, alarm.minute, alarm.days, this.now());
    }
    this.#persist();
    return { ...alarm };
  }

  cancel(id) {
    const before = this.#alarms.length;
    this.#alarms = this.#alarms.filter((a) => a.id !== id);
    if (before === this.#alarms.length) return false;
    this.#persist();
    return true;
  }

  cancelApp(appId) {
    this.#alarms = this.#alarms.filter((a) => a.appId !== appId);
    this.#persist();
  }

  get(id) {
    const alarm = this.#alarms.find((a) => a.id === id);
    return alarm ? { ...alarm } : null;
  }

  list(appId) {
    return this.#alarms
      .filter((a) => !appId || a.appId === appId)
      .map((a) => ({ ...a }))
      .sort((a, b) => a.at - b.at);
  }

  /** Prochaine alarme active (éventuellement filtrée par type). */
  next({ appId, kind } = {}) {
    return (
      this.list(appId).find((a) => a.enabled && (!kind || a.kind === kind) && a.at > this.now()) ?? null
    );
  }

  /** Répète une alarme dans `minutes` minutes (bouton « Répéter »). */
  snooze(alarm, minutes = 9) {
    return this.schedule({
      appId: alarm.appId,
      kind: 'alarm',
      at: this.now() + minutes * 60_000,
      label: alarm.label,
      payload: { ...(alarm.payload ?? {}), snoozed: true },
    });
  }

  /** @param {{ kinds?: string[] }} [options] types à traiter (les autres attendent) */
  tick(now = this.now(), { kinds = null } = {}) {
    const fired = [];
    let changed = false;
    for (const alarm of [...this.#alarms]) {
      if (!alarm.enabled || alarm.at > now || (kinds && !kinds.includes(alarm.kind))) continue;
      fired.push({ ...alarm });
      changed = true;
      if (alarm.kind === 'alarm' && alarm.days?.length) {
        alarm.at = nextOccurrence(alarm.hour, alarm.minute, alarm.days, now);
      } else if (alarm.kind === 'alarm' && alarm.hour != null) {
        alarm.enabled = false; // réveil ponctuel : désactivé mais conservé
        alarm.at = nextOccurrence(alarm.hour, alarm.minute, [], now);
      } else {
        this.#alarms = this.#alarms.filter((a) => a.id !== alarm.id);
      }
    }
    if (changed) this.#persist();
    for (const alarm of fired) {
      this.log?.info('alarm', `déclenchement ${alarm.kind} #${alarm.id}`);
      this.events?.emit('alarm:fire', alarm);
    }
    return fired;
  }
}
