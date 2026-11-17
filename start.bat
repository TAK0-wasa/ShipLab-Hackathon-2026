@echo off
cd /d "%~dp0"
if not exist node_modules\electron\package.json (
  echo [1/2] npm install ...
  call npm install
  if errorlevel 1 goto :fail
)
if not exist node_modules\electron\dist\electron.exe (
  echo [2/2] Downloading Electron ...
  node node_modules\electron\install.js
  if errorlevel 1 goto :fail
)
if not exist node_modules\electron\dist\electron.exe goto :fail
call npm start -- %*
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo Failed. Please copy the messages above.
pause
exit /b 1
