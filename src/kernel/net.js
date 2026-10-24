/**
 * Accès à Internet pour les apps (autorisation « Internet », SDK orion.net)
 * et pour les services d'Orion qui parlent à des services en ligne.
 *
 * Les apps du Store tournent sans réseau (iframe isolée, politique de
 * sécurité) : Orion fait leurs requêtes, après avoir vérifié l'adresse.
 * Jamais Orion lui-même (ses fichiers, le pont orion-server) ni le réseau
 * local (box, imprimantes, autres machines) : seulement http(s) vers Internet.
 *
 *   - Orion installé : orion-server fait la requête (POST /api/net/request,
 *     voir server/orion_net.py), sans les limites des navigateurs et avec sa
 *     propre vérification des adresses IP ;
 *   - téléphone, navigateur : fetch() d'Orion, sans cookies ni référent. Le
 *     site doit accepter les requêtes d'un navigateur (CORS), comme les API de
 *     Mastodon, de Google ou de Microsoft.
 */
export const MAX_REQUEST_BODY = 1024 * 1024;
export const MAX_RESPONSE = 8 * 1024 * 1024;
const TIMEOUT = 30_000;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const FORBIDDEN_HEADER = /^(?:host|cookie2?|origin|referer|connection|content-length|transfer-encoding|keep-alive|upgrade|te|trailer|expect|accept-encoding|x-orion|proxy-.*|sec-.*)$/i;
const RESPONSE_HEADERS = ['content-type', 'link', 'location', 'etag', 'last-modified', 'retry-after', 'www-authenticate', 'content-language', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

export class NetError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Nom ou adresse du réseau local, de l'appareil, ou réservée (le constructeur URL a normalisé les formes d'IPv4). */
export function blockedHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c <= 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (host.includes(':')) return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host) || host.startsWith('::ffff:') || host.startsWith('64:ff9b:') || host.startsWith('2001:db8:');
  return false;
}

/** Adresse qu'une app peut joindre, sinon NetError. `self` : origine d'Orion. */
export function checkUrl(value, { self = null } = {}) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    throw new NetError('Adresse invalide', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new NetError('Seules les adresses http et https sont autorisées', 400);
  if (url.username || url.password) throw new NetError('Identifiants dans l\'adresse refusés', 400);
  if (self && url.origin === self) throw new NetError('Les apps n\'ont pas accès aux fichiers d\'Orion', 403);
  if (blockedHost(url.hostname)) throw new NetError('Le réseau local et l\'appareil lui-même sont inaccessibles aux apps', 403);
  return url;
}

function cleanHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers).slice(0, 50)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADER.test(name)) continue;
    out[name] = String(value).replace(/[\r\n]/g, '').slice(0, 4096);
  }
  return out;
}

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class NetService {
  constructor({ bridge = null, env = globalThis, log = null } = {}) {
    this.bridge = bridge;
    this.env = env;
    this.log = log;
  }

  /** Orion installé : orion-server fait les requêtes (pas de limite CORS). */
  get proxied() {
    return Boolean(this.bridge?.has('net'));
  }

  get origin() {
    return this.env.location?.origin ?? null;
  }

  /**
   * Fait une requête. `body` : texte (ou base64 avec bodyEncoding: 'base64') ;
   * `responseType` : 'text' | 'json' | 'base64'. Renvoie { ok, status, url, headers, body }.
   */
  async request(input, { method = 'GET', headers = {}, body = null, bodyEncoding = 'text', responseType = 'text', timeout = TIMEOUT } = {}) {
    const url = checkUrl(input, { self: this.origin });
    const verb = String(method).toUpperCase();
    if (!METHODS.includes(verb)) throw new NetError('Méthode HTTP refusée', 400);
    const sent = body == null || verb === 'GET' || verb === 'HEAD' ? null : String(body);
    const size = sent == null ? 0 : bodyEncoding === 'base64' ? Math.floor((sent.length * 3) / 4) : new TextEncoder().encode(sent).length;
    if (size > MAX_REQUEST_BODY) throw new NetError('Requête trop volumineuse (1 Mo au plus)', 413);
    const type = ['json', 'base64'].includes(responseType) ? responseType : 'text';
    const clean = cleanHeaders(headers);

    let result;
    if (this.proxied) {
      try {
        result = await this.bridge.post('net/request', { url: url.href, method: verb, headers: clean, body: sent, bodyEncoding: bodyEncoding === 'base64' ? 'base64' : 'text', responseType: type === 'json' ? 'text' : type }, { timeout: timeout + 5000 });
      } catch (error) {
        throw new NetError(error.message, error.status ?? 502);
      }
    } else {
      result = await this.#browser(url, verb, clean, sent, bodyEncoding, type, timeout);
    }
    if (type === 'json') {
      try {
        result.body = result.body === '' ? null : JSON.parse(result.body);
      } catch {
        if (result.ok) throw new NetError('Réponse JSON invalide', 502);
      }
    }
    return { ok: Boolean(result.ok), status: result.status, url: result.url, headers: result.headers ?? {}, body: result.body };
  }

  async #browser(url, method, headers, body, bodyEncoding, type, timeout) {
    let payload = body ?? undefined;
    if (body != null && bodyEncoding === 'base64') {
      try {
        payload = fromBase64(body);
      } catch {
        throw new NetError('Corps de requête invalide (base64)', 400);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await this.env.fetch(url.href, {
        method,
        headers,
        body: payload,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') throw new NetError(`${url.hostname} ne répond pas`, 504);
      if (this.env.navigator?.onLine === false) throw new NetError('Pas de connexion à Internet', 0);
      throw new NetError(`${url.hostname} est injoignable, ou n'accepte pas les demandes venant d'un navigateur (CORS) : sur Orion installé, la requête passe par orion-server`, 502);
    }
    try {
      // Redirection suivie par le navigateur : la destination doit rester sur Internet.
      if (response.url && response.url !== url.href) checkUrl(response.url, { self: this.origin });
      const bytes = await readCapped(response, MAX_RESPONSE);
      const picked = {};
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value != null) picked[name] = value;
      }
      return { ok: response.ok, status: response.status, url: response.url || url.href, headers: picked, body: type === 'base64' ? toBase64(bytes) : new TextDecoder().decode(bytes) };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readCapped(response, max) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) throw new NetError('Réponse trop volumineuse (8 Mo au plus)', 502);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw new NetError('Réponse trop volumineuse (8 Mo au plus)', 502);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      reader.cancel().catch(() => {});
      throw new NetError('Réponse trop volumineuse (8 Mo au plus)', 502);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
