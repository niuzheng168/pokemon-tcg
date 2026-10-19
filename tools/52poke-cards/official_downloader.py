"""Cross-platform, resumable acquisition from public Simplified Chinese sources.

Discovery uses declared official pages and the reviewed 151 campaign generator.
Image URLs are never inferred from Wiki filenames. Only byte-identical snapshot
matches may enter the library automatically; other scans remain candidates.
No SQLite, Unix-only imports, OCR, credentials or 52Poké requests are involved.
Official requests do not fetch or interpret robots.txt.
"""
from __future__ import annotations

from collections import Counter
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from card_storage import atomic_json, publish_download, register_manifest_collisions

USER_AGENT = "PokemonCardStudy/1.0 (noncommercial local card-image archiving)"
GAP = 10
RATE = 250_000
MAX_IMAGE_BYTES = 25_000_000
MAX_DOCUMENT_BYTES = 2_000_000
CAMPAIGN = "https://special.pokemon.cn/151/"
CAMPAIGN_SCRIPT = CAMPAIGN + "static/js/4.8470c2c8.chunk.js"
SUFFIXES = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp", "GIF": ".gif"}
REDIRECTS = {301, 302, 303, 307, 308}


class OfficialStopped(ValueError):
    """Persistent block or policy denial; never automatically cleared."""


def read_json(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def official_url(url):
    """Validate both initial URLs and every redirect; preserve published queries."""
    if not isinstance(url, str) or re.search(r"[\x00-\x20\\]", url):
        raise ValueError("Invalid official URL.")
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != "https" or parts.username or parts.password
            or parts.port not in (None, 443)
            or not any(parts.hostname == domain or (parts.hostname or "").endswith("." + domain)
                       for domain in ("pokemon.cn", "pokemon.com.cn"))):
        raise ValueError("URL is outside the official Chinese source allowlist.")
    return urllib.parse.urlunsplit(("https", parts.netloc.lower(), parts.path or "/", parts.query, ""))


def canonical(url):
    parts = urllib.parse.urlsplit(official_url(url))
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def image_url(url):
    return Path(urllib.parse.urlsplit(url).path).suffix.lower() in set(SUFFIXES.values()) | {".jpeg"}


def simplified_targets(manifest):
    # Mixed/unknown-language uses cannot become Simplified-language approvals.
    return [target for target in manifest["targets"] if target.get("uses")
            and {use.get("language") for use in target["uses"]} == {"zh-Hans"}]


def source_pages(manifest):
    pages = {}
    for target in simplified_targets(manifest):
        for url in target.get("declared_source_urls", []):
            try:
                fetch_url = official_url(url)
            except ValueError:
                continue
            pages.setdefault(canonical(fetch_url), fetch_url)
    return pages


