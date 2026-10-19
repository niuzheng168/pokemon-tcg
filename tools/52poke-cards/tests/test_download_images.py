from datetime import datetime
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from zoneinfo import ZoneInfo

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import download_images as mod


PAGE = "https://asia.pokemon-card.com/tw/card-search/detail/12758/"
IMAGE = "https://asia.pokemon-card.com/tw/card-img/tw00012758.png"


def png_bytes():
    data = io.BytesIO()
    Image.new("RGB", (8, 12), (40, 120, 30)).save(data, "PNG")
    return data.getvalue()


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {"Content-Type": "image/png", "Content-Length": str(len(data))}


class FakeNetwork:
    def __init__(self, data=None):
        self.data = png_bytes() if data is None else data
        self.calls = []
        self.permitted_calls = []

    def permitted(self, url):
        self.permitted_calls.append(url)

    def open(self, url, headers):
        self.calls.append((url, headers))
        return Response(self.data)

    def finished(self):
        pass


class ImageTests(unittest.TestCase):
    def test_simplified_filter_never_uses_traditional_header_image(self):
        card = {
            "page_id": 1, "title": "火箭队的团珠蛛（SV10）", "revision_id": 2,
            "images": [{"file_name": "SV10F008.png", "parameter": "image", "source_template_index": 0}],
            "printings": [
                {"language": "zh-Hans", "set_code": "CSV10C", "number": "018/222",
                 "image": None, "source_template_index": 1},
                {"language": "zh-Hant", "set_code": "SV10F", "number": "008/098",
                 "image": {"file_name": "SV10F008.png"}, "source_template_index": 2},
            ],
        }
        self.assertEqual(mod.card_image_uses(card, "zh-Hans"), ([], 1))
        traditional, missing = mod.card_image_uses(card, "zh-Hant")
        self.assertEqual(traditional[0][0], "SV10F008.png")
        self.assertEqual(missing, 0)
        self.assertEqual(len(mod.card_image_uses(card, "all")[0]), 1)

    def test_simplified_printing_identity_is_preserved(self):
        card = {
            "page_id": 1, "title": "示例卡", "revision_id": 2, "images": [],
            "printings": [
                {"language": "zh-Hans", "set_code": "CSV10C", "number": "018/222",
                 "image": {"file_name": "CSV10C018.png"}, "source_template_index": 1},
            ],
        }
        entries, missing = mod.card_image_uses(card, "zh-Hans")
        self.assertEqual(missing, 0)
        self.assertEqual(entries[0][0], "CSV10C018.png")
        self.assertEqual(entries[0][1]["number"], "018/222")
        self.assertEqual(entries[0][1]["language"], "zh-Hans")

    def test_tw_or_hk_source_cannot_satisfy_simplified_request(self):
        for page in (PAGE, PAGE.replace("/tw/", "/hk/")):
            self.assertFalse(mod.source_matches_language(page, "zh-Hans"))
            self.assertTrue(mod.source_matches_language(page, "zh-Hant"))
            self.assertTrue(mod.source_matches_language(page, "all"))

    def test_chinese_image_policy_keeps_each_printing_language(self):
        card = {
            "page_id": 1, "title": "示例卡", "revision_id": 2, "images": [],
            "printings": [
                {"language": "zh-Hans", "set_code": "CSV10C", "number": "018/222",
                 "image": None, "source_template_index": 1},
                {"language": "zh-Hant", "set_code": "SV10F", "number": "008/098",
                 "image": {"file_name": "SV10F008.png"}, "source_template_index": 2},
            ],
        }
        references, missing = mod.card_image_uses(card, "zh")
        self.assertEqual(missing, 1)
        self.assertEqual(len(references), 1)
        self.assertEqual(references[0][1]["language"], "zh-Hant")
        self.assertEqual(references[0][1]["number"], "008/098")
        self.assertTrue(mod.source_matches_language(PAGE, "zh"))
        self.assertFalse(mod.source_matches_language(PAGE, "zh-Hans"))

    def test_official_source_is_exact_and_https(self):
        self.assertEqual(mod.official_page(PAGE), PAGE)
        for url in (
            PAGE.replace("https", "http"), PAGE + "?redirect=x",
            PAGE.replace("asia.pokemon-card.com", "evil.example"),
            PAGE.replace("asia.pokemon-card.com", "user@asia.pokemon-card.com"),
            PAGE.replace("asia.pokemon-card.com", "asia.pokemon-card.com:bad"),
            "https://asia.pokemon-card.com/tw/card-search/",
        ):
            self.assertIsNone(mod.official_page(url))

    def test_only_explicit_source_template_counts(self):
        self.assertEqual(mod.declared_sources("{{来源|[" + PAGE + " 官方]}}"), [PAGE])
        self.assertEqual(mod.declared_sources("Other [" + PAGE + " link]"), [])
        self.assertEqual(mod.declared_sources("{{来源|[https://evil.example/x fake]}}"), [])

    def test_resolver_excludes_icons_and_logos(self):
        document = f"""<title>&lt;火箭隊的&gt;團珠蛛 | 官網</title>
            <img src="/build/images/tw/header/logo.svg">
            <img src="/various_images/energy/Grass.png">
            <img src="/tw/card-img/mark/twhk_exp_SV10.png">
            <img src="{IMAGE}"><img src="{IMAGE}">"""
        url, title = mod.resolve_card_image(PAGE, document)
        self.assertEqual(url, IMAGE)
        self.assertIn("團珠蛛", title)

    def test_resolver_rejects_ambiguity_and_wrong_origin(self):
        for document in (
            '<img src="https://evil.example/tw/card-img/x.png">',
            f'<img src="{IMAGE}"><img src="/tw/card-img/tw99999999.png">',
            "<html>Cloudflare challenge</html>",
        ):
            with self.assertRaises(ValueError):
                mod.resolve_card_image(PAGE, document)

    def test_filename_normalization_and_unsafe_names(self):
        self.assertEqual(mod.canonical_filename("File:SV10F008.png"), "SV10F008.png")
        self.assertEqual(mod.canonical_filename("test_card.JPG"), "Test card.JPG")
        for name in ("../x.png", "file.svg", "n", "{{image}}", "file.png/anything"):
            self.assertIsNone(mod.canonical_filename(name))

    def test_off_peak_boundaries(self):
        tz = ZoneInfo("Asia/Hong_Kong")
        for hour, expected in ((1, False), (2, True), (7, True), (8, False), (20, False)):
            self.assertEqual(mod.off_peak(datetime(2026, 10, 19, hour, tzinfo=tz)), expected)

    def test_retry_after_is_respected(self):
        error = urllib.error.HTTPError(PAGE, 429, "rate limited", {"Retry-After": "7200"}, None)
        self.assertGreaterEqual(mod.retry_delay(error), 7200)

    def test_download_validates_and_reuses_receipt_without_network(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(mod.time, "sleep"):
            net = FakeNetwork()
            first = mod.download_asset(net, IMAGE, PAGE, Path(tmp))
            self.assertEqual((first["width"], first["height"]), (8, 12))
            self.assertTrue(Path(first["local_file"]).is_file())
            second = mod.download_asset(net, IMAGE, PAGE, Path(tmp))
            self.assertEqual(first["sha256"], second["sha256"])
            self.assertEqual(len(net.calls), 1)
            self.assertEqual(len(net.permitted_calls), 1)

    def test_html_is_never_saved_as_a_valid_image(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(mod.time, "sleep"):
            net = FakeNetwork(b"<html>Not a PNG</html>")
            with self.assertRaises(Exception):
                mod.download_asset(net, IMAGE, PAGE, Path(tmp))
            self.assertEqual(list(Path(tmp).rglob("*.download.json")), [])
            self.assertEqual(list(Path(tmp).rglob("*.png")), [])

    def test_changed_local_image_does_not_trigger_silent_network_download(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(mod.time, "sleep"):
            net = FakeNetwork()
            record = mod.download_asset(net, IMAGE, PAGE, Path(tmp))
            Path(record["local_file"]).write_bytes(b"corrupt")
            with self.assertRaises(ValueError):
                mod.download_asset(net, IMAGE, PAGE, Path(tmp))
            self.assertEqual(len(net.calls), 1)

    def test_interrupted_partial_uses_if_range(self):
        payload = png_bytes()
        with tempfile.TemporaryDirectory() as tmp, patch.object(mod.time, "sleep"):
            directory = Path(tmp)
            key = mod.hashlib.sha256(IMAGE.encode()).hexdigest()
            dest = directory / "files" / key[:2] / (key + ".png")
            dest.parent.mkdir(parents=True)
            dest.with_suffix(".png.part").write_bytes(payload[:12])
            dest.with_suffix(".png.resume.json").write_text(json.dumps({"etag": '"v1"'}))
            net = FakeNetwork()

            def opened(url, headers):
                net.calls.append((url, headers))
                return Response(payload[12:], 206, {
                    "Content-Type": "image/png", "Content-Length": str(len(payload) - 12),
                    "Content-Range": f"bytes 12-{len(payload)-1}/{len(payload)}", "ETag": '"v1"',
                })

            net.open = opened
            record = mod.download_asset(net, IMAGE, PAGE, directory)
            self.assertEqual(net.calls[0][1]["Range"], "bytes=12-")
            self.assertEqual(net.calls[0][1]["If-Range"], '"v1"')
            self.assertEqual(Path(record["local_file"]).read_bytes(), payload)

    def test_server_ignoring_range_restarts_without_appending(self):
        payload = png_bytes()
        with tempfile.TemporaryDirectory() as tmp, patch.object(mod.time, "sleep"):
            directory = Path(tmp)
            key = mod.hashlib.sha256(IMAGE.encode()).hexdigest()
            dest = directory / "files" / key[:2] / (key + ".png")
            dest.parent.mkdir(parents=True)
            dest.with_suffix(".png.part").write_bytes(b"previous")
            dest.with_suffix(".png.resume.json").write_text(json.dumps({"etag": '"v1"'}))
            net = FakeNetwork(payload)
            record = mod.download_asset(net, IMAGE, PAGE, directory)
            self.assertEqual(Path(record["local_file"]).read_bytes(), payload)
            self.assertEqual(net.calls[0][1]["Range"], "bytes=8-")

    def test_http_403_stops_instead_of_rotating_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = mod.connect(Path(tmp))
            net = mod.Network(db)
            error = urllib.error.HTTPError(PAGE, 403, "Forbidden", {}, None)
            with patch.object(net.opener, "open", side_effect=error) as opened:
                with self.assertRaises(mod.AccessBlocked):
                    net.open(PAGE)
                self.assertEqual(opened.call_count, 1)
                request = opened.call_args.args[0]
                self.assertEqual(request.get_header("User-agent"), mod.USER_AGENT)
            db.close()

    def test_block_pauses_queue_before_next_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            db = mod.connect(directory)
            for name in ("a.png", "b.png"):
                db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                    name, 1, 1, 2, "[]", PAGE, "source", "pending", None, 0, None, 0,
                ))
            db.commit()
            with patch.object(mod.Network, "document", side_effect=mod.AccessBlocked("403")) as document:
                with self.assertRaises(mod.AccessBlocked):
                    mod.run(db, directory, 2, None)
                self.assertEqual(document.call_count, 1)
            self.assertIsNotNone(mod.get_meta(db, "blocked"))
            self.assertEqual(db.execute("SELECT status FROM jobs WHERE filename='b.png'").fetchone()[0], "pending")
            db.close()

    def test_queue_schema_and_status_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            db = mod.connect(directory)
            db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                "x.png", 1, 1, 2, "[]", PAGE, "source", "pending", None, 0, None, 0,
            ))
            db.commit()
            self.assertEqual(mod.summary(db, directory)["counts"], {"pending": 1})
            db.close()


if __name__ == "__main__":
    unittest.main()
