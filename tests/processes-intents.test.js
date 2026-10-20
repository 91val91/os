import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager } from '../src/kernel/processes.js';
import { PackageManager } from '../src/kernel/packages.js';
import { ActivityManager, matchIntent, matchType } from '../src/kernel/intents.js';
import { EventBus } from '../src/kernel/events.js';
import { memoryStore, recorder } from './helpers.js';

test('cycle de vie des processus et ordre des récents', () => {
  const { events, of } = recorder();
  const pm = new ProcessManager({ events });
  const a = pm.spawn('notes');
  pm.setForeground(a.pid);
  const b = pm.spawn('music');
  pm.setForeground(b.pid);
  assert.equal(pm.foreground().appId, 'music');
  assert.equal(pm.get(a.pid).state, 'background');
  assert.deepEqual(pm.list().map((p) => p.appId), ['music', 'notes']);
  assert.throws(() => pm.spawn('notes'), /déjà actif/);
  pm.setForeground(a.pid);
  assert.deepEqual(pm.list().map((p) => p.appId), ['notes', 'music']);
  assert.equal(pm.kill(b.pid), true);
  assert.equal(pm.getByApp('music'), null);
  assert.deepEqual(of('process:exit').map((e) => e.appId), ['music']);
});

test('le « low memory killer » arrête les apps les plus anciennes', () => {
  const pm = new ProcessManager({ maxBackground: 2 });
  for (const id of ['a', 'b', 'c', 'd']) pm.setForeground(pm.spawn(id).pid);
  // d au premier plan, c et b en arrière-plan, a tué.
  assert.deepEqual(pm.list().map((p) => p.appId), ['d', 'c', 'b']);
});

test('correspondance des types MIME et des filtres d\'intents', () => {
  assert.equal(matchType('image/*', 'image/png'), true);
  assert.equal(matchType('image/*', 'audio/mp3'), false);
  assert.equal(matchType('*/*', 'x/y'), true);
  assert.equal(matchIntent({ action: 'view', types: ['text/*'] }, { action: 'view', type: 'text/plain' }), true);
  assert.equal(matchIntent({ action: 'view', types: ['text/*'] }, { action: 'send', type: 'text/plain' }), false);
  assert.equal(matchIntent({ action: 'dial' }, { action: 'dial', data: { number: '1' } }), true);
  assert.equal(matchIntent({ action: 'dial' }, { action: 'dial', type: 'text/plain' }), false);
});

async function setup() {
  const events = new EventBus();
  const packages = new PackageManager({ store: memoryStore('pkg'), events });
  packages.register({ id: 'notes', name: 'Notes', preinstalled: true, intents: [{ action: 'view', types: ['text/*'] }, { action: 'send', types: ['text/plain'] }] });
  packages.register({ id: 'messages', name: 'Messages', system: true, intents: [{ action: 'send', types: ['text/plain'] }] });
  packages.register({ id: 'photos', name: 'Photos', system: true, intents: [{ action: 'pick', types: ['image/*'] }] });
  packages.register({ id: 'snake', name: 'Snake' });
  await packages.load();
  const processes = new ProcessManager({ events });
  const am = new ActivityManager({ packages, processes, events });
  return { events, packages, processes, am };
}

test('gestionnaire de paquets : installation, désinstallation, apps système protégées', async () => {
  const { packages, events } = await setup();
  const removed = [];
  events.on('package:uninstall', ({ id }) => removed.push(id));
  assert.equal(packages.isInstalled('notes'), true);
  assert.equal(packages.isInstalled('snake'), false);
  await packages.install('snake');
  assert.equal(packages.isInstalled('snake'), true);
  await packages.uninstall('snake');
  assert.deepEqual(removed, ['snake']);
  await assert.rejects(() => packages.uninstall('messages'), /système/);
  await assert.rejects(() => packages.install('inconnu'), /introuvable/);
});

test('intents implicites, sélecteur et intents explicites', async () => {
  const { am, processes } = await setup();
  assert.deepEqual(am.resolve({ action: 'send', type: 'text/plain' }).map((p) => p.id).sort(), ['messages', 'notes']);
  // Sans hôte graphique, le premier candidat est lancé.
  const pid = await am.start({ action: 'view', type: 'text/plain', data: { path: '/a.txt' } });
  assert.equal(processes.get(pid).appId, 'notes');
  // Avec un hôte, le sélecteur choisit.
  am.host = { choose: async (candidates) => candidates.find((p) => p.id === 'messages').id, launch: async (appId, intent) => processes.spawn(appId, { intent }).pid };
  const pid2 = await am.start({ action: 'send', type: 'text/plain' });
  assert.equal(processes.get(pid2).appId, 'messages');
  await assert.rejects(() => am.start({ action: 'view', type: 'video/mp4' }), /Aucune application/);
  await assert.rejects(() => am.start({ app: 'snake' }), /non installée/);
});

test('startActivityForResult : le résultat revient à l\'appelant', async () => {
  const { am, processes } = await setup();
  const caller = processes.spawn('notes');
  processes.setForeground(caller.pid);
  const pending = am.start({ action: 'pick', type: 'image/*' }, { callerPid: caller.pid, forResult: true });
  await new Promise((r) => setTimeout(r, 0));
  const picker = processes.getByApp('photos');
  assert.ok(am.isWaitingForResult(picker.pid));
  am.finish(picker.pid, { path: '/home/Photos/a.jpg' });
  assert.deepEqual(await pending, { path: '/home/Photos/a.jpg' });
  assert.equal(processes.getByApp('photos'), null);
  assert.equal(processes.foreground().pid, caller.pid);
});

test('un processus tué sans résultat renvoie null', async () => {
  const { am, processes } = await setup();
  const pending = am.start({ action: 'pick', type: 'image/*' }, { forResult: true });
  await new Promise((r) => setTimeout(r, 0));
  processes.killApp('photos');
  assert.equal(await pending, null);
});
