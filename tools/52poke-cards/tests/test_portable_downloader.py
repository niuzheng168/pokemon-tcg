from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
import zipfile

from PIL import Image

import portable_downloader as d


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}


class Opener:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class Clock:
    def __init__(self, at=None):
        self.at = at or datetime(2026, 10, 18, 18, tzinfo=timezone.utc).timestamp()
        self.sleeps = []

    def now(self):
        return self.at

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.at += seconds


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        stream = io.BytesIO()
        Image.new("RGB", (3, 4), "green").save(stream, format="PNG")
        self.png = stream.getvalue()
        self.target = {
            "wiki_filename": "Example001.png", "wiki_file_page_id": 1, "wiki_file_revision_id": 2,
            "uses": [], "declared_source_urls": [], "semantic_identity_review_required": True,
            "latest_file_metadata": {
                "url": "https://media.52poke.com/wiki/a/ab/Example001.png",
                "sha1": hashlib.sha1(self.png).hexdigest(), "size": len(self.png),
                "width": 3, "height": 4,
            },
        }
        self.manifest = {"schema_version": 1, "targets": [self.target]}
        self.manifest_path = self.root / "manifest.json"
        d.atomic_json(self.manifest_path, self.manifest)
        self.clock = Clock()

    def network(self, replies=(), wait=True):
        opener = Opener(replies)
        network = d.Network(self.root, wait=wait, opener=opener,
                            clock=self.clock.now, sleep=self.clock.sleep)
        for url in d.ROBOTS_URLS:
            network.state["robots"][url] = {
                "at": self.clock.now(), "text": "User-agent: *\nAllow: /\n", "delay": 0,
            }
        return network, opener

    def response(self, data=None, status=200, headers=None):
        content = self.png if data is None else data
        return Response(content, status, {
            "Content-Type": "image/png", "Content-Length": str(len(content)), "ETag": '"stable"',
            **(headers or {}),
        })

    def test_manifest_and_missing_url_are_offline(self):
        self.manifest["targets"].append({
            "wiki_filename": "Missing.png", "latest_file_metadata": None,
        })
        d.atomic_json(self.manifest_path, self.manifest)
        manifest = d.load_manifest(self.manifest_path)
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")), redirect_stdout(io.StringIO()) as out:
            d.status(manifest, self.root)
        report = json.loads(out.getvalue())
        self.assertEqual(report["with_original_url"], 1)
        self.assertEqual(report["without_original_url"], 1)
        self.assertEqual(report["network_requests"], 0)

    def test_manifest_rejects_url_and_path_injection(self):
        for url in (
            "http://media.52poke.com/wiki/a/ab/Example001.png",
            "https://other.example/wiki/a/ab/Example001.png",
            "https://media.52poke.com@other.example/wiki/a/ab/Example001.png",
            "https://media.52poke.com/wiki/a/ab/Example001.png?token=secret",
            "https://media.52poke.com/wiki/archive/a/ab/Example001.png",
        ):
            with self.subTest(url=url):
                self.target["latest_file_metadata"]["url"] = url
                d.atomic_json(self.manifest_path, self.manifest)
                with self.assertRaises(ValueError):
                    d.load_manifest(self.manifest_path)

    def test_fresh_download_is_verified_with_fixed_identity(self):
        network, opener = self.network([self.response()])
        digest = d.download_one(network, self.root, self.target)
        self.assertEqual(digest["sha256"], hashlib.sha256(self.png).hexdigest())
        self.assertEqual(opener.requests[0].get_header("User-agent"), d.USER_AGENT)
        self.assertEqual(d.image_path(self.root, self.target).read_bytes(), self.png)
        self.assertFalse(network.state["in_flight"])
        self.assertTrue(self.clock.sleeps)  # Bandwidth limiting is also active.

    def test_403_is_persistent_and_not_retried(self):
        error = urllib.error.HTTPError(d.ROBOTS_URLS[0], 403, "Forbidden", {}, None)
        network, opener = self.network([error])
        with self.assertRaises(d.StopDownload):
            network.request(d.ROBOTS_URLS[0], lambda response: None, reserve=100)
        with self.assertRaises(d.StopDownload):
            network.request(d.ROBOTS_URLS[0], lambda response: None, reserve=100)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(network.state["access_block"]["status"], 403)
        restored = d.Network(self.root, opener=Opener([]), clock=self.clock.now)
        self.assertEqual(restored.state["access_block"]["status"], 403)

    def test_401_and_429_also_stop_without_retry(self):
        for code in (401, 429):
            with self.subTest(code=code):
                self.root.joinpath("state.json").unlink(missing_ok=True)
                error = urllib.error.HTTPError(d.ROBOTS_URLS[0], code, "Blocked", {"Retry-After": "600"}, None)
                network, opener = self.network([error])
                with self.assertRaises(d.StopDownload):
                    network.request(d.ROBOTS_URLS[0], lambda response: None, reserve=100)
                self.assertEqual(network.state["access_block"]["status"], code)
                self.assertEqual(len(opener.requests), 1)

    def test_500_seconds_gap_not_milliseconds(self):
        network, _ = self.network([Response(b""), Response(b"")])
        network.request(d.ROBOTS_URLS[0], lambda response: response.read(), reserve=1)
        previous = self.clock.now()
        network.request(d.ROBOTS_URLS[1], lambda response: response.read(), reserve=1)
        self.assertGreaterEqual(self.clock.now() - previous, 500)

    def test_no_wait_never_requests_outside_window(self):
        self.clock.at = datetime(2026, 10, 19, 4, tzinfo=timezone.utc).timestamp()
        network, opener = self.network([Response(b"")], wait=False)
        with self.assertRaisesRegex(d.StopDownload, "Next permitted"):
            network.request(d.ROBOTS_URLS[0], lambda response: None, reserve=1)
        self.assertFalse(opener.requests)

    def test_wait_obeys_machine_independent_night_window(self):
        self.clock.at = datetime(2026, 10, 19, 4, tzinfo=timezone.utc).timestamp()
        network, opener = self.network([Response(b"")])
        network.request(d.ROBOTS_URLS[0], lambda response: response.read(), reserve=1)
        self.assertTrue(d.off_peak(self.clock.now()))
        self.assertEqual(datetime.fromtimestamp(self.clock.now(), d.TZ).hour, 2)
        self.assertEqual(len(opener.requests), 1)

    def test_longer_robots_delay_and_hour_budget(self):
        network, _ = self.network([Response(b"")])
        network.state["last_finished"] = self.clock.now()
        network.state["robots"][d.ROBOTS_URLS[0]]["delay"] = 800
        network.state["transfers"] = [{"at": self.clock.now(), "bytes": d.HOUR_BYTES}]
        before = self.clock.now()
        network.request(d.ROBOTS_URLS[0], lambda response: response.read(), reserve=1)
        self.assertGreaterEqual(self.clock.now() - before, 3601)

    def test_first_robots_fetch_has_no_empty_max_error(self):
        network = d.Network(self.root, wait=True, opener=Opener([Response(b"User-agent: *\nAllow: /\n")]),
                            clock=self.clock.now, sleep=self.clock.sleep)
        network.request(d.ROBOTS_URLS[0], lambda response: response.read(), reserve=65536)

    def test_policies_expiring_during_overnight_wait_are_refreshed(self):
        # First policies at 02:00; next image slot crosses the 08:00 cutoff.
        policy_time = self.clock.now()
        self.clock.at += 6 * 3600 - 60
        text = b"User-agent: *\nAllow: /\n"
        network, opener = self.network([Response(text), Response(text), self.response()])
        for policy in network.state["robots"].values():
            policy["at"] = policy_time
        network.state["last_finished"] = self.clock.now()
        d.download_one(network, self.root, self.target)
        self.assertEqual([r.full_url for r in opener.requests], [
            *d.ROBOTS_URLS, self.target["latest_file_metadata"]["url"],
        ])
        self.assertTrue(d.off_peak(self.clock.now()))
        self.assertTrue(all(self.clock.now() - r["at"] < 86400 for r in network.state["robots"].values()))

    def test_robots_denial_prevents_image_request(self):
        network, opener = self.network([self.response()])
        network.state["robots"][d.ROBOTS_URLS[1]]["text"] = "User-agent: *\nDisallow: /\n"
        with self.assertRaisesRegex(d.StopDownload, "disallows"):
            d.download_one(network, self.root, self.target)
        self.assertFalse(opener.requests)

    def test_html_and_corrupt_content_are_not_accepted(self):
        network, _ = self.network([self.response(b"<html>challenge</html>", headers={"Content-Type": "text/html"})])
        with self.assertRaises(d.StopDownload):
            d.download_one(network, self.root, self.target)
        self.assertFalse(d.image_path(self.root, self.target).exists())
        network, _ = self.network([self.response(b"x" * len(self.png))])
        with self.assertRaises(ValueError):
            d.download_one(network, self.root, self.target)
        self.assertFalse(d.image_path(self.root, self.target).exists())

    def test_resume_uses_range_and_if_range(self):
        path = d.image_path(self.root, self.target)
        path.parent.mkdir()
        path.with_name(path.name + ".part").write_bytes(self.png[:20])
        d.atomic_json(path.with_name(path.name + ".resume.json"), {
            "url": self.target["latest_file_metadata"]["url"], "validator": '"stable"',
        })
        response = self.response(self.png[20:], 206, {"Content-Range": f"bytes 20-{len(self.png)-1}/{len(self.png)}"})
        network, opener = self.network([response])
        d.download_one(network, self.root, self.target)
        self.assertEqual(opener.requests[0].get_header("Range"), "bytes=20-")
        self.assertEqual(opener.requests[0].get_header("If-range"), '"stable"')
        self.assertEqual(path.read_bytes(), self.png)

    def test_ignored_range_retains_partial_without_overwrite(self):
        path = d.image_path(self.root, self.target)
        path.parent.mkdir()
        part = path.with_name(path.name + ".part")
        part.write_bytes(self.png[:20])
        d.atomic_json(path.with_name(path.name + ".resume.json"), {
            "url": self.target["latest_file_metadata"]["url"], "validator": '"stable"',
        })
        network, _ = self.network([self.response()])
        with self.assertRaisesRegex(d.StopDownload, "Range"):
            d.download_one(network, self.root, self.target)
        self.assertEqual(part.read_bytes(), self.png[:20])
        self.assertFalse(path.exists())

    def test_crashed_request_starts_new_gap(self):
        d.atomic_json(self.root / "state.json", {
            "last_finished": 1, "robots": {}, "transfers": [], "in_flight": True,
        })
        network, _ = self.network()
        self.assertEqual(network.state["last_finished"], self.clock.now())
        self.assertNotIn("in_flight", network.state)

    def test_verified_cache_is_offline_and_missing_receipt_file_is_not_redownloaded(self):
        path = d.image_path(self.root, self.target)
        path.parent.mkdir()
        path.write_bytes(self.png)
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            self.assertEqual(d.verify_cached(self.manifest, self.root, record=True)[0], 1)
        receipt = d.read_json(self.root / "receipts.json")["files"][self.target["wiki_filename"]]
        self.assertTrue(receipt["semantic_identity_review_required"])
        self.assertTrue(receipt["not_an_automatic_language_or_engine_version_approval"])
        path.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            d.verify_cached(self.manifest, self.root, record=True)

    def test_complete_partial_is_recovered_without_network(self):
        path = d.image_path(self.root, self.target)
        path.parent.mkdir()
        path.with_name(path.name + ".part").write_bytes(self.png)
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            self.assertEqual(d.verify_cached(self.manifest, self.root, record=True)[0], 1)
        self.assertTrue(path.exists())

    def test_output_directory_has_single_writer_lock(self):
        with d.output_lock(self.root):
            with self.assertRaises(d.StopDownload):
                with d.output_lock(self.root):
                    self.fail("second writer acquired the lock")

    def test_cli_does_not_download_without_authorization(self):
        with patch("sys.argv", ["portable_downloader.py", "--manifest", str(self.manifest_path),
                                "--output", str(self.root / "out"), "download"]), \
                patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(d.StopDownload, "permission"):
                d.main()

    def test_result_zip_includes_only_verified_files_and_provenance(self):
        path = d.image_path(self.root, self.target)
        path.parent.mkdir()
        path.write_bytes(self.png)
        (self.root / ".env").write_text("SECRET=not-for-export")
        result = self.root / "result.zip"
        with patch("sys.argv", ["portable_downloader.py", "--manifest", str(self.manifest_path),
                                "--output", str(self.root), "pack-results", "--zip", str(result)]), \
                patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            d.main()
        with zipfile.ZipFile(result) as archive:
            self.assertEqual(set(archive.namelist()), {"manifest.json", "receipts.json", path.relative_to(self.root).as_posix()})
            self.assertNotIn(b"not-for-export", b"".join(archive.read(name) for name in archive.namelist()))


if __name__ == "__main__":
    unittest.main()
