#!/usr/bin/env python3
"""Build a Homebrew-installable LG Hue Sync IPK with the official webOS CLI."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
APP_DIR = ROOT_DIR / "webos-app"
APP_INFO = json.loads((APP_DIR / "appinfo.json").read_text(encoding="utf-8"))
VERSION = APP_INFO["version"]
OUTPUT_DIR = Path(os.environ.get("LG_HUE_SYNC_OUTPUT_DIR", ROOT_DIR / "target")).resolve()
BINARY_PATH = os.environ.get("LG_HUE_SYNC_BINARY")


def build_ipk() -> None:
    if not BINARY_PATH:
        raise SystemExit("LG_HUE_SYNC_BINARY is required")

    binary = Path(BINARY_PATH).resolve()
    if not binary.is_file():
        raise FileNotFoundError(f"LG_HUE_SYNC_BINARY not found: {binary}")
    if shutil.which("ares-package") is None:
        raise SystemExit("ares-package not found; install @webos-tools/cli")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="lg-hue-sync-package-") as tmp:
        stage = Path(tmp) / "org.webosbrew.lg-hue-sync"
        shutil.copytree(APP_DIR, stage)

        bin_dir = stage / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        staged_binary = bin_dir / "lg-hue-sync"
        shutil.copy2(binary, staged_binary)
        staged_binary.chmod(0o755)

        startup = stage / "startup.sh"
        startup.chmod(0o755)

        config_example = ROOT_DIR / "config.example.json"
        if config_example.is_file():
            shutil.copy2(config_example, stage / "config.example.json")

        subprocess.run(
            ["ares-package", "--no-minify", "--outdir", str(OUTPUT_DIR), str(stage)],
            check=True,
        )

    expected = OUTPUT_DIR / f"org.webosbrew.lg-hue-sync_{VERSION}_all.ipk"
    if not expected.is_file():
        candidates = list(OUTPUT_DIR.glob("org.webosbrew.lg-hue-sync_*_all.ipk"))
        if len(candidates) != 1:
            raise SystemExit(f"expected one LG Hue Sync IPK, found {len(candidates)}")
        candidates[0].replace(expected)

    manifest = {
        "id": APP_INFO["id"],
        "version": VERSION,
        "type": APP_INFO.get("type", "web"),
        "title": APP_INFO["title"],
        "appDescription": APP_INFO["appDescription"],
        "iconUri": "https://raw.githubusercontent.com/poiedk/webos-apps-repo/main/apps/lg-hue-sync/webos-app/bold-icon.svg",
        "sourceUrl": "https://github.com/poiedk/webos-apps-repo/tree/main/apps/lg-hue-sync",
        "rootRequired": True,
        "ipkUrl": f"https://raw.githubusercontent.com/poiedk/webos-apps-repo/main/packages/{expected.name}",
        "ipkHash": {"sha256": hashlib.sha256(expected.read_bytes()).hexdigest()},
        "ipkSize": expected.stat().st_size,
    }
    manifest_path = OUTPUT_DIR / "org.webosbrew.lg-hue-sync.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Successfully created {expected} ({expected.stat().st_size} bytes)")
    print(f"Successfully created {manifest_path}")


if __name__ == "__main__":
    build_ipk()
