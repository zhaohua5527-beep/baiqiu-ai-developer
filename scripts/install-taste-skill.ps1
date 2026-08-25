$ErrorActionPreference = "Stop"

$skillDir = Join-Path $env:USERPROFILE ".claude\skills\taste-skill"
$tmpDir = Join-Path $env:USERPROFILE ".claude\tmp-taste-skill"
$repo = "https://github.com/Leonxlnx/taste-skill.git"

Write-Host "[1/5] Preparing directories..."
if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE ".claude\skills") | Out-Null

Write-Host "[2/5] Cloning $repo"
git clone --depth 1 $repo $tmpDir

Write-Host "[3/5] Installing skill files..."
if (Test-Path $skillDir) { Remove-Item -Recurse -Force $skillDir }
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null

$candidates = @(
  (Join-Path $tmpDir "SKILL.md"),
  (Join-Path $tmpDir "skills\taste-skill\SKILL.md"),
  (Join-Path $tmpDir "taste-skill\SKILL.md")
)

$source = $null
foreach ($c in $candidates) {
  if (Test-Path $c) {
    $source = Split-Path $c -Parent
    break
  }
}

if (-not $source) {
  Write-Host "Could not locate SKILL.md. Repository contents:"
  Get-ChildItem -Recurse $tmpDir | Select-Object -ExpandProperty FullName
  throw "SKILL.md not found"
}

Copy-Item -Path (Join-Path $source "*") -Destination $skillDir -Recurse -Force

Write-Host "[4/5] Cleaning temp clone..."
Remove-Item -Recurse -Force $tmpDir

Write-Host "[5/5] Installed to: $skillDir"
if (Test-Path (Join-Path $skillDir "SKILL.md")) {
  Write-Host "OK: SKILL.md found. Restart Claude Code or run /reload-plugins."
} else {
  throw "Install finished but SKILL.md is missing"
}
