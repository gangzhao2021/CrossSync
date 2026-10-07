import asyncio
import hashlib
import io
import ipaddress
import os
import re
import secrets
import shutil
import socket
import tempfile
import threading
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from typing import Dict, Optional
from urllib.parse import urlencode

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask

from .config import area_dir, ensure_dirs, load_env_overrides, set_downloads_dir, settings
from .utils import (
    file_fingerprint,
    folder_picker_available,
    get_lan_ip,
    legacy_file_fingerprint,
    open_folder,
    pick_folder,
    safe_join,
)
from .uploader import (
    UploadStore,
    UploadMeta,
    release_reserved_path,
    reserve_unique_path_nested,
    sanitize_rel_path,
)
from .checksums import (
    checksum_for_file,
    checksum_snapshot,
    delete_checksums,
    normalize_rel_path,
    record_checksum,
    verify_checksum,
)


load_env_overrides()
ensure_dirs()

static_dir = os.path.join(os.path.dirname(__file__), "static")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))


def compute_asset_version() -> str:
    """Fingerprint static assets so templates and the service worker bust caches automatically."""
    digest = hashlib.sha256()
    for root, dirs, names in os.walk(static_dir):
        dirs.sort()
        for name in sorted(names):
            full = os.path.join(root, name)
            stat = os.stat(full)
            digest.update(f"{os.path.relpath(full, static_dir)}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    return digest.hexdigest()[:12]


ASSET_VERSION = compute_asset_version()
templates.env.globals["asset_version"] = ASSET_VERSION

upload_store = UploadStore(os.path.join(settings.temp_dir, "uploads"))
upload_slots = asyncio.Semaphore(settings.max_server_uploads)
capacity_lock = threading.RLock()
stream_reservations: Dict[str, tuple] = {}
# Partially assembled outputs that must never be listed, downloaded or cleared.
PARTIAL_OUTPUT_RE = re.compile(r"\.(?:assembling|streaming)-[a-zA-Z0-9-]+\.tmp$")


@asynccontextmanager
async def lifespan(_: FastAPI):
    async def cleanup_loop():
        while True:
            try:
                await run_io(upload_store.cleanup_expired)
            except Exception:
                pass
            await asyncio.sleep(3600)

    cleanup_task = asyncio.create_task(cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=static_dir), name="static")


def resolve_area(area: str) -> str:
    """Map a transfer area from a URL to its directory, or answer 404."""
    try:
        return area_dir(area)
    except ValueError:
        raise HTTPException(status_code=404, detail="unknown area")


def discard_files(*paths: str) -> None:
    """Best-effort removal of temporary files."""
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass


async def run_io(function, *args, **kwargs):
    # A cancelled HTTP request must not close/delete files a worker still uses.
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


@asynccontextmanager
async def upload_activity(upload_id):
    entering = asyncio.create_task(asyncio.to_thread(upload_store.begin_activity, upload_id))
    try:
        await asyncio.shield(entering)
        yield
    finally:
        try:
            await entering
        except Exception:
            pass
        else:
            await run_io(upload_store.end_activity, upload_id)


def disk_device(path):
    return os.stat(path).st_dev


def check_upload_capacity(size, target_dir, chunk_size=0, *, stream=False):
    """Reserve conservatively per volume, including cross-volume final copies.

    Existing session sizes are intentionally not credited for sparse allocation.
    This can reject early, but never assumes truncate() reserved physical space.
    Call under capacity_lock before creating a session or stream reservation.
    """
    requirements = {}
    directories = {}

    def add(path, amount):
        device = disk_device(path)
        directories[device] = path
        requirements[device] = requirements.get(device, 0) + amount
        return device

    def reserve(file_size, destination, chunk, is_stream):
        temp_device = add(settings.temp_dir, file_size)
        dest_device = disk_device(destination)
        if dest_device != temp_device or (not is_stream and not settings.direct_upload_assembly):
            add(destination, file_size)
        if not is_stream:
            add(settings.temp_dir, min(file_size, chunk * settings.max_server_uploads))

    for sid in upload_store.active_sessions():
        try:
            meta = upload_store.get_meta(sid)
        except HTTPException as exc:
            if exc.status_code == 404:
                continue
            raise
        reserve(meta.size, meta.destination_dir(), meta.chunk_size, False)
    for file_size, destination in stream_reservations.values():
        reserve(file_size, destination, 0, True)
    reserve(size, target_dir, chunk_size, stream)
    for device, amount in requirements.items():
        if amount + settings.min_free_space_reserve > shutil.disk_usage(directories[device]).free:
            raise HTTPException(status_code=507, detail="not enough free disk space for upload and temporary files")

FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#247c6d"/><path fill="#fffefa" d="M18 19h12v6h-6v14h6v6H18V19Zm16 0h12v6h-8v5h7v6h-7v9h-6V19Z"/></svg>"""


def app_url_for_request(request: Request, sid: Optional[str] = None):
    host_ip = get_lan_ip()
    scheme = request.url.scheme or "http"
    port = request.url.port or settings.port
    params = {}
    if settings.access_token:
        params["k"] = settings.access_token
    if sid:
        params["sid"] = sid
    query = f"?{urlencode(params)}" if params else ""
    return host_ip, f"{scheme}://{host_ip}:{port}/app{query}"


@app.middleware("http")
async def access_gate(request: Request, call_next):
    path = request.scope.get("path", "")
    public = (
        path in {"/favicon.ico", "/manifest.webmanifest", "/sw.js", "/ca.crt", "/healthz"}
        or path.startswith("/static/")
    )
    if public or is_host_request(request):
        return await call_next(request)

    authorization = request.headers.get("authorization", "")
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    query_token = request.query_params.get("k", "")
    token = bearer or request.headers.get("x-crosssync-token", "") or request.cookies.get("crosssync_access", "") or query_token
    if token and settings.access_token and secrets.compare_digest(token, settings.access_token):
        if query_token and request.method == "GET" and path == "/app":
            clean_query = urlencode([(key, value) for key, value in request.query_params.multi_items() if key != "k"])
            response = RedirectResponse(str(request.url.replace(query=clean_query)), status_code=303)
        else:
            response = await call_next(request)
        response.set_cookie(
            "crosssync_access",
            settings.access_token,
            httponly=True,
            secure=request.url.scheme == "https",
            samesite="strict",
            max_age=60 * 60 * 24 * 180,
        )
        return response

    await asyncio.sleep(0.15)
    if path.startswith("/api/") or path.startswith("/dl/"):
        return JSONResponse({"detail": "需要 CrossSync 访问令牌"}, status_code=401)
    return HTMLResponse("<h3>需要 CrossSync 访问令牌</h3><p>请从电脑端二维码重新打开。</p>", status_code=401)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # Render index page with QR for LAN URL
    sid = uuid.uuid4().hex
    _, url = app_url_for_request(request, sid)
    ca_available = os.path.isfile(os.path.join(settings.base_dir, "certs", "ca.crt"))
    return templates.TemplateResponse(request, "index.html", {
        "lan_url": url,
        "access_token": settings.access_token,
        "sid": sid,
        "ca_available": ca_available,
        "is_https": request.url.scheme == "https",
    })


@app.get("/favicon.ico")
async def favicon():
    return HTMLResponse(FAVICON_SVG, media_type="image/svg+xml")


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(os.path.join(static_dir, "manifest.webmanifest"), media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker():
    with open(os.path.join(static_dir, "sw.js"), encoding="utf-8") as f:
        script = f.read().replace("__ASSET_VERSION__", ASSET_VERSION)
    return Response(
        script,
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


@app.get("/ca.crt")
async def ca_certificate():
    path = os.path.join(settings.base_dir, "certs", "ca.crt")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="CA certificate has not been generated")
    return FileResponse(path, media_type="application/x-x509-ca-cert", filename="CrossSync-Local-CA.crt")


@app.get("/qr.png")
async def qr_png(request: Request):
    try:
        import qrcode
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"QR deps missing: {e}")
    sid = request.query_params.get('sid')
    _, url = app_url_for_request(request, sid)
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@app.get("/app", response_class=HTMLResponse)
async def app_page(request: Request):
    lan_ip = get_lan_ip()
    return templates.TemplateResponse(request, "app.html", {
        "lan_ip": lan_ip,
        "chunk_size": settings.default_chunk_size,
        "max_concurrency": settings.max_concurrency,
    })


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


