from contextlib import redirect_stdout
import gzip
import io
import json
from pathlib import Path
import tempfile
import unittest

import snapshot_metadata as snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        (self.source / "display-zh-hans").mkdir(parents=True)
        audit = {"archive_release": "2026.10.18", "archive_sha256": "a" * 64}
        (self.source / "audit.json").write_text(json.dumps(audit), encoding="utf-8")
        (self.source / "display-zh-hans/audit.json").write_text(
            json.dumps({"counts": {"cards": 1}, "image_queues": ["/private/cache/queue.sqlite"]}), encoding="utf-8")
        self.raw = (
            json.dumps({"id": 1, "games": ["tcg"], "printings": [{"number": "1/2"}]}) + "\n"
            + json.dumps({"id": 2, "games": ["pocket"], "printings": []}) + "\n"
        ).encode()
        (self.source / "cards.jsonl").write_bytes(self.raw)
        display = {
            "id": 1, "display": {"name": "测试卡"},
            "image": {"local_file": "/private/card.png", "sha256": "b" * 64,
                      "derivation": {"parent_local_file": "/private/poster.png", "box": [0, 0, 3, 4]}},
        }
        (self.source / "display-zh-hans/cards.jsonl").write_text(json.dumps(display) + "\n", encoding="utf-8")

    def build(self, name="out"):
        with redirect_stdout(io.StringIO()):
            return snapshot.build(self.source, self.root / name)

    def test_raw_bytes_and_counts_survive_compression(self):
        manifest = self.build()
        self.assertEqual(gzip.decompress((self.root / "out/cards.jsonl.gz").read_bytes()), self.raw)
        raw = manifest["files"]["cards.jsonl.gz"]
        self.assertEqual(raw["records"], 2)
        self.assertEqual(raw["game_page_counts"], {"tcg": 1, "pocket": 1})
        self.assertEqual(raw["printing_rows"], 1)

    def test_local_paths_removed_but_card_text_provenance_and_hashes_retained(self):
        self.build()
        data = gzip.decompress((self.root / "out/display-zh-hans.jsonl.gz").read_bytes())
        row = json.loads(data)
        self.assertNotIn(b"/private/", data)
        self.assertEqual(row["display"]["name"], "测试卡")
        self.assertEqual(row["image"]["sha256"], "b" * 64)
        self.assertTrue(row["image"]["local_file_omitted_from_snapshot"])
        self.assertNotIn("image_queues", json.loads((self.root / "out/display-audit.json").read_text()))

    def test_deterministic_snapshot_and_full_verifier(self):
        first, second = self.build("one"), self.build("two")
        self.assertEqual(first, second)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(snapshot.verify(self.root / "one"), first)
        with (self.root / "one/cards.jsonl.gz").open("ab") as stream:
            stream.write(b"tamper")
        with self.assertRaisesRegex(ValueError, "differs"):
            snapshot.verify(self.root / "one")


if __name__ == "__main__":
    unittest.main()
