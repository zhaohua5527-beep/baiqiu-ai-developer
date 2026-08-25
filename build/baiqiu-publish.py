#!/usr/bin/env python3
"""Publish a Baiqiu client release from the restricted incoming directory.

This program is intentionally designed to run only through the narrowly scoped
sudo rule for the baiqiu-deploy account. It promotes uploaded artifacts into
the public release directory and atomically updates the update manifest.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path


ROOT = Path("/opt/baiqiu-update")
INCOMING = ROOT / "incoming"
RELEASES = ROOT / "releases"
MANIFEST = ROOT / "updates.json"
ONLINE_MANIFEST = ROOT / "update.json"
BACKUPS = ROOT / "backups"
DEPLOY_USER = "baiqiu-deploy"
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$")
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MAX_ONLINE_MANIFEST_BYTES = 64 * 1024
ONLINE_MANIFEST_PUBLIC_KEY = b"""-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvgwkCd/0+G/cd8K3eSxfSHtPHY4lR1jA2TP1zhn6NZM=
-----END PUBLIC KEY-----
"""


def fail(message: str) -> None:
    print(f"Publish failed: {message}", file=sys.stderr)
    raise SystemExit(2)


def version_key(value: str) -> tuple[int, int, int]:
    numeric = str(value).lstrip("vV").split("+", 1)[0].split("-", 1)[0]
    parts = numeric.split(".")
    return tuple(int(parts[index]) if index < len(parts) else 0 for index in range(3))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def incoming_file(name: str, suffix: str, deploy_uid: int) -> Path:
    if not FILE_RE.fullmatch(name) or Path(name).name != name:
        fail("uploaded file name is invalid")
    if not name.lower().endswith(suffix):
        fail(f"{name} must end with {suffix}")

    path = INCOMING / name
    try:
        details = path.lstat()
    except FileNotFoundError:
        fail(f"uploaded file does not exist: {name}")
    if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode):
        fail(f"uploaded file is not a regular file: {name}")
    if details.st_uid != deploy_uid:
        fail(f"uploaded file owner is invalid: {name}")
    if details.st_size <= 0:
        fail(f"uploaded file is empty: {name}")
    return path


def read_manifest() -> dict:
    if not MANIFEST.exists():
        return {"channels": {"stable": []}}
    try:
        data = json.loads(MANIFEST.read_text("utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read existing manifest: {error}")
    if not isinstance(data, dict):
        fail("existing manifest is not a JSON object")
    return data


def write_manifest(data: dict) -> None:
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    if MANIFEST.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        backup = BACKUPS / f"updates.json.before-{stamp}.bak"
        shutil.copy2(MANIFEST, backup)
        os.chown(backup, 0, 0)
        os.chmod(backup, 0o600)

    tmp = MANIFEST.with_name(f".{MANIFEST.name}.{os.getpid()}.tmp")
    encoded = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    try:
        with open(tmp, "xb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.chown(tmp, 0, 0)
        os.chmod(tmp, 0o644)
        os.replace(tmp, MANIFEST)
    finally:
        if tmp.exists():
            tmp.unlink()


def promote(source: Path, target: Path) -> Path:
    if target.exists() or target.is_symlink():
        backup = target.with_name(f"{target.name}.replaced-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}")
        os.replace(target, backup)
        os.chown(backup, 0, 0)
        os.chmod(backup, 0o600)
    os.replace(source, target)
    os.chown(target, 0, 0)
    os.chmod(target, 0o644)
    return target


def safe_release_path(value: object) -> str:
    text = str(value or "").replace("\\", "/")
    if not text or text.startswith("/") or ":" in text or ".." in text.split("/"):
        fail("full-client release manifest contains an unsafe file path")
    return text


def validate_full_client_zip(package: Path, version: str) -> None:
    try:
        with zipfile.ZipFile(package) as archive:
            names = {name.replace("\\", "/"): name for name in archive.namelist()}
            manifest_name = "client/release-manifest.json" if "client/release-manifest.json" in names else "release-manifest.json"
            if manifest_name not in names:
                fail("ZIP is not a full-client update package: release-manifest.json is missing")
            manifest = json.loads(archive.read(names[manifest_name]).decode("utf-8-sig"))
    except zipfile.BadZipFile:
        fail("ZIP is not a valid archive")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"full-client release manifest is invalid: {error}")
    if not isinstance(manifest, dict) or manifest.get("packageType") != "full-client":
        fail("ZIP is not a full-client update package")
    if str(manifest.get("version") or "") != version:
        fail(f"full-client package version does not match --version: {manifest.get('version') or 'missing'}")
    executable = manifest.get("executable") if isinstance(manifest.get("executable"), dict) else {}
    if not executable.get("path") or not re.fullmatch(r"[a-f0-9]{64}", str(executable.get("sha256") or ""), re.I):
        fail("full-client release manifest has invalid executable integrity data")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) < 10:
        fail("full-client release manifest has too few files")
    for item in files:
        if not isinstance(item, dict):
            fail("full-client release manifest has an invalid file entry")
        safe_release_path(item.get("path"))
        if not isinstance(item.get("size"), int) or item["size"] < 0:
            fail("full-client release manifest has an invalid file size")
        if not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256") or ""), re.I):
            fail("full-client release manifest has an invalid file hash")


def validate_windows_installer(installer: Path) -> None:
    with installer.open("rb") as source:
        if source.read(2) != b"MZ":
            fail("installer is not a Windows executable")


def canonical_online_payload(manifest: dict) -> bytes:
    payload = dict(manifest)
    payload.pop("signature", None)
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def verify_online_manifest(manifest_file: Path, version: str, package: Path, installer: Path, force_update: bool) -> dict:
    if manifest_file.stat().st_size > MAX_ONLINE_MANIFEST_BYTES:
        fail("online update manifest is too large")
    try:
        manifest = json.loads(manifest_file.read_text("utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"online update manifest is invalid: {error}")
    if not isinstance(manifest, dict):
        fail("online update manifest is not a JSON object")
    if manifest.get("schemaVersion") != 1 or manifest.get("manifestType") != "baiqiu-online-update":
        fail("online update manifest schema is unsupported")
    if str(manifest.get("version") or manifest.get("latestVersion") or "") != version:
        fail("online update manifest version does not match --version")
    if manifest.get("packageType") != "full-client":
        fail("online update manifest package type is invalid")
    if bool(manifest.get("forceUpdate")) != bool(force_update):
        fail("online update manifest forceUpdate does not match the publish command")

    package_hash = sha256_file(package)
    installer_hash = sha256_file(installer)
    if str(manifest.get("sha256") or "").lower() != package_hash:
        fail("online update manifest ZIP hash does not match the uploaded package")
    if int(manifest.get("size") or 0) != package.stat().st_size:
        fail("online update manifest ZIP size does not match the uploaded package")
    if str(manifest.get("installerSha256") or "").lower() != installer_hash:
        fail("online update manifest installer hash does not match the uploaded installer")
    if int(manifest.get("installerSize") or 0) != installer.stat().st_size:
        fail("online update manifest installer size does not match the uploaded installer")

    expected_zip_url = f"http://47.108.191.67/baiqiu-{version}.zip"
    expected_installer_url = f"http://47.108.191.67/download/baiqiu-{version}-setup.exe"
    if str(manifest.get("downloadUrl") or "") != expected_zip_url:
        fail("online update manifest ZIP URL is not the official release URL")
    if str(manifest.get("installerUrl") or "") != expected_installer_url:
        fail("online update manifest installer URL is not the official release URL")

    signature = manifest.get("signature") if isinstance(manifest.get("signature"), dict) else {}
    if signature.get("algorithm") != "ed25519" or not signature.get("value"):
        fail("online update manifest is unsigned")
    try:
        signature_bytes = base64.b64decode(str(signature["value"]), validate=True)
    except (ValueError, TypeError) as error:
        fail(f"online update manifest signature is invalid: {error}")
    if len(signature_bytes) != 64:
        fail("online update manifest signature has an invalid length")

    with tempfile.TemporaryDirectory(prefix="baiqiu-manifest-") as temporary:
        temporary_root = Path(temporary)
        public_key = temporary_root / "public.pem"
        payload = temporary_root / "payload.json"
        signature_file = temporary_root / "signature.bin"
        public_key.write_bytes(ONLINE_MANIFEST_PUBLIC_KEY)
        payload.write_bytes(canonical_online_payload(manifest))
        signature_file.write_bytes(signature_bytes)
        result = subprocess.run([
            "/usr/bin/openssl", "pkeyutl", "-verify", "-pubin",
            "-inkey", str(public_key), "-rawin", "-in", str(payload),
            "-sigfile", str(signature_file),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=False)
        if result.returncode != 0:
            fail("online update manifest signature verification failed")
    return manifest


def write_online_manifest(source: Path) -> None:
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    if ONLINE_MANIFEST.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        backup = BACKUPS / f"update.json.before-{stamp}.bak"
        shutil.copy2(ONLINE_MANIFEST, backup)
        os.chown(backup, 0, 0)
        os.chmod(backup, 0o600)

    tmp = ONLINE_MANIFEST.with_name(f".{ONLINE_MANIFEST.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "xb") as output:
            with source.open("rb") as manifest_input:
                shutil.copyfileobj(manifest_input, output)
            output.flush()
            os.fsync(output.fileno())
        os.chown(tmp, 0, 0)
        os.chmod(tmp, 0o644)
        os.replace(tmp, ONLINE_MANIFEST)
        source.unlink()
    finally:
        if tmp.exists():
            tmp.unlink()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish a Baiqiu client release")
    parser.add_argument("--version", required=True)
    parser.add_argument("--zip", dest="zip_name", required=True)
    parser.add_argument("--installer", dest="installer_name", required=True)
    parser.add_argument("--manifest", dest="manifest_name", required=True)
    parser.add_argument("--notes", required=True)
    parser.add_argument("--force-update", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    version = str(args.version).strip()
    notes = str(args.notes).strip()
    if not VERSION_RE.fullmatch(version):
        fail("version must look like 3.0.7")
    if not notes or len(notes) > 4000 or "\x00" in notes:
        fail("release notes are invalid")
    if os.geteuid() != 0:
        fail("must run through sudo")

    try:
        deploy_uid = pwd.getpwnam(DEPLOY_USER).pw_uid
    except KeyError:
        fail(f"deployment user does not exist: {DEPLOY_USER}")

    zip_source = incoming_file(args.zip_name, ".zip", deploy_uid)
    installer_source = incoming_file(args.installer_name, ".exe", deploy_uid)
    online_manifest_source = incoming_file(args.manifest_name, ".json", deploy_uid)
    validate_full_client_zip(zip_source, version)
    validate_windows_installer(installer_source)
    signed_manifest = verify_online_manifest(
        online_manifest_source,
        version,
        zip_source,
        installer_source,
        bool(args.force_update),
    )
    existing_manifest = read_manifest()
    existing_stable = existing_manifest.get("channels", {}).get("stable", [])
    latest_existing = next((entry for entry in existing_stable if isinstance(entry, dict)), None)
    if latest_existing and version_key(version) < version_key(str(latest_existing.get("version") or "0.0.0")):
        fail("release downgrade is blocked")
    RELEASES.mkdir(mode=0o755, exist_ok=True)

    zip_target = promote(zip_source, RELEASES / f"baiqiu-customer-{version}.zip")
    installer_target = promote(installer_source, RELEASES / f"BaiqiuAI-Setup-{version}.exe")
    installer_alias = RELEASES / f"baiqiu-{version}-setup.exe"
    if installer_alias.exists() or installer_alias.is_symlink():
        installer_alias.unlink()
    installer_alias.symlink_to(installer_target.name)
    os.lchown(installer_alias, 0, 0)

    item = {
        "version": version,
        "file": zip_target.name,
        "sha256": sha256_file(zip_target),
        "notes": notes,
        "updateLog": notes,
        "publisher": DEPLOY_USER,
        "forceUpdate": bool(args.force_update),
        "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "installerFile": installer_target.name,
        "installerSha256": sha256_file(installer_target),
    }

    manifest = existing_manifest
    channels = manifest.setdefault("channels", {})
    stable = channels.setdefault("stable", [])
    if not isinstance(stable, list):
        fail("stable channel is not a list")
    stable = [entry for entry in stable if isinstance(entry, dict) and str(entry.get("version")) != version]
    stable.append(item)
    stable.sort(key=lambda entry: version_key(str(entry.get("version", "0.0.0"))), reverse=True)
    channels["stable"] = stable
    write_manifest(manifest)
    write_online_manifest(online_manifest_source)

    print(json.dumps({
        "ok": True,
        "version": version,
        "zip": zip_target.name,
        "zipSha256": item["sha256"],
        "installer": installer_target.name,
        "installerSha256": item["installerSha256"],
        "manifest": ONLINE_MANIFEST.name,
        "manifestVersion": signed_manifest.get("version"),
        "signatureAlgorithm": signed_manifest.get("signature", {}).get("algorithm"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
