import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AccountRegistry } from '../src/kernel/accounts.js';
import { MemoryBackend, Namespace } from '../src/kernel/storage.js';
import { HardwareBridge } from '../src/kernel/bridge.js';
import { MailService } from '../src/kernel/mail.js';
import { bootKernel } from '../src/kernel/kernel.js';
import { IdentityService, IdentityError, PROVIDERS, providerFor, checkAddress, normalizeIdentity, authorizeUrl, verifyIdToken } from '../src/kernel/identity.js';
import { nameFromEmail } from '../src/system/sign-in.js';
import { fakeBridge } from './fake-bridge.js';

const subtle = webcrypto.subtle;
const NOW = Date.UTC(2026, 9, 24, 12);
const GOOGLE_CLIENT = '1234-orion.apps.googleusercontent.com';
const MS_CLIENT = '6731de76-14a6-49ae-97bc-6eba6914391e';
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';

const b64url = (data) => Buffer.from(typeof data === 'string' ? data : new Uint8Array(data)).toString('base64url');

/** Fournisseur imité : paire de clés RSA, jetons signés RS256 et clés publiques (JWKS). */
async function fakeProvider(kid = 'cle-1') {
  const { privateKey, publicKey } = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await subtle.exportKey('jwk', publicKey)), kid, use: 'sig' };
  return {
    jwks: { keys: [jwk] },
    async sign(claims, header = {}) {
      const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header }));
      const body = b64url(JSON.stringify(claims));
      const signature = await subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
      return `${head}.${body}.${b64url(signature)}`;
    },
  };
}

const googleClaims = (extra = {}) => ({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT, sub: '10769150350006150715113082367', email: 'Camille.Martin@gmail.com', email_verified: true, name: 'Camille Martin', nonce: 'n-0S6_WzA2Mj', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, ...extra });

async function registryWith(name = 'Camille') {
  let t = NOW;
  const registry = await new AccountRegistry({ store: new Namespace(new MemoryBackend(), 'accounts'), now: () => t++ }).load();
  const owner = registry.create({ name, owner: true });
  return { registry, owner };
}

test('compte en ligne : fournisseurs et adresses', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['google', 'microsoft', 'apple', 'yahoo', 'other']);
  assert.equal(providerFor('a@gmail.com'), 'google');
  assert.equal(providerFor('a@Hotmail.FR'), 'microsoft');
  assert.equal(providerFor('a@me.com'), 'apple');
  assert.equal(providerFor('a@ymail.com'), 'yahoo');
  assert.equal(providerFor('a@orange.fr'), 'other');
  assert.deepEqual(checkAddress('google', ' Camille@GMAIL.com '), { provider: 'google', email: 'camille@gmail.com' });
  // « Autre adresse » avec une adresse connue : le bon fournisseur est retenu.
  assert.deepEqual(checkAddress('other', 'camille@icloud.com'), { provider: 'apple', email: 'camille@icloud.com' });
  assert.throws(() => checkAddress('google', 'camille@orange.fr'), /pas une adresse Gmail \(@gmail\.com, @googlemail\.com\)/);
  assert.throws(() => checkAddress('microsoft', 'camille@gmail.com'), /Outlook.*…\)/);
  assert.throws(() => checkAddress('other', 'camille@'), /pas valide/);
  assert.equal(nameFromEmail('camille.martin@gmail.com'), 'Camille Martin');
  assert.equal(nameFromEmail('élodie_durand@free.fr'), 'Élodie Durand');
  assert.equal(nameFromEmail('cm1984@free.fr'), '');
});

test('compte en ligne : identité nettoyée, jamais « vérifiée » sans méthode', () => {
  assert.equal(normalizeIdentity(null), null);
  assert.equal(normalizeIdentity({ email: 'pas-une-adresse' }), null);
  const forged = normalizeIdentity({ provider: 'google', email: 'X@gmail.com', verified: true, method: 'magie', subject: 'abc' }, 5);
  assert.deepEqual(forged, { provider: 'google', email: 'x@gmail.com', verified: false, method: 'none', subject: null, linkedAt: 5, verifiedAt: null });
  const ok = normalizeIdentity({ provider: 'inconnu', email: 'x@me.com', verified: true, method: 'mail', linkedAt: 1, verifiedAt: 2 }, 5);
  assert.deepEqual(ok, { provider: 'apple', email: 'x@me.com', verified: true, method: 'mail', subject: null, linkedAt: 1, verifiedAt: 2 });
});

test('compte en ligne : le registre garde l\'identité nettoyée et en reprend l\'adresse', async () => {
  const { registry, owner } = await registryWith();
  registry.update(owner.id, { identity: { provider: 'google', email: 'Camille@gmail.com', verified: true, method: 'oidc', subject: '42' } });
  assert.equal(registry.get(owner.id).email, 'camille@gmail.com');
  assert.equal(registry.get(owner.id).identity.subject, '42');
  registry.update(owner.id, { identity: { email: 'invalide' } });
  assert.equal(registry.get(owner.id).identity, null);
});

