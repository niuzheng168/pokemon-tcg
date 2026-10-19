"""Render the tracked, data-free HTML/CSS/JS template with a selected local run."""
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

from . import review_fields as fields, semantics
from .common import TOOL, digest, load, output_root, require, safe_path, write

ASSETS = Path(__file__).resolve().parent / "assets"


def pending_report(base):
    """An offline preview must never pretend that model adjudication ran."""
    report = json.loads(json.dumps(base))
    for result in report["results"]:
        result["base_merged_metadata_file"] = result.get("merged_metadata_file")
        result["base_status"] = result["status"]
        result["semantic_equivalence"] = []
    for pair in semantics.source_pairs(base):
        checks = semantics.hard_checks(pair)
        equal = pair["base_status"] != "needs_semantic_review" and not checks["vetoes"]
        entry = {
            "id": pair["id"], "left": pair["left"], "right": pair["right"], "context": pair["context"],
            "decision": "deterministic_equal" if equal else "needs_review",
            "machine_accepted": equal, "reviews": [], "hard_checks": checks, "human_reviewed": False,
            "hold_reasons": [] if equal else ["semantic_review_not_run"],
        }
        next(r for r in report["results"] if r["mik_id"] == pair["card_id"])["semantic_equivalence"].append(entry)
    report["status_counts"] = dict(Counter(r["status"] for r in report["results"]))
    report.update(deployments=list(semantics.DEPLOYMENTS), cloud_usage={}, calibration_passed=False,
                  calibration_required=True, model_review_complete=False)
    return report


