import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from download_images import completed_binding_reusable


class PreparationRetentionTests(unittest.TestCase):
    def inputs(self):
        old = {"status": "done", "asset_url": "https://image.pokemon.com.cn/a.png",
               "file_page_id": 1, "file_revision_id": 2, "source_evidence": "archived source",
               "source_url": "https://www.pokemon.cn/tcg/product/one.html",
               "uses_json": json.dumps([{"page_id": 3}])}
        evidence = {"page_id": 1, "revision_id": 2, "evidence": "archived source"}
        return old, {"image_language": "zh-Hans"}, evidence, [{"page_id": 3}]

    def test_completed_mainland_binding_survives_older_asia_only_resolver(self):
        old, asset, evidence, refs = self.inputs()
        self.assertTrue(completed_binding_reusable(old, asset, evidence, refs, "zh-Hans"))
        self.assertTrue(completed_binding_reusable(old, asset, evidence, refs, "zh"))

    def test_language_revision_or_page_identity_change_does_not_reuse_binding(self):
        old, asset, evidence, refs = self.inputs()
        self.assertFalse(completed_binding_reusable(old, asset, evidence, refs, "zh-Hant"))
        self.assertFalse(completed_binding_reusable(old, asset, {**evidence, "revision_id": 99}, refs, "zh-Hans"))
        self.assertFalse(completed_binding_reusable(old, asset, evidence, [{"page_id": 4}], "zh-Hans"))
        self.assertFalse(completed_binding_reusable({**old, "status": "pending"}, asset, evidence, refs, "zh-Hans"))

    def test_traditional_origin_never_becomes_simplified_because_of_file_name(self):
        old, asset, evidence, refs = self.inputs()
        old["source_url"] = "https://asia.pokemon-card.com/tw/card-search/detail/123/"
        asset = {}
        self.assertTrue(completed_binding_reusable(old, asset or {"official_page_url": old["source_url"]}, evidence, refs, "zh-Hant"))
        self.assertFalse(completed_binding_reusable(old, {"official_page_url": old["source_url"]}, evidence, refs, "zh-Hans"))


if __name__ == "__main__":
    unittest.main()
