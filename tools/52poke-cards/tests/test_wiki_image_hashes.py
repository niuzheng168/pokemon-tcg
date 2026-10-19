import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wiki_image_hashes as mod
from collect_official_candidates import initialize
from download_images import connect, dump_json


class WikiHashTests(unittest.TestCase):
    def fixture(self, root, **info_changes):
        source = initialize(root / "official-candidates")
        image_path = root / "public-card.png"
        image = io.BytesIO()
        Image.new("RGB", (71, 100), (80, 140, 200)).save(image, "PNG")
        image_path.write_bytes(image.getvalue())
        payload = image.getvalue()
        asset = {"sha256": hashlib.sha256(payload).hexdigest(), "local_file": str(image_path),
                 "bytes": len(payload), "width": 71, "height": 100,
                 "official_image_url": "https://image.pokemon.com.cn/public-card.png"}
        source.execute("INSERT INTO photos(url,page_url,record) VALUES (?,?,?)",
                       (asset["official_image_url"], "https://www.pokemon.cn/tcg/test.html", json.dumps(asset)))
        source.commit()
        source.close()
        queue = connect(root / "images-zh-hans")
        use = {"language": "zh-Hans", "page_id": 10, "title": "示例卡", "number": "001/100", "set_code": "CSV1C"}
        queue.execute("""INSERT INTO jobs(filename,file_page_id,file_revision_id,uses_json,status)
                         VALUES ('CSV1C001.png',1,2,?,'unresolved')""", (json.dumps([use]),))
        queue.commit()
        queue.close()
        directory = root / "sources/wiki-file-metadata"
        directory.mkdir(parents=True)
        info = {"sha1": hashlib.sha1(payload).hexdigest(), "size": len(payload), "width": 71, "height": 100,
                "url": "https://media.52poke.com/wiki/a/a1/CSV1C001.png", **info_changes}
        data = {"query": {"pages": [{"ns": 6, "pageid": 1, "title": "File:CSV1C001.png", "imageinfo": [info]}]}}
        dump_json(directory / "batch.json", data)
        dump_json(directory / "state.json", {"last_finished": 0, "streams": {},
                   "batches": [{"file": "batch.json", "at": 1, "source": "https://wiki.52poke.com/api.php"}]})
        return directory, image_path

    def run_binding(self, root, directory):
        with patch.object(mod, "ROOT", root), patch.object(mod, "DIRECTORY", directory), \
                patch.object(mod, "STATE", directory / "state.json"):
            mod.bind()

    def test_exact_wiki_hash_and_size_bind_without_ocr_or_cdn_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, _ = self.fixture(root)
            self.run_binding(root, directory)
            queue = connect(root / "images-zh-hans")
            self.assertEqual(queue.execute("SELECT status FROM jobs").fetchone()[0], "done")
            evidence = json.loads(queue.execute("SELECT evidence FROM file_verifications").fetchone()[0])
            self.assertTrue(evidence["byte_identical_to_wiki_copy"])
            self.assertEqual(evidence["content_hash_verification"]["page_id"], 1)
            queue.close()
            source = sqlite3.connect(root / "official-candidates/candidates.sqlite")
            self.assertIsNone(source.execute("SELECT ocr FROM photos").fetchone()[0])
            source.close()

    def test_wrong_hash_or_size_does_not_bind(self):
        for change in ({"sha1": "0" * 40}, {"size": 9999999}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                directory, _ = self.fixture(root, **change)
                self.run_binding(root, directory)
                queue = connect(root / "images-zh-hans")
                self.assertEqual(queue.execute("SELECT status FROM jobs").fetchone()[0], "unresolved")
                queue.close()

    def test_recovered_reference_still_requires_semantic_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, _ = self.fixture(root)
            queue = connect(root / "images-zh-hans")
            queue.execute("UPDATE jobs SET uses_json=?", (json.dumps([{
                "language": "zh-Hans", "language_is_requested_target_not_image_verification": True}]),))
            queue.commit()
            queue.close()
            self.run_binding(root, directory)
            queue = connect(root / "images-zh-hans")
            self.assertEqual(queue.execute("SELECT status FROM jobs").fetchone()[0], "unresolved")
            queue.close()

    def test_recovered_reference_accepts_only_hash_plus_complete_independent_identity_reads(self):
        use = {"language": "zh-Hans", "recovered_existing_File_for_printing": True,
               "set_code": "CSV1C", "number": "001/100", "title": "示例卡（TCG）", "template_index": 4}
        reading = {"name": "示例卡", "set_code": "CSV1C", "number": "001/100", "hp": 60,
                   "language": "zh-Hans", "confidence": 1}
        photo = {"ocr": json.dumps({"reading": reading}), "second_ocr": json.dumps({"reading": reading})}
        self.assertIsNotNone(mod.verified_recovered_identity([use], photo))
        self.assertIsNone(mod.verified_recovered_identity([use, use], photo))
        for change in ({"name": "另一只"}, {"set_code": "CSV2C"}, {"number": "002/100"},
                       {"language": "zh-Hant"}, {"confidence": .95}):
            wrong = {**photo, "second_ocr": json.dumps({"reading": {**reading, **change}})}
            self.assertIsNone(mod.verified_recovered_identity([use], wrong))

    def test_recovered_binding_requires_both_live_byte_match_and_semantic_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, _ = self.fixture(root)
            use = {"language": "zh-Hans", "language_is_requested_target_not_image_verification": True,
                   "recovered_existing_File_for_printing": True, "set_code": "CSV1C",
                   "number": "001/100", "title": "示例卡（TCG）", "page_id": 10, "template_index": 4}
            queue = connect(root / "images-zh-hans")
            queue.execute("UPDATE jobs SET uses_json=?", (json.dumps([use]),))
            queue.commit()
            queue.close()
            reading = {"name": "示例卡", "set_code": "CSV1C", "number": "001/100",
                       "hp": 60, "language": "zh-Hans", "confidence": 1}
            source = sqlite3.connect(root / "official-candidates/candidates.sqlite")
            source.execute("UPDATE photos SET ocr=?,second_ocr=?", (json.dumps({"reading": reading}), json.dumps({"reading": reading})))
            source.commit()
            source.close()
            self.run_binding(root, directory)
            queue = connect(root / "images-zh-hans")
            self.assertEqual(queue.execute("SELECT status FROM jobs").fetchone()[0], "done")
            evidence = json.loads(queue.execute("SELECT evidence FROM file_verifications").fetchone()[0])
            self.assertTrue(evidence["recovered_existing_File_for_printing"])
            self.assertTrue(evidence["byte_identical_to_wiki_copy"])
            queue.close()

    def test_changed_cache_bytes_are_not_associated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, image = self.fixture(root)
            image.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                self.run_binding(root, directory)

    def test_tampered_digest_index_cannot_create_a_false_exact_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, image = self.fixture(root, sha1="0" * 40)
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            dump_json(directory / "local-content-index.json", {digest: {
                "sha1": "0" * 40, "local_file": str(image), "size": image.stat().st_size,
                "mtime_ns": image.stat().st_mtime_ns}})
            with self.assertRaises(ValueError):
                self.run_binding(root, directory)

    def test_recreated_file_page_id_is_not_the_archived_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, _ = self.fixture(root)
            data = json.loads((directory / "batch.json").read_text())
            data["query"]["pages"][0]["pageid"] = 999
            dump_json(directory / "batch.json", data)
            self.run_binding(root, directory)
            queue = connect(root / "images-zh-hans")
            self.assertEqual(queue.execute("SELECT status FROM jobs").fetchone()[0], "unresolved")
            queue.close()

    def test_api_access_block_is_persisted_without_retry_or_identity_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, _ = self.fixture(root)
            robots = root / "sources/current-access/wiki-robots-recheck.txt"
            robots.parent.mkdir(parents=True)
            robots.write_text("User-agent: *\nCrawl-delay: 500\n")
            with patch.object(mod, "ROOT", root), patch.object(mod, "DIRECTORY", directory), \
                    patch.object(mod, "STATE", directory / "state.json"), patch.object(mod, "off_peak", return_value=True), \
                    patch.object(mod.urllib.request, "build_opener") as opener:
                opener.return_value.open.side_effect = urllib.error.HTTPError(
                    "https://wiki.52poke.com/api.php", 403, "blocked", {}, None)
                with self.assertRaises(urllib.error.HTTPError):
                    mod.fetch("CS", 1)
                with self.assertRaises(ValueError):
                    mod.fetch("CS", 1)
                self.assertEqual(opener.return_value.open.call_count, 1)
                self.assertIn("HTTP 403", json.loads((directory / "state.json").read_text())["blocked"])


if __name__ == "__main__":
    unittest.main()
