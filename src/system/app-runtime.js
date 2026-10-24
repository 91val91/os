/**
 * Exécution des apps publiées sur le Store.
 *
 * Le code d'une app (un fichier HTML, CSS et JavaScript) s'exécute dans une
 * iframe isolée : sandbox="allow-scripts" sans allow-same-origin (origine
 * opaque : ni la page d'Orion, ni ses données, ni les cookies), sans
 * fenêtres, téléchargements ni navigation de la page principale, et une
 * politique de sécurité (CSP) qui interdit tout accès au réseau.
 *
 * L'app ne parle au système que par le SDK `orion` : des messages sur un
 * MessagePort, chacun vérifié ici (méthodes autorisées, tailles, cadence).
 *
 *   orion.app                         { id, name, version }
 *   orion.storage.get/set/remove/keys/clear   données de l'app (1 Mo)
 *   orion.ui.toast/alert/confirm/prompt
 *   orion.device.vibrate(motif) · orion.device.info()
 *   orion.notify({ title, body })
 *   orion.location.current()          autorisation « Localisation » déclarée
 *   orion.mail.status() · accounts() · folders() · messages() · message()
 *     · setFlags() · move() · remove() · send()   autorisation « E-mails » déclarée
 *                                     (comptes des Réglages, relevés par orion-server)
 *   orion.net.request(url, options) · authorize(url) · redirectUri() · status()
 *                                     autorisation « Internet » déclarée : Orion fait
 *                                     les requêtes (jamais vers lui ni le réseau local)
 *   orion.on('pause' | 'resume' | 'theme', fn) · orion.onBack(fn) · orion.close()
 *
 * Limite connue : une boucle infinie dans l'app peut ralentir Orion (le
 * navigateur décide si l'iframe a son propre processus).
 */
import { h } from '../lib/dom.js';
import { authorizeInWindow } from './sign-in.js';

export const styles = [];

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
const MAX_STORAGE = 1_048_576;
/** Requêtes Internet d'une app : au plus NET_LIMIT par minute, NET_PARALLEL à la fois. */
const NET_LIMIT = 300;
const NET_PARALLEL = 6;
const NET_BODY = 1_500_000; // caractères (1 Mo encodé en base64)
/** Envois d'e-mails par une app : au plus SEND_LIMIT par fenêtre de SEND_WINDOW. */
const SEND_LIMIT = 10;
const SEND_WINDOW = 600_000;