def downloads_free_bytes() -> Optional[int]:
    try:
        return shutil.disk_usage(settings.downloads_dir).free
    except OSError:
        return None


@app.get("/api/config")
async def api_config(request: Request):
    host_request = is_host_request(request)
    return JSONResponse({
        "downloads_dir": settings.downloads_dir,
        "downloads_free_bytes": downloads_free_bytes(),
        "outbox_dir": settings.outbox_dir,
        "computer_name": socket.gethostname(),
        "lan_ip": get_lan_ip(),
        "default_chunk_size": settings.default_chunk_size,
        "max_concurrency": settings.max_concurrency,
        "direct_upload_assembly": settings.direct_upload_assembly,
        "record_upload_checksums": settings.record_upload_checksums,
        "is_host_device": host_request,
        "can_choose_downloads_dir": host_request and folder_picker_available(),
        "request_scheme": request.url.scheme,
        "ca_certificate_available": os.path.isfile(os.path.join(settings.base_dir, "certs", "ca.crt")),
    })


@app.post("/api/config/downloads-dir/pick")
def api_pick_downloads_dir(request: Request):
    if not is_host_request(request):
        raise HTTPException(status_code=403, detail="只能在运行 CrossSync 的电脑上选择保存位置")
    if not folder_picker_available():
        raise HTTPException(status_code=501, detail="当前系统没有可用的文件夹选择器")

    try:
        selected = pick_folder(settings.downloads_dir)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"无法打开文件夹选择器：{exc}")
    if not selected:
        return JSONResponse({
            "ok": False,
            "cancelled": True,
            "downloads_dir": settings.downloads_dir,
        })

    try:
        downloads_dir = set_downloads_dir(selected, persist=True)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return JSONResponse({
        "ok": True,
        "cancelled": False,
        "downloads_dir": downloads_dir,
        "downloads_free_bytes": downloads_free_bytes(),
    })


@app.post("/api/init-upload")
async def init_upload(payload: dict = Body(...)):
    return await run_io(initialize_upload, payload)


def initialize_upload(payload):
    with capacity_lock:
        return _initialize_upload(payload)


def _initialize_upload(payload):
    try:
        name = sanitize_rel_path(payload["name"])
        size = int(payload["size"])
        raw_chunk_size = payload.get("chunk_size")
        chunk_size = int(settings.default_chunk_size if raw_chunk_size is None else raw_chunk_size)
        last_modified = payload.get("last_modified")
        target = payload.get("target", "downloads")
        client_id = str(payload.get("client_id") or "")
        resume_key = str(payload.get("resume_key") or "")
        if target not in ("downloads", "outbox"):
            raise ValueError("invalid target")
        if size < 0 or size > settings.max_file_size:
            raise ValueError("invalid size")
        if not settings.min_chunk_size <= chunk_size <= settings.max_chunk_size:
            raise ValueError("invalid chunk size")
        if len(client_id) > 128 or len(resume_key) > 512:
            raise ValueError("invalid resume identity")
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid payload")

    total_chunks = (size + chunk_size - 1) // chunk_size
    if total_chunks > settings.max_chunks_per_file:
        raise HTTPException(status_code=413, detail="too many chunks")
    fingerprint = file_fingerprint(name, size, last_modified, client_id, resume_key)
    # Try find existing unfinished session
    existing = upload_store.find_by_fingerprint(fingerprint, target=target)
    if not existing and resume_key:
        legacy_fingerprint = legacy_file_fingerprint(name, size, last_modified, client_id, resume_key)
        existing = upload_store.find_by_fingerprint(legacy_fingerprint, target=target)
        if existing:
            existing.fingerprint = fingerprint
            upload_store.update_meta(existing)
    if existing:
        resumed = resume_upload(existing.upload_id, chunk_size)
        if resumed is not None:
            return resumed

    if len(upload_store.active_sessions()) >= settings.max_active_uploads:
        raise HTTPException(status_code=503, detail="too many active uploads")
    target_dir = area_dir(target)
    check_upload_capacity(size, target_dir, chunk_size)

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
        target_dir=target_dir,
    )
    upload_store.init_session(meta)
    return JSONResponse({
        "resumed": False,
        "upload_id": upload_id,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "missing": list(range(total_chunks)),
    })


