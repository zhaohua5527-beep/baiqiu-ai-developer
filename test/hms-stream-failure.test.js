"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { HermesAcpClient } = require("../services/hermes-acp-client");
const { HmsMessageStreamDemux } = require("../services/hms-progress");
const { providerDiagnostic, timeoutFailure, preserveFailedOutput } = require("../services/hms-stream-failure");
const { userFacingError } = require("../services/user-facing-error-adapter");

function errorUpdate(code = "HERMES_PROVIDER_OVERLOADED") {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" },
    _meta: { baiqiu_diagnostic: { type: "provider_error", code, timestamp: 1000, errorType: "APIError", command: "secret", message: "private" } } };
}

test("provider errors preserve typed public reasons without leaking diagnostic payloads", () => {
  const diagnostic = providerDiagnostic(errorUpdate());
  assert.deepEqual(diagnostic, { type: "provider_error", code: "HERMES_PROVIDER_OVERLOADED", timestamp: 1000, errorType: "APIError" });
  assert.match(userFacingError(diagnostic), /过载/);
  assert.equal(providerDiagnostic(errorUpdate("invented")), null);
  assert.equal(providerDiagnostic({ ...errorUpdate(), content: { type: "text", text: "answer" } }), null);
});

test("30-second and two-minute timeout reasons remain distinct", () => {
  const first = timeoutFailure({ timeoutKind: "first_event", message: "untrusted" });
  assert.equal(first.code, "MODEL_FIRST_EVENT_TIMEOUT");
  assert.match(userFacingError(first), /30 秒/);
  assert.match(userFacingError(timeoutFailure({ timeoutKind: "no_progress" })), /2 分钟/);
  assert.equal(timeoutFailure({}).code, "MODEL_NO_PROGRESS_TIMEOUT");
});

test("HTTP diagnostic timings accept only safe fields and never become public updates", async () => {
  const update = errorUpdate();
  update._meta.baiqiu_diagnostic = { type: "provider_timing", stage: "http_headers", requestId: "12345678-1234-1234-1234-123456789012", timestamp: 2000, httpStatus: 200, secret: "private" };
  assert.deepEqual(providerDiagnostic(update), { type: "provider_timing", stage: "http_headers", requestId: "12345678-1234-1234-1234-123456789012", timestamp: 2000, httpStatus: 200 });
  const client = new HermesAcpClient();
  const updates = [{ update }, { kind: "stop", stopReason: "end_turn" }];
  client.ensureSession = async () => ({ hermesSessionId: "native", active: { prompt() {}, async nextUpdate() { return updates.shift(); } } });
  let publicUpdates = 0;
  const result = await client.prompt("local", "test", { onUpdate() { publicUpdates++; } });
  assert.equal(publicUpdates, 0);
  assert.equal(result.text, "");
  assert.equal(result.diagnostics.length, 1);
});

test("failed output retains exact answer segments and appends a separate failure notice", () => {
  const segments = [{ eventId: "answer-1", text: "已确认 **地点**。\n" }, { eventId: "answer-2", text: "```py\nprint(42)\n```" }];
  const result = { answerSegments: segments };
  const before = JSON.stringify(result);
  assert.equal(preserveFailedOutput(result, "供应商过载"), "已确认 **地点**。\n```py\nprint(42)\n```\n\n供应商过载");
  assert.equal(JSON.stringify(result), before);
  assert.equal(preserveFailedOutput({ text: "private raw protocol" }, "失败"), "失败");
});

test("overload stops retries but preserves received tools and answer for failure persistence", async () => {
  const client = new HermesAcpClient();
  const updates = [
    { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "terminal", rawInput: { command: "print(42)" } },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: { output: "42" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "部分答案" } },
    errorUpdate()
  ];
  let cancelled = 0;
  const diagnostics = [];
  client.ensureSession = async () => ({ hermesSessionId: "native-1", active: {
    prompt() {}, async nextUpdate() { return { update: updates.shift() }; }
  } });
  client.cancel = async () => { cancelled++; };
  await assert.rejects(client.prompt("local-1", "hello", { onDiagnostic: (event) => diagnostics.push(event) }), (error) => {
    assert.equal(error.code, "HERMES_PROVIDER_OVERLOADED");
    assert.equal(error.hermesResult.text, "部分答案");
    assert.equal(error.hermesResult.toolCalls[0].toolCallId, "tool-1");
    assert.equal(error.hermesResult.updates.length, 3);
    assert.equal(error.hermesResult.diagnostics.length, 1);
    return true;
  });
  assert.equal(cancelled, 1);
  assert.equal(client.hasActivePrompt("local-1"), false);
  assert.equal(diagnostics.length, 1);
});

