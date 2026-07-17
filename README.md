# CrossSync

> 原生 iPhone 客户端位于 [`ios/`](ios/README.md)，用于在系统照片选择器关闭后显示 iCloud 原片准备进度、保持前台常亮，并复用 16 MB / 4 路分片上传。

CrossSync is a local LAN file-transfer app for moving files directly between iPhone Safari and a Windows or macOS computer. A persistent access token is enabled by default so other devices on the LAN cannot browse, upload, or delete files.

## What It Does

- iPhone -> computer: choose files on iPhone and they are written directly into the computer's selected receive folder. No second browser download is needed.
- Computer -> iPhone: open the same web app on the computer, upload files into `data/outbox`, then download them from iPhone.
- All iPhone files are uploaded in resumable chunks, including small photos. If the phone disconnects or the browser is interrupted, reopen CrossSync and choose the same files again; completed chunks are skipped automatically.
- The mobile UI starts a keep-awake guard during transfer. It uses Screen Wake Lock when available and falls back to a visible local looping video for Safari/HTTP LAN sessions.
- iPhone uploads use 16 MB resumable chunks, a shared pool of up to four upload lanes, direct server-side writes, and automatic per-chunk timeout/retry. The shared pool stays fast on LAN without flooding Safari when a large batch is selected.
- The file lists support single-file download, selected ZIP download, delete, and open-folder actions.
- Completed uploads record SHA-256 checksums in hidden app metadata, so integrity can be verified without adding extra `.sha256` files to normal downloads.

## Quick Start

### Windows

```powershell
.\run.ps1
```

Windows starts in HTTPS mode by default so iPhone Screen Wake Lock and Home Screen installation can work. Then open `https://localhost:8008` on the computer and scan the QR code with iPhone.

The first run also generates a persistent 12-digit access token in `data/.crosssync/preferences.json`. It is printed in the terminal and shown on the computer-only QR page. Safari receives it through the QR link automatically; enter the same token in the native iPhone app's connection settings.

The first HTTPS run creates a private `CrossSync Local CA` and a server certificate under `certs/` on Windows, macOS, and Linux. On iPhone, open `/ca.crt`, install the profile, then go to **Settings → General → About → Certificate Trust Settings** and enable full trust for `CrossSync Local CA`. Reopen CrossSync afterward.

### macOS / Linux

```bash
./run.sh --https
```

If the script is not executable yet:

```bash
chmod +x run.sh
./run.sh --https
```

### Manual

```bash
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8008
```

## Options

- Custom access token: `.\run.ps1 -AccessToken 123456789012` or `./run.sh --access-token 123456789012`
- Windows HTTPS: enabled by default (`.\run.ps1` or `.\run.ps1 -Https`)
- Windows HTTP compatibility mode: `.\run.ps1 -Http`
- Regenerate Windows certificates after a network/address change: `.\run.ps1 -RegenerateCertificate`
- macOS/Linux HTTPS: `./run.sh --https`
- Regenerate macOS/Linux certificates: `./run.sh --regenerate-certificate`
- Custom port: `.\run.ps1 -Port 8010` or `./run.sh --port 8010`
- Manual LAN address: `.\run.ps1 -LanHost 192.168.1.20` or `./run.sh --lan-host 192.168.1.20`

CrossSync generates `certs/cert.pem`, `certs/key.pem`, and `certs/ca.crt` automatically when HTTPS is requested. Windows uses OpenSSL from Git for Windows (or another installed OpenSSL); macOS/Linux require `openssl` on `PATH`. When HTTPS is active, QR codes and app links use `https://`. If auto-detection chooses the wrong network interface, use `-LanHost 192.168.1.20` on Windows or `--lan-host 192.168.1.20` on macOS/Linux.

Changing only the LAN address keeps the existing CA and issues a new server certificate. Full certificate regeneration rotates the CA; after that, install and fully trust the new `/ca.crt` profile on iPhone. The native app accepts the current system-trusted CA first and retains the bundled CA only as a compatibility fallback, so CA rotation does not require rebuilding the app.

## Default Paths

- iPhone -> computer: `data/downloads`
- computer -> iPhone: `data/outbox`
- chunk temp files: `data/temp`
- checksum metadata: `data/.crosssync/checksums.json`
- access token and preferences: `data/.crosssync/preferences.json`

On the computer, open the CrossSync workbench and use **选择保存位置** in **电脑接收区** to choose any writable folder. The choice is saved in `data/.crosssync/preferences.json` and reused the next time CrossSync starts. `CROSSSYNC_DOWNLOADS_DIR` still takes priority when it is explicitly set.

CrossSync no longer writes `filename.sha256` files next to transferred files by default. Existing `.sha256` files are hidden from the app list and ZIP downloads, but they can still be used as a legacy verification source. For faster large transfers, completed uploads are exposed immediately and full-file checksums are recorded only when the SHA-256 option is enabled or `CROSSSYNC_RECORD_UPLOAD_CHECKSUMS=1` is set. If you explicitly want sidecar files for external tools, set `CROSSSYNC_WRITE_SHA256=1` before starting the server.

## iPhone Screen Sleep

For the most reliable transfer, use trusted HTTPS and add CrossSync to the iPhone Home Screen from Safari's Share menu. The workbench reports the exact guard mode: **原生常亮**, **双重守护**, **视频守护**, or **未启用**.

Keep CrossSync in the foreground while transferring. Native Screen Wake Lock is preferred on HTTPS. A local muted video remains as an HTTP/older-iOS fallback, but the UI labels it as a compatibility mode because iOS can still override it. Manual screen locking, switching apps, or Low Power Mode can release browser wake protection.

The keep-awake guard starts only after iOS returns selected files to the page, so it does not compete with the Photos picker. If the guard is released, return to CrossSync and tap the on-screen re-enable action.

If iOS blocks both browser keep-awake methods, the transfer is still resumable: unlock the phone, reopen the page, choose the same file again, and CrossSync will continue from the missing chunks.

CrossSync keeps a local list of unfinished browser uploads for 48 hours, matching the server's temporary upload retention. After a page reload, the workbench shows **重新选择并续传** with the pending filenames. Safari does not let a web page reopen Photo Library files silently, so this re-selection is required after iOS discards the page; already uploaded chunks are not sent again.

For large videos, keep the page in the foreground until the file completes. If a single chunk stalls, CrossSync aborts that chunk after 180 seconds and retries it automatically.

When choosing from the iPhone Photos library, iOS may spend time exporting or downloading the original asset before Safari receives the file. CrossSync suspends its keep-awake work during this handoff and starts uploading immediately after the page receives the files, but it cannot control the time iOS spends preparing iCloud originals. Selecting smaller batches can make that system handoff shorter.
