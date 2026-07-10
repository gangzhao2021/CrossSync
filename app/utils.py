import os
import socket
import hashlib
import shutil
import subprocess
import sys
from typing import Optional


def _usable_lan_ip(ip: str) -> bool:
    if not ip or ip.startswith(("127.", "169.254.")):
        return False
    return ip != "0.0.0.0"


def _add_lan_candidate(candidates: list[str], ip: str) -> None:
    if _usable_lan_ip(ip) and ip not in candidates:
        candidates.append(ip)


def get_lan_ip() -> str:
    override = (os.getenv("CROSSSYNC_LAN_HOST") or os.getenv("CROSSSYNC_LAN_IP") or "").strip()
    if override:
        return override

    candidates: list[str] = []

    # UDP connect does not send packets; it asks the OS which local interface
    # would be used for that route. Private targets cover LAN-only networks.
    for target in ("192.168.255.255", "10.255.255.255", "172.16.255.255", "8.8.8.8"):
        s = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((target, 80))
            _add_lan_candidate(candidates, s.getsockname()[0])
        except Exception:
            pass
        finally:
            try:
                if s:
                    s.close()
            except Exception:
                pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_DGRAM):
            _add_lan_candidate(candidates, info[4][0])
    except Exception:
        pass

    return candidates[0] if candidates else "127.0.0.1"


def safe_join(base: str, *paths: str) -> str:
    base_real = os.path.realpath(os.path.abspath(base))
    joined = os.path.realpath(os.path.abspath(os.path.join(base_real, *paths)))
    try:
        contained = os.path.commonpath([joined, base_real]) == base_real
    except ValueError:
        contained = False
    if not contained:
        raise ValueError("Path traversal detected")
    return joined


def file_fingerprint(
    name: str,
    size: int,
    last_modified: Optional[int],
    client_id: str = "",
    resume_key: str = "",
) -> str:
    m = hashlib.sha256()
    for value in (client_id, resume_key, name, str(size), str(last_modified or 0)):
        encoded = value.encode("utf-8")
        m.update(len(encoded).to_bytes(8, "big"))
        m.update(encoded)
    return m.hexdigest()


def open_folder(path: str) -> bool:
    folder = os.path.abspath(path)
    if not os.path.isdir(folder):
        return False

    try:
        if os.name == "nt":
            os.startfile(folder)  # type: ignore[attr-defined]
            return True
        if sys.platform == "darwin":
            subprocess.Popen(["open", folder], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True

        opener = shutil.which("xdg-open")
        if opener:
            subprocess.Popen([opener, folder], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
    except Exception:
        return False

    return False


def folder_picker_available() -> bool:
    if os.name == "nt":
        return bool(shutil.which("powershell.exe") or shutil.which("powershell"))
    if sys.platform == "darwin":
        return bool(shutil.which("osascript"))
    return bool(shutil.which("zenity") or shutil.which("kdialog"))


def pick_folder(initial_path: Optional[str] = None) -> Optional[str]:
    """Open the host OS folder picker and return an existing folder.

    The caller must ensure this is only exposed to a browser running on the
    host computer; LAN clients must not be able to open native dialogs.
    """
    initial = os.path.abspath(initial_path or os.path.expanduser("~"))

    if os.name == "nt":
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not powershell:
            raise RuntimeError("PowerShell is unavailable")
        script = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择手机文件在电脑上的保存位置'
$dialog.ShowNewFolderButton = $true
if ($env:CROSSSYNC_PICKER_INITIAL -and (Test-Path -LiteralPath $env:CROSSSYNC_PICKER_INITIAL -PathType Container)) {
    $dialog.SelectedPath = $env:CROSSSYNC_PICKER_INITIAL
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
}
$owner.Close()
$owner.Dispose()
"""
        env = os.environ.copy()
        env["CROSSSYNC_PICKER_INITIAL"] = initial
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        completed = subprocess.run(
            [powershell, "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            creationflags=creationflags,
            check=False,
        )
        if completed.returncode != 0:
            message = (completed.stderr or completed.stdout or "PowerShell folder picker failed").strip()
            raise RuntimeError(message)
        selected = completed.stdout.strip()
    elif sys.platform == "darwin":
        osascript = shutil.which("osascript")
        if not osascript:
            raise RuntimeError("osascript is unavailable")
        script = """
on run argv
    set initialPath to item 1 of argv
    set chosenFolder to choose folder with prompt "选择手机文件在电脑上的保存位置" default location POSIX file initialPath
    return POSIX path of chosenFolder
end run
"""
        completed = subprocess.run(
            [osascript, "-e", script, initial],
            capture_output=True,
            text=True,
            check=False,
        )
        selected = completed.stdout.strip()
    else:
        zenity = shutil.which("zenity")
        kdialog = shutil.which("kdialog")
        if zenity:
            completed = subprocess.run(
                [zenity, "--file-selection", "--directory", f"--filename={initial}{os.sep}"],
                capture_output=True,
                text=True,
                check=False,
            )
        elif kdialog:
            completed = subprocess.run(
                [kdialog, "--getexistingdirectory", initial, "--title", "选择手机文件在电脑上的保存位置"],
                capture_output=True,
                text=True,
                check=False,
            )
        else:
            raise RuntimeError("no supported folder picker is available")
        selected = completed.stdout.strip()

    if not selected:
        return None
    selected = os.path.abspath(selected)
    return selected if os.path.isdir(selected) else None
