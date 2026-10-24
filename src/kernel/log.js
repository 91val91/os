/**
 * Journal système en anneau (équivalent de dmesg / logcat).
 */
const LEVELS = { debug: 'D', info: 'I', warn: 'W', error: 'E' };

export class SystemLog {
  #entries = [];

  constructor({ limit = 500, now = Date.now, echo = false } = {}) {
    this.limit = limit;
    this.now = now;
    this.bootTime = now();
    this.echo = echo;
    this.listeners = new Set();
  }

  write(level, tag, message) {
    const entry = { time: this.now(), level, tag, message: String(message) };
    this.#entries.push(entry);
    if (this.#entries.length > this.limit) this.#entries.shift();
    if (this.echo) {
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[method](`[${tag}] ${entry.message}`);
    }
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  debug(tag, message) { return this.write('debug', tag, message); }
  info(tag, message) { return this.write('info', tag, message); }
  warn(tag, message) { return this.write('warn', tag, message); }
  error(tag, message) { return this.write('error', tag, message); }

  list({ tag, level } = {}) {
    return this.#entries.filter((e) => (!tag || e.tag === tag) && (!level || e.level === level));
  }

  clear() {
    this.#entries = [];
  }

  /** Formate une entrée façon dmesg : "[   1.234] I/tag: message". */
  format(entry) {
    const seconds = ((entry.time - this.bootTime) / 1000).toFixed(3).padStart(8, ' ');
    return `[${seconds}] ${LEVELS[entry.level] ?? '?'}/${entry.tag}: ${entry.message}`;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