def resume_upload(upload_id, chunk_size):
    with upload_store.session_lock(upload_id):
        try:
            existing = upload_store.get_meta(upload_id)
        except HTTPException as exc:
            if exc.status_code == 404:
                return None
            raise
        completed = upload_store.completion(upload_id)
        if completed:
            final_path = completed.split("|sha256:", 1)[0]
            if not os.path.isfile(final_path) or os.path.getsize(final_path) != existing.size:
                upload_store.remove_session(upload_id)
                return None
        can_resume = bool(completed) or existing.chunk_size == chunk_size
        if settings.direct_upload_assembly and not completed:
            can_resume = can_resume and os.path.isfile(upload_store.payload_path(upload_id))
        if not can_resume:
            upload_store.remove_session(upload_id)
            return None
        upload_store.touch(upload_id)
        return JSONResponse({
            "resumed": True,
            "upload_id": upload_id,
            "chunk_size": existing.chunk_size,
            "total_chunks": existing.total_chunks,
            "missing": upload_store.missing_chunks(upload_id),
        })


async def upload_chunk(upload_id: str, chunk_index: int, request: Request):
    async with upload_slots:
        async with upload_activity(upload_id):
            return await _upload_chunk(upload_id, chunk_index, request)


@app.put("/api/upload/{upload_id}/{chunk_index}")
async def upload_chunk_route(upload_id: str, chunk_index: int, request: Request):
    return await upload_chunk(upload_id, chunk_index, request)


async def _upload_chunk(upload_id: str, chunk_index: int, request: Request):
    meta = await run_io(upload_store.get_meta, upload_id)
    if chunk_index < 0 or chunk_index >= meta.total_chunks:
        raise HTTPException(status_code=400, detail="chunk index out of range")

    # Allow last chunk to be smaller
    expected = meta.chunk_size
    if chunk_index == meta.total_chunks - 1:
        expected = meta.size - meta.chunk_size * (meta.total_chunks - 1)

    hdr = request.headers.get('x-sha256')
    sha256 = hashlib.sha256() if hdr else None

    temp_path = upload_store.chunk_temp_path(upload_id, chunk_index)
    total = 0
    try:
        with open(temp_path, "wb", buffering=0) as f:
            async for block in request.stream():
                if not block:
                    continue
                total += len(block)
                if total > expected:
                    raise HTTPException(status_code=400, detail=f"chunk too large {total} > {expected}")
                if sha256:
                    sha256.update(block)
                await run_io(f.write, block)
        if sha256 and sha256.hexdigest().lower() != hdr.lower():
            raise HTTPException(status_code=400, detail="chunk checksum mismatch")
        if total != expected:
            raise HTTPException(status_code=400, detail=f"chunk size mismatch {total} != {expected}")
    except (asyncio.CancelledError, HTTPException):
        discard_files(temp_path)
        raise
    except Exception as exc:
        discard_files(temp_path)
        raise HTTPException(status_code=499, detail=f"upload interrupted: {exc}")

    try:
        await run_io(
            upload_store.commit_streamed_chunk,
            upload_id,
            chunk_index,
            temp_path,
            expected_size=expected,
            offset=meta.chunk_size * chunk_index,
            direct=settings.direct_upload_assembly,
        )
    finally:
        discard_files(temp_path)
    return JSONResponse({"ok": True, "idx": chunk_index})


@app.get("/api/upload/{upload_id}/status")
async def upload_status(upload_id: str):
    missing = await run_io(upload_store.missing_chunks, upload_id)
    return JSONResponse({"missing": missing})


