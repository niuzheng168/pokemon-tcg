"""Build a small, explicit-allowlist ZIP without credentials, caches or private data."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import zipfile

ROOT = Path(__file__).resolve().parent


def encoded_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def build(destination):
    report_path = ROOT / "sources/current-access/remaining-simplified-targets.json"
    queue_path = ROOT / "images-zh-hans/queue.sqlite"
    if report_path.exists() or queue_path.exists():
        if not report_path.exists() or not queue_path.exists():
            raise ValueError("Local queue/report is incomplete; regenerate the report before packaging.")
        report = json.loads(report_path.read_text())
        queue = sqlite3.connect(f"file:{queue_path}?mode=ro", uri=True)
        try:
            pending = {r[0] for r in queue.execute("SELECT filename FROM jobs WHERE active=1 AND status!='done'")}
        finally:
            queue.close()
        if pending != {t["wiki_filename"] for t in report["targets"]}:
            raise ValueError("Remaining report is stale; run report_remaining_images.py before building.")
    else:
        # A fresh clone can build the same portable program/list without local DBs.
        from portable_downloader import load_manifest
        frozen = load_manifest(ROOT / "manifests/remaining-images.json")
        report = {
            "targets": frozen["targets"],
            "generated_at_utc": frozen["source_report_generated_at_utc"],
        }
    targets = []
    for source in report["targets"]:
        targets.append({
            k: source[k] for k in (
                "wiki_filename", "wiki_file_page_id", "wiki_file_revision_id", "uses",
                "declared_source_urls", "latest_file_metadata",
            )
        })
        targets[-1]["semantic_identity_review_required"] = source.get("semantic_identity_review_required", False) or any(
            use.get("language_is_requested_target_not_image_verification") for use in source["uses"]
        )
    manifest = {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_report_generated_at_utc": report["generated_at_utc"],
        "scope": "currently unresolved explicit Simplified TCG image references, not the whole database",
        "metadata_attribution": "神奇宝贝百科 / wiki.52poke.com; CC BY-NC-SA 3.0; card image rights remain with their owners",
        "targets": targets,
    }
    ready = [t for t in targets if t["latest_file_metadata"]]
    missing = [t for t in targets if not t["latest_file_metadata"]]
    summary = {
        "generated_at_utc": manifest["generated_at_utc"],
        "target_references": len(targets), "with_original_image_url": len(ready),
        "without_original_image_url": len(missing),
        "unique_original_image_urls": len({t["latest_file_metadata"]["url"] for t in ready}),
        "known_unique_content_bytes": sum({
            t["latest_file_metadata"]["sha1"]: t["latest_file_metadata"]["size"] for t in ready
        }.values()),
        "recovered_references_requiring_semantic_review": sum(t["semantic_identity_review_required"] for t in targets),
        "includes_credentials": False, "includes_downloaded_images": False,
        "includes_restricted_research_dataset": False, "requires_source_authorized_access": True,
        "request_gap_seconds_minimum": 500, "request_window_utc_plus_08": "02:00–08:00",
    }
    table = io.StringIO(newline="")
    writer = csv.writer(table, lineterminator="\n")
    writer.writerow(["wiki_filename", "card_titles", "printing_numbers", "original_url", "sha1", "bytes", "width", "height", "semantic_review_required", "declared_sources"])
    for t in targets:
        info = t["latest_file_metadata"] or {}
        writer.writerow([
            t["wiki_filename"], " | ".join(dict.fromkeys(u["title"] for u in t["uses"])),
            " | ".join(dict.fromkeys(str(u.get("number") or "") for u in t["uses"])),
            info.get("url", ""), info.get("sha1", ""), info.get("size", ""),
            info.get("width", ""), info.get("height", ""), t["semantic_identity_review_required"],
            " | ".join(t["declared_source_urls"]),
        ])
    payload = {
        "README.md": (ROOT / "PORTABLE_DOWNLOAD_README.md").read_bytes(),
        "portable_downloader.py": (ROOT / "portable_downloader.py").read_bytes(),
        "card_storage.py": (ROOT / "card_storage.py").read_bytes(),
        "requirements.txt": b"pillow==13.0.0\n",
        "tests/test_portable_downloader.py": (ROOT / "tests/test_portable_downloader.py").read_bytes(),
        "bundle-summary.json": encoded_json(summary),
        "manifests/remaining-images.json": encoded_json(manifest),
        "manifests/missing-image-urls.json": encoded_json({"schema_version": 1, "targets": missing}),
        "manifests/download-urls.txt": ("\n".join(dict.fromkeys(t["latest_file_metadata"]["url"] for t in ready)) + "\n").encode(),
        "manifests/remaining-images.csv": b"\xef\xbb\xbf" + table.getvalue().encode("utf-8"),
        "source-policy/wiki-robots-cached.txt": (ROOT / "sources/current-access/wiki-robots-recheck.txt").read_bytes(),
        "source-policy/machine-reading-policy.wikitext": (ROOT / "sources/神奇宝贝百科_机器读取守则.wikitext").read_bytes(),
        "source-policy/README.txt": (
            "Cached policy evidence only, not an authorization or a fresh access check.\n"
            "Wiki robots retrieved 2026-10-18; policy last-modified 2024-04-08.\n"
            "The downloader refreshes robots before image requests. No cache images, credentials,\n"
            "private machine paths, model settings or restricted research metadata are included.\n"
        ).encode(),
    }
    payload["SHA256SUMS.txt"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(payload.items())
    ).encode()
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = destination / "52poke-image-downloader-2026-10-19.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(payload.items()):
            archive.writestr(f"52poke-image-downloader/{name}", data)
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    archive_path.with_suffix(".zip.sha256").write_text(
        f"{digest}  {archive_path.name}\n", encoding="utf-8")
    print(json.dumps({**summary, "zip": str(archive_path), "zip_bytes": archive_path.stat().st_size,
                      "sha256": digest}, ensure_ascii=False, indent=2))
    return archive_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=ROOT / "exports")
    build(parser.parse_args().destination)
