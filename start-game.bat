@echo off
rem PRO TAG launcher: starts the game server and opens the game in your browser.
rem Double-click this file, or run it from a terminal. Close this window to stop the server.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
echo Starting PRO TAG...
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080"
python server\main.py %*
pause
