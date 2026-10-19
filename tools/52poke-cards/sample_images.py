"""Validate and bind only the explicitly committed, public-source sample images."""
from __future__ import annotations

import json
from pathlib import Path
import struct

from card_library import make_metadata
from card_storage import digest, identity_key, printing_identity, relative_directory


def add_samples(manifest_path, snapshot, groups, cards, views, languages=None):
    """Preflight all bytes before any library write; never guess a printing."""
    if manifest_path is None:
        return {"enabled": False, "available": 0, "selected": 0, "selected_bytes": 0}
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("schema_version") != 1
            or any(manifest.get(key) != snapshot[key] for key in ("archive_release", "archive_sha256"))):
        raise ValueError("Sample images belong to another snapshot; use --no-samples.")
    samples = manifest["samples"]
    if (manifest.get("sample_count") != len(samples)
            or manifest.get("total_bytes") != sum(s["bytes"] for s in samples)):
        raise ValueError("Sample manifest count/size mismatch.")
    manifest_sha256 = digest(manifest_path)
    root = manifest_path.parent.resolve()
    seen, selected = set(), []
    for sample in samples:
        identity = printing_identity({
            "game": sample["game"], "language": sample["printing_language"],
            "set_code": sample["set_id"], "number": sample["number"],
        })
        if any(sample[field] != identity[field] for field in
               ("id", "printing_language", "set_id", "number", "number_slug")):
            raise ValueError("Noncanonical sample printing identity.")
        key = identity_key(identity)
        if key in seen:
            raise ValueError("Duplicate sample printing identity.")
        seen.add(key)
        relative = Path("images") / relative_directory(identity) / "image.png"
        if sample["file"] != relative.as_posix():
            raise ValueError("Sample path does not match its exact printing identity.")
        source = root / relative
        if (not source.resolve().is_relative_to(root)
                or any(parent.is_symlink() for parent in [source, *source.parents] if parent != root)):
            raise ValueError("Sample image must not escape or symlink outside its committed tree.")
        if not source.is_file() or source.stat().st_size != sample["bytes"] or digest(source) != sample["sha256"]:
            raise ValueError(f"Missing or corrupt committed sample image: {relative}")
        with source.open("rb") as stream:
            header = stream.read(24)
        if (header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR"
                or len(header) != 24
                or struct.unpack(">II", header[16:24]) != (sample["width"], sample["height"])):
            raise ValueError(f"Sample PNG header/dimensions mismatch: {relative}")
        if languages and identity["printing_language"] not in languages:
            continue
        group = groups.get(key)
        if not group:
            raise ValueError(f"Sample printing is absent from the metadata snapshot: {identity['id']}")
        metadata = make_metadata(group, cards, views)  # Also rejects ambiguous identities.
        if (metadata["id"] != identity["id"]
                or metadata["source_pages"] != sample["source_pages"]
                or metadata["name"] != sample["name_zh_hans"]):
            raise ValueError(f"Sample source page/revision/printing mismatch: {identity['id']}")
        verification = {
            "method": "committed_public_sample_with_pinned_printing_and_source_revision",
            "repository_sample_manifest_sha256": manifest_sha256,
            "repository_sample_file": sample["file"],
            "recorded_matching_evidence": sample["recorded_matching_evidence"],
            "human_reviewed": False,
            "not_an_engine_version_mapping": True,
        }
        if sample.get("rules_version_warning"):
            verification["rules_version_warning"] = sample["rules_version_warning"]
        selected.append((group, {
            "committed_sample": True, "verification": verification,
            "asset": {
                "local_file": str(source), "sha256": sample["sha256"],
                "image_language": identity["printing_language"],
                "width": sample["width"], "height": sample["height"], "bytes": sample["bytes"],
                "official_image_url": sample["source_url"],
                "official_page_url": sample["source_page_url"],
            },
        }))
    # Do not leave a partially bound batch if any manifest entry failed validation.
    for group, item in selected:
        group["assets"].append(item)
    return {
        "enabled": True, "available": len(samples), "selected": len(selected),
        "selected_bytes": sum(item["asset"]["bytes"] for _, item in selected),
        "manifest_sha256": manifest_sha256, "all_sample_hashes_verified": True,
    }
