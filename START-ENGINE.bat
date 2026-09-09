@echo off
title VyaparTrack Engine + Tunnel
cd /d "%~dp0"

echo Starting VyaparTrack engine...
start "VyaparTrack Engine" /min cmd /c "npm start"

timeout /t 8 /nobreak >nul

echo Starting Cloudflare tunnel...
start "VyaparTrack Tunnel" /min cmd /c "cloudflared tunnel --url http://localhost:3000"

timeout /t 12 /nobreak >nul

echo.
echo ============================================================
echo  NEW TUNNEL URL (each restart gets a new one):
echo ============================================================
for /f "tokens=*" %%u in ('powershell -NoProfile -Command "Select-String -Path tunnel.err.log,tunnel.out.log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1 | ForEach-Object { $_.Matches[0].Value }"') do set TUNNEL_URL=%%u
echo  %TUNNEL_URL%
echo.
echo IMPORTANT: if the URL changed, the APK needs updating
echo (Settings gear in the app lets you paste the new URL
echo  without reinstalling - or ask me to rebuild the APK).
echo.
echo Engine:  http://localhost:3000
echo Keep this window open. Closing it stops nothing,
echo but the two minimized windows ARE the server+tunnel.
echo ============================================================
pause
