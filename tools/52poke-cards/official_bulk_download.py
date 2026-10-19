"""Archive the UNION of declared official sources and every product-category page.

Raw image collection only: no card-shape filter, OCR, identity assignment or library
writes. State is separate from the frozen manifest/old queue, but the source access
block and exclusive writer lock are shared. Published signatures are never guessed.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from concurrent.futures import CancelledError, FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
import uuid
import xml.etree.ElementTree as ET

from card_storage import atomic_json, copy_verified, digest
from official_downloader import (
    CAMPAIGN, CAMPAIGN_SCRIPT, REDIRECTS, USER_AGENT, canonical, gallery_urls,
    official_url, source_pages,
)
from portable_downloader import load_manifest, output_lock

ROOT = Path(__file__).resolve().parent
CATEGORY = "https://www.pokemon.cn/category/tcg/product"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico", ".tif", ".tiff"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
BAD = {401, 403, 429}
DONE = {"done", "reused", "missing"}


def image_key(url):
    """Keep content-transform queries; only strip the published auth_key token."""
    p = urlsplit(official_url(url))
    query = urlencode([(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k != "auth_key"])
    return urlunsplit((p.scheme, p.netloc, p.path, query, ""))


def category_number(url):
    p = urlsplit(url)
    if p.hostname != "www.pokemon.cn":
        return None
    match = re.fullmatch(r"/category/tcg/product(?:/(?:p|page)/([1-9]\d*))?/?", p.path)
    if not match:
        return None
    query = dict(parse_qsl(p.query))
    return int(match[1] or query.get("paged", 1))


def document_key(url):
    number = category_number(url)
    if number:
        return CATEGORY if number == 1 else CATEGORY + f"/p/{number}"
    return canonical(url)


class Page(HTMLParser):
    """Collect published image references, not just card-shaped article scans."""
    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.images, self.styles, self.pagination, self.articles = set(), set(), set(), set()
        self.external = set()
        self.stack, self.text, self.title, self.canonical_urls = [], [], [], []

    def resource(self, value, kind="image", require_suffix=False):
        if not value:
            return
        value = value.strip()
        if value.startswith("data:image/") and kind == "image":
            self.images.add(value)
            return
        if value.startswith(("#", "data:", "javascript:")):
            return
        candidate = urljoin(self.url, value)
        try:
            candidate = official_url(candidate)
        except ValueError:
            if urlsplit(candidate).scheme in {"http", "https"}:
                self.external.add(candidate.split("?", 1)[0])
            return
        if require_suffix and Path(urlsplit(candidate).path).suffix.lower() not in IMAGE_SUFFIXES:
            return
        (self.styles if kind == "style" else self.images).add(candidate)

    def css(self, text):
        for match in re.finditer(r"url\(\s*(['\"]?)(.*?)\1\s*\)", text, re.S):
            self.resource(match[2], require_suffix=True)
        for match in re.finditer(r"@import\s+['\"]([^'\"]+)['\"]", text):
            self.resource(match[1], "style")

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        main = tag == "main" or any(t == "main" for t in self.stack)
        if tag == "a" and a.get("href"):
            url = urljoin(self.url, a["href"])
            try:
                url = official_url(url)
            except ValueError:
                url = None
            if url:
                if category_number(url):
                    self.pagination.add(url)
                elif main and urlsplit(url).hostname == "www.pokemon.cn" and re.fullmatch(
                    r"/tcg/(?:product/)?[^/]+\.html", urlsplit(url).path
                ):
                    self.articles.add(url)
                self.resource(url, require_suffix=True)
        if tag in {"img", "source", "image", "input"}:
            if tag != "input" or a.get("type") == "image":
                for key in ("src", "data-src", "data-original", "data-lazy-src", "data-lazy", "href", "xlink:href", "data-echo"):
                    self.resource(a.get(key))
                for key in ("srcset", "data-srcset", "data-lazy-srcset"):
                    for part in a.get(key, "").split(","):
                        if part.strip():
                            self.resource(part.strip().split()[0])
        if tag == "video":
            self.resource(a.get("poster"))
        if tag == "link":
            rel = a.get("rel", "").split()
            if "stylesheet" in rel:
                self.resource(a.get("href"), "style")
            elif any(r in rel for r in ("icon", "apple-touch-icon", "image_src")) or a.get("as") == "image":
                self.resource(a.get("href"))
            elif "canonical" in rel and a.get("href"):
                try:
                    self.canonical_urls.append(canonical(urljoin(self.url, a["href"])))
                except ValueError:
                    pass
        if tag == "meta" and a.get("property") == "og:image":
            self.resource(a.get("content"))
        if tag == "meta" and a.get("property") == "og:url":
            try:
                self.canonical_urls.append(canonical(a.get("content")))
            except ValueError:
                pass
        self.css(a.get("style", ""))
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in self.stack:
            self.stack = self.stack[:len(self.stack) - 1 - self.stack[::-1].index(tag)]

    def handle_data(self, data):
        self.text.append(data)
        if "title" in self.stack:
            self.title.append(data)
        if "style" in self.stack:
            self.css(data)

    @property
    def numbering(self):
        match = re.search(r"Page\s*(\d+)\s*/\s*(\d+)", " ".join(self.text), re.I)
        return (int(match[1]), int(match[2])) if match else None


class Stopped(RuntimeError):
    pass


class HostUnavailable(RuntimeError):
    """Transport circuit opened; unrelated official hosts may still be usable."""


class Network:
    """Bounded adaptive concurrency; durable shared 401/403/429 stop; no proxies."""
    def __init__(self, policy_output, scratch, *, workers=32, max_rps=4, transport=None):
        self.path = policy_output / "official-network.json"
        self.scratch, self.workers, self.max_rps = scratch, workers, max_rps
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.active, self.successes, self.request_count = 0, 0, 0
        self.next_start, self.semaphores, self.transport_failures = {}, {}, {}
        self.transport = transport or self.curl
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {"source": "official", "last_finished": 0}
        if self.state.get("source") != "official":
            raise ValueError("Wrong shared network source.")
        if self.state.get("access_block"):
            raise Stopped("Existing official access block retained; no new requests.")
        # An old queue remains untouched. The global source block is never reset.
        self.state.update(in_flight=False, bulk_in_flight=0)
        self.state.setdefault("transport_pauses", {})
        atomic_json(self.path, self.state)

    def check_host(self, url):
        host = urlsplit(url).hostname
        with self.lock:
            if host in self.state["transport_pauses"]:
                raise HostUnavailable(f"{host}: transport paused after repeated connection failures")

    def transport_failed(self, url, error):
        host = urlsplit(url).hostname
        with self.lock:
            count = self.transport_failures.get(host, 0) + 1
            self.transport_failures[host] = count
            if count >= 3:
                self.state["transport_pauses"][host] = {
                    "reason": type(error).__name__ + ":" + str(error)[:100], "at": time.time(),
                }
                atomic_json(self.path, self.state)

    def block(self, code, url):
        with self.lock:
            self.state["access_block"] = {"reason": f"HTTP {code}", "url": canonical(url), "at": time.time()}
            self.stop.set()
            atomic_json(self.path, self.state)

    def gate(self, url):
        self.check_host(url)
        host = urlsplit(url).hostname
        with self.lock:
            semaphore = self.semaphores.setdefault(host, threading.Semaphore(
                4 if host in {"www.pokemon.cn", "special.pokemon.cn"} else self.workers
            ))
        while not semaphore.acquire(timeout=.2):
            if self.stop.is_set():
                raise Stopped("Stopped before request.")
            self.check_host(url)
        try:
            while True:
                if self.stop.is_set():
                    raise Stopped("Stopped before request.")
                self.check_host(url)
                with self.lock:
                    rate = min(self.max_rps, 1 if self.successes < 20 else 2 if self.successes < 60 else self.max_rps)
                    now = time.monotonic()
                    due = self.next_start.get(host, now)
                    if now >= due:
                        self.next_start[host] = now + 1 / rate
                        self.active += 1
                        self.request_count += 1
                        self.state.update(in_flight=True, bulk_in_flight=self.active)
                        atomic_json(self.path, self.state)
                        return semaphore
                self.stop.wait(min(.2, max(0, due - now)))
        except BaseException:
            semaphore.release()
            raise

    def curl(self, url, kind):
        token = uuid.uuid4().hex
        path, headers = self.scratch / (token + ".part"), self.scratch / (token + ".headers")
        maximum = 128_000_000 if kind == "image" else 5_000_000
        command = [
            "curl", "--silent", "--show-error", "--noproxy", "*", "--proto", "=https",
            "--connect-timeout", "10", "--max-time", "60", "--speed-time", "25", "--speed-limit", "1024",
            "--max-filesize", str(maximum), "--user-agent", USER_AGENT, "--header", "Accept-Encoding: identity",
            "--dump-header", str(headers), "--output", str(path), "--write-out", "%{http_code}\\n%{content_type}", url,
        ]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            while True:
                try:
                    stdout, stderr = process.communicate(timeout=.25)
                    break
                except subprocess.TimeoutExpired:
                    try:
                        self.check_host(url)
                        cancelled = self.stop.is_set()
                    except HostUnavailable:
                        cancelled = True
                    if cancelled:
                        process.terminate()
                        try:
                            process.communicate(timeout=3)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.communicate()
                        self.check_host(url)
                        raise Stopped("Cancelled in-flight request after stop.")
            lines = stdout.decode(errors="replace").splitlines()
            code = int(lines[0]) if lines and lines[0].isdigit() else 0
            mime = lines[1].split(";", 1)[0].lower() if len(lines) > 1 else ""
            fields = {}
            if headers.exists():
                for line in headers.read_text(errors="replace").splitlines():
                    if ":" in line:
                        key, value = line.split(":", 1)
                        fields[key.lower()] = value.strip()
            if code in BAD:
                self.block(code, url)
                raise Stopped(f"HTTP {code}; source access block persisted.")
            if process.returncode and code not in REDIRECTS:
                # Do not retain stderr, which may contain the signed URL.
                detail = "_connection_timeout" if b"Connection timeout" in stderr else ""
                raise OSError(f"curl_exit_{process.returncode}{detail}")
            if path.exists() and path.stat().st_size > maximum:
                raise ValueError("Response exceeds archive size limit.")
            return {"code": code, "mime": mime, "headers": fields, "path": path}
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        finally:
            headers.unlink(missing_ok=True)

    def fetch(self, url, kind):
        for _ in range(6):
            url = official_url(url)
            semaphore = self.gate(url)
            try:
                try:
                    result = self.transport(url, kind)
                except OSError as error:
                    self.transport_failed(url, error)
                    raise
                if result["code"] in BAD:
                    self.block(result["code"], url)
                    result["path"].unlink(missing_ok=True)
                    raise Stopped("HTTP access restriction persisted.")
                if result["code"] in REDIRECTS:
                    result["path"].unlink(missing_ok=True)
                    location = result["headers"].get("location")
                    if not location:
                        raise ValueError("Missing redirect location.")
                    url = official_url(urljoin(url, location))
                    continue
                result["url"] = url
                with self.lock:
                    self.transport_failures[urlsplit(url).hostname] = 0
                if result["code"] == 200:
                    with self.lock:
                        self.successes += 1
                return result
            finally:
                with self.lock:
                    self.active -= 1
                    self.state.update(in_flight=bool(self.active), bulk_in_flight=self.active, last_finished=time.time())
                    atomic_json(self.path, self.state)
                semaphore.release()
        raise ValueError("Too many redirects.")


def validate_image(path):
    from PIL import Image
    h1, h256 = hashlib.sha1(), hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            h1.update(chunk); h256.update(chunk); size += len(chunk)
    if not 0 < size <= 128_000_000:
        raise ValueError("Image byte size outside archive bounds.")
    with path.open("rb") as stream:
        head = stream.read(512).lstrip()
    if head.startswith((b"<?xml", b"<svg", b"<!--", b"<!DOCTYPE svg")):
        try:
            xml = ET.parse(path).getroot()
        except ET.ParseError as error:
            raise ValueError("Malformed SVG image.") from error
        if xml.tag.rsplit("}", 1)[-1] != "svg":
            raise ValueError("Not an SVG image.")
        width, height, suffix = xml.attrib.get("width"), xml.attrib.get("height"), ".svg"
    else:
        with Image.open(path) as image:
            width, height, fmt = image.width, image.height, image.format
            if width * height > 100_000_000:
                raise ValueError("Image exceeds 100M decoded pixels; retain error for review.")
            image.verify()
        with Image.open(path) as image:
            image.load()
        suffix = {"PNG": ".png", "JPEG": ".jpg", "GIF": ".gif", "WEBP": ".webp", "AVIF": ".avif",
                  "BMP": ".bmp", "ICO": ".ico", "TIFF": ".tiff"}.get(fmt)
        if not suffix:
            raise ValueError("Unsupported image format.")
    return {"sha1": h1.hexdigest(), "sha256": h256.hexdigest(), "bytes": size,
            "width": width, "height": height, "suffix": suffix}


class Archive:
    def __init__(self, output, manifest, *, collection=None):
        self.output, self.manifest, self.collection = output, manifest, collection
        output.mkdir(parents=True, exist_ok=True)
        output.chmod(0o700)
        for name in ("images", "documents", "scratch"):
            (output / name).mkdir(exist_ok=True)
        self.db = sqlite3.connect(output / "archive.sqlite")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS jobs(
              key TEXT PRIMARY KEY,kind TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,origins TEXT NOT NULL DEFAULT '[]',result TEXT,error TEXT,
              http_status INTEGER,available_at REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS local_images(key TEXT PRIMARY KEY,source TEXT NOT NULL,sha256 TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS category_pages(number INTEGER PRIMARY KEY,total INTEGER NOT NULL,
              url TEXT NOT NULL,articles TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS exclusions(url TEXT PRIMARY KEY,reason TEXT NOT NULL);
        """)
        self.manifest_hash = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        old = self.meta("original_manifest_sha256")
        if old and old != self.manifest_hash:
            raise ValueError("Original source manifest changed; do not reset this archive.")
        self.set_meta("original_manifest_sha256", self.manifest_hash)

    def recover(self):
        """Only the locked run command may recover interrupted work, never status."""
        self.db.execute("UPDATE jobs SET status='pending',error='Interrupted previous attempt' WHERE status='downloading' AND attempts<3")
        self.db.execute("UPDATE jobs SET status='error',error='Interrupted final attempt' WHERE status='downloading' AND attempts>=3")
        self.db.commit()

    def meta(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def set_meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))
        self.db.commit()

    def add(self, url, kind, origin):
        if url.startswith("data:image/") and kind == "image":
            key = "inline:" + hashlib.sha256(url.encode()).hexdigest()
        else:
            url = official_url(url)
            key = kind + ":" + (image_key(url) if kind == "image" else document_key(url))
        old = self.db.execute("SELECT origins,status FROM jobs WHERE key=?", (key,)).fetchone()
        origins = set(json.loads(old[0])) if old else set()
        origins.add(origin)
        self.db.execute(
            """INSERT INTO jobs(key,kind,url,origins) VALUES (?,?,?,?)
               ON CONFLICT(key) DO UPDATE SET origins=excluded.origins,
               url=CASE WHEN jobs.status IN ('pending','error') THEN excluded.url ELSE jobs.url END""",
            (key, kind, url, json.dumps(sorted(origins), ensure_ascii=False)),
        )
        self.db.commit()
        return key

    def seed(self, source_list=None):
        pages = source_pages(self.manifest)
        for key, url in pages.items():
            self.add(url, "image" if Path(urlsplit(key).path).suffix.lower() in IMAGE_SUFFIXES else "page", "original_manifest")
        if source_list is not None:
            if (source_list.get("schema_version") != 1
                    or source_list.get("merge_operation") != "union_not_replacement"
                    or source_list.get("original_manifest_struct_sha256") != self.manifest_hash):
                raise ValueError("Source list does not match the original manifest.")
            for page in source_list["pages"]:
                self.add(page["url"], "page", "committed_union_source_list")
        self.add(CATEGORY, "category", "requested_product_category")
        self.set_meta("original_source_pages", len(pages))

    def register_local(self, document, blobs, parent_key=None):
        if isinstance(document, dict):
            checksum = document.get("sha256")
            if isinstance(checksum, str) and checksum in blobs:
                for field in ("source_url", "url", "image_url", "official_image_url"):
                    url = document.get(field)
                    if not isinstance(url, str) or Path(urlsplit(url).path).suffix.lower() not in IMAGE_SUFFIXES:
                        continue
                    try:
                        key = image_key(url)
                    except ValueError:
                        continue
                    self.db.execute("INSERT OR IGNORE INTO local_images VALUES (?,?,?)", (key, str(blobs[checksum]), checksum))
                if isinstance(parent_key, str) and parent_key.startswith("https://"):
                    try:
                        self.db.execute("INSERT OR IGNORE INTO local_images VALUES (?,?,?)",
                                        (image_key(parent_key), str(blobs[checksum]), checksum))
                    except ValueError:
                        pass
            for key, value in document.items():
                if isinstance(value, (dict, list)):
                    self.register_local(value, blobs, key)
        elif isinstance(document, list):
            for value in document:
                self.register_local(value, blobs)

    def inventory(self):
        if self.meta("inventory_complete"):
            return
        blobs = {}
        if self.collection:
            index = self.collection / "catalog/image-index.jsonl"
            for line in index.read_text().splitlines():
                row = json.loads(line)
                source = self.collection / row["image_file"]
                if not source.resolve().is_relative_to(self.collection.resolve()) or digest(source) != row["sha256"]:
                    raise ValueError("Historical image cache changed; refusing to skip it.")
                blobs[row["sha256"]] = source
            self.register_local(json.loads((self.collection / "official-import/official-receipts.json").read_text()), blobs)
            for path in (self.collection / "sources").rglob("*.json"):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, ValueError):
                    continue
                self.register_local(data, blobs)
        for path in (ROOT / "exports").glob("venusaur-snivy-gx-*/*result.json"):
            data = json.loads(path.read_text())
            if data.get("status") == "downloaded_and_fully_decoded":
                source = Path(data["local_file"])
                if digest(source) != data["image"]["sha256"]:
                    raise ValueError("Previously downloaded single image changed.")
                self.register_local({"sha256": data["image"]["sha256"], "source_url": data["source_image"]},
                                    {data["image"]["sha256"]: source})
        self.db.commit()
        self.set_meta("local_blob_inventory", len(blobs))
        self.set_meta("inventory_complete", True)

    def parse(self, row, path, final_url):
        text = path.read_text(encoding="utf-8-sig")
        if row["kind"] == "script":
            for url in gallery_urls(text):
                self.add(url, "image", CAMPAIGN)
            return
        parsed = Page(final_url)
        if row["kind"] == "style":
            parsed.css(text)
        else:
            parsed.feed(text)
        for url in parsed.images:
            self.add(url, "image", canonical(final_url))
        for url in parsed.styles:
            self.add(url, "style", canonical(final_url))
        for url in parsed.external:
            self.db.execute("INSERT OR IGNORE INTO exclusions VALUES (?,?)", (url, "nonofficial_host_not_fetched"))
        if row["kind"] == "category":
            if not parsed.numbering:
                raise ValueError("Category pagination count missing; cannot prove complete traversal.")
            number, total = parsed.numbering
            if number != category_number(final_url):
                raise ValueError("Category returned a different pagination page.")
            articles = sorted({document_key(url) for url in parsed.articles})
            if not articles:
                raise ValueError("Category page contains no product article links.")
            self.db.execute("INSERT OR REPLACE INTO category_pages VALUES (?,?,?,?)",
                            (number, total, canonical(final_url), json.dumps(articles)))
            for url in parsed.pagination:
                self.add(url, "category", "category_pagination")
            for url in articles:
                self.add(url, "page", "product_category")
        if canonical(final_url) == CAMPAIGN:
            self.add(CAMPAIGN_SCRIPT, "script", "reviewed_151_generator")
        self.db.commit()

    def cache_first_category(self):
        path = self.output / "category-first.private.html"
        row = self.db.execute("SELECT * FROM jobs WHERE kind='category' AND key=?", ("category:" + CATEGORY,)).fetchone()
        if path.exists() and row and row["status"] == "pending":
            destination = self.output / "documents" / (hashlib.sha256(row["key"].encode()).hexdigest() + ".html")
            shutil.copyfile(path, destination)
            self.parse(row, destination, CATEGORY)
            self.finish(row, "done", {"local_file": str(destination), "source_url": CATEGORY, "cached_probe": True}, 200)

    def finish(self, row, status, result=None, code=None, error=None):
        self.db.execute("UPDATE jobs SET status=?,result=?,http_status=?,error=? WHERE key=?",
                        (status, json.dumps(result, ensure_ascii=False) if result else None, code, error, row["key"]))
        self.db.commit()

    def keep_image(self, path, *, source_url, reused=False):
        info = validate_image(path)
        destination = self.output / "images" / (info["sha256"] + info["suffix"])
        copy_verified(path, destination, info["sha256"])
        return {**info, "local_file": str(destination), "source_url": canonical(source_url) if not source_url.startswith("data:") else "embedded_in_saved_document",
                "reused_local_file": reused, "identity_status": "raw_image_no_printing_identity_assigned"}

    def skip_local(self, row):
        if row["kind"] != "image":
            return False
        url = row["url"]
        if url.startswith("data:image/"):
            header, payload = url.split(",", 1)
            if ";base64" not in header:
                from urllib.parse import unquote_to_bytes
                data = unquote_to_bytes(payload)
            else:
                data = base64.b64decode(payload, validate=True)
            path = self.output / "scratch" / (uuid.uuid4().hex + ".part")
            path.write_bytes(data)
            try:
                result = self.keep_image(path, source_url=url)
                self.finish(row, "done", result, 200)
            finally:
                path.unlink(missing_ok=True)
            return True
        local = self.db.execute("SELECT * FROM local_images WHERE key=?", (image_key(url),)).fetchone()
        if local:
            path = Path(local["source"])
            if digest(path) != local["sha256"]:
                raise ValueError("Previously downloaded local bytes changed.")
            result = self.keep_image(path, source_url=url, reused=True)
            self.finish(row, "reused", result, 200)
            return True
        return False

    def reuse_cached_images(self):
        """Resolve all local hits before scheduling any network work."""
        rows = self.db.execute(
            "SELECT * FROM jobs WHERE kind='image' AND status NOT IN ('done','reused','missing')"
        ).fetchall()
        for row in rows:
            try:
                self.skip_local(row)
            except (OSError, ValueError) as error:
                self.finish(row, "error", error=type(error).__name__)

    def process(self, row, result):
        path, code = result["path"], result["code"]
        try:
            if code in {404, 410}:
                self.finish(row, "missing", code=code, error=f"HTTP {code}")
                return
            if code != 200:
                raise OSError(f"HTTP_{code}")
            if row["kind"] == "image":
                if not result["mime"].startswith("image/") and result["mime"] not in {"application/octet-stream", "binary/octet-stream"}:
                    raise ValueError("Response is not an image.")
                record = self.keep_image(path, source_url=result["url"])
            else:
                suffix = ".css" if row["kind"] == "style" else ".js" if row["kind"] == "script" else ".html"
                destination = self.output / "documents" / (hashlib.sha256(row["key"].encode()).hexdigest() + suffix)
                shutil.copyfile(path, destination)
                self.parse(row, destination, result["url"])
                record = {"local_file": str(destination), "source_url": canonical(result["url"]), "sha256": digest(destination)}
            self.finish(row, "done", record, code)
        finally:
            path.unlink(missing_ok=True)

    def failure(self, row, error, *, blocked=False):
        current = self.db.execute("SELECT attempts FROM jobs WHERE key=?", (row["key"],)).fetchone()[0]
        retry = isinstance(error, OSError) and current < 3 and not blocked
        self.db.execute("UPDATE jobs SET status=?,error=?,available_at=? WHERE key=?",
                        ("pending" if retry else "blocked" if blocked else "error",
                         type(error).__name__ + ":" + str(error)[:100] if isinstance(error, OSError) else type(error).__name__,
                         time.time() + (2 ** current if retry else 0), row["key"]))
        self.db.commit()

    def run_phase(self, network, *, images=False):
        futures = {}
        condition = "kind='image'" if images else "kind!='image'"
        with ThreadPoolExecutor(max_workers=network.workers) as pool:
            try:
                self._run_phase(network, pool, futures, condition)
            finally:
                # Set cancellation before executor.__exit__ waits for curl workers.
                if futures:
                    network.stop.set()
                    for future in futures:
                        future.cancel()

    def _run_phase(self, network, pool, futures, condition):
        while True:
            if network.stop.is_set():
                for future in futures:
                    future.cancel()
            else:
                room = network.workers - len(futures)
                rows = self.db.execute(
                    f"SELECT * FROM jobs WHERE {condition} AND status='pending' AND available_at<=? "
                    "ORDER BY CASE kind WHEN 'category' THEN 0 WHEN 'page' THEN 1 ELSE 2 END,key LIMIT ?",
                    (time.time(), room),
                ).fetchall()
                for row in rows:
                    try:
                        network.check_host(row["url"])
                    except HostUnavailable:
                        self.finish(row, "deferred", error="HostUnavailable")
                        continue
                    try:
                        if self.skip_local(row):
                            continue
                    except (OSError, ValueError) as error:
                        self.finish(row, "error", error=type(error).__name__)
                        continue
                    self.db.execute("UPDATE jobs SET status='downloading',attempts=attempts+1 WHERE key=?", (row["key"],))
                    self.db.commit()
                    futures[pool.submit(network.fetch, row["url"], row["kind"])] = row
            if not futures:
                if network.stop.is_set():
                    raise Stopped("Official source stop recorded.")
                pending = self.db.execute(f"SELECT COUNT(*) FROM jobs WHERE {condition} AND status='pending'").fetchone()[0]
                if not pending:
                    break
                time.sleep(.5)
                continue
            completed, _ = wait(futures, timeout=1, return_when=FIRST_COMPLETED)
            for future in completed:
                row = futures.pop(future)
                try:
                    self.process(row, future.result())
                except HostUnavailable:
                    self.finish(row, "deferred", error="HostUnavailable")
                except (Stopped, CancelledError) as error:
                    self.failure(row, error, blocked=True)
                except (OSError, ValueError, UnicodeError) as error:
                    self.failure(row, error)
            self.export_summary(network)

    def summary(self):
        counts = {}
        for kind in ("category", "page", "script", "style", "image"):
            counts[kind] = dict(self.db.execute("SELECT status,COUNT(*) FROM jobs WHERE kind=? GROUP BY status", (kind,)).fetchall())
        categories = [dict(row) for row in self.db.execute("SELECT number,total,url FROM category_pages ORDER BY number")]
        expected = max((row["total"] for row in categories), default=0)
        category_complete = bool(expected) and {row["number"] for row in categories} == set(range(1, expected + 1))
        all_articles = set()
        for row in self.db.execute("SELECT articles FROM category_pages"):
            all_articles.update(json.loads(row[0]))
        sources = set(source_pages(self.manifest))
        union = sources | all_articles
        image_records = [json.loads(row[0]) for row in self.db.execute("SELECT result FROM jobs WHERE kind='image' AND status IN ('done','reused')")]
        unique = {row["sha256"]: row["bytes"] for row in image_records}
        unfinished = self.db.execute("SELECT COUNT(*) FROM jobs WHERE status NOT IN ('done','reused','missing')").fetchone()[0]
        return {
            "source": "official_union_original_plus_all_product", "original_manifest_struct_sha256": self.manifest_hash,
            "original_manifest_file_sha256": self.meta("original_manifest_file_sha256"),
            "original_source_pages": len(sources), "category_product_articles": len(all_articles),
            "source_category_article_overlap": len(sources & all_articles), "merged_unique_source_pages": len(union),
            "category_pages_expected": expected, "category_pages_received": len(categories), "category_pagination_complete": category_complete,
            "jobs": counts, "unique_image_files": len(unique), "unique_image_bytes": sum(unique.values()),
            "reused_local_image_urls": counts["image"].get("reused", 0),
            "excluded_nonofficial_resources": self.db.execute("SELECT COUNT(*) FROM exclusions").fetchone()[0],
            "unfinished_jobs": unfinished, "all_known_jobs_terminal": unfinished == 0,
            "download_complete": category_complete and unfinished == 0
                and not any(value.get("missing", 0) for value in counts.values()),
            "category_pages": categories, "library_modified": False,
        }

    def export_summary(self, network=None):
        result = self.summary()
        if network:
            result.update(network_requests_this_run=network.request_count, successful_requests_this_run=network.successes,
                          workers=network.workers, max_requests_per_second_per_host=network.max_rps,
                          source_access_blocked=bool(network.state.get("access_block")),
                          transport_pauses=network.state["transport_pauses"])
        atomic_json(self.output / "summary.json", result)
        now = time.monotonic()
        if now - getattr(self, "last_log", 0) >= 10:
            self.last_log = now
            print(json.dumps({k: result[k] for k in ("category_pages_received", "category_pages_expected", "merged_unique_source_pages", "jobs", "unique_image_files", "unique_image_bytes", "unfinished_jobs")}, ensure_ascii=False), flush=True)
        return result

    def export_catalog(self):
        with (self.output / "images.jsonl").open("w", encoding="utf-8") as stream:
            for row in self.db.execute("SELECT key,origins,result FROM jobs WHERE kind='image' AND status IN ('done','reused') ORDER BY key"):
                record = json.loads(row["result"])
                record.update(source_pages=json.loads(row["origins"]), url_key_sha256=hashlib.sha256(row["key"].encode()).hexdigest())
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        public_sources, category_pages, supporting_resources = [], [], []
        for row in self.db.execute("SELECT url,kind,origins,status FROM jobs WHERE kind IN ('category','page','script','style') ORDER BY key"):
            record = {"url": canonical(row["url"]), "kind": row["kind"],
                      "origins": json.loads(row["origins"]), "status": row["status"]}
            (public_sources if row["kind"] == "page" else
             category_pages if row["kind"] == "category" else supporting_resources).append(record)
        atomic_json(self.output / "merged-source-pages.json", {
            "original_manifest_sha256": self.manifest_hash, "merge_operation": "union_not_replacement",
            "pages": public_sources, "category_pages": category_pages,
            "supporting_resources": supporting_resources,
        })
        errors = [{"url": canonical(row["url"]) if not row["url"].startswith("data:") else "embedded_image",
                   "kind": row["kind"], "status": row["status"], "http_status": row["http_status"],
                   "attempts": row["attempts"], "error": row["error"]}
                  for row in self.db.execute("SELECT * FROM jobs WHERE status NOT IN ('done','reused') ORDER BY kind,key")]
        atomic_json(self.output / "unavailable-or-unfinished.json", errors)

    def export_download_list(self, destination):
        """Publish portable discovery evidence, never cached signatures/state."""
        summary = self.summary()
        pages = [
            {"url": canonical(row["url"]), "origins": json.loads(row["origins"])}
            for row in self.db.execute("SELECT url,origins FROM jobs WHERE kind='page' ORDER BY key")
        ]
        if len(pages) != summary["merged_unique_source_pages"]:
            raise ValueError("Merged source count mismatch; refusing to export an incomplete list.")
        destination.mkdir(parents=True, exist_ok=True)
        atomic_json(destination / "official-bulk-sources.json", {
            "schema_version": 1, "snapshot_date_utc": time.strftime("%Y-%m-%d", time.gmtime()),
            "merge_operation": "union_not_replacement",
            "original_manifest_struct_sha256": self.manifest_hash,
            "original_manifest_file_sha256": self.meta("original_manifest_file_sha256"),
            "category": CATEGORY, "category_pages": summary["category_pages"],
            "counts": {key: summary[key] for key in (
                "original_source_pages", "category_product_articles",
                "source_category_article_overlap", "merged_unique_source_pages",
            )},
            "pages": pages, "image_inventory_file": "official-bulk-images.jsonl",
            "image_urls_require_page_refresh": True,
        })
        with (destination / "official-bulk-images.jsonl").open("w", encoding="utf-8") as stream:
            for row in self.db.execute("SELECT key,url,origins FROM jobs WHERE kind='image' ORDER BY key"):
                embedded = row["url"].startswith("data:")
                record = {"url": None if embedded else image_key(row["url"]),
                          "embedded_image": embedded, "source_pages": json.loads(row["origins"]),
                          "url_key_sha256": hashlib.sha256(row["key"].encode()).hexdigest()}
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        return {"source_pages": len(pages), "image_references": self.db.execute(
            "SELECT COUNT(*) FROM jobs WHERE kind='image'").fetchone()[0]}

    def verify(self):
        records = [json.loads(row[0]) for row in self.db.execute("SELECT result FROM jobs WHERE kind='image' AND status IN ('done','reused')")]
        unique = {r["sha256"]: r for r in records}
        for record in unique.values():
            checked = validate_image(Path(record["local_file"]))
            if any(checked[key] != record[key] for key in checked):
                raise ValueError("Archived image changed.")
        return {"verified_unique_images": len(unique), "verified_bytes": sum(r["bytes"] for r in unique.values()), "network_requests": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "status", "verify", "export-list"))
    parser.add_argument("--manifest", type=Path, default=ROOT / "manifests/remaining-images.json")
    parser.add_argument("--output", type=Path, default=ROOT / "downloads-official/all-public-images")
    parser.add_argument("--policy-output", type=Path, default=ROOT / "downloads-official")
    parser.add_argument("--collection", type=Path, help="Optional verified historical collection; never required on a fresh machine.")
    parser.add_argument("--source-list", type=Path, default=ROOT / "manifests/official-bulk-sources.json",
                        help="Committed union of source pages; image signatures are refreshed from these pages.")
    parser.add_argument("--list-output", type=Path, default=ROOT / "manifests")
    parser.add_argument("--workers", type=int, default=32)
    parser.add_argument("--max-rps", type=float, default=4)
    parser.add_argument("--site-authorized", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workers <= 32 or not 0 < args.max_rps <= 4:
        parser.error("workers must be 1..32 and max-rps must be >0 and <=4.")
    if args.command == "run" and not args.site_authorized:
        parser.error("run requires explicit --site-authorized.")
    manifest_bytes = args.manifest.read_bytes()
    archive = Archive(args.output, load_manifest(args.manifest), collection=args.collection)
    if args.command == "export-list":
        with output_lock(args.policy_output):
            print(json.dumps(archive.export_download_list(args.list_output), ensure_ascii=False, indent=2))
        return
    if args.command == "status":
        print(json.dumps(archive.summary(), ensure_ascii=False, indent=2))
        return
    if args.command == "verify":
        print(json.dumps(archive.verify(), ensure_ascii=False, indent=2))
        return
    if not shutil.which("curl"):
        raise SystemExit("This Linux archive runner requires the installed curl executable.")
    with output_lock(args.policy_output):
        network = Network(args.policy_output, args.output / "scratch", workers=args.workers, max_rps=args.max_rps)
        try:
            file_hash = hashlib.sha256(manifest_bytes).hexdigest()
            old_hash = archive.meta("original_manifest_file_sha256")
            if old_hash and old_hash != file_hash:
                raise ValueError("Original source manifest file bytes changed.")
            archive.set_meta("original_manifest_file_sha256", file_hash)
            archive.recover()
            source_list = json.loads(args.source_list.read_text()) if args.source_list.exists() else None
            archive.seed(source_list)
            archive.inventory()
            archive.cache_first_category()
            archive.run_phase(network)
            archive.reuse_cached_images()
            archive.run_phase(network, images=True)
        except BaseException:
            network.stop.set()
            raise
        finally:
            archive.export_catalog()
            archive.export_summary(network)
            if args.manifest.read_bytes() != manifest_bytes:
                raise ValueError("Original manifest was modified.")
    print(json.dumps(archive.verify(), ensure_ascii=False), flush=True)
    if not archive.summary()["download_complete"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
