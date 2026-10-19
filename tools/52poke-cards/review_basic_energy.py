"""One audited, bounded stronger-model review of ambiguous basic-Energy pictures."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sqlite3
import time

from accept_official_candidates import agreement, name, number
from collect_official_candidates import DIRECTORY, ocr, settings
from download_images import ROOT, sha256
from export_display_metadata import read_only
from image_identity import printed_set
from tool_paths import DEFAULT_ENV

MODEL = "gpt-4.1-global-standard"


def expected_identity(first, second, use):
    printed = number(first.get("number"))
    return bool(
        agreement(first, second) and first.get("hp") is None
        and printed and printed[0] == "fraction" and printed[1] == use["number_numerator"]
        and printed_set(first.get("set_code"), first.get("number")) == printed_set(use["set_code"])
        and name(first.get("name")) == name(re.sub(r"（[^（）]+）$", "", use["title"]))
    )


def run(limit):
    source = read_only(ROOT / "images-zh-hans/queue.sqlite")
    targets = []
    for row in source.execute("SELECT * FROM jobs WHERE active=1 AND status!='done'"):
        for use in json.loads(row["uses_json"]):
            if use.get("supplementary_basic_energy_header"):
                targets.append((dict(row), use))
    source.close()
    db = sqlite3.connect(DIRECTORY / "candidates.sqlite")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS focused_reviews(
            url TEXT,model TEXT,at REAL,status TEXT,first TEXT,second TEXT,error TEXT,
            PRIMARY KEY(url,model));
        CREATE TABLE IF NOT EXISTS ocr_history(
            url TEXT,column_name TEXT,record TEXT,at REAL,reason TEXT,
            PRIMARY KEY(url,column_name,reason));
    """)
    config = settings(DEFAULT_ENV)
    reviewed = 0
    try:
        for job, use in targets:
            for photo in db.execute("SELECT * FROM photos WHERE page_url=? AND ocr IS NOT NULL",
                                    (job["source_url"],)).fetchall():
                first = json.loads(photo["ocr"])["reading"]
                identity = number(first.get("number"))
                if (not identity or identity[0] != "fraction" or identity[1] != use["number_numerator"]
                        or printed_set(first.get("set_code"), first.get("number")) != printed_set(use["set_code"])):
                    continue
                if not photo["second_ocr"] and first.get("confidence", 0) >= .98:
                    continue  # The ordinary processor may already be completing this second read.
                changed = db.execute("INSERT OR IGNORE INTO focused_reviews(url,model,at,status) VALUES (?,?,?,'running')",
                                     (photo["url"], MODEL, time.time())).rowcount
                db.commit()
                if not changed:
                    continue
                reviewed += 1
                record = json.loads(photo["record"])
                try:
                    if sha256(Path(record["local_file"])) != record["sha256"]:
                        raise ValueError("Public card cache changed; no upload was made.")
                    reads = [ocr(record["local_file"], config, full=full, model=MODEL) for full in (False, True)]
                    valid = expected_identity(reads[0]["reading"], reads[1]["reading"], use)
                    status = "needs_review"
                    if valid:
                        count = db.execute("""
                            UPDATE photos SET ocr=?,second_ocr=?
                            WHERE url=? AND ocr IS ? AND second_ocr IS ?
                        """, (json.dumps(reads[0], ensure_ascii=False), json.dumps(reads[1], ensure_ascii=False),
                              photo["url"], photo["ocr"], photo["second_ocr"])).rowcount
                        status = "applied" if count else "concurrent_change_preserved"
                        if count:
                            for column in ("ocr", "second_ocr"):
                                if photo[column]:
                                    db.execute("INSERT OR IGNORE INTO ocr_history VALUES (?,?,?,?,?)",
                                               (photo["url"], column, photo[column], time.time(), "focused_basic_energy_gpt41_v1"))
                    db.execute("UPDATE focused_reviews SET status=?,first=?,second=? WHERE url=? AND model=?",
                               (status, json.dumps(reads[0], ensure_ascii=False), json.dumps(reads[1], ensure_ascii=False),
                                photo["url"], MODEL))
                    db.commit()
                    print(json.dumps({"filename": job["filename"], "review_status": status}, ensure_ascii=False), flush=True)
                except Exception as exc:
                    # Do not persist configuration, endpoint, payload or server exception bodies.
                    db.execute("UPDATE focused_reviews SET status='error',error=? WHERE url=? AND model=?",
                               (type(exc).__name__, photo["url"], MODEL))
                    db.commit()
                    raise RuntimeError(f"Focused OCR failed ({type(exc).__name__}); no credentials logged.") from None
                if reviewed >= limit:
                    return
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.limit <= 2:
        raise SystemExit("Use at most two focused reviews; at most four model calls.")
    run(args.limit)
