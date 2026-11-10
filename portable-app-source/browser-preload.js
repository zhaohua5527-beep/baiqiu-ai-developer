"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blackBallBrowser", {
  getState: () => ipcRenderer.invoke("black-ball-browser:get-state"),
  navigate: (target) => ipcRenderer.invoke("black-ball-browser:navigate", target),
  back: () => ipcRenderer.invoke("black-ball-browser:back"),
  forward: () => ipcRenderer.invoke("black-ball-browser:forward"),
  reload: () => ipcRenderer.invoke("black-ball-browser:reload"),
  stop: () => ipcRenderer.invoke("black-ball-browser:stop"),
  home: () => ipcRenderer.invoke("black-ball-browser:home"),
  closePage: () => ipcRenderer.invoke("black-ball-browser:close-page"),
  newTab: () => ipcRenderer.invoke("black-ball-browser:new-tab"),
  selectTab: (tabId) => ipcRenderer.invoke("black-ball-browser:select-tab", tabId),
  closeTab: (tabId) => ipcRenderer.invoke("black-ball-browser:close-tab", tabId),
  toggleBookmark: () => ipcRenderer.invoke("black-ball-browser:bookmark-toggle"),
  removeBookmark: (url) => ipcRenderer.invoke("black-ball-browser:bookmark-remove", url),
  listCredentials: () => ipcRenderer.invoke("black-ball-browser:credentials-list"),
  saveCredential: (payload) => ipcRenderer.invoke("black-ball-browser:credential-save", payload),
  fillCredential: (id) => ipcRenderer.invoke("black-ball-browser:credential-fill", id),
  deleteCredential: (id) => ipcRenderer.invoke("black-ball-browser:credential-delete", id),
  analyze: () => ipcRenderer.invoke("black-ball-browser:analyze-current"),
  openExternal: () => ipcRenderer.invoke("black-ball-browser:open-external"),
  onState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("black-ball-browser:state", listener);
    return () => ipcRenderer.removeListener("black-ball-browser:state", listener);
  }
});
