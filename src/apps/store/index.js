/**
 * Store : catalogue des applications (celles d'Orion et celles publiées par
 * les développeurs), achats avec le solde de test, installation
 * (téléchargement simulé), notes, compte et console développeur.
 */
import { h, render as fill } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { navStack, page, tabBar, searchField, listGroup, listItem, emptyState, avatar, button } from '../../lib/ui.js';
import { appIcon } from '../../system/app-icon.js';
import { PERMISSIONS } from '../../kernel/permissions.js';
import { formatPrice, formatMoney, TOP_UPS, DEVELOPER_FEE, COMMISSION } from '../../kernel/store.js';
import { scanApp } from '../../kernel/app-scan.js';
import { developerConsole } from './console.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const STARS = { game2048: 4.8, snake: 4.6, paint: 4.7, recorder: 4.5 };
const dateFormat = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export function mount(root, ctx) {
  const pm = ctx.kernel.packages;
  const store = ctx.kernel.store;
  const downloads = new Map(); // id → progression 0..1
  const container = h('div.store-views');
  const nav = navStack(container);
  let tab = 'today';
  let query = '';

  // Une app retirée de la vente n'apparaît que pour ceux qui l'ont installée.
  const catalog = () => pm.list({ installed: null }).filter((p) => !p.hidden && !(p.unlisted && !pm.isInstalled(p.id)));
  const optional = () => catalog().filter((p) => !p.system && !p.store);
  const published = () => catalog().filter((p) => p.store && !p.unlisted);
  const publisher = (pkg) => pkg.publisher?.name ?? 'Orion Labs';

  /** Vérification d'identité (code de verrouillage) avant un paiement. */
  const verify = (title) => ctx.system.protection?.verify({ title, reason: 'Confirmez avec votre code de verrouillage.' }) ?? Promise.resolve(true);

  async function topUp() {
    const choice = await ctx.ui.actionSheet({
      title: 'Ajouter des fonds de test',
      message: 'Argent fictif pour essayer les achats et le programme développeur. Aucun paiement réel n\'est demandé ni débité.',
      actions: TOP_UPS.map((amount) => ({ label: `+ ${formatMoney(amount)}`, value: amount })),
    });
    if (!choice) return false;
    try {
      store.topUp(choice);
      ctx.ui.toast(`Solde de test : ${formatMoney(store.wallet().balance)}`);
      return true;
    } catch (error) {
      await ctx.ui.alert({ title: 'Impossible d\'ajouter des fonds', message: error.message });
      return false;
    }
  }

  // ───────────── Achat (paiement fictif) ─────────────

  async function buy(pkg) {
    const wallet = store.wallet();
    const enough = wallet.balance >= pkg.price;
    const content = h(
      'div.pay-sheet',
      appIcon(pkg, { size: 56 }),
      h('strong', pkg.name),
      h('span.pay-dev', publisher(pkg)),
      h('div.pay-rows', h('div', h('span', 'Prix'), h('b', formatPrice(pkg.price))), h('div', h('span', 'Solde de test'), h('b', formatMoney(wallet.balance)))),
      h('p.pay-note', icon('info', { size: 14 }), 'Paiement fictif : le prix est retiré de votre solde de test, aucun argent réel n\'est débité.'),
    );
    const choice = await ctx.ui.alert({
      title: 'Orion Pay',
      content,
      buttons: [{ label: 'Annuler', value: null, role: 'cancel' }, enough ? { label: `Payer ${formatPrice(pkg.price)}`, value: 'pay' } : { label: 'Ajouter des fonds de test', value: 'topup' }],
    });
    if (choice === 'topup') return (await topUp()) && buy(pkg);
    if (choice !== 'pay' || !(await verify(`Acheter ${pkg.name}`))) return false;
    try {
      const receipt = store.purchase(pkg.id);
      ctx.ui.vibrate([10, 40, 10]);
      ctx.ui.toast(`Achat confirmé · reçu ${receipt.id}`);
      return true;
    } catch (error) {
      await ctx.ui.alert({ title: 'Achat impossible', message: error.message });
      return false;
    }
  }

  // ───────────── Bouton Obtenir / prix / Ouvrir ─────────────

  function getButton(pkg) {
    const btn = h('button.get-btn', { type: 'button', onclick: (e) => { e.stopPropagation(); act(pm.get(pkg.id) ?? pkg); } });
    btn.dataset.app = pkg.id;
    renderButton(btn, pkg);
    return btn;
  }

  function renderButton(btn, pkg) {
    if (!pkg) return;
    const progress = downloads.get(pkg.id);
    btn.classList.remove('price');
    if (progress != null) {
      btn.className = 'get-btn downloading';
      btn.style.setProperty('--p', String(progress));
      btn.replaceChildren(h('span.ring'), h('span.stop'));
      btn.setAttribute('aria-label', 'Téléchargement en cours');
      return;
    }
    btn.className = 'get-btn';
    btn.removeAttribute('aria-label');
    if (pm.isInstalled(pkg.id)) btn.textContent = 'OUVRIR';
    else if (pkg.store && pkg.price && !store.owns(pkg.id)) {
      btn.textContent = formatPrice(pkg.price);
      btn.classList.add('price');
    } else btn.textContent = 'OBTENIR';
  }

  function refreshButtons() {
    for (const btn of root.querySelectorAll('.get-btn')) renderButton(btn, pm.get(btn.dataset.app));
  }

  async function act(pkg) {
    if (downloads.has(pkg.id)) return;
    if (pm.isInstalled(pkg.id)) {
      ctx.startActivity({ app: pkg.id, action: 'main' });
      return;
    }
    if (!ctx.kernel.device.connectivity.online) {
      ctx.ui.alert({ title: 'Pas de connexion', message: 'Connectez-vous à Internet pour télécharger des applications.' });
      return;
    }
    if (pkg.store) {
      if (!store.owns(pkg.id) && !(await buy(pkg))) return;
      // Analyse avant installation (Protection de l'appareil).
      const scan = ctx.system.protection?.scanBeforeInstall(pkg) ?? scanApp(pkg.code);
      if (scan.level === 'danger') {
        await ctx.ui.alert({ title: 'Installation bloquée', message: `Protection de l'appareil a bloqué ${pkg.name} : ${scan.findings.map((f) => f.message).join(' ; ')}.` });
        return;
      }
    }
    download(pkg);
  }

  function download(pkg) {
    downloads.set(pkg.id, 0);
    refreshButtons();
    const started = ctx.now();
    const total = 900 + pkg.size * 600;
    const stop = ctx.setInterval(async () => {
      const p = Math.min(1, (ctx.now() - started) / total);
      downloads.set(pkg.id, p);
      refreshButtons();
      if (p >= 1) {
        stop();
        await pkg.load().catch(() => null);
        downloads.delete(pkg.id);
        if (pm.has(pkg.id)) {
          await pm.install(pkg.id);
          if (pkg.store) store.recordInstall(pkg.id);
          ctx.ui.vibrate(20);
        }
        refreshButtons();
      }
    }, 80);
  }

  // ───────────── Pages ─────────────

  function appRow(pkg) {
    return h(
      'div.list-item.tappable.store-row',
      { onclick: () => detailPage(pkg.id) },
      appIcon(pkg, { size: 58 }),
      h('div.li-body', h('div.li-title', pkg.name), h('div.li-sub', pkg.description || pkg.category), h('div.li-sub.store-cat', pkg.store ? `${pkg.category} · ${publisher(pkg)}` : pkg.category)),
      getButton(pkg),
    );
  }

  const todayContent = h('div');
  const todayPage = page({ title: "Aujourd'hui", content: todayContent });
  function renderToday() {
    const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
    const feature = (id, kicker, title, text, gradient) => {
      const pkg = pm.get(id);
      return h(
        'button.store-feature',
        { type: 'button', style: { background: gradient }, onclick: () => detailPage(id) },
        h('small', kicker),
        h('strong', title),
        h('p', text),
        h('div.store-feature-app', appIcon(pkg, { size: 44 }), h('div', h('b', pkg.name), h('span', pkg.category)), getButton(pkg)),
      );
    };
    const fresh = published().sort((a, b) => (store.app(b.id)?.live?.publishedAt ?? 0) - (store.app(a.id)?.live?.publishedAt ?? 0));
    fill(
      todayContent,
      h('div.store-date', date),
      feature('game2048', 'LE JEU DU JOUR', 'Fusionnez jusqu\'à 2048', 'Un casse-tête minimaliste pour aiguiser votre logique en quelques minutes.', 'linear-gradient(150deg, #f7b733, #fc4a1a)'),
      fresh.length ? listGroup({ header: 'Nouveautés des développeurs', items: fresh.slice(0, 6).map(appRow) }) : null,
      feature('paint', 'CRÉATIVITÉ', 'Votre écran est une toile', 'Dessinez du bout des doigts et enregistrez vos œuvres dans Photos.', 'linear-gradient(150deg, #a855f7, #ec4899)'),
      listGroup({ header: 'À découvrir', items: optional().map(appRow) }),
      h(
        'button.store-dev-banner',
        { type: 'button', onclick: () => developer.open() },
        icon('code', { size: 26 }),
        h('div', h('strong', 'Vous développez des apps ?'), h('span', store.developer() ? 'Ouvrir la console développeur' : 'Publiez-les sur le Store, gratuites ou payantes.')),
        icon('chevron-right', { size: 18 }),
      ),
    );
  }

  const appsContent = h('div');
  const appsPage = page({ title: 'Apps', content: appsContent });
  function renderApps() {
    const groups = new Map();
    for (const pkg of catalog()) {
      if (!groups.has(pkg.category)) groups.set(pkg.category, []);
      groups.get(pkg.category).push(pkg);
    }
    appsContent.replaceChildren(...[...groups].sort(([a], [b]) => a.localeCompare(b, 'fr')).map(([category, apps]) => listGroup({ header: category, items: apps.map(appRow) })));
  }

  const searchContent = h('div');
  const searchPage = page({ title: 'Rechercher', content: [searchField({ placeholder: 'Jeux, apps, développeurs…', onInput: (v) => { query = v.trim().toLowerCase(); renderSearch(); } }), searchContent] });
  function renderSearch() {
    const results = query ? catalog().filter((p) => `${p.name} ${p.category} ${p.description} ${publisher(p)}`.toLowerCase().includes(query)) : [];
    searchContent.replaceChildren(
      query
        ? results.length
          ? h('div.list.store-results', results.map(appRow))
          : emptyState({ icon: 'search', title: 'Aucun résultat', message: `Rien ne correspond à « ${query} ».` })
        : h('div.store-suggestions', h('div.list-header', 'Suggestions'), ...['jeux', 'dessin', 'audio', 'utilitaires'].map((s) => h('button.chip', { type: 'button', onclick: () => { searchPage.querySelector('input').value = s; query = s; renderSearch(); } }, s))),
    );
  }

  function stars(value, { size = 16, onPick = null } = {}) {
    return h(
      'div.store-stars',
      [1, 2, 3, 4, 5].map((n) =>
        onPick
          ? h('button', { type: 'button', 'aria-label': `${n} étoile${n > 1 ? 's' : ''}`, onclick: () => onPick(n) }, icon(n <= value ? 'star-fill' : 'star', { size }))
          : icon(n <= Math.round(value) ? 'star-fill' : 'star', { size }),
      ),
    );
  }

  function detailPage(id) {
    const content = h('div');
    const render = () => {
      const pkg = pm.get(id);
      if (!pkg) {
        fill(content, emptyState({ icon: 'store', title: 'App indisponible', message: 'Elle a été supprimée par son développeur.' }));
        return;
      }
      const installed = pm.isInstalled(id);
      const rating = pkg.store ? store.rating(id) : { average: STARS[id] ?? 4.4, count: null };
      const app = pkg.store ? store.app(id) : null;
      const mine = app && store.developer()?.accountId === app.developerId;
      const scan = pkg.store ? pkg.scan ?? scanApp(pkg.code) : null;
      fill(
        content,
        h('div.store-detail-head', appIcon(pkg, { size: 110 }), h('div', h('h2', pkg.name), h('p', publisher(pkg)), getButton(pkg))),
        h(
          'div.store-stats',
          h('div', h('small', rating.count == null ? 'NOTES' : rating.count ? `${rating.count} NOTE${rating.count > 1 ? 'S' : ''}` : 'NOTES'), h('strong', rating.count === 0 ? '—' : rating.average.toFixed(1).replace('.', ',')), rating.count === 0 ? h('span', 'Aucune') : stars(rating.average, { size: 11 })),
          h('div', h('small', 'PRIX'), h('strong', pkg.price ? formatPrice(pkg.price) : 'Gratuit'), h('span', pkg.store && pkg.price && store.owns(id) ? 'Acheté' : ' ')),
          h('div', h('small', 'TAILLE'), h('strong', String(pkg.size).replace('.', ',')), h('span', 'Mo')),
          h('div', h('small', 'VERSION'), h('strong', pkg.version), h('span', pkg.system ? 'Système' : 'Store')),
        ),
        pkg.store ? null : h('div.store-shots', [0, 1, 2].map((i) => h('div.store-shot', { style: { background: `linear-gradient(${160 + i * 40}deg, ${pkg.color[0]}, ${pkg.color[1]})` } }, appIcon(pkg, { size: 54 + i * 6 })))),
        h('p.store-description', pkg.longDescription ?? pkg.description),
        pkg.store && pkg.notes ? listGroup({ header: `Nouveautés · version ${pkg.version}`, items: [h('div.list-item', h('div.li-body', h('div.li-sub.store-notes', pkg.notes)))] }) : null,
        pkg.store && installed && !mine
          ? listGroup({ header: 'Votre note', items: [h('div.list-item.store-rate', stars(rating.mine, { size: 26, onPick: (n) => { try { store.rate(id, n); ctx.ui.toast('Merci pour votre note'); } catch (error) { ctx.ui.toast(error.message); } } }))] })
          : null,
        scan
          ? listGroup({
              header: 'Protection de l\'appareil',
              items: [
                listItem({
                  icon: scan.level === 'safe' ? 'shield' : 'info',
                  iconColor: scan.level === 'safe' ? '#30d158' : '#ff9f0a',
                  title: scan.level === 'safe' ? 'Aucun problème détecté' : 'À surveiller',
                  subtitle: scan.level === 'safe' ? 'Analysée avant sa publication · s\'exécute isolée, sans accès à Internet' : scan.findings.map((f) => f.message).join(' · '),
                }),
              ],
            })
          : null,
        listGroup({
          header: 'Informations',
          items: [
            h('div.list-item', h('div.li-body', h('div.li-title', 'Développeur')), h('div.li-detail', publisher(pkg))),
            h('div.list-item', h('div.li-body', h('div.li-title', 'Catégorie')), h('div.li-detail', pkg.category)),
            h('div.list-item', h('div.li-body', h('div.li-title', 'Autorisations')), h('div.li-detail', pkg.permissions.map((p) => PERMISSIONS[p]?.label ?? p).join(', ') || 'Aucune')),
            h('div.list-item', h('div.li-body', h('div.li-title', 'Confidentialité')), h('div.li-detail', pkg.store ? 'Aucun accès à Internet' : 'Aucune donnée collectée')),
            app?.live ? h('div.list-item', h('div.li-body', h('div.li-title', 'Mise à jour')), h('div.li-detail', dateFormat(app.live.publishedAt))) : null,
          ],
        }),
        mine ? button('Gérer dans la console développeur', { variant: 'tinted', block: true, icon: 'code', onClick: () => developer.open({ app: id }) }) : null,
        installed && !pkg.system
          ? h('button.btn.btn-gray.block.destructive.store-remove', { type: 'button', onclick: async () => {
              if (await ctx.ui.confirm({ title: `Supprimer ${pkg.name} ?`, message: pkg.store && pkg.price ? 'Ses données seront supprimées. Vous pourrez la réinstaller sans payer à nouveau.' : 'Ses données seront également supprimées.', confirmLabel: 'Supprimer', destructive: true })) {
                await pm.uninstall(id);
                render();
              }
            } }, icon('trash', { size: 18 }), "Supprimer l'app")
          : null,
      );
    };
    const p = page({ title: '', large: false, back: { label: 'Retour', onClick: () => nav.pop() }, content });
    p.onShow = render;
    p.refresh = render;
    render();
    nav.push(p);
  }

  // ───────────── Compte : solde de test, achats, développeur ─────────────

  const accountContent = h('div');
  const accountPage = page({ title: 'Compte', content: accountContent });

  async function purchaseActions(receipt) {
    const pkg = pm.get(receipt.appId);
    const actions = [
      pkg ? { label: 'Voir dans le Store', value: 'view' } : null,
      { label: 'Afficher le reçu', value: 'receipt' },
      store.canRefund(receipt.appId) ? { label: 'Demander un remboursement', value: 'refund', destructive: true } : null,
    ].filter(Boolean);
    const choice = await ctx.ui.actionSheet({ title: receipt.name, actions });
    if (choice === 'view') detailPage(receipt.appId);
    else if (choice === 'receipt') {
      await ctx.ui.alert({
        title: `Reçu ${receipt.id}`,
        content: h(
          'div.store-receipt',
          h('div', h('span', 'App'), h('b', `${receipt.name} ${receipt.version}`)),
          h('div', h('span', 'Développeur'), h('b', receipt.developer)),
          h('div', h('span', 'Montant'), h('b', formatMoney(receipt.price))),
          h('div', h('span', 'Date'), h('b', new Date(receipt.at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }))),
          receipt.refunded ? h('div', h('span', 'État'), h('b', 'Remboursé')) : null,
          h('p', 'Payé avec le solde de test : aucun argent réel.'),
        ),
      });
    } else if (choice === 'refund') {
      if (!(await ctx.ui.confirm({ title: `Rembourser ${receipt.name} ?`, message: `${formatMoney(receipt.price)} reviennent sur votre solde de test et l'app est supprimée de cet appareil.`, confirmLabel: 'Rembourser', destructive: true }))) return;
      try {
        store.refund(receipt.appId);
        if (pm.isInstalled(receipt.appId)) await pm.uninstall(receipt.appId);
        ctx.ui.toast('Remboursement effectué');
      } catch (error) {
        ctx.ui.alert({ title: 'Remboursement impossible', message: error.message });
      }
    }
  }

  const TRANSACTION = { topup: 'Crédit de test', purchase: 'Achat', refund: 'Remboursement', fee: 'Inscription développeur', sale: 'Vente', chargeback: 'Vente remboursée' };

  function historyPage() {
    const content = h('div');
    const render = () => {
      const list = store.wallet().transactions.slice().reverse();
      fill(
        content,
        list.length
          ? listGroup({
              footer: 'Opérations sur votre solde de test (argent fictif).',
              items: list.map((t) => listItem({ title: t.label, subtitle: `${TRANSACTION[t.type] ?? t.type} · ${new Date(t.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`, detail: h(`span.store-amount${t.amount >= 0 ? '.plus' : ''}`, `${t.amount >= 0 ? '+' : '−'} ${formatMoney(Math.abs(t.amount))}`) })),
            })
          : emptyState({ icon: 'list', title: 'Aucune opération' }),
      );
    };
    const p = page({ title: 'Historique', large: false, back: { label: 'Compte', onClick: () => nav.pop() }, content });
    p.refresh = render;
    render();
    nav.push(p);
  }

  function renderAccount() {
    const account = ctx.kernel.account;
    const name = account?.name || ctx.kernel.settings.get('userName') || 'Moi';
    const wallet = store.wallet();
    const purchases = Object.values(wallet.purchases).sort((a, b) => b.at - a.at);
    const profile = store.developer();
    fill(
      accountContent,
      h('div.store-account', avatar(name, { size: 54, color: account?.color, photo: account?.photo }), h('div', h('strong', name), h('span', account?.email || 'Compte de cet appareil'))),
      h(
        'div.wallet-card',
        h('small', 'SOLDE DE TEST'),
        h('strong', formatMoney(wallet.balance)),
        h('p', 'Argent fictif pour essayer les achats : Orion n\'a pas encore de service de paiement, aucun moyen de paiement réel n\'est demandé.'),
        button('Ajouter des fonds de test', { variant: 'tinted', small: true, icon: 'plus', onClick: topUp }),
      ),
      listGroup({
        header: 'Achats',
        items: purchases.length
          ? purchases.map((r) => {
              const pkg = pm.get(r.appId);
              return listItem({
                leading: pkg ? appIcon(pkg, { size: 34 }) : h('div.store-missing', icon('store', { size: 18 })),
                title: r.name,
                subtitle: `${dateFormat(r.at)} · reçu ${r.id}`,
                detail: r.refunded ? 'Remboursé' : formatMoney(r.price),
                chevron: true,
                onClick: () => purchaseActions(r),
              });
            })
          : [h('div.list-item', h('div.li-body', h('div.li-sub', 'Aucun achat pour le moment.')))],
        footer: purchases.length ? 'Remboursement possible pendant 2 heures après l\'achat.' : null,
      }),
      listGroup({ items: [listItem({ icon: 'list', iconColor: '#8e8e93', title: 'Historique des opérations', chevron: true, onClick: historyPage })] }),
      listGroup({
        header: 'Développeurs',
        items: [
          listItem({
            icon: 'code',
            iconColor: '#5e5ce6',
            title: profile ? 'Console développeur' : 'Publier vos apps sur le Store',
            subtitle: profile ? profile.name : `Inscription ${formatMoney(DEVELOPER_FEE)} · commission ${Math.round(COMMISSION * 100)} %`,
            chevron: true,
            onClick: () => developer.open(),
          }),
        ],
      }),
    );
  }

  const developer = developerConsole({ ctx, nav, store, verify, topUp, openListing: (id) => detailPage(id) });

  // ───────────── Onglets ─────────────

  const pages = { today: [todayPage, renderToday], apps: [appsPage, renderApps], search: [searchPage, renderSearch], account: [accountPage, renderAccount] };
  const tabs = tabBar(
    [
      { id: 'today', label: "Aujourd'hui", icon: 'note-edit' },
      { id: 'apps', label: 'Apps', icon: 'layers' },
      { id: 'search', label: 'Rechercher', icon: 'search' },
      { id: 'account', label: 'Compte', icon: 'user-circle' },
    ],
    { value: tab, onChange: (id) => show(id) },
  );
  function show(id) {
    tab = id;
    tabs.select(id);
    const [p, render] = pages[id];
    nav.reset(p);
    render();
  }

  /** Après un changement (achat, publication, autre fenêtre) : la page affichée est redessinée. */
  function refresh() {
    refreshButtons();
    if (nav.depth === 1) pages[tab][1]();
    else nav.top?.refresh?.();
  }

  root.classList.add('with-tabbar', 'store');
  root.append(container, tabs);
  show('today');
  ctx.subscribe('package:install', refreshButtons);
  ctx.subscribe('package:uninstall', () => {
    refreshButtons();
    nav.top?.refresh?.();
  });
  ctx.subscribe('store:change', refresh);
  ctx.onBack(async () => (nav.depth > 1 ? nav.pop() : false));
  function onIntent(intent) {
    if (intent?.data?.page === 'developer') developer.open();
    else if (intent?.data?.app && pm.get(intent.data.app)) detailPage(intent.data.app);
  }
  onIntent(ctx.intent);
  return { onIntent };
}
