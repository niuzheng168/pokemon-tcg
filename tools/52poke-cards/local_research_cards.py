"""Plan, download and verify a restricted dataset for LOCAL research only.

Never copy its pictures or metadata into the public website, public image queues,
or redistribution catalogs. Existing Wiki metadata remains the display source.
The optional local research server reads a separate, ignored manifest.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import subprocess
import time

from PIL import Image

from accept_official_candidates import name, number
from download_images import ROOT, dump_json
from export_academy import TYPES, academy_cards, exact_block
from export_display_metadata import read_only
from image_identity import printed_set
from tool_paths import ACADEMY_ROOT, RESEARCH_DATASET

REPO = RESEARCH_DATASET
DIRECTORY = ROOT / "data/local-research"
PLAN = DIRECTORY / "download-plan.json"
MANIFEST = DIRECTORY / "academy-private-scans.json"
DATASET_SOURCE = "https://github.com/duanxr/PTCG-CHS-Datasets"


def safe_image(path):
    return isinstance(path, str) and re.fullmatch(r"img/\d+/\d+\.png", path) is not None


def card_key(code, identifier, card_name):
    return printed_set(code), number(identifier), name(card_name)


def preferred(cards):
    return min(cards, key=lambda c: (
        c["details"].get("special_shiny_type", 0) != 0,
        c["details"].get("collectionFlag", 0) != 0, c["id"], c["image"],
    ))


def compatible(engine, candidate, attributes, cost_types):
    details = candidate["details"]
    if str(details.get("cardType")) != {"pokemon": "1", "trainer": "2", "energy": "3"}[engine["kind"]]:
        return False
    if engine["kind"] != "pokemon":
        return True  # The full printed identifier and exact Wiki/engine version were checked separately.
    if details.get("hp") != engine["hp"] or attributes.get(str(details.get("attribute"))) != TYPES[engine["type"]]:
        return False
    attacks = details.get("abilityItemList", [])
    if len(attacks) != len(engine.get("attacks", [])):
        return False
    for actual, expected in zip(attacks, engine["attacks"]):
        codes = [v for v in str(actual.get("abilityCost") or "").split(",") if v]
        if sorted(cost_types.get(v, "?") for v in codes) != sorted(TYPES[t] for t in expected["cost"]):
            return False
        damage = lambda v: re.sub(r"\s+", "", str(v or "")).replace("x", "×")
        if damage(actual.get("abilityDamage")) != damage(expected.get("damage")):
            return False
    if details.get("retreatCost") != engine.get("retreat"):
        return False
    return True


def prepare():
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    dataset_path = REPO / "ptcg_chs_infos.json"
    data = json.loads(dataset_path.read_text())
    commit = subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip()
    # No --long: asking Git for missing blob sizes would lazily fetch every image.
    tree = subprocess.check_output(["git", "-C", str(REPO), "ls-tree", "-r", "HEAD", "img"], text=True)
    objects = {path: header.split()[2] for line in tree.splitlines()
               for header, path in [line.split("\t", 1)]
               if header.split()[0] == "100644" and safe_image(path)}
    index = defaultdict(list)
    for collection in data["collections"]:
        for card in collection["cards"]:
            details = card.get("details") or {}
            key = card_key(details.get("commodityCode"), details.get("collectionNumber"), details.get("cardName") or card["name"])
            if key[0] and key[1] and safe_image(card["image"]) and card["image"] in objects:
                index[key].append(card)
    queue = read_only(ROOT / "images-zh-hans/queue.sqlite")
    metadata = read_only(ROOT / "data/2026.10.18/cards.sqlite")
    images, targets, engine_bindings = {}, [], {}

    def add(card):
        path = card["image"]
        images[path] = {"path": path, "git_blob_sha1": objects[path], "dataset_card_id": card["id"]}
        return path

    try:
        archive_sha = json.loads(metadata.execute("SELECT value FROM metadata WHERE key='archive_sha256'").fetchone()[0])
        for job in queue.execute("SELECT * FROM jobs WHERE active=1 AND status!='done'"):
            choices = []
            for use in json.loads(job["uses_json"]):
                choices.extend(index.get(card_key(use.get("set_code"), use.get("number"),
                                                 re.sub(r"（[^（）]+）$", "", use["title"])), []))
            if choices:
                selected = preferred(choices)
                targets.append({"wiki_filename": job["filename"], "image": add(selected),
                                "method": "full_set_number_name_identity_not_byte_identical_Wiki_claim"})
        records = {r["id"]: r for (raw,) in metadata.execute("SELECT record_json FROM extracts WHERE status='card'")
                   for r in [json.loads(raw)]}
        academy = ACADEMY_ROOT
        catalog = json.loads((academy / "public/data/locales/zh-CN.js").read_text().split("export default ", 1)[1].rstrip().removesuffix(";"))
        if catalog["archive"]["sha256"] != archive_sha:
            raise ValueError("Website and Wiki metadata snapshots differ.")
        engine_cards, _ = academy_cards(academy)
        attr = {v["dictCode"]: v["dictValue"] for v in data["dict"]["attribute"]}
        costs = {v["dictCode"]: v["dictValue"] for v in data["dict"]["ability_cost"]}
        for identifier, entry in catalog["cards"].items():
            source = records.get(entry.get("source"))
            engine = engine_cards[identifier]
            if entry["scan"] or not source or len(source["card_blocks"]) != 1 or not exact_block(engine, source):
                continue
            choices = []
            for printing in source["printings"]:
                if printing["language"] == "zh-Hans":
                    for candidate in index.get(card_key(printing.get("set_code"), printing.get("number"), source["display_name"]), []):
                        if compatible(engine, candidate, attr, costs):
                            choices.append(candidate)
            if choices:
                selected = preferred(choices)
                engine_bindings[identifier] = {"image": add(selected), "wiki_page_id": source["page_id"],
                                              "method": "exact_Wiki_engine_version_full_printed_identifier_and_numeric_stats"}
    finally:
        queue.close()
        metadata.close()
    plan = {"local_only": True, "redistribution_permitted": False, "dataset_source": DATASET_SOURCE,
            "dataset_commit": commit, "dataset_metadata_sha256": hashlib.sha256(dataset_path.read_bytes()).hexdigest(),
            "archive_sha256": archive_sha, "base_dir": str(REPO.resolve()), "images": images,
            "wiki_targets": targets, "engine_cards": engine_bindings,
            "note": "Local research data only; do not publish, bundle, or upload these images to a model service."}
    dump_json(PLAN, plan)
    print(json.dumps({"private_images_planned": len(images), "missing_wiki_targets_with_same_print_identity": len(targets),
                      "additional_engine_cards": len(engine_bindings), "public_files_written": 0}), flush=True)


def verify(path, expected_blob):
    raw = path.read_bytes()
    blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    if blob != expected_blob:
        return None  # Git may still be writing this checkout file; leave it pending.
    with Image.open(path) as image:
        width, height = image.size
        image.verify()
    return {"sha256": hashlib.sha256(raw).hexdigest(), "sha1": hashlib.sha1(raw).hexdigest(),
            "bytes": len(raw), "width": width, "height": height}


def index_files(plan):
    assets, checked = {}, {}
    for relative, item in plan["images"].items():
        path = REPO / relative
        if not safe_image(relative) or not path.resolve().is_relative_to(REPO.resolve()):
            raise ValueError("Research image path left its pinned dataset.")
        if not path.is_file():
            continue
        record = verify(path, item["git_blob_sha1"])
        if record:
            checked[relative] = record
            assets[record["sha256"]] = {"relative_path": relative, **record}
    cards = {identifier: {"asset": checked[item["image"]]["sha256"], "language": "zh-Hans",
                         "label": "简体卡图（仅本地研究）", "wiki_page_id": item["wiki_page_id"]}
             for identifier, item in plan["engine_cards"].items() if item["image"] in checked}
    manifest = {"version": 1, "local_only": True, "redistribution_permitted": False,
                "source": DATASET_SOURCE, "base_dir": str(REPO.resolve()), "assets": assets, "cards": cards,
                "notice": "仅限本机非商业研究；不得打包进公开构建、上传仓库或未经授权向第三方分发。"}
    dump_json(MANIFEST, manifest)
    # A separate private overlay makes the downloaded Wiki targets usable without
    # changing/publicly redistributing the original Wiki projection or this dataset.
    from wiki_image_hashes import load_state, records, DIRECTORY as WIKI_METADATA
    live = {filename: info for batch in load_state()["batches"]
            for filename, info in records(json.loads((WIKI_METADATA / batch["file"]).read_text()))}
    queue = read_only(ROOT / "images-zh-hans/queue.sqlite")
    bindings = []
    try:
        snapshot = json.loads(queue.execute("SELECT value FROM metadata WHERE key='plan'").fetchone()[0])
        if snapshot["archive_sha256"] != plan["archive_sha256"]:
            raise ValueError("Private image plan and current Wiki queue belong to different archives.")
        for target in plan["wiki_targets"]:
            image = checked.get(target["image"])
            if not image:
                continue
            job = queue.execute("SELECT * FROM jobs WHERE filename=?", (target["wiki_filename"],)).fetchone()
            if not job:
                continue
            expected = live.get(target["wiki_filename"])
            exact = bool(expected and expected["page_id"] == job["file_page_id"]
                         and expected["sha1"] == image["sha1"] and expected["size"] == image["bytes"])
            bindings.append({"wiki_filename": target["wiki_filename"], "asset": image["sha256"],
                             "uses": json.loads(job["uses_json"]), "image_language": "zh-Hans",
                             "byte_identical_to_live_Wiki_file": exact, "identity_method": target["method"]})
    finally:
        queue.close()
    dump_json(DIRECTORY / "wiki-image-bindings.json", {
        "local_only": True, "redistribution_permitted": False, "archive_sha256": plan["archive_sha256"],
        "bindings": bindings,
    })
    progress = {"at_epoch": time.time(), "planned_images": len(plan["images"]), "verified_images": len(checked),
                "verified_bytes": sum(r["bytes"] for r in checked.values()), "local_engine_cards": len(cards),
                "verified_wiki_print_identities": sum(t["image"] in checked for t in plan["wiki_targets"]),
                "wiki_byte_exact_matches": sum(b["byte_identical_to_live_Wiki_file"] for b in bindings),
                "not_a_Wiki_byte_exact_or_public_distribution_claim": True}
    dump_json(DIRECTORY / "progress.json", progress)
    print(json.dumps(progress), flush=True)
    return len(checked)


def download(plan):
    if subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip() != plan["dataset_commit"]:
        raise ValueError("Dataset checkout changed since planning; no download started.")
    patterns = ["/README.md", "/ptcg_chs_infos.json", "/.gitignore"] + ["/" + p for p in sorted(plan["images"])]
    dump_json(DIRECTORY / "download-state.json", {"status": "running", "pid": os.getpid(), "at_epoch": time.time()})
    try:
        subprocess.run(["git", "-C", str(REPO), "sparse-checkout", "set", "--no-cone", "--stdin"],
                       input="\n".join(patterns) + "\n", text=True, check=True)
        dump_json(DIRECTORY / "download-state.json", {"status": "complete", "pid": os.getpid(), "at_epoch": time.time()})
    except BaseException:
        dump_json(DIRECTORY / "download-state.json", {"status": "stopped", "pid": os.getpid(), "at_epoch": time.time()})
        raise


def downloader_live():
    state_path = DIRECTORY / "download-state.json"
    if not state_path.exists():
        return False
    state = json.loads(state_path.read_text())
    try:
        args = Path(f"/proc/{state['pid']}/cmdline").read_bytes().split(b"\0")
        return state["status"] == "running" and b"local_research_cards.py" in args and b"download" in args
    except (FileNotFoundError, PermissionError):
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "download", "index"])
    parser.add_argument("--follow", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare()
    else:
        plan = json.loads(PLAN.read_text())
        if not plan["local_only"] or plan["redistribution_permitted"]:
            raise ValueError("This importer is exclusively for restricted local research.")
        if args.command == "download":
            download(plan)
        else:
            while True:
                index_files(plan)
                if not args.follow:
                    break
                if not downloader_live():
                    index_files(plan)  # Final sweep after the producer's last completed file.
                    break
                time.sleep(60)
