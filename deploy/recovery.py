"""Create or check a private manifest of an offline, consistent recovery snapshot."""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import tempfile


SCHEDULER = "state/openclaw.sqlite"
AGENT_DB = re.compile(r"agents/[^/]+/agent/openclaw-agent\.sqlite\Z")


def database_tables(path: Path, *, scheduler: bool) -> dict[str, int]:
    # Read a disposable copy. SQLite can create a shared-memory index to read WAL,
    # but must never generate sidecars in the snapshot being verified.
    with tempfile.TemporaryDirectory(prefix="pantheon-sqlite-") as tmp:
        local = Path(tmp) / "state.sqlite"
        shutil.copyfile(path, local)
        for suffix in ("-wal", "-journal"):
            sidecar = path.with_name(path.name + suffix)
            if sidecar.is_file():
                shutil.copyfile(sidecar, local.with_name(local.name + suffix))
        try:
            with closing(sqlite3.connect(local.as_uri() + "?mode=ro", uri=True)) as connection:
                if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError("SQLite integrity check failed")
                tables = [row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
                )]
                wanted = [name for name in tables if name == "cron_jobs"] if scheduler else [
                    name for name in tables if "session" in name.lower()
                ]
                if not wanted:
                    raise ValueError("SQLite required scheduler or session tables are missing")
                return {name: connection.execute(
                    'SELECT count(*) FROM "' + name.replace('"', '""') + '"'
                ).fetchone()[0] for name in wanted}
        except sqlite3.Error as error:
            raise ValueError("SQLite could not read the snapshot") from error


def inventory(root: Path) -> dict:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("snapshot must be an absolute path to a real directory")

    def fail_walk(error):
        raise error

    files = {}
    directories = []
    for current, dirs, names in os.walk(root, onerror=fail_walk):
        folder = Path(current)
        for name in dirs:
            path = folder / name
            if not stat.S_ISDIR(path.lstat().st_mode):
                raise ValueError("snapshot entries must be a directory or regular file")
            directories.append(path.relative_to(root).as_posix())
        for name in names:
            path = folder / name
            mode = path.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise ValueError("snapshot entries must be a directory or regular file")
            if name.endswith((".sqlite-shm", ".sqlite3-shm", ".db-shm")):
                continue  # Transient SQLite index, rebuilt from the DB and WAL.
            with path.open("rb") as file:
                files[path.relative_to(root).as_posix()] = {
                    "sha256": hashlib.file_digest(file, "sha256").hexdigest(),
                    "mode": stat.S_IMODE(mode),
                }
    if SCHEDULER not in files:
        raise ValueError("snapshot is missing the scheduler database")
    agents = sorted(name for name in files if AGENT_DB.fullmatch(name))
    if not agents:
        raise ValueError("snapshot is missing an agent database")
    if not any("/" not in name and (name == "workspace" or name.startswith("workspace-"))
               for name in directories):
        raise ValueError("snapshot is missing workspace directories")
    tables = {name: database_tables(root / name, scheduler=name == SCHEDULER)
              for name in [SCHEDULER, *agents]}
    return {"format": 1, "directories": sorted(directories), "files": files, "tables": tables}


def verify(root: Path, expected: dict) -> None:
    if inventory(root) != expected:
        raise ValueError("snapshot does not match the private manifest")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("manifest", "verify"))
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        if args.manifest.resolve().is_relative_to(args.snapshot.resolve()):
            raise ValueError("keep the manifest outside the snapshot directory")
        if args.command == "manifest":
            contents = json.dumps(inventory(args.snapshot), indent=2, sort_keys=True) + "\n"
            fd = os.open(args.manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as file:
                file.write(contents)
            print("Private recovery manifest created.")
        else:
            verify(args.snapshot, json.loads(args.manifest.read_text()))
            print("Recovery snapshot matches the private manifest; required databases passed integrity checks.")
    except (OSError, ValueError) as error:
        # OS errors can embed paths containing private agent names or other data.
        detail = error.strerror if isinstance(error, OSError) else str(error)
        parser.exit(1, f"recovery: {detail}\n")


if __name__ == "__main__":
    main()
