"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { HmsMessageStreamDemux } = require("../services/hms-progress");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const projectRuntimeSource = fs.readFileSync(path.join(root, "services", "hms-project-runtime.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");

test("continuation answer segments are unique while progress and answer remain bound", () => {
  const decode = (prefix, text) => {
    const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false, segmentPrefix: prefix });
    return demux.consume(text);
  };
  const first = decode("turn-1:p1:", '<baiqiu-progress>{"segmentId":"1","stage":"read","status":"running","message":"已读取请求"}</baiqiu-progress><baiqiu-answer segmentId="1">第一段</baiqiu-answer>');
  const second = decode("turn-1:p2:", '<baiqiu-progress>{"segmentId":"1","stage":"verify","status":"running","message":"已核对结果"}</baiqiu-progress><baiqiu-answer segmentId="1">第二段</baiqiu-answer>');

  const firstSegment = first.answerDeltas[0].segmentId;
  const secondSegment = second.answerDeltas[0].segmentId;
  assert.notEqual(firstSegment, secondSegment);
  assert.equal(first.progressEvents[0].segmentId, firstSegment);
  assert.equal(second.progressEvents[0].segmentId, secondSegment);
});

test("main stream envelope declares the authoritative event identity and output roles", () => {
  assert.match(mainSource, /snapshotSequence:\s*\+\+rendererSnapshotSequence/);
  assert.match(mainSource, /turnId,\s*eventId,\s*sequence:\s*seq/);
  assert.match(mainSource, /target,\s*outputType,\s*eventType/);
  assert.match(mainSource, /target === "structured_result"/);
  assert.match(mainSource, /target === "answer" \? "result"/);
  assert.match(mainSource, /segmentPrefix/);
});

test("renderer rejects stale snapshots, deduplicates events, and merges authoritative messages", () => {
  assert.match(rendererSource, /incomingSequence > 0 && incomingSequence < Number\(state\.lastSessionChangedSequence/);
  assert.match(rendererSource, /seenEventIds\.has\(eventId\)/);
  assert.match(rendererSource, /function mergeAuthoritativeMessageHistory\(/);
  assert.match(rendererSource, /messages are authoritative for the active turn/);
  assert.match(rendererSource, /rememberAuthoritativeMessage\(session\.id, message\)/);
  assert.match(rendererSource, /historyCount\(history\) === 0 && historyCount\(cachedHistory\) > 0/);
  assert.match(rendererSource, /if \(history == null\) \{[\s\S]*?authoritativeMessagesBySession/);
});

test("result and structured_result use distinct font roles", () => {
  assert.match(stylesSource, /--font-result:/);
  assert.match(stylesSource, /--font-structured-result:/);
  assert.match(stylesSource, /\.stream-segment-answer[\s\S]*font-family: var\(--font-result\)/);
  assert.match(stylesSource, /\.stream-segment-reasoning[\s\S]*font-family: var\(--font-structured-result\)/);
  assert.match(stylesSource, /\.execution-activity-line-reasoning[\s\S]*font-family: var\(--font-structured-result\)/);
});

test("public protocol is shared by provider upload/chat and Black Ball execution prompts", () => {
  const occurrences = (source, value) => source.split(value).length - 1;
  assert.ok(occurrences(mainSource, "structured_result") >= 3);
  assert.match(mainSource, /baiqiu-progress carries structured_result/);
  assert.match(mainSource, /The public protocol has two distinct output kinds/);
  assert.match(projectRuntimeSource, /BLACK_BALL_PUBLIC_EVENT_PROTOCOL/);
  assert.match(projectRuntimeSource, /baiqiu-progress/);
});

test("progress targets remain separate from the execution theater", () => {
  assert.match(mainSource, /function publicProgressTarget\(/);
  assert.match(mainSource, /target === "execution_activity"/);
  assert.match(rendererSource, /function progressTarget\(/);
  assert.match(rendererSource, /function ensureLiveStructuredResultPanel\(/);
  assert.match(rendererSource, /function appendLiveStructuredResult\(/);
  assert.match(rendererSource, /streaming-structured-result/);
  assert.match(rendererSource, /if \(target === "structured_result"\)/);
});

test("HMS project prompts forward live Black Ball progress and answer segments", () => {
  assert.match(mainSource, /const progressMapper = new HmsProgressMapper\(\{ segmentPrefix \}\)/);
  assert.match(mainSource, /const visibleStream = new HmsMessageStreamDemux\(\{[\s\S]*?requireFinalEnvelope: false/);
  assert.match(mainSource, /emitHmsProgress\(mappedProgress\)/);
  assert.match(mainSource, /emitAnswerParts\(visibleStream\.consume\(hmsProgressContentText\(update\)\)\)/);
  assert.match(mainSource, /const publishAnswer = phase === "summary"/);
  assert.match(mainSource, /if \(!String\(streamedSummaryAnswer \|\| ""\)\.trim\(\)\)/);
  assert.match(mainSource, /target: "answer",[\s\S]*?outputType: "result",[\s\S]*?eventType: "result_delta"/);
});

test("complete final results cannot be replaced by shorter streamed text", () => {
  assert.match(mainSource, /The final envelope is the Black Ball authority/);
  assert.doesNotMatch(mainSource, /text: streamedPublicText,\s*stopReason: "segmented_public_answer"/);
  assert.match(rendererSource, /finalExtendsStream/);
});
