/**
 * Messagerie : comptes e-mail (IMAP pour recevoir, SMTP pour envoyer).
 *
 * Un navigateur ne peut pas ouvrir de connexion IMAP ou SMTP : c'est
 * orion-server (Orion installé) qui relève et envoie le courrier, avec la
 * bibliothèque standard de Python (voir server/orion_mail.py). Le noyau ne
 * fait qu'appeler son API, par le pont matériel. Sans pont (téléphone,
 * GitHub Pages), la messagerie est indisponible.
 *
 * Les comptes sont ajoutés dans les Réglages ; le mot de passe va au serveur
 * et n'en revient jamais. Chaque utilisateur d'Orion ne voit que ses comptes
 * (les comptes ajoutés avant les utilisateurs d'Orion sont visibles de tous).
 * Les apps du Store y accèdent par le SDK (orion.mail), avec l'autorisation
 * « E-mails » (voir system/app-context.js).
 */
export const MAIL_FLAGS = ['seen', 'flagged', 'answered'];
export const MAIL_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all'];

/** Délais : connexion chiffrée, identification et téléchargement chez le fournisseur. */
const READ_TIMEOUT = 45_000;
const ADD_TIMEOUT = 75_000;

export class MailError extends Error {}

export class MailService {
  #accounts = null; // comptes de l'utilisateur (cache), sans mot de passe

  constructor({ bridge = null, events = null, log = null, account = () => null } = {}) {
    this.bridge = bridge;
    this.events = events;
    this.log = log;
    this.owner = () => account() ?? null;
  }

  /** La messagerie demande orion-server. */
  get available() {
    return Boolean(this.bridge?.has('mail'));
  }

  get simulated() {
    return Boolean(this.bridge?.simulated);
  }

  #require() {
    if (!this.available) throw new MailError('La messagerie demande Orion installé sur un ordinateur ou une machine virtuelle (orion-server)');
  }

  async #call(method, path, body, timeout = READ_TIMEOUT) {
    this.#require();
    try {
      return method === 'GET' ? await this.bridge.get(path, { timeout }) : await this.bridge.post(path, body, { timeout });
    } catch (error) {
      throw new MailError(error.message);
    }
  }

  static #query(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
  }

  // ───────────── Comptes ─────────────

  /** Comptes de l'utilisateur d'Orion en cours. */
  async accounts({ refresh = false } = {}) {
    if (!this.available) return [];
    if (!this.#accounts || refresh) {
      const owner = this.owner();
      const data = await this.#call('GET', `mail?${MailService.#query({ owner })}`);
      this.#accounts = (data.accounts ?? []).filter((a) => !a.owner || a.owner === owner);
    }
    return structuredClone(this.#accounts);
  }

  /** Serveurs de réception et d'envoi proposés pour une adresse (fournisseurs connus, sinon devinés). */
  autoconfig(address) {
    return this.#call('POST', 'mail/autoconfig', { address });
  }

  /** Vérifie la connexion aux deux serveurs, puis enregistre le compte. */
  async addAccount({ name = '', address, username = '', password, imap, smtp, saveSent = true }) {
    const account = await this.#call('POST', 'mail/accounts/add', { owner: this.owner(), name, address, username, password, imap, smtp, saveSent }, ADD_TIMEOUT);
    this.#accounts = null;
    this.log?.info('mail', `compte ajouté : ${account.address}`);
    this.events?.emit('mail:accounts', { added: account.id });
    return account;
  }

  async removeAccount(id) {
    await this.#own(id);
    await this.#call('POST', 'mail/accounts/remove', { id });
    this.#accounts = null;
    this.log?.info('mail', 'compte retiré');
    this.events?.emit('mail:accounts', { removed: id });
  }

  /** Un compte d'un autre utilisateur d'Orion n'est pas accessible. */
  async #own(id) {
    const list = await this.accounts();
    if (list.some((a) => a.id === id)) return;
    if ((await this.accounts({ refresh: true })).some((a) => a.id === id)) return;
    throw new MailError('Compte de messagerie introuvable');
  }

  // ───────────── Courrier ─────────────

  async folders(account) {
    await this.#own(account);
    return (await this.#call('GET', `mail/folders?${MailService.#query({ account })}`)).folders;
  }

  /** Messages d'un dossier, du plus récent au plus ancien ; `before` : uid de la page suivante. */
  async messages(account, folder, { before = null, limit = 40, query = '', filter = '' } = {}) {
    await this.#own(account);
    return this.#call('GET', `mail/messages?${MailService.#query({ account, folder, before, limit, q: query, filter })}`);
  }

  async message(account, folder, uid) {
    await this.#own(account);
    return this.#call('GET', `mail/message?${MailService.#query({ account, folder, uid })}`);
  }

  async setFlags(account, folder, uids, { add = [], remove = [] } = {}) {
    await this.#own(account);
    await this.#call('POST', 'mail/flags', { account, folder, uids, add, remove });
    this.events?.emit('mail:change', { account, folder });
  }

  /** Déplace vers un dossier (son identifiant) ou un rôle (« archive », « inbox »…). */
  async move(account, folder, uids, to) {
    await this.#own(account);
    const result = await this.#call('POST', 'mail/move', { account, folder, uids, to });
    this.events?.emit('mail:change', { account, folder });
    return result.folder;
  }

  /** Corbeille ; suppression définitive si le message y est déjà. */
  async remove(account, folder, uids) {
    await this.#own(account);
    const result = await this.#call('POST', 'mail/delete', { account, folder, uids });
    this.events?.emit('mail:change', { account, folder });
    return result.folder;
  }

  /** Envoie par le serveur SMTP du compte. `to`, `cc`, `bcc` : [{ name, address }] ou adresses. */
  async send(account, { to = [], cc = [], bcc = [], subject = '', text = '', inReplyTo = '', references = '' }) {
    await this.#own(account);
    const result = await this.#call('POST', 'mail/send', { account, to, cc, bcc, subject, text, inReplyTo, references }, ADD_TIMEOUT);
    this.log?.info('mail', `message envoyé (${to.length + cc.length + bcc.length} destinataire(s))`);
    this.events?.emit('mail:sent', { account });
    return result;
  }
}
