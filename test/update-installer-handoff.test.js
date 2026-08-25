"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  handoffPathForScript,
  scriptPathIdentity,
  clearInstallerHandoff,
  readInstallerHandoff,
  waitForInstallerHandoff
} = require("../services/update-installer-handoff");

function loadUpdater(userData) {
  const originalLoad = Module._load;
  const updaterPath = require.resolve("../services/updater");
  delete require.cache[updaterPath];
  Module._load = function loadElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getVersion: () => "3.0.10", getPath: () => userData } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../services/updater");
  } finally {
    Module._load = originalLoad;
  }
}

test("installer handoff accepts a matching script in a Chinese path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-handoff-"));
  const script = path.join(root, "白球AI", "updates", "update.ps1");
  const handoff = handoffPathForScript(script);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "# test", "utf8");
  fs.writeFileSync(handoff, `\uFEFF${JSON.stringify({ processId: 4321, scriptPath: script, version: "3.0.11" })}`, "utf8");
  try {
    assert.equal(readInstallerHandoff(script).processId, 4321);
    assert.equal((await waitForInstallerHandoff(script, { timeoutMs: 1000, pollMs: 25 })).version, "3.0.11");
    clearInstallerHandoff(script);
    assert.equal(fs.existsSync(handoff), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer handoff accepts the stable Base64 identity when PowerShell writes a garbled display path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-handoff-identity-"));
  const script = path.join(root, "白球AI", "updates", "update.ps1");
  const handoff = handoffPathForScript(script);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "# test", "utf8");
  fs.writeFileSync(handoff, JSON.stringify({
    processId: 4321,
    scriptPath: "C:\\garbled-path\\update.ps1",
    scriptPathBase64: scriptPathIdentity(script)
  }), "utf8");
  try {
    assert.equal(readInstallerHandoff(script).processId, 4321);
    assert.equal(readInstallerHandoff(script).scriptPath, path.resolve(script));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer handoff rejects stale or mismatched markers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-handoff-timeout-"));
  const script = path.join(root, "update.ps1");
  const handoff = handoffPathForScript(script);
  fs.writeFileSync(script, "# test", "utf8");
  fs.writeFileSync(handoff, JSON.stringify({ processId: 4321, scriptPath: path.join(root, "other.ps1") }), "utf8");
  try {
    assert.equal(readInstallerHandoff(script), null);
    await assert.rejects(
      waitForInstallerHandoff(script, { timeoutMs: 1000, pollMs: 25 }),
      /未确认启动/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("full update script emits a BOM and a unique installer handoff", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-handoff-script-"));
  const userData = path.join(root, "白球AI", "用户数据");
  const updates = path.join(userData, "updates");
  const install = path.join(root, "installed");
  const executable = path.join(install, "白球AI.exe");
  const packageFile = path.join(updates, "update.zip");
  fs.mkdirSync(updates, { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(executable, "old executable", "utf8");
  fs.writeFileSync(packageFile, "signed package placeholder", "utf8");
  try {
    const Updater = loadUpdater(userData);
    const updater = new Updater({
      currentVersion: "3.0.10",
      downloadDir: updates,
      statePath: path.join(updates, "update-state.json"),
      executablePath: executable,
      userDataPath: userData,
      processId: 0
    });
    const prepared = await updater.applyUpdate(packageFile, {
      version: "3.0.11",
      oldVersion: "3.0.10",
      restart: false
    });
    const scriptBytes = fs.readFileSync(prepared.scriptPath);
    const scriptText = scriptBytes.toString("utf8").replace(/^\uFEFF/, "");
    assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(prepared.handoffPath, handoffPathForScript(prepared.scriptPath));
    assert.match(scriptText, /\$handoffFile = \[System\.Text\.Encoding\]::UTF8/);
    assert.match(scriptText, /\$scriptIdentity = \[System\.Text\.Encoding\]::UTF8/);
    assert.match(scriptText, /\$scriptIdentityBase64 = '/);
    assert.match(scriptText, /processId = \$PID; scriptPath = \$scriptIdentity/);
    assert.match(scriptText, /Write-InstallerHandoff/);
    assert.match(scriptText, /\$manifestExecutablePath = \[string\]\$releaseManifest\.executable\.path/);
    assert.match(scriptText, /Get-SafeReleaseFile \$sourcePath \$manifestExecutablePath/);
    assert.match(scriptText, /当前启动的程序不是此更新包对应的正式版/);
    assert.doesNotMatch(scriptText, /Join-Path \$sourcePath 'BaiqiuAI\.exe'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main process launches the updater through WMI before it exits", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function runPreparedUpdateScript");
  const end = mainSource.indexOf("function ensureUpdater", start);
  const launcher = mainSource.slice(start, end);
  assert.match(launcher, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(launcher, /waitForInstallerHandoff\(script, \{ timeoutMs: 15000/);
  assert.doesNotMatch(launcher, /detached:\s*true/);
});

test("startup recovery clears a stale rollback after a full installer has upgraded the app", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function recoverInterruptedUpdate");
  const end = mainSource.indexOf("function runPreparedUpdateScript", start);
  const recovery = mainSource.slice(start, end);
  assert.match(recovery, /status === "rollback" && version && compareSemanticVersions\(installedVersion, version\) >= 0/);
  assert.match(recovery, /updateStatus: "completed"/);
  assert.match(recovery, /已清除旧失败状态/);
});
