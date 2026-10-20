/**
 * Fichiers : explorateur du système de fichiers virtuel (import, export,
 * renommage, déplacement, suppression, ouverture via les intents).
 */
import { h } from '../../lib/dom.js';
import { longPress } from '../../lib/gesture.js';
import { formatBytes, relativeTime } from '../../lib/format.js';
import { navStack, page, listGroup, listItem, iconTile, iconButton, emptyState } from '../../lib/ui.js';
import { basename, dirname, isTextMime, mimeFromName } from '../../kernel/vfs.js';
import { USER_DIRS } from '../../kernel/seed.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const ROOT_LABELS = { '/': 'Racine', '/home': 'Mon téléphone', '/data': 'Données des apps', '/system': 'Système', '/tmp': 'Temporaire' };
const DIR_ICONS = { Documents: ['file-text', '#5b8def'], Photos: ['image', '#f2437b'], Music: ['music', '#ff4d6d'], Downloads: ['download', '#34c759'], Recordings: ['mic', '#ff9500'] };

function labelFor(path) {
  if (ROOT_LABELS[path]) return ROOT_LABELS[path];
  if (dirname(path) === '/home' && USER_DIRS[basename(path)]) return USER_DIRS[basename(path)];
  return basename(path);
}

function fileIcon(entry) {
  if (entry.type === 'dir') return DIR_ICONS[entry.name] && dirname(entry.path) === '/home' ? DIR_ICONS[entry.name] : ['folder-fill', '#4dabf7'];
  const mime = entry.mime ?? '';
  if (mime.startsWith('image/')) return ['image', '#f2437b'];
  if (mime.startsWith('audio/')) return ['music', '#ff4d6d'];
  if (mime.startsWith('video/')) return ['video', '#af52de'];
  if (mime.includes('json') || mime.includes('javascript') || mime.includes('x-sh')) return ['code', '#30b0c7'];
  if (isTextMime(mime)) return ['file-text', '#8e8e93'];
  return ['file', '#8e8e93'];
}

