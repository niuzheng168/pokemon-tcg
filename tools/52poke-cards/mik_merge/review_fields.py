"""Read-only comparison rows and hash-verified local image previews."""
from __future__ import annotations

import base64
from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
import hashlib
import io
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from PIL import Image

ROOT = Path(__file__).resolve().parent
LIBRARY = next(parent for parent in ROOT.parents if parent.name == "52poke-cards") / "library"
ENERGY = dict(zip("GRWLPFDMNYC", ["草", "火", "水", "雷", "超", "斗", "恶", "钢", "龙", "妖", "无"]))
STAGES = {"Basic": "基础", "Stage1": "1阶进化", "Stage2": "2阶进化", "Stage 1": "1阶进化", "Stage 2": "2阶进化"}
CARD_TYPES = {
    "Pokemon": "宝可梦", "Supporter": "支援者", "Item": "物品", "Tool": "宝可梦道具",
    "Stadium": "竞技场", "Basic Energy": "基本能量", "Special Energy": "特殊能量",
}


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def pretty(value):
    if value is None:
        return "未提供"
    if value == "" or value == []:
        return "空白"
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def layout(value):
    return re.sub(r"[\s【】]", "", str(value or ""))


def row(key, group, label, mik, wiki, *, canonical=None, selectable=False,
        mik_path="", wiki_path="", provenance=None, languages=None, hint=""):
    if (mik is None or mik == "") and (wiki is None or wiki == ""):
        status = "empty"
    elif mik is None or wiki is None:
        status = "missing"
    elif mik == wiki:
        status = "equal"
    elif canonical and canonical[0] == canonical[1]:
        status = "equivalent"
    elif isinstance(mik, str) and isinstance(wiki, str) and layout(mik) == layout(wiki):
        status = "equivalent"
    else:
        status = "different"
    a, b = pretty(mik), pretty(wiki)
    segments = {"mik": [[a, False]], "wiki": [[b, False]]}
    if status == "different" and len(a) + len(b) < 6000:
        segments = {"mik": [], "wiki": []}
        for op, a1, a2, b1, b2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
            if a1 != a2:
                segments["mik"].append([a[a1:a2], op != "equal"])
            if b1 != b2:
                segments["wiki"].append([b[b1:b2], op != "equal"])
    return {
        "id": key, "group": group, "label": label, "mik": mik, "wiki": wiki, "status": status,
        "segments": segments, "selectable": selectable and status != "empty",
        "mik_path": mik_path, "wiki_path": wiki_path, "provenance": provenance,
        "languages": languages or {}, "hint": hint,
    }


def wiki_type(block):
    header = block["header"]
    if block["kind"] == "pokemon":
        return "宝可梦"
    if block["kind"] == "energy":
        return "基本能量" if header.get("base") == "y" else "特殊能量"
    source = str(header.get("type", "")) + str(header.get("type2", ""))
    if "道具" in source:
        return "宝可梦道具"
    if "支援者" in source or "支持者" in source:
        return "支援者"
    if "场地" in source or "竞技场" in source:
        return "竞技场"
    return "物品" if "物品" in source else block["type"]


