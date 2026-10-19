"""Associate official candidate scans only when two OCR readings and wiki identity agree."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import fcntl
import json
from pathlib import Path
import re
import sqlite3
import unicodedata
from urllib.parse import urlsplit, urlunsplit

from collect_official_candidates import DIRECTORY
from download_images import ROOT, connect, dump_json, sha256, summary
from export_academy import clean_zh
from image_identity import printed_number as number, printed_set


def name(value):
    text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", clean_zh(value))).casefold()
    # Unambiguous printed type symbols, only in basic Energy names.
    return {"基本⚡能量": "基本雷能量", "基本⚡️能量": "基本雷能量",
            "基本🔥能量": "基本火能量", "基本🌑能量": "基本恶能量",
            "基本👁能量": "基本超能量", "基本👁️能量": "基本超能量"}.get(text, text)


def page(url):
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, p.path.rstrip("/"), "", ""))


def agreement(first, second):
    if any(read.get("language") != "zh-Hans" or read.get("confidence", 0) < .98 for read in (first, second)):
        return False
    return (
        printed_set(first.get("set_code"), first.get("number"))
        and printed_set(first.get("set_code"), first.get("number")) == printed_set(second.get("set_code"), second.get("number"))
        and number(first.get("number")) and number(first["number"]) == number(second.get("number"))
        and name(first.get("name", "")) == name(second.get("name", ""))
        and first.get("hp") == second.get("hp")
    )


def retain_stronger_evidence(old_evidence, old_asset, new_evidence, new_asset):
    same_bytes = old_asset and old_asset.get("sha256") == new_asset.get("sha256")
    if old_evidence.get("byte_identical_to_wiki_copy") and not same_bytes:
        return None  # Do not replace a byte-exact original with a merely equivalent printing/crop.
    if same_bytes:
        return {**old_evidence, **new_evidence}
    return new_evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    candidates = sqlite3.connect(f"file:{DIRECTORY / 'candidates.sqlite'}?mode=ro", uri=True)
    candidates.row_factory = sqlite3.Row
    directory = ROOT / "images-zh-hans"
    accepted, review = [], []
    with (directory / ".lock").open("a") as lock:
        # Cooperate with short, offline queue updates. No network requests happen
        # while holding this lock, so the minute monitor need not abort on contention.
        fcntl.flock(lock, fcntl.LOCK_EX)
        db = connect(directory)
        jobs = db.execute("SELECT * FROM jobs WHERE active=1").fetchall()
        identities = defaultdict(dict)
        energy_headers = defaultdict(dict)
        for job in jobs:
            sources = {page(u) for u in re.findall(
                r"https://www\.pokemon\.cn/[^\s\]|]+", job["source_evidence"] or "")}
            for use in json.loads(job["uses_json"]):
                if use.get("language") == "zh-Hans":
                    identity = (printed_set(use.get("set_code")), number(use.get("number")),
                                name(re.sub(r"（[^（）]+）$", "", use["title"])))
                    for source in sources:
                        identities[(source, *identity)][job["filename"]] = job
                        if use.get("supplementary_basic_energy_header"):
                            energy_key = (source, printed_set(use.get("set_code")),
                                          use["number_numerator"], identity[2])
                            energy_headers[energy_key][job["filename"]] = job
        source_map = defaultdict(set)
        if candidates.execute("SELECT 1 FROM sqlite_master WHERE name='resource_sources'").fetchone():
            for url, source in candidates.execute("SELECT url,page_url FROM resource_sources"):
                source_map[url].add(page(source))
        for photo in candidates.execute("SELECT * FROM photos WHERE ocr IS NOT NULL"):
            if not photo["second_ocr"]:
                review.append({"url": photo["url"], "reason": "second_reading_missing"})
                continue
            first, second = [json.loads(photo[k])["reading"] for k in ("ocr", "second_ocr")]
            if not agreement(first, second):
                review.append({"url": photo["url"], "reason": "OCR_readings_not_high_confidence_agreement"})
                continue
            identity = (printed_set(first.get("set_code"), first.get("number")), number(first.get("number")), name(first["name"]))
            unique = {}
            header_identity = False
            for source in source_map[photo["url"]] | {page(photo["page_url"])}:
                unique.update(identities.get((source, *identity), {}))
                printed = number(first.get("number"))
                if printed and printed[0] == "fraction" and first.get("hp") is None:
                    header_matches = energy_headers.get((source, identity[0], printed[1], identity[2]), {})
                    unique.update(header_matches)
                    header_identity = header_identity or bool(header_matches)
            matches = list(unique.values())
            if len(matches) != 1:
                review.append({"url": photo["url"], "reason": "no_unique_wiki_page_set_number_name_match",
                               "matches": len(matches), "reading": first})
                continue
            job = matches[0]
            asset = json.loads(photo["record"])
            if asset.get("source") == "crop_from_public_official_caption_graphic" and job["status"] == "done":
                continue  # A promotional crop must not displace an already selected original.
            if sha256(Path(asset["local_file"])) != asset["sha256"]:
                raise ValueError("Candidate changed since OCR.")
            evidence = {
                "method": ("two_OCR_reads_exact_archived_basic_energy_header_source_set_numerator_name"
                           if header_identity else "two_OCR_reads_and_exact_archived_official_source_set_number_name"),
                "reading": first, "human_reviewed": False,
                "wiki_file_page_id": job["file_page_id"],
                "wiki_file_revision_id": job["file_revision_id"],
            }
            if header_identity:
                evidence["basic_energy_header"] = True
                evidence["full_number_source"] = "two_matching_reads_of_printed_image_not_a_wiki_printing_row"
            recovered = next((use for use in json.loads(job["uses_json"])
                              if use.get("recovered_existing_File_for_printing")), None)
            if recovered:
                evidence.update({
                    "method": "two_OCR_reads_exact_existing_archived_File_source_and_printing_identity",
                    "recovered_existing_File_for_printing": True,
                    "wiki_printing_template_index": recovered["template_index"],
                    "original_metadata_image_field": recovered.get("original_image_field"),
                })
            prior = db.execute("SELECT evidence FROM file_verifications WHERE filename=?", (job["filename"],)).fetchone()
            prior_asset = db.execute("SELECT record_json FROM assets WHERE url=?", (job["asset_url"],)).fetchone()
            evidence = retain_stronger_evidence(
                json.loads(prior[0]) if prior else {}, json.loads(prior_asset[0]) if prior_asset else None,
                evidence, asset,
            )
            if evidence is None:
                continue
            accepted.append({"filename": job["filename"], "url": photo["url"], "evidence": evidence})
            if args.apply:
                asset.update({"image_language": "zh-Hans", "matching_evidence": evidence})
                db.execute("INSERT OR REPLACE INTO assets VALUES (?,?)",
                           (photo["url"], json.dumps(asset, ensure_ascii=False)))
                db.execute("UPDATE jobs SET status='done',source_url=?,asset_url=?,error=NULL WHERE filename=?",
                           (photo["page_url"], photo["url"], job["filename"]))
                db.execute("INSERT OR REPLACE INTO file_verifications VALUES (?,?)",
                           (job["filename"], json.dumps(evidence, ensure_ascii=False)))
        db.commit()
        report = {"applied": args.apply, "accepted": accepted, "needs_review": review,
                  "review_reasons": dict(Counter(row["reason"] for row in review))}
        output = ROOT / "sources/current-access/official-candidate-matching.json"
        dump_json(output, report)
        if args.apply:
            summary(db, directory)
        db.close()
    print(json.dumps({"applied": args.apply, "accepted": len(accepted), "needs_review": len(review)}, indent=2))


if __name__ == "__main__":
    main()
