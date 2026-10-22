#!/usr/bin/env python3
"""orion-server : serveur de l'interface d'Orion OS et pont vers le matériel.

Sur une machine Orion (image installable, voir installer/), ce programme :

* sert les fichiers de l'interface (index.html, sw.js, version.json,
  manifest.webmanifest, assets/, src/) sur http://127.0.0.1:8080 ;
* expose sous /api/ le Wi-Fi (NetworkManager), le Bluetooth (BlueZ), le
  réseau mobile (ModemManager), le GPS (gpsd) et l'alimentation (systemd),
  selon le contrat décrit dans server/API.md ;
* avec --simulate, imite tout ce matériel en mémoire pour développer et
  tester l'interface dans un navigateur ordinaire ;
* avec la sous-commande « sync », télécharge et vérifie la dernière version
  publiée d'Orion pour une machine installée (mises à jour).

Usage :
    python3 orion_server.py [--root DOSSIER] [--host 127.0.0.1] [--port 8080] [--simulate]
    python3 orion_server.py sync --source https://91val91.github.io/os/ --data /var/lib/orion

Python 3.11 ou plus récent, bibliothèque standard uniquement.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.client
import json
import logging
import math
import os
import random
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

BRIDGE_NAME = "orion-server"
BRIDGE_VERSION = "1.0.0"

DEFAULT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = "https://91val91.github.io/os/"
DEFAULT_DATA = "/var/lib/orion"

LOG = logging.getLogger(BRIDGE_NAME)

# --------------------------------------------------------------------------
# Fichiers servis
# --------------------------------------------------------------------------

# Seuls ces fichiers et dossiers de la racine sont servis (liste blanche).
STATIC_FILES = frozenset({"index.html", "sw.js", "version.json", "manifest.webmanifest"})
STATIC_DIRS = frozenset({"assets", "src"})

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".txt": "text/plain; charset=utf-8",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".wasm": "application/wasm",
}

MAX_BODY = 64 * 1024  # taille maximale du corps d'une requête POST


def static_parts(url_path: str) -> list[str] | None:
    """Découpe le chemin d'une URL en segments sûrs, ou None s'il est refusé.

    Refuse les « .. », « . », segments vides (« // », barre finale), fichiers
    cachés, barres obliques inverses, octets nuls, UTF-8 invalide et tout ce
    qui n'est pas dans la liste blanche.
    """
    try:
        decoded = urllib.parse.unquote(url_path, errors="strict")
    except UnicodeDecodeError:
        return None
    if decoded in ("", "/"):
        return ["index.html"]
    if not decoded.startswith("/") or "\x00" in decoded or "\\" in decoded:
        return None
    parts = decoded[1:].split("/")
    return parts if allowed_parts(parts) else None


def allowed_parts(parts: list[str]) -> bool:
    if not parts or any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return False
    if len(parts) == 1:
        return parts[0] in STATIC_FILES
    return parts[0] in STATIC_DIRS


def resolve_static(root: str | os.PathLike[str], parts: list[str]) -> str | None:
    """Chemin réel du fichier demandé, ou None s'il sort de la racine.

    La racine est résolue à chaque appel : si elle est un lien symbolique
    (/var/lib/orion/current), une nouvelle version devient servie dès que le
    lien change, sans redémarrer. Les liens symboliques qui pointent hors de
    la racine, ou hors de la liste blanche, sont refusés.
    """
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, *parts))
    if not target.startswith(base.rstrip(os.sep) + os.sep):
        return None
    if not allowed_parts(os.path.relpath(target, base).split(os.sep)):
        return None
    return target


# --------------------------------------------------------------------------
# Erreurs, validation
# --------------------------------------------------------------------------


class ApiError(Exception):
    """Erreur renvoyée au client : statut HTTP et message en français."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
MAC_RE = re.compile(r"[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}")
PHONE_RE = re.compile(r"\+?[0-9*#]{1,20}")
PHONE_SEPARATORS_RE = re.compile(r"[ .\-()]")
ID_RE = re.compile(r"[0-9]{1,6}")
PIN_RE = re.compile(r"[0-9]{4,8}")
APN_RE = re.compile(r"[A-Za-z0-9._-]{0,64}")
OK = {"ok": True}


def get_bool(body: dict, key: str) -> bool:
    value = body.get(key)
    if not isinstance(value, bool):
        raise ApiError(400, f"Paramètre « {key} » manquant ou invalide (true ou false attendu)")
    return value


def get_str(body: dict, key: str, *, required: bool = True, max_len: int = 256) -> str | None:
    value = body.get(key)
    if value is None or (value == "" and not required):
        if required:
            raise ApiError(400, f"Paramètre « {key} » manquant")
        return None
    if not isinstance(value, str) or len(value) > max_len or "\x00" in value:
        raise ApiError(400, f"Paramètre « {key} » invalide")
    return value


def valid_mac(body: dict) -> str:
    value = get_str(body, "address", max_len=17)
    if not MAC_RE.fullmatch(value):
        raise ApiError(400, "Adresse Bluetooth invalide (format AA:BB:CC:DD:EE:FF attendu)")
    return value.upper()


def valid_phone(body: dict) -> str:
    value = get_str(body, "number", max_len=40)
    number = PHONE_SEPARATORS_RE.sub("", value)
    if not PHONE_RE.fullmatch(number):
        raise ApiError(400, "Numéro de téléphone invalide")
    return number


def valid_id(body: dict, *, required: bool = True) -> str | None:
    value = body.get("id")
    if value is None and not required:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ApiError(400, "Identifiant invalide")
    return value


def valid_ssid(body: dict) -> str:
    value = get_str(body, "ssid", max_len=64)
    if not 1 <= len(value.encode("utf-8")) <= 32 or CONTROL_RE.search(value):
        raise ApiError(400, "Nom de réseau (SSID) invalide")
    return value


def valid_password(body: dict) -> str | None:
    value = get_str(body, "password", required=False, max_len=64)
    if value is not None and CONTROL_RE.search(value):
        raise ApiError(400, "Mot de passe invalide")
    return value


def clean(value: Any) -> str:
    """Valeur texte de mmcli/nmcli : « -- » signifie « vide »."""
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text == "--" else text


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value).strip().split()[0])
    except (ValueError, IndexError):
        return default


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def network_sort_key(net: dict) -> tuple:
    return (not net["active"], -net["signal"], net["ssid"].lower())


def bt_sort_key(dev: dict) -> tuple:
    return (not dev["paired"], not dev["connected"], dev["name"].lower(), dev["address"])


# --------------------------------------------------------------------------
# Exécution des outils système
# --------------------------------------------------------------------------


@dataclass
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    @property
    def output(self) -> str:
        return f"{self.stdout}\n{self.stderr}".strip()


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


class CommandRunner:
    """Lance nmcli, bluetoothctl, mmcli, systemctl… avec une liste d'arguments.

    Jamais de shell : chaque argument (SSID, mot de passe, texte d'un SMS) est
    transmis tel quel au programme. Les messages sont forcés en anglais (pour
    pouvoir les analyser) mais en UTF-8 (SSID accentués). Les tests
    remplacent cette classe par un faux qui renvoie des sorties enregistrées.
    """

    def __init__(self) -> None:
        env = dict(os.environ)
        env.update({"LC_ALL": "C.UTF-8", "LANG": "C.UTF-8", "LANGUAGE": "", "NO_COLOR": "1", "TERM": "dumb"})
        self.env = env

    def which(self, name: str) -> bool:
        return shutil.which(name) is not None

    def run(self, args: list[str], timeout: float = 10.0) -> CommandResult:
        if not args or not all(isinstance(a, str) for a in args):
            raise TypeError("arguments invalides")
        try:
            proc = subprocess.run(
                list(args),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                env=self.env,
                check=False,
            )
        except FileNotFoundError:
            return CommandResult(127, "", f"{args[0]}: commande introuvable")
        except subprocess.TimeoutExpired as exc:
            return CommandResult(124, _text(exc.stdout), _text(exc.stderr) + "\nTimeout expired")
        except OSError as exc:
            return CommandResult(126, "", str(exc))
        return CommandResult(proc.returncode, proc.stdout or "", proc.stderr or "")


