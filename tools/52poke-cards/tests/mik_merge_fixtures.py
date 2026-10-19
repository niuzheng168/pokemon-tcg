"""Synthetic metadata, solid-colour PNGs and a fake Foundry transport; no downloads."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
from PIL import Image

from mik_merge import semantics


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def effect(text):
    return {"zh-Hans": {"text": text, "wikitext": text, "parameter": "effect"}}


def make_card(index, mechanic="", stage="Basic", basic_energy=False):
    name, english = f"合并测试{index}{mechanic}", f"Merge Test {index} {mechanic}"
    key = "DAR" if basic_energy else f"{index:03d}"
    number = key if basic_energy else f"{key}/005"
    ability = {"name": "测试特性", "text": ""}
    attack = {"name": "测试招式", "text": "", "cost": "CCC", "damage": "160"}
    if mechanic == "GX":
        ability["text"] = "在自己的回合，每次从自己的手牌将草能量附着于这只宝可梦身上时，可使用1次。"
        attacks = [attack, {"name": "测试GX", "text": "给对手的所有宝可梦各造成50点伤害。额外附有2个能量时，回复己方全部HP。" + semantics.RULES["GX"]["reminder"],
                            "cost": "CCC+", "damage": ""}]
        wiki_ability = "在自己的回合从手牌将1个草能量贴在这只宝可梦身上时可以使用1次。"
    elif stage == "VSTAR":
        ability["text"] = "在自己的回合可以使用。将自己牌库上方的7张卡放于弃牌区。选择自己弃牌区中最多2张卡加入手牌。" + semantics.RULES["VSTAR"]["reminder"]
        attacks = [attack]
        wiki_ability = "在自己的回合时可使用。丢弃自己牌库顶的7张卡。从自己弃牌区选择最多2张卡加入手牌。"
    else:
        attacks = [{**attack, "damage": "180+" if mechanic == "ex" else "160"}]
        wiki_ability = ""
    attr = {
        "energyType": "G", "stage": stage, "hp": "270", "ability": [ability], "attack": attacks,
        "weakness": None if mechanic == "ex" else {"energy": "R", "value": "×2"},
        "resistance": None, "retreatCost": 3, "evolvesFrom": "测试前阶V" if stage == "VSTAR" else "",
    }
    mik = {
        "name": name, "nameEn": english, "setCode": "TEST", "cardIndex": key, "setCardsNum": "",
        "cardType": "Basic Energy" if basic_energy else "Pokemon", "mechanic": mechanic,
        "pokemonAttr": None if basic_energy else attr, "description": "", "label": [],
        "effectId": f"synthetic-{index}", "effectSameCards": [], "artist": "测试", "rarity": "测试",
        "regulationMark": "", "releaseDate": "", "regulationLegal": {},
    }
    raw_attacks, shown_attacks = [], []
    for slot, item in enumerate(attacks):
        text = item["text"]
        if mechanic == "GX" and slot == 1:
            text = "对对手的全部宝可梦造成50点伤害。若额外携带2个能量，全部己方HP恢复。"
        damage = "180" if mechanic == "ex" else item["damage"]
        raw_attacks.append({
            "template": "卡牌信息/attack/GX" if mechanic == "GX" and slot == 1 else "卡牌信息/attack",
            "names": {"zh-Hans": {"text": item["name"]}}, "effects": effect(text),
            "cost": [dict(zip("GC+", ["草", "无", "+"])).get(c, c) for c in item["cost"]],
            "damage": damage, "fields": {"damage": damage, **({"damageP": "加"} if mechanic == "ex" else {})},
            "source_template_index": slot + 2,
        })
        shown_attacks.append({"display": {"name": item["name"], "effect": text, "damage": damage,
                                         "energy_cost": raw_attacks[-1]["cost"]}})
    raw_abilities = [{
        "template": "卡牌信息/power/VSTAR" if stage == "VSTAR" else "卡牌信息/power",
        "names": {"zh-Hans": {"text": ability["name"]}}, "effects": effect(wiki_ability),
        "fields": {}, "source_template_index": 5,
    }]
    shown_abilities = [{"display": {"name": ability["name"], "effect": wiki_ability}}]
    if stage == "VSTAR":
        raw_abilities.insert(0, {"template": "卡牌信息/VSTAR力量", "names": {}, "effects": {}, "fields": {},
                                 "source_template_index": 4})
        shown_abilities.insert(0, {"display": {}})
    footer = {"retreat": "3", **({"weakness": "火"} if attr["weakness"] else {})}
    block = {
        "kind": "energy" if basic_energy else "pokemon", "game": "tcg",
        "header_template": "卡牌信息/header/VSTAR" if stage == "VSTAR" else "卡牌信息/header",
        "header": {"base": "y", **({"evostage": "V"} if stage == "VSTAR" else {})},
        "hp": "270", "type": "草", "stage": "V" if stage == "VSTAR" else "基础",
        "evolves_from": "测试前阶" if stage == "VSTAR" else "",
        "attacks": [] if basic_energy else raw_attacks, "abilities": [] if basic_energy else raw_abilities,
        "effects": [], "footers": [] if basic_energy else [{"fields": footer}],
    }
    wiki = {
        "id": f"52poke:{100 + index}", "page_id": 100 + index, "revision_id": 2,
        "title": name, "display_name": name, "names": {"zh": {"text": name}, "en": {"text": english}},
        "games": ["tcg"], "card_blocks": [block],
        "printings": [{"language": "zh-Hans", "set_code": "TEST", "number": number, "source_template_index": 10}],
        "source_url": "https://wiki.52poke.com/wiki/Test", "revision_url": "https://wiki.52poke.com/?oldid=2",
        "source_wikitext_sha256": "a" * 64, "archive_release": "test", "attribution": {"source": "Synthetic test"},
    }
    view = {
        "page_id": 100 + index, "display": {"name": name}, "field_provenance": {}, "review": {"human_reviewed": False},
        "blocks": [{"display": {"name": name, "stage": block["stage"], "evolves_from": block["evolves_from"]},
                    "attacks": [] if basic_energy else shown_attacks, "abilities": [] if basic_energy else shown_abilities,
                    "effects": [], "footers": [] if basic_energy else [{"display": dict(footer)}]}],
        "simplified_printings": [{"set_code": "TEST", "display": {"set_name": "Synthetic test"}}],
    }
    return mik, wiki, view


def create_run_inputs(root):
    source, snapshot = root / "source", root / "snapshot"
    cards, views, samples, observations = [], [], [], []
    variants = [(1, "GX", "Basic", False), (2, "V", "VSTAR", False), (3, "V", "VSTAR", False),
                (4, "ex", "Basic", False), (5, "", "Basic", True)]
    for variant in variants:
        mik, wiki, view = make_card(*variant)
        identity = "TEST/" + mik["cardIndex"]
        directory = source / "cards" / identity
        write(directory / "metadata.json", mik)
        write(directory / "source-response.json", {"code": 200, "data": mik})
        raw = (directory / "source-response.json").read_bytes()
        write(directory / "metadata-receipt.json", {"sha256": hashlib.sha256(raw).hexdigest()})
        Image.new("RGB", (30, 42), (20, 60, 40)).save(directory / "image.png")
        image_hash = hashlib.sha256((directory / "image.png").read_bytes()).hexdigest()
        write(directory / "image-receipt.json", {"sha256": image_hash, "url": "https://example.invalid/test.png",
              "image": {"sha256": image_hash, "width": 30, "height": 42}})
        observations.append({"mik_id": identity, "image_sha256": image_hash, "printed_number": wiki["printings"][0]["number"],
                             "method": "synthetic_test_only", "human_reviewed": False})
        samples.append({"batch": "sample", "mik_id": identity})
        cards.append(wiki)
        views.append(view)
    snapshot.mkdir()
    files = {}
    for name, rows in (("cards.jsonl.gz", cards), ("display-zh-hans.jsonl.gz", views)):
        raw = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode()
        (snapshot / name).write_bytes(gzip.compress(raw, mtime=0))
        files[name] = {"gzip_sha256": hashlib.sha256((snapshot / name).read_bytes()).hexdigest()}
    write(snapshot / "manifest.json", {"archive_release": "synthetic-test", "files": files})
    selection, observation_file = root / "selection.json", root / "observations.json"
    write(selection, {"schema": "mik-52poke-selection-v1", "samples": samples})
    write(observation_file, {"observations": observations})
    return source, snapshot, selection, observation_file


def fake_response(payload, requests):
    """Transport fixture; expected control answers never enter the real payload."""
    visible = json.loads(payload["messages"][1]["content"])["pairs"]
    control_answers = {}
    for control in semantics.controls():
        left = semantics.mask_verified_reminder(control["left"], control["context"])
        right = semantics.mask_verified_reminder(control["right"], control["context"])
        control_answers[(left, right)] = control["expected_accept"]
        control_answers[(right, left)] = control["expected_accept"]
    rows = []
    for pair in visible:
        equivalent = control_answers.get((pair["left"], pair["right"]), True)
        dimensions = []
        for dimension in semantics.DIMENSIONS:
            relation = "match" if dimension in ("amounts", "operations") else "absent"
            if not equivalent and dimension == "operations":
                relation = "different"
            dimensions.append({
                "dimension": dimension, "relation": relation,
                "left_evidence_ids": [pair["left_spans"][0]["id"]] if relation != "absent" else [],
                "right_evidence_ids": [pair["right_spans"][0]["id"]] if relation != "absent" else [],
                "explanation": "Synthetic transport fixture, not model inference.",
            })
        rows.append({"pair_id": pair["pair_id"], "verdict": "equivalent" if equivalent else "different",
                     "summary": "Synthetic transport fixture.", "dimensions": dimensions})
    requests.append(copy.deepcopy(payload))
    return {"model": payload["model"], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"results": rows})}}]}
