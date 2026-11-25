@echo off
rem One-time setup for sapnote-cli: install deps + Chromium browser.
rem SAFE TO RE-RUN: finished steps are skipped automatically.
rem   - npm install is incremental (only missing packages are fetched)
rem   - playwright install skips browsers already fully installed
rem   - an interrupted download just re-downloads that one package
rem If it fails midway: fix the cause (network/proxy) and run this again.

setlocal
cd /d "%~dp0"

echo === sapnote-cli setup ===
echo This script is re-runnable: completed steps are skipped on retry.
echo.

echo [1/3] Checking npm dependencies...
if exist "node_modules\playwright\package.json" (
    echo       node_modules already present - skipping npm install.
) else (
    echo       installing npm dependencies, may take a few minutes...
    call npm install --no-audit --no-fund || goto :err
)

echo [2/3] Checking Chromium browser (playwright build 1255)...
if exist "%LOCALAPPDATA%\ms-playwright\chromium-1255\INSTALLATION_COMPLETE" (
    if exist "%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1255\INSTALLATION_COMPLETE" (
        echo       Chromium 1255 already installed - skipping download.
        goto :env
    )
)
echo       downloading Chromium (~200 MB)...
echo       Download source (auto-picked, first that works):
echo         1. npmmirror.com China CDN  - no proxy needed, fastest in CN
echo         2. cdn.playwright.dev       - needs proxy; its redirect target
echo           (storage.googleapis.com) is UNSTABLE in CN, causes ECONNRESET
if not defined PLAYWRIGHT_DOWNLOAD_HOST set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
if not defined HTTPS_PROXY echo       (no HTTPS_PROXY set - using China mirror directly^)
call npx playwright install chromium || goto :err

:env
echo [3/3] Credentials...
if exist ".env" (
    echo       .env already exists - keeping it.
) else (
    copy /y env-example.txt .env >nul && echo       created .env from template - EDIT IT with your S-User!
)

echo.
echo === setup complete ===
echo Try:  sapnote get 2744792
goto :eof

:err
echo.
echo setup.cmd failed.
echo If the error was ECONNRESET: the default route (storage.googleapis.com
echo via your proxy) is unstable. Force the China mirror and retry:
echo   set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
echo   setup.cmd
echo finished parts are kept; only unfinished packages re-download.
exit /b 1
