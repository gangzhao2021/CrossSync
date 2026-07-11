import os
import shutil
import ssl
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SETUP_SCRIPT = REPO_ROOT / "scripts" / "setup-https.sh"


def find_bash():
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    if os.name == "nt" and windows_git_bash.is_file():
        return str(windows_git_bash)
    return shutil.which("bash")


@unittest.skipUnless(find_bash(), "bash is unavailable")
class PosixHTTPSSetupTests(unittest.TestCase):
    def run_setup(self, cert_dir, host, *extra_args):
        env = os.environ.copy()
        env["CROSSSYNC_CERT_DIR"] = str(cert_dir)
        completed = subprocess.run(
            [find_bash(), str(SETUP_SCRIPT), "--lan-host", host, *extra_args],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)

    def test_generates_certificates_and_reuses_ca_for_host_changes(self):
        with tempfile.TemporaryDirectory(prefix="crosssync-certs-") as temp_dir:
            cert_dir = Path(temp_dir)
            self.run_setup(cert_dir, "127.0.0.1")

            ca_before = (cert_dir / "ca.crt").read_bytes()
            server_before = (cert_dir / "cert.pem").read_bytes()
            decoded = ssl._ssl._test_decode_cert(str(cert_dir / "cert.pem"))
            self.assertIn(("IP Address", "127.0.0.1"), decoded["subjectAltName"])

            self.run_setup(cert_dir, "192.168.50.10")
            self.assertEqual((cert_dir / "ca.crt").read_bytes(), ca_before)
            self.assertNotEqual((cert_dir / "cert.pem").read_bytes(), server_before)
            decoded = ssl._ssl._test_decode_cert(str(cert_dir / "cert.pem"))
            self.assertIn(("IP Address", "192.168.50.10"), decoded["subjectAltName"])

    def test_force_rotates_ca(self):
        with tempfile.TemporaryDirectory(prefix="crosssync-certs-") as temp_dir:
            cert_dir = Path(temp_dir)
            self.run_setup(cert_dir, "127.0.0.1")
            ca_before = (cert_dir / "ca.crt").read_bytes()

            self.run_setup(cert_dir, "127.0.0.1", "--force")
            self.assertNotEqual((cert_dir / "ca.crt").read_bytes(), ca_before)


if __name__ == "__main__":
    unittest.main()
