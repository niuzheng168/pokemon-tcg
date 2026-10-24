"""Parallel, isolated full-source staging using the pilot's conservative gates.

Only an index of the existing local export is used. No downloads, production
imports, OCR claims, model calls, or engine mappings are performed here.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time

from PIL import Image

from . import stage
from .common import TOOL, digest, load, output_root, require, safe_path, write


def now():
    return datetime.now(timezone.utc).isoformat()


def grams(text):
    text = stage.layout(text)
    return {text[i:i + 2] for i in range(max(0, len(text) - 1))}


def prepare_card(wiki, view):
    card, display, repairs = stage.prepare_card(wiki, view)
    # Japanese 新字体 悪 and Chinese 惡/恶 are the same explicit Darkness label.
    # This is a cost-label alias, never removal of an energy, number or operator.
    for bi, block in enumerate(card["card_blocks"]):
        for ai, attack in enumerate(block["attacks"]):
            before = attack["cost"]
            after = ["恶" if value == "悪" else value for value in before]
            if before != after:
                attack["cost"] = after
                display["blocks"][bi]["attacks"][ai]["display"]["energy_cost"] = after
                repairs.append({"field": f"blocks.{bi}.attacks.{ai}.cost", "old": before,
                                "new": after, "method": "explicit_darkness_label_alias_悪_恶"})
    return card, display, repairs


def validate_source(source, key):
    """Validate actual archived image format and both historical receipt shapes."""
    directory = Path(source) / "cards" / key
    mik = load(directory / "metadata.json")
    envelope = load(directory / "source-response.json")
    receipt = load(directory / "metadata-receipt.json")
    ir = load(directory / "image-receipt.json")
    require(mik["setCode"] + "/" + mik["cardIndex"] == key, "MIK source identity mismatch.")
    require(envelope["code"] == 200 and envelope["data"] == mik, "Metadata and response disagree.")
    require(digest(directory / "source-response.json") == receipt["sha256"], "Response receipt hash mismatch.")
    filename = ir.get("file") or "image" + ir["image"].get("suffix", ".png")
    require(re.fullmatch(r"image\.(?:png|webp|jpe?g)", filename), "Unsupported or unsafe archived image filename.")
    image_path = directory / filename
    image_hash = digest(image_path)
    require(image_hash == ir["image"]["sha256"], "Nested image receipt SHA-256 mismatch.")
    if "sha256" in ir:
        require(image_hash == ir["sha256"], "Image receipt SHA-256 mismatch.")
    with Image.open(image_path) as image:
        image.load()
        expected = {".png": "PNG", ".webp": "WEBP", ".jpg": "JPEG", ".jpeg": "JPEG"}[image_path.suffix]
        require(image.format == expected, "Image bytes do not match archived format.")
        require((image.width, image.height) == (ir["image"]["width"], ir["image"]["height"]),
                "Image receipt dimensions mismatch.")
        size = [image.width, image.height]
    return mik, {
        "metadata_sha256": digest(directory / "metadata.json"), "image_sha256": image_hash,
        "image_size": size, "image_bytes": image_path.stat().st_size, "image_file": filename,
        "image_source_url": ir.get("url") or ir["request"]["url"],
    }


class BulkMatcher(stage.Matcher):
    """Same candidate gates; cache the exact fallback Jaccard calculation."""

    def __init__(self, cards, views):
        super().__init__(cards, views)
        self.lock = threading.RLock()
        self.fallback_index = None
        self.fallback_sizes = {}

    def fallback(self, description):
        with self.lock:
            if self.fallback_index is None:
                index = defaultdict(list)
                for page_id, view in self.views.items():
                    text = "".join(item["display"].get("effect") or ""
                                   for block in view["blocks"]
                                   for group in ("attacks", "abilities", "effects")
                                   for item in block[group])
                    values = grams(text)
                    self.fallback_sizes[page_id] = len(values)
                    for value in values:
                        index[value].append(page_id)
                self.fallback_index = dict(index)
        query = grams(description)
        overlaps = Counter()
        for value in query:
            overlaps.update(self.fallback_index.get(value, ()))
        ranked = [(count / max(1, len(query) + self.fallback_sizes[page_id] - count), page_id)
                  for page_id, count in overlaps.items()]
        return [page_id for _, page_id in sorted(ranked, reverse=True)[:8]]

    def find(self, mik):
        name_ids = (set(self.by_name.get(stage.names(mik["name"]), ()))
                    | set(self.by_name.get(stage.names(mik.get("nameEn")), ())))
        if mik.get("nameEn") in {"Boss's Orders", "Professor's Research"}:
            for key, ids in self.by_name.items():
                if key.startswith(stage.names(mik["nameEn"])):
                    name_ids.update(ids)
        print_ids = set(self.by_print.get(
            (mik["setCode"].casefold(), stage.number_head(mik["cardIndex"])), ()))
        ids = name_ids | print_ids
        if not ids:
            ids.update(self.fallback(mik.get("description") or ""))
        candidates = []
        for page_id in sorted(ids):
            with self.lock:
                if page_id not in self.prepared:
                    self.prepared[page_id] = prepare_card(self.cards[page_id], self.views[page_id])
                wiki, _, repairs = self.prepared[page_id]
            for block_index, block in enumerate(wiki["card_blocks"]):
                if block["game"] != "tcg":
                    continue
                checks = stage.structural(mik, block, wiki)
                direct = stage.direct_printings(mik, wiki)
                candidates.append({
                    "page_id": page_id, "title": wiki["title"], "block": block_index,
                    "checks": checks, "failed": [key for key, value in checks.items() if not value],
                    "direct_printings": direct, "derived_normalizations": repairs,
                    "rank_hint": ((100 if direct else 0) + (10 if page_id in name_ids else 0)
                                  + sum(checks.values())),
                })
        candidates.sort(key=lambda c: (bool(c["failed"]), -c["rank_hint"], c["page_id"], c["block"]))
        passing = [c for c in candidates if not c["failed"]]
        direct = [c for c in passing if c["direct_printings"]]
        chosen = passing[0] if len(passing) == 1 else direct[0] if len(direct) == 1 else None
        return chosen, candidates, sorted(name_ids)


def read_full_selection(source):
    source = Path(source).resolve()
    rows, seen = [], set()
    with (source / "index.jsonl").open(encoding="utf-8") as stream:
        for line in stream:
            entry = json.loads(line)
            card = entry["source_card"]
            key = card["setCode"] + "/" + card["cardIndex"]
            require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", key),
                    "Unsafe MIK index identity.")
            require(key not in seen, "Duplicate MIK index identity: " + key)
            require(entry["directory"] == "cards/" + key, "Index directory does not match identity.")
            directory = source / entry["directory"]
            require(directory.resolve().is_relative_to(source), "Source directory escapes input.")
            seen.add(key)
            rows.append({"mik_id": key, "batch": "all", "index": len(rows) + 1,
                         "name": card.get("cardName", key), "card_type": card.get("cardType", "")})
    actual = {f"{set_dir.name}/{card_dir.name}"
              for set_dir in (source / "cards").iterdir() if set_dir.is_dir()
              for card_dir in set_dir.iterdir() if card_dir.is_dir()}
    require(actual == seen, "Source index and actual printing directories differ.")
    return rows


def catalog_row(result, root):
    def relative(value):
        return str(Path(value).relative_to(root)) if value else None
    key = result["mik_id"]
    directory = Path(result.get("output_directory") or root / "cards" / key)
    image = directory / result.get("input_hashes", {}).get("image_file", "image.png")
    chosen = result.get("chosen")
    return {
        "mik_id": key, "name": result.get("name", key),
        "set_code": key.split("/")[0], "card_type": result.get("card_type", ""),
        "status": result["status"],
        "association_status": "unique" if chosen else "unresolved",
        "semantic_status": result.get("semantic_status", "pending"),
        "wiki_id": "52poke:" + str(chosen["page_id"]) if chosen else None,
        "holds": result.get("holds", []),
        "image_sha256": result.get("input_hashes", {}).get("image_sha256"),
        "image_file": str(image.relative_to(root)) if image.is_file() else None,
        "detail_file": str((directory / "review.json").relative_to(root)),
        "merged_metadata_file": relative(result.get("merged_metadata_file")),
    }


def stage_full(source, snapshot, observations, run_dir, workers=12, only_keys=None):
    source, snapshot = Path(source).resolve(), Path(snapshot).resolve()
    observation_path = Path(observations).resolve()
    root = output_root(run_dir, protected=(source, snapshot, observation_path, TOOL / "library"))
    require(not (root / "pilot-results.json").exists(), "Do not restage an existing completed run.")
    root.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    manifest = load(snapshot / "manifest.json")
    snapshots = {"manifest.json": digest(snapshot / "manifest.json")}
    for filename in ("cards.jsonl.gz", "display-zh-hans.jsonl.gz"):
        expected = manifest["files"][filename]["gzip_sha256"]
        require(digest(snapshot / filename) == expected, "Snapshot integrity failure: " + filename)
        snapshots[filename] = expected
    selected = read_full_selection(source)
    if only_keys is not None:
        selected = [r for r in selected if r["mik_id"] in only_keys]
        require({r["mik_id"] for r in selected} == set(only_keys), "Refinement keys are absent from source.")
    selection_path = root / "full-selection.json"
    write(root, selection_path, {
        "schema": "mik-52poke-selection-v1",
        "method": "Every unique printing in the complete local MIK index; no replacements or exclusions.",
        "samples": [{"batch": "all", "mik_id": row["mik_id"]} for row in selected],
    })
    saved = load(root / "run-inputs.json") if (root / "run-inputs.json").is_file() else {}
    saved.update(source=str(source), snapshot=str(snapshot), observations=str(observation_path),
                 selection=str(selection_path), source_index_sha256=digest(source / "index.jsonl"))
    write(root, root / "run-inputs.json", saved)
    write(root, root / "progress.json", {
        "phase": "loading_verified_snapshot", "processed": 0, "total": len(selected),
        "updated_at": now(), "offline_workers": workers,
    })
    with gzip.open(snapshot / "cards.jsonl.gz", "rt", encoding="utf-8") as stream:
        cards = {c["page_id"]: c for c in map(json.loads, stream) if "tcg" in c["games"]}
    with gzip.open(snapshot / "display-zh-hans.jsonl.gz", "rt", encoding="utf-8") as stream:
        views = {c["page_id"]: c for c in map(json.loads, stream)}
    matcher = BulkMatcher(cards, views)
    observations_data = load(observation_path)["observations"]
    observed = {row["mik_id"]: row for row in observations_data}
    require(len(observed) == len(observations_data), "Duplicate card-face observations.")
    stage.ROOT, stage.SOURCE, stage.SNAPSHOT = root, source, snapshot
    stage.OBSERVED_NUMBERS = {}
    wiki_lock = threading.Lock()

    def worker(item):
        key = item["mik_id"]
        directory = safe_path(root, root / "cards" / key)
        require(not directory.exists(), "Existing card output may not be overwritten: " + key)
        directory.mkdir(parents=True)
        result = {
            "batch": "all", "index": item["index"], "mik_id": key,
            "name": item["name"], "card_type": item["card_type"],
            "input_hashes": {}, "name_candidates": [], "candidate_evidence": [],
            "status": "blocked", "chosen": None, "holds": [], "field_diffs": [],
            "semantic_pairs": [], "semantic_status": "not_run",
            "output_directory": str(directory),
        }
        detail = {"mik_id": key}
        input_files = {}
        try:
            mik, hashes = validate_source(source, key)
            result.update(name=mik["name"], card_type=mik["cardType"], input_hashes=hashes)
            detail["mik_metadata"] = mik
            for filename in ("metadata.json", "source-response.json", "metadata-receipt.json",
                             hashes["image_file"], "image-receipt.json"):
                path = source / "cards" / key / filename
                input_files[str(path)] = digest(path)
                destination = "mik-metadata.json" if filename == "metadata.json" else filename
                shutil.copyfile(path, safe_path(root, directory / destination))
            observation = observed.get(key)
            if observation:
                require(observation.get("human_reviewed") is False,
                        "Card-face observation must not impersonate human approval.")
                require(observation["image_sha256"] == hashes["image_sha256"],
                        "Card-face observation image SHA-256 mismatch.")
                with wiki_lock:
                    stage.OBSERVED_NUMBERS[key] = observation["printed_number"]
            chosen, candidates, name_ids = matcher.find(mik)
            result.update(chosen=chosen, candidate_evidence=candidates, name_candidates=name_ids)
            if chosen is None:
                result["holds"] = [{"code": "no_unique_structurally_compatible_candidate"}]
            else:
                page_id = chosen["page_id"]
                wiki, view, repairs = matcher.prepared[page_id]
                metadata, diffs, pairs, holds = stage.merge_candidate(key, mik, hashes, chosen, wiki, view)
                metadata["primary_image"] = hashes["image_file"]
                metadata["images"][0]["file"] = hashes["image_file"]
                metadata["images"][0]["source_cache_file"] = str(source / "cards" / key / hashes["image_file"])
                metadata["derived_normalizations"] = repairs
                if observation:
                    if observation["printed_number"] != metadata["number"]:
                        holds.append({"code": "card_face_printed_number_conflict",
                                      "observed": observation["printed_number"],
                                      "candidate_number": metadata["number"]})
                    else:
                        metadata["images"][0]["verification"]["printed_number_observation"] = observation
                else:
                    holds.append({"code": "card_face_identity_not_independently_checked"})
                metadata["review_flags"] = sorted({hold["code"] for hold in holds})
                require(metadata["human_reviewed"] is False and metadata["rules_engine_implemented"] is False,
                        "Candidate approval or engine flags changed.")
                # Immutable snapshot projections are shared only INSIDE this new run.
                with wiki_lock:
                    shared = safe_path(root, root / "wiki" / str(page_id))
                    for filename, value in (
                        ("wiki-source.json", cards[page_id]), ("wiki-display.json", views[page_id]),
                        ("normalized-wiki-source.json", wiki), ("normalized-wiki-display.json", view),
                    ):
                        target = shared / filename
                        if not target.is_file():
                            write(root, target, value)
                        os.link(target, safe_path(root, directory / filename))
                write(root, directory / "metadata.json", metadata)
                result.update(status="needs_review" if holds else "ready", holds=holds,
                              field_diffs=diffs, semantic_pairs=pairs,
                              image_identity_observation=observation,
                              merged_metadata_file=str(directory / "metadata.json"),
                              semantic_status="pending" if any(p["status"] == "needs_semantic_review" for p in pairs)
                              else "deterministic")
                detail.update(wiki_source=cards[page_id], wiki_display=views[page_id],
                              normalized_wiki_source=wiki, normalized_wiki_display=view,
                              merged_candidate=metadata)
        except Exception as error:
            # Local validation exceptions are diagnostic, never a reason to drop a printing.
            result["status"] = "blocked"
            result["holds"].append({"code": "source_or_staging_validation_failed",
                                    "error_type": type(error).__name__, "detail": str(error)[:500]})
        detail.update(result=result, holds=result["holds"], status=result["status"],
                      candidate_evidence=result["candidate_evidence"],
                      field_diffs=result["field_diffs"], semantic_equivalence=[])
        write(root, directory / "review.json", detail)
        write(root, directory / "merge-check.json", result)
        return result, input_files

    results = {}
    counts = Counter()
    ledger = safe_path(root, root / "audit/source-files-before.jsonl")
    ledger.parent.mkdir(parents=True, exist_ok=True)
    last = 0.0
    with ledger.open("x", encoding="utf-8") as log, ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(worker, row): row["mik_id"] for row in selected}
        for future in as_completed(futures):
            result, hashes = future.result()
            results[result["mik_id"]] = result
            counts[result["status"]] += 1
            log.write(json.dumps({"mik_id": result["mik_id"], "files": hashes}) + "\n")
            if time.monotonic() - last >= 3 or len(results) == len(selected):
                log.flush()
                progress = {
                    "phase": "staging", "processed": len(results), "total": len(selected),
                    "status_counts": dict(counts), "unique_associations": sum(bool(r["chosen"]) for r in results.values()),
                    "updated_at": now(), "elapsed_seconds": round(time.monotonic() - started, 1),
                    "offline_workers": workers, "model_requests": 0,
                }
                write(root, root / "progress.json", progress)
                print(json.dumps(progress, ensure_ascii=False), flush=True)
                last = time.monotonic()
    ordered = [results[row["mik_id"]] for row in selected]
    report = {
        "schema": "mik-52poke-staged-candidates-v1", "scope": "All local MIK printings; candidate outputs only.",
        "archive_release": manifest["archive_release"], "snapshot_sha256": snapshots,
        "selection_sha256": digest(selection_path), "sampling": "Full local source index; no filtering.",
        "production_library_modified": False, "results": ordered,
    }
    write(root, root / "pilot-results.json", report)
    catalog = {"schema": "mik-52poke-bulk-catalog-v1",
               "fingerprint": hashlib.sha256(json.dumps(
                   {"snapshot": snapshots, "source_index": saved["source_index_sha256"],
                    "cards": [(r["mik_id"], r["input_hashes"].get("image_sha256")) for r in ordered]},
                   sort_keys=True).encode()).hexdigest(),
               "cards": [catalog_row(result, root) for result in ordered]}
    write(root, root / "catalog.json", catalog)
    summary = {
        "phase": "staged", "total": len(ordered), "candidate_count": sum(bool(r.get("merged_metadata_file")) for r in ordered),
        "unique_associations": sum(bool(r["chosen"]) for r in ordered),
        "status_counts": dict(counts), "hold_counts": dict(Counter(h["code"] for r in ordered for h in r["holds"])),
        "semantic_pairs": sum(len(r["semantic_pairs"]) for r in ordered),
        "unresolved_semantic_pairs": sum(p["status"] == "needs_semantic_review" for r in ordered for p in r["semantic_pairs"]),
        "human_reviewed": False, "rules_engine_implemented": False, "updated_at": now(),
    }
    write(root, root / "summary.json", summary)
    write(root, root / "progress.json", {**summary, "processed": len(ordered),
                                        "elapsed_seconds": round(time.monotonic() - started, 1)})
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return report


def refine(run_dir, workers=12):
    """Keep the first-pass diagnostics; retry ONLY with explicit representation support."""
    root = output_root(run_dir)
    base = load(root / "pilot-results.json")
    saved = load(root / "run-inputs.json")
    keys = {r["mik_id"] for r in base["results"] if r["status"] == "blocked"}
    write(root, root / "audit/initial-stage-results.json", base)
    if not keys:
        return base
    refined = stage_full(saved["source"], saved["snapshot"], saved["observations"],
                         root / "refinement", workers, only_keys=keys)
    replacements = {r["mik_id"]: r for r in refined["results"]}
    base["results"] = [replacements.get(r["mik_id"], r) for r in base["results"]]
    base["bulk_refinement"] = {
        "selected_blocked_cards": len(keys),
        "recovered_unique_associations": sum(bool(r["chosen"]) for r in refined["results"]),
        "methods": ["explicit_darkness_cost_label_悪_恶",
                    "actual_archived_webp_format_with_original_sha256",
                    "nested_image_sha256_receipt_shape"],
        "no_structural_or_semantic_thresholds_relaxed": True,
    }
    write(root, root / "pilot-results.json", base)
    catalog = load(root / "catalog.json")
    catalog["cards"] = [catalog_row(r, root) for r in base["results"]]
    catalog["fingerprint"] = hashlib.sha256(json.dumps({
        "snapshot": base["snapshot_sha256"], "source_index": saved["source_index_sha256"],
        "cards": [(r["mik_id"], r["input_hashes"].get("image_sha256")) for r in base["results"]],
    }, sort_keys=True).encode()).hexdigest()
    write(root, root / "catalog.json", catalog)
    summary = {
        "phase": "staged", "total": len(base["results"]), "processed": len(base["results"]),
        "candidate_count": sum(bool(r.get("merged_metadata_file")) for r in base["results"]),
        "unique_associations": sum(bool(r["chosen"]) for r in base["results"]),
        "status_counts": dict(Counter(r["status"] for r in base["results"])),
        "hold_counts": dict(Counter(h["code"] for r in base["results"] for h in r["holds"])),
        "unresolved_semantic_pairs": sum(p["status"] == "needs_semantic_review"
                                         for r in base["results"] for p in r["semantic_pairs"]),
        "refinement": base["bulk_refinement"], "updated_at": now(),
    }
    write(root, root / "summary.json", summary)
    write(root, root / "progress.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return base


def publish(run_dir):
    """Publish semantic-layer results to lightweight per-card web details."""
    root = output_root(run_dir)
    base = load(root / "pilot-results.json")
    report_path = root / "semantic-v2/results.json"
    report = load(report_path) if report_path.is_file() else base
    previous = load(root / "catalog.json")
    for result in report["results"]:
        directory = Path(result.get("output_directory") or root / "cards" / result["mik_id"])
        path = directory / "review.json"
        detail = load(path)
        decisions = result.get("semantic_equivalence", [])
        result["semantic_status"] = (
            "accepted" if decisions and all(d["machine_accepted"] for d in decisions)
            else "needs_review" if decisions else result.get("semantic_status", "not_applicable"))
        if result.get("merged_metadata_file"):
            final_path = safe_path(root, Path(result["merged_metadata_file"]))
            detail["merged_candidate"] = load(final_path)
            image_name = result["input_hashes"].get("image_file", "image.png")
            image_source = safe_path(root, directory / image_name)
            image_target = safe_path(root, final_path.parent / image_name)
            if image_source.resolve() != image_target.resolve() and not image_target.exists():
                os.link(image_source, image_target)
            require(digest(image_target) == result["input_hashes"]["image_sha256"],
                    "Published candidate image hash mismatch.")
        detail.update(result=result, status=result["status"], holds=result["holds"],
                      semantic_equivalence=decisions)
        write(root, path, detail)
    previous["cards"] = [catalog_row(r, root) for r in report["results"]]
    write(root, root / "catalog.json", previous)
    counts = dict(Counter(r["status"] for r in report["results"]))
    summary = {
        "phase": "complete", "total": len(report["results"]),
        "candidate_count": sum(bool(r.get("merged_metadata_file")) for r in report["results"]),
        "unique_associations": sum(bool(r["chosen"]) for r in report["results"]),
        "status_counts": counts,
        "hold_counts": dict(Counter(h["code"] for r in report["results"] for h in r["holds"])),
        "human_reviewed": False, "rules_engine_implemented": False, "updated_at": now(),
        "model_review_complete": report_path.is_file(),
        **{k: report[k] for k in ("cloud_usage", "calibration_passed", "control_count",
                                  "fresh_requests_this_run", "model_reviewed_source_pairs")
           if k in report},
    }
    write(root, root / "summary.json", summary)
    write(root, root / "progress.json", {**summary, "processed": len(report["results"])})
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("stage")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--snapshot", default=TOOL / "snapshots/2026.10.18")
    p.add_argument("--observations", default=TOOL / "mik_merge/example-card-face-observations.json")
    p.add_argument("--workers", type=int, default=12)
    p = sub.add_parser("publish")
    p.add_argument("--run-dir", required=True)
    p = sub.add_parser("refine")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()
    if args.command == "stage":
        require(1 <= args.workers <= 32, "Offline workers must be between 1 and 32.")
        stage_full(args.source, args.snapshot, args.observations, args.run_dir, args.workers)
    elif args.command == "refine":
        require(1 <= args.workers <= 32, "Offline workers must be between 1 and 32.")
        refine(args.run_dir, args.workers)
    else:
        publish(args.run_dir)


if __name__ == "__main__":
    main()
