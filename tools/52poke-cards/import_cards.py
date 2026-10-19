"""Extract card pages from a local 52Poké XML snapshot, without network requests."""
from __future__ import annotations

import argparse
import collections
import csv
import gzip
import hashlib
import json
import re
import sqlite3
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

import mwparserfromhell as mw

ROOT = Path(__file__).resolve().parent
VERSION = "1"
LICENSE_URL = "https://creativecommons.org/licenses/by-nc-sa/3.0/"
WIKI = "https://wiki.52poke.com/wiki/"
FAMILIES = ("卡牌信息", "训练家卡信息", "能量卡信息")
KINDS = dict(zip(FAMILIES, ("pokemon", "trainer", "energy")))
MARKERS = (*FAMILIES, "卡牌工程", "卡牌工程", "ExpansionList", "expansionlist", "卡牌信息")
CONTENT_NAMESPACES = {0, 4, 8, 10, 12, 14, 100}


def json_text(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def normalize_title(value: str) -> str:
    return value.replace("_", " ").strip()


def template_name(value: str) -> str:
    name = normalize_title(value)
    name = re.sub(r"^(?:template|模板)\s*[:：]\s*", "", name, flags=re.I)
    return name.casefold()


def page_url(title: str) -> str:
    return WIKI + urllib.parse.quote(title.replace(" ", "_"), safe=":")


def plain(value: str) -> str:
    """Convenience text, NOT a MediaWiki renderer; raw values are always retained."""
    return str(mw.parse(value).strip_code(
        normalize=True, collapse=True, keep_template_params=True,
    )).strip()


def as_int(value: str):
    return int(value) if re.fullmatch(r"\d+", value.strip()) else None


def iterate_pages(path: Path):
    opener = gzip.open if path.name.endswith(".gz") else open
    with opener(path, "rb") as stream:
        events = ET.iterparse(stream, events=("start", "end"))
        _, root = next(events)
        ns = root.tag.split("}")[0] + "}" if "}" in root.tag else ""
        for event, element in events:
            if event != "end" or element.tag != ns + "page":
                continue
            revision = element.find(ns + "revision")
            redirect = element.find(ns + "redirect")
            yield {
                "page_id": int(element.findtext(ns + "id")),
                "title": element.findtext(ns + "title") or "",
                "namespace": int(element.findtext(ns + "ns") or 0),
                "revision_id": int(revision.findtext(ns + "id") or 0) if revision is not None else 0,
                "timestamp": revision.findtext(ns + "timestamp") if revision is not None else None,
                "redirect": redirect.get("title") if redirect is not None else None,
                "wikitext": revision.findtext(ns + "text") or "" if revision is not None else "",
            }
            element.clear()
            root.clear()


def connect(path: Path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pages(
            page_id INTEGER PRIMARY KEY, title TEXT UNIQUE NOT NULL, namespace INTEGER,
            revision_id INTEGER, timestamp TEXT, redirect TEXT, candidate INTEGER NOT NULL,
            wikitext_zlib BLOB
        );
        CREATE INDEX IF NOT EXISTS pages_candidates ON pages(namespace,candidate);
        CREATE TABLE IF NOT EXISTS extracts(
            page_id INTEGER PRIMARY KEY REFERENCES pages(page_id),
            version TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT, error TEXT
        );
    """)
    return db


def get_meta(db, key, default=None):
    row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def set_meta(db, key, value):
    db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, json_text(value)))


def import_xml(db, archive: Path):
    with archive.open("rb") as stream:
        fingerprint = hashlib.file_digest(stream, "sha256").hexdigest()
    previous = get_meta(db, "archive_sha256")
    if previous and previous != fingerprint:
        raise ValueError("Output directory belongs to a different archive. Choose another --output.")
    set_meta(db, "archive_sha256", fingerprint)
    set_meta(db, "archive_file", str(archive.resolve()))
    if get_meta(db, "import_complete", False):
        print("Archive index already complete; resuming extraction.", flush=True)
        return
    counts = collections.Counter()
    start = time.monotonic()
    for page in iterate_pages(archive):
        text, namespace = page["wikitext"], page["namespace"]
        candidate = namespace == 0 and (
            any(marker in text for marker in MARKERS)
            or re.search(r"（(?:TCG|TCGP)）$", page["title"], re.I) is not None
            or ("==卡牌信息==" in text)
        )
        payload = zlib.compress(text.encode(), 6) if namespace in CONTENT_NAMESPACES else None
        db.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?,?,?,?)", (
            page["page_id"], page["title"], namespace, page["revision_id"],
            page["timestamp"], page["redirect"], int(candidate), payload,
        ))
        counts[namespace] += 1
        if sum(counts.values()) % 5000 == 0:
            db.commit()
            print(f"Indexed {sum(counts.values()):,} pages", flush=True)
    set_meta(db, "namespace_counts", dict(counts))
    set_meta(db, "import_complete", True)
    set_meta(db, "import_seconds", round(time.monotonic() - start, 2))
    db.commit()


def template_record(template, index):
    return {
        "index": index, "name": str(template.name).strip(),
        "parameters": [
            {"name": str(p.name).strip(), "value": str(p.value).strip(), "named": bool(p.showkey)}
            for p in template.params
        ],
    }


def fields(template):
    # Last named occurrence wins as in MediaWiki. The ordered list above preserves duplicates.
    return {str(p.name).strip(): str(p.value).strip() for p in template.params}


def localized(values, mode):
    keys = {
        "name": {
            "zh": ("name",), "zh-Hans": ("ZHSname", "nameZHS"),
            "zh-Hant": ("ZHTname", "nameZHT"), "ja": ("jname",), "en": ("ename",),
        },
        "effect": {
            "zh": ("ceffect",), "zh-Hans": ("effectZHS", "ZHSeffect"),
            "zh-Hant": ("effectZHT", "ZHTeffect"), "ja": ("jeffect",), "en": ("eeffect",),
        },
    }[mode]
    result = {}
    for lang, alternatives in keys.items():
        for key in alternatives:
            if values.get(key):
                result[lang] = {"text": plain(values[key]), "wikitext": values[key], "parameter": key}
                break
    return result


def attack_record(template, index):
    values = fields(template)
    costs = []
    collecting = False
    for param in template.params:
        key = str(param.name).strip()
        if key == "cost":
            collecting = True
            costs.append(str(param.value).strip())
        elif collecting and key.isdigit():
            costs.append(str(param.value).strip())
        elif collecting:
            collecting = False
    return {
        "source_template_index": index, "template": str(template.name).strip(),
        "names": localized(values, "name"), "effects": localized(values, "effect"),
        "damage": values.get("damage"), "cost": [plain(c) for c in costs],
        "cost_wikitext": costs, "fields": values,
    }


def image_reference(value: str):
    value = value.strip()
    if not value or value.casefold() in {"n", "no", "none", "-", "—"}:
        return None
    if "{{" in value or "[[" in value:
        return {"raw": value, "unresolved": True}
    if value.startswith(("https://", "http://")):
        return {"raw": value, "source_url": value, "downloaded": False}
    filename = re.sub(r"^(?:File|Image|文件|檔案|图像|圖像):", "", value, flags=re.I)
    return {
        "file_name": filename, "file_page_url": page_url("File:" + filename),
        "downloaded": False,
    }


def printing_records(template, index):
    name, values = template_name(str(template.name)), fields(template)
    if not name.startswith("expansionlist/main"):
        return []
    configs = (
        [("cn", "zh-Hans"), ("zh", "zh-Hant")] if name.endswith("/zh")
        else [("", values.get("word") or "other")] if name.endswith("/p")
        else [("ja", "ja"), ("en", "en")]
    )
    results = []
    for prefix, language in configs:
        source_keys = {field: prefix + suffix for field, suffix in {
            "set_name": "expansion", "set_code": "icon", "series": "series",
            "release_date": "time", "number": "no", "rarity": "rar", "image": "img",
        }.items()}
        if not any(values.get(key) for key in source_keys.values()):
            continue
        result = {
            "source_template_index": index, "language": language,
            **{key: plain(values.get(parameter, "")) or None
               for key, parameter in source_keys.items() if key != "image"},
            "illustrator": plain(values.get("illus", "")) or None,
            "regulation_mark": values.get("reg") or None,
            "image": image_reference(values.get(prefix + "img", "")),
            "raw_image_value": values.get(prefix + "img"),
            "rowspan_resolved": False,
        }
        results.append(result)
    return results


def header_kind(name: str):
    for family in FAMILIES:
        if name == family + "/header" or name.startswith(family + "/header/"):
            return KINDS[family]
    return None


def parse_card(page):
    text = page["wikitext"]
    code = mw.parse(text)
    templates = code.filter_templates(recursive=True)
    blocks, retained, printings, images = [], [], [], []
    current = None
    names = {}
    warnings = []
    observed = collections.Counter()
    for index, template in enumerate(templates):
        name, values = template_name(str(template.name)), fields(template)
        kind = header_kind(name)
        family_member = any(name.startswith(family + "/") for family in FAMILIES)
        if name == "n" and not names:
            for number, lang in (("1", "zh"), ("3", "ja"), ("4", "en")):
                if values.get(number):
                    names[lang] = {"text": plain(values[number]), "wikitext": values[number]}
        if family_member or name.startswith("expansionlist/") or name == "n":
            retained.append(template_record(template, index))
        if family_member:
            observed[name] += 1
        if kind:
            current = {
                "kind": kind, "game": "pocket" if "/pocket" in name else "tcg",
                "header_template": str(template.name).strip(), "source_template_index": index,
                "header": values, "names": localized(values, "name"),
                "hp": as_int(values.get("hp", "")), "hp_wikitext": values.get("hp"),
                "type": plain(values.get("type", "")) or None,
                "stage": plain(values.get("evostage", "")) or None,
                "evolves_from": plain(values.get("evo", "")) or None,
                "attacks": [], "abilities": [], "effects": [], "footers": [],
            }
            blocks.append(current)
        elif current is not None and family_member:
            leaf = name.split("/", 1)[1]
            if leaf.startswith("attack"):
                current["attacks"].append(attack_record(template, index))
            elif leaf.startswith(("power", "oldpower")) or leaf in {"古代能力", "幼年", "vstar力量", "arceus", "item"}:
                current["abilities"].append({
                    "source_template_index": index, "template": str(template.name).strip(),
                    "names": localized(values, "name"), "effects": localized(values, "effect"),
                    "fields": values,
                })
            elif leaf.startswith(("main", "multimain", "tm")):
                current["effects"].append({
                    "source_template_index": index, "template": str(template.name).strip(),
                    "texts": localized(values, "effect"), "fields": values,
                })
                if leaf.startswith("multimain"):
                    warnings.append("version_specific_trainer_text_preserved_in_fields")
            elif "end" in leaf or leaf == "footer":
                current["footers"].append({
                    "source_template_index": index, "template": str(template.name).strip(),
                    "fields": values,
                })
        printings.extend(printing_records(template, index))
        if family_member or name.startswith("expansionlist/"):
            for key, value in values.items():
                if re.search(r"(?:image|img)\d*$", key, re.I):
                    ref = image_reference(value)
                    if ref:
                        images.append({"source_template_index": index, "parameter": key, **ref})
    if not blocks:
        return None, dict(observed)
    if len(blocks) > 1:
        warnings.append("multiple_card_blocks_do_not_merge_versions_or_games")
    if any(template_name(str(t.name)).startswith(("#", "subst:", "safesubst:")) for t in templates):
        warnings.append("conditional_templates_not_rendered")
    categories = [
        str(link.title).split(":", 1)[1].strip()
        for link in code.filter_wikilinks()
        if re.match(r"^(?:Category|分类|分類):", str(link.title), re.I)
    ]
    games = sorted({b["game"] for b in blocks})
    record = {
        "id": f"52poke:{page['page_id']}", "page_id": page["page_id"],
        "title": page["title"], "display_name": re.sub(r"（[^（）]*）$", "", page["title"]),
        "revision_id": page["revision_id"], "revision_timestamp": page["timestamp"],
        "source_url": page_url(page["title"]),
        "revision_url": f"https://wiki.52poke.com/index.php?oldid={page['revision_id']}",
        "source_wikitext_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "names": names, "games": games, "kinds": sorted({b["kind"] for b in blocks}),
        "card_blocks": blocks, "printings": printings, "images": images,
        "categories": categories, "templates": retained,
        "warnings": sorted(set(warnings)),
        "attribution": {
            "source": "神奇宝贝百科及其贡献者", "license": "CC-BY-NC-SA-3.0",
            "license_url": LICENSE_URL, "modified": True,
            "modification": "从维基源代码提取字段；未渲染全部模板；原始维基文本另行保留。",
        },
        "rules_engine_implemented": False,
    }
    return record, dict(observed)


def inflate(row):
    return {
        **dict(row),
        "wikitext": zlib.decompress(row["wikitext_zlib"]).decode() if row["wikitext_zlib"] else "",
    }


def extract(db):
    rows = db.execute("""
        SELECT p.* FROM pages p LEFT JOIN extracts e ON p.page_id=e.page_id
        WHERE p.namespace=0 AND p.candidate=1 AND p.redirect IS NULL
        AND (e.page_id IS NULL OR e.version<>? OR e.status='error')
        ORDER BY p.page_id
    """, (VERSION,)).fetchall()
    print(f"Extracting/resuming {len(rows):,} candidate pages", flush=True)
    for index, row in enumerate(rows, 1):
        try:
            record, observed = parse_card(inflate(row))
            status = "card" if record else "related"
            payload = record if record else {"observed_card_templates": observed}
            db.execute("INSERT OR REPLACE INTO extracts VALUES (?,?,?,?,NULL)", (
                row["page_id"], VERSION, status, json_text(payload),
            ))
        except Exception as error:
            db.execute("INSERT OR REPLACE INTO extracts VALUES (?,?,?,NULL,?)", (
                row["page_id"], VERSION, "error", f"{type(error).__name__}: {error}",
            ))
        if index % 200 == 0:
            db.commit()
            print(f"Processed {index:,}/{len(rows):,} candidates", flush=True)
    db.commit()


def export(db, directory: Path, release: str):
    files = {}
    names = (
        "cards.jsonl", "printings.jsonl", "aliases.jsonl", "cards.csv",
        "card_pages.raw.jsonl.gz", "related_pages.raw.jsonl.gz", "templates.raw.jsonl.gz",
        "needs_review.jsonl",
    )
    for name in names:
        path = directory / (name + ".part")
        files[name] = gzip.open(path, "wt", encoding="utf-8") if name.endswith(".gz") else path.open("w", encoding="utf-8", newline="")
    counts = collections.Counter()
    template_counts = collections.Counter()
    warnings = collections.Counter()
    errors = []
    writer = csv.writer(files["cards.csv"])
    writer.writerow(["page_id", "title", "games", "kinds", "name_ja", "name_en", "blocks", "printings", "source_url"])
    cards_by_title = {}
    try:
        for row in db.execute("""
            SELECT p.*, e.status, e.record_json, e.error FROM pages p
            JOIN extracts e ON p.page_id=e.page_id ORDER BY p.page_id
        """):
            raw = {
                "page_id": row["page_id"], "title": row["title"], "namespace": row["namespace"],
                "revision_id": row["revision_id"], "timestamp": row["timestamp"],
                "source_url": page_url(row["title"]), "wikitext": inflate(row)["wikitext"],
            }
            if row["status"] == "card":
                card = json.loads(row["record_json"])
                card["archive_release"] = release
                cards_by_title[normalize_title(row["title"])] = row["page_id"]
                files["cards.jsonl"].write(json_text(card) + "\n")
                files["card_pages.raw.jsonl.gz"].write(json_text(raw) + "\n")
                counts["card_pages"] += 1
                counts["card_blocks"] += len(card["card_blocks"])
                counts["game:" + "+".join(card["games"])] += 1
                for block in card["card_blocks"]:
                    counts["block:" + block["game"] + ":" + block["kind"]] += 1
                for printing in card["printings"]:
                    files["printings.jsonl"].write(json_text({
                        "page_id": row["page_id"], "title": row["title"],
                        "revision_id": row["revision_id"], "archive_release": release, **printing,
                    }) + "\n")
                    counts["printing_rows"] += 1
                for item in card["templates"]:
                    template_counts[template_name(item["name"])] += 1
                warnings.update(card["warnings"])
                writer.writerow([
                    row["page_id"], row["title"], "+".join(card["games"]), "+".join(card["kinds"]),
                    card["names"].get("ja", {}).get("text", ""), card["names"].get("en", {}).get("text", ""),
                    len(card["card_blocks"]), len(card["printings"]), card["source_url"],
                ])
            else:
                files["related_pages.raw.jsonl.gz"].write(json_text(raw) + "\n")
                counts["related_pages"] += 1
                if row["status"] == "error":
                    errors.append({"page_id": row["page_id"], "title": row["title"], "error": row["error"]})
                if any(family + "/" in raw["wikitext"] for family in FAMILIES) or re.search(
                    r"是一[张張].{0,100}卡", raw["wikitext"][:1000], re.S
                ):
                    files["needs_review.jsonl"].write(json_text({
                        "page_id": row["page_id"], "title": row["title"], "status": row["status"],
                        "reason": "card-like text without a recognized actual-card header", "error": row["error"],
                    }) + "\n")
                    counts["review_pages"] += 1
        redirects = {
            normalize_title(r["title"]): normalize_title(r["redirect"].split("#", 1)[0])
            for r in db.execute("SELECT title,redirect FROM pages WHERE namespace=0 AND redirect IS NOT NULL")
        }
        for title, target in sorted(redirects.items()):
            seen = {title}
            resolved = target
            while resolved in redirects and resolved not in seen:
                seen.add(resolved)
                resolved = redirects[resolved]
            if resolved in cards_by_title:
                files["aliases.jsonl"].write(json_text({
                    "alias": title, "redirect_target": target,
                    "canonical_title": resolved, "page_id": cards_by_title[resolved],
                }) + "\n")
                counts["aliases"] += 1
        for row in db.execute("SELECT * FROM pages WHERE namespace=10 ORDER BY page_id"):
            page = inflate(row)
            files["templates.raw.jsonl.gz"].write(json_text({
                key: page[key] for key in ("page_id", "title", "revision_id", "timestamp", "redirect", "wikitext")
            }) + "\n")
            counts["template_pages_preserved"] += 1
    finally:
        for output in files.values():
            output.close()
    for name in names:
        (directory / (name + ".part")).replace(directory / name)
    audit = {
        "archive_release": release, "extractor_version": VERSION,
        "archive_sha256": get_meta(db, "archive_sha256"),
        "namespace_counts": get_meta(db, "namespace_counts"),
        "counts": dict(counts), "warnings": dict(warnings), "errors": errors,
        "template_usage": dict(template_counts.most_common()),
        "scope": "All XML pages scanned. Actual card headers classify card pages; project/list/rule pages retained separately.",
        "limitations": [
            "Snapshot date is not live-site completeness.",
            "Generic Chinese fields are not assumed to be reviewed Simplified Chinese.",
            "Template parameters and raw text retained; not a full MediaWiki renderer.",
            "Merged table cells/rowspans are not expanded into invented values.",
            "Image file-page references only; no image binaries downloaded.",
            "Card descriptions are not executable game rules.",
        ],
        "files": {
            name: {"bytes": (directory / name).stat().st_size} for name in names
        },
    }
    (directory / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="Scan/extract/export a local XML archive")
    build.add_argument("--archive", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--release", required=True)
    query = sub.add_parser("search", help="Search extracted card titles (offline)")
    query.add_argument("term")
    query.add_argument("--database", type=Path, required=True)
    query.add_argument("--limit", type=int, default=10)
    show = sub.add_parser("show", help="Show one extracted card or its raw wikitext")
    show.add_argument("title")
    show.add_argument("--database", type=Path, required=True)
    show.add_argument("--raw", action="store_true")
    args = parser.parse_args()
    if args.command == "build":
        args.output.mkdir(parents=True, exist_ok=True)
        database = args.output / "cards.sqlite"
        db = connect(database)
        try:
            import_xml(db, args.archive)
            set_meta(db, "archive_release", args.release)
            extract(db)
            audit = export(db, args.output, args.release)
            set_meta(db, "extractor_version", VERSION)
            set_meta(db, "last_export_counts", audit["counts"])
            db.commit()
        finally:
            db.close()
        print(json.dumps({"counts": audit["counts"], "errors": len(audit["errors"])}, ensure_ascii=False, indent=2))
        if audit["errors"]:
            raise SystemExit(1)
        return
    db = sqlite3.connect(f"file:{urllib.parse.quote(str(args.database.resolve()))}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        if args.command == "search":
            # Parameters are bound: no SQL string interpolation of the search term.
            rows = db.execute("""
                SELECT p.title,p.page_id,e.record_json FROM pages p JOIN extracts e ON p.page_id=e.page_id
                WHERE e.status='card' AND p.title LIKE ? ORDER BY p.title LIMIT ?
            """, ("%" + args.term + "%", max(1, min(args.limit, 100))))
            for row in rows:
                record = json.loads(row["record_json"])
                print(json_text({key: record[key] for key in ("page_id", "title", "games", "source_url")}))
        else:
            row = db.execute("""
                SELECT p.*,e.record_json FROM pages p LEFT JOIN extracts e ON p.page_id=e.page_id
                WHERE p.title=?
            """, (args.title,)).fetchone()
            if row is None:
                raise SystemExit("Title not found; use search first.")
            if args.raw:
                print(inflate(row)["wikitext"])
            elif row["record_json"]:
                print(json.dumps(json.loads(row["record_json"]), ensure_ascii=False, indent=2))
            else:
                raise SystemExit("Page exists in the archive but is not an extracted card.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
