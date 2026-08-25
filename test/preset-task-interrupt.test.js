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

test("preset interruption signals the active controller before awaiting persistence", () => {
  const start = functionSegment("startQueuedTask", "clearQueueSortIndicators");
  const signalAt = start.indexOf("api.signalAbortChat?.");
  const firstAwaitAt = start.indexOf("await api.abortChat");

  assert.ok(signalAt >= 0, "preset interruption must send the fast abort signal");
  assert.ok(firstAwaitAt > signalAt, "fast abort signal must precede the first persistence await");
  assert.doesNotMatch(start.slice(0, firstAwaitAt), /setTimeout|api\.init/);
  assert.doesNotMatch(rendererSource, /waitForQueuedTaskAbortSettlement/);
  assert.match(start, /taskState\.textContent = "正在切换预置任务"/);
});

test("fast abort IPC validates run identity and separates timeout from user cancellation", () => {
  assert.match(preloadSource, /signalAbortChat: \(payload\) => ipcRenderer\.send\("chat:abort-signal", payload\)/);
  const signalStart = mainSource.indexOf('ipcMain.on("chat:abort-signal"');
  const fullAbortStart = mainSource.indexOf('ipcMain.handle("chat:abort"', signalStart);
  const signal = mainSource.slice(signalStart, fullAbortStart);

  assert.ok(signalStart >= 0 && fullAbortStart > signalStart);
  assert.match(signal, /activeRuns\.get\(requestedId\)/);
  assert.match(signal, /requestedRunId && !cancelRequestTargetsRun\(requestedRunId, run\)/);
  assert.match(signal, /const timeoutRequested = String\(abortRequest\.reason \|\| ""\)\.toLowerCase\(\) === "timeout"/);
  assert.match(signal, /if \(timeoutRequested\) \{[\s\S]*?run\.timedOut = true;[\s\S]*?\} else \{[\s\S]*?run\.userAborted = true;/);
  assert.match(signal, /run\.controller\.abort\(timeoutRequested \? \{ code: "TASK_TIMEOUT", message: run\.timeoutReason \} : undefined\)/);
  assert.doesNotMatch(signal, /\bawait\b|loadDb\(/);
});

test("preset rows expose editing and restore text plus attachments", () => {
  const render = functionSegment("renderQueue", "renderSettings");
  const restore = functionSegment("restoreQueuedTaskToComposer", "waitForVisibleOutputDrain");

  assert.match(render, /data-action="edit"/);
  assert.match(render, /restoreQueuedTaskToComposer\(selected, task\)/);
  assert.match(restore, /chatInput\.value = task\.text \|\| ""/);
  assert.match(restore, /state\.attachments = \[\.\.\.\(task\.attachments \|\| \[\]\)\]/);
  assert.match(restore, /state\.composerQuote = task\.quote/);
});

test("an interrupted sender cannot clear a replacement sender", () => {
  const send = functionSegment("sendCurrentTask", "processQueue");

  assert.match(rendererSource, /const activeSendOwners = new Map\(\)/);
  assert.match(send, /activeSendOwners\.set\(session\.id, streamId\)/);
  assert.match(send, /activeSendOwners\.get\(session\.id\) !== streamId/);
  assert.match(send, /activeSendOwners\.has\(session\.id\)/);
  assert.match(send, /state\.abortedStreamIds\.has\(streamId\)/);
});
