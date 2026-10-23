"""Tests d'orion-server : python3 -m unittest discover -s server -v

Aucun matériel n'est nécessaire : les outils système (nmcli, bluetoothctl,
mmcli) sont remplacés par un faux qui renvoie des sorties réelles
enregistrées, gpsd par un faux serveur TCP, et le serveur HTTP tourne pour de
vrai sur un port libre.
"""

from __future__ import annotations

import functools
import hashlib
import http.client
import json
import os
import socket
import socketserver
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import orion_server as osv  # noqa: E402
from orion_server import ApiError, CommandResult  # noqa: E402

# ---------------------------------------------------------------------------
# Faux outils système
# ---------------------------------------------------------------------------


class FakeRunner:
    """Remplace CommandRunner : règles (préfixe d'arguments → résultat)."""

    def __init__(self, rules=(), tools=("nmcli", "bluetoothctl", "mmcli", "systemctl")):
        self.rules = list(rules)
        self.tools = set(tools)
        self.calls: list[list[str]] = []
        self.lock = threading.Lock()

    def add(self, prefix, result):
        self.rules.insert(0, (tuple(prefix), result))

    def which(self, name):
        return name in self.tools

    def run(self, args, timeout=10.0):
        assert isinstance(args, list) and all(isinstance(a, str) for a in args), args
        with self.lock:
            self.calls.append(list(args))
        for prefix, result in self.rules:
            if tuple(args[: len(prefix)]) == prefix:
                return result(args) if callable(result) else result
        return CommandResult(1, "", f"commande inattendue : {args}")

    def called(self, *prefix):
        return [c for c in self.calls if tuple(c[: len(prefix)]) == prefix]


def ok(stdout="", stderr=""):
    return CommandResult(0, stdout, stderr)


# Sorties de nmcli 1.42 (Debian 12), mode « terse » : « : » et « \ » échappés.
NM_WIFI_LIST = (
    "*:Maison:72:WPA2:5180 MHz\n"
    " :Maison:54:WPA2:2437 MHz\n"
    ":Café\\:Wifi:60::2412 MHz\n"
    ":Livebox-7A3F:80:WPA1 WPA2:2462 MHz\n"
    "::40:WPA2:2412 MHz\n"
    ":Réseau d'Élise:30:WPA3:5500 MHz\n"
    ":Back\\\\slash:20:--:2412 MHz\n"
    ":Livebox-7A3F:41:WPA1 WPA2:5240 MHz\n"
)
UUID_MAISON = "6f1b5d2c-1111-4c3b-9d6e-0a1b2c3d4e5f"
UUID_CAFE = "0d6c1f3e-2222-4b8a-8e1f-9a8b7c6d5e4f"
UUID_ETH = "a1b2c3d4-3333-4d5e-9f00-112233445566"
UUID_NEW = "deadbeef-4444-4aaa-8bbb-cccccccccccc"
UUID_GSM = "feedface-5555-4abc-9def-000000000001"
NM_CONNECTIONS = (
    f"Maison:{UUID_MAISON}:802-11-wireless\n"
    f"Wired connection 1:{UUID_ETH}:802-3-ethernet\n"
    f"Café\\:Wifi:{UUID_CAFE}:802-11-wireless\n"
)
NM_DEVICES = (
    "wlp2s0:wifi:connected:Maison\n"
    "enp3s0:ethernet:unavailable:\n"
    "p2p-dev-wlp2s0:wifi-p2p:disconnected:\n"
    "lo:loopback:connected (externally):lo\n"
)


