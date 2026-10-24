"""Accès à Internet pour les apps d'Orion (POST /api/net/request).

Les apps du Store tournent sans réseau : quand l'utilisateur leur accorde
l'autorisation « Internet », Orion fait leurs requêtes. Sur Orion installé,
c'est ce module qui s'en charge, sans les limites des navigateurs (CORS).

Protection contre les requêtes vers le réseau local (SSRF) : seules les
adresses IP publiques sont jointes. Le nom est résolu, chaque adresse
vérifiée, puis la connexion est ouverte sur l'adresse vérifiée elle-même
(« épinglée », pour qu'une seconde résolution ne puisse pas mener ailleurs),
y compris à chaque redirection. orion-server, la box, les imprimantes et les
autres machines du réseau restent hors de portée des apps.

Bibliothèque standard uniquement.
"""

from __future__ import annotations

import base64
import http.client
import ipaddress
import logging
import socket
import ssl
import urllib.parse
from typing import Any, Callable

LOG = logging.getLogger("orion-server")

MAX_REQUEST = 1024 * 1024  # corps envoyé (octets)
MAX_RESPONSE = 8 * 1024 * 1024  # corps reçu (octets)
TIMEOUT = 25.0
MAX_REDIRECTS = 5
METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
FORBIDDEN_HEADERS = frozenset(
    {"host", "cookie", "cookie2", "origin", "referer", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "expect", "accept-encoding", "x-orion"}
)
RESPONSE_HEADERS = ("content-type", "link", "location", "etag", "last-modified", "retry-after", "www-authenticate", "content-language", "x-ratelimit-remaining", "x-ratelimit-reset")
LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".lan")
USER_AGENT = "OrionOS/0.1 (orion-server)"


