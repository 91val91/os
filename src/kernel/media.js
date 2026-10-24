/**
 * Session multimédia globale : l'application qui joue du son publie ses
 * métadonnées ; le centre de contrôle et l'écran verrouillé les affichent et
 * renvoient les commandes (lecture, pause, suivant…).
 */
export class MediaService {
  #session = null;
  #handlers = {};

  constructor({ events = null } = {}) {
    this.events = events;
  }

  set(appId, metadata, handlers = {}) {
    this.#session = { appId, title: '', artist: '', artwork: null, playing: false, position: 0, duration: 0, ...metadata };
    this.#handlers = handlers;
    this.events?.emit('media:change', this.get());
  }

  update(appId, patch) {
    if (this.#session?.appId !== appId) return;
    Object.assign(this.#session, patch);
    this.events?.emit('media:change', this.get());
  }

  clear(appId) {
    if (appId && this.#session?.appId !== appId) return;
    this.#session = null;
    this.#handlers = {};
    this.events?.emit('media:change', null);
  }

  get() {
    return this.#session ? { ...this.#session } : null;
  }

  /** @param {'play'|'pause'|'toggle'|'next'|'previous'|'seek'} action */
  command(action, value) {
    if (!this.#session) return false;
    const handler =
      this.#handlers[action] ?? (action === 'toggle' ? this.#handlers[this.#session.playing ? 'pause' : 'play'] : null);
    if (!handler) return false;
    handler(value);
    return true;
  }
}
