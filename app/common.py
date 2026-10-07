"""Helpers shared by the route modules."""
import asyncio
import ipaddress
import os
import re
from typing import Optional

from fastapi import HTTPException, Request

from .checksums import normalize_rel_path
from .config import area_dir
from .utils import get_lan_ip, open_folder

# Partially assembled outputs that must never be listed, downloaded or cleared.
PARTIAL_OUTPUT_RE = re.compile(r"\.(?:assembling|streaming)-[a-zA-Z0-9-]+\.tmp$")
FALSE_FLAGS = {"0", "false", "False", "no", "off"}


async def run_io(function, *args, **kwargs):
    """Run blocking work in a thread; a cancelled request still waits for it to finish."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


def resolve_area(area: str) -> str:
    """Map a transfer area from a URL to its directory, or answer 404."""
    try:
        return area_dir(area)
    except ValueError:
        raise HTTPException(status_code=404, detail="unknown area")


def area_rel_path(full_path: str, base_dir: str) -> str:
    """Path of a saved file relative to its area, for display and checksum keys.

    Saved paths come from safe_join/reserve_unique_path_nested, which resolve
    symlinks, junctions and Windows 8.3 short names. Resolve the base the same
    way, or relpath walks out of the area (for example ``../../RUNNER~1/...``).
    """
    return normalize_rel_path(os.path.relpath(full_path, os.path.realpath(base_dir)))


def discard_files(*paths: str) -> None:
    """Best-effort removal of temporary files."""
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass


def is_hidden_transfer_file(rel_path: str) -> bool:
    rel = normalize_rel_path(rel_path)
    parts = rel.split("/")
    name = parts[-1] if parts else rel
    return (
        ".crosssync" in [part.lower() for part in parts]
        or bool(PARTIAL_OUTPUT_RE.search(name))
        or name.endswith(".sha256")
        or name in {".DS_Store", "Thumbs.db"}
    )


def is_host_address(client_host: str, lan_ip: Optional[str] = None) -> bool:
    """Return whether an address belongs to the computer running CrossSync."""
    try:
        client_ip = ipaddress.ip_address(client_host)
        if client_ip.is_loopback:
            return True
        mapped_ip = getattr(client_ip, "ipv4_mapped", None)
        if mapped_ip and mapped_ip.is_loopback:
            return True
    except ValueError:
        return False

    host_lan_ip = lan_ip or get_lan_ip()
    try:
        return client_ip == ipaddress.ip_address(host_lan_ip)
    except ValueError:
        return client_host == host_lan_ip


def is_host_request(request: Request) -> bool:
    client_host = request.client.host if request.client else ""
    return is_host_address(client_host)


def wants_checksum(request: Request, default: bool) -> bool:
    flag = request.query_params.get("checksum")
    return default if flag is None else flag not in FALSE_FLAGS


def open_folder_if_requested(request: Request, path: str) -> None:
    flag = request.query_params.get("open")
    if flag and flag not in FALSE_FLAGS and is_host_request(request):
        try:
            open_folder(os.path.dirname(path))
        except Exception:
            pass
