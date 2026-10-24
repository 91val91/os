import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootKernel } from '../src/kernel/kernel.js';
import { MemoryBackend } from '../src/kernel/storage.js';
import { replyTo } from '../src/kernel/chatbot.js';
import { phoneKey, CONTACTS_FILE } from '../src/kernel/contacts.js';
import { CALLS_FILE, SMS_FILE } from '../src/kernel/telephony.js';
import { fakeClock, fakeTimers } from './helpers.js';

const MANIFESTS = [
  { id: 'phone', name: 'Téléphone', system: true },
  { id: 'messages', name: 'Messages', system: true },
  { id: 'snake', name: 'Snake' },
];

async function boot(backend = new MemoryBackend()) {
  const now = fakeClock();
  const timers = fakeTimers(now);
  const kernel = await bootKernel({ backend, manifests: MANIFESTS, env: {}, now, timers });
  return { kernel, now, timers, backend };
}

test('premier démarrage : arborescence, sans contacts ni conversations fictifs', async () => {
  const { kernel } = await boot();
  assert.equal(kernel.firstBoot, true);
  for (const dir of ['/home/Documents', '/home/Photos', '/system/bin', '/data']) assert.ok(kernel.fs.isDir(dir), dir);
  assert.ok(kernel.fs.exists('/system/bin/ls'));
  assert.equal(kernel.contacts.list().length, 0);
  assert.equal(kernel.telephony.threads().length, 0);
  assert.equal(kernel.telephony.callLog().length, 0);
  assert.equal(kernel.packages.isInstalled('snake'), false);
});

test('mise à jour : les données de démonstration des anciennes versions sont retirées', async () => {
  const backend = new MemoryBackend();
  const first = await boot(backend);
  const { fs, settings } = first.kernel;
  // État laissé par une ancienne version : contacts, SMS et appels fictifs, plus des données de l'utilisateur.
  fs.writeJSON(CONTACTS_FILE, [
    { id: 'c1', firstName: 'Alice', lastName: 'Martin', phone: '+33 6 12 34 56 78' },
    { id: 'c8', firstName: 'Maman', phone: '+33 6 89 01 23 45' },
    { id: 'c1x9', firstName: 'Zoé', phone: '+33 6 11 11 11 11' },
  ]);
  fs.writeJSON(SMS_FILE, {
    [phoneKey('+33 6 12 34 56 78')]: { address: '+33 6 12 34 56 78', messages: [{ id: 1, from: 'them', text: 'Salut !', time: 1 }] },
    [phoneKey('+33 6 11 11 11 11')]: { address: '+33 6 11 11 11 11', messages: [{ id: 2, from: 'me', text: 'Coucou', time: 2 }] },
  });
  fs.writeJSON(CALLS_FILE, [
    { id: 3, number: '+33 6 23 45 67 89', direction: 'in', missed: true, time: 3, duration: 0 },
    { id: 4, number: '+33 6 11 11 11 11', direction: 'out', missed: false, time: 4, duration: 30 },
  ]);
  settings.reset('demoDataRemoved');
  await new Promise((r) => setTimeout(r, 0));

  const { kernel } = await boot(backend);
  assert.deepEqual(kernel.contacts.list().map((c) => c.firstName), ['Zoé']);
  assert.deepEqual(kernel.telephony.threads().map((t) => t.address), ['+33 6 11 11 11 11']);
  assert.deepEqual(kernel.telephony.callLog().map((c) => c.number), ['+33 6 11 11 11 11']);
});

test('les données persistent d\'un démarrage à l\'autre', async () => {
  const backend = new MemoryBackend();
  const first = await boot(backend);
  first.kernel.fs.writeFile('/home/Documents/test.txt', 'gardé');
  first.kernel.settings.set('userName', 'Camille');
  await first.kernel.packages.install('snake');
  await new Promise((r) => setTimeout(r, 0));
  const second = await boot(backend);
  assert.equal(second.kernel.firstBoot, false);
  assert.equal(second.kernel.fs.readFile('/home/Documents/test.txt'), 'gardé');
  assert.equal(second.kernel.settings.get('userName'), 'Camille');
  assert.equal(second.kernel.packages.isInstalled('snake'), true);
});

