"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

test("stop button aborts the active run before form submission can enqueue input", () => {
  const stop = sourceBetween(rendererSource, 'sendBtn.addEventListener("click"', 'chatForm.addEventListener("submit"');
  assert.match(stop, /event\.preventDefault\(\)/);
  assert.match(stop, /event\.stopPropagation\(\)/);
  assert.match(stop, /await abortCurrentTask\(\)/);
  assert.doesNotMatch(stop, /enqueueCurrentTask/);
});

test("terminal frames stop runtime controls without destroying the draining answer owner", () => {
  const terminal = sourceBetween(
    rendererSource,
    "if (terminalFrame)",
    'if (frame.type !== "delta") return;'
  );
  const finalize = sourceBetween(rendererSource, "function finalizeLiveChatStream", "function discardLiveChatStreamsForSession");
  const runtimeControls = sourceBetween(rendererSource, "function syncSessionRuntimeControls", "async function selectSessionById");

  assert.match(terminal, /transitionLiveTurn\(entry, LIVE_TURN_STATES\.TERMINAL_RECEIVED\)/);
  assert.match(terminal, /syncSessionRuntimeControls\(entry\.sessionId\)/);
  assert.doesNotMatch(terminal, /discardLiveChatStream/);
  assert.match(finalize, /transitionLiveTurn\(entry, LIVE_TURN_STATES\.ANSWER_COMMITTED\)/);
  assert.match(finalize, /syncSessionRuntimeControls\(entry\.sessionId\)/);
  assert.match(runtimeControls, /setBusy\(running\)/);
});

test("old runs can release only their own session and run owner", () => {
  assert.match(rendererSource, /function activeSendOwnerMatches\(sessionId, runId\)/);
  assert.match(rendererSource, /activeSendOwners\.get\(sessionKey\) === runKey/);
  assert.match(rendererSource, /function releaseActiveSendOwner\(sessionId, runId\)/);
  assert.match(rendererSource, /if \(!activeSendOwnerMatches\(session\.id, streamId\)\)/);
  assert.match(rendererSource, /releaseActiveSendOwner\(session\.id, streamId\)/);
  assert.match(rendererSource, /releaseActiveSendOwner\(session\.id, activeRunId\)/);
});

