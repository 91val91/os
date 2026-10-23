"""Messagerie d'orion-server : comptes e-mail de l'utilisateur (IMAP et SMTP).

Orion (l'interface) ne peut pas parler IMAP ni SMTP : un navigateur n'ouvre
pas de connexion TCP. orion-server le fait pour lui, avec la bibliothèque
standard de Python (imaplib, smtplib, email) :

* comptes ajoutés depuis les Réglages d'Orion, vérifiés (connexion IMAP et
  SMTP) avant d'être enregistrés dans mail.json (droits 0600, dossier de
  données du serveur). Le mot de passe n'est jamais renvoyé à l'interface ;
* dossiers (rôles « spéciaux » : envoyés, brouillons, corbeille…), liste des
  messages par pages, recherche, lecture (texte ; le HTML est converti en
  texte, jamais renvoyé tel quel), drapeaux, déplacement, suppression ;
* envoi par SMTP, avec une copie dans le dossier des envoyés si le
  fournisseur ne la fait pas lui-même ;
* configuration automatique à partir de l'adresse (fournisseurs connus, puis
  base de Thunderbird) ;
* TLS obligatoire et certificats vérifiés, sauf pour un serveur sur la
  machine elle-même (127.0.0.1 : passerelle locale comme Proton Mail Bridge).

SimulatedMailService imite des comptes en mémoire (orion_server.py --simulate).
"""

from __future__ import annotations

import base64
import contextlib
import copy
import email.policy
import email.utils
import html
import html.parser
import imaplib
import json
import logging
import os
import re
import secrets
import smtplib
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.headerregistry import Address
from email.message import EmailMessage
from email.parser import BytesHeaderParser, BytesParser
from pathlib import Path
from typing import Any, Callable, Iterator

LOG = logging.getLogger("orion-server")


class MailError(Exception):
    """Erreur à renvoyer à l'interface (code HTTP et message en français)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


SECURITIES = ("ssl", "starttls", "none")
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
HOST_RE = re.compile(r"(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|::1")
# Partie locale ASCII (pas de SMTPUTF8), domaine ASCII (IDN : forme punycode).
EMAIL_RE = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}")
ACCOUNT_ID_RE = re.compile(r"[0-9a-f]{16}")
MSGID_RE = re.compile(r"<[^<>\s]{1,250}>")
FLAG_NAMES = {"seen": "\\Seen", "flagged": "\\Flagged", "answered": "\\Answered"}
ROLES = ("inbox", "sent", "drafts", "trash", "junk", "archive", "all")
ROLE_LABELS = {
    "inbox": "Réception",
    "sent": "Envoyés",
    "drafts": "Brouillons",
    "trash": "Corbeille",
    "junk": "Indésirables",
    "archive": "Archive",
    "all": "Tous les messages",
}
# Dossiers sans attribut « special-use » (RFC 6154) : reconnus à leur nom.
ROLE_NAMES = {
    "sent": {"sent", "sent items", "sent messages", "sent mail", "envoyés", "envoyes", "éléments envoyés", "messages envoyés"},
    "drafts": {"drafts", "draft", "brouillons", "brouillon"},
    "trash": {"trash", "corbeille", "deleted items", "deleted messages", "bin", "éléments supprimés"},
    "junk": {"junk", "spam", "junk e-mail", "junk email", "courrier indésirable", "indésirables", "pourriels"},
    "archive": {"archive", "archives"},
}
SPECIAL_USE = {"\\sent": "sent", "\\drafts": "drafts", "\\trash": "trash", "\\junk": "junk", "\\archive": "archive", "\\all": "all"}

PAGE_DEFAULT = 40
PAGE_MAX = 100
MAX_RECIPIENTS = 100
MAX_TEXT = 100_000  # caractères d'un message envoyé
MAX_SHOWN = 200_000  # caractères du texte d'un message lu
MAX_FETCH = 25 * 1024 * 1024  # taille d'un message téléchargé
PREVIEW_BYTES = 4096
TIMEOUT = 25.0
KEEP_ALIVE = 90.0  # secondes : connexion IMAP gardée entre deux requêtes
EHLO_NAME = "orion-os.local"

# Fournisseurs courants (sinon : base de Thunderbird, puis imap./smtp.<domaine>).
GMAIL = {"imap": ("imap.gmail.com", 993, "ssl"), "smtp": ("smtp.gmail.com", 465, "ssl"), "saveSent": False, "note": "Gmail demande un mot de passe d'application (Compte Google → Sécurité → Mots de passe des applications), pas votre mot de passe habituel."}
OUTLOOK = {"imap": ("outlook.office365.com", 993, "ssl"), "smtp": ("smtp-mail.outlook.com", 587, "starttls"), "saveSent": False, "note": "Outlook et Hotmail refusent souvent la connexion par mot de passe (seule la connexion Microsoft, pas encore prise en charge, est acceptée)."}
YAHOO = {"imap": ("imap.mail.yahoo.com", 993, "ssl"), "smtp": ("smtp.mail.yahoo.com", 465, "ssl"), "note": "Yahoo demande un mot de passe d'application (Sécurité du compte → Générer un mot de passe d'application)."}
ICLOUD = {"imap": ("imap.mail.me.com", 993, "ssl"), "smtp": ("smtp.mail.me.com", 587, "starttls"), "note": "iCloud demande un mot de passe pour app (appleid.apple.com → Connexion et sécurité)."}
PROVIDERS: dict[str, dict] = {
    "gmail.com": GMAIL,
    "googlemail.com": GMAIL,
    "outlook.com": OUTLOOK,
    "outlook.fr": OUTLOOK,
    "hotmail.com": OUTLOOK,
    "hotmail.fr": OUTLOOK,
    "live.com": OUTLOOK,
    "live.fr": OUTLOOK,
    "msn.com": OUTLOOK,
    "yahoo.com": YAHOO,
    "yahoo.fr": YAHOO,
    "ymail.com": YAHOO,
    "icloud.com": ICLOUD,
    "me.com": ICLOUD,
    "mac.com": ICLOUD,
    "orange.fr": {"imap": ("imap.orange.fr", 993, "ssl"), "smtp": ("smtp.orange.fr", 465, "ssl")},
    "wanadoo.fr": {"imap": ("imap.orange.fr", 993, "ssl"), "smtp": ("smtp.orange.fr", 465, "ssl")},
    "free.fr": {"imap": ("imap.free.fr", 993, "ssl"), "smtp": ("smtp.free.fr", 465, "ssl")},
    "sfr.fr": {"imap": ("imap.sfr.fr", 993, "ssl"), "smtp": ("smtp.sfr.fr", 465, "ssl")},
    "neuf.fr": {"imap": ("imap.sfr.fr", 993, "ssl"), "smtp": ("smtp.sfr.fr", 465, "ssl")},
    "laposte.net": {"imap": ("imap.laposte.net", 993, "ssl"), "smtp": ("smtp.laposte.net", 465, "ssl")},
    "fastmail.com": {"imap": ("imap.fastmail.com", 993, "ssl"), "smtp": ("smtp.fastmail.com", 465, "ssl")},
}
ISPDB = "https://autoconfig.thunderbird.net/v1.1/"


# --------------------------------------------------------------------------
# Outils
# --------------------------------------------------------------------------


def is_loopback(host: str) -> bool:
    return host.strip("[]").lower() in LOOPBACK_HOSTS


def imap_utf7_encode(name: str) -> str:
    """Nom de dossier en « UTF-7 modifié » (RFC 3501, 5.1.3)."""
    out: list[str] = []
    pending: list[str] = []

    def flush() -> None:
        if pending:
            chunk = base64.b64encode("".join(pending).encode("utf-16-be")).rstrip(b"=").replace(b"/", b",")
            out.append("&" + chunk.decode("ascii") + "-")
            pending.clear()

    for char in name:
        if 0x20 <= ord(char) <= 0x7E:
            flush()
            out.append("&-" if char == "&" else char)
        else:
            pending.append(char)
    flush()
    return "".join(out)


def imap_utf7_decode(raw: bytes) -> str:
    if not raw.isascii():
        return raw.decode("utf-8", "replace")  # serveur en UTF8=ACCEPT
    text = raw.decode("ascii")
    out: list[str] = []
    i = 0
    while i < len(text):
        if text[i] != "&":
            out.append(text[i])
            i += 1
            continue
        end = text.find("-", i)
        if end == -1:
            out.append(text[i:])
            break
        chunk = text[i + 1 : end]
        if not chunk:
            out.append("&")
        else:
            data = chunk.replace(",", "/")
            data += "=" * (-len(data) % 4)
            try:
                out.append(base64.b64decode(data).decode("utf-16-be"))
            except (ValueError, UnicodeDecodeError):
                out.append(text[i : end + 1])
        i = end + 1
    return "".join(out)


def quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def quote_mailbox(name: str) -> str:
    return quote(imap_utf7_encode(name))


def unquote(raw: bytes) -> bytes:
    raw = raw.strip()
    if raw.startswith(b'"') and raw.endswith(b'"') and len(raw) >= 2:
        return re.sub(rb"\\(.)", rb"\1", raw[1:-1])
    return raw


def response_text(data: Any) -> str:
    """Texte d'une réponse IMAP (pour les messages d'erreur)."""
    parts = []
    for item in data or []:
        if isinstance(item, bytes):
            parts.append(item.decode("utf-8", "replace"))
        elif isinstance(item, tuple) and item and isinstance(item[0], bytes):
            parts.append(item[0].decode("utf-8", "replace"))
    return " ".join(parts).strip()[:200]


def ensure_ok(result: tuple[str, Any], action: str) -> Any:
    typ, data = result
    if typ != "OK":
        detail = response_text(data)
        raise MailError(502, f"Le serveur de messagerie a refusé {action}{' : ' + detail if detail else ''}")
    return data


class _HtmlText(html.parser.HTMLParser):
    """HTML → texte : blocs, listes, liens (adresse ajoutée), sans script ni style."""

    BLOCKS = {"p", "div", "tr", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "article", "header", "footer", "hr", "pre", "address"}
    SKIP = {"script", "style", "head", "title", "template", "noscript"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.links: list[tuple[str, int]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self.skip += 1
        elif tag == "br":
            self.parts.append("\n")
        elif tag == "li":
            self.parts.append("\n• ")
        elif tag in ("td", "th"):
            self.parts.append(" ")
        elif tag in self.BLOCKS:
            self.parts.append("\n\n" if tag in ("p", "h1", "h2", "h3", "blockquote") else "\n")
        elif tag == "a":
            href = dict(attrs).get("href") or ""
            self.links.append((href, len(self.parts)))
        elif tag == "img":
            alt = (dict(attrs).get("alt") or "").strip()
            if alt and not self.skip:
                self.parts.append(f"[{alt}]")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCKS:
            self.parts.append("\n")
        elif tag == "a" and self.links:
            href, start = self.links.pop()
            label = "".join(self.parts[start:]).strip()
            if href.startswith(("http://", "https://")) and href not in label and label:
                self.parts.append(f" ({href})")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(re.sub(r"\s+", " ", data))


def html_to_text(markup: str) -> str:
    parser = _HtmlText()
    try:
        parser.feed(markup)
        parser.close()
    except Exception:  # HTML très abîmé : on garde ce qui a été lu
        pass
    lines = [line.strip() for line in "".join(parser.parts).splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def decode_part(part: Any) -> str:
    raw = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    try:
        return raw.decode(charset, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


def body_text(message: Any) -> tuple[str, bool]:
    """Texte lisible d'un message : partie texte, sinon HTML converti. (texte, venait du HTML)"""
    try:
        part = message.get_body(preferencelist=("plain", "html"))
    except Exception:
        part = None
    if part is None:
        if message.get_content_maintype() == "text":
            part = message
        else:
            return "", False
    text = decode_part(part)
    if part.get_content_subtype() == "html":
        return html_to_text(text), True
    return text.replace("\r\n", "\n"), False


