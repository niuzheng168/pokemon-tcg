import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apply_basic_visual_reviews import validate


def inputs():
    review = {"method": "assistant_visual_inspection", "human_reviewed": False,
              "reviewer": "Codex", "inspected_evidence": "/local/contact-sheet.png",
              "sha256": "same", "image_url": "https://image.pokemon.com.cn/image.png",
              "printed_number": "137/052", "printed_set_code": "CSVL2C",
              "observed_type_symbol": "Fighting", "canonical_name": "基本斗能量", "image_language": "zh-Hans"}
    use = {"supplementary_basic_energy_header": True, "number_numerator": 137,
           "set_code": "CSVL2C", "basic_energy_type": "斗", "title": "基本斗能量（TCG）"}
    photo = {"url": review["image_url"], "record": json.dumps({"sha256": "same"})}
    return review, use, photo


class VisualReviewTests(unittest.TestCase):
    def test_explicit_visual_receipt_and_printed_edition_are_required(self):
        review, use, photo = inputs()
        self.assertEqual(validate(review, use, photo, {"CSVL2C": {"zh-Hans"}}), {"sha256": "same"})

    def test_wrong_bytes_number_type_or_review_claim_are_rejected(self):
        review, use, photo = inputs()
        for changes in ({"sha256": "other"}, {"printed_number": "139/052"},
                        {"observed_type_symbol": "Metal"}, {"human_reviewed": True},
                        {"printed_set_code": "CSV12C"}, {"canonical_name": "基本恶能量"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate({**review, **changes}, use, photo, {"CSVL2C": {"zh-Hans"}})

    def test_unknown_or_multilingual_edition_cannot_be_assumed_simplified(self):
        review, use, photo = inputs()
        for languages in ({}, {"CSVL2C": {"zh-Hant"}}, {"CSVL2C": {"zh-Hans", "zh-Hant"}}):
            with self.assertRaises(ValueError):
                validate(review, use, photo, languages)


if __name__ == "__main__":
    unittest.main()
