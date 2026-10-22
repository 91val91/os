import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRegistry } from '../src/kernel/accounts.js';
import { MemoryBackend, Namespace } from '../src/kernel/storage.js';
import { bootKernel } from '../src/kernel/kernel.js';
import { createPasscode } from '../src/kernel/settings.js';
import { DeveloperMode, passwordProblem } from '../src/system/developer.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Un appareil : registre partagé, une session (noyau + interface minimale) par compte. */
async function device() {
  const store = new Namespace(new MemoryBackend(), 'accounts');
  const registry = await new AccountRegistry({ store }).load();
  const owner = registry.create({ name: 'Camille', owner: true });
  const guest = registry.create({ name: 'Léa' });
  await flush();
  const session = async (account) => {
    const kernel = await bootKernel({ accounts: await new AccountRegistry({ store }).load(), accountId: account.id, env: {} });
    const ui = { kernel, wm: { windows: new Map() } };
    ui.developer = new DeveloperMode(ui);
    return ui;
  };
  return { owner, guest, session };
}

test('mot de passe développeur : règles', () => {
  assert.match(passwordProblem('abc12', 'abc12'), /6 caractères/);
  assert.match(passwordProblem('abcdefg', 'abcdefg'), /lettres et chiffres/);
  assert.match(passwordProblem('orion2026', 'orion2027'), /correspondent/);
  assert.equal(passwordProblem('orion2026', 'orion2026'), null);
});

test('mode développeur : un mot de passe pour l\'appareil, géré par le propriétaire', async () => {
  const { owner, guest, session } = await device();
  const camille = await session(owner);
  assert.equal(camille.developer.configured, false);
  assert.equal(camille.developer.canManage, true);
  await camille.developer.create('orion2026');
  assert.equal(camille.developer.unlocked, true);

  // Léa : même mot de passe, sans pouvoir le changer ni le supprimer.
  const lea = await session(guest);
  assert.equal(lea.developer.configured, true);
  assert.equal(lea.developer.canManage, false);
  await assert.rejects(lea.developer.replace('autre2026'), /Camille/);
  await assert.rejects(lea.developer.remove(), /Camille/);
  assert.equal((await lea.developer.unlock('orion2026')).ok, true);

  // « Réinitialiser les réglages » d'un compte n'efface pas le mot de passe de l'appareil.
  for (const key of Object.keys(lea.kernel.settings.all())) lea.kernel.settings.reset(key);
  assert.equal((await session(guest)).developer.configured, true);
  camille.kernel.shutdown();
  lea.kernel.shutdown();
});

test('mode développeur : blocage après 5 échecs, conservé d\'une session à l\'autre', async () => {
  const { owner, session } = await device();
  const first = await session(owner);
  await first.developer.create('orion2026');
  first.developer.lock();
  assert.equal(first.developer.unlocked, false);
  for (let i = 1; i <= 4; i++) assert.deepEqual(await first.developer.unlock('faux'), { ok: false, left: 5 - i, wait: 0 });
  const fifth = await first.developer.unlock('faux');
  assert.equal(fifth.wait, 30);
  assert.equal((await first.developer.unlock('orion2026')).ok, false, 'même le bon mot de passe attend');
  await flush();
  const second = await session(owner);
  assert.ok(second.developer.wait > 25, 'blocage conservé après un redémarrage');
  first.kernel.shutdown();
  second.kernel.shutdown();
});

test('mode développeur : l\'ancien mot de passe du propriétaire devient celui de l\'appareil', async () => {
  const { owner, guest, session } = await device();
  const lea = await session(guest);
  lea.kernel.settings.set('developerPassword', await createPasscode('lea2026'));
  lea.developer.migrate();
  assert.equal(lea.developer.configured, false, 'celui d\'un autre compte est oublié');
  assert.equal(lea.kernel.settings.get('developerPassword'), undefined);

  const camille = await session(owner);
  camille.kernel.settings.set('developerPassword', await createPasscode('ancien42'));
  camille.kernel.settings.set('developer', true);
  camille.developer.migrate();
  assert.equal(camille.developer.configured, true);
  assert.equal(camille.kernel.settings.get('developer'), undefined);
  assert.equal((await camille.developer.unlock('ancien42')).ok, true);
  lea.kernel.shutdown();
  camille.kernel.shutdown();
});
