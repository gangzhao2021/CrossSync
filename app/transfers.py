"""Upload routes: resumable chunked uploads and single-request stream uploads."""
import asyncio
import hashlib
import os
import shutil
import threading
import uuid
from contextlib import asynccontextmanager
from typing import Dict, Optional

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from . import transfer_log
from .checksums import record_checksum
from .common import (
    area_rel_path,
    discard_files,
    open_folder_if_requested,
    run_io,
    wants_checksum,
)
from .config import area_dir, settings
from .uploader import (
    AssemblyResult,
    UploadMeta,
    UploadStore,
    release_reserved_path,
    reserve_unique_path_nested,
    sanitize_rel_path,
)
from .utils import file_fingerprint, legacy_file_fingerprint

router = APIRouter()

upload_store = UploadStore(os.path.join(settings.temp_dir, "uploads"))
upload_slots = asyncio.Semaphore(settings.max_server_uploads)
capacity_lock = threading.RLock()
stream_reservations: Dict[str, tuple] = {}


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


def record_saved_file(area: str, rel_path: str, full_path: str, sha: Optional[str]) -> Optional[dict]:
    """Remember a file CrossSync saved, and its checksum when one was computed."""
    try:
        transfer_log.record_transfer(area, full_path)
    except OSError:
        pass
    if not sha:
        return None
    try:
        return record_checksum(area, rel_path, full_path, sha)
    except Exception:
        return None


@router.post("/api/init-upload")
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
        if completed and not completed.is_intact(existing.size):
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


@router.put("/api/upload/{upload_id}/{chunk_index}")
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


@router.get("/api/upload/{upload_id}/status")
async def upload_status(upload_id: str):
    missing = await run_io(upload_store.missing_chunks, upload_id)
    return JSONResponse({"missing": missing})


@router.delete("/api/upload/{upload_id}")
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


@router.post("/api/upload-stream")
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

    compute_checksum = wants_checksum(request, settings.record_upload_checksums)
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

    rel_path = area_rel_path(final_path, target_dir)
    sha = sha256.hexdigest() if sha256 else None
    checksum_info = await run_io(record_saved_file, target, rel_path, final_path, sha)
    open_folder_if_requested(request, final_path)
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


@router.post("/api/finish-upload/{upload_id}")
async def finish_upload(upload_id: str, request: Request):
    async with upload_slots:
        async with upload_activity(upload_id):
            return await _finish_upload(upload_id, request)


async def _finish_upload(upload_id: str, request: Request):
    meta = await run_io(upload_store.get_meta, upload_id)
    compute_checksum = wants_checksum(request, settings.record_upload_checksums)
    result: AssemblyResult = await run_io(upload_store.assemble, upload_id, compute_sha256=compute_checksum)
    rel_path = area_rel_path(result.path, meta.destination_dir())
    checksum_info = await run_io(record_saved_file, meta.target, rel_path, result.path, result.sha256)
    open_folder_if_requested(request, result.path)
    if result.sha256 and settings.write_sha256_sidecar:
        try:
            with open(result.path + ".sha256", "w", encoding="utf-8") as f:
                f.write(f"{result.sha256}  {os.path.basename(result.path)}\n")
        except OSError:
            pass
    return JSONResponse({
        "saved": result.path,
        "path": rel_path,
        "area": meta.target,
        "sha256": result.sha256,
        "checksum": checksum_info,
    })
