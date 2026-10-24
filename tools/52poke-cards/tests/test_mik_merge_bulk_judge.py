"""Synthetic/offline bulk tests: no real inference, NAS, or exported card data."""
import contextlib
import copy
import io
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error

from mik_merge import bulk_judge as bulk
from mik_merge import common, semantics, stage
from mik_merge_fixtures import create_run_inputs, fake_response, write


class BulkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.run_dir = self.root / "exports/run"
        self.addCleanup(patch.stopall)
        patch.object(common, "EXPORTS", self.root / "exports").start()
        self.source, self.snapshot, self.selection, self.observations = create_run_inputs(self.root)
        with contextlib.redirect_stdout(io.StringIO()):
            stage.run(self.source, self.snapshot, self.selection, self.run_dir, self.observations)
        self.base = common.load(self.run_dir / "pilot-results.json")
        # Exercise the full-stager's flat cards/SET/NUM layout, not pilot batches.
        for result in self.base["results"]:
            old = Path(result["merged_metadata_file"]).parent
            new = self.run_dir / "cards" / result["mik_id"]
            new.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(old, new)
            result["merged_metadata_file"] = str(new / "metadata.json")
        self.save()
        self.requests = []
        self.lock = threading.Lock()
        self.active, self.peak = {}, {}
        patch.object(bulk.RateGate, "wait", return_value=None).start()
        patch.object(bulk, "credentials", return_value=(
            "https://test.openai.azure.com/openai/v1", "unit-secret-never-archive")).start()
        self.modifier = None
        self.failure = None
        self.response_headers = {}
        outer = self

        class Opener:
            def open(self, request, timeout):
                payload = json.loads(request.data)
                deployment = payload["model"]
                with outer.lock:
                    outer.active[deployment] = outer.active.get(deployment, 0) + 1
                    outer.peak[deployment] = max(outer.peak.get(deployment, 0), outer.active[deployment])
                try:
                    # Ensure workers overlap; only a mocked transport is used.
                    time.sleep(0.002)
                    if outer.failure:
                        outer.failure(payload)
                    with outer.lock:
                        response = fake_response(payload, outer.requests)
                    if outer.modifier:
                        outer.modifier(response, payload)
                    raw = response if isinstance(response, bytes) else json.dumps(response).encode()

                    class Response:
                        headers = outer.response_headers

                        def __enter__(self):
                            return self

                        def __exit__(self, *args):
                            pass

                        def read(self, size):
                            return raw[:size]
                    return Response()
                finally:
                    with outer.lock:
                        outer.active[deployment] -= 1

        patch("urllib.request.build_opener", return_value=Opener()).start()

    def save(self):
        write(self.run_dir / "pilot-results.json", self.base)

    def judge(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return bulk.run(self.run_dir, max_requests=kwargs.pop("max_requests", 100),
                            run_azure=kwargs.pop("run_azure", True), **kwargs)

    def offline(self):
        return patch("urllib.request.build_opener", side_effect=AssertionError("network"))

    def clone(self, source="TEST/002", number="006", suffix=""):
        original = next(r for r in self.base["results"] if r["mik_id"] == source)
        result = copy.deepcopy(original)
        old = Path(original["merged_metadata_file"]).parent
        card = "TEST/" + number
        new = self.run_dir / "cards" / card
        shutil.copytree(old, new)
        result["mik_id"], result["merged_metadata_file"] = card, str(new / "metadata.json")
        mik = common.load(new / "mik-metadata.json")
        mik["cardIndex"] = number
        if suffix:
            mik["pokemonAttr"]["ability"][0]["text"] += suffix
            view = common.load(new / "normalized-wiki-display.json")
            view["blocks"][0]["abilities"][0]["display"]["effect"] += suffix
            write(new / "normalized-wiki-display.json", view)
            for pair in result["semantic_pairs"]:
                if pair["field"] == "abilities.0.effect":
                    pair["mik"] += suffix
                    pair["wiki"] += suffix
        write(new / "mik-metadata.json", mik)
        result["input_hashes"]["metadata_sha256"] = common.digest(new / "mik-metadata.json")
        self.base["results"].append(result)
        self.save()
        return result

    def source_request(self, payload):
        visible = json.loads(payload["messages"][1]["content"])["pairs"]
        return any("丢弃自己牌库顶的7张卡" in p["left"] + p["right"] for p in visible)

    def test_plan_offline_and_full_calibration_hashes_unchanged(self):
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            plan = bulk.plan(self.run_dir, max_requests=8, env="/nonexistent/.env.foundry")
        self.assertEqual(plan["exact_unique_body_count"], 3)
        self.assertEqual(plan["model_source_pair_count"], 4)
        self.assertEqual(plan["deduplicated_source_pair_count"], 1)
        self.assertEqual(plan["planned_request_count"], 8)
        self.assertEqual(plan["calibration_request_count"], 6)
        self.assertEqual(common.load(self.run_dir / "semantic-plan.json"), plan)
        self.assertFalse((self.run_dir / "semantic-v2/cloud").exists())
        # Have the unmodified pilot transport construct/cache its six requests.
        semantics.configure(self.run_dir, max_requests=8)
        client = semantics.Foundry(True)
        with patch.object(semantics, "credentials", return_value=(
                "https://test.openai.azure.com/openai/v1", "unit-secret")), contextlib.redirect_stdout(io.StringIO()):
            for offset in range(0, 12, 4):
                for reviewer in (0, 1):
                    client.review(semantics.controls()[offset:offset + 4], reviewer, f"old-group-{offset}-{reviewer}")
        cached = bulk.plan(self.run_dir, max_requests=2)
        self.assertEqual(cached["cached_request_count"], 6)
        self.assertEqual(cached["uncached_request_count"], 2)
        self.assertEqual({r["request_sha256"] for r in cached["requests"][:6]},
                         {r["request_sha256"] for r in client.receipts})

    def test_real_mocked_flow_exact_dedup_and_immutable_sources(self):
        before = {str(p): common.digest(p) for p in (self.run_dir / "cards").rglob("*") if p.is_file()}
        report = self.judge(max_requests=8)
        self.assertTrue(report["calibration_passed"])
        self.assertEqual(len(report["calibration"]["controls"]), 12)
        self.assertEqual(report["fresh_requests_this_run"], 8)
        self.assertEqual(report["status_counts"], {"ready": 4, "needs_review": 1})
        self.assertEqual(report["counters"]["deduplicated_pairs"], 1)
        self.assertEqual(report["usage"]["total_tokens"], 16)
        self.assertEqual(before, {str(p): common.digest(p) for p in (self.run_dir / "cards").rglob("*") if p.is_file()})
        self.assertEqual([r["mik_id"] for r in report["results"]], [r["mik_id"] for r in self.base["results"]])
        d2, d3 = (next(d for d in report["decisions"] if d["id"] == f"TEST/00{i}:abilities.0.effect") for i in (2, 3))
        self.assertNotEqual(d2["input_sha256"], d3["input_sha256"])
        self.assertFalse(d2["reviews"][0]["propagated_exact_duplicate"])
        self.assertTrue(d3["reviews"][0]["propagated_exact_duplicate"])
        for result in report["results"]:
            path = Path(result["merged_metadata_file"])
            self.assertEqual(path, self.run_dir / "semantic-v2/candidates" / result["mik_id"] / "metadata.json")
            metadata = common.load(path)
            self.assertFalse(metadata["human_reviewed"])
            self.assertFalse(metadata["rules_engine_implemented"])
        progress = common.load(self.run_dir / "judge-progress.json")
        self.assertEqual(progress["phase"], "complete")
        self.assertEqual(progress["actual_calls"], 8)
        ledger = common.load(self.run_dir / "semantic-v2/attempt-ledger.json")["attempts"]
        self.assertEqual(len(ledger), 8)
        self.assertTrue(all(a["status"] == "complete" and a["response_sha256"] for a in ledger))
        self.assertTrue(all("unit-secret" not in p.read_text() for p in (self.run_dir / "semantic-v2").rglob("*.json")))
        for payload in self.requests:
            for pair in json.loads(payload["messages"][1]["content"])["pairs"]:
                self.assertEqual(set(pair), {"pair_id", "left", "right", "left_spans", "right_spans"})

    def test_cache_only_replay_does_not_read_credentials_and_preserves_metadata(self):
        first = self.judge(max_requests=8)
        before = {r["mik_id"]: common.digest(r["merged_metadata_file"]) for r in first["results"]}
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            replay = self.judge(run_azure=False, max_requests=1)
        self.assertEqual(replay["fresh_requests_this_run"], 0)
        self.assertEqual(replay["counters"]["cache_hits"], 8)
        self.assertEqual(replay["usage"]["total_tokens"], 16)
        self.assertEqual(before, {r["mik_id"]: common.digest(r["merged_metadata_file"]) for r in replay["results"]})
        self.assertEqual(len(common.load(self.run_dir / "semantic-v2/attempt-ledger.json")["attempts"]), 8)

    def test_repeatable_cache_sources_seed_hash_triples_not_results(self):
        self.judge()
        cloud = self.run_dir / "semantic-v2/cloud"
        one, two = self.root / "seed-one", self.root / "seed-two"
        one.mkdir()
        two.mkdir()
        for i, request in enumerate(sorted(cloud.glob("*.request.json"))):
            prefix = str(request)[:-len(".request.json")]
            target = one if i % 2 else two
            for kind in ("request", "response", "receipt"):
                shutil.copyfile(prefix + f".{kind}.json", target / f"unrelated-group-{i}.{kind}.json")
        write(one / "results.json", {"calibration_passed": False, "results": ["untrusted"]})
        original_bytes = {str(p): p.read_bytes() for p in one.glob("*")}
        shutil.rmtree(self.run_dir / "semantic-v2")
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            replay = self.judge(run_azure=False, max_requests=1, cache_sources=(one, two))
        self.assertTrue(replay["calibration_passed"])
        self.assertEqual(replay["fresh_requests_this_run"], 0)
        self.assertEqual(replay["counters"]["cache_hits"], 8)
        self.assertEqual(original_bytes, {str(p): p.read_bytes() for p in one.glob("*")})

    def test_tampered_calibration_cache_fails_closed_without_refetch(self):
        self.judge()
        response = next((self.run_dir / "semantic-v2/cloud").glob("controls-*.response.json"))
        response.write_bytes(response.read_bytes() + b" ")
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            report = self.judge(max_requests=8)
        self.assertFalse(report["calibration_passed"])
        self.assertEqual(report["fresh_requests_this_run"], 0)
        self.assertTrue(any(r.get("error_code") == "cache_integrity_error" for r in report["requests"]))
        self.assertTrue(all(not d["machine_accepted"] for d in report["decisions"] if d["reviews"]))

    def test_corrupt_request_bytes_and_receipt_never_trigger_refetch(self):
        self.judge()
        request = next((self.run_dir / "semantic-v2/cloud").glob("source-pairs-*.request.json"))
        request.write_bytes(request.read_bytes() + b" ")
        with self.offline():
            report = self.judge()
        self.assertTrue(report["calibration_passed"])
        self.assertEqual(report["fresh_requests_this_run"], 0)
        self.assertTrue(any(d.get("request_diagnostics") for d in report["decisions"]))
        self.assertTrue(all(not d["machine_accepted"] for d in report["decisions"] if d["reviews"]))

    def test_budget_is_preflighted_after_plan_before_any_calls(self):
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            with self.assertRaisesRegex(ValueError, "max-requests"):
                self.judge(max_requests=7)
        self.assertFalse(common.load(self.run_dir / "semantic-plan.json")["budget_sufficient"])
        self.assertFalse((self.run_dir / "semantic-v2/attempt-ledger.json").exists())

    def test_offline_missing_cache_returns_all_cards_held_not_catastrophic(self):
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            report = self.judge(run_azure=False, max_requests=1)
        self.assertEqual(len(report["results"]), 5)
        self.assertFalse(report["calibration_passed"])
        self.assertEqual(report["fresh_requests_this_run"], 0)
        self.assertTrue(any(o.get("error_code") == "matching_cache_missing" for o in report["requests"]))
        self.assertTrue((self.run_dir / "judge-progress.json").is_file())

    def test_blocked_card_and_all_nonsemantic_holds_are_preserved(self):
        for result in self.base["results"]:
            result["holds"].extend([
                {"code": "card_face_identity_not_independently_checked", "detail": "Do not remove."},
                {"code": "trainer_effect_slot_alignment_ambiguous", "detail": "Do not flatten."},
            ])
        self.base["results"].append({
            "mik_id": "TEST/BLOCKED", "chosen": None, "status": "blocked",
            "holds": [{"code": "no_unique_structurally_compatible_candidate"}], "semantic_pairs": [],
        })
        self.save()
        report = self.judge()
        self.assertEqual(len(report["results"]), 6)
        self.assertEqual(report["results"][-1]["status"], "blocked")
        self.assertEqual(report["results"][-1]["semantic_equivalence"], [])
        for original, result in zip(self.base["results"], report["results"]):
            nonsemantic = [h for h in original["holds"] if h["code"] != "effect_semantics_unresolved"]
            self.assertTrue(all(h in result["holds"] for h in nonsemantic))
            if original["chosen"]:
                self.assertEqual(result["status"], "needs_review")

    def test_refinement_paths_and_output_directory_are_preserved(self):
        result = self.base["results"][1]
        old = Path(result["merged_metadata_file"]).parent
        directory = self.run_dir / "refinement/cards" / result["mik_id"]
        directory.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(old, directory)
        result["merged_metadata_file"] = str(directory / "metadata.json")
        result["output_directory"] = str(directory)
        self.save()
        report = self.judge()
        refined = report["results"][1]
        self.assertEqual(refined["output_directory"], str(directory))
        self.assertEqual(refined["base_merged_metadata_file"], str(directory / "metadata.json"))
        self.assertEqual(refined["merged_metadata_file"], str(
            self.run_dir / "semantic-v2/candidates/TEST/002/metadata.json"))
        self.assertTrue(refined["semantic_equivalence"])
        self.assertTrue(all(d["machine_accepted"] for d in refined["semantic_equivalence"]))

    def test_invalid_one_slot_does_not_discard_other_cards_or_request_it(self):
        original = self.base["results"][0]
        original["semantic_pairs"][0]["mik"] = "伪造源文本。"
        self.save()
        report = self.judge()
        decision = next(d for d in report["decisions"] if d["id"].endswith(":attacks.0.effect"))
        self.assertFalse(decision["machine_accepted"])
        self.assertIn("source_validation_failed", decision["hold_reasons"])
        self.assertTrue(any(d["machine_accepted"] and d["card_id"] == "TEST/002" for d in report["decisions"]))
        self.assertEqual(len(report["results"]), len(self.base["results"]))

    def test_ambiguous_field_is_retained_for_review(self):
        self.base["results"][0]["semantic_pairs"][0]["field"] = "attacks.-1.effect"
        self.save()
        report = self.judge()
        self.assertEqual(report["results"][0]["status"], "needs_review")
        self.assertTrue(any(d["field"] == "attacks.-1.effect" and not d["machine_accepted"]
                            for d in report["decisions"]))

    def test_no_model_work_needs_no_calibration(self):
        self.base["results"] = [r for r in self.base["results"] if r["mik_id"] in ("TEST/004", "TEST/DAR")]
        self.save()
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            report = self.judge(max_requests=1)
        self.assertFalse(report["calibration_required"])
        self.assertEqual(report["control_count"], 0)
        self.assertEqual(report["fresh_requests_this_run"], 0)

    def test_hard_veto_is_not_sent_to_models_or_removed(self):
        # A literal, frozen number disagreement; not a fabricated report slot.
        result = self.base["results"][1]
        directory = Path(result["merged_metadata_file"]).parent
        view = common.load(directory / "normalized-wiki-display.json")
        view["blocks"][0]["abilities"][0]["display"]["effect"] = (
            view["blocks"][0]["abilities"][0]["display"]["effect"].replace("7张", "8张"))
        write(directory / "normalized-wiki-display.json", view)
        next(p for p in result["semantic_pairs"] if p["field"] == "abilities.0.effect")["wiki"] = (
            view["blocks"][0]["abilities"][0]["display"]["effect"])
        self.save()
        report = self.judge()
        self.assertEqual(report["skipped_by_hard_veto"], 1)
        self.assertEqual(report["counters"]["skipped_by_hard_veto"], 1)
        decision = next(d for d in report["decisions"] if d["id"] == "TEST/002:abilities.0.effect")
        self.assertFalse(decision["machine_accepted"])
        self.assertEqual(decision["reviews"], [])
        self.assertEqual(decision["model_skipped"], "hard_veto")
        self.assertIn("nonunit_number_mismatch", decision["hold_reasons"])
        for payload in self.requests:
            for pair in json.loads(payload["messages"][1]["content"])["pairs"]:
                self.assertNotIn("丢弃自己牌库顶的8张卡", pair["left"] + pair["right"])

    def test_oversized_source_slot_is_individually_held(self):
        result = self.base["results"][1]
        directory = Path(result["merged_metadata_file"]).parent
        mik = common.load(directory / "mik-metadata.json")
        suffix = "抽卡。" * 1400
        mik["pokemonAttr"]["ability"][0]["text"] += suffix
        write(directory / "mik-metadata.json", mik)
        result["input_hashes"]["metadata_sha256"] = common.digest(directory / "mik-metadata.json")
        pair = next(p for p in result["semantic_pairs"] if p["field"] == "abilities.0.effect")
        pair["mik"] += suffix
        self.save()
        report = self.judge()
        decision = next(d for d in report["decisions"] if d["id"] == "TEST/002:abilities.0.effect")
        self.assertFalse(decision["machine_accepted"])
        self.assertIn("effect_text_exceeds_bound", decision["hold_reasons"])
        self.assertEqual(report["skipped_oversized_pairs"], 1)
        self.assertTrue(report["calibration_passed"])
        self.assertTrue(any(d["machine_accepted"] for d in report["decisions"] if d["reviews"]))

    def test_calibration_failure_or_uncertainty_stops_real_source_requests(self):
        def wrong(response, payload):
            data = json.loads(response["choices"][0]["message"]["content"])
            # A negative control's uncertainty must not count as passing.
            if any("每个自己的回合仅可" in p["left"] + p["right"]
                   for p in json.loads(payload["messages"][1]["content"])["pairs"]):
                data["results"][0]["verdict"] = "uncertain"
                response["choices"][0]["message"]["content"] = json.dumps(data)
        self.modifier = wrong
        report = self.judge()
        self.assertFalse(report["calibration_passed"])
        self.assertEqual(report["fresh_requests_this_run"], 6)
        self.assertFalse(any(self.source_request(payload) for payload in self.requests))
        model = [d for d in report["decisions"] if d["field"] == "abilities.0.effect" and d["card_id"] == "TEST/002"][0]
        self.assertFalse(model["machine_accepted"])
        self.assertIn("calibration_not_passed", model["hold_reasons"])

    def test_source_http_failure_is_local_sanitized_and_never_retried(self):
        def failure(payload):
            if self.source_request(payload) and payload["model"] == semantics.DEFAULT_DEPLOYMENTS[0]:
                raise urllib.error.HTTPError("https://secret.invalid", 429, "provider-secret-body", {}, io.BytesIO(b"SECRET"))
        self.failure = failure
        report = self.judge()
        self.assertTrue(report["calibration_passed"])
        self.assertEqual(report["fresh_requests_this_run"], 8)
        self.assertEqual(report["counters"]["failed_requests"], 1)
        self.assertEqual(len(report["results"]), 5)
        self.assertTrue(any(o.get("http_status") == 429 for o in report["requests"]))
        ledger = common.load(self.run_dir / "semantic-v2/attempt-ledger.json")
        self.assertEqual(len(ledger["attempts"]), 8)
        self.assertEqual(sum(a["status"] == "failed" for a in ledger["attempts"]), 1)
        for path in (self.run_dir / "semantic-v2").rglob("*.json"):
            self.assertNotIn("provider-secret-body", path.read_text())
        with self.offline():
            replay = self.judge()
        self.assertEqual(replay["fresh_requests_this_run"], 0)
        self.assertTrue(any(o.get("error_code") == "previous_attempt_without_valid_cache" for o in replay["requests"]))

    def test_invalid_output_retains_raw_hash_usage_and_other_chunk_success(self):
        for i in range(6, 12):
            self.clone(number=f"{i:03d}", suffix=f"然后抽{i}张卡。")

        def invalid(response, payload):
            visible = json.loads(payload["messages"][1]["content"])["pairs"]
            if self.source_request(payload) and any("抽11张卡" in p["left"] + p["right"] for p in visible):
                response["choices"][0]["finish_reason"] = "length"
        self.modifier = invalid
        report = self.judge()
        self.assertEqual(report["counters"]["failed_requests"], 2)
        self.assertTrue(report["calibration_passed"])
        self.assertTrue(any(d["machine_accepted"] for d in report["decisions"] if d["reviews"]))
        self.assertEqual(report["usage"]["total_tokens"], report["fresh_requests_this_run"] * 2)
        failed = [o for o in report["requests"] if o["status"] != "complete"]
        self.assertTrue(all(o["response_sha256"] and o["usage"] for o in failed))
        progress = common.load(self.run_dir / "judge-progress.json")
        self.assertEqual(progress["completed_requests"], report["planned_request_count"])
        self.assertEqual(progress["error_count"], 2)

    def test_exact_not_normalized_dedup_and_verified_context_meaning(self):
        semantics.configure(self.run_dir)
        pair = semantics.source_pairs(self.base)[1]
        other = copy.deepcopy(pair)
        other["context"].update(source_file="/different", source_slot="different", source_sha256="f" * 64)
        self.assertEqual(bulk.body_key(pair), bulk.body_key(other))
        other["context"]["mechanic_rule"] = "unverified different rule"
        self.assertNotEqual(bulk.body_key(pair), bulk.body_key(other))
        other = copy.deepcopy(pair)
        other["left"] = " " + other["left"]
        self.assertEqual(semantics.layout(pair["left"]), semantics.layout(other["left"]))
        self.assertNotEqual(bulk.body_key(pair), bulk.body_key(other))
        other = copy.deepcopy(pair)
        other["right"] = other["left"]
        other["left"] = pair["right"]
        self.assertNotEqual(bulk.body_key(pair), bulk.body_key(other))

    def test_duplicate_propagation_revalidates_literal_evidence(self):
        report = self.judge()
        semantics.configure(self.run_dir)
        pairs = semantics.source_pairs(self.base)
        original = next(p for p in pairs if p["id"] == "TEST/002:abilities.0.effect")
        target = next(p for p in pairs if p["id"] == "TEST/003:abilities.0.effect")
        row = copy.deepcopy(next(d for d in report["decisions"] if d["id"] == original["id"])["reviews"][0])
        bulk.propagate_review(target, original, row)
        next(d for d in row["dimensions"] if d["dimension"] == "operations")["left_spans"][0]["text"] = "伪造引文"
        with self.assertRaisesRegex(ValueError, "Duplicate evidence"):
            bulk.propagate_review(target, original, row)

    def test_concurrency_is_bounded_separately_for_both_deployments(self):
        for i in range(6, 28):
            self.clone(number=f"{i:03d}", suffix=f"然后抽{i}张卡。")
        report = self.judge(workers_per_deployment=2)
        self.assertTrue(report["calibration_passed"])
        self.assertEqual(set(self.peak), set(semantics.DEFAULT_DEPLOYMENTS))
        self.assertTrue(all(1 < peak <= 2 for peak in self.peak.values()))
        self.assertEqual(report["fresh_requests_this_run"], len(self.requests))
        self.assertLessEqual(report["fresh_requests_this_run"], report["max_requests"])

    def test_cli_explicit_budget_and_ceiling_validation(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            bulk.main(["plan", "--run-dir", str(self.run_dir)])
        for options in ({"max_requests": 0}, {"max_requests": 1, "workers_per_deployment": 9},
                        {"max_requests": 1, "requests_per_minute": 21},
                        {"max_requests": 1, "deployments": ("same", "same")}):
            with self.assertRaises(ValueError):
                bulk.plan(self.run_dir, **options)
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            with contextlib.redirect_stdout(io.StringIO()):
                result = bulk.main(["plan", "--run-dir", str(self.run_dir), "--max-requests", "8", "--run-azure"])
        self.assertEqual(result["network_requests_made"], 0)

    def test_generated_selection_inside_run_is_hash_bound_and_not_external_input(self):
        selection = self.run_dir / "full-selection.json"
        shutil.copyfile(self.selection, selection)
        self.base["selection_sha256"] = common.digest(selection)
        self.save()
        saved = common.load(self.run_dir / "run-inputs.json")
        saved["selection"] = str(selection)
        write(self.run_dir / "run-inputs.json", saved)
        with self.offline(), patch.object(bulk, "credentials", side_effect=AssertionError("secrets")):
            plan = bulk.plan(self.run_dir, max_requests=8, workers_per_deployment=8)
        self.assertEqual(plan["workers_per_deployment"], 8)
        self.assertEqual(plan["planned_request_count"], 8)
        selection.write_bytes(selection.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "frozen report hash"):
            bulk.plan(self.run_dir, max_requests=8)

    def test_generated_selection_may_not_be_symlink_or_arbitrary_internal_input(self):
        saved = common.load(self.run_dir / "run-inputs.json")
        self.base["selection_sha256"] = common.digest(self.selection)
        self.save()
        internal = self.run_dir / "full-selection.json"
        internal.symlink_to(self.selection)
        saved["selection"] = str(internal)
        write(self.run_dir / "run-inputs.json", saved)
        with self.assertRaises(ValueError):
            bulk.plan(self.run_dir, max_requests=8)
        internal.unlink()
        other = self.run_dir / "arbitrary-selection.json"
        shutil.copyfile(self.selection, other)
        internal.symlink_to(other)
        with self.assertRaises(ValueError):
            bulk.plan(self.run_dir, max_requests=8)
        saved["selection"] = str(other)
        write(self.run_dir / "run-inputs.json", saved)
        with self.assertRaises(ValueError):
            bulk.plan(self.run_dir, max_requests=8)

    def test_generated_selection_does_not_exempt_other_protected_inputs(self):
        selection = self.run_dir / "full-selection.json"
        shutil.copyfile(self.selection, selection)
        self.base["selection_sha256"] = common.digest(selection)
        self.save()
        original = common.load(self.run_dir / "run-inputs.json")
        for key in ("source", "snapshot", "observations"):
            saved = {**original, "selection": str(selection), key: str(self.run_dir / key)}
            write(self.run_dir / "run-inputs.json", saved)
            with self.assertRaises(ValueError):
                bulk.plan(self.run_dir, max_requests=8)
        # An external ancestor selection is still a protected input, not owned.
        write(self.run_dir / "run-inputs.json", {**original, "selection": str(self.root)})
        with self.assertRaises(ValueError):
            bulk.plan(self.run_dir, max_requests=8)

    def test_network_receipts_only_capture_allowlisted_rate_headers(self):
        self.response_headers = {
            "X-RateLimit-Limit-Tokens": "1000000", "x-ratelimit-remaining-tokens": "900000",
            "x-ratelimit-limit-requests": "1000", "x-ratelimit-reset-tokens": "1m5s",
            "Retry-After": "3", "api-key": "unit-secret", "Authorization": "Bearer unit-secret",
            "x-provider-body": "private-provider-body",
        }
        report = self.judge(workers_per_deployment=8)
        self.assertTrue(report["calibration_passed"])
        self.assertEqual(report["workers_per_deployment"], 8)
        self.assertEqual(report["requests_per_minute"], 20)
        self.assertEqual(report["token_pacing"]["reservation_limits"], {
            semantics.DEFAULT_DEPLOYMENTS[0]: 800000, semantics.DEFAULT_DEPLOYMENTS[1]: 400000})
        expected = {k.lower(): v for k, v in self.response_headers.items() if k.lower() in bulk.RATE_LIMIT_HEADERS}
        for receipt_file in (self.run_dir / "semantic-v2/cloud").glob("*.receipt.json"):
            receipt = common.load(receipt_file)
            self.assertEqual(receipt["rate_limit_headers"], expected)
            self.assertGreater(receipt["token_reservation"], 11000)
            self.assertLessEqual(receipt["token_reservation"], receipt["rolling_token_reservation_limit"])
        self.assertTrue(all(o["rate_limit_headers"] == expected for o in report["requests"]))
        with self.offline():
            replay = self.judge(run_azure=False, max_requests=1)
        self.assertEqual(replay["token_reservations"], {})
        self.assertTrue(all(o["rate_limit_headers"] == expected for o in replay["requests"]))

    def test_http_failure_headers_have_separate_nonreplayable_error_receipt(self):
        def failure(payload):
            if self.source_request(payload) and payload["model"] == semantics.DEFAULT_DEPLOYMENTS[0]:
                raise urllib.error.HTTPError("https://not-logged.invalid", 429, "private-body", {
                    "retry-after": "60", "x-ratelimit-remaining-tokens": "0",
                    "authorization": "private-key",
                }, io.BytesIO(b"private body"))
        self.failure = failure
        report = self.judge()
        failed = next(o for o in report["requests"] if o.get("http_status") == 429)
        self.assertEqual(failed["rate_limit_headers"], {"retry-after": "60", "x-ratelimit-remaining-tokens": "0"})
        receipt = common.load(failed["error_receipt_file"])
        self.assertEqual(receipt["rate_limit_headers"], failed["rate_limit_headers"])
        self.assertFalse(receipt["model_response_body_archived"])
        self.assertNotIn("response_sha256", receipt)


class RateAndCredentialTests(unittest.TestCase):
    def test_rate_gate_rolling_minute_and_spacing(self):
        # Use the real method despite BulkTests' per-test transport patches.
        now = [0.0]
        calls = []
        with patch.object(bulk.time, "monotonic", side_effect=lambda: now[0]), patch.object(
                bulk.time, "sleep", side_effect=lambda delay: now.__setitem__(0, now[0] + delay)):
            gate = bulk.RateGate(20)
            for _ in range(45):
                gate.wait()
                calls.append(now[0])
        self.assertTrue(all(b - a >= 3 for a, b in zip(calls, calls[1:])))
        self.assertTrue(all(sum(t <= other < t + 60 for other in calls) <= 20 for t in calls))

    def test_combined_token_reservations_are_rolling_and_do_not_relax_rpm(self):
        now, calls = [0.0], []
        with patch.object(bulk.time, "monotonic", side_effect=lambda: now[0]), patch.object(
                bulk.time, "sleep", side_effect=lambda delay: now.__setitem__(0, now[0] + delay)):
            gate = bulk.RateGate(20, token_limit=100)
            for reserved in (60, 40, 1, 60, 39, 100):
                gate.wait(reserved)
                calls.append((now[0], reserved))
        self.assertEqual(calls[:3], [(0.0, 60), (3.0, 40), (60.0, 1)])
        for start, _ in calls:
            self.assertLessEqual(sum(tokens for at, tokens in calls if start <= at < start + 60), 100)
        self.assertTrue(all(b[0] - a[0] >= 3 for a, b in zip(calls, calls[1:])))
        with self.assertRaises(bulk.Diagnostic):
            gate.wait(101)

    def test_rate_header_allowlist_rejects_control_text_and_secret_fields(self):
        result = bulk.rate_limit_headers({
            "x-ratelimit-limit-tokens": "800000", "x-ratelimit-reset-tokens": "1m2s",
            "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
            "x-ratelimit-remaining-tokens": "private-secret",
            "x-ratelimit-limit-requests": "20\nprivate",
            "x-ratelimit-reset-requests": "x" * 129,
            "authorization": "Bearer secret",
        })
        self.assertEqual(set(result), {"x-ratelimit-limit-tokens", "x-ratelimit-reset-tokens", "retry-after"})

    def test_only_explicit_dotenv_api_key_and_clean_matching_azure_host(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / ".env.foundry"
            path.write_text("AOAI_ENDPOINT=https://test.openai.azure.com/openai/v1\nFOUNDRY_KEY=file-key\n")
            with patch.dict("os.environ", {"AOAI_ENDPOINT": "https://evil.invalid", "FOUNDRY_KEY": "process-key"}):
                self.assertEqual(bulk.credentials(path, "test.openai.azure.com"), (
                    "https://test.openai.azure.com/openai/v1", "file-key"))
            with self.assertRaises(ValueError):
                bulk.credentials(path, "other.openai.azure.com")
            for endpoint in ("http://test.openai.azure.com/openai/v1",
                             "https://test.openai.azure.com/openai/v1?x=1",
                             "https://test.openai.azure.com:444/openai/v1",
                             "https://key@test.openai.azure.com/openai/v1",
                             "https://evil.invalid/openai/v1"):
                path.write_text(f"AOAI_ENDPOINT={endpoint}\nFOUNDRY_KEY=file-key\n")
                with self.assertRaises(ValueError):
                    bulk.credentials(path, "test.openai.azure.com")
            path.write_text("AOAI_ENDPOINT=https://test.openai.azure.com/openai/v1\nAZURE_ACCESS_TOKEN=not-an-api-key\n")
            with self.assertRaises(ValueError):
                bulk.credentials(path, "test.openai.azure.com")


if __name__ == "__main__":
    unittest.main()
