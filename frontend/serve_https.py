#!/usr/bin/env python3
"""
Minimal HTTPS static server for the frontend.

- Serves the current directory (frontend/) over HTTPS.
- Uses provided cert/key files.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import ssl
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


AUTH_COOKIE_NAME = "livecaption_auth"
AUTH_TTL_SECONDS = 12 * 60 * 60


def _default_cert_paths() -> tuple[str, str]:
    # Common locations:
    # - local run: <repo>/ssl-config/{cert,key}.pem
    # - docker:    mounted at /ssl-config/{cert,key}.pem
    here = Path(__file__).resolve()
    repo_root = here.parent.parent
    local_cert = repo_root / "ssl-config" / "cert.pem"
    local_key = repo_root / "ssl-config" / "key.pem"
    docker_cert = Path("/ssl-config/cert.pem")
    docker_key = Path("/ssl-config/key.pem")

    cert = os.getenv("SSL_CERT_FILE") or (str(docker_cert) if docker_cert.exists() else str(local_cert))
    key = os.getenv("SSL_KEY_FILE") or (str(docker_key) if docker_key.exists() else str(local_key))
    return cert, key


class _TLSRequestHandler(SimpleHTTPRequestHandler):
    """
    Do TLS handshake in the per-request thread, not the main accept loop.

    This avoids the whole server getting stuck if a client connects but never
    completes the TLS handshake (common with scanners / half-open connections
    on public IPs).
    """

    def _auth_secret(self) -> bytes:
        secret = os.getenv("AUTH_SECRET")
        if not secret:
            # Deterministic fallback keeps local/dev runs usable. Production should
            # set AUTH_SECRET in frontend/.env so cookies survive container rebuilds.
            secret = "livecaption-dev-auth-secret"
        return secret.encode("utf-8")

    def _auth_keys_path(self) -> Path:
        configured = os.getenv("AUTH_KEYS_FILE")
        if configured:
            return Path(configured)
        return Path(__file__).resolve().parent / "auth_keys.json"

    def _load_auth_keys(self) -> dict[str, str]:
        path = self._auth_keys_path()
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)

        raw_keys = data.get("keys", data)
        keys: dict[str, str] = {}
        if isinstance(raw_keys, dict):
            for key, value in raw_keys.items():
                if isinstance(value, dict):
                    passkey = value.get("passkey")
                else:
                    passkey = value
                if isinstance(key, str) and isinstance(passkey, str):
                    keys[key] = passkey
        return keys

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 4096:
            return {}
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _b64encode(self, raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def _b64decode(self, raw: str) -> bytes:
        padding = "=" * (-len(raw) % 4)
        return base64.urlsafe_b64decode(raw + padding)

    def _sign(self, payload: str) -> str:
        digest = hmac.new(self._auth_secret(), payload.encode("ascii"), hashlib.sha256).digest()
        return self._b64encode(digest)

    def _make_cookie_value(self, key: str) -> str:
        payload = self._b64encode(
            json.dumps(
                {"key": key, "exp": int(time.time()) + AUTH_TTL_SECONDS},
                separators=(",", ":"),
            ).encode("utf-8")
        )
        return f"{payload}.{self._sign(payload)}"

    def _parse_cookies(self) -> dict[str, str]:
        cookies: dict[str, str] = {}
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            cookies[name.strip()] = value.strip()
        return cookies

    def _validate_cookie(self) -> str | None:
        value = self._parse_cookies().get(AUTH_COOKIE_NAME)
        if not value or "." not in value:
            return None
        payload, signature = value.rsplit(".", 1)
        if not hmac.compare_digest(signature, self._sign(payload)):
            return None
        try:
            data = json.loads(self._b64decode(payload).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        key = data.get("key")
        exp = data.get("exp")
        if not isinstance(key, str) or not isinstance(exp, int):
            return None
        if exp < int(time.time()):
            return None
        if key not in self._load_auth_keys():
            return None
        return key

    def _key_from_original_uri(self) -> str | None:
        original = self.headers.get("X-Original-URI", self.path)
        parsed = urlparse(original)
        path = parsed.path
        if path.startswith("/live/"):
            parts = path.split("/")
            return parts[2] if len(parts) > 2 and parts[2] else None
        if path.startswith("/subtitles/"):
            parts = path.split("/")
            return parts[2] if len(parts) > 2 and parts[2] else None
        if path == "/register":
            values = parse_qs(parsed.query).get("src")
            return values[0] if values else None
        return None

    def _serve_login_page(self) -> None:
        self.path = "/login.html"
        return super().do_GET()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/" and not parse_qs(parsed.query).get("src"):
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/login")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

        if parsed.path == "/login":
            self._serve_login_page()
            return

        if parsed.path == "/auth/keys":
            try:
                keys = sorted(self._load_auth_keys().keys())
            except OSError:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "auth keys unavailable"})
                return
            self._send_json(HTTPStatus.OK, {"keys": keys})
            return

        if parsed.path == "/auth/verify":
            cookie_key = self._validate_cookie()
            requested_key = self._key_from_original_uri()
            if cookie_key and requested_key and hmac.compare_digest(cookie_key, requested_key):
                self.send_response(HTTPStatus.NO_CONTENT)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/auth/login":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        payload = self._read_json_body()
        key = str(payload.get("key", "")).strip()
        passkey = str(payload.get("passkey", "")).strip()
        try:
            auth_keys = self._load_auth_keys()
        except OSError:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "auth keys unavailable"})
            return

        expected = auth_keys.get(key)
        if not expected or not hmac.compare_digest(passkey, expected):
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "invalid key or passkey"})
            return

        cookie = self._make_cookie_value(key)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Set-Cookie",
            f"{AUTH_COOKIE_NAME}={cookie}; Max-Age={AUTH_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax",
        )
        body = json.dumps({"ok": True, "redirect": f"/?src={key}"}).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def setup(self) -> None:
        # StreamRequestHandler.setup(), inlined so we can handshake first.
        self.connection = self.request  # type: ignore[assignment]

        # Handshake can block forever on a bad client; bound it.
        timeout = getattr(self.server, "tls_handshake_timeout", 5.0)  # type: ignore[attr-defined]
        if isinstance(self.connection, ssl.SSLSocket):
            self.connection.settimeout(timeout)
            try:
                self.connection.do_handshake()
            finally:
                # After handshake, allow normal blocking IO for serving files.
                self.connection.settimeout(None)

        self.rfile = self.connection.makefile("rb", self.rbufsize)
        self.wfile = self.connection.makefile("wb", self.wbufsize)


class _TLSHTTPServer(ThreadingHTTPServer):
    # If a client stalls, don't keep the process alive at shutdown.
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        RequestHandlerClass: type[SimpleHTTPRequestHandler],
        ssl_context: ssl.SSLContext,
        tls_handshake_timeout: float,
    ) -> None:
        super().__init__(server_address, RequestHandlerClass)
        self.ssl_context = ssl_context
        self.tls_handshake_timeout = tls_handshake_timeout

    def get_request(self) -> tuple[Any, tuple[str, int]]:
        sock, addr = super().get_request()
        # Wrap without handshaking; handshake happens in the handler thread.
        tls_sock = self.ssl_context.wrap_socket(
            sock,
            server_side=True,
            do_handshake_on_connect=False,
        )
        return tls_sock, addr


def main() -> None:
    cert_default, key_default = _default_cert_paths()

    p = argparse.ArgumentParser(description="Serve static frontend over HTTPS")
    p.add_argument("--bind", default=os.getenv("FRONTEND_HOST", "0.0.0.0"))
    p.add_argument("--port", type=int, default=int(os.getenv("FRONTEND_PORT", "8088")))
    p.add_argument("--cert", default=cert_default)
    p.add_argument("--key", default=key_default)
    p.add_argument(
        "--tls-handshake-timeout",
        type=float,
        default=float(os.getenv("TLS_HANDSHAKE_TIMEOUT_SECONDS", "5")),
        help="Timeout (seconds) for TLS handshake per connection.",
    )
    args = p.parse_args()

    cert_path = Path(args.cert)
    key_path = Path(args.key)
    if not cert_path.exists():
        raise SystemExit(f"[frontend https] cert not found: {cert_path}")
    if not key_path.exists():
        raise SystemExit(f"[frontend https] key not found: {key_path}")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    httpd = _TLSHTTPServer(
        (args.bind, args.port),
        _TLSRequestHandler,
        ssl_context=ctx,
        tls_handshake_timeout=args.tls_handshake_timeout,
    )

    print(
        f"[frontend https] serving on https://{args.bind}:{args.port} "
        f"(cert={cert_path}, tls_handshake_timeout={args.tls_handshake_timeout}s)",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