def preview_of(text: str) -> str:
    lines = [line for line in text.splitlines() if not line.lstrip().startswith(">")]
    return re.sub(r"\s+", " ", " ".join(lines)).strip()[:200]


def addresses(message: Any, name: str) -> list[dict]:
    try:
        header = message[name]
        if header is None:
            return []
        found = [{"name": a.display_name or "", "address": a.addr_spec} for a in header.addresses if a.addr_spec]
        if found:
            return found
    except Exception:
        pass
    raw = message.get_all(name, failobj=[]) if hasattr(message, "get_all") else []
    return [{"name": n, "address": a} for n, a in email.utils.getaddresses([str(v) for v in raw]) if a]


def header_text(message: Any, name: str, limit: int = 998) -> str:
    try:
        value = message[name]
    except Exception:
        value = None
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def message_date(message: Any, fallback: float | None) -> int | None:
    raw = header_text(message, "Date")
    if raw:
        with contextlib.suppress(TypeError, ValueError, IndexError, OverflowError):
            when = email.utils.parsedate_to_datetime(raw)
            if when.tzinfo is not None:
                return int(when.timestamp() * 1000)
    return int(fallback * 1000) if fallback else None


FETCH_START = re.compile(rb"^\d+ \(")
SECTION_RE = re.compile(rb"(BODY\[[^\]]*\](?:<\d+>)?|RFC822(?:\.HEADER|\.TEXT)?)\s*\{\d+\}\s*$", re.I)


def parse_fetch(data: list) -> list[dict]:
    """Réponse de UID FETCH (forme d'imaplib) → [{uid, flags, size, internaldate, sections}]."""
    messages: list[dict] = []
    current: dict | None = None
    for item in data or []:
        if isinstance(item, tuple):
            head, literal = item[0], item[1]
        elif isinstance(item, bytes):
            head, literal = item, None
        else:
            continue
        if FETCH_START.match(head):
            current = {"meta": b"", "sections": {}}
            messages.append(current)
        if current is None:
            continue
        current["meta"] += b" " + head
        if literal is not None:
            match = SECTION_RE.search(head)
            key = match.group(1).decode("ascii", "replace").upper() if match else "?"
            current["sections"][key] = literal
    result = []
    for message in messages:
        meta = message["meta"]
        uid = re.search(rb"UID (\d+)", meta)
        if not uid:
            continue
        flags = re.search(rb"FLAGS \(([^)]*)\)", meta)
        size = re.search(rb"RFC822\.SIZE (\d+)", meta)
        internal = re.search(rb'INTERNALDATE "([^"]+)"', meta)
        when = None
        if internal:
            parsed = imaplib.Internaldate2tuple(b'INTERNALDATE "' + internal.group(1) + b'"')
            when = time.mktime(parsed) if parsed else None
        result.append(
            {
                "uid": int(uid.group(1)),
                "flags": {f.lower() for f in flags.group(1).decode("ascii", "replace").split()} if flags else set(),
                "size": int(size.group(1)) if size else 0,
                "internaldate": when,
                "sections": message["sections"],
            }
        )
    return result


def section(sections: dict, prefix: str) -> bytes | None:
    for key, value in sections.items():
        if key.startswith(prefix):
            return value
    return None


