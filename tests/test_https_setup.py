import ssl
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from app import certs

REPO_ROOT = Path(__file__).resolve().parents[1]


def san(cert_path):
    return ssl._ssl._test_decode_cert(str(cert_path))["subjectAltName"]


class CertificateTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="crosssync-certs-")
        self.addCleanup(folder.cleanup)
        self.dir = Path(folder.name)

    def test_generates_a_ca_and_a_server_certificate_it_signed(self):
        result = certs.ensure_certificates(str(self.dir), "192.168.50.10", "crosssync.local")
        self.assertTrue(result["created_ca"] and result["renewed"])
        names = san(self.dir / "cert.pem")
        for expected in (("DNS", "localhost"), ("IP Address", "127.0.0.1"),
                         ("IP Address", "192.168.50.10"), ("DNS", "crosssync.local")):
            self.assertIn(expected, names)
        # The server certificate must be signed by the CrossSync CA and match its key.
        from cryptography import x509
        server = x509.load_pem_x509_certificate((self.dir / "cert.pem").read_bytes())
        server.verify_directly_issued_by(x509.load_pem_x509_certificate((self.dir / "ca.crt").read_bytes()))
        context = ssl.create_default_context(cafile=str(self.dir / "ca.crt"))
        context.load_cert_chain(str(self.dir / "cert.pem"), str(self.dir / "key.pem"))
        self.assertEqual((self.dir / "lan-host.txt").read_text().strip(), "192.168.50.10 crosssync.local")

    def test_reuses_the_ca_and_only_reissues_when_the_address_changes(self):
        certs.ensure_certificates(str(self.dir), "127.0.0.1")
        ca_before = (self.dir / "ca.crt").read_bytes()
        server_before = (self.dir / "cert.pem").read_bytes()

        unchanged = certs.ensure_certificates(str(self.dir), "127.0.0.1")
        self.assertFalse(unchanged["renewed"])
        self.assertEqual((self.dir / "cert.pem").read_bytes(), server_before)

        moved = certs.ensure_certificates(str(self.dir), "192.168.50.10")
        self.assertTrue(moved["renewed"])
        self.assertFalse(moved["created_ca"])
        self.assertEqual((self.dir / "ca.crt").read_bytes(), ca_before)
        self.assertIn(("IP Address", "192.168.50.10"), san(self.dir / "cert.pem"))

    def test_force_rotates_the_ca(self):
        certs.ensure_certificates(str(self.dir), "127.0.0.1")
        ca_before = (self.dir / "ca.crt").read_bytes()
        certs.ensure_certificates(str(self.dir), "127.0.0.1", force=True)
        self.assertNotEqual((self.dir / "ca.crt").read_bytes(), ca_before)

    def test_server_certificate_lifetime_is_acceptable_to_ios(self):
        certs.ensure_certificates(str(self.dir), "127.0.0.1")
        decoded = ssl._ssl._test_decode_cert(str(self.dir / "cert.pem"))
        from email.utils import parsedate_to_datetime
        lifetime = parsedate_to_datetime(decoded["notAfter"]) - parsedate_to_datetime(decoded["notBefore"])
        self.assertLessEqual(lifetime.days, 825)

    def test_command_line_entry_point(self):
        completed = subprocess.run(
            [sys.executable, "-m", "app.certs", "--lan-host", "10.0.0.8", "--dns-name", "crosssync.local",
             "--cert-dir", str(self.dir)],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(("IP Address", "10.0.0.8"), san(self.dir / "cert.pem"))


if __name__ == "__main__":
    unittest.main()
