"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const SessionTaskQueue = require("../renderer-v2/session-task-queue");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ visible = false, streaming = false } = {}) {
  const sent = [], saved = [], displayed = [], aborted = [];
  const state = {
    selectedSessionId: visible ? "one" : "two", attachments: [{ name: "draft.png" }],
    composerQuote: { sessionId: visible ? "one" : "two", messageId: "unsent-draft" },
    db: { sessions: [{ id: "one", status: "completed" }, { id: "two", status: "completed" }] },
    abortRequestedSessions: new Set(), abortedStreamIds: new Set(), closedClarificationSessions: new Set(),
    pendingClarificationCards: new Map(), messageWindowOffsets: new Map(), currentMessages: []
  };
  let nextResult = async () => ({ success: true, status: "completed", text: "已完成" });
  let appendFailure = false;
  let sequence = 0;
  const noop = () => {};
  const context = {
    console, setTimeout, clearTimeout, clearInterval, queueMicrotask, Date, Math, Promise, performance,
    cancelAnimationFrame: noop,
    LIVE_TURN_STATES: { CREATED: 'CREATED', RUNNING: 'RUNNING', TERMINAL_RECEIVED: 'TERMINAL_RECEIVED',
      ANSWER_COMMITTED: 'ANSWER_COMMITTED', VIEW_DRAINED: 'VIEW_DRAINED', CLOSED: 'CLOSED' },
    transitionLiveTurn: (entry, next) => { entry.turnState = next; },
    state, sessionTaskQueue: new SessionTaskQueue(), queueDispatches: new Set(),
    activeSendOwners: new Map(), liveChatStreams: new Map(), activeAssistantTypings: new Map(),
    locallyCompletedSessions: new Set(), chatInput: { value: "正在编辑的草稿" }, draftSaveTimer: null,
    taskState: {}, monitorMode: {}, recordState: {}, monitorSession: {}, messageList: {},
    selectedSession: () => state.db.sessions.find(item => item.id === state.selectedSessionId),
    activeLiveChatStreamForSession: id => [...context.liveChatStreams.values()].find(entry => entry.sessionId === id),
    activeAssistantTypingForSession: id => context.activeAssistantTypings.get(id),
    miniTheatre: { start: noop, select: noop, finish: noop },
    isWechatChatSession: () => false, isTaskBrainConfirmation: result => result.requiresConfirmation,
    messageDurationMs: () => 0, buildPersistedAttachments: items => items,
    createChatStreamId: id => id + ":" + ++sequence,
    productResultText: result => result.text,
    addMessage: message => { displayed.push(message); return null; },
    finalizeLiveChatStream: () => streaming ? {} : null,
    messageRowForId: () => null,
    registerLiveChatStream: (id, sessionId) => {
      if (streaming) context.liveChatStreams.set(id, { streamId: id, sessionId });
    },
    createThinkingMessage: () => null,
    waitForVisibleOutputDrain: async () => {},
    api: {
      appendMessage: async (id, message) => {
        if (appendFailure) throw new Error("disk failed");
        saved.push({ id, message });
      },
      productSubmitTask: async input => { sent.push(input); return nextResult(input); },
      init: async () => state.db,
      ownerStatus: async () => ({}), productQueryTask: async () => null,
      signalAbortChat: input => aborted.push(input), abortChat: async () => ({ ok: true })
    }
  };
  for (const name of ["renderQueue", "showCopyToast", "clearComposerSuggestions", "rememberPendingUserMessage",
    "rememberAuthoritativeMessage", "removeThinkingMessage", "renderMessages", "saveSessionDraft", "adjustComposerHeight",
    "renderAttachments", "renderComposerQuote", "anchorNewInstruction", "setBusy", "scheduleExecutionPresenceCheck",
    "updateProjectTreePresentation", "setTaskProgressStage", "setNewOutputAvailable", "scrollMessagesToBottom",
    "renderProductDashboard", "appendLiveStreamNotice", "discardLiveChatStream", "renderAll", "scheduleStreamingScroll",
    "removeSessionExecutionIndicator", "ensureSessionExecutionMotion", "stopProgress", "renderSessions", "statusText",
    "renderMonitorLog", "renderMetricBars", "renderTaskProgressRail", "renderTaskBoard", "clearPendingClarificationCards",
    "clearComposerClarification", "preserveCancelledLiveChatStream", "discardLiveChatStreamsForSession",
    "stopExecutionActivityFlow", "releaseLiveChatStreamRow", "reportStartupMetric"] ) context[name] = noop;
  context.console = { ...console, error: noop };
  vm.createContext(context);
  vm.runInContext([
    between("const EXECUTION_TERMINAL_STATUSES", "async function selectSessionById"),
    between("function activeSendOwnerMatches", "function renderedMessageWindowMatches"),
    between("function closeLiveChatStream", "function formatTaskDuration"),
    between("async function submitProductInput", "function renderProductDashboard"),
    between("function isBusyProductResult", "async function discardUnstartedProductMessage"),
    between("async function abortCurrentTask", "let wechatSendPending"),
    between("async function enqueueCurrentTask", "async function abortCurrentTask"),
    between("function finishQueuedTaskEdit", "function finalizeVisibleStreamNow"),
    between("async function sendCurrentTask", 'attachBtn.addEventListener'),
    between("async function startQueuedTask", "function clearQueueSortIndicators")
  ].join("\n"), context);
  return { context, sent, saved, displayed, aborted,
    result: handler => { nextResult = handler; }, failAppend: () => { appendFailure = true; } };
}

