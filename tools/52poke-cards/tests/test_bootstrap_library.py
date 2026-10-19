from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import bootstrap_library as bootstrap
import card_storage as storage
from snapshot_metadata import build as snapshot
from test_card_library import fixture_card, fixture_view


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.snapshot = self.root / "raw", self.root / "snapshot"
        self.source.mkdir()
        (self.source / "display-zh-hans").mkdir()
        self.library = self.root / "library"

    def prepare(self, cards=None, views=None):
        cards = cards if cards is not None else [fixture_card()]
        views = views if views is not None else [fixture_view()]
        storage.atomic_json(self.source / "audit.json", {
            "archive_release": "2026.10.18", "archive_sha256": "a" * 64,
        })
        storage.atomic_json(self.source / "display-zh-hans/audit.json", {})
        for name, rows in (("cards.jsonl", cards), ("display-zh-hans/cards.jsonl", views)):
            (self.source / name).write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8",
            )
        with redirect_stdout(io.StringIO()):
            snapshot(self.source, self.snapshot)

    def run_bootstrap(self, **kwargs):
        with redirect_stdout(io.StringIO()):
            return bootstrap.bootstrap(self.snapshot, self.library, **kwargs)

    def test_fresh_machine_needs_only_the_committed_snapshots(self):
        self.prepare()
        with patch("sqlite3.connect", side_effect=AssertionError("SQLite input not allowed")), \
                patch("urllib.request.urlopen", side_effect=AssertionError("network")):
            report = self.run_bootstrap()
        path = self.library / "zh-Hans/151C/001_151/metadata.json"
        metadata = json.loads(path.read_text())
        self.assertEqual(metadata["number"], "001/151")
        self.assertEqual(metadata["metadata_language"], "zh-Hans")
        self.assertEqual(metadata["images"], [])
        self.assertFalse(list(self.library.rglob("*.png")))
        self.assertEqual(report["counts"]["printings"], 1)
        self.assertEqual(report["counts"]["image_files"], 0)

    def test_cli_works_without_site_packages(self):
        self.prepare()
        result = subprocess.run([
            sys.executable, "-S", str(Path(bootstrap.__file__).resolve()),
            "--snapshot", str(self.snapshot), "--library", str(self.library),
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.library / "zh-Hans/151C/001_151/metadata.json").is_file())

    def test_dry_run_does_not_create_the_output(self):
        self.prepare()
        report = self.run_bootstrap(dry_run=True)
        self.assertEqual(report["printings"], 1)
        self.assertFalse(self.library.exists())

    def test_repeat_preserves_text_corrections_and_downloaded_images(self):
        self.prepare()
        self.run_bootstrap()
        folder = self.library / "zh-Hans/151C/001_151"
        path = folder / "metadata.json"
        metadata = json.loads(path.read_text())
        metadata["name"] = "家长已校对的名称"
        metadata["human_reviewed"] = True
        image = folder / "image.png"
        image.write_bytes(b"previously verified test image")
        metadata["images"] = [{"file": "image.png", "sha256": storage.digest(image)}]
        metadata["primary_image"] = "image.png"
        storage.atomic_json(path, metadata)
        before = path.read_bytes()
        report = self.run_bootstrap()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(report["counts"]["image_files"], 1)
        self.assertEqual(report["counts"].get("metadata_files_written", 0), 0)
        row = json.loads((self.library / "index.jsonl").read_text())
        self.assertEqual(row["image_files"], ["image.png"])

    def test_a_different_snapshot_or_existing_identity_is_not_overwritten(self):
        self.prepare()
        self.run_bootstrap()
        path = self.library / "zh-Hans/151C/001_151/metadata.json"
        for changed in (
            {"archive_release": "another-release"},
            {"source_pages": [{"page_id": 1, "revision_id": 999}]},
            {"number": "001/999"},
        ):
            with self.subTest(changed=changed):
                metadata = json.loads(path.read_text())
                original = path.read_bytes()
                storage.atomic_json(path, {**metadata, **changed})
                before = path.read_bytes()
                with self.assertRaises(ValueError):
                    self.run_bootstrap()
                self.assertEqual(path.read_bytes(), before)
                path.write_bytes(original)

    def test_recorded_basic_energy_identity_is_not_mistaken_for_local_image_bytes(self):
        card, view = fixture_card(), fixture_view()
        card["printings"] = []
        view["image"] = {
            "image_language": "zh-Hans", "wiki_filename": "CSVL2C137.png", "sha256": "b" * 64,
            "printings": [{
                "language": "zh-Hans", "set_code": "CSVL2C", "number": "137/052",
                "derived_from_image": True, "verification": "recorded_independent_identity_reads",
            }],
        }
        self.prepare([card], [view])
        report = self.run_bootstrap()
        path = self.library / "zh-Hans/CSVL2C/137_052/metadata.json"
        metadata = json.loads(path.read_text())
        self.assertEqual(metadata["images"], [])
        self.assertEqual(report["counts"]["image_files"], 0)
        self.assertIn("identity_completed_from_verified_image_evidence", metadata["review_flags"])

    def test_pocket_and_conflicting_or_incomplete_identities_stay_out_of_normal_folders(self):
        card = fixture_card(3, number="002/151")
        pocket = fixture_card(4, number="004/151")
        pocket["games"] = ["pocket"]
        unknown = fixture_card(5, number="未知")
        cards = [fixture_card(), fixture_card(2), card, pocket, unknown]
        views = [fixture_view(page_id) for page_id in (1, 2, 3, 5)]
        self.prepare(cards, views)
        report = self.run_bootstrap()
        self.assertEqual(report["counts"]["printings"], 1)
        self.assertEqual(report["counts"]["identity_collisions"], 1)
        self.assertEqual(report["unidentified_printing_rows"], 1)
        self.assertTrue((self.library / "zh-Hans/151C/002_151/metadata.json").exists())
        self.assertFalse((self.library / "zh-Hans/151C/001_151/metadata.json").exists())
        self.assertFalse((self.library / "zh-Hans/151C/004_151/metadata.json").exists())

    def test_corrupt_snapshot_fails_before_creating_folders(self):
        self.prepare()
        path = self.snapshot / "cards.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"tampered")
        with self.assertRaises(ValueError):
            self.run_bootstrap()
        self.assertFalse(self.library.exists())

    def test_language_filter_does_not_turn_image_language_into_metadata_language(self):
        cards = [fixture_card(), fixture_card(2, language="zh-Hant", number="002/151")]
        self.prepare(cards, [fixture_view(), fixture_view(2)])
        report = self.run_bootstrap(languages=["zh-Hant"])
        self.assertEqual(report["counts"]["printings"], 1)
        metadata = json.loads((self.library / "zh-Hant/151C/002_151/metadata.json").read_text())
        self.assertEqual(metadata["metadata_language"], "zh-Hans")
        self.assertFalse((self.library / "zh-Hans").exists())

    def test_rebuilding_keeps_prior_review_evidence_and_collision_registry(self):
        self.prepare()
        self.run_bootstrap()
        review = self.library / "_review"
        old_key = "zh-hant/old/001_151"
        storage.atomic_json(review / "collision-keys.json", [old_key])
        rows = {
            "assets.jsonl": {"filename": "Unresolved.png", "reasons": ["needs_manual_review"]},
            "printings.jsonl": {"reason": "previous_review", "wiki_id": "52poke:999"},
            "collisions.jsonl": {"path_key": old_key, "assets": [{"sha256": "b" * 64}]},
        }
        for name, row in rows.items():
            (review / name).write_text(json.dumps(row) + "\n", encoding="utf-8")
        self.run_bootstrap(languages=["zh-Hans"])
        self.run_bootstrap(languages=["zh-Hans"])
        self.assertIn(old_key, json.loads((review / "collision-keys.json").read_text()))
        for name, row in rows.items():
            data = [json.loads(line) for line in (review / name).read_text().splitlines()]
            self.assertIn(row, data)
            self.assertEqual(data.count(row), 1)


if __name__ == "__main__":
    unittest.main()
