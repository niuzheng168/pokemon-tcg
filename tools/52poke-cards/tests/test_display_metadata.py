import copy
from pathlib import Path
import json
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from export_display_metadata import ChineseText, build_view, image_index, merged_image_index, select_image
from import_cards import parse_card

SAMPLE = """{{N|火箭隊的團珠蛛||ロケット団のタマンチュラ|Team Rocket's Tarountula}}
{{卡牌信息/header|name=团珠蛛|的宝可梦=火箭队|hp=50|type=草|evostage=基础|image=SV10F008.png}}
{{卡牌信息/attack|ZHSname=猛撞|ZHTname=猛撞|ename=Take Down|cost=草|damage=30
|effectZHS=给这只宝可梦也造成10伤害。|effectZHT=這隻寶可夢也受到10點傷害。}}
{{卡牌信息/svend|weakness=火|retreat=1}}
{{ExpansionList/main/zh|cnicon=CSV10C|cnexpansion=共逐荣光|cnno=018/222|cnimg=
|zhicon=SV10F|zhexpansion=火箭隊的榮耀|zhno=008/098|zhimg=SV10F008.png}}
"""


def fixture():
    card, _ = parse_card({
        "page_id": 284937, "title": "火箭队的团珠蛛（SV10）",
        "revision_id": 2605286, "timestamp": "2026-07-17T01:30:12Z", "wikitext": SAMPLE,
    })
    return card


def image(language="zh-Hant", filename="SV10F008.png", checksum="hant"):
    return {
        "wiki_filename": filename, "image_language": language,
        "local_file": "/example/card.png", "width": 868, "height": 1212,
        "sha256": checksum, "source_page_url": "https://example.invalid/card",
    }


