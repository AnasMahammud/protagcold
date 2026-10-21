@echo off
rem PRO TAG: host a game friends can join from ANYWHERE on the internet (no LAN, no port forwarding).
rem Starts the game server on this PC and a free Cloudflare tunnel, then prints a public link to share.
rem Close this window to stop hosting.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required. Install it from https://www.python.org/downloads/
  pause
  exit /b 1
)
python tools\online_host.py
pause
