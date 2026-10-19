from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from public_collage_cards import left_card_box
from export_display_metadata import select_image


class PublicCollageTests(unittest.TestCase):
    def test_full_height_caption_layout_does_not_trim_or_resize(self):
        self.assertEqual(left_card_box(2016, 1210), (0, 0, 895, 1210))
        for width, height in [(868, 1212), (1845, 601), (2628, 2442), (166, 100)]:
            self.assertIsNone(left_card_box(width, height))

    def test_crop_label_is_distinct_and_originals_stay_preferred(self):
        card = {"page_id": 1, "images": [{"file_name": "one.png"}], "printings": []}
        crop = {"wiki_filename": "One.png", "image_language": "zh-Hans",
                "width": 895, "height": 1210, "sha256": "crop",
                "derived_from_official_graphic": {"resized": False}}
        original = {"wiki_filename": "One.png", "image_language": "zh-Hant",
                    "width": 299, "height": 418, "sha256": "original"}
        key = (1, "One.png")
        self.assertIn("官网配图裁取，非原件", select_image(card, {key: [crop]})["label"])
        self.assertEqual(select_image(card, {key: [crop, original]})["sha256"], "original")


if __name__ == "__main__":
    unittest.main()
