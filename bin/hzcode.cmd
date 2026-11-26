@echo off
rem HorizonCode Windows launcher — preserves the --no-env-file trust boundary
rem (a workspace .env is never auto-loaded by Bun).
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "BUN_CMD=bun"
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "BUN_CMD=%USERPROFILE%\.bun\bin\bun.exe"
  )
)
"%BUN_CMD%" --no-env-file run "%ROOT%\app\src\main.ts" %*
exit /b %ERRORLEVEL%
