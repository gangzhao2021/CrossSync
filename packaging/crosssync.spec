# PyInstaller spec for the Windows desktop build. Run scripts/build-windows.ps1 instead of calling this directly.
# -*- mode: python ; coding: utf-8 -*-
import os

from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))  # noqa: F821 - provided by PyInstaller

hidden = (
    collect_submodules("uvicorn")
    + collect_submodules("zeroconf")
    + collect_submodules("pystray")
    + collect_submodules("app")
)

a = Analysis(  # noqa: F821
    [os.path.join(ROOT, "CrossSync.pyw")],
    pathex=[ROOT],
    datas=[
        (os.path.join(ROOT, "app", "static"), os.path.join("app", "static")),
        (os.path.join(ROOT, "app", "templates"), os.path.join("app", "templates")),
        (os.path.join(ROOT, "LICENSE"), "."),
    ],
    hiddenimports=hidden,
    excludes=["tkinter", "pytest", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="CrossSync",
    console=False,  # No terminal window: the app lives in the system tray.
    icon=os.path.join(ROOT, "packaging", "crosssync.ico"),
    version=None,
)
coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    name="CrossSync",
)
