@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Claude Console

echo.
echo  ============================================
echo    Claude Console Launcher
echo  ============================================
echo.

:: ---- 1. Locate Python interpreter (system Python first, then PATH) ----
set "PYTHON="
if exist "C:\Python312\python.exe" set "PYTHON=C:\Python312\python.exe"
if not defined PYTHON (
    where python >nul 2>nul && set "PYTHON=python"
)
if not defined PYTHON (
    echo [ERROR] Python not found. Please install Python 3.9+ or set PYTHON path in this script.
    pause
    exit /b 1
)

:: ---- 2. Create virtual environment (first run only) ----
if not exist "venv\Scripts\python.exe" (
    echo [First run] Creating virtual environment...
    "%PYTHON%" -m venv venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment
        pause
        exit /b 1
    )
    echo [First run] Installing dependencies, please wait...
    venv\Scripts\python.exe -m pip install -r requirements.txt -q
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies, please check your network
        pause
        exit /b 1
    )
)

:: ---- 3. Get LAN IP ----
set "LOCAL_IP="
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /i "IPv4"') do (
    for /f "tokens=1 delims= " %%j in ("%%i") do (
        set "LOCAL_IP=%%j"
        goto :gotip
    )
)
:gotip
if "%LOCAL_IP%"=="" set "LOCAL_IP=127.0.0.1"

:: ---- 4. Start server ----
:: Port defined in one place to keep config.py and startup consistent
set "PORT=8080"

echo.
echo   Server is starting!
echo.
echo   Local:     http://127.0.0.1:%PORT%
echo   LAN:       http://%LOCAL_IP%:%PORT%
echo.
echo   公网访问:  登录后「系统」-「外网穿透（Cloudflare）」- 启用穿透
echo   Default account: admin   Default password: change-me-please
echo   (Please change the password in System tab after first login!)
echo.
echo   Press Ctrl+C to stop the server
echo.

:: Open browser after 1 second
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:%PORT%"

venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port %PORT% --reload

pause