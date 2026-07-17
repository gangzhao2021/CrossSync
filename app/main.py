import os
import io
import time
import uuid
import asyncio
import shutil
import ipaddress
import socket
import secrets
from typing import List, Optional, Dict

from fastapi import FastAPI, Request, HTTPException
from fastapi import Body
from fastapi.responses import HTMLResponse, FileResponse, ORJSONResponse, RedirectResponse, StreamingResponse
from starlette.background import BackgroundTask
import tempfile
import zipfile
from urllib.parse import urlencode
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import settings, ensure_dirs, load_env_overrides, set_downloads_dir
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
app = FastAPI(title=settings.app_name)

static_dir = os.path.join(os.path.dirname(__file__), "static")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

app.mount("/static", StaticFiles(directory=static_dir), name="static")

upload_store = UploadStore(os.path.join(settings.temp_dir, "uploads"))
upload_slots = asyncio.Semaphore(settings.max_server_uploads)

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
        return ORJSONResponse({"detail": "需要 CrossSync 访问令牌"}, status_code=401)
    return HTMLResponse("<h3>需要 CrossSync 访问令牌</h3><p>请从电脑端二维码重新打开。</p>", status_code=401)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # Render index page with QR for LAN URL
    sid = uuid.uuid4().hex
    _, url = app_url_for_request(request, sid)
    ca_available = os.path.isfile(os.path.join(settings.base_dir, "certs", "ca.crt"))
    return templates.TemplateResponse("index.html", {
        "request": request,
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
    return FileResponse(
        os.path.join(static_dir, "sw.js"),
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
        from PIL import Image
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
    return templates.TemplateResponse("app.html", {"request": request, "lan_ip": lan_ip, "chunk_size": settings.default_chunk_size, "max_concurrency": settings.max_concurrency})


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
    return ORJSONResponse({
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
        return ORJSONResponse({
            "ok": False,
            "cancelled": True,
            "downloads_dir": settings.downloads_dir,
        })

    try:
        downloads_dir = set_downloads_dir(selected, persist=True)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ORJSONResponse({
        "ok": True,
        "cancelled": False,
        "downloads_dir": downloads_dir,
        "downloads_free_bytes": downloads_free_bytes(),
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
        can_resume = existing.chunk_size == chunk_size
        if settings.direct_upload_assembly:
            can_resume = can_resume and os.path.isfile(upload_store.payload_path(existing.upload_id))
        if can_resume:
            missing = upload_store.missing_chunks(existing.upload_id)
            return ORJSONResponse({
                "resumed": True,
                "upload_id": existing.upload_id,
                "chunk_size": existing.chunk_size,
                "total_chunks": existing.total_chunks,
                "missing": missing,
            })
        upload_store.remove_session(existing.upload_id)

    if len(upload_store.list_sessions()) >= settings.max_active_uploads:
        raise HTTPException(status_code=503, detail="too many active uploads")
    target_dir = settings.downloads_dir if target == "downloads" else settings.outbox_dir
    try:
        free = shutil.disk_usage(target_dir).free
    except OSError:
        free = None
    reserved = upload_store.reserved_bytes()
    if free is not None and size + reserved + settings.min_free_space_reserve > free:
        raise HTTPException(status_code=507, detail="not enough free disk space")

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


async def upload_chunk(upload_id: str, chunk_index: int, request: Request):
    async with upload_slots:
        return await _upload_chunk(upload_id, chunk_index, request)


@app.put("/api/upload/{upload_id}/{chunk_index}")
async def upload_chunk_route(upload_id: str, chunk_index: int, request: Request):
    return await upload_chunk(upload_id, chunk_index, request)


async def _upload_chunk(upload_id: str, chunk_index: int, request: Request):
    meta = upload_store.get_meta(upload_id)
    if chunk_index < 0 or chunk_index >= meta.total_chunks:
        raise HTTPException(status_code=400, detail="chunk index out of range")

    # Allow last chunk to be smaller
    expected = meta.chunk_size
    if chunk_index == meta.total_chunks - 1:
        expected = meta.size - meta.chunk_size * (meta.total_chunks - 1)

    hdr = request.headers.get('x-sha256')
    sha256 = None
    if hdr:
        import hashlib
        sha256 = hashlib.sha256()

    temp_path = upload_store.chunk_temp_path(upload_id, chunk_index)
    total = 0
    try:
        with open(temp_path, "wb") as f:
            async for block in request.stream():
                if not block:
                    continue
                total += len(block)
                if total > expected:
                    raise HTTPException(status_code=400, detail=f"chunk too large {total} > {expected}")
                if sha256:
                    sha256.update(block)
                f.write(block)
    except asyncio.CancelledError:
        try:
            os.remove(temp_path)
        except Exception:
            pass
        raise
    except HTTPException:
        try:
            os.remove(temp_path)
        except Exception:
            pass
        raise
    except Exception as exc:
        try:
            os.remove(temp_path)
        except Exception:
            pass
        raise HTTPException(status_code=499, detail=f"upload interrupted: {exc}")

    if sha256 and sha256.hexdigest().lower() != hdr.lower():
        try:
            os.remove(temp_path)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail="chunk checksum mismatch")

    if total != expected:
        try:
            os.remove(temp_path)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=f"chunk size mismatch {total} != {expected}")

    upload_store.commit_streamed_chunk(
        upload_id,
        chunk_index,
        temp_path,
        offset=meta.chunk_size * chunk_index,
        direct=settings.direct_upload_assembly,
    )
    return ORJSONResponse({"ok": True, "idx": chunk_index})


@app.get("/api/upload/{upload_id}/status")
async def upload_status(upload_id: str):
    missing = upload_store.missing_chunks(upload_id)
    return ORJSONResponse({"missing": missing})


@app.delete("/api/upload/{upload_id}")
async def cancel_upload(upload_id: str):
    try:
        upload_store.get_meta(upload_id)
    except HTTPException as exc:
        if exc.status_code == 404:
            return ORJSONResponse({"ok": True, "removed": False})
        raise
    upload_store.remove_session(upload_id)
    return ORJSONResponse({"ok": True, "removed": True})


async def upload_stream(request: Request):
    async with upload_slots:
        return await _upload_stream(request)


@app.post("/api/upload-stream")
async def upload_stream_route(request: Request):
    return await upload_stream(request)


async def _upload_stream(request: Request):
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

    target_dir = settings.downloads_dir if target == "downloads" else settings.outbox_dir
    try:
        free = shutil.disk_usage(target_dir).free
    except OSError:
        free = None
    if free is not None and expected_size + settings.min_free_space_reserve > free:
        raise HTTPException(status_code=507, detail="not enough free disk space")
    try:
        rel = sanitize_rel_path(name)
        final_path = reserve_unique_path_nested(target_dir, rel)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    stream_dir = os.path.join(settings.temp_dir, "streams")
    os.makedirs(stream_dir, exist_ok=True)
    temp_path = os.path.join(stream_dir, f"{uuid.uuid4().hex}.uploading")
    final_temp_path = f"{final_path}.streaming-{uuid.uuid4().hex}.tmp"

    sha256 = None
    if compute_checksum:
        import hashlib
        sha256 = hashlib.sha256()

    total = 0
    try:
        with open(temp_path, "wb") as out:
            async for block in request.stream():
                if not block:
                    continue
                total += len(block)
                if expected_size >= 0 and total > expected_size:
                    raise HTTPException(status_code=400, detail="stream upload too large")
                if sha256:
                    sha256.update(block)
                out.write(block)
        if expected_size >= 0 and total != expected_size:
            raise HTTPException(status_code=400, detail=f"stream size mismatch {total} != {expected_size}")

        try:
            os.replace(temp_path, final_path)
        except OSError:
            with open(temp_path, "rb") as src, open(final_temp_path, "wb") as out:
                shutil.copyfileobj(src, out, length=1024 * 1024)
            os.replace(final_temp_path, final_path)
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass
    except asyncio.CancelledError:
        for path in (temp_path, final_temp_path):
            try:
                os.remove(path)
            except Exception:
                pass
        release_reserved_path(final_path)
        raise
    except HTTPException:
        for path in (temp_path, final_temp_path):
            try:
                os.remove(path)
            except Exception:
                pass
        release_reserved_path(final_path)
        raise
    except Exception as exc:
        for path in (temp_path, final_temp_path):
            try:
                os.remove(path)
            except Exception:
                pass
        release_reserved_path(final_path)
        raise HTTPException(status_code=499, detail=f"stream upload interrupted: {exc}")

    base_dir = settings.downloads_dir if target == "downloads" else settings.outbox_dir
    rel_path = normalize_rel_path(os.path.relpath(final_path, base_dir))
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
    return ORJSONResponse({
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
    meta = upload_store.get_meta(upload_id)
    checksum_flag = request.query_params.get("checksum")
    compute_checksum = settings.record_upload_checksums
    if checksum_flag is not None:
        compute_checksum = checksum_flag not in {"0", "false", "False", "no", "off"}
    async with upload_slots:
        result = await asyncio.to_thread(upload_store.assemble, upload_id, compute_sha256=compute_checksum)
    if "|sha256:" in result:
        final_path, sha = result.split("|sha256:", 1)
    else:
        final_path, sha = result, None
    base_dir = settings.downloads_dir if meta.target == "downloads" else settings.outbox_dir
    rel_path = normalize_rel_path(os.path.relpath(final_path, base_dir))
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
    return ORJSONResponse({
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
        ".crosssync" in parts
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


@app.get("/api/list/downloads")
async def list_downloads():
    files = await asyncio.to_thread(lambda: list(iter_files_within(settings.downloads_dir, "downloads")))
    return ORJSONResponse({"files": files})


@app.get("/api/list/outbox")
async def list_outbox():
    files = await asyncio.to_thread(lambda: list(iter_files_within(settings.outbox_dir, "outbox")))
    return ORJSONResponse({"files": files})


@app.post("/api/verify")
async def api_verify(payload: dict = Body(...)):
    area = payload.get("area")
    path = payload.get("path")
    if area not in ("downloads", "outbox") or not path:
        raise HTTPException(status_code=400, detail="invalid payload")
    if is_hidden_transfer_file(path):
        raise HTTPException(status_code=404, detail="not found")
    base = settings.downloads_dir if area == "downloads" else settings.outbox_dir
    try:
        full = safe_join(base, path)
    except ValueError:
        raise HTTPException(status_code=403, detail="bad path")
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="not found")
    result = await asyncio.to_thread(verify_checksum, area, normalize_rel_path(path), full)
    return ORJSONResponse(result)


@app.post("/api/open/downloads")
async def open_downloads_folder(request: Request):
    if not is_host_request(request):
        raise HTTPException(status_code=403, detail="只能在运行 CrossSync 的电脑上打开目录")
    return ORJSONResponse({"ok": open_folder(settings.downloads_dir)})


@app.post("/api/open/outbox")
async def open_outbox_folder(request: Request):
    if not is_host_request(request):
        raise HTTPException(status_code=403, detail="只能在运行 CrossSync 的电脑上打开目录")
    return ORJSONResponse({"ok": open_folder(settings.outbox_dir)})


@app.get("/healthz")
async def healthz():
    return ORJSONResponse({"ok": True})


@app.get("/dl/outbox/{path:path}")
async def download_outbox(path: str):
    if is_hidden_transfer_file(path):
        raise HTTPException(status_code=404, detail="not found")
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
            if is_hidden_transfer_file(p):
                continue
            try:
                full = safe_join(settings.outbox_dir, p)
            except ValueError:
                continue
            if os.path.isfile(full):
                files.append((full, normalize_rel_path(os.path.relpath(full, settings.outbox_dir))))
    else:
        listed = await asyncio.to_thread(lambda: list(iter_files_within(settings.outbox_dir, "outbox")))
        files = [(os.path.join(settings.outbox_dir, f["path"].replace("/", os.sep)), f["path"]) for f in listed]
    if not files:
        raise HTTPException(status_code=404, detail="no files")

    tmp_zip = await asyncio.to_thread(create_zip_archive, files, "outbox_")
    filename = f"outbox-{int(time.time())}.zip"
    return FileResponse(tmp_zip, filename=filename, media_type="application/zip", background=BackgroundTask(lambda: os.remove(tmp_zip)))


@app.get("/dl/downloads/{path:path}")
async def download_downloads(path: str):
    if is_hidden_transfer_file(path):
        raise HTTPException(status_code=404, detail="not found")
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
            if is_hidden_transfer_file(p):
                continue
            try:
                full = safe_join(settings.downloads_dir, p)
            except ValueError:
                continue
            if os.path.isfile(full):
                files.append((full, normalize_rel_path(os.path.relpath(full, settings.downloads_dir))))
    else:
        listed = await asyncio.to_thread(lambda: list(iter_files_within(settings.downloads_dir, "downloads")))
        files = [(os.path.join(settings.downloads_dir, f["path"].replace("/", os.sep)), f["path"]) for f in listed]
    if not files:
        raise HTTPException(status_code=404, detail="no files")
    tmp_zip = await asyncio.to_thread(create_zip_archive, files, "downloads_")
    filename = f"downloads-{int(time.time())}.zip"
    return FileResponse(tmp_zip, filename=filename, media_type="application/zip", background=BackgroundTask(lambda: os.remove(tmp_zip)))


@app.post("/api/delete")
async def api_delete(payload: dict = Body(...)):
    area = payload.get("area")
    paths = payload.get("paths")
    clear = payload.get("clear") is True
    if area not in ("downloads", "outbox"):
        raise HTTPException(status_code=400, detail="invalid area")
    if not clear and not isinstance(paths, list):
        raise HTTPException(status_code=400, detail="paths are required")
    base = settings.downloads_dir if area == "downloads" else settings.outbox_dir
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
                _remove_file(os.path.join(root, name))
        delete_checksums(area)
        _remove_empty_dirs(base)
        return ORJSONResponse({"ok": True, "cleared": True})
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
