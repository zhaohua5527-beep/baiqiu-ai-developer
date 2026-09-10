"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createEventState,
  reduceEventState,
  targetForSemanticType
} = require("../services/black-ball-public-event-contract");
const { buildExecutionLog, HmsMessageStreamDemux } = require("../services/hms-progress");

const SCENARIOS = Object.freeze({
  thinking_tool_final: ["thinking", "tool", "final"],
  thinking_cross_tool_final: ["thinking", "cross", "tool", "final"],
  thinking_cross_stage_result_thinking_tool_final: ["thinking", "cross", "stage_result", "thinking", "tool", "final"],
  thinking_thinking_thinking_tool_final: ["thinking", "thinking", "thinking", "tool", "final"],
  stage_result_final: ["stage_result", "final"]
});

function event(turnId, semanticType, sequence, overrides = {}) {
  return {
    turnId,
    eventId: `${turnId}:${sequence}:${semanticType}`,
    sequence,
    target: targetForSemanticType(semanticType),
    semanticType,
    message: `${semanticType} ${sequence}`,
    ...overrides
  };
}

function reduceScenario(name, semanticTypes) {
  return semanticTypes.reduce(
    (state, semanticType, index) => reduceEventState(state, event(name, semanticType, index + 1)),
    createEventState(name)
  );
}

test("the five required streams retain only producer-declared semantic events", () => {
  for (const [name, semanticTypes] of Object.entries(SCENARIOS)) {
    const state = reduceScenario(name, semanticTypes);
    assert.deepEqual(state.events.map((item) => item.semanticType), semanticTypes, name);
    assert.equal(state.hasCross, semanticTypes.includes("cross"), name);
    assert.equal(state.stageResultCount, semanticTypes.filter((type) => type === "stage_result").length, name);
    assert.equal(state.finalReceived, true, name);
    assert.deepEqual(state.violations, [], name);
  }
});

test("progress text never invents cross or stage_result", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const generic = demux.consume('<baiqiu-progress>{"stage":"analyze","message":"交叉检查后形成阶段性结果"}</baiqiu-progress>');
  assert.equal(generic.progressEvents[0].semanticType, "thinking");
  assert.equal(generic.progressEvents[0].target, "structured_result");

  const explicit = new HmsMessageStreamDemux({ requireFinalEnvelope: false }).consume(
    '<baiqiu-progress>{"type":"cross","stage":"verify","message":"两份真实证据存在差异"}</baiqiu-progress>'
  );
  assert.equal(explicit.progressEvents[0].semanticType, "cross");

  const stageResult = new HmsMessageStreamDemux({ requireFinalEnvelope: false }).consume(
    '<baiqiu-progress>{"type":"stage_result","stage":"verify","message":"本阶段核验完成"}</baiqiu-progress>'
  );
  assert.equal(stageResult.progressEvents[0].semanticType, "stage_result");

  const ambiguousTarget = new HmsMessageStreamDemux({ requireFinalEnvelope: false }).consume(
    '<baiqiu-progress>{"type":"structured_result","message":"不能自动等价为阶段结果"}</baiqiu-progress>'
  );
  assert.deepEqual(ambiguousTarget.progressEvents, []);
});

test("exact duplicates are idempotent and conflicting duplicate ids are rejected", () => {
  const turnId = "duplicate-turn";
  const first = event(turnId, "cross", 1);
  let state = reduceEventState(createEventState(turnId), first);
  state = reduceEventState(state, { ...first });
  assert.equal(state.events.length, 1);
  assert.equal(state.duplicates, 1);
  state = reduceEventState(state, { ...first, message: "conflicting content" });
  assert.equal(state.events.length, 1);
  assert.equal(state.violations.at(-1)?.code, "conflicting_event_id");
});

test("out-of-order earlier events are sorted while events after final are rejected", () => {
  const turnId = "out-of-order-turn";
  let state = reduceEventState(createEventState(turnId), event(turnId, "final", 5));
  state = reduceEventState(state, event(turnId, "thinking", 1));
  state = reduceEventState(state, event(turnId, "tool", 3));
  assert.deepEqual(state.events.map((item) => item.semanticType), ["thinking", "tool", "final"]);
  state = reduceEventState(state, event(turnId, "action", 6));
  assert.equal(state.events.length, 3);
  assert.equal(state.violations.at(-1)?.code, "event_after_final");
});

test("stage_result is valid without thinking or cross and target mismatches fail closed", () => {
  const valid = reduceScenario("stage-only", ["stage_result", "final"]);
  assert.deepEqual(valid.events.map((item) => item.semanticType), ["stage_result", "final"]);
  const invalid = reduceEventState(
    createEventState("bad-target"),
    event("bad-target", "stage_result", 1, { target: "execution_activity" })
  );
  assert.equal(invalid.events.length, 0);
  assert.equal(invalid.violations.at(-1)?.code, "semantic_target_mismatch");
});

test("an early final needs no synthetic predecessor and concurrent turns stay isolated", () => {
  const finalOnly = reduceEventState(createEventState("final-only"), event("final-only", "final", 1));
  assert.deepEqual(finalOnly.events.map((item) => item.semanticType), ["final"]);
  assert.equal(finalOnly.hasCross, false);
  assert.equal(finalOnly.stageResultCount, 0);

  const left = reduceEventState(createEventState("left"), event("left", "cross", 1));
  const right = reduceEventState(createEventState("right"), event("right", "stage_result", 1));
  assert.deepEqual(left.events.map((item) => item.semanticType), ["cross"]);
  assert.deepEqual(right.events.map((item) => item.semanticType), ["stage_result"]);
  const polluted = reduceEventState(left, event("right", "tool", 2));
  assert.equal(polluted.events.length, 1);
  assert.equal(polluted.violations.at(-1)?.code, "turn_mismatch");
});

test("durable tool events retain their explicit semantic type", () => {
  const [persisted] = buildExecutionLog([{
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    title: "read_file",
    status: "completed",
    rawOutput: { success: true }
  }], { runId: "durable-turn" });
  assert.equal(persisted.semanticType, "tool");
});
