"""Build the language/set/full-number card library offline; keep raw caches intact."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sqlite3
from urllib.parse import quote, urlsplit

from card_storage import (
    LANGUAGES, atomic_json, attach_image, digest, identity_key, printing_identity,
    relative_directory, safe_path, library_lock, canonical_set,
)
ROOT = Path(__file__).resolve().parent


def read_jsonl(path):
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary.replace(path)


def preserved_review_rows(path, rows, preserve_existing):
    previous = list(read_jsonl(path)) if preserve_existing and path.is_file() else []
    result, seen = [], set()
    for row in [*previous, *rows]:
        key = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if key not in seen:
            result.append(row)
            seen.add(key)
    return result


def read_assets(queues, archive_sha256):
    assets = []
    trusted = [(Path(q).parent / child).resolve()
               for q in queues for child in ("files", "samples")]
    # Accepted public-source candidates can legitimately remain in the
    # independent downloader's files subtree. Never trust the research tree.
    trusted.append((ROOT / "official-candidates/files").resolve())
    for queue in queues:
        queue = Path(queue)
        if not queue.is_file():
            continue
        db = sqlite3.connect(f"file:{quote(str(queue.resolve()))}?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        try:
            row = db.execute("SELECT value FROM metadata WHERE key='plan'").fetchone()
            plan = json.loads(row[0]) if row else {}
            if plan.get("archive_sha256") != archive_sha256:
                raise ValueError(f"Queue belongs to another archive: {queue}")
            verifications = {}
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='file_verifications'").fetchone():
                verifications = {r[0]: json.loads(r[1]) for r in db.execute("SELECT * FROM file_verifications")}
            for row in db.execute("""
                SELECT j.filename,j.uses_json,j.source_url,a.record_json FROM jobs j
                JOIN assets a ON a.url=j.asset_url WHERE j.active=1 AND j.status='done'
                ORDER BY j.filename
            """):
                asset = json.loads(row["record_json"])
                local = Path(asset["local_file"])
                if not any(local.resolve().is_relative_to(t) for t in trusted):
                    raise ValueError(f"Image outside the explicit public-source caches: {local}")
                if not local.is_file() or digest(local) != asset["sha256"]:
                    raise ValueError(f"Missing or corrupt source image: {local}")
                origin = urlsplit(asset.get("official_page_url") or row["source_url"] or "")
                if not asset.get("image_language") and origin.hostname == "asia.pokemon-card.com" and origin.path.startswith(("/tw/", "/hk/")):
                    asset["image_language"] = "zh-Hant"
                assets.append({
                    "filename": row["filename"], "uses": json.loads(row["uses_json"]),
                    "asset": asset,
                    "verification": verifications.get(row["filename"], asset.get("matching_evidence", {})),
                })
        finally:
            db.close()
    return assets


def build_groups(cards, views, assets, languages, additional_printings=()):
    groups, reviews = {}, []
    code_counts = defaultdict(Counter)
    for card in cards.values():
        for printing in card["printings"]:
            try:
                identity = printing_identity(printing)
            except ValueError:
                continue
            code_counts[(identity["printing_language"], identity["set_id"].casefold())][identity["set_id"]] += 1
    aliases = {language + "/" + lower: sorted(counts, key=lambda code: (-counts[code], code))[0]
               for (language, lower), counts in code_counts.items()}

    def add(card, printing, *, evidence=None):
        language = LANGUAGES.get(printing.get("language"))
        if languages and language not in languages:
            return None
        try:
            identity = canonical_set(printing_identity(printing), aliases)
        except ValueError as error:
            reviews.append({"reason": str(error), "wiki_id": card["id"], "printing": printing})
            return None
        key = identity_key(identity)
        group = groups.setdefault(key, {"identity": identity, "entries": [], "assets": []})
        entry = {"page_id": card["page_id"], "printing": printing, "evidence": evidence}
        if entry not in group["entries"]:
            group["entries"].append(entry)
        return key

    for card in cards.values():
        for printing in card["printings"]:
            add(card, printing)
    for record in additional_printings:
        card = cards.get(record["page_id"])
        if card:
            add(card, record["printing"], evidence=record["evidence"])
    pending_assets = []
    for item in assets:
        keys, reasons = set(), set()
        evidence, asset = item["verification"], item["asset"]
        for use in item["uses"]:
            card = cards.get(use["page_id"])
            if not card:
                reasons.add("source_page_is_not_a_tcg_card")
                continue
            printing = use
            if evidence.get("basic_energy_header") or evidence.get("recovered_existing_File_for_printing"):
                reading = evidence.get("reading", {})
                printing = {**use, "language": reading.get("language"),
                            "set_code": reading.get("set_code"), "number": reading.get("number")}
            if (use.get("language_is_requested_target_not_image_verification")
                    and not (evidence.get("basic_energy_header") or evidence.get("recovered_existing_File_for_printing"))):
                reasons.add("semantic_identity_review_required")
                continue
            try:
                identity = canonical_set(printing_identity(printing), aliases)
            except ValueError as error:
                reasons.add(str(error))
                continue
            if languages and identity["printing_language"] not in languages:
                continue
            if asset.get("image_language") != identity["printing_language"]:
                reasons.add("image_language_does_not_match_printing")
                continue
            key = identity_key(identity)
            if key not in groups:
                if evidence.get("basic_energy_header") or evidence.get("recovered_existing_File_for_printing"):
                    add(card, printing, evidence=evidence)
                else:
                    reasons.add("printing_absent_from_source_metadata")
                    continue
            if card["page_id"] not in {e["page_id"] for e in groups[key]["entries"]}:
                reasons.add("image_source_page_conflicts_with_printing")
                continue
            keys.add(key)
        if len(keys) != 1 or reasons:
            pending_assets.append({
                "filename": item["filename"], "reasons": sorted(reasons) or ["multiple_or_missing_printing_identities"],
                "source_cache_file": asset["local_file"], "sha256": asset["sha256"],
                "uses": item["uses"],
            })
        else:
            groups[next(iter(keys))]["assets"].append(item)
    return groups, reviews, pending_assets


def make_metadata(group, cards, views):
    identity, entries = group["identity"], group["entries"]
    pages = sorted({e["page_id"] for e in entries})
    numbers = {e["printing"]["number"] for e in entries}
    if len(pages) != 1 or len(numbers) != 1:
        raise ValueError("Cross-page identity or number-slug collision.")
    card, view = cards[pages[0]], views.get(pages[0])
    if not view or view["revision_id"] != card["revision_id"] or view["metadata_language"] != "zh-Hans":
        raise ValueError(f"Missing/current Simplified display projection: {card['id']}")
    flags = set(identity["identity_flags"])
    if any(e["evidence"] for e in entries):
        flags.add("identity_completed_from_verified_image_evidence")
    flags.add("wiki_page_text_may_contain_multiple_rules_versions")
    set_names = sorted({
        p["display"]["set_name"] for p in view["simplified_printings"]
        if p["display"].get("set_name")
        and (p.get("set_code") or "").casefold() == identity["set_id"].casefold()
    })
    return {
        "schema_version": 1, **identity,
        "metadata_language": "zh-Hans", "name": view["display"]["name"],
        "set_names_zh_hans": set_names, "display": {"name": view["display"]["name"]},
        "blocks": view["blocks"], "field_provenance": view["field_provenance"],
        "text_review": view["review"], "review_flags": sorted(flags), "human_reviewed": False,
        "source_pages": [{
            "id": card["id"], "page_id": card["page_id"], "revision_id": card["revision_id"],
            "source_url": card["source_url"], "revision_url": card["revision_url"],
            "source_wikitext_sha256": card["source_wikitext_sha256"],
        }],
        "source_printings": entries,
        "archive_release": card["archive_release"], "attribution": card["attribution"],
        "rules_engine_implemented": card["rules_engine_implemented"],
        "not_an_engine_version_mapping": True, "images": [],
    }


def sync(cards_path, display_path, queues, root, languages=None):
    root = Path(root)
    cards = {c["page_id"]: c for c in read_jsonl(cards_path) if "tcg" in c["games"]}
    views = {v["page_id"]: v for v in read_jsonl(display_path)}
    # Queue/archive integrity is checked against the same importer audit used
    # by the display exporter, not guessed from a release/date string.
    audit = json.loads((Path(cards_path).parent / "audit.json").read_text(encoding="utf-8"))
    assets = read_assets(queues, audit["archive_sha256"])
    groups, reviews, pending_assets = build_groups(cards, views, assets, languages)
    return write_library(cards, views, groups, reviews, pending_assets, root)


def write_library(cards, views, groups, reviews, pending_assets, root, *,
                  preserve_existing=False, report_extra=None):
    """Shared writer for live queues and offline fresh-clone bootstrap."""
    root = Path(root)
    collisions = {key: group for key, group in groups.items()
                  if len({e["page_id"] for e in group["entries"]}) > 1
                  or len({e["printing"]["number"] for e in group["entries"]}) > 1}
    counts, index, sets = Counter(), [], defaultdict(list)
    with library_lock(root):
        collision_path = safe_path(root, Path("_review/collision-keys.json"))
        known_collisions = set(json.loads(collision_path.read_text(encoding="utf-8"))) if collision_path.exists() else set()
        atomic_json(collision_path, sorted(known_collisions | set(collisions)))
        atomic_json(safe_path(root, Path("set-codes.json")), {
            group["identity"]["printing_language"] + "/" + group["identity"]["set_id"].casefold():
            group["identity"]["set_id"] for group in groups.values()
        })
        for n, (key, group) in enumerate(sorted(groups.items()), 1):
            if key in collisions:
                counts["identity_collisions"] += 1
                # Never keep an old normal-library entry for a now-ambiguous
                # identity. Stop for an explicit operator review instead.
                old = safe_path(root, relative_directory(group["identity"]) / "metadata.json")
                if old.exists():
                    raise ValueError(f"Existing printing became ambiguous; review before continuing: {old}")
                continue
            metadata = make_metadata(group, cards, views)
            path = safe_path(root, relative_directory(metadata) / "metadata.json")
            if path.exists():
                old = json.loads(path.read_text(encoding="utf-8"))
                if (identity_key(old) != key
                        or old["number"] != metadata["number"]
                        or {p["page_id"] for p in old["source_pages"]} != {p["page_id"] for p in metadata["source_pages"]}):
                    raise ValueError(f"Refusing a conflicting existing metadata file: {path}")
                if preserve_existing and old.get("metadata_language") == "zh-Hans":
                    expected_pages = {
                        (p["page_id"], p.get("revision_id"), p.get("source_wikitext_sha256"))
                        for p in metadata["source_pages"]
                    }
                    existing_pages = {
                        (p["page_id"], p.get("revision_id"), p.get("source_wikitext_sha256"))
                        for p in old["source_pages"]
                    }
                    if (existing_pages != expected_pages
                            or old.get("archive_release") != metadata["archive_release"]):
                        raise ValueError(f"Existing metadata belongs to a different snapshot/revision: {path}")
                    # Keep human corrections, stronger evidence and downloaded
                    # images. Bootstrap is not a metadata overwrite operation.
                    metadata = old
                elif preserve_existing and "simplified_display_metadata_pending" not in old.get("review_flags", []):
                    raise ValueError(f"Existing incomplete metadata needs explicit review: {path}")
                metadata["images"] = old.get("images", [])
                if old.get("primary_image"):
                    metadata["primary_image"] = old["primary_image"]
                for image in metadata["images"]:
                    if digest(safe_path(root, relative_directory(metadata) / image["file"])) != image["sha256"]:
                        raise ValueError(f"Previously published image changed: {path}")
            seen = set()
            for item in group["assets"]:
                asset = item["asset"]
                if asset["sha256"] in seen:
                    continue
                if item.get("committed_sample") and any(
                    image["sha256"] == asset["sha256"] for image in metadata["images"]
                ):
                    # Existing bytes were verified above. Seeding must not
                    # replace stronger review/provenance with the sample record.
                    counts["sample_images_reused"] += 1
                    seen.add(asset["sha256"])
                    continue
                attach_image(root, metadata, asset, verification=item["verification"])
                if item.get("committed_sample"):
                    counts["sample_images_added"] += 1
                seen.add(asset["sha256"])
            if atomic_json(path, metadata):
                counts["metadata_files_written"] += 1
            counts["printings"] += 1
            counts["language:" + metadata["printing_language"]] += 1
            counts["printings_with_images"] += bool(metadata["images"])
            counts["image_files"] += len(metadata["images"])
            index.append({
                "id": metadata["id"], "name": metadata["name"],
                "printing_language": metadata["printing_language"], "set_id": metadata["set_id"],
                "number": metadata["number"],
                "metadata_file": path.relative_to(root).as_posix(),
                "image_files": [i["file"] for i in metadata["images"]],
            })
            sets[(metadata["printing_language"], metadata["set_id"])].append(metadata["set_names_zh_hans"])
            if n % 1000 == 0:
                print(f"Library: {n}/{len(groups)} identities; {counts['printings_with_images']} with images.", flush=True)
        for (language, code), members in sets.items():
            atomic_json(safe_path(root, Path(language) / code / "set.json"), {
                "id": code, "printing_language": language, "metadata_language": "zh-Hans",
                "names_zh_hans": sorted({name for names in members for name in names}),
                "printing_count": len(members),
                "not_a_complete_or_official_set_catalog": True,
            })
        write_jsonl(safe_path(root, Path("index.jsonl")), index)
        review_path = safe_path(root, Path("_review/printings.jsonl"))
        reviews = preserved_review_rows(review_path, reviews, preserve_existing)
        write_jsonl(review_path, reviews)
        collision_records = {key: {"path_key": key, **group} for key, group in collisions.items()}
        collision_path = safe_path(root, Path("_review/collisions.jsonl"))
        if preserve_existing and collision_path.is_file():
            # Metadata-only bootstrap cannot reconstruct richer image evidence
            # that was recorded while the live queue was available.
            collision_records.update({row["path_key"]: row for row in read_jsonl(collision_path)})
        write_jsonl(collision_path, (collision_records[key] for key in sorted(collision_records)))
        asset_path = safe_path(root, Path("_review/assets.jsonl"))
        pending_assets = preserved_review_rows(asset_path, pending_assets, preserve_existing)
        write_jsonl(asset_path, pending_assets)
        report = {
            "schema_version": 1, "directory_layout": "printing_language/set_id/full_number_slug",
            "number_slug_rule": "Replace slash and spaces with underscore, preserve leading zeros and suffixes.",
            "game_directory": False, "metadata_language": "zh-Hans",
            "index_is_last_sync_snapshot": True, "per_card_metadata_is_authoritative": True,
            "counts": dict(counts), "unidentified_printing_rows": len(reviews),
            "unpublished_asset_bindings": len(pending_assets), "sets": len(sets),
            "source_card_pages": len(cards), "source_images_and_databases_modified": False,
            "network_requests": 0, "image_copies_verified_with_sha256": True,
            **(report_extra or {}),
        }
        atomic_json(safe_path(root, Path("report.json")), report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cards", type=Path, default=ROOT / "data/2026.10.18/cards.jsonl")
    parser.add_argument("--display", type=Path, default=ROOT / "data/2026.10.18/display-zh-hans/cards.jsonl")
    parser.add_argument("--images", type=Path, action="append", help="Local queue SQLite; repeat to merge.")
    parser.add_argument("--library", type=Path, default=ROOT / "library")
    parser.add_argument("--language", action="append", choices=sorted(set(LANGUAGES.values())),
                        help="Repeat to restrict printing languages; default: all unambiguously identified TCG languages.")
    args = parser.parse_args()
    queues = args.images or [ROOT / f"{name}/queue.sqlite" for name in
                             ("images", "images-zh-hans", "images-academy-zh-hant")]
    print(json.dumps(sync(args.cards, args.display, queues, args.library, args.language),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
