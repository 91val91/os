/**
 * Assistant de premier démarrage (et de chaque nouveau compte) : compte,
 * apparence, navigation, code.
 */
import { h, animate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { avatar } from '../lib/ui.js';
import { createPasscode } from '../kernel/settings.js';
import { platform } from './platform.js';

const GREETINGS = ['Bonjour', 'Hello', 'Hola', 'Ciao', 'Hallo', 'Olá', 'Привет', 'こんにちは', 'مرحبا', '你好'];

export class SetupWizard {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.setup;
  }

  run() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.account = this.k.account;
      this.values = {
        userName: this.account?.name ?? '',
        email: this.account?.email ?? '',
        theme: this.k.settings.get('theme'),
        // App installée sur un téléphone : le bas de l'écran appartient aux gestes
        // du système (accueil iOS/Android) ; les boutons évitent tout conflit.
        navigation: platform.installed ? 'buttons' : this.k.settings.get('navigation'),
        passcode: null,
      };
      this.el.classList.add('visible');
      this.#step(0);
    });
  }

  #screen(content, { next = null, nextLabel = 'Continuer', back = null, skip = null } = {}) {
    const page = h(
      'div.setup-page',
      h('div.setup-body', content),
      h(
        'div.setup-footer',
        next ? h('button.btn.btn-filled.block.setup-next', { type: 'button', onclick: next }, nextLabel) : null,
        skip ? h('button.btn.btn-plain.block', { type: 'button', onclick: skip.action }, skip.label) : null,
        back ? h('button.setup-back', { type: 'button', onclick: back }, icon('chevron-left', { size: 20 }), 'Retour') : null,
      ),
    );
    const previous = this.el.firstElementChild;
    this.el.append(page);
    const d = this.ui.animScale;
    if (previous) {
      animate(previous, [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-30%)' }], { duration: 300 * d, fill: 'forwards' }).then(() => previous.remove());
      animate(page, [{ opacity: 0, transform: 'translateX(30%)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 300 * d, easing: 'cubic-bezier(.2,.9,.3,1)' });
    }
    return page;
  }

  #choice(options, current, onSelect) {
    const wrap = h('div.setup-choices');
    const render = (value) => {
      wrap.replaceChildren(
        ...options.map((o) =>
          h(
            `button.setup-choice${o.value === value ? '.selected' : ''}`,
            { type: 'button', onclick: () => { onSelect(o.value); render(o.value); } },
            h(`div.setup-preview.${o.preview}`, o.previewContent ?? null),
            h('strong', o.label),
            o.detail ? h('small', o.detail) : null,
            h('span.setup-check', icon('check', { size: 14, stroke: 3 })),
          ),
        ),
      );
    };
    render(current);
    return wrap;
  }

  #step(n) {
    const steps = [
      () => {
        const word = h('div.setup-hello', GREETINGS[0]);
        let i = 0;
        const timer = setInterval(() => {
          if (!word.isConnected) return clearInterval(timer);
          i = (i + 1) % GREETINGS.length;
          animate(word, [{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' }).then(() => {
            word.textContent = GREETINGS[i];
            animate(word, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 300, fill: 'forwards' });
          });
        }, 1800);
        // Nouveau compte ajouté depuis les Réglages : on peut renoncer et revenir au propriétaire.
        const cancel = this.account && !this.account.owner ? { label: 'Annuler et revenir à la session précédente', action: () => this.ui.deleteAccount(this.account.id) } : null;
        this.#screen([h('div.setup-logo', icon('sparkles', { size: 40 })), word, h('p.setup-lead', `Bienvenue sur ${this.k.os.name}`)], { next: () => this.#step(1), nextLabel: 'Commencer', skip: cancel });
      },
      () => {
        const color = this.account?.color ?? this.k.settings.get('accent');
        const preview = h('div.setup-avatar');
        const renderPreview = () => preview.replaceChildren(avatar(this.values.userName.trim() || '?', { size: 84, color }));
        const name = h('input.setup-input', { type: 'text', placeholder: 'Prénom et nom', value: this.values.userName, autocomplete: 'name', maxlength: 40 });
        const email = h('input.setup-input', { type: 'email', placeholder: 'Adresse e-mail (facultatif)', value: this.values.email, autocomplete: 'email', inputmode: 'email', maxlength: 80 });
        const error = h('p.setup-error');
        const next = () => {
          if (!this.values.userName.trim()) {
            error.textContent = 'Indiquez votre nom pour créer votre compte.';
            animate(name, [{ transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 260 });
            name.focus();
            return;
          }
          if (this.values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.values.email.trim())) {
            error.textContent = 'Cette adresse e-mail ne semble pas valide.';
            email.focus();
            return;
          }
          this.#step(2);
        };
        name.addEventListener('input', () => {
          this.values.userName = name.value;
          error.textContent = '';
          renderPreview();
        });
        email.addEventListener('input', () => {
          this.values.email = email.value;
          error.textContent = '';
        });
        name.addEventListener('keydown', (e) => e.key === 'Enter' && email.focus());
        email.addEventListener('keydown', (e) => e.key === 'Enter' && next());
        renderPreview();
        setTimeout(() => name.focus(), 350);
        this.#screen(
          [
            h('h1', 'Votre compte'),
            h('p.setup-lead', 'Votre compte garde vos réglages, vos apps et vos données. D\'autres personnes pourront avoir le leur sur ce téléphone.'),
            preview,
            h('div.setup-fields', name, email),
            error,
          ],
          { next, back: () => this.#step(0) },
        );
      },
      () => {
        this.#screen(
          [
            h('h1', 'Apparence'),
            h('p.setup-lead', 'Choisissez un thème. Vous pourrez le modifier plus tard.'),
            this.#choice(
              [
                { value: 'light', label: 'Clair', preview: 'light' },
                { value: 'dark', label: 'Sombre', preview: 'dark' },
                { value: 'auto', label: 'Automatique', preview: 'auto' },
              ],
              this.values.theme,
              (v) => {
                this.values.theme = v;
                this.k.settings.set('theme', v);
              },
            ),
          ],
          { next: () => this.#step(3), back: () => this.#step(1) },
        );
      },
      () => {
        this.#screen(
          [
            h('h1', 'Navigation'),
            h('p.setup-lead', 'Comment préférez-vous naviguer ?'),
            this.#choice(
              [
                { value: 'gestures', label: 'Gestes', detail: 'Style iOS : balayez depuis le bas', preview: 'preview-gestures', previewContent: h('span.pill') },
                { value: 'buttons', label: 'Boutons', detail: 'Style Android : ◁ ○ ▢', preview: 'preview-buttons', previewContent: [icon('nav-back', { size: 12 }), icon('nav-home', { size: 12 }), icon('nav-recents', { size: 12 })] },
              ],
              this.values.navigation,
              (v) => {
                this.values.navigation = v;
                this.k.settings.set('navigation', v);
              },
            ),
          ],
          { next: () => this.#step(4), back: () => this.#step(2) },
        );
      },
      () => {
        let code = '';
        let first = null;
        const dots = h('div.pin-dots.setup-dots');
        const title = h('p.setup-lead', 'Choisissez un code à 4 chiffres pour protéger votre téléphone.');
        const renderDots = () => dots.replaceChildren(...Array.from({ length: 4 }, (_, i) => h(`span${i < code.length ? '.filled' : ''}`)));
        const press = (d) => {
          if (d === '⌫') code = code.slice(0, -1);
          else if (code.length < 4) code += d;
          renderDots();
          if (code.length === 4) {
            if (first === null) {
              first = code;
              code = '';
              title.textContent = 'Confirmez votre code.';
              setTimeout(renderDots, 150);
            } else if (first === code) {
              this.values.passcode = code;
              setTimeout(() => this.#step(5), 200);
            } else {
              first = null;
              code = '';
              title.textContent = 'Les codes ne correspondent pas. Recommencez.';
              animate(dots, [{ transform: 'translateX(-10px)' }, { transform: 'translateX(10px)' }, { transform: 'translateX(0)' }], { duration: 300 });
              setTimeout(renderDots, 150);
            }
          }
        };
        renderDots();
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
        this.#screen(
          [
            h('h1', 'Code de verrouillage'),
            title,
            dots,
            h('div.setup-keypad', keys.map((k) => (k ? h('button.pin-key.small', { type: 'button', onclick: () => press(k) }, k) : h('span')))),
          ],
          { back: () => this.#step(3), skip: { label: 'Ne pas définir de code', action: () => { this.values.passcode = null; this.#step(5); } } },
        );
      },
      () => {
        this.#screen(
          [
            h('div.setup-logo.done', icon('check', { size: 40, stroke: 3 })),
            h('h1', this.values.userName.trim() ? `C'est prêt, ${this.values.userName.trim()} !` : "C'est prêt !"),
            h('p.setup-lead', 'Astuce : balayez vers le haut depuis le bas de l\'écran pour revenir à l\'accueil, et tirez la barre d\'état pour les notifications.'),
          ],
          { next: () => this.#finish(), nextLabel: 'Accéder à l\'accueil', back: () => this.#step(4) },
        );
      },
    ];
    steps[n]();
  }

  async #finish() {
    const s = this.k.settings;
    if (this.values.userName.trim()) s.set('userName', this.values.userName.trim());
    if (this.account) this.k.accounts.update(this.account.id, { name: this.values.userName.trim(), email: this.values.email.trim(), lastLogin: Date.now() });
    s.set('theme', this.values.theme);
    s.set('navigation', this.values.navigation);
    if (this.values.passcode) {
      try {
        s.set('passcode', await createPasscode(this.values.passcode));
      } catch (error) {
        this.ui.dialogs.toast(`Code non enregistré : ${error.message}`);
      }
    }
    s.set('setupDone', true);
    this.k.notifications.post({
      appId: 'settings',
      title: `Bienvenue sur ${this.k.os.name}`,
      body: 'Découvrez les astuces dans Fichiers → Documents → Bienvenue.txt',
      intent: { action: 'view', type: 'text/plain', data: { path: '/home/Documents/Bienvenue.txt' } },
    });
    await animate(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: this.ui.dur(400), fill: 'forwards' });
    this.el.classList.remove('visible');
    this.el.replaceChildren();
    this.el.getAnimations?.().forEach((a) => a.cancel());
    this.resolve();
  }
}
