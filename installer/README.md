# Image installable d'Orion OS (machine virtuelle et vrai PC)

Ce dossier construit une **image ISO d'Orion OS** pour PC 64 bits (amd64) : une Debian 12 minimale qui démarre directement sur Orion en plein écran, sans bureau ni navigateur visible. La même image sert à trois choses :

- **l'essayer dans une machine virtuelle** (QEMU, VirtualBox, VMware, GNOME Boxes, UTM) ;
- **démarrer un vrai PC ou une tablette x86 depuis une clé USB**, sans rien modifier sur le disque ;
- **l'installer sur le disque** de la machine (*expérimental*).

Sur cette machine, le Wi‑Fi, le Bluetooth, le réseau mobile, le GPS et le bouton marche/arrêt d'Orion pilotent le vrai matériel, grâce au serveur [`orion-server`](../server/API.md).

> **État : expérimental.** L'image n'a pas encore été construite et testée sur beaucoup de machines. Les retours (modèle de PC, ce qui marche, ce qui ne marche pas) sont les bienvenus.

## Ce que contient l'image

```
Démarrage (GRUB en UEFI, isolinux en BIOS)
 └─ Debian 12, noyau Linux 6.1, micrologiciels Wi‑Fi/Bluetooth/son/graphismes
     ├─ orion-server.service   http://127.0.0.1:8080 : fichiers d'Orion + API matérielle
     │    ├─ NetworkManager (Wi‑Fi, Ethernet, données mobiles)
     │    ├─ BlueZ (Bluetooth)          ├─ ModemManager (appels, SMS)
     │    ├─ gpsd (GPS USB)             └─ systemd-logind (redémarrer, éteindre)
     ├─ tty1 : connexion automatique de « orion » → cage (Wayland) → Chromium en mode kiosque
     └─ orion-update.timer     toutes les 6 h : télécharge et vérifie la dernière version d'Orion
```

| Élément | Où |
| --- | --- |
| Interface d'Orion (version en service) | `/var/lib/orion/current` → `/var/lib/orion/releases/<version>/` |
| Serveur matériel | `/opt/orion-server/orion_server.py` (+ `API.md`) |
| Protection contre la réinitialisation (empreinte du code du propriétaire) | `/var/lib/orion/protection.json` |
| Lancement de l'interface | `/usr/local/bin/orion-kiosk`, appelé par `~/.bash_profile` sur tty1 |
| Réglages (port, source des mises à jour, options de Chromium) | `/etc/default/orion` |
| Droits de l'utilisateur `orion` (réseau, modem, alimentation) | `/etc/polkit-1/rules.d/50-orion.rules` |
| Règles de Chromium (pas de compte, de traduction, de mots de passe…) | `/etc/chromium/policies/managed/orion.json` |

L'utilisateur `orion` fait tout tourner ; `root` est verrouillé. Le serveur n'écoute que sur 127.0.0.1 et refuse toute requête qui ne vient pas d'Orion lui‑même (voir la section *Sécurité* de [`server/API.md`](../server/API.md)).

## Construire l'image

Il faut environ **10 Go d'espace libre**, une connexion Internet (1,5 Go de paquets Debian téléchargés la première fois) et **30 à 60 minutes**. Le fichier produit est `installer/out/orion-os-<version>-amd64.iso` (environ 1,5 Go), avec son empreinte `.sha256`. La version est celle de `version.json` ; la construction vérifie d'abord que `version.json` correspond aux fichiers (sinon : `npm run release`).

**Sur Debian 12** (ou une machine virtuelle Debian 12) :

```bash
sudo apt install live-build
sudo installer/build.sh
```

Le live-build d'Ubuntu (version 3.x) est trop ancien : sur Ubuntu, utilisez Docker.

**Depuis n'importe quel système avec Docker** (Linux, macOS, Windows avec WSL 2) :

```bash
installer/build-in-docker.sh
```

La construction a lieu dans un conteneur Debian 12 privilégié ; les paquets téléchargés sont gardés dans le volume Docker `orion-os-build` pour les fois suivantes. Sur un Mac à puce Apple, le conteneur amd64 est émulé : comptez plusieurs heures.

