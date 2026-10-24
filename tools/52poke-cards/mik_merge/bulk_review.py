"""Read-only, loopback-only full-catalog review sidecar; never stages or judges.

Run with PYTHONPATH=tools/52poke-cards python -m mik_merge.bulk_review
build|serve --run-dir tools/52poke-cards/exports/RUN [--port 0].
Only catalog.json, run-inputs.json, optional summary/progress, catalog-selected
review.json files and checksum-verified PNG/WebP/JPEG originals can be read.
"""
from __future__ import annotations

import argparse
from collections import Counter, OrderedDict
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import threading
from urllib.parse import parse_qs, urlsplit

from . import common

ASSETS = Path(__file__).resolve().parent / "assets"
SCHEMA = "mik-52poke-bulk-catalog-v1"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*\Z")
SHA = re.compile(r"[a-fA-F0-9]{64}\Z")
STATUSES = ("ready", "needs_review", "blocked")
DETAIL_KEYS = (
    "mik_id", "status", "holds", "row", "result", "mik_metadata", "wiki_source", "wiki_display",
    "normalized_wiki_source", "normalized_wiki_display", "merged_candidate",
    "semantic_equivalence", "candidate_evidence", "field_diffs",
)
MAX_JSON = 48 * 1024 * 1024
MAX_IMAGE = 32 * 1024 * 1024
IMAGE_SUFFIXES = (".png", ".webp", ".jpg", ".jpeg")
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:; connect-src 'self'; font-src 'none'; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'; worker-src 'none'"
)


def _relative(value):
    common.require(isinstance(value, str) and value and "\\" not in value,
                   "Expected a run-relative path.")
    parts = value.split("/")
    common.require(all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", p) for p in parts),
                   "Unsafe run-relative path.")
    common.require(not PurePosixPath(value).is_absolute(), "Absolute paths are forbidden.")
    return parts


@contextmanager
def _directory(root, parts=(), *, create=False):
    """Descriptor-relative IO rejects symlinks, including intermediate folders."""
    root = common.output_root(root)
    descriptors = []
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        descriptors.append(os.open(root, flags))
        for part in parts:
            if create:
                try:
                    os.mkdir(part, dir_fd=descriptors[-1])
                except FileExistsError:
                    pass
            descriptors.append(os.open(part, flags, dir_fd=descriptors[-1]))
        yield descriptors[-1]
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


@contextmanager
def _file(root, relative):
    parts = _relative(relative)
    with _directory(root, parts[:-1]) as parent:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            common.require(stat.S_ISREG(os.fstat(fd).st_mode), "Not a regular file.")
            yield fd
        finally:
            os.close(fd)


def _stamp(fd):
    info = os.fstat(fd)
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _bytes(fd, limit=MAX_JSON):
    common.require(os.fstat(fd).st_size <= limit, "Review file is too large.")
    chunks, size = [], 0
    while block := os.read(fd, min(65536, limit + 1 - size)):
        chunks.append(block)
        size += len(block)
        common.require(size <= limit, "Review file is too large.")
    return b"".join(chunks)


def _read_json(root, relative, *, optional=False):
    try:
        with _file(root, relative) as fd:
            return json.loads(_bytes(fd))
    except FileNotFoundError:
        if optional:
            return None
        raise