/** SDK injecté dans l'iframe, avant le code de l'app. */
const SDK = `(() => {
  'use strict';
  let port = null;
  let seq = 0;
  const queue = [];
  const pending = new Map();
  const listeners = { pause: [], resume: [], theme: [] };
  const backHandlers = [];
  const app = {};
  const send = (message) => (port ? port.postMessage(message) : queue.push(message));
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ id, method, args });
  });
  const theme = (value) => {
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  };
  async function back(id) {
    let handled = false;
    for (let i = backHandlers.length - 1; i >= 0 && !handled; i--) {
      try { handled = Boolean(await backHandlers[i]()); } catch (error) { console.error(error); }
    }
    send({ back: id, handled });
  }
  addEventListener('message', (event) => {
    if (port || event.source !== parent || !event.data || event.data.type !== 'orion:init') return;
    port = event.ports[0];
    Object.assign(app, event.data.app);
    Object.freeze(app);
    theme(event.data.theme);
    port.onmessage = ({ data }) => {
      if (data.event === 'back') return void back(data.id);
      if (data.event) {
        if (data.event === 'theme') theme(data.value);
        for (const fn of listeners[data.event] || []) { try { fn(data.value); } catch (error) { console.error(error); } }
        return;
      }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    queue.splice(0).forEach((message) => port.postMessage(message));
  });
  addEventListener('error', (event) => send({ id: 0, method: 'log', args: ['error', String(event.message)] }));
  addEventListener('unhandledrejection', (event) => send({ id: 0, method: 'log', args: ['error', String(event.reason && event.reason.message || event.reason)] }));
  window.orion = Object.freeze({
    app,
    storage: Object.freeze({
      get: (key) => call('storage.get', key),
      set: (key, value) => call('storage.set', key, value),
      remove: (key) => call('storage.remove', key),
      keys: () => call('storage.keys'),
      clear: () => call('storage.clear'),
    }),
    ui: Object.freeze({
      toast: (message) => call('ui.toast', String(message)),
      alert: (options) => call('ui.alert', typeof options === 'string' ? { title: options } : options),
      confirm: (options) => call('ui.confirm', typeof options === 'string' ? { title: options } : options),
      prompt: (options) => call('ui.prompt', typeof options === 'string' ? { title: options } : options),
    }),
    device: Object.freeze({
      vibrate: (pattern) => call('device.vibrate', pattern),
      info: () => call('device.info'),
    }),
    location: Object.freeze({ current: () => call('location.current') }),
    net: Object.freeze({
      status: () => call('net.status'),
      request: (url, options) => call('net.request', url, options || {}),
      authorize: (url) => call('net.authorize', url),
      redirectUri: () => call('net.redirectUri'),
    }),
    mail: Object.freeze({
      status: () => call('mail.status'),
      accounts: () => call('mail.accounts'),
      folders: (account) => call('mail.folders', account),
      messages: (account, folder, options) => call('mail.messages', account, folder, options || {}),
      message: (account, folder, uid) => call('mail.message', account, folder, uid),
      setFlags: (account, folder, uids, change) => call('mail.flags', account, folder, uids, change || {}),
      move: (account, folder, uids, to) => call('mail.move', account, folder, uids, to),
      remove: (account, folder, uids) => call('mail.delete', account, folder, uids),
      send: (account, message) => call('mail.send', account, message || {}),
    }),
    notify: (options) => call('notify', options),
    close: () => call('app.close'),
    on(event, fn) {
      if (!listeners[event] || typeof fn !== 'function') throw new Error('Événement inconnu : ' + event);
      listeners[event].push(fn);
      return () => listeners[event].splice(listeners[event].indexOf(fn) >>> 0, 1);
    },
    onBack(fn) {
      backHandlers.push(fn);
      return () => backHandlers.splice(backHandlers.indexOf(fn) >>> 0, 1);
    },
  });
})();`;

