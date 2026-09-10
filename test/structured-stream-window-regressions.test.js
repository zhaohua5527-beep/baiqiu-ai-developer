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
const rendererStyles = fs.readFileSync(
  path.join(__dirname, "..", "renderer-v2", "styles.css"),
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
  assert.match(rendererSource, /node\.__structuredRetireWhenPainted/);
  assert.match(rendererSource, /scheduleLiveStructuredEntryFade\(entry, node\);/);
  assert.match(rendererSource, /entry\?\.structuredNodes\?\.values/);
});

test("real structured events render in their own lane instead of the execution timeline", () => {
  const append = sourceBetween(
    rendererSource,
    "function appendLiveStructuredResult",
    "function isPublicStructuredThought"
  );
  assert.match(append, /document\.createElement\("div"\)/);
  assert.match(append, /structured-result-entry/);
  assert.doesNotMatch(append, /pushExecutionActivityDetail/);
});

test("structured containers are visible unless explicitly hidden", () => {
  assert.match(rendererStyles, /\.stream-segment-structured\[hidden\] \{ display: none !important; \}/);
  assert.doesNotMatch(rendererStyles, /\.stream-segment-structured,\s*\.stream-segment-reasoning \{ display: none !important; \}/);
  assert.match(rendererStyles, /\.persisted-structured-result \{[\s\S]*?max-height: none;[\s\S]*?mask-image: none;/);
});

test("terminal transport frames do not tear down the answer owner before durable commit", () => {
  const terminal = sourceBetween(
    rendererSource,
    "if (terminalFrame)",
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

test("persisted turns keep cross-linked process events beside permanent answer segments", () => {
  const persisted = sourceBetween(
    rendererSource,
    "function renderPersistedSegmentPairs",
    "function snapshotMessageIdentity"
  );
  assert.match(persisted, /publicExecutionDetailsFromMessage\(message\)/);
  assert.match(persisted, /const replay = persistedReplay\.replaySegmentModel\(message, processDetails\);/);
  assert.match(persisted, /stream-segment-process/);
  assert.match(persisted, /stream-segment-structured streaming-structured-result/);
  assert.match(persisted, /structuredBySegment/);
  assert.match(persisted, /const structuredEvents = replay\.structuredEvents;/);
  assert.match(persisted, /replaceExecutionActivityLines/);
  assert.match(persisted, /answerBySegment/);
  const timeline = sourceBetween(
    rendererSource,
    "function publicExecutionDetailsFromMessage",
    "function renderPersistedExecutionTimeline"
  );
  assert.match(timeline, /structuredEventsFromMessage\(message\)/);
  assert.match(rendererSource, /root\.dataset\.lifecycle = "completed"/);
  assert.match(rendererSource, /structured\.className = "stream-segment-structured streaming-structured-result"/);
  assert.match(rendererSource, /const block = ensureLiveSegmentBlock\(entry, key\)/);
  assert.match(rendererSource, /root\.dataset\.segmentedDetailsOwner/);
});

test("structured summaries paint synchronously while final answers keep adaptive typing", () => {
  const append = sourceBetween(rendererSource, "function appendLiveStructuredResult", "function isPublicStructuredThought");
  assert.match(append, /node\.textContent = node\.__structuredTargetText/);
  assert.match(append, /node\.__structuredVisibleLength = Array\.from\(node\.__structuredTargetText\)\.length/);
  assert.doesNotMatch(append, /scheduleLiveStructuredEntryPaint\(entry, node\)/);
  assert.match(rendererSource, /revealLiveChatStreamText[\s\S]*?assistantTypingCharsPerSecond\(entry\.targetChars\.length\)/);
});

test("live structured summaries surface in the activity header before the answer", () => {
  const append = sourceBetween(rendererSource, "function appendLiveStructuredResult", "function isPublicStructuredThought");
  assert.match(append, /execution-activity-narrative\.streaming-structured-result/);
  assert.match(append, /liveSummary\.textContent = text/);
  assert.match(append, /liveSummary\.hidden = false/);
  assert.match(rendererStyles, /\.execution-activity-narratives\s*\{[\s\S]*?display: flex;[\s\S]*?align-items: center;/);
});

test("final answer commit keeps segmented content and retires only temporary process surfaces", () => {
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
  assert.match(collapse, /stopExecutionActivityFlow\(root\)/);
  assert.match(collapse, /root\.dataset\.lifecycle = "completed"/);
  assert.doesNotMatch(collapse, /execution-completion-count/);
  assert.match(collapse, /streaming-elapsed/);
  assert.doesNotMatch(collapse, /execution-activity-duration-only/);
  assert.match(rendererSource, /recycleLiveStructuredProcess\(entry, "", \{ transientOnly: true, respectMinimum: false \}\)/);
  assert.match(rendererSource, /durableStructuredEvents\.length[\s\S]*?renderPersistedSegmentPairs\(message, rendered\)/);
  assert.doesNotMatch(rendererSource, /transientOnly: false/);
  assert.match(rendererSource, /hideLiveThinkingLayer\(entry, \{ allStructured: true, respectMinimum: false \}\)/);
});

test("the local theater stays separate from authoritative Black Ball structured output", () => {
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_THEATER_ENABLED = true;/);
  const stream = sourceBetween(rendererSource, "function streamActivityHtml", "function updateLiveStreamElapsed");
  const structured = sourceBetween(rendererSource, "function ensureLiveStructuredResultPanel", "function placeLiveStructuredResultPanel");
  assert.match(stream, /execution-activity-narrative streaming-structured-result/);
  assert.match(stream, /mini-theatre-region execution-activity-inline-theater/);
  assert.match(stream, /execution-process-region/);
  assert.ok(stream.indexOf("mini-theatre-region") < stream.indexOf("execution-process-region"));
  assert.match(structured, /const block = ensureLiveSegmentBlock\(entry, key\)/);
  assert.doesNotMatch(structured, /entry\.activity\?\.querySelector\?\.\("\.execution-activity-narrative"\)/);
  assert.match(rendererSource, /node\.dataset\.source = "black-ball-structured"/);
  assert.doesNotMatch(rendererSource, /if \(EXECUTION_ACTIVITY_THEATER_ENABLED\).*scheduleExecutionActivityWhimsy/);
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
