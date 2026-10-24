"""Synthetic-only full-catalog sidecar tests. No source export, NAS or cloud."""
import contextlib
import copy
import hashlib
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import Image

from mik_merge import bulk_review, common


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def synthetic_run(exports, *, count=7):
    """Reusable synthetic fixture, also usable by the optional HTTP browser test."""
    root = exports / "bulk-synthetic"
    root.mkdir(parents=True)
    image = io.BytesIO()
    Image.new("RGB", (32, 45), "#7799aa").save(image, format="PNG")
    raw = image.getvalue()
    sha = hashlib.sha256(raw).hexdigest()
    cards = []
    for index in range(count):
        set_code = "SYN" if index % 2 == 0 else "ALT"
        number = f"{index + 1:05}"
        identity = f"{set_code}/{number}"
        status = bulk_review.STATUSES[index % len(bulk_review.STATUSES)]
        has_image = status != "blocked" or index == 2
        row = {
            "mik_id": identity, "name": f"合成卡牌 {index + 1}",
            "set_code": set_code, "card_type": "Pokemon",
            "status": status, "association_status": "unmatched" if status == "blocked" else "unique",
            "semantic_status": "not_run" if status == "blocked" else "deterministic_equal",
            "wiki_id": None if status == "blocked" else f"synthetic-{index}",
            "holds": [] if status == "ready" else [{"code": "unmatched" if status == "blocked" else "semantic_pending",
                                                   "reason": "合成原因；并非实际卡文"}],
            "image_sha256": sha if has_image else None,
            "image_file": f"cards/{identity}/image.png" if has_image else None,
            "detail_file": f"cards/{identity}/review.json",
            "merged_metadata_file": f"cards/{identity}/merged.json" if status != "blocked" else None,
        }
        cards.append(row)
        # Large-catalog tests need only the index, not thousands of tiny files.
        if count > 1000 and index >= 4:
            continue
        directory = root / "cards" / identity
        directory.mkdir(parents=True)
        if row["image_file"]:
            (directory / "image.png").write_bytes(raw)
        write(directory / "review.json", {
            "mik_id": identity, "status": status, "holds": row["holds"],
            "row": row, "result": {"mik_id": identity, "status": status},
            "mik_metadata": {"name": row["name"], "description": "合成描述 <img src=x onerror=alert(1)>",
                             "pokemonAttr": {"attack": [{"name": "合成招式", "text": "只用于测试的招式文字", "damage": "10+"}]}},
            **({} if status == "blocked" else {
                "wiki_source": {"title": "合成 Wiki 原始结构"},
                "wiki_display": {"display": {"name": "合成 Wiki 名称"}},
                "normalized_wiki_source": {"title": "合成规范化结构"},
                "normalized_wiki_display": {"display": {"name": "合成规范化名称"}, "blocks": [
                    {"attacks": [{"display": {"name": "合成招式", "effect": "只用于测试的另一段文字"}}]}]},
                "merged_candidate": {"human_reviewed": False, "rules_engine_implemented": False},
                "field_diffs": [{"id": "name", "label": "名称", "mik": row["name"], "wiki": "合成规范化名称", "status": "different"}],
                "candidate_evidence": [{"page_id": 12345, "title": "合成候选", "checks": {"kind": True}}],
                "semantic_equivalence": [{
                    "id": f"{identity}:effect", "left": "合成左侧原文", "right": "合成右侧原文", "decision": "needs_review",
                    "reviews": [{"deployment": "synthetic-offline", "verdict": "uncertain",
                                 "dimensions": [{"dimension": "quantity", "relation": "uncertain",
                                                 "evidence": "合成证据句子"}]}],
                }],
            }),
        })
    write(root / "catalog.json", {"schema": bulk_review.SCHEMA, "cards": cards})
    write(root / "run-inputs.json", {
        "source": {"sha256": "1" * 64}, "snapshot": {"sha256": "2" * 64},
        "selection": {"sha256": "3" * 64}, "observations": {"sha256": "4" * 64},
    })
    write(root / "progress.json", {"processed": count - 1, "phase": "synthetic"})
    return root, cards, raw


class BulkReviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.exports = self.base / "exports"
        self.patch = patch.object(common, "EXPORTS", self.exports)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.root, self.cards, self.png = synthetic_run(self.exports)
        bulk_review.build(self.root)
        self.server = bulk_review.make_server(self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path, *, method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def api(self, path):
        status, _, raw = self.request(path)
        self.assertEqual(status, 200, raw)
        return json.loads(raw)

    def replace_catalog(self, cards):
        write(self.root / "catalog.json", {"schema": bulk_review.SCHEMA, "cards": cards})

    def test_build_copies_only_data_free_assets_and_needs_no_catalog(self):
        root = self.exports / "before-staging"
        target = bulk_review.build(root)
        self.assertEqual(target, root / "web/index.html")
        expected = {"index.html", "assets/bulk-review.js", "assets/bulk-review.css"}
        self.assertEqual({str(p.relative_to(root / "web")) for p in (root / "web").rglob("*") if p.is_file()}, expected)
        for name in expected:
            text = (root / "web" / name).read_text()
            self.assertNotIn("合成卡牌", text)
        self.assertNotIn("innerHTML", (target.parent / "assets/bulk-review.js").read_text())

    def test_summary_counts_include_every_blocked_and_unmatched_card(self):
        result = self.api("/api/summary")
        self.assertEqual((result["total"], result["candidate"], result["ready"],
                          result["needs_review"], result["blocked"]), (7, 5, 3, 2, 2))
        self.assertEqual(result["progress"]["processed"], 6)
        self.assertIsNone(result["summary"])
        self.assertFalse(result["final"])
        self.assertEqual(sum(s["count"] for s in result["sets"]), 7)
        self.assertEqual({r["code"]: r["count"] for r in result["reasons"]},
                         {"semantic_pending": 2, "unmatched": 2})

    def test_pagination_and_composable_search_status_set_reason_filters(self):
        first = self.api("/api/cards?page_size=3")
        second = self.api("/api/cards?page_size=3&page=2")
        third = self.api("/api/cards?page_size=3&page=3")
        self.assertEqual([first["pages"], first["total"], len(third["cards"])], [3, 7, 1])
        self.assertEqual([c["mik_id"] for c in first["cards"] + second["cards"] + third["cards"]],
                         [c["mik_id"] for c in self.cards])
        filtered = self.api("/api/cards?status=blocked&set=SYN&reason=unmatched")
        self.assertEqual([c["mik_id"] for c in filtered["cards"]], ["SYN/00003"])
        self.assertEqual(self.api("/api/cards?q=synthetic-4")["cards"][0]["mik_id"], "SYN/00005")
        self.assertEqual(self.api("/api/cards?search=alt&set_code=ALT&hold=semantic_pending")["total"], 1)
        self.assertEqual(self.api("/api/cards?q=no-match")["total"], 0)
        self.assertEqual(self.api("/api/cards?page=100")["cards"], [])

    def test_bounded_pages_invalid_queries_and_unknown_fields(self):
        for query in ("page=0", "page=-1", "page=wrong", "page_size=201", "page_size=0",
                      "page=1&page=2", "status=passed", "file=.env", "q=a&search=a"):
            with self.subTest(query=query):
                self.assertEqual(self.request("/api/cards?" + query)[0], 400)

    def test_detail_contains_comparison_candidates_models_and_keeps_literal_text(self):
        result = self.api("/api/card?mik_id=SYN/00001")
        self.assertTrue(result["detail_available"])
        self.assertEqual(set(result["detail"]), set(bulk_review.DETAIL_KEYS))
        self.assertIn("<img", result["detail"]["mik_metadata"]["description"])
        self.assertFalse(result["detail"]["merged_candidate"]["human_reviewed"])
        self.assertEqual(result["detail"]["semantic_equivalence"][0]["reviews"][0]["deployment"], "synthetic-offline")
        blocked = self.api("/api/card?mik_id=SYN/00003")
        self.assertEqual(blocked["card"]["status"], "blocked")
        self.assertIsNone(blocked["card"]["wiki_id"])
        self.assertEqual(set(blocked["detail"]), {"mik_id", "status", "holds", "row", "result", "mik_metadata"})
        self.assertTrue(blocked["card"]["image_url"])
        self.assertIn("合成描述", blocked["detail"]["mik_metadata"]["description"])
        self.assertEqual(self.request(blocked["card"]["image_url"])[0], 200)

    def test_missing_blocked_detail_is_explicit_not_dropped(self):
        (self.root / self.cards[2]["detail_file"]).unlink()
        result = self.api("/api/card?mik_id=SYN/00003")
        self.assertFalse(result["detail_available"])
        self.assertEqual(result["detail"], {})
        self.assertEqual(self.api("/api/cards?status=blocked")["total"], 2)
        self.assertEqual(self.request("/api/card?mik_id=SYN/99999")[0], 404)

    def test_summary_progress_and_catalog_are_live_but_inputs_fingerprint_is_stable(self):
        initial = self.api("/api/summary")
        write(self.root / "progress.json", {"processed": 7, "phase": "finished"})
        write(self.root / "judge-progress.json", {"phase": "judging", "planned_requests": 123,
                                                 "completed_requests": 42, "raw_response": "never-expose"})
        write(self.root / "summary.json", {"finished": True, "totals": {"all": 7}})
        changed = copy.deepcopy(self.cards)
        changed[1]["status"], changed[1]["holds"] = "ready", []
        self.replace_catalog(changed)
        final = self.api("/api/summary")
        self.assertEqual(final["dataset_fingerprint"], initial["dataset_fingerprint"])
        self.assertNotEqual(final["catalog_revision"], initial["catalog_revision"])
        self.assertEqual(final["ready"], 4)
        self.assertTrue(final["final"])
        self.assertTrue(final["summary"]["finished"])
        self.assertEqual(final["progress"]["phase"], "finished")
        self.assertEqual(final["judge_progress"]["completed_requests"], 42)
        self.assertEqual(final["judge_progress"]["planned_requests"], 123)
        self.assertNotIn("raw_response", final["judge_progress"])
        write(self.root / "run-inputs.json", {"source": "different"})
        self.assertNotEqual(self.api("/api/summary")["dataset_fingerprint"], initial["dataset_fingerprint"])

    def test_fingerprint_binds_all_identities_and_image_hashes_not_order(self):
        initial = self.api("/api/summary")["dataset_fingerprint"]
        self.replace_catalog(list(reversed(self.cards)))
        self.assertEqual(initial, self.api("/api/summary")["dataset_fingerprint"])
        changed = copy.deepcopy(self.cards)
        changed[0]["image_sha256"] = "f" * 64
        self.replace_catalog(changed)
        self.assertNotEqual(initial, self.api("/api/summary")["dataset_fingerprint"])

    def test_top_level_catalog_fingerprint_is_exposed_and_bound(self):
        value = {"schema": bulk_review.SCHEMA, "fingerprint": "a" * 64, "cards": self.cards}
        write(self.root / "catalog.json", value)
        initial = self.api("/api/summary")
        self.assertEqual(initial["catalog_fingerprint"], "a" * 64)
        value["fingerprint"] = "b" * 64
        write(self.root / "catalog.json", value)
        self.assertNotEqual(initial["dataset_fingerprint"], self.api("/api/summary")["dataset_fingerprint"])

    def test_staged_summary_is_not_presented_as_final(self):
        write(self.root / "summary.json", {"phase": "staged", "total": 7})
        self.assertFalse(self.api("/api/summary")["final"])
        write(self.root / "summary.json", {"phase": "complete", "total": 7})
        self.assertTrue(self.api("/api/summary")["final"])

    def test_only_exact_catalog_image_route_is_served_and_png_is_checked(self):
        status, headers, raw = self.request("/images/SYN/00001")
        self.assertEqual((status, raw), (200, self.png))
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(self.request("/images/ALT/00006")[0], 404)
        self.assertEqual(self.request("/images/SYN/99999")[0], 404)
        image = self.root / self.cards[0]["image_file"]
        image.write_bytes(self.png + b"tampered")
        self.assertEqual(self.request("/images/SYN/00001")[0], 503)

    def test_matching_hash_is_not_enough_for_invalid_image(self):
        for raw in (b"not-png", b"\x89PNG\r\n\x1a\nbroken"):
            with self.subTest(raw=raw):
                changed = copy.deepcopy(self.cards)
                changed[0]["image_sha256"] = hashlib.sha256(raw).hexdigest()
                (self.root / changed[0]["image_file"]).write_bytes(raw)
                self.replace_catalog(changed)
                self.assertEqual(self.request("/images/SYN/00001")[0], 503)

    def test_original_webp_jpeg_and_refinement_paths_no_conversion(self):
        for format_name, suffix, mime in (("WEBP", ".webp", "image/webp"),
                                          ("JPEG", ".jpeg", "image/jpeg"),
                                          ("PNG", ".png", "image/png")):
            with self.subTest(format=format_name):
                output = io.BytesIO()
                Image.new("RGB", (21, 31), "#ab9944").save(output, format=format_name)
                raw = output.getvalue()
                changed = copy.deepcopy(self.cards)
                changed[2]["detail_file"] = "refinement/cards/SYN/00003/review.json"
                changed[2]["image_file"] = f"refinement/cards/SYN/00003/image{suffix}"
                changed[2]["image_sha256"] = hashlib.sha256(raw).hexdigest()
                write(self.root / changed[2]["detail_file"], {
                    "mik_id": "SYN/00003", "mik_metadata": {"description": "合成阻断卡仍保留原始描述"},
                    "result": {"mik_id": "SYN/00003", "output_directory": "refinement/cards/SYN/00003"},
                })
                (self.root / changed[2]["image_file"]).write_bytes(raw)
                self.replace_catalog(changed)
                detail = self.api("/api/card?mik_id=SYN/00003")
                self.assertIn("合成阻断卡", detail["detail"]["mik_metadata"]["description"])
                status, headers, served = self.request(detail["card"]["image_url"])
                self.assertEqual((status, headers["Content-Type"], served), (200, mime, raw))
                self.assertEqual(hashlib.sha256(served).hexdigest(), changed[2]["image_sha256"])

    def test_no_arbitrary_files_cloud_transport_credentials_or_directory_listing(self):
        write(self.root / "semantic-v2/cloud/secret.response.json", {"secret": "do-not-expose"})
        (self.root / ".env").write_text("AZURE_OPENAI_API_KEY=do-not-expose")
        for path in ("/catalog.json", "/run-inputs.json", "/summary.json", "/progress.json",
                     "/.env", "/web/", "/web/preview-info.json", "/assets/",
                     "/cards/SYN/00001/review.json", "/semantic-v2/cloud/secret.response.json",
                     "/../.env", "/%2e%2e/.env", "/images/../.env", "/images/SYN%2f00001",
                     "/api/card/../../.env", "/assets/../bulk_review.py"):
            with self.subTest(path=path):
                status, _, raw = self.request(path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"do-not-expose", raw)
        for method in ("POST", "PUT", "DELETE", "PATCH", "OPTIONS"):
            self.assertEqual(self.request("/api/card", method=method)[0], 405)

    def test_nested_transport_and_secret_keys_are_not_review_evidence(self):
        relative = self.root / self.cards[0]["detail_file"]
        detail = common.load(relative)
        poison = {
            "api_key": "do-not-expose", "request": {"messages": ["do-not-expose"]},
            "rawResponse": "do-not-expose", "cloud_request": "do-not-expose",
            "nested": {"credentials": "do-not-expose", "Authorization": "do-not-expose"},
        }
        detail["secret_extra"] = poison
        detail["semantic_equivalence"][0]["reviews"][0].update(poison)
        detail["mik_metadata"]["source_response_file"] = "/not/exposed"
        write(relative, detail)
        write(self.root / "summary.json", {"total": 7, **poison})
        write(self.root / "progress.json", {"processed": 1, **poison})
        for route in ("/api/summary", "/api/card?mik_id=SYN/00001"):
            raw = self.request(route)[2]
            self.assertNotIn(b"do-not-expose", raw)
            self.assertNotIn(b"/not/exposed", raw)
        self.assertIn(b"synthetic-offline", self.request("/api/card?mik_id=SYN/00001")[2])

    def test_loopback_host_origin_credentials_and_security_headers(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"},
                        {"Sec-Fetch-Site": "cross-site"}, {"Authorization": "Basic dGVzdA=="},
                        {"Proxy-Authorization": "Bearer test"}):
            self.assertEqual(self.request("/api/summary", headers=headers)[0], 403)
        status, headers, _ = self.request("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
        self.assertIn("img-src 'self' data:", headers["Content-Security-Policy"])
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("/", method="HEAD")[2], b"")

    def test_run_directory_is_strict_exports_child_including_cli(self):
        for root in (self.exports, self.base, self.base / "library"):
            with self.subTest(root=root), self.assertRaises(ValueError):
                bulk_review.build(root)
            with self.assertRaises(ValueError):
                bulk_review.make_server(root)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            bulk_review.main(["build", "--run-dir", str(self.root)])
        self.assertIn(str(self.root / "web/index.html"), output.getvalue())

    def test_catalog_paths_duplicates_and_unknown_status_fail_closed_not_omit(self):
        cases = []
        for key, value in (
            ("mik_id", "../bad"), ("detail_file", "../outside.json"),
            ("detail_file", "semantic-v2/cloud/response.json"),
            ("image_file", "/tmp/secret.png"), ("image_file", "cards/../secret.png"),
            ("image_file", "cards\\secret.png"), ("merged_metadata_file", "../merged.json"),
            ("status", "accepted"), ("set_code", "OTHER"),
        ):
            cards = copy.deepcopy(self.cards)
            cards[0][key] = value
            cases.append(cards)
        cases.append(self.cards + [self.cards[0]])
        for cards in cases:
            with self.subTest(first=cards[0]):
                self.replace_catalog(cards)
                self.assertEqual(self.request("/api/summary")[0], 503)

    def test_symlinks_to_sources_are_never_followed_for_reads_or_build(self):
        outside = self.base / "private"
        outside.mkdir()
        (outside / "image.png").write_bytes(self.png)
        write(outside / "review.json", {"mik_metadata": {"name": "must-not-be-read"}})
        image = self.root / self.cards[0]["image_file"]
        image.unlink()
        image.symlink_to(outside / "image.png")
        self.assertEqual(self.request("/images/SYN/00001")[0], 503)
        detail = self.root / self.cards[0]["detail_file"]
        detail.unlink()
        detail.symlink_to(outside / "review.json")
        status, _, raw = self.request("/api/card?mik_id=SYN/00001")
        self.assertEqual(status, 503)
        self.assertNotIn(b"must-not-be-read", raw)
        for path in (self.root / "web/assets", self.root / "cards/ALT"):
            moved = path.with_name(path.name + "-old")
            path.rename(moved)
            path.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            bulk_review.build(self.root)
        self.assertEqual(self.request("/assets/bulk-review.js")[0], 503)
        self.assertEqual(self.request("/api/card?mik_id=ALT/00002")[0], 503)
        self.assertEqual(set(p.name for p in outside.iterdir()), {"image.png", "review.json"})

    def test_detail_identity_mismatch_is_blocked(self):
        path = self.root / self.cards[0]["detail_file"]
        write(path, {"result": {"mik_id": "SYN/WRONG"}, "mik_metadata": {"name": "wrong"}})
        self.assertEqual(self.request("/api/card?mik_id=SYN/00001")[0], 503)

    def test_large_catalog_has_bounded_payload_and_cached_index(self):
        cards = []
        template = self.cards[0]
        for index in range(13057):
            card = {**template, "mik_id": f"SYN/{index:05}", "detail_file": f"cards/SYN/{index:05}/review.json"}
            cards.append(card)
        self.replace_catalog(cards)
        result = self.api("/api/cards?page=66&page_size=200")
        self.assertEqual((result["total"], result["pages"], len(result["cards"])), (13057, 66, 57))
        self.assertLess(len(json.dumps(result)), 60000)
        catalog = bulk_review.Catalog(self.root)
        first = catalog.get()
        self.assertIs(first, catalog.get())
        self.assertEqual(len(first["lookup"]), 13057)

    def test_serve_writes_preview_url_inside_web(self):
        with patch.object(self.server, "serve_forever"), patch.object(
                bulk_review, "make_server", return_value=self.server), patch.object(
                self.server, "server_close"), contextlib.redirect_stdout(io.StringIO()) as output:
            bulk_review.serve(self.root)
        info = common.load(self.root / "web/preview-info.json")
        self.assertEqual(info["url"], f"http://127.0.0.1:{self.server.server_port}/")
        self.assertTrue(info["local_only"])
        self.assertIn("PREVIEW_URL=" + info["url"], output.getvalue())
        self.assertEqual(self.request("/preview-info.json")[0], 404)


if __name__ == "__main__":
    unittest.main()
