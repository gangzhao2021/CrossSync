"""Text between devices: a link, a verification code, a paragraph.

Copy on the phone, paste on the computer (and back), like PairDrop's and
LocalSend's text messages. The newest messages are kept so a page opened later
still shows them. Plain-text bodies are accepted too, for iPhone Shortcuts.
"""
import json
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from . import devices, events, metadb
from .common import is_host_request, run_io

router = APIRouter()
# Called with each message another device sends, e.g. to copy it on the computer.
received_listeners = set()

MAX_TEXT_CHARS = 20_000
KEEP_MESSAGES = 50


def sender_name(request: Request) -> str:
    if is_host_request(request):
        return "这台电脑"
    return devices.describe(request.headers.get("user-agent", ""))


def save_text(text: str, sender: str) -> dict:
    now = time.time()
    with metadb.connect() as conn:
        cursor = conn.execute("INSERT INTO texts (text, sender, created) VALUES (?, ?, ?)", (text, sender, now))
        message_id = cursor.lastrowid
        conn.execute(
            "DELETE FROM texts WHERE id NOT IN (SELECT id FROM texts ORDER BY id DESC LIMIT ?)", (KEEP_MESSAGES,)
        )
    return {"id": message_id, "text": text, "sender": sender, "created": now}


def recent_texts() -> list:
    with metadb.connect() as conn:
        rows = conn.execute("SELECT id, text, sender, created FROM texts ORDER BY id DESC LIMIT ?", (KEEP_MESSAGES,)).fetchall()
    return [{"id": r[0], "text": r[1], "sender": r[2], "created": r[3]} for r in rows]


def delete_texts(message_id=None) -> None:
    with metadb.connect() as conn:
        if message_id is None:
            conn.execute("DELETE FROM texts")
        else:
            conn.execute("DELETE FROM texts WHERE id = ?", (message_id,))


async def read_text(request: Request) -> str:
    content_type = request.headers.get("content-type", "")
    body = await request.body()
    if len(body) > MAX_TEXT_CHARS * 4:
        raise HTTPException(status_code=413, detail="文字太长了")
    if content_type.startswith("application/json"):
        try:
            text = json.loads(body.decode("utf-8")).get("text", "")
        except (ValueError, AttributeError, UnicodeDecodeError):
            raise HTTPException(status_code=400, detail="invalid payload")
    else:
        text = body.decode("utf-8", "replace")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="invalid payload")
    text = text.strip("\r\n")
    if not text.strip():
        raise HTTPException(status_code=400, detail="没有要发送的文字")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail=f"文字太长了，最多 {MAX_TEXT_CHARS} 个字")
    return text


@router.post("/api/text")
async def send_text(request: Request):
    text = await read_text(request)
    item = await run_io(save_text, text, sender_name(request))
    events.publish("text", id=item["id"], sender=item["sender"], preview=text[:80])
    if not is_host_request(request):
        for listener in list(received_listeners):
            try:
                listener(item)
            except Exception:
                pass
    return JSONResponse(item)


@router.get("/api/text")
async def list_texts():
    return JSONResponse({"items": await run_io(recent_texts)})


@router.delete("/api/text/{message_id}")
async def delete_text(message_id: int):
    await run_io(delete_texts, message_id)
    events.publish("text", id=message_id, removed=True)
    return JSONResponse({"ok": True})


@router.delete("/api/text")
async def clear_texts():
    await run_io(delete_texts)
    events.publish("text", removed=True)
    return JSONResponse({"ok": True})