def first_error_line(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for line in lines:
        if re.search(r"error|failed|couldn't|cannot|not ", line, re.IGNORECASE):
            return line[:200]
    return lines[0][:200] if lines else ""


def with_detail(message: str, output: str) -> str:
    detail = first_error_line(output)
    return f"{message} : {detail}" if detail else message


# --------------------------------------------------------------------------
# Wi-Fi et réseau (NetworkManager, nmcli)
# --------------------------------------------------------------------------


def split_terse(line: str) -> list[str]:
    """Découpe une ligne « nmcli -t » : « : » sépare, « \\: » et « \\\\ » sont échappés."""
    fields: list[str] = []
    current: list[str] = []
    i = 0
    while i < len(line):
        char = line[i]
        if char == "\\" and i + 1 < len(line):
            current.append(line[i + 1])
            i += 2
            continue
        if char == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
        i += 1
    fields.append("".join(current))
    return fields


def unescape_terse(value: str) -> str:
    return re.sub(r"\\(.)", r"\1", value)


def parse_wifi_list(output: str, known: dict[str, list[str]]) -> list[dict]:
    """Réseaux de « nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY,FREQ device wifi list ».

    SSID vides (réseaux masqués) ignorés ; un même SSID vu sur plusieurs points
    d'accès est fusionné (celui en cours d'utilisation, sinon le meilleur signal).
    """
    networks: dict[str, dict] = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = split_terse(line)
        if len(fields) < 5:
            continue
        in_use, ssid, signal, security, freq = fields[:5]
        if not ssid or ssid == "--":
            continue
        entry = {
            "ssid": ssid,
            "signal": max(0, min(100, as_int(signal))),
            "security": clean(security),
            "frequency": as_int(freq),
            "known": ssid in known,
            "active": in_use.strip() == "*",
        }
        previous = networks.get(ssid)
        if previous is None:
            networks[ssid] = entry
            continue
        better = (entry["active"] and not previous["active"]) or (
            entry["active"] == previous["active"] and entry["signal"] > previous["signal"]
        )
        if better:
            entry["active"] = entry["active"] or previous["active"]
            networks[ssid] = entry
    return sorted(networks.values(), key=network_sort_key)


def nm_error(res: CommandResult, message: str = "NetworkManager a refusé l'opération") -> ApiError:
    low = res.output.lower()
    if res.returncode == 127:
        return ApiError(503, "Wi-Fi indisponible : NetworkManager (nmcli) n'est pas installé")
    if "networkmanager is not running" in low or "could not create nmclient" in low:
        return ApiError(503, "NetworkManager n'est pas démarré")
    if "not authorized" in low or "insufficient privileges" in low or "not allowed" in low:
        return ApiError(403, "Action refusée par le système (droits insuffisants)")
    if res.returncode == 124 or "timeout expired" in low:
        return ApiError(504, "Le réseau ne répond pas (délai dépassé)")
    return ApiError(502, with_detail(message, res.output))


def nm_connect_error(res: CommandResult, password_given: bool) -> ApiError:
    low = res.output.lower()
    if "psk: property is invalid" in low or "802-11-wireless-security.psk" in low and "invalid" in low:
        return ApiError(400, "Mot de passe invalide (8 à 63 caractères)")
    if "secrets were required" in low or "no secrets" in low or "(7)" in low:
        return ApiError(400, "Mot de passe incorrect" if password_given else "Mot de passe requis")
    if "no network with ssid" in low or "could not be found" in low or "(53)" in low:
        return ApiError(404, "Réseau introuvable")
    if "no wi-fi device" in low or "no suitable device" in low:
        return ApiError(503, "Aucune carte Wi-Fi détectée")
    if "ip configuration could not be reserved" in low or "(5)" in low:
        return ApiError(502, "Connecté, mais aucune adresse IP obtenue (DHCP)")
    error = nm_error(res, "Connexion impossible")
    return error


class NetworkManagerBackend:
    WIFI_TYPES = ("802-11-wireless", "wifi")
    GSM_TYPES = ("gsm",)
    MOBILE_PROFILE = "orion-mobile"

    def __init__(self, runner: CommandRunner):
        self.runner = runner
        self._ssid_cache: dict[str, str] = {}
        self._lock = threading.Lock()

    def nmcli(self, *args: str, timeout: float = 15.0) -> CommandResult:
        return self.runner.run(["nmcli", *args], timeout=timeout)

    # --- état général ---------------------------------------------------

    def present(self) -> bool:
        return self.runner.which("nmcli")

    def running(self) -> bool:
        if not self.present():
            return False
        res = self.nmcli("-t", "-f", "RUNNING", "general", timeout=5)
        return res.ok and res.stdout.strip() == "running"

    def devices(self) -> list[dict]:
        res = self.nmcli("-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", timeout=8)
        if not res.ok:
            raise nm_error(res)
        devices = []
        for line in res.stdout.splitlines():
            if not line.strip():
                continue
            fields = split_terse(line)
            if len(fields) >= 4:
                devices.append({"device": fields[0], "type": fields[1], "state": fields[2], "connection": clean(fields[3])})
        return devices

    def wifi_available(self) -> bool:
        try:
            return self.running() and any(d["type"] == "wifi" for d in self.devices())
        except ApiError:
            return False

    def device_ip(self, device: str) -> str | None:
        res = self.nmcli("-t", "-f", "IP4.ADDRESS", "device", "show", device, timeout=8)
        if not res.ok:
            return None
        for line in res.stdout.splitlines():
            fields = split_terse(line)
            if len(fields) >= 2 and fields[0].startswith("IP4.ADDRESS") and fields[1]:
                return fields[1].split("/")[0]
        return None

    def network_state(self) -> dict:
        if not self.present():
            raise ApiError(503, "NetworkManager (nmcli) n'est pas installé")
        res = self.nmcli("networking", "connectivity", timeout=8)
        if not res.ok:
            raise nm_error(res)
        connectivity = res.stdout.strip() or "unknown"
        if connectivity not in ("full", "limited", "portal", "none", "unknown"):
            connectivity = "unknown"
        primary = None
        for dev in self.devices():
            if dev["state"] != "connected" or dev["type"] in ("loopback", "bridge", "tun", "wifi-p2p"):
                continue
            kind = dev["type"] if dev["type"] in ("wifi", "ethernet", "gsm") else "other"
            primary = {"type": kind, "name": dev["connection"], "device": dev["device"], "ip": self.device_ip(dev["device"])}
            break
        return {"connectivity": connectivity, "primary": primary}

    # --- profils ---------------------------------------------------------

    def profiles(self, types: tuple[str, ...]) -> list[tuple[str, str]]:
        """(uuid, nom) des profils enregistrés de ces types."""
        res = self.nmcli("-t", "-f", "NAME,UUID,TYPE", "connection", "show", timeout=8)
        if not res.ok:
            raise nm_error(res)
        found = []
        for line in res.stdout.splitlines():
            fields = split_terse(line)
            if len(fields) >= 3 and fields[2] in types:
                found.append((fields[1], fields[0]))
        return found

    def known_wifi(self) -> dict[str, list[str]]:
        """SSID → uuids des profils Wi-Fi enregistrés."""
        with self._lock:
            cache = dict(self._ssid_cache)
        fresh: dict[str, str] = {}
        known: dict[str, list[str]] = {}
        for uuid, name in self.profiles(self.WIFI_TYPES):
            ssid = cache.get(uuid)
            if ssid is None:
                res = self.nmcli("-t", "-g", "802-11-wireless.ssid", "connection", "show", "uuid", uuid, timeout=8)
                ssid = unescape_terse(res.stdout.rstrip("\r\n")) if res.ok and res.stdout.strip() else name
            fresh[uuid] = ssid
            known.setdefault(ssid, []).append(uuid)
        with self._lock:
            self._ssid_cache = fresh
        return known

    def active_types(self) -> set[str]:
        res = self.nmcli("-t", "-f", "TYPE,STATE", "connection", "show", "--active", timeout=8)
        if not res.ok:
            return set()
        types = set()
        for line in res.stdout.splitlines():
            fields = split_terse(line)
            if len(fields) >= 2 and fields[1] == "activated":
                types.add(fields[0])
        return types

    # --- Wi-Fi -----------------------------------------------------------

    def wifi_enabled(self) -> bool:
        if not self.present():
            raise ApiError(503, "Wi-Fi indisponible : NetworkManager (nmcli) n'est pas installé")
        res = self.nmcli("radio", "wifi", timeout=5)
        if not res.ok:
            raise nm_error(res)
        return res.stdout.strip() == "enabled"

    def _scan(self, rescan: bool) -> str:
        args = ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY,FREQ", "device", "wifi", "list", "--rescan"]
        res = self.nmcli(*args, "yes" if rescan else "no", timeout=30)
        if not res.ok and rescan:
            # NetworkManager refuse les recherches trop rapprochées : liste actuelle.
            res = self.nmcli(*args, "no", timeout=15)
        if not res.ok:
            raise nm_error(res, "Recherche des réseaux impossible")
        return res.stdout

    def wifi_state(self, rescan: bool = False) -> dict:
        if not self.wifi_enabled():
            return {"enabled": False, "connected": None, "networks": []}
        output = self._scan(rescan)
        networks = parse_wifi_list(output, self.known_wifi())
        connected = None
        active = next((n for n in networks if n["active"]), None)
        if active:
            ip = None
            for dev in self.devices():
                if dev["type"] == "wifi" and dev["state"] == "connected":
                    ip = self.device_ip(dev["device"])
                    break
            connected = {key: active[key] for key in ("ssid", "signal", "security", "frequency")}
            connected["ip"] = ip
        return {"enabled": True, "connected": connected, "networks": networks}

    def wifi_power(self, enabled: bool) -> None:
        res = self.nmcli("radio", "wifi", "on" if enabled else "off", timeout=10)
        if not res.ok:
            raise nm_error(res)

    def wifi_connect(self, ssid: str, password: str | None, hidden: bool = False) -> None:
        if not self.wifi_enabled():
            raise ApiError(409, "Le Wi-Fi est désactivé")
        uuids = self.known_wifi().get(ssid, [])
        if uuids:
            if password:
                # Réseau connu, nouveau mot de passe : le profil est mis à jour.
                mod = self.nmcli("connection", "modify", "uuid", uuids[0], "802-11-wireless-security.psk", password, timeout=10)
                if not mod.ok:
                    raise nm_connect_error(mod, password_given=True)
            res = self.nmcli("--wait", "45", "connection", "up", "uuid", uuids[0], timeout=60)
            if not res.ok:
                raise nm_connect_error(res, password_given=bool(password))
            return
        if not password and not hidden:
            listed = next((n for n in parse_wifi_list(self._scan(False), {}) if n["ssid"] == ssid), None)
            if listed is not None and listed["security"]:
                raise ApiError(400, "Mot de passe requis")
        before = {uuid for uuid, _ in self.profiles(self.WIFI_TYPES)}
        args = ["--wait", "45", "device", "wifi", "connect", ssid]
        if password:
            args += ["password", password]
        if hidden:
            args += ["hidden", "yes"]
        res = self.nmcli(*args, timeout=60)
        if not res.ok:
            # Ne pas laisser derrière soi un profil avec un mauvais mot de passe.
            for uuid, _ in self.profiles(self.WIFI_TYPES):
                if uuid not in before:
                    self.nmcli("connection", "delete", "uuid", uuid, timeout=10)
            raise nm_connect_error(res, password_given=bool(password))

    def wifi_disconnect(self) -> None:
        for dev in self.devices():
            if dev["type"] == "wifi" and dev["state"].startswith(("connected", "connecting")):
                res = self.nmcli("device", "disconnect", dev["device"], timeout=15)
                if not res.ok:
                    raise nm_error(res, "Déconnexion impossible")

    def wifi_forget(self, ssid: str) -> None:
        uuids = self.known_wifi().get(ssid)
        if not uuids:
            raise ApiError(404, "Réseau inconnu")
        for uuid in uuids:
            res = self.nmcli("connection", "delete", "uuid", uuid, timeout=15)
            if not res.ok:
                raise nm_error(res, "Impossible d'oublier ce réseau")

    # --- données mobiles --------------------------------------------------

    def mobile_data_active(self) -> bool:
        return bool(self.present() and self.active_types() & set(self.GSM_TYPES))

    def mobile_data(self, enabled: bool, apn: str | None) -> None:
        if not self.present():
            raise ApiError(503, "NetworkManager (nmcli) n'est pas installé")
        profiles = self.profiles(self.GSM_TYPES)
        if not enabled:
            for uuid, _ in profiles:
                self.nmcli("connection", "modify", "uuid", uuid, "connection.autoconnect", "no", timeout=10)
                self.nmcli("connection", "down", "uuid", uuid, timeout=20)
            return
        if profiles:
            uuid = profiles[0][0]
            changes = ["connection.autoconnect", "yes"]
            if apn is not None:
                changes += ["gsm.apn", apn]
            res = self.nmcli("connection", "modify", "uuid", uuid, *changes, timeout=10)
            if not res.ok:
                raise nm_error(res, "Réglage des données mobiles impossible")
        else:
            args = ["connection", "add", "type", "gsm", "ifname", "*", "con-name", self.MOBILE_PROFILE, "connection.autoconnect", "yes"]
            if apn:
                args += ["gsm.apn", apn]
            res = self.nmcli(*args, timeout=15)
            match = re.search(r"\(([0-9a-fA-F-]{36})\)", res.stdout)
            if not res.ok or not match:
                raise nm_error(res, "Création de la connexion de données impossible")
            uuid = match.group(1)
        res = self.nmcli("--wait", "60", "connection", "up", "uuid", uuid, timeout=75)
        if not res.ok:
            raise nm_error(res, "Connexion des données mobiles impossible")


# --------------------------------------------------------------------------
# Bluetooth (BlueZ, bluetoothctl)
# --------------------------------------------------------------------------

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|[\x01\x02\r]")
BT_DEVICE_RE = re.compile(r"Device ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})(?: (.*))?")


def clean_bt_output(text: str) -> str:
    return ANSI_RE.sub("", text or "")


def parse_bt_properties(text: str) -> dict[str, str]:
    """Propriétés « Clé: valeur » de « bluetoothctl show » ou « info » (première occurrence)."""
    props: dict[str, str] = {}
    for raw in clean_bt_output(text).splitlines():
        line = raw.strip()
        if not line or line.startswith("[") or line.startswith(("Controller ", "Device ")) or ":" not in line:
            continue
        key, _, value = line.partition(":")
        props.setdefault(key.strip(), value.strip())
    return props


def parse_bt_devices(text: str) -> list[str]:
    addresses: list[str] = []
    for raw in clean_bt_output(text).splitlines():
        match = BT_DEVICE_RE.fullmatch(raw.strip())
        if match:
            address = match.group(1).upper()
            if address not in addresses:
                addresses.append(address)
    return addresses


def parse_battery(value: str | None) -> int | None:
    if not value:
        return None
    match = re.search(r"\((\d{1,3})\)", value)
    try:
        level = int(match.group(1)) if match else int(value.split()[0], 0)
    except ValueError:
        return None
    return level if 0 <= level <= 100 else None


def bt_device_entry(address: str, info: dict[str, str] | None) -> dict | None:
    """Appareil tel que l'API le décrit, ou None (inconnu, ou anonyme et non appairé)."""
    if info is None:
        return None
    paired = info.get("Paired") == "yes"
    connected = info.get("Connected") == "yes"
    if not info.get("Name") and not paired and not connected:
        return None  # balises anonymes trouvées pendant la recherche
    entry = {
        "address": address,
        "name": info.get("Alias") or info.get("Name") or address,
        "paired": paired,
        "connected": connected,
        "trusted": info.get("Trusted") == "yes",
        "icon": info.get("Icon", ""),
    }
    battery = parse_battery(info.get("Battery Percentage"))
    if battery is not None:
        entry["battery"] = battery
    return entry


def bt_error(res: CommandResult, message: str) -> ApiError:
    low = res.output.lower()
    if res.returncode == 127:
        return ApiError(503, "Bluetooth indisponible : bluetoothctl n'est pas installé")
    if "no default controller" in low:
        return ApiError(503, "Aucun adaptateur Bluetooth")
    if "not available" in low or "doesnotexist" in low or "does not exist" in low:
        return ApiError(404, "Appareil introuvable : relancez la recherche")
    if "blocked" in low:
        return ApiError(409, "Bluetooth bloqué par le système (rfkill)")
    if "notready" in low or "not ready" in low:
        return ApiError(409, "Le Bluetooth est désactivé")
    if "authentication" in low:
        return ApiError(400, "Appairage refusé par l'appareil")
    if "inprogress" in low or "in progress" in low:
        return ApiError(409, "Une opération est déjà en cours avec cet appareil")
    if "profile-unavailable" in low:
        return ApiError(502, "Aucun profil compatible avec cet appareil")
    if res.returncode == 124 or "page-timeout" in low or "connectionattemptfailed" in low or "host is down" in low:
        return ApiError(504, "L'appareil ne répond pas (est-il allumé et à portée ?)")
    if "accessdenied" in low or "not authorized" in low or "notpermitted" in low:
        return ApiError(403, "Action refusée par le système (droits insuffisants)")
    return ApiError(502, with_detail(message, res.output))


def bt_succeeded(res: CommandResult) -> bool:
    low = res.output.lower()
    return res.ok and not any(word in low for word in ("failed", "not available", "error"))


class BluetoothBackend:
    def __init__(self, runner: CommandRunner):
        self.runner = runner
        self._lock = threading.Lock()
        self._scan_thread: threading.Thread | None = None
        self._scan_until = 0.0

    def btctl(self, *args: str, timeout: float = 10.0) -> CommandResult:
        res = self.runner.run(["bluetoothctl", *args], timeout=timeout)
        return CommandResult(res.returncode, clean_bt_output(res.stdout), clean_bt_output(res.stderr))

    def controller(self) -> dict[str, str] | None:
        if not self.runner.which("bluetoothctl"):
            return None
        # Sans bluetoothd, bluetoothctl attend indéfiniment : délai court.
        res = self.btctl("show", timeout=5)
        if not res.ok or "Controller" not in res.stdout:
            return None
        return parse_bt_properties(res.stdout)

    def available(self) -> bool:
        return self.controller() is not None

    def scanning(self) -> bool:
        with self._lock:
            alive = self._scan_thread is not None and self._scan_thread.is_alive()
            return alive or time.monotonic() < self._scan_until

    def info(self, address: str) -> dict[str, str] | None:
        res = self.btctl("info", address, timeout=8)
        if not res.ok or "not available" in res.output.lower():
            return None
        return parse_bt_properties(res.stdout)

    def state(self) -> dict:
        ctrl = self.controller()
        if ctrl is None:
            return {"available": False, "powered": False, "discovering": False, "devices": []}
        res = self.btctl("devices", timeout=8)
        addresses = parse_bt_devices(res.stdout)[:64] if res.ok else []
        with ThreadPoolExecutor(max_workers=8) as pool:
            infos = list(pool.map(self.info, addresses))
        devices = [entry for entry in map(bt_device_entry, addresses, infos) if entry]
        devices.sort(key=bt_sort_key)
        return {
            "available": True,
            "powered": ctrl.get("Powered") == "yes",
            "discovering": ctrl.get("Discovering") == "yes" or self.scanning(),
            "devices": devices,
        }

    def _require(self) -> dict[str, str]:
        ctrl = self.controller()
        if ctrl is None:
            raise ApiError(503, "Aucun adaptateur Bluetooth")
        return ctrl

    def power(self, enabled: bool) -> None:
        self._require()
        res = self.btctl("power", "on" if enabled else "off", timeout=10)
        if not bt_succeeded(res):
            raise bt_error(res, "Impossible de changer l'état du Bluetooth")

    def scan(self, seconds: int) -> None:
        if self._require().get("Powered") != "yes":
            raise ApiError(409, "Le Bluetooth est désactivé")
        with self._lock:
            if self._scan_thread is not None and self._scan_thread.is_alive():
                return
            self._scan_until = time.monotonic() + seconds
            thread = threading.Thread(target=self._scan_worker, args=(seconds,), name="bt-scan", daemon=True)
            self._scan_thread = thread
            thread.start()

    def _scan_worker(self, seconds: int) -> None:
        # bluetoothctl reste ouvert N secondes ; la recherche s'arrête quand il se ferme.
        res = self.btctl("--timeout", str(seconds), "scan", "on", timeout=seconds + 10)
        if not res.ok:
            LOG.warning("Recherche Bluetooth : %s", first_error_line(res.output))

    def pair(self, address: str) -> None:
        self._require()
        # Agent « NoInputNoOutput » : appairage simple (casques, enceintes, souris).
        res = self.btctl("--agent", "NoInputNoOutput", "pair", address, timeout=45)
        low = res.output.lower()
        if not (bt_succeeded(res) or "alreadyexists" in low or "already exists" in low):
            raise bt_error(res, "Appairage impossible")
        res = self.btctl("trust", address, timeout=10)
        if not bt_succeeded(res):
            raise bt_error(res, "Impossible de faire confiance à l'appareil")

    def connect(self, address: str) -> None:
        self._require()
        res = self.btctl("connect", address, timeout=40)
        if not bt_succeeded(res):
            raise bt_error(res, "Connexion impossible")

    def disconnect(self, address: str) -> None:
        self._require()
        res = self.btctl("disconnect", address, timeout=20)
        if not bt_succeeded(res):
            raise bt_error(res, "Déconnexion impossible")

    def remove(self, address: str) -> None:
        self._require()
        res = self.btctl("remove", address, timeout=20)
        if not bt_succeeded(res):
            raise bt_error(res, "Impossible d'oublier l'appareil")


# --------------------------------------------------------------------------
# Réseau mobile (ModemManager, mmcli)
# --------------------------------------------------------------------------

TECH_PRIORITY = ["5gnr", "lte", "hspa-plus", "hspa", "hsupa", "hsdpa", "umts", "edge", "gprs", "gsm", "evdob", "evdoa", "evdo0", "1xrtt", "pots"]
CALL_STATES = {
    "ringing-in": "ringing",
    "waiting": "ringing",
    "dialing": "dialing",
    "ringing-out": "dialing",
    "active": "active",
    "held": "held",
    "terminated": "terminated",
    "unknown": "terminated",
}


def mm_paths(output: str, kind: str) -> list[str]:
    """Index des objets ModemManager (Modem, Call, SMS, SIM) cités dans une sortie mmcli."""
    found: list[str] = []
    for index in re.findall(rf"/org/freedesktop/ModemManager1/{kind}/(\d+)", output):
        if index not in found:
            found.append(index)
    return found


def mm_quote(value: str) -> str:
    """Valeur pour une chaîne « clé=valeur » de mmcli.

    mmcli lit une valeur entre ' ou " jusqu'au guillemet identique suivant,
    sans échappement possible : on prend le guillemet absent du texte. Si les
    deux sont présents, l'apostrophe droite devient typographique (’).
    """
    if "'" not in value:
        return f"'{value}'"
    if '"' not in value:
        return f'"{value}"'
    return "'" + value.replace("'", "’") + "'"


def mm_timestamp(value: str) -> str | None:
    text = clean(value)
    if not text:
        return None
    if re.search(r"[+-]\d{2}$", text):
        return text + ":00"
    match = re.fullmatch(r"(.*[+-]\d{2})(\d{2})", text)
    return f"{match.group(1)}:{match.group(2)}" if match else text


def mm_error(res: CommandResult, message: str) -> ApiError:
    low = res.output.lower()
    if res.returncode == 127:
        return ApiError(503, "Réseau mobile indisponible : ModemManager (mmcli) n'est pas installé")
    if "couldn't find the modemmanager process" in low or "modemmanager is not running" in low:
        return ApiError(503, "ModemManager n'est pas démarré")
    if "incorrectpassword" in low or "incorrect password" in low:
        return ApiError(400, "Code PIN incorrect")
    if "simpuk" in low or "puk" in low:
        return ApiError(403, "Carte SIM bloquée : code PUK nécessaire")
    if "simnotinserted" in low or "sim-missing" in low or "sim not inserted" in low:
        return ApiError(409, "Aucune carte SIM")
    if "simpin" in low or "sim pin" in low or "locked" in low:
        return ApiError(409, "Carte SIM verrouillée : saisissez le code PIN")
    if "unauthorized" in low or "not authorized" in low:
        return ApiError(403, "Action refusée par le système (droits insuffisants)")
    if "wrongstate" in low or "wrong state" in low or "not registered" in low:
        return ApiError(409, "Le modem n'est pas prêt (réseau non disponible)")
    if res.returncode == 124 or "timeout" in low:
        return ApiError(504, "Le modem ne répond pas (délai dépassé)")
    return ApiError(502, with_detail(message, res.output))


def best_technology(techs: list[str]) -> str | None:
    values = [clean(t).lower() for t in techs if clean(t)]
    for tech in TECH_PRIORITY:
        if tech in values:
            return tech
    return values[0] if values else None


class ModemBackend:
    TERMINATED_TTL = 30.0  # un appel terminé reste listé 30 s avant d'être effacé

    def __init__(self, runner: CommandRunner, network: NetworkManagerBackend):
        self.runner = runner
        self.network = network
        self._terminated: dict[str, float] = {}
        self._lock = threading.Lock()

    def mmcli(self, *args: str, timeout: float = 15.0) -> CommandResult:
        return self.runner.run(["mmcli", *args], timeout=timeout)

    def json(self, *args: str, timeout: float = 15.0) -> dict:
        res = self.mmcli(*args, "-J", timeout=timeout)
        if not res.ok:
            raise mm_error(res, "ModemManager ne répond pas")
        try:
            data = json.loads(res.stdout)
        except ValueError:
            raise ApiError(502, "Réponse illisible de ModemManager") from None
        return data if isinstance(data, dict) else {}

    def modem_index(self) -> str | None:
        if not self.runner.which("mmcli"):
            return None
        res = self.mmcli("-L", "-J", timeout=8)
        if not res.ok:
            return None
        paths = mm_paths(res.stdout, "Modem")
        return paths[0] if paths else None

    def available(self) -> bool:
        return self.modem_index() is not None

    def require(self) -> str:
        index = self.modem_index()
        if index is None:
            raise ApiError(503, "Aucun modem détecté")
        return index

    def info(self, index: str) -> dict:
        return self.json("-m", index).get("modem") or {}

    def state(self) -> dict:
        index = self.modem_index()
        if index is None:
            return {"available": False}
        modem = self.info(index)
        generic = modem.get("generic") or {}
        gpp = modem.get("3gpp") or {}
        state = clean(generic.get("state")) or "unknown"
        failed = clean(generic.get("state-failed-reason"))
        quality = generic.get("signal-quality") or {}
        numbers = [clean(n) for n in generic.get("own-numbers") or [] if clean(n)]
        return {
            "available": True,
            "state": state,
            "operator": clean(gpp.get("operator-name")) or None,
            "signal": max(0, min(100, as_int(quality.get("value") if isinstance(quality, dict) else quality))),
            "technology": best_technology(generic.get("access-technologies") or []),
            "sim": bool(clean(generic.get("sim"))) and failed != "sim-missing",
            "number": numbers[0] if numbers else None,
            "registration": clean(gpp.get("registration-state")) or "unknown",
            "enabled": state not in ("disabled", "disabling", "failed", "locked", "unknown"),
            "data": self.network.mobile_data_active(),
        }

    def power(self, enabled: bool) -> None:
        index = self.require()
        res = self.mmcli("-m", index, "--enable" if enabled else "--disable", timeout=40)
        if not res.ok:
            raise mm_error(res, "Impossible de changer l'état du modem")

    def unlock(self, pin: str) -> None:
        index = self.require()
        sims = mm_paths(json.dumps(self.info(index)), "SIM")
        if not sims:
            raise ApiError(409, "Aucune carte SIM")
        res = self.mmcli("-i", sims[0], f"--pin={pin}", timeout=20)
        if not res.ok:
            raise mm_error(res, "Code PIN refusé")
        self.mmcli("-m", index, "--enable", timeout=40)

    # --- appels ---------------------------------------------------------

    def _call(self, call_id: str) -> dict | None:
        try:
            data = self.json("-o", call_id, timeout=8).get("call") or {}
        except ApiError:
            return None
        detail = {**(data.get("properties") or {}), **(data.get("detail") or {})}
        mm_state = clean(detail.get("state")) or "unknown"
        return {
            "id": call_id,
            "number": clean(detail.get("number")),
            "direction": "incoming" if clean(detail.get("direction")) == "incoming" else "outgoing",
            "state": CALL_STATES.get(mm_state, "terminated"),
        }

    def calls(self) -> list[dict]:
        index = self.modem_index()
        if index is None:
            return []
        res = self.mmcli("-m", index, "--voice-list-calls", "-J", timeout=8)
        if not res.ok:
            return []
        ids = mm_paths(res.stdout, "Call")[:16]
        with ThreadPoolExecutor(max_workers=4) as pool:
            calls = [c for c in pool.map(self._call, ids) if c]
        now = time.monotonic()
        with self._lock:
            live = {c["id"] for c in calls}
            self._terminated = {k: v for k, v in self._terminated.items() if k in live}
            expired = []
            for call in calls:
                if call["state"] == "terminated":
                    first = self._terminated.setdefault(call["id"], now)
                    if now - first > self.TERMINATED_TTL:
                        expired.append(call["id"])
        for call_id in expired:
            self.mmcli("-m", index, f"--voice-delete-call={call_id}", timeout=8)
        return [c for c in calls if c["id"] not in expired]

    def dial(self, number: str) -> str:
        index = self.require()
        res = self.mmcli("-m", index, f"--voice-create-call=number={number}", timeout=20)
        ids = mm_paths(res.stdout, "Call")
        if not res.ok or not ids:
            raise mm_error(res, "Appel impossible")
        start = self.mmcli("-o", ids[0], "--start", timeout=30)
        if not start.ok:
            self.mmcli("-m", index, f"--voice-delete-call={ids[0]}", timeout=8)
            raise mm_error(start, "Appel impossible")
        return ids[0]

    def answer(self, call_id: str) -> None:
        self.require()
        res = self.mmcli("-o", call_id, "--accept", timeout=20)
        if not res.ok:
            raise mm_error(res, "Impossible de répondre")

    def hangup(self, call_id: str | None) -> None:
        index = self.require()
        if call_id is not None:
            res = self.mmcli("-o", call_id, "--hangup", timeout=20)
        else:
            res = self.mmcli("-m", index, "--voice-hangup-all", timeout=20)
        if not res.ok:
            raise mm_error(res, "Impossible de raccrocher")

    # --- SMS ------------------------------------------------------------

    def send_sms(self, number: str, text: str) -> None:
        index = self.require()
        spec = f"number={mm_quote(number)},text={mm_quote(text)}"
        res = self.mmcli("-m", index, f"--messaging-create-sms={spec}", timeout=20)
        ids = mm_paths(res.stdout, "SMS")
        if not res.ok or not ids:
            raise mm_error(res, "Création du SMS impossible")
        sent = self.mmcli("-s", ids[0], "--send", timeout=90)
        if not sent.ok:
            self.mmcli("-m", index, f"--messaging-delete-sms={ids[0]}", timeout=10)
            raise mm_error(sent, "Envoi du SMS impossible")

    def _sms(self, sms_id: str) -> dict | None:
        try:
            data = self.json("-s", sms_id, timeout=8).get("sms") or {}
        except ApiError:
            return None
        content = data.get("content") or {}
        props = data.get("properties") or {}
        return {
            "id": sms_id,
            "number": clean(content.get("number")),
            "text": clean(content.get("text")),
            "timestamp": mm_timestamp(props.get("timestamp")),
            "state": clean(props.get("state")) or "unknown",
        }

    def messages(self) -> list[dict]:
        index = self.require()
        res = self.mmcli("-m", index, "--messaging-list-sms", "-J", timeout=10)
        if not res.ok:
            raise mm_error(res, "Lecture des SMS impossible")
        ids = sorted(mm_paths(res.stdout, "SMS"), key=int)[-200:]
        with ThreadPoolExecutor(max_workers=6) as pool:
            return [m for m in pool.map(self._sms, ids) if m]

    def delete_sms(self, sms_id: str) -> None:
        index = self.require()
        res = self.mmcli("-m", index, f"--messaging-delete-sms={sms_id}", timeout=10)
        if not res.ok:
            raise mm_error(res, "Suppression du SMS impossible")


# --------------------------------------------------------------------------
# GPS (gpsd, protocole JSON sur TCP 2947)
# --------------------------------------------------------------------------


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def gps_fix(tpv: dict | None, sky: dict | None) -> dict | None:
    """Position au format de l'API à partir des messages TPV et SKY de gpsd."""
    if not tpv or as_int(tpv.get("mode"), 0) < 2:
        return None
    lat, lon = _number(tpv.get("lat")), _number(tpv.get("lon"))
    if lat is None or lon is None:
        return None
    accuracy = _number(tpv.get("eph"))
    if accuracy is None:
        errors = [e for e in (_number(tpv.get("epx")), _number(tpv.get("epy"))) if e is not None]
        accuracy = max(errors) if errors else None
    alt = next((v for v in (_number(tpv.get(k)) for k in ("altMSL", "alt", "altHAE")) if v is not None), None)
    satellites = None
    if sky:
        satellites = as_int(sky.get("uSat"), -1)
        if satellites < 0:
            satellites = sum(1 for s in sky.get("satellites") or [] if isinstance(s, dict) and s.get("used"))
    return {
        "lat": round(lat, 7),
        "lon": round(lon, 7),
        "alt": alt,
        "speed": _number(tpv.get("speed")),
        "heading": _number(tpv.get("track")),
        "accuracy": accuracy,
        "time": tpv.get("time") if isinstance(tpv.get("time"), str) else None,
        "satellites": satellites,
    }


class GpsdClient:
    """Interroge gpsd directement (sans gpspipe) : ?WATCH puis ?POLL."""

    def __init__(self, host: str = "127.0.0.1", port: int = 2947, timeout: float = 2.0):
        self.host = host
        self.port = port
        self.timeout = timeout

    def query(self) -> dict:
        result: dict[str, Any] = {"reachable": False, "devices": None, "tpv": None, "sky": None}
        deadline = time.monotonic() + self.timeout
        try:
            sock = socket.create_connection((self.host, self.port), timeout=min(1.0, self.timeout))
        except OSError:
            return result
        result["reachable"] = True
        with sock:
            try:
                sock.sendall(b'?WATCH={"enable":true,"json":true};\n')
            except OSError:
                return result
            buffer = b""
            polled = got_poll = False
            while time.monotonic() < deadline:
                sock.settimeout(max(0.05, deadline - time.monotonic()))
                try:
                    chunk = sock.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > 1 << 20:
                    break
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    try:
                        message = json.loads(line.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if not isinstance(message, dict):
                        continue
                    kind = message.get("class")
                    if kind == "DEVICES":
                        result["devices"] = [d for d in message.get("devices") or [] if isinstance(d, dict)]
                    elif kind == "WATCH" and not polled:
                        polled = True
                        with contextlib.suppress(OSError):
                            sock.sendall(b"?POLL;\n")
                    elif kind == "TPV":
                        result["tpv"] = self._better(result["tpv"], message)
                    elif kind == "SKY":
                        result["sky"] = message
                    elif kind == "POLL":
                        got_poll = True
                        for tpv in message.get("tpv") or []:
                            if isinstance(tpv, dict):
                                result["tpv"] = self._better(result["tpv"], tpv)
                        # La réponse à ?POLL est l'état le plus récent : elle l'emporte.
                        skies = [s for s in message.get("sky") or [] if isinstance(s, dict)]
                        if skies:
                            result["sky"] = skies[0]
                if result["devices"] == []:
                    break  # gpsd tourne mais aucun récepteur n'est branché
                if got_poll:
                    break
        return result

    @staticmethod
    def _better(current: dict | None, candidate: dict) -> dict:
        if current is None or as_int(candidate.get("mode"), 0) >= as_int(current.get("mode"), 0):
            return candidate
        return current


class GpsBackend:
    CACHE_TTL = 1.0

    def __init__(self, client: GpsdClient):
        self.client = client
        self._lock = threading.Lock()
        self._cache: tuple[float, dict] | None = None

    def state(self) -> dict:
        with self._lock:
            if self._cache and time.monotonic() - self._cache[0] < self.CACHE_TTL:
                return self._cache[1]
        query = self.client.query()
        devices = query["devices"]
        available = query["reachable"] and (bool(devices) or (devices is None and query["tpv"] is not None))
        state = {"available": available, "fix": gps_fix(query["tpv"], query["sky"]) if available else None}
        with self._lock:
            self._cache = (time.monotonic(), state)
        return state

    def available(self) -> bool:
        return self.state()["available"]


# --------------------------------------------------------------------------
# Alimentation (systemd / logind)
# --------------------------------------------------------------------------

POWER_DELAY = 1.0


class PowerBackend:
    def __init__(self, runner: CommandRunner):
        self.runner = runner

    def available(self) -> bool:
        return self.runner.which("systemctl")

    def request(self, action: str) -> None:
        if not self.available():
            raise ApiError(503, "Commande systemctl introuvable")

        def run() -> None:
            res = self.runner.run(["systemctl", action], timeout=30)
            if not res.ok:
                LOG.error("systemctl %s : %s", action, first_error_line(res.output))

        # Exécuté après l'envoi de la réponse.
        timer = threading.Timer(POWER_DELAY, run)
        timer.daemon = True
        timer.start()


# --------------------------------------------------------------------------
# Matériel réel
# --------------------------------------------------------------------------


class RealHardware:
    simulated = False
    STATUS_TTL = 5.0

    def __init__(self, runner: CommandRunner | None = None, gps: GpsdClient | None = None):
        self.runner = runner or CommandRunner()
        self.nm = NetworkManagerBackend(self.runner)
        self.bt = BluetoothBackend(self.runner)
        self.mm = ModemBackend(self.runner, self.nm)
        self.gps = GpsBackend(gps or GpsdClient())
        self.power = PowerBackend(self.runner)
        self._lock = threading.Lock()
        self._caps: tuple[float, dict] | None = None

    def capabilities(self) -> dict:
        with self._lock:
            if self._caps and time.monotonic() - self._caps[0] < self.STATUS_TTL:
                return dict(self._caps[1])
        checks: dict[str, Callable[[], bool]] = {
            "wifi": self.nm.wifi_available,
            "bluetooth": self.bt.available,
            "modem": self.mm.available,
            "gps": self.gps.available,
            "power": self.power.available,
            "network": self.nm.running,
        }
        caps = {}
        with ThreadPoolExecutor(max_workers=len(checks)) as pool:
            futures = {name: pool.submit(check) for name, check in checks.items()}
            for name, future in futures.items():
                try:
                    caps[name] = bool(future.result())
                except Exception:  # une détection qui échoue vaut « absent »
                    LOG.exception("Détection de %s", name)
                    caps[name] = False
        with self._lock:
            self._caps = (time.monotonic(), caps)
        return dict(caps)

    def status(self) -> dict:
        return {
            "bridge": BRIDGE_NAME,
            "version": BRIDGE_VERSION,
            "hostname": socket.gethostname(),
            "simulated": False,
            "capabilities": self.capabilities(),
        }

    def network_state(self) -> dict:
        return self.nm.network_state()

    def wifi_state(self, rescan: bool) -> dict:
        return self.nm.wifi_state(rescan)

    def wifi_power(self, enabled: bool) -> None:
        self.nm.wifi_power(enabled)

    def wifi_connect(self, ssid: str, password: str | None, hidden: bool) -> None:
        self.nm.wifi_connect(ssid, password, hidden)

    def wifi_disconnect(self) -> None:
        self.nm.wifi_disconnect()

    def wifi_forget(self, ssid: str) -> None:
        self.nm.wifi_forget(ssid)

    def bt_state(self) -> dict:
        return self.bt.state()

    def bt_power(self, enabled: bool) -> None:
        self.bt.power(enabled)

    def bt_scan(self, seconds: int) -> None:
        self.bt.scan(seconds)

    def bt_pair(self, address: str) -> None:
        self.bt.pair(address)

    def bt_connect(self, address: str) -> None:
        self.bt.connect(address)

    def bt_disconnect(self, address: str) -> None:
        self.bt.disconnect(address)

    def bt_remove(self, address: str) -> None:
        self.bt.remove(address)

    def modem_state(self) -> dict:
        return self.mm.state()

    def modem_power(self, enabled: bool) -> None:
        self.mm.power(enabled)

    def modem_data(self, enabled: bool, apn: str | None) -> None:
        self.mm.require()
        self.nm.mobile_data(enabled, apn)

    def modem_pin(self, pin: str) -> None:
        self.mm.unlock(pin)

    def modem_calls(self) -> list[dict]:
        return self.mm.calls()

    def modem_call(self, number: str) -> str:
        return self.mm.dial(number)

    def modem_answer(self, call_id: str) -> None:
        self.mm.answer(call_id)

    def modem_hangup(self, call_id: str | None) -> None:
        self.mm.hangup(call_id)

    def modem_sms_send(self, number: str, text: str) -> None:
        self.mm.send_sms(number, text)

    def modem_sms_list(self) -> list[dict]:
        return self.mm.messages()

    def modem_sms_delete(self, sms_id: str) -> None:
        self.mm.delete_sms(sms_id)

    def gps_state(self) -> dict:
        return self.gps.state()

    def power_request(self, action: str) -> None:
        self.power.request(action)


# --------------------------------------------------------------------------
# Matériel simulé (--simulate)
# --------------------------------------------------------------------------

SIM_WIFI_PASSWORD = "orion1234"
SIM_IP = "192.168.1.42"
SIM_MOBILE_IP = "10.64.12.7"
SIM_NUMBER = "+33612345678"
SIM_OPERATOR = "Orion Mobile"
SIM_GPS_CENTER = (48.8530, 2.3499)  # Paris, île de la Cité
SIM_NETWORKS = [
    {"ssid": "Orion Box", "security": "WPA2", "frequency": 5180, "signal": 82},
    {"ssid": "Livebox-7A3F", "security": "WPA2", "frequency": 2437, "signal": 64},
    {"ssid": "Café de la Gare", "security": "", "frequency": 2412, "signal": 57},
    {"ssid": "Bureau Orion 5G", "security": "WPA3", "frequency": 5500, "signal": 46},
    {"ssid": "Freebox du voisin", "security": "WPA1 WPA2", "frequency": 2462, "signal": 31},
]
SIM_BT_PAIRED = {
    "A0:B1:C2:D3:E4:01": {"name": "Écouteurs Orion", "icon": "audio-headset", "battery": 80},
    "A0:B1:C2:D3:E4:02": {"name": "Clavier Orion", "icon": "input-keyboard"},
}
SIM_BT_NEARBY = [
    ("A0:B1:C2:D3:E4:10", {"name": "Enceinte du salon", "icon": "audio-card", "delay": 0.6}),
    ("A0:B1:C2:D3:E4:11", {"name": "Souris sans fil", "icon": "input-mouse", "battery": 55, "delay": 1.2}),
    ("A0:B1:C2:D3:E4:12", {"name": "Téléphone de Léa", "icon": "phone", "delay": 1.8}),
    ("A0:B1:C2:D3:E4:13", {"name": "Montre connectée", "icon": "", "battery": 72, "delay": 2.4}),
]


class SimulatedHardware:
    """Imitation en mémoire de tout le matériel, avec un état qui évolue.

    delay_scale règle les délais simulés (connexion, appairage, réponse aux
    SMS…) : 1 en usage normal, 0 dans les tests. clock permet aux tests
    d'avancer le temps (déplacement du GPS, appels).
    """

    simulated = True
    OUTGOING_ANSWER_DELAY = 3.0
    SMS_REPLY_DELAY = 3.0
    RING_TIMEOUT = 30.0
    TERMINATED_TTL = 30.0

    def __init__(self, *, delay_scale: float = 1.0, clock: Callable[[], float] = time.monotonic, seed: int | None = None):
        self._lock = threading.RLock()
        self._clock = clock
        self._scale = delay_scale
        self._rng = random.Random(seed)
        self._t0 = clock()
        # Wi-Fi : connecté à « Orion Box », réseau déjà connu.
        self._wifi_enabled = True
        self._known = {"Orion Box"}
        self._wifi_connected: str | None = "Orion Box"
        # Bluetooth
        self._bt_powered = True
        self._bt: dict[str, dict] = {
            addr: {"paired": True, "trusted": True, "connected": False, **info} for addr, info in SIM_BT_PAIRED.items()
        }
        self._scan_start: float | None = None
        self._scan_end = 0.0
        self._bt_hidden: set[str] = set()
        # Modem
        self._modem_enabled = True
        self._data = True
        self._apn = "orion"
        self._calls: dict[str, dict] = {}
        self._next_call = 1
        self._sms: list[dict] = []
        self._next_sms = 1
        self._pending: list[tuple[float, str, dict]] = []

    def _now(self) -> float:
        return self._clock()

    def _sleep(self, seconds: float) -> None:
        if self._scale > 0:
            time.sleep(seconds * self._scale)

    # --- état général ---------------------------------------------------

    def status(self) -> dict:
        caps = {"wifi": True, "bluetooth": True, "modem": True, "gps": True, "power": True, "network": True}
        return {"bridge": BRIDGE_NAME, "version": BRIDGE_VERSION, "hostname": "orion", "simulated": True, "capabilities": caps}

    def network_state(self) -> dict:
        with self._lock:
            if self._wifi_enabled and self._wifi_connected:
                primary = {"type": "wifi", "name": self._wifi_connected, "device": "wlan0", "ip": SIM_IP}
            elif self._modem_enabled and self._data:
                primary = {"type": "gsm", "name": "orion-mobile", "device": "cdc-wdm0", "ip": SIM_MOBILE_IP}
            else:
                primary = None
        return {"connectivity": "full" if primary else "none", "primary": primary}

    # --- Wi-Fi ------------------------------------------------------------

    def wifi_state(self, rescan: bool) -> dict:
        if rescan:
            self._sleep(1.0)
        with self._lock:
            if not self._wifi_enabled:
                return {"enabled": False, "connected": None, "networks": []}
            networks = []
            for net in SIM_NETWORKS:
                networks.append({
                    "ssid": net["ssid"],
                    "signal": max(0, min(100, net["signal"] + self._rng.randint(-3, 3))),
                    "security": net["security"],
                    "frequency": net["frequency"],
                    "known": net["ssid"] in self._known,
                    "active": net["ssid"] == self._wifi_connected,
                })
            networks.sort(key=network_sort_key)
            active = next((n for n in networks if n["active"]), None)
            connected = None
            if active:
                connected = {key: active[key] for key in ("ssid", "signal", "security", "frequency")}
                connected["ip"] = SIM_IP
            return {"enabled": True, "connected": connected, "networks": networks}

    def wifi_power(self, enabled: bool) -> None:
        with self._lock:
            self._wifi_enabled = enabled
            if not enabled:
                self._wifi_connected = None

    def wifi_connect(self, ssid: str, password: str | None, hidden: bool) -> None:
        with self._lock:
            if not self._wifi_enabled:
                raise ApiError(409, "Le Wi-Fi est désactivé")
            net = next((n for n in SIM_NETWORKS if n["ssid"] == ssid), None)
        self._sleep(1.5)
        with self._lock:
            if net is None:
                raise ApiError(404, "Réseau introuvable")
            if net["security"]:
                if password is not None and password != SIM_WIFI_PASSWORD:
                    raise ApiError(400, "Mot de passe incorrect")
                if password is None and ssid not in self._known:
                    raise ApiError(400, "Mot de passe requis")
            self._known.add(ssid)
            self._wifi_connected = ssid

    def wifi_disconnect(self) -> None:
        with self._lock:
            self._wifi_connected = None

    def wifi_forget(self, ssid: str) -> None:
        with self._lock:
            if ssid not in self._known:
                raise ApiError(404, "Réseau inconnu")
            self._known.discard(ssid)
            if self._wifi_connected == ssid:
                self._wifi_connected = None

    # --- Bluetooth ----------------------------------------------------------

    def _bt_refresh(self) -> None:
        if self._scan_start is None:
            return
        horizon = min(self._now(), self._scan_end)
        for address, info in SIM_BT_NEARBY:
            if address in self._bt or address in self._bt_hidden:
                continue
            if self._scan_start + info["delay"] * self._scale <= horizon:
                self._bt[address] = {"paired": False, "trusted": False, "connected": False, **info}

    def bt_state(self) -> dict:
        with self._lock:
            self._bt_refresh()
            devices = []
            for address, dev in self._bt.items():
                entry = {
                    "address": address,
                    "name": dev["name"],
                    "paired": dev["paired"],
                    "connected": dev["connected"] and self._bt_powered,
                    "trusted": dev["trusted"],
                    "icon": dev.get("icon", ""),
                }
                if dev.get("battery") is not None and entry["connected"]:
                    entry["battery"] = dev["battery"]
                devices.append(entry)
            devices.sort(key=bt_sort_key)
            discovering = self._bt_powered and self._now() < self._scan_end
            return {"available": True, "powered": self._bt_powered, "discovering": discovering, "devices": devices}

    def bt_power(self, enabled: bool) -> None:
        with self._lock:
            self._bt_powered = enabled
            if not enabled:
                self._scan_end = 0.0
                for dev in self._bt.values():
                    dev["connected"] = False

    def bt_scan(self, seconds: int) -> None:
        with self._lock:
            if not self._bt_powered:
                raise ApiError(409, "Le Bluetooth est désactivé")
            self._scan_start = self._now()
            self._scan_end = self._scan_start + seconds * self._scale
            self._bt_hidden.clear()

    def _bt_device(self, address: str) -> dict:
        self._bt_refresh()
        if not self._bt_powered:
            raise ApiError(409, "Le Bluetooth est désactivé")
        dev = self._bt.get(address)
        if dev is None:
            raise ApiError(404, "Appareil introuvable : relancez la recherche")
        return dev

    def bt_pair(self, address: str) -> None:
        with self._lock:
            self._bt_device(address)
        self._sleep(1.5)
        with self._lock:
            dev = self._bt_device(address)
            dev["paired"] = dev["trusted"] = True

    def bt_connect(self, address: str) -> None:
        with self._lock:
            if not self._bt_device(address)["paired"]:
                raise ApiError(400, "Appareil non appairé")
        self._sleep(1.0)
        with self._lock:
            self._bt_device(address)["connected"] = True

    def bt_disconnect(self, address: str) -> None:
        with self._lock:
            self._bt_device(address)["connected"] = False

    def bt_remove(self, address: str) -> None:
        with self._lock:
            self._bt_device(address)
            del self._bt[address]
            if any(address == a for a, _ in SIM_BT_NEARBY):
                self._bt_hidden.add(address)  # réapparaîtra à la prochaine recherche

    # --- Modem ----------------------------------------------------------------

    def _process(self) -> None:
        """Fait avancer le temps simulé : réponses aux SMS, appels."""
        now = self._now()
        due = [p for p in self._pending if p[0] <= now]
        self._pending = [p for p in self._pending if p[0] > now]
        for _, kind, payload in sorted(due, key=lambda p: p[0]):
            if kind == "sms":
                self._receive_sms(payload["number"], payload["text"])
        for call_id, call in list(self._calls.items()):
            if call["state"] == "dialing" and now >= call["since"] + self.OUTGOING_ANSWER_DELAY * self._scale:
                call.update(state="active", since=now)
            elif call["state"] == "ringing" and now >= call["since"] + self.RING_TIMEOUT:
                call.update(state="terminated", since=now)  # appel manqué
            elif call["state"] == "terminated" and now >= call["since"] + self.TERMINATED_TTL:
                del self._calls[call_id]

    def _receive_sms(self, number: str, text: str) -> None:
        self._sms.append({"id": str(self._next_sms), "number": number, "text": text, "timestamp": local_now_iso(), "state": "received"})
        self._next_sms += 1

    def _require_modem(self) -> None:
        if not self._modem_enabled:
            raise ApiError(409, "Le réseau mobile est désactivé")

    def modem_state(self) -> dict:
        with self._lock:
            self._process()
            enabled = self._modem_enabled
            return {
                "available": True,
                "state": ("connected" if self._data else "registered") if enabled else "disabled",
                "operator": SIM_OPERATOR if enabled else None,
                "signal": max(0, min(100, 68 + self._rng.randint(-4, 4))) if enabled else 0,
                "technology": "lte" if enabled else None,
                "sim": True,
                "number": SIM_NUMBER,
                "registration": "home" if enabled else "idle",
                "enabled": enabled,
                "data": enabled and self._data,
            }

    def modem_power(self, enabled: bool) -> None:
        with self._lock:
            self._modem_enabled = enabled
            if not enabled:
                for call in self._calls.values():
                    call.update(state="terminated", since=self._now())

    def modem_data(self, enabled: bool, apn: str | None) -> None:
        with self._lock:
            if enabled:
                self._require_modem()
            if apn is not None:
                self._apn = apn
        if enabled:
            self._sleep(1.0)
        with self._lock:
            self._data = enabled

    def modem_pin(self, pin: str) -> None:
        raise ApiError(409, "La carte SIM n'est pas verrouillée")

    def modem_calls(self) -> list[dict]:
        with self._lock:
            self._process()
            return [
                {"id": call_id, "number": call["number"], "direction": call["direction"], "state": call["state"]}
                for call_id, call in sorted(self._calls.items(), key=lambda item: int(item[0]))
            ]

    def _new_call(self, number: str, direction: str, state: str) -> str:
        call_id = str(self._next_call)
        self._next_call += 1
        self._calls[call_id] = {"number": number, "direction": direction, "state": state, "since": self._now()}
        return call_id

    def modem_call(self, number: str) -> str:
        with self._lock:
            self._require_modem()
            self._process()
            if any(c["state"] in ("dialing", "active") for c in self._calls.values()):
                raise ApiError(409, "Un appel est déjà en cours")
            return self._new_call(number, "outgoing", "dialing")

    def modem_answer(self, call_id: str) -> None:
        with self._lock:
            self._process()
            call = self._calls.get(call_id)
            if call is None or call["state"] != "ringing":
                raise ApiError(409, "Aucun appel entrant à décrocher")
            call.update(state="active", since=self._now())

    def modem_hangup(self, call_id: str | None) -> None:
        with self._lock:
            self._process()
            if call_id is not None and call_id not in self._calls:
                raise ApiError(404, "Appel introuvable")
            for cid, call in self._calls.items():
                if (call_id is None or cid == call_id) and call["state"] != "terminated":
                    call.update(state="terminated", since=self._now())

    def modem_sms_send(self, number: str, text: str) -> None:
        with self._lock:
            self._require_modem()
        self._sleep(0.5)
        with self._lock:
            self._sms.append({"id": str(self._next_sms), "number": number, "text": text, "timestamp": local_now_iso(), "state": "sent"})
            self._next_sms += 1
            excerpt = text if len(text) <= 60 else text[:59] + "…"
            reply = f"Bien reçu : « {excerpt} »"
            self._pending.append((self._now() + self.SMS_REPLY_DELAY * self._scale, "sms", {"number": number, "text": reply}))

    def modem_sms_list(self) -> list[dict]:
        with self._lock:
            self._process()
            return [dict(m) for m in self._sms]

    def modem_sms_delete(self, sms_id: str) -> None:
        with self._lock:
            before = len(self._sms)
            self._sms = [m for m in self._sms if m["id"] != sms_id]
            if len(self._sms) == before:
                raise ApiError(404, "SMS introuvable")

    def simulate_incoming_call(self, number: str) -> str:
        with self._lock:
            self._require_modem()
            return self._new_call(number, "incoming", "ringing")

    def simulate_incoming_sms(self, number: str, text: str) -> None:
        with self._lock:
            self._require_modem()
            self._receive_sms(number, text)

    # --- GPS : promenade à pied autour de l'île de la Cité -------------------

    def gps_state(self) -> dict:
        elapsed = self._now() - self._t0
        radius, speed = 220.0, 1.4  # mètres, mètres par seconde
        angle = elapsed * speed / radius
        lat0, lon0 = SIM_GPS_CENTER
        lat = lat0 + radius * math.sin(angle) / 111_320.0
        lon = lon0 + radius * math.cos(angle) / (111_320.0 * math.cos(math.radians(lat0)))
        heading = (math.degrees(math.atan2(-math.sin(angle), math.cos(angle))) + 360.0) % 360.0
        return {
            "available": True,
            "fix": {
                "lat": round(lat, 7),
                "lon": round(lon, 7),
                "alt": 35.0,
                "speed": speed,
                "heading": round(heading, 1),
                "accuracy": round(5.0 + 2.0 * math.sin(elapsed / 15.0), 1),
                "time": utc_now_iso(),
                "satellites": 8 + int(elapsed / 20.0) % 4,
            },
        }

    def power_request(self, action: str) -> None:
        LOG.warning("Simulation : « %s » demandé, rien n'est fait", action)


# --------------------------------------------------------------------------
# API HTTP
# --------------------------------------------------------------------------

Handler = Callable[[Any, dict, dict], Any]


def _flag(query: dict, name: str) -> bool:
    return (query.get(name) or ["0"])[-1].lower() in ("1", "true", "yes", "oui")


def _scan_seconds(body: dict) -> int:
    seconds = body.get("seconds", 10)
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
        raise ApiError(400, "Paramètre « seconds » invalide")
    return max(1, min(30, int(seconds)))


def _apn(body: dict) -> str | None:
    apn = body.get("apn")
    if apn is None:
        return None
    if not isinstance(apn, str) or not APN_RE.fullmatch(apn):
        raise ApiError(400, "Point d'accès (APN) invalide")
    return apn


def _sms_text(body: dict) -> str:
    text = get_str(body, "text", max_len=1000)
    if not text.strip():
        raise ApiError(400, "Le message est vide")
    return text


def _done(action: Callable[[], Any]) -> dict:
    action()
    return OK


def _pin(body: dict) -> str:
    pin = get_str(body, "pin", max_len=8)
    if not PIN_RE.fullmatch(pin):
        raise ApiError(400, "Code PIN invalide (4 à 8 chiffres)")
    return pin


API_ROUTES: dict[str, dict[str, Handler]] = {
    "/api/status": {"GET": lambda hw, body, q: hw.status()},
    "/api/network": {"GET": lambda hw, body, q: hw.network_state()},
    "/api/wifi": {"GET": lambda hw, body, q: hw.wifi_state(_flag(q, "rescan"))},
    "/api/wifi/power": {"POST": lambda hw, body, q: _done(lambda: hw.wifi_power(get_bool(body, "enabled")))},
    "/api/wifi/connect": {
        "POST": lambda hw, body, q: _done(
            lambda: hw.wifi_connect(valid_ssid(body), valid_password(body), body.get("hidden") is True)
        )
    },
    "/api/wifi/disconnect": {"POST": lambda hw, body, q: _done(hw.wifi_disconnect)},
    "/api/wifi/forget": {"POST": lambda hw, body, q: _done(lambda: hw.wifi_forget(valid_ssid(body)))},
    "/api/bluetooth": {"GET": lambda hw, body, q: hw.bt_state()},
    "/api/bluetooth/power": {"POST": lambda hw, body, q: _done(lambda: hw.bt_power(get_bool(body, "enabled")))},
    "/api/bluetooth/scan": {"POST": lambda hw, body, q: _done(lambda: hw.bt_scan(_scan_seconds(body)))},
    "/api/bluetooth/pair": {"POST": lambda hw, body, q: _done(lambda: hw.bt_pair(valid_mac(body)))},
    "/api/bluetooth/connect": {"POST": lambda hw, body, q: _done(lambda: hw.bt_connect(valid_mac(body)))},
    "/api/bluetooth/disconnect": {"POST": lambda hw, body, q: _done(lambda: hw.bt_disconnect(valid_mac(body)))},
    "/api/bluetooth/remove": {"POST": lambda hw, body, q: _done(lambda: hw.bt_remove(valid_mac(body)))},
    "/api/modem": {"GET": lambda hw, body, q: hw.modem_state()},
    "/api/modem/power": {"POST": lambda hw, body, q: _done(lambda: hw.modem_power(get_bool(body, "enabled")))},
    "/api/modem/data": {"POST": lambda hw, body, q: _done(lambda: hw.modem_data(get_bool(body, "enabled"), _apn(body)))},
    "/api/modem/pin": {"POST": lambda hw, body, q: _done(lambda: hw.modem_pin(_pin(body)))},
    "/api/modem/calls": {"GET": lambda hw, body, q: {"calls": hw.modem_calls()}},
    "/api/modem/call": {"POST": lambda hw, body, q: {"ok": True, "id": hw.modem_call(valid_phone(body))}},
    "/api/modem/answer": {"POST": lambda hw, body, q: _done(lambda: hw.modem_answer(valid_id(body)))},
    "/api/modem/hangup": {"POST": lambda hw, body, q: _done(lambda: hw.modem_hangup(valid_id(body, required=False)))},
    "/api/modem/sms": {
        "GET": lambda hw, body, q: {"messages": hw.modem_sms_list()},
        "POST": lambda hw, body, q: _done(lambda: hw.modem_sms_send(valid_phone(body), _sms_text(body))),
    },
    "/api/modem/sms/delete": {"POST": lambda hw, body, q: _done(lambda: hw.modem_sms_delete(valid_id(body)))},
    "/api/gps": {"GET": lambda hw, body, q: hw.gps_state()},
    "/api/system/reboot": {"POST": lambda hw, body, q: _done(lambda: hw.power_request("reboot"))},
    "/api/system/poweroff": {"POST": lambda hw, body, q: _done(lambda: hw.power_request("poweroff"))},
}

# Points d'accès de test, présents seulement avec --simulate.
SIMULATE_ROUTES: dict[str, dict[str, Handler]] = {
    "/api/simulate/incoming-call": {"POST": lambda hw, body, q: {"ok": True, "id": hw.simulate_incoming_call(valid_phone(body))}},
    "/api/simulate/incoming-sms": {"POST": lambda hw, body, q: _done(lambda: hw.simulate_incoming_sms(valid_phone(body), _sms_text(body)))},
}


class OrionHandler(BaseHTTPRequestHandler):
    server_version = BRIDGE_NAME
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30
    error_content_type = "text/plain; charset=utf-8"
    error_message_format = "%(code)d %(message)s\n"
    server: OrionHTTPServer

    def version_string(self) -> str:
        return f"{BRIDGE_NAME}/{BRIDGE_VERSION}"

    # --- journal ------------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (signature imposée)
        LOG.info("%s %s", self.address_string(), format % args)

    def log_error(self, format: str, *args: Any) -> None:  # noqa: A002
        # Connexions inactives fermées, requêtes malformées : rien d'utile au journal.
        LOG.debug("%s %s", self.address_string(), format % args)

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        if status >= 400 or LOG.isEnabledFor(logging.DEBUG):
            self.log_message('"%s" %s', self.requestline, code)

    # --- méthodes -----------------------------------------------------------

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_TRACE(self) -> None:
        self._dispatch("TRACE")

    def do_CONNECT(self) -> None:
        self._dispatch("CONNECT")

    # --- réponses -----------------------------------------------------------

    def _send(self, status: int, body: bytes, content_type: str, *, head: bool = False, close: bool = False, headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self._end_headers(close)
        if not head:
            self.wfile.write(body)

    def _end_headers(self, close: bool = False) -> None:
        if close or self.close_connection:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()

    def _json(self, status: int, payload: Any, *, head: bool = False, close: bool = False, headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        merged = {"Cache-Control": "no-store", **(headers or {})}
        self._send(status, body, "application/json; charset=utf-8", head=head, close=close, headers=merged)

    def _error(self, status: int, message: str, *, head: bool = False, close: bool = False, headers: dict | None = None) -> None:
        self._json(status, {"error": message}, head=head, close=close, headers=headers)

    # --- contrôles de sécurité ------------------------------------------------

    def _host_allowed(self) -> bool:
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1:
            return False
        return hosts[0].strip().lower() in self.server.allowed_hosts

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is not None and origin.strip().lower() != "http://" + self.headers.get("Host", "").strip().lower():
            return False
        site = self.headers.get("Sec-Fetch-Site")
        return site is None or site.strip().lower() in ("same-origin", "none")

    def _read_json(self) -> dict:
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(411, "Longueur de la requête requise")
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else 0
        except ValueError:
            raise ApiError(400, "Longueur de la requête invalide") from None
        if length < 0:
            raise ApiError(400, "Longueur de la requête invalide")
        if length > MAX_BODY:
            raise ApiError(413, "Requête trop volumineuse")
        data = self.rfile.read(length) if length else b""
        if len(data) != length:
            raise ApiError(400, "Requête incomplète")
        if not data.strip():
            return {}
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise ApiError(400, "Corps JSON invalide") from None
        if not isinstance(payload, dict):
            raise ApiError(400, "Un objet JSON est attendu")
        return payload

    # --- aiguillage -----------------------------------------------------------

    def _dispatch(self, method: str) -> None:
        try:
            if method != "POST" and (self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0").strip() not in ("", "0")):
                # Corps inattendu, jamais lu : la connexion ne doit pas resservir.
                self.close_connection = True
            if not self._host_allowed():
                # Protection contre le « DNS rebinding » : seul 127.0.0.1/localhost est servi.
                self._error(403, "Hôte refusé", head=method == "HEAD", close=True)
                return
            if not self.path.startswith("/"):
                self._error(400, "Requête invalide", close=True)
                return
            # Découpage à la main : urlsplit() lirait « //x/… » comme un nom d'hôte.
            path = self.path.split("#", 1)[0].split("?", 1)[0]
            is_api = path == "/api" or path.startswith("/api/")
            if method not in ("GET", "HEAD", "POST") or (method == "POST" and not is_api):
                allow = "GET, HEAD, POST" if is_api else "GET, HEAD"
                self._error(405, "Méthode non autorisée", head=method == "HEAD", close=True, headers={"Allow": allow})
                return
            if is_api:
                self._api(method, path)
            else:
                self._static(path, head=method == "HEAD")
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _api(self, method: str, path: str) -> None:
        head = method == "HEAD"
        close = method == "POST"  # tant que le corps n'est pas lu, la connexion est fermée en cas d'erreur
        if not self._same_origin():
            self._error(403, "Origine refusée", head=head, close=True)
            return
        routes = self.server.routes.get(path)
        if routes is None:
            self._error(404, "Point d'accès inconnu", head=head, close=close)
            return
        wanted = "GET" if head else method
        handler = routes.get(wanted)
        if handler is None:
            allow = ", ".join(sorted(set(routes) | ({"HEAD"} if "GET" in routes else set())))
            self._error(405, "Méthode non autorisée", head=head, close=True, headers={"Allow": allow})
            return
        body: dict = {}
        if method == "POST":
            if self.headers.get("X-Orion", "").strip() != "1":
                self._error(403, "Requête refusée : en-tête « X-Orion: 1 » manquant", close=True)
                return
            media_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if media_type != "application/json":
                self._error(403, "Requête refusée : « Content-Type: application/json » attendu", close=True)
                return
            try:
                body = self._read_json()
            except ApiError as error:
                self._error(error.status, error.message, close=True)
                return
        query = urllib.parse.parse_qs(self.path.split("#", 1)[0].partition("?")[2])
        try:
            result = handler(self.server.hardware, body, query)
        except ApiError as error:
            self._error(error.status, error.message, head=head)
            return
        except Exception:
            LOG.exception("Erreur sur %s %s", method, path)
            self._error(500, "Erreur interne du serveur Orion", head=head)
            return
        self._json(200, result, head=head)

    def _static(self, url_path: str, *, head: bool) -> None:
        parts = static_parts(url_path)
        target = resolve_static(self.server.root, parts) if parts else None
        if target is None:
            self._error(404, "Fichier introuvable", head=head)
            return
        try:
            with open(target, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise IsADirectoryError(target)
                etag = f'"{info.st_ino:x}-{info.st_size:x}-{info.st_mtime_ns:x}"'
                headers = {"Cache-Control": "no-cache", "ETag": etag}
                if etag in [tag.strip() for tag in self.headers.get("If-None-Match", "").split(",")]:
                    self.send_response(304)
                    for key, value in headers.items():
                        self.send_header(key, value)
                    self._end_headers()
                    return
                data = b"" if head else handle.read()
        except OSError:
            self._error(404, "Fichier introuvable", head=head)
            return
        content_type = MIME_TYPES.get(os.path.splitext(target)[1].lower(), "application/octet-stream")
        if head:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(info.st_size))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            for key, value in headers.items():
                self.send_header(key, value)
            self._end_headers()
            return
        self._send(200, data, content_type, headers=headers)


class OrionHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], root: str | os.PathLike[str], hardware: Any, allow_hosts: tuple[str, ...] = ()):
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, OrionHandler)
        self.root = str(root)
        self.hardware = hardware
        self.routes = dict(API_ROUTES)
        if getattr(hardware, "simulated", False):
            self.routes.update(SIMULATE_ROUTES)
        port = self.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if address[0] == "::1":
            hosts.add(f"[::1]:{port}")
        hosts.update(f"{h.lower()}:{port}" for h in allow_hosts)
        if port == 80:
            hosts.update(h.rsplit(":", 1)[0] for h in list(hosts))
        self.allowed_hosts = frozenset(hosts)


def make_server(root: str | os.PathLike[str], host: str, port: int, hardware: Any, allow_hosts: tuple[str, ...] = ()) -> OrionHTTPServer:
    return OrionHTTPServer((host, port), root, hardware, allow_hosts)


# --------------------------------------------------------------------------
# Mises à jour : sous-commande « sync »
# --------------------------------------------------------------------------


class SyncError(Exception):
    pass


SYNC_TOP_FILES = frozenset({"index.html", "manifest.webmanifest", "sw.js"})
SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._@+-]{0,127}")
RELEASE_NAME_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z._+-]{0,63}")
HASH_RE = re.compile(r"[0-9a-f]{64}")
MAX_MANIFEST = 4 * 1024 * 1024
MAX_SW = 2 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_FILES = 20_000


