/**
 * Faux orion-server en mémoire pour les tests (mêmes routes que server/API.md).
 */
import { createHash } from 'node:crypto';

export function fakeBridge({ capabilities = { wifi: true, network: true, bluetooth: true, modem: true, gps: true, power: true } } = {}) {
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
  };

  function checkCode(code) {
    const { record } = state.protection;
    if (!record) return true;
    const ok = createHash('sha256').update(`${record.salt}:${code}`).digest('hex') === record.hash;
    state.protection.failures = ok ? 0 : (state.protection.failures ?? 0) + 1;
    return ok;
  }

  async function fetch(url, { method = 'GET', headers = {}, body } = {}) {
    const path = String(url).replace(/^api\//, '').replace(/\?.*$/, '');
    const data = body ? JSON.parse(body) : undefined;
    requests.push({ method, path, url: String(url), headers, body: data });
    if (method === 'POST' && (headers['X-Orion'] !== '1' || headers['Content-Type'] !== 'application/json')) return response(fail(403, 'Requête refusée'));
    const route = routes[`${method} ${path}`];
    return response(route ? route(data) : fail(404, 'Introuvable'));
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
