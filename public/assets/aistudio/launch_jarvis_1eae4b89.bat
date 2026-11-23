@echo off
cd /d "%~dp0"

echo ============================================================
echo   J.A.R.V.I.S. 2.0  ^|  One-Click Launch
echo ============================================================
echo.

echo Starting local J.A.R.V.I.S. server...
if exist .venv\Scripts\python.exe (
    start "J.A.R.V.I.S. Server" cmd /k ".venv\Scripts\python.exe -m cloud_server.server"
) else (
    start "J.A.R.V.I.S. Server" cmd /k "python -m cloud_server.server"
)

REM Give the web server a moment to start before opening the dashboard
ping 127.0.0.1 -n 5 >nul

start "" http://localhost:8000/dashboard

echo.
echo J.A.R.V.I.S. dashboard opened.
echo Use the keyboard input, click SEND, or click the microphone button for voice input.
echo. 
pause
