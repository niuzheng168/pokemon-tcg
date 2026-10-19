"""Download exact card-file sources declared by 52Poké, without bypassing its CDN."""
from __future__ import annotations

import argparse
import collections
import fcntl
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sqlite3
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

import mwparserfromhell as mw
from PIL import Image

from import_cards import ROOT, iterate_pages, template_name
from card_storage import publish_download, register_manifest_collisions

USER_AGENT = "PokemonCardStudy/1.0 (noncommercial local card-image archiving)"
OFFICIAL_HOST = "asia.pokemon-card.com"
RATE = 250_000  # Below 1 MB/s and, even continuously, below 1 GB/hour.
GAP = 0.75
MAX_IMAGE_BYTES = 25_000_000
SOURCE_PATH = re.compile(r"^/([a-z]{2})/card-search/detail/([0-9]+)/?$")
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}


class AccessBlocked(RuntimeError):
    pass


def dump_json(path: Path, value):
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def sha256(path: Path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical_filename(value: str):
    value = re.sub(r"<!--.*?-->", "", value, flags=re.S).strip()
    value = re.sub(r"^(?:File|Image|文件|檔案|图像|圖像):", "", value, flags=re.I)
    value = unicodedata.normalize("NFC", value.replace("_", " "))
    if not value or any(c in value for c in ("/", "\\", "\x00", "{", "}", "[", "]")):
        return None
    if Path(value).suffix.lower() not in EXTENSIONS:
        return None
    return value[0].upper() + value[1:]


def official_page(value: str):
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST
            or parsed.username or parsed.password or port not in (None, 443)
            or parsed.query or not SOURCE_PATH.fullmatch(parsed.path)):
        return None
    return urllib.parse.urlunsplit(("https", OFFICIAL_HOST, parsed.path.rstrip("/") + "/", "", ""))


def declared_sources(text: str):
    """Only explicit 来源 templates, not arbitrary links or name-search guesses."""
    urls = set()
    for template in mw.parse(text).filter_templates(recursive=True):
        if template_name(str(template.name)) not in {"来源", "來源", "source"}:
            continue
        for param in template.params:
            for link in mw.parse(str(param.value)).filter_external_links():
                if url := official_page(str(link.url).strip()):
                    urls.add(url)
    return sorted(urls)


class CardImageParser(HTMLParser):
    def __init__(self, page_url):
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.region = SOURCE_PATH.fullmatch(urllib.parse.urlsplit(page_url).path)[1]
        self.images = set()
        self.title = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag != "img" or not values.get("src"):
            return
        url = urllib.parse.urljoin(self.page_url, html.unescape(values["src"]))
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme == "https" and parsed.hostname == OFFICIAL_HOST
                and not parsed.username and not parsed.password
                and parsed.port in (None, 443)
                and re.fullmatch(
                    "/" + re.escape(self.region) + r"/card-img/[^/]+\.(?:png|jpe?g|webp)",
                    parsed.path, re.I)):
            self.images.add(url)

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)


def resolve_card_image(page_url, document):
    if not official_page(page_url):
        raise ValueError("Not a supported, exact official card-detail page.")
    parser = CardImageParser(page_url)
    parser.feed(document)
    if len(parser.images) != 1:
        raise ValueError(f"Expected exactly one card image, found {len(parser.images)}; refusing to guess.")
    return next(iter(parser.images)), "".join(parser.title).strip()


