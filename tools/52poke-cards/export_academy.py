"""Export a read-only Chinese presentation catalog for Academy's existing engine cards.

Card-name localization does not confer playable capability. Scans require a much
stronger same-version match than a name: HP, type, ordered attacks/cost/damage and
ability identity, or an identical trainer text. Internal engine files are untouched.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import unicodedata

from export_display_metadata import ChineseText, CONVERTER, image_index, select_image, simplified_variant
from import_cards import ROOT, plain
from tool_paths import ACADEMY_ROOT

TYPES = {
    "Grass": "草", "Fire": "火", "Water": "水", "Lightning": "雷", "Psychic": "超",
    "Fighting": "斗", "Colorless": "无色", "Darkness": "恶", "Metal": "钢", "Dragon": "龙",
}
NAME_ALIASES = {"stone fighting energy": "stone f energy"}
POWER_ALIASES = {"search for friends": "friend search"}
# Old English printings may have no official mainland release. This is an explicitly
# labelled community display name, not an official translated printing.
COMMUNITY_NAMES = {"super energy removal": "超级能量消除（经典版）"}
# Explicit field-level exceptions to bad/missing wiki English labels. These never
# weaken scan matching or replace the engine's identity/effect.
FIELD_OVERRIDES = {
    ("swsh9-59", 1): (231053, 1, "wiki_english_name_missing"),
    ("sm1-26", 1): (141032, 1, "wiki_english_name_mislabeled_as_Brave_Bird"),
}


def normalize(value):
    text = unicodedata.normalize("NFKC", plain(str(value or "")))
    return re.sub(r"\s+", " ", text.replace("’", "'").replace("é", "e")).strip().casefold()


def name_key(value):
    value = normalize(value)
    value = re.sub(r"\s*([♀♂])", r"\1", value)
    value = value.replace(" (", " ").replace(")", "")
    if value.startswith("basic ") and value.endswith(" energy"):
        value = value[6:]
    return NAME_ALIASES.get(value, value)


def clean_zh(value):
    text = CONVERTER.convert(plain(simplified_variant(value or "")))
    return re.sub(r"\s+", " ", text).strip()

def attack_key(value):
    return re.sub(r"\s*-?gx$", "", normalize(value))

def power_key(value):
    return POWER_ALIASES.get(normalize(value), normalize(value))

def energy_type(value):
    return {"无": "无色", "一般": "无色", "电": "雷", "闪电": "雷", "格斗": "斗"}.get(clean_zh(value), clean_zh(value))


def chinese_name(record):
    return clean_zh(record["display_name"])


def academy_cards(repo):
    folder = repo / "public/data/decks"
    index = json.loads((folder / "index.json").read_text())
    cards, decks = {}, {}
    for key in index["decks"] + [d["key"] for d in index["modern"]]:
        deck = json.loads((folder / key / "cards.json").read_text())
        decks[key] = deck
        for card in deck["cards"]:
            cards.setdefault(card["id"], card)
    return cards, decks


def attack_signature(attack):
    en = attack.get("names", {}).get("en", {}).get("text")
    return (
        attack_key(en), normalize(attack.get("damage")),
        tuple(energy_type(c) for c in attack.get("cost", [])),
    )


def exact_block(engine, record):
    """Fail closed on missing/ambiguous version evidence; never pair on name alone."""
    matches = []
    for block in record["card_blocks"]:
        if block["game"] != "tcg" or block["kind"] != engine["kind"]:
            continue
        if engine["kind"] == "pokemon":
            if block["hp"] != engine["hp"] or energy_type(block["type"]) != TYPES[engine["type"]]:
                continue
            expected = [
                (attack_key(a["name"]), normalize(a["damage"]), tuple(TYPES[t] for t in a["cost"]))
                for a in engine["attacks"]
            ]
            if [attack_signature(a) for a in block["attacks"]] != expected:
                continue
            expected_power = power_key((engine.get("power") or {}).get("name"))
            actual_power = [
                power_key(a.get("names", {}).get("en", {}).get("text"))
                for a in block["abilities"]
            ]
            if ([expected_power] if expected_power else []) != actual_power:
                continue
        elif engine["kind"] == "trainer":
            actual = [normalize(e.get("texts", {}).get("en", {}).get("text")) for e in block["effects"]]
            if not engine.get("text") or normalize(engine["text"]) not in actual:
                continue
        elif engine["kind"] == "energy" and not engine.get("special"):
            if (str(block.get("header", {}).get("base", "")).casefold() != "y"
                    or energy_type(block.get("type")) != TYPES.get(engine.get("energyType"))
                    or any(block.get(key) for key in ("attacks", "abilities", "effects"))):
                continue
        else:
            # Special Energy has additional version rules; a name alone is insufficient.
            continue
        matches.append(block)
    return matches[0] if len(matches) == 1 else None


def localized(item, key):
    return ChineseText().choose("field", item.get(key, {}), normalize_terms=key == "effects")


def candidate_records(engine, by_name):
    key = name_key(engine["name"])
    result = by_name.get(key, [])
    if not result and key.startswith(("boss's orders", "professor's research")):
        # Only for the displayed identity. Exact-block evidence is still mandatory for scans.
        result = [record for name, records in by_name.items() if name.startswith(key) for record in records]
    return result


def build_catalog(cards, records, images):
    by_name = collections.defaultdict(list)
    names = collections.defaultdict(collections.Counter)
    attack_names = collections.defaultdict(collections.Counter)
    power_names = collections.defaultdict(collections.Counter)
    references = {}
    for record in records:
        en = record["names"].get("en", {}).get("text")
        if en:
            by_name[name_key(en)].append(record)
            names[normalize(en)][chinese_name(record)] += 1
        for block in record["card_blocks"]:
            if block["game"] != "tcg":
                continue
            for target, items in [(attack_names, block["attacks"]), (power_names, block["abilities"])]:
                for item in items:
                    english = item.get("names", {}).get("en", {}).get("text")
                    zh = localized(item, "names")
                    if english and zh and not re.search(r"[{}<>]", zh):
                        score = 100 if item.get("names", {}).get("zh-Hans") else 1
                        target[attack_key(english) if target is attack_names else power_key(english)][zh] += score
    catalog, audit = {}, collections.Counter()
    issues = []
    for card_id, engine in cards.items():
        candidates = candidate_records(engine, by_name)
        candidates = sorted(candidates, key=lambda r: (
            exact_block(engine, r) is None,
            not any(p["language"] == "zh-Hans" for p in r["printings"]),
            r["page_id"],
        ))
        source = candidates[0] if candidates else None
        item = {"name": None, "attacks": [], "power": None, "source": None, "scan": None}
        if engine["kind"] == "energy" and not engine.get("special"):
            item["name"] = TYPES[engine["energyType"]] + "能量"
            audit["basic_energy_names"] += 1
        elif name_key(engine["name"]) in COMMUNITY_NAMES:
            item["name"] = COMMUNITY_NAMES[name_key(engine["name"])]
            item["name_review"] = "community_display_name_no_verified_mainland_printing"
        elif source:
            item["name"] = chinese_name(source)
            if name_key(engine["name"]) in {"boss's orders", "professor's research"}:
                item["name"] = "老大的指令" if "orders" in name_key(engine["name"]) else "博士的研究"
            item["source"] = source["id"]
            references[source["id"]] = {
                "title": source["title"], "url": source["source_url"],
                "revision": source["revision_id"], "raw_sha256": source["source_wikitext_sha256"],
            }
        if not item["name"]:
            issues.append({"card": card_id, "field": "name", "english": engine["name"]})
            item["name"] = engine["name"]
        else:
            audit["cards_with_chinese_name"] += 1
            names[normalize(engine["name"])][item["name"]] += 1000
        block = exact_block(engine, source) if source else None
        if block:
            audit["same_version_structural_matches"] += 1
            if not item["source"]:
                item["source"] = source["id"]
                references[source["id"]] = {
                    "title": source["title"], "url": source["source_url"],
                    "revision": source["revision_id"], "raw_sha256": source["source_wikitext_sha256"],
                }
        for i, attack in enumerate(engine.get("attacks", [])):
            matching = block["attacks"][i] if block and i < len(block["attacks"]) else None
            zh = localized(matching, "names") if matching else None
            choices = attack_names.get(attack_key(attack["name"]), {})
            zh = zh or (max(choices, key=choices.get) if choices else None)
            override = FIELD_OVERRIDES.get((card_id, i))
            if override:
                page_id, slot, reason = override
                record = next(r for r in records if r["page_id"] == page_id)
                candidate = record["card_blocks"][0]["attacks"][slot]
                assert normalize(candidate["damage"]) == normalize(attack["damage"])
                assert tuple(energy_type(c) for c in candidate["cost"]) == tuple(TYPES[t] for t in attack["cost"])
                zh = localized(candidate, "names")
                item.setdefault("field_notes", []).append({"field": f"attacks.{i}", "source": record["id"], "reason": reason})
            if zh and attack.get("effect", {}).get("gx") and not zh.endswith("GX"):
                zh += "GX"
            effect = localized(matching, "effects") if matching else None
            item["attacks"].append({"name": zh or attack["name"], "effect": effect})
            if zh:
                audit["attacks_with_chinese_name"] += 1
            else:
                issues.append({"card": card_id, "field": f"attacks.{i}", "english": attack["name"]})
        if engine.get("power"):
            choices = power_names.get(power_key(engine["power"]["name"]), {})
            item["power"] = max(choices, key=choices.get) if choices else None
            if not item["power"]:
                issues.append({"card": card_id, "field": "power", "english": engine["power"]["name"]})
        if block and len(source["card_blocks"]) == 1:
            image = select_image(source, images)
            if image:
                item["scan"] = image
                if image.get("derived_from_official_graphic"):
                    audit["cards_with_public_promotional_crop:" + image["image_language"]] += 1
                else:
                    audit["cards_with_exact_cached_scan:" + image["image_language"]] += 1
        catalog[card_id] = item
    # Exact normalized names are safe to translate even when a log omits the card ID.
    words = {}
    for table in [attack_names, power_names, names]:
        for en, choices in table.items():
            if choices:
                words[en] = max(choices, key=choices.get)
    for engine in cards.values():
        item = catalog[engine["id"]]
        for original, translated in zip(engine.get("attacks", []), item["attacks"]):
            words.setdefault(normalize(original["name"]), translated["name"])
        if engine.get("power") and item["power"]:
            words[normalize(engine["power"]["name"])] = item["power"]
    audit["cards"] = len(cards)
    return catalog, words, references, dict(audit), issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--academy", type=Path, default=ACADEMY_ROOT)
    parser.add_argument("--database", type=Path, default=ROOT / "data/2026.10.18/cards.sqlite")
    args = parser.parse_args()
    cards, decks = academy_cards(args.academy)
    db = sqlite3.connect(f"file:{args.database.resolve()}?mode=ro", uri=True)
    metadata = {k: json.loads(v) for k, v in db.execute("SELECT key,value FROM metadata")}
    records = [json.loads(row[0]) for row in db.execute("SELECT record_json FROM extracts WHERE status='card'")]
    records = [r for r in records if "tcg" in r["games"]]
    db.close()
    images = collections.defaultdict(list)
    for queue in [ROOT / "images/queue.sqlite", ROOT / "images-zh-hans/queue.sqlite",
                  ROOT / "images-academy-zh-hant/queue.sqlite"]:
        for key, assets in image_index(queue, metadata["archive_sha256"]).items():
            images[key].extend(assets)
    catalog, words, references, counts, issues = build_catalog(cards, records, images)
    scans = args.academy / "public/img/zh-scans"
    scans.mkdir(parents=True, exist_ok=True)
    for item in catalog.values():
        if not item["scan"]:
            continue
        scan = item["scan"]
        filename = scan["sha256"] + Path(scan["local_file"]).suffix
        target = scans / filename
        if not target.exists():
            shutil.copyfile(scan["local_file"], target)
        item["scan"] = {
            key: scan.get(key) for key in [
                "image_language", "label", "sha256", "source_page_url", "printings", "wiki_filename",
                "byte_identical_to_wiki_copy", "wiki_file_sha1",
                "derived_from_official_graphic",
            ]
        } | {"url": "img/zh-scans/" + filename}
    folder = args.academy / "public/data/locales"
    folder.mkdir(parents=True, exist_ok=True)
    output = {
        "cards": catalog, "words": words, "sources": references,
        "archive": {"release": metadata["archive_release"], "sha256": metadata["archive_sha256"]},
        "attribution": {
            "source": "神奇宝贝百科及其贡献者", "license": "CC-BY-NC-SA-3.0",
            "url": "https://wiki.52poke.com/wiki/神奇宝贝百科:版权声明",
            "modified": True,
            "notice": "提取并转换为简体中文，术语及卡名尚需逐卡复核；不代表官方核准译名。",
        },
    }
    (folder / "zh-CN.js").write_text(
        "// Generated by 52poke-cards/export_academy.py. Data: CC BY-NC-SA 3.0; not MIT.\n"
        "export default " + json.dumps(output, ensure_ascii=False, separators=(",", ":")) + ";\n"
    )
    report = {"counts": counts, "unresolved": issues, "deck_count": len(decks),
              "source_database_unchanged": True, "engine_files_unchanged": True}
    (folder / "zh-CN-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
