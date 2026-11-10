@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装白球AI.ps1"
if errorlevel 1 (
  echo.
  echo 安装失败，请把这段错误信息发给我。
  pause
)
endlocal
