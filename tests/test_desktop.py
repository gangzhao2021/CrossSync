import os
import socket
import sys
import unittest
from unittest.mock import patch

from app import desktop


class FakeRegistry:
    """In-memory stand-in for winreg, so tests never touch the real Run key."""

    HKEY_CURRENT_USER = "HKCU"
    KEY_SET_VALUE = 2
    REG_SZ = 1

    def __init__(self):
        self.values = {}

    class _Key:
        def __init__(self, registry):
            self.registry = registry

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def OpenKey(self, root, path, *args):
        assert (root, path) == (self.HKEY_CURRENT_USER, desktop.AUTOSTART_KEY)
        return self._Key(self)

    def QueryValueEx(self, key, name):
        if name not in self.values:
            raise FileNotFoundError(name)
        return self.values[name], self.REG_SZ

    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[name] = value

    def DeleteValue(self, key, name):
        if name not in self.values:
            raise FileNotFoundError(name)
        del self.values[name]


class LaunchCommandTests(unittest.TestCase):
    def test_source_checkout_runs_the_pyw_launcher_without_a_console(self):
        with patch.object(sys, "executable", r"C:\repo\.venv\Scripts\python.exe"), \
                patch.object(sys, "frozen", False, create=True):
            command = desktop.launch_command(8008)
        self.assertIn(r"C:\repo\.venv\Scripts\pythonw.exe", command)
        self.assertIn(os.path.join(desktop.REPO_ROOT, "CrossSync.pyw"), command)
        self.assertTrue(command.endswith("--port 8008 --no-browser"))

    def test_packaged_app_runs_itself(self):
        with patch.object(sys, "executable", r"C:\Program Files\CrossSync\CrossSync.exe"), \
                patch.object(sys, "frozen", True, create=True):
            self.assertEqual(desktop.launch_command(8010),
                             '"C:\\Program Files\\CrossSync\\CrossSync.exe" --port 8010 --no-browser')


class AutostartTests(unittest.TestCase):
    def test_enable_and_disable_sign_in_start(self):
        registry = FakeRegistry()
        self.assertFalse(desktop.autostart_enabled(registry))
        desktop.set_autostart(True, 8008, registry)
        self.assertTrue(desktop.autostart_enabled(registry))
        self.assertIn("--no-browser", registry.values[desktop.AUTOSTART_NAME])
        desktop.set_autostart(False, 8008, registry)
        self.assertFalse(desktop.autostart_enabled(registry))
        desktop.set_autostart(False, 8008, registry)  # Removing twice is harmless.


class SingleInstanceTests(unittest.TestCase):
    def test_detects_a_port_that_is_already_serving(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            self.assertTrue(desktop.port_in_use(port))
        self.assertFalse(desktop.port_in_use(port))


class PackagedPathTests(unittest.TestCase):
    def test_packaged_app_keeps_data_and_certificates_per_user(self):
        from app import config

        with patch.object(sys, "frozen", True, create=True), \
                patch.dict(os.environ, {"LOCALAPPDATA": r"C:\Users\someone\AppData\Local"}):
            self.assertEqual(config._home_dir(), r"C:\Users\someone\AppData\Local\CrossSync")
        with patch.object(sys, "frozen", False, create=True):
            self.assertEqual(config._home_dir(), config._BASE_DIR)


if __name__ == "__main__":
    unittest.main()
