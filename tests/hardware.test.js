import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootKernel } from '../src/kernel/kernel.js';
import { HardwareBridge } from '../src/kernel/bridge.js';
import { NetworkService, signalBars } from '../src/kernel/network.js';
import { BluetoothService, unsupportedReason } from '../src/kernel/bluetooth.js';
import { LocationService, distance, formatCoordinates, toGpx } from '../src/kernel/location.js';
import { Settings } from '../src/kernel/settings.js';
import { EventBus } from '../src/kernel/events.js';
import { project, unproject, parseGpx, formatDistance } from '../src/apps/maps/index.js';
import { fakeBridge, settle } from './fake-bridge.js';
import { fakeClock, fakeTimers } from './helpers.js';

const MANIFESTS = [
  { id: 'phone', name: 'Téléphone', system: true },
  { id: 'messages', name: 'Messages', system: true },
  { id: 'maps', name: 'Plans', system: true, permissions: ['location'] },
];

async function boot(env) {
  const now = fakeClock();
  const timers = fakeTimers(now);
  const kernel = await bootKernel({ manifests: MANIFESTS, env, now, timers });
  await settle();
  return { kernel, now, timers };
}

// ───────────── Pont matériel ─────────────

test('pont : absent hors de l\'adresse locale, sans même une requête', async () => {
  let calls = 0;
  const bridge = await new HardwareBridge({ env: { location: { hostname: '91val91.github.io' }, fetch: async () => calls++ } }).detect();
  assert.equal(bridge.available, false);
  assert.equal(calls, 0);
});

test('pont : détecté sur 127.0.0.1, requêtes POST protégées, erreurs lisibles', async () => {
  const fake = fakeBridge();
  const bridge = await new HardwareBridge({ env: fake.env() }).detect();
  assert.equal(bridge.available, true);
  assert.equal(bridge.has('wifi'), true);
  assert.equal(bridge.simulated, true);
  await assert.rejects(bridge.post('wifi/connect', { ssid: 'Voisin', password: 'faux' }), /Mot de passe incorrect/);
  const post = fake.requests.at(-1);
  assert.equal(post.headers['X-Orion'], '1');
  assert.equal(post.headers['Content-Type'], 'application/json');
});

test('pont : pas cherché quand Orion est servi dans un sous-dossier (serveur de développement)', async () => {
  let calls = 0;
  const bridge = await new HardwareBridge({ env: { location: { hostname: '127.0.0.1', pathname: '/os/' }, fetch: async () => calls++ } }).detect();
  assert.equal(bridge.available, false);
  assert.equal(calls, 0);
});

test('pont : un serveur qui n\'est pas orion-server est ignoré', async () => {
  const env = { location: { hostname: 'localhost' }, fetch: async () => ({ ok: false, status: 404, json: async () => { throw new Error('html'); } }) };
  const bridge = await new HardwareBridge({ env }).detect();
  assert.equal(bridge.available, false);
});

// ───────────── Réseau ─────────────

test('réseau (navigateur) : type, qualité et hors ligne tels que le navigateur les connaît', async () => {
  const connection = { type: 'cellular', effectiveType: '3g', downlink: 1.4, rtt: 300, saveData: false, addEventListener() {} };
  const env = { navigator: { onLine: true, connection }, addEventListener() {} };
  const net = new NetworkService({ env, settings: new Settings() }).init();
  let st = net.state;
  assert.equal(st.type, 'cellular');
  assert.equal(st.qualityBars, 3);
  assert.equal(st.wifi.controllable, false);
  connection.type = 'wifi';
  assert.equal(net.state.type, 'wifi');
  // iOS : pas de Network Information API.
  const ios = new NetworkService({ env: { navigator: { onLine: true }, addEventListener() {} }, settings: new Settings() }).init();
  assert.equal(ios.state.type, 'unknown');
  ios.online = false;
  st = ios.state;
  assert.equal(st.type, 'none');
  assert.equal(st.online, false);
  await assert.rejects(net.setWifiEnabled(false), /géré par son système/);
});