def summary_from_fetch(item: dict) -> dict:
    headers = section(item["sections"], "BODY[HEADER") or b""
    parsed = BytesHeaderParser(policy=email.policy.default).parsebytes(headers)
    preview = ""
    partial = section(item["sections"], "BODY[TEXT]")
    if partial:
        with contextlib.suppress(Exception):
            preview = preview_of(body_text(BytesParser(policy=email.policy.default).parsebytes(headers + b"\r\n" + partial))[0])
    content_type = header_text(parsed, "Content-Type").lower()
    flags = item["flags"]
    return {
        "uid": item["uid"],
        "from": (addresses(parsed, "From") or [{"name": "", "address": ""}])[0],
        "to": addresses(parsed, "To"),
        "cc": addresses(parsed, "Cc"),
        "subject": header_text(parsed, "Subject", 500),
        "date": message_date(parsed, item["internaldate"]),
        "seen": "\\seen" in flags,
        "flagged": "\\flagged" in flags,
        "answered": "\\answered" in flags,
        "size": item["size"],
        "attachments": content_type.startswith("multipart/mixed"),
        "preview": preview,
    }


def folder_role(flags: set[str], name: str, delimiter: str | None) -> str | None:
    if name.upper() == "INBOX":
        return "inbox"
    for flag in flags:
        if flag in SPECIAL_USE:
            return SPECIAL_USE[flag]
    leaf = (name.rsplit(delimiter, 1)[-1] if delimiter else name).strip().lower()
    for role, names in ROLE_NAMES.items():
        if leaf in names:
            return role
    return None


def folder_label(name: str, role: str | None, delimiter: str | None) -> str:
    if role in ROLE_LABELS:
        return ROLE_LABELS[role]
    label = name
    if delimiter and label.upper().startswith("INBOX" + delimiter):
        label = label[len("INBOX") + len(delimiter) :]
    return label.replace(delimiter, " › ") if delimiter else label


LIST_RE = re.compile(rb'\((?P<flags>[^)]*)\) (?P<delim>"(?:[^"\\]|\\.)*"|NIL) (?P<name>.*)$', re.I)


def parse_list(data: list) -> list[tuple[set[str], str | None, str]]:
    folders = []
    for entry in data or []:
        literal = None
        if isinstance(entry, tuple):
            head, literal = entry[0], entry[1]
        elif isinstance(entry, bytes):
            head = entry
        else:
            continue
        match = LIST_RE.match(head)
        if not match:
            continue
        flags = {f.lower() for f in match.group("flags").decode("ascii", "replace").split()}
        delim = None if match.group("delim").upper() == b"NIL" else unquote(match.group("delim")).decode("ascii", "replace")
        raw = literal if literal is not None else unquote(match.group("name"))
        folders.append((flags, delim, imap_utf7_decode(raw)))
    return folders


def first_line(error: BaseException) -> str:
    text = str(error.args[-1] if getattr(error, "args", None) else error)
    if isinstance(error, smtplib.SMTPResponseException):
        text = error.smtp_error.decode("utf-8", "replace") if isinstance(error.smtp_error, bytes) else str(error.smtp_error)
    if text.startswith("b'") or text.startswith('b"'):
        text = text[2:-1]
    return text.strip().splitlines()[0][:200] if text.strip() else type(error).__name__


def network_error(error: BaseException, side: str, host: str) -> MailError:
    """Erreur de connexion → message clair (côté « réception » ou « envoi »)."""
    if isinstance(error, MailError):
        return error
    if isinstance(error, socket.gaierror):
        return MailError(502, f"Serveur d'{side} introuvable : {host}")
    if isinstance(error, ssl.SSLCertVerificationError):
        return MailError(502, f"Certificat du serveur d'{side} non valide ({host}) : connexion refusée par sécurité")
    if isinstance(error, ssl.SSLError):
        return MailError(502, f"Échec de la connexion chiffrée au serveur d'{side} ({host}) : vérifiez le port et la sécurité")
    if isinstance(error, (socket.timeout, TimeoutError)):
        return MailError(504, f"Le serveur d'{side} ne répond pas ({host})")
    if isinstance(error, ConnectionRefusedError):
        return MailError(502, f"Connexion refusée par le serveur d'{side} ({host}) : vérifiez le port")
    # Avant OSError : SMTPException en hérite.
    if isinstance(error, (imaplib.IMAP4.error, smtplib.SMTPException)):
        return MailError(502, f"Erreur du serveur d'{side} : {first_line(error)}")
    if isinstance(error, OSError):
        return MailError(502, f"Serveur d'{side} injoignable ({host}) : {error.strerror or error}")
    LOG.warning("Messagerie : erreur inattendue avec %s", host, exc_info=error)
    return MailError(502, f"Erreur de messagerie : {first_line(error)}")


def auth_hint(host: str) -> str:
    host = host.lower()
    if host.endswith(("gmail.com", "googlemail.com")):
        return GMAIL["note"]
    if host.endswith("yahoo.com"):
        return YAHOO["note"]
    if host.endswith(("me.com", "icloud.com")):
        return ICLOUD["note"]
    if "outlook" in host or "office365" in host:
        return OUTLOOK["note"]
    return "Vérifiez l'identifiant et le mot de passe ; certains fournisseurs demandent un mot de passe d'application."


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------


def text_field(body: dict, key: str, *, required: bool = True, max_len: int = 256) -> str:
    value = body.get(key)
    if value is None or value == "":
        if required:
            raise MailError(400, f"Paramètre « {key} » manquant")
        return ""
    if not isinstance(value, str) or len(value) > max_len or any(ord(c) < 0x20 for c in value):
        raise MailError(400, f"Paramètre « {key} » invalide")
    return value.strip()


def valid_address(value: Any, field: str = "address") -> str:
    if not isinstance(value, str) or not EMAIL_RE.fullmatch(value.strip()):
        raise MailError(400, f"Adresse e-mail invalide{' (' + field + ')' if field != 'address' else ''} : {str(value)[:80]}")
    return value.strip()


def valid_server(value: Any, kind: str) -> dict:
    if not isinstance(value, dict):
        raise MailError(400, f"Serveur {kind} manquant")
    host = str(value.get("host", "")).strip().lower()
    port = value.get("port")
    security = value.get("security")
    if not HOST_RE.fullmatch(host):
        raise MailError(400, f"Nom du serveur {kind} invalide")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise MailError(400, f"Port du serveur {kind} invalide")
    if security not in SECURITIES:
        raise MailError(400, f"Sécurité du serveur {kind} invalide (ssl, starttls ou none)")
    if security == "none" and not is_loopback(host):
        raise MailError(400, f"Connexion non chiffrée refusée pour le serveur {kind} : seul un serveur sur cette machine (127.0.0.1) peut s'en passer")
    return {"host": host, "port": port, "security": security}


def valid_people(body: dict, key: str) -> list[dict]:
    value = body.get(key) or []
    if not isinstance(value, list) or len(value) > MAX_RECIPIENTS:
        raise MailError(400, f"Destinataires « {key} » invalides")
    people = []
    for entry in value:
        if isinstance(entry, str):
            entry = {"address": entry}
        if not isinstance(entry, dict):
            raise MailError(400, f"Destinataire invalide ({key})")
        name = entry.get("name") or ""
        if not isinstance(name, str) or len(name) > 120:
            raise MailError(400, f"Nom de destinataire invalide ({key})")
        people.append({"name": re.sub(r"[\x00-\x1f\x7f]", " ", name).strip(), "address": valid_address(entry.get("address"), key)})
    return people


