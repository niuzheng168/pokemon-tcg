"""Build Simplified Chinese display metadata without changing source data or game IDs."""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import quote, urlsplit

from opencc import OpenCC

from download_images import canonical_filename
from import_cards import ROOT, plain

CONVERTER = OpenCC("t2s")
KIND_LABELS = {"pokemon": "宝可梦", "trainer": "训练家", "energy": "能量"}
OFFICIAL_TERMS = {
    "回合间检查": "宝可梦检查", "抵抗力": "抗性", "场地卡": "竞技场卡",
    "先手": "先攻", "后手": "后攻", "气绝": "昏厥", "奖品卡": "奖赏卡", "基础能量": "基本能量",
    "候补宝可梦": "备战宝可梦", "候补席": "备战区", "候补区": "备战区",
    "后备宝可梦": "备战宝可梦", "后备区": "备战区", "弃牌堆": "弃牌区", "丢弃区": "弃牌区",
    "支持者卡": "支援者卡", "格斗能量": "斗能量", "格斗属性": "斗属性",
    "电能量": "雷能量", "电属性": "雷属性",
}

def simplified_variant(value):
    """Resolve explicit MediaWiki Chinese variants without executing templates."""
    def select(match):
        options = dict(re.findall(r"(zh(?:-[a-z]+)?):([^;]+)", match.group(1)))
        return options.get("zh-hans") or options.get("zh-cn") or options.get("zh") or next(iter(options.values()), "")
    return re.sub(r"-\{([^{}]*zh-[^{}]*)\}-", select, value)


class ChineseText:
    """All child-facing text is separate from audit/provenance fields."""
    def __init__(self):
        self.provenance = {}
        self.warnings = set()

    def render(self, path, value, source_language="zh", parameter=None, normalize_terms=False):
        if not value or not str(value).strip():
            return None
        raw = str(value)
        if "{{" in raw or "{{{" in raw or "-{" in raw:
            self.warnings.add("wiki_markup_requires_review")
        text = re.sub(r"\s+", " ", plain(simplified_variant(raw))).strip()
        text = CONVERTER.convert(text)
        if not text:
            self.warnings.add("empty_text_after_markup_removal")
            return None
        changed = text != re.sub(r"\s+", " ", plain(raw)).strip()
        if source_language != "zh-Hans":
            self.warnings.add("fallback_text_requires_terminology_review")
        self.provenance[path] = {
            "source_language": source_language, "source_parameter": parameter,
            "conversion": "opencc-t2s" if changed else "none",
            "declared_simplified_in_source": source_language == "zh-Hans",
            "human_reviewed": False,
        }
        if normalize_terms or re.search(r"(?:^|\.)(?:effect|effects)(?:\.|$)", path):
            changes = []
            for old, new in OFFICIAL_TERMS.items():
                if old in text:
                    text = text.replace(old, new)
                    changes.append({"from": old, "to": new})
            if changes:
                self.provenance[path]["terminology_normalization"] = changes
                self.provenance[path]["terminology_source"] = "https://www.pokemon.cn/tcg-about"
                self.warnings.add("official_glossary_terms_normalized_not_an_official_translation")
        return text

    def choose(self, path, options, required=False, normalize_terms=False):
        for language in ("zh-Hans", "zh", "zh-Hant"):
            candidate = options.get(language) or {}
            value = candidate.get("wikitext") or candidate.get("text")
            if value and str(value).strip():
                return self.render(path, value, language, candidate.get("parameter"), normalize_terms=normalize_terms)
        # Never display English/Japanese as if it were Simplified Chinese.
        if required or any(options.values()):
            self.warnings.add("missing_chinese_text")
        return None


def effect_view(item, path, text, attack=False):
    display = {
        "name": text.choose(path + ".name", item.get("names", {}), required=True),
        "effect": text.choose(path + ".effect", item.get("effects", {})),
    }
    if attack:
        display.update({
            "damage": item.get("damage"),
            "energy_cost": [
                text.render(f"{path}.energy_cost.{index}", cost)
                for index, cost in enumerate(item.get("cost_wikitext", item.get("cost", [])))
            ],
        })
    return {"source_template_index": item["source_template_index"], "display": display}


