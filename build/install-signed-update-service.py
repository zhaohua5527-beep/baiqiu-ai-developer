#!/usr/bin/env python3
"""Install the signed update publisher and switch /update.json atomically."""

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
SERVER = ROOT / "server.py"
PUBLISHER = Path("/usr/local/sbin/baiqiu-publish")
UPDATES = ROOT / "updates.json"
ONLINE_MANIFEST = ROOT / "update.json"
SERVICE = "baiqiu-update.service"
EXPECTED_SERVER_SHA256 = "99c4549ab7c5e4759c715ede7685d2e86bf1083b9bb4843ef997a9d1aa452448"
VERSION = "3.0.8"
ZIP_NAME = "baiqiu-customer-3.0.8.zip"
INSTALLER_NAME = "BaiqiuAI-Setup-3.0.8.exe"
MANIFEST_NAME = "update.json"
PUBLISHER_NAME = "baiqiu-publish-signed.py"
NOTES = "优化首秒运行进度、新会话启动速度、最终回答映射、任务证据与界面展示。"


OLD_ROUTE = '''        if path in ("/update.json", "/manifest.json", "/baiqiu-update.json"):
            return write_json_response(self, latest_payload(self, query.get("channel", ["stable"])[0]))
'''

NEW_ROUTE = '''        if path == "/update.json":
            signed_manifest_path = ROOT / "update.json"
            try:
                signed_manifest = json.loads(signed_manifest_path.read_text("utf-8-sig"))
            except (OSError, json.JSONDecodeError):
                return write_json_response(self, {"error": "Signed update manifest unavailable"}, 503)
            return write_json_response(self, signed_manifest)

        if path in ("/manifest.json", "/baiqiu-update.json"):
            return write_json_response(self, latest_payload(self, query.get("channel", ["stable"])[0]))
'''


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


def restore_file(backup: Path, target: Path) -> None:
    if backup.exists():
        atomic_install(backup, target, backup.stat().st_mode & 0o777)
    elif target.exists() or target.is_symlink():
        target.unlink()


def wait_for_live_manifest(url: str, attempts: int = 20, delay: float = 1.0) -> dict:
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                return json.load(response)
        except (OSError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(delay)
    raise RuntimeError(f"update service did not become ready: {last_error}") from last_error


def main() -> None:
    if os.geteuid() != 0:
        raise RuntimeError("must run as root from the cloud maintenance console")
    if sha256_file(SERVER) != EXPECTED_SERVER_SHA256:
        raise RuntimeError("server.py changed since the maintenance plan was prepared")

    publisher_source = INCOMING / PUBLISHER_NAME
    for required in [publisher_source, INCOMING / ZIP_NAME, INCOMING / INSTALLER_NAME, INCOMING / MANIFEST_NAME]:
        if not required.is_file() or required.is_symlink():
            raise RuntimeError(f"missing staged release file: {required}")

    run("/usr/bin/python3", "-m", "py_compile", str(publisher_source))
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    backup = ROOT / "backups" / f"signed-update-service-{stamp}"
    backup.mkdir(parents=True, mode=0o700)
    for source in [SERVER, PUBLISHER, UPDATES, ONLINE_MANIFEST]:
        if source.exists():
            shutil.copy2(source, backup / source.name)
    (backup / "metadata.json").write_text(json.dumps({
        "serverSha256": sha256_file(SERVER),
        "publisherSha256": sha256_file(PUBLISHER),
        "version": VERSION,
    }, indent=2) + "\n", "utf-8")

    patched_server = backup / "server.py.patched"
    server_text = SERVER.read_text("utf-8")
    if server_text.count(OLD_ROUTE) != 1:
        raise RuntimeError("server.py update route no longer matches the audited source")
    patched_server.write_text(server_text.replace(OLD_ROUTE, NEW_ROUTE), "utf-8")
    run("/usr/bin/python3", "-m", "py_compile", str(patched_server))

    deploy_uid = pwd.getpwnam("baiqiu-deploy").pw_uid
    try:
        atomic_install(publisher_source, PUBLISHER, 0o750)
        run(
            str(PUBLISHER),
            "--version", VERSION,
            "--zip", ZIP_NAME,
            "--installer", INSTALLER_NAME,
            "--manifest", MANIFEST_NAME,
            "--notes", NOTES,
        )
        atomic_install(patched_server, SERVER, 0o644)
        run("/usr/bin/systemctl", "restart", SERVICE)
        live = wait_for_live_manifest("http://127.0.0.1:18790/update.json")
        if live.get("schemaVersion") != 1 or live.get("manifestType") != "baiqiu-online-update":
            raise RuntimeError("live update manifest schema verification failed")
        if live.get("version") != VERSION or live.get("forceUpdate") is not False:
            raise RuntimeError("live update manifest release values are incorrect")
        if live.get("signature", {}).get("algorithm") != "ed25519":
            raise RuntimeError("live update manifest signature is missing")
    except Exception:
        release_zip = RELEASES / f"baiqiu-customer-{VERSION}.zip"
        release_installer = RELEASES / f"BaiqiuAI-Setup-{VERSION}.exe"
        release_alias = RELEASES / f"baiqiu-{VERSION}-setup.exe"
        for released, staged in [
            (release_zip, INCOMING / ZIP_NAME),
            (release_installer, INCOMING / INSTALLER_NAME),
        ]:
            if released.exists() and not staged.exists():
                os.replace(released, staged)
                os.chown(staged, deploy_uid, -1)
        staged_manifest = INCOMING / MANIFEST_NAME
        if ONLINE_MANIFEST.exists() and not staged_manifest.exists():
            shutil.copy2(ONLINE_MANIFEST, staged_manifest)
            os.chown(staged_manifest, deploy_uid, -1)
        if release_alias.exists() or release_alias.is_symlink():
            release_alias.unlink()

        restore_file(backup / SERVER.name, SERVER)
        restore_file(backup / PUBLISHER.name, PUBLISHER)
        restore_file(backup / UPDATES.name, UPDATES)
        restore_file(backup / ONLINE_MANIFEST.name, ONLINE_MANIFEST)
        run("/usr/bin/systemctl", "restart", SERVICE)
        raise

    print(json.dumps({
        "ok": True,
        "version": VERSION,
        "backup": str(backup),
        "serverSha256": sha256_file(SERVER),
        "publisherSha256": sha256_file(PUBLISHER),
    }))


if __name__ == "__main__":
    main()
