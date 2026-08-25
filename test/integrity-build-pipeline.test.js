"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { generateIntegrityManifest } = require("../build/generate-integrity-manifest");

const protectedFiles = ["main.js", "preload.js", "browser-preload.js", "tool-registry.js", "tool-loader.js"];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("integrity manifest generator records the files that will be packaged", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-integrity-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of protectedFiles) fs.writeFileSync(path.join(root, file), `fixture:${file}\n`, "utf8");

  const result = generateIntegrityManifest(root);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  assert.deepEqual(result.files.sort(), [...protectedFiles].sort());
  for (const file of protectedFiles) {
    assert.equal(manifest.files[file], sha256(path.join(root, file)));
  }
});

test("every packaged build script refreshes integrity before electron-builder", () => {
  const pkg = require("../package.json");
  for (const script of ["build", "build:dir", "package:release"]) {
    assert.match(pkg.scripts[script], /^npm run prepare:integrity && electron-builder\b/, script);
  }
  assert.match(pkg.scripts["build:hms"], /npm run build$/);
});
