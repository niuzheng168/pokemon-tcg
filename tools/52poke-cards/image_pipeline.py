"""Persistent download manifest with completely independent download and OCR workers.

plan prepares archived card references and published official image URLs.
download consumes URLs serially; it never imports model credentials or waits for OCR.
process consumes verified local files; it never downloads source pages or pictures.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import urllib.error
from urllib.parse import urlsplit

from collect_official_candidates import (
    ArticleImages, DIRECTORY, OFFICIAL_RATE, OCRPipeline, OfficialNetwork,
    canonical_url, initialize, settings,
)
from download_images import AccessBlocked, ROOT, download_asset, dump_json, sha256
from tool_paths import DEFAULT_ENV


def connect(directory=DIRECTORY):
    db = initialize(directory)
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS source_jobs(
            url TEXT PRIMARY KEY, priority INTEGER, status TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS resource_jobs(
            url TEXT PRIMARY KEY, fetch_url TEXT, page_url TEXT, priority INTEGER,
            status TEXT, attempts INTEGER DEFAULT 0, error TEXT, updated_at REAL);
        CREATE TABLE IF NOT EXISTS resource_sources(
            url TEXT, page_url TEXT, PRIMARY KEY(url,page_url));
    """)
    return db


@contextmanager
def worker_lock(directory, name):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / f".{name}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def state(db, role, status):
    db.execute("INSERT OR REPLACE INTO state VALUES (?,?)", (
        f"{role}_status", json.dumps({"status": status, "pid": os.getpid(), "at": time.time()}),
    ))
    db.commit()


def manifest_references(db, path, queue_path=None):
    """The full archived reference list is local and requires no network or OCR."""
    queue_path = queue_path or ROOT / "images-zh-hans/queue.sqlite"
    source = sqlite3.connect(f"file:{queue_path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    pages, references = {}, []
    for row in source.execute("SELECT * FROM jobs WHERE active=1 ORDER BY filename"):
        urls = sorted(set(re.findall(r"https://www\.pokemon\.cn/[^\s\]|]+", row["source_evidence"] or "")))
        references.append({
            "wiki_filename": row["filename"], "file_page_id": row["file_page_id"],
            "file_revision_id": row["file_revision_id"], "printings": json.loads(row["uses_json"]),
            "declared_official_pages": urls, "matching_status": row["status"],
            "asset_url": row["asset_url"],
        })
        for url in urls:
            canonical_url(url)
            pages[url] = pages.get(url, 0) + 1
    source.close()
    for url, count in pages.items():
        db.execute("""
            INSERT INTO source_jobs VALUES (?,?,'pending',NULL)
            ON CONFLICT(url) DO UPDATE SET priority=excluded.priority
        """, (url, count))
    db.commit()
    write_jsonl(path, references)
    return len(references), len(pages)


def write_jsonl(path, rows):
    temporary = path.with_suffix(path.suffix + ".part")
    with temporary.open("w") as output:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary.replace(path)


def enqueue_page(db, page, document):
    parser = ArticleImages()
    parser.feed(document)
    for fetch_url in dict.fromkeys(parser.images):
        url = canonical_url(fetch_url)
        # Prioritize explicitly sized single-card assets, without manufacturing another URL.
        dimensions = re.search(r"-thumb-(\d+)x(\d+)-", urlsplit(url).path)
        priority = 0 if dimensions and .67 < int(dimensions[1]) / int(dimensions[2]) < .77 else 1
        known = db.execute("SELECT 1 FROM photos WHERE url=?", (url,)).fetchone()
        failure = db.execute("SELECT error FROM failures WHERE url=?", (url,)).fetchone()
        status = "done" if known else "error" if failure else "pending"
        db.execute("""
            INSERT OR IGNORE INTO resource_jobs(url,fetch_url,page_url,priority,status,error,updated_at)
            VALUES (?,?,?,?,?,?,?)
        """, (url, fetch_url, page, priority, status, failure[0] if failure else None, time.time()))
        db.execute("INSERT OR IGNORE INTO resource_sources VALUES (?,?)", (url, page))
    db.execute("UPDATE source_jobs SET status='done',error=NULL WHERE url=?", (page,))
    db.commit()


def export_manifest(db, directory):
    rows = []
    for row in db.execute("SELECT * FROM resource_jobs ORDER BY priority,url"):
        value = dict(row)
        value["source_pages"] = [r[0] for r in db.execute(
            "SELECT page_url FROM resource_sources WHERE url=? ORDER BY page_url", (row["url"],))]
        rows.append(value)
    write_jsonl(directory / "download-list.jsonl", rows)
    return len(rows)


def plan(db, directory, cached_only=False):
    count, pages = manifest_references(db, directory / "wiki-card-references.jsonl")
    print(f"Prepared {count} archived card-image references; {pages} explicit official source pages.", flush=True)
    net = OfficialNetwork(db)
    state(db, "planner", "running")
    try:
        for row in db.execute("SELECT * FROM source_jobs ORDER BY priority DESC,url").fetchall():
            page = row["url"]
            cached = db.execute("SELECT html,status FROM pages WHERE url=?", (page,)).fetchone()
            if cached:
                if cached["status"] != "ok":
                    db.execute("UPDATE source_jobs SET status='error',error=? WHERE url=?", (cached["status"], page))
                    db.commit()
                    continue
                document = cached["html"]
            elif cached_only:
                continue
            else:
                try:
                    document = net.document(page)
                except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as exc:
                    error = f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
                    db.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?)", (page, time.time(), "", error))
                    db.execute("UPDATE source_jobs SET status='error',error=? WHERE url=?", (error, page))
                    db.commit()
                    print(f"Source retained for review: {error}", flush=True)
                    continue
                db.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,'ok')", (page, time.time(), document))
                db.commit()
            enqueue_page(db, page, document)
            print(f"Manifest: {export_manifest(db, directory)} published URLs; page {page}", flush=True)
        state(db, "planner", "cached" if cached_only else "complete")
    except BaseException as exc:
        if isinstance(exc, AccessBlocked):
            db.execute("INSERT OR REPLACE INTO state VALUES ('blocked',?)", (str(exc),))
        state(db, "planner", "stopped" if isinstance(exc, KeyboardInterrupt) else "error")
        raise
    finally:
        export_manifest(db, directory)


