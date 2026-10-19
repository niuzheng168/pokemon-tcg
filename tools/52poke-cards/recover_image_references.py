"""Recover real archived File pages omitted from printing image fields.

Discovery scans the local archive, never constructs a CDN image URL, and never
declares an image Chinese based on its filename. A candidate still needs exact
source-page, printed series/full number/name and two-read image verification.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import fcntl
import json
from pathlib import Path
import re
import time

from basic_energy_sources import mainland_sources
from download_images import ROOT, canonical_filename, connect, dump_json, get_meta, set_meta, sha256, summary
from export_display_metadata import read_only
from image_identity import printed_number, printed_set
from import_cards import iterate_pages

REPORT = ROOT / "sources/current-access/recovered-file-reference-candidates.json"
ARCHIVE = ROOT / "downloads/52poke-2026.10.18.xml.gz"
IMAGE_QUEUE = ROOT / "images-zh-hans"
FILE_PATTERN = re.compile(r"(.+?)(\d{3})\.(?:png|jpe?g)", re.I)


def candidates(records, file_names, known):
    identities, prefixes = defaultdict(dict), defaultdict(set)
    for record in records:
        if "tcg" not in record["games"]:
            continue
        for printing in record["printings"]:
            identity, code = printed_number(printing.get("number")), printed_set(printing.get("set_code"))
            if (printing["language"] != "zh-Hans" or not identity
                    or identity[0] not in {"fraction", "promo"} or not code):
                continue
            filename = (printing.get("image") or {}).get("file_name")
            use = {
                "page_id": record["page_id"], "title": record["title"], "revision_id": record["revision_id"],
                "set_code": code, "number": printing["number"], "language": "zh-Hans",
                "template_index": printing["source_template_index"], "original_image_field": filename,
            }
            identities[(code, identity[1])][(record["page_id"], identity)] = use
            prefixes[code].add(code)
            # Aliases must themselves be evidenced by an explicit printing image.
            if filename and (match := FILE_PATTERN.fullmatch(filename)) and int(match[2]) == identity[1]:
                prefixes[match[1].upper()].add(code)
    result = {}
    for filename in file_names:
        filename = canonical_filename(filename)
        if not filename or filename in known or not (match := FILE_PATTERN.fullmatch(filename)):
            continue
        choices = prefixes.get(match[1].upper(), set())
        if len(choices) != 1:
            continue
        uses = identities.get((next(iter(choices)), int(match[2])), {})
        # A filename does not reveal the denominator or which of two wiki pages is intended.
        if len(uses) == 1:
            result[filename] = next(iter(uses.values()))
    return result


def discover():
    db = read_only(ROOT / "data/2026.10.18/cards.sqlite")
    queue = read_only(IMAGE_QUEUE / "queue.sqlite")
    try:
        metadata = {k: json.loads(v) for k, v in db.execute("SELECT key,value FROM metadata")}
        if sha256(ARCHIVE) != metadata["archive_sha256"]:
            raise ValueError("Cached archive and metadata fingerprint differ.")
        known = {row[0] for row in queue.execute("SELECT filename FROM jobs WHERE active=1")}
        targets = candidates(
            (json.loads(row[0]) for row in db.execute("SELECT record_json FROM extracts WHERE status='card'")),
            (row[0] for row in db.execute("SELECT title FROM pages WHERE namespace=6")), known,
        )
    finally:
        db.close()
        queue.close()
    print(f"Scanning cached archive for {len(targets)} unique, existing File-page candidates.", flush=True)
    found, started = [], time.monotonic()
    for page in iterate_pages(ARCHIVE):
        if page["namespace"] != 6:
            continue
        filename = canonical_filename(page["title"])
        if filename in targets:
            found.append({
                "filename": filename, "use": targets.pop(filename), "file_page_id": page["page_id"],
                "file_revision_id": page["revision_id"], "source_evidence": page["wikitext"],
            })
        if not targets:
            break
    report = {
        "archive_sha256": metadata["archive_sha256"], "candidates": found, "not_found": sorted(targets),
        "elapsed_seconds": time.monotonic() - started,
        "note": "Discovered references only, not downloaded or language-verified images.",
    }
    dump_json(REPORT, report)
    count = sum(len(mainland_sources(row["source_evidence"])) == 1 for row in found)
    print(json.dumps({"existing_file_pages": len(found), "unique_mainland_sources": count}), flush=True)


def prepare():
    report = json.loads(REPORT.read_text())
    with (IMAGE_QUEUE / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        queue = connect(IMAGE_QUEUE)
        try:
            plan = get_meta(queue, "plan")
            if plan["archive_sha256"] != report["archive_sha256"]:
                raise ValueError("Discovery report and target queue belong to different archives.")
            added, files = 0, []
            for row in report["candidates"]:
                sources = mainland_sources(row["source_evidence"])
                if len(sources) != 1:
                    continue
                filename = row["filename"]
                use = {**row["use"], "referenced_filename": filename, "parameter": "recovered_File_identity",
                       "recovered_existing_File_for_printing": True,
                       "language_is_requested_target_not_image_verification": True}
                queue.execute("""
                    INSERT OR IGNORE INTO jobs(
                        filename,active,file_page_id,file_revision_id,uses_json,source_url,source_evidence,status,error)
                    VALUES (?,1,?,?,?,?,?,'unresolved',?)
                """, (filename, row["file_page_id"], row["file_revision_id"],
                      json.dumps([use], ensure_ascii=False), sources[0], row["source_evidence"],
                      "Recovered existing File candidate; printed identity and image language not yet verified."))
                added += queue.execute("SELECT changes()").fetchone()[0]
                files.append(filename)
            plan["recovered_existing_printing_files"] = {
                "report": str(REPORT), "report_sha256": sha256(REPORT), "filenames": files,
                "raw_metadata_unchanged": True,
            }
            set_meta(queue, "plan", plan)
            queue.commit()
            summary(queue, IMAGE_QUEUE)
            print(json.dumps({"new_target_references": added, "unique_source_candidates": len(files)}), flush=True)
        finally:
            queue.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["discover", "prepare"])
    args = parser.parse_args()
    discover() if args.command == "discover" else prepare()
