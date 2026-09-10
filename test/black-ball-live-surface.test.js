"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

test("live activity uses one factual row above the real result", () => {
  const activity = sourceBetween("function streamActivityHtml", "function updateLiveStreamElapsed");
  const narrative = sourceBetween("function paintLiveExecutionNarrative", "function scheduleExecutionNarrativeReveal");
  const head = activity.match(/<div class="execution-activity-head">([\s\S]*?)<\/div>\s*<div class="execution-activity-shell">/)?.[1] || "";

  assert.match(head, /streaming-elapsed/);
  assert.match(head, /streaming-activity-label/);
  assert.doesNotMatch(head, /execution-activity-step-label/);
  assert.doesNotMatch(head, /execution-stage-summary|execution-activity-narrative|execution-event-narrative/);
  assert.match(activity, /execution-activity-narrative streaming-structured-result/);
  assert.match(activity, /execution-event-narrative/);
  assert.doesNotMatch(activity, /data-theater="1"/);
  assert.match(activity, /mini-theatre-region execution-activity-inline-theater/);
  assert.match(activity, /execution-process-region/);
  assert.ok(activity.indexOf("mini-theatre-region") < activity.indexOf("execution-process-region"));
  assert.match(narrative, /item\.publicSummary/);
  assert.doesNotMatch(narrative, /Math\.random|nextExecutionActivityWhimsy|renderExecutionActivityWhimsyScene/);
});

test("live execution lines type real events without event clocks or clipping", () => {
  const lines = sourceBetween("function executionActivityLineHtml", "function replaceExecutionActivityLines");
  const push = sourceBetween("function pushExecutionActivityDetail", "function executionActivityFlowIsPending");

  assert.doesNotMatch(lines, /execution-activity-line-marker|executionActivityTimeText|document\.createElement\("time"\)/);
  assert.match(lines, /line\.append\(text\)/);
  assert.match(push, /root\.dataset\.lifecycle === "completed" && root\.dataset\.activityExpanded !== "1"/);
  assert.match(push, /flow\.queue = \[\.\.\.flow\.queue, detail\]/);
});

test("live task step keeps only the latest real execution summary", () => {
  const narrative = sourceBetween("function paintLiveExecutionNarrative", "function scheduleExecutionNarrativeReveal");

  assert.match(narrative, /summaries\.slice\(-1\)/);
  assert.doesNotMatch(narrative, /summaries\.slice\(-EXECUTION_ACTIVITY_VISIBLE_LIMIT\)/);
});

test("English internal narration is buffered across stream chunks", () => {
  const helpers = sourceBetween("function normalizeEscapedBaiqiuProtocolClosers", "function isNativeBlackBallMessage");
  const { filterLiveAssistantDelta } = new Function(`${helpers}; return { filterLiveAssistantDelta };`)();
  const entry = { suppressingInternalNarration: false, internalNarrationBuffer: "" };

  assert.equal(filterLiveAssistantDelta(entry, 'The user said "\u4f60\u597d", which is a simple greeting.'), "");
  assert.equal(filterLiveAssistantDelta(entry, "\nAccording to my instructions, I should answer briefly."), "");
  assert.equal(
    filterLiveAssistantDelta(entry, "\n\u6709\u4ec0\u4e48\u9700\u8981\u5e2e\u5fd9\u7684\uff0c\u76f4\u63a5\u8bf4\u3002"),
    "\u6709\u4ec0\u4e48\u9700\u8981\u5e2e\u5fd9\u7684\uff0c\u76f4\u63a5\u8bf4\u3002"
  );
  assert.equal(entry.suppressingInternalNarration, false);
  assert.equal(entry.internalNarrationBuffer, "");

  const englishEntry = { suppressingInternalNarration: false, internalNarrationBuffer: "" };
  assert.equal(filterLiveAssistantDelta(englishEntry, "Hello, how can I help?"), "Hello, how can I help?");
});

test("runtime controls are independent from queue and presentation drain state", () => {
  const localRuntime = sourceBetween("function liveChatStreamRuntimePhase", "function sessionIsRunning");
  const running = sourceBetween("function sessionIsRunning", "async function selectSessionById");
  const sidebar = sourceBetween("function projectSessionStatus", "function projectSidebarStatus");

  assert.match(localRuntime, /LIVE_TURN_STATES\.CREATED, LIVE_TURN_STATES\.RUNNING/);
  assert.match(localRuntime, /LIVE_TURN_STATES\.TERMINAL_RECEIVED/);
  assert.match(localRuntime, /LIVE_TURN_STATES\.ANSWER_COMMITTED/);
  assert.match(running, /localRuntime\.phase === "running"/);
  assert.match(running, /localRuntime\.phase === "terminal"/);
  assert.doesNotMatch(running, /sessionTaskQueue\.isActive/);
  assert.doesNotMatch(running, /activeLiveChatStreamForSession\(session\.id\).*return true/);
  assert.match(sidebar, /localRuntime\.phase === "running"/);
  assert.doesNotMatch(sidebar, /sessionTaskQueue\.isActive/);
});

test("terminal replies retain the full expandable execution timeline", () => {
  const collapse = sourceBetween("function collapseCompletedExecutionActivity", "function streamActivityHtml");

  assert.match(collapse, /stopExecutionActivityFlow\(root\)/);
  assert.match(collapse, /root\.dataset\.lifecycle = "completed"/);
  assert.doesNotMatch(collapse, /execution-completion-count/);
  assert.match(collapse, /streaming-elapsed/);
  assert.match(collapse, /streaming-activity-label.*小剧场/);
  assert.doesNotMatch(collapse, /execution-activity-step-label.*步骤/);
  assert.match(collapse, /executionActivityRenderedDetails\(root, history\)/);
  assert.doesNotMatch(collapse, /execution-activity-duration-only/);
  assert.match(collapse, /return root/);
  assert.match(source, /if \(root\?\.dataset\?\.lifecycle === "completed"[\s\S]*?return \[\]/);
  assert.match(source, /if \(viewport\) viewport\.hidden = visible\.length === 0;/);
});