class PageImages(HTMLParser):
    """Prefer linked originals/lazy images; navigation is not a card identity."""
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.article, self.saw_article = base, 0, False
        self.links, self.all_images, self.article_images = [], [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "article":
            self.article += 1
            self.saw_article = True
        if tag == "a":
            self.links.append(attrs.get("href", ""))
        if tag != "img":
            return
        if re.fullmatch(r"\d+", attrs.get("width", "")) and int(attrs["width"]) < 180:
            return
        choices = self.links[-1:] + [attrs.get(key, "") for key in
                                     ("data-original", "data-src", "data-lazy-src")]
        ranked = []
        for item in attrs.get("srcset", "").split(","):
            fields = item.split()
            if fields:
                rank = float(fields[1][:-1]) if (
                    len(fields) > 1 and re.fullmatch(r"\d+(?:\.\d+)?[wx]", fields[1])
                ) else 0
                ranked.append((rank, fields[0]))
        choices += [url for _, url in sorted(ranked, reverse=True)] + [attrs.get("src", "")]
        for choice in choices:
            if not choice:
                continue
            try:
                url = official_url(urllib.parse.urljoin(self.base, choice))
            except ValueError:
                continue
            if image_url(url):
                self.all_images.append(url)
                if self.article:
                    self.article_images.append(url)
                break

    def handle_endtag(self, tag):
        if tag == "article":
            self.article = max(0, self.article - 1)
        if tag == "a" and self.links:
            self.links.pop()

    def images(self):
        rows = self.article_images if self.saw_article else self.all_images
        return list({canonical(url): url for url in rows}.values())


def gallery_urls(script):
    """Recognize the published generator, not a guessed range of card IDs.

    These are candidate URLs, not assertions about printed numbers or variants.
    Fail closed if the reviewed generator changes.
    """
    prefix = '"https://special.pokemon.cn/151/img/big/151_".concat(e,'
    if not all(token in script for token in (
        "Array.from({length:151})", prefix + '".png")',
        prefix + '1===a?".png":2===a?"a.png":"b.png")', "i.show_big=function(e)",
    )):
        raise ValueError("151 gallery generator changed; review the public script first.")
    plain = set(re.findall(r'"(\d{3})"===a', script))
    if len(plain) != 12:
        raise ValueError("151 gallery variant rules changed; manual review required.")
    identifiers = set(re.findall(r'\.show_big\("(\d{3}[ab]?)"\)', script))
    for number in range(1, 152):
        identifier = f"{number:03}"
        identifiers.add(identifier)
        if identifier not in plain:
            identifiers.update((identifier + "a", identifier + "b"))
    return [CAMPAIGN + f"img/big/151_{identifier}.png" for identifier in sorted(identifiers)]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OfficialNetwork:
    """One serial writer, >=10s completion gap, 250KB/s, persistent stop."""
    def __init__(self, output, *, opener=None, clock=time.time, sleep=time.sleep):
        self.path = output / "official-network.json"
        self.state = read_json(self.path, {"source": "official", "last_finished": 0})
        if self.state.get("source") != "official":
            raise ValueError("Unsupported official network state; refusing to reset it.")
        self.clock, self.sleep = clock, sleep
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.last_url = None  # Final successful URL, including after a redirect.
        if self.state.pop("in_flight", False):
            self.state["last_finished"] = clock()
            self.save()

    def save(self):
        atomic_json(self.path, self.state)

    def stop(self, reason, url):
        self.state["access_block"] = {"reason": reason, "url": canonical(url), "at": self.clock()}
        self.save()
        raise OfficialStopped(reason + "; stopped without retry, IP or identity changes.")

    def check_stopped(self):
        if self.state.get("access_block"):
            raise OfficialStopped("An official-source block is recorded; inspect it with the source operator.")

    def _request(self, url, kind):
        self.check_stopped()
        self.sleep(max(0, self.state["last_finished"] + GAP - self.clock()))
        self.state["in_flight"] = True
        self.save()
        maximum = MAX_IMAGE_BYTES if kind == "image" else MAX_DOCUMENT_BYTES
        request = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT, "Accept-Encoding": "identity",
            "Accept": "image/*" if kind == "image" else "*/*",
        })
        try:
            with self.opener.open(request, timeout=45) as response:
                if response.status != 200:
                    raise ValueError("Unexpected official response status.")
                headers = response.headers
                if headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
                    raise ValueError("Encoded official response is not supported.")
                if kind == "image" and not headers.get("Content-Type", "").lower().startswith("image/"):
                    raise ValueError("Official response is not an image.")
                length = headers.get("Content-Length")
                if length and (not length.isdigit() or int(length) > maximum):
                    raise ValueError("Official response exceeds the size limit.")
                chunks, received, started = [], 0, self.clock()
                while chunk := response.read(min(65536, maximum + 1 - received)):
                    received += len(chunk)
                    if received > maximum:
                        raise ValueError("Official response exceeds the size limit.")
                    chunks.append(chunk)
                    self.sleep(max(0, received / RATE - (self.clock() - started)))
                if length and received != int(length):
                    raise ValueError("Truncated official response.")
                return b"".join(chunks)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in {401, 403, 429}:
                self.stop(f"HTTP {error.code}", url)
            raise
        finally:
            self.state["last_finished"] = self.clock()
            self.state["in_flight"] = False
            self.save()

    def fetch(self, url, kind):
        for _ in range(6):
            url = official_url(url)
            self.check_stopped()
            try:
                data = self._request(url, kind)
                self.last_url = url
                return data
            except urllib.error.HTTPError as error:
                if error.code not in REDIRECTS or not error.headers.get("Location"):
                    raise
                url = official_url(urllib.parse.urljoin(url, error.headers["Location"]))
                # The allowlist, persistent block and request gap apply on every hop.
        raise ValueError("Too many official redirects.")