def make_rows(mik, wiki, view, block_index):
    block, shown = wiki["card_blocks"][block_index], view["blocks"][block_index]
    provenance = view["field_provenance"]
    rows = [
        row("name", "基本信息", "卡牌名称", mik["name"], view["display"]["name"], selectable=True,
            mik_path="name", wiki_path="display.name", provenance=provenance.get("name")),
        row("kind", "基本信息", "卡牌类型", CARD_TYPES[mik["cardType"]], wiki_type(block),
            mik_path=f"cardType = {mik['cardType']}", wiki_path="card_blocks[].kind / header"),
    ]
    attr = mik.get("pokemonAttr")
    if attr:
        rows.extend([
            row("hp", "基本信息", "HP", attr["hp"], block["hp"], mik_path="pokemonAttr.hp", wiki_path="card_blocks[].hp"),
            row("type", "基本信息", "属性", ENERGY.get(attr["energyType"], attr["energyType"]), block["type"],
                mik_path=f"energyType = {attr['energyType']}", wiki_path="card_blocks[].type"),
            row("stage", "基本信息", "进化阶段", STAGES.get(attr["stage"], attr["stage"]), block["stage"],
                mik_path=f"stage = {attr['stage']}", wiki_path="card_blocks[].stage"),
            row("evolves_from", "基本信息", "进化来源", attr["evolvesFrom"], block["evolves_from"],
                mik_path="pokemonAttr.evolvesFrom", wiki_path="card_blocks[].evolves_from"),
        ])
        for kind, source_key in [("abilities", "ability"), ("attacks", "attack")]:
            for index in range(max(len(attr[source_key]), len(block[kind]))):
                left = attr[source_key][index] if index < len(attr[source_key]) else {}
                right = block[kind][index] if index < len(block[kind]) else {}
                display = shown[kind][index]["display"] if index < len(shown[kind]) else {}
                group = ("特性" if kind == "abilities" else "招式") + f" {index + 1}"
                prefix = f"blocks.{block_index}.{kind}.{index}"
                for field, source_field in [("name", "name"), ("effect", "text")]:
                    options = right.get("names" if field == "name" else "effects", {})
                    rows.append(row(
                        f"{kind}.{index}.{field}", group, "名称" if field == "name" else "效果描述",
                        left.get(source_field), display.get(field), selectable=True,
                        mik_path=f"pokemonAttr.{source_key}[{index}].{source_field}",
                        wiki_path=f"{prefix}.display.{field}", provenance=provenance.get(prefix + "." + field),
                        languages={lang: option.get("text") for lang, option in options.items() if lang in {"en", "ja", "zh-Hant"}},
                    ))
                if kind == "attacks":
                    codes = left.get("cost")
                    expanded = [ENERGY.get(c, c) for c in codes] if codes is not None else None
                    raw_cost = right.get("cost")
                    cleaned = [c for c in (raw_cost or []) if c]
                    rows.extend([
                        row(f"attacks.{index}.cost", group, "能量费用", expanded, raw_cost,
                            canonical=(expanded, cleaned), mik_path=f"attack[{index}].cost = {codes}",
                            wiki_path=f"card_blocks[].attacks[{index}].cost",
                            hint="MIK 字母已按能量类型展开；Wiki 空槽只用于对照，+ 标记没有被删除。"),
                        row(f"attacks.{index}.damage", group, "伤害", left.get("damage"), right.get("damage"),
                            mik_path=f"attack[{index}].damage", wiki_path=f"card_blocks[].attacks[{index}].damage",
                            hint="空白可能表示招式没有固定伤害数值，须结合效果正文；+ 与 × 不互换。"),
                    ])
        footer = block["footers"][0]["fields"] if block["footers"] else {}
        weakness, resistance = attr.get("weakness"), attr.get("resistance")
        rows.extend([
            row("weakness.type", "其他规则", "弱点属性", ENERGY.get((weakness or {}).get("energy")), footer.get("weakness"),
                mik_path="pokemonAttr.weakness.energy", wiki_path="footers[].fields.weakness"),
            row("weakness.value", "其他规则", "弱点修正", (weakness or {}).get("value"), footer.get("weaknessnumber"),
                mik_path="pokemonAttr.weakness.value", wiki_path="footers[].fields.weaknessnumber",
                hint="优先保留 Wiki 显式 weaknessnumber；本记录缺失时可从 mik 补充，不能给所有卡默认填 ×2。"),
            row("resistance", "其他规则", "抗性", resistance, footer.get("resistance"),
                mik_path="pokemonAttr.resistance", wiki_path="footers[].fields.resistance"),
            row("retreat", "其他规则", "撤退费用", str(attr["retreatCost"]), footer.get("retreat"),
                mik_path="pokemonAttr.retreatCost", wiki_path="footers[].fields.retreat"),
        ])
    else:
        options = {}
        for effect in block["effects"]:
            for language, option in effect.get("texts", {}).items():
                if language in {"en", "ja", "zh-Hant"}:
                    options[language] = options.get(language, "") + option.get("text", "")
        effects = "".join(effect["display"].get("effect") or "" for effect in shown["effects"])
        rows.append(row(
            "effects", "规则说明", "效果描述", mik["description"], effects, selectable=True,
            mik_path="description", wiki_path=f"blocks.{block_index}.effects[].display.effect",
            provenance=provenance.get(f"blocks.{block_index}.effects.0"), languages=options,
            hint="基本能量的空白描述不是缺少规则或任意能量通配。",
        ))
    return rows


def encode_image(path, expected, *, preview=False):
    raw = path.read_bytes()
    if sha(raw) != expected:
        raise ValueError(f"Image checksum mismatch: {path}")
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        source_size = list(image.size)
        if preview:
            image = image.convert("RGB")
            image.thumbnail((700, 980), Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, "WEBP", quality=94, method=5)
            raw, mime = buffer.getvalue(), "image/webp"
            display_size = list(image.size)
        else:
            if image.format != "PNG":
                raise ValueError("Expected a frozen MIK PNG.")
            mime, display_size = "image/png", source_size
    return {"src": f"data:{mime};base64," + base64.b64encode(raw).decode("ascii"),
            "source_sha256": expected, "source_size": source_size,
            "display_size": display_size, "derived_preview": preview}


def local_wiki_image(view, index, mik, library=None):
    library = Path(library or LIBRARY).resolve()
    recorded = view.get("image")
    if not recorded:
        return None
    for printing in recorded.get("printings", []):
        key = (printing.get("language"), (printing.get("set_code") or "").casefold(), printing.get("number"))
        entry = index.get(key)
        if not entry:
            continue
        metadata_path = (library / entry["metadata_file"]).resolve()
        if not metadata_path.is_relative_to(library):
            continue
        metadata = load(metadata_path)
        for asset in metadata.get("images", []):
            if asset.get("sha256") != recorded.get("sha256"):
                continue
            path = metadata_path.parent / asset["file"]
            if not path.resolve().is_relative_to(library) or not path.is_file():
                continue
            image = encode_image(path, recorded["sha256"], preview=True)
            same = entry["set_id"].casefold() == mik["setCode"].casefold() and (
                entry["number"].split("/")[0].lstrip("0") == mik["cardIndex"].lstrip("0")
            )
            image.update({"filename": recorded["wiki_filename"], "identity": f"{entry['set_id']} · {entry['number']}",
                          "language": recorded.get("image_language"), "same_printing_candidate": same,
                          "note": ("系列与编号分子一致，仍需独立核对卡面。" if same else "这是同规则页面的其他印刷版，不能当作当前 MIK 印刷版。")})
            return image
    return None


def checked_url(value, hostname):
    parsed = urlsplit(value or "")
    return value if parsed.scheme == "https" and parsed.hostname == hostname else None