def connect(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(directory / "queue.sqlite")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS jobs(
            filename TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1,
            file_page_id INTEGER, file_revision_id INTEGER, uses_json TEXT NOT NULL,
            source_url TEXT, source_evidence TEXT, status TEXT NOT NULL,
            asset_url TEXT, attempts INTEGER NOT NULL DEFAULT 0,
            error TEXT, next_retry REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS assets(
            url TEXT PRIMARY KEY, record_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resolutions(
            page_url TEXT PRIMARY KEY, image_url TEXT NOT NULL, title TEXT, resolved_at REAL
        );
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS file_verifications(filename TEXT PRIMARY KEY,evidence TEXT NOT NULL);
    """)
    return db


def set_meta(db, key, value):
    db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))


def get_meta(db, key, default=None):
    row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def library_targets(db, library):
    """Know queue-wide collisions before the first identified publication."""
    game = get_meta(db, "plan", {}).get("game", "tcg")
    targets = {
        row["filename"]: {
            "wiki_filename": row["filename"],
            "uses": [{**use, "game": use.get("game", game)} for use in json.loads(row["uses_json"])],
        }
        for row in db.execute("SELECT filename,uses_json FROM jobs WHERE active=1")
    }
    register_manifest_collisions(library, targets.values())
    return targets


def card_image_uses(card, language):
    """Language-filtered images must come from explicit printing rows, never a header fallback."""
    if language == "zh":
        simplified, missing_simplified = card_image_uses(card, "zh-Hans")
        traditional, missing_traditional = card_image_uses(card, "zh-Hant")
        return simplified + traditional, missing_simplified + missing_traditional
    identity = {
        "page_id": card["page_id"], "title": card["title"],
        "revision_id": card["revision_id"],
    }
    if language == "all":
        return [
            (image.get("file_name", ""), {
                **identity, "parameter": image["parameter"],
                "template_index": image["source_template_index"], "language": "unspecified",
            })
            for image in card["images"]
        ], 0
    prefix = {"zh-Hans": "cn", "zh-Hant": "zh", "ja": "ja", "en": "en"}[language]
    uses, missing = [], 0
    for printing in card["printings"]:
        if printing["language"] != language:
            continue
        # A bare `img=n` continuation row is not an independent identified printing.
        if not any(printing.get(key) for key in ("set_name", "set_code", "number")):
            continue
        image = printing.get("image") or {}
        name = image.get("file_name")
        if not name:
            missing += 1
            continue
        uses.append((name, {
            **identity, "parameter": prefix + "img",
            "template_index": printing["source_template_index"], "language": language,
            "set_code": printing.get("set_code"), "set_name": printing.get("set_name"),
            "number": printing.get("number"),
        }))
    return uses, missing


def source_matches_language(url, language):
    # This resolver currently supports Asia card-search only. /tw and /hk are NOT Simplified Chinese.
    if not official_page(url):
        return False
    if language == "all":
        return True
    region = SOURCE_PATH.fullmatch(urllib.parse.urlsplit(url).path)[1]
    return language in {"zh-Hant", "zh"} and region in {"tw", "hk"}


def completed_binding_reusable(existing, asset, evidence, refs, language):
    if (not existing or existing["status"] != "done" or not existing["asset_url"] or not asset
            or not evidence.get("page_id") or not evidence.get("revision_id")
            or existing["file_page_id"] != evidence["page_id"]
            or existing["file_revision_id"] != evidence["revision_id"]
            or existing["source_evidence"] != evidence.get("evidence")):
        return False
    image_language = asset.get("image_language")
    origin = urllib.parse.urlsplit(asset.get("official_page_url") or existing["source_url"] or "")
    if not image_language and origin.hostname == OFFICIAL_HOST and origin.path.startswith(("/tw/", "/hk/")):
        image_language = "zh-Hant"
    allowed = {"zh-Hans", "zh-Hant"} if language == "zh" else {language}
    if language != "all" and image_language not in allowed:
        return False
    old_pages = {use["page_id"] for use in json.loads(existing["uses_json"])}
    return {use["page_id"] for use in refs} <= old_pages


def prepare(db, cards_database: Path, archive: Path, game: str, language="all"):
    source = sqlite3.connect(cards_database)
    source.row_factory = sqlite3.Row
    expected = source.execute("SELECT value FROM metadata WHERE key='archive_sha256'").fetchone()
    fingerprint = sha256(archive)
    if not expected or json.loads(expected[0]) != fingerprint:
        source.close()
        raise ValueError("The XML archive does not match the card database's archive checksum.")
    release_row = source.execute("SELECT value FROM metadata WHERE key='archive_release'").fetchone()
    release = json.loads(release_row[0]) if release_row else None
    old_plan = get_meta(db, "plan", {})
    if old_plan.get("archive_sha256") and old_plan["archive_sha256"] != fingerprint:
        source.close()
        raise ValueError("Existing queue belongs to another archive. Use a new cache directory or an explicit migration.")
    same_archive = old_plan.get("archive_sha256") == fingerprint
    uses = collections.defaultdict(list)
    eligible_pages = set()
    skipped = 0
    missing_language_images = 0
    for row in source.execute("SELECT record_json FROM extracts WHERE status='card'"):
        card = json.loads(row[0])
        if game != "all" and game not in card["games"]:
            continue
        eligible_pages.add(card["page_id"])
        references, missing = card_image_uses(card, language)
        missing_language_images += missing
        for file_name, reference in references:
            filename = canonical_filename(file_name)
            if not filename:
                skipped += 1
                continue
            uses[filename].append(reference)
    redirects = {}
    for row in source.execute("SELECT title,redirect FROM pages WHERE namespace=6 AND redirect IS NOT NULL"):
        original, target = canonical_filename(row["title"]), canonical_filename(row["redirect"])
        if original and target:
            redirects[original] = target
    source.close()
    canonical_uses = collections.defaultdict(list)
    for original, refs in uses.items():
        target, seen = original, set()
        while target in redirects and target not in seen:
            seen.add(target)
            target = redirects[target]
        canonical_uses[target].extend([{**ref, "referenced_filename": original} for ref in refs])
    extras = {}
    allowed = {"zh-Hans", "zh-Hant"} if language == "zh" else {language}
    if same_archive:
        for old in db.execute("SELECT * FROM jobs WHERE active=1"):
            refs = json.loads(old["uses_json"])
            if (old["filename"] not in canonical_uses and refs
                    and all(u["page_id"] in eligible_pages for u in refs)
                    and all(language == "all" or u.get("language") in allowed for u in refs)
                    and any(u.get("supplementary_basic_energy_header") or u.get("recovered_existing_File_for_printing") for u in refs)):
                extras[old["filename"]] = old
    target_names = set(canonical_uses) | set(extras)
    sources = {}
    for page in iterate_pages(archive):
        if page["namespace"] != 6:
            continue
        name = canonical_filename(page["title"])
        if name not in target_names:
            continue
        refs = canonical_uses.get(name) or json.loads(extras[name]["uses_json"])
        sources[name] = {
            "page_id": page["page_id"], "revision_id": page["revision_id"],
            "urls": [url for url in declared_sources(page["wikitext"])
                     if (
                         any(source_matches_language(url, ref["language"])
                             for ref in refs)
                         if language == "zh" else source_matches_language(url, language)
                     )],
            "evidence": page["wikitext"],
        }
    # Validate every retained completed file before mutating the live queue.
    retained, verified = {}, set()
    if same_archive:
        for name in target_names:
            existing = db.execute("SELECT * FROM jobs WHERE filename=?", (name,)).fetchone()
            if not existing or not existing["asset_url"]:
                continue
            old_asset = db.execute("SELECT record_json FROM assets WHERE url=?", (existing["asset_url"],)).fetchone()
            asset = json.loads(old_asset[0]) if old_asset else None
            refs = canonical_uses.get(name) or json.loads(extras[name]["uses_json"])
            if completed_binding_reusable(existing, asset, sources.get(name, {}), refs, language):
                if asset["sha256"] not in verified:
                    path = Path(asset["local_file"])
                    if not path.is_file() or sha256(path) != asset["sha256"]:
                        raise ValueError("Completed cache missing/corrupt; preparation did not reset it or redownload it.")
                    verified.add(asset["sha256"])
                retained[name] = existing
    db.execute("UPDATE jobs SET active=0")
    for name, refs in sorted(canonical_uses.items()):
        evidence = sources.get(name, {})
        urls = evidence.get("urls", [])
        url = urls[0] if len(urls) == 1 else None
        reason = None if url else (
            "Multiple declared official sources; manual review required."
            if len(urls) > 1 else "No supported official source of the requested language explicitly declared in the archived File page."
        )
        existing = db.execute("SELECT * FROM jobs WHERE filename=?", (name,)).fetchone()
        keep = name in retained
        same_source = existing and existing["source_url"] == url and (existing["status"] != "done" or keep)
        if keep:
            url = existing["source_url"]
            same_source = True
        status = existing["status"] if same_source else ("pending" if url else "unresolved")
        db.execute("""
            INSERT OR REPLACE INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            name, 1, evidence.get("page_id"), evidence.get("revision_id"),
            json.dumps(refs, ensure_ascii=False), url, evidence.get("evidence"), status,
            existing["asset_url"] if same_source else None,
            existing["attempts"] if same_source else 0,
            None if keep else existing["error"] if same_source and existing["error"] else reason,
            existing["next_retry"] if same_source else 0,
        ))
    extra_names = []
    for name, existing in extras.items():
        evidence = sources.get(name, {})
        if (existing["file_page_id"] != evidence.get("page_id")
                or existing["file_revision_id"] != evidence.get("revision_id")):
            continue
        if existing["status"] == "done" and name not in retained:
            db.execute("UPDATE jobs SET active=1,status='unresolved',asset_url=NULL,error=? WHERE filename=?",
                       ("Retained target reference; completed asset no longer satisfies the requested image language.", name))
        else:
            db.execute("UPDATE jobs SET active=1 WHERE filename=?", (name,))
        extra_names.append(name)
    plan = {
        "game": game, "language": language, "wiki_image_references": len(uses) + len(extra_names),
        "standard_printing_image_references": len(uses), "supplemental_reference_count": len(extra_names),
        "printing_rows_missing_explicit_language_image": missing_language_images,
        "language_fallback": False,
        "metadata_language": "zh-Hans",
        "image_languages": ["zh-Hans", "zh-Hant"] if language == "zh" else [language],
        "language_note": "Image language is independent of display metadata; never relabel traditional images as simplified.",
        "unique_after_file_redirects": len(canonical_uses) + len(extra_names),
        "skipped_unresolved_or_non_image_fields": skipped,
        "cards_database": str(cards_database.resolve()), "archive": str(archive.resolve()),
        "archive_release": release, "archive_sha256": fingerprint,
        "wiki_direct": "Disabled: stored Cloudflare 403 diagnostics; no identity/IP workaround.",
        "matching": "Only explicit archived File-page source links; no card-name matching.",
    }
    for key in ("supplementary_basic_energy_headers", "recovered_existing_printing_files"):
        if extra_names and key in old_plan:
            plan[key] = old_plan[key]
    set_meta(db, "plan", plan)
    db.commit()


def verify_image(path: Path):
    with Image.open(path) as image:
        width, height = image.size
        fmt = image.format
        image.verify()
    if fmt not in {"PNG", "JPEG", "WEBP", "GIF", "AVIF"}:
        raise ValueError(f"Unexpected image format {fmt}")
    return {
        "bytes": path.stat().st_size, "sha256": sha256(path),
        "width": width, "height": height, "format": fmt,
    }


def seed_verified_sample(db):
    if get_meta(db, "plan", {}).get("language", "all") not in {"all", "zh", "zh-Hant"}:
        return
    path = ROOT / "sources/image-fallback-success.json"
    if not path.exists():
        return
    record = json.loads(path.read_text())
    sample = Path(record["local_file"]).resolve()
    # Keep the SQLite parent local while explicitly linked image subtrees live
    # on NAS. Do not accept unrelated files merely because they are external.
    roots = [(ROOT / name).resolve() for name in ("images", "images/files", "images/samples")]
    if not any(sample.is_relative_to(root) for root in roots) or not sample.is_file():
        return
    if sha256(sample) != record["sha256"]:
        raise ValueError("Previously downloaded sample checksum mismatch.")
    url = record["official_image_url"]
    db.execute("INSERT OR IGNORE INTO assets VALUES (?,?)", (url, json.dumps(record, ensure_ascii=False)))
    db.execute("INSERT OR IGNORE INTO resolutions VALUES (?,?,?,?)", (
        record["official_page_url"], url, "Previously verified exact official source", sample.stat().st_mtime,
    ))
    db.execute("""
        UPDATE jobs SET status='done',asset_url=?,error=NULL
        WHERE filename=? AND source_url=?
    """, (url, record["wiki_file_name"], record["official_page_url"]))
    db.commit()


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if (parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST
                or parsed.username or parsed.password or parsed.port not in (None, 443)):
            raise AccessBlocked("Redirect outside the supported official origin; stopped.")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


class Network:
    def __init__(self, db):
        self.db = db
        self.opener = urllib.request.build_opener(SafeRedirect())
        self.robots = None

    def open(self, url, headers=None):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST
                or parsed.username or parsed.password or parsed.port not in (None, 443)):
            raise AccessBlocked("Unsupported origin.")
        delay = GAP - (time.time() - get_meta(self.db, "last_request_finished", 0))
        if delay > 0:
            time.sleep(delay)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            response = self.opener.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            self.finished()
            if error.code in (401, 403):
                raise AccessBlocked(f"HTTP {error.code}; stopped, no header/identity/proxy cycling.") from error
            raise
        except Exception:
            self.finished()
            raise
        return response

    def finished(self):
        set_meta(self.db, "last_request_finished", time.time())
        self.db.commit()

    def permitted(self, url):
        if self.robots is None:
            cached = get_meta(self.db, "robots_cache")
            if not cached:
                seed = ROOT / "sources/official-asia-robots.json"
                text_file = ROOT / "sources/official-asia-robots.txt"
                if seed.exists() and text_file.exists():
                    info = json.loads(seed.read_text())
                    if info.get("status") == 200:
                        cached = {"at": info["fetched_at_epoch"], "text": text_file.read_text()}
            if not cached or time.time() - cached["at"] >= 86400:
                try:
                    with self.open(f"https://{OFFICIAL_HOST}/robots.txt") as response:
                        text = response.read(256_000).decode("utf-8", errors="replace")
                except urllib.error.HTTPError as error:
                    if error.code not in (404, 410):
                        raise
                    text = ""
                finally:
                    self.finished()
                cached = {"at": time.time(), "text": text}
            self.robots = urllib.robotparser.RobotFileParser()
            self.robots.parse(cached["text"].splitlines())
            set_meta(self.db, "robots_cache", cached)
            self.db.commit()
        if not self.robots.can_fetch(USER_AGENT, url):
            raise AccessBlocked("Disallowed by the official source's robots.txt.")
        crawl_delay = self.robots.crawl_delay(USER_AGENT) or 0
        delay = crawl_delay - (time.time() - get_meta(self.db, "last_request_finished", 0))
        if delay > 0:
            time.sleep(delay)

    def document(self, url):
        self.permitted(url)
        try:
            with self.open(url) as response:
                data = response.read(2_000_001)
                if len(data) > 2_000_000:
                    raise ValueError("Official card page unexpectedly large.")
                return data.decode("utf-8")
        finally:
            self.finished()


