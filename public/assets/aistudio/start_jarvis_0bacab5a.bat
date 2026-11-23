@echo off
title J.A.R.V.I.S. 2.0 Launcher
cd /d "%~dp0"

echo ============================================================
echo   J.A.R.V.I.S. 2.0  ^|  Autonomous AI Operating System
echo ============================================================
echo.
echo Launching Tray Mission Control and Background Voice Daemon...
echo.

if exist .venv\Scripts\pythonw.exe (
    start "" ".venv\Scripts\pythonw.exe" tray.py
    start "" ".venv\Scripts\pythonw.exe" main.py --daemon
) else (
    start "" pythonw tray.py
    start "" pythonw main.py --daemon
)

echo [✓] J.A.R.V.I.S. 2.0 is now active in the system tray and background.
echo [✓] Wake-word listener active: Simply say "Hey Jarvis".
echo [✓] Dashboard online at: http://localhost:8000/dashboard
echo.
timeout /t 3 >nul
exit
