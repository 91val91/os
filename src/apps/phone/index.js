/**
 * Téléphone : clavier DTMF, appels récents, favoris, contacts et
 * messagerie vocale.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { relativeTime, formatDuration } from '../../lib/format.js';
import { tabBar, appBar, avatar, listItem, segmented, emptyState, searchField, collapseOnScroll } from '../../lib/ui.js';
import { longPress } from '../../lib/gesture.js';
import { displayName } from '../../kernel/contacts.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const LETTERS = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' };

function formatNumber(raw) {
  const digits = raw.replace(/[^\d+*#]/g, '');
  if (/^0\d{9}$/.test(digits)) return digits.replace(/(\d{2})(?=\d)/g, '$1 ');
  if (/^\+33\d{9}$/.test(digits)) return `+33 ${digits.slice(3, 4)} ${digits.slice(4).replace(/(\d{2})(?=\d)/g, '$1 ')}`;
  return digits;
}

export function mount(root, ctx) {
  const tel = ctx.telephony;
  const contacts = ctx.contacts;
  let number = '';
  let tab = ctx.storage.get('tab', 'keypad');
  let recentsFilter = 'all';

  const views = {};
  const container = h('div.phone-views');

  const call = (target) => {
    if (!target) return;
    try {
      tel.dial(target);
    } catch (error) {
      ctx.ui.alert({ title: 'Appel impossible', message: error.message });
    }
  };

  // ───────────── Clavier ─────────────
  const display = h('div.dial-number');
  const nameHint = h('div.dial-name');
  const addLink = h('button.dial-add', { type: 'button', onclick: () => ctx.startActivity({ app: 'contacts', action: 'view', data: { phone: formatNumber(number) } }) }, 'Ajouter le numéro');
  const back = h('button.dial-back', { type: 'button', 'aria-label': 'Effacer', onclick: () => { number = number.slice(0, -1); renderDisplay(); } }, icon('backspace', { size: 26 }));
  longPress(back, () => {
    number = '';
    renderDisplay();
  });

  function renderDisplay() {
    display.textContent = formatNumber(number);
    display.style.fontSize = number.length > 13 ? '1.6rem' : '2.3rem';
    const match = number.length >= 6 ? contacts.findByPhone(number) : null;
    nameHint.textContent = match ? displayName(match) : '';
    addLink.style.visibility = number && !match ? 'visible' : 'hidden';
    back.style.visibility = number ? 'visible' : 'hidden';
  }

  const keyButton = (d) => {
    const btn = h('button.dial-key', { type: 'button', onclick: () => { number += d; ctx.sound.dtmf(d); ctx.ui.vibrate(5); renderDisplay(); } }, h('span.dial-digit', d), h('span.dial-letters', LETTERS[d] ?? ' '));
    if (d === '0') longPress(btn, () => { number += '+'; renderDisplay(); });
    return btn;
  };
  views.keypad = h(
    'div.phone-keypad',
    h('div.dial-top', display, nameHint, addLink),
    h('div.dial-grid', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(keyButton)),
    h(
      'div.dial-bottom',
      h('span'),
      h('button.dial-call', { type: 'button', 'aria-label': 'Appeler', onclick: () => {
        if (!number) {
          number = tel.callLog().find((c) => c.direction === 'out')?.number.replace(/\s/g, '') ?? '';
          renderDisplay();
          return;
        }
        call(formatNumber(number));
      } }, icon('phone-fill', { size: 32 })),
      back,
    ),
  );

  // ───────────── Récents ─────────────
  const recentsList = h('div.list');
  const recentsBar = appBar({
    title: 'Récents',
    large: true,
    leading: h('button.appbar-text', { type: 'button', onclick: async () => {
      if (await ctx.ui.confirm({ title: "Effacer l'historique des appels ?", confirmLabel: 'Effacer', destructive: true })) tel.clearCallLog();
    } }, 'Effacer'),
  });
  const recentsScroll = h(
    'div.app-scroll',
    h('div.app-content', h('div.phone-filter', segmented([{ value: 'all', label: 'Tous' }, { value: 'missed', label: 'Manqués' }], recentsFilter, (v) => { recentsFilter = v; renderRecents(); })), recentsList),
  );
  collapseOnScroll(recentsBar, recentsScroll);
  views.recents = h('div.phone-page', recentsBar, recentsScroll);

  function renderRecents() {
    const items = tel.callLog().filter((c) => recentsFilter === 'all' || c.missed);
    if (!items.length) {
      recentsList.replaceChildren(emptyState({ icon: 'history', title: 'Aucun appel', message: recentsFilter === 'missed' ? 'Aucun appel manqué.' : '' }));
      return;
    }
    recentsList.replaceChildren(
      ...items.map((c) => {
        const contact = contacts.findByPhone(c.number);
        const kind = c.missed ? 'Manqué' : c.declined ? 'Refusé' : c.direction === 'out' ? 'Sortant' : 'Entrant';
        return listItem({
          leading: h(`span.call-dir${c.missed ? '.missed' : ''}`, icon(c.missed ? 'phone-missed' : c.direction === 'out' ? 'phone-outgoing' : 'phone-incoming', { size: 16 })),
          title: h(`span${c.missed ? '.missed-text' : ''}`, c.name),
          subtitle: `${kind}${c.duration ? ' · ' + formatDuration(c.duration * 1000) : ''}`,
          detail: relativeTime(c.time, ctx.now()),
          trailing: h('button.info-btn', { type: 'button', 'aria-label': 'Infos', onclick: (e) => { e.stopPropagation(); contact ? ctx.startActivity({ app: 'contacts', action: 'view', data: { id: contact.id } }) : ctx.startActivity({ app: 'contacts', action: 'view', data: { phone: c.number } }); } }, icon('info', { size: 22 })),
          onClick: () => call(c.number),
        });
      }),
    );
  }

  // ───────────── Favoris & contacts ─────────────
  const favList = h('div.list');
  const favBar = appBar({ title: 'Favoris', large: true });
  const favScroll = h('div.app-scroll', h('div.app-content', favList));
  collapseOnScroll(favBar, favScroll);
  views.favorites = h('div.phone-page', favBar, favScroll);

  function renderFavorites() {
    const favs = contacts.list().filter((c) => c.favorite);
    favList.replaceChildren(
      ...(favs.length
        ? favs.map((c) => listItem({ leading: avatar(displayName(c), { color: c.color, size: 40 }), title: displayName(c), subtitle: 'mobile', trailing: h('span.fav-call', icon('phone-fill', { size: 18 })), onClick: () => call(c.phone) }))
        : [emptyState({ icon: 'star', title: 'Aucun favori', message: 'Ajoutez des favoris depuis la fiche d\'un contact.' })]),
    );
  }

  const contactsList = h('div.list');
  let contactQuery = '';
  const contactsBar = appBar({ title: 'Contacts', large: true });
  const contactsScroll = h('div.app-scroll', h('div.app-content', h('div.phone-filter', searchField({ onInput: (v) => { contactQuery = v; renderContacts(); } })), contactsList));
  collapseOnScroll(contactsBar, contactsScroll);
  views.contacts = h('div.phone-page', contactsBar, contactsScroll);

  function renderContacts() {
    contactsList.replaceChildren(
      ...contacts.search(contactQuery).map((c) =>
        listItem({
          leading: avatar(displayName(c), { color: c.color, size: 36 }),
          title: displayName(c),
          subtitle: c.phone,
          trailing: h('button.info-btn', { type: 'button', 'aria-label': 'Fiche', onclick: (e) => { e.stopPropagation(); ctx.startActivity({ app: 'contacts', action: 'view', data: { id: c.id } }); } }, icon('info', { size: 22 })),
          onClick: () => call(c.phone),
        }),
      ),
    );
  }

  // ───────────── Messagerie ─────────────
  const vmBar = appBar({ title: 'Messagerie', large: true });
  views.voicemail = h(
    'div.phone-page',
    vmBar,
    h(
      'div.app-scroll',
      h(
        'div.app-content',
        emptyState({ icon: 'voicemail', title: 'Aucun message vocal', message: 'Les messages laissés par vos correspondants apparaîtront ici.' }),
        h('button.btn.btn-tinted.block.vm-call', { type: 'button', onclick: () => call('888') }, icon('voicemail', { size: 20 }), 'Appeler la messagerie'),
      ),
    ),
  );

  // ───────────── Onglets ─────────────
  const renderers = { recents: renderRecents, favorites: renderFavorites, contacts: renderContacts };
  const tabs = tabBar(
    [
      { id: 'favorites', label: 'Favoris', icon: 'star-fill' },
      { id: 'recents', label: 'Récents', icon: 'history' },
      { id: 'contacts', label: 'Contacts', icon: 'user-circle' },
      { id: 'keypad', label: 'Clavier', icon: 'keypad' },
      { id: 'voicemail', label: 'Messagerie', icon: 'voicemail' },
    ],
    { value: tab, onChange: (id) => show(id) },
  );

  function show(id) {
    tab = id;
    ctx.storage.set('tab', id);
    tabs.select(id);
    renderers[id]?.();
    container.replaceChildren(views[id]);
    if (id === 'recents') ctx.kernel.notifications.clear({ appId: 'phone' });
    updateBadge();
  }

  function updateBadge() {
    tabs.setBadge('recents', ctx.kernel.notifications.list({ appId: 'phone' }).length);
  }

  root.classList.add('with-tabbar', 'phone');
  root.append(container, tabs);
  renderDisplay();

  function handleIntent(intent) {
    if (intent?.action === 'dial' && intent.data?.number) {
      if (intent.data.call) {
        call(intent.data.number);
        show('recents');
      } else {
        number = intent.data.number.replace(/\s/g, '');
        renderDisplay();
        show('keypad');
      }
    } else if (intent?.data?.tab && views[intent.data.tab]) {
      show(intent.data.tab);
    } else {
      show(tab);
    }
  }
  handleIntent(ctx.intent);

  ctx.subscribe('call:log', () => tab === 'recents' && renderRecents());
  ctx.subscribe('contacts:change', () => renderers[tab]?.());
  ctx.subscribe('notification:post', updateBadge);

  const onKey = (e) => {
    if (!ctx.foreground || tab !== 'keypad' || e.target.closest('input')) return;
    if (/^[0-9*#]$/.test(e.key)) {
      number += e.key;
      ctx.sound.dtmf(e.key);
      renderDisplay();
    } else if (e.key === 'Backspace') {
      number = number.slice(0, -1);
      renderDisplay();
    } else if (e.key === 'Enter' && number) call(formatNumber(number));
  };
  window.addEventListener('keydown', onKey);
  ctx.on('destroy', () => {
    window.removeEventListener('keydown', onKey);
  });

  return { onIntent: handleIntent };
}
