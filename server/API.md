# Contrat de l'API matérielle d'Orion (orion-server)

Servie par `orion-server` ([`orion_server.py`](orion_server.py) et, pour la messagerie, [`orion_mail.py`](orion_mail.py) ; Python ≥ 3.11, bibliothèque standard uniquement) sur la même origine qu'Orion (http://127.0.0.1:8080), préfixe `/api/`.
Toutes les réponses sont du JSON (`Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`).
Erreurs : statut HTTP 4xx/5xx et corps `{ "error": "message en français" }`.

```bash
python3 server/orion_server.py --simulate --port 8090   # matériel simulé, pour développer dans un navigateur
python3 server/orion_server.py                          # vrai matériel (machine Orion), http://127.0.0.1:8080
python3 -m unittest discover -s server -v               # tests
```

Options : `--root DOSSIER` (dossier contenant `index.html`, par défaut la racine du dépôt ; sur une machine Orion `/var/lib/orion/current`), `--host` (défaut `127.0.0.1`), `--port` (défaut `8080`), `--simulate`, `--allow-host NOM` (nom d'hôte supplémentaire accepté dans `Host`, à n'utiliser qu'avec `--host`), `--state DOSSIER` (données gardées par le serveur : protection de l'appareil, comptes de messagerie ; défaut `/var/lib/orion`, en mémoire avec `--simulate`).

## Sécurité

- écoute sur 127.0.0.1 uniquement (option `--host` pour autre chose, déconseillée) ;
- en-tête `Host` obligatoirement `127.0.0.1:<port>` ou `localhost:<port>` (protection DNS rebinding), sinon 403 `Hôte refusé` — y compris pour les fichiers de l'interface ;
- toute requête `POST` doit porter `X-Orion: 1` et `Content-Type: application/json` (force un pré-vol CORS
  que le serveur refuse : aucun site tiers ne peut piloter le matériel), sinon 403 ;
