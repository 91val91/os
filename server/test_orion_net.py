"""Tests de l'accès à Internet des apps (orion_net.py) : requêtes, redirections,
limites, et surtout le refus du réseau local, contre un petit serveur HTTP local
(joint sous un nom « public » imité, ou refusé comme adresse locale)."""

from __future__ import annotations

import base64
import http.server
import json
import threading
import unittest

import orion_net as on
import orion_server as osv
from orion_net import NetError, NetProxy


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body=b"", headers=None):
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        port = self.server.server_address[1]
        if self.path == "/json":
            self._send(200, json.dumps({"bonjour": "le monde"}).encode(), {"Content-Type": "application/json; charset=utf-8", "Link": '<https://api.exemple.test/json?page=2>; rel="next"', "Set-Cookie": "piste=1"})
        elif self.path == "/headers":
            self._send(200, json.dumps({k.lower(): v for k, v in self.headers.items()}).encode(), {"Content-Type": "application/json"})
        elif self.path == "/redirect":
            self._send(302, headers={"Location": "/json"})
        elif self.path == "/redirect-local":
            self._send(302, headers={"Location": f"http://interne.test:{port}/json"})
        elif self.path == "/bin":
            self._send(200, bytes(range(256)), {"Content-Type": "application/octet-stream"})
        elif self.path == "/big":
            self._send(200, b"x" * (on.MAX_RESPONSE + 10), {"Content-Type": "text/plain"})
        elif self.path == "/latin1":
            self._send(200, "café".encode("latin-1"), {"Content-Type": "text/plain; charset=iso-8859-1"})
        else:
            self._send(404, b"introuvable")

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/see-other":
            self._send(303, headers={"Location": "/json"})
            return
        self._send(201, json.dumps({"method": "POST", "body": data.decode("utf-8", "replace"), "type": self.headers.get("Content-Type")}).encode(), {"Content-Type": "application/json"})

    do_PUT = do_POST