def download_asset(net, url, referer, directory, *, rate_limit=RATE):
    if not isinstance(rate_limit, (int, float)) or rate_limit <= 0:
        raise ValueError("A positive per-source byte rate is required.")
    key = hashlib.sha256(url.encode()).hexdigest()
    extension = Path(urllib.parse.urlsplit(url).path).suffix.lower()
    destination = directory / "files" / key[:2] / (key + extension)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    checkpoint = destination.with_suffix(destination.suffix + ".resume.json")
    receipt = destination.with_suffix(destination.suffix + ".download.json")
    if receipt.exists():
        record = json.loads(receipt.read_text())
        candidate = destination if destination.exists() else partial
        if candidate.is_file() and record.get("official_image_url") == url and sha256(candidate) == record["sha256"]:
            if candidate != destination:
                candidate.replace(destination)
            checkpoint.unlink(missing_ok=True)
            return record
        raise ValueError("Local receipt/image mismatch; refusing silent re-download.")
    if destination.exists():
        raise ValueError("Local image exists without a receipt; inspect it before re-downloading.")
    net.permitted(url)
    headers = {"Referer": referer}
    offset = 0
    if partial.exists() and checkpoint.exists():
        resume = json.loads(checkpoint.read_text())
        validator = resume.get("etag") or resume.get("last_modified")
        if validator:
            offset = partial.stat().st_size
            headers.update({"Range": f"bytes={offset}-", "If-Range": validator})
    received = 0
    try:
        with net.open(url, headers) as response:
            content_type = response.headers.get("Content-Type", "")
            if not content_type.startswith("image/"):
                raise ValueError(f"Not an image response: {content_type}")
            if response.status == 206:
                if not offset or not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                    raise ValueError("Invalid partial-content response.")
            elif response.status == 200:
                offset = 0
            else:
                raise ValueError(f"Unexpected image status {response.status}")
            length = response.headers.get("Content-Length")
            if length and int(length) + offset > MAX_IMAGE_BYTES:
                raise ValueError("Image exceeds per-file size limit.")
            dump_json(checkpoint, {
                "url": url, "etag": response.headers.get("ETag"),
                "last_modified": response.headers.get("Last-Modified"),
            })
            started = time.monotonic()
            with partial.open("ab" if offset else "wb") as output:
                while chunk := response.read(32 * 1024):
                    received += len(chunk)
                    if offset + received > MAX_IMAGE_BYTES:
                        raise ValueError("Image exceeds per-file size limit.")
                    output.write(chunk)
                    time.sleep(max(0, received / rate_limit - (time.monotonic() - started)))
            if length and received != int(length):
                raise ValueError("Truncated image body.")
        info = verify_image(partial)
        record = {
            **info, "local_file": str(destination.resolve()),
            "source": "official_source_declared_by_wiki",
            "official_image_url": url, "official_page_url": referer,
            "downloaded_at_epoch": time.time(), "byte_identical_to_wiki_copy": None,
        }
        dump_json(receipt, record)
        partial.replace(destination)
        checkpoint.unlink(missing_ok=True)
        return record
    finally:
        net.finished()


