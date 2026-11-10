$ErrorActionPreference = "Stop"

$driveRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $driveRoot "白球AI便携版\app"
$target = Join-Path $env:LOCALAPPDATA "Programs\白球AI"
$executable = Join-Path $target "白球AI.exe"

if (-not (Test-Path -LiteralPath (Join-Path $source "白球AI.exe") -PathType Leaf)) {
    throw "找不到 F 盘中的白球AI程序：$source"
}

Write-Host "正在安装白球AI到：$target"
New-Item -ItemType Directory -Path $target -Force | Out-Null
& robocopy.exe $source $target /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP | Out-Host
if ($LASTEXITCODE -gt 7) {
    throw "程序复制失败，错误码：$LASTEXITCODE"
}

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null

foreach ($shortcutPath in @(
    (Join-Path $desktop "白球AI.lnk"),
    (Join-Path $startMenu "白球AI.lnk")
)) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $executable
    $shortcut.WorkingDirectory = $target
    $shortcut.IconLocation = "$executable,0"
    $shortcut.Description = "白球AI"
    $shortcut.Save()
}

Write-Host "安装完成。桌面快捷方式：$desktop\白球AI.lnk"
Write-Host "本次没有复制 F 盘中的聊天记录、记忆、API Key 或浏览器登录状态。"
Read-Host "按回车键退出"
