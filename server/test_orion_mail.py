"""Tests de la messagerie d'orion-server : python3 -m unittest discover -s server -v

Le vrai code (imaplib, smtplib, email) parle à de faux serveurs IMAP et SMTP
lancés sur 127.0.0.1 (connexion non chiffrée, permise seulement en local) ;
l'API HTTP est testée avec la messagerie simulée (--simulate).
"""

from __future__ import annotations

import base64
import email
import email.policy
import io
import json
import os
import re
import socketserver
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import orion_mail as om  # noqa: E402
from orion_mail import MailError  # noqa: E402
from test_orion_server import ServerTestCase  # noqa: E402

USER = "camille@exemple.fr"
PASSWORD = "s3cret-ÉtÉ"  # accentué : connexion par AUTH PLAIN en UTF-8

# ---------------------------------------------------------------------------
# Faux serveur IMAP (le sous-ensemble de RFC 3501 qu'utilise orion_mail)
# ---------------------------------------------------------------------------


def internaldate(when: float) -> str:
    return time.strftime("%d-%b-%Y %H:%M:%S +0000", time.gmtime(when))


class FakeImapState:
    def __init__(self, *, move: bool = True):
        self.capabilities = "IMAP4rev1 AUTH=PLAIN UIDPLUS" + (" MOVE" if move else "")
        self.lock = threading.Lock()
        self.commands: list[str] = []
        self.mailboxes: dict[str, dict] = {}
        for name, flags in [("INBOX", ""), ("Sent", "\\Sent"), ("Drafts", "\\Drafts"), ("Trash", "\\Trash"), ("Archive", "\\Archive"), (om.imap_utf7_encode("Reçus/Factures"), ""), ("[Gmail]", "\\Noselect")]:
            self.mailboxes[name] = {"flags": flags, "validity": 42, "next": 1, "messages": []}

    def add(self, mailbox: str, raw: bytes, flags=(), when: float | None = None) -> int:
        box = self.mailboxes[mailbox]
        uid = box["next"]
        box["next"] += 1
        box["messages"].append({"uid": uid, "flags": set(flags), "raw": raw, "date": internaldate(when or time.time())})
        return uid


def tokenize(data: bytes) -> list:
    """Arguments d'une commande : atomes, chaînes entre guillemets, listes (gardées brutes), littéraux (bytes)."""
    tokens: list = []
    i = 0
    while i < len(data):
        c = data[i : i + 1]
        if c == b" ":
            i += 1
        elif c == b'"':
            j = i + 1
            out = bytearray()
            while data[j : j + 1] != b'"':
                if data[j : j + 1] == b"\\":
                    j += 1
                out += data[j : j + 1]
                j += 1
            tokens.append(out.decode("utf-8"))
            i = j + 1
        elif c == b"(":
            depth, j = 0, i
            while True:
                if data[j : j + 1] == b"(":
                    depth += 1
                elif data[j : j + 1] == b")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            tokens.append(("list", data[i + 1 : j].decode("utf-8")))
            i = j + 1
        elif c == b"\0":  # marqueur de littéral inséré par la lecture
            n = int.from_bytes(data[i + 1 : i + 5], "big")
            tokens.append(data[i + 5 : i + 5 + n])
            i += 5 + n
        else:
            j = i
            while j < len(data) and data[j : j + 1] not in (b" ", b"\0"):
                if data[j : j + 1] == b"[":
                    j = data.index(b"]", j)
                j += 1
            tokens.append(data[i:j].decode("utf-8"))
            i = j
    return tokens


def uid_matches(spec: str, uid: int, last: int) -> bool:
    for part in spec.split(","):
        if ":" in part:
            a, b = part.split(":")
            lo, hi = int(a), (last if b == "*" else int(b))
            if min(lo, hi) <= uid <= max(lo, hi):
                return True
        elif int(part) == uid:
            return True
    return False


def searchable(raw: bytes) -> str:
    """Texte cherché par TEXT : en-têtes et parties texte décodées (comme un vrai serveur)."""
    message = email.message_from_bytes(raw, policy=email.policy.default)
    parts = [str(value) for value in message.values()]
    for part in message.walk():
        if part.get_content_maintype() == "text":
            parts.append(part.get_content())
    return " ".join(parts).lower()


def header_fields(raw: bytes, names: list[str]) -> bytes:
    head = raw.split(b"\r\n\r\n", 1)[0]
    lines, keep = [], False
    for line in head.split(b"\r\n"):
        if line[:1] in (b" ", b"\t"):
            if keep:
                lines.append(line)
            continue
        keep = line.split(b":", 1)[0].decode().upper() in names
        if keep:
            lines.append(line)
    return b"\r\n".join(lines) + b"\r\n\r\n"