test("a successful turn sends already confirmed supplements in order to the original session", async () => {
  const fixture = harness();
  const { context, sent, saved } = fixture;
  let complete;
  fixture.result(() => new Promise(resolve => { complete = resolve; }));
  const original = context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
  await tick();
  const attachment = { name: "图片.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" };
  const quote = { sessionId: "source", messageId: "quoted", text: "原文", attachments: [attachment] };
  context.sessionTaskQueue.enqueue("one", { text: "补充一", attachments: [attachment], quote, autoStart: true });
  context.sessionTaskQueue.enqueue("one", { text: "补充二", attachments: [], autoStart: true });
  await Promise.all([context.processQueue("one"), context.processQueue("one")]);
  assert.equal(sent.length, 1);
  fixture.result(async () => ({ success: true, status: "completed", text: "补充处理完成" }));
  complete({ success: true, status: "completed", text: "原任务结果" });
  await original;
  await tick();
  await tick();
  assert.equal(sent.length, 3);
  assert.ok(sent.every(input => input.sessionId === "one"));
  assert.match(sent[1].message, /补充一/);
  assert.match(sent[1].message, /不要丢弃原目标/);
  assert.equal(sent[1].attachments[0].dataUrl, attachment.dataUrl);
  assert.equal(sent[1].quote.messageId, "quoted");
  assert.match(sent[2].message, /补充二/);
  assert.deepEqual(saved.filter(item => item.message.role === "user").map(item => item.message.text), ["原任务", "补充一", "补充二"]);
  assert.equal(context.chatInput.value, "正在编辑的草稿");
  assert.equal(context.state.selectedSessionId, "two");
  assert.equal(context.sessionTaskQueue.list("one").length, 0);
});

test("completed turn dispatches supplements despite a stale running snapshot", async () => {
  const fixture = harness();
  const { context, sent } = fixture;
  context.state.db.sessions[0].status = "running";
  fixture.result(async input => ({
    success: true,
    status: "completed",
    text: input.message.includes("补充") ? "补充完成" : "原任务完成"
  }));
  context.sessionTaskQueue.enqueue("one", { text: "补充", autoStart: true });
  context.sessionTaskQueue.enqueue("one", { text: "第二条补充", autoStart: true });

  await context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
  await tick();
  await tick();

  assert.equal(sent.length, 3);
  assert.match(sent[1].message, /补充/);
  assert.equal(context.sessionTaskQueue.list("one").length, 0);
});

test("a committed view closing before the IPC result cannot cancel automatic supplements", async () => {
  const fixture = harness({ visible: true, streaming: true });
  const { context, sent } = fixture;
  let complete;
  fixture.result(() => new Promise(resolve => { complete = resolve; }));
  const original = context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
  await tick();
  context.sessionTaskQueue.enqueue("one", { text: "补充", autoStart: true });
  const streamId = context.activeSendOwners.get("one");
  const entry = context.liveChatStreams.get(streamId);
  entry.turnState = "VIEW_DRAINED";
  entry.backendCompleted = true;
  context.closeLiveChatStream(streamId, { reason: "view_drained" });
  assert.equal(context.activeSendOwners.get("one"), streamId, "Display cleanup released an unfinished submission");
  await tick();
  assert.equal(sent.length, 1);
  fixture.result(async () => ({ success: true, status: "completed", text: "补充完成" }));
  complete({ success: true, status: "completed", text: "原任务完成" });
  await original;
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(context.sessionTaskQueue.isPaused("one"), false);
});

