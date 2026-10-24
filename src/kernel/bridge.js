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

  /** Le pont n'existe que lorsqu'Orion est servi par orion-server : adresse locale, à la racine. */
  get #reachable() {
    const where = this.env.location;
    if (!LOOPBACK.has(where?.hostname) || typeof this.env.fetch !== 'function') return false;
    return !where.pathname || /^\/(index\.html)?$/.test(where.pathname);
  }

  /**
   * Cherche orion-server (une seule fois, au démarrage). Le délai est large : sur une
   * machine Orion le serveur est toujours là, mais certaines détections du matériel sont lentes.
   */
  async detect({ timeout = 10_000 } = {}) {
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
 *
 * - start(ms) démarre, ou change seulement la cadence (sans requête immédiate) ;
 * - restart() interroge tout de suite (après une action) : une réponse plus
 *   ancienne arrivée ensuite est ignorée ;
 * - push(état) transmet un état obtenu ailleurs (refresh) sans fausser la
 *   comparaison suivante ;
 * - dispose() arrête pour de bon (extinction) : rien ne peut le relancer.
 */
export class Poller {
  #timer = null;
  #running = false;
  #disposed = false;
  #generation = 0;
  #last = '';

  constructor({ fetch, onState, onError = null, interval = 5000, timers = globalThis, always = null }) {
    this.fetch = fetch;
    this.onState = onState;
    this.onError = onError;
    this.interval = interval;
    this.timers = timers;
    /** Si vrai, chaque relevé est transmis même inchangé (suivi d'un appel en cours). */
    this.always = always;
  }

  get running() {
    return this.#running;
  }

  start(interval = this.interval) {
    if (this.#disposed) return this;
    const changed = interval !== this.interval;
    this.interval = interval;
    if (!this.#running) {
      this.#running = true;
      this.#loop(this.#generation);
    } else if (changed && this.#timer !== null) {
      // Nouvelle cadence : la prochaine interrogation est reprogrammée, sans requête de plus.
      this.timers.clearTimeout(this.#timer);
      this.#schedule(this.#generation);
    }
    return this;
  }

  /** Interroge tout de suite (après une action) en conservant la cadence. */
  restart() {
    if (!this.#running || this.#disposed) return this;
    this.timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#loop(++this.#generation);
    return this;
  }

  /** État obtenu hors du poller (refresh) : transmis et retenu pour la comparaison suivante. */
  push(state) {
    if (this.#disposed) return;
    this.#last = JSON.stringify(state);
    this.onState(state);
  }

  stop() {
    this.#running = false;
    this.#generation++;
    this.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  dispose() {
    this.stop();
    this.#disposed = true;
  }

  #schedule(generation) {
    this.#timer = this.timers.setTimeout(() => this.#loop(generation), this.interval);
  }

  async #loop(generation) {
    this.#timer = null;
    let state;
    let failed = null;
    try {
      state = await this.fetch();
    } catch (error) {
      failed = error;
    }
    // Arrêté, ou une interrogation plus récente a été lancée entre-temps : cette réponse est périmée.
    if (generation !== this.#generation || !this.#running) return;
    if (failed) this.onError?.(failed);
    else {
      const key = JSON.stringify(state);
      if (key !== this.#last || this.always?.()) {
        this.#last = key;
        this.onState(state);
      }
    }
    if (generation === this.#generation && this.#running && this.#timer === null) this.#schedule(generation);
  }
}
