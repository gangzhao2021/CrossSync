"""New devices must be allowed on the computer before they can use CrossSync.

The access token in the QR code is long-lived, so anyone who saw it could keep
sending files. Like LocalSend's receive prompt, the first visit from a device
now waits until someone clicks "允许" on the computer. Allowed devices are
remembered; the computer itself never needs approval.

A browser is recognised by a random cookie. Apps without cookies (the iPhone
app, Shortcuts) may send X-CrossSync-Device; failing that, their user agent
stands in for an identity.
"""
import hashlib
import re
import secrets
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Set

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from . import events, metadb
from .common import is_host_request
from .config import settings

router = APIRouter()

DEVICE_COOKIE = "crosssync_device"
DEVICE_HEADER = "x-crosssync-device"
DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_PENDING = 20
PENDING_TTL_SECONDS = 15 * 60
DENIED_SECONDS = 10 * 60


@dataclass
class Pending:
    device_id: str
    name: str
    address: str
    since: float


_pending: Dict[str, Pending] = {}
_denied: Dict[str, float] = {}
# Called with each new request, e.g. to show a tray notification.
request_listeners: Set[Callable[[Pending], None]] = set()


def new_device_id() -> str:
    return secrets.token_hex(16)


def device_id_for(request: Request) -> Optional[str]:
    """The id a request already carries (header or cookie), if any."""
    for value in (request.headers.get(DEVICE_HEADER, ""), request.cookies.get(DEVICE_COOKIE, "")):
        if value and DEVICE_ID.match(value):
            return value
    return None


def identify(request: Request) -> tuple:
    """(device_id, issue_cookie). Browsers get a fresh cookie id; other clients
    without an id are told apart by their user agent."""
    known = device_id_for(request)
    if known:
        return known, False
    agent = request.headers.get("user-agent", "")
    if "mozilla" in agent.lower():
        return new_device_id(), True
    return "ua-" + hashlib.sha256(agent.encode("utf-8", "ignore")).hexdigest()[:24], False


def describe(user_agent: str) -> str:
    """A short, recognisable name for the approval prompt."""
    agent = user_agent or ""
    # The iPhone app's requests say "CrossSync/<build> CFNetwork/...".
    if "CrossSyncMobile" in agent or (agent.startswith("CrossSync/") and "CFNetwork" in agent):
        return "iPhone 上的 CrossSync App"
    if "Shortcuts" in agent or "WorkflowKit" in agent:
        return "iPhone 快捷指令"
    for marker, device in (("iPad", "iPad"), ("iPhone", "iPhone"), ("Android", "安卓手机"),
                           ("Macintosh", "Mac"), ("Windows", "Windows 电脑"), ("Linux", "Linux 电脑")):
        if marker in agent:
            break
    else:
        device = "未知设备"
    for marker, browser in (("Edg/", "Edge"), ("CriOS", "Chrome"), ("Chrome/", "Chrome"),
                            ("FxiOS", "Firefox"), ("Firefox/", "Firefox"), ("Safari/", "Safari")):
        if marker in agent:
            return f"{device} · {browser}"
    return device


# ---- Storage -----------------------------------------------------------------

def _approved_row(device_id: str):
    with metadb.connect() as conn:
        return conn.execute("SELECT id, name, approved_at, last_seen FROM devices WHERE id = ?", (device_id,)).fetchone()


def is_approved(device_id: str) -> bool:
    return _approved_row(device_id) is not None


def approved_devices() -> List[dict]:
    with metadb.connect() as conn:
        rows = conn.execute("SELECT id, name, approved_at, last_seen FROM devices ORDER BY last_seen DESC").fetchall()
    return [{"id": r[0], "name": r[1], "approved_at": r[2], "last_seen": r[3]} for r in rows]


def touch(device_id: str) -> None:
    now = time.time()
    with metadb.connect() as conn:
        # At most one write a minute per device, not one per upload chunk.
        conn.execute("UPDATE devices SET last_seen = ? WHERE id = ? AND last_seen < ?", (now, device_id, now - 60))


def approve(device_id: str, name: Optional[str] = None) -> None:
    pending = _pending.pop(device_id, None)
    now = time.time()
    with metadb.connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO devices (id, name, approved_at, last_seen) VALUES (?, ?, ?, ?)",
            (device_id, name or (pending.name if pending else "设备"), now, now),
        )
    _denied.pop(device_id, None)


def deny(device_id: str) -> None:
    _pending.pop(device_id, None)
    _denied[device_id] = time.time()


def forget(device_id: str) -> None:
    with metadb.connect() as conn:
        conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))


# ---- Pending requests --------------------------------------------------------

def status(device_id: str) -> str:
    """approved | denied | pending | unknown"""
    if is_approved(device_id):
        return "approved"
    denied_at = _denied.get(device_id)
    if denied_at and time.time() - denied_at < DENIED_SECONDS:
        return "denied"
    return "pending" if device_id in _pending else "unknown"


def request_access(device_id: str, user_agent: str, address: str) -> str:
    """Record that a device is waiting; returns its status. Call from the event loop."""
    current = status(device_id)
    if current in ("approved", "denied"):
        return current
    now = time.time()
    for stale in [key for key, item in _pending.items() if now - item.since > PENDING_TTL_SECONDS]:
        _pending.pop(stale, None)
    if device_id not in _pending:
        if len(_pending) >= MAX_PENDING:
            return "busy"
        item = Pending(device_id, describe(user_agent), address, now)
        _pending[device_id] = item
        events.publish("device-request", id=device_id, name=item.name, address=address)
        for listener in list(request_listeners):
            try:
                listener(item)
            except Exception:
                pass
    return "pending"


def pending_requests() -> List[dict]:
    return [{"id": p.device_id, "name": p.name, "address": p.address, "since": p.since}
            for p in sorted(_pending.values(), key=lambda p: p.since)]


# ---- Routes ------------------------------------------------------------------

def require_host(request: Request) -> None:
    if not is_host_request(request):
        raise HTTPException(status_code=403, detail="只能在运行 CrossSync 的电脑上管理设备")


@router.get("/api/device/status")
async def device_status(request: Request):
    """For a waiting device: has the computer decided yet?"""
    device_id = device_id_for(request)
    return JSONResponse({"status": status(device_id) if device_id else "unknown"})


@router.get("/api/devices")
async def list_devices(request: Request):
    require_host(request)
    return JSONResponse({
        "enabled": settings.require_device_approval,
        "pending": pending_requests(),
        "approved": approved_devices(),
    })


@router.post("/api/devices/{device_id}/approve")
async def approve_device(device_id: str, request: Request):
    require_host(request)
    if not DEVICE_ID.match(device_id):
        raise HTTPException(status_code=400, detail="invalid device")
    approve(device_id)
    events.publish("device-decided", id=device_id, approved=True)
    return JSONResponse({"ok": True})


@router.post("/api/devices/{device_id}/deny")
async def deny_device(device_id: str, request: Request):
    require_host(request)
    deny(device_id)
    events.publish("device-decided", id=device_id, approved=False)
    return JSONResponse({"ok": True})


@router.delete("/api/devices/{device_id}")
async def forget_device(device_id: str, request: Request):
    require_host(request)
    forget(device_id)
    return JSONResponse({"ok": True})
