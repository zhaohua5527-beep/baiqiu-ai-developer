"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("product:submit-task rejects an overlapping run and creates a fresh controller", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const nextHandler = mainSource.indexOf("ipcMain.handle(", start + 50);
  const segment = mainSource.slice(start, nextHandler > start ? nextHandler : start + 30000);

  assert.match(segment, /const running = activeRuns\.get\(sessionId\);[\s\S]*?if \(running\) \{[\s\S]*?error: "RUN_ALREADY_ACTIVE"/);
  assert.match(segment, /const controller = new AbortController\(\);[\s\S]*?activeRuns\.set\(sessionId, \{[\s\S]*?runId: requestRunId,[\s\S]*?controller,/);
  assert.doesNotMatch(segment, /previousRun\?\.controller|previousRun && !previousRun\.controller/);
});

test("product run cleanup is scoped to the controller it created", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const nextHandler = mainSource.indexOf("ipcMain.handle(", start + 50);
  const segment = mainSource.slice(start, nextHandler > start ? nextHandler : start + 30000);
  assert.match(segment, /finishingRun\?\.controller === controller && finishingRun\?\.runId === requestRunId/s);
  assert.match(segment, /activeRuns\.delete\(sessionId\)/);
});
