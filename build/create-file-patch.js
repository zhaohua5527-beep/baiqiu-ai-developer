"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { signPatchManifest } = require("../services/patch-update");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function releaseFiles(clientRoot) {
  const releasePath = path.join(clientRoot, "release-manifest.json");
  const release = readJson(releasePath);
  if (release.packageType !== "full-client" || !release.version || !Array.isArray(release.files)) throw new Error(`Invalid full release manifest: ${releasePath}`);
  const entries = new Map(release.files.map((file) => [file.path, { ...file }]));
  entries.set("release-manifest.json", {
    path: "release-manifest.json",
    size: fs.statSync(releasePath).size,
    sha256: sha256(releasePath)
  });
  return { release, entries };
}

function validRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized || normalized.includes("../") || normalized.startsWith("/")) throw new Error(`Unsafe release file path: ${value}`);
  return normalized;
}

function copyPatchFile(stageRoot, targetRoot, relativePath) {
  const source = path.join(targetRoot, relativePath);
  if (!fs.existsSync(source)) throw new Error(`Target release file is missing: ${relativePath}`);
  const output = path.join(stageRoot, "files", relativePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(source, output);
}

function archive(stageRoot, outputFile) {
  fs.rmSync(outputFile, { force: true });
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Compress-Archive -Path .\\* -DestinationPath $env:BAIQIU_PATCH_OUTPUT -CompressionLevel Optimal -Force"
  ], {
    cwd: stageRoot,
    env: { ...process.env, BAIQIU_PATCH_OUTPUT: outputFile },
    stdio: "inherit"
  });
  if (result.status !== 0) throw new Error(`Patch ZIP creation failed with exit code ${result.status}`);
}

function main() {
  const [baseArg, targetArg, outputArg, privateKeyArg] = process.argv.slice(2);
  if (!baseArg || !targetArg || !outputArg || !privateKeyArg) {
    throw new Error("Usage: node build/create-file-patch.js <base-client> <target-client> <output.zip> <private-key.pem>");
  }
  const baseRoot = path.resolve(baseArg);
  const targetRoot = path.resolve(targetArg);
  const outputFile = path.resolve(outputArg);
  const privateKey = fs.readFileSync(path.resolve(privateKeyArg), "utf8");
  const base = releaseFiles(baseRoot);
  const target = releaseFiles(targetRoot);
  if (base.release.version === target.release.version) throw new Error("Patch base and target versions must differ");

  const paths = [...new Set([...base.entries.keys(), ...target.entries.keys()])].sort();
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-file-patch-"));
  try {
    const files = [];
    for (const rawPath of paths) {
      const relativePath = validRelativePath(rawPath);
      const before = base.entries.get(relativePath) || null;
      const after = target.entries.get(relativePath) || null;
      if (before && after && before.sha256 === after.sha256) continue;
      const operation = after ? "replace" : "delete";
      if (after) copyPatchFile(stageRoot, targetRoot, relativePath);
      files.push({
        path: relativePath,
        operation,
        before: before ? { size: before.size, sha256: before.sha256 } : null,
        after: after ? { size: after.size, sha256: after.sha256 } : null
      });
    }
    if (!files.length) throw new Error("No files changed between releases");
    const manifest = signPatchManifest({
      schemaVersion: 1,
      packageType: "file-patch",
      fromVersion: base.release.version,
      toVersion: target.release.version,
      createdAt: new Date().toISOString(),
      targetReleaseManifestSha256: target.entries.get("release-manifest.json").sha256,
      files
    }, privateKey);
    fs.writeFileSync(path.join(stageRoot, "patch-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    archive(stageRoot, outputFile);
    console.log(JSON.stringify({
      packageType: manifest.packageType,
      fromVersion: manifest.fromVersion,
      toVersion: manifest.toVersion,
      changedFiles: files.length,
      outputFile,
      size: fs.statSync(outputFile).size,
      sha256: sha256(outputFile)
    }));
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

main();