test("display drain automatically wakes the queue after successful submission cleanup", async () => {
  for (const force of [false, true]) {
    const { context, sent } = harness({ visible: true, streaming: true });
    context.sessionTaskQueue.enqueue("one", { text: "补充", autoStart: true });
    await context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
    assert.equal(sent.length, 1);
    const streamId = context.activeSendOwners.get("one");
    context.liveChatStreams.get(streamId).turnState = "VIEW_DRAINED";
    context.closeLiveChatStream(streamId, { force, reason: force ? "detached_session_row" : "view_drained" });
    await tick();
    assert.equal(sent.length, 2, `No automatic wake after force=${force}`);
    await tick();
    assert.equal(sent.length, 2, "Duplicate wake repeated the supplement");
  }
});

test("a view drained during final snapshot refresh releases the stop button and confirmed queue", async () => {
  for (const refreshFails of [false, true]) {
    const fixture = harness({ visible: true, streaming: true });
    const { context, sent } = fixture;
    let refreshCount = 0;
    let settleRefresh;
    context.setBusy = value => { context.state.busy = value; };
    context.api.init = async () => {
      if (++refreshCount === 2) return new Promise((resolve, reject) => {
        settleRefresh = () => refreshFails ? reject(new Error("snapshot failed")) : resolve(context.state.db);
      });
      return context.state.db;
    };
    const original = context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
    const settled = original.then(() => null, error => error);
    await tick();
    assert.equal(typeof settleRefresh, "function");
    const streamId = context.activeSendOwners.get("one");
    const entry = context.liveChatStreams.get(streamId);
    entry.turnState = "VIEW_DRAINED";
    entry.backendCompleted = true;
    context.closeLiveChatStream(streamId, { reason: "view_drained" });
    assert.equal(context.sessionTaskQueue.isPending("one"), true);
    assert.equal(context.activeSendOwners.get("one"), streamId);
    settleRefresh();
    const error = await settled;
    assert.equal(Boolean(error), refreshFails);
    assert.equal(context.activeSendOwners.has("one"), false);
    assert.equal(context.sessionTaskQueue.isPending("one"), false);
    assert.equal(context.sessionTaskQueue.isActive("one"), false);
    assert.equal(context.sessionIsRunning(context.selectedSession()), false);
    assert.equal(context.state.busy, false);
    context.sessionTaskQueue.enqueue("one", { text: "补充", autoStart: true });
    await context.processQueue("one");
    assert.equal(sent.length, 2);
    assert.match(sent[1].message, /补充/);
  }
});

test("view cleanup cannot turn a failed or cancelled submission into automatic delivery", async () => {
  for (const result of [
    { success: false, status: "failed" },
    { success: false, status: "cancelled" },
    { success: true, status: "awaiting_input" },
    { success: true, status: "completed", deliveryPending: true }
  ]) {
    const fixture = harness({ visible: true, streaming: true });
    const { context, sent } = fixture;
    let complete;
    fixture.result(() => new Promise(resolve => { complete = resolve; }));
    const original = context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
    await tick();
    context.sessionTaskQueue.enqueue("one", { text: "保留的补充", autoStart: true });
    const streamId = context.activeSendOwners.get("one");
    context.liveChatStreams.get(streamId).turnState = "VIEW_DRAINED";
    context.closeLiveChatStream(streamId);
    complete({ ...result, text: "已产生的内容" });
    await original;
    await tick();
    assert.equal(sent.length, 1, JSON.stringify(result));
    assert.equal(context.sessionTaskQueue.isPaused("one"), true);
    assert.equal(context.sessionTaskQueue.list("one")[0].text, "保留的补充");
  }
});