def read_only(path):
    db = sqlite3.connect(f"file:{quote(str(path.resolve()))}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def image_index(path, expected_archive_sha256):
    if not path.exists():
        return {}
    db = read_only(path)
    try:
        row = db.execute("SELECT value FROM metadata WHERE key='plan'").fetchone()
        plan = json.loads(row[0]) if row else {}
        if plan.get("archive_sha256") != expected_archive_sha256:
            raise ValueError("Image manifest and metadata come from different archives.")
        result = collections.defaultdict(list)
        verified = set()
        evidence_by_file = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='file_verifications'").fetchone():
            evidence_by_file = {r[0]: json.loads(r[1]) for r in db.execute("SELECT * FROM file_verifications")}
        for row in db.execute("""
            SELECT j.filename,j.uses_json,j.source_url,a.record_json FROM jobs j
            JOIN assets a ON j.asset_url=a.url WHERE j.status='done'
        """):
            asset = json.loads(row["record_json"])
            local = Path(asset["local_file"])
            if asset["sha256"] not in verified:
                if not local.is_file():
                    raise ValueError(f"Missing cached image: {local}")
                with local.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != asset["sha256"]:
                        raise ValueError(f"Cached image checksum mismatch: {local}")
                verified.add(asset["sha256"])
            official = urlsplit(row["source_url"])
            # Do not infer language from simplified card text or a filename.
            language = "zh-Hant" if (
                official.hostname == "asia.pokemon-card.com"
                and official.path.startswith(("/tw/", "/hk/"))
            ) else asset.get("image_language")
            if language not in {"zh-Hans", "zh-Hant"}:
                continue
            for use in json.loads(row["uses_json"]):
                filename = canonical_filename(use.get("referenced_filename") or row["filename"])
                candidate = {
                    "wiki_filename": filename, "image_language": language,
                    "local_file": str(local), "sha256": asset["sha256"],
                    "width": asset["width"], "height": asset["height"],
                    "source_page_url": row["source_url"],
                }
                if asset.get("source") == "crop_from_public_official_caption_graphic":
                    candidate["derived_from_official_graphic"] = asset["derivation"]
                evidence = evidence_by_file.get(row["filename"], asset.get("matching_evidence", {}))
                candidate["byte_identical_to_wiki_copy"] = evidence.get("byte_identical_to_wiki_copy")
                candidate["wiki_file_sha1"] = evidence.get("content_hash_verification", {}).get("sha1")
                recovered = evidence.get("recovered_existing_File_for_printing")
                if evidence.get("basic_energy_header") or recovered:
                    reading = evidence["reading"]
                    candidate["printed_identity"] = {
                        "language": language, "set_code": reading["set_code"], "number": reading["number"],
                        "derived_from_image": True, "source_template_index": evidence.get("wiki_printing_template_index"),
                        "verification": evidence["method"], "human_reviewed": False,
                    }
                result[(use["page_id"], filename)].append(candidate)
                if recovered:
                    # This is a verified additional reference, not a mutation of
                    # the original wiki printing's missing/different image field.
                    candidate["recovered_existing_File_for_printing"] = True
                    result[(use["page_id"], None)].append(candidate)
        return result
    finally:
        db.close()


def merged_image_index(paths, expected_archive_sha256):
    merged = collections.defaultdict(list)
    seen = set()
    for path in paths:
        for identity, candidates in image_index(path, expected_archive_sha256).items():
            for candidate in candidates:
                key = (identity, candidate["sha256"], candidate["image_language"])
                if key not in seen:
                    merged[identity].append(candidate)
                    seen.add(key)
    return merged


def select_image(card, images):
    candidates = {}
    additional = images.get((card["page_id"], None), [])
    for ref in card["images"]:
        filename = canonical_filename(ref.get("file_name", ""))
        for candidate in images.get((card["page_id"], filename), []):
            previous = candidates.get(candidate["sha256"])
            if previous is None or candidate["image_language"] == "zh-Hans":
                candidates[candidate["sha256"]] = candidate
    for candidate in additional:
        if candidate.get("recovered_existing_File_for_printing") and candidate.get("printed_identity"):
            previous = candidates.get(candidate["sha256"])
            if previous is None or candidate["image_language"] == "zh-Hans":
                candidates[candidate["sha256"]] = candidate
    if not candidates:
        return None
    chosen = min(candidates.values(), key=lambda image: (
        bool(image.get("derived_from_official_graphic")),
        image["image_language"] != "zh-Hans",
        -image["width"] * image["height"],
        image["wiki_filename"],
    ))
    matching_printings = [
        {
            "language": p["language"], "set_code": p.get("set_code"),
            "number": p.get("number"), "source_template_index": p["source_template_index"],
        }
        for p in card["printings"]
        if p["language"] == chosen["image_language"]
        and canonical_filename((p.get("image") or {}).get("file_name", "")) == chosen["wiki_filename"]
    ]
    if not matching_printings and chosen.get("printed_identity"):
        matching_printings.append(chosen["printed_identity"])
    return {
        **chosen,
        "label": ("简体卡图（官网配图裁取，非原件）" if chosen.get("derived_from_official_graphic")
                  else "简体原卡图" if chosen["image_language"] == "zh-Hans" else "繁体原卡图"),
        "printings": matching_printings,
        "same_language_as_metadata": chosen["image_language"] == "zh-Hans",
        "is_simplified_printing_scan": chosen["image_language"] == "zh-Hans",
        "note": "卡图保留原语言，简体说明见旁边文字；卡图编号与其他发行版编号分开保存。",
    }


def build_view(card, images=None):
    text = ChineseText()
    title = text.render("name", card["display_name"], "zh", "wiki_page_title")
    blocks = []
    for index, block in enumerate(card["card_blocks"]):
        path = f"blocks.{index}"
        if len(card["card_blocks"]) > 1:
            text.warnings.add("multiple_card_blocks_require_version_selection")
        footers = []
        for footer_index, footer in enumerate(block.get("footers", [])):
            fields = footer["fields"]
            prefix = f"{path}.footers.{footer_index}"
            footers.append({
                "source_template_index": footer["source_template_index"],
                "display": {
                    key: text.render(prefix + "." + key, fields.get(key))
                    for key in ("weakness", "resistance", "retreat")
                },
            })
        descriptions = []
        for effect_index, effect in enumerate(block.get("effects", [])):
            if "multimain" in effect["template"].lower():
                text.warnings.add("version_specific_trainer_text_not_flattened")
            descriptions.append({
                "source_template_index": effect["source_template_index"],
                "display": {"effect": text.choose(
                    f"{path}.effects.{effect_index}", effect.get("texts", {}), required=True,
                )},
            })
        blocks.append({
            "game": block["game"], "kind": block["kind"],
            "source_template_index": block["source_template_index"],
            "display": {
                "kind": KIND_LABELS[block["kind"]], "hp": block["hp"],
                "type": text.render(path + ".type", block.get("type")),
                "stage": text.render(path + ".stage", block.get("stage")),
                "evolves_from": text.render(path + ".evolves_from", block.get("evolves_from")),
            },
            "attacks": [effect_view(attack, f"{path}.attacks.{n}", text, attack=True)
                        for n, attack in enumerate(block.get("attacks", []))],
            "abilities": [effect_view(ability, f"{path}.abilities.{n}", text)
                          for n, ability in enumerate(block.get("abilities", []))],
            "effects": descriptions, "footers": footers,
        })
    printings = [
        {
            "language": p["language"], "set_code": p["set_code"], "number": p["number"],
            "source_template_index": p["source_template_index"],
            "display": {"set_name": text.render(f"printings.{i}.set_name", p["set_name"])},
        }
        for i, p in enumerate(card["printings"])
        if p["language"] == "zh-Hans" and any(p.get(key) for key in ("set_code", "set_name", "number"))
    ]
    image = select_image(card, images or {})
    return {
        "id": card["id"], "page_id": card["page_id"], "revision_id": card["revision_id"],
        "metadata_language": "zh-Hans",
        "display": {"name": title, "image_label": image["label"] if image else "暂无卡图"},
        "blocks": blocks, "simplified_printings": printings, "image": image,
        "field_provenance": text.provenance,
        "review": {
            "human_reviewed": False,
            "warnings": sorted(set(card.get("warnings", [])) | text.warnings),
            "note": "字形转简体不等于核准官方术语；缺失中文与复杂版本文字保留待审，不用外文替代。",
        },
        "source": {
            "url": card["source_url"], "revision_url": card["revision_url"],
            "wikitext_sha256": card["source_wikitext_sha256"],
        },
        "attribution": card["attribution"],
        "rules_engine_implemented": card["rules_engine_implemented"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=ROOT / "data/2026.10.18/cards.sqlite")
    parser.add_argument("--images", type=Path, action="append",
                        help="Image queue SQLite; repeat to merge. Defaults to all three local Chinese image queues.")
    parser.add_argument("--output", type=Path, default=ROOT / "data/2026.10.18/display-zh-hans")
    parser.add_argument("--title", help="Export just this exact title for inspection")
    args = parser.parse_args()
    db = read_only(args.database)
    try:
        metadata = {row["key"]: json.loads(row["value"]) for row in db.execute("SELECT * FROM metadata")}
        queues = args.images or [ROOT / "images/queue.sqlite", ROOT / "images-zh-hans/queue.sqlite",
                                 ROOT / "images-academy-zh-hant/queue.sqlite"]
        images = merged_image_index(queues, metadata["archive_sha256"])
        args.output.mkdir(parents=True, exist_ok=True)
        filename = "card.json" if args.title else "cards.jsonl"
        destination = args.output / filename
        temporary = destination.with_suffix(destination.suffix + ".part")
        query = "SELECT p.title,e.record_json FROM pages p JOIN extracts e USING(page_id) WHERE e.status='card'"
        rows = db.execute(query + (" AND p.title=?" if args.title else "") + " ORDER BY p.page_id",
                          (args.title,) if args.title else ())
        counts = collections.Counter()
        methods = collections.Counter()
        with temporary.open("w") as output:
            for row in rows:
                card = json.loads(row["record_json"])
                if "tcg" not in card["games"]:
                    continue
                view = build_view(card, images)
                output.write(json.dumps(view, ensure_ascii=False, indent=2 if args.title else None) + "\n")
                counts["cards"] += 1
                if view["image"]:
                    counts["cards_with_cached_image"] += 1
                    counts["image:" + view["image"]["image_language"]] += 1
                for provenance in view["field_provenance"].values():
                    methods[provenance["source_language"] + ":" + provenance["conversion"]] += 1
                for warning in view["review"]["warnings"]:
                    counts["warning:" + warning] += 1
        if not counts["cards"]:
            temporary.unlink()
            raise SystemExit("No matching TCG card.")
        temporary.replace(destination)
        report = {
            "archive_release": metadata["archive_release"],
            "metadata_language": "zh-Hans", "image_language_preference": ["zh-Hans", "zh-Hant"],
            "counts": dict(counts), "field_methods": dict(methods),
            "source_database_unchanged": True, "images_downloaded_by_this_export": 0,
            "image_queues": [str(path.resolve()) for path in queues],
            "note": "Display projection, not a full MediaWiki renderer, validated official translation, or rules engine.",
        }
        (args.output / "audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        db.close()


if __name__ == "__main__":
    main()
