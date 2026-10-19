"""Portable, serialized downloader for an explicitly supplied 52Poké manifest.

No credentials, proxies, browser identity, URL discovery, OCR or model calls.
Use only with permission to access the source from the intended environment.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import zipfile

ROOT = Path(__file__).resolve().parent
USER_AGENT = "PokemonCardStudy/1.0 (noncommercial local card-image archiving)"
TZ = timezone(timedelta(hours=8))
GAP = 500  # Seconds, not milliseconds: conservative archived Wiki robots rule.
RATE = 250_000
HOUR_BYTES = 1_000_000_000
MAX_IMAGE_BYTES = 25_000_000
ROBOTS_URLS = (
    "https://wiki.52poke.com/robots.txt",
    "https://media.52poke.com/robots.txt",
)


class StopDownload(RuntimeError):
    """A condition requiring waiting, source permission or human inspection."""


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def read_json(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def load_manifest(path):
    value = read_json(path)
    if not value or value.get("schema_version") != 1 or not isinstance(value.get("targets"), list):
        raise ValueError("Unsupported or missing manifest.")
    seen = set()
    for target in value["targets"]:
        name = target["wiki_filename"]
        if not isinstance(name, str) or name in seen or re.search(r"[/\\\x00]", name):
            raise ValueError("Invalid or duplicate Wiki filename.")
        seen.add(name)
        info = target.get("latest_file_metadata")
        if not info:
            continue
        url = urllib.parse.urlsplit(info["url"])
        if (url.scheme != "https" or url.netloc != "media.52poke.com"
                or url.query or url.fragment or not url.path.startswith("/wiki/")
                or "/archive/" in url.path or "/thumb/" in url.path
                or urllib.parse.unquote(url.path.rsplit("/", 1)[-1]).replace("_", " ")
                != name.replace("_", " ")
                or not re.fullmatch(r"[0-9a-f]{40}", info["sha1"])
                or type(info["size"]) is not int or not 0 < info["size"] <= MAX_IMAGE_BYTES
                or any(type(info.get(k)) is not int or info[k] <= 0 for k in ("width", "height"))):
            raise ValueError(f"Unsafe or incomplete original-image metadata: {name}")
    return value


def ready_targets(manifest):
    return [target for target in manifest["targets"] if target.get("latest_file_metadata")]


def image_path(output, target):
    info = target["latest_file_metadata"]
    suffix = Path(target["wiki_filename"]).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        raise ValueError("Unsupported image filename.")
    return output / "files" / (info["sha1"] + suffix)


def verify_image(path, info):
    from PIL import Image

    h1, h256 = hashlib.sha1(), hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(65536):
            size += len(chunk)
            h1.update(chunk)
            h256.update(chunk)
    if size != info["size"] or h1.hexdigest() != info["sha1"]:
        raise ValueError(f"Image size/SHA-1 mismatch: {path.name}")
    with Image.open(path) as image:
        if image.size != (info["width"], info["height"]):
            raise ValueError(f"Image dimensions mismatch: {path.name}")
        image.verify()
    with Image.open(path) as image:
        image.load()
    return {"sha1": h1.hexdigest(), "sha256": h256.hexdigest(), "bytes": size}


@contextmanager
def output_lock(output):
    """OS locks are released after a crash, including on Windows."""
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".download.lock").open("a+b") as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise StopDownload("Another process holds this output directory.") from error
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_UN)


def off_peak(now):
    return 2 <= datetime.fromtimestamp(now, TZ).hour < 8


def next_window(now):
    local = datetime.fromtimestamp(now, TZ)
    start = local.replace(hour=2, minute=0, second=0, microsecond=0)
    if local.hour >= 8:
        start += timedelta(days=1)
    return start.timestamp()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise StopDownload("Unexpected redirect; stopped without following it.")


class Network:
    def __init__(self, output, wait=False, opener=None, clock=time.time, sleep=time.sleep):
        self.path = output / "state.json"
        self.state = read_json(self.path, {"last_finished": 0, "robots": {}, "transfers": []})
        self.wait, self.clock, self.sleep = wait, clock, sleep
        # Do not inherit HTTP(S)_PROXY: changing routes to evade a block is not supported.
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        if self.state.pop("in_flight", False):
            self.state["last_finished"] = clock()  # Crash: start a new conservative gap.
            self.save()

    def save(self):
        atomic_json(self.path, self.state)

    def before_request(self, reserve, needs_policy=False):
        if self.state.get("access_block"):
            raise StopDownload("An access block is recorded in state.json. Contact the source operator; do not change identity/IP to retry.")
        while True:
            now = self.clock()
            self.state["transfers"] = [t for t in self.state["transfers"] if t["at"] > now - 3600]
            gap = max([GAP, *[r.get("delay", 0) for r in self.state["robots"].values()]])
            due = max(now, self.state.get("last_finished", 0) + gap,
                      self.state.get("retry_after", 0))
            if not off_peak(due):
                due = max(due, next_window(due))
            if sum(t["bytes"] for t in self.state["transfers"]) + reserve > HOUR_BYTES:
                due = max(due, min(t["at"] for t in self.state["transfers"]) + 3601)
            if due <= now:
                if needs_policy and any(
                    url not in self.state["robots"]
                    or now - self.state["robots"][url]["at"] >= 86400 for url in ROBOTS_URLS
                ):
                    self.robots()
                    continue
                break
            when = datetime.fromtimestamp(due, TZ).isoformat(timespec="seconds")
            if not self.wait:
                raise StopDownload(f"Next permitted request: {when}. Use --wait to wait automatically.")
            print(f"Waiting until {when} (UTC+08; serialized, robots delay enforced).", flush=True)
            self.sleep(max(1, due - now))
        # Reserve bytes before requesting, so a crash cannot erase the hourly budget.
        reservation = {"at": self.clock(), "bytes": reserve}
        self.state["transfers"].append(reservation)
        self.state["in_flight"] = True
        self.save()
        return reservation

    def request(self, url, consumer, *, reserve, headers=None):
        if url not in ROBOTS_URLS and not (
            urllib.parse.urlsplit(url).scheme == "https"
            and urllib.parse.urlsplit(url).netloc == "media.52poke.com"
            and urllib.parse.urlsplit(url).path.startswith("/wiki/")
        ):
            raise ValueError("Network request outside the fixed source allowlist.")
        self.before_request(reserve, needs_policy=url not in ROBOTS_URLS)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            if url not in ROBOTS_URLS:
                self.check_image_allowed(url)
            with self.opener.open(request, timeout=45) as response:
                result = consumer(response)
            return result
        except urllib.error.HTTPError as error:
            if error.code in {401, 403, 429}:
                self.state["access_block"] = {
                    "status": error.code, "url": url, "at": self.clock(),
                    "retry_after": error.headers.get("Retry-After"),
                }
            raise StopDownload(f"HTTP {error.code}; stopped without retry or identity changes: {url}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise StopDownload(f"Network interrupted ({type(error).__name__}); completed files are retained.") from error
        finally:
            self.state["last_finished"] = self.clock()
            self.state["in_flight"] = False
            self.save()

    def robots(self):
        for url in ROBOTS_URLS:
            cached = self.state["robots"].get(url)
            if cached and self.clock() - cached["at"] < 86400:
                continue

            def consume(response):
                content = response.read(65537)
                if (response.status != 200 or len(content) > 65536
                        or b"<html" in content.lower() or b"<!doctype" in content.lower()):
                    raise StopDownload("robots.txt is not an accessible plain-text policy; no images requested.")
                return content.decode("utf-8-sig")

            text = self.request(url, consume, reserve=65536)
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(text.splitlines())
            self.state["robots"][url] = {
                "at": self.clock(), "text": text,
                "delay": parser.crawl_delay(USER_AGENT) or 0,
            }
            self.save()

    def check_image_allowed(self, url):
        for policy_url in ROBOTS_URLS:
            policy = self.state["robots"][policy_url]
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(policy["text"].splitlines())
            # Also honor the Wiki's path policy conservatively for its attachment CDN.
            check_url = url
            if "wiki.52poke.com" in policy_url:
                check_url = url.replace("https://media.52poke.com", "https://wiki.52poke.com", 1)
            if not parser.can_fetch(USER_AGENT, check_url):
                raise StopDownload("robots.txt disallows this image; stopped without requesting it.")


def download_one(network, output, target):
    info = target["latest_file_metadata"]
    path = image_path(output, target)
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    resume_path = path.with_name(path.name + ".resume.json")
    resume = read_json(resume_path, {})
    offset = part.stat().st_size if part.exists() else 0
    if offset:
        if offset == info["size"]:
            result = verify_image(part, info)
            part.replace(path)
            resume_path.unlink(missing_ok=True)
            return result
        if (offset > info["size"] or resume.get("url") != info["url"]
                or not resume.get("validator")):
            raise StopDownload("Partial file lacks safe resume metadata; retained for inspection.")
    headers = {"Accept": "image/*"}
    if offset:
        headers.update({"Range": f"bytes={offset}-", "If-Range": resume["validator"]})
    def consume(response):
        if response.headers.get("Content-Encoding", "identity").lower() not in {"identity", ""}:
            raise StopDownload("Encoded image response cannot be checked against the original bytes.")
        status = response.status
        if offset:
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
            if (status != 206 or not match or int(match[1]) != offset
                    or int(match[2]) != info["size"] - 1 or int(match[3]) != info["size"]):
                raise StopDownload("Server did not honor safe Range resume; partial file retained.")
        elif status != 200:
            raise StopDownload(f"Unexpected image status: {status}")
        if not response.headers.get("Content-Type", "").lower().startswith("image/"):
            raise StopDownload("Non-image response; not saved as a card.")
        length = response.headers.get("Content-Length")
        if length is not None and int(length) != info["size"] - offset:
            raise StopDownload("Source size changed since the manifest snapshot; no automatic substitution.")
        validator = response.headers.get("ETag", "")
        if not validator or validator.startswith("W/"):
            validator = response.headers.get("Last-Modified", "")
        atomic_json(resume_path, {"url": info["url"], "validator": validator})
        started, received = time.monotonic(), 0
        with part.open("ab" if offset else "wb") as stream:
            while chunk := response.read(min(65536, info["size"] - offset - received + 1)):
                received += len(chunk)
                if received + offset > info["size"]:
                    raise StopDownload("Source is larger than expected; partial retained, not accepted.")
                stream.write(chunk)
                delay = received / RATE - (time.monotonic() - started)
                if delay > 0:
                    network.sleep(delay)
        if received + offset != info["size"]:
            raise StopDownload("Image was truncated; partial retained for safe resume.")

    network.request(info["url"], consume, reserve=info["size"] - offset, headers=headers)
    result = verify_image(part, info)
    part.replace(path)
    resume_path.unlink(missing_ok=True)
    return result


def record_receipt(output, target, digest):
    path = output / "receipts.json"
    receipts = read_json(path, {"schema_version": 1, "files": {}})
    receipts["files"][target["wiki_filename"]] = {
        "wiki_filename": target["wiki_filename"],
        "wiki_file_page_id": target["wiki_file_page_id"],
        "wiki_file_revision_id": target["wiki_file_revision_id"],
        "source_url": target["latest_file_metadata"]["url"],
        "relative_file": image_path(output, target).relative_to(output).as_posix(),
        "verified_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "width": target["latest_file_metadata"]["width"],
        "height": target["latest_file_metadata"]["height"],
        **digest,
        "verification": "snapshot_Wiki_SHA1_size_dimensions_and_image_decode",
        "semantic_identity_review_required": target.get("semantic_identity_review_required", False),
        "not_an_automatic_language_or_engine_version_approval": True,
    }
    atomic_json(path, receipts)


def verify_cached(manifest, output, record=False):
    receipts = read_json(output / "receipts.json", {"files": {}})["files"]
    count, size = 0, 0
    for target in ready_targets(manifest):
        path = image_path(output, target)
        if not path.exists():
            if target["wiki_filename"] in receipts:
                raise ValueError("Previously verified file is missing; no automatic re-download.")
            part = path.with_name(path.name + ".part")
            if record and part.exists() and part.stat().st_size == target["latest_file_metadata"]["size"]:
                verify_image(part, target["latest_file_metadata"])
                part.replace(path)
                path.with_name(path.name + ".resume.json").unlink(missing_ok=True)
            else:
                continue
        result = verify_image(path, target["latest_file_metadata"])
        previous = receipts.get(target["wiki_filename"])
        if previous and any(previous.get(k) != result[k] for k in ("sha1", "sha256", "bytes")):
            raise ValueError("Previously verified bytes changed; no automatic re-download.")
        if record and not previous:
            record_receipt(output, target, result)
        count += 1
        size += result["bytes"]
    return count, size


def status(manifest, output):
    receipts = read_json(output / "receipts.json", {"files": {}})["files"]
    targets = ready_targets(manifest)
    done = sum(t["wiki_filename"] in receipts and image_path(output, t).is_file() for t in targets)
    print(json.dumps({
        "target_references": len(manifest["targets"]), "with_original_url": len(targets),
        "without_original_url": len(manifest["targets"]) - len(targets),
        "recorded_completed_files_not_rehashed": done, "remaining_url_targets": len(targets) - done,
        "known_unique_bytes": sum({t["latest_file_metadata"]["sha1"]: t["latest_file_metadata"]["size"] for t in targets}.values()),
        "network_requests": 0,
    }, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "manifests/remaining-images.json")
    parser.add_argument("--output", type=Path, default=ROOT / "downloads")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="Offline manifest and recorded-progress summary.")
    download = sub.add_parser("download", help="Serialized downloads only in 02:00–08:00 UTC+08.")
    download.add_argument("--site-authorized", action="store_true", help="Confirm source-authorized access; not permission to evade a block.")
    download.add_argument("--wait", action="store_true", help="Wait for the time window and request interval.")
    download.add_argument("--limit", type=int, default=0, help="Stop after this many new files (0 = all ready targets).")
    sub.add_parser("verify", help="Offline SHA-1/SHA-256, size, dimensions and decode verification.")
    pack = sub.add_parser("pack-results", help="Verify and ZIP only downloaded files and receipts.")
    pack.add_argument("--zip", type=Path, default=ROOT / "52poke-downloaded-images.zip")
    args = parser.parse_args()
    manifest = load_manifest(args.manifest)
    if args.command == "status":
        status(manifest, args.output)
        return
    if args.command == "download" and not args.site_authorized:
        raise StopDownload("Confirm permission with --site-authorized. Do not switch IPs/machines to bypass a source block.")
    if args.command == "download" and args.limit < 0:
        raise ValueError("--limit must be zero or positive.")
    with output_lock(args.output):
        count, size = verify_cached(manifest, args.output, record=True)
        if args.command == "verify":
            print(f"Verified {count} files, {size} bytes; no network requests.")
        elif args.command == "pack-results":
            receipts = read_json(args.output / "receipts.json", {"schema_version": 1, "files": {}})
            allowed = {t["wiki_filename"] for t in ready_targets(manifest)}
            if set(receipts["files"]) - allowed:
                raise ValueError("Unexpected receipts from a different manifest; use a separate output folder.")
            entries = []
            for target in ready_targets(manifest):
                receipt = receipts["files"].get(target["wiki_filename"])
                if receipt:
                    expected = image_path(args.output, target)
                    if receipt["relative_file"] != expected.relative_to(args.output).as_posix():
                        raise ValueError("Receipt has an unexpected file path.")
                    entries.append((expected, receipt["relative_file"]))
            args.zip.parent.mkdir(parents=True, exist_ok=True)
            if args.zip.resolve() in {path.resolve() for path, _ in entries}:
                raise ValueError("Result ZIP cannot overwrite a downloaded image.")
            temporary = args.zip.with_name(args.zip.name + ".tmp")
            with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("receipts.json", json.dumps(receipts, ensure_ascii=False, indent=2))
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                for path, name in entries:
                    archive.write(path, name)
            temporary.replace(args.zip)
            print(f"Packed {len(entries)} verified files: {args.zip.resolve()}")
        else:
            pending = [t for t in ready_targets(manifest) if not image_path(args.output, t).exists()]
            if not pending:
                print("All URL targets are already verified; no network requests.")
                return
            network = Network(args.output, wait=args.wait)
            network.robots()
            done = 0
            for target in pending:
                network.robots()  # Refresh policies after a multi-night download.
                result = download_one(network, args.output, target)
                record_receipt(args.output, target, result)
                done += 1
                print(f"[{count + done}/{len(ready_targets(manifest))}] {target['wiki_filename']} verified ({result['bytes']} bytes)", flush=True)
                if args.limit and done >= args.limit:
                    break


if __name__ == "__main__":
    try:
        main()
    except (StopDownload, ValueError, ImportError, OSError) as error:
        print(f"STOP: {error}", file=sys.stderr)
        sys.exit(2)
