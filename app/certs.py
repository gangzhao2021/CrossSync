"""Local HTTPS certificates: a private CrossSync CA plus a server certificate.

Pure Python (the `cryptography` package), so neither Git for Windows nor an
OpenSSL install is needed. Behaviour matches the old setup-https scripts:

- The CA is created once and kept; iPhones only need to trust it once.
- The server certificate is re-issued when the LAN address or the .local
  name changes (recorded in lan-host.txt), signed by the same CA.
- force=True rotates the CA too; iPhones then need the new /ca.crt.

Usage: python -m app.certs --lan-host 192.168.1.20 [--dns-name crosssync.local] [--force]
"""
import argparse
import datetime
import ipaddress
import os
from typing import Optional

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CA_KEY = "ca-key.pem"
CA_CERT = "ca.crt"
SERVER_KEY = "key.pem"
SERVER_CERT = "cert.pem"
HOST_MARKER = "lan-host.txt"
CA_DAYS = 3650
SERVER_DAYS = 825  # iOS rejects server certificates valid for longer than 825 days.


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _write_private(path: str, data: bytes) -> None:
    with open(path, "wb") as f:
        f.write(data)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _key_pem(key) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption(),
    )


def _create_ca(cert_dir: str) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CrossSync Local CA")])
    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=False, content_commitment=False, key_encipherment=False, data_encipherment=False,
            key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False,
        ), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    _write_private(os.path.join(cert_dir, CA_KEY), _key_pem(key))
    with open(os.path.join(cert_dir, CA_CERT), "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def _host_entry(host: str) -> x509.GeneralName:
    try:
        return x509.IPAddress(ipaddress.ip_address(host))
    except ValueError:
        return x509.DNSName(host)


def _create_server(cert_dir: str, lan_host: str, dns_name: Optional[str]) -> None:
    with open(os.path.join(cert_dir, CA_KEY), "rb") as f:
        ca_key = serialization.load_pem_private_key(f.read(), password=None)
    with open(os.path.join(cert_dir, CA_CERT), "rb") as f:
        ca_cert = x509.load_pem_x509_certificate(f.read())

    names = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1")), _host_entry(lan_host)]
    if dns_name and dns_name != lan_host:
        names.append(x509.DNSName(dns_name))

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, lan_host)]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=SERVER_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=False, key_encipherment=True, data_encipherment=False,
            key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False,
        ), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    _write_private(os.path.join(cert_dir, SERVER_KEY), _key_pem(key))
    with open(os.path.join(cert_dir, SERVER_CERT), "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def ensure_certificates(cert_dir: str, lan_host: str, dns_name: Optional[str] = None, force: bool = False) -> dict:
    """Create or refresh the certificates; returns their paths and what changed."""
    os.makedirs(cert_dir, exist_ok=True)
    paths = {name: os.path.join(cert_dir, name) for name in (CA_KEY, CA_CERT, SERVER_KEY, SERVER_CERT, HOST_MARKER)}
    if force:
        for path in paths.values():
            if os.path.exists(path):
                os.remove(path)

    created_ca = False
    if not (os.path.isfile(paths[CA_KEY]) and os.path.isfile(paths[CA_CERT])):
        _create_ca(cert_dir)
        created_ca = True

    wanted = f"{lan_host} {dns_name}".strip() if dns_name else lan_host
    try:
        with open(paths[HOST_MARKER], encoding="ascii", errors="ignore") as f:
            current = f.read().strip()
    except FileNotFoundError:
        current = ""
    renewed = created_ca or current != wanted or not (os.path.isfile(paths[SERVER_KEY]) and os.path.isfile(paths[SERVER_CERT]))
    if renewed:
        _create_server(cert_dir, lan_host, dns_name)
        with open(paths[HOST_MARKER], "w", encoding="ascii") as f:
            f.write(wanted + "\n")

    return {
        "ca": paths[CA_CERT],
        "cert": paths[SERVER_CERT],
        "key": paths[SERVER_KEY],
        "created_ca": created_ca,
        "renewed": renewed,
    }


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Create or refresh CrossSync's local HTTPS certificates.")
    parser.add_argument("--lan-host", required=True, help="LAN IP address or host name of this computer")
    parser.add_argument("--dns-name", default="", help="extra name, e.g. crosssync.local")
    parser.add_argument("--cert-dir", default=os.environ.get("CROSSSYNC_CERT_DIR", ""), help="defaults to the configured certs folder")
    parser.add_argument("--force", action="store_true", help="also replace the CA (iPhones must trust the new one)")
    args = parser.parse_args(argv)
    cert_dir = args.cert_dir
    if not cert_dir:
        from .config import settings

        cert_dir = settings.cert_dir
    result = ensure_certificates(cert_dir, args.lan_host, args.dns_name or None, args.force)
    state = "new CA and certificate" if result["created_ca"] else ("certificate renewed" if result["renewed"] else "certificates up to date")
    print(f"CrossSync HTTPS: {state} in {cert_dir}")


if __name__ == "__main__":
    main()
