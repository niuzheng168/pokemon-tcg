from pathlib import Path
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch

import download_images as downloader
from import_cards import connect, export, export_target


class StoragePathTests(unittest.TestCase):
    def test_normal_exports_keep_their_requested_location(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "cards.jsonl"
            self.assertEqual(export_target(path), path)

    def test_atomic_export_updates_target_without_replacing_nas_link(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "nas" / "cards.jsonl"
            target.parent.mkdir()
            target.write_text("old", encoding="utf-8")
            alias = root / "cards.jsonl"
            alias.symlink_to(target)
            destination = export_target(alias)
            temporary = destination.with_name(destination.name + ".part")
            temporary.write_text("new", encoding="utf-8")
            temporary.replace(destination)
            self.assertTrue(alias.is_symlink())
            self.assertEqual(alias.read_text(), "new")
            self.assertEqual(target.read_text(), "new")
            self.assertFalse((root / "cards.jsonl.part").exists())

    def test_unavailable_nas_does_not_create_a_local_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            alias = Path(folder) / "cards.jsonl"
            alias.symlink_to(Path(folder) / "unmounted" / "cards.jsonl")
            with self.assertRaises(FileNotFoundError):
                export_target(alias)
            self.assertTrue(alias.is_symlink())

    def test_importer_export_uses_nas_target_for_atomic_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            local, nas = root / "local", root / "nas"
            local.mkdir()
            nas.mkdir()
            target = nas / "cards.jsonl"
            target.write_text("previous export", encoding="utf-8")
            alias = local / "cards.jsonl"
            alias.symlink_to(target)
            database = connect(local / "cards.sqlite")
            try:
                export(database, local, "2026.10.18")
            finally:
                database.close()
            self.assertTrue(alias.is_symlink())
            self.assertEqual(target.read_text(), "")
            self.assertFalse((local / "cards.jsonl.part").exists())
            self.assertTrue((local / "cards.sqlite").is_file())

    def exercise_sample(self, use_linked_cache):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            local, nas = root / "local", root / "nas"
            (local / "images").mkdir(parents=True)
            nas.mkdir()
            (local / "images/samples").symlink_to(nas, target_is_directory=True)
            target = nas / "sample.png" if use_linked_cache else root / "unrelated.png"
            target.write_bytes(b"previously verified public sample")
            sample = local / "images/samples/sample.png" if use_linked_cache else target
            record = {
                "local_file": str(sample), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "wiki_file_name": "Sample.png",
                "official_image_url": "https://asia.pokemon-card.com/tw/card-img/Sample.png",
                "official_page_url": "https://asia.pokemon-card.com/tw/card-search/detail/1/",
            }
            (local / "sources").mkdir()
            (local / "sources/image-fallback-success.json").write_text(json.dumps(record), encoding="utf-8")
            queue = downloader.connect(local / "queue")
            try:
                downloader.set_meta(queue, "plan", {"language": "zh-Hant"})
                queue.execute("INSERT INTO jobs(filename,uses_json,status,source_url) VALUES (?,?,'pending',?)",
                              ("Sample.png", "[]", record["official_page_url"]))
                with patch.object(downloader, "ROOT", local):
                    downloader.seed_verified_sample(queue)
                return queue.execute("SELECT status FROM jobs").fetchone()[0]
            finally:
                queue.close()

    def test_verified_sample_cache_can_be_linked_to_nas(self):
        self.assertEqual(self.exercise_sample(True), "done")

    def test_unrelated_external_file_is_not_a_trusted_sample(self):
        self.assertEqual(self.exercise_sample(False), "pending")


if __name__ == "__main__":
    unittest.main()
