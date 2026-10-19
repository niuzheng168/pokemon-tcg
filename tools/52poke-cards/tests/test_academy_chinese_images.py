import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from academy_chinese_images import select_jobs


def row(filename="SV1F001.png", page=1, language="zh-Hant", region="tw", status="pending"):
    return {"filename": filename, "status": status,
            "source_url": f"https://asia.pokemon-card.com/{region}/card-search/detail/123/",
            "uses_json": json.dumps([{"page_id": page, "language": language}])}


class AcademyImageTests(unittest.TestCase):
    def test_only_exact_needed_page_not_same_name_is_selected(self):
        result = select_jobs({1: ["engine-card"]}, [row(), row("SV1F002.png", page=2)])
        self.assertEqual(set(result), {"SV1F001.png"})
        self.assertEqual(result["SV1F001.png"]["cards"], {"engine-card"})

    def test_wrong_language_region_and_unresolved_sources_are_excluded(self):
        for candidate in [row(language="zh-Hans"), row(region="ja"), row(status="unresolved")]:
            self.assertEqual(select_jobs({1: ["engine-card"]}, [candidate]), {})

    def test_one_real_scan_is_selected_per_source_page(self):
        result = select_jobs({1: ["one", "two"]}, [row("AC1D001.png"), row("SV1F001.png")])
        self.assertEqual(set(result), {"SV1F001.png"})
        self.assertEqual(result["SV1F001.png"]["cards"], {"one", "two"})

    def test_existing_verified_cache_is_preferred_without_redownload(self):
        result = select_jobs({1: ["one"]}, [row("AC1D001.png", status="done"), row("SV1F001.png")])
        self.assertEqual(set(result), {"AC1D001.png"})


if __name__ == "__main__":
    unittest.main()
