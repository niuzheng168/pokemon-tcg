import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from mik_merge import common, preview, review, semantics, stage
from mik_merge_fixtures import create_run_inputs, fake_response, write


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.exports = self.root / "exports"
        p = patch.object(common, "EXPORTS", self.exports)
        p.start()
        self.addCleanup(p.stop)
        self.source, self.snapshot, self.selection, self.observations = create_run_inputs(self.root)
        self.run_dir = self.exports / "run"
        self.stage()
        semantics.configure(self.run_dir)

    def stage(self, selection=None, observations=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return stage.run(self.source, self.snapshot, selection or self.selection, self.run_dir,
                             observations or self.observations)

    def cloud(self, modifier=None):
        requests = []
        secret = "unit-only-secret-do-not-archive-0123456789"

        class Opener:
            def open(_self, request, timeout):
                payload = json.loads(request.data)
                response = fake_response(payload, requests)
                if modifier:
                    modifier(response, payload)
                raw = json.dumps(response).encode()

                class Response:
                    def __enter__(self):
                        return self

                    def __exit__(self, *args):
                        pass

                    def read(self, size):
                        return raw[:size]
                return Response()

        return requests, secret, patch.object(semantics, "credentials", return_value=("https://test.openai.azure.com/openai/v1", secret)), patch(
            "urllib.request.build_opener", return_value=Opener())

    def judge(self, modifier=None):
        requests, secret, credentials, transport = self.cloud(modifier)
        with credentials, transport, contextlib.redirect_stdout(io.StringIO()):
            result = semantics.run(True)
        return result, requests, secret

    def test_real_flow_and_cache_only_replay_never_read_credentials(self):
        report, requests, secret = self.judge()
        self.assertEqual(report["status_counts"], {"ready": 4, "needs_review": 1})
        self.assertEqual(len(requests), 8)
        self.assertTrue(report["calibration_passed"])
        self.assertEqual(report["model_reviewed_source_pairs"], 4)
        before = {r["mik_id"]: common.digest(r["merged_metadata_file"]) for r in report["results"]}
        with patch.object(semantics, "credentials", side_effect=AssertionError("credentials read")), patch(
                "urllib.request.build_opener", side_effect=AssertionError("network")), contextlib.redirect_stdout(io.StringIO()):
            replay = semantics.run(False)
        self.assertEqual(replay["fresh_requests_this_run"], 0)
        self.assertEqual(before, {r["mik_id"]: common.digest(r["merged_metadata_file"]) for r in replay["results"]})
        for path in (self.run_dir / "semantic-v2/cloud").glob("*.json"):
            self.assertNotIn(secret.encode(), path.read_bytes())
        for request in requests:
            for pair in json.loads(request["messages"][1]["content"])["pairs"]:
                self.assertNotIn("expected_accept", pair)
                self.assertNotIn("kind", pair)
                self.assertNotIn("card_id", pair)

    def test_human_and_engine_flags_not_changed_and_dar_stays_held(self):
        report, _, _ = self.judge()
        for result in report["results"]:
            metadata = common.load(result["merged_metadata_file"])
            base = common.load(result["base_merged_metadata_file"])
            self.assertFalse(metadata["human_reviewed"])
            self.assertFalse(metadata["rules_engine_implemented"])
            stripped = copy.deepcopy(metadata)
            stripped.pop("semantic_equivalence_review")
            stripped["review_flags"] = base["review_flags"]
            self.assertEqual(stripped, base)
        dar = next(r for r in report["results"] if r["mik_id"] == "TEST/DAR")
        self.assertEqual([h["code"] for h in dar["holds"]], ["printing_schema_unsupported"])

    def test_failed_calibration_cannot_be_hidden_by_hard_vetoes(self):
        def bad_first_control(response, payload):
            body = json.loads(payload["messages"][1]["content"])["pairs"]
            if any("每次" in p["left"] + p["right"] and "每个自己的回合仅可" in p["left"] + p["right"] for p in body):
                first = json.loads(response["choices"][0]["message"]["content"])
                row = first["results"][0]
                row["verdict"] = "equivalent"
                next(d for d in row["dimensions"] if d["dimension"] == "operations")["relation"] = "match"
                response["choices"][0]["message"]["content"] = json.dumps(first)
        report, _, _ = self.judge(bad_first_control)
        self.assertFalse(report["calibration_passed"])
        model_decisions = [d for d in report["decisions"] if d["reviews"]]
        self.assertTrue(all(not d["machine_accepted"] for d in model_decisions))
        self.assertTrue(all("calibration_not_passed" in d["hold_reasons"] for d in model_decisions))

    def test_tampered_cache_is_not_accepted_or_silently_refetched(self):
        self.judge()
        response = next((self.run_dir / "semantic-v2/cloud").glob("*.response.json"))
        response.write_bytes(response.read_bytes() + b" ")
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")), self.assertRaisesRegex(ValueError, "integrity"):
            semantics.run(False)

    def test_truncated_or_refused_response_fails_closed(self):
        def truncated(response, payload):
            response["choices"][0]["finish_reason"] = "length"
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            self.judge(truncated)
        self.assertFalse((self.run_dir / "semantic-v2/results.json").exists())

    def test_budget_fails_before_any_cloud_calls(self):
        pairs = semantics.source_pairs(common.load(self.run_dir / "pilot-results.json"))
        unresolved = [p for p in pairs if p["base_status"] == "needs_semantic_review"]
        with patch.object(semantics, "source_pairs", return_value=unresolved + [copy.deepcopy(unresolved[0])]), patch(
                "urllib.request.build_opener", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(ValueError, "requires 10 requests"):
                semantics.run(True)

    def test_no_unresolved_text_needs_no_calibration_or_network(self):
        selected = common.load(self.selection)
        selected["samples"] = [r for r in selected["samples"] if r["mik_id"] in ("TEST/004", "TEST/DAR")]
        write(self.selection, selected)
        self.stage()
        with patch("urllib.request.build_opener", side_effect=AssertionError("network")), contextlib.redirect_stdout(io.StringIO()):
            report = semantics.run(False)
        self.assertEqual(report["fresh_requests_this_run"], 0)
        self.assertFalse(report["calibration_required"])
        self.assertEqual(report["control_count"], 0)

    def test_selection_traversal_and_duplicate_ids_rejected(self):
        for samples in ([{"mik_id": "../source"}], [{"mik_id": "TEST/001", "batch": "../evil"}],
                        [{"mik_id": "TEST/001"}, {"mik_id": "TEST/001", "batch": "other"}]):
            write(self.selection, {"schema": "mik-52poke-selection-v1", "samples": samples})
            with self.assertRaises(ValueError):
                common.read_selection(self.selection)

    def test_output_cannot_escape_or_overlap_sources(self):
        for directory in (self.root, self.exports, self.source, common.TOOL / "library"):
            with self.assertRaises(ValueError):
                common.output_root(directory)
        link = self.run_dir / "escape"
        link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escapes"):
            common.write(self.run_dir, link / "bad.json", {})
        self.assertFalse((self.source / "bad.json").exists())

    def test_observation_requires_matching_image_hash(self):
        observations = common.load(self.observations)
        observations["observations"][0]["image_sha256"] = "0" * 64
        write(self.observations, observations)
        with self.assertRaisesRegex(ValueError, "image hash mismatch"):
            self.stage()

    def test_raw_response_hash_and_envelope_are_checked(self):
        path = self.source / "cards/TEST/001/source-response.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "receipt mismatch"):
            stage.validate_source("TEST/001")

    def test_damage_plus_and_unknown_templates_not_erased(self):
        directory = self.run_dir / "sample/candidates/TEST/004"
        raw = common.load(directory / "wiki-source.json")
        view = common.load(directory / "wiki-display.json")
        normalized, _, _ = stage.prepare_card(raw, view)
        self.assertEqual(raw["card_blocks"][0]["attacks"][0]["damage"], "180")
        self.assertEqual(normalized["card_blocks"][0]["attacks"][0]["damage"], "180+")
        mik = common.load(directory / "mik-metadata.json")
        mik["pokemonAttr"]["attack"][0]["damage"] = "180"
        self.assertFalse(all(stage.structural(mik, normalized["card_blocks"][0], normalized).values()))
        self.assertEqual(stage.render_known_wiki("{{TCG|链接目标|显示文字}}"), "显示文字")
        self.assertEqual(stage.render_known_wiki("{{unknown|1|2}}"), "{{unknown|1|2}}")

    def test_only_empty_vstar_wrapper_is_dropped(self):
        directory = self.run_dir / "sample/candidates/TEST/002"
        raw, view = common.load(directory / "wiki-source.json"), common.load(directory / "wiki-display.json")
        raw["card_blocks"][0]["abilities"][0]["fields"]["not_empty"] = "keep"
        normalized, _, _ = stage.prepare_card(raw, view)
        self.assertEqual(len(normalized["card_blocks"][0]["abilities"]), 2)

    def test_same_name_same_hp_wrong_attack_rejected_and_ambiguity_held(self):
        directory = self.run_dir / "sample/candidates/TEST/001"
        mik, raw, view = [common.load(directory / p) for p in ("mik-metadata.json", "wiki-source.json", "wiki-display.json")]
        wrong = copy.deepcopy(raw)
        wrong.update(page_id=999, id="52poke:999")
        wrong["card_blocks"][0]["attacks"][0]["damage"] = "999"
        chosen, candidates, _ = stage.Matcher({101: raw, 999: wrong}, {101: view, 999: view}).find(mik)
        self.assertEqual(chosen["page_id"], 101)
        self.assertTrue(next(c for c in candidates if c["page_id"] == 999)["failed"])
        wrong["card_blocks"][0]["attacks"][0]["damage"] = raw["card_blocks"][0]["attacks"][0]["damage"]
        chosen, _, _ = stage.Matcher({101: raw, 999: wrong}, {101: view, 999: view}).find(mik)
        self.assertIsNone(chosen)

    def test_effect_and_metadata_changes_invalidate_source_evidence(self):
        base = common.load(self.run_dir / "pilot-results.json")
        base["results"][0]["semantic_pairs"][1]["mik"] = "伪造效果"
        with self.assertRaisesRegex(ValueError, "source slot"):
            semantics.source_pairs(base)

    def test_credentials_are_explicit_and_azure_only(self):
        with patch.dict("os.environ", {"AOAI_ENDPOINT": "https://test.openai.azure.com/openai/v1", "FOUNDRY_KEY": "secret"}, clear=True):
            with self.assertRaisesRegex(ValueError, "azure-host"):
                semantics.credentials()
            semantics.configure(self.run_dir, azure_host="test.openai.azure.com")
            self.assertEqual(semantics.credentials(), ("https://test.openai.azure.com/openai/v1", "secret"))
        with patch.dict("os.environ", {"AOAI_ENDPOINT": "https://evil.invalid/openai/v1", "FOUNDRY_KEY": "secret"}, clear=True):
            semantics.configure(self.run_dir, azure_host="evil.invalid")
            with self.assertRaisesRegex(ValueError, "Azure service"):
                semantics.credentials()
        with self.assertRaisesRegex(ValueError, "distinct"):
            semantics.configure(self.run_dir, deployments=("same", "same"))

    def test_html_before_models_does_not_claim_semantic_approval(self):
        path = review.build(self.run_dir, self.root / "no-library")
        html = path.read_text()
        self.assertNotIn("/* REVIEW_DATA */", html)
        self.assertIn('"model_review_complete":false', html)
        self.assertIn("尚未完成语义核验", html)
        self.assertIn('connect-src \'none\'', html)
        self.assertIn("5 张", html)
        self.assertNotIn("20 张", html)

    def test_html_models_and_preview_do_not_expose_directory(self):
        self.judge()
        page = review.build(self.run_dir, self.root / "no-library")
        self.assertIn('"model_review_complete":true', page.read_text())
        server = preview.make_server(self.run_dir)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}"
            with urllib.request.urlopen(url + "/review.html") as response:
                self.assertEqual(response.read(), page.read_bytes())
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(url + "/results.json")
            self.assertEqual(error.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
