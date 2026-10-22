/**
 * Téléphonie : appels vocaux et SMS, selon ce que l'appareil permet vraiment.
 *
 * - « modem » : Orion installé avec un modem 4G/5G (orion-server + ModemManager).
 *   Les appels et SMS passent par le réseau de l'opérateur ; appels et SMS
 *   entrants sont détectés en interrogeant le modem.
 * - « handoff » (téléphone) : une page web n'a pas accès au modem du téléphone.
 *   Orion confie l'appel ou le SMS à l'app Téléphone ou Messages du système
 *   (liens tel: et sms:) : c'est un vrai appel, un vrai SMS. Orion garde
 *   l'historique et les conversations.
 * - « simulated » : démonstration sans réseau (ordinateur). Les correspondants
 *   répondent automatiquement (chatbot.js) ; les options développeur et le
 *   terminal peuvent simuler des appels et SMS entrants.
 *
 * Réglage telephony.mode : 'auto' (modem s'il existe, sinon téléphone sur un
 * mobile, sinon simulation), 'handoff' ou 'simulated'.
 */
import { replyTo } from './chatbot.js';
import { phoneKey } from './contacts.js';
import { Poller } from './bridge.js';
import { signalBars } from './network.js';

export const SMS_FILE = '/data/providers/sms.json';
export const CALLS_FILE = '/data/providers/calls.json';
export const EMERGENCY_NUMBERS = ['112', '15', '17', '18', '114', '911'];
export const VOICEMAIL = '888';

/** Technologie d'accès ModemManager → libellé de la barre d'état. */
const TECHNOLOGIES = [
  [/5gnr/, '5G'],
  [/lte/, '4G'],
  [/hspa-plus|hspa|hsdpa|hsupa|umts|evdo/, '3G'],
  [/edge/, 'E'],
  [/gprs/, 'G'],
  [/gsm|1xrtt/, '2G'],
];
const REGISTERED = new Set(['registered', 'connecting', 'connected', 'disconnecting']);

/** Appareil mobile (Android, iPhone, iPad) : les liens tel: et sms: ouvrent les apps du système. */
export function isMobileDevice(env = globalThis) {
  const nav = env.navigator ?? {};
  if (nav.userAgentData?.mobile) return true;
  const ua = nav.userAgent ?? '';
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
}

const isApple = (env) => /iPhone|iPad|iPod|Macintosh/.test(env.navigator?.userAgent ?? '');

export class TelephonyService {
  #threads = {}; // phoneKey → { address, messages: [] }
  #calls = [];
  #timers = new Set();
  #nextId = 1;
  #modemPoller = null;
  #smsPoller = null;
  #handledCalls = new Set(); // appels du modem déjà présentés

  constructor({ fs, events = null, contacts = null, notifications = null, settings = null, log = null, now = Date.now, timers = globalThis, random = Math.random, env = globalThis, bridge = null, openExternal = null }) {
    this.fs = fs;
    this.events = events;
    this.contacts = contacts;
    this.notifications = notifications;
    this.settings = settings;
    this.log = log;
    this.now = now;
    this.timers = timers;
    this.random = random;
    this.env = env;
    this.bridge = bridge;
    /** Ouvre un lien tel: ou sms: dans l'app du système. */
    this.openExternal = openExternal ?? ((url) => env.location?.assign?.(url));
    this.call = null;
    this.activeThread = null;
    /** Dernier état du modem (GET api/modem). */
    this.modem = null;
  }

  /** 'modem' | 'handoff' | 'simulated' */
  get mode() {
    const pref = this.settings?.get('telephony.mode') ?? 'auto';
    if (pref === 'simulated') return 'simulated';
    if (pref !== 'handoff' && this.bridge?.has('modem')) return 'modem';
    if (pref === 'handoff' || isMobileDevice(this.env)) return 'handoff';
    return 'simulated';
  }

