$ErrorActionPreference = "Stop"

function U8($b64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }

$appRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $appRoot)
$desktop = [Environment]::GetFolderPath("Desktop")
$electronDist = Join-Path $appRoot "node_modules\electron\dist"
$fallbackElectronDist = Join-Path $repoRoot "work\openclaw-desktop\node_modules\electron\dist"
$namePrefix = U8 "55m955CDQUk="
$clientName = U8 "55m955CDQUkt5a6i5oi356uv"
$devName = U8 "55m955CDQUkt5byA5Y+R6ICF"
$clientLinkName = U8 "55m955CDQUnvvIjlrqLmiLfnq6/vvIkubG5r"
$devLinkName = U8 "55m955CDQUnvvIjlvIDlj5HogIXvvIkubG5r"
$clientRoot = Join-Path $desktop $clientName
$devRoot = Join-Path $desktop $devName
$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) $namePrefix
$version = (Get-Content -LiteralPath (Join-Path $appRoot "package.json") -Raw | ConvertFrom-Json).version

function Stop-BaiqiuProcesses {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -like "Baiqiu*" -or $_.ProcessName -like ($namePrefix + "*") } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

function Clear-Directory($path) {
  if (Test-Path -LiteralPath $path) {
    $empty = Join-Path $env:TEMP ("baiqiu-empty-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    robocopy $empty $path /MIR | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Failed to clear $path : robocopy exit $LASTEXITCODE" }
    Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path $path | Out-Null
}

function Copy-AppPortable($targetRoot, [bool]$isDev) {
  Clear-Directory $targetRoot
  robocopy $electronDist $targetRoot /MIR | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Failed to copy Electron runtime to $targetRoot : $LASTEXITCODE" }
  $appOut = Join-Path $targetRoot "resources\app"
  New-Item -ItemType Directory -Force -Path $appOut | Out-Null
  robocopy $appRoot $appOut /MIR /XD ".git" "dist" "server\releases" /XF "package-lock.json" | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Failed to copy Baiqiu app to $appOut : $LASTEXITCODE" }
  @{
    appVersion = $version
    build = (Get-Date).ToString("yyyyMMdd")
    channel = $(if ($isDev) { "dev" } else { "customer" })
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $appOut "version.json") -Encoding UTF8
  $electronExe = Join-Path $targetRoot "electron.exe"
  $namedExe = Join-Path $targetRoot "BaiqiuAI.exe"
  if (Test-Path -LiteralPath $electronExe) {
    if (Test-Path -LiteralPath $namedExe) { Remove-Item -LiteralPath $namedExe -Force -ErrorAction SilentlyContinue }
    Rename-Item -LiteralPath $electronExe -NewName "BaiqiuAI.exe"
  }
  @{
    mode = $(if ($isDev) { "dev" } else { "client" })
    version = $version
    generatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $targetRoot "baiqiu-mode.json") -Encoding UTF8
}

function New-Shortcut($linkPath, $targetRoot, [bool]$isDev) {
  $target = Join-Path $targetRoot "BaiqiuAI.exe"
  $ws = New-Object -ComObject WScript.Shell
  $link = $ws.CreateShortcut($linkPath)
  $link.TargetPath = $target
  $link.WorkingDirectory = $targetRoot
  $link.Arguments = $(if ($isDev) { "--dev" } else { "" })
  $link.Save()
}

if (!(Test-Path $electronDist) -and (Test-Path $fallbackElectronDist)) { $electronDist = $fallbackElectronDist }
if (!(Test-Path $electronDist)) { throw "Electron runtime was not found." }

Stop-BaiqiuProcesses
Copy-AppPortable $clientRoot $false
Copy-AppPortable $devRoot $true
New-Shortcut (Join-Path $desktop $clientLinkName) $clientRoot $false
New-Shortcut (Join-Path $desktop $devLinkName) $devRoot $true
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
New-Shortcut (Join-Path $startMenu $clientLinkName) $clientRoot $false
New-Shortcut (Join-Path $startMenu $devLinkName) $devRoot $true
Write-Host "Client -> $clientRoot"
Write-Host "Dev    -> $devRoot"
Write-Host "No installer or update package was created."
