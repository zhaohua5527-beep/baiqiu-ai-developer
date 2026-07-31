!macro customCheckAppRunning
  DetailPrint "Closing ${PRODUCT_NAME} before installation."

  ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  Sleep 800

  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    Sleep 1200
  ${EndIf}

  ${nsProcess::Unload}
!macroend