test('réseau (orion-server) : Wi‑Fi réel, mot de passe, oubli', async () => {
  const fake = fakeBridge();
  const { kernel } = await boot(fake.env());
  const net = kernel.network;
  assert.equal(net.controllable, true);
  assert.equal(net.state.wifi.connected, null);
  assert.equal(net.state.type, 'none');
  await assert.rejects(net.connect('Voisin', 'mauvais'), /Mot de passe incorrect/);
  await net.connect('Voisin', 'orion1234');
  let st = net.state;
  assert.equal(st.wifi.connected.ssid, 'Voisin');
  assert.equal(st.type, 'wifi');
  assert.equal(st.ip, '192.168.1.23');
  assert.equal(st.wifi.networks.find((n) => n.ssid === 'Voisin').known, true);
  await net.forget('Voisin');
  st = net.state;
  assert.equal(st.wifi.connected, null);
  assert.equal(st.wifi.networks.find((n) => n.ssid === 'Voisin').known, false);
  // Réseau connu : pas besoin de mot de passe.
  await net.connect('Maison');
  assert.equal(net.state.wifi.connected.ssid, 'Maison');
  kernel.shutdown();
});

test('mode avion (orion-server) : coupe Wi‑Fi, Bluetooth et modem puis les rallume', async () => {
  const fake = fakeBridge();
  const { kernel } = await boot(fake.env());
  fake.state.bt.powered = false; // Bluetooth éteint avant le mode avion : il doit le rester
  await kernel.bluetooth.refresh();
  kernel.settings.set('airplane', true);
  await settle(20);
  assert.equal(fake.state.wifi.enabled, false);
  assert.equal(fake.state.modem.enabled, false);
  assert.equal(kernel.telephony.network.cellular, false);
  assert.equal(kernel.telephony.network.operator, 'Mode avion');
  kernel.settings.set('airplane', false);
  await settle(20);
  assert.equal(fake.state.wifi.enabled, true);
  assert.equal(fake.state.modem.enabled, true);
  assert.equal(fake.state.bt.powered, false);
  kernel.shutdown();
});

test('barres de signal', () => {
  assert.deepEqual([null, 0, 10, 30, 55, 90].map(signalBars), [0, 0, 1, 2, 3, 4]);
});

// ───────────── Bluetooth ─────────────

test('Bluetooth (orion-server) : recherche, appairage, déconnexion, oubli', async () => {
  const fake = fakeBridge();
  const { kernel } = await boot(fake.env());
  const bt = kernel.bluetooth;
  assert.equal(bt.mode, 'bridge');
  assert.equal(bt.enabled, true);
  assert.deepEqual(bt.devices().map((d) => [d.name, d.kind, d.battery]), [['Écouteurs', 'audio', 70]]);
  await bt.scan(5);
  await bt.refresh();
  const speaker = bt.devices().find((d) => d.name === 'Enceinte');
  assert.equal(speaker.paired, false);
  await bt.connect(speaker.id); // non appairé → appairage
  assert.ok(fake.requests.some((r) => r.path === 'bluetooth/pair' && r.body.address === speaker.id));
  assert.equal(bt.devices().find((d) => d.id === speaker.id).connected, true);
  await bt.disconnect(speaker.id);
  assert.equal(bt.devices().find((d) => d.id === speaker.id).connected, false);
  await bt.forget(speaker.id);
  assert.equal(bt.devices().some((d) => d.id === speaker.id), false);
  await assert.rejects(bt.connect('pas-une-adresse'), /Appareil inconnu/);
  kernel.shutdown();
});

