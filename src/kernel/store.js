/**
 * Store d'Orion : comptes développeur, apps publiées, achats et revenus.
 *
 * Un compte de l'appareil devient développeur en payant l'inscription ; il
 * crée ses apps (un fichier HTML, CSS et JavaScript), les fait examiner,
 * puis les publie gratuitement ou à un prix fixe. Les autres comptes les
 * trouvent dans le Store, les achètent et les installent ; le développeur
 * touche le prix moins la commission du Store.
 *
 * Il n'y a pas encore de serveur pour le Store : le catalogue est partagé par
 * les comptes de cet appareil, et les paiements sont fictifs (un solde de
 * test, aucun moyen de paiement réel n'est demandé ni débité).
 *
 * Les apps publiées s'exécutent isolées du système (voir system/app-runtime.js).
 */
import { scanApp } from './app-scan.js';

/** Inscription au programme développeur, en centimes (paiement unique). */
export const DEVELOPER_FEE = 2500;
/** Part du Store sur chaque vente. */
export const COMMISSION = 0.15;
/** Prix proposés, en centimes. */
export const PRICES = [0, 99, 199, 299, 499, 999];
/** Remboursement possible pendant ce délai après l'achat. */
export const REFUND_WINDOW = 2 * 3_600_000;
export const MAX_CODE = 256 * 1024;
/** Solde de test maximal (centimes). */
export const MAX_BALANCE = 50_000;
export const TOP_UPS = [1000, 2500, 5000];
export const CATEGORIES = ['Divertissement', 'Éducation', 'Jeux', 'Productivité', 'Santé et forme', 'Utilitaires'];
/** Pictogrammes proposés pour l'icône d'une app. */
export const GLYPHS = ['sparkles', 'star', 'heart', 'gamepad', 'music-note', 'book', 'brush', 'calculator', 'clock', 'globe', 'leaf', 'bolt', 'compass', 'notes', 'list', 'chip', 'mail'];
export const PALETTES = [
  ['#5ac8fa', '#007aff'],
  ['#ff9f0a', '#ff375f'],
  ['#30d158', '#0a7d34'],
  ['#bf5af2', '#5e5ce6'],
  ['#ff453a', '#b00020'],
  ['#ffd60a', '#ff9f0a'],
  ['#64d2ff', '#5e5ce6'],
  ['#8e8e93', '#3a3a3c'],
];
/** Autorisations qu'une app du Store peut demander. */
export const STORE_PERMISSIONS = ['location'];

/** « 1,99 € » */
export function formatPrice(cents) {
  return cents ? formatMoney(cents) : 'Gratuit';
}

