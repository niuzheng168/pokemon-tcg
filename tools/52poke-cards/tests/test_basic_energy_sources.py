import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from basic_energy_sources import reference_for
from export_academy import exact_block
from export_display_metadata import build_view
from review_basic_energy import expected_identity


def card():
    return {
        "id": "52poke:1", "page_id": 1, "title": "基本火能量（TCG）", "display_name": "基本火能量",
        "revision_id": 2, "games": ["tcg"], "kinds": ["energy"], "warnings": [],
        "card_blocks": [{
            "game": "tcg", "kind": "energy", "header": {"base": "y"},
            "source_template_index": 3, "type": "火", "hp": None, "stage": None,
            "evolves_from": None, "attacks": [], "abilities": [], "effects": [], "footers": [],
        }],
        "images": [{"source_template_index": 3, "parameter": "image", "file_name": "CSVL2C133.png"}],
        "printings": [], "source_url": "https://wiki.52poke.com/wiki/基本火能量（TCG）",
        "revision_url": "https://wiki.52poke.com/index.php?oldid=2", "source_wikitext_sha256": "original",
        "attribution": {"license": "CC-BY-NC-SA-3.0"}, "rules_engine_implemented": False,
    }


def file_job(url="https://www.pokemon.cn/tcg/17590.html"):
    return {"filename": "CSVL2C133.png", "file_page_id": 4, "file_revision_id": 5,
            "source_evidence": "{{来源|[" + url + " 简中官方网站]}}"}


class BasicEnergyTests(unittest.TestCase):
    def test_focused_review_still_requires_two_reads_and_exact_expected_identity(self):
        use = reference_for(card(), file_job())["use"]
        read = {"name": "基本火能量", "set_code": "CSVL2C", "number": "133/052",
                "hp": None, "language": "zh-Hans", "confidence": 1}
        self.assertTrue(expected_identity(read, read, use))
        for changes in ({"number": "134/052"}, {"name": "基本钢能量"}, {"language": "zh-Hant"},
                        {"confidence": .95}, {"hp": 60}, {"set_code": "OTHER"}):
            self.assertFalse(expected_identity({**read, **changes}, {**read, **changes}, use))
        self.assertFalse(expected_identity(read, {**read, "number": "133/053"}, use))

    def test_archived_base_header_and_mainland_file_source_are_required(self):
        ref = reference_for(card(), file_job())
        self.assertEqual(ref["use"]["set_code"], "CSVL2C")
        self.assertEqual(ref["use"]["number_numerator"], 133)
        self.assertIsNone(ref["use"]["number"], "Do not invent the missing printed denominator.")
        self.assertTrue(ref["use"]["language_is_requested_target_not_image_verification"])

    def test_traditional_header_cannot_be_relabelled_by_filename(self):
        for url in ["https://asia.pokemon-card.com/tw/card-search/detail/1/",
                    "https://evil.example/www.pokemon.cn/tcg/17590.html",
                    "https://user@www.pokemon.cn/tcg/17590.html"]:
            self.assertIsNone(reference_for(card(), file_job(url)))
        no_source = file_job()
        no_source["source_evidence"] = "Unrelated https://www.pokemon.cn/tcg/17590.html"
        self.assertIsNone(reference_for(card(), no_source))

    def test_pokemon_and_special_energy_headers_are_never_fallbacks(self):
        source = card()
        source["card_blocks"][0]["kind"] = "pokemon"
        self.assertIsNone(reference_for(source, file_job()))
        source = card()
        del source["card_blocks"][0]["header"]["base"]
        self.assertIsNone(reference_for(source, file_job()))

    def test_ambiguous_source_or_header_images_are_rejected(self):
        source = file_job()
        source["source_evidence"] += "{{来源|[https://www.pokemon.cn/tcg/2.html 第二来源]}}"
        self.assertIsNone(reference_for(card(), source))
        record = card()
        record["images"].append(copy.deepcopy(record["images"][0]))
        self.assertIsNone(reference_for(record, file_job()))

    def test_wrong_header_template_or_filename_is_rejected(self):
        for key, value in [("source_template_index", 4), ("file_name", "other.png"), ("parameter", "cnimg")]:
            record = card()
            record["images"][0][key] = value
            self.assertIsNone(reference_for(record, file_job()))

    def test_basic_energy_effect_and_type_must_match_engine(self):
        engine = {"kind": "energy", "energyType": "Fire"}
        self.assertIsNotNone(exact_block(engine, card()))
        self.assertIsNone(exact_block({**engine, "special": True}, card()))
        self.assertIsNone(exact_block({**engine, "energyType": "Water"}, card()))
        record = card()
        record["card_blocks"][0]["effects"] = [{"text": "Additional historical rule"}]
        self.assertIsNone(exact_block(engine, record))
        record = card()
        record["card_blocks"].append(copy.deepcopy(record["card_blocks"][0]))
        self.assertIsNone(exact_block(engine, record), "Do not choose between ambiguous card blocks.")

    def test_printed_image_identity_does_not_mutate_missing_wiki_printings(self):
        source = card()
        before = copy.deepcopy(source)
        printed = {"language": "zh-Hans", "set_code": "CSVL2C", "number": "133/052",
                   "derived_from_image": True, "source_template_index": None,
                   "verification": "two_OCR_reads_exact_archived_basic_energy_header_source_set_numerator_name"}
        asset = {"wiki_filename": "CSVL2C133.png", "image_language": "zh-Hans",
                 "sha256": "image", "width": 868, "height": 1212, "printed_identity": printed}
        view = build_view(source, {(1, "CSVL2C133.png"): [asset]})
        self.assertEqual(view["simplified_printings"], [])
        self.assertEqual(view["image"]["printings"], [printed])
        self.assertEqual(source, before)


if __name__ == "__main__":
    unittest.main()
