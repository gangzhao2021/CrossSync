import os
import socket
import hashlib
from typing import Optional


def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        try:
            s.close()
        except Exception:
            pass
    return ip


def safe_join(base: str, *paths: str) -> str:
    joined = os.path.abspath(os.path.join(base, *paths))
    base_abs = os.path.abspath(base)
    if os.path.commonpath([joined, base_abs]) != base_abs:
        raise ValueError("Path traversal detected")
    return joined


def file_fingerprint(name: str, size: int, last_modified: Optional[int]) -> str:
    m = hashlib.sha256()
    m.update(name.encode("utf-8"))
    m.update(str(size).encode("ascii"))
    if last_modified is not None:
        m.update(str(last_modified).encode("ascii"))
    return m.hexdigest()