class FakeImapHandler(socketserver.StreamRequestHandler):
    state: FakeImapState

    def send(self, data: bytes | str) -> None:
        self.wfile.write(data if isinstance(data, bytes) else data.encode())

    def read_command(self) -> bytes | None:
        """Ligne de commande, littéraux compris (remplacés par \\0 + longueur + données)."""
        out = b""
        while True:
            line = self.rfile.readline()
            if not line:
                return None
            line = line.rstrip(b"\r\n")
            match = re.search(rb"\{(\d+)\}$", line)
            if not match:
                return out + line
            n = int(match.group(1))
            self.send("+ go ahead\r\n")
            literal = self.rfile.read(n)
            out += line[: match.start()] + b"\0" + n.to_bytes(4, "big") + literal

    def handle(self) -> None:
        self.selected: str | None = None
        self.user = None
        self.send(f"* OK [CAPABILITY {self.state.capabilities}] Faux IMAP prêt\r\n")
        while True:
            line = self.read_command()
            if line is None:
                return
            tag, _, rest = line.partition(b" ")
            command, _, args = rest.partition(b" ")
            command = command.decode().upper()
            if command == "UID":
                sub, _, args = args.partition(b" ")
                command = "UID " + sub.decode().upper()
            with self.state.lock:
                self.state.commands.append(command)
                try:
                    reply = self.dispatch(command, tokenize(args))
                except Exception as error:  # noqa: BLE001
                    reply = f"BAD {error}"
            if reply == "BYE":
                self.send(f"* BYE\r\n{tag.decode()} OK au revoir\r\n")
                return
            self.send(f"{tag.decode()} {reply}\r\n")

    def box(self, name: str) -> dict:
        return self.state.mailboxes[name]

    def dispatch(self, command: str, args: list) -> str:
        if command == "CAPABILITY":
            self.send(f"* CAPABILITY {self.state.capabilities}\r\n")
            return "OK fait"
        if command in ("NOOP", "CHECK"):
            return "OK fait"
        if command == "LOGOUT":
            return "BYE"
        if command == "LOGIN":
            return self.login(args[0], args[1])
        if command == "AUTHENTICATE":
            self.send("+ \r\n")
            decoded = base64.b64decode(self.rfile.readline().strip()).decode("utf-8")
            _, user, password = decoded.split("\0")
            return self.login(user, password)
        if self.user is None:
            return "NO non connecté"
        if command == "LIST":
            for name, box in self.state.mailboxes.items():
                self.send(f'* LIST (\\HasNoChildren {box["flags"]}) "/" "{name}"\r\n'.replace(" )", ")"))
            return "OK LIST terminé"
        if command == "STATUS":
            box = self.box(args[0])
            unseen = sum("\\Seen" not in m["flags"] for m in box["messages"])
            self.send(f'* STATUS "{args[0]}" (MESSAGES {len(box["messages"])} UNSEEN {unseen})\r\n')
            return "OK fait"
        if command in ("SELECT", "EXAMINE"):
            if args[0] not in self.state.mailboxes or "Noselect" in self.box(args[0])["flags"]:
                return "NO dossier inconnu"
            self.selected = args[0]
            box = self.box(args[0])
            self.send(f"* {len(box['messages'])} EXISTS\r\n* OK [UIDVALIDITY {box['validity']}] UIDs valides\r\n")
            return "OK [READ-ONLY] fait" if command == "EXAMINE" else "OK [READ-WRITE] fait"
        if command == "APPEND":
            flags = args[1][1] if isinstance(args[1], tuple) else ""
            self.state.add(args[0], args[-1], flags.split())
            return "OK APPEND terminé"
        if self.selected is None:
            return "BAD aucun dossier ouvert"
        box = self.box(self.selected)
        if command == "UID SEARCH":
            return self.search(box, args)
        if command == "UID FETCH":
            return self.fetch(box, args[0], args[1][1])
        if command == "UID STORE":
            flags = set(args[2][1].split())
            for m in self.pick(box, args[0]):
                if args[1].startswith("+"):
                    m["flags"] |= flags
                else:
                    m["flags"] -= flags
            return "OK STORE terminé"
        if command in ("UID MOVE", "UID COPY"):
            if command == "UID MOVE" and "MOVE" not in self.state.capabilities:
                return "BAD MOVE non pris en charge"
            for m in self.pick(box, args[0]):
                self.state.add(args[1], m["raw"], m["flags"] - {"\\Deleted"})
                if command == "UID MOVE":
                    box["messages"].remove(m)
            return "OK fait"
        if command == "UID EXPUNGE":
            for m in self.pick(box, args[0]):
                if "\\Deleted" in m["flags"]:
                    box["messages"].remove(m)
            return "OK EXPUNGE terminé"
        if command == "EXPUNGE":
            box["messages"] = [m for m in box["messages"] if "\\Deleted" not in m["flags"]]
            return "OK EXPUNGE terminé"
        return "BAD commande inconnue"

    def login(self, user: str, password: str) -> str:
        if user == USER and password == PASSWORD:
            self.user = user
            return "OK connecté"
        return "NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)"

    def pick(self, box: dict, spec: str) -> list[dict]:
        last = box["next"] - 1
        return [m for m in list(box["messages"]) if uid_matches(spec, m["uid"], last)]

    def search(self, box: dict, args: list) -> str:
        found = list(box["messages"])
        i = 0
        while i < len(args):
            key = args[i].upper() if isinstance(args[i], str) else args[i]
            if key == "CHARSET":
                i += 2
                continue
            if key == "UNSEEN":
                found = [m for m in found if "\\Seen" not in m["flags"]]
            elif key == "FLAGGED":
                found = [m for m in found if "\\Flagged" in m["flags"]]
            elif key == "UID":
                i += 1
                found = [m for m in found if uid_matches(args[i], m["uid"], box["next"] - 1)]
            elif key == "TEXT":
                i += 1
                needle = args[i].decode() if isinstance(args[i], bytes) else args[i]
                found = [m for m in found if needle.lower() in searchable(m["raw"])]
            i += 1
        self.send("* SEARCH " + " ".join(str(m["uid"]) for m in found) + "\r\n")
        return "OK SEARCH terminé"

    def fetch(self, box: dict, spec: str, items: str) -> str:
        for m in self.pick(box, spec):
            seq = box["messages"].index(m) + 1
            parts: list[bytes] = [f"UID {m['uid']}".encode()]
            if "FLAGS" in items.split():
                parts.append(f"FLAGS ({' '.join(sorted(m['flags']))})".encode())
            if "RFC822.SIZE" in items:
                parts.append(f"RFC822.SIZE {len(m['raw'])}".encode())
            if "INTERNALDATE" in items:
                parts.append(f'INTERNALDATE "{m["date"]}"'.encode())
            fields = re.search(r"BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]", items)
            if fields:
                data = header_fields(m["raw"], fields.group(1).split())
                parts.append(f"BODY[HEADER.FIELDS ({fields.group(1)})] {{{len(data)}}}\r\n".encode() + data)
            text = re.search(r"BODY\.PEEK\[TEXT\]<0\.(\d+)>", items)
            if text:
                data = m["raw"].split(b"\r\n\r\n", 1)[1][: int(text.group(1))]
                parts.append(f"BODY[TEXT]<0> {{{len(data)}}}\r\n".encode() + data)
            if "BODY.PEEK[]" in items:
                parts.append(f"BODY[] {{{len(m['raw'])}}}\r\n".encode() + m["raw"])
            self.send(f"* {seq} FETCH (".encode() + b" ".join(parts) + b")\r\n")
        return "OK FETCH terminé"


