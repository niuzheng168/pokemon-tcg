import io
from concurrent.futures import Future
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collect_official_candidates as collector
import image_pipeline as pipeline
from accept_official_candidates import agreement
from download_images import AccessBlocked, download_asset

PAGE = "https://www.pokemon.cn/tcg/product/example.html"


class Response(io.BytesIO):
    status = 200

    def __init__(self, data):
        super().__init__(data)
        self.headers = {"Content-Type": "image/png", "Content-Length": str(len(data))}


class FakeNetwork:
    def __init__(self, *args):
        stream = io.BytesIO()
        Image.new("RGB", (71, 100), (200, 80, 20)).save(stream, "PNG")
        self.data = stream.getvalue()

    def permitted(self, url):
        pass

    def finished(self):
        pass

    def open(self, url, headers):
        return Response(self.data)


def reading(**changes):
    value = {"name": "皮卡丘", "set_code": "CSV1C", "number": "001/100",
             "hp": 60, "language": "zh-Hans", "confidence": 1}
    value.update(changes)
    return {"reading": value}


def page_html(*names):
    return "<article>" + "".join(
        f'<img src="https://image.pokemon.com.cn/{name}.png?auth_key=published">' for name in names
    ) + "</article>"


class PipelineTests(unittest.TestCase):
    def test_cancelled_queued_ocr_is_removed_without_shutdown_spin(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = pipeline.connect(Path(tmp))
            worker = collector.OCRPipeline(db, {}, workers=1)
            future = Future()
            future.cancel()
            worker.pending[future] = ("unused", "/unused", "ocr")
            try:
                worker.poll()
                self.assertEqual(worker.pending, {})
            finally:
                worker.pending.clear()
                worker.close()
                db.close()

    def test_manifest_deduplicates_images_and_preserves_both_published_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = pipeline.connect(Path(tmp))
            pipeline.enqueue_page(db, PAGE, page_html("one", "one"))
            pipeline.enqueue_page(db, PAGE + "?edition=2", page_html("one"))
            self.assertEqual(db.execute("SELECT count(*) FROM resource_jobs").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM resource_sources").fetchone()[0], 2)
            self.assertEqual(pipeline.export_manifest(db, Path(tmp)), 1)
            item = json.loads((Path(tmp) / "download-list.jsonl").read_text())
            self.assertEqual(len(item["source_pages"]), 2)
            db.close()

    def test_download_never_reads_model_credentials_and_can_resume_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(pipeline, "OfficialNetwork", FakeNetwork):
            directory = Path(tmp)
            db = pipeline.connect(directory)
            pipeline.enqueue_page(db, PAGE, page_html("one", "two"))
            with patch.object(pipeline, "settings", side_effect=AssertionError("No credentials allowed")), \
                    patch.object(pipeline, "OCRPipeline", side_effect=AssertionError("No OCR allowed")):
                pipeline.download(db, directory)
                pipeline.download(db, directory)
            self.assertEqual(db.execute("SELECT count(*) FROM photos").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT sum(attempts) FROM resource_jobs").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM photos WHERE ocr IS NOT NULL").fetchone()[0], 0)
            db.close()

    def test_slow_ocr_cannot_block_download_worker(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        errors = []

        def slow_ocr(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("Test cleanup timeout")
            return reading()

        def process_worker(directory):
            db = pipeline.connect(directory)
            try:
                pipeline.process(db, {}, workers=1)
            except BaseException as exc:
                errors.append(exc)
            finally:
                db.close()
                finished.set()

        with tempfile.TemporaryDirectory() as tmp, patch.object(pipeline, "OfficialNetwork", FakeNetwork), \
                patch.object(collector, "ocr", side_effect=slow_ocr):
            directory = Path(tmp)
            db = pipeline.connect(directory)
            record = download_asset(FakeNetwork(), "https://image.pokemon.com.cn/initial.png", PAGE, directory)
            db.execute("INSERT INTO photos(url,page_url,record) VALUES (?,?,?)",
                       ("https://image.pokemon.com.cn/initial.png", PAGE, json.dumps(record)))
            db.commit()
            thread = threading.Thread(target=process_worker, args=(directory,))
            thread.start()
            try:
                self.assertTrue(entered.wait(2), "The OCR worker must actually be blocked.")
                pipeline.enqueue_page(db, PAGE, page_html("one", "two"))
                pipeline.download(db, directory)
                self.assertFalse(finished.is_set(), "OCR should still be waiting.")
                self.assertEqual(db.execute("SELECT count(*) FROM resource_jobs WHERE status='done'").fetchone()[0], 2)
            finally:
                release.set()
                thread.join(5)
                db.close()
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])

    def test_access_block_stops_before_next_download_without_altering_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            db = pipeline.connect(directory)
            pipeline.enqueue_page(db, PAGE, page_html("one", "two"))
            with patch.object(pipeline, "download_asset", side_effect=AccessBlocked("HTTP 403")) as fetch:
                with self.assertRaises(AccessBlocked):
                    pipeline.download(db, directory)
            self.assertEqual(fetch.call_count, 1)
            statuses = dict(db.execute("SELECT status,count(*) FROM resource_jobs GROUP BY status"))
            self.assertEqual(statuses, {"blocked": 1, "pending": 1})
            db.close()

    def test_unidentifiable_first_read_does_not_waste_second_model_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = pipeline.connect(Path(tmp))
            url = "https://image.pokemon.com.cn/one.png"
            record = {"local_file": "/unused/test.png", "width": 868, "height": 1212}
            db.execute("INSERT INTO photos(url,page_url,record) VALUES (?,?,?)", (url, PAGE, json.dumps(record)))
            db.commit()
            calls = []

            def reader(*args, **kwargs):
                calls.append(kwargs["full"])
                return reading(number=None)

            worker = collector.OCRPipeline(db, {}, workers=1, reader=reader)
            worker.submit(url, record, None)
            worker.close()
            self.assertEqual(calls, [False])
            self.assertEqual(db.execute("SELECT count(*) FROM ocr_reviews").fetchone()[0], 1)
            self.assertIsNone(db.execute("SELECT second_ocr FROM photos").fetchone()[0])
            db.close()

    def test_strict_identity_gate_still_rejects_wrong_language_number_or_hp(self):
        first = reading()["reading"]
        self.assertTrue(agreement(first, first))
        for change in ({"language": "zh-Hant"}, {"number": "002/100"}, {"hp": 70},
                       {"set_code": "CSV2C"}, {"name": "雷丘"}, {"confidence": .97}):
            self.assertFalse(agreement(first, reading(**change)["reading"]))

    def test_model_rate_limit_pauses_only_processing_not_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = pipeline.connect(Path(tmp))
            record = {"local_file": "/unused/test.png", "width": 868, "height": 1212}
            db.execute("INSERT INTO photos(url,page_url,record) VALUES (?,?,?)", ("test", PAGE, json.dumps(record)))
            db.commit()

            def limited(*args, **kwargs):
                raise collector.OCRHTTPError(429)

            worker = collector.OCRPipeline(db, {}, workers=1, reader=limited)
            worker.submit("test", record, None)
            worker.close()
            self.assertTrue(worker.paused)
            self.assertIsNotNone(db.execute("SELECT 1 FROM state WHERE key='ocr_paused'").fetchone())
            self.assertIsNone(db.execute("SELECT 1 FROM state WHERE key='blocked'").fetchone())
            db.close()

    def test_invalid_ocr_schema_is_rejected(self):
        for change in ({"confidence": "1"}, {"confidence": True}, {"hp": "60"}, {"name": []}):
            with self.assertRaises(ValueError):
                collector.validate_reading(reading(**change)["reading"])


if __name__ == "__main__":
    unittest.main()