def compare_versions(a: Any, b: Any) -> int:
    """Comme compareVersions() de l'interface : « 1.10.0 » > « 1.9.2 »."""

    def parts(value: Any) -> list[int]:
        out = []
        for piece in str(value).split("."):
            try:
                out.append(int(piece))
            except ValueError:
                out.append(0)
        return out

    pa, pb = parts(a), parts(b)
    for i in range(max(len(pa), len(pb))):
        diff = (pa[i] if i < len(pa) else 0) - (pb[i] if i < len(pb) else 0)
        if diff:
            return 1 if diff > 0 else -1
    return 0


def manifest_parts(key: Any) -> list[str]:
    """Segments d'un chemin de version.json (« ./src/main.js »), sinon SyncError."""
    if not isinstance(key, str) or not key.startswith("./"):
        raise SyncError(f"Chemin refusé dans version.json : {key!r}")
    parts = key[2:].split("/")
    ok = 1 <= len(parts) <= 16 and all(SEGMENT_RE.fullmatch(p) for p in parts)
    if ok:
        ok = parts[0] in SYNC_TOP_FILES if len(parts) == 1 else parts[0] in STATIC_DIRS
    if not ok:
        raise SyncError(f"Chemin refusé dans version.json : {key!r}")
    return parts


def parse_manifest(manifest: Any) -> tuple[str, list[tuple[str, list[str], str, int]]]:
    if not isinstance(manifest, dict):
        raise SyncError("version.json invalide")
    version = manifest.get("version")
    if not isinstance(version, str) or not RELEASE_NAME_RE.fullmatch(version) or ".." in version:
        raise SyncError(f"Numéro de version refusé : {version!r}")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
        raise SyncError("Liste de fichiers absente ou invalide dans version.json")
    entries = []
    total = 0
    for key, meta in files.items():
        parts = manifest_parts(key)
        if not isinstance(meta, dict):
            raise SyncError(f"Description invalide pour {key}")
        digest, size = meta.get("hash"), meta.get("size")
        if not isinstance(digest, str) or not HASH_RE.fullmatch(digest):
            raise SyncError(f"Empreinte SHA-256 invalide pour {key}")
        if isinstance(size, bool) or not isinstance(size, int) or not 0 <= size <= MAX_FILE:
            raise SyncError(f"Taille invalide pour {key}")
        total += size
        entries.append((key, parts, digest, size))
    if total > MAX_TOTAL:
        raise SyncError("Version trop volumineuse")
    if "./index.html" not in files:
        raise SyncError("Version incomplète : index.html manquant")
    paths = {"/".join(p) for _, p, _, _ in entries}
    for _, parts, _, _ in entries:
        for i in range(1, len(parts)):
            if "/".join(parts[:i]) in paths:
                raise SyncError("Chemins incohérents dans version.json (fichier et dossier du même nom)")
    return version, entries


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def http_get(url: str, max_bytes: int, opener: urllib.request.OpenerDirector, timeout: float = 30.0) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": f"{BRIDGE_NAME}/{BRIDGE_VERSION} (sync)", "Cache-Control": "no-cache"})
    try:
        with opener.open(request, timeout=timeout) as response:
            if urllib.parse.urlsplit(url).scheme == "https" and urllib.parse.urlsplit(response.geturl()).scheme != "https":
                raise SyncError(f"Redirection non sécurisée refusée : {url}")
            if response.status != 200:
                raise SyncError(f"{url} : réponse HTTP {response.status}")
            data = response.read(max_bytes + 1)
    except urllib.error.HTTPError as error:
        raise SyncError(f"{url} : erreur HTTP {error.code}") from None
    except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
        reason = getattr(error, "reason", error)
        raise SyncError(f"Téléchargement impossible ({url}) : {reason}") from None
    if len(data) > max_bytes:
        raise SyncError(f"Fichier plus gros qu'annoncé : {url}")
    return data


