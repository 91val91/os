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
const EDITABLE = ['name', 'email', 'color', 'photo', 'lastLogin'];

export class AccountRegistry {
  #data = { accounts: [], current: null, removed: [] };

  /**
   * @param {object} options
   * @param {{ get(key: string): Promise<unknown>, put(key: string, value: unknown): Promise<unknown> }} options.store
   */
  constructor({ store, now = Date.now, random = Math.random }) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.events = null;
  }

  async load() {
    const data = await this.store.get('registry');
    if (data) this.#data = { accounts: [], current: null, removed: [], ...data };
    return this;
  }

  #save() {
    this.events?.emit('account:change', {});
    return this.store.put('registry', structuredClone(this.#data));
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
    this.#data.accounts.push(account);
    this.#data.current ??= id;
    this.#save();
    return { ...account };
  }

  update(id, patch) {
    const account = this.#data.accounts.find((a) => a.id === id);
    if (!account) return null;
    for (const key of EDITABLE) if (key in patch) account[key] = typeof patch[key] === 'string' && key !== 'photo' ? patch[key].trim() : patch[key];
    this.#save();
    return { ...account };
  }

  setCurrent(id) {
    if (!this.get(id)) throw new Error('Compte introuvable');
    this.#data.current = id;
    return this.#save();
  }

  /** Retire un compte ; sa base sera effacée au prochain démarrage (elle peut être ouverte). */
  remove(id) {
    const account = this.get(id);
    if (!account) return Promise.resolve(false);
    if (account.owner) throw new Error('Le compte du propriétaire ne peut pas être supprimé');
    this.#data.accounts = this.#data.accounts.filter((a) => a.id !== id);
    this.#data.removed.push(account.db);
    if (this.#data.current === id) this.#data.current = this.owner?.id ?? null;
    return this.#save().then(() => true);
  }

  forgetRemoved(db) {
    this.#data.removed = this.#data.removed.filter((name) => name !== db);
    return this.#save();
  }
}

/**
 * Ouvre la session du compte courant : registre, compte et stockage de ses
 * données. Au tout premier démarrage (ou sur un appareil d'avant les comptes),
 * le compte du propriétaire est créé ; son nom est complété par l'assistant.
 */
export async function openSession(env = globalThis) {
  const registry = await new AccountRegistry({ store: new Namespace(await openBestBackend(env, { name: REGISTRY_DB }), 'accounts') }).load();
  for (const db of registry.removed) {
    await deleteBackend(env, db).catch(() => {});
    await registry.forgetRemoved(db);
  }
  const account = registry.current ?? registry.create({ owner: true });
  const backend = await openBestBackend(env, { name: account.db });
  return { registry, account, backend };
}

/** Efface toutes les données de l'appareil : chaque compte et le registre. */
export async function eraseAllAccounts(registry, env = globalThis) {
  for (const db of [...registry.list().map((a) => a.db), ...registry.removed]) await deleteBackend(env, db).catch(() => {});
  await deleteBackend(env, REGISTRY_DB).catch(() => {});
}