test('OpenID Connect : adresse de connexion', () => {
  const url = new URL(authorizeUrl('google', { clientId: GOOGLE_CLIENT, redirectUri: 'https://exemple.github.io/os/src/auth.html', state: 'pABC', nonce: 'N1', loginHint: 'camille@gmail.com' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'id_token');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://exemple.github.io/os/src/auth.html');
  assert.equal(url.searchParams.get('nonce'), 'N1');
  assert.equal(url.searchParams.get('login_hint'), 'camille@gmail.com');
  assert.throws(() => authorizeUrl('apple', { clientId: 'x', redirectUri: 'y', state: 's', nonce: 'n' }), IdentityError);
  assert.throws(() => authorizeUrl('google', { clientId: '', redirectUri: 'y', state: 's', nonce: 'n' }), IdentityError);
});

test('OpenID Connect : signature, émetteur, destinataire, dates et nonce vérifiés', async () => {
  const google = await fakeProvider();
  const other = await fakeProvider();
  const key = async (kid) => google.jwks.keys.find((k) => k.kid === kid) ?? null;
  const verify = (token, extra = {}) => verifyIdToken(token, { provider: 'google', clientId: GOOGLE_CLIENT, nonce: 'n-0S6_WzA2Mj', key, now: NOW, subtle, ...extra });

  assert.deepEqual(await verify(await google.sign(googleClaims())), { subject: '10769150350006150715113082367', email: 'camille.martin@gmail.com', name: 'Camille Martin' });
  await assert.rejects(verify(await other.sign(googleClaims())), /Signature du jeton invalide/);
  const [head, , sig] = (await google.sign(googleClaims())).split('.');
  await assert.rejects(verify(`${head}.${b64url(JSON.stringify(googleClaims({ email: 'pirate@gmail.com' })))}.${sig}`), /Signature du jeton invalide/);
  await assert.rejects(verify(await google.sign(googleClaims(), { alg: 'none' })), /non prise en charge/);
  await assert.rejects(verify(await google.sign(googleClaims(), { kid: 'inconnue' })), /Clé de signature/);
  await assert.rejects(verify(await google.sign(googleClaims({ iss: 'https://pirate.exemple' }))), /autre fournisseur/);
  await assert.rejects(verify(await google.sign(googleClaims({ aud: 'autre-app' }))), /autre application/);
  await assert.rejects(verify(await google.sign(googleClaims({ exp: NOW / 1000 - 3600 }))), /expiré/);
  await assert.rejects(verify(await google.sign(googleClaims({ iat: NOW / 1000 + 3600 }))), /expiré/);
  await assert.rejects(verify(await google.sign(googleClaims({ nonce: 'autre' }))), /rejoué/);
  await assert.rejects(verify(await google.sign(googleClaims()), { nonce: '' }), /rejoué/);
  await assert.rejects(verify(await google.sign(googleClaims({ email_verified: false }))), /pas confirmé/);
  await assert.rejects(verify('pas.un.jeton'), /illisible/);
  await assert.rejects(verify('a.b'), /illisible/);

  // Microsoft (point d'accès « common ») : l'émetteur est celui de l'annuaire du compte.
  const ms = { iss: `https://login.microsoftonline.com/${CONSUMERS}/v2.0`, tid: CONSUMERS, aud: MS_CLIENT, sub: 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ', preferred_username: 'camille@outlook.fr', name: 'Camille', nonce: 'n1', iat: NOW / 1000, exp: NOW / 1000 + 3600 };
  const signed = async (claims) => verifyIdToken(await google.sign(claims), { provider: 'microsoft', clientId: MS_CLIENT, nonce: 'n1', key, now: NOW, subtle });
  assert.equal((await signed(ms)).email, 'camille@outlook.fr');
  await assert.rejects(signed({ ...ms, tid: '00000000-0000-0000-0000-000000000000' }), /autre fournisseur/);
  await assert.rejects(signed({ ...ms, iss: 'https://login.microsoftonline.com/common/v2.0' }), /autre fournisseur/);
});

test('service : profil sans compte en ligne, adresse non vérifiée', async () => {
  const { registry, owner } = await registryWith();
  const events = [];
  const identity = new IdentityService({ accounts: registry, account: () => owner.id, events: { emit: (type, e) => events.push([type, e]) }, now: () => NOW });
  assert.equal(identity.required, true);
  assert.deepEqual(identity.methods('google'), { oidc: false, mail: false });
  assert.throws(() => identity.linkUnverified({ provider: 'google', email: 'camille@orange.fr' }), /pas une adresse Gmail/);
  assert.equal(identity.required, true);
  const linked = identity.linkUnverified({ provider: 'other', email: 'camille@orange.fr' });
  assert.deepEqual(linked, { provider: 'other', email: 'camille@orange.fr', verified: false, method: 'none', subject: null, linkedAt: NOW, verifiedAt: null });
  assert.equal(identity.required, false);
  assert.equal(registry.get(owner.id).email, 'camille@orange.fr');
  assert.deepEqual(events, [['account:identity', { provider: 'other', verified: false }]]);
  await assert.rejects(identity.verifyWithMail({ provider: 'other', email: 'camille@orange.fr', password: 'x' }), /Orion installé/);
  // Sans registre des comptes (stockage indisponible) : rien n'est exigé.
  assert.equal(new IdentityService({ accounts: null }).required, false);
});

test('service : vérification par la connexion à la messagerie (orion-server)', async () => {
  const fake = fakeBridge();
  const bridge = await new HardwareBridge({ env: fake.env() }).detect();
  const { registry, owner } = await registryWith();
  const mail = new MailService({ bridge, account: () => owner.id });
  const identity = new IdentityService({ accounts: registry, account: () => owner.id, mail, now: () => NOW });
  assert.deepEqual(identity.methods('apple'), { oidc: false, mail: true });

  // Mot de passe refusé : rien n'est associé.
  await assert.rejects(identity.verifyWithMail({ provider: 'other', email: 'camille@free.fr', password: 'faux' }), /refusée/);
  assert.equal(identity.required, true);
  assert.equal(fake.state.mail.accounts.length, 0);
  await assert.rejects(identity.verifyWithMail({ provider: 'other', email: 'camille@free.fr', password: '' }), /mot de passe/);

  // Vérifié et ajouté à la messagerie.
  const verified = await identity.verifyWithMail({ provider: 'other', email: 'Camille@free.fr', password: 'secret', name: 'Camille' });
  assert.equal(verified.verified, true);
  assert.equal(verified.method, 'mail');
  assert.deepEqual(fake.state.mail.accounts.map((a) => [a.address, a.owner]), [['camille@free.fr', owner.id]]);

  // Compte de messagerie déjà là : vérification seule, pas de doublon.
  await identity.verifyWithMail({ provider: 'other', email: 'camille@free.fr', password: 'secret' });
  assert.equal(fake.state.mail.accounts.length, 1);
  assert.deepEqual(fake.state.mail.verified, ['camille@free.fr']);

  // Sans relever les e-mails : vérification seule, le mot de passe n'est pas gardé.
  await identity.verifyWithMail({ provider: 'apple', email: 'camille@icloud.com', password: 'app-pass', addMailbox: false });
  assert.equal(fake.state.mail.accounts.length, 1);
  assert.equal(registry.get(owner.id).identity.provider, 'apple');
});

test('service : « Continuer avec Google » vérifie le jeton avec les clés publiées', async () => {
  const google = await fakeProvider('k1');
  const { registry, owner } = await registryWith();
  const fetches = [];
  const fetch = async (url) => {
    fetches.push(url);
    return { ok: true, status: 200, json: async () => google.jwks };
  };
  const identity = new IdentityService({ accounts: registry, account: () => owner.id, clients: { google: GOOGLE_CLIENT, microsoft: '' }, fetch, subtle, now: () => NOW });
  assert.deepEqual(identity.methods('google'), { oidc: true, mail: false });
  assert.equal(identity.methods('microsoft').oidc, false);
  assert.throws(() => identity.beginOidc('microsoft', { redirectUri: 'https://x/src/auth.html' }), IdentityError);
  const { url, state, nonce } = identity.beginOidc('google', { redirectUri: 'https://x/src/auth.html', state: 'p123' });
  assert.equal(state, 'p123');
  assert.equal(new URL(url).searchParams.get('nonce'), nonce);
  assert.ok(nonce.length >= 20);

  const token = await google.sign(googleClaims({ nonce }));
  const { identity: linked, name } = await identity.completeOidc('google', { idToken: token, nonce });
  assert.equal(name, 'Camille Martin');
  assert.deepEqual([linked.email, linked.verified, linked.method, linked.subject], ['camille.martin@gmail.com', true, 'oidc', '10769150350006150715113082367']);
  assert.deepEqual(fetches, ['https://www.googleapis.com/oauth2/v3/certs']);
  // Clés gardées en mémoire ; un jeton rejoué avec un autre nonce est refusé.
  await assert.rejects(identity.completeOidc('google', { idToken: token, nonce: 'autre' }), /rejoué/);
  assert.equal(fetches.length, 1);
  // Clé inconnue : les clés sont relues une fois (renouvellement chez le fournisseur).
  const rotated = await fakeProvider('k2');
  await assert.rejects(identity.completeOidc('google', { idToken: await rotated.sign(googleClaims({ nonce })), nonce }), /Clé de signature/);
  assert.equal(fetches.length, 2);
});

test('noyau : le service d\'identité suit le compte de la session', async () => {
  const { registry, owner } = await registryWith('');
  const kernel = await bootKernel({ accounts: registry, accountId: owner.id });
  assert.equal(kernel.identity.required, true);
  kernel.identity.linkUnverified({ provider: 'yahoo', email: 'camille@yahoo.fr' });
  assert.equal(kernel.account.identity.provider, 'yahoo');
  assert.equal(kernel.identity.required, false);
  kernel.shutdown();
});
