@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title EvoAgent Server

echo ============================================
echo   EvoAgent - AI Agent Platform
echo ============================================
echo.

where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Bun is not installed.
    echo Please install Bun first: https://bun.sh
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    bun install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed.
    echo.
)

if exist ".env" (
    echo [INFO] Loading .env file...
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set "line=%%a"
        if not "!line:~0,1!"=="#" (
            if not "%%b"=="" (
                set "%%a=%%b"
            )
        )
    )
    echo [OK] .env loaded.
    echo.
) else (
    echo [INFO] No .env file found. Using system environment variables.
    echo.
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8900 :8901 " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)

set PORT=8900

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [WARN] Port %PORT% is in use, trying 8901...
    set PORT=8901
)

echo [INFO] Starting EvoAgent All-in-One Server on port %PORT%...
echo.
echo   Web UI:      http://localhost:%PORT%
echo   MCP Health:  http://localhost:%PORT%/health
echo   MCP Endpoint:http://localhost:%PORT%/mcp
echo   REST API:    http://localhost:%PORT%/api/v1
echo.
echo   Copy-ready MCP JSON config:
echo   {
echo     "mcpServers": {
echo       "evoagent": {
echo         "url": "http://127.0.0.1:%PORT%/mcp"
echo       }
echo     }
echo   }
echo.
echo   Close this window to stop the server.
echo ============================================
echo.

set BUN_CONFIG_HTTP_IDLE_TIMEOUT=0

start /min bun run src/cli.ts all --port=%PORT% --host=127.0.0.1

echo [INFO] Waiting for server to be ready...
set SERVER_READY=0
for /L %%i in (1,1,30) do (
    if !SERVER_READY! equ 0 (
        curl -s -o nul http://127.0.0.1:%PORT%/health >nul 2>&1
        if !errorlevel! equ 0 (
            set SERVER_READY=1
            echo [OK] Server is ready.
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)
if !SERVER_READY! equ 0 (
    echo [WARN] Server did not become ready within 30s, opening browser anyway...
)

start http://localhost:%PORT%
