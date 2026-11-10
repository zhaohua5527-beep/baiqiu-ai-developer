"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  canonicalTarget: canonicalPublicEventTarget,
  normalizeSemanticType,
  semanticTypeFromEvent,
  targetForSemanticType
} = require("../services/black-ball-public-event-contract");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to).trim();
}

function createPublicProgressHarness() {
  const isPublic = sourceBetween(
    mainSource,
    "function isBlackBallPublicProgress",
    "function publicProgressTarget"
  );
  const target = sourceBetween(
    mainSource,
    "function publicProgressTarget",
    "function publicChatProgress"
  );
  const normalize = sourceBetween(
    mainSource,
    "function publicChatProgress",
    "function emitBlackBallRunStarted"
  );
  return vm.runInNewContext(`
    (() => {
      const chatStreamProgressSequences = new Map();
      const chatStreamFrameSequences = new Map();
      const chatStreamStarted = new Map();
      const activeRuns = new Map();
      const sent = [];
      const traces = [];
      const mainWindow = { isDestroyed: () => false, webContents: { send: (_name, frame) => sent.push(frame) } };
      const writeCrossReplyTrace = (phase, meta) => traces.push({ phase, ...meta });
      const safeActivitySnippet = (value, maxLength) => String(value || "").slice(0, maxLength);
      const safeReasoningDelta = (value) => String(value || "");
      ${isPublic}
      ${target}
      ${normalize}
      ${sourceBetween(mainSource, "function emitChatStream(", "function safeReasoningDelta(")}
      return { publicChatProgress, emitChatStream, sent, traces };
    })()
  `, { canonicalPublicEventTarget, normalizeSemanticType, semanticTypeFromEvent, targetForSemanticType });
}

test("public progress retains producer sequences independently for each target", () => {
  const { publicChatProgress } = createPublicProgressHarness();
  const streamId = "turn-sequence-regression";
  const lifecycle = publicChatProgress(streamId, {
    type: "start",
    progress: {
      source: "hms",
      actor: "blackball",
      provenance: "blackball_runtime",
      kind: "lifecycle",
      message: "request accepted",
      target: "execution_activity"
    }
  });
  const structured = publicChatProgress(streamId, {
    type: "phase",
    progress: {
      source: "hms",
      actor: "model",
      provenance: "blackball_public",
      kind: "public_reasoning",
      sequence: 1,
      eventId: `${streamId}:live:1`,
      segmentId: "1",
      message: "checked the requested scope",
      target: "structured_result"
    }
  });

  assert.equal(lifecycle.sequence, 1);
  assert.equal(structured.sequence, 1);
  assert.equal(structured.turnId, streamId);
  assert.equal(structured.eventId, `${streamId}:live:1`);
  assert.equal(structured.target, "structured_result");
  assert.equal(structured.outputType, "structured_result");
  assert.equal(structured.kind, "public_reasoning");
});

test("stage results retain complete long Markdown across parsing, framing and persistence", () => {
  const { HmsMessageStreamDemux } = require("../services/hms-progress");
  const replay = require("../renderer-v2/persisted-replay");
  const message = "## 阶段成果\n\n| 对象 | 金额 |\n| --- | --- |\n| A | 120 |\n\n"
    + "完整正文🙂与换行。\n".repeat(2500) + "\n最后一行必须保留。";
  const wire = `<baiqiu-progress>${JSON.stringify({ type: "stage_result", goalId: "invoice", segmentId: "one", message })}</baiqiu-progress>`;
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const events = [];
  for (let offset = 0; offset < wire.length; offset += 137) events.push(...demux.consume(wire.slice(offset, offset + 137)).progressEvents);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, message);
  const { emitChatStream, traces, sent } = createPublicProgressHarness();
  const normalized = emitChatStream("session", "turn-long", { type: "phase", progress: events[0] }).progress;
  assert.equal(normalized.message, message);
  assert.equal(normalized.goalId, "invoice");
  assert.equal(sent[0].progress.message, message);
  assert.equal(traces[0].phase, "stage:sent");
  assert.equal(traces[0].eventId, normalized.eventId);
  assert.equal(traces[0].contentChars, message.length);
  const restored = replay.structuredEventsFromMessage(JSON.parse(JSON.stringify({ role: "assistant", raw: { structuredEvents: [], productResult: { raw: { structuredEvents: [normalized] } } } })));
  assert.equal(restored[0].message, message);
});

test("each stream retains Black Ball's public event sequence", () => {
  const { publicChatProgress } = createPublicProgressHarness();
  const progress = (eventId, sequence) => ({
    type: "phase",
    progress: {
      source: "hms",
      actor: "model",
      provenance: "blackball_public",
      kind: "public_reasoning",
      sequence,
      eventId,
      message: eventId,
      target: "structured_result"
    }
  });

  assert.equal(publicChatProgress("turn-a", progress("turn-a:live:9", 9)).sequence, 9);
  assert.equal(publicChatProgress("turn-a", progress("turn-a:live:10", 10)).sequence, 10);
  assert.equal(publicChatProgress("turn-b", progress("turn-b:live:1", 1)).sequence, 1);
});

test("legacy events receive fallback sequences per target without renumbering producer events", () => {
  const { publicChatProgress } = createPublicProgressHarness();
  const frame = (target, eventId = "") => ({
    type: "phase",
    progress: {
      source: "hms",
      actor: "model",
      provenance: "blackball_public",
      kind: target === "execution_activity" ? "execution" : "public_progress",
      target,
      eventId,
      message: target
    }
  });

  assert.equal(publicChatProgress("turn-a", frame("execution_activity")).sequence, 1);
  assert.equal(publicChatProgress("turn-a", frame("execution_activity")).sequence, 2);
  assert.equal(publicChatProgress("turn-a", frame("structured_result")).sequence, 1);
  assert.equal(publicChatProgress("turn-a", {
    ...frame("structured_result", "turn-a:structured:8"),
    progress: { ...frame("structured_result").progress, sequence: 8, eventId: "turn-a:structured:8" }
  }).sequence, 8);
  assert.equal(publicChatProgress("turn-a", frame("structured_result")).sequence, 9);
});

test("public progress preserves sanitized evidence relationships and tool result metadata", () => {
  const { publicChatProgress } = createPublicProgressHarness();
  const event = publicChatProgress("turn-evidence", {
    type: "phase",
    progress: {
      source: "tool",
      actor: "model",
      provenance: "blackball_tool",
      kind: "tool",
      type: "tool_result",
      status: "failed",
      eventId: "turn-evidence:tool:1",
      sequence: 1,
      toolCallId: "tool-1",
      resultKind: "tool_result",
      errorPreview: "ENOENT: missing file",
      evidenceEventIds: ["turn-evidence:tool:0"],
      evidenceToolCallIds: ["tool-0"],
      target: "execution_activity",
      message: "读取失败：文件不存在"
    }
  });
  assert.equal(event.status, "failed");
  assert.equal(event.resultKind, "tool_result");
  assert.equal(event.errorPreview, "ENOENT: missing file");
  assert.deepEqual([...event.evidenceEventIds], ["turn-evidence:tool:0"]);
  assert.deepEqual([...event.evidenceToolCallIds], ["tool-0"]);
});
