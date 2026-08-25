!macro customCheckAppRunning
  DetailPrint "Closing ${PRODUCT_NAME} before installation."
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  Sleep 1200
!macroend
