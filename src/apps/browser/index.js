/**
 * Navigateur : barre d'adresse (iOS, en bas), page d'accueil avec favoris,
 * historique, partage. Les pages s'affichent dans une iframe isolée ; les
 * sites qui refusent l'intégration peuvent être ouverts dans un onglet.
 */
import { h, render } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const FAVORITES = [
  { title: 'Wikipédia', url: 'https://fr.m.wikipedia.org/wiki/Wikip%C3%A9dia:Accueil_principal', color: '#636366', letter: 'W' },
  { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/export/embed.html?bbox=2.25,48.81,2.42,48.90&layer=mapnik', color: '#7ebc6f', letter: 'O' },
  { title: 'MDN', url: 'https://developer.mozilla.org/fr/', color: '#1b1b1b', letter: 'M' },
  { title: 'Wiktionnaire', url: 'https://fr.m.wiktionary.org/', color: '#3366cc', letter: 'W' },
  { title: 'Orion OS', url: 'about:orion', color: '#5e5ce6', letter: 'O' },
];

// Pages Web tierces (origine différente) : scripts autorisés, mais isolées de l'OS.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

function toUrl(input) {
  const text = input.trim();
  if (!text) return null;
  if (text === 'about:orion' || text === 'about:home') return text;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text) && !text.includes(' ')) return `https://${text}`;
  return `https://fr.m.wikipedia.org/w/index.php?search=${encodeURIComponent(text)}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\.|^fr\.m\.|^m\./, '');
  } catch {
    return url;
  }
}

export function mount(root, ctx) {
  const history = [];
  let position = -1;
  let visits = ctx.storage.get('visits', []);

  const frame = h('iframe.browser-frame', { sandbox: SANDBOX, referrerpolicy: 'no-referrer', title: 'Page web' });
  const home = h('div.browser-home');
  const progress = h('div.browser-progress');
  const hint = h('div.browser-hint');
  const content = h('div.browser-content', home, frame, progress, hint);

  const address = h('input.browser-address', { type: 'text', placeholder: 'Rechercher ou saisir une adresse', enterkeyhint: 'go', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const reloadBtn = h('button.browser-mini', { type: 'button', 'aria-label': 'Recharger', onclick: () => current() && load(current(), { push: false }) }, icon('refresh', { size: 16 }));
  const backBtn = h('button.browser-tool', { type: 'button', 'aria-label': 'Précédent', onclick: () => go(-1) }, icon('chevron-left', { size: 26 }));
  const forwardBtn = h('button.browser-tool', { type: 'button', 'aria-label': 'Suivant', onclick: () => go(1) }, icon('chevron-right', { size: 26 }));

  address.addEventListener('focus', () => {
    address.value = current() && current().startsWith('http') ? current() : '';
    requestAnimationFrame(() => address.select());
  });
  address.addEventListener('blur', () => renderAddress());
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = toUrl(address.value);
      address.blur();
      if (url) load(url);
    }
  });

  const current = () => history[position] ?? null;

  function renderAddress() {
    const url = current();
    if (document.activeElement === address) return;
    address.value = !url || url === 'about:home' ? '' : url === 'about:orion' ? 'Orion OS' : hostOf(url);
    backBtn.disabled = position <= 0;
    forwardBtn.disabled = position >= history.length - 1;
    reloadBtn.hidden = !url || url.startsWith('about:');
  }

  function renderHome() {
    render(home,
      h('h2', 'Favoris'),
      h(
        'div.browser-favs',
        FAVORITES.map((f) => h('button.browser-fav', { type: 'button', onclick: () => load(f.url) }, h('span', { style: { background: f.color } }, f.letter), f.title)),
      ),
      visits.length ? h('h2', 'Récemment consultés') : null,
      visits.length
        ? h(
            'div.list',
            visits.slice(0, 6).map((v) => h('div.list-item.tappable', { onclick: () => load(v.url) }, h('span.browser-globe', icon('globe', { size: 18 })), h('div.li-body', h('div.li-title', v.title || hostOf(v.url)), h('div.li-sub', v.url)))),
          )
        : null,
      h('p.browser-note', 'Astuce : certains sites interdisent leur affichage dans une autre application. Utilisez alors le bouton « Ouvrir dans un onglet ».'),
    );
  }

  function aboutPage() {
    const k = ctx.kernel;
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:28px 22px;color:#222;background:linear-gradient(180deg,#eef2ff,#fff)}h1{font-size:28px;margin:0 0 6px}p{color:#555}code{background:#eef;padding:2px 6px;border-radius:6px}li{margin:6px 0}</style>
<h1>${k.os.name} ${k.os.label}</h1><p>« ${k.os.codename} » — build <code>${k.os.build}</code></p>
<p>Un système d'exploitation mobile web, inspiré d'iOS et d'Android.</p>
<ul><li>Noyau JavaScript : processus, système de fichiers, paquets, intents</li><li>Notifications, alarmes, permissions, téléphonie simulée</li><li>${k.packages.list().length} applications installées</li><li>Stockage : ${k.backend}</li></ul>`;
  }

  let loadTimer = null;
  function load(url, { push = true } = {}) {
    if (push) {
      history.splice(position + 1);
      history.push(url);
      position = history.length - 1;
    }
    clearTimeout(loadTimer);
    hint.hidden = true;
    if (url === 'about:home') {
      frame.hidden = true;
      home.hidden = false;
      progress.className = 'browser-progress';
      renderHome();
    } else {
      home.hidden = true;
      frame.hidden = false;
      progress.className = 'browser-progress loading';
      if (url === 'about:orion') {
        frame.setAttribute('sandbox', '');
        frame.srcdoc = aboutPage();
      } else {
        frame.setAttribute('sandbox', SANDBOX);
        frame.removeAttribute('srcdoc');
        frame.src = url;
        visits = [{ url, title: hostOf(url) }, ...visits.filter((v) => v.url !== url)].slice(0, 20);
        ctx.storage.set('visits', visits);
      }
      loadTimer = setTimeout(() => {
        hint.hidden = false;
        hint.replaceChildren(h('span', 'La page reste vide ?'), h('button', { type: 'button', onclick: openExternal }, 'Ouvrir dans un onglet'));
      }, 6000);
    }
    renderAddress();
  }

  frame.addEventListener('load', () => {
    progress.className = 'browser-progress done';
    clearTimeout(loadTimer);
  });

  function go(delta) {
    const target = position + delta;
    if (target < 0 || target >= history.length) return;
    position = target;
    load(history[position], { push: false });
  }

  function openExternal() {
    const url = current();
    if (url?.startsWith('http')) window.open(url, '_blank', 'noopener');
  }

  const toolbar = h(
    'div.browser-toolbar',
    h('div.browser-bar', icon('search', { size: 15 }), address, reloadBtn),
    h(
      'div.browser-tools',
      backBtn,
      forwardBtn,
      h('button.browser-tool', { type: 'button', 'aria-label': 'Partager', onclick: () => current()?.startsWith('http') && ctx.ui.share({ type: 'text/plain', data: { text: current() } }) }, icon('share', { size: 22 })),
      h('button.browser-tool', { type: 'button', 'aria-label': 'Accueil', onclick: () => load('about:home') }, icon('book', { size: 22 })),
      h('button.browser-tool', { type: 'button', 'aria-label': 'Ouvrir dans un onglet', onclick: openExternal }, icon('tabs', { size: 22 })),
    ),
  );

  root.classList.add('browser');
  root.append(content, toolbar);

  function handleIntent(intent) {
    const data = intent?.data;
    if (data?.url) load(data.url);
    else if (data?.query) load(toUrl(data.query));
    else if (data?.text && /^https?:/.test(data.text)) load(data.text);
    else if (!current()) load('about:home');
  }
  handleIntent(ctx.intent);
  ctx.onBack(() => {
    if (position > 0) {
      go(-1);
      return true;
    }
    return false;
  });
  return { onIntent: handleIntent };
}
