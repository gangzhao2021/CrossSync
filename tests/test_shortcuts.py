import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import app.main as main
from app import metadb, transfers
from app.config import settings

SHORTCUT = {"Authorization": "Bearer 123456789012", "User-Agent": "Shortcuts/3200 CFNetwork/1568 Darwin/24.0.0"}


class ShortcutUploadTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="crosssync-shortcuts-")
        self.addCleanup(folder.cleanup)
        self.addCleanup(metadb.close_all)
        self.downloads = os.path.join(folder.name, "downloads")
        temp = os.path.join(folder.name, "temp")
        for path in (self.downloads, temp):
            os.makedirs(path)
        for key, value in {"mdns_enabled": False, "access_token": "123456789012", "require_device_approval": False,
                           "metadata_dir": os.path.join(folder.name, "meta"), "downloads_dir": self.downloads,
                           "temp_dir": temp, "min_free_space_reserve": 0}.items():
            patcher = patch.object(settings, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(transfers, "stream_reservations", {})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(main.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_raw_body_without_size_or_name_is_saved_with_an_extension(self):
        response = self.client.post("/api/upload-stream?target=downloads", content=b"jpeg bytes",
                                    headers={**SHORTCUT, "Content-Type": "image/jpeg"})
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()["path"]
        self.assertTrue(saved.startswith("来自 iPhone ") and saved.endswith(".jpg"), saved)
        with open(os.path.join(self.downloads, saved), "rb") as f:
            self.assertEqual(f.read(), b"jpeg bytes")

    def test_name_without_extension_gets_one_from_the_type(self):
        response = self.client.post("/api/upload-stream?target=downloads&name=IMG_1234", content=b"heic",
                                    headers={**SHORTCUT, "Content-Type": "image/heic"})
        self.assertEqual(response.json()["path"], "IMG_1234.heic")

    def test_percent_encoded_header_names_are_decoded(self):
        response = self.client.post("/api/upload-stream?target=downloads", content=b"pdf",
                                    headers={**SHORTCUT, "X-File-Name": "%E5%90%88%E5%90%8C.pdf"})
        self.assertEqual(response.json()["path"], "合同.pdf")

    def test_guide_is_only_shown_on_the_computer(self):
        self.assertEqual(self.client.get("/shortcuts", headers=SHORTCUT).status_code, 403)
        with patch.object(main, "is_host_request", return_value=True):
            page = self.client.get("/shortcuts").text
        self.assertIn("/api/upload-stream?target=downloads", page)
        self.assertIn('data-value="Bearer 123456789012"', page)
        self.assertNotIn(">Bearer 123456789012<", page)  # Hidden until "显示" is clicked.


if __name__ == "__main__":
    unittest.main()
