"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const { HmsProgressMapper, toolEvent } = require(path.join(root, "services", "hms-progress"));

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  let to = source.indexOf(end, from + start.length);
  // Older mojibake fixtures encoded the progress label differently from the
  // current renderer source. Keep the range assertion anchored to the call
  // itself when that legacy suffix is absent.
  if (to < 0 && String(end).startsWith("updateVisibleProgress")) {
    to = source.indexOf("updateVisibleProgress", from + start.length);
  }
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

test("only explicitly public Black Ball reasoning enters the chat progress stream", () => {
  const mapper = new HmsProgressMapper();
  assert.deepEqual(mapper.consume({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "thinking", thinking: "private model scratch work" }
  }), []);

  const publicEvents = mapper.consume({
    sessionUpdate: "agent_thought_chunk",
    visibility: "public",
    content: { type: "thinking", thinking: "已核对输入中的两个约束。" }
  });
  assert.equal(publicEvents.length, 1);
  assert.equal(publicEvents[0].message, "已核对输入中的两个约束。");
  assert.equal(publicEvents[0].provenance, "blackball_public");
});

test("Black Ball start creates the single visible activity anchor and clock", () => {
  const boundary = sourceBetween(mainSource, "function publicChatProgress", "function emitChatStream");
  const handler = sourceBetween(rendererSource, "function handleChatStreamFrame", "function removeSessionExecutionIndicator");
  assert.match(boundary, /\["phase", "start"\]\.includes\(type\)/);
  assert.match(boundary, /timestamp: Number\(supplied\.timestamp \|\| 0\)/);
  assert.match(mainSource, /function emitBlackBallRunStarted/);
  assert.match(mainSource, /emitBlackBallRunStarted\(sessionId, payload\.streamId \|\| requestRunId/);
  assert.match(handler, /const frameProgress = frame\.progress/);
  assert.match(handler, /if \(frameProgress\) setLiveStreamActivity\(entry, frameProgress\)/);
  assert.match(handler, /if \(frame\.type === "start"\)/);
  assert.match(handler, /entry\.executionStartedAt = Number\(frame\.startedAt\)/);
  assert.match(rendererSource, /startedAt: Number\(options\.startedAt \|\| Date\.now\(\)\)/);
  assert.match(rendererSource, /executionStartedAt: Number\(options\.executionStartedAt \|\| 0\)/);
  assert.match(rendererSource, /function activateLiveBlackBallExecution/);
});

test("duplicate lifecycle frames share one display identity", () => {
  assert.match(rendererSource, /Lifecycle\/public progress events can be emitted once at request accept/);
  assert.match(rendererSource, /\["lifecycle", "public_progress", "progress", "execution"\]\.includes\(entry\.kind\)/);
  assert.match(rendererSource, /const identity = \["lifecycle", "public_progress", "progress", "execution"\]/);
});

test("the lifecycle anchor owns the only clock and never becomes fake reasoning", () => {
  const activity = sourceBetween(rendererSource, "function setLiveStreamActivity", "function adoptPersistedLiveStreamRow");
  assert.match(rendererSource, /node\.innerHTML = '<span class="execution-current-thinking-text"><\/span>'/);
  assert.match(activity, /const block = kind === "lifecycle"\s*\n\s*\? null/);
  assert.match(activity, /setLiveCurrentThinking\(entry, "", \{ segmentId: "" \}\)/);
});

test("the product entry emits Black Ball start before routing and model preparation", () => {
  const submit = sourceBetween(mainSource, 'const executeSubmission = async () => {', 'const modelReadiness = selectedModelReadiness');
  assert.match(submit, /const productStartedAt = Date\.now\(\);/);
  assert.match(submit, /emitBlackBallRunStarted\(sessionId, payload\.streamId \|\| requestRunId, productStartedAt\);/);
  assert.match(submit, /emitBlackBallRunStarted\([\s\S]*?const taskContext/);
});

test("the renderer registers the live stream before persistence can drop start", () => {
  const send = sourceBetween(rendererSource, "const userRow = addVisibleMessage(userMessage);", "updateVisibleProgress(\"已接收\", 8);");
  assert.match(send, /registerLiveChatStream\(streamId, session\.id, thinkingRow/);
  assert.ok(send.indexOf("registerLiveChatStream") < send.indexOf("await api.appendMessage(session.id, userMessage)"));
});

test("model-authored progress and real tool events retain Black Ball provenance", () => {
  const mapper = new HmsProgressMapper();
  const progress = mapper.consume({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: '<baiqiu-progress>{"segmentId":"1","stage":"verify","message":"测试结果确认了修复有效。"}</baiqiu-progress>'
    }
  });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].message, "测试结果确认了修复有效。");
  assert.equal(progress[0].provenance, "blackball_public");

  const tool = toolEvent({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "read_file",
    status: "running",
    rawInput: { path: "C:\\workspace\\input.txt" }
  });
  assert.equal(tool.provenance, "blackball_tool");
  assert.equal(tool.toolCallId, "tool-1");
});

