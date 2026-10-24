/**
 * Couche de stockage persistant (clé → valeur).
 * Trois pilotes : IndexedDB (navigateur), localStorage (secours) et mémoire
 * (tests, navigation privée). Les services du noyau reçoivent un espace de
 * noms isolé via `Namespace`.
 */

export class MemoryBackend {
  kind = 'memory';
  #map = new Map();

  async getAll() {
    return [...this.#map].map(([k, v]) => [k, structuredClone(v)]);
  }

  async put(key, value) {
    this.#map.set(key, structuredClone(value));
  }

  async delete(key) {
    this.#map.delete(key);
  }

  async clear() {
    this.#map.clear();
  }
}

export class LocalStorageBackend {
  kind = 'localStorage';

  constructor(storage, prefix = 'orion:') {
    this.storage = storage;
    this.prefix = prefix;
  }

  async getAll() {
    const out = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(this.prefix)) continue;
      try {
        out.push([key.slice(this.prefix.length), JSON.parse(this.storage.getItem(key))]);
      } catch {
        /* entrée corrompue : ignorée */
      }
    }
    return out;
  }

  async put(key, value) {
    this.storage.setItem(this.prefix + key, JSON.stringify(value));
  }

  async delete(key) {
    this.storage.removeItem(this.prefix + key);
  }

  async clear() {
    const keys = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(this.prefix)) keys.push(key);
    }
    keys.forEach((k) => this.storage.removeItem(k));
  }
}

export class IndexedDBBackend {
  kind = 'indexedDB';

  constructor(idb, name = 'orion-os') {
    this.idb = idb;
    this.name = name;
    this.db = null;
  }

  open() {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      const req = this.idb.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        // Base supprimée ailleurs (compte effacé) : on libère la connexion pour ne pas bloquer.
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloqué'));
    });
    return this.db;
  }

  async #tx(mode, run) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const result = run(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Transaction annulée'));
    });
  }

  getAll() {
    return this.#tx('readonly', (store) => {
      const keys = store.getAllKeys();
      const values = store.getAll();
      return () => keys.result.map((k, i) => [k, values.result[i]]);
    });
  }

  put(key, value) {
    return this.#tx('readwrite', (store) => void store.put(value, key));
  }

  delete(key) {
    return this.#tx('readwrite', (store) => void store.delete(key));
  }

  clear() {
    return this.#tx('readwrite', (store) => void store.clear());
  }
}

/** Préfixe localStorage d'une base (« orion: » pour la base d'origine, d'avant les comptes). */
const prefixFor = (name) => (name === 'orion-os' ? 'orion:' : `${name}:`);

/** Choisit le meilleur pilote disponible dans l'environnement pour la base `name`. */
export async function openBestBackend(env = globalThis, { name = 'orion-os' } = {}) {
  if (env.indexedDB) {
    try {
      const backend = new IndexedDBBackend(env.indexedDB, name);
      await backend.open();
      return backend;
    } catch {
      /* on passe au pilote suivant */
    }
  }
  try {
    if (env.localStorage) {
      const probe = '__orion_probe__';
      env.localStorage.setItem(probe, '1');
      env.localStorage.removeItem(probe);
      return new LocalStorageBackend(env.localStorage, prefixFor(name));
    }
  } catch {
    /* stockage indisponible */
  }
  return new MemoryBackend();
}

/**
 * Efface une base, quel que soit le pilote qui l'a créée. Renvoie false si
 * elle est encore ouverte ailleurs : l'effacement aura lieu à sa fermeture.
 */
export async function deleteBackend(env = globalThis, name) {
  try {
    if (env.localStorage) await new LocalStorageBackend(env.localStorage, prefixFor(name)).clear();
  } catch {
    /* stockage indisponible */
  }
  if (!env.indexedDB) return true;
  return new Promise((resolve, reject) => {
    const req = env.indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(false);
  });
}

/** Vue préfixée d'un pilote : chaque service a son propre espace de clés. */
export class Namespace {
  /**
   * @param {object} backend
   * @param {string} name
   * @param {Array<[string, unknown]>} [snapshot] contenu complet déjà lu au démarrage,
   *   pour éviter de relire tout le stockage pour chaque service.
   */
  constructor(backend, name, snapshot) {
    this.backend = backend;
    this.prefix = `${name}:`;
    this.snapshot = snapshot;
    this.onError = (error) => console.error(`[storage:${name}]`, error);
  }

  async entries() {
    const all = this.snapshot ?? (await this.backend.getAll());
    this.snapshot = undefined;
    return all
      .filter(([k]) => typeof k === 'string' && k.startsWith(this.prefix))
      .map(([k, v]) => [k.slice(this.prefix.length), v]);
  }

  async get(key) {
    const entries = await this.entries();
    return entries.find(([k]) => k === key)?.[1];
  }

  put(key, value) {
    return this.backend.put(this.prefix + key, value).catch(this.onError);
  }

  delete(key) {
    return this.backend.delete(this.prefix + key).catch(this.onError);
  }
}
