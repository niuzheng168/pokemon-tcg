"""Shared, offline printing-identity paths and lossless card-image publication.

Raw downloads remain a resumable source cache. The user-facing library contains
only identified TCG printings: language / set / full_number_with_underscores.
This module uses only the standard library, including in the portable bundle.
"""
from __future__ import annotations

import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
import re
import shutil
import tempfile

LANGUAGES = {
    **{code: code for code in ("zh-Hans", "zh-Hant", "ja", "en", "ko", "id", "th",
                               "pt", "pt-BR", "it", "fr", "de", "es", "nl", "ru", "pl")},
    "韩文": "ko", "印尼文": "id", "泰文": "th", "葡萄牙文": "pt",
    "巴西葡萄牙文": "pt-BR", "意大利文": "it", "法文": "fr",
    "德文": "de", "西班牙文": "es", "荷兰文": "nl", "俄文": "ru", "波兰文": "pl",
}
SET_CODE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
NUMBER = re.compile(r"[A-Za-z]*[0-9]+[A-Za-z]?(?: +[0-9]+)?(?:/(?:[A-Za-z]*[0-9]+[A-Za-z]?|[A-Za-z0-9]+-P))?")
WINDOWS_RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", re.I)
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}


def printing_identity(printing):
    """Never infer identity from a filename, page ID, name or a partial number."""
    if printing.get("game", "tcg") != "tcg":
        raise ValueError("not_an_entity_tcg_printing")
    language = LANGUAGES.get(printing.get("language"))
    if not language:
        raise ValueError("unknown_or_multiple_printing_languages")
    code, number = printing.get("set_code"), printing.get("number")
    if (not isinstance(code, str) or not SET_CODE.fullmatch(code)
            or code.endswith(".") or ".." in code or WINDOWS_RESERVED.fullmatch(code.split(".")[0])):
        raise ValueError("missing_or_unsupported_set_code")
    if not isinstance(number, str) or not NUMBER.fullmatch(number):
        raise ValueError("missing_or_unsupported_full_number")
    flags = []
    # A Wiki icon is not necessarily the printed promo series. Retain the raw
    # icon separately; an explicit promo suffix provides a less ambiguous code.
    suffix = number.split("/")[-1]
    if re.fullmatch(r"[A-Za-z0-9]+-P", suffix) and code.casefold() != suffix.casefold():
        code = suffix
        flags.append("source_icon_and_printed_promo_suffix_disagree")
    slug = re.sub(r"[/ ]+", "_", number)
    if WINDOWS_RESERVED.fullmatch(slug):
        raise ValueError("reserved_card_number")
    return {
        "game": "tcg", "printing_language": language, "set_id": code,
        "number": number, "number_slug": slug,
        "id": f"tcg:{language}:{code}:{number}", "identity_flags": flags,
    }


def relative_directory(identity):
    # Revalidate even when the caller supplied an identity dictionary.
    checked = printing_identity({
        "game": identity.get("game"), "language": identity["printing_language"],
        "set_code": identity["set_id"], "number": identity["number"],
    })
    if checked["set_id"] != identity["set_id"]:
        raise ValueError("Noncanonical printing identity.")
    return Path(checked["printing_language"]) / checked["set_id"] / checked["number_slug"]


def identity_key(identity):
    # NAS/Windows may be case-insensitive; do not create two conflicting paths.
    return relative_directory(identity).as_posix().casefold()


def canonical_set(identity, aliases):
    code = aliases.get(identity["printing_language"] + "/" + identity["set_id"].casefold(), identity["set_id"])
    checked = printing_identity({
        "language": identity["printing_language"], "set_code": code, "number": identity["number"],
    })
    return {**checked, "identity_flags": identity["identity_flags"]}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_path(root, relative):
    root = Path(root)
    if root.is_symlink() and not root.exists():
        raise FileNotFoundError(f"Library target is unavailable: {root}")
    root.mkdir(parents=True, exist_ok=True)
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Library path escapes its root.")
    return path