def write_file(path: Path, data: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(path, 0o644)


def fsync_dir(path: Path) -> None:
    with contextlib.suppress(OSError):
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def switch_current(data: Path, target: str) -> None:
    """Fait pointer data/current vers target de façon atomique (rename d'un lien)."""
    temporary = data / f".current-{os.getpid()}"
    with contextlib.suppress(FileNotFoundError):
        temporary.unlink()
    os.symlink(target, temporary)
    os.replace(temporary, data / "current")
    fsync_dir(data)


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def sync_release(source: str, data_dir: str | os.PathLike[str], *, allow_downgrade: bool = False, opener: urllib.request.OpenerDirector | None = None) -> str:
    """Installe la dernière version publiée à côté de l'actuelle puis bascule dessus.

    1. version.json est téléchargé et validé (chemins, empreintes, tailles) ;
    2. chaque fichier est repris de la version actuelle si son empreinte est
       identique, sinon téléchargé, et toujours vérifié (SHA-256 et taille) ;
    3. la nouvelle version, complète, est renommée dans releases/<version>,
       puis le lien « current » est remplacé atomiquement ;
    4. la version précédente est gardée, les plus anciennes sont effacées.
    En cas d'erreur, rien de ce qui est servi ne change.
    """
    import fcntl  # Unix uniquement : importé ici pour que --simulate marche partout

    scheme = urllib.parse.urlsplit(source).scheme
    if scheme not in ("https", "http"):
        raise SyncError("La source doit être une adresse http(s)")
    if not source.endswith("/"):
        source += "/"
    opener = opener or urllib.request.build_opener()
    data = Path(data_dir)
    releases = data / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    current_link = data / "current"
    if current_link.exists() and not current_link.is_symlink():
        raise SyncError(f"{current_link} doit être un lien symbolique")

    lock_fd = os.open(data / ".sync.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SyncError("Une autre mise à jour est déjà en cours") from None

        stamp = int(time.time())
        raw = http_get(f"{source}version.json?t={stamp}", MAX_MANIFEST, opener)
        try:
            manifest = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise SyncError("version.json illisible") from None
        version, entries = parse_manifest(manifest)

        current_dir = Path(os.path.realpath(current_link)) if current_link.is_symlink() and current_link.exists() else None
        current_manifest: dict | None = None
        if current_dir is not None:
            with contextlib.suppress(OSError, ValueError):
                current_manifest = json.loads((current_dir / "version.json").read_text("utf-8"))
        if isinstance(current_manifest, dict):
            installed = current_manifest.get("version")
            if installed == version and current_manifest.get("files") == manifest.get("files"):
                return f"Orion OS {version} est à jour."
            if compare_versions(version, installed) < 0 and not allow_downgrade:
                return f"La version publiée ({version}) est plus ancienne que celle installée ({installed}) : rien n'est changé."

        name = version
        if current_dir is not None and current_dir == (releases / name).resolve():
            name = f"{version}-{sha256_bytes(raw)[:12]}"  # republiée sous le même numéro
        final = releases / name

        # Fichiers déjà présents (version actuelle), par empreinte.
        reusable: dict[str, Path] = {}
        if current_dir is not None and isinstance(current_manifest, dict) and isinstance(current_manifest.get("files"), dict):
            for key, meta in current_manifest["files"].items():
                try:
                    parts = manifest_parts(key)
                except SyncError:
                    continue
                if isinstance(meta, dict) and isinstance(meta.get("hash"), str):
                    reusable.setdefault(meta["hash"], current_dir.joinpath(*parts))

        staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=releases))
        try:
            downloaded = reused = downloaded_bytes = 0
            for key, parts, digest, size in entries:
                dest = staging.joinpath(*parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                local = reusable.get(digest)
                if local is not None and local.is_file() and not local.is_symlink() and local.stat().st_size == size and sha256_file(local) == digest:
                    shutil.copyfile(local, dest)
                    os.chmod(dest, 0o644)
                    reused += 1
                    continue
                url = source + "/".join(urllib.parse.quote(p) for p in parts) + f"?v={digest[:16]}"
                content = http_get(url, size, opener)
                if len(content) != size or sha256_bytes(content) != digest:
                    raise SyncError(f"Fichier altéré ou incomplet : {key[2:]} (empreinte ou taille inattendue). Publication en cours ? Nouvel essai à la prochaine vérification.")
                write_file(dest, content)
                downloaded += 1
                downloaded_bytes += size
            if "./sw.js" not in manifest["files"]:
                # sw.js n'est pas listé dans version.json : téléchargé à part (HTTPS).
                write_file(staging / "sw.js", http_get(f"{source}sw.js?t={stamp}", MAX_SW, opener))
            write_file(staging / "version.json", raw)
            for directory in sorted({p.parent for p in staging.rglob("*")} | {staging}, key=lambda p: len(p.parts), reverse=True):
                os.chmod(directory, 0o755)
                fsync_dir(directory)
            if final.exists() or final.is_symlink():
                _remove(final)
            os.rename(staging, final)
            fsync_dir(releases)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise

        switch_current(data, f"releases/{name}")
        keep = {name}
        if current_dir is not None and current_dir.parent == releases.resolve():
            keep.add(current_dir.name)
        for entry in releases.iterdir():
            if entry.name not in keep:
                with contextlib.suppress(OSError):
                    _remove(entry)
        for entry in data.glob(".current-*"):
            with contextlib.suppress(OSError):
                entry.unlink()
        return (
            f"Orion OS {version} installée dans {final} : {downloaded} fichier(s) téléchargé(s) "
            f"({downloaded_bytes // 1024} Ko), {reused} repris de la version précédente. "
            "Orion proposera la mise à jour dans Réglages."
        )
    finally:
        os.close(lock_fd)


def sync_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="orion_server.py sync",
        description="Télécharge et vérifie la dernière version publiée d'Orion OS, puis la rend disponible à l'interface.",
    )
    parser.add_argument("--source", default=DEFAULT_SOURCE, help=f"adresse de publication (défaut : {DEFAULT_SOURCE})")
    parser.add_argument("--data", default=DEFAULT_DATA, help=f"dossier des versions (défaut : {DEFAULT_DATA})")
    parser.add_argument("--allow-downgrade", action="store_true", help="accepter une version plus ancienne que l'installée")
    args = parser.parse_args(argv)
    try:
        message = sync_release(args.source, args.data, allow_downgrade=args.allow_downgrade)
    except SyncError as error:
        print(f"Échec de la mise à jour : {error}", file=sys.stderr)
        return 1
    except OSError as error:  # disque plein, droits…
        print(f"Échec de la mise à jour : {error.strerror or error} ({error.filename or args.data})", file=sys.stderr)
        return 1
    print(message)
    return 0


