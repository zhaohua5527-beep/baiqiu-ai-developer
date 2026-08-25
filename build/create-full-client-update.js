"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return listFiles(root, child);
    if (!entry.isFile()) return [];
    if (child === "release-manifest.json") return [];
    const file = path.join(root, child);
    return [{
      path: child.replace(/\\/g, "/"),
      size: fs.statSync(file).size,
      sha256: sha256(file)
    }];
  });
}

function copyDirectory(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false
  });
}

function readVersion(clientDir) {
  const packageFile = path.join(clientDir, "resources", "app", "package.json");
  const versionFile = path.join(clientDir, "resources", "app", "version.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const version = String(pkg.version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:\.0)?(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version: ${version || "missing"}`);
  }
  if (fs.existsSync(versionFile)) {
    const metadata = JSON.parse(fs.readFileSync(versionFile, "utf8"));
    if (String(metadata.appVersion || "").trim() !== version) {
      throw new Error(`Version metadata mismatch: package=${version}, version.json=${metadata.appVersion || "missing"}`);
    }
  }
  return version;
}

function prepareReleaseVersion(clientDir, requestedVersion = "") {
  const sourceVersion = readVersion(clientDir);
  const releaseVersion = String(requestedVersion || sourceVersion).trim();
  if (!/^\d+\.\d+\.\d+(?:\.0)?$/.test(releaseVersion)) {
    throw new Error(`Invalid release version: ${releaseVersion || "missing"}`);
  }
  if (releaseVersion === sourceVersion) return releaseVersion;
  if (releaseVersion !== `${sourceVersion}.0`) {
    throw new Error(`A bridge release may only append .0 to the built version: ${sourceVersion} -> ${releaseVersion}`);
  }
  const packageFile = path.join(clientDir, "resources", "app", "package.json");
  const versionFile = path.join(clientDir, "resources", "app", "version.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const metadata = JSON.parse(fs.readFileSync(versionFile, "utf8"));
  pkg.version = releaseVersion;
  metadata.appVersion = releaseVersion;
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  fs.writeFileSync(versionFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return releaseVersion;
}

function findExecutable(clientDir) {
  const candidates = fs.readdirSync(clientDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name) && !/^uninstall/i.test(entry.name))
    .map((entry) => entry.name);
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one application executable, found: ${candidates.join(", ") || "none"}`);
  }
  return candidates[0];
}

function addLegacyExecutableAlias(clientDir, executable, compatibilityArg) {
  if (compatibilityArg !== "--legacy-exe-alias") return;
  const legacyName = "BaiqiuAI.exe";
  if (executable.toLowerCase() === legacyName.toLowerCase()) return;
  const legacyPath = path.join(clientDir, legacyName);
  if (fs.existsSync(legacyPath)) throw new Error(`Legacy executable alias already exists: ${legacyPath}`);
  fs.copyFileSync(path.join(clientDir, executable), legacyPath);
}

function main() {
  const [clientArg, outputArg, releaseVersionArg = "", compatibilityArg = ""] = process.argv.slice(2);
  if (!clientArg || !outputArg) {
    throw new Error("Usage: node build/create-full-client-update.js <win-unpacked> <output.zip> [release-version] [--legacy-exe-alias]");
  }
  const clientDir = path.resolve(clientArg);
  const outputFile = path.resolve(outputArg);
  if (!fs.existsSync(path.join(clientDir, "resources", "app", "main.js"))) {
    throw new Error("Client directory must be built with asar disabled and contain resources/app/main.js");
  }
  if (!fs.existsSync(path.join(clientDir, "resources", "hms-bundle", "hms-runtime.7z"))) {
    throw new Error("Client directory does not contain the embedded HMS runtime");
  }

  const version = prepareReleaseVersion(clientDir, releaseVersionArg);
  const executable = findExecutable(clientDir);
  addLegacyExecutableAlias(clientDir, executable, compatibilityArg);
  const executablePath = path.join(clientDir, executable);
  const manifest = {
    schemaVersion: 1,
    packageType: "full-client",
    version,
    createdAt: new Date().toISOString(),
    executable: {
      path: executable,
      size: fs.statSync(executablePath).size,
      sha256: sha256(executablePath)
    },
    files: listFiles(clientDir).sort((left, right) => left.path.localeCompare(right.path))
  };

  fs.writeFileSync(path.join(clientDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const stagingRoot = path.join(path.dirname(outputFile), `.update-stage-${version}`);
  const stagedClient = path.join(stagingRoot, "client");
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  copyDirectory(clientDir, stagedClient);
  fs.rmSync(outputFile, { force: true });
  const archive = spawnSync("tar.exe", [
    "-a",
    "-c",
    "-f",
    outputFile,
    "-C",
    stagingRoot,
    "client"
  ], {
    stdio: "inherit"
  });
  if (archive.status !== 0) throw new Error(`ZIP creation failed with exit code ${archive.status}`);
  const result = {
    version,
    packageType: manifest.packageType,
    executable,
    fileCount: manifest.files.length,
    outputFile,
    size: fs.statSync(outputFile).size,
    sha256: sha256(outputFile)
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
