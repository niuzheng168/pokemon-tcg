import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_research_cards import safe_image, preferred, compatible, verify


class LocalResearchTests(unittest.TestCase):
    def test_only_numeric_dataset_image_paths_are_allowed(self):
        self.assertTrue(safe_image("img/530/6.png"))
        for path in ("../secret.png", "/img/1/2.png", "img/1/../../key", "img/1/cover.png", "img/1/2.svg", None):
            self.assertFalse(safe_image(path), path)

    def test_regular_variant_is_preferred_without_guessing_identity(self):
        a = {"id": 1, "image": "img/1/1.png", "details": {"special_shiny_type": 1}}
        b = {"id": 2, "image": "img/1/2.png", "details": {"special_shiny_type": 0}}
        self.assertEqual(preferred([a, b]), b)

    def test_hp_type_attack_cost_damage_and_retreat_are_checked(self):
        engine = {"kind": "pokemon", "hp": 70, "type": "Fire", "retreat": 1,
                  "attacks": [{"cost": ["Fire"], "damage": "30"}]}
        details = {"cardType": "1", "hp": 70, "attribute": "2", "retreatCost": 1,
                   "abilityItemList": [{"abilityCost": "2", "abilityDamage": "30"}]}
        self.assertTrue(compatible(engine, {"details": details}, {"2": "火"}, {"2": "火"}))
        for changes in ({"hp": 80}, {"attribute": "3"}, {"retreatCost": 2},
                        {"abilityItemList": [{"abilityCost": "2,2", "abilityDamage": "30"}]},
                        {"abilityItemList": [{"abilityCost": "2", "abilityDamage": "40"}]}):
            self.assertFalse(compatible(engine, {"details": {**details, **changes}}, {"2": "火"}, {"2": "火"}))

    def test_actual_git_blob_identity_not_dataset_hash_field_verifies_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "card.png"
            stream = io.BytesIO()
            Image.new("RGB", (3, 4), "blue").save(stream, "PNG")
            raw = stream.getvalue()
            path.write_bytes(raw)
            expected = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            result = verify(path, expected)
            self.assertEqual(result["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual((result["width"], result["height"]), (3, 4))
            path.write_bytes(raw[:10])
            self.assertIsNone(verify(path, expected))


if __name__ == "__main__":
    unittest.main()