test('Bluetooth (Web Bluetooth) : appareil choisi, connexion GATT réelle et batterie', async () => {
  const listeners = {};
  const device = {
    id: 'dev-1',
    name: 'Montre',
    addEventListener: (type, fn) => (listeners[type] = fn),
    forget: async () => {},
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return {
          getPrimaryService: async (name) => {
            assert.equal(name, 'battery_service');
            return { getCharacteristic: async () => ({ readValue: async () => new DataView(new Uint8Array([42]).buffer), startNotifications: async () => {}, addEventListener() {} }) };
          },
        };
      },
      disconnect() {
        this.connected = false;
        listeners.gattserverdisconnected?.();
      },
    },
  };
  const settings = new Settings();
  const bt = new BluetoothService({ settings, env: { navigator: { bluetooth: { requestDevice: async () => device } } } }).init();
  assert.equal(bt.mode, 'web');
  await assert.rejects(bt.add(), /Activez le Bluetooth/);
  await bt.setPowered(true);
  await bt.add();
  assert.deepEqual(bt.devices().map((d) => [d.name, d.connected, d.battery]), [['Montre', true, 42]]);
  assert.deepEqual(settings.get('bluetooth.devices'), [{ id: 'dev-1', name: 'Montre' }]);
  // Mode avion : les appareils sont déconnectés.
  settings.set('airplane', true);
  assert.equal(bt.devices()[0].connected, false);
  settings.set('airplane', false);
  await bt.forget('dev-1');
  assert.deepEqual(bt.devices(), []);
});

test('Bluetooth : explication quand le navigateur ne le permet pas', () => {
  const iphone = { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } };
  assert.equal(new BluetoothService({ env: iphone }).available, false);
  assert.match(unsupportedReason(iphone), /Safari/);
  assert.match(unsupportedReason({ navigator: { userAgent: 'Firefox/130' } }), /Firefox/);
});

// ───────────── Localisation ─────────────

test('localisation (navigateur) : suivi partagé, position actuelle, réglage désactivé', async () => {
  let watching = 0;
  let emit = null;
  const geolocation = {
    watchPosition: (ok) => {
      watching++;
      emit = ok;
      return 7;
    },
    clearWatch: (id) => {
      assert.equal(id, 7);
      watching--;
    },
    getCurrentPosition: (ok) => ok({ coords: { latitude: 45.76, longitude: 4.83, accuracy: 12, altitude: null, speed: null, heading: NaN }, timestamp: 1000 }),
  };
  const settings = new Settings();
  const events = new EventBus();
  const loc = new LocationService({ settings, events, env: { navigator: { geolocation } }, now: () => 1000 }).init();
  assert.equal(loc.source, 'browser');
  const seen = [];
  const stopA = loc.watch((p) => seen.push(['a', p.lat]));
  const stopB = loc.watch((p) => seen.push(['b', p.lat]));
  assert.equal(watching, 1, 'une seule source pour tous les abonnés');
  assert.equal(loc.active, true);
  emit({ coords: { latitude: 48.85, longitude: 2.35, accuracy: 5, altitude: 30, speed: 1.2, heading: 90 }, timestamp: 1000 });
  assert.deepEqual(seen, [['a', 48.85], ['b', 48.85]]);
  assert.equal(loc.last.heading, 90);
  stopA();
  stopB();
  assert.equal(watching, 0);
  assert.equal(loc.active, false);
  const here = await loc.current({ maxAge: 0 });
  assert.equal(here.lat, 45.76);
  assert.equal(here.heading, null);
  settings.set('location', false);
  await assert.rejects(loc.current(), /désactivé/);
  assert.throws(() => loc.watch(() => {}), /désactivé/);
});

test('localisation (orion-server) : récepteur GPS via gpsd', async () => {
  const fake = fakeBridge();
  const { kernel } = await boot(fake.env());
  assert.equal(kernel.location.source, 'gps');
  const position = await kernel.location.current();
  assert.equal(position.source, 'gps');
  assert.equal(position.satellites, 9);
  assert.equal(position.accuracy, 6);
  kernel.shutdown();
});

