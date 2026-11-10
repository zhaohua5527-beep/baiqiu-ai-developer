param(
  [string]$PackageRoot,
  [string]$ElectronPath,
  [string]$PythonPath,
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $PackageRoot) { $PackageRoot = Join-Path ([IO.Path]::GetPathRoot($PSScriptRoot)) '白球AI便携版\app\resources\app' }
if (-not $ElectronPath) { $ElectronPath = Join-Path $env:USERPROFILE 'Desktop\白球AI-正式软件仓库\source-current\node_modules\electron\dist\electron.exe' }
if (-not $PythonPath) { $PythonPath = (Get-Command python -ErrorAction Stop).Source }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot ('回归结果-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
foreach ($required in @($ElectronPath, $PythonPath, (Join-Path $PackageRoot 'renderer-v2\app.js'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少回归依赖：$required" }
}
if ((Split-Path $ElectronPath -Leaf) -ne 'electron.exe') { throw '请指定独立测试用 electron.exe，不要使用白球正式启动程序。' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stdout = Join-Path $OutputDirectory '界面回归.stdout.log'
$stderr = Join-Path $OutputDirectory '界面回归.stderr.log'
$screenshot = Join-Path $OutputDirectory '编辑界面.png'
$oldNodeMode = $env:ELECTRON_RUN_AS_NODE
$oldBaseline = $env:BAIQIU_CARD_BASELINE
try {
  $env:ELECTRON_RUN_AS_NODE = $null
  $env:BAIQIU_CARD_BASELINE = $null
  $arguments = @(('"' + (Join-Path $PSScriptRoot 'content-card.electron.cjs') + '"'), ('"' + $PackageRoot + '"'), ('"' + $screenshot + '"'))
  $process = Start-Process -FilePath $ElectronPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (-not $process.WaitForExit(30000)) { throw "隔离回归超时，测试进程号：$($process.Id)，请查看日志。" }
  Get-Content -LiteralPath $stdout
  if ($process.ExitCode -ne 0) { Get-Content -LiteralPath $stderr; throw '界面回归失败。' }
  & $PythonPath -B (Join-Path $PSScriptRoot 'code-block-edit-transport.py') ($screenshot + '.request.json') $PackageRoot
  if ($LASTEXITCODE -ne 0) { throw '黑球补充请求回归失败。' }
  Write-Output "回归完成。结果目录：$OutputDirectory；未联网调用模型，未重启正式客户端。"
} finally {
  $env:ELECTRON_RUN_AS_NODE = $oldNodeMode
  $env:BAIQIU_CARD_BASELINE = $oldBaseline
}