@app.delete("/api/upload/{upload_id}")
async def cancel_upload(upload_id: str):
    try:
        await run_io(upload_store.get_meta, upload_id)
    except HTTPException as exc:
        if exc.status_code == 404:
            return JSONResponse({"ok": True, "removed": False})
        raise
    await run_io(upload_store.remove_session, upload_id)
    return JSONResponse({"ok": True, "removed": True})


def release_stream_capacity(reservation_id):
    with capacity_lock:
        stream_reservations.pop(reservation_id, None)


def reserve_stream_capacity(reservation_id, size, target_dir):
    with capacity_lock:
        check_upload_capacity(size, target_dir, stream=True)
        stream_reservations[reservation_id] = (size, target_dir)


def publish_stream(temp_path, final_temp_path, final_path):
    try:
        os.replace(temp_path, final_path)
    except OSError:
        with open(temp_path, "rb") as src, open(final_temp_path, "wb") as out:
            shutil.copyfileobj(src, out, length=1024 * 1024)
        os.replace(final_temp_path, final_path)
        os.remove(temp_path)


async def upload_stream(request: Request):
    reservation_id = uuid.uuid4().hex
    async with upload_slots:
        try:
            return await _upload_stream(request, reservation_id)
        finally:
            await run_io(release_stream_capacity, reservation_id)


@app.post("/api/upload-stream")
async def upload_stream_route(request: Request):
    return await upload_stream(request)


async def _upload_stream(request: Request, reservation_id: str):
    name = request.query_params.get("name") or request.headers.get("x-file-name")
    target = request.query_params.get("target", "downloads")
    if not name or target not in ("downloads", "outbox"):
        raise HTTPException(status_code=400, detail="invalid stream upload request")
    try:
        expected_size = int(request.query_params.get("size") or request.headers.get("x-file-size") or "")
    except ValueError:
        raise HTTPException(status_code=400, detail="valid file size is required")
    if expected_size < 0 or expected_size > settings.max_file_size:
        raise HTTPException(status_code=413, detail="file is too large")

    checksum_flag = request.query_params.get("checksum")
    compute_checksum = settings.record_upload_checksums
    if checksum_flag is not None:
        compute_checksum = checksum_flag not in {"0", "false", "False", "no", "off"}

    target_dir = area_dir(target)
    await run_io(reserve_stream_capacity, reservation_id, expected_size, target_dir)
    try:
        rel = sanitize_rel_path(name)
        final_path = reserve_unique_path_nested(target_dir, rel)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    stream_dir = os.path.join(settings.temp_dir, "streams")
    os.makedirs(stream_dir, exist_ok=True)
    temp_path = os.path.join(stream_dir, f"{uuid.uuid4().hex}.uploading")
    final_temp_path = f"{final_path}.streaming-{uuid.uuid4().hex}.tmp"

    sha256 = hashlib.sha256() if compute_checksum else None

    total = 0
    try:
        with open(temp_path, "wb", buffering=0) as out:
            async for block in request.stream():
                if not block:
                    continue
                total += len(block)
                if expected_size >= 0 and total > expected_size:
                    raise HTTPException(status_code=400, detail="stream upload too large")
                if sha256:
                    sha256.update(block)
                await run_io(out.write, block)
        if expected_size >= 0 and total != expected_size:
            raise HTTPException(status_code=400, detail=f"stream size mismatch {total} != {expected_size}")

        await run_io(publish_stream, temp_path, final_temp_path, final_path)
    except (asyncio.CancelledError, HTTPException):
        discard_files(temp_path, final_temp_path)
        release_reserved_path(final_path)
        raise
    except Exception as exc:
        discard_files(temp_path, final_temp_path)
        release_reserved_path(final_path)
        raise HTTPException(status_code=499, detail=f"stream upload interrupted: {exc}")

    rel_path = normalize_rel_path(os.path.relpath(final_path, target_dir))
    sha = sha256.hexdigest() if sha256 else None
    checksum_info = None
    if sha:
        try:
            checksum_info = record_checksum(target, rel_path, final_path, sha)
        except Exception:
            checksum_info = None

    open_flag = request.query_params.get("open")
    if open_flag and open_flag not in ("0", "false", "False") and is_host_request(request):
        try:
            open_folder(os.path.dirname(final_path))
        except Exception:
            pass

    release_reserved_path(final_path)
    return JSONResponse({
        "saved": final_path,
        "path": rel_path,
        "area": target,
        "sha256": sha,
        "checksum": checksum_info,
        "streamed": True,
        "size": total,
    })