def role_live(db, role):
    row = db.execute("SELECT value FROM state WHERE key=?", (f"{role}_status",)).fetchone()
    if not row:
        return False
    value = json.loads(row[0])
    try:
        return (value["status"] == "running" and b"image_pipeline.py" in
                Path(f"/proc/{value['pid']}/cmdline").read_bytes())
    except (FileNotFoundError, PermissionError):
        return False


def download(db, directory, rate_limit=OFFICIAL_RATE, follow=False, max_images=0):
    """The only picture-download worker. No model, OCR pool, or environment file."""
    net, downloaded = OfficialNetwork(db), 0
    state(db, "downloader", "running")
    db.execute("UPDATE resource_jobs SET status='pending' WHERE status='downloading'")
    db.commit()
    current = None
    try:
        while not max_images or downloaded < max_images:
            if db.execute("SELECT 1 FROM state WHERE key='blocked'").fetchone():
                raise AccessBlocked("Source block is recorded; no automatic identity or URL changes.")
            current = db.execute("""
                SELECT * FROM resource_jobs WHERE status='pending' ORDER BY priority,rowid LIMIT 1
            """).fetchone()
            if not current:
                if follow and role_live(db, "planner"):
                    time.sleep(1)
                    continue
                break
            url = current["url"]
            db.execute("UPDATE resource_jobs SET status='downloading',attempts=attempts+1,updated_at=? WHERE url=?",
                       (time.time(), url))
            db.commit()
            started = time.monotonic()
            try:
                record = download_asset(net, current["fetch_url"], current["page_url"], directory,
                                        rate_limit=rate_limit)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as exc:
                error = f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
                db.execute("UPDATE resource_jobs SET status='error',error=?,updated_at=? WHERE url=?",
                           (error, time.time(), url))
                db.execute("INSERT OR REPLACE INTO failures VALUES (?,?,?)", (url, error, time.time()))
                db.commit()
                print(f"Download retained for review: {error}", flush=True)
                current = None
                continue
            elapsed = time.monotonic() - started
            db.execute("INSERT OR IGNORE INTO photos(url,page_url,record) VALUES (?,?,?)",
                       (url, current["page_url"], json.dumps(record, ensure_ascii=False)))
            db.execute("INSERT OR REPLACE INTO transfers VALUES (?,?,?,?,?)",
                       (url, time.time(), elapsed, record["bytes"], rate_limit))
            db.execute("UPDATE resource_jobs SET status='done',error=NULL,updated_at=? WHERE url=?",
                       (time.time(), url))
            db.commit()
            downloaded += 1
            print(f"Downloaded {downloaded}: {record['bytes']:,} bytes in {elapsed:.2f}s; "
                  f"{record['width']}×{record['height']}; OCR not awaited.", flush=True)
            current = None
        state(db, "downloader", "complete")
    except BaseException as exc:
        if isinstance(exc, AccessBlocked):
            db.execute("INSERT OR REPLACE INTO state VALUES ('blocked',?)", (str(exc),))
        if current:
            status = "blocked" if isinstance(exc, AccessBlocked) else "pending"
            db.execute("UPDATE resource_jobs SET status=?,updated_at=? WHERE url=?",
                       (status, time.time(), current["url"]))
        state(db, "downloader", "stopped" if isinstance(exc, KeyboardInterrupt) else "error")
        raise
    finally:
        export_manifest(db, directory)


