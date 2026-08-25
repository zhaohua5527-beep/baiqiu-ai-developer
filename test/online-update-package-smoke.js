"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

async function main() {
  const [zipArg, rootArg, targetVersion = "3.0.4", updaterArg = ""] = process.argv.slice(2);
  if (!zipArg || !rootArg) {
    if (process.env.NODE_TEST_CONTEXT) {
      process.stdout.write("online-update-package-smoke requires an explicit update package; skipped during node --test discovery\n");
      return;
    }
    throw new Error("Usage: node test/online-update-package-smoke.js <package.zip> <empty-test-root> [target-version] [updater-module]");
  }
  const zip = path.resolve(zipArg);
  const root = path.resolve(rootArg);
  if (!fs.existsSync(zip)) throw new Error(`Missing update package: ${zip}`);
  if (fs.existsSync(root)) throw new Error(`Smoke test root already exists: ${root}`);

  const install = path.join(root, "installed");
  const userData = path.join(root, "user-data");
  const executable = path.join(install, "\u767d\u7403AI.exe");
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(executable, "simulated-3.0.3-executable", "utf8");

  const originalLoad = Module._load;
  Module._load = function loadElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getVersion: () => "3.0.3",
          getPath: (name) => name === "userData" ? userData : root
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const Updater = require(updaterArg ? path.resolve(updaterArg) : "../services/updater");
  Module._load = originalLoad;

  const updater = new Updater({
    currentVersion: "3.0.3",
    executablePath: executable,
    userDataPath: userData,
    downloadDir: path.join(userData, "updates"),
    processId: 0
  });
  const prepared = await updater.applyUpdate(zip, {
    version: targetVersion,
    oldVersion: "3.0.3",
    restart: false
  });
  const run = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    prepared.scriptPath
  ], { stdio: "inherit", timeout: 900000 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Update script failed with exit code ${run.status}`);

  const stateFile = path.join(userData, "updates", "update-state.json");
  const state = readJson(stateFile);
  const version = readJson(path.join(install, "resources", "app", "version.json"));
  const release = readJson(path.join(install, "release-manifest.json"));
  const hms = path.join(install, "resources", "hms-bundle", "hms-runtime.7z");
  const hmsEntry = release.files.find((entry) => entry.path === "resources/hms-bundle/hms-runtime.7z");

  if (state.status !== "completed") throw new Error(`Unexpected update state: ${state.status || "missing"}`);
  if (version.appVersion !== targetVersion) throw new Error(`Unexpected installed version: ${version.appVersion || "missing"}`);
  if (release.packageType !== "full-client" || release.version !== targetVersion) throw new Error("Release manifest was not installed");
  if (!hmsEntry || !fs.existsSync(hms) || sha256(hms) !== hmsEntry.sha256) throw new Error("Embedded HMS runtime was not installed intact");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    installedVersion: version.appVersion,
    executable: path.basename(executable),
    updateState: state.status,
    hmsBytes: fs.statSync(hms).size,
    fileCount: release.files.length
  })}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
