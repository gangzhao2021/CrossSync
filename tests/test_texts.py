import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import events, metadb, texts
from app.config import settings
from app.main import app

PHONE = {"Authorization": "Bearer 123456789012",
         "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1"}


class TextTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="crosssync-texts-")
        self.addCleanup(folder.cleanup)
        self.addCleanup(metadb.close_all)
        for key, value in {"mdns_enabled": False, "access_token": "123456789012",
                           "require_device_approval": False, "metadata_dir": folder.name}.items():
            patcher = patch.object(settings, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_text_from_the_phone_reaches_the_computer(self):
        received = []
        texts.received_listeners.add(received.append)
        self.addCleanup(texts.received_listeners.discard, received.append)
        with patch.object(events, "publish") as publish:
            sent = self.client.post("/api/text", json={"text": "验证码 482913"}, headers=PHONE).json()
        self.assertEqual((sent["text"], sent["sender"]), ("验证码 482913", "iPhone · Safari"))
        self.assertEqual(publish.call_args.args[0], "text")
        self.assertEqual([item["text"] for item in received], ["验证码 482913"])  # The tray copies it.
        listed = self.client.get("/api/text", headers=PHONE).json()["items"]
        self.assertEqual([item["text"] for item in listed], ["验证码 482913"])

    def test_plain_text_bodies_work_for_shortcuts(self):
        sent = self.client.post("/api/text", content="https://example.com/a?b=c".encode(),
                                headers={**PHONE, "Content-Type": "text/plain; charset=utf-8"}).json()
        self.assertEqual(sent["text"], "https://example.com/a?b=c")

    def test_empty_and_oversized_text_are_refused(self):
        self.assertEqual(self.client.post("/api/text", json={"text": "  \n "}, headers=PHONE).status_code, 400)
        self.assertEqual(self.client.post("/api/text", json={"text": 5}, headers=PHONE).status_code, 400)
        long_text = "字" * (texts.MAX_TEXT_CHARS + 1)
        self.assertEqual(self.client.post("/api/text", json={"text": long_text}, headers=PHONE).status_code, 413)

    def test_only_the_newest_messages_are_kept_and_they_can_be_deleted(self):
        for index in range(texts.KEEP_MESSAGES + 5):
            self.client.post("/api/text", json={"text": f"第 {index} 条"}, headers=PHONE)
        items = self.client.get("/api/text", headers=PHONE).json()["items"]
        self.assertEqual(len(items), texts.KEEP_MESSAGES)
        self.assertEqual(items[0]["text"], f"第 {texts.KEEP_MESSAGES + 4} 条")
        self.client.delete(f"/api/text/{items[0]['id']}", headers=PHONE)
        self.assertEqual(len(self.client.get("/api/text", headers=PHONE).json()["items"]), texts.KEEP_MESSAGES - 1)
        self.client.delete("/api/text", headers=PHONE)
        self.assertEqual(self.client.get("/api/text", headers=PHONE).json()["items"], [])


if __name__ == "__main__":
    unittest.main()
