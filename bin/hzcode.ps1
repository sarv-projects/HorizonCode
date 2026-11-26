#!/usr/bin/env pwsh
# HorizonCode PowerShell launcher — preserves the --no-env-file trust boundary
# (a workspace .env is never auto-loaded by Bun).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($null -ne $BunCmd) {
  $Bun = $BunCmd.Source
} elseif (Test-Path (Join-Path $HOME ".bun\bin\bun.exe")) {
  $Bun = Join-Path $HOME ".bun\bin\bun.exe"
} else {
  $Bun = "bun"
}
& $Bun --no-env-file run (Join-Path $Root "app\src\main.ts") @args
exit $LASTEXITCODE
