import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from accept_official_candidates import retain_stronger_evidence
import review_card_details as details


class DetailReviewTests(unittest.TestCase):
    def test_rarity_is_separate_without_truncating_pack_or_promo_identifiers(self):
        raw = {"reading": {"number": "081/103 RR"}}
        parsed = details.separate_rarity_token(raw)
        self.assertEqual(parsed["reading"]["number"], "081/103")
        self.assertEqual(parsed["raw_reading"]["number"], "081/103 RR")
        for identifier in ["081/103RR", "01 06/09", "001/30th-P", "081/103 XYZ", "081/103 1"]:
            original = {"reading": {"number": identifier}}
            self.assertEqual(details.separate_rarity_token(original), original)

    def test_separate_regulation_mark_does_not_change_printed_identifier(self):
        seed = {"set_code": "CSGC", "number": "005/008"}
        raw = {"reading": {"set_code": "csGC D", "number": "D 005/008", "name": "雷伊布"}}
        parsed = details.separate_regulation_tokens(seed, raw)
        self.assertEqual(parsed["reading"]["set_code"], "csGC")
        self.assertEqual(parsed["reading"]["number"], "005/008")
        self.assertEqual(parsed["raw_reading"], raw["reading"])
        self.assertEqual(raw["reading"]["set_code"], "csGC D", "Original observation is immutable.")
        prefix = details.separate_regulation_tokens({"set_code": "30thC", "number": "081/103"},
                                                   {"reading": {"set_code": "J 30th C", "number": "081/103"}})
        self.assertEqual(prefix["reading"]["set_code"], "30th C")
        for code, identifier in [("CSGCD", "005/008"), ("CS4 C", "005/008"), ("CSGC", "01 005/008"),
                                 ("CSGC", "F 006/008"), ("CSGC", "SSR 005/008")]:
            raw = {"reading": {"set_code": code, "number": identifier}}
            self.assertEqual(details.separate_regulation_tokens(seed, raw), raw)

    def test_byte_exact_image_is_never_downgraded(self):
        old = {"byte_identical_to_wiki_copy": True, "content_hash_verification": {"sha1": "wiki"}}
        self.assertIsNone(retain_stronger_evidence(old, {"sha256": "a"}, {"method": "OCR"}, {"sha256": "b"}))

    def test_same_bytes_retain_file_specific_hash_proof(self):
        old = {"byte_identical_to_wiki_copy": True, "content_hash_verification": {"sha1": "wiki"}}
        combined = retain_stronger_evidence(old, {"sha256": "a"}, {"method": "OCR"}, {"sha256": "a"})
        self.assertTrue(combined["byte_identical_to_wiki_copy"])
        self.assertEqual(combined["content_hash_verification"], old["content_hash_verification"])

    def test_target_still_requires_exact_source_series_full_number_and_name(self):
        use = {"language": "zh-Hans", "set_code": "CS1.5C", "number": "009/055", "title": "丰蜜龙（TCG）"}
        jobs = [{"filename": "CS1.5C009.png", "source_evidence": "https://www.pokemon.cn/tcg/product/test.html",
                 "uses_json": json.dumps([use])}]
        read = {"name": "丰蜜龙", "set_code": "CS1.5C", "number": "009/055",
                "language": "zh-Hans", "confidence": 1, "hp": 90}
        photo = {"url": "https://image.pokemon.com.cn/one.png", "page_url": "https://www.pokemon.cn/tcg/product/test.html",
                 "ocr": json.dumps({"reading": read}), "second_ocr": None}
        self.assertEqual(len(details.review_targets(jobs, [photo], {})), 1)
        for change in ({"set_code": "CS15C"}, {"number": "010/055"}, {"name": "苹裹龙"}, {"confidence": .95}):
            altered = {**photo, "ocr": json.dumps({"reading": {**read, **change}})}
            self.assertEqual(details.review_targets(jobs, [altered], {}), [])
        self.assertEqual(details.review_targets(jobs, [{**photo, "page_url": "https://www.pokemon.cn/tcg/other.html"}], {}), [])
        bad_first = json.dumps({"reading": {**read, "set_code": "unreadable"}})
        second_seed = {**photo, "ocr": bad_first, "second_ocr": photo["ocr"]}
        selected = details.review_targets(jobs, [second_seed], {})
        self.assertEqual(selected[0][1]["seed_column"], "second_ocr")
        self.assertEqual(selected[0][1]["ocr"], bad_first, "Seed selection must not overwrite the stored observation.")

    def test_enlarged_views_only_accept_intact_public_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "files" / "card.png"
            path.parent.mkdir()
            Image.new("RGB", (710, 1000), "green").save(path)
            asset = {"local_file": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                     "official_image_url": "https://image.pokemon.com.cn/card.png"}
            with patch.object(details, "DIRECTORY", root):
                views = details.detail_views(asset)
                self.assertEqual(len(views), 3)
                with Image.open(io.BytesIO(views[2])) as image:
                    self.assertGreater(image.width, int(710 * .56))
                restricted = root / "research.png"
                restricted.write_bytes(path.read_bytes())
                with self.assertRaises(ValueError):
                    details.detail_views({**asset, "local_file": str(restricted)})
                path.write_bytes(b"changed")
                with self.assertRaises(ValueError):
                    details.detail_views(asset)


if __name__ == "__main__":
    unittest.main()
