"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const replay = require("../renderer-v2/persisted-replay.js");

test("structured-only messages produce a stable default replay segment", () => {
  const model = replay.replaySegmentModel({
    id: "structured-only",
    text: "final answer",
    structuredEvents: [{
      turnId: "turn-1",
      eventId: "structured-1",
      sequence: 1,
      target: "structured_result",
      message: "stage confirmed"
    }]
  });
  assert.equal(model.answerSegments.length, 1);
  assert.equal(model.answerSegments[0].segmentId, "__default");
  assert.equal(model.structuredBySegment.get("__default")[0].eventId, "structured-1");
});

test("empty delta falls back to the public message while non-empty delta wins", () => {
  assert.equal(replay.eventDisplayText({ delta: "", message: "stage confirmed" }), "stage confirmed");
  assert.equal(replay.eventDisplayText({ delta: "partial", message: "ignored" }), "partial");
});

test("nested raw.raw event fields are independently extracted", () => {
  const message = {
    raw: {
      raw: {
        executionLog: [{ eventId: "execution-raw-raw", target: "execution", message: "nested tool" }],
        structuredEvents: [{ eventId: "structured-raw-raw", target: "structured_result", message: "nested stage" }],
        answerSegments: [{ eventId: "answer-raw-raw", segmentId: "segment-1", text: "nested answer" }]
      }
    }
  };
  assert.equal(replay.executionLogFromMessage(message)[0].eventId, "execution-raw-raw");
  assert.equal(replay.structuredEventsFromMessage(message)[0].eventId, "structured-raw-raw");
  assert.equal(replay.answerSegmentsFromMessage(message)[0].eventId, "answer-raw-raw");
});

test("structured and answer events deduplicate conflicts and retain stable order", () => {
  const structured = replay.mergeStructuredEventLists(
    [
      { eventId: "e-2", turnId: "turn-1", sequence: 2, target: "structured_result", message: "second" },
      { eventId: "e-1", turnId: "turn-1", sequence: 1, target: "structured_result", message: "first" }
    ],
    [{ eventId: "e-1", turnId: "turn-1", sequence: 1, target: "structured_result", message: "first" }]
  );
  assert.deepEqual(structured.map((event) => event.eventId), ["e-1", "e-2"]);

  const answers = replay.mergeAnswerSegmentLists([
    { eventId: "a-2", segmentId: "s-2", sequence: 2, text: "second" },
    { eventId: "a-1", segmentId: "s-1", sequence: 1, text: "first" },
    { eventId: "a-1", segmentId: "s-1", sequence: 1, text: "first" }
  ]);
  assert.deepEqual(answers.map((segment) => segment.eventId), ["a-1", "a-2"]);
});

test("snapshot merge preserves committed answer and independent process records", () => {
  const current = {
    id: "message-1",
    role: "assistant",
    text: "final answer",
    raw: {
      raw: {
        executionLog: [{ eventId: "execution-1", target: "execution", message: "tool returned" }]
      },
      productResult: {
        answerSegments: [{ eventId: "answer-1", segmentId: "segment-1", sequence: 1, text: "final answer" }]
      }
    }
  };
  const merged = replay.mergeSessionSnapshotMessage(current, { id: "message-1", role: "assistant", text: "", raw: {} });
  assert.equal(merged.text, "final answer");
  assert.equal(merged.raw.raw.executionLog[0].eventId, "execution-1");
  assert.equal(merged.raw.productResult.answerSegments[0].eventId, "answer-1");
});

test("an incomplete live copy cannot move a persisted assistant reply before its user turn", () => {
  const user = { id: "user-1", role: "user", text: "question", createdAt: 100 };
  const persistedAssistant = {
    id: "product-result:user-1",
    role: "assistant",
    text: "answer",
    createdAt: 200
  };
  const liveAssistant = {
    id: "product-result:user-1",
    role: "assistant",
    text: "answer"
  };

  const mergedAssistant = replay.mergeSessionSnapshotMessage(persistedAssistant, liveAssistant);
  const ordered = [user, mergedAssistant]
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));

  assert.equal(mergedAssistant.createdAt, 200);
  assert.deepEqual(ordered.map((message) => message.id), ["user-1", "product-result:user-1"]);
});

test("ordinary messages do not create a synthetic process or answer segment", () => {
  const model = replay.replaySegmentModel({ id: "plain", role: "assistant", text: "short reply" });
  assert.equal(model.answerSegments.length, 0);
  assert.equal(model.structuredEvents.length, 0);
  assert.equal(model.processDetails.length, 0);
});