class NetProxyTest(unittest.TestCase):
    def setUp(self):
        self.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.http.server_address[1]
        threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        # « api.exemple.test » : un site d'Internet imité (servi en local) ; « interne.test » : une machine du réseau local.
        names = {"api.exemple.test": "93.184.215.14", "interne.test": "192.168.1.20"}
        self.proxy = NetProxy(resolver=lambda host, port: [names.get(host, "151.101.1.140")], public=on.public_ip, timeout=5)
        real_address = self.proxy._address

        def address(host, port):
            real_address(host, port)  # vérification de l'adresse résolue (publique ou non)…
            return "127.0.0.1"  # …puis connexion au serveur de test

        self.proxy._address = address

    def url(self, path, host="api.exemple.test"):
        return f"http://{host}:{self.port}{path}"

    def test_public_and_local_addresses(self):
        for address in ["127.0.0.1", "10.0.0.8", "172.20.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1", "pas-une-ip"]:
            self.assertFalse(on.public_ip(address), address)
        for address in ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]:
            self.assertTrue(on.public_ip(address), address)

    def test_urls_refused(self):
        for url in ["ftp://exemple.fr/", "http://moi:secret@exemple.fr/", "http://localhost:8080/api/mail", "http://imprimante.local/", "https://box.lan/", "http://exemple.fr:99999/", "file:///etc/passwd", 42]:
            with self.assertRaises(NetError, msg=url):
                on.check_url(url)

    def test_get_json_text_and_headers(self):
        result = self.proxy.request({"url": self.url("/json")})
        self.assertEqual(result["status"], 200)
        self.assertTrue(result["ok"])
        self.assertEqual(json.loads(result["body"]), {"bonjour": "le monde"})
        self.assertIn('rel="next"', result["headers"]["link"])
        self.assertNotIn("set-cookie", result["headers"])  # pas de cookie pour les apps
        self.assertEqual(self.proxy.request({"url": self.url("/latin1")})["body"], "café")

    def test_headers_forwarded_and_filtered(self):
        result = self.proxy.request({"url": self.url("/headers"), "headers": {"Authorization": "Bearer abc", "Cookie": "vol=1", "Host": "ailleurs", "X-Orion": "1", "Proxy-Authorization": "x", "Bad Header": "x", "Accept": "application/json\r\nX-Injecte: 1"}})
        seen = json.loads(result["body"])
        self.assertEqual(seen["authorization"], "Bearer abc")
        self.assertEqual(seen["host"], f"api.exemple.test:{self.port}")
        self.assertEqual(seen["accept"], "application/jsonX-Injecte: 1")
        for name in ("cookie", "x-orion", "proxy-authorization", "x-injecte"):
            self.assertNotIn(name, seen)
        self.assertTrue(seen["user-agent"].startswith("OrionOS/"))

    def test_post_body_text_and_base64(self):
        result = self.proxy.request({"url": self.url("/echo"), "method": "POST", "headers": {"Content-Type": "application/json"}, "body": '{"a":1}'})
        self.assertEqual(result["status"], 201)
        self.assertEqual(json.loads(result["body"]), {"method": "POST", "body": '{"a":1}', "type": "application/json"})
        raw = base64.b64encode("é".encode()).decode()
        self.assertEqual(json.loads(self.proxy.request({"url": self.url("/echo"), "method": "PUT", "body": raw, "bodyEncoding": "base64"})["body"])["body"], "é")
        with self.assertRaises(NetError) as caught:
            self.proxy.request({"url": self.url("/echo"), "method": "POST", "body": "x" * (on.MAX_REQUEST + 1)})
        self.assertEqual(caught.exception.status, 413)
        with self.assertRaises(NetError):
            self.proxy.request({"url": self.url("/echo"), "method": "CONNECT"})

    def test_binary_response_and_size_limit(self):
        result = self.proxy.request({"url": self.url("/bin"), "responseType": "base64"})
        self.assertEqual(base64.b64decode(result["body"]), bytes(range(256)))
        self.assertEqual(result["encoding"], "base64")
        with self.assertRaises(NetError) as caught:
            self.proxy.request({"url": self.url("/big")})
        self.assertIn("volumineuse", caught.exception.message)

    def test_redirects_are_followed_and_checked_again(self):
        result = self.proxy.request({"url": self.url("/redirect")})
        self.assertEqual(result["status"], 200)
        self.assertTrue(result["url"].endswith("/json"))
        self.assertEqual(self.proxy.request({"url": self.url("/see-other"), "method": "POST", "body": "x"})["status"], 200)
        # Une redirection vers une machine du réseau local est refusée.
        with self.assertRaises(NetError) as caught:
            self.proxy.request({"url": self.url("/redirect-local")})
        self.assertEqual(caught.exception.status, 403)

    def test_local_network_is_refused(self):
        with self.assertRaises(NetError) as caught:
            self.proxy.request({"url": self.url("/json", host="interne.test")})
        self.assertEqual(caught.exception.status, 403)
        # Sans l'imitation : le serveur de test lui-même (127.0.0.1) est hors de portée.
        with self.assertRaises(NetError) as caught:
            NetProxy(timeout=2).request({"url": f"http://127.0.0.1:{self.port}/json"})
        self.assertEqual(caught.exception.status, 403)

    def test_unreachable(self):
        proxy = NetProxy(resolver=lambda host, port: [], timeout=2)
        with self.assertRaises(NetError) as caught:
            proxy.request({"url": "https://nulle-part.exemple/"})
        self.assertEqual(caught.exception.status, 502)


class NetApiTest(unittest.TestCase):
    """POST /api/net/request : en-tête X-Orion exigé, erreurs relayées, capacité annoncée."""

    def setUp(self):
        import tempfile
        from pathlib import Path

        self.tmp = Path(tempfile.mkdtemp(prefix="orion-net-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        (self.tmp / "index.html").write_text("<!doctype html>")
        self.server = osv.make_server(self.tmp, "127.0.0.1", 0, osv.SimulatedHardware(delay_scale=0, seed=1), net=NetProxy(timeout=2))
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, body, orion=True):
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            headers = {"Content-Type": "application/json", **({"X-Orion": "1"} if orion else {})}
            conn.request("POST", "/api/net/request", json.dumps(body), headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read() or b"{}")
        finally:
            conn.close()

    def test_api(self):
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/api/status")
        caps = json.loads(conn.getresponse().read())["capabilities"]
        conn.close()
        self.assertTrue(caps["net"])
        self.assertEqual(self.post({"url": "http://127.0.0.1:1/"}, orion=False)[0], 403)
        status, data = self.post({"url": f"http://127.0.0.1:{self.port}/api/status"})
        self.assertEqual(status, 403)
        self.assertIn("réseau local", data["error"])
        self.assertEqual(self.post({"url": "ftp://exemple.fr/"})[0], 400)
        # Corps jusqu'à 1 Mo (en base64 dans le JSON) accepté jusqu'au module, refusé au-delà.
        status, data = self.post({"url": "http://localhost/", "method": "POST", "body": base64.b64encode(b"x" * 600_000).decode(), "bodyEncoding": "base64"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
