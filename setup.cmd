@echo off
rem One-time setup for sapnote-cli: install deps + Chromium browser
rem (browser goes to %LOCALAPPDATA%\ms-playwright, not this folder)
echo [1/2] Installing npm dependencies (may take a few minutes)...
call npm install || goto :err
echo [2/2] Installing Chromium browser (~90 MB, set HTTPS_PROXY if behind a firewall)...
call npx playwright install chromium || goto :err
echo.
echo Done. Configure credentials then run:
echo   copy env-example.txt .env      (edit with your S-User)
echo   sapnote get 2744792
goto :eof

:err
echo Setup failed. Check npm/node installation and network (proxy).
exit /b 1
