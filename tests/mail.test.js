import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootKernel } from '../src/kernel/kernel.js';
import { HardwareBridge } from '../src/kernel/bridge.js';
import { MailService } from '../src/kernel/mail.js';
import { PERMISSIONS } from '../src/kernel/permissions.js';
import { STORE_PERMISSIONS } from '../src/kernel/store.js';
import { fakeBridge, settle } from './fake-bridge.js';
import { fakeClock, fakeTimers } from './helpers.js';

const ACCOUNT = { name: 'Camille', address: 'camille@exemple.fr', password: 'secret', imap: { host: 'imap.exemple.fr', port: 993, security: 'ssl' }, smtp: { host: 'smtp.exemple.fr', port: 465, security: 'ssl' } };

async function boot(env) {
  const now = fakeClock();
  const kernel = await bootKernel({ manifests: [{ id: 'mailapp', name: 'Courrier', permissions: ['mail'] }], env, now, timers: fakeTimers(now) });
  await settle();
  return kernel;
}

test('messagerie : indisponible sans orion-server', async () => {
  const kernel = await boot({});
  assert.equal(kernel.mail.available, false);
  assert.deepEqual(await kernel.mail.accounts(), []);
  await assert.rejects(kernel.mail.addAccount(ACCOUNT), /Orion installé/);
});

test('messagerie : comptes, dossiers, lecture, drapeaux, envoi et suppression par le pont', async () => {
  const fake = fakeBridge();
  const kernel = await boot(fake.env());
  const events = [];
  kernel.events.on('mail:accounts', (e) => events.push(e));
  assert.equal(kernel.mail.available, true);
  assert.equal((await kernel.mail.autoconfig('a@free.fr')).imap.host, 'imap.free.fr');
  await assert.rejects(kernel.mail.addAccount({ ...ACCOUNT, password: 'faux' }), /refusée/);
  const account = await kernel.mail.addAccount(ACCOUNT);
  assert.equal(account.password, undefined);
  assert.equal(events.length, 1);
  // Délai long : connexion chiffrée et identification chez le fournisseur.
  const add = fake.requests.find((r) => r.path === 'mail/accounts/add' && r.body.password === 'secret');
  assert.equal(add.body.owner, null);
  assert.deepEqual((await kernel.mail.accounts()).map((a) => a.address), ['camille@exemple.fr']);

  const folders = await kernel.mail.folders(account.id);
  assert.deepEqual(folders.map((f) => [f.id, f.role, f.unread]), [['INBOX', 'inbox', 1], ['Envoyés', 'sent', 0]]);
  const list = await kernel.mail.messages(account.id, 'INBOX', { query: 'Bon' });
  assert.equal(list.messages[0].subject, 'Bonjour');
  assert.match(fake.requests.at(-1).url, /folder=INBOX/);
  assert.match(fake.requests.at(-1).url, /q=Bon/);
  assert.equal((await kernel.mail.message(account.id, 'INBOX', 1)).text, 'Salut');
  await kernel.mail.setFlags(account.id, 'INBOX', [1], { add: ['seen'] });
  assert.equal(fake.state.mail.boxes[account.id].INBOX[0].seen, true);
  const sent = await kernel.mail.send(account.id, { to: [{ name: 'Lucas', address: 'lucas@exemple.fr' }], subject: 'Re: Bonjour', text: 'Merci', inReplyTo: '<1@x>' });
  assert.equal(sent.savedTo, 'Envoyés');
  assert.equal(fake.state.mail.sent[0].inReplyTo, '<1@x>');
  assert.equal(await kernel.mail.remove(account.id, 'INBOX', [1]), null);
  await kernel.mail.removeAccount(account.id);
  assert.deepEqual(await kernel.mail.accounts(), []);
  await assert.rejects(kernel.mail.folders(account.id), /introuvable/);
});

test('messagerie : chaque utilisateur d\'Orion ne voit que ses comptes', async () => {
  const fake = fakeBridge();
  const bridge = await new HardwareBridge({ env: fake.env() }).detect();
  let owner = 'camille';
  const mail = new MailService({ bridge, account: () => owner });
  const mine = await mail.addAccount(ACCOUNT);
  owner = 'alex';
  assert.deepEqual(await mail.accounts({ refresh: true }), []);
  // Même en connaissant son identifiant, le compte d'un autre utilisateur est refusé.
  await assert.rejects(mail.messages(mine.id, 'INBOX'), /introuvable/);
  await assert.rejects(mail.send(mine.id, { to: ['x@exemple.fr'] }), /introuvable/);
  assert.equal(fake.state.mail.sent.length, 0);
});

test('messagerie : autorisation « E-mails » pour les apps du Store', async () => {
  assert.equal(PERMISSIONS.mail.label, 'E-mails');
  assert.ok(STORE_PERMISSIONS.includes('mail'));
  const kernel = await boot(fakeBridge().env());
  assert.equal(kernel.permissions.check('mailapp', 'mail'), 'prompt');
  kernel.permissions.prompter = async () => 'deny';
  assert.equal(await kernel.permissions.request('mailapp', 'mail'), false);
  assert.equal(kernel.permissions.check('mailapp', 'mail'), 'denied');
  // Une app qui ne l'a pas déclarée ne peut même pas la demander.
  assert.equal(kernel.permissions.check('autre', 'mail'), 'denied');
});
