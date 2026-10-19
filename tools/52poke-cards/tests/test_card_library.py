import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import card_library as library
import card_storage as storage


def fixture_card(page_id=1, language="zh-Hans", number="001/151", code="151C"):
    return {
        "id": f"52poke:{page_id}", "page_id": page_id, "revision_id": 2, "games": ["tcg"],
        "printings": [{"language": language, "set_code": code, "number": number,
                       "source_template_index": 3, "rarity": "U"}],
        "source_url": "https://wiki.52poke.com/wiki/Example", "revision_url": "https://wiki.52poke.com/?oldid=2",
        "source_wikitext_sha256": "a" * 64, "archive_release": "2026.10.18",
        "attribution": {"source": "神奇宝贝百科"}, "rules_engine_implemented": False,
    }


def fixture_view(page_id=1):
    return {
        "page_id": page_id, "revision_id": 2, "metadata_language": "zh-Hans",
        "display": {"name": "妙蛙种子", "image_label": "暂无卡图"}, "blocks": [],
        "field_provenance": {}, "review": {"human_reviewed": False},
        "simplified_printings": [{"set_code": "151C", "display": {"set_name": "收集啦151"}}],
    }


class CardLibraryTests(unittest.TestCase):
    def test_cross_page_and_number_slug_collisions_are_not_collapsed(self):
        cards = {1: fixture_card(), 2: fixture_card(2)}
        groups, reviews, pending = library.build_groups(cards, {}, [], None)
        self.assertEqual(len(groups), 1)
        self.assertEqual({e["page_id"] for e in next(iter(groups.values()))["entries"]}, {1, 2})
        self.assertFalse(reviews or pending)
        with self.assertRaises(ValueError):
            library.make_metadata(next(iter(groups.values())), cards, {})

    def test_unidentified_and_pocket_rows_are_not_guessed_from_filename(self):
        card = fixture_card()
        card["printings"][0]["set_code"] = None
        groups, reviews, _ = library.build_groups({1: card}, {}, [], None)
        self.assertFalse(groups)
        self.assertEqual(reviews[0]["reason"], "missing_or_unsupported_set_code")

    def test_image_binding_requires_matching_language_and_explicit_identity(self):
        card = fixture_card()
        asset = {"filename": "151C001.png", "uses": [{"page_id": 1, **card["printings"][0]}],
                 "verification": {}, "asset": {"image_language": "zh-Hant", "local_file": "/public/cache.png", "sha256": "a" * 64}}
        groups, _, pending = library.build_groups({1: card}, {}, [asset], None)
        self.assertFalse(next(iter(groups.values()))["assets"])
        self.assertEqual(pending[0]["reasons"], ["image_language_does_not_match_printing"])

    def test_basic_energy_identity_can_be_completed_from_existing_verified_evidence(self):
        card = fixture_card()
        card["printings"] = []
        item = {
            "filename": "CSVL2C137.png", "uses": [{
                "page_id": 1, "language_is_requested_target_not_image_verification": True,
            }],
            "asset": {"image_language": "zh-Hans", "local_file": "/public/cache.png", "sha256": "a" * 64},
            "verification": {"basic_energy_header": True, "reading": {
                "language": "zh-Hans", "set_code": "CSVL2C", "number": "137/052",
            }},
        }
        groups, _, pending = library.build_groups({1: card}, {1: fixture_view()}, [item], None)
        group = next(iter(groups.values()))
        self.assertEqual(group["identity"]["number"], "137/052")
        self.assertEqual(len(group["assets"]), 1)
        self.assertFalse(pending)
        metadata = library.make_metadata(group, {1: card}, {1: fixture_view()})
        self.assertIn("identity_completed_from_verified_image_evidence", metadata["review_flags"])

    def test_case_aliases_share_one_folder_but_original_rows_are_preserved(self):
        card = fixture_card(code="csvL2C")
        card["printings"].append({**card["printings"][0], "set_code": "CSVL2C"})
        groups, _, _ = library.build_groups({1: card}, {}, [], None)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(next(iter(groups.values()))["entries"]), 2)

    def test_simplified_display_is_independent_of_printing_language_and_rules_ids(self):
        card = fixture_card(language="zh-Hant")
        groups, _, _ = library.build_groups({1: card}, {}, [], None)
        metadata = library.make_metadata(next(iter(groups.values())), {1: card}, {1: fixture_view()})
        self.assertEqual(metadata["metadata_language"], "zh-Hans")
        self.assertEqual(metadata["printing_language"], "zh-Hant")
        self.assertEqual(metadata["name"], "妙蛙种子")
        self.assertEqual(metadata["source_pages"][0]["id"], "52poke:1")
        self.assertEqual(metadata["source_printings"][0]["printing"]["rarity"], "U")
        self.assertNotIn("image_label", metadata["display"])
        self.assertFalse(metadata["rules_engine_implemented"])

    def test_full_offline_sync_is_idempotent_and_records_reviews(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cards = [fixture_card(), fixture_card(2, number="002/151"), fixture_card(3, number="002/151")]
            invalid = fixture_card(4, number="未知")
            cards.append(invalid)
            views = [fixture_view(n) for n in range(1, 5)]
            for name, rows in (("cards.jsonl", cards), ("views.jsonl", views)):
                (root / name).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
            storage.atomic_json(root / "audit.json", {"archive_sha256": "a" * 64})
            target = root / "nas-library"
            with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
                first = library.sync(root / "cards.jsonl", root / "views.jsonl", [], target)
                second = library.sync(root / "cards.jsonl", root / "views.jsonl", [], target)
            self.assertEqual(first["counts"]["printings"], 1)
            self.assertEqual(first["counts"]["identity_collisions"], 1)
            self.assertEqual(first["unidentified_printing_rows"], 1)
            self.assertEqual(second["counts"].get("metadata_files_written", 0), 0)
            self.assertEqual(len(list(target.rglob("metadata.json"))), 1)
            self.assertFalse((target / "tcg").exists())
            meta = json.loads((target / "zh-Hans/151C/001_151/metadata.json").read_text())
            self.assertEqual(meta["number"], "001/151")
            self.assertEqual(meta["metadata_language"], "zh-Hans")
            self.assertTrue((target / "_review/collisions.jsonl").read_text())

    def test_stale_display_revision_is_rejected(self):
        card = fixture_card()
        groups, _, _ = library.build_groups({1: card}, {}, [], None)
        view = fixture_view()
        view["revision_id"] = 999
        with self.assertRaises(ValueError):
            library.make_metadata(next(iter(groups.values())), {1: card}, {1: view})


if __name__ == "__main__":
    unittest.main()