# ---------------------------------------------------------------------------
# Faux serveur SMTP
# ---------------------------------------------------------------------------


class FakeSmtpHandler(socketserver.StreamRequestHandler):
    sent: list[dict]

    def reply(self, text: str) -> None:
        self.wfile.write((text + "\r\n").encode())

    def handle(self) -> None:
        self.reply("220 faux.smtp ESMTP")
        authed, sender, rcpts = False, None, []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            command = line.decode().strip()
            upper = command.upper()
            if upper.startswith(("EHLO", "HELO")):
                self.wfile.write(b"250-faux.smtp\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n")
            elif upper.startswith("AUTH PLAIN"):
                _, user, password = base64.b64decode(command.split()[2]).decode("utf-8").split("\0")
                authed = user == USER and password == PASSWORD
                self.reply("235 2.7.0 ok" if authed else "535 5.7.8 Authentication failed")
            elif upper.startswith("MAIL FROM:"):
                sender = command[10:].strip()
                self.reply("250 ok" if authed else "530 auth required")
            elif upper.startswith("RCPT TO:"):
                rcpt = command[8:].strip().strip("<>")
                if rcpt.startswith("refuse@"):
                    self.reply("550 5.1.1 unknown user")
                else:
                    rcpts.append(rcpt)
                    self.reply("250 ok")
            elif upper == "DATA":
                self.reply("354 go")
                data = b""
                while True:
                    chunk = self.rfile.readline()
                    if chunk == b".\r\n":
                        break
                    data += chunk
                self.sent.append({"from": sender, "to": list(rcpts), "data": data})
                rcpts = []
                self.reply("250 queued")
            elif upper in ("RSET", "NOOP"):
                self.reply("250 ok")
            elif upper == "QUIT":
                self.reply("221 bye")
                return
            else:
                self.reply("502 not implemented")