test('désinstaller une app supprime ses données et l\'arrête', async () => {
  const { kernel } = await boot();
  await kernel.packages.install('snake');
  kernel.processes.spawn('snake');
  kernel.fs.writeJSON('/data/snake/storage.json', { best: 42 });
  kernel.notifications.post({ appId: 'snake', title: 'Record !' });
  await kernel.packages.uninstall('snake');
  assert.equal(kernel.processes.getByApp('snake'), null);
  assert.equal(kernel.fs.exists('/data/snake'), false);
  assert.equal(kernel.notifications.list({ appId: 'snake' }).length, 0);
});

test('SMS : envoi, réponse automatique et notification', async () => {
  const { kernel, timers } = await boot();
  const tel = kernel.telephony;
  const typing = [];
  kernel.events.on('sms:typing', (e) => typing.push(e.typing));
  kernel.contacts.add({ firstName: 'Bruno', lastName: 'Lefèvre', phone: '+33 6 23 45 67 89' });
  const sent = tel.sendSms('+33 6 23 45 67 89', { text: 'Bonjour !' });
  assert.equal(sent.status, 'delivered');
  timers.advance(5000);
  assert.deepEqual(typing, [true, false]);
  const thread = tel.thread('06 23 45 67 89');
  assert.equal(thread.name, 'Bruno Lefèvre');
  assert.equal(thread.messages.at(-1).from, 'them');
  assert.equal(thread.unread, 1);
  assert.equal(kernel.notifications.list({ appId: 'messages' }).length, 1);
  tel.markRead('+33 6 23 45 67 89');
  assert.equal(tel.thread('+33623456789').unread, 0);
  assert.equal(kernel.notifications.list({ appId: 'messages' }).length, 0);
});

test('SMS : la conversation ouverte ne notifie pas', async () => {
  const { kernel, timers } = await boot();
  const tel = kernel.telephony;
  tel.setActiveThread('+33 7 34 56 78 90');
  tel.sendSms('+33 7 34 56 78 90', { text: 'Tu viens ?' });
  timers.advance(5000);
  assert.equal(kernel.notifications.list({ appId: 'messages' }).length, 0);
  assert.equal(tel.thread('+33 7 34 56 78 90').unread, 0);
});

test('mode avion : SMS en échec et appels bloqués (sauf urgence)', async () => {
  const { kernel } = await boot();
  kernel.settings.set('airplane', true);
  assert.equal(kernel.telephony.sendSms('0612345678', { text: 'test' }).status, 'failed');
  assert.throws(() => kernel.telephony.dial('0612345678'), /mode avion/);
  assert.equal(kernel.telephony.dial('112').emergency, true);
});

test('appels : sortant décroché puis raccroché, entrant manqué', async () => {
  const { kernel, timers, now } = await boot();
  const tel = kernel.telephony;
  const states = [];
  kernel.events.on('call:state', (c) => states.push(c?.state ?? null));
  kernel.contacts.add({ firstName: 'Alice', lastName: 'Martin', phone: '+33 6 12 34 56 78' });
  tel.dial('+33 6 12 34 56 78');
  timers.advance(10_000);
  assert.equal(tel.call.state, 'active');
  const connectedAt = tel.call.connectedAt;
  timers.advance(65_000);
  const hungUpAt = now();
  tel.hangup();
  assert.deepEqual(states, ['dialing', 'ringing', 'active', 'ended']);
  assert.equal(tel.callLog()[0].duration, Math.round((hungUpAt - connectedAt) / 1000));
  assert.equal(tel.callLog()[0].name, 'Alice Martin');

  tel.incoming('+33 6 56 78 90 12');
  assert.equal(tel.call.state, 'incoming');
  timers.advance(31_000);
  assert.equal(tel.call, null);
  assert.equal(tel.callLog()[0].missed, true);
  assert.equal(kernel.notifications.list({ appId: 'phone' })[0].title, 'Appel manqué');
});

test('correspondant simulé et normalisation des numéros', () => {
  assert.equal(replyTo('merci beaucoup', () => 0), 'Avec plaisir !');
  assert.equal(replyTo('On mange où ce soir ?', () => 0), 'Ça marche, je suis dispo !');
  assert.equal(phoneKey('+33 6 12 34 56 78'), phoneKey('06.12.34.56.78'));
});
