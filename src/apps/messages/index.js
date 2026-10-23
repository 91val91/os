/**
 * Messages : conversations SMS (pile téléphonie du noyau), photos jointes,
 * indicateur de saisie, réponses automatiques des correspondants simulés.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { relativeTime, formatTime, isSameDay, formatDate } from '../../lib/format.js';
import { navStack, page, searchField, avatar, iconButton, swipeToDelete, emptyState, listItem } from '../../lib/ui.js';
import { displayName } from '../../kernel/contacts.js';
import { threadKey } from '../../kernel/telephony.js';

export const styles = [new URL('./style.css', import.meta.url).href];

/** État du dernier SMS envoyé (modem : envoi puis envoyé ; téléphone : confié à l'app Messages). */
const STATUS_LABELS = { delivered: 'Distribué', sending: 'Envoi…', sent: 'Envoyé', handoff: 'Ouvert dans l\'app Messages du téléphone' };

export function mount(root, ctx) {
  const tel = ctx.telephony;
  const nav = navStack(root);
  let query = '';
  let openThread = null; // { address, render, typing }

  const setActive = () => tel.setActiveThread(ctx.foreground && openThread ? openThread.address : null);

  // ───────────── Liste des conversations ─────────────
  const listEl = h('div.threads');
  const listPage = page({
    title: 'Messages',
    actions: [iconButton('note-edit', () => composePage(), { label: 'Nouveau message', size: 24 })],
    content: [h('div.threads-search', searchField({ onInput: (v) => { query = v.toLowerCase(); renderList(); } })), listEl],
  });

  function renderList() {
    const threads = tel.threads().filter((t) => !query || t.name.toLowerCase().includes(query) || t.messages.some((m) => m.text?.toLowerCase().includes(query)));
    if (!threads.length) {
      listEl.replaceChildren(emptyState({ icon: 'message', title: query ? 'Aucun résultat' : 'Aucun message', message: query ? '' : 'Touchez le crayon pour démarrer une conversation.' }));
      return;
    }
    listEl.replaceChildren(
      h(
        'div.list',
        threads.map((t) => {
          const row = h(
            'div.list-item.tappable.thread-row',
            { onclick: () => threadPage(t.address) },
            h('span.unread-dot', { style: { visibility: t.unread ? 'visible' : 'hidden' } }),
            avatar(t.name, { color: t.contact?.color, size: 46 }),
            h(
              'div.li-body',
              h('div.thread-head', h('strong', t.name), h('span', t.last ? relativeTime(t.last.time, ctx.now()) : ''), icon('chevron-right', { size: 14 })),
              h('div.thread-preview', t.last ? (t.last.from === 'me' ? 'Vous : ' : '') + (t.last.text || '📷 Photo') : ''),
            ),
          );
          return swipeToDelete(row, () => {
            tel.deleteThread(t.address);
            renderList();
          });
        }),
      ),
    );
  }

  // ───────────── Conversation ─────────────
  function threadPage(address, { draft = '', image = null } = {}) {
    const thread = tel.thread(address);
    const bubbles = h('div.bubbles');
    const scroll = h('div.app-scroll.thread-scroll', bubbles);
    const input = h('textarea.composer-input', { rows: 1, placeholder: 'Message', enterkeyhint: 'send' });
    input.value = draft;
    let attachment = image;
    const preview = h('div.composer-attachment');
    const sendBtn = h('button.composer-send', { type: 'button', 'aria-label': 'Envoyer', onclick: () => send() }, icon('arrow-up', { size: 20, stroke: 2.6 }));

    const renderAttachment = () => {
      preview.replaceChildren();
      if (attachment) {
        preview.append(h('div.attach-thumb', { style: { backgroundImage: `url("${attachment}")` } }, h('button', { type: 'button', 'aria-label': 'Retirer', onclick: () => { attachment = null; renderAttachment(); } }, icon('close', { size: 12, stroke: 3 }))));
      }
      updateSend();
    };
    const updateSend = () => sendBtn.classList.toggle('ready', Boolean(input.value.trim() || attachment));
    const autoGrow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };
    input.addEventListener('input', () => {
      updateSend();
      autoGrow();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    function send() {
      const text = input.value.trim();
      if (!text && !attachment) return;
      try {
        const message = tel.sendSms(address, { text, image: attachment });
        if (message.status === 'failed') ctx.ui.toast("Échec de l'envoi : aucun réseau");
        else if (message.status !== 'handoff') ctx.sound.sent();
      } catch (error) {
        ctx.ui.toast(error.message);
        return;
      }
      input.value = '';
      attachment = null;
      autoGrow();
      renderAttachment();
      render();
    }

    async function attach() {
      const result = await ctx.startActivityForResult({ action: 'pick', type: 'image/*' });
      if (result?.path) {
        attachment = ctx.fs.readFile(result.path);
        renderAttachment();
      }
    }

    function render() {
      const { messages } = tel.thread(address);
      const nodes = [];
      let previous = null;
      messages.forEach((m, i) => {
        if (!previous || m.time - previous.time > 15 * 60_000) {
          nodes.push(h('div.bubble-time', isSameDay(m.time, ctx.now()) ? formatTime(m.time, ctx.settings.get('use24h')) : `${formatDate(m.time, { weekday: 'short', day: 'numeric', month: 'short' })} ${formatTime(m.time, ctx.settings.get('use24h'))}`));
        }
        const next = messages[i + 1];
        const tail = !next || next.from !== m.from || next.time - m.time > 60_000;
        nodes.push(
          h(
            `div.bubble.${m.from}${tail ? '.tail' : ''}${m.status === 'failed' ? '.failed' : ''}`,
            m.image ? h('img.bubble-image', { src: m.image, alt: 'Photo', onclick: () => viewImage(m.image) }) : null,
            m.text ? h('span.selectable', m.text) : null,
          ),
        );
        if (m.status === 'failed') nodes.push(h('div.bubble-status.failed', icon('info', { size: 12 }), ' Non distribué'));
        previous = m;
      });
      const lastMine = [...messages].reverse().find((m) => m.from === 'me');
      if (lastMine && lastMine === messages.at(-1) && lastMine.status !== 'failed') nodes.push(h('div.bubble-status', STATUS_LABELS[lastMine.status] ?? 'Distribué'));
      if (openThread?.typing) nodes.push(h('div.bubble.them.tail.typing', h('i'), h('i'), h('i')));
      bubbles.replaceChildren(...nodes);
      requestAnimationFrame(() => (scroll.scrollTop = scroll.scrollHeight));
    }

    const contact = thread.contact;
    const title = h(
      'button.thread-title',
      { type: 'button', onclick: () => (contact ? ctx.startActivity({ app: 'contacts', action: 'view', data: { id: contact.id } }) : ctx.startActivity({ app: 'contacts', action: 'view', data: { phone: address } })) },
      avatar(thread.name, { color: contact?.color, size: 34 }),
      h('span', thread.name, icon('chevron-right', { size: 10 })),
    );
    const bar = h(
      'header.appbar.thread-bar',
      h(
        'div.appbar-row',
        h('div.appbar-leading', h('button.appbar-back', { type: 'button', onclick: () => nav.pop() }, icon('chevron-left', { size: 26 }), h('span.thread-back-count'))),
        title,
        h('div.appbar-actions', iconButton('phone', () => ctx.startActivity({ action: 'dial', data: { number: address, call: true } }), { label: 'Appeler' })),
      ),
    );
    const composer = h(
      'div.composer',
      h('button.composer-plus', { type: 'button', 'aria-label': 'Joindre une photo', onclick: attach }, icon('plus', { size: 20, stroke: 2.4 })),
      h('div.composer-field', preview, input, sendBtn),
    );
    const p = h('div.page.thread-page', bar, scroll, composer);
    p.onPop = () => {
      openThread = null;
      setActive();
      renderList();
    };
    openThread = { address, render, typing: false };
    nav.push(p);
    setActive();
    render();
    renderAttachment();
    autoGrow();
    if (draft || image) setTimeout(() => input.focus(), 400);
  }

  function viewImage(src) {
    const overlay = h('div.image-viewer', { onclick: () => overlay.remove() }, h('img', { src, alt: '' }));
    root.append(overlay);
  }

  // ───────────── Nouveau message ─────────────
  function composePage(shared = {}) {
    const input = h('input.to-input', { type: 'text', placeholder: 'Nom ou numéro', autocomplete: 'off' });
    const suggestions = h('div.list');
    const go = (address) => {
      nav.pop({ animated: false });
      threadPage(address, shared);
    };
    const render = () => {
      const q = input.value.trim();
      const found = ctx.contacts.search(q).filter((c) => c.phone);
      const items = found.map((c) => listItem({ leading: avatar(displayName(c), { color: c.color, size: 34 }), title: displayName(c), subtitle: c.phone, onClick: () => go(c.phone) }));
      if (/^\+?[\d\s]{6,}$/.test(q)) items.unshift(listItem({ icon: 'phone', iconColor: '#34c759', title: `Envoyer à ${q}`, onClick: () => go(q) }));
      suggestions.replaceChildren(...items);
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const match = ctx.contacts.search(input.value.trim())[0];
        go(match?.phone ?? input.value.trim());
      }
    });
    const p = page({
      title: 'Nouveau message',
      large: false,
      back: { label: 'Annuler', onClick: () => nav.pop() },
      content: [h('label.to-field', h('span', 'À :'), input), suggestions],
    });
    nav.push(p);
    render();
    setTimeout(() => input.focus(), 400);
  }

  // ───────────── Événements ─────────────
  const refresh = (address) => {
    if (openThread && address && threadKey(openThread.address) === threadKey(address)) openThread.render();
    if (nav.depth === 1) renderList();
  };
  ctx.subscribe('sms:received', ({ address }) => refresh(address));
  ctx.subscribe('sms:sent', ({ address }) => refresh(address));
  ctx.subscribe('sms:status', ({ address }) => refresh(address));
  ctx.subscribe('sms:read', () => nav.depth === 1 && renderList());
  ctx.subscribe('sms:typing', ({ address, typing }) => {
    if (openThread && threadKey(openThread.address) === threadKey(address)) {
      openThread.typing = typing;
      openThread.render();
    }
  });
  ctx.subscribe('contacts:change', () => nav.depth === 1 && renderList());

  function handleIntent(intent) {
    if (!intent) return;
    if (intent.action === 'view' && intent.data?.address) threadPage(intent.data.address);
    else if (intent.action === 'send') composePage({ draft: intent.data?.text ?? '', image: intent.data?.image ?? null });
    else if (intent.action === 'sms') composePage();
  }

  nav.push(listPage);
  renderList();
  handleIntent(ctx.intent);
  ctx.onBack(async () => (nav.depth > 1 ? nav.pop() : false));
  ctx.on('destroy', () => tel.setActiveThread(null));

  return {
    onIntent: async (intent) => {
      while (nav.depth > 1) await nav.pop({ animated: false });
      handleIntent(intent);
    },
    onPause: setActive,
    onResume: () => {
      setActive();
      openThread?.render();
      if (nav.depth === 1) renderList();
    },
  };
}
