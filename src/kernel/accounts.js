/**
 * Comptes utilisateurs : plusieurs personnes partagent l'appareil, chacune
 * avec son profil (nom, e-mail, photo), son code et ses propres données
 * (fichiers, réglages, apps, contacts, messages).
 *
 * Le registre des comptes est stocké à part ; les données de chaque compte
 * vivent dans leur propre base. Celle du propriétaire, « orion-os », est la
 * base d'avant les comptes : un appareil déjà configuré garde ses données.
 */
import { Namespace, openBestBackend, deleteBackend } from './storage.js';

export const OWNER_DB = 'orion-os';
export const REGISTRY_DB = 'orion-accounts';

const COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff', '#5e5ce6', '#ff453a'];
const EDITABLE = ['name', 'email', 'color', 'photo', 'lastLogin', 'returnTo'];
const EMPTY = () => ({ accounts: [], current: null, removed: [], developer: null });

export class AccountRegistry {
  #data = EMPTY();
  #queue = Promise.resolve();

  /**
   * @param {object} options
   * @param {{ get(key: string): Promise<unknown>, put(key: string, value: unknown): Promise<unknown> }} options.store
   * @param {{ request(name: string, fn: () => Promise<unknown>): Promise<unknown> }} [options.locks] verrou partagé entre fenêtres (navigator.locks)
   * @param {{ postMessage(m: unknown): void, onmessage: unknown }} [options.channel] canal vers les autres fenêtres d'Orion (BroadcastChannel)
   */
  constructor({ store, now = Date.now, random = Math.random, locks = null, channel = null }) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.locks = locks;
    this.channel = channel;
    this.events = null;
    if (channel) channel.onmessage = () => this.load().then(() => this.events?.emit('account:change', {}));
  }

  async load() {
    const data = await this.store.get('registry');
    if (data) this.#data = { ...EMPTY(), ...data };
    return this;
  }

  /**
   * Applique une modification tout de suite en mémoire, puis à la copie
   * enregistrée relue juste avant l'écriture : une autre fenêtre d'Orion (app
   * installée et onglet, par exemple) a pu changer le registre entre-temps.
   */
  #commit(mutate) {
    mutate(this.#data);
    this.events?.emit('account:change', {});
    const write = async () => {
      const stored = await this.store.get('registry');
      if (stored) {
        this.#data = { ...EMPTY(), ...stored };
        mutate(this.#data);
      }
      await this.store.put('registry', structuredClone(this.#data));
      this.channel?.postMessage('change');
    };
    const run = () => (this.locks ? this.locks.request(REGISTRY_DB, write) : write());
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  /** Le propriétaire d'abord, puis par ordre de création. */
  list() {
    return this.#data.accounts.map((a) => ({ ...a })).sort((a, b) => Number(b.owner) - Number(a.owner) || a.createdAt - b.createdAt);
  }

  get(id) {
    const account = this.#data.accounts.find((a) => a.id === id);
    return account ? { ...account } : null;
  }

  get owner() {
    return this.list().find((a) => a.owner) ?? null;
  }

  get current() {
    return this.get(this.#data.current) ?? this.list()[0] ?? null;
  }

  /** Bases des comptes supprimés, à effacer au prochain démarrage. */
  get removed() {
    return [...this.#data.removed];
  }

  /**
   * Mode développeur de l'appareil, commun à tous les comptes : empreinte du
   * mot de passe et tentatives échouées (le blocage survit aux redémarrages).
   */
  get developer() {
    return { password: null, failures: 0, blockedUntil: 0, ...this.#data.developer };
  }

  setDeveloper(patch) {
    return this.#commit((data) => {
      data.developer = { ...data.developer, ...patch };
    });
  }

  create({ name = '', email = '', color = null, owner = false } = {}) {
    if (owner && this.owner) throw new Error('Il y a déjà un propriétaire');
    const id = owner ? 'owner' : `u${this.now().toString(36)}${Math.floor(this.random() * 1296).toString(36)}`;
    const account = {
      id,
      name: String(name).trim(),
      email: String(email).trim(),
      color: color ?? COLORS[this.#data.accounts.length % COLORS.length],
      photo: null,
      owner,
      db: owner ? OWNER_DB : `${OWNER_DB}-${id}`,
      createdAt: this.now(),
      lastLogin: null,
    };
    this.#commit((data) => {
      if (owner && data.accounts.some((a) => a.owner)) return;
      if (!data.accounts.some((a) => a.id === id)) data.accounts.push({ ...account });
      data.current ??= id;
    });
    return { ...account };
  }

  update(id, patch) {
    if (!this.get(id)) return null;
    const changes = {};
    for (const key of EDITABLE) if (key in patch) changes[key] = typeof patch[key] === 'string' && key !== 'photo' ? patch[key].trim() : patch[key];
    // Seulement si le compte existe encore dans la copie enregistrée (pas de résurrection).
    this.#commit((data) => Object.assign(data.accounts.find((a) => a.id === id) ?? {}, changes));
    return this.get(id);
  }

  setCurrent(id) {
    if (!this.get(id)) throw new Error('Compte introuvable');
    return this.#commit((data) => {
      if (data.accounts.some((a) => a.id === id)) data.current = id;
    });
  }

  /** Retire un compte ; sa base sera effacée au prochain démarrage (elle peut être ouverte). */
  remove(id) {
    const account = this.get(id);
    if (!account) return Promise.resolve(false);
    if (account.owner) throw new Error('Le compte du propriétaire ne peut pas être supprimé');
    return this.#commit((data) => {
      data.accounts = data.accounts.filter((a) => a.id !== id);
      if (!data.removed.includes(account.db)) data.removed.push(account.db);
      if (data.current === id) data.current = data.accounts.find((a) => a.owner)?.id ?? null;
    }).then(() => true);
  }

  forgetRemoved(db) {
    return this.#commit((data) => {
      data.removed = data.removed.filter((name) => name !== db);
    });
  }
}

