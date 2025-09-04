import os
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

    # Upload behavior
    default_chunk_size: int = 8 * 1024 * 1024  # 8 MB
    max_concurrency: int = 4

    # Cleanup
    temp_ttl_seconds: int = 60 * 60 * 48  # 48 hours

    # Preferences
    open_on_finish_default: bool = False
    write_sha256_sidecar: bool = True

    # OTP access control (optional)
    otp_enabled: bool = False
    otp_code: Optional[str] = None


settings = Settings()


def ensure_dirs():
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.downloads_dir, exist_ok=True)
    os.makedirs(settings.outbox_dir, exist_ok=True)
    os.makedirs(settings.temp_dir, exist_ok=True)


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
    ob = os.getenv("CROSSSYNC_OUTBOX_DIR")
    if ob:
        settings.outbox_dir = os.path.abspath(ob)
    w = os.getenv("CROSSSYNC_WRITE_SHA256")
    if w is not None:
        settings.write_sha256_sidecar = _env_truthy(w)
