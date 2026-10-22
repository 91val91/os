/**
 * Barre d'état : heure, îlot d'activités en direct, réseau, batterie.
 *
 * Les icônes réseau montrent l'état réel : signal du modem et force du Wi‑Fi
 * avec orion-server ; type de connexion et qualité estimée par le navigateur
 * sur un téléphone (rien n'est affiché quand le navigateur ne le sait pas).
 */
import { h, render } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatTime } from '../lib/format.js';

export class StatusBar {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.statusbar;
    this.activities = new Map();
    this.time = h('span.sb-time');
    this.island = h('button.island', { type: 'button', onclick: (e) => { e.stopPropagation(); this.#activeActivity()?.onClick?.(); } });
    this.icons = h('div.sb-icons');
    this.left = h('div.sb-left', this.time);
    this.el.replaceChildren(this.left, h('div.sb-center', this.island), h('div.sb-right', this.icons));
  }

  start() {
    const refresh = () => this.render();
    for (const type of ['settings:change', 'battery:change', 'network:change', 'bluetooth:change', 'location:change', 'alarm:change', 'call:state']) this.k.events.on(type, refresh);
    this.timer = setInterval(() => {
      this.#renderTime();
      this.#renderIsland();
    }, 1000);
    this.render();
  }

  stop() {
    clearInterval(this.timer);
  }

  render() {
    this.#renderTime();
    this.#renderIcons();
    this.#renderIsland();
  }

  #renderTime() {
    const text = formatTime(this.k.now(), this.k.settings.get('use24h'));
    if (this.time.textContent !== text) this.time.textContent = text;
  }

  #renderIcons() {
    const { settings, device, alarms, network, telephony, bluetooth, location } = this.k;
    const net = network.state;
    const tel = telephony.network;
    const items = [];
    if (settings.get('dnd')) items.push(icon('moon-fill', { size: 14 }));
    const nextAlarm = alarms.next({ kind: 'alarm' });
    if (nextAlarm && nextAlarm.at - this.k.now() < 86_400_000) items.push(icon('alarm', { size: 14, stroke: 2.4 }));
    if (location.active) items.push(h('span.sb-location', icon('location-fill', { size: 11 })));
    if (bluetooth.enabled && !net.airplane) items.push(icon('bluetooth', { size: 14, stroke: 2.4 }));
    if (net.airplane) {
      items.push(icon('airplane', { size: 15 }));
    } else {
      // Réseau mobile : barres du modem, de la simulation, ou qualité estimée par le navigateur.
      let bars = null;
      let label = null;
      if (tel.mode === 'modem' || tel.mode === 'simulated') {
        bars = tel.signal;
        label = tel.cellular ? tel.type : null;
      } else if (net.type === 'cellular') {
        bars = net.qualityBars ?? 4;
        label = net.quality && net.quality !== 'slow-2g' ? net.quality.toUpperCase() : null;
      }
      if (bars != null) items.push(h('span.sb-signal', [1, 2, 3, 4].map((i) => h(`i${i <= bars ? '.on' : ''}`, { style: { height: `${3 + i * 2.2}px` } }))));
      if (label && net.type !== 'wifi' && net.type !== 'ethernet') items.push(h('span.sb-net', label));
      if (net.type === 'wifi') {
        const signal = net.wifi.connected?.signal;
        const level = signal == null ? 3 : signal >= 60 ? 3 : signal >= 35 ? 2 : 1;
        items.push(h('span.sb-wifi', { dataset: { level: String(level) } }, icon('wifi', { size: 16, stroke: 2.6 })));
      } else if (net.type === 'ethernet') {
        items.push(icon('ethernet', { size: 15, stroke: 2.2 }));
      } else if (!net.online) {
        items.push(h('span.sb-offline', { title: 'Hors ligne' }, icon('wifi-off', { size: 15, stroke: 2.4 })));
      }
    }
    const b = device.battery;
    const pct = Math.round(b.level * 100);
    const low = pct <= 20 && !b.charging;
    if (settings.get('showBatteryPercent')) items.push(h('span.sb-pct', `${pct}`));
    items.push(
      h(
        `span.sb-battery${b.charging ? '.charging' : ''}${low ? '.low' : ''}${settings.get('batterySaver') ? '.saver' : ''}`,
        h('span.sb-battery-fill', { style: { width: `${Math.max(6, pct)}%` } }),
        b.charging ? icon('bolt', { size: 11 }) : null,
      ),
    );
    this.icons.replaceChildren(...items);
  }

  // ───────────── Îlot / activités en direct ─────────────

  setActivity(id, activity) {
    this.activities.set(id, { priority: 1, ...activity });
    this.#renderIsland();
  }

  clearActivity(id) {
    if (this.activities.delete(id)) this.#renderIsland();
  }

  #activeActivity() {
    let best = null;
    for (const a of this.activities.values()) if (!best || a.priority > best.priority) best = a;
    return best;
  }

  #renderIsland() {
    const a = this.#activeActivity();
    this.island.classList.toggle('active', Boolean(a));
    this.el.classList.toggle('has-activity', Boolean(a));
    if (!a) {
      if (this.island.childElementCount) this.island.replaceChildren();
      return;
    }
    const text = typeof a.text === 'function' ? a.text() : a.text ?? '';
    const key = `${a.icon}|${a.color}|${text}`;
    if (this.island.dataset.key === key) return;
    this.island.dataset.key = key;
    this.island.style.setProperty('--activity', a.color ?? '#30d158');
    render(
      this.island,
      h('span.island-icon', icon(a.icon ?? 'dot', { size: 14, stroke: 2.4 })),
      h('span.island-text', text),
    );
  }

  /** Couleur du texte de la barre selon ce qui est affiché dessous. */
  refreshStyle() {
    const ui = this.ui;
    let style = 'light';
    if (ui.controlCenter?.isOpen) style = 'light';
    else if (ui.shade?.isOpen) style = ui.theme.resolved === 'dark' ? 'light' : 'dark';
    else if (ui.state === 'app') {
      const pref = ui.wm?.statusStyle ?? 'auto';
      style = pref === 'auto' ? (ui.theme.resolved === 'dark' ? 'light' : 'dark') : pref;
    } else if (ui.state === 'setup') style = ui.theme.resolved === 'dark' ? 'light' : 'dark';
    this.el.classList.toggle('sb-dark', style === 'dark');
    this.el.classList.toggle('sb-light', style !== 'dark');
  }
}