def build(run_dir, library=None):
    root = output_root(run_dir)
    semantics.configure(root)
    out = safe_path(root, root / "semantic-v2")
    base = load(root / "pilot-results.json")
    blocked = [r["mik_id"] for r in base["results"] if not r["chosen"]]
    require(not blocked, "No HTML produced: unresolved associations are retained in the JSON report: " + ", ".join(blocked))
    report_file = out / "results.json"
    if report_file.is_file():
        report = load(report_file)
        require(report["engine_sha256"] == digest(Path(semantics.__file__)), "Semantic results are stale; replay the cached judge first.")
        require(report["base_report_sha256"] == digest(root / "pilot-results.json"), "Staging report changed; rerun the semantic judge.")
        calibration = load(out / "calibration.json")
        semantic_revision = digest(report_file)
        report["model_review_complete"] = True
    else:
        report, calibration = pending_report(base), {"controls": []}
        semantic_revision = "not-run:" + digest(root / "pilot-results.json")
    library = Path(library or TOOL / "library").resolve()
    library_index = {}
    if (library / "index.jsonl").is_file():
        with (library / "index.jsonl").open(encoding="utf-8") as stream:
            for entry in map(json.loads, stream):
                library_index[(entry["printing_language"], entry["set_id"].casefold(), entry["number"])] = entry
    cards = []
    for index, result in enumerate(report["results"], 1):
        origin = safe_path(root, Path(result["base_merged_metadata_file"]).parent)
        mik, raw_wiki, raw_view, wiki, view = [load(origin / name) for name in (
            "mik-metadata.json", "wiki-source.json", "wiki-display.json",
            "normalized-wiki-source.json", "normalized-wiki-display.json",
        )]
        hashes = result["input_hashes"]
        require(digest(origin / "mik-metadata.json") == hashes["metadata_sha256"], "Frozen MIK metadata changed.")
        rows = fields.make_rows(mik, wiki, view, result["chosen"]["block"])
        equivalents = {d["id"].split(":", 1)[1]: d for d in result["semantic_equivalence"]}
        for row in rows:
            row["equivalence"] = equivalents.get(row["id"])
        sample = {
            "mik_id": result["mik_id"], "wiki_candidate": {
                "id": wiki["id"], "title": wiki["title"], "block": result["chosen"]["block"],
            },
            "structural_checks": result["chosen"]["checks"], "human_reviewed": False,
            "base_status": result["base_status"], "status": result["status"], "remaining_holds": result["holds"],
        }
        warnings = ["机器检查通过（未入库、未经人工核准）。" if result["status"] == "ready" else "仍有暂缓事项，未自动通过。",
                    "审核意见独立保存在此数据指纹下，不会改变卡牌源数据或替你作人工核准。"]
        if not report["model_review_complete"]:
            warnings.append("模型语义核验尚未运行；效果文字差异仍暂缓。")
        warnings.extend("待解决：" + h["code"] for h in result["holds"])
        cards.append({
            "id": result["mik_id"], "index": index, "name": mik["name"],
            "kind": fields.CARD_TYPES[mik["cardType"]], "wiki_id": wiki["id"], "wiki_title": wiki["title"],
            "merge_status": result["status"], "merge_holds": result["holds"], "base_status": result["base_status"],
            "wiki_url": fields.checked_url(wiki["revision_url"], "wiki.52poke.com"),
            "mik_url": "https://tcg.mik.moe/cards/" + result["mik_id"],
            "rows": rows, "counts": dict(Counter(r["status"] for r in rows)),
            "text_difference_count": sum(r["selectable"] and r["status"] in {"different", "missing"} for r in rows),
            "warnings": warnings, "checks": result["chosen"]["checks"], "supplements": [],
            "mik_image": fields.encode_image(origin / "image.png", hashes["image_sha256"]),
            "wiki_image": fields.local_wiki_image(view, library_index, mik, library),
            "wiki_image_record": view.get("image"), "printings": result["chosen"]["direct_printings"],
            "candidate_pages": sorted({c["page_id"] for c in result["candidate_evidence"]}),
            "semantic_equivalence": result["semantic_equivalence"],
            "provenance": {
                "mik_metadata_sha256": hashes["metadata_sha256"], "mik_image_sha256": hashes["image_sha256"],
                "wiki_page_id": wiki["page_id"], "wiki_revision_id": wiki["revision_id"],
                "wiki_source_wikitext_sha256": wiki["source_wikitext_sha256"],
            },
            "raw": {"mik": mik, "wiki": raw_wiki, "wiki_display": raw_view, "sample_comparison": sample,
                    "normalized_wiki": wiki, "normalized_wiki_display": view,
                    "merged_candidate": load(safe_path(root, Path(result["merged_metadata_file"])))},
        })
    identity = {"snapshot": base["snapshot_sha256"], "cards": [{"id": c["id"], **c["provenance"]} for c in cards]}
    data = {
        "schema": "mik-52poke-review-page-v1", "fingerprint": semantics.sha(json.dumps(identity, sort_keys=True).encode()),
        "semantic_revision": semantic_revision, "generated_at": datetime.now(timezone.utc).isoformat(),
        "sampled_at": base.get("selected_at_utc") or "未记录", "archive_release": base.get("archive_release", "未记录"),
        "snapshot": base["snapshot_sha256"], "cards": cards, "semantic_probe": None,
        "equivalence": {
            **{k: report.get(k) for k in ("status_counts", "calibration_passed", "calibration_required",
                                         "model_review_complete", "deployments", "cloud_usage")},
            "controls": [{"id": c["id"], "passed": c["passed"], "expected_accept": c["expected_accept"],
                          "verdicts": c["model_only_verdicts"]} for c in calibration["controls"]],
        },
    }
    embedded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    embedded = embedded.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    html = (ASSETS / "review.template.html").read_text().replace("{{CARD_COUNT}}", str(len(cards)))
    for marker, content in [
        ("/* REVIEW_STYLES */", (ASSETS / "review.css").read_text()),
        ("/* REVIEW_DATA */", embedded), ("/* REVIEW_APP */", (ASSETS / "review.js").read_text()),
    ]:
        require(html.count(marker) == 1, "Invalid review template marker.")
        html = html.replace(marker, content)
    target = safe_path(out, out / "review.html")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(html, encoding="utf-8")
    write(out, out / "review-manifest.json", {
        "cards": len(cards), "fingerprint": data["fingerprint"], "semantic_revision": semantic_revision,
        "html_sha256": digest(target), "production_library_modified": False,
    })
    return target
