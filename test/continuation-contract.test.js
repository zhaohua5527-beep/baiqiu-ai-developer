"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { hasCommittedRuntimeDelivery, enforceRuntimeOutcome } = require("../services/runtime-outcome");
const { evaluateHmsResponse } = require("../services/hms-outcome-contract");
const { conversationResultStatus } = require("../services/response-router");
const { providerDiagnostic } = require("../services/hms-stream-failure");
const { createRequestRun } = require("../services/request-run-contract");
const replay = require("../renderer-v2/persisted-replay");

function deliveredStage() {
  const body = "已经完成的阶段结果。";
  return { runId: "turn", text: "", status: "done", structuredEvents: [
    { turnId: "turn", eventId: "stage:one", sequence: 1, target: "structured", type: "stage_result",
      nativeSegmentId: "one", segmentId: "turn:p1:one", message: body }
  ], runtimeOutcome: { source: "black_ball_runtime", turnId: "turn", eventId: "terminal:turn", sequence: 2,
    status: "completed", pendingToolIds: [], pendingSupplementIds: [], completion: { version: 1, status: "completed",
      outputs: [{ target: "structured", segmentId: "one", sha256: createHash("sha256").update(body).digest("hex") }] } } };
}

test("stage-only completion requires explicit references and actual delivered content", () => {
  const result = deliveredStage();
  assert.equal(hasCommittedRuntimeDelivery(result), true);
  assert.equal(evaluateHmsResponse(result, { canonicalTask: true }).success, true);
  assert.equal(evaluateHmsResponse(result, { canonicalTask: false }).success, true);
  assert.equal(result.text, "");
  assert.equal(hasCommittedRuntimeDelivery({ ...result, structuredEvents: [] }), false);
  assert.equal(hasCommittedRuntimeDelivery({ ...result, runId: "replacement" }), false);
  result.structuredEvents[0].message = "另一个结果";
  assert.equal(hasCommittedRuntimeDelivery(result), false);
});

test("loop completion alone cannot authorize a blank answer", () => {
  const result = deliveredStage();
  delete result.runtimeOutcome.completion;
  assert.equal(hasCommittedRuntimeDelivery(result), false);
  assert.equal(evaluateHmsResponse(result, { canonicalTask: true }).success, false);
});

test("completed legacy runtime with a final answer survives missing completion outputs", () => {
  const result = {
    runId: "turn-legacy",
    status: "done",
    protocolError: true,
    text: "完整答案已返回。",
    answerSegments: [{ text: "完整答案已返回。" }],
    runtimeOutcome: {
      source: "black_ball_runtime",
      turnId: "turn-legacy",
      eventId: "runtime:legacy",
      sequence: 2,
      status: "completed",
      stopReason: "end_turn",
      pendingToolIds: []
    }
  };
  assert.equal(hasCommittedRuntimeDelivery(result), true);
  const recovered = require("../services/hms-stream-failure").failIncompleteProtocol(result, result.text);
  assert.equal(recovered.status, "done");
  assert.equal(recovered.success, true);
  assert.equal(recovered.protocolError, false);
  assert.equal(recovered.text, result.text);
});

test("pending tools and unanswered supplements block complete delivery", () => {
  const result = deliveredStage();
  result.runtimeOutcome.pendingToolIds = ["tool"];
  assert.equal(hasCommittedRuntimeDelivery(result), false);
  result.runtimeOutcome.pendingToolIds = [];
  result.runtimeOutcome.pendingSupplementIds = ["supplement"];
  assert.equal(hasCommittedRuntimeDelivery(result), false);
  result.runtimeOutcome.pendingSupplementIds = [];
  result.runtimeOutcome.supplements = { supplement: { status: "applied" } };
  assert.equal(hasCommittedRuntimeDelivery(result), false);
});

test("ordinary answers can prove delivery without a stage card", () => {
  const result = deliveredStage();
  const answer = "知道，我会按补充要求继续。";
  result.text = answer;
  result.structuredEvents = [];
  result.runtimeOutcome.completion.outputs = [{ target: "answer", segmentId: "answer:one", contentChars: answer.length,
    sha256: createHash("sha256").update(answer).digest("hex") }];
  assert.equal(hasCommittedRuntimeDelivery(result), true);
  result.text = answer.slice(0, -1);
  assert.equal(hasCommittedRuntimeDelivery(result), false);
});

