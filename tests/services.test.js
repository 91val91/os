import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationService } from '../src/kernel/notifications.js';
import { AlarmService, nextOccurrence } from '../src/kernel/alarms.js';
import { PermissionService } from '../src/kernel/permissions.js';
import { PackageManager } from '../src/kernel/packages.js';
import { Settings, createPasscode, verifyPasscode } from '../src/kernel/settings.js';
import { MediaService } from '../src/kernel/media.js';
import { MemoryBackend } from '../src/kernel/storage.js';
import { memoryStore, fakeClock, recorder } from './helpers.js';

test('réglages : valeurs par défaut, persistance et observateurs', async () => {
  const backend = new MemoryBackend();
  const settings = await new Settings({ store: memoryStore('settings', backend) }).load();
  assert.equal(settings.get('theme'), 'auto');
  const seen = [];
  settings.watch('theme', (v) => seen.push(v));
  settings.set('theme', 'dark');
  settings.set('theme', 'dark');
  assert.deepEqual(seen, ['dark']);
  await new Promise((r) => setTimeout(r, 0));
  const reloaded = await new Settings({ store: memoryStore('settings', backend) }).load();
  assert.equal(reloaded.get('theme'), 'dark');
  reloaded.reset('theme');
  assert.equal(reloaded.get('theme'), 'auto');
});

test('code de verrouillage haché et salé', async () => {
  const record = await createPasscode('1234');
  assert.equal(record.length, 4);
  assert.notEqual(record.hash, '1234');
  assert.equal(await verifyPasscode(record, '1234'), true);
  assert.equal(await verifyPasscode(record, '0000'), false);
  assert.equal(await verifyPasscode(null, 'peu importe'), true);
});

test('notifications : publication, remplacement par tag, blocage par app', async () => {
  const settings = new Settings();
  const { events, of } = recorder();
  const n = await new NotificationService({ store: memoryStore('n'), events, settings }).load();
  n.post({ appId: 'messages', title: 'Alice', body: '1', tag: 'sms:alice' });
  n.post({ appId: 'messages', title: 'Alice', body: '2', tag: 'sms:alice' });
  n.post({ appId: 'phone', title: 'Appel manqué' });
  assert.equal(n.list().length, 2);
  assert.equal(n.list({ appId: 'messages' })[0].body, '2');
  assert.equal(n.unreadCount(), 2);
  n.markAllRead();
  assert.equal(n.unreadCount(), 0);
  settings.set('notifications.phone', false);
  assert.equal(n.post({ appId: 'phone', title: 'Bloquée' }), null);
  assert.equal(n.clear({ appId: 'messages' }), 1);
  assert.equal(of('notification:post').length, 3);
  assert.throws(() => n.post({ appId: 'x' }), /appId et title/);
});

test('prochaine occurrence d\'un réveil', () => {
  const monday10 = new Date(2026, 0, 12, 10, 0).getTime(); // lundi
  const at = (t) => new Date(t);
  assert.equal(at(nextOccurrence(7, 30, null, monday10)).getDate(), 13); // demain 7:30
  assert.equal(at(nextOccurrence(11, 0, null, monday10)).getHours(), 11); // aujourd'hui 11:00
  const weekend = at(nextOccurrence(9, 0, [0, 6], monday10)); // samedi
  assert.equal(weekend.getDay(), 6);
  assert.equal(weekend.getHours(), 9);
});

test('alarmes : déclenchement, répétition, minuteur, répétition différée', async () => {
  const now = fakeClock(new Date(2026, 0, 12, 6, 0).getTime());
  const { events, of } = recorder();
  const alarms = await new AlarmService({ store: memoryStore('alarms'), events, now }).load();
  const daily = alarms.schedule({ appId: 'clock', hour: 7, minute: 0, days: [1, 2, 3, 4, 5] });
  const once = alarms.schedule({ appId: 'clock', hour: 6, minute: 30 });
  const timer = alarms.schedule({ appId: 'clock', kind: 'timer', at: now() + 60_000 });

  now.advance(60_000);
  assert.deepEqual(alarms.tick().map((a) => a.id), [timer.id]);
  assert.equal(alarms.get(timer.id), null); // minuteur supprimé

  now.set(new Date(2026, 0, 12, 6, 30).getTime());
  alarms.tick();
  assert.equal(alarms.get(once.id).enabled, false); // réveil ponctuel désactivé

  now.set(new Date(2026, 0, 12, 7, 0).getTime());
  alarms.tick();
  const next = new Date(alarms.get(daily.id).at);
  assert.equal(next.getDate(), 13); // reprogrammé pour mardi

  const snooze = alarms.snooze(alarms.get(daily.id), 9);
  assert.equal(snooze.at, now() + 9 * 60_000);
  assert.equal(of('alarm:fire').length, 3);
  assert.equal(alarms.cancel(snooze.id), true);
});

test('permissions : déclaration obligatoire, invite, refus mémorisé, « une fois »', async () => {
  const packages = new PackageManager();
  packages.register({ id: 'camera', name: 'Appareil photo', permissions: ['camera'] });
  packages.register({ id: 'notes', name: 'Notes' });
  const settings = new Settings();
  const perms = await new PermissionService({ store: memoryStore('p'), packages, settings }).load();
  const answers = ['deny', 'once'];
  let prompts = 0;
  perms.prompter = async () => {
    prompts++;
    return answers.shift();
  };
  assert.equal(await perms.request('notes', 'camera'), false); // non déclarée
  assert.equal(prompts, 0);
  assert.equal(await perms.request('camera', 'camera'), false); // refusée
  assert.equal(await perms.request('camera', 'camera'), false); // refus mémorisé, pas de nouvelle invite
  assert.equal(prompts, 1);
  perms.set('camera', 'camera', 'prompt');
  assert.equal(await perms.request('camera', 'camera'), true); // une seule fois
  assert.equal(perms.check('camera', 'camera'), 'granted');
  perms.reset('camera');
  assert.equal(perms.check('camera', 'camera'), 'prompt');
});

test('session multimédia : commandes relayées à l\'app', () => {
  const media = new MediaService();
  const calls = [];
  media.set('music', { title: 'A', playing: true }, { pause: () => calls.push('pause'), next: () => calls.push('next') });
  assert.equal(media.command('toggle'), true);
  assert.equal(media.command('next'), true);
  assert.equal(media.command('previous'), false);
  assert.deepEqual(calls, ['pause', 'next']);
  media.clear('autre');
  assert.equal(media.get().title, 'A');
  media.clear('music');
  assert.equal(media.get(), null);
});
