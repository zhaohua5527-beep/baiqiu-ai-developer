$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'InstallerV3.cs'
$manifest = Join-Path $PSScriptRoot 'upgrade-build\bundle.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw '请先运行 build-upgrade.cjs 构建并校验正式安装包。' }
$bundle = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$bundle | Add-Member -NotePropertyName guid -NotePropertyValue '47e76a39-27f8-5672-b9b0-dc99c558e785' -Force
$payload = Join-Path $PSScriptRoot ('upgrade-build\payload\' + $bundle.installer)
if ((Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash -ne $bundle.hash) { throw '正式安装包与构建清单不一致。' }
$manifest = Join-Path $PSScriptRoot 'upgrade-build\bundle-embedded.json'
[IO.File]::WriteAllText($manifest, ($bundle | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding($false)))
$icon = Join-Path $PSScriptRoot 'baiqiu.ico'
$output = Join-Path $PSScriptRoot '安装白球AI.exe'
& $compiler /nologo /target:winexe /platform:anycpu ("/out:" + $output) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:Microsoft.CSharp.dll /reference:System.Web.Extensions.dll ("/resource:" + $manifest + ',bundle.json') ("/win32icon:" + $icon) $source
if ($LASTEXITCODE -ne 0) { throw '安装程序构建失败' }
Write-Output $output
