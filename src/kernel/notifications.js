/**
 * Centre de notifications.
 * Les applications publient des notifications ; l'interface système les
 * affiche (bannière, volet, écran verrouillé). Un `tag` permet de remplacer
 * une notification existante (comme sur Android).
 */
const LIMIT = 60;

export class NotificationService {
  #items = [];
  #nextId = 1;

  constructor({ store = null, events = null, settings = null, now = Date.now } = {}) {
    this.store = store;
    this.events = events;
    this.settings = settings;
    this.now = now;
  }

  async load() {
    const saved = this.store ? Object.fromEntries(await this.store.entries()) : {};
    if (Array.isArray(saved.items)) this.#items = saved.items;
    this.#nextId = Math.max(0, ...this.#items.map((n) => n.id)) + 1;
    return this;
  }

  #persist() {
    this.store?.put('items', this.#items);
  }

  isEnabledFor(appId) {
    return this.settings?.get(`notifications.${appId}`) !== false;
  }

  post({ appId, title, body = '', icon = null, intent = null, tag = null, silent = false, priority = 'default', actions = [] }) {
    if (!appId || !title) throw new Error('Une notification nécessite appId et title');
    if (!this.isEnabledFor(appId)) return null;
    const notification = {
      id: this.#nextId++,
      appId,
      title: String(title),
      body: String(body),
      icon,
      intent,
      tag,
      silent,
      priority,
      actions,
      time: this.now(),
      read: false,
    };
    if (tag) this.#items = this.#items.filter((n) => !(n.appId === appId && n.tag === tag));
    this.#items.unshift(notification);
    this.#items.length = Math.min(this.#items.length, LIMIT);
    this.#persist();
    this.events?.emit('notification:post', notification);
    return notification;
  }

  list({ appId } = {}) {
    return this.#items.filter((n) => !appId || n.appId === appId);
  }

  get(id) {
    return this.#items.find((n) => n.id === id) ?? null;
  }

  unreadCount(appId) {
    return this.#items.filter((n) => !n.read && (!appId || n.appId === appId)).length;
  }

  dismiss(id) {
    const before = this.#items.length;
    this.#items = this.#items.filter((n) => n.id !== id);
    if (this.#items.length === before) return false;
    this.#persist();
    this.events?.emit('notification:dismiss', { id });
    return true;
  }

  /** Supprime les notifications (toutes, d'une application ou d'un tag). */
  clear({ appId, tag } = {}) {
    const removed = this.#items.filter((n) => (!appId || n.appId === appId) && (!tag || n.tag === tag));
    if (!removed.length) return 0;
    const ids = new Set(removed.map((n) => n.id));
    this.#items = this.#items.filter((n) => !ids.has(n.id));
    this.#persist();
    removed.forEach((n) => this.events?.emit('notification:dismiss', { id: n.id }));
    return removed.length;
  }

  markAllRead(appId) {
    let changed = false;
    for (const n of this.#items) {
      if (!n.read && (!appId || n.appId === appId)) {
        n.read = true;
        changed = true;
      }
    }
    if (changed) {
      this.#persist();
      this.events?.emit('notification:read', { appId });
    }
  }
}
