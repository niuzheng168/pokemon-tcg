import base64
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import bootstrap_library as bootstrap
from card_library import build_groups, make_metadata
import card_storage as storage
from snapshot_metadata import build as snapshot
from test_card_library import fixture_card, fixture_view


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII="
)


class SampleImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / "library"
        self.frozen = self.root / "snapshots/2026.10.18"
        self.manifest_path = self.root / "samples/manifest.json"
        self.prepare()

    def prepare(self, collision=False):
        cards = [fixture_card(), fixture_card(2, language="zh-Hant", number="002/151")]
        if collision:
            cards.append(fixture_card(3))
        views = [fixture_view(c["page_id"]) for c in cards]
        raw = self.root / "raw"
        storage.atomic_json(raw / "audit.json", {
            "archive_release": "2026.10.18", "archive_sha256": "a" * 64,
        })
        storage.atomic_json(raw / "display-zh-hans/audit.json", {})
        for path, rows in (("cards.jsonl", cards), ("display-zh-hans/cards.jsonl", views)):
            (raw / path).write_text("".join(json.dumps(c) + "\n" for c in rows), encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            snapshot(raw, self.frozen)
        # Pin the samples to the two original pages, not the optional conflict.
        cards = {c["page_id"]: c for c in cards[:2]}
        views = {v["page_id"]: v for v in views[:2]}
        groups, _, _ = build_groups(cards, views, [], None)
        samples = []
        for group in groups.values():
            metadata = make_metadata(group, cards, views)
            relative = Path("images") / storage.relative_directory(metadata) / "image.png"
            image = self.manifest_path.parent / relative
            image.parent.mkdir(parents=True, exist_ok=True)
            image.write_bytes(PNG)
            samples.append({
                **{k: metadata[k] for k in ("id", "game", "printing_language", "set_id", "number", "number_slug")},
                "name_zh_hans": metadata["name"], "source_pages": metadata["source_pages"],
                "file": relative.as_posix(), "sha256": storage.digest(image),
                "bytes": len(PNG), "width": 1, "height": 1,
                "source_url": "https://example.org/public-image.png",
                "source_page_url": "https://example.org/public-card",
                "recorded_matching_evidence": {},
            })
        storage.atomic_json(self.manifest_path, {
            "schema_version": 1, "archive_release": "2026.10.18", "archive_sha256": "a" * 64,
            "samples": samples, "sample_count": len(samples), "total_bytes": len(PNG) * len(samples),
        })

    def manifest(self):
        return json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def run_bootstrap(self, **kwargs):
        kwargs.setdefault("samples", self.manifest_path)
        with redirect_stdout(io.StringIO()):
            return bootstrap.bootstrap(self.frozen, self.library, **kwargs)

    def test_build_seeds_exact_images_offline_with_simplified_metadata_and_index(self):
        with patch("sqlite3.connect", side_effect=AssertionError("database")), \
                patch("urllib.request.urlopen", side_effect=AssertionError("network")):
            report = self.run_bootstrap()
        self.assertEqual(report["counts"]["sample_images_added"], 2)
        self.assertEqual(report["counts"]["image_files"], 2)
        self.assertEqual(report["network_requests"], 0)
        rows = [json.loads(line) for line in (self.library / "index.jsonl").read_text().splitlines()]
        for row in rows:
            self.assertEqual(row["image_files"], ["image.png"])
            path = self.library / row["metadata_file"]
            metadata = json.loads(path.read_text())
            self.assertEqual(metadata["metadata_language"], "zh-Hans")
            self.assertEqual((path.parent / "image.png").read_bytes(), PNG)
            self.assertEqual(metadata["images"][0]["printing_language"], row["printing_language"])
            self.assertFalse(metadata["images"][0]["verification"]["human_reviewed"])

    def test_repeat_preserves_stronger_evidence_parent_corrections_and_primary_image(self):
        self.run_bootstrap()
        path = self.library / "zh-Hans/151C/001_151/metadata.json"
        metadata = json.loads(path.read_text())
        metadata["name"] = "家长校对的名称"
        metadata["human_reviewed"] = True
        metadata["images"][0]["verification"] = {"human_reviewed": True, "note": "stronger evidence"}
        metadata["images"][0]["source_cache_file"] = "keep this original provenance"
        storage.atomic_json(path, metadata)
        before = path.read_bytes()
        report = self.run_bootstrap()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(report["counts"]["sample_images_reused"], 2)
        self.assertEqual(report["counts"].get("metadata_files_written", 0), 0)
        self.assertEqual(len(list(self.library.rglob("*.png"))), 2)

    def test_different_existing_image_is_kept_as_primary_and_sample_added_as_variant(self):
        self.run_bootstrap(samples=None)
        path = self.library / "zh-Hans/151C/001_151/metadata.json"
        metadata = json.loads(path.read_text())
        primary = path.parent / "image.png"
        primary.write_bytes(b"existing separately verified image")
        metadata["images"] = [{"file": "image.png", "sha256": storage.digest(primary)}]
        metadata["primary_image"] = "image.png"
        storage.atomic_json(path, metadata)
        self.run_bootstrap()
        updated = json.loads(path.read_text())
        self.assertEqual(primary.read_bytes(), b"existing separately verified image")
        self.assertEqual(updated["primary_image"], "image.png")
        self.assertEqual(len(updated["images"]), 2)
        variant = updated["images"][1]
        self.assertTrue(variant["file"].startswith("images/"))
        self.assertEqual((path.parent / variant["file"]).read_bytes(), PNG)
        before = path.read_bytes()
        self.run_bootstrap()
        self.assertEqual(path.read_bytes(), before)

    def test_dry_run_checks_samples_without_creating_output(self):
        report = self.run_bootstrap(dry_run=True)
        self.assertEqual(report["bundled_samples"]["selected"], 2)
        self.assertFalse(self.library.exists())

    def test_language_filter_seeds_only_requested_printing_language(self):
        report = self.run_bootstrap(languages=["zh-Hant"])
        self.assertEqual(report["bundled_samples"]["selected"], 1)
        self.assertEqual(report["counts"]["image_files"], 1)
        self.assertTrue((self.library / "zh-Hant/151C/002_151/image.png").is_file())
        self.assertFalse((self.library / "zh-Hans").exists())

    def test_missing_and_corrupt_samples_fail_even_in_dry_run_before_writes(self):
        path = self.manifest_path.parent / self.manifest()["samples"][-1]["file"]
        for data in (b"corrupted", None):
            with self.subTest(data=data):
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(data)
                with self.assertRaises(ValueError):
                    self.run_bootstrap(dry_run=True)
                self.assertFalse(self.library.exists())

    def test_wrong_archive_revision_identity_and_dimensions_fail_closed(self):
        original = self.manifest()
        for field in ("archive_sha256", "revision", "identity", "dimensions", "duplicate"):
            with self.subTest(field=field):
                manifest = json.loads(json.dumps(original))
                sample = manifest["samples"][0]
                if field == "archive_sha256":
                    manifest[field] = "b" * 64
                elif field == "revision":
                    sample["source_pages"][0]["revision_id"] = 99
                elif field == "identity":
                    sample["number"] = "099/151"
                elif field == "dimensions":
                    sample["width"] = 99
                else:
                    manifest["samples"][1] = sample
                storage.atomic_json(self.manifest_path, manifest)
                with self.assertRaises(ValueError):
                    self.run_bootstrap()
                self.assertFalse(self.library.exists())

    def test_traversal_and_external_or_internal_symlinks_are_rejected(self):
        original = self.manifest()
        manifest = self.manifest()
        manifest["samples"][0]["file"] = "../outside.png"
        storage.atomic_json(self.manifest_path, manifest)
        with self.assertRaises(ValueError):
            self.run_bootstrap()
        storage.atomic_json(self.manifest_path, original)
        source = self.manifest_path.parent / original["samples"][0]["file"]
        source.unlink()
        for target in (self.root / "outside.png", self.manifest_path.parent / "other.png"):
            with self.subTest(target=target):
                target.write_bytes(PNG)
                source.symlink_to(target)
                with self.assertRaises(ValueError):
                    self.run_bootstrap()
                source.unlink()
                self.assertFalse(self.library.exists())

    def test_cross_page_collision_cannot_be_published_as_a_sample(self):
        self.prepare(collision=True)
        with self.assertRaises(ValueError):
            self.run_bootstrap()
        self.assertFalse(self.library.exists())

    def test_corrupt_existing_image_is_not_replaced_by_repository_sample(self):
        self.run_bootstrap()
        image = self.library / "zh-Hans/151C/001_151/image.png"
        image.write_bytes(b"damaged existing image")
        with self.assertRaises(ValueError):
            self.run_bootstrap()
        self.assertEqual(image.read_bytes(), b"damaged existing image")

    def test_isolated_default_cli_works_without_site_packages_or_workspace_imports(self):
        tool = self.root / "isolated-tool"
        tool.mkdir()
        for name in ("bootstrap_library.py", "card_library.py", "card_storage.py",
                     "sample_images.py", "snapshot_metadata.py"):
            shutil.copyfile(Path(bootstrap.__file__).parent / name, tool / name)
        shutil.copytree(self.frozen, tool / "snapshots/2026.10.18")
        shutil.copytree(self.manifest_path.parent, tool / "samples")
        env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
        command = [sys.executable, "-S", str(tool / "bootstrap_library.py")]
        for run in range(2):
            result = subprocess.run(command, cwd=tool, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout.split("(offline).\n")[-1])
            self.assertEqual(report["counts"]["image_files"], 2)
            self.assertEqual(report["counts"].get("metadata_files_written", 0), 2 if run == 0 else 0)

    def test_bundled_manifest_has_exactly_ten_decodable_images_and_no_machine_paths(self):
        manifest = json.loads(bootstrap.DEFAULT_SAMPLES.read_text(encoding="utf-8"))
        self.assertEqual(manifest["sample_count"], 10)
        self.assertEqual(manifest["total_bytes"], 2247500)
        for sample in manifest["samples"]:
            path = bootstrap.DEFAULT_SAMPLES.parent / sample["file"]
            self.assertEqual(storage.digest(path), sample["sha256"])
            with Image.open(path) as picture:
                self.assertEqual(picture.size, (sample["width"], sample["height"]))
                picture.verify()
        text = bootstrap.DEFAULT_SAMPLES.read_text(encoding="utf-8")
        for private in ("/nas/", "/home/", "auth_key=", "source_cache_file", "local-research"):
            self.assertNotIn(private, text)


if __name__ == "__main__":
    unittest.main()
