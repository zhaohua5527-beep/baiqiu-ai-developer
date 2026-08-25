"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const { inspectUpdatePackage, signPatchManifest, verifyPatchManifest } = require("../services/patch-update");

function signedManifest(privateKey) {
  return signPatchManifest({
    schemaVersion: 1,
    packageType: "file-patch",
    fromVersion: "3.0.5",
    toVersion: "3.0.6",
    files: [{
      path: "resources/app/main.js",
      operation: "replace",
      before: { size: 10, sha256: "a".repeat(64) },
      after: { size: 12, sha256: "b".repeat(64) }
    }]
  }, privateKey);
}

test("signed patch manifests are accepted and ZIP detection is bounded", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  const manifest = signedManifest(privateKey);
  assert.equal(verifyPatchManifest(manifest, { publicKey }).toVersion, "3.0.6");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-patch-test-"));
  try {
    const zip = new JSZip();
    zip.file("patch-manifest.json", JSON.stringify(manifest));
    zip.file("files/resources/app/main.js", "next");
    const output = path.join(root, "patch.zip");
    fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const inspected = inspectUpdatePackage(output, { publicKey, fromVersion: "3.0.5", toVersion: "3.0.6" });
    assert.equal(inspected.packageType, "file-patch");
    assert.equal(inspected.manifest.files[0].path, "resources/app/main.js");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("patch signature rejects changed operations", () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  const manifest = signedManifest(privateKey);
  manifest.files[0].path = "resources/app/preload.js";
  assert.throws(() => verifyPatchManifest(manifest, { publicKey }), /signature/i);
});

test("full-client ZIPs require an explicit release manifest with the target version", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-full-update-test-"));
  try {
    const zip = new JSZip();
    zip.file("client/release-manifest.json", JSON.stringify({
      packageType: "full-client",
      version: "3.0.7",
      executable: { path: "BaiqiuAI.exe", sha256: "c".repeat(64) },
      files: Array.from({ length: 10 }, (_item, index) => ({ path: `resources/app/file-${index}.js`, size: index, sha256: "d".repeat(64) }))
    }));
    const output = path.join(root, "client.zip");
    fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const inspected = inspectUpdatePackage(output, { toVersion: "3.0.7" });
    assert.equal(inspected.packageType, "full-client");
    assert.equal(inspected.manifest.version, "3.0.7");
    assert.throws(() => inspectUpdatePackage(output, { toVersion: "3.0.8" }), /version mismatch/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("full-client ZIP inspection accepts Windows archive path separators", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-windows-zip-test-"));
  try {
    const zip = new JSZip();
    zip.file("client\\release-manifest.json", JSON.stringify({
      packageType: "full-client",
      version: "3.0.7",
      executable: { path: "BaiqiuAI.exe", sha256: "c".repeat(64) },
      files: Array.from({ length: 10 }, (_item, index) => ({ path: `resources/app/file-${index}.js`, size: index, sha256: "d".repeat(64) }))
    }));
    const output = path.join(root, "windows-client.zip");
    fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const inspected = inspectUpdatePackage(output, { toVersion: "3.0.7" });
    assert.equal(inspected.packageType, "full-client");
    assert.equal(inspected.manifest.version, "3.0.7");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