@contextmanager
def library_lock(root):
    """One library writer, cross-platform; never wait for an OCR worker."""
    path = safe_path(root, Path(".library.lock"))
    with path.open("a+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def atomic_json(path, value):
    path = Path(path)
    content = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if path.is_file() and path.read_bytes() == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
    return True


def copy_verified(source, destination, expected):
    """Copy byte-for-byte, never replace another image or silently repair one."""
    source, destination = Path(source), Path(destination)
    if digest(source) != expected:
        raise ValueError(f"Source image checksum mismatch: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if digest(destination) != expected:
            raise ValueError(f"Refusing to overwrite a different library image: {destination}")
        return
    fd, name = tempfile.mkstemp(prefix=".image.", suffix=".tmp", dir=destination.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        shutil.copyfile(source, temporary)
        if digest(temporary) != expected:
            raise ValueError("Library copy checksum mismatch.")
        # Publication is serialized by the calling sync/downloader. Recheck
        # before replace so a pre-existing unrelated file is never overwritten.
        if destination.exists():
            if digest(destination) != expected:
                raise ValueError(f"Library image appeared with different bytes: {destination}")
        else:
            temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def attach_image(root, metadata, asset, *, verification=None):
    directory = relative_directory(metadata)
    suffix = Path(asset["local_file"]).suffix.lower()
    if suffix not in IMAGE_SUFFIXES or not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"]):
        raise ValueError("Invalid image suffix or SHA-256.")
    image_language = asset.get("image_language")
    if image_language != metadata["printing_language"]:
        raise ValueError("Image language does not match the printing directory.")
    images = metadata.setdefault("images", [])
    existing = next((image for image in images if image["sha256"] == asset["sha256"]), None)
    filename = existing["file"] if existing else (
        "image" + suffix if not images else f"images/{asset['sha256']}{suffix}"
    )
    destination = safe_path(root, directory / filename)
    copy_verified(asset["local_file"], destination, asset["sha256"])
    record = {
        "file": filename, "sha256": asset["sha256"],
        "asset_id": "sha256:" + asset["sha256"],
        "printing_language": image_language,
        "source_url": asset.get("official_image_url"),
        "source_page_url": asset.get("official_page_url"),
        "source_cache_file": asset["local_file"],
        "width": asset.get("width"), "height": asset.get("height"), "bytes": asset.get("bytes"),
        "kind": ("official_graphic_crop" if asset.get("source") == "crop_from_public_official_caption_graphic"
                 else "source_card_image"),
        "derivation": asset.get("derivation"),
        "verification": verification or asset.get("matching_evidence", {}),
        "not_an_engine_version_mapping": True,
    }
    if existing:
        existing.update(record)
    else:
        images.append(record)
    metadata.setdefault("primary_image", filename)
    return record


def publish_download(root, target, asset):
    with library_lock(root):
        return _publish_download(root, target, asset)


def register_manifest_collisions(root, targets):
    """Detect cross-file collisions before publishing the first manifest image."""
    identities = {}
    for target in targets:
        for use in target.get("uses", []):
            try:
                identity = printing_identity(use)
            except ValueError:
                continue
            key = identity_key(identity)
            entry = identities.setdefault(key, {"pages": set(), "numbers": set()})
            entry["pages"].add(use.get("page_id"))
            entry["numbers"].add(identity["number"])
    found = {key for key, value in identities.items()
             if len(value["pages"]) > 1 or len(value["numbers"]) > 1}
    if found:
        with library_lock(root):
            path = safe_path(root, Path("_review/collision-keys.json"))
            previous = set(json.loads(path.read_text())) if path.exists() else set()
            atomic_json(path, sorted(previous | found))
    return found


def _publish_download(root, target, asset):
    """Fast post-download publication; no OCR, network or metadata rebuild.

    Ambiguous files stay in their raw cache, with an explicit review record.
    A minimal metadata shell is not advertised as Simplified display metadata.
    The offline sync supplies the full Simplified projection later.
    """
    uses = target.get("uses", [])
    reason = None
    identities = []
    try:
        if target.get("semantic_identity_review_required") or any(
            use.get("language_is_requested_target_not_image_verification") for use in uses
        ):
            raise ValueError("semantic_identity_review_required")
        if not uses or any(not use.get("page_id") for use in uses):
            raise ValueError("missing_source_page_identity")
        identities = [printing_identity(use) for use in uses]
        if len({identity_key(i) for i in identities}) != 1 or len({u["page_id"] for u in uses}) != 1:
            raise ValueError("multiple_printing_or_page_identities")
        identity = identities[0]
        if any(i["number"] != identity["number"] for i in identities):
            raise ValueError("number_slug_collision")
        if identity["identity_flags"]:
            raise ValueError("promo_identity_needs_offline_metadata_review")
        if asset.get("image_language") != identity["printing_language"]:
            raise ValueError("unverified_or_conflicting_image_language")
        aliases = Path(root) / "set-codes.json"
        if aliases.exists():
            identity = canonical_set(identity, json.loads(aliases.read_text()))
        metadata_path = safe_path(root, relative_directory(identity) / "metadata.json")
        metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {
            "schema_version": 1, **identity, "metadata_language": None, "name": None,
            "source_pages": [{"page_id": uses[0]["page_id"]}],
            "source_printings": uses, "images": [],
            "review_flags": ["simplified_display_metadata_pending"],
            "attribution": {
                "source": "神奇宝贝百科及其贡献者",
                "source_url": "https://wiki.52poke.com/",
                "license": "CC-BY-NC-SA-3.0",
                "note": "Wiki metadata attribution; card image rights remain with their owners.",
            },
        }
        if (identity_key(metadata) != identity_key(identity)
                or {p["page_id"] for p in metadata["source_pages"]} != {uses[0]["page_id"]}):
            raise ValueError("existing_library_identity_collision")
        # Bulk sync may have quarantined an identity shared by multiple pages.
        collisions = Path(root) / "_review/collision-keys.json"
        if collisions.exists() and identity_key(identity) in json.loads(collisions.read_text()):
            raise ValueError("known_cross_page_identity_collision")
    except (ValueError, KeyError) as error:
        reason = str(error)
    if reason:
        key = hashlib.sha256(target["wiki_filename"].encode("utf-8")).hexdigest()
        atomic_json(safe_path(root, Path("_review/downloads") / (key + ".json")), {
            "reason": reason, "target": target, "source_cache_file": asset["local_file"],
            "sha256": asset["sha256"], "image_copied": False,
        })
        return False
    attach_image(root, metadata, asset)
    atomic_json(metadata_path, metadata)
    return True
