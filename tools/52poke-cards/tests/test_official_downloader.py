from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import zipfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import official_downloader as mod
import portable_downloader as portable
from card_storage import atomic_json

PAGE = "https://www.pokemon.cn/tcg/example.html"
IMAGE = "https://image.pokemon.com.cn/wp-content/uploads/example.png"
PICTURE = io.BytesIO()
Image.new("RGB", (260, 363), "green").save(PICTURE, format="PNG")
PICTURE = PICTURE.getvalue()


def manifest(*, review=False):
    return {"schema_version": 1, "targets": [{
        "wiki_filename": "Example001.png", "wiki_file_page_id": 3, "wiki_file_revision_id": 4,
        "uses": [{"page_id": 1, "language": "zh-Hans", "set_code": "151C", "number": "001/151"}],
        "declared_source_urls": [PAGE], "semantic_identity_review_required": review,
        "latest_file_metadata": {
            "url": "https://media.52poke.com/wiki/a/ab/Example001.png",
            "sha1": hashlib.sha1(PICTURE).hexdigest(), "size": len(PICTURE),
            "width": 260, "height": 363,
        },
    }]}


class Clock:
    def __init__(self):
        self.now = 1000.

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Response(io.BytesIO):
    status = 200

    def __init__(self, data, content_type="text/plain", headers=None):
        super().__init__(data)
        self.headers = {"Content-Type": content_type, "Content-Length": str(len(data)), **(headers or {})}


class Opener:
    def __init__(self, clock, replies):
        self.clock, self.replies, self.calls = clock, list(replies), []

    def open(self, request, timeout):
        if urllib.parse.urlsplit(request.full_url).path == "/robots.txt":
            raise AssertionError("Official downloads must not request robots.txt.")
        self.calls.append((request.full_url, self.clock.time(), dict(request.header_items())))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class FakeNetwork:
    def __init__(self, replies):
        self.replies, self.calls = replies, []

    def check_stopped(self):
        pass

    def fetch(self, url, kind):
        self.calls.append((url, kind))
        result = self.replies[url]
        if isinstance(result, Exception):
            raise result
        return result


class OfficialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output, self.library = self.root / "downloads", self.root / "library"
        self.clock = Clock()

    def network(self, replies):
        opener = Opener(self.clock, replies)
        net = mod.OfficialNetwork(self.output, opener=opener,
                                  clock=self.clock.time, sleep=self.clock.sleep)
        return net, opener

    def run_download(self, data=None, **kwargs):
        net = FakeNetwork({PAGE: f'<article><img src="{IMAGE}"></article>'.encode(),
                           IMAGE: PICTURE if data is None else data})
        runner = mod.Runner(kwargs.pop("manifest", manifest()), self.output, net)
        with redirect_stdout(io.StringIO()):
            runner.download(library=self.library, **kwargs)
        return runner, net

    def test_plan_cli_is_offline_stdlib_only_and_does_not_create_output(self):
        path = self.root / "manifest.json"
        atomic_json(path, manifest())
        result = subprocess.run([
            sys.executable, "-S", str(Path(portable.__file__).resolve()),
            "--source", "official", "--manifest", str(path), "--output", str(self.output), "plan",
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["declared_official_pages"], 1)
        self.assertFalse(self.output.exists())

    def test_only_simplified_chinese_targets_and_official_hosts_are_discovered(self):
        value = manifest()
        for language in ("zh-Hant", "ja", None):
            other = json.loads(json.dumps(value["targets"][0]))
            other["uses"][0]["language"] = language
            other["declared_source_urls"] = [PAGE + "/not-simplified"]
            value["targets"].append(other)
        value["targets"][0]["declared_source_urls"] += [
            "https://media.52poke.com/wiki/a/ab/Example001.png", "https://asia.pokemon-card.com/tw/"]
        self.assertEqual(mod.source_pages(value), {PAGE: PAGE})
        self.assertEqual(len(mod.simplified_targets(value)), 1)

    def test_url_allowlist_rejects_spoofed_hosts_and_credentials(self):
        for url in ("http://www.pokemon.cn/a", "https://pokemon.cn.evil.test/a",
                    "https://evilpokemon.cn/a", "https://user@www.pokemon.cn/a",
                    "https://www.pokemon.cn:444/a", "https://www.pokemon.cn\\@evil.test/a",
                    "https://127.0.0.1/a", "https://www.pokemon.cn/a\nx"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                mod.official_url(url)
        self.assertEqual(mod.official_url(IMAGE + "?auth_key=published#fragment"),
                         IMAGE + "?auth_key=published")
        self.assertEqual(mod.canonical(IMAGE + "?auth_key=published"), IMAGE)

    def test_parser_prefers_original_and_lazy_largest_images_and_ignores_navigation(self):
        parser = mod.PageImages(PAGE)
        parser.feed(f'''<img src="{IMAGE}/navigation.png"><article>
          <a href="{IMAGE}?auth_key=original"><img src="/small.png"></a>
          <img data-src="{IMAGE}/lazy.jpg" src="/placeholder.png">
          <img srcset="{IMAGE}/1.png 100w, {IMAGE}/2.png 868w">
          <img width="64" src="{IMAGE}/icon.png">
          <img src="https://example.com/nonofficial.png"></article>''')
        self.assertEqual(parser.images(), [IMAGE + "?auth_key=original",
                                         IMAGE + "/lazy.jpg", IMAGE + "/2.png"])

    def test_gallery_does_not_use_wiki_filename_or_unpublished_152(self):
        plain = "||".join(f'"{number:03}"===a' for number in range(1, 13))
        script = (f'Array.from({{length:151}});{plain};'
                  '"https://special.pokemon.cn/151/img/big/151_".concat(e,".png");'
                  '"https://special.pokemon.cn/151/img/big/151_".concat(e,1===a?".png":2===a?"a.png":"b.png");'
                  'i.show_big=function(e);i.show_big("172");')
        urls = mod.gallery_urls(script)
        self.assertIn(mod.CAMPAIGN + "img/big/151_172.png", urls)
        self.assertIn(mod.CAMPAIGN + "img/big/151_151b.png", urls)
        self.assertNotIn(mod.CAMPAIGN + "img/big/151_001a.png", urls)
        self.assertNotIn(mod.CAMPAIGN + "img/big/151_152.png", urls)
        with self.assertRaises(ValueError):
            mod.gallery_urls(script.replace("length:151", "length:152"))

    def test_official_network_obeys_gap_rate_and_fixed_user_agent_without_robots(self):
        net, opener = self.network([Response(PICTURE, "image/png"), Response(PICTURE, "image/png")])
        self.assertEqual(net.fetch(IMAGE, "image"), PICTURE)
        first_finished = self.clock.time()
        self.assertEqual(net.fetch(IMAGE, "image"), PICTURE)
        self.assertEqual(len(opener.calls), 2)
        first, second = opener.calls
        self.assertEqual([first[0], second[0]], [IMAGE, IMAGE])
        self.assertGreaterEqual(second[1] - first_finished, mod.GAP)
        for call in opener.calls:
            self.assertEqual(call[2]["User-agent"], mod.USER_AGENT)
            self.assertEqual(call[2]["Accept-encoding"], "identity")
        self.assertAlmostEqual(self.clock.now - second[1], len(PICTURE) / mod.RATE, places=8)
        self.assertNotIn("robots", mod.read_json(self.output / "official-network.json"))

    def test_pages_scripts_and_images_are_requested_directly_without_robots(self):
        script = mod.CAMPAIGN_SCRIPT
        net, opener = self.network([
            Response(b"<article></article>", "text/html"),
            Response(b"public script", "application/javascript"),
            Response(PICTURE, "image/png"),
        ])
        for url, kind in ((PAGE, "page"), (script, "script"), (IMAGE, "image")):
            net.fetch(url, kind)
        self.assertEqual([call[0] for call in opener.calls], [PAGE, script, IMAGE])
        self.assertEqual(net.last_url, IMAGE)
        self.assertTrue(all(b[1] - a[1] >= mod.GAP for a, b in zip(opener.calls, opener.calls[1:])))

    def test_two_image_batch_downloads_without_robots_and_keeps_remaining_jobs_pending(self):
        images = [IMAGE + f"/{index}.png" for index in range(3)]
        html = "<article>" + "".join(f'<img src="{url}">' for url in images) + "</article>"
        net, opener = self.network([
            Response(html.encode(), "text/html"),
            Response(PICTURE, "image/png"), Response(PICTURE, "image/png"),
        ])
        runner = mod.Runner(manifest(), self.output, net)
        with redirect_stdout(io.StringIO()):
            runner.download(limit=2, library=self.library)
        self.assertEqual([call[0] for call in opener.calls], [PAGE, *images[:2]])
        self.assertEqual(runner.state["status"], "paused_batch_limit")
        self.assertEqual([runner.state["jobs"][url]["status"] for url in images], ["done", "done", "pending"])
        self.assertEqual((self.library / "zh-Hans/151C/001_151/image.png").read_bytes(), PICTURE)

    def test_legacy_robots_cache_is_not_read_or_refreshed(self):
        for index, cache in enumerate((
            None,
            {"https://image.pokemon.com.cn": {"at": 0, "text": "User-agent: *\nDisallow: /"}},
            {"https://image.pokemon.com.cn": {"at": self.clock.time(), "text": "Access denied"}},
        )):
            with self.subTest(cache=cache):
                self.output = self.root / str(index)
                atomic_json(self.output / "official-network.json", {
                    "source": "official", "last_finished": self.clock.time(), "robots": cache,
                })
                net, opener = self.network([Response(PICTURE, "image/png")])
                self.assertEqual(net.fetch(IMAGE, "image"), PICTURE)
                self.assertEqual([call[0] for call in opener.calls], [IMAGE])
                self.assertEqual(mod.read_json(self.output / "official-network.json")["robots"], cache)

    def test_removing_robots_checks_does_not_clear_existing_stop_records(self):
        for index, reason in enumerate(("HTTP 403", "Official robots.txt disallows the resource")):
            with self.subTest(reason=reason):
                self.output = self.root / str(index)
                atomic_json(self.output / "official-network.json", {
                    "source": "official", "last_finished": self.clock.time(),
                    "access_block": {"reason": reason, "url": PAGE, "at": self.clock.time()},
                })
                before = (self.output / "official-network.json").read_bytes()
                net, opener = self.network([])
                with self.assertRaises(mod.OfficialStopped):
                    net.fetch(IMAGE, "image")
                self.assertFalse(opener.calls)
                self.assertEqual((self.output / "official-network.json").read_bytes(), before)

    def test_404_is_still_an_error_without_extra_policy_requests(self):
        error = urllib.error.HTTPError(IMAGE, 404, "missing", {}, None)
        net, opener = self.network([error, Response(PICTURE, "image/png")])
        with self.assertRaises(urllib.error.HTTPError):
            net.fetch(IMAGE, "image")
        first_finished = self.clock.time()
        self.assertEqual(net.fetch(IMAGE, "image"), PICTURE)
        self.assertEqual([call[0] for call in opener.calls], [IMAGE, IMAGE])
        self.assertGreaterEqual(opener.calls[1][1] - first_finished, mod.GAP)

    def test_401_403_429_are_persisted_without_signed_queries_or_retry(self):
        for code in (401, 403, 429):
            with self.subTest(code=code):
                self.output = self.root / str(code)
                url = IMAGE + "?auth_key=private-query"
                net, opener = self.network([urllib.error.HTTPError(url, code, "secret body", {}, None)])
                with self.assertRaisesRegex(mod.OfficialStopped, f"HTTP {code}"):
                    net.fetch(url, "image")
                with self.assertRaises(mod.OfficialStopped):
                    net.fetch(url, "image")
                state = (self.output / "official-network.json").read_text()
                self.assertNotIn("private-query", state)
                self.assertNotIn("secret body", state)
                reopened = mod.OfficialNetwork(self.output, opener=opener,
                                              clock=self.clock.time, sleep=self.clock.sleep)
                with self.assertRaises(mod.OfficialStopped):
                    reopened.fetch(url, "image")
                self.assertEqual(len(opener.calls), 1)

    def test_external_redirect_is_never_requested(self):
        redirect = urllib.error.HTTPError(PAGE, 302, "redirect", {"Location": "https://example.com/a"}, None)
        net, opener = self.network([redirect])
        with self.assertRaises(ValueError):
            net.fetch(PAGE, "page")
        self.assertEqual(len(opener.calls), 1)

    def test_official_redirects_preserve_gap_without_requesting_robots_on_either_origin(self):
        redirect = urllib.error.HTTPError(PAGE, 302, "redirect", {"Location": IMAGE}, None)
        net, opener = self.network([redirect, Response(PICTURE, "image/png")])
        self.assertEqual(net.fetch(PAGE, "page"), PICTURE)
        self.assertEqual([call[0] for call in opener.calls], [PAGE, IMAGE])
        self.assertGreaterEqual(opener.calls[1][1] - opener.calls[0][1], mod.GAP)

    def test_redirected_page_resolves_relative_images_against_final_url(self):
        final = "https://www.pokemon.cn/tcg/product/new/index.html"
        image = "https://www.pokemon.cn/tcg/product/new/card.png"
        redirect = urllib.error.HTTPError(PAGE, 302, "redirect", {"Location": final}, None)
        net, opener = self.network([
            redirect, Response(b'<article><img src="card.png"></article>', "text/html"),
            Response(PICTURE, "image/png"),
        ])
        runner = mod.Runner(manifest(), self.output, net)
        with redirect_stdout(io.StringIO()):
            runner.download()
        self.assertEqual(opener.calls[-1][0], image)
        receipt = next(iter(mod.read_json(self.output / "official-receipts.json")["files"].values()))
        self.assertEqual(receipt["source_url"], image)
        self.assertEqual(set(receipt["source_pages"]), {PAGE, final})

    def test_redirected_image_receipt_uses_final_url_without_signature(self):
        final = IMAGE + "/full.png?auth_key=redirect-secret"
        redirect = urllib.error.HTTPError(IMAGE, 302, "redirect", {"Location": final}, None)
        net, opener = self.network([
            Response(f'<article><img src="{IMAGE}"></article>'.encode(), "text/html"),
            redirect, Response(PICTURE, "image/png"),
        ])
        runner = mod.Runner(manifest(), self.output, net)
        with redirect_stdout(io.StringIO()):
            runner.download()
        self.assertEqual(opener.calls[-1][0], final)
        receipt_text = (self.output / "official-receipts.json").read_text()
        receipt = next(iter(json.loads(receipt_text)["files"].values()))
        self.assertEqual(receipt["source_url"], mod.canonical(final))
        self.assertNotIn("redirect-secret", receipt_text)

    def test_non_image_encoded_oversized_truncated_responses_are_not_accepted(self):
        for response in (Response(b"<html>challenge</html>", "text/html"),
                         Response(PICTURE, "image/png", {"Content-Encoding": "gzip"}),
                         Response(PICTURE, "image/png", {"Content-Length": "25000001"}),
                         Response(PICTURE, "image/png", {"Content-Length": str(len(PICTURE) + 1)})):
            self.output = self.root / str(id(response))
            net, opener = self.network([response])
            with self.assertRaises(ValueError):
                net.fetch(IMAGE, "image")
            self.assertEqual([call[0] for call in opener.calls], [IMAGE])

    def test_crash_restores_conservative_gap_without_clearing_blocks(self):
        atomic_json(self.output / "official-network.json", {
            "source": "official", "last_finished": 0, "in_flight": True,
        })
        net, opener = self.network([Response(b"")])
        net.fetch(PAGE, "page")
        self.assertGreaterEqual(opener.calls[0][1], 1010)

    def test_exact_bytes_publish_but_candidates_never_get_guessed_identities(self):
        runner, net = self.run_download()
        self.assertEqual(runner.summary()["exact_original_targets"], 1)
        picture = self.library / "zh-Hans/151C/001_151/image.png"
        self.assertEqual(picture.read_bytes(), PICTURE)
        self.assertTrue(all("52poke.com" not in url for url, _ in net.calls))
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            runner.download(library=self.library)
        other = io.BytesIO()
        Image.new("RGB", (520, 726), "blue").save(other, "PNG")
        self.output, self.library = self.root / "other", self.root / "other-library"
        runner, _ = self.run_download(other.getvalue())
        self.assertEqual(runner.summary()["verified_candidate_files"], 1)
        self.assertEqual(runner.summary()["exact_original_targets"], 0)
        self.assertFalse(self.library.exists())

    def test_exact_bytes_requiring_semantic_review_remain_unpublished(self):
        runner, _ = self.run_download(manifest=manifest(review=True))
        self.assertEqual(runner.summary()["exact_original_targets"], 1)
        self.assertFalse(list(self.library.rglob("image.png")))
        self.assertTrue(list((self.library / "_review/downloads").glob("*.json")))

    def test_changed_or_missing_cache_is_not_silently_redownloaded(self):
        runner, net = self.run_download()
        files = list((self.output / "files").glob("*"))
        files[0].write_bytes(b"changed")
        with self.assertRaises(ValueError):
            runner.download()
        self.assertEqual(len(net.calls), 2)
        files[0].unlink()
        with self.assertRaises(FileNotFoundError):
            runner.download()

    def test_image_limit_counts_failed_attempts_and_restart_skips_errors(self):
        net = FakeNetwork({PAGE: f'<article><img src="{IMAGE}"><img src="{IMAGE}/z.png"></article>'.encode(),
                           IMAGE: urllib.error.HTTPError(IMAGE, 404, "missing", {}, None),
                           IMAGE + "/z.png": PICTURE})
        runner = mod.Runner(manifest(), self.output, net)
        with redirect_stdout(io.StringIO()):
            runner.download(limit=1)
        self.assertEqual(len(net.calls), 2)
        self.assertEqual(runner.state["status"], "paused_batch_limit")
        reopened = mod.Runner(manifest(), self.output, net)
        with redirect_stdout(io.StringIO()):
            reopened.download(limit=1)
        self.assertEqual([url for url, _ in net.calls].count(IMAGE), 1)
        self.assertEqual(reopened.summary()["verified_candidate_files"], 1)

    def test_duplicates_reuse_one_content_file_and_receipts_do_not_leak_queries(self):
        signed = IMAGE + "?auth_key=not-public-output"
        net = FakeNetwork({PAGE: f'<article><img src="{signed}"></article>'.encode(),
                           signed: PICTURE})
        runner = mod.Runner(manifest(), self.output, net)
        with redirect_stdout(io.StringIO()):
            runner.download()
        public = (self.output / "official-receipts.json").read_text()
        self.assertNotIn("not-public-output", public)
        self.assertIn("not-public-output", (self.output / "official-queue.json").read_text())
        job = {"source_pages": [PAGE], "status": "downloading"}
        runner.accept_image(IMAGE + "/duplicate.png", job, PICTURE)
        self.assertEqual(len(list((self.output / "files").glob("*.png"))), 1)

    def test_changed_manifest_does_not_reset_queue_or_source_block(self):
        runner, _ = self.run_download()
        before = (self.output / "official-queue.json").read_bytes()
        value = manifest()
        value["targets"][0]["uses"][0]["page_id"] = 999
        with self.assertRaises(ValueError):
            mod.Runner(value, self.output)
        self.assertEqual((self.output / "official-queue.json").read_bytes(), before)

    def test_unfinished_request_is_not_blindly_reissued_after_restart(self):
        runner = mod.Runner(manifest(), self.output, FakeNetwork({}))
        runner.state["jobs"][PAGE]["status"] = "downloading"
        runner.save()
        with redirect_stdout(io.StringIO()):
            runner.download()
        self.assertEqual(runner.state["jobs"][PAGE]["status"], "error")
        self.assertFalse(runner.network.calls)

    def test_official_permission_is_required_and_old_source_remains_default(self):
        path = self.root / "manifest.json"
        atomic_json(path, manifest())
        args = ["portable_downloader.py", "--manifest", str(path), "--output", str(self.output)]
        with patch("sys.argv", [*args, "--source", "official", "download"]), \
                self.assertRaises(portable.StopDownload):
            portable.main()
        with patch("sys.argv", [*args, "status"]), redirect_stdout(io.StringIO()) as text:
            portable.main()
        self.assertIn('"with_original_url": 1', text.getvalue())
        self.assertFalse(self.output.exists())

    def test_pack_and_offline_verify_import_without_private_network_state(self):
        self.run_download()
        path, archive = self.root / "manifest.json", self.root / "result.zip"
        atomic_json(path, manifest())
        args = ["portable_downloader.py", "--source", "official", "--manifest", str(path),
                "--output", str(self.output), "--library", str(self.library)]
        with patch("sys.argv", [*args, "pack-results", "--zip", str(archive)]), \
                patch("urllib.request.build_opener", side_effect=AssertionError("network")), \
                redirect_stdout(io.StringIO()):
            portable.main()
        incoming, library = self.root / "incoming", self.root / "master"
        with zipfile.ZipFile(archive) as bundle:
            self.assertNotIn("official-queue.json", bundle.namelist())
            self.assertNotIn("official-network.json", bundle.namelist())
            bundle.extractall(incoming)
        args = ["portable_downloader.py", "--source", "official",
                "--manifest", str(incoming / "manifest.json"), "--output", str(incoming),
                "--library", str(library), "verify"]
        with patch("sys.argv", args), redirect_stdout(io.StringIO()), \
                patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            portable.main()
        self.assertEqual((library / "zh-Hans/151C/001_151/image.png").read_bytes(), PICTURE)

    def test_result_manifest_does_not_expose_declared_page_signature(self):
        value = manifest()
        signed_page = PAGE + "?auth_key=temporary-secret"
        value["targets"][0]["declared_source_urls"] = [signed_page]
        net = FakeNetwork({signed_page: f'<article><img src="{IMAGE}"></article>'.encode(), IMAGE: PICTURE})
        with redirect_stdout(io.StringIO()):
            mod.Runner(value, self.output, net).download()
        args = type("Args", (), {
            "command": "pack-results", "output": self.output,
            "library": self.library, "zip": self.root / "results.zip",
        })()
        mod.run(args, value)
        with zipfile.ZipFile(args.zip) as bundle:
            self.assertNotIn(b"temporary-secret", b"".join(bundle.read(name) for name in bundle.namelist()))

    def test_results_only_or_incomplete_migration_cannot_reset_network_policy(self):
        self.run_download()
        # The fake transport has no real network-state file, just like a
        # migration which forgot to copy it. Neither case may start requests.
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(mod.OfficialStopped, "state is missing"):
                mod.Runner(manifest(), self.output).download()
            (self.output / "official-queue.json").unlink()
            with self.assertRaisesRegex(mod.OfficialStopped, "state is missing"):
                mod.Runner(manifest(), self.output).download()

    def test_missing_queue_without_receipts_cannot_recreate_network_jobs(self):
        for artifact in ("official-network.json", "files/interrupted.png.part"):
            with self.subTest(artifact=artifact):
                self.output = self.root / artifact.split("/")[0]
                path = self.output / artifact
                atomic_json(path, {"source": "official", "last_finished": 1000})
                before = path.read_bytes()
                with patch("urllib.request.build_opener", side_effect=AssertionError("network")):
                    with self.assertRaisesRegex(mod.OfficialStopped, "state is missing"):
                        mod.Runner(manifest(), self.output).download()
                self.assertFalse((self.output / "official-queue.json").exists())
                self.assertEqual(path.read_bytes(), before)

    def test_missing_network_state_cannot_hide_behind_zero_task_count(self):
        runner = mod.Runner(manifest(), self.output)
        runner.state["jobs"][PAGE].update(status="error", attempts=1)
        runner.save()
        before = runner.path.read_bytes()
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(mod.OfficialStopped, "state is missing"):
                runner.download()
        self.assertEqual(runner.path.read_bytes(), before)

    def test_result_zip_cannot_overwrite_state_manifest_or_library(self):
        self.run_download()
        manifest_path = self.root / "manifest.zip"
        atomic_json(manifest_path, manifest())
        atomic_json(self.output / "official-network.json", {"source": "official", "access_block": True})
        (self.output / ".download.lock").write_bytes(b"lock")
        cache = next((self.output / "files").glob("*.png"))
        destinations = [
            self.output / name for name in (
                "official-queue.json", "official-network.json", "official-receipts.json", ".download.lock",
            )
        ] + [manifest_path, cache, self.library / "result.zip", self.output / "files/result.zip"]
        alias = self.root / "state-alias.zip"
        try:
            alias.symlink_to(self.output / "official-network.json")
        except (OSError, NotImplementedError):
            pass  # Windows may require extra permission to create symlinks.
        else:
            destinations.append(alias)
        for destination in destinations:
            with self.subTest(destination=destination):
                before = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
                args = type("Args", (), {
                    "command": "pack-results", "output": self.output, "library": self.library,
                    "manifest": manifest_path, "zip": destination,
                })()
                with self.assertRaises(ValueError):
                    mod.run(args, manifest())
                self.assertEqual({path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}, before)

    def test_result_zip_uses_fresh_temp_file_and_preserves_existing_output_on_failure(self):
        self.run_download()
        archive = self.root / "result.zip"
        stale = self.root / "result.zip.tmp"
        state = self.output / "official-queue.json"
        try:
            stale.symlink_to(state)
        except (OSError, NotImplementedError):
            self.skipTest("Creating symlinks is unavailable in this environment.")
        before = state.read_bytes()
        args = type("Args", (), {
            "command": "pack-results", "output": self.output,
            "library": self.library, "zip": archive,
        })()
        mod.run(args, manifest())
        self.assertTrue(stale.is_symlink())
        self.assertEqual(state.read_bytes(), before)
        previous = archive.read_bytes()
        with patch.object(zipfile.ZipFile, "write", side_effect=OSError("disk full")), self.assertRaises(OSError):
            mod.run(args, manifest())
        self.assertEqual(archive.read_bytes(), previous)
        self.assertEqual(state.read_bytes(), before)
        self.assertFalse(list(self.root.glob(".official-results.*.tmp")))

    def test_library_failure_keeps_completed_bytes_for_offline_publication_recovery(self):
        net = FakeNetwork({PAGE: f'<article><img src="{IMAGE}"></article>'.encode(), IMAGE: PICTURE})
        runner = mod.Runner(manifest(), self.output, net)
        with patch.object(mod, "publish_download", side_effect=OSError("library unavailable")), \
                redirect_stdout(io.StringIO()), self.assertRaises(OSError):
            runner.download(library=self.library)
        self.assertEqual(runner.state["status"], "paused")
        self.assertEqual(runner.state["jobs"][IMAGE]["status"], "done")
        with redirect_stdout(io.StringIO()):
            runner.download(library=self.library)
        self.assertEqual(len(net.calls), 2)
        self.assertEqual((self.library / "zh-Hans/151C/001_151/image.png").read_bytes(), PICTURE)


if __name__ == "__main__":
    unittest.main()