def decode_image(data):
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        width, height, fmt = image.width, image.height, image.format
        if width * height > 50_000_000:
            raise ValueError("Official image exceeds the decoded pixel limit.")
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()
    if fmt not in SUFFIXES:
        raise ValueError("Unsupported official image format.")
    return {
        "sha1": hashlib.sha1(data).hexdigest(), "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data), "width": width, "height": height, "suffix": SUFFIXES[fmt],
    }


def exact_matches(manifest, record):
    return [target for target in simplified_targets(manifest)
            if (info := target.get("latest_file_metadata"))
            and info["sha1"] == record["sha1"] and info["size"] == record["bytes"]
            and (info["width"], info["height"]) == (record["width"], record["height"])]


def cache_path(output, record):
    if (not re.fullmatch(r"[0-9a-f]{64}", record["sha256"])
            or record["suffix"] not in SUFFIXES.values()):
        raise ValueError("Invalid official cache identity.")
    return output / "files" / (record["sha256"] + record["suffix"])


def verify_receipts(manifest, output, library=None, *, only=None):
    """Offline import also works from pack-results, with no private queue state."""
    receipts = read_json(output / "official-receipts.json", {"source": "official", "files": {}})
    if receipts.get("source") != "official":
        raise ValueError("Not an official-source receipt file.")
    published = 0
    if library and receipts["files"]:
        register_manifest_collisions(library, manifest["targets"])
    for key, record in receipts["files"].items():
        if only and key != only:
            continue
        if key != record["sha256"]:
            raise ValueError("Official receipt key changed.")
        path = cache_path(output, record)
        if (type(record["bytes"]) is not int or not 0 < record["bytes"] <= MAX_IMAGE_BYTES
                or path.stat().st_size != record["bytes"]):
            raise ValueError("Previously verified official image size changed.")
        checked = decode_image(path.read_bytes())  # Missing/corrupt files are never redownloaded silently.
        if any(checked[field] != record[field] for field in checked):
            raise ValueError("Previously verified official bytes changed.")
        if library:
            for target in exact_matches(manifest, checked):
                asset = {
                    **checked, "local_file": str(path.resolve()), "image_language": "zh-Hans",
                    "official_image_url": canonical(record["source_url"]),
                    "official_page_url": canonical(record["source_pages"][0]),
                    "matching_evidence": {
                        "method": "official_bytes_match_snapshot_Wiki_SHA1_size_dimensions_and_decode",
                        "human_reviewed": False,
                        "semantic_identity_review_required": target.get("semantic_identity_review_required", False),
                    },
                }
                published += publish_download(library, target, asset, preserve_existing_image=True)
    return receipts, published


