/**
 * Protection de l'appareil : ce que le noyau garde et décide.
 *
 * - échecs du code de verrouillage, comptés par compte et conservés
 *   (recharger la page ne les remet pas à zéro), avec des attentes
 *   croissantes et, si le propriétaire l'a choisi, l'effacement ;
 * - protection contre la réinitialisation : après un effacement qui n'a pas
 *   été fait par le propriétaire depuis les Réglages (trop d'échecs, vol),
 *   l'appareil demande le code de l'ancien propriétaire avant de servir. Elle
 *   est gardée dans une base à part, que l'effacement d'Orion ne touche pas,
 *   et, sur Orion installé, par orion-server (/var/lib/orion), qui vérifie le
 *   code et limite les essais ;
 * - délai de sécurité pour les réglages sensibles ;
 * - options de l'appareil (communes à tous les comptes, choisies par le
 *   propriétaire) et résultat des dernières analyses.
 *
 * Limite : dans un navigateur ordinaire, effacer les données du site efface
 * aussi cette base ; seule une installation (orion-server) y résiste.
 */
import { hashPasscode } from './settings.js';

/** Attente (secondes) après n échecs du code, comme sur iOS. */
const LOCKOUT = { 5: 60, 6: 300, 7: 900, 8: 900, 9: 3600 };
export const WIPE_AFTER = 10;
/** Délai de sécurité des réglages sensibles, puis fenêtre pour agir. */
export const SECURITY_DELAY = 3_600_000;
export const SECURITY_WINDOW = 3_600_000;

export const DEFAULT_OPTIONS = Object.freeze({ wipe: false, sensitive: false, theftLock: false, offlineLock: false });

const EMPTY_LOCKOUT = { failures: 0, blockedUntil: 0 };

export class ProtectionService {
  #data = { options: { ...DEFAULT_OPTIONS }, lockout: {}, frp: null, delays: {}, scan: null };
  #remote = null; // état de la protection gardée par orion-server

  /**
   * @param {object} options
   * @param {import('./storage.js').Namespace} options.store base de la protection (à part, non effacée avec Orion)
   * @param {() => string | null} options.account compte de la session
   * @param {() => boolean} options.isOwner
   */
  constructor({ store, events = null, bridge = null, log = null, now = Date.now, account = () => null, isOwner = () => true }) {
    this.store = store;
    this.events = events;
    this.bridge = bridge;
    this.log = log;
    this.now = now;
    this.accountId = () => account() ?? 'local';
    this.isOwner = isOwner;
  }