test("discarding a detached running view retains request ownership until real completion", async () => {
  const fixture = harness({ visible: true, streaming: true });
  const { context, sent } = fixture;
  let complete;
  fixture.result(() => new Promise(resolve => { complete = resolve; }));
  const original = context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
  await tick();
  context.sessionTaskQueue.enqueue("one", { text: "回到原会话的补充", autoStart: true });
  const streamId = context.activeSendOwners.get("one");
  context.state.selectedSessionId = "two";
  context.discardLiveChatStream(streamId, { reason: "detached_session_row" });
  await tick();
  assert.equal(context.activeSendOwners.get("one"), streamId);
  assert.equal(sent.length, 1);
  fixture.result(async () => ({ success: true, status: "completed", text: "补充完成" }));
  complete({ success: true, status: "completed", text: "原任务完成" });
  await original;
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sessionId, "one");
  assert.equal(context.state.selectedSessionId, "two");
});

test("a late old view cannot unlock a replacement run or clear its stop request", async () => {
  const { context, sent } = harness({ visible: true, streaming: true });
  context.sessionTaskQueue.enqueue("one", { text: "待处理", autoStart: true });
  context.liveChatStreams.set("old", { sessionId: "one", streamId: "old", turnState: "VIEW_DRAINED" });
  context.activeSendOwners.set("one", "replacement");
  context.sessionTaskQueue.beginRun("one", "replacement");
  context.sessionTaskQueue.setActive("one", true);
  context.state.abortRequestedSessions.add("one");
  context.closeLiveChatStream("old");
  await tick();
  assert.equal(context.activeSendOwners.get("one"), "replacement");
  assert.equal(context.sessionTaskQueue.isPending("one"), true);
  assert.equal(context.sessionTaskQueue.isActive("one"), true);
  assert.equal(context.state.abortRequestedSessions.has("one"), true);
  assert.equal(sent.length, 0);
});

test("automatic delivery preserves the visible composer and does not borrow its quote", async () => {
  const { context, sent, displayed } = harness({ visible: true });
  context.sessionTaskQueue.enqueue("one", { text: "用户补充", attachments: [], autoStart: true });
  await context.processQueue("one");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quote, undefined);
  assert.equal(displayed[0].text, "用户补充");
  assert.equal(context.chatInput.value, "正在编辑的草稿");
  assert.equal(context.state.attachments[0].name, "draft.png");
  assert.equal(context.state.composerQuote.messageId, "unsent-draft");
});

test("failed, cancelled, waiting and nonterminal results pause the queue", async () => {
  for (const result of [
    { success: false, status: "failed" }, { success: true, status: "cancelled" },
    { success: true, requiresConfirmation: true }, { success: true, requiresModelConfiguration: true },
    { success: true, status: "running" }, { success: true, deliveryPending: true }
  ]) {
    const fixture = harness();
    fixture.result(async () => ({ ...result, text: "已有结果" }));
    fixture.context.sessionTaskQueue.enqueue("one", { text: "补充", autoStart: true });
    await fixture.context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
    await fixture.context.processQueue("one");
    assert.equal(fixture.sent.length, 1, JSON.stringify(result));
    assert.equal(fixture.context.sessionTaskQueue.list("one").length, 1);
    assert.equal(fixture.context.sessionTaskQueue.isPaused("one"), true);
  }
});

test("stop preserves supplements and late success cannot restart them", async () => {
  const fixture = harness({ visible: true });
  let complete;
  fixture.result(() => new Promise(resolve => { complete = resolve; }));
  const original = fixture.context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
  await tick();
  fixture.context.sessionTaskQueue.enqueue("one", { text: "不要删除", autoStart: true });
  await fixture.context.abortCurrentTask();
  complete({ success: true, text: "迟到的完成", status: "completed" });
  await original;
  await tick();
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.context.sessionTaskQueue.list("one")[0].text, "不要删除");
  assert.equal(fixture.context.sessionTaskQueue.isPaused("one"), true);
});

test("stream drain and active typing block follow-up even after backend success", async () => {
  const { context, sent } = harness({ visible: true, streaming: true });
  context.sessionTaskQueue.enqueue("one", { text: "随后补充", autoStart: true });
  await context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
  assert.equal(sent.length, 1);
  context.liveChatStreams.clear();
  context.activeSendOwners.clear();
  context.sessionTaskQueue.setActive("one", false);
  context.activeAssistantTypings.set("one", {});
  await context.processQueue("one");
  assert.equal(sent.length, 1);
  context.activeAssistantTypings.clear();
  await context.processQueue("one");
  assert.equal(sent.length, 2);
});

