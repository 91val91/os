/**
 * Mode développeur : un seul mot de passe pour tout l'appareil, choisi par le
 * propriétaire et demandé à chaque compte. Il ouvre les options pour les
 * développeurs et le Terminal jusqu'au prochain verrouillage.
 *
 * Il est enregistré avec les comptes et non dans les réglages : « Réinitialiser
 * les réglages » ne l'efface pas. Les échecs sont comptés pour l'appareil et
 * le blocage qui suit survit à la fermeture des Réglages et aux redémarrages.
 */
import { createPasscode, verifyPasscode } from '../kernel/settings.js';

export const MIN_PASSWORD_LENGTH = 6;
const FREE_ATTEMPTS = 5;
const MAX_WAIT = 15 * 60;

/** Message d'erreur pour un nouveau mot de passe, ou null s'il convient. */
export function passwordProblem(password, confirmation) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  if (!/\d/.test(password) || !/\p{L}/u.test(password)) return 'Mélangez lettres et chiffres.';
  if (password !== confirmation) return 'Les deux mots de passe ne correspondent pas.';
  return null;
}

export class DeveloperMode {
  #unlockedWith = null; // empreinte du mot de passe qui a servi à déverrouiller

  constructor(ui) {
    this.ui = ui;
    this.unlocked = false;
    // Mot de passe changé ou supprimé depuis une autre fenêtre d'Orion : cette fenêtre se reverrouille.
    ui.kernel?.events.on('account:change', () => {
      if (this.unlocked && this.#state.password?.hash !== this.#unlockedWith) this.lock();
    });
  }

  #open() {
    this.unlocked = true;
    this.#unlockedWith = this.#state.password?.hash ?? null;
  }

  get #k() {
    return this.ui.kernel;
  }

  /** État enregistré : registre des comptes ou, sans comptes, réglages. */
  get #state() {
    return this.#k.accounts?.developer ?? { password: null, failures: 0, blockedUntil: 0, ...this.#k.settings.get('developerState') };
  }

  #save(patch) {
    if (this.#k.accounts) return this.#k.accounts.setDeveloper(patch);
    this.#k.settings.set('developerState', { ...this.#state, ...patch });
    return Promise.resolve();
  }

  get configured() {
    return Boolean(this.#state.password);
  }

  /** Seul le propriétaire choisit, change ou supprime le mot de passe. */
  get canManage() {
    return !this.#k.accounts || Boolean(this.#k.account?.owner);
  }

  get ownerName() {
    return this.#k.accounts?.owner?.name || 'le propriétaire';
  }

  /** Secondes à attendre avant un nouvel essai (0 : essai possible). */
  get wait() {
    return Math.max(0, Math.ceil((this.#state.blockedUntil - Date.now()) / 1000));
  }

  /**
   * Mot de passe des versions précédentes, choisi compte par compte dans les
   * réglages : celui du propriétaire devient celui de l'appareil, les autres
   * sont oubliés (il faudra le mot de passe de l'appareil).
   */
  migrate() {
    const settings = this.#k.settings;
    const legacy = settings.get('developerPassword');
    if (legacy && !this.configured && this.canManage) this.#save({ password: legacy });
    for (const key of ['developerPassword', 'developer']) if (settings.get(key) != null) settings.reset(key);
  }

  async create(password) {
    if (!this.canManage) throw new Error(`Seul ${this.ownerName} peut définir le mot de passe développeur`);
    await this.#save({ password: await createPasscode(password), failures: 0, blockedUntil: 0 });
    this.#open();
  }

  /** Déverrouille ; renvoie { ok } ou { ok: false, left, wait }. */
  async unlock(password) {
    if (this.wait) return { ok: false, left: 0, wait: this.wait };
    const state = this.#state;
    // Sans mot de passe (supprimé entre-temps, par exemple depuis une autre fenêtre), rien ne s'ouvre.
    if (!state.password) return { ok: false, left: 0, wait: 0, missing: true };
    if (await verifyPasscode(state.password, password)) {
      if (state.failures) await this.#save({ failures: 0, blockedUntil: 0 });
      this.#open();
      return { ok: true };
    }
    // Après 5 échecs : 30 s d'attente, puis le double à chaque nouvel échec (15 min au plus).
    const failures = state.failures + 1;
    const wait = failures >= FREE_ATTEMPTS ? Math.min(MAX_WAIT, 30 * 2 ** (failures - FREE_ATTEMPTS)) : 0;
    await this.#save({ failures, blockedUntil: wait ? Date.now() + wait * 1000 : 0 });
    return { ok: false, left: Math.max(0, FREE_ATTEMPTS - failures), wait };
  }

  /** Nouveau mot de passe (le propriétaire, déverrouillé ou après son code de verrouillage). */
  async replace(password) {
    if (!this.canManage) throw new Error(`Seul ${this.ownerName} peut changer le mot de passe développeur`);
    await this.#save({ password: await createPasscode(password), failures: 0, blockedUntil: 0 });
    this.#open();
  }

  /** Supprime le mot de passe : le mode développeur n'est plus accessible jusqu'à un nouveau. */
  async remove() {
    if (!this.canManage) throw new Error(`Seul ${this.ownerName} peut supprimer le mot de passe développeur`);
    await this.#save({ password: null, failures: 0, blockedUntil: 0 });
    this.lock();
  }

  /** Referme l'accès : les apps réservées (Terminal) sont arrêtées sans animation. */
  lock() {
    if (!this.unlocked) return;
    this.unlocked = false;
    for (const [pid, win] of [...this.ui.wm.windows]) if (win.pkg.developer) this.#k.processes.kill(pid, 'developer-lock');
    this.#k.events.emit('developer:lock', {});
  }
}
