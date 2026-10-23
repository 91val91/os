/**
 * Permissions d'exécution (modèle iOS/Android).
 * Une application doit déclarer la permission dans son manifeste, puis la
 * demander ; l'utilisateur choisit Autoriser / Une seule fois / Refuser.
 * Un refus est mémorisé : seule l'app Réglages permet de revenir dessus.
 */
export const PERMISSIONS = {
  camera: { label: 'Appareil photo', icon: 'camera', reason: 'prendre des photos et des vidéos' },
  microphone: { label: 'Microphone', icon: 'mic', reason: 'enregistrer du son' },
  location: { label: 'Localisation', icon: 'location', reason: 'connaître votre position' },
  contacts: { label: 'Contacts', icon: 'user', reason: 'accéder à vos contacts' },
  mail: { label: 'E-mails', icon: 'mail', reason: 'lire, classer et envoyer vos e-mails (comptes ajoutés dans les Réglages)' },
};

export class PermissionService {
  #grants = {}; // appId → { perm: 'granted' | 'denied' }
  #session = new Set(); // autorisations « une seule fois » : `${appId}:${perm}`

  constructor({ store = null, events = null, packages = null, settings = null } = {}) {
    this.store = store;
    this.events = events;
    this.packages = packages;
    this.settings = settings;
    /** Fonction d'invite fournie par l'interface : ({ appId, perm }) → 'allow' | 'once' | 'deny' */
    this.prompter = null;
  }

  async load() {
    const saved = this.store ? Object.fromEntries(await this.store.entries()) : {};
    this.#grants = saved.grants ?? {};
    return this;
  }

  #persist() {
    this.store?.put('grants', this.#grants);
  }

  declared(appId, perm) {
    const pkg = this.packages?.get(appId);
    return !this.packages || Boolean(pkg?.permissions?.includes(perm));
  }

  check(appId, perm) {
    if (!PERMISSIONS[perm] || !this.declared(appId, perm)) return 'denied';
    if (perm === 'location' && this.settings?.get('location') === false) return 'denied';
    if (this.#session.has(`${appId}:${perm}`)) return 'granted';
    return this.#grants[appId]?.[perm] ?? 'prompt';
  }

  async request(appId, perm) {
    const state = this.check(appId, perm);
    if (state !== 'prompt') return state === 'granted';
    const answer = this.prompter ? await this.prompter({ appId, perm, info: PERMISSIONS[perm] }) : 'deny';
    if (answer === 'once') {
      this.#session.add(`${appId}:${perm}`);
      return true;
    }
    this.set(appId, perm, answer === 'allow' ? 'granted' : 'denied');
    return answer === 'allow';
  }

  set(appId, perm, state) {
    this.#grants[appId] = { ...this.#grants[appId] };
    if (state === 'prompt') delete this.#grants[appId][perm];
    else this.#grants[appId][perm] = state;
    if (state !== 'granted') this.#session.delete(`${appId}:${perm}`);
    this.#persist();
    this.events?.emit('permission:change', { appId, perm, state });
  }

  reset(appId) {
    delete this.#grants[appId];
    for (const key of [...this.#session]) if (key.startsWith(`${appId}:`)) this.#session.delete(key);
    this.#persist();
    this.events?.emit('permission:change', { appId });
  }

  /** Permissions déclarées par une application avec leur état. */
  listFor(appId) {
    const pkg = this.packages?.get(appId);
    return (pkg?.permissions ?? [])
      .filter((perm) => PERMISSIONS[perm])
      .map((perm) => ({ perm, ...PERMISSIONS[perm], state: this.check(appId, perm) }));
  }
}
