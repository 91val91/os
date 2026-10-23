import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, Namespace } from '../src/kernel/storage.js';
import { PackageManager } from '../src/kernel/packages.js';
import { EventBus } from '../src/kernel/events.js';
import { StoreService, DEVELOPER_FEE, netRevenue, formatPrice, REFUND_WINDOW } from '../src/kernel/store.js';
import { scanApp } from '../src/kernel/app-scan.js';
import { bootKernel } from '../src/kernel/kernel.js';
import { fakeClock } from './helpers.js';

/** Appareil à plusieurs comptes : espace partagé commun, un PackageManager par compte. */
function device() {
  const shared = new MemoryBackend();
  const now = fakeClock();
  const session = async (account) => {
    const packages = new PackageManager({ store: new Namespace(new MemoryBackend(), 'packages'), events: new EventBus(), now });
    const store = await new StoreService({ store: new Namespace(shared, 'store'), packages, events: new EventBus(), now, account: () => account, runtime: async () => ({}) }).load();
    await packages.load();
    return { packages, store };
  };
  return { shared, now, session };
}

const GOOD = {
  description: 'Un compteur de touchers très simple, pour essayer le Store.',
  code: '<button id="b">+1</button><script>document.getElementById("b").onclick = () => orion.ui.toast("+1")</script>',
};

test('prix et commission', () => {
  assert.equal(formatPrice(0), 'Gratuit');
  assert.equal(formatPrice(199).replace(/\s/g, ' '), '1,99 €');
  assert.equal(netRevenue(199), 169);
});

test('programme développeur : inscription payée avec le solde de test', async () => {
  const { session } = device();
  const { store } = await session('owner');
  assert.throws(() => store.registerDeveloper({ name: 'Camille Apps', accepted: true }), /insuffisant/);
  store.topUp(2500);
  assert.throws(() => store.registerDeveloper({ name: 'Camille Apps' }), /contrat/);
  assert.throws(() => store.registerDeveloper({ name: 'Orion Officiel', accepted: true }), /réservé/);
  const profile = store.registerDeveloper({ name: 'Camille Apps', email: 'camille@example.com', accepted: true });
  assert.equal(profile.name, 'Camille Apps');
  assert.equal(store.wallet().balance, 2500 - DEVELOPER_FEE);
  assert.deepEqual(store.wallet().transactions.map((t) => t.type), ['topup', 'fee']);
  assert.throws(() => store.registerDeveloper({ name: 'Autre', accepted: true }), /déjà inscrit/);
  assert.throws(() => store.topUp(1234), /invalide/);
});

test('publication : brouillon, examen, mise en ligne, mise à jour et retrait', async () => {
  const { session } = device();
  const dev = await session('owner');
  dev.store.topUp(2500);
  assert.throws(() => dev.store.createApp({ name: 'Compteur' }), /Inscrivez-vous/);
  dev.store.registerDeveloper({ name: 'Camille Apps', accepted: true });
  const draft = dev.store.createApp({ name: 'Compteur' });
  assert.equal(draft.id, 'store.compteur');
  assert.equal(draft.status, 'draft');
  assert.equal(dev.store.createApp({ name: 'Compteur' }).id, 'store.compteur-2');

  // Description trop courte : examen refusé.
  assert.equal(dev.store.review(draft.id).ok, false);
  assert.throws(() => dev.store.publish(draft.id), /Examen refusé : description/);
  dev.store.updateDraft(draft.id, { ...GOOD, price: 199, category: 'Jeux' });
  assert.equal(dev.store.review(draft.id).ok, true);
  const live = dev.store.publish(draft.id);
  assert.equal(live.status, 'published');
  assert.equal(dev.packages.get(draft.id).price, 199);
  assert.equal(dev.packages.get(draft.id).publisher.name, 'Camille Apps');
  assert.deepEqual(dev.store.catalog().map((a) => a.id), [draft.id]);

  // Mise à jour : le brouillon diffère de la version en ligne jusqu'à sa publication.
  dev.store.updateDraft(draft.id, { code: `${GOOD.code}<p>v2</p>` });
  assert.equal(dev.store.app(draft.id).pending, true);
  assert.match(dev.store.review(draft.id).checks.find((c) => c.label === 'Version').detail, /Supérieure à 1.0/);
  assert.equal(dev.store.review(draft.id).ok, false);
  dev.store.updateDraft(draft.id, { version: '1.1', notes: 'Nouveau paragraphe' });
  dev.store.publish(draft.id);
  assert.equal(dev.packages.get(draft.id).version, '1.1');
  assert.match(dev.packages.get(draft.id).code, /v2/);

  // Code dangereux : refusé à l'examen.
  dev.store.updateDraft(draft.id, { version: '1.2', notes: 'Piège', code: '<script>top.location = "https://exemple.invalid"</script>' });
  assert.throws(() => dev.store.publish(draft.id), /analyse de sécurité/);

  dev.store.setListed(draft.id, false);
  assert.deepEqual(dev.store.catalog(), []);
  assert.equal(dev.packages.get(draft.id).unlisted, true);
});

