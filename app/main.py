import os
import io
import time
import uuid
import asyncio
from typing import List, Optional, Dict

from fastapi import FastAPI, Request, UploadFile, File, HTTPException
from fastapi import Body
from fastapi.responses import HTMLResponse, FileResponse, ORJSONResponse, StreamingResponse
from starlette.background import BackgroundTask
import tempfile
import zipfile
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import settings, ensure_dirs, load_env_overrides
from .utils import get_lan_ip, safe_join, file_fingerprint
from .uploader import UploadStore, UploadMeta


load_env_overrides()
ensure_dirs()
app = FastAPI(title=settings.app_name)

static_dir = os.path.join(os.path.dirname(__file__), "static")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

app.mount("/static", StaticFiles(directory=static_dir), name="static")

upload_store = UploadStore(os.path.join(settings.temp_dir, "uploads"))


# Optional simple OTP gate middleware
@app.middleware("http")
async def otp_gate(request: Request, call_next):
    if not settings.otp_enabled:
        return await call_next(request)
    path = request.scope.get("path", "")
    # Public endpoints
    if path in {"/", "/qr.png"} or path.startswith("/static") or path.startswith("/api/sse/") or path.startswith("/api/scanned"):
        return await call_next(request)
    # Validate cookie or query param
    token = request.cookies.get("x_otp") or request.query_params.get("k")
    if token and settings.otp_code and token == settings.otp_code:
        response = await call_next(request)
        # Set cookie for subsequent API calls
        response.set_cookie("x_otp", token, httponly=False, samesite="lax")
        return response
    return HTMLResponse("<h3>需要一次性访问码</h3><p>请返回二维码页或附加 ?k=CODE 参数。</p>", status_code=401)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # Render index page with QR for LAN URL
    host_ip = get_lan_ip()
    query = ""
    if settings.otp_enabled:
        # Generate a simple code if not set
        if not settings.otp_code:
            settings.otp_code = str(int(time.time()))[-6:]
        query = f"?k={settings.otp_code}"
    sid = uuid.uuid4().hex
    url = f"http://{host_ip}:{settings.port}/app{query}&sid={sid}" if query else f"http://{host_ip}:{settings.port}/app?sid={sid}"
    return templates.TemplateResponse("index.html", {"request": request, "lan_url": url, "otp": settings.otp_code, "otp_enabled": settings.otp_enabled, "sid": sid})


@app.get("/qr.png")
async def qr_png(request: Request):
    try:
        import qrcode
        from PIL import Image
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"QR deps missing: {e}")
    host_ip = get_lan_ip()
    sid = request.query_params.get('sid')
    query = ""
    if settings.otp_enabled:
        if not settings.otp_code:
            settings.otp_code = str(int(time.time()))[-6:]
        query = f"?k={settings.otp_code}"
    # Append sid
    if sid:
        query = (query + ("&" if query else "?") + f"sid={sid}")
    url = f"http://{host_ip}:{settings.port}/app{query}"
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@app.get("/app", response_class=HTMLResponse)
async def app_page(request: Request):
    return templates.TemplateResponse("app.html", {"request": request, "chunk_size": settings.default_chunk_size, "max_concurrency": settings.max_concurrency})


@app.get("/api/config")
async def api_config():
    return ORJSONResponse({
        "downloads_dir": settings.downloads_dir,
        "outbox_dir": settings.outbox_dir,
        "default_chunk_size": settings.default_chunk_size,
        "max_concurrency": settings.max_concurrency,
    })


class InitUploadBody:
    def __init__(self, name: str, size: int, chunk_size: Optional[int] = None, last_modified: Optional[int] = None, target: str = "downloads"):
        self.name = name
        self.size = size
        self.chunk_size = chunk_size or settings.default_chunk_size
        self.last_modified = last_modified
        self.target = target


@app.post("/api/init-upload")
async def init_upload(payload: dict = Body(...)):
    try:
        name = payload["name"]  # can be nested path under target root
        size = int(payload["size"])
        chunk_size = int(payload.get("chunk_size") or settings.default_chunk_size)
        last_modified = payload.get("last_modified")
        target = payload.get("target", "downloads")
        if target not in ("downloads", "outbox"):
            raise ValueError("invalid target")
    except Exception:
        raise HTTPException(status_code=400, detail="invalid payload")

    total_chunks = (size + chunk_size - 1) // chunk_size
    fingerprint = file_fingerprint(name, size, last_modified)
    # Try find existing unfinished session
    existing = upload_store.find_by_fingerprint(fingerprint)
    if existing:
        missing = upload_store.missing_chunks(existing.upload_id)
        return ORJSONResponse({
            "resumed": True,
            "upload_id": existing.upload_id,
            "chunk_size": existing.chunk_size,
            "total_chunks": existing.total_chunks,
            "missing": missing,
        })

    upload_id = uuid.uuid4().hex
    meta = UploadMeta(
        upload_id=upload_id,
        name=name,
        size=size,
        chunk_size=chunk_size,
        target=target,
        fingerprint=fingerprint,
        total_chunks=total_chunks,
        received={},
    )
    upload_store.init_session(meta)
    return ORJSONResponse({
        "resumed": False,
        "upload_id": upload_id,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "missing": list(range(total_chunks)),
    })


