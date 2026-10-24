import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootKernel } from '../src/kernel/kernel.js';
import { HardwareBridge } from '../src/kernel/bridge.js';
import { NetService, NetError, blockedHost, checkUrl, MAX_RESPONSE } from '../src/kernel/net.js';
import { PERMISSIONS } from '../src/kernel/permissions.js';
import { STORE_PERMISSIONS } from '../src/kernel/store.js';
import { scanApp } from '../src/kernel/app-scan.js';
import { fakeBridge, settle } from './fake-bridge.js';

/** fetch imité : `routes[url]` → { status, headers, body, url } ou fonction (url, init). */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError('Failed to fetch');
    const r = typeof route === 'function' ? await route(url, init) : route;
    const headers = new Headers(r.headers ?? {});
    const body = r.body instanceof Uint8Array ? r.body : new TextEncoder().encode(r.body ?? '');
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, url: r.url ?? url, headers, body: new Response(body).body, arrayBuffer: async () => body.buffer };
  };
  return { fetch, calls };
}

test('Internet : adresses du réseau local, de l\'appareil et d\'Orion refusées', () => {
  for (const host of ['localhost', 'box.lan', 'imprimante.local', 'nas.home.arpa', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1', '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:7f00:1]']) assert.ok(blockedHost(host), host);
  for (const host of ['mastodon.social', '8.8.8.8', '172.32.0.1', '[2001:4860:4860::8888]']) assert.ok(!blockedHost(host), host);
  // Formes détournées d'une adresse locale : normalisées par URL, puis refusées.
  for (const url of ['http://0x7f.1/', 'http://2130706433/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'ftp://exemple.fr/', 'http://a:b@exemple.fr/', 'javascript:alert(1)', 'pas une adresse']) assert.throws(() => checkUrl(url), NetError, url);
  assert.throws(() => checkUrl('https://orion.exemple/os/src/kernel/net.js', { self: 'https://orion.exemple' }), /fichiers d'Orion/);
  assert.equal(checkUrl('https://mastodon.social/api/v1/instance').hostname, 'mastodon.social');
});

test('Internet (navigateur) : requête sans cookies, en-têtes filtrés, JSON, base64', async () => {
  const { fetch, calls } = fakeFetch({
    'https://api.exemple.fr/v1/data': { body: '{"ok":true}', headers: { 'content-type': 'application/json', link: '<https://api.exemple.fr/v1/data?page=2>; rel="next"', 'set-cookie': 'piste=1' } },
    'https://api.exemple.fr/image': { body: new Uint8Array([0, 255, 128]), headers: { 'content-type': 'image/png' } },
    'https://api.exemple.fr/post': (url, init) => ({ status: 201, body: JSON.stringify({ body: new TextDecoder().decode(init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(init.body)) }) }),
  });
  const net = new NetService({ env: { fetch, location: { origin: 'https://orion.exemple' } } });
  const r = await net.request('https://api.exemple.fr/v1/data', { headers: { Authorization: 'Bearer x', Cookie: 'vol=1', 'X-Orion': '1', 'Bad Header': 'x', Accept: 'a\r\nInjecté: 1' }, responseType: 'json' });
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.link, /rel="next"/);
  assert.equal(r.headers['set-cookie'], undefined);
  const init = calls[0].init;
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.deepEqual(init.headers, { Authorization: 'Bearer x', Accept: 'aInjecté: 1' });
  assert.equal((await net.request('https://api.exemple.fr/image', { responseType: 'base64' })).body, btoa(String.fromCharCode(0, 255, 128)));
  const posted = await net.request('https://api.exemple.fr/post', { method: 'post', body: btoa(String.fromCharCode(0xc3, 0xa9)), bodyEncoding: 'base64', responseType: 'json' });
  assert.deepEqual([posted.status, posted.body], [201, { body: 'é' }]);
  await assert.rejects(net.request('https://api.exemple.fr/post', { method: 'POST', body: '***', bodyEncoding: 'base64' }), /base64/);
  // GET : pas de corps envoyé.
  await net.request('https://api.exemple.fr/v1/data', { body: 'ignoré' });
  assert.equal(calls.at(-1).init.body, undefined);
});

test('Internet (navigateur) : CORS, hors ligne, redirection locale, taille et méthode refusées', async () => {
  const { fetch } = fakeFetch({
    'https://sans-cors.exemple/': () => {
      throw new TypeError('Failed to fetch');
    },
    'https://redirige.exemple/': { url: 'http://192.168.1.1/admin', body: 'secret' },
    'https://lourd.exemple/': { body: 'x', headers: { 'content-length': String(MAX_RESPONSE + 1) } },
  });
  const net = new NetService({ env: { fetch, navigator: { onLine: true } } });
  await assert.rejects(net.request('https://sans-cors.exemple/'), /CORS/);
  await assert.rejects(net.request('https://redirige.exemple/'), /réseau local/);
  await assert.rejects(net.request('https://lourd.exemple/'), /volumineuse/);
  await assert.rejects(net.request('https://api.exemple.fr/', { method: 'CONNECT' }), /Méthode/);
  await assert.rejects(net.request('https://api.exemple.fr/', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }), /volumineuse/);
  await assert.rejects(net.request('http://localhost:8080/api/mail'), /réseau local/);
  const offline = new NetService({ env: { fetch: async () => { throw new TypeError('offline'); }, navigator: { onLine: false } } });
  await assert.rejects(offline.request('https://api.exemple.fr/'), /Pas de connexion/);
});

test('Internet (Orion installé) : orion-server fait la requête', async () => {
  const fake = fakeBridge();
  fake.state.web = (req) => (req.url === 'https://api.exemple.fr/v1/data' ? { status: 200, body: '{"via":"orion-server"}' } : { status: 404, body: '' });
  const bridge = await new HardwareBridge({ env: fake.env() }).detect();
  const net = new NetService({ bridge, env: fake.env() });
  assert.equal(net.proxied, true);
  const r = await net.request('https://api.exemple.fr/v1/data', { headers: { Authorization: 'Bearer x', Cookie: 'non' }, responseType: 'json' });
  assert.deepEqual(r.body, { via: 'orion-server' });
  assert.deepEqual(fake.state.netRequests[0], { url: 'https://api.exemple.fr/v1/data', method: 'GET', headers: { Authorization: 'Bearer x' }, body: null, bodyEncoding: 'text', responseType: 'text' });
  // Vérification faite avant même de solliciter orion-server.
  await assert.rejects(net.request('http://10.0.0.1/'), /réseau local/);
  assert.equal(fake.state.netRequests.length, 1);
  fake.state.web = () => ({ status: 403, error: 'Le réseau local et l\'appareil lui-même sont inaccessibles aux apps' });
  await assert.rejects(net.request('https://rebind.exemple/'), /réseau local/);
});

test('Internet : autorisation « Internet » des apps du Store, examen du code', async () => {
  assert.equal(PERMISSIONS.internet.label, 'Internet');
  assert.ok(STORE_PERMISSIONS.includes('internet'));
  const kernel = await bootKernel({ manifests: [{ id: 'social', name: 'Social', permissions: ['internet'] }], env: {} });
  await settle();
  assert.ok(kernel.net instanceof NetService);
  assert.equal(kernel.permissions.check('social', 'internet'), 'prompt');
  assert.equal(kernel.permissions.check('autre', 'internet'), 'denied');
  kernel.shutdown();
  // orion.net passe l'examen ; un accès direct au réseau est signalé.
  assert.deepEqual(scanApp('<script>orion.net.request("https://api.exemple.fr/")</script>'), { level: 'safe', findings: [] });
  assert.match(scanApp('<script>fetch("https://api.exemple.fr/")</script>').findings[0].message, /orion\.net/);
});
