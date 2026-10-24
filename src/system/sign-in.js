/**
 * « Continuer avec Google / Microsoft » : la page de connexion du fournisseur
 * s'ouvre dans une fenêtre, qui revient sur src/auth.html ; celle-ci renvoie
 * le jeton à Orion (BroadcastChannel, ou la fenêtre qui l'a ouverte). Quand
 * aucune fenêtre ne peut s'ouvrir (bloquée, app installée sur iPhone), la
 * connexion se fait dans la page même et Orion la termine au redémarrage.
 * Le jeton est vérifié par le noyau (kernel/identity.js).
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { IdentityError, randomToken } from '../kernel/identity.js';
import { platform } from './platform.js';

const CHANNEL = 'orion-auth';
const PENDING = 'orion-auth-pending';
const RESULT = 'orion-auth-result';
const TIMEOUT = 10 * 60_000;

export const redirectUri = () => new URL('src/auth.html', new URL('./', location.href)).href;

function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function failure(message) {
  if (message.error === 'access_denied' || message.error === 'user_cancelled') return new IdentityError('Connexion annulée');
  return new IdentityError(`Connexion refusée par le fournisseur${message.description ? ` : ${message.description}` : ''}`);
}

/**
 * Ouvre la connexion du fournisseur. Renvoie { promise, cancel } ; la promesse
 * donne { identity, name } une fois le jeton vérifié. `purpose` est rappelé au
 * retour d'une connexion faite dans la page (« setup » ou « link »).
 */
export function signInWithProvider(kernel, provider, { loginHint = '', purpose = 'link' } = {}) {
  const inPage = platform.ios && platform.installed;
  const { url, state, nonce } = kernel.identity.beginOidc(provider, { redirectUri: redirectUri(), loginHint, state: `${inPage ? 'r' : 'p'}${randomToken()}` });
  const popup = inPage ? null : window.open(url, 'orion-sign-in', 'popup,width=500,height=720');
  if (!popup) {
    const store = storage();
    if (!store) return { promise: Promise.reject(new IdentityError('Connexion impossible : ouvrez Orion dans le navigateur')), cancel() {} };
    const again = inPage ? { url, state } : kernel.identity.beginOidc(provider, { redirectUri: redirectUri(), loginHint, state: `r${randomToken()}`, nonce });
    store.setItem(PENDING, JSON.stringify({ provider, state: again.state, nonce, purpose }));
    location.assign(again.url);
    return { promise: new Promise(() => {}), cancel() {} };
  }
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
    const finish = (fn, value) => {
      channel?.close();
      window.removeEventListener('message', onWindowMessage);
      clearTimeout(timer);
      try {
        popup.close();
      } catch {
        /* déjà fermée */
      }
      fn(value);
    };
    const onMessage = (message) => {
      if (message?.type !== 'orion-auth' || message.state !== state) return;
      if (message.error || !message.idToken) return finish(reject, failure(message));
      kernel.identity.completeOidc(provider, { idToken: message.idToken, nonce }).then((result) => finish(resolve, result), (error) => finish(reject, error));
    };
    const onWindowMessage = (event) => event.origin === location.origin && onMessage(event.data);
    if (channel) channel.onmessage = (event) => onMessage(event.data);
    window.addEventListener('message', onWindowMessage);
    // La fenêtre du fournisseur ne dit pas toujours qu'elle a été fermée : délai, et bouton Annuler.
    const timer = setTimeout(() => finish(reject, new IdentityError('Connexion expirée')), TIMEOUT);
    cancel = () => finish(reject, new IdentityError('Connexion annulée'));
  });
  return { promise, cancel: () => cancel() };
}

/**
 * Connexion faite dans la page, au retour du fournisseur : { provider, purpose,
 * finish() } (finish vérifie le jeton), ou null. Lue une seule fois.
 */
export function takeRedirectResult(kernel) {
  const store = storage();
  if (!store) return null;
  let pending;
  let message;
  try {
    pending = JSON.parse(store.getItem(PENDING) ?? 'null');
    message = JSON.parse(store.getItem(RESULT) ?? 'null');
  } catch {
    pending = null;
  }
  store.removeItem(PENDING);
  store.removeItem(RESULT);
  if (!pending?.provider || !message || message.state !== pending.state) return null;
  return {
    provider: pending.provider,
    purpose: pending.purpose,
    finish: () => (message.error || !message.idToken ? Promise.reject(failure(message)) : kernel.identity.completeOidc(pending.provider, { idToken: message.idToken, nonce: pending.nonce })),
  };
}

/** Pastille du fournisseur (initiale sur sa couleur ; enveloppe pour « Autre adresse »). */
export function providerBadge(p, size = 40) {
  return h(
    'span.provider-badge',
    { style: { background: p.color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.48)}px`, borderRadius: `${Math.round(size * 0.28)}px` }, 'aria-hidden': 'true' },
    p.id === 'other' ? icon('mail', { size: Math.round(size * 0.5) }) : p.name[0],
  );
}

/** « camille.martin@gmail.com » → « Camille Martin » (proposé comme nom du profil). */
export function nameFromEmail(email) {
  const parts = String(email).split('@')[0].split(/[._-]+/).filter(Boolean);
  if (!parts.length || parts.length > 3 || !parts.every((p) => /^\p{L}{2,}$/u.test(p))) return '';
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}
