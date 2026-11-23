@echo off
REM Run the voice command test suite for Jarvis

cd /d "%~dp0"
echo Starting J.A.R.V.I.S. Voice Command Test Suite...
echo.

python test_voice_commands.py

if errorlevel 1 (
    echo.
    echo Tests failed with errors.
    pause
    exit /b 1
) else (
    echo.
    echo Tests completed successfully!
    pause
    exit /b 0
)