test("duplicate dispatches are serialized and failed acceptance restores the task", async () => {
  const fixture = harness();
  fixture.context.sessionTaskQueue.enqueue("one", { text: "补充", autoStart: true });
  await Promise.all(Array.from({ length: 8 }, () => fixture.context.processQueue("one")));
  assert.equal(fixture.sent.length, 1);
  fixture.context.sessionTaskQueue.enqueue("one", { text: "持久化失败", autoStart: true });
  fixture.failAppend();
  await fixture.context.processQueue("one");
  assert.equal(fixture.context.sessionTaskQueue.list("one")[0].text, "持久化失败");
  assert.equal(fixture.context.sessionTaskQueue.isPaused("one"), true);
});

test("editing blocks dispatch; choosing next never interrupts the active run", async () => {
  const { context, sent, aborted } = harness();
  const first = context.sessionTaskQueue.enqueue("one", { text: "第一条" });
  const second = context.sessionTaskQueue.enqueue("one", { text: "第二条", quote: { messageId: "original" }, context: { value: "选项" } });
  first.editing = true;
  await context.processQueue("one");
  assert.equal(sent.length, 0);
  context.state.db.sessions[0].status = "running";
  await context.startQueuedTask(context.state.db.sessions[0], second);
  assert.equal(aborted.length, 0);
  assert.equal(context.sessionTaskQueue.list("one")[0], second);
  context.sessionTaskQueue.update("one", second.id, { text: "修改后" });
  assert.equal(second.quote.messageId, "original");
  assert.equal(second.context.value, "选项");
});

test("stale run completion does not unlock or pause a newer run", () => {
  const queue = new SessionTaskQueue();
  queue.beginRun("one", "old");
  queue.beginRun("one", "new");
  assert.equal(queue.finishRun("one", "old", false), false);
  assert.equal(queue.isPending("one"), true);
  assert.equal(queue.isPaused("one"), false);
  queue.pause("one");
  queue.finishRun("one", "new", true);
  assert.equal(queue.isPaused("one"), true);
});

test("transport failure pauses, explicit resume sends only remaining supplements", async () => {
  const fixture = harness();
  fixture.result(async () => { throw new Error("HTTP 502"); });
  const queue = fixture.context.sessionTaskQueue;
  const removed = queue.enqueue("one", { text: "应被删除", autoStart: true });
  queue.enqueue("one", { text: "继续补充", autoStart: true });
  await fixture.context.sendCurrentTask({ text: "原任务", attachments: [] }, "one");
  queue.remove("one", removed.id);
  await fixture.context.processQueue("one");
  assert.equal(fixture.sent.length, 1);
  fixture.result(async () => ({ success: true, status: "completed", text: "恢复成功" }));
  await fixture.context.startQueuedTask(fixture.context.state.db.sessions[0], queue.list("one")[0]);
  assert.equal(fixture.sent.length, 2);
  assert.match(fixture.sent[1].message, /继续补充/);
  assert.equal(queue.list("one").length, 0);
});

test("quote-only and attachment-only supplements use their original session and payload", async () => {
  const { context, sent } = harness();
  context.sessionTaskQueue.enqueue("one", { quote: { sessionId: "source", messageId: "quote-only" }, autoStart: true });
  context.sessionTaskQueue.enqueue("two", { attachments: [{ name: "表格.csv", textContent: "a,b\n1,2" }], autoStart: true });
  await Promise.all([context.processQueue("one"), context.processQueue("two")]);
  assert.equal(sent.length, 2);
  const quoted = sent.find(input => input.sessionId === "one");
  const attached = sent.find(input => input.sessionId === "two");
  assert.equal(quoted.quote.messageId, "quote-only");
  assert.equal(attached.attachments[0].textContent, "a,b\n1,2");
  assert.equal(attached.quote, undefined);
});

