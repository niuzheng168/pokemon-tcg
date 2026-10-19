"""Download only missing Academy scans with exact archived Traditional sources.

This does not replace the Simplified collection goal. It fills website artwork
using the user's permitted Traditional originals while all display text stays
Simplified. Engine IDs/names/effects are never edited.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import time

from download_images import ROOT, connect, dump_json, get_meta, run, set_meta, source_matches_language, summary
from export_academy import academy_cards, exact_block
from export_display_metadata import read_only
from tool_paths import ACADEMY_ROOT

DIRECTORY = ROOT / "images-academy-zh-hant"


def select_jobs(needed, rows):
    options = defaultdict(list)
    for row in rows:
        if row["status"] not in {"pending", "done"} or not source_matches_language(row["source_url"] or "", "zh-Hant"):
            continue
        for use in json.loads(row["uses_json"]):
            if use["page_id"] in needed and use.get("language") == "zh-Hant":
                options[use["page_id"]].append(row)
    chosen = {}
    for page, variants in options.items():
        row = min(variants, key=lambda r: (
            r["status"] != "done", not r["filename"].startswith(("SV", "S-P", "SCC")), r["filename"],
        ))
        item = chosen.setdefault(row["filename"], {"job": row, "pages": set(), "cards": set()})
        item["pages"].add(page)
        item["cards"].update(needed[page])
    return chosen


def prepare(queue):
    academy = ACADEMY_ROOT
    catalog = json.loads((academy / "public/data/locales/zh-CN.js").read_text().split("export default ", 1)[1].rstrip().removesuffix(";"))
    cards, _ = academy_cards(academy)
    source = read_only(ROOT / "data/2026.10.18/cards.sqlite")
    original = read_only(ROOT / "images/queue.sqlite")
    try:
        metadata = {k: json.loads(v) for k, v in source.execute("SELECT key,value FROM metadata")}
        plan = json.loads(original.execute("SELECT value FROM metadata WHERE key='plan'").fetchone()[0])
        if not catalog["archive"]["sha256"] == plan["archive_sha256"] == metadata["archive_sha256"]:
            raise ValueError("Website catalog and source queues must come from the same archive.")
        records = {record["id"]: record for (value,) in source.execute("SELECT record_json FROM extracts WHERE status='card'")
                   for record in [json.loads(value)]}
        needed = defaultdict(list)
        for identifier, item in catalog["cards"].items():
            record = records.get(item.get("source"))
            if (not item["scan"] and record and len(record["card_blocks"]) == 1
                    and exact_block(cards[identifier], record)):
                needed[record["page_id"]].append(identifier)
        chosen = select_jobs(needed, [dict(row) for row in original.execute("SELECT * FROM jobs WHERE active=1")])
        existing = get_meta(queue, "plan")
        if existing and existing["archive_sha256"] != metadata["archive_sha256"]:
            raise ValueError("Existing website image cache belongs to another archive.")
        queue.execute("UPDATE jobs SET active=0")
        manifest = []
        for filename, item in chosen.items():
            row = item["job"]
            uses = [use for use in json.loads(row["uses_json"])
                    if use["page_id"] in item["pages"] and use.get("language") == "zh-Hant"]
            queue.execute("""
                INSERT OR IGNORE INTO jobs(filename,active,file_page_id,file_revision_id,uses_json,
                    source_url,source_evidence,status,asset_url,attempts,error,next_retry)
                VALUES (?,1,?,?,?,?,?,?,?,0,NULL,0)
            """, (filename, row["file_page_id"], row["file_revision_id"], json.dumps(uses, ensure_ascii=False),
                  row["source_url"], row["source_evidence"], row["status"], row["asset_url"]))
            queue.execute("UPDATE jobs SET active=1 WHERE filename=?", (filename,))
            if row["asset_url"]:
                asset = original.execute("SELECT record_json FROM assets WHERE url=?", (row["asset_url"],)).fetchone()
                if asset:
                    queue.execute("INSERT OR IGNORE INTO assets VALUES (?,?)", (row["asset_url"], asset[0]))
            resolution = original.execute("SELECT * FROM resolutions WHERE page_url=?", (row["source_url"],)).fetchone()
            if resolution:
                queue.execute("INSERT OR IGNORE INTO resolutions VALUES (?,?,?,?)", tuple(resolution))
            manifest.append({"filename": filename, "source_page": row["source_url"], "engine_cards": sorted(item["cards"]),
                             "image_language": "zh-Hant", "metadata_language": "zh-Hans",
                             "identity_gate": "exact_archived_card_version_and_declared_official_source"})
        set_meta(queue, "plan", {**plan, "language": "zh-Hant", "image_languages": ["zh-Hant"],
                 "scope": "Academy_missing_scans_with_structural_version_match",
                 "wiki_image_references": len(chosen), "unique_after_file_redirects": len(chosen),
                 "engine_cards_covered": len({c for item in chosen.values() for c in item["cards"]})})
        queue.commit()
        dump_json(DIRECTORY / "website-download-list.json", manifest)
        print(json.dumps({"target_images": len(chosen),
                          "engine_cards_covered": len({c for item in chosen.values() for c in item["cards"]})}), flush=True)
    finally:
        source.close()
        original.close()


def status(value):
    db = sqlite3.connect(ROOT / "official-candidates/candidates.sqlite", timeout=30)
    db.execute("INSERT OR REPLACE INTO state VALUES ('academy_images_status',?)",
               (json.dumps({"status": value, "pid": os.getpid(), "at": time.time()}),))
    db.commit()
    db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run", "status"])
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--rate-limit", type=int, default=1_000_000,
                        help="Official Asia image-host byte/s cap; never changes Wiki limits.")
    args = parser.parse_args()
    if not 1 <= args.limit <= 300:
        raise SystemExit("Use one bounded serial website-image batch of at most 300.")
    if not 1 <= args.rate_limit <= 1_000_000:
        raise SystemExit("Use a positive official-host cap of at most 1 MB/s.")
    DIRECTORY.mkdir(exist_ok=True, parents=True)
    with (DIRECTORY / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        queue = connect(DIRECTORY)
        try:
            if args.command == "prepare":
                prepare(queue)
            elif args.command == "run":
                status("running")
                try:
                    run(queue, DIRECTORY, args.limit, None, rate_limit=args.rate_limit)
                    status("complete")
                except BaseException:
                    status("stopped")
                    raise
            print(json.dumps(summary(queue, DIRECTORY), ensure_ascii=False, indent=2), flush=True)
        finally:
            queue.close()


if __name__ == "__main__":
    main()
