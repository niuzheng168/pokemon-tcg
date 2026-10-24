from __future__ import annotations

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import ipaddress
import gzip
from pathlib import Path
import re
import socket
from urllib.parse import urlsplit

from .core import LABELS, SHA, encoded

ASSETS = Path(__file__).resolve().parent / "assets"
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")


def loopback_origin(value):
    try:
        u = urlsplit(value)
        return (u.scheme == "http" and u.hostname in LOOPBACK_HOSTS
                and u.username is None and u.password is None
                and u.port is not None and 0 < u.port <= 65535
                and value == "http://" + u.netloc)
    except ValueError:
        return False


class ReviewServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, allowed_hosts=(), forwarded_origins=(), ssh_forwarded=False):
        self.store = store
        self.ssh_forwarded = ssh_forwarded
        self.hosts = set(LOOPBACK_HOSTS)
        self.hosts.update(socket.gethostbyname_ex(socket.gethostname())[2])
        if address[0] != "0.0.0.0":
            self.hosts.add(address[0])
        for host in allowed_hosts:
            if not ipaddress.ip_address(host).is_private:
                raise ValueError("Only explicitly configured private LAN addresses are allowed.")
            self.hosts.add(host)
        self.forwarded_origins = set()
        for origin in forwarded_origins:
            u = urlsplit(origin)
            if (u.scheme != "http" or u.hostname not in self.hosts
                    or u.username is not None or u.password is not None
                    or u.port is None or u.port == 0
                    or origin != "http://" + u.netloc):
                raise ValueError("Forwarded origins must be exact HTTP origins with a trusted host and explicit port.")
            self.forwarded_origins.add(origin)
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # No arbitrary query strings or request bodies in logs.
        if args and isinstance(args[0], str) and "/thumb/" in args[0]:
            return
        print("Official image review:", self.command, urlsplit(self.path).path, flush=True)

    def send(self, code, body, content_type="application/json; charset=utf-8", *, immutable=False, attachment=None):
        if not isinstance(body, bytes):
            body = encoded(body)
        compressed = len(body) > 20_000 and content_type.startswith("application/json") and "gzip" in self.headers.get("Accept-Encoding", "")
        if compressed:
            body = gzip.compress(body, compresslevel=3)
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400, immutable" if immutable else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Referrer-Policy", "no-referrer")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        if attachment:
            self.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def allowed(self):
        host = self.headers.get("Host", "")
        via_ssh = (self.server.ssh_forwarded
                   and ipaddress.ip_address(self.client_address[0]).is_loopback)
        try:
            u = urlsplit("http://" + host)
            if (u.netloc != host or u.username is not None or u.password is not None
                    or u.hostname not in self.server.hosts):
                return False
            if (u.port != self.server.server_port
                    and "http://" + host not in self.server.forwarded_origins
                    and not (via_ssh and loopback_origin("http://" + host))):
                return False
        except ValueError:
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            return False
        origin = self.headers.get("Origin")
        # SSH proxies may preserve the external Host or rewrite it to the
        # backend. Trust only explicitly configured external origins, never
        # client-supplied Forwarded / X-Forwarded-* headers.
        if origin not in (None, "http://" + host) and origin not in self.server.forwarded_origins:
            # Some local proxies rewrite Host but preserve browser Origin.
            # Only loopback peers/hosts qualify, and browser-provided fetch
            # metadata must confirm this was SAME-ORIGIN before proxying.
            # Other localhost ports making cross-origin requests send
            # "same-site", not "same-origin", and remain rejected.
            if not (via_ssh and u.hostname in LOOPBACK_HOSTS
                    and u.port == self.server.server_port
                    and loopback_origin(origin)
                    and self.headers.get("Sec-Fetch-Site") == "same-origin"):
                return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            if not self.allowed():
                return self.send(403, {"error": "仅允许同源访问。"})
            path = urlsplit(self.path).path
            if path == "/api/catalog":
                return self.send(200, self.server.store.snapshot())
            if path == "/api/export":
                data = self.server.store.snapshot()
                return self.send(200, data, attachment="official-image-review.json")
            if path in ("/", "/app.js", "/style.css"):
                name, mime = {"/": ("index.html", "text/html; charset=utf-8"),
                              "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                              "/style.css": ("style.css", "text/css; charset=utf-8")}[path]
                return self.send(200, (ASSETS / name).read_bytes(), mime)
            match = re.fullmatch(r"/(thumb|image)/([a-f0-9]{64})(?:\.jpg)?", path)
            if match:
                kind, sha = match.groups()
                row = self.server.store.row(sha)
                if not row:
                    return self.send(404, {"error": "图片不存在。"})
                if kind == "thumb":
                    return self.send(200, self.server.store.thumb(sha).read_bytes(), "image/jpeg", immutable=True)
                original = self.server.store.original(row)
                if original.stat().st_size != row["bytes"]:
                    return self.send(409, {"error": "原始图片大小已改变。"})
                mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                        ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon"}.get(row["suffix"])
                return self.send(200, original.read_bytes(), mime or "application/octet-stream",
                                 attachment=sha + row["suffix"] if not mime else None)
            return self.send(404, {"error": "页面不存在。"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (OSError, ValueError, KeyError):
            return self.send(404, {"error": "文件暂不可用。"})

    def do_POST(self):
        try:
            if not self.allowed():
                return self.send(403, {"error": "拒绝跨站修改。"})
            if self.path != "/api/review":
                return self.send(404, {"error": "接口不存在。"})
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= 120_000:
                return self.send(413, {"error": "请求体超出范围。"})
            data = json.loads(self.rfile.read(length))
            ids, label = data.get("ids"), data.get("label")
            note = data.get("note", "")
            if (not isinstance(ids, list) or not 1 <= len(ids) <= 1000 or len(set(ids)) != len(ids)
                    or any(not isinstance(i, str) or not SHA.fullmatch(i) for i in ids)
                    or label not in (*LABELS, "reset") or not isinstance(note, str) or len(note) > 500):
                return self.send(400, {"error": "无效的审核内容。"})
            store = self.server.store
            with store.lock, store.db:
                revision = store.meta("review_revision", 0)
                if data.get("revision") != revision:
                    return self.send(409, {"error": "审核结果已更新，请刷新后重试。"})
                existing = {r["id"] for r in store.rows()}
                if not set(ids) <= existing:
                    return self.send(404, {"error": "存在未知图片，未保存任何更改。"})
                at = datetime.now(timezone.utc).isoformat()
                for sha in ids:
                    if label == "reset":
                        store.db.execute("DELETE FROM reviews WHERE id=?", (sha,))
                    else:
                        store.db.execute("INSERT OR REPLACE INTO reviews VALUES (?,?,?,?)", (sha, label, note, at))
                    store.db.execute("INSERT INTO events(id,label,note,at) VALUES (?,?,?,?)", (sha, label, note, at))
                # Keep the update in the same transaction as all review changes.
                store.db.execute("INSERT OR REPLACE INTO meta VALUES ('review_revision',?)", (json.dumps(revision + 1),))
            try:
                store.export()
                warning = None
            except (OSError, ValueError):
                warning = "审核已保存在本机；NAS 导出暂时失败，存储恢复后可重新导出。"
            return self.send(200, {"ok": True, "revision": revision + 1, "saved": len(ids), "warning": warning})
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.send(400, {"error": "无法解析审核内容。"})


def serve(store, host="127.0.0.1", port=8832, allowed_hosts=(), forwarded_origins=(), ssh_forwarded=False):
    if host not in ("127.0.0.1", "0.0.0.0") and not host.startswith(("192.168.", "10.")):
        raise ValueError("Use a loopback/private-network bind address.")
    with ReviewServer((host, port), store, allowed_hosts, forwarded_origins, ssh_forwarded) as server:
        print(f"Official image review: http://{host}:{server.server_port}/", flush=True)
        server.serve_forever()
