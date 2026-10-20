/**
 * Écran verrouillé : horloge, notifications, lecture en cours, raccourcis
 * lampe/appareil photo, déverrouillage par balayage et code PIN.
 */
import { h, animate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { drag } from '../lib/gesture.js';
import { formatDate, formatTime } from '../lib/format.js';
import { verifyPasscode } from '../kernel/settings.js';

const LETTERS = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ' };

export class LockScreen {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.lock;
    this.isLocked = false;
    this.pending = [];
    this.failures = 0;
    this.blockedUntil = 0;
  }

  start() {
    this.time = h('div.lock-time');
    this.date = h('div.lock-date');
    this.media = h('div.lock-media');
    this.notifs = h('div.lock-notifs');
    this.lockIcon = h('div.lock-icon', icon('lock-fill', { size: 22 }));
    this.hint = h('div.lock-hint', 'Balayez vers le haut pour déverrouiller');
    this.flashBtn = h('button.lock-action', { type: 'button', 'aria-label': 'Lampe torche', onclick: (e) => { e.stopPropagation(); this.k.settings.toggle('flashlight'); this.k.device.vibrate(10); this.#renderActions(); } }, icon('flashlight', { size: 22 }));
    this.cameraBtn = h('button.lock-action', { type: 'button', 'aria-label': 'Appareil photo', onclick: (e) => { e.stopPropagation(); this.unlock({ then: () => this.ui.launch('camera') }); } }, icon('camera', { size: 22 }));
    this.content = h(
      'div.lock-content',
      h('div.lock-top', this.lockIcon, this.date, this.time),
      h('div.lock-middle', this.media, this.notifs),
      h('div.lock-bottom', this.flashBtn, this.hint, this.cameraBtn),
      h('div.lock-indicator'),
    );
    this.pin = this.#buildPin();
    this.el.replaceChildren(h('div.lock-wallpaper'), this.content, this.pin);

    drag(this.el, {
      axis: 'y',
      filter: (e) => this.isLocked && !this.pinVisible && !e.target.closest('button'),
      onStart: () => (this.content.style.transition = 'none'),
      onMove: ({ dy }) => {
        const offset = Math.min(0, dy);
        this.content.style.transform = `translateY(${offset}px)`;
        this.content.style.opacity = String(1 + offset / 400);
      },
      onEnd: ({ dy, vy }) => {
        this.content.style.transition = '';
        if (-dy > this.el.clientHeight * 0.2 || vy < -0.5) this.unlock();
        else this.#resetContent();
      },
    });
    this.el.addEventListener('click', (e) => {
      if (this.isLocked && !this.pinVisible && e.target === this.el) this.#bounceHint();
    });

    const refresh = () => this.isLocked && this.render();
    for (const type of ['notification:post', 'notification:dismiss', 'media:change', 'settings:change']) this.k.events.on(type, refresh);
    setInterval(() => this.isLocked && this.#renderClock(), 1000);
  }

  get pinVisible() {
    return this.pin.classList.contains('visible');
  }

  #resetContent() {
    this.content.style.transform = '';
    this.content.style.opacity = '';
  }

  #bounceHint() {
    animate(this.content, [{ transform: 'translateY(0)' }, { transform: 'translateY(-26px)' }, { transform: 'translateY(0)' }], { duration: 420, easing: 'ease-out' });
  }

  render() {
    this.#renderClock();
    this.#renderActions();
    const session = this.k.media.get();
    this.media.classList.toggle('visible', Boolean(session));
    if (session) {
      this.media.replaceChildren(
        h('div.lock-media-info', h('strong', session.title), h('span', session.artist)),
        h(
          'div.lock-media-controls',
          h('button', { type: 'button', 'aria-label': 'Précédent', onclick: (e) => { e.stopPropagation(); this.k.media.command('previous'); } }, icon('previous', { size: 22 })),
          h('button', { type: 'button', 'aria-label': 'Lecture', onclick: (e) => { e.stopPropagation(); this.k.media.command('toggle'); } }, icon(session.playing ? 'pause' : 'play', { size: 28 })),
          h('button', { type: 'button', 'aria-label': 'Suivant', onclick: (e) => { e.stopPropagation(); this.k.media.command('next'); } }, icon('next', { size: 22 })),
        ),
      );
    }
    const items = this.k.notifications.list().slice(0, 6);
    this.notifs.replaceChildren(
      ...items.map((n) => this.ui.shade.card(n, { compact: true, onOpen: (notif) => this.unlock({ then: () => this.ui.shade.openNotification(notif) }) })),
    );
  }

  #renderClock() {
    const now = this.k.now();
    this.time.textContent = formatTime(now, this.k.settings.get('use24h'));
    this.date.textContent = formatDate(now);
  }

  #renderActions() {
    this.flashBtn.classList.toggle('active', Boolean(this.k.settings.get('flashlight')));
  }

  lock() {
    this.isLocked = true;
    this.el.classList.add('visible');
    this.el.classList.remove('leaving');
    this.#hidePin();
    this.#resetContent();
    this.lockIcon.replaceChildren(icon('lock-fill', { size: 22 }));
    this.render();
  }

  /** Déverrouille (avec code si défini). `then` est exécuté après. */
  async unlock({ then = null } = {}) {
    if (!this.isLocked) {
      then?.();
      return true;
    }
    if (then) this.pending.push(then);
    if (this.k.settings.get('passcode')) {
      this.#showPin();
      return false;
    }
    await this.#dismiss();
    return true;
  }

  async #dismiss() {
    this.isLocked = false;
    this.lockIcon.replaceChildren(icon('unlock', { size: 22 }));
    this.ui.sound.unlock();
    this.el.classList.add('leaving');
    const d = this.ui.animScale;
    await animate(this.el, [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0.6 }], { duration: 320 * d, easing: 'cubic-bezier(.4,0,.2,1)' });
    this.el.classList.remove('visible', 'leaving');
    this.#hidePin();
    this.#resetContent();
    this.ui.onUnlocked();
    const tasks = this.pending;
    this.pending = [];
    tasks.forEach((fn) => fn());
  }

  // ───────────── Code PIN ─────────────

  #buildPin() {
    this.dots = h('div.pin-dots');
    this.pinTitle = h('div.pin-title', 'Saisissez le code');
    const key = (digit) =>
      h('button.pin-key', { type: 'button', onclick: (e) => { e.stopPropagation(); this.#press(String(digit)); } }, h('span.pin-digit', String(digit)), h('span.pin-letters', LETTERS[digit] ?? (digit === 0 ? '+' : ' ')));
    this.cancelBtn = h('button.pin-text', { type: 'button', onclick: (e) => { e.stopPropagation(); this.#cancelOrDelete(); } }, 'Annuler');
    const grid = h(
      'div.pin-grid',
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map(key),
      h('button.pin-text', { type: 'button', onclick: (e) => { e.stopPropagation(); this.ui.emergencyCall(); } }, 'Urgence'),
      key(0),
      this.cancelBtn,
    );
    const pin = h('div.lock-pin', h('div.pin-box', h('div.pin-lock', icon('lock-fill', { size: 20 })), this.pinTitle, this.dots, grid));
    this.entered = '';
    document.addEventListener('keydown', (e) => {
      if (!this.pinVisible) return;
      if (/^\d$/.test(e.key)) this.#press(e.key);
      if (e.key === 'Backspace') this.#cancelOrDelete();
      if (e.key === 'Escape') this.#hidePin();
    });
    return pin;
  }

  #showPin() {
    this.entered = '';
    this.#renderDots();
    this.pin.classList.add('visible');
    this.content.classList.add('blurred');
    this.#resetContent();
  }

  #hidePin() {
    this.pin.classList.remove('visible');
    this.content.classList.remove('blurred');
    this.entered = '';
  }

  #renderDots() {
    const length = this.k.settings.get('passcode')?.length ?? 4;
    this.dots.replaceChildren(...Array.from({ length }, (_, i) => h(`span${i < this.entered.length ? '.filled' : ''}`)));
    this.cancelBtn.textContent = this.entered ? 'Effacer' : 'Annuler';
  }

  #cancelOrDelete() {
    if (this.entered) {
      this.entered = this.entered.slice(0, -1);
      this.#renderDots();
    } else {
      this.#hidePin();
      this.pending = [];
    }
  }

  async #press(digit) {
    if (Date.now() < this.blockedUntil) return;
    const record = this.k.settings.get('passcode');
    const length = record?.length ?? 4;
    if (this.entered.length >= length) return;
    this.ui.sound.click();
    this.k.device.vibrate(5);
    this.entered += digit;
    this.#renderDots();
    if (this.entered.length < length) return;
    if (await verifyPasscode(record, this.entered)) {
      this.failures = 0;
      this.pinTitle.textContent = 'Saisissez le code';
      await this.#dismiss();
      return;
    }
    this.failures++;
    this.k.device.vibrate([60, 40, 60]);
    await animate(this.dots, [{ transform: 'translateX(0)' }, { transform: 'translateX(-14px)' }, { transform: 'translateX(12px)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(0)' }], { duration: 380 });
    this.entered = '';
    if (this.failures >= 5) {
      this.blockedUntil = Date.now() + 30_000;
      this.pinTitle.textContent = 'Réessayez dans 30 secondes';
      setTimeout(() => (this.pinTitle.textContent = 'Saisissez le code'), 30_000);
    } else {
      this.pinTitle.textContent = 'Code incorrect';
    }
    this.#renderDots();
  }
}
