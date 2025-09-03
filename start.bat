@echo off
chcp 65001 > nul
title CrossSync

echo.
echo ========================================
echo           CrossSync
echo ========================================
echo.

:: 检查Node.js是否安装
node --version > nul 2>&1
if errorlevel 1 (
    echo ❌ 错误: 未检测到Node.js
    echo 请先安装Node.js: https://nodejs.org
    pause
    exit /b 1
)

:: 检查依赖是否安装
if not exist "node_modules" (
    echo 📦 正在安装依赖...
    npm install
    if errorlevel 1 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
)

:: 获取本机IP地址
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /R /C:"IPv4.*192\.168\."') do (
    for /f "tokens=1" %%j in ("%%i") do set LOCAL_IP=%%j
)

echo 🚀 启动服务器...
echo.
echo 💻 电脑访问: http://localhost:3010
echo 📱 手机访问: http://%LOCAL_IP%:3010
echo.
echo 💡 提示:
echo    • 确保手机和电脑在同一WiFi网络
echo    • 如果无法访问，请检查防火墙设置
echo    • 按 Ctrl+C 停止服务器
echo.

:: 启动服务器
node server/server.js