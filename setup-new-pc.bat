@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required. Install the Node.js LTS version and try again.
    pause
    exit /b 1
)

if not exist "node_modules\mongoose" (
    echo Installing project dependencies...
    call npm install
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

set "MONGODB_URI=mongodb://127.0.0.1:27017/utsavfest"
node scripts\mongodb-transfer.js import
if errorlevel 1 (
    echo Start MongoDB Community Server and confirm the backup file is present, then retry.
    pause
    exit /b 1
)

echo Starting UtsavFest...
call npm start
