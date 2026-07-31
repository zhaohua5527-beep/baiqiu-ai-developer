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
  analyze: () => ipcRenderer.invoke("black-ball-browser:analyze-current"),
  openExternal: () => ipcRenderer.invoke("black-ball-browser:open-external"),
  onState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("black-ball-browser:state", listener);
    return () => ipcRenderer.removeListener("black-ball-browser:state", listener);
  }
});
