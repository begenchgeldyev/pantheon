"""Encrypt, restore, and monitor a sealed offline OpenClaw capture with restic."""

import argparse
from datetime import UTC, datetime, timedelta
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

from recovery import verify
from runtime import publish


def restic(*args: str, cwd: Path | None = None) -> str:
    # Snapshot paths and backend diagnostics can expose private deployment details.
    completed = subprocess.run(["restic", *args], cwd=cwd, env={**os.environ, "TZ": "UTC"}, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    if completed.returncode:
        raise ValueError(f"restic {args[0]} failed (exit {completed.returncode})")
    return completed.stdout


def check_capture(capture: Path) -> None:
    if not capture.is_absolute() or capture.is_symlink() or not capture.is_dir():
        raise ValueError("capture must be an absolute path to a real directory")
    if {p.name for p in capture.iterdir()} != {"state", "manifest.json"}:
        raise ValueError("capture must contain exactly state/ and manifest.json")
    manifest = capture / "manifest.json"
    if not stat.S_ISREG(manifest.lstat().st_mode):
        raise ValueError("manifest must be a regular file")
    verify(capture / "state", json.loads(manifest.read_text()))


def stream_tag(stream: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", stream):
        raise ValueError("invalid backup stream name")
    return "pantheon-openclaw-" + stream


def backup(capture: Path, stream: str, captured_at: datetime) -> None:
    if captured_at.utcoffset() is None or captured_at > datetime.now(UTC):
        raise ValueError("capture time must have a timezone and must not be in the future")
    check_capture(capture)
    restic("backup", "--quiet", "--tag", stream_tag(stream),
           "--time", captured_at.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S"), "--exclude", "*.sqlite-shm",
           "--exclude", "*.sqlite3-shm", "--exclude", "*.db-shm", "state", "manifest.json",
           cwd=capture)


def snapshots(stream: str) -> list[dict]:
    return json.loads(restic("snapshots", "--json", "--tag", stream_tag(stream))) or []


def restore(snapshot_id: str, destination: Path) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", snapshot_id):
        raise ValueError("restore requires a full restic snapshot ID")
    if not destination.is_absolute():
        raise ValueError("restore destination must be absolute")
    if os.path.lexists(destination):
        raise ValueError("restore destination already exists")
    with tempfile.TemporaryDirectory(prefix=".pantheon-restore-", dir=destination.parent) as tmp:
        capture = Path(tmp) / "capture"
        capture.mkdir(mode=0o700)
        restic("restore", snapshot_id, "--target", str(capture), "--verify")
        check_capture(capture)
        capture.chmod(0o700)
        publish(capture, destination)


def check_freshness(stream: str) -> None:
    now = datetime.now(UTC)
    # Don't let a future-dated snapshot suppress a missed-backup alert.
    times = (datetime.fromisoformat(s["time"]) for s in snapshots(stream))
    if not any(now - timedelta(hours=24) <= time <= now for time in times):
        raise ValueError("no backup in the last 24 hours")


def retain(stream: str, *, dry_run: bool) -> int:
    # Group within this tag only, even when the capture path or source hostname changes.
    flags = ["--dry-run"] if dry_run else []
    result = json.loads(restic("forget", "--json", "--tag", stream_tag(stream),
                               "--group-by", "tags", "--keep-daily", "7",
                               "--keep-weekly", "4", *flags)) or []
    return sum(len(group["remove"] or []) for group in result)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("backup", "snapshots", "check", "retention-preview", "retain"):
        sub = commands.add_parser(name)
        sub.add_argument("stream")
        if name == "backup":
            sub.add_argument("capture", type=Path)
            sub.add_argument("--captured-at", type=datetime.fromisoformat, required=True,
                             help="actual capture time in ISO 8601 with an explicit timezone")
    sub = commands.add_parser("restore")
    sub.add_argument("id")
    sub.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "backup":
            backup(args.capture, args.stream, args.captured_at)
        elif args.command == "restore":
            restore(args.id, args.destination)
        elif args.command == "check":
            check_freshness(args.stream)
        elif args.command == "snapshots":
            for snapshot in snapshots(args.stream):
                print(snapshot["time"], snapshot["id"])
        else:
            print("Snapshots selected for removal:", retain(args.stream, dry_run=args.command == "retention-preview"))
    except (OSError, ValueError) as error:
        detail = error.strerror if isinstance(error, OSError) else str(error)
        parser.exit(1, f"backup: {detail}\n")


if __name__ == "__main__":
    main()
