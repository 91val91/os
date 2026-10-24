/**
 * Compte en ligne : chaque utilisateur d'Orion associe à son profil un compte
 * Google (Gmail), Microsoft (Outlook, Hotmail, Live), Apple (iCloud), Yahoo
 * ou une autre adresse e-mail. Il est obligatoire : l'assistant le demande, et
 * un profil qui n'en a pas encore le reçoit au déverrouillage suivant.
 *
 * Orion n'a pas de serveur de comptes : l'adresse est vérifiée auprès du
 * fournisseur lui-même, de la meilleure façon disponible.
 *   1. OpenID Connect (« Continuer avec Google / Microsoft ») : le fournisseur
 *      authentifie la personne et renvoie un jeton d'identité signé, dont
 *      Orion vérifie la signature, l'émetteur, le destinataire, les dates et
 *      le nonce. Demande un identifiant client (config/identity.js).
 *   2. Connexion au serveur de messagerie de l'adresse (IMAP) par orion-server,
 *      sur Orion installé : seul le titulaire de la boîte peut s'y connecter.
 *   3. Sinon, l'adresse est enregistrée « non vérifiée », à vérifier plus tard
 *      dans Réglages → Compte.
 * Aucun mot de passe n'est conservé par Orion (la messagerie le garde côté
 * orion-server, si la personne choisit de relever ses e-mails).
 */
import { OIDC_CLIENTS } from '../config/identity.js';

export const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export const METHODS = ['oidc', 'mail', 'none'];

const MICROSOFT_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/;
const SKEW = 300; // secondes de décalage d'horloge tolérées
const KEYS_TTL = 6 * 3600_000;

export const PROVIDERS = Object.freeze([
  {
    id: 'google',
    name: 'Google',
    service: 'Gmail',
    color: '#ea4335',
    domains: ['gmail.com', 'googlemail.com'],
    oidc: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      keys: 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: (claims) => claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com',
      // Google indique si l'adresse a été vérifiée.
      email: (claims) => (claims.email_verified === true || claims.email_verified === 'true' ? claims.email : null),
    },
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    service: 'Outlook, Hotmail, Live',
    color: '#0078d4',
    domains: ['outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com', 'passport.com'],
    oidc: {
      authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      keys: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
      // Point d'accès « common » : l'émetteur est celui de l'annuaire du compte (tid).
      issuer: (claims) => MICROSOFT_ISSUER.exec(claims.iss ?? '')?.[1] === claims.tid,
      email: (claims) => claims.email ?? (EMAIL.test(claims.preferred_username ?? '') ? claims.preferred_username : null),
    },
  },
  { id: 'apple', name: 'Apple', service: 'iCloud', color: '#1d1d1f', domains: ['icloud.com', 'me.com', 'mac.com'] },
  { id: 'yahoo', name: 'Yahoo', service: 'Yahoo Mail', color: '#6001d2', domains: ['yahoo.com', 'yahoo.fr', 'ymail.com', 'rocketmail.com'] },
  { id: 'other', name: 'Autre adresse', service: 'Orange, Free, SFR, La Poste…', color: '#8e8e93', domains: [] },
]);

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export class IdentityError extends Error {}

export function provider(id) {
  return BY_ID.get(id) ?? null;
}

const domainOf = (email) => String(email).split('@').pop().toLowerCase();

/** Fournisseur d'une adresse d'après son domaine (« other » si inconnu). */
export function providerFor(email) {
  const domain = domainOf(email);
  return PROVIDERS.find((p) => p.domains.includes(domain))?.id ?? 'other';
}

/**
 * Vérifie qu'une adresse saisie correspond au fournisseur choisi. Renvoie le
 * fournisseur retenu : « Autre adresse » avec une adresse Gmail devient Google.
 */
export function checkAddress(providerId, email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!EMAIL.test(value)) throw new IdentityError('Cette adresse e-mail n\'est pas valide.');
  const detected = providerFor(value);
  if (providerId === 'other' || detected === providerId) return { provider: detected, email: value };
  const p = provider(providerId);
  const domains = (p?.domains ?? []).map((d) => `@${d}`);
  throw new IdentityError(`Ce n'est pas une adresse ${p?.service ?? ''} (${domains.slice(0, 3).join(', ')}${domains.length > 3 ? '…' : ''}). Pour une autre adresse, choisissez « Autre adresse ».`);
}

