"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const installer = fs.readFileSync(path.join(root, "services", "hms-runtime-installer.js"), "utf8");

test("NSIS presents an install-location choice", () => {
  assert.equal(packageJson.build.nsis.oneClick, false);
  assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, true);
});

test("first-run HMS archive extraction is resource constrained", () => {
  assert.match(installer, /"-mmt=1"/);
});
