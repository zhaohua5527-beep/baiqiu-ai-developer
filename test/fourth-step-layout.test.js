"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const rendererStyles = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8");

function sourceBetween(start, end) {
  const from = rendererSource.indexOf(start);
  const to = rendererSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return rendererSource.slice(from, to);
}

test("theatre content shares the header row with elapsed time", () => {
  for (const source of [
    sourceBetween("function renderPersistedExecutionTimeline", "function executionActivityNodes"),
    sourceBetween("function collapseCompletedExecutionActivity", "function streamActivityHtml"),
    sourceBetween("function streamActivityHtml", "function updateLiveStreamElapsed")
  ]) {
    const headerStart = source.indexOf("execution-activity-head");
    const shellStart = source.indexOf("execution-activity-shell", headerStart);
    const header = source.slice(headerStart, shellStart);
    assert.match(header, /mini-theatre-region execution-activity-inline-theater/);
    assert.match(header, /streaming-elapsed/);
  }
});

test("region labels are retained for internal hooks but hidden from users", () => {
  assert.match(rendererStyles, /\.streaming-activity-label,\s*\.execution-process-label \{ display: none !important; \}/);
  assert.match(rendererStyles, /\.message\.assistant \.result-region::before \{ content: none; display: none; \}/);
  assert.match(rendererSource, /<span class="streaming-activity-label">小剧场<\/span>/);
  assert.match(rendererSource, /<span class="execution-process-label">执行过程<\/span>/);
});
