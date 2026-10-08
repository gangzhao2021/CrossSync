"""Record of files CrossSync itself saved, so "clear" never touches anything else.

Entries are keyed by the resolved absolute path and remember size and mtime.
A file is only treated as CrossSync's own while both still match, so a file
the user later replaced or edited under the same name is left alone.
Rows live in the SQLite metadata store (see metadb.py).
"""
import os
from typing import Iterable, List

from . import metadb


def _key(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def record_transfer(area: str, full_path: str) -> None:
    stat = os.stat(full_path)
    with metadb.connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO transfers (key, area, path, size, mtime_ns) VALUES (?, ?, ?, ?, ?)",
            (_key(full_path), area, os.path.realpath(full_path), stat.st_size, stat.st_mtime_ns),
        )


def owned_files(area: str, base_dir: str) -> List[str]:
    """Existing files under base_dir that CrossSync saved for this area and that are unchanged."""
    base_key = _key(base_dir)
    with metadb.connect() as conn:
        rows = conn.execute("SELECT key, path, size, mtime_ns FROM transfers WHERE area = ?", (area,)).fetchall()
    owned = []
    for key, path, size, mtime_ns in rows:
        try:
            if os.path.commonpath([key, base_key]) != base_key:
                continue
            stat = os.stat(path)
        except (OSError, ValueError):
            continue
        if stat.st_size == size and stat.st_mtime_ns == mtime_ns:
            owned.append(path)
    return owned


def forget_transfers(paths: Iterable[str]) -> None:
    keys = [(_key(path),) for path in paths]
    if keys:
        with metadb.connect() as conn:
            conn.executemany("DELETE FROM transfers WHERE key = ?", keys)


def prune_missing() -> None:
    """Drop entries whose files no longer exist."""
    with metadb.connect() as conn:
        paths = conn.execute("SELECT key, path FROM transfers").fetchall()
        gone = [(key,) for key, path in paths if not os.path.exists(path)]
        if gone:
            conn.executemany("DELETE FROM transfers WHERE key = ?", gone)
