/**
 * Réseau : état réel de la connexion et, avec le pont matériel, pilotage du Wi‑Fi.
 *
 * - Orion installé (orion-server) : NetworkManager. Recherche des réseaux,
 *   connexion avec mot de passe, déconnexion, oubli, activation du Wi‑Fi,
 *   type de connexion (Wi‑Fi, Ethernet, réseau mobile) et adresse IP.
 * - Navigateur (téléphone) : la radio Wi‑Fi appartient à Android ou iOS. Orion
 *   affiche ce que le navigateur sait vraiment : en ligne ou non, type de
 *   connexion et débit estimé (Network Information API, Chrome sur Android).
 *
 * Le mode avion coupe les radios pilotées par le pont (Wi‑Fi, Bluetooth, modem) ;
 * dans un navigateur il coupe les services d'Orion (appels, SMS, Bluetooth).
 */
import { Poller } from './bridge.js';

const TYPES = { wifi: 'wifi', ethernet: 'ethernet', gsm: 'cellular', cdma: 'cellular', cellular: 'cellular', bluetooth: 'other', wimax: 'other', other: 'other', none: 'none' };

/** Barres de signal (0 à 4) à partir d'un pourcentage. */
export const signalBars = (percent) => (percent == null ? 0 : percent >= 75 ? 4 : percent >= 50 ? 3 : percent >= 25 ? 2 : percent > 0 ? 1 : 0);

/** Qualité estimée par le navigateur (effectiveType) → barres. */
const QUALITY_BARS = { '4g': 4, '3g': 3, '2g': 2, 'slow-2g': 1 };

export class NetworkService {
  #wifi = null; // état Wi‑Fi du pont
  #link = null; // connexion principale vue par le pont (GET api/network)
  #poller = null;
  #radios = null; // états des radios avant le mode avion

  constructor({ events = null, settings = null, env = globalThis, bridge = null, log = null, timers = globalThis } = {}) {
    this.events = events;
    this.settings = settings;
    this.env = env;
    this.bridge = bridge;
    this.log = log;
    this.timers = timers;
    this.online = env.navigator?.onLine ?? true;
    /** Hooks fournis par le noyau pour le mode avion (Bluetooth, modem). */
    this.radios = [];
  }

  /** Wi‑Fi piloté par orion-server. */
  get controllable() {
    return Boolean(this.bridge?.has('wifi'));
  }

  init() {
    this.env.addEventListener?.('online', () => this.#setOnline(true));
    this.env.addEventListener?.('offline', () => this.#setOnline(false));
    this.env.navigator?.connection?.addEventListener?.('change', () => this.#emit());
    if (this.bridge?.has('wifi') || this.bridge?.has('network')) {
      this.#poller = new Poller({
        timers: this.timers,
        interval: 10_000,
        fetch: () => this.#fetchBridge(),
        onState: ({ wifi, link }) => {
          this.#wifi = wifi;
          this.#link = link;
          this.#emit();
        },
        onError: (error) => this.log?.warn('net', error.message),
      }).start();
    }
    this.settings?.watch('airplane', (on) => this.#applyAirplane(Boolean(on)));
    return this;
  }

  shutdown() {
    this.#poller?.stop();
  }

  async #fetchBridge({ rescan = false } = {}) {
    const [wifi, link] = await Promise.all([
      this.bridge.has('wifi') ? this.bridge.get(`wifi${rescan ? '?rescan=1' : ''}`, { timeout: rescan ? 20_000 : 8000 }) : null,
      this.bridge.has('network') ? this.bridge.get('network').catch(() => null) : null,
    ]);
    return { wifi, link };
  }

  #setOnline(online) {
    this.online = online;
    this.#emit();
  }

