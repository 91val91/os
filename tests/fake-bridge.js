/**
 * Faux orion-server en mémoire pour les tests (mêmes routes que server/API.md).
 */
import { createHash } from 'node:crypto';

export function fakeBridge({ capabilities = { wifi: true, network: true, bluetooth: true, modem: true, gps: true, power: true, mail: true, net: true } } = {}) {
  const state = {
    wifi: {
      enabled: true,
      connected: null,
      known: new Set(['Maison']),
      networks: [
        { ssid: 'Maison', signal: 80, security: 'WPA2', frequency: 5180 },
        { ssid: 'Café', signal: 45, security: '', frequency: 2412 },
        { ssid: 'Voisin', signal: 30, security: 'WPA2', frequency: 2437 },
      ],
    },
    bt: { powered: true, discovering: false, devices: [{ address: 'AA:BB:CC:DD:EE:01', name: 'Écouteurs', paired: true, connected: false, trusted: true, icon: 'audio-headset', battery: 70 }] },
    modem: { available: true, enabled: true, state: 'registered', operator: 'Orion Mobile', signal: 64, technology: 'lte', sim: true, number: '+33600000000', registration: 'home', data: false },
    calls: [],
    sms: [],
    protection: {},
    // Messagerie (comme orion_mail : comptes sans mot de passe à l'extérieur, un dossier par nom).
    mail: { accounts: [], boxes: {}, sent: [], verified: [], next: 1 },
    netRequests: [],
    web: () => ({ status: 404, body: 'introuvable' }),
    gps: { available: true, fix: { lat: 48.8566, lon: 2.3522, alt: 35, speed: 0, heading: null, accuracy: 6, time: '2026-01-15T09:00:00Z', satellites: 9 } },
  };
  const requests = [];
  let nextCall = 1;
  let nextSms = 1;

  const ok = (body = { ok: true }) => ({ status: 200, body });
  const fail = (status, error) => ({ status, body: { error } });
  const wifiView = () => ({
    enabled: state.wifi.enabled,
    connected: state.wifi.connected ? { ...state.wifi.networks.find((n) => n.ssid === state.wifi.connected), ip: '192.168.1.23' } : null,
    networks: state.wifi.enabled ? state.wifi.networks.map((n) => ({ ...n, known: state.wifi.known.has(n.ssid), active: n.ssid === state.wifi.connected })) : [],
  });

  const routes = {
    'GET status': () => ok({ bridge: 'orion-server', version: '1.0.0', hostname: 'orion', simulated: true, capabilities }),
    'GET wifi': () => ok(wifiView()),
    'GET network': () => ok({ connectivity: state.wifi.connected ? 'full' : 'none', primary: state.wifi.connected ? { type: 'wifi', name: state.wifi.connected, device: 'wlan0', ip: '192.168.1.23' } : null }),
    'POST wifi/power': ({ enabled }) => {
      state.wifi.enabled = enabled;
      if (!enabled) state.wifi.connected = null;
      return ok();
    },
    'POST wifi/connect': ({ ssid, password }) => {
      const n = state.wifi.networks.find((x) => x.ssid === ssid);
      if (!n) return fail(404, 'Réseau introuvable');
      if (n.security && !state.wifi.known.has(ssid) && password !== 'orion1234') return fail(400, 'Mot de passe incorrect');
      state.wifi.known.add(ssid);
      state.wifi.connected = ssid;
      return ok();
    },
    'POST wifi/disconnect': () => {
      state.wifi.connected = null;
      return ok();
    },
    'POST wifi/forget': ({ ssid }) => {
      state.wifi.known.delete(ssid);
      if (state.wifi.connected === ssid) state.wifi.connected = null;
      return ok();
    },
    'GET bluetooth': () => ok({ available: true, powered: state.bt.powered, discovering: state.bt.discovering, devices: state.bt.powered ? state.bt.devices : [] }),
    'POST bluetooth/power': ({ enabled }) => {
      state.bt.powered = enabled;
      return ok();
    },
    'POST bluetooth/scan': () => {
      state.bt.discovering = true;
      state.bt.devices.push({ address: 'AA:BB:CC:DD:EE:02', name: 'Enceinte', paired: false, connected: false, trusted: false, icon: 'audio-card' });
      return ok();
    },
    'POST bluetooth/pair': ({ address }) => {
      const d = state.bt.devices.find((x) => x.address === address);
      Object.assign(d, { paired: true, trusted: true }); // comme BlueZ : appairé, pas encore connecté
      return ok();
    },
    'POST bluetooth/connect': ({ address }) => {
      const d = state.bt.devices.find((x) => x.address === address);
      if (!d.paired) return fail(400, 'Appareil non appairé');
      d.connected = true;
      return ok();
    },
    'POST bluetooth/disconnect': ({ address }) => {
      state.bt.devices.find((x) => x.address === address).connected = false;
      return ok();
    },
    'POST bluetooth/remove': ({ address }) => {
      state.bt.devices = state.bt.devices.filter((x) => x.address !== address);
      return ok();
    },
    'GET modem': () => ok({ ...state.modem }),
    'POST modem/power': ({ enabled }) => {
      state.modem.enabled = enabled;
      state.modem.state = enabled ? 'registered' : 'disabled';
      return ok();
    },
    'POST modem/data': ({ enabled }) => {
      state.modem.data = enabled;
      return ok();
    },
    'GET modem/calls': () => ok({ calls: state.calls.map((c) => ({ ...c })) }),
    'POST modem/call': ({ number }) => {
      const id = String(nextCall++);
      state.calls.push({ id, number, direction: 'outgoing', state: 'dialing' });
      return ok({ ok: true, id });
    },
    'POST modem/answer': ({ id }) => {
      state.calls.find((c) => c.id === id).state = 'active';
      return ok();
    },
    'POST modem/hangup': ({ id } = {}) => {
      state.calls = id ? state.calls.filter((c) => c.id !== id) : [];
      return ok();
    },
    'POST modem/sms': ({ number, text }) => {
      state.sms.push({ id: String(nextSms++), number, text, timestamp: null, state: 'sent' });
      return ok();
    },
    'GET modem/sms': () => ok({ messages: state.sms.map((m) => ({ ...m })) }),
    'POST modem/sms/delete': ({ id }) => {
      state.sms = state.sms.filter((m) => m.id !== id);
      return ok();
    },
    'GET gps': () => ok({ ...state.gps }),
    // Protection contre la réinitialisation gardée par le serveur (l'empreinte n'est jamais renvoyée).
    'GET protection': () => ok(state.protection.record ? { enabled: true, owner: state.protection.owner, since: 1, wait: 0 } : { enabled: false, wait: 0 }),
    'POST protection/enable': ({ record, owner }) => {
      if (state.protection.record) return fail(409, 'Déjà activée');
      Object.assign(state.protection, { record, owner, failures: 0 });
      return routes['GET protection']();
    },
    'POST protection/verify': ({ code }) => (checkCode(code) ? ok() : fail(403, 'Code incorrect')),
    'POST protection/disable': ({ code }) => {
      if (!checkCode(code)) return fail(403, 'Code incorrect');
      state.protection = {};
      return ok();
    },
    'POST protection/update': ({ code, record }) => {
      if (!checkCode(code)) return fail(403, 'Code incorrect');
      state.protection.record = record;
      return routes['GET protection']();
    },
    'GET mail': (_, q) => ok({ available: true, simulated: true, accounts: state.mail.accounts.filter((a) => !q.owner || a.owner === q.owner || !a.owner).map(publicAccount) }),
    'POST mail/autoconfig': ({ address }) => ok({ source: 'guess', username: address, imap: { host: `imap.${address.split('@')[1]}`, port: 993, security: 'ssl' }, smtp: { host: `smtp.${address.split('@')[1]}`, port: 465, security: 'ssl' }, saveSent: true, note: '' }),
    'POST mail/accounts/add': (body) => {
      if (body.password === 'faux') return fail(401, 'Connexion refusée par le serveur de réception');
      const account = { ...body, id: `acc${String(state.mail.next++).padStart(13, '0')}`, username: body.username || body.address };
      state.mail.accounts.push(account);
      state.mail.boxes[account.id] = { INBOX: [{ uid: 1, from: { name: 'Lucas', address: 'lucas@exemple.fr' }, to: [{ name: '', address: account.address }], cc: [], subject: 'Bonjour', date: 1, seen: false, flagged: false, answered: false, size: 10, attachments: false, preview: 'Salut', text: 'Salut' }], Envoyés: [] };
      return ok(publicAccount(account));
    },
    // Internet (orion-server fait la requête) : `state.web(requête)` imite les sites.
    'POST net/request': (body) => {
      state.netRequests.push(body);
      const reply = state.web(body);
      return reply.error ? fail(reply.status, reply.error) : ok({ ok: reply.status < 300, url: body.url, headers: {}, encoding: 'text', ...reply });
    },
    'POST mail/verify': (body) => {
      state.mail.verified.push(body.address);
      return body.password === 'faux' ? fail(401, 'Connexion refusée par le serveur de réception') : ok({ ok: true, address: body.address });
    },
    'POST mail/accounts/remove': ({ id }) => {
      if (!state.mail.accounts.some((a) => a.id === id)) return fail(404, 'Compte de messagerie introuvable');
      state.mail.accounts = state.mail.accounts.filter((a) => a.id !== id);
      return ok();
    },
    'GET mail/folders': (_, q) => mailBox(q.account, (box) => ok({ folders: Object.keys(box).map((id) => ({ id, name: id === 'INBOX' ? 'Réception' : id, role: id === 'INBOX' ? 'inbox' : 'sent', unread: box[id].filter((m) => !m.seen).length, total: box[id].length })) })),
    'GET mail/messages': (_, q) => mailBox(q.account, (box) => ok({ messages: (box[q.folder] ?? []).filter((m) => !q.q || m.subject.includes(q.q)).map(({ text, ...m }) => m), more: false, uidValidity: 1 })),
    'GET mail/message': (_, q) => mailBox(q.account, (box) => {
      const found = (box[q.folder] ?? []).find((m) => m.uid === Number(q.uid));
      return found ? ok({ ...found, html: false, attachments: [] }) : fail(404, 'Message introuvable');
    }),
    'POST mail/flags': ({ account, folder, uids, add = [], remove = [] }) => mailBox(account, (box) => {
      for (const m of box[folder].filter((x) => uids.includes(x.uid))) {
        for (const f of add) m[f] = true;
        for (const f of remove) m[f] = false;
      }
      return ok();
    }),
    'POST mail/delete': ({ account, folder, uids }) => mailBox(account, (box) => {
      box[folder] = box[folder].filter((m) => !uids.includes(m.uid));
      return ok({ ok: true, folder: null });
    }),
    'POST mail/send': (body) => mailBox(body.account, (box) => {
      state.mail.sent.push(body);
      box.Envoyés.push({ uid: 100 + state.mail.sent.length, from: { name: '', address: 'moi' }, to: body.to, cc: [], subject: body.subject, date: 2, seen: true, flagged: false, answered: false, size: 1, attachments: false, preview: body.text, text: body.text });
      return ok({ ok: true, messageId: '<x@orion.test>', refused: [], savedTo: 'Envoyés' });
    }),
  };

  const publicAccount = ({ password: _password, ...account }) => account;
  function mailBox(id, then) {
    const box = state.mail.boxes[id];
    return box && state.mail.accounts.some((a) => a.id === id) ? then(box) : fail(404, 'Compte de messagerie introuvable');
  }

  function checkCode(code) {
    const { record } = state.protection;
    if (!record) return true;
    const ok = createHash('sha256').update(`${record.salt}:${code}`).digest('hex') === record.hash;
    state.protection.failures = ok ? 0 : (state.protection.failures ?? 0) + 1;
    return ok;
  }

  async function fetch(url, { method = 'GET', headers = {}, body } = {}) {
    const path = String(url).replace(/^api\//, '').replace(/\?.*$/, '');
    const query = Object.fromEntries(new URLSearchParams(String(url).split('?')[1] ?? ''));
    const data = body ? JSON.parse(body) : undefined;
    requests.push({ method, path, url: String(url), headers, body: data });
    if (method === 'POST' && (headers['X-Orion'] !== '1' || headers['Content-Type'] !== 'application/json')) return response(fail(403, 'Requête refusée'));
    const route = routes[`${method} ${path}`];
    return response(route ? route(data, query) : fail(404, 'Introuvable'));
  }

  const response = ({ status, body }) => ({ ok: status < 400, status, json: async () => structuredClone(body) });

  return {
    state,
    requests,
    fetch,
    env: (extra = {}) => ({ location: { hostname: '127.0.0.1' }, fetch, ...extra }),
    /** Appel entrant qui sonne sur le modem. */
    ring(number) {
      const id = String(nextCall++);
      state.calls.push({ id, number, direction: 'incoming', state: 'ringing' });
      return id;
    },
    receive(number, text, timestamp = new Date().toISOString()) {
      state.sms.push({ id: String(nextSms++), number, text, timestamp, state: 'received' });
    },
  };
}

/** Laisse s'exécuter les promesses en attente (réponses du faux serveur). */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}
