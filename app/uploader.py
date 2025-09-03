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

    def list_sessions(self) -> List[str]:
        try:
            return [d for d in os.listdir(self.base_dir) if os.path.isdir(os.path.join(self.base_dir, d))]
        except FileNotFoundError:
            return []

    def find_by_fingerprint(self, fingerprint: str) -> Optional[UploadMeta]:
        for sid in self.list_sessions():
            mp = self.meta_path(sid)
            try:
                meta = UploadMeta.from_file(mp)
            except Exception:
                continue
            if meta.fingerprint == fingerprint:
                return meta
        return None

    def init_session(self, meta: UploadMeta) -> None:
        sd = self.session_dir(meta.upload_id)
        os.makedirs(sd, exist_ok=True)
        with open(self.meta_path(meta.upload_id), "w", encoding="utf-8") as f:
            f.write(meta.to_json())

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

    def get_meta(self, upload_id: str) -> UploadMeta:
        mp = self.meta_path(upload_id)
        if not os.path.isfile(mp):
            raise HTTPException(status_code=404, detail="upload not found")
        return UploadMeta.from_file(mp)

    def assemble(self, upload_id: str) -> str:
        meta = self.get_meta(upload_id)
        target_dir = settings.downloads_dir if meta.target == "downloads" else settings.outbox_dir
        os.makedirs(target_dir, exist_ok=True)
        rel = sanitize_rel_path(meta.name)
        final_path = unique_path_nested(target_dir, rel)

        # Append chunks in order
        with open(final_path, "wb") as out:
            for idx in range(meta.total_chunks):
                cp = self.chunk_path(upload_id, idx)
                if not os.path.isfile(cp):
                    raise HTTPException(status_code=400, detail=f"missing chunk {idx}")
                with open(cp, "rb") as cf:
                    shutil.copyfileobj(cf, out, length=1024 * 1024)

        # Cleanup session
        shutil.rmtree(self.session_dir(upload_id), ignore_errors=True)
        return final_path

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
