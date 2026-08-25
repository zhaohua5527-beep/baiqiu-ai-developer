"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function loadUpdater(userData) {
  const originalLoad = Module._load;
  const updaterPath = require.resolve("../services/updater");
  delete require.cache[updaterPath];
  Module._load = function loadElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getVersion: () => "3.0.5", getPath: () => userData } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../services/updater");
  } finally {
    Module._load = originalLoad;
  }
}

test("applyPatchUpdate replaces and deletes only declared files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-patch-apply-"));
  const install = path.join(root, "client");
  const userData = path.join(root, "user-data");
  const updates = path.join(userData, "updates");
  const mainFile = path.join(install, "resources", "app", "main.js");
  const versionFile = path.join(install, "resources", "app", "version.json");
  const removedFile = path.join(install, "resources", "app", "remove-me.txt");
  const releaseFile = path.join(install, "release-manifest.json");
  const executable = path.join(install, "BaiqiuAI.exe");
  fs.mkdirSync(path.dirname(mainFile), { recursive: true });
  fs.writeFileSync(mainFile, "old-main", "utf8");
  fs.writeFileSync(versionFile, JSON.stringify({ appVersion: "3.0.5" }), "utf8");
  fs.writeFileSync(removedFile, "delete-me", "utf8");
  fs.writeFileSync(releaseFile, JSON.stringify({ version: "3.0.5", packageType: "full-client" }), "utf8");
  fs.writeFileSync(executable, "not-a-real-executable", "utf8");

  const targetMain = Buffer.from("new-main", "utf8");
  const targetVersion = Buffer.from(JSON.stringify({ appVersion: "3.0.6" }), "utf8");
  const targetRelease = Buffer.from(JSON.stringify({ version: "3.0.6", packageType: "full-client" }), "utf8");
  const operations = [
    { path: "resources/app/main.js", before: fs.readFileSync(mainFile), after: targetMain, operation: "replace" },
    { path: "resources/app/version.json", before: fs.readFileSync(versionFile), after: targetVersion, operation: "replace" },
    { path: "resources/app/remove-me.txt", before: fs.readFileSync(removedFile), after: null, operation: "delete" },
    { path: "release-manifest.json", before: fs.readFileSync(releaseFile), after: targetRelease, operation: "replace" }
  ];
  const manifest = {
    schemaVersion: 1,
    packageType: "file-patch",
    fromVersion: "3.0.5",
    toVersion: "3.0.6",
    targetReleaseManifestSha256: sha256(targetRelease),
    files: operations.map((item) => ({
      path: item.path,
      operation: item.operation,
      before: { size: item.before.length, sha256: sha256(item.before) },
      after: item.after ? { size: item.after.length, sha256: sha256(item.after) } : null
    }))
  };
  const archive = new JSZip();
  archive.file("patch-manifest.json", JSON.stringify(manifest));
  for (const item of operations) {
    if (item.after) archive.file(`files/${item.path}`, item.after);
  }
  fs.mkdirSync(updates, { recursive: true });
  const packageFile = path.join(updates, "patch.zip");
  fs.writeFileSync(packageFile, await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

  try {
    const Updater = loadUpdater(userData);
    const updater = new Updater({
      currentVersion: "3.0.5",
      downloadDir: updates,
      statePath: path.join(updates, "update-state.json"),
      executablePath: executable,
      userDataPath: userData,
      processId: 0
    });
    const prepared = await updater.applyPatchUpdate(packageFile, {
      version: "3.0.6",
      oldVersion: "3.0.5",
      manifest,
      packageChecksum: sha256(fs.readFileSync(packageFile)),
      restart: false
    });
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", prepared.scriptPath], { timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, String(result.stderr || ""));
    assert.equal(fs.readFileSync(mainFile, "utf8"), "new-main");
    assert.deepEqual(JSON.parse(fs.readFileSync(versionFile, "utf8")), { appVersion: "3.0.6" });
    assert.equal(fs.existsSync(removedFile), false);
    const state = JSON.parse(fs.readFileSync(path.join(updates, "update-state.json"), "utf8").replace(/^\uFEFF/, ""));
    assert.equal(state.status, "completed");
    assert.equal(state.packageType, "file-patch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
