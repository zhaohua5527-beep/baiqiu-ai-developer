"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");

function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source range: ${start}`);
  return source.slice(from, to);
}

test("cross message is rendered once in the shared execution flow without a heading", () => {
  const paint = sourceBetween("function executionThreeRowViewModel", "function executionActivityViewportIsAtBottom");
  assert.match(paint, /results\.replaceChildren\(\.\.\.phase\.resultEvents\.map/);
  assert.match(paint, /node\.dataset\.semanticType = item\.semanticType/);
  assert.match(paint, /node\.dataset\.sourceEventId = item\.sourceEventId \|\| item\.eventId/);
  assert.match(paint, /paintExecutionPhaseResult\(root, node, item\)/);
  assert.doesNotMatch(paint, /className = .*execution-cross-summary/);
  assert.doesNotMatch(paint, /交叉核验结论|crossPanel/);
});

test("cross phase model preserves the producer message without filtering or truncation", () => {
  const helper = sourceBetween("function executionThreeRowViewModel", "function paintExecutionStageView");
  const phasesFor = new Function(`${helper}; return executionThreeRowViewModel;`)();
  const longText = `Cross result: ${"evidence agrees. ".repeat(200)}`;
  const phases = phasesFor({ events: [{
    eventId: "cross-1",
    sequence: 1,
    semanticType: "cross",
    target: "structured",
    message: longText
  }] });
  assert.equal(phases[0].resultEvents[0].text, longText);
});

test("cross payload fields survive renderer normalization", () => {
  const helpers = sourceBetween("function activityDetailText", "function executionActivityEntryKey");
  const { executionSummaryEntry } = new Function(`${helpers}; return { executionSummaryEntry };`)();
  const title = `地理位置核验${"证据".repeat(100)}`;
  const publicSummary = `公开核验摘要${"一致".repeat(200)}`;
  const event = {
    eventId: "cross-1",
    target: "structured",
    semanticType: "cross",
    message: "两组证据一致",
    title,
    publicSummary,
    comparison: "资中县城 → 重龙",
    evidence: ["29.7806°N", "104.8522°E"],
    conclusion: "两组地理信息一致"
  };
  const normalized = executionSummaryEntry(event);
  assert.equal(normalized.message, event.message);
  assert.equal(normalized.title, title);
  assert.equal(normalized.publicSummary, publicSummary);
  assert.equal(normalized.comparison, event.comparison);
  assert.deepEqual(normalized.evidence, event.evidence);
  assert.equal(normalized.conclusion, event.conclusion);
});

test("the structured lane keeps cross in its factual panel and omits primary summary duplicates", () => {
  const helperSource = sourceBetween("function isCrossStructuredEvent", "function mergeAnswerSegmentLists");
  const { isCrossStructuredEvent } = new Function(`${helperSource}; return { isCrossStructuredEvent };`)();
  assert.equal(isCrossStructuredEvent({ semanticType: "cross", message: "核验完成" }), true);
  assert.equal(isCrossStructuredEvent({ semantic_type: "cross", message: "核验完成" }), true);
  assert.equal(isCrossStructuredEvent({ type: "cross", message: "核验完成" }), false);
  assert.equal(isCrossStructuredEvent({ semanticType: "stage_result", message: "核验完成" }), false);
  assert.equal(isCrossStructuredEvent({ message: "已完成交叉核验" }), false);

  const persisted = sourceBetween("function renderPersistedSegmentPairs", "function snapshotMessageIdentity");
  assert.match(persisted, /\.filter\(\(event\) => !isPrimaryExecutionSummaryEvent\(event\)\)/);

  const live = sourceBetween("function appendLiveStructuredResult", "function isPublicStructuredThought");
  const storedAt = live.indexOf("entry.structuredEvents.push");
  const excludedAt = live.indexOf("if (isPrimaryExecutionSummaryEvent(progress)) return null;");
  const nodeAt = live.indexOf('node = document.createElement("div")');
  assert.ok(storedAt >= 0 && excludedAt > storedAt && nodeAt > excludedAt);
});