class Servers:
    """Faux serveurs IMAP et SMTP sur des ports libres."""

    def __init__(self, *, move: bool = True):
        self.imap_state = FakeImapState(move=move)
        self.sent: list[dict] = []
        imap_handler = type("H", (FakeImapHandler,), {"state": self.imap_state})
        smtp_handler = type("S", (FakeSmtpHandler,), {"sent": self.sent})
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self.imap = socketserver.ThreadingTCPServer(("127.0.0.1", 0), imap_handler)
        self.smtp = socketserver.ThreadingTCPServer(("127.0.0.1", 0), smtp_handler)
        for server in (self.imap, self.smtp):
            server.daemon_threads = True
            threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    def close(self) -> None:
        for server in (self.imap, self.smtp):
            server.shutdown()
            server.server_close()

    def account(self, **extra) -> dict:
        return {
            "owner": "acc-1",
            "name": "Camille Martin",
            "address": USER,
            "password": PASSWORD,
            "imap": {"host": "127.0.0.1", "port": self.imap.server_address[1], "security": "none"},
            "smtp": {"host": "127.0.0.1", "port": self.smtp.server_address[1], "security": "none"},
            **extra,
        }


def mail(sender: str, subject: str, text: str, *, html: str | None = None, attachment: bytes | None = None, cte: str | None = None) -> bytes:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = USER
    message["Subject"] = subject
    message["Date"] = "Fri, 23 Oct 2026 10:00:00 +0200"
    message["Message-ID"] = f"<{abs(hash(subject))}@exemple.fr>"
    if html is not None and not text:
        message.set_content(html, subtype="html")
    else:
        message.set_content(text, cte=cte) if cte else message.set_content(text)
        if html is not None:
            message.add_alternative(html, subtype="html")
    if attachment is not None:
        message.add_attachment(attachment, maintype="application", subtype="pdf", filename="facture.pdf")
    return message.as_bytes(policy=email.policy.SMTP)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class HelpersTest(unittest.TestCase):
    def test_modified_utf7(self):
        for name in ["INBOX", "Éléments envoyés", "A&B", "日本語", "Reçus/Factures"]:
            encoded = om.imap_utf7_encode(name)
            self.assertTrue(encoded.isascii())
            self.assertEqual(om.imap_utf7_decode(encoded.encode()), name)
        self.assertEqual(om.imap_utf7_encode("Éléments envoyés"), "&AMk-l&AOk-ments envoy&AOk-s")

    def test_html_to_text(self):
        text = om.html_to_text("<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Titre</h1><p>Bonjour&nbsp;<b>Camille</b>,</p><ul><li>un</li><li>deux</li></ul><p><a href='https://exemple.fr/x'>le lien</a></p></body></html>")
        self.assertNotIn("alert", text)
        self.assertNotIn("p{}", text)
        self.assertIn("Titre", text)
        self.assertIn("Bonjour Camille,", text.replace("\xa0", " "))
        self.assertIn("• un", text)
        self.assertIn("le lien (https://exemple.fr/x)", text)

    def test_parse_list(self):
        data = [
            b'(\\HasNoChildren \\Sent) "/" "Sent"',
            b'(\\HasChildren \\Noselect) "/" "[Gmail]"',
            b'(\\HasNoChildren) "." INBOX.Factures',
            (b'(\\HasNoChildren) "/" {16}', "Éléments envoyés".encode()),
            b"",
        ]
        folders = om.parse_list(data)
        self.assertEqual([f[2] for f in folders], ["Sent", "[Gmail]", "INBOX.Factures", "Éléments envoyés"])
        self.assertEqual(om.folder_role(folders[0][0], "Sent", "/"), "sent")
        self.assertEqual(om.folder_role(set(), "Éléments envoyés", "/"), "sent")
        self.assertEqual(om.folder_label("INBOX.Factures", None, "."), "Factures")

    def test_validation(self):
        with self.assertRaises(MailError) as caught:
            om.valid_server({"host": "imap.exemple.fr", "port": 143, "security": "none"}, "IMAP")
        self.assertIn("non chiffrée", caught.exception.message)
        self.assertEqual(om.valid_server({"host": "127.0.0.1", "port": 1143, "security": "none"}, "IMAP")["host"], "127.0.0.1")
        for bad in ["pas-une-adresse", "a@b", "x y@exemple.fr", "é@exemple.fr", "a@exemple.fr\r\nBcc: x@y.fr"]:
            with self.assertRaises(MailError):
                om.valid_address(bad)
        with self.assertRaises(MailError):
            om.valid_uids([1, "2"])
        with self.assertRaises(MailError):
            om.valid_flags(["deleted"])


