import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from app import checksums, library, metadb, transfer_log
from app.config import load_env_overrides, settings


class TempMetadataTestCase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.addCleanup(metadb.close_all)  # Release the database before the folder is removed.
        self.root = folder.name
        self.metadata = os.path.join(self.root, "meta")
        self.files = os.path.join(self.root, "files")
        os.makedirs(self.metadata)
        os.makedirs(self.files)
        for key, value in {"metadata_dir": self.metadata, "downloads_dir": self.files}.items():
            patcher = patch.object(settings, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def make(self, name, mtime):
        path = os.path.join(self.files, name)
        with open(path, "wb") as f:
            f.write(name.encode())
        os.utime(path, (mtime, mtime))
        return path


class LegacyMetadataMigrationTests(TempMetadataTestCase):
    def test_json_stores_are_imported_once_and_retired(self):
        photo = self.make("a.jpg", 1_700_000_000)
        stat = os.stat(photo)
        with open(os.path.join(self.metadata, "checksums.json"), "w", encoding="utf-8") as f:
            json.dump({"downloads:a.jpg": {"sha256": "ab" * 32, "size": stat.st_size, "mtime": int(stat.st_mtime)}}, f)
        with open(os.path.join(self.metadata, "transfers.json"), "w", encoding="utf-8") as f:
            json.dump({os.path.normcase(os.path.realpath(photo)): {
                "area": "downloads", "path": os.path.realpath(photo), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
            }}, f)

        self.assertEqual(checksums.checksum_snapshot("downloads")["downloads:a.jpg"]["sha256"], "ab" * 32)
        self.assertEqual(transfer_log.owned_files("downloads", self.files), [os.path.realpath(photo)])
        names = sorted(os.listdir(self.metadata))
        self.assertIn(metadb.DB_FILE, names)
        self.assertIn("checksums.json.migrated", names)
        self.assertIn("transfers.json.migrated", names)
        self.assertNotIn("checksums.json", names)

    def test_area_snapshot_and_deletes_are_scoped(self):
        for area in ("downloads", "outbox"):
            path = self.make(f"{area}.bin", 1_700_000_000)
            checksums.record_checksum(area, f"{area}.bin", path, "cd" * 32)
        self.assertEqual(list(checksums.checksum_snapshot("downloads")), ["downloads:downloads.bin"])
        checksums.delete_checksums("downloads")
        self.assertEqual(list(checksums.checksum_snapshot()), ["outbox:outbox.bin"])


class RecentListTests(TempMetadataTestCase):
    def test_limit_returns_newest_files_and_total(self):
        for i in range(30):
            self.make(f"IMG_{i:03d}.jpg", 1_700_000_000 + i)
        payload = json.loads(asyncio.run(library.list_area("downloads", limit=5)).body)
        self.assertEqual([f["path"] for f in payload["files"]], [f"IMG_{i:03d}.jpg" for i in range(29, 24, -1)])
        self.assertEqual(payload["total"], 30)
        self.assertTrue(payload["truncated"])

    def test_no_limit_lists_everything(self):
        for i in range(3):
            self.make(f"f{i}.txt", 1_700_000_000 + i)
        payload = json.loads(asyncio.run(library.list_area("downloads")).body)
        self.assertEqual((len(payload["files"]), payload["total"], payload["truncated"]), (3, 3, False))


class TempDirOverrideTests(unittest.TestCase):
    def test_env_var_moves_upload_sessions(self):
        # load_env_overrides touches several global settings; restore them all afterwards.
        saved = {key: getattr(settings, key) for key in (
            "temp_dir", "metadata_dir", "access_token", "downloads_dir", "outbox_dir", "display_name",
        )}
        self.addCleanup(lambda: [setattr(settings, key, value) for key, value in saved.items()])
        with tempfile.TemporaryDirectory() as folder, \
                patch.dict(os.environ, {"CROSSSYNC_TEMP_DIR": os.path.join(folder, "fast-temp")}):
            settings.metadata_dir = folder
            load_env_overrides()
            self.assertEqual(settings.temp_dir, os.path.join(folder, "fast-temp"))


if __name__ == "__main__":
    unittest.main()