  async load() {
    const saved = Object.fromEntries(await this.store.entries());
    this.#data = {
      options: { ...DEFAULT_OPTIONS, ...saved.options },
      lockout: saved.lockout ?? {},
      frp: saved.frp ?? null,
      delays: saved.delays ?? {},
      scan: saved.scan ?? null,
    };
    if (this.bridge?.has('protection')) {
      try {
        this.#remote = await this.bridge.get('protection');
      } catch (error) {
        this.log?.warn('protection', `orion-server injoignable : ${error.message}`);
      }
    }
    return this;
  }

  #save(key) {
    this.store.put(key, structuredClone(this.#data[key]));
    this.events?.emit('protection:change', { key });
  }

  // ───────────── Options de l'appareil ─────────────

  get options() {
    return { ...this.#data.options };
  }

  setOption(key, value) {
    if (!(key in DEFAULT_OPTIONS)) throw new Error(`Option inconnue : ${key}`);
    if (!this.isOwner()) throw new Error('Seul le propriétaire de l\'appareil peut changer ce réglage');
    this.#data.options[key] = Boolean(value);
    this.#save('options');
  }

  // ───────────── Échecs du code de verrouillage ─────────────

  lockout(accountId = this.accountId()) {
    const state = { ...EMPTY_LOCKOUT, ...this.#data.lockout[accountId] };
    return { ...state, wait: Math.max(0, Math.ceil((state.blockedUntil - this.now()) / 1000)) };
  }

  /**
   * Un code faux. Renvoie { failures, wait (s), left (avant l'effacement, ou null), wipe }.
   * `wipe` : l'appareil (ou le compte) doit être effacé maintenant.
   */
  recordFailure(accountId = this.accountId()) {
    const failures = this.lockout(accountId).failures + 1;
    const wipeOn = this.#data.options.wipe;
    const wipe = wipeOn && failures >= WIPE_AFTER;
    const wait = wipe ? 0 : (LOCKOUT[failures] ?? (failures >= WIPE_AFTER ? 3 * 3600 : 0));
    this.#data.lockout[accountId] = { failures, blockedUntil: wait ? this.now() + wait * 1000 : 0 };
    this.#save('lockout');
    this.log?.warn('protection', `code incorrect (${failures} échec${failures > 1 ? 's' : ''})`);
    return { failures, wait, left: wipeOn ? Math.max(0, WIPE_AFTER - failures) : null, wipe };
  }

  recordSuccess(accountId = this.accountId()) {
    if (!this.#data.lockout[accountId]) return;
    delete this.#data.lockout[accountId];
    this.#save('lockout');
  }

  /** Après un effacement : les compteurs repartent de zéro (la protection contre la réinitialisation reste). */
  resetAfterWipe(accountId = null) {
    if (accountId) delete this.#data.lockout[accountId];
    else this.#data.lockout = {};
    this.#data.delays = {};
    this.#data.scan = null;
    this.#save('lockout');
    this.#save('delays');
    this.#save('scan');
  }

  // ───────────── Protection contre la réinitialisation ─────────────

  /** { enabled, owner, since, remote } — remote : gardée aussi par orion-server. */
  get frp() {
    const local = this.#data.frp;
    const remote = this.#remote?.enabled ? this.#remote : null;
    return {
      enabled: Boolean(local?.enabled || remote),
      owner: local?.owner ?? remote?.owner ?? null,
      since: local?.since ?? remote?.since ?? null,
      remote: Boolean(remote),
    };
  }

  /**
   * Active la protection avec le code de verrouillage actuel du propriétaire
   * (son empreinte, déjà vérifiée par l'appelant).
   */
  async enableFrp({ record, owner }) {
    if (!this.isOwner()) throw new Error('Seul le propriétaire peut activer cette protection');
    if (!record?.hash) throw new Error('Définissez d\'abord un code de verrouillage');
    const entry = { enabled: true, owner: { name: owner?.name ?? '', email: owner?.email ?? '' }, record, since: this.now(), failures: 0, blockedUntil: 0 };
    if (this.bridge?.has('protection')) {
      this.#remote = await this.bridge.post('protection/enable', { record, owner: entry.owner });
    }
    this.#data.frp = entry;
    this.#save('frp');
    this.log?.info('protection', 'protection contre la réinitialisation activée');
  }

  /** Le propriétaire a changé de code : la protection suit (l'ancien code a été vérifié). */
  async updateFrpRecord(record, oldCode) {
    if (!this.#data.frp?.enabled && !this.#remote?.enabled) return;
    if (this.#remote?.enabled) this.#remote = await this.bridge.post('protection/update', { code: oldCode, record });
    if (this.#data.frp) {
      this.#data.frp = { ...this.#data.frp, record };
      this.#save('frp');
    }
  }

  /** Attente avant un nouvel essai du code de l'ancien propriétaire (secondes). */
  get frpWait() {
    const local = Math.max(0, Math.ceil(((this.#data.frp?.blockedUntil ?? 0) - this.now()) / 1000));
    return Math.max(local, this.#remote?.wait ?? 0);
  }

  /**
   * Vérifie le code de l'ancien propriétaire. Renvoie { ok, wait }.
   * orion-server, quand il garde la protection, décide (il compte les essais lui-même).
   */
  async verifyFrp(code) {
    if (this.#remote?.enabled) {
      try {
        await this.bridge.post('protection/verify', { code: String(code) });
        return { ok: true, wait: 0 };
      } catch (error) {
        try {
          this.#remote = await this.bridge.get('protection');
        } catch {
          /* injoignable : la réponse reste un refus */
        }
        return { ok: false, wait: this.#remote?.wait ?? 0, error: error.message };
      }
    }
    const frp = this.#data.frp;
    if (!frp?.enabled) return { ok: true, wait: 0 };
    if (this.frpWait) return { ok: false, wait: this.frpWait };
    if ((await hashPasscode(String(code), frp.record.salt)) === frp.record.hash) return { ok: true, wait: 0 };
    const failures = (frp.failures ?? 0) + 1;
    const wait = failures >= 5 ? Math.min(3600, 30 * 2 ** (failures - 5)) : 0;
    this.#data.frp = { ...frp, failures, blockedUntil: wait ? this.now() + wait * 1000 : 0 };
    this.#save('frp');
    return { ok: false, wait };
  }

  /** Désactive la protection, avec le code du propriétaire (vérifié ici). */
  async disableFrp(code) {
    const result = await this.verifyFrp(code);
    if (!result.ok) return result;
    if (this.#remote?.enabled) {
      await this.bridge.post('protection/disable', { code: String(code) });
      this.#remote = { enabled: false };
    }
    this.#data.frp = null;
    this.#save('frp');
    this.log?.info('protection', 'protection contre la réinitialisation désactivée');
    return { ok: true, wait: 0 };
  }

  // ───────────── Délai de sécurité ─────────────

  /**
   * Réglage sensible demandé (après le code) : avec la protection des données
   * sensibles, il n'est possible qu'une heure après une première demande.
   * Renvoie { allowed, readyAt }.
   */
  requestSensitive(action) {
    if (!this.#data.options.sensitive) return { allowed: true, readyAt: null };
    const now = this.now();
    const readyAt = this.#data.delays[action];
    if (readyAt && now >= readyAt && now < readyAt + SECURITY_WINDOW) {
      delete this.#data.delays[action];
      this.#save('delays');
      return { allowed: true, readyAt };
    }
    if (readyAt && now < readyAt) return { allowed: false, readyAt };
    this.#data.delays[action] = now + SECURITY_DELAY;
    this.#save('delays');
    return { allowed: false, readyAt: this.#data.delays[action], started: true };
  }

  pendingDelays() {
    const now = this.now();
    return Object.entries(this.#data.delays)
      .filter(([, readyAt]) => readyAt + SECURITY_WINDOW > now)
      .map(([action, readyAt]) => ({ action, readyAt }));
  }

  // ───────────── Dernière analyse ─────────────

  get lastScan() {
    return this.#data.scan ? structuredClone(this.#data.scan) : null;
  }

  saveScan(scan) {
    this.#data.scan = { ...scan, at: this.now() };
    this.#save('scan');
  }
}
