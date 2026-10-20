/**
 * Écran d'alarme : réveils et minuteurs qui sonnent, rappels du calendrier.
 * Suit aussi le minuteur en cours pour l'îlot de la barre d'état.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatTime, formatDuration } from '../lib/format.js';

export class AlarmScreen {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = h('div.alarm-screen');
    ui.layers.system.append(this.el);
    this.ringing = null;
  }

  start() {
    this.k.events.on('alarm:fire', (alarm) => this.#fire(alarm));
    this.k.events.on('alarm:change', () => this.#trackTimer());
    this.#trackTimer();
  }

  get isVisible() {
    return Boolean(this.ringing);
  }

  #trackTimer() {
    const timer = this.k.alarms.next({ kind: 'timer' });
    if (!timer) {
      this.ui.statusbar.clearActivity('timer');
      return;
    }
    this.ui.statusbar.setActivity('timer', {
      icon: 'timer',
      color: '#ff9f0a',
      priority: 5,
      text: () => formatDuration(Math.max(0, timer.at - this.k.now())),
      onClick: () => this.ui.openIntent({ app: 'clock', action: 'view', data: { tab: 'timer' } }),
    });
  }

  #fire(alarm) {
    if (alarm.kind === 'reminder') {
      this.k.notifications.post({
        appId: alarm.appId,
        title: alarm.label || 'Rappel',
        body: alarm.payload?.body ?? formatTime(alarm.at, this.k.settings.get('use24h')),
        intent: alarm.payload?.intent ?? { app: alarm.appId, action: 'main' },
      });
      return;
    }
    if (this.ringing) this.#stop();
    this.ringing = alarm;
    if (this.ui.state === 'off') this.ui.wake();
    this.ui.sound.startLoop('alarm');
    this.k.device.vibrate([500, 300, 500, 300, 500]);
    this.#trackTimer();
    this.render();
    this.el.classList.add('visible');
  }

  render() {
    const alarm = this.ringing;
    const isTimer = alarm.kind === 'timer';
    this.el.replaceChildren(
      h('div.alarm-glow'),
      h(
        'div.alarm-content',
        h('div.alarm-icon', icon(isTimer ? 'timer' : 'alarm', { size: 40 })),
        h('div.alarm-time', formatTime(this.k.now(), this.k.settings.get('use24h'))),
        h('div.alarm-label', isTimer ? 'Minuteur terminé' : alarm.label || 'Réveil'),
      ),
      h(
        'div.alarm-actions',
        isTimer
          ? h('button.alarm-btn.secondary', { type: 'button', onclick: () => this.#repeat() }, 'Relancer')
          : h('button.alarm-btn.secondary', { type: 'button', onclick: () => this.#snooze() }, 'Répéter (9 min)'),
        h('button.alarm-btn.primary', { type: 'button', onclick: () => this.#stop() }, 'Arrêter'),
      ),
    );
  }

  #snooze() {
    this.k.alarms.snooze(this.ringing, 9);
    this.ui.dialogs.toast('Répétition dans 9 minutes');
    this.#stop();
  }

  #repeat() {
    const duration = this.ringing.duration ?? 60_000;
    this.k.alarms.schedule({ appId: this.ringing.appId, kind: 'timer', at: this.k.now() + duration, duration, label: this.ringing.label });
    this.#stop();
  }

  #stop() {
    this.ui.sound.stopLoop('alarm');
    this.ringing = null;
    this.el.classList.remove('visible');
  }

  dismiss() {
    if (!this.ringing) return false;
    this.#stop();
    return true;
  }
}
