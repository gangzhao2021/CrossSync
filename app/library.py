"""File-area routes: list, verify, open, download (single file or streamed ZIP) and delete."""
import asyncio
import os
import time
import zipfile
from typing import Iterable, Iterator, List, Optional, Tuple

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from send2trash import send2trash

from . import transfer_log
from .checksums import (
    checksum_for_file,
    checksum_snapshot,
    delete_checksums,
    normalize_rel_path,
    verify_checksum,
)
from .common import (
    area_rel_path,
    is_hidden_transfer_file,
    is_host_request,
    resolve_area,
    run_io,
)
from .config import area_dir
from .utils import open_folder, safe_join

router = APIRouter()
ZIP_READ_SIZE = 1024 * 1024


def iter_files_within(base_dir: str, area: Optional[str] = None):
    records = checksum_snapshot(area) if area else None
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = [d for d in dirs if d != ".crosssync" and not os.path.islink(os.path.join(root, d))]
        for f in files:
            full = os.path.join(root, f)
            if os.path.islink(full):
                continue
            rel_norm = normalize_rel_path(os.path.relpath(full, base_dir))
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


def list_files(base_dir: str, area: str, limit: int = 0) -> Tuple[List[dict], int]:
    """Newest files first, optionally only the newest `limit`, plus the total count.

    Checksum lookups run only for the files returned, so a large personal
    folder costs one stat per file rather than a full metadata pass.
    """
    files = sorted(iter_files_within(base_dir), key=lambda item: (-item["mtime"], item["path"]))
    total = len(files)
    if limit > 0:
        files = files[:limit]
    records = checksum_snapshot(area)
    for item in files:
        full = os.path.join(base_dir, item["path"].replace("/", os.sep))
        try:
            checksum = checksum_for_file(area, item["path"], full, records)
        except OSError:
            continue
        if checksum:
            item["sha256"] = checksum["sha256"]
            item["checksum_source"] = checksum.get("source")
            item["checksum_fresh"] = bool(checksum.get("matches_file_metadata", True))
    return files, total


class _ChunkSink:
    """Write-only, unseekable target: zipfile then emits data descriptors and never seeks back."""

    def __init__(self) -> None:
        self._chunks: List[bytes] = []

    def write(self, data) -> int:
        self._chunks.append(bytes(data))
        return len(data)

    def flush(self) -> None:
        pass

    def drain(self) -> bytes:
        data = b"".join(self._chunks)
        self._chunks.clear()
        return data


def iter_zip_stream(files: Iterable[Tuple[str, str]]) -> Iterator[bytes]:
    """Yield a ZIP archive while reading the files, without a temporary archive on disk.

    Entries are stored uncompressed: photos and videos do not shrink, and
    deflating them only slowed large downloads down.
    """
    sink = _ChunkSink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
        for full, arcname in files:
            try:
                info = zipfile.ZipInfo.from_file(full, arcname.replace("\\", "/"), strict_timestamps=False)
                source = open(full, "rb")
            except OSError:
                continue  # Removed after the list was built.
            info.compress_type = zipfile.ZIP_STORED
            with source, archive.open(info, "w", force_zip64=True) as entry:
                while True:
                    block = source.read(ZIP_READ_SIZE)
                    if not block:
                        break
                    entry.write(block)
                    data = sink.drain()
                    if data:
                        yield data
            data = sink.drain()
            if data:
                yield data
    data = sink.drain()
    if data:
        yield data


def move_to_trash(path: str) -> None:
    """Send a file to the system trash / Recycle Bin instead of deleting it permanently."""
    send2trash(path)


def remove_empty_parents(paths: Iterable[str], base_dir: str) -> None:
    """Remove folders emptied by a delete, walking up to (never including) base_dir."""
    base = os.path.normcase(os.path.realpath(base_dir))
    for path in sorted(set(paths), key=len, reverse=True):
        parent = os.path.dirname(os.path.realpath(path))
        while os.path.normcase(parent) != base and os.path.normcase(parent).startswith(base + os.sep):
            try:
                os.rmdir(parent)  # Fails, and stops, if the folder still has content.
            except OSError:
                break
            parent = os.path.dirname(parent)


def trash_files(area: str, base: str, full_paths: List[str]) -> Tuple[List[str], List[str]]:
    """Trash files (and legacy .sha256 sidecars); return (removed rel paths, failed rel paths)."""
    removed, failed, gone = [], [], []
    for full in full_paths:
        rel = area_rel_path(full, base)
        try:
            move_to_trash(full)
        except Exception:
            failed.append(rel)
            continue
        removed.append(rel)
        gone.append(full)
        sidecar = f"{full}.sha256"
        if os.path.isfile(sidecar):
            try:
                move_to_trash(sidecar)
            except Exception:
                pass
    if removed:
        delete_checksums(area, removed)
        transfer_log.forget_transfers(gone)
        remove_empty_parents(gone, base)
    return removed, failed


@router.get("/api/list/{area}")
async def list_area(area: str, limit: int = 0):
    base = resolve_area(area)
    limit = max(0, min(limit, 5000))
    files, total = await asyncio.to_thread(list_files, base, area, limit)
    return JSONResponse({"files": files, "total": total, "truncated": total > len(files)})


@router.post("/api/verify")
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


@router.post("/api/open/{area}")
async def open_area_folder(area: str, request: Request):
    base = resolve_area(area)
    if not is_host_request(request):
        raise HTTPException(status_code=403, detail="只能在运行 CrossSync 的电脑上打开目录")
    return JSONResponse({"ok": open_folder(base)})


@router.get("/dl/{area}.zip")
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
                files.append((full, area_rel_path(full, base)))
    else:
        listed = await asyncio.to_thread(lambda: list(iter_files_within(base)))
        files = [(os.path.join(base, f["path"].replace("/", os.sep)), f["path"]) for f in listed]
    if not files:
        raise HTTPException(status_code=404, detail="no files")
    filename = f"{area}-{int(time.time())}.zip"
    return StreamingResponse(
        iter_zip_stream(files),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/dl/{area}/{path:path}")
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


@router.post("/api/delete")
async def api_delete(request: Request, payload: dict = Body(...)):
    """Move files to the trash.

    - ``paths``: the files the user selected in the list.
    - ``clear``: only on the host computer, and only files CrossSync saved that
      are unchanged since. The receive folder may be a personal folder such as
      Pictures, so files that were already there are never touched.
    """
    area = payload.get("area")
    paths = payload.get("paths")
    clear = payload.get("clear") is True
    if area not in ("downloads", "outbox"):
        raise HTTPException(status_code=400, detail="invalid area")
    if not clear and not isinstance(paths, list):
        raise HTTPException(status_code=400, detail="paths are required")
    base = area_dir(area)

    if clear:
        if not is_host_request(request):
            raise HTTPException(status_code=403, detail="只能在运行 CrossSync 的电脑上清空")
        targets = await run_io(transfer_log.owned_files, area, base)
        removed, failed = await run_io(trash_files, area, base, targets)
        return JSONResponse({"ok": not failed, "cleared": True, "deleted": len(removed), "failed": failed})

    targets = []
    for p in paths:
        if not isinstance(p, str) or is_hidden_transfer_file(p):
            continue
        try:
            full = safe_join(base, p)
        except ValueError:
            continue
        if os.path.isfile(full):
            targets.append(full)
    removed, failed = await run_io(trash_files, area, base, targets)
    return JSONResponse({"ok": not failed, "deleted": len(removed), "failed": failed})
