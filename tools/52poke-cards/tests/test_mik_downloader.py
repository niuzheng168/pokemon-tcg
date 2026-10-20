from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mik_downloader as mod


def raw(data):
    return json.dumps({"code": 200, "data": data}, ensure_ascii=False).encode("utf-8")


def card(index="001", code="A"):
    return {"setCode": code, "cardIndex": index, "cardName": "测试卡", "effectId": "abc"}


def details(record=None):
    record = record or card()
    return {**record, "name": record["cardName"], "description": "完整特性和招式",
            "pokemonAttr": {"hp": 100}, "setCardsNum": "", "effectSameCards": []}


stream = io.BytesIO()
Image.new("RGB", (30, 42), "green").save(stream, format="PNG")
PICTURE = stream.getvalue()


class FakeNetwork:
    def __init__(self, output, records=None):
        self.output, self.stop = output, threading.Event()
        self.calls, self.errors = [], {}
        self.records = records or [card()]

    def check(self):
        if self.stop.is_set() or (self.output / "PAUSE").exists():
            raise mod.Stopped("paused")

    def fetch(self, kind, payload):
        self.check()
        self.calls.append((kind, payload))
        if kind in self.errors:
            raise self.errors[kind]
        if kind == "catalog":
            content = raw({"list": [{"setId": "product", "setCode": "PROMO", "cardsNum": len(self.records)}]})
        elif kind == "set":
            content = raw({"setId": payload["setId"], "cards": self.records, "cardsNum": len(self.records)})
        elif kind == "metadata":
            record = next(c for c in self.records if mod.card_key(c) == mod.card_key(payload))
            content = raw(details(record))
        else:
            content = PICTURE
        return content, {"sha256": mod.sha256(content), "http_status": 200, "url": "https://tcg.mik.moe/test"}


class Response(io.BytesIO):
    status = 200

    def __init__(self, content, content_type="application/json", headers=None):
        super().__init__(content)
        self.headers = {"Content-Type": content_type, **(headers or {})}


