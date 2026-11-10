$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path $PSScriptRoot 'upgrade-build\nsis-fixture'
$fixture = Get-Content -LiteralPath (Join-Path $fixtureRoot 'fixture.json') -Raw | ConvertFrom-Json
$target = Join-Path $env:LOCALAPPDATA ('BaiqiuInstaller\fixture-' + (Get-Date -Format yyyyMMddHHmmss))
$reg = 'HKCU:\Software\' + $fixture.guid
$uninstallReg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $fixture.guid
if ((Test-Path $reg) -or (Test-Path $uninstallReg)) { throw '回归专用安装记录已存在，请先检查上次测试，避免覆盖。' }
$checks = 0
function Assert-Fixture($condition, $label) { if (-not $condition) { throw "FAIL: $label" }; $script:checks++ }
function Invoke-Fixture($file, $arguments) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru -WindowStyle Hidden
  if (-not $process.WaitForExit(60000)) { throw "测试安装器超时：$($process.Id)" }
  return $process.ExitCode
}
$first = Join-Path $fixtureRoot 'payload\Fixture-1.0.0.exe'
$second = Join-Path $fixtureRoot 'payload\Fixture-1.0.1.exe'
$arguments = '/S /currentuser /D=' + $target
Assert-Fixture ((Invoke-Fixture $first $arguments) -eq 0) 'fresh install exit'
Assert-Fixture ((Get-ItemProperty $reg).InstallLocation.TrimEnd('\') -eq $target) 'registry target'
Assert-Fixture ((Get-Content (Join-Path $target 'resources\app\package.json') -Raw | ConvertFrom-Json).version -eq '1.0.0') 'first version'
$holder = Start-Process -FilePath (Join-Path $target 'BaiqiuUpgradeFixture.exe') -PassThru -WindowStyle Hidden
try {
  Assert-Fixture ((Invoke-Fixture $second $arguments) -eq 20) 'running old version blocks upgrade'
  Assert-Fixture (-not $holder.HasExited) 'installer does not kill running process'
  Assert-Fixture ((Get-Content (Join-Path $target 'resources\app\package.json') -Raw | ConvertFrom-Json).version -eq '1.0.0') 'blocked install retains old files'
} finally { if (-not $holder.HasExited) { $holder.Kill(); $holder.WaitForExit() }; $holder.Dispose() }
Assert-Fixture ((Invoke-Fixture $second $arguments) -eq 0) 'upgrade exit'
Assert-Fixture ((Get-Content (Join-Path $target 'resources\app\package.json') -Raw | ConvertFrom-Json).version -eq '1.0.1') 'upgraded version'
Assert-Fixture ((Get-ItemProperty $uninstallReg).DisplayVersion -eq '1.0.1') 'uninstall record refreshed'
$shortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'BaiqiuUpgradeFixture.lnk'
$shell = New-Object -ComObject WScript.Shell
Assert-Fixture ($shell.CreateShortcut($shortcut).TargetPath -eq (Join-Path $target 'BaiqiuUpgradeFixture.exe')) 'desktop target'
$uninstaller = Join-Path $target 'Uninstall BaiqiuUpgradeFixture.exe'
Assert-Fixture (Test-Path -LiteralPath $uninstaller) 'uninstaller exists'
Assert-Fixture ((Invoke-Fixture $uninstaller ('/S _?=' + $target)) -eq 0) 'fixture uninstall works'
Assert-Fixture (-not (Test-Path $reg)) 'fixture registry removed'
Assert-Fixture (-not (Test-Path $uninstallReg)) 'fixture uninstall registry removed'
Write-Output "PASS NSIS checks=$checks; only isolated fixture appId/target/shortcuts used"
