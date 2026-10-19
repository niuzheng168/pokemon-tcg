from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from PIL import Image

import bootstrap_library as bootstrap
import card_storage as storage
import portable_downloader as downloader
import official_downloader as official
from snapshot_metadata import build as snapshot
from test_card_library import fixture_card, fixture_view


class FreshCloneWorkflowTests(unittest.TestCase):
    def test_official_download_merges_into_bootstrap_and_preserves_human_review(self):
        with tempfile.TemporaryDirectory() as folder, redirect_stdout(io.StringIO()):
            root = Path(folder)
            raw, frozen, library, output = (root / name for name in ("raw", "snapshot", "library", "official"))
            (raw / "display-zh-hans").mkdir(parents=True)
            storage.atomic_json(raw / "audit.json", {
                "archive_release": "2026.10.18", "archive_sha256": "a" * 64,
            })
            storage.atomic_json(raw / "display-zh-hans/audit.json", {})
            (raw / "cards.jsonl").write_text(json.dumps(fixture_card()) + "\n", encoding="utf-8")
            (raw / "display-zh-hans/cards.jsonl").write_text(json.dumps(fixture_view()) + "\n", encoding="utf-8")
            snapshot(raw, frozen)
            bootstrap.bootstrap(frozen, library, languages=["zh-Hans"], samples=None)
            metadata_path = library / "zh-Hans/151C/001_151/metadata.json"
            original = json.loads(metadata_path.read_text(encoding="utf-8"))
            stream = io.BytesIO()
            Image.new("RGB", (3, 4), "green").save(stream, format="PNG")
            picture = stream.getvalue()
            page, image = "https://www.pokemon.cn/tcg/test.html", "https://image.pokemon.com.cn/test.png"
            target = {
                "wiki_filename": "Example001.png",
                "uses": [{"page_id": 1, "language": "zh-Hans", "set_code": "151C", "number": "001/151"}],
                "declared_source_urls": [page], "semantic_identity_review_required": False,
                "latest_file_metadata": {
                    "sha1": hashlib.sha1(picture).hexdigest(), "size": len(picture), "width": 3, "height": 4,
                },
            }

            class Network:
                def check_stopped(self):
                    pass

                def fetch(self, url, kind):
                    return picture if kind == "image" else f'<article><img src="{image}"></article>'.encode()

            value = {"schema_version": 1, "targets": [target]}
            official.Runner(value, output, Network()).download(library=library)
            downloaded = json.loads(metadata_path.read_text(encoding="utf-8"))
            for key in original:
                if key != "images":
                    self.assertEqual(downloaded[key], original[key])
            self.assertEqual((metadata_path.parent / "image.png").read_bytes(), picture)
            downloaded["name"] = "人工校对名称"
            downloaded["images"][0]["verification"] = {"human_reviewed": True, "notes": "stronger evidence"}
            storage.atomic_json(metadata_path, downloaded)
            before = metadata_path.read_bytes()
            official.verify_receipts(value, output, library)
            self.assertEqual(metadata_path.read_bytes(), before)
            report = bootstrap.bootstrap(frozen, library, languages=["zh-Hans"], samples=None)
            self.assertEqual(report["counts"]["printings_with_images"], 1)
            self.assertEqual(metadata_path.read_bytes(), before)
            self.assertEqual(json.loads((library / "index.jsonl").read_text())["image_files"], ["image.png"])

    def test_metadata_bootstrap_manual_transfer_and_offline_import_preserve_information(self):
        with tempfile.TemporaryDirectory() as folder, redirect_stdout(io.StringIO()):
            root = Path(folder)
            raw, frozen = root / "raw", root / "snapshot"
            raw.mkdir()
            (raw / "display-zh-hans").mkdir()
            storage.atomic_json(raw / "audit.json", {
                "archive_release": "2026.10.18", "archive_sha256": "a" * 64,
            })
            storage.atomic_json(raw / "display-zh-hans/audit.json", {})
            (raw / "cards.jsonl").write_text(json.dumps(fixture_card()) + "\n", encoding="utf-8")
            (raw / "display-zh-hans/cards.jsonl").write_text(json.dumps(fixture_view()) + "\n", encoding="utf-8")
            snapshot(raw, frozen)
            master = root / "master-library"
            bootstrap.bootstrap(frozen, master, samples=None)
            metadata_path = master / "zh-Hans/151C/001_151/metadata.json"
            original = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(original["images"], [])

            stream = io.BytesIO()
            Image.new("RGB", (3, 4), "green").save(stream, format="PNG")
            picture = stream.getvalue()
            target = {
                "wiki_filename": "Example001.png", "wiki_file_page_id": 9, "wiki_file_revision_id": 10,
                "uses": [{"page_id": 1, "language": "zh-Hans", "set_code": "151C", "number": "001/151"}],
                "declared_source_urls": [], "semantic_identity_review_required": False,
                "latest_file_metadata": {
                    "url": "https://media.52poke.com/wiki/a/ab/Example001.png",
                    "sha1": hashlib.sha1(picture).hexdigest(), "size": len(picture), "width": 3, "height": 4,
                },
            }
            manifest = root / "manifest.json"
            storage.atomic_json(manifest, {"schema_version": 1, "targets": [target]})
            machine_a = root / "machine-a-downloads"
            downloaded = downloader.image_path(machine_a, target)
            downloaded.parent.mkdir(parents=True)
            downloaded.write_bytes(picture)
            transfer_zip = root / "machine-a-results.zip"
            with patch("urllib.request.build_opener", side_effect=AssertionError("network")):
                with patch("sys.argv", ["portable_downloader.py", "--manifest", str(manifest),
                                        "--output", str(machine_a), "pack-results", "--zip", str(transfer_zip)]):
                    downloader.main()
                incoming = root / "manually-extracted-results"
                with zipfile.ZipFile(transfer_zip) as archive:
                    archive.extractall(incoming)
                arguments = [
                    "portable_downloader.py", "--manifest", str(incoming / "manifest.json"),
                    "--output", str(incoming), "--library", str(master), "verify",
                ]
                with patch("sys.argv", arguments):
                    downloader.main()
                updated = json.loads(metadata_path.read_text(encoding="utf-8"))
                self.assertEqual((metadata_path.parent / "image.png").read_bytes(), picture)
                for key, value in original.items():
                    if key not in {"images", "primary_image"}:
                        self.assertEqual(updated[key], value, key)
                before_repeat = metadata_path.read_bytes()
                with patch("sys.argv", arguments):
                    downloader.main()
                self.assertEqual(metadata_path.read_bytes(), before_repeat)
            # Rebuild metadata after merging: do not lose images or replace
            # complete text; refresh the index that download workers don't own.
            report = bootstrap.bootstrap(frozen, master, samples=None)
            self.assertEqual(report["counts"]["printings_with_images"], 1)
            self.assertEqual(report["counts"]["image_files"], 1)
            self.assertEqual(metadata_path.read_bytes(), before_repeat)
            self.assertEqual(json.loads((master / "index.jsonl").read_text())["image_files"], ["image.png"])


if __name__ == "__main__":
    unittest.main()
