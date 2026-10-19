"""Match cached official images to live Wiki File bytes, without downloading its CDN.

Only file metadata is requested. Requests are serialized, use the fixed app UA,
honor robots and a >=500-second gap, and run in the published low-traffic window.
An exact SHA-1 AND size match is confirmed against the cache's stored SHA-256.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

from download_images import ROOT, USER_AGENT, canonical_filename, connect, dump_json, off_peak, sha256, summary
from image_identity import printed_set

DIRECTORY = ROOT / "sources/wiki-file-metadata"
STATE = DIRECTORY / "state.json"


def verified_recovered_identity(uses, photo):
    """Exact File bytes replace a source-page URL coincidence, not identity verification."""
    from accept_official_candidates import agreement, name, number
    if not photo.get("ocr") or not photo.get("second_ocr"):
        return None
    first, second = [json.loads(photo[k])["reading"] for k in ("ocr", "second_ocr")]
    if not agreement(first, second):
        return None
    matches = []
    for use in uses:
        if (not use.get("recovered_existing_File_for_printing") or use.get("language") != "zh-Hans"
                or printed_set(use.get("set_code")) != printed_set(first.get("set_code"), first.get("number"))
                or number(use.get("number")) != number(first.get("number"))
                or name(re.sub(r"（[^（）]+）$", "", use["title"])) != name(first.get("name"))):
            continue
        matches.append(use)
    if len(matches) != 1:
        return None
    use = matches[0]
    return {
        "method": "two_independent_printed_identity_reads_and_exact_live_Wiki_File_content_hash",
        "reading": first, "human_reviewed": False, "recovered_existing_File_for_printing": True,
        "wiki_printing_template_index": use["template_index"],
        "original_metadata_image_field": use.get("original_image_field"),
    }


def load_state():
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE.read_text()) if STATE.exists() else {"batches": [], "streams": {}, "last_finished": 0}
    probe = ROOT / "sources/current-access/wiki-file-metadata-probe.json"
    if probe.exists():
        state["last_finished"] = max(state["last_finished"], json.loads(probe.read_text()).get("finished_at_epoch", 0))
    return state


def records(data):
    for page in data.get("query", {}).get("pages", []):
        info = (page.get("imageinfo") or [{}])[0]
        filename = canonical_filename(page.get("title", ""))
        if (page.get("ns") != 6 or not isinstance(page.get("pageid"), int) or not filename or page.get("missing")
                or not re.fullmatch(r"[0-9a-f]{40}", info.get("sha1", ""))
                or not isinstance(info.get("size"), int) or info["size"] <= 0
                or urllib.parse.urlsplit(info.get("url", "")).hostname != "media.52poke.com"):
            continue
        yield filename, {"page_id": page["pageid"], **info}


def worker_status(status, **extra):
    path = ROOT / "official-candidates/candidates.sqlite"
    if not path.exists():
        return
    db = sqlite3.connect(path, timeout=30)
    import os
    db.execute("INSERT OR REPLACE INTO state VALUES ('wiki_metadata_status',?)", (
        json.dumps({"status": status, "pid": os.getpid(), "at": time.time(), **extra}),))
    db.commit()
    db.close()


def cache_index():
    """Only verified public-image receipts; never upload or inspect unrelated local files."""
    previous_path = DIRECTORY / "local-content-index.json"
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    source = sqlite3.connect(f"file:{ROOT / 'official-candidates/candidates.sqlite'}?mode=ro", uri=True)
    assets = [(u, json.loads(r)) for u, r in source.execute("SELECT url,record FROM photos")]
    source.close()
    queue = sqlite3.connect(f"file:{ROOT / 'images-zh-hans/queue.sqlite'}?mode=ro", uri=True)
    assets.extend((u, json.loads(r)) for u, r in queue.execute("SELECT url,record_json FROM assets"))
    queue.close()
    index, saved = {}, {}
    for url, asset in assets:
        if asset["sha256"] in saved:
            continue
        path = Path(asset["local_file"])
        if not path.is_file():
            raise ValueError("A previously verified public image is missing.")
        stat = path.stat()
        old = previous.get(asset["sha256"])
        if old and old["local_file"] == str(path) and old["mtime_ns"] == stat.st_mtime_ns and old["size"] == stat.st_size:
            digest = old["sha1"]
        else:
            h1, h256 = hashlib.sha1(), hashlib.sha256()
            with path.open("rb") as stream:
                while block := stream.read(1_048_576):
                    h1.update(block)
                    h256.update(block)
            if h256.hexdigest() != asset["sha256"] or stat.st_size != asset["bytes"]:
                raise ValueError("Public cache changed; refusing hash association.")
            digest = h1.hexdigest()
        saved[asset["sha256"]] = {"sha1": digest, "size": stat.st_size,
                                 "local_file": str(path), "mtime_ns": stat.st_mtime_ns}
        index.setdefault((digest, stat.st_size), (url, asset))
    dump_json(previous_path, saved)
    return index


def bind():
    state = load_state()
    live = {}
    for batch in state["batches"]:
        for filename, info in records(json.loads((DIRECTORY / batch["file"]).read_text())):
            live[filename] = {**info, "metadata_fetched_at_epoch": batch["at"], "metadata_source": batch["source"]}
    index = cache_index()
    photo_source = sqlite3.connect(f"file:{ROOT / 'official-candidates/candidates.sqlite'}?mode=ro", uri=True)
    photo_source.row_factory = sqlite3.Row
    photos_by_hash = {}
    for photo in photo_source.execute("SELECT * FROM photos WHERE ocr IS NOT NULL AND second_ocr IS NOT NULL"):
        photos_by_hash.setdefault(json.loads(photo["record"])["sha256"], []).append(dict(photo))
    photo_source.close()
    directory = ROOT / "images-zh-hans"
    matched, skipped_derived = [], 0
    with (directory / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        queue = connect(directory)
        try:
            for job in queue.execute("SELECT * FROM jobs WHERE active=1").fetchall():
                info = live.get(job["filename"])
                if not info or job["file_page_id"] != info["page_id"]:
                    continue  # A deleted/re-created File page is not silently treated as the archived one.
                uses = json.loads(job["uses_json"])
                if not uses or any(u.get("language") != "zh-Hans" for u in uses):
                    continue
                derived = any(u.get("language_is_requested_target_not_image_verification") for u in uses)
                if derived and job["status"] != "done":
                    skipped_derived += 1
                cached = index.get((info["sha1"], info["size"]))
                if not cached:
                    continue
                url, asset = cached
                recovered_semantic = None
                if derived and job["status"] != "done":
                    recovered_semantic = next((proof for photo in photos_by_hash.get(asset["sha256"], [])
                                               if (proof := verified_recovered_identity(uses, photo))), None)
                    if not recovered_semantic:
                        continue
                    skipped_derived -= 1
                h1, h256 = hashlib.sha1(), hashlib.sha256()
                with Path(asset["local_file"]).open("rb") as image:
                    while block := image.read(1_048_576):
                        h1.update(block)
                        h256.update(block)
                if h256.hexdigest() != asset["sha256"] or h1.hexdigest() != info["sha1"]:
                    raise ValueError("Matched public cache does not have the claimed content hashes.")
                old = queue.execute("SELECT evidence FROM file_verifications WHERE filename=?", (job["filename"],)).fetchone()
                semantic = json.loads(old[0]) if old else {}
                semantic = recovered_semantic or semantic
                if not semantic and job["asset_url"]:
                    old_asset = queue.execute("SELECT record_json FROM assets WHERE url=?", (job["asset_url"],)).fetchone()
                    if old_asset:
                        previous = json.loads(old_asset[0]).get("matching_evidence", {})
                        if previous.get("wiki_file_page_id") == job["file_page_id"]:
                            semantic = previous
                evidence = {**semantic, "content_hash_verification": info,
                            "byte_identical_to_wiki_copy": True, "human_reviewed": False,
                            "wiki_file_page_id": job["file_page_id"], "wiki_file_revision_id": job["file_revision_id"]}
                if not semantic:
                    evidence["method"] = "live_Wiki_File_sha1_and_size_equal_verified_public_cache"
                    evidence["wiki_file_page_id"] = job["file_page_id"]
                    evidence["wiki_file_revision_id"] = job["file_revision_id"]
                # Proof belongs to this File binding, not every reference sharing the same blob.
                queue.execute("INSERT OR REPLACE INTO file_verifications VALUES (?,?)",
                              (job["filename"], json.dumps(evidence, ensure_ascii=False)))
                current = queue.execute("SELECT record_json FROM assets WHERE url=?", (url,)).fetchone()
                stored = json.loads(current[0]) if current else dict(asset)
                if stored["sha256"] != asset["sha256"]:
                    raise ValueError("One public URL has conflicting cached bytes.")
                stored["image_language"] = "zh-Hans"
                queue.execute("INSERT OR REPLACE INTO assets VALUES (?,?)", (url, json.dumps(stored, ensure_ascii=False)))
                was_done = job["status"] == "done"
                queue.execute("UPDATE jobs SET status='done',asset_url=?,error=NULL WHERE filename=?",
                              (url, job["filename"]))
                matched.append({"filename": job["filename"], "newly_done": not was_done})
            queue.commit()
            summary(queue, directory)
        finally:
            queue.close()
    report = {"matched": matched, "newly_done": sum(row["newly_done"] for row in matched),
              "derived_references_still_requiring_semantic_verification": skipped_derived,
              "cached_wiki_file_records": len(live), "cdn_downloads": 0, "OCR_calls": 0}
    output = ROOT / "sources/current-access/wiki-hash-matching.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    dump_json(output, report)
    print(json.dumps({k: v for k, v in report.items() if k != "matched"}), flush=True)


class MetadataRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, url):
        p = urllib.parse.urlsplit(url)
        if p.scheme != "https" or p.hostname != "wiki.52poke.com" or p.path != "/api.php":
            raise ValueError("Metadata redirect left the approved API; no follow-up request.")
        return super().redirect_request(req, fp, code, msg, headers, url)


def fetch(prefix, batches, titles=None, final=True):
    state = load_state()
    if state.get("blocked"):
        raise ValueError("A metadata access block is recorded; inspect it before any further request.")
    robots_path = ROOT / "sources/current-access/wiki-robots-recheck.txt"
    if time.time() - robots_path.stat().st_mtime >= 86400:
        raise ValueError("Refresh the expired robots cache before requesting file metadata.")
    robots = urllib.robotparser.RobotFileParser()
    robots.parse(robots_path.read_text().splitlines())
    gap = max(500, robots.crawl_delay(USER_AGENT) or 0)
    opener = urllib.request.build_opener(MetadataRedirect())
    stream_key = "titles-" + hashlib.sha256("|".join(titles).encode()).hexdigest()[:12] if titles else prefix
    try:
        for _ in range(batches):
            stream = state["streams"].get(stream_key, {})
            if stream.get("complete"):
                break
            next_at = state["last_finished"] + gap
            while time.time() < next_at:
                worker_status("waiting", prefix=prefix, next_allowed_at_epoch=next_at)
                time.sleep(min(60, next_at - time.time()))
            if not off_peak():
                raise ValueError("Metadata bulk window ended; continuation is saved.")
            params = {"action": "query", "format": "json", "formatversion": "2", "maxlag": "5",
                      "prop": "imageinfo", "iiprop": "url|sha1|size|timestamp", "iilimit": "1"}
            if titles:
                params["titles"] = "|".join("File:" + title for title in titles)
            else:
                params.update({"generator": "allimages", "gaiprefix": prefix, "gailimit": "500"})
            params.update(stream.get("continuation", {}))
            url = "https://wiki.52poke.com/api.php?" + urllib.parse.urlencode(params)
            if not robots.can_fetch(USER_AGENT, url):
                raise ValueError("robots.txt disallows this metadata request.")
            worker_status("running", prefix=prefix)
            # Reserve the request before opening it so interruptions cannot reset the gap.
            state["last_finished"] = time.time()
            dump_json(STATE, state)
            try:
                with opener.open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                   "Accept": "application/json"}), timeout=60) as response:
                    body = response.read(2_000_001)
                    if len(body) > 2_000_000:
                        raise ValueError("Metadata response exceeds its bound.")
                    data = json.loads(body)
            except urllib.error.HTTPError as exc:
                if exc.code in {401, 403, 429}:
                    state["blocked"] = f"HTTP {exc.code}; no identity/URL workaround."
                raise
            finally:
                state["last_finished"] = time.time()
                dump_json(STATE, state)
            filename = f"{stream_key}-{len(state['batches']):04}-{int(time.time())}.json"
            dump_json(DIRECTORY / filename, data)
            if data.get("error"):
                raise ValueError("Wiki returned an API error; response retained for inspection.")
            if any((name not in titles if titles else not name.startswith(prefix)) for name, _ in records(data)):
                raise ValueError("API response did not honor the explicit filename prefix.")
            state["batches"].append({"file": filename, "at": time.time(), "source": url})
            # Never follow image-history continuation: only latest file metadata
            # and the allimages generator's next page are part of this task.
            continuation = {k: v for k, v in data.get("continue", {}).items() if k in {"continue", "gaicontinue"}}
            complete = bool(titles) or "gaicontinue" not in continuation
            state["streams"][stream_key] = {"continuation": {} if complete else continuation,
                                            "complete": complete}
            dump_json(STATE, state)
            print(f"Cached {len(list(records(data)))} live File metadata records; next request >= {gap}s later.", flush=True)
            bind()
        worker_status("complete" if final else "running", prefix=prefix)
    except BaseException:
        worker_status("stopped", prefix=prefix)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["ingest-probe", "bind", "fetch"])
    parser.add_argument("--prefix", default="CS")
    parser.add_argument("--prefixes", nargs="+", help="Process these explicit filename prefixes serially in one worker.")
    parser.add_argument("--batches", type=int, default=1)
    parser.add_argument("--titles-json", type=Path, help="An explicit JSON list of at most 50 real target filenames.")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,20}", args.prefix) or not 1 <= args.batches <= 10:
        raise SystemExit("Use an explicit bounded filename prefix and 1–10 metadata batches.")
    if args.prefixes and (len(args.prefixes) > 10 or any(not re.fullmatch(r"[A-Za-z0-9.-]{1,20}", p) for p in args.prefixes)):
        raise SystemExit("Use at most ten explicit safe filename prefixes.")
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    titles = json.loads(args.titles_json.read_text()) if args.titles_json else None
    if titles is not None and (not isinstance(titles, list) or not 1 <= len(titles) <= 50
                              or any(not isinstance(t, str) or "|" in t or canonical_filename(t) != t for t in titles)):
        raise SystemExit("Use 1–50 exact, safe target filenames for one metadata query.")
    with (DIRECTORY / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "ingest-probe":
            state = load_state()
            source = ROOT / "sources/current-access/wiki-file-metadata-probe-data.json"
            receipt = json.loads((ROOT / "sources/current-access/wiki-file-metadata-probe.json").read_text())
            name = "initial-probe.json"
            dump_json(DIRECTORY / name, json.loads(source.read_text()))
            if not any(b["file"] == name for b in state["batches"]):
                state["batches"].append({"file": name, "at": receipt["finished_at_epoch"], "source": receipt["url"]})
            dump_json(STATE, state)
            bind()
        elif args.command == "bind":
            bind()
        else:
            prefixes = args.prefixes or ([] if titles else [args.prefix])
            for i, prefix in enumerate(prefixes):
                fetch(prefix, args.batches, final=i == len(prefixes) - 1 and not titles)
            if titles:
                fetch("exact-targets", 1, titles, final=True)


if __name__ == "__main__":
    main()
