/**
 * Notes : notes texte enregistrées dans /home/Documents/Notes (visibles
 * dans Fichiers et le Terminal). Recherche, épinglage, partage.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { relativeTime } from '../../lib/format.js';
import { iconButton, searchField, emptyState, swipeToDelete, navStack, page, listItem } from '../../lib/ui.js';
import { basename, dirname } from '../../kernel/vfs.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const DIR = '/home/Documents/Notes';

function titleOf(text) {
  return text.split('\n').find((l) => l.trim())?.trim().slice(0, 80) || 'Nouvelle note';
}

function previewOf(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(1).join(' ').slice(0, 90) || 'Aucun texte supplémentaire';
}

export function mount(root, ctx) {
  const fs = ctx.fs;
  if (!fs.exists(DIR)) fs.mkdir(DIR, { recursive: true });
  const pinned = new Set(ctx.storage.get('pinned', []));
  const nav = navStack(root);
  let query = '';
  let editor = null;

  const savePinned = () => ctx.storage.set('pinned', [...pinned]);

  function notes() {
    return fs
      .readdir(DIR)
      .filter((e) => e.type === 'file')
      .map((e) => ({ ...e, text: fs.readFile(e.path) }))
      .filter((n) => !query || n.text.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => (pinned.has(b.path) - pinned.has(a.path)) || b.mtime - a.mtime);
  }

  // ───────────── Liste ─────────────
  const count = h('div.notes-count');
  const listPage = page({
    title: 'Notes',
    content: [h('div.notes-search', searchField({ onInput: (v) => { query = v; renderList(); } })), h('div.notes-list')],
  });
  const footer = h('div.notes-toolbar', count, iconButton('note-edit', () => openEditor(null), { label: 'Nouvelle note', size: 24 }));
  listPage.append(footer);

  function renderList() {
    const list = listPage.querySelector('.notes-list');
    const all = notes();
    count.textContent = `${all.length} note${all.length > 1 ? 's' : ''}`;
    if (!all.length) {
      list.replaceChildren(emptyState({ icon: 'notes', title: query ? 'Aucun résultat' : 'Aucune note', message: query ? '' : 'Touchez le crayon pour écrire votre première note.' }));
      return;
    }
    const groups = [
      { title: 'Épinglées', items: all.filter((n) => pinned.has(n.path)) },
      { title: 'Notes', items: all.filter((n) => !pinned.has(n.path)) },
    ].filter((g) => g.items.length);
    list.replaceChildren(
      ...groups.map((g) =>
        h(
          'section.list-group',
          groups.length > 1 ? h('div.list-header', g.title) : null,
          h(
            'div.list',
            g.items.map((n) => {
              const row = listItem({
                title: titleOf(n.text),
                subtitle: h('span', h('strong', relativeTime(n.mtime, ctx.now())), '  ', previewOf(n.text)),
                trailing: pinned.has(n.path) ? h('span.note-pin', icon('pin-fill', { size: 14 })) : null,
                onClick: () => openEditor(n.path),
              });
              return swipeToDelete(row, () => {
                fs.rm(n.path, { force: true });
                pinned.delete(n.path);
                savePinned();
                renderList();
              });
            }),
          ),
        ),
      ),
    );
  }

  // ───────────── Éditeur ─────────────
  function openEditor(path, initialText = '') {
    let current = path;
    const isNote = !path || dirname(path) === DIR;
    const textarea = h('textarea.note-editor', { placeholder: 'Écrivez quelque chose…', spellcheck: true });
    textarea.value = path ? fs.readFile(path) : initialText;
    const status = h('div.note-status');
    let timer = null;

    const save = () => {
      clearTimeout(timer);
      const text = textarea.value;
      if (!current) {
        if (!text.trim()) return;
        current = fs.uniquePath(`${DIR}/note-${ctx.now()}.txt`);
      }
      fs.writeFile(current, text, { parents: true });
      status.textContent = 'Enregistré';
    };
    textarea.addEventListener('input', () => {
      status.textContent = '';
      clearTimeout(timer);
      timer = setTimeout(save, 400);
    });

    const pinBtn = iconButton(pinned.has(path) ? 'pin-fill' : 'pin', () => {
      save();
      if (!current) return;
      if (pinned.has(current)) pinned.delete(current);
      else pinned.add(current);
      savePinned();
      pinBtn.replaceChildren(icon(pinned.has(current) ? 'pin-fill' : 'pin', { size: 22 }));
    }, { label: 'Épingler' });

    const editorPage = page({
      title: path && !isNote ? basename(path) : '',
      large: false,
      back: { label: isNote ? 'Notes' : 'Retour', onClick: () => back() },
      actions: [
        isNote ? pinBtn : null,
        iconButton('share', () => {
          save();
          if (textarea.value.trim()) ctx.ui.share({ type: 'text/plain', data: { text: textarea.value } });
        }, { label: 'Partager' }),
        iconButton('trash', async () => {
          if (current && !(await ctx.ui.confirm({ title: 'Supprimer cette note ?', confirmLabel: 'Supprimer', destructive: true }))) return;
          clearTimeout(timer);
          if (current) fs.rm(current, { force: true });
          current = null;
          textarea.value = '';
          back();
        }, { label: 'Supprimer' }),
      ],
      content: [status, textarea],
      className: 'note-page',
    });
    editorPage.onPop = () => {
      save();
      if (current && !fs.readFile(current).trim()) fs.rm(current, { force: true });
      editor = null;
      renderList();
    };
    editor = { save };
    nav.push(editorPage);
    if (!path) setTimeout(() => textarea.focus(), 400);
  }

  async function back() {
    if (nav.depth > 1) {
      await nav.pop();
      return true;
    }
    return false;
  }

  function handleIntent(intent) {
    if (!intent) return;
    if (intent.action === 'view' && intent.data?.path) openEditor(intent.data.path);
    else if (intent.action === 'view' && intent.data?.create) openEditor(null);
    else if (intent.action === 'send') openEditor(null, intent.data?.text ?? '');
  }

  nav.push(listPage);
  renderList();
  handleIntent(ctx.intent);
  ctx.onBack(back);
  ctx.subscribe('fs:change', ({ path }) => {
    if (path.startsWith(DIR) && nav.depth === 1) renderList();
  });

  return {
    onIntent: async (intent) => {
      while (nav.depth > 1) await nav.pop({ animated: false });
      handleIntent(intent);
    },
    onPause: () => editor?.save(),
  };
}
