@echo off
setlocal

cd /d "%~dp0"

echo WeChat Scraper Studio
echo ---------------------
echo Starting app...

if not exist node_modules\electron\package.json (
  echo Installing dependencies first...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    goto :end
  )
)

call npx electron .
if errorlevel 1 (
  echo Failed to start Electron.
)

:end
echo.
pause
endlocal
