/**
 * Pont matériel : client de orion-server, le service natif d'Orion installé
 * (image pour PC, tablette ou machine virtuelle). Il pilote le vrai matériel
 * par NetworkManager, BlueZ, ModemManager et gpsd (voir server/API.md).
 *
 * Orion installé est servi par orion-server lui-même sur http://127.0.0.1:8080 :
 * l'API est donc sur la même origine, sous api/. Dans un navigateur ordinaire
 * (téléphone, GitHub Pages) il n'y a pas de pont : les services se rabattent
 * sur les API du navigateur.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class BridgeError extends Error {}

export class HardwareBridge {
  constructor({ env = globalThis, log = null, timeout = 8000 } = {}) {
    this.env = env;
    this.log = log;
    this.timeout = timeout;
    this.available = false;
    this.simulated = false;
    this.capabilities = {};
    this.info = null;
  }

  /** Le pont n'existe que lorsqu'Orion est servi par orion-server (adresse locale). */
  get #reachable() {
    return LOOPBACK.has(this.env.location?.hostname) && typeof this.env.fetch === 'function';
  }

  async detect({ timeout = 1500 } = {}) {
    if (!this.#reachable) return this;
    try {
      const status = await this.get('status', { timeout });
      if (status?.bridge === 'orion-server') {
        this.available = true;
        this.simulated = Boolean(status.simulated);
        this.capabilities = status.capabilities ?? {};
        this.info = status;
        const caps = Object.entries(this.capabilities).filter(([, on]) => on).map(([name]) => name);
        this.log?.info('bridge', `orion-server ${status.version ?? ''}${this.simulated ? ' (matériel simulé)' : ''} : ${caps.join(', ') || 'aucun matériel'}`);
      }
    } catch {
      /* pas de pont : API du navigateur */
    }
    return this;
  }

  has(capability) {
    return this.available && Boolean(this.capabilities[capability]);
  }

  async #request(method, path, body, { timeout = this.timeout } = {}) {
    const controller = typeof this.env.AbortController === 'function' ? new this.env.AbortController() : null;
    const timer = controller && timeout ? setTimeout(() => controller.abort(), timeout) : null;
    let response;
    try {
      response = await this.env.fetch(`api/${path}`, {
        method,
        cache: 'no-store',
        signal: controller?.signal,
        // X-Orion + JSON : un site tiers ne peut pas envoyer cette requête sans pré-vol (refusé par le serveur).
        headers: method === 'POST' ? { 'X-Orion': '1', 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch (error) {
      throw new BridgeError(error?.name === 'AbortError' ? 'Le matériel ne répond pas' : 'Service matériel injoignable');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* corps vide ou invalide */
    }
    if (!response.ok) throw new BridgeError(data?.error ?? `Erreur du service matériel (${response.status})`);
    return data ?? {};
  }

  get(path, options) {
    return this.#request('GET', path, null, options);
  }

  post(path, body, options) {
    return this.#request('POST', path, body, options);
  }
}

/**
 * Interroge régulièrement le pont tant que quelqu'un écoute.
 * `fetch` renvoie l'état ; `onState` le reçoit (pas d'appel si inchangé).
 */
export class Poller {
  #timer = null;
  #running = false;
  #last = '';

  constructor({ fetch, onState, onError = null, interval = 5000, timers = globalThis }) {
    this.fetch = fetch;
    this.onState = onState;
    this.onError = onError;
    this.interval = interval;
    this.timers = timers;
  }

  get running() {
    return this.#running;
  }

  start(interval = this.interval) {
    this.interval = interval;
    if (this.#running) return this.restart();
    this.#running = true;
    this.#loop();
    return this;
  }

  /** Relance tout de suite (après une action) en conservant la cadence. */
  restart() {
    if (!this.#running) return this;
    this.timers.clearTimeout(this.#timer);
    this.#loop();
    return this;
  }

  stop() {
    this.#running = false;
    this.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #loop() {
    this.#timer = null;
    try {
      const state = await this.fetch();
      const key = JSON.stringify(state);
      if (key !== this.#last) {
        this.#last = key;
        this.onState(state);
      }
    } catch (error) {
      this.onError?.(error);
    }
    if (this.#running && this.#timer === null) this.#timer = this.timers.setTimeout(() => this.#loop(), this.interval);
  }
}
