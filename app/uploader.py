import os
import json
import shutil
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from fastapi import HTTPException

from .config import settings
from .utils import safe_join


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

    def session_dir(self, upload_id: str) -> str:
        return os.path.join(self.base_dir, upload_id)

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

    def remove_session(self, upload_id: str) -> None:
        shutil.rmtree(self.session_dir(upload_id), ignore_errors=True)

    def find_by_fingerprint(self, fingerprint: str, target: Optional[str] = None) -> Optional[UploadMeta]:
        for sid in self.list_sessions():
            mp = self.meta_path(sid)
            try:
                meta = UploadMeta.from_file(mp)
            except Exception:
                continue
            if meta.fingerprint == fingerprint and (target is None or meta.target == target):
                return meta
        return None

    def init_session(self, meta: UploadMeta) -> None:
        sd = self.session_dir(meta.upload_id)
        os.makedirs(sd, exist_ok=True)
        with open(self.meta_path(meta.upload_id), "w", encoding="utf-8") as f:
            f.write(meta.to_json())
        if settings.direct_upload_assembly:
            with open(self.payload_path(meta.upload_id), "wb") as f:
                f.truncate(meta.size)

    def update_meta(self, meta: UploadMeta) -> None:
        with open(self.meta_path(meta.upload_id), "w", encoding="utf-8") as f:
            f.write(meta.to_json())

    def write_chunk(self, upload_id: str, idx: int, data: bytes, expected_size: Optional[int] = None):
        sd = self.session_dir(upload_id)
        if not os.path.isdir(sd):
            raise HTTPException(status_code=404, detail="upload not found")
        cp = self.chunk_path(upload_id, idx)
        with open(cp, "wb") as f:
            f.write(data)
        if expected_size is not None and os.path.getsize(cp) != expected_size:
            raise HTTPException(status_code=400, detail="chunk size mismatch")

    def chunk_temp_path(self, upload_id: str, idx: int) -> str:
        return os.path.join(self.session_dir(upload_id), f"{idx:08d}.uploading")

    def commit_streamed_chunk(self, upload_id: str, idx: int, temp_path: str, expected_size: Optional[int] = None, offset: int = 0, direct: bool = False):
        sd = self.session_dir(upload_id)
        if not os.path.isdir(sd):
            raise HTTPException(status_code=404, detail="upload not found")
        if expected_size is not None and os.path.getsize(temp_path) != expected_size:
            try:
                os.remove(temp_path)
            except Exception:
                pass
            raise HTTPException(status_code=400, detail="chunk size mismatch")
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
            return
        os.replace(temp_path, self.chunk_path(upload_id, idx))

    def get_meta(self, upload_id: str) -> UploadMeta:
        mp = self.meta_path(upload_id)
        if not os.path.isfile(mp):
            raise HTTPException(status_code=404, detail="upload not found")
        return UploadMeta.from_file(mp)

    def assemble(self, upload_id: str, compute_sha256: bool = True) -> str:
        meta = self.get_meta(upload_id)
        target_dir = settings.downloads_dir if meta.target == "downloads" else settings.outbox_dir
        os.makedirs(target_dir, exist_ok=True)
        rel = sanitize_rel_path(meta.name)
        final_path = unique_path_nested(target_dir, rel)
        chunk_paths = []
        for idx in range(meta.total_chunks):
            cp = self.chunk_path(upload_id, idx)
            if not os.path.isfile(cp):
                raise HTTPException(status_code=400, detail=f"missing chunk {idx}")
            chunk_paths.append(cp)

        import hashlib
        sha = None
        payload_path = self.payload_path(upload_id)
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
            shutil.rmtree(self.session_dir(upload_id), ignore_errors=True)
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

        # Cleanup session
        shutil.rmtree(self.session_dir(upload_id), ignore_errors=True)
        return final_path + (f"|sha256:{sha}" if sha else "")

    def missing_chunks(self, upload_id: str) -> List[int]:
        meta = self.get_meta(upload_id)
        missing = []
        for idx in range(meta.total_chunks):
            if not os.path.isfile(self.chunk_path(upload_id, idx)):
                missing.append(idx)
        return missing


def unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    i = 1
    while True:
        candidate = f"{base} ({i}){ext}"
        if not os.path.exists(candidate):
            return candidate
        i += 1


def unique_path_nested(base_dir: str, rel_path: str) -> str:
    # Preserve directory structure under base_dir while unique-ifying the file name.
    rel_path = sanitize_rel_path(rel_path)
    full = safe_join(base_dir, rel_path)
    parent = os.path.dirname(full)
    os.makedirs(parent, exist_ok=True)
    if not os.path.exists(full):
        return full
    name = os.path.basename(full)
    base, ext = os.path.splitext(name)
    i = 1
    while True:
        candidate = os.path.join(parent, f"{base} ({i}){ext}")
        if not os.path.exists(candidate):
            return candidate
        i += 1


def sanitize_rel_path(rel_path: str) -> str:
    rel = rel_path.replace("\\", "/")
    # remove leading slashes
    while rel.startswith('/'):
        rel = rel[1:]
    # remove parent traversal
    parts = []
    for p in rel.split('/'):
        if p in ('', '.'):
            continue
        if p == '..':
            if parts:
                parts.pop()
            continue
        parts.append(p)
    return '/'.join(parts)
