"""Offline tests: acceptance gates, exact evidence, immutable base and cache reuse."""
import copy
import json
from pathlib import Path
import unittest

from mik_merge import semantics as engine
from mik_merge import common, stage
from mik_merge_fixtures import create_run_inputs
import contextlib
import io
import tempfile
from unittest.mock import patch


def fixture():
    pair = {"pair_id": "p000", "left": "抽1张卡。", "right": "抽1张卡。", "context": {}}
    pair["left_spans"] = engine.make_spans(pair["left"], "L")
    pair["right_spans"] = engine.make_spans(pair["right"], "R")
    dimensions = [
        {"dimension": key, "relation": "absent", "left_evidence_ids": [], "right_evidence_ids": [],
         "explanation": "双方未说明。"}
        for key in engine.DIMENSIONS
    ]
    for row in dimensions:
        if row["dimension"] in ("amounts", "operations"):
            row.update(relation="match", left_evidence_ids=["L0"], right_evidence_ids=["R0"])
    response = {"results": [{"pair_id": "p000", "verdict": "equivalent", "summary": "同文。",
                             "dimensions": dimensions}]}
    return pair, response


class Gates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.exports_patch = patch.object(common, "EXPORTS", cls.root / "exports")
        cls.exports_patch.start()
        source, snapshot, selection, observations = create_run_inputs(cls.root)
        cls.run_dir = cls.root / "exports/run"
        with contextlib.redirect_stdout(io.StringIO()):
            stage.run(source, snapshot, selection, cls.run_dir, observations)

    @classmethod
    def tearDownClass(cls):
        cls.exports_patch.stop()
        cls.tmp.cleanup()

    def setUp(self):
        engine.configure(self.run_dir)

    def test_operators_not_erased(self):
        self.assertNotEqual(engine.layout("-20"), engine.layout("+20"))
        self.assertNotEqual(engine.layout("最多2张"), engine.layout("2张"))
        self.assertNotEqual(engine.layout("每次"), engine.layout("每回合"))

    def test_original_numeric_and_frequency_controls_veto(self):
        controls = {c["id"]: c for c in engine.controls()}
        self.assertIn("per_event_vs_explicit_once_per_turn", engine.hard_checks(controls["control:event_vs_turn"])["vetoes"])
        self.assertIn("signed_amount_mismatch", engine.hard_checks(controls["control:minus_vs_plus"])["vetoes"])
        self.assertIn("nonunit_number_mismatch", engine.hard_checks(controls["control:discard_count"])["vetoes"])

    def test_rule_reminder_requires_exact_context(self):
        pair = next(c for c in engine.controls() if c["id"] == "control:scoped_reminder")
        self.assertEqual(engine.hard_checks(pair)["vetoes"], [])
        pair["context"] = {}
        self.assertIn("unverified_mechanic_reminder", engine.hard_checks(pair)["vetoes"])
        pair["context"] = {"mechanic": "GX", "slot_template": "卡牌信息/power",
                           "mechanic_rule": engine.RULES["GX"]["rule"]}
        self.assertIn("unverified_mechanic_reminder", engine.hard_checks(pair)["vetoes"])

    def test_model_not_given_expected_answers_or_source_names(self):
        pair = engine.controls()[0]
        visible = engine.visible_pair(pair, 0, True)
        self.assertEqual(visible["left"], pair["right"])
        self.assertEqual(set(visible), {"pair_id", "left", "right", "left_spans", "right_spans"})
        self.assertNotIn("expected", json.dumps(visible))
        self.assertNotIn("event_vs_turn", json.dumps(visible))

    def test_valid_exact_evidence(self):
        pair, response = fixture()
        self.assertEqual(engine.validate_output(response, [pair])["p000"]["verdict"], "equivalent")

    def test_fabricated_quote_fails_closed(self):
        pair, response = fixture()
        pair["left_spans"][0]["text"] = "抽2张卡。"
        with self.assertRaisesRegex(ValueError, "literal"):
            engine.validate_output(response, [pair])

    def test_unknown_evidence_id_fails_closed(self):
        pair, response = fixture()
        response["results"][0]["dimensions"][5]["left_evidence_ids"] = ["R0"]
        with self.assertRaisesRegex(ValueError, "unknown"):
            engine.validate_output(response, [pair])

    def test_spans_and_derived_quotes_preserve_original_text(self):
        pair, response = fixture()
        result = engine.validate_output(response, [pair])
        self.assertEqual(result["p000"]["dimensions"][5]["left_quotes"], ["抽1张卡。"])
        text = "抽1张卡。\n然后弃2张卡。[每次触发。]"
        for span in engine.make_spans(text, "L"):
            self.assertEqual(text[span["start"]:span["end"]], span["text"])

    def test_absent_condition_can_cite_literal_text_to_show_no_extra_condition(self):
        pair, response = fixture()
        response["results"][0]["dimensions"][6].update(left_evidence_ids=["L0"], right_evidence_ids=["R0"])
        self.assertEqual(engine.validate_output(response, [pair])["p000"]["verdict"], "equivalent")

    def test_missing_dimension_fails_closed(self):
        pair, response = fixture()
        response["results"][0]["dimensions"].pop()
        with self.assertRaisesRegex(ValueError, "dimensions"):
            engine.validate_output(response, [pair])

    def test_conflicting_dimension_cannot_approve(self):
        pair, response = fixture()
        response["results"][0]["dimensions"][5]["relation"] = "different"
        with self.assertRaisesRegex(ValueError, "contradicts"):
            engine.validate_output(response, [pair])

    def test_missing_evidence_cannot_approve(self):
        pair, response = fixture()
        response["results"][0]["dimensions"][5]["right_evidence_ids"] = []
        with self.assertRaisesRegex(ValueError, "lacks evidence"):
            engine.validate_output(response, [pair])

    def test_unprovided_context_cannot_approve(self):
        pair, response = fixture()
        response["results"][0]["dimensions"][8].update(relation="match", context_keys=["mechanic_rule"])
        with self.assertRaisesRegex(ValueError, "context"):
            engine.validate_output(response, [pair])

    def test_all_absent_cannot_approve(self):
        pair, response = fixture()
        for row in response["results"][0]["dimensions"]:
            row.update(relation="absent", left_evidence_ids=[], right_evidence_ids=[])
        with self.assertRaisesRegex(ValueError, "operation"):
            engine.validate_output(response, [pair])

    def test_duplicate_pair_rejected(self):
        pair, response = fixture()
        response["results"].append(copy.deepcopy(response["results"][0]))
        with self.assertRaises(ValueError):
            engine.validate_output(response, [pair])

    def test_calibration_failure_overrides_positive_models(self):
        pair = engine.controls()[-2]
        reviews = [{"deployment": d, "verdict": "equivalent"} for d in engine.DEPLOYMENTS]
        self.assertFalse(engine.decide(pair, reviews, False)["machine_accepted"])

    def test_either_model_uncertain_or_disagrees_retains_hold(self):
        pair = engine.controls()[-2]
        reviews = [{"deployment": d, "verdict": "equivalent"} for d in engine.DEPLOYMENTS]
        self.assertTrue(engine.decide(pair, reviews, True)["machine_accepted"])
        reviews[1]["verdict"] = "uncertain"
        self.assertFalse(engine.decide(pair, reviews, True)["machine_accepted"])
        reviews[1]["verdict"] = "equivalent_with_reminder"
        self.assertFalse(engine.decide(pair, reviews, True)["machine_accepted"])

    def test_same_deployment_twice_is_not_two_reviewers(self):
        pair = engine.controls()[-2]
        reviews = [{"deployment": engine.DEPLOYMENTS[0], "verdict": "equivalent"}] * 2
        self.assertFalse(engine.decide(pair, reviews, True)["machine_accepted"])

    def test_numeric_guard_overrides_both_models(self):
        pair = engine.controls()[1]
        reviews = [{"deployment": d, "verdict": "equivalent"} for d in engine.DEPLOYMENTS]
        self.assertFalse(engine.decide(pair, reviews, True)["machine_accepted"])

    def test_only_four_frozen_pairs_need_models(self):
        pairs = engine.source_pairs(engine.load(engine.ROOT / "pilot-results.json"))
        self.assertEqual(sum(p["base_status"] == "needs_semantic_review" for p in pairs), 4)
        for p in pairs:
            if p["context"]:
                path = Path(p["context"]["source_file"])
                self.assertEqual(engine.sha(path.read_bytes()), p["context"]["source_sha256"])

    def test_vstar_context_uses_mik_subtype_not_just_family(self):
        pairs = engine.source_pairs(engine.load(engine.ROOT / "pilot-results.json"))
        lugia = next(p for p in pairs if p["id"] == "TEST/002:abilities.0.effect")
        self.assertEqual(lugia["context"]["mik_mechanic"], "V")
        self.assertEqual(lugia["context"]["mik_stage"], "VSTAR")
        self.assertEqual(lugia["context"]["slot_template"], "卡牌信息/power/VSTAR")
        self.assertEqual(engine.hard_checks(lugia)["vetoes"], [])
        shown = engine.visible_pair(lugia, 0, False)
        self.assertNotIn("只能使用1次", shown["left"])
        for span in shown["left_spans"]:
            self.assertEqual(lugia["left"][span["start"]:span["end"]], span["text"])

    def test_unit_one_is_not_silently_ignored(self):
        pairs = engine.source_pairs(engine.load(engine.ROOT / "pilot-results.json"))
        gx = next(p for p in pairs if p["id"] == "TEST/001:abilities.0.effect")
        reviews = [{"deployment": d, "verdict": "equivalent", "dimensions": []} for d in engine.DEPLOYMENTS]
        self.assertFalse(engine.decide(gx, reviews, True)["machine_accepted"])
        for r in reviews:
            r["dimensions"] = [{"dimension": "amounts", "relation": "match"}]
        self.assertTrue(engine.decide(gx, reviews, True)["machine_accepted"])

    def test_output_path_guard(self):
        with self.assertRaises(ValueError):
            engine.write(engine.ROOT / "must-not-exist.json", {})


if __name__ == "__main__":
    unittest.main()
