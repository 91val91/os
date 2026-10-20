/**
 * Store : catalogue des applications, installation (téléchargement simulé)
 * et désinstallation via le gestionnaire de paquets du noyau.
 */
import { h, render as fill } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { navStack, page, tabBar, searchField, listGroup, emptyState } from '../../lib/ui.js';
import { appIcon } from '../../system/app-icon.js';
import { PERMISSIONS } from '../../kernel/permissions.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const STARS = { game2048: 4.8, snake: 4.6, paint: 4.7, recorder: 4.5 };

export function mount(root, ctx) {
  const pm = ctx.kernel.packages;
  const downloads = new Map(); // id → progression 0..1
  const container = h('div.store-views');
  const nav = navStack(container);
  let tab = 'today';
  let query = '';

  const catalog = () => pm.list({ installed: null });
  const optional = () => catalog().filter((p) => !p.system);

  // ───────────── Bouton Obtenir / Ouvrir ─────────────
  function getButton(pkg) {
    const btn = h('button.get-btn', { type: 'button', onclick: (e) => { e.stopPropagation(); act(pkg); } });
    btn.dataset.app = pkg.id;
    renderButton(btn, pkg);
    return btn;
  }

  function renderButton(btn, pkg) {
    const progress = downloads.get(pkg.id);
    if (progress != null) {
      btn.className = 'get-btn downloading';
      btn.style.setProperty('--p', String(progress));
      btn.replaceChildren(h('span.ring'), h('span.stop'));
      btn.setAttribute('aria-label', 'Téléchargement en cours');
    } else if (pm.isInstalled(pkg.id)) {
      btn.className = 'get-btn';
      btn.textContent = 'OUVRIR';
    } else {
      btn.className = 'get-btn';
      btn.textContent = 'OBTENIR';
    }
  }

  function refreshButtons() {
    for (const btn of root.querySelectorAll('.get-btn')) renderButton(btn, pm.get(btn.dataset.app));
  }

  function act(pkg) {
    if (downloads.has(pkg.id)) return;
    if (pm.isInstalled(pkg.id)) {
      ctx.startActivity({ app: pkg.id, action: 'main' });
      return;
    }
    if (!ctx.kernel.device.connectivity.online) {
      ctx.ui.alert({ title: 'Pas de connexion', message: 'Connectez-vous à Internet pour télécharger des applications.' });
      return;
    }
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
        await pm.install(pkg.id);
        ctx.ui.vibrate(20);
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
      h('div.li-body', h('div.li-title', pkg.name), h('div.li-sub', pkg.description || pkg.category), h('div.li-sub.store-cat', pkg.category)),
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
    todayContent.replaceChildren(
      h('div.store-date', date),
      feature('game2048', 'LE JEU DU JOUR', 'Fusionnez jusqu\'à 2048', 'Un casse-tête minimaliste pour aiguiser votre logique en quelques minutes.', 'linear-gradient(150deg, #f7b733, #fc4a1a)'),
      feature('paint', 'CRÉATIVITÉ', 'Votre écran est une toile', 'Dessinez du bout des doigts et enregistrez vos œuvres dans Photos.', 'linear-gradient(150deg, #a855f7, #ec4899)'),
      listGroup({ header: 'À découvrir', items: optional().map(appRow) }),
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
  const searchPage = page({ title: 'Rechercher', content: [searchField({ placeholder: 'Jeux, apps et plus encore', onInput: (v) => { query = v.trim().toLowerCase(); renderSearch(); } }), searchContent] });
  function renderSearch() {
    const results = query ? catalog().filter((p) => `${p.name} ${p.category} ${p.description}`.toLowerCase().includes(query)) : [];
    searchContent.replaceChildren(
      query
        ? results.length
          ? h('div.list.store-results', results.map(appRow))
          : emptyState({ icon: 'search', title: 'Aucun résultat', message: `Rien ne correspond à « ${query} ».` })
        : h('div.store-suggestions', h('div.list-header', 'Suggestions'), ...['jeux', 'dessin', 'audio', 'utilitaires'].map((s) => h('button.chip', { type: 'button', onclick: () => { searchPage.querySelector('input').value = s; query = s; renderSearch(); } }, s))),
    );
  }

  function detailPage(id) {
    const content = h('div');
    const render = () => {
      const pkg = pm.get(id);
      const installed = pm.isInstalled(id);
      const stars = STARS[id] ?? 4.4;
      fill(
        content,
        h('div.store-detail-head', appIcon(pkg, { size: 110 }), h('div', h('h2', pkg.name), h('p', pkg.category), getButton(pkg))),
        h(
          'div.store-stats',
          h('div', h('small', 'NOTES'), h('strong', String(stars).replace('.', ',')), h('span', '★'.repeat(Math.round(stars)))),
          h('div', h('small', 'ÂGE'), h('strong', '4+'), h('span', 'ans')),
          h('div', h('small', 'TAILLE'), h('strong', String(pkg.size).replace('.', ',')), h('span', 'Mo')),
          h('div', h('small', 'VERSION'), h('strong', pkg.version), h('span', pkg.system ? 'Système' : 'Store')),
        ),
        h('div.store-shots', [0, 1, 2].map((i) => h('div.store-shot', { style: { background: `linear-gradient(${160 + i * 40}deg, ${pkg.color[0]}, ${pkg.color[1]})` } }, appIcon(pkg, { size: 54 + i * 6 })))),
        h('p.store-description', pkg.description),
        listGroup({
          header: 'Informations',
          items: [
            h('div.list-item', h('div.li-body', h('div.li-title', 'Développeur')), h('div.li-detail', 'Orion Labs')),
            h('div.list-item', h('div.li-body', h('div.li-title', 'Catégorie')), h('div.li-detail', pkg.category)),
            h('div.list-item', h('div.li-body', h('div.li-title', 'Autorisations')), h('div.li-detail', pkg.permissions.map((p) => PERMISSIONS[p]?.label ?? p).join(', ') || 'Aucune')),
            h('div.list-item', h('div.li-body', h('div.li-title', 'Confidentialité')), h('div.li-detail', 'Aucune donnée collectée')),
          ],
        }),
        installed && !pkg.system
          ? h('button.btn.btn-gray.block.destructive', { type: 'button', onclick: async () => {
              if (await ctx.ui.confirm({ title: `Supprimer ${pkg.name} ?`, message: 'Ses données seront également supprimées.', confirmLabel: 'Supprimer', destructive: true })) {
                await pm.uninstall(id);
                render();
              }
            } }, icon('trash', { size: 18 }), "Supprimer l'app")
          : null,
      );
    };
    const p = page({ title: '', large: false, back: { label: 'Retour', onClick: () => nav.pop() }, content });
    p.onShow = render;
    render();
    nav.push(p);
  }

  // ───────────── Onglets ─────────────
  const pages = { today: [todayPage, renderToday], apps: [appsPage, renderApps], search: [searchPage, renderSearch] };
  const tabs = tabBar(
    [
      { id: 'today', label: "Aujourd'hui", icon: 'note-edit' },
      { id: 'apps', label: 'Apps', icon: 'layers' },
      { id: 'search', label: 'Rechercher', icon: 'search' },
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

  root.classList.add('with-tabbar', 'store');
  root.append(container, tabs);
  show('today');
  ctx.subscribe('package:install', refreshButtons);
  ctx.subscribe('package:uninstall', () => {
    refreshButtons();
    nav.top?.onShow?.();
  });
  ctx.onBack(async () => (nav.depth > 1 ? nav.pop() : false));
}
