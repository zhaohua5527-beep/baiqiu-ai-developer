"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const modelAdapterSource = fs.readFileSync(path.join(root, "services", "model-adapter.js"), "utf8");

test("live execution and structured results use separate surfaces", () => {
  const streamActivity = rendererSource.slice(
    rendererSource.indexOf("function streamActivityHtml"),
    rendererSource.indexOf("function updateLiveStreamElapsed")
  );
  const hideThinking = rendererSource.slice(
    rendererSource.indexOf("function hideLiveThinkingLayer"),
    rendererSource.indexOf("function collapseCompletedExecutionActivity")
  );
  const collapse = rendererSource.slice(
    rendererSource.indexOf("function collapseCompletedExecutionActivity"),
    rendererSource.indexOf("function streamActivityHtml")
  );
  const finalize = rendererSource.slice(
    rendererSource.indexOf("function finalizeLiveChatStream"),
    rendererSource.indexOf("function discardLiveChatStreamsForSession")
  );
  const delta = rendererSource.slice(
    rendererSource.indexOf('if (frame.type !== "delta")'),
    rendererSource.indexOf("function removeSessionExecutionIndicator")
  );
  const flush = rendererSource.slice(
    rendererSource.indexOf("function flushLiveChatStream"),
    rendererSource.indexOf("function scheduleLiveChatStreamPaint")
  );

  assert.match(streamActivity, /execution-reasoning-flow/);
  assert.match(streamActivity, /execution-activity-narrative streaming-structured-result/);
  assert.match(streamActivity, /executionActivityToggleHtml\(visibleDetails\.length, false\)/);
  assert.match(rendererSource, /streaming-structured-result/);
  assert.match(rendererSource, /appendLiveStructuredResult/);
  assert.doesNotMatch(streamActivity, /thinking-bars/);
  assert.doesNotMatch(streamActivity, /已用/);
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_VISIBLE_LIMIT = 3/);
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_QUEUE_LIMIT = 32/);
  assert.match(rendererSource, /REASONING_SEGMENT_HISTORY_LIMIT/);
  assert.match(hideThinking, /clearExecutionCurrentThinking\(root\)/);
  assert.doesNotMatch(hideThinking, /current\.hidden = true/);
  assert.match(collapse, /stopExecutionActivityFlow\(root\)/);
  assert.match(collapse, /root\.dataset\.lifecycle = "completed"/);
  assert.doesNotMatch(collapse, /execution-completion-count/);
  assert.match(collapse, /streaming-elapsed/);
  assert.doesNotMatch(collapse, /execution-activity-duration-only/);
  assert.match(collapse, /return root/);
  assert.match(finalize, /collapseCompletedExecutionActivity\(entry\.activity, completedDurationMs, \[[\s\S]*?entry\.activityDetails[\s\S]*?entry\.structuredEvents/);
  assert.doesNotMatch(finalize, /currentRow\.querySelector\("\.execution-activity-completed"\)/);
  assert.match(delta, /retireLiveExecutionPhase\(entry, segmentId\)/);
  assert.match(delta, /entry\.text \+= delta/);
  assert.match(flush, /if \(entry\.backendCompleted\)[\s\S]*?entry\.finalizeWhenDrained\?\.\(\)/);
  assert.match(rendererSource, /function appendLiveReasoningDelta/);
  assert.match(rendererSource, /appendLiveReasoningDelta\(entry, progress\)/);
  assert.doesNotMatch(rendererSource, /Native thought chunks are deliberately ignored/);
  assert.doesNotMatch(rendererSource.slice(rendererSource.indexOf('if (frame.type !== "delta")'), rendererSource.indexOf("function removeSessionExecutionIndicator")), /正在输出/);
  assert.match(mainSource, /type: "error",\s*message: userFacingError\(error/);
  assert.match(rendererSource, /function taskFailureText/);
  assert.match(rendererSource, /模型连接失败，请检查网络/);
});

test("only public model reasoning is forwarded and missing first events terminate instead of hanging", () => {
  const providerDelta = mainSource.slice(
    mainSource.indexOf("const onProviderDelta"),
    mainSource.indexOf("logDeepSeekFinalRequestBodyOnce", mainSource.indexOf("const onProviderDelta"))
  );
  const hmsPrompt = mainSource.slice(
    mainSource.indexOf("const promptHermes = async"),
    mainSource.indexOf("const tail = visibleStream.flush()", mainSource.indexOf("const promptHermes = async"))
  );
  assert.match(providerDelta, /kind: "reasoning_delta"/);
  assert.match(providerDelta, /delta: reasoning/);
  assert.match(providerDelta, /visibility \|\| ""\)\.toLowerCase\(\) === "public"/);
  assert.match(providerDelta, /provenance \|\| ""\)\.toLowerCase\(\) === "blackball_public"/);
  assert.match(modelAdapterSource, /FIRST_STREAM_DELTA_TIMEOUT_MS/);
  assert.match(modelAdapterSource, /MODEL_FIRST_EVENT_TIMEOUT/);
  assert.match(rendererSource, /LIVE_STREAM_FIRST_EVENT_TIMEOUT_MS/);
  assert.match(rendererSource, /handleLiveStreamTimeout/);
  assert.match(rendererSource, /api\.signalAbortChat/);
});

test("abort snapshots cannot make the renderer preserve a stale live conversation", () => {
  const abortStart = mainSource.indexOf('ipcMain.handle("chat:abort"');
  const abortEnd = mainSource.indexOf('ipcMain.handle("clipboard:write-text"', abortStart);
  const abort = mainSource.slice(abortStart, abortEnd);
  const persistedState = abort.indexOf("const updated = updateSession");
  const broadcast = abort.indexOf("rendererDbSnapshot(updated)");

  assert.ok(persistedState >= 0 && broadcast > persistedState);
  assert.match(abort, /status: "aborted"/);

  const sessionChanged = rendererSource.slice(rendererSource.indexOf("api.onSessionChanged"));
  assert.match(sessionChanged, /preservesLiveConversation[\s\S]*?state\.abortRequestedSessions\.has\(selectedSessionId\)/);
});

test("message cache invalidates every session when the database file version changes", () => {
  const cache = mainSource.slice(
    mainSource.indexOf("const _messagesCache"),
    mainSource.indexOf("function writeJson")
  );
  assert.match(cache, /messageCacheVersionChanged/);
  assert.match(cache, /_messagesCache\.clear\(\)/);
  assert.match(cache, /_messagesCacheMeta\.size !== stat\.size/);
  assert.match(cache, /currentStat\.mtimeMs !== mtime \|\| currentStat\.size !== warmSize/);
});
