# Orion OS

**Orion OS** est un système d'exploitation mobile fonctionnel, inspiré à la fois d'**iOS** et d'**Android**, qui s'exécute dans n'importe quel navigateur moderne et s'installe en plein écran sur un vrai téléphone (application web progressive).

Comme Firefox OS ou KaiOS, il est construit sur les technologies du Web : un **noyau JavaScript** gère les processus, le système de fichiers, les paquets, les intents, les notifications, les alarmes, les permissions et une pile téléphonie ; une **interface système** fournit l'écran verrouillé, l'accueil, les gestes, le multitâche ; et **20 applications** sont livrées (dont 4 à installer depuis le Store).

![Écran verrouillé, accueil, centre de contrôle et compte](docs/screenshots/apercu.jpg)

## Démarrage rapide

Aucune dépendance n'est nécessaire pour l'exécuter (Node.js ≥ 20 sert uniquement de serveur local) :

```bash
npm start
# → http://localhost:8080
```

- **Sur ordinateur**, le système s'affiche dans un cadre de téléphone avec ses boutons physiques (latéral, volume, silencieux) ; la souris remplace le doigt et le clic droit l'appui long.
- **Sur un téléphone**, il doit être servi en HTTPS : voir [Démarrer sur mobile](#démarrer-sur-mobile).
- N'importe quel hébergement statique convient (GitHub Pages, Netlify…) : tous les chemins sont relatifs.

Au premier démarrage, un assistant vous accueille (nom, thème, style de navigation, code de verrouillage). Toutes les données sont persistées dans IndexedDB.

## Démarrer sur mobile

Les navigateurs mobiles n'autorisent l'installation en plein écran, le fonctionnement hors ligne, la caméra, le micro et la localisation que sur une page **HTTPS**. Le plus simple est donc de publier Orion OS sur GitHub Pages (gratuit pour un dépôt public) :

1. Sur GitHub, ouvrez le dépôt → **Settings** → **Pages**.
2. Dans **Build and deployment**, choisissez **Source : Deploy from a branch**, puis la branche qui contient Orion OS et le dossier **/ (root)** → **Save**.
3. Après une à deux minutes, le système est en ligne à l'adresse `https://<utilisateur>.github.io/<dépôt>/` (par exemple `https://91val91.github.io/os/`).

Ouvrez ensuite cette adresse sur le téléphone et installez-la :

- **Android (Chrome)** : menu **⋮** → **Installer l'application** (ou « Ajouter à l'écran d'accueil »). L'icône Orion apparaît parmi vos applications ; elle s'ouvre en plein écran, sans barre d'adresse, et le bouton ou geste Retour d'Android agit dans Orion.
- **iPhone / iPad (Safari)** : bouton **Partager** → **Sur l'écran d'accueil**, en laissant « Ouvrir en tant qu'app web » activé → **Ajouter**.

Lancez toujours Orion depuis cette icône : dans un onglet du navigateur, la barre d'adresse reste visible et les gestes du bord de l'écran appartiennent au navigateur. Après la première ouverture, toute la version installée est sur le téléphone et le système démarre même sans réseau. Quand une nouvelle version est publiée, Orion vous le signale par une notification : voir [Mises à jour](#mises-à-jour).

**Sans hébergement**, depuis votre ordinateur :

- `HOST=0.0.0.0 npm start` puis `http://<ip-de-l-ordinateur>:8080` sur un téléphone du même Wi‑Fi : pratique pour un essai, mais en HTTP il n'y a ni installation, ni hors ligne, ni caméra, ni localisation.
- Un tunnel HTTPS temporaire lève ces limites : `npm start` dans un terminal, puis `cloudflared tunnel --url http://localhost:8080` dans un autre, et ouvrez l'adresse `https://….trycloudflare.com` affichée (elle change à chaque lancement).
- Android branché en USB : dans Chrome sur l'ordinateur, `chrome://inspect` → **Port forwarding** `8080 → localhost:8080`, puis `http://localhost:8080` sur le téléphone, qui compte comme une adresse sécurisée.

**Limites sur un vrai téléphone** : Orion OS reste une application web. Quand le téléphone est en veille ou qu'une autre application est au premier plan, il est suspendu : réveils et minuteurs ne sonnent qu'une fois Orion rouvert. Les appels et SMS passent par les apps Téléphone et Messages du téléphone (voir [Réseau, Bluetooth, téléphonie et GPS](#réseau-bluetooth-téléphonie-et-gps)), et les boutons physiques (volume, marche) restent ceux du téléphone hôte ; utilisez le centre de contrôle et le menu marche-arrêt d'Orion. Sur iPhone, l'app installée ne partage pas ses données avec Safari : ce qui a été configuré dans un onglet est à refaire dans l'app.

## Prise en main

| Geste / touche | Action |
| --- | --- |
| Glisser vers le haut depuis le bas | Retour à l'accueil (l'app rétrécit vers son icône) |
| Glisser vers le haut et maintenir | Applications récentes (cartes, glisser vers le haut pour fermer) |
| Glisser latéralement sur la barre du bas | Basculer vers l'app précédente |
| Glisser depuis le bord gauche ou droit, ou Retour du téléphone Android | Retour |
| Tirer la barre d'état à gauche | Volet de notifications et réglages rapides (Android) |
| Tirer la barre d'état à droite | Centre de contrôle (iOS) |
| Glisser vers le haut sur l'accueil | Tiroir d'applications avec recherche universelle |
| Appui long sur une icône | Raccourcis, infos, suppression, mode édition (glisser-déposer) |
| Bouton latéral (Alt+L) / appui long (Alt+P) | Veille et verrouillage / menu marche-arrêt |
| Échap · Alt+H · Alt+R · Alt+N · Alt+C | Retour · Accueil · Récentes · Notifications · Centre de contrôle |
| Alt+↑ / Alt+↓ | Volume |

Vous préférez la navigation Android à trois boutons (◁ ○ ▢) ? **Réglages → Personnalisation → Navigation système**. La forme des icônes (iOS, arrondie, ronde façon Android), la couleur d'accentuation, le thème, le fond d'écran et la taille du texte se règlent au même endroit.

![Volet, récentes, appel entrant, mode édition](docs/screenshots/systeme.jpg)

## Fonctionnalités

**Système**
- **Comptes et utilisateurs** : l'assistant crée votre compte (nom, e-mail facultatif) ; d'autres personnes peuvent avoir le leur sur le même téléphone (**Réglages → Compte → Utilisateurs**). Chaque compte a ses apps, fichiers, photos, contacts, messages, réglages et code ; on change d'utilisateur depuis l'écran verrouillé ou le volet de notifications. Les comptes sont enregistrés sur l'appareil uniquement (pas de synchronisation en ligne).
- Écran verrouillé avec horloge, notifications, lecture en cours, lampe et appareil photo ; code PIN haché (SHA-256 salé), appel d'urgence. Les erreurs de code sont comptées même après un redémarrage (attente d'1 min après 5 erreurs, puis 5 min, 15 min, 1 h).
- **Protection de l'appareil** : voir [Protection de l'appareil](#protection-de-lappareil).
- Accueil à pages avec dock, widgets (horloge, météo), badges, icônes vivantes (date du Calendrier, aiguilles de l'Horloge), mode édition par glisser-déposer.
- Multitâche : une instance par app, apps en arrière-plan conservées, écran des récentes, arrêt automatique des plus anciennes (« low memory killer »).
- Notifications en bannière, volet groupé, « Ne pas déranger », autorisation par app.
- Îlot d'activités en direct : appel en cours, minuteur, musique, enregistrement.
- Permissions à l'exécution (appareil photo, micro, localisation, contacts) : « Autoriser », « Une seule fois », « Refuser », révocables dans les Réglages.
- Intents à la Android : « Ouvrir avec », « Partager avec », sélection d'une photo ou d'un contact depuis une autre app (`startActivityForResult`).
- Alarmes système : réveils, minuteurs et rappels sonnent même si l'app est fermée.
- Thèmes clair/sombre/automatique, Night Shift, luminosité, économiseur de batterie.
- **Connectivité réelle** : Wi‑Fi, Bluetooth, réseau mobile et mode avion reflètent l'état réel de l'appareil ; installé sur un PC, une tablette ou une machine virtuelle, Orion pilote lui-même le Wi‑Fi, le Bluetooth et un modem 4G. Voir [Réseau, Bluetooth, téléphonie et GPS](#réseau-bluetooth-téléphonie-et-gps).
- **Service de localisation** (GPS du téléphone ou récepteur GPS branché sur Orion installé), partagé par les apps qui en ont l'autorisation ; icône dans la barre d'état pendant le suivi.
- **Mises à jour du système** (**Réglages → Général → Mise à jour logicielle**) : voir [Mises à jour](#mises-à-jour).
- **Mode développeur protégé par un mot de passe d'appareil** (**Réglages → Mode développeur**) : le propriétaire le choisit une fois (6 caractères minimum, lettres et chiffres) ; il vaut pour tous les comptes, seul le propriétaire peut le changer ou le supprimer, et « Réinitialiser les réglages » ne l'efface pas. Il est redemandé après chaque verrouillage de l'appareil. Après 5 erreurs, attente de 30 s, doublée à chaque nouvelle erreur (15 min au plus), même si l'on ferme les Réglages ou redémarre. Mot de passe oublié : le propriétaire le remplace avec son code de verrouillage.

**Applications**

| App | Points clés |
| --- | --- |
| Téléphone | Clavier DTMF, récents, favoris, messagerie vocale. Vrais appels : par le modem d'Orion installé, ou confiés à l'app Téléphone du téléphone |
| Messages | Conversations, photos jointes. Vrais SMS (modem ou app Messages du téléphone) ; en mode démonstration, correspondants simulés qui répondent |
| Plans | Carte OpenStreetMap (plan ou relief), position en direct avec précision et cap, recherche de lieux, itinéraires voiture/vélo/à pied, trajets enregistrés en GPX dans `Documents/Trajets` |
| Contacts | Carnet d'adresses partagé, index alphabétique, sélection pour d'autres apps |
| Appareil photo | Caméra réelle (ou scène simulée), filtres, formats 9:16/photo/carré, caméra avant/arrière, retardateur. **Réglages → Appareil photo** : format par défaut, qualité (Haute, Standard, Économie), retardateur, grille, selfies en miroir, son de l'obturateur, conserver les réglages |
| Photos | Photothèque par mois, albums, favoris, visionneuse avec balayage et zoom, fond d'écran |
| Horloge | Horloge mondiale, réveils avec jours de répétition, chronomètre à tours, minuteur |
| Calculatrice | Saisie d'expressions avec aperçu, mode scientifique, historique |
| Notes | Fichiers texte dans `/home/Documents/Notes`, recherche, épinglage, partage |
| Calendrier | Vue mensuelle, événements, rappels |
| Météo | Prévisions réelles via Open-Meteo, position par le service de localisation, recherche de villes ; données simulées hors ligne |
| Musique | Morceaux génératifs synthétisés en temps réel, import de fichiers audio, contrôle système |
| Navigateur | Barre d'adresse, favoris, historique, partage |
| Fichiers | Explorateur de votre espace personnel (Documents, Photos, Musique…), import/export, renommage, déplacement. Les fichiers système n'y sont pas accessibles |
| Réglages | Wi‑Fi (réseaux, mot de passe, test de débit), Bluetooth, réseau mobile, localisation, notifications, sons, affichage, fonds d'écran, confidentialité, protection de l'appareil, code, batterie, stockage, apps |
| Terminal | Shell `osh` avec tubes, redirections, complétion et plus de 60 commandes. Caché : il s'ouvre depuis les options pour les développeurs et se ferme au verrouillage |
| Store | Catalogue des apps d'Orion et de celles publiées par les développeurs, apps gratuites ou payantes (solde de test, reçus, remboursement sous 2 h), notes, compte. Voir [Publier une app sur le Store](#publier-une-app-sur-le-store) |
| 2048, Snake, Dessin, Dictaphone | À installer depuis le Store |

![Terminal, Musique, Météo, Store](docs/screenshots/applications.jpg)

## Architecture

```
┌────────────────────────── Applications (src/apps) ──────────────────────────┐
│ Téléphone · Messages · Photos · Réglages · Terminal · Store · …              │
│                 mount(root, ctx)  ←  contexte d'application (SDK)           │
├────────────────────────── Interface système (src/system) ───────────────────┤
│ Gestionnaire de fenêtres · Écran verrouillé · Accueil · Tiroir · Volet      │
│ Centre de contrôle · Navigation (gestes/boutons) · Appels · Alarmes · …     │
├────────────────────────── Noyau (src/kernel) ───────────────────────────────┤
│ accounts · processes · intents/activités · packages · vfs · settings        │
│ notifications · alarms · permissions · media · contacts · telephony · shell │
│ network · bluetooth · location · bridge (pont matériel orion-server)        │
│ store (Store et développeurs) · protection (protection de l'appareil)       │
├────────────────────────── Stockage ─────────────────────────────────────────┤
│ une base par compte : IndexedDB  →  localStorage  →  mémoire                │
└─────────────────────────────────────────────────────────────────────────────┘
```

- Le **noyau** est du JavaScript pur, sans accès au DOM : il est entièrement testé sous Node.js.
- Les services communiquent par un **bus d'événements** (`process:start`, `notification:post`, `alarm:fire`, `call:state`…).
- Les **comptes** sont listés dans un registre séparé (`orion-accounts`) ; chaque compte a sa propre base (`orion-os` pour le propriétaire, celle d'avant les comptes), ouverte au démarrage : changer d'utilisateur redémarre le système sur ses données.
- Le **système de fichiers virtuel** est hiérarchique (`/home`, `/data/<app>`, `/system` en lecture seule, `/tmp`), lisible de façon synchrone et persisté de façon asynchrone.
- Chaque application travaille dans un **bac à sable** : `ctx.fs` ne donne accès qu'à l'espace de l'utilisateur (`/home`, `/tmp`) et à ses propres données (`/data/<app>`) ; les fichiers système et ceux des autres apps lui sont refusés (`EACCES`), et aucun intent ne peut lui en confier un. Seul le Terminal, en mode développeur, voit tout le système.
- L'**interface système** est l'« hôte » du gestionnaire d'activités : elle crée une fenêtre par processus, charge le module de l'app à la demande et l'anime.
- Le **pont matériel** (`src/kernel/bridge.js`) parle à `orion-server`, le service natif d'Orion installé, servi sur la même origine (`/api/…`, voir `server/API.md`). Il n'est cherché que lorsqu'Orion est servi en local (`127.0.0.1`) ; ailleurs, les services `network`, `bluetooth`, `location` et `telephony` utilisent les API du navigateur.

## Écrire une application

1. Déclarez-la dans `src/apps/registry.js` :

```js
{
  id: 'meteo-plus',
  name: 'Météo+',
  icon: 'cloud-sun',              // pictogramme de l'icône (src/lib/icons.js)
  color: ['#5bb8ff', '#1f5fd6'],  // dégradé de l'icône et fond de l'écran de lancement
  category: 'Météo',
  permissions: ['location'],
  intents: [{ action: 'view', types: ['text/plain'] }],
  load: () => import('./meteo-plus/index.js'),
}
```

Les applications intégrées ont leur propre illustration (`src/system/app-art.js`) ; les autres affichent ce pictogramme sur leur dégradé.

2. Exportez une fonction `mount` :

```js
import { h } from '../../lib/dom.js';
import { page, button } from '../../lib/ui.js';

export function mount(root, ctx) {
  const view = page({ title: 'Météo+', content: button('Me notifier', { onClick: () => ctx.notify({ title: 'Bonjour !' }) }) });
  root.append(view);
  return { onPause() {}, onResume() {}, onIntent(intent) {}, onDestroy() {} };
}
```

Le contexte `ctx` donne accès au système :

| API | Rôle |
| --- | --- |
| `ctx.fs`, `ctx.storage` | Système de fichiers, préférences privées (`/data/<id>/storage.json`) |
| `ctx.notify(options)` | Publier une notification |
| `ctx.startActivity(intent)`, `ctx.startActivityForResult(intent)`, `ctx.finish(result)` | Intents |
| `ctx.requestPermission('camera')` | Permission à l'exécution |
| `ctx.alarms.schedule({ at \| hour, minute, days })` | Alarmes système |
| `ctx.media.set(meta, handlers)` | Session multimédia (centre de contrôle, écran verrouillé) |
| `ctx.ui.toast/alert/confirm/prompt/actionSheet/share/liveActivity` | Interface système |
| `ctx.on('pause' \| 'resume' \| 'intent' \| 'destroy')`, `ctx.onBack(fn)` | Cycle de vie et bouton Retour |
| `ctx.setTimeout/setInterval/raf/subscribe` | Ressources libérées automatiquement à la fermeture |

Les apps système reçoivent en plus `ctx.kernel` et `ctx.system`.

## Publier une app sur le Store

Tout compte de l'appareil peut devenir développeur : **Store → Compte → Publier vos apps sur le Store**.

1. **Inscription** au programme développeur : nom public, e-mail de contact, acceptation du contrat de distribution et **25 €** payés une fois.
2. **Console développeur** : revenus nets, ventes, installations et note moyenne ; « Nouvelle app » crée un brouillon à partir d'un modèle prêt à essayer.
3. **Édition** : nom, sous-titre, description, catégorie, prix (gratuit ou de 0,99 € à 9,99 €), icône (pictogramme et couleurs), autorisation de localisation, version et notes de version, et le **code** : un seul fichier HTML (avec ses `<style>` et `<script>`). **Essayer** lance le brouillon isolé, avec des données jetables.
4. **Examen automatique** avant chaque publication : fiche complète, numéro de version supérieur au précédent, taille du code (256 Ko au plus) et **analyse de sécurité** (tentative de sortir de l'environnement isolé, mineur de cryptomonnaie, imitation des écrans d'Orion pour voler un code : refusés ; accès réseau, `eval`, code masqué : signalés).
5. **Publication** : l'app apparaît dans le Store des autres comptes (« Nouveautés des développeurs », catégories, recherche). Une modification reste un brouillon jusqu'à « Publier la mise à jour ». « Retirer de la vente » la cache du Store ; ceux qui l'ont installée la gardent.

Le Store retient **15 %** de chaque vente ; le reste est versé sur le solde du développeur. Un acheteur peut être remboursé pendant 2 heures (l'app est alors désinstallée et la vente annulée).

**Paiements fictifs** : Orion n'a pas encore de service de paiement. Chaque compte a un **solde de test** (Store → Compte → « Ajouter des fonds de test », 500 € au plus) : aucun moyen de paiement réel n'est demandé ni débité. De même, sans serveur du Store, le catalogue est partagé par les comptes **de cet appareil**.

**Exécution isolée** : une app publiée tourne dans une `iframe` `sandbox="allow-scripts"` sans origine (ni la page d'Orion, ni ses données, ni le stockage du navigateur) et sans accès au réseau (politique de sécurité `default-src 'none'`). Elle ne parle au système que par le SDK `orion`, dont chaque appel est vérifié :

```html
<button id="b">+1</button>
<script>
  document.getElementById('b').onclick = async () => {
  const n = (await orion.storage.get('n')) ?? 0;      // données de l'app (1 Mo), dans /data/<app>
  await orion.storage.set('n', n + 1);
  orion.ui.toast('Bonjour');                          // aussi alert, confirm, prompt
  orion.device.vibrate(10);                           // et device.info()
  orion.notify({ title: 'Rappel', body: '…' });       // une toutes les 5 s au plus
  const pos = await orion.location.current();         // si l'app déclare la localisation et que l'utilisateur l'accepte
  };
  orion.onBack(() => false);                          // bouton Retour (true : traité par l'app) ; orion.on('pause' | 'resume' | 'theme', fn) ; orion.close()
</script>
```

## Protection de l'appareil

**Réglages → Protection de l'appareil** fait le **bilan de sécurité** de l'appareil et regroupe ses protections :

- **Bilan** : code de verrouillage, verrouillage automatique, mises à jour, intégrité du système, apps du Store installées, mode développeur ouvert, protection contre la réinitialisation. Chaque point à corriger mène au bon réglage.
- **Intégrité du système** (« Analyser maintenant ») : chaque fichier d'Orion gardé sur l'appareil est comparé à son empreinte SHA-256 publiée dans `version.json` ; un fichier modifié (extension du navigateur, stockage endommagé, logiciel malveillant) est signalé et **« Réparer »** le fait retélécharger et vérifier. Sur Orion installé, `orion-server` vérifie aussi les fichiers qu'il sert.
- **Analyse des apps** : les apps du Store sont analysées avant leur publication, avant chaque installation et à chaque analyse ; une app dangereuse ne s'installe pas.
- **Protection contre la réinitialisation** : si l'appareil est effacé autrement que par son propriétaire depuis les Réglages (trop d'erreurs de code, vol), il demande le code de l'ancien propriétaire avant de pouvoir resservir. Elle est gardée dans une base à part, que l'effacement d'Orion ne touche pas, et sur Orion installé par `orion-server` (`/var/lib/orion/protection.json`), qui vérifie le code sans jamais renvoyer son empreinte et limite les essais.
- **Effacer après 10 tentatives** (facultatif) : au dixième code faux, l'appareil est effacé (pour un autre compte que le propriétaire : ses seules données) ; un avertissement s'affiche à partir de la septième erreur.
- **Protection des données sensibles** (facultative) : changer ou désactiver le code, tout effacer ou désactiver une protection demande le code, puis n'est possible qu'**une heure plus tard** (pendant une heure) ; un voleur qui a vu votre code ne peut pas verrouiller votre appareil pour lui.
- **Verrouillage en cas de vol** (téléphone ou tablette) : un mouvement brusque, comme un appareil arraché de la main, le verrouille aussitôt. **Verrouillage hors ligne** : l'appareil se verrouille si la connexion est perdue plus de 10 secondes.
- Achats sur le Store et inscription au programme développeur : **vérification d'identité** par le code de verrouillage.

Limites : dans un navigateur ordinaire, « Effacer les données du site » efface aussi la protection contre la réinitialisation (le navigateur ne laisse rien survivre à cela) ; seule une installation avec `orion-server` y résiste. Le délai de sécurité s'applique partout (Orion ne connaît pas encore vos lieux familiers).

## Le shell `osh`

Accessible depuis le Terminal, en mode développeur (**Réglages → Mode développeur → Terminal**).

```sh
$ neofetch
$ ls -l /home/Photos | grep jpg | wc -l
$ echo "Courses : pain, café" > ~/Documents/liste.txt && open ~/Documents/liste.txt
$ pm list -a ; pm install snake ; open snake
$ ps ; kill 104
$ users                             # comptes de l'appareil
$ sim sms 0612345678 "Coucou !"     # simule un SMS entrant
$ net                               # état du réseau (connexion, Wi‑Fi, modem, pont matériel)
$ wifi scan ; wifi connect Maison   # Wi‑Fi (Orion installé)
$ bt ; gps                          # appareils Bluetooth, position actuelle
$ settings set theme dark
$ calc "sqrt(2) * 10"
```

Opérateurs `|`, `>`, `>>`, `;`, `&&`, `||`, variables (`$HOME`, `$?`), jokers (`*.txt`), historique (↑/↓) et complétion (Tab). `help` liste toutes les commandes.

## Réseau, Bluetooth, téléphonie et GPS

Une page web n'a pas le droit de piloter les radios d'un téléphone : c'est Android ou iOS qui les gère. Orion affiche donc l'état réel et utilise ce que le navigateur permet vraiment ; installé sur une machine (voir [Installer Orion](#installer-orion-sur-un-pc-ou-une-machine-virtuelle)), il pilote le matériel lui-même grâce à `orion-server`.

| | Sur un téléphone (navigateur) | Orion installé (PC, tablette, VM) |
| --- | --- | --- |
| Wi‑Fi | État réel : en ligne ou non, type de connexion, qualité et débit estimés (Chrome sur Android), test de débit. Le choix du réseau se fait dans les réglages du téléphone | Recherche des réseaux, connexion avec mot de passe, réseaux masqués, déconnexion, oubli, activation (NetworkManager) |
| Bluetooth | Chrome sur Android et ordinateur : appareils basse consommation (montres, capteurs…) choisis dans la fenêtre du navigateur, connexion réelle et batterie. Indisponible sur Safari (iPhone, iPad) et Firefox | Tous les appareils : recherche, appairage, connexion, batterie, oubli (BlueZ) |
| Appels et SMS | Vrais appels et SMS confiés aux apps Téléphone et Messages du téléphone (liens `tel:` et `sms:`) ; Orion garde l'historique et les conversations | Modem 4G/5G USB ou M.2 : appels entrants et sortants, SMS envoyés et reçus, données mobiles, opérateur et signal (ModemManager) |
| Localisation | GPS du téléphone (API Geolocation, en https), avec votre accord et celui du navigateur | Récepteur GPS USB (gpsd) : position, altitude, vitesse, satellites |
| Mode avion | Coupe les services d'Orion (appels, SMS, Bluetooth) | Coupe réellement le Wi‑Fi, le Bluetooth et le modem, puis les rallume comme avant |

Sur un ordinateur sans modem, **Réglages → Réseau mobile** permet de choisir le mode démonstration (appels et SMS simulés, correspondants qui répondent).

## Installer Orion sur un PC ou une machine virtuelle

Le dossier [`installer/`](installer/README.md) construit une **image ISO d'Orion OS** (PC 64 bits, BIOS et UEFI) : une Debian 12 minimale qui démarre directement sur Orion en plein écran (Chromium en mode kiosque dans `cage`), avec `orion-server` pour le matériel.

- **Machine virtuelle** : `installer/run-vm.sh` (QEMU), ou VirtualBox, VMware, GNOME Boxes, UTM.
- **Vrai PC ou tablette x86** : l'ISO s'écrit sur une clé USB (balenaEtcher, Rufus en mode DD, `dd`) et démarre sans toucher au disque.
- **Installation sur le disque** (*expérimental*) : entrée « Install » du menu de démarrage, avec l'installateur de Debian.
- **Construire l'image** : `sudo installer/build.sh` sur Debian 12, `installer/build-in-docker.sh` partout ailleurs, ou l'action GitHub `installer.yml` (onglet **Actions**, et jointe aux publications `v*`).
- **Mises à jour** : `orion-update.timer` télécharge et vérifie la dernière version publiée toutes les 6 heures ; Orion la propose ensuite comme sur le Web.

Pour développer sans le matériel : `python3 server/orion_server.py --simulate`, puis http://127.0.0.1:8080 (Wi‑Fi, Bluetooth, modem et GPS imités ; mot de passe Wi‑Fi `orion1234`). L'API est décrite dans [`server/API.md`](server/API.md).

> L'image n'a pas encore été construite ni démarrée sur de vrais PC : c'est un premier jet, à essayer d'abord en machine virtuelle. Les téléphones ARM (PinePhone, Librem 5…) viendront plus tard.

## Mises à jour

Le téléphone garde la version installée, entièrement en cache, jusqu'à ce que vous en installiez une nouvelle : une session ne mélange jamais deux versions.

- **Vérification** : au démarrage puis toutes les 6 heures, et à l'ouverture de **Réglages → Général → Mise à jour logicielle**. Une nouvelle version est annoncée par une notification et en tête des Réglages, avec ses nouveautés et la taille réellement à télécharger.
- **Téléchargement** : la nouvelle version est préparée à côté de l'actuelle. Seuls les fichiers modifiés transitent par le réseau ; chacun est vérifié avec son empreinte SHA-256 (un fichier altéré ou une publication en cours fait échouer la mise à jour, sans rien casser).
- **Installation** : « Installer maintenant » redémarre Orion sur la nouvelle version ; l'ancienne est effacée. Vos données, comptes et réglages sont conservés.
- **Automatique** : le téléchargement est automatique par défaut ; l'installation peut l'être aussi (quand l'appareil est verrouillé et que rien n'est en cours : appel, réveil, musique).
- **Version retirée** : si l'éditeur retire une version déjà téléchargée, elle est abandonnée et n'est jamais installée.

**Numérotation** : Orion OS est en **0.1 (alpha)**. Chaque publication porte aussi un numéro d'ordre (`sequence`, +1 à chaque version) : c'est lui qui dit quelle version est la plus récente. Les appareils encore en 1.2.0 (ancienne numérotation) passent donc bien à la 0.1 : le nouveau service worker la télécharge en arrière-plan et l'applique au redémarrage suivant d'Orion.

**Publier une version** : changez le numéro, le numéro d'ordre (`sequence` + 1) et les nouveautés dans `src/kernel/version.js`, ajoutez vos fichiers à git (`git add`), lancez `npm run release` (qui régénère `version.json` à partir de l'index git : version, notes, empreinte et taille de chaque fichier tel que GitHub Pages le servira ; il refuse de tourner s'il reste des changements non ajoutés), puis `git add version.json`, commitez et poussez. Les téléphones la proposent à la vérification suivante. Les tests échouent si `version.json` n'est plus à jour.

## Tests

```bash
npm test            # 112 tests unitaires (noyau, Store, protection, matériel avec un faux orion-server, mises à jour ; node:test, sans dépendance)
npm install && npx playwright install chromium
npm run test:e2e    # parcours complet dans Chromium : configuration, 20 apps, gestes, code PIN, comptes
npm run lint        # ESLint
npm run screenshots # régénère les captures du README
npm run release     # régénère version.json avant de publier une version
python3 -m unittest discover -s server   # 78 tests d'orion-server (pont matériel, protection, synchronisation)
```

## Structure du projet

```
index.html, manifest.webmanifest, sw.js   PWA (plein écran, hors ligne, mises à jour)
version.json                              version publiée (npm run release)
src/main.js                               point d'entrée
src/kernel/                               noyau (services, shell, stockage)
src/system/                               interface système
src/apps/                                 applications et registre
src/lib/                                  DOM, icônes, gestes, kit d'interface, calcul, formats
src/styles/                               jetons de design, interface système, composants
tests/                                    tests unitaires et de bout en bout
scripts/                                  serveur local, publication (version.json), icônes PWA, captures
server/                                   orion-server : pont matériel et mises à jour d'Orion installé (Python)
installer/                                image ISO installable (live-build), machine virtuelle, Docker
```

## Ce qui est réel, ce qui est simulé

Orion OS est un système d'exploitation **applicatif** : il gère ses propres processus, fichiers, paquets et périphériques virtuels, et s'appuie sur le navigateur (donc sur Android ou iOS) ou sur `orion-server` (Orion installé) pour le matériel. Concrètement :

- **réels** : appareil photo, micro, localisation, niveau de batterie, vibreur, son, état du réseau, appels et SMS (modem d'Orion installé, ou apps du téléphone), Bluetooth (Orion installé, ou appareils basse consommation dans Chrome), Wi‑Fi (Orion installé), plein écran et hors ligne ;
- **simulés** : le mode démonstration de la téléphonie (au choix, sur un ordinateur sans modem), la lampe torche, la batterie sur un ordinateur sans batterie, et les **paiements du Store** (solde de test : pas encore de service de paiement ni de serveur du Store).

Installé avec l'image prévue pour cela, Orion devient le système principal de la machine, à la manière de Firefox OS (B2G) ou KaiOS : un noyau Linux, un navigateur en mode kiosque lancé au démarrage et `orion-server` pour le matériel.

## Licence

Apache 2.0 — voir [LICENSE](LICENSE).
