from datetime import UTC, datetime, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy"))


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        from runtime import extract_archive, stage, verify_artifact

        self.extract = extract_archive
        self.stage = stage
        self.verify = verify_artifact
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_rejects_checksum_mismatch(self):
        artifact = self.root / "download"
        artifact.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.verify(artifact, "0" * 64)
        self.verify(artifact, hashlib.sha256(b"tampered").hexdigest())

    def test_archive_cannot_escape_through_member_name(self):
        archive = self.root / "bad.tar"
        with tarfile.open(archive, "w") as tar:
            member = tarfile.TarInfo("../escaped")
            member.size = 1
            tar.addfile(member, io.BytesIO(b"x"))
        dest = self.root / "extract"
        dest.mkdir()
        with self.assertRaises(tarfile.TarError):
            self.extract(archive, dest)
        self.assertFalse((self.root / "escaped").exists())

    def test_existing_destination_is_left_untouched(self):
        dest = self.root / "existing"
        dest.mkdir()
        item = dest / "private"
        item.write_text("keep")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.stage(self.root, dest)
        self.assertEqual(item.read_text(), "keep")

    def test_relative_destination_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "must be absolute"):
            self.stage(self.root, Path("relative-bundle"))

    def test_corrupt_bundle_is_not_published(self):
        (self.root / "node-v24.21.0-linux-x64.tar.xz").write_bytes(b"wrong")
        dest = self.root / "bundle"
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.stage(self.root, dest)
        self.assertFalse(dest.exists())


class RecoveryFixture(unittest.TestCase):
    def setUp(self):
        from recovery import inventory, verify

        self.inventory = inventory
        self.verify = verify
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.scheduler = self.make_db("state/openclaw.sqlite", "cron_jobs")
        self.make_db("agents/example/agent/openclaw-agent.sqlite", "sessions")
        (self.root / "workspace").mkdir()
        (self.root / "workspace/MEMORY.md").write_text("synthetic")

    def make_db(self, name, table):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path)
        self.addCleanup(db.close)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute(f"CREATE TABLE {table} (id INTEGER)")
        db.execute(f"INSERT INTO {table} VALUES (1)")
        db.commit()
        return db


class RecoveryTest(RecoveryFixture):
    def test_inventory_reads_commits_in_wal(self):
        self.assertTrue((self.root / "state/openclaw.sqlite-wal").is_file())
        manifest = self.inventory(self.root)
        self.assertEqual(manifest["tables"]["state/openclaw.sqlite"]["cron_jobs"], 1)
        self.assertEqual(manifest["tables"]["agents/example/agent/openclaw-agent.sqlite"]["sessions"], 1)
        self.verify(self.root, manifest)

    def test_missing_agent_database_is_not_a_valid_snapshot(self):
        (self.root / "agents/example/agent/openclaw-agent.sqlite").unlink()
        with self.assertRaisesRegex(ValueError, "agent database"):
            self.inventory(self.root)

    def test_workspace_drift_is_detected(self):
        manifest = self.inventory(self.root)
        (self.root / "workspace/MEMORY.md").write_text("changed")
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.verify(self.root, manifest)

    def test_corrupt_database_is_rejected(self):
        self.scheduler.close()  # Checkpoint first; a valid WAL can repair a bad base page.
        (self.root / "state/openclaw.sqlite").write_bytes(b"bad" * 4096)
        with self.assertRaisesRegex(ValueError, "SQLite"):
            self.inventory(self.root)

    def test_symlink_is_not_followed(self):
        (self.root / "workspace/link").symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.inventory(self.root)


@unittest.skipUnless(shutil.which("restic"), "restic is required for the encrypted fixture")
class BackupTest(RecoveryFixture):
    def test_encrypted_round_trip_and_drift_rejection(self):
        from backup import backup, check_freshness, retain, snapshots, restore

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        source = root / "capture"
        source.mkdir()
        snapshot = source / "state"
        shutil.copytree(self.root, snapshot)
        manifest = source / "manifest.json"
        manifest.write_text(json.dumps(self.inventory(snapshot)))
        password = root / "password"
        password.write_text("synthetic recovery test only")
        password.chmod(0o600)
        env = {"PATH": os.environ["PATH"], "HOME": str(root),
               "RESTIC_REPOSITORY": str(root / "vault"), "RESTIC_PASSWORD_FILE": str(password)}
        self.enterContext(patch.dict(os.environ, env, clear=True))
        subprocess.run(["restic", "init", "--quiet"], check=True)
        old_capture = datetime.now(UTC) - timedelta(days=2)
        backup(source, "unit-test", old_capture)
        with self.assertRaisesRegex(ValueError, "last 24 hours"):
            check_freshness("unit-test")
        real_run = subprocess.run

        def saved_incomplete_snapshot(argv, **kwargs):
            result = real_run(argv, **kwargs)
            if argv[:2] == ["restic", "backup"] and result.returncode == 0:
                result.returncode = 3  # Restic can save a snapshot even when reading a source fails.
            return result

        with patch("backup.subprocess.run", side_effect=saved_incomplete_snapshot):
            with self.assertRaisesRegex(ValueError, "exit 3"):
                backup(source, "unit-test", datetime.now(UTC))
        with self.assertRaisesRegex(ValueError, "last 24 hours"):
            check_freshness("unit-test")
        backup(source, "fresh-test", datetime.now(UTC))
        check_freshness("fresh-test")
        self.assertEqual(retain("unit-test", dry_run=True), 0)
        received, = snapshots("unit-test")
        restore(received["id"], root / "recovered")
        self.verify(root / "recovered/state", json.loads(manifest.read_text()))
        with self.assertRaisesRegex(ValueError, "already exists"):
            restore(received["id"], root / "recovered")
        (snapshot / "workspace/MEMORY.md").write_text("changed")
        with self.assertRaisesRegex(ValueError, "does not match"):
            backup(source, "unit-test", old_capture)
        self.assertEqual(len(snapshots("unit-test")), 1)
