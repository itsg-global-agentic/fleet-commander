@echo off
title Fleet Commander
cd /d "%~dp0"

:: Check if node_modules exists, install if not
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

:: Check if dist exists, build if not
if not exist "dist\server\index.js" (
    echo Building Fleet Commander...
    call npm run build
)

:: Initialize database if needed (just start server, it auto-creates)
echo Starting Fleet Commander...
echo.
echo   Dashboard: http://localhost:4680
echo.

:: Open browser after 2 second delay (in background)
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:4680"

:: Start server (foreground so window stays open)
node dist\server\index.js

:: If server exits, pause so user can see errors
echo.
echo Server stopped. Press any key to exit.
pause >nul
