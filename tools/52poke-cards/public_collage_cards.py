"""Recover full card views embedded in already-downloaded public official graphics.

Only the repeated left-card/right-caption layout is supported initially. The
crop is a candidate, never automatically a card match. It retains original
pixels and provenance; printed identity still needs two independent readings.
No restricted research image is opened or uploaded.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
import time

from PIL import Image

from collect_official_candidates import DIRECTORY, OCRPipeline, canonical_url, initialize, ocr, settings
from download_images import ROOT, dump_json, sha256
from review_card_details import read_details, separate_regulation_tokens, separate_rarity_token
from accept_official_candidates import agreement


def left_card_box(width, height):
    if height < 600 or not 1.64 <= width / height <= 1.70:
        return None
    # Keep a small neutral margin so the card's right border cannot be trimmed.
    return (0, 0, min(width, round(height * .74)), height)


def discover(limit):
    db = initialize(DIRECTORY)
    queue = sqlite3.connect(f"file:{ROOT / 'images-zh-hans/queue.sqlite'}?mode=ro", uri=True)
    pages = set()
    for (evidence,) in queue.execute("SELECT source_evidence FROM jobs WHERE active=1 AND status!='done'"):
        pages.update(re.findall(r"https://www\.pokemon\.cn/[^\s\]|]+", evidence or ""))
    queue.close()
    new = []
    try:
        for row in db.execute("SELECT * FROM photos WHERE url NOT LIKE 'public-crop:%' ORDER BY rowid").fetchall():
            if len(new) >= limit:
                break
            if row["page_url"] not in pages:
                continue
            parent = json.loads(row["record"])
            box = left_card_box(parent["width"], parent["height"])
            if not box:
                continue
            canonical_url(parent["official_image_url"])
            path = Path(parent["local_file"]).resolve()
            if not path.is_relative_to((DIRECTORY / "files").resolve()) or sha256(path) != parent["sha256"]:
                raise ValueError("Public parent cache changed; no crop made.")
            derivation_id = hashlib.sha256((parent["sha256"] + json.dumps(box)).encode()).hexdigest()
            key = "public-crop:" + derivation_id
            if db.execute("SELECT 1 FROM photos WHERE url=?", (key,)).fetchone():
                continue
            with Image.open(path) as source:
                cropped = source.convert("RGB").crop(box)
                data = io.BytesIO()
                cropped.save(data, "PNG")
                raw = data.getvalue()
            target = DIRECTORY / "files/crops" / (derivation_id + ".png")
            target.parent.mkdir(exist_ok=True, parents=True)
            if target.exists():
                if target.read_bytes() != raw:
                    raise ValueError("Existing crop bytes differ; refusing an overwrite.")
            else:
                temp = target.with_suffix(".png.part")
                temp.write_bytes(raw)
                temp.replace(target)
            asset = {
                "source": "crop_from_public_official_caption_graphic", "local_file": str(target.resolve()),
                "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "format": "PNG",
                "width": box[2] - box[0], "height": box[3] - box[1],
                "official_image_url": parent["official_image_url"], "official_page_url": row["page_url"],
                "downloaded_at_epoch": parent["downloaded_at_epoch"], "derived_at_epoch": time.time(),
                "byte_identical_to_wiki_copy": None,
                "derivation": {"parent_sha256": parent["sha256"], "parent_local_file": parent["local_file"],
                               "box": box, "method": "full_height_left_card_with_neutral_margin",
                               "resized": False, "not_an_original_single_card_scan_claim": True},
            }
            db.execute("INSERT INTO photos(url,page_url,record) VALUES (?,?,?)",
                       (key, row["page_url"], json.dumps(asset, ensure_ascii=False)))
            db.execute("INSERT OR IGNORE INTO resource_sources VALUES (?,?)", (key, row["page_url"]))
            db.commit()
            new.append({"url": key, "source_page": row["page_url"], "derivation": asset["derivation"]})
        dump_json(ROOT / "sources/current-access/public-collage-crop-discovery.json",
                  {"new_candidates": new, "count": len(new), "network_downloads": 0, "not_verified_as_cards_yet": True})
        print(json.dumps({"new_crop_candidates": len(new), "network_downloads": 0}), flush=True)
    finally:
        db.close()


def process(limit, workers, model):
    db = initialize(DIRECTORY)
    from tool_paths import DEFAULT_ENV
    config = settings(DEFAULT_ENV)
    assets = {}
    seeds = {}

    def reader(path, values, full=False):
        asset = assets[path]
        if full:
            result = separate_rarity_token(read_details(asset, values, model=model))
            return separate_regulation_tokens(seeds[path], result)
        if sha256(Path(path)) != asset["sha256"]:
            raise ValueError("Public crop changed; no model upload was made.")
        result = separate_rarity_token(ocr(path, values, model=model))
        seeds[path] = result["reading"]
        return result

    pipeline = OCRPipeline(db, config, workers=workers, reader=reader)
    completed = False
    try:
        rows = db.execute("""SELECT * FROM photos WHERE url LIKE 'public-crop:%'
                            AND (ocr IS NULL OR second_ocr IS NULL) ORDER BY rowid LIMIT ?""", (limit,)).fetchall()
        for row in rows:
            row = dict(row)
            if row["ocr"]:
                old_json = row["ocr"]
                original = json.loads(old_json)
                parsed = separate_rarity_token(original)
                if parsed != original:
                    row["ocr"] = json.dumps(parsed, ensure_ascii=False)
                    db.execute("UPDATE photos SET ocr=? WHERE url=? AND ocr IS ?",
                               (row["ocr"], row["url"], old_json))
                    db.commit()
            asset = json.loads(row["record"])
            path = Path(asset["local_file"]).resolve()
            if not path.is_relative_to((DIRECTORY / "files/crops").resolve()):
                raise ValueError("Only public crop receipts may be processed.")
            assets[str(path)] = asset
            if row["ocr"]:
                seeds[str(path)] = json.loads(row["ocr"])["reading"]
            pipeline.submit(row["url"], asset, row)
        pipeline.close()
        completed = True
    finally:
        if not completed:
            pipeline.close(interrupted=True)
        db.close()


def recheck(limit, model):
    """Explicit one-time quality retry; keep all prior model observations intact."""
    db = initialize(DIRECTORY)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS crop_rechecks(url TEXT,model TEXT,at REAL,PRIMARY KEY(url,model));
        CREATE TABLE IF NOT EXISTS ocr_history(url TEXT,column_name TEXT,record TEXT,at REAL,reason TEXT,
                                              PRIMARY KEY(url,column_name,reason));
    """)
    count = 0
    try:
        for row in db.execute("SELECT * FROM photos WHERE url LIKE 'public-crop:%' ORDER BY rowid").fetchall():
            if count >= limit:
                break
            if db.execute("SELECT 1 FROM crop_rechecks WHERE url=? AND model=?", (row["url"], model)).fetchone():
                continue
            if row["ocr"] and row["second_ocr"] and agreement(
                    json.loads(row["ocr"])["reading"], json.loads(row["second_ocr"])["reading"]):
                continue
            for column in ("ocr", "second_ocr"):
                if row[column]:
                    db.execute("INSERT OR IGNORE INTO ocr_history VALUES (?,?,?,?,?)",
                               (row["url"], column, row[column], time.time(), "bounded_crop_quality_retry_" + model))
            db.execute("UPDATE photos SET ocr=NULL,second_ocr=NULL WHERE url=?", (row["url"],))
            db.execute("INSERT INTO crop_rechecks VALUES (?,?,?)", (row["url"], model, time.time()))
            count += 1
        db.commit()
        print(json.dumps({"public_crops_queued_for_quality_review": count, "model": model}), flush=True)
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["discover", "process", "recheck"])
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--model", choices=["gpt-4.1-mini-global-standard", "gpt-4.1-global-standard"],
                        default="gpt-4.1-mini-global-standard")
    args = parser.parse_args()
    if not 1 <= args.limit <= 200 or not 1 <= args.workers <= 4:
        raise SystemExit("Use a bounded 1–200 public-image batch and 1–4 model workers.")
    DIRECTORY.mkdir(exist_ok=True, parents=True)
    with (DIRECTORY / ".public-crops.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "discover":
            discover(args.limit)
        elif args.command == "recheck":
            recheck(args.limit, args.model)
        else:
            process(args.limit, args.workers, args.model)
