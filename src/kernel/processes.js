/**
 * Gestionnaire de processus.
 *
 * Chaque application lancée devient un processus (une seule instance par
 * application, comme les tâches iOS/Android). Un seul processus est au
 * premier plan ; les autres sont en arrière-plan, classés du plus récent au
 * plus ancien. Au-delà de `maxBackground`, le plus ancien est arrêté
 * (équivalent du « low memory killer » d'Android).
 */
export class ProcessManager {
  #table = new Map();
  #order = []; // pids, du plus récent au plus ancien
  #nextPid = 100;

  constructor({ events = null, log = null, now = Date.now, maxBackground = 8 } = {}) {
    this.events = events;
    this.log = log;
    this.now = now;
    this.maxBackground = maxBackground;
  }

  spawn(appId, { intent = null, callerPid = null } = {}) {
    if (this.getByApp(appId)) throw new Error(`Processus déjà actif pour ${appId}`);
    const proc = {
      pid: this.#nextPid++,
      appId,
      state: 'starting',
      startedAt: this.now(),
      intent,
      callerPid,
    };
    this.#table.set(proc.pid, proc);
    this.#order.unshift(proc.pid);
    this.log?.info('am', `start ${appId} pid=${proc.pid}`);
    this.events?.emit('process:start', { ...proc });
    this.#trim();
    return proc;
  }

  get(pid) {
    return this.#table.get(pid) ?? null;
  }

  getByApp(appId) {
    for (const proc of this.#table.values()) if (proc.appId === appId) return proc;
    return null;
  }

  /** Liste triée du plus récent au plus ancien. */
  list() {
    return this.#order.map((pid) => this.#table.get(pid));
  }

  foreground() {
    for (const proc of this.#table.values()) if (proc.state === 'foreground') return proc;
    return null;
  }

  setForeground(pid) {
    const proc = this.#table.get(pid);
    if (!proc) throw new Error(`Processus inconnu : ${pid}`);
    const current = this.foreground();
    if (current && current.pid !== pid) this.#setState(current, 'background');
    this.#order = [pid, ...this.#order.filter((p) => p !== pid)];
    if (proc.state !== 'foreground') this.#setState(proc, 'foreground');
    this.#trim();
    return proc;
  }

  /** Passe le processus au premier plan en arrière-plan (retour à l'accueil). */
  backgroundAll() {
    const current = this.foreground();
    if (current) this.#setState(current, 'background');
    this.#trim();
  }

  kill(pid, reason = 'kill') {
    const proc = this.#table.get(pid);
    if (!proc) return false;
    this.#table.delete(pid);
    this.#order = this.#order.filter((p) => p !== pid);
    proc.state = 'dead';
    this.log?.info('am', `exit ${proc.appId} pid=${pid} (${reason})`);
    this.events?.emit('process:exit', { pid, appId: proc.appId, reason });
    return true;
  }

  killApp(appId, reason) {
    const proc = this.getByApp(appId);
    return proc ? this.kill(proc.pid, reason) : false;
  }

  killAll(reason = 'shutdown') {
    for (const pid of [...this.#order]) this.kill(pid, reason);
  }

  #setState(proc, state) {
    const previous = proc.state;
    proc.state = state;
    this.events?.emit('process:state', { pid: proc.pid, appId: proc.appId, state, previous });
  }

  #trim() {
    const background = this.#order.map((pid) => this.#table.get(pid)).filter((p) => p.state !== 'foreground');
    // Le processus qui démarre compte comme actif.
    const candidates = background.filter((p) => p.state !== 'starting');
    while (candidates.length > this.maxBackground) {
      const victim = candidates.pop();
      this.kill(victim.pid, 'lmk');
    }
  }
}
