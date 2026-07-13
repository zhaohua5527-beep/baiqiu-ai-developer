Unicode true
!ifndef VERSION
!define VERSION "1.1.18"
!endif
Name "Baiqiu AI"
OutFile "BaiqiuAI-Setup-${VERSION}.exe"
Icon "..\assets\icon.ico"
InstallDir "$LOCALAPPDATA\BaiqiuAI"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
AutoCloseWindow false
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install Baiqiu AI"
  ExecWait '"$SYSDIR\taskkill.exe" /F /IM BaiqiuAI.exe'
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "portable\*.*"
  CreateShortCut "$DESKTOP\BaiqiuAI.lnk" "$INSTDIR\BaiqiuAI.exe" "" "$INSTDIR\BaiqiuAI.exe" 0
  CreateDirectory "$SMPROGRAMS\Baiqiu AI"
  CreateShortCut "$SMPROGRAMS\Baiqiu AI\BaiqiuAI.lnk" "$INSTDIR\BaiqiuAI.exe" "" "$INSTDIR\BaiqiuAI.exe" 0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI" "DisplayName" "Baiqiu AI"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI" "Publisher" "Baiqiu AI"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI" "DisplayIcon" "$INSTDIR\BaiqiuAI.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI" "NoRepair" 1
  Exec '"$INSTDIR\BaiqiuAI.exe"'
SectionEnd

Section "Uninstall"
  ExecWait '"$SYSDIR\taskkill.exe" /F /IM BaiqiuAI.exe'
  Delete "$DESKTOP\BaiqiuAI.lnk"
  Delete "$SMPROGRAMS\Baiqiu AI\BaiqiuAI.lnk"
  RMDir "$SMPROGRAMS\Baiqiu AI"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BaiqiuAI"
  RMDir /r "$INSTDIR"
SectionEnd
