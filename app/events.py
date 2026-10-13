"""Live events for open pages: a file arrived, or an area's file list changed.

Pages subscribe with EventSource. This replaces waiting up to 15 seconds for
the next list poll, and it keeps working while the tab is in the background,
which is when the computer needs to say "your photos have arrived".
"""
import asyncio
import json
from typing import Set

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

router = APIRouter()

MAX_SUBSCRIBERS = 32
KEEPALIVE_SECONDS = 25
QUEUE_LIMIT = 200  # A stalled page drops events instead of growing memory.
_subscribers: Set[asyncio.Queue] = set()


def publish(kind: str, **data) -> None:
    """Send an event to every open page. Call from the event loop."""
    message = json.dumps({"type": kind, **data}, ensure_ascii=False)
    for queue in list(_subscribers):
        if queue.qsize() < QUEUE_LIMIT:
            queue.put_nowait(message)


@router.get("/api/events")
async def events():
    if len(_subscribers) >= MAX_SUBSCRIBERS:
        raise HTTPException(status_code=429, detail="too many open pages")
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.add(queue)

    async def stream():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {message}\n\n"
        finally:
            _subscribers.discard(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
