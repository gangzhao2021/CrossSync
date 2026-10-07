import hashlib
import json
import os
import shutil
import threading
import unicodedata
import uuid
import time
from functools import wraps
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from fastapi import HTTPException

from .config import area_dir, settings
from .utils import safe_join


_path_reservation_lock = threading.Lock()
_reserved_paths: set[str] = set()
_windows_reserved_names = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def session_locked(method):
    @wraps(method)
    def guarded(self, upload_id, *args, **kwargs):
        with self.session_lock(upload_id):
            return method(self, str(upload_id).lower(), *args, **kwargs)
    return guarded


@dataclass
class UploadMeta:
    upload_id: str
    name: str
    size: int
    chunk_size: int
    target: str  # downloads | outbox
    fingerprint: str
    total_chunks: int
    received: Dict[str, int]  # chunk_index -> size (string keys for JSON)
    target_dir: Optional[str] = None

    def destination_dir(self) -> str:
        return self.target_dir or area_dir(self.target)

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @staticmethod
    def from_file(path: str) -> "UploadMeta":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return UploadMeta(**data)


class UploadStore:
    def __init__(self, base_dir: str):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)
        self._locks = [threading.RLock() for _ in range(128)]
        self._active: Dict[str, int] = {}
        self._cancelled: set[str] = set()
        self._activity_lock = threading.RLock()
        self._index_lock = threading.RLock()
        self._fingerprints: Dict[tuple, str] = {}
        self._session_keys: Dict[str, tuple] = {}
        self._unfinished: set[str] = set()
        for sid in self.list_sessions():
            try:
                self._index_meta(self.get_meta(sid))
            except (HTTPException, OSError, ValueError, TypeError):
                continue

    def _index_meta(self, meta: UploadMeta) -> None:
        key = (meta.fingerprint, meta.target)
        completed = self.completion(meta.upload_id)
        with self._index_lock:
            previous = self._session_keys.get(meta.upload_id)
            if previous and self._fingerprints.get(previous) == meta.upload_id:
                self._fingerprints.pop(previous, None)
            self._session_keys[meta.upload_id] = key
            self._fingerprints[key] = meta.upload_id
            if completed:
                self._unfinished.discard(meta.upload_id)
            else:
                self._unfinished.add(meta.upload_id)

    def _forget(self, upload_id: str) -> None:
        with self._index_lock:
            key = self._session_keys.pop(upload_id, None)
            if key and self._fingerprints.get(key) == upload_id:
                self._fingerprints.pop(key, None)
            self._unfinished.discard(upload_id)

    def session_lock(self, upload_id: str):
        self.session_dir(upload_id)  # Validate before using any session state.
        return self._locks[int(upload_id, 16) % len(self._locks)]

    @session_locked
    def begin_activity(self, upload_id: str) -> None:
        self.get_meta(upload_id)
        with self._activity_lock:
            if upload_id in self._cancelled:
                raise HTTPException(status_code=409, detail="upload cancelled")
            self._active[upload_id] = self._active.get(upload_id, 0) + 1
        self.touch(upload_id)

    @session_locked
    def end_activity(self, upload_id: str) -> None:
        with self._activity_lock:
            remaining = self._active.get(upload_id, 1) - 1
            if remaining:
                self._active[upload_id] = remaining
            else:
                self._active.pop(upload_id, None)
                if upload_id in self._cancelled:
                    self._cancelled.discard(upload_id)
                    shutil.rmtree(self.session_dir(upload_id), ignore_errors=True)
                    self._forget(upload_id)

    def touch(self, upload_id: str) -> None:
        os.utime(self.meta_path(upload_id), None)

    def completion(self, upload_id: str) -> Optional[str]:
        try:
            with open(os.path.join(self.session_dir(upload_id), "completed.json"), encoding="utf-8") as f:
                return json.load(f)["result"]
        except FileNotFoundError:
            return None

    def active_sessions(self) -> List[str]:
        with self._index_lock:
            return list(self._unfinished)

    def cleanup_expired(self, now: Optional[float] = None) -> None:
        now = time.time() if now is None else now
        for sid in self.list_sessions():
            try:
                lock = self.session_lock(sid)
                if not lock.acquire(blocking=False):
                    continue
                try:
                    with self._activity_lock:
                        active = self._active.get(sid, 0)
                    activity_path = self.meta_path(sid)
                    if not os.path.exists(activity_path):
                        activity_path = self.session_dir(sid)
                    if not active and now - os.path.getmtime(activity_path) > settings.temp_ttl_seconds:
                        self.remove_session(sid)
                finally:
                    lock.release()
            except (OSError, HTTPException):
                continue

    def session_dir(self, upload_id: str) -> str:
        try:
            normalized = uuid.UUID(upload_id).hex
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(status_code=400, detail="invalid upload id")
        if normalized != str(upload_id).lower():
            raise HTTPException(status_code=400, detail="invalid upload id")
        return safe_join(self.base_dir, normalized)

    def meta_path(self, upload_id: str) -> str:
        return os.path.join(self.session_dir(upload_id), "meta.json")

    def chunk_path(self, upload_id: str, idx: int) -> str:
        return os.path.join(self.session_dir(upload_id), f"{idx:08d}.part")

    def payload_path(self, upload_id: str) -> str:
        return os.path.join(self.session_dir(upload_id), "payload.bin")

    def list_sessions(self) -> List[str]:
        try:
            return [d for d in os.listdir(self.base_dir) if os.path.isdir(os.path.join(self.base_dir, d))]
        except FileNotFoundError:
            return []

    @session_locked
    def remove_session(self, upload_id: str) -> None:
        with self._activity_lock:
            if self._active.get(upload_id, 0):
                self._cancelled.add(upload_id)
                return
        shutil.rmtree(self.session_dir(upload_id), ignore_errors=True)
        self._forget(upload_id)

    def find_by_fingerprint(self, fingerprint: str, target: Optional[str] = None) -> Optional[UploadMeta]:
        with self._index_lock:
            sid = self._fingerprints.get((fingerprint, target)) if target else next(
                (sid for key, sid in self._fingerprints.items() if key[0] == fingerprint), None
            )
        if sid is None:
            return None
        try:
            return self.get_meta(sid)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            self._forget(sid)
            return None

    def reserved_bytes(self) -> int:
        total = 0
        for sid in self.active_sessions():
            try:
                total += max(0, self.get_meta(sid).size)
            except Exception:
                continue
        return total

    def init_session(self, meta: UploadMeta) -> None:
        sd = self.session_dir(meta.upload_id)
        os.makedirs(sd, exist_ok=True)
        try:
            self.update_meta(meta)
            if settings.direct_upload_assembly:
                with open(self.payload_path(meta.upload_id), "wb") as f:
                    f.truncate(meta.size)
        except BaseException:
            self.remove_session(meta.upload_id)
            raise

    def update_meta(self, meta: UploadMeta) -> None:
        with self.session_lock(meta.upload_id):
            path = self.meta_path(meta.upload_id)
            temp = f"{path}.{uuid.uuid4().hex}.tmp"
            with open(temp, "w", encoding="utf-8") as f:
                f.write(meta.to_json())
            os.replace(temp, path)
            self._index_meta(meta)

    def chunk_temp_path(self, upload_id: str, idx: int) -> str:
        return os.path.join(self.session_dir(upload_id), f"{idx:08d}.{uuid.uuid4().hex}.uploading")

    @session_locked
    def commit_streamed_chunk(self, upload_id: str, idx: int, temp_path: str, expected_size: Optional[int] = None, offset: int = 0, direct: bool = False):
        sd = self.session_dir(upload_id)
        if not os.path.isdir(sd):
            raise HTTPException(status_code=404, detail="upload not found")
        with self._activity_lock:
            if upload_id in self._cancelled:
                raise HTTPException(status_code=409, detail="upload cancelled")
        if expected_size is not None and os.path.getsize(temp_path) != expected_size:
            try:
                os.remove(temp_path)
            except Exception:
                pass
            raise HTTPException(status_code=400, detail="chunk size mismatch")
        if self.completion(upload_id) or os.path.isfile(self.chunk_path(upload_id, idx)):
            os.remove(temp_path)
            self.touch(upload_id)
            return
        if direct:
            payload = self.payload_path(upload_id)
            if not os.path.isfile(payload):
                meta = self.get_meta(upload_id)
                with open(payload, "wb") as f:
                    f.truncate(meta.size)
            with open(temp_path, "rb") as src, open(payload, "r+b") as out:
                out.seek(offset)
                shutil.copyfileobj(src, out, length=1024 * 1024)
            with open(self.chunk_path(upload_id, idx), "wb") as marker:
                marker.write(b"ok")
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass
            self.touch(upload_id)
            return
        os.replace(temp_path, self.chunk_path(upload_id, idx))
        self.touch(upload_id)

    def get_meta(self, upload_id: str) -> UploadMeta:
        mp = self.meta_path(upload_id)
        if not os.path.isfile(mp):
            raise HTTPException(status_code=404, detail="upload not found")
        return UploadMeta.from_file(mp)

    @session_locked
    def assemble(self, upload_id: str, compute_sha256: bool = True) -> str:
        meta = self.get_meta(upload_id)
        with self._activity_lock:
            if upload_id in self._cancelled:
                raise HTTPException(status_code=409, detail="upload cancelled")
        completed = self.completion(upload_id)
        if completed:
            final_path = completed.split("|sha256:", 1)[0]
            if not os.path.isfile(final_path) or os.path.getsize(final_path) != meta.size:
                raise HTTPException(status_code=410, detail="completed file is no longer available")
            self.touch(upload_id)
            return completed
        target_dir = meta.destination_dir()
        os.makedirs(target_dir, exist_ok=True)
        chunk_paths = []
        for idx in range(meta.total_chunks):
            cp = self.chunk_path(upload_id, idx)
            if not os.path.isfile(cp):
                raise HTTPException(status_code=400, detail=f"missing chunk {idx}")
            chunk_paths.append(cp)

        final_path = reserve_unique_path_nested(target_dir, meta.name)
        try:
            result = self._assemble_to_path(
                upload_id,
                meta,
                chunk_paths,
                final_path,
                compute_sha256=compute_sha256,
            )
            receipt = os.path.join(self.session_dir(upload_id), "completed.json")
            with open(receipt + ".tmp", "w", encoding="utf-8") as f:
                json.dump({"result": result}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(receipt + ".tmp", receipt)
            with self._index_lock:
                self._unfinished.discard(upload_id)
            self.touch(upload_id)
            for cp in chunk_paths:
                try:
                    os.remove(cp)
                except FileNotFoundError:
                    pass
            return result
        finally:
            release_reserved_path(final_path)

    def _assemble_to_path(
        self,
        upload_id: str,
        meta: UploadMeta,
        chunk_paths: List[str],
        final_path: str,
        *,
        compute_sha256: bool,
    ) -> str:
        sha = None
        payload_path = self.payload_path(upload_id)
        if settings.direct_upload_assembly and not os.path.isfile(payload_path):
            raise HTTPException(status_code=409, detail="upload payload is unavailable")
        if settings.direct_upload_assembly and os.path.isfile(payload_path):
            if os.path.getsize(payload_path) != meta.size:
                raise HTTPException(status_code=400, detail="assembled payload size mismatch")
            if compute_sha256:
                sha256 = hashlib.sha256()
                with open(payload_path, "rb") as f:
                    while True:
                        buf = f.read(1024 * 1024)
                        if not buf:
                            break
                        sha256.update(buf)
                sha = sha256.hexdigest()
            temp_path = f"{final_path}.assembling-{upload_id}.tmp"
            try:
                try:
                    os.replace(payload_path, final_path)
                except OSError:
                    with open(payload_path, "rb") as src, open(temp_path, "wb") as out:
                        shutil.copyfileobj(src, out, length=1024 * 1024)
                    os.replace(temp_path, final_path)
                    try:
                        os.remove(payload_path)
                    except FileNotFoundError:
                        pass
            except Exception:
                try:
                    os.remove(temp_path)
                except FileNotFoundError:
                    pass
                except Exception:
                    pass
                raise
            return final_path + (f"|sha256:{sha}" if sha else "")

        sha256 = hashlib.sha256() if compute_sha256 else None
        temp_path = f"{final_path}.assembling-{upload_id}.tmp"
        try:
            # Assemble into a temp file first so an interrupted or invalid upload
            # never exposes a partial final file in the transfer list.
            with open(temp_path, "wb") as out:
                for cp in chunk_paths:
                    with open(cp, "rb") as cf:
                        while True:
                            buf = cf.read(1024 * 1024)
                            if not buf:
                                break
                            if sha256:
                                sha256.update(buf)
                            out.write(buf)
            if os.path.getsize(temp_path) != meta.size:
                raise HTTPException(status_code=400, detail="assembled payload size mismatch")
            os.replace(temp_path, final_path)
            if sha256:
                sha = sha256.hexdigest()
        except Exception:
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass
            except Exception:
                pass
            raise

        return final_path + (f"|sha256:{sha}" if sha else "")

    @session_locked
    def missing_chunks(self, upload_id: str) -> List[int]:
        meta = self.get_meta(upload_id)
        if self.completion(upload_id):
            return []
        missing = []
        for idx in range(meta.total_chunks):
            if not os.path.isfile(self.chunk_path(upload_id, idx)):
                missing.append(idx)
        return missing


def reserve_unique_path_nested(base_dir: str, rel_path: str) -> str:
    rel = sanitize_rel_path(rel_path)
    base_real = os.path.realpath(os.path.abspath(base_dir))
    full = safe_join(base_real, rel)
    parent = os.path.dirname(full)
    os.makedirs(parent, exist_ok=True)
    name = os.path.basename(full)
    stem, ext = os.path.splitext(name)

    with _path_reservation_lock:
        index = 0
        while True:
            candidate_name = name if index == 0 else f"{stem} ({index}){ext}"
            candidate = safe_join(base_real, os.path.relpath(os.path.join(parent, candidate_name), base_real))
            key = os.path.normcase(os.path.abspath(candidate))
            if not os.path.exists(candidate) and key not in _reserved_paths:
                _reserved_paths.add(key)
                return candidate
            index += 1


def release_reserved_path(path: str) -> None:
    key = os.path.normcase(os.path.abspath(path))
    with _path_reservation_lock:
        _reserved_paths.discard(key)


def sanitize_rel_path(rel_path: str) -> str:
    if not isinstance(rel_path, str):
        raise ValueError("invalid file name")
    rel = unicodedata.normalize("NFKC", rel_path).replace("\\", "/")
    if len(rel) > 1024 or rel.startswith("/"):
        raise ValueError("invalid file name")

    parts = []
    for p in rel.split('/'):
        if p in ('', '.'):
            continue
        if p == '..':
            raise ValueError("parent paths are not allowed")
        if len(p) > 255 or p.endswith((" ", ".")):
            raise ValueError("invalid file name")
        if ':' in p or any(ord(ch) < 32 for ch in p):
            raise ValueError("invalid file name")
        if p.split('.', 1)[0].upper() in _windows_reserved_names:
            raise ValueError("reserved Windows file name")
        if p.lower() == ".crosssync":
            raise ValueError("reserved CrossSync path")
        parts.append(p)
    normalized = '/'.join(parts)
    if not normalized or normalized.lower().endswith(".sha256"):
        raise ValueError("invalid file name")
    return normalized
