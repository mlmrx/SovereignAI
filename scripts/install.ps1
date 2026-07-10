# SovereignAI installer for Windows.
#   irm https://raw.githubusercontent.com/mlmrx/SovereignAI/main/scripts/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo = 'mlmrx/SovereignAI'
$dest = Join-Path $env:LOCALAPPDATA 'SovereignAI'

Write-Host "`n  ⬡ SovereignAI installer" -ForegroundColor Yellow

# 1. Node 22.5+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  Node.js not found. Install Node 22+ from https://nodejs.org first." -ForegroundColor Red
  exit 1
}
$version = (node --version).TrimStart('v')
if ([version]$version -lt [version]'22.5.0') {
  Write-Host "  Node $version found, but 22.5+ is required. Update at https://nodejs.org" -ForegroundColor Red
  exit 1
}

# 2. Fetch source (git if present, zip otherwise)
if (Test-Path $dest) {
  Write-Host "  Updating existing install at $dest"
  if (Test-Path (Join-Path $dest '.git')) { git -C $dest pull --quiet }
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  git clone --quiet "https://github.com/$repo" $dest
} else {
  $zip = Join-Path $env:TEMP 'sovereignai.zip'
  Invoke-WebRequest "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zip
  Expand-Archive $zip (Join-Path $env:TEMP 'sovereignai-x') -Force
  Move-Item (Join-Path $env:TEMP 'sovereignai-x\SovereignAI-main') $dest
}

# 3. Shim on PATH
$binDir = Join-Path $dest 'shim'
New-Item -ItemType Directory -Force $binDir | Out-Null
@"
@echo off
node --no-warnings "$dest\bin\sovereign.js" %*
"@ | Set-Content (Join-Path $binDir 'sovereign.cmd') -Encoding ascii

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Write-Host "  Added to PATH (new terminals will pick it up)"
}

Write-Host @"

  Installed to $dest

  Start your AI:     sovereign start
  Then open:         http://127.0.0.1:4321
  Local models:      install Ollama from https://ollama.com and 'ollama pull llama3.1'

  Your models. Your memory. Your machine.
"@ -ForegroundColor Green
