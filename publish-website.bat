@echo off
rem PRO TAG: make your game a website friends can open (GitHub + Render, both free).
rem First time: follow the 2 steps it shows. Later: run it again to update the website.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required. Install it from https://www.python.org/downloads/
  pause
  exit /b 1
)
python tools\publish_website.py %*
pause
