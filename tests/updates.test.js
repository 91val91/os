import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootKernel } from '../src/kernel/kernel.js';
import { RELEASE } from '../src/kernel/version.js';
import { UpdateManager, compareVersions } from '../src/system/updates.js';

test('comparaison de versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1', '1.1.0'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
});

/** Système minimal : noyau réel, réseau simulé (version.json), sans service worker. */
async function system(published) {
  const kernel = await bootKernel({ env: {} });
  const restarts = [];
  const ui = { kernel, power: { restart: async (message) => restarts.push(message) } };
  const env = { fetch: async () => (published ? { ok: true, json: async () => published } : Promise.reject(new Error('hors ligne'))), navigator: { onLine: Boolean(published) } };
  return { kernel, updates: new UpdateManager(ui, { env }), restarts };
}

test('mises à jour : rien à installer quand la version publiée est la même', async () => {
  const { kernel, updates } = await system({ version: RELEASE.version });
  await updates.check();
  assert.equal(updates.status, 'uptodate');
  assert.ok(kernel.settings.get('updates.lastCheck') > 0);
  assert.equal(kernel.notifications.list({ appId: 'settings' }).length, 0);
  kernel.shutdown();
});

test('mises à jour : nouvelle version annoncée, téléchargée puis installée', async () => {
  const next = { version: '99.0.0', build: 'OR9', date: '2027-01-01', notes: ['Nouveautés'], size: 1234 };
  const { kernel, updates, restarts } = await system(next);
  const statuses = [];
  kernel.events.on('update:change', ({ status }) => statuses.push(status));
  await updates.check();
  assert.equal(updates.status, 'available');
  assert.equal(updates.available.version, '99.0.0');
  const [notification] = kernel.notifications.list({ appId: 'settings' });
  assert.match(notification.title, /Mise à jour disponible/);
  assert.deepEqual(notification.intent.data, { page: 'updates' });

  // Sans service worker, rien à télécharger : la mise à jour s'installe en rechargeant.
  await updates.download();
  assert.equal(updates.status, 'ready');
  await updates.install();
  assert.deepEqual(restarts, ['Installation d\'Orion OS 99.0.0…']);
  assert.deepEqual(statuses, ['checking', 'available', 'ready', 'installing']);
  kernel.shutdown();
});

test('mises à jour : erreur claire hors ligne', async () => {
  const { kernel, updates } = await system(null);
  await updates.check();
  assert.equal(updates.status, 'error');
  assert.match(updates.error, /connexion/);
  kernel.shutdown();
});
