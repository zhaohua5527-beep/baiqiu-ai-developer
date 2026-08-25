#!/usr/bin/env python3
"""Rotate the online-update verifier and publish 3.0.10 atomically."""

from __future__ import annotations

import hashlib
import json
import os
import pwd
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


ROOT = Path("/opt/baiqiu-update")
INCOMING = ROOT / "incoming"
RELEASES = ROOT / "releases"
BACKUPS = ROOT / "backups"
PUBLISHER = Path("/usr/local/sbin/baiqiu-publish")
UPDATES = ROOT / "updates.json"
ONLINE_MANIFEST = ROOT / "update.json"
DEPLOY_USER = "baiqiu-deploy"
VERSION = "3.0.10"
PUBLISHER_NAME = "baiqiu-publish-3.0.10.py"
ZIP_NAME = "baiqiu-upload-3.0.10.zip"
INSTALLER_NAME = "baiqiu-upload-3.0.10.exe"
MANIFEST_NAME = "baiqiu-upload-3.0.10.json"
NOTES = "Manual trust-root migration online update validation"

EXPECTED_SHA256 = {
    PUBLISHER_NAME: "61062e7d808a4cfd848ada4934f49b6442ad0aebae5fefbe2287bd809612b0ee",
    ZIP_NAME: "7cbb4ca6ba8853c142d0c027a01211b75307f2fcffe79b0e998f724e07d256f8",
    INSTALLER_NAME: "cf0c6f210a86af5c5bfac0c6b20b3e5dcf93bd2a9181b905698519f9abe17485",
    MANIFEST_NAME: "3d5b33d2f201a5d2a1ba7432594ab4815ad8d493f913d067159d9eaaf4c0deb7",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(*args: str) -> None:
    result = subprocess.run(args, check=False, text=True, stdout=sys.stdout, stderr=sys.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(args)}")


def atomic_install(source: Path, target: Path, mode: int) -> None:
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        with source.open("rb") as input_file, open(temporary, "xb") as output_file:
            shutil.copyfileobj(input_file, output_file)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.chown(temporary, 0, 0)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


def restore_file(source: Path, target: Path) -> None:
    if source.exists():
        atomic_install(source, target, source.stat().st_mode & 0o777)
    elif target.exists() or target.is_symlink():
        target.unlink()


def read_live_manifest() -> dict:
    with urllib.request.urlopen("http://127.0.0.1:18790/update.json", timeout=10) as response:
        return json.load(response)


def validate_staged_files() -> dict[str, Path]:
    staged = {name: INCOMING / name for name in EXPECTED_SHA256}
    for name, path in staged.items():
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"missing regular staged file: {path}")
        actual = sha256_file(path)
        if actual != EXPECTED_SHA256[name]:
            raise RuntimeError(f"staged SHA-256 mismatch: {name}")
    return staged


def main() -> None:
    if os.geteuid() != 0:
        raise RuntimeError("must run as root from the cloud maintenance console")

    staged = validate_staged_files()
    run("/usr/bin/python3", "-m", "py_compile", str(staged[PUBLISHER_NAME]))
    deploy_uid = pwd.getpwnam(DEPLOY_USER).pw_uid
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    backup = BACKUPS / f"trust-root-before-{VERSION}-{stamp}"
    backup.mkdir(parents=True, mode=0o700)
    for source in (PUBLISHER, UPDATES, ONLINE_MANIFEST):
        if source.exists():
            shutil.copy2(source, backup / source.name)

    released_zip = RELEASES / f"baiqiu-customer-{VERSION}.zip"
    released_installer = RELEASES / f"BaiqiuAI-Setup-{VERSION}.exe"
    installer_alias = RELEASES / f"baiqiu-{VERSION}-setup.exe"

    try:
        atomic_install(staged[PUBLISHER_NAME], PUBLISHER, 0o750)
        run(
            str(PUBLISHER),
            "--version", VERSION,
            "--zip", ZIP_NAME,
            "--installer", INSTALLER_NAME,
            "--manifest", MANIFEST_NAME,
            "--notes", NOTES,
        )
        live = read_live_manifest()
        if live.get("schemaVersion") != 1 or live.get("manifestType") != "baiqiu-online-update":
            raise RuntimeError("live manifest schema verification failed")
        if live.get("version") != VERSION or live.get("forceUpdate") is not False:
            raise RuntimeError("live manifest release values are incorrect")
        if live.get("sha256") != EXPECTED_SHA256[ZIP_NAME]:
            raise RuntimeError("live package SHA-256 is incorrect")
        if live.get("installerSha256") != EXPECTED_SHA256[INSTALLER_NAME]:
            raise RuntimeError("live installer SHA-256 is incorrect")
        if live.get("signature", {}).get("algorithm") != "ed25519":
            raise RuntimeError("live manifest signature is missing")
    except Exception:
        for released, incoming in (
            (released_zip, staged[ZIP_NAME]),
            (released_installer, staged[INSTALLER_NAME]),
        ):
            if released.exists() and not incoming.exists():
                os.replace(released, incoming)
                os.chown(incoming, deploy_uid, -1)
        if installer_alias.exists() or installer_alias.is_symlink():
            installer_alias.unlink()
        restore_file(backup / PUBLISHER.name, PUBLISHER)
        restore_file(backup / UPDATES.name, UPDATES)
        restore_file(backup / ONLINE_MANIFEST.name, ONLINE_MANIFEST)
        raise

    print(json.dumps({
        "ok": True,
        "version": VERSION,
        "backup": str(backup),
        "publisherSha256": sha256_file(PUBLISHER),
        "packageSha256": EXPECTED_SHA256[ZIP_NAME],
        "installerSha256": EXPECTED_SHA256[INSTALLER_NAME],
    }))


if __name__ == "__main__":
    main()