def _atomic_bytes(root, relative, raw):
    parts = _relative(relative)
    with _directory(root, parts[:-1], create=True) as parent:
        # Exclusive temporary creation cannot follow a pre-planted symlink.
        temporary = f"{parts[-1]}.{os.getpid()}.{threading.get_ident()}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
            os.replace(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def build(run_dir):
    """Copy only tracked, data-free assets. No catalog or source scan is needed."""
    root = common.output_root(run_dir)
    root.mkdir(parents=True, exist_ok=True)
    common.output_root(root)
    for name, target in (
        ("bulk-review.html", "web/index.html"),
        ("bulk-review.css", "web/assets/bulk-review.css"),
        ("bulk-review.js", "web/assets/bulk-review.js"),
    ):
        _atomic_bytes(root, target, (ASSETS / name).read_bytes())
    return root / "web/index.html"


def _private_key(key):
    key = re.sub(r"([a-z])([A-Z])", r"\1_\2", str(key)).lower()
    if key in {
        "planned_requests", "completed_requests", "successful_requests", "failed_requests",
        "max_requests", "fresh_requests_this_run", "cached_requests", "request_count",
    }:
        return False
    compact = re.sub(r"[^a-z0-9]", "", key)
    return (
        any(term in compact for term in (
            "credential", "secret", "password", "apikey", "authorization",
            "cookie", "endpoint", "environment", "sourceresponse", "rawresponse",
            "request", "response", "headers",
        ))
        or compact in {
            "cloud", "headers", "token", "accesstoken", "refreshtoken",
            "request", "requests", "response", "responses", "messages", "choices",
            "env", "raw", "sourcefile", "sourcepath", "absolutepath",
        }
        or compact.endswith("file") and compact not in {"profile"}
    )


def _public(value, depth=0):
    """Project review evidence/statistics, not transport envelopes or credentials."""
    common.require(depth < 80, "Review structure is too deeply nested.")
    if isinstance(value, dict):
        return {key: _public(item, depth + 1) for key, item in value.items() if not _private_key(key)}
    if isinstance(value, list):
        return [_public(item, depth + 1) for item in value]
    return value


class Catalog:
    """One cached index, cheap filtered pages, lazy per-card JSON/image reads."""

    def __init__(self, root):
        self.root = common.output_root(root)
        self.lock = threading.RLock()
        self.version = None
        self.snapshot = None
        self.images = OrderedDict()

    def get(self):
        with self.lock, _file(self.root, "catalog.json") as catalog_fd, _file(
                self.root, "run-inputs.json") as inputs_fd:
            version = (_stamp(catalog_fd), _stamp(inputs_fd))
            if version == self.version:
                return self.snapshot
            catalog = json.loads(_bytes(catalog_fd))
            inputs = json.loads(_bytes(inputs_fd))
            common.require(isinstance(inputs, dict), "Invalid run input fingerprints.")
            common.require(isinstance(catalog, dict) and catalog.get("schema") == SCHEMA,
                           "Unknown bulk catalog schema.")
            common.require(isinstance(catalog.get("cards"), list), "Catalog cards must be a list.")
            supplied_fingerprint = catalog.get("fingerprint", catalog.get("dataset_fingerprint"))
            common.require(supplied_fingerprint is None or isinstance(supplied_fingerprint, str)
                           and SHA.fullmatch(supplied_fingerprint), "Invalid catalog fingerprint.")
            cards, lookup, searches, sets, reasons = [], {}, {}, Counter(), Counter()
            for entry in catalog["cards"]:
                common.require(isinstance(entry, dict), "Invalid catalog row.")
                identity = entry.get("mik_id")
                common.require(isinstance(identity, str) and ID.fullmatch(identity),
                               "Unsafe MIK printing identifier.")
                common.require(identity not in lookup, "Duplicate MIK printing identifier.")
                set_code, _ = identity.split("/")
                common.require(entry.get("set_code") == set_code, "Catalog set identity mismatch.")
                common.require(entry.get("status") in STATUSES, "Unknown catalog status.")
                common.require(isinstance(entry.get("name"), str), "Invalid card name.")
                wiki = entry.get("wiki_id")
                common.require(wiki is None or isinstance(wiki, str), "Invalid Wiki identity.")
                detail_file = entry.get("detail_file")
                detail_parts = _relative(detail_file)
                common.require(detail_parts[-3:] == [*identity.split("/"), "review.json"],
                               "Detail path must name this card's review.json.")
                image_file, image_sha = entry.get("image_file"), entry.get("image_sha256")
                if image_file is not None:
                    _relative(image_file)
                    common.require(image_file.lower().endswith(IMAGE_SUFFIXES) and isinstance(image_sha, str)
                                   and SHA.fullmatch(image_sha), "Invalid catalog image.")
                common.require(image_sha is None or isinstance(image_sha, str) and SHA.fullmatch(image_sha),
                               "Invalid image fingerprint.")
                merged_file = entry.get("merged_metadata_file")
                if merged_file is not None:
                    _relative(merged_file)
                holds = entry.get("holds", [])
                common.require(isinstance(holds, list) and all(
                    isinstance(h, dict) and isinstance(h.get("code"), str) and h["code"]
                    for h in holds), "Invalid catalog holds.")
                row = {key: _public(entry.get(key)) for key in (
                    "mik_id", "name", "set_code", "card_type", "status",
                    "association_status", "semantic_status", "wiki_id", "image_sha256",
                )}
                row.update(
                    holds=_public(holds),
                    image_url=f"/images/{identity}" if image_file is not None else None,
                    has_merged_candidate=merged_file is not None,
                )
                cards.append(row)
                lookup[identity] = (row, detail_file, image_file)
                searches[identity] = "\n".join(str(v or "") for v in (
                    identity, row["name"], wiki, row["card_type"],
                    row["association_status"], row["semantic_status"],
                    *[h["code"] for h in row["holds"]],
                )).casefold()
                sets[set_code] += 1
                reasons.update({h["code"] for h in holds})
            fingerprint = hashlib.sha256(json.dumps({
                "schema": SCHEMA, "inputs": inputs, "catalog_fingerprint": supplied_fingerprint,
                "cards": sorted((c["mik_id"], c["image_sha256"]) for c in cards),
            }, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            result = {
                "cards": cards, "lookup": lookup, "searches": searches,
                "fingerprint": fingerprint, "sets": sets, "reasons": reasons,
                "revision": hashlib.sha256(repr(version).encode()).hexdigest(),
                "catalog_fingerprint": supplied_fingerprint,
                "counts": dict(Counter(c["status"] for c in cards)),
                "candidate": sum(c["wiki_id"] is not None or c["has_merged_candidate"] for c in cards),
            }
            self.snapshot, self.version = result, version
            self.images.clear()
            return result

    def summary(self):
        data = self.get()
        final = _read_json(self.root, "summary.json", optional=True)
        return {
            "dataset_fingerprint": data["fingerprint"], "total": len(data["cards"]),
            "catalog_revision": data["revision"],
            "catalog_fingerprint": data["catalog_fingerprint"],
            "candidate": data["candidate"],
            **{status: data["counts"].get(status, 0) for status in STATUSES},
            "status_counts": {status: data["counts"].get(status, 0) for status in STATUSES},
            "sets": [{"set_code": key, "count": count} for key, count in sorted(data["sets"].items())],
            "reasons": [{"code": key, "count": count} for key, count in sorted(data["reasons"].items())],
            "summary": _public(final),
            "final": final is not None and (
                not isinstance(final, dict) or final.get("phase") not in ("staged", "staging", "judging")),
            "progress": _public(_read_json(self.root, "progress.json", optional=True)),
            "judge_progress": _public(_read_json(self.root, "judge-progress.json", optional=True)),
        }

    def page(self, query):
        allowed = {"page", "page_size", "q", "search", "status", "set", "set_code", "reason", "hold"}
        common.require(not set(query) - allowed, "Unknown cards query.")
        common.require(not ({"q", "search"} <= query.keys()
                            or {"set", "set_code"} <= query.keys()
                            or {"reason", "hold"} <= query.keys()), "Ambiguous cards query.")
        try:
            page, size = int(query.get("page", "1")), int(query.get("page_size", "50"))
        except ValueError:
            raise ValueError("Invalid page number.") from None
        common.require(1 <= page <= 1000000 and 1 <= size <= 200, "Invalid page bounds.")
        text = query.get("q", query.get("search", "")).strip().casefold()
        status = query.get("status", "")
        set_code = query.get("set", query.get("set_code", ""))
        reason = query.get("reason", query.get("hold", ""))
        common.require(status in ("", "all", *STATUSES), "Unknown status filter.")
        common.require(len(text) <= 256 and len(set_code) <= 128 and len(reason) <= 256,
                       "Filter is too long.")
        data = self.get()
        cards = [
            card for card in data["cards"]
            if (not text or text in data["searches"][card["mik_id"]])
            and (status in ("", "all") or card["status"] == status)
            and (not set_code or card["set_code"] == set_code)
            and (not reason or any(h["code"] == reason for h in card["holds"]))
        ]
        start = (page - 1) * size
        return {
            "dataset_fingerprint": data["fingerprint"], "cards": cards[start:start + size],
            "catalog_revision": data["revision"],
            "total": len(cards), "catalog_total": len(data["cards"]), "page": page,
            "page_size": size, "pages": math.ceil(len(cards) / size),
        }

    def detail(self, identity):
        data = self.get()
        if identity not in data["lookup"]:
            raise KeyError(identity)
        row, relative, _ = data["lookup"][identity]
        detail = _read_json(self.root, relative, optional=True)
        common.require(detail is None or isinstance(detail, dict), "Invalid detail document.")
        common.require(not detail or detail.get("mik_id", identity) == identity, "Detail identity mismatch.")
        for key in ("row", "result"):
            if detail and isinstance(detail.get(key), dict):
                common.require(detail[key].get("mik_id", identity) == identity,
                               "Detail identity mismatch.")
        return {
            "dataset_fingerprint": data["fingerprint"], "card": row,
            "catalog_revision": data["revision"],
            "detail_available": detail is not None,
            "detail": {key: _public(detail[key]) for key in DETAIL_KEYS if detail and key in detail},
        }

    def image(self, identity):
        data = self.get()
        if identity not in data["lookup"]:
            raise KeyError(identity)
        row, _, relative = data["lookup"][identity]
        if relative is None:
            raise KeyError(identity)
        with _file(self.root, relative) as fd:
            cache_key = identity, row["image_sha256"], _stamp(fd)
            with self.lock:
                if cache_key in self.images:
                    self.images.move_to_end(cache_key)
                    return self.images[cache_key]
            raw = _bytes(fd, MAX_IMAGE)
        common.require(hashlib.sha256(raw).hexdigest() == row["image_sha256"].lower(),
                       "Image checksum mismatch.")
        from PIL import Image
        try:
            with Image.open(io.BytesIO(raw)) as image:
                common.require(image.format in ("PNG", "WEBP", "JPEG") and image.width * image.height <= 32000000,
                               "Invalid image dimensions or format.")
                mime = {"PNG": "image/png", "WEBP": "image/webp", "JPEG": "image/jpeg"}[image.format]
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
        except (OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise ValueError("Invalid local image.") from error
        with self.lock:
            self.images[cache_key] = raw, mime
            while len(self.images) > 48 or sum(len(item[0]) for item in self.images.values()) > 48 * 1024 * 1024:
                self.images.popitem(last=False)
        return raw, mime


def make_server(run_dir, port=0):
    root = common.output_root(run_dir)
    catalog = Catalog(root)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            # Do not log user searches, source text or authorization headers.
            pass

        def respond(self, status, body=b"", content_type="application/json; charset=utf-8"):
            self.send_response(status)
            for key, value in {
                "Content-Type": content_type, "Content-Length": str(len(body)),
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer",
                "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin",
                "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
            }.items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def error(self, status, message):
            self.respond(status, json.dumps({"error": message}).encode())

        def do_GET(self):
            try:
                valid_hosts = {
                    f"127.0.0.1:{self.server.server_port}",
                    f"localhost:{self.server.server_port}",
                }
                host = self.headers.get("Host", "")
                if host not in valid_hosts or len(self.headers.get_all("Host", [])) != 1:
                    self.error(403, "Loopback Host required.")
                    return
                if self.headers.get("Origin") not in (None, f"http://{host}"):
                    self.error(403, "Cross-origin access is forbidden.")
                    return
                if self.headers.get("Sec-Fetch-Site") == "cross-site":
                    self.error(403, "Cross-site access is forbidden.")
                    return
                if self.headers.get("Authorization") or self.headers.get("Proxy-Authorization"):
                    self.error(403, "Credentials are not accepted.")
                    return
                if (not self.path.startswith("/") or self.path.startswith("//")
                        or "\\" in self.path or any(ord(c) < 32 for c in self.path)):
                    self.error(404, "No such route.")
                    return
                url = urlsplit(self.path)
                common.require(not url.fragment and len(url.query) <= 4096, "Invalid query.")
                parsed = parse_qs(url.query, keep_blank_values=True, max_num_fields=12)
                common.require(all(len(values) == 1 for values in parsed.values()), "Duplicate query.")
                query = {key: values[0] for key, values in parsed.items()}
                static = {
                    "/": ("web/index.html", "text/html; charset=utf-8"),
                    "/assets/bulk-review.js": ("web/assets/bulk-review.js", "text/javascript; charset=utf-8"),
                    "/assets/bulk-review.css": ("web/assets/bulk-review.css", "text/css; charset=utf-8"),
                }
                if url.path in static:
                    common.require(not query, "This route accepts no query.")
                    path, mime = static[url.path]
                    with _file(root, path) as fd:
                        raw = _bytes(fd, 2 * 1024 * 1024)
                    self.respond(200, raw, mime)
                    return
                if url.path == "/api/summary":
                    common.require(not query, "This route accepts no query.")
                    value = catalog.summary()
                elif url.path == "/api/cards":
                    value = catalog.page(query)
                elif url.path == "/api/card":
                    common.require(set(query) == {"mik_id"}, "Expected exactly one mik_id.")
                    value = catalog.detail(query["mik_id"])
                elif url.path.startswith("/images/") and ID.fullmatch(url.path[len("/images/"):]):
                    common.require(not query, "This route accepts no query.")
                    raw, mime = catalog.image(url.path[len("/images/"):])
                    self.respond(200, raw, mime)
                    return
                else:
                    self.error(404, "No such route.")
                    return
                self.respond(200, json.dumps(value, ensure_ascii=False, allow_nan=False).encode())
            except KeyError:
                self.error(404, "Card or image is not in the catalog.")
            except (OSError, ValueError, TypeError, RecursionError, OverflowError):
                # Deliberately no filesystem paths, source text or transport data.
                self.error(503 if urlsplit(self.path).path != "/api/cards" else 400,
                           "Review data unavailable or request invalid.")

        def do_HEAD(self):
            self.do_GET()

        def do_POST(self):
            self.error(405, "Read-only service.")

        do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_POST

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def serve(run_dir, port=0):
    root = common.output_root(run_dir)
    build(root)
    server = make_server(root, port)
    url = f"http://127.0.0.1:{server.server_port}/"
    try:
        _atomic_bytes(root, "web/preview-info.json", (
            json.dumps({"url": url, "local_only": True, "read_only": True}, indent=2) + "\n"
        ).encode())
        print("PREVIEW_URL=" + url, flush=True)
        server.serve_forever()
    finally:
        server.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "serve"))
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        common.require(0 <= args.port <= 65535, "Port must be between 0 and 65535.")
        if args.command == "build":
            print(build(args.run_dir))
        else:
            serve(args.run_dir, args.port)
    except (OSError, ValueError) as error:
        parser.exit(2, f"bulk review: {error}\n")


if __name__ == "__main__":
    main()
