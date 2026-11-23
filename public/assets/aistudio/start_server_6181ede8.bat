@echo off
title J.A.R.V.I.S. 2.0 — Cloud Server
cd /d "%~dp0"
echo.
echo  ============================================================
echo   J.A.R.V.I.S. 2.0  ^|  Cloud Backend + Multi-Agent System
echo  ============================================================
echo.
echo  Starting FastAPI cloud server on http://localhost:8000
echo  Dashboard : http://localhost:8000/dashboard
echo  API Docs  : http://localhost:8000/docs
echo  Health    : http://localhost:8000/api/health
echo.

if exist .venv\Scripts\python.exe (
    .venv\Scripts\python.exe -m uvicorn cloud_server.server:app --host 0.0.0.0 --port 8000 --reload
) else (
    python -m uvicorn cloud_server.server:app --host 0.0.0.0 --port 8000 --reload
)
pause
