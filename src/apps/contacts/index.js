/**
 * Contacts : carnet d'adresses partagé (fournisseur du noyau).
 * Gère aussi l'intent « pick » pour choisir un contact depuis une autre app.
 */
import { h, render } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { navStack, page, searchField, avatar, iconButton, listGroup, listItem, field, emptyState } from '../../lib/ui.js';
import { displayName } from '../../kernel/contacts.js';

export const styles = [new URL('./style.css', import.meta.url).href];

export function mount(root, ctx) {
  const provider = ctx.contacts;
  const nav = navStack(root);
  const picking = () => ctx.intent?.action === 'pick';
  let query = '';

  // ───────────── Liste ─────────────
  const listEl = h('div.contacts-list');
  const index = h('nav.contacts-index');
  const listPage = page({
    title: 'Contacts',
    actions: [iconButton('plus', () => editPage(null), { label: 'Nouveau contact', size: 24 })],
    content: [h('div.contacts-search', searchField({ onInput: (v) => { query = v; renderList(); } })), listEl],
  });
  listPage.append(index);

  function letterOf(contact) {
    const first = displayName(contact).normalize('NFD').replace(/[̀-ͯ]/g, '')[0]?.toUpperCase() ?? '#';
    return /[A-Z]/.test(first) ? first : '#';
  }

  function renderList() {
    const all = provider.search(query);
    listPage.bar.setTitle(picking() ? 'Choisir un contact' : 'Contacts');
    if (!all.length) {
      listEl.replaceChildren(emptyState({ icon: 'user', title: query ? 'Aucun résultat' : 'Aucun contact', message: query ? '' : 'Touchez + pour ajouter un contact.' }));
      index.replaceChildren();
      return;
    }
    const groups = new Map();
    for (const c of all) {
      const letter = letterOf(c);
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(c);
    }
    const me = h(
      'div.contacts-me',
      avatar(ctx.settings.get('userName'), { size: 54, color: ctx.settings.get('accent') }),
      h('div', h('strong', ctx.settings.get('userName')), h('span', 'Ma fiche')),
    );
    render(
      listEl,
      query || picking() ? null : me,
      ...[...groups].map(([letter, contacts]) =>
        h(
          'section.list-group',
          { dataset: { letter } },
          h('div.list-header', letter),
          h(
            'div.list',
            contacts.map((c) =>
              listItem({
                leading: avatar(displayName(c), { color: c.color, size: 36 }),
                title: h('span', c.firstName ? c.firstName + ' ' : '', h('strong', c.lastName || (c.firstName ? '' : displayName(c)))),
                subtitle: picking() ? c.phone : c.company || null,
                trailing: c.favorite ? h('span.contact-fav', icon('star-fill', { size: 14 })) : null,
                onClick: () => (picking() ? ctx.finish({ id: c.id, name: displayName(c), phone: c.phone }) : detailPage(c.id)),
              }),
            ),
          ),
        ),
      ),
    );
    index.replaceChildren(
      ...[...groups.keys()].map((letter) =>
        h('button', { type: 'button', onclick: () => listPage.scroll.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: 'start' }) }, letter),
      ),
    );
  }

  // ───────────── Fiche ─────────────
  function detailPage(id) {
    const content = h('div');
    const render = () => {
      const c = provider.get(id);
      if (!c) return;
      const name = displayName(c);
      const action = (iconName, label, fn, disabled = false) =>
        h('button.contact-action', { type: 'button', disabled, onclick: fn }, icon(iconName, { size: 22 }), h('span', label));
      content.replaceChildren(
        h('div.contact-hero', avatar(name, { color: c.color, size: 96 }), h('h2', name), c.company ? h('p', c.company) : null),
        h(
          'div.contact-actions',
          action('message-fill', 'message', () => ctx.startActivity({ app: 'messages', action: 'view', data: { address: c.phone } }), !c.phone),
          action('phone-fill', 'appel', () => ctx.startActivity({ action: 'dial', data: { number: c.phone, call: true } }), !c.phone),
          action('mail', 'e-mail', () => window.open(`mailto:${c.email}`), !c.email),
          action(c.favorite ? 'star-fill' : 'star', 'favori', () => { provider.update(id, { favorite: !c.favorite }); render(); }),
        ),
        listGroup({
          items: [
            c.phone ? listItem({ title: h('a.contact-link', { href: '#', onclick: (e) => { e.preventDefault(); ctx.startActivity({ action: 'dial', data: { number: c.phone, call: true } }); } }, c.phone), subtitle: 'mobile' }) : null,
            c.email ? listItem({ title: c.email, subtitle: 'e-mail' }) : null,
          ].filter(Boolean),
        }),
        c.notes ? listGroup({ items: [listItem({ title: c.notes, subtitle: 'Notes' })] }) : null,
        listGroup({
          items: [
            listItem({ title: 'Partager le contact', onClick: () => ctx.ui.share({ type: 'text/plain', data: { text: `${name}\n${c.phone ?? ''}\n${c.email ?? ''}`.trim() } }) }),
            listItem({ title: 'Supprimer le contact', destructive: true, onClick: async () => {
              if (await ctx.ui.confirm({ title: `Supprimer ${name} ?`, confirmLabel: 'Supprimer', destructive: true })) {
                provider.remove(id);
                nav.pop();
              }
            } }),
          ],
        }),
      );
    };
    const p = page({ title: '', large: false, back: { label: 'Contacts', onClick: () => nav.pop() }, actions: [h('button.appbar-text', { type: 'button', onclick: () => editPage(id) }, 'Modifier')], content });
    p.onShow = render;
    render();
    nav.push(p);
  }

  // ───────────── Édition ─────────────
  function editPage(id, preset = {}) {
    const c = id ? provider.get(id) : { firstName: '', lastName: '', company: '', phone: '', email: '', notes: '', ...preset };
    const fields = {
      firstName: field({ label: 'Prénom', value: c.firstName, autofocus: !id }),
      lastName: field({ label: 'Nom', value: c.lastName }),
      company: field({ label: 'Entreprise', value: c.company ?? '' }),
      phone: field({ label: 'Téléphone', value: c.phone ?? '', type: 'tel', inputmode: 'tel' }),
      email: field({ label: 'E-mail', value: c.email ?? '', type: 'email' }),
      notes: field({ label: 'Notes', value: c.notes ?? '', multiline: true }),
    };
    const save = () => {
      const data = Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.input.value.trim()]));
      if (!data.firstName && !data.lastName && !data.company && !data.phone) {
        ctx.ui.toast('Saisissez au moins un nom ou un numéro');
        return;
      }
      if (id) provider.update(id, data);
      else {
        const created = provider.add(data);
        nav.pop({ animated: false });
        detailPage(created.id);
        return;
      }
      nav.pop();
    };
    const p = page({
      title: id ? 'Modifier' : 'Nouveau contact',
      large: false,
      back: { label: 'Annuler', onClick: () => nav.pop() },
      actions: [h('button.appbar-text.strong', { type: 'button', onclick: save }, 'OK')],
      content: [
        h('div.contact-hero', avatar(displayName(c) || '?', { color: c.color, size: 84 })),
        h('div.form-group', fields.firstName, fields.lastName, fields.company),
        h('div.form-group', fields.phone, fields.email),
        h('div.form-group', fields.notes),
      ],
    });
    nav.push(p);
  }

  function handleIntent(intent) {
    renderList();
    const data = intent?.data;
    if (intent?.action !== 'view' || !data) return;
    if (data.id && provider.get(data.id)) detailPage(data.id);
    else if (data.create || data.phone) editPage(null, { phone: data.phone ?? '' });
  }

  nav.push(listPage);
  handleIntent(ctx.intent);
  ctx.subscribe('contacts:change', () => {
    renderList();
    nav.top?.onShow?.();
  });
  ctx.onBack(async () => (nav.depth > 1 ? nav.pop() : false));
  return {
    onIntent: async (intent) => {
      while (nav.depth > 1) await nav.pop({ animated: false });
      handleIntent(intent);
    },
  };
}
