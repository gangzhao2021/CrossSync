CrossSync — LAN file transfer between iPhone (Safari) and Windows

Overview

- Windows runs a local FastAPI web server accessible on LAN.
- iPhone opens the web UI by scanning a QR code.
- Bidirectional transfer:
  - Send to PC: iPhone uploads files via resumable/chunked upload.
  - Send to iPhone: Windows user (or any desktop browser) uploads into Outbox; iPhone downloads them.
- Large files supported (10s of GB) via chunked upload and streaming download.
- Drag-and-drop multi-file upload (folder drop on desktop), progress with speed/ETA, and auto cleanup of stale temp files.

Quick Start

1) Create venv and install deps:

   python -m venv .venv
   .venv/Scripts/activate  # Windows PowerShell: .venv\\Scripts\\Activate.ps1
   pip install -r requirements.txt

2) Run server:

   python -m uvicorn app.main:app --host 0.0.0.0 --port 8008

   Or use run.ps1 which prints the local URL and opens a QR page.

3) On Windows, open http://127.0.0.1:8008 and scan the QR code with iPhone.

Options

- OTP gate: `./run.ps1 -EnableOtp` (optional `-OtpCode 123456`)
- HTTPS: `./run.ps1 -Https` (requires `certs/cert.pem` + `certs/key.pem`)
- Port: `./run.ps1 -Port 8010`

Default Paths

- Downloads (iPhone -> PC): data/downloads
- Outbox (PC -> iPhone):    data/outbox
- Temp (chunks):            data/temp

Notes

- iOS Safari may not support folder drag-and-drop; multiple file selection works.
- No authentication is enabled by default. Consider using trusted LAN only.
- Pause/Resume: Available per-file during upload. Cancelling keeps uploaded chunks for later resume.
- ZIP download: Outbox supports “Download all” or selected files as ZIP.
- Open-on-finish: Toggle in “发送到电脑” to auto-open folder after upload (Windows only).