@app.post("/api/finish-upload/{upload_id}")
async def finish_upload(upload_id: str, request: Request):
    async with upload_slots:
        async with upload_activity(upload_id):
            return await _finish_upload(upload_id, request)


async def _finish_upload(upload_id: str, request: Request):
    meta = await run_io(upload_store.get_meta, upload_id)
    checksum_flag = request.query_params.get("checksum")
    compute_checksum = settings.record_upload_checksums
    if checksum_flag is not None:
        compute_checksum = checksum_flag not in {"0", "false", "False", "no", "off"}
    result = await run_io(upload_store.assemble, upload_id, compute_sha256=compute_checksum)
    if "|sha256:" in result:
        final_path, sha = result.split("|sha256:", 1)
    else:
        final_path, sha = result, None
    rel_path = normalize_rel_path(os.path.relpath(final_path, meta.destination_dir()))
    checksum_info = None
    if sha:
        try:
            checksum_info = record_checksum(meta.target, rel_path, final_path, sha)
        except Exception:
            checksum_info = None
    # Optionally open folder on Windows host
    open_flag = request.query_params.get("open")
    if open_flag and open_flag not in ("0", "false", "False") and is_host_request(request):
        try:
            open_folder(os.path.dirname(final_path))
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
    return JSONResponse({
        "saved": final_path,
        "path": rel_path,
        "area": meta.target,
        "sha256": sha,
        "checksum": checksum_info,
    })


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


def iter_files_within(base_dir: str, area: Optional[str] = None):
    records = checksum_snapshot() if area else None
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = [d for d in dirs if d != ".crosssync" and not os.path.islink(os.path.join(root, d))]
        for f in files:
            full = os.path.join(root, f)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, base_dir)
            rel_norm = normalize_rel_path(rel)
            if is_hidden_transfer_file(rel_norm):
                continue
            stat = os.stat(full)
            item = {
                "path": rel_norm,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
            }
            if area:
                checksum = checksum_for_file(area, rel_norm, full, records)
                if checksum:
                    item["sha256"] = checksum["sha256"]
                    item["checksum_source"] = checksum.get("source")
                    item["checksum_fresh"] = bool(checksum.get("matches_file_metadata", True))
            yield item


def create_zip_archive(files, prefix: str) -> str:
    os.makedirs(settings.temp_dir, exist_ok=True)
    fd, tmp_zip = tempfile.mkstemp(prefix=prefix, suffix=".zip", dir=settings.temp_dir)
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for full, arc in files:
                zf.write(full, arc.replace("\\", "/"))
        return tmp_zip
    except Exception:
        try:
            os.remove(tmp_zip)
        except OSError:
            pass
        raise


@app.get("/api/list/{area}")
async def list_area(area: str):
    base = resolve_area(area)
    files = await asyncio.to_thread(lambda: list(iter_files_within(base, area)))
    return JSONResponse({"files": files})


@app.post("/api/verify")
async def api_verify(payload: dict = Body(...)):
    area = payload.get("area")
    path = payload.get("path")
    if area not in ("downloads", "outbox") or not path:
        raise HTTPException(status_code=400, detail="invalid payload")
    if is_hidden_transfer_file(path):
        raise HTTPException(status_code=404, detail="not found")
    base = area_dir(area)
    try:
        full = safe_join(base, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="bad path")
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="not found")
    result = await asyncio.to_thread(verify_checksum, area, normalize_rel_path(path), full)
    return JSONResponse(result)


@app.post("/api/open/{area}")
async def open_area_folder(area: str, request: Request):
    base = resolve_area(area)
    if not is_host_request(request):
        raise HTTPException(status_code=403, detail="只能在运行 CrossSync 的电脑上打开目录")
    return JSONResponse({"ok": open_folder(base)})