@app.put("/api/upload/{upload_id}/{chunk_index}")
async def upload_chunk(upload_id: str, chunk_index: int, request: Request):
    meta = upload_store.get_meta(upload_id)
    # Try reading body; for now we read into memory (chunk-sized)
    data = await request.body()
    # Optional integrity check via x-sha256 header
    hdr = request.headers.get('x-sha256')
    if hdr:
        import hashlib
        h = hashlib.sha256(data).hexdigest()
        if h.lower() != hdr.lower():
            raise HTTPException(status_code=400, detail="chunk checksum mismatch")
    # Allow last chunk to be smaller
    expected = meta.chunk_size
    if chunk_index == meta.total_chunks - 1:
        expected = meta.size - meta.chunk_size * (meta.total_chunks - 1)
    if len(data) != expected:
        # iOS/Safari may split differently if size unknown; accept but mark warning
        if not (chunk_index == meta.total_chunks - 1 and len(data) <= expected and len(data) > 0):
            raise HTTPException(status_code=400, detail=f"chunk size mismatch {len(data)} != {expected}")
    upload_store.write_chunk(upload_id, chunk_index, data)
    meta.received[str(chunk_index)] = len(data)
    upload_store.update_meta(meta)
    return ORJSONResponse({"ok": True, "idx": chunk_index})


@app.get("/api/upload/{upload_id}/status")
async def upload_status(upload_id: str):
    missing = upload_store.missing_chunks(upload_id)
    return ORJSONResponse({"missing": missing})


@app.post("/api/finish-upload/{upload_id}")
async def finish_upload(upload_id: str, request: Request):
    result = upload_store.assemble(upload_id)
    if "|sha256:" in result:
        final_path, sha = result.split("|sha256:", 1)
    else:
        final_path, sha = result, None
    # Optionally open folder on Windows host
    open_flag = request.query_params.get("open")
    if open_flag and open_flag not in ("0", "false", "False"):
        try:
            if os.name == "nt":
                folder = os.path.dirname(final_path)
                os.startfile(folder)
        except Exception:
            pass
    # Write sidecar checksum file
    if sha and settings.write_sha256_sidecar:
        try:
            sidecar = final_path + ".sha256"
            with open(sidecar, "w", encoding="utf-8") as f:
                f.write(f"{sha}  {os.path.basename(final_path)}\n")
        except Exception:
            pass
    return ORJSONResponse({"saved": final_path, "sha256": sha})


def iter_files_within(base_dir: str):
    for root, dirs, files in os.walk(base_dir):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, base_dir)
            stat = os.stat(full)
            yield {
                "path": rel.replace("\\", "/"),
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
            }


@app.get("/api/list/downloads")
async def list_downloads():
    return ORJSONResponse({"files": list(iter_files_within(settings.downloads_dir))})


@app.get("/api/list/outbox")
async def list_outbox():
    return ORJSONResponse({"files": list(iter_files_within(settings.outbox_dir))})


@app.post("/api/open/downloads")
async def open_downloads_folder():
    try:
        if os.name == "nt":
            os.startfile(settings.downloads_dir)
    except Exception:
        pass
    return ORJSONResponse({"ok": True})


@app.post("/api/open/outbox")
async def open_outbox_folder():
    try:
        if os.name == "nt":
            os.startfile(settings.outbox_dir)
    except Exception:
        pass
    return ORJSONResponse({"ok": True})


@app.get("/healthz")
async def healthz():
    return ORJSONResponse({"ok": True})


@app.get("/dl/outbox/{path:path}")
async def download_outbox(path: str):
    try:
        full = safe_join(settings.outbox_dir, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="bad path")
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(full, filename=os.path.basename(full))


