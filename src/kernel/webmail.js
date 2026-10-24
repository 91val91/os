/**
 * E-mails par Internet, sans orion-server : Gmail (API Gmail) et Outlook,
 * Hotmail, Live (Microsoft Graph).
 *
 * Un navigateur ne parle ni IMAP ni SMTP : sur un téléphone, seules les API
 * web des fournisseurs permettent de relever et d'envoyer le courrier. Orion
 * s'y connecte par OAuth, dans la page du fournisseur (le mot de passe ne se
 * saisit jamais dans Orion), avec les identifiants clients de
 * config/identity.js (les mêmes que « Continuer avec Google / Microsoft ») :
 *   - Google : flux « jeton » (une application web ne peut pas garder de
 *     secret) : l'accès dure une heure, puis Orion propose de se reconnecter
 *     d'un toucher (la fenêtre de Google se referme seule) ;
 *   - Microsoft : code + PKCE (application « monopage ») : l'accès se
 *     renouvelle seul pendant 24 heures.
 *
 * Les comptes et leurs jetons restent sur l'appareil, dans les données de
 * l'utilisateur d'Orion. Les dossiers et messages ont la forme de ceux
 * d'orion-server (voir server/API.md), pour que les apps (orion.mail) n'y
 * voient pas de différence : `uid` entier, croissant avec la date de réception.
 */
import { MailError } from './mail.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_BATCH = 'https://www.googleapis.com/batch/gmail/v1';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export const WEB_PROVIDERS = Object.freeze({
  google: Object.freeze({ name: 'Gmail', company: 'Google', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', scope: 'https://mail.google.com/ email profile', revoke: 'https://oauth2.googleapis.com/revoke' }),
  microsoft: Object.freeze({ name: 'Outlook', company: 'Microsoft', authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'offline_access openid email profile Mail.ReadWrite Mail.Send User.Read' }),
});

const ROLE_NAMES = { inbox: 'Réception', sent: 'Envoyés', drafts: 'Brouillons', trash: 'Corbeille', junk: 'Indésirables', archive: 'Archives', all: 'Tous les messages' };
const GMAIL_ROLES = { INBOX: 'inbox', DRAFT: 'drafts', SENT: 'sent', SPAM: 'junk', TRASH: 'trash' };
const GMAIL_ALL = 'ALL'; // « Tous les messages » : pas de libellé
const GMAIL_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Content-Type'].map((h) => `metadataHeaders=${h}`).join('&');
const GRAPH_ROLES = { inbox: 'inbox', drafts: 'drafts', sentitems: 'sent', junkemail: 'junk', deleteditems: 'trash', archive: 'archive' };
const GRAPH_SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,hasAttachments,bodyPreview';
// Identifiants Graph qui ne changent pas quand le message change de dossier.
const GRAPH_PREFER = 'IdType="ImmutableId"';
const MAX_TEXT = 200_000;
const MAX_SEND = 100_000;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

// ───────────── Outils ─────────────

