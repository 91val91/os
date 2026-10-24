/**
 * Contexte d'exécution fourni à chaque application (son « SDK »).
 *
 * Toutes les ressources acquises via le contexte (abonnements, minuteries)
 * sont libérées automatiquement à la fermeture du processus.
 */
import { EventBus } from '../kernel/events.js';
import { sandbox, USER_SPACE } from '../kernel/vfs.js';
import { authorizeInWindow, redirectUri } from './sign-in.js';

/**
 * Façade d'un service : seulement les méthodes et propriétés listées. Les
 * champs internes (fs du noyau, réglages, pont matériel…) restent inaccessibles.
 */
function expose(service, methods, getters = []) {
  const api = {};
  for (const name of methods) api[name] = (...args) => service[name](...args);
  for (const name of getters) Object.defineProperty(api, name, { get: () => service[name], enumerable: true });
  return Object.freeze(api);
}

const CONTACTS_API = ['list', 'get', 'findByPhone', 'search', 'add', 'update', 'remove', 'nameFor'];
const TELEPHONY_API = ['threads', 'thread', 'unreadCount', 'sendSms', 'setActiveThread', 'markRead', 'deleteThread', 'callLog', 'clearCallLog', 'dial', 'answer', 'hangup', 'setCallOption', 'nameFor'];
const DEVICE_API = ['vibrate', 'info', 'uptime'];
const SOUND_API = ['click', 'notify', 'sent', 'shutter', 'dtmf', 'charge', 'volumeTick', 'startLoop', 'stopLoop', 'setPlaybackSession'];