**Sur GitHub, sans rien installer** : l'action [`.github/workflows/installer.yml`](../.github/workflows/installer.yml) teste le serveur, construit l'image à chaque modification de `server/` ou `installer/`, et la dépose en artefact (onglet **Actions** → la dernière exécution → *orion-os-amd64-iso*). On peut aussi la lancer à la main (**Run workflow**). Pour une étiquette `v0.1` poussée sur GitHub, l'image est jointe à la publication correspondante (onglet **Releases**).

## Essayer dans une machine virtuelle

Prévoir **3 à 4 Go de mémoire** et 2 processeurs. La souris tient lieu de doigt ; le clavier est en AZERTY.

**QEMU** (Linux, macOS) — le plus simple :

```bash
sudo apt install qemu-system-x86 ovmf     # macOS : brew install qemu
installer/run-vm.sh                        # dernière image de installer/out/
installer/run-vm.sh --bios                 # démarrage BIOS au lieu d'UEFI
installer/run-vm.sh --gpu std              # si l'écran reste noir
```

Le script active KVM quand c'est possible (sans KVM, tout est émulé et lent), utilise l'UEFI (OVMF) s'il est installé, une carte graphique virtio, une tablette USB (pointeur absolu, comme un écran tactile) et le réseau de QEMU (vu comme un câble Ethernet par Orion).

**VirtualBox** : *Nouvelle* → type *Linux*, version *Debian (64-bit)*, 3 072 Mo, 2 processeurs ; *Affichage* → contrôleur *VMSVGA*, 3D désactivée ; *Stockage* → choisir l'ISO dans le lecteur optique ; *Système* → cocher *Activer EFI* (facultatif). Pas besoin des additions invité.

**VMware Workstation / Fusion (Mac Intel)** : nouvelle machine depuis l'ISO, système *Debian 12.x 64 bits* (ou *Autre Linux 6.x 64 bits*), 3 Go de mémoire.

**GNOME Boxes** : **+** → *Créer une machine virtuelle* → choisir le fichier ISO, puis 3 Go de mémoire.

