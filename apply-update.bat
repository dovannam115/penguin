@echo off
:: Penguin, apply update
:: User nhan duoc file zip (vd: mas-ai-office-20260520-1530.zip) tu nguoi gui,
:: copy zip vao folder nay, nhap dup file apply-update.bat.
::
:: Script: tim zip moi nhat trong folder, stop app, giai nen de len source,
:: chay npm install neu package.json thay doi, khoi dong lai.
:: KHONG dong toi .data/ (lich su chat, db, password) va password-backup.txt.

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   Penguin, apply update
echo ==========================================
echo.

:: Tim file zip mat khac, uu tien:
::   1. Penguin_v*.zip (current naming)
::   2. AGENT-P_v*.zip (legacy)
::   3. mas-ai-office-*.zip / agentp-update-*.zip / update-*.zip
::   4. Bat ky file *.zip nao trong folder neu khong match pattern tren
set "UPDATE_ZIP="
for /f "delims=" %%f in ('dir /b /o-d /a-d "Penguin_v*.zip" "AGENT-P_v*.zip" "mas-ai-office-*.zip" "agentp-update-*.zip" "update-*.zip" 2^>nul') do (
  if not defined UPDATE_ZIP set "UPDATE_ZIP=%%f"
)
if not defined UPDATE_ZIP (
  for /f "delims=" %%f in ('dir /b /o-d /a-d "*.zip" 2^>nul') do (
    if not defined UPDATE_ZIP set "UPDATE_ZIP=%%f"
  )
)

if not defined UPDATE_ZIP (
  echo [LOI] Khong tim thay file zip update nao trong folder nay.
  echo Hay copy file zip update vao folder Penguin, roi chay lai apply-update.bat.
  echo.
  pause
  exit /b 1
)

echo File update: %UPDATE_ZIP%
echo.
choice /m "Tien hanh cap nhat"
if errorlevel 2 (
  echo Da huy.
  exit /b 0
)

echo.
echo [1/4] Dung app Penguin...
if exist stop.bat (
  call stop.bat >nul 2>&1
)
:: Du chac chan, kill thu cong tien trinh dang giu port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING" 2^>nul') do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo [2/4] Sao luu danh sach file source hien tai...
:: Snapshot list of root files for diagnostics; .data is never touched.
dir /b /a-d > .last-update-source-list.txt 2>nul

echo [3/4] Giai nen %UPDATE_ZIP% de len source...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Expand-Archive -Path '%UPDATE_ZIP%' -DestinationPath '%CD%' -Force; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo [LOI] Giai nen that bai. Kiem tra file zip co bi corrupt khong.
  pause
  exit /b 1
)

echo [4/4] Cap nhat thu vien (npm install, co the mat 30-60 giay)...
call npm install --no-audit --no-fund --silent
if errorlevel 1 (
  echo [CANH BAO] npm install co loi, nhung van se thu khoi dong lai.
)

echo.
echo ==========================================
echo   Da cap nhat xong! Dang khoi dong lai...
echo ==========================================
echo.
start "" start.bat

:: Don dep file zip da apply (optional)
del "%UPDATE_ZIP%" >nul 2>&1

timeout /t 3 /nobreak >nul
endlocal