/**
 * Ouvre la session du compte courant : registre, compte et stockage de ses
 * données. Au tout premier démarrage (ou sur un appareil d'avant les comptes),
 * le compte du propriétaire est créé ; son nom est complété par l'assistant.
 */
export async function openSession(env = globalThis) {
  const shared = await openBestBackend(env, { name: REGISTRY_DB });
  const registry = await new AccountRegistry({
    store: new Namespace(shared, 'accounts'),
    locks: env.navigator?.locks ?? null,
    channel: env.BroadcastChannel ? new env.BroadcastChannel(REGISTRY_DB) : null,
  }).load();
  // Bases des comptes supprimés : oubliées seulement une fois réellement effacées.
  for (const db of registry.removed) {
    if (await deleteBackend(env, db).catch(() => false)) await registry.forgetRemoved(db);
  }
  const account = registry.current ?? registry.create({ owner: true });
  const backend = await openBestBackend(env, { name: account.db });
  // `shared` : données communes aux comptes de l'appareil (Store).
  return { registry, account, backend, shared };
}

/**
 * Efface les données de tous les comptes et le registre. La base du
 * propriétaire a déjà été vidée par kernel.factoryReset() : la supprimer
 * pourrait rester en attente derrière une autre fenêtre et bloquer le
 * démarrage suivant. Les bases orphelines (comptes perdus) partent aussi.
 */
export async function eraseAllAccounts(registry, env = globalThis) {
  const names = new Set([...registry.list().map((a) => a.db), ...registry.removed]);
  for (const { name } of (await env.indexedDB?.databases?.().catch(() => [])) ?? []) if (name?.startsWith(`${OWNER_DB}-`)) names.add(name);
  try {
    for (let i = 0; i < (env.localStorage?.length ?? 0); i++) {
      const key = env.localStorage.key(i);
      if (key?.startsWith(`${OWNER_DB}-`)) names.add(key.slice(0, key.indexOf(':')));
    }
  } catch {
    /* stockage indisponible */
  }
  names.delete(OWNER_DB);
  for (const db of names) await deleteBackend(env, db).catch(() => {});
  await deleteBackend(env, REGISTRY_DB).catch(() => {});
}
