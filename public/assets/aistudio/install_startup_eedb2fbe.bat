@echo off
title J.A.R.V.I.S. 2.0 — Auto-Startup Installer
cd /d "%~dp0"

echo ============================================================
echo   J.A.R.V.I.S. 2.0  ^|  Windows Auto-Startup Installer
echo ============================================================
echo.
echo Installing J.A.R.V.I.S. stealth launcher to Windows Startup...
echo.

cscript //Nologo install_startup.vbs

echo.
echo J.A.R.V.I.S. will now start automatically in the background
echo whenever you turn on your laptop. No windows will appear.
echo.
pause