/** Document de l'iframe : CSP et SDK d'abord (l'app ne peut que les durcir), puis le code de l'app. */
export function appDocument(code) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light}html[data-theme=dark]{color-scheme:dark}body{margin:0;background:Canvas;color:CanvasText;font-family:system-ui,-apple-system,sans-serif;-webkit-tap-highlight-color:transparent}</style><script>${SDK}</script></head><body>${code}</body></html>`;
}

const text = (value, max) => String(value ?? '').slice(0, max);
const cloneable = (value) => {
  const json = JSON.stringify(value);
  return json === undefined ? null : JSON.parse(json);
};

/**
 * Services offerts à l'app, à partir du contexte d'une app d'Orion.
 * `test` : essai depuis la console développeur (données en mémoire, pas de notification).
 */
export function hostFromContext(ctx, { test = false } = {}) {
  const memory = new Map();
  const storage = test
    ? { get: (k) => memory.get(k) ?? null, set: (k, v) => memory.set(k, v), remove: (k) => memory.delete(k), all: () => Object.fromEntries(memory), clear: () => memory.clear() }
    : {
        get: (k) => ctx.storage.get(k),
        set: (k, v) => ctx.storage.set(k, v),
        remove: (k) => ctx.storage.remove(k),
        all: () => ctx.fs.readJSON(`${ctx.dataDir}/storage.json`, {}),
        // Clé par clé : le stockage de l'app garde une copie en mémoire.
        clear: () => Object.keys(ctx.fs.readJSON(`${ctx.dataDir}/storage.json`, {})).forEach((key) => ctx.storage.remove(key)),
      };
  return {
    storage,
    ui: ctx.ui,
    vibrate: (pattern) => ctx.device.vibrate(pattern),
    info: () => ({ battery: ctx.device.battery?.level ?? null, online: ctx.device.connectivity?.online ?? true, locale: 'fr-FR' }),
    notify: test ? (options) => ctx.ui.toast(`Notification (essai) : ${options.title}`) : (options) => ctx.notify(options),
    location: () => (test ? Promise.reject(new Error('Position indisponible pendant un essai')) : ctx.location.current()),
    // Pendant un essai, l'app n'est pas installée : pas d'accès aux vrais e-mails.
    mail: test ? null : ctx.mail,
    net: test ? trialNet(ctx) : ctx.net,
    close: () => (test ? null : ctx.exit()),
    log: (message) => ctx.log(message),
  };
}

/** Internet pendant un essai de la console : l'app n'est pas installée, on demande une fois. */
function trialNet(ctx) {
  let answer = null;
  const allow = async () => {
    answer ??= ctx.ui.confirm({ title: 'Accès à Internet', message: 'Pendant cet essai, l\'app peut contacter des sites sur Internet (jamais votre réseau local).', confirmLabel: 'Autoriser' }).then(Boolean);
    if (!(await answer)) throw new Error('Accès à Internet refusé');
  };
  return {
    permission: () => 'prompt',
    get proxied() {
      return ctx.kernel.net.proxied;
    },
    request: async (url, options) => {
      await allow();
      return ctx.kernel.net.request(url, options);
    },
    authorize: async (url) => {
      await allow();
      return authorizeInWindow(url, { confirm: (options) => ctx.ui.confirm(options) });
    },
    redirectUri: () => new URL('src/auth.html', new URL('./', location.href)).href,
  };
}

/**
 * Lance une app dans `root`. Renvoie { back(), emit(event, value), dispose() }.
 * @param {HTMLElement} root
 * @param {{ app: { id: string, name: string, version: string }, code: string, host: ReturnType<typeof hostFromContext>, onStop?: (reason: string) => void }} options
 */
export function runApp(root, { app, code, host, onStop = null }) {
  const frame = h('iframe.app-frame', { title: app.name });
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  const shell = h('div.app-runtime', frame);
  root.append(shell);
  const channel = new MessageChannel();
  const port = channel.port1;
  const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  let loads = 0;
  let stopped = false;
  let dialog = false;
  let lastToast = 0;
  let lastNotify = 0;
  let backSeq = 0;
  const backReplies = new Map();

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    port.close();
    frame.remove();
    shell.append(h('div.app-runtime-stopped', h('strong', `${app.name} a été arrêtée`), h('p', reason)));
    host.log?.(`arrêtée : ${reason}`);
    onStop?.(reason);
  }

  frame.addEventListener('load', () => {
    loads++;
    if (loads === 1) {
      frame.contentWindow.postMessage({ type: 'orion:init', app: { id: app.id, name: app.name, version: app.version }, theme: currentTheme() }, '*', [channel.port2]);
    } else {
      // L'app a rechargé ou quitté sa page : le SDK n'y est plus, elle est arrêtée.
      stop('Elle a tenté d\'ouvrir une autre page, ce qui est interdit aux apps du Store.');
    }
  });

  const storageSize = (data) => new Blob([JSON.stringify(data)]).size;
  const sends = [];
  const netTimes = [];
  const netQueue = [];
  let netActive = 0;
  let authorizing = false;
  const internet = () => {
    if (!host.net) throw new Error('Internet indisponible');
    return host.net;
  };
  /** Une requête à la fois par créneau : NET_PARALLEL en cours, les autres attendent. */
  async function netSlot(run) {
    const now = Date.now();
    while (netTimes.length && now - netTimes[0] > 60_000) netTimes.shift();
    if (netTimes.length >= NET_LIMIT) throw new Error('Trop de requêtes Internet : attendez une minute');
    netTimes.push(now);
    if (netActive >= NET_PARALLEL) await new Promise((resolve) => netQueue.push(resolve));
    netActive++;
    try {
      return await run();
    } finally {
      netActive--;
      netQueue.shift()?.();
    }
  }
  const headerMap = (value) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).slice(0, 50).map(([k, v]) => [text(k, 64), text(v, 4096)]));

  const mailbox = () => {
    if (!host.mail) throw new Error('Messagerie indisponible pendant un essai : publiez l\'app et installez-la pour utiliser vos comptes');
    return host.mail;
  };
  const uidList = (value) => (Array.isArray(value) ? value : [value]).slice(0, 1000).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const flagList = (value) => (Array.isArray(value) ? value : []).filter((f) => ['seen', 'flagged', 'answered'].includes(f));
  const people = (value) =>
    (Array.isArray(value) ? value : [])
      .slice(0, 100)
      .map((p) => (typeof p === 'string' ? { address: text(p, 254) } : { name: text(p?.name, 120), address: text(p?.address, 254) }));

  async function modal(fn) {
    if (dialog) throw new Error('Une boîte de dialogue est déjà ouverte');
    dialog = true;
    try {
      return await fn();
    } finally {
      dialog = false;
    }
  }

  const METHODS = {
    'storage.get': (key) => host.storage.get(text(key, 200)),
    'storage.set': (key, value) => {
      const data = { ...host.storage.all(), [text(key, 200)]: cloneable(value) };
      if (storageSize(data) > MAX_STORAGE) throw new Error('Espace de stockage de l\'app plein (1 Mo)');
      host.storage.set(text(key, 200), cloneable(value));
      return true;
    },
    'storage.remove': (key) => {
      host.storage.remove(text(key, 200));
      return true;
    },
    'storage.keys': () => Object.keys(host.storage.all()),
    'storage.clear': () => {
      host.storage.clear();
      return true;
    },
    'ui.toast': (message) => {
      if (Date.now() - lastToast < 800) return false;
      lastToast = Date.now();
      host.ui.toast(text(message, 160));
      return true;
    },
    'ui.alert': (o = {}) => modal(() => host.ui.alert({ title: text(o.title, 80) || app.name, message: text(o.message, 600) })).then(() => true),
    'ui.confirm': (o = {}) => modal(() => host.ui.confirm({ title: text(o.title, 80) || app.name, message: text(o.message, 600), confirmLabel: text(o.confirmLabel, 24) || 'OK' })).then(Boolean),
    // Le nom de l'app accompagne toute saisie : elle ne peut pas se faire passer pour Orion.
    'ui.prompt': (o = {}) => modal(() => host.ui.prompt({ title: text(o.title, 80) || app.name, message: [text(o.message, 600), `Demandé par l'app « ${app.name} »`].filter(Boolean).join(' — '), placeholder: text(o.placeholder, 80), value: text(o.value, 2000) })).then((v) => (v == null ? null : text(v, 2000))),
    'device.vibrate': (pattern) => {
      const list = (Array.isArray(pattern) ? pattern : [pattern]).slice(0, 10).map((n) => Math.max(0, Math.min(1000, Number(n) || 0)));
      host.vibrate(list.length === 1 ? list[0] : list);
      return true;
    },
    'device.info': () => ({ ...host.info(), theme: currentTheme() }),
    notify: (o = {}) => {
      if (Date.now() - lastNotify < 5000) throw new Error('Trop de notifications : attendez quelques secondes');
      lastNotify = Date.now();
      host.notify({ title: text(o.title, 80) || app.name, body: text(o.body, 300) });
      return true;
    },
    'location.current': async () => {
      const fix = await host.location();
      return fix && { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy ?? null, altitude: fix.alt ?? null, time: fix.time ?? null };
    },
    'net.status': () => ({ available: Boolean(host.net), permission: host.net ? host.net.permission() : 'denied', proxied: Boolean(host.net?.proxied) }),
    'net.request': (url, o = {}) =>
      netSlot(() =>
        internet().request(text(url, 4096), {
          method: text(o.method, 10) || 'GET',
          headers: headerMap(o.headers),
          body: o.body == null ? null : text(o.body, NET_BODY),
          bodyEncoding: o.bodyEncoding === 'base64' ? 'base64' : 'text',
          responseType: ['json', 'base64'].includes(o.responseType) ? o.responseType : 'text',
        }),
      ),
    'net.authorize': async (url) => {
      if (authorizing) throw new Error('Une connexion est déjà en cours');
      authorizing = true;
      try {
        return await internet().authorize(text(url, 4096));
      } finally {
        authorizing = false;
      }
    },
    'net.redirectUri': () => internet().redirectUri(),
    'mail.status': () => ({ available: Boolean(host.mail?.available), permission: host.mail ? host.mail.permission() : 'denied', test: !host.mail }),
    'mail.accounts': () => mailbox().accounts(),
    'mail.folders': (account) => mailbox().folders(text(account, 64)),
    'mail.messages': (account, folder, o = {}) =>
      mailbox().messages(text(account, 64), text(folder, 512), {
        before: Number.isInteger(o.before) && o.before > 0 ? o.before : null,
        limit: Math.max(1, Math.min(100, Number(o.limit) || 40)),
        query: text(o.query, 200),
        filter: ['unread', 'flagged'].includes(o.filter) ? o.filter : '',
      }),
    'mail.message': (account, folder, uid) => mailbox().message(text(account, 64), text(folder, 512), uidList(uid)[0] ?? 0),
    'mail.flags': (account, folder, uids, change = {}) => mailbox().setFlags(text(account, 64), text(folder, 512), uidList(uids), { add: flagList(change.add), remove: flagList(change.remove) }).then(() => true),
    'mail.move': (account, folder, uids, to) => mailbox().move(text(account, 64), text(folder, 512), uidList(uids), text(to, 512)),
    'mail.delete': (account, folder, uids) => mailbox().remove(text(account, 64), text(folder, 512), uidList(uids)),
    'mail.send': (account, m = {}) => {
      const now = Date.now();
      while (sends.length && now - sends[0] > SEND_WINDOW) sends.shift();
      if (sends.length >= SEND_LIMIT) throw new Error('Trop d\'e-mails envoyés en peu de temps : attendez quelques minutes');
      sends.push(now);
      return mailbox().send(text(account, 64), {
        to: people(m.to),
        cc: people(m.cc),
        bcc: people(m.bcc),
        subject: text(m.subject, 500),
        text: text(m.text, 100_000),
        inReplyTo: text(m.inReplyTo, 300),
        references: text(m.references, 4000),
      });
    },
    'app.close': () => {
      host.close();
      return true;
    },
    log: (level, message) => {
      host.log?.(`${level === 'error' ? 'erreur' : 'journal'} : ${text(message, 300)}`);
      return true;
    },
  };

  port.onmessage = async ({ data }) => {
    if (stopped || !data || typeof data !== 'object') return;
    if ('back' in data) {
      backReplies.get(data.back)?.(Boolean(data.handled));
      return;
    }
    const method = Object.hasOwn(METHODS, data.method) ? METHODS[data.method] : null;
    let reply;
    try {
      if (!method) throw new Error(`Fonction inconnue : ${String(data.method).slice(0, 40)}`);
      reply = { id: data.id, result: cloneable(await method(...(Array.isArray(data.args) ? data.args : []))) };
    } catch (error) {
      reply = { id: data.id, error: text(error?.message ?? error, 300) };
    }
    if (!stopped && data.id) port.postMessage(reply);
  };
  port.start?.();

  // Thème d'Orion suivi en direct.
  const observer = new MutationObserver(() => !stopped && port.postMessage({ event: 'theme', value: currentTheme() }));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  frame.srcdoc = appDocument(code);

  return {
    frame,
    /** Retour : l'app répond si elle l'a traité (300 ms au plus). */
    back() {
      if (stopped || loads === 0) return Promise.resolve(false);
      const id = ++backSeq;
      return new Promise((resolve) => {
        const done = (handled) => {
          backReplies.delete(id);
          resolve(handled);
        };
        backReplies.set(id, done);
        setTimeout(() => backReplies.has(id) && done(false), 300);
        port.postMessage({ event: 'back', id });
      });
    },
    emit(event, value = null) {
      if (!stopped) port.postMessage({ event, value });
    },
    dispose() {
      observer.disconnect();
      if (!stopped) {
        stopped = true;
        port.close();
      }
      shell.remove();
    },
  };
}

/** Point d'entrée d'une app publiée (paquet du Store) lancée par le gestionnaire de fenêtres. */
export function mount(root, ctx) {
  const app = ctx.app;
  root.classList.add('store-app');
  const run = runApp(root, { app, code: app.code, host: hostFromContext(ctx) });
  ctx.onBack(() => run.back());
  ctx.on('pause', () => run.emit('pause'));
  ctx.on('resume', () => run.emit('resume'));
  ctx.on('destroy', () => run.dispose());
}
