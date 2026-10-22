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

/** Faux service worker (contrôleur de la page) : version installée, version prête, messages. */
function fakeWorker({ staged = null } = {}) {
  const listeners = new Set();
  const worker = {
    staged,
    received: [],
    broadcast: (data) => listeners.forEach((fn) => fn({ data })),
    postMessage(message, [port]) {
      worker.received.push(message.type);
      const reply = (data) => queueMicrotask(() => port.postMessage(data));
      if (message.type === 'status') reply({ current: { version: RELEASE.version }, staged: worker.staged });
      else if (message.type === 'estimate') reply({ size: 10 });
      else if (message.type === 'discard') {
        if (worker.staged?.version !== message.keep) worker.staged = null;
        reply({ ok: true });
      } else if (message.type === 'download') worker.pendingDownload = reply; // réponse contrôlée par le test
    },
  };
  class Channel {
    constructor() {
      this.port1 = {};
      this.port2 = { postMessage: (data) => this.port1.onmessage?.({ data }) };
    }
  }
  const env = (published) => ({
    MessageChannel: Channel,
    fetch: async () => (published ? { ok: true, json: async () => published } : Promise.reject(new Error('hors ligne'))),
    navigator: { onLine: Boolean(published), serviceWorker: { controller: worker, addEventListener: (type, fn) => listeners.add(fn) } },
  });
  return { worker, env };
}

async function managed(published, worker, env, extra = {}) {
  const kernel = await bootKernel({ env: {} });
  const ui = { kernel, state: 'home', poweredOff: false, alarmScreen: { isVisible: false }, power: { restart: async () => {} }, ...extra };
  const updates = new UpdateManager(ui, { env: env(published) });
  return { kernel, ui, updates };
}

test('mises à jour : une version retirée par l\'éditeur n\'est jamais installée', async () => {
  const { worker, env } = fakeWorker({ staged: { version: '99.0.0' } });
  const { kernel, updates } = await managed({ version: RELEASE.version }, worker, env);
  await updates.check();
  assert.equal(updates.status, 'uptodate');
  assert.ok(worker.received.includes('discard'));
  assert.equal(worker.staged, null);
  kernel.shutdown();
});

test('mises à jour : une version prête reste installable hors ligne', async () => {
  const { worker, env } = fakeWorker({ staged: { version: '99.0.0' } });
  const { kernel, updates } = await managed(null, worker, env);
  updates.status = 'ready';
  updates.available = { version: '99.0.0' };
  await updates.check();
  assert.equal(updates.status, 'ready');
  assert.match(updates.checkError, /connexion/);
  assert.equal(worker.staged.version, '99.0.0');
  kernel.shutdown();
});

test('mises à jour : un téléchargement suivi depuis une autre fenêtre se termine bien', async () => {
  const { worker, env } = fakeWorker();
  const { kernel, updates } = await managed({ version: '99.0.0' }, worker, env);
  updates.start();
  worker.broadcast({ type: 'update-progress', version: '99.0.0', done: 5, total: 10, downloaded: 100 });
  assert.equal(updates.status, 'downloading');
  worker.staged = { version: '99.0.0', notes: [] };
  worker.broadcast({ type: 'update-ready', version: '99.0.0' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(updates.status, 'ready');
  // Échec signalé par le service worker : l'erreur s'affiche au lieu d'un téléchargement sans fin.
  updates.status = 'downloading';
  worker.staged = null;
  worker.broadcast({ type: 'update-failed', error: 'Un fichier reçu ne correspond pas' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(updates.status, 'error');
  assert.match(updates.error, /ne correspond pas/);
  updates.stop();
  kernel.shutdown();
});

test('mises à jour : l\'installation automatique attend un appareil vraiment au repos', async () => {
  const { worker, env } = fakeWorker({ staged: { version: '99.0.0' } });
  const installs = [];
  const { kernel, ui, updates } = await managed({ version: '99.0.0' }, worker, env, { state: 'locked' });
  kernel.settings.set('updates.autoInstall', true);
  updates.install = async () => installs.push(Date.now());
  updates.status = 'ready';
  updates.start();
  const lock = () => kernel.events.emit('device:lock', {});
  // Musique en cours sous l'écran verrouillé : pas de redémarrage.
  kernel.media.set('music', { title: 'Titre', playing: true }, {});
  lock();
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(installs.length, 0);
  kernel.media.clear('music');
  // Déverrouillé aussitôt : pas de redémarrage pendant l'utilisation.
  lock();
  ui.state = 'home';
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(installs.length, 0);
  ui.state = 'locked';
  lock();
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(installs.length, 1);
  updates.stop();
  kernel.shutdown();
});
