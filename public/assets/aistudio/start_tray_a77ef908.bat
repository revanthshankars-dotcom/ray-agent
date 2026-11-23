@echo off
title J.A.R.V.I.S. 2.0 — System Tray
cd /d "%~dp0"
echo.
echo  ============================================================
echo   J.A.R.V.I.S. 2.0  ^|  System Tray + Background Server
echo  ============================================================
echo.
echo  Starting system tray application...
echo  The J.A.R.V.I.S. icon will appear in your system tray.
echo  Right-click it to access the dashboard and controls.
echo.

if exist .venv\Scripts\pythonw.exe (
    .venv\Scripts\pythonw.exe tray.py
) else if exist .venv\Scripts\python.exe (
    .venv\Scripts\python.exe tray.py
) else (
    pythonw tray.py
)
