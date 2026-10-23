/**
 * Réglages : configuration complète du système.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { formatBytes, formatDuration, relativeTime } from '../../lib/format.js';
import { navStack, page, listGroup, listItem, toggle, slider, segmented, avatar, button, spinner } from '../../lib/ui.js';
import { PERMISSIONS } from '../../kernel/permissions.js';
import { createPasscode } from '../../kernel/settings.js';
import { displayName } from '../../kernel/contacts.js';
import { WALLPAPERS, wallpaperCss } from '../../system/wallpapers.js';
import { appIcon } from '../../system/app-icon.js';
import { passwordProblem, MIN_PASSWORD_LENGTH } from '../../system/developer.js';
import { logo } from '../../system/power.js';
import { quickTiles } from '../../system/quick-settings.js';
import { unsupportedReason } from '../../kernel/bluetooth.js';
import { formatCoordinates } from '../../kernel/location.js';
import { repairIntegrity } from '../../system/integrity.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROFILE_COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];
const ACCENTS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];

export function mount(root, ctx) {
  const k = ctx.kernel;
  const s = k.settings;
  const ui = ctx.system;
  const nav = navStack(root);

  const accounts = k.accounts;
  /** Compte de la session (profil minimal si les comptes sont indisponibles). */
  const me = () => k.account ?? { id: null, name: s.get('userName'), email: '', color: s.get('accent'), photo: null, owner: !accounts, createdAt: null };
  const accountAvatar = (a, size) => avatar(a.name || '?', { size, color: a.color, photo: a.photo });
  const tiles = quickTiles(ui);
  const row = (opts) => listItem(opts);
  /** Apps listées dans les Réglages : les apps cachées (Terminal) seulement en mode développeur. */
  const visibleApps = () => k.packages.list().filter((p) => !p.hidden || ui.developerUnlocked);
  /** Observateurs créés pendant le rendu d'une page : libérés au rendu suivant ou à sa fermeture. */
  let scope = null;
  const keep = (off) => (scope ? scope.push(off) : ctx.on('destroy', off));
  /** Rendu d'une page avec ses propres observateurs ; renvoie la fonction qui les libère. */
  function scoped(render) {
    let offs = [];
    const release = () => offs.splice(0).forEach((off) => off());
    ctx.on('destroy', release);
    return {
      release,
      run() {
        release();
        const outer = scope;
        scope = offs = [];
        try {
          render();
        } finally {
          scope = outer;
        }
      },
    };
  }
  const toggleRow = (title, key, { icon: iconName, color, subtitle, invert = false, onChange } = {}) => {
    const sw = toggle(invert ? !s.get(key) : s.get(key), (v) => {
      s.set(key, invert ? !v : v);
      onChange?.(v);
    }, { label: title });
    keep(s.watch(key, (v) => sw.set(invert ? !v : v)));
    return listItem({ icon: iconName, iconColor: color, title, subtitle, trailing: sw });
  };

  /** Crée une sous-page et l'empile. `build(content, refresh)` remplit le contenu. */
  function open(title, build, { back = 'Réglages', large = true } = {}) {
    const content = h('div');
    const p = page({ title, large, back: { label: back, onClick: () => nav.pop() }, content });
    const view = scoped(() => content.replaceChildren(...[build(refresh)].flat().filter(Boolean)));
    const refresh = () => view.run();
    p.onShow = refresh;
    p.onPop = view.release;
    refresh();
    nav.push(p);
    return p;
  }

  // ───────────── Page principale ─────────────

  function mainPage() {
    const content = h('div');
    const render = () => {
      const groups = [
        listGroup({
          items: [
            listItem({
              leading: accountAvatar(me(), 58),
              title: h('span.settings-name', me().name),
              subtitle: me().email || `Compte Orion · ${s.get('deviceName')}`,
              chevron: true,
              onClick: accountPage,
              className: 'settings-profile',
            }),
            accounts ? row({ icon: 'users', iconColor: '#8e8e93', title: 'Utilisateurs', detail: String(accounts.list().length), chevron: true, onClick: usersPage }) : null,
          ].filter(Boolean),
        }),
        // Comme sur iOS : une mise à jour disponible est proposée en tête des Réglages.
        ['available', 'downloading', 'ready'].includes(ui.updates?.status)
          ? listGroup({ items: [row({ icon: 'download', iconColor: '#0a84ff', title: ui.updates.status === 'ready' ? 'Mise à jour prête à installer' : 'Mise à jour disponible', subtitle: `Orion OS ${ui.updates.available?.label ?? ui.updates.available?.version ?? ''}`, detail: h('span.update-badge', '1'), chevron: true, onClick: updatesPage })] })
          : null,
        listGroup({
          items: [
            toggleRow('Mode avion', 'airplane', { icon: 'airplane', color: '#ff9500', onChange: () => p.onShow() }),
            row({ icon: 'wifi', iconColor: '#0a84ff', title: 'Wi‑Fi', detail: tiles.wifi.detail(), chevron: true, onClick: wifiPage }),
            row({ icon: 'bluetooth', iconColor: '#0a84ff', title: 'Bluetooth', detail: tiles.bluetooth.detail(), chevron: true, onClick: bluetoothPage }),
            row({ icon: 'antenna', iconColor: '#30d158', title: 'Réseau mobile', detail: k.telephony.mode === 'handoff' ? 'Apps du téléphone' : k.telephony.network.operator, chevron: true, onClick: cellularPage }),
          ],
        }),
        listGroup({
          items: [
            row({ icon: 'bell', iconColor: '#ff3b30', title: 'Notifications', chevron: true, onClick: notificationsPage }),
            row({ icon: 'volume', iconColor: '#ff2d55', title: 'Sons et vibrations', chevron: true, onClick: soundPage }),
            toggleRow('Ne pas déranger', 'dnd', { icon: 'moon-fill', color: '#5e5ce6' }),
          ],
        }),
        listGroup({
          items: [
            row({ icon: 'sun', iconColor: '#0a84ff', title: 'Écran et luminosité', chevron: true, onClick: displayPage }),
            row({ icon: 'image', iconColor: '#32ade6', title: "Fond d'écran", chevron: true, onClick: wallpaperPage }),
            row({ icon: 'palette', iconColor: '#bf5af2', title: 'Personnalisation', chevron: true, onClick: personalizationPage }),
          ],
        }),
        listGroup({
          items: [
            row({ icon: 'hand', iconColor: '#0a84ff', title: 'Confidentialité et sécurité', chevron: true, onClick: privacyPage }),
            row({ icon: 'shield', iconColor: '#30d158', title: 'Protection de l\'appareil', detail: protectionSummary(), chevron: true, onClick: protectionPage }),
            row({ icon: 'lock', iconColor: '#ff3b30', title: 'Code de verrouillage', detail: s.get('passcode') ? 'Activé' : 'Désactivé', chevron: true, onClick: passcodePage }),
            row({ icon: 'battery', iconColor: '#30d158', title: 'Batterie', detail: `${Math.round(k.device.battery.level * 100)} %`, chevron: true, onClick: batteryPage }),
            row({ icon: 'storage', iconColor: '#8e8e93', title: 'Stockage', detail: formatBytes(k.fs.du('/')), chevron: true, onClick: storagePage }),
          ],
        }),
        listGroup({
          items: [
            row({ icon: 'apps', iconColor: '#5856d6', title: 'Applications', detail: String(visibleApps().length), chevron: true, onClick: appsPage }),
            row({ icon: 'camera', iconColor: '#8e8e93', title: 'Appareil photo', chevron: true, onClick: cameraPage }),
            row({ icon: 'settings', iconColor: '#8e8e93', title: 'Général', chevron: true, onClick: generalPage }),
            row({ icon: 'code', iconColor: '#636366', title: 'Mode développeur', detail: dev.unlocked ? 'Déverrouillé' : icon('lock', { size: 15 }), chevron: true, onClick: developerPage }),
            row({ icon: 'info', iconColor: '#8e8e93', title: `À propos de ${k.os.name}`, chevron: true, onClick: aboutPage }),
          ].filter(Boolean),
        }),
      ];
      content.replaceChildren(...groups);
    };
    const p = page({ title: 'Réglages', content });
    const view = scoped(render);
    p.onShow = () => view.run();
    view.run();
    return p;
  }

  // ───────────── Compte et utilisateurs ─────────────

  /** Recadre une photo en carré de 256 px (le registre des comptes reste léger). */
  function shrinkPhoto(dataUrl, size = 256) {
    return new Promise((resolve) => {
      const img = document.createElement('img');
      img.onload = () => {
        try {
          const w = img.naturalWidth || size;
          const hgt = img.naturalHeight || size;
          const side = Math.min(w, hgt);
          const canvas = h('canvas', { width: size, height: size });
          canvas.getContext('2d').drawImage(img, (w - side) / 2, (hgt - side) / 2, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch {
          resolve(dataUrl.length < 300_000 ? dataUrl : null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function changePhoto(refresh) {
    const a = me();
    const choice = await ctx.ui.actionSheet({
      title: 'Photo du profil',
      actions: [{ label: 'Choisir une photo', value: 'pick', icon: 'image' }, a.photo ? { label: 'Retirer la photo', value: 'remove', icon: 'trash', destructive: true } : null].filter(Boolean),
    });
    if (choice === 'remove') accounts.update(a.id, { photo: null });
    if (choice === 'pick') {
      const result = await ctx.startActivityForResult({ action: 'pick', type: 'image/*' });
      if (!result?.path) return;
      const photo = await shrinkPhoto(ctx.fs.readFile(result.path));
      if (!photo) return ctx.ui.toast('Cette image ne peut pas être utilisée');
      accounts.update(a.id, { photo });
      ctx.ui.toast('Photo mise à jour');
    }
    refresh();
  }

  function accountPage() {
    open('Compte', (refresh) => {
      const a = me();
      const since = a.createdAt ? new Date(a.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
      return [
        h(
          'div.settings-hero',
          accounts
            ? h('button.account-photo', { type: 'button', 'aria-label': 'Modifier la photo', onclick: () => changePhoto(refresh) }, accountAvatar(a, 92), h('span.account-photo-edit', icon('camera', { size: 14 })))
            : accountAvatar(a, 92),
          h('h2', a.name),
          h('p', a.email || `${k.os.name} · ${s.get('deviceName')}`),
        ),
        listGroup({
          items: [
            row({ title: 'Nom', detail: a.name, chevron: true, onClick: async () => { const v = await ctx.ui.prompt({ title: 'Votre nom', value: a.name }); if (v?.trim()) { s.set('userName', v.trim()); refresh(); } } }),
            accounts
              ? row({
                  title: 'Adresse e-mail',
                  detail: a.email || 'Ajouter',
                  chevron: true,
                  onClick: async () => {
                    const v = await ctx.ui.prompt({ title: 'Adresse e-mail', value: a.email, type: 'email', placeholder: 'nom@exemple.fr' });
                    if (v == null) return;
                    if (v.trim() && !EMAIL.test(v.trim())) return ctx.ui.alert({ title: 'Adresse invalide', message: 'Vérifiez l\'adresse e-mail saisie.' });
                    accounts.update(a.id, { email: v.trim() });
                    refresh();
                  },
                })
              : null,
            accounts
              ? h(
                  'div.list-item.account-colors',
                  h('span', 'Couleur'),
                  h('div', PROFILE_COLORS.map((c) => h(`button.account-color${c === a.color ? '.active' : ''}`, { type: 'button', 'aria-label': `Couleur ${c}`, style: { background: c }, onclick: () => { accounts.update(a.id, { color: c }); refresh(); } }))),
                )
              : null,
          ].filter(Boolean),
        }),
        listGroup({
          items: [
            row({ icon: 'lock', iconColor: '#ff3b30', title: 'Code de verrouillage', detail: s.get('passcode') ? 'Activé' : 'Désactivé', chevron: true, onClick: passcodePage }),
            accounts ? row({ icon: 'users', iconColor: '#8e8e93', title: 'Utilisateurs', detail: String(accounts.list().length), chevron: true, onClick: usersPage }) : null,
            row({ icon: 'phone-fill', iconColor: '#30d158', title: "Nom de l'appareil", detail: s.get('deviceName'), chevron: true, onClick: async () => { const v = await ctx.ui.prompt({ title: "Nom de l'appareil", value: s.get('deviceName') }); if (v?.trim()) { s.set('deviceName', v.trim()); refresh(); } } }),
          ].filter(Boolean),
          footer: accounts ? `${a.owner ? 'Propriétaire de l\'appareil' : 'Utilisateur de l\'appareil'}${since ? ` · compte créé le ${since}` : ''}. Le compte est enregistré sur ce téléphone uniquement.` : null,
        }),
      ];
    });
  }

  function usersPage() {
    open('Utilisateurs', (refresh) => {
      const current = me();
      const describe = (a) => [a.id === current.id ? 'Vous' : null, a.owner ? 'Propriétaire' : null, a.email || null].filter(Boolean).join(' · ') || 'Utilisateur';
      return [
        listGroup({
          header: 'Sur cet appareil',
          items: accounts.list().map((a) =>
            row({
              leading: accountAvatar(a, 40),
              title: a.name || 'Nouvel utilisateur',
              subtitle: describe(a),
              trailing: a.id === current.id ? h('span.check-mark', icon('check', { size: 18, stroke: 2.6 })) : null,
              chevron: a.id !== current.id,
              onClick: a.id === current.id ? accountPage : () => userActions(a, refresh),
            }),
          ),
          footer: 'Chaque utilisateur a son propre espace : apps, fichiers, réglages, contacts, messages et code. Changez d\'utilisateur depuis l\'écran verrouillé ou le volet de notifications.',
        }),
        current.owner
          ? listGroup({ items: [row({ icon: 'user-plus', iconColor: '#30d158', title: 'Ajouter un utilisateur', onClick: () => addUser(refresh) })] })
          : listGroup({ items: [row({ title: `Supprimer ${current.name} de cet appareil`, destructive: true, onClick: () => removeUser(current) })], footer: 'Seul le propriétaire peut ajouter des utilisateurs.' }),
      ];
    }, { back: 'Compte' });
  }

  async function userActions(a, refresh) {
    const choice = await ctx.ui.actionSheet({
      title: a.name,
      actions: [{ label: `Passer à ${a.name || 'ce compte'}`, value: 'switch', icon: 'users' }, me().owner && !a.owner ? { label: 'Supprimer l\'utilisateur', value: 'remove', icon: 'trash', destructive: true } : null].filter(Boolean),
    });
    if (choice === 'switch') ui.switchAccount(a.id);
    if (choice === 'remove' && (await removeUser(a))) refresh();
  }

  async function addUser(refresh) {
    const name = (await ctx.ui.prompt({ title: 'Nouvel utilisateur', message: 'Il disposera de son propre espace sur ce téléphone.', placeholder: 'Prénom et nom', confirmLabel: 'Ajouter' }))?.trim();
    if (!name) return;
    const account = accounts.create({ name });
    refresh();
    if (await ctx.ui.confirm({ title: `Passer à ${name} maintenant ?`, message: 'La configuration de son compte va commencer.', confirmLabel: 'Changer' })) {
      // L'assistant du nouveau compte pourra être annulé pour revenir ici.
      accounts.update(account.id, { returnTo: me().id });
      ui.switchAccount(account.id);
    } else ctx.ui.toast(`${name} a été ajouté`);
  }

  async function removeUser(a) {
    const self = a.id === me().id;
    const ok = await ctx.ui.confirm({
      title: self ? 'Supprimer votre compte ?' : `Supprimer ${a.name} ?`,
      message: 'Ses apps, fichiers, photos, contacts, messages et réglages seront définitivement effacés de cet appareil.',
      confirmLabel: 'Supprimer',
      destructive: true,
    });
    if (!ok) return false;
    await ui.deleteAccount(a.id);
    if (!self) ctx.ui.toast(`${a.name} a été supprimé`);
    return true;
  }

  // ───────────── Connectivité ─────────────

  /** Rafraîchit la page à chaque événement tant qu'elle est affichée ; `stop` à sa fermeture. */
  function live(p, types, stop = null) {
    const offs = types.map((type) => k.events.on(type, () => nav.top === p && p.onShow()));
    const end = () => {
      offs.splice(0).forEach((off) => off());
      stop?.();
      stop = null;
    };
    const release = p.onPop;
    p.onPop = () => {
      end();
      release?.();
    };
    ctx.on('destroy', end);
    return p;
  }

  const failed = (title) => (error) => ctx.ui.alert({ title, message: error.message });
  const strength = (signal) => h('span.wifi-strength', { dataset: { level: String(signal == null ? 3 : signal >= 60 ? 3 : signal >= 35 ? 2 : 1) } }, icon('wifi', { size: 18 }));
  const wifiMeta = (n) => h('span.wifi-meta', n.security ? icon('lock', { size: 14 }) : null, strength(n.signal));
  const TYPE_LABELS = { wifi: 'Wi‑Fi', cellular: 'Réseau mobile', ethernet: 'Ethernet (câble)', other: 'Autre', none: 'Aucune', unknown: 'Non indiquée' };
  const QUALITY_LABELS = { '4g': 'Rapide (équivalent 4G)', '3g': 'Moyenne (équivalent 3G)', '2g': 'Lente (équivalent 2G)', 'slow-2g': 'Très lente' };

  /** Ce que le navigateur sait vraiment de la connexion (Network Information API). */
  function connectionRows(st) {
    return [
      row({ title: 'État', detail: st.airplane && !st.online ? 'Mode avion' : st.online ? 'En ligne' : 'Hors ligne' }),
      row({ title: 'Connexion', detail: TYPE_LABELS[st.type] ?? st.type }),
      st.quality ? row({ title: 'Qualité', detail: QUALITY_LABELS[st.quality] ?? st.quality }) : null,
      st.downlink ? row({ title: 'Débit estimé', detail: `${String(st.downlink).replace('.', ',')} Mb/s` }) : null,
      st.rtt ? row({ title: 'Latence estimée', detail: `${st.rtt} ms` }) : null,
      st.saveData ? row({ title: 'Économiseur de données', detail: 'Activé' }) : null,
      st.ip ? row({ title: 'Adresse IP', detail: st.ip }) : null,
    ].filter(Boolean);
  }

  /** Test de connexion : latence vers le serveur d'Orion et débit descendant. */
  function speedTestGroup(refresh) {
    const result = speedTestGroup.result;
    return listGroup({
      header: 'Test de connexion',
      items: [
        result?.running
          ? row({ title: 'Mesure en cours…', trailing: spinner(18) })
          : row({
              icon: 'bolt',
              iconColor: '#30d158',
              title: 'Tester la connexion',
              onClick: async () => {
                speedTestGroup.result = { running: true };
                refresh();
                try {
                  speedTestGroup.result = await k.network.speedTest();
                } catch (error) {
                  speedTestGroup.result = { error: error.message };
                }
                refresh();
              },
            }),
        result?.error ? row({ title: 'Résultat', detail: result.error }) : null,
        result?.latency != null ? row({ title: 'Latence', detail: `${result.latency} ms` }) : null,
        result?.latency != null ? row({ title: 'Débit descendant', detail: result.download != null ? `${String(result.download).replace('.', ',')} Mb/s` : 'Non mesurable ici' }) : null,
      ].filter(Boolean),
      footer: 'Le débit est mesuré en téléchargeant 5 Mo depuis speed.cloudflare.com.',
    });
  }

  function wifiPage() {
    const net = k.network;
    if (!net.controllable) {
      const p = open('Wi‑Fi', (refresh) => {
        const st = net.state;
        return [
          listGroup({
            header: 'Connexion actuelle',
            items: connectionRows(st),
            footer: 'Sur un téléphone, la radio Wi‑Fi est gérée par Android ou iOS : choisissez votre réseau dans les réglages du téléphone. Orion indique ici ce que le navigateur sait réellement de la connexion. Installé sur un ordinateur, une tablette ou une machine virtuelle, Orion pilote lui-même le Wi‑Fi.',
          }),
          speedTestGroup(refresh),
        ];
      });
      return live(p, ['network:change']);
    }

    let joining = null;
    let scanning = false;
    const p = open('Wi‑Fi', (refresh) => {
      const st = net.state;
      const wifi = st.wifi;
      const power = toggle(wifi.enabled, (on) => net.setWifiEnabled(on).catch(failed('Wi‑Fi')).finally(refresh), { label: 'Wi‑Fi' });
      const groups = [listGroup({ items: [row({ icon: 'wifi', iconColor: '#0a84ff', title: 'Wi‑Fi', trailing: power })], footer: st.airplane ? 'Le mode avion est activé.' : null })];
      if (!wifi.enabled) return groups;
      const c = wifi.connected;
      if (c) {
        groups.push(listGroup({ items: [row({ leading: h('span.check-mark', icon('check', { size: 18, stroke: 2.6 })), title: c.ssid, subtitle: ['Connecté', c.ip].filter(Boolean).join(' · '), trailing: wifiMeta(c), chevron: true, onClick: () => wifiDetails(c) })] }));
      }
      const others = wifi.networks.filter((n) => !n.active && n.ssid !== c?.ssid);
      groups.push(
        listGroup({
          header: h('span.scanning', 'Réseaux', scanning ? spinner(14) : null),
          items: [
            ...others.map((n) => row({ title: n.ssid, subtitle: joining === n.ssid ? 'Connexion…' : n.known ? 'Enregistré' : null, trailing: joining === n.ssid ? spinner(16) : wifiMeta(n), onClick: () => join(n) })),
            row({ title: 'Autre réseau…', onClick: joinHidden }),
          ],
          footer: others.length ? null : scanning ? null : 'Aucun autre réseau à proximité.',
        }),
        listGroup({ items: [row({ icon: 'refresh', iconColor: '#0a84ff', title: 'Rechercher à nouveau', onClick: rescan })] }),
      );
      return groups;
    });

    async function rescan() {
      if (scanning) return;
      scanning = true;
      p.onShow();
      await net.refresh({ rescan: true }).catch(failed('Recherche impossible'));
      scanning = false;
      p.onShow();
    }

    async function join(n, { ssid = n?.ssid, password = null, hidden = false } = {}) {
      if (joining) return;
      if (n?.security && !n.known && password == null) {
        password = await ctx.ui.prompt({ title: `Mot de passe pour « ${ssid} »`, type: 'password', placeholder: 'Mot de passe', confirmLabel: 'Rejoindre' });
        if (password == null) return;
      }
      joining = ssid;
      p.onShow();
      let failure = null;
      try {
        await net.connect(ssid, password || null, { hidden });
        ctx.ui.toast(`Connecté à ${ssid}`);
      } catch (error) {
        failure = error;
      } finally {
        joining = null;
        p.onShow();
      }
      if (!failure) return;
      if (n?.known && password == null) {
        // Réseau enregistré : son mot de passe a peut-être changé.
        const choice = await ctx.ui.actionSheet({
          title: `Impossible de rejoindre « ${ssid} »`,
          message: failure.message,
          actions: [{ label: 'Saisir le mot de passe', value: 'password' }, { label: 'Oublier ce réseau', value: 'forget', destructive: true }],
        });
        if (choice === 'password') {
          const pw = await ctx.ui.prompt({ title: `Mot de passe pour « ${ssid} »`, type: 'password', placeholder: 'Mot de passe', confirmLabel: 'Rejoindre' });
          if (pw != null) join(n, { ssid, password: pw });
        } else if (choice === 'forget') {
          net.forget(ssid).then(() => ctx.ui.toast(`« ${ssid} » oublié`), failed('Impossible d\'oublier ce réseau'));
        }
        return;
      }
      ctx.ui.alert({ title: `Impossible de rejoindre « ${ssid} »`, message: failure.message });
    }

    async function joinHidden() {
      const ssid = (await ctx.ui.prompt({ title: 'Autre réseau', message: 'Nom du réseau (SSID)', placeholder: 'Nom', confirmLabel: 'Suivant' }))?.trim();
      if (!ssid) return;
      const password = await ctx.ui.prompt({ title: `Mot de passe pour « ${ssid} »`, message: 'Laissez vide pour un réseau ouvert.', type: 'password', placeholder: 'Mot de passe', confirmLabel: 'Rejoindre' });
      if (password == null) return;
      join(null, { ssid, password, hidden: true });
    }

    function wifiDetails(c) {
      const band = c.frequency ? (c.frequency >= 5900 ? '6 GHz' : c.frequency >= 4900 ? '5 GHz' : '2,4 GHz') : null;
      open(c.ssid, () => [
        listGroup({
          items: [
            row({ title: 'Signal', detail: c.signal != null ? `${c.signal} %` : '—' }),
            row({ title: 'Sécurité', detail: c.security || 'Aucune (réseau ouvert)' }),
            band ? row({ title: 'Bande', detail: `${band} (${c.frequency} MHz)` }) : null,
            row({ title: 'Adresse IP', detail: c.ip || '—' }),
          ].filter(Boolean),
        }),
        listGroup({
          items: [
            row({ title: 'Se déconnecter', onClick: () => net.disconnect().then(() => nav.pop(), failed('Déconnexion impossible')) }),
            row({
              title: 'Oublier ce réseau',
              destructive: true,
              onClick: async () => {
                if (!(await ctx.ui.confirm({ title: `Oublier « ${c.ssid} » ?`, message: 'Le mot de passe enregistré sera effacé.', confirmLabel: 'Oublier', destructive: true }))) return;
                net.forget(c.ssid).then(() => nav.pop(), failed('Impossible d\'oublier ce réseau'));
              },
            }),
          ],
        }),
      ], { back: 'Wi‑Fi', large: false });
    }

    live(p, ['network:change'], net.watch());
    if (net.state.wifi.enabled) rescan();
  }

  const BT_ICONS = { audio: 'volume', phone: 'phone', computer: 'code', keyboard: 'keypad', mouse: 'hand', gamepad: 'gamepad', watch: 'clock', ble: 'bluetooth', other: 'bluetooth' };

  function bluetoothPage() {
    const bt = k.bluetooth;
    let busy = null;
    const p = open('Bluetooth', (refresh) => {
      if (!bt.available) {
        return listGroup({
          items: [row({ icon: 'bluetooth', iconColor: '#8e8e93', title: 'Bluetooth', detail: 'Indisponible' })],
          footer: `${unsupportedReason()} Sur Android, Chrome permet de connecter des appareils Bluetooth basse consommation (montres, capteurs…). Installé sur un ordinateur ou une tablette, Orion gère tous les appareils Bluetooth.`,
        });
      }
      const st = bt.state;
      const power = toggle(st.enabled, (on) => bt.setPowered(on).catch(failed('Bluetooth')).finally(refresh), { label: 'Bluetooth' });
      const groups = [
        listGroup({
          items: [row({ icon: 'bluetooth', iconColor: '#0a84ff', title: 'Bluetooth', trailing: power })],
          footer: st.mode === 'bridge' ? `Visible sous le nom « ${k.bridge.info?.hostname ?? s.get('deviceName')} » pendant la recherche.` : 'Orion se connecte aux appareils Bluetooth basse consommation (montres, capteurs, balises…) choisis dans la fenêtre du navigateur. Les écouteurs et enceintes s\'appairent dans les réglages Bluetooth du téléphone.',
        }),
      ];
      if (!st.enabled) return groups;
      const describe = (d) => [busy === d.id ? 'Connexion…' : d.connected ? 'Connecté' : d.paired ? 'Non connecté' : null, d.battery != null ? `batterie ${d.battery} %` : null, d.error ?? null].filter(Boolean).join(' · ') || null;
      const deviceRow = (d) =>
        row({
          icon: BT_ICONS[d.kind] ?? 'bluetooth',
          iconColor: d.connected ? '#0a84ff' : '#8e8e93',
          title: d.name,
          subtitle: describe(d),
          trailing: busy === d.id ? spinner(16) : null,
          onClick: () => (d.paired ? deviceActions(d) : act(d, () => bt.connect(d.id), `${d.name} connecté`)),
        });
      const devices = st.devices;
      const paired = devices.filter((d) => d.paired);
      groups.push(listGroup({ header: 'Mes appareils', items: paired.map(deviceRow), footer: paired.length ? null : 'Aucun appareil.' }));
      if (st.mode === 'bridge') {
        const others = devices.filter((d) => !d.paired);
        groups.push(
          listGroup({
            header: h('span.scanning', 'Autres appareils', st.scanning ? spinner(14) : null),
            items: [...others.map(deviceRow), st.scanning ? null : row({ icon: 'refresh', iconColor: '#0a84ff', title: 'Rechercher', onClick: () => bt.scan().catch(failed('Recherche impossible')) })].filter(Boolean),
            footer: 'Mettez l\'appareil en mode appairage pour qu\'il apparaisse.',
          }),
        );
      } else {
        groups.push(listGroup({ items: [row({ icon: 'plus', iconColor: '#0a84ff', title: 'Ajouter un appareil…', onClick: () => bt.add().then((d) => d && ctx.ui.toast(`${d.name || 'Appareil'} connecté`), failed('Bluetooth')) })] }));
      }
      return groups;
    });

    async function act(d, action, done) {
      busy = d.id;
      p.onShow();
      try {
        await action();
        if (done) ctx.ui.toast(done);
      } catch (error) {
        ctx.ui.alert({ title: d.name, message: error.message });
      } finally {
        busy = null;
        p.onShow();
      }
    }

    async function deviceActions(d) {
      const choice = await ctx.ui.actionSheet({
        title: d.name,
        actions: [d.connected ? { label: 'Déconnecter', value: 'disconnect' } : { label: 'Connecter', value: 'connect' }, { label: 'Oublier cet appareil', value: 'forget', destructive: true }],
      });
      if (choice === 'connect') act(d, () => bt.connect(d.id), `${d.name} connecté`);
      else if (choice === 'disconnect') act(d, () => bt.disconnect(d.id));
      else if (choice === 'forget') act(d, () => bt.forget(d.id), `${d.name} oublié`);
    }

    live(p, ['bluetooth:change'], bt.watch());
    if (bt.mode === 'bridge' && bt.enabled) bt.scan().catch(() => {});
  }

  function cellularPage() {
    const tel = k.telephony;
    const MODES = { modem: 'Modem', handoff: 'Apps du téléphone', simulated: 'Simulation' };
    const p = open('Réseau mobile', (refresh) => {
      const n = tel.network;
      const groups = [];
      if (n.mode === 'modem') {
        groups.push(
          listGroup({
            items: [
              row({ icon: 'antenna', iconColor: '#30d158', title: 'Données mobiles', trailing: toggle(n.data, (on) => tel.setMobileData(on).catch(failed('Données mobiles')).finally(refresh), { label: 'Données mobiles' }) }),
              row({ icon: 'power', iconColor: '#8e8e93', title: 'Modem', trailing: toggle(n.enabled, (on) => tel.setModemEnabled(on).catch(failed('Modem')).finally(refresh), { label: 'Modem' }) }),
            ],
          }),
          listGroup({
            header: 'Opérateur',
            items: [
              row({ title: 'Opérateur', detail: n.operator }),
              row({ title: 'Réseau', detail: [n.type, n.roaming ? 'itinérance' : null].filter(Boolean).join(' · ') || '—' }),
              row({ title: 'Signal', detail: n.signalPercent != null && n.cellular ? `${n.signalPercent} %` : '—' }),
              row({ title: 'Carte SIM', detail: n.sim === false ? 'Absente' : n.sim ? 'Présente' : '—' }),
              row({ title: 'Numéro', detail: n.number ?? '—' }),
            ],
            footer: 'Les appels et SMS passent par le modem (ModemManager). Le son des appels dépend de la prise en charge du modem.',
          }),
        );
      } else {
        const pref = s.get('telephony.mode') ?? 'auto';
        groups.push(
          listGroup({
            header: 'Appels et SMS',
            items: [h('div.list-item', segmented([{ value: 'auto', label: 'Auto' }, { value: 'handoff', label: 'Téléphone' }, { value: 'simulated', label: 'Simulation' }], pref, (v) => { s.set('telephony.mode', v); refresh(); }))],
            footer: n.mode === 'handoff'
              ? 'Une page web n\'a pas accès au modem du téléphone : Orion confie chaque appel à l\'app Téléphone et chaque SMS à l\'app Messages du système. Ce sont de vrais appels et de vrais SMS ; Orion garde l\'historique et vos conversations. Les messages reçus arrivent dans l\'app Messages du téléphone.'
              : 'Mode démonstration : aucun appel ni SMS ne quitte l\'appareil, les correspondants répondent automatiquement. Sur un téléphone, choisissez « Téléphone » pour passer de vrais appels.',
          }),
          listGroup({ items: [row({ title: 'Utilisé en ce moment', detail: MODES[n.mode] })] }),
        );
        if (n.mode === 'simulated') groups.push(listGroup({ header: 'Réseau simulé', items: [toggleRow('Réseau mobile simulé', 'cellular', { onChange: refresh }), row({ title: 'Opérateur', detail: n.operator })] }));
        groups.push(listGroup({ header: 'Connexion du navigateur', items: connectionRows(k.network.state) }));
      }
      if (n.mode !== 'simulated') {
        groups.push(
          listGroup({
            items: [
              row({
                icon: 'voicemail',
                iconColor: '#30d158',
                title: 'Messagerie vocale',
                detail: s.get('telephony.voicemail') || 'À définir',
                onClick: async () => {
                  const number = await ctx.ui.prompt({ title: 'Messagerie vocale', message: 'Orange 888, SFR 123, Bouygues Telecom 660, Free 666…', value: s.get('telephony.voicemail') ?? '', placeholder: 'Numéro', type: 'tel', confirmLabel: 'Enregistrer' });
                  if (number == null) return;
                  if (number.trim()) s.set('telephony.voicemail', number.trim());
                  else s.reset('telephony.voicemail');
                  refresh();
                },
              }),
            ],
          }),
        );
      }
      return groups;
    });
    live(p, ['network:change']);
  }

  function locationPage() {
    const loc = k.location;
    let measuring = false;
    const p = open('Service de localisation', (refresh) => {
      const position = loc.last;
      const sourceLabel = loc.source === 'gps' ? 'Récepteur GPS (gpsd)' : loc.source === 'browser' ? 'Navigateur (GPS, Wi‑Fi et antennes du téléphone)' : 'Aucune';
      const apps = visibleApps().filter((pkg) => pkg.permissions.includes('location'));
      return [
        listGroup({ items: [toggleRow('Service de localisation', 'location', { icon: 'location', color: '#0a84ff', onChange: refresh })], footer: 'Les applications doivent aussi obtenir votre autorisation. Sur un téléphone, le navigateur demande en plus la sienne.' }),
        listGroup({
          header: 'Source',
          items: [
            row({ title: 'Source', detail: sourceLabel }),
            position ? row({ title: 'Dernière position', subtitle: formatCoordinates(position), detail: relativeTime(position.time, k.now()) }) : null,
            position?.accuracy != null ? row({ title: 'Précision', detail: `± ${Math.round(position.accuracy)} m` }) : null,
            position?.satellites != null ? row({ title: 'Satellites', detail: String(position.satellites) }) : null,
            loc.error ? row({ title: 'État', subtitle: loc.error }) : null,
            s.get('location') && loc.source
              ? measuring
                ? row({ title: 'Recherche de la position…', trailing: spinner(18) })
                : row({
                    icon: 'crosshair',
                    iconColor: '#0a84ff',
                    title: 'Localiser maintenant',
                    onClick: async () => {
                      measuring = true;
                      refresh();
                      await loc.current({ maxAge: 0 }).catch((error) => ctx.ui.alert({ title: 'Localisation', message: error.message }));
                      measuring = false;
                      refresh();
                    },
                  })
              : null,
          ].filter(Boolean),
        }),
        listGroup({
          header: 'Applications',
          items: apps.map((pkg) => row({ leading: appIcon(pkg, { size: 30 }), title: pkg.name, detail: { granted: 'Autorisée', denied: 'Refusée', prompt: 'Demander' }[k.permissions.check(pkg.id, 'location')] ?? '', chevron: true, onClick: () => permissionPage('location', PERMISSIONS.location) })),
          footer: apps.length ? null : 'Aucune application ne demande la position.',
        }),
      ];
    });
    live(p, ['location:change', 'permission:change']);
  }

  // ───────────── Notifications & sons ─────────────

  function notificationsPage() {
    open('Notifications', () => [
      listGroup({ items: [toggleRow('Ne pas déranger', 'dnd', { icon: 'moon-fill', color: '#5e5ce6', subtitle: 'Masque les bannières et coupe les sons' })] }),
      listGroup({
        header: 'Applications',
        items: visibleApps().map((pkg) => {
          const key = `notifications.${pkg.id}`;
          const sw = toggle(s.get(key) !== false, (v) => s.set(key, v), { label: pkg.name });
          return row({ leading: appIcon(pkg, { size: 30 }), title: pkg.name, trailing: sw });
        }),
      }),
    ]);
  }

  function soundPage() {
    open('Sons et vibrations', () => [
      listGroup({
        header: 'Volume',
        items: [h('div.list-item', slider({ value: s.get('volume'), min: 0, max: 1, step: 0.05, iconLeft: 'volume-low', iconRight: 'volume', onInput: (v) => s.set('volume', v), label: 'Volume' }))],
      }),
      listGroup({
        items: [
          toggleRow('Mode silencieux', 'silent', { icon: 'bell-off', color: '#ff3b30' }),
          toggleRow('Sons du système', 'sounds', { icon: 'volume', color: '#ff2d55', subtitle: 'Clics, verrouillage' }),
          toggleRow('Vibrations', 'haptics', { icon: 'waveform', color: '#ff9500' }),
        ],
      }),
      listGroup({
        items: [
          row({ title: 'Tester la sonnerie', onClick: () => { ctx.sound.startLoop('ring'); setTimeout(() => ctx.sound.stopLoop('ring'), 2600); } }),
          row({ title: 'Tester la notification', onClick: () => ctx.sound.notify() }),
        ],
      }),
    ]);
  }

  // ───────────── Affichage ─────────────

  function displayPage() {
    open('Écran et luminosité', (refresh) => [
      listGroup({
        header: 'Apparence',
        items: [
          h(
            'div.list-item.theme-picker',
            ...[
              ['light', 'Clair'],
              ['dark', 'Sombre'],
              ['auto', 'Auto'],
            ].map(([value, label]) =>
              h(
                `button.theme-option${s.get('theme') === value ? '.active' : ''}`,
                { type: 'button', onclick: () => { s.set('theme', value); refresh(); } },
                h(`div.theme-preview.${value}`, h('span'), h('span'), h('span')),
                h('span', label),
                h('span.theme-radio', s.get('theme') === value ? icon('check', { size: 12, stroke: 3 }) : null),
              ),
            ),
          ),
        ],
      }),
      listGroup({
        header: 'Luminosité',
        items: [
          h('div.list-item', slider({ value: s.get('brightness'), min: 0.15, max: 1, step: 0.01, iconLeft: 'sun', iconRight: 'sun', onInput: (v) => s.set('brightness', v), label: 'Luminosité' })),
          toggleRow('Night Shift', 'nightShift', { subtitle: 'Couleurs plus chaudes pour le soir' }),
        ],
      }),
      listGroup({
        header: 'Texte',
        items: [h('div.list-item', h('span.text-small', 'A'), slider({ value: s.get('fontScale'), min: 0.85, max: 1.3, step: 0.05, onInput: (v) => s.set('fontScale', v), label: 'Taille du texte' }), h('span.text-large', 'A'))],
      }),
      listGroup({
        header: 'Verrouillage automatique',
        items: [
          h(
            'div.list-item',
            segmented(
              [
                { value: 30, label: '30 s' },
                { value: 60, label: '1 min' },
                { value: 120, label: '2 min' },
                { value: 300, label: '5 min' },
                { value: 0, label: 'Jamais' },
              ],
              s.get('autoLock'),
              (v) => s.set('autoLock', v),
            ),
          ),
        ],
      }),
    ]);
  }

  function wallpaperPage() {
    open("Fond d'écran", (refresh) => {
      const current = s.get('wallpaper');
      const custom = typeof current === 'string' && current.startsWith('/');
      return [
        h(
          'div.wallpaper-current',
          h('div.wallpaper-phone', { style: { background: wallpaperCss(current, k.fs) } }, h('div.wp-time', '09:41')),
          h('div.wallpaper-phone', { style: { background: wallpaperCss(current, k.fs) } }, h('div.wp-grid', Array.from({ length: 12 }, () => h('i')))),
        ),
        h(
          'div.wallpaper-grid',
          WALLPAPERS.map((w) =>
            h(
              `button.wallpaper-tile${current === w.id ? '.active' : ''}`,
              { type: 'button', style: { background: wallpaperCss(w.id, k.fs) }, onclick: () => { s.set('wallpaper', w.id); refresh(); } },
              h('span', w.name),
            ),
          ),
        ),
        listGroup({
          items: [
            row({
              icon: 'image',
              iconColor: '#f2437b',
              title: 'Choisir une photo…',
              detail: custom ? 'Photo' : null,
              chevron: true,
              onClick: async () => {
                const result = await ctx.startActivityForResult({ action: 'pick', type: 'image/*' });
                if (result?.path) {
                  s.set('wallpaper', result.path);
                  ctx.ui.toast("Fond d'écran mis à jour");
                  refresh();
                }
              },
            }),
          ],
        }),
      ];
    });
  }

  function personalizationPage() {
    open('Personnalisation', (refresh) => [
      listGroup({
        header: "Couleur d'accentuation",
        items: [
          h(
            'div.list-item.accent-row',
            ACCENTS.map((color) =>
              h(`button.accent-swatch${s.get('accent') === color ? '.active' : ''}`, { type: 'button', 'aria-label': color, style: { background: color }, onclick: () => { s.set('accent', color); refresh(); } }, s.get('accent') === color ? icon('check', { size: 16, stroke: 3 }) : null),
            ),
          ),
        ],
      }),
      listGroup({
        header: 'Forme des icônes',
        items: [
          h(
            'div.list-item',
            segmented(
              [
                { value: 'squircle', label: 'iOS' },
                { value: 'rounded', label: 'Arrondie' },
                { value: 'circle', label: 'Android' },
              ],
              s.get('iconShape'),
              (v) => s.set('iconShape', v),
            ),
          ),
        ],
      }),
      listGroup({
        header: 'Navigation système',
        footer: s.get('navigation') === 'gestures'
          ? 'Balayez vers le haut depuis le bas pour revenir à l\'accueil, maintenez pour les apps récentes, glissez depuis un bord pour revenir en arrière.'
          : 'Boutons Retour, Accueil et Récentes en bas de l\'écran.',
        items: [
          h(
            'div.list-item',
            segmented(
              [
                { value: 'gestures', label: 'Gestes' },
                { value: 'buttons', label: 'Boutons ◁ ○ ▢' },
              ],
              s.get('navigation'),
              (v) => { s.set('navigation', v); refresh(); },
            ),
          ),
        ],
      }),
      listGroup({
        items: [
          toggleRow('Format 24 heures', 'use24h', { icon: 'clock', color: '#8e8e93' }),
          toggleRow('Pourcentage de batterie', 'showBatteryPercent', { icon: 'battery', color: '#30d158' }),
        ],
      }),
      listGroup({
        items: [
          row({ title: "Réinitialiser l'écran d'accueil", destructive: true, onClick: async () => {
            if (await ctx.ui.confirm({ title: "Réinitialiser l'écran d'accueil ?", message: 'La disposition par défaut sera rétablie au prochain démarrage.', confirmLabel: 'Réinitialiser', destructive: true })) {
              s.reset('homeLayout');
              ctx.ui.toast('Disposition réinitialisée (redémarrage requis)');
            }
          } }),
        ],
      }),
    ]);
  }

  // ───────────── Confidentialité, code ─────────────

  function privacyPage() {
    open('Confidentialité', () => [
      listGroup({ items: [row({ icon: 'location', iconColor: '#0a84ff', title: 'Service de localisation', detail: s.get('location') ? 'Activé' : 'Désactivé', chevron: true, onClick: locationPage })] }),
      listGroup({
        header: 'Autorisations',
        items: Object.entries(PERMISSIONS).map(([perm, info]) => {
          const apps = visibleApps().filter((p) => p.permissions.includes(perm));
          return row({ icon: info.icon, iconColor: '#0a84ff', title: info.label, detail: String(apps.length), chevron: true, onClick: () => permissionPage(perm, info) });
        }),
        footer: 'Les applications doivent déclarer une autorisation puis la demander. Vous pouvez la révoquer à tout moment.',
      }),
    ]);
  }

  function permissionPage(perm, info) {
    open(info.label, (refresh) => {
      const apps = visibleApps().filter((p) => p.permissions.includes(perm));
      if (!apps.length) return h('p.muted.center', 'Aucune application ne demande cette autorisation.');
      return listGroup({
        items: apps.map((pkg) => permissionRow(pkg, perm, refresh)),
      });
    }, { back: 'Confidentialité' });
  }

  function permissionRow(pkg, perm, refresh) {
    const state = k.permissions.check(pkg.id, perm);
    return h(
      'div.list-item.perm-row',
      appIcon(pkg, { size: 30 }),
      h('div.li-body', h('div.li-title', pkg.name)),
      segmented(
        [
          { value: 'granted', label: 'Oui' },
          { value: 'prompt', label: 'Demander' },
          { value: 'denied', label: 'Non' },
        ],
        state,
        (v) => { k.permissions.set(pkg.id, perm, v); refresh?.(); },
      ),
    );
  }

  async function askNewCode() {
    const first = await ctx.ui.prompt({ title: 'Nouveau code', message: 'Saisissez un code de 4 à 6 chiffres.', type: 'password', placeholder: '••••' });
    if (first == null) return null;
    if (!/^\d{4,6}$/.test(first)) {
      await ctx.ui.alert({ title: 'Code invalide', message: 'Le code doit contenir 4 à 6 chiffres.' });
      return null;
    }
    const second = await ctx.ui.prompt({ title: 'Confirmez le code', type: 'password', placeholder: '••••' });
    if (second !== first) {
      await ctx.ui.alert({ title: 'Les codes ne correspondent pas' });
      return null;
    }
    return first;
  }

  /** Code actuel (échecs comptés par la Protection de l'appareil). */
  async function checkCurrentCode() {
    return (await ui.protection.askCode({ title: 'Code actuel' })) != null;
  }

  // ───────────── Mise à jour logicielle ─────────────

  function updatesPage() {
    const up = ui.updates;
    const p = open('Mise à jour logicielle', () => {
      const a = up.available;
      const busy = ['checking', 'downloading', 'installing'].includes(up.status);
      const notes = (list) => h('ul.update-notes', list.map((note) => h('li', note)));
      let card;
      if (a && ['available', 'downloading', 'ready', 'installing', 'error'].includes(up.status)) {
        const progress = up.progress?.total ? up.progress.done / up.progress.total : 0;
        card = h(
          'div.update-card',
          h('div.update-head', h('div.update-logo', logo(44)), h('div', h('strong', `Orion OS ${a.label ?? a.version}`), h('span', [a.date && new Date(a.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }), up.status === 'available' && a.download != null ? `${formatBytes(a.download)} à télécharger` : a.size ? formatBytes(a.size) : null].filter(Boolean).join(' · ')))),
          a.notes?.length ? notes(a.notes) : null,
          up.status === 'downloading'
            ? h('div.update-progress', h('div.update-bar', h('span', { style: { width: `${Math.round(progress * 100)}%` } })), h('small', up.progress?.total ? `Téléchargement… ${Math.round(progress * 100)} % (${up.progress.done} fichiers sur ${up.progress.total}, ${formatBytes(up.progress.downloaded ?? 0)} reçus)` : 'Préparation du téléchargement…'))
            : null,
          up.status === 'installing' ? h('div.update-progress', spinner(18), h('small', 'Installation…')) : null,
          up.status === 'error' ? h('p.update-error', up.error) : null,
          up.status === 'available' || up.status === 'error' ? button('Télécharger', { block: true, onClick: () => up.download() }) : null,
          up.status === 'ready'
            ? [button('Installer maintenant', { block: true, onClick: () => up.install() }), h('p.update-hint', 'Orion redémarre sur la nouvelle version ; vos données et réglages sont conservés.')]
            : null,
        );
      } else {
        card = h(
          'div.update-card.center',
          h('div.update-logo', logo(56)),
          h('strong', `Orion OS ${k.os.label}`),
          up.status === 'checking'
            ? h('p', spinner(16), ' Recherche de mises à jour…')
            : up.status === 'error'
              ? h('p.update-error', up.error)
              : h('p', up.lastCheck ? 'Votre logiciel est à jour.' : 'Aucune vérification pour le moment.'),
          button('Rechercher des mises à jour', { variant: 'tinted', block: true, disabled: busy, onClick: () => up.check() }),
        );
      }
      return [
        card,
        up.lastCheck ? h('p.update-checked', `Dernière vérification : ${relativeTime(up.lastCheck, Date.now())}`) : null,
        listGroup({
          items: [
            toggleRow('Téléchargement automatique', 'updates.autoDownload', { subtitle: 'Télécharger les nouvelles versions dès leur publication' }),
            toggleRow('Installation automatique', 'updates.autoInstall', { subtitle: 'Installer une version téléchargée quand l\'appareil se verrouille' }),
          ],
        }),
        listGroup({
          header: `Nouveautés d'Orion OS ${k.os.label}`,
          items: [h('div.list-item.update-current', notes(up.installed.notes))],
          footer: `Build ${up.installed.build}${up.installed.date ? ` du ${new Date(up.installed.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}.`,
        }),
      ];
    }, { back: 'Général' });
    p.updates = true;
    // Pas de vérification récente : on en lance une en ouvrant la page.
    if (Date.now() - up.lastCheck > 60_000 && !['downloading', 'ready', 'installing'].includes(up.status)) up.check();
  }

  // ───────────── Appareil photo ─────────────

  function cameraPage() {
    const choice = (key, options) => {
      const control = segmented(options, s.get(key), (v) => s.set(key, v));
      // Réglage modifié ailleurs (bouton retardateur de l'appareil photo) : le contrôle suit.
      keep(s.watch(key, (v) => control.set(v)));
      return h('div.list-item', control);
    };
    open('Appareil photo', () => [
      listGroup({
        header: 'Format par défaut',
        items: [choice('camera.format', [{ value: 'wide', label: '9:16' }, { value: 'photo', label: 'Photo 3:4' }, { value: 'square', label: 'Carré 1:1' }])],
      }),
      listGroup({
        header: 'Qualité des photos',
        items: [choice('camera.quality', [{ value: 'high', label: 'Haute' }, { value: 'standard', label: 'Standard' }, { value: 'compact', label: 'Économie' }])],
        footer: 'Haute : jusqu\'à 2560 pixels, fichiers plus lourds. Standard : 1440 pixels. Économie : 1080 pixels, idéal pour partager et gagner de la place.',
      }),
      listGroup({
        header: 'Retardateur',
        items: [choice('camera.timer', [{ value: 0, label: 'Désactivé' }, { value: 3, label: '3 s' }, { value: 10, label: '10 s' }])],
        footer: 'Également réglable depuis le bouton en haut de l\'appareil photo.',
      }),
      listGroup({
        items: [
          toggleRow('Grille', 'camera.grid', { icon: 'grid', color: '#8e8e93', subtitle: 'Règle des tiers pour cadrer' }),
          toggleRow('Selfies en miroir', 'camera.mirror', { icon: 'user', color: '#0a84ff', subtitle: 'Enregistrer les photos de la caméra avant comme dans le viseur' }),
          toggleRow('Son de l\'obturateur', 'camera.shutterSound', { icon: 'volume', color: '#ff2d55' }),
          toggleRow('Conserver les réglages', 'camera.preserve', { icon: 'history', color: '#ff9500', subtitle: 'Garder le format, le filtre et la caméra de la dernière utilisation' }),
        ],
      }),
      listGroup({
        items: [
          row({ icon: 'hand', iconColor: '#0a84ff', title: 'Autorisations de l\'appareil photo', chevron: true, onClick: () => appPage('camera') }),
          row({ icon: 'camera', iconColor: '#8e8e93', title: 'Ouvrir l\'appareil photo', onClick: () => ctx.startActivity({ app: 'camera', action: 'main' }) }),
        ],
      }),
    ]);
  }

  // ───────────── Mode développeur (mot de passe de l'appareil) ─────────────

  const dev = ui.developer;
  /** État affiché par la page Mode développeur (pour ne la redessiner que s'il change). */
  const devState = () => `${dev.configured}|${dev.unlocked}|${dev.canManage}`;
  let devShown = null;

  /** Champ de mot de passe avec bouton pour l'afficher. */
  function passwordField(label, { autofocus = false, onEnter = null } = {}) {
    const input = h('input.dev-input', { type: 'password', placeholder: label, 'aria-label': label, autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    const eye = h('button.dev-eye', { type: 'button', 'aria-label': 'Afficher le mot de passe' }, icon('eye', { size: 18 }));
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.replaceChildren(icon(show ? 'eye-off' : 'eye', { size: 18 }));
    });
    if (onEnter) input.addEventListener('keydown', (e) => e.key === 'Enter' && onEnter());
    if (autofocus) setTimeout(() => input.focus(), 350);
    return { el: h('div.dev-field', input, eye), input };
  }

  const devHero = (title, text, iconName = 'code') => h('div.settings-hero', h('div.hero-icon.dev-hero', icon(iconName, { size: 34 })), h('h2', title), h('p', text));

  /** Formulaire « nouveau mot de passe » (création, changement, oubli). */
  function newPasswordForm({ title, text, action, onDone }) {
    const error = h('p.dev-error');
    const submit = async () => {
      const problem = passwordProblem(first.input.value, second.input.value);
      if (problem) {
        error.textContent = problem;
        return;
      }
      try {
        await action(first.input.value);
        onDone();
      } catch (e) {
        error.textContent = e.message;
      }
    };
    const first = passwordField('Nouveau mot de passe', { autofocus: true });
    const second = passwordField('Confirmer le mot de passe', { onEnter: submit });
    return [
      devHero(title, text, 'lock-fill'),
      h('div.dev-form', first.el, second.el, h('p.dev-hint', `Au moins ${MIN_PASSWORD_LENGTH} caractères, avec des lettres et des chiffres.`), error, button('Valider', { block: true, onClick: submit })),
    ];
  }

  /** Mot de passe oublié : le propriétaire en choisit un nouveau après son code de verrouillage. */
  async function forgotDeveloperPassword(refresh) {
    if (!dev.canManage) return ctx.ui.alert({ title: 'Mot de passe oublié', message: `Demandez-le à ${dev.ownerName}, propriétaire de l'appareil.` });
    // Sans code de verrouillage, n'importe qui peut ouvrir la session du propriétaire : seul l'effacement reste possible.
    if (!s.get('passcode')) {
      return ctx.ui.alert({
        title: 'Mot de passe oublié',
        message: 'Sans code de verrouillage, l\'appareil ne peut pas vérifier que vous êtes le propriétaire. Pour retrouver l\'accès au mode développeur, effacez l\'appareil (Réglages › Général › Effacer contenu et réglages). Définissez un code de verrouillage pour pouvoir remplacer ce mot de passe à l\'avenir.',
      });
    }
    if (!(await checkCurrentCode())) return;
    const p = open('Nouveau mot de passe', (done) => newPasswordForm({ title: 'Nouveau mot de passe développeur', text: 'Il remplace l\'ancien pour tous les comptes de l\'appareil.', action: (pw) => dev.replace(pw), onDone: () => { ctx.ui.toast('Mot de passe modifié'); nav.pop(); refresh(); } }), { back: 'Mode développeur' });
    p.developer = true;
  }

  function unlockForm(refresh) {
    const error = h('p.dev-error');
    const submitBtn = button('Déverrouiller', { block: true, onClick: () => submit() });
    const field = passwordField('Mot de passe développeur', { autofocus: true, onEnter: () => submit() });
    const showWait = () => {
      const wait = dev.wait;
      submitBtn.disabled = Boolean(wait);
      if (!wait) return;
      error.textContent = `Trop de tentatives. Réessayez dans ${wait} s.`;
      setTimeout(() => (error.isConnected ? showWait() : null), 1000);
    };
    async function submit() {
      if (!field.input.value || dev.wait) return;
      const result = await dev.unlock(field.input.value);
      if (result.ok || result.missing) {
        if (result.ok) ctx.ui.toast('Mode développeur déverrouillé');
        refresh();
        return;
      }
      field.input.value = '';
      ctx.ui.vibrate([60, 40, 60]);
      error.textContent = result.left ? `Mot de passe incorrect. Encore ${result.left} essai${result.left > 1 ? 's' : ''} avant un temps d'attente.` : 'Mot de passe incorrect.';
      showWait();
    }
    showWait();
    return [
      devHero('Mode développeur verrouillé', 'Saisissez le mot de passe développeur de l\'appareil pour ouvrir les options et le Terminal. Il est redemandé après chaque verrouillage.', 'lock-fill'),
      h('div.dev-form', field.el, error, submitBtn, h('button.dev-link', { type: 'button', onclick: () => forgotDeveloperPassword(refresh) }, 'Mot de passe oublié ?')),
    ];
  }

  // ───────────── Protection de l'appareil ─────────────

  /** Code de verrouillage (vérifié) puis délai de sécurité d'un réglage sensible. Renvoie le code, '' sans code, ou null. */
  async function sensitiveCode(title, action) {
    const code = await ui.protection.askCode({ title });
    if (code == null) return null;
    return (await ui.protection.allowSensitive(action)) ? code : null;
  }

  const LEVEL = { ok: ['check-circle', '#30d158'], warning: ['info', '#ff9f0a'], danger: ['shield', '#ff3b30'] };

  function protectionSummary() {
    const issues = ui.protection.checkup().filter((i) => i.level !== 'ok').length;
    return issues ? `${issues} action${issues > 1 ? 's' : ''}` : 'Protégé';
  }

  function protectionPage() {
    const prot = ui.protection;
    const svc = k.protection;
    let progress = null;
    let lastPaint = 0;
    const ACTIONS = {
      passcode: passcodePage,
      autolock: displayPage,
      updates: updatesPage,
      developer: () => {
        ui.developer.lock();
        ctx.ui.toast('Mode développeur verrouillé');
      },
    };
    const p = open('Protection de l\'appareil', (refresh) => {
      const items = prot.checkup();
      const issues = items.filter((i) => i.level !== 'ok');
      const level = issues.some((i) => i.level === 'danger') ? 'danger' : issues.length ? 'warning' : 'ok';
      const last = svc.lastScan;
      const owner = Boolean(me().owner);
      const opts = svc.options;
      const frp = svc.frp;
      const integrity = last?.integrity;
      const changed = integrity?.status === 'altered' ? [...(integrity.altered ?? []).map((f) => [f, 'modifié']), ...(integrity.missing ?? []).map((f) => [f, 'absent'])] : [];
      const threats = last?.apps?.threats ?? [];
      const scan = async () => {
        progress = 0;
        refresh();
        await prot.scan({
          onProgress: (x) => {
            progress = x;
            if (Date.now() - lastPaint > 200) {
              lastPaint = Date.now();
              refresh();
            }
          },
        });
        progress = null;
        refresh();
      };
      const optionRow = (key, title, subtitle, { onEnable = null, onDisable = null, disabled = false } = {}) =>
        row({
          title,
          subtitle,
          trailing: toggle(opts[key], async (on) => {
            const ok = on ? (onEnable ? await onEnable() : true) : onDisable ? await onDisable() : true;
            if (ok) {
              try {
                svc.setOption(key, on);
              } catch (error) {
                ctx.ui.alert({ title: 'Réglage impossible', message: error.message });
              }
            }
            refresh();
          }, { label: title, disabled: disabled || !owner }),
        });
      const offWithCode = () => sensitiveCode('Désactiver une protection', 'protection').then((code) => code != null);
      return [
        h(
          'div.settings-hero.protect-hero',
          h(`div.hero-icon.protect-${level}`, icon('shield', { size: 34 })),
          h('h2', level === 'ok' ? 'Votre appareil est protégé' : level === 'danger' ? 'Votre appareil est exposé' : 'Des actions sont recommandées'),
          h('p', progress != null ? `Analyse en cours… ${Math.round(progress * 100)} %` : last ? `Dernière analyse : ${relativeTime(last.at, Date.now()).replace(/^./, (c) => c.toLowerCase())}` : 'Aucune analyse pour le moment'),
        ),
        button(progress != null ? 'Analyse en cours…' : 'Analyser maintenant', { block: true, disabled: progress != null, icon: 'refresh', onClick: scan }),
        listGroup({
          header: 'Bilan de sécurité',
          items: items.map((item) => {
            const action = item.id === 'integrity' && !integrity ? scan : ACTIONS[item.id];
            return row({ icon: LEVEL[item.level][0], iconColor: LEVEL[item.level][1], title: item.title, subtitle: item.detail, chevron: Boolean(action) && item.level !== 'ok', onClick: action && item.level !== 'ok' ? action : null });
          }),
        }),
        changed.length
          ? listGroup({
              header: 'Fichiers système modifiés',
              items: [
                ...changed.slice(0, 8).map(([file, state]) => row({ title: file.replace(/^\.\//, ''), detail: state })),
                row({ icon: 'download', iconColor: '#0a84ff', title: 'Réparer', subtitle: 'Retélécharger et vérifier ces fichiers', onClick: async () => {
                  const result = await repairIntegrity();
                  if (!result?.ok) return ctx.ui.alert({ title: 'Réparation impossible', message: result?.error ?? 'Erreur inconnue' });
                  ctx.ui.toast(`${result.repaired} fichier(s) réparé(s)`);
                  await scan();
                } }),
              ],
              footer: integrity.source === 'orion-server' ? 'Fichiers servis par orion-server : lancez « systemctl start orion-update » pour réinstaller la version.' : 'Ces fichiers ne correspondent pas à la version publiée d\'Orion (extension du navigateur, stockage endommagé ou logiciel malveillant).',
            })
          : null,
        threats.length
          ? listGroup({
              header: 'Apps à surveiller',
              items: threats.map((t) => row({ icon: 'info', iconColor: t.level === 'danger' ? '#ff3b30' : '#ff9f0a', title: t.name, subtitle: t.findings.map((f) => f.message).join(' · '), chevron: true, onClick: () => appPage(t.id) })),
            })
          : null,
        svc.pendingDelays().length
          ? listGroup({
              header: 'Délai de sécurité en cours',
              items: svc.pendingDelays().map(({ action, readyAt }) => row({ icon: 'clock', iconColor: '#5e5ce6', title: { passcode: 'Code de verrouillage', erase: 'Effacement', frp: 'Protection contre la réinitialisation', protection: 'Désactiver une protection' }[action] ?? action, detail: readyAt > Date.now() ? `à ${new Date(readyAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'Possible maintenant' })),
            })
          : null,
        listGroup({
          header: 'Protections',
          items: [
            row({
              title: 'Protection contre la réinitialisation',
              subtitle: frp.enabled ? `Après un effacement, le code de ${frp.owner?.name || 'son propriétaire'} est demandé${frp.remote ? ' · gardée par orion-server' : ''}` : 'Après un effacement, le code du propriétaire est demandé',
              trailing: toggle(frp.enabled, async (on) => {
                try {
                  if (on) {
                    if (!s.get('passcode')) {
                      await ctx.ui.alert({ title: 'Code nécessaire', message: 'Définissez d\'abord un code de verrouillage : c\'est lui qui sera demandé après une réinitialisation.' });
                    } else if ((await ui.protection.askCode({ title: 'Activer la protection' })) != null) {
                      await svc.enableFrp({ record: s.get('passcode'), owner: { name: me().name, email: me().email } });
                      ctx.ui.toast('Protection contre la réinitialisation activée');
                    }
                  } else {
                    const code = await sensitiveCode('Désactiver la protection', 'frp');
                    if (code != null) {
                      const result = await svc.disableFrp(code);
                      if (!result.ok) await ctx.ui.alert({ title: 'Toujours activée', message: result.wait ? `Réessayez dans ${result.wait} s.` : 'Code incorrect.' });
                    }
                  }
                } catch (error) {
                  await ctx.ui.alert({ title: 'Réglage impossible', message: error.message });
                }
                refresh();
              }, { label: 'Protection contre la réinitialisation', disabled: !owner }),
            }),
            optionRow('wipe', 'Effacer après 10 tentatives', 'Après 10 codes faux, l\'appareil est effacé (un autre compte : ses données seulement)', {
              onEnable: () => ctx.ui.confirm({ title: 'Effacer après 10 tentatives ?', message: 'Si quelqu\'un se trompe 10 fois de code, toutes les données seront effacées. Les attentes entre les essais restent actives.', confirmLabel: 'Activer' }),
              onDisable: offWithCode,
            }),
            optionRow('sensitive', 'Protection des données sensibles', 'Code et délai d\'une heure pour changer le code, effacer ou désactiver une protection', { onDisable: offWithCode }),
            optionRow('theftLock', 'Verrouillage en cas de vol', prot.motionSupported ? 'Verrouille aussitôt si l\'appareil est arraché de la main' : 'Nécessite un capteur de mouvement (téléphone ou tablette)', {
              onEnable: async () => {
                if (await prot.requestMotionPermission()) return true;
                await ctx.ui.alert({ title: 'Capteur indisponible', message: 'Le navigateur ne donne pas accès aux capteurs de mouvement.' });
                return false;
              },
              disabled: !prot.motionSupported,
            }),
            optionRow('offlineLock', 'Verrouillage hors ligne', 'Verrouille si la connexion est perdue plus de 10 secondes'),
          ],
          footer: owner
            ? 'Ces protections valent pour tout l\'appareil. Dans un navigateur, effacer les données du site les efface aussi ; sur Orion installé, la protection contre la réinitialisation est également gardée par orion-server. Les apps du Store sont analysées avant chaque installation.'
            : `Ces protections valent pour tout l'appareil et sont réglées par ${accounts?.owner?.name || 'le propriétaire'}.`,
        }),
      ];
    });
    p.protection = true;
  }

  function passcodePage() {
    open('Code de verrouillage', (refresh) => {
      const enabled = Boolean(s.get('passcode'));
      return [
        h('div.settings-hero', h('div.hero-icon', icon('lock-fill', { size: 34 })), h('p', enabled ? 'Votre appareil est protégé par un code.' : "Protégez l'accès à votre appareil avec un code.")),
        listGroup({
          items: enabled
            ? [
                row({ title: 'Modifier le code', onClick: async () => {
                  const old = await sensitiveCode('Modifier le code', 'passcode');
                  if (old == null) return;
                  const code = await askNewCode();
                  if (!code) return;
                  const record = await createPasscode(code);
                  // La protection contre la réinitialisation suit le nouveau code.
                  if (me().owner) {
                    try {
                      await k.protection.updateFrpRecord(record, old);
                    } catch (error) {
                      await ctx.ui.alert({ title: 'Code non modifié', message: `La protection contre la réinitialisation n'a pas pu être mise à jour : ${error.message}` });
                      return;
                    }
                  }
                  s.set('passcode', record);
                  ctx.ui.toast('Code modifié');
                  refresh();
                } }),
                row({ title: 'Désactiver le code', destructive: true, onClick: async () => {
                  const frp = me().owner && k.protection.frp.enabled;
                  if (frp && !(await ctx.ui.confirm({ title: 'Désactiver le code ?', message: 'La protection contre la réinitialisation sera aussi désactivée : elle repose sur votre code.', confirmLabel: 'Désactiver', destructive: true }))) return;
                  const old = await sensitiveCode('Désactiver le code', 'passcode');
                  if (old == null) return;
                  if (frp && !(await k.protection.disableFrp(old).catch((e) => ({ ok: false, error: e.message }))).ok) {
                    await ctx.ui.alert({ title: 'Code toujours actif', message: 'La protection contre la réinitialisation n\'a pas pu être désactivée.' });
                    return;
                  }
                  s.set('passcode', null);
                  ctx.ui.toast('Code désactivé');
                  refresh();
                } }),
              ]
            : [row({ title: 'Activer le code', onClick: async () => { const code = await askNewCode(); if (code) { s.set('passcode', await createPasscode(code)); ctx.ui.toast('Code activé'); refresh(); } } })],
        }),
        listGroup({ items: [row({ title: 'Verrouiller maintenant', onClick: () => ui.lockNow() })] }),
      ];
    });
  }

  // ───────────── Batterie, stockage ─────────────

  function batteryPage() {
    const p = open('Batterie', () => {
      const b = k.device.battery;
      const pct = Math.round(b.level * 100);
      const apps = visibleApps().slice(0, 8);
      const weights = apps.map((pkg, i) => ((pkg.id.charCodeAt(0) * 13 + i * 7) % 30) + 4);
      const total = weights.reduce((a, b2) => a + b2, 0);
      return [
        h(
          'div.battery-hero',
          h('div.battery-big', h('div.battery-big-fill', { style: { width: `${pct}%`, background: pct <= 20 ? 'var(--red)' : s.get('batterySaver') ? 'var(--yellow)' : 'var(--green)' } })),
          h('div.battery-pct', `${pct} %`),
          h('div.muted', b.charging ? 'En charge ⚡' : `Autonomie estimée : ${Math.round(pct / (s.get('batterySaver') ? 4 : 6))} h`),
          b.simulated ? h('div.muted.small', 'Batterie simulée (aucune batterie détectée)') : null,
        ),
        listGroup({ items: [toggleRow('Économiseur de batterie', 'batterySaver', { icon: 'leaf', color: '#ffcc00', subtitle: 'Réduit les animations et l\'activité en arrière-plan' }), toggleRow('Afficher le pourcentage', 'showBatteryPercent')] }),
        listGroup({
          header: 'Utilisation par application',
          items: apps.map((pkg, i) => row({ leading: appIcon(pkg, { size: 30 }), title: pkg.name, detail: `${Math.round((weights[i] / total) * 100)} %` })),
        }),
      ];
    });
    live(p, ['battery:change']);
  }

  function storagePage() {
    open('Stockage', (refresh) => {
      const total = k.fs.du('/');
      const parts = [
        { label: 'Photos', path: '/home/Photos', color: '#f2437b' },
        { label: 'Documents', path: '/home/Documents', color: '#5b8def' },
        { label: 'Musique', path: '/home/Music', color: '#ff4d6d' },
        { label: 'Enregistrements', path: '/home/Recordings', color: '#ff9500' },
        { label: 'Données des apps', path: '/data', color: '#5856d6' },
        { label: 'Système', path: '/system', color: '#8e8e93' },
      ].map((p) => ({ ...p, size: k.fs.exists(p.path) ? k.fs.du(p.path) : 0 }));
      return [
        h(
          'div.storage-hero',
          h('div.storage-total', formatBytes(total), h('span', ' utilisés')),
          h('div.storage-bar', parts.map((p) => h('span', { style: { flex: String(Math.max(p.size, total * 0.01)), background: p.color } }))),
          h('div.muted.small', `Pilote de stockage : ${k.backend}`),
        ),
        listGroup({ items: parts.map((p) => row({ leading: h('span.storage-dot', { style: { background: p.color } }), title: p.label, detail: formatBytes(p.size) })) }),
        listGroup({
          items: [
            row({ title: 'Vider les fichiers temporaires', detail: formatBytes(k.fs.du('/tmp')), onClick: () => { for (const e of k.fs.readdir('/tmp')) k.fs.rm(e.path, { recursive: true }); ctx.ui.toast('Fichiers temporaires supprimés'); refresh(); } }),
          ],
        }),
      ];
    });
  }

  // ───────────── Applications ─────────────

  function appsPage() {
    open('Applications', () => [
      listGroup({
        header: `${visibleApps().length} applications installées`,
        items: visibleApps().map((pkg) => row({ leading: appIcon(pkg, { size: 30 }), title: pkg.name, subtitle: pkg.system ? 'Application système' : `Version ${pkg.version}`, detail: formatBytes(pkg.size * 1_048_576 + (k.fs.exists(`/data/${pkg.id}`) ? k.fs.du(`/data/${pkg.id}`) : 0)), chevron: true, onClick: () => appPage(pkg.id) })),
      }),
      listGroup({ items: [row({ icon: 'bag', iconColor: '#1d5cf0', title: 'Obtenir plus d\'applications', chevron: true, onClick: () => ctx.startActivity({ app: 'store', action: 'main' }) })] }),
    ]);
  }

  function appPage(id) {
    const p = open('', (refresh) => {
      const pkg = k.packages.get(id);
      if (!pkg || !k.packages.isInstalled(id)) return h('p.muted', 'Application désinstallée.');
      const proc = k.processes.getByApp(id);
      const dataSize = k.fs.exists(`/data/${id}`) ? k.fs.du(`/data/${id}`) : 0;
      const notifKey = `notifications.${id}`;
      const perms = k.permissions.listFor(id);
      return [
        h('div.app-hero', appIcon(pkg, { size: 76 }), h('h2', pkg.name), h('p', `${pkg.category} · version ${pkg.version}`)),
        h(
          'div.app-actions',
          button('Ouvrir', { variant: 'tinted', icon: 'arrow-right', onClick: () => ctx.startActivity({ app: id, action: 'main' }).catch((error) => ctx.ui.toast(error.message)) }),
          button("Forcer l'arrêt", { variant: 'gray', icon: 'stop', disabled: !proc, onClick: () => { k.processes.killApp(id, 'force-stop'); ctx.ui.toast(`${pkg.name} arrêtée`); refresh(); } }),
        ),
        listGroup({
          items: [
            row({ title: 'Taille de l\'app', detail: formatBytes(pkg.size * 1_048_576) }),
            row({ title: 'Données', detail: formatBytes(dataSize) }),
            row({ title: 'État', detail: proc ? (proc.state === 'foreground' ? 'Au premier plan' : 'En arrière-plan') : 'Arrêtée' }),
            row({ title: 'Effacer les données', destructive: true, onClick: async () => {
              if (!(await ctx.ui.confirm({ title: `Effacer les données de ${pkg.name} ?`, message: 'Les préférences et données privées de l\'app seront supprimées.', confirmLabel: 'Effacer', destructive: true }))) return;
              k.processes.killApp(id, 'clear-data');
              k.fs.rm(`/data/${id}`, { recursive: true, force: true });
              ctx.ui.toast('Données effacées');
              refresh();
            } }),
          ],
        }),
        listGroup({
          header: 'Notifications',
          items: [listItem({ title: 'Autoriser les notifications', trailing: toggle(s.get(notifKey) !== false, (v) => s.set(notifKey, v)) })],
        }),
        perms.length ? listGroup({ header: 'Autorisations', items: perms.map((perm) => permissionRow(pkg, perm.perm, refresh)) }) : null,
        pkg.intents.length
          ? listGroup({ header: 'Ouvre par défaut', items: pkg.intents.map((f) => row({ title: f.action, detail: f.types?.join(', ') ?? '—' })) })
          : null,
        pkg.system
          ? h('p.muted.small.center', 'Application système : elle ne peut pas être désinstallée.')
          : listGroup({ items: [row({ title: 'Désinstaller', destructive: true, onClick: async () => {
              if (await ctx.ui.confirm({ title: `Désinstaller ${pkg.name} ?`, confirmLabel: 'Désinstaller', destructive: true })) {
                await k.packages.uninstall(id);
                nav.pop();
              }
            } })] }),
      ];
    }, { back: 'Applications', large: false });
    p.bar.setTitle(k.packages.get(id)?.name ?? '');
  }

  // ───────────── Général, à propos, développeur ─────────────

  function generalPage() {
    open('Général', () => [
      listGroup({
        items: [
          row({ title: 'Informations', chevron: true, onClick: aboutPage }),
          row({ title: 'Mise à jour logicielle', detail: ['available', 'ready'].includes(ui.updates?.status) ? h('span.update-badge', '1') : null, chevron: true, onClick: updatesPage }),
          row({ title: 'Langue et région', detail: 'Français (France)' }),
          toggleRow('Format 24 heures', 'use24h'),
        ],
      }),
      listGroup({
        items: [
          row({ title: 'Redémarrer', onClick: async () => { if (await ctx.ui.confirm({ title: "Redémarrer l'appareil ?", confirmLabel: 'Redémarrer' })) k.device.requestPower('reboot'); } }),
          row({ title: 'Éteindre', onClick: () => ui.power.showMenu() }),
        ],
      }),
      listGroup({
        items: [
          row({ title: 'Réinitialiser tous les réglages', destructive: true, onClick: async () => {
            if (!(await ctx.ui.confirm({ title: 'Réinitialiser les réglages ?', message: 'Vos données sont conservées, seuls les réglages sont rétablis.', confirmLabel: 'Réinitialiser', destructive: true }))) return;
            for (const key of Object.keys(s.all())) if (!['setupDone', 'userName', 'passcode', 'demoDataRemoved', 'developerState', 'telephony.seenSms'].includes(key)) s.reset(key);
            ctx.ui.toast('Réglages réinitialisés');
          } }),
          me().owner
            ? row({ title: 'Effacer contenu et réglages', destructive: true, onClick: async () => {
                const others = (accounts?.list().length ?? 1) > 1;
                const frp = k.protection.frp.enabled;
                if (!(await ctx.ui.confirm({ title: 'Tout effacer ?', message: `Toutes les données (photos, notes, messages, réglages${others ? ' et tous les comptes' : ''}) seront supprimées et l'appareil redémarrera.${frp ? ' Effacé par vous, l\'appareil ne demandera pas votre code ensuite : la protection contre la réinitialisation est levée.' : ''}`, confirmLabel: 'Tout effacer', destructive: true }))) return;
                const code = await sensitiveCode('Effacer contenu et réglages', 'erase');
                if (code == null) return;
                if (frp && code && !(await k.protection.disableFrp(code).catch(() => ({ ok: false }))).ok) {
                  await ctx.ui.alert({ title: 'Effacement annulé', message: 'La protection contre la réinitialisation n\'a pas pu être levée.' });
                  return;
                }
                k.protection.resetAfterWipe();
                await ui.eraseDevice();
              } })
            : row({ title: 'Effacer le contenu de mon compte', destructive: true, onClick: async () => {
                if (!(await ctx.ui.confirm({ title: 'Effacer votre contenu ?', message: 'Vos apps, fichiers, messages et réglages seront supprimés ; votre compte sera reconfiguré au redémarrage.', confirmLabel: 'Effacer', destructive: true }))) return;
                if ((await sensitiveCode('Effacer mon contenu', 'erase')) == null) return;
                k.protection.resetAfterWipe(me().id);
                await ui.eraseDevice();
              } }),
        ],
      }),
    ]);
  }

  function aboutPage() {
    let taps = 0;
    const p = open('Informations', () => {
      const info = k.device.info();
      return [
        h('div.settings-hero', h('div.hero-logo', logo(72)), h('h2', `${k.os.name} ${k.os.label}`), h('p', `« ${k.os.codename} »`)),
        listGroup({
          items: [
            row({ title: 'Nom', detail: s.get('deviceName') }),
            row({ title: 'Version', detail: k.os.label }),
            row({
              title: 'Numéro de build',
              detail: k.os.build,
              // Geste Android : 7 touchers ouvrent le mode développeur.
              onClick: () => {
                taps++;
                if (taps >= 7) {
                  taps = 0;
                  developerPage();
                } else if (taps >= 3) ctx.ui.toast(`Plus que ${7 - taps} étape(s) pour le mode développeur`);
              },
            }),
            row({ title: 'Noyau', detail: k.os.kernel }),
            row({ title: 'Modèle', detail: info.model }),
          ],
        }),
        listGroup({
          header: 'Matériel hôte',
          items: [
            row({ title: 'Plateforme', detail: info.platform }),
            row({ title: 'Processeur', detail: info.cores ? `${info.cores} cœurs` : '—' }),
            row({ title: 'Mémoire', detail: info.memory ? `${info.memory} Go` : '—' }),
            row({ title: 'Écran', detail: info.screen }),
            row({ title: 'Stockage', detail: `${formatBytes(k.fs.du('/'))} (${k.backend})` }),
            row({ title: 'Allumé depuis', detail: formatDuration(k.device.uptime()) }),
          ],
        }),
        h('p.muted.small.center.selectable', info.userAgent),
      ];
    }, { back: 'Général' });
    return p;
  }

  /** Mode développeur : création du mot de passe, déverrouillage, puis options. */
  function developerPage() {
    const p = open('Mode développeur', (refresh) => {
      devShown = devState();
      if (dev.unlocked) return developerOptions(refresh);
      if (dev.configured) return unlockForm(refresh);
      if (!dev.canManage) return [devHero('Mode développeur non configuré', `Demandez à ${dev.ownerName}, propriétaire de l'appareil, de définir le mot de passe développeur.`)];
      return newPasswordForm({
        title: 'Créer le mot de passe développeur',
        text: s.get('passcode')
          ? 'Il protège les options pour les développeurs et le Terminal, pour tous les comptes de l\'appareil. Vous seul pourrez le modifier.'
          : 'Il protège les options pour les développeurs et le Terminal, pour tous les comptes de l\'appareil. Conseil : définissez aussi un code de verrouillage, sinon un mot de passe oublié ne pourra pas être remplacé.',
        action: (pw) => dev.create(pw),
        onDone: () => {
          ctx.ui.toast('Mode développeur déverrouillé');
          refresh();
        },
      });
    });
    p.devRoot = true;
  }

  function developerOptions(refresh) {
    const openTerminal = () => ctx.startActivity({ app: 'terminal', action: 'main' }).catch((error) => ctx.ui.toast(error.message));
    return [
      listGroup({
        items: [
          row({ leading: appIcon(k.packages.get('terminal'), { size: 30 }), title: 'Terminal', subtitle: 'Shell osh : accès complet au système', chevron: true, onClick: openTerminal }),
          row({ icon: 'lock', iconColor: '#636366', title: 'Verrouiller le mode développeur', onClick: () => dev.lock() }),
        ],
        footer: 'Le mode développeur se verrouille aussi avec l\'appareil ; le Terminal est alors fermé.',
      }),
      dev.canManage
        ? listGroup({
            header: 'Mot de passe de l\'appareil',
            items: [
              row({
                title: 'Changer le mot de passe',
                chevron: true,
                onClick: () => {
                  const p = open('Changer le mot de passe', () => newPasswordForm({ title: 'Nouveau mot de passe développeur', text: 'Il remplace l\'ancien pour tous les comptes de l\'appareil.', action: (pw) => dev.replace(pw), onDone: () => { ctx.ui.toast('Mot de passe modifié'); nav.pop(); } }), { back: 'Mode développeur' });
                  p.developer = true;
                },
              }),
              row({
                title: 'Supprimer le mot de passe',
                destructive: true,
                onClick: async () => {
                  if (!(await ctx.ui.confirm({ title: 'Supprimer le mot de passe ?', message: 'Le mode développeur et le Terminal ne seront plus accessibles jusqu\'à ce que vous en choisissiez un nouveau.', confirmLabel: 'Supprimer', destructive: true }))) return;
                  await dev.remove();
                  refresh();
                },
              }),
            ],
            footer: 'Commun à tous les comptes de l\'appareil. Seul le propriétaire peut le modifier.',
          })
        : null,
      listGroup({
        header: "Échelle d'animation",
        items: [
          h(
            'div.list-item',
            segmented(
              [
                { value: 0, label: 'Aucune' },
                { value: 0.5, label: '0,5×' },
                { value: 1, label: '1×' },
                { value: 2, label: '2×' },
                { value: 5, label: '5×' },
              ],
              s.get('animScale'),
              (v) => s.set('animScale', v),
            ),
          ),
          toggleRow('Afficher les appuis', 'showTouches'),
        ],
      }),
      listGroup({
        header: 'Modem simulé',
        items: [
          row({ icon: 'phone-incoming', iconColor: '#30d158', title: 'Simuler un appel entrant', subtitle: 'Dans 3 secondes', onClick: () => simulate('call') }),
          row({ icon: 'message-fill', iconColor: '#30d158', title: 'Simuler un SMS entrant', subtitle: 'Dans 3 secondes', onClick: () => simulate('sms') }),
        ],
      }),
      listGroup({
        header: 'Batterie simulée',
        items: [
          listItem({ title: 'En charge', trailing: toggle(k.device.battery.charging, (v) => { k.device.setCharging(v); if (v) ctx.sound.charge(); }) }),
          h('div.list-item', slider({ value: k.device.battery.level, min: 0.01, max: 1, step: 0.01, iconLeft: 'battery', onInput: (v) => k.device.setBatteryLevel(v), label: 'Niveau' })),
        ],
      }),
      listGroup({
        items: [
          row({ icon: 'list', iconColor: '#636366', title: 'Journal système', chevron: true, onClick: logPage }),
        ],
      }),
    ];
  }

  function simulate(kind) {
    const contacts = k.contacts.list().filter((c) => c.phone);
    const contact = contacts[Math.floor(Math.random() * contacts.length)];
    // Sans contact, un numéro inconnu au hasard.
    const number = contact?.phone ?? `+33 6 ${Array.from({ length: 4 }, () => String(Math.floor(Math.random() * 100)).padStart(2, '0')).join(' ')}`;
    const from = contact ? displayName(contact) : number;
    ctx.ui.toast(kind === 'call' ? `Appel de ${from} dans 3 s…` : `SMS de ${from} dans 3 s…`);
    setTimeout(() => {
      if (kind === 'call') k.telephony.incoming(number);
      else k.telephony.receiveSms(number, ['Tu es dispo pour un café ? ☕', 'Coucou ! Tu as vu mon message ?', 'On se retrouve à 19 h ?', 'Je viens de finir, je t\'appelle après.'][Math.floor(Math.random() * 4)]);
    }, 3000);
  }

  function logPage() {
    const p = open('Journal système', () => h('pre.log-view.selectable', k.log.list().slice(-200).map((e) => k.log.format(e)).join('\n')), { back: 'Mode développeur', large: false });
    p.developer = true;
  }

  // ───────────── Intents ─────────────

  const PAGES = { updates: updatesPage, camera: cameraPage, account: accountPage, users: () => accounts && usersPage(), wallpaper: wallpaperPage, battery: batteryPage, display: displayPage, wifi: wifiPage, bluetooth: bluetoothPage, cellular: cellularPage, location: locationPage, notifications: notificationsPage, privacy: privacyPage, storage: storagePage, apps: appsPage, passcode: passcodePage, protection: protectionPage, about: aboutPage, sound: soundPage, developer: developerPage };

  function handleIntent(intent) {
    const data = intent?.data;
    if (!data) return;
    if (data.page === 'app' && data.app) appPage(data.app);
    else PAGES[data.page]?.();
  }

  nav.push(mainPage());
  handleIntent(ctx.intent);
  ctx.onBack(async () => (nav.depth > 1 ? nav.pop() : false));
  // Redessins regroupés : immédiat, puis au plus un toutes les 250 ms (un téléchargement émet un événement par fichier).
  let redrawTimer = null;
  let redrawAgain = null;
  const redraw = (wanted) => {
    if (!wanted(nav.top)) return;
    if (redrawTimer) {
      redrawAgain = wanted;
      return;
    }
    nav.top?.onShow?.();
    redrawTimer = ctx.setTimeout(() => {
      redrawTimer = null;
      const again = redrawAgain;
      redrawAgain = null;
      if (again) redraw(again);
    }, 250);
  };
  const isRoot = () => nav.depth === 1;
  for (const type of ['settings:change', 'package:install', 'package:uninstall', 'network:change', 'bluetooth:change']) ctx.subscribe(type, () => redraw(isRoot));
  // Protection de l'appareil (autre fenêtre, analyse, délai) : sa page et le résumé de l'accueil suivent.
  ctx.subscribe('protection:change', () => redraw((top) => top?.protection || isRoot()));
  // Mises à jour : la page suit la vérification et le téléchargement en direct.
  ctx.subscribe('update:change', ({ status }) => {
    const wanted = (top) => top?.updates || isRoot();
    // Un changement d'état s'affiche tout de suite ; seule la progression du téléchargement est regroupée.
    if (status !== 'downloading' && wanted(nav.top)) nav.top?.onShow?.();
    else redraw(wanted);
  });
  // Mot de passe développeur créé, changé ou supprimé (autre fenêtre) : la page se met à jour.
  // Un simple essai raté (compté dans le registre) ne la redessine pas : le message d'erreur reste.
  ctx.subscribe('account:change', () => redraw((top) => (top?.devRoot && devState() !== devShown) || isRoot()));
  // Mode développeur verrouillé : ses sous-pages se ferment, sa page redemande le mot de passe.
  ctx.subscribe('developer:lock', async () => {
    while (nav.top?.developer) await nav.pop({ animated: false });
    nav.top?.onShow?.();
  });

  return {
    onIntent: async (intent) => {
      while (nav.depth > 1) await nav.pop({ animated: false });
      handleIntent(intent);
    },
  };
}
