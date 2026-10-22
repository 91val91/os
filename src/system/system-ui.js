/**
 * Interface système (« SystemUI ») : construit l'écran, démarre le noyau,
 * orchestre les états (démarrage → configuration → verrouillé → accueil →
 * application → récentes) et les entrées (gestes, boutons, clavier).
 */
import { h } from '../lib/dom.js';
import { avatar } from '../lib/ui.js';
import { viewport } from '../lib/gesture.js';
import { bootKernel } from '../kernel/kernel.js';
import { openBestBackend, deleteBackend, Namespace } from '../kernel/storage.js';
import { openSession, eraseAllAccounts } from '../kernel/accounts.js';
import { AlarmService } from '../kernel/alarms.js';
import { MANIFESTS } from '../apps/registry.js';
import { ThemeManager } from './theme.js';
import { SoundManager } from './sound.js';
import { Dialogs } from './dialogs.js';
import { WindowManager } from './window-manager.js';
import { StatusBar } from './statusbar.js';
import { Navigation } from './navigation.js';
import { HomeScreen } from './home.js';
import { AppDrawer } from './drawer.js';
import { NotificationShade } from './shade.js';
import { ControlCenter } from './control-center.js';
import { LockScreen } from './lockscreen.js';
import { Banners } from './banners.js';
import { CallScreen } from './call-screen.js';
import { AlarmScreen } from './alarm-screen.js';
import { SetupWizard } from './setup.js';
import { PowerManager, logo } from './power.js';
import { platform } from './platform.js';
import { DeveloperMode } from './developer.js';
import { UpdateManager } from './updates.js';

const LAYERS = ['wallpaper', 'home', 'drawer', 'windows', 'recents', 'navbar', 'lock', 'system', 'setup', 'shade', 'controlCenter', 'statusbar', 'banners', 'dialogs', 'hud', 'toasts', 'filters', 'boot', 'off'];
const SCREEN_W = 393;
const SCREEN_H = 852;

export class SystemUI {
  constructor(stage) {
    this.stage = stage;
    this.state = 'boot';
    this.animScale = 1;
    this.screenRadius = 0;
    this.lastActivity = Date.now();
    platform.applyClasses();
    this.#buildDom();
  }

  dur(ms) {
    return ms * this.animScale;
  }

  /** Mode développeur déverrouillé (mot de passe de l'appareil) : Terminal et options accessibles. */
  get developerUnlocked() {
    return Boolean(this.developer?.unlocked);
  }

  // ───────────── Construction de l'écran ─────────────