@app.get("/healthz")
async def healthz():
    return JSONResponse({"ok": True})


@app.get("/dl/{area}.zip")
async def download_area_zip(area: str, request: Request):
    base = resolve_area(area)
    # Repeated 'paths' query params select specific files; otherwise include all.
    paths = request.query_params.getlist("paths")
    files = []
    if paths:
        for p in paths:
            if is_hidden_transfer_file(p):
                continue
            try:
                full = safe_join(base, p)
            except ValueError:
                continue
            if os.path.isfile(full):
                files.append((full, normalize_rel_path(os.path.relpath(full, base))))
    else:
        listed = await asyncio.to_thread(lambda: list(iter_files_within(base, area)))
        files = [(os.path.join(base, f["path"].replace("/", os.sep)), f["path"]) for f in listed]
    if not files:
        raise HTTPException(status_code=404, detail="no files")
    tmp_zip = await asyncio.to_thread(create_zip_archive, files, f"{area}_")
    filename = f"{area}-{int(time.time())}.zip"
    return FileResponse(tmp_zip, filename=filename, media_type="application/zip", background=BackgroundTask(lambda: os.remove(tmp_zip)))


@app.get("/dl/{area}/{path:path}")
async def download_area_file(area: str, path: str):
    base = resolve_area(area)
    if is_hidden_transfer_file(path):
        raise HTTPException(status_code=404, detail="not found")
    try:
        full = safe_join(base, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="bad path")
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(full, filename=os.path.basename(full))


@app.post("/api/delete")
async def api_delete(payload: dict = Body(...)):
    area = payload.get("area")
    paths = payload.get("paths")
    clear = payload.get("clear") is True
    if area not in ("downloads", "outbox"):
        raise HTTPException(status_code=400, detail="invalid area")
    if not clear and not isinstance(paths, list):
        raise HTTPException(status_code=400, detail="paths are required")
    base = area_dir(area)
    def _remove_empty_dirs(root: str):
        for r, dnames, fnames in os.walk(root, topdown=False):
            if not dnames and not fnames and r != root:
                try:
                    os.rmdir(r)
                except Exception:
                    pass
    def _remove_file(path: str) -> bool:
        try:
            if os.path.isfile(path):
                os.remove(path)
                return True
        except Exception:
            pass
        return False
    if clear:
        # Clear everything in the selected area, including hidden legacy sidecars.
        for root, dirs, files in os.walk(base):
            try:
                dirs[:] = [d for d in dirs if d != ".crosssync"]
            except Exception:
                pass
            for name in files:
                if PARTIAL_OUTPUT_RE.search(name):
                    continue
                _remove_file(os.path.join(root, name))
        delete_checksums(area)
        _remove_empty_dirs(base)
        return JSONResponse({"ok": True, "cleared": True})
    else:
        deleted = 0
        removed_paths = []
        for p in paths or []:
            try:
                full = safe_join(base, p)
            except ValueError:
                continue
            if is_hidden_transfer_file(p):
                continue
            if _remove_file(full):
                deleted += 1
                removed_paths.append(normalize_rel_path(p))
                _remove_file(f"{full}.sha256")
        if removed_paths:
            delete_checksums(area, removed_paths)
        _remove_empty_dirs(base)
        return JSONResponse({"ok": True, "deleted": deleted})


# Server-sent events let the QR page open /app once the phone has scanned.
SSE_MAX_CLIENTS = 32
SSE_TTL_SECONDS = 10 * 60
SSE_KEEPALIVE_SECONDS = 25
SID_RE = re.compile(r"^[0-9a-f]{32}$")
sse_clients: Dict[str, asyncio.Queue] = {}


@app.get("/api/sse/{sid}")
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


@app.post("/api/scanned")
async def api_scanned(sid: Optional[str] = None):
    if not sid:
        raise HTTPException(status_code=400, detail="sid required")
    q = sse_clients.get(sid)
    if q:
        await q.put("scanned")
        sse_clients.pop(sid, None)
    return JSONResponse({"ok": True})