- aucun en-tête CORS n'est jamais envoyé ; `OPTIONS` (pré-vol), `PUT`, `DELETE`… → 405 ;
- en plus : un en-tête `Origin` différent de `http://<Host>` ou un `Sec-Fetch-Site` autre que `same-origin`/`none` → 403 `Origine refusée` sur `/api/` (une page d'un autre port de 127.0.0.1 est donc refusée elle aussi) ;
- corps limité à 256 Kio (413 ; la taille d'un e-mail envoyé), JSON invalide ou non objet → 400, `Transfer-Encoding` refusé (411) ;
- les outils système sont lancés avec une liste d'arguments (jamais de shell), avec délai maximal ; adresses MAC, numéros, identifiants, SSID, APN et code PIN sont validés strictement ;
- toute réponse porte `X-Content-Type-Options: nosniff` et `Cross-Origin-Resource-Policy: same-origin`.

## Fichiers de l'interface

`GET`/`HEAD` seulement. Sont servis : `/` (→ `index.html`), `/index.html`, `/sw.js`, `/version.json`, `/manifest.webmanifest`, `/assets/**`, `/src/**`. Tout le reste → 404 (pas de liste de dossier, pas de fichier caché, pas de `..`, `%2e%2e`, `//`, `\`). La chaîne de requête est ignorée (`/?fullscreen`). Le chemin réel est vérifié : un lien symbolique qui sort de la racine ou de la liste blanche → 404. La racine est résolue à chaque requête : si elle est un lien symbolique (`/var/lib/orion/current`), une nouvelle version est servie dès que le lien change, sans redémarrage. `Cache-Control: no-cache` et `ETag` (réponse 304 si `If-None-Match` correspond). Types : `.html` `text/html; charset=utf-8`, `.js` `text/javascript; charset=utf-8`, `.css`, `.json`, `.webmanifest` `application/manifest+json`, `.svg`, `.png`, polices, sons…

## GET /api/status
```json
{ "bridge": "orion-server", "version": "1.0.0", "hostname": "orion", "simulated": false,
  "capabilities": { "wifi": true, "bluetooth": true, "modem": false, "gps": false, "power": true, "network": true,
                    "protection": true, "integrity": true, "mail": true } }
```
Une capacité est vraie si l'outil correspondant est présent et répond :
- `wifi` : nmcli présent, NetworkManager actif et au moins une carte Wi‑Fi ;
- `bluetooth` : bluetoothctl présent et un adaptateur (`bluetoothctl show`) ;
- `modem` : mmcli présent et au moins un modem (`mmcli -L`) ;
- `gps` : gpsd joignable sur 127.0.0.1:2947 **et** au moins un récepteur branché ;
- `power` : systemctl présent ;
- `network` *(ajout)* : NetworkManager utilisable (actif), même sans Wi‑Fi (machine virtuelle, câble) ;
- `protection`, `integrity` et `mail` *(ajout)* : toujours vrais (voir plus bas).

Résultat gardé 5 s. *(Ajout)* `simulated` vaut `true` avec `--simulate`.

## GET /api/network *(ajout)*
```json
{ "connectivity": "full", "primary": { "type": "wifi", "name": "Maison", "device": "wlan0", "ip": "192.168.1.23" } }
```
`connectivity` : `full` | `limited` | `portal` | `none` | `unknown` (`nmcli networking connectivity`).
`primary` : première interface connectée de `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device` (hors loopback, ponts, tunnels), `type` ∈ `wifi` | `ethernet` | `gsm` | `other`, `name` = nom de la connexion NetworkManager (pour le Wi‑Fi, en général le SSID), `ip` = IPv4 ou `null` ; `primary` vaut `null` sans connexion.
503 si NetworkManager est absent.

## Wi‑Fi (NetworkManager, nmcli)
- `GET /api/wifi` (option `?rescan=1` : nouvelle recherche avant de répondre)
```json
{ "enabled": true,
  "connected": { "ssid": "Maison", "signal": 72, "security": "WPA2", "frequency": 5180, "ip": "192.168.1.23" },
  "networks": [ { "ssid": "Maison", "signal": 72, "security": "WPA2", "frequency": 5180, "known": true, "active": true } ] }
```
  `signal` 0–100 ; `security` chaîne vide pour un réseau ouvert (sinon la valeur de nmcli : `WPA2`, `WPA1 WPA2`, `WPA3`, `WPA2 802.1X`…) ; `frequency` en MHz ; `connected` vaut `null` si non connecté ;
  réseaux triés : actif d'abord, puis par signal décroissant, SSID vides ignorés, doublons fusionnés (le point d'accès utilisé, sinon le meilleur signal). Wi‑Fi coupé : `{ "enabled": false, "connected": null, "networks": [] }`. 503 si NetworkManager est absent.
- `POST /api/wifi/power` `{ "enabled": false }` → `{ "ok": true }`
- `POST /api/wifi/connect` `{ "ssid": "Maison", "password": "…" }` (mot de passe facultatif pour un réseau connu ou ouvert)
  → `{ "ok": true }` ou 400/500 `{ "error": "Mot de passe incorrect" }` (message lisible)
  *(Ajout)* `"hidden": true` pour un réseau masqué. Un réseau connu est rejoint avec son profil enregistré (un mot de passe fourni le met à jour). Un essai raté ne laisse pas de profil derrière lui. SSID : 1 à 32 octets UTF‑8, sans caractère de contrôle.
- `POST /api/wifi/disconnect` `{}` → `{ "ok": true }`
- `POST /api/wifi/forget` `{ "ssid": "Maison" }` → `{ "ok": true }` (404 `Réseau inconnu` sans profil)

Erreurs de connexion : 400 `Mot de passe incorrect`, 400 `Mot de passe requis`, 400 `Mot de passe invalide (8 à 63 caractères)`, 404 `Réseau introuvable`, 409 `Le Wi-Fi est désactivé`, 502 `Connecté, mais aucune adresse IP obtenue (DHCP)`, 503 `Aucune carte Wi-Fi détectée`, 503 `NetworkManager n'est pas démarré`, 403 `Action refusée par le système (droits insuffisants)`, 504 `Le réseau ne répond pas (délai dépassé)`, sinon 502 `Connexion impossible : <détail>`.

## Bluetooth (BlueZ, bluetoothctl)
- `GET /api/bluetooth`
```json
{ "available": true, "powered": true, "discovering": false,
  "devices": [ { "address": "AA:BB:CC:DD:EE:FF", "name": "Écouteurs", "paired": true, "connected": false,
                 "trusted": true, "icon": "audio-headset", "battery": 80 } ] }
```
  `battery` (0–100) seulement si connu (« Battery Percentage » de BlueZ, en pratique quand l'appareil est connecté) ; `icon` = icône freedesktop de BlueZ (`audio-headset`, `audio-card`, `input-keyboard`, `input-mouse`, `phone`…) ou `""` ; `name` = alias BlueZ ; appareils appairés d'abord, puis connectés, puis par nom. Les appareils trouvés sans nom et non appairés (balises) sont ignorés. Sans adaptateur : `{ "available": false, "powered": false, "discovering": false, "devices": [] }`.
- `POST /api/bluetooth/power` `{ "enabled": true }`
- `POST /api/bluetooth/scan` `{ "seconds": 10 }` → lance la recherche pendant N s (ramené entre 1 et 30, 10 par défaut), répond tout de suite `{ "ok": true }` (409 si le Bluetooth est coupé) ; `discovering` est vrai pendant la recherche, les appareils apparaissent au fil des `GET`.
- `POST /api/bluetooth/pair` `{ "address": "…" }` (appairage + confiance), `/connect`, `/disconnect`, `/remove` → `{ "ok": true }`

Adresse : `AA:BB:CC:DD:EE:FF` (majuscules ou minuscules), sinon 400. Appairage avec l'agent « NoInputNoOutput » : fonctionne pour les casques, enceintes, souris, manettes ; les claviers qui demandent un code ne sont pas encore pris en charge. Erreurs : 404 `Appareil introuvable : relancez la recherche`, 400 `Appareil non appairé` (simulation), 400 `Appairage refusé par l'appareil`, 409 `Le Bluetooth est désactivé`, 409 `Bluetooth bloqué par le système (rfkill)`, 502 `Aucun profil compatible avec cet appareil`, 504 `L'appareil ne répond pas (est-il allumé et à portée ?)`, 503 `Aucun adaptateur Bluetooth`.

## Réseau mobile (ModemManager, mmcli)
- `GET /api/modem`
```json
{ "available": true, "state": "connected", "operator": "Orange F", "signal": 64, "technology": "lte",
  "sim": true, "number": "+33612345678", "registration": "home", "enabled": true, "data": true }
```
  `available:false` (et rien d'autre) sans modem.
  `state` : état ModemManager (`failed`, `locked`, `disabled`, `enabling`, `enabled`, `searching`, `registered`, `connecting`, `connected`…) ; `technology` : la meilleure technologie d'accès (`5gnr`, `lte`, `umts`, `hspa`, `edge`, `gprs`…) ou `null` ; `operator`, `number` : `null` si inconnus ; `registration` : `home`, `roaming`, `searching`, `denied`, `idle`, `unknown`…
  *(Ajouts)* `enabled` : le modem n'est ni `disabled`/`disabling`, ni `failed`, ni `locked` (code PIN attendu), ni `unknown` ; `data` : une connexion NetworkManager de type `gsm` est active.
- `POST /api/modem/power` `{ "enabled": true }` *(ajout)* → `mmcli -m N --enable` / `--disable` → `{ "ok": true }`
- `POST /api/modem/data` `{ "enabled": true, "apn": "free" }` *(ajout)* → `{ "ok": true }`. Active : la première connexion `gsm` de NetworkManager est démarrée (et passe en connexion automatique) ; s'il n'y en a pas, `nmcli connection add type gsm ifname '*' con-name orion-mobile` la crée. `apn` facultatif (`^[A-Za-z0-9._-]{0,64}$`) : sans APN, ModemManager utilise le réglage de l'opérateur. Désactive : connexion arrêtée, connexion automatique coupée.
- `POST /api/modem/pin` `{ "pin": "1234" }` *(ajout)* → déverrouille la carte SIM (`mmcli -i <sim> --pin=…`) puis active le modem. 400 `Code PIN incorrect`, 403 `Carte SIM bloquée : code PUK nécessaire`.
- `POST /api/modem/call` `{ "number": "+33…" }` → `{ "ok": true, "id": "0" }` ; `POST /api/modem/hangup` `{}` (tous les appels) ou *(ajout)* `{ "id": "3" }` (cet appel)
- `GET /api/modem/calls` *(ajout)* → `mmcli -m N --voice-list-calls` + `mmcli -o <appel> -J`
```json
{ "calls": [ { "id": "3", "number": "+33612345678", "direction": "incoming", "state": "ringing" } ] }
```
  `direction` : `incoming` | `outgoing` ; `state` : `ringing` (ModemManager `ringing-in`, `waiting`), `dialing` (`dialing`, `ringing-out`), `active`, `held`, `terminated` (`terminated`, `unknown`). Un appel terminé reste listé 30 s puis est effacé du modem. Sans modem : `{ "calls": [] }`.
- `POST /api/modem/answer` `{ "id": "3" }` *(ajout)* → `mmcli -o 3 --accept` → `{ "ok": true }`
- `POST /api/modem/sms` `{ "number": "+33…", "text": "…" }` → `{ "ok": true }` (texte de 1 à 1000 caractères, découpé en plusieurs SMS par ModemManager si besoin)
- `GET /api/modem/sms` → `{ "messages": [ { "id": "3", "number": "+33…", "text": "…", "timestamp": "2026-10-22T10:00:00+02:00", "state": "received" } ] }`
  Messages du modem par identifiant croissant (200 au plus). `state` : `received`, `sent`, `stored`, `receiving`, `sending`, `unknown`. `timestamp` vaut `null` quand le réseau n'en donne pas (SMS envoyés).
- `POST /api/modem/sms/delete` `{ "id": "3" }` *(ajout)* → supprime le SMS du modem.

Numéros : espaces, points, tirets et parenthèses sont retirés, puis le numéro doit vérifier `^\+?[0-9*#]{1,20}$`, sinon 400. Identifiants d'appel et de SMS : `^[0-9]{1,6}$` (chaîne ou entier). Le texte d'un SMS est passé à mmcli entre guillemets simples, ou doubles s'il contient une apostrophe ; s'il contient les deux, l'apostrophe droite `'` est remplacée par `’` (mmcli n'a pas d'échappement). Erreurs : 503 `Aucun modem détecté`, 503 `ModemManager n'est pas démarré`, 409 `Aucune carte SIM`, 409 `Carte SIM verrouillée : saisissez le code PIN`, 409 `Le modem n'est pas prêt (réseau non disponible)`, 403 droits insuffisants, 504 délai dépassé, sinon 502 avec le détail.

## GPS (gpsd)
- `GET /api/gps`
```json
{ "available": true, "fix": { "lat": 48.8566, "lon": 2.3522, "alt": 35.0, "speed": 0.4, "heading": 120.0,
  "accuracy": 8.0, "time": "2026-10-22T10:00:00Z", "satellites": 9 } }
```
  `fix` vaut `null` tant qu'il n'y a pas de position (mode < 2). `speed` en m/s, `heading` en degrés, `accuracy` en mètres.
  Interroge gpsd directement en TCP sur 127.0.0.1:2947 (`?WATCH={"enable":true,"json":true}` puis `?POLL;`, 2 s au plus, résultat gardé 1 s ; pas besoin de gpspipe). `alt` : altitude au-dessus du niveau de la mer (`altMSL`, sinon `alt`/`altHAE`) ; `accuracy` : `eph`, sinon le plus grand de `epx`/`epy` ; `satellites` : satellites utilisés (`uSat` du message SKY) ; chacun peut valoir `null` s'il est inconnu. `available` est faux si gpsd ne répond pas ou si aucun récepteur n'est branché (`{ "available": false, "fix": null }`).

## Alimentation (systemd / logind)
- `POST /api/system/reboot` `{}` et `POST /api/system/poweroff` `{}` → `{ "ok": true }` (exécuté 1 s après la réponse, par `systemctl reboot|poweroff` ; l'utilisateur `orion` y est autorisé par une règle polkit)

## Protection de l'appareil *(ajout)*

Protection contre la réinitialisation : l'empreinte du code de verrouillage du propriétaire (sel + SHA-256 de `sel:code`, comme `hashPasscode()` de l'interface) est gardée dans `--state`/`protection.json` (droits 0600), hors des données de l'interface : elle survit à l'effacement d'Orion et du profil du navigateur. **L'empreinte n'est jamais renvoyée** ; le code est vérifié ici, et les essais sont limités (après 5 erreurs, attente de 30 s doublée à chaque erreur, 1 h au plus, conservée sur le disque).

- `GET /api/protection` → `{ "enabled": true, "owner": { "name": "Camille", "email": "c@exemple.fr" }, "since": 1792749951916, "wait": 0 }` ou `{ "enabled": false, "wait": 0 }` (`wait` : secondes avant un nouvel essai) ;
- `POST /api/protection/enable` `{ "record": { "salt": "<hex>", "hash": "<sha256>", "length": 4 }, "owner": { "name": "…", "email": "…" } }` → état public ; 409 si déjà activée (la remplacer demande le code) ;
- `POST /api/protection/verify` `{ "code": "1234" }` → `{ "ok": true }` ; 403 `Code incorrect` ; 429 `Trop d'essais : réessayez dans N s` ;
- `POST /api/protection/disable` `{ "code": "1234" }` → `{ "ok": true }` (même contrôle que `verify`, puis le fichier est supprimé) ;
- `POST /api/protection/update` `{ "code": "<ancien>", "record": { … } }` → état public (le propriétaire a changé de code).

Codes : 4 à 8 chiffres ; `salt` : 8 à 64 caractères hexadécimaux ; `length` : 4 à 8.

## GET /api/integrity *(ajout)*

Compare les fichiers de l'interface servie (`--root`) à `version.json` (taille et SHA-256) :
```json
{ "status": "altered", "version": "0.1", "checked": 122, "altered": ["./src/main.js"], "missing": [] }
```
`status` : `ok` ou `altered` (100 chemins au plus par liste). 500 si `version.json` est illisible.

## Messagerie *(ajout)*

Un navigateur ne peut pas ouvrir de connexion IMAP ou SMTP : orion-server relève et envoie le courrier des comptes que l'utilisateur ajoute dans **Réglages → Comptes de messagerie** ([`orion_mail.py`](orion_mail.py) : `imaplib`, `smtplib`, `email`).

- **Identifiants** : gardés dans `--state`/`mail.json` (droits 0600, lisible seulement par l'utilisateur du service et root), comme le ferait un logiciel de messagerie sans mot de passe principal. **Le mot de passe n'est jamais renvoyé.** Un compte n'est enregistré qu'après une connexion réussie aux deux serveurs.
- **Chiffrement** : `ssl` (TLS dès la connexion, ports 993/465) ou `starttls` (143/587) ; certificats et nom du serveur toujours vérifiés. `none` (sans chiffrement) n'est accepté que pour un serveur sur la machine (127.0.0.1, `::1`, `localhost` : passerelle locale comme Proton Mail Bridge, dont le certificat auto-signé est alors accepté).
- **Lecture** : `BODY.PEEK` (lire ne marque pas comme lu : c'est l'interface qui le demande) ; le texte est extrait de la partie `text/plain`, sinon le HTML est **converti en texte** (scripts, styles et images retirés, adresse des liens ajoutée) : aucun HTML n'est renvoyé à l'interface. Pièces jointes : nom, type et taille (pas encore de téléchargement). 25 Mo au plus par message.
- **Connexion IMAP** gardée par compte (90 s après la dernière requête) et vérifiée par `NOOP` avant d'être réutilisée ; une requête à la fois par compte.
- Identifiants accentués : `AUTHENTICATE PLAIN` / `AUTH PLAIN` en UTF-8.

Les comptes portent un `owner` (identifiant du compte Orion qui l'a ajouté) : l'interface ne montre à chaque utilisateur d'Orion que ses comptes (les comptes sans `owner`, à tous).

- `GET /api/mail?owner=<id>` → `{ "available": true, "simulated": false, "accounts": [ { "id": "3f9c…", "owner": "<id>", "name": "Camille Martin", "address": "camille@free.fr", "username": "camille@free.fr", "imap": { "host": "imap.free.fr", "port": 993, "security": "ssl" }, "smtp": { "host": "smtp.free.fr", "port": 465, "security": "ssl" }, "saveSent": true, "createdAt": 1792749951916 } ] }` ;
- `POST /api/mail/autoconfig` `{ "address": "camille@free.fr" }` → `{ "source": "known", "username": "…", "imap": {…}, "smtp": {…}, "saveSent": true, "note": "" }` : fournisseurs courants (`known` : Gmail, Outlook/Hotmail, Yahoo, iCloud, Orange, Free, SFR, La Poste, Fastmail), sinon la base de Thunderbird (`ispdb`, `autoconfig.thunderbird.net`), sinon `imap.`/`smtp.<domaine>` (`guess`). `note` : conseil (mot de passe d'application de Gmail, d'iCloud…) ;
- `POST /api/mail/accounts/add` `{ "owner", "name", "address", "username" (défaut : l'adresse), "password", "imap": { "host", "port", "security" }, "smtp": {…}, "saveSent": true }` → le compte (sans mot de passe) ; 401 identifiants refusés (avec un conseil pour Gmail, iCloud…), 502/504 serveur introuvable, injoignable, certificat invalide, 409 compte déjà ajouté ;
- `POST /api/mail/accounts/remove` `{ "id" }` → `{ "ok": true }` ;
- `GET /api/mail/folders?account=<id>` → `{ "folders": [ { "id": "INBOX", "name": "Réception", "role": "inbox", "unread": 3, "total": 120 }, { "id": "Sent", "name": "Envoyés", "role": "sent", … }, { "id": "Reçus/Factures", "name": "Reçus › Factures", "role": null, "unread": null, "total": null } ] }` : `id` = nom IMAP (décodé de l'UTF-7 modifié), `role` ∈ `inbox` `sent` `drafts` `trash` `junk` `archive` `all` (attributs RFC 6154, sinon reconnu au nom : « Sent », « Éléments envoyés », « Corbeille »…), compteurs pour Réception et les dossiers à rôle ; les dossiers `\Noselect` sont omis ;
- `GET /api/mail/messages?account=&folder=&limit=40&before=<uid>&q=<texte>&filter=unread|flagged` → `{ "messages": [ { "uid": 42, "from": { "name", "address" }, "to": […], "cc": […], "subject", "date": <ms>, "seen", "flagged", "answered", "size", "attachments": <booléen>, "preview": "…" } ], "more": true, "uidValidity": 7 }` : du plus récent au plus ancien, `before` pour la page suivante, `q` : recherche `TEXT` du serveur (UTF-8), 100 messages au plus par page ;
- `GET /api/mail/message?account=&folder=&uid=` → résumé + `"text"`, `"html"` (le texte venait du HTML), `"truncated"`, `"attachments": [ { "name", "type", "size" } ]`, `"replyTo"`, `"messageId"`, `"references"` ; 404 si le message a été déplacé ;
- `POST /api/mail/flags` `{ "account", "folder", "uids": [42], "add": ["seen"], "remove": ["flagged"] }` (drapeaux `seen`, `flagged`, `answered`) ;
- `POST /api/mail/move` `{ "account", "folder", "uids", "to": "archive" | "<dossier>" }` → `{ "ok": true, "folder": "Archive" }` (`UID MOVE`, sinon `COPY` + `\Deleted` + `EXPUNGE`) ;
- `POST /api/mail/delete` `{ "account", "folder", "uids" }` → vers la corbeille (`"folder": "Trash"`) ; définitivement (`"folder": null`) si le message y est déjà ou sans corbeille ;
- `POST /api/mail/send` `{ "account", "to": [ { "name", "address" } | "adresse" ], "cc", "bcc", "subject", "text", "inReplyTo": "<id@…>", "references": "…" }` → `{ "ok": true, "messageId": "<…>", "refused": [], "savedTo": "Sent" }` : texte brut UTF-8, `Bcc` jamais transmis aux destinataires, en-têtes nettoyés (pas de retour à la ligne dans l'objet), 100 destinataires et 100 000 caractères au plus ; copie dans « Envoyés » si `saveSent` (Gmail et Outlook la font eux-mêmes : désactivée par défaut). 400 destinataire refusé par le serveur.

## Mode simulé (`--simulate`)

Tout le matériel est imité en mémoire, avec un état qui évolue, pour développer l'interface dans un navigateur ordinaire :
- **Wi‑Fi** : « Orion Box » (WPA2, connu, connecté au départ), « Livebox-7A3F » (WPA2), « Café de la Gare » (ouvert), « Bureau Orion 5G » (WPA3), « Freebox du voisin » (WPA1 WPA2) ; le mot de passe de tous les réseaux protégés est **`orion1234`** ; connexion, déconnexion, oubli et coupure changent vraiment l'état ; le signal varie de ±3 ; IP `192.168.1.42`.
- **Bluetooth** : « Écouteurs Orion » (casque, batterie 80 % une fois connecté) et « Clavier Orion » déjà appairés ; une recherche fait apparaître « Enceinte du salon », « Souris sans fil » (batterie 55 %), « Téléphone de Léa » et « Montre connectée » (un toutes les 0,6 s) ; appairer, connecter, déconnecter, oublier fonctionnent (connecter un appareil non appairé → 400).
- **Modem** : opérateur « Orion Mobile », LTE, signal ≈ 68, numéro `+33612345678`, carte SIM présente, données mobiles actives ; `power` et `data` changent l'état. Un appel sortant passe de `dialing` à `active` après 3 s ; les SMS envoyés sont gardés, et une réponse « Bien reçu : « … » » arrive du même numéro 3 s plus tard.
- **GPS** : promenade à pied (1,4 m/s) sur un cercle de 220 m autour de l'île de la Cité à Paris, 8 à 11 satellites, précision 3 à 7 m.
- **Réseau** (`/api/network`) : `wifi` si le Wi‑Fi simulé est connecté, sinon `gsm` si les données mobiles sont actives, sinon `{ "connectivity": "none", "primary": null }`.
- **Alimentation** : la demande est seulement écrite dans le journal.
- **Messagerie** : tout mot de passe est accepté sauf `faux` (401), un serveur `introuvable.…` donne 502 ; chaque compte a ses dossiers en mémoire (Réception, Envoyés, Brouillons, Corbeille, Indésirables, Archives, Factures) et quelques messages, dont un en HTML ; un message envoyé va dans Envoyés, et dans Réception s'il vous est adressé. Rien ne part sur Internet (l'autoconfiguration n'interroge pas Thunderbird).
- `/api/status` indique `"simulated": true`.

Points d'accès de test, **uniquement avec `--simulate`** (404 sinon) :
- `POST /api/simulate/incoming-call` `{ "number": "+33…" }` → `{ "ok": true, "id": "4" }` : un appel entrant sonne (`ringing`, manqué au bout de 30 s) ;
- `POST /api/simulate/incoming-sms` `{ "number": "+33…", "text": "…" }` → `{ "ok": true }` : un SMS est reçu ;
- `POST /api/simulate/incoming-mail` `{ "account" (défaut : le premier), "from": "lucas@exemple.fr", "name": "Lucas", "subject": "…", "text": "…" }` → `{ "ok": true, "uid": 9 }` : un e-mail arrive dans Réception.

## Mises à jour d'une machine installée (`sync`)

```bash
python3 orion_server.py sync --source https://91val91.github.io/os/ --data /var/lib/orion [--allow-downgrade]
```

1. télécharge `version.json` (contourne les caches), le valide : numéro de version sûr, chemins uniquement `./index.html`, `./manifest.webmanifest`, `./sw.js`, `./assets/…`, `./src/…` (segments `[A-Za-z0-9_][A-Za-z0-9._@+-]*`, ni `..` ni fichier caché), empreintes SHA‑256, tailles, 512 Mio au plus ;
2. ne fait rien si la version installée est identique, ni si la version publiée est plus ancienne (sauf `--allow-downgrade`) ;
3. construit la nouvelle version dans un dossier temporaire de `releases/` : chaque fichier dont l'empreinte existe déjà dans la version actuelle (vérifiée sur le disque) est copié, les autres sont téléchargés ; **chaque fichier est vérifié (taille et SHA‑256)** ; `sw.js`, absent de `version.json`, est téléchargé à part ; `version.json` est écrit tel que reçu ;
4. renomme le dossier en `releases/<version>` (ou `<version>-<empreinte>` si ce numéro est déjà celui en service) puis remplace atomiquement le lien `current` ;
5. garde la version précédente, efface les plus anciennes.

Au moindre problème (fichier altéré, réseau, chemin refusé), le dossier temporaire est supprimé et `current` ne change pas ; code de sortie 1. Un verrou empêche deux synchronisations simultanées. Le serveur résolvant `current` à chaque requête, l'interface voit aussitôt le nouveau `version.json` et propose la mise à jour dans **Réglages → Général → Mise à jour logicielle**, comme sur le Web.