def valid_folder(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 512 or any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise MailError(400, "Dossier invalide")
    return value


def valid_uids(value: Any) -> list[int]:
    if not isinstance(value, list) or not 1 <= len(value) <= 1000:
        raise MailError(400, "Messages (uids) invalides")
    uids = []
    for uid in value:
        if isinstance(uid, bool) or not isinstance(uid, int) or not 0 < uid < 2**32:
            raise MailError(400, "Numéro de message (uid) invalide")
        uids.append(uid)
    return sorted(set(uids))


def valid_flags(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(flag not in FLAG_NAMES for flag in value):
        raise MailError(400, "Drapeaux invalides (seen, flagged, answered)")
    return list(dict.fromkeys(value))


def uid_set(uids: list[int]) -> str:
    return ",".join(str(uid) for uid in uids)


# --------------------------------------------------------------------------
# Comptes enregistrés
# --------------------------------------------------------------------------


class MailStore:
    """Comptes de messagerie, mot de passe compris : mail.json, droits 0600 (en mémoire sans fichier).

    Le mot de passe est en clair dans ce fichier, comme dans la plupart des
    logiciels de messagerie sans « mot de passe principal » : il doit pouvoir
    être envoyé au serveur. Seul l'utilisateur du service (et root) peut le lire.
    """

    def __init__(self, path: Path | None):
        self.path = path
        self._lock = threading.Lock()
        self._memory: dict = {"accounts": []}

    def _read(self) -> dict:
        if self.path is None:
            return copy.deepcopy(self._memory)
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return {"accounts": []}
        except (OSError, ValueError):
            LOG.warning("Messagerie : %s illisible", self.path)
            return {"accounts": []}
        if not isinstance(data, dict) or not isinstance(data.get("accounts"), list):
            return {"accounts": []}
        return data

    def _write(self, data: dict) -> None:
        if self.path is None:
            self._memory = copy.deepcopy(data)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def all(self) -> list[dict]:
        with self._lock:
            return [a for a in self._read()["accounts"] if isinstance(a, dict) and ACCOUNT_ID_RE.fullmatch(str(a.get("id", "")))]

    def get(self, account_id: Any) -> dict:
        if not isinstance(account_id, str) or not ACCOUNT_ID_RE.fullmatch(account_id):
            raise MailError(400, "Compte de messagerie invalide")
        for account in self.all():
            if account["id"] == account_id:
                return account
        raise MailError(404, "Compte de messagerie introuvable")

    def add(self, account: dict) -> dict:
        with self._lock:
            data = self._read()
            if any(a.get("address", "").lower() == account["address"].lower() and a.get("owner") == account.get("owner") for a in data["accounts"]):
                raise MailError(409, "Ce compte de messagerie est déjà ajouté")
            data["accounts"].append(account)
            self._write(data)
        return account

    def remove(self, account_id: str) -> None:
        self.get(account_id)
        with self._lock:
            data = self._read()
            data["accounts"] = [a for a in data["accounts"] if a.get("id") != account_id]
            self._write(data)


def public(account: dict) -> dict:
    """Ce que l'interface voit d'un compte (jamais le mot de passe)."""
    return {
        "id": account["id"],
        "owner": account.get("owner"),
        "name": account.get("name", ""),
        "address": account["address"],
        "username": account["username"],
        "imap": dict(account["imap"]),
        "smtp": dict(account["smtp"]),
        "saveSent": bool(account.get("saveSent", True)),
        "createdAt": account.get("createdAt"),
    }


# --------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------


class MailService:
    """Comptes (MailStore) et opérations IMAP/SMTP, une connexion IMAP gardée par compte."""

    simulated = False

    def __init__(self, store: MailStore, *, timeout: float = TIMEOUT, opener: urllib.request.OpenerDirector | None = None, clock: Callable[[], float] = time.time):
        self.store = store
        self.timeout = timeout
        self.opener = opener
        self.clock = clock
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._sessions: dict[str, tuple[imaplib.IMAP4, float]] = {}

    # --- comptes ------------------------------------------------------------

    def status(self, owner: str | None = None) -> dict:
        accounts = [public(a) for a in self.store.all() if owner is None or a.get("owner") in (owner, None)]
        return {"available": True, "simulated": self.simulated, "accounts": accounts}

    def autoconfig(self, body: dict) -> dict:
        address = valid_address(body.get("address"))
        domain = address.rsplit("@", 1)[1].lower()
        known = PROVIDERS.get(domain)
        if known:
            return self._config(address, known, "known")
        found = self._ispdb(address, domain)
        if found:
            return found
        guess = {"imap": (f"imap.{domain}", 993, "ssl"), "smtp": (f"smtp.{domain}", 465, "ssl")}
        return self._config(address, guess, "guess")

    @staticmethod
    def _config(address: str, provider: dict, source: str, username: str | None = None) -> dict:
        def server(spec: tuple[str, int, str]) -> dict:
            return {"host": spec[0], "port": spec[1], "security": spec[2]}

        domain = address.rsplit("@", 1)[1].lower()
        return {
            "source": source,
            "username": username or address,
            "imap": server(provider["imap"]),
            "smtp": server(provider["smtp"]),
            "saveSent": provider.get("saveSent", not domain.endswith(("gmail.com", "googlemail.com"))),
            "note": provider.get("note", ""),
        }

    def _ispdb(self, address: str, domain: str) -> dict | None:
        """Base de configuration de Thunderbird (fournisseurs moins courants)."""
        opener = self.opener or urllib.request.build_opener()
        try:
            with opener.open(ISPDB + urllib.parse.quote(domain), timeout=8) as response:
                root = ET.fromstring(response.read(256 * 1024))
        except Exception:
            return None
        local = address.rsplit("@", 1)[0]

        def pick(kind: str, type_: str) -> tuple[tuple[str, int, str], str] | None:
            for node in root.iter(kind):
                if node.get("type") != type_:
                    continue
                host = (node.findtext("hostname") or "").strip().lower()
                port = int((node.findtext("port") or "0").strip() or 0)
                socket_type = (node.findtext("socketType") or "").strip().upper()
                security = {"SSL": "ssl", "STARTTLS": "starttls"}.get(socket_type)
                user = (node.findtext("username") or "%EMAILADDRESS%").replace("%EMAILADDRESS%", address).replace("%EMAILLOCALPART%", local).replace("%EMAILDOMAIN%", domain)
                if security and HOST_RE.fullmatch(host) and 0 < port < 65536:
                    return (host, port, security), user
            return None

        imap = pick("incomingServer", "imap")
        smtp = pick("outgoingServer", "smtp")
        if not imap or not smtp:
            return None
        return self._config(address, {"imap": imap[0], "smtp": smtp[0]}, "ispdb", imap[1])

    def add_account(self, body: dict) -> dict:
        address = valid_address(body.get("address"))
        account = {
            "id": secrets.token_hex(8),
            "owner": text_field(body, "owner", required=False, max_len=64) or None,
            "name": text_field(body, "name", required=False, max_len=120),
            "address": address,
            "username": text_field(body, "username", required=False, max_len=256) or address,
            "password": body.get("password"),
            "imap": valid_server(body.get("imap"), "de réception (IMAP)"),
            "smtp": valid_server(body.get("smtp"), "d'envoi (SMTP)"),
            "saveSent": body.get("saveSent", True) is not False,
            "createdAt": int(self.clock() * 1000),
        }
        password = account["password"]
        if not isinstance(password, str) or not password or len(password) > 1024 or "\n" in password or "\r" in password:
            raise MailError(400, "Mot de passe manquant ou invalide")
        self.verify(account)
        self.store.add(account)
        LOG.info("Messagerie : compte ajouté (%s)", address)
        return public(account)

    def remove_account(self, body: dict) -> dict:
        account = self.store.get(body.get("id"))
        self._close(account["id"])
        self.store.remove(account["id"])
        LOG.info("Messagerie : compte retiré (%s)", account["address"])
        return {"ok": True}

    # --- connexions -----------------------------------------------------------

    @staticmethod
    def _context(host: str) -> ssl.SSLContext:
        context = ssl.create_default_context()
        if is_loopback(host):
            # Passerelle sur la machine (Proton Mail Bridge…) : certificat auto-signé, rien ne sort.
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        return context

    def _open_imap(self, account: dict) -> imaplib.IMAP4:
        server = account["imap"]
        host, port, security = server["host"], server["port"], server["security"]
        imap: imaplib.IMAP4 | None = None
        try:
            if security == "ssl":
                imap = imaplib.IMAP4_SSL(host, port, ssl_context=self._context(host), timeout=self.timeout)
            else:
                imap = imaplib.IMAP4(host, port, timeout=self.timeout)
                if security == "starttls":
                    imap.starttls(ssl_context=self._context(host))
        except Exception as error:
            with contextlib.suppress(Exception):
                if imap is not None:
                    imap.shutdown()
            raise network_error(error, "réception", host) from None
        user, password = account["username"], account["password"]
        try:
            if user.isascii() and password.isascii():
                imap.login(user, password)
            elif "AUTH=PLAIN" in imap.capabilities:
                imap.authenticate("PLAIN", lambda _: f"\0{user}\0{password}".encode())
            else:
                raise MailError(401, "Le serveur de réception n'accepte pas ce mot de passe (caractères accentués)")
        except imaplib.IMAP4.error as error:
            with contextlib.suppress(Exception):
                imap.shutdown()
            raise MailError(401, f"Connexion refusée par le serveur de réception ({first_line(error)}). {auth_hint(host)}") from None
        except MailError:
            with contextlib.suppress(Exception):
                imap.shutdown()
            raise
        except Exception as error:
            with contextlib.suppress(Exception):
                imap.shutdown()
            raise network_error(error, "réception", host) from None
        imap._orion_selected = None  # type: ignore[attr-defined]
        return imap

    def _lock(self, account_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(account_id, threading.Lock())

    def _close(self, account_id: str) -> None:
        with self._locks_guard:
            entry = self._sessions.pop(account_id, None)
        if entry:
            with contextlib.suppress(Exception):
                entry[0].logout()

    @contextlib.contextmanager
    def _imap(self, account: dict) -> Iterator[imaplib.IMAP4]:
        """Connexion IMAP du compte : réutilisée si récente et vivante, recréée sinon."""
        with self._lock(account["id"]):
            with self._locks_guard:
                entry = self._sessions.pop(account["id"], None)
            imap = None
            if entry and time.monotonic() - entry[1] < KEEP_ALIVE:
                with contextlib.suppress(Exception):
                    if entry[0].noop()[0] == "OK":
                        imap = entry[0]
            if imap is None:
                if entry:
                    with contextlib.suppress(Exception):
                        entry[0].shutdown()
                imap = self._open_imap(account)
            try:
                yield imap
            except MailError:
                # Erreur du serveur sur une commande : la connexion reste utilisable.
                with self._locks_guard:
                    self._sessions[account["id"]] = (imap, time.monotonic())
                raise
            except Exception as error:
                with contextlib.suppress(Exception):
                    imap.shutdown()
                raise network_error(error, "réception", account["imap"]["host"]) from None
            with self._locks_guard:
                self._sessions[account["id"]] = (imap, time.monotonic())

    @staticmethod
    def _select(imap: imaplib.IMAP4, folder: str, readonly: bool) -> int:
        """Ouvre un dossier ; renvoie son UIDVALIDITY."""
        current = getattr(imap, "_orion_selected", None)
        if current and current[0] == folder and (readonly or not current[1]):
            return current[2]
        typ, data = imap.select(quote_mailbox(folder), readonly=readonly)
        if typ != "OK":
            imap._orion_selected = None  # type: ignore[attr-defined]
            raise MailError(404, f"Dossier introuvable : {folder}")
        validity = 0
        with contextlib.suppress(Exception):
            validity = int((imap.response("UIDVALIDITY")[1] or [b"0"])[-1] or 0)
        imap._orion_selected = (folder, readonly, validity)  # type: ignore[attr-defined]
        return validity

    def _open_smtp(self, account: dict) -> smtplib.SMTP:
        server = account["smtp"]
        host, port, security = server["host"], server["port"], server["security"]
        smtp: smtplib.SMTP | None = None
        try:
            if security == "ssl":
                smtp = smtplib.SMTP_SSL(host, port, local_hostname=EHLO_NAME, context=self._context(host), timeout=self.timeout)
            else:
                smtp = smtplib.SMTP(host, port, local_hostname=EHLO_NAME, timeout=self.timeout)
                if security == "starttls":
                    smtp.starttls(context=self._context(host))
            smtp.ehlo()
            if smtp.has_extn("auth"):
                user, password = account["username"], account["password"]
                if user.isascii() and password.isascii():
                    smtp.login(user, password)
                else:
                    token = base64.b64encode(f"\0{user}\0{password}".encode()).decode("ascii")
                    code, reply = smtp.docmd("AUTH", "PLAIN " + token)
                    if code != 235:
                        raise smtplib.SMTPAuthenticationError(code, reply)
            elif not is_loopback(host):
                raise MailError(502, f"Le serveur d'envoi ({host}) ne propose pas d'authentification")
        except smtplib.SMTPAuthenticationError as error:
            self._quit(smtp)
            raise MailError(401, f"Connexion refusée par le serveur d'envoi ({first_line(error)}). {auth_hint(host)}") from None
        except MailError:
            self._quit(smtp)
            raise
        except Exception as error:
            self._quit(smtp)
            raise network_error(error, "envoi", host) from None
        return smtp

    @staticmethod
    def _quit(smtp: smtplib.SMTP | None) -> None:
        if smtp is not None:
            with contextlib.suppress(Exception):
                smtp.quit()
            with contextlib.suppress(Exception):
                smtp.close()

    def verify(self, account: dict) -> None:
        """Connexion aux deux serveurs avec les identifiants (avant d'enregistrer le compte)."""
        imap = self._open_imap(account)
        with contextlib.suppress(Exception):
            imap.logout()
        self._quit(self._open_smtp(account))

    # --- dossiers et messages ---------------------------------------------------

    def _folders(self, imap: imaplib.IMAP4, counts: bool) -> list[dict]:
        listed = parse_list(ensure_ok(imap.list(), "la liste des dossiers"))
        folders = []
        seen_roles: set[str] = set()
        for flags, delimiter, name in listed:
            if "\\noselect" in flags or "\\nonexistent" in flags:
                continue
            role = folder_role(flags, name, delimiter)
            if role in seen_roles:
                role = None  # deux « Envoyés » : seul le premier garde le rôle
            if role:
                seen_roles.add(role)
            folders.append({"id": name, "name": folder_label(name, role, delimiter), "role": role, "unread": None, "total": None})
        order = {role: i for i, role in enumerate(ROLES)}
        folders.sort(key=lambda f: (order.get(f["role"], len(ROLES)), f["name"].lower()))
        if counts:
            for folder in folders:
                if folder["role"] not in ("inbox", "sent", "drafts", "trash", "junk", "archive"):
                    continue
                with contextlib.suppress(Exception):
                    typ, data = imap.status(quote_mailbox(folder["id"]), "(MESSAGES UNSEEN)")
                    if typ == "OK":
                        text = response_text(data)
                        total = re.search(r"MESSAGES (\d+)", text)
                        unread = re.search(r"UNSEEN (\d+)", text)
                        folder["total"] = int(total.group(1)) if total else None
                        folder["unread"] = int(unread.group(1)) if unread else None
        return folders

    def folders(self, account_id: Any) -> dict:
        account = self.store.get(account_id)
        with self._imap(account) as imap:
            return {"folders": self._folders(imap, counts=True)}

    def _role_folder(self, imap: imaplib.IMAP4, role: str) -> str | None:
        return next((f["id"] for f in self._folders(imap, counts=False) if f["role"] == role), None)

    def messages(self, account_id: Any, folder: Any, *, before: int | None = None, limit: int = PAGE_DEFAULT, query: str = "", filter_: str = "") -> dict:
        account = self.store.get(account_id)
        folder = valid_folder(folder)
        limit = max(1, min(PAGE_MAX, limit))
        if filter_ not in ("", "unread", "flagged"):
            raise MailError(400, "Filtre invalide (unread ou flagged)")
        if len(query) > 200 or any(ord(c) < 0x20 for c in query):
            raise MailError(400, "Recherche invalide")
        with self._imap(account) as imap:
            validity = self._select(imap, folder, readonly=True)
            criteria: list[str] = []
            if filter_ == "unread":
                criteria.append("UNSEEN")
            elif filter_ == "flagged":
                criteria.append("FLAGGED")
            if before is not None:
                if before <= 1:
                    return {"messages": [], "more": False, "uidValidity": validity}
                criteria.append(f"UID 1:{before - 1}")
            query = query.strip()
            if query and query.isascii():
                result = imap.uid("SEARCH", *criteria, "TEXT", quote(query))
            elif query:
                imap.literal = query.encode("utf-8")
                result = imap.uid("SEARCH", "CHARSET", "UTF-8", *criteria, "TEXT")
            else:
                result = imap.uid("SEARCH", *(criteria or ["ALL"]))
            data = ensure_ok(result, "la recherche")
            uids = sorted({int(x) for x in b" ".join(d for d in data if isinstance(d, bytes)).split() if x.isdigit()}, reverse=True)
            page = uids[:limit]
            items = []
            if page:
                fields = "FROM TO CC SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING"
                spec = f"(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS ({fields})] BODY.PEEK[TEXT]<0.{PREVIEW_BYTES}>)"
                fetched = parse_fetch(ensure_ok(imap.uid("FETCH", uid_set(page), spec), "la lecture des messages"))
                items = sorted((summary_from_fetch(item) for item in fetched), key=lambda m: m["uid"], reverse=True)
            return {"messages": items, "more": len(uids) > limit, "uidValidity": validity}

    def message(self, account_id: Any, folder: Any, uid: Any) -> dict:
        account = self.store.get(account_id)
        folder = valid_folder(folder)
        uid = valid_uids([uid])[0]
        with self._imap(account) as imap:
            self._select(imap, folder, readonly=True)
            info = parse_fetch(ensure_ok(imap.uid("FETCH", str(uid), "(UID FLAGS RFC822.SIZE INTERNALDATE)"), "la lecture du message"))
            if not info:
                raise MailError(404, "Message introuvable (déplacé ou supprimé)")
            if info[0]["size"] > MAX_FETCH:
                raise MailError(413, "Message trop volumineux pour être affiché ici")
            fetched = parse_fetch(ensure_ok(imap.uid("FETCH", str(uid), "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])"), "la lecture du message"))
        if not fetched:
            raise MailError(404, "Message introuvable (déplacé ou supprimé)")
        item = fetched[0]
        raw = section(item["sections"], "BODY[]") or b""
        parsed = BytesParser(policy=email.policy.default).parsebytes(raw)
        text, from_html = body_text(parsed)
        attachments = []
        with contextlib.suppress(Exception):
            for part in parsed.iter_attachments():
                payload = part.get_payload(decode=True) or b""
                attachments.append({"name": part.get_filename() or "Pièce jointe", "type": part.get_content_type(), "size": len(payload)})
        flags = item["flags"]
        return {
            "uid": item["uid"],
            "from": (addresses(parsed, "From") or [{"name": "", "address": ""}])[0],
            "to": addresses(parsed, "To"),
            "cc": addresses(parsed, "Cc"),
            "replyTo": addresses(parsed, "Reply-To"),
            "subject": header_text(parsed, "Subject", 500),
            "date": message_date(parsed, item["internaldate"]),
            "seen": "\\seen" in flags,
            "flagged": "\\flagged" in flags,
            "answered": "\\answered" in flags,
            "size": item["size"],
            "text": text[:MAX_SHOWN],
            "truncated": len(text) > MAX_SHOWN,
            "html": from_html,
            "attachments": attachments[:50],
            "messageId": header_text(parsed, "Message-ID", 300),
            "references": header_text(parsed, "References", 2000),
        }

    def flags(self, body: dict) -> dict:
        account = self.store.get(body.get("account"))
        folder = valid_folder(body.get("folder"))
        uids = valid_uids(body.get("uids"))
        add, remove = valid_flags(body.get("add")), valid_flags(body.get("remove"))
        with self._imap(account) as imap:
            self._select(imap, folder, readonly=False)
            for sign, names in (("+", add), ("-", remove)):
                if names:
                    flags = "(" + " ".join(FLAG_NAMES[n] for n in names) + ")"
                    ensure_ok(imap.uid("STORE", uid_set(uids), sign + "FLAGS.SILENT", flags), "le changement de drapeaux")
        return {"ok": True}

    def _expunge(self, imap: imaplib.IMAP4, uids: list[int]) -> None:
        ensure_ok(imap.uid("STORE", uid_set(uids), "+FLAGS.SILENT", "(\\Deleted)"), "la suppression")
        if "UIDPLUS" in imap.capabilities:
            ensure_ok(imap.uid("EXPUNGE", uid_set(uids)), "la suppression")
        else:
            ensure_ok(imap.expunge(), "la suppression")

    def _move(self, imap: imaplib.IMAP4, uids: list[int], target: str) -> None:
        if "MOVE" in imap.capabilities:
            ensure_ok(imap.uid("MOVE", uid_set(uids), quote_mailbox(target)), "le déplacement")
        else:
            ensure_ok(imap.uid("COPY", uid_set(uids), quote_mailbox(target)), "le déplacement")
            self._expunge(imap, uids)

    def _target(self, imap: imaplib.IMAP4, target: Any) -> str:
        """Dossier de destination : un rôle (« archive »…) ou le nom d'un dossier existant."""
        folders = self._folders(imap, counts=False)
        if target in ROLES:
            found = next((f["id"] for f in folders if f["role"] == target), None)
            if not found:
                raise MailError(404, f"Ce compte n'a pas de dossier « {ROLE_LABELS[target]} »")
            return found
        name = valid_folder(target)
        if not any(f["id"] == name for f in folders):
            raise MailError(404, f"Dossier introuvable : {name}")
        return name

    def move(self, body: dict) -> dict:
        account = self.store.get(body.get("account"))
        folder = valid_folder(body.get("folder"))
        uids = valid_uids(body.get("uids"))
        with self._imap(account) as imap:
            target = self._target(imap, body.get("to"))
            if target == folder:
                return {"ok": True, "folder": target}
            self._select(imap, folder, readonly=False)
            self._move(imap, uids, target)
        return {"ok": True, "folder": target}

    def delete(self, body: dict) -> dict:
        """Vers la corbeille ; définitivement si le message y est déjà (ou sans corbeille)."""
        account = self.store.get(body.get("account"))
        folder = valid_folder(body.get("folder"))
        uids = valid_uids(body.get("uids"))
        with self._imap(account) as imap:
            trash = self._role_folder(imap, "trash")
            self._select(imap, folder, readonly=False)
            if trash and trash != folder:
                self._move(imap, uids, trash)
                return {"ok": True, "folder": trash}
            self._expunge(imap, uids)
        return {"ok": True, "folder": None}

    # --- envoi ------------------------------------------------------------------

    @staticmethod
    def compose(account: dict, body: dict, now: float) -> EmailMessage:
        to, cc, bcc = valid_people(body, "to"), valid_people(body, "cc"), valid_people(body, "bcc")
        if not to and not cc and not bcc:
            raise MailError(400, "Aucun destinataire")
        if len(to) + len(cc) + len(bcc) > MAX_RECIPIENTS:
            raise MailError(400, f"Trop de destinataires ({MAX_RECIPIENTS} au plus)")
        subject = body.get("subject") or ""
        text = body.get("text") or ""
        if not isinstance(subject, str) or len(subject) > 500 or not isinstance(text, str) or len(text) > MAX_TEXT:
            raise MailError(400, "Objet ou texte du message invalide (trop long ?)")
        message = EmailMessage()

        def person(p: dict) -> Address:
            local, domain = p["address"].rsplit("@", 1)
            return Address(display_name=p.get("name") or "", username=local, domain=domain)

        message["From"] = person({"name": account.get("name") or "", "address": account["address"]})
        if to:
            message["To"] = [person(p) for p in to]
        if cc:
            message["Cc"] = [person(p) for p in cc]
        if bcc:
            message["Bcc"] = [person(p) for p in bcc]
        message["Subject"] = re.sub(r"[\r\n]+", " ", subject).strip()
        message["Date"] = email.utils.formatdate(now, localtime=True)
        message["Message-ID"] = email.utils.make_msgid(domain=account["address"].rsplit("@", 1)[1])
        reply_to = body.get("inReplyTo") or ""
        if reply_to:
            if not isinstance(reply_to, str) or not MSGID_RE.fullmatch(reply_to.strip()):
                raise MailError(400, "Message d'origine (inReplyTo) invalide")
            refs = body.get("references") or ""
            if not isinstance(refs, str) or len(refs) > 4000:
                raise MailError(400, "Références invalides")
            chain = MSGID_RE.findall(refs)[-20:]
            if reply_to.strip() not in chain:
                chain.append(reply_to.strip())
            message["In-Reply-To"] = reply_to.strip()
            message["References"] = " ".join(chain)
        message["X-Mailer"] = "Orion OS"
        message.set_content(text.replace("\r\n", "\n"))
        return message

    def send(self, body: dict) -> dict:
        account = self.store.get(body.get("account"))
        message = self.compose(account, body, self.clock())
        smtp = self._open_smtp(account)
        try:
            refused = smtp.send_message(message)
        except smtplib.SMTPRecipientsRefused as error:
            raise MailError(400, "Destinataire refusé par le serveur : " + ", ".join(error.recipients)) from None
        except smtplib.SMTPSenderRefused as error:
            raise MailError(400, f"Expéditeur refusé par le serveur d'envoi : {first_line(error)}") from None
        except smtplib.SMTPDataError as error:
            raise MailError(502, f"Message refusé par le serveur d'envoi : {first_line(error)}") from None
        except Exception as error:
            raise network_error(error, "envoi", account["smtp"]["host"]) from None
        finally:
            self._quit(smtp)
        LOG.info("Messagerie : message envoyé depuis %s", account["address"])
        saved = None
        if account.get("saveSent", True):
            saved = self._save_sent(account, message)
        return {"ok": True, "messageId": message["Message-ID"], "refused": sorted(refused), "savedTo": saved}

    def _save_sent(self, account: dict, message: EmailMessage) -> str | None:
        """Copie dans « Envoyés » (le message est parti : un échec ici n'est pas une erreur d'envoi)."""
        try:
            with self._imap(account) as imap:
                sent = self._role_folder(imap, "sent")
                if not sent:
                    return None
                data = message.as_bytes(policy=email.policy.SMTP)
                ensure_ok(imap.append(quote_mailbox(sent), "(\\Seen)", imaplib.Time2Internaldate(self.clock()), data), "la copie dans les envoyés")
                return sent
        except MailError as error:
            LOG.warning("Messagerie : copie dans les envoyés impossible : %s", error.message)
            return None


# --------------------------------------------------------------------------
# Messagerie simulée (--simulate)
# --------------------------------------------------------------------------


class SimulatedMailService(MailService):
    """Comptes imités en mémoire : tout mot de passe est accepté, sauf « faux »."""

    simulated = True

    def __init__(self, store: MailStore | None = None, *, clock: Callable[[], float] = time.time):
        super().__init__(store or MailStore(None), clock=clock)
        self._boxes: dict[str, dict] = {}
        self._guard = threading.Lock()

    def _ispdb(self, address: str, domain: str) -> dict | None:
        return None  # pas de réseau en simulation

    def verify(self, account: dict) -> None:
        if account["password"] == "faux":
            raise MailError(401, f"Connexion refusée par le serveur de réception (identifiants incorrects). {auth_hint(account['imap']['host'])}")
        if account["imap"]["host"].startswith("introuvable."):
            raise MailError(502, f"Serveur de réception introuvable : {account['imap']['host']}")

    def _box(self, account: dict) -> dict:
        with self._guard:
            box = self._boxes.get(account["id"])
            if box is None:
                box = self._seed(account)
                self._boxes[account["id"]] = box
            return box

    def _seed(self, account: dict) -> dict:
        now = self.clock()
        me = {"name": account.get("name") or "", "address": account["address"]}
        folders = {name: [] for name in ("INBOX", "Envoyés", "Brouillons", "Corbeille", "Indésirables", "Archives", "Factures")}
        box = {"folders": folders, "next": 1, "validity": 1}
        samples = [
            ("INBOX", {"name": "Équipe Orion (simulation)", "address": "bienvenue@orion.test"}, "Votre messagerie fonctionne", "Bonjour,\n\nCe compte est simulé par orion-server (--simulate) : les messages restent en mémoire et rien n'est envoyé sur Internet.\n\nSur Orion installé, vos vrais comptes (IMAP et SMTP) sont relevés de la même façon.\n\nBonne journée !", 600, False),
            ("INBOX", {"name": "Camille Martin", "address": "camille.martin@exemple.fr"}, "Dîner samedi ?", "Salut !\n\nOn organise un dîner samedi soir, vers 20 h. Tu viens ?\n\nCamille", 7200, False),
            ("INBOX", {"name": "Banque Exemple", "address": "info@banque.exemple.fr"}, "Votre relevé du mois est disponible", "<p>Bonjour,</p><p>Votre <b>relevé</b> est disponible dans votre espace client.</p><p><a href=\"https://banque.exemple.fr/releve\">Consulter</a></p>", 86400, True),
            ("Factures", {"name": "Fournisseur d'énergie", "address": "factures@energie.exemple.fr"}, "Facture d'octobre", "Bonjour,\n\nVotre facture d'octobre s'élève à 54,20 €.\n\nCordialement", 5 * 86400, True),
            ("Envoyés", me, "Re: Dîner samedi ?", "Avec plaisir !\n\n> On organise un dîner samedi soir, vers 20 h.", 3600, True),
        ]
        # Du plus ancien au plus récent : les numéros (uid) suivent l'ordre d'arrivée, comme en IMAP.
        for folder, sender, subject, text, age, seen in sorted(samples, key=lambda sample: -sample[4]):
            to = [{"name": "Camille Martin", "address": "camille.martin@exemple.fr"}] if folder == "Envoyés" else [me]
            self._store(box, folder, sender, to, [], subject, text, now - age, seen=seen, html_body=text.startswith("<"))
        return box

    def _store(self, box: dict, folder: str, sender: dict, to: list, cc: list, subject: str, text: str, when: float, *, seen: bool, html_body: bool = False, message_id: str = "", references: str = "") -> dict:
        message = {
            "uid": box["next"],
            "from": sender,
            "to": to,
            "cc": cc,
            "replyTo": [],
            "subject": subject,
            "date": int(when * 1000),
            "seen": seen,
            "flagged": False,
            "answered": False,
            "size": len(text.encode()) + 400,
            "text": html_to_text(text) if html_body else text,
            "html": html_body,
            "attachments": [],
            "messageId": message_id or f"<sim-{box['next']}@orion.test>",
            "references": references,
        }
        box["next"] += 1
        box["folders"][folder].append(message)
        return message

    @staticmethod
    def _summary(message: dict) -> dict:
        keys = ("uid", "from", "to", "cc", "subject", "date", "seen", "flagged", "answered", "size")
        return {**{k: copy.deepcopy(message[k]) for k in keys}, "attachments": bool(message["attachments"]), "preview": preview_of(message["text"])}

    def _folder(self, box: dict, folder: Any) -> list:
        folder = valid_folder(folder)
        if folder not in box["folders"]:
            raise MailError(404, f"Dossier introuvable : {folder}")
        return box["folders"][folder]

    def _role(self, name: str) -> str | None:
        return {"INBOX": "inbox", "Envoyés": "sent", "Brouillons": "drafts", "Corbeille": "trash", "Indésirables": "junk", "Archives": "archive"}.get(name)

    def folders(self, account_id: Any) -> dict:
        box = self._box(self.store.get(account_id))
        with self._guard:
            folders = []
            for name, messages in box["folders"].items():
                role = self._role(name)
                folders.append({"id": name, "name": folder_label(name, role, "/"), "role": role, "unread": sum(not m["seen"] for m in messages) if role else None, "total": len(messages) if role else None})
        order = {role: i for i, role in enumerate(ROLES)}
        folders.sort(key=lambda f: (order.get(f["role"], len(ROLES)), f["name"].lower()))
        return {"folders": folders}

    def messages(self, account_id: Any, folder: Any, *, before: int | None = None, limit: int = PAGE_DEFAULT, query: str = "", filter_: str = "") -> dict:
        box = self._box(self.store.get(account_id))
        limit = max(1, min(PAGE_MAX, limit))
        with self._guard:
            items = sorted(self._folder(box, folder), key=lambda m: m["uid"], reverse=True)
            if filter_ == "unread":
                items = [m for m in items if not m["seen"]]
            elif filter_ == "flagged":
                items = [m for m in items if m["flagged"]]
            if before is not None:
                items = [m for m in items if m["uid"] < before]
            needle = query.strip().lower()
            if needle:
                items = [m for m in items if needle in " ".join([m["subject"], m["text"], m["from"]["name"], m["from"]["address"]]).lower()]
            return {"messages": [self._summary(m) for m in items[:limit]], "more": len(items) > limit, "uidValidity": box["validity"]}

    def message(self, account_id: Any, folder: Any, uid: Any) -> dict:
        box = self._box(self.store.get(account_id))
        uid = valid_uids([uid])[0]
        with self._guard:
            found = next((m for m in self._folder(box, folder) if m["uid"] == uid), None)
            if not found:
                raise MailError(404, "Message introuvable (déplacé ou supprimé)")
            return {**copy.deepcopy(found), "truncated": False}

    def _pick(self, box: dict, body: dict) -> tuple[list, list[dict]]:
        messages = self._folder(box, body.get("folder"))
        uids = set(valid_uids(body.get("uids")))
        return messages, [m for m in messages if m["uid"] in uids]

    def flags(self, body: dict) -> dict:
        box = self._box(self.store.get(body.get("account")))
        add, remove = valid_flags(body.get("add")), valid_flags(body.get("remove"))
        with self._guard:
            _, chosen = self._pick(box, body)
            for message in chosen:
                for flag in add:
                    message[flag] = True
                for flag in remove:
                    message[flag] = False
        return {"ok": True}

    def _target_name(self, box: dict, target: Any) -> str:
        if target in ROLES:
            found = next((name for name in box["folders"] if self._role(name) == target), None)
            if not found:
                raise MailError(404, f"Ce compte n'a pas de dossier « {ROLE_LABELS[target]} »")
            return found
        name = valid_folder(target)
        if name not in box["folders"]:
            raise MailError(404, f"Dossier introuvable : {name}")
        return name

    def move(self, body: dict) -> dict:
        box = self._box(self.store.get(body.get("account")))
        with self._guard:
            target = self._target_name(box, body.get("to"))
            messages, chosen = self._pick(box, body)
            if target != body.get("folder"):
                for message in chosen:
                    messages.remove(message)
                    message["uid"] = box["next"]
                    box["next"] += 1
                    box["folders"][target].append(message)
        return {"ok": True, "folder": target}

    def delete(self, body: dict) -> dict:
        box = self._box(self.store.get(body.get("account")))
        with self._guard:
            messages, chosen = self._pick(box, body)
            if body.get("folder") != "Corbeille":
                for message in chosen:
                    messages.remove(message)
                    message["uid"] = box["next"]
                    box["next"] += 1
                    box["folders"]["Corbeille"].append(message)
                return {"ok": True, "folder": "Corbeille"}
            for message in chosen:
                messages.remove(message)
        return {"ok": True, "folder": None}

    def send(self, body: dict) -> dict:
        account = self.store.get(body.get("account"))
        message = self.compose(account, body, self.clock())  # mêmes vérifications que pour un vrai envoi
        box = self._box(account)
        me = {"name": account.get("name") or "", "address": account["address"]}
        to, cc, bcc = valid_people(body, "to"), valid_people(body, "cc"), valid_people(body, "bcc")
        text = body.get("text") or ""
        with self._guard:
            self._store(box, "Envoyés", me, to, cc, message["Subject"], text, self.clock(), seen=True, message_id=message["Message-ID"], references=message.get("References", ""))
            if any(p["address"].lower() == account["address"].lower() for p in to + cc + bcc):
                self._store(box, "INBOX", me, to, cc, message["Subject"], text, self.clock(), seen=False, message_id=message["Message-ID"], references=message.get("References", ""))
        return {"ok": True, "messageId": message["Message-ID"], "refused": [], "savedTo": "Envoyés"}

    def receive(self, body: dict) -> dict:
        """Point d'accès de test : un message arrive dans Réception (le premier compte par défaut)."""
        accounts = self.store.all()
        if not accounts:
            raise MailError(404, "Aucun compte de messagerie")
        account = self.store.get(body["account"]) if body.get("account") else accounts[0]
        sender = {"name": text_field(body, "name", required=False, max_len=120), "address": valid_address(body.get("from") or "contact@exemple.fr")}
        subject = text_field(body, "subject", required=False, max_len=500) or "(Sans objet)"
        text = body.get("text") or ""
        if not isinstance(text, str) or len(text) > MAX_TEXT:
            raise MailError(400, "Texte invalide")
        box = self._box(account)
        with self._guard:
            stored = self._store(box, "INBOX", sender, [{"name": account.get("name") or "", "address": account["address"]}], [], subject, text, self.clock(), seen=False)
        return {"ok": True, "uid": stored["uid"]}