/** Identité enregistrée dans le registre des comptes, nettoyée. */
export function normalizeIdentity(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const email = String(value.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) return null;
  const method = METHODS.includes(value.method) ? value.method : 'none';
  const verified = method !== 'none' && value.verified === true;
  return {
    provider: BY_ID.has(value.provider) ? value.provider : providerFor(email),
    email,
    verified,
    method: verified ? method : 'none',
    subject: verified && value.subject ? String(value.subject).slice(0, 255) : null,
    linkedAt: Number.isFinite(value.linkedAt) ? value.linkedAt : now,
    verifiedAt: verified ? (Number.isFinite(value.verifiedAt) ? value.verifiedAt : now) : null,
  };
}

// ───────────── OpenID Connect ─────────────

function base64url(text) {
  const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const decodeJson = (part) => JSON.parse(new TextDecoder().decode(base64url(part)));

/** Adresse de connexion du fournisseur (flux implicite : jeton d'identité seul, rien d'autre). */
export function authorizeUrl(providerId, { clientId, redirectUri, state, nonce, loginHint = '' }) {
  const config = provider(providerId)?.oidc;
  if (!config || !clientId) throw new IdentityError('Connexion directe indisponible pour ce fournisseur');
  const url = new URL(config.authorize);
  const params = { client_id: clientId, redirect_uri: redirectUri, response_type: 'id_token', scope: 'openid email profile', state, nonce, prompt: 'select_account' };
  if (loginHint) params.login_hint = loginHint;
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

/**
 * Vérifie un jeton d'identité (JWT signé RS256) et renvoie ce qu'il atteste.
 * `key(kid)` fournit la clé publique (JWK) du fournisseur.
 */
export async function verifyIdToken(token, { provider: providerId, clientId, nonce, key, now = Date.now(), subtle = globalThis.crypto?.subtle }) {
  const config = provider(providerId)?.oidc;
  if (!config) throw new IdentityError('Fournisseur inconnu');
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new IdentityError('Jeton d\'identité illisible');
  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw new IdentityError('Jeton d\'identité illisible');
  }
  if (header.alg !== 'RS256') throw new IdentityError('Signature du jeton non prise en charge');
  const jwk = await key(header.kid);
  if (!jwk || jwk.kty !== 'RSA') throw new IdentityError('Clé de signature du fournisseur introuvable');
  const publicKey = await subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await subtle.verify('RSASSA-PKCS1-v1_5', publicKey, base64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new IdentityError('Signature du jeton invalide');
  if (!config.issuer(claims)) throw new IdentityError('Jeton émis par un autre fournisseur');
  if (!(claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId)))) throw new IdentityError('Jeton destiné à une autre application');
  const t = now / 1000;
  if (!(claims.exp > t - SKEW) || claims.iat > t + SKEW || claims.nbf > t + SKEW) throw new IdentityError('Jeton expiré : vérifiez l\'heure de l\'appareil et recommencez');
  if (!nonce || claims.nonce !== nonce) throw new IdentityError('Jeton rejoué ou demandé par une autre session');
  const email = config.email(claims);
  if (!email || !EMAIL.test(email)) throw new IdentityError('Le fournisseur n\'a pas confirmé d\'adresse e-mail pour ce compte');
  if (!claims.sub) throw new IdentityError('Jeton sans identifiant de compte');
  return { subject: String(claims.sub), email: email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name.trim().slice(0, 40) : '' };
}

