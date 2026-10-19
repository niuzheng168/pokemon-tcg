"""Download publisher-provided XML snapshots; never crawl live wiki pages."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = "https://api.github.com/repos/52poke/mwarchiver/releases"
USER_AGENT = "PokemonCardStudy/1.0 (noncommercial official-archive importer)"
# Published by 52Poké on 神奇宝贝百科:离线归档; not a guessed password.
PUBLIC_ARCHIVE_PASSWORD = "52P0KEW1K1"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def select_release(tag: str):
    if tag != "latest":
        if not re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", tag):
            raise ValueError("XML release must be YYYY.MM.DD, not a ZIM release.")
        return read_json(f"{API}/tags/{tag}")
    releases = read_json(f"{API}?per_page=100")
    candidates = [
        item for item in releases
        if not item["draft"] and not item["prerelease"]
        and re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", item["tag_name"])
        and any(a["name"] == f"mwarchiver-{item['tag_name']}.zip" for a in item["assets"])
    ]
    if not candidates:
        raise ValueError("No XML archive in the publisher's release listing.")
    return max(candidates, key=lambda item: item["tag_name"])


def download(asset: dict, destination: Path):
    expected = asset.get("digest", "")
    if not expected.startswith("sha256:"):
        raise ValueError("Publisher SHA-256 digest missing; refusing an unverified archive.")
    if destination.exists():
        if destination.stat().st_size != asset["size"] or "sha256:" + digest(destination) != expected:
            raise ValueError(f"Existing archive does not match the publisher: {destination}")
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > asset["size"]:
        raise ValueError(f"Oversized partial file; inspect it before retrying: {partial}")
    if offset < asset["size"]:
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(asset["browser_download_url"], headers=headers)
        with urllib.request.urlopen(request, timeout=90) as response:
            resumed = offset > 0 and response.status == 206
            if resumed and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                raise ValueError("Invalid Content-Range; refusing to append.")
            if response.status not in (200, 206):
                raise ValueError(f"Unexpected download status {response.status}")
            with partial.open("ab" if resumed else "wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
    if partial.stat().st_size != asset["size"] or "sha256:" + digest(partial) != expected:
        raise ValueError(f"Archive checksum/size mismatch: {partial}")
    partial.replace(destination)


def unpack(archive: Path, tag: str, directory: Path, password: str) -> Path:
    member = f"52poke-{tag}.xml.gz"
    destination = directory / member
    with zipfile.ZipFile(archive) as bundle:
        info = bundle.getinfo(member)
        if info.file_size > 2 * 1024**3:
            raise ValueError("Archive member exceeds the 2 GiB safety limit.")
        if destination.exists():
            if destination.stat().st_size != info.file_size:
                raise ValueError(f"Existing extracted file has an unexpected size: {destination}")
            return destination
        partial = destination.with_suffix(destination.suffix + ".part")
        with partial.open("wb") as output:
            if shutil.which("unzip"):
                subprocess.run(
                    ["unzip", "-p", "-P", password, str(archive), member],
                    stdout=output, check=True,
                )
            else:
                with bundle.open(member, pwd=password.encode()) as stream:
                    shutil.copyfileobj(stream, output, length=1024 * 1024)
        if partial.stat().st_size != info.file_size:
            raise ValueError("Extracted member size mismatch.")
        partial.replace(destination)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default="latest", help="YYYY.MM.DD or latest XML release")
    parser.add_argument("--password", default=PUBLIC_ARCHIVE_PASSWORD, help="Publisher's public archive password")
    args = parser.parse_args()
    release = select_release(args.release)
    tag = release["tag_name"]
    asset = next(a for a in release["assets"] if a["name"] == f"mwarchiver-{tag}.zip")
    directory = ROOT / "downloads"
    sources = ROOT / "sources"
    directory.mkdir(exist_ok=True)
    sources.mkdir(exist_ok=True)
    (sources / f"release-{tag}.json").write_text(
        json.dumps(release, ensure_ascii=False, indent=2) + "\n"
    )
    archive = directory / asset["name"]
    print(f"Downloading/verifying {asset['name']} ({asset['size']:,} bytes)", flush=True)
    download(asset, archive)
    extracted = unpack(archive, tag, directory, args.password)
    manifest = {
        "release": tag, "published_at": release["published_at"],
        "publisher": "52Poké Wiki", "release_url": release["html_url"],
        "archive_url": asset["browser_download_url"], "archive_sha256": digest(archive),
        "xml_gz": str(extracted), "xml_gz_sha256": digest(extracted),
        "license": "CC-BY-NC-SA-3.0",
        "note": "Snapshot, not a live-site mirror. No card images downloaded.",
    }
    (sources / f"manifest-{tag}.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    print(extracted)


if __name__ == "__main__":
    main()
