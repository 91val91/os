/**
 * Intents (inspirés d'Android) et gestionnaire d'activités.
 *
 * Un intent décrit une intention : { action, type?, data?, app?, extras? }.
 *   - explicite : `app` désigne l'application cible ;
 *   - implicite : on cherche les applications installées dont un filtre
 *     `{ action, types }` correspond. S'il y en a plusieurs, l'interface
 *     système affiche un sélecteur.
 * `start(intent, { forResult: true })` renvoie une promesse résolue quand
 * l'application cible appelle `finish(result)` (startActivityForResult).
 */

export function matchType(pattern, type) {
  if (!pattern || pattern === '*/*' || pattern === '*') return true;
  if (!type) return false;
  const [pMain, pSub] = pattern.split('/');
  const [tMain, tSub] = type.split('/');
  return pMain === tMain && (pSub === '*' || pSub === tSub);
}

export function matchIntent(filter, intent) {
  if (!filter || !intent || filter.action !== intent.action) return false;
  if (!filter.types?.length) return !intent.type;
  return filter.types.some((pattern) => matchType(pattern, intent.type));
}

export class ActivityManager {
  #results = new Map(); // pid → { resolve, callerPid }

  constructor({ packages, processes, events = null, log = null }) {
    this.packages = packages;
    this.processes = processes;
    this.events = events;
    this.log = log;
    /**
     * Hôte graphique, fourni par l'interface système :
     *   launch(appId, intent, opts) → Promise<pid>
     *   choose(packages, intent) → Promise<appId | null>
     *   focus(pid)
     */
    this.host = null;
    events?.on('process:exit', ({ pid }) => {
      const pending = this.#results.get(pid);
      if (pending) {
        this.#results.delete(pid);
        pending.resolve(null);
      }
    });
  }

  resolve(intent) {
    return this.packages
      .list()
      .filter((pkg) => pkg.intents.some((filter) => matchIntent(filter, intent)));
  }

  async start(intent, { callerPid = null, forResult = false } = {}) {
    let appId = intent.app;
    if (!appId) {
      const candidates = this.resolve(intent);
      if (!candidates.length) throw new Error('Aucune application ne peut ouvrir ce contenu');
      if (candidates.length === 1 || !this.host?.choose) appId = candidates[0].id;
      else appId = await this.host.choose(candidates, intent);
      if (!appId) return null;
    }
    if (!this.packages.isInstalled(appId)) throw new Error(`Application non installée : ${appId}`);
    this.log?.info('am', `intent ${intent.action ?? 'main'} → ${appId}`);

    const pid = this.host
      ? await this.host.launch(appId, intent, { callerPid })
      : this.#headlessLaunch(appId, intent, callerPid);

    if (!forResult) return pid;
    return new Promise((resolve) => this.#results.set(pid, { resolve, callerPid }));
  }

  /** Lancement sans interface (tests, terminal sans écran). */
  #headlessLaunch(appId, intent, callerPid) {
    const proc = this.processes.getByApp(appId) ?? this.processes.spawn(appId, { intent, callerPid });
    this.processes.setForeground(proc.pid);
    return proc.pid;
  }

  /** Termine l'activité `pid` et transmet `result` à l'appelant. */
  finish(pid, result = null) {
    const pending = this.#results.get(pid);
    this.#results.delete(pid);
    pending?.resolve(result);
    const callerPid = pending?.callerPid ?? this.processes.get(pid)?.callerPid;
    this.processes.kill(pid, 'finish');
    if (callerPid && this.processes.get(callerPid)) {
      if (this.host?.focus) this.host.focus(callerPid);
      else this.processes.setForeground(callerPid);
    }
  }

  isWaitingForResult(pid) {
    return this.#results.has(pid);
  }
}
