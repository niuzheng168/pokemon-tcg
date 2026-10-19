import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
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
        for name in ("PORTABLE_DOWNLOAD_README.md", "OFFICIAL_DOWNLOADS.md",
                     "portable_downloader.py", "official_downloader.py", "card_storage.py",
                     "tests/test_portable_downloader.py", "tests/test_official_downloader.py",
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
            self.assertEqual(summary["source_policies"]["official"]["language"], "zh-Hans")
            self.assertFalse(summary["source_policies"]["official"]["robots_check"])
            self.assertTrue(summary["source_policies"]["52poke"]["robots_check"])
            self.assertIn("52poke-image-downloader/official_downloader.py", names)
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

    def test_real_bundle_runs_in_isolation_with_no_workspace_imports_or_network(self):
        self.queue.close()
        (self.root / "images-zh-hans/queue.sqlite").unlink()
        (self.root / "sources/current-access/remaining-simplified-targets.json").unlink()
        for name in (
            "portable_downloader.py", "official_downloader.py", "card_storage.py",
            "tests/test_portable_downloader.py", "tests/test_official_downloader.py",
        ):
            shutil.copyfile(bundle.ROOT / name, self.root / name)
        (self.root / "manifests").mkdir()
        frozen = {
            "schema_version": 1, "source_report_generated_at_utc": "2026-10-19T00:00:00Z",
            "targets": [{**self.target, "declared_source_urls": ["https://www.pokemon.cn/tcg/example.html"]}],
        }
        (self.root / "manifests/remaining-images.json").write_text(json.dumps(frozen), encoding="utf-8")
        with patch.object(bundle, "ROOT", self.root), redirect_stdout(io.StringIO()):
            path = bundle.build(self.root / "out")
        extracted = self.root / "standalone"
        with zipfile.ZipFile(path) as archive:
            archive.extractall(extracted)
        tool = extracted / "52poke-image-downloader"
        env = {key: value for key, value in os.environ.items() if key not in {"PYTHONPATH", "PYTHONHOME"}}
        for command in ("plan", "status"):
            result = subprocess.run([
                sys.executable, "-S", "portable_downloader.py", "--source", "official", command,
            ], cwd=tool, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["declared_official_pages"], 1)
        self.assertFalse((tool / "downloads-official").exists())
        code = """
import pathlib, sys, unittest
attempts = []
def offline(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
        attempts.append(event)
        raise AssertionError("Standalone bundle must remain offline")
sys.addaudithook(offline)
import portable_downloader, official_downloader, card_storage
assert all(pathlib.Path(module.__file__).resolve().parent == pathlib.Path.cwd()
           for module in (portable_downloader, official_downloader, card_storage))
result = unittest.TextTestRunner().run(unittest.defaultTestLoader.discover("tests"))
assert not attempts, attempts
raise SystemExit(not result.wasSuccessful())
"""
        result = subprocess.run([sys.executable, "-c", code], cwd=tool, env=env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK", result.stderr)


if __name__ == "__main__":
    unittest.main()
