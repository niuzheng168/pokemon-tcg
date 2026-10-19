import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from accept_official_candidates import agreement, name
from collect_official_candidates import second_reading_useful
from image_identity import printed_number, printed_set


def reading(number="115/SV-P", code="SV-P", **changes):
    value = {"name": "轻身鳕", "number": number, "set_code": code, "hp": 130,
             "language": "zh-Hans", "confidence": 1}
    value.update(changes)
    return value


class IdentityTests(unittest.TestCase):
    def test_printed_number_formats_and_padding(self):
        for value, expected in [
            ("001/100", ("fraction", 1, 100)),
            ("１１５／ＳＶ－Ｐ", ("promo", 115, "SV-P")),
            ("001/30th-P", ("promo", 1, "30TH-P")),
            ("01 06/09", ("pack", 1, 6, 9)),
            ("B/RGB", ("color", "B", "RGB")),
            ("001/P", ("promo", 1, "P")),
        ]:
            with self.subTest(value=value):
                self.assertEqual(printed_number(value), expected)
        self.assertEqual(printed_number("001 / 0100"), printed_number("1/100"))

    def test_malformed_partial_or_ambiguous_identifiers_rejected(self):
        for text in ("", None, "115", "SV-P", "?", "115/SV/P", "1/100 extra", "1//100", "unknown/unknown"):
            self.assertIsNone(printed_number(text), text)

    def test_pack_prefix_and_promo_suffix_cannot_be_discarded(self):
        self.assertNotEqual(printed_number("01 06/09"), printed_number("06/09"))
        self.assertNotEqual(printed_number("01 06/09"), printed_number("02 06/09"))
        self.assertNotEqual(printed_number("115/SV-P"), printed_number("115/S-P"))

    def test_promo_series_is_only_derived_from_the_actual_printed_suffix(self):
        self.assertEqual(printed_set("115/SV-P", "115/SV-P"), "SV-P")
        self.assertEqual(printed_set(None, "115/SV-P"), "SV-P")
        self.assertEqual(printed_set(None, "001/30th-P"), "30TH-P")
        self.assertIsNone(printed_set(None, "115/100"))
        self.assertEqual(printed_set("SV-P", "001/30th-P"), "SV-P")
        self.assertNotEqual(printed_set(None, "001/30th-P"), "SV-P")

    def test_case_and_ocr_spacing_not_hyphens_or_dots_are_normalized(self):
        self.assertEqual(printed_set("csDC E"), "CSDCE")
        self.assertEqual(printed_set("CS 4.1 C"), "CS4.1C")
        self.assertNotEqual(printed_set("CS4.1C"), printed_set("CS41C"))
        self.assertNotEqual(printed_set("SV-P"), printed_set("SVP"))

    def test_both_ocr_reads_still_have_to_agree_for_promos(self):
        self.assertTrue(agreement(reading(), reading(code="115/SV-P")))
        for change in ({"number": "116/SV-P"}, {"name": "轻身鳄"}, {"language": "zh-Hant"},
                       {"set_code": "S-P"}, {"hp": 120}, {"confidence": .97}):
            self.assertFalse(agreement(reading(), reading(**change)))
        self.assertTrue(second_reading_useful({"reading": reading()}))
        self.assertFalse(second_reading_useful({"reading": reading(number=None, code=None)}))

    def test_only_unambiguous_energy_symbols_are_equivalent(self):
        self.assertEqual(name("基本⚡能量"), name("基本雷能量"))
        self.assertEqual(name("基本🔥能量"), name("基本火能量"))
        self.assertEqual(name("基本🌑能量"), name("基本恶能量"))
        self.assertEqual(name("基本👁能量"), name("基本超能量"))
        self.assertNotEqual(name("基本👁能量"), name("基本恶能量"))
        self.assertNotEqual(name("基本⚪能量"), name("基本钢能量"))
        self.assertNotEqual(name("基本能量"), name("基本草能量"))


if __name__ == "__main__":
    unittest.main()