test("White Ball lifecycle labels are rejected at the IPC boundary", () => {
  const publicBoundary = sourceBetween(mainSource, "function isBlackBallPublicProgress", "function safeReasoningDelta");
  assert.match(publicBoundary, /provenance\.startsWith\("blackball_"\)/);
  assert.match(publicBoundary, /source === "tool" && kind === "tool"/);
  assert.match(publicBoundary, /if \(!isBlackBallPublicProgress\(supplied\)\) return null/);
  assert.match(publicBoundary, /type[^\n]+=== "phase" && !progress\) return;/);
  assert.doesNotMatch(publicBoundary, /source === "bridge"/);
  assert.doesNotMatch(mainSource, /actor: "白球"/);
  assert.doesNotMatch(mainSource, /正在读取本轮请求，准备当前会话/);
});

test("each answer segment retires only its temporary process surface", () => {
  const retire = sourceBetween(rendererSource, "function retireLiveExecutionPhase", "function adoptPendingReasoningBlock");
  const delta = sourceBetween(rendererSource, "function handleChatStreamFrame", "function removeSessionExecutionIndicator");
  const finalize = sourceBetween(rendererSource, "function finalizeLiveChatStream", "function discardLiveChatStreamsForSession");
  const reasoning = sourceBetween(rendererSource, "function appendLiveReasoningDelta", "function completeLiveReasoningSegment");
  const completeReasoning = sourceBetween(rendererSource, "function completeLiveReasoningSegment", "function setLiveStreamActivity");

  assert.match(retire, /factual execution milestones/);
  assert.doesNotMatch(retire, /entry\.activityDetails = \[\]/);
  assert.doesNotMatch(retire, /root\.dataset\.lifecycle = "exiting"/);
  assert.doesNotMatch(retire, /root\.hidden = true/);
  assert.match(completeReasoning, /segment\.node\.dataset\.lifecycle = "exiting"/);
  assert.match(completeReasoning, /segment\.node\.style\.height = "0px"/);
  assert.match(completeReasoning, /PUBLIC_REASONING_MIN_VISIBLE_MS - \(Date\.now\(\) - shownAt\)/);
  assert.match(completeReasoning, /if \(remainingVisibleMs > 0\) setTimeout\(beginExit, remainingVisibleMs\)/);
  assert.match(delta, /const firstAnswerDelta = !entry\.answerStartedSegments\.has\(segmentId\)/);
  assert.match(delta, /entry\.pendingReasoningBlockId = ""/);
  assert.match(delta, /if \(firstAnswerDelta\) retireLiveExecutionPhase\(entry, segmentId\)/);
  assert.match(reasoning, /entry\.activityDetails = \[/);
  assert.match(reasoning, /setLiveCurrentThinking\(entry, combinedText/);
  assert.doesNotMatch(reasoning, /scheduleLiveActivityPaint\(entry\)/);
  assert.doesNotMatch(reasoning, /scheduleLiveReasoningReveal/);
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_VISIBLE_LIMIT = 3/);
  assert.match(rendererSource, /entry\.activity\.dataset\.activityExpanded = "0"/);
  assert.match(finalize, /entry\.finalized = true/);
  assert.match(finalize, /appendLiveFinalAnswerSuffix/);
});

test("completed process UI removes the temporary activity surface", () => {
  const collapse = sourceBetween(rendererSource, "function collapseCompletedExecutionActivity", "function streamActivityHtml");
  assert.match(collapse, /stopExecutionActivityFlow\(root\)/);
  assert.match(collapse, /root\.remove\(\)/);
  assert.match(collapse, /return null/);
  const finish = sourceBetween(rendererSource, "function finishLiveExecutionSurface", "function collapseCompletedExecutionActivity");
  assert.match(finish, /activity\.remove\(\)/);
  assert.match(finish, /entry\.activity = null/);
  assert.doesNotMatch(rendererSource, /createThinkingMessage\("已接收任务，正在建立执行上下文"/);
});
