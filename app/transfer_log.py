"""Record of files CrossSync itself saved, so "clear" never touches anything else.

Entries are keyed by the resolved absolute path and remember size and mtime.
A file is only treated as CrossSync's own while both still match, so a file
the user later replaced or edited under the same name is left alone.
Rows live in the SQLite metadata store (see metadb.py).
"""
import os
from typing import Callable, Iterable, List, Optional, Tuple

from . import metadb
from .checksums import sha256_file


def _key(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def record_transfer(area: str, full_path: str, sha256: Optional[str] = None) -> None:
    stat = os.stat(full_path)
    with metadb.connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO transfers (key, area, path, size, mtime_ns, sha256) VALUES (?, ?, ?, ?, ?, ?)",
            (_key(full_path), area, os.path.realpath(full_path), stat.st_size, stat.st_mtime_ns, sha256),
        )


def _same_size_files(area: str, base_dir: str, size: int):
    """(key, path, known_sha) of unchanged files CrossSync saved here with this size."""
    base_key = _key(base_dir)
    with metadb.connect() as conn:
        rows = conn.execute(
            "SELECT key, path, mtime_ns, sha256 FROM transfers WHERE area = ? AND size = ?", (area, size)
        ).fetchall()
    for key, path, mtime_ns, known_sha in rows:
        try:
            if os.path.commonpath([key, base_key]) != base_key:
                continue
            stat = os.stat(path)
        except (OSError, ValueError):
            continue
        if stat.st_size != size or stat.st_mtime_ns != mtime_ns:
            continue  # Edited or replaced since CrossSync saved it.
        yield key, path, known_sha


def _known_sha(key: str, path: str, known_sha: Optional[str], hash_file: Callable[[str], str]) -> str:
    if known_sha is None:
        known_sha = hash_file(path)
        with metadb.connect() as conn:
            conn.execute("UPDATE transfers SET sha256 = ? WHERE key = ?", (known_sha, key))
    return known_sha


def has_same_size(area: str, base_dir: str, size: int) -> bool:
    """Whether a duplicate is possible at all; a phone only hashes a file when this is true."""
    return next(_same_size_files(area, base_dir, size), None) is not None


def find_by_sha(area: str, base_dir: str, size: int, sha256: str,
                hash_file: Callable[[str], str] = sha256_file) -> Optional[str]:
    """Path of an unchanged saved file with this size and SHA-256, checked before uploading."""
    for key, path, known_sha in _same_size_files(area, base_dir, size):
        if _known_sha(key, path, known_sha, hash_file) == sha256:
            return path
    return None


def find_duplicate(area: str, base_dir: str, size: int, new_file: str,
                   hash_file: Callable[[str], str] = sha256_file) -> Optional[Tuple[str, str]]:
    """An unchanged file CrossSync saved earlier with exactly the same bytes as new_file.

    Hashing only happens when a received file of the same size exists, so
    ordinary uploads cost one indexed lookup. Hashes of earlier files are
    computed at most once and stored.
    """
    new_sha = None
    for key, path, known_sha in _same_size_files(area, base_dir, size):
        if new_sha is None:
            new_sha = hash_file(new_file)
        if _known_sha(key, path, known_sha, hash_file) == new_sha:
            return path, new_sha
    return None


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
