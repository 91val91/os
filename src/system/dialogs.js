/**
 * Boîtes de dialogue système : alertes, confirmations, saisie, feuilles
 * d'actions, sélecteur d'application, demandes de permission, toasts.
 */
import { h, animate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { appIcon } from './app-icon.js';

export class Dialogs {
  constructor(ui) {
    this.ui = ui;
    this.layer = ui.layers.dialogs;
    this.stack = [];
  }

  get open() {
    return this.stack.length > 0;
  }

  /** Ferme la boîte du dessus (touche Retour). */
  closeTop() {
    const top = this.stack.at(-1);
    if (!top) return false;
    top.dismiss();
    return true;
  }

  closeAll() {
    while (this.stack.length) this.stack.at(-1).dismiss();
  }

  #mount(panel, { kind = 'alert', cancelValue = null, backdropDismiss = true } = {}) {
    return new Promise((resolve) => {
      const backdrop = h('div.dialog-backdrop');
      const wrapper = h(`div.dialog-wrap.${kind}`, backdrop, panel);
      this.layer.append(wrapper);
      this.layer.classList.add('active');
      const d = this.ui.dur(1);
      animate(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 * d });
      if (kind === 'sheet') animate(panel, [{ transform: 'translateY(110%)' }, { transform: 'translateY(0)' }], { duration: 320 * d, easing: 'cubic-bezier(.2,.9,.3,1)' });
      else animate(panel, [{ opacity: 0, transform: 'scale(1.12)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220 * d, easing: 'cubic-bezier(.2,.9,.3,1.1)' });

      const entry = {
        dismiss: () => finish(cancelValue),
      };
      const finish = async (value) => {
        if (entry.done) return;
        entry.done = true;
        this.stack = this.stack.filter((e) => e !== entry);
        resolve(value);
        await Promise.all([
          animate(backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 * d, fill: 'forwards' }),
          kind === 'sheet'
            ? animate(panel, [{ transform: 'translateY(0)' }, { transform: 'translateY(110%)' }], { duration: 220 * d, fill: 'forwards' })
            : animate(panel, [{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }], { duration: 160 * d, fill: 'forwards' }),
        ]);
        wrapper.remove();
        if (!this.layer.children.length) this.layer.classList.remove('active');
      };
      entry.finish = finish;
      if (backdropDismiss) backdrop.addEventListener('click', () => finish(cancelValue));
      this.stack.push(entry);
      panel.finish = finish;
    });
  }

  /**
   * @param {{ title?: string, message?: string, buttons?: { label: string, value?: any, role?: 'cancel'|'destructive'|'default' }[] }} options
   */
  alert({ title = '', message = '', buttons = [{ label: 'OK', value: true }], content = null } = {}) {
    const panel = h('div.dialog.alert', h('div.dialog-text', title ? h('h3', title) : null, message ? h('p', message) : null, content));
    const cancel = buttons.find((b) => b.role === 'cancel');
    const row = h(`div.dialog-buttons${buttons.length > 2 ? '.stacked' : ''}`);
    for (const b of buttons) {
      row.append(h(`button.dialog-btn${b.role ? '.' + b.role : ''}`, { type: 'button', onclick: () => panel.finish(b.value ?? b.label) }, b.label));
    }
    panel.append(row);
    const promise = this.#mount(panel, { cancelValue: cancel ? cancel.value ?? null : null, backdropDismiss: Boolean(cancel) });
    setTimeout(() => row.querySelector('.dialog-btn:not(.cancel)')?.focus(), 50);
    return promise;
  }

  confirm({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Annuler', destructive = false }) {
    return this.alert({
      title,
      message,
      buttons: [
        { label: cancelLabel, value: false, role: 'cancel' },
        { label: confirmLabel, value: true, role: destructive ? 'destructive' : 'default' },
      ],
    }).then(Boolean);
  }

  prompt({ title, message = '', value = '', placeholder = '', confirmLabel = 'OK', type = 'text' }) {
    const input = h('input.dialog-input', { type, value, placeholder, autocomplete: 'off' });
    const panel = h('div.dialog.alert', h('div.dialog-text', h('h3', title), message ? h('p', message) : null, input));
    const row = h(
      'div.dialog-buttons',
      h('button.dialog-btn.cancel', { type: 'button', onclick: () => panel.finish(null) }, 'Annuler'),
      h('button.dialog-btn.default', { type: 'button', onclick: () => panel.finish(input.value) }, confirmLabel),
    );
    panel.append(row);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') panel.finish(input.value);
    });
    const promise = this.#mount(panel, { cancelValue: null });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 80);
    return promise;
  }

  /** Feuille d'actions (iOS) / menu inférieur (Android). */
  actionSheet({ title = '', message = '', actions = [], cancelLabel = 'Annuler' }) {
    const group = h(
      'div.action-group',
      title || message ? h('div.action-head', title ? h('strong', title) : null, message ? h('span', message) : null) : null,
      actions.map((a) =>
        h(`button.action-btn${a.destructive ? '.destructive' : ''}`, { type: 'button', disabled: a.disabled, onclick: () => panel.finish(a.value ?? a.label) }, a.icon ? icon(a.icon, { size: 20 }) : null, h('span', a.label)),
      ),
    );
    const panel = h('div.dialog.action-sheet', group, h('button.action-btn.cancel', { type: 'button', onclick: () => panel.finish(null) }, cancelLabel));
    return this.#mount(panel, { kind: 'sheet', cancelValue: null });
  }

  /** Sélecteur d'application pour un intent implicite. */
  choose(packages, intent) {
    const titles = { view: 'Ouvrir avec', send: 'Partager avec', pick: 'Choisir avec' };
    const grid = h(
      'div.chooser-grid',
      packages.map((pkg) => h('button.chooser-item', { type: 'button', onclick: () => panel.finish(pkg.id) }, appIcon(pkg, { size: 54 }), h('span', pkg.name))),
    );
    const panel = h('div.dialog.action-sheet.chooser', h('div.action-group', h('div.action-head', h('strong', titles[intent.action] ?? 'Ouvrir avec')), grid), h('button.action-btn.cancel', { type: 'button', onclick: () => panel.finish(null) }, 'Annuler'));
    return this.#mount(panel, { kind: 'sheet', cancelValue: null });
  }

  permission({ appId, info }) {
    const pkg = this.ui.kernel.packages.get(appId);
    const panel = h(
      'div.dialog.alert.permission',
      h(
        'div.dialog-text',
        h('div.permission-icon', icon(info.icon, { size: 30 })),
        h('h3', `Autoriser « ${pkg?.name ?? appId} » à ${info.reason} ?`),
        h('p', `${pkg?.name ?? appId} demande l'accès : ${info.label}.`),
      ),
      h(
        'div.dialog-buttons.stacked',
        h('button.dialog-btn.default', { type: 'button', onclick: () => panel.finish('allow') }, "Lorsque l'app est active"),
        h('button.dialog-btn', { type: 'button', onclick: () => panel.finish('once') }, 'Cette fois uniquement'),
        h('button.dialog-btn.cancel', { type: 'button', onclick: () => panel.finish('deny') }, 'Refuser'),
      ),
    );
    return this.#mount(panel, { cancelValue: 'deny', backdropDismiss: false });
  }

  /** Message éphémère en bas de l'écran (Android). */
  toast(message, { duration = 2200, icon: iconName = null } = {}) {
    const el = h('div.toast', iconName ? icon(iconName, { size: 18 }) : null, h('span', message));
    this.ui.layers.toasts.append(el);
    const d = this.ui.dur(1);
    animate(el, [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200 * d, easing: 'ease-out' });
    setTimeout(async () => {
      await animate(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 250 * d, fill: 'forwards' });
      el.remove();
    }, duration);
  }
}
