!macro customCheckAppRunning
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 603
      ${Break}
    ${EndIf}
    ${If} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "无法确认白球AI是否已退出，请检查进程权限后重试。" /SD IDOK
      SetErrorLevel 21
      Quit
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "白球AI仍在运行。请先保存任务，从托盘菜单退出白球，再点击重试。安装程序不会强制结束任务。" /SD IDCANCEL IDRETRY +3
    SetErrorLevel 20
    Quit
  ${Loop}
!macroend