class AutoconfigTest(unittest.TestCase):
    def test_known_provider(self):
        service = om.MailService(om.MailStore(None))
        config = service.autoconfig({"address": "camille@gmail.com"})
        self.assertEqual(config["imap"], {"host": "imap.gmail.com", "port": 993, "security": "ssl"})
        self.assertFalse(config["saveSent"])
        self.assertIn("mot de passe d'application", config["note"])
        self.assertEqual(service.autoconfig({"address": "a@orange.fr"})["smtp"]["host"], "smtp.orange.fr")

    def test_thunderbird_database_then_guess(self):
        xml = b"""<clientConfig><emailProvider id="exemple.org">
          <incomingServer type="pop3"><hostname>pop.exemple.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
          <incomingServer type="imap"><hostname>mail.exemple.org</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer>
          <outgoingServer type="smtp"><hostname>mail.exemple.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
        </emailProvider></clientConfig>"""
        asked = []

        class Opener:
            def open(self, url, timeout=None):
                asked.append(url)
                if "exemple.org" in url:
                    return io.BytesIO(xml)
                raise OSError("404")

        service = om.MailService(om.MailStore(None), opener=Opener())
        config = service.autoconfig({"address": "camille@exemple.org"})
        self.assertEqual(config["source"], "ispdb")
        self.assertEqual(config["username"], "camille")
        self.assertEqual(config["imap"], {"host": "mail.exemple.org", "port": 143, "security": "starttls"})
        guess = service.autoconfig({"address": "camille@inconnu.fr"})
        self.assertEqual((guess["source"], guess["imap"]["host"], guess["smtp"]["host"]), ("guess", "imap.inconnu.fr", "smtp.inconnu.fr"))
        self.assertTrue(asked[0].startswith("https://autoconfig.thunderbird.net/"))


