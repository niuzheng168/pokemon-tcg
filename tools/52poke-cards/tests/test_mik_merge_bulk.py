import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from mik_merge import bulk, common, stage
from mik_merge_fixtures import create_run_inputs, write


class BulkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source, self.snapshot, self.selection, self.observations = create_run_inputs(self.root)
        self.exports = self.root / "exports"
        self.run = self.exports / "fresh"
        p = patch.object(common, "EXPORTS", self.exports)
        p.start()
        self.addCleanup(p.stop)
        selected = common.load(self.selection)["samples"]
        rows = []
        for item in selected:
            key = item["mik_id"]
            mik = common.load(self.source / "cards" / key / "metadata.json")
            rows.append({"source_card": {"setCode": mik["setCode"], "cardIndex": mik["cardIndex"],
                                        "cardName": mik["name"], "cardType": mik["cardType"]},
                         "directory": "cards/" + key})
        self.index = self.source / "index.jsonl"
        self.index.write_text("".join(json.dumps(r) + "\n" for r in rows))

    def process(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return bulk.stage_full(self.source, self.snapshot, self.observations, self.run, workers=3)

    def test_parallel_staging_keeps_all_and_source_hashes(self):
        before = {str(p): common.digest(p) for p in self.source.rglob("*") if p.is_file()}
        result = self.process()
        self.assertEqual(len(result["results"]), 5)
        self.assertTrue(all(r["chosen"] for r in result["results"]))
        self.assertEqual(len(common.load(self.run / "catalog.json")["cards"]), 5)
        for row in result["results"]:
            metadata = common.load(row["merged_metadata_file"])
            self.assertFalse(metadata["human_reviewed"])
            self.assertFalse(metadata["rules_engine_implemented"])
        self.assertEqual(before, {str(p): common.digest(p) for p in self.source.rglob("*") if p.is_file()})
        dar = next(r for r in result["results"] if r["mik_id"].endswith("/DAR"))
        self.assertIn("printing_schema_unsupported", [h["code"] for h in dar["holds"]])
        with self.assertRaisesRegex(ValueError, "Do not restage"):
            self.process()

    def test_missing_card_face_is_still_a_hold(self):
        write(self.observations, {"observations": []})
        result = self.process()
        self.assertTrue(all("card_face_identity_not_independently_checked" in
                            [h["code"] for h in row["holds"]] for row in result["results"]))
        self.assertFalse(any(row["status"] == "ready" for row in result["results"]))

    def test_observation_mismatch_is_not_repaired_or_dropped(self):
        observations = common.load(self.observations)
        key = observations["observations"][0]["mik_id"]
        observations["observations"][0]["image_sha256"] = "0" * 64
        write(self.observations, observations)
        result = self.process()
        row = next(r for r in result["results"] if r["mik_id"] == key)
        self.assertEqual(row["status"], "blocked")
        self.assertIn("SHA-256 mismatch", row["holds"][0]["detail"])
        self.assertEqual(len(common.load(self.run / "catalog.json")["cards"]), 5)
        self.assertEqual(common.load(self.observations)["observations"][0]["image_sha256"], "0" * 64)

    def test_index_duplicates_and_unindexed_directories_are_rejected(self):
        raw = self.index.read_text()
        self.index.write_text(raw + raw.splitlines()[0] + "\n")
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            bulk.read_full_selection(self.source)
        self.index.write_text(raw)
        (self.source / "cards" / "EXTRA" / "001").mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "directories differ"):
            bulk.read_full_selection(self.source)

    def test_unmatched_record_remains_visible(self):
        selected = common.load(self.selection)["samples"]
        key = selected[0]["mik_id"]
        directory = self.source / "cards" / key
        metadata = common.load(directory / "metadata.json")
        metadata["cardType"] = "synthetic-unsupported-kind"
        write(directory / "metadata.json", metadata)
        write(directory / "source-response.json", {"code": 200, "data": metadata})
        write(directory / "metadata-receipt.json",
              {"sha256": hashlib.sha256((directory / "source-response.json").read_bytes()).hexdigest()})
        result = self.process()
        row = next(r for r in result["results"] if r["mik_id"] == key)
        self.assertIsNone(row["chosen"])
        self.assertEqual(row["status"], "blocked")
        self.assertTrue((self.run / "cards" / key / "review.json").is_file())
        self.assertEqual(len(common.load(self.run / "catalog.json")["cards"]), 5)

    def test_fallback_index_matches_original_jaccard_rank(self):
        import gzip
        with gzip.open(self.snapshot / "cards.jsonl.gz", "rt") as f:
            cards = {r["page_id"]: r for r in map(json.loads, f)}
        with gzip.open(self.snapshot / "display-zh-hans.jsonl.gz", "rt") as f:
            views = {r["page_id"]: r for r in map(json.loads, f)}
        matcher = bulk.BulkMatcher(cards, views)
        query = "将自己的手牌放于弃牌区后才可使用。"
        query_grams = bulk.grams(query)
        ranked = []
        for page_id, view in views.items():
            text = "".join(item["display"].get("effect") or "" for block in view["blocks"]
                           for group in ("attacks", "abilities", "effects") for item in block[group])
            values = bulk.grams(text)
            overlap = len(query_grams & values)
            if overlap:
                ranked.append((overlap / max(1, len(query_grams | values)), page_id))
        self.assertEqual(matcher.fallback(query), [p for _, p in sorted(ranked, reverse=True)[:8]])
        for directory in (self.source / "cards" / "TEST").iterdir():
            metadata = common.load(directory / "metadata.json")
            self.assertEqual(stage.Matcher(cards, views).find(metadata), matcher.find(metadata))

    def test_webp_and_nested_receipt_preserve_original_bytes_and_hash(self):
        from PIL import Image
        key = common.load(self.selection)["samples"][0]["mik_id"]
        directory = self.source / "cards" / key
        with Image.open(directory / "image.png") as im:
            im.save(directory / "image.webp", lossless=True)
        receipt = common.load(directory / "image-receipt.json")
        image_hash = common.digest(directory / "image.webp")
        receipt.pop("sha256")
        receipt["file"] = "image.webp"
        receipt["image"].update(sha256=image_hash, suffix=".webp")
        write(directory / "image-receipt.json", receipt)
        (directory / "image.png").unlink()
        observation = common.load(self.observations)
        for row in observation["observations"]:
            if row["mik_id"] == key:
                row["image_sha256"] = image_hash
        write(self.observations, observation)
        result = self.process()
        row = next(r for r in result["results"] if r["mik_id"] == key)
        self.assertIsNotNone(row["chosen"])
        metadata = common.load(row["merged_metadata_file"])
        self.assertEqual(metadata["primary_image"], "image.webp")
        self.assertEqual(metadata["images"][0]["sha256"], image_hash)
        self.assertEqual(common.digest(Path(row["output_directory"]) / "image.webp"), image_hash)

    def test_darkness_alias_is_logged_without_removing_cost(self):
        import gzip
        with gzip.open(self.snapshot / "cards.jsonl.gz", "rt") as f:
            wiki = json.loads(next(f))
        with gzip.open(self.snapshot / "display-zh-hans.jsonl.gz", "rt") as f:
            view = json.loads(next(f))
        wiki["card_blocks"][0]["attacks"][0]["cost"] = ["悪", "无", "+"]
        normalized, _, repairs = bulk.prepare_card(wiki, view)
        self.assertEqual(normalized["card_blocks"][0]["attacks"][0]["cost"], ["恶", "无", "+"])
        self.assertEqual(wiki["card_blocks"][0]["attacks"][0]["cost"], ["悪", "无", "+"])
        self.assertIn("explicit_darkness_label_alias_悪_恶", [r["method"] for r in repairs])

    def test_publish_materializes_final_images_without_changing_sources_or_holds(self):
        import copy
        staged = self.process()
        final = copy.deepcopy(staged)
        originals = {}
        for result in final["results"]:
            source = Path(result["merged_metadata_file"])
            originals[str(source)] = common.digest(source)
            target = self.run / "semantic-v2" / "candidates" / result["mik_id"] / "metadata.json"
            write(target, common.load(source))
            result["base_merged_metadata_file"] = str(source)
            result["merged_metadata_file"] = str(target)
            result["semantic_equivalence"] = []
        write(self.run / "semantic-v2" / "results.json", final)
        with contextlib.redirect_stdout(io.StringIO()):
            summary = bulk.publish(self.run)
        self.assertEqual(summary["total"], 5)
        for result in final["results"]:
            metadata_path = Path(result["merged_metadata_file"])
            image = metadata_path.parent / common.load(metadata_path)["primary_image"]
            self.assertTrue(image.is_file())
            self.assertEqual(common.digest(image), result["input_hashes"]["image_sha256"])
            detail = common.load(Path(result["output_directory"]) / "review.json")
            self.assertEqual(detail["holds"], result["holds"])
            self.assertFalse(detail["merged_candidate"]["human_reviewed"])
        self.assertEqual(originals, {path: common.digest(path) for path in originals})


if __name__ == "__main__":
    unittest.main()
