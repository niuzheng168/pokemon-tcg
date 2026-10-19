"""Shared local IO boundaries. Runtime data is restricted to ignored exports."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

TOOL = Path(__file__).resolve().parents[1]
REPO = TOOL.parents[1]
EXPORTS = TOOL / "exports"


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def output_root(path, *, protected=()):
    root, exports = Path(path).resolve(), EXPORTS.resolve()
    require(root != exports and root.is_relative_to(exports),
            "Run directory must be a strict child of tools/52poke-cards/exports.")
    for source in protected:
        source = Path(source).resolve()
        require(not root.is_relative_to(source) and not source.is_relative_to(root),
                "Output must not overlap source data, snapshots, or the library.")
    return root


def safe_path(root, path):
    root, path = Path(root).resolve(), Path(path)
    require(path.resolve().is_relative_to(root), "Output path escapes the isolated run directory.")
    return path


def write(root, path, value):
    path = safe_path(root, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = safe_path(root, path.with_suffix(path.suffix + ".tmp"))
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_selection(path):
    value = load(path)
    require(value.get("schema") == "mik-52poke-selection-v1", "Unknown selection schema.")
    require(isinstance(value.get("samples"), list) and value["samples"], "Selection must not be empty.")
    seen, samples, indices = set(), [], {}
    for item in value["samples"]:
        identity, batch = item.get("mik_id", ""), item.get("batch", "sample")
        require(isinstance(identity, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", identity),
                "Unsafe MIK printing identifier.")
        require(isinstance(batch, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", batch), "Unsafe batch identifier.")
        require(identity not in seen, "Duplicate MIK printing in selection.")
        seen.add(identity)
        indices[batch] = indices.get(batch, 0) + 1
        samples.append({"mik_id": identity, "batch": batch, "index": indices[batch]})
    return {**value, "samples": samples}
