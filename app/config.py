import json
import os
import secrets
import tempfile
from dataclasses import dataclass
from typing import Optional


_BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
_DATA_DIR = os.path.join(_BASE_DIR, "data")


@dataclass
class Settings:
    app_name: str = "CrossSync"
    port: int = 8008

    # Directories
    base_dir: str = _BASE_DIR
    data_dir: str = _DATA_DIR
    downloads_dir: str = os.path.join(_DATA_DIR, "downloads")
    outbox_dir: str = os.path.join(_DATA_DIR, "outbox")
    temp_dir: str = os.path.join(_DATA_DIR, "temp")
    metadata_dir: str = os.path.join(_DATA_DIR, ".crosssync")

    # Upload behavior
    default_chunk_size: int = 8 * 1024 * 1024  # 8 MB
    max_concurrency: int = 4
    max_server_uploads: int = 8
    direct_upload_assembly: bool = True
    record_upload_checksums: bool = False
    max_file_size: int = 100 * 1024 * 1024 * 1024  # 100 GB
    min_chunk_size: int = 256 * 1024  # 256 KB
    max_chunk_size: int = 64 * 1024 * 1024  # 64 MB
    max_chunks_per_file: int = 10_000
    max_active_uploads: int = 64
    min_free_space_reserve: int = 256 * 1024 * 1024  # 256 MB

    # Cleanup
    temp_ttl_seconds: int = 60 * 60 * 48  # 48 hours

    # Preferences
    write_sha256_sidecar: bool = False

    # LAN access control. A persistent 12-digit token is generated on first run.
    access_token: Optional[str] = None

    # Friendly name shown on phones instead of the OS hostname (e.g. "书房电脑").
    display_name: Optional[str] = None


settings = Settings()


def area_dir(area: str) -> str:
    """Return the directory that backs a transfer area ("downloads" or "outbox")."""
    if area == "downloads":
        return settings.downloads_dir
    if area == "outbox":
        return settings.outbox_dir
    raise ValueError(f"unknown transfer area: {area}")


def _preferences_path() -> str:
    return os.path.join(settings.metadata_dir, "preferences.json")


def _read_preferences() -> dict:
    try:
        with open(_preferences_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write_preferences(preferences: dict) -> None:
    os.makedirs(settings.metadata_dir, exist_ok=True)
    temp_path = f"{_preferences_path()}.tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(preferences, f, ensure_ascii=False, indent=2)
    os.replace(temp_path, _preferences_path())


def set_downloads_dir(path: str, *, persist: bool = True) -> str:
    folder = os.path.abspath(os.path.expandvars(os.path.expanduser(path)))
    if not os.path.isdir(folder):
        raise ValueError("selected folder does not exist")

    # Confirm the server process can really save uploads here before switching.
    try:
        with tempfile.NamedTemporaryFile(prefix=".crosssync-write-test-", dir=folder):
            pass
    except OSError as exc:
        raise ValueError("selected folder is not writable") from exc

    settings.downloads_dir = folder
    if persist:
        preferences = _read_preferences()
        preferences["downloads_dir"] = folder
        _write_preferences(preferences)
    return folder


DISPLAY_NAME_MAX_LENGTH = 32


def normalize_display_name(name) -> Optional[str]:
    """Trim a user-supplied computer name; empty means "use the hostname"."""
    if not isinstance(name, str):
        raise ValueError("name must be text")
    # Control characters (newlines, tabs) become spaces, then runs of spaces collapse.
    cleaned = " ".join("".join(ch if ch.isprintable() else " " for ch in name).split())
    if len(cleaned) > DISPLAY_NAME_MAX_LENGTH:
        raise ValueError(f"name must be at most {DISPLAY_NAME_MAX_LENGTH} characters")
    return cleaned or None


def set_display_name(name) -> Optional[str]:
    settings.display_name = normalize_display_name(name)
    preferences = _read_preferences()
    if settings.display_name:
        preferences["display_name"] = settings.display_name
    else:
        preferences.pop("display_name", None)
    _write_preferences(preferences)
    return settings.display_name


def ensure_dirs():
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.downloads_dir, exist_ok=True)
    os.makedirs(settings.outbox_dir, exist_ok=True)
    os.makedirs(settings.temp_dir, exist_ok=True)
    os.makedirs(settings.metadata_dir, exist_ok=True)


def _env_truthy(v: Optional[str]) -> bool:
    return str(v or "").lower() in {"1", "true", "yes", "y", "on"}


def load_env_overrides():
    configured_token = (os.getenv("CROSSSYNC_ACCESS_TOKEN") or "").strip()
    preferences = _read_preferences()
    saved_token = preferences.get("access_token")
    if configured_token:
        settings.access_token = configured_token
    elif isinstance(saved_token, str) and len(saved_token) >= 8:
        settings.access_token = saved_token
    else:
        settings.access_token = f"{secrets.randbelow(10**12):012d}"
        preferences["access_token"] = settings.access_token
        _write_preferences(preferences)

    try:
        settings.display_name = normalize_display_name(preferences.get("display_name") or "")
    except ValueError:
        settings.display_name = None

    # Override data directories
    dl = os.getenv("CROSSSYNC_DOWNLOADS_DIR")
    if dl:
        settings.downloads_dir = os.path.abspath(dl)
    else:
        saved_downloads_dir = preferences.get("downloads_dir")
        if isinstance(saved_downloads_dir, str) and os.path.isdir(saved_downloads_dir):
            settings.downloads_dir = os.path.abspath(saved_downloads_dir)
    ob = os.getenv("CROSSSYNC_OUTBOX_DIR")
    if ob:
        settings.outbox_dir = os.path.abspath(ob)
    w = os.getenv("CROSSSYNC_WRITE_SHA256")
    if w is not None:
        settings.write_sha256_sidecar = _env_truthy(w)
    direct = os.getenv("CROSSSYNC_DIRECT_UPLOAD_ASSEMBLY")
    if direct is not None:
        settings.direct_upload_assembly = _env_truthy(direct)
    upload_checksums = os.getenv("CROSSSYNC_RECORD_UPLOAD_CHECKSUMS")
    if upload_checksums is not None:
        settings.record_upload_checksums = _env_truthy(upload_checksums)
