"""Minute-by-minute local download progress. Counts candidates separately from accepted scans."""
from __future__ import annotations
import argparse
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent


def snapshot(pid=None):
    q = sqlite3.connect(f"file:{ROOT / 'images-zh-hans/queue.sqlite'}?mode=ro", uri=True)
    counts = dict(q.execute("SELECT status,count(*) FROM jobs WHERE active=1 GROUP BY status"))
    accepted = [json.loads(r[0]) for r in q.execute("SELECT record_json FROM assets")]
    accepted_hashes = {a["sha256"] for a in accepted}
    q.close()
    extra_assets = []
    extra_statuses = {}
    for directory in ["images", "images-academy-zh-hant"]:
        extra_path = ROOT / directory / "queue.sqlite"
        if extra_path.exists():
            extra = sqlite3.connect(f"file:{extra_path}?mode=ro", uri=True)
            extra_assets.extend(json.loads(r[0]) for r in extra.execute("SELECT record_json FROM assets"))
            if directory == "images-academy-zh-hant":
                extra_statuses = dict(extra.execute("SELECT status,count(*) FROM jobs WHERE active=1 GROUP BY status"))
            extra.close()
    candidates = []
    path = ROOT / "official-candidates/candidates.sqlite"
    if path.exists():
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        candidates = [json.loads(r[0]) for r in c.execute("SELECT record FROM photos")]
        ocr = c.execute("SELECT count(*) FROM photos WHERE second_ocr IS NOT NULL").fetchone()[0]
        c.close()
    else:
        ocr = 0
    details = {}
    roles = {}
    if path.exists():
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "resource_jobs" in tables:
            details["download_manifest_urls"] = c.execute("SELECT count(*) FROM resource_jobs").fetchone()[0]
            details["download_queue_statuses"] = dict(c.execute(
                "SELECT status,count(*) FROM resource_jobs GROUP BY status"))
            details["source_page_statuses"] = dict(c.execute(
                "SELECT status,count(*) FROM source_jobs GROUP BY status"))
            details["recent_transfers"] = [
                {"bytes": b, "seconds": round(s, 2)} for b, s in c.execute(
                    "SELECT bytes,seconds FROM transfers ORDER BY at DESC LIMIT 8")]
            roles = {k.removesuffix("_status"): json.loads(v) for k, v in c.execute(
                "SELECT key,value FROM state WHERE key IN ('planner_status','downloader_status','processor_status','wiki_metadata_status','academy_images_status')")}
            details["workers_running"] = {}
            for role, value in roles.items():
                try:
                    command = Path(f"/proc/{value['pid']}/cmdline").read_bytes()
                    details["workers_running"][role] = value["status"] in {"running", "waiting"} and (
                        b"image_pipeline.py" in command or b"wiki_image_hashes.py" in command
                        or b"academy_chinese_images.py" in command)
                except (FileNotFoundError, PermissionError):
                    details["workers_running"][role] = False
        if "ocr_reviews" in tables:
            details["ocr_first_reading_deferred"] = c.execute("SELECT count(*) FROM ocr_reviews").fetchone()[0]
            details["ocr_errors"] = c.execute("SELECT count(*) FROM ocr_errors").fetchone()[0]
        c.close()
    live = False
    if pid:
        try:
            command = Path(f"/proc/{pid}/cmdline").read_bytes()
            live = b"collect_official_candidates.py" in command or b"image_pipeline.py" in command
        except (FileNotFoundError, PermissionError):
            pass
    all_assets = accepted + candidates + extra_assets
    crops = {a["sha256"]: a for a in all_assets if a.get("source") == "crop_from_public_official_caption_graphic"}
    unique = {a["sha256"]: a for a in all_assets
              if a.get("source") != "crop_from_public_official_caption_graphic"
              if Path(a["local_file"]).is_file() and Path(a["local_file"]).stat().st_size == a["bytes"]}
    return {
        "at_epoch": time.time(), "time": datetime.now(ZoneInfo("Asia/Hong_Kong")).isoformat(timespec="seconds"),
        "confirmed_jobs": counts.get("done", 0), "total_explicit_wiki_references": sum(counts.values()),
        "confirmed_bytes": sum(a["bytes"] for a in accepted), "statuses": counts,
        "official_candidate_resources_cached": len(candidates), "double_ocr_completed": ocr,
        "candidate_resources_not_accepted": sum(a["sha256"] not in accepted_hashes for a in candidates),
        "downloaded_image_files": len(unique),
        "downloaded_image_bytes": sum(a["bytes"] for a in unique.values()),
        "local_public_crop_files_not_network_downloads": len(crops),
        "local_public_crop_bytes_not_network_downloads": sum(a["bytes"] for a in crops.values()),
        "website_traditional_queue_statuses": extra_statuses,
        "collector_pid": pid, "collector_live": live,
        "workers": roles, **details,
        "note": "Candidates can include posters; only exact accepted matches count as confirmed cards. Missing wiki image references are not included in the denominator.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--accept", action="store_true", help="Apply the existing strict two-OCR matcher before each snapshot.")
    args = parser.parse_args()
    if args.interval < 60:
        raise SystemExit("Progress interval must be at least 60 seconds.")
    previous = None
    while True:
        if args.accept:
            subprocess.run([sys.executable, str(ROOT / "accept_official_candidates.py"), "--apply"], check=True,
                           stdout=subprocess.DEVNULL)
        state = snapshot(args.pid)
        if previous:
            state["new_confirmed_since_previous"] = state["confirmed_jobs"] - previous["confirmed_jobs"]
            state["new_candidate_resources_since_previous"] = state["official_candidate_resources_cached"] - previous["official_candidate_resources_cached"]
            state["new_downloaded_files_since_previous"] = state["downloaded_image_files"] - previous["downloaded_image_files"]
        (ROOT / "sources/current-access/progress-latest.json").write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(state, ensure_ascii=False), flush=True)
        previous = state
        if args.pid and not state["collector_live"] and not any(state.get("workers_running", {}).values()):
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