test("canonical product adapter retains partial answers and event evidence on failure", async () => {
  const { UIAdapter } = require("../services/product-sdk/ui-adapter");
  const adapter = Object.create(UIAdapter.prototype);
  const answerSegments = [{ eventId: "answer-1", text: "已确认 **地点**。" }];
  const executionLog = [{ eventId: "tool-1", sourceText: "print(42)", resultPreview: "42" }];
  adapter.chatRunner = async () => ({
    ok: false, status: "failed", text: "已确认 **地点**。\n\n执行失败。",
    error: "模型供应商服务器当前过载，请稍后重试。", answerSegments, executionLog
  });
  const result = await adapter.submitCanonicalUIInput({ templateId: "desktop.chat_runtime", message: "test" });
  assert.equal(result.success, false);
  assert.equal(result.text, "已确认 **地点**。\n\n模型供应商服务器当前过载，请稍后重试。");
  assert.deepEqual(result.raw.answerSegments, answerSegments);
  assert.deepEqual(result.raw.executionLog, executionLog);
});

test("the observed misspelled close recovers only complete real stage JSON, across every split", () => {
  const source = '<baiqiu-progress>{"type":"stage_result","segmentId":"1","message":"真实结果正文"}</baiu-progress>后续答案';
  for (let split = 0; split <= source.length; split++) {
    const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
    const first = demux.consume(source.slice(0, split));
    const second = demux.consume(source.slice(split));
    const tail = demux.flush();
    const events = [...first.progressEvents, ...second.progressEvents];
    assert.equal(events.length, 1, `split ${split}`);
    assert.equal(events[0].message, "真实结果正文");
    const answer = [first, second, tail].map((part) => part.visibleDelta
      + (part.answerDeltas || []).map((event) => event.delta).join("")).join("");
    assert.equal(answer, "后续答案", `split ${split}`);
  }
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  assert.equal(demux.consume('<baiqiu-progress>{"message":"incomplete</baiu-progress>').progressEvents.length, 0);
});

test("prompt failure snapshots retain emitted identities without rebuilding or resetting output", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const start = source.indexOf("const partialOutput = (raw = {}) => (");
  const end = source.indexOf("let pendingPlainProtocolText", start);
  const snapshot = new Function("emittedExecutionEvents", "hmsStructuredEvents", "streamedAnswerSegments", "streamedAnswerTurnSequences", "streamedPublicText", "streamId",
    `${source.slice(start, end)}; return partialOutput;`)(
    [{ eventId: "tool-real", turnSequence: 2, sourceText: "print(42)", resultPreview: "42" }],
    [{ eventId: "stage-real", message: "真实阶段结果" }], new Map([["segment-1", "真实答案"]]), new Map([["segment-1", 4]]), "真实答案", "run-1"
  );
  const result = snapshot({ toolCalls: [{ toolCallId: "tool-1" }] });
  assert.equal(result.executionLog[0].eventId, "tool-real");
  assert.equal(result.executionLog[0].sourceText, "print(42)");
  assert.equal(result.structuredEvents[0].eventId, "stage-real");
  assert.equal(result.answerSegments[0].turnSequence, 4);
  assert.equal(result.answerSegments[0].text, "真实答案");
  const failure = source.slice(source.indexOf('if (result?.status === "failed" && looksLikeHermesFailure'), source.indexOf('if (!options.internalStructuredResponse && isInternalIntentControlReply'));
  assert.doesNotMatch(failure, /clearAnswer|streamedAnswerSegments\.clear/);
});
