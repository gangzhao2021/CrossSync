import asyncio
import json
import unittest
from unittest.mock import patch

from starlette.requests import Request

from app.main import api_config, api_pick_downloads_dir, is_host_address


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
    @patch("app.main.get_lan_ip", return_value="192.168.2.14")
    @patch("app.main.downloads_free_bytes", return_value=123456)
    @patch("app.main.folder_picker_available", return_value=True)
    def test_host_config_exposes_native_folder_picker(self, _picker, _free, _lan):
        response = asyncio.run(api_config(make_request()))
        payload = json.loads(response.body)
        self.assertTrue(payload["is_host_device"])
        self.assertTrue(payload["can_choose_downloads_dir"])
        self.assertEqual(payload["downloads_free_bytes"], 123456)
        self.assertEqual(payload["lan_ip"], "192.168.2.14")
        self.assertTrue(payload["computer_name"])

    @patch("app.main.get_lan_ip", return_value="192.168.2.14")
    @patch("app.main.folder_picker_available", return_value=True)
    def test_lan_client_cannot_open_computer_folder_picker(self, _picker, _lan):
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


if __name__ == "__main__":
    unittest.main()