class Runner:
    def __init__(self, manifest, output, network=None):
        self.manifest, self.output, self.network = manifest, output, network
        self.path = output / "official-queue.json"
        fingerprint = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        self.state = read_json(self.path, {
            "schema_version": 1, "source": "official", "manifest_sha256": fingerprint,
            "jobs": {}, "status": "ready", "network_tasks": 0,
        })
        if self.state.get("source") != "official" or self.state.get("manifest_sha256") != fingerprint:
            raise ValueError("Official queue belongs to a different manifest; do not reset an existing task.")
        for url, fetch_url in source_pages(manifest).items():
            self.enqueue(fetch_url, "image" if image_url(url) else "page", url)

    def enqueue(self, fetch_url, kind, page):
        url = canonical(fetch_url)
        job = self.state["jobs"].setdefault(url, {
            "fetch_url": official_url(fetch_url), "kind": kind, "status": "pending",
            "source_pages": [], "attempts": 0,
        })
        if canonical(page) not in job["source_pages"]:
            job["source_pages"].append(canonical(page))

    def save(self):
        atomic_json(self.path, self.state)  # Private: may contain public-page temporary CDN queries.

    def summary(self):
        receipts = read_json(self.output / "official-receipts.json", {"files": {}})["files"]
        return {
            "source": "official", "printing_language": "zh-Hans", "status": self.state["status"],
            "target_references": len(simplified_targets(self.manifest)),
            "declared_official_pages": len(source_pages(self.manifest)),
            "jobs": dict(Counter(job["status"] for job in self.state["jobs"].values())),
            "verified_candidate_files": len(receipts),
            "exact_original_targets": len({target["wiki_filename"] for record in receipts.values()
                                           for target in exact_matches(self.manifest, record)}),
            "counts_are_receipt_records_not_fresh_file_verification": True,
            "not_a_complete_official_card_catalog": True,
        }

    def accept_image(self, url, job, data):
        record = decode_image(data)
        matched = exact_matches(self.manifest, record)
        shaped = record["width"] >= 200 and record["height"] >= 280 and 1.28 <= record["height"] / record["width"] <= 1.52
        if not shaped and not matched:
            job["status"] = "non_card"
            return
        path = cache_path(self.output, record)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_bytes() != data:
            raise ValueError("Refusing to overwrite changed official cache bytes.")
        if not path.exists():
            part = path.with_suffix(path.suffix + ".part")
            part.write_bytes(data)
            part.replace(path)
        receipts = read_json(self.output / "official-receipts.json", {
            "schema_version": 1, "source": "official", "files": {},
        })
        previous = receipts["files"].get(record["sha256"], {})
        pages = sorted(set(previous.get("source_pages", []) + job["source_pages"]))
        receipts["files"][record["sha256"]] = {
            **record, "source_url": canonical(url), "source_pages": pages,
            "matched_targets": [target["wiki_filename"] for target in matched],
            "verification": "full_image_decode_and_local_SHA1_SHA256",
            "identity_status": "snapshot_byte_match" if matched else "candidate_requires_identity_review",
            "not_an_automatic_language_or_engine_version_approval": True,
        }
        atomic_json(self.output / "official-receipts.json", receipts)
        job.update(status="done", sha256=record["sha256"])

    def download(self, *, limit=0, library=None):
        network_path = self.output / "official-network.json"
        has_attempts = self.state["network_tasks"] or any(
            job["attempts"] or job["status"] != "pending" for job in self.state["jobs"].values()
        )
        if self.network is None and (
            (not self.path.exists() and any(path.exists() for path in (
                network_path, self.output / "official-receipts.json", self.output / "files",
            )))
            or (has_attempts and not network_path.exists())
        ):
            raise OfficialStopped(
                "Network task state is missing; use offline verify for result-only imports, "
                "or restore the original queue and network state. No new requests were made."
            )
        verify_receipts(self.manifest, self.output, library)
        network = self.network or OfficialNetwork(self.output)
        network.check_stopped()
        for job in self.state["jobs"].values():
            if job["status"] == "downloading":
                job.update(status="error", error="Interrupted request; inspect before explicitly retrying.")
        self.state["status"] = "running"
        self.save()
        transfers = 0
        try:
            while pending := [(url, job) for url, job in self.state["jobs"].items() if job["status"] == "pending"]:
                # Drain discovered pictures before fetching another source page.
                url, job = min(pending, key=lambda pair: (pair[1]["kind"] == "page", pair[0]))
                job.update(status="downloading", attempts=job["attempts"] + 1)
                self.state["network_tasks"] += 1
                if job["kind"] == "image":
                    transfers += 1
                self.save()
                try:
                    data = network.fetch(job["fetch_url"], job["kind"])
                    resolved_url = official_url(getattr(network, "last_url", None) or job["fetch_url"])
                    job["resolved_url"] = canonical(resolved_url)
                    if job["kind"] == "image":
                        self.accept_image(resolved_url, job, data)
                    elif job["kind"] == "script":
                        for image in gallery_urls(data.decode("utf-8")):
                            self.enqueue(image, "image", CAMPAIGN)
                        job["status"] = "done"
                    else:
                        parser = PageImages(resolved_url)
                        parser.feed(data.decode("utf-8"))
                        for image in parser.images():
                            self.enqueue(image, "image", url)
                            self.enqueue(image, "image", resolved_url)
                        if canonical(resolved_url) == CAMPAIGN:
                            self.enqueue(CAMPAIGN_SCRIPT, "script", CAMPAIGN)
                        job["status"] = "done"
                except OfficialStopped:
                    job["status"] = "blocked"
                    raise
                except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
                    # Do not leak exception bodies or temporary signed query strings.
                    job.update(status="error", error=f"HTTP {error.code}" if isinstance(
                        error, urllib.error.HTTPError) else type(error).__name__)
                self.save()
                if library and job["kind"] == "image" and job["status"] == "done":
                    verify_receipts(self.manifest, self.output, library, only=job["sha256"])
                print(json.dumps(self.summary(), ensure_ascii=False), flush=True)
                if limit and transfers >= limit:
                    break
            pending = any(job["status"] == "pending" for job in self.state["jobs"].values())
            self.state["status"] = "paused_batch_limit" if pending else "finished_available_sources"
        except BaseException as error:
            self.state["status"] = "blocked" if isinstance(error, OfficialStopped) else "paused"
            raise
        finally:
            self.save()