@app.get("/dl/outbox.zip")
async def download_outbox_zip(request: Request):
    # Accept repeated query param 'paths' to include specific files; otherwise include all
    paths = request.query_params.getlist("paths") if hasattr(request.query_params, 'getlist') else []
    files = []
    if paths:
        for p in paths:
            try:
                full = safe_join(settings.outbox_dir, p)
            except ValueError:
                continue
            if os.path.isfile(full):
                files.append((full, p))
    else:
        for f in iter_files_within(settings.outbox_dir):
            files.append((os.path.join(settings.outbox_dir, f["path"].replace("/", os.sep)), f["path"]))
    if not files:
        raise HTTPException(status_code=404, detail="no files")

    # Create a temp zip file then stream and delete after
    tmp_dir = settings.temp_dir
    os.makedirs(tmp_dir, exist_ok=True)
    fd, tmp_zip = tempfile.mkstemp(prefix="outbox_", suffix=".zip", dir=tmp_dir)
    os.close(fd)
    with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for full, arc in files:
            # arc must be posix style
            arcname = arc.replace("\\", "/")
            zf.write(full, arcname)
    filename = f"outbox-{int(time.time())}.zip"
    return FileResponse(tmp_zip, filename=filename, media_type="application/zip", background=BackgroundTask(lambda: os.remove(tmp_zip)))


@app.get("/dl/downloads/{path:path}")
async def download_downloads(path: str):
    try:
        full = safe_join(settings.downloads_dir, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="bad path")
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(full, filename=os.path.basename(full))


@app.get("/dl/downloads.zip")
async def download_downloads_zip(request: Request):
    paths = request.query_params.getlist("paths") if hasattr(request.query_params, 'getlist') else []
    files = []
    if paths:
        for p in paths:
            try:
                full = safe_join(settings.downloads_dir, p)
            except ValueError:
                continue
            if os.path.isfile(full):
                files.append((full, p))
    else:
        for f in iter_files_within(settings.downloads_dir):
            files.append((os.path.join(settings.downloads_dir, f["path"].replace("/", os.sep)), f["path"]))
    if not files:
        raise HTTPException(status_code=404, detail="no files")
    tmp_dir = settings.temp_dir
    os.makedirs(tmp_dir, exist_ok=True)
    fd, tmp_zip = tempfile.mkstemp(prefix="downloads_", suffix=".zip", dir=tmp_dir)
    os.close(fd)
    with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for full, arc in files:
            arcname = arc.replace("\\", "/")
            zf.write(full, arcname)
    filename = f"downloads-{int(time.time())}.zip"
    return FileResponse(tmp_zip, filename=filename, media_type="application/zip", background=BackgroundTask(lambda: os.remove(tmp_zip)))


@app.post("/api/delete")
async def api_delete(payload: dict = Body(...)):
    area = payload.get("area")
    paths = payload.get("paths") or []
    if area not in ("downloads", "outbox"):
        raise HTTPException(status_code=400, detail="invalid area")
    base = settings.downloads_dir if area == "downloads" else settings.outbox_dir
    def _remove_empty_dirs(root: str):
        for r, dnames, fnames in os.walk(root, topdown=False):
            if not dnames and not fnames and r != root:
                try:
                    os.rmdir(r)
                except Exception:
                    pass
    if not paths:
        # delete all files
        for f in list(iter_files_within(base)):
            try:
                os.remove(safe_join(base, f["path"]))
            except Exception:
                pass
        _remove_empty_dirs(base)
        return ORJSONResponse({"ok": True, "cleared": True})
    else:
        deleted = 0
        for p in paths:
            try:
                full = safe_join(base, p)
            except ValueError:
                continue
            try:
                if os.path.isfile(full):
                    os.remove(full)
                    deleted += 1
            except Exception:
                pass
        _remove_empty_dirs(base)
        return ORJSONResponse({"ok": True, "deleted": deleted})


# Simple SSE to notify desktop to open /app after phone scans
sse_clients: Dict[str, asyncio.Queue] = {}


@app.get("/api/sse/{sid}")
async def sse_endpoint(sid: str):
    queue: asyncio.Queue = asyncio.Queue()
    sse_clients[sid] = queue

    async def event_gen():
        try:
            while True:
                msg = await queue.get()
                yield f"data: {msg}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            sse_clients.pop(sid, None)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@app.post("/api/scanned")
async def api_scanned(sid: Optional[str] = None):
    if not sid:
        raise HTTPException(status_code=400, detail="sid required")
    q = sse_clients.get(sid)
    if q:
        await q.put("scanned")
        sse_clients.pop(sid, None)
    return ORJSONResponse({"ok": True})


@app.on_event("startup")
async def on_startup():
    # Schedule periodic cleanup of temp uploads
    import asyncio
    async def cleanup_loop():
        while True:
            try:
                now = time.time()
                base = os.path.join(settings.temp_dir, "uploads")
                if os.path.isdir(base):
                    for sid in os.listdir(base):
                        sp = os.path.join(base, sid)
                        mp = os.path.join(sp, "meta.json")
                        try:
                            mtime = os.path.getmtime(mp)
                        except Exception:
                            mtime = os.path.getmtime(sp)
                        if now - mtime > settings.temp_ttl_seconds:
                            import shutil
                            shutil.rmtree(sp, ignore_errors=True)
            except Exception:
                pass
            await asyncio.sleep(3600)
    import asyncio
    asyncio.create_task(cleanup_loop())
