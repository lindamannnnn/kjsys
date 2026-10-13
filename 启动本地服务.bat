@echo off
chcp 65001 >nul
title Shenglong ERP - Local Services

echo ==================================================
echo   Shenglong ERP local services
echo   (MySQL docker + API 3000 + H5 5174 + Admin 5176)
echo ==================================================
echo.

rem --- 1. Docker Desktop ---
tasklist /FI "IMAGENAME eq com.docker.backend.exe" 2>nul | find "com.docker.backend.exe" >nul
if errorlevel 1 (
  echo [1/4] Starting Docker Desktop...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
) else (
  echo [1/4] Docker Desktop already running
)

rem --- 2. wait for docker daemon ---
echo [2/4] Waiting for docker daemon...
:waitdocker
docker ps >nul 2>&1
if errorlevel 1 (
  timeout /t 5 /nobreak >nul
  goto waitdocker
)
echo       docker is ready

rem --- 3. MySQL container ---
echo [3/4] Starting MySQL container...
docker compose -f G:\sl\shenglong-erp\docker-compose.yml up -d mysql
if errorlevel 1 (
  echo.
  echo [ERROR] MySQL failed to start. Check the message above.
  pause
  exit /b 1
)

rem --- 4. three node services in separate windows ---
echo [4/4] Starting API / H5 / Admin...
start "SL-API-3000" cmd /k "cd /d G:\sl\shenglong-erp\server && node src/app.js"
timeout /t 3 /nobreak >nul
start "SL-H5-5174" cmd /k "cd /d G:\sl\shenglong-erp\server && node tests\role-agent\static-serve.js ..\miniprogram\dist\build\h5 5174"
start "SL-Admin-5176" cmd /k "cd /d G:\sl\shenglong-erp\server && node tests\role-agent\static-serve.js ..\admin\dist-local 5176 admin"

echo.
echo ==================================================
echo   All started. Three small windows opened:
echo     SL-API-3000   API server     http://127.0.0.1:3000
echo     SL-H5-5174    MiniApp H5     http://127.0.0.1:5174
echo     SL-Admin-5176 Admin console  http://127.0.0.1:5176/admin
echo.
echo   To STOP: just close those three windows.
echo   (They are independent of WorkBuddy now.)
echo ==================================================
timeout /t 3 /nobreak >nul
exit /b 0
