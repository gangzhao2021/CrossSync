"""CrossSync FastAPI application: pages, access control, runtime config and route wiring.

Route modules:
- transfers: chunked and stream uploads
- library: listing, verification, downloads and deletes for the two file areas
- pairing: the QR page's scan notification
"""
import asyncio
import hashlib
import io
import os
import secrets
import shutil
import socket
import uuid
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import ensure_dirs, load_env_overrides, set_downloads_dir, settings

load_env_overrides()
ensure_dirs()

from . import library, pairing, transfer_log, transfers  # noqa: E402  (need settings loaded first)
from .common import is_host_request, run_io  # noqa: E402
from .utils import folder_picker_available, get_lan_ip, pick_folder  # noqa: E402

static_dir = os.path.join(os.path.dirname(__file__), "static")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))
FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#247c6d"/><path fill="#fffefa" d="M18 19h12v6h-6v14h6v6H18V19Zm16 0h12v6h-8v5h7v6h-7v9h-6V19Z"/></svg>"""
PUBLIC_PATHS = {"/favicon.ico", "/manifest.webmanifest", "/sw.js", "/ca.crt", "/healthz"}


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


@asynccontextmanager
async def lifespan(_: FastAPI):
    async def cleanup_loop():
        while True:
            try:
                await run_io(transfers.upload_store.cleanup_expired)
                await run_io(transfer_log.prune_missing)
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
app.include_router(transfers.router)
app.include_router(library.router)
app.include_router(pairing.router)


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
    if path in PUBLIC_PATHS or path.startswith("/static/") or is_host_request(request):
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
    sid = uuid.uuid4().hex
    _, url = app_url_for_request(request, sid)
    return templates.TemplateResponse(request, "index.html", {
        "lan_url": url,
        "access_token": settings.access_token,
        "sid": sid,
        "ca_available": ca_certificate_available(),
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


def ca_certificate_path() -> str:
    return os.path.join(settings.base_dir, "certs", "ca.crt")


def ca_certificate_available() -> bool:
    return os.path.isfile(ca_certificate_path())


@app.get("/ca.crt")
async def ca_certificate():
    if not ca_certificate_available():
        raise HTTPException(status_code=404, detail="CA certificate has not been generated")
    return FileResponse(ca_certificate_path(), media_type="application/x-x509-ca-cert", filename="CrossSync-Local-CA.crt")


@app.get("/qr.png")
async def qr_png(request: Request):
    import qrcode

    _, url = app_url_for_request(request, request.query_params.get("sid"))
    buf = io.BytesIO()
    qrcode.make(url).save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@app.get("/app", response_class=HTMLResponse)
async def app_page(request: Request):
    return templates.TemplateResponse(request, "app.html", {
        "lan_ip": get_lan_ip(),
        "chunk_size": settings.default_chunk_size,
        "max_concurrency": settings.max_concurrency,
    })


@app.get("/healthz")
async def healthz():
    return JSONResponse({"ok": True})


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
        "ca_certificate_available": ca_certificate_available(),
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
