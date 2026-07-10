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

# 2. Fetch source (git if present, archive refresh otherwise)
function Install-SourceArchive {
  $work = Join-Path $env:TEMP ("sovereignai-install-" + [guid]::NewGuid().ToString('N'))
  $zip = Join-Path $work 'sovereignai.zip'
  $extract = Join-Path $work 'source'
  New-Item -ItemType Directory -Force $work | Out-Null
  try {
    Invoke-WebRequest "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive $zip $extract -Force
    $source = Join-Path $extract 'SovereignAI-main'
    New-Item -ItemType Directory -Force $dest | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $dest -Recurse -Force
  } finally {
    if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  }
}

if (Test-Path (Join-Path $dest '.git')) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required to update the existing Git install at $dest."
  }
  Write-Host "  Updating existing Git install at $dest"
  git -C $dest pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { throw "Could not update $dest; resolve its Git changes and run the installer again." }
} elseif (Test-Path $dest) {
  Write-Host "  Refreshing existing archive install at $dest (config and data are preserved)"
  Install-SourceArchive
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  git clone --quiet "https://github.com/$repo" $dest
  if ($LASTEXITCODE -ne 0) { throw "Could not clone SovereignAI into $dest." }
} else {
  Install-SourceArchive
}

# 3. Shim on PATH
$binDir = Join-Path $dest 'shim'
New-Item -ItemType Directory -Force $binDir | Out-Null
@"
@echo off
if not defined SOVEREIGN_HOME set "SOVEREIGN_HOME=$dest"
node --no-warnings "$dest\bin\sovereign.js" %*
"@ | Set-Content (Join-Path $binDir 'sovereign.cmd') -Encoding ascii

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Write-Host "  Added to PATH (new terminals will pick it up)"
}

Write-Host @"

  Installed to $dest
  Config + data:     $dest  (override with SOVEREIGN_HOME for another instance)

  Start your AI:     sovereign start
  Then open:         http://127.0.0.1:4321
  Local models:      install Ollama from https://ollama.com and 'ollama pull llama3.1'

  Your models. Your memory. Your machine.
"@ -ForegroundColor Green
