"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("conversation route leaves realtime tool selection to HMS", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("if (!conversationUnderstanding.shouldCreateTask) {");
  assert.ok(start >= 0, "conversation fallback branch must exist");
  const segment = mainSource.slice(start, start + 3000);
  assert.doesNotMatch(segment, /tryHandleRealtimeWebQuestion/);
  assert.match(segment, /runHermesSessionPrompt/);
});

test("realtime questions are promoted once before the runtime lane is selected", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("function requestNeedsHmsToolDecision");
  const end = mainSource.indexOf("function browserAutomationPrompt", start);
  const helper = mainSource.slice(start, end);
  assert.match(helper, /isRealtimeWebQuestion\(value, sessionId\)/);
  const runtimeStart = mainSource.indexOf("async function runHermesSessionPrompt");
  const runtime = mainSource.slice(runtimeStart, runtimeStart + 1200);
  assert.doesNotMatch(runtime, /requestNeedsHmsToolDecision/);
  const understandingReady = mainSource.indexOf('markProductTiming("understanding_ready")');
  const promotion = mainSource.lastIndexOf("conversationUnderstanding = routeHmsToolRequest", understandingReady);
  assert.ok(promotion >= 0 && promotion < understandingReady, "tool decision is finalized before runtime selection");
});

test("task route has no pre-HMS realtime shortcut", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSource.indexOf("if (!taskBrainTask) {");
  const end = mainSource.indexOf("const runtimeContext =", start);
  const segment = mainSource.slice(start, end);
  assert.doesNotMatch(segment, /tryHandleRealtimeWebQuestion/);
  assert.match(mainSource, /baiqiuToolProtocol: \{ version: "1\.0"/);
});
