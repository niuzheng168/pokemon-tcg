"""Offline MIK/52Poké candidate staging; never writes the production library.

READY means this pilot's checks passed, not implemented game effects or human
approval. Unresolved semantics/printing identities are explicitly held.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import copy
from difflib import SequenceMatcher
import gzip
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import unicodedata

from opencc import OpenCC
from PIL import Image
import mwparserfromhell

from .common import TOOL, output_root, require, read_selection, safe_path
from .common import write as bounded_write

ROOT = TOOL / "exports/mik-merge"
SOURCE = TOOL / "exports/mik-source"
SNAPSHOT = TOOL / "snapshots/2026.10.18"
from card_storage import printing_identity

CC = OpenCC("t2s")
ENERGY = dict(zip("GRWLPFDMNYC", ["草", "火", "水", "雷", "超", "斗", "恶", "钢", "龙", "妖", "无"]))
STAGES = {"Basic": "基础", "基本": "基础", "Stage 1": "1阶", "Stage1": "1阶", "1阶进化": "1阶",
          "一阶进化": "1阶", "Stage 2": "2阶", "Stage2": "2阶", "2阶进化": "2阶", "二阶进化": "2阶"}
REMINDERS = {
    "GX": "[对战中，己方的GX招式只能使用1次。]",
    "VSTAR": "[对战中，己方的【VSTAR】力量只能使用1次。]",
}
# Populated only from an explicitly supplied, image-hash-bound observation file.
OBSERVED_NUMBERS = {}


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    bounded_write(ROOT, path, value)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def names(value):
    return re.sub(r"[\W_]+", "", CC.convert(unicodedata.normalize("NFKC", str(value or ""))).casefold())


def layout(value):
    return re.sub(r"[\s【】]", "", str(value or ""))


def number_head(value):
    head = str(value or "").split("/")[0]
    return str(int(head)) if head.isdigit() else head


def energy(value):
    if isinstance(value, str):
        value = CC.convert(value)
    return {"无色": "无", "格斗": "斗", "电": "雷", "一般": "无"}.get(value, value)


def costs(attack, mik=False):
    values = [ENERGY.get(c, c) for c in attack.get("cost", "")] if mik else attack.get("cost", [])
    return Counter(energy(v) for v in values if v)


def damage(value):
    # Never discard +, minus or multiplication marks.
    return re.sub(r"\s+", "", str(value or ""))


def render_known_wiki(value):
    """Render a bounded template subset; retain unknown templates, never erase them."""
    def render(code):
        output = []
        for node in mwparserfromhell.parse(str(code)).nodes:
            kind = type(node).__name__
            if kind == "Template":
                name = CC.convert(str(node.name).strip()).casefold()
                arg = lambda n: render(node.get(str(n)).value) if node.has(str(n)) else ""
                if name == "e":
                    output.append(energy(arg(1)))
                elif name == "tcg":
                    output.append(arg(2) if node.has("2") else arg(1))
                elif name == "拥有规则的宝可梦":
                    output.append(arg(1) if node.has("1") else "拥有规则的宝可梦")
                else:
                    output.append(str(node))
            elif kind == "Wikilink":
                output.append(render(node.text if node.text is not None else node.title))
            elif kind == "Tag":
                output.append("\n" if str(node.tag).casefold() == "br" else render(node.contents or ""))
            elif kind == "Comment":
                continue
            else:
                output.append(str(node))
        return "".join(output)
    text = CC.convert(html.unescape(render(value)))
    text = re.sub(r"'{2,5}", "", text)
    return re.sub(r"\s+", " ", text).strip()


def prepare_card(wiki, view):
    """Evidence-based derived repairs; originals remain in separate frozen files."""
    card, display, repairs = copy.deepcopy(wiki), copy.deepcopy(view), []
    for index, block in enumerate(card["card_blocks"]):
        shown = display["blocks"][index]
        if block["kind"] == "pokemon":
            for key in ("type", "stage", "evolves_from"):
                old = block.get(key)
                new = energy(old) if key == "type" else CC.convert(old) if isinstance(old, str) else old
                if old != new:
                    repairs.append({"field": f"blocks.{index}.{key}", "old": old, "new": new,
                                    "method": "t2s_and_energy_label_alias"})
                    block[key] = shown["display"][key] = new
            for slot, attack in enumerate(block["attacks"]):
                converted = [energy(value) for value in attack["cost"]]
                if converted != attack["cost"]:
                    repairs.append({"field": f"blocks.{index}.attacks.{slot}.cost", "old": attack["cost"],
                                    "new": converted, "method": "t2s_energy_labels"})
                    attack["cost"] = converted
                    shown["attacks"][slot]["display"]["energy_cost"] = converted
        if block["header_template"].endswith("/VSTAR"):
            if block["stage"] != "VSTAR":
                repairs.append({"field": f"blocks.{index}.stage", "old": block["stage"], "new": "VSTAR",
                                "evidence": block["header_template"], "method": "explicit_header_template"})
                block["stage"] = shown["display"]["stage"] = "VSTAR"
            evo = block.get("evolves_from")
            if evo and block["header"].get("evostage") == "V" and not evo.endswith("V"):
                repairs.append({"field": f"blocks.{index}.evolves_from", "old": evo, "new": evo + "V",
                                "evidence": "header/VSTAR with evostage=V", "method": "explicit_evolution_template"})
                block["evolves_from"] = shown["display"]["evolves_from"] = evo + "V"
        keep, mapping = [], {}
        for old_index, ability in enumerate(block["abilities"]):
            if (ability["template"] == "卡牌信息/VSTAR力量" and not ability["names"]
                    and not ability["effects"] and not ability["fields"]):
                repairs.append({"field": f"blocks.{index}.abilities.{old_index}", "method": "remove_empty_vstar_section_heading",
                                "source_template_index": ability["source_template_index"]})
            else:
                mapping[old_index] = len(keep)
                keep.append(old_index)
        block["abilities"] = [block["abilities"][i] for i in keep]
        shown["abilities"] = [shown["abilities"][i] for i in keep]
        adjusted = {}
        for path, provenance in display["field_provenance"].items():
            match = re.match(rf"blocks\.{index}\.abilities\.(\d+)(\..*)?$", path)
            if match:
                old_index = int(match[1])
                if old_index not in mapping:
                    continue
                path = f"blocks.{index}.abilities.{mapping[old_index]}{match[2] or ''}"
            adjusted[path] = provenance
        display["field_provenance"] = adjusted
        for slot, attack in enumerate(block["attacks"]):
            marker = attack["fields"].get("damageP")
            operator = {"加": "+", "乘": "×", "减": "-", "除": "÷"}.get(marker)
            if operator and attack["damage"] and not attack["damage"].endswith(operator):
                value = attack["damage"] + operator
                repairs.append({"field": f"blocks.{index}.attacks.{slot}.damage", "old": attack["damage"],
                                "new": value, "evidence": {"damage": attack["fields"].get("damage"), "damageP": marker},
                                "method": "explicit_damage_operator_field"})
                attack["damage"] = shown["attacks"][slot]["display"]["damage"] = value
        for group in ("attacks", "abilities", "effects"):
            for slot, item in enumerate(block[group]):
                options = item.get("texts" if group == "effects" else "effects", {})
                source = next((options[language] for language in ("zh-Hans", "zh", "zh-Hant")
                               if options.get(language, {}).get("wikitext")), None)
                if not source:
                    continue
                old = shown[group][slot]["display"].get("effect")
                new = render_known_wiki(source["wikitext"])
                # Restrict this correction to an obvious self-pronoun typo in effect text.
                new = new.replace("自已", "自己")
                if new != old:
                    repairs.append({"field": f"blocks.{index}.{group}.{slot}.effect", "old": old, "new": new,
                                    "method": "bounded_template_display_text_and_t2s",
                                    "source_parameter": source.get("parameter")})
                    shown[group][slot]["display"]["effect"] = new
    return card, display, repairs


def subtype(block):
    if block["kind"] == "pokemon":
        return "Pokemon"
    if block["kind"] == "energy":
        return "Basic Energy" if block["header"].get("base") == "y" else "Special Energy"
    text = str(block["header"].get("type", "")) + str(block["header"].get("type2", ""))
    if "道具" in text:
        return "Tool"
    if "支援者" in text or "支持者" in text:
        return "Supporter"
    if "竞技场" in text or "场地" in text:
        return "Stadium"
    return "Item" if "物品" in text else "unknown"


def structural(mik, block, wiki):
    checks = {"game": block["game"] == "tcg", "kind": subtype(block) == mik["cardType"]}
    attr = mik.get("pokemonAttr")
    if not attr:
        return checks
    checks.update({
        "hp": attr["hp"] == block["hp"],
        "type": ENERGY.get(attr["energyType"]) == energy(block["type"]),
        "stage": STAGES.get(attr["stage"], attr["stage"]) == STAGES.get(CC.convert(block["stage"] or ""), CC.convert(block["stage"] or "")),
        "attack_count": len(attr["attack"]) == len(block["attacks"]),
        "ability_count": len(attr["ability"]) == len(block["abilities"]),
    })
    wiki_en = wiki["names"].get("en", {}).get("text", "")
    if mik.get("mechanic") == "ex":
        checks["modern_ex_not_legacy_EX"] = not wiki_en.endswith("-EX") and "/EX" not in block["header_template"]
    if mik.get("mechanic") == "EX":
        checks["legacy_EX_not_modern_ex"] = wiki_en.endswith("-EX") or "/EX" in block["header_template"]
    for index, (left, right) in enumerate(zip(attr["attack"], block["attacks"])):
        checks[f"attacks.{index}.cost_including_plus"] = costs(left, True) == costs(right)
        checks[f"attacks.{index}.damage_preserving_operators"] = damage(left["damage"]) == damage(right["damage"])
    footers = [footer["fields"] for footer in block["footers"]]
    if footers:
        if any("retreat" in footer for footer in footers):
            checks["retreat"] = any(str(attr["retreatCost"]) == str(footer.get("retreat")) for footer in footers)
        actual_weaknesses = {energy(footer.get("weakness")) for footer in footers if footer.get("weakness")}
        expected = ENERGY.get((attr.get("weakness") or {}).get("energy"))
        checks["weakness_type"] = actual_weaknesses == ({expected} if expected else set())
        actual_resistance = {energy(footer.get("resistance")) for footer in footers if footer.get("resistance")}
        expected_resistance = ENERGY.get((attr.get("resistance") or {}).get("energy"))
        checks["resistance_type"] = actual_resistance == ({expected_resistance} if expected_resistance else set())
    return checks


def direct_printings(mik, wiki):
    return [p for p in wiki["printings"] if p["language"] == "zh-Hans"
            and (p.get("set_code") or "").casefold() == mik["setCode"].casefold()
            and number_head(p.get("number")) == number_head(mik["cardIndex"])]


def validate_source(key):
    directory = SOURCE / "cards" / key
    mik = load(directory / "metadata.json")
    envelope = load(directory / "source-response.json")
    receipt, image_receipt = [load(directory / name) for name in ("metadata-receipt.json", "image-receipt.json")]
    require(mik["setCode"] + "/" + mik["cardIndex"] == key, "MIK source identity mismatch.")
    require(envelope["code"] == 200 and envelope["data"] == mik, "MIK metadata does not match its source response.")
    require(digest(directory / "source-response.json") == receipt["sha256"], "MIK response receipt mismatch.")
    require(digest(directory / "image.png") == image_receipt["sha256"] == image_receipt["image"]["sha256"],
            "MIK image receipt mismatch.")
    with Image.open(directory / "image.png") as image:
        image.load()
        require(list(image.size) == [image_receipt["image"]["width"], image_receipt["image"]["height"]],
                "MIK image dimensions do not match the receipt.")
        size = list(image.size)
    return mik, {"metadata_sha256": digest(directory / "metadata.json"),
                 "image_sha256": image_receipt["sha256"], "image_size": size,
                 "image_bytes": (directory / "image.png").stat().st_size,
                 "image_source_url": image_receipt["url"]}


class Matcher:
    def __init__(self, cards, views):
        self.cards, self.views = cards, views
        self.prepared = {}
        self.by_name, self.by_print = defaultdict(set), defaultdict(set)
        for page_id, wiki in cards.items():
            for name in [wiki["display_name"], views[page_id]["display"]["name"]] + [
                v.get("text") for v in wiki["names"].values()
            ]:
                if names(name):
                    self.by_name[names(name)].add(page_id)
            for printing in wiki["printings"]:
                if printing["language"] == "zh-Hans" and printing.get("set_code") and printing.get("number"):
                    self.by_print[(printing["set_code"].casefold(), number_head(printing["number"]))].add(page_id)

    def find(self, mik):
        name_ids = set(self.by_name[names(mik["name"])]) | self.by_name[names(mik.get("nameEn"))]
        if mik.get("nameEn") in {"Boss's Orders", "Professor's Research"}:
            for key, ids in self.by_name.items():
                if key.startswith(names(mik["nameEn"])):
                    name_ids.update(ids)
        print_ids = self.by_print[(mik["setCode"].casefold(), number_head(mik["cardIndex"]))]
        ids = name_ids | print_ids
        # Conservative text fallback, still followed by hard structural gates.
        if not ids:
            query = set(layout(mik["description"])[i:i+2] for i in range(max(0, len(layout(mik["description"])))-1))
            ranked = []
            for page_id, view in self.views.items():
                text = "".join(item["display"].get("effect") or ""
                               for block in view["blocks"] for group in ("attacks", "abilities", "effects")
                               for item in block[group])
                grams = {layout(text)[i:i+2] for i in range(max(0, len(layout(text)))-1)}
                overlap = len(query & grams)
                if overlap:
                    ranked.append((overlap / max(1, len(query | grams)), page_id))
            ids.update(page_id for _, page_id in sorted(ranked, reverse=True)[:8])
        candidates = []
        for page_id in sorted(ids):
            if page_id not in self.prepared:
                self.prepared[page_id] = prepare_card(self.cards[page_id], self.views[page_id])
            wiki, _, repairs = self.prepared[page_id]
            for block_index, block in enumerate(wiki["card_blocks"]):
                if block["game"] != "tcg":
                    continue
                checks = structural(mik, block, wiki)
                direct = direct_printings(mik, wiki)
                candidates.append({
                    "page_id": page_id, "title": wiki["title"], "block": block_index,
                    "checks": checks, "failed": [key for key, value in checks.items() if not value],
                    "direct_printings": direct,
                    "derived_normalizations": repairs,
                    "rank_hint": (100 if direct else 0) + (10 if page_id in name_ids else 0) + sum(checks.values()),
                })
        candidates.sort(key=lambda c: (bool(c["failed"]), -c["rank_hint"], c["page_id"], c["block"]))
        passing = [candidate for candidate in candidates if not candidate["failed"]]
        direct = [candidate for candidate in passing if candidate["direct_printings"]]
        chosen = passing[0] if len(passing) == 1 else direct[0] if len(direct) == 1 else None
        return chosen, candidates, sorted(name_ids)


def change(metadata, diffs, path, value, source, key, hashes):
    parts = path.split(".")
    parent = metadata
    for part in parts[:-1]:
        parent = parent[int(part)] if isinstance(parent, list) else parent[part]
    leaf = parts[-1]
    old = parent.get(leaf)
    if old != value:
        diffs.append({"path": path, "old_value": old, "new_value": value, "source": source})
        parent[leaf] = value
    provenance_key = path.replace(".display", "").removeprefix("display.")
    metadata["field_provenance"][provenance_key] = {
        "source": source, "source_language": "zh-Hans", "source_card_id": key,
        "source_metadata_sha256": hashes["metadata_sha256"], "human_reviewed": False,
    }


def merge_candidate(key, mik, hashes, chosen, wiki, view):
    index = chosen["block"]
    block = wiki["card_blocks"][index]
    merged = {
        "schema_version": 1, "game": "tcg", "printing_language": "zh-Hans",
        "set_id": mik["setCode"], "number": None, "number_slug": None, "id": "mik:" + key,
        "identity_flags": [], "metadata_language": "zh-Hans", "name": view["display"]["name"],
        "set_names_zh_hans": sorted({p["display"]["set_name"] for p in view["simplified_printings"]
                                   if p["display"].get("set_name")
                                   and (p.get("set_code") or "").casefold() == mik["setCode"].casefold()}),
        "display": {"name": view["display"]["name"]},
        "blocks": [copy.deepcopy(view["blocks"][index])],
        "field_provenance": {}, "text_review": copy.deepcopy(view["review"]),
        "review_flags": [], "human_reviewed": False,
        "source_pages": [{k: wiki[k] for k in ("id", "page_id", "revision_id", "source_url", "revision_url", "source_wikitext_sha256")}],
        "source_printings": [{"page_id": wiki["page_id"], "printing": p, "evidence": None}
                             for p in chosen["direct_printings"]],
        "external_source_records": [{
            "source": "mik", "source_type": "third-party", "id": key,
            "metadata_sha256": hashes["metadata_sha256"], "original_metadata_file": "mik-metadata.json",
            "rule_block": index, "mechanic": mik.get("mechanic"), "labels": mik.get("label"),
        }],
        "archive_release": wiki["archive_release"], "attribution": copy.deepcopy(wiki["attribution"]),
        "rules_engine_implemented": False, "not_an_engine_version_mapping": True,
        "primary_image": "image.png",
        "images": [{"file": "image.png", "sha256": hashes["image_sha256"],
                    "asset_id": "sha256:" + hashes["image_sha256"],
                    "printing_language": "zh-Hans", "source": "mik", "source_printing_key": key,
                    "source_url": hashes["image_source_url"], "source_page_url": "https://tcg.mik.moe/cards/" + key,
                    "source_cache_file": str(SOURCE / "cards" / key / "image.png"),
                    "width": hashes["image_size"][0], "height": hashes["image_size"][1], "bytes": hashes["image_bytes"],
                    "kind": "source_card_image", "derivation": None,
                    "verification": {"method": "mik_receipt_sha256_and_complete_decode", "human_reviewed": False},
                    "not_an_engine_version_mapping": True}],
    }
    for path, value in view["field_provenance"].items():
        if path == "name" or path.startswith(f"blocks.{index}."):
            merged["field_provenance"][path.replace(f"blocks.{index}.", "blocks.0.", 1)] = copy.deepcopy(value)
    diffs, semantics, holds = [], [], []
    possible_numbers = {p["number"] for p in chosen["direct_printings"]}
    full_number = next(iter(possible_numbers)) if len(possible_numbers) == 1 else OBSERVED_NUMBERS.get(key)
    if full_number:
        merged["number"] = full_number
        try:
            identity = printing_identity({"language": "zh-Hans", "set_code": mik["setCode"], "number": full_number})
            merged.update(identity)
        except ValueError as error:
            holds.append({"code": "printing_schema_unsupported", "detail": str(error), "printed_number": full_number})
    else:
        holds.append({"code": "full_printing_number_unverified", "detail": "No unique complete Wiki printing identity; no denominator inferred."})
    if key in OBSERVED_NUMBERS and not possible_numbers:
        merged["identity_flags"].append("printing_identity_from_previously_inspected_card_face")
    change(merged, diffs, "name", mik["name"], "mik", key, hashes)
    change(merged, diffs, "display.name", mik["name"], "mik", key, hashes)
    attr = mik.get("pokemonAttr")
    if attr:
        for group, source_group in [("attacks", "attack"), ("abilities", "ability")]:
            for slot, left in enumerate(attr[source_group]):
                right = block[group][slot]
                shown = merged["blocks"][0][group][slot]["display"]
                old_effect = shown.get("effect")
                new_effect = left["text"]
                status = "layout_equal" if layout(new_effect) == layout(old_effect) else "needs_semantic_review"
                for mechanism, reminder in REMINDERS.items():
                    if reminder in new_effect and mechanism in right.get("template", ""):
                        if layout(new_effect.replace(reminder, "")) == layout(old_effect):
                            status = "equal_with_explicit_mechanic_reminder"
                semantics.append({"field": f"{group}.{slot}.effect", "mik": new_effect, "wiki": old_effect, "status": status})
                if status == "needs_semantic_review":
                    holds.append({"code": "effect_semantics_unresolved", "field": f"{group}.{slot}.effect"})
                change(merged, diffs, f"blocks.0.{group}.{slot}.display.name", left["name"], "mik", key, hashes)
                if new_effect.strip():
                    change(merged, diffs, f"blocks.0.{group}.{slot}.display.effect", new_effect, "mik", key, hashes)
                elif old_effect:
                    holds.append({"code": "mik_effect_missing_existing_wiki_text", "field": f"{group}.{slot}.effect"})
        if len(block["footers"]) == 1 and len(merged["blocks"][0]["footers"]) == 1:
            raw_footer = block["footers"][0]["fields"]
            for raw_key, source_key in [("weaknessnumber", "weakness"), ("resistancenumber", "resistance")]:
                explicit = raw_footer.get(raw_key)
                value = (attr.get(source_key) or {}).get("value")
                path = f"blocks.0.footers.0.display.{raw_key}"
                if explicit not in (None, ""):
                    parent = merged["blocks"][0]["footers"][0]["display"]
                    if raw_key not in parent:
                        diffs.append({"path": path, "old_value": None, "new_value": explicit, "source": "52poke_explicit_footer"})
                        parent[raw_key] = explicit
                elif value is not None:
                    change(merged, diffs, path, value, "mik", key, hashes)
    else:
        effects = merged["blocks"][0]["effects"]
        old_effect = "".join(item["display"].get("effect") or "" for item in effects)
        new_effect = mik["description"]
        status = "layout_equal" if layout(old_effect) == layout(new_effect) else "needs_semantic_review"
        semantics.append({"field": "effects", "mik": new_effect, "wiki": old_effect, "status": status})
        if status != "layout_equal":
            holds.append({"code": "effect_semantics_unresolved", "field": "effects"})
        if new_effect.strip():
            if len(effects) == 1:
                change(merged, diffs, "blocks.0.effects.0.display.effect", new_effect, "mik", key, hashes)
            else:
                holds.append({"code": "trainer_effect_slot_alignment_ambiguous", "detail": f"{len(effects)} Wiki effect slots; not flattened."})
    merged["review_flags"] = sorted({item["code"] for item in holds})
    merged["text_review"]["human_reviewed"] = False
    return merged, diffs, semantics, holds


def run(source, snapshot, selection, run_dir, observations=None):
    global ROOT, SOURCE, SNAPSHOT, OBSERVED_NUMBERS
    SOURCE, SNAPSHOT = Path(source).resolve(), Path(snapshot).resolve()
    selection_path = Path(selection).resolve()
    protected = [SOURCE, SNAPSHOT, TOOL / "library", selection_path]
    if observations:
        protected.append(Path(observations))
    ROOT = output_root(run_dir, protected=protected)
    selected = read_selection(selection_path)
    sampling_method = selected.get("method", "User supplied selection")
    selected_at = selected.get("selected_at_utc")
    manifest = load(SNAPSHOT / "manifest.json")
    snapshot_sha256 = {"manifest.json": digest(SNAPSHOT / "manifest.json")}
    for filename in ("cards.jsonl.gz", "display-zh-hans.jsonl.gz"):
        expected = manifest["files"][filename]["gzip_sha256"]
        require(digest(SNAPSHOT / filename) == expected, "Snapshot integrity check failed: " + filename)
        snapshot_sha256[filename] = expected
    with gzip.open(SNAPSHOT / "cards.jsonl.gz", "rt", encoding="utf-8") as stream:
        cards = {c["page_id"]: c for c in map(json.loads, stream) if "tcg" in c["games"]}
    with gzip.open(SNAPSHOT / "display-zh-hans.jsonl.gz", "rt", encoding="utf-8") as stream:
        views = {c["page_id"]: c for c in map(json.loads, stream)}
    matcher = Matcher(cards, views)
    observation_rows = load(Path(observations))["observations"] if observations else []
    observation_map = {r["mik_id"]: r for r in observation_rows}
    require(len(observation_map) == len(observation_rows), "Duplicate card-face observations.")
    OBSERVED_NUMBERS = {}
    for item in selected["samples"]:
        observed = observation_map.get(item["mik_id"])
        if observed:
            require(observed.get("human_reviewed") is False, "Pilot observations must not impersonate human approval.")
            require(isinstance(observed.get("printed_number"), str) and observed["printed_number"].strip(),
                    "Observation is missing a printed number.")
            # Bind before using the observation to construct a printing identity.
            _, hashes = validate_source(item["mik_id"])
            require(observed["image_sha256"] == hashes["image_sha256"], "Card-face observation image hash mismatch.")
            OBSERVED_NUMBERS[item["mik_id"]] = observed["printed_number"]
    batches = [(batch, [s for s in selected["samples"] if s["batch"] == batch])
               for batch in dict.fromkeys(s["batch"] for s in selected["samples"])]
    all_results = []
    for batch, selected in batches:
        results = []
        for selection in selected:
            key = selection["mik_id"]
            mik, hashes = validate_source(key)
            chosen, candidates, name_ids = matcher.find(mik)
            result = {
                "batch": batch, "index": selection["index"], "mik_id": key, "name": mik["name"],
                "card_type": mik["cardType"], "input_hashes": hashes, "name_candidates": name_ids,
                "candidate_evidence": candidates, "status": "blocked", "chosen": chosen,
                "holds": [], "field_diffs": [], "semantic_pairs": [],
            }
            if chosen:
                raw_wiki, raw_view = cards[chosen["page_id"]], views[chosen["page_id"]]
                wiki, view, repairs = matcher.prepared[chosen["page_id"]]
                merged, diffs, semantics, holds = merge_candidate(key, mik, hashes, chosen, wiki, view)
                merged["derived_normalizations"] = repairs
                observed = observation_map.get(key)
                if observed:
                    require(observed["image_sha256"] == hashes["image_sha256"], "Observation changed.")
                    if observed["printed_number"] != merged["number"]:
                        holds.append({"code": "card_face_printed_number_conflict", "observed": observed["printed_number"],
                                      "candidate_number": merged["number"]})
                    else:
                        merged["images"][0]["verification"]["printed_number_observation"] = observed
                else:
                    holds.append({"code": "card_face_identity_not_independently_checked"})
                merged["review_flags"] = sorted({hold["code"] for hold in holds})
                directory = ROOT / batch / "candidates" / key
                safe_path(ROOT, directory)
                directory.mkdir(parents=True, exist_ok=True)
                for filename in ("metadata.json", "source-response.json", "metadata-receipt.json", "image-receipt.json", "image.png"):
                    target = "mik-metadata.json" if filename == "metadata.json" else filename
                    shutil.copyfile(SOURCE / "cards" / key / filename, safe_path(ROOT, directory / target))
                write(directory / "wiki-source.json", raw_wiki)
                write(directory / "wiki-display.json", raw_view)
                write(directory / "normalized-wiki-source.json", wiki)
                write(directory / "normalized-wiki-display.json", view)
                write(directory / "metadata.json", merged)
                require(merged["schema_version"] == 1 and merged["metadata_language"] == "zh-Hans", "Unexpected merge schema.")
                require(len(merged["blocks"]) == 1 and not merged["rules_engine_implemented"], "Invalid candidate scope.")
                require(digest(directory / "image.png") == merged["images"][0]["sha256"], "Copied image hash mismatch.")
                result.update({"status": "needs_review" if holds else "ready", "holds": holds,
                               "field_diffs": diffs, "semantic_pairs": semantics,
                               "image_identity_observation": observed,
                               "merged_metadata_file": str(directory / "metadata.json")})
                write(directory / "merge-check.json", result)
            else:
                result["holds"] = [{"code": "no_unique_structurally_compatible_candidate"}]
            results.append(result)
        write(ROOT / batch / "results.json", {"batch": batch, "sample_count": len(results),
              "status_counts": dict(Counter(r["status"] for r in results)),
              "production_library_modified": False, "results": results})
        all_results.extend(results)
    report = {"schema": "mik-52poke-staged-candidates-v1",
              "scope": "Selected source printings, staged candidates only; no production writes",
              "archive_release": manifest["archive_release"], "snapshot_sha256": snapshot_sha256,
              "selection_sha256": digest(selection_path), "sampling": sampling_method,
              "selected_at_utc": selected_at,
              "production_library_modified": False, "results": all_results}
    write(ROOT / "pilot-results.json", report)
    write(ROOT / "run-inputs.json", {
        "source": str(SOURCE), "snapshot": str(SNAPSHOT), "selection": str(selection_path),
        "observations": str(Path(observations).resolve()) if observations else None,
    })
    for batch, _ in batches:
        rows = [r for r in all_results if r["batch"] == batch]
        print(batch, dict(Counter(r["status"] for r in rows)))
        for result in rows:
            chosen = result["chosen"]
            print(result["mik_id"], result["name"], (f"52poke:{chosen['page_id']} block {chosen['block']}" if chosen else "NO UNIQUE MATCH"),
                  result["status"], [hold["code"] for hold in result["holds"]])
    return report