export function mount(root, ctx) {
  const fs = ctx.fs;
  const nav = navStack(root);
  let showHidden = ctx.storage.get('showHidden', false);
  const picker = h('input', { type: 'file', multiple: true, hidden: true });
  root.append(picker);

  function usageBar() {
    const used = fs.du('/home');
    const parts = Object.keys(USER_DIRS).map((dir) => ({ dir, size: fs.du(`/home/${dir}`), color: DIR_ICONS[dir][1] }));
    const total = Math.max(used, 1);
    return h(
      'div.files-usage',
      h('div.files-usage-head', h('strong', 'Stockage'), h('span', `${formatBytes(used)} utilisés`)),
      h('div.files-bar', parts.map((p) => h('span', { style: { width: `${(p.size / total) * 100}%`, background: p.color } }))),
      h('div.files-legend', parts.filter((p) => p.size).map((p) => h('span', h('i', { style: { background: p.color } }), `${USER_DIRS[p.dir]}`))),
    );
  }

  function browsePage() {
    const content = h('div');
    const render = () => {
      content.replaceChildren(
        usageBar(),
        listGroup({
          header: 'Sur mon téléphone',
          items: Object.keys(USER_DIRS).map((dir) => {
            const path = `/home/${dir}`;
            const [name, color] = DIR_ICONS[dir];
            const count = fs.exists(path) ? fs.readdir(path, { hidden: false }).length : 0;
            return listItem({ leading: iconTile(name, color), title: USER_DIRS[dir], detail: String(count), chevron: true, onClick: () => openDir(path) });
          }),
        }),
        listGroup({
          header: 'Emplacements',
          items: [
            listItem({ leading: iconTile('home', '#5856d6'), title: 'Dossier personnel', subtitle: '/home', chevron: true, onClick: () => openDir('/home') }),
            listItem({ leading: iconTile('storage', '#636366'), title: 'Racine du système', subtitle: '/', chevron: true, onClick: () => openDir('/') }),
          ],
        }),
        listGroup({
          header: 'Récents',
          items: recentFiles().map((f) => entryRow(f, () => render())),
        }),
      );
    };
    const p = page({ title: 'Parcourir', content });
    p.onShow = render;
    render();
    return p;
  }

  function recentFiles() {
    return [...fs.walk('/home')]
      .filter((e) => e.type === 'file' && !e.name.startsWith('.'))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
  }

  function entryRow(entry, refresh) {
    const [name, color] = fileIcon(entry);
    const thumb = entry.mime?.startsWith('image/') ? h('div.files-thumb', { style: { backgroundImage: `url("${fs.readFile(entry.path)}")` } }) : iconTile(name, color, 18);
    const row = listItem({
      leading: thumb,
      title: entry.name,
      subtitle: `${relativeTime(entry.mtime, ctx.now())} · ${entry.type === 'dir' ? `${fs.readdir(entry.path).length} élément(s)` : formatBytes(entry.size)}`,
      chevron: entry.type === 'dir',
      onClick: () => (entry.type === 'dir' ? openDir(entry.path) : openFile(entry)),
    });
    longPress(row, () => actions(entry, refresh));
    return row;
  }

  function openDir(path) {
    const content = h('div');
    const render = () => {
      if (!fs.exists(path)) return;
      const entries = fs.readdir(path, { hidden: showHidden });
      const readonly = fs.stat(path).readonly;
      content.replaceChildren(
        h('div.files-path', path),
        entries.length
          ? h('div.list', entries.map((e) => entryRow(e, render)))
          : emptyState({ icon: 'folder', title: 'Dossier vide', message: readonly ? 'Ce dossier est en lecture seule.' : 'Importez des fichiers ou créez un dossier.' }),
        h('div.files-footer', `${entries.length} élément(s) · ${formatBytes(fs.du(path))}`),
      );
    };
    const p = page({
      title: labelFor(path),
      large: true,
      back: { label: nav.depth === 1 ? 'Parcourir' : labelFor(dirname(path)), onClick: () => nav.pop() },
      actions: [iconButton('more', () => dirMenu(path, render), { label: 'Plus' })],
      content,
    });
    p.onShow = render;
    p.path = path;
    render();
    nav.push(p);
  }

  async function dirMenu(path, refresh) {
    const readonly = fs.stat(path).readonly;
    const choice = await ctx.ui.actionSheet({
      title: labelFor(path),
      actions: [
        { label: 'Nouveau dossier', value: 'mkdir', icon: 'folder-plus', disabled: readonly },
        { label: 'Nouveau fichier texte', value: 'touch', icon: 'file-plus', disabled: readonly },
        { label: 'Importer des fichiers', value: 'import', icon: 'upload', disabled: readonly },
        { label: showHidden ? 'Masquer les fichiers cachés' : 'Afficher les fichiers cachés', value: 'hidden', icon: 'eye' },
      ],
    });
    try {
      if (choice === 'mkdir') {
        const name = await ctx.ui.prompt({ title: 'Nouveau dossier', placeholder: 'Nom du dossier', value: 'Nouveau dossier' });
        if (name?.trim()) fs.mkdir(fs.uniquePath(`${path}/${name.trim()}`));
      } else if (choice === 'touch') {
        const name = await ctx.ui.prompt({ title: 'Nouveau fichier', placeholder: 'nom.txt', value: 'sans titre.txt' });
        if (name?.trim()) {
          const file = fs.uniquePath(`${path}/${name.trim()}`);
          fs.writeFile(file, '');
          openFile(fs.stat(file));
        }
      } else if (choice === 'import') {
        importInto(path, refresh);
        return;
      } else if (choice === 'hidden') {
        showHidden = !showHidden;
        ctx.storage.set('showHidden', showHidden);
      }
    } catch (error) {
      ctx.ui.toast(error.message);
    }
    refresh();
  }

  function importInto(path, refresh) {
    picker.value = '';
    picker.onchange = async () => {
      let imported = 0;
      for (const file of picker.files) {
        const mime = file.type || mimeFromName(file.name);
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          if (isTextMime(mime)) reader.readAsText(file);
          else reader.readAsDataURL(file);
        });
        fs.writeFile(fs.uniquePath(`${path}/${file.name}`), content, { mime });
        imported++;
      }
      ctx.ui.toast(`${imported} fichier(s) importé(s)`);
      refresh();
    };
    picker.click();
  }

  async function openFile(entry) {
    const mime = entry.mime ?? mimeFromName(entry.name);
    try {
      await ctx.startActivity({ action: 'view', type: isTextMime(mime) ? 'text/plain' : mime, data: { path: entry.path } });
    } catch {
      const choice = await ctx.ui.alert({
        title: entry.name,
        message: `Aucune application ne peut ouvrir ce type de fichier (${mime}).`,
        buttons: [
          { label: 'Exporter', value: 'export' },
          { label: 'OK', value: null, role: 'cancel' },
        ],
      });
      if (choice === 'export') exportFile(entry);
    }
  }

  function exportFile(entry) {
    const content = fs.readFile(entry.path);
    const href = content.startsWith('data:') ? content : URL.createObjectURL(new Blob([content], { type: entry.mime }));
    const a = h('a', { href, download: entry.name });
    document.body.append(a);
    a.click();
    a.remove();
    if (!content.startsWith('data:')) setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  async function actions(entry, refresh) {
    ctx.ui.vibrate(12);
    const readonly = entry.readonly;
    const choice = await ctx.ui.actionSheet({
      title: entry.name,
      message: entry.path,
      actions: [
        { label: 'Ouvrir', value: 'open', icon: 'arrow-right' },
        { label: 'Renommer', value: 'rename', icon: 'edit', disabled: readonly },
        { label: 'Dupliquer', value: 'copy', icon: 'copy', disabled: readonly },
        { label: 'Déplacer…', value: 'move', icon: 'folder', disabled: readonly },
        entry.type === 'file' ? { label: 'Partager', value: 'share', icon: 'share' } : null,
        entry.type === 'file' ? { label: "Exporter vers l'appareil", value: 'export', icon: 'download' } : null,
        { label: 'Supprimer', value: 'delete', icon: 'trash', destructive: true, disabled: readonly },
      ].filter(Boolean),
    });
    try {
      switch (choice) {
        case 'open':
          entry.type === 'dir' ? openDir(entry.path) : openFile(entry);
          break;
        case 'rename': {
          const name = await ctx.ui.prompt({ title: 'Renommer', value: entry.name });
          if (name?.trim() && name.trim() !== entry.name) fs.rename(entry.path, `${dirname(entry.path)}/${name.trim()}`);
          break;
        }
        case 'copy':
          fs.copy(entry.path, fs.uniquePath(entry.path));
          break;
        case 'move': {
          const target = await ctx.ui.prompt({ title: 'Déplacer vers', message: 'Chemin du dossier de destination', value: dirname(entry.path) });
          if (target?.trim()) fs.rename(entry.path, target.trim());
          break;
        }
        case 'share': {
          const content = fs.readFile(entry.path);
          if (entry.mime?.startsWith('image/')) await ctx.ui.share({ type: entry.mime, data: { image: content, path: entry.path } });
          else await ctx.ui.share({ type: 'text/plain', data: { text: isTextMime(entry.mime) ? content : entry.path } });
          break;
        }
        case 'export':
          exportFile(entry);
          break;
        case 'delete':
          if (await ctx.ui.confirm({ title: `Supprimer « ${entry.name} » ?`, message: 'Cette action est irréversible.', confirmLabel: 'Supprimer', destructive: true })) {
            fs.rm(entry.path, { recursive: true });
          }
          break;
        default:
          return;
      }
    } catch (error) {
      ctx.ui.toast(error.message);
    }
    refresh();
  }

  nav.push(browsePage());
  const handle = (intent) => {
    const path = intent?.data?.path;
    if (path && fs.isDir(path)) openDir(path);
  };
  handle(ctx.intent);
  ctx.onBack(async () => (nav.depth > 1 ? nav.pop() : false));
  ctx.subscribe('fs:change', () => nav.top?.onShow?.());
  return {
    onIntent: (intent) => handle(intent),
  };
}
