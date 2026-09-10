"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { aggregateExecutionEvents } = require("../renderer-v2/event-aggregator");

function event(turnId, semanticType, sequence, extra = {}) {
  const target = ["thinking", "cross", "stage_result"].includes(semanticType)
    ? "structured_result"
    : semanticType === "final" ? "answer" : "execution_activity";
  return {
    turnId,
    eventId: `${turnId}:${sequence}:${semanticType}`,
    sequence,
    semanticType,
    type: semanticType,
    target,
    stage: extra.stage || "verify",
    action: extra.action || "",
    actionId: extra.actionId || "",
    message: `${semanticType} ${sequence}`,
    ...extra
  };
}

test("the five real event shapes remain producer-driven", () => {
  const scenarios = [
    ["thinking", "tool", "final"],
    ["thinking", "cross", "tool", "final"],
    ["thinking", "cross", "stage_result", "thinking", "tool", "final"],
    ["thinking", "thinking", "thinking", "tool", "final"],
    ["stage_result", "final"]
  ];
  for (const semanticTypes of scenarios) {
    const raw = semanticTypes.map((type, index) => event("turn-1", type, index + 1, {
      actionId: type === "tool" ? "read-1" : ""
    }));
    const model = aggregateExecutionEvents(raw, { turnId: "turn-1" });
    assert.deepEqual(model.events.map((item) => item.semanticType), semanticTypes);
    assert.equal(model.hasCross, semanticTypes.includes("cross"));
    assert.equal(model.stageResultCount, semanticTypes.filter((type) => type === "stage_result").length);
    assert.equal(model.finalReceived, true);
  }
});

test("repeated actions collapse into one action group without deleting raw events", () => {
  const raw = Array.from({ length: 20 }, (_, index) => event("turn-2", "tool", index + 1, {
    stage: "read",
    action: "search",
    actionId: "search-1"
  }));
  const model = aggregateExecutionEvents(raw, { turnId: "turn-2" });
  assert.equal(model.rawEvents.length, 20);
  assert.equal(model.events.length, 20);
  assert.equal(model.stages.length, 1);
  assert.equal(model.stages[0].actionGroups.length, 1);
  assert.equal(model.stages[0].actionGroups[0].eventCount, 20);
  assert.equal(model.stages[0].sourceEventIds.length, 20);
});

test("different explicit stages stay separate and stage results do not become final", () => {
  const raw = [
    event("turn-3", "tool", 1, { stage: "read", action: "search", actionId: "s" }),
    event("turn-3", "cross", 2, { stage: "verify" }),
    event("turn-3", "stage_result", 3, { stage: "verify" }),
    event("turn-3", "final", 4, { stage: "answer" })
  ];
  const model = aggregateExecutionEvents(raw, { turnId: "turn-3" });
  assert.equal(model.stages.length, 3);
  assert.equal(model.stages[1].cross.semanticType, "cross");
  assert.equal(model.stages[1].stageResult.semanticType, "stage_result");
  assert.equal(model.finalReceived, true);
  assert.equal(model.stageResultCount, 1);
});

test("out-of-order events are ordered, exact duplicate ids are ignored, conflicts are reported", () => {
  const first = event("turn-4", "thinking", 1, { stage: "read" });
  const duplicate = { ...first };
  const conflict = { ...first, message: "different" };
  const model = aggregateExecutionEvents([
    event("turn-4", "final", 3, { stage: "answer" }),
    event("turn-4", "tool", 2, { stage: "read" }),
    duplicate,
    conflict,
    first
  ], { turnId: "turn-4" });
  assert.deepEqual(model.events.map((item) => item.sequence), [1, 2, 3]);
  assert.equal(model.conflicts.length, 1);
  assert.equal(model.events.some((item) => item.semanticType === "stage_result"), false);
});

test("events from another turn are not merged", () => {
  const model = aggregateExecutionEvents([
    event("left", "cross", 1),
    event("right", "stage_result", 1)
  ], { turnId: "left" });
  assert.deepEqual(model.events.map((item) => item.turnId), ["left"]);
  assert.equal(model.hasCross, true);
  assert.equal(model.stageResultCount, 0);
});

test("renderer loads the aggregator and owns one theater container", () => {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
  assert.match(app, /const eventAggregator = window\.BaiqiuEventAggregator/);
  assert.match(app, /function paintExecutionStageView\(/);
  assert.match(app, /execution-activity-inline-theater/);
  assert.match(html, /event-aggregator\.js/);
});

test("theater cleanup cancels both scene and reschedule timers", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const stop = app.slice(app.indexOf("function stopExecutionActivityFlow"), app.indexOf("function clearExecutionActivityWhimsy"));
  assert.match(stop, /clearTimeout\(flow\.whimsyScheduleTimer\)/);
  assert.match(stop, /flow\.whimsyScheduleTimer = null/);
  assert.match(app, /flow\.whimsyScheduleTimer = setTimeout/);
  assert.match(app, /whimsyShownCount\s*\|\|\s*0\)\s*>= 5/);
  assert.doesNotMatch(stop, /appendMessage|executionLog/);
});
