import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
import zipfile

import build_portable_bundle as bundle


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("sources/current-access", "images-zh-hans", "tests"):
            (self.root / name).mkdir(parents=True)
        for name in ("PORTABLE_DOWNLOAD_README.md", "portable_downloader.py",
                     "tests/test_portable_downloader.py",
                     "sources/current-access/wiki-robots-recheck.txt",
                     "sources/神奇宝贝百科_机器读取守则.wikitext"):
            (self.root / name).write_text("fixture", encoding="utf-8")
        (self.root / ".env").write_text("SECRET=do-not-package-this-secret")
        (self.root / "data/local-research").mkdir(parents=True)
        (self.root / "data/local-research/private.json").write_text('{"secret":"restricted"}')
        self.target = {
            "wiki_filename": "Sample.png", "wiki_file_page_id": 1, "wiki_file_revision_id": 2,
            "uses": [{"title": "测试卡", "number": "1/2", "language": "zh-Hans"}],
            "declared_source_urls": [], "latest_file_metadata": None,
            "local_research_print_equivalent_only": True,
        }
        self.report = {"generated_at_utc": "2026-10-19T00:00:00Z", "targets": [self.target]}
        (self.root / "sources/current-access/remaining-simplified-targets.json").write_text(json.dumps(self.report))
        self.queue = sqlite3.connect(self.root / "images-zh-hans/queue.sqlite")
        self.queue.execute("CREATE TABLE jobs(filename TEXT,active INT,status TEXT)")
        self.queue.execute("INSERT INTO jobs VALUES ('Sample.png',1,'unresolved')")
        self.queue.commit()
        self.addCleanup(self.queue.close)

    def test_archive_allowlist_checksums_and_pending_scope(self):
        with patch.object(bundle, "ROOT", self.root), redirect_stdout(io.StringIO()):
            path = bundle.build(self.root / "out")
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            self.assertTrue(all(name.startswith("52poke-image-downloader/") for name in names))
            data = b"".join(archive.read(name) for name in names)
            self.assertNotIn(b"do-not-package-this-secret", data)
            self.assertNotIn(b"local_research_print_equivalent_only", data)
            self.assertFalse(any(".env" in name or "private" in name for name in names))
            checksum = archive.read("52poke-image-downloader/SHA256SUMS.txt").decode()
            for line in checksum.splitlines():
                digest, name = line.split("  ", 1)
                self.assertEqual(digest, hashlib.sha256(archive.read("52poke-image-downloader/" + name)).hexdigest())
            summary = json.loads(archive.read("52poke-image-downloader/bundle-summary.json"))
            self.assertEqual(summary["target_references"], 1)
            self.assertEqual(summary["without_original_image_url"], 1)
        self.assertEqual(path.with_suffix(".zip.sha256").read_text().split()[0],
                         hashlib.sha256(path.read_bytes()).hexdigest())

    def test_stale_report_is_rejected_instead_of_silently_packaging(self):
        self.queue.execute("UPDATE jobs SET status='done'")
        self.queue.commit()
        with patch.object(bundle, "ROOT", self.root):
            with self.assertRaisesRegex(ValueError, "stale"):
                bundle.build(self.root / "out")

    def test_fresh_clone_builds_from_public_frozen_manifest(self):
        self.queue.close()
        (self.root / "images-zh-hans/queue.sqlite").unlink()
        (self.root / "sources/current-access/remaining-simplified-targets.json").unlink()
        (self.root / "manifests").mkdir()
        frozen = {"schema_version": 1, "source_report_generated_at_utc": "2026-10-19T00:00:00Z",
                  "targets": [{**self.target, "semantic_identity_review_required": True}]}
        (self.root / "manifests/remaining-images.json").write_text(json.dumps(frozen))
        with patch.object(bundle, "ROOT", self.root), redirect_stdout(io.StringIO()):
            path = bundle.build(self.root / "out")
        with zipfile.ZipFile(path) as archive:
            data = json.loads(archive.read("52poke-image-downloader/manifests/remaining-images.json"))
            self.assertTrue(data["targets"][0]["semantic_identity_review_required"])


if __name__ == "__main__":
    unittest.main()