def run(args, manifest):
    if args.command == "status" or args.command == "plan":
        # Constructing the offline plan creates no output directory/network object.
        return Runner(manifest, args.output).summary()
    if args.command == "download":
        runner = Runner(manifest, args.output)
        runner.download(limit=args.limit, library=args.library)
        return runner.summary()
    receipts, published = verify_receipts(
        manifest, args.output, args.library if args.command == "verify" else None,
    )
    if args.command == "pack-results":
        entries = [(cache_path(args.output, record), "files/" + cache_path(args.output, record).name)
                   for record in receipts["files"].values()]
        protected = {args.output / name for name in (
            "official-queue.json", "official-network.json", "official-receipts.json",
            ".download.lock", "manifest.json",
        )}
        if getattr(args, "manifest", None):
            protected.add(args.manifest)
        destination = args.zip.resolve()
        library = args.library or args.output / "library"
        if (args.zip.suffix.lower() != ".zip"
                or destination in {path.resolve() for path in protected}
                or any(destination.is_relative_to(root.resolve()) for root in (args.output / "files", library))):
            raise ValueError("Result ZIP must be a .zip outside task state, input manifest, image cache and library.")
        args.zip.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".official-results.", suffix=".tmp", dir=args.zip.parent)
        os.close(fd)
        temporary = Path(name)
        try:
            with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("official-receipts.json", json.dumps(receipts, ensure_ascii=False, indent=2))
                public_manifest = json.loads(json.dumps(manifest))
                for target in public_manifest["targets"]:
                    target["declared_source_urls"] = [
                        urllib.parse.urlunsplit((*urllib.parse.urlsplit(url)[:3], "", ""))
                        for url in target.get("declared_source_urls", [])
                    ]
                archive.writestr("manifest.json", json.dumps(public_manifest, ensure_ascii=False, indent=2))
                for path, name in entries:
                    archive.write(path, name)
            temporary.replace(args.zip)
        finally:
            temporary.unlink(missing_ok=True)
    return {"source": "official", "verified_files": len(receipts["files"]),
            "published_exact_target_images": published, "network_requests": 0}
