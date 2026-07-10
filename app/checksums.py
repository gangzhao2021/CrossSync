import hashlib
import json
import os
import threading
import time
from typing import Dict, List, Optional

from .config import settings


CHECKSUM_FILE = "checksums.json"
_store_lock = threading.RLock()


def normalize_rel_path(path: str) -> str:
    return path.replace("\\", "/").strip("/")


def _store_path() -> str:
    return os.path.join(settings.metadata_dir, CHECKSUM_FILE)


def _checksum_key(area: str, rel_path: str) -> str:
    return f"{area}:{normalize_rel_path(rel_path)}"


def _read_store() -> Dict[str, dict]:
    try:
        with open(_store_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_store(data: Dict[str, dict]) -> None:
    os.makedirs(settings.metadata_dir, exist_ok=True)
    path = _store_path()
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp_path, path)


def _file_stat(full_path: str) -> dict:
    stat = os.stat(full_path)
    return {"size": stat.st_size, "mtime": int(stat.st_mtime)}


def is_sha256(value: str) -> bool:
    value = value.strip().lower()
    return len(value) == 64 and all(ch in "0123456789abcdef" for ch in value)


def sha256_file(full_path: str) -> str:
    h = hashlib.sha256()
    with open(full_path, "rb") as f:
        while True:
            block = f.read(1024 * 1024)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def checksum_snapshot() -> Dict[str, dict]:
    with _store_lock:
        return dict(_read_store())


def record_checksum(area: str, rel_path: str, full_path: str, sha256: str) -> dict:
    rel = normalize_rel_path(rel_path)
    stat = _file_stat(full_path)
    record = {
        "area": area,
        "path": rel,
        "sha256": sha256.lower(),
        "size": stat["size"],
        "mtime": stat["mtime"],
        "saved_at": int(time.time()),
        "source": "manifest",
    }
    with _store_lock:
        data = _read_store()
        data[_checksum_key(area, rel)] = record
        _write_store(data)
    return record


def delete_checksums(area: str, paths: Optional[List[str]] = None) -> None:
    with _store_lock:
        data = _read_store()
        if not data:
            return

        if paths is None:
            prefix = f"{area}:"
            data = {key: value for key, value in data.items() if not key.startswith(prefix)}
        else:
            for path in paths:
                data.pop(_checksum_key(area, path), None)
        _write_store(data)


def _legacy_sidecar_checksum(area: str, rel_path: str, full_path: str) -> Optional[dict]:
    sidecar = f"{full_path}.sha256"
    if not os.path.isfile(sidecar):
        return None
    try:
        with open(sidecar, "r", encoding="utf-8") as f:
            token = f.readline().strip().split()[0].lower()
    except Exception:
        return None
    if not is_sha256(token):
        return None

    stat = _file_stat(full_path)
    return {
        "area": area,
        "path": normalize_rel_path(rel_path),
        "sha256": token,
        "size": stat["size"],
        "mtime": stat["mtime"],
        "saved_at": int(os.path.getmtime(sidecar)),
        "source": "sidecar",
        "matches_file_metadata": True,
    }


def checksum_for_file(
    area: str,
    rel_path: str,
    full_path: str,
    records: Optional[Dict[str, dict]] = None,
) -> Optional[dict]:
    rel = normalize_rel_path(rel_path)
    stat = _file_stat(full_path)
    record = (records if records is not None else checksum_snapshot()).get(_checksum_key(area, rel))
    if isinstance(record, dict) and is_sha256(str(record.get("sha256", ""))):
        out = dict(record)
        out["source"] = out.get("source") or "manifest"
        try:
            stored_size = int(out.get("size", -1))
            stored_mtime = int(out.get("mtime", -1))
        except (TypeError, ValueError):
            stored_size = -1
            stored_mtime = -1
        out["matches_file_metadata"] = stored_size == stat["size"] and stored_mtime == stat["mtime"]
        return out
    return _legacy_sidecar_checksum(area, rel, full_path)


def verify_checksum(area: str, rel_path: str, full_path: str) -> dict:
    expected = checksum_for_file(area, rel_path, full_path)
    actual = sha256_file(full_path)
    if not expected:
        record = record_checksum(area, rel_path, full_path, actual)
        return {
            "ok": True,
            "status": "recorded",
            "sha256": actual,
            "checksum": record,
        }

    if actual.lower() == expected["sha256"].lower():
        record = record_checksum(area, rel_path, full_path, actual)
        return {
            "ok": True,
            "status": "matched",
            "sha256": actual,
            "source": expected.get("source"),
            "checksum": record,
        }

    return {
        "ok": False,
        "status": "mismatch",
        "expected": expected["sha256"],
        "actual": actual,
        "source": expected.get("source"),
    }
