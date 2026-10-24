from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
from urllib.parse import urlsplit, urlunsplit

from PIL import Image, ImageOps

TOOL = Path(__file__).resolve().parents[1]
DEFAULT_STATE = TOOL / "exports/official-card-filter"
DEFAULT_IMAGES = Path("/nas/share/Pokemon/images/official-bulk")
DEFAULT_RECEIPTS = Path("/nas/share/Pokemon/metadata/official-bulk/images.jsonl")
DEFAULT_DERIVED = Path("/nas/share/Pokemon/images/official-card-filter")
DEFAULT_REPORTS = Path("/nas/share/Pokemon/metadata/official-card-filter")
SHA = re.compile(r"[0-9a-f]{64}\Z")
LABELS = ("card", "non_card", "review")
NEEDS_RECHECK = {"disagreement", "geometry_hold", "layout_hold"}
KINDS = (
    "card_front", "card_back", "multi_card", "product", "packaging", "poster",
    "banner", "logo", "photo", "accessory", "other", "uncertain",
)
VERSION = "official-pure-card-v2"


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def checksum(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(encoded(value) + b"\n")
            stream.flush()
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def public_url(value):
    p = urlsplit(value)
    if (p.scheme != "https" or p.username or p.password or p.port not in (None, 443)
            or not any(p.hostname == domain or (p.hostname or "").endswith("." + domain)
                       for domain in ("pokemon.cn", "pokemon.com.cn"))):
        raise ValueError("Unexpected nonofficial source URL.")
    return urlunsplit((p.scheme, p.netloc, p.path, "", ""))


def ensure_storage(roots):
    if any(Path(value).is_relative_to(Path("/nas/share")) for value in roots.values()):
        if not os.path.ismount("/nas/share"):
            raise OSError("NAS is not mounted; refusing a local fallback directory.")
    if not Path(roots["images"]).is_dir():
        raise OSError("Original image archive is unavailable; do not create a replacement.")


def inventory(receipts):
    """Merge all receipts for a hash; do not lose alternate source pages/URLs."""
    unique = {}
    for line in Path(receipts).read_text().splitlines():
        r = json.loads(line)
        sha = r["sha256"]
        if not SHA.fullmatch(sha):
            raise ValueError("Invalid source image checksum.")
        if r["suffix"] not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico", ".tif", ".tiff"):
            raise ValueError("Invalid source image suffix.")
        if not isinstance(r["source_pages"], list) or not r["source_pages"]:
            raise ValueError("Every source image needs recorded provenance.")
        key = (r["bytes"], r["width"], r["height"], r["suffix"])
        if sha in unique and unique[sha]["signature"] != key:
            raise ValueError("Inconsistent receipts for the same image.")
        item = unique.setdefault(sha, {
            "id": sha, "signature": key, "bytes": r["bytes"], "width": r["width"],
            "height": r["height"], "suffix": r["suffix"], "sources": set(), "image_urls": set(),
        })
        item["sources"].update(public_url(u) for u in r["source_pages"])
        if r["source_url"].startswith("https://"):
            item["image_urls"].add(public_url(r["source_url"]))
    result = []
    for ordinal, sha in enumerate(sorted(unique), 1):
        row = unique[sha]
        row.pop("signature")
        row.update(short_id=f"I{ordinal:04d}", sources=sorted(row["sources"]), image_urls=sorted(row["image_urls"]))
        result.append(row)
    return result


def validated_prediction(value):
    if not isinstance(value, dict) or set(value) != {
        "id", "label", "kind", "confidence", "full_card", "reason",
    }:
        raise ValueError("Unexpected prediction schema.")
    if value["label"] not in LABELS or value["kind"] not in KINDS:
        raise ValueError("Unknown prediction category.")
    if type(value["confidence"]) is not int or not 0 <= value["confidence"] <= 100:
        raise ValueError("Invalid model confidence score.")
    if type(value["full_card"]) is not bool:
        raise ValueError("Invalid complete-card flag.")
    if not isinstance(value["reason"], str) or not 1 <= len(value["reason"]) <= 300:
        raise ValueError("Missing/oversized visual evidence.")
    if value["label"] == "card" and (value["kind"] != "card_front" or not value["full_card"]):
        raise ValueError("Card prediction lacks a complete front-face assertion.")
    if value["label"] == "non_card" and value["kind"] in ("card_front", "uncertain"):
        raise ValueError("Contradictory non-card prediction.")
    if value["label"] != "card" and value["full_card"]:
        raise ValueError("Non-card/review prediction claims a full qualifying card.")
    return value


def decide(row, votes):
    """Consensus is a model decision, not human approval or card identity."""
    if row.get("hold"):
        return {"label": "review", "kind": "uncertain", "score": 0,
                "reason": row["hold"]["reason"], "method": "provider_hold"}
    if row.get("error"):
        return {"label": "review", "kind": "uncertain", "score": 0, "reason": "预览处理失败，需检查原图。", "method": "image_error"}
    primary, secondary, adjudicator, verifier = (votes.get(k) for k in ("primary", "secondary", "adjudicator", "verifier"))
    if primary and secondary:
        if (adjudicator and verifier and adjudicator["label"] == verifier["label"] != "review"
              and min(adjudicator["confidence"], verifier["confidence"]) >= 98
              and (not adjudicator.get("model") or adjudicator.get("model") != verifier.get("model"))):
            selected = verifier
            method = "two_single_image_consensus"
        elif (primary["label"] == secondary["label"] != "review"
                and min(primary["confidence"], secondary["confidence"]) >= 96):
            selected = secondary
            method = "two_model_consensus"
        elif adjudicator and adjudicator["label"] != "review" and adjudicator["confidence"] >= 98:
            support = [v for v in (primary, secondary) if v["label"] == adjudicator["label"] and v["confidence"] >= 96]
            if not support:
                return {"label": "review", "kind": adjudicator["kind"], "score": adjudicator["confidence"],
                        "reason": "放大复判与前两次结果未形成可靠共识。", "method": "disagreement"}
            selected = adjudicator
            method = "enlarged_majority"
        else:
            return {"label": "review", "kind": secondary["kind"], "score": min(primary["confidence"], secondary["confidence"]),
                    "reason": "模型意见不一致或评分不足，需复核。", "method": "disagreement"}
        if selected["label"] == "card":
            visible_reason = selected["reason"]
            for negated in ("没有多张卡牌", "无多张卡牌", "不是多张卡牌", "没有两张卡牌", "并非多张卡牌",
                            "不含多张卡牌", "不包含多张卡牌", "未见多张卡牌", "非多张卡牌", "未包含多张卡牌"):
                visible_reason = visible_reason.replace(negated, "")
            if any(phrase in visible_reason for phrase in (
                    "两张完整", "多张完整", "两张卡牌", "多张卡牌",
                    "右侧为说明", "右侧为介绍", "右侧为文字", "右侧有说明文字")):
                return {"label": "review", "kind": "card_front", "score": selected["confidence"],
                        "reason": "模型虽然给出卡图标签，但理由提到多张卡牌或卡外说明；需核对整图版式。",
                        "method": "layout_hold"}
            w, h = row.get("width"), row.get("height")
            if isinstance(w, int) and isinstance(h, int):
                ratio = min(w, h) / max(w, h)
                if w >= h or not .64 <= ratio <= .79:
                    return {"label": "review", "kind": "card_front", "score": selected["confidence"],
                            "reason": "模型认为是卡图，但画幅不是常规竖向单卡；需检查是否有卡牌外的说明文字、背景、拼图或旋转。", "method": "geometry_hold"}
        score = min(v["confidence"] for v in (primary, secondary)) if method == "two_model_consensus" else (
            min(adjudicator["confidence"], verifier["confidence"]) if method == "two_single_image_consensus" else selected["confidence"])
        return {"label": selected["label"], "kind": selected["kind"], "score": score,
                "reason": selected["reason"], "method": method}
    return {"label": "review", "kind": "uncertain", "score": 0,
            "reason": "等待两次视觉判别完成。" if not primary or not secondary else "等待判别。",
            "method": "pending"}


class Store:
    def __init__(self, state=DEFAULT_STATE):
        self.root = Path(state).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.root.chmod(0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "filter.sqlite", timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,data TEXT NOT NULL,
              prepared INTEGER NOT NULL DEFAULT 0,error TEXT);
            CREATE TABLE IF NOT EXISTS votes(id TEXT NOT NULL,pass TEXT NOT NULL,data TEXT NOT NULL,
              PRIMARY KEY(id,pass));
            CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,label TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT,label TEXT,note TEXT,at TEXT);
            CREATE TABLE IF NOT EXISTS holds(id TEXT PRIMARY KEY,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS vote_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL,pass TEXT NOT NULL,data TEXT NOT NULL);
        """)

    def meta(self, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))

    def seed(self, receipts=DEFAULT_RECEIPTS, images=DEFAULT_IMAGES, derived=DEFAULT_DERIVED, reports=DEFAULT_REPORTS):
        rows = inventory(receipts)
        fingerprint = hashlib.sha256(encoded(rows)).hexdigest()
        if self.meta("inventory_fingerprint", fingerprint) != fingerprint:
            raise ValueError("Source inventory changed; refusing to reset existing judgments.")
        roots = {"images": str(Path(images).resolve()), "derived": str(Path(derived).resolve()), "reports": str(Path(reports).resolve())}
        if len(set(roots.values())) != 3 or any(Path(roots[a]).is_relative_to(Path(roots[b]))
                for a in roots for b in roots if a != b):
            raise ValueError("Source and generated-output directories must be separate.")
        if self.meta("roots", roots) != roots:
            raise ValueError("Existing run uses different storage paths.")
        ensure_storage(roots)
        for path in (Path(roots["derived"]) / "thumbs", Path(roots["reports"])):
            path.mkdir(parents=True, exist_ok=True)
        with self.lock, self.db:
            for row in rows:
                self.db.execute("INSERT OR IGNORE INTO images(id,data) VALUES (?,?)", (row["id"], encoded(row).decode()))
        self.set_meta("roots", roots)
        self.set_meta("inventory_fingerprint", fingerprint)
        self.set_meta("version", VERSION)
        return rows

    def rows(self):
        with self.lock:
            holds = {r["id"]: json.loads(r["data"]) for r in self.db.execute("SELECT * FROM holds")}
            result = []
            for row in self.db.execute("SELECT * FROM images ORDER BY id"):
                data = json.loads(row["data"])
                data.update(prepared=bool(row["prepared"]), error=row["error"], hold=holds.get(row["id"]))
                result.append(data)
            return result

    def row(self, sha):
        with self.lock:
            found = self.db.execute("SELECT * FROM images WHERE id=?", (sha,)).fetchone()
            if not found:
                return None
            row = json.loads(found["data"])
            hold = self.db.execute("SELECT data FROM holds WHERE id=?", (sha,)).fetchone()
            return {**row, "prepared": bool(found["prepared"]), "error": found["error"],
                    "hold": json.loads(hold[0]) if hold else None}

    def hold(self, ids, code, reason):
        with self.lock, self.db:
            for sha in ids:
                if not SHA.fullmatch(sha):
                    raise ValueError("Invalid held image checksum.")
                self.db.execute("INSERT OR IGNORE INTO holds VALUES (?,?)", (sha, encoded({"code": code, "reason": reason}).decode()))

    def original(self, row):
        root = Path(self.meta("roots")["images"])
        path = root / (row["id"] + row["suffix"])
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError("Source path escaped the original archive.")
        return path

    def thumb(self, sha):
        if not SHA.fullmatch(sha):
            raise ValueError("Invalid image identifier.")
        return Path(self.meta("roots")["derived"]) / "thumbs" / (sha + ".jpg")

    def prepare_one(self, row):
        path, target = self.original(row), self.thumb(row["id"])
        if not path.is_file() or path.stat().st_size != row["bytes"] or checksum(path) != row["id"]:
            raise ValueError("Original image checksum/size mismatch; no upload.")
        if not target.exists():
            if row["suffix"] == ".svg":
                script = (
                    "const fs=require('fs'),sharp=require('sharp');"
                    "sharp(fs.readFileSync(process.argv[1]),{limitInputPixels:100000000})"
                    ".resize({width:900,height:1100,fit:'inside',withoutEnlargement:true})"
                    ".flatten({background:'#fff'}).jpeg({quality:88}).toFile(process.argv[2]);"
                )
                result = subprocess.run(["node", "-e", script, str(path), str(target)], cwd=TOOL.parent.parent,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if result.returncode:
                    raise ValueError("SVG preview rendering failed.")
            else:
                with Image.open(path) as source:
                    image = ImageOps.exif_transpose(source)
                    image.thumbnail((900, 1100), Image.Resampling.LANCZOS)
                    if image.mode == "RGBA" or "transparency" in image.info:
                        rgba = image.convert("RGBA")
                        image = Image.new("RGB", rgba.size, "white")
                        image.paste(rgba, mask=rgba.getchannel("A"))
                    else:
                        image = image.convert("RGB")
                    temporary = target.with_suffix(".tmp")
                    image.save(temporary, "JPEG", quality=88)
                    temporary.replace(target)
        with Image.open(target) as image:
            image.verify()
        with self.lock, self.db:
            self.db.execute("UPDATE images SET prepared=1,error=NULL WHERE id=?", (row["id"],))

    def save_vote(self, sha, phase, vote, model=None):
        validated_prediction(vote)
        with self.lock, self.db:
            old = self.db.execute("SELECT data FROM votes WHERE id=? AND pass=?", (sha, phase)).fetchone()
            value = encoded({**vote, **({"model": model} if model else {})}).decode()
            if old and old[0] != value:
                self.db.execute("INSERT INTO vote_history(id,pass,data) VALUES (?,?,?)", (sha, phase, old[0]))
            self.db.execute("INSERT OR REPLACE INTO votes VALUES (?,?,?)",
                            (sha, phase, value))

    def votes(self):
        with self.lock:
            result = {}
            for row in self.db.execute("SELECT * FROM votes"):
                result.setdefault(row["id"], {})[row["pass"]] = json.loads(row["data"])
            return result

    def catalog(self):
        with self.lock:
            votes = self.votes()
            reviews = {r["id"]: dict(r) for r in self.db.execute("SELECT * FROM reviews")}
            result = []
            for row in self.rows():
                decision = decide(row, votes.get(row["id"], {}))
                human = reviews.get(row["id"])
                result.append({
                    **row, "ai": decision, "votes": votes.get(row["id"], {}),
                    "human": human, "label": human["label"] if human else decision["label"],
                    "original_filename": row["id"] + row["suffix"],
                    "thumb_url": "/thumb/" + row["id"] + ".jpg" if row["prepared"] else None,
                    "original_url": "/image/" + row["id"],
                })
            return result

    def snapshot(self):
        from collections import Counter
        data = self.catalog()
        summary = {
            "total": len(data), "counts": dict(Counter(r["label"] for r in data)),
            "human_reviewed": sum(bool(r["human"]) for r in data),
            "two_model_reviewed": sum("primary" in r["votes"] and "secondary" in r["votes"] for r in data),
            "adjudicated": sum("adjudicator" in r["votes"] for r in data),
            "independent_single_image_checks": sum("verifier" in r["votes"] for r in data),
            "provider_held_images": sum(bool(r.get("hold")) for r in data),
            "source_files_unchanged": all(r["prepared"] for r in data), "formal_library_modified": False,
            "inventory_fingerprint": self.meta("inventory_fingerprint"), "version": VERSION,
            "classification_complete": all(r["ai"]["method"] != "pending" for r in data),
            "progress": self.meta("progress", {}),
            "review_revision": self.meta("review_revision", 0),
            "original_image_directory": self.meta("roots", {}).get("images"),
            "pending_model_inputs": sum(r["ai"]["method"] == "pending" for r in data),
            "pending_enlarged_checks": sum(r["ai"]["method"] in NEEDS_RECHECK
                                          and not r["human"] and "adjudicator" not in r["votes"] for r in data),
            "pending_second_enlarged_checks": sum(r["ai"]["method"] in NEEDS_RECHECK
                                                 and not r["human"] and "adjudicator" in r["votes"]
                                                 and "verifier" not in r["votes"] for r in data),
        }
        summary["pipeline_complete"] = summary["classification_complete"] and not any(
            summary[k] for k in ("pending_model_inputs", "pending_enlarged_checks", "pending_second_enlarged_checks"))
        return {"summary": summary, "images": data}

    def export(self):
        import fcntl
        with (self.root / ".export.lock").open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return self._export_locked()

    def _export_locked(self):
        ensure_storage(self.meta("roots"))
        snapshot = self.snapshot()
        data, summary = snapshot["images"], snapshot["summary"]
        reports = Path(self.meta("roots")["reports"])
        write_json(reports / "catalog.json", snapshot)
        write_json(reports / "summary.json", summary)
        for label in LABELS:
            write_json(reports / (label + ".json"), [r for r in data if r["label"] == label])
        # This NAS does not support creating symlinks (CIFS EOPNOTSUPP).
        # Keep tiny local symlink views; all actual image bytes remain on NAS.
        views = self.root / "views"
        if views.is_symlink():
            raise ValueError("Refusing to write through a substituted view directory.")
        views.mkdir(exist_ok=True)
        for label in LABELS:
            directory = views / label
            if directory.is_symlink():
                raise ValueError("Refusing a substituted class directory.")
            directory.mkdir(exist_ok=True)
        for row in data:
            target = self.original(row)
            for label in LABELS:
                link = views / label / row["original_filename"]
                if link.is_symlink():
                    if link.readlink() != target:
                        raise ValueError("Existing view link points elsewhere; do not overwrite it.")
                    if label != row["label"]:
                        link.unlink()
                elif link.exists():
                    raise ValueError("Unexpected real file in symlink view; do not overwrite it.")
                elif label == row["label"]:
                    link.symlink_to(target)
        return summary