test('achat d\'une app payante par un autre compte, revenus du développeur et remboursement', async () => {
  const { session, now } = device();
  const dev = await session('owner');
  dev.store.topUp(2500);
  dev.store.registerDeveloper({ name: 'Camille Apps', accepted: true });
  const { id } = dev.store.createApp({ name: 'Compteur' });
  dev.store.updateDraft(id, { ...GOOD, price: 199 });
  dev.store.publish(id);
  assert.equal(dev.store.owns(id), true, 'le développeur possède ses apps');

  // Un autre compte de l'appareil voit l'app dans son Store.
  const buyer = await session('u2');
  assert.ok(buyer.packages.get(id));
  assert.equal(buyer.store.owns(id), false);
  assert.throws(() => buyer.store.purchase(id), /insuffisant/);
  buyer.store.topUp(1000);
  const receipt = buyer.store.purchase(id);
  assert.match(receipt.id, /^R/);
  assert.equal(buyer.store.wallet().balance, 1000 - 199);
  assert.equal(buyer.store.owns(id), true);
  assert.throws(() => buyer.store.purchase(id), /possédez déjà/);
  await buyer.packages.install(id);
  buyer.store.recordInstall(id);
  buyer.store.recordInstall(id);
  buyer.store.rate(id, 4);
  assert.throws(() => dev.store.rate(id, 5), /propre app/);

  // Le développeur (autre fenêtre) voit sa vente après relecture.
  await dev.store.reload();
  assert.equal(dev.store.wallet().balance, netRevenue(199));
  assert.deepEqual(dev.store.stats(id), { sales: 1, revenue: netRevenue(199), refunds: 0, installs: 1 });
  assert.equal(dev.store.summary().average, 4);
  assert.throws(() => dev.store.deleteApp(id), /retirez-la de la vente/);

  // Remboursement dans les 2 heures.
  await buyer.store.reload();
  assert.equal(buyer.store.canRefund(id), true);
  buyer.store.refund(id);
  assert.equal(buyer.store.wallet().balance, 1000);
  assert.equal(buyer.store.owns(id), false);
  assert.throws(() => buyer.store.refund(id), /délai/);
  await dev.store.reload();
  assert.equal(dev.store.wallet().balance, 0);
  assert.equal(dev.store.stats(id).sales, 0);

  // Après le délai : plus de remboursement.
  buyer.store.purchase(id);
  now.advance(REFUND_WINDOW + 1);
  assert.equal(buyer.store.canRefund(id), false);
});

test('une app supprimée par son développeur disparaît du catalogue', async () => {
  const { session } = device();
  const dev = await session('owner');
  dev.store.topUp(2500);
  dev.store.registerDeveloper({ name: 'Camille Apps', accepted: true });
  const { id } = dev.store.createApp({ name: 'Essai' });
  dev.store.updateDraft(id, GOOD);
  dev.store.publish(id);
  assert.ok(dev.packages.get(id));
  dev.store.deleteApp(id);
  assert.equal(dev.packages.get(id), null);
  assert.equal(dev.store.app(id), null);
});

test('le noyau enregistre les apps publiées avant de relire les apps installées', async () => {
  const backend = new MemoryBackend();
  const shared = new MemoryBackend();
  const first = await bootKernel({ backend, shared, env: {} });
  first.store.topUp(2500);
  first.store.registerDeveloper({ name: 'Camille Apps', accepted: true });
  const { id } = first.store.createApp({ name: 'Compteur' });
  first.store.updateDraft(id, GOOD);
  first.store.publish(id);
  await first.packages.install(id);
  first.shutdown();
  await new Promise((r) => setTimeout(r, 0));
  const again = await bootKernel({ backend, shared, env: {} });
  assert.equal(again.packages.isInstalled(id), true, 'installée après redémarrage');
  again.shutdown();
});

test('analyse des apps', () => {
  assert.equal(scanApp(GOOD.code).level, 'safe');
  assert.equal(scanApp('<script>top.location = "x"</script>').level, 'danger');
  assert.equal(scanApp('<script>new CoinHive.Anonymous("k")</script>').level, 'danger');
  assert.equal(scanApp('<p>Code de verrouillage d\'Orion</p><input type="password">').level, 'danger');
  assert.deepEqual(scanApp('<script>fetch("https://exemple.invalid")</script>').findings.map((f) => f.id), ['network']);
  assert.deepEqual(scanApp('<script>eval("1+1")</script>').findings.map((f) => f.id), ['dynamic']);
  assert.equal(scanApp(`<script>var s = "${'\\x41'.repeat(60)}"</script>`).findings[0].id, 'obfuscated');
});