test('localisation : distance, coordonnées lisibles et trace GPX', () => {
  const paris = { lat: 48.8566, lon: 2.3522 };
  const lyon = { lat: 45.764, lon: 4.8357 };
  assert.ok(Math.abs(distance(paris, lyon) - 391_500) < 2000);
  assert.equal(formatCoordinates({ lat: -33.8688, lon: -151.2093 }, 2), '33,87° S, 151,21° O');
  const points = [{ ...paris, alt: 35, time: Date.UTC(2026, 0, 1, 10) }, { ...lyon, alt: null, time: Date.UTC(2026, 0, 1, 14) }];
  const gpx = toGpx(points, { name: 'Paris → Lyon <test>' });
  assert.match(gpx, /<name>Paris → Lyon &lt;test&gt;<\/name>/);
  const back = parseGpx(gpx);
  assert.equal(back.length, 2);
  assert.equal(back[0].alt, 35);
  assert.equal(back[1].time, Date.UTC(2026, 0, 1, 14));
  assert.ok(Math.abs(back[1].lat - lyon.lat) < 1e-6);
});

test('Plans : projection de Mercator réversible et distances lisibles', () => {
  for (const pos of [{ lat: 48.8566, lon: 2.3522 }, { lat: -33.86, lon: 151.2 }, { lat: 0, lon: -179.9 }]) {
    const back = unproject(project(pos, 13.5), 13.5);
    assert.ok(Math.abs(back.lat - pos.lat) < 1e-9 && Math.abs(back.lon - pos.lon) < 1e-9);
  }
  assert.deepEqual(project({ lat: 0, lon: 0 }, 0), { x: 128, y: 128 });
  assert.equal(formatDistance(850), '850 m');
  assert.equal(formatDistance(4321), '4,3 km');
  assert.equal(formatDistance(25_600), '26 km');
});

// ───────────── Téléphonie ─────────────

const ANDROID = { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7) Mobile' } };
const IPHONE = { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } };

async function phone(env) {
  const opened = [];
  const { kernel } = await boot({ ...env });
  kernel.telephony.openExternal = (url) => opened.push(url);
  return { kernel, opened };
}

test('téléphonie (téléphone) : vrais appels et SMS par les apps du système', async () => {
  const { kernel, opened } = await phone(ANDROID);
  const tel = kernel.telephony;
  assert.equal(tel.mode, 'handoff');
  assert.equal(tel.network.signal, null);
  assert.deepEqual(tel.dial('06 12 34 56 78'), { handoff: true, number: '06 12 34 56 78' });
  assert.equal(tel.call, null, 'pas d\'écran d\'appel simulé');
  assert.equal(opened.at(-1), 'tel:0612345678');
  assert.equal(tel.callLog()[0].handoff, true);
  tel.dial('*#06#');
  assert.equal(opened.at(-1), 'tel:*%2306%23');
  const sms = tel.sendSms('+33 6 12 34 56 78', { text: 'Salut & à bientôt' });
  assert.equal(sms.status, 'handoff');
  assert.equal(opened.at(-1), `sms:+33612345678?body=${encodeURIComponent('Salut & à bientôt')}`);
  assert.throws(() => tel.sendSms('0612345678', { image: 'data:image/png;base64,AAAA' }), /photos/);
  // Mode avion d'Orion : seuls les numéros d'urgence passent.
  kernel.settings.set('airplane', true);
  assert.throws(() => tel.dial('0612345678'), /mode avion/);
  tel.dial('112');
  assert.equal(opened.at(-1), 'tel:112');
  kernel.shutdown();
});

test('téléphonie (iPhone) : lien sms: au format iOS ; mode simulation au choix', async () => {
  const { kernel, opened } = await phone(IPHONE);
  kernel.telephony.sendSms('0612345678', { text: 'Coucou' });
  assert.equal(opened.at(-1), 'sms:0612345678&body=Coucou');
  kernel.settings.set('telephony.mode', 'simulated');
  assert.equal(kernel.telephony.mode, 'simulated');
  assert.equal(kernel.telephony.dial('0612345678').state, 'dialing');
  kernel.shutdown();
});

