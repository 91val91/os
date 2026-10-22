/**
 * Réglages : configuration complète du système.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { formatBytes, formatDuration } from '../../lib/format.js';
import { navStack, page, listGroup, listItem, toggle, slider, segmented, avatar, button, spinner } from '../../lib/ui.js';
import { PERMISSIONS } from '../../kernel/permissions.js';
import { createPasscode, verifyPasscode } from '../../kernel/settings.js';
import { displayName } from '../../kernel/contacts.js';
import { WALLPAPERS, wallpaperCss } from '../../system/wallpapers.js';
import { appIcon } from '../../system/app-icon.js';
import { logo } from '../../system/power.js';

export const styles = [new URL('./style.css', import.meta.url).href];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROFILE_COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];
const ACCENTS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];
const NETWORKS = [
  { name: 'Orion-Maison', secure: true, signal: 3 },
  { name: 'Livebox-4A2F', secure: true, signal: 3 },
  { name: 'Freebox-9B1C', secure: true, signal: 2 },
  { name: 'Café du Coin', secure: false, signal: 2 },
  { name: 'Bbox-77E0', secure: true, signal: 1 },
  { name: 'iPhone de Léa', secure: true, signal: 1 },
];

export function mount(root, ctx) {
  const k = ctx.kernel;
  const s = k.settings;
  const ui = ctx.system;
  const nav = navStack(root);

  const accounts = k.accounts;
  /** Compte de la session (profil minimal si les comptes sont indisponibles). */
  const me = () => k.account ?? { id: null, name: s.get('userName'), email: '', color: s.get('accent'), photo: null, owner: !accounts, createdAt: null };
  const accountAvatar = (a, size) => avatar(a.name || '?', { size, color: a.color, photo: a.photo });
  const row = (opts) => listItem(opts);
  const toggleRow = (title, key, { icon: iconName, color, subtitle, invert = false, onChange } = {}) => {
    const sw = toggle(invert ? !s.get(key) : s.get(key), (v) => {
      s.set(key, invert ? !v : v);
      onChange?.(v);
    }, { label: title });
    const off = s.watch(key, (v) => sw.set(invert ? !v : v));
    ctx.on('destroy', off);
    return listItem({ icon: iconName, iconColor: color, title, subtitle, trailing: sw });
  };

  /** Crée une sous-page et l'empile. `build(content, refresh)` remplit le contenu. */
  function open(title, build, { back = 'Réglages', large = true } = {}) {
    const content = h('div');
    const p = page({ title, large, back: { label: back, onClick: () => nav.pop() }, content });
    const refresh = () => content.replaceChildren(...[build(refresh)].flat().filter(Boolean));
    p.onShow = refresh;
    refresh();
    nav.push(p);
    return p;
  }

  // ───────────── Page principale ─────────────

  function mainPage() {
    const content = h('div');
    const render = () => {
      const net = k.device.connectivity;
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
        listGroup({
          items: [
            toggleRow('Mode avion', 'airplane', { icon: 'airplane', color: '#ff9500', onChange: render }),
            row({ icon: 'wifi', iconColor: '#0a84ff', title: 'Wi‑Fi', detail: net.wifi ? s.get('wifiNetwork') : 'Désactivé', chevron: true, onClick: wifiPage }),
            row({ icon: 'bluetooth', iconColor: '#0a84ff', title: 'Bluetooth', detail: s.get('bluetooth') ? 'Activé' : 'Désactivé', chevron: true, onClick: bluetoothPage }),
            row({ icon: 'antenna', iconColor: '#30d158', title: 'Réseau mobile', detail: k.telephony.network.operator, chevron: true, onClick: cellularPage }),
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
            row({ icon: 'lock', iconColor: '#ff3b30', title: 'Code de verrouillage', detail: s.get('passcode') ? 'Activé' : 'Désactivé', chevron: true, onClick: passcodePage }),
            row({ icon: 'battery', iconColor: '#30d158', title: 'Batterie', detail: `${Math.round(k.device.battery.level * 100)} %`, chevron: true, onClick: batteryPage }),
            row({ icon: 'storage', iconColor: '#8e8e93', title: 'Stockage', detail: formatBytes(k.fs.du('/')), chevron: true, onClick: storagePage }),
          ],
        }),
        listGroup({
          items: [
            row({ icon: 'apps', iconColor: '#5856d6', title: 'Applications', detail: String(k.packages.list().length), chevron: true, onClick: appsPage }),
            row({ icon: 'settings', iconColor: '#8e8e93', title: 'Général', chevron: true, onClick: generalPage }),
            s.get('developer') ? row({ icon: 'code', iconColor: '#636366', title: 'Options pour les développeurs', chevron: true, onClick: developerPage }) : null,
            row({ icon: 'info', iconColor: '#8e8e93', title: `À propos de ${k.os.name}`, chevron: true, onClick: aboutPage }),
          ].filter(Boolean),
        }),
      ];
      content.replaceChildren(...groups);
    };
    const p = page({ title: 'Réglages', content });
    p.onShow = render;
    render();
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

  function wifiPage() {
    open('Wi‑Fi', (refresh) => {
      const on = s.get('wifi') && !s.get('airplane');
      const items = [
        listGroup({
          items: [toggleRow('Wi‑Fi', 'wifi', { onChange: refresh })],
          footer: s.get('airplane') ? 'Le mode avion est activé.' : null,
        }),
      ];
      if (on) {
        items.push(
          listGroup({
            items: [row({ leading: h('span.check-mark', icon('check', { size: 18, stroke: 2.6 })), title: s.get('wifiNetwork'), subtitle: 'Connecté', trailing: h('span.wifi-meta', icon('lock', { size: 14 }), icon('wifi', { size: 18 })) })],
          }),
          listGroup({
            header: 'Réseaux',
            items: NETWORKS.filter((n) => n.name !== s.get('wifiNetwork')).map((n) =>
              row({
                title: n.name,
                trailing: h('span.wifi-meta', n.secure ? icon('lock', { size: 14 }) : null, icon('wifi', { size: 18, stroke: n.signal >= 2 ? 2 : 1.4 })),
                onClick: async () => {
                  if (n.secure) {
                    const pass = await ctx.ui.prompt({ title: `Mot de passe pour « ${n.name} »`, type: 'password', placeholder: 'Mot de passe', confirmLabel: 'Rejoindre' });
                    if (pass == null) return;
                    if (pass.length < 8) {
                      ctx.ui.alert({ title: 'Connexion impossible', message: 'Mot de passe incorrect (8 caractères minimum).' });
                      return;
                    }
                  }
                  s.set('wifiNetwork', n.name);
                  ctx.ui.toast(`Connecté à ${n.name}`);
                  refresh();
                },
              }),
            ),
          }),
        );
      }
      return items;
    });
  }

  function bluetoothPage() {
    const devices = () => s.get('btDevices') ?? { 'Écouteurs Orion Buds': false, 'Enceinte JBL Flip': false, 'Montre Orion Watch': true };
    open('Bluetooth', (refresh) => {
      const on = s.get('bluetooth') && !s.get('airplane');
      const list = devices();
      return [
        listGroup({ items: [toggleRow('Bluetooth', 'bluetooth', { onChange: refresh })], footer: `Visible sous le nom « ${s.get('deviceName')} ».` }),
        on
          ? listGroup({
              header: 'Mes appareils',
              items: Object.entries(list).map(([name, connected]) =>
                row({
                  title: name,
                  detail: connected ? 'Connecté' : 'Non connecté',
                  onClick: () => {
                    s.set('btDevices', { ...list, [name]: !connected });
                    ctx.ui.toast(connected ? `${name} déconnecté` : `${name} connecté`);
                    refresh();
                  },
                }),
              ),
            })
          : null,
        on ? listGroup({ header: h('span.scanning', 'Autres appareils', spinner(14)), items: [row({ title: 'TV Salon', subtitle: 'Recherche…' })] }) : null,
      ];
    });
  }

  function cellularPage() {
    open('Réseau mobile', () => {
      const net = k.telephony.network;
      return [
        listGroup({ items: [toggleRow('Données cellulaires', 'cellular')] }),
        listGroup({
          header: 'Opérateur',
          items: [row({ title: 'Opérateur', detail: net.operator }), row({ title: 'Technologie', detail: net.cellular ? '5G' : '—' }), row({ title: 'Numéro', detail: '+33 6 00 00 00 00' })],
        }),
      ];
    });
  }

  // ───────────── Notifications & sons ─────────────

  function notificationsPage() {
    open('Notifications', () => [
      listGroup({ items: [toggleRow('Ne pas déranger', 'dnd', { icon: 'moon-fill', color: '#5e5ce6', subtitle: 'Masque les bannières et coupe les sons' })] }),
      listGroup({
        header: 'Applications',
        items: k.packages.list().map((pkg) => {
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
      listGroup({ items: [toggleRow('Service de localisation', 'location', { icon: 'location', color: '#0a84ff' })] }),
      listGroup({
        header: 'Autorisations',
        items: Object.entries(PERMISSIONS).map(([perm, info]) => {
          const apps = k.packages.list().filter((p) => p.permissions.includes(perm));
          return row({ icon: info.icon, iconColor: '#0a84ff', title: info.label, detail: String(apps.length), chevron: true, onClick: () => permissionPage(perm, info) });
        }),
        footer: 'Les applications doivent déclarer une autorisation puis la demander. Vous pouvez la révoquer à tout moment.',
      }),
    ]);
  }

  function permissionPage(perm, info) {
    open(info.label, (refresh) => {
      const apps = k.packages.list().filter((p) => p.permissions.includes(perm));
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

  async function checkCurrentCode() {
    const record = s.get('passcode');
    if (!record) return true;
    const code = await ctx.ui.prompt({ title: 'Code actuel', type: 'password', placeholder: '••••' });
    if (code == null) return false;
    if (await verifyPasscode(record, code)) return true;
    await ctx.ui.alert({ title: 'Code incorrect' });
    return false;
  }

  function passcodePage() {
    open('Code de verrouillage', (refresh) => {
      const enabled = Boolean(s.get('passcode'));
      return [
        h('div.settings-hero', h('div.hero-icon', icon('lock-fill', { size: 34 })), h('p', enabled ? 'Votre appareil est protégé par un code.' : "Protégez l'accès à votre appareil avec un code.")),
        listGroup({
          items: enabled
            ? [
                row({ title: 'Modifier le code', onClick: async () => { if (!(await checkCurrentCode())) return; const code = await askNewCode(); if (code) { s.set('passcode', await createPasscode(code)); ctx.ui.toast('Code modifié'); refresh(); } } }),
                row({ title: 'Désactiver le code', destructive: true, onClick: async () => { if (!(await checkCurrentCode())) return; s.set('passcode', null); ctx.ui.toast('Code désactivé'); refresh(); } }),
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
      const apps = k.packages.list().slice(0, 8);
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
    const off = k.events.on('battery:change', () => nav.top === p && p.onShow());
    ctx.on('destroy', off);
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
        header: `${k.packages.list().length} applications installées`,
        items: k.packages.list().map((pkg) => row({ leading: appIcon(pkg, { size: 30 }), title: pkg.name, subtitle: pkg.system ? 'Application système' : `Version ${pkg.version}`, detail: formatBytes(pkg.size * 1_048_576 + (k.fs.exists(`/data/${pkg.id}`) ? k.fs.du(`/data/${pkg.id}`) : 0)), chevron: true, onClick: () => appPage(pkg.id) })),
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
          button('Ouvrir', { variant: 'tinted', icon: 'arrow-right', onClick: () => ctx.startActivity({ app: id, action: 'main' }) }),
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
            for (const key of Object.keys(s.all())) if (!['setupDone', 'userName', 'passcode', 'demoDataRemoved'].includes(key)) s.reset(key);
            ctx.ui.toast('Réglages réinitialisés');
          } }),
          me().owner
            ? row({ title: 'Effacer contenu et réglages', destructive: true, onClick: async () => {
                const others = (accounts?.list().length ?? 1) > 1;
                if (!(await ctx.ui.confirm({ title: 'Tout effacer ?', message: `Toutes les données (photos, notes, messages, réglages${others ? ' et tous les comptes' : ''}) seront supprimées et l'appareil redémarrera.`, confirmLabel: 'Tout effacer', destructive: true }))) return;
                await ui.eraseDevice();
              } })
            : row({ title: 'Effacer le contenu de mon compte', destructive: true, onClick: async () => {
                if (!(await ctx.ui.confirm({ title: 'Effacer votre contenu ?', message: 'Vos apps, fichiers, messages et réglages seront supprimés ; votre compte sera reconfiguré au redémarrage.', confirmLabel: 'Effacer', destructive: true }))) return;
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
        h('div.settings-hero', h('div.hero-logo', logo(72)), h('h2', `${k.os.name} ${k.os.version}`), h('p', `« ${k.os.codename} »`)),
        listGroup({
          items: [
            row({ title: 'Nom', detail: s.get('deviceName') }),
            row({ title: 'Version', detail: k.os.version }),
            row({
              title: 'Numéro de build',
              detail: k.os.build,
              onClick: () => {
                if (s.get('developer')) return ctx.ui.toast('Vous êtes déjà développeur');
                taps++;
                if (taps >= 7) {
                  s.set('developer', true);
                  ctx.ui.toast('Vous êtes maintenant développeur !');
                } else if (taps >= 3) ctx.ui.toast(`Plus que ${7 - taps} étape(s) pour devenir développeur`);
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

  function developerPage() {
    open('Développeur', (refresh) => [
      listGroup({ items: [toggleRow('Options pour les développeurs', 'developer', { onChange: (v) => !v && nav.pop() })] }),
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
          row({ icon: 'terminal', iconColor: '#3a3a40', title: 'Ouvrir le Terminal', chevron: true, onClick: () => ctx.startActivity({ app: 'terminal', action: 'main' }) }),
        ],
      }),
    ]);
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
    open('Journal système', () => h('pre.log-view.selectable', k.log.list().slice(-200).map((e) => k.log.format(e)).join('\n')), { back: 'Développeur', large: false });
  }

  // ───────────── Intents ─────────────

  const PAGES = { account: accountPage, users: () => accounts && usersPage(), wallpaper: wallpaperPage, battery: batteryPage, display: displayPage, wifi: wifiPage, bluetooth: bluetoothPage, notifications: notificationsPage, privacy: privacyPage, storage: storagePage, apps: appsPage, passcode: passcodePage, about: aboutPage, sound: soundPage, developer: developerPage };

  function handleIntent(intent) {
    const data = intent?.data;
    if (!data) return;
    if (data.page === 'app' && data.app) appPage(data.app);
    else PAGES[data.page]?.();
  }

  nav.push(mainPage());
  handleIntent(ctx.intent);
  ctx.onBack(async () => (nav.depth > 1 ? nav.pop() : false));
  const offs = ['settings:change', 'package:install', 'package:uninstall'].map((type) =>
    k.events.on(type, () => {
      if (nav.depth === 1) nav.top?.onShow?.();
    }),
  );
  ctx.on('destroy', () => offs.forEach((off) => off()));

  return {
    onIntent: async (intent) => {
      while (nav.depth > 1) await nav.pop({ animated: false });
      handleIntent(intent);
    },
  };
}