def nm_runner(**overrides):
    runner = FakeRunner()
    runner.add(("nmcli", "-t", "-f", "RUNNING", "general"), ok("running\n"))
    runner.add(("nmcli", "radio", "wifi"), ok("enabled\n"))
    runner.add(("nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY,FREQ", "device", "wifi", "list"), ok(NM_WIFI_LIST))
    runner.add(("nmcli", "-t", "-f", "NAME,UUID,TYPE", "connection", "show"), ok(overrides.get("connections", NM_CONNECTIONS)))
    runner.add(("nmcli", "-t", "-g", "802-11-wireless.ssid", "connection", "show", "uuid", UUID_MAISON), ok("Maison\n"))
    runner.add(("nmcli", "-t", "-g", "802-11-wireless.ssid", "connection", "show", "uuid", UUID_CAFE), ok("Café\\:Wifi\n"))
    runner.add(("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"), ok(overrides.get("devices", NM_DEVICES)))
    runner.add(("nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "wlp2s0"), ok("IP4.ADDRESS[1]:192.168.1.23/24\n"))
    runner.add(("nmcli", "-t", "-f", "TYPE,STATE", "connection", "show", "--active"), ok("802-11-wireless:activated\n"))
    return runner


class TerseParsingTest(unittest.TestCase):
    def test_split_terse_escapes(self):
        self.assertEqual(osv.split_terse("a\\:b:c\\\\d:"), ["a:b", "c\\d", ""])
        self.assertEqual(osv.split_terse("AA\\:BB\\:CC:x"), ["AA:BB:CC", "x"])
        self.assertEqual(osv.unescape_terse("Café\\:Wifi"), "Café:Wifi")

    def test_wifi_list_merges_sorts_and_skips_hidden(self):
        networks = osv.parse_wifi_list(NM_WIFI_LIST, {"Maison": ["x"]})
        self.assertEqual([n["ssid"] for n in networks], ["Maison", "Livebox-7A3F", "Café:Wifi", "Réseau d'Élise", "Back\\slash"])
        maison = networks[0]
        self.assertEqual((maison["signal"], maison["frequency"], maison["active"], maison["known"]), (72, 5180, True, True))
        livebox = networks[1]
        self.assertEqual((livebox["signal"], livebox["frequency"], livebox["security"]), (80, 2462, "WPA1 WPA2"))
        self.assertEqual(networks[2]["security"], "")
        self.assertEqual(networks[4]["security"], "")  # « -- » = ouvert

    def test_active_access_point_wins_over_stronger_one(self):
        output = ":Maison:90:WPA2:2437 MHz\n*:Maison:50:WPA2:5180 MHz\n"
        (network,) = osv.parse_wifi_list(output, {})
        self.assertEqual((network["signal"], network["frequency"], network["active"]), (50, 5180, True))


class WifiBackendTest(unittest.TestCase):
    def test_state_with_connected_network_and_known_ssids(self):
        runner = nm_runner()
        state = osv.NetworkManagerBackend(runner).wifi_state(rescan=True)
        self.assertTrue(state["enabled"])
        self.assertEqual(state["connected"], {"ssid": "Maison", "signal": 72, "security": "WPA2", "frequency": 5180, "ip": "192.168.1.23"})
        known = {n["ssid"]: n["known"] for n in state["networks"]}
        self.assertTrue(known["Café:Wifi"])  # SSID du profil, « : » déséchappé
        self.assertFalse(known["Livebox-7A3F"])
        self.assertTrue(runner.called("nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY,FREQ", "device", "wifi", "list", "--rescan", "yes"))

    def test_disabled_radio(self):
        runner = nm_runner()
        runner.add(("nmcli", "radio", "wifi"), ok("disabled\n"))
        self.assertEqual(osv.NetworkManagerBackend(runner).wifi_state(), {"enabled": False, "connected": None, "networks": []})

    def test_wrong_password_is_reported_and_new_profile_removed(self):
        runner = nm_runner()
        state = {"attempted": False}

        def connections(args):
            extra = f"Livebox-7A3F:{UUID_NEW}:802-11-wireless\n" if state["attempted"] else ""
            return ok(NM_CONNECTIONS + extra)

        def connect(args):
            state["attempted"] = True
            return CommandResult(4, "", "Error: Connection activation failed: (7) Secrets were required, but not provided.\n")

        runner.add(("nmcli", "-t", "-f", "NAME,UUID,TYPE", "connection", "show"), connections)
        runner.add(("nmcli", "--wait", "45", "device", "wifi", "connect"), connect)
        runner.add(("nmcli", "-t", "-g", "802-11-wireless.ssid", "connection", "show", "uuid", UUID_NEW), ok("Livebox-7A3F\n"))
        runner.add(("nmcli", "connection", "delete", "uuid", UUID_NEW), ok())
        with self.assertRaises(ApiError) as ctx:
            osv.NetworkManagerBackend(runner).wifi_connect("Livebox-7A3F", "mauvais mdp", False)
        self.assertEqual((ctx.exception.status, ctx.exception.message), (400, "Mot de passe incorrect"))
        (call,) = runner.called("nmcli", "--wait", "45", "device", "wifi", "connect")
        self.assertEqual(call, ["nmcli", "--wait", "45", "device", "wifi", "connect", "Livebox-7A3F", "password", "mauvais mdp"])
        self.assertTrue(runner.called("nmcli", "connection", "delete", "uuid", UUID_NEW))

    def test_unknown_network(self):
        runner = nm_runner()
        runner.add(("nmcli", "--wait", "45", "device", "wifi", "connect"), CommandResult(10, "", "Error: No network with SSID 'Nulle part' found.\n"))
        with self.assertRaises(ApiError) as ctx:
            osv.NetworkManagerBackend(runner).wifi_connect("Nulle part", "motdepasse", False)
        self.assertEqual((ctx.exception.status, ctx.exception.message), (404, "Réseau introuvable"))

    def test_secured_unknown_network_without_password(self):
        runner = nm_runner()
        with self.assertRaises(ApiError) as ctx:
            osv.NetworkManagerBackend(runner).wifi_connect("Livebox-7A3F", None, False)
        self.assertEqual((ctx.exception.status, ctx.exception.message), (400, "Mot de passe requis"))
        self.assertFalse(runner.called("nmcli", "--wait", "45", "device", "wifi", "connect"))

    def test_connect_open_network_with_special_characters(self):
        runner = nm_runner()
        runner.add(("nmcli", "--wait", "45", "device", "wifi", "connect"), ok("Device 'wlp2s0' successfully activated.\n"))
        osv.NetworkManagerBackend(runner).wifi_connect("Réseau d'Élise; rm -rf /", None, True)
        (call,) = runner.called("nmcli", "--wait", "45", "device", "wifi", "connect")
        self.assertEqual(call[6:], ["Réseau d'Élise; rm -rf /", "hidden", "yes"])

    def test_known_network_uses_saved_profile(self):
        runner = nm_runner()
        runner.add(("nmcli", "--wait", "45", "connection", "up", "uuid", UUID_CAFE), ok("Connection successfully activated\n"))
        osv.NetworkManagerBackend(runner).wifi_connect("Café:Wifi", None, False)
        self.assertTrue(runner.called("nmcli", "--wait", "45", "connection", "up", "uuid", UUID_CAFE))

    def test_forget_and_disconnect(self):
        runner = nm_runner()
        runner.add(("nmcli", "connection", "delete", "uuid", UUID_MAISON), ok())
        runner.add(("nmcli", "device", "disconnect", "wlp2s0"), ok())
        backend = osv.NetworkManagerBackend(runner)
        backend.wifi_forget("Maison")
        backend.wifi_disconnect()
        self.assertTrue(runner.called("nmcli", "connection", "delete", "uuid", UUID_MAISON))
        self.assertTrue(runner.called("nmcli", "device", "disconnect", "wlp2s0"))
        with self.assertRaises(ApiError) as ctx:
            backend.wifi_forget("Inconnu")
        self.assertEqual(ctx.exception.status, 404)

    def test_not_authorized(self):
        runner = nm_runner()
        runner.add(("nmcli", "radio", "wifi", "off"), CommandResult(1, "", "Error: Not authorized to change Wi-Fi state.\n"))
        with self.assertRaises(ApiError) as ctx:
            osv.NetworkManagerBackend(runner).wifi_power(False)
        self.assertEqual(ctx.exception.status, 403)

    def test_network_summary(self):
        runner = nm_runner()
        runner.add(("nmcli", "networking", "connectivity"), ok("full\n"))
        state = osv.NetworkManagerBackend(runner).network_state()
        self.assertEqual(state, {"connectivity": "full", "primary": {"type": "wifi", "name": "Maison", "device": "wlp2s0", "ip": "192.168.1.23"}})
        runner = nm_runner(devices="enp3s0:ethernet:connected:Wired connection 1\nlo:loopback:connected (externally):lo\n")
        runner.add(("nmcli", "networking", "connectivity"), ok("portal\n"))
        runner.add(("nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "enp3s0"), ok("IP4.ADDRESS[1]:10.0.2.15/24\n"))
        state = osv.NetworkManagerBackend(runner).network_state()
        self.assertEqual(state["connectivity"], "portal")
        self.assertEqual(state["primary"]["type"], "ethernet")
        self.assertEqual(state["primary"]["ip"], "10.0.2.15")
        runner = nm_runner(devices="lo:loopback:connected (externally):lo\n")
        runner.add(("nmcli", "networking", "connectivity"), ok("none\n"))
        self.assertEqual(osv.NetworkManagerBackend(runner).network_state(), {"connectivity": "none", "primary": None})

    def test_mobile_data_creates_profile_with_apn(self):
        runner = nm_runner()
        runner.add(
            ("nmcli", "connection", "add", "type", "gsm"),
            ok(f"Connection 'orion-mobile' ({UUID_GSM}) successfully added.\n"),
        )
        runner.add(("nmcli", "--wait", "60", "connection", "up", "uuid", UUID_GSM), ok())
        osv.NetworkManagerBackend(runner).mobile_data(True, "free")
        (add,) = runner.called("nmcli", "connection", "add")
        self.assertEqual(add[4:], ["gsm", "ifname", "*", "con-name", "orion-mobile", "connection.autoconnect", "yes", "gsm.apn", "free"])
        self.assertTrue(runner.called("nmcli", "--wait", "60", "connection", "up", "uuid", UUID_GSM))


# --- Bluetooth --------------------------------------------------------------

BT_SHOW = (
    "Agent registered\n"
    "Controller 00:1A:7D:DA:71:13 (public)\n"
    "\tName: orion\n\tAlias: orion\n\tClass: 0x006c0104\n\tPowered: yes\n\tDiscoverable: no\n"
    "\tPairable: yes\n\tUUID: Generic Attribute Profile (00001801-0000-1000-8000-00805f9b34fb)\n"
    "\tModalias: usb:v1D6Bp0246d0542\n\tDiscovering: no\n\tRoles: central\n"
)
BT_DEVICES = (
    "\x1b[0;94m[bluetooth]\x1b[0m# Device 11:22:33:44:55:66 Écouteurs\n"
    "Device 11:22:33:44:55:66 Écouteurs\n"
    "Device AA:BB:CC:DD:EE:FF Clavier\n"
    "Device 5C:5C:5C:5C:5C:5C 5C-5C-5C-5C-5C-5C\n"
    "Device 01:02:03:04:05:06 Zèbre\n"
    "Device 11:22:33:44:55:66 Écouteurs\n"
    "[\x1b[0;93mCHG\x1b[0m] Device 11:22:33:44:55:66 RSSI: -60\n"
)
BT_INFO = {
    "11:22:33:44:55:66": (
        "Device 11:22:33:44:55:66 (public)\n\tName: WH-1000XM4\n\tAlias: Écouteurs\n\tClass: 0x00240404\n"
        "\tIcon: audio-headset\n\tPaired: yes\n\tBonded: yes\n\tTrusted: yes\n\tBlocked: no\n\tConnected: yes\n"
        "\tLegacyPairing: no\n\tUUID: Audio Sink                (0000110b-0000-1000-8000-00805f9b34fb)\n"
        "\tBattery Percentage: 0x50 (80)\n"
    ),
    "AA:BB:CC:DD:EE:FF": (
        "Device AA:BB:CC:DD:EE:FF (random)\n\tName: Clavier\n\tAlias: Clavier\n\tIcon: input-keyboard\n"
        "\tPaired: no\n\tTrusted: no\n\tBlocked: no\n\tConnected: no\n\tRSSI: -71\n"
    ),
    "5C:5C:5C:5C:5C:5C": "Device 5C:5C:5C:5C:5C:5C (random)\n\tAlias: 5C-5C-5C-5C-5C-5C\n\tPaired: no\n\tConnected: no\n",
    "01:02:03:04:05:06": "Device 01:02:03:04:05:06 (public)\n\tName: Zèbre\n\tAlias: Zèbre\n\tPaired: no\n\tConnected: no\n",
}


def bt_runner():
    runner = FakeRunner()
    runner.add(("bluetoothctl", "show"), ok(BT_SHOW))
    runner.add(("bluetoothctl", "devices"), ok(BT_DEVICES))
    runner.add(("bluetoothctl", "info"), lambda args: ok(BT_INFO[args[2]]) if args[2] in BT_INFO else ok("Device %s not available\n" % args[2]))
    return runner


class BluetoothBackendTest(unittest.TestCase):
    def test_state(self):
        state = osv.BluetoothBackend(bt_runner()).state()
        self.assertTrue(state["available"])
        self.assertTrue(state["powered"])
        self.assertFalse(state["discovering"])
        names = [d["name"] for d in state["devices"]]
        self.assertEqual(names, ["Écouteurs", "Clavier", "Zèbre"])  # appairés d'abord, anonymes ignorés
        first = state["devices"][0]
        self.assertEqual(first, {"address": "11:22:33:44:55:66", "name": "Écouteurs", "paired": True, "connected": True, "trusted": True, "icon": "audio-headset", "battery": 80})
        self.assertNotIn("battery", state["devices"][1])

    def test_no_controller(self):
        runner = FakeRunner()
        runner.add(("bluetoothctl", "show"), CommandResult(0, "No default controller available\n"))
        self.assertEqual(osv.BluetoothBackend(runner).state(), {"available": False, "powered": False, "discovering": False, "devices": []})
        runner = FakeRunner(tools=())
        self.assertFalse(osv.BluetoothBackend(runner).available())

    def test_battery_parsing(self):
        self.assertEqual(osv.parse_battery("0x50 (80)"), 80)
        self.assertEqual(osv.parse_battery("0x64"), 100)
        self.assertIsNone(osv.parse_battery("0xff (255)"))
        self.assertIsNone(osv.parse_battery(None))

    def test_scan_runs_in_background(self):
        runner = bt_runner()
        runner.add(("bluetoothctl", "--timeout"), ok("Discovery started\n"))
        backend = osv.BluetoothBackend(runner)
        backend.scan(12)
        backend._scan_thread.join(5)
        self.assertEqual(runner.called("bluetoothctl", "--timeout"), [["bluetoothctl", "--timeout", "12", "scan", "on"]])
        self.assertTrue(backend.scanning())  # pendant les 12 s annoncées

    def test_pair_trust_connect_errors(self):
        runner = bt_runner()
        runner.add(("bluetoothctl", "--agent", "NoInputNoOutput", "pair"), ok("Attempting to pair with AA:BB:CC:DD:EE:FF\nPairing successful\n"))
        runner.add(("bluetoothctl", "trust"), ok("Changing AA:BB:CC:DD:EE:FF trust succeeded\n"))
        runner.add(("bluetoothctl", "connect"), CommandResult(1, "Attempting to connect to AA:BB:CC:DD:EE:FF\nFailed to connect: org.bluez.Error.Failed br-connection-page-timeout\n"))
        backend = osv.BluetoothBackend(runner)
        backend.pair("AA:BB:CC:DD:EE:FF")
        self.assertTrue(runner.called("bluetoothctl", "trust", "AA:BB:CC:DD:EE:FF"))
        with self.assertRaises(ApiError) as ctx:
            backend.connect("AA:BB:CC:DD:EE:FF")
        self.assertEqual(ctx.exception.status, 504)
        runner.add(("bluetoothctl", "remove"), ok("Device 99:99:99:99:99:99 not available\n"))
        with self.assertRaises(ApiError) as ctx:
            backend.remove("99:99:99:99:99:99")
        self.assertEqual(ctx.exception.status, 404)

    def test_mac_validation(self):
        self.assertEqual(osv.valid_mac({"address": "aa:bb:cc:dd:ee:ff"}), "AA:BB:CC:DD:EE:FF")
        for bad in ("AA:BB:CC:DD:EE", "AA-BB-CC-DD-EE-FF", "AA:BB:CC:DD:EE:FF\n", "AA:BB:CC:DD:EE:FG", "; reboot", "", 12, None):
            with self.assertRaises(ApiError, msg=repr(bad)):
                osv.valid_mac({"address": bad})


# --- Modem --------------------------------------------------------------------

MM_LIST = json.dumps({"modem-list": ["/org/freedesktop/ModemManager1/Modem/0"]})
MM_MODEM = json.dumps({
    "modem": {
        "3gpp": {"imei": "356938035643809", "operator-code": "20801", "operator-name": "Orange F", "registration-state": "home", "packet-service-state": "attached"},
        "dbus-path": "/org/freedesktop/ModemManager1/Modem/0",
        "generic": {
            "access-technologies": ["umts", "lte"],
            "manufacturer": "Quectel",
            "model": "EG25",
            "own-numbers": ["+33612345678"],
            "power-state": "on",
            "signal-quality": {"recent": "yes", "value": "64"},
            "sim": "/org/freedesktop/ModemManager1/SIM/0",
            "state": "connected",
            "state-failed-reason": "--",
        },
    }
})
MM_CALLS = json.dumps({"modem.voice.call": ["/org/freedesktop/ModemManager1/Call/3", "/org/freedesktop/ModemManager1/Call/4", "/org/freedesktop/ModemManager1/Call/5"]})
MM_CALL = {
    "3": {"direction": "incoming", "number": "+33611111111", "state": "ringing-in", "state-reason": "incoming-new"},
    "4": {"direction": "outgoing", "number": "+33622222222", "state": "ringing-out", "state-reason": "outgoing-started"},
    "5": {"direction": "outgoing", "number": "3654", "state": "terminated", "state-reason": "terminated"},
}
MM_SMS_LIST = json.dumps({"modem.messaging.sms": ["/org/freedesktop/ModemManager1/SMS/12", "/org/freedesktop/ModemManager1/SMS/3"]})
MM_SMS = {
    "3": {"content": {"data": "--", "number": "+33699999999", "text": "Rendez-vous à 18 h, d'accord ?"}, "properties": {"state": "received", "timestamp": "2026-10-22T10:00:00+02", "pdu-type": "deliver"}},
    "12": {"content": {"data": "--", "number": "+33699999999", "text": "Oui"}, "properties": {"state": "sent", "timestamp": "--", "pdu-type": "submit"}},
}


def mm_runner():
    runner = nm_runner()
    runner.add(("mmcli", "-L", "-J"), ok(MM_LIST))
    runner.add(("mmcli", "-m", "0", "-J"), ok(MM_MODEM))
    runner.add(("mmcli", "-m", "0", "--voice-list-calls", "-J"), ok(MM_CALLS))
    runner.add(("mmcli", "-o"), lambda args: ok(json.dumps({"call": {"dbus-path": f"/org/freedesktop/ModemManager1/Call/{args[2]}", "detail": MM_CALL[args[2]]}})) if args[3] == "-J" else ok("successfully done\n"))
    runner.add(("mmcli", "-m", "0", "--messaging-list-sms", "-J"), ok(MM_SMS_LIST))
    runner.add(("mmcli", "-s"), lambda args: ok(json.dumps({"sms": MM_SMS[args[2]]})) if args[3] == "-J" else ok("successfully sent the SMS\n"))
    runner.add(("nmcli", "-t", "-f", "TYPE,STATE", "connection", "show", "--active"), ok("802-11-wireless:activated\ngsm:activated\n"))
    return runner


def parse_mm_key_values(text):
    """Analyse « clé=valeur,… » comme mm_common_parse_key_value_string() de ModemManager."""
    result, i, n = {}, 0, len(text)
    while True:
        while i < n and text[i].isspace():
            i += 1
        if i >= n:
            return result
        start = i
        while i < n and (text[i].isalnum() or text[i] in "-_"):
            i += 1
        key = text[start:i]
        while i < n and text[i].isspace():
            i += 1
        if not key or i >= n or text[i] != "=":
            raise ValueError("clé invalide")
        i += 1
        while i < n and text[i].isspace():
            i += 1
        if i < n and text[i] in "'\"":
            end = text.find(text[i], i + 1)
            if end < 0:
                raise ValueError("guillemets non fermés")
            value, i = text[i + 1 : end], end + 1
        else:
            end = text.find(",", i)
            end = n if end < 0 else end
            value, i = text[i:end].rstrip(), end
        result[key] = value
        while i < n and text[i].isspace():
            i += 1
        if i >= n:
            return result
        if text[i] != ",":
            raise ValueError("contenu inattendu après une valeur")
        i += 1


class ModemBackendTest(unittest.TestCase):
    def test_state(self):
        state = osv.ModemBackend(mm_runner(), osv.NetworkManagerBackend(mm_runner())).state()
        self.assertEqual(state, {
            "available": True, "state": "connected", "operator": "Orange F", "signal": 64, "technology": "lte",
            "sim": True, "number": "+33612345678", "registration": "home", "enabled": True, "data": True,
        })

    def test_no_modem(self):
        runner = FakeRunner()
        runner.add(("mmcli", "-L", "-J"), ok(json.dumps({"modem-list": []})))
        self.assertEqual(osv.ModemBackend(runner, osv.NetworkManagerBackend(runner)).state(), {"available": False})
        runner = FakeRunner()
        runner.add(("mmcli", "-L"), CommandResult(1, "", "error: couldn't find the ModemManager process in the bus\n"))
        self.assertFalse(osv.ModemBackend(runner, osv.NetworkManagerBackend(runner)).available())

    def test_calls_states_are_mapped(self):
        runner = mm_runner()
        calls = osv.ModemBackend(runner, osv.NetworkManagerBackend(runner)).calls()
        self.assertEqual(calls, [
            {"id": "3", "number": "+33611111111", "direction": "incoming", "state": "ringing"},
            {"id": "4", "number": "+33622222222", "direction": "outgoing", "state": "dialing"},
            {"id": "5", "number": "3654", "direction": "outgoing", "state": "terminated"},
        ])

    def test_dial_answer_hangup(self):
        runner = mm_runner()
        runner.add(("mmcli", "-m", "0", "--voice-create-call=number=+33612345678"), ok("Successfully created new call: /org/freedesktop/ModemManager1/Call/7\n"))
        backend = osv.ModemBackend(runner, osv.NetworkManagerBackend(runner))
        self.assertEqual(backend.dial("+33612345678"), "7")
        self.assertTrue(runner.called("mmcli", "-o", "7", "--start"))
        backend.answer("3")
        self.assertTrue(runner.called("mmcli", "-o", "3", "--accept"))
        backend.hangup("3")
        self.assertTrue(runner.called("mmcli", "-o", "3", "--hangup"))
        runner.add(("mmcli", "-m", "0", "--voice-hangup-all"), ok())
        backend.hangup(None)
        self.assertTrue(runner.called("mmcli", "-m", "0", "--voice-hangup-all"))

    def test_sms_list(self):
        runner = mm_runner()
        messages = osv.ModemBackend(runner, osv.NetworkManagerBackend(runner)).messages()
        self.assertEqual(messages, [
            {"id": "3", "number": "+33699999999", "text": "Rendez-vous à 18 h, d'accord ?", "timestamp": "2026-10-22T10:00:00+02:00", "state": "received"},
            {"id": "12", "number": "+33699999999", "text": "Oui", "timestamp": None, "state": "sent"},
        ])

    def test_sms_text_is_passed_safely(self):
        texts = [
            "Bonjour, ça va ?",
            "L'été arrive",
            'Il a dit "salut", puis est parti',
            "Ligne 1\nLigne 2, avec virgule = égal",
            "  espaces  ",
            "--messaging-delete-sms=0",
            "$(reboot) `id` ; rm -rf / && echo",
        ]
        for text in texts:
            runner = mm_runner()
            created = []

            def create(args, created=created):
                created.append(args)
                return ok("Successfully created new SMS: /org/freedesktop/ModemManager1/SMS/21\n")

            runner.add(("mmcli", "-m", "0"), lambda args, create=create: create(args) if args[3].startswith("--messaging-create-sms=") else ok())
            osv.ModemBackend(runner, osv.NetworkManagerBackend(runner)).send_sms("+33612345678", text)
            (args,) = created
            self.assertEqual(len(args), 4, args)
            spec = args[3][len("--messaging-create-sms="):]
            self.assertEqual(parse_mm_key_values(spec), {"number": "+33612345678", "text": text})
            self.assertTrue(runner.called("mmcli", "-s", "21", "--send"))
        both = "L'été \"chaud\""
        self.assertEqual(parse_mm_key_values("text=" + osv.mm_quote(both))["text"], "L’été \"chaud\"")

    def test_failed_send_deletes_draft(self):
        runner = mm_runner()

        def modem(args):
            if args[3].startswith("--messaging-create-sms="):
                return ok("Successfully created new SMS: /org/freedesktop/ModemManager1/SMS/22\n")
            return ok()

        runner.add(("mmcli", "-m", "0"), modem)
        runner.add(("mmcli", "-s", "22", "--send"), CommandResult(1, "", "error: couldn't send the SMS: 'GDBus.Error:org.freedesktop.ModemManager1.Error.Core.WrongState: not registered'\n"))
        with self.assertRaises(ApiError) as ctx:
            osv.ModemBackend(runner, osv.NetworkManagerBackend(runner)).send_sms("+33612345678", "test")
        self.assertEqual(ctx.exception.status, 409)
        self.assertTrue(runner.called("mmcli", "-m", "0", "--messaging-delete-sms=22"))

    def test_phone_validation(self):
        self.assertEqual(osv.valid_phone({"number": "+33 6 12 34 56 78"}), "+33612345678")
        self.assertEqual(osv.valid_phone({"number": "06.12.34.56.78"}), "0612345678")
        self.assertEqual(osv.valid_phone({"number": "*#06#"}), "*#06#")
        for bad in ("12a", "+33612345678;reboot", "", "1" * 21, "++33", "+33\n6", 336, "number='x'"):
            with self.assertRaises(ApiError, msg=repr(bad)):
                osv.valid_phone({"number": bad})

    def test_ids(self):
        self.assertEqual(osv.valid_id({"id": "3"}), "3")
        self.assertEqual(osv.valid_id({"id": 12}), "12")
        self.assertIsNone(osv.valid_id({}, required=False))
        for bad in ("1234567", "-1", "3 ", "../3", True, None):
            with self.assertRaises(ApiError, msg=repr(bad)):
                osv.valid_id({"id": bad})


# --- GPS ----------------------------------------------------------------------


class FakeGpsd(socketserver.ThreadingTCPServer):
    """Faux gpsd : VERSION à la connexion, DEVICES/WATCH puis POLL."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, devices, tpv, sky):
        self.devices, self.tpv, self.sky = devices, tpv, sky
        self.commands = []
        super().__init__(("127.0.0.1", 0), FakeGpsdHandler)
        threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()


class FakeGpsdHandler(socketserver.StreamRequestHandler):
    def send(self, message):
        self.wfile.write(json.dumps(message).encode() + b"\r\n")

    def handle(self):
        try:
            self.converse()
        except OSError:
            pass  # le client ferme la connexion dès qu'il a sa réponse

    def converse(self):
        server = self.server
        self.send({"class": "VERSION", "release": "3.22", "rev": "3.22", "proto_major": 3, "proto_minor": 14})
        for raw in self.rfile:
            line = raw.decode().strip()
            server.commands.append(line)
            if line.startswith("?WATCH="):
                self.send({"class": "DEVICES", "devices": server.devices})
                self.send({"class": "WATCH", "enable": True, "json": True})
                if server.tpv:
                    self.send({"class": "SKY", "device": "/dev/ttyACM0", "satellites": [{"PRN": 1, "used": True}, {"PRN": 2, "used": False}]})
            elif line.startswith("?POLL;"):
                self.send({"class": "POLL", "time": "2026-10-22T10:00:00.000Z", "active": len(server.devices), "tpv": [server.tpv] if server.tpv else [], "sky": [server.sky] if server.sky else []})


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class GpsTest(unittest.TestCase):
    DEVICE = [{"class": "DEVICE", "path": "/dev/ttyACM0", "driver": "u-blox", "activated": "2026-10-22T09:59:00.000Z"}]
    TPV = {"class": "TPV", "device": "/dev/ttyACM0", "mode": 3, "time": "2026-10-22T10:00:00.000Z", "lat": 48.85661234, "lon": 2.35221987, "altHAE": 82.1, "altMSL": 35.2, "eph": 6.3, "epx": 4.1, "epy": 5.2, "speed": 0.42, "track": 121.5}
    SKY = {"class": "SKY", "device": "/dev/ttyACM0", "nSat": 14, "uSat": 9}

    def gps(self, server):
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return osv.GpsBackend(osv.GpsdClient(port=server.server_address[1], timeout=2.0))

    def test_fix(self):
        server = FakeGpsd(self.DEVICE, self.TPV, self.SKY)
        state = self.gps(server).state()
        self.assertEqual(state, {"available": True, "fix": {
            "lat": 48.8566123, "lon": 2.3522199, "alt": 35.2, "speed": 0.42, "heading": 121.5,
            "accuracy": 6.3, "time": "2026-10-22T10:00:00.000Z", "satellites": 9,
        }})
        self.assertEqual(server.commands[:2], ['?WATCH={"enable":true,"json":true};', "?POLL;"])

    def test_no_fix_yet(self):
        tpv = {"class": "TPV", "device": "/dev/ttyACM0", "mode": 1}
        state = self.gps(FakeGpsd(self.DEVICE, tpv, None)).state()
        self.assertEqual(state, {"available": True, "fix": None})

    def test_accuracy_and_satellites_fallbacks(self):
        tpv = {k: v for k, v in self.TPV.items() if k not in ("eph", "altMSL")}
        fix = osv.gps_fix(tpv, {"satellites": [{"used": True}, {"used": True}, {"used": False}]})
        self.assertEqual((fix["accuracy"], fix["alt"], fix["satellites"]), (5.2, 82.1, 2))

    def test_no_receiver(self):
        self.assertEqual(self.gps(FakeGpsd([], None, None)).state(), {"available": False, "fix": None})

    def test_gpsd_not_running(self):
        backend = osv.GpsBackend(osv.GpsdClient(port=free_port(), timeout=1.0))
        self.assertEqual(backend.state(), {"available": False, "fix": None})


# --- Statut et alimentation (matériel réel, outils factices) ------------------


class RealHardwareTest(unittest.TestCase):
    def test_status_capabilities(self):
        runner = mm_runner()
        runner.add(("bluetoothctl", "show"), ok("No default controller available\n"))
        hardware = osv.RealHardware(runner, gps=osv.GpsdClient(port=free_port(), timeout=0.5))
        status = hardware.status()
        self.assertEqual(status["bridge"], "orion-server")
        self.assertFalse(status["simulated"])
        self.assertEqual(status["capabilities"], {"wifi": True, "bluetooth": False, "modem": True, "gps": False, "power": True, "network": True})
        calls = len(runner.calls)
        hardware.status()
        self.assertEqual(len(runner.calls), calls)  # résultat gardé quelques secondes

    def test_stale_capabilities_returned_at_once_and_refreshed(self):
        runner = mm_runner()
        runner.add(("bluetoothctl", "show"), ok("No default controller available\n"))
        hardware = osv.RealHardware(runner, gps=osv.GpsdClient(port=free_port(), timeout=0.5))
        first = hardware.capabilities()
        hardware._caps = (time.monotonic() - 60, first)  # périmé
        calls = len(runner.calls)
        started = time.monotonic()
        self.assertEqual(hardware.capabilities(), first)  # tout de suite, sans attendre les outils
        self.assertLess(time.monotonic() - started, 0.5)
        for _ in range(50):  # recalcul en arrière-plan
            if hardware._caps[0] > started:
                break
            time.sleep(0.05)
        self.assertGreater(hardware._caps[0], started)
        self.assertGreater(len(runner.calls), calls)

    def test_power_runs_after_delay(self):
        runner = FakeRunner()
        runner.add(("systemctl", "reboot"), ok())
        original = osv.POWER_DELAY
        osv.POWER_DELAY = 0.05
        try:
            osv.PowerBackend(runner).request("reboot")
            self.assertFalse(runner.called("systemctl"))
            time.sleep(0.3)
        finally:
            osv.POWER_DELAY = original
        self.assertEqual(runner.calls, [["systemctl", "reboot"]])


# ---------------------------------------------------------------------------
# Serveur HTTP
# ---------------------------------------------------------------------------


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def write(path: Path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))


def make_release(directory: Path, label: str):
    write(directory / "index.html", f"<!doctype html><title>Orion {label}</title>")
    write(directory / "sw.js", "self.addEventListener('fetch', () => {});")
    write(directory / "version.json", json.dumps({"version": label, "files": {}}))
    write(directory / "manifest.webmanifest", '{"name": "Orion OS"}')
    write(directory / "assets" / "icon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
    write(directory / "assets" / "icon.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
    write(directory / "src" / "main.js", "export const ok = true;")
    write(directory / "src" / "styles" / "base.css", "body { margin: 0 }")
    write(directory / "README.md", "pas servi")
    write(directory / ".git" / "config", "[core]")
    write(directory / "docs" / "x.txt", "pas servi")


class ServerTestCase(unittest.TestCase):
    hardware_factory = staticmethod(lambda clock: osv.SimulatedHardware(delay_scale=0, clock=clock, seed=1))

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="orion-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        make_release(self.tmp / "releases" / "a", "A")
        make_release(self.tmp / "releases" / "b", "B")
        write(self.tmp / "secret.txt", "SECRET")
        os.symlink("../../../secret.txt", self.tmp / "releases" / "a" / "src" / "escape.js")
        os.symlink("../README.md", self.tmp / "releases" / "a" / "src" / "readme.js")
        os.symlink("main.js", self.tmp / "releases" / "a" / "src" / "alias.js")
        os.symlink("releases/a", self.tmp / "current")
        self.clock = FakeClock()
        self.hardware = self.hardware_factory(self.clock)
        self.server = osv.make_server(self.tmp / "current", "127.0.0.1", 0, self.hardware)
        self.port = self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            if host is not False:
                conn.putheader("Host", host or f"127.0.0.1:{self.port}")
            data = json.dumps(body).encode() if isinstance(body, (dict, list)) else (body or b"")
            for key, value in (headers or {}).items():
                conn.putheader(key, value)
            if method == "POST" or data:
                conn.putheader("Content-Length", str(len(data)))
            conn.endheaders(data or None)
            response = conn.getresponse()
            payload = response.read()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, payload
        finally:
            conn.close()

    def api(self, method, path, body=None, headers=None):
        merged = {"X-Orion": "1", "Content-Type": "application/json"} if method == "POST" else {}
        merged.update(headers or {})
        status, _, payload = self.request(method, path, body if body is not None else ({} if method == "POST" else None), merged)
        return status, json.loads(payload)


class StaticFilesTest(ServerTestCase):
    def test_mime_types_and_headers(self):
        expected = {
            "/": "text/html; charset=utf-8",
            "/index.html": "text/html; charset=utf-8",
            "/sw.js": "text/javascript; charset=utf-8",
            "/src/main.js": "text/javascript; charset=utf-8",
            "/version.json": "application/json; charset=utf-8",
            "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
            "/src/styles/base.css": "text/css; charset=utf-8",
            "/assets/icon.svg": "image/svg+xml",
            "/assets/icon.png": "image/png",
        }
        for path, content_type in expected.items():
            status, headers, _ = self.request("GET", path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers["content-type"], content_type, path)
            self.assertEqual(headers["cache-control"], "no-cache", path)
            self.assertFalse([h for h in headers if h.startswith("access-control-")], path)

    def test_query_strings_are_ignored(self):
        for path in ("/?fullscreen", "/index.html?x=1&y=2", "/src/main.js?v=3"):
            self.assertEqual(self.request("GET", path)[0], 200, path)

    def test_head_and_etag(self):
        status, headers, body = self.request("HEAD", "/src/main.js")
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(int(headers["content-length"]), len("export const ok = true;"))
        status, _, body = self.request("GET", "/src/main.js", headers={"If-None-Match": headers["etag"]})
        self.assertEqual((status, body), (304, b""))

    def test_path_traversal_and_whitelist(self):
        refused = [
            "/../secret.txt", "/src/../../secret.txt", "/%2e%2e/secret.txt", "/src/%2e%2e/%2e%2e/secret.txt",
            "/src/..%2f..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/src/%2E%2E/%2E%2E/%2E%2E/secret.txt",
            "/src/escape.js", "/src/readme.js", "/src/main.js%00.png", "/src//main.js", "/src/./main.js",
            "/README.md", "/.git/config", "/docs/x.txt", "/src/", "/src", "/assets/", "//etc/passwd",
            "/src\\..\\README.md", "/%ff", "/index.html/", "/releases/a/index.html", "/current/index.html",
        ]
        for path in refused:
            status, _, body = self.request("GET", path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(b"SECRET", body)
            self.assertNotIn(b"pas servi", body)
        self.assertEqual(self.request("GET", "/src/alias.js")[0], 200)  # lien interne autorisé

    def test_double_slash_is_not_a_host(self):
        for path in ("//x/api/status", "//x/index.html", "//127.0.0.1/src/main.js"):
            self.assertEqual(self.request("GET", path)[0], 404, path)
        headers = {"X-Orion": "1", "Content-Type": "application/json"}
        self.assertEqual(self.request("POST", "//x/api/wifi/disconnect", {}, headers)[0], 405)

    def test_get_with_body_closes_connection(self):
        status, headers, _ = self.request("GET", "/index.html", b"GET /secret HTTP/1.1\r\n\r\n")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("connection"), "close")
        self.assertNotIn("connection", self.request("GET", "/index.html")[1])

    def test_absolute_form_and_methods(self):
        self.assertEqual(self.request("GET", "http://127.0.0.1/index.html")[0], 400)
        self.assertEqual(self.request("POST", "/", headers={"X-Orion": "1", "Content-Type": "application/json"})[0], 405)
        self.assertEqual(self.request("PUT", "/index.html")[0], 405)
        self.assertEqual(self.request("DELETE", "/api/status")[0], 405)

    def test_root_symlink_is_followed_per_request(self):
        self.assertIn(b"Orion A", self.request("GET", "/")[2])
        os.symlink("releases/b", self.tmp / "current.new")
        os.replace(self.tmp / "current.new", self.tmp / "current")
        self.assertIn(b"Orion B", self.request("GET", "/")[2])
        self.assertEqual(self.request("GET", "/src/escape.js")[0], 404)

    def test_keep_alive(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            for path in ("/", "/src/main.js", "/api/status"):
                conn.request("GET", path, headers={"Host": f"localhost:{self.port}"})
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 200)
        finally:
            conn.close()


class SecurityTest(ServerTestCase):
    def test_host_header(self):
        for host in ("evil.example", f"evil.example:{self.port}", "127.0.0.1", f"127.0.0.1:{self.port + 1}", f"192.168.1.5:{self.port}"):
            for path in ("/", "/api/status"):
                status, headers, body = self.request("GET", path, host=host)
                self.assertEqual(status, 403, (host, path))
                self.assertEqual(json.loads(body), {"error": "Hôte refusé"})
        self.assertEqual(self.request("GET", "/", host=False)[0], 403)
        self.assertEqual(self.request("GET", "/api/status", host=f"LocalHost:{self.port}")[0], 200)
        self.assertEqual(self.request("GET", "/", host=f"localhost:{self.port}")[0], 200)

    def test_post_requires_custom_header_and_json(self):
        path, body = "/api/wifi/disconnect", {}
        cases = [
            ({"Content-Type": "application/json"}, 403),
            ({"X-Orion": "0", "Content-Type": "application/json"}, 403),
            ({"X-Orion": "1", "Content-Type": "text/plain"}, 403),
            ({"X-Orion": "1", "Content-Type": "application/x-www-form-urlencoded"}, 403),
            ({"X-Orion": "1"}, 403),
            ({"X-Orion": "1", "Content-Type": "application/json; charset=utf-8"}, 200),
        ]
        for headers, expected in cases:
            status, response_headers, payload = self.request("POST", path, body, headers)
            self.assertEqual(status, expected, headers)
            self.assertIn("error" if expected != 200 else "ok", json.loads(payload))

    def test_cross_origin_is_refused_without_cors(self):
        headers = {"X-Orion": "1", "Content-Type": "application/json", "Origin": "http://evil.example"}
        status, response_headers, _ = self.request("POST", "/api/wifi/disconnect", {}, headers)
        self.assertEqual(status, 403)
        self.assertFalse([h for h in response_headers if h.startswith("access-control-")])
        headers["Origin"] = f"http://127.0.0.1:{self.port + 1}"
        self.assertEqual(self.request("POST", "/api/wifi/disconnect", {}, headers)[0], 403)
        headers["Origin"] = f"http://127.0.0.1:{self.port}"
        self.assertEqual(self.request("POST", "/api/wifi/disconnect", {}, headers)[0], 200)
        self.assertEqual(self.request("GET", "/api/status", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("GET", "/api/status", headers={"Sec-Fetch-Site": "same-site"})[0], 403)
        self.assertEqual(self.request("GET", "/api/status", headers={"Sec-Fetch-Site": "same-origin"})[0], 200)
        preflight = {"Origin": "http://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-orion,content-type"}
        status, response_headers, _ = self.request("OPTIONS", "/api/wifi/connect", headers=preflight)
        self.assertEqual(status, 405)
        self.assertFalse([h for h in response_headers if h.startswith("access-control-")])
        self.assertEqual(self.request("OPTIONS", "/api/wifi/connect", host="evil.example")[0], 403)

    def test_body_validation(self):
        headers = {"X-Orion": "1", "Content-Type": "application/json"}
        self.assertEqual(self.request("POST", "/api/wifi/connect", b"x" * (osv.MAX_BODY + 1), headers)[0], 413)
        self.assertEqual(self.request("POST", "/api/wifi/connect", b"{pas du json", headers)[0], 400)
        self.assertEqual(self.request("POST", "/api/wifi/connect", b"[1, 2]", headers)[0], 400)
        self.assertEqual(self.request("POST", "/api/wifi/connect", b"[" * 5000 + b"]" * 5000, headers)[0], 400)
        status, payload = self.api("POST", "/api/wifi/connect", {"ssid": 3})
        self.assertEqual((status, payload), (400, {"error": "Paramètre « ssid » invalide"}))
        self.assertEqual(self.api("POST", "/api/wifi/connect", {"ssid": "x" * 33})[0], 400)
        self.assertEqual(self.api("POST", "/api/wifi/power", {"enabled": "oui"})[0], 400)

    def test_unknown_routes(self):
        self.assertEqual(self.api("GET", "/api/nope"), (404, {"error": "Point d'accès inconnu"}))
        self.assertEqual(self.api("GET", "/api/wifi/connect")[0], 405)
        self.assertEqual(self.api("POST", "/api/status")[0], 405)

    def test_simulate_routes_only_in_simulation(self):
        self.assertEqual(self.api("POST", "/api/simulate/incoming-sms", {"number": "+33600000000", "text": "Coucou"})[0], 200)
        real = osv.make_server(self.tmp / "current", "127.0.0.1", 0, osv.RealHardware(FakeRunner(tools=())))
        self.addCleanup(real.server_close)
        self.assertNotIn("/api/simulate/incoming-sms", real.routes)
        self.assertNotIn("/api/simulate/incoming-call", real.routes)


class SimulatedFlowsTest(ServerTestCase):
    def test_status(self):
        status, payload = self.api("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(payload["simulated"])
        self.assertEqual(set(payload["capabilities"]), {"wifi", "bluetooth", "modem", "gps", "power", "network", "protection", "integrity", "mail"})

    def test_wifi(self):
        wifi = self.api("GET", "/api/wifi?rescan=1")[1]
        self.assertEqual(wifi["connected"]["ssid"], "Orion Box")
        self.assertEqual(self.api("POST", "/api/wifi/connect", {"ssid": "Livebox-7A3F", "password": "mauvais"}), (400, {"error": "Mot de passe incorrect"}))
        self.assertEqual(self.api("POST", "/api/wifi/connect", {"ssid": "Livebox-7A3F"}), (400, {"error": "Mot de passe requis"}))
        self.assertEqual(self.api("POST", "/api/wifi/connect", {"ssid": "Absent"}), (404, {"error": "Réseau introuvable"}))
        self.assertEqual(self.api("POST", "/api/wifi/connect", {"ssid": "Livebox-7A3F", "password": osv.SIM_WIFI_PASSWORD}), (200, {"ok": True}))
        wifi = self.api("GET", "/api/wifi")[1]
        self.assertEqual(wifi["connected"]["ssid"], "Livebox-7A3F")
        self.assertEqual(wifi["networks"][0]["ssid"], "Livebox-7A3F")
        self.assertTrue(wifi["networks"][0]["known"])
        self.assertEqual(self.api("POST", "/api/wifi/connect", {"ssid": "Café de la Gare"})[0], 200)
        self.assertEqual(self.api("POST", "/api/wifi/forget", {"ssid": "Livebox-7A3F"})[0], 200)
        self.assertFalse(next(n for n in self.api("GET", "/api/wifi")[1]["networks"] if n["ssid"] == "Livebox-7A3F")["known"])
        self.assertEqual(self.api("POST", "/api/wifi/power", {"enabled": False})[0], 200)
        self.assertEqual(self.api("GET", "/api/wifi")[1], {"enabled": False, "connected": None, "networks": []})
        self.assertEqual(self.api("POST", "/api/wifi/connect", {"ssid": "Café de la Gare"})[0], 409)
        self.api("POST", "/api/wifi/power", {"enabled": True})
        self.assertIsNone(self.api("GET", "/api/wifi")[1]["connected"])

    def test_network_summary(self):
        self.assertEqual(self.api("GET", "/api/network")[1]["primary"]["type"], "wifi")
        self.api("POST", "/api/wifi/disconnect")
        self.assertEqual(self.api("GET", "/api/network")[1]["primary"]["type"], "gsm")
        self.api("POST", "/api/modem/data", {"enabled": False})
        self.assertEqual(self.api("GET", "/api/network")[1], {"connectivity": "none", "primary": None})

    def test_bluetooth_scan_pair_connect(self):
        state = self.api("GET", "/api/bluetooth")[1]
        self.assertEqual([d["name"] for d in state["devices"]], ["Clavier Orion", "Écouteurs Orion"])
        self.assertEqual(self.api("POST", "/api/bluetooth/scan", {"seconds": 99})[0], 200)
        state = self.api("GET", "/api/bluetooth")[1]
        speaker = next(d for d in state["devices"] if d["name"] == "Enceinte du salon")
        self.assertFalse(speaker["paired"])
        address = speaker["address"]
        self.assertEqual(self.api("POST", "/api/bluetooth/connect", {"address": address}), (400, {"error": "Appareil non appairé"}))
        self.assertEqual(self.api("POST", "/api/bluetooth/pair", {"address": address.lower()})[0], 200)
        self.assertEqual(self.api("POST", "/api/bluetooth/connect", {"address": address})[0], 200)
        speaker = next(d for d in self.api("GET", "/api/bluetooth")[1]["devices"] if d["address"] == address)
        self.assertTrue(speaker["paired"] and speaker["connected"] and speaker["trusted"])
        self.assertEqual(self.api("POST", "/api/bluetooth/remove", {"address": address})[0], 200)
        self.assertNotIn(address, [d["address"] for d in self.api("GET", "/api/bluetooth")[1]["devices"]])
        self.assertEqual(self.api("POST", "/api/bluetooth/pair", {"address": "nope"})[0], 400)
        self.assertEqual(self.api("POST", "/api/bluetooth/pair", {"address": "00:00:00:00:00:00"})[0], 404)
        self.api("POST", "/api/bluetooth/power", {"enabled": False})
        self.assertEqual(self.api("POST", "/api/bluetooth/scan", {})[0], 409)

    def test_modem_calls(self):
        modem = self.api("GET", "/api/modem")[1]
        self.assertEqual((modem["operator"], modem["technology"], modem["enabled"], modem["data"]), ("Orion Mobile", "lte", True, True))
        self.api("POST", "/api/modem/power", {"enabled": False})
        modem = self.api("GET", "/api/modem")[1]
        self.assertEqual((modem["enabled"], modem["data"], modem["state"]), (False, False, "disabled"))
        self.assertEqual(self.api("POST", "/api/modem/call", {"number": "+33600000000"})[0], 409)
        self.api("POST", "/api/modem/power", {"enabled": True})
        self.assertEqual(self.api("POST", "/api/modem/call", {"number": "+33 6 00 00 00 00; reboot"})[0], 400)
        status, payload = self.api("POST", "/api/modem/call", {"number": "+33 6 00 00 00 00"})
        self.assertEqual(status, 200)
        call_id = payload["id"]
        self.assertEqual(self.api("GET", "/api/modem/calls")[1]["calls"], [{"id": call_id, "number": "+33600000000", "direction": "outgoing", "state": "active"}])
        self.assertEqual(self.api("POST", "/api/modem/hangup", {"id": call_id})[0], 200)
        self.assertEqual(self.api("GET", "/api/modem/calls")[1]["calls"][0]["state"], "terminated")
        incoming = self.api("POST", "/api/simulate/incoming-call", {"number": "+33611111111"})[1]["id"]
        calls = {c["id"]: c for c in self.api("GET", "/api/modem/calls")[1]["calls"]}
        self.assertEqual((calls[incoming]["direction"], calls[incoming]["state"]), ("incoming", "ringing"))
        self.assertEqual(self.api("POST", "/api/modem/answer", {"id": incoming})[0], 200)
        self.assertEqual({c["id"]: c for c in self.api("GET", "/api/modem/calls")[1]["calls"]}[incoming]["state"], "active")
        self.assertEqual(self.api("POST", "/api/modem/answer", {"id": incoming})[0], 409)
        self.assertEqual(self.api("POST", "/api/modem/hangup", {})[0], 200)
        self.assertTrue(all(c["state"] == "terminated" for c in self.api("GET", "/api/modem/calls")[1]["calls"]))
        self.clock.now += 31
        self.assertEqual(self.api("GET", "/api/modem/calls")[1], {"calls": []})

    def test_outgoing_call_rings_before_answer(self):
        hardware = osv.SimulatedHardware(delay_scale=1, clock=self.clock)
        call_id = hardware.modem_call("+33600000000")
        self.assertEqual(hardware.modem_calls()[0]["state"], "dialing")
        self.clock.now += 3.1
        self.assertEqual(hardware.modem_calls(), [{"id": call_id, "number": "+33600000000", "direction": "outgoing", "state": "active"}])

    def test_sms_send_and_receive(self):
        self.assertEqual(self.api("POST", "/api/modem/sms", {"number": "+33612345678", "text": ""})[0], 400)
        self.assertEqual(self.api("POST", "/api/modem/sms", {"number": "+33612345678", "text": "L'été, \"enfin\" !"}), (200, {"ok": True}))
        messages = self.api("GET", "/api/modem/sms")[1]["messages"]
        self.assertEqual([(m["state"], m["number"]) for m in messages], [("sent", "+33612345678"), ("received", "+33612345678")])
        self.assertEqual(messages[0]["text"], "L'été, \"enfin\" !")
        self.assertIn("Bien reçu", messages[1]["text"])
        self.assertTrue(messages[1]["timestamp"])
        self.api("POST", "/api/simulate/incoming-sms", {"number": "+33699999999", "text": "Coucou"})
        messages = self.api("GET", "/api/modem/sms")[1]["messages"]
        self.assertEqual(messages[-1]["text"], "Coucou")
        self.assertEqual(self.api("POST", "/api/modem/sms/delete", {"id": messages[0]["id"]})[0], 200)
        self.assertEqual(len(self.api("GET", "/api/modem/sms")[1]["messages"]), 2)

    def test_gps_moves(self):
        first = self.api("GET", "/api/gps")[1]
        self.assertTrue(first["available"])
        fix = first["fix"]
        self.assertAlmostEqual(fix["lat"], 48.853, delta=0.01)
        self.assertAlmostEqual(fix["lon"], 2.35, delta=0.01)
        self.assertGreaterEqual(fix["satellites"], 4)
        self.clock.now += 60
        moved = self.api("GET", "/api/gps")[1]["fix"]
        dy = (moved["lat"] - fix["lat"]) * 111_320
        dx = (moved["lon"] - fix["lon"]) * 111_320 * 0.6577
        distance = (dx * dx + dy * dy) ** 0.5
        self.assertTrue(60 < distance < 90, distance)  # ~84 m en une minute à pied

    def test_power(self):
        self.assertEqual(self.api("POST", "/api/system/reboot"), (200, {"ok": True}))
        self.assertEqual(self.api("POST", "/api/system/poweroff"), (200, {"ok": True}))


# ---------------------------------------------------------------------------
# Mises à jour (sous-commande sync)
# ---------------------------------------------------------------------------


class ProtectionTest(ServerTestCase):
    """Protection contre la réinitialisation gardée par le serveur, et intégrité de l'interface."""

    SALT = "00112233aabbccdd"

    def setUp(self):
        super().setUp()
        self.server.protection.clock = self.clock

    def record(self, code):
        return {"salt": self.SALT, "hash": hashlib.sha256(f"{self.SALT}:{code}".encode()).hexdigest(), "length": len(code)}

    def test_status_announces_protection(self):
        status, data = self.api("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(data["capabilities"]["protection"])
        self.assertTrue(data["capabilities"]["integrity"])

    def test_enable_verify_throttle_and_disable(self):
        self.assertEqual(self.api("GET", "/api/protection"), (200, {"enabled": False, "wait": 0}))
        status, data = self.api("POST", "/api/protection/enable", {"record": self.record("1234"), "owner": {"name": "Camille", "email": "c@example.com"}})
        self.assertEqual(status, 200)
        self.assertEqual(data["owner"]["name"], "Camille")
        self.assertNotIn("record", data)
        # Une seule protection : la remplacer demanderait le code.
        self.assertEqual(self.api("POST", "/api/protection/enable", {"record": self.record("9999")})[0], 409)
        self.assertEqual(self.api("POST", "/api/protection/verify", {"code": "1234"}), (200, {"ok": True}))
        for _ in range(4):
            self.assertEqual(self.api("POST", "/api/protection/verify", {"code": "0000"})[0], 403)
        # Cinquième échec : attente imposée, même avec le bon code.
        self.assertEqual(self.api("POST", "/api/protection/verify", {"code": "0000"})[0], 403)
        self.assertEqual(self.api("GET", "/api/protection")[1]["wait"], 30)
        status, data = self.api("POST", "/api/protection/verify", {"code": "1234"})
        self.assertEqual(status, 429)
        self.assertIn("30 s", data["error"])
        self.clock.now += 31
        self.assertEqual(self.api("POST", "/api/protection/disable", {"code": "1234"}), (200, {"ok": True}))
        self.assertFalse(self.api("GET", "/api/protection")[1]["enabled"])

    def test_update_requires_the_current_code(self):
        self.api("POST", "/api/protection/enable", {"record": self.record("1234")})
        self.assertEqual(self.api("POST", "/api/protection/update", {"code": "4321", "record": self.record("5678")})[0], 403)
        self.assertEqual(self.api("POST", "/api/protection/update", {"code": "1234", "record": self.record("5678")})[0], 200)
        self.assertEqual(self.api("POST", "/api/protection/verify", {"code": "5678"})[0], 200)

    def test_invalid_requests(self):
        self.assertEqual(self.api("POST", "/api/protection/enable", {"record": {"salt": "x", "hash": "y", "length": 4}})[0], 400)
        self.assertEqual(self.api("POST", "/api/protection/verify", {"code": "12ab"})[0], 400)

    def test_kept_on_disk(self):
        clock = FakeClock()
        path = self.tmp / "state" / "protection.json"
        store = osv.ProtectionStore(path, clock)
        store.enable(self.record("2468"), {"name": "Camille", "email": ""})
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        again = osv.ProtectionStore(path, clock)
        self.assertTrue(again.public()["enabled"])
        with self.assertRaises(osv.ApiError):
            again.verify("1111")
        self.assertEqual(json.loads(path.read_text())["failures"], 1)
        again.disable("2468")
        self.assertFalse(path.exists())

    def test_integrity(self):
        root = self.tmp / "releases" / "c"
        files = {"index.html": "<!doctype html>", "src/main.js": "export {};"}
        listing = {}
        for name, content in files.items():
            write(root / name, content)
            listing[f"./{name}"] = {"hash": hashlib.sha256(content.encode()).hexdigest(), "size": len(content)}
        write(root / "version.json", json.dumps({"version": "0.1", "files": listing}))
        self.assertEqual(osv.check_integrity(root)["status"], "ok")
        write(root / "src" / "main.js", "export const pirate = 1;")
        (root / "index.html").unlink()
        result = osv.check_integrity(root)
        self.assertEqual((result["status"], result["altered"], result["missing"]), ("altered", ["./src/main.js"], ["./index.html"]))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002
        self.server.requests.append(self.path.split("?")[0])


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="orion-sync-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.publish_dir = self.tmp / "publication"
        self.publish_dir.mkdir()
        self.data = self.tmp / "data"
        handler = functools.partial(QuietHandler, directory=str(self.publish_dir))
        self.source = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.source.requests = []
        threading.Thread(target=self.source.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        self.addCleanup(self.source.server_close)
        self.addCleanup(self.source.shutdown)
        self.url = f"http://127.0.0.1:{self.source.server_address[1]}/"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    FILES = {
        "index.html": "<!doctype html><title>Orion</title>",
        "manifest.webmanifest": '{"name": "Orion OS"}',
        "assets/icon.svg": "<svg/>",
        "src/main.js": "import './system/ui.js';",
        "src/system/ui.js": "export const version = 1;",
        "src/styles/base.css": "body{}",
    }

    def publish(self, version, files=None, manifest_override=None, corrupt=None):
        files = dict(self.FILES if files is None else files)
        for old in list(self.publish_dir.iterdir()):
            __import__("shutil").rmtree(old) if old.is_dir() else old.unlink()
        listing = {}
        for path, content in files.items():
            data = content.encode()
            write(self.publish_dir / path, data)
            listing[f"./{path}"] = {"hash": hashlib.sha256(data).hexdigest(), "size": len(data)}
        write(self.publish_dir / "sw.js", f"// sw {version}")
        manifest = {"version": version, "build": "TEST", "notes": [], "size": 0, "files": listing}
        if manifest_override:
            manifest.update(manifest_override)
        write(self.publish_dir / "version.json", json.dumps(manifest, indent=1))
        if corrupt:
            write(self.publish_dir / corrupt, "contenu modifié après la publication")
        return manifest

    def sync(self, **kwargs):
        self.source.requests.clear()
        return osv.sync_release(self.url, self.data, opener=self.opener, **kwargs)

    def current(self):
        return json.loads((self.data / "current" / "version.json").read_text())["version"]

    def downloads(self):
        return sorted(set(self.source.requests) - {"/version.json", "/sw.js"})

    def test_first_install_and_incremental_update(self):
        self.publish("1.0.0")
        message = self.sync()
        self.assertIn("1.0.0", message)
        self.assertEqual(os.readlink(self.data / "current"), "releases/1.0.0")
        self.assertEqual(self.current(), "1.0.0")
        for path, content in self.FILES.items():
            self.assertEqual((self.data / "current" / path).read_text(), content)
        self.assertEqual((self.data / "current" / "sw.js").read_text(), "// sw 1.0.0")
        self.assertEqual(len(self.downloads()), len(self.FILES))

        files = dict(self.FILES, **{"src/system/ui.js": "export const version = 2;", "src/apps/new.js": "export {};"})
        self.publish("1.1.0", files)
        self.sync()
        self.assertEqual(self.current(), "1.1.0")
        self.assertEqual(self.downloads(), ["/src/apps/new.js", "/src/system/ui.js"])  # seulement ce qui a changé
        self.assertTrue((self.data / "releases" / "1.0.0" / "index.html").is_file())  # précédente gardée
        self.assertEqual((self.data / "current" / "src" / "system" / "ui.js").read_text(), "export const version = 2;")

        self.assertIn("à jour", self.sync())
        self.assertEqual(self.downloads(), [])

        self.publish("1.2.0", files)
        self.sync()
        self.assertEqual(sorted(p.name for p in (self.data / "releases").iterdir()), ["1.1.0", "1.2.0"])
        self.assertFalse(list(self.data.glob(".current-*")))

    def test_server_serves_new_release_without_restart(self):
        self.publish("1.0.0")
        self.sync()
        server = osv.make_server(self.data / "current", "127.0.0.1", 0, osv.SimulatedHardware(delay_scale=0))
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]

        def served_version():
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("GET", "/version.json")
            body = conn.getresponse().read()
            conn.close()
            return json.loads(body)["version"]

        self.assertEqual(served_version(), "1.0.0")
        self.publish("1.1.0")
        self.sync()
        self.assertEqual(served_version(), "1.1.0")

    def test_hash_mismatch_leaves_current_untouched(self):
        self.publish("1.0.0")
        self.sync()
        self.publish("2.0.0", dict(self.FILES, **{"src/main.js": "nouveau"}), corrupt="src/main.js")
        with self.assertRaises(osv.SyncError) as ctx:
            self.sync()
        self.assertIn("src/main.js", str(ctx.exception))
        self.assertEqual(self.current(), "1.0.0")
        self.assertEqual(sorted(p.name for p in (self.data / "releases").iterdir()), ["1.0.0"])  # ni 2.0.0 ni .staging-*

    def test_size_mismatch_is_refused(self):
        manifest = self.publish("1.0.0")
        manifest["files"]["./index.html"]["size"] += 1
        write(self.publish_dir / "version.json", json.dumps(manifest))
        with self.assertRaises(osv.SyncError):
            self.sync()
        self.assertFalse((self.data / "current").exists())

    def test_malicious_paths_are_refused(self):
        self.publish("1.0.0")
        self.sync()
        digest = {"hash": "0" * 64, "size": 1}
        for bad in ("./../evil.js", "./src/../../evil.js", "./etc/passwd", "/etc/passwd", "src/main.js", "./src/.hidden",
                    "./src//x.js", "./version.json", "./src/a\\b.js", "./src/./x.js", "./README.md", "./src/x\x00.js", "./.git/config"):
            self.publish("9.9.9", manifest_override={"files": {"./index.html": digest, bad: digest}})
            with self.assertRaises(osv.SyncError, msg=bad):
                self.sync()
        for version in ("../../tmp/x", "1.0/../..", "", ".hidden", "a" * 80, 3):
            self.publish("x", manifest_override={"version": version})
            with self.assertRaises(osv.SyncError, msg=repr(version)):
                self.sync()
        self.publish("9.9.9", manifest_override={"files": {"./index.html": {"hash": "zz", "size": 1}}})
        with self.assertRaises(osv.SyncError):
            self.sync()
        self.assertEqual(self.current(), "1.0.0")
        self.assertFalse((self.tmp / "evil.js").exists())
        self.assertEqual(sorted(p.name for p in (self.data / "releases").iterdir()), ["1.0.0"])

    def test_downgrade_is_ignored_unless_allowed(self):
        self.publish("1.1.0")
        self.sync()
        self.publish("1.0.9")
        self.assertIn("plus ancienne", self.sync())
        self.assertEqual(self.current(), "1.1.0")
        self.sync(allow_downgrade=True)
        self.assertEqual(self.current(), "1.0.9")

    def test_sequence_orders_releases(self):
        # 1.2.0 (sans numéro d'ordre) → 0.1 alpha (numéro d'ordre 4) : c'est une mise à jour.
        self.publish("1.2.0")
        self.sync()
        self.publish("0.1", manifest_override={"channel": "alpha", "sequence": 4})
        self.assertIn("installée", self.sync())
        self.assertEqual(self.current(), "0.1")
        # Plus ancienne d'après le numéro d'ordre, même avec un numéro affiché plus grand.
        self.publish("2.0", manifest_override={"sequence": 3})
        self.assertIn("plus ancienne", self.sync())
        self.publish("1.9.0")
        self.assertIn("plus ancienne", self.sync())
        self.assertEqual(self.current(), "0.1")
        self.publish("0.2", manifest_override={"channel": "alpha", "sequence": 5})
        self.sync()
        self.assertEqual(self.current(), "0.2")

    def test_republished_version_gets_a_new_directory(self):
        self.publish("1.0.0")
        self.sync()
        self.publish("1.0.0", dict(self.FILES, **{"src/main.js": "corrigé"}))
        self.sync()
        target = os.readlink(self.data / "current")
        self.assertTrue(target.startswith("releases/1.0.0-"), target)
        self.assertEqual((self.data / "current" / "src" / "main.js").read_text(), "corrigé")
        self.assertTrue((self.data / "releases" / "1.0.0" / "index.html").is_file())

    def test_current_must_be_a_symlink(self):
        (self.data / "current").mkdir(parents=True)
        self.publish("1.0.0")
        with self.assertRaises(osv.SyncError):
            self.sync()

    def test_command_line_exit_codes(self):
        port = free_port()
        code = osv.sync_main(["--source", f"http://127.0.0.1:{port}/", "--data", str(self.data)])
        self.assertEqual(code, 1)
        self.assertFalse((self.data / "current").exists())

    def test_version_comparison(self):
        self.assertEqual(osv.compare_versions("1.10.0", "1.9.2"), 1)
        self.assertEqual(osv.compare_versions("1.1", "1.1.0"), 0)
        self.assertEqual(osv.compare_versions("1.0.0", "1.0.1"), -1)
        self.assertEqual(osv.compare_releases({"version": "0.1", "sequence": 4}, {"version": "1.2.0"}), 1)
        self.assertEqual(osv.compare_releases({"version": "1.2.0"}, {"version": "0.1", "sequence": 4}), -1)
        self.assertEqual(osv.compare_releases({"version": "0.2", "sequence": 5}, {"version": "0.1", "sequence": 4}), 1)
        self.assertEqual(osv.compare_releases({"version": "1.2.0"}, {"version": "1.1.0"}), 1)
        self.assertEqual(osv.compare_releases({"version": "0.1", "sequence": True}, {"version": "1.2.0"}), -1)


if __name__ == "__main__":
    unittest.main()
