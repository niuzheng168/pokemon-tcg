import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recover_image_references import candidates
from export_display_metadata import select_image


def record(page=1, code="CSV1C", number="001/100", image=None):
    return {"games": ["tcg"], "page_id": page, "title": "示例卡（TCG）", "revision_id": page + 10,
            "printings": [{"language": "zh-Hans", "set_code": code, "number": number,
                           "image": {"file_name": image} if image else None, "source_template_index": 4}]}


class RecoveryTests(unittest.TestCase):
    def test_only_real_supplied_file_names_are_considered(self):
        result = candidates([record()], ["File:CSV1C001.png", "File:CSV1C002.png"], set())
        self.assertEqual(set(result), {"CSV1C001.png"})
        self.assertIsNone(result["CSV1C001.png"]["original_image_field"])
        self.assertEqual(candidates([record()], [], set()), {})

    def test_existing_queue_files_are_not_recreated(self):
        self.assertEqual(candidates([record()], ["CSV1C001.png"], {"CSV1C001.png"}), {})

    def test_ambiguous_page_or_denominator_is_never_guessed(self):
        for records in ([record(), record(page=2)], [record(), record(number="001/200")]):
            self.assertEqual(candidates(records, ["CSV1C001.png"], set()), {})

    def test_prefix_alias_requires_an_explicit_existing_printing_image(self):
        source = record(code="SV-P", number="001/SV-P", image="SVPC001.png")
        second = record(page=2, code="SV-P", number="002/SV-P")
        self.assertIn("SVPC002.png", candidates([source, second], ["SVPC002.png"], set()))
        self.assertEqual(candidates([second], ["SVPC002.png"], set()), {})

    def test_non_simplified_printings_do_not_supply_simplified_candidates(self):
        source = record()
        source["printings"][0]["language"] = "zh-Hant"
        self.assertEqual(candidates([source], ["CSV1C001.png"], set()), {})

    def test_unverified_additional_image_or_other_page_cannot_be_selected(self):
        card = {"page_id": 1, "images": [], "printings": []}
        asset = {"wiki_filename": "CSV1C001.png", "image_language": "zh-Hans",
                 "width": 868, "height": 1212, "sha256": "test"}
        self.assertIsNone(select_image(card, {(1, None): [asset]}))
        verified = {**asset, "recovered_existing_File_for_printing": True,
                    "printed_identity": {"language": "zh-Hans", "set_code": "CSV1C", "number": "001/100",
                                         "derived_from_image": True}}
        self.assertIsNone(select_image(card, {(2, None): [verified]}))
        before = copy.deepcopy(card)
        self.assertEqual(select_image(card, {(1, None): [verified]})["printings"], [verified["printed_identity"]])
        self.assertEqual(card, before)


if __name__ == "__main__":
    unittest.main()
