!macro customInstall
  RMDir /r "$DESKTOP\白球AI-客户端"
  RMDir /r "$DESKTOP\白球AI-开发者"
  RMDir /r "$DESKTOP\白球AI-update"
  Delete "$DESKTOP\启动白球AI-客户端.cmd"
  Delete "$DESKTOP\启动白球AI-开发者.cmd"
  Delete "$DESKTOP\白球AI（客户端）.lnk"
  Delete "$DESKTOP\白球AI（开发者）.lnk"
!macroend