**UTM (Mac)** : *Créer une machine virtuelle* → *Émuler* (obligatoire sur puce Apple : l'image est amd64), *Linux*, choisir l'ISO, 4 Go, 4 cœurs. Sur puce Apple l'émulation est lente mais fonctionne ; sur Mac Intel, choisir *Virtualiser*.

Dans une machine virtuelle il n'y a ni Wi‑Fi, ni Bluetooth, ni modem, ni GPS : Orion les affiche comme absents et utilise la connexion filaire virtuelle. On peut transmettre un vrai périphérique USB (clé Wi‑Fi, dongle Bluetooth, GPS, modem 4G) à la machine virtuelle : il fonctionne alors comme sur un vrai PC.

## Démarrer un vrai PC depuis une clé USB

Il faut une clé d'au moins **4 Go** (son contenu sera effacé).

- **Windows, macOS, Linux** : [balenaEtcher](https://etcher.balena.io/) → *Flash from file* → l'ISO → la clé → *Flash*.
- **Windows** : [Rufus](https://rufus.ie/) → l'ISO → *Démarrer* ; à la question, choisir **« Écrire en mode Image DD »**.
- **Linux** (vérifiez trois fois le nom du périphérique avec `lsblk`, tout son contenu sera perdu) :
  ```bash
  sha256sum -c orion-os-*-amd64.iso.sha256
  sudo dd if=orion-os-<version>-amd64.iso of=/dev/sdX bs=4M conv=fsync status=progress
  ```

Ensuite, branchez la clé sur le PC éteint et démarrez en ouvrant le **menu de démarrage** : selon la marque, **F12** (Dell, Lenovo, Acer), **F9** (HP), **F8** (Asus), **F11** (MSI), **Échap** ou **F10** ; sur une tablette Windows, maintenez *Volume bas* en l'allumant, ou depuis Windows : *Paramètres → Système → Récupération → Démarrage avancé*. Choisissez la clé USB (de préférence l'entrée « UEFI »). Dans le menu d'Orion, la première entrée démarre le système.

**Secure Boot** : l'image utilise le chargeur signé de Debian (shim) et démarre normalement avec Secure Boot activé. Si la machine refuse quand même de démarrer la clé, désactivez Secure Boot dans le réglage du micrologiciel (**F2** ou **Suppr** au démarrage, menu *Security* ou *Boot*). Les vieux PC sans UEFI démarrent en mode BIOS.

En démarrage sur clé (« système live »), tout ce que vous faites dans Orion est **perdu à l'extinction** : rien n'est écrit sur le disque du PC. Pour garder vos données, installez Orion.

## Installer sur le disque (expérimental)

> **Attention : l'installation efface tout le disque choisi** (Windows, fichiers…). Faites une sauvegarde et n'utilisez qu'une machine dédiée à Orion.

1. Démarrez sur la clé USB et choisissez dans le menu de démarrage l'entrée **d'installation** (« Install » ou « Graphical install », parfois sous « Advanced options » / « Start installer »).
2. L'installateur de Debian s'ouvre en français, avec le clavier, le fuseau horaire et le nom de la machine (`orion`) déjà réglés. Il demande seulement :
   - le **mot de passe de l'utilisateur `orion`** (deux fois) — il sert sur les consoles de dépannage, la session d'Orion s'ouvre toute seule ;
   - le **disque** où installer Orion, puis une **confirmation** avant d'écrire dessus ;
   - éventuellement le réseau (facultatif : tout est déjà sur la clé).
3. À la fin, retirez la clé : la machine redémarre directement sur Orion.

**Pourquoi l'installateur de Debian** plutôt qu'un script maison : c'est celui des images officielles de Debian (mode « live », qui copie le système de la clé tel quel). Il est éprouvé sur une grande variété de machines : il détecte BIOS ou UEFI et installe le bon chargeur (y compris pour Secure Boot), gère les disques NVMe, eMMC, SATA, crée la partition EFI quand il le faut, retire les paquets propres au système live et ajoute de lui-même son entrée au menu de démarrage. Un script maison aurait fait la même chose avec bien plus de risques de rater un cas dès le premier essai. Les réponses par défaut sont dans [`config/includes.installer/preseed.cfg`](config/includes.installer/preseed.cfg) ; le choix du disque et la confirmation restent toujours demandés.

Sur le système installé, `root` est verrouillé (comme sur un téléphone) : l'utilisateur `orion` peut piloter le réseau, le modem, l'alimentation et redémarrer ses propres services, et les correctifs de sécurité de Debian s'installent automatiquement (`unattended-upgrades`).

Pour essayer l'installation sans risque, dans une machine virtuelle :

```bash
installer/run-vm.sh --disk orion.qcow2          # démarrer la clé avec un disque virtuel vide de 16 Go
installer/run-vm.sh --disk orion.qcow2 --no-iso # puis démarrer le système installé
```

## Ce qui fonctionne sur un PC

| Fonction | Sur un PC ou une tablette x86 |
| --- | --- |
| Wi‑Fi | Cartes Intel, Realtek, Atheros/Qualcomm, Broadcom, Marvell (micrologiciels inclus) via NetworkManager : recherche, réseaux protégés, réseaux connus, oubli |
| Ethernet | Automatique (DHCP) ; c'est la connexion des machines virtuelles |
| Bluetooth | Adaptateurs intégrés ou clés USB, via BlueZ : recherche, appairage, connexion. Casques et enceintes passent par PipeWire. Appareils demandant un code (certains claviers) : pas encore |
| Réseau mobile | Modems 4G/5G USB ou M.2 reconnus par ModemManager (Quectel, Sierra Wireless, Fibocom, Huawei…) avec une carte SIM : opérateur, signal, données mobiles, SMS, appels (le son des appels dépend du modem et n'est pas encore relié aux haut-parleurs) |
| GPS | Récepteurs USB (u-blox, SiRF, la plupart des « GPS USB » NMEA) détectés automatiquement par gpsd. Le GPS intégré aux modems n'est pas encore utilisé |
| Son, caméra, micro | Carte son du PC (PipeWire), webcams USB ou intégrées |
| Batterie | Niveau et charge lus par Chromium (UPower) |
| Redémarrer / éteindre | Depuis le menu marche‑arrêt d'Orion |
| Écran tactile | Pris en charge (événements tactiles de Chromium) |

**Limites actuelles**

- **PC 64 bits (amd64) uniquement.** Les téléphones et cartes ARM (PinePhone, Librem 5, Raspberry Pi…) sont une étape ultérieure (même système, mais image et noyau différents).
- Pas de clavier à l'écran : sur une tablette sans clavier, la saisie de texte demande un clavier USB ou Bluetooth.
- Une seule session et un seul écran : avec un écran externe branché, l'affichage s'étend sur les deux.
- En démarrage sur clé, rien n'est conservé à l'extinction.

## Mises à jour

Deux mécanismes complémentaires :

1. **Orion lui‑même** : toutes les 6 heures (et 5 minutes après le démarrage), `orion-update.timer` lance `orion_server.py sync`, qui télécharge la dernière version publiée sur `https://91val91.github.io/os/` dans `/var/lib/orion/releases/<version>/`. Seuls les fichiers modifiés sont téléchargés, **chacun est vérifié** (taille et SHA‑256 de `version.json`), puis le lien `/var/lib/orion/current` bascule d'un coup ; la version précédente est gardée. En cas de problème, rien ne change. L'interface d'Orion voit alors la nouvelle version et la propose comme d'habitude dans **Réglages → Général → Mise à jour logicielle** (téléchargement depuis la machine elle‑même, installation au redémarrage). Pour vérifier tout de suite : `systemctl start orion-update` puis `journalctl -u orion-update`. La source se change dans `/etc/default/orion` (`ORION_UPDATE_SOURCE`).
2. **Debian** (noyau, Chromium, pilotes) : correctifs de sécurité installés automatiquement sur le système installé. Pour une nouvelle version de Debian, réinstallez avec une nouvelle image.

## Dépannage

- **Écran noir ou interface qui ne s'affiche pas** : **Ctrl+Alt+F2** ouvre une console (en démarrage sur clé, déjà connectée ; sur un système installé, utilisateur `orion` et son mot de passe ; le mot de passe du système live est `live`). **Ctrl+Alt+F1** revient à l'interface. Après trois échecs de démarrage, l'interface passe d'elle‑même au rendu logiciel, puis, si la carte graphique n'est pas prise en charge par le compositeur Wayland (carte standard de QEMU, Hyper‑V, affichage UEFI générique sans pilote), à un affichage X11 de secours (`journalctl -t orion-kiosk` dit lequel est utilisé). En machine virtuelle, préférez une carte *virtio* (`run-vm.sh`, GNOME Boxes, virt-manager) ou, dans VirtualBox, le contrôleur graphique *VMSVGA*.
- **Journaux** :
  ```bash
  journalctl -b -u orion-server      # serveur et pont matériel
  journalctl -b -t orion-kiosk       # cage et Chromium
  journalctl -b -u orion-update      # mises à jour
  systemctl status orion-server
  systemctl restart orion-server     # autorisé pour l'utilisateur orion
  ```
- **État du matériel** : `nmcli device`, `nmcli device wifi list`, `bluetoothctl show`, `mmcli -L`, `rfkill list`, et l'API elle‑même :
  ```bash
  python3 -c 'import urllib.request as u; print(u.urlopen("http://127.0.0.1:8080/api/status").read().decode())'
  ```
- **Wi‑Fi absent** : `nmcli device` doit lister une interface `wifi` ; sinon le micrologiciel de la carte manque (`journalctl -k | grep -i firmware`), signalez le modèle (`lspci -nn`, `lsusb`).
- **Ne plus lancer l'interface sur tty1** (pour dépanner) : `mkdir -p ~/.config/orion && touch ~/.config/orion/sans-interface`, puis redémarrez ; supprimez le fichier pour revenir.
- **Clavier QWERTY au lieu d'AZERTY** : le réglage est dans `/etc/default/keyboard` (`XKBLAYOUT`).

## Fichiers de ce dossier

| Fichier | Rôle |
| --- | --- |
| `build.sh` | Construit l'ISO avec live-build (Debian 12) |
| `build-in-docker.sh`, `Dockerfile` | Même chose dans un conteneur Debian 12 |
| `run-vm.sh` | Démarre l'ISO (ou un disque installé) dans QEMU |
| `boot-test.sh` | Démarre l'ISO dans QEMU sans écran et vérifie qu'orion-server démarre et que l'interface s'affiche (capture d'écran), avec une carte graphique virtio (Wayland) puis la carte standard de QEMU (secours X11) ; lancé par l'action GitHub après chaque construction |
| `config/package-lists/orion.list.chroot` | Paquets de l'image |
| `config/hooks/normal/9000-orion.hook.chroot` | Réglages appliqués dans l'image (langue, services…) |
| `config/includes.chroot/` | Fichiers copiés tels quels dans l'image (services, polkit, Chromium, kiosque…) |
| `config/includes.installer/preseed.cfg` | Réponses préenregistrées de l'installateur |