test('téléphonie (modem) : appel sortant, décroché, raccroché par le correspondant', async () => {
  const fake = fakeBridge();
  const { kernel, timers } = await boot(fake.env());
  const tel = kernel.telephony;
  assert.equal(tel.mode, 'modem');
  assert.equal(tel.network.operator, 'Orion Mobile');
  assert.equal(tel.network.type, '4G');
  assert.equal(tel.network.signal, 3);
  tel.dial('0612345678');
  await settle();
  assert.equal(tel.call.modemId, '1');
  fake.state.calls[0].state = 'active';
  timers.advance(1000);
  await settle();
  assert.equal(tel.call.state, 'active');
  fake.state.calls = [];
  timers.advance(1000);
  await settle();
  assert.equal(tel.call, null);
  assert.equal(tel.callLog()[0].direction, 'out');
  kernel.shutdown();
});

test('téléphonie (modem) : appel entrant décroché, et appel manqué', async () => {
  const fake = fakeBridge();
  const { kernel, timers } = await boot(fake.env());
  const tel = kernel.telephony;
  const id = fake.ring('+33611111111');
  timers.advance(3000);
  await settle();
  assert.equal(tel.call.state, 'incoming');
  assert.equal(tel.call.modemId, id);
  tel.answer();
  await settle();
  assert.equal(fake.state.calls[0].state, 'active');
  tel.hangup();
  await settle();
  assert.equal(fake.state.calls.length, 0);
  // Le correspondant raccroche avant qu'on décroche : appel manqué.
  fake.ring('+33622222222');
  timers.advance(3000);
  await settle();
  assert.equal(tel.call.state, 'incoming');
  fake.state.calls = [];
  timers.advance(1000);
  await settle();
  assert.equal(tel.call, null);
  assert.equal(tel.callLog()[0].missed, true);
  assert.ok(kernel.notifications.list({ appId: 'phone' }).some((n) => n.title === 'Appel manqué'));
  kernel.shutdown();
});

test('téléphonie (modem) : SMS envoyés et reçus, anciens SMS importés sans notification', async () => {
  const fake = fakeBridge();
  fake.receive('+33633333333', 'Ancien message', '2025-12-01T10:00:00Z');
  const { kernel, timers } = await boot(fake.env());
  const tel = kernel.telephony;
  await settle();
  assert.equal(tel.thread('+33633333333').messages[0].text, 'Ancien message');
  assert.equal(kernel.notifications.list({ appId: 'messages' }).length, 0);
  const sent = tel.sendSms('+33644444444', { text: 'Bonjour' });
  assert.equal(sent.status, 'sending');
  await settle();
  assert.equal(tel.thread('+33644444444').messages[0].status, 'sent');
  assert.ok(fake.state.sms.some((m) => m.text === 'Bonjour' && m.number === '+33644444444'));
  fake.receive('+33644444444', 'Bien reçu !');
  timers.advance(10_000);
  await settle();
  assert.equal(tel.thread('+33644444444').messages.at(-1).text, 'Bien reçu !');
  assert.equal(kernel.notifications.list({ appId: 'messages' }).length, 1);
  // Pas de doublon au passage suivant.
  timers.advance(10_000);
  await settle();
  assert.equal(tel.thread('+33644444444').messages.length, 2);
  kernel.shutdown();
});

test('téléphonie (modem) : données mobiles', async () => {
  const fake = fakeBridge();
  const { kernel } = await boot(fake.env());
  await kernel.telephony.setMobileData(true);
  await settle();
  assert.equal(fake.state.modem.data, true);
  assert.equal(kernel.telephony.network.data, true);
  kernel.shutdown();
});