def summary(db, directory):
    counts = dict(db.execute("SELECT status,count(*) FROM jobs WHERE active=1 GROUP BY status").fetchall())
    items, total_bytes, urls = [], 0, set()
    with (directory / "manifest.jsonl.part").open("w") as output:
        for row in db.execute("""
            SELECT j.*,a.record_json FROM jobs j LEFT JOIN assets a ON j.asset_url=a.url
            WHERE j.active=1 ORDER BY j.filename
        """):
            asset = json.loads(row["record_json"]) if row["record_json"] else None
            record = {
                "wiki_filename": row["filename"], "file_page_id": row["file_page_id"],
                "file_revision_id": row["file_revision_id"], "status": row["status"],
                "wiki_file_page_url": "https://wiki.52poke.com/wiki/File:" + urllib.parse.quote(row["filename"].replace(" ", "_")),
                "official_source_page": row["source_url"], "error": row["error"],
                "uses": json.loads(row["uses_json"]), "asset": asset,
            }
            output.write(json.dumps(record, ensure_ascii=False) + "\n")
            if asset and row["asset_url"] not in urls:
                total_bytes += asset["bytes"]
                urls.add(row["asset_url"])
                items.append(asset["local_file"])
    (directory / "manifest.jsonl.part").replace(directory / "manifest.jsonl")
    result = {
        "plan": get_meta(db, "plan"), "counts": counts, "unique_downloaded_assets": len(urls),
        "downloaded_bytes": total_bytes, "sample_local_files": items[:5],
        "blocked": get_meta(db, "blocked"), "rate_bytes_per_second": get_meta(db, "active_rate_limit", RATE),
        "note": "Wiki CDN 403 is not bypassed. Official-source images may differ in bytes from the wiki copy.",
    }
    dump_json(directory / "status.json", result)
    return result


