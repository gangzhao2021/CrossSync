"""Record of files CrossSync itself saved, so "clear" never touches anything else.

Entries are keyed by the resolved absolute path and remember size and mtime.
A file is only treated as CrossSync's own while both still match, so a file
the user later replaced or edited under the same name is left alone.
"""
import json
import os
import threading
from typing import Dict, Iterable, List

from .config import settings

TRANSFER_LOG_FILE = "transfers.json"
_lock = threading.RLock()


def _log_path() -> str:
    return os.path.join(settings.metadata_dir, TRANSFER_LOG_FILE)


def _key(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def _read() -> Dict[str, dict]:
    try:
        with open(_log_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write(data: Dict[str, dict]) -> None:
    os.makedirs(settings.metadata_dir, exist_ok=True)
    temp = f"{_log_path()}.tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(temp, _log_path())


def record_transfer(area: str, full_path: str) -> None:
    stat = os.stat(full_path)
    with _lock:
        data = _read()
        data[_key(full_path)] = {
            "area": area,
            "path": os.path.realpath(full_path),
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }
        _write(data)


def owned_files(area: str, base_dir: str) -> List[str]:
    """Existing files under base_dir that CrossSync saved for this area and that are unchanged."""
    base_key = _key(base_dir)
    owned = []
    with _lock:
        for key, entry in _read().items():
            if entry.get("area") != area:
                continue
            try:
                inside = os.path.commonpath([key, base_key]) == base_key
            except ValueError:
                inside = False
            if not inside:
                continue
            path = entry.get("path", "")
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if stat.st_size == entry.get("size") and stat.st_mtime_ns == entry.get("mtime_ns"):
                owned.append(path)
    return owned


def forget_transfers(paths: Iterable[str]) -> None:
    keys = {_key(path) for path in paths}
    if not keys:
        return
    with _lock:
        data = _read()
        remaining = {key: value for key, value in data.items() if key not in keys}
        if len(remaining) != len(data):
            _write(remaining)


def prune_missing() -> None:
    """Drop entries whose files no longer exist."""
    with _lock:
        data = _read()
        remaining = {key: value for key, value in data.items() if os.path.exists(value.get("path", ""))}
        if len(remaining) != len(data):
            _write(remaining)