class ImapSmtpTest(unittest.TestCase):
    """Vrai code IMAP/SMTP contre les faux serveurs."""

    def setUp(self):
        self.servers = Servers()
        self.addCleanup(self.servers.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="orion-mail-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.store = om.MailStore(self.tmp / "mail.json")
        self.service = om.MailService(self.store, timeout=5)
        self.addCleanup(lambda: [self.service._close(a["id"]) for a in self.store.all()])
        state = self.servers.imap_state
        self.u_plain = state.add("INBOX", mail("Lucas Bernard <lucas@exemple.fr>", "Photos des vacances", "Coucou,\n\nJ'ai trié les photos de la Bretagne.\n\n> ancienne citation"), {"\\Seen"})
        self.u_qp = state.add("INBOX", mail("Médiathèque <media@exemple.fr>", "Réservation disponible", "Le livre réservé vous attend à l'accueil. " * 3, cte="quoted-printable"))
        self.u_html = state.add("INBOX", mail("Banque <info@banque.fr>", "Relevé", "", html="<p>Votre <b>relevé</b> est prêt.</p><p><a href='https://banque.fr/r'>Voir</a></p>"))
        self.u_att = state.add("INBOX", mail("Énergie <factures@energie.fr>", "Facture", "Ci-joint votre facture.", attachment=b"%PDF-1.4 " * 50), {"\\Flagged"})
        self.account = self.service.add_account(self.servers.account())

    def test_account_is_verified_and_kept_without_exposing_the_password(self):
        self.assertNotIn("password", self.account)
        self.assertEqual(oct((self.tmp / "mail.json").stat().st_mode & 0o777), "0o600")
        self.assertEqual(self.store.all()[0]["password"], PASSWORD)
        status = self.service.status("acc-1")
        self.assertEqual([a["address"] for a in status["accounts"]], [USER])
        self.assertNotIn("password", json.dumps(status))
        self.assertEqual(self.service.status("autre")["accounts"], [])
        with self.assertRaises(MailError) as caught:
            self.service.add_account(self.servers.account())
        self.assertEqual(caught.exception.status, 409)

    def test_wrong_password_is_refused_before_saving(self):
        with self.assertRaises(MailError) as caught:
            self.service.add_account(self.servers.account(password="mauvais", owner="acc-2"))
        self.assertEqual(caught.exception.status, 401)
        self.assertIn("serveur de réception", caught.exception.message)
        self.assertEqual(len(self.store.all()), 1)

    def test_login_is_verified_without_saving_anything(self):
        account = self.servers.account()
        self.assertEqual(self.service.verify_login({**account, "owner": "acc-2"}), {"ok": True, "address": USER})
        with self.assertRaises(MailError) as caught:
            self.service.verify_login({**account, "password": "mauvais"})
        self.assertEqual(caught.exception.status, 401)
        with self.assertRaises(MailError) as caught:
            self.service.verify_login({**account, "password": ""})
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(len(self.store.all()), 1)

    def test_unreachable_server(self):
        with self.assertRaises(MailError) as caught:
            self.service.add_account(self.servers.account(owner="acc-2", imap={"host": "127.0.0.1", "port": 1, "security": "none"}))
        self.assertEqual(caught.exception.status, 502)
        self.assertIn("Connexion refusée", caught.exception.message)

    def test_folders_roles_and_counts(self):
        folders = self.service.folders(self.account["id"])["folders"]
        by_id = {f["id"]: f for f in folders}
        self.assertNotIn("[Gmail]", by_id)  # \\Noselect
        self.assertEqual([f["role"] for f in folders[:5]], ["inbox", "sent", "drafts", "trash", "archive"])
        self.assertEqual(by_id["INBOX"]["name"], "Réception")
        self.assertEqual((by_id["INBOX"]["total"], by_id["INBOX"]["unread"]), (4, 3))
        self.assertEqual(by_id["Reçus/Factures"]["name"], "Reçus › Factures")

    def test_messages_page_preview_and_search(self):
        page = self.service.messages(self.account["id"], "INBOX", limit=3)
        self.assertEqual([m["uid"] for m in page["messages"]], [self.u_att, self.u_html, self.u_qp])
        self.assertTrue(page["more"])
        self.assertEqual(page["uidValidity"], 42)
        att, html_msg, qp = page["messages"]
        self.assertTrue(att["flagged"] and att["attachments"])
        self.assertEqual(att["from"], {"name": "Énergie", "address": "factures@energie.fr"})
        self.assertEqual(html_msg["preview"], "Votre relevé est prêt. Voir (https://banque.fr/r)")
        self.assertTrue(qp["preview"].startswith("Le livre réservé vous attend"))
        self.assertFalse(qp["seen"])
        self.assertEqual(qp["date"], 1792742400000)
        rest = self.service.messages(self.account["id"], "INBOX", before=self.u_qp, limit=3)
        self.assertEqual([m["uid"] for m in rest["messages"]], [self.u_plain])
        self.assertEqual(rest["messages"][0]["preview"], "Coucou, J'ai trié les photos de la Bretagne.")
        self.assertFalse(rest["more"])
        self.assertEqual([m["uid"] for m in self.service.messages(self.account["id"], "INBOX", query="Bretagne")["messages"]], [self.u_plain])
        self.assertEqual([m["uid"] for m in self.service.messages(self.account["id"], "INBOX", query="réservé")["messages"]], [self.u_qp])
        self.assertEqual([m["uid"] for m in self.service.messages(self.account["id"], "INBOX", filter_="flagged")["messages"]], [self.u_att])
        self.assertEqual(len(self.service.messages(self.account["id"], "INBOX", filter_="unread")["messages"]), 3)
        with self.assertRaises(MailError):
            self.service.messages(self.account["id"], "Inexistant")

    def test_read_message_text_html_and_attachments(self):
        message = self.service.message(self.account["id"], "INBOX", self.u_att)
        self.assertEqual(message["text"].strip(), "Ci-joint votre facture.")
        self.assertEqual(message["attachments"], [{"name": "facture.pdf", "type": "application/pdf", "size": 450}])
        self.assertTrue(message["messageId"].startswith("<"))
        html_msg = self.service.message(self.account["id"], "INBOX", self.u_html)
        self.assertTrue(html_msg["html"])
        self.assertNotIn("<", html_msg["text"])
        self.assertIn("relevé", html_msg["text"])
        # Lire ne marque pas comme lu (BODY.PEEK) : c'est l'interface qui le décide.
        self.assertFalse(self.service.message(self.account["id"], "INBOX", self.u_qp)["seen"])
        with self.assertRaises(MailError) as caught:
            self.service.message(self.account["id"], "INBOX", 999)
        self.assertEqual(caught.exception.status, 404)

    def test_flags_move_and_delete(self):
        acc = self.account["id"]
        self.service.flags({"account": acc, "folder": "INBOX", "uids": [self.u_qp], "add": ["seen", "flagged"]})
        self.service.flags({"account": acc, "folder": "INBOX", "uids": [self.u_att], "remove": ["flagged"]})
        summary = {m["uid"]: m for m in self.service.messages(acc, "INBOX")["messages"]}
        self.assertTrue(summary[self.u_qp]["seen"] and summary[self.u_qp]["flagged"])
        self.assertFalse(summary[self.u_att]["flagged"])
        self.assertEqual(self.service.move({"account": acc, "folder": "INBOX", "uids": [self.u_plain], "to": "archive"})["folder"], "Archive")
        self.assertEqual(len(self.service.messages(acc, "Archive")["messages"]), 1)
        self.assertEqual(self.service.delete({"account": acc, "folder": "INBOX", "uids": [self.u_html]})["folder"], "Trash")
        trash = self.service.messages(acc, "Trash")["messages"]
        self.assertEqual([m["subject"] for m in trash], ["Relevé"])
        self.assertEqual(self.service.delete({"account": acc, "folder": "Trash", "uids": [trash[0]["uid"]]})["folder"], None)
        self.assertEqual(self.service.messages(acc, "Trash")["messages"], [])
        self.assertEqual(len(self.service.messages(acc, "INBOX")["messages"]), 2)
        with self.assertRaises(MailError):
            self.service.move({"account": acc, "folder": "INBOX", "uids": [self.u_qp], "to": "Inexistant"})
        self.assertIn("UID MOVE", self.servers.imap_state.commands)

    def test_send_then_copy_in_sent(self):
        result = self.service.send(
            {
                "account": self.account["id"],
                "to": [{"name": "Lucas Bernard", "address": "lucas@exemple.fr"}],
                "cc": ["sophie@exemple.fr"],
                "bcc": [{"address": "cache@exemple.fr"}],
                "subject": "Re: Photos des vacances\r\nBcc: pirate@exemple.fr",
                "text": "Avec plaisir !\n\n> J'ai trié les photos.",
                "inReplyTo": "<123@exemple.fr>",
                "references": "<001@exemple.fr> <123@exemple.fr>",
            }
        )
        self.assertEqual(result["savedTo"], "Sent")
        self.assertEqual(len(self.servers.sent), 1)
        sent = self.servers.sent[0]
        self.assertEqual(sorted(sent["to"]), ["cache@exemple.fr", "lucas@exemple.fr", "sophie@exemple.fr"])
        parsed = email.message_from_bytes(sent["data"], policy=email.policy.default)
        self.assertEqual(str(parsed["From"]), "Camille Martin <camille@exemple.fr>")
        self.assertIsNone(parsed["Bcc"])  # jamais transmis aux destinataires
        self.assertEqual(parsed["Subject"], "Re: Photos des vacances Bcc: pirate@exemple.fr")
        self.assertEqual(parsed["In-Reply-To"], "<123@exemple.fr>")
        self.assertEqual(parsed["References"], "<001@exemple.fr> <123@exemple.fr>")
        self.assertIn("Avec plaisir", parsed.get_content())
        copy = self.service.messages(self.account["id"], "Sent")["messages"]
        self.assertEqual(copy[0]["subject"], "Re: Photos des vacances Bcc: pirate@exemple.fr")
        self.assertTrue(copy[0]["seen"])

    def test_send_errors_and_no_copy_when_provider_saves_it(self):
        acc = self.service.add_account(self.servers.account(owner="acc-2", saveSent=False))
        result = self.service.send({"account": acc["id"], "to": ["lucas@exemple.fr"], "subject": "Sans copie", "text": "x"})
        self.assertIsNone(result["savedTo"])
        self.assertEqual(self.service.messages(acc["id"], "Sent")["messages"], [])
        with self.assertRaises(MailError) as caught:
            self.service.send({"account": acc["id"], "to": ["refuse@exemple.fr"], "text": "x"})
        self.assertIn("refuse@exemple.fr", caught.exception.message)
        for body in [{"to": []}, {"to": ["pas une adresse"]}, {"to": ["a@exemple.fr"], "inReplyTo": "pas-un-id"}, {"to": ["a@exemple.fr"], "text": "x" * (om.MAX_TEXT + 1)}]:
            with self.assertRaises(MailError):
                self.service.send({"account": acc["id"], **body})
        self.service._close(acc["id"])

    def test_copy_and_expunge_without_move(self):
        servers = Servers(move=False)
        self.addCleanup(servers.close)
        service = om.MailService(om.MailStore(None), timeout=5)
        uid = servers.imap_state.add("INBOX", mail("a@exemple.fr", "Vieux", "texte"))
        acc = service.add_account(servers.account())
        service.move({"account": acc["id"], "folder": "INBOX", "uids": [uid], "to": "archive"})
        self.assertEqual(servers.imap_state.mailboxes["INBOX"]["messages"], [])
        self.assertEqual(len(servers.imap_state.mailboxes["Archive"]["messages"]), 1)
        self.assertIn("UID COPY", servers.imap_state.commands)
        service._close(acc["id"])

    def test_connection_is_reused(self):
        before = self.servers.imap_state.commands.count("AUTHENTICATE")
        for _ in range(3):
            self.service.folders(self.account["id"])
        self.assertEqual(self.servers.imap_state.commands.count("AUTHENTICATE"), before + 1)

    def test_remove_account(self):
        self.service.remove_account({"id": self.account["id"]})
        self.assertEqual(self.store.all(), [])
        with self.assertRaises(MailError) as caught:
            self.service.folders(self.account["id"])
        self.assertEqual(caught.exception.status, 404)


class MailApiTest(ServerTestCase):
    """API HTTP avec la messagerie simulée (orion_server.py --simulate)."""

    def add(self, **extra):
        body = {
            "owner": "acc-1",
            "name": "Camille",
            "address": "camille@exemple.fr",
            "password": "secret",
            "imap": {"host": "imap.exemple.fr", "port": 993, "security": "ssl"},
            "smtp": {"host": "smtp.exemple.fr", "port": 465, "security": "ssl"},
            **extra,
        }
        return self.api("POST", "/api/mail/accounts/add", body)

    def test_status_and_accounts(self):
        self.assertTrue(self.api("GET", "/api/status")[1]["capabilities"]["mail"])
        self.assertEqual(self.api("GET", "/api/mail"), (200, {"available": True, "simulated": True, "accounts": []}))
        status, data = self.add(password="faux")
        self.assertEqual(status, 401)
        self.assertIn("identifiants incorrects", data["error"])
        status, account = self.add()
        self.assertEqual(status, 200)
        self.assertNotIn("password", account)
        self.assertEqual(self.api("GET", "/api/mail?owner=acc-1")[1]["accounts"][0]["id"], account["id"])
        self.assertEqual(self.api("GET", "/api/mail?owner=acc-2")[1]["accounts"], [])
        self.assertEqual(self.add()[0], 409)
        self.assertEqual(self.add(owner="acc-3", imap={"host": "imap.exemple.fr", "port": 143, "security": "none"})[0], 400)
        self.assertEqual(self.api("POST", "/api/mail/autoconfig", {"address": "x@free.fr"})[1]["imap"]["host"], "imap.free.fr")
        self.assertEqual(self.api("POST", "/api/mail/accounts/remove", {"id": account["id"]}), (200, {"ok": True}))
        self.assertEqual(self.api("POST", "/api/mail/accounts/remove", {"id": account["id"]})[0], 404)

    def test_read_flag_move_send_and_receive(self):
        acc = self.add()[1]["id"]
        folders = self.api("GET", f"/api/mail/folders?account={acc}")[1]["folders"]
        self.assertEqual(folders[0], {"id": "INBOX", "name": "Réception", "role": "inbox", "unread": 2, "total": 3})
        listing = self.api("GET", f"/api/mail/messages?account={acc}&folder=INBOX&limit=2")[1]
        self.assertEqual(len(listing["messages"]), 2)
        self.assertTrue(listing["more"])
        uid = listing["messages"][0]["uid"]
        message = self.api("GET", f"/api/mail/message?account={acc}&folder=INBOX&uid={uid}")[1]
        self.assertIn("simulé", message["text"])
        self.assertEqual(self.api("POST", "/api/mail/flags", {"account": acc, "folder": "INBOX", "uids": [uid], "add": ["seen"]})[0], 200)
        self.assertEqual(self.api("GET", f"/api/mail/folders?account={acc}")[1]["folders"][0]["unread"], 1)
        self.assertEqual(self.api("POST", "/api/mail/move", {"account": acc, "folder": "INBOX", "uids": [uid], "to": "archive"})[1]["folder"], "Archives")
        status, sent = self.api("POST", "/api/mail/send", {"account": acc, "to": [{"name": "Moi", "address": "camille@exemple.fr"}], "subject": "Note", "text": "Penser au pain"})
        self.assertEqual(status, 200)
        self.assertTrue(sent["messageId"].startswith("<"))
        inbox = self.api("GET", f"/api/mail/messages?account={acc}&folder=INBOX&q=pain")[1]["messages"]
        self.assertEqual([m["subject"] for m in inbox], ["Note"])
        self.assertEqual(self.api("POST", "/api/simulate/incoming-mail", {"from": "lucas@exemple.fr", "name": "Lucas", "subject": "Coucou", "text": "Salut"})[0], 200)
        self.assertEqual(self.api("GET", f"/api/mail/messages?account={acc}&folder=INBOX&limit=1")[1]["messages"][0]["subject"], "Coucou")
        self.assertEqual(self.api("GET", f"/api/mail/messages?account={acc}&folder=INBOX&before=abc")[0], 400)
        self.assertEqual(self.api("GET", "/api/mail/folders?account=0000000000000000")[0], 404)
        self.assertEqual(self.api("GET", "/api/mail/folders?account=../x")[0], 400)

    def test_verify_login(self):
        body = {"address": "camille@exemple.fr", "password": "secret", "imap": {"host": "imap.exemple.fr", "port": 993, "security": "ssl"}}
        self.assertEqual(self.api("POST", "/api/mail/verify", body), (200, {"ok": True, "address": "camille@exemple.fr"}))
        self.assertEqual(self.api("POST", "/api/mail/verify", {**body, "password": "faux"})[0], 401)
        self.assertEqual(self.api("GET", "/api/mail")[1]["accounts"], [])

    def test_mail_post_requires_the_orion_header(self):
        status, _, _ = self.request("POST", "/api/mail/send", {"account": "x"}, {"Content-Type": "application/json"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
