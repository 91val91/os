/**
 * Contexte d'exécution fourni à chaque application (son « SDK »).
 *
 * Toutes les ressources acquises via le contexte (abonnements, minuteries)
 * sont libérées automatiquement à la fermeture du processus.
 */
import { EventBus } from '../kernel/events.js';
import { sandbox, USER_SPACE } from '../kernel/vfs.js';

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
    contacts: kernel.contacts,
    telephony: kernel.telephony,
    device: kernel.device,
    sound: ui.sound,
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