# --------------------------------------------------------------------------
# Lancement
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    if argv and argv[0] == "sync":
        return sync_main(argv[1:])
    parser = argparse.ArgumentParser(
        prog="orion_server.py",
        description="Sert Orion OS et relie l'interface au matériel (Wi-Fi, Bluetooth, modem, GPS, alimentation). "
        "Sous-commande : « sync » pour les mises à jour (voir « sync --help »).",
    )
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="dossier contenant index.html (défaut : le dépôt)")
    parser.add_argument("--host", default="127.0.0.1", help="adresse d'écoute (défaut : 127.0.0.1, déconseillé de changer)")
    parser.add_argument("--port", type=int, default=8080, help="port d'écoute (défaut : 8080)")
    parser.add_argument("--simulate", action="store_true", help="imiter tout le matériel (développement)")
    parser.add_argument(
        "--allow-host", action="append", default=[], metavar="NOM", help="nom d'hôte supplémentaire accepté dans l'en-tête Host (avec --host)"
    )
    args = parser.parse_args(argv)
    if not os.path.isfile(os.path.join(os.path.realpath(args.root), "index.html")):
        LOG.warning("Pas d'index.html dans %s : l'interface ne sera pas servie", args.root)
    hardware: Any = SimulatedHardware() if args.simulate else RealHardware()
    try:
        server = make_server(args.root, args.host, args.port, hardware, tuple(args.allow_host))
    except OSError as error:
        LOG.error("Impossible d'écouter sur %s:%s : %s", args.host, args.port, error)
        return 1
    mode = "matériel simulé" if args.simulate else "matériel réel"
    shown = f"[{args.host}]" if ":" in args.host else args.host
    LOG.info("Orion OS servi sur http://%s:%s/ (%s, racine %s)", shown, server.server_address[1], mode, args.root)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
