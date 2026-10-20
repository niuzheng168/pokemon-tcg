"""Resumable, source-isolated acquisition of AREAZERO public card records.

Uses published public frontend endpoints, no credentials, proxies or browser
impersonation. User authorization is not a claim of source-operator permission.
Does not modify the Wiki/official queues or automatically merge into a library.
"""
from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.request

from card_storage import atomic_json, safe_path
from official_downloader import decode_image
from portable_downloader import output_lock

ROOT = Path(__file__).resolve().parent
ORIGIN = "https://tcg.mik.moe"
USER_AGENT = "Codex (OpenAI coding agent; +https://github.com/openai/codex)"
DEFAULT_OUTPUT = ROOT / "exports/mik-full-20261019"
ENDPOINTS = {
    "catalog": "/api/v3/card/product-list",
    "set": "/api/v3/card/product-detail",
    "metadata": "/api/v3/card/card-detail",
}
IMAGE_SUFFIXES = {".png", ".jpg", ".webp", ".gif"}
LEGACY_FORMAT_ERROR = "ValueError: The published PNG endpoint returned another format."


class Stopped(RuntimeError):
    pass


class Missing(RuntimeError):
    pass


class Transient(RuntimeError):
    pass


def component(value):
    if (not isinstance(value, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", value)
            or ".." in value or value.endswith(".")
            or re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", value.split(".")[0], re.I)):
        raise ValueError("Unsafe source identifier.")
    return value


def card_key(record):
    return component(record["setCode"]) + "/" + component(record["cardIndex"])


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def immutable_bytes(path, raw):
    """Publish complete files atomically; never overwrite conflicting bytes."""
    path = Path(path)
    if path.exists():
        if path.read_bytes() != raw:
            raise ValueError(f"Refusing to overwrite a different file: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name, suffix=".part", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            if path.read_bytes() != raw:
                raise ValueError(f"File appeared with different bytes: {path}")
        else:
            os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def immutable_json(path, data):
    if Path(path).exists() and load(path) != data:
        raise ValueError(f"Refusing to replace different metadata: {path}")
    if not Path(path).exists():
        atomic_json(path, data)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Network:
    def __init__(self, output, purpose, *, interval=.25, opener=None):
        if not purpose.strip() or len(purpose) > 200 or re.search(r"[\r\n\x00]", purpose):
            raise ValueError("Supply a short, privacy-safe purpose.")
        if not .25 <= interval <= 3600:
            raise ValueError("Request interval must be at least 0.25 seconds.")
        self.output, self.purpose, self.interval = Path(output), purpose, interval
        self.stop = threading.Event()
        self.gate, self.log_lock, self.block_lock = threading.Lock(), threading.Lock(), threading.Lock()
        self.last_start = 0.
        self.local = threading.local()
        self.test_opener = opener

    def check(self):
        if (self.output / "access-block.json").exists():
            raise Stopped("Persistent source access block; no automatic retry.")
        if self.stop.is_set() or (self.output / "PAUSE").exists():
            raise Stopped("Download paused.")

    def block(self, reason, url, status=None):
        with self.block_lock:
            if not (self.output / "access-block.json").exists():
                atomic_json(self.output / "access-block.json", {
                    "reason": reason, "url": url, "http_status": status, "time": time.time(),
                    "automatic_clear": False,
                })
            self.stop.set()
        raise Stopped(reason)

    def fetch(self, kind, payload):
        self.check()
        if kind not in (*ENDPOINTS, "image"):
            raise ValueError("Unsupported public operation.")
        if kind == "image":
            key = card_key(payload)
            path = f"/static/img/{key}.png"
            intent = f"下载 {key} 的卡牌图片，用于{self.purpose}。"
            body, maximum = None, 25_000_000
        else:
            path, maximum = ENDPOINTS[kind], 8_000_000
            key = component(payload["setId"]) if kind == "set" else (
                card_key(payload) if kind == "metadata" else "全部发售系列")
            intent = f"读取 {key} 的{('完整卡牌 metadata' if kind == 'metadata' else '卡牌清单')}，用于{self.purpose}。"
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        url = ORIGIN + path
        # One global rate gate, shared by API and image workers. Waiting is
        # interruptible; no queued request may start after a source block.
        with self.gate:
            self.stop.wait(max(0., self.last_start + self.interval - time.monotonic()))
            self.check()
            self.last_start = time.monotonic()
        request = urllib.request.Request(url, data=body, method="POST" if body is not None else "GET", headers={
            "User-Agent": USER_AGENT, "Agent-Intent": intent.encode("utf-8"),
            "Accept": "image/png" if kind == "image" else "application/json",
            "Content-Type": "application/json", "Accept-Encoding": "identity",
        })
        if not hasattr(self.local, "opener"):
            self.local.opener = self.test_opener or urllib.request.build_opener(
                urllib.request.ProxyHandler({}), NoRedirect())
        receipt = {"url": url, "method": request.method, "body": payload if body else None,
                   "agent_intent": intent, "user_agent": USER_AGENT, "started_at": time.time()}
        try:
            with self.local.opener.open(request, timeout=25) as response:
                receipt["http_status"] = response.status
                content_type = response.headers.get("Content-Type", "")
                receipt["content_type"] = content_type
                # Do not retain or forward session cookies, authentication or
                # arbitrary server headers.
                if int(response.headers.get("Content-Length", "0")) > maximum:
                    raise ValueError("Response exceeds the download size limit.")
                chunks, count, deadline = [], 0, time.monotonic() + 60
                while True:
                    self.check()
                    if time.monotonic() > deadline:
                        raise TimeoutError("Total response deadline exceeded.")
                    chunk = getattr(response, "read1", response.read)(65536)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > maximum:
                        raise ValueError("Response exceeds the download size limit.")
                    chunks.append(chunk)
                raw = b"".join(chunks)
            if "html" in content_type.lower():
                self.block("Unexpected HTML/challenge response; manual inspection required.", url)
            if kind != "image":
                value = json.loads(raw)
                code = value.get("code") if isinstance(value, dict) else None
                if str(code) in {"401", "403", "429"}:
                    self.block("Source returned an API access denial.", url, code)
                if isinstance(code, int) and 500 <= code <= 599:
                    raise Transient(f"Source API returned {code}.")
                if code != 200 or not isinstance(value.get("data"), dict):
                    raise ValueError(f"Unexpected API response: {str(value)[:300]}")
            receipt.update(bytes=len(raw), sha256=sha256(raw))
            return raw, receipt
        except urllib.error.HTTPError as exc:
            receipt["http_status"] = exc.code
            if exc.code in (401, 403, 429) or 300 <= exc.code < 400:
                self.block("HTTP denial/rate limit/redirect; no automatic retry.", url, exc.code)
            if exc.code == 404:
                raise Missing(f"Source returned HTTP 404: {path}") from exc
            if 500 <= exc.code <= 599:
                raise Transient(f"Source returned HTTP {exc.code}.") from exc
            raise ValueError(f"Source returned HTTP {exc.code}: {path}") from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            raise Transient(str(exc)) from exc
        finally:
            receipt["finished_at"] = time.time()
            with self.log_lock:
                self.output.mkdir(parents=True, exist_ok=True)
                with (self.output / "requests.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(receipt, ensure_ascii=False) + "\n")


def cached_api(output, network, kind, payload, relative, receipt_name):
    path = safe_path(output, relative)
    receipt_path = path.with_name(receipt_name)
    if path.exists():
        raw = path.read_bytes()
        if not receipt_path.exists() or load(receipt_path).get("sha256") != sha256(raw):
            raise ValueError(f"Cached response lacks matching provenance: {path}")
    else:
        raw, receipt = network.fetch(kind, payload)
        atomic_json(receipt_path, receipt)
        immutable_bytes(path, raw)
    value = json.loads(raw)
    if value.get("code") != 200 or not isinstance(value.get("data"), dict):
        raise ValueError("Cached response is not successful card data.")
    return value["data"]


def validate_metadata(data, expected):
    if card_key(data) != card_key(expected):
        raise ValueError("Returned card identity does not match the requested printing.")
    if (not data.get("name") or "description" not in data
            or data["description"] is not None and not isinstance(data["description"], str)):
        raise ValueError("Card details are incomplete.")
    if expected.get("cardName") and data["name"] != expected["cardName"]:
        raise ValueError("Returned card name disagrees with its series listing.")
    if expected.get("effectId") and data.get("effectId") != expected["effectId"]:
        raise ValueError("Returned rules identity disagrees with its series listing.")


def stored_image_path(directory, receipt):
    """Use the decoded format, not the source URL's sometimes incorrect .png."""
    suffix = receipt["image"]["suffix"]
    if suffix not in IMAGE_SUFFIXES:
        raise ValueError("Unsupported cached image format.")
    filename = "image" + suffix
    if receipt.get("file", filename) != filename:
        raise ValueError("Image receipt filename disagrees with its decoded format.")
    return safe_path(directory, Path(filename))


class Runner:
    def __init__(self, output, network, *, workers=4):
        if not 1 <= workers <= 4:
            raise ValueError("Use between one and four workers.")
        self.output, self.network, self.workers = Path(output), network, workers
        self.output.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.output / "queue.sqlite")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY, expected INTEGER, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cards (
                id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memberships (
                product TEXT, card TEXT, PRIMARY KEY (product, card));
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY, kind TEXT, key TEXT, body TEXT,
                state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                next_at REAL NOT NULL DEFAULT 0, error TEXT,
                UNIQUE (kind, key));
            CREATE INDEX IF NOT EXISTS ready_jobs ON jobs (state, next_at, kind);
            CREATE INDEX IF NOT EXISTS jobs_by_key ON jobs (key);
            CREATE TABLE IF NOT EXISTS warnings (id TEXT PRIMARY KEY, body TEXT);
        """)
        # Only the sole writer holding output_lock may recover abandoned jobs.
        self.db.execute("UPDATE jobs SET state='pending' WHERE state='running'")
        self.db.commit()

    def add_job(self, kind, key, data):
        self.db.execute("INSERT OR IGNORE INTO jobs(kind,key,body) VALUES(?,?,?)",
                        (kind, key, json.dumps(data, ensure_ascii=False)))

    def retry_image_formats(self):
        """Explicit, narrow recovery of the former PNG-only validation bug."""
        self.network.check()
        rows = self.db.execute("""
            SELECT id,key,attempts,error FROM jobs
            WHERE kind='image' AND state='error' AND error=?
        """, (LEGACY_FORMAT_ERROR,)).fetchall()
        if not rows:
            return 0
        with (self.output / "format-retries.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"time": time.time(), "jobs": [dict(row) for row in rows]},
                                    ensure_ascii=False) + "\n")
        with self.db:
            self.db.executemany("UPDATE jobs SET state='pending',next_at=0,error=NULL WHERE id=?",
                                ((row["id"],) for row in rows))
        return len(rows)

    def prepare(self):
        catalog = cached_api(self.output, self.network, "catalog", {},
                             Path("catalog-response.json"), "catalog-receipt.json")
        products = catalog["list"]
        if not isinstance(products, list) or not products:
            raise ValueError("The public series catalog is empty or unsupported.")
        seen = set()
        for product in products:
            key = component(product["setId"])
            if key in seen or type(product["cardsNum"]) is not int or product["cardsNum"] < 0:
                raise ValueError("Duplicate or invalid catalog product.")
            seen.add(key)
        with self.db:
            for product in products:
                key = product["setId"]
                self.db.execute("INSERT OR IGNORE INTO products VALUES(?,?,?)",
                                (key, product["cardsNum"], json.dumps(product, ensure_ascii=False)))
                self.add_job("set", key, {"setId": key})
        immutable_json(self.output / "catalog.json", catalog)

    def work(self, kind, expected):
        self.network.check()
        if kind == "set":
            key = component(expected["setId"])
            data = cached_api(self.output, self.network, kind, expected,
                              Path("sets") / key / "source-response.json", "receipt.json")
            if data.get("setId") != key or not isinstance(data.get("cards"), list):
                raise ValueError("Returned series identity or card list is invalid.")
            for card in data["cards"]:
                card_key(card)
            immutable_json(safe_path(self.output, Path("sets") / key / "set.json"), data)
            return data
        key = card_key(expected)
        directory = Path("cards") / key
        if kind == "metadata":
            data = cached_api(self.output, self.network, kind,
                              {k: expected[k] for k in ("setCode", "cardIndex")},
                              directory / "source-response.json", "metadata-receipt.json")
            validate_metadata(data, expected)
            immutable_json(safe_path(self.output, directory / "metadata.json"), data)
            return None
        if kind != "image":
            raise ValueError("Unsupported job type.")
        validate_metadata(load(safe_path(self.output, directory / "metadata.json")), expected)
        local_directory = safe_path(self.output, directory)
        receipt_path = safe_path(local_directory, Path("image-receipt.json"))
        receipt = load(receipt_path) if receipt_path.exists() else None
        path = stored_image_path(local_directory, receipt) if receipt else (
            safe_path(local_directory, Path("image.png")))
        if path.exists():
            info = decode_image(path.read_bytes())
            if not receipt or receipt.get("image") != info:
                raise ValueError("Cached image is missing matching hash/provenance.")
        else:
            if any((local_directory / ("image" + suffix)).exists() for suffix in IMAGE_SUFFIXES):
                raise ValueError("Existing image disagrees with its provenance; refusing to replace it.")
            raw, receipt = self.network.fetch("image", expected)
            info = decode_image(raw)
            receipt["image"] = info
            path = stored_image_path(local_directory, receipt)
            receipt["file"] = path.name
            atomic_json(receipt_path, receipt)
            immutable_bytes(path, raw)
        return None

    def accept(self, job, data):
        if job["kind"] == "set":
            seen = {}
            for card in data["cards"]:
                key = card_key(card)
                if key in seen and seen[key] != card:
                    raise ValueError("Conflicting duplicate printing in a series.")
                seen[key] = card
                previous = self.db.execute("SELECT body FROM cards WHERE id=?", (key,)).fetchone()
                if previous and load_dict(previous["body"]) != card:
                    raise ValueError("Conflicting printing metadata across series.")
            expected = self.db.execute("SELECT expected FROM products WHERE id=?", (job["key"],)).fetchone()[0]
            if expected != len(seen) or data.get("cardsNum") != len(seen):
                self.db.execute("INSERT OR REPLACE INTO warnings VALUES(?,?)", (job["key"], json.dumps({
                    "catalog_count": expected, "detail_count": data.get("cardsNum"),
                    "unique_observed_cards": len(seen),
                })))
            for key, card in seen.items():
                self.db.execute("INSERT OR IGNORE INTO cards VALUES(?,?)",
                                (key, json.dumps(card, ensure_ascii=False)))
                self.db.execute("INSERT OR IGNORE INTO memberships VALUES(?,?)", (job["key"], key))
                self.add_job("metadata", key, card)
        elif job["kind"] == "metadata":
            self.add_job("image", job["key"], load_dict(job["body"]))
        self.db.execute("UPDATE jobs SET state='done',error=NULL WHERE id=?", (job["id"],))

    def summary(self, state):
        counts = {}
        for row in self.db.execute("SELECT kind,state,count(*) AS n FROM jobs GROUP BY kind,state"):
            counts.setdefault(row["kind"], {})[row["state"]] = row["n"]
        result = {
            "source": ORIGIN + "/cards", "source_type": "third-party",
            "state": state, "updated_at": time.time(), "pid": os.getpid(),
            "output": str(self.output.resolve()), "workers": self.workers,
            "products": self.db.execute("SELECT count(*) FROM products").fetchone()[0],
            "listed_card_memberships": self.db.execute("SELECT coalesce(sum(expected),0) FROM products").fetchone()[0],
            "discovered_unique_printings": self.db.execute("SELECT count(*) FROM cards").fetchone()[0],
            "metadata_downloaded": counts.get("metadata", {}).get("done", 0),
            "images_downloaded": counts.get("image", {}).get("done", 0),
            "jobs": counts,
            "catalog_count_warnings": {
                row["id"]: load_dict(row["body"]) for row in self.db.execute("SELECT * FROM warnings")},
            "errors": [dict(row) for row in self.db.execute(
                "SELECT kind,key,state,attempts,error FROM jobs WHERE state IN ('error','missing')")],
            "existing_library_modified": False, "other_download_queues_resumed": False,
        }
        atomic_json(self.output / "progress.json", result)
        print(json.dumps({k: result[k] for k in (
            "state", "products", "discovered_unique_printings", "metadata_downloaded", "images_downloaded")},
                         ensure_ascii=False), flush=True)
        return result

    def run(self, *, limit=None):
        self.network.check()
        self.prepare()
        futures, submitted, last_report, state = {}, 0, 0., "running"
        try:
            with ThreadPoolExecutor(max_workers=self.workers) as pool:
                while True:
                    self.network.check()
                    if time.monotonic() - last_report >= 10:
                        self.summary("running")
                        last_report = time.monotonic()
                    while len(futures) < self.workers and (limit is None or submitted < limit):
                        job = self.db.execute("""
                            SELECT * FROM jobs WHERE state='pending' AND next_at<=?
                            ORDER BY CASE kind WHEN 'set' THEN 0 WHEN 'image' THEN 1 ELSE 2 END, id LIMIT 1
                        """, (time.time(),)).fetchone()
                        if job is None:
                            break
                        with self.db:
                            self.db.execute("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?", (job["id"],))
                        futures[pool.submit(self.work, job["kind"], load_dict(job["body"]))] = job
                        submitted += 1
                    if not futures:
                        pending = self.db.execute("SELECT count(*) FROM jobs WHERE state='pending'").fetchone()[0]
                        if not pending or (limit is not None and submitted >= limit):
                            break
                        self.network.stop.wait(.25)
                        continue
                    done, _ = wait(futures, timeout=.5, return_when=FIRST_COMPLETED)
                    for future in done:
                        job = futures.pop(future)
                        try:
                            data = future.result()
                            with self.db:
                                self.accept(job, data)
                        except Stopped:
                            with self.db:
                                self.db.execute("UPDATE jobs SET state='pending' WHERE id=?", (job["id"],))
                            raise
                        except Exception as exc:
                            attempts = job["attempts"] + 1
                            retry = isinstance(exc, Transient) and attempts < 3
                            status = "pending" if retry else ("missing" if isinstance(exc, Missing) else "error")
                            with self.db:
                                self.db.execute("UPDATE jobs SET state=?,next_at=?,error=? WHERE id=?",
                                                (status, time.time() + 5 * 2 ** (attempts - 1),
                                                 f"{type(exc).__name__}: {exc}", job["id"]))
                            print(f"{job['kind']} {job['key']}: {status}: {exc}", flush=True)
        except (Stopped, KeyboardInterrupt):
            state = "blocked" if (self.output / "access-block.json").exists() else "paused"
        finally:
            # A block or pause can leave already completed files awaiting their
            # DB transaction. They will be validated and reused on explicit run.
            with self.db:
                self.db.execute("UPDATE jobs SET state='pending' WHERE state='running'")
        pending = self.db.execute("SELECT count(*) FROM jobs WHERE state='pending'").fetchone()[0]
        errors = self.db.execute("SELECT count(*) FROM jobs WHERE state IN ('error','missing')").fetchone()[0]
        warnings = self.db.execute("SELECT count(*) FROM warnings").fetchone()[0]
        if state == "running":
            state = "paused" if pending else ("complete_with_gaps" if errors or warnings else "complete")
        if state == "complete" and verify(self.output)["errors"]:
            state = "complete_with_gaps"
        result = self.summary(state)
        self.export_index()
        return result

    def export_index(self):
        """Small source index, not a guessed full-number/engine/library mapping."""
        path = self.output / "index.jsonl"
        fd, name = tempfile.mkstemp(prefix=".index", suffix=".part", dir=self.output)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                for row in self.db.execute("SELECT * FROM cards ORDER BY id"):
                    states = {r["kind"]: r["state"] for r in self.db.execute(
                        "SELECT kind,state FROM jobs WHERE key=?", (row["id"],))}
                    stream.write(json.dumps({
                        "source_card": load_dict(row["body"]), "source_page": ORIGIN + "/cards/" + row["id"],
                        "directory": "cards/" + row["id"], "metadata_state": states.get("metadata"),
                        "image_state": states.get("image"),
                        "image_file": (
                            stored_image_path(
                                self.output / "cards" / row["id"],
                                load(self.output / "cards" / row["id"] / "image-receipt.json")
                            ).name if states.get("image") == "done" else None),
                    }, ensure_ascii=False) + "\n")
            os.replace(name, path)
        finally:
            Path(name).unlink(missing_ok=True)

    def close(self):
        self.db.close()


def load_dict(text):
    return json.loads(text)


def verify(output):
    """Offline read-back of every committed completed job, even during a run."""
    output = Path(output).resolve()
    db = sqlite3.connect((output / "queue.sqlite").as_uri() + "?mode=ro", uri=True)
    errors, counts = [], {"metadata": 0, "image": 0}
    try:
        jobs = db.execute("""
            SELECT jobs.kind,jobs.key,cards.body FROM jobs JOIN cards ON jobs.key=cards.id
            WHERE jobs.state='done' AND jobs.kind IN ('metadata','image')
        """).fetchall()
        for kind, key, body in jobs:
            try:
                directory = safe_path(output, Path("cards") / key)
                if kind == "metadata":
                    raw = (directory / "source-response.json").read_bytes()
                    if sha256(raw) != load(directory / "metadata-receipt.json")["sha256"]:
                        raise ValueError("Source response hash mismatch.")
                    envelope, data = json.loads(raw), load(directory / "metadata.json")
                    if envelope.get("code") != 200 or envelope.get("data") != data:
                        raise ValueError("Extracted metadata differs from the original API response.")
                    validate_metadata(data, load_dict(body))
                else:
                    receipt = load(directory / "image-receipt.json")
                    if decode_image(stored_image_path(directory, receipt).read_bytes()) != receipt["image"]:
                        raise ValueError("Image read-back/provenance mismatch.")
                counts[kind] += 1
            except Exception as exc:
                errors.append({"kind": kind, "key": key, "error": f"{type(exc).__name__}: {exc}"})
    finally:
        db.close()
    result = {"checked_at": time.time(), "verified_completed_jobs": counts, "errors": errors,
              "scope": "Completed jobs only; pending/missing jobs are not represented as verified."}
    atomic_json(output / "verification.json", result)
    return result


def seed(output, source):
    """Reuse only a fully verified prior one-card export, preserving receipts."""
    data = load(source / "metadata.json")
    validate_metadata(data, data)
    raw = (source / "source-response.json").read_bytes()
    if (json.loads(raw).get("code") != 200 or json.loads(raw).get("data") != data
            or load(source / "metadata-receipt.json")["sha256"] != sha256(raw)):
        raise ValueError("Seed metadata provenance mismatch.")
    receipt = load(source / "image-receipt.json")
    image_path = stored_image_path(source, receipt)
    image = image_path.read_bytes()
    if decode_image(image) != receipt["image"]:
        raise ValueError("Seed image validation failed.")
    directory = Path("cards") / card_key(data)
    for name in ("metadata.json", "source-response.json", "metadata-receipt.json", image_path.name, "image-receipt.json"):
        immutable_bytes(safe_path(output, directory / name), (source / name).read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("pause")
    sub.add_parser("verify")
    run = sub.add_parser("run")
    run.add_argument("--user-authorized", action="store_true", help="Local user authorization, not source-operator permission")
    run.add_argument("--purpose", required=True, help="Short privacy-safe purpose, sent to the source")
    run.add_argument("--workers", type=int, default=4)
    run.add_argument("--interval", type=float, default=.25)
    run.add_argument("--limit", type=int, help="Bound this invocation to this many jobs")
    run.add_argument("--resume", action="store_true", help="Explicitly remove a local PAUSE marker, never an access block")
    run.add_argument("--retry-image-formats", action="store_true",
                     help="Retry only previous PNG-only format validation failures, preserving their audit history")
    run.add_argument("--seed", type=Path, help="Verified previous single-card export")
    args = parser.parse_args()
    if args.command == "status":
        print(json.dumps(load(args.output / "progress.json") if (args.output / "progress.json").exists()
                         else {"state": "not_started", "output": str(args.output)},
                         ensure_ascii=False, indent=2))
        return 0
    if args.command == "pause":
        atomic_json(args.output / "PAUSE", {"requested_at": time.time()})
        return 0
    if args.command == "verify":
        result = verify(args.output)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result["errors"] else 0
    if not args.user_authorized:
        parser.error("run requires explicit --user-authorized")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    with output_lock(args.output):
        net = Network(args.output, args.purpose, interval=args.interval)
        if args.resume:
            if (args.output / "access-block.json").exists():
                raise Stopped("A source access block cannot be cleared by --resume.")
            (args.output / "PAUSE").unlink(missing_ok=True)
        net.check()
        if args.seed:
            seed(args.output, args.seed)
        runner = Runner(args.output, net, workers=args.workers)
        if args.retry_image_formats:
            print(f"Requeued format-only failures: {runner.retry_image_formats()}", flush=True)
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: net.stop.set())
        try:
            try:
                result = runner.run(limit=args.limit)
            except Stopped:
                result = runner.summary("blocked" if (args.output / "access-block.json").exists() else "paused")
                runner.export_index()
        finally:
            runner.close()
    return 2 if result["state"] in ("blocked", "complete_with_gaps") else 0


if __name__ == "__main__":
    raise SystemExit(main())
