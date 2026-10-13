"""Start CrossSync with a tray icon and no console window (double-click, or run with pythonw).

The packaged CrossSync.exe is built from this file; see scripts/build-windows.ps1.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.desktop import main  # noqa: E402

if __name__ == "__main__":
    main()
