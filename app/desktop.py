"""CrossSync as a desktop app: the server runs in the background with a tray icon.

No terminal window stays open. The tray menu opens the workbench, shows the QR
page, opens the receive folder, toggles "start when I sign in" and quits.
Starting it again while it runs just opens the browser.

    pythonw CrossSync.pyw            (from a source checkout)
    CrossSync.exe                    (packaged build; no Python needed)
"""
import argparse
import logging
import os
import socket
import sys
import threading
import time
import webbrowser
from logging.handlers import RotatingFileHandler
from typing import Optional

log = logging.getLogger("crosssync.desktop")
AUTOSTART_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_NAME = "CrossSync"
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))


# --- helpers (unit tested) -----------------------------------------------------

def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def launch_command(port: int) -> str:
    """The command Windows runs at sign-in to start CrossSync without a console."""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --port {port} --no-browser'
    pythonw = sys.executable
    if pythonw.lower().endswith("python.exe"):  # pythonw.exe is the console-less twin.
        pythonw = pythonw[: -len("python.exe")] + "pythonw.exe"
    return f'"{pythonw}" "{os.path.join(REPO_ROOT, "CrossSync.pyw")}" --port {port} --no-browser'


def autostart_supported() -> bool:
    return sys.platform == "win32"


def autostart_enabled(registry=None) -> bool:
    if not autostart_supported() and registry is None:
        return False
    winreg = registry or __import__("winreg")
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY) as key:
            winreg.QueryValueEx(key, AUTOSTART_NAME)
            return True
    except OSError:
        return False


def set_autostart(enabled: bool, port: int, registry=None) -> None:
    """Add or remove CrossSync from the current user's sign-in programs."""
    winreg = registry or __import__("winreg")
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, launch_command(port))
        else:
            try:
                winreg.DeleteValue(key, AUTOSTART_NAME)
            except FileNotFoundError:
                pass


def configure_logging(log_dir: str) -> str:
    """Log to a file; a windowed app has no console for stdout or stderr."""
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, "crosssync.log")
    handler = RotatingFileHandler(path, maxBytes=2 * 1024 * 1024, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    if sys.stdout is None or sys.stderr is None:
        stream = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 - lives for the process
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
    return path


def show_error(message: str) -> None:
    log.error(message)
    if sys.platform == "win32":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "CrossSync", 0x10)


# --- app --------------------------------------------------------------------------

def prepare_https(settings) -> Optional[tuple]:
    from .certs import ensure_certificates
    from .utils import get_lan_ip

    dns_name = f"{settings.mdns_name}.local" if settings.mdns_enabled else None
    try:
        result = ensure_certificates(settings.cert_dir, get_lan_ip(), dns_name)
        return result["cert"], result["key"]
    except Exception:
        log.exception("HTTPS certificates could not be prepared; using HTTP")
        return None


def run_tray(base_url: str, settings, port: int, stop) -> None:
    import pystray
    from PIL import Image

    from .utils import open_folder

    image = Image.open(os.path.join(os.path.dirname(__file__), "static", "app-icon-192.png"))
    host = f"{settings.mdns_name}.local" if settings.mdns_enabled else "localhost"

    def toggle_autostart(icon, item):
        try:
            set_autostart(not autostart_enabled(), port)
        except OSError as exc:
            show_error(f"没能修改开机启动设置：{exc}")

    def quit_app(icon, item):
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("打开 CrossSync", lambda: webbrowser.open(base_url + "app"), default=True),
        pystray.MenuItem("显示扫码页", lambda: webbrowser.open(base_url)),
        pystray.MenuItem("打开接收文件夹", lambda: open_folder(settings.downloads_dir)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "登录 Windows 时自动启动", toggle_autostart,
            checked=lambda item: autostart_enabled(), visible=autostart_supported(),
        ),
        pystray.MenuItem("退出 CrossSync", quit_app),
    )
    icon = pystray.Icon("CrossSync", image, f"CrossSync · {host}:{port}", menu)

    from . import devices

    def announce_device(item):
        try:
            icon.notify(f"{item.name} 想连接这台电脑。打开 CrossSync 点“允许”或“拒绝”。", "CrossSync")
        except Exception:
            log.exception("Could not show the new-device notification")

    devices.request_listeners.add(announce_device)
    try:
        icon.run()
    finally:
        devices.request_listeners.discard(announce_device)
    stop()


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Run CrossSync in the background with a tray icon.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CROSSSYNC_PORT") or 8008))
    parser.add_argument("--http", action="store_true", help="serve plain HTTP (no Screen Wake Lock on iPhone)")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser on start")
    args = parser.parse_args(argv)
    os.environ["CROSSSYNC_PORT"] = str(args.port)

    from .config import load_env_overrides, settings

    load_env_overrides()
    log_path = configure_logging(os.path.join(settings.data_dir, "logs"))

    scheme = "http" if args.http else "https"
    base_url = f"{scheme}://localhost:{args.port}/"
    if port_in_use(args.port):
        # Already running (or the port is taken): just bring up the page.
        webbrowser.open(base_url)
        return

    tls = None if args.http else prepare_https(settings)
    if tls is None:
        scheme = "http"
        base_url = f"http://localhost:{args.port}/"

    import uvicorn

    from .main import app

    config = uvicorn.Config(
        app, host="0.0.0.0", port=args.port, log_config=None, log_level="info",
        ssl_certfile=tls[0] if tls else None, ssl_keyfile=tls[1] if tls else None,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="crosssync-server", daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.1)
    if not server.started:
        show_error(f"CrossSync 没能启动（端口 {args.port} 可能被占用）。详情见日志：{log_path}")
        server.should_exit = True
        return

    log.info("CrossSync running at %s", base_url)
    if not args.no_browser:
        webbrowser.open(base_url)

    def stop():
        server.should_exit = True
        thread.join(timeout=10)

    run_tray(base_url, settings, args.port, stop)


if __name__ == "__main__":
    main()
