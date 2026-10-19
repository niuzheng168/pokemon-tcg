"""Make deterministic, image-free metadata snapshots from local importer outputs."""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def public_projection(value):
    """Remove cache-local paths, not card text or source/revision identities."""
    if isinstance(value, list):
        return [public_projection(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {
        key: public_projection(item) for key, item in value.items()
        if key not in {"local_file", "parent_local_file", "base_dir", "image_queues"}
    }
    if "local_file" in value:
        result["local_file_omitted_from_snapshot"] = True
    return result


def compress_jsonl(source, destination, project=False):
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_digest, published_digest = hashlib.sha256(), hashlib.sha256()
    counts, games, printings, uncompressed_bytes = 0, Counter(), 0, 0
    with source.open("rb") as input_stream, destination.open("wb") as output:
        with gzip.GzipFile(filename="", fileobj=output, mode="wb", compresslevel=9, mtime=0) as compressed:
            for line in input_stream:
                source_digest.update(line)
                if not line.strip():
                    continue
                value = json.loads(line)
                counts += 1
                games.update(value.get("games", []))
                printings += len(value.get("printings", []))
                if project:
                    line = (json.dumps(public_projection(value), ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                published_digest.update(line)
                uncompressed_bytes += len(line)
                compressed.write(line)
    return {
        "records": counts, "game_page_counts": dict(games), "printing_rows": printings,
        "source_bytes": source.stat().st_size, "source_sha256": source_digest.hexdigest(),
        "published_uncompressed_bytes": uncompressed_bytes,
        "published_uncompressed_sha256": published_digest.hexdigest(),
        "gzip_bytes": destination.stat().st_size,
        "gzip_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "local_image_paths_removed": project,
    }


def build(source, output):
    output.mkdir(parents=True, exist_ok=True)
    audit = json.loads((source / "audit.json").read_text(encoding="utf-8"))
    files = {
        "cards.jsonl.gz": compress_jsonl(source / "cards.jsonl", output / "cards.jsonl.gz"),
        "display-zh-hans.jsonl.gz": compress_jsonl(
            source / "display-zh-hans/cards.jsonl", output / "display-zh-hans.jsonl.gz", project=True),
    }
    # Keep provenance and known warnings, but never workstation paths.
    for name, file in (
        ("extraction-audit.json", source / "audit.json"),
        ("display-audit.json", source / "display-zh-hans/audit.json"),
    ):
        data = public_projection(json.loads(file.read_text(encoding="utf-8")))
        (output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "schema_version": 1, "archive_release": audit["archive_release"],
        "archive_sha256": audit["archive_sha256"], "files": files,
        "attribution": {
            "source": "神奇宝贝百科及其贡献者", "license": "CC-BY-NC-SA-3.0",
            "source_url": "https://wiki.52poke.com/wiki/神奇宝贝百科:卡牌工程",
            "license_url": "https://creativecommons.org/licenses/by-nc-sa/3.0/",
            "modified": True,
        },
        "images_included": False, "restricted_research_data_included": False,
        "limitations": [
            "Snapshot, not a current-site completeness guarantee.",
            "Card pages, printings and executable engine card identities are different counts.",
            "Chinese text is a reviewable display projection, not a certified official translation.",
            "Image references describe source-local cache matches; image bytes and local paths are not distributed.",
            "Raw XML and derived SQLite/CSV are excluded; fetch/import scripts can rebuild them.",
        ],
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def verify(directory):
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    for filename, expected in manifest["files"].items():
        if filename not in {"cards.jsonl.gz", "display-zh-hans.jsonl.gz"}:
            raise ValueError("Unexpected snapshot filename.")
        path = directory / filename
        if (path.stat().st_size != expected["gzip_bytes"]
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected["gzip_sha256"]):
            raise ValueError(f"Compressed snapshot differs: {filename}")
        digest, count, size = hashlib.sha256(), 0, 0
        games, printings = Counter(), 0
        with gzip.open(path, "rb") as stream:
            for line in stream:
                digest.update(line)
                size += len(line)
                row = json.loads(line)
                count += 1
                games.update(row.get("games", []))
                printings += len(row.get("printings", []))
        if (digest.hexdigest() != expected["published_uncompressed_sha256"]
                or count != expected["records"] or size != expected["published_uncompressed_bytes"]
                or dict(games) != expected["game_page_counts"] or printings != expected["printing_rows"]):
            raise ValueError(f"Expanded snapshot differs: {filename}")
    print("Snapshot hashes, expanded sizes and all record counts verified (offline).")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--source", type=Path, help="Local data/YYYY.MM.DD importer output.")
    action.add_argument("--verify", type=Path, help="Verify a checked-in snapshot without downloading.")
    parser.add_argument("--output", type=Path, default=ROOT / "snapshots/2026.10.18")
    args = parser.parse_args()
    if args.verify:
        verify(args.verify)
    else:
        build(args.source, args.output)