  #buildDom() {
    this.layers = {};
    this.screen = h('div#screen');
    for (const name of LAYERS) {
      const el = h(`div.layer.layer-${name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
      this.layers[name] = el;
      this.screen.append(el);
    }
    const button = (cls, label, handlers) => h(`button.hw-btn.${cls}`, { type: 'button', 'aria-label': label, title: label, ...handlers });
    this.powerButton = button('power', 'Bouton latéral (Alt+L, maintenir : menu)', {});
    this.device = h(
      'div#device',
      button('silent', 'Mode silencieux', { onclick: () => this.toggleSilent() }),
      button('vol-up', 'Volume + (Alt+↑)', { onclick: () => this.changeVolume(0.1) }),
      button('vol-down', 'Volume − (Alt+↓)', { onclick: () => this.changeVolume(-0.1) }),
      this.powerButton,
      h('div.screen-wrap', this.screen, h('div.camera-cutout')),
    );
    this.help = h(
      'aside.desk-help',
      h('div.desk-brand', logo(30), h('div', h('strong', 'Orion OS'), h('span', 'Système mobile web'))),
      h('h4', 'Gestes'),
      h('ul', [
        h('li', 'Glisser depuis le bas : accueil'),
        h('li', 'Glisser et maintenir : apps récentes'),
        h('li', 'Barre d\'état à gauche : notifications'),
        h('li', 'Barre d\'état à droite : centre de contrôle'),
        h('li', 'Bord gauche/droit : retour'),
        h('li', 'Appui long / clic droit : menus'),
      ]),
      h('h4', 'Clavier'),
      h('ul.keys', [
        h('li', h('kbd', 'Échap'), ' Retour'),
        h('li', h('kbd', 'Alt'), '+', h('kbd', 'H'), ' Accueil'),
        h('li', h('kbd', 'Alt'), '+', h('kbd', 'R'), ' Récentes'),
        h('li', h('kbd', 'Alt'), '+', h('kbd', 'N'), ' Notifications'),
        h('li', h('kbd', 'Alt'), '+', h('kbd', 'C'), ' Centre de contrôle'),
        h('li', h('kbd', 'Alt'), '+', h('kbd', 'L'), ' Verrouiller / réveiller'),
        h('li', h('kbd', 'Alt'), '+', h('kbd', 'P'), ' Marche/arrêt'),
        h('li', h('kbd', 'Alt'), '+', h('kbd', '↑'), h('kbd', '↓'), ' Volume'),
      ]),
    );
    this.stage.replaceChildren(this.device, this.help);
    this.#setupPowerButton();
    this.#fit();
    window.addEventListener('resize', () => this.#fit());
    window.visualViewport?.addEventListener('resize', () => this.#fit());
    window.visualViewport?.addEventListener('scroll', () => this.#fit());
  }

  /** Mode cadre (ordinateur) ou plein écran (téléphone). */
  #fit() {
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const fullscreen = vw <= 560 || (coarse && vw < 1000) || new URLSearchParams(location.search).has('fullscreen');
    document.body.classList.toggle('fullscreen', fullscreen);
    if (fullscreen) {
      viewport.scale = 1;
      this.device.style.transform = '';
      this.screenRadius = 0;
      // Hauteur réellement visible (le clavier virtuel d'iOS ne réduit pas 100dvh) ; iOS fait aussi
      // glisser la zone visible pour montrer le champ saisi : l'écran la suit.
      document.documentElement.style.setProperty('--app-h', `${Math.round(vh)}px`);
      document.documentElement.style.setProperty('--app-top', `${Math.round(window.visualViewport?.pageTop ?? 0)}px`);
    } else {
      const frameW = SCREEN_W + 28;
      const frameH = SCREEN_H + 28;
      const helpSpace = vw > 980 ? 300 : 0;
      const scale = Math.min(1, (vh - 32) / frameH, (vw - 32 - helpSpace) / frameW);
      viewport.scale = scale;
      document.documentElement.style.setProperty('--app-h', `${SCREEN_H}px`);
      document.documentElement.style.setProperty('--app-top', '0px');
      this.device.style.transform = `scale(${scale})`;
      this.screenRadius = 48;
    }
    this.help.classList.toggle('hidden', fullscreen || vw <= 980);
    const width = fullscreen ? vw : SCREEN_W;
    this.screen.style.setProperty('--icon-size', `${Math.round(Math.min(68, Math.max(52, width * 0.152)))}px`);
    this.screen.style.setProperty('--screen-radius', `${this.screenRadius}px`);
  }

  // ───────────── Démarrage ─────────────

  async powerOn() {
    this.power = new PowerManager(this);
    this.power.showBoot();
    const started = performance.now();
    // Session du compte courant : ses données vivent dans leur propre base.
    let session = null;
    try {
      session = await openSession();
    } catch (error) {
      console.warn('Comptes indisponibles', error);
    }
    const backend = session?.backend ?? (await openBestBackend().catch(() => undefined));
    // Stockage persistant pour que le téléphone n'efface pas le système de fichiers. Seulement
    // une fois installé : dans un onglet, Firefox afficherait une invite à chaque démarrage.
    if (platform.installed) {
      navigator.storage?.persisted?.().then((persisted) => persisted || navigator.storage.persist()).catch(() => {});
    }
    this.kernel = await bootKernel({ backend, accounts: session?.registry ?? null, accountId: session?.account.id, manifests: MANIFESTS, onProgress: (_, p) => this.power.setBootProgress(p) });
    window.orion = { kernel: this.kernel, ui: this };
    this.#syncAccount();
    this.developer = new DeveloperMode(this);
    this.developer.migrate();
    this.updates = new UpdateManager(this);
    await this.#watchOtherAlarms();

    const k = this.kernel;
    this.theme = new ThemeManager(this);
    this.sound = new SoundManager(k.settings);
    this.dialogs = new Dialogs(this);
    this.statusbar = new StatusBar(this);
    this.wm = new WindowManager(this);
    this.home = new HomeScreen(this);
    this.drawer = new AppDrawer(this);
    this.shade = new NotificationShade(this);
    this.controlCenter = new ControlCenter(this);
    this.lock = new LockScreen(this);
    this.banners = new Banners(this);
    this.calls = new CallScreen(this);
    this.alarmScreen = new AlarmScreen(this);
    this.nav = new Navigation(this);

    this.theme.start();
    this.statusbar.start();
    this.home.start();
    this.drawer.start();
    this.shade.start();
    this.controlCenter.start();
    this.lock.start();
    this.banners.start();
    this.calls.start();
    this.alarmScreen.start();
    this.nav.start();

    k.am.host = {
      launch: (appId, intent, opts) => this.wm.launch(appId, intent, opts),
      choose: (packages, intent) => this.dialogs.choose(packages, intent),
      focus: (pid) => this.wm.focus(pid),
    };
    k.permissions.prompter = (request) => this.dialogs.permission(request);
    this.#wireKernelEvents();
    this.#setupInput();
    this.#startTimers();

    const elapsed = performance.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(0, 1300 - elapsed)));
    this.power.setBootProgress(1);
    this.lock.lock();
    this.setState('locked');
    await this.power.hideBoot();

    if (!k.settings.get('setupDone')) {
      this.setState('setup');
      await new SetupWizard(this).run();
      this.lock.isLocked = false;
      this.lock.el.classList.remove('visible');
      this.setState('home');
    }
    this.#prefetchApps();
    this.updates.start();
  }

  /** Le nom du compte et celui des réglages (utilisé par les apps) restent identiques. */
  #syncAccount() {
    const { accounts, settings } = this.kernel;
    const account = this.kernel.account;
    if (!accounts || !account) return;
    // Appareil configuré avant les comptes : le propriétaire reprend le nom déjà choisi.
    if (!account.name && settings.get('setupDone')) accounts.update(account.id, { name: settings.get('userName') });
    else if (account.name && settings.get('userName') !== account.name) settings.set('userName', account.name);
    settings.watch('userName', (name) => name && accounts.update(account.id, { name }));
  }

  // ───────────── Comptes ─────────────

  /**
   * Réveils et minuteurs des autres comptes : ils sonnent aussi pendant cette
   * session (leurs rappels de calendrier attendent le retour de leur titulaire).
   */
  async #watchOtherAlarms() {
    this.otherAlarms = [];
    const { accounts, account } = this.kernel;
    for (const other of accounts?.list() ?? []) {
      if (other.id === account?.id) continue;
      try {
        const backend = await openBestBackend(globalThis, { name: other.db });
        const service = await new AlarmService({ store: new Namespace(backend, 'alarms'), now: this.kernel.now }).load();
        this.otherAlarms.push({ account: other, service });
      } catch (error) {
        console.warn(`Réveils de ${other.name} indisponibles`, error);
      }
    }
  }

  /** Renonce à un compte tout juste créé et revient à la session qui l'a créé. */
  async cancelNewAccount(account) {
    const accounts = this.kernel.accounts;
    await accounts.remove(account.id);
    if (accounts.get(account.returnTo)) await accounts.setCurrent(account.returnTo);
    await this.power.restart('Retour à la session précédente…');
  }

  /** Ouvre la session d'un autre compte (redémarrage sur ses données). */
  async switchAccount(id) {
    const accounts = this.kernel.accounts;
    const target = accounts?.get(id);
    if (!target || id === this.kernel.account?.id) return;
    await accounts.setCurrent(id);
    await this.power.restart(target.name ? `Ouverture de la session de ${target.name}…` : 'Nouvel utilisateur…');
  }

  /** Supprime un compte et ses données (pas celui du propriétaire). */
  async deleteAccount(id) {
    const accounts = this.kernel.accounts;
    const account = accounts?.get(id);
    if (!account || account.owner) return false;
    const self = id === this.kernel.account?.id;
    await accounts.remove(id);
    // Compte en cours : sa base est ouverte, elle sera effacée au redémarrage (session du propriétaire).
    if (self) {
      await this.power.restart('Suppression du compte…');
      return true;
    }
    this.otherAlarms = this.otherAlarms.filter((entry) => entry.account.id !== id);
    // Encore ouverte dans une autre fenêtre : elle sera effacée à un prochain démarrage.
    if (await deleteBackend(globalThis, account.db).catch(() => false)) await accounts.forgetRemoved(account.db);
    return true;
  }

  /** Réinitialisation d'usine : efface tous les comptes (propriétaire) ou les données du compte. */
  async eraseDevice() {
    const k = this.kernel;
    await k.factoryReset();
    if (k.accounts && k.account?.owner) await eraseAllAccounts(k.accounts);
    location.reload();
  }

  /** Liste des comptes pour changer d'utilisateur (écran verrouillé, volet). */
  async showAccountPicker({ manage = false } = {}) {
    const accounts = this.kernel.accounts;
    if (!accounts) return;
    const current = this.kernel.account;
    const actions = accounts.list().map((a) => ({
      label: a.id === current?.id ? `${a.name || 'Moi'} · actuel` : a.name || 'Nouvel utilisateur',
      value: a.id,
      leading: avatar(a.name, { size: 30, color: a.color, photo: a.photo }),
      disabled: a.id === current?.id,
    }));
    if (manage) actions.push({ label: 'Gérer les comptes', value: 'manage', icon: 'settings' });
    const choice = await this.dialogs.actionSheet({ title: 'Changer d\'utilisateur', actions });
    if (choice === 'manage') this.openIntent({ app: 'settings', action: 'view', data: { page: 'users' } });
    else if (choice) await this.switchAccount(choice);
  }

  /** Précharge les modules des apps (démarrage plus rapide, cache hors ligne). */
  #prefetchApps() {
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
    idle(() => {
      for (const pkg of this.kernel.packages.list({ installed: null })) {
        pkg
          .load()
          .then((module) => module.styles?.forEach((href) => fetch(href).catch(() => {})))
          .catch(() => {});
      }
    });
  }

  #wireKernelEvents() {
    const k = this.kernel;
    k.events.on('power:request', ({ action }) => {
      if (action === 'lock') this.lockNow();
      if (action === 'reboot') this.power.reboot();
      if (action === 'shutdown') this.power.shutdown();
    });
    k.events.on('battery:change', (b) => {
      if (b.previous != null && b.previous > 0.2 && b.level <= 0.2 && !b.charging) {
        k.notifications.post({ appId: 'settings', title: 'Batterie faible', body: `${Math.round(b.level * 100)} % restants. Activez l'économiseur de batterie.`, tag: 'battery', intent: { app: 'settings', action: 'view', data: { page: 'battery' } } });
      }
    });
    k.events.on('package:install', ({ id }) => {
      const pkg = k.packages.get(id);
      if (this.state !== 'boot') this.dialogs.toast(`${pkg.name} installée`, { icon: 'check-circle' });
    });
  }

  #startTimers() {
    const k = this.kernel;
    setInterval(() => {
      k.alarms.tick();
      for (const { account, service } of this.otherAlarms ?? []) {
        for (const alarm of service.tick(undefined, { kinds: ['alarm', 'timer'] })) this.alarmScreen.ring(alarm, { account, service });
      }
      k.device.tick();
      this.#checkAutoLock();
    }, 1000);
  }

  #checkAutoLock() {
    const seconds = this.kernel.settings.get('autoLock');
    if (!seconds || ['off', 'boot', 'setup'].includes(this.state)) return;
    if (this.kernel.telephony.call || this.alarmScreen.isVisible) return;
    if (Date.now() - this.lastActivity > seconds * 1000) this.screenOff();
  }

  // ───────────── États ─────────────

  setState(state) {
    this.state = state;
    this.screen.dataset.state = state;
    this.statusbar?.refreshStyle();
    // Une app ouverte de façon asynchrone après un toucher doit aussi intercepter Retour.
    setTimeout(() => this.#armHistory(), 0);
  }

  /** Ferme volets, tiroir, menus et dialogues (sauf `except`). */
  closeOverlays({ except = null } = {}) {
    if (except !== this.shade && this.shade?.isOpen) this.shade.close();
    if (except !== this.controlCenter && this.controlCenter?.isOpen) this.controlCenter.close();
    if (except !== this.drawer && this.drawer?.isOpen) this.drawer.close(true);
    this.contextMenuClose?.();
    this.powerMenuClose?.();
  }

  async launch(appId, intent = { action: 'main' }, options = {}) {
    if (this.lock.isLocked) {
      await this.lock.unlock({ then: () => this.launch(appId, intent, options) });
      return;
    }
    this.closeOverlays();
    this.home.exitEditMode();
    try {
      return await this.wm.launch(appId, intent, options);
    } catch (error) {
      this.dialogs.toast(error.message);
    }
  }

  /** Démarre un intent (explicite ou implicite) depuis l'interface système. */
  async openIntent(intent, { appId = null } = {}) {
    if (this.lock.isLocked) {
      await this.lock.unlock({ then: () => this.openIntent(intent, { appId }) });
      return;
    }
    this.closeOverlays();
    try {
      if (intent?.app || intent?.action) await this.kernel.am.start(intent);
      else if (appId) await this.launch(appId);
    } catch (error) {
      this.dialogs.toast(error.message);
    }
  }

  async goHome() {
    if (this.dialogs.open) this.dialogs.closeAll();
    this.closeOverlays();
    if (this.state === 'locked' || this.state === 'setup' || this.state === 'off') return;
    if (this.calls.isVisible && this.calls.minimize()) return;
    if (this.state === 'recents') {
      await this.wm.closeRecents();
      this.setState('home');
      return;
    }
    if (this.state === 'home') {
      if (!this.home.exitEditMode()) this.home.setPage(0);
      return;
    }
    this.setState('home');
    await this.wm.minimize();
  }

  async back() {
    if (this.dialogs.closeTop()) return;
    if (this.contextMenuClose) return this.contextMenuClose();
    if (this.powerMenuClose) return this.powerMenuClose();
    if (this.shade.isOpen) return this.shade.close();
    if (this.controlCenter.isOpen) return this.controlCenter.close();
    if (this.calls.isVisible) return void this.calls.minimize();
    if (this.state === 'locked') return;
    if (this.drawer.isOpen) return void this.drawer.close();
    if (this.state === 'recents') return this.goHome();
    if (this.state === 'home') return void this.home.exitEditMode();
    if (this.state === 'app') await this.wm.back();
  }

  showRecents() {
    if (!['home', 'app'].includes(this.state)) return;
    this.closeOverlays();
    this.home.exitEditMode();
    this.wm.showRecents();
  }

  toggleRecents() {
    if (this.state === 'recents') this.goHome();
    else this.showRecents();
  }

  onUnlocked() {
    const fg = this.wm.currentWindow;
    this.setState(fg ? 'app' : 'home');
    const account = this.kernel.account;
    if (account) this.kernel.accounts.update(account.id, { lastLogin: Date.now() });
  }

  lockNow() {
    this.developer.lock();
    // Les apps au premier plan restent ouvertes derrière l'écran verrouillé : elles en sont prévenues.
    this.kernel.events.emit('device:lock', {});
    this.closeOverlays();
    this.dialogs.closeAll();
    if (this.state === 'recents') this.wm.closeRecents();
    this.home.exitEditMode();
    this.drawer.close(true);
    this.lock.lock();
    this.setState('locked');
    this.sound.lock();
  }

  // ───────────── Écran et bouton latéral ─────────────

  screenOff() {
    if (this.state === 'off' || this.state === 'boot') return;
    if (this.state !== 'setup') this.lockNow();
    this.stateBeforeOff = this.state;
    this.layers.off.replaceChildren();
    this.layers.off.classList.add('visible');
    this.setState('off');
  }

  wake() {
    if (this.poweredOff) return;
    this.layers.off.classList.remove('visible');
    this.lastActivity = Date.now();
    this.setState(this.stateBeforeOff === 'setup' ? 'setup' : 'locked');
    if (this.lock.isLocked) this.lock.render();
  }

  wakeForNotification() {
    this.wake();
    clearTimeout(this.sleepAgain);
    this.sleepAgain = setTimeout(() => {
      if (this.state === 'locked' && Date.now() - this.lastActivity > 7000) this.screenOff();
    }, 8000);
  }

  pressPower() {
    if (this.poweredOff) return this.power.powerOn();
    if (this.alarmScreen.isVisible) return this.alarmScreen.dismiss();
    if (this.kernel?.telephony.call?.state === 'incoming') {
      this.sound.stopLoop('ring');
      return;
    }
    if (this.state === 'off') this.wake();
    else this.screenOff();
  }

  #setupPowerButton() {
    let timer = null;
    let long = false;
    const btn = this.powerButton;
    btn.addEventListener('pointerdown', () => {
      long = false;
      timer = setTimeout(() => {
        long = true;
        if (this.kernel && !this.poweredOff) {
          if (this.state === 'off') this.wake();
          this.power.showMenu();
        }
      }, 650);
    });
    const up = () => {
      clearTimeout(timer);
      if (!long && this.kernel) this.pressPower();
      long = true;
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointerleave', () => clearTimeout(timer));
  }

  toggleSilent() {
    if (!this.kernel) return;
    const silent = this.kernel.settings.toggle('silent');
    this.dialogs.toast(silent ? 'Mode silencieux activé' : 'Sonnerie activée', { icon: silent ? 'bell-off' : 'bell' });
  }

  changeVolume(delta) {
    if (!this.kernel) return;
    const s = this.kernel.settings;
    const value = Math.round(Math.min(1, Math.max(0, s.get('volume') + delta)) * 10) / 10;
    s.set('volume', value);
    this.power.showVolume(value);
    this.sound.volumeTick();
    this.lastActivity = Date.now();
  }

  emergencyCall() {
    try {
      this.kernel.telephony.dial('112');
    } catch (error) {
      this.dialogs.toast(error.message);
    }
  }

  // ───────────── Entrées ─────────────

  #setupInput() {
    const activity = () => (this.lastActivity = Date.now());
    this.screen.addEventListener('pointerdown', (e) => {
      activity();
      if (this.state === 'off') {
        // Sur un téléphone il n'y a pas de bouton latéral : toucher l'écran rallume.
        if (this.poweredOff) this.power.powerOn();
        else this.wake();
      }
      if (this.kernel.settings.get('showTouches')) this.#touchDot(e);
    }, true);
    // Pas de menu contextuel du navigateur (appui long sur une image ou un lien).
    this.screen.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('input, textarea, [contenteditable="true"], .selectable')) e.preventDefault();
    });
    // Au retour dans l'app (dont les minuteurs étaient suspendus, sur iPhone notamment) :
    // verrouille si le délai d'inactivité est dépassé, sans éteindre l'écran que l'on regarde.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const seconds = this.kernel.settings.get('autoLock');
      const idle = seconds && Date.now() - this.lastActivity > seconds * 1000;
      if (idle && !['off', 'boot', 'setup', 'locked'].includes(this.state) && !this.kernel.telephony.call && !this.alarmScreen.isVisible) this.lockNow();
      activity();
    });
    this.#setupHistory();
    this.screen.addEventListener('click', (e) => {
      if (e.target.closest('button, [role="button"], .tappable')) this.sound.click();
    });
    window.addEventListener('keydown', (e) => {
      activity();
      const typing = e.target.closest?.('input, textarea, [contenteditable="true"]');
      if (e.altKey) {
        const actions = {
          h: () => this.goHome(),
          r: () => this.toggleRecents(),
          n: () => (this.shade.isOpen ? this.shade.close() : this.shade.open()),
          c: () => (this.controlCenter.isOpen ? this.controlCenter.close() : this.controlCenter.open()),
          l: () => this.pressPower(),
          p: () => this.power.showMenu(),
          arrowup: () => this.changeVolume(0.1),
          arrowdown: () => this.changeVolume(-0.1),
        };
        const action = actions[e.key.toLowerCase()];
        if (action && this.state !== 'boot') {
          e.preventDefault();
          action();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (typing) e.target.blur();
        if (!this.lock.pinVisible) this.back();
      }
    });
  }

  /** Y a-t-il quelque chose à fermer avec « Retour » ? */
  canGoBack() {
    if (['boot', 'off', 'setup'].includes(this.state)) return false;
    // Ce que back() ferme même sur l'écran verrouillé.
    const overlay = Boolean(
      this.dialogs.open || this.shade.isOpen || this.controlCenter.isOpen || this.calls.isVisible || this.contextMenuClose || this.powerMenuClose,
    );
    if (this.state === 'locked') return overlay;
    return overlay || this.state !== 'home' || this.drawer.isOpen || this.home.editing;
  }

  /**
   * Relie le bouton / geste Retour du téléphone (et du navigateur) au Retour
   * d'Orion : une entrée d'historique « garde » est ajoutée tant qu'il y a
   * quelque chose à fermer, et l'événement popstate déclenche back().
   * Sans cela, Retour fermerait l'application installée.
   */
  #setupHistory() {
    this.historyReady = true;
    // Chrome ignore les entrées ajoutées sans geste de l'utilisateur : on arme après chaque toucher.
    window.addEventListener('pointerup', () => setTimeout(() => this.#armHistory(), 0), true);
    // Sur écran tactile, le clic d'un toucher arrive après ce délai : ce qu'il ouvre est armé ici.
    window.addEventListener('click', () => setTimeout(() => this.#armHistory(), 0), true);
    window.addEventListener('popstate', () => {
      if (this.state === 'off') return;
      this.back();
      setTimeout(() => this.#armHistory(), 0);
    });
  }

  #armHistory() {
    if (this.historyReady && !history.state?.orion && this.canGoBack()) history.pushState({ orion: true }, '');
  }

  #touchDot(e) {
    const rect = this.screen.getBoundingClientRect();
    const dot = h('div.touch-dot', { style: { left: `${(e.clientX - rect.left) / viewport.scale}px`, top: `${(e.clientY - rect.top) / viewport.scale}px` } });
    this.screen.append(dot);
    setTimeout(() => dot.remove(), 500);
  }
}
