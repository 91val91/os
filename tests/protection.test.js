import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, Namespace } from '../src/kernel/storage.js';
import { ProtectionService, WIPE_AFTER, SECURITY_DELAY } from '../src/kernel/protection.js';
import { HardwareBridge } from '../src/kernel/bridge.js';
import { createPasscode } from '../src/kernel/settings.js';
import { bootKernel } from '../src/kernel/kernel.js';
import { fakeClock } from './helpers.js';
import { fakeBridge } from './fake-bridge.js';

async function service({ backend = new MemoryBackend(), now = fakeClock(), owner = true, bridge = null, account = 'owner' } = {}) {
  return new ProtectionService({ store: new Namespace(backend, 'protection'), now, account: () => account, isOwner: () => owner, bridge }).load();
}

test('échecs du code : attentes croissantes, conservées après un redémarrage', async () => {
  const backend = new MemoryBackend();
  const now = fakeClock();
  const p = await service({ backend, now });
  for (let i = 1; i <= 4; i++) assert.equal(p.recordFailure().wait, 0);
  assert.deepEqual(p.recordFailure(), { failures: 5, wait: 60, left: null, wipe: false });
  // Recharger la page ne remet pas le compteur à zéro.
  const again = await service({ backend, now });
  assert.equal(again.lockout().wait, 60);
  now.advance(61_000);
  assert.equal(again.lockout().wait, 0);
  assert.equal(again.recordFailure().wait, 300);
  again.recordSuccess();
  assert.equal(again.lockout().failures, 0);
});

test('effacement après 10 tentatives, seulement si le propriétaire l\'a activé', async () => {
  const p = await service();
  for (let i = 1; i < WIPE_AFTER; i++) p.recordFailure();
  assert.equal(p.recordFailure().wipe, false, 'désactivé par défaut : seulement des attentes');
  const q = await service();
  q.setOption('wipe', true);
  let last;
  for (let i = 1; i <= WIPE_AFTER; i++) last = q.recordFailure();
  assert.equal(last.wipe, true);
  assert.equal(last.left, 0);
  // Les options de l'appareil sont réservées au propriétaire.
  const guest = await service({ owner: false });
  assert.throws(() => guest.setOption('wipe', true), /propriétaire/);
});

test('protection contre la réinitialisation : gardée après l\'effacement, levée par le code', async () => {
  const backend = new MemoryBackend();
  const now = fakeClock();
  const p = await service({ backend, now });
  const record = await createPasscode('2468');
  await p.enableFrp({ record, owner: { name: 'Camille', email: 'camille@example.com' } });
  p.resetAfterWipe();
  const after = await service({ backend, now });
  assert.equal(after.frp.enabled, true);
  assert.equal(after.frp.owner.name, 'Camille');
  for (let i = 0; i < 4; i++) assert.equal((await after.verifyFrp('0000')).ok, false);
  assert.deepEqual(await after.verifyFrp('0000'), { ok: false, wait: 30 });
  assert.deepEqual(await after.verifyFrp('2468'), { ok: false, wait: 30 }, 'même le bon code attend');
  now.advance(31_000);
  assert.equal((await after.disableFrp('2468')).ok, true);
  assert.equal(after.frp.enabled, false);
});

test('protection contre la réinitialisation gardée par orion-server', async () => {
  const fake = fakeBridge({ capabilities: { protection: true } });
  const bridge = await new HardwareBridge({ env: fake.env() }).detect();
  const backend = new MemoryBackend();
  const p = await service({ backend, bridge });
  const record = await createPasscode('1357');
  await p.enableFrp({ record, owner: { name: 'Camille' } });
  assert.equal(fake.state.protection.record.hash, record.hash);
  // Données du navigateur effacées : le serveur se souvient encore.
  const fresh = await service({ bridge });
  assert.deepEqual([fresh.frp.enabled, fresh.frp.remote], [true, true]);
  assert.equal((await fresh.verifyFrp('0000')).ok, false);
  // Nouveau code du propriétaire : le serveur exige l'ancien.
  const next = await createPasscode('8642');
  await assert.rejects(fresh.updateFrpRecord(next, '0000'), /incorrect/);
  await p.updateFrpRecord(next, '1357');
  assert.equal((await fresh.disableFrp('8642')).ok, true);
  assert.deepEqual(fake.state.protection, {});
});

test('délai de sécurité des réglages sensibles', async () => {
  const now = fakeClock();
  const p = await service({ now });
  assert.equal(p.requestSensitive('erase').allowed, true, 'sans l\'option : immédiat');
  p.setOption('sensitive', true);
  const first = p.requestSensitive('erase');
  assert.deepEqual([first.allowed, first.started], [false, true]);
  now.advance(10 * 60_000);
  assert.equal(p.requestSensitive('erase').allowed, false);
  assert.equal(p.pendingDelays().length, 1);
  now.advance(SECURITY_DELAY);
  assert.equal(p.requestSensitive('erase').allowed, true);
  assert.equal(p.requestSensitive('erase').started, true, 'utilisé : un nouveau délai recommence');
});

test('le noyau garde la protection dans sa propre base, que l\'effacement ne touche pas', async () => {
  const backend = new MemoryBackend();
  const protectionBackend = new MemoryBackend();
  const kernel = await bootKernel({ backend, protectionBackend, env: {} });
  await kernel.protection.enableFrp({ record: await createPasscode('1234'), owner: { name: 'Camille' } });
  await kernel.factoryReset();
  const fresh = await bootKernel({ backend, protectionBackend, env: {} });
  assert.equal(fresh.firstBoot, true);
  assert.equal(fresh.protection.frp.enabled, true);
  fresh.shutdown();
});

test('intégrité : les fichiers gardés sur l\'appareil comparés à la version publiée', async () => {
  const { checkIntegrity } = await import('../src/system/integrity.js');
  const hash = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const base = 'https://exemple.test/os/';
  const files = { './index.html': '<!doctype html>', './src/main.js': 'export {};' };
  const manifest = { version: '0.1', files: {} };
  for (const [path, text] of Object.entries(files)) manifest.files[path] = { hash: await hash(text), size: text.length };
  const stores = new Map([['orion-os-meta', new Map([['state', JSON.stringify({ current: manifest })]])], ['orion-os-release-0.1', new Map(Object.entries(files).map(([p, t]) => [new URL(p, base).href, t]))]]);
  const caches = {
    has: async (name) => stores.has(name),
    open: async (name) => ({ match: async (key) => (stores.get(name).has(key) ? new Response(stores.get(name).get(key)) : undefined) }),
  };
  const env = { caches, crypto: globalThis.crypto, location: { href: `${base}?fullscreen` } };
  assert.deepEqual(await checkIntegrity({ env }), { status: 'ok', version: '0.1', checked: 2, altered: [], missing: [], source: 'appareil' });
  stores.get('orion-os-release-0.1').set(new URL('./src/main.js', base).href, 'export const piège = 1;');
  stores.get('orion-os-release-0.1').delete(new URL('./index.html', base).href);
  const result = await checkIntegrity({ env });
  assert.deepEqual([result.status, result.altered, result.missing], ['altered', ['./src/main.js'], ['./index.html']]);
  assert.equal((await checkIntegrity({ env: {} })).status, 'unavailable');
});
