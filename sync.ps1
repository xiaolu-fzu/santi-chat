<#
  sync.ps1 - copy publishable assets from the RAG project into this repo (root level).
  NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as ANSI unless it has a
  BOM, so any non-ASCII character here breaks the parser.

  Usage:  .\sync.ps1
  Then:   git add -A ; git commit -m "..." ; git push
#>
$ErrorActionPreference = 'Continue'
$RAG = Join-Path (Split-Path $PSScriptRoot -Parent) 'RAG'
if (-not (Test-Path $RAG)) { Write-Host "RAG dir not found: $RAG" -ForegroundColor Red; exit 1 }
# Source root: the santi subproject. The RAG tree was reorganised into
# santi/ + nianbao/ + shared root, so these used to be RAG\web and RAG\demo.
# Guard below makes a future move fail loudly instead of silently syncing nothing.
$SRC = Join-Path $RAG 'santi'
if (-not (Test-Path $SRC)) { Write-Host "santi source dir not found: $SRC" -ForegroundColor Red; exit 1 }
foreach ($d in @('web','demo')) {
    if (-not (Test-Path (Join-Path $SRC $d))) {
        Write-Host "missing source subdir: $SRC\$d" -ForegroundColor Red; exit 1
    }
}
$ROOT = $PSScriptRoot

Write-Host "== 1/5 fonts ==" -ForegroundColor Cyan
$fx = Join-Path $ROOT 'fonts'
New-Item -ItemType Directory -Force -Path $fx | Out-Null
# noto-serif-sc is unused now (pages moved to sans-serif): do not publish it
Get-ChildItem (Join-Path $SRC 'web\fonts') | Where-Object { $_.Name -notlike 'noto-serif-sc*' } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $fx -Recurse -Force
}
Write-Host ("   {0} font chunks" -f (Get-ChildItem $fx -Recurse -File).Count)

Write-Host "== 2/5 ragdata ==" -ForegroundColor Cyan
$rd = Join-Path $ROOT 'ragdata'
if (Test-Path $rd) { Remove-Item $rd -Recurse -Force }
New-Item -ItemType Directory -Force -Path $rd | Out-Null
Copy-Item -Path (Join-Path $SRC 'web\ragdata\*') -Destination $rd -Recurse -Force
Write-Host ("   ragdata {0} MB" -f [math]::Round(((Get-ChildItem $rd -Recurse -File | Measure-Object Length -Sum).Sum/1MB),2))

Write-Host "== 3/5 chat page ==" -ForegroundColor Cyan
Copy-Item -Path (Join-Path $SRC 'web\chat.html') -Destination (Join-Path $ROOT 'chat.html') -Force

Write-Host "== 4/5 showcase -> index.html ==" -ForegroundColor Cyan
$show = Get-Content (Join-Path $SRC 'demo\characters.html') -Raw -Encoding UTF8
$show = $show -replace '\.\./web/fonts/', 'fonts/'
Set-Content (Join-Path $ROOT 'index.html') $show -Encoding UTF8 -NoNewline
Copy-Item -Path (Join-Path $SRC 'demo\char_demo.js') -Destination (Join-Path $ROOT 'char_demo.js') -Force

Write-Host "== 5/5 check ==" -ForegroundColor Cyan
$need = @('index.html','chat.html','char_demo.js','ragdata\rag-client.js','ragdata\manifest.json',
          'ragdata\vectors.bin','ragdata\chunks.json','ragdata\personas.json',
          'ragdata\models\bge-small-zh-v1.5\onnx\model_quantized.onnx',
          'ragdata\lib\transformers.min.js',
          'ragdata\lib\ort-wasm-simd-threaded.jsep.mjs',
          'ragdata\lib\ort-wasm-simd-threaded.jsep.wasm',
          'fonts\noto-sans-sc.css')
$bad = 0
foreach ($f in $need) {
    $p = Join-Path $ROOT $f
    if (Test-Path $p) { Write-Host ("   OK       {0,-56} {1,9:N1} KB" -f $f, ((Get-Item $p).Length/1KB)) }
    else { Write-Host ("   MISSING  {0}" -f $f) -ForegroundColor Red; $bad++ }
}
$tot = [math]::Round(((Get-ChildItem $ROOT -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\|\\dist\\|\\\.wrangler\\' } | Measure-Object Length -Sum).Sum/1MB),2)
Write-Host ""
Write-Host "repo total: $tot MB" -ForegroundColor Green
if ($bad -gt 0) { exit 1 }
