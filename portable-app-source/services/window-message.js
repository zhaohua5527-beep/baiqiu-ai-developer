"use strict";

function safeWindowSend(windowRef, channel, ...args) {
  if (!windowRef || windowRef.isDestroyed?.()) return false;
  const contents = windowRef.webContents;
  if (!contents || contents.isDestroyed?.()) return false;
  try {
    contents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

module.exports = { safeWindowSend };
