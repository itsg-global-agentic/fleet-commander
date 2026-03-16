# Fleet Commander Launcher
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Fleet Commander" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
}

if (-not (Test-Path "dist/server/index.js")) {
    Write-Host "Building..." -ForegroundColor Yellow
    npm run build
}

Write-Host "Starting on http://localhost:4680" -ForegroundColor Green
Write-Host ""

# Open browser after delay
Start-Job -ScriptBlock { Start-Sleep 2; Start-Process "http://localhost:4680" } | Out-Null

# Run server
node dist/server/index.js
