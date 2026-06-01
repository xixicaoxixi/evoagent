@echo off
chcp 65001 >nul 2>&1
echo Stopping EvoAgent servers...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 :3001 :3002 :8900 :8901 " ^| findstr "LISTENING" ^| findstr "bun"') do (
    taskkill /PID %%a /F >nul 2>&1
)

taskkill /FI "WINDOWTITLE eq EvoAgent MCP" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq EvoAgent Server" /F >nul 2>&1

echo EvoAgent servers stopped.
timeout /t 2 /nobreak >nul