const utf8 = (text) => new TextEncoder().encode(text);
function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const base64url = (bytes) => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromBase64(text) {
  const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
function decodeBytes(bytes, charset = 'utf-8') {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
const oneLine = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();

/** uid d'un message : date de réception (ms) × 1000 + empreinte de son identifiant. */
export function uidOf(ms, id) {
  let hash = 0x811c9dc5;
  for (const c of String(id)) hash = Math.imul(hash ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return Math.max(0, Math.floor(Number(ms) || 0)) * 1000 + (hash % 1000) + 1;
}
const msOf = (uid) => Math.floor((uid - 1) / 1000);

/** Mots encodés des en-têtes (=?UTF-8?B?…?=, =?ISO-8859-1?Q?…?=). */
export function decodeWords(value) {
  return String(value ?? '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, charset, kind, data) => {
      try {
        if (kind.toUpperCase() === 'B') return decodeBytes(fromBase64(data), charset);
        const bytes = [];
        const text = data.replace(/_/g, ' ');
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
            bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(text.charCodeAt(i) & 0xff);
        }
        return decodeBytes(new Uint8Array(bytes), charset);
      } catch {
        return all;
      }
    });
}

/** « Camille <c@exemple.fr>, "Martin, Lucas" <l@exemple.fr> » → [{ name, address }]. */
export function parseAddresses(value) {
  const out = [];
  const push = (part) => {
    const text = part.trim();
    if (!text) return;
    const m = /^(.*?)<([^<>]+)>\s*$/.exec(text);
    const address = (m ? m[2] : text).trim();
    const name = m ? decodeWords(m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')) : '';
    if (address.includes('@')) out.push({ name, address });
  };
  let current = '';
  let quoted = false;
  let angle = false;
  let escaped = false;
  for (const c of String(value ?? '')) {
    if (escaped) escaped = false;
    else if (c === '\\' && quoted) escaped = true;
    else if (c === '"') quoted = !quoted;
    else if (c === '<' && !quoted) angle = true;
    else if (c === '>' && !quoted) angle = false;
    else if (c === ',' && !quoted && !angle) {
      push(current);
      current = '';
      continue;
    }
    current += c;
  }
  push(current);
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (text) =>
  String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? all;
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
  });

/** Texte lisible d'un e-mail HTML (sans balises, styles ni scripts). */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Mot encodé d'un en-tête, découpé en morceaux de 45 octets au plus (sans couper un caractère). */
function encodeWord(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const chunks = [];
  let chunk = '';
  for (const c of text) {
    if (utf8(chunk + c).length > 45) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += c;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${base64(utf8(part))}?=`).join('\r\n ');
}
function mailbox({ name = '', address }) {
  const display = oneLine(name);
  if (!display) return address;
  return `${/^[\x20-\x7e]*$/.test(display) ? `"${display.replace(/["\\]/g, '\\$&')}"` : encodeWord(display)} <${address}>`;
}

/** Destinataires : [{ name, address }] ou adresses, vérifiés. */
export function recipients(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : [list]) {
    if (!item) continue;
    const parsed = typeof item === 'string' ? parseAddresses(item) : [{ name: oneLine(item.name), address: oneLine(item.address) }];
    if (!parsed.length) throw new MailError(`Adresse invalide : ${oneLine(item)}`);
    for (const r of parsed) {
      if (!EMAIL.test(r.address)) throw new MailError(`Adresse invalide : ${r.address}`);
      out.push({ name: r.name, address: r.address });
    }
  }
  return out;
}

/** Message MIME (texte brut UTF-8) pour l'API Gmail. */
export function buildMime({ from, to = [], cc = [], bcc = [], subject = '', text = '', inReplyTo = '', references = '', date = Date.now() }) {
  const lines = [`From: ${mailbox(from)}`];
  if (to.length) lines.push(`To: ${to.map(mailbox).join(', ')}`);
  if (cc.length) lines.push(`Cc: ${cc.map(mailbox).join(', ')}`);
  if (bcc.length) lines.push(`Bcc: ${bcc.map(mailbox).join(', ')}`);
  lines.push(`Subject: ${encodeWord(oneLine(subject))}`, `Date: ${new Date(date).toUTCString()}`);
  if (oneLine(inReplyTo)) lines.push(`In-Reply-To: ${oneLine(inReplyTo)}`);
  if (oneLine(references)) lines.push(`References: ${oneLine(references)}`);
  const body = base64(utf8(String(text).replace(/\r?\n/g, '\r\n'))).replace(/.{76}/g, '$&\r\n');
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body);
  return lines.join('\r\n');
}

/** Réponse groupée (multipart/mixed) de l'API Gmail : corps JSON de chaque requête, dans l'ordre. */
export function parseBatch(text, contentType, count) {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType ?? '')?.[1];
  const results = Array(count).fill(null);
  if (!boundary) return results;
  String(text)
    .split(`--${boundary}`)
    .forEach((part, i) => {
      const index = Number(/content-id:\s*<?response-i?(\d+)>?/i.exec(part)?.[1] ?? i - 1);
      const status = Number(/HTTP\/[\d.]+ (\d{3})/.exec(part)?.[1] ?? 0);
      const start = part.indexOf('{');
      if (status !== 200 || start < 0 || !(index >= 0 && index < count)) return;
      try {
        results[index] = JSON.parse(part.slice(start, part.lastIndexOf('}') + 1));
      } catch {
        /* partie illisible */
      }
    });
  return results;
}

const header = (headers, name) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';

// ───────────── Comptes ─────────────

export class WebMail {
  #accounts = [];
  #ids = new Map(); // compte → Map(uid → identifiant du fournisseur)
  #pages = new Map(); // compte|dossier|recherche|uid → page suivante
  #roles = new Map(); // compte (Outlook) → { rôle → identifiant du dossier }

  constructor({ store = null, net, clients = {}, notifications = null, events = null, log = null, now = Date.now, crypto = globalThis.crypto } = {}) {
    this.store = store;
    this.net = net;
    this.clients = clients;
    this.notifications = notifications;
    this.events = events;
    this.log = log;
    this.now = now;
    this.crypto = crypto;
  }

  async load() {
    const saved = await this.store?.get('accounts');
    this.#accounts = Array.isArray(saved) ? saved : [];
    return this;
  }

  #save() {
    this.store?.put('accounts', this.#accounts);
  }

  /** Fournisseur utilisable sur cet Orion (identifiant client renseigné). */
  configured(provider) {
    return Boolean(WEB_PROVIDERS[provider] && this.clients[provider]);
  }

  get enabled() {
    return this.#accounts.length > 0 || Object.keys(WEB_PROVIDERS).some((p) => this.configured(p));
  }

  owns(id) {
    return this.#accounts.some((a) => a.id === id);
  }

  #get(id) {
    const account = this.#accounts.find((a) => a.id === id);
    if (!account) throw new MailError('Compte de messagerie introuvable');
    return account;
  }

  #usable(a) {
    return Boolean((a.token && a.expires > this.now() + 60_000) || a.refresh);
  }

  list() {
    return this.#accounts.map((a) => ({ id: a.id, provider: a.provider, web: true, name: a.name, address: a.address, username: a.address, imap: null, smtp: null, saveSent: false, createdAt: a.createdAt, expired: !this.#usable(a) }));
  }

  /**
   * Début d'une connexion : adresse de la page du fournisseur (à ouvrir dans
   * une fenêtre, voir system/sign-in.js) et données à garder pour la suite.
   * `account` : compte à reconnecter.
   */
  async begin(provider, { redirectUri, account = null }) {
    const p = WEB_PROVIDERS[provider];
    if (!this.configured(provider)) throw new MailError(`${p?.name ?? 'Ce service'} n'est pas configuré sur cet Orion (identifiant client manquant dans src/config/identity.js)`);
    const existing = account ? this.#get(account) : null;
    const pending = { provider, redirectUri, account: existing?.id ?? null };
    const url = new URL(p.authorize);
    const query = { client_id: this.clients[provider], redirect_uri: redirectUri, scope: p.scope };
    if (existing) query.login_hint = existing.address;
    else query.prompt = 'select_account';
    if (provider === 'google') Object.assign(query, { response_type: 'token', include_granted_scopes: 'true' });
    else {
      // PKCE : le code de retour ne sert qu'à cette connexion-ci.
      pending.verifier = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await this.crypto.subtle.digest('SHA-256', utf8(pending.verifier))));
      Object.assign(query, { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return { url: url.href, pending };
  }

  /** Fin d'une connexion : paramètres du retour → compte enregistré (ou reconnecté). */
  async complete(pending, params = {}) {
    const { provider } = pending;
    const p = WEB_PROVIDERS[provider];
    if (params.error) throw new MailError(params.error === 'access_denied' ? 'Connexion annulée' : params.error_description || params.error);
    let tokens;
    if (provider === 'google') {
      if (!params.access_token) throw new MailError('Google n\'a pas donné d\'accès');
      // Le jeton doit avoir été émis pour Orion, avec l'accès aux e-mails.
      const info = await this.#request(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(params.access_token)}`);
      if (info.aud !== this.clients.google && info.azp !== this.clients.google) throw new MailError('Jeton destiné à une autre application');
      if (!String(info.scope ?? '').split(' ').includes('https://mail.google.com/')) throw new MailError('Orion n\'a pas reçu l\'accès à Gmail : cochez l\'accès à vos e-mails, puis réessayez');
      tokens = { token: params.access_token, expires: this.now() + Number(params.expires_in || info.expires_in || 3600) * 1000, refresh: null };
    } else {
      if (!params.code) throw new MailError('Microsoft n\'a pas donné d\'accès');
      tokens = await this.#redeem({ grant_type: 'authorization_code', code: params.code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
    }
    const profile = await this.#profile(provider, tokens.token);
    let account = pending.account ? this.#get(pending.account) : this.#accounts.find((a) => a.provider === provider && a.address === profile.address);
    if (account && account.address !== profile.address) throw new MailError(`Connectez-vous avec ${account.address} (pas ${profile.address})`);
    if (account) Object.assign(account, tokens, { notified: false, name: account.name || profile.name });
    else {
      account = { id: `web-${base64url(this.crypto.getRandomValues(new Uint8Array(9)))}`, provider, address: profile.address, name: profile.name, createdAt: this.now(), ...tokens };
      this.#accounts.push(account);
      this.log?.info('mail', `compte ${p.name} ajouté : ${account.address}`);
      this.events?.emit('mail:accounts', { added: account.id });
    }
    this.#save();
    this.notifications?.list({ appId: 'settings' }).filter((n) => n.tag === `webmail-${account.id}`).forEach((n) => this.notifications.dismiss(n.id));
    return this.list().find((a) => a.id === account.id);
  }

  async removeAccount(id) {
    const account = this.#get(id);
    this.#accounts = this.#accounts.filter((a) => a !== account);
    this.#save();
    this.#ids.delete(id);
    this.#roles.delete(id);
    // Google : l'accès est retiré tout de suite (Microsoft : il expire seul).
    if (account.provider === 'google' && account.token) this.#request(`${WEB_PROVIDERS.google.revoke}?token=${encodeURIComponent(account.token)}`, { method: 'POST' }).catch(() => {});
    this.log?.info('mail', 'compte retiré');
    this.events?.emit('mail:accounts', { removed: id });
  }

  async #profile(provider, token) {
    const auth = { Authorization: `Bearer ${token}` };
    if (provider === 'google') {
      const [mailbox, user] = await Promise.all([this.#request(`${GMAIL}/profile`, { headers: auth }), this.#request('https://www.googleapis.com/oauth2/v3/userinfo', { headers: auth }).catch(() => ({}))]);
      return { address: String(mailbox.emailAddress).toLowerCase(), name: user.name ?? '' };
    }
    const me = await this.#request(`${GRAPH}/me?$select=displayName,mail,userPrincipalName`, { headers: auth });
    const address = String(me.mail || me.userPrincipalName || '').toLowerCase();
    if (!EMAIL.test(address)) throw new MailError('Ce compte Microsoft n\'a pas de boîte e-mail');
    return { address, name: me.displayName ?? '' };
  }

  /** Jeton Microsoft (code ou renouvellement). */
  async #redeem(fields, previous = null) {
    const body = new URLSearchParams({ client_id: this.clients.microsoft, scope: WEB_PROVIDERS.microsoft.scope, ...fields }).toString();
    const t = await this.#request(WEB_PROVIDERS.microsoft.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!t?.access_token) throw new MailError('Microsoft n\'a pas donné d\'accès');
    return { token: t.access_token, expires: this.now() + Number(t.expires_in || 3600) * 1000, refresh: t.refresh_token || previous };
  }

  /** Jeton valable du compte : renouvelé (Microsoft), sinon reconnexion demandée. */
  async #token(a) {
    if (a.token && a.expires > this.now() + 60_000) return a.token;
    if (a.provider === 'microsoft' && a.refresh) {
      try {
        Object.assign(a, await this.#redeem({ grant_type: 'refresh_token', refresh_token: a.refresh }, a.refresh));
        this.#save();
        return a.token;
      } catch (error) {
        if (!(error.status >= 400 && error.status < 500)) throw error;
        a.refresh = null; // renouvellement refusé (24 heures passées) : nouvelle connexion
      }
    }
    return this.#expired(a);
  }

  #expired(a) {
    const name = WEB_PROVIDERS[a.provider].name;
    Object.assign(a, { token: null, expires: 0 });
    if (!a.notified) {
      a.notified = true;
      this.notifications?.post({ appId: 'settings', title: `${name} : reconnexion nécessaire`, body: `${a.address} · touchez pour vous reconnecter`, tag: `webmail-${a.id}`, intent: { app: 'settings', action: 'view', data: { page: 'mail' } } });
      this.events?.emit('mail:reauth', { account: a.id });
    }
    this.#save();
    throw new MailError(`Connexion à ${name} expirée : reconnectez ${a.address} dans Réglages → Comptes de messagerie`);
  }

  async #request(url, { method = 'GET', headers = {}, body = null, text = false } = {}) {
    let r;
    try {
      r = await this.net.request(url, { method, headers: { Accept: 'application/json', ...headers }, body, responseType: text ? 'text' : 'json' });
    } catch (error) {
      throw Object.assign(new MailError(error.message), { status: error.status ?? 0 });
    }
    if (!r.ok) {
      const b = r.body && typeof r.body === 'object' ? r.body : {};
      const message = b.error?.message || b.error_description || (typeof b.error === 'string' ? b.error : '') || `Le service a répondu ${r.status}`;
      throw Object.assign(new MailError(message), { status: r.status });
    }
    return text ? { text: r.body, headers: r.headers } : r.body;
  }

  /** Requête authentifiée ; jeton refusé : un renouvellement (Microsoft), sinon reconnexion. */
  async #api(a, url, { method = 'GET', query = null, body = undefined, headers = {}, text = false } = {}) {
    // Espaces en %20 (et non « + ») : les paramètres OData de Graph l'exigent.
    const search = query && Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const full = search ? `${url}?${search}` : url;
    const extra = a.provider === 'microsoft' ? { Prefer: GRAPH_PREFER, ...headers } : headers;
    const json = body !== undefined && typeof body !== 'string';
    const send = async () => this.#request(full, { method, text, body: json ? JSON.stringify(body) : (body ?? null), headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...extra, Authorization: `Bearer ${await this.#token(a)}` } });
    try {
      return await send();
    } catch (error) {
      if (error.status !== 401) throw error;
      a.expires = 0;
      if (a.provider !== 'microsoft' || !a.refresh) return this.#expired(a);
      return send();
    }
  }

  // ───────────── Courrier ─────────────

  #remember(a, uid, id) {
    let map = this.#ids.get(a.id);
    if (!map) this.#ids.set(a.id, (map = new Map()));
    map.set(uid, id);
    if (map.size > 5000) map.delete(map.keys().next().value);
    return uid;
  }

  #page(key, value) {
    if (value === undefined) return this.#pages.get(key);
    this.#pages.set(key, value);
    if (this.#pages.size > 200) this.#pages.delete(this.#pages.keys().next().value);
  }

  /** Identifiant du fournisseur d'un uid (cherché autour de sa date s'il n'est plus en mémoire). */
  async #resolve(a, folder, uid) {
    const known = this.#ids.get(a.id)?.get(uid);
    if (known) return known;
    const ms = msOf(uid);
    if (a.provider === 'google') {
      const list = await this.#api(a, `${GMAIL}/messages`, { query: { q: `after:${Math.floor(ms / 1000) - 1} before:${Math.floor(ms / 1000) + 2}`, maxResults: 50, includeSpamTrash: 'true' } });
      for (const m of list.messages ?? []) this.#remember(a, uidOf(Number((await this.#api(a, `${GMAIL}/messages/${m.id}`, { query: { format: 'minimal' } })).internalDate), m.id), m.id);
    } else {
      const iso = (t) => new Date(t).toISOString();
      const list = await this.#api(a, `${GRAPH}/me/messages`, { query: { $filter: `receivedDateTime ge ${iso(ms - 1000)} and receivedDateTime le ${iso(ms + 1000)}`, $select: 'id,receivedDateTime', $top: 50 } });
      for (const m of list.value ?? []) this.#remember(a, uidOf(Date.parse(m.receivedDateTime), m.id), m.id);
    }
    const found = this.#ids.get(a.id)?.get(uid);
    if (!found) throw Object.assign(new MailError('Message introuvable : il a été déplacé ou supprimé'), { status: 404 });
    return found;
  }

  folders(id) {
    const a = this.#get(id);
    return a.provider === 'google' ? this.#gmailFolders(a) : this.#graphFolders(a);
  }

  /** Messages d'un dossier, du plus récent au plus ancien ; `before` : uid de la page suivante. */
  messages(id, folder, { before = null, limit = 40, query = '', filter = '' } = {}) {
    const a = this.#get(id);
    const options = { before: Number.isInteger(before) && before > 0 ? before : null, limit: Math.min(100, Math.max(1, Number(limit) || 40)), query: oneLine(query).slice(0, 200), filter: ['unread', 'flagged'].includes(filter) ? filter : '' };
    return a.provider === 'google' ? this.#gmailMessages(a, String(folder), options) : this.#graphMessages(a, String(folder), options);
  }

  message(id, folder, uid) {
    const a = this.#get(id);
    return a.provider === 'google' ? this.#gmailMessage(a, String(folder), Number(uid)) : this.#graphMessage(a, String(folder), Number(uid));
  }

  async setFlags(id, folder, uids, { add = [], remove = [] } = {}) {
    const a = this.#get(id);
    const ids = await Promise.all(uids.map((uid) => this.#resolve(a, folder, uid)));
    if (a.provider === 'google') {
      const addLabelIds = [...(remove.includes('seen') ? ['UNREAD'] : []), ...(add.includes('flagged') ? ['STARRED'] : [])];
      const removeLabelIds = [...(add.includes('seen') ? ['UNREAD'] : []), ...(remove.includes('flagged') ? ['STARRED'] : [])];
      if (addLabelIds.length || removeLabelIds.length) await this.#api(a, `${GMAIL}/messages/batchModify`, { method: 'POST', body: { ids, addLabelIds, removeLabelIds } });
      return;
    }
    const patch = {};
    if (add.includes('seen') || remove.includes('seen')) patch.isRead = add.includes('seen');
    if (add.includes('flagged') || remove.includes('flagged')) patch.flag = { flagStatus: add.includes('flagged') ? 'flagged' : 'notFlagged' };
    if (Object.keys(patch).length) await this.#graphBatch(a, ids.map((x) => ({ method: 'PATCH', url: `/me/messages/${x}`, body: patch })));
  }

  /** Déplace vers un dossier (son identifiant) ou un rôle (« archive », « inbox »…). Renvoie le dossier d'arrivée. */
  async move(id, folder, uids, to) {
    const a = this.#get(id);
    const ids = await Promise.all(uids.map((uid) => this.#resolve(a, folder, uid)));
    if (a.provider === 'google') {
      // Gmail : des libellés. Archiver, c'est retirer « Réception ».
      const role = Object.entries(GMAIL_ROLES).find(([, r]) => r === to)?.[0];
      const target = to === 'archive' || to === 'all' ? GMAIL_ALL : role ?? String(to);
      if (target === folder) return folder;
      const removeLabelIds = [...new Set([folder, ...(target === GMAIL_ALL ? ['INBOX'] : [])])].filter((l) => l !== GMAIL_ALL);
      await this.#api(a, `${GMAIL}/messages/batchModify`, { method: 'POST', body: { ids, addLabelIds: target === GMAIL_ALL ? [] : [target], removeLabelIds } });
      return target;
    }
    const known = Object.entries(GRAPH_ROLES).find(([, r]) => r === to)?.[0];
    const destination = known ?? String(to);
    const results = await this.#graphBatch(a, ids.map((x) => ({ method: 'POST', url: `/me/messages/${x}/move`, body: { destinationId: destination } })));
    const moved = results.find((r) => r?.parentFolderId)?.parentFolderId;
    return moved ?? destination;
  }

  /** Corbeille ; suppression définitive si le message y est déjà. */
  async remove(id, folder, uids) {
    const a = this.#get(id);
    if (a.provider === 'google') {
      if (folder !== 'TRASH') return this.move(id, folder, uids, 'trash');
      const ids = await Promise.all(uids.map((uid) => this.#resolve(a, folder, uid)));
      await this.#api(a, `${GMAIL}/messages/batchDelete`, { method: 'POST', body: { ids } });
      return null;
    }
    const trash = (await this.#graphRoles(a)).trash;
    if (folder !== trash && folder !== 'deleteditems') return this.move(id, folder, uids, 'trash');
    const ids = await Promise.all(uids.map((uid) => this.#resolve(a, folder, uid)));
    await this.#graphBatch(a, ids.map((x) => ({ method: 'DELETE', url: `/me/messages/${x}` })));
    return null;
  }

  async send(id, { to = [], cc = [], bcc = [], subject = '', text = '', inReplyTo = '', references = '' } = {}) {
    const a = this.#get(id);
    const message = { to: recipients(to), cc: recipients(cc), bcc: recipients(bcc), subject: oneLine(subject).slice(0, 500), text: String(text ?? '') };
    const count = message.to.length + message.cc.length + message.bcc.length;
    if (!count) throw new MailError('Indiquez au moins un destinataire');
    if (count > 100) throw new MailError('100 destinataires au plus');
    if (message.text.length > MAX_SEND) throw new MailError('Message trop long (100 000 caractères au plus)');
    if (a.provider === 'google') {
      const raw = buildMime({ from: { name: a.name, address: a.address }, ...message, inReplyTo, references, date: this.now() });
      await this.#api(a, `${GMAIL}/messages/send`, { method: 'POST', body: { raw: base64url(utf8(raw)) } });
      return { ok: true, messageId: '', refused: [], savedTo: 'SENT' };
    }
    const people = (list) => list.map((r) => ({ emailAddress: { address: r.address, ...(r.name ? { name: r.name } : {}) } }));
    const fields = { subject: message.subject, body: { contentType: 'Text', content: message.text }, toRecipients: people(message.to), ccRecipients: people(message.cc), bccRecipients: people(message.bcc) };
    // Réponse : brouillon de réponse d'Outlook (il garde la conversation), puis envoi.
    const original = oneLine(inReplyTo) && (await this.#api(a, `${GRAPH}/me/messages`, { query: { $filter: `internetMessageId eq '${oneLine(inReplyTo).replace(/'/g, "''")}'`, $select: 'id', $top: 1 } }).catch(() => null))?.value?.[0];
    if (original) {
      const draft = await this.#api(a, `${GRAPH}/me/messages/${original.id}/createReply`, { method: 'POST', body: {} });
      await this.#api(a, `${GRAPH}/me/messages/${draft.id}`, { method: 'PATCH', body: fields });
      await this.#api(a, `${GRAPH}/me/messages/${draft.id}/send`, { method: 'POST', body: {} });
    } else await this.#api(a, `${GRAPH}/me/sendMail`, { method: 'POST', body: { message: fields, saveToSentItems: true } });
    return { ok: true, messageId: '', refused: [], savedTo: (await this.#graphRoles(a).catch(() => ({}))).sent ?? 'sentitems' };
  }

  // ───────────── Gmail ─────────────

  /** Plusieurs lectures en une requête (API « batch » de Gmail, 100 au plus). */
  async #gmailBatch(a, paths) {
    const results = [];
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const boundary = `orion_${base64url(this.crypto.getRandomValues(new Uint8Array(9)))}`;
      const body = `${chunk.map((path, j) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <i${j}>\r\n\r\nGET /gmail/v1/users/me/${path}\r\n\r\n`).join('')}--${boundary}--\r\n`;
      const r = await this.#api(a, GMAIL_BATCH, { method: 'POST', headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` }, body, text: true });
      results.push(...parseBatch(r.text, r.headers['content-type'], chunk.length));
    }
    return results;
  }

  async #gmailFolders(a) {
    const [labels, counts] = await Promise.all([this.#api(a, `${GMAIL}/labels`), this.#gmailBatch(a, Object.keys(GMAIL_ROLES).map((id) => `labels/${id}`))]);
    const system = Object.entries(GMAIL_ROLES).map(([id, role], i) => ({ id, name: ROLE_NAMES[role], role, unread: counts[i]?.messagesUnread ?? null, total: counts[i]?.messagesTotal ?? null }));
    const mine = (labels.labels ?? [])
      .filter((l) => l.type === 'user')
      .sort((x, y) => x.name.localeCompare(y.name, 'fr'))
      .map((l) => ({ id: l.id, name: l.name.split('/').join(' › '), role: null, unread: null, total: null }));
    return [...system.slice(0, 3), { id: GMAIL_ALL, name: ROLE_NAMES.all, role: 'all', unread: null, total: null }, ...system.slice(3), ...mine];
  }

  #gmailSummary(a, m) {
    const headers = m.payload?.headers ?? [];
    const labels = m.labelIds ?? [];
    const date = Number(m.internalDate) || Date.parse(header(headers, 'date')) || 0;
    return {
      uid: this.#remember(a, uidOf(date, m.id), m.id),
      from: parseAddresses(header(headers, 'from'))[0] ?? { name: '', address: '' },
      to: parseAddresses(header(headers, 'to')),
      cc: parseAddresses(header(headers, 'cc')),
      subject: decodeWords(header(headers, 'subject')),
      date,
      seen: !labels.includes('UNREAD'),
      flagged: labels.includes('STARRED'),
      answered: false,
      size: m.sizeEstimate ?? 0,
      attachments: /multipart\/mixed/i.test(header(headers, 'content-type')),
      preview: decodeEntities(m.snippet ?? ''),
    };
  }

  async #gmailMessages(a, folder, { before, limit, query, filter }) {
    const q = [query, filter === 'unread' ? 'is:unread' : '', filter === 'flagged' ? 'is:starred' : ''].filter(Boolean).join(' ');
    const key = `${a.id}|${folder}|${q}`;
    const token = before ? this.#page(`${key}|${before}`) : null;
    // Page suivante inconnue (Orion redémarré) : par la date.
    const search = before && !token ? `${q} before:${Math.floor(msOf(before) / 1000) + 1}`.trim() : q;
    const list = await this.#api(a, `${GMAIL}/messages`, { query: { maxResults: limit, labelIds: folder === GMAIL_ALL ? null : folder, q: search, pageToken: token } });
    const metas = await this.#gmailBatch(a, (list.messages ?? []).map((m) => `messages/${m.id}?format=metadata&${GMAIL_HEADERS}`));
    const messages = metas
      .filter(Boolean)
      .map((m) => this.#gmailSummary(a, m))
      .filter((m) => !before || m.uid < before)
      .sort((x, y) => y.uid - x.uid);
    if (list.nextPageToken && messages.length) this.#page(`${key}|${messages.at(-1).uid}`, list.nextPageToken);
    return { messages, more: Boolean(list.nextPageToken), uidValidity: 1 };
  }

  async #gmailMessage(a, folder, uid) {
    const m = await this.#api(a, `${GMAIL}/messages/${await this.#resolve(a, folder, uid)}`, { query: { format: 'full' } });
    const headers = m.payload?.headers ?? [];
    const parts = [];
    const walk = (part) => {
      if (!part) return;
      parts.push(part);
      (part.parts ?? []).forEach(walk);
    };
    walk(m.payload);
    const charset = (part) => /charset="?([\w.-]+)"?/i.exec(header(part.headers ?? [], 'content-type'))?.[1];
    const bodyOf = (part) => (part?.body?.data ? decodeBytes(fromBase64(part.body.data), charset(part)) : '');
    const inline = parts.filter((part) => !part.filename && part.body?.data);
    const plain = inline.find((part) => part.mimeType === 'text/plain');
    const html = !plain && inline.find((part) => part.mimeType === 'text/html');
    const full = plain ? bodyOf(plain) : htmlToText(bodyOf(html));
    return {
      ...this.#gmailSummary(a, m),
      text: full.slice(0, MAX_TEXT),
      html: Boolean(html),
      truncated: full.length > MAX_TEXT,
      attachments: parts.filter((part) => part.filename).map((part) => ({ name: part.filename, type: part.mimeType, size: part.body?.size ?? 0 })),
      replyTo: parseAddresses(header(headers, 'reply-to')),
      messageId: header(headers, 'message-id'),
      references: header(headers, 'references'),
    };
  }

  // ───────────── Outlook (Microsoft Graph) ─────────────

  /** Plusieurs requêtes en une (« $batch », 20 au plus) ; corps de chaque réponse, dans l'ordre. */
  async #graphBatch(a, requests, { strict = true } = {}) {
    const results = [];
    for (let i = 0; i < requests.length; i += 20) {
      const chunk = requests.slice(i, i + 20);
      const r = await this.#api(a, `${GRAPH}/$batch`, {
        method: 'POST',
        body: { requests: chunk.map((req, j) => ({ id: String(j), method: req.method, url: req.url, headers: { Prefer: GRAPH_PREFER, ...(req.body ? { 'Content-Type': 'application/json' } : {}) }, ...(req.body ? { body: req.body } : {}) })) },
      });
      const byId = new Map((r?.responses ?? []).map((x) => [Number(x.id), x]));
      chunk.forEach((req, j) => {
        const x = byId.get(j);
        if (strict && (!x || x.status >= 400)) throw Object.assign(new MailError(x?.body?.error?.message || 'Opération refusée par Outlook'), { status: x?.status ?? 502 });
        results.push(x && x.status < 400 ? (x.body ?? {}) : null);
      });
    }
    return results;
  }

  /** Dossiers à rôle d'Outlook : rôle → identifiant. */
  async #graphRoles(a) {
    if (this.#roles.has(a.id)) return this.#roles.get(a.id);
    const names = Object.keys(GRAPH_ROLES);
    const found = await this.#graphBatch(a, names.map((name) => ({ method: 'GET', url: `/me/mailFolders/${name}?$select=id` })), { strict: false });
    const roles = {};
    names.forEach((name, i) => found[i]?.id && (roles[GRAPH_ROLES[name]] = found[i].id));
    this.#roles.set(a.id, roles);
    return roles;
  }

  async #graphFolders(a) {
    const [list, roles] = await Promise.all([this.#api(a, `${GRAPH}/me/mailFolders`, { query: { $top: 100, $select: 'id,displayName,unreadItemCount,totalItemCount' } }), this.#graphRoles(a)]);
    const roleOf = new Map(Object.entries(roles).map(([role, id]) => [id, role]));
    const order = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
    return (list.value ?? [])
      .map((f) => {
        const role = roleOf.get(f.id) ?? null;
        return { id: f.id, name: role ? ROLE_NAMES[role] : f.displayName, role, unread: role ? (f.unreadItemCount ?? null) : null, total: role ? (f.totalItemCount ?? null) : null };
      })
      .sort((x, y) => (x.role ? order.indexOf(x.role) : 99) - (y.role ? order.indexOf(y.role) : 99) || x.name.localeCompare(y.name, 'fr'));
  }

  #graphSummary(a, m) {
    const date = Date.parse(m.receivedDateTime) || 0;
    const person = (r) => ({ name: r?.emailAddress?.name ?? '', address: r?.emailAddress?.address ?? '' });
    return {
      uid: this.#remember(a, uidOf(date, m.id), m.id),
      from: person(m.from),
      to: (m.toRecipients ?? []).map(person),
      cc: (m.ccRecipients ?? []).map(person),
      subject: m.subject ?? '',
      date,
      seen: Boolean(m.isRead),
      flagged: m.flag?.flagStatus === 'flagged',
      answered: false,
      size: 0,
      attachments: Boolean(m.hasAttachments),
      preview: m.bodyPreview ?? '',
    };
  }

  async #graphMessages(a, folder, { before, limit, query, filter }) {
    const key = `${a.id}|${folder}|${query}|${filter}`;
    const next = before ? this.#page(`${key}|${before}`) : null;
    let r;
    if (next) r = await this.#api(a, next);
    else {
      const params = { $top: limit, $select: GRAPH_SELECT };
      if (query) params.$search = `"${query.replace(/["\\]/g, '')}"`; // la recherche ne se combine ni au tri ni aux filtres
      else {
        // Graph : la propriété de tri doit ouvrir le filtre.
        const since = before ? `receivedDateTime lt ${new Date(msOf(before)).toISOString()}` : 'receivedDateTime ge 1970-01-01T00:00:00Z';
        params.$filter = [since, filter === 'unread' ? 'isRead eq false' : '', filter === 'flagged' ? "flag/flagStatus eq 'flagged'" : ''].filter(Boolean).join(' and ');
        params.$orderby = 'receivedDateTime desc';
      }
      r = await this.#api(a, `${GRAPH}/me/mailFolders/${encodeURIComponent(folder)}/messages`, { query: params });
    }
    const messages = (r.value ?? [])
      .map((m) => this.#graphSummary(a, m))
      .filter((m) => (!before || m.uid < before) && (filter !== 'unread' || !m.seen) && (filter !== 'flagged' || m.flagged))
      .sort((x, y) => y.uid - x.uid);
    const link = r['@odata.nextLink'];
    if (link && messages.length) this.#page(`${key}|${messages.at(-1).uid}`, link);
    return { messages, more: Boolean(link), uidValidity: 1 };
  }

  async #graphMessage(a, folder, uid) {
    const id = await this.#resolve(a, folder, uid);
    const m = await this.#api(a, `${GRAPH}/me/messages/${id}`, { query: { $select: `${GRAPH_SELECT},replyTo,internetMessageId,internetMessageHeaders,body` }, headers: { Prefer: `${GRAPH_PREFER}, outlook.body-content-type="text"` } });
    const files = m.hasAttachments ? ((await this.#api(a, `${GRAPH}/me/messages/${id}/attachments`, { query: { $select: 'name,contentType,size,isInline' } }).catch(() => null))?.value ?? []) : [];
    const text = m.body?.contentType === 'html' ? htmlToText(m.body.content) : String(m.body?.content ?? '');
    const headers = m.internetMessageHeaders ?? [];
    return {
      ...this.#graphSummary(a, m),
      text: text.slice(0, MAX_TEXT),
      html: m.body?.contentType === 'html',
      truncated: text.length > MAX_TEXT,
      attachments: files.filter((f) => !f.isInline).map((f) => ({ name: f.name, type: f.contentType, size: f.size ?? 0 })),
      replyTo: (m.replyTo ?? []).map((r) => ({ name: r.emailAddress?.name ?? '', address: r.emailAddress?.address ?? '' })),
      messageId: m.internetMessageId ?? '',
      references: header(headers, 'references'),
    };
  }
}
