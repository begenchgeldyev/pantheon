"""Stage pinned Linux x86-64 upstream packages without touching services or state."""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile


PINS_FILE = Path(__file__).with_name("releases.json")


def verify_artifact(path: Path, digest: str) -> None:
    with path.open("rb") as file:
        actual = hashlib.file_digest(file, "sha256").hexdigest()
    if actual != digest:
        raise ValueError(f"checksum mismatch: {path.name}")


def extract_archive(path: Path, destination: Path) -> None:
    with tarfile.open(path) as archive:
        archive.extractall(destination, filter="data")


def publish(source: Path, destination: Path) -> None:
    # Linux renameat2 with RENAME_NOREPLACE: a concurrent installer cannot overwrite.
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), destination)


def stage(artifacts: Path, destination: Path) -> None:
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("these artifacts require Linux x86-64")
    if not artifacts.is_absolute() or not destination.is_absolute():
        raise ValueError("artifact and destination paths must be absolute")
    if os.path.lexists(destination):
        raise ValueError("destination already exists; use a new bundle path")
    if os.geteuid() == 0:
        raise ValueError("stage as an unprivileged user; npm runs upstream install scripts")

    pins = json.loads(PINS_FILE.read_text())
    with tempfile.TemporaryDirectory(prefix=".pantheon-build-", dir=destination.parent) as temp:
        root = Path(temp)
        for item in pins.values():
            copy = root / item["file"]
            shutil.copyfile(artifacts / item["file"], copy)
            verify_artifact(copy, item["sha256"])

        extract_archive(root / pins["node"]["file"], root)
        extract_archive(root / pins["proxy"]["file"], root / "proxy")
        bundle = root / "bundle"
        bundle.mkdir(mode=0o755)
        node = bundle / "node"
        (root / f"node-v{pins['node']['version']}-linux-x64").rename(node)
        proxy = bundle / "proxy"
        proxy.mkdir()
        shutil.copy2(root / "proxy" / "cli-proxy-api", proxy)
        shutil.copy2(root / "proxy" / "LICENSE", proxy)

        npm_env = {
            "PATH": f"{node / 'bin'}:{os.defpath}",
            "HOME": str(root),
            "npm_config_cache": str(root / "npm-cache"),
            "npm_config_userconfig": str(root / "empty-user.npmrc"),
            "npm_config_globalconfig": str(root / "empty-global.npmrc"),
            "npm_config_registry": "https://registry.npmjs.org/",
        }
        subprocess.run(
            [node / "bin/npm", "install", "--global", "--prefix", node,
             "--no-audit", "--no-fund", root / pins["openclaw"]["file"]],
            cwd=root, env=npm_env, check=True,
        )
        package = node / "lib/node_modules/openclaw/package.json"
        if json.loads(package.read_text())["version"] != pins["openclaw"]["version"]:
            raise ValueError("installed OpenClaw version does not match the pin")
        shutil.copyfile(PINS_FILE, bundle / "releases.json")
        publish(bundle, destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        stage(args.artifacts, args.destination)
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"runtime: {error}\n")


if __name__ == "__main__":
    main()
