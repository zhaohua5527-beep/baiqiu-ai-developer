"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const SessionTaskQueue = require("../renderer-v2/session-task-queue");
const blackBallPublicEvents = require("../services/black-ball-public-event-contract");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

function liveFrameHarness(entry) {
  const eventBoundary = sourceBetween(rendererSource, "function transitionLiveTurn", "function registerLiveChatStream");
  const body = sourceBetween(rendererSource, "function handleChatStreamFrame", "function removeSessionExecutionIndicator");
  const liveChatStreams = new Map([[entry.streamId, entry]]);
  const factory = new Function(
    "liveChatStreams",
    "LIVE_TURN_STATES",
    "LIVE_TURN_TRANSITIONS",
    "handleVoiceConversationStreamFrame",
    "setLiveStreamStage",
    "setLiveStreamActivity",
    "markLiveStreamEventReceived",
    "filterLiveAssistantDelta",
    "streamSegmentKey",
    "adoptPendingReasoningBlock",
    "placeLiveActivityBeforeBlock",
    "placeLiveStructuredResultPanel",
    "orderLiveSegmentBlocks",
    "retireLiveExecutionPhase",
    "settleLiveSegmentTransition",
    "scheduleLiveChatStreamPaint",
    "resetLiveChatStreamReveal",
    "setLiveCurrentThinking",
    "updateLiveStreamElapsed",
    "freezeLiveStreamElapsed",
    "syncSessionRuntimeControls",
    "appendLiveStreamNotice",
    "recycleLiveStructuredProcess",
    "blackBallPublicEvents",
    `const reportStartupMetric = () => {}; ${sourceBetween(rendererSource, "function reportLiveOutputTiming", 'reportStartupMetric("renderer:script-start")')}\n${eventBoundary}\n${body}; return handleChatStreamFrame;`
  );
  return factory(
    liveChatStreams,
    { CREATED: "CREATED", RUNNING: "RUNNING", TERMINAL_RECEIVED: "TERMINAL_RECEIVED" },
    { CREATED: new Set(["RUNNING", "TERMINAL_RECEIVED"]), RUNNING: new Set(["TERMINAL_RECEIVED"]) },
    () => {},
    () => {},
    () => {},
    () => {},
    (_entry, delta) => String(delta || ""),
    () => "__default",
    () => null,
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    blackBallPublicEvents
  );
}

function chatSubmissionHarness() {
  const body = sourceBetween(mainSource, "function runIdempotentChatSubmission", "function recoverCompletedConversationTrace");
  const activeChatSubmissions = new Map();
  const completedChatSubmissions = new Map();
  const factory = new Function(
    "activeChatSubmissions",
    "completedChatSubmissions",
    "productSubmissionKey",
    "productRequestFingerprint",
    "idempotencyKeyReusedResult",
    `${body}; return runIdempotentChatSubmission;`
  );
  return factory(
    activeChatSubmissions,
    completedChatSubmissions,
    (payload, sessionId) => `${sessionId}:${payload.runId || ""}`,
    (payload) => JSON.stringify([payload.text || "", payload.attachments || [], payload.context || null]),
    () => ({ success: false, error: "IDEMPOTENCY_KEY_REUSED" })
  );
}

test("a duplicate start frame cannot erase or replace text already owned by the stream", () => {
  const entry = {
    streamId: "run-1",
    sessionId: "session-1",
    text: "",
    backendCompleted: false,
    timedOut: false,
    lastFrameSequence: 0,
    completedSegments: new Set(),
    segmentEndLengths: new Map(),
    segmentOrder: [],
    segmentCharsById: new Map(),
    answerStartedSegments: new Set(),
    pendingReasoningBlockId: "",
    activeSegmentId: "",
    activityUpdatedAt: 0,
    terminalType: "",
    targetChars: [],
    revealedLength: 0,
    completionTimer: null,
    activity: null,
    row: null
  };
  const frame = liveFrameHarness(entry);
  frame({ type: "start", eventId: "run-1:start", sequence: 1, target: "execution", eventType: "execution_start", streamId: "run-1", sessionId: "session-1", seq: 1 });
  frame({ type: "delta", eventId: "run-1:answer:1", sequence: 1, target: "answer", eventType: "answer_delta", delta: "第一段", streamId: "run-1", sessionId: "session-1", seq: 2 });
  frame({ type: "start", eventId: "run-1:start:duplicate", sequence: 2, target: "execution", eventType: "execution_start", streamId: "run-1", sessionId: "session-1", seq: 3 });
  frame({ type: "delta", eventId: "run-1:answer:2", sequence: 2, target: "answer", eventType: "answer_delta", delta: "第二段", streamId: "run-1", sessionId: "session-1", seq: 4 });
  assert.equal(entry.text, "第一段第二段");
  assert.doesNotMatch(sourceBetween(rendererSource, "function handleChatStreamFrame", "function removeSessionExecutionIndicator"), /resetPending/);
});

