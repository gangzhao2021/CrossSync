import json
import os
import tempfile
from dataclasses import dataclass
from typing import Optional


@dataclass
class Settings:
    app_name: str = "CrossSync"
    host: str = "0.0.0.0"
    port: int = 8008

    # Directories
    base_dir: str = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
    data_dir: str = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)), "data")
    downloads_dir: str = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)), "data", "downloads")
    outbox_dir: str = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)), "data", "outbox")
    temp_dir: str = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)), "data", "temp")
    metadata_dir: str = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)), "data", ".crosssync")

    # Upload behavior
    default_chunk_size: int = 8 * 1024 * 1024  # 8 MB
    max_concurrency: int = 4
    direct_upload_assembly: bool = True
    record_upload_checksums: bool = False

    # Cleanup
    temp_ttl_seconds: int = 60 * 60 * 48  # 48 hours

    # Preferences
    open_on_finish_default: bool = False
    write_sha256_sidecar: bool = False

    # OTP access control (optional)
    otp_enabled: bool = False
    otp_code: Optional[str] = None


settings = Settings()


def _preferences_path() -> str:
    return os.path.join(settings.metadata_dir, "preferences.json")


def _read_preferences() -> dict:
    try:
        with open(_preferences_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


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
        os.makedirs(settings.metadata_dir, exist_ok=True)
        preferences = _read_preferences()
        preferences["downloads_dir"] = folder
        temp_path = f"{_preferences_path()}.tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(preferences, f, ensure_ascii=False, indent=2)
        os.replace(temp_path, _preferences_path())
    return folder


def ensure_dirs():
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.downloads_dir, exist_ok=True)
    os.makedirs(settings.outbox_dir, exist_ok=True)
    os.makedirs(settings.temp_dir, exist_ok=True)
    os.makedirs(settings.metadata_dir, exist_ok=True)


def _env_truthy(v: Optional[str]) -> bool:
    return str(v or "").lower() in {"1", "true", "yes", "y", "on"}


def load_env_overrides():
    # Allow enabling OTP and setting code via env
    settings.otp_enabled = _env_truthy(os.getenv("CROSSSYNC_ENABLE_OTP")) or settings.otp_enabled
    code = os.getenv("CROSSSYNC_OTP_CODE")
    if code:
        settings.otp_code = code

    # Override data directories
    dl = os.getenv("CROSSSYNC_DOWNLOADS_DIR")
    if dl:
        settings.downloads_dir = os.path.abspath(dl)
    else:
        saved_downloads_dir = _read_preferences().get("downloads_dir")
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