export function createAppContext({ ui, proc, pkg }) {
  const kernel = ui.kernel;
  const appId = pkg.id;
  const lifecycle = new EventBus((error) => kernel.log.error(appId, error?.stack ?? String(error)));
  const disposers = new Set();
  const backHandlers = [];
  const dataDir = `/data/${appId}`;
  const storageFile = `${dataDir}/storage.json`;
  let storageCache = null;

  const track = (off) => {
    disposers.add(off);
    return () => {
      off();
      disposers.delete(off);
    };
  };

  /** Position : autorisation de l'app vérifiée à chaque demande, suivi arrêté si elle est retirée. */
  const location = {
    get available() {
      return Boolean(kernel.location.source);
    },
    async current(options) {
      if (!(await kernel.permissions.request(appId, 'location'))) throw new Error('Accès à la position refusé');
      return kernel.location.current(options);
    },
    async watch(fn, { onError } = {}) {
      if (!(await kernel.permissions.request(appId, 'location'))) throw new Error('Accès à la position refusé');
      const stop = kernel.location.watch(fn);
      const offError = kernel.events.on('location:change', ({ error }) => error && onError?.(error));
      const offPermission = kernel.events.on('permission:change', (e) => {
        if (e.appId === appId && kernel.permissions.check(appId, 'location') !== 'granted') {
          end();
          onError?.('Accès à la position retiré');
        }
      });
      const end = track(() => {
        stop();
        offError();
        offPermission();
      });
      return end;
    },
  };

  /**
   * Messagerie (comptes ajoutés dans les Réglages) : autorisation « E-mails »
   * demandée au premier usage et vérifiée à chaque appel. Les apps ne voient
   * des comptes que le nom et l'adresse.
   */
  const allowMail = async () => {
    if (!kernel.mail.available) throw new Error('La messagerie demande Orion installé (orion-server)');
    if (!(await kernel.permissions.request(appId, 'mail'))) throw new Error('Accès aux e-mails refusé');
  };
  const mailCall = (method) => async (...args) => {
    await allowMail();
    return kernel.mail[method](...args);
  };
  const mail = {
    get available() {
      return kernel.mail.available;
    },
    /** État de l'autorisation sans la demander : 'granted' | 'denied' | 'prompt'. */
    permission: () => kernel.permissions.check(appId, 'mail'),
    async accounts() {
      await allowMail();
      return (await kernel.mail.accounts()).map(({ id, name, address }) => ({ id, name, address }));
    },
    folders: mailCall('folders'),
    messages: mailCall('messages'),
    message: mailCall('message'),
    setFlags: mailCall('setFlags'),
    move: mailCall('move'),
    remove: mailCall('remove'),
    send: mailCall('send'),
  };

  /**
   * Internet (autorisation « Internet ») : Orion fait les requêtes de l'app,
   * jamais vers Orion lui-même ni vers le réseau local (voir kernel/net.js).
   */
  const allowNet = async () => {
    if (!(await kernel.permissions.request(appId, 'internet'))) throw new Error('Accès à Internet refusé');
  };
  const net = {
    permission: () => kernel.permissions.check(appId, 'internet'),
    get proxied() {
      return kernel.net.proxied;
    },
    async request(url, options) {
      await allowNet();
      return kernel.net.request(url, options);
    },
    /** Connexion à un service en ligne (OAuth) : fenêtre du service, retour sur src/auth.html. */
    async authorize(url) {
      await allowNet();
      return authorizeInWindow(url);
    },
    redirectUri: () => redirectUri(),
  };

  const storage = {
    get(key, fallback = null) {
      storageCache ??= kernel.fs.readJSON(storageFile, {});
      return key in storageCache ? storageCache[key] : fallback;
    },
    set(key, value) {
      storageCache ??= kernel.fs.readJSON(storageFile, {});
      storageCache[key] = value;
      kernel.fs.writeJSON(storageFile, storageCache);
    },
    remove(key) {
      storageCache ??= kernel.fs.readJSON(storageFile, {});
      delete storageCache[key];
      kernel.fs.writeJSON(storageFile, storageCache);
    },
  };

  const ctx = {
    pid: proc.pid,
    app: pkg,
    /** Dernier intent reçu (mis à jour quand l'app est relancée avec de nouvelles données). */
    get intent() {
      return kernel.processes.get(proc.pid)?.intent ?? proc.intent;
    },
    kernel: pkg.system ? kernel : null,
    system: pkg.system ? ui : null,
    // Fichiers : espace de l'utilisateur et données de l'app, pas les fichiers système.
    fs: sandbox(kernel.fs, [...USER_SPACE, dataDir]),
    dataDir,
    storage,
    // Appels et SMS réels (modem, apps du téléphone) et carnet d'adresses : réservés aux apps système.
    // Les façades protègent des erreurs, pas d'un code hostile : toutes les apps partagent la même page.
    contacts: pkg.system ? expose(kernel.contacts, CONTACTS_API) : null,
    telephony: pkg.system ? expose(kernel.telephony, TELEPHONY_API, ['call', 'network', 'mode']) : null,
    device: expose(kernel.device, DEVICE_API, ['battery', 'connectivity']),
    location,
    mail,
    net,
    sound: expose(ui.sound, SOUND_API),
    now: () => kernel.now(),
    log: (message) => kernel.log.info(appId, message),

    settings: {
      get: (key) => kernel.settings.get(key),
      set: pkg.system ? (key, value) => kernel.settings.set(key, value) : undefined,
      watch: (key, fn) => track(kernel.settings.watch(key, fn)),
    },

    /** Cycle de vie : 'pause' | 'resume' | 'intent' | 'destroy'. */
    on: (event, fn) => track(lifecycle.on(event, fn)),
    /** Abonnement à un événement du noyau. */
    subscribe: (event, fn) => track(kernel.events.on(event, fn)),
    get foreground() {
      return kernel.processes.get(proc.pid)?.state === 'foreground';
    },

    setTimeout(fn, ms) {
      const id = setTimeout(() => {
        disposers.delete(off);
        fn();
      }, ms);
      const off = () => clearTimeout(id);
      disposers.add(off);
      return off;
    },
    setInterval(fn, ms) {
      const id = setInterval(fn, ms);
      return track(() => clearInterval(id));
    },
    raf(fn) {
      let id = requestAnimationFrame(function loop(t) {
        if (fn(t) !== false) id = requestAnimationFrame(loop);
      });
      return track(() => cancelAnimationFrame(id));
    },

    notify: (options) => kernel.notifications.post({ ...options, appId }),
    startActivity: (intent) => kernel.am.start(intent, { callerPid: proc.pid }),
    startActivityForResult: (intent) => kernel.am.start(intent, { callerPid: proc.pid, forResult: true }),
    /** Termine l'activité et renvoie un résultat à l'appelant. */
    finish: (result = null) => kernel.am.finish(proc.pid, result),
    get forResult() {
      return kernel.am.isWaitingForResult(proc.pid);
    },
    exit: () => ui.wm.close(proc.pid),
    requestPermission: (perm) => kernel.permissions.request(appId, perm),

    alarms: {
      schedule: (options) => kernel.alarms.schedule({ ...options, appId }),
      update: (id, patch) => kernel.alarms.update(id, patch),
      cancel: (id) => kernel.alarms.cancel(id),
      list: () => kernel.alarms.list(appId),
    },

    media: {
      set: (metadata, handlers) => kernel.media.set(appId, metadata, handlers),
      update: (patch) => kernel.media.update(appId, patch),
      clear: () => kernel.media.clear(appId),
    },

    /** Gestion du bouton/geste Retour : renvoyer true si l'app l'a traité. */
    onBack(fn) {
      backHandlers.push(fn);
      return () => {
        const i = backHandlers.indexOf(fn);
        if (i >= 0) backHandlers.splice(i, 1);
      };
    },

    ui: {
      toast: (message, options) => ui.dialogs.toast(message, options),
      alert: (options) => ui.dialogs.alert(options),
      confirm: (options) => ui.dialogs.confirm(options),
      prompt: (options) => ui.dialogs.prompt(options),
      actionSheet: (options) => ui.dialogs.actionSheet(options),
      setStatusBar: (style) => ui.wm.setStatusBarStyle(proc.pid, style),
      vibrate: (pattern) => kernel.device.vibrate(pattern),
      /** Activité en direct affichée dans l'îlot de la barre d'état. */
      liveActivity: (options) => {
        const id = `${appId}:${options.id ?? 'main'}`;
        ui.statusbar.setActivity(id, { appId, ...options, onClick: options.onClick ?? (() => ui.launch(appId)) });
        const end = () => ui.statusbar.clearActivity(id);
        track(end);
        return {
          update: (patch) => ui.statusbar.setActivity(id, { appId, ...options, ...patch, onClick: options.onClick ?? (() => ui.launch(appId)) }),
          end,
        };
      },
      share: (intent) => kernel.am.start({ action: 'send', ...intent }, { callerPid: proc.pid }).catch((error) => ui.dialogs.toast(error.message)),
    },
  };

  async function runBack() {
    for (let i = backHandlers.length - 1; i >= 0; i--) {
      if (await backHandlers[i]()) return true;
    }
    return false;
  }

  function dispose() {
    lifecycle.emit('destroy');
    for (const off of [...disposers]) {
      try {
        off();
      } catch {
        /* ignoré */
      }
    }
    disposers.clear();
  }

  return { ctx, lifecycle, runBack, dispose };
}
