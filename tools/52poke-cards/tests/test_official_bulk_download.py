from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

import official_bulk_download as bulk
from card_storage import atomic_json

PAGE = "https://www.pokemon.cn/tcg/product/example.html"
IMAGE = "https://image.pokemon.com.cn/example.png"


def manifest(pages=(PAGE,)):
    return {"schema_version": 1, "targets": [{
        "wiki_filename": "Example.png", "declared_source_urls": list(pages),
        "uses": [{"language": "zh-Hans"}], "latest_file_metadata": None,
    }]}


def picture(path, size=(8, 8), color="green"):
    Image.new("RGB", size, color).save(path, format="PNG")
    return path


class BulkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "archive"

    def archive(self, value=None):
        result = bulk.Archive(self.output, value or manifest())
        self.addCleanup(result.db.close)
        return result

    def test_all_images_include_small_noncard_lazy_original_and_srcset(self):
        page = bulk.Page(PAGE)
        page.feed(f"""
          <img width="16" src="{IMAGE}">
          <a href="/full.png"><img src="/small.png" data-src="/lazy.png"
             srcset="/one.png 1x, /two.png 2x"></a>
          <source data-srcset="/three.webp 100w, /four.webp 200w">
          <div style="background-image:url('/background.jpg')"></div>
          <video poster="/poster.jpg"></video>
          <link rel="icon" href="/favicon.ico">
          <link rel="stylesheet" href="/style.css">
        """)
        expected = {IMAGE, *("https://www.pokemon.cn" + path for path in (
            "/full.png", "/small.png", "/lazy.png", "/one.png", "/two.png",
            "/three.webp", "/four.webp", "/background.jpg", "/poster.jpg", "/favicon.ico",
        ))}
        self.assertEqual(page.images, expected)
        self.assertEqual(page.styles, {"https://www.pokemon.cn/style.css"})

    def test_category_discovers_actual_pagination_and_only_main_article_links(self):
        page = bulk.Page(bulk.CATEGORY)
        page.feed(f"""
          <a href="/tcg/product/not-in-category.html">Outside main</a>
          <main><a href="{PAGE}">Product</a>
          <a href="/tcg/old.html">Old product URL</a>
          <a href="/category/tcg/product/p/12">12</a>
          <a href="/category/tcg/product/p/2">Next</a>
          <div>Page 1/12</div></main>
          <a href="/tcg/product/footer.html">Footer</a>
        """)
        self.assertEqual(page.articles, {PAGE, "https://www.pokemon.cn/tcg/old.html"})
        self.assertEqual(page.numbering, (1, 12))
        self.assertEqual({bulk.category_number(url) for url in page.pagination}, {2, 12})

    def test_category_key_and_content_queries_are_not_confused(self):
        self.assertEqual(bulk.document_key(bulk.CATEGORY + "?paged=2"), bulk.CATEGORY + "/p/2")
        self.assertEqual(bulk.document_key(bulk.CATEGORY + "/p/1/"), bulk.CATEGORY)
        self.assertIsNone(bulk.category_number("https://www.pokemon.cn.evil.test/category/tcg/product"))
        self.assertEqual(bulk.image_key(IMAGE + "?auth_key=one"), bulk.image_key(IMAGE + "?auth_key=two"))
        self.assertNotEqual(bulk.image_key(IMAGE + "?width=100"), bulk.image_key(IMAGE + "?width=200"))

    def test_nonofficial_images_are_recorded_but_never_queued(self):
        page = bulk.Page(PAGE)
        page.feed('<img src="https://evil.test/a.png"><img src="http://www.pokemon.cn/insecure.png">')
        self.assertFalse(page.images)
        self.assertEqual(len(page.external), 2)

    def test_source_merge_is_a_union_and_preserves_manifest(self):
        common = "https://www.pokemon.cn/tcg/product/common.html"
        old = "https://www.pokemon.cn/tcg/event/old.html"
        new = "https://www.pokemon.cn/tcg/product/new.html"
        value = manifest((old, common))
        before = json.dumps(value, sort_keys=True)
        archive = self.archive(value)
        archive.seed()
        path = self.root / "category.html"
        path.write_text(f'<main><a href="{common}">A</a><a href="{new}">B</a>Page 1/1</main>')
        row = archive.db.execute("SELECT * FROM jobs WHERE kind='category'").fetchone()
        archive.parse(row, path, bulk.CATEGORY)
        summary = archive.summary()
        self.assertEqual(summary["original_source_pages"], 2)
        self.assertEqual(summary["category_product_articles"], 2)
        self.assertEqual(summary["source_category_article_overlap"], 1)
        self.assertEqual(summary["merged_unique_source_pages"], 3)
        self.assertTrue(summary["category_pagination_complete"])
        self.assertEqual(json.dumps(value, sort_keys=True), before)

    def test_committed_source_list_adds_pages_without_replacing_original_sources(self):
        archive = self.archive()
        extra = "https://www.pokemon.cn/tcg/product/new.html"
        archive.seed({
            "schema_version": 1, "merge_operation": "union_not_replacement",
            "original_manifest_struct_sha256": archive.manifest_hash,
            "pages": [{"url": PAGE}, {"url": extra}, {"url": extra}],
        })
        rows = archive.db.execute("SELECT url FROM jobs WHERE kind='page'").fetchall()
        self.assertEqual({row[0] for row in rows}, {PAGE, extra})
        self.assertEqual(len(rows), 2)
        with self.assertRaises(ValueError):
            archive.seed({"schema_version": 1, "merge_operation": "replace"})

    def test_exported_download_list_is_portable_and_separates_images_from_sources(self):
        archive = self.archive()
        archive.seed()
        archive.add(IMAGE + "?auth_key=private-secret", "image", PAGE)
        archive.add("https://www.pokemon.cn/style.css", "style", PAGE)
        destination = self.root / "published"
        self.assertEqual(archive.export_download_list(destination), {"source_pages": 1, "image_references": 1})
        sources = json.loads((destination / "official-bulk-sources.json").read_text())
        self.assertEqual(sources["pages"], [{"url": PAGE, "origins": ["original_manifest"]}])
        images = json.loads((destination / "official-bulk-images.jsonl").read_text())
        self.assertEqual(images["url"], IMAGE)
        self.assertNotIn("private-secret", repr(sources) + repr(images))
        self.assertNotIn(str(self.root), repr(sources) + repr(images))
        other = bulk.Archive(self.root / "fresh", manifest())
        self.addCleanup(other.db.close)
        other.seed(sources)
        self.assertEqual(other.db.execute("SELECT COUNT(*) FROM jobs WHERE kind='page'").fetchone()[0], 1)

    def test_exported_source_catalog_does_not_mix_styles_and_category_into_union(self):
        archive = self.archive()
        archive.seed()
        archive.add("https://www.pokemon.cn/style.css", "style", PAGE)
        archive.export_catalog()
        catalog = json.loads((self.output / "merged-source-pages.json").read_text())
        self.assertEqual([row["url"] for row in catalog["pages"]], [PAGE])
        self.assertEqual(len(catalog["category_pages"]), 1)
        self.assertEqual(len(catalog["supporting_resources"]), 1)

    def test_image_urls_and_origins_deduplicate_without_losing_latest_signature(self):
        archive = self.archive()
        first = archive.add(IMAGE + "?auth_key=old", "image", PAGE)
        second = archive.add(IMAGE + "?auth_key=new", "image", bulk.CAMPAIGN)
        self.assertEqual(first, second)
        row = archive.db.execute("SELECT * FROM jobs").fetchone()
        self.assertEqual(row["url"], IMAGE + "?auth_key=new")
        self.assertEqual(set(json.loads(row["origins"])), {PAGE, bulk.CAMPAIGN})

    def test_missing_pagination_page_cannot_be_called_complete(self):
        archive = self.archive()
        archive.db.execute("INSERT INTO category_pages VALUES (1,3,?,?)", (bulk.CATEGORY, json.dumps([PAGE])))
        archive.db.execute("INSERT INTO category_pages VALUES (3,3,?,?)", (bulk.CATEGORY + "/p/3", json.dumps([PAGE])))
        self.assertFalse(archive.summary()["category_pagination_complete"])
        self.assertFalse(archive.summary()["download_complete"])

    def test_terminal_missing_sources_are_not_reported_as_download_complete(self):
        archive = self.archive()
        archive.seed()
        for row in archive.db.execute("SELECT * FROM jobs").fetchall():
            archive.finish(row, "missing", code=404)
        archive.db.execute("INSERT INTO category_pages VALUES (1,1,?,?)", (bulk.CATEGORY, json.dumps([PAGE])))
        archive.db.commit()
        self.assertTrue(archive.summary()["all_known_jobs_terminal"])
        self.assertFalse(archive.summary()["download_complete"])

    def test_images_with_different_urls_share_one_content_file(self):
        archive = self.archive()
        path = picture(self.root / "square.png")
        first = archive.keep_image(path, source_url=IMAGE)
        second = archive.keep_image(path, source_url=IMAGE + "/duplicate.png")
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(len(list((self.output / "images").iterdir())), 1)
        self.assertEqual(first["identity_status"], "raw_image_no_printing_identity_assigned")
        self.assertFalse((self.output / "library").exists())

    def test_verified_local_image_skips_network_and_is_independently_copied(self):
        archive = self.archive()
        path = picture(self.root / "cached.png")
        info = bulk.validate_image(path)
        archive.db.execute("INSERT INTO local_images VALUES (?,?,?)", (bulk.image_key(IMAGE), str(path), info["sha256"]))
        key = archive.add(IMAGE + "?auth_key=published", "image", PAGE)
        row = archive.db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
        self.assertTrue(archive.skip_local(row))
        row = archive.db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
        self.assertEqual(row["status"], "reused")
        result = json.loads(row["result"])
        self.assertNotIn("auth_key", json.dumps(result))
        self.assertFalse(Path(result["local_file"]).samefile(path))
        self.assertEqual(path.read_bytes(), Path(result["local_file"]).read_bytes())

    def test_preflight_reuses_local_images_even_after_exhausted_transport_retries(self):
        archive = self.archive()
        path = picture(self.root / "cached.png")
        info = bulk.validate_image(path)
        archive.db.execute("INSERT INTO local_images VALUES (?,?,?)", (bulk.image_key(IMAGE), str(path), info["sha256"]))
        archive.add(IMAGE, "image", PAGE)
        archive.db.execute("UPDATE jobs SET status='error',attempts=3")
        archive.db.commit()
        archive.reuse_cached_images()
        self.assertEqual(archive.summary()["jobs"]["image"], {"reused": 1})

    def test_changed_archive_image_fails_offline_verify(self):
        archive = self.archive()
        source = picture(self.root / "source.png")
        key = archive.add(IMAGE, "image", PAGE)
        row = archive.db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
        record = archive.keep_image(source, source_url=IMAGE)
        archive.finish(row, "done", record)
        self.assertEqual(archive.verify()["verified_unique_images"], 1)
        Path(record["local_file"]).write_bytes(b"changed")
        with self.assertRaises((OSError, ValueError)):
            archive.verify()

    def test_svg_is_saved_and_html_is_not_accepted_as_an_image(self):
        svg = self.root / "image.svg"
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>')
        self.assertEqual(bulk.validate_image(svg)["suffix"], ".svg")
        html = self.root / "bad.png"
        html.write_text("<html>error</html>")
        with self.assertRaises((OSError, ValueError)):
            bulk.validate_image(html)
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" broken')
        with self.assertRaises(ValueError):
            bulk.validate_image(svg)

    def test_opening_status_does_not_requeue_live_work(self):
        archive = self.archive()
        key = archive.add(IMAGE, "image", PAGE)
        archive.db.execute("UPDATE jobs SET status='downloading',attempts=1 WHERE key=?", (key,))
        archive.db.commit()
        other = self.archive()
        self.assertEqual(other.summary()["jobs"]["image"]["downloading"], 1)
        archive.recover()
        self.assertEqual(archive.summary()["jobs"]["image"]["pending"], 1)

    def network(self, replies):
        calls = []
        def transport(url, kind):
            calls.append((url, kind))
            value = replies.pop(0)
            path = self.root / f"response-{len(calls)}.part"
            path.write_bytes(value.get("data", b"body"))
            return {"path": path, "headers": value.get("headers", {}), "code": value["code"], "mime": value.get("mime", "text/html")}
        network = bulk.Network(self.root / "policy", self.root / "scratch", transport=transport)
        network.successes = 200
        return network, calls

    def test_401_403_429_stop_persistently_and_never_clear_previous_block(self):
        for status in (401, 403, 429):
            with self.subTest(status=status):
                self.root = Path(self.temp.name) / str(status)
                self.root.mkdir()
                network, calls = self.network([{"code": status}])
                with self.assertRaises(bulk.Stopped):
                    network.fetch(IMAGE + "?auth_key=private", "image")
                self.assertEqual(len(calls), 1)
                state = json.loads(network.path.read_text())
                self.assertNotIn("private", json.dumps(state))
                self.assertFalse(state["in_flight"])
                with self.assertRaises(bulk.Stopped):
                    bulk.Network(self.root / "policy", self.root / "scratch", transport=lambda *_: self.fail("network"))

    def test_redirects_validate_every_hop_and_do_not_request_external_hosts(self):
        network, calls = self.network([{"code": 302, "headers": {"location": "https://evil.test/a.png"}}])
        with self.assertRaises(ValueError):
            network.fetch(PAGE, "page")
        self.assertEqual(calls, [(PAGE, "page")])
        self.assertFalse(json.loads(network.path.read_text())["in_flight"])

    def test_repeated_transport_failures_pause_host_persistently_without_rotating_identity(self):
        calls = []
        def failing(url, kind):
            calls.append(url)
            raise OSError("curl_exit_28_connection_timeout")
        network = bulk.Network(self.root / "policy", self.root / "scratch", transport=failing)
        network.max_rps = 1000
        network.successes = 200
        for _ in range(3):
            with self.assertRaises(OSError):
                network.fetch(IMAGE, "image")
        with self.assertRaises(bulk.HostUnavailable):
            network.fetch(IMAGE, "image")
        self.assertEqual(calls, [IMAGE] * 3)
        self.assertFalse(network.state.get("access_block"))
        network.check_host(PAGE)  # The webpage host is not the failed CDN host.
        restored = bulk.Network(self.root / "policy", self.root / "scratch", transport=failing)
        with self.assertRaises(bulk.HostUnavailable):
            restored.fetch(IMAGE, "image")
        self.assertEqual(len(calls), 3)

    def test_paused_host_is_deferred_without_network_requests(self):
        archive = self.archive()
        archive.add(IMAGE, "image", PAGE)
        network, calls = self.network([])
        network.state["transport_pauses"]["image.pokemon.com.cn"] = {"reason": "connection timeout"}
        with redirect_stdout(io.StringIO()):
            archive.run_phase(network, images=True)
        self.assertEqual(calls, [])
        self.assertEqual(archive.summary()["jobs"]["image"], {"deferred": 1})

    def test_official_redirect_uses_same_fixed_identity_transport_and_final_url(self):
        network, calls = self.network([
            {"code": 302, "headers": {"location": IMAGE}}, {"code": 200, "mime": "image/png"},
        ])
        response = network.fetch(PAGE, "page")
        self.assertEqual(response["url"], IMAGE)
        self.assertEqual(calls, [(PAGE, "page"), (IMAGE, "page")])
        self.assertEqual(network.request_count, 2)
        self.assertFalse(json.loads(network.path.read_text())["in_flight"])

    def test_public_catalogs_do_not_expose_temporary_signatures(self):
        archive = self.archive()
        key = archive.add(IMAGE + "?auth_key=private-secret", "image", PAGE)
        row = archive.db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
        record = archive.keep_image(picture(self.root / "image.png"), source_url=row["url"])
        archive.finish(row, "done", record)
        archive.export_catalog()
        self.assertNotIn("private-secret", (self.output / "images.jsonl").read_text())
        self.assertIn("private-secret", archive.db.execute("SELECT url FROM jobs").fetchone()[0])

    def test_failed_image_response_is_retained_without_counting_as_verified(self):
        archive = self.archive()
        key = archive.add(IMAGE + "?auth_key=private-secret", "image", PAGE)
        archive.db.execute("UPDATE jobs SET status='downloading',attempts=1 WHERE key=?", (key,))
        archive.db.commit()
        row = archive.db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
        path = self.root / "bad-response.part"
        data = b"<html>not an image</html>"
        path.write_bytes(data)
        response = {"path": path, "url": row["url"], "code": 200, "mime": "text/html"}
        with self.assertRaisesRegex(ValueError, "Response is not an image") as caught:
            archive.process(row, response)
        archive.failure(row, caught.exception)
        failed = archive.db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
        record = json.loads(failed["result"])
        self.assertEqual(failed["status"], "error")
        self.assertEqual(failed["http_status"], 200)
        self.assertEqual(failed["attempts"], 1)
        self.assertEqual(failed["error"], "ValueError:Response is not an image.")
        self.assertEqual(Path(record["local_file"]).read_bytes(), data)
        self.assertEqual(bulk.digest(Path(record["local_file"])), record["sha256"])
        self.assertFalse(path.exists())
        self.assertEqual(archive.verify()["verified_unique_images"], 0)
        archive.export_catalog()
        errors = (self.output / "unavailable-or-unfinished.json").read_text()
        self.assertNotIn("private-secret", errors)
        self.assertEqual(json.loads(errors)[0]["unverified_response"]["verification_status"], "failed")

    def test_failure_diagnostics_redact_signed_urls_and_standalone_tokens(self):
        archive = self.archive()
        key = archive.add(IMAGE, "image", PAGE)
        row = archive.db.execute("SELECT * FROM jobs WHERE key=?", (key,)).fetchone()
        archive.failure(row, ValueError(
            "Decode failed at " + IMAGE + "?auth_key=private-secret; auth_key=another-secret"
        ))
        error = archive.db.execute("SELECT error FROM jobs WHERE key=?", (key,)).fetchone()[0]
        self.assertIn("Decode failed", error)
        self.assertNotIn("private-secret", error)
        self.assertNotIn("another-secret", error)
        self.assertNotIn(IMAGE, error)

    def test_original_manifest_mismatch_is_not_silently_reset(self):
        self.archive()
        with self.assertRaises(ValueError):
            self.archive(manifest(("https://www.pokemon.cn/tcg/product/other.html",)))


if __name__ == "__main__":
    unittest.main()
