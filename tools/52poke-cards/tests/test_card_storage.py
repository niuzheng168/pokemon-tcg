import json
from pathlib import Path
import tempfile
import unittest

import card_storage as storage


class CardStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / "library"
        self.source = self.root / "source.png"
        self.source.write_bytes(b"verified-test-bytes")
        self.use = {"page_id": 1, "language": "zh-Hans", "set_code": "151C", "number": "001/151"}
        self.identity = storage.printing_identity(self.use)
        self.asset = {
            "local_file": str(self.source), "sha256": storage.digest(self.source),
            "image_language": "zh-Hans",
        }
        self.target = {"wiki_filename": "151C001.png", "uses": [self.use]}

    def test_number_paths_preserve_zeroes_prefixes_and_suffixes(self):
        for number, code, slug in (
            ("001/151", "151C", "001_151"), ("001/SV-P", "SV-P", "001_SV-P"),
            ("10 02/04", "CBB2C", "10_02_04"), ("106/103", "30thC", "106_103"),
            ("001", "Test", "001"), ("TG01/TG30", "Test", "TG01_TG30"),
            ("043/055", "CS1.5C", "043_055"),
        ):
            with self.subTest(number=number):
                identity = storage.printing_identity({**self.use, "set_code": code, "number": number})
                self.assertEqual(storage.relative_directory(identity).as_posix(), f"zh-Hans/{code}/{slug}")
                self.assertEqual(identity["number"], number)
                self.assertNotIn("/tcg/", "/" + storage.relative_directory(identity).as_posix())

    def test_unsafe_unknown_and_multilanguage_identities_are_rejected(self):
        for changed in (
            {"set_code": "../bad"}, {"set_code": "CON"}, {"set_code": "/absolute"},
            {"set_code": "CON.txt"}, {"set_code": "151C."}, {"set_code": "A..B"},
            {"number": "../../bad"}, {"number": "001/151/extra"}, {"number": "—"},
            {"number": "未知"}, {"number": "DPBP#123"}, {"number": None},
            {"language": "zh"}, {"language": "泰文、印尼文"}, {"game": "pocket"},
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                storage.printing_identity({**self.use, **changed})

    def test_promo_suffix_is_used_with_explicit_audit_flag(self):
        identity = storage.printing_identity({**self.use, "set_code": "S-P", "number": "064/SV-P"})
        self.assertEqual(identity["set_id"], "SV-P")
        self.assertIn("source_icon_and_printed_promo_suffix_disagree", identity["identity_flags"])
        self.assertEqual(storage.printing_identity({**self.use, "language": "韩文"})["printing_language"], "ko")

    def test_verified_download_is_published_and_second_run_is_idempotent(self):
        self.assertTrue(storage.publish_download(self.library, self.target, self.asset))
        folder = self.library / "zh-Hans/151C/001_151"
        before = (folder / "metadata.json").read_bytes()
        self.assertEqual((folder / "image.png").read_bytes(), self.source.read_bytes())
        self.assertTrue(storage.publish_download(self.library, self.target, self.asset))
        self.assertEqual((folder / "metadata.json").read_bytes(), before)
        metadata = json.loads(before)
        self.assertEqual(metadata["number"], "001/151")
        self.assertIsNone(metadata["metadata_language"])  # Not a false Simplified-text claim.
        self.assertEqual(len(metadata["images"]), 1)

    def test_different_images_of_same_printing_are_not_overwritten(self):
        storage.publish_download(self.library, self.target, self.asset)
        source = self.root / "other.png"
        source.write_bytes(b"another-resolution")
        other = {**self.asset, "local_file": str(source), "sha256": storage.digest(source)}
        storage.publish_download(self.library, self.target, other)
        folder = self.library / "zh-Hans/151C/001_151"
        self.assertEqual((folder / "image.png").read_bytes(), self.source.read_bytes())
        metadata = json.loads((folder / "metadata.json").read_text())
        self.assertEqual(len(metadata["images"]), 2)
        self.assertEqual((folder / metadata["images"][1]["file"]).read_bytes(), source.read_bytes())

    def test_bad_source_or_changed_library_image_is_never_silently_replaced(self):
        with self.assertRaises(ValueError):
            storage.publish_download(self.library, self.target, {**self.asset, "sha256": "0" * 64})
        storage.publish_download(self.library, self.target, self.asset)
        image = self.library / "zh-Hans/151C/001_151/image.png"
        image.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            storage.publish_download(self.library, self.target, self.asset)
        self.assertEqual(image.read_bytes(), b"changed")

    def test_ambiguous_semantic_and_language_bindings_only_enter_review(self):
        for changed in (
            {"uses": []},
            {"uses": [self.use, {**self.use, "page_id": 2}]},
            {"uses": [self.use, {**self.use, "number": "002/151"}]},
            {"semantic_identity_review_required": True},
            {"uses": [{**self.use, "language_is_requested_target_not_image_verification": True}]},
            {"uses": [{**self.use, "language": "zh-Hant"}]},
        ):
            with self.subTest(changed=changed):
                self.assertFalse(storage.publish_download(self.library, {**self.target, **changed}, self.asset))
        self.assertFalse(list(self.library.rglob("*.png")))
        self.assertTrue(list((self.library / "_review/downloads").glob("*.json")))

    def test_cross_page_collision_cannot_overwrite_or_bypass_sync_review(self):
        storage.publish_download(self.library, self.target, self.asset)
        other = {**self.target, "uses": [{**self.use, "page_id": 2}]}
        self.assertFalse(storage.publish_download(self.library, other, self.asset))
        storage.atomic_json(self.library / "_review/collision-keys.json", [storage.identity_key(self.identity)])
        self.assertFalse(storage.publish_download(self.library, self.target, self.asset))

    def test_symlink_escape_missing_nas_and_parallel_writer_are_rejected(self):
        self.library.mkdir()
        external = self.root / "outside"
        external.mkdir()
        (self.library / "zh-Hans").symlink_to(external)
        self.assertFalse(storage.publish_download(self.library, self.target, self.asset))
        self.assertFalse(list(external.iterdir()))
        with self.assertRaises(ValueError):
            storage.safe_path(self.library, Path("zh-Hans/151C/001_151/metadata.json"))
        broken = self.root / "broken-library"
        broken.symlink_to(self.root / "not-mounted")
        with self.assertRaises(FileNotFoundError):
            storage.safe_path(broken, Path("metadata.json"))
        self.assertTrue(broken.is_symlink())
        with storage.library_lock(self.library):
            with self.assertRaises(OSError):
                with storage.library_lock(self.library):
                    self.fail("second writer acquired the library")


if __name__ == "__main__":
    unittest.main()
