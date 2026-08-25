"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

test("attachments stay on the Black Ball-owned ordinary turn", () => {
  const start = mainSource.indexOf('ipcMain.handle("product:submit-task"');
  const end = mainSource.indexOf('ipcMain.handle("product:query-task"', start);
  const handler = mainSource.slice(start, end);
  assert.doesNotMatch(handler, /incomingAttachments\.length > 0 \|\| requestNeedsHmsToolDecision/);
  assert.doesNotMatch(handler, /brain\.submit\(\{[\s\S]{0,500}attachments: incomingAttachments/);
  assert.match(mainSource, /blackBallOwnedUnderstanding/);
  assert.match(mainSource, /taskWorksetContinuationText\(resumed\)/);
});

test("attachment recovery is bounded to the current session history", () => {
  assert.match(mainSource, /latestAttachmentMessageForRecovery\(sessionId\)/);
  assert.match(mainSource, /loadDb\(\)\.messages\?\.\[sessionId\]/);
  assert.doesNotMatch(mainSource, /latestAttachmentMessageForRecovery\([^)]*global/i);
});

test("canonical tasks bypass Whiteball clarification prediction", () => {
  assert.match(mainSource, /whiteBallLifecycleTurn && !canonicalTaskId && conversationUnderstanding\.responseMode === "clarify"/);
  assert.match(mainSource, /task\?\.status === "awaiting_confirmation"/);
});

test("empty canonical worksets recover current-session attachments before continuing", () => {
  assert.match(mainSource, /shouldRecoverAttachmentWorkset\(existingTask, message\)/);
  assert.match(mainSource, /const sourceMessage = latestAttachmentMessageForRecovery\(sessionId\)/);
  assert.match(mainSource, /repairedTask = brain\.continueWorkset\(existingTask\.task_id, \{ attachments: sourceMessage\.attachments \}\)/);
  assert.match(mainSource, /restartedTerminalTask: isTerminalTaskForRetry/);
});

test("canonical tasks without persisted timing are recalculated as task-brain execution", () => {
  assert.match(mainSource, /const routedTiming = timingForTask\(\{[\s\S]{0,400}route: existingTask\?\.route \|\| "task_brain"/);
  assert.match(mainSource, /persistedTiming && persistedTiming\.hardTimeoutMs >= routedTiming\.hardTimeoutMs/);
});