  #emit() {
    this.events?.emit('network:change', this.state);
  }

  /** Informations du navigateur (Network Information API) : absentes sur iOS et Firefox. */
  get #connection() {
    const c = this.env.navigator?.connection;
    if (!c) return null;
    return { type: c.type ?? null, quality: c.effectiveType ?? null, downlink: c.downlink ?? null, rtt: c.rtt ?? null, saveData: Boolean(c.saveData) };
  }

  get state() {
    const airplane = Boolean(this.settings?.get('airplane'));
    const browser = this.#connection;
    const wifi = this.#wifi;
    let type;
    let online = this.online;
    if (this.bridge?.available && (wifi || this.#link)) {
      const link = this.#link;
      if (link) {
        type = link.primary ? TYPES[link.primary.type] ?? 'other' : 'none';
        if (link.connectivity === 'none') online = false;
      } else {
        type = wifi?.connected ? 'wifi' : 'unknown';
      }
    } else {
      type = browser?.type ? TYPES[browser.type] ?? (browser.type === 'unknown' ? 'unknown' : 'other') : online ? 'unknown' : 'none';
    }
    if (!online) type = 'none';
    return {
      airplane,
      online,
      type,
      source: this.controllable ? 'bridge' : 'browser',
      quality: browser?.quality ?? null,
      qualityBars: QUALITY_BARS[browser?.quality] ?? null,
      downlink: browser?.downlink ?? null,
      rtt: browser?.rtt ?? null,
      saveData: browser?.saveData ?? false,
      ip: this.#link?.primary?.ip ?? wifi?.connected?.ip ?? null,
      primary: this.#link?.primary ?? null,
      wifi: {
        controllable: this.controllable,
        enabled: wifi ? Boolean(wifi.enabled) : type === 'wifi',
        connected: wifi?.connected ?? null,
        networks: wifi?.networks ?? [],
      },
    };
  }

  // ───────────── Wi‑Fi (pont) ─────────────

  #requireBridge() {
    if (!this.controllable) throw new Error('Le Wi‑Fi de cet appareil est géré par son système (Android, iOS…).');
  }

  /** Relit l'état (avec une nouvelle recherche des réseaux si demandé). */
  async refresh({ rescan = false } = {}) {
    if (!this.bridge?.available) return this.state;
    const { wifi, link } = await this.#fetchBridge({ rescan });
    this.#wifi = wifi;
    this.#link = link;
    this.#emit();
    return this.state;
  }

  /** Cadence de rafraîchissement : rapide pendant qu'une page Wi‑Fi est ouverte. */
  watch() {
    if (!this.#poller) return () => {};
    this.#poller.start(4000);
    return () => this.#poller.start(10_000);
  }

  async #act(path, body, message) {
    this.#requireBridge();
    await this.bridge.post(path, body, { timeout: 45_000 });
    if (message) this.log?.info('net', message);
    await this.refresh().catch(() => {});
  }

  setWifiEnabled(enabled) {
    return this.#act('wifi/power', { enabled: Boolean(enabled) }, `Wi‑Fi ${enabled ? 'activé' : 'désactivé'}`);
  }

  connect(ssid, password) {
    const body = { ssid };
    if (password) body.password = password;
    return this.#act('wifi/connect', body, `connexion à « ${ssid} »`);
  }

  disconnect() {
    return this.#act('wifi/disconnect', {}, 'Wi‑Fi déconnecté');
  }

  forget(ssid) {
    return this.#act('wifi/forget', { ssid }, `réseau « ${ssid} » oublié`);
  }

  // ───────────── Mode avion ─────────────

  async #applyAirplane(on) {
    this.#emit();
    if (!this.bridge?.available) return;
    const radios = [];
    if (this.controllable) radios.push({ name: 'wifi', get: () => this.#wifi?.enabled ?? true, set: (v) => this.setWifiEnabled(v) });
    radios.push(...this.radios);
    if (on) {
      this.#radios = {};
      for (const radio of radios) {
        this.#radios[radio.name] = radio.get();
        await radio.set(false).catch((error) => this.log?.warn('net', `mode avion (${radio.name}) : ${error.message}`));
      }
      this.settings?.set('airplane.radios', this.#radios);
    } else {
      const saved = this.#radios ?? this.settings?.get('airplane.radios') ?? {};
      for (const radio of radios) {
        if (saved[radio.name] === false) continue;
        await radio.set(true).catch((error) => this.log?.warn('net', `mode avion (${radio.name}) : ${error.message}`));
      }
      this.#radios = null;
    }
  }

  // ───────────── Test de connexion ─────────────

  /**
   * Mesure la latence (aller-retour vers le serveur d'Orion) et, si possible,
   * le débit descendant (téléchargement de 5 Mo depuis Cloudflare).
   */
  async speedTest({ bytes = 5_000_000 } = {}) {
    const now = () => this.env.performance?.now?.() ?? Date.now();
    const fetch = this.env.fetch;
    let latency = null;
    for (let i = 0; i < 3; i++) {
      const start = now();
      try {
        // version.json n'est jamais servi par le cache : c'est un vrai aller-retour.
        await fetch('version.json', { method: 'HEAD', cache: 'no-store' });
        latency = Math.min(latency ?? Infinity, now() - start);
      } catch {
        break;
      }
    }
    if (latency == null) throw new Error('Pas de connexion à Internet');
    let download = null;
    try {
      const start = now();
      const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, { cache: 'no-store' });
      if (response.ok) {
        const size = (await response.arrayBuffer()).byteLength;
        const seconds = (now() - start) / 1000;
        if (size > 100_000 && seconds > 0) download = (size * 8) / seconds / 1e6;
      }
    } catch {
      /* débit non mesurable (bloqué ou hors ligne) : on garde la latence */
    }
    return { latency: Math.round(latency), download: download == null ? null : Math.round(download * 10) / 10 };
  }
}