/** Jeton aléatoire pour `state` et `nonce`. */
export function randomToken(bytes = 18, crypto = globalThis.crypto) {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buffer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ───────────── Service ─────────────

export class IdentityService {
  #keys = new Map(); // fournisseur → { at, keys }

  constructor({ accounts = null, account = () => null, mail = null, clients = OIDC_CLIENTS, events = null, log = null, now = Date.now, fetch = globalThis.fetch?.bind(globalThis), subtle = globalThis.crypto?.subtle } = {}) {
    this.accounts = accounts;
    this.accountId = account;
    this.mail = mail;
    this.clients = clients;
    this.events = events;
    this.log = log;
    this.now = now;
    this.fetch = fetch;
    this.subtle = subtle;
  }

  /** Compte en ligne du profil en cours (null s'il n'en a pas encore). */
  get identity() {
    return this.accounts?.get(this.accountId())?.identity ?? null;
  }

  /** Le profil doit être associé à un compte en ligne avant d'aller plus loin. */
  get required() {
    return Boolean(this.accounts?.get(this.accountId())) && !this.identity;
  }

  /** Façons de vérifier une adresse de ce fournisseur, ici et maintenant. */
  methods(providerId) {
    return { oidc: Boolean(provider(providerId)?.oidc && this.clients?.[providerId] && this.subtle), mail: Boolean(this.mail?.available) };
  }

  /** Adresse enregistrée sans vérification (aucune méthode disponible, ou choix de la personne). */
  linkUnverified({ provider: providerId, email }) {
    const checked = checkAddress(providerId, email);
    return this.#save({ ...checked, method: 'none', verified: false });
  }

  /**
   * Vérifie l'adresse en se connectant à son serveur de réception (IMAP). Avec
   * `addMailbox`, le compte est aussi ajouté à la messagerie d'Orion (et ses
   * e-mails relevés) ; sinon le mot de passe sert à la vérification seulement.
   */
  async verifyWithMail({ provider: providerId, email, password, addMailbox = true, name = '' }) {
    const checked = checkAddress(providerId, email);
    if (!this.mail?.available) throw new IdentityError('La vérification par la messagerie demande Orion installé (orion-server)');
    if (!password) throw new IdentityError('Saisissez le mot de passe de ce compte.');
    const existing = (await this.mail.accounts({ refresh: true })).find((a) => a.address.toLowerCase() === checked.email);
    if (existing) {
      await this.mail.verifyLogin({ address: existing.address, username: existing.username, password, imap: existing.imap });
    } else {
      const config = await this.mail.autoconfig(checked.email);
      const servers = { address: checked.email, username: config.username, password, imap: config.imap };
      if (addMailbox) await this.mail.addAccount({ ...servers, name, smtp: config.smtp, saveSent: config.saveSent });
      else await this.mail.verifyLogin(servers);
    }
    return this.#save({ ...checked, method: 'mail', verified: true });
  }

  /** Prépare une connexion OpenID Connect : adresse du fournisseur, `state` et `nonce` à retenir. */
  beginOidc(providerId, { redirectUri, loginHint = '', state = randomToken(), nonce = randomToken() }) {
    if (!this.methods(providerId).oidc) throw new IdentityError('Connexion directe indisponible pour ce fournisseur');
    return { url: authorizeUrl(providerId, { clientId: this.clients[providerId], redirectUri, state, nonce, loginHint }), state, nonce };
  }

  /** Vérifie le jeton renvoyé par le fournisseur et associe le compte. Renvoie aussi le nom donné par le fournisseur. */
  async completeOidc(providerId, { idToken, nonce }) {
    const claims = await verifyIdToken(idToken, { provider: providerId, clientId: this.clients[providerId], nonce, key: (kid) => this.#key(providerId, kid), now: this.now(), subtle: this.subtle });
    const identity = this.#save({ provider: providerId, email: claims.email, method: 'oidc', verified: true, subject: claims.subject });
    return { identity, name: claims.name };
  }

  /** Clés publiques du fournisseur, gardées quelques heures ; relues si la clé demandée est nouvelle. */
  async #key(providerId, kid) {
    const cached = this.#keys.get(providerId);
    const find = (set) => set?.keys.find((k) => k.kid === kid) ?? null;
    if (cached && this.now() - cached.at < KEYS_TTL && find(cached)) return find(cached);
    let response;
    try {
      response = await this.fetch(provider(providerId).oidc.keys, { cache: 'no-store' });
    } catch {
      throw new IdentityError('Pas de connexion à Internet : impossible de vérifier le jeton');
    }
    if (!response.ok) throw new IdentityError(`Clés du fournisseur indisponibles (${response.status})`);
    const set = { at: this.now(), keys: (await response.json()).keys ?? [] };
    this.#keys.set(providerId, set);
    return find(set);
  }

  #save(identity) {
    const id = this.accountId();
    if (!this.accounts?.get(id)) throw new IdentityError('Profil introuvable');
    const previous = this.identity;
    const value = normalizeIdentity({ ...identity, linkedAt: previous?.email === identity.email ? previous.linkedAt : this.now(), verifiedAt: this.now() }, this.now());
    this.accounts.update(id, { identity: value });
    this.log?.info('identity', `compte ${provider(value.provider).name} associé${value.verified ? ` (vérifié : ${value.method})` : ' (non vérifié)'}`);
    this.events?.emit('account:identity', { provider: value.provider, verified: value.verified });
    return value;
  }
}
