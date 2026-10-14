import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import devices, metadb
from app.config import settings
from app.main import app

TOKEN = "123456789012"
BROWSER = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"}


class DeviceApprovalTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="crosssync-devices-")
        self.addCleanup(folder.cleanup)
        self.addCleanup(metadb.close_all)  # Release the database before the folder is removed.
        for key, value in {"mdns_enabled": False, "access_token": TOKEN, "require_device_approval": True,
                           "metadata_dir": folder.name}.items():
            patcher = patch.object(settings, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("_pending", "_denied"):
            patcher = patch.object(devices, name, {})
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_new_browser_waits_until_the_computer_allows_it(self):
        first = self.client.get(f"/app?k={TOKEN}", headers=BROWSER, follow_redirects=False)
        self.assertEqual(first.status_code, 303)
        device_id = first.cookies.get(devices.DEVICE_COOKIE)
        self.assertTrue(device_id)

        waiting = self.client.get("/app", headers=BROWSER)
        self.assertEqual(waiting.status_code, 403)
        self.assertIn("请在电脑上点“允许”", waiting.text)
        self.assertEqual(self.client.get("/api/config", headers=BROWSER).json()["device"], "pending")
        self.assertEqual(self.client.get("/api/device/status", headers=BROWSER).json()["status"], "pending")
        self.assertEqual([item["name"] for item in devices.pending_requests()], ["iPhone · Safari"])

        devices.approve(device_id)
        self.assertEqual(self.client.get("/api/device/status", headers=BROWSER).json()["status"], "approved")
        self.assertEqual(self.client.get("/app", headers=BROWSER).status_code, 200)
        self.assertEqual(self.client.get("/api/config", headers=BROWSER).status_code, 200)
        self.assertEqual([item["id"] for item in devices.approved_devices()], [device_id])

    def test_denied_device_is_told_so(self):
        self.client.get(f"/app?k={TOKEN}", headers=BROWSER)
        device_id = self.client.cookies.get(devices.DEVICE_COOKIE)
        devices.deny(device_id)
        response = self.client.get("/api/config", headers=BROWSER)
        self.assertEqual((response.status_code, response.json()["device"]), (403, "denied"))
        self.assertIn("电脑拒绝了这台设备", self.client.get("/app", headers=BROWSER).text)

    def test_apps_without_cookies_are_recognised_by_their_header_or_user_agent(self):
        headers = {"Authorization": f"Bearer {TOKEN}", "User-Agent": "Shortcuts/2.0 CFNetwork/1.0"}
        self.assertEqual(self.client.get("/api/config", headers=headers).status_code, 403)
        [request] = devices.pending_requests()
        self.assertEqual(request["name"], "iPhone 快捷指令")
        devices.approve(request["id"])
        self.assertEqual(self.client.get("/api/config", headers=headers).status_code, 200)

        with_header = {**headers, devices.DEVICE_HEADER: "native-app-0001"}
        self.assertEqual(self.client.get("/api/config", headers=with_header).status_code, 403)
        self.assertIn("native-app-0001", [item["id"] for item in devices.pending_requests()])

    def test_forgotten_device_has_to_ask_again(self):
        self.client.get(f"/app?k={TOKEN}", headers=BROWSER)
        device_id = self.client.cookies.get(devices.DEVICE_COOKIE)
        devices.approve(device_id)
        self.assertEqual(self.client.get("/api/config", headers=BROWSER).status_code, 200)
        devices.forget(device_id)
        self.assertEqual(self.client.get("/api/config", headers=BROWSER).status_code, 403)

    def test_only_the_computer_manages_devices(self):
        auth = {"Authorization": f"Bearer {TOKEN}", devices.DEVICE_HEADER: "phone-device-01"}
        devices.approve("phone-device-01", "iPhone")
        for method, path in (("get", "/api/devices"), ("post", "/api/devices/phone-device-01/approve"),
                             ("post", "/api/devices/phone-device-01/deny"), ("delete", "/api/devices/phone-device-01")):
            self.assertEqual(getattr(self.client, method)(path, headers=auth).status_code, 403, path)

    def test_turning_approval_off_lets_token_holders_in(self):
        with patch.object(settings, "require_device_approval", False):
            self.assertEqual(self.client.get("/api/config", headers={"Authorization": f"Bearer {TOKEN}"}).status_code, 200)

    def test_names_shown_on_the_computer(self):
        cases = {
            BROWSER["User-Agent"]: "iPhone · Safari",
            "Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36": "安卓手机 · Chrome",
            "CrossSyncMobile/1 CFNetwork/1568 Darwin/24.0.0": "iPhone 上的 CrossSync App",
            "": "未知设备",
        }
        for agent, name in cases.items():
            self.assertEqual(devices.describe(agent), name, agent)


if __name__ == "__main__":
    unittest.main()
