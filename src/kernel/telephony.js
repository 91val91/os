/**
 * Pile téléphonie simulée (modem virtuel) : appels vocaux et SMS.
 *
 * Les correspondants répondent automatiquement aux SMS (voir chatbot.js) ;
 * les appels sortants décrochent après quelques secondes. Les options
 * développeur et le terminal peuvent simuler des appels/SMS entrants.
 */
import { replyTo } from './chatbot.js';
import { phoneKey } from './contacts.js';

export const SMS_FILE = '/data/providers/sms.json';
export const CALLS_FILE = '/data/providers/calls.json';
export const EMERGENCY_NUMBERS = ['112', '15', '17', '18', '114', '911'];
export const VOICEMAIL = '888';


export class TelephonyService {
  #threads = {}; // phoneKey → { address, messages: [] }
  #calls = [];
  #timers = new Set();
  #nextId = 1;

  constructor({ fs, events = null, contacts = null, notifications = null, settings = null, log = null, now = Date.now, timers = globalThis, random = Math.random }) {
    this.fs = fs;
    this.events = events;
    this.contacts = contacts;
    this.notifications = notifications;
    this.settings = settings;
    this.log = log;
    this.now = now;
    this.timers = timers;
    this.random = random;
    this.call = null;
    this.activeThread = null;
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
  }

  // ───────────── Réseau ─────────────

  get network() {
    const airplane = Boolean(this.settings?.get('airplane'));
    const cellular = !airplane && this.settings?.get('cellular') !== false;
    return { airplane, cellular, operator: cellular ? 'Orion Mobile' : 'Pas de service', signal: cellular ? 4 : 0, type: '5G' };
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
    const online = this.network.cellular;
    const message = this.#append(address, {
      id: this.#nextId++,
      from: 'me',
      text: text.trim(),
      image,
      time: this.now(),
      read: true,
      status: online ? 'delivered' : 'failed',
    });
    this.log?.info('sms', `→ ${address} (${message.status})`);
    this.events?.emit('sms:sent', { address, message: { ...message } });
    if (online && phoneKey(address).length >= 6) {
      const delay = 1500 + this.random() * 2500;
      this.#later(() => this.events?.emit('sms:typing', { address, typing: true }), Math.min(900, delay / 2));
      this.#later(() => {
        this.events?.emit('sms:typing', { address, typing: false });
        this.receiveSms(address, replyTo(text, this.random));
      }, delay);
    }
    return { ...message };
  }

  receiveSms(address, text, { image = null } = {}) {
    const active = this.activeThread && phoneKey(this.activeThread) === phoneKey(address);
    const message = this.#append(address, {
      id: this.#nextId++,
      from: 'them',
      text,
      image,
      time: this.now(),
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
    if (!emergency && !this.network.cellular) throw new Error('Aucun réseau : désactivez le mode avion');
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
    this.log?.info('tel', `appel sortant ${clean}`);
    this.#emitCall();
    const id = this.call.id;
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

  incoming(number) {
    const clean = String(number ?? '').trim();
    if (!this.network.cellular) return null;
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
    };
    this.log?.info('tel', `appel entrant ${clean}`);
    const id = this.call.id;
    this.call.timer = this.#later(() => {
      if (this.call?.id !== id || this.call.state !== 'incoming') return;
      this.call = null;
      this.#missed(clean);
      this.#emitCall();
    }, 30_000);
    this.#emitCall();
    return { ...this.call };
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
    this.call.state = 'active';
    this.call.connectedAt = this.now();
    this.#emitCall();
    return true;
  }

  hangup() {
    const call = this.call;
    if (!call) return false;
    this.#cancel(call.timer);
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