class MetadataTests(unittest.TestCase):
    def test_effect_terms_follow_official_simplified_glossary_with_provenance(self):
        text = ChineseText()
        result = text.choose("blocks.0.attacks.0.effect", {"zh-Hans": {"text": "不计算抵抗力。回合间检查时丢弃场地卡。"}})
        self.assertEqual(result, "不计算抗性。宝可梦检查时丢弃竞技场卡。")
        provenance = text.provenance["blocks.0.attacks.0.effect"]
        self.assertEqual(provenance["conversion"], "none", "Terminology edits are not glyph conversion.")
        self.assertEqual({c["from"] for c in provenance["terminology_normalization"]},
                         {"抵抗力", "回合间检查", "场地卡"})
        self.assertFalse(provenance["human_reviewed"])

    def test_proper_names_are_not_rewritten_as_rule_terms(self):
        text = ChineseText()
        self.assertEqual(text.choose("attacks.0.name", {"zh-Hans": {"text": "先手必胜"}}), "先手必胜")
        self.assertNotIn("terminology_normalization", text.provenance["attacks.0.name"])

    def test_multiple_image_queues_merge_without_duplicate_photos(self):
        key = (284937, "SV10F008.png")
        hant, hans = image(), image("zh-Hans", checksum="hans")
        with patch("export_display_metadata.image_index", side_effect=[{key: [hant]}, {key: [hant, hans]}]):
            combined = merged_image_index([Path("traditional"), Path("simplified")], "same-archive")
        self.assertEqual(combined[key], [hant, hans])
        self.assertEqual(select_image(fixture(), combined)["image_language"], "zh-Hans")

    def test_identical_photo_hash_prefers_simplified_regardless_of_queue_order(self):
        key = (284937, "SV10F008.png")
        combined = {key: [image("zh-Hans", checksum="same"), image("zh-Hant", checksum="same")]}
        self.assertEqual(select_image(fixture(), combined)["image_language"], "zh-Hans")

    def test_other_archive_image_queue_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "queue.sqlite"
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE metadata(key TEXT,value TEXT)")
            db.execute("INSERT INTO metadata VALUES ('plan',?)", (json.dumps({"archive_sha256": "other"}),))
            db.commit()
            db.close()
            with self.assertRaisesRegex(ValueError, "different archives"):
                image_index(path, "expected")

    def test_explicit_simplified_text_wins(self):
        text = ChineseText()
        result = text.choose("effect", {
            "zh-Hans": {"text": "给这只宝可梦也造成10伤害。", "parameter": "effectZHS"},
            "zh": {"text": "通用中文"},
            "zh-Hant": {"text": "繁體中文"},
        })
        self.assertEqual(result, "给这只宝可梦也造成10伤害。")
        self.assertEqual(text.provenance["effect"]["source_parameter"], "effectZHS")
        self.assertTrue(text.provenance["effect"]["declared_simplified_in_source"])

    def test_traditional_fallback_is_converted_and_flagged(self):
        text = ChineseText()
        result = text.choose("effect", {"zh-Hant": {"text": "這隻寶可夢也受到10點傷害。"}})
        self.assertEqual(result, "这只宝可梦也受到10点伤害。")
        self.assertEqual(text.provenance["effect"]["conversion"], "opencc-t2s")
        self.assertIn("fallback_text_requires_terminology_review", text.warnings)

    def test_generic_mixed_chinese_is_simplified(self):
        text = ChineseText()
        self.assertEqual(text.choose("name", {"zh": {"text": "火箭隊的团珠蛛"}}), "火箭队的团珠蛛")

    def test_no_foreign_text_fallback(self):
        text = ChineseText()
        self.assertIsNone(text.choose("name", {"en": {"text": "Take Down"}}, required=True))
        self.assertIn("missing_chinese_text", text.warnings)

    def test_traditional_image_and_simplified_metadata_are_independent(self):
        card = fixture()
        images = {(284937, "SV10F008.png"): [image()]}
        result = build_view(card, images)
        self.assertEqual(result["metadata_language"], "zh-Hans")
        self.assertEqual(result["display"]["name"], "火箭队的团珠蛛")
        self.assertEqual(result["blocks"][0]["display"]["hp"], 50)
        self.assertEqual(result["blocks"][0]["attacks"][0]["display"], {
            "name": "猛撞", "effect": "给这只宝可梦也造成10伤害。",
            "damage": "30", "energy_cost": ["草"],
        })
        self.assertEqual(result["image"]["image_language"], "zh-Hant")
        self.assertEqual(result["display"]["image_label"], "繁体原卡图")
        self.assertFalse(result["image"]["is_simplified_printing_scan"])
        self.assertEqual(result["image"]["printings"][0]["number"], "008/098")
        self.assertEqual(result["simplified_printings"][0]["number"], "018/222")

    def test_view_does_not_mutate_source_or_ids(self):
        original = fixture()
        before = copy.deepcopy(original)
        view = build_view(original)
        self.assertEqual(original, before)
        self.assertEqual(view["id"], original["id"])
        self.assertEqual(view["revision_id"], original["revision_id"])
        self.assertFalse(view["rules_engine_implemented"])

    def test_missing_image_does_not_hide_metadata(self):
        result = build_view(fixture())
        self.assertIsNone(result["image"])
        self.assertEqual(result["display"]["image_label"], "暂无卡图")
        self.assertEqual(result["blocks"][0]["attacks"][0]["display"]["name"], "猛撞")

    def test_available_simplified_image_preferred(self):
        card = fixture()
        card["images"].append({"file_name": "CSV10C018.png"})
        result = select_image(card, {
            (284937, "SV10F008.png"): [image()],
            (284937, "CSV10C018.png"): [image("zh-Hans", "CSV10C018.png", "hans")],
        })
        self.assertEqual(result["image_language"], "zh-Hans")

    def test_no_same_name_other_page_matching(self):
        self.assertIsNone(select_image(fixture(), {(999, "SV10F008.png"): [image()]}))

    def test_ability_trainer_and_footer_text_are_also_simplified(self):
        card = fixture()
        card["card_blocks"][0]["abilities"] = [{
            "source_template_index": 33,
            "names": {"zh-Hant": {"text": "充電"}},
            "effects": {"zh-Hant": {"text": "從棄牌區選擇1張能量卡。"}},
        }]
        card["card_blocks"][0]["effects"] = [{
            "source_template_index": 34, "template": "训练家卡信息/main",
            "texts": {"zh-Hant": {"text": "將自己的牌庫洗牌。"}},
        }]
        card["card_blocks"][0]["footers"][0]["fields"]["weakness"] = "鬥"
        result = build_view(card)
        self.assertEqual(result["blocks"][0]["abilities"][0]["display"]["name"], "充电")
        self.assertEqual(result["blocks"][0]["abilities"][0]["display"]["effect"], "从弃牌区选择1张能量卡。")
        self.assertEqual(result["blocks"][0]["effects"][0]["display"]["effect"], "将自己的牌库洗牌。")
        self.assertEqual(result["blocks"][0]["footers"][0]["display"]["weakness"], "斗")

    def test_multi_version_trainer_is_not_silently_claimed_complete(self):
        card = fixture()
        card["card_blocks"][0]["effects"] = [{
            "source_template_index": 34, "template": "训练家卡信息/multimain",
            "texts": {}, "fields": {"ceffect2": "版本专属文字"},
        }]
        result = build_view(card)
        self.assertIn("version_specific_trainer_text_not_flattened", result["review"]["warnings"])
        self.assertIsNone(result["blocks"][0]["effects"][0]["display"]["effect"])


if __name__ == "__main__":
    unittest.main()
