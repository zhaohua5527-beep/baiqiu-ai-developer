@echo off
setlocal EnableExtensions
set "SKILL_DIR=%USERPROFILE%\.claude\skills\taste-skill"
set "TMP_DIR=%USERPROFILE%\.claude\tmp-taste-skill"
set "REPO=https://github.com/Leonxlnx/taste-skill.git"

echo [1/5] Preparing directories...
if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%"
mkdir "%USERPROFILE%\.claude\skills" 2>nul

echo [2/5] Cloning %REPO%
git clone --depth 1 "%REPO%" "%TMP_DIR%"
if errorlevel 1 (
  echo Clone failed.
  exit /b 1
)

echo [3/5] Installing skill files...
if exist "%SKILL_DIR%" rmdir /s /q "%SKILL_DIR%"
mkdir "%SKILL_DIR%" 2>nul

if exist "%TMP_DIR%\SKILL.md" (
  xcopy /e /i /y "%TMP_DIR%\*" "%SKILL_DIR%\" >nul
) else if exist "%TMP_DIR%\skills\taste-skill\SKILL.md" (
  xcopy /e /i /y "%TMP_DIR%\skills\taste-skill\*" "%SKILL_DIR%\" >nul
) else if exist "%TMP_DIR%\taste-skill\SKILL.md" (
  xcopy /e /i /y "%TMP_DIR%\taste-skill\*" "%SKILL_DIR%\" >nul
) else (
  echo Could not find SKILL.md in repository layout.
  dir /s /b "%TMP_DIR%\SKILL.md"
  exit /b 2
)

echo [4/5] Cleaning temp clone...
rmdir /s /q "%TMP_DIR%"

echo [5/5] Installed to:
echo   %SKILL_DIR%
if exist "%SKILL_DIR%\SKILL.md" (
  echo SKILL.md found. Restart Claude Code or run /reload-plugins.
  exit /b 0
) else (
  echo SKILL.md missing after install.
  exit /b 3
)