test("addressed supplements do not substitute for a whole-task completion declaration", () => {
  const result = deliveredStage();
  result.runtimeOutcome.supplements = { supplement: { status: "addressed" } };
  assert.equal(hasCommittedRuntimeDelivery(result), false);
  Object.assign(result.runtimeOutcome.completion, { scope: "active_task", addressedSupplementIds: ["supplement"] });
  assert.equal(hasCommittedRuntimeDelivery(result), true);
  result.runtimeOutcome.supplements.second = { status: "addressed" };
  assert.equal(hasCommittedRuntimeDelivery(result), false);
});

test("clarification stays awaiting input and cannot overwrite a protocol failure", () => {
  const result = deliveredStage();
  result.runtimeOutcome.status = "awaiting_input";
  result.runtimeOutcome.completion.status = "awaiting_input";
  result.runtimeOutcome.pendingSupplementIds = ["supplement"];
  result.runtimeOutcome.supplements = { supplement: { status: "needs_clarification" } };
  assert.equal(conversationResultStatus(result), "awaiting_input");
  assert.equal(enforceRuntimeOutcome(result).status, "awaiting_input");
  assert.equal(createRequestRun({ runId: "turn", result: enforceRuntimeOutcome(result) }).executionOutcome, "none");
  assert.equal(evaluateHmsResponse(result, { canonicalTask: true }).status, "awaiting_input");
  assert.equal(enforceRuntimeOutcome({ ...result, status: "failed", protocolError: true }).status, "failed");
});

test("semantic receipts retain the corresponding response reference", () => {
  const value = { type: "supplement", stage: "addressed", supplementId: "supplement", turnId: "turn",
    eventId: "supplement:12345678-1234-1234-1234-123456789012", sequence: 3, timestamp: 1, responseSegmentId: "answer:one" };
  const diagnostic = providerDiagnostic({ sessionUpdate: "agent_message_chunk", content: { text: "" }, _meta: { baiqiu_diagnostic: value } });
  assert.equal(diagnostic.stage, "addressed");
  assert.equal(diagnostic.responseSegmentId, "answer:one");
});

function conversation() {
  const oldAnswer = { turnId: "turn", eventId: "old", sequence: 1, turnSequence: 1, segmentId: "old", target: "answer", type: "answer_segment", text: "原回复。" };
  const newAnswer = { ...oldAnswer, eventId: "new", sequence: 2, turnSequence: 3, segmentId: "new", text: "知道，按照补充继续。", replyToUserMessageId: "supplement" };
  const stage = { turnId: "turn", eventId: "stage", sequence: 1, turnSequence: 4, segmentId: "stage", target: "structured", type: "stage_result",
    message: "保留 **原始 Markdown**。", replyToUserMessageId: "supplement" };
  return [{ id: "original", role: "user", text: "原指令" },
    { id: "product-result:original", role: "assistant", text: oldAnswer.text + newAnswer.text,
      raw: { productResult: { clientMessageId: "original", runId: "turn", answerSegments: [oldAnswer, newAnswer], structuredEvents: [stage] } } },
    { id: "supplement", role: "user", text: "你知道吗" }];
}

test("history puts subsequent output after the supplement without mutating old content", () => {
  const source = conversation();
  const before = JSON.stringify(source);
  const messages = replay.expandSupplementReplies(source);
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(messages[1].text, "原回复。");
  assert.equal(messages[3].text, "知道，按照补充继续。");
  assert.equal(replay.structuredEventsFromMessage(messages[1]).length, 0);
  assert.equal(replay.structuredEventsFromMessage(messages[3])[0].message, "保留 **原始 Markdown**。");
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(replay.expandSupplementReplies(messages), messages);
});

test("only duplicate event IDs are removed, not repeated content", () => {
  const source = conversation();
  const result = source[1].raw.productResult;
  result.answerSegments.push({ ...result.answerSegments[1] });
  assert.equal(replay.expandSupplementReplies(source)[3].text, "知道，按照补充继续。");
  result.answerSegments.push({ ...result.answerSegments[1], eventId: "additional", sequence: 3, turnSequence: 5 });
  source[1].text += result.answerSegments[1].text;
  assert.equal(replay.expandSupplementReplies(source)[3].text, "知道，按照补充继续。知道，按照补充继续。");
});

test("mismatched historical answer text is retained rather than silently removed", () => {
  const source = conversation();
  source[1].text = "落库正文与分段不一致时必须完整保留。";
  const messages = replay.expandSupplementReplies(source);
  assert.equal(messages.find(message => message.id === source[1].id).text, source[1].text);
  assert.deepEqual(replay.answerSegmentsFromMessage(messages[1]), replay.answerSegmentsFromMessage(source[1]));
});
