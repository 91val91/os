/**
 * Photos : photothèque (grille par mois), albums, visionneuse avec
 * balayage, zoom, favoris, partage. Répond aux intents « view » et « pick ».
 */
import { h, render } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { drag } from '../../lib/gesture.js';
import { formatDate, formatBytes } from '../../lib/format.js';
import { navStack, page, tabBar, iconButton, emptyState } from '../../lib/ui.js';

export const styles = [new URL('./style.css', import.meta.url).href];

export function mount(root, ctx) {
  const fs = ctx.fs;
  const favorites = new Set(ctx.storage.get('favorites', []));
  const container = h('div.photos-views');
  const nav = navStack(container);
  let tab = 'library';
  const picking = () => ctx.intent?.action === 'pick';

  const saveFavorites = () => ctx.storage.set('favorites', [...favorites].filter((p) => fs.exists(p)));

  function allPhotos() {
    const out = [];
    for (const entry of fs.walk('/home')) {
      if (entry.type === 'file' && entry.mime?.startsWith('image/')) out.push(entry);
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  // ───────────── Grilles ─────────────
  function grid(photos, { groupByMonth = false } = {}) {
    if (!photos.length) return emptyState({ icon: 'image', title: 'Aucune photo', message: "Les photos prises avec l'Appareil photo apparaîtront ici." });
    const tile = (p, i) =>
      h(
        'button.photo-tile',
        { type: 'button', style: { backgroundImage: `url("${fs.readFile(p.path)}")` }, 'aria-label': p.name, onclick: () => (picking() ? ctx.finish({ path: p.path }) : viewer(photos, i)) },
        favorites.has(p.path) ? h('span.photo-fav', icon('heart-fill', { size: 14 })) : null,
      );
    if (!groupByMonth) return h('div.photo-grid', photos.map(tile));
    const sections = [];
    let current = null;
    photos.forEach((p, i) => {
      const key = formatDate(p.mtime, { month: 'long', year: 'numeric' });
      if (key !== current?.key) {
        current = { key, grid: h('div.photo-grid') };
        sections.push(h('h3.photo-month', key), current.grid);
      }
      current.grid.append(tile(p, i));
    });
    return h('div', sections);
  }

  const libraryContent = h('div');
  const libraryPage = page({
    title: 'Photothèque',
    actions: [iconButton('camera', () => ctx.startActivity({ app: 'camera', action: 'main' }), { label: 'Appareil photo' })],
    content: libraryContent,
    className: 'photos-page',
  });
  const albumsContent = h('div');
  const albumsPage = page({ title: 'Albums', content: albumsContent, className: 'photos-page' });

  function renderLibrary() {
    const photos = allPhotos();
    libraryPage.bar.setTitle(picking() ? 'Choisir une photo' : 'Photothèque');
    render(libraryContent, grid(photos, { groupByMonth: !picking() }), photos.length ? h('div.photo-count', `${photos.length} photo${photos.length > 1 ? 's' : ''}`) : null);
  }

  function renderAlbums() {
    const photos = allPhotos();
    const albums = [
      { title: 'Récents', items: photos },
      { title: 'Favoris', items: photos.filter((p) => favorites.has(p.path)) },
      { title: 'Appareil photo', items: photos.filter((p) => p.name.startsWith('IMG_')) },
      { title: 'Dessins', items: photos.filter((p) => p.name.startsWith('Dessin')) },
    ];
    albumsContent.replaceChildren(
      h(
        'div.album-grid',
        albums.map((a) =>
          h(
            'button.album',
            { type: 'button', onclick: () => albumPage(a.title, () => albums.find((x) => x.title === a.title).items) },
            h('div.album-cover', a.items[0] ? { style: { backgroundImage: `url("${fs.readFile(a.items[0].path)}")` } } : null, a.items[0] ? null : icon('image', { size: 30 })),
            h('strong', a.title),
            h('span', String(a.items.length)),
          ),
        ),
      ),
    );
  }

  function albumPage(title) {
    const content = h('div');
    const render = () => {
      const photos = allPhotos();
      const items = title === 'Favoris' ? photos.filter((p) => favorites.has(p.path)) : title === 'Appareil photo' ? photos.filter((p) => p.name.startsWith('IMG_')) : title === 'Dessins' ? photos.filter((p) => p.name.startsWith('Dessin')) : photos;
      content.replaceChildren(grid(items));
    };
    const p = page({ title, back: { label: 'Albums', onClick: () => nav.pop() }, content, className: 'photos-page' });
    p.onShow = render;
    render();
    nav.push(p);
  }

  // ───────────── Visionneuse ─────────────
  function viewer(photos, index) {
    let i = index;
    let zoom = 1;
    let chrome = true;
    const img = h('img.viewer-img', { alt: '' });
    const stage = h('div.viewer-stage', img);
    const title = h('div.viewer-title');
    const favBtn = h('button.viewer-btn', { type: 'button', 'aria-label': 'Favori', onclick: toggleFavorite });
    const top = h('div.viewer-top', h('button.viewer-back', { type: 'button', onclick: () => close() }, icon('chevron-left', { size: 26 }), 'Retour'), title, h('span'));
    const bottom = h(
      'div.viewer-bottom',
      h('button.viewer-btn', { type: 'button', 'aria-label': 'Partager', onclick: share }, icon('share', { size: 22 })),
      favBtn,
      h('button.viewer-btn', { type: 'button', 'aria-label': 'Infos', onclick: info }, icon('info', { size: 22 })),
      h('button.viewer-btn', { type: 'button', 'aria-label': 'Fond d\'écran', onclick: setWallpaper }, icon('image', { size: 22 })),
      h('button.viewer-btn', { type: 'button', 'aria-label': 'Supprimer', onclick: remove }, icon('trash', { size: 22 })),
    );
    const el = h('div.viewer', stage, top, bottom);
    root.append(el);
    ctx.ui.setStatusBar('light');

    const show = () => {
      const p = photos[i];
      if (!p) return close();
      img.src = fs.readFile(p.path);
      title.replaceChildren(h('strong', formatDate(p.mtime, { day: 'numeric', month: 'long', year: 'numeric' })), h('span', new Date(p.mtime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })));
      favBtn.replaceChildren(icon(favorites.has(p.path) ? 'heart-fill' : 'heart', { size: 22 }));
      favBtn.classList.toggle('active', favorites.has(p.path));
      zoom = 1;
      img.style.transform = '';
    };

    function toggleFavorite() {
      const p = photos[i].path;
      if (favorites.has(p)) favorites.delete(p);
      else favorites.add(p);
      saveFavorites();
      show();
    }

    function share() {
      const p = photos[i];
      ctx.ui.share({ type: p.mime, data: { image: fs.readFile(p.path), path: p.path } });
    }

    function info() {
      const p = photos[i];
      ctx.ui.alert({ title: p.name, message: `${formatDate(p.mtime, { dateStyle: 'full' })}\n${formatBytes(p.size)} · ${p.mime}\n${p.path}` });
    }

    async function setWallpaper() {
      ctx.settings.set?.('wallpaper', photos[i].path);
      ctx.ui.toast("Défini comme fond d'écran");
    }

    async function remove() {
      const p = photos[i];
      if (!(await ctx.ui.confirm({ title: 'Supprimer cette photo ?', confirmLabel: 'Supprimer la photo', destructive: true }))) return;
      fs.rm(p.path);
      favorites.delete(p.path);
      saveFavorites();
      photos.splice(i, 1);
      if (!photos.length) return close();
      i = Math.min(i, photos.length - 1);
      show();
    }

    function close() {
      el.remove();
      ctx.ui.setStatusBar('auto');
      viewerClose = null;
      renderLibrary();
      renderAlbums();
    }

    let lastTap = 0;
    stage.addEventListener('click', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        zoom = zoom > 1 ? 1 : 2.4;
        const rect = img.getBoundingClientRect();
        const ox = ((e.clientX - rect.left) / rect.width) * 100;
        const oy = ((e.clientY - rect.top) / rect.height) * 100;
        img.style.transformOrigin = `${ox}% ${oy}%`;
        img.style.transform = zoom > 1 ? `scale(${zoom})` : '';
      } else {
        setTimeout(() => {
          if (Date.now() - lastTap >= 300) {
            chrome = !chrome;
            el.classList.toggle('immersive', !chrome);
          }
        }, 310);
      }
      lastTap = now;
    });

    drag(stage, {
      filter: () => zoom === 1,
      onMove: ({ dx, dy, axis }) => {
        if (axis === 'x') img.style.transform = `translateX(${dx}px)`;
        else if (dy > 0) {
          img.style.transform = `translateY(${dy}px) scale(${1 - Math.min(dy, 300) / 1000})`;
          el.style.background = `rgba(0,0,0,${1 - Math.min(dy, 300) / 400})`;
        }
      },
      onEnd: ({ dx, dy, vx, axis }) => {
        img.style.transition = 'transform .25s';
        setTimeout(() => (img.style.transition = ''), 260);
        el.style.background = '';
        if (axis === 'x' && (dx < -80 || vx < -0.5) && i < photos.length - 1) {
          i++;
          show();
        } else if (axis === 'x' && (dx > 80 || vx > 0.5) && i > 0) {
          i--;
          show();
        } else if (axis === 'y' && dy > 120) {
          close();
        } else img.style.transform = '';
      },
    });

    viewerClose = close;
    show();
  }

  let viewerClose = null;

  // ───────────── Onglets ─────────────
  const tabs = tabBar(
    [
      { id: 'library', label: 'Photothèque', icon: 'photos' },
      { id: 'albums', label: 'Albums', icon: 'layers' },
    ],
    { value: tab, onChange: (id) => show(id) },
  );

  function show(id) {
    tab = id;
    tabs.select(id);
    nav.reset(id === 'library' ? libraryPage : albumsPage);
    if (id === 'library') renderLibrary();
    else renderAlbums();
  }

  root.classList.add('with-tabbar', 'photos');
  root.append(container, tabs);

  function handleIntent(intent) {
    if (picking()) {
      tabs.hidden = true;
      const cancel = h('button.appbar-text', { type: 'button', onclick: () => ctx.finish(null) }, 'Annuler');
      libraryPage.bar.querySelector('.appbar-actions').replaceChildren(cancel);
      show('library');
      return;
    }
    show(tab);
    if (intent?.action === 'view' && intent.data?.path) {
      const photos = allPhotos();
      let index = photos.findIndex((p) => p.path === intent.data.path);
      if (index < 0 && fs.exists(intent.data.path)) {
        photos.unshift(fs.stat(intent.data.path));
        index = 0;
      }
      if (index >= 0) viewer(photos, index);
    }
  }

  handleIntent(ctx.intent);
  ctx.subscribe('fs:change', ({ path }) => {
    if (!path.startsWith('/home') || viewerClose) return;
    if (tab === 'library') renderLibrary();
    else if (nav.depth > 1) nav.top.onShow?.();
    else renderAlbums();
  });
  ctx.onBack(async () => {
    if (viewerClose) {
      viewerClose();
      return true;
    }
    if (nav.depth > 1) return nav.pop();
    if (picking()) {
      ctx.finish(null);
      return true;
    }
    return false;
  });

  return {
    onIntent: (intent) => {
      viewerClose?.();
      handleIntent(intent);
    },
  };
}
