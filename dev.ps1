<#
  dev.ps1 - build dist/ and run wrangler pages dev locally (ASCII only, see sync.ps1 note).
#>
$ErrorActionPreference = 'Stop'
$ROOT = $PSScriptRoot
$DIST = Join-Path $ROOT 'dist'

Write-Host "== build dist/ ==" -ForegroundColor Cyan
if (Test-Path $DIST) { Remove-Item $DIST -Recurse -Force }
New-Item -ItemType Directory -Force -Path $DIST | Out-Null
foreach ($item in @('index.html','chat.html','char_demo.js','fonts','ragdata')) {
    $src = Join-Path $ROOT $item
    if (Test-Path $src) { Copy-Item -Path $src -Destination $DIST -Recurse -Force }
    else { Write-Host "   missing: $item" -ForegroundColor Yellow }
}
Write-Host ("   dist/ {0} MB" -f [math]::Round(((Get-ChildItem $DIST -Recurse -File | Measure-Object Length -Sum).Sum/1MB),2))

if (-not (Test-Path (Join-Path $ROOT '.dev.vars'))) {
    Write-Host ""
    Write-Host "NOTE: .dev.vars not found. Copy .dev.vars.example to .dev.vars and fill in" -ForegroundColor Yellow
    Write-Host "      DEEPSEEK_API_KEY / ACCESS_CODE before running." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "== wrangler pages dev (http://127.0.0.1:8788) ==" -ForegroundColor Cyan
npx --yes wrangler@latest pages dev dist --port 8788
