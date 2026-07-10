import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.config import settings
from app.main import api_delete, app, init_upload
from app.uploader import (
    release_reserved_path,
    reserve_unique_path_nested,
    sanitize_rel_path,
)
from app.utils import file_fingerprint, safe_join


class AccessControlTests(unittest.TestCase):
    def test_lan_api_requires_token(self):
        with patch.object(settings, "access_token", "123456789012"):
            with TestClient(app) as client:
                response = client.get("/api/config")
                self.assertEqual(response.status_code, 401)

                response = client.get(
                    "/api/config",
                    headers={"Authorization": "Bearer 123456789012"},
                )
                self.assertEqual(response.status_code, 200)

    def test_health_check_stays_public(self):
        with TestClient(app) as client:
            self.assertEqual(client.get("/healthz").status_code, 200)


class UploadBoundaryTests(unittest.TestCase):
    def test_rejects_unsafe_windows_and_parent_paths(self):
        for value in (".", "..", "../photo.jpg", "CON", "photo.jpg:secret", ".crosssync/token"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    sanitize_rel_path(value)

    def test_reservations_make_concurrent_names_unique(self):
        with tempfile.TemporaryDirectory() as directory:
            first = reserve_unique_path_nested(directory, "photo.heic")
            second = reserve_unique_path_nested(directory, "photo.heic")
            try:
                self.assertNotEqual(first, second)
                self.assertTrue(second.endswith("photo (1).heic"))
            finally:
                release_reserved_path(first)
                release_reserved_path(second)

    def test_fingerprint_is_scoped_to_client_and_asset(self):
        first = file_fingerprint("IMG.heic", 100, 0, "phone-a", "asset-1")
        second = file_fingerprint("IMG.heic", 100, 0, "phone-b", "asset-1")
        third = file_fingerprint("IMG.heic", 100, 0, "phone-a", "asset-2")
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, third)

    def test_init_rejects_invalid_chunk_size(self):
        with self.assertRaises(HTTPException) as context:
            asyncio.run(init_upload({"name": "photo.jpg", "size": 10, "chunk_size": 0}))
        self.assertEqual(context.exception.status_code, 400)

    def test_delete_requires_explicit_clear_flag(self):
        with self.assertRaises(HTTPException) as context:
            asyncio.run(api_delete({"area": "downloads"}))
        self.assertEqual(context.exception.status_code, 400)

    def test_safe_join_does_not_follow_symlink_outside_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            link = os.path.join(root, "outside")
            try:
                os.symlink(outside, link)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks are unavailable")
            with self.assertRaises(ValueError):
                safe_join(root, "outside", "secret.txt")


if __name__ == "__main__":
    unittest.main()