  /** Démarre le suivi du modem (appels et SMS entrants). */
  start() {
    if (!this.bridge?.has('modem')) return this;
    this.#modemPoller = new Poller({
      timers: this.timers,
      interval: 3000,
      fetch: async () => {
        const [modem, calls] = await Promise.all([this.bridge.get('modem'), this.bridge.get('modem/calls').catch(() => null)]);
        return { modem, calls: calls?.calls ?? null };
      },
      onState: ({ modem, calls }) => {
        this.modem = modem;
        if (this.mode === 'modem' && calls) this.#syncCalls(calls);
        this.events?.emit('network:change', {});
      },
      onError: (error) => this.log?.warn('tel', error.message),
    }).start();
    this.#smsPoller = new Poller({
      timers: this.timers,
      interval: 10_000,
      fetch: () => this.bridge.get('modem/sms'),
      onState: ({ messages }) => this.mode === 'modem' && this.#syncSms(messages ?? []),
      onError: (error) => this.log?.warn('sms', error.message),
    }).start();
    return this;
  }

  load() {
    this.#threads = this.fs.exists(SMS_FILE) ? this.fs.readJSON(SMS_FILE, {}) : {};
    this.#calls = this.fs.exists(CALLS_FILE) ? this.fs.readJSON(CALLS_FILE, []) : [];
    const ids = Object.values(this.#threads).flatMap((th) => th.messages.map((m) => m.id ?? 0));
    this.#nextId = Math.max(this.#nextId, ...ids, ...this.#calls.map((c) => c.id)) + 1;
    return this;
  }

  /** Efface conversations et appels de ces numéros (données de démonstration). */
  forgetNumbers(numbers) {
    const keys = new Set(numbers.map(phoneKey));
    const threads = Object.keys(this.#threads).filter((key) => keys.has(key));
    const calls = this.#calls.length;
    threads.forEach((key) => delete this.#threads[key]);
    this.#calls = this.#calls.filter((c) => !keys.has(phoneKey(c.number)));
    if (threads.length) this.#saveThreads();
    if (calls !== this.#calls.length) this.#saveCalls();
  }

  #saveThreads() {
    this.fs.writeJSON(SMS_FILE, this.#threads, { system: true });
  }

  #saveCalls() {
    this.fs.writeJSON(CALLS_FILE, this.#calls.slice(0, 100), { system: true });
  }

  #later(fn, ms) {
    const handle = this.timers.setTimeout(() => {
      this.#timers.delete(handle);
      fn();
    }, ms);
    this.#timers.add(handle);
    return handle;
  }

  #cancel(handle) {
    if (handle == null) return;
    this.timers.clearTimeout(handle);
    this.#timers.delete(handle);
  }

  shutdown() {
    for (const handle of this.#timers) this.timers.clearTimeout(handle);
    this.#timers.clear();
    this.#modemPoller?.stop();
    this.#smsPoller?.stop();
  }

  // ───────────── Réseau ─────────────

  get network() {
    const airplane = Boolean(this.settings?.get('airplane'));
    const mode = this.mode;
    if (mode === 'modem') {
      const m = this.modem ?? {};
      const enabled = Boolean(m.available) && m.enabled !== false;
      const cellular = !airplane && enabled && REGISTERED.has(m.state);
      const tech = String(m.technology ?? '');
      const operator = cellular ? m.operator || 'Réseau mobile' : airplane ? 'Mode avion' : m.sim === false ? 'Pas de carte SIM' : !enabled ? 'Modem désactivé' : m.state === 'searching' ? 'Recherche…' : 'Pas de service';
      return {
        mode,
        airplane,
        cellular,
        operator,
        signal: cellular ? signalBars(m.signal) : 0,
        signalPercent: m.signal ?? null,
        type: cellular ? TECHNOLOGIES.find(([re]) => re.test(tech))?.[1] ?? null : null,
        data: Boolean(m.data),
        enabled,
        sim: m.sim ?? null,
        number: m.number || null,
        roaming: m.registration === 'roaming',
        state: m.state ?? null,
      };
    }
    if (mode === 'handoff') return { mode, airplane, cellular: !airplane, operator: 'Opérateur du téléphone', signal: null, type: null };
    const cellular = !airplane && this.settings?.get('cellular') !== false;
    return { mode, airplane, cellular, operator: cellular ? 'Orion Mobile' : 'Pas de service', signal: cellular ? 4 : 0, type: '5G' };
  }

  /** Données mobiles (modem). */
  async setMobileData(enabled) {
    if (this.mode !== 'modem') throw new Error('Pas de modem piloté par Orion sur cet appareil');
    await this.bridge.post('modem/data', { enabled: Boolean(enabled) }, { timeout: 45_000 });
    this.#modemPoller?.restart();
  }

  /** Allume ou éteint le modem (mode avion). */
  async setModemEnabled(enabled) {
    if (!this.bridge?.has('modem')) return;
    await this.bridge.post('modem/power', { enabled: Boolean(enabled) }, { timeout: 30_000 });
    this.#modemPoller?.restart();
  }

  nameFor(number) {
    if (number === VOICEMAIL) return 'Messagerie vocale';
    if (EMERGENCY_NUMBERS.includes(String(number).replace(/\s/g, ''))) return "Appel d'urgence";
    return this.contacts?.nameFor(number) ?? number;
  }

  // ───────────── SMS ─────────────

  threads() {
    return Object.values(this.#threads)
      .filter((th) => th.messages.length)
      .map((th) => this.#describe(th))
      .sort((a, b) => (b.last?.time ?? 0) - (a.last?.time ?? 0));
  }

  thread(address) {
    const th = this.#threads[phoneKey(address)];
    return th ? this.#describe(th) : { address, name: this.nameFor(address), contact: this.contacts?.findByPhone(address) ?? null, messages: [], unread: 0, last: null };
  }

  #describe(th) {
    return {
      address: th.address,
      name: this.nameFor(th.address),
      contact: this.contacts?.findByPhone(th.address) ?? null,
      messages: th.messages.map((m) => ({ ...m })),
      unread: th.messages.filter((m) => m.from === 'them' && !m.read).length,
      last: th.messages.at(-1) ?? null,
    };
  }

  #append(address, message) {
    const key = phoneKey(address) || address;
    const th = (this.#threads[key] ??= { address, messages: [] });
    th.messages.push(message);
    this.#saveThreads();
    return message;
  }

  unreadCount() {
    return this.threads().reduce((sum, th) => sum + th.unread, 0);
  }

  sendSms(address, { text = '', image = null } = {}) {
    if (!String(address).trim()) throw new Error('Destinataire manquant');
    if (!text.trim() && !image) throw new Error('Message vide');
    const mode = this.mode;
    if (image && mode !== 'simulated') throw new Error(mode === 'modem' ? 'Les photos (MMS) ne sont pas encore prises en charge par le modem.' : 'Les photos ne peuvent pas être transmises à l\'app Messages du téléphone.');
    const online = this.network.cellular;
    const status = !online ? 'failed' : mode === 'modem' ? 'sending' : mode === 'handoff' ? 'handoff' : 'delivered';
    const message = this.#append(address, {
      id: this.#nextId++,
      from: 'me',
      text: text.trim(),
      image,
      time: this.now(),
      read: true,
      status,
    });
    this.log?.info('sms', `→ ${address} (${message.status})`);
    this.events?.emit('sms:sent', { address, message: { ...message } });
    if (!online) return { ...message };
    if (mode === 'handoff') {
      // Android : sms:numéro?body=… ; iOS : sms:numéro&body=…
      const number = String(address).replace(/[^\d+]/g, '');
      this.openExternal(`sms:${number}${isApple(this.env) ? '&' : '?'}body=${encodeURIComponent(message.text)}`);
    } else if (mode === 'modem') {
      this.bridge
        .post('modem/sms', { number: String(address).replace(/[^\d+]/g, ''), text: message.text }, { timeout: 60_000 })
        .then(() => this.#setStatus(address, message.id, 'sent'))
        .catch((error) => {
          this.log?.warn('sms', `échec de l'envoi : ${error.message}`);
          this.#setStatus(address, message.id, 'failed');
        });
    } else if (phoneKey(address).length >= 6) {
      const delay = 1500 + this.random() * 2500;
      this.#later(() => this.events?.emit('sms:typing', { address, typing: true }), Math.min(900, delay / 2));
      this.#later(() => {
        this.events?.emit('sms:typing', { address, typing: false });
        this.receiveSms(address, replyTo(text, this.random));
      }, delay);
    }
    return { ...message };
  }

  #setStatus(address, id, status) {
    const message = this.#threads[phoneKey(address) || address]?.messages.find((m) => m.id === id);
    if (!message) return;
    message.status = status;
    this.#saveThreads();
    this.events?.emit('sms:status', { address, id, status });
  }

  /**
   * SMS reçus par le modem. Au tout premier passage, ceux déjà présents sur la
   * carte SIM sont importés sans notification.
   */
  #syncSms(messages) {
    const seenList = this.settings?.get('telephony.seenSms');
    const seen = new Set(seenList ?? []);
    const first = !seenList;
    let changed = false;
    for (const m of messages) {
      if (m.state !== 'received' || !m.number) continue;
      const key = `${m.number}|${m.timestamp ?? ''}|${m.text ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changed = true;
      const time = Date.parse(m.timestamp ?? '') || this.now();
      if (first) this.#append(m.number, { id: this.#nextId++, from: 'them', text: m.text ?? '', image: null, time, read: true, status: 'delivered' });
      else this.receiveSms(m.number, m.text ?? '', { time });
    }
    if (changed || first) this.settings?.set('telephony.seenSms', [...seen].slice(-300));
    if (first && changed) this.events?.emit('sms:received', { address: null });
  }

  receiveSms(address, text, { image = null, time = this.now() } = {}) {
    const active = this.activeThread && phoneKey(this.activeThread) === phoneKey(address);
    const message = this.#append(address, {
      id: this.#nextId++,
      from: 'them',
      text,
      image,
      time,
      read: Boolean(active),
      status: 'delivered',
    });
    this.log?.info('sms', `← ${address}`);
    this.events?.emit('sms:received', { address, message: { ...message } });
    if (!active) {
      this.notifications?.post({
        appId: 'messages',
        title: this.nameFor(address),
        body: text || '📷 Photo',
        tag: `sms:${phoneKey(address)}`,
        intent: { app: 'messages', action: 'view', data: { address } },
      });
    }
    return { ...message };
  }

  setActiveThread(address) {
    this.activeThread = address;
    if (address) this.markRead(address);
  }

  markRead(address) {
    const th = this.#threads[phoneKey(address)];
    if (!th) return;
    let changed = false;
    for (const m of th.messages) {
      if (!m.read) {
        m.read = true;
        changed = true;
      }
    }
    if (changed) {
      this.#saveThreads();
      this.events?.emit('sms:read', { address });
    }
    this.notifications?.clear({ appId: 'messages', tag: `sms:${phoneKey(address)}` });
  }

  deleteThread(address) {
    delete this.#threads[phoneKey(address)];
    this.#saveThreads();
    this.events?.emit('sms:deleted', { address });
  }

  // ───────────── Appels ─────────────

  callLog() {
    return this.#calls.map((c) => ({ ...c, name: this.nameFor(c.number) }));
  }

  clearCallLog() {
    this.#calls = [];
    this.#saveCalls();
    this.events?.emit('call:log', {});
  }

  #emitCall() {
    this.events?.emit('call:state', this.call ? { ...this.call } : null);
  }

  #log(entry) {
    this.#calls.unshift({ id: this.#nextId++, time: this.now(), ...entry });
    this.#saveCalls();
    this.events?.emit('call:log', {});
  }

  dial(number) {
    const clean = String(number ?? '').trim();
    if (!clean) throw new Error('Numéro vide');
    if (this.call) throw new Error('Un appel est déjà en cours');
    const emergency = EMERGENCY_NUMBERS.includes(clean.replace(/\s/g, ''));
    const mode = this.mode;
    if (!emergency && !this.network.cellular) {
      throw new Error(this.network.airplane ? 'Aucun réseau : désactivez le mode avion' : `Appel impossible : ${this.network.operator.toLowerCase()}`);
    }
    if (mode === 'handoff') {
      // L'app Téléphone du système passe le vrai appel (« # » doit être encodé dans un lien tel:).
      this.openExternal(`tel:${clean.replace(/[^\d+*#]/g, '').replace(/#/g, '%23')}`);
      this.log?.info('tel', `appel ${clean} confié à l'app Téléphone`);
      this.#log({ number: clean, direction: 'out', missed: false, duration: null, handoff: true });
      return { handoff: true, number: clean };
    }
    this.call = {
      id: this.#nextId++,
      number: clean,
      name: this.nameFor(clean),
      direction: 'out',
      state: 'dialing',
      startedAt: this.now(),
      connectedAt: null,
      muted: false,
      speaker: false,
      held: false,
      emergency,
    };
    this.log?.info('tel', `appel sortant ${clean}${mode === 'modem' ? ' (modem)' : ''}`);
    this.#emitCall();
    const id = this.call.id;
    if (mode === 'modem') {
      this.bridge
        .post('modem/call', { number: clean.replace(/[^\d+*#]/g, '') }, { timeout: 30_000 })
        .then(({ id: modemId }) => {
          if (this.call?.id !== id) return void this.bridge.post('modem/hangup', { id: String(modemId) }).catch(() => {});
          this.call.modemId = String(modemId);
          this.#handledCalls.add(this.call.modemId);
          this.#modemPoller?.start(1000);
        })
        .catch((error) => {
          if (this.call?.id !== id) return;
          this.log?.warn('tel', `échec de l'appel : ${error.message}`);
          this.events?.emit('call:error', { message: `Appel impossible : ${error.message}` });
          this.hangup();
        });
      return { ...this.call };
    }
    const connectAfter = emergency || clean === VOICEMAIL ? 800 : 2200 + this.random() * 2000;
    this.call.timer = this.#later(() => {
      if (this.call?.id !== id) return;
      this.call.state = 'ringing';
      this.#emitCall();
      this.call.timer = this.#later(() => {
        if (this.call?.id !== id) return;
        this.call.state = 'active';
        this.call.connectedAt = this.now();
        this.#emitCall();
      }, connectAfter);
    }, 1000);
    return { ...this.call };
  }

  /** Appel entrant (modem réel, ou simulé par le terminal et les options développeur). */
  incoming(number, { modemId = null } = {}) {
    const clean = String(number ?? '').trim();
    if (!modemId && !this.network.cellular) return null;
    if (this.call) {
      this.#missed(clean);
      return null;
    }
    this.call = {
      id: this.#nextId++,
      number: clean,
      name: this.nameFor(clean),
      direction: 'in',
      state: 'incoming',
      startedAt: this.now(),
      connectedAt: null,
      muted: false,
      speaker: false,
      held: false,
      modemId,
    };
    this.log?.info('tel', `appel entrant ${clean}`);
    const id = this.call.id;
    // Un vrai appel s'arrête quand le correspondant raccroche (vu par le modem).
    if (!modemId) {
      this.call.timer = this.#later(() => {
        if (this.call?.id !== id || this.call.state !== 'incoming') return;
        this.call = null;
        this.#missed(clean);
        this.#emitCall();
      }, 30_000);
    }
    this.#emitCall();
    return { ...this.call };
  }

  /** Rapproche l'appel en cours de la liste des appels du modem. */
  #syncCalls(calls) {
    const live = calls.filter((c) => c.state !== 'terminated');
    const call = this.call;
    if (call?.modemId) {
      const remote = live.find((c) => String(c.id) === call.modemId);
      if (!remote) {
        // Le correspondant a raccroché (ou n'a jamais décroché).
        if (call.state === 'incoming') {
          this.#cancel(call.timer);
          this.call = null;
          this.#missed(call.number);
          this.#emitCall();
        } else {
          this.hangup({ remote: true });
        }
      } else if (remote.state === 'active' && call.state !== 'active') {
        call.state = 'active';
        call.connectedAt ??= this.now();
        call.held = false;
        this.#emitCall();
      } else if (remote.state === 'held' && !call.held) {
        call.held = true;
        this.#emitCall();
      }
    }
    for (const c of live) {
      const key = String(c.id);
      if (c.direction !== 'incoming' || c.state !== 'ringing' || this.#handledCalls.has(key)) continue;
      this.#handledCalls.add(key);
      this.incoming(c.number || 'Numéro masqué', { modemId: key });
    }
    this.#modemPoller?.start(this.call ? 1000 : 3000);
  }

  #missed(number) {
    this.#log({ number, direction: 'in', missed: true, duration: 0 });
    this.notifications?.post({
      appId: 'phone',
      title: 'Appel manqué',
      body: this.nameFor(number),
      tag: `missed:${phoneKey(number)}`,
      intent: { app: 'phone', action: 'view', data: { tab: 'recents' } },
    });
  }

  answer() {
    if (this.call?.state !== 'incoming') return false;
    this.#cancel(this.call.timer);
    const call = this.call;
    if (call.modemId) {
      this.bridge.post('modem/answer', { id: call.modemId }).catch((error) => {
        this.events?.emit('call:error', { message: `Impossible de décrocher : ${error.message}` });
        if (this.call === call) this.hangup();
      });
    }
    this.call.state = 'active';
    this.call.connectedAt = this.now();
    this.#emitCall();
    return true;
  }

  hangup({ remote = false } = {}) {
    const call = this.call;
    if (!call) return false;
    this.#cancel(call.timer);
    if (call.modemId && !remote) this.bridge.post('modem/hangup', { id: call.modemId }).catch((error) => this.log?.warn('tel', error.message));
    const duration = call.connectedAt ? Math.round((this.now() - call.connectedAt) / 1000) : 0;
    this.#log({
      number: call.number,
      direction: call.direction,
      missed: false,
      declined: call.state === 'incoming',
      duration,
    });
    this.call = null;
    this.events?.emit('call:state', { ...call, state: 'ended', duration });
    return true;
  }

  setCallOption(option, value) {
    if (!this.call || !['muted', 'speaker', 'held'].includes(option)) return;
    this.call[option] = value ?? !this.call[option];
    this.#emitCall();
  }
}