def process(db, config, workers=2, follow=False):
    """Process only local files. The independent downloader can continue at full speed."""
    pipeline = OCRPipeline(db, config, workers)
    state(db, "processor", "running")
    completed = False
    visited, verified = set(), set()
    final_sweep = False
    try:
        while True:
            for row in db.execute("SELECT * FROM photos ORDER BY rowid").fetchall():
                if row["ocr"] and row["second_ocr"]:
                    continue
                revision = (row["url"], row["ocr"], row["second_ocr"])
                if revision in visited:
                    continue
                record = json.loads(row["record"])
                # Checking the digest also ensures the file was committed atomically before OCR.
                identity = (record["local_file"], record["sha256"])
                if identity not in verified:
                    if not Path(record["local_file"]).is_file() or sha256(Path(record["local_file"])) != record["sha256"]:
                        raise ValueError("Image cache changed; do not identify a different file.")
                    verified.add(identity)
                pipeline.submit(row["url"], record, row)
                visited.add(revision)
            pipeline.poll()
            if not follow:
                break
            if pipeline.paused:
                break
            if not (role_live(db, "downloader") or role_live(db, "planner")):
                # A producer may have committed its last photo after the SELECT above.
                if final_sweep:
                    break
                final_sweep = True
                continue
            time.sleep(1)
        pipeline.close()
        state(db, "processor", "paused" if pipeline.paused else "complete")
        completed = True
    except BaseException as exc:
        state(db, "processor", "stopped" if isinstance(exc, KeyboardInterrupt) else "error")
        raise
    finally:
        if not completed:
            pipeline.close(interrupted=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "download", "process", "status"])
    parser.add_argument("--cached-only", action="store_true")
    parser.add_argument("--follow", action="store_true", help="Wait while an independent producer is running.")
    parser.add_argument("--max-images", type=int, default=0, help="0 consumes the finite prepared manifest.")
    parser.add_argument("--ocr-workers", type=int, default=2)
    parser.add_argument("--rate-limit", type=int, default=OFFICIAL_RATE)
    parser.add_argument("--env", type=Path, default=DEFAULT_ENV)
    args = parser.parse_args()
    if not 1 <= args.ocr_workers <= 4 or not 1 <= args.rate_limit <= OFFICIAL_RATE or args.max_images < 0:
        raise SystemExit("Use 1–4 OCR workers, a positive rate ≤1 MB/s, and a nonnegative download limit.")
    with worker_lock(DIRECTORY, args.command):
        db = connect()
        try:
            if args.command == "plan":
                plan(db, DIRECTORY, args.cached_only)
            elif args.command == "download":
                download(db, DIRECTORY, args.rate_limit, args.follow, args.max_images)
            elif args.command == "process":
                process(db, settings(args.env), args.ocr_workers, args.follow)
            else:
                from watch_progress import snapshot
                print(json.dumps(snapshot(), ensure_ascii=False, indent=2))
        finally:
            db.close()


if __name__ == "__main__":
    main()
