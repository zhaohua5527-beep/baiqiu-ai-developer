"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function normalizeApplication(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["calculator", "calc", "计算器"].includes(text)) return "calculator";
  if (["wps", "wps office", "金山", "金山办公"].includes(text)) return "wps";
  return "";
}

function wpsCandidates(environment = process.env) {
  const roots = [
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.LOCALAPPDATA
  ].filter(Boolean);
  const relativePaths = [
    ["Kingsoft", "WPS Office", "ksolaunch.exe"],
    ["Kingsoft", "WPS Office", "office6", "ksolaunch.exe"],
    ["Kingsoft", "WPS Office", "wps.exe"],
    ["Kingsoft", "WPS Office", "office6", "wps.exe"],
    ["Kingsoft", "WPS Office", "et.exe"],
    ["Kingsoft", "WPS Office", "office6", "et.exe"]
  ];
  return [...new Set(roots.flatMap((root) => relativePaths.map((parts) => path.join(root, ...parts))))];
}

function firstExistingPath(candidates = [], exists = fs.existsSync) {
  return candidates.find((candidate) => exists(candidate)) || "";
}

function launchDetached(command, args = [], spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref?.();
      resolve({ pid: Number(child.pid || 0), command, args });
    });
  });
}

async function launchWindowsApplication(application, options = {}) {
  const app = normalizeApplication(application);
  const exists = options.exists || fs.existsSync;
  const spawnProcess = options.spawn || spawn;
  if (!app) throw new Error("Unsupported Windows application");
  if (app === "calculator") {
    const launched = await launchDetached("calc.exe", [], spawnProcess);
    return { application: app, executable: "calc.exe", ...launched };
  }
  const executable = firstExistingPath(wpsCandidates(options.environment || process.env), exists);
  if (!executable) throw new Error("未检测到 WPS 安装位置，请先安装 WPS Office 后重试。");
  const launched = await launchDetached(executable, [], spawnProcess);
  return { application: app, executable, ...launched };
}

module.exports = {
  normalizeApplication,
  wpsCandidates,
  firstExistingPath,
  launchWindowsApplication
};
