import asyncio
import json
import os
import socket
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from app.common import is_host_address
from app.config import load_env_overrides, settings
from app.main import api_config, api_pick_downloads_dir, api_set_display_name


def make_request(client_host: str = "127.0.0.1") -> Request:
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/config",
        "raw_path": b"/api/config",
        "query_string": b"",
        "headers": [],
        "client": (client_host, 50000),
        "server": ("127.0.0.1", 8008),
    })


class HostAddressTests(unittest.TestCase):
    def test_ipv4_loopback_is_host(self):
        self.assertTrue(is_host_address("127.0.0.1", "192.168.2.14"))

    def test_ipv6_loopback_is_host(self):
        self.assertTrue(is_host_address("::1", "192.168.2.14"))

    def test_ipv4_mapped_loopback_is_host(self):
        self.assertTrue(is_host_address("::ffff:127.0.0.1", "192.168.2.14"))

    def test_computers_lan_address_is_host(self):
        self.assertTrue(is_host_address("192.168.2.14", "192.168.2.14"))

    def test_another_lan_device_is_not_host(self):
        self.assertFalse(is_host_address("192.168.2.32", "192.168.2.14"))

    def test_invalid_address_is_not_host(self):
        self.assertFalse(is_host_address("not-an-ip", "192.168.2.14"))


class RuntimeConfigTests(unittest.TestCase):
    @patch("app.common.get_lan_ip", return_value="192.168.2.14")
    @patch("app.main.get_lan_ip", return_value="192.168.2.14")
    @patch("app.main.downloads_free_bytes", return_value=123456)
    @patch("app.main.folder_picker_available", return_value=True)
    def test_host_config_exposes_native_folder_picker(self, _picker, _free, _lan, _common_lan):
        response = asyncio.run(api_config(make_request()))
        payload = json.loads(response.body)
        self.assertTrue(payload["is_host_device"])
        self.assertTrue(payload["can_choose_downloads_dir"])
        self.assertEqual(payload["downloads_free_bytes"], 123456)
        self.assertEqual(payload["lan_ip"], "192.168.2.14")
        self.assertTrue(payload["computer_name"])

    @patch("app.common.get_lan_ip", return_value="192.168.2.14")
    @patch("app.main.get_lan_ip", return_value="192.168.2.14")
    @patch("app.main.folder_picker_available", return_value=True)
    def test_lan_client_cannot_open_computer_folder_picker(self, _picker, _lan, _common_lan):
        response = asyncio.run(api_config(make_request("192.168.2.32")))
        payload = json.loads(response.body)
        self.assertFalse(payload["is_host_device"])
        self.assertFalse(payload["can_choose_downloads_dir"])

    @patch("app.main.pick_folder", return_value=None)
    @patch("app.main.folder_picker_available", return_value=True)
    def test_folder_picker_cancel_keeps_current_path(self, _available, _pick):
        response = api_pick_downloads_dir(make_request())
        payload = json.loads(response.body)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["cancelled"])


class DisplayNameTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        for key, value in {"metadata_dir": folder.name, "display_name": None}.items():
            patcher = patch.object(settings, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.preferences = os.path.join(folder.name, "preferences.json")

    def config(self):
        return json.loads(asyncio.run(api_config(make_request())).body)

    def test_hostname_is_used_until_a_name_is_set(self):
        payload = self.config()
        self.assertEqual(payload["computer_name"], socket.gethostname())
        self.assertFalse(payload["has_display_name"])

    def test_rename_is_saved_cleaned_and_survives_restart(self):
        result = json.loads(api_set_display_name(make_request(), {"name": "  书房\n电脑  "}).body)
        self.assertEqual(result["computer_name"], "书房 电脑")
        self.assertEqual(self.config()["computer_name"], "书房 电脑")
        with open(self.preferences, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["display_name"], "书房 电脑")
        settings.display_name = None
        load_env_overrides()
        self.assertEqual(settings.display_name, "书房 电脑")

    def test_empty_name_restores_hostname(self):
        api_set_display_name(make_request(), {"name": "客厅电脑"})
        api_set_display_name(make_request(), {"name": "   "})
        self.assertEqual(self.config()["computer_name"], socket.gethostname())

    def test_rejects_long_names_and_lan_clients(self):
        with self.assertRaises(HTTPException) as too_long:
            api_set_display_name(make_request(), {"name": "x" * 33})
        self.assertEqual(too_long.exception.status_code, 400)
        with self.assertRaises(HTTPException) as remote:
            api_set_display_name(make_request("192.0.2.40"), {"name": "别人的电脑"})
        self.assertEqual(remote.exception.status_code, 403)
        self.assertIsNone(settings.display_name)


if __name__ == "__main__":
    unittest.main()
