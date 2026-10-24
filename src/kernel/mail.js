/**
 * Messagerie : comptes e-mail.
 *
 * Un navigateur ne peut pas ouvrir de connexion IMAP ou SMTP : c'est
 * orion-server (Orion installé) qui relève et envoie le courrier, avec la
 * bibliothèque standard de Python (voir server/orion_mail.py). Le noyau ne
 * fait qu'appeler son API, par le pont matériel. Partout (téléphone, GitHub
 * Pages), Gmail et Outlook passent aussi par leurs API web (voir webmail.js),
 * si Orion a leurs identifiants clients.
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

  constructor({ bridge = null, events = null, log = null, account = () => null, web = null } = {}) {
    this.bridge = bridge;
    this.events = events;
    this.log = log;
    this.owner = () => account() ?? null;
    this.web = web; // Gmail et Outlook par Internet (WebMail)
  }

  /** IMAP et SMTP : orion-server. */
  get server() {
    return Boolean(this.bridge?.has('mail'));
  }

  /** Messagerie possible : orion-server, ou Gmail et Outlook par Internet. */
  get available() {
    return this.server || Boolean(this.web?.enabled);
  }

  get simulated() {
    return Boolean(this.bridge?.simulated);
  }

  #require() {
    if (!this.server) throw new MailError('La messagerie demande Orion installé sur un ordinateur ou une machine virtuelle (orion-server)');
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

  /** Comptes de l'utilisateur d'Orion en cours (ceux d'orion-server, puis Gmail et Outlook par Internet). */
  async accounts({ refresh = false } = {}) {
    const web = this.web?.list() ?? [];
    if (!this.server) return web;
    if (!this.#accounts || refresh) {
      const owner = this.owner();
      try {
        const data = await this.#call('GET', `mail?${MailService.#query({ owner })}`);
        this.#accounts = (data.accounts ?? []).filter((a) => !a.owner || a.owner === owner);
      } catch (error) {
        // orion-server injoignable : les comptes par Internet restent utilisables.
        if (!web.length) throw error;
        this.log?.warn('mail', error.message);
        return web;
      }
    }
    return [...structuredClone(this.#accounts), ...web];
  }

  /** Compte Gmail ou Outlook par Internet (sinon : orion-server). */
  #web(id) {
    return Boolean(this.web?.owns(id));
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

  /**
   * Vérifie seulement l'identifiant et le mot de passe auprès du serveur de
   * réception (compte en ligne d'Orion), sans rien enregistrer.
   */
  async verifyLogin({ address, username = '', password, imap }) {
    await this.#call('POST', 'mail/verify', { address, username, password, imap }, ADD_TIMEOUT);
    return true;
  }

  async removeAccount(id) {
    if (this.#web(id)) return this.web.removeAccount(id);
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
    if (this.#web(account)) return this.web.folders(account);
    await this.#own(account);
    return (await this.#call('GET', `mail/folders?${MailService.#query({ account })}`)).folders;
  }

  /** Messages d'un dossier, du plus récent au plus ancien ; `before` : uid de la page suivante. */
  async messages(account, folder, { before = null, limit = 40, query = '', filter = '' } = {}) {
    if (this.#web(account)) return this.web.messages(account, folder, { before, limit, query, filter });
    await this.#own(account);
    return this.#call('GET', `mail/messages?${MailService.#query({ account, folder, before, limit, q: query, filter })}`);
  }

  async message(account, folder, uid) {
    if (this.#web(account)) return this.web.message(account, folder, uid);
    await this.#own(account);
    return this.#call('GET', `mail/message?${MailService.#query({ account, folder, uid })}`);
  }

  async setFlags(account, folder, uids, { add = [], remove = [] } = {}) {
    if (this.#web(account)) await this.web.setFlags(account, folder, uids, { add, remove });
    else {
      await this.#own(account);
      await this.#call('POST', 'mail/flags', { account, folder, uids, add, remove });
    }
    this.events?.emit('mail:change', { account, folder });
  }

  /** Déplace vers un dossier (son identifiant) ou un rôle (« archive », « inbox »…). */
  async move(account, folder, uids, to) {
    let moved;
    if (this.#web(account)) moved = await this.web.move(account, folder, uids, to);
    else {
      await this.#own(account);
      moved = (await this.#call('POST', 'mail/move', { account, folder, uids, to })).folder;
    }
    this.events?.emit('mail:change', { account, folder });
    return moved;
  }

  /** Corbeille ; suppression définitive si le message y est déjà. */
  async remove(account, folder, uids) {
    let left;
    if (this.#web(account)) left = await this.web.remove(account, folder, uids);
    else {
      await this.#own(account);
      left = (await this.#call('POST', 'mail/delete', { account, folder, uids })).folder;
    }
    this.events?.emit('mail:change', { account, folder });
    return left;
  }

  /** Envoie par le serveur SMTP du compte (ou l'API de Gmail, d'Outlook). `to`, `cc`, `bcc` : [{ name, address }] ou adresses. */
  async send(account, { to = [], cc = [], bcc = [], subject = '', text = '', inReplyTo = '', references = '' }) {
    let result;
    if (this.#web(account)) result = await this.web.send(account, { to, cc, bcc, subject, text, inReplyTo, references });
    else {
      await this.#own(account);
      result = await this.#call('POST', 'mail/send', { account, to, cc, bcc, subject, text, inReplyTo, references }, ADD_TIMEOUT);
    }
    this.log?.info('mail', `message envoyé (${to.length + cc.length + bcc.length} destinataire(s))`);
    this.events?.emit('mail:sent', { account });
    return result;
  }
}
