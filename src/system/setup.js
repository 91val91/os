/**
 * Assistant de premier démarrage (et de chaque nouveau profil) : compte en
 * ligne obligatoire (Google, Microsoft, iCloud, Yahoo ou autre adresse),
 * profil, apparence, navigation, code. Sa partie « compte en ligne » sert
 * aussi seule (link) : profil qui n'en a pas encore, ou changement depuis les
 * Réglages.
 */
import { h, animate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { avatar } from '../lib/ui.js';
import { createPasscode } from '../kernel/settings.js';
import { PROVIDERS, provider as providerById } from '../kernel/identity.js';
import { platform } from './platform.js';
import { signInWithProvider, providerBadge, nameFromEmail } from './sign-in.js';

const GREETINGS = ['Bonjour', 'Hello', 'Hola', 'Ciao', 'Hallo', 'Olá', 'Привет', 'こんにちは', 'مرحبا', '你好'];

export class SetupWizard {
  constructor(ui) {
    this.ui = ui;
    this.k = ui.kernel;
    this.el = ui.layers.setup;
  }

  /** Assistant complet. `resumed` : retour d'une connexion Google / Microsoft faite dans la page. */
  run({ resumed = null } = {}) {
    return this.#open('setup', () => (resumed ? this.#resume(resumed) : this.#go('hello')));
  }

  /**
   * Compte en ligne seulement. `required` : le profil n'en a pas encore et ne
   * peut pas continuer sans. Résout avec l'identité associée, ou null (annulé).
   */
  link({ required = false, provider = null, resumed = null } = {}) {
    return this.#open(required ? 'required' : 'link', () => {
      if (resumed) return this.#resume(resumed);
      if (provider) this.values.provider = provider;
      this.#go(provider ? 'signin' : 'provider');
    });
  }

  #open(mode, start) {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.mode = mode;
      this.account = this.k.account;
      const identity = this.k.identity?.identity ?? null;
      this.values = {
        userName: this.account?.name ?? '',
        provider: identity?.provider ?? null,
        email: identity?.email ?? this.account?.email ?? '',
        manual: false,
        error: '',
        theme: this.k.settings.get('theme'),
        // App installée sur un téléphone : le bas de l'écran appartient aux gestes
        // du système (accueil iOS/Android) ; les boutons évitent tout conflit.
        navigation: platform.installed ? 'buttons' : this.k.settings.get('navigation'),
        passcode: null,
      };
      this.el.classList.add('visible');
      start();
    });
  }

  /** Le compte en ligne n'est demandé que s'il y a un registre des comptes. */
  get #accounts() {
    return Boolean(this.k.accounts && this.account && this.k.identity);
  }

  #screen(content, { next = null, nextLabel = 'Continuer', back = null, skip = null } = {}) {
    const page = h(
      'div.setup-page',
      h('div.setup-body', content),
      h(
        'div.setup-footer',
        next ? h('button.btn.btn-filled.block.setup-next', { type: 'button', onclick: next }, nextLabel) : null,
        skip ? h('button.btn.btn-plain.block.setup-skip', { type: 'button', onclick: skip.action }, skip.label) : null,
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

  #shake(el) {
    animate(el, [{ transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 260 });
  }

  #go(step) {
    const steps = {
      hello: () => this.#hello(),
      provider: () => this.#provider(),
      signin: () => this.#signIn(),
      profile: () => this.#profile(),
      appearance: () => this.#appearance(),
      navigation: () => this.#navigation(),
      passcode: () => this.#passcode(),
      done: () => this.#done(),
    };
    steps[step]();
  }

  // ───────────── Étapes ─────────────

  #hello() {
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
    this.#screen([h('div.setup-logo', icon('sparkles', { size: 40 })), word, h('p.setup-lead', `Bienvenue sur ${this.k.os.name}`)], {
      next: () => this.#go(this.#accounts ? 'provider' : 'profile'),
      nextLabel: 'Commencer',
      skip: this.#leave(),
    });
  }

  /**
   * Sortie possible sans compte en ligne : profil tout juste ajouté depuis les
   * Réglages (retour à la session qui l'a créé), autre utilisateur, ou annuler
   * un changement de compte en ligne.
   */
  #leave() {
    const a = this.account;
    if (this.mode === 'link') return { label: 'Annuler', action: () => this.#close(null) };
    if (a && !a.owner && a.returnTo && this.k.accounts.get(a.returnTo)) return { label: 'Annuler et revenir à la session précédente', action: () => this.ui.cancelNewAccount(a) };
    if (a && (this.k.accounts?.list().length ?? 0) > 1) return { label: 'Changer d\'utilisateur', action: () => this.ui.showAccountPicker() };
    return null;
  }

  #provider() {
    const pick = (id) => {
      if (id !== this.values.provider) this.values.email = '';
      this.values.provider = id;
      this.values.manual = false;
      this.values.error = '';
      this.#go('signin');
    };
    const lead = {
      setup: 'Connectez le compte e-mail que vous utilisez déjà. Il est obligatoire : il identifie votre profil sur cet appareil.',
      required: `${this.account?.name ? `${this.account.name}, votre` : 'Votre'} profil doit maintenant être associé à un compte en ligne. Choisissez le vôtre pour continuer.`,
      link: 'Choisissez le compte en ligne à associer à votre profil.',
    }[this.mode];
    this.#screen(
      [
        h('h1', this.mode === 'link' ? 'Compte en ligne' : 'Connectez-vous'),
        h('p.setup-lead', lead),
        h(
          'div.setup-providers',
          PROVIDERS.map((p) =>
            h(
              'button.setup-provider',
              { type: 'button', dataset: { provider: p.id }, onclick: () => pick(p.id) },
              providerBadge(p, 40),
              h('span.setup-provider-text', h('strong', p.id === 'other' ? p.name : p.id === 'apple' ? 'iCloud' : p.name), h('small', p.id === 'apple' ? 'Apple' : p.service)),
              icon('chevron-right', { size: 18 }),
            ),
          ),
        ),
      ],
      { back: this.mode === 'setup' ? () => this.#go('hello') : null, skip: this.mode === 'setup' ? null : this.#leave() },
    );
  }

  #signIn() {
    const p = providerById(this.values.provider) ?? providerById('other');
    const methods = this.k.identity.methods(p.id);
    const error = h('p.setup-error', this.values.error);
    this.values.error = '';
    const title = p.id === 'other' ? 'Votre adresse e-mail' : `Compte ${p.id === 'apple' ? 'iCloud' : p.name}`;
    const head = [h('div.setup-provider-logo', providerBadge(p, 64)), h('h1', title)];
    const back = () => this.#go('provider');
    const succeeded = (identity, name = '') => {
      this.values.email = identity.email;
      this.values.provider = identity.provider;
      if (name && !this.values.userName.trim()) this.values.userName = name;
      if (this.mode === 'setup') return this.#go('profile');
      this.ui.dialogs?.toast(identity.verified ? 'Compte en ligne vérifié' : 'Compte en ligne enregistré');
      this.#close(identity);
    };

    // « Continuer avec Google / Microsoft » : le fournisseur authentifie la personne.
    if (methods.oidc && !this.values.manual) {
      let attempt = null;
      const page = this.#screen(
        [
          ...head,
          h('p.setup-lead', `Connectez-vous sur la page de ${p.name}. Orion reçoit seulement votre nom, votre adresse et l'identifiant de votre compte, jamais votre mot de passe.`),
          error,
        ],
        {
          next: async () => {
            const button = page.querySelector('.setup-next');
            button.disabled = true;
            button.textContent = 'En attente de la connexion…';
            error.textContent = '';
            try {
              attempt = signInWithProvider(this.k, p.id, { loginHint: this.values.email, purpose: this.mode === 'setup' ? 'setup' : 'link' });
              const { identity, name } = await attempt.promise;
              succeeded(identity, name);
            } catch (e) {
              error.textContent = e.message;
              button.disabled = false;
              button.textContent = `Continuer avec ${p.name}`;
            }
          },
          nextLabel: `Continuer avec ${p.name}`,
          skip: { label: 'Saisir mon adresse à la place', action: () => { attempt?.cancel(); this.values.manual = true; this.#go('signin'); } },
          back: () => { attempt?.cancel(); back(); },
        },
      );
      return;
    }

    const placeholder = p.domains[0] ? `nom@${p.domains[0]}` : 'nom@exemple.fr';
    const email = h('input.setup-input', { type: 'email', placeholder, value: this.values.email, autocomplete: 'username', inputmode: 'email', autocapitalize: 'off', spellcheck: false, maxlength: 120 });
    const password = methods.mail ? h('input.setup-input', { type: 'password', placeholder: 'Mot de passe', autocomplete: 'current-password', maxlength: 1024 }) : null;
    const hint = h('p.setup-note');
    const addMailbox = methods.mail ? h('input', { type: 'checkbox', checked: true }) : null;
    let hinted = '';
    const showHint = async () => {
      const value = email.value.trim().toLowerCase();
      if (!methods.mail || value === hinted || !/@.+\./.test(value)) return;
      hinted = value;
      const note = await this.k.mail.autoconfig(value).then((c) => c.note, () => '');
      if (hinted === value) hint.textContent = note || 'Avec la validation en deux étapes, utilisez un mot de passe d\'application créé dans la sécurité de votre compte.';
    };
    let page = null;
    const submit = async () => {
      error.textContent = '';
      const button = page.querySelector('.setup-next');
      button.disabled = true;
      button.textContent = methods.mail ? 'Connexion…' : 'Enregistrement…';
      try {
        const identity = methods.mail
          ? await this.k.identity.verifyWithMail({ provider: p.id, email: email.value, password: password.value, addMailbox: addMailbox.checked, name: this.values.userName.trim() })
          : this.k.identity.linkUnverified({ provider: p.id, email: email.value });
        succeeded(identity, this.values.userName.trim() ? '' : nameFromEmail(identity.email));
      } catch (e) {
        error.textContent = e.message;
        this.#shake(e.message.includes('adresse') ? email : password ?? email);
        button.disabled = false;
        button.textContent = methods.mail ? 'Se connecter' : 'Continuer';
      }
    };
    email.addEventListener('input', () => {
      this.values.email = email.value;
      error.textContent = '';
    });
    email.addEventListener('change', showHint);
    email.addEventListener('keydown', (e) => e.key === 'Enter' && (password ? password.focus() : submit()));
    password?.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    password?.addEventListener('input', () => (error.textContent = ''));
    if (this.values.email) showHint();
    setTimeout(() => (this.values.email && password ? password : email).focus(), 350);

    const unavailable = p.oidc
      ? `La connexion avec ${p.name} n'est pas activée sur cette copie d'Orion, et la vérification par la messagerie demande Orion installé (ordinateur ou machine virtuelle).`
      : 'La vérification par la messagerie demande Orion installé (ordinateur ou machine virtuelle).';
    page = this.#screen(
      [
        ...head,
        h(
          'p.setup-lead',
          methods.mail
            ? 'Orion vérifie l\'adresse en se connectant à votre messagerie. Le mot de passe ne sert qu\'à cela, sauf si vous relevez vos e-mails dans Orion (il est alors gardé par orion-server, sur cet appareil).'
            : 'Saisissez l\'adresse de votre compte.',
        ),
        h('div.setup-fields', email, password),
        methods.mail ? h('label.setup-check-row', addMailbox, h('span', 'Relever aussi mes e-mails dans Orion')) : null,
        methods.mail ? hint : h('p.setup-note', `${unavailable} L'adresse sera enregistrée comme non vérifiée ; vous pourrez la vérifier plus tard dans Réglages → Compte.`),
        error,
      ],
      {
        next: submit,
        nextLabel: methods.mail ? 'Se connecter' : 'Continuer',
        skip: methods.oidc ? { label: `Continuer avec ${p.name} à la place`, action: () => { this.values.manual = false; this.#go('signin'); } } : null,
        back,
      },
    );
  }

  /** Retour d'une connexion faite dans la page (app installée sur iPhone). */
  async #resume(resumed) {
    this.values.provider = resumed.provider;
    this.#screen([h('div.setup-logo', icon('shield', { size: 40 })), h('h1', 'Connexion…'), h('p.setup-lead', 'Vérification du compte auprès du fournisseur.')]);
    try {
      const { identity, name } = await resumed.finish();
      this.values.email = identity.email;
      if (name && !this.values.userName.trim()) this.values.userName = name;
      if (this.mode === 'setup') return this.#go('profile');
      this.ui.dialogs?.toast('Compte en ligne vérifié');
      this.#close(identity);
    } catch (e) {
      this.values.error = e.message;
      this.#go('signin');
    }
  }

  #profile() {
    const color = this.account?.color ?? this.k.settings.get('accent');
    const preview = h('div.setup-avatar');
    const renderPreview = () => preview.replaceChildren(avatar(this.values.userName.trim() || '?', { size: 84, color }));
    const name = h('input.setup-input', { type: 'text', placeholder: 'Prénom et nom', value: this.values.userName, autocomplete: 'name', maxlength: 40 });
    const error = h('p.setup-error');
    const next = () => {
      if (!this.values.userName.trim()) {
        error.textContent = 'Indiquez votre nom pour créer votre profil.';
        this.#shake(name);
        name.focus();
        return;
      }
      this.#go('appearance');
    };
    name.addEventListener('input', () => {
      this.values.userName = name.value;
      error.textContent = '';
      renderPreview();
    });
    name.addEventListener('keydown', (e) => e.key === 'Enter' && next());
    renderPreview();
    setTimeout(() => name.focus(), 350);
    const identity = this.k.identity?.identity;
    const p = identity && providerById(identity.provider);
    this.#screen(
      [
        h('h1', 'Votre profil'),
        h('p.setup-lead', 'Votre profil garde vos réglages, vos apps et vos données. D\'autres personnes pourront avoir le leur sur ce téléphone.'),
        preview,
        h('div.setup-fields', name),
        identity
          ? h('p.setup-identity', providerBadge(p, 20), h('span', identity.email), h(`span.identity-status${identity.verified ? '.verified' : ''}`, identity.verified ? 'vérifié' : 'non vérifié'))
          : null,
        error,
      ],
      { next, back: this.#accounts ? () => this.#go('provider') : () => this.#go('hello') },
    );
  }

  #appearance() {
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
      { next: () => this.#go('navigation'), back: () => this.#go('profile') },
    );
  }

  #navigation() {
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
      { next: () => this.#go('passcode'), back: () => this.#go('appearance') },
    );
  }

  #passcode() {
    let code = '';
    let first = null;
    const dots = h('div.pin-dots.setup-dots');
    const title = h('p.setup-lead', 'Choisissez un code à 4 chiffres pour protéger votre téléphone.');
    const renderDots = () => dots.replaceChildren(...Array.from({ length: 4 }, (_, i) => h(`span${i < code.length ? '.filled' : ''}`)));
    const press = (d) => {
      if (d === '⌫') code = code.slice(0, -1);
      else if (code.length < 4) code += d;
      renderDots();
      if (code.length < 4) return;
      if (first === null) {
        first = code;
        code = '';
        title.textContent = 'Confirmez votre code.';
        setTimeout(renderDots, 150);
      } else if (first === code) {
        this.values.passcode = code;
        setTimeout(() => this.#go('done'), 200);
      } else {
        first = null;
        code = '';
        title.textContent = 'Les codes ne correspondent pas. Recommencez.';
        animate(dots, [{ transform: 'translateX(-10px)' }, { transform: 'translateX(10px)' }, { transform: 'translateX(0)' }], { duration: 300 });
        setTimeout(renderDots, 150);
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
      { back: () => this.#go('navigation'), skip: { label: 'Ne pas définir de code', action: () => { this.values.passcode = null; this.#go('done'); } } },
    );
  }

  #done() {
    this.#screen(
      [
        h('div.setup-logo.done', icon('check', { size: 40, stroke: 3 })),
        h('h1', this.values.userName.trim() ? `C'est prêt, ${this.values.userName.trim()} !` : "C'est prêt !"),
        h('p.setup-lead', 'Astuce : balayez vers le haut depuis le bas de l\'écran pour revenir à l\'accueil, et tirez la barre d\'état pour les notifications.'),
      ],
      { next: () => this.#finish(), nextLabel: 'Accéder à l\'accueil', back: () => this.#go('passcode') },
    );
  }

  async #finish() {
    const s = this.k.settings;
    if (this.values.userName.trim()) s.set('userName', this.values.userName.trim());
    if (this.account) this.k.accounts.update(this.account.id, { name: this.values.userName.trim(), lastLogin: Date.now(), returnTo: null });
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
    await this.#close(null);
  }

  async #close(result) {
    await animate(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: this.ui.dur(400), fill: 'forwards' });
    this.el.classList.remove('visible');
    this.el.replaceChildren();
    this.el.getAnimations?.().forEach((a) => a.cancel());
    this.resolve(result);
  }
}
