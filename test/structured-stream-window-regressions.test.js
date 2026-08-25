"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererSource = fs.readFileSync(
  path.join(__dirname, "..", "renderer-v2", "app.js"),
  "utf8"
);
const mainSource = fs.readFileSync(
  path.join(__dirname, "..", "main.js"),
  "utf8"
);

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

test("structured public process keeps a three-entry rolling window with transient thoughts", () => {
  assert.match(rendererSource, /const STRUCTURED_RESULT_VISIBLE_LIMIT = 3;/);
  assert.match(rendererSource, /function trimLiveStructuredResultWindow\(entry\)/);
  assert.match(rendererSource, /nodes\.slice\(0, overflow\)\.forEach/);
  assert.match(rendererSource, /function scheduleLiveStructuredEntryFade\(entry, node\)/);
  assert.match(rendererSource, /STRUCTURED_THOUGHT_FADE_MS/);
  assert.match(rendererSource, /structured-result-entry-thinking/);
});

test("terminal transport frames do not tear down the answer owner before durable commit", () => {
  const terminal = sourceBetween(
    rendererSource,
    "if ([\"done\", \"error\", \"cancelled\"].includes(frame.type))",
    "if (frame.type !== \"delta\") return;"
  );
  assert.doesNotMatch(terminal, /hideLiveThinkingLayer\(entry\)/);
  assert.doesNotMatch(terminal, /finishLiveExecutionSurface\(entry\)/);

  const finalizeGuard = sourceBetween(
    rendererSource,
    "function finalizeVisibleStreamNow",
    "async function waitForVisibleOutputDrain"
  );
  assert.match(finalizeGuard, /entry\.finalizing && typeof entry\.finalizeWhenDrained === \"function\"/);

  const sendCurrentTask = sourceBetween(
    rendererSource,
    "async function sendCurrentTask",
    "async function processQueue"
  );
  const finallyBlock = sendCurrentTask.slice(sendCurrentTask.lastIndexOf("} finally {"));
  assert.match(finallyBlock, /if \(!preserveStreamedView\) \{\s*discardLiveChatStream\(streamId\);/);
  assert.doesNotMatch(finallyBlock, /if \(preserveStreamedView\) \{\s*finalizeVisibleStreamNow\(streamId\)/);
});

test("persisted turns restore real structured events beside permanent answer segments", () => {
  const persisted = sourceBetween(
    rendererSource,
    "function renderPersistedSegmentPairs",
    "function snapshotMessageIdentity"
  );
  assert.match(persisted, /structuredEventsFromMessage\(message\)/);
  assert.match(persisted, /visibleStructuredEvents = structuredEvents\.slice\(-STRUCTURED_RESULT_VISIBLE_LIMIT\)/);
  assert.match(persisted, /structured-result-entry/);
  assert.match(persisted, /answerBySegment/);
  assert.match(rendererSource, /insertBefore\(panel, answer\)/);
});

test("final answer commit keeps segmented content and completed execution timeline", () => {
  const finalOnly = sourceBetween(
    rendererSource,
    "if (rendered && !hasStreamedAnswer)",
    "} else if (rendered && finalExtendsStream)"
  );
  assert.match(finalOnly, /renderSegmentedLiveAnswer\(entry\)/);
  assert.doesNotMatch(finalOnly, /rendered\.replaceChildren\(\)/);
  assert.match(rendererSource, /authoredAnswerText = answerSegmentsFromMessage\(message\)/);
  const collapse = sourceBetween(
    rendererSource,
    "function collapseCompletedExecutionActivity",
    "function streamActivityHtml"
  );
  assert.doesNotMatch(collapse, /root\.remove\(\)/);
  assert.match(collapse, /execution-activity-completed/);
  assert.match(rendererSource, /recycleLiveStructuredProcess\(entry, "", \{ transientOnly: true \}\)/);
});

test("startup does not fabricate a structured event", () => {
  const started = sourceBetween(
    mainSource,
    "function emitBlackBallRunStarted",
    "function emitChatStream"
  );
  assert.doesNotMatch(started, /structured_start/);
  assert.match(started, /target: "execution_activity"/);
});
