"""Resolve Simplified scans from exact official sources declared by wiki File pages.

The 151 campaign's public JavaScript explicitly maps card numbers to image URLs.
This is not a name-based substitution, a wiki-CDN workaround, or a guessed URL range.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

from download_images import (
    ROOT, USER_AGENT, GAP, AccessBlocked, connect, download_asset, get_meta,
    set_meta, summary, sha256,
)

HOST = "special.pokemon.cn"
CAMPAIGN = "https://special.pokemon.cn/151/"
SCRIPT = ROOT / "sources/current-access/4.8470c2c8.chunk.js"


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, url):
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or parts.hostname != HOST or parts.username or parts.password:
            raise AccessBlocked("Official campaign redirected outside its approved origin.")
        return super().redirect_request(req, fp, code, msg, headers, url)


class CampaignNetwork:
    def __init__(self, db):
        self.db = db
        self.opener = urllib.request.build_opener(Redirect())
        self.rules = None

    def finished(self):
        set_meta(self.db, "last_request_finished", time.time())
        self.db.commit()

    def open(self, url, headers=None):
        parts = urllib.parse.urlsplit(url)
        if (parts.scheme != "https" or parts.hostname != HOST or parts.username or parts.password
                or parts.port not in (None, 443) or parts.query):
            raise ValueError("Unsupported origin or query.")
        time.sleep(max(0, GAP - (time.time() - get_meta(self.db, "last_request_finished", 0))))
        try:
            return self.opener.open(urllib.request.Request(
                url, headers={"User-Agent": USER_AGENT, **(headers or {})},
            ), timeout=35)
        except urllib.error.HTTPError as exc:
            self.finished()
            if exc.code in {401, 403}:
                raise AccessBlocked(f"HTTP {exc.code}; stopped without changing identity.") from exc
            raise

    def permitted(self, url):
        if self.rules is None:
            cache = get_meta(self.db, "special_robots")
            if not cache or time.time() - cache["at"] > 86400:
                try:
                    with self.open(f"https://{HOST}/robots.txt") as response:
                        text, status = response.read(256000).decode(), response.status
                except urllib.error.HTTPError as exc:
                    if exc.code not in {404, 410}:
                        raise
                    text, status = "", exc.code
                finally:
                    self.finished()
                cache = {"at": time.time(), "status": status, "text": text}
                set_meta(self.db, "special_robots", cache)
                self.db.commit()
            self.rules = urllib.robotparser.RobotFileParser()
            self.rules.parse(cache["text"].splitlines())
        if not self.rules.can_fetch(USER_AGENT, url):
            raise AccessBlocked("Official campaign robots.txt disallows the requested image.")


def campaign_images(script):
    """Require the recognized live site's number-to-URL mapping before expanding it."""
    if not all(token in script for token in [
        'Array.from({length:151})',
        '"https://special.pokemon.cn/151/img/big/151_".concat(e,".png")',
        'i.show_big=function(e)',
    ]):
        raise ValueError("Campaign script changed; inspect its image mapping before proceeding.")
    numbers = {f"{n:03}" for n in range(1, 152)}
    numbers.update(re.findall(r'\.show_big\("(\d{3})"\)', script))
    return {n: f"{CAMPAIGN}img/big/151_{n}.png" for n in numbers}


def prepare(db):
    script = SCRIPT.read_text()
    images = campaign_images(script)
    evidence = {"campaign": CAMPAIGN, "script": str(SCRIPT),
                "script_sha256": sha256(SCRIPT), "method": "published_campaign_number_mapping"}
    added = 0
    for row in db.execute("SELECT * FROM jobs WHERE active=1").fetchall():
        if CAMPAIGN not in (row["source_evidence"] or ""):
            continue
        uses = json.loads(row["uses_json"])
        numbers = {
            u["number"].split("/")[0].zfill(3)
            for u in uses if u.get("language") == "zh-Hans" and u.get("set_code") == "151C"
            and re.fullmatch(r"\d+/151", u.get("number") or "")
        }
        if len(numbers) != 1 or (number := next(iter(numbers))) not in images:
            continue
        source = f"{CAMPAIGN}#card-{number}"
        db.execute("INSERT OR REPLACE INTO resolutions VALUES (?,?,?,?)", (
            source, images[number], f"收集啦151 {number}/151", time.time(),
        ))
        if row["status"] != "done":
            db.execute("UPDATE jobs SET source_url=?,status='pending',error=NULL WHERE filename=?",
                       (source, row["filename"]))
        added += 1
    set_meta(db, "simplified_source_resolution", {**evidence, "resolved": added})
    db.commit()
    return added


def run(db, directory, limit):
    if not 1 <= limit <= 200:
        raise ValueError("Use one serial bounded batch of at most 200 images.")
    if get_meta(db, "blocked"):
        raise AccessBlocked("An access block is recorded; do not retry or change identity.")
    net = CampaignNetwork(db)
    rows = db.execute("""
        SELECT j.*,r.image_url FROM jobs j JOIN resolutions r ON j.source_url=r.page_url
        WHERE j.active=1 AND j.status='pending' AND j.source_url LIKE ?
        ORDER BY j.filename LIMIT ?
    """, (CAMPAIGN + "#card-%", limit)).fetchall()
    for row in rows:
        print(f"Downloading Simplified original: {row['filename']}", flush=True)
        try:
            cached = db.execute("SELECT record_json FROM assets WHERE url=?", (row["image_url"],)).fetchone()
            if cached:
                record = json.loads(cached[0])
                if sha256(Path(record["local_file"])) != record["sha256"]:
                    raise ValueError("Cached image changed.")
            else:
                record = {
                    **download_asset(net, row["image_url"], CAMPAIGN, directory),
                    "image_language": "zh-Hans",
                    "matching_evidence": get_meta(db, "simplified_source_resolution"),
                }
                db.execute("INSERT INTO assets VALUES (?,?)",
                           (row["image_url"], json.dumps(record, ensure_ascii=False)))
            db.execute("UPDATE jobs SET status='done',asset_url=?,attempts=attempts+1,error=NULL WHERE filename=?",
                       (row["image_url"], row["filename"]))
            print(f"Saved {record['width']}x{record['height']}, {record['bytes']} bytes", flush=True)
        except AccessBlocked as exc:
            set_meta(db, "blocked", {"source": row["image_url"], "error": str(exc), "at": time.time()})
            db.execute("UPDATE jobs SET status='blocked',error=? WHERE filename=?", (str(exc), row["filename"]))
            db.commit()
            raise
        except Exception as exc:
            status = "missing_source" if isinstance(exc, urllib.error.HTTPError) and exc.code in {404, 410} else "error"
            db.execute("UPDATE jobs SET status=?,error=?,attempts=attempts+1 WHERE filename=?",
                       (status, f"{type(exc).__name__}: {exc}", row["filename"]))
            print(f"Not downloaded: {exc}", flush=True)
        db.commit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run", "status"])
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--directory", type=Path, default=ROOT / "images-zh-hans")
    args = parser.parse_args()
    args.directory.mkdir(exist_ok=True, parents=True)
    with (args.directory / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = connect(args.directory)
        try:
            if args.command == "prepare":
                print(f"Resolved exact campaign printings: {prepare(db)}")
            elif args.command == "run":
                run(db, args.directory, args.limit)
        finally:
            print(json.dumps(summary(db, args.directory), ensure_ascii=False, indent=2), flush=True)
            db.close()


if __name__ == "__main__":
    main()