test("reasoning is a transient typewriter lane and never becomes structured history", () => {
  const reasoning = sourceBetween(rendererSource, "function appendLiveReasoningDelta", "function completeLiveReasoningSegment");
  const routing = sourceBetween(rendererSource, "function setLiveStreamActivity", "function adoptPersistedLiveStreamRow");
  const providerDelta = sourceBetween(mainSource, "const onProviderDelta", "logDeepSeekFinalRequestBodyOnce");
  assert.match(reasoning, /entry\.reasoningDetails = \[/);
  assert.match(reasoning, /setLiveCurrentThinking\(entry, combinedText/);
  assert.match(rendererSource, /function assistantTypingCharsPerSecond\(totalCharacters = 0\)/);
  assert.match(routing, /if \(target === "structured_result" \|\| target === "reasoning" \|\| reasoningKind\.includes\(kind\)\)/);
  assert.match(rendererSource, /function progressTarget\(progress = \{\}\) \{[\s\S]*?return "structured_result";/);
  assert.match(rendererSource, /if \(entry\.reasoningRevealTimer\) clearTimeout/);
  assert.match(rendererSource, /entry\.currentThoughtText = ""/);
  assert.match(providerDelta, /delta\.visibility \|\| ""\)\.toLowerCase\(\) === "public"/);
  assert.match(providerDelta, /delta\.provenance \|\| ""\)\.toLowerCase\(\) === "blackball_public"/);
  assert.match(providerDelta, /if \(!reasoning \|\| !publicReasoning\) return;/);
});

test("the next public reasoning segment is not queued after the current answer is fully visible", () => {
  const source = sourceBetween(rendererSource, "function queueReasoningUntilAnswerVisible", "function flushQueuedReasoning");
  const queueReasoningUntilAnswerVisible = new Function(
    "liveAnswerSegmentIsVisible",
    `${source}; return queueReasoningUntilAnswerVisible;`
  )(() => false);
  const entry = {
    activeSegmentId: "answer-1",
    revealedLength: 4,
    targetChars: Array.from("done"),
    queuedReasoningDeltas: [],
    segmentCharsById: new Map([["answer-1", Array.from("done")]])
  };

  assert.equal(queueReasoningUntilAnswerVisible(entry, { message: "next" }, "answer-2"), false);
  assert.deepEqual(entry.queuedReasoningDeltas, []);
});

test("structured output keeps only real structured events and is capped at three visible entries", () => {
  const merge = sourceBetween(rendererSource, "function mergeStructuredEventLists", "function structuredEventsFromMessage");
  assert.match(merge, /progressTarget\(event\) !== "structured_result"/);
  assert.match(rendererSource, /const STRUCTURED_RESULT_VISIBLE_LIMIT = 3/);
  assert.match(rendererSource, /trimLiveStructuredResultWindow\(entry\)/);
  assert.match(mainSource, /progress\.target === "structured_result" && !reasoningEvent/);
});

test("cancellation removes the local owner only after sending the exact run id to Black Ball", () => {
  const abort = sourceBetween(rendererSource, "async function abortCurrentTask", "function sendCurrentTaskWasInterrupted");
  assert.match(abort, /const activeRunId = activeLiveChatStreamForSession\(session\.id\)\?\.streamId/);
  assert.match(abort, /api\.signalAbortChat\?\.\(\{ sessionId: session\.id, runId: activeRunId \}\)/);
  assert.match(abort, /api\.abortChat\(\{ sessionId: session\.id, runId: activeRunId \}\)/);
  assert.match(abort, /discardLiveChatStreamsForSession\(session\.id, \{ force: true \}\)/);
  assert.match(mainSource, /id: `product-result:\$\{interruptedUserMessage\.id\}`/);
  const mainAbort = sourceBetween(mainSource, 'ipcMain.handle("chat:abort"', 'ipcMain.handle("clipboard:write-text"');
  assert.match(mainAbort, /await withTimeout\(pendingSubmission, 5000, "等待取消结果持久化"\)/);
  assert.match(mainAbort, /if \(!verifyProductResultCommit\(targetId, responseMessageId\)\) \{[\s\S]*?persistProductResult\(/);
  assert.ok(
    mainAbort.indexOf("persistProductResult({") < mainAbort.indexOf("rendererDbSnapshot(updated)"),
    "cancel result must be durable before the terminal snapshot is returned"
  );
});

test("stalled runs time out by exact owner without treating lifecycle theater as model output", () => {
  const registration = sourceBetween(rendererSource, "function registerLiveChatStream", "function resetLiveChatStreamReveal");
  const timeout = sourceBetween(rendererSource, "function checkLiveStreamProgress", "function reasoningSegmentKey");
  const activity = sourceBetween(rendererSource, "function setLiveStreamActivity", "function adoptPersistedLiveStreamRow");
  const armFirstEvent = sourceBetween(rendererSource, "function armLiveStreamFirstEventTimeout", "function appendLiveStreamNotice");
  assert.doesNotMatch(registration, /setTimeout\([\s\S]*LIVE_STREAM_FIRST_EVENT_TIMEOUT_MS/);
  assert.match(armFirstEvent, /LIVE_STREAM_FIRST_EVENT_TIMEOUT_MS/);
  assert.match(activity, /type === "model_request_dispatched"/);
  assert.match(activity, /armLiveStreamFirstEventTimeout\(entry, progress\.timestamp\)/);
  assert.match(registration, /checkLiveStreamProgress\(entry\)/);
  assert.match(timeout, /sessionId: entry\.sessionId/);
  assert.match(timeout, /runId: entry\.streamId/);
  assert.match(timeout, /reason: "timeout"/);
  assert.match(timeout, /LIVE_STREAM_NO_PROGRESS_TIMEOUT_MS/);
  assert.match(timeout, /!Number\(entry\.modelRequestDispatchedAt\) && !entry\.firstEventReceived/);
  assert.match(activity, /source === "hms" && kind !== "lifecycle"/);
});

test("the real Hermes dispatch timing event arms the renderer timeout once", () => {
  const runtime = sourceBetween(mainSource, "async function runHermesSessionPrompt", "async function runHermesSessionPromptWithRecovery");
  assert.match(mainSource, /function emitBlackBallModelRequestDispatched/);
  assert.match(runtime, /stage === "promptDispatched" && !modelRequestDispatched/);
  assert.match(runtime, /emitBlackBallModelRequestDispatched\(session\.id, streamId, detail\?\.at\)/);
});

test("drained output always commits a pending finalization", () => {
  const flush = sourceBetween(rendererSource, "function flushLiveChatStream", "function liveMarkdownBatchInterval");
  assert.match(flush, /entry\.finalizeWhenDrained\?\.\(\)/);
  assert.doesNotMatch(flush, /if \(!entry\.finalizing\) entry\.finalizeWhenDrained/);
});
