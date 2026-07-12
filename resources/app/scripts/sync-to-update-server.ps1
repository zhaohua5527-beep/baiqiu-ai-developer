param(
  [string]$Version = "",
  [string]$HostName = "108.187.15.86",
  [string]$User = "root",
  [int]$Port = 22,
  [string]$KeyPath = "",
  [string]$RemoteDir = "/opt/baiqiu-update"
)

$ErrorActionPreference = "Stop"

function First-Value([object[]]$Values, [string]$Fallback = "") {
  foreach ($value in $Values) {
    if ($null -ne $value -and "$value".Trim()) { return "$value".Trim() }
  }
  return $Fallback
}

function Remote-Quote([string]$Value) {
  return "'" + ($Value -replace "'", "'\''") + "'"
}

function Run-Step([string]$Name, [string]$Exe, [string[]]$Args) {
  Write-Host "==> $Name"
  & $Exe @Args
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

$appRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $appRoot "server"
$configPath = First-Value @($env:BAIQIU_SSH_CONFIG, "D:\BaiQiuAI\data\deploy\ssh-deploy.json")
if (Test-Path -LiteralPath $configPath) {
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
  $config = [pscustomobject]@{}
}

$HostName = First-Value @($env:BAIQIU_SSH_HOST, $config.host, $HostName) "108.187.15.86"
$User = First-Value @($env:BAIQIU_SSH_USER, $config.user, $User) "root"
$Port = [int](First-Value @($env:BAIQIU_SSH_PORT, $config.port, $Port) "22")
$KeyPath = First-Value @($env:BAIQIU_SSH_KEY, $env:BAIQIU_SSH_KEY_PATH, $config.keyPath, $KeyPath)
$RemoteDir = First-Value @($env:BAIQIU_SSH_REMOTE_DIR, $config.remoteDir, $RemoteDir) "/opt/baiqiu-update"

if (!$KeyPath) { throw "Missing SSH keyPath. Add a deploy key to $configPath or set BAIQIU_SSH_KEY." }
if (!(Test-Path -LiteralPath $KeyPath)) { throw "SSH keyPath does not exist: $KeyPath" }
if (!(Test-Path -LiteralPath (Join-Path $serverRoot "updates.json"))) { throw "Missing server\updates.json. Publish a version first." }

$target = "$User@$HostName"
$remoteTmp = "$RemoteDir/.deploy-tmp"
$sshCommon = @("-p", "$Port", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-i", $KeyPath)
$scpCommon = @("-P", "$Port", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-i", $KeyPath)

$remoteDirQ = Remote-Quote $RemoteDir
$remoteTmpQ = Remote-Quote $remoteTmp
Run-Step "prepare remote update directory" "ssh.exe" ($sshCommon + @($target, "mkdir -p $remoteTmpQ $remoteDirQ/releases"))

foreach ($file in @("updates.json", "update.json")) {
  $source = Join-Path $serverRoot $file
  if (Test-Path -LiteralPath $source) {
    Run-Step "upload $file" "scp.exe" ($scpCommon + @($source, "\${target}:$remoteTmp/$file"))
  }
}

$localReleases = Join-Path $serverRoot "releases"
if (Test-Path -LiteralPath $localReleases) {
  Run-Step "upload releases" "scp.exe" ($scpCommon + @("-r", "$localReleases\*", "\${target}:$remoteTmp/releases/"))
}

$installCommand = @(
  "set -e",
  "mkdir -p $remoteDirQ/releases",
  "if [ -f $remoteTmpQ/updates.json ]; then cp $remoteTmpQ/updates.json $remoteDirQ/updates.json; fi",
  "if [ -f $remoteTmpQ/update.json ]; then cp $remoteTmpQ/update.json $remoteDirQ/update.json; fi",
  "if [ -d $remoteTmpQ/releases ]; then cp -R $remoteTmpQ/releases/. $remoteDirQ/releases/; fi",
  "rm -rf $remoteTmpQ"
) -join "; "
Run-Step "activate remote files" "ssh.exe" ($sshCommon + @($target, $installCommand))

$stateDir = "D:\BaiQiuAI\data\deploy"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
  status = "synced"
  version = $Version
  deployedAt = (Get-Date).ToString("o")
  remote = "\${target}:$RemoteDir"
  url = "http://108.187.15.86:18790/"
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stateDir "last-deploy.json") -Encoding UTF8

Write-Host "Synced to http://108.187.15.86:18790/"
Write-Host "Remote: \${target}:$RemoteDir"
Write-Host "Version: $Version"
