@echo off
rem PRO TAG LAN server: lets other computers on your network join.
rem They open the http://<your-ip>:8080 address printed below in their browser.
rem Windows may ask whether to allow Python through the firewall: allow it on PRIVATE networks.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required. Install it from https://www.python.org/downloads/
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080"
python server\main.py --host 0.0.0.0 %*
pause
