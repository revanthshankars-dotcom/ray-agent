@echo off
title J.A.R.V.I.S. Hands-Off Background Assistant
cd /d "%~dp0"

echo =======================================================
echo  J.A.R.V.I.S. 2.0 - Hands-Off Background Service
echo =======================================================
echo.
echo Starting J.A.R.V.I.S. in background standby mode...
echo It will NOT run tasks automatically. It will wait for your call.
echo.

if exist .venv\Scripts\python.exe (
    .venv\Scripts\python.exe hands_off_jarvis.py
) else (
    python hands_off_jarvis.py
)

pause
