"""SQLite store for CrossSync metadata (checksums and the record of received files).

Each update touches one row, instead of rewriting a whole JSON file whose size
grows with every file ever received. Older checksums.json / transfers.json
files are imported once and renamed to *.migrated.

The database runs in WAL mode with synchronous=NORMAL on one long-lived
connection: a commit is an append to the WAL rather than several fsyncs. On a
spinning disk that is the difference between ~200 ms and ~1 ms per received
file. A power cut can lose the last few records, never corrupt the database;
the records are conveniences (checksums, which files CrossSync saved).
"""
import atexit
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Dict

from .config import settings

DB_FILE = "crosssync.db"
LEGACY_CHECKSUMS = "checksums.json"
LEGACY_TRANSFERS = "transfers.json"
SCHEMA = """
CREATE TABLE IF NOT EXISTS checksums (
    key TEXT PRIMARY KEY,
    record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
    key TEXT PRIMARY KEY,
    area TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_by_area ON transfers(area);
"""

_lock = threading.RLock()
_connections: Dict[str, sqlite3.Connection] = {}


def db_path() -> str:
    return os.path.join(settings.metadata_dir, DB_FILE)


def _open(path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    with conn:
        _import_legacy_json(conn, os.path.dirname(path))
    return conn


@contextmanager
def connect():
    """The shared connection for the current metadata folder; commits on success."""
    path = db_path()
    with _lock:
        conn = _connections.get(path)
        if conn is not None and not os.path.exists(path):
            conn.close()  # The folder was removed underneath us; start fresh.
            conn = None
        if conn is None:
            conn = _connections[path] = _open(path)
        with conn:
            yield conn


def close_all() -> None:
    """Close every cached connection (used at exit and by tests that delete folders)."""
    with _lock:
        for conn in _connections.values():
            try:
                conn.close()
            except sqlite3.Error:
                pass
        _connections.clear()


atexit.register(close_all)


def _load_json(folder: str, name: str) -> dict:
    try:
        with open(os.path.join(folder, name), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _retire(folder: str, name: str) -> None:
    source = os.path.join(folder, name)
    if os.path.exists(source):
        try:
            os.replace(source, f"{source}.migrated")
        except OSError:
            pass


def _import_legacy_json(conn: sqlite3.Connection, folder: str) -> None:
    checksums = _load_json(folder, LEGACY_CHECKSUMS)
    if checksums:
        conn.executemany(
            "INSERT OR IGNORE INTO checksums (key, record) VALUES (?, ?)",
            [(key, json.dumps(value, ensure_ascii=False)) for key, value in checksums.items() if isinstance(value, dict)],
        )
    transfers = _load_json(folder, LEGACY_TRANSFERS)
    rows = []
    for key, value in transfers.items():
        try:
            rows.append((key, value["area"], value["path"], int(value["size"]), int(value["mtime_ns"])))
        except (KeyError, TypeError, ValueError):
            continue
    if rows:
        conn.executemany("INSERT OR IGNORE INTO transfers VALUES (?, ?, ?, ?, ?)", rows)
    _retire(folder, LEGACY_CHECKSUMS)
    _retire(folder, LEGACY_TRANSFERS)
