"""QR pairing: server-sent events let the QR page open /app once the phone has scanned."""
import asyncio
import re
import time
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()

SSE_MAX_CLIENTS = 32
SSE_TTL_SECONDS = 10 * 60
SSE_KEEPALIVE_SECONDS = 25
SID_RE = re.compile(r"^[0-9a-f]{32}$")
sse_clients: Dict[str, asyncio.Queue] = {}


@router.get("/api/sse/{sid}")
async def sse_endpoint(sid: str):
    if not SID_RE.match(sid):
        raise HTTPException(status_code=400, detail="invalid sid")
    if sid not in sse_clients and len(sse_clients) >= SSE_MAX_CLIENTS:
        raise HTTPException(status_code=429, detail="too many waiting QR pages")
    queue: asyncio.Queue = asyncio.Queue()
    sse_clients[sid] = queue

    async def event_gen():
        deadline = time.monotonic() + SSE_TTL_SECONDS
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # Tell the page to stop reconnecting; a reload starts a new session.
                    yield "event: expired\ndata: expired\n\n"
                    return
                try:
                    msg = await asyncio.wait_for(queue.get(), min(SSE_KEEPALIVE_SECONDS, remaining))
                except asyncio.TimeoutError:
                    # Comment lines keep the connection alive and reveal closed clients.
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {msg}\n\n"
                return
        finally:
            if sse_clients.get(sid) is queue:
                sse_clients.pop(sid, None)

    return StreamingResponse(event_gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.post("/api/scanned")
async def api_scanned(sid: Optional[str] = None):
    if not sid:
        raise HTTPException(status_code=400, detail="sid required")
    q = sse_clients.get(sid)
    if q:
        await q.put("scanned")
        sse_clients.pop(sid, None)
    return JSONResponse({"ok": True})
