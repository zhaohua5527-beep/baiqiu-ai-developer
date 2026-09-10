"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildExecutionLog,
  HmsMessageStreamDemux,
  HmsProgressMapper,
  toolEvidenceEventId
} = require("../services/hms-progress");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");

test("judgment metadata retains the real tool call it cites", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume('<baiqiu-progress>{"segmentId":"1","stage":"analyze","message":"读取结果显示配置缺少事件关系字段，下一步补充归一化。","evidenceToolCallIds":["tool-read-1"]}</baiqiu-progress>');
  assert.deepEqual(parsed.progressEvents[0].evidenceToolCallIds, ["tool-read-1"]);
  assert.equal(parsed.progressEvents[0].kind, "public_progress");
});

test("failed tools remain failed real results and never become completion", () => {
  const mapper = new HmsProgressMapper();
  const started = mapper.consume({
    sessionUpdate: "tool_call",
    toolCallId: "tool-read-1",
    title: "read_file",
    rawInput: { path: "missing.txt" }
  })[0];
  const failed = mapper.consume({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-read-1",
    title: "read_file",
    status: "failed",
    error: "ENOENT: file not found"
  })[0];
  assert.equal(started.resultKind, "tool_started");
  assert.equal(failed.type, "tool_result");
  assert.equal(failed.resultKind, "tool_result");
  assert.equal(failed.status, "failed");
  assert.match(failed.errorPreview, /ENOENT/);
  assert.doesNotMatch(failed.message, /已完成/);
});

test("test and build tool outcomes are explicit verification results", () => {
  const mapper = new HmsProgressMapper();
  const result = mapper.consume({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-test-1",
    title: "terminal",
    rawInput: { command: "node --test test/example.test.js" },
    rawOutput: { success: true, passed: 3, failed: 0 },
    status: "completed"
  })[0];
  assert.equal(result.type, "verification_result");
  assert.equal(result.resultKind, "verification_result");
  assert.equal(result.status, "completed");
  assert.match(result.resultPreview, /passed/);
});

test("terminal tool evidence keeps one stable id across live and persisted events", () => {
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-read-1",
    title: "read_file",
    rawOutput: { success: true, text: "metadata only" },
    status: "completed"
  };
  const live = new HmsProgressMapper().consume(update)[0];
  const expected = "turn-1:tool:tool-read-1:tool_result";
  assert.equal(toolEvidenceEventId("turn-1", live), expected);
  const persisted = buildExecutionLog([{ ...update, receivedAt: 10 }], {
    runId: "runtime-1",
    eventIdRoot: "turn-1"
  });
  assert.equal(persisted[0].eventId, expected);
});

test("shared protocol allows direct answers without classifying away tool capability", () => {
  const protocol = require("../services/public-response-protocol").publicResponseStreamPrompt();
  assert.match(protocol, /无需工具和阶段输出时直接回答/);
  assert.match(protocol, /工具能力和当前推理等级保持不变/);
  assert.match(mainSource, /!options\.internalStructuredResponse \? publicResponseStreamPrompt\(\)/);
});

test("evidence links survive transport, persistence, rendering, and legacy fallback", () => {
  assert.match(mainSource, /executionEvidenceByToolCallId/);
  assert.match(mainSource, /afterEventId: latestExecutionEvidence\.eventId/);
  assert.match(mainSource, /evidenceEventIds: safeEventReferenceList/);
  assert.match(rendererSource, /node\.dataset\.afterEventId/);
  assert.match(rendererSource, /node\.dataset\.evidenceEventIds/);
  assert.match(rendererSource, /String\(event\.afterEventId \|\| ""\)/);
  assert.match(rendererSource, /String\(event\.eventId \|\| `\$\{turnId\}:structured:/);
});

test("the live top narrative is grounded and raw execution stays in expandable details", () => {
  const streamStart = rendererSource.indexOf("function streamActivityHtml");
  const streamEnd = rendererSource.indexOf("function updateLiveStreamElapsed", streamStart);
  const stream = rendererSource.slice(streamStart, streamEnd);
  assert.match(rendererSource, /const EXECUTION_ACTIVITY_THEATER_ENABLED = false;/);
  assert.match(stream, /execution-activity-narrative streaming-structured-result/);
  assert.match(stream, /executionActivityToggleHtml\(visibleDetails\.length, false\)/);
  assert.doesNotMatch(stream, /execution-activity-inline-theater/);
  assert.match(rendererSource, /node\.dataset\.source = "black-ball-structured"/);
  assert.match(rendererSource, /node\.textContent = node\.__structuredTargetText/);
  assert.match(rendererSource, /node\.dataset\.afterEventId/);
  assert.match(rendererSource, /node\.dataset\.evidenceEventIds/);
  assert.match(rendererSource, /collapseCompletedExecutionActivity\(entry\.activity, completedDurationMs, \[[\s\S]*?entry\.activityDetails[\s\S]*?entry\.structuredEvents/);
  assert.match(rendererSource, /if \(root\.dataset\.activityExpanded !== "1"\) \{[\s\S]*?updateExecutionActivityToggle\(root, next\.length\);[\s\S]*?return next;/);
});