class NetError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def public_ip(address: str) -> bool:
    """Adresse joignable sur Internet : ni privée, ni locale, ni réservée, ni multidiffusion."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(info[4][0] for info in infos))


def check_url(raw: Any) -> urllib.parse.SplitResult:
    if not isinstance(raw, str) or len(raw) > 4096:
        raise NetError(400, "Adresse invalide")
    url = urllib.parse.urlsplit(raw.strip())
    if url.scheme not in ("http", "https") or not url.hostname:
        raise NetError(400, "Seules les adresses http et https sont autorisées")
    if url.username or url.password:
        raise NetError(400, "Identifiants dans l'adresse refusés")
    try:
        url.port  # noqa: B018 (valide le port)
    except ValueError:
        raise NetError(400, "Port invalide") from None
    host = url.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith(LOCAL_SUFFIXES):
        raise NetError(403, "Le réseau local et l'appareil lui-même sont inaccessibles aux apps")
    return url


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str, timeout: float):
        super().__init__(host, port, timeout=timeout)
        self._address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, address: str, timeout: float, context: ssl.SSLContext):
        super().__init__(host, port, timeout=timeout, context=context)
        self._address = address
        self._ctx = context

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        # Certificat vérifié pour le nom demandé (SNI), sur l'adresse déjà contrôlée.
        self.sock = self._ctx.wrap_socket(sock, server_hostname=self.host)


class NetProxy:
    """Fait les requêtes des apps. `resolver` et `public` sont remplaçables pour les tests."""

    def __init__(self, *, resolver: Callable[[str, int], list[str]] = system_resolver, public: Callable[[str], bool] = public_ip, timeout: float = TIMEOUT, context: ssl.SSLContext | None = None):
        self.resolver = resolver
        self.public = public
        self.timeout = timeout
        self.context = context or ssl.create_default_context()

    def _address(self, host: str, port: int) -> str:
        try:
            addresses = self.resolver(host, port)
        except (OSError, UnicodeError):
            raise NetError(502, f"Adresse introuvable : {host}") from None
        if not addresses:
            raise NetError(502, f"Adresse introuvable : {host}")
        if not all(self.public(a) for a in addresses):
            LOG.warning("Internet : requête vers une adresse locale refusée (%s)", host)
            raise NetError(403, "Le réseau local et l'appareil lui-même sont inaccessibles aux apps")
        return addresses[0]

    def request(self, body: dict) -> dict:
        url = check_url(body.get("url"))
        method = str(body.get("method") or "GET").upper()
        if method not in METHODS:
            raise NetError(400, "Méthode HTTP refusée")
        headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
        raw_headers = body.get("headers") or {}
        if not isinstance(raw_headers, dict):
            raise NetError(400, "En-têtes invalides")
        for name, value in list(raw_headers.items())[:50]:
            if not isinstance(name, str) or not name or len(name) > 64 or not all(c.isalnum() or c == "-" for c in name):
                continue
            if name.lower() in FORBIDDEN_HEADERS or name.lower().startswith(("proxy-", "sec-")):
                continue
            headers[name] = str(value).replace("\r", "").replace("\n", "")[:4096]
        payload = body.get("body")
        data: bytes | None = None
        if payload is not None and method not in ("GET", "HEAD"):
            if not isinstance(payload, str):
                raise NetError(400, "Corps de requête invalide")
            if body.get("bodyEncoding") == "base64":
                try:
                    data = base64.b64decode(payload, validate=True)
                except ValueError:
                    raise NetError(400, "Corps de requête invalide (base64)") from None
            else:
                data = payload.encode("utf-8")
            if len(data) > MAX_REQUEST:
                raise NetError(413, "Requête trop volumineuse (1 Mo au plus)")
        response_type = body.get("responseType") if body.get("responseType") in ("text", "json", "base64") else "text"

        for _ in range(MAX_REDIRECTS + 1):
            port = url.port or (443 if url.scheme == "https" else 80)
            address = self._address(url.hostname, port)
            path = urllib.parse.urlunsplit(("", "", url.path or "/", url.query, ""))
            host_header = url.hostname if url.port is None else f"{url.hostname}:{url.port}"
            conn: http.client.HTTPConnection = (
                _PinnedHTTPS(url.hostname, port, address, self.timeout, self.context) if url.scheme == "https" else _PinnedHTTP(url.hostname, port, address, self.timeout)
            )
            try:
                conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
                conn.putheader("Host", host_header)
                for name, value in headers.items():
                    conn.putheader(name, value)
                if data is not None:
                    conn.putheader("Content-Length", str(len(data)))
                conn.endheaders(data)
                response = conn.getresponse()
                location = response.getheader("Location")
                if response.status in (301, 302, 303, 307, 308) and location:
                    response.read(65536)
                    target = urllib.parse.urljoin(urllib.parse.urlunsplit(url), location)
                    url = check_url(target)
                    if response.status == 303 or (response.status in (301, 302) and method == "POST"):
                        method, data = "GET", None
                    continue
                content = response.read(MAX_RESPONSE + 1)
            except ssl.SSLCertVerificationError:
                raise NetError(502, f"Certificat invalide pour {url.hostname}") from None
            except (OSError, http.client.HTTPException) as error:
                raise NetError(504 if isinstance(error, TimeoutError | socket.timeout) else 502, f"{url.hostname} est injoignable") from None
            finally:
                conn.close()
            if len(content) > MAX_RESPONSE:
                raise NetError(502, "Réponse trop volumineuse (8 Mo au plus)")
            picked = {name: response.getheader(name) for name in RESPONSE_HEADERS if response.getheader(name) is not None}
            if response_type == "base64":
                text, encoding = base64.b64encode(content).decode("ascii"), "base64"
            else:
                charset = response.headers.get_content_charset() or "utf-8"
                try:
                    text = content.decode(charset, "replace")
                except LookupError:
                    text = content.decode("utf-8", "replace")
                encoding = "text"
            return {"ok": 200 <= response.status < 300, "status": response.status, "url": urllib.parse.urlunsplit(url), "headers": picked, "body": text, "encoding": encoding}
        raise NetError(502, "Trop de redirections")
