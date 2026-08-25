"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

test("live activity uses one dynamic top row without a duplicate fixed title", () => {
  const activity = sourceBetween("function streamActivityHtml", "function updateLiveStreamElapsed");
  const theater = sourceBetween("function executionTheaterSceneFromActivity", "function enqueueExecutionActivityTheater");
  const head = activity.match(/<div class="execution-activity-head">([\s\S]*?)<\/div>\s*<div class="execution-activity-shell">/)?.[1] || "";

  assert.match(head, /execution-activity-inline-theater/);
  assert.match(head, /streaming-elapsed/);
  assert.doesNotMatch(activity, /streaming-activity-label/);
  assert.doesNotMatch(activity, new RegExp("\\u9ed1\\u7403\\u5c0f\\u5267\\u573a"));
  assert.equal((activity.match(/execution-activity-inline-theater/g) || []).length, 1);
  assert.match(theater, /name: "\u9ed1\u7403"/);
});

test("English internal narration is buffered across stream chunks", () => {
  const helpers = sourceBetween("function rawBlackBallAnswerText", "function isNativeBlackBallMessage");
  const { filterLiveAssistantDelta } = new Function(`${helpers}; return { filterLiveAssistantDelta };`)();
  const entry = { suppressingInternalNarration: false, internalNarrationBuffer: "" };

  assert.equal(filterLiveAssistantDelta(entry, 'The user said "\u4f60\u597d", which is a simple greeting.'), "");
  assert.equal(filterLiveAssistantDelta(entry, "\nAccording to my instructions, I should answer briefly."), "");
  assert.equal(
    filterLiveAssistantDelta(entry, "\n\u6709\u4ec0\u4e48\u9700\u8981\u5e2e\u5fd9\u7684\uff0c\u76f4\u63a5\u8bf4\u3002"),
    "\u6709\u4ec0\u4e48\u9700\u8981\u5e2e\u5fd9\u7684\uff0c\u76f4\u63a5\u8bf4\u3002"
  );
  assert.equal(entry.suppressingInternalNarration, false);
  assert.equal(entry.internalNarrationBuffer, "");

  const englishEntry = { suppressingInternalNarration: false, internalNarrationBuffer: "" };
  assert.equal(filterLiveAssistantDelta(englishEntry, "Hello, how can I help?"), "Hello, how can I help?");
});

test("terminal session state wins over a stale local queue flag", () => {
  const running = sourceBetween("function sessionIsRunning", "async function selectSessionById");
  const sidebar = sourceBetween("function projectSessionStatus", "function projectSidebarStatus");

  assert.ok(running.indexOf("terminalStatuses.includes(status)") < running.indexOf("sessionTaskQueue.isActive(session.id)"));
  assert.ok(sidebar.indexOf('["SUCCESS", "DONE", "COMPLETED"]') < sidebar.lastIndexOf("sessionTaskQueue.isActive(session.id)"));
});

test("terminal replies remove the temporary theater and activity timeline", () => {
  const collapse = sourceBetween("function collapseCompletedExecutionActivity", "function streamActivityHtml");

  assert.match(collapse, /stopExecutionActivityFlow\(root\)/);
  assert.match(collapse, /root\.remove\(\)/);
  assert.match(collapse, /return null/);
});
