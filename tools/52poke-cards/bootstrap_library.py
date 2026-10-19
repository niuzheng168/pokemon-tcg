"""Build metadata-only card folders directly from the committed gzip snapshots.

Standard library only; Windows/macOS/Linux. No SQLite input, NAS, image cache,
network, OCR/model credentials or raw XML archive is required.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import json
from pathlib import Path

from card_library import ROOT, build_groups, make_metadata, write_library
from card_storage import LANGUAGES, digest, identity_key, printing_identity
from snapshot_metadata import verify

DEFAULT_SNAPSHOT = ROOT / "snapshots/2026.10.18"


def read_gzip(path):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def supplemental_printings(cards, views, manifest):
    """Reuse explicitly recorded identities, never infer them from filenames.

    Basic-energy headers sometimes have a verified printed identity but no
    printing row. Their evidence is already in the committed display snapshot.
    Do not turn the historical image reference into a claim of local bytes.
    """
    known = set()
    for card in cards.values():
        for printing in card["printings"]:
            try:
                known.add((card["page_id"], identity_key(printing_identity(printing))))
            except ValueError:
                continue
    records = []
    for page_id, view in views.items():
        if page_id not in cards:
            continue
        image = view.get("image") or {}
        for printing in image.get("printings", []):
            if (not printing.get("derived_from_image") or not printing.get("verification")
                    or printing.get("language") != image.get("image_language")):
                continue
            try:
                key = (page_id, identity_key(printing_identity(printing)))
            except ValueError:
                continue
            if key in known:
                continue
            known.add(key)
            records.append({
                "page_id": page_id,
                "printing": {
                    **printing, "source_template_index": printing.get("source_template_index"),
                },
                "evidence": {
                    "source": "committed_display_metadata_recorded_printed_identity",
                    "archive_sha256": manifest["archive_sha256"],
                    "wiki_filename": image.get("wiki_filename"),
                    "recorded_image_sha256": image.get("sha256"),
                    "recorded_identity": printing,
                    "human_reviewed": False,
                    "local_image_available": False,
                },
            })
    return records


def bootstrap(snapshot, library, languages=None, *, dry_run=False):
    snapshot = Path(snapshot)
    manifest = verify(snapshot)  # Both compressed and expanded hashes/counts.
    cards = {card["page_id"]: card for card in read_gzip(snapshot / "cards.jsonl.gz")
             if "tcg" in card["games"]}
    views = {view["page_id"]: view for view in read_gzip(snapshot / "display-zh-hans.jsonl.gz")}
    if len(cards) != manifest["files"]["cards.jsonl.gz"]["game_page_counts"]["tcg"]:
        raise ValueError("Duplicate or missing source TCG page identity.")
    if len(views) != manifest["files"]["display-zh-hans.jsonl.gz"]["records"]:
        raise ValueError("Duplicate or missing display page identity.")
    groups, reviews, pending = build_groups(
        cards, views, [], languages, supplemental_printings(cards, views, manifest),
    )
    collisions = {key for key, group in groups.items()
                  if len({entry["page_id"] for entry in group["entries"]}) > 1
                  or len({entry["printing"]["number"] for entry in group["entries"]}) > 1}
    counts, sets = Counter(), set()
    for key, group in groups.items():
        if key in collisions:
            continue
        metadata = make_metadata(group, cards, views)
        counts[metadata["printing_language"]] += 1
        sets.add((metadata["printing_language"], metadata["set_id"]))
    extra = {
        "input_mode": "committed_metadata_snapshot",
        "source_archive_release": manifest["archive_release"],
        "source_archive_sha256": manifest["archive_sha256"],
        "source_snapshot_manifest_sha256": digest(snapshot / "manifest.json"),
        "printing_language_filter": languages,
        "local_image_cache_required": False,
        "source_database_required": False,
        "historical_image_references_not_counted_as_local_files": True,
    }
    if dry_run:
        return {
            **extra, "dry_run": True, "printings": sum(counts.values()),
            "by_printing_language": dict(counts), "sets": len(sets),
            "identity_collisions": len(collisions), "unidentified_printing_rows": len(reviews),
            "metadata_files_written": 0, "images_downloaded": 0,
            "network_requests": 0, "library_modified": False,
        }
    return write_library(
        cards, views, groups, reviews, pending, library,
        preserve_existing=True, report_extra=extra,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--library", type=Path, default=ROOT / "library")
    parser.add_argument("--language", action="append", choices=sorted(set(LANGUAGES.values())))
    parser.add_argument("--dry-run", action="store_true", help="Verify and count; do not create any folders.")
    args = parser.parse_args()
    print(json.dumps(bootstrap(args.snapshot, args.library, args.language, dry_run=args.dry_run),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
