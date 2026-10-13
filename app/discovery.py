"""Advertise this computer on the LAN as <name>.local (mDNS, the protocol behind Bonjour).

iPhones resolve .local names natively, so links and the Home Screen app can
use https://crosssync.local:8008 instead of an IP address that changes
whenever the router hands out a new one. The address record is refreshed
when the computer's LAN IP changes.
"""
import logging
import os
import socket
import ssl
from typing import Optional

from .config import settings
from .utils import get_lan_ip

log = logging.getLogger("crosssync.discovery")
SERVICE_TYPE = "_crosssync._tcp.local."
REFRESH_SECONDS = 60


def usable_address(address: str) -> bool:
    try:
        socket.inet_aton(address)
    except OSError:
        return False
    return not address.startswith(("127.", "169.254.", "0."))


class Advertiser:
    def __init__(self) -> None:
        self.zeroconf = None
        self.info = None
        self.address: Optional[str] = None

    @property
    def active(self) -> bool:
        return self.info is not None

    @property
    def hostname(self) -> str:
        return f"{settings.mdns_name}.local"

    def _service(self, address: str):
        from zeroconf import ServiceInfo

        return ServiceInfo(
            SERVICE_TYPE,
            f"CrossSync {settings.mdns_name}.{SERVICE_TYPE}",
            addresses=[socket.inet_aton(address)],
            port=settings.port,
            server=f"{self.hostname}.",
            properties={"path": "/app"},
        )

    async def start(self) -> None:
        if not settings.mdns_enabled:
            return
        address = get_lan_ip()
        if not usable_address(address):
            log.warning("mDNS not started: no LAN IPv4 address")
            return
        try:
            from zeroconf import IPVersion
            from zeroconf.asyncio import AsyncZeroconf

            self.zeroconf = AsyncZeroconf(ip_version=IPVersion.V4Only)
            info = self._service(address)
            await self.zeroconf.async_register_service(info, allow_name_change=True)
            self.info, self.address = info, address
            log.info("Advertising %s at %s", self.hostname, address)
        except Exception as exc:  # Port 5353 busy, no multicast, firewall...
            log.warning("mDNS advertising unavailable: %s", exc)
            await self.stop()

    async def refresh(self) -> None:
        """Follow LAN IP changes (DHCP renewals, switching Wi-Fi)."""
        if not self.active:
            return
        address = get_lan_ip()
        if address == self.address or not usable_address(address):
            return
        info = self._service(address)
        await self.zeroconf.async_update_service(info)
        self.info, self.address = info, address
        log.info("mDNS address for %s updated to %s", self.hostname, address)

    async def stop(self) -> None:
        if self.zeroconf is not None:
            try:
                if self.info is not None:
                    await self.zeroconf.async_unregister_service(self.info)
                await self.zeroconf.async_close()
            except Exception:
                pass
        self.zeroconf = self.info = self.address = None


advertiser = Advertiser()

_cert_cache: dict = {}


def certificate_covers(cert_path: str, hostname: str) -> bool:
    """Whether the HTTPS certificate lists hostname, so the .local link will not show a warning."""
    try:
        mtime = os.path.getmtime(cert_path)
    except OSError:
        return False
    cached = _cert_cache.get(cert_path)
    if not cached or cached[0] != mtime:
        try:
            names = {value.lower() for kind, value in ssl._ssl._test_decode_cert(cert_path).get("subjectAltName", ()) if kind == "DNS"}
        except Exception:
            names = set()
        cached = _cert_cache[cert_path] = (mtime, names)
    return hostname.lower() in cached[1]