class Opener:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def open(self, request, timeout):
        self.calls.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class MikDownloaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "downloads"
        self.output.mkdir()
        self.net = FakeNetwork(self.output)

    def runner(self, records=None):
        if records is not None:
            self.net.records = records
        runner = mod.Runner(self.output, self.net, workers=1)
        self.addCleanup(runner.close)
        return runner

    def run_quiet(self, runner, **kwargs):
        with redirect_stdout(io.StringIO()):
            return runner.run(**kwargs)

    def test_complete_download_preserves_source_data_and_exact_printing_id(self):
        runner = self.runner()
        result = self.run_quiet(runner)
        self.assertEqual(result["state"], "complete")
        self.assertEqual(result["metadata_downloaded"], 1)
        self.assertEqual(result["images_downloaded"], 1)
        directory = self.output / "cards/A/001"
        self.assertEqual(mod.load(directory / "metadata.json"), details())
        self.assertEqual((directory / "image.png").read_bytes(), PICTURE)
        self.assertFalse((self.output / "cards/PROMO").exists())
        self.assertEqual(mod.load(directory / "image-receipt.json")["image"]["sha256"],
                         hashlib.sha256(PICTURE).hexdigest())
        self.assertEqual(len((self.output / "index.jsonl").read_text().splitlines()), 1)
        self.assertFalse(result["existing_library_modified"])
        self.assertFalse(result["other_download_queues_resumed"])

    def test_resume_does_not_repeat_completed_requests(self):
        runner = self.runner()
        first = self.run_quiet(runner, limit=2)
        self.assertEqual(first["state"], "paused")
        self.assertEqual(first["metadata_downloaded"], 1)
        self.assertEqual(first["images_downloaded"], 0)
        self.assertEqual(self.run_quiet(runner)["state"], "complete")
        calls = list(self.net.calls)
        self.assertEqual(self.run_quiet(runner)["state"], "complete")
        self.assertEqual(self.net.calls, calls)

    def test_offline_verification_detects_later_corruption(self):
        runner = self.runner()
        self.run_quiet(runner)
        calls = list(self.net.calls)
        (self.output / "cards/A/001/image.png").write_bytes(b"corrupted")
        result = mod.verify(self.output)
        self.assertEqual(result["verified_completed_jobs"]["metadata"], 1)
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["errors"][0]["kind"], "image")
        self.assertEqual(self.net.calls, calls)
        self.assertEqual(self.run_quiet(runner)["state"], "complete_with_gaps")

    def test_null_description_is_preserved_as_source_data(self):
        data = details()
        data["description"] = None
        mod.validate_metadata(data, card())
        self.assertIsNone(data["description"])

    def test_leading_zeros_and_different_printings_are_not_merged(self):
        result = self.run_quiet(self.runner([card("001"), card("1"), card("001", "B")]))
        self.assertEqual(result["images_downloaded"], 3)
        self.assertEqual(result["discovered_unique_printings"], 3)
        for key in ("A/001", "A/1", "B/001"):
            self.assertTrue((self.output / "cards" / key / "image.png").exists())

    def test_same_record_repeated_in_a_list_is_not_double_downloaded(self):
        result = self.run_quiet(self.runner([card(), card()]))
        self.assertEqual(result["discovered_unique_printings"], 1)
        self.assertEqual(result["metadata_downloaded"], 1)
        self.assertEqual(result["state"], "complete_with_gaps")
        self.assertIn("product", result["catalog_count_warnings"])

    def test_source_404_is_reported_as_missing_not_success(self):
        self.net.errors["image"] = mod.Missing("HTTP 404")
        result = self.run_quiet(self.runner())
        self.assertEqual(result["state"], "complete_with_gaps")
        self.assertEqual(result["images_downloaded"], 0)
        self.assertEqual(result["jobs"]["image"]["missing"], 1)
        self.assertEqual(sum(k == "image" for k, _ in self.net.calls), 1)

    def test_invalid_image_is_not_published(self):
        original = self.net.fetch

        def fetch(kind, payload):
            if kind == "image":
                return b"not png", {}
            return original(kind, payload)

        self.net.fetch = fetch
        result = self.run_quiet(self.runner())
        self.assertEqual(result["state"], "complete_with_gaps")
        self.assertFalse((self.output / "cards/A/001/image.png").exists())

    def test_actual_image_format_is_preserved_despite_png_url(self):
        for fmt, suffix in (("JPEG", ".jpg"), ("WEBP", ".webp"), ("GIF", ".gif")):
            with self.subTest(format=fmt):
                output = self.output / fmt
                net = FakeNetwork(output)
                stream = io.BytesIO()
                Image.new("RGB", (30, 42), "blue").save(stream, format=fmt)
                image = stream.getvalue()
                original = net.fetch

                def fetch(kind, payload):
                    if kind == "image":
                        return image, {"sha256": mod.sha256(image)}
                    return original(kind, payload)

                net.fetch = fetch
                runner = mod.Runner(output, net, workers=1)
                self.addCleanup(runner.close)
                self.assertEqual(self.run_quiet(runner)["state"], "complete")
                directory = output / "cards/A/001"
                self.assertEqual((directory / ("image" + suffix)).read_bytes(), image)
                self.assertFalse((directory / "image.png").exists())
                self.assertEqual(mod.load(directory / "image-receipt.json")["file"], "image" + suffix)
                self.assertEqual(mod.verify(output)["errors"], [])
                self.assertEqual(json.loads((output / "index.jsonl").read_text())["image_file"], "image" + suffix)
                calls = list(net.calls)
                self.assertEqual(self.run_quiet(runner)["state"], "complete")
                self.assertEqual(net.calls, calls)
                seed_output = self.output / (fmt + "-seed")
                mod.seed(seed_output, directory)
                self.assertEqual((seed_output / "cards/A/001" / ("image" + suffix)).read_bytes(), image)

    def test_format_retry_is_narrow_and_preserves_attempt_history(self):
        self.net.errors["image"] = ValueError("The published PNG endpoint returned another format.")
        runner = self.runner()
        self.assertEqual(self.run_quiet(runner)["state"], "complete_with_gaps")
        with runner.db:
            runner.db.execute("INSERT INTO jobs(kind,key,body,state,error) VALUES(?,?,?,?,?)",
                              ("image", "other/404", "{}", "missing", "HTTP 404"))
        self.assertEqual(runner.retry_image_formats(), 1)
        row = runner.db.execute("SELECT state,attempts FROM jobs WHERE key='A/001' AND kind='image'").fetchone()
        self.assertEqual(tuple(row), ("pending", 1))
        self.assertEqual(runner.db.execute("SELECT state FROM jobs WHERE key='other/404'").fetchone()[0], "missing")
        audit = json.loads((self.output / "format-retries.jsonl").read_text())
        self.assertEqual(audit["jobs"][0]["error"], mod.LEGACY_FORMAT_ERROR)
        del self.net.errors["image"]
        result = self.run_quiet(runner)
        self.assertEqual(result["images_downloaded"], 1)
        self.assertEqual(result["jobs"]["image"]["missing"], 1)

    def test_receipt_cannot_redirect_image_reads_outside_card_directory(self):
        for filename in ("../image.jpg", "/tmp/image.jpg", "image.png"):
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                mod.stored_image_path(self.output, {"file": filename, "image": {"suffix": ".jpg"}})

    def test_returned_wrong_card_identity_is_not_published(self):
        original = self.net.fetch

        def fetch(kind, payload):
            if kind == "metadata":
                content = raw(details(card("999")))
                return content, {"sha256": mod.sha256(content)}
            return original(kind, payload)

        self.net.fetch = fetch
        result = self.run_quiet(self.runner())
        self.assertEqual(result["jobs"]["metadata"]["error"], 1)
        self.assertFalse((self.output / "cards/A/001/metadata.json").exists())
        self.assertNotIn("image", [kind for kind, _ in self.net.calls])

    def test_conflicting_catalog_duplicate_is_not_accepted(self):
        conflict = {**card(), "effectId": "different"}
        result = self.run_quiet(self.runner([card(), conflict]))
        self.assertEqual(result["discovered_unique_printings"], 0)
        self.assertEqual(result["jobs"]["set"]["error"], 1)

    def test_transient_retries_are_bounded_and_back_off(self):
        runner = self.runner()
        self.run_quiet(runner, limit=1)  # Series discovery.
        self.net.errors["metadata"] = mod.Transient("timeout")
        for attempts in range(1, 4):
            result = self.run_quiet(runner, limit=1)
            row = runner.db.execute("SELECT * FROM jobs WHERE kind='metadata'").fetchone()
            self.assertEqual(row["attempts"], attempts)
            self.assertGreater(row["next_at"], mod.time.time())
            with runner.db:
                runner.db.execute("UPDATE jobs SET next_at=0")
        self.assertEqual(result["jobs"]["metadata"]["error"], 1)
        self.assertEqual(self.run_quiet(runner)["state"], "complete_with_gaps")
        self.assertEqual(sum(k == "metadata" for k, _ in self.net.calls), 3)

    def test_cached_response_hash_mismatch_does_not_trigger_refetch(self):
        runner = self.runner()
        self.run_quiet(runner, limit=1)
        path = self.output / "cards/A/001/source-response.json"
        path.parent.mkdir(parents=True)
        path.write_bytes(raw(details()))
        mod.atomic_json(path.with_name("metadata-receipt.json"), {"sha256": "0" * 64})
        result = self.run_quiet(runner)
        self.assertEqual(result["jobs"]["metadata"]["error"], 1)
        self.assertNotIn("metadata", [kind for kind, _ in self.net.calls])
        self.assertEqual(path.read_bytes(), raw(details()))

    def test_seed_reuses_both_verified_files_without_network(self):
        original = self.runner()
        self.run_quiet(original)
        source = self.output / "cards/A/001"
        target = Path(self.temp.name) / "second"
        mod.seed(target, source)
        net = FakeNetwork(target)
        runner = mod.Runner(target, net, workers=1)
        self.addCleanup(runner.close)
        result = self.run_quiet(runner)
        self.assertEqual(result["state"], "complete")
        self.assertEqual([kind for kind, _ in net.calls], ["catalog", "set"])

    def test_manual_metadata_is_not_overwritten(self):
        runner = self.runner()
        self.run_quiet(runner, limit=1)
        path = self.output / "cards/A/001/metadata.json"
        mod.atomic_json(path, {"manual": "do not overwrite"})
        result = self.run_quiet(runner)
        self.assertEqual(result["jobs"]["metadata"]["error"], 1)
        self.assertEqual(mod.load(path), {"manual": "do not overwrite"})

    def test_paused_runner_does_not_make_network_requests(self):
        runner = self.runner()
        (self.output / "PAUSE").write_text("pause")
        with self.assertRaises(mod.Stopped):
            self.run_quiet(runner)
        self.assertEqual(self.net.calls, [])

    def test_safe_identifiers_reject_traversal_and_reserved_names(self):
        for value in ("../other", "A/1", "A\\1", "a..b", ".", "NUL", "COM1", "x.", "a\nb"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                mod.component(value)
        self.assertEqual(mod.component("CSM2.5C"), "CSM2.5C")
        self.assertEqual(mod.component("CSMPaC"), "CSMPaC")

    def test_symlink_escape_is_rejected(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.output / "cards").symlink_to(outside)
        with self.assertRaises(ValueError):
            mod.safe_path(self.output, Path("cards/A/001/image.png"))
        self.assertEqual(list(outside.iterdir()), [])

    def test_network_identifies_agent_and_does_not_send_cookies(self):
        opener = Opener([Response(raw({"list": []}), headers={"Set-Cookie": "secret=value"})])
        net = mod.Network(self.output, "本地查看卡组配合", opener=opener)
        _, receipt = net.fetch("catalog", {})
        headers = dict(opener.calls[0].header_items())
        self.assertEqual(headers["User-agent"], mod.USER_AGENT)
        self.assertIn("本地查看卡组配合", headers["Agent-intent"].decode("utf-8"))
        self.assertNotIn("Cookie", headers)
        self.assertNotIn("secret", json.dumps(receipt))
        self.assertEqual(opener.calls[0].method, "POST")
        self.assertEqual(opener.calls[0].data, b"{}")

    def test_http_denials_and_redirects_persist_without_retry(self):
        for code in (401, 403, 429, 302):
            with self.subTest(code=code):
                output = self.output / str(code)
                error = urllib.error.HTTPError(mod.ORIGIN, code, "denied", {}, None)
                opener = Opener([error])
                net = mod.Network(output, "本地查看卡组配合", opener=opener)
                with self.assertRaises(mod.Stopped):
                    net.fetch("catalog", {})
                self.assertEqual(mod.load(output / "access-block.json")["http_status"], code)
                other = mod.Network(output, "本地查看卡组配合", opener=opener)
                with self.assertRaises(mod.Stopped):
                    other.fetch("catalog", {})
                self.assertEqual(len(opener.calls), 1)

    def test_api_denial_inside_http_200_stops(self):
        opener = Opener([Response(json.dumps({"code": 429, "msg": "slow down"}).encode())])
        net = mod.Network(self.output, "本地查看卡组配合", opener=opener)
        with self.assertRaises(mod.Stopped):
            net.fetch("catalog", {})
        self.assertTrue((self.output / "access-block.json").exists())

    def test_html_challenge_stops_without_browser_fallback(self):
        opener = Opener([Response(b"<html>challenge</html>", "text/html")])
        net = mod.Network(self.output, "本地查看卡组配合", opener=opener)
        with self.assertRaises(mod.Stopped):
            net.fetch("catalog", {})
        self.assertEqual(len(opener.calls), 1)

    def test_worker_and_request_rate_are_bounded(self):
        with self.assertRaises(ValueError):
            mod.Runner(self.output, self.net, workers=50)
        with self.assertRaises(ValueError):
            mod.Network(self.output, "本地查看卡组配合", interval=0)
        self.assertIsNone(mod.NoRedirect().redirect_request(None, None, 302, "", {}, mod.ORIGIN))

    def test_large_declared_response_is_rejected(self):
        opener = Opener([Response(b"{}", headers={"Content-Length": "9999999999"})])
        net = mod.Network(self.output, "本地查看卡组配合", opener=opener)
        with self.assertRaises(ValueError):
            net.fetch("catalog", {})

    def test_status_is_offline_standard_library_only_and_creates_nothing(self):
        output = Path(self.temp.name) / "new"
        result = subprocess.run([sys.executable, "-S", mod.__file__, "--output", str(output), "status"],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "not_started")
        self.assertFalse(output.exists())

    def test_run_requires_explicit_local_authorization(self):
        output = Path(self.temp.name) / "new"
        result = subprocess.run([sys.executable, mod.__file__, "--output", str(output), "run",
                                 "--purpose", "本地查看卡组配合"], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--user-authorized", result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
