[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$')]
    [string]$Version,

    [Parameter(Mandatory)]
    [string]$ZipPath,

    [Parameter(Mandatory)]
    [string]$InstallerPath,

    [Parameter(Mandatory)]
    [string]$ManifestPath,

    [Parameter(Mandatory)]
    [ValidateLength(1, 4000)]
    [string]$Notes,

    [switch]$ForceUpdate,

    [string]$HostName = '47.108.191.67',
    [string]$UserName = 'baiqiu-deploy',
    [string]$KeyPath = "$env:USERPROFILE\.ssh\baiqiu-deploy-ed25519"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-File([string]$Path, [string]$Extension) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "File not found: $Path"
    }
    if ([IO.Path]::GetExtension($resolved).ToLowerInvariant() -ne $Extension) {
        throw "Expected a $Extension file: $resolved"
    }
    return $resolved
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE"
    }
}

function Quote-Posix([string]$Value) {
    return "'" + $Value.Replace("'", "'`"'`"'") + "'"
}

$zip = Require-File $ZipPath '.zip'
$installer = Require-File $InstallerPath '.exe'
$signedManifest = Require-File $ManifestPath '.json'
$key = Require-File $KeyPath ''

$remote = "$UserName@$HostName"
$remoteZip = "baiqiu-upload-$Version.zip"
$remoteInstaller = "baiqiu-upload-$Version.exe"
$remoteManifest = "baiqiu-upload-$Version.json"
$sshOptions = @('-i', $key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new')

Write-Host "Uploading ZIP for v$Version..."
Invoke-Checked 'scp.exe' ($sshOptions + @($zip, "${remote}:/opt/baiqiu-update/incoming/$remoteZip"))

Write-Host "Uploading installer for v$Version..."
Invoke-Checked 'scp.exe' ($sshOptions + @($installer, "${remote}:/opt/baiqiu-update/incoming/$remoteInstaller"))

Write-Host "Uploading signed manifest for v$Version..."
Invoke-Checked 'scp.exe' ($sshOptions + @($signedManifest, "${remote}:/opt/baiqiu-update/incoming/$remoteManifest"))

$publishArgs = @(
    'sudo', '/usr/local/sbin/baiqiu-publish',
    '--version', $Version,
    '--zip', $remoteZip,
    '--installer', $remoteInstaller,
    '--manifest', $remoteManifest,
    '--notes', $Notes
)
if ($ForceUpdate) {
    $publishArgs += '--force-update'
}
$remoteCommand = ($publishArgs | ForEach-Object { Quote-Posix ([string]$_) }) -join ' '

Write-Host "Publishing v$Version..."
Invoke-Checked 'ssh.exe' ($sshOptions + @($remote, $remoteCommand))

$manifestJson = & ssh.exe @sshOptions $remote "curl -fsS http://127.0.0.1:18790/update.json"
if ($LASTEXITCODE -ne 0) {
    throw "Published, but could not read the live update manifest."
}
$live = $manifestJson | ConvertFrom-Json
if ($live.latestVersion -ne $Version) {
    throw "Published, but live manifest reports v$($live.latestVersion), expected v$Version."
}
if ($live.schemaVersion -ne 1 -or $live.manifestType -ne 'baiqiu-online-update') {
    throw 'Published, but the live update manifest schema is invalid.'
}
if ($live.signature.algorithm -ne 'ed25519' -or -not $live.signature.value) {
    throw 'Published, but the live update manifest is unsigned.'
}
if ([bool]$live.forceUpdate -ne [bool]$ForceUpdate) {
    throw 'Published, but the live forceUpdate value does not match the requested release.'
}
$localZipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
if ([string]$live.sha256 -ne $localZipHash) {
    throw 'Published, but the live ZIP hash does not match the local release.'
}

Write-Host "Published v$Version successfully."
Write-Host "Installer: $($live.installerUrl)"
