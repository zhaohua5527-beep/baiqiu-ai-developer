"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

test("short contextual questions are not rebound before Black Ball sees them", () => {
  assert.match(mainSource, /function contextualTaskFollowup\(text = "", context = \{\}\)/);
  const start = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const end = mainSource.indexOf('ipcMain.handle("product:query-task"', start);
  const handler = mainSource.slice(start, end);
  assert.doesNotMatch(handler, /contextualTaskFollowup|latestTaskBoundAssistantMessage|isCompactExecutionConfirmation/);
  assert.match(mainSource, /blackBallOwnedUnderstanding/);
});

test("failed product results cannot persist unverified model prose as a normal answer", () => {
  assert.match(mainSource, /const failedResult = \["failed", "timed_out"\]\.includes\(requestRun\.executionOutcome\)/);
  assert.match(mainSource, /executionOutcome: requestRun\.executionOutcome/);
  assert.match(mainSource, /existing\.text = resolvedText/);
  assert.match(mainSource, /requestRun\.executionOutcome === "timed_out" \? "执行超时" : "执行失败"/);
});

test("selecting an intent direction continues the original request immediately", () => {
  assert.match(mainSource, /const selectedDirectionCompletesInput = !response\?\.confirmed/);
  assert.match(mainSource, /继续执行原请求，并在本轮直接交付用户要求的最终内容/);
  assert.match(mainSource, /status: response\?\.aborted \? "cancelled" : "awaiting_input"/);
});

test("clarification responses remain visibly waiting instead of completed", () => {
  assert.match(rendererSource, /\["pending_confirmation", "awaiting_input"\]\.includes/);
  assert.match(rendererSource, /Boolean\(result\?\.clarification\)/);
});
