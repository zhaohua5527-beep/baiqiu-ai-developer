"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const rendererHtml = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const registrySource = fs.readFileSync(path.join(root, "tool-registry.js"), "utf8");

test("White Ball has no access-mode or chat permission controls", () => {
  for (const source of [rendererSource, rendererHtml]) {
    assert.doesNotMatch(source, /accessModeBtn|ACCESS_MODES|\/yolo|showConfirmCard/);
  }
  assert.doesNotMatch(preloadSource, /tool:confirmation|onToolConfirmation|confirmTool/);
  assert.doesNotMatch(mainSource, /tool:confirmation-response|new PermissionManager|setPermissionManager/);
  assert.doesNotMatch(registrySource, /_permissionManager|_requestChatConfirmation|_pendingConfirmations/);
});

test("Hermes authorization is silent while protected data and membership remain guarded", () => {
  const start = mainSource.indexOf("async function requestHermesPermission");
  const end = mainSource.indexOf("function ensureHermesClient", start);
  const permission = mainSource.slice(start, end);
  assert.match(permission, /isSensitiveHermesToolCall/);
  assert.match(permission, /memberToolEntitlement/);
  assert.match(permission, /hermesPermissionSelection\(params\.options \|\| \[\], "allow_once"\)/);
  assert.doesNotMatch(permission, /_requestChatConfirmation|accessMode|requiresConfirmation/);
});
