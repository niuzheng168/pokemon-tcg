"""Add omitted basic-Energy header references without guessing their image language.

Only explicit base=y Energy headers whose archived File page cites a mainland
official TCG page are eligible. Image language and the full printed identifier
still require two matching readings before an asset can be accepted.
"""
from __future__ import annotations

import argparse
import fcntl
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit

import mwparserfromhell as mw

from download_images import ROOT, connect, get_meta, set_meta, summary
from export_display_metadata import CONVERTER, read_only
from import_cards import template_name

DIRECTORY = ROOT / "images-zh-hans"


def mainland_sources(text):
    urls = set()
    for template in mw.parse(text or "").filter_templates(recursive=True):
        if template_name(str(template.name)) not in {"来源", "來源", "source"}:
            continue
        for param in template.params:
            for link in mw.parse(str(param.value)).filter_external_links():
                url = str(link.url).strip()
                parsed = urlsplit(url)
                try:
                    allowed = (parsed.scheme == "https" and parsed.hostname == "www.pokemon.cn"
                               and not parsed.username and not parsed.password
                               and parsed.port in (None, 443) and parsed.path.startswith("/tcg/"))
                except ValueError:
                    allowed = False
                if allowed:
                    urls.add(url)
    return sorted(urls)


def reference_for(card, file_job):
    blocks = card.get("card_blocks", [])
    if "tcg" not in card.get("games", []) or len(blocks) != 1:
        return None
    block = blocks[0]
    if (block["game"] != "tcg" or block["kind"] != "energy"
            or str(block.get("header", {}).get("base", "")).casefold() != "y"
            or any(block.get(key) for key in ("attacks", "abilities", "effects"))
            or CONVERTER.convert(block.get("type") or "") not in {"草", "火", "水", "雷", "超", "斗", "恶", "钢"}):
        return None
    refs = [ref for ref in card.get("images", [])
            if ref.get("source_template_index") == block["source_template_index"] and ref.get("parameter") == "image"]
    if len(refs) != 1 or refs[0]["file_name"] != file_job["filename"]:
        return None
    filename = file_job["filename"]
    code = re.fullmatch(r"([A-Za-z0-9.]*[A-Za-z])(\d{3})\.(?:png|jpe?g)", filename, re.I)
    if not code or not file_job.get("file_page_id") or not file_job.get("file_revision_id"):
        return None
    urls = mainland_sources(file_job.get("source_evidence"))
    if len(urls) != 1:
        return None
    return {
        "filename": filename, "source_url": next(iter(urls)),
        "file_page_id": file_job["file_page_id"], "file_revision_id": file_job["file_revision_id"],
        "source_evidence": file_job["source_evidence"],
        "use": {
            "page_id": card["page_id"], "title": card["title"], "revision_id": card["revision_id"],
            "parameter": "image", "template_index": block["source_template_index"],
            "referenced_filename": filename, "language": "zh-Hans",
            "language_is_requested_target_not_image_verification": True,
            "set_code": code[1], "number": None, "number_numerator": int(code[2]),
            "basic_energy_type": CONVERTER.convert(block["type"]),
            "supplementary_basic_energy_header": True,
            "identity_basis": "explicit_archived_basic_energy_header_and_exact_File_source",
        },
    }


def prepare():
    metadata = read_only(ROOT / "data/2026.10.18/cards.sqlite")
    original = read_only(ROOT / "images/queue.sqlite")
    try:
        expected = json.loads(metadata.execute("SELECT value FROM metadata WHERE key='archive_sha256'").fetchone()[0])
        original_plan = json.loads(original.execute("SELECT value FROM metadata WHERE key='plan'").fetchone()[0])
        if original_plan["archive_sha256"] != expected:
            raise ValueError("Original references and metadata must come from the same archive.")
        headers = []
        for (value,) in metadata.execute("SELECT record_json FROM extracts WHERE status='card'"):
            card = json.loads(value)
            if card.get("kinds") != ["energy"]:
                continue
            for ref in card["images"]:
                row = original.execute("SELECT * FROM jobs WHERE filename=?", (ref["file_name"],)).fetchone()
                if row and (header := reference_for(card, dict(row))):
                    headers.append(header)
    finally:
        metadata.close()
        original.close()
    with (DIRECTORY / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        queue = connect(DIRECTORY)
        try:
            plan = get_meta(queue, "plan")
            if plan["archive_sha256"] != expected:
                raise ValueError("Target image queue belongs to a different archive.")
            added = 0
            for header in headers:
                queue.execute("""
                    INSERT OR IGNORE INTO jobs(
                        filename,active,file_page_id,file_revision_id,uses_json,source_url,source_evidence,status,error)
                    VALUES (?,1,?,?,?,?,?,'unresolved',?)
                """, (header["filename"], header["file_page_id"], header["file_revision_id"],
                      json.dumps([header["use"]], ensure_ascii=False), header["source_url"], header["source_evidence"],
                      "Header-only basic Energy reference; image language and full number await verification."))
                added += queue.execute("SELECT changes()").fetchone()[0]
            plan["supplementary_basic_energy_headers"] = [header["filename"] for header in headers]
            set_meta(queue, "plan", plan)
            queue.commit()
            summary(queue, DIRECTORY)
            print(json.dumps({"header_references": len(headers), "new_jobs": added,
                              "language_not_inferred_from_filename": True}, ensure_ascii=False))
        finally:
            queue.close()


def recheck():
    """One bounded, audited re-read for the eight newly supported header-only identities."""
    queue = read_only(DIRECTORY / "queue.sqlite")
    targets = []
    for row in queue.execute("SELECT uses_json,source_url FROM jobs WHERE active=1"):
        for use in json.loads(row["uses_json"]):
            if use.get("supplementary_basic_energy_header"):
                targets.append((use["set_code"].upper(), use["number_numerator"], row["source_url"]))
    queue.close()
    if len(targets) > 8:
        raise ValueError("Review this batch before re-reading more than eight basic Energy images.")
    db = sqlite3.connect(ROOT / "official-candidates/candidates.sqlite")
    db.row_factory = sqlite3.Row
    try:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS ocr_history(
                url TEXT,column_name TEXT,record TEXT,at REAL,reason TEXT,
                PRIMARY KEY(url,column_name,reason));
        """)
        from image_identity import printed_number, printed_set
        count = 0
        for photo in db.execute("SELECT * FROM photos WHERE ocr IS NOT NULL").fetchall():
            first = json.loads(photo["ocr"])["reading"]
            identity = printed_number(first.get("number"))
            if not identity or identity[0] != "fraction":
                continue
            key = (printed_set(first.get("set_code"), first.get("number")), identity[1], photo["page_url"])
            if key not in targets:
                continue
            reason = "newly_supported_archived_basic_energy_header_v1"
            if db.execute("SELECT 1 FROM ocr_history WHERE url=? AND reason=?", (photo["url"], reason)).fetchone():
                continue
            for column in ("ocr", "second_ocr"):
                if photo[column]:
                    db.execute("INSERT INTO ocr_history VALUES (?,?,?,?,?)",
                               (photo["url"], column, photo[column], time.time(), reason))
            db.execute("UPDATE photos SET ocr=NULL,second_ocr=NULL WHERE url=?", (photo["url"],))
            db.execute("DELETE FROM ocr_reviews WHERE url=?", (photo["url"],))
            count += 1
        db.commit()
        print(json.dumps({"recheck_queued": count, "previous_readings_preserved": True}))
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "recheck"])
    args = parser.parse_args()
    prepare() if args.command == "prepare" else recheck()