test("the first terminal frame is latched and later frames cannot mutate the answer", () => {
  const entry = {
    streamId: "run-terminal",
    sessionId: "session-1",
    text: "answer",
    backendCompleted: false,
    timedOut: false,
    terminalType: "",
    lastFrameSequence: 0,
    targetChars: [],
    revealedLength: 0,
    completionTimer: null,
    activity: null
  };
  const frame = liveFrameHarness(entry);
  frame({ type: "done", eventId: "run-terminal:done", sequence: 1, target: "answer", eventType: "turn_complete", streamId: entry.streamId, sessionId: entry.sessionId, seq: 1 });
  frame({ type: "delta", eventId: "run-terminal:late-answer", sequence: 2, target: "answer", eventType: "answer_delta", delta: "late", streamId: entry.streamId, sessionId: entry.sessionId, seq: 2 });
  frame({ type: "error", eventId: "run-terminal:late-error", sequence: 3, target: "execution", eventType: "turn_complete", message: "late error", streamId: entry.streamId, sessionId: entry.sessionId, seq: 3 });
  assert.equal(entry.text, "answer");
  assert.equal(entry.terminalType, "done");
  assert.equal(entry.lastFrameSequence, 1);
});

test("durable final text cannot replace a mismatched live answer that is already visible", () => {
  const finalize = sourceBetween(rendererSource, "function finalizeLiveChatStream", "function discardLiveChatStreamsForSession");
  assert.match(finalize, /finalTextDiffers/);
  assert.match(finalize, /if \(rendered && \(!hasStreamedAnswer \|\| answerPaintIncomplete\)\)/);
  assert.doesNotMatch(finalize, /rendered && \(!hasStreamedAnswer \|\| finalTextDiffers\)/);
  assert.match(finalize, /const committedText = hasStreamedAnswer && !finalExtendsStream[\s\S]*?streamedDisplayText/);
  assert.match(finalize, /renderSegmentedLiveAnswer\(entry\)/);
  assert.match(finalize, /else if \(finalTextDiffers\)[\s\S]*?durable_answer_conflicts_with_stream/);
  assert.doesNotMatch(finalize, /renderProgressiveMarkdown\(rendered, finalDisplayText/);
  assert.doesNotMatch(finalize, /addMessage\(/);
});

test("protocol recovery observes the failure but never starts a second user generation", () => {
  const wrapper = sourceBetween(mainSource, "async function runHermesSessionPromptWithRecovery", "async function sendWithHermes");
  assert.equal((wrapper.match(/runHermesSessionPrompt\(/g) || []).length, 1);
  assert.match(wrapper, /automatic_retry_suppressed/);
  assert.doesNotMatch(wrapper, /fresh_session_retry|selfHealingRecoveryAttempt|自动恢复并继续执行/);
});

test("product submissions have one per-session owner, idempotent replay, and a main-process deadline", () => {
  const submit = sourceBetween(mainSource, 'ipcMain.handle("product:submit-task"', 'ipcMain.handle("product:query-task"');
  assert.match(submit, /activeProductSubmissions\.get\(submissionKey\)/);
  assert.match(submit, /persistedProductResultForClientMessage/);
  assert.match(submit, /activeSubmission\.fingerprint !== requestFingerprint/);
  assert.match(submit, /error: "RUN_ALREADY_ACTIVE"/);
  assert.match(submit, /waitForModelRuntimeTransition\(controller\.signal\)/);
  assert.ok(submit.indexOf("activeRuns.set(sessionId") < submit.indexOf("waitForModelRuntimeTransition(controller.signal)"));
  assert.match(submit, /const controller = new AbortController\(\)/);
  assert.doesNotMatch(submit, /previousRun[\s\S]*?previousRun\.controller/);
  assert.match(submit, /timeoutMs: PRODUCT_RUN_TIMEOUT_MS/);
  const runtimeResult = submit.indexOf("submitProductWithTaskBrain(payload)");
  const commitBarrier = submit.indexOf("ensureRunActive(controller.signal)", runtimeResult);
  const persistedResult = submit.indexOf("return persistProductResult", commitBarrier);
  assert.ok(runtimeResult >= 0 && commitBarrier > runtimeResult && persistedResult > commitBarrier);
  assert.match(submit, /finishingRun\?\.controller === controller && finishingRun\?\.runId === requestRunId/);
});

test("runtime-transition waits are abortable and deadlines commit timeout before abort", async () => {
  const wait = sourceBetween(mainSource, "function waitForModelRuntimeTransition", "async function reconcileSelectedModelRuntime");
  const deadline = sourceBetween(mainSource, "function startActiveRunDeadline", "function needsDesktopAction");
  assert.match(wait, /ensureRunActive\(signal\)/);
  assert.match(wait, /signal\.addEventListener\?\.\("abort"/);
  assert.match(wait, /if \(signal\.aborted\) \{\s*onAbort\(\)/);
  assert.match(deadline, /markTimedOut\(run\.taskId, message\)/);
  assert.ok(deadline.indexOf("markTimedOut(run.taskId, message)") < deadline.indexOf("controller.abort"));

  const ensureActiveSource = sourceBetween(mainSource, "function ensureRunActive", "function withTimeout");
  const ensureActive = new Function(`${ensureActiveSource}; return ensureRunActive;`)();
  const waitForTransition = new Function(
    "modelRuntimeTransition",
    "ensureRunActive",
    `${wait}; return waitForModelRuntimeTransition;`
  )(Promise.resolve(), ensureActive);
  const raceSignal = {
    aborted: false,
    reason: { code: "TASK_TIMEOUT", message: "transition deadline" },
    addEventListener() { this.aborted = true; },
    removeEventListener() {}
  };
  await assert.rejects(waitForTransition(raceSignal), (error) => error?.code === "TASK_TIMEOUT");

  const events = [];
  const controller = {
    signal: { aborted: false },
    abort(reason) {
      events.push(["abort", reason]);
      this.signal.aborted = true;
    }
  };
  const run = { controller, taskId: "task-1" };
  const callbacks = [];
  const startDeadline = new Function(
    "activeRuns",
    "ensureTaskBrain",
    "setTimeout",
    "clearTimeout",
    `${deadline}; return startActiveRunDeadline;`
  )(
    new Map([["session-1", run]]),
    () => ({ markTimedOut: (taskId, message) => events.push(["timed_out", taskId, message]) }),
    (callback) => {
      callbacks.push(callback);
      return { unref() {} };
    },
    () => {}
  );
  startDeadline({ sessionId: "session-1", controller, timeoutMs: 1, message: "deadline" });
  callbacks[0]();
  assert.deepEqual(events, [
    ["timed_out", "task-1", "deadline"],
    ["abort", { code: "TASK_TIMEOUT", message: "deadline" }]
  ]);
  assert.equal(run.timedOut, true);
});

test("legacy chat requests reuse the same request promise and acquire a lease before waiting", () => {
  const helpers = sourceBetween(mainSource, "function productSubmissionKey", "function recoverCompletedConversationTrace");
  const send = sourceBetween(mainSource, 'ipcMain.handle("chat:send"', 'ipcMain.on("chat:abort-signal"');
  assert.match(helpers, /function runIdempotentChatSubmission/);
  assert.match(helpers, /activeChatSubmissions\.get\(submissionKey\)/);
  assert.match(helpers, /completedChatSubmissions\.get\(submissionKey\)/);
  assert.match(send, /runIdempotentChatSubmission\(payload, session\.id/);
  assert.match(send, /waitForModelRuntimeTransition\(controller\.signal\)/);
  assert.ok(send.indexOf("activeRuns.set(session.id") < send.indexOf("waitForModelRuntimeTransition(controller.signal)"));
  const runtimeResult = send.indexOf("const blackBallResponse = await productLayerChatRuntime");
  const commitBarrier = send.indexOf("ensureRunActive(controller.signal)", runtimeResult);
  const successTrace = send.indexOf('traceStatus = blackBallResponse?.ok === false ? "failed" : "success"', commitBarrier);
  assert.ok(runtimeResult >= 0 && commitBarrier > runtimeResult && successTrace > commitBarrier);
});

test("late model success is rejected before assistant persistence", () => {
  const runtime = sourceBetween(mainSource, "async function productLayerChatRuntime", "function bindUnderstandingToTaskDecision");
  const modelResult = runtime.indexOf("const result = await runHermesSessionPromptWithRecovery");
  const commitBarrier = runtime.indexOf("ensureRunActive(runtimeOptions.signal)", modelResult);
  const assistantCommit = runtime.indexOf("appendMessage(session.id", commitBarrier);
  assert.ok(modelResult >= 0 && commitBarrier > modelResult && assistantCommit > commitBarrier);
  assert.match(runtime, /runWasAbortedByUser\(session\.id, runController\)/);
  assert.match(runtime, /status: timedOut \? "timed_out" : cancelled \? "cancelled" : "failed"/);
});

test("fast no-progress timeout commits TaskBrain before aborting the transport", () => {
  const abortSignal = sourceBetween(mainSource, 'ipcMain.on("chat:abort-signal"', 'ipcMain.handle("chat:abort"');
  const taskTimeout = abortSignal.indexOf("markTimedOut(run.taskId, run.timeoutReason)");
  const transportAbort = abortSignal.indexOf("run.controller.abort");
  assert.ok(taskTimeout >= 0 && transportAbort > taskTimeout);
});

test("legacy chat idempotency shares one execution and rejects key reuse with changed content", async () => {
  const submit = chatSubmissionHarness();
  let executionCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const payload = { runId: "run-1", text: "same request" };
  const first = submit(payload, "session-1", async () => {
    executionCount += 1;
    await gate;
    return { ok: true, value: 1 };
  });
  const duplicate = submit({ ...payload }, "session-1", () => {
    executionCount += 1;
    return { ok: true, value: 2 };
  });
  assert.equal(duplicate, first);
  const conflict = await submit({ ...payload, text: "different request" }, "session-1", () => null);
  assert.equal(conflict.error, "IDEMPOTENCY_KEY_REUSED");
  release();
  assert.deepEqual(await first, { ok: true, value: 1 });
  assert.equal(executionCount, 1);
  const replay = await submit({ ...payload }, "session-1", () => {
    executionCount += 1;
    return { ok: true, value: 3 };
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(executionCount, 1);
});

test("persisted rows are adopted by response identity instead of creating a second answer", () => {
  const adoption = sourceBetween(rendererSource, "function adoptPersistedLiveStreamRow", "function flushLiveChatStream");
  const restore = sourceBetween(rendererSource, "function restoreLiveChatStream", "function restoreLiveStreamSegments");
  const send = sourceBetween(rendererSource, "async function sendCurrentTask", "async function processQueue");
  assert.match(adoption, /messageRowForId\(entry\.responseMessageId\)/);
  assert.match(adoption, /entry\.persistedRowAdopted = true/);
  assert.match(restore, /if \(entry\.persistedRowAdopted\) return true/);
  assert.match(send, /const persistedRow = responseMessageId \? messageRowForId\(responseMessageId\) : null/);
});

test("live activity keeps every uniquely identified event and no-progress aborts the owned run", () => {
  const activity = sourceBetween(rendererSource, "function setLiveStreamActivity", "function ensureLiveStreamRow");
  const progress = sourceBetween(rendererSource, "function checkLiveStreamProgress", "function reasoningSegmentKey");
  assert.match(activity, /\[\.\.\.entry\.activityDetails, activityEntry\]/);
  assert.match(activity, /uniqueExecutionActivityEntries/);
  assert.doesNotMatch(activity, /EXECUTION_ACTIVITY_HISTORY_LIMIT/);
  assert.doesNotMatch(activity, /entry\.activityDetails = \[activityEntry\]/);
  assert.match(progress, /handleLiveStreamTimeout\(entry, "连续 2 分钟/);
  assert.match(progress, /reason: "timeout"/);
});

test("manual queues de-duplicate work and stay bounded", () => {
  const queue = new SessionTaskQueue();
  const first = queue.enqueue("session-1", { text: "  Same   task  " });
  const duplicate = queue.enqueue("session-1", { text: "same task" });
  assert.equal(duplicate, first);
  assert.equal(queue.list("session-1").length, 1);
  assert.equal(first.autoStart, false);
  for (let index = 1; index < 20; index += 1) queue.enqueue("session-1", { text: `task-${index}` });
  assert.equal(queue.list("session-1").length, 20);
  assert.equal(queue.enqueue("session-1", { text: "overflow" }), null);
});
