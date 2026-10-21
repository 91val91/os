import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRegistry, openSession, eraseAllAccounts, OWNER_DB } from '../src/kernel/accounts.js';
import { MemoryBackend, Namespace } from '../src/kernel/storage.js';
import { bootKernel } from '../src/kernel/kernel.js';

/** localStorage minimal (navigateur sans IndexedDB). */
function fakeLocalStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('registre : propriétaire, utilisateurs, compte courant, suppression', async () => {
  const backend = new MemoryBackend();
  let t = 1000;
  const registry = await new AccountRegistry({ store: new Namespace(backend, 'accounts'), now: () => t++ }).load();
  const owner = registry.create({ name: 'Camille', owner: true });
  assert.equal(owner.db, OWNER_DB);
  assert.equal(registry.current.id, owner.id);
  assert.throws(() => registry.create({ owner: true }), /propriétaire/);

  const lea = registry.create({ name: '  Léa ', email: 'lea@exemple.fr' });
  assert.equal(lea.name, 'Léa');
  assert.notEqual(lea.db, OWNER_DB);
  assert.deepEqual(registry.list().map((a) => a.name), ['Camille', 'Léa']);

  registry.update(lea.id, { email: 'lea.b@exemple.fr', owner: true, db: 'piratage' });
  assert.equal(registry.get(lea.id).email, 'lea.b@exemple.fr');
  assert.equal(registry.get(lea.id).owner, false, 'seuls les champs du profil sont modifiables');
  assert.equal(registry.get(lea.id).db, lea.db);

  await registry.setCurrent(lea.id);
  assert.equal(registry.current.id, lea.id);
  assert.throws(() => registry.remove(owner.id), /propriétaire/);
  assert.equal(await registry.remove(lea.id), true);
  assert.equal(registry.current.id, owner.id, 'retour au propriétaire');
  assert.deepEqual(registry.removed, [lea.db]);

  await flush();
  const reloaded = await new AccountRegistry({ store: new Namespace(backend, 'accounts') }).load();
  assert.deepEqual(reloaded.list().map((a) => a.name), ['Camille']);
  assert.deepEqual(reloaded.removed, [lea.db]);
});

test('session : chaque compte a ses propres données, effacées avec lui', async () => {
  const localStorage = fakeLocalStorage();
  const env = { localStorage };

  // Premier démarrage : le propriétaire utilise la base d'origine (préfixe « orion: »).
  const first = await openSession(env);
  assert.equal(first.account.owner, true);
  await first.backend.put('fs:/home', 'propriétaire');
  const guest = first.registry.create({ name: 'Hugo' });
  await first.registry.setCurrent(guest.id);

  const second = await openSession(env);
  assert.equal(second.account.id, guest.id);
  assert.deepEqual(await second.backend.getAll(), [], 'nouveau compte : base vide');
  await second.backend.put('fs:/home', 'invité');

  await second.registry.setCurrent(first.account.id);
  const third = await openSession(env);
  assert.deepEqual(await third.backend.getAll(), [['fs:/home', 'propriétaire']], 'pas de fuite entre comptes');

  // Suppression : la base du compte disparaît au démarrage suivant.
  await third.registry.remove(guest.id);
  const fourth = await openSession(env);
  assert.deepEqual(fourth.registry.removed, []);
  assert.ok(!localStorage.keys().some((key) => key.startsWith(guest.db)), 'données du compte effacées');
  assert.ok(localStorage.keys().includes('orion:fs:/home'));

  await eraseAllAccounts(fourth.registry, env);
  assert.deepEqual(localStorage.keys(), [], 'réinitialisation : tout est effacé');
});

test('noyau : compte de la session et événement de changement', async () => {
  const registry = await new AccountRegistry({ store: new Namespace(new MemoryBackend(), 'accounts') }).load();
  registry.create({ name: 'Camille', owner: true });
  const kernel = await bootKernel({ backend: new MemoryBackend(), accounts: registry, env: {} });
  assert.equal(kernel.account.name, 'Camille');
  let changes = 0;
  kernel.events.on('account:change', () => changes++);
  kernel.accounts.update(kernel.account.id, { name: 'Camille D.' });
  assert.equal(kernel.account.name, 'Camille D.');
  assert.equal(changes, 1);
  kernel.shutdown();
});
