"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");

test("manual consciousness extraction runs without the full-screen animation", () => {
  const start = rendererSource.indexOf("async function runBlackCoreExtraction");
  const end = rendererSource.indexOf("function routeBlackCoreProgress", start);
  const extraction = rendererSource.slice(start, end);

  assert.match(extraction, /return await api\.saveConsciousState/);
  assert.doesNotMatch(extraction, /openBlackCore\(/);
  assert.doesNotMatch(extraction, /completeBlackCore\(/);
  assert.doesNotMatch(extraction, /blackCoreDelay\(/);
});

test("the extraction status uses real progress events without timer-driven playback", () => {
  const start = rendererSource.indexOf("function showConsciousProgress");
  const end = rendererSource.indexOf("api.onProjectConsciousBackupProgress", start);
  const progress = rendererSource.slice(start, end);

  assert.match(progress, /panel\._flowStep = Math\.max/);
  assert.doesNotMatch(progress, /setInterval/);
});

test("the extraction progress indicator is static", () => {
  const start = cssSource.indexOf(".conscious-save-progress {");
  const end = cssSource.indexOf(".conscious-protection-dialog", start);
  const styles = cssSource.slice(start, end);

  assert.doesNotMatch(styles, /animation\s*:/);
});
