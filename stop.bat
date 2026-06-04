@echo off
:: Stop Penguin server (kills the node.exe process listening on port 3000).
title Stop Penguin
echo Stopping Penguin...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 .*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
:: Also clean up any orphaned next-dev workers
taskkill /F /IM node.exe /FI "WINDOWTITLE eq next-server*" >nul 2>&1
echo Done.
timeout /t 2 /nobreak >nul