test("live text supplement steers the original turn without aborting or creating a new task", async () => {
  const { context, sent, aborted } = harness();
  const received = [];
  context.activeSendOwners.set("one", "original-turn");
  context.api.supplementChat = async input => {
    received.push(input);
    return { accepted: true, status: "applied" };
  };
  context.sessionTaskQueue.enqueue("one", { id: "supplement-one", text: "改为中文", deliveryMode: "steer", autoStart: true });
  await Promise.all([context.processQueue("one"), context.processQueue("one")]);
  assert.equal(received.length, 1);
  assert.equal(received[0].runId, "original-turn");
  assert.equal(received[0].supplementId, "supplement-one");
  assert.equal(sent.length, 0);
  assert.equal(aborted.length, 0);
  assert.equal(context.sessionTaskQueue.list("one").length, 0);
  assert.equal(context.activeSendOwners.get("one"), "original-turn");
});

test("live attachments and quotes remain intact in the next-turn queue", async () => {
  const { context, sent } = harness();
  context.activeSendOwners.set("one", "original-turn");
  context.api.supplementChat = async () => { throw new Error("must not strip attachments"); };
  const attachment = { name: "image.png", dataUrl: "data:image/png;base64,AA==" };
  const queued = context.sessionTaskQueue.enqueue("one", { text: "看附件", deliveryMode: "steer", autoStart: true,
    attachments: [attachment], quote: { messageId: "quote" } });
  await context.processQueue("one");
  assert.equal(queued.deliveryMode, "queue");
  assert.equal(queued.attachments[0].dataUrl, attachment.dataUrl);
  assert.equal(queued.quote.messageId, "quote");
  assert.equal(sent.length, 0);
});

test("unknown supplement receipts retain identity and never launch duplicate work", async () => {
  const { context, sent } = harness();
  const received = [];
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.activeSendOwners.set("one", "original-turn");
  context.api.supplementChat = async input => { received.push(input); return { accepted: null, status: "unknown" }; };
  const queued = context.sessionTaskQueue.enqueue("one", { text: "不能丢失", deliveryMode: "steer", autoStart: true });
  await context.processQueue("one");
  context.activeSendOwners.clear();
  await context.processQueue("one");
  await context.processQueue("one");
  assert.equal(received.length, 3);
  assert.ok(received.every(input => input.supplementId === queued.id && input.runId === "original-turn"));
  assert.equal(context.sessionTaskQueue.isPaused("one"), true);
  assert.equal(context.sessionTaskQueue.list("one")[0].text, "不能丢失");
  assert.equal(sent.length, 0);
});

test("a preset supplement waits for the current task and then sends automatically", async () => {
  const { context, sent } = harness({ visible: true });
  context.activeSendOwners.set("one", "running-turn");
  context.chatInput.value = "任务完成后自动补充";
  await context.enqueueCurrentTask({ deliveryMode: "queue" });
  const preset = context.sessionTaskQueue.list("one")[0];
  assert.equal(preset.autoStart, true);
  assert.equal(preset.deliveryMode, "queue");
  await context.processQueue("one");
  context.activeSendOwners.clear();
  await context.processQueue("one");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "以下是用户对本会话当前任务的补充。请结合已完成的结果和原始目标继续处理；除非用户明确改变目标，否则不要丢弃原目标。\n\n任务完成后自动补充");
  assert.equal(context.sessionTaskQueue.list("one").length, 0);
});

test("the normal Enter path sends an immediate supplement", async () => {
  const { context, sent } = harness({ visible: true });
  const received = [];
  context.activeSendOwners.set("one", "running-turn");
  context.api.supplementChat = async input => { received.push(input); return { accepted: true, status: "applied" }; };
  context.state.attachments = [];
  context.state.composerQuote = null;
  context.chatInput.value = "现在就补充";
  await context.enqueueCurrentTask();
  assert.equal(received.length, 1);
  assert.equal(received[0].runId, "running-turn");
  assert.equal(received[0].text, "现在就补充");
  assert.equal(sent.length, 0);
  assert.equal(context.sessionTaskQueue.list("one").length, 0);
});

test("an unsent draft does not block another explicitly submitted supplement", async () => {
  const { context, sent } = harness();
  const draft = context.sessionTaskQueue.enqueue("one", { text: "还在编辑" });
  context.sessionTaskQueue.enqueue("one", { text: "已确认发送", autoStart: true });
  await context.processQueue("one");
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(context.sessionTaskQueue.list("one")[0], draft);
});
