/**
 * Gestionnaire de paquets : catalogue des applications connues (manifestes)
 * et ensemble des applications installées.
 *
 * Un manifeste décrit une application :
 *   { id, name, icon, color: [from, to], category, system, preinstalled,
 *     version, description, permissions: [], intents: [{ action, types }],
 *     shortcuts: [{ label, icon, intent }], load: () => import(...) }
 */
const REQUIRED = ['id', 'name'];

export class PackageManager {
  #available = new Map();
  #installed = new Set();

  constructor({ store = null, events = null, log = null, now = Date.now } = {}) {
    this.store = store;
    this.events = events;
    this.log = log;
    this.now = now;
    this.installDates = {};
  }

  register(manifest) {
    for (const key of REQUIRED) {
      if (!manifest?.[key]) throw new Error(`Manifeste invalide : champ "${key}" manquant`);
    }
    const pkg = {
      version: '1.0.0',
      category: 'Utilitaires',
      system: false,
      preinstalled: false,
      permissions: [],
      intents: [],
      shortcuts: [],
      description: '',
      size: 1,
      ...manifest,
    };
    this.#available.set(pkg.id, Object.freeze(pkg));
    if (pkg.system) this.#installed.add(pkg.id);
    return pkg;
  }

  async load() {
    const stored = this.store ? Object.fromEntries(await this.store.entries()) : {};
    const saved = stored.installed;
    this.installDates = stored.dates ?? {};
    if (Array.isArray(saved)) {
      saved.filter((id) => this.#available.has(id)).forEach((id) => this.#installed.add(id));
    } else {
      // Premier démarrage : on installe les applications fournies d'usine.
      for (const pkg of this.#available.values()) {
        if (pkg.preinstalled || pkg.system) this.#installed.add(pkg.id);
      }
      this.#persist();
    }
    return this;
  }

  #persist() {
    this.store?.put('installed', [...this.#installed]);
    this.store?.put('dates', this.installDates);
  }

  get(id) {
    return this.#available.get(id) ?? null;
  }

  has(id) {
    return this.#available.has(id);
  }

  isInstalled(id) {
    return this.#installed.has(id);
  }

  /** @param {{ installed?: boolean | null }} [options] null = tout le catalogue */
  list({ installed = true } = {}) {
    const all = [...this.#available.values()];
    const filtered = installed === null ? all : all.filter((p) => this.#installed.has(p.id) === installed);
    return filtered.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  async install(id) {
    const pkg = this.get(id);
    if (!pkg) throw new Error(`Paquet introuvable : ${id}`);
    if (this.#installed.has(id)) return pkg;
    this.#installed.add(id);
    this.installDates[id] = this.now();
    this.#persist();
    this.log?.info('pm', `installé : ${id} ${pkg.version}`);
    this.events?.emit('package:install', { id });
    return pkg;
  }

  /** Retire une app du catalogue (app du Store supprimée par son développeur). */
  unregister(id) {
    const pkg = this.get(id);
    if (!pkg || pkg.system) return false;
    const installed = this.#installed.delete(id);
    this.#available.delete(id);
    if (installed) {
      delete this.installDates[id];
      this.#persist();
      this.events?.emit('package:uninstall', { id });
    }
    return true;
  }

  async uninstall(id) {
    const pkg = this.get(id);
    if (!pkg) throw new Error(`Paquet introuvable : ${id}`);
    if (pkg.system) throw new Error(`${pkg.name} est une application système et ne peut pas être supprimée`);
    if (!this.#installed.delete(id)) return false;
    delete this.installDates[id];
    this.#persist();
    this.log?.info('pm', `désinstallé : ${id}`);
    this.events?.emit('package:uninstall', { id });
    return true;
  }
}
