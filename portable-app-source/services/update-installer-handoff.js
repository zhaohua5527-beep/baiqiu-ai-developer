"use strict";

const fs = require("node:fs");
const path = require("node:path");

function handoffPathForScript(scriptPath = "") {
  const script = path.resolve(String(scriptPath || ""));
  return path.join(path.dirname(script), "installer-started.json");
}

function scriptPathIdentity(scriptPath = "") {
  return Buffer.from(path.resolve(String(scriptPath || "")), "utf8").toString("base64");
}

function clearInstallerHandoff(scriptPath = "") {
  fs.rmSync(handoffPathForScript(scriptPath), { force: true });
}

function readInstallerHandoff(scriptPath = "") {
  try {
    const expectedScript = path.resolve(String(scriptPath || ""));
    const value = JSON.parse(fs.readFileSync(handoffPathForScript(expectedScript), "utf8").replace(/^\uFEFF/, ""));
    if (!Number.isInteger(Number(value.processId)) || Number(value.processId) <= 0) return null;
    const expectedIdentity = scriptPathIdentity(expectedScript);
    if (value.scriptPathBase64) {
      if (String(value.scriptPathBase64) !== expectedIdentity) return null;
      return { ...value, processId: Number(value.processId), scriptPath: expectedScript, scriptPathBase64: expectedIdentity };
    }
    const actualScript = path.resolve(String(value.scriptPath || ""));
    if (actualScript.toLowerCase() !== expectedScript.toLowerCase()) return null;
    return { ...value, processId: Number(value.processId), scriptPath: actualScript, scriptPathBase64: expectedIdentity };
  } catch {
    return null;
  }
}

function waitForInstallerHandoff(scriptPath = "", { timeoutMs = 15000, pollMs = 100 } = {}) {
  const timeout = Math.max(1000, Number(timeoutMs) || 15000);
  const interval = Math.max(25, Number(pollMs) || 100);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const handoff = readInstallerHandoff(scriptPath);
      if (handoff) {
        resolve(handoff);
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`更新安装器在 ${timeout}ms 内未确认启动。`));
        return;
      }
      setTimeout(poll, interval);
    };
    poll();
  });
}

module.exports = {
  handoffPathForScript,
  scriptPathIdentity,
  clearInstallerHandoff,
  readInstallerHandoff,
  waitForInstallerHandoff
};
