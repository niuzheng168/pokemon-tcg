"""Produce an honest pending-image list without requests, guessed URLs or status resets."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import json
import re
from urllib.parse import urlsplit

from download_images import ROOT, dump_json
from export_display_metadata import read_only
from wiki_image_hashes import DIRECTORY, load_state, records


def main():
    live = {filename: info for batch in load_state()["batches"]
            for filename, info in records(json.loads((DIRECTORY / batch["file"]).read_text()))}
    private_path = ROOT / "data/local-research/wiki-image-bindings.json"
    private = set()
    if private_path.exists():
        private = {row["wiki_filename"] for row in json.loads(private_path.read_text())["bindings"]}
    queue = read_only(ROOT / "images-zh-hans/queue.sqlite")
    candidates = read_only(ROOT / "official-candidates/candidates.sqlite")
    reviews = {row[0]: row[1] for row in candidates.execute("SELECT filename,status FROM detail_reviews")}
    targets, hosts, content_bytes = [], Counter(), {}
    try:
        for job in queue.execute("SELECT * FROM jobs WHERE active=1 AND status!='done' ORDER BY filename"):
            urls = sorted(set(re.findall(r"https?://[^\s\]|<>]+", job["source_evidence"] or "")))
            hosts.update(urlsplit(url).hostname for url in urls)
            metadata = live.get(job["filename"])
            if metadata and metadata["page_id"] != job["file_page_id"]:
                metadata = None
            if metadata:
                content_bytes[(metadata["sha1"], metadata["size"])] = metadata["size"]
            targets.append({
                "wiki_filename": job["filename"], "wiki_file_page_id": job["file_page_id"],
                "wiki_file_revision_id": job["file_revision_id"], "uses": json.loads(job["uses_json"]),
                "declared_source_urls": urls,
                "latest_file_metadata": {k: metadata[k] for k in ["sha1", "size", "width", "height", "url"] if k in metadata} if metadata else None,
                "public_detail_review": reviews.get(job["filename"]),
                "local_research_print_equivalent_only": job["filename"] in private,
                "status": "unresolved",
            })
    finally:
        queue.close()
        candidates.close()
    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "unresolved_target_references": len(targets),
        "with_live_file_metadata_in_saved_snapshot": sum(bool(t["latest_file_metadata"]) for t in targets),
        "distinct_pending_content_bytes_known": sum(content_bytes.values()),
        "local_research_equivalents_not_counted_as_public_or_Wiki_originals": sum(t["local_research_print_equivalent_only"] for t in targets),
        "source_hosts": dict(hosts),
        "constraints": {
            "Wiki_CDN": "403 recorded; no identity, proxy, cookie or challenge workaround",
            "Bilibili_public_article": "verification page recorded; no challenge bypass",
            "AREAZERO": "published policy requires specific user-approved intent and confirmation for every request; no further automated requests",
            "research_dataset": "local research only; excluded from public builds and model uploads",
        },
        "targets": targets,
        "note": "Known metadata byte totals are not a download-time estimate or proof that a resource is currently accessible.",
    }
    dump_json(ROOT / "sources/current-access/remaining-simplified-targets.json", report)
    print(json.dumps({k: v for k, v in report.items() if k not in {"targets", "constraints"}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