def off_peak(now=None):
    now = now or datetime.now(ZoneInfo("Asia/Hong_Kong"))
    local = now.astimezone(ZoneInfo("Asia/Hong_Kong"))
    return 2 <= local.hour < 8


def retry_delay(error):
    delay = 60
    if isinstance(error, urllib.error.HTTPError) and error.code == 429:
        value = (error.headers or {}).get("Retry-After", "").strip()
        if value.isdigit():
            delay = max(delay, int(value))
        elif value:
            try:
                delay = max(delay, parsedate_to_datetime(value).timestamp() - time.time())
            except (ValueError, TypeError, OverflowError):
                delay = 3600
        else:
            delay = 3600
    return delay


def run(db, directory, limit, only, *, rate_limit=RATE, library=None):
    if limit < 1:
        raise ValueError("--limit must be positive; use an explicit bounded batch.")
    # Each image may require its source page and image (plus robots).
    if limit * 2 + 1 > 500 and not off_peak():
        raise ValueError("Bulk runs are restricted to 02:00–08:00 Asia/Hong_Kong.")
    if get_meta(db, "blocked"):
        raise AccessBlocked("Previous access block recorded; resolve it with the source operator before retrying.")
    if not isinstance(rate_limit, (int, float)) or rate_limit <= 0:
        raise ValueError("A positive official-source byte rate is required.")
    set_meta(db, "active_rate_limit", rate_limit)
    db.commit()
    clauses = ["active=1", "status IN ('pending','error')", "attempts<3", "source_url IS NOT NULL", "next_retry<=?"]
    params = [time.time()]
    if only:
        clauses.append("filename=?")
        params.append(canonical_filename(only))
    rows = db.execute("SELECT * FROM jobs WHERE " + " AND ".join(clauses) + " ORDER BY filename LIMIT ?", [*params, limit]).fetchall()
    targets = library_targets(db, library) if library else {}
    net = Network(db)
    page_cache = {}
    failures = 0
    for row in rows:
        if limit * 2 + 1 > 500 and not off_peak():
            print("Off-peak window ended; remaining jobs preserved.", flush=True)
            break
        print(f"Fetching declared source: {row['filename']}", flush=True)
        try:
            page = row["source_url"]
            if page not in page_cache:
                known = db.execute("SELECT * FROM resolutions WHERE page_url=?", (page,)).fetchone()
                if known and time.time() - known["resolved_at"] < 86400:
                    page_cache[page] = (known["image_url"], known["title"])
                else:
                    page_cache[page] = resolve_card_image(page, net.document(page))
                    db.execute("INSERT OR REPLACE INTO resolutions VALUES (?,?,?,?)", (
                        page, *page_cache[page], time.time(),
                    ))
            url, page_title = page_cache[page]
            cached = db.execute("SELECT record_json FROM assets WHERE url=?", (url,)).fetchone()
            if cached:
                asset = json.loads(cached[0])
                path = Path(asset["local_file"])
                if not path.is_file() or sha256(path) != asset["sha256"]:
                    raise ValueError("Cached image missing/corrupt; not silently downloading it again.")
            else:
                asset = {**download_asset(net, url, page, directory, rate_limit=rate_limit), "official_page_title": page_title}
                db.execute("INSERT INTO assets VALUES (?,?)", (url, json.dumps(asset, ensure_ascii=False)))
            db.execute("UPDATE jobs SET status='done',asset_url=?,error=NULL,attempts=attempts+1 WHERE filename=?", (url, row["filename"]))
            print(f"Saved {asset['width']}x{asset['height']}, {asset['bytes']:,} bytes", flush=True)
        except AccessBlocked as error:
            set_meta(db, "blocked", {"source": row["source_url"], "error": str(error), "at": time.time()})
            db.execute("UPDATE jobs SET status='blocked',error=?,attempts=attempts+1 WHERE filename=?", (str(error), row["filename"]))
            db.commit()
            raise
        except Exception as error:
            failures += 1
            delay = retry_delay(error)
            permanent = isinstance(error, urllib.error.HTTPError) and error.code in (404, 410)
            db.execute("""
                UPDATE jobs SET status=?,error=?,attempts=attempts+1,next_retry=? WHERE filename=?
            """, ("missing_source" if permanent else "error", f"{type(error).__name__}: {error}", time.time() + delay, row["filename"]))
            print(f"Retained for review/retry: {error}", flush=True)
        db.commit()
        if library and db.execute("SELECT status FROM jobs WHERE filename=?", (row["filename"],)).fetchone()[0] == "done":
            # Persist download success before publication. A NAS/publication
            # failure must not turn verified bytes into another network job.
            image_asset = dict(asset)
            if not image_asset.get("image_language") and source_matches_language(page, "zh-Hant"):
                image_asset["image_language"] = "zh-Hant"
            publish_download(library, targets[row["filename"]], image_asset)
    if failures:
        raise RuntimeError(f"{failures} download(s) did not complete; retry state was retained.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "images",
                        help="Image cache; display metadata language is configured separately.")
    parser.add_argument("--library", type=Path, default=ROOT / "library",
                        help="Identified cards: printing-language/set/full_number/. Raw cache remains resumable.")
    sub = parser.add_subparsers(dest="command", required=True)
    prepare_args = sub.add_parser("prepare")
    prepare_args.add_argument("--database", type=Path, required=True)
    prepare_args.add_argument("--archive", type=Path, required=True)
    prepare_args.add_argument("--game", choices=("tcg", "pocket", "all"), default="tcg")
    prepare_args.add_argument("--language", choices=("zh", "zh-Hans", "zh-Hant", "ja", "en", "all"),
                              default="zh",
                              help="Image language only; zh accepts Simplified/Traditional with their original labels.")
    run_args = sub.add_parser("run")
    run_args.add_argument("--limit", type=int, default=5)
    run_args.add_argument("--only")
    sub.add_parser("status")
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    with (args.directory / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another image job holds the lock; parallel downloads are disabled.")
        db = connect(args.directory)
        failure = None
        try:
            if args.command == "prepare":
                prepare(db, args.database, args.archive, args.game, args.language)
                seed_verified_sample(db)
            elif args.command == "run":
                run(db, args.directory, args.limit, args.only, library=args.library)
        except Exception as error:
            failure = error
        finally:
            result = summary(db, args.directory)
            db.close()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if failure:
            raise SystemExit(str(failure))


if __name__ == "__main__":
    main()
