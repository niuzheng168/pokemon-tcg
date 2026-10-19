"""Apply explicit assistant visual-review receipts for header-only basic Energy.

This is not an OCR confidence override or a human-review claim. The receipt must
record the inspected bytes, printed code/number and visible type symbol. Language
is checked against the printed edition's language in the archived metadata.
"""
from __future__ import annotations

import argparse
import fcntl
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from accept_official_candidates import name, number
from basic_energy_sources import mainland_sources
from collect_official_candidates import DIRECTORY
from download_images import ROOT, connect, dump_json, get_meta, sha256, summary
from export_display_metadata import read_only
from image_identity import printed_set

SYMBOLS = {"Grass": "草", "Fire": "火", "Water": "水", "Lightning": "雷",
           "Psychic": "超", "Fighting": "斗", "Darkness": "恶", "Metal": "钢"}


def validate(review, use, photo, edition_languages):
    if (review.get("method") != "assistant_visual_inspection" or review.get("human_reviewed") is not False
            or not review.get("reviewer") or not review.get("inspected_evidence")
            or not use.get("supplementary_basic_energy_header")):
        raise ValueError("Explicit non-human visual inspection of a supported basic-Energy reference is required.")
    asset = json.loads(photo["record"])
    if review["sha256"] != asset["sha256"] or review["image_url"] != photo["url"]:
        raise ValueError("Reviewed bytes/image URL do not match the cached asset.")
    identifier = number(review.get("printed_number"))
    code = printed_set(review.get("printed_set_code"))
    if (not identifier or identifier[0] != "fraction" or identifier[1] != use["number_numerator"]
            or code != printed_set(use["set_code"])):
        raise ValueError("The observed printed identifier does not match the archived File reference.")
    symbol = SYMBOLS.get(review.get("observed_type_symbol"))
    if (symbol != use.get("basic_energy_type")
            or name(review.get("canonical_name")) != name(re.sub(r"（[^（）]+）$", "", use["title"]))):
        raise ValueError("The observed Energy type/name does not match the basic-Energy header.")
    if review.get("image_language") != "zh-Hans" or edition_languages.get(code) != {"zh-Hans"}:
        raise ValueError("The printed edition must unambiguously be Simplified Chinese in the archive.")
    return asset


def run(path):
    receipt = json.loads(path.read_text())
    reviews = receipt["reviews"]
    if not 1 <= len(reviews) <= 8:
        raise ValueError("Only a bounded batch of at most eight basic-Energy visual receipts is supported.")
    metadata = read_only(ROOT / "data/2026.10.18/cards.sqlite")
    languages = {}
    try:
        archive_sha = json.loads(metadata.execute("SELECT value FROM metadata WHERE key='archive_sha256'").fetchone()[0])
        for (value,) in metadata.execute("SELECT record_json FROM extracts WHERE status='card'"):
            for printing in json.loads(value)["printings"]:
                code = printed_set(printing.get("set_code"))
                if code:
                    languages.setdefault(code, set()).add(printing["language"])
    finally:
        metadata.close()
    photos = read_only(DIRECTORY / "candidates.sqlite")
    directory = ROOT / "images-zh-hans"
    applied = []
    with (directory / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        queue = connect(directory)
        try:
            if get_meta(queue, "plan")["archive_sha256"] != archive_sha:
                raise ValueError("Image queue and metadata archive fingerprints differ.")
            for review in reviews:
                job = queue.execute("SELECT * FROM jobs WHERE filename=? AND active=1", (review["wiki_filename"],)).fetchone()
                photo = photos.execute("SELECT * FROM photos WHERE url=?", (review["image_url"],)).fetchone()
                if not job or not photo:
                    raise ValueError("The exact archived reference and cached official photo must exist.")
                uses = json.loads(job["uses_json"])
                if len(uses) != 1 or photo["page_url"] not in mainland_sources(job["source_evidence"]):
                    raise ValueError("The photo's official source does not match the exact archived File source.")
                asset = validate(review, uses[0], photo, languages)
                if sha256(Path(asset["local_file"])) != asset["sha256"]:
                    raise ValueError("Cache changed since visual review.")
                evidence = {
                    "method": "assistant_visual_review_exact_archived_basic_energy_source_code_number_type",
                    "human_reviewed": False, "assistant_visual_reviewed": True, "visual_receipt": review,
                    "basic_energy_header": True, "wiki_file_page_id": job["file_page_id"],
                    "wiki_file_revision_id": job["file_revision_id"],
                    "language_basis": "observed_printed_edition_code_unambiguously_zh-Hans_in_same_archive",
                    "full_number_source": "direct_visual_inspection_not_a_wiki_printing_row",
                    "reading": {"name": review["canonical_name"], "set_code": review["printed_set_code"],
                                "number": review["printed_number"], "hp": None, "language": "zh-Hans"},
                }
                asset.update({"image_language": "zh-Hans", "matching_evidence": evidence})
                queue.execute("INSERT OR REPLACE INTO assets VALUES (?,?)",
                              (photo["url"], json.dumps(asset, ensure_ascii=False)))
                queue.execute("UPDATE jobs SET status='done',asset_url=?,source_url=?,error=NULL WHERE filename=?",
                              (photo["url"], photo["page_url"], job["filename"]))
                queue.execute("INSERT OR REPLACE INTO file_verifications VALUES (?,?)",
                              (job["filename"], json.dumps(evidence, ensure_ascii=False)))
                applied.append(job["filename"])
            queue.commit()
            summary(queue, directory)
        finally:
            queue.close()
            photos.close()
    result = {"applied_visual_reviews": applied, "human_reviewed": False, "model_readings_unchanged": True}
    dump_json(ROOT / "sources/current-access/basic-energy-visual-review-result.json", result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    run(parser.parse_args().receipt)
