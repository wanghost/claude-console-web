@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Claude Console

echo.
echo  ============================================
echo    Claude Console 一键启动
echo  ============================================
echo.

:: ---- 1. 检查 Python ----
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Python，请先安装 Python 3.9+ 并加入 PATH
    pause
    exit /b 1
)

:: ---- 2. 创建虚拟环境（首次）----
if not exist "venv\Scripts\python.exe" (
    echo [首次运行] 正在创建虚拟环境...
    python -m venv venv
    if errorlevel 1 (
        echo [错误] 虚拟环境创建失败
        pause
        exit /b 1
    )
    echo [首次运行] 正在安装依赖，请稍候...
    venv\Scripts\python.exe -m pip install -r requirements.txt -q
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试
        pause
        exit /b 1
    )
)

:: ---- 3. 获取本机局域网 IP ----
set "LOCAL_IP="
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /i "IPv4"') do (
    for /f "tokens=1 delims= " %%j in ("%%i") do (
        set "LOCAL_IP=%%j"
        goto :gotip
    )
)
:gotip
if "%LOCAL_IP%"=="" set "LOCAL_IP=127.0.0.1"

:: ---- 4. 启动服务 ----
echo.
echo   服务已启动！
echo.
echo   本机访问:   http://127.0.0.1:8080
echo   局域网访问: http://%LOCAL_IP%:8080   （手机同一 WiFi 下）
echo.
echo   默认账号: admin   默认密码: change-me-please
echo   （首次登录后请到「系统」页修改密码！）
echo.
echo   按 Ctrl+C 停止服务
echo.

:: 延迟 1 秒后自动打开浏览器
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:8080"

venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8080

pause
