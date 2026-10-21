import { sha256Hex } from '../lib/sha256.js';

/**
 * Service de réglages : valeurs par défaut + surcharges persistées.
 */
export const DEFAULT_SETTINGS = {
  setupDone: false,
  userName: 'Utilisateur',
  deviceName: 'Orion',
  // Apparence
  theme: 'auto', // auto | light | dark
  accent: '#0a84ff',
  wallpaper: 'aurora',
  iconShape: 'squircle', // squircle | circle | rounded
  fontScale: 1,
  brightness: 1,
  nightShift: false,
  use24h: true,
  showBatteryPercent: true,
  // Navigation
  navigation: 'gestures', // gestures | buttons
  // Connectivité
  wifi: true,
  wifiNetwork: 'Orion-Maison',
  bluetooth: false,
  airplane: false,
  cellular: true,
  location: true,
  // Sons
  volume: 0.6,
  silent: false,
  sounds: true,
  haptics: true,
  dnd: false,
  // Écran & sécurité
  autoLock: 120, // secondes, 0 = jamais
  passcode: null, // { salt, hash }
  rotationLock: true,
  batterySaver: false,
  flashlight: false,
  // Lanceur
  homeLayout: null,
  // Développeur
  developer: false,
  animScale: 1,
  showTouches: false,
};

export class Settings {
  #values = {};
  #watchers = new Map();

  constructor({ store = null, events = null, defaults = DEFAULT_SETTINGS } = {}) {
    this.store = store;
    this.events = events;
    this.defaults = defaults;
  }

  async load() {
    if (!this.store) return this;
    for (const [key, value] of await this.store.entries()) this.#values[key] = value;
    return this;
  }

  get(key) {
    return key in this.#values ? this.#values[key] : this.defaults[key];
  }

  has(key) {
    return key in this.#values || key in this.defaults;
  }

  all() {
    return { ...this.defaults, ...this.#values };
  }

  set(key, value) {
    if (key in this.#values && JSON.stringify(this.#values[key]) === JSON.stringify(value)) return;
    this.#values[key] = value;
    this.store?.put(key, value);
    this.#changed(key, value);
  }

  patch(values) {
    for (const [key, value] of Object.entries(values)) this.set(key, value);
  }

  reset(key) {
    delete this.#values[key];
    this.store?.delete(key);
    this.#changed(key, this.get(key));
  }

  toggle(key) {
    this.set(key, !this.get(key));
    return this.get(key);
  }

  #changed(key, value) {
    for (const k of [key, '*']) {
      for (const fn of this.#watchers.get(k) ?? []) {
        try {
          fn(value, key);
        } catch (error) {
          console.error('[settings] watcher', error);
        }
      }
    }
    this.events?.emit('settings:change', { key, value });
  }

  /** Observe une clé (ou "*") ; renvoie la fonction de désabonnement. */
  watch(key, fn) {
    let set = this.#watchers.get(key);
    if (!set) this.#watchers.set(key, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
}

/**
 * Hachage d'un code de verrouillage (SHA-256 salé). Web Crypto n'existe qu'en
 * contexte sécurisé : en http sur le réseau local, on utilise l'implémentation JS.
 */
export async function hashPasscode(code, salt) {
  const data = new TextEncoder().encode(`${salt}:${code}`);
  if (!globalThis.crypto?.subtle) return sha256Hex(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createPasscode(code) {
  const salt = [...globalThis.crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { salt, hash: await hashPasscode(code, salt), length: String(code).length };
}

export async function verifyPasscode(record, code) {
  if (!record) return true;
  return (await hashPasscode(code, record.salt)) === record.hash;
}
