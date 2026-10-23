/**
 * Interface d'appel (système) : appel entrant, appel en cours, clavier DTMF.
 * Réduite, elle s'affiche dans l'îlot de la barre d'état.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatDuration } from '../lib/format.js';
import { avatar } from '../lib/ui.js';

export class CallScreen {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = h('div.call-screen');
    ui.layers.system.append(this.el);
    this.minimized = false;
    this.keypad = false;
    this.digits = '';
  }

  start() {
    this.k.events.on('call:state', (call) => this.#onState(call));
    // Modem : numéro refusé, pas de réseau, décrochage impossible…
    this.k.events.on('call:error', ({ message }) => this.ui.dialogs.toast(message, { icon: 'phone-missed' }));
    setInterval(() => {
      if (this.k.telephony.call?.state === 'active') this.#renderStatus();
    }, 1000);
  }

  #status(call) {
    if (!call) return '';
    switch (call.state) {
      case 'dialing': return 'Appel…';
      case 'ringing': return 'Sonnerie…';
      case 'incoming': return 'Appel entrant';
      case 'active': return call.held ? 'En attente' : formatDuration(this.k.now() - call.connectedAt);
      case 'ended': return 'Appel terminé';
      default: return '';
    }
  }

  #onState(call) {
    const ui = this.ui;
    ui.sound.stopLoop('ring');
    ui.sound.stopLoop('ringback');
    if (!call) {
      this.#hide();
      return;
    }
    if (call.state === 'ended') {
      this.call = call;
      this.render();
      ui.statusbar.clearActivity('call');
      setTimeout(() => {
        if (!this.k.telephony.call) this.#hide();
      }, 1200);
      return;
    }
    const isNew = !this.call || this.call.id !== call.id;
    this.call = call;
    if (isNew) {
      this.minimized = false;
      this.keypad = false;
      this.digits = '';
      if (ui.state === 'off') ui.wake();
    }
    if (call.state === 'incoming') {
      ui.sound.startLoop('ring');
      this.k.device.vibrate([400, 300, 400]);
    }
    if (call.state === 'ringing') ui.sound.startLoop('ringback');
    this.render();
    if (!this.minimized) this.el.classList.add('visible');
    this.#updateActivity();
  }

  #updateActivity() {
    const call = this.k.telephony.call;
    if (!call || call.state === 'incoming') {
      this.ui.statusbar.clearActivity('call');
      return;
    }
    this.ui.statusbar.setActivity('call', {
      icon: 'phone-fill',
      color: '#30d158',
      priority: 10,
      text: () => this.#status(this.k.telephony.call),
      onClick: () => this.restore(),
    });
  }

  #hide() {
    this.el.classList.remove('visible');
    this.call = null;
    this.ui.statusbar.clearActivity('call');
  }

  minimize() {
    if (!this.k.telephony.call || this.k.telephony.call.state === 'incoming') return false;
    this.minimized = true;
    this.el.classList.remove('visible');
    this.#updateActivity();
    return true;
  }

  restore() {
    if (!this.k.telephony.call) return;
    this.minimized = false;
    this.render();
    this.el.classList.add('visible');
  }

  get isVisible() {
    return this.el.classList.contains('visible');
  }

  #renderStatus() {
    const status = this.el.querySelector('.call-status');
    if (status && this.call) status.textContent = this.#status(this.k.telephony.call ?? this.call);
  }

  render() {
    const call = this.call;
    if (!call) return;
    const t = this.k.telephony;
    const contact = this.k.contacts.findByPhone(call.number);
    const head = h(
      'div.call-head',
      avatar(call.name, { color: contact?.color, size: 92 }),
      h('div.call-name', call.name),
      call.name !== call.number ? h('div.call-number', call.number) : null,
      h('div.call-status', this.#status(call)),
    );
    let body;
    if (call.state === 'incoming') {
      body = h(
        'div.call-incoming',
        h('div.call-incoming-btn', h('button.call-btn.decline', { type: 'button', 'aria-label': 'Refuser', onclick: () => t.hangup() }, icon('hang-up', { size: 34 })), h('span', 'Refuser')),
        h('div.call-incoming-btn', h('button.call-btn.accept', { type: 'button', 'aria-label': 'Accepter', onclick: () => t.answer() }, icon('phone-fill', { size: 30 })), h('span', 'Accepter')),
      );
    } else if (this.keypad) {
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
      body = h(
        'div.call-keypad',
        h('div.call-digits', this.digits || ' '),
        h('div.call-keys', keys.map((k) => h('button.call-key', { type: 'button', onclick: () => { this.digits += k; this.ui.sound.dtmf(k); this.render(); } }, k))),
        h('div.call-bottom', h('button.call-text', { type: 'button', onclick: () => { this.keypad = false; this.render(); } }, 'Masquer'), h('button.call-btn.decline', { type: 'button', 'aria-label': 'Raccrocher', onclick: () => t.hangup() }, icon('hang-up', { size: 34 })), h('span')),
      );
    } else {
      // Appel du modem : silence, clavier (DTMF), haut-parleur et attente ne sont pas encore reliés au matériel.
      const modem = Boolean(call.modemId);
      const option = (name, label, key, active) =>
        h(
          `button.call-option${active && !modem ? '.active' : ''}`,
          { type: 'button', disabled: call.state === 'ended' || modem, title: modem ? 'Pas encore disponible pour un appel du modem' : null, onclick: () => (key === 'keypad' ? ((this.keypad = true), this.render()) : t.setCallOption(key)) },
          h('span.call-option-icon', icon(name, { size: 26 })),
          h('span', label),
        );
      body = h(
        'div.call-active',
        h(
          'div.call-options',
          option(call.muted ? 'mic-off' : 'mic', 'Silence', 'muted', call.muted),
          option('keypad', 'Clavier', 'keypad', false),
          option('volume', 'Haut-parleur', 'speaker', call.speaker),
          option('pause', 'Attente', 'held', call.held),
          h('button.call-option', { type: 'button', disabled: true }, h('span.call-option-icon', icon('video', { size: 26 })), h('span', 'FaceTime')),
          h('button.call-option', { type: 'button', onclick: () => { this.minimize(); this.ui.launch('contacts'); } }, h('span.call-option-icon', icon('users', { size: 26 })), h('span', 'Contacts')),
        ),
        h('div.call-bottom', h('span'), h('button.call-btn.decline', { type: 'button', 'aria-label': 'Raccrocher', disabled: call.state === 'ended', onclick: () => t.hangup() }, icon('hang-up', { size: 34 })), h('button.call-text', { type: 'button', onclick: () => this.minimize() }, 'Réduire')),
      );
    }
    this.el.classList.toggle('ended', call.state === 'ended');
    this.el.replaceChildren(h('div.call-backdrop', { style: { '--c': contact?.color ?? '#3a3a3c' } }), head, body);
  }
}
