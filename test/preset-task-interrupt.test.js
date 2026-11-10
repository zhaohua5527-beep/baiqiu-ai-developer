"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

function functionSegment(name, nextName) {
  const start = rendererSource.indexOf(`function ${name}`);
  const end = rendererSource.indexOf(`function ${nextName}`, start + 20);
  assert.ok(start >= 0, `${name} must exist`);
  return rendererSource.slice(start, end > start ? end : start + 12000);
}

test("confirming a supplement continues the active task without aborting it", () => {
  const start = functionSegment("startQueuedTask", "clearQueueSortIndicators");
  assert.doesNotMatch(start, /signalAbortChat|api\.abortChat|abortCurrentTask|api\.init/);
  assert.match(start, /finishQueuedTaskEdit\(session, task\)/);
  assert.match(start, /autoStart: true, deliveryMode: "steer"/);
  assert.match(start, /processQueue\(session\.id\)/);
  assert.doesNotMatch(rendererSource, /waitForQueuedTaskAbortSettlement/);
});

test("fast abort IPC validates run identity and separates timeout inspection from user cancellation", () => {
  assert.match(preloadSource, /signalAbortChat: \(payload\) => ipcRenderer\.send\("chat:abort-signal", payload\)/);
  const signalStart = mainSource.indexOf('ipcMain.on("chat:abort-signal"');
  const fullAbortStart = mainSource.indexOf('ipcMain.handle("chat:abort"', signalStart);
  const signal = mainSource.slice(signalStart, fullAbortStart);

  assert.ok(signalStart >= 0 && fullAbortStart > signalStart);
  assert.match(signal, /activeRuns\.get\(requestedId\)/);
  assert.match(signal, /requestedRunId && !cancelRequestTargetsRun\(requestedRunId, run\)/);
  assert.match(signal, /const timeoutRequested = String\(abortRequest\.reason \|\| ""\)\.toLowerCase\(\) === "timeout"/);
  const timeoutBranch = signal.slice(signal.indexOf("if (timeoutRequested) {"), signal.indexOf("} else {"));
  assert.match(timeoutBranch, /run\.queryRuntimeStatus/);
  assert.doesNotMatch(timeoutBranch, /run\.controller\.abort/);
  assert.doesNotMatch(signal, /\bawait\b|loadDb\(/);
});

test("preset rows edit locally without replacing the composer or opening a dialog", () => {
  const render = functionSegment("renderQueue", "renderSettings");
  const editor = functionSegment("editQueuedTaskInline", "finalizeVisibleStreamNow");

  assert.match(render, /data-action="edit"/);
  assert.match(render, /editQueuedTaskInline\(selected, task\)/);
  assert.match(render, /queue-task-editor/);
  assert.match(editor, /autoStart: false/);
  assert.match(editor, /task\.editText = task\.text \|\| ""/);
  assert.doesNotMatch(editor, /chatInput\.value\s*=|state\.attachments\s*=|state\.composerQuote\s*=|createElement\("dialog"\)|showModal|processQueue/);
});

test("an interrupted sender cannot clear a replacement sender", () => {
  const send = functionSegment("sendCurrentTask", "processQueue");

  assert.match(rendererSource, /const activeSendOwners = new Map\(\)/);
  assert.match(send, /activeSendOwners\.set\(session\.id, streamId\)/);
  assert.match(send, /!activeSendOwnerMatches\(session\.id, streamId\)/);
  assert.match(send, /activeSendOwners\.has\(session\.id\)/);
  assert.match(send, /state\.abortedStreamIds\.has\(streamId\)/);
});
