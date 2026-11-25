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

if not defined MONGODB_URI set "MONGODB_URI=mongodb://127.0.0.1:27017/utsavfest"
node scripts\mongodb-transfer.js export
if errorlevel 1 (
    pause
    exit /b 1
)

echo Keep database-backup\utsavfest-backup.json private. It contains personal account data.
pause
