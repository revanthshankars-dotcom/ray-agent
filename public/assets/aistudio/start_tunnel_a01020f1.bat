@echo off
title J.A.R.V.I.S. 2.0 — Cloudflare Remote Mobile Tunnel
cd /d "%~dp0"

echo ============================================================
echo   J.A.R.V.I.S. 2.0  ^|  Cloudflare Remote Mobile Access
echo ============================================================
echo.
echo Launching Cloudflare Tunnel for secure smartphone access...
echo (Requires no account, no payment, and no router configuration)
echo.

if exist .venv\Scripts\python.exe (
    .venv\Scripts\python.exe core\tunnel_manager.py
) else (
    python core\tunnel_manager.py
)

pause
