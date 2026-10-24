from contextlib import contextmanager
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from PIL import Image

from official_filter.core import Store, checksum, decide, ensure_storage, inventory, validated_prediction
from official_filter.model import AzureError, Client, credentials, ordered_rows, schema
from official_filter.web import Handler, ReviewServer, loopback_origin


def vote(label="card", confidence=99, **fields):
    return {"id": "I0001", "label": label, "kind": "card_front" if label == "card" else "product",
            "confidence": confidence, "full_card": label == "card", "reason": "完整单张卡面。" if label == "card" else "可见盒装商品。",
            **fields}


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.images, self.derived, self.reports = (self.root / p for p in ("images", "derived", "reports"))
        self.images.mkdir()
        image = self.root / "fixture.png"
        Image.new("RGB", (300, 420), "#31614b").save(image)
        sha = checksum(image)
        image.rename(self.images / (sha + ".png"))
        self.row = {"sha256": sha, "width": 300, "height": 420, "bytes": (self.images / (sha + ".png")).stat().st_size,
                    "suffix": ".png", "source_url": "https://image.pokemon.com.cn/a.png?auth_key=private",
                    "source_pages": ["https://www.pokemon.cn/tcg/product/test.html"]}
        self.receipts = self.root / "images.jsonl"
        self.receipts.write_text(json.dumps(self.row) + "\n")
        self.store = Store(self.root / "state")
        self.addCleanup(self.store.db.close)
        self.store.seed(self.receipts, self.images, self.derived, self.reports)

    def test_inventory_keeps_all_sources_and_strips_signatures(self):
        second = {**self.row, "source_pages": ["https://www.pokemon.cn/tcg/product/second.html"]}
        self.receipts.write_text(json.dumps(self.row) + "\n" + json.dumps(second) + "\n")
        data = inventory(self.receipts)
        self.assertEqual(len(data), 1)
        self.assertEqual(len(data[0]["sources"]), 2)
        self.assertNotIn("private", json.dumps(data))

    def test_shape_alone_never_confirms_a_card(self):
        row = {"width": 868, "height": 1212}
        self.assertEqual(decide(row, {})["label"], "review")
        self.assertEqual(decide(row, {"primary": vote()})["label"], "review")

    def test_two_model_consensus_and_all_card_kinds(self):
        result = decide({"width": 868, "height": 1212}, {"primary": vote(), "secondary": vote(confidence=98)})
        self.assertEqual(result["label"], "card")
        self.assertEqual(result["method"], "two_model_consensus")
        self.assertIn("Trainer", __import__("official_filter.model", fromlist=["PROMPT"]).PROMPT)
        self.assertIn("Energy", __import__("official_filter.model", fromlist=["PROMPT"]).PROMPT)

    def test_disagreement_requires_strong_enlarged_vote_and_support(self):
        votes = {"primary": vote(), "secondary": vote("non_card")}
        row = {"width": 868, "height": 1212}
        self.assertEqual(decide(row, votes)["label"], "review")
        votes["adjudicator"] = vote(confidence=99)
        self.assertEqual(decide(row, votes)["method"], "enlarged_majority")
        votes["adjudicator"] = vote(confidence=90)
        self.assertEqual(decide(row, votes)["label"], "review")

    def test_unusual_geometry_is_not_silently_accepted(self):
        result = decide({"width": 2000, "height": 2000}, {"primary": vote(), "secondary": vote()})
        self.assertEqual(result["method"], "geometry_hold")
        self.assertEqual(result["label"], "review")
        result = decide({"width": 2016, "height": 1210}, {"primary": vote(), "secondary": vote()})
        self.assertEqual(result["method"], "geometry_hold")
        self.assertEqual(result["label"], "review")
        result = decide({"width": 868, "height": 1212}, {"primary": vote(), "secondary": vote(reason="图像显示两张完整卡牌。")})
        self.assertEqual(result["method"], "layout_hold")
        result = decide({"width": 868, "height": 1212}, {"primary": vote(), "secondary": vote(reason="只有一张卡牌，没有多张卡牌或背景。")})
        self.assertEqual(result["label"], "card")

    def test_two_independent_enlarged_views_can_resolve_low_score_tiles(self):
        votes = {"primary": vote(confidence=90), "secondary": vote(confidence=90),
                 "adjudicator": {**vote(), "model": "deployment-a"},
                 "verifier": {**vote(), "model": "deployment-b"}}
        result = decide({"width": 868, "height": 1212}, votes)
        self.assertEqual(result["label"], "card")
        self.assertEqual(result["method"], "two_single_image_consensus")
        votes["verifier"]["model"] = "deployment-a"
        self.assertEqual(decide({"width": 868, "height": 1212}, votes)["label"], "review")
        votes = {"primary": vote(), "secondary": vote(),
                 "adjudicator": {**vote("non_card"), "model": "deployment-a"},
                 "verifier": {**vote("non_card"), "model": "deployment-b"}}
        self.assertEqual(decide({"width": 1600, "height": 1600}, votes)["label"], "non_card")

    def test_prediction_schema_fails_closed(self):
        for invalid in (vote(confidence=True), vote(confidence=101), vote(full_card=False),
                        vote(kind="poster"), vote(reason=""), {**vote(), "injected": "yes"}):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    validated_prediction(invalid)
        with self.assertRaises(ValueError):
            validated_prediction(vote("non_card", full_card=True))
        variants = schema()["properties"]["items"]["items"]["anyOf"]
        self.assertEqual(variants[0]["properties"]["full_card"]["enum"], [True])
        self.assertEqual(variants[1]["properties"]["full_card"]["enum"], [False])

    def test_shuffled_contact_sheet_ids_match_text_order(self):
        rows = [{"short_id": f"I{i:04d}"} for i in range(12)]
        self.assertEqual(ordered_rows(rows, "primary"), rows)
        self.assertNotEqual(ordered_rows(rows, "secondary"), rows)
        self.assertEqual({r["short_id"] for r in rows}, {r["short_id"] for r in ordered_rows(rows, "secondary")})

    def test_previews_preserve_original_and_detect_changes(self):
        row = self.store.rows()[0]
        original = self.store.original(row)
        before = original.read_bytes()
        self.store.prepare_one(row)
        self.assertEqual(original.read_bytes(), before)
        self.assertTrue(self.store.thumb(row["id"]).exists())
        original.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum/size"):
            self.store.prepare_one(row)

    def test_model_cache_and_strict_input_coverage(self):
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        calls = []
        def transport(body):
            calls.append(body)
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"items": [vote()]})}}]}
        client = Client(self.store, None, transport=transport)
        client.predict([row], "primary", "test-deployment")
        client.predict([row], "primary", "test-deployment")
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.store.votes()[row["id"]]["primary"]["model"], "test-deployment")
        bad = Client(self.store, None, transport=lambda _: {
            "choices": [{"finish_reason": "stop", "message": {"content": '{"items":[]}'}}]})
        with self.assertRaisesRegex(ValueError, "omitted"):
            bad.predict([row], "secondary", "different-test-deployment")

    def test_azure_credentials_are_server_only_and_redirect_host_rejected(self):
        path = self.root / ".env"
        path.write_text('AOAI_ENDPOINT=https://bad.invalid/openai/v1\nFOUNDRY_KEY=private\n')
        with self.assertRaises(ValueError):
            credentials(path)
        path.write_text('AOAI_ENDPOINT=https://test.openai.azure.com/openai/v1\nFOUNDRY_KEY=private\n')
        self.assertEqual(credentials(path)[1], "private")
        self.assertNotIn("private", json.dumps(self.store.snapshot()))

    def test_azure_403_is_persisted_without_retrying(self):
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        calls = []
        def denied(_):
            calls.append(1)
            raise urllib.error.HTTPError("https://test.openai.azure.com/", 403, "denied", {}, None)
        client = Client(self.store, None, transport=denied)
        with self.assertRaises(AzureError):
            client.predict([row], "primary")
        self.assertEqual(len(calls), 1)
        with self.assertRaisesRegex(AzureError, "restriction retained"):
            Client(self.store, None, transport=denied)

    def test_long_retry_after_is_respected_and_persisted(self):
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        def paused(_):
            raise urllib.error.HTTPError("https://test.openai.azure.com/", 429, "limited", {"retry-after": "180"}, None)
        client = Client(self.store, None, transport=paused)
        with self.assertRaisesRegex(AzureError, "long rate-limit pause"):
            client.predict([row], "primary")
        self.assertGreater(client.state["rate_limit_pause_until"], time.time() + 100)
        with self.assertRaisesRegex(AzureError, "pause is still active"):
            Client(self.store, None, transport=paused)

    def test_content_filter_keeps_a_manual_hold_without_bypassing_it(self):
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        calls = []
        def filtered(_):
            calls.append(1)
            body = io.BytesIO(json.dumps({"error": {"code": "content_filter",
                "innererror": {"code": "ResponsibleAIPolicyViolation"}, "message": "Filtered image"}}).encode())
            raise urllib.error.HTTPError("https://test.openai.azure.com/", 400, "filtered", {}, body)
        client = Client(self.store, None, transport=filtered)
        with self.assertRaisesRegex(AzureError, "manual-review hold"):
            client.predict([row], "primary")
        self.assertEqual(self.store.catalog()[0]["ai"]["method"], "provider_hold")
        with self.assertRaisesRegex(AzureError, "retained provider hold"):
            client.predict([row], "secondary")
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.store.snapshot()["summary"]["provider_held_images"], 1)

    def test_single_image_schema_pins_the_literal_image_id(self):
        for variant in schema(["I0254"])["properties"]["items"]["items"]["anyOf"]:
            self.assertEqual(variant["properties"]["id"]["enum"], ["I0254"])

    def test_request_budget_stops_before_an_extra_call(self):
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        calls = []
        def transport(body):
            calls.append(body)
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"items": [vote()]})}}]}
        client = Client(self.store, None, max_requests=1, transport=transport)
        client.predict([row], "primary")
        with self.assertRaisesRegex(AzureError, "budget exhausted"):
            client.predict([row], "secondary")
        self.assertTrue(client.stop.is_set())
        self.assertEqual(len(calls), 1)

    @contextmanager
    def server(self, **options):
        server = ReviewServer(("127.0.0.1", 0), self.store, **options)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_forwarded_origin_handles_preserved_and_rewritten_host(self):
        origin = "http://localhost:57824"
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        with self.server(forwarded_origins=[origin]) as base:
            for path in ("/", "/app.js", "/style.css", "/api/catalog",
                         "/thumb/" + row["id"] + ".jpg"):
                with urllib.request.urlopen(urllib.request.Request(
                        base + path, headers={"Host": "localhost:57824"})) as response:
                    self.assertEqual(response.status, 200)
            for revision, headers in enumerate((
                    {"Host": "localhost:57824", "Origin": origin},
                    {"Origin": origin})):
                payload = {"ids": [row["id"]], "label": "card", "revision": revision}
                with urllib.request.urlopen(urllib.request.Request(
                        base + "/api/review", data=json.dumps(payload).encode(),
                        headers={**headers, "Content-Type": "application/json",
                                 "Sec-Fetch-Site": "same-origin"})) as response:
                    self.assertEqual(json.load(response)["revision"], revision + 1)
            self.assertEqual(self.store.catalog()[0]["human"]["label"], "card")

    def test_forwarding_does_not_allow_other_hosts_origins_or_cross_site(self):
        with self.server(forwarded_origins=["http://localhost:57824"]) as base:
            for headers in (
                    {"Host": "localhost:57825"},
                    {"Host": "evil.invalid:57824"},
                    {"Host": "localhost:57824", "Origin": "http://localhost:57825"},
                    {"Host": "localhost:57824", "Origin": "https://evil.invalid"},
                    {"Host": "localhost:57824", "Sec-Fetch-Site": "cross-site"},
                    {"Host": "localhost:57824/path"},
                    {"Host": "name@localhost:57824"},
                    {"Host": "localhost:57825", "Forwarded": "host=localhost:57824",
                     "X-Forwarded-Host": "localhost:57824", "X-Forwarded-Port": "57824"},
            ):
                with self.subTest(headers=headers):
                    for data in (None, b"{}"):
                        with self.assertRaises(urllib.error.HTTPError) as caught:
                            urllib.request.urlopen(urllib.request.Request(
                                base + ("/" if data is None else "/api/review"),
                                data=data, headers=headers))
                        self.assertEqual(caught.exception.code, 403)
            self.assertEqual(self.store.meta("review_revision", 0), 0)
            with urllib.request.urlopen(base + "/") as response:
                self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
                self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))

    def test_forwarding_is_explicitly_opt_in(self):
        with self.server() as base:
            for headers in ({"Host": "localhost:57824"}, {"Origin": "http://localhost:57824"}):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(urllib.request.Request(base + "/", headers=headers))
                self.assertEqual(caught.exception.code, 403)

    def test_forwarded_origin_configuration_is_narrow(self):
        for origin in ("http://evil.invalid:57824", "https://localhost:57824",
                       "http://localhost", "http://localhost:0", "http://localhost:99999",
                       "http://localhost:57824/", "http://localhost:57824?x=1",
                       "http://localhost:57824#x", "http://name@localhost:57824",
                       "http://localhost:57824\n", " http://localhost:57824"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                ReviewServer(("127.0.0.1", 0), self.store, forwarded_origins=[origin])

    def test_ssh_forwarding_accepts_changing_ports_without_reconfiguration(self):
        row = self.store.rows()[0]
        with self.server(ssh_forwarded=True) as base:
            revision = 0
            for port in (57824, 58388, 59999):
                for rewritten in (False, True):
                    origin = f"http://localhost:{port}"
                    headers = {"Origin": origin, "Sec-Fetch-Site": "same-origin"}
                    if not rewritten:
                        headers["Host"] = f"localhost:{port}"
                    with urllib.request.urlopen(urllib.request.Request(
                            base + "/api/catalog", headers=headers)) as response:
                        self.assertEqual(json.load(response)["summary"]["total"], 1)
                    payload = {"ids": [row["id"]], "label": "card", "revision": revision}
                    with urllib.request.urlopen(urllib.request.Request(
                            base + "/api/review", data=json.dumps(payload).encode(),
                            headers={**headers, "Content-Type": "application/json"})) as response:
                        revision += 1
                        self.assertEqual(json.load(response)["revision"], revision)
            self.assertEqual(self.store.meta("review_revision", 0), 6)

    def test_dynamic_ssh_forwarding_still_rejects_cross_origin_and_bad_hosts(self):
        with self.server(ssh_forwarded=True) as base:
            for headers in (
                    {"Host": "localhost:58388", "Origin": "https://evil.invalid"},
                    {"Host": "localhost:58388", "Origin": "http://localhost:59999",
                     "Sec-Fetch-Site": "same-origin"},
                    {"Origin": "http://localhost:58388", "Sec-Fetch-Site": "same-site"},
                    {"Origin": "http://localhost:58388"},
                    {"Origin": "http://localhost:58388", "Sec-Fetch-Site": "cross-site"},
                    {"Origin": "http://localhost:58388/", "Sec-Fetch-Site": "same-origin"},
                    {"Host": "localhost:58388", "Sec-Fetch-Site": "cross-site"},
                    {"Host": "evil.invalid:58388"},
                    {"Host": "192.168.3.45:58388"},
                    {"Host": "localhost:58388/path"},
                    {"Host": "user@localhost:58388"},
                    {"Host": "localhost:0"},
                    {"Host": "localhost:99999"},
                    {"Host": "localhost:58388", "Origin": "null"},
            ):
                with self.subTest(headers=headers):
                    for data in (None, b"{}"):
                        with self.assertRaises(urllib.error.HTTPError) as caught:
                            urllib.request.urlopen(urllib.request.Request(
                                base + ("/" if data is None else "/api/review"),
                                data=data, headers=headers))
                        self.assertEqual(caught.exception.code, 403)
                        caught.exception.close()
            self.assertEqual(self.store.meta("review_revision", 0), 0)

    def test_dynamic_ssh_forwarding_does_not_trust_lan_peers(self):
        with self.server(ssh_forwarded=True) as base:
            # Exercise the real handler's peer check without binding a LAN
            # address or requiring a particular host network in offline tests.
            allowed = Handler.allowed
            def lan_peer(handler):
                handler.client_address = ("192.168.3.100", 12345)
                return allowed(handler)
            with patch.object(Handler, "allowed", lan_peer):
                for headers in ({"Host": "localhost:58388"},
                                {"Origin": "http://localhost:58388", "Sec-Fetch-Site": "same-origin"}):
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(urllib.request.Request(base + "/", headers=headers))
                    self.assertEqual(caught.exception.code, 403)
                    caught.exception.close()
                # The existing backend origin remains usable on the LAN.
                with urllib.request.urlopen(base + "/") as response:
                    self.assertEqual(response.status, 200)

    def test_loopback_origin_rejects_lookalikes_and_malformed_values(self):
        for value in ("http://localhost:58388", "http://127.0.0.1:58388", "http://[::1]:58388"):
            self.assertTrue(loopback_origin(value))
        for value in ("http://localhost.evil.invalid:58388", "http://127.0.0.2:58388",
                      "http://192.168.3.45:58388", "https://localhost:58388", "http://localhost",
                      "http://localhost:58388/", "http://localhost:58388?x=1",
                      "http://localhost:0", "http://localhost:99999",
                      "http://user@localhost:58388", "http://localhost:58388\n"):
            with self.subTest(value=value):
                self.assertFalse(loopback_origin(value))

    def test_server_review_persistence_revision_and_csrf(self):
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        with self.server() as base:
            with urllib.request.urlopen(base + "/api/catalog") as response:
                before = json.load(response)
            self.assertEqual(before["summary"]["total"], 1)
            payload = {"ids": [row["id"]], "label": "card", "note": "人工检查通过", "revision": 0}
            request = urllib.request.Request(base + "/api/review", data=json.dumps(payload).encode(),
                                             headers={"Content-Type": "application/json", "Origin": base})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["revision"], 1)
            self.assertEqual(self.store.catalog()[0]["label"], "card")
            self.assertEqual(json.loads((self.reports / "card.json").read_text())[0]["human"]["note"], "人工检查通过")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request)
            self.assertEqual(caught.exception.code, 409)
            bad = urllib.request.Request(base + "/api/review", data=json.dumps(payload).encode(),
                                         headers={"Origin": "https://evil.invalid"})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(bad)
            self.assertEqual(caught.exception.code, 403)
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(base + "/image/../../.env.foundry")
            with urllib.request.urlopen(base + "/") as response:
                self.assertIn("script-src 'self'", response.headers["Content-Security-Policy"])
                self.assertIn("官网卡图", response.read().decode())
            self.assertFalse((self.images / ".env.foundry").exists())

    def test_human_result_survives_model_reclassification(self):
        row = self.store.rows()[0]
        with self.store.db:
            self.store.db.execute("INSERT INTO reviews VALUES (?,?,?,?)", (row["id"], "non_card", "人工确认包装", "now"))
        self.store.save_vote(row["id"], "primary", vote())
        self.store.save_vote(row["id"], "secondary", vote())
        result = self.store.catalog()[0]
        self.assertEqual(result["ai"]["label"], "card")
        self.assertEqual(result["label"], "non_card")

    def test_class_views_link_originals_without_copying_and_follow_reviews(self):
        row = self.store.rows()[0]
        self.store.prepare_one(row)
        self.store.export()
        name = row["id"] + row["suffix"]
        initial = self.store.root / "views/review" / name
        self.assertTrue(initial.is_symlink())
        self.assertEqual(initial.resolve(), self.store.original(row))
        self.store.save_vote(row["id"], "primary", vote())
        self.store.save_vote(row["id"], "secondary", vote())
        self.store.export()
        self.assertFalse(initial.exists())
        self.assertTrue((self.store.root / "views/card" / name).is_symlink())
        self.assertEqual(len(list(self.images.iterdir())), 1)

    def test_missing_nas_never_creates_a_local_fallback(self):
        with patch("official_filter.core.os.path.ismount", return_value=False):
            with self.assertRaisesRegex(OSError, "refusing a local fallback"):
                ensure_storage({"images": "/nas/share/Pokemon/images/official-bulk",
                                "reports": "/nas/share/Pokemon/metadata/official-card-filter"})


if __name__ == "__main__":
    unittest.main()
