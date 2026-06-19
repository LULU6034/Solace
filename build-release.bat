@echo off
cd /d D:\Project\ai-desktop-pet-electron
set GH_TOKEN=%GH_TOKEN%
set NODE_TLS_REJECT_UNAUTHORIZED=0
set PATH=C:\Windows\System32\WindowsPowerShell\v1.0;%PATH%
call npx electron-builder --publish always --config.npmRebuild=false
echo.
echo Done. Check release/ folder.
pause
