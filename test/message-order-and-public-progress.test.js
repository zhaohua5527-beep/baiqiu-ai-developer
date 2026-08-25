"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const { publicActivityText } = require(path.join(root, "services", "hms-progress"));

test("assistant persistence is bound to the originating user turn", () => {
  const append = mainSource.slice(
    mainSource.indexOf("function appendMessage"),
    mainSource.indexOf("function assistantCompletesUserMessage")
  );
  const persist = mainSource.slice(
    mainSource.indexOf("function persistProductResult"),
    mainSource.indexOf("function canConnect")
  );

  assert.match(append, /const replyToUserId = message\.role === "assistant"/);
  assert.match(append, /findIndex\(\(entry\) => entry\?\.role === "user"[\s\S]*?replyToUserId/);
  assert.match(append, /splice\(insertAt, 0, item\)/);
  assert.match(mainSource, /const responseMessageId = clientMessageId \? `product-result:\$\{clientMessageId\}`/);
  assert.match(mainSource, /const appendBoundAssistant = \(text, raw = \{\}\)/);
  assert.match(persist, /message\.id === responseMessageId \|\| assistantCompletesUserMessage\(message, String\(clientMessageId/);
  assert.doesNotMatch(persist, /!previousIds\.has\(message\.id\)/);
});

test("persisted chat and task replies include a real duration for renderer recovery", () => {
  assert.match(mainSource, /async function productLayerChatRuntime\(input = \{\}\) \{\s*const runtimeStartedAt = Date\.now\(\);/);
  assert.match(mainSource, /durationMs: Math\.max\(1, Date\.now\(\) - runtimeStartedAt\)/);
  const taskSubmit = mainSource.slice(
    mainSource.indexOf("async function submitProductWithTaskBrain"),
    mainSource.indexOf("function ensureSession", mainSource.indexOf("async function submitProductWithTaskBrain"))
  );
  assert.match(taskSubmit, /durationMs: Math\.max\(\s*1,\s*Number\(raw\?\.durationMs \|\| 0\),\s*Date\.now\(\) - productTimingStartedAt/);
});

test("public progress removes runtime identity names without exposing private thought text", () => {
  const text = publicActivityText("黑球项目 CEO 正在规划，Worker 正在执行");
  assert.match(text, /正在规划/);
  assert.match(text, /正在执行/);
  assert.doesNotMatch(text, /黑球|白球|HMS|Hermes|CEO|Worker|Agent/i);
  const activityFormatter = rendererSource.slice(
    rendererSource.indexOf("function activityDetailText"),
    rendererSource.indexOf("function executionActivityEntry")
  );
  assert.match(activityFormatter, /Render the event[\s\S]*?supplied by the model/);
  assert.match(activityFormatter, /return value\.slice\(0, 20000\)/);
  assert.doesNotMatch(activityFormatter, /HMS\|Hermes\|CEO\|Worker\|Agent/);
});

test("stream transport preserves model progress identity and transient runtime state", () => {
  assert.match(mainSource, /const kind = safeActivitySnippet\(supplied\.kind/);
  assert.match(mainSource, /kind,\s*phase,/);
  assert.match(mainSource, /transient: supplied\.transient === true/);
  assert.match(mainSource, /\[Public response channel protocol\]/);
  assert.match(mainSource, /publish a concise factual public reasoning summary before each answer segment/);
  assert.match(mainSource, /公开判断必须包含真实逻辑/);
  assert.match(mainSource, /Continuously write real public work summaries/);
  assert.match(mainSource, /公开过程必须按真实段落严格交替发送/);
  assert.match(mainSource, /credentials/);
  assert.match(mainSource, /function isBlackBallPublicProgress/);
  assert.match(rendererSource, /entry\.activityTransient = transient;/);
  assert.doesNotMatch(rendererSource, /modelPublicProgressStarted[\s\S]{0,240}clearExecutionActivityDetails/);
});

test("reasoning and reply streams are sequenced and painted without local replay", () => {
  assert.match(mainSource, /const chatStreamFrameSequences = new Map\(\);/);
  assert.match(mainSource, /\.\.\.frame,\s*seq,/);
  assert.match(mainSource, /delta: \["reasoning_delta", "reasoning_note", "public_reasoning"\]\.includes\(kind\)/);
  assert.match(rendererSource, /frameSequence > 0 && frameSequence <= Number\(entry\.lastFrameSequence \|\| 0\)/);
  assert.match(rendererSource, /function appendLiveReasoningDelta\(entry, progress = \{\}\)/);
  assert.match(rendererSource, /activityPaintFrame = requestAnimationFrame/);
  assert.match(rendererSource, /const continuesCurrentReasoning = previous/);
  const liveReveal = rendererSource.slice(
    rendererSource.indexOf("function revealLiveChatStreamText"),
    rendererSource.indexOf("function completedActivityHtml")
  );
  assert.match(liveReveal, /entry\.visibleText = entry\.visibleChars\.join\(""\)/);
  assert.doesNotMatch(liveReveal, /assistantTypingCharsPerSecond|typingPauseFor/);
});
