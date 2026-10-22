/**
 * Noyau d'Orion OS : démarre et relie les services système.
 *
 *   events ─ log ─ storage
 *     ├─ accounts        comptes utilisateurs (registre partagé)
 *     ├─ settings        réglages persistants
 *     ├─ fs              système de fichiers virtuel
 *     ├─ packages        gestionnaire de paquets
 *     ├─ processes / am  processus et activités (intents)
 *     ├─ notifications   centre de notifications
 *     ├─ alarms          réveils, minuteurs, rappels
 *     ├─ permissions     autorisations d'exécution
 *     ├─ media           session multimédia globale
 *     ├─ contacts        fournisseur de contacts
 *     ├─ telephony       modem simulé (appels, SMS)
 *     └─ device          HAL : batterie, réseau, vibreur
 */
import { EventBus } from './events.js';
import { SystemLog } from './log.js';
import { MemoryBackend, Namespace } from './storage.js';
import { FileSystem } from './vfs.js';
import { Settings } from './settings.js';
import { PackageManager } from './packages.js';
import { ProcessManager } from './processes.js';
import { ActivityManager } from './intents.js';
import { NotificationService } from './notifications.js';
import { AlarmService } from './alarms.js';
import { PermissionService } from './permissions.js';
import { MediaService } from './media.js';
import { ContactsProvider, DEMO_CONTACTS } from './contacts.js';
import { TelephonyService } from './telephony.js';
import { DeviceService } from './device.js';
import { seedFilesystem, writeSystemFiles } from './seed.js';
import { COMMAND_NAMES } from './shell.js';
import { RELEASE } from './version.js';

export const OS = Object.freeze({
  name: 'Orion OS',
  version: RELEASE.version,
  codename: RELEASE.codename,
  build: RELEASE.build,
  kernel: `orion-kernel ${RELEASE.version}-js`,
});

/**
 * @param {object} options
 * @param {object} [options.backend] pilote de stockage (mémoire par défaut)
 * @param {import('./accounts.js').AccountRegistry} [options.accounts] registre des comptes
 * @param {string} [options.accountId] compte de cette session (le registre peut changer de compte courant)
 * @param {object[]} [options.manifests] manifestes des applications
 * @param {(step: string, progress: number) => void} [options.onProgress]
 */
export async function bootKernel({ backend = new MemoryBackend(), accounts = null, accountId = accounts?.current?.id ?? null, manifests = [], env = globalThis, now = Date.now, timers = globalThis, onProgress = () => {}, echoLog = false } = {}) {
  const log = new SystemLog({ now, echo: echoLog });
  const events = new EventBus((error, type) => log.error('events', `${type}: ${error?.stack ?? error}`));
  log.info('kernel', `${OS.name} ${OS.version} « ${OS.codename} » (${OS.build})`);
  log.info('kernel', `stockage : ${backend.kind}`);
  if (accounts) {
    accounts.events = events;
    log.info('accounts', `${accounts.list().length} compte(s), session de « ${accounts.get(accountId)?.name || 'nouveau compte'} »`);
  }

  const snapshot = await backend.getAll();
  const ns = (name) => new Namespace(backend, name, snapshot);
  onProgress('storage', 0.1);

  const settings = await new Settings({ store: ns('settings'), events }).load();
  log.info('settings', `${Object.keys(settings.all()).length} réglages chargés`);
  onProgress('settings', 0.2);

  const fs = await new FileSystem({ store: ns('fs'), events, now }).mount();
  const firstBoot = !fs.exists('/home');
  if (firstBoot) {
    log.info('vfs', 'premier démarrage : création de l\'arborescence');
    seedFilesystem(fs, now());
  }
  writeSystemFiles(fs, OS, COMMAND_NAMES);
  log.info('vfs', `monté, ${(fs.du('/') / 1024).toFixed(0)} Ko utilisés`);
  onProgress('fs', 0.4);

  const packages = new PackageManager({ store: ns('packages'), events, log, now });
  manifests.forEach((m) => packages.register(m));
  await packages.load();
  log.info('pm', `${packages.list().length} applications installées`);
  onProgress('packages', 0.55);

  const processes = new ProcessManager({ events, log, now });
  const am = new ActivityManager({ packages, processes, events, log });
  const notifications = await new NotificationService({ store: ns('notifications'), events, settings, now }).load();
  const alarms = await new AlarmService({ store: ns('alarms'), events, now, log }).load();
  const permissions = await new PermissionService({ store: ns('permissions'), events, packages, settings }).load();
  const media = new MediaService({ events });
  onProgress('services', 0.7);

  const contacts = new ContactsProvider({ fs, events }).load();
  const telephony = new TelephonyService({ fs, events, contacts, notifications, settings, log, now, timers }).load();
  // Les premières versions livraient des correspondants fictifs : leurs SMS et appels sont effacés une fois.
  if (!settings.get('demoDataRemoved')) {
    telephony.forgetNumbers(DEMO_CONTACTS.map((c) => c.phone));
    settings.set('demoDataRemoved', true);
  }
  const device = await new DeviceService({ events, settings, env, now, log }).init();
  onProgress('hal', 0.85);

  // Désinstallation : arrêt du processus et nettoyage des données de l'app.
  events.on('package:uninstall', ({ id }) => {
    processes.killApp(id, 'uninstall');
    fs.rm(`/data/${id}`, { recursive: true, force: true });
    notifications.clear({ appId: id });
    alarms.cancelApp(id);
    permissions.reset(id);
    media.clear(id);
  });
  events.on('process:exit', ({ appId }) => media.clear(appId));

  const kernel = {
    os: OS,
    backend: backend.kind,
    accounts,
    /**
     * Compte de la session en cours (null sans registre, ou s'il a été supprimé
     * depuis une autre fenêtre). Une autre fenêtre peut changer le compte
     * courant du registre : cette session reste sur ses propres données.
     */
    get account() {
      return accounts?.get(accountId) ?? null;
    },
    firstBoot,
    now,
    log,
    events,
    settings,
    fs,
    packages,
    processes,
    am,
    notifications,
    alarms,
    permissions,
    media,
    contacts,
    telephony,
    device,
    /** Efface toutes les données (réinitialisation d'usine). */
    async factoryReset() {
      log.warn('kernel', 'réinitialisation d\'usine');
      telephony.shutdown();
      await backend.clear();
    },
    shutdown() {
      telephony.shutdown();
      processes.killAll('shutdown');
    },
  };
  log.info('kernel', 'démarrage du noyau terminé');
  onProgress('ready', 1);
  return kernel;
}
