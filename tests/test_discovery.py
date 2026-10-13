import asyncio
import unittest
from unittest.mock import patch

from starlette.requests import Request

import app.main as main
from app import discovery
from app.config import settings


def request(scheme="https"):
    return Request({
        "type": "http", "scheme": scheme, "method": "GET", "path": "/", "query_string": b"",
        "headers": [(b"host", b"127.0.0.1:8008")], "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8008),
    })


class PhoneLinkTests(unittest.TestCase):
    def setUp(self):
        for target, value in ((main, "get_lan_ip"),):
            patcher = patch.object(target, value, return_value="192.168.2.14")
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_uses_the_lan_ip_when_mdns_is_not_running(self):
        with patch.object(discovery.Advertiser, "active", new=False):
            host, url = main.app_url_for_request(request(), "a" * 32)
        self.assertEqual(host, "192.168.2.14")
        self.assertTrue(url.startswith("https://192.168.2.14:8008/app?"))

    def test_uses_the_local_name_when_the_certificate_covers_it(self):
        with patch.object(discovery.Advertiser, "active", new=True), \
                patch.object(main, "certificate_covers", return_value=True):
            host, url = main.app_url_for_request(request(), None)
        self.assertEqual(host, "crosssync.local")
        self.assertTrue(url.startswith("https://crosssync.local:8008/app"))

    def test_falls_back_to_ip_when_the_certificate_lacks_the_name(self):
        with patch.object(discovery.Advertiser, "active", new=True), \
                patch.object(main, "certificate_covers", return_value=False):
            host, _ = main.app_url_for_request(request(), None)
        self.assertEqual(host, "192.168.2.14")

    def test_plain_http_can_always_use_the_name(self):
        with patch.object(discovery.Advertiser, "active", new=True):
            host, url = main.app_url_for_request(request("http"), None)
        self.assertEqual(url.split("/app")[0], "http://crosssync.local:8008")


class AdvertiserTests(unittest.TestCase):
    def test_disabled_advertiser_stays_inactive(self):
        advertiser = discovery.Advertiser()
        with patch.object(settings, "mdns_enabled", False):
            asyncio.run(advertiser.start())
        self.assertFalse(advertiser.active)

    def test_no_lan_address_means_no_advertising(self):
        advertiser = discovery.Advertiser()
        with patch.object(discovery, "get_lan_ip", return_value="127.0.0.1"):
            asyncio.run(advertiser.start())
        self.assertFalse(advertiser.active)

    def test_only_real_ipv4_lan_addresses_are_advertised(self):
        self.assertTrue(discovery.usable_address("192.168.2.14"))
        for address in ("127.0.0.1", "169.254.3.4", "fe80::1", "not-an-ip"):
            self.assertFalse(discovery.usable_address(address), address)


if __name__ == "__main__":
    unittest.main()