/** « 12,50 € » (montant d'un solde ou d'une opération). */
export function formatMoney(cents) {
  return `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/** Part du développeur sur une vente. */
export const netRevenue = (price) => Math.round(price * (1 - COMMISSION));

const VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
const versionParts = (v) => String(v).split('.').map(Number);
function newerVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

const slug = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'app';

/** Champs d'une app que le développeur modifie (brouillon) et que la publication fige. */
const FIELDS = ['name', 'subtitle', 'description', 'category', 'icon', 'color', 'price', 'permissions', 'version', 'notes', 'code'];

export const STARTER_CODE = `<style>
  body { font: 17px system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; text-align: center; }
  button { font: inherit; padding: 12px 22px; border: 0; border-radius: 12px; background: #0a84ff; color: #fff; }
</style>
<h1>Bonjour 👋</h1>
<p>Vous avez touché le bouton <strong id="count">0</strong> fois.</p>
<button id="tap">Toucher</button>
<script>
  const count = document.getElementById('count');
  orion.storage.get('taps').then((n) => (count.textContent = n ?? 0));
  document.getElementById('tap').onclick = async () => {
    const n = ((await orion.storage.get('taps')) ?? 0) + 1;
    await orion.storage.set('taps', n);
    count.textContent = n;
    orion.device.vibrate(10);
    if (n % 10 === 0) orion.ui.toast(n + ' touchers !');
  };
</script>
`;

export class StoreError extends Error {}

export class StoreService {
  #data = new Map(); // clé → valeur (copie de l'espace partagé)
  #channel = null;

  /**
   * @param {object} options
   * @param {import('./storage.js').Namespace} options.store espace partagé par les comptes de l'appareil
   * @param {import('./packages.js').PackageManager} options.packages
   * @param {() => string | null} options.account compte de la session (null sans comptes)
   * @param {() => Promise<object>} options.runtime chargeur de l'exécuteur des apps publiées
   */
  constructor({ store, packages, events = null, log = null, now = Date.now, account = () => null, runtime = null, channel = null, random = Math.random }) {
    this.store = store;
    this.packages = packages;
    this.events = events;
    this.log = log;
    this.now = now;
    this.random = random;
    this.accountId = () => account() ?? 'local';
    this.runtime = runtime ?? (() => Promise.reject(new Error('Les apps du Store ne peuvent pas s\'exécuter ici')));
    if (channel) {
      // Autre fenêtre d'Orion (app installée et onglet) : le catalogue est relu.
      this.#channel = channel;
      channel.onmessage = () => this.reload();
    }
  }

  close() {
    this.#channel?.close?.();
    this.#channel = null;
  }

  async load() {
    this.#data = new Map(await this.store.entries());
    this.#registerAll();
    return this;
  }

  async reload() {
    this.store.snapshot = undefined;
    await this.load();
    this.events?.emit('store:change', {});
  }

  #get(key, fallback = null) {
    const value = this.#data.get(key);
    return value === undefined ? fallback : structuredClone(value);
  }

  #put(key, value) {
    if (value == null) {
      this.#data.delete(key);
      this.store.delete(key);
    } else {
      this.#data.set(key, structuredClone(value));
      this.store.put(key, value);
    }
  }

  #changed(detail = {}) {
    this.events?.emit('store:change', detail);
    this.#channel?.postMessage('change');
  }

  // ───────────── Solde de test et achats ─────────────

  /** Portefeuille d'un compte : solde de test, opérations et achats. */
  wallet(accountId = this.accountId()) {
    return { balance: 0, transactions: [], purchases: {}, ...this.#get(`wallet:${accountId}`, {}) };
  }

  #saveWallet(accountId, wallet) {
    wallet.transactions = wallet.transactions.slice(-200);
    this.#put(`wallet:${accountId}`, wallet);
  }

  #transaction(accountId, amount, type, label, extra = {}) {
    const wallet = this.wallet(accountId);
    if (wallet.balance + amount < 0) throw new StoreError(`Solde de test insuffisant (${formatMoney(wallet.balance)})`);
    wallet.balance += amount;
    const entry = { id: this.#id('T'), at: this.now(), type, amount, label, ...extra };
    wallet.transactions.push(entry);
    return { wallet, entry };
  }

  #id(prefix) {
    return `${prefix}${this.now().toString(36).toUpperCase()}${Math.floor(this.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`;
  }

  /** Ajoute de l'argent fictif au solde de test. */
  topUp(amount) {
    if (!TOP_UPS.includes(amount)) throw new StoreError('Montant invalide');
    const id = this.accountId();
    if (this.wallet(id).balance + amount > MAX_BALANCE) throw new StoreError(`Le solde de test est limité à ${formatMoney(MAX_BALANCE)}`);
    const { wallet } = this.#transaction(id, amount, 'topup', 'Crédit de test ajouté');
    this.#saveWallet(id, wallet);
    this.#changed({ wallet: id });
    return wallet.balance;
  }

  /** L'app peut-elle être installée par ce compte (gratuite, achetée ou publiée par lui) ? */
  owns(appId, accountId = this.accountId()) {
    const app = this.#get(`app:${appId}`);
    if (!app) return true; // app d'Orion
    if (app.developerId === accountId) return true;
    if (!app.live?.price) return true;
    const purchase = this.wallet(accountId).purchases[appId];
    return Boolean(purchase && !purchase.refunded);
  }

  /** Achète une app payante avec le solde de test. Renvoie le reçu. */
  purchase(appId) {
    const app = this.#get(`app:${appId}`);
    if (!app?.live) throw new StoreError('Cette app n\'est pas en vente');
    const buyer = this.accountId();
    if (this.owns(appId, buyer)) throw new StoreError('Vous possédez déjà cette app');
    if (!app.listed) throw new StoreError('Cette app a été retirée de la vente');
    const price = app.live.price;
    const { wallet } = this.#transaction(buyer, -price, 'purchase', app.live.name, { appId });
    const receipt = { id: this.#id('R'), appId, name: app.live.name, version: app.live.version, developer: app.developerName, price, at: this.now(), refunded: false };
    wallet.purchases[appId] = receipt;
    this.#saveWallet(buyer, wallet);
    // Le développeur reçoit sa part sur son solde de test.
    const net = netRevenue(price);
    const seller = this.#transaction(app.developerId, net, 'sale', `Vente de ${app.live.name}`, { appId, gross: price });
    this.#saveWallet(app.developerId, seller.wallet);
    this.#bumpStats(appId, { sales: 1, revenue: net });
    this.log?.info('store', `achat : ${appId} (${formatPrice(price)}, reçu ${receipt.id})`);
    this.#changed({ appId });
    return receipt;
  }

  canRefund(appId, accountId = this.accountId()) {
    const purchase = this.wallet(accountId).purchases[appId];
    return Boolean(purchase && !purchase.refunded && this.now() - purchase.at < REFUND_WINDOW);
  }

  /** Remboursement (dans les 2 heures) : l'app n'est plus possédée. */
  refund(appId) {
    const buyer = this.accountId();
    if (!this.canRefund(appId, buyer)) throw new StoreError('Le délai de remboursement (2 heures) est dépassé');
    const app = this.#get(`app:${appId}`);
    const purchase = this.wallet(buyer).purchases[appId];
    const { wallet } = this.#transaction(buyer, purchase.price, 'refund', `Remboursement de ${purchase.name}`, { appId });
    wallet.purchases[appId] = { ...purchase, refunded: true };
    this.#saveWallet(buyer, wallet);
    if (app) {
      // Le solde du développeur peut devenir négatif : le remboursement passe quand même.
      const seller = this.wallet(app.developerId);
      const net = netRevenue(purchase.price);
      seller.balance -= net;
      seller.transactions.push({ id: this.#id('T'), at: this.now(), type: 'chargeback', amount: -net, label: `Remboursement de ${purchase.name}`, appId });
      this.#saveWallet(app.developerId, seller);
      this.#bumpStats(appId, { sales: -1, revenue: -net, refunds: 1 });
    }
    this.#changed({ appId });
    return true;
  }

  // ───────────── Programme développeur ─────────────

  developer(accountId = this.accountId()) {
    return this.#get(`developer:${accountId}`);
  }

  /** Inscription au programme développeur, payée avec le solde de test. */
  registerDeveloper({ name, email = '', website = '', accepted = false }) {
    const id = this.accountId();
    if (this.developer(id)) throw new StoreError('Vous êtes déjà inscrit au programme développeur');
    const publicName = String(name ?? '').trim();
    if (publicName.length < 2 || publicName.length > 40) throw new StoreError('Le nom du développeur doit faire de 2 à 40 caractères');
    if (/orion/i.test(publicName)) throw new StoreError('Le nom « Orion » est réservé');
    if (this.#developers().some((d) => d.name.toLowerCase() === publicName.toLowerCase())) throw new StoreError('Ce nom de développeur est déjà pris');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new StoreError('Adresse e-mail invalide');
    if (!accepted) throw new StoreError('Acceptez le contrat de distribution pour continuer');
    const { wallet, entry } = this.#transaction(id, -DEVELOPER_FEE, 'fee', 'Inscription au programme développeur');
    this.#saveWallet(id, wallet);
    const profile = { accountId: id, name: publicName, email: email.trim(), website: String(website ?? '').trim(), joinedAt: this.now(), receipt: entry.id };
    this.#put(`developer:${id}`, profile);
    this.log?.info('store', `nouveau développeur : ${publicName}`);
    this.#changed({ developer: id });
    return profile;
  }

  #developers() {
    return [...this.#data].filter(([key]) => key.startsWith('developer:')).map(([, value]) => value);
  }

  #requireDeveloper() {
    const profile = this.developer();
    if (!profile) throw new StoreError('Inscrivez-vous au programme développeur pour publier des apps');
    return profile;
  }

  #requireOwnApp(appId) {
    const app = this.#get(`app:${appId}`);
    if (!app || app.developerId !== this.accountId()) throw new StoreError('App introuvable');
    return app;
  }

  // ───────────── Apps ─────────────

  app(appId) {
    const app = this.#get(`app:${appId}`);
    return app && { ...app, status: app.live ? (app.listed ? 'published' : 'unlisted') : 'draft', pending: Boolean(app.live && FIELDS.some((f) => JSON.stringify(app.draft[f]) !== JSON.stringify(app.live[f]))) };
  }

  /** Apps d'un développeur (le compte courant par défaut). */
  apps(developerId = this.accountId()) {
    return [...this.#data]
      .filter(([key, value]) => key.startsWith('app:') && value.developerId === developerId)
      .map(([key]) => this.app(key.slice(4)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Apps en vente (catalogue du Store). */
  catalog() {
    return [...this.#data].filter(([key, value]) => key.startsWith('app:') && value.live && value.listed).map(([key]) => this.app(key.slice(4)));
  }

  createApp({ name }) {
    const developer = this.#requireDeveloper();
    const title = String(name ?? '').trim();
    if (!title) throw new StoreError('Donnez un nom à votre app');
    let id = `store.${slug(title)}`;
    for (let i = 2; this.#data.has(`app:${id}`) || this.packages?.has(id); i++) id = `store.${slug(title)}-${i}`;
    const draft = { name: title.slice(0, 30), subtitle: '', description: '', category: 'Utilitaires', icon: GLYPHS[0], color: PALETTES[Math.floor(this.random() * PALETTES.length)], price: 0, permissions: [], version: '1.0', notes: '', code: STARTER_CODE };
    const app = { id, developerId: developer.accountId, developerName: developer.name, draft, live: null, listed: false, createdAt: this.now(), updatedAt: this.now(), history: [] };
    this.#put(`app:${id}`, app);
    this.#changed({ appId: id });
    return this.app(id);
  }

  updateDraft(appId, patch) {
    const app = this.#requireOwnApp(appId);
    for (const key of FIELDS) if (key in patch) app.draft[key] = structuredClone(patch[key]);
    app.updatedAt = this.now();
    this.#put(`app:${appId}`, app);
    this.#changed({ appId });
    return this.app(appId);
  }

  /** Supprime une app jamais vendue (un brouillon ou une app gratuite sans installation). */
  deleteApp(appId) {
    const app = this.#requireOwnApp(appId);
    const stats = this.stats(appId);
    if (app.live && (stats.sales > 0 || stats.installs > 0)) throw new StoreError('Une app déjà installée ou achetée ne peut pas être supprimée : retirez-la de la vente');
    this.#put(`app:${appId}`, null);
    this.packages?.unregister(appId);
    this.#put(`stats:${appId}`, null);
    this.#put(`ratings:${appId}`, null);
    this.#changed({ appId });
    return true;
  }

  /**
   * Examen automatique avant publication : fiche complète, version, taille et
   * analyse du code. Toutes les vérifications doivent être réussies.
   */
  review(appId) {
    const app = this.#requireOwnApp(appId);
    const d = app.draft;
    const scan = scanApp(d.code);
    const checks = [
      { label: 'Nom', ok: d.name.trim().length >= 2 && d.name.length <= 30 && !/orion/i.test(d.name), detail: /orion/i.test(d.name) ? 'Le nom « Orion » est réservé' : '2 à 30 caractères' },
      { label: 'Description', ok: d.description.trim().length >= 20, detail: 'Au moins 20 caractères' },
      { label: 'Catégorie', ok: CATEGORIES.includes(d.category), detail: d.category },
      { label: 'Prix', ok: PRICES.includes(d.price), detail: formatPrice(d.price) },
      { label: 'Version', ok: VERSION_RE.test(d.version) && (!app.live || newerVersion(d.version, app.live.version)), detail: app.live ? `Supérieure à ${app.live.version}` : 'Par exemple 1.0' },
      { label: 'Notes de version', ok: !app.live || d.notes.trim().length >= 3, detail: app.live ? 'Décrivez les nouveautés' : 'Facultatives' },
      { label: 'Taille du code', ok: d.code.trim().length > 0 && new Blob([d.code]).size <= MAX_CODE, detail: `${Math.ceil(new Blob([d.code]).size / 1024)} Ko sur ${MAX_CODE / 1024} Ko` },
      { label: 'Analyse de sécurité', ok: scan.level !== 'danger', detail: scan.findings.length ? scan.findings.map((f) => f.message).join(' · ') : 'Aucun problème détecté' },
    ];
    return { ok: checks.every((c) => c.ok), checks, scan };
  }

  /** Publie le brouillon (première publication ou mise à jour), après l'examen. */
  publish(appId) {
    const app = this.#requireOwnApp(appId);
    const result = this.review(appId);
    if (!result.ok) throw new StoreError(`Examen refusé : ${result.checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join(', ')}`);
    const developer = this.#requireDeveloper();
    const first = !app.live;
    app.live = { ...structuredClone(app.draft), size: new Blob([app.draft.code]).size, scan: result.scan, publishedAt: this.now() };
    app.developerName = developer.name;
    app.listed = true;
    app.updatedAt = this.now();
    app.history = [...app.history, { version: app.live.version, notes: app.live.notes, at: this.now() }].slice(-20);
    this.#put(`app:${appId}`, app);
    this.#register(app);
    this.log?.info('store', `${first ? 'publiée' : 'mise à jour'} : ${appId} ${app.live.version}`);
    this.#changed({ appId });
    return this.app(appId);
  }

  /** Retire de la vente (les copies installées restent utilisables) ou remet en vente. */
  setListed(appId, listed) {
    const app = this.#requireOwnApp(appId);
    if (!app.live) throw new StoreError('Publiez d\'abord votre app');
    app.listed = Boolean(listed);
    app.updatedAt = this.now();
    this.#put(`app:${appId}`, app);
    this.#register(app);
    this.#changed({ appId });
    return this.app(appId);
  }

  // ───────────── Statistiques et notes ─────────────

  stats(appId) {
    return { sales: 0, revenue: 0, refunds: 0, installs: 0, ...this.#get(`stats:${appId}`, {}) };
  }

  #bumpStats(appId, delta) {
    const stats = this.stats(appId);
    for (const [key, value] of Object.entries(delta)) stats[key] = (stats[key] ?? 0) + value;
    this.#put(`stats:${appId}`, stats);
  }

  /** Une installation par compte est comptée. */
  recordInstall(appId) {
    if (!this.#data.has(`app:${appId}`)) return;
    const seen = this.#get(`installs:${appId}`, []);
    if (seen.includes(this.accountId())) return;
    this.#put(`installs:${appId}`, [...seen, this.accountId()]);
    this.#bumpStats(appId, { installs: 1 });
  }

  /** Résumé du développeur : ventes, revenus nets, installations, note. */
  summary(developerId = this.accountId()) {
    const apps = this.apps(developerId);
    const total = { apps: apps.length, published: apps.filter((a) => a.live).length, sales: 0, revenue: 0, installs: 0, ratings: 0, stars: 0 };
    for (const app of apps) {
      const stats = this.stats(app.id);
      total.sales += stats.sales;
      total.revenue += stats.revenue;
      total.installs += stats.installs;
      const rating = this.rating(app.id);
      total.ratings += rating.count;
      total.stars += rating.average * rating.count;
    }
    total.average = total.ratings ? total.stars / total.ratings : 0;
    return total;
  }

  rating(appId) {
    const votes = Object.values(this.#get(`ratings:${appId}`, {}));
    return { count: votes.length, average: votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 0, mine: this.#get(`ratings:${appId}`, {})[this.accountId()] ?? 0 };
  }

  /** Note de 1 à 5, une par compte qui a installé l'app (pas le développeur). */
  rate(appId, stars) {
    const app = this.#get(`app:${appId}`);
    if (!app?.live) throw new StoreError('App introuvable');
    if (app.developerId === this.accountId()) throw new StoreError('Vous ne pouvez pas noter votre propre app');
    if (!this.packages?.isInstalled(appId)) throw new StoreError('Installez l\'app pour la noter');
    const value = Math.round(Number(stars));
    if (!(value >= 1 && value <= 5)) throw new StoreError('Note invalide');
    this.#put(`ratings:${appId}`, { ...this.#get(`ratings:${appId}`, {}), [this.accountId()]: value });
    this.#changed({ appId });
  }

  // ───────────── Paquets ─────────────

  #registerAll() {
    for (const [key, app] of this.#data) if (key.startsWith('app:') && app.live) this.#register(app);
    // Supprimée par son développeur (depuis une autre fenêtre) : elle quitte aussi le catalogue de celle-ci.
    for (const pkg of this.packages?.list({ installed: null }) ?? []) if (pkg.store && !this.#data.get(`app:${pkg.id}`)?.live) this.packages.unregister(pkg.id);
  }

  /** Manifeste de paquet d'une app publiée (version en ligne). */
  #register(app) {
    if (!this.packages) return;
    const live = app.live;
    this.packages.register({
      id: app.id,
      name: live.name,
      icon: live.icon,
      color: live.color,
      category: live.category,
      description: live.subtitle || live.description,
      longDescription: live.description,
      version: live.version,
      notes: live.notes,
      size: Math.max(0.1, Math.round((live.size / 1_048_576) * 10) / 10),
      permissions: live.permissions.filter((p) => STORE_PERMISSIONS.includes(p)),
      publisher: { id: app.developerId, name: app.developerName },
      price: live.price,
      unlisted: !app.listed,
      store: true,
      code: live.code,
      scan: live.scan,
      load: this.runtime,
    });
  }
}
